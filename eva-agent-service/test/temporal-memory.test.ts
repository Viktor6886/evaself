import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateConfidence,
  buildEvidence,
  evidenceHash,
} from "../dist/memory/temporal/evidence.js";
import { EntityResolver, normalizeName } from "../dist/memory/temporal/entity-resolution.js";
import { MemoryDeduplicator, periodsOverlap } from "../dist/memory/temporal/dedup.js";
import { TemporalMemoryQueries } from "../dist/memory/temporal/queries.js";
import { TemporalMemoryRepository } from "../dist/memory/temporal/versions.js";
import { TemporalBackfill } from "../dist/memory/temporal/backfill.js";
import { canTransition, sourceTrust } from "../dist/memory/temporal/status.js";

import { MemoryFakeDb } from "./memory-fake-db.ts";

const USER = 41;
const OTHER_USER = 77;

function statement(id: string, excerpt: string, at: Date) {
  return {
    sourceType: "user_statement",
    sourceId: id,
    messageId: id,
    sourceAt: at,
    excerpt,
  };
}

async function seedUser(db: MemoryFakeDb) {
  db.tables.set("memory_nodes", { rows: [], sequence: 0 });
  return new TemporalMemoryRepository();
}

test("одно и то же сообщение даёт один и тот же отпечаток доказательства", () => {
  const first = evidenceHash({
    sourceType: "user_statement",
    sourceId: "msg-1",
    messageId: "msg-1",
    excerpt: "Я перешёл в другую компанию",
  });
  const second = evidenceHash({
    sourceType: "user_statement",
    sourceId: "msg-1",
    messageId: "msg-1",
    excerpt: "Я  перешёл  в другую компанию ",
  });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("вывод модели доверяется меньше прямого утверждения пользователя", () => {
  assert.ok(sourceTrust("user_statement") > sourceTrust("model_inference"));
  const inference = buildEvidence({
    sourceType: "model_inference",
    sourceId: "m-1",
    excerpt: "похоже, он выгорел",
    confidence: 0.99,
  });
  // Уверенность доказательства ограничена доверием к источнику: модель
  // не может объявить свою догадку словами человека.
  assert.ok(inference.confidence <= sourceTrust("model_inference"));
});

test("повторная обработка того же сообщения не повышает уверенность", () => {
  const one = buildEvidence(statement("msg-1", "Я работаю в Контуре", new Date("2024-01-01")));
  const again = buildEvidence(statement("msg-1", "Я работаю в Контуре", new Date("2024-06-01")));
  const different = buildEvidence(statement("msg-2", "Я всё ещё в Контуре", new Date("2024-06-01")));

  const once = aggregateConfidence([one]);
  const twice = aggregateConfidence([one, again]);
  const independent = aggregateConfidence([one, different]);

  assert.equal(twice, once);
  assert.ok(independent > once);
});

test("опровержение снижает уверенность, но не стирает поддержку", () => {
  const support = buildEvidence(statement("msg-1", "Я живу в Москве", new Date()));
  const refute = buildEvidence({
    ...statement("msg-2", "Нет, я переехал", new Date()),
    support: "refutes" as const,
  });
  const combined = aggregateConfidence([support, refute]);
  assert.ok(combined > 0);
  assert.ok(combined < aggregateConfidence([support]));
});

test("смена факта создаёт новую версию и не удаляет предыдущую", async () => {
  const db = new MemoryFakeDb();
  const repository = await seedUser(db);

  const first = await repository.recordFact(db, {
    userId: USER,
    nodeType: "profile_fact",
    canonicalKey: "profile:employer",
    title: "Место работы",
    textContent: "Контур",
    validFrom: new Date("2022-01-01"),
    evidence: [statement("msg-1", "Работаю в Контуре", new Date("2022-01-01"))],
    changeReason: "первое упоминание",
    actorType: "user",
  });
  assert.equal(first.outcome, "created");
  assert.equal(first.version, 1);

  const second = await repository.recordFact(db, {
    userId: USER,
    nodeType: "profile_fact",
    canonicalKey: "profile:employer",
    title: "Место работы",
    textContent: "Яндекс",
    validFrom: new Date("2024-03-01"),
    evidence: [statement("msg-9", "Перешёл в Яндекс", new Date("2024-03-01"))],
    changeReason: "смена работы",
    actorType: "user",
    significance: "medium",
  });
  assert.equal(second.outcome, "versioned");
  assert.equal(second.version, 2);
  assert.notEqual(second.versionId, first.versionId);

  const versions = db.rowsOf("memory_node_versions");
  assert.equal(versions.length, 2);
  const previous = versions.find((row) => Number(row.version) === 1)!;
  // Прежняя версия на месте, её значение не переписано.
  assert.equal(previous.text_content, "Контур");
  assert.equal(previous.status, "superseded");
  assert.ok(previous.valid_to);
  // Конфликт открыт, а не разрешён молча.
  assert.equal(db.rowsOf("memory_conflicts").length, 1);
  assert.equal(db.rowsOf("memory_conflicts")[0]!.status, "awaiting_user");
});

test("факт на дату, полная история и изменения за период", async () => {
  const db = new MemoryFakeDb();
  const repository = await seedUser(db);
  const queries = new TemporalMemoryQueries();

  await repository.recordFact(db, {
    userId: USER,
    nodeType: "profile_fact",
    canonicalKey: "profile:city",
    title: "Город",
    textContent: "Пермь",
    validFrom: new Date("2020-01-01"),
    evidence: [statement("msg-1", "Живу в Перми", new Date("2020-01-01"))],
    changeReason: "первое упоминание",
    actorType: "user",
  });
  await repository.recordFact(db, {
    userId: USER,
    nodeType: "profile_fact",
    canonicalKey: "profile:city",
    title: "Город",
    textContent: "Москва",
    validFrom: new Date("2023-05-01"),
    evidence: [statement("msg-2", "Переехал в Москву", new Date("2023-05-01"))],
    changeReason: "переезд",
    actorType: "user",
  });

  const inThePast = await queries.factAsOf(db, USER, "profile:city", new Date("2021-07-01"));
  assert.equal(inThePast?.textContent, "Пермь");

  const now = await queries.factAsOf(db, USER, "profile:city", new Date("2024-01-01"));
  assert.equal(now?.textContent, "Москва");

  const current = await queries.currentFact(db, USER, "profile:city");
  assert.equal(current?.textContent, "Москва");

  const history = await queries.factHistory(db, USER, "profile:city");
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((item) => item.textContent), ["Пермь", "Москва"]);
  assert.equal(history[1]!.supersedesVersionId, history[0]!.versionId);

  const changes = await queries.changesBetween(
    db, USER, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000),
  );
  assert.equal(changes.length, 2);
});

