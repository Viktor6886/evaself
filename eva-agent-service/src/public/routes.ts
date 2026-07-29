import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Config } from "../config.js";
import type { Database } from "../db.js";
import { badRequest, unauthorized } from "../errors.js";
import type { UserProfileService } from "../profile/profile-service.js";
import {
  type TelegramWebAppUser,
  verifyTelegramWebAppInitData,
} from "./telegram-webapp-auth.js";

interface PublicRequest extends FastifyRequest {
  telegramWebAppUser?: TelegramWebAppUser;
}

export interface PublicSession {
  user: {
    id: number;
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    language_code: string;
    timezone: string;
  };
  plan: string;
  quotas: Array<Record<string, unknown>>;
}

export interface PublicTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  due_at: Date | null;
  remind_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

export interface PublicDataSource {
  openSession(user: TelegramWebAppUser): Promise<PublicSession>;
  listTasks(telegramId: number): Promise<PublicTask[]>;
  getProfile(telegramId: number): Promise<Record<string, unknown>>;
  updateProfile(
    telegramId: number,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

export class PublicRepository implements PublicDataSource {
  constructor(
    private readonly db: Database,
    private readonly profile: UserProfileService,
  ) {}

  async openSession(user: TelegramWebAppUser): Promise<PublicSession> {
    const saved = await this.db.upsertUser({
      telegramId: user.id,
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
      languageCode: user.language_code,
    });
    const overview = await this.db.getUserOverview(user.id);
    return {
      user: {
        id: saved.id,
        first_name: saved.first_name,
        last_name: saved.last_name,
        username: saved.username,
        language_code: saved.language_code,
        timezone: saved.timezone,
      },
      plan: typeof overview?.plan === "string" ? overview.plan : "free",
      quotas: await this.db.getQuotaStatus(user.id),
    };
  }

  async listTasks(telegramId: number): Promise<PublicTask[]> {
    const { rows } = await this.db.query<PublicTask>(
      `SELECT t.id::text, t.title, t.description, t.status, t.priority,
              t.due_at, t.remind_at, t.completed_at, t.updated_at
         FROM tasks t
         JOIN users u ON u.id = t.user_id
        WHERE u.telegram_id = $1
          AND t.status <> 'canceled'
        ORDER BY
          CASE t.status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
          COALESCE(t.next_run_at, t.due_at, t.created_at),
          t.id
        LIMIT 100`,
      [telegramId],
    );
    return rows;
  }

  async getProfile(telegramId: number): Promise<Record<string, unknown>> {
    const user = await this.userByTelegramId(telegramId);
    const profile = await this.profile.getProfile(user.id);
    return {
      user: {
        preferred_name: profileValue(profile.confirmed, "preferred_name"),
        city: user.city,
        timezone: user.timezone,
        language_mode: user.language_mode,
        preferred_language: user.preferred_language,
      },
      confirmed: profile.confirmed.map(publicProfileField),
      candidates: profile.candidates.map(publicProfileField),
      completeness: profile.completeness,
    };
  }

  async updateProfile(
    telegramId: number,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const user = await this.userByTelegramId(telegramId);
    const fields = input.fields && typeof input.fields === "object" && !Array.isArray(input.fields)
      ? Object.entries(input.fields as Record<string, unknown>).slice(0, 20)
      : [];
    for (const [fieldKey, value] of fields) {
      await this.profile.upsert({
        userId: user.id,
        fieldKey,
        value,
        sourceType: "webapp",
        explicitlyStated: true,
        confidence: 1,
      });
    }
    for (const fieldKey of stringList(input.confirm, 20)) {
      await this.profile.confirm(user.id, fieldKey);
    }
    for (const fieldKey of stringList(input.decline, 20)) {
      await this.profile.decline(user.id, fieldKey);
    }
    if (Object.hasOwn(input, "preferred_language")) {
      const language = input.preferred_language;
      if (language !== null && language !== "ru" && language !== "en") {
        throw new Error("preferred_language должен быть ru, en или null");
      }
      await this.profile.setLanguage(user.id, language);
    }
    return await this.getProfile(telegramId);
  }

  private async userByTelegramId(telegramId: number): Promise<{
    id: number;
    city: string | null;
    timezone: string;
    language_mode: string;
    preferred_language: string | null;
  }> {
    const { rows } = await this.db.query<{
      id: number;
      city: string | null;
      timezone: string;
      language_mode: string;
      preferred_language: string | null;
    }>(
      `SELECT id, city, timezone, language_mode, preferred_language
         FROM users
        WHERE telegram_id = $1`,
      [telegramId],
    );
    if (!rows[0]) throw unauthorized("Пользователь Telegram не найден");
    return rows[0];
  }
}

export function registerPublicRoutes(
  app: FastifyInstance,
  input: {
    config: Config;
    repository: PublicDataSource;
    now?: () => Date;
  },
): void {
  void app.register(async (publicApp) => {
    publicApp.addHook("onRequest", async (request) => {
      const header = request.headers["x-telegram-init-data"];
      if (typeof header !== "string") {
        throw unauthorized("Откройте Mini App из Telegram");
      }
      const verified = verifyTelegramWebAppInitData(
        header,
        input.config.telegramBotToken,
        {
          maxAgeSeconds: input.config.telegramWebAppMaxAgeSeconds,
          now: input.now?.(),
        },
      );
      (request as PublicRequest).telegramWebAppUser = verified.user;
    });

    publicApp.post("/session", async (request) => ({
      ...(await input.repository.openSession(publicUser(request))),
    }));

    publicApp.get("/tasks", async (request) => ({
      tasks: await input.repository.listTasks(publicUser(request).id),
    }));

    publicApp.get("/profile", async (request) => ({
      profile: await input.repository.getProfile(publicUser(request).id),
    }));

    publicApp.patch("/profile", async (request) => {
      try {
        return {
          profile: await input.repository.updateProfile(
            publicUser(request).id,
            request.body && typeof request.body === "object"
              ? request.body as Record<string, unknown>
              : {},
          ),
        };
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : "Некорректный профиль");
      }
    });
  }, { prefix: "/public" });
}

function publicUser(request: FastifyRequest): TelegramWebAppUser {
  const user = (request as PublicRequest).telegramWebAppUser;
  if (!user) throw unauthorized("Сессия Telegram Mini App не проверена");
  return user;
}

function publicProfileField(field: {
  field_key: string;
  field_value: string | null;
  field_json: unknown;
  status: string;
  confirmed_at: Date | null;
  updated_at: Date;
}): Record<string, unknown> {
  return {
    field_key: field.field_key,
    value: field.field_json ?? field.field_value,
    status: field.status,
    confirmed_at: field.confirmed_at,
    updated_at: field.updated_at,
  };
}

function profileValue(
  fields: Array<{ field_key: string; field_value: string | null; field_json: unknown }>,
  fieldKey: string,
): unknown {
  const field = fields.find((item) => item.field_key === fieldKey);
  return field?.field_json ?? field?.field_value ?? null;
}

function stringList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, limit)
    : [];
}
