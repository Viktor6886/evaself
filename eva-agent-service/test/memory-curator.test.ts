import assert from "node:assert/strict";
import test from "node:test";

import {
  absorb,
  detectBoundary,
  EpisodeService,
  EpisodeTracker,
  INACTIVITY_MS,
  newEpisodeState,
} from "../dist/memory/episodes.js";
import { parseCuratorResult } from "../dist/memory/curator/schema.js";
import { curatorSpec, MemoryCuratorService } from "../dist/memory/curator/service.js";
import { MemoryUserControl } from "../dist/memory/curator/user-control.js";
import { buildTemporalMemory } from "../dist/memory/temporal/index.js";
import { TemporalMemoryQueries } from "../dist/memory/temporal/queries.js";
import { dedupKey } from "../dist/jobs/policy.js";

import { MemoryFakeDb } from "./memory-fake-db.ts";

const USER = 41;
const OTHER_USER = 77;

const LONG = "Я перехожу работать в другую компанию с марта, и это решение окончательное.";

function validCandidate(overrides: Record<string, unknown> = {}) {
  return {
    kind: "fact",
    type: "profile_fact",
    title: "Место работы",
    value: "Яндекс",
    confidence: 0.8,
    messageIds: ["msg-1"],
    privacyMode: "normal",
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// Детектор эпизодов
// ---------------------------------------------------------------------

test("короткий обмен репликами не закрывает эпизод", () => {
  let state = newEpisodeState(new Date("2024-01-01T10:00:00Z"));
  state = absorb(state, { kind: "message", text: "ок", messageId: "m1", at: new Date("2024-01-01T10:00:01Z") });
  const decision = detectBoundary(state, {
    kind: "turn_completed", at: new Date("2024-01-01T10:00:02Z"),
  });
  assert.equal(decision.closed, false);
  assert.equal(decision.worthCurating, false);
});

test("завершённый ход с содержанием закрывает эпизод", () => {
  let state = newEpisodeState(new Date("2024-01-01T10:00:00Z"));
  state = absorb(state, { kind: "message", text: LONG, messageId: "m1", at: new Date("2024-01-01T10:00:01Z") });
  state = absorb(state, { kind: "message", text: LONG, messageId: "m2", at: new Date("2024-01-01T10:00:05Z") });
  const decision = detectBoundary(state, {
    kind: "turn_completed", at: new Date("2024-01-01T10:00:06Z"),
  });
  assert.equal(decision.closed, true);
  assert.equal(decision.reason, "turn_completed");
});

test("смена темы, бездействие, явная важность и сжатие — границы эпизода", () => {
  let state = newEpisodeState(new Date("2024-01-01T10:00:00Z"));
  state = absorb(state, { kind: "message", text: LONG, messageId: "m1", at: new Date("2024-01-01T10:00:01Z") });
  state = absorb(state, { kind: "message", text: LONG, messageId: "m2", at: new Date("2024-01-01T10:00:02Z") });

  assert.equal(detectBoundary(state, {
    kind: "message",
    text: "Расскажи про велосипедные маршруты вокруг озера",
    at: new Date("2024-01-01T10:00:10Z"),
  }).reason, "topic_shift");

  assert.equal(detectBoundary(state, {
    kind: "message",
    text: LONG,
    at: new Date(state.lastMessageAt.getTime() + INACTIVITY_MS + 1),
  }).reason, "inactivity");

  const explicit = detectBoundary(newEpisodeState(new Date()), {
    kind: "explicit", text: "запомни", at: new Date(),
  });
  assert.equal(explicit.reason, "explicit_important");
  assert.equal(explicit.worthCurating, true);

  assert.equal(detectBoundary(state, {
    kind: "compaction", at: new Date("2024-01-01T10:00:11Z"),
  }).reason, "before_compaction");
});

test("детектор ничего не ждёт и не роняет ответ", async () => {
  const db = new MemoryFakeDb();
  const episodes = new EpisodeService(db as never, true);
  const closed: unknown[] = [];
  const tracker = new EpisodeTracker(episodes, async (episode) => { closed.push(episode); });

  const started = Date.now();
  for (let index = 0; index < 3; index += 1) {
    tracker.observe({
      userId: USER,
      conversationId: "conv-1",
      signal: { kind: "message", text: LONG, messageId: `m${index}`, at: new Date() },
    });
  }
  tracker.observe({
    userId: USER, conversationId: "conv-1", signal: { kind: "turn_completed", at: new Date() },
  });
  // Наблюдение синхронно: запись эпизода уходит в фон.
  assert.ok(Date.now() - started < 50);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(db.rowsOf("memory_episodes").length, 1);
  assert.equal(closed.length, 1);
});

// ---------------------------------------------------------------------
// Схема результата
// ---------------------------------------------------------------------

test("свободный текст вместо структуры — невалидный результат", () => {
  assert.equal(parseCuratorResult("Похоже, он сменил работу").ok, false);
  assert.equal(parseCuratorResult("").ok, false);
  const notObject = parseCuratorResult("[1,2,3]");
  assert.equal(notObject.ok, false);
});

test("кандидат без ссылки на сообщение отвергается", () => {
  const parsed = parseCuratorResult(JSON.stringify({
    candidates: [validCandidate({ messageIds: [] })],
  }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok === false && parsed.code, "curator_candidate_without_source");
});

test("схема проверяет вид, уверенность, даты и полноту связи", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [validCandidate({ kind: "guess" }), "curator_candidate_kind_unknown"],
    [validCandidate({ confidence: 5 }), "curator_confidence_invalid"],
    [validCandidate({ validFrom: "не дата" }), "curator_date_invalid"],
    [validCandidate({ validFrom: "2024-05-01", validTo: "2024-01-01" }), "curator_interval_invalid"],
    [validCandidate({ kind: "relation", from: "", to: "" }), "curator_relation_incomplete"],
    [validCandidate({ privacyMode: "секретно" }), "curator_privacy_unknown"],
  ];
  for (const [candidate, code] of cases) {
    const parsed = parseCuratorResult(JSON.stringify({ candidates: [candidate] }));
    assert.equal(parsed.ok, false, `ожидался отказ ${code}`);
    assert.equal(parsed.ok === false && parsed.code, code);
  }

  const good = parseCuratorResult("```json\n" + JSON.stringify({
    candidates: [validCandidate({ validFrom: "2024-03-01T00:00:00Z", needsConfirmation: true })],
    uncertain: [{ note: "не ясно, с какой даты", confidence: 0.3 }],
  }) + "\n```");
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.result.candidates.length, 1);
    assert.equal(good.result.candidates[0]!.needsConfirmation, true);
    assert.equal(good.result.uncertain.length, 1);
  }
});

