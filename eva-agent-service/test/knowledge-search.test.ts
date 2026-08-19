import assert from "node:assert/strict";
import test from "node:test";

import { KnowledgeSearch } from "../dist/knowledge/search.js";
import { CoreToolFactory } from "../dist/tools/core-tools.js";

/** Тот же договор сборки инструмента, что и у Agent SDK, но без него. */
const tool = (
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  execute: (args: Record<string, unknown>, runtime: unknown) => Promise<unknown>,
) => ({
  name, label, description, parameters,
  execute: async (_callId: string, args: Record<string, unknown>, runtime: unknown) =>
    ({ details: await execute(args, runtime) }),
});

/** Поддельная база: запоминает запрос и отдаёт заданные строки. */
function fakeDb(rows: Array<Record<string, unknown>>) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const scopes: unknown[] = [];
  return {
    queries,
    scopes,
    withUserScope: async <T>(scope: unknown, work: () => Promise<T>) => {
      scopes.push(scope);
      return await work();
    },
    query: async (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      return { rows };
    },
  };
}

const ROW = {
  document_id: "doc-1", document_name: "Договор.pdf", ordinal: 3,
  content: "Аренда продлена до марта", score: "0.03", matched: "both",
};

test("поиск идёт и словами, и вектором, и только в области человека", async () => {
  const db = fakeDb([ROW]);
  const search = new KnowledgeSearch(db as never, async () => new Array(1_536).fill(0.1));
  const found = await search.search(77, "что там про аренду", { limit: 4 });

  assert.deepEqual(found.hits, [{
    documentId: "doc-1", documentName: "Договор.pdf", ordinal: 3,
    content: "Аренда продлена до марта", score: 0.03, matched: "both",
  }]);
  assert.equal(found.degraded, false);

  const { sql, values } = db.queries[0]!;
  // Обе половины поиска на месте, и они сливаются одним рангом.
  assert.match(sql, /websearch_to_tsquery/);
  assert.match(sql, /embedding <=>/);
  assert.match(sql, /FULL OUTER JOIN/);
  // Граница арендатора: свои фрагменты и общие продуктовые, ничьи больше.
  assert.match(sql, /c\.user_id = \$1 OR c\.product_verified/);
  assert.equal(values[0], 77);
  assert.equal(values[2], 4);
  assert.equal(String(values[3]).startsWith("["), true, "вектор запроса не передан");
  assert.deepEqual(db.scopes[0], { userId: 77, label: "knowledge.search", inherit: true });
});

test("без эмбеддингов поиск не врёт, а честно объявляет себя урезанным", async () => {
  const db = fakeDb([ROW]);
  const search = new KnowledgeSearch(db as never, async () => { throw new Error("router down"); });
  const found = await search.search(77, "аренда");

  assert.equal(found.degraded, true);
  assert.equal(db.queries[0]?.values[3], null, "вектор всё-таки ушёл в запрос");
  assert.equal(found.hits.length, 1);
});

test("пустой запрос не ходит в базу", async () => {
  const db = fakeDb([]);
  const found = await new KnowledgeSearch(db as never).search(77, "   ");
  assert.deepEqual(found, { hits: [], degraded: false });
  assert.deepEqual(db.queries, []);
});

test("инструмент поиска зарегистрирован и отдаёт фрагменты", async () => {
  const db = fakeDb([ROW]);
  const factory = new CoreToolFactory(
    { routerUrl: "", routerApiKey: "" } as never,
    db as never,
    {} as never,
    new KnowledgeSearch(db as never),
  );
  const tools = new Map(factory.build(tool as never).map((entry) => [entry.name, entry]));
  assert.ok(tools.has("knowledge_search"), "инструмент не зарегистрирован");

  const runtime = { userId: 77, telegramId: 42, chatId: 42, conversationId: "c", purpose: "chat" };
  const result = await tools.get("knowledge_search")!.execute("call-1", { query: "аренда" }, runtime as never);
  const details = result.details as { results: Array<{ document: string; content: string }> };
  assert.equal(details.results[0]?.document, "Договор.pdf");
  assert.match(details.results[0]?.content ?? "", /Аренда продлена/);
});
