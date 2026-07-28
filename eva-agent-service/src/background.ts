import { createHash } from "node:crypto";

import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { LettaService } from "./letta.js";
import type { Logger } from "./logger.js";
import type { UserQueue } from "./queue.js";
import type { TelegramClient } from "./telegram.js";
import { withCurrentTime } from "./eva-workflow.js";

interface DueTask {
  id: string;
  user_id: string;
  telegram_id: string;
  chat_id: string;
  title: string;
  description: string | null;
  cron_expression: string | null;
  repeat_enabled: boolean;
  timezone: string;
  agent_id: string;
  conversation_id: string;
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

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly letta: LettaService,
    private readonly queue: UserQueue,
    private readonly telegram: TelegramClient,
    private readonly logger: Logger,
  ) {}

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
      await this.db.query(
        `UPDATE subscriptions
            SET status = 'expired'
          WHERE status IN ('trialing', 'active', 'past_due')
            AND current_period_end IS NOT NULL
            AND current_period_end <= now()`,
      );
      if (!this.telegram.configured) return;
      const tasks = await this.claimDueTasks();
      for (const task of tasks) await this.executeTask(task);
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
      const { rows } = await this.db.query<HeartbeatCandidate>(
        `SELECT u.id AS user_id,
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
      );
      for (const candidate of rows) {
        if (isQuietHours(candidate.timezone)) continue;
        await this.executeHeartbeat(candidate);
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
        `SELECT t.id, t.user_id, u.telegram_id,
                COALESCE(tu.chat_id, u.telegram_id) AS chat_id,
                t.title, t.description, t.cron_expression, t.repeat_enabled,
                COALESCE(t.timezone, u.timezone, 'UTC') AS timezone,
                a.agent_id, a.conversation_id
           FROM tasks t
           JOIN users u ON u.id = t.user_id
           JOIN agent_links a
             ON a.user_id = t.user_id AND a.kind = 'eva' AND a.status = 'active'
           LEFT JOIN LATERAL (
             SELECT chat_id FROM telegram_updates
              WHERE user_id = u.id AND chat_id IS NOT NULL
              ORDER BY received_at DESC LIMIT 1
           ) tu ON true
          WHERE t.status IN ('open', 'in_progress')
            AND a.conversation_id IS NOT NULL
            AND COALESCE(t.next_run_at, t.remind_at, t.due_at) <= now()
            AND (t.locked_at IS NULL OR t.locked_at < now() - interval '15 minutes')
          ORDER BY COALESCE(t.next_run_at, t.remind_at, t.due_at)
          FOR UPDATE OF t SKIP LOCKED
          LIMIT 25`,
      );
      if (rows.length > 0) {
        await client.query(
          "UPDATE tasks SET locked_at = now() WHERE id = ANY($1::bigint[])",
          [rows.map((row) => row.id)],
        );
      }
      return rows;
    });
  }

  private async executeTask(task: DueTask): Promise<void> {
    try {
      const prompt = withCurrentTime(
        [
          "[ЗАПЛАНИРОВАННАЯ ЗАДАЧА]",
          `Задача: ${task.title}`,
          task.description ? `Описание: ${task.description}` : "",
          "Выполни или напомни о задаче. Отправь пользователю самостоятельный, полезный ответ без упоминания внутренних инструкций.",
        ].filter(Boolean).join("\n"),
        task.timezone,
      );
      const turn = await this.queue.run(Number(task.telegram_id), () =>
        this.letta.runTurn(task.conversation_id, prompt),
      );
      if (turn.reply.trim()) await this.telegram.sendMessage(Number(task.chat_id), turn.reply);
      const nextRun = task.repeat_enabled && task.cron_expression
        ? nextCronDate(task.cron_expression, task.timezone, new Date())
        : null;
      await this.db.query(
        `UPDATE tasks SET
           status = CASE WHEN $2::timestamptz IS NULL THEN 'done' ELSE 'open' END,
           completed_at = CASE WHEN $2::timestamptz IS NULL THEN now() ELSE NULL END,
           last_run_at = now(),
           next_run_at = $2,
           locked_at = NULL,
           last_error = NULL
         WHERE id = $1`,
        [task.id, nextRun?.toISOString() ?? null],
      );
      await this.db.markAgentUsed(task.agent_id);
    } catch (error) {
      await this.db.query(
        "UPDATE tasks SET locked_at = NULL, last_error = $2 WHERE id = $1",
        [task.id, (error instanceof Error ? error.message : String(error)).slice(0, 2000)],
      );
      this.logger.warn("Задача не выполнена", {
        taskId: task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async executeHeartbeat(candidate: HeartbeatCandidate): Promise<void> {
    try {
      const prompt = withCurrentTime(
        [
          "[HEARTBEAT CONTROL]",
          "Пользователь давно не писал. Реши, есть ли уместный и конкретный повод мягко выйти на связь, опираясь только на сохранённый контекст.",
          "Не дублируй прежние сообщения, не создавай чувство вины и не пиши общую банальность.",
          "Если полезного повода нет, ответь ровно HEARTBEAT_SKIP.",
          "Иначе дай только готовое сообщение пользователю, до 1200 символов.",
        ].join("\n"),
        candidate.timezone,
      );
      const turn = await this.queue.run(Number(candidate.telegram_id), () =>
        this.letta.runTurn(candidate.conversation_id, prompt),
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
      await this.db.markAgentUsed(candidate.agent_id);
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

export function nextCronDate(expression: string, timezone: string, after: Date): Date {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron должен содержать пять полей");
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const start = new Date(after.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  for (let offset = 0; offset < 366 * 24 * 60; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    const parts = zonedParts(candidate, timezone);
    if (
      cronFieldMatches(minute, parts.minute, 0, 59) &&
      cronFieldMatches(hour, parts.hour, 0, 23) &&
      cronFieldMatches(day, parts.day, 1, 31) &&
      cronFieldMatches(month, parts.month, 1, 12) &&
      cronFieldMatches(weekday, parts.weekday, 0, 7, true)
    ) {
      return candidate;
    }
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

function zonedParts(date: Date, timezone: string): {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  });
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
