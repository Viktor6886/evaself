/**
 * Архив данных человека (docs/data-archive.md): маршруты Mini App, разбор
 * присланного файла и сервис поверх поддельной базы.
 *
 * Поддельная база здесь пропускает каждый запрос через настоящую
 * `assertQueryAllowed` в области человека: запрос выгрузки без владельца
 * упал бы здесь, а не в production. Сам SQL — вставка без перезаписи,
 * хэш содержания, ограничения таблиц — проверяется на настоящем
 * PostgreSQL: `scripts/ci/test-data-archive.mjs`.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";

import Fastify from "fastify";

import { readWorkbook } from "../dist/archive/xlsx-reader.js";
import { writeWorkbook } from "../dist/archive/xlsx-writer.js";
import { parseArchive } from "../dist/archive/import-parse.js";
import { contentHash } from "../dist/archive/import-entries.js";
import { Multiset } from "../dist/archive/import-context.js";
import { cleanText } from "../dist/archive/format.js";
import { DataArchiveService, memoryBlocksOf } from "../dist/archive/service.js";
import type { DataArchivePublic } from "../dist/public/archive-routes.js";
import { registerPublicRoutes } from "../dist/public/routes.js";
import { assertQueryAllowed, bindUserId, currentScope, runInScope, userScope } from "../dist/tenancy/scope.js";

const BOT_TOKEN = "123456789:AAAA_test_token";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const USER = { id: 42001, first_name: "Test", username: "test_user", language_code: "ru" };

function initData(user: Record<string, unknown>): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(NOW.getTime() / 1000)), query_id: "AAEAAAE",
    signature: "telegram-ed25519-signature", user: JSON.stringify(user),
  });
  const check = [...params.entries()].sort(([l], [r]) => l.localeCompare(r)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

const signed = { "x-telegram-init-data": initData(USER) };

/** Лимитер в памяти: считает попадания в корзину за всё время теста. */
function limiter() {
  const counts = new Map<string, number>();
  return {
    counts,
    hit: async (bucket: string, limit: number) => {
      const count = (counts.get(bucket) ?? 0) + 1;
      counts.set(bucket, count);
      return { allowed: count <= limit, remaining: Math.max(limit - count, 0), retryAfterSeconds: 60 };
    },
  };
}

function app(archive?: DataArchivePublic, rateLimiter = limiter()) {
  const fastify = Fastify({ logger: false });
  registerPublicRoutes(fastify, {
    config: { telegramBotToken: BOT_TOKEN, telegramWebAppMaxAgeSeconds: 3_600, rateLimitWindowSeconds: 60, publicRateLimitPerIp: 1_000, publicRateLimitPerUser: 1_000 } as never,
    repository: { openSession: async () => ({}) } as never,
    now: () => NOW,
    rateLimiter,
    ...(archive ? { archive } : {}),
  });
  return fastify;
}

function multipart(name: string, bytes: Buffer, field = "file") {
  const boundary = "----ArchiveBoundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\n`
      + "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n"),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { ...signed, "content-type": `multipart/form-data; boundary=${boundary}` } };
}

function stub(calls: string[], enabled = true): DataArchivePublic {
  return {
    overview: () => ({ enabled, memory: false, max_bytes: 10 * 1024 * 1024 }),
    export: async (telegramId) => { calls.push(`export:${telegramId}`); return { sent: true }; },
    preview: async (telegramId, file) => { calls.push(`preview:${telegramId}:${file.toString("utf8")}`); return { applied: false }; },
    apply: async (telegramId, file, sha) => { calls.push(`apply:${telegramId}:${file.toString("utf8")}:${sha}`); return { applied: true }; },
  };
}

test("маршруты: без сервиса или с выключенным флагом раздел скрыт, действия отклоняются", async () => {
  for (const archive of [undefined, stub([], false)]) {
    const fastify = app(archive);
    try {
      const overview = await fastify.inject({ method: "GET", url: "/public/archive", headers: signed });
      assert.equal(overview.statusCode, 200);
      assert.equal(overview.json().enabled, false);
      assert.equal((await fastify.inject({ method: "POST", url: "/public/archive/export", headers: signed })).statusCode, 400);
    } finally {
      await fastify.close();
    }
  }
});

