/**
 * Выборка кандидатов на проактивное сообщение.
 *
 * Вынесена отдельно от исполнения не ради красоты: именно выборку
 * сравнивает режим зеркала. Пока новый механизм не доказал, что выбирает
 * тех же людей, что и старый интервал, отключать старый нельзя — а
 * сравнивать можно только то, что можно вызвать, ничего не совершив.
 *
 * Условия отбора повторяют старые запросы `BackgroundRuntime` намеренно
 * дословно. Любое «заодно улучшим» здесь означает, что зеркало покажет
 * расхождение, и будет непонятно, это новая ошибка или новое поведение.
 * Улучшения — после отключения старого пути.
 */

import type { Database } from "../../db.js";
import type { ProactiveCandidate } from "./service.js";

export interface ReminderCandidate extends ProactiveCandidate {
  taskId: string;
  title: string;
  description: string | null;
  priority: number;
  dueAt: Date | null;
  remindAt: Date | null;
  relatedGoal: string | null;
  previousReminders: number;
  lastTaskAction: string | null;
  scheduledAt: Date;
}

interface CandidateRow {
  user_id: string;
  telegram_id: string;
  chat_id: string;
  timezone: string;
  agent_id: string;
  conversation_id: string;
  last_user_message_at: Date | null;
  last_proactive_at: Date | null;
  unanswered: number | string;
  consent: boolean;
  frequency: string | null;
  awaiting_reply: boolean;
}

interface ReminderRow extends CandidateRow {
  task_id: string;
  title: string;
  description: string | null;
  priority: number;
  due_at: Date | null;
  remind_at: Date | null;
  related_goal: string | null;
  previous_reminders: number;
  last_task_action: string | null;
  scheduled_at: Date;
}

/**
 * Общая часть выборки: кто человек, куда писать, когда он последний раз
 * писал сам и что мы ему уже отправляли.
 *
 * `frequency` выводится из режима агента: `quiet` — это и есть «реже».
 * Отдельной колонки настройки частоты пока нет, и заводить её здесь
 * значило бы менять контракт настроек в шаге про очереди.
 */
const CANDIDATE_COLUMNS = `
  u.id AS user_id,
  u.telegram_id,
  COALESCE(t.chat_id, u.telegram_id) AS chat_id,
  COALESCE(u.timezone, 'UTC') AS timezone,
  a.agent_id,
  a.conversation_id,
  COALESCE(h.last_user_message_at, u.last_seen_at) AS last_user_message_at,
  pm.last_proactive_at,
  COALESCE(pm.unanswered, 0) AS unanswered,
  COALESCE(p.heartbeat_enabled, true) AS consent,
  CASE WHEN COALESCE(p.agent_mode, 'companion') = 'quiet' THEN 'reduced' ELSE 'normal' END
    AS frequency,
  COALESCE(t.received_at, '-infinity'::timestamptz)
    > COALESCE(pm.last_proactive_at, '-infinity'::timestamptz) AS awaiting_reply`;

const CANDIDATE_JOINS = `
  -- tenant: system — общая часть выборки кандидатов по всем пользователям;
  -- решение и сообщение готовятся уже в области владельца
  JOIN agent_links a
    ON a.user_id = u.id AND a.kind = 'eva' AND a.status = 'active'
  LEFT JOIN user_preferences p ON p.user_id = u.id
  LEFT JOIN heartbeat_state h ON h.user_id = u.id
  LEFT JOIN LATERAL (
    SELECT chat_id, received_at FROM telegram_updates
     WHERE user_id = u.id AND chat_id IS NOT NULL
     ORDER BY received_at DESC LIMIT 1
  ) t ON true
  LEFT JOIN LATERAL (
    SELECT max(created_at) AS last_proactive_at,
           count(*) FILTER (WHERE status = 'sent') AS unanswered
      FROM proactive_messages m
     WHERE m.user_id = u.id
       AND m.kind = $1
       AND m.created_at > COALESCE(h.last_user_message_at, u.last_seen_at, '-infinity'::timestamptz)
  ) pm ON true`;

function toCandidate(row: CandidateRow): ProactiveCandidate {
  return {
    userId: Number(row.user_id),
    telegramId: Number(row.telegram_id),
    chatId: Number(row.chat_id),
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    timezone: row.timezone,
    lastUserMessageAt: row.last_user_message_at ?? null,
    lastProactiveAt: row.last_proactive_at ?? null,
    unansweredProactive: Number(row.unanswered) || 0,
    consent: row.consent !== false,
    frequency: row.frequency === "reduced" ? "reduced" : "normal",
    awaitingReply: row.awaiting_reply === true,
  };
}

export class ProactiveSelection {
  constructor(private readonly db: Database) {}

