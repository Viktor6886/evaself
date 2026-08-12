/**
 * Memory Doctor.
 *
 * База подменена: проверяется поведение диагностики, а не SQL. Сам SQL
 * каждой проверки прогоняется на настоящей схеме в CI
 * (`scripts/ci/test-memory-doctor.mjs`) — на подготовленном наборе с
 * внесёнными дефектами, где видно и то, что проверка находит, и то,
 * что она не выдумывает.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DOCTOR_CHECKS, DOCTOR_CHECK_IDS, EXCERPT_LIMIT } from "../dist/memory/doctor/checks.js";
import { MemoryDoctorService, DEFAULT_DOCTOR_BUDGET } from "../dist/memory/doctor/service.js";

type Rows = Record<string, unknown>[];

/** Фейк базы: запросы различаются по тегу проверки в тексте запроса. */
class DoctorFakeDb {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly reports: Rows = [];
  readonly actions: Rows = [];
  readonly nodes = new Map<number, Record<string, unknown>>();
  readonly edges = new Map<number, Record<string, unknown>>();
  readonly blocks = new Map<string, Record<string, unknown>>();
  readonly recorded: Array<Record<string, unknown>> = [];
  present = new Set<string>();
  sweepRows: Rows = [];
  responses = new Map<string, Rows>();
  failing = new Set<string>();

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Rows; rowCount: number }> {
    this.calls.push({ sql, values });
    const check = /doctor:([a-z_]+)/.exec(sql)?.[1];
    if (check) {
      if (this.failing.has(check)) throw new Error("check failed");
      return this.result(this.responses.get(check) ?? []);
    }
    if (sql.includes("WITH last_report AS")) return this.result(this.sweepRows);
    if (sql.includes("to_regclass")) {
      const table = String(values[0]).replace("public.", "");
      return this.result([{ present: this.present.has(table) }]);
    }
    if (sql.includes("INSERT INTO memory_doctor_reports")) {
      if (this.reports.some((row) => row.report_key === values[1])) return this.result([]);
      const id = this.reports.length + 1;
      this.reports.push({
        id: String(id), user_id: values[0], report_key: values[1], trigger_reason: values[2],
        status: values[3], checks_version: values[4],
        sections: JSON.parse(String(values[5])), findings: JSON.parse(String(values[6])),
        budget: JSON.parse(String(values[7])),
      });
      return this.result([{ id: String(id) }]);
    }
    if (sql.includes("INSERT INTO memory_doctor_actions")) {
      const id = this.actions.length + 1;
      this.actions.push({
        id: String(id), user_id: values[0], report_id: String(values[1]), finding_id: values[2],
        check_id: values[3], action_type: values[4], node_id: values[5],
        proposal: JSON.parse(String(values[6])), status: "proposed", snapshot: null,
      });
      return this.result([{ id: String(id) }]);
    }
    if (sql.includes("FROM memory_doctor_reports")) {
      return this.result([...this.reports].reverse().slice(0, 1));
    }
    if (sql.includes("SELECT snapshot FROM memory_doctor_actions")) {
      const row = this.actions.find((item) => item.id === String(values[1]));
      return this.result(row?.snapshot ? [{ snapshot: row.snapshot }] : []);
    }
    if (sql.includes("FROM memory_doctor_actions")) {
      const byId = values[1] !== undefined && sql.includes("AND id = $2");
      return this.result(byId
        ? this.actions.filter((row) => row.id === String(values[1]))
        : this.actions.filter((row) => row.report_id === String(values[1])));
    }
    if (sql.includes("UPDATE memory_doctor_actions")) {
      const row = this.actions.find((item) => item.id === String(values[1]));
      if (!row) return this.result([]);
      const target = /SET status = '([a-z_]+)'/.exec(sql)?.[1];
      if (target === "applied") { row.status = "applied"; row.snapshot = JSON.parse(String(values[2])); }
      else if (target === "rejected") { if (row.status !== "proposed") return this.result([]); row.status = "rejected"; }
      else if (target === "rolled_back") { if (row.status !== "applied") return this.result([]); row.status = "rolled_back"; }
      return this.result([row]);
    }
    if (sql.includes("FROM memory_nodes WHERE user_id = $1 AND id = $2")) {
      const node = this.nodes.get(Number(values[1]));
      return this.result(node ? [node] : []);
    }
    if (sql.includes("UPDATE memory_edges")) {
      const edge = this.edges.get(Number(values[1]));
      if (!edge) return this.result([]);
      const previous = String(edge.status);
      edge.status = sql.includes("'archived'") ? "archived" : String(values[2]);
      return this.result([{ status: previous }]);
    }
    if (sql.includes("letta_memory_block_sync")) {
      const block = this.blocks.get(String(values[1]));
      if (!block) return this.result([]);
      const previous = String(block.status);
      block.status = sql.includes("'pending'") ? "pending" : String(values[2]);
      return this.result([{ status: previous }]);
    }
    return this.result([]);
  }

  async transaction<T>(work: (client: DoctorFakeDb) => Promise<T>): Promise<T> {
    return await work(this);
  }

  async withUserScope<T>(_scope: unknown, work: () => Promise<T>): Promise<T> {
    return await work();
  }

  async withSystemScope<T>(_label: string, work: () => Promise<T>): Promise<T> {
    return await work();
  }

  bindScopeUserId(): void {}

  private result(rows: Rows): { rows: Rows; rowCount: number } {
    return { rows, rowCount: rows.length };
  }
}

