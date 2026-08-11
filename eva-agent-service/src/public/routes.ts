import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Config } from "../config.js";
import type { Database } from "../db.js";
import { badRequest, unauthorized } from "../errors.js";
import type { GoalService } from "../goals/goal-service.js";
import type { UserProfileService } from "../profile/profile-service.js";
import {
  type TelegramWebAppUser,
  verifyTelegramWebAppInitData,
} from "./telegram-webapp-auth.js";
import {
  clientAddress,
  enforceRateLimit,
  NoopRateLimiter,
  type RateLimiter,
} from "./rate-limit.js";
import {
  authenticateMiniAppRequest,
  INIT_DATA_HEADER,
  initDataFingerprint,
  type MiniAppSessionStore,
} from "./webapp-session.js";

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
  getToday(telegramId: number): Promise<Record<string, unknown>>;
  listTasks(telegramId: number): Promise<PublicTask[]>;
  listGoals(telegramId: number): Promise<Record<string, unknown>[]>;
  createGoal(
    telegramId: number,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  updateGoal(
    telegramId: number,
    goalId: number,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  getProfile(telegramId: number): Promise<Record<string, unknown>>;
  updateProfile(
    telegramId: number,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  getProgress(telegramId: number): Promise<Record<string, unknown>>;
  startWorkBlock(
    telegramId: number,
    workBlockId: number,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  completeWorkBlock(
    telegramId: number,
    workBlockId: number,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

export class PublicRepository implements PublicDataSource {
  constructor(
    private readonly db: Database,
    private readonly profile: UserProfileService,
    private readonly goals: GoalService,
  ) {}

  /**
   * Каждый метод репозитория открывает область своего пользователя.
   * Идентификатор приходит только из проверенной подписи Telegram; тело
   * запроса на выбор владельца не влияет.
   */
  private async scoped<T>(
    telegramId: number,
    label: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return await this.db.withUserScope(
      { telegramId, label: `public.${label}` },
      work,
    );
  }

  async openSession(user: TelegramWebAppUser): Promise<PublicSession> {
    return await this.scoped(user.id, "session", async () => {
    const saved = await this.db.upsertUser({
      telegramId: user.id,
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
      languageCode: user.language_code,
    });
    this.db.bindScopeUserId(saved.id);
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
    });
  }

  async listTasks(telegramId: number): Promise<PublicTask[]> {
    return await this.scoped(telegramId, "tasks", async () => {
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
    });
  }

  async getToday(telegramId: number): Promise<Record<string, unknown>> {
    return await this.scoped(telegramId, "today", async () => {
    const { rows } = await this.db.query<{
      timezone: string;
      local_time: string;
      work_block_id: string | null;
      work_block_status: string | null;
      goal_id: string | null;
      goal_title: string | null;
      main_action: string | null;
      expected_result: string | null;
      first_step: string | null;
      continuation: string | null;
      tasks: unknown;
    }>(
      `SELECT u.timezone,
              to_char(now() AT TIME ZONE u.timezone, 'HH24:MI') AS local_time,
              focus.work_block_id,
              focus.work_block_status,
              COALESCE(focus.goal_id, nearest.goal_id) AS goal_id,
              COALESCE(focus.goal_title, nearest.goal_title) AS goal_title,
              COALESCE(focus.intention, nearest.first_action, nearest.result_title) AS main_action,
              COALESCE(focus.completion_criterion, nearest.result_artifact, nearest.result_title)
                AS expected_result,
              COALESCE(focus.first_physical_step, nearest.first_action) AS first_step,
              continuation.next_step AS continuation,
              COALESCE(extra.tasks, '[]'::jsonb) AS tasks
         FROM users u
         LEFT JOIN LATERAL (
           SELECT wb.id::text AS work_block_id,
                  wb.status AS work_block_status,
                  wb.goal_id::text AS goal_id,
                  g.title AS goal_title,
                  wb.intention,
                  wb.completion_criterion,
                  wb.first_physical_step
             FROM work_blocks wb
             JOIN goals g ON g.id = wb.goal_id AND g.user_id = wb.user_id
            WHERE wb.user_id = u.id
              AND wb.status IN ('active', 'planned')
            ORDER BY CASE wb.status WHEN 'active' THEN 0 ELSE 1 END,
                     COALESCE(wb.planned_start_at, wb.created_at),
                     wb.id
            LIMIT 1
         ) focus ON true
         LEFT JOIN LATERAL (
           SELECT g.id::text AS goal_id,
                  g.title AS goal_title,
                  r.title AS result_title,
                  r.result_artifact,
                  r.first_action
             FROM goals g
             LEFT JOIN LATERAL (
               SELECT title, result_artifact, first_action
                 FROM goal_results
                WHERE user_id = u.id
                  AND goal_id = g.id
                  AND status NOT IN ('completed', 'skipped')
                ORDER BY is_critical_path DESC, sort_order, id
                LIMIT 1
             ) r ON true
            WHERE g.user_id = u.id AND g.status = 'active'
            ORDER BY g.priority, g.updated_at DESC
            LIMIT 1
         ) nearest ON focus.work_block_id IS NULL
         LEFT JOIN LATERAL (
           SELECT next_step
             FROM work_blocks
            WHERE user_id = u.id
              AND status = 'completed'
              AND next_step IS NOT NULL
            ORDER BY completed_at DESC, id DESC
            LIMIT 1
         ) continuation ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(task ORDER BY selected_tasks.order_key) AS tasks
             FROM (
               SELECT jsonb_build_object(
                        'id', t.id::text,
                        'title', t.title,
                        'status', t.status,
                        'due_at', t.due_at,
                        'estimated_minutes', t.estimated_minutes
                      ) AS task,
                      COALESCE(t.due_at, t.created_at) AS order_key
                 FROM tasks t
                WHERE t.user_id = u.id
                  AND t.status IN ('open', 'in_progress')
                ORDER BY CASE t.status WHEN 'in_progress' THEN 0 ELSE 1 END,
                         COALESCE(t.due_at, t.created_at),
                         t.id
                LIMIT 3
             ) selected_tasks
         ) extra ON true
        WHERE u.telegram_id = $1`,
      [telegramId],
    );
    if (!rows[0]) throw unauthorized("Пользователь Telegram не найден");
    return rows[0];
    });
  }

  async listGoals(telegramId: number): Promise<Record<string, unknown>[]> {
    return await this.scoped(telegramId, "goals", async () => {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT g.id::text,
              g.title,
              g.why_it_matters,
              g.target_date,
              g.status,
              g.priority,
              g.vector_stage,
              g.user_confirmed,
              COALESCE(progress.progress_percent, 0) AS progress_percent,
              next_result.id::text AS next_result_id,
              next_result.title AS next_result,
              next_result.first_action AS next_step,
              next_result.target_date AS next_result_date
         FROM goals g
         JOIN users u ON u.id = g.user_id
         LEFT JOIN LATERAL (
           SELECT round(avg(progress_percent))::integer AS progress_percent
             FROM goal_results
            WHERE user_id = g.user_id AND goal_id = g.id
         ) progress ON true
         LEFT JOIN LATERAL (
           SELECT id, title, first_action, target_date
             FROM goal_results
            WHERE user_id = g.user_id
              AND goal_id = g.id
              AND status NOT IN ('completed', 'skipped')
            ORDER BY is_critical_path DESC, sort_order, id
            LIMIT 1
         ) next_result ON true
        WHERE u.telegram_id = $1
          AND g.status <> 'abandoned'
        ORDER BY CASE g.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
                 g.priority,
                 g.updated_at DESC
        LIMIT 50`,
      [telegramId],
    );
    return rows;
    });
  }

  async createGoal(
    telegramId: number,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await this.scoped(telegramId, "goal.create", async () => {
    const user = await this.userByTelegramId(telegramId);
    const draft = await this.goals.upsertGoal({
      userId: user.id,
      title: requiredText(input.title, "Название цели", 500),
      whyItMatters: optionalText(input.why_it_matters, 5_000),
      targetDate: optionalDate(input.target_date),
      priority: optionalInteger(input.priority, 1, 5) ?? 3,
      status: "draft",
      vectorStage: "north",
    }) as Record<string, unknown>;
    return await this.goals.confirmGoal(user.id, Number(draft.id)) as Record<
      string,
      unknown
    >;
    });
  }

  async updateGoal(
    telegramId: number,
    goalId: number,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await this.scoped(telegramId, "goal.update", async () => {
    const user = await this.userByTelegramId(telegramId);
    const status = optionalEnum(
      input.status,
      ["active", "paused", "completed", "abandoned"],
      "Статус цели",
    );
    if (status === "active") {
      return await this.goals.confirmGoal(user.id, goalId) as Record<
        string,
        unknown
      >;
    }
    return await this.goals.upsertGoal({
      userId: user.id,
      id: goalId,
      ...(Object.hasOwn(input, "title")
        ? { title: requiredText(input.title, "Название цели", 500) }
        : {}),
      ...(Object.hasOwn(input, "why_it_matters")
        ? { whyItMatters: optionalText(input.why_it_matters, 5_000) }
        : {}),
      ...(Object.hasOwn(input, "target_date")
        ? { targetDate: optionalDate(input.target_date) }
        : {}),
      ...(Object.hasOwn(input, "priority")
        ? { priority: optionalInteger(input.priority, 1, 5) ?? 3 }
        : {}),
      ...(status ? { status } : {}),
    }) as Record<string, unknown>;
    });
  }

  async getProfile(telegramId: number): Promise<Record<string, unknown>> {
    return await this.scoped(telegramId, "profile", async () => {
    const user = await this.userByTelegramId(telegramId);
    const profile = await this.profile.getProfile(user.id);
    return {
      user: {
        preferred_name: profileValue(profile.confirmed, "preferred_name"),
        city: user.city,
        timezone: user.timezone,
        language_mode: user.language_mode,
        preferred_language: user.preferred_language,
        interests: profileValue(profile.confirmed, "interests"),
        communication_style: profileValue(profile.confirmed, "communication_style"),
      },
      confirmed: profile.confirmed.map(publicProfileField),
      candidates: profile.candidates.map(publicProfileField),
      completeness: profile.completeness,
    };
    });
  }

  async updateProfile(
    telegramId: number,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await this.scoped(telegramId, "profile.update", async () => {
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
    });
  }

  async getProgress(telegramId: number): Promise<Record<string, unknown>> {
    return await this.scoped(telegramId, "progress", async () => {
    const user = await this.userByTelegramId(telegramId);
    const [results, workBlocks, strategies, goals] = await Promise.all([
      this.db.query(
        `SELECT r.id::text, r.title, r.result_artifact, r.completed_at,
                g.id::text AS goal_id, g.title AS goal_title
           FROM goal_results r
           JOIN goals g ON g.id = r.goal_id AND g.user_id = r.user_id
          WHERE r.user_id = $1 AND r.status = 'completed'
          ORDER BY r.completed_at DESC NULLS LAST, r.updated_at DESC
          LIMIT 30`,
        [user.id],
      ),
      this.db.query(
        `SELECT wb.id::text, wb.intention, wb.actual_result, wb.artifact,
                wb.actual_minutes, wb.helpful_factor, wb.completed_at,
                g.id::text AS goal_id, g.title AS goal_title
           FROM work_blocks wb
           JOIN goals g ON g.id = wb.goal_id AND g.user_id = wb.user_id
          WHERE wb.user_id = $1 AND wb.status = 'completed'
          ORDER BY wb.completed_at DESC
          LIMIT 30`,
        [user.id],
      ),
      this.db.query(
        `SELECT id::text, title, description, uses_count, last_used_at
           FROM user_strategies
          WHERE user_id = $1 AND status = 'confirmed'
          ORDER BY uses_count DESC, updated_at DESC
          LIMIT 20`,
        [user.id],
      ),
      this.db.query(
        `SELECT g.id::text, g.title, g.status,
                COALESCE(round(avg(r.progress_percent))::integer, 0) AS progress_percent
           FROM goals g
           LEFT JOIN goal_results r
             ON r.goal_id = g.id AND r.user_id = g.user_id
          WHERE g.user_id = $1 AND g.status IN ('active', 'completed')
          GROUP BY g.id
          ORDER BY CASE g.status WHEN 'active' THEN 0 ELSE 1 END, g.updated_at DESC
          LIMIT 30`,
        [user.id],
      ),
    ]);
    return {
      completed_results: results.rows,
      work_blocks: workBlocks.rows,
      strategies: strategies.rows,
      goals: goals.rows,
    };
    });
  }

  async startWorkBlock(
    telegramId: number,
    workBlockId: number,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await this.scoped(telegramId, "work-block.start", async () => {
    const owned = await this.ownedWorkBlock(telegramId, workBlockId);
    return await this.goals.recordWorkBlock({
      userId: owned.userId,
      action: "start",
      goalId: owned.goalId,
      goalResultId: owned.goalResultId,
      workBlockId,
      energyBefore: optionalInteger(input.energy_before, 1, 5),
    }) as Record<string, unknown>;
    });
  }

  async completeWorkBlock(
    telegramId: number,
    workBlockId: number,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await this.scoped(telegramId, "work-block.complete", async () => {
    const owned = await this.ownedWorkBlock(telegramId, workBlockId);
    return await this.goals.recordWorkBlock({
      userId: owned.userId,
      action: "complete",
      goalId: owned.goalId,
      goalResultId: owned.goalResultId,
      workBlockId,
      actualResult:
        optionalText(input.actual_result, 10_000) ?? "Шаг отмечен выполненным",
      artifact: optionalText(input.artifact, 10_000),
      nextStep: optionalText(input.next_step, 5_000),
      actualMinutes: optionalInteger(input.actual_minutes, 0, 10_080),
      energyAfter: optionalInteger(input.energy_after, 1, 5),
      resultCompleted: input.result_completed === true,
      progressPercent: optionalInteger(input.progress_percent, 0, 100),
    }) as Record<string, unknown>;
    });
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
    this.db.bindScopeUserId(Number(rows[0].id));
    return rows[0];
  }

  private async ownedWorkBlock(
    telegramId: number,
    workBlockId: number,
  ): Promise<{ userId: number; goalId: number; goalResultId: number | null }> {
    const { rows } = await this.db.query<{
      user_id: string;
      goal_id: string;
      goal_result_id: string | null;
    }>(
      `SELECT wb.user_id, wb.goal_id, wb.goal_result_id
         FROM work_blocks wb
         JOIN users u ON u.id = wb.user_id
        WHERE wb.id = $1 AND u.telegram_id = $2`,
      [workBlockId, telegramId],
    );
    if (!rows[0]) throw new Error("Рабочий блок не найден");
    this.db.bindScopeUserId(Number(rows[0].user_id));
    return {
      userId: Number(rows[0].user_id),
      goalId: Number(rows[0].goal_id),
      goalResultId: rows[0].goal_result_id
        ? Number(rows[0].goal_result_id)
        : null,
    };
  }
}

/**
 * Что Mini App умеет делать с памятью. Интерфейс объявлен здесь, а
 * реализация приходит снаружи: маршруты не должны знать ни о temporal-
 * версиях, ни о доказательствах — они переводят Telegram-личность в
 * идентификатор владельца и передают дальше.
 */
export interface MiniAppMemoryControl {
  list(telegramId: number): Promise<unknown[]>;
  history(telegramId: number, nodeId: number): Promise<unknown[]>;
  decide(telegramId: number, nodeId: number, decision: "confirm" | "reject"): Promise<boolean>;
  correct(
    telegramId: number,
    nodeId: number,
    patch: { title?: string; value?: string | null },
  ): Promise<{ version: number } | null>;
  remove(telegramId: number, nodeId: number): Promise<Record<string, number> | null>;
}

function requireMemory(memory: MiniAppMemoryControl | undefined): MiniAppMemoryControl {
  if (!memory) throw badRequest("Управление памятью отключено");
  return memory;
}

export function registerPublicRoutes(
  app: FastifyInstance,
  input: {
    config: Config;
    repository: PublicDataSource;
    telegram?: { username(): Promise<string | null> };
    now?: () => Date;
    sessions?: MiniAppSessionStore;
    rateLimiter?: RateLimiter;
    approvals?: { decide(input: { telegramId: number; sdkRequestId: string; decision: "allow" | "deny" }): Promise<unknown> };
    /**
     * Контроль памяти из Mini App. Владелец берётся из проверенной
     * подписи Telegram и приводится к внутреннему идентификатору здесь
     * же: принимать `user_id` из тела запроса значило бы отдать чужую
     * память тому, кто угадает число.
     */
    memory?: MiniAppMemoryControl;
  },
): void {
  const limiter = input.rateLimiter ?? new NoopRateLimiter();
  const window = input.config.rateLimitWindowSeconds ?? 60;
  // The landing page is an ordinary web page, not a Mini App launch, so it
  // has no initData to present. The bot's @handle is public information
  // anyway — this one route therefore sits OUTSIDE the hook below, which
  // guards everything user-specific.
  app.get("/public/bot", async (request, reply) => {
    // Маршрут вне защищённой области, но не бесплатный: при недоступном
    // Telegram username() не кэширует неудачу и каждый запрос уходит
    // наружу getMe. Лимит по адресу — тот же, что у остальных публичных.
    await enforceRateLimit(
      limiter,
      `public:ip:${clientAddress(request.headers as Record<string, unknown>, request.ip)}`,
      { limit: input.config.publicRateLimitPerIp, windowSeconds: window },
    );
    reply.header("Cache-Control", "public, max-age=300");
    return {
      username: (await input.telegram?.username()) ?? null,
      configured: Boolean(input.config.telegramBotToken),
    };
  });

  void app.register(async (publicApp) => {
    publicApp.addHook("onRequest", async (request) => {
      // Лимит по адресу — ДО проверки подписи: сама проверка стоит
      // процессорного времени, и поток неподписанных запросов не должен
      // его тратить.
      await enforceRateLimit(
        limiter,
        `public:ip:${clientAddress(request.headers as Record<string, unknown>, request.ip)}`,
        { limit: input.config.publicRateLimitPerIp, windowSeconds: window },
      );

      (request as PublicRequest).telegramWebAppUser =
        await authenticateMiniAppRequest(
          request.headers as Record<string, unknown>,
          {
            botToken: input.config.telegramBotToken,
            maxAgeSeconds: input.config.telegramWebAppMaxAgeSeconds,
            ...(input.sessions ? { sessions: input.sessions } : {}),
            ...(input.now ? { now: input.now } : {}),
            verify: verifyTelegramWebAppInitData,
          },
        );

      // Второй лимит — по проверенной личности: один пользователь не
      // должен исчерпать общий ресурс, зайдя с многих адресов.
      await enforceRateLimit(
        limiter,
        `public:user:${(request as PublicRequest).telegramWebAppUser!.id}`,
        { limit: input.config.publicRateLimitPerUser, windowSeconds: window },
      );
    });

    // Обмен проверенного initData на короткоживущую серверную сессию.
    //
    // Границы защиты, чтобы не переоценивать её:
    //   • одну и ту же строку нельзя обменять на сессию дважды — этот
    //     путь односоставный;
    //   • но на остальных маршрутах initData пока принимается как
    //     запасной путь и там повторное предъявление НЕ отсекается. То
    //     есть перехваченная строка остаётся годной до конца окна (600 с).
    //     Окно сокращено с часа именно поэтому. Полное закрытие требует
    //     обязательной сессии на всех маршрутах и ломает перезагрузку
    //     Mini App внутри окна — решение вынесено человеку, см. PROGRESS.md.
    //
    // Заявка идёт ДО openSession: иначе повторно предъявленная строка
    // успевала бы записать в users прежде, чем её отвергнут.
    publicApp.post("/session", async (request) => {
      const initData = request.headers[INIT_DATA_HEADER];
      if (!input.sessions || typeof initData !== "string") {
        return { ...(await input.repository.openSession(publicUser(request))) };
      }

      const claimed = await input.sessions.claimInitData(
        initDataFingerprint(initData),
        input.config.telegramWebAppMaxAgeSeconds,
      );
      if (!claimed) {
        throw unauthorized("Эта ссылка Mini App уже использована — откройте приложение заново");
      }
      const session = await input.repository.openSession(publicUser(request));
      const token = await input.sessions.issue(
        publicUser(request),
        input.config.webAppSessionTtlSeconds,
      );
      return {
        ...session,
        session_token: token,
        session_expires_in: input.config.webAppSessionTtlSeconds,
      };
    });

    publicApp.get("/today", async (request) => ({
      today: await input.repository.getToday(publicUser(request).id),
    }));

    publicApp.get("/tasks", async (request) => ({
      tasks: await input.repository.listTasks(publicUser(request).id),
    }));

    publicApp.get("/goals", async (request) => ({
      goals: await input.repository.listGoals(publicUser(request).id),
    }));

    publicApp.post("/goals", async (request) => {
      try {
        return {
          goal: await input.repository.createGoal(
            publicUser(request).id,
            requestBody(request),
          ),
        };
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : "Некорректная цель");
      }
    });

    publicApp.patch("/goals/:id", async (request) => {
      try {
        return {
          goal: await input.repository.updateGoal(
            publicUser(request).id,
            positiveId((request.params as { id?: string }).id, "цели"),
            requestBody(request),
          ),
        };
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : "Некорректная цель");
      }
    });

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

    publicApp.get("/progress", async (request) => ({
      progress: await input.repository.getProgress(publicUser(request).id),
    }));

    // ---- Контроль памяти (шаг 16) ---------------------------------
    //
    // Пять маршрутов: посмотреть, историю, подтвердить, исправить,
    // удалить. Отсутствующая сборка памяти — честный отказ, а не пустой
    // список: пустой список означал бы «Ева ничего не помнит», и человек
    // сделал бы неверный вывод о выключенной функции.
    publicApp.get("/memory", async (request) => {
      const memory = requireMemory(input.memory);
      return { items: await memory.list(publicUser(request).id) };
    });

    publicApp.get("/memory/:id/history", async (request) => {
      const memory = requireMemory(input.memory);
      return {
        history: await memory.history(
          publicUser(request).id,
          positiveId((request.params as { id?: string }).id, "факта"),
        ),
      };
    });

    publicApp.post("/memory/:id/confirm", async (request) => {
      const memory = requireMemory(input.memory);
      const decision = requestBody(request).decision;
      if (decision !== "confirm" && decision !== "reject") {
        throw badRequest("Некорректное решение");
      }
      const ok = await memory.decide(
        publicUser(request).id,
        positiveId((request.params as { id?: string }).id, "факта"),
        decision,
      );
      if (!ok) throw badRequest("Этот факт нельзя подтвердить или отклонить");
      return { ok: true };
    });

    publicApp.patch("/memory/:id", async (request) => {
      const memory = requireMemory(input.memory);
      const body = requestBody(request);
      const result = await memory.correct(
        publicUser(request).id,
        positiveId((request.params as { id?: string }).id, "факта"),
        {
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(body.value === null || typeof body.value === "string"
            ? { value: body.value as string | null }
            : {}),
        },
      );
      if (!result) throw badRequest("Факт не найден");
      // Исправление — это новая версия, а не правка на месте.
      return { version: result.version };
    });

    publicApp.delete("/memory/:id", async (request) => {
      const memory = requireMemory(input.memory);
      const removed = await memory.remove(
        publicUser(request).id,
        positiveId((request.params as { id?: string }).id, "факта"),
      );
      if (!removed) throw badRequest("Факт не найден");
      return { deleted: removed };
    });

    publicApp.post("/tool-approvals/:requestId/decision", async (request) => {
      if (!input.approvals) throw badRequest("Подтверждения инструментов отключены");
      const sdkRequestId = String((request.params as { requestId?: string }).requestId ?? "").trim();
      const decision = requestBody(request).decision;
      if (!sdkRequestId || (decision !== "allow" && decision !== "deny")) throw badRequest("Некорректное решение");
      await input.approvals.decide({ telegramId: publicUser(request).id, sdkRequestId, decision });
      return { ok: true };
    });

    publicApp.post("/work-blocks/:id/start", async (request) => {
      try {
        return {
          work_block: await input.repository.startWorkBlock(
            publicUser(request).id,
            positiveId((request.params as { id?: string }).id, "рабочего блока"),
            requestBody(request),
          ),
        };
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : "Не удалось начать шаг");
      }
    });

    publicApp.post("/work-blocks/:id/complete", async (request) => {
      try {
        return {
          work_block: await input.repository.completeWorkBlock(
            publicUser(request).id,
            positiveId((request.params as { id?: string }).id, "рабочего блока"),
            requestBody(request),
          ),
        };
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : "Не удалось завершить шаг");
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

function requestBody(request: FastifyRequest): Record<string, unknown> {
  return request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
}

function positiveId(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Некорректный ID ${name}`);
  }
  return parsed;
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name}: требуется текст`);
  }
  return value.trim().slice(0, max);
}

function optionalText(value: unknown, max: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("Ожидается текст");
  return value.trim().slice(0, max) || null;
}

function optionalInteger(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Ожидается целое число от ${min} до ${max}`);
  }
  return parsed;
}

function optionalDate(value: unknown): string | null {
  const text = optionalText(value, 10);
  if (text === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new Error("Ожидается дата YYYY-MM-DD");
  }
  return text;
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${name}: недопустимое значение`);
  }
  return value as T;
}
