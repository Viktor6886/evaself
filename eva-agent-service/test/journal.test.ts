/**
 * Дневник Mini App, недельный обзор и «Спросить Еву».
 *
 * Проверяется то, что нельзя увидеть чтением кода и что легко потерять
 * при любой правке: сохранение записи не обращается к модели, вопрос при
 * обсуждении ровно один, обзор молчит при нехватке данных, а разделы
 * ответа не смешиваются. Семантика хранения — распространение удаления,
 * склейка карточек людей, срок голосовой заметки — проверяется на
 * настоящем PostgreSQL: `scripts/ci/test-journal-postgres.mjs`.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import Fastify from "fastify";

import { registerWebappCoreRoutes } from "../dist/public/webapp-core.js";
import {
  buildDiscussionRequest,
  countQuestions,
  limitQuestions,
} from "../dist/public/journal/discussion.js";
import { askEva } from "../dist/public/journal/ask.js";
import { weeklyReview, MIN_OBSERVATIONS } from "../dist/public/journal/weekly-review.js";
import { runInScope, userScope } from "../dist/tenancy/index.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyzABCDEFG";
const NOW = new Date("2026-08-14T09:00:00.000Z");
const ANNA = { id: 500_001, internalId: 41, first_name: "Анна" };
const BORIS = { id: 500_002, internalId: 42, first_name: "Анна" };

// ---------------------------------------------------------------------
// Правило одного вопроса и кризис до модели
// ---------------------------------------------------------------------

test("обсуждение записи допускает ровно один вопрос", () => {
  const request = buildDiscussionRequest({
    content: "Сегодня был тяжёлый разговор с коллегой, но я не сдался.",
    title: "Разговор",
    local_date: "2026-08-14",
    mood: "low",
  });
  assert.equal(request.question_limit, 1);
  assert.match(request.prompt, /не больше одного уточняющего вопроса/);
  assert.equal(request.crisis, null);
});

test("развёрнутый разбор снимает ограничение, но только по явной просьбе", () => {
  const plain = buildDiscussionRequest(
    { content: "Обычная запись", title: null, local_date: "2026-08-14", mood: null },
  );
  const detailed = buildDiscussionRequest(
    { content: "Обычная запись", title: null, local_date: "2026-08-14", mood: null },
    { detailed: true },
  );
  assert.equal(plain.question_limit, 1);
  assert.ok(detailed.question_limit > 1);
  assert.match(detailed.prompt, /развёрнутый разбор/);
});

test("кризис определяется до модели и не даёт цепочки вопросов", () => {
  const request = buildDiscussionRequest(
    {
      content: "не хочу жить, хочу покончить с собой",
      title: null,
      local_date: "2026-08-14",
      mood: "very_low",
    },
    { detailed: true },
  );
  assert.ok(request.crisis, "кризис должен быть найден детектором");
  // Даже развёрнутый режим не превращает поддержку в допрос.
  assert.equal(request.question_limit, 1);
  assert.ok(request.prompt.includes(request.crisis!.directive));
});

test("лишние вопросы срезаются, а утверждения остаются", () => {
  const answer = "Слышу тебя. Что ты чувствуешь? А что сказал коллега? Может, стоит отдохнуть?";
  assert.equal(countQuestions(answer), 3);
  const limited = limitQuestions(answer, 1);
  assert.equal(countQuestions(limited), 1);
  assert.match(limited, /^Слышу тебя\./);
  assert.match(limited, /Что ты чувствуешь\?$/);
});

test("ответ без лишних вопросов не переписывается", () => {
  const answer = "Записал. Что было самым трудным?";
  assert.equal(limitQuestions(answer, 1), answer);
  assert.equal(limitQuestions("Просто утверждение.", 0), "Просто утверждение.");
});

// ---------------------------------------------------------------------
// Недельный обзор: честное «данных мало»
// ---------------------------------------------------------------------

const EMPTY_WEEK = {
  period_from: "2026-08-08",
  period_to: "2026-08-14",
  entries: "1",
  entries_with_mood: "1",
  avg_journal_mood: "4.00",
  checkins: "1",
  avg_energy: "6.0",
  avg_tension: "4.0",
  high_tension_days: "0",
  completed_tasks: "0",
  completed_results: "0",
  active_goals: "0",
  people_mentions: "0",
};

const FULL_WEEK = {
  ...EMPTY_WEEK,
  entries: "6",
  entries_with_mood: "5",
  checkins: "6",
  high_tension_days: "3",
  completed_tasks: "4",
  completed_results: "2",
  active_goals: "2",
  people_mentions: "3",
};

function scriptedDb(rows: unknown[]) {
  return withTenantScopes({
    query: async () => ({ rows, rowCount: rows.length }),
  }) as never;
}

/**
 * Обзор и «Спросить Еву» вызываются здесь напрямую, минуя маршрут,
 * который обычно открывает область владельца. Без неё поддельная база
 * отвергает запрос — как и настоящая: это и есть доказательство, что
 * оба модуля работают только внутри области.
 */
