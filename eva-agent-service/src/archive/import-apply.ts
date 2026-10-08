/**
 * Запись разобранного архива в базу — только добавлением.
 *
 * Главное правило загрузки: файл дополняет то, что есть у Евы, и ничего
 * не заменяет. Строки только вставляются, повтор уже имеющейся записи
 * пропускается, а «дополнение» — это заполнение пустого места (имя в
 * профиле, где имени нет; ответ анкеты, на который ответа не было) — и
 * условие «пусто» стоит в самом запросе записи, а не только в чтении
 * перед ней.
 *
 * Повтор узнаётся по содержанию, а не по идентификатору, и считается по
 * количеству: архив, загруженный дважды, второй раз ничего не добавляет,
 * а две одинаковые записи файла на чистом аккаунте дают две записи.
 *
 * Предпросмотр — тот же код в транзакции только для чтения, без единой
 * записи (`import-context.ts`). Запись — одной транзакцией вызывающего:
 * файл ложится целиком или не ложится вовсе.
 */

import { normalizeProfileValue } from "../profile/profile-service.js";
import { fold } from "./format.js";
import { createContext, type ApplyClient, type ApplyContext, type ApplyMode } from "./import-context.js";
import { applyEntries } from "./import-entries.js";
import { applyGoals, applyTasks } from "./import-goals.js";
import type { ParsedArchive, RowError } from "./import-types.js";
import { sheet, type SheetId } from "./sheets.js";

export type { ApplyClient } from "./import-context.js";

export interface SheetReport {
  id: SheetId;
  name: string;
  added: number;
  existing: number;
  /** Существующие записи, в которых заполнено пустое место. */
  filled: number;
}

export interface ImportReport {
  recognized: boolean;
  sheets: SheetReport[];
  added_total: number;
  existing_total: number;
  filled_total: number;
  /** Первые ошибки строк; всего их `error_count`. */
  errors: RowError[];
  error_count: number;
  warnings: string[];
  /** Задачи-действия, загруженные выключенными. */
  paused_actions: number;
  /** Напоминания, которые после загрузки начнут срабатывать. */
  active_reminders: number;
  read_only_sheets: string[];
  /** Текст для передачи Еве в чате: память из файла сама в память не пишется. */
  memory_handoff: string | null;
}

/** Загрузка уже идёт: вторая не ждёт её, держа соединение, а отказывает. */
export class ArchiveBusy extends Error {
  constructor() {
    super("archive_import_busy");
    this.name = "ArchiveBusy";
  }
}

const ERROR_LIMIT = 100;
const HANDOFF_LIMIT = 3_500;

export async function applyArchive(
  client: ApplyClient,
  input: { userId: number; parsed: ParsedArchive; now: Date; mode: ApplyMode },
): Promise<ImportReport> {
  const ctx = createContext({ client, ...input });
  if (input.mode === "apply") {
    // Две загрузки одного человека не идут параллельно: обе прочли бы
    // базу до записи другой. Блокировка не ждёт — занятая значит, что
    // загрузка уже идёт, и держать соединение пула в ожидании незачем.
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked",
      [`evaself.archive.import:${input.userId}`],
    );
    if (!rows[0]?.locked) throw new ArchiveBusy();
  }
  await client.query("SET LOCAL statement_timeout = '120s'");

  await applyProfile(ctx);
  await applyQuestionnaire(ctx);
  await applyNorth(ctx);
  const links = await applyGoals(ctx);
  const tasks = await applyTasks(ctx, links);
  await applyEntries(ctx);

  for (const [message, rows] of ctx.notices) {
    const shown = rows.slice(0, 10).join(", ");
    ctx.warnings.push(`${message}: строки ${shown}${rows.length > 10 ? ` и ещё ${rows.length - 10}` : ""}.`);
  }
  const sheets: SheetReport[] = [...ctx.counters.entries()].map(([id, counter]) => ({
    id, name: sheet(id).name, added: counter.added, existing: counter.existing, filled: counter.filled,
  }));
  return {
    recognized: input.parsed.recognized,
    sheets,
    added_total: sheets.reduce((sum, item) => sum + item.added, 0),
    existing_total: sheets.reduce((sum, item) => sum + item.existing, 0),
    filled_total: sheets.reduce((sum, item) => sum + item.filled, 0),
    errors: ctx.errors.slice(0, ERROR_LIMIT),
    error_count: ctx.errors.length,
    warnings: ctx.warnings,
    paused_actions: tasks.paused,
    active_reminders: tasks.scheduled,
    read_only_sheets: input.parsed.readOnlySheets,
    memory_handoff: memoryHandoff(input.parsed.memory),
  };
}

// ---- профиль: заполняется только пустое -------------------------------