test("маршруты: человек — из подписи, без подписи 401 и до сервиса не доходит", async () => {
  const calls: string[] = [];
  const fastify = app(stub(calls));
  try {
    assert.equal((await fastify.inject({ method: "POST", url: "/public/archive/export" })).statusCode, 401);
    assert.deepEqual(calls, []);
    const exported = await fastify.inject({ method: "POST", url: "/public/archive/export", headers: signed });
    assert.equal(exported.statusCode, 200);
    assert.deepEqual(calls, [`export:${USER.id}`]);
  } finally {
    await fastify.close();
  }
});

test("маршруты: выгрузка ограничена тремя за десять минут на человека", async () => {
  const calls: string[] = [];
  const rate = limiter();
  const fastify = app(stub(calls), rate);
  try {
    const codes = [];
    for (let index = 0; index < 4; index += 1) {
      codes.push((await fastify.inject({ method: "POST", url: "/public/archive/export", headers: signed })).statusCode);
    }
    assert.deepEqual(codes, [200, 200, 200, 429]);
    assert.equal(calls.length, 3);
    assert.equal(rate.counts.get(`public:archive:export:${USER.id}`), 4);
  } finally {
    await fastify.close();
  }
});

test("маршруты: файл приходит в сервис как есть; поле и отметка предпросмотра проверяются", async () => {
  const calls: string[] = [];
  const fastify = app(stub(calls));
  try {
    const preview = multipart("архив.xlsx", Buffer.from("содержимое"));
    const answer = await fastify.inject({ method: "POST", url: "/public/archive/import/preview", payload: preview.body, headers: preview.headers });
    assert.equal(answer.statusCode, 200);
    assert.deepEqual(calls, [`preview:${USER.id}:содержимое`]);

    const wrong = multipart("архив.xlsx", Buffer.from("x"), "document");
    assert.equal((await fastify.inject({ method: "POST", url: "/public/archive/import/preview", payload: wrong.body, headers: wrong.headers })).statusCode, 400);

    const sha = "b".repeat(64);
    const unmarked = multipart("архив.xlsx", Buffer.from("x"));
    const refused = await fastify.inject({ method: "POST", url: "/public/archive/import", payload: unmarked.body, headers: unmarked.headers });
    assert.equal(refused.statusCode, 400, "запись без отметки предпросмотра отклоняется");
    assert.match(refused.json().error.message, /Сначала посмотри/);
    assert.equal(calls.some((call) => call.startsWith("apply:")), false);
    const bad = multipart("архив.xlsx", Buffer.from("x"));
    assert.equal((await fastify.inject({ method: "POST", url: "/public/archive/import?sha256=../../etc", payload: bad.body, headers: bad.headers })).statusCode, 400);
    const good = multipart("архив.xlsx", Buffer.from("данные"));
    assert.equal((await fastify.inject({ method: "POST", url: `/public/archive/import?sha256=${sha}`, payload: good.body, headers: good.headers })).statusCode, 200);
    assert.equal(calls.at(-1), `apply:${USER.id}:данные:${sha}`);
  } finally {
    await fastify.close();
  }
});

// ---------------------------------------------------------------------
// разбор файла
// ---------------------------------------------------------------------

const ZONE = "Europe/Moscow";
const sheetOf = (name: string, rows: Array<Array<string | number | boolean | null>>) => ({ name, rows });

test("разбор: столбцы — по заголовку в любом порядке, ошибки — с номером строки Excel", () => {
  const parsed = parseArchive({
    date1904: false,
    sheets: [sheetOf("Задачи и напоминания", [
      ["Статус", "Лишний столбец", "Название", "Напомнить", "Повтор (cron)", "Повторять", "Часовой пояс", "Вид"],
      ["в работе", "x", "Позвонить маме", "07.10.2026 18:30", null, null, null, "напоминание"],
      [],
      ["done", null, "Старая", 46302.5, null, "нет", "Europe/Moscow", null],
      ["открыта", null, "Без cron", null, null, "да", null, null],
      ["открыта", null, "Плохой пояс", null, null, null, "Mars/Base", null],
      ["непонятно", null, "Плохой статус", null, null, null, null, null],
      ["открыта", null, "", null, null, null, null, null],
    ])],
  }, { zone: ZONE });
  assert.deepEqual(parsed.tasks.map((item) => [item.row, item.value.title, item.value.status]), [
    [2, "Позвонить маме", "in_progress"],
    [4, "Старая", "done"],
    [5, "Без cron", "open"],
  ]);
  assert.equal(parsed.tasks[2]!.value.repeat_enabled, false, "«повторять» без расписания — разовая задача");
  assert.equal(parsed.tasks[0]!.value.remind_at, "2026-10-07T18:30");
  assert.equal(parsed.tasks[1]!.value.remind_at, "2026-10-07T12:00", "номер дня Excel читается как дата");
  assert.deepEqual(parsed.errors.map((error) => error.row), [6, 7, 8]);
  assert.match(parsed.errors[0]!.message, /Mars\/Base/);
  assert.match(parsed.errors[1]!.message, /не из списка/);
  assert.match(parsed.errors[2]!.message, /Название/);
});

