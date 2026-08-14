import type { Database } from "../db.js";
import { formatLocalShort, humanizeInterval } from "../time/local-date-time.js";

export type TaskEventType =
  | "created" | "updated" | "reminder_generated" | "reminder_sent"
  | "delivery_failed" | "user_replied" | "snoozed" | "completed"
  | "cancelled" | "reopened";

export interface TaskEventInput {
  userId: number;
  taskId: number | string;
  eventType: TaskEventType;
  scheduledAt?: Date | string | null;
  generatedAt?: Date | string | null;
  sentAt?: Date | string | null;
  generatedText?: string | null;
  deliveryStatus?: string | null;
  telegramChatId?: number | string | null;
  telegramMessageId?: number | string | null;
  conversationId?: string | null;
  llmRequestId?: string | null;
  errorCode?: string | null;
  metadata?: Record<string, unknown>;
}

export class TaskEventService {
  constructor(private readonly db: Database) {}

  async record(input: TaskEventInput): Promise<Record<string, unknown> | null> {
    const routing = input.llmRequestId
      ? await this.routerOutcome(input.userId, input.llmRequestId)
      : null;
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO task_events (
         user_id, task_id, event_type, scheduled_at, generated_at, sent_at,
         generated_text, delivery_status, telegram_chat_id, telegram_message_id,
         conversation_id, routing_mode, requested_route, effective_route,
         llm_request_id, actual_provider_id, actual_model, error_code, metadata
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb
       )
       ON CONFLICT (task_id, event_type, scheduled_at)
         WHERE event_type IN ('reminder_generated', 'reminder_sent')
       DO UPDATE SET
         generated_at = COALESCE(EXCLUDED.generated_at, task_events.generated_at),
         sent_at = COALESCE(EXCLUDED.sent_at, task_events.sent_at),
         generated_text = COALESCE(EXCLUDED.generated_text, task_events.generated_text),
         delivery_status = COALESCE(EXCLUDED.delivery_status, task_events.delivery_status),
         telegram_chat_id = COALESCE(EXCLUDED.telegram_chat_id, task_events.telegram_chat_id),
         telegram_message_id = COALESCE(EXCLUDED.telegram_message_id, task_events.telegram_message_id),
         routing_mode = COALESCE(EXCLUDED.routing_mode, task_events.routing_mode),
         requested_route = COALESCE(EXCLUDED.requested_route, task_events.requested_route),
         effective_route = COALESCE(EXCLUDED.effective_route, task_events.effective_route),
         llm_request_id = COALESCE(EXCLUDED.llm_request_id, task_events.llm_request_id),
         actual_provider_id = COALESCE(EXCLUDED.actual_provider_id, task_events.actual_provider_id),
         actual_model = COALESCE(EXCLUDED.actual_model, task_events.actual_model),
         error_code = COALESCE(EXCLUDED.error_code, task_events.error_code),
         metadata = task_events.metadata || EXCLUDED.metadata
       RETURNING *`,
      [
        input.userId, input.taskId, input.eventType, input.scheduledAt ?? null,
        input.generatedAt ?? null, input.sentAt ?? null,
        input.generatedText?.slice(0, 12_000) ?? null, input.deliveryStatus ?? null,
        input.telegramChatId ?? null, input.telegramMessageId ?? null,
        input.conversationId ?? null, routing?.routing_mode ?? null,
        routing?.requested_route ?? null, routing?.effective_route ?? null,
        input.llmRequestId ?? null, routing?.actual_provider_id ?? null,
        routing?.model ?? null, input.errorCode ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return rows[0] ?? null;
  }

  async findByTelegramReply(
    userId: number,
    chatId: number,
    repliedMessageId: number,
  ): Promise<{ task_id: string; title: string; status: string } | null> {
    const { rows } = await this.db.query<{ task_id: string; title: string; status: string }>(
      `SELECT e.task_id, t.title, t.status
         FROM task_events e JOIN tasks t ON t.id = e.task_id AND t.user_id = e.user_id
        WHERE e.user_id = $1 AND e.telegram_chat_id = $2
          AND e.telegram_message_id = $3 AND e.event_type = 'reminder_sent'
        ORDER BY e.created_at DESC LIMIT 1`,
      [userId, chatId, repliedMessageId],
    );
    return rows[0] ?? null;
  }

  async recent(userId: number, limit = 20): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT e.*, t.title, t.status AS task_status
         FROM task_events e JOIN tasks t ON t.id = e.task_id AND t.user_id = e.user_id
        WHERE e.user_id = $1
        ORDER BY e.created_at DESC LIMIT $2`,
      [userId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows;
  }

  async recentOpenReminderTasks(
    userId: number,
    limit = 3,
  ): Promise<Array<{ task_id: string; title: string }>> {
    const { rows } = await this.db.query<{ task_id: string; title: string }>(
      `SELECT DISTINCT ON (e.task_id) e.task_id, t.title
         FROM task_events e JOIN tasks t ON t.id=e.task_id AND t.user_id=e.user_id
        WHERE e.user_id=$1 AND e.event_type='reminder_sent'
          AND t.status IN ('open','in_progress')
        ORDER BY e.task_id, e.sent_at DESC NULLS LAST
        LIMIT $2`,
      [userId, Math.min(Math.max(limit, 1), 10)],
    );
    return rows;
  }

  async forTask(userId: number, taskId: number, limit = 50): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT e.*, t.title, t.status AS task_status
         FROM task_events e JOIN tasks t ON t.id = e.task_id AND t.user_id = e.user_id
        WHERE e.user_id = $1 AND e.task_id = $2
        ORDER BY e.created_at DESC LIMIT $3`,
      [userId, taskId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows;
  }

  async complete(userId: number, taskId: number): Promise<Record<string, unknown> | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE tasks SET status='done', completed_at=now(), next_run_at=NULL,
              remind_at=NULL, locked_at=NULL
        WHERE id=$1 AND user_id=$2 RETURNING *`,
      [taskId, userId],
    );
    if (rows[0]) await this.record({ userId, taskId, eventType: "completed" });
    return rows[0] ?? null;
  }

  async cancel(userId: number, taskId: number): Promise<Record<string, unknown> | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE tasks SET status='canceled', completed_at=NULL, next_run_at=NULL,
              remind_at=NULL, locked_at=NULL
        WHERE id=$1 AND user_id=$2 RETURNING *`,
      [taskId, userId],
    );
    if (rows[0]) await this.record({ userId, taskId, eventType: "cancelled" });
    return rows[0] ?? null;
  }

  async snooze(userId: number, taskId: number, until: Date): Promise<Record<string, unknown> | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE tasks SET status=CASE WHEN status='done' THEN 'open' ELSE status END,
              completed_at=NULL, remind_at=$3, next_run_at=$3, locked_at=NULL
        WHERE id=$1 AND user_id=$2 RETURNING *`,
      [taskId, userId, until.toISOString()],
    );
    if (rows[0]) await this.record({
      userId, taskId, eventType: "snoozed", scheduledAt: until,
      metadata: { snoozed_until: until.toISOString() },
    });
    return rows[0] ?? null;
  }

  /**
   * Ближайшие напоминания: когда сработают и через сколько.
   *
   * Промежуток считает серверный код, а не модель. Без этого она берёт
   * его из головы и ошибается на часы: «до будильника пять с половиной
   * часов», когда до него три с половиной. Момент срабатывания берётся
   * тем же выражением, что и у планировщика напоминаний
   * (`COALESCE(next_run_at, remind_at, due_at)`), — двух представлений
   * о времени задачи быть не должно.
   */
  async upcomingLines(
    userId: number,
    timezone: string,
    now: Date = new Date(),
  ): Promise<string[]> {
    const { rows } = await this.db.query<{ title: string; scheduled_at: Date }>(
      `SELECT t.title, COALESCE(t.next_run_at, t.remind_at, t.due_at) AS scheduled_at
         FROM tasks t
        WHERE t.user_id = $1
          -- Тот же положительный отбор, что у планировщика напоминаний:
          -- перечислять исключения значит разойтись с ним на первом же
          -- новом статусе (в схеме, к слову, «canceled» с одной «l»).
          AND t.status IN ('open', 'in_progress')
          AND COALESCE(t.next_run_at, t.remind_at, t.due_at) > now()
        ORDER BY COALESCE(t.next_run_at, t.remind_at, t.due_at)
        LIMIT 3`,
      [userId],
    );
    return rows.map((row) => {
      const at = new Date(row.scheduled_at);
      return `${formatLocalShort(at, timezone)} (через ${
        humanizeInterval(at.getTime() - now.getTime())
      }): «${row.title}»`.slice(0, 300);
    });
  }

  /**
   * Недавние события задач. Часовой пояс обязателен: с умолчанием любой
   * новый потребитель молча получал бы UTC в виде, неотличимом от
   * местного времени, — ровно ту путаницу, ради которой перевод и делался.
   */
  async contextLines(userId: number, timezone: string): Promise<string[]> {
    const { rows } = await this.db.query<{
      title: string; event_type: string; created_at: Date; task_status: string;
    }>(
      `SELECT t.title, e.event_type, e.created_at, t.status AS task_status
         FROM task_events e JOIN tasks t ON t.id=e.task_id AND t.user_id=e.user_id
        WHERE e.user_id=$1 AND e.created_at >= now() - interval '14 days'
          AND e.event_type IN ('reminder_sent','user_replied','snoozed','completed','cancelled')
        ORDER BY e.created_at DESC LIMIT 5`,
      [userId],
    );
    return rows.map((row) => {
      // Местное время, а не UTC: рядом в контексте стоит local_time
      // пользователя, и две шкалы в одном блоке модель сводит неверно —
      // «напоминание было три часа назад» превращается во «вчера».
      const at = formatLocalShort(row.created_at, timezone);
      const action: Record<string, string> = {
        reminder_sent: "отправлено напоминание",
        user_replied: "получен ответ на напоминание",
        snoozed: "напоминание перенесено",
        completed: "задача выполнена",
        cancelled: "задача отменена",
      };
      const status = ["open", "in_progress"].includes(row.task_status)
        ? "; задача ещё не отмечена выполненной" : "";
      return `${at}: ${action[row.event_type] ?? row.event_type} «${row.title}»${status}`.slice(0, 500);
    });
  }

  /**
   * Телеметрия маршрута берётся только по собственному ходу пользователя:
   * `request_id` приходит из кода, но границу задаёт владелец записи, а
   * не совпадение идентификатора. Записи без владельца — служебные ходы
   * самого сервиса.
   */
  private async routerOutcome(userId: number, requestId: string): Promise<{
    routing_mode: string; requested_route: string; effective_route: string;
    actual_provider_id: string; model: string;
  } | null> {
    const { rows } = await this.db.query<{
      routing_mode: string; requested_route: string; effective_route: string;
      actual_provider_id: string; model: string;
    }>(
      `SELECT routing_mode, requested_route, effective_route, actual_provider_id, model
         FROM llm_requests
        WHERE request_id=$2 AND succeeded
          AND (user_id = $1 OR user_id IS NULL)
        ORDER BY finished_at DESC LIMIT 1`,
      [userId, requestId],
    );
    return rows[0] ?? null;
  }
}