test("состояние сущности восстанавливается на выбранную дату", async () => {
  const db = new MemoryFakeDb();
  const repository = await seedUser(db);
  const queries = new TemporalMemoryQueries();

  const person = await repository.recordFact(db, {
    userId: USER,
    nodeType: "person",
    canonicalKey: "person:anna",
    title: "Анна",
    validFrom: new Date("2019-01-01"),
    evidence: [statement("msg-1", "Моя коллега Анна", new Date("2019-01-01"))],
    changeReason: "знакомство",
    actorType: "user",
  });
  const role = await repository.recordFact(db, {
    userId: USER,
    nodeType: "relationship",
    canonicalKey: "rel:anna:role",
    title: "Роль Анны",
    textContent: "коллега",
    validFrom: new Date("2019-01-01"),
    evidence: [statement("msg-2", "Анна — коллега", new Date("2019-01-01"))],
    changeReason: "знакомство",
    actorType: "user",
  });
  // Узел роли принадлежит сущности «Анна».
  db.rowsOf("memory_nodes").find((row) => String(row.id) === String(role.nodeId))!.entity_id =
    String(person.nodeId);

  await repository.recordFact(db, {
    userId: USER,
    nodeType: "relationship",
    canonicalKey: "rel:anna:role",
    title: "Роль Анны",
    textContent: "руководитель",
    validFrom: new Date("2023-01-01"),
    evidence: [statement("msg-3", "Анна стала руководителем", new Date("2023-01-01"))],
    changeReason: "повышение",
    actorType: "user",
  });

  const before = await queries.entityStateAt(db, USER, person.nodeId, new Date("2020-06-01"));
  assert.equal(before.find((item) => item.factKey === "rel:anna:role")?.textContent, "коллега");

  const after = await queries.entityStateAt(db, USER, person.nodeId, new Date("2024-06-01"));
  assert.equal(after.find((item) => item.factKey === "rel:anna:role")?.textContent, "руководитель");
});