test("разбор: «О файле» — чужой формат и более новая версия отклоняются, пояс берётся из файла", () => {
  const about = (format: string, version: string, zone = "Asia/Yekaterinburg") => sheetOf("О файле", [
    ["Поле", "Значение"], ["Формат", format], ["Версия формата", version], ["Часовой пояс времени в файле", zone],
  ]);
  assert.throws(() => parseArchive({ date1904: false, sheets: [about("чужой", "1")] }, { zone: ZONE }), /не архив Евы/);
  assert.throws(() => parseArchive({ date1904: false, sheets: [about("evaself-archive", "2")] }, { zone: ZONE }), /более новой версией/);
  const parsed = parseArchive({
    date1904: false,
    sheets: [about("evaself-archive", "1"), sheetOf("Дневник", [
      ["Дата", "Запись", "Создана", "Люди"],
      ["2026-10-01", "Текст", "2026-10-01T09:15:00Z", "Мама\nПапа"],
    ])],
  }, { zone: ZONE });
  assert.equal(parsed.recognized, true);
  assert.equal(parsed.zone, "Asia/Yekaterinburg");
  // Момент со смещением переводится в пояс файла, а не в пояс сервера.
  assert.equal(parsed.journal[0]!.value.created_at, "2026-10-01T14:15");
  assert.deepEqual(parsed.journal[0]!.value.people, ["Мама", "Папа"]);
});

test("разбор: нет обязательного столбца — лист пропущен с понятной причиной", () => {
  const parsed = parseArchive({ date1904: false, sheets: [sheetOf("Цели", [["Ключ", "Статус"], ["Ц1", "черновик"]])] }, { zone: ZONE });
  assert.deepEqual(parsed.goals, []);
  assert.equal(parsed.errors[0]!.row, 1);
  assert.match(parsed.errors[0]!.message, /«Название»/);
});

test("разбор: продолжения длинного текста склеиваются без потери пробелов на стыке", () => {
  const parsed = parseArchive({
    date1904: true,
    sheets: [sheetOf("Заметки", [
      ["Заголовок", "Текст", "Текст (продолжение 1)", "Создана"],
      ["Длинная", "первая часть ", "вторая часть", 44840.5],
    ])],
  }, { zone: ZONE });
  assert.equal(parsed.notes[0]!.value.content, "первая часть вторая часть");
  assert.equal(parsed.notes[0]!.value.created_at, "2026-10-07T12:00", "календарь 1904 года");
});

test("разбор: продолжений столько, сколько в файле, и в любом порядке столбцов", () => {
  const parsed = parseArchive({
    date1904: false,
    sheets: [sheetOf("Заметки", [
      ["Текст (продолжение 2)", "Заголовок", "Текст", "Текст (продолжение 1)", "Текст (продолжение 999)"],
      ["третья", "Порядок", "первая ", "вторая ", null],
    ])],
  }, { zone: ZONE });
  assert.equal(parsed.notes[0]!.value.content, "первая вторая третья");
});

