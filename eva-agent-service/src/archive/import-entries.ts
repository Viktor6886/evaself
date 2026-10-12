/**
 * Запись записей архива: люди и дневник, заметки, самочувствие, бюджет,
 * решения. Те же правила, что в `import-apply.ts`: только вставка, повтор
 * пропускается, существующие строки не меняются.
 *
 * Повтор длинного текста узнаётся по хэшу содержания, посчитанному на
 * стороне базы (`hashSql`): тянуть в память весь дневник человека ради
 * сравнения незачем. Повторы считаются по количеству (`Multiset`).
 */

import { normalizeSql } from "../public/journal/input.js";
import { fold } from "./format.js";
import { contentHash, hashSql, Multiset, type ApplyContext } from "./import-context.js";

export { contentHash, hashSql } from "./import-context.js";

export async function applyEntries(ctx: ApplyContext): Promise<void> {
  const { client, userId, parsed } = ctx;

  // ---- люди: одно имя — одна карточка ---------------------------------
  if (parsed.people.length > 0) {
    const counter = ctx.count("people");
    // Пустое «кем приходится» у существующей карточки — пустое место, его
    // можно заполнить; заполненное не меняется.
    const { rows } = await client.query<{ normalized: string; empty: boolean }>(
      "SELECT normalized, relation IS NULL AS empty FROM journal_people WHERE user_id = $1",
      [userId],
    );
    const known = new Map(rows.map((row) => [row.normalized, row.empty]));
    // Имя сводится тем же выражением, что и при записи (`normalizeSql`), и
    // одним запросом на весь лист: у JavaScript и PostgreSQL разные
    // представления о пробелах (неразрывный, например), и предпросмотр
    // расходился бы с записью.
    const keys = ctx.mode === "preview"
      ? (await client.query<{ normalized: string }>(
        `SELECT ${normalizeSql("name")} AS normalized
           FROM unnest($1::text[]) WITH ORDINALITY AS item(name, position)
          ORDER BY position`,
        [parsed.people.map(({ value }) => value.display_name)],
      )).rows.map((row) => row.normalized)
      : [];
    for (const [index, { value }] of parsed.people.entries()) {
      await ctx.pace();
      const keyOf = keys[index] ?? "";
      if (ctx.mode === "preview") {
        const empty = known.get(keyOf);
        if (empty === undefined) counter.added += 1;
        else if (empty && value.relation) counter.filled += 1;
        else counter.existing += 1;
        known.set(keyOf, empty === undefined ? !value.relation : empty && !value.relation);
        continue;
      }
      const { rows: written } = await client.query<{ inserted: boolean }>(
        `INSERT INTO journal_people (user_id, display_name, normalized, relation)
         VALUES ($1, $2, ${normalizeSql("$2")}, $3)
         ON CONFLICT (user_id, normalized) DO UPDATE SET relation = EXCLUDED.relation, updated_at = now()
           WHERE journal_people.relation IS NULL AND EXCLUDED.relation IS NOT NULL
         RETURNING (xmax = 0) AS inserted`,
        [userId, value.display_name, value.relation],
      );
      if (!written[0]) counter.existing += 1;
      else if (written[0].inserted) counter.added += 1;
      else counter.filled += 1;
    }
  }

  // ---- дневник: повтор — тот же день и тот же текст --------------------
  if (parsed.journal.length > 0) {
    const counter = ctx.count("journal");
    const { rows } = await client.query<{ local_date: string; hash: string }>(
      `SELECT local_date::text AS local_date, ${hashSql("content")} AS hash
         FROM journal_entries WHERE user_id = $1`,
      [userId],
    );
    const existing = new Multiset();
    for (const row of rows) existing.add(`${row.local_date}|${row.hash}`, true);
    // Одно имя — один поиск карточки на всю загрузку, сколько бы записей
    // его ни упоминали.
    const personIds = new Map<string, number>();
    for (const { value } of parsed.journal) {
      await ctx.pace();
      if (existing.take(`${value.local_date}|${contentHash(value.content)}`) !== undefined) {
        counter.existing += 1;
        continue;
      }
      // Запись возвращается сохранённой, а не «обсуждённой с Евой»: того
      // разговора в этой переписке не было.
      const entryId = await ctx.insert(
        `INSERT INTO journal_entries (user_id, local_date, title, content, mood, energy, share_state, source_channel, created_at)
         VALUES ($1, $2::date, $3, $4, $5, $6, 'saved', 'miniapp', COALESCE($7::timestamptz, now()))
         RETURNING id`,
        [userId, value.local_date, value.title, value.content, value.mood, value.energy, ctx.createdAt(value.created_at)],
      );
      if (ctx.mode === "apply") {
        for (const name of value.people) {
          await client.query(
            `INSERT INTO journal_entry_people (user_id, entry_id, person_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (entry_id, person_id) DO NOTHING`,
            [userId, entryId, await person(ctx, name, personIds)],
          );
        }
      }
      counter.added += 1;
    }
  }

  // ---- заметки: повтор — тот же заголовок и текст -----------------------
  if (parsed.notes.length > 0) {
    const counter = ctx.count("notes");
    const { rows } = await client.query<{ title: string; hash: string }>(
      `SELECT title, ${hashSql("content")} AS hash FROM eva_notes WHERE user_id = $1`,
      [userId],
    );
    const existing = new Multiset();
    for (const row of rows) existing.add(`${fold(row.title)}|${row.hash}`, true);
    for (const { value } of parsed.notes) {
      await ctx.pace();
      if (existing.take(`${fold(value.title)}|${contentHash(value.content)}`) !== undefined) {
        counter.existing += 1;
        continue;
      }
      await ctx.run(
        `INSERT INTO eva_notes (user_id, title, content, category, tags, pinned, entry_type, created_at)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7, COALESCE($8::timestamptz, now()))`,
        [userId, value.title, value.content, value.category, value.tags, value.pinned, value.entry_type, ctx.createdAt(value.created_at)],
      );
      counter.added += 1;
    }
  }

  // ---- самочувствие: одна отметка на день --------------------------------
  if (parsed.checkins.length > 0) {
    const counter = ctx.count("checkins");
    const { rows } = await client.query<{ local_date: string }>(
      "SELECT local_date::text AS local_date FROM user_checkins WHERE user_id = $1",
      [userId],
    );
    const days = new Set(rows.map((row) => row.local_date));
    for (const { value } of parsed.checkins) {
      await ctx.pace();
      if (days.has(value.local_date)) {
        counter.existing += 1;
        continue;
      }
      days.add(value.local_date);
      if (ctx.mode === "apply") {
        const { rows: written } = await client.query(
          `INSERT INTO user_checkins (user_id, local_date, mood, energy, tension, note, source)
           VALUES ($1, $2::date, $3, $4, $5, $6, 'import')
           ON CONFLICT (user_id, local_date) DO NOTHING
           RETURNING id`,
          [userId, value.local_date, value.mood, value.energy, value.tension, value.note],
        );
        if (written.length === 0) {
          counter.existing += 1;
          continue;
        }
      }
      counter.added += 1;
    }
  }

  // ---- бюджет: повтор — все поля записи ----------------------------------
  if (parsed.budget.length > 0) {
    const counter = ctx.count("budget");
    const { rows } = await client.query<Record<string, string | null>>(
      `SELECT occurred_on::text AS occurred_on, entry_type, amount_minor::text AS amount_minor, currency,
              category, store, description, payment_method, quantity::text AS quantity
         FROM budget_entries WHERE user_id = $1`,
      [userId],
    );
    const fingerprint = (row: Record<string, string | number | null>) => [
      row.occurred_on, row.entry_type, String(row.amount_minor), row.currency,
      fold(String(row.category ?? "")), fold(String(row.store ?? "")), fold(String(row.description ?? "")),
      fold(String(row.payment_method ?? "")), row.quantity === null || row.quantity === undefined ? "" : String(Number(row.quantity)),
    ].join("|");
    const existing = new Multiset();
    for (const row of rows) existing.add(fingerprint(row), true);
    for (const { value } of parsed.budget) {
      await ctx.pace();
      if (existing.take(fingerprint({ ...value })) !== undefined) {
        counter.existing += 1;
        continue;
      }
      await ctx.run(
        `INSERT INTO budget_entries
           (user_id, occurred_on, entry_type, amount_minor, currency, category, store, description, payment_method, quantity)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          userId, value.occurred_on, value.entry_type, value.amount_minor, value.currency, value.category,
          value.store, value.description, value.payment_method, value.quantity,
        ],
      );
      counter.added += 1;
    }
  }

  // ---- решения: повтор — тот же вопрос ----------------------------------
  if (parsed.decisions.length > 0) {
    const counter = ctx.count("decisions");
    const { rows } = await client.query<{ question: string }>(
      "SELECT question FROM eva_decisions WHERE user_id = $1",
      [userId],
    );
    const existing = new Multiset();
    for (const row of rows) existing.add(fold(row.question), true);
    for (const { value } of parsed.decisions) {
      await ctx.pace();
      if (existing.take(fold(value.question)) !== undefined) {
        counter.existing += 1;
        continue;
      }
      await ctx.run(
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
          value.actual_result, value.status, ctx.createdAt(value.created_at),
        ],
      );
      counter.added += 1;
    }
  }
}

/** Карточка человека по имени: есть — её id, нет — новая. Существующая не меняется. */
async function person(ctx: ApplyContext, name: string, cache: Map<string, number>): Promise<number> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const id = await findOrCreatePerson(ctx, name);
  cache.set(name, id);
  return id;
}

async function findOrCreatePerson(ctx: ApplyContext, name: string): Promise<number> {
  const inserted = await ctx.client.query<{ id: string }>(
    `INSERT INTO journal_people (user_id, display_name, normalized)
     VALUES ($1, $2, ${normalizeSql("$2")})
     ON CONFLICT (user_id, normalized) DO NOTHING
     RETURNING id`,
    [ctx.userId, name],
  );
  if (inserted.rows[0]) return Number(inserted.rows[0].id);
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT id FROM journal_people WHERE user_id = $1 AND normalized = ${normalizeSql("$2")}`,
    [ctx.userId, name],
  );
  return Number(rows[0]!.id);
}