test("спецификация Curator не даёт писать человеку и требует свою схему", () => {
  const spec = curatorSpec();
  assert.equal(spec.purpose, "maintenance");
  assert.ok(spec.parseResult);
  assert.equal(spec.parseResult!("не json").ok, false);
});

// ---------------------------------------------------------------------
// Прогон Curator
// ---------------------------------------------------------------------

class FakeAgentJobs {
  calls = 0;
  readonly reply: string;
  constructor(reply: string) { this.reply = reply; }
  async run(input: { spec: { parseResult?: (reply: string) => unknown } }) {
    this.calls += 1;
    const parsed = input.spec.parseResult!(this.reply) as
      { ok: boolean; proposal?: unknown; code?: string };
    if (!parsed.ok) {
      return { status: "invalid_result", usage: {}, code: parsed.code };
    }
    return { status: "succeeded", proposal: parsed.proposal, usage: {} };
  }
}

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function curatorFor(db: MemoryFakeDb, reply: string, agentJobs = new FakeAgentJobs(reply)) {
  const episodes = new EpisodeService(db as never, true);
  const memory = buildTemporalMemory(true);
  return {
    episodes,
    memory,
    agentJobs,
    service: new MemoryCuratorService(
      db as never, episodes as never, memory as never, agentJobs as never, logger as never, true,
    ),
  };
}

async function seedEpisode(db: MemoryFakeDb, userId = USER) {
  return db.seed("memory_episodes", {
    user_id: userId,
    conversation_id: "conv-1",
    episode_key: `key-${userId}`,
    status: "closed",
    boundary_reason: "turn_completed",
    privacy_mode: "normal",
    message_ids: ["msg-1"],
    summary: null,
    message_count: 2,
  });
}

test("предпросмотр ничего не записывает", async () => {
  const db = new MemoryFakeDb();
  const episode = await seedEpisode(db);
  const reply = JSON.stringify({ candidates: [validCandidate()] });
  const { service } = curatorFor(db, reply);

  const outcome = await service.run({
    runId: "run-preview",
    userId: USER,
    agentId: "agent-1",
    episodeId: Number(episode.id),
    parentConversationId: "conv-1",
    signal: new AbortController().signal,
    mode: "preview",
  });

  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.candidates.length, 1);
  assert.equal(db.rowsOf("memory_nodes").length, 0);
  assert.equal(db.rowsOf("memory_node_versions").length, 0);
  assert.equal(db.rowsOf("memory_evidence").length, 0);
  // Эпизод не забран под обработку: предпросмотр его не расходует.
  assert.equal(episode.status, "closed");
});