test("разбор: суммы, подписи и статус анкеты", () => {
  const parsed = parseArchive({
    date1904: false,
    sheets: [
      sheetOf("Бюджет", [
        ["Дата", "Тип", "Сумма", "Валюта"],
        ["07.10.2026", "доход", "1 234,50", "rub"],
        ["07.10.2026", null, -99.9, null],
        ["07.10.2026", null, 10, "рубли"],
      ]),
      sheetOf("Анкета", [
        ["Код поля", "Ответ", "Статус"],
        ["city", "Пермь", "подтверждено"],
        ["interests", "бег\nгоры", "предположение"],
        ["Город", "Пермь", null],
        ["work_schedule", null, "отказ отвечать"],
        ["quiet_hours", null, "не относится"],
      ]),
      sheetOf("Решения", [
        ["Вопрос", "Варианты"],
        ["Бежать ли весной?", JSON.stringify(["да", "нет, осенью\nесли не успею"])],
        ["Переезжать?", "да\nнет"],
      ]),
    ],
  }, { zone: ZONE });
  assert.deepEqual(parsed.budget.map((item) => [item.value.entry_type, item.value.amount_minor, item.value.currency]), [
    ["income", 123_450, "RUB"],
    ["expense", 9_990, "RUB"],
  ]);
  assert.equal(parsed.errors.find((error) => error.sheet === "Бюджет")?.row, 4);
  assert.deepEqual(parsed.questionnaire.map((item) => [item.value.field_key, item.value.status]), [
    ["city", "confirmed"],
    ["interests", "candidate"],
  ]);
  assert.match(parsed.errors.find((error) => error.sheet === "Анкета")!.message, /латиница/);
  assert.equal(parsed.errors.filter((error) => error.sheet === "Анкета").length, 1, "отказ отвечать — не ошибка");
  assert.deepEqual(parsed.decisions.map((item) => item.value.options), [
    ["да", "нет, осенью\nесли не успею"],
    ["да", "нет"],
  ]);
});

test("разбор: память Евы читается, но только как текст для передачи", () => {
  const parsed = parseArchive({
    date1904: false,
    sheets: [sheetOf("Память Евы", [
      ["Раздел", "Содержание", "Содержание (продолжение 1)"],
      ["Что Ева знает обо мне", "Любит ", "горы"],
      ["persona", "Я — Ева", null],
    ])],
  }, { zone: ZONE });
  assert.deepEqual(parsed.memory, [{ label: "Что Ева знает обо мне", value: "Любит горы" }]);
});

test("хэш содержания не зависит от переводов строк и пробелов по краям", () => {
  assert.equal(contentHash("строка\r\nвторая\n "), contentHash("строка\nвторая"));
  assert.equal(contentHash("а"), createHash("md5").update("а", "utf8").digest("hex"));
  assert.notEqual(contentHash("а б"), contentHash("аб"));
});

test("блоки памяти — из blocks или memory.blocks; нет ни того, ни другого — null", () => {
  assert.deepEqual(memoryBlocksOf({ blocks: [{ label: "human", value: "Любит горы" }, { label: "persona", value: "Ева" }] }),
    { human: "Любит горы", current_state: null });
  assert.deepEqual(memoryBlocksOf({ memory: { blocks: [{ label: "current_state", value: "Устала" }] } }),
    { human: null, current_state: "Устала" });
  assert.equal(memoryBlocksOf({ id: "agent" }), null);
  assert.equal(memoryBlocksOf(null), null);
});

// ---------------------------------------------------------------------
// сервис поверх поддельной базы с настоящей границей арендатора
// ---------------------------------------------------------------------

const INTERNAL = 7;

function guardedDb(rows: (sql: string) => unknown[] = () => []) {
  const queries: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    assertQueryAllowed(sql, params);
    const flat = sql.replace(/\s+/gu, " ").trim();
    queries.push(flat);
    if (flat.startsWith("SELECT id, timezone FROM users")) return { rows: [{ id: String(INTERNAL), timezone: ZONE }], rowCount: 1 };
    if (flat.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }], rowCount: 1 };
    if (flat.startsWith("INSERT INTO") && flat.includes("RETURNING id")) return { rows: [{ id: "1" }], rowCount: 1 };
    return { rows: rows(flat), rowCount: 0 };
  };
  const db = {
    query,
    withUserScope: async (input: { telegramId?: number; userId?: number; label: string }, work: () => Promise<unknown>) =>
      await runInScope(userScope(input), work),
    bindScopeUserId: (userId: number) => bindUserId(userId),
    transaction: async (work: (client: { query: typeof query }) => Promise<unknown>) => await work({ query }),
  };
  return { db, queries };
}

function service(options: {
  enabled?: boolean;
  memory?: boolean;
  memorySource?: () => Promise<unknown>;
  /** Доставка ждёт этого обещания — так выгрузка остаётся «в работе». */
  delivery?: Promise<void>;
} = {}) {
  const sent: Array<{ chatId: number; bytes: Buffer; filename: string; mimeType?: string }> = [];
  const { db, queries } = guardedDb();
  const archive = new DataArchiveService({
    db: db as never,
    telegram: {
      sendDocument: async (chatId, bytes, filename, extra) => {
        await options.delivery;
        sent.push({ chatId, bytes: Buffer.from(bytes), filename, ...(extra?.mimeType ? { mimeType: extra.mimeType } : {}) });
      },
    },
    flags: { enabled: () => options.enabled ?? true, memory: () => options.memory ?? false },
    memory: { read: async () => (options.memorySource ? await options.memorySource() : null) as never },
    now: () => NOW,
  });
  return { archive, sent, queries };
}

