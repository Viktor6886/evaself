/**
 * Запись записей архива: люди и дневник, заметки, самочувствие, бюджет,
 * решения. Те же правила, что в `import-apply.ts`: только вставка, повтор
 * пропускается, существующие строки не меняются.
 *
 * Повтор длинного текста узнаётся по хэшу содержания, посчитанному на
 * стороне базы: тянуть в память весь дневник человека ради сравнения
 * незачем. Нормализация одна и та же в SQL и здесь — переводы строк
 * приводятся к `\n`, пробелы по краям срезаются, — иначе архив, который
 * Excel пересохранил с `\r\n`, загружался бы второй раз как новый.
 */

import { createHash } from "node:crypto";

import { normalizeSql } from "../public/journal/input.js";
import { fold } from "./format.js";
import type { ParsedArchive, RowError } from "./import-types.js";
import type { SheetId } from "./sheets.js";

export interface ApplyClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface Counter {
  added: number;
  existing: number;
}

const EDGE_WHITESPACE = "' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13)";

/** Хэш содержания в SQL — пара к `contentHash`. */
export function hashSql(column: string): string {
  return `md5(btrim(replace(replace(${column}, chr(13) || chr(10), chr(10)), chr(13), chr(10)), ${EDGE_WHITESPACE}))`;
}

export function contentHash(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");
  return createHash("md5").update(normalized, "utf8").digest("hex");
}

