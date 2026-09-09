/**
 * Что Ева отправила сама — и когда.
 *
 * Сообщение по наступившему сроку и сообщение по своей инициативе
 * сочиняются в служебных conversation (`scheduler`, `task_action`,
 * `initiative`) и уходят человеку напрямую. Основной диалог о них не
 * знает: для Евы этого сообщения не было, и на «ты же мне писала утром»
 * ей нечего ответить.
 *
 * Своей памяти здесь не заводится (инварианты 12, 13). Собственное
 * сообщение — продуктовый факт хода, и место ему в
 * `RuntimeContextBuilder`, единственном сборщике продуктового контекста
 * (инвариант 15). Как только человек ответит, этот текст окажется внутри
 * его сообщения в основном диалоге — и дальше историей и recall
 * распоряжается Letta, как и положено.
 *
 * Два источника, потому что механизмов доставки два и сводить их в один
 * значило бы завести третью таблицу поверх двух работающих:
 * `task_events` — задачи, `proactive_messages` — инициатива.
 */

import type { Database } from "../db.js";
import { formatLocalShort } from "../time/local-date-time.js";

/** Сколько собственных сообщений попадает в ход. */
export const OWN_MESSAGE_LINES = 3;

/** Сколько знаков текста остаётся в строке контекста. */
const TEXT_BUDGET = 200;

/**
 * Жёсткое окно выборки.
 *
 * Граница «с прошлого сообщения человека» может отсутствовать вовсе —
 * у того, кто не писал никогда. Без окна такой запрос собрал бы всю
 * историю, а смысла в сообщении месячной давности для текущего хода нет.
 */
const WINDOW_DAYS = 7;

interface OwnMessageRow {
  sent_at: Date;
  message_text: string;
  source: string;
}

export interface OwnMessage {
  sentAt: Date;
  text: string;
  /** `task` — по наступившему сроку, `proactive` — по своей инициативе. */
  source: string;
}

export class OwnMessagesService {
  constructor(private readonly db: Database) {}

  /**
   * Когда человек писал в последний раз.
   *
   * Спрашивается только там, где вызывающий этого не знает, — в фоновом
   * ходе. У живого хода значение уже на руках: `recordUserMessage`
   * возвращает предыдущее время, и брать его из базы заново значило бы
   * получить время только что записанного сообщения, то есть пустую
   * выборку всегда.
   */
  async lastUserMessageAt(userId: number): Promise<Date | null> {
    const { rows } = await this.db.query<{ at: Date | null }>(
      `SELECT COALESCE(h.last_user_message_at, u.last_seen_at) AS at
         FROM users u
         LEFT JOIN heartbeat_state h ON h.user_id = u.id
        WHERE u.id = $1`,
      [userId],
    );
    return rows[0]?.at ?? null;
  }

  /** Собственные сообщения Евы после `since`, новые первыми. */
  async since(
    userId: number,
    since: Date | null,
    limit = OWN_MESSAGE_LINES,
  ): Promise<OwnMessage[]> {
    const bounded = Math.min(Math.max(limit, 1), 20);
    const { rows } = await this.db.query<OwnMessageRow>(
      `SELECT sent_at, message_text, source
         FROM (
           -- Задача: отправленное напоминание и результат выполненного
           -- действия. Оба уже хранят текст — новой колонки не нужно.
           SELECT e.sent_at, e.generated_text AS message_text, 'task' AS source
             FROM task_events e
            WHERE e.user_id = $1
              AND e.event_type IN ('reminder_sent', 'action_done')
              AND e.sent_at IS NOT NULL
              AND e.generated_text IS NOT NULL
           UNION ALL
           -- Инициатива: heartbeat, check-in и сообщение в выбранное
           -- человеком окно.
           SELECT m.sent_at, m.message_text, 'proactive' AS source
             FROM proactive_messages m
            WHERE m.user_id = $1
              AND m.status = 'sent'
              AND m.sent_at IS NOT NULL
              AND m.message_text IS NOT NULL
         ) sent
        WHERE sent_at > COALESCE($2::timestamptz, '-infinity'::timestamptz)
          AND sent_at > now() - make_interval(days => $3)
        ORDER BY sent_at DESC
        LIMIT $4`,
      [userId, since?.toISOString() ?? null, WINDOW_DAYS, bounded],
    );
    return rows.map((row) => ({
      sentAt: new Date(row.sent_at),
      text: row.message_text,
      source: row.source,
    }));
  }

  /**
   * Строки для контекста хода.
   *
   * Время местное, как и всё остальное в блоке: рядом стоит `local_time`
   * человека, и две шкалы в одном блоке модель сводит неверно.
   */
  async lines(
    userId: number,
    timezone: string,
    since: Date | null,
    limit = OWN_MESSAGE_LINES,
  ): Promise<string[]> {
    const messages = await this.since(userId, since, limit);
    return messages
      .slice()
      .reverse()
      .map((message) => {
        const text = message.text.replace(/\s+/gu, " ").trim();
        const shortened = text.length > TEXT_BUDGET
          ? `${text.slice(0, TEXT_BUDGET)}…`
          : text;
        return `${formatLocalShort(message.sentAt, timezone)}: «${shortened}»`;
      });
  }
}