test("тёзки не объединяются автоматически", async () => {
  const db = new MemoryFakeDb();
  db.seed("memory_nodes", {
    user_id: USER,
    node_type: "person",
    canonical_key: "person:ivanov-1",
    title: "Пётр Иванов",
    text_content: null,
    content_json: { organization: "Контур" },
    status: "active",
  });
  const resolver = new EntityResolver();

  const namesake = await resolver.resolve(db, {
    userId: USER,
    nodeType: "person",
    name: "Пётр Иванов",
    context: { organization: "Школа №5" },
  });
  assert.notEqual(namesake.decision, "matched");
  assert.equal(namesake.match, null);

  // Тот же человек: совпал различающий признак.
  const same = await resolver.resolve(db, {
    userId: USER,
    nodeType: "person",
    name: "Петр Иванов",
    context: { organization: "Контур" },
  });
  assert.equal(same.decision, "matched");
  assert.equal(same.match?.nodeId, 1);
});

test("человек и организация не объединяются, тип фильтруется", async () => {
  const db = new MemoryFakeDb();
  db.seed("memory_nodes", {
    user_id: USER,
    node_type: "artifact",
    canonical_key: "org:nikel",
    title: "Никель",
    text_content: null,
    content_json: {},
    status: "active",
  });
  const resolver = new EntityResolver();
  const result = await resolver.resolve(db, {
    userId: USER,
    nodeType: "person",
    name: "Никель",
  });
  assert.equal(result.decision, "separate");
  assert.equal(result.candidates.length, 0);
});

test("автоматическое объединение имеет аудит и откатывается", async () => {
  const db = new MemoryFakeDb();
  const source = db.seed("memory_nodes", {
    user_id: USER, node_type: "person", canonical_key: "person:a",
    title: "Саня", content_json: {}, status: "active", entity_id: null,
  });
  const target = db.seed("memory_nodes", {
    user_id: USER, node_type: "person", canonical_key: "person:b",
    title: "Александр", content_json: {}, status: "active", entity_id: null,
  });
  const resolver = new EntityResolver();

  const mergeId = await resolver.merge(db, {
    userId: USER,
    sourceNodeId: Number(source.id),
    targetNodeId: Number(target.id),
    score: 0.95,
    reason: "синоним подтверждён пользователем",
    actorType: "user",
  });

  assert.equal(db.rowsOf("memory_entity_merges").length, 1);
  assert.equal(source.entity_id, Number(target.id));
  assert.equal(source.status, "superseded");

  assert.equal(await resolver.rollbackMerge(db, USER, mergeId), true);
  assert.equal(source.entity_id, null);
  assert.equal(source.status, "active");
  // Повторный откат ничего не делает и не врёт об успехе.
  assert.equal(await resolver.rollbackMerge(db, USER, mergeId), false);
});