async function applyProfile(ctx: ApplyContext): Promise<void> {
  const profile = ctx.parsed.profile;
  if (!profile) return;
  const counter = ctx.count("profile");
  const { client, userId } = ctx;
  const current = (await client.query<Record<string, string | null>>(
    "SELECT first_name, last_name, city, country_code, timezone, timezone_source FROM users WHERE id = $1",
    [userId],
  )).rows[0];
  if (current) {
    // Условие «пусто» — в самом UPDATE: правка профиля между чтением и
    // записью не перезаписывается.
    const fills: Array<[string, string | undefined, string]> = [
      ["first_name", profile.first_name, "COALESCE(btrim(first_name), '') = ''"],
      ["last_name", profile.last_name, "COALESCE(btrim(last_name), '') = ''"],
      ["city", profile.city, "COALESCE(btrim(city), '') = ''"],
      ["country_code", profile.country_code, "COALESCE(btrim(country_code), '') = ''"],
    ];
    for (const [column, value, empty] of fills) {
      if (!value) continue;
      if ((current[column] ?? "").trim()) {
        counter.existing += 1;
        continue;
      }
      if (ctx.mode === "apply") {
        const { rows } = await client.query(
          `UPDATE users SET ${column} = $2, updated_at = now() WHERE id = $1 AND ${empty} RETURNING id`,
          [userId, value],
        );
        if (rows.length === 0) {
          counter.existing += 1;
          continue;
        }
      }
      counter.filled += 1;
    }
    // Пояс «UTC» без источника — значение по умолчанию, а не выбор
    // человека: его можно заполнить. Выбранный пояс не трогается.
    if (profile.timezone) {
      let filled = current.timezone_source === null && current.timezone === "UTC";
      if (filled && ctx.mode === "apply") {
        const { rows } = await client.query(
          `UPDATE users
              SET timezone = $2, timezone_source = 'import', timezone_updated_at = now(), updated_at = now()
            WHERE id = $1 AND timezone_source IS NULL AND timezone = 'UTC'
            RETURNING id`,
          [userId, profile.timezone],
        );
        filled = rows.length > 0;
      }
      if (filled) counter.filled += 1;
      else counter.existing += 1;
    }
  }
  const candidates: Array<[string, string | boolean | undefined]> = [
    ["response_mode", profile.response_mode],
    ["agent_mode", profile.agent_mode],
    ["use_emoji", profile.use_emoji],
    ["heartbeat_enabled", profile.heartbeat_enabled],
  ];
  const preferences = candidates.filter((entry) => entry[1] !== undefined);
  if (preferences.length === 0) return;
  // Настройки — одна строка на человека. Есть строка — человек уже что-то
  // выбирал, и файл её не трогает.
  let created: boolean;
  if (ctx.mode === "preview") {
    const { rows } = await client.query("SELECT 1 AS present FROM user_preferences WHERE user_id = $1", [userId]);
    created = rows.length === 0;
  } else {
    const { rows } = await client.query(
      `INSERT INTO user_preferences (user_id, ${preferences.map(([column]) => column).join(", ")})
       VALUES ($1, ${preferences.map((_, index) => `$${index + 2}`).join(", ")})
       ON CONFLICT (user_id) DO NOTHING
       RETURNING user_id`,
      [userId, ...preferences.map(([, value]) => value)],
    );
    created = rows.length > 0;
  }
  if (created) counter.added += preferences.length;
  else counter.existing += preferences.length;
}

// ---- анкета: ответ пишется туда, где ответа нет ------------------------