export async function applyEntries(
  client: ApplyClient,
  input: {
    userId: number;
    parsed: ParsedArchive;
    count: (id: SheetId) => Counter;
    errors: RowError[];
    createdAt: (wall: string | null) => string | null;
  },
): Promise<void> {
  const { userId, parsed, count, createdAt } = input;

  // ---- люди: одно имя — одна карточка ---------------------------------
  if (parsed.people.length > 0) {
    const counter = count("people");
    for (const { value } of parsed.people) {
      // Пустое «кем приходится» у существующей карточки — пустое место,
      // его можно заполнить; заполненное не меняется.
      const { rows } = await client.query<{ inserted: boolean }>(
        `INSERT INTO journal_people (user_id, display_name, normalized, relation)
         VALUES ($1, $2, ${normalizeSql("$2")}, $3)
         ON CONFLICT (user_id, normalized) DO UPDATE SET relation = EXCLUDED.relation, updated_at = now()
           WHERE journal_people.relation IS NULL AND EXCLUDED.relation IS NOT NULL
         RETURNING (xmax = 0) AS inserted`,
        [userId, value.display_name, value.relation],
      );
      if (rows[0]?.inserted) counter.added += 1;
      else counter.existing += 1;
    }
  }

  // ---- дневник: повтор — тот же день и тот же текст --------------------
  if (parsed.journal.length > 0) {
    const counter = count("journal");
    const { rows } = await client.query<{ local_date: string; hash: string }>(
      `SELECT local_date::text AS local_date, ${hashSql("content")} AS hash
         FROM journal_entries WHERE user_id = $1`,
      [userId],
    );
    const known = new Set(rows.map((row) => `${row.local_date}|${row.hash}`));
    for (const { value } of parsed.journal) {
      const key = `${value.local_date}|${contentHash(value.content)}`;
      if (known.has(key)) {
        counter.existing += 1;
        continue;
      }
      // Запись возвращается сохранённой, а не «обсуждённой с Евой»: того
      // разговора в этой переписке не было.
      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO journal_entries (user_id, local_date, title, content, mood, energy, share_state, source_channel, created_at)
         VALUES ($1, $2::date, $3, $4, $5, $6, 'saved', 'miniapp', COALESCE($7::timestamptz, now()))
         RETURNING id`,
        [userId, value.local_date, value.title, value.content, value.mood, value.energy, createdAt(value.created_at)],
      );
      const entryId = Number(inserted[0]!.id);
      for (const name of value.people) {
        const personId = await person(client, userId, name);
        await client.query(
          `INSERT INTO journal_entry_people (user_id, entry_id, person_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (entry_id, person_id) DO NOTHING`,
          [userId, entryId, personId],
        );
      }
      known.add(key);
      counter.added += 1;
    }
  }

  // ---- заметки: повтор — тот же заголовок и текст -----------------------
  if (parsed.notes.length > 0) {
    const counter = count("notes");
    const { rows } = await client.query<{ title: string; hash: string }>(
      `SELECT title, ${hashSql("content")} AS hash FROM eva_notes WHERE user_id = $1`,
      [userId],
    );
    const known = new Set(rows.map((row) => `${fold(row.title)}|${row.hash}`));
    for (const { value } of parsed.notes) {
      const key = `${fold(value.title)}|${contentHash(value.content)}`;
      if (known.has(key)) {
        counter.existing += 1;
        continue;
      }
      await client.query(
        `INSERT INTO eva_notes (user_id, title, content, category, tags, pinned, entry_type, created_at)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7, COALESCE($8::timestamptz, now()))`,
        [userId, value.title, value.content, value.category, value.tags, value.pinned, value.entry_type, createdAt(value.created_at)],
      );
      known.add(key);
      counter.added += 1;
    }
  }

  // ---- самочувствие: одна отметка на день --------------------------------
  if (parsed.checkins.length > 0) {
    const counter = count("checkins");
    for (const { value } of parsed.checkins) {
      const { rows } = await client.query(
        `INSERT INTO user_checkins (user_id, local_date, mood, energy, tension, note, source)
         VALUES ($1, $2::date, $3, $4, $5, $6, 'import')
         ON CONFLICT (user_id, local_date) DO NOTHING
         RETURNING id`,
        [userId, value.local_date, value.mood, value.energy, value.tension, value.note],
      );
      if (rows.length > 0) counter.added += 1;
      else counter.existing += 1;
    }
  }

  // ---- бюджет: повтор — та же дата, сумма, валюта и описание ------------
  if (parsed.budget.length > 0) {
    const counter = count("budget");
    const { rows } = await client.query<Record<string, string | null>>(
      `SELECT occurred_on::text AS occurred_on, entry_type, amount_minor::text AS amount_minor, currency,
              category, store, description
         FROM budget_entries WHERE user_id = $1`,
      [userId],
    );
    const fingerprint = (row: Record<string, string | number | null>) => [
      row.occurred_on, row.entry_type, String(row.amount_minor), row.currency,
      fold(String(row.category ?? "")), fold(String(row.store ?? "")), fold(String(row.description ?? "")),
    ].join("|");
    const known = new Set(rows.map((row) => fingerprint(row)));
    for (const { value } of parsed.budget) {
      const key = fingerprint({ ...value });
      if (known.has(key)) {
        counter.existing += 1;
        continue;
      }
      await client.query(
        `INSERT INTO budget_entries
           (user_id, occurred_on, entry_type, amount_minor, currency, category, store, description, payment_method, quantity)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          userId, value.occurred_on, value.entry_type, value.amount_minor, value.currency, value.category,
          value.store, value.description, value.payment_method, value.quantity,
        ],
      );
      known.add(key);
      counter.added += 1;
    }
  }

  // ---- решения: повтор — тот же вопрос ----------------------------------
  if (parsed.decisions.length > 0) {
    const counter = count("decisions");
    const { rows } = await client.query<{ question: string }>(
      "SELECT question FROM eva_decisions WHERE user_id = $1",
      [userId],
    );
    const known = new Set(rows.map((row) => fold(row.question)));
    for (const { value } of parsed.decisions) {
      const key = fold(value.question);
      if (known.has(key)) {
        counter.existing += 1;
        continue;
      }
      await client.query(
        `INSERT INTO eva_decisions (
           user_id, question, options, facts, assumptions, criteria, risks, selected_option, confidence,
           reversible, cheap_test, review_at, actual_result, status, created_at
         ) VALUES (
           $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12::date, $13, $14,
           COALESCE($15::timestamptz, now())
         )`,
        [
          userId, value.question, JSON.stringify(value.options), JSON.stringify(value.facts),
          JSON.stringify(value.assumptions), JSON.stringify(value.criteria), JSON.stringify(value.risks),
          value.selected_option, value.confidence, value.reversible, value.cheap_test, value.review_at,
          value.actual_result, value.status, createdAt(value.created_at),
        ],
      );
      known.add(key);
      counter.added += 1;
    }
  }
}

/** Карточка человека по имени: есть — её id, нет — новая. Существующая не меняется. */
async function person(client: ApplyClient, userId: number, name: string): Promise<number> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO journal_people (user_id, display_name, normalized)
     VALUES ($1, $2, ${normalizeSql("$2")})
     ON CONFLICT (user_id, normalized) DO NOTHING
     RETURNING id`,
    [userId, name],
  );
  if (inserted.rows[0]) return Number(inserted.rows[0].id);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM journal_people WHERE user_id = $1 AND normalized = ${normalizeSql("$2")}`,
    [userId, name],
  );
  return Number(rows[0]!.id);
}