function memoryLayer(db: DoctorFakeDb, enabled = true) {
  return {
    enabled,
    versions: {
      recordFact: async (_client: unknown, input: Record<string, unknown>) => {
        db.recorded.push(input);
        return { outcome: "versioned", versionId: db.recorded.length };
      },
    },
    entities: {
      merge: async (_client: unknown, input: Record<string, unknown>) => {
        db.recorded.push({ merge: input });
        return 77;
      },
      rollbackMerge: async (_client: unknown, _userId: number, mergeId: number) => mergeId === 77,
    },
    queries: {}, dedup: {}, backfill: {},
  } as never;
}

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

function service(db: DoctorFakeDb, options: { enabled?: boolean; memory?: boolean } = {}) {
  return new MemoryDoctorService(
    db as never,
    memoryLayer(db, options.memory ?? true),
    logger,
    options.enabled ?? true,
  );
}

test("каждая проверка объявлена в списке, называет арендатора и ограничена пределом", () => {
  assert.equal(DOCTOR_CHECKS.length, DOCTOR_CHECK_IDS.length);
  for (const check of DOCTOR_CHECKS) {
    assert.ok(DOCTOR_CHECK_IDS.includes(check.id), `${check.id} вне списка`);
    assert.ok(check.sql.includes(`doctor:${check.id}`), `${check.id} без тега`);
    assert.ok(/user_id = \$1/.test(check.sql), `${check.id} без арендатора`);
    assert.ok(check.sql.includes("LIMIT $2"), `${check.id} без предела строк`);
  }
});

test("отчёт содержит раздел на каждый тип проблемы, включая пустые и неприменимые", async () => {
  const db = new DoctorFakeDb();
  // Таблица векторов в этом наборе не заведена: проверка обязана назвать
  // себя неприменимой, а не отчитаться нулём находок.
  db.responses.set("contradictions", [
    { conflict_id: 5, node_id: 12, fact_key: "city", kind: "contradiction", significance: "high" },
  ]);
  const report = await service(db).run({ userId: 1, reportKey: "k1", trigger: "admin" });

  assert.equal(report.status, "succeeded");
  assert.equal(report.sections.length, DOCTOR_CHECK_IDS.length);
  // Пустая проверка — это `checked` с нулём находок, а не отсутствие раздела.
  const empty = report.sections.find((section) => section.check === "duplicate_nodes");
  assert.deepEqual([empty?.status, empty?.findings], ["checked", 0]);
  // Проверка, чьей таблицы нет, объявляется неприменимой, а не пустой:
  // «ничего не нашли» и «нечем искать» — разные утверждения.
  const orphan = report.sections.find((section) => section.check === "orphan_embeddings");
  assert.equal(orphan?.status, "not_applicable");
  assert.match(String(orphan?.reason), /memory_embeddings/);
  assert.equal(report.findings.length, 1);
});

