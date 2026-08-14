/**
 * Дневник Mini App.
 *
 * Главное свойство, ради которого этот модуль существует отдельно от
 * заметок: **запись сохраняется без участия ИИ**. Ни создание, ни правка,
 * ни удаление не обращаются ни к модели, ни к Letta — человек пишет в
 * свой дневник, и запись ложится в PostgreSQL как есть. Обращение к Еве
 * возможно только отдельным явным действием (`share`), и оно меняет
 * состояние записи так, чтобы это было видно в обоих каналах.
 *
 * Второе свойство — минимизация чужих данных (пункт 10 шага, инвариант
 * 30). Карточка человека хранит имя, которым его называет сам автор, и
 * необязательную роль. Ни признаков, ни оценок, ни выводов о третьем лице
 * здесь не появляется, и создать скрытый профиль этими методами нельзя.
 */

import type pg from "pg";

import type { Database } from "../../db.js";
import { badRequest, notFound } from "../../errors.js";

export type JournalMood = "very_low" | "low" | "neutral" | "good" | "great";

export const JOURNAL_MOODS: readonly JournalMood[] = [
  "very_low",
  "low",
  "neutral",
  "good",
  "great",
];

export type JournalLinkType = "goal" | "task" | "checkin";

export interface JournalLink {
  target_type: JournalLinkType;
  target_id: string;
}

export interface JournalPerson {
  id: string;
  display_name: string;
  relation: string | null;
  mentions: number;
}

export interface JournalEntry {
  id: string;
  local_date: string;
  title: string | null;
  content: string;
  mood: JournalMood | null;
  energy: number | null;
  share_state: "saved" | "shared_with_eva";
  shared_at: string | null;
  source_channel: "miniapp" | "telegram";
  created_at: string;
  updated_at: string;
  people: JournalPerson[];
  links: JournalLink[];
  voice: JournalVoiceNote | null;
}

export interface JournalVoiceNote {
  id: string;
  media_key: string;
  duration_ms: number | null;
  status: "stored" | "transcribed" | "expired" | "failed";
  transcript: string | null;
  expires_at: string;
}

export interface JournalEntryInput {
  content?: unknown;
  title?: unknown;
  mood?: unknown;
  energy?: unknown;
  local_date?: unknown;
  people?: unknown;
  links?: unknown;
  source_channel?: unknown;
}

/** Что именно исчезло вместе с записью — ответ показывается человеку. */
export interface JournalDeletion {
  entries: number;
  links: number;
  people_links: number;
  people_removed: number;
  voice_notes: number;
  channel_links: number;
}

const MAX_PEOPLE_PER_ENTRY = 20;
const MAX_LINKS_PER_ENTRY = 20;

export class JournalService {
  private readonly now: () => Date;
  private readonly voiceRetentionDays: number;