test("синоним находит сущность, чужой синоним — нет", async () => {
  const db = new MemoryFakeDb();
  const node = db.seed("memory_nodes", {
    user_id: USER, node_type: "person", canonical_key: "person:alex",
    title: "Александр", content_json: {}, status: "active",
  });
  db.seed("memory_nodes", {
    user_id: OTHER_USER, node_type: "person", canonical_key: "person:alex",
    title: "Александр", content_json: {}, status: "active",
  });
  const resolver = new EntityResolver();
  await resolver.addAlias(db, {
    userId: USER, nodeId: Number(node.id), nodeType: "person", alias: "Саня",
  });
  // Повтор синонима не создаёт вторую строку.
  assert.equal(
    await resolver.addAlias(db, {
      userId: USER, nodeId: Number(node.id), nodeType: "person", alias: "саня",
    }),
    false,
  );

  const mine = await resolver.resolve(db, { userId: USER, nodeType: "person", name: "Саня" });
  assert.equal(mine.candidates[0]?.nodeId, Number(node.id));

  const foreign = await resolver.resolve(db, { userId: OTHER_USER, nodeType: "person", name: "Саня" });
  assert.equal(foreign.candidates.length, 0);
});

test("дедупликация находит существующий узел, а не создаёт дубль", async () => {
  const db = new MemoryFakeDb();
  db.seed("memory_nodes", {
    user_id: USER, node_type: "interest", canonical_key: "interest:radio",
    title: "Радиотехника", text_content: "Радиотехника", content_json: {}, status: "active",
  });
  const dedup = new MemoryDeduplicator();

  const byCanonical = await dedup.findNodeDuplicate(db, {
    userId: USER, nodeType: "interest", canonicalKey: "interest:radio", title: "что угодно",
  });
  assert.equal(byCanonical?.matchedBy, "canonical");

  const byTitle = await dedup.findNodeDuplicate(db, {
    userId: USER, nodeType: "interest", canonicalKey: "interest:other", title: "радиотехника",
  });
  assert.equal(byTitle?.matchedBy, "exact_title");

  const foreign = await dedup.findNodeDuplicate(db, {
    userId: OTHER_USER, nodeType: "interest", canonicalKey: "interest:radio", title: "Радиотехника",
  });
  assert.equal(foreign, null);
});

test("связь дублируется только при пересечении периодов", async () => {
  const db = new MemoryFakeDb();
  db.seed("memory_edges", {
    user_id: USER, from_node_id: "1", relation_type: "belongs_to", to_node_id: "2",
    status: "active", valid_from: new Date("2020-01-01"), valid_to: new Date("2023-01-01"),
  });
  const dedup = new MemoryDeduplicator();

  const overlapping = await dedup.findEdgeDuplicate(db, {
    userId: USER, fromNodeId: 1, relationType: "belongs_to", toNodeId: 2,
    validFrom: new Date("2022-01-01"), validTo: null,
  });
  assert.ok(overlapping);

  const later = await dedup.findEdgeDuplicate(db, {
    userId: USER, fromNodeId: 1, relationType: "belongs_to", toNodeId: 2,
    validFrom: new Date("2025-01-01"), validTo: null,
  });
  assert.equal(later, null);

  assert.equal(
    periodsOverlap(
      { from: new Date("2020-01-01"), to: new Date("2023-01-01") },
      { from: new Date("2023-01-01"), to: null },
    ),
    false,
  );
});