async function asOwner<T>(work: () => Promise<T>): Promise<T> {
  return await runInScope(
    userScope({ userId: ANNA.internalId, telegramId: ANNA.id, label: "тест" }),
    work,
  );
}

test("обзор при нехватке наблюдений не делает вывода", async () => {
  const review = await asOwner(async () => await weeklyReview(
    scriptedDb([EMPTY_WEEK]),
    { id: ANNA.internalId, timezone: "Europe/Moscow" },
  ));
  assert.equal(review.sufficient, false);
  assert.match(review.summary, new RegExp(String(MIN_OBSERVATIONS)));
  for (const section of review.sections) {
    assert.equal(section.finding, null, `раздел ${section.key} сделал вывод на пустых данных`);
    assert.equal(section.sufficient, false);
  }
});

test("обзор с достаточными данными называет наблюдение наблюдением", async () => {
  const review = await asOwner(async () => await weeklyReview(
    scriptedDb([FULL_WEEK]),
    { id: ANNA.internalId, timezone: "Europe/Moscow" },
  ));
  assert.equal(review.sufficient, true);
  const mood = review.sections.find((section) => section.key === "mood")!;
  assert.equal(mood.sufficient, true);
  // Высокое напряжение — наблюдение, а не диагноз: формулировка входит
  // в границы персоны и меняться молча не должна.
  assert.match(mood.finding!, /наблюдение, а не диагноз/);
  assert.equal(review.totals.completed_tasks, 4);
});