  constructor(
    private readonly db: Database,
    options: { now?: () => Date; voiceRetentionDays?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.voiceRetentionDays = options.voiceRetentionDays ?? 30;
  }

  async list(
    userId: number,
    options: { limit?: number; days?: number } = {},
  ): Promise<JournalEntry[]> {
    const limit = clampInteger(options.limit ?? 50, 1, 200);
    const days = clampInteger(options.days ?? 90, 1, 365);
    const { rows } = await this.db.query<JournalRow>(
      `SELECT id::text, local_date::text, title, content, mood, energy,
              share_state, shared_at, source_channel, created_at, updated_at
         FROM journal_entries
        WHERE user_id = $1
          AND local_date >= (current_date - ($2::integer - 1))
        ORDER BY local_date DESC, id DESC
        LIMIT $3`,
      [userId, days, limit],
    );
    return await this.decorate(userId, rows);
  }

  async get(userId: number, entryId: number): Promise<JournalEntry> {
    const { rows } = await this.db.query<JournalRow>(
      `SELECT id::text, local_date::text, title, content, mood, energy,
              share_state, shared_at, source_channel, created_at, updated_at
         FROM journal_entries
        WHERE user_id = $1 AND id = $2`,
      [userId, entryId],
    );
    if (!rows[0]) throw notFound("Запись дневника не найдена");
    return (await this.decorate(userId, rows))[0]!;
  }

  /**
   * Создание записи. Модель здесь не участвует: единственный внешний
   * вызов — SQL. Именно это проверяет тест «сохранение записи без ИИ».
   */
  async create(
    userId: number,
    timezone: string,
    input: JournalEntryInput,
  ): Promise<JournalEntry> {
    const content = requiredText(input.content, "Запись", 20_000);
    const title = optionalText(input.title, 300);
    const mood = optionalEnum(input.mood, JOURNAL_MOODS, "Настроение");
    const energy = optionalInteger(input.energy, 1, 10);
    const localDate = optionalDate(input.local_date);
    const people = personNames(input.people);
    const links = entryLinks(input.links);
    const channel = optionalEnum(
      input.source_channel,
      ["miniapp", "telegram"] as const,
      "Канал",
    ) ?? "miniapp";

    const id = await this.db.transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (user_id, local_date, title, content, mood, energy, source_channel)
         VALUES ($1, COALESCE($2::date, (now() AT TIME ZONE $3)::date),
                 $4, $5, $6, $7, $8)
         RETURNING id::text`,
        [userId, localDate, timezone, title, content, mood, energy, channel],
      );
      const entryId = Number(rows[0]!.id);
      await this.replaceRelations(client, userId, entryId, people, links);
      return entryId;
    });
    return await this.get(userId, id);
  }

  async update(
    userId: number,
    entryId: number,
    input: JournalEntryInput,
  ): Promise<JournalEntry> {
    const patch: string[] = [];
    const values: unknown[] = [];
    if (Object.hasOwn(input, "content")) {
      values.push(requiredText(input.content, "Запись", 20_000));
      patch.push(`content = $${values.length + 2}`);
    }
    if (Object.hasOwn(input, "title")) {
      values.push(optionalText(input.title, 300));
      patch.push(`title = $${values.length + 2}`);
    }
    if (Object.hasOwn(input, "mood")) {
      values.push(optionalEnum(input.mood, JOURNAL_MOODS, "Настроение"));
      patch.push(`mood = $${values.length + 2}`);
    }
    if (Object.hasOwn(input, "energy")) {
      values.push(optionalInteger(input.energy, 1, 10));
      patch.push(`energy = $${values.length + 2}`);
    }
    const touchesRelations = Object.hasOwn(input, "people") || Object.hasOwn(input, "links");
    if (patch.length === 0 && !touchesRelations) {
      throw badRequest("Нет изменений записи");
    }

    await this.db.transaction(async (client) => {
      if (patch.length > 0) {
        const result = await client.query(
          `UPDATE journal_entries SET ${patch.join(", ")}, updated_at = now()
            WHERE id = $1 AND user_id = $2`,
          [entryId, userId, ...values],
        );
        if (!result.rowCount) throw notFound("Запись дневника не найдена");
      } else {
        const owned = await client.query(
          "SELECT 1 FROM journal_entries WHERE id = $1 AND user_id = $2",
          [entryId, userId],
        );
        if (!owned.rowCount) throw notFound("Запись дневника не найдена");
      }
      if (touchesRelations) {
        await this.replaceRelations(
          client,
          userId,
          entryId,
          Object.hasOwn(input, "people") ? personNames(input.people) : null,
          Object.hasOwn(input, "links") ? entryLinks(input.links) : null,
        );
      }
    });
    return await this.get(userId, entryId);
  }

  /**
   * Удаление записи вместе со всем производным.
   *
   * Просто `DELETE` по journal_entries сработал бы и сам — каскады это
   * умеют. Пересчёт всё равно нужен: карточка человека, у которого не
   * осталось ни одного упоминания, обязана исчезнуть. Иначе в разделе
   * «Люди» остаётся имя без единой записи — то самое «производное
   * данное», которое пункт 9 требует убирать вместе с оригиналом.
   */
  async remove(userId: number, entryId: number): Promise<JournalDeletion> {
    return await this.db.transaction(async (client) => {
      const owned = await client.query(
        "SELECT 1 FROM journal_entries WHERE id = $1 AND user_id = $2",
        [entryId, userId],
      );
      if (!owned.rowCount) throw notFound("Запись дневника не найдена");

      const links = await client.query(
        "DELETE FROM journal_entry_links WHERE entry_id = $1 AND user_id = $2",
        [entryId, userId],
      );
      const peopleLinks = await client.query<{ person_id: string }>(
        `DELETE FROM journal_entry_people
          WHERE entry_id = $1 AND user_id = $2
          RETURNING person_id::text`,
        [entryId, userId],
      );
      const voice = await client.query(
        "DELETE FROM journal_voice_notes WHERE entry_id = $1 AND user_id = $2",
        [entryId, userId],
      );
      const channels = await client.query(
        "DELETE FROM channel_message_links WHERE entry_id = $1 AND user_id = $2",
        [entryId, userId],
      );
      await client.query(
        "DELETE FROM journal_entries WHERE id = $1 AND user_id = $2",
        [entryId, userId],
      );
      const orphans = await this.pruneOrphanPeople(
        client,
        userId,
        peopleLinks.rows.map((row) => Number(row.person_id)),
      );
      return {
        entries: 1,
        links: links.rowCount ?? 0,
        people_links: peopleLinks.rowCount ?? 0,
        people_removed: orphans,
        voice_notes: voice.rowCount ?? 0,
        channel_links: channels.rowCount ?? 0,
      };
    });
  }

  async listPeople(userId: number): Promise<JournalPerson[]> {
    const { rows } = await this.db.query<{
      id: string;
      display_name: string;
      relation: string | null;
      mentions: string;
    }>(
      `SELECT p.id::text, p.display_name, p.relation,
              count(ep.id) AS mentions
         FROM journal_people p
         LEFT JOIN journal_entry_people ep
           ON ep.person_id = p.id AND ep.user_id = p.user_id
        WHERE p.user_id = $1
        GROUP BY p.id
        ORDER BY count(ep.id) DESC, p.display_name
        LIMIT 200`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      display_name: row.display_name,
      relation: row.relation,
      mentions: Number(row.mentions),
    }));
  }

  async updatePerson(
    userId: number,
    personId: number,
    input: { display_name?: unknown; relation?: unknown },
  ): Promise<JournalPerson> {
    const displayName = Object.hasOwn(input, "display_name")
      ? requiredText(input.display_name, "Имя", 200)
      : null;
    const relation = Object.hasOwn(input, "relation")
      ? optionalText(input.relation, 200)
      : undefined;
    const { rows } = await this.db.query<{
      id: string;
      display_name: string;
      relation: string | null;
    }>(
      `UPDATE journal_people SET
         display_name = COALESCE($3, display_name),
         normalized = COALESCE(${normalizeSql("$3")}, normalized),
         relation = CASE WHEN $4::boolean THEN $5 ELSE relation END,
         updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING id::text, display_name, relation`,
      [personId, userId, displayName, relation !== undefined, relation ?? null],
    );
    if (!rows[0]) throw notFound("Карточка человека не найдена");
    return { ...rows[0], mentions: 0 };
  }

  /**
   * Удаление карточки человека убирает и все упоминания в записях: сама
   * запись остаётся, но связи с человеком в ней не будет. Текст записи
   * при этом не переписывается — это слова автора, а не производные
   * данные.
   */
  async removePerson(userId: number, personId: number): Promise<{ mentions: number }> {
    return await this.db.transaction(async (client) => {
      const mentions = await client.query(
        "DELETE FROM journal_entry_people WHERE person_id = $1 AND user_id = $2",
        [personId, userId],
      );
      const removed = await client.query(
        "DELETE FROM journal_people WHERE id = $1 AND user_id = $2",
        [personId, userId],
      );
      if (!removed.rowCount) throw notFound("Карточка человека не найдена");
      return { mentions: mentions.rowCount ?? 0 };
    });
  }

  /**
   * Отдать запись Еве. Это отдельное действие, а не следствие
   * сохранения: пока человек его не выполнил, запись остаётся личной.
   */
  async markShared(userId: number, entryId: number): Promise<JournalEntry> {
    const result = await this.db.query(
      `UPDATE journal_entries
          SET share_state = 'shared_with_eva', shared_at = now(), updated_at = now()
        WHERE id = $1 AND user_id = $2`,
      [entryId, userId],
    );
    if (!result.rowCount) throw notFound("Запись дневника не найдена");
    return await this.get(userId, entryId);
  }

  /**
   * Голосовая заметка: файл лежит в media-service, здесь только срок и
   * состояние. Срок ставится при записи, а не при первом обращении —
   * иначе забытая заметка жила бы вечно.
   */
  async attachVoice(
    userId: number,
    input: { media_key?: unknown; duration_ms?: unknown; entry_id?: unknown },
  ): Promise<JournalVoiceNote> {
    const mediaKey = requiredText(input.media_key, "Ключ записи", 300);
    const durationMs = optionalInteger(input.duration_ms, 0, 3_600_000);
    const entryId = input.entry_id == null ? null : positiveId(input.entry_id, "записи");
    if (entryId !== null) {
      const owned = await this.db.query(
        "SELECT 1 FROM journal_entries WHERE id = $1 AND user_id = $2",
        [entryId, userId],
      );
      if (!owned.rowCount) throw notFound("Запись дневника не найдена");
    }
    const { rows } = await this.db.query<JournalVoiceNote>(
      `INSERT INTO journal_voice_notes
         (user_id, entry_id, media_key, duration_ms, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5::integer * interval '1 day'))
       ON CONFLICT (user_id, media_key) DO UPDATE SET
         entry_id = EXCLUDED.entry_id,
         duration_ms = EXCLUDED.duration_ms,
         updated_at = now()
       RETURNING id::text, media_key, duration_ms, status, transcript, expires_at`,
      [userId, entryId, mediaKey, durationMs ?? null, this.voiceRetentionDays],
    );
    return rows[0]!;
  }

  /**
   * Расшифровка приходит от STT и сохраняется рядом с файлом. Она
   * переживает истечение аудио: удаление файла не должно стирать то, что
   * человек надиктовал в дневник.
   */
  async setTranscript(
    userId: number,
    voiceId: number,
    transcript: string,
  ): Promise<JournalVoiceNote> {
    const { rows } = await this.db.query<JournalVoiceNote>(
      `UPDATE journal_voice_notes
          SET transcript = $3,
              status = CASE WHEN status = 'expired' THEN 'expired' ELSE 'transcribed' END,
              updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING id::text, media_key, duration_ms, status, transcript, expires_at`,
      [voiceId, userId, requiredText(transcript, "Расшифровка", 20_000)],
    );
    if (!rows[0]) throw notFound("Голосовая заметка не найдена");
    return rows[0];
  }

  /**
   * Сверка срока хранения. Строка не удаляется: `expired` — это факт,
   * который объясняет человеку, почему аудио больше не проигрывается,
   * а исчезнувшая строка выглядела бы как потеря записи.
   */
  async expireVoiceNotes(userId: number): Promise<{ expired: number; media_keys: string[] }> {
    const { rows } = await this.db.query<{ media_key: string }>(
      `UPDATE journal_voice_notes
          SET status = 'expired', updated_at = now()
        WHERE user_id = $1
          AND expires_at <= $2::timestamptz
          AND status IN ('stored', 'transcribed')
        RETURNING media_key`,
      [userId, this.now().toISOString()],
    );
    return { expired: rows.length, media_keys: rows.map((row) => row.media_key) };
  }

  // ------------------------------------------------------------------

  private async decorate(userId: number, rows: JournalRow[]): Promise<JournalEntry[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => Number(row.id));
    const [people, links, voice] = await Promise.all([
      this.db.query<{
        entry_id: string;
        id: string;
        display_name: string;
        relation: string | null;
      }>(
        `SELECT ep.entry_id::text, p.id::text, p.display_name, p.relation
           FROM journal_entry_people ep
           JOIN journal_people p ON p.id = ep.person_id AND p.user_id = ep.user_id
          WHERE ep.user_id = $1 AND ep.entry_id = ANY($2::bigint[])
          ORDER BY p.display_name`,
        [userId, ids],
      ),
      this.db.query<{ entry_id: string; target_type: JournalLinkType; target_id: string }>(
        `SELECT entry_id::text, target_type, target_id::text
           FROM journal_entry_links
          WHERE user_id = $1 AND entry_id = ANY($2::bigint[])
          ORDER BY target_type, target_id`,
        [userId, ids],
      ),
      this.db.query<JournalVoiceNote & { entry_id: string }>(
        `SELECT entry_id::text, id::text, media_key, duration_ms, status,
                transcript, expires_at
           FROM journal_voice_notes
          WHERE user_id = $1 AND entry_id = ANY($2::bigint[])
          ORDER BY id DESC`,
        [userId, ids],
      ),
    ]);
    const byEntry = <T extends { entry_id: string }>(list: T[]): Map<string, T[]> => {
      const map = new Map<string, T[]>();
      for (const item of list) {
        const bucket = map.get(item.entry_id) ?? [];
        bucket.push(item);
        map.set(item.entry_id, bucket);
      }
      return map;
    };
    const peopleByEntry = byEntry(people.rows);
    const linksByEntry = byEntry(links.rows);
    const voiceByEntry = byEntry(voice.rows);
    return rows.map((row) => ({
      ...row,
      people: (peopleByEntry.get(row.id) ?? []).map((person) => ({
        id: person.id,
        display_name: person.display_name,
        relation: person.relation,
        mentions: 0,
      })),
      links: (linksByEntry.get(row.id) ?? []).map((link) => ({
        target_type: link.target_type,
        target_id: link.target_id,
      })),
      voice: voiceByEntry.get(row.id)?.[0]
        ? {
          id: voiceByEntry.get(row.id)![0]!.id,
          media_key: voiceByEntry.get(row.id)![0]!.media_key,
          duration_ms: voiceByEntry.get(row.id)![0]!.duration_ms,
          status: voiceByEntry.get(row.id)![0]!.status,
          transcript: voiceByEntry.get(row.id)![0]!.transcript,
          expires_at: voiceByEntry.get(row.id)![0]!.expires_at,
        }
        : null,
    }));
  }

  private async replaceRelations(
    client: pg.PoolClient,
    userId: number,
    entryId: number,
    people: string[] | null,
    links: JournalLink[] | null,
  ): Promise<void> {
    if (people !== null) {
      const previous = await client.query<{ person_id: string }>(
        `DELETE FROM journal_entry_people
          WHERE entry_id = $1 AND user_id = $2
          RETURNING person_id::text`,
        [entryId, userId],
      );
      for (const name of people) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO journal_people (user_id, display_name, normalized)
           VALUES ($1, $2, ${normalizeSql("$2")})
           ON CONFLICT (user_id, normalized)
             DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
           RETURNING id::text`,
          [userId, name],
        );
        await client.query(
          `INSERT INTO journal_entry_people (user_id, entry_id, person_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (entry_id, person_id) DO NOTHING`,
          [userId, entryId, Number(rows[0]!.id)],
        );
      }
      await this.pruneOrphanPeople(
        client,
        userId,
        previous.rows.map((row) => Number(row.person_id)),
      );
    }
    if (links !== null) {
      await client.query(
        "DELETE FROM journal_entry_links WHERE entry_id = $1 AND user_id = $2",
        [entryId, userId],
      );
      for (const link of links) {
        await client.query(
          `INSERT INTO journal_entry_links (user_id, entry_id, target_type, target_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (entry_id, target_type, target_id) DO NOTHING`,
          [userId, entryId, link.target_type, Number(link.target_id)],
        );
      }
    }
  }

  /** Человек без единого упоминания в дневнике перестаёт существовать. */
  private async pruneOrphanPeople(
    client: pg.PoolClient,
    userId: number,
    candidates: number[],
  ): Promise<number> {
    if (candidates.length === 0) return 0;
    const result = await client.query(
      `DELETE FROM journal_people p
        WHERE p.user_id = $1
          AND p.id = ANY($2::bigint[])
          AND NOT EXISTS (
            SELECT 1 FROM journal_entry_people ep
             WHERE ep.person_id = p.id AND ep.user_id = p.user_id
          )`,
      [userId, [...new Set(candidates)]],
    );
    return result.rowCount ?? 0;
  }
}