test("перенос существующих данных идемпотентен и возобновляем", async () => {
  const db = new MemoryFakeDb();
  for (let index = 0; index < 5; index += 1) {
    db.seed("memory_nodes", {
      user_id: index % 2 === 0 ? USER : OTHER_USER,
      node_type: "interest",
      canonical_key: `interest:${index}`,
      title: `Интерес ${index}`,
      text_content: null,
      content_json: {},
      status: "active",
      confidence: "0.9",
      sensitivity: "normal",
      source_type: "profile",
      source_id: `field-${index}`,
      source_quote: null,
      valid_from: null,
      valid_to: null,
      created_at: new Date("2024-01-01"),
      fact_key: null,
    });
  }
  const backfill = new TemporalBackfill();

  // Обрыв: первая партия меньше набора, курсор сохранён.
  const first = await backfill.runBatch(db, { batchSize: 2 });
  assert.equal(first.migrated, 2);
  assert.equal(first.done, false);

  const rest = await backfill.runToCompletion(db, { batchSize: 2 });
  assert.equal(rest.done, true);
  assert.equal(db.rowsOf("memory_node_versions").length, 5);

  // Повторный полный прогон с нуля не создаёт вторых версий.
  db.rowsOf("memory_backfill_state").length = 0;
  const again = await backfill.runToCompletion(db, { batchSize: 10 });
  assert.equal(again.migrated, 0);
  assert.equal(again.skipped, 5);
  assert.equal(db.rowsOf("memory_node_versions").length, 5);
  assert.equal(db.rowsOf("memory_evidence").length, 5);

  // Изоляция сохранена: у каждой версии тот же владелец, что у узла.
  for (const version of db.rowsOf("memory_node_versions")) {
    const node = db.rowsOf("memory_nodes").find((row) => String(row.id) === String(version.node_id))!;
    assert.equal(version.user_id, node.user_id);
  }
});

test("опровержение открывает конфликт и не удаляет факт", async () => {
  const db = new MemoryFakeDb();
  const repository = await seedUser(db);
  const fact = await repository.recordFact(db, {
    userId: USER,
    nodeType: "profile_fact",
    canonicalKey: "profile:role",
    title: "Роль",
    textContent: "тимлид",
    evidence: [statement("msg-1", "Я тимлид", new Date())],
    changeReason: "первое упоминание",
    actorType: "user",
  });

  const refuted = await repository.refute(db, {
    userId: USER,
    nodeId: fact.nodeId,
    evidence: [statement("msg-2", "Нет, я не тимлид", new Date())],
    reason: "пользователь опроверг",
    actorType: "user",
  });

  assert.ok(refuted.conflictId > 0);
  const node = db.rowsOf("memory_nodes")[0]!;
  assert.equal(node.status, "refuted");
  // Версия и доказательства остались.
  assert.equal(db.rowsOf("memory_node_versions").length, 1);
  assert.equal(db.rowsOf("memory_evidence").length, 2);

  const conflicts = await repository.openConflicts(db, USER);
  assert.equal(conflicts.length, 1);
});

test("статусы: разрешённые переходы закрыты словарём", () => {
  assert.equal(canTransition("candidate", "active"), true);
  assert.equal(canTransition("active", "superseded"), true);
  assert.equal(canTransition("deleted", "active"), false);
  assert.equal(canTransition("forgotten", "active"), false);
});

test("нормализация имени убирает регистр, ё и пунктуацию", () => {
  assert.equal(normalizeName("Пётр  Иванов!"), "петр иванов");
  assert.equal(normalizeName("ПЕТР-ИВАНОВ"), "петр иванов");
});

test("память пользователя A не видна пользователю B", async () => {
  const db = new MemoryFakeDb();
  const repository = await seedUser(db);
  const queries = new TemporalMemoryQueries();

  await repository.recordFact(db, {
    userId: USER,
    nodeType: "profile_fact",
    canonicalKey: "profile:secret",
    title: "Факт A",
    textContent: "только для A",
    evidence: [statement("msg-1", "мой факт", new Date())],
    changeReason: "первое упоминание",
    actorType: "user",
  });

  assert.equal(await queries.currentFact(db, OTHER_USER, "profile:secret"), null);
  assert.equal((await queries.factHistory(db, OTHER_USER, "profile:secret")).length, 0);
  assert.equal((await queries.liveFacts(db, OTHER_USER)).length, 0);
  assert.equal((await queries.liveFacts(db, USER)).length, 1);
  // Ни один запрос не ушёл без предиката владельца.
  assert.deepEqual(db.unscoped, []);
});
