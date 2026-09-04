import { createHash } from "node:crypto";

import type { Config } from "./config.js";
import type { ConversationPurposeService } from "./conversations/purpose-service.js";
import type { Database } from "./db.js";
import type { LettaService } from "./letta.js";
import type { Logger } from "./logger.js";
import type { RuntimeContextBuilder } from "./runtime/runtime-context.js";
import type { UserTurnLock } from "./turns/user-turn-lock.js";
import type { TelegramClient } from "./telegram.js";
import { TaskEventService } from "./tasks/task-event-service.js";
import { ScheduledTaskRunner, type DueTask } from "./tasks/task-runner.js";
import { isQuietHours } from "./time/cron.js";

// Cron-утилиты переехали в `src/time/cron.ts` (шаг 08): их считает уже не
// только планировщик. Реэкспорт сохраняет прежние точки импорта.
export { assertCronExpression, cronFieldMatches, nextCronDate } from "./time/cron.js";

interface HeartbeatCandidate {
  user_id: string;
  telegram_id: string;
  chat_id: string;
  timezone: string;
  agent_id: string;
  conversation_id: string;
  last_user_message_at: Date | null;
  last_sent_at: Date | null;
  last_message_hash: string | null;
}

export class BackgroundRuntime {
  private taskTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private taskRunning = false;
  private heartbeatRunning = false;
  private readonly taskEvents: TaskEventService;
  private readonly taskRunner: ScheduledTaskRunner;

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly letta: LettaService,
    private readonly queue: UserTurnLock,
    private readonly telegram: TelegramClient,
    private readonly runtimeContext: RuntimeContextBuilder,
    private readonly purposes: ConversationPurposeService,
    private readonly logger: Logger,
    taskEvents?: TaskEventService,
  ) {
    this.taskEvents = taskEvents ?? new TaskEventService(db);
    this.taskRunner = new ScheduledTaskRunner(
      db, letta, queue, telegram, runtimeContext, purposes, this.taskEvents, logger,
    );
  }

  /**
   * Запустить интервалы.
   *
   * `enabled = false` означает, что задачи забрала очередь (шаг 08): в
   * этом случае таймеры не заводятся вовсе. Ровно здесь и держится
   * правило «одна задача не исполняется двумя механизмами» — не
   * договорённостью, а тем, что второй механизм не стартует.
   */
  start(enabled = true): void {
    if (this.taskTimer || this.heartbeatTimer) return;
    if (!enabled) {
      this.logger.info("Интервалы планировщика не запущены: задачи ведёт очередь");
      return;
    }
    this.taskTimer = setInterval(
      () => void this.runTasks(),
      Math.max(this.config.schedulerIntervalMs, 10_000),
    );
    this.heartbeatTimer = setInterval(
      () => void this.runHeartbeats(),
      Math.max(this.config.heartbeatIntervalMs, 60_000),
    );
    this.taskTimer.unref();
    this.heartbeatTimer.unref();
    void this.runTasks();
  }

  /** Работают ли сейчас старые интервалы. Нужно наблюдению и тестам переноса. */
  get schedulerActive(): boolean {
    return this.taskTimer !== null || this.heartbeatTimer !== null;
  }

  /**
   * Что выбрал бы старый механизм прямо сейчас — без блокировок и без
   * побочных действий.
   *
   * Нужно режиму зеркала: сравнить выборки можно, только получив обе, а
   * `claimDueTasks` берёт строки под блокировку и увёл бы задачи у
   * самого себя. Поэтому предпросмотр повторяет условие отбора и ничего
   * не меняет.
   */
  async previewSelection(kind: "reminder" | "heartbeat"): Promise<string[]> {
    if (kind === "heartbeat") {
      const { rows } = await this.db.withSystemScope(
        "scheduler.preview.heartbeat",
        async () => await this.db.query<{ user_id: string }>(
          `-- tenant: system — предпросмотр общесистемной выборки, ничего не меняет
           SELECT u.id AS user_id
             FROM users u
             JOIN agent_links a
               ON a.user_id = u.id AND a.kind = 'eva' AND a.status = 'active'
             LEFT JOIN user_preferences p ON p.user_id = u.id
             LEFT JOIN heartbeat_state h ON h.user_id = u.id
            WHERE u.state = 'active'
              AND NOT u.is_blocked
              AND a.conversation_id IS NOT NULL
              AND COALESCE(p.heartbeat_enabled, true)
              AND COALESCE(h.last_user_message_at, u.last_seen_at, u.created_at)
                  <= now() - COALESCE(p.heartbeat_min_silence, interval '6 hours')
              AND (h.last_sent_at IS NULL OR
                   h.last_sent_at <= now() - COALESCE(p.heartbeat_min_interval, interval '12 hours'))
            ORDER BY COALESCE(h.last_sent_at, '-infinity'::timestamptz)
            LIMIT 25`,
        ),
        { crossUser: true },
      );
      return rows.map((row) => `user:${Number(row.user_id)}`);
    }
    const { rows } = await this.db.withSystemScope(
      "scheduler.preview.reminder",
      async () => await this.db.query<{ id: string }>(
        `-- tenant: system — предпросмотр общесистемной выборки, ничего не меняет
         SELECT t.id
           FROM tasks t
           JOIN users u ON u.id = t.user_id
           JOIN agent_links a
             ON a.user_id = t.user_id AND a.kind = 'eva' AND a.status = 'active'
          WHERE t.status IN ('open', 'in_progress')
            AND a.conversation_id IS NOT NULL
            AND COALESCE(t.next_run_at, t.remind_at, t.due_at) <= now()
            AND (t.last_run_at IS NULL
                 OR t.last_run_at < COALESCE(t.next_run_at, t.remind_at, t.due_at))
            AND (t.locked_at IS NULL OR t.locked_at < now() - interval '15 minutes')
          ORDER BY COALESCE(t.next_run_at, t.remind_at, t.due_at)
          LIMIT 25`,
      ),
      { crossUser: true },
    );
    return rows.map((row) => `task:${row.id}`);
  }

  stop(): void {
    if (this.taskTimer) clearInterval(this.taskTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.taskTimer = null;
    this.heartbeatTimer = null;
  }

  async runTasks(): Promise<void> {
    if (this.taskRunning) return;
    this.taskRunning = true;
    try {
      // Просроченные подписки и выборка задач идут сразу по многим
      // пользователям — это объявленная системная работа. Сама же
      // задача выполняется уже в области своего владельца.
      const tasks = await this.db.withSystemScope(
        "scheduler.claim",
        async () => {
          await this.db.query(
            `
              -- tenant: system — периодическое истечение подписок по сроку, общесистемная развёртка, а не запрос пользователя
              UPDATE subscriptions
                SET status = 'expired'
              WHERE status IN ('trialing', 'active', 'past_due')
                AND current_period_end IS NOT NULL
                AND current_period_end <= now()`,
          );
          if (!this.telegram.configured) return [];
          return await this.claimDueTasks();
        },
        { crossUser: true },
      );
      for (const task of tasks) {
        await this.db.withUserScope(
          {
            userId: Number(task.user_id),
            telegramId: Number(task.telegram_id),
            label: "scheduler.task",
          },
          async () => await this.executeTask(task),
        );
      }
    } catch (error) {
      this.logger.error("Ошибка планировщика задач", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.taskRunning = false;
    }
  }

  async runHeartbeats(): Promise<void> {
    if (this.heartbeatRunning || !this.telegram.configured) return;
    this.heartbeatRunning = true;
    try {
      const { rows } = await this.db.withSystemScope(
        "heartbeat.candidates",
        async () => await this.db.query<HeartbeatCandidate>(
          `
            -- tenant: system — кандидаты heartbeat выбираются по всем пользователям, сообщение готовится уже в области владельца
            SELECT u.id AS user_id,
                  u.telegram_id,
                  COALESCE(t.chat_id, u.telegram_id) AS chat_id,
                  u.timezone,
                  a.agent_id,
                  a.conversation_id,
                  h.last_user_message_at,
                  h.last_sent_at,
                  h.last_message_hash
             FROM users u
             JOIN agent_links a
               ON a.user_id = u.id AND a.kind = 'eva' AND a.status = 'active'
             LEFT JOIN user_preferences p ON p.user_id = u.id
             LEFT JOIN heartbeat_state h ON h.user_id = u.id
             LEFT JOIN LATERAL (
               SELECT chat_id FROM telegram_updates
                WHERE user_id = u.id AND chat_id IS NOT NULL
                ORDER BY received_at DESC LIMIT 1
             ) t ON true
            WHERE u.state = 'active'
              AND NOT u.is_blocked
              AND a.conversation_id IS NOT NULL
              AND COALESCE(p.heartbeat_enabled, true)
              AND COALESCE(h.last_user_message_at, u.last_seen_at, u.created_at)
                  <= now() - COALESCE(p.heartbeat_min_silence, interval '6 hours')
              AND (h.last_sent_at IS NULL OR
                   h.last_sent_at <= now() - COALESCE(p.heartbeat_min_interval, interval '12 hours'))
            ORDER BY COALESCE(h.last_sent_at, '-infinity'::timestamptz)
            LIMIT 25`,
        ),
        { crossUser: true },
      );
      for (const candidate of rows) {
        if (isQuietHours(candidate.timezone)) continue;
        await this.db.withUserScope(
          {
            userId: Number(candidate.user_id),
            telegramId: Number(candidate.telegram_id),
            label: "heartbeat",
          },
          async () => await this.executeHeartbeat(candidate),
        );
      }
    } catch (error) {
      this.logger.error("Ошибка heartbeat", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.heartbeatRunning = false;
    }
  }

  private async claimDueTasks(): Promise<DueTask[]> {
    return await this.db.transaction(async (client) => {
      const { rows } = await client.query<DueTask>(
        `
          -- tenant: system — планировщик забирает наступившие задачи по всем пользователям, выполнение идёт в области владельца
          SELECT t.id, t.user_id, u.telegram_id,
                COALESCE(tu.chat_id, u.telegram_id) AS chat_id,
                t.kind, t.title, t.description, t.priority, t.attempts,
                t.due_at, t.remind_at,
                g.title AS related_goal,
                -- Сколько раз этот срок уже отрабатывал: у напоминания это
                -- отправки, у действия — выполнения. Род задачи один на
                -- строку, поэтому счётчик тоже один.
                (SELECT count(*)::int FROM task_events e
                  WHERE e.task_id=t.id
                    AND e.event_type IN ('reminder_sent', 'action_done')) AS previous_runs,
                (SELECT e.event_type FROM task_events e
                  WHERE e.task_id=t.id ORDER BY e.created_at DESC LIMIT 1) AS last_task_action,
                t.cron_expression, t.repeat_enabled,
                COALESCE(t.timezone, u.timezone, 'UTC') AS timezone,
                a.agent_id, a.conversation_id,
                COALESCE(t.next_run_at, t.remind_at, t.due_at) AS scheduled_at,
                -- Язык нужен не ходу агента, а детерминированному тексту
                -- планировщика: его отправляет код, когда ход не состоялся.
                u.language_mode, u.preferred_language,
                u.last_message_language, u.language_code
           FROM tasks t
           JOIN users u ON u.id = t.user_id
           JOIN agent_links a
             ON a.user_id = t.user_id AND a.kind = 'eva' AND a.status = 'active'
           LEFT JOIN LATERAL (
             SELECT chat_id FROM telegram_updates
              WHERE user_id = u.id AND chat_id IS NOT NULL
              ORDER BY received_at DESC LIMIT 1
           ) tu ON true
           LEFT JOIN goals g ON g.id = t.goal_id AND g.user_id = t.user_id
          WHERE t.status IN ('open', 'in_progress')
            AND a.conversation_id IS NOT NULL
            AND COALESCE(t.next_run_at, t.remind_at, t.due_at) <= now()
            AND (t.last_run_at IS NULL OR t.last_run_at < COALESCE(t.next_run_at, t.remind_at, t.due_at))
            AND (t.locked_at IS NULL OR t.locked_at < now() - interval '15 minutes')
          ORDER BY COALESCE(t.next_run_at, t.remind_at, t.due_at)
          FOR UPDATE OF t SKIP LOCKED
          LIMIT 25`,
      );
      if (rows.length > 0) {
        await client.query(
          `
            -- tenant: system — блокировка уже отобранных строк планировщика: список id получен выборкой выше
            UPDATE tasks SET locked_at = now() WHERE id = ANY($1::bigint[])`,
          [rows.map((row) => row.id)],
        );
      }
      return rows;
    });
  }

  /**
   * Выполнение вынесено в `ScheduledTaskRunner`: интервалы отвечают за
   * то, ЧТО забрать, а он — за то, что с этим сделать.
   */
  private async executeTask(task: DueTask): Promise<void> {
    await this.taskRunner.execute(task);
  }

  private async executeHeartbeat(candidate: HeartbeatCandidate): Promise<void> {
    try {
      const scheduler = await this.purposes.ensure({
        userId: Number(candidate.user_id),
        agentId: candidate.agent_id,
        purpose: "scheduler",
        parentConversationId: candidate.conversation_id,
      });
      const userMessage = [
          "[HEARTBEAT CONTROL]",
          "Пользователь давно не писал. Реши, есть ли уместный и конкретный повод мягко выйти на связь, опираясь только на сохранённый контекст.",
          "Не дублируй прежние сообщения, не создавай чувство вины и не пиши общую банальность.",
          "Если полезного повода нет, ответь ровно HEARTBEAT_SKIP.",
          "Иначе дай только готовое сообщение пользователю, до 1200 символов.",
        ].join("\n");
      const context = await this.runtimeContext.build({
        userId: Number(candidate.user_id),
        conversationId: scheduler.conversationId,
        userMessage,
        detectLanguage: false,
      });
      const prompt = this.runtimeContext.wrapUserMessage(context, userMessage, {
        internalOperationType: "heartbeat",
      });
      const turn = await this.queue.run(
        Number(candidate.telegram_id),
        () => this.letta.runTurn(scheduler.conversationId, prompt),
        { userId: Number(candidate.user_id), conversationId: scheduler.conversationId },
      );
      const reply = turn.reply.trim().slice(0, 1200);
      if (!reply || reply === "HEARTBEAT_SKIP") {
        await this.saveHeartbeat(candidate, null, "skipped");
        return;
      }
      const hash = createHash("sha256").update(reply, "utf8").digest("hex");
      if (hash === candidate.last_message_hash) {
        await this.saveHeartbeat(candidate, null, "duplicate");
        return;
      }
      await this.telegram.withPriority(
        "reminder",
        async () => await this.telegram.sendMessage(Number(candidate.chat_id), reply),
      );
      await this.saveHeartbeat(candidate, hash, "sent");
      await this.db.markAgentUsed(candidate.agent_id, Number(candidate.user_id));
    } catch (error) {
      this.logger.warn("Heartbeat не отправлен", {
        userId: candidate.user_id,
        message: error instanceof Error ? error.message : String(error),
      });
      await this.db.query(
        `INSERT INTO heartbeat_state (user_id, last_result)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET last_result = EXCLUDED.last_result`,
        [candidate.user_id, `error:${String(error).slice(0, 500)}`],
      );
    }
  }

  private async saveHeartbeat(
    candidate: HeartbeatCandidate,
    hash: string | null,
    result: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO heartbeat_state (user_id, last_sent_at, last_message_hash, last_result)
       VALUES ($1, now(), $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         last_sent_at = now(),
         last_message_hash = COALESCE(EXCLUDED.last_message_hash, heartbeat_state.last_message_hash),
         last_result = EXCLUDED.last_result`,
      [candidate.user_id, hash, result],
    );
  }
}