test("чувствительный вывод сохраняется кандидатом и не становится фактом", async () => {
  const db = new MemoryFakeDb();
  const episode = await seedEpisode(db);
  const reply = JSON.stringify({
    candidates: [validCandidate({
      title: "Состояние", value: "выгорание",
      privacyMode: "sensitive", needsConfirmation: true,
    })],
  });
  const { service } = curatorFor(db, reply);

  const outcome = await service.run({
    runId: "run-1",
    userId: USER,
    agentId: "agent-1",
    episodeId: Number(episode.id),
    parentConversationId: "conv-1",
    signal: new AbortController().signal,
  });

  assert.equal(outcome.status, "succeeded");
  const node = db.rowsOf("memory_nodes")[0]!;
  assert.equal(node.status, "candidate");
  assert.equal(node.sensitivity, "sensitive");
  assert.equal(outcome.applied.pendingConfirmation, 1);
});

test("повторная обработка эпизода не создаёт дубликатов и вторых доказательств", async () => {
  const db = new MemoryFakeDb();
  const episode = await seedEpisode(db);
  const reply = JSON.stringify({ candidates: [validCandidate()] });
  const { service, episodes } = curatorFor(db, reply);
  const run = async (runId: string) => await service.run({
    runId,
    userId: USER,
    agentId: "agent-1",
    episodeId: Number(episode.id),
    parentConversationId: "conv-1",
    signal: new AbortController().signal,
  });

  await run("run-1");
  const nodesAfterFirst = db.rowsOf("memory_nodes").length;
  const evidenceAfterFirst = db.rowsOf("memory_evidence").length;

  // Второй запуск: эпизод уже забран, работа не начинается.
  const second = await run("run-2");
  assert.equal(second.status, "skipped");
  assert.equal(db.rowsOf("memory_nodes").length, nodesAfterFirst);

  // Даже если эпизод вернуть в закрытое состояние, тот же материал не
  // добавляет ни узла, ни независимого доказательства.
  episode.status = "closed";
  void episodes;
  const third = await run("run-3");
  assert.equal(third.status, "succeeded");
  assert.equal(db.rowsOf("memory_nodes").length, nodesAfterFirst);
  assert.equal(db.rowsOf("memory_evidence").length, evidenceAfterFirst);
});

test("невалидный результат модели не попадает в память", async () => {
  const db = new MemoryFakeDb();
  const episode = await seedEpisode(db);
  const { service } = curatorFor(db, "я подумал и решил, что он программист");

  const outcome = await service.run({
    runId: "run-bad",
    userId: USER,
    agentId: "agent-1",
    episodeId: Number(episode.id),
    parentConversationId: "conv-1",
    signal: new AbortController().signal,
  });

  assert.equal(outcome.status, "invalid_result");
  assert.equal(db.rowsOf("memory_nodes").length, 0);
  assert.equal(episode.status, "failed");
});

test("параллельные задания одного пользователя не запускаются", () => {
  const forEpisodeOne = dedupKey({
    queue: "memory", type: "memory_curator", mode: "keep_last_if_active", userId: USER,
  });
  const forEpisodeTwo = dedupKey({
    queue: "memory", type: "memory_curator", mode: "keep_last_if_active", userId: USER,
  });
  const forOtherUser = dedupKey({
    queue: "memory", type: "memory_curator", mode: "keep_last_if_active", userId: OTHER_USER,
  });
  // Один ключ у человека — второе задание заменяет ожидающее, а не идёт
  // рядом. У другого человека ключ свой: его работа не теряется.
  assert.equal(forEpisodeOne, forEpisodeTwo);
  assert.notEqual(forEpisodeOne, forOtherUser);
});

// ---------------------------------------------------------------------
// Контроль памяти пользователем
// ---------------------------------------------------------------------

async function seedFact(db: MemoryFakeDb, userId = USER) {
  const memory = buildTemporalMemory(true);
  const fact = await memory.versions.recordFact(db as never, {
    userId,
    nodeType: "profile_fact",
    canonicalKey: "profile:employer",
    title: "Место работы",
    textContent: "Контур",
    status: "candidate",
    evidence: [{
      sourceType: "curator", sourceId: "episode:1", messageId: "msg-1",
      excerpt: "работаю в Контуре", confidence: 0.7,
    }],
    changeReason: "curator",
    actorType: "curator",
  });
  return { memory, fact };
}

test("подтверждение кандидата делает его фактом", async () => {
  const db = new MemoryFakeDb();
  const { memory, fact } = await seedFact(db);
  const control = new MemoryUserControl(db as never, memory as never);

  assert.equal(await control.confirm(USER, fact.nodeId), true);
  assert.equal(db.rowsOf("memory_nodes")[0]!.status, "active");
  // Подтверждение — прямое утверждение человека, оно записано
  // доказательством.
  assert.ok(db.rowsOf("memory_evidence").some((row) => row.source_type === "user_confirmation"));

  // Чужой факт подтвердить нельзя.
  assert.equal(await control.confirm(OTHER_USER, fact.nodeId), false);
});

