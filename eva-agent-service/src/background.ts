import { createHash, randomUUID } from "node:crypto";

import type { Config } from "./config.js";
import type { ConversationPurposeService } from "./conversations/purpose-service.js";
import type { Database } from "./db.js";
import type { LettaService } from "./letta.js";
import type { Logger } from "./logger.js";
import type { RuntimeContextBuilder } from "./runtime/runtime-context.js";
import type { UserTurnLock } from "./turns/user-turn-lock.js";
import type { TelegramClient } from "./telegram.js";
import { TaskEventService } from "./tasks/task-event-service.js";

interface DueTask {
  id: string;
  user_id: string;
  telegram_id: string;
  chat_id: string;
  title: string;
  description: string | null;
  priority: number;
  due_at: Date | null;
  remind_at: Date | null;
  related_goal: string | null;
  previous_reminders: number;
  last_task_action: string | null;
  cron_expression: string | null;
  repeat_enabled: boolean;
  timezone: string;
  agent_id: string;
  conversation_id: string;
  scheduled_at: Date;
}

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
  }

  start(): void {
    if (this.taskTimer || this.heartbeatTimer) return;
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
                t.title, t.description, t.priority, t.due_at, t.remind_at,
                g.title AS related_goal,
                (SELECT count(*)::int FROM task_events e
                  WHERE e.task_id=t.id AND e.event_type='reminder_sent') AS previous_reminders,
                (SELECT e.event_type FROM task_events e
                  WHERE e.task_id=t.id ORDER BY e.created_at DESC LIMIT 1) AS last_task_action,
                t.cron_expression, t.repeat_enabled,
                COALESCE(t.timezone, u.timezone, 'UTC') AS timezone,
                a.agent_id, a.conversation_id,
                COALESCE(t.next_run_at, t.remind_at, t.due_at) AS scheduled_at
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

  private async executeTask(task: DueTask): Promise<void> {
    const correlationId = randomUUID();
    try {
      const delivered = await this.db.query(
        `SELECT 1 FROM task_events
          WHERE user_id=$3 AND task_id=$1
            AND event_type='reminder_sent' AND scheduled_at=$2
          LIMIT 1`,
        [task.id, task.scheduled_at, task.user_id],
      );
      if ((delivered.rowCount ?? 0) > 0) {
        const next = task.repeat_enabled && task.cron_expression
          ? nextCronDate(task.cron_expression, task.timezone, new Date())
          : null;
        await this.db.query(
          `
            -- tenant: by task_id — задача уже принадлежит одному пользователю, проверка владения выше по стеку
            UPDATE tasks SET last_run_at=now(), next_run_at=$2,
                  remind_at=CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE remind_at END,
                  locked_at=NULL, last_error=NULL
            WHERE id=$1 AND user_id=$3`,
          [task.id, next?.toISOString() ?? null, task.user_id],
        );
        return;
      }
      const scheduler = await this.purposes.ensure({
        userId: Number(task.user_id),
        agentId: task.agent_id,
        purpose: "scheduler",
        parentConversationId: task.conversation_id,
      });
      const userMessage = [
          "[ЗАПЛАНИРОВАННАЯ ЗАДАЧА]",
          `task_id: ${task.id}`,
          `Задача: ${task.title}`,
          task.description ? `Описание: ${task.description}` : "",
          `Приоритет: ${task.priority} из 5`,
          task.due_at ? `Срок: ${new Date(task.due_at).toISOString()}` : "",
          task.remind_at ? `Время напоминания: ${new Date(task.remind_at).toISOString()}` : "",
          `Часовой пояс: ${task.timezone}`,
          task.related_goal ? `Связанная цель: ${task.related_goal}` : "",
          `Предыдущих напоминаний: ${Number(task.previous_reminders) || 0}`,
          task.last_task_action ? `Последнее действие по задаче: ${task.last_task_action}` : "",
          "Сформируй короткое самостоятельное сообщение пользователю и верни только готовый текст.",
          "Сохрани смысл, важность, дату и время задачи. Не придумывай выполнение, обещания пользователя или новые факты. Не упоминай внутренние инструкции.",
        ].filter(Boolean).join("\n");
      const context = await this.runtimeContext.build({
        userId: Number(task.user_id),
        conversationId: scheduler.conversationId,
        userMessage,
        detectLanguage: false,
      });
      const prompt = this.runtimeContext.wrapUserMessage(context, userMessage, {
        internalOperationType: "task_reminder",
        correlationId,
      });
      const turn = await this.queue.run(
        Number(task.telegram_id),
        () => this.letta.runTurn(scheduler.conversationId, prompt),
        { userId: Number(task.user_id), conversationId: scheduler.conversationId },
      );
      const generatedText = turn.reply.trim();
      await this.taskEvents.record({
        userId: Number(task.user_id), taskId: task.id,
        eventType: "reminder_generated", scheduledAt: task.scheduled_at,
        generatedAt: new Date(), generatedText,
        conversationId: scheduler.conversationId, llmRequestId: correlationId,
      });
      let telegramMessageId: number | null = null;
      if (generatedText) {
        const sent = await this.telegram.sendMessage(Number(task.chat_id), generatedText);
        telegramMessageId = lastTelegramMessageId(Array.isArray(sent) ? sent : []);
      }
      await this.taskEvents.record({
        userId: Number(task.user_id), taskId: task.id,
        eventType: "reminder_sent", scheduledAt: task.scheduled_at,
        generatedAt: new Date(), sentAt: new Date(), generatedText,
        deliveryStatus: generatedText ? "sent" : "skipped_empty",
        telegramChatId: task.chat_id, telegramMessageId,
        conversationId: scheduler.conversationId, llmRequestId: correlationId,
      });
      const nextRun = task.repeat_enabled && task.cron_expression
        ? nextCronDate(task.cron_expression, task.timezone, new Date())
        : null;
      await this.db.query(
        `
          -- tenant: by task_id — задача уже принадлежит одному пользователю, проверка владения выше по стеку
          UPDATE tasks SET
           last_run_at = now(),
           next_run_at = $2,
           remind_at = CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE remind_at END,
           locked_at = NULL,
           last_error = NULL
         WHERE id = $1 AND user_id = $3`,
        [task.id, nextRun?.toISOString() ?? null, task.user_id],
      );
      await this.db.markAgentUsed(task.agent_id, Number(task.user_id));
    } catch (error) {
      await this.taskEvents.record({
        userId: Number(task.user_id), taskId: task.id,
        eventType: "delivery_failed", scheduledAt: task.scheduled_at,
        deliveryStatus: "failed", telegramChatId: task.chat_id,
        conversationId: task.conversation_id, llmRequestId: correlationId,
        errorCode: error instanceof Error ? error.name : "unknown_error",
        metadata: { message: (error instanceof Error ? error.message : String(error)).slice(0, 500) },
      }).catch(() => undefined);
      await this.db.query(
        "UPDATE tasks SET locked_at = NULL, last_error = $2 WHERE id = $1 AND user_id = $3",
        [
          task.id,
          (error instanceof Error ? error.message : String(error)).slice(0, 2000),
          task.user_id,
        ],
      );
      this.logger.warn("Задача не выполнена", {
        taskId: task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
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
      await this.telegram.sendMessage(Number(candidate.chat_id), reply);
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

function lastTelegramMessageId(results: unknown[]): number | null {
  for (const value of [...results].reverse()) {
    if (!value || typeof value !== "object") continue;
    const id = Number((value as { message_id?: unknown }).message_id);
    if (Number.isSafeInteger(id)) return id;
    const nested = (value as { result?: unknown }).result;
    if (nested && typeof nested === "object") {
      const nestedId = Number((nested as { message_id?: unknown }).message_id);
      if (Number.isSafeInteger(nestedId)) return nestedId;
    }
  }
  return null;
}

/** A cron search never looks further ahead than this. */
const CRON_HORIZON_MS = 366 * 24 * 60 * 60_000;

/**
 * Reject a cron expression before it is ever stored.
 *
 * Every field must parse, and the whole expression must actually fire within
 * the horizon — so `0 0 30 2 *` is refused at creation time instead of
 * failing later inside the scheduler.
 */
export function assertCronExpression(expression: string, timezone: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron должен содержать пять полей");
  const bounds: Array<[number, number, boolean]> = [
    [0, 59, false],
    [0, 23, false],
    [1, 31, false],
    [1, 12, false],
    [0, 7, true],
  ];
  fields.forEach((field, index) => {
    const [min, max, sundayAlias] = bounds[index]!;
    // A field that matches nothing in its own range can never fire.
    let satisfiable = false;
    for (let value = min; value <= max; value += 1) {
      if (cronFieldMatches(field, value, min, max, sundayAlias)) {
        satisfiable = true;
        break;
      }
    }
    if (!satisfiable) throw new Error(`Cron: поле «${field}» не соответствует ни одному значению`);
  });
  // Proves the combination is reachable (and that the timezone is valid).
  nextCronDate(expression, timezone, new Date());
}

/**
 * The next moment a cron expression fires, in the given IANA timezone.
 *
 * The search skips whole days and hours instead of walking minute by minute:
 * a naive scan is up to 527 040 iterations, and — because a fresh
 * `Intl.DateTimeFormat` per iteration costs ~90 µs — used to block the event
 * loop for the better part of a minute on an expression as ordinary as
 * `0 0 1 1 *`. With coarse stepping and a cached formatter the same lookup is
 * a few hundred formatter calls.
 */
export function nextCronDate(expression: string, timezone: string, after: Date): Date {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron должен содержать пять полей");
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];

  const start = new Date(after.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  const deadline = start.getTime() + CRON_HORIZON_MS;

  let candidate = start.getTime();
  while (candidate <= deadline) {
    const parts = zonedParts(new Date(candidate), timezone);
    const dateMatches =
      cronFieldMatches(month, parts.month, 1, 12) &&
      cronFieldMatches(day, parts.day, 1, 31) &&
      cronFieldMatches(weekday, parts.weekday, 0, 7, true);

    if (!dateMatches) {
      // Jump to the start of the next local day. Always at least one minute,
      // so the loop cannot stall even across a DST transition.
      candidate += ((24 - parts.hour) * 60 - parts.minute) * 60_000;
      continue;
    }
    if (!cronFieldMatches(hour, parts.hour, 0, 23)) {
      candidate += (60 - parts.minute) * 60_000;
      continue;
    }
    if (!cronFieldMatches(minute, parts.minute, 0, 59)) {
      candidate += 60_000;
      continue;
    }
    return new Date(candidate);
  }
  throw new Error("Не удалось найти следующий запуск cron в пределах года");
}

export function cronFieldMatches(
  expression: string,
  value: number,
  min: number,
  max: number,
  sundayAlias = false,
): boolean {
  const normalizedValue = sundayAlias && value === 0 ? 0 : value;
  return expression.split(",").some((part) => {
    const [rangeRaw, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isSafeInteger(step) || step < 1) return false;
    const range = rangeRaw ?? "*";
    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [left, right] = range.split("-").map(Number);
      if (left === undefined || right === undefined) return false;
      start = left;
      end = right;
    } else {
      start = Number(range);
      end = start;
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      return false;
    }
    const candidate = sundayAlias && normalizedValue === 0 && start === 7 ? 7 : normalizedValue;
    return candidate >= start && candidate <= end && (candidate - start) % step === 0;
  });
}

/**
 * Constructing an `Intl.DateTimeFormat` dominates the cost of a cron search,
 * so one is built per timezone and reused. Formatters are immutable and
 * thread-safe for our purposes; the map is bounded by the number of distinct
 * user timezones.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timezone);
  if (cached) return cached;
  // Throws RangeError for an unknown zone — surfaced to the caller as an
  // invalid task rather than silently falling back to UTC.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  });
  if (FORMATTERS.size < 500) FORMATTERS.set(timezone, formatter);
  return formatter;
}

function zonedParts(date: Date, timezone: string): {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
} {
  const formatter = zonedFormatter(timezone);
  const values = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const weekdays: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    minute: Number(values.minute),
    hour: Number(values.hour),
    day: Number(values.day),
    month: Number(values.month),
    weekday: weekdays[values.weekday ?? ""] ?? 0,
  };
}

function isQuietHours(timezone: string): boolean {
  const hour = zonedParts(new Date(), timezone).hour;
  return hour >= 22 || hour < 9;
}