  /**
   * Кандидаты heartbeat.
   *
   * Условия молчания и интервала оставлены в SQL, как в старом цикле:
   * отбирать в базе дешевле, чем вычитывать всех активных людей и
   * фильтровать в процессе. Окончательное решение всё равно принимает
   * `decideProactive` — SQL только сокращает выборку.
   */
  async heartbeat(limit = 25): Promise<ProactiveCandidate[]> {
    const { rows } = await this.db.withSystemScope(
      "proactive.select.heartbeat",
      async () => await this.db.query<CandidateRow>(
        `-- tenant: system — кандидаты выбираются по всем пользователям,
         -- сообщение готовится уже в области владельца
         SELECT ${CANDIDATE_COLUMNS}
           FROM users u
           ${CANDIDATE_JOINS}
          WHERE u.state = 'active'
            AND NOT u.is_blocked
            AND a.conversation_id IS NOT NULL
            AND COALESCE(p.heartbeat_enabled, true)
            AND COALESCE(h.last_user_message_at, u.last_seen_at, u.created_at)
                <= now() - COALESCE(p.heartbeat_min_silence, interval '6 hours')
            AND (h.last_sent_at IS NULL OR
                 h.last_sent_at <= now() - COALESCE(p.heartbeat_min_interval, interval '12 hours'))
          ORDER BY COALESCE(h.last_sent_at, '-infinity'::timestamptz)
          LIMIT $2`,
        ["heartbeat", limit],
      ),
      { crossUser: true },
    );
    return rows.map(toCandidate);
  }

  /**
   * Кандидаты check-in.
   *
   * У check-in нет старого интервала: до этого шага его вообще не было.
   * Поэтому сравнивать зеркалу не с чем, и выборка сразу отбирает по
   * местному часу — час считается в SQL через зону пользователя, чтобы
   * не вычитывать всех активных людей ради проверки времени.
   */
  async checkin(
    kind: "checkin_morning" | "checkin_evening",
    localHour: number,
    limit = 100,
  ): Promise<ProactiveCandidate[]> {
    const { rows } = await this.db.withSystemScope(
      `proactive.select.${kind}`,
      async () => await this.db.query<CandidateRow>(
        `-- tenant: system — кандидаты выбираются по всем пользователям,
         -- сообщение готовится уже в области владельца
         SELECT ${CANDIDATE_COLUMNS}
           FROM users u
           ${CANDIDATE_JOINS}
          WHERE u.state = 'active'
            AND NOT u.is_blocked
            AND a.conversation_id IS NOT NULL
            AND COALESCE(p.heartbeat_enabled, true)
            AND extract(hour FROM (now() AT TIME ZONE COALESCE(u.timezone, 'UTC'))) = $2
          ORDER BY u.id
          LIMIT $3`,
        [kind, localHour, limit],
      ),
      { crossUser: true },
    );
    return rows.map(toCandidate);
  }

  /**
   * Наступившие напоминания.
   *
   * Выборка повторяет `BackgroundRuntime.claimDueTasks`, но НИЧЕГО не
   * блокирует: в режиме зеркала блокировка строки увела бы задачу у
   * старого механизма, и сравнение перестало бы быть наблюдением.
   * Блокировку берёт исполнение — там же, где и раньше.
   */
  async reminders(limit = 25): Promise<ReminderCandidate[]> {
    const { rows } = await this.db.withSystemScope(
      "proactive.select.reminders",
      async () => await this.db.query<ReminderRow>(
        `-- tenant: system — планировщик смотрит наступившие задачи всех
         -- пользователей, выполнение идёт в области владельца
         SELECT ${CANDIDATE_COLUMNS},
                task.id AS task_id, task.title, task.description, task.priority,
                task.due_at, task.remind_at,
                g.title AS related_goal,
                (SELECT count(*)::int FROM task_events e
                  WHERE e.task_id = task.id AND e.event_type = 'reminder_sent')
                  AS previous_reminders,
                (SELECT e.event_type FROM task_events e
                  WHERE e.task_id = task.id ORDER BY e.created_at DESC LIMIT 1)
                  AS last_task_action,
                COALESCE(task.next_run_at, task.remind_at, task.due_at) AS scheduled_at
           FROM tasks task
           JOIN users u ON u.id = task.user_id
           ${CANDIDATE_JOINS}
           LEFT JOIN goals g ON g.id = task.goal_id AND g.user_id = task.user_id
          WHERE task.status IN ('open', 'in_progress')
            AND a.conversation_id IS NOT NULL
            AND COALESCE(task.next_run_at, task.remind_at, task.due_at) <= now()
            AND (task.last_run_at IS NULL
                 OR task.last_run_at < COALESCE(task.next_run_at, task.remind_at, task.due_at))
            AND (task.locked_at IS NULL OR task.locked_at < now() - interval '15 minutes')
          ORDER BY COALESCE(task.next_run_at, task.remind_at, task.due_at)
          LIMIT $2`,
        ["reminder", limit],
      ),
      { crossUser: true },
    );
    return rows.map((row) => ({
      ...toCandidate(row),
      // Часовой пояс задачи сильнее пояса пользователя: напоминание
      // назначено в конкретной зоне и при переезде не переезжает.
      taskId: row.task_id,
      title: row.title,
      description: row.description,
      priority: Number(row.priority) || 3,
      dueAt: row.due_at ?? null,
      remindAt: row.remind_at ?? null,
      relatedGoal: row.related_goal,
      previousReminders: Number(row.previous_reminders) || 0,
      lastTaskAction: row.last_task_action,
      scheduledAt: row.scheduled_at,
    }));
  }
}

/** Ключи для сравнения выборок: идентификатор задачи или пользователя. */
export function selectionKeys(
  candidates: readonly (ProactiveCandidate | ReminderCandidate)[],
): string[] {
  return candidates.map((candidate) =>
    "taskId" in candidate ? `task:${candidate.taskId}` : `user:${candidate.userId}`);
}