test("сервис: выгрузка — каждый запрос в области человека, файл уходит ему в чат", async () => {
  const { archive, sent, queries } = service();
  const result = await archive.export(USER.id);
  assert.equal(currentScope(), undefined, "область не протекает наружу");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.chatId, USER.id);
  assert.equal(sent[0]!.filename, "eva-archive-2026-10-07.xlsx");
  assert.match(String(sent[0]!.mimeType), /spreadsheetml/);
  assert.equal(result.filename, sent[0]!.filename);
  // Каждый запрос к пользовательской таблице назвал владельца — иначе
  // assertQueryAllowed уже бросил бы исключение.
  assert.ok(queries.some((sql) => sql.includes("FROM tasks WHERE user_id = $1")));
  assert.ok(queries.some((sql) => sql.startsWith("INSERT INTO audit_log")));
  const book = await readWorkbook(sent[0]!.bytes);
  assert.equal(book.sheets[0]!.name, "О файле");
  assert.equal(book.sheets.some((sheet) => sheet.name === "Память Евы"), false, "память без флага не выгружается");
  assert.equal(book.sheets.some((sheet) => sheet.name.includes("OSINT")), false);
});

test("сервис: память по флагу — только human и current_state; недоступный runtime не ломает выгрузку", async () => {
  const withMemory = service({
    memory: true,
    memorySource: async () => ({ human: "Любит горы", current_state: "Готовится к марафону" }),
  });
  await withMemory.archive.export(USER.id);
  const book = await readWorkbook(withMemory.sent[0]!.bytes);
  const memory = book.sheets.find((sheet) => sheet.name === "Память Евы");
  assert.ok(memory);
  assert.deepEqual(memory.rows.slice(1).map((row) => row[0]), ["Что Ева знает обо мне", "Моё текущее состояние"]);

  const long = `${"Длинная память. ".repeat(4_500)}конец`;
  const spilled = service({ memory: true, memorySource: async () => ({ human: long, current_state: null }) });
  const exported = await spilled.archive.export(USER.id);
  assert.equal(exported.truncated, 0, "длинная память не обрезана");
  const memorySheet = (await readWorkbook(spilled.sent[0]!.bytes)).sheets.find((sheet) => sheet.name === "Память Евы")!;
  assert.deepEqual(memorySheet.rows[0], ["Раздел", "Содержание", "Содержание (продолжение 1)", "Содержание (продолжение 2)"]);
  assert.equal(memorySheet.rows[1]!.slice(1).join(""), long);
  const reparsed = parseArchive(await readWorkbook(spilled.sent[0]!.bytes), { zone: ZONE });
  assert.equal(reparsed.memory[0]!.value, long);

  const broken = service({ memory: true, memorySource: async () => { throw new Error("runtime down"); } });
  await broken.archive.export(USER.id);
  const fallback = (await readWorkbook(broken.sent[0]!.bytes)).sheets.find((sheet) => sheet.name === "Память Евы");
  assert.match(String(fallback?.rows[1]?.[1]), /недоступна/);
});

test("сервис: выключенный флаг — отказ до любого запроса", async () => {
  const { archive, queries, sent } = service({ enabled: false });
  await assert.rejects(archive.export(USER.id), /отключён/);
  await assert.rejects(archive.preview(USER.id, Buffer.from("x")), /отключён/);
  assert.deepEqual(queries, []);
  assert.deepEqual(sent, []);
});