test("каждая находка ссылается на конкретные записи и на доказательство", async () => {
  const db = new DoctorFakeDb();
  db.responses.set("duplicate_nodes", [{
    node_type: "person", copies: 3, keep_node_id: 4, node_ids: [4, 9, 11],
    sample_title: "Сестра " + "я".repeat(400),
  }]);
  const report = await service(db).run({ userId: 1, reportKey: "k2", trigger: "user" });
  const finding = report.findings[0]!;

  assert.deepEqual(finding.subject, { kind: "node", ids: ["4", "9", "11"] });
  assert.equal(finding.evidence.copies, 3);
  // Сырой текст в отчёте только как доказательство и только урезанный.
  assert.equal(String(finding.evidence.title).length, EXCERPT_LIMIT);
  assert.equal(finding.proposal?.actionType, "merge_duplicate");
});

test("бюджет ограничивает прогон, а не молча урезает отчёт", async () => {
  const db = new DoctorFakeDb();
  const report = await service(db).run({
    userId: 1, reportKey: "k3", trigger: "scheduled", budget: { maxChecks: 2 },
  });

  assert.equal(report.status, "partial");
  const skipped = report.sections.filter((section) => section.status === "skipped");
  assert.equal(skipped.length, DOCTOR_CHECK_IDS.length - 2);
  assert.equal(skipped[0]?.reason, "budget_exhausted");
  // Предел строк доходит до самого запроса, а не остаётся обещанием.
  const call = db.calls.find((item) => item.sql.includes("doctor:duplicate_nodes"));
  assert.equal(call?.values[1], DEFAULT_DOCTOR_BUDGET.maxRowsPerCheck);
});

test("отказ одной проверки не отменяет отчёт и назван в разделе", async () => {
  const db = new DoctorFakeDb();
  db.failing.add("stale_facts");
  const report = await service(db).run({ userId: 1, reportKey: "k4", trigger: "scheduled" });

  assert.equal(report.status, "partial");
  const failed = report.sections.find((section) => section.check === "stale_facts");
  assert.equal(failed?.status, "failed");
  assert.equal(report.sections.filter((section) => section.status === "checked").length,
    DOCTOR_CHECK_IDS.length - 2);
});

test("прогон ничего не пишет в память и повторяется по тому же ключу без дублей", async () => {
  const db = new DoctorFakeDb();
  db.responses.set("privacy_mismatch", [
    { node_id: 3, node_type: "psychological_feature", sensitivity: "normal", source_type: "curator" },
  ]);
  const doctor = service(db);
  await doctor.run({ userId: 1, reportKey: "same", trigger: "admin" });
  const second = await doctor.run({ userId: 1, reportKey: "same", trigger: "admin" });

  assert.equal(db.recorded.length, 0, "диагностика не пишет память");
  assert.equal(db.reports.length, 1, "повторный прогон того же ключа не удваивает отчёт");
  assert.equal(second.reportId, null);
  assert.equal(db.actions.length, 1);
});

test("предложение применяется только явным действием и откатывается по снимку", async () => {
  const db = new DoctorFakeDb();
  db.nodes.set(3, {
    id: "3", node_type: "psychological_feature", canonical_key: "curator:x",
    title: "Догадка", text_content: null, status: "active", sensitivity: "normal",
  });
  db.responses.set("privacy_mismatch", [
    { node_id: 3, node_type: "psychological_feature", sensitivity: "normal", source_type: "curator" },
  ]);
  const doctor = service(db);
  const report = await doctor.run({ userId: 1, reportKey: "k5", trigger: "admin" });

  // После прогона предложение существует, но не применено.
  const proposals = await doctor.proposals(1, report.reportId!);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]!.status, "proposed");
  assert.equal(db.recorded.length, 0);

  // Предпросмотр показывает то же изменение и по-прежнему ничего не пишет.
  const preview = await doctor.preview(1, proposals[0]!.id);
  assert.deepEqual(preview?.diff, [{ field: "sensitivity", from: "normal", to: "sensitive" }]);
  assert.equal(db.recorded.length, 0);

  const applied = await doctor.apply(1, proposals[0]!.id, { type: "user", id: "770001" });
  assert.equal(applied.ok, true);
  assert.equal(db.recorded.length, 1);
  assert.equal(db.recorded[0]!.sensitivity, "sensitive");
  assert.equal(db.recorded[0]!.actorType, "user");

  // Повторное применение того же предложения запрещено.
  assert.equal((await doctor.apply(1, proposals[0]!.id, { type: "user", id: "770001" })).code,
    "doctor_action_not_open");

  assert.equal(await doctor.rollback(1, proposals[0]!.id), true);
  assert.equal(db.recorded.length, 2, "откат — тоже новая версия, а не правка на месте");
  assert.equal(db.recorded[1]!.sensitivity, "normal");
  assert.equal(await doctor.rollback(1, proposals[0]!.id), false, "повторный откат ничего не делает");
});

