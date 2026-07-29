import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Config } from "../config.js";
import type { Database } from "../db.js";
import { unauthorized } from "../errors.js";
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
}

export class PublicRepository implements PublicDataSource {
  constructor(private readonly db: Database) {}

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
  }, { prefix: "/public" });
}

function publicUser(request: FastifyRequest): TelegramWebAppUser {
  const user = (request as PublicRequest).telegramWebAppUser;
  if (!user) throw unauthorized("Сессия Telegram Mini App не проверена");
  return user;
}