test("обзор воспроизводим: те же данные — тот же текст", async () => {
  const user = { id: ANNA.internalId, timezone: "Europe/Moscow" };
  const first = await asOwner(async () => await weeklyReview(scriptedDb([FULL_WEEK]), user));
  const second = await asOwner(async () => await weeklyReview(scriptedDb([FULL_WEEK]), user));
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------
// «Спросить Еву»: источники не смешиваются
// ---------------------------------------------------------------------

/** Отдаёт строки в зависимости от того, к какой таблице обращён запрос. */
function askDb(tables: Record<string, unknown[]>) {
  return withTenantScopes({
    query: async (sql: string) => {
      const table = sql.includes("research_claim_sources") ? "research" : "records";
      const rows = tables[table] ?? [];
      return { rows, rowCount: rows.length };
    },
  }) as never;
}

const RECORD_ROW = {
  kind: "journal_entries",
  id: "11",
  title: "Пробежка",
  body: "Пробежал пять километров",
  recorded_at: "2026-08-13T06:00:00.000Z",
};

test("три источника остаются тремя разделами с доказательствами", async () => {
  const answer = await asOwner(async () => await askEva(
    askDb({ records: [RECORD_ROW], research: [] }),
    { id: ANNA.internalId, timezone: "Europe/Moscow" },
    { question: "бег" },
    {
      model: {
        conclude: async () => ({ text: "Похоже, бег стал регулярным.", confidence: 0.95 }),
      },
    },
  ));
  assert.deepEqual(
    answer.sections.map((section) => section.kind),
    ["structured_records", "external_sources", "model_conclusion"],
  );
  assert.equal(answer.sections[0]!.items[0]!.evidence[0]!.reference, "journal_entries:11");
  // Вывод модели не может быть увереннее данных, из которых собран.
  const conclusion = answer.sections[2]!.items[0]!;
  assert.ok(conclusion.confidence <= 0.7, `уверенность вывода ${conclusion.confidence}`);
  assert.ok(conclusion.evidence.length > 0, "вывод без указания, из чего он сделан");
});

test("выключенная подсистема объявляется выключенной, а не пустой", async () => {
  const answer = await asOwner(async () => await askEva(
    askDb({ records: [RECORD_ROW] }),
    { id: ANNA.internalId, timezone: "Europe/Moscow" },
    { question: "бег" },
    { externalEnabled: false },
  ));
  const external = answer.sections.find((section) => section.kind === "external_sources")!;
  assert.equal(external.available, false);
  assert.match(external.unavailable_reason!, /выключен/);
  const model = answer.sections.find((section) => section.kind === "model_conclusion")!;
  assert.equal(model.available, false, "не подключённый вывод не должен выглядеть пустым");
});

test("при кризисе вывод модели не запрашивается", async () => {
  let asked = false;
  const answer = await asOwner(async () => await askEva(
    askDb({ records: [RECORD_ROW] }),
    { id: ANNA.internalId, timezone: "Europe/Moscow" },
    { question: "не хочу жить" },
    {
      model: {
        conclude: async () => {
          asked = true;
          return { text: "…", confidence: 0.5 };
        },
      },
    },
  ));
  assert.ok(answer.crisis, "кризис должен быть распознан");
  assert.equal(asked, false, "модель не должна вызываться при кризисе");
  assert.equal(
    answer.sections.find((section) => section.kind === "model_conclusion")!.available,
    false,
  );
});

// ---------------------------------------------------------------------
// Маршруты: владелец только из подписи, флаг убирает раздел целиком
// ---------------------------------------------------------------------

function journalApp(options: { enabled: boolean }) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const owners = new Map<number, number>([
    [ANNA.id, ANNA.internalId],
    [BORIS.id, BORIS.internalId],
  ]);
  const entry = {
    id: "1",
    local_date: "2026-08-14",
    title: null,
    content: "Запись",
    mood: null,
    energy: null,
    share_state: "saved",
    shared_at: null,
    source_channel: "miniapp",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  const query = async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes("FROM users")) {
      const internalId = owners.get(Number(values[0]));
      return {
        rows: internalId ? [{ id: String(internalId), timezone: "Europe/Moscow" }] : [],
        rowCount: internalId ? 1 : 0,
      };
    }
    if (sql.includes("INSERT INTO journal_entries")) return { rows: [{ id: "1" }], rowCount: 1 };
    if (sql.includes("FROM journal_entries")) return { rows: [entry], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const app = Fastify({ logger: false });
  registerWebappCoreRoutes(app, {
    config: {
      telegramBotToken: BOT_TOKEN,
      telegramWebAppMaxAgeSeconds: 600,
      publicRateLimitPerIp: 1_000,
      publicRateLimitPerUser: 1_000,
      rateLimitWindowSeconds: 60,
      miniAppJournalEnabled: options.enabled,
      journalVoiceRetentionDays: 30,
      temporalMemoryEnabled: false,
      hybridRetrievalEnabled: false,
      researchOrchestratorEnabled: false,
    } as never,
    db: withTenantScopes({ query }) as never,
    now: () => NOW,
  });
  return { app, statements };
}

test("выключенный флаг убирает дневник, а не отдаёт пустой список", async () => {
  const { app } = journalApp({ enabled: false });
  const response = await app.inject({
    method: "GET",
    url: "/public/v2/journal",
    headers: { "x-telegram-init-data": initDataFor(ANNA) },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test("запись сохраняется без обращения к модели и на своего владельца", async () => {
  const { app, statements } = journalApp({ enabled: true });
  const response = await app.inject({
    method: "POST",
    url: "/public/v2/journal",
    headers: { "x-telegram-init-data": initDataFor(ANNA) },
    // Подставленный чужой идентификатор владельца не меняет.
    payload: { content: "Сегодня получилось", user_id: BORIS.internalId },
  });
  assert.equal(response.statusCode, 201);
  const insert = statements.find((item) => item.sql.includes("INSERT INTO journal_entries"));
  assert.ok(insert, "вставка записи не выполнялась");
  assert.equal(insert!.values[0], ANNA.internalId);
  assert.ok(!insert!.values.includes(BORIS.internalId));
  await app.close();
});

test("совпадение отображаемых имён не объединяет учётные записи", async () => {
  // У ANNA и BORIS одинаковое first_name: если бы связывание шло по
  // имени, второй пользователь писал бы в дневник первого.
  const { app, statements } = journalApp({ enabled: true });
  for (const user of [ANNA, BORIS]) {
    const response = await app.inject({
      method: "POST",
      url: "/public/v2/journal",
      headers: { "x-telegram-init-data": initDataFor(user) },
      payload: { content: "Запись" },
    });
    assert.equal(response.statusCode, 201);
  }
  const owners = statements
    .filter((item) => item.sql.includes("INSERT INTO journal_entries"))
    .map((item) => item.values[0]);
  assert.deepEqual(owners, [ANNA.internalId, BORIS.internalId]);
  await app.close();
});

test("вопрос обязателен, а внутреннее устройство наружу не уходит", async () => {
  const { app } = journalApp({ enabled: true });
  const response = await app.inject({
    method: "POST",
    url: "/public/v2/journal/ask",
    headers: { "x-telegram-init-data": initDataFor(ANNA) },
    payload: {},
  });
  assert.equal(response.statusCode, 400);
  const payload = response.json() as { error?: { message?: string }; message?: string };
  const message = String(payload.error?.message ?? payload.message ?? "");
  assert.match(message, /Вопрос/);
  assert.ok(
    !/SELECT|journal_entries|user_id/.test(message),
    "сообщение об ошибке раскрывает устройство",
  );
  await app.close();
});

function initDataFor(user: { id: number; first_name: string }): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(NOW.getTime() / 1000)),
    query_id: "AAEAAAE",
    user: JSON.stringify({ id: user.id, first_name: user.first_name }),
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}
