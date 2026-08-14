/**
 * Один внутренний пользователь на все каналы.
 *
 * Telegram и Mini App — разные транспорты одной учётной записи. Ключ
 * объединения ровно один: проверенный `telegram_id` из подписи, который
 * приводится к `users.id`. Имя, username, город, email и телефон ключом
 * не являются (инвариант 6), и в этом модуле нет ни одного запроса,
 * который искал бы пользователя по ним, — двое Александров Ивановых
 * останутся двумя учётными записями.
 *
 * Второе назначение — связь «сообщение канала → ход → conversation»
 * (пункт 2 шага). Благодаря ей действие, сделанное в одном канале, видно
 * в другом: лента собирается по `user_id`, а не по каналу.
 */

import type { Database } from "../db.js";
import { badRequest, unauthorized } from "../errors.js";

export type Channel = "telegram" | "miniapp";

export interface ChannelLink {
  id: string;
  channel: Channel;
  channel_message_id: string;
  turn_id: string | null;
  conversation_id: string | null;
  entry_id: string | null;
  created_at: string;
}

export interface ChannelActivityItem {
  channel: Channel;
  kind: "journal_entry" | "message";
  reference: string;
  title: string;
  at: string;
}

export class ChannelLinkService {
  constructor(private readonly db: Database) {}

  /**
   * Внутренний идентификатор по проверенному Telegram-идентификатору.
   *
   * Отдельный метод нужен, чтобы у связывания каналов был ровно один
   * вход: любое другое сопоставление (по имени, по username) пришлось бы
   * писать заново и это было бы заметно в ревью.
   */
  async internalUserId(telegramId: number): Promise<number> {
    const { rows } = await this.db.query<{ id: string }>(
      "SELECT id::text FROM users WHERE telegram_id = $1",
      [telegramId],
    );
    if (!rows[0]) throw unauthorized("Пользователь Telegram не найден");
    return Number(rows[0].id);
  }

  /**
   * Привязка сообщения канала к ходу и conversation.
   *
   * Повторный вызов с тем же сообщением ничего не дублирует: пара
   * (канал, идентификатор сообщения) уникальна. Это и делает связь
   * пригодной для повторной доставки — та же строка, тот же ход.
   */
  async link(
    userId: number,
    input: {
      channel: Channel;
      channelMessageId: string;
      turnId?: string | null;
      conversationId?: string | null;
      entryId?: number | null;
    },
  ): Promise<ChannelLink> {
    const channel = input.channel;
    if (channel !== "telegram" && channel !== "miniapp") {
      throw badRequest("Неизвестный канал");
    }
    const messageId = String(input.channelMessageId ?? "").trim();
    if (!messageId) throw badRequest("Идентификатор сообщения канала обязателен");
    const { rows } = await this.db.query<ChannelLink>(
      `INSERT INTO channel_message_links
         (user_id, channel, channel_message_id, turn_id, conversation_id, entry_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (channel, channel_message_id) DO UPDATE SET
         turn_id = COALESCE(EXCLUDED.turn_id, channel_message_links.turn_id),
         conversation_id = COALESCE(EXCLUDED.conversation_id, channel_message_links.conversation_id),
         entry_id = COALESCE(EXCLUDED.entry_id, channel_message_links.entry_id)
       RETURNING id::text, channel, channel_message_id, turn_id, conversation_id,
                 entry_id::text, created_at::text`,
      [
        userId,
        channel,
        messageId,
        input.turnId ?? null,
        input.conversationId ?? null,
        input.entryId ?? null,
      ],
    );
    return rows[0]!;
  }

  /** Все каналы, через которые прошёл один ход. */
  async byTurn(userId: number, turnId: string): Promise<ChannelLink[]> {
    const { rows } = await this.db.query<ChannelLink>(
      `SELECT id::text, channel, channel_message_id, turn_id, conversation_id,
              entry_id::text, created_at::text
         FROM channel_message_links
        WHERE user_id = $1 AND turn_id = $2
        ORDER BY created_at, id`,
      [userId, turnId],
    );
    return rows;
  }

  /**
   * Общая лента: то, что человек сделал, независимо от канала.
   *
   * Именно этот запрос доказывает пункт 3 шага «действие, выполненное в
   * одном канале, видно в другом» — выборка идёт по владельцу, канал
   * остаётся признаком строки, а не условием отбора.
   */
  async activity(userId: number, limit = 20): Promise<ChannelActivityItem[]> {
    const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
    // Порядок берётся по timestamptz, а не по его текстовой записи:
    // текст несёт смещение зоны ('+03' против '+02' при переходе на
    // зимнее время), и лексикографическая сортировка перепутала бы
    // события по разные стороны перевода часов.
    const { rows } = await this.db.query<ChannelActivityItem & { ordered_at: Date }>(
      `SELECT channel, kind, reference, title, at, ordered_at
         FROM (
           (SELECT source_channel AS channel, 'journal_entry' AS kind,
                   'journal_entries:' || id::text AS reference,
                   coalesce(title, 'Запись дневника') AS title,
                   created_at::text AS at,
                   created_at AS ordered_at
              FROM journal_entries
             WHERE user_id = $1)
           UNION ALL
           (SELECT channel, 'message' AS kind,
                   'channel_message_links:' || id::text AS reference,
                   'Сообщение канала' AS title,
                   created_at::text AS at,
                   created_at AS ordered_at
              FROM channel_message_links
             WHERE user_id = $1)
         ) feed
        ORDER BY ordered_at DESC
        LIMIT $2`,
      [userId, bounded],
    );
    return rows.map(({ channel, kind, reference, title, at }) => ({
      channel, kind, reference, title, at,
    }));
  }
}