test("исправление создаёт новую версию, а не переписывает прежнюю", async () => {
  const db = new MemoryFakeDb();
  const { memory, fact } = await seedFact(db);
  const control = new MemoryUserControl(db as never, memory as never);
  const queries = new TemporalMemoryQueries();

  const corrected = await control.correct({
    userId: USER, nodeId: fact.nodeId, value: "Яндекс",
  });
  assert.equal(corrected?.version, 2);

  const history = await queries.factHistory(db as never, USER, "profile:employer");
  assert.equal(history.length, 2);
  assert.equal(history[0]!.textContent, "Контур");
  assert.equal(history[1]!.textContent, "Яндекс");
  assert.equal(history[1]!.actorType, "user");
  assert.equal(history[1]!.status, "active");
});

test("удаление очищает версии, доказательства и производные", async () => {
  const db = new MemoryFakeDb();
  const { memory, fact } = await seedFact(db);
  const control = new MemoryUserControl(db as never, memory as never);
  db.seed("memory_entity_aliases", {
    user_id: USER, node_id: String(fact.nodeId), node_type: "profile_fact",
    alias: "работа", normalized_alias: "работа", alias_kind: "synonym",
  });

  const removed = await control.remove(USER, fact.nodeId);
  assert.ok(removed);
  assert.ok(removed!.versions >= 1);
  assert.equal(db.rowsOf("memory_node_versions").length, 0);
  assert.equal(db.rowsOf("memory_evidence").length, 0);
  assert.equal(db.rowsOf("memory_entity_aliases").length, 0);
  assert.equal(db.rowsOf("memory_conflicts").length, 0);
  // Снимок остаётся надгробием: повторное извлечение того же сообщения
  // не воскрешает факт молча.
  assert.equal(db.rowsOf("memory_nodes")[0]!.status, "deleted");

  // Чужое удалить нельзя.
  assert.equal(await control.remove(OTHER_USER, fact.nodeId), null);
});

test("удалённый факт не воскресает и не роняет остальной эпизод", async () => {
  const db = new MemoryFakeDb();
  const first = db.seed("memory_episodes", {
    user_id: USER, conversation_id: "conv-1", episode_key: "key-1", status: "closed",
    boundary_reason: "turn_completed", privacy_mode: "normal",
    message_ids: ["msg-1"], summary: null, message_count: 2,
  });
  const reply = JSON.stringify({ candidates: [validCandidate()] });
  const { service, memory } = curatorFor(db, reply);
  const run = async (runId: string, episodeId: number, service_: typeof service) =>
    await service_.run({
      runId, userId: USER, agentId: "agent-1", episodeId,
      parentConversationId: "conv-1", signal: new AbortController().signal,
    });

  await run("run-1", Number(first.id), service);
  const created = db.rowsOf("memory_nodes")[0]!;

  // Человек удалил этот факт: снимок остался надгробием.
  const control = new MemoryUserControl(db as never, memory as never);
  await control.remove(USER, Number(created.id));
  assert.equal(created.status, "deleted");

  // Новый эпизод предлагает тот же факт и ещё один.
  const second = db.seed("memory_episodes", {
    user_id: USER, conversation_id: "conv-1", episode_key: "key-2", status: "closed",
    boundary_reason: "turn_completed", privacy_mode: "normal",
    message_ids: ["msg-2"], summary: null, message_count: 2,
  });
  const repeated = JSON.stringify({
    candidates: [
      validCandidate(),
      validCandidate({ title: "Любимый спорт", value: "бег", messageIds: ["msg-2"] }),
    ],
  });
  const again = curatorFor(db, repeated);

  const outcome = await run("run-2", Number(second.id), again.service);
  assert.equal(outcome.status, "succeeded");
  // Удалённый пропущен, соседний записан: один негодный кандидат не
  // отменяет весь эпизод.
  assert.equal(outcome.applied.skipped, 1);
  assert.equal(outcome.applied.created, 1);
  assert.equal(created.status, "deleted");
  // На надгробие не легло ни одного нового доказательства.
  assert.equal(
    db.rowsOf("memory_evidence").filter((row) => String(row.node_id) === String(created.id)).length,
    0,
  );
});

test("память пользователя A не видна пользователю B через контроль", async () => {
  const db = new MemoryFakeDb();
  const { memory } = await seedFact(db, USER);
  await seedFact(db, OTHER_USER);
  const control = new MemoryUserControl(db as never, memory as never);

  const mine = await control.list(USER);
  const theirs = await control.list(OTHER_USER);
  assert.equal(mine.length, 1);
  assert.equal(theirs.length, 1);
  assert.notEqual(mine[0]!.id, theirs[0]!.id);
  assert.deepEqual(db.unscoped, []);
});
