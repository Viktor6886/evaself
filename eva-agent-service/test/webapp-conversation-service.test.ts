import assert from "node:assert/strict";
import { test } from "node:test";

import { ConversationService } from "../dist/public/conversation-service.js";

class FakeClient {
  released = false;
  snapshot?: Map<string, any>;
  activeSnapshot?: string;
  readonly db: FakeDb;
  constructor(db: FakeDb) { this.db = db; }
  async query(sql: string, values: unknown[] = []) {
    this.db.sql.push(sql);
    if (sql === "BEGIN") { this.snapshot = new Map([...this.db.rows].map(([id, row]) => [id, { ...row }])); this.activeSnapshot = this.db.active; return { rows: [] }; }
    if (sql === "COMMIT" && this.db.failCommit && !this.db.commitFailed) {
      this.db.commitFailed = true;
      if (!this.db.persistBeforeCommitError) { this.db.rows = this.snapshot!; this.db.active = this.activeSnapshot!; }
      throw new Error("commit failed");
    }
    if (sql === "ROLLBACK") { if (this.snapshot) this.db.rows = this.snapshot; return { rows: [] }; }
    if (sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM users u") && sql.includes("FOR UPDATE OF a")) {
      return { rows: this.db.link ? [{ user_id: 7, agent_id: "agent-1", active_conversation_id: this.db.active }] : [] };
    }
    if (sql.includes("FROM agent_conversations") && sql.includes("FOR UPDATE")) {
      const id = String(values[2]);
      const row = this.db.rows.get(id);
      return { rows: row && row.user_id === values[0] && row.agent_id === values[1] && row.status === "active" ? [{ ...row, id }] : [] };
    }
    if (sql.includes("canonical conversation status")) {
      if (this.db.failReconciliation) throw new Error("verification failed");
      const row = this.db.rows.get(String(values[2]));
      return { rows: row && row.user_id === values[0] && row.agent_id === values[1] ? [{ status: row.status }] : [] };
    }
    if (sql.includes("canonical active conversation after ambiguous COMMIT")) {
      if (this.db.failReconciliation) throw new Error("verification failed");
      if (this.db.missingReconciliationLink) return { rows: [] };
      return { rows: [{ active_conversation_id: this.db.active }] };
    }
    if (sql.includes("INSERT INTO agent_conversations")) {
      if (this.db.failInsert) throw new Error("insert failed");
      const id = String(values[2]);
      this.db.rows.set(id, { user_id: values[0], agent_id: values[1], title: values[3], status: "active" });
      return { rows: [] };
    }
    if (sql.includes("UPDATE agent_links")) { this.db.active = String(values[2]); return { rows: [] }; }
    if (sql.includes("SET status = 'archived'")) { this.db.rows.get(String(values[2]))!.status = "archived"; return { rows: [] }; }
    if (sql.includes("SELECT conversation_id AS id")) return { rows: [...this.db.rows].filter(([, r]) => r.user_id === values[0] && r.agent_id === values[1] && r.status === "active").map(([id, r]) => ({ id, title: r.title, active: id === this.db.active })) };
    throw new Error(`unexpected SQL: ${sql}`);
  }
  release() { this.released = true; }
}
class FakeDb {
  active = "conv-active";
  link = true;
  failInsert = false;
  failCommit = false;
  commitFailed = false;
  persistBeforeCommitError = false;
  failReconciliation = false;
  missingReconciliationLink = false;
  clients = 0;
  sql: string[] = [];
  rows = new Map<string, any>([["conv-active", { user_id: 7, agent_id: "agent-1", title: "Active", status: "active" }], ["conv-other", { user_id: 7, agent_id: "agent-1", title: "Other", status: "active" }], ["conv-foreign", { user_id: 8, agent_id: "agent-2", title: "Foreign", status: "active" }], ["conv-archived", { user_id: 7, agent_id: "agent-1", title: "Old", status: "archived" }]]);
  async transactionClient() { this.clients += 1; return new FakeClient(this); }
}
function fixture(failAudit = false) {
  const db = new FakeDb();
  const calls: string[] = [];
  const letta = {
    async createConversationRecord() { calls.push("create"); return { id: "conv-new" }; },
    async updateConversation(id: string, patch: object) { calls.push(`${id}:${JSON.stringify(patch)}`); return {}; },
  };
  const guard = { async assertConversationDeletable(id: string) { calls.push(`guard:${id}`); } };
  const audits: any[] = [];
  return { db, calls, audits, service: new ConversationService(db as never, letta as never, guard as never, async (event: any) => {
    if (failAudit) throw new Error("audit failed");
    audits.push(event);
  }) };
}

test("tenant ownership is checked before Letta mutation", async () => {
  const { service, calls } = fixture();
  await assert.rejects(() => service.activate(101, "conv-foreign"), (e: any) => e.statusCode === 404);
  assert.deepEqual(calls, []);
});

test("active conversation cannot be archived and guard runs before Letta", async () => {
  const { service, calls } = fixture();
  await assert.rejects(() => service.archive(101, "conv-active"), (e: any) => e.statusCode === 409);
  assert.deepEqual(calls, []);
});

test("archived conversation cannot be activated", async () => {
  const { service, calls } = fixture();
  await assert.rejects(() => service.activate(101, "conv-archived"), (e: any) => e.statusCode === 404);
  assert.deepEqual(calls, []);
});