test("сервис: предпросмотр ничего не фиксирует, запись чужого файла после предпросмотра — 409", async () => {
  const { bytes } = await writeWorkbook([{
    name: "Заметки",
    columns: [{ header: "Заголовок", kind: "text" }, { header: "Текст", kind: "longtext" }],
    rows: [["Идея", "Текст идеи"]],
  }], { title: "t", creator: "t", created: NOW });
  const { archive, queries } = service();
  const preview = await archive.preview(USER.id, bytes);
  assert.equal(preview.applied, false);
  assert.equal(preview.added_total, 1);
  assert.equal(preview.file_sha256, createHash("sha256").update(bytes).digest("hex"));
  // Предпросмотр — транзакция только для чтения и ни одной записи.
  assert.ok(queries.includes("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"));
  assert.equal(queries.some((sql) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false, "предпросмотр ничего не пишет");
  assert.equal(queries.some((sql) => sql.includes("pg_try_advisory_xact_lock")), false, "предпросмотру блокировка не нужна");

  const sha = createHash("sha256").update(bytes).digest("hex");
  const applied = await archive.apply(USER.id, bytes, sha);
  assert.equal(applied.applied, true);
  assert.ok(queries.some((sql) => sql.startsWith("SELECT pg_try_advisory_xact_lock")), "запись не ждёт чужую блокировку");
  assert.ok(queries.some((sql) => sql.startsWith("INSERT INTO eva_notes")));
  assert.ok(queries.some((sql) => sql.startsWith("INSERT INTO audit_log")), "запись — в аудите");

  await assert.rejects(archive.apply(USER.id, bytes, "c".repeat(64)), (error: { statusCode?: number }) => error.statusCode === 409);
  await assert.rejects(archive.preview(USER.id, Buffer.from("not a workbook at all")), /не файл Excel/);
  const empty = await writeWorkbook([{ name: "Чужой лист", columns: [{ header: "А", kind: "text" }], rows: [["1"]] }],
    { title: "t", creator: "t", created: NOW });
  await assert.rejects(archive.preview(USER.id, empty.bytes), /нет листов архива Евы/);
});

test("сервис: одна архивная операция на человека и не больше двух на процесс — отказ сразу, без ожидания", async () => {
  const { bytes } = await writeWorkbook([{
    name: "Заметки",
    columns: [{ header: "Заголовок", kind: "text" }, { header: "Текст", kind: "longtext" }],
    rows: [["Идея", "Текст"]],
  }], { title: "t", creator: "t", created: NOW });
  let release: () => void = () => undefined;
  const delivery = new Promise<void>((resolve) => { release = resolve; });
  const { archive } = service({ delivery });
  const first = archive.export(USER.id);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(archive.preview(USER.id, bytes), (error: { statusCode?: number }) => error.statusCode === 409);
  const second = archive.export(USER.id + 1);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(archive.export(USER.id + 2), (error: { statusCode?: number }) => error.statusCode === 429);
  release();
  await Promise.all([first, second]);
  assert.equal((await archive.preview(USER.id, bytes)).added_total, 1, "после окончания — снова можно");
});

test("сервис: файл больше предела записей отклоняется до базы", async () => {
  // На листе читается не больше 10 000 строк, поэтому предел всего файла
  // (30 000) превышают четыре листа.
  const many = (prefix: string) => Array.from({ length: 10_000 }, (_, index) => [`${prefix} ${index}`, "текст"]);
  const { bytes } = await writeWorkbook([
    { name: "Заметки", columns: [{ header: "Заголовок", kind: "text" }, { header: "Текст", kind: "longtext" }], rows: many("Заметка") },
    { name: "Решения", columns: [{ header: "Вопрос", kind: "longtext" }], rows: many("Вопрос") },
    { name: "Задачи и напоминания", columns: [{ header: "Название", kind: "text" }], rows: many("Задача") },
    { name: "Люди из дневника", columns: [{ header: "Имя", kind: "text" }], rows: [["Мама"]] },
  ], { title: "t", creator: "t", created: NOW });
  const { archive, queries } = service();
  await assert.rejects(archive.preview(USER.id, bytes), /больше 30000 записей/);
  assert.equal(queries.some((sql) => sql.includes("eva_notes")), false);
});

test("нормализация текста: управляющие символы, переводы строк и края — как в SQL хэша", () => {
  assert.equal(cleanText("\u00a0 текст\u0001 с\r\nкраями\r\u3000\ufeff"), "текст с\nкраями");
  assert.equal(cleanText("\r\u0002\nстрока"), "строка", "управляющий символ убирается раньше, чем склеивается \\r\\n");
  assert.equal(cleanText(`${" ".repeat(50_000)}x${" ".repeat(50_000)}`), "x");
  assert.equal(contentHash("\u00a0Текст\u3000"), contentHash("Текст"));
});

test("повторы по количеству: два одинаковых в файле при одном в базе — один новый", () => {
  const existing = new Multiset<number>();
  existing.add("аптека|200", 1);
  assert.equal(existing.take("аптека|200"), 1);
  assert.equal(existing.take("аптека|200"), undefined);
  assert.equal(existing.take("другое"), undefined);
});