async function applyQuestionnaire(ctx: ApplyContext): Promise<void> {
  if (ctx.parsed.questionnaire.length === 0) return;
  const counter = ctx.count("questionnaire");
  const { client, userId } = ctx;
  const { rows: definitions } = await client.query<{
    field_key: string;
    value_type: "string" | "string_array" | "object";
    sensitivity: string;
    confirmation_required: boolean;
  }>("SELECT field_key, value_type, sensitivity, confirmation_required FROM profile_field_definitions WHERE enabled");
  const byKey = new Map(definitions.map((row) => [row.field_key, row]));
  const { rows: answers } = await client.query<{ field_key: string; empty: boolean }>(
    `SELECT field_key, (status = 'missing' AND field_value IS NULL AND field_json IS NULL) AS empty
       FROM onboarding_fields WHERE user_id = $1`,
    [userId],
  );
  const present = new Map(answers.map((row) => [row.field_key, row.empty]));
  for (const { row, value } of ctx.parsed.questionnaire) {
    const definition = byKey.get(value.field_key);
    if (!definition) {
      ctx.errors.push({ sheet: sheet("questionnaire").name, row, message: `поле «${value.field_key}» Еве неизвестно` });
      continue;
    }
    let normalized: { text: string | null; json: unknown };
    try {
      const raw = value.field_key === "grammatical_gender" ? gender(value.value) : value.value;
      normalized = normalizeProfileValue(answer(raw, definition.value_type), definition.value_type);
    } catch (error) {
      ctx.errors.push({
        sheet: sheet("questionnaire").name,
        row,
        message: error instanceof SyntaxError ? "ответ должен быть JSON-объектом" : (error as Error).message,
      });
      continue;
    }
    // Чувствительное поле и поле, требующее подтверждения, из файла
    // приходят предположением: подтверждает их человек в разговоре, а не
    // отметка в файле, который мог прийти не от него.
    const status = definition.confirmation_required || definition.sensitivity !== "normal" ? "candidate" : value.status;
    const empty = present.get(value.field_key);
    if (empty === false) {
      counter.existing += 1;
      continue;
    }
    if (ctx.mode === "preview") {
      if (empty === undefined) counter.added += 1;
      else counter.filled += 1;
      present.set(value.field_key, false);
      continue;
    }
    const { rows } = await client.query<{ inserted: boolean }>(
      `INSERT INTO onboarding_fields
         (user_id, field_key, field_value, field_json, status, confidence, source_type, confirmed_at, sensitivity)
       SELECT $1, d.field_key, $3, $4::jsonb, $5, 1, 'archive_import',
              CASE WHEN $5 = 'confirmed' THEN now() ELSE NULL END, d.sensitivity
         FROM profile_field_definitions d
        WHERE d.field_key = $2
       ON CONFLICT (user_id, field_key) DO UPDATE SET
         field_value = EXCLUDED.field_value,
         field_json = EXCLUDED.field_json,
         status = EXCLUDED.status,
         confidence = EXCLUDED.confidence,
         source_type = EXCLUDED.source_type,
         confirmed_at = EXCLUDED.confirmed_at,
         answered_at = now(),
         updated_at = now()
       WHERE onboarding_fields.status = 'missing'
         AND onboarding_fields.field_value IS NULL
         AND onboarding_fields.field_json IS NULL
       RETURNING (xmax = 0) AS inserted`,
      [userId, value.field_key, normalized.text, normalized.json === null ? null : JSON.stringify(normalized.json), status],
    );
    present.set(value.field_key, false);
    if (!rows[0]) counter.existing += 1;
    else if (rows[0].inserted) counter.added += 1;
    else counter.filled += 1;
  }
}

// ---- направление: одна строка на человека -----------------------------

async function applyNorth(ctx: ApplyContext): Promise<void> {
  const north = ctx.parsed.north;
  if (!north) return;
  const counter = ctx.count("north");
  let created: boolean;
  if (ctx.mode === "preview") {
    const { rows } = await ctx.client.query("SELECT 1 AS present FROM user_north WHERE user_id = $1", [ctx.userId]);
    created = rows.length === 0;
  } else {
    const { rows } = await ctx.client.query(
      `INSERT INTO user_north (
         user_id, desired_direction, why_it_matters, values, acceptable_cost,
         unacceptable_cost, conflicts, reduce_list, user_confirmed, confirmed_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9, CASE WHEN $9 THEN now() ELSE NULL END)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING user_id`,
      [
        ctx.userId, north.desired_direction, north.why_it_matters, JSON.stringify(north.values),
        north.acceptable_cost, north.unacceptable_cost, JSON.stringify(north.conflicts),
        JSON.stringify(north.reduce_list), north.user_confirmed,
      ],
    );
    created = rows.length > 0;
  }
  if (created) counter.added += 1;
  else counter.existing += 1;
}

/**
 * Ответ анкеты из ячейки в форму значения поля. Список выгрузка пишет по
 * пункту на строку (или JSON-массивом): такой ответ делится только по
 * строкам, и запятая внутри пункта его не разрывает. Ответ одной строкой
 * делится, как в разговоре, — по запятым.
 */
function answer(raw: string, type: "string" | "string_array" | "object"): unknown {
  if (type === "object") return JSON.parse(raw) as unknown;
  if (type !== "string_array") return raw;
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Не JSON — обычный текст, который начинается со скобки.
    }
  }
  return raw.includes("\n") ? raw.split("\n") : raw;
}

function gender(value: string): string {
  const folded = fold(value);
  if (["masculine", "мужской", "м"].includes(folded)) return "masculine";
  if (["feminine", "женский", "ж"].includes(folded)) return "feminine";
  throw new Error("грамматический род — «мужской» или «женский»");
}

/** Обращение к Еве с памятью из файла — его человек отправит сам. */
function memoryHandoff(memory: ParsedArchive["memory"]): string | null {
  if (memory.length === 0) return null;
  const intro = "Это из моего архива — то, что ты знала обо мне раньше. Посмотри и запомни то, что важно сейчас.";
  let text = [intro, ...memory.map((item) => `${item.label}:\n${item.value}`)].join("\n\n");
  if (text.length > HANDOFF_LIMIT) text = `${text.slice(0, HANDOFF_LIMIT - 1)}…`;
  return text;
}