test("creation stays inactive and archives Letta object when DB insert fails", async () => {
  const { service, db, calls } = fixture(); db.failInsert = true;
  await assert.rejects(() => service.create(101, "Project"), /insert failed/);
  assert.deepEqual(calls, ["create", 'conv-new:{"archived":true}']);
  assert.equal(db.active, "conv-active");
});

test("creation compensates a rejected COMMIT with no persistence", async () => {
  const { service, db, calls } = fixture(); db.failCommit = true;
  await assert.rejects(() => service.create(101, "Project"), /commit failed/);
  assert.deepEqual(calls, ["create", 'conv-new:{"archived":true}']);
  assert.equal(db.clients, 2);
});

test("creation proceeds to audit when fresh reconciliation finds active row", async () => {
  const { service, db, calls, audits } = fixture(); db.failCommit = true; db.persistBeforeCommitError = true;
  assert.equal((await service.create(101, "Project")).id, "conv-new");
  assert.deepEqual(calls, ["create"]);
  assert.deepEqual(audits.map((x) => x.action), ["conversation.create"]);
});

test("archive compensates a rejected COMMIT with no persistence", async () => {
  const { service, db, calls } = fixture(); db.failCommit = true;
  await assert.rejects(() => service.archive(101, "conv-other"), /commit failed/);
  assert.deepEqual(calls, ["guard:conv-other", 'conv-other:{"archived":true}', 'conv-other:{"archived":false}']);
});

test("archive proceeds to audit when fresh reconciliation finds archived row", async () => {
  const { service, db, calls, audits } = fixture(); db.failCommit = true; db.persistBeforeCommitError = true;
  assert.deepEqual(await service.archive(101, "conv-other"), { id: "conv-other", archived: true });
  assert.deepEqual(calls, ["guard:conv-other", 'conv-other:{"archived":true}']);
  assert.deepEqual(audits.map((x) => x.action), ["conversation.archive"]);
});

test("activation proceeds to audit when fresh reconciliation finds target active", async () => {
  const { service, db, audits } = fixture(); db.failCommit = true; db.persistBeforeCommitError = true;
  assert.equal((await service.activate(101, "conv-other")).active, true);
  assert.equal(db.active, "conv-other");
  assert.deepEqual(audits.map((x) => x.action), ["conversation.activate"]);
});

test("activation rejects original COMMIT error when fresh reconciliation finds previous active", async () => {
  const { service, db, audits } = fixture(); db.failCommit = true;
  await assert.rejects(() => service.activate(101, "conv-other"), /commit failed/);
  assert.equal(db.active, "conv-active");
  assert.deepEqual(audits, []);
});

test("activation fails closed when fresh reconciliation query fails", async () => {
  const { service, db, audits } = fixture(); db.failCommit = true; db.failReconciliation = true;
  await assert.rejects(() => service.activate(101, "conv-other"), (e: any) => e instanceof AggregateError && /recovery/i.test(e.message));
  assert.deepEqual(audits, []);
});

test("activation fails closed when fresh reconciliation cannot establish canonical link", async () => {
  const { service, db, audits } = fixture(); db.failCommit = true; db.missingReconciliationLink = true;
  await assert.rejects(() => service.activate(101, "conv-other"), (e: any) => e instanceof AggregateError && /recovery/i.test(e.message));
  assert.deepEqual(audits, []);
});

test("failed fresh reconciliation fails closed without compensation", async () => {
  const { service, db, calls } = fixture(); db.failCommit = true; db.failReconciliation = true;
  await assert.rejects(() => service.create(101, "Project"), (e: any) => e instanceof AggregateError && /recovery/i.test(e.message));
  assert.deepEqual(calls, ["create"]);
});

test("audit failure rejects after commit without compensating committed Letta mutation", async () => {
  const { service, calls, db } = fixture(true);
  await assert.rejects(() => service.create(101, "Project"), /audit failed/);
  assert.deepEqual(calls, ["create"]);
  assert.equal(db.sql.filter((sql) => sql === "COMMIT").length, 1);
});

test("archive failure leaves DB unchanged", async () => {
  const { db, service, calls } = fixture();
  (service as any).letta.updateConversation = async () => { calls.push("archive-fail"); throw new Error("Letta down"); };
  await assert.rejects(() => service.archive(101, "conv-other"), /Letta down/);
  assert.equal(db.rows.get("conv-other").status, "active");
});

test("lifecycle uses advisory transaction lock, preserves inactive rows and audits", async () => {
  const { service, db, calls, audits } = fixture();
  const created = await service.create(101, "Project");
  assert.equal(created.active, false);
  await service.activate(101, "conv-other");
  await service.archive(101, "conv-active");
  assert.ok(db.sql.some((sql) => sql.includes("pg_advisory_xact_lock")));
  assert.equal(db.rows.get("conv-new").status, "active");
  assert.equal(db.rows.get("conv-active").status, "archived");
  assert.deepEqual(calls.slice(-2), ["guard:conv-active", 'conv-active:{"archived":true}']);
  assert.deepEqual(audits.map((x) => x.action), ["conversation.create", "conversation.activate", "conversation.archive"]);
});

test("strict conversation IDs reject path-like input", async () => {
  const { service } = fixture();
  await assert.rejects(() => service.activate(101, "../foreign"), (e: any) => e.statusCode === 400);
});
