/**
 * Гибридный поиск, уровни контекста и Deep Recall.
 *
 * База подменена: здесь проверяется поведение — порядок фильтров,
 * слияние источников, бюджеты и решение о вызове инструмента. Сам SQL
 * (в том числе изоляция пользователей в векторном поиске) прогоняется
 * на настоящей базе в CI: `scripts/ci/test-hybrid-retrieval.mjs`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GRAPH_LIMITS, HybridRetrieval, SOURCE_WEIGHTS } from "../dist/memory/retrieval/hybrid.js";
import {
  DeepRecall,
  decideDeepRecall,
  parseAsOf,
} from "../dist/memory/retrieval/deep-recall.js";
import {
  CONTEXT_LEVELS,
  LEVEL_BUDGETS,
  fitLevel,
  overBudget,
  totalCharacters,
} from "../dist/runtime/context-levels.js";
import { MemoryEmbeddings, contentHash, vectorLiteral } from "../dist/memory/retrieval/embeddings.js";

type Rows = Record<string, unknown>[];

class RetrievalFakeDb {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly scopes: unknown[] = [];
  responses = new Map<string, Rows>();
  failing = new Set<string>();
  rows: Rows = [];

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Rows; rowCount: number }> {
    this.calls.push({ sql, values });
    const source = /retrieval:([a-z]+)/.exec(sql)?.[1];
    if (source) {
      if (this.failing.has(source)) throw new Error("source failed");
      return { rows: this.responses.get(source) ?? [], rowCount: 0 };
    }
    return { rows: this.rows, rowCount: this.rows.length };
  }

  async transaction<T>(work: (client: RetrievalFakeDb) => Promise<T>): Promise<T> {
    return await work(this);
  }

  async withUserScope<T>(scope: unknown, work: () => Promise<T>): Promise<T> {
    this.scopes.push(scope);
    return await work();
  }

  bindScopeUserId(): void {}
}

const node = (id: number, score: number, overrides: Record<string, unknown> = {}) => ({
  id: String(id), title: `узел ${id}`, text_content: null, node_type: "person",
  status: "active", sensitivity: "normal", confidence: 0.9, valid_from: null,
  observed_at: null, score, ...overrides,
});

function retrieval(db: RetrievalFakeDb, enabled = true) {
  return new HybridRetrieval(db as never, {
    enabled, model: "text-embedding-3-small", embeddingVersion: 1,
  });
}

test("каждый источник фильтрует по владельцу первым условием", async () => {
  const db = new RetrievalFakeDb();
  db.responses.set("fts", [node(1, 0.5)]);
  await retrieval(db).search({ userId: 7, text: "прага", vector: [0.1, 0.2] });

  const sources = db.calls.filter((call) => /retrieval:/.test(call.sql));
  assert.ok(sources.length >= 3, "выполнены полнотекстовый, триграммный и векторный источники");
  for (const call of sources) {
    assert.ok(/user_id = \$1/.test(call.sql), `источник без владельца: ${call.sql.slice(0, 40)}`);
    assert.equal(call.values[0], 7, "владелец подставлен первым параметром");
  }
  // Обход графа тоже проверяет владельца на каждом шаге, а не только в конце.
  const graph = db.calls.find((call) => call.sql.includes("retrieval:graph"));
  assert.equal((graph?.sql.match(/user_id = \$1/g) ?? []).length >= 2, true);
});

test("узел, найденный несколькими источниками, поднимается, а не дублируется", async () => {
  const db = new RetrievalFakeDb();
  db.responses.set("fts", [node(1, 1), node(2, 0.4)]);
  db.responses.set("trigram", [node(1, 1)]);
  const result = await retrieval(db).search({ userId: 1, text: "прага" });

  assert.equal(result.candidates.length, 2, "дубликат фрагмента убран");
  const first = result.candidates[0]!;
  assert.equal(first.nodeId, 1);
  assert.deepEqual(first.sources, ["fts", "trigram"]);
  assert.equal(first.score, SOURCE_WEIGHTS.fts * 1 + SOURCE_WEIGHTS.trigram * 1);
});

test("отказ источника — деградация, а не ошибка ответа", async () => {
  const db = new RetrievalFakeDb();
  db.responses.set("fts", [node(1, 1)]);
  db.failing.add("trigram");
  const result = await retrieval(db).search({ userId: 1, text: "прага" });

  assert.equal(result.degraded, true);
  assert.deepEqual(result.used.includes("trigram"), false);
  assert.equal(result.candidates.length, 1, "успевшие источники ответили");
});

test("обход графа ограничен глубиной, числом узлов и связей", async () => {
  const db = new RetrievalFakeDb();
  db.responses.set("fts", [node(1, 1)]);
  await retrieval(db).search({ userId: 1, text: "прага", depth: 9 });

  const graph = db.calls.find((call) => call.sql.includes("retrieval:graph"))!;
  const [, depth, edges, nodes] = graph.values.slice(-4);
  assert.equal(depth, GRAPH_LIMITS.maxDepth, "глубина обрезана максимумом, а не принята как есть");
  assert.equal(edges, GRAPH_LIMITS.maxEdges);
  assert.equal(nodes, GRAPH_LIMITS.maxNodes);
});

test("запрос «на дату» идёт по времени действительности, а не по статусу", async () => {
  const db = new RetrievalFakeDb();
  const asOf = new Date("2023-03-01T00:00:00Z");
  await retrieval(db).search({ userId: 1, text: "город", asOf });
  const fts = db.calls.find((call) => call.sql.includes("retrieval:fts"))!;

  assert.ok(fts.sql.includes("valid_from <="), "период действительности участвует в отборе");
  assert.ok(!fts.sql.includes("n.status IN"), "«на дату» не сужается текущим статусом");
  assert.ok(fts.values.includes(asOf));

  const db2 = new RetrievalFakeDb();
  await retrieval(db2).search({ userId: 1, text: "город" });
  const now = db2.calls.find((call) => call.sql.includes("retrieval:fts"))!;
  assert.ok(now.sql.includes("n.status IN"), "«сейчас» берёт живой снимок");
});

test("чувствительное не попадает в выборку без явного запроса", async () => {
  const db = new RetrievalFakeDb();
  await retrieval(db).search({ userId: 1, text: "тема" });
  assert.ok(db.calls[0]!.sql.includes("n.sensitivity = 'normal'"));

  const db2 = new RetrievalFakeDb();
  await retrieval(db2).search({ userId: 1, text: "тема", includeSensitive: true });
  assert.ok(!db2.calls[0]!.sql.includes("n.sensitivity = 'normal'"));
});

test("выключенный флаг не ходит в базу и честно объявляет деградацию", async () => {
  const db = new RetrievalFakeDb();
  const result = await retrieval(db, false).search({ userId: 1, text: "тема" });
  assert.deepEqual([result.candidates.length, result.degraded, db.calls.length], [0, true, 0]);
});

test("уровни контекста имеют свои бюджеты и измеряются фактически", () => {
  assert.deepEqual([...CONTEXT_LEVELS].sort(), Object.keys(LEVEL_BUDGETS).sort());

  const long = Array.from({ length: 200 }, (_, index) => `строка памяти ${index}`.repeat(10));
  const fitted = fitLevel("memory", long);
  assert.ok(fitted.measurement.characters <= LEVEL_BUDGETS.memory);
  assert.ok(fitted.measurement.dropped > 0, "выброшенные строки посчитаны, а не потеряны молча");
  assert.equal(fitted.lines.length + fitted.measurement.dropped, long.length);

  // Пустой уровень тоже измеряется: ноль — это измерение, а пропущенный
  // уровень означал бы «не считали».
  const empty = fitLevel("skills", []);
  assert.deepEqual(
    [empty.measurement.level, empty.measurement.characters, empty.measurement.budget],
    ["skills", 0, LEVEL_BUDGETS.skills],
  );

  const measurements = [fitted.measurement, fitLevel("knowledge", ["короткая"]).measurement];
  assert.equal(totalCharacters(measurements), measurements[0]!.characters + measurements[1]!.characters);
  assert.deepEqual(overBudget(measurements), [], "уложившиеся уровни не объявляются превышенными");
});

test("Deep Recall вызывается по вопросу о прошлом и по ссылке на время, но не на обычном сообщении", () => {
  const ordinary = decideDeepRecall({ message: "Привет, как дела", contextCandidates: 3 });
  assert.deepEqual([ordinary.needed, ordinary.reason], [false, null]);

  const past = decideDeepRecall({ message: "Помнишь, что я говорил про Прагу?", contextCandidates: 3 });
  assert.deepEqual([past.needed, past.reason], [true, "explicit_past"]);

  const dated = decideDeepRecall({ message: "Что было 12.03.2023", contextCandidates: 3 });
  assert.equal(dated.reason, "time_reference");
  assert.equal(dated.asOf?.toISOString(), "2023-03-12T00:00:00.000Z");

  const shortage = decideDeepRecall({ message: "А что с этим?", contextCandidates: 0 });
  assert.equal(shortage.reason, "context_shortage");

  assert.equal(parseAsOf("в 2021 году", new Date())?.toISOString(), "2021-01-01T00:00:00.000Z");
  assert.equal(parseAsOf("в марте 2023", new Date())?.toISOString(), "2023-03-01T00:00:00.000Z");
  // Основа месяца не ищется внутри чужого слова.
  assert.equal(parseAsOf("маленький шаг", new Date()), null);
});

test("Deep Recall укладывается в свой бюджет и не зовётся без решения", async () => {
  const db = new RetrievalFakeDb();
  db.responses.set("fts", [
    // Первый кандидат длиннее всего бюджета: он обязан быть пропущен,
    // а не оборвать выборку на себе.
    node(1, 3, { text_content: "очень длинное содержимое ".repeat(40) }),
    ...Array.from({ length: 10 }, (_, index) =>
      node(index + 2, 1, { text_content: "коротко" })),
  ]);
  const recall = new DeepRecall(retrieval(db) as never, true, {
    maxCandidates: 5, maxCharacters: 300, timeoutMs: 500,
  });

  const skipped = await recall.recall({
    userId: 1, message: "привет", decision: { needed: false, reason: null, asOf: null },
  });
  assert.deepEqual([skipped.lines.length, db.calls.length], [0, 0], "без решения инструмент не работает");

  const result = await recall.recall({
    userId: 1, message: "помнишь Прагу?",
    decision: { needed: true, reason: "explicit_past", asOf: null },
  });
  assert.ok(result.lines.length > 0, "длинный кандидат не обрывает выборку");
  assert.ok(!result.lines.some((line) => line.includes("очень длинное")));
  assert.ok(result.lines.join("").length <= 300, "бюджет знаков соблюдён");
  const call = db.calls.find((item) => item.sql.includes("retrieval:fts"))!;
  assert.equal(call.values.at(-1), 5, "бюджет кандидатов дошёл до запроса");
});

test("вектор не пересчитывается, если содержание не менялось", async () => {
  const db = new RetrievalFakeDb();
  let calls = 0;
  const client = {
    model: "m", dimension: 3,
    embed: async (texts: readonly string[]) => { calls += 1; return texts.map(() => [1, 2, 3]); },
  };
  const embeddings = new MemoryEmbeddings(db as never, client, 1);
  db.rows = [{
    subject_kind: "node", subject_id: "5", content_hash: contentHash("m", 1, "текст"),
  }];

  const outcome = await embeddings.index(1, [{ kind: "node", id: 5, text: "текст" }]);
  assert.deepEqual([outcome.indexed, outcome.skipped, calls], [0, 1, 0]);

  db.rows = [];
  const second = await embeddings.index(1, [{ kind: "node", id: 5, text: "другой" }]);
  assert.deepEqual([second.indexed, calls], [1, 1]);
});

test("смена модели открывает переиндексацию, а не переписывает таблицу", async () => {
  const db = new RetrievalFakeDb();
  const client = { model: "new", dimension: 3, embed: async () => [] };
  const embeddings = new MemoryEmbeddings(db as never, client, 2);

  db.rows = [{ id: "1" }];
  assert.equal(await embeddings.openReindex("new", 3, 2), 1);
  const insert = db.calls.at(-1)!;
  assert.ok(insert.sql.includes("memory_embedding_reindex"));
  assert.ok(insert.sql.includes("ON CONFLICT (model, target_version) DO NOTHING"));
  assert.ok(!db.calls.some((call) => /DELETE FROM memory_embeddings/.test(call.sql)),
    "старые векторы не удаляются до конца переиндексации");

  // Пока переиндексация не завершена, поиск пользуется прежней версией.
  db.rows = [];
  assert.deepEqual(await embeddings.activeVersion(), { model: "new", version: 2 });
  db.rows = [{ model: "old", target_version: 1 }];
  assert.deepEqual(await embeddings.activeVersion(), { model: "old", version: 1 });
});

test("литерал вектора не пропускает нечисловое значение", () => {
  assert.equal(vectorLiteral([1, Number.NaN, 3]), "[1,0,3]");
});