test("отклонённое предложение не меняет память", async () => {
  const db = new DoctorFakeDb();
  db.responses.set("low_confidence", [{ node_id: 8, node_type: "interest", confidence: 0.2, status: "active" }]);
  const doctor = service(db);
  const report = await doctor.run({ userId: 1, reportKey: "k6", trigger: "user" });
  const [proposal] = await doctor.proposals(1, report.reportId!);

  assert.equal(await doctor.reject(1, proposal!.id), true);
  assert.equal(db.recorded.length, 0);
  assert.equal((await doctor.apply(1, proposal!.id, { type: "admin", id: "root" })).code,
    "doctor_action_not_open");
});

test("объединение дубликатов идёт через разрешение сущностей и откатывается им же", async () => {
  const db = new DoctorFakeDb();
  db.responses.set("duplicate_nodes", [{
    node_type: "person", copies: 2, keep_node_id: 4, node_ids: [4, 9], sample_title: "Сестра",
  }]);
  const doctor = service(db);
  const report = await doctor.run({ userId: 1, reportKey: "k7", trigger: "admin" });
  const [proposal] = await doctor.proposals(1, report.reportId!);

  assert.equal((await doctor.apply(1, proposal!.id, { type: "admin", id: "root" })).ok, true);
  assert.deepEqual(
    (db.recorded[0] as { merge: Record<string, unknown> }).merge.sourceNodeId, 9,
  );
  assert.equal(await doctor.rollback(1, proposal!.id), true);
});

test("выключенный флаг даёт честный отказ, а не пустой отчёт", async () => {
  const db = new DoctorFakeDb();
  const report = await service(db, { enabled: false }).run({
    userId: 1, reportKey: "k8", trigger: "admin",
  });

  assert.equal(report.status, "failed");
  assert.equal(report.reportId, null);
  assert.ok(report.sections.every((section) => section.reason === "memory_doctor_disabled"));
  assert.equal(db.calls.length, 0);
});

test("плановый обход выбирает повод по состоянию памяти, а не по вызывающему", async () => {
  const db = new DoctorFakeDb();
  db.sweepRows = [
    { user_id: "1", trigger: "conflict_detected" },
    { user_id: "2", trigger: "memory_growth" },
    { user_id: "3", trigger: "scheduled" },
  ];
  const due = await service(db).sweep();

  assert.deepEqual(due, [
    { userId: 1, trigger: "conflict_detected" },
    { userId: 2, trigger: "memory_growth" },
    { userId: 3, trigger: "scheduled" },
  ]);
  const call = db.calls.at(-1)!;
  // Обход идёт поперёк пользователей и объявляет это, а не обходит молча.
  assert.ok(call.sql.includes("-- tenant: system"));
  // Повод выбирается в самом запросе: противоречие важнее роста объёма,
  // рост — важнее смены версии набора.
  assert.ok(call.sql.indexOf("conflict_detected") < call.sql.indexOf("memory_growth"));
  assert.ok(call.sql.indexOf("memory_growth") < call.sql.indexOf("schema_version_changed"));
});

test("намерение ставится на очередь памяти и не даёт двух диагностик одного человека", () => {
  const db = new DoctorFakeDb();
  const intent = service(db).intent({
    userId: 42, trigger: "memory_growth", reportKey: "run-1", traceId: "t-1",
  });

  assert.equal(intent.queue, "memory");
  assert.equal(intent.dedupMode, "keep_last_if_active");
  assert.equal(intent.privacy, "restricted");
  assert.equal(intent.idempotencyKey, "memory_doctor:42:run-1");
  // Ключ дедупликации по пользователю: два эпизода подряд не запускают
  // две диагностики рядом.
  assert.ok(String(intent.dedupKey).includes("42"));
});
