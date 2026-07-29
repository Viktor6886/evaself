import assert from "node:assert/strict";
import test from "node:test";

import {
  GraphContextService,
  shouldUseGraphContext,
} from "../dist/memory/graph-context.js";
import { GraphRepository } from "../dist/memory/graph-repository.js";

test("profile interests create nodes and belongs_to edges", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let id = 0;
  const queryable = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO memory_nodes")) {
        id += 1;
        return {
          rows: [{
            id: String(id),
            user_id: String(values[0]),
            node_type: values[1],
            canonical_key: values[2],
            title: values[3],
            status: values[6],
          }],
        };
      }
      return { rows: [] };
    },
  };
  const graph = new GraphRepository({} as never);
  await graph.syncProfile(queryable as never, 41, {
    field_key: "interests",
    field_value: null,
    field_json: ["Радиотехника", "ИИ"],
    status: "confirmed",
    confidence: "1",
    sensitivity: "normal",
    source_type: "conversation",
    source_id: "turn-1",
    source_quote: "Мне интересны радиотехника и ИИ",
  } as never);

  const interestNodes = calls.filter(
    (call) => call.sql.includes("INSERT INTO memory_nodes") && call.values[1] === "interest",
  );
  const edges = calls.filter((call) => call.sql.includes("INSERT INTO memory_edges"));
  assert.equal(interestNodes.length, 2);
  assert.equal(edges.length, 2);
  assert.ok(edges.every((call) => call.values[2] === "belongs_to"));
});

test("confirmed goal is linked to its value", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let id = 10;
  const queryable = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO memory_nodes")) {
        id += 1;
        return {
          rows: [{
            id: String(id),
            user_id: String(values[0]),
            node_type: values[1],
            canonical_key: values[2],
            title: values[3],
            status: values[6],
          }],
        };
      }
      return { rows: [] };
    },
  };
  const graph = new GraphRepository({} as never);
  await graph.syncGoal(queryable as never, {
    userId: 41,
    goal: {
      id: "7",
      title: "Запустить прототип",
      why_it_matters: "Больше самостоятельности",
      user_confirmed: true,
    },
    values: ["самостоятельность"],
  });

  assert.ok(calls.some(
    (call) => call.sql.includes("INSERT INTO memory_nodes") && call.values[1] === "goal",
  ));
  assert.ok(calls.some(
    (call) => call.sql.includes("INSERT INTO memory_nodes") && call.values[1] === "value",
  ));
  assert.ok(calls.some(
    (call) => call.sql.includes("INSERT INTO memory_edges") && call.values[2] === "aligned_with",
  ));
});

test("graph context is user-scoped, active-only and bounded to depth two", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const nodes = Array.from({ length: 20 }, (_, index) => ({
    id: index + 1,
    node_type: "goal",
    title: `Цель ${index + 1}`,
    text_content: "Описание",
    confidence: 1,
    updated_at: new Date().toISOString(),
    score: 1,
  }));
  const edges = Array.from({ length: 30 }, (_, index) => ({
    from_node_id: (index % 10) + 1,
    relation_type: "part_of",
    to_node_id: ((index + 1) % 10) + 1,
    weight: 1,
    confidence: 1,
  }));
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("WITH RECURSIVE")) return { rows: [{ nodes, edges }] };
      return { rows: [] };
    },
  };
  const graph = new GraphContextService({
    transaction: async (work: (value: typeof client) => Promise<unknown>) => await work(client),
  } as never, { enabled: true, timeoutMs: 75 });

  const result = await graph.findRelevant(41, "Проведи недельную ревизию моей цели");
  assert.equal(result.used, true);
  assert.equal(result.relevantMemory.length, 12);
  const query = calls.find((call) => call.sql.includes("WITH RECURSIVE"));
  assert.equal(query?.values[0], 41);
  assert.equal(query?.values[3], 2);
  assert.equal(query?.values[4], 12);
  assert.equal(query?.values[5], 18);
  assert.match(query?.sql ?? "", /n\.user_id = \$1/);
  assert.match(query?.sql ?? "", /n\.status = 'active'/);
  assert.match(query?.sql ?? "", /n\.sensitivity = 'normal'/);
});

test("graph timeout returns empty context and does not break the turn", async () => {
  const timeout = Object.assign(new Error("canceling statement due to statement timeout"), {
    code: "57014",
  });
  const graph = new GraphContextService({
    transaction: async () => {
      throw timeout;
    },
  } as never, { enabled: true, timeoutMs: 75 });

  const result = await graph.findRelevant(41, "Почему я снова откладываю эту цель?");
  assert.equal(result.used, true);
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.relevantMemory, []);
});

test("sensitive psychological candidate stays unconfirmed", async () => {
  const statuses: unknown[] = [];
  let id = 0;
  const queryable = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO memory_nodes")) {
        statuses.push(values[6]);
        id += 1;
        return {
          rows: [{
            id: String(id),
            user_id: "41",
            node_type: values[1],
            canonical_key: values[2],
            title: values[3],
            status: values[6],
          }],
        };
      }
      return { rows: [] };
    },
  };
  const graph = new GraphRepository({} as never);
  await graph.syncProfile(queryable as never, 41, {
    field_key: "typical_obstacles",
    field_value: null,
    field_json: ["страх оценки"],
    status: "candidate",
    confidence: "0.7",
    sensitivity: "sensitive",
    source_type: "conversation",
    source_id: "turn-2",
    source_quote: "Возможно, я боюсь оценки",
  } as never);

  assert.ok(statuses.includes("unconfirmed"));
  assert.equal(statuses.includes("active"), true); // the neutral user:self root
});

test("graph lookup is skipped for greetings, commands and simple tasks", () => {
  assert.equal(shouldUseGraphContext("Привет!"), false);
  assert.equal(shouldUseGraphContext("/balance"), false);
  assert.equal(shouldUseGraphContext("Напомни завтра позвонить"), false);
  assert.equal(shouldUseGraphContext("Почему я снова откладываю эту цель?"), true);
  assert.equal(shouldUseGraphContext("Что мне обычно помогает двигаться к результату?"), true);
});