interface JournalRow {
  id: string;
  local_date: string;
  title: string | null;
  content: string;
  mood: JournalMood | null;
  energy: number | null;
  share_state: "saved" | "shared_with_eva";
  shared_at: string | null;
  source_channel: "miniapp" | "telegram";
  created_at: string;
  updated_at: string;
}

/**
 * Нормализация имени выполняется в SQL, а не в JavaScript: значение
 * попадает и в `INSERT`, и в `ON CONFLICT`, и расхождение между двумя
 * реализациями свёртки регистра дало бы дубли карточек, которые снаружи
 * выглядят одинаково.
 */
function normalizeSql(param: string): string {
  return `btrim(lower(regexp_replace(${param}, '\\s+', ' ', 'g')))`;
}

function personNames(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw badRequest("Ожидается список людей");
  const names: string[] = [];
  for (const item of value.slice(0, MAX_PEOPLE_PER_ENTRY)) {
    const name = typeof item === "string"
      ? item
      : item && typeof item === "object"
        ? (item as { display_name?: unknown }).display_name
        : null;
    const text = typeof name === "string" ? name.trim().slice(0, 200) : "";
    if (text) names.push(text);
  }
  return names;
}

function entryLinks(value: unknown): JournalLink[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw badRequest("Ожидается список связей");
  const links: JournalLink[] = [];
  for (const item of value.slice(0, MAX_LINKS_PER_ENTRY)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as { target_type?: unknown; target_id?: unknown };
    const type = optionalEnum(
      raw.target_type,
      ["goal", "task", "checkin"] as const,
      "Тип связи",
    );
    if (!type) continue;
    links.push({ target_type: type, target_id: String(positiveId(raw.target_id, "связи")) });
  }
  return links;
}

export function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest(`${name}: требуется текст`);
  }
  return value.trim().slice(0, max);
}

export function optionalText(value: unknown, max: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw badRequest("Ожидается текст");
  return value.trim().slice(0, max) || null;
}

export function optionalInteger(value: unknown, min: number, max: number): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw badRequest(`Ожидается целое число от ${min} до ${max}`);
  }
  return parsed;
}

export function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw badRequest(`${name}: недопустимое значение`);
  }
  return value as T;
}

export function optionalDate(value: unknown): string | null {
  const text = optionalText(value, 10);
  if (text === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw badRequest("Ожидается дата YYYY-MM-DD");
  }
  return text;
}

export function positiveId(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw badRequest(`Некорректный ID ${name}`);
  }
  return parsed;
}

function clampInteger(value: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
