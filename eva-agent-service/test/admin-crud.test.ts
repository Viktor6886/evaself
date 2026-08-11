/**
 * Полный административный CRUD: роли, подтверждения, аудит, откат и
 * честность ответов.
 *
 * Что здесь НЕ проверяется и не притворяется проверенным: поведение
 * настоящего PostgreSQL. Поддельная база повторяет правила выборки, но не
 * ограничения схемы — CHECK на исходы применения и каскады проверяются
 * миграцией на живой базе в CI.
 *
 * Здесь — то, что решает код: кому доступен маршрут, что происходит без
 * подтверждения, попадает ли действие в аудит, что именно уходит в ответ и
 * чего в ответе быть не должно.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAdminServer } from "../dist/admin/server.js";
import { AgentDirectoryService } from "../dist/admin/agent-directory.js";
import { ConversationToolSelectorService } from "../dist/admin/conversation-tool-selectors.js";
import { MemoryTemplateService } from "../dist/admin/memory-template-service.js";
import { ToolApprovalService } from "../dist/admin/tool-approvals.js";
import { ToolGatewayStateStore, ToolManifestRegistry } from "../dist/tools/gateway.js";
import { AgentToolFactory, createCanonicalToolManifestRegistry } from "../dist/agent-tools.js";
import { TurnOperationsService } from "../dist/admin/turn-operations.js";
import { SUBSYSTEM_SECTIONS, subsystemPayload } from "../dist/admin/subsystem-status.js";
import { DeleteGuard } from "../dist/letta/delete-guard.js";
import { DisabledAdminPlane } from "../dist/letta/admin-client.js";
import { MemoryBlockSync, blockChecksum } from "../dist/letta/memory-block-sync.js";

// ---------------------------------------------------------------------
// Поддельная база: повторяет правила выборки, не ограничения схемы
// ---------------------------------------------------------------------

const PERSONA = "Ева — спокойный собеседник";

interface FakeRow {
  [key: string]: unknown;
}

class FakeDb {
  agents: FakeRow[] = [
    { agent_id: "agent-1", user_id: 11, status: "active", kind: "eva", agent_name: "Ева",
      model: "m", embedding_model: "e", message_count: 4, last_message_at: "2026-08-01" },
    { agent_id: "agent-2", user_id: 22, status: "active", kind: "eva", agent_name: "Ева",
      model: "m", embedding_model: "e", message_count: 7, last_message_at: "2026-08-02" },
    { agent_id: "agent-3", user_id: 33, status: "archived", kind: "eva", agent_name: "Ева",
      model: "m", embedding_model: "e", message_count: 0, last_message_at: null },
  ];

  conversations: FakeRow[] = [
    { conversation_id: "conv-1", agent_id: "agent-1", user_id: 11, title: "Разговор",
      status: "active", message_count: 3, started_at: "2026-08-01", last_message_at: "2026-08-01",
      archived_at: null, purpose: "chat" },
  ];

  blocks: FakeRow[] = [
    { agent_id: "agent-1", label: "persona", desired_value: PERSONA, status: "synced",
      attempts: 1, last_error: null },
  ];

  applications: FakeRow[] = [];
  items: FakeRow[] = [];
  turns: FakeRow[] = [];
  outbox: FakeRow[] = [];
  effects: FakeRow[] = [];
  transitions: FakeRow[] = [];
  /** Всё, что ушло в базу: по нему видно, писал ли предпросмотр. */
  written: string[] = [];

  private seq = 0;

  query = async (sql: string, values: unknown[] = []) => {
    const text = sql.replace(/--[^\n]*\n/g, " ").replace(/\s+/g, " ").trim();

    if (text.startsWith("SELECT agent_id, user_id, status FROM agent_links")) {
      const all = values[0] === true;
      const wanted = (values[1] ?? []) as string[];
      const rows = this.agents.filter((row) => all || wanted.includes(String(row.agent_id)));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT agent_id, label, left(")) {
      const wanted = (values[0] ?? []) as string[];
      const rows = this.blocks
        .filter((row) => wanted.includes(String(row.agent_id)))
        .map((row) => ({
          agent_id: row.agent_id,
          label: row.label,
          checksum: blockChecksum(String(row.desired_value)),
        }));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("INSERT INTO memory_template_applications")) {
      this.written.push("application");
      this.seq += 1;
      const row: FakeRow = {
        id: this.seq,
        artifact_id: values[0],
        version_id: values[1],
        scope: values[2],
        targets: values[3],
        excluded: values[4],
        dry_run: values[5],
        status: values[6],
        counts: JSON.parse(String(values[7])),
        reverts_id: values[8],
        reason: values[9],
        created_at: "2026-08-11T00:00:00Z",
      };
      this.applications.push(row);
      return { rows: [{ id: row.id, created_at: row.created_at }], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO memory_template_application_items")) {
      this.written.push("item");
      this.items.push({
        application_id: values[0],
        user_id: values[1],
        agent_id: values[2],
        label: values[3],
        previous_checksum: values[4],
        next_checksum: values[5],
        outcome: values[6],
        detail: values[7],
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO letta_memory_block_sync")) {
      this.written.push("sync");
      const [userId, agentId, label, desired] = values as [number, string, string, string];
      const existing = this.blocks.find(
        (row) => row.agent_id === agentId && row.label === label,
      );
      if (existing) existing.desired_value = desired;
      else {
        this.blocks.push({
          agent_id: agentId, user_id: userId, label, desired_value: desired,
          status: "pending", attempts: 0, last_error: null,
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("SELECT a.id, a.artifact_id, a.version_id")) {
      const rows = this.applications
        .filter((row) => text.includes("WHERE a.id = $1") ? row.id === values[0] : true)
        .map((row) => ({ ...row, version: row.version_id }));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT agent_id, user_id, label, previous_checksum")) {
      const rows = this.items.filter((row) => row.application_id === values[0]);
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT l.agent_id, l.user_id, l.kind")) {
      const rows = this.agents.map((row) => ({
        ...row,
        conversations: this.conversations.filter((c) => c.agent_id === row.agent_id).length,
        active_turns: this.turns.filter(
          (t) => t.agent_id === row.agent_id && t.finished_at === null,
        ).length,
        total: this.agents.length,
      }));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT c.conversation_id")) {
      const rows = this.conversations.map((row) => ({ ...row, total: this.conversations.length }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("SET current_task_tools = $2")) {
      const row = this.conversations.find((item) => item.conversation_id === values[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.current_task_tools = values[1];
      row.selected_skill_tools = values[2];
      return { rows: [row], rowCount: 1 };
    }
    if (text.startsWith("UPDATE agent_conversations")) {
      const row = this.conversations.find((item) => item.conversation_id === values[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = values[1];
      row.archived_at = values[1] === "archived" ? "2026-08-11" : null;
      return { rows: [row], rowCount: 1 };
    }
    if (text.startsWith("SELECT label, status, attempts, last_error")) {
      const rows = this.blocks
        .filter((row) => row.agent_id === values[0])
        .map((row) => ({
          label: row.label, status: row.status, attempts: row.attempts,
          last_error: row.last_error, checksum: blockChecksum(String(row.desired_value)),
        }));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT run_id, state, conversation_id FROM turn_runs")) {
      const rows = this.turns.filter(
        (row) => row[String(text.includes("agent_id =") ? "agent_id" : "conversation_id")]
          === values[0] && row.finished_at === null,
      );
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT id, user_id, status, sent_at, attempts FROM telegram_outbox")) {
      const rows = this.outbox.filter((row) => row.id === values[0]);
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("UPDATE telegram_outbox")) {
      const row = this.outbox.find(
        (item) => item.id === values[0] && item.sent_at === null
          && ["dead", "retry"].includes(String(item.status)),
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.status = "pending";
      return { rows: [row], rowCount: 1 };
    }
    if (text.startsWith("UPDATE turn_runs")) {
      const row = this.turns.find(
        (item) => item.run_id === values[0] && item.finished_at === null,
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.cancel_requested_at = "2026-08-11";
      row.cancel_reason = values[1];
      return { rows: [row], rowCount: 1 };
    }
    if (text.startsWith("SELECT tool_name,")) {
      return { rows: [{ tool_name: "save_task", calls: 3, failed: 1, running: 0 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
}

/** Реестр артефактов, суженный до того, что нужно шаблонам. */
function fakeRegistry(versions: Record<number, unknown>) {
  return {
    list: async () => [{
      id: 1, kind: "memory_block_template", slug: "eva", title: "Ева",
      description: "", archivedAt: null,
    }],
    version: async (id: number) => {
      const found = versions[id];
      if (!found) throw new Error(`нет версии ${id}`);
      return found;
    },
    active: async () => ({ versionId: 2, version: 2, publishedAt: "2026-08-01" }),
  };
}

const APPROVED_V2 = {
  id: 2, artifactId: 1, version: 2, status: "approved", parentId: 1,
  body: { blocks: [{ label: "persona", value: "Ева — внимательный собеседник" }] },
  checksum: "x", validation: {}, testResult: null, createdAt: "2026-08-01",
};
const APPROVED_V1 = {
  id: 1, artifactId: 1, version: 1, status: "approved", parentId: null,
  body: { blocks: [{ label: "persona", value: PERSONA }] },
  checksum: "y", validation: {}, testResult: null, createdAt: "2026-07-01",
};

function templateService(db: FakeDb) {
  const sync = new MemoryBlockSync(
    { query: db.query, withUserScope: async (_input: unknown, work: () => Promise<unknown>) => await work() } as never,
    new DisabledAdminPlane("тест"),
  );
  return new MemoryTemplateService(
    db as never,
    fakeRegistry({ 1: APPROVED_V1, 2: APPROVED_V2 }) as never,
    sync,
  );
}

function directory(db: FakeDb) {
  return new AgentDirectoryService(
    db as never,
    new DeleteGuard({
      query: db.query,
      withSystemScope: async (_reason: string, work: () => Promise<unknown>) => await work(),
    } as never),
  );
}

test("conversation tool selectors accept only exact canonical names and preserve null versus empty", async () => {
  const db = new FakeDb();
  const service = new ConversationToolSelectorService(db as never, createCanonicalToolManifestRegistry());
  await assert.rejects(() => service.set("conv-1", ["*"], null), /canonical|зарегистрирован/i);
  await assert.rejects(() => service.set("conv-1", ["get_notes ignored"], null), /canonical|зарегистрирован/i);
  const written = await service.set("conv-1", [], null);
  assert.deepEqual(written.currentTaskTools, []);
  assert.equal(written.selectedSkillTools, null);
  assert.deepEqual(db.conversations[0]!.current_task_tools, []);
  assert.equal(db.conversations[0]!.selected_skill_tools, null);
});

// ---------------------------------------------------------------------
// 2. Шаблоны memory block: предпросмотр, применение, откат
// ---------------------------------------------------------------------

test("предпросмотр не записывает ни одного намерения", async () => {
  const db = new FakeDb();
  const application = await templateService(db).preview({
    versionId: 2,
    scope: "all",
  });
  assert.equal(application.dryRun, true);
  assert.equal(application.status, "previewed");
  assert.equal(db.written.includes("sync"), false, "предпросмотр записал намерение");
  // Агент-1 меняется, агент-2 тоже (у него намерения ещё нет),
  // архивный агент-3 пропускается.
  assert.equal(application.counts.recorded, 2);
  assert.equal(application.counts.skipped, 1);
});

test("применение записывает намерения, исключения не трогаются", async () => {
  const db = new FakeDb();
  const application = await templateService(db).apply({
    versionId: 2,
    scope: "group",
    agentIds: ["agent-1", "agent-2"],
    excluded: ["agent-2"],
    reason: "новая персона",
  });
  assert.equal(application.status, "applied");
  assert.equal(application.counts.recorded, 1);
  assert.equal(application.counts.excluded, 1);
  const agentTwo = db.blocks.find((row) => row.agent_id === "agent-2");
  assert.equal(agentTwo, undefined, "исключённому агенту записали намерение");
  const agentOne = db.blocks.find((row) => row.agent_id === "agent-1");
  assert.equal(agentOne?.desired_value, "Ева — внимательный собеседник");
});

test("повторное применение той же версии ничего не меняет", async () => {
  const db = new FakeDb();
  const service = templateService(db);
  await service.apply({ versionId: 2, scope: "agent", agentIds: ["agent-1"], reason: "раз" });
  const second = await service.apply({
    versionId: 2, scope: "agent", agentIds: ["agent-1"], reason: "два",
  });
  assert.equal(second.counts.unchanged, 1);
  assert.equal(second.counts.recorded, undefined);
});

test("неутверждённая версия шаблона не применяется, но показывается в предпросмотре", async () => {
  const db = new FakeDb();
  const service = new MemoryTemplateService(
    db as never,
    fakeRegistry({ 3: { ...APPROVED_V2, id: 3, status: "candidate" } }) as never,
    new MemoryBlockSync(
      { query: db.query, withUserScope: async (_i: unknown, work: () => Promise<unknown>) => await work() } as never,
      new DisabledAdminPlane("тест"),
    ),
  );
  await assert.rejects(
    () => service.apply({ versionId: 3, scope: "agent", agentIds: ["agent-1"], reason: "x" }),
    /применяется только утверждённая/,
  );
  const preview = await service.preview({ versionId: 3, scope: "agent", agentIds: ["agent-1"] });
  assert.equal(preview.dryRun, true);
});

test("откат возвращает родительскую версию тем же агентам и не переписывает историю", async () => {
  const db = new FakeDb();
  const service = templateService(db);
  const applied = await service.apply({
    versionId: 2, scope: "agent", agentIds: ["agent-1"], reason: "новая персона",
  });
  const reverted = await service.rollback(applied.id, "откатываем", null);

  assert.equal(reverted.revertsId, applied.id);
  assert.equal(reverted.versionId, 1, "откат ушёл не на родительскую версию");
  assert.equal(db.blocks.find((row) => row.agent_id === "agent-1")?.desired_value, PERSONA);
  // История не переписана: оба прогона на месте.
  assert.equal(db.applications.length, 2);
});

test("предпросмотр не откатывается и откат требует причины", async () => {
  const db = new FakeDb();
  const service = templateService(db);
  const preview = await service.preview({ versionId: 2, scope: "agent", agentIds: ["agent-1"] });
  await assert.rejects(
    () => service.rollback(preview.id, "причина", null),
    /только выполненное применение/,
  );
  const applied = await service.apply({
    versionId: 2, scope: "agent", agentIds: ["agent-1"], reason: "x",
  });
  await assert.rejects(() => service.rollback(applied.id, "   ", null), /требует причины/);
});

test("журнал применения содержит отпечатки, а не значения блоков", async () => {
  const db = new FakeDb();
  const service = templateService(db);
  const applied = await service.apply({
    versionId: 2, scope: "agent", agentIds: ["agent-1"], reason: "x",
  });
  const stored = await service.application(applied.id);
  const serialized = JSON.stringify(stored);
  assert.equal(serialized.includes("внимательный собеседник"), false);
  assert.equal(serialized.includes(PERSONA), false);
  assert.equal(stored.items[0]?.nextChecksum.length, 16);
});

// ---------------------------------------------------------------------
// 1. Агенты и conversations
// ---------------------------------------------------------------------

test("архивация conversation отклоняется, пока ход не закончился", async () => {
  const db = new FakeDb();
  db.turns.push({
    run_id: "11111111-1111-1111-1111-111111111111", conversation_id: "conv-1",
    agent_id: "agent-1", state: "approval_pending", finished_at: null,
  });
  await assert.rejects(
    () => directory(db).setConversationStatus("conv-1", "archived"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "deletion_blocked");
      assert.match((error as Error).message, /пока ход не закончился/);
      return true;
    },
  );
  assert.equal(db.conversations[0]!.status, "active");
});

test("предпросмотр удаления называет ожидающие подтверждения", async () => {
  const db = new FakeDb();
  db.turns.push({
    run_id: "11111111-1111-1111-1111-111111111111", conversation_id: "conv-1",
    agent_id: "agent-1", state: "approval_pending", finished_at: null,
  });
  const preview = await directory(db).deletionPreview("agent", "agent-1");
  assert.equal(preview.deletable, false);
  assert.equal(preview.awaitingApproval, 1);
});

test("экспорт агента не содержит ни сообщений, ни значений блоков", async () => {
  const db = new FakeDb();
  const snapshot = await directory(db).exportAgent("agent-1");
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(PERSONA), false);
  assert.equal(serialized.includes("desired_value"), false);
  assert.equal((snapshot as { format?: string }).format, "evaself.agent-snapshot.v1");
});

test("импорт чужого формата отвергается до всякой выборки", async () => {
  const db = new FakeDb();
  await assert.rejects(
    () => directory(db).importPreview({ format: "чужой", agent: { agent_id: "agent-1" } }),
    /evaself.agent-snapshot.v1/,
  );
});

// ---------------------------------------------------------------------
// 8. Восстановление
// ---------------------------------------------------------------------

test("доставленное сообщение не повторяется", async () => {
  const db = new FakeDb();
  db.outbox.push({ id: 7, user_id: 11, status: "sent", sent_at: "2026-08-01", attempts: 1 });
  await assert.rejects(
    () => new TurnOperationsService(db as never).redeliver(7),
    /уже доставлено/,
  );
  assert.equal(db.outbox[0]!.status, "sent");
});

test("повторяется только dead или retry", async () => {
  const db = new FakeDb();
  db.outbox.push({ id: 8, user_id: 11, status: "pending", sent_at: null, attempts: 0 });
  db.outbox.push({ id: 9, user_id: 11, status: "dead", sent_at: null, attempts: 8 });
  const service = new TurnOperationsService(db as never);
  await assert.rejects(() => service.redeliver(8), /dead или retry/);
  const result = await service.redeliver(9);
  assert.equal(result.status, "pending");
});

test("отмена ставит барьер, а не переписывает состояние хода", async () => {
  const db = new FakeDb();
  db.turns.push({
    run_id: "22222222-2222-2222-2222-222222222222", state: "letta_processing",
    finished_at: null, cancel_requested_at: null,
  });
  const service = new TurnOperationsService(db as never);
  await assert.rejects(
    () => service.requestCancel("22222222-2222-2222-2222-222222222222", "  "),
    /требует причины/,
  );
  await service.requestCancel("22222222-2222-2222-2222-222222222222", "завис");
  assert.equal(db.turns[0]!.state, "letta_processing", "состояние переписано административно");
  assert.equal(db.turns[0]!.cancel_reason, "завис");
});

// ---------------------------------------------------------------------
// 3–7, 9. Инструменты, approvals и разделы подсистем
// ---------------------------------------------------------------------

test("обзор инструментов публикует реализованный реестр и durable gateway state", async () => {
  const db = new FakeDb();
  const registry = new ToolManifestRegistry();
  registry.register({ name: "save_task", version: "1", inputSchema: {}, outputSchema: {}, owner: "core", purposes: ["chat"], risk: "low_risk_write", approvalRequired: false, idempotent: true, timeoutMs: 1000, limits: { maxResultBytes: 1000 }, sideEffect: true });
  const overview = await new ToolApprovalService(db as never, registry, new ToolGatewayStateStore(db as never)).tools(7);
  const status = (overview as { status: { implemented: boolean } }).status;
  assert.equal(status.implemented, true);
  assert.equal((overview as { manifests: unknown[] }).manifests.length, 1);
  assert.ok(Array.isArray((overview as { gateway_state: unknown[] }).gateway_state));
});

test("admin approvals are read from durable approvals and rules tables", async () => {
  const db = new FakeDb();
  const result = await new ToolApprovalService(db as never, new ToolManifestRegistry(), new ToolGatewayStateStore(db as never)).approvals(20);
  assert.equal((result as { status: { implemented: boolean } }).status.implemented, true);
  assert.ok(Array.isArray((result as { pending: unknown[] }).pending));
  assert.ok(Array.isArray((result as { resolved: unknown[] }).resolved));
  assert.ok(Array.isArray((result as { standing_rules: unknown[] }).standing_rules));
});

test("разделы отсутствующих подсистем не выдают пустоту за данные", () => {
  assert.deepEqual(
    SUBSYSTEM_SECTIONS.map((section) => section.id),
    ["skills", "research", "evals", "extensions"],
  );
  for (const section of SUBSYSTEM_SECTIONS) {
    assert.equal(section.implemented, false);
    // Номер шага обязателен: «когда-нибудь» невозможно проверить.
    assert.match(section.plannedStep, /\d+/);
    const payload = subsystemPayload(section) as { items: unknown[]; status: { detail: string } };
    assert.deepEqual(payload.items, []);
    assert.ok(payload.status.detail.length > 40, "статус без объяснения");
  }
});

// ---------------------------------------------------------------------
// 10. Правила: роли, подтверждение, аудит, флаг
// ---------------------------------------------------------------------

interface HarnessOptions {
  role?: string;
  flag?: string;
  gatewayFlag?: string;
  /** Флаг реестра артефактов: у шага 13 он свой и выключается отдельно. */
  artifactsFlag?: string;
}

function harness(db: FakeDb, options: HarnessOptions = {}) {
  process.env.EVA_ADMIN_CRUD = options.flag ?? "1";
  process.env.EVA_ARTIFACT_VERSIONS = options.artifactsFlag ?? "0";
  const audits: Array<{ operation: string; details: unknown }> = [];
  const guards: string[] = [];
  const session = {
    id: "session-1",
    user: { id: "00000000-0000-0000-0000-000000000001", username: "кто-то", role: options.role ?? "owner" },
  };
  const app = buildAdminServer({
    auth: {
      authenticate: async () => session,
      requireCsrf: () => guards.push("csrf"),
      requireSudo: async (_id: string, scope: string) => {
        guards.push(`sudo:${scope}`);
      },
    },
    audit: {
      start: async (entry: { operation: string }) => {
        audits.push({ operation: entry.operation, details: null });
        return { id: `audit-${audits.length}`, startedAt: Date.now() };
      },
      finish: async () => undefined,
      annotate: async (id: string, details: unknown) => {
        const index = Number(id.split("-")[1]) - 1;
        if (audits[index]) audits[index]!.details = details;
      },
      list: async () => [],
    },
    artifacts: fakeRegistry({ 1: APPROVED_V1, 2: APPROVED_V2 }),
    crud: {
      directory: directory(db),
      selectors: (options.gatewayFlag ?? "1") === "1"
        ? new ConversationToolSelectorService(db as never, createCanonicalToolManifestRegistry())
        : undefined,
      templates: templateService(db),
      tools: new ToolApprovalService(db as never, new ToolManifestRegistry(), new ToolGatewayStateStore(db as never)),
      turns: new TurnOperationsService(db as never),
    },
    config: {}, secrets: {}, health: {}, operations: {}, providers: {},
    llmRouter: {}, stt: {}, integrations: {}, users: {},
    events: { publish: async () => undefined },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    readiness: async () => true,
  } as never);
  return { app, audits, guards };
}

test("tool selector writer is flag-gated, owner/admin-only, confirmed, sudo-protected and audited", async () => {
  const off = harness(new FakeDb(), { gatewayFlag: "0" });
  await off.app.ready();
  assert.equal((await off.app.inject({ method: "POST", url: "/api/admin/v1/conversations/conv-1/tool-selectors", headers: { cookie: "eva_admin=session-1" }, payload: {} })).statusCode, 404);
  await off.app.close();

  const db = new FakeDb();
  const { app, audits, guards } = harness(db);
  await app.ready();
  const missing = await app.inject({ method: "POST", url: "/api/admin/v1/conversations/conv-1/tool-selectors", headers: { cookie: "eva_admin=session-1" }, payload: { current_task_tools: ["get_notes"], selected_skill_tools: [] } });
  assert.equal(missing.statusCode, 400);
  const response = await app.inject({ method: "POST", url: "/api/admin/v1/conversations/conv-1/tool-selectors", headers: { cookie: "eva_admin=session-1", "x-csrf-token": "t" }, payload: { confirm: "conv-1", current_task_tools: ["get_notes"], selected_skill_tools: ["get_notes"] } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(guards.slice(-2), ["csrf", "sudo:users:write"]);
  assert.deepEqual(db.conversations[0]!.current_task_tools, ["get_notes"]);
  assert.deepEqual(db.conversations[0]!.selected_skill_tools, ["get_notes"]);
  assert.deepEqual(audits.findLast((entry) => entry.operation.includes("tool-selectors"))?.details, { conversation_id: "conv-1", user_id: 11, current_task_tools: ["get_notes"], selected_skill_tools: ["get_notes"] });

  const runtimeDb = {
    getAgentRuntimeContext: async () => ({ userId: 11, telegramId: 42, chatId: 42, conversationId: "conv-1", purpose: "chat", timezone: "UTC", responseMode: "text", useEmoji: true,
      currentTaskTools: db.conversations[0]!.current_task_tools, selectedSkillTools: db.conversations[0]!.selected_skill_tools }),
    query: db.query,
    withUserScope: async (_scope: unknown, work: () => Promise<unknown>) => await work(),
  };
  const factory = new AgentToolFactory({ vectorGoalsEnabled: false } as never, runtimeDb as never, {} as never,
    { debug() {}, info() {}, warn() {}, error() {} });
  assert.deepEqual((await factory.sessionPolicy("conv-1")).visibleTools, ["get_notes"]);
  await app.close();

  const viewer = harness(new FakeDb(), { role: "viewer" });
  await viewer.app.ready();
  assert.equal((await viewer.app.inject({ method: "POST", url: "/api/admin/v1/conversations/conv-1/tool-selectors", headers: { cookie: "eva_admin=session-1" }, payload: { confirm: "conv-1", current_task_tools: null, selected_skill_tools: null } })).statusCode, 403);
  await viewer.app.close();
});

test("выключенный флаг не оставляет ни одного маршрута раздела", async () => {
  const { app } = harness(new FakeDb(), { flag: "0" });
  await app.ready();
  const response = await app.inject({
    method: "GET", url: "/api/admin/v1/agents", headers: { cookie: "eva_admin=session-1" },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test("реестр артефактов выключается своим флагом, независимо от раздела CRUD", async () => {
  // Публикация версии меняет то, на чём работают живые ходы, и обязана
  // выключаться (инвариант 22). Флаг у шага 13 свой: разделы двух шагов
  // включаются независимо, потому что цена ошибки у них разная.
  const off = harness(new FakeDb(), { flag: "1", artifactsFlag: "0" });
  await off.app.ready();
  const closed = await off.app.inject({
    method: "GET", url: "/api/admin/v1/artifacts", headers: { cookie: "eva_admin=session-1" },
  });
  assert.equal(closed.statusCode, 404, closed.body);
  // Раздел шага 12 при этом на месте: флаги независимы.
  const crud = await off.app.inject({
    method: "GET", url: "/api/admin/v1/agents", headers: { cookie: "eva_admin=session-1" },
  });
  assert.equal(crud.statusCode, 200, crud.body);
  await off.app.close();

  const on = harness(new FakeDb(), { flag: "0", artifactsFlag: "1" });
  await on.app.ready();
  const open = await on.app.inject({
    method: "GET", url: "/api/admin/v1/artifacts", headers: { cookie: "eva_admin=session-1" },
  });
  assert.equal(open.statusCode, 200, open.body);
  await on.app.close();
});

test("viewer читает каталог, но не меняет состояние", async () => {
  const db = new FakeDb();
  const { app } = harness(db, { role: "viewer" });
  await app.ready();

  const read = await app.inject({
    method: "GET", url: "/api/admin/v1/agents", headers: { cookie: "eva_admin=session-1" },
  });
  assert.equal(read.statusCode, 200, read.body);

  for (const url of [
    "/api/admin/v1/memory/templates/apply",
    "/api/admin/v1/conversations/conv-1/archive",
    "/api/admin/v1/turns/22222222-2222-2222-2222-222222222222/cancel",
  ]) {
    const response = await app.inject({
      method: "POST", url, headers: { cookie: "eva_admin=session-1" }, payload: {},
    });
    assert.equal(response.statusCode, 403, `${url}: ${response.body}`);
  }
  await app.close();
});

test("оператор ведёт дежурство, но массовое применение шаблона ему закрыто", async () => {
  const db = new FakeDb();
  db.outbox.push({ id: 9, user_id: 11, status: "dead", sent_at: null, attempts: 8 });
  const { app } = harness(db, { role: "operator" });
  await app.ready();

  const redeliver = await app.inject({
    method: "POST",
    url: "/api/admin/v1/deliveries/9/redeliver",
    headers: { cookie: "eva_admin=session-1" },
    payload: { confirm: "9" },
  });
  assert.equal(redeliver.statusCode, 200, redeliver.body);

  const apply = await app.inject({
    method: "POST",
    url: "/api/admin/v1/memory/templates/apply",
    headers: { cookie: "eva_admin=session-1" },
    payload: { version_id: 2, scope: "all", confirm: "2", reason: "x" },
  });
  assert.equal(apply.statusCode, 403);
  await app.close();
});

test("опасное действие без подтверждения не выполняется", async () => {
  const db = new FakeDb();
  const { app } = harness(db);
  await app.ready();

  const withoutConfirm = await app.inject({
    method: "POST",
    url: "/api/admin/v1/memory/templates/apply",
    headers: { cookie: "eva_admin=session-1" },
    payload: { version_id: 2, scope: "all", reason: "без подтверждения" },
  });
  assert.equal(withoutConfirm.statusCode, 400);
  assert.equal(JSON.parse(withoutConfirm.body).error.code, "bad_request");
  assert.equal(db.written.includes("sync"), false);

  const withConfirm = await app.inject({
    method: "POST",
    url: "/api/admin/v1/memory/templates/apply",
    headers: { cookie: "eva_admin=session-1" },
    payload: { version_id: 2, scope: "all", confirm: "2", reason: "новая персона" },
  });
  assert.equal(withConfirm.statusCode, 200, withConfirm.body);
  await app.close();
});

test("массовое применение проходит CSRF и sudo, а чтение — нет", async () => {
  const db = new FakeDb();
  const { app, guards } = harness(db);
  await app.ready();

  await app.inject({
    method: "GET", url: "/api/admin/v1/agents", headers: { cookie: "eva_admin=session-1" },
  });
  assert.deepEqual(guards, [], "чтение потребовало CSRF или sudo");

  await app.inject({
    method: "POST",
    url: "/api/admin/v1/memory/templates/apply",
    headers: { cookie: "eva_admin=session-1", "x-csrf-token": "t" },
    payload: { version_id: 2, scope: "all", confirm: "2", reason: "новая персона" },
  });
  // Sudo здесь тот же, что у блокировки пользователя: то же по смыслу
  // действие «изменить состояние человека в системе», только для многих.
  assert.deepEqual(guards, ["csrf", "sudo:users:write"]);
  await app.close();
});

test("применение шаблона попадает в аудит вместе с исходами", async () => {
  const db = new FakeDb();
  const { app, audits } = harness(db);
  await app.ready();
  await app.inject({
    method: "POST",
    url: "/api/admin/v1/memory/templates/apply",
    headers: { cookie: "eva_admin=session-1" },
    payload: { version_id: 2, scope: "all", confirm: "2", reason: "новая персона" },
  });
  const entry = audits.find((row) => row.operation.includes("templates/apply"));
  assert.ok(entry, "применение шаблона не попало в аудит");
  const details = entry!.details as { counts?: Record<string, number>; version_id?: number };
  assert.equal(details.version_id, 2);
  assert.ok(details.counts, "в аудите нет исходов применения");
  // Значения блоков в журнал не попадают — только счётчики.
  assert.equal(JSON.stringify(details).includes("собеседник"), false);
  await app.close();
});

test("отказ доменного слоя показывается своим кодом, а не внутренней ошибкой", async () => {
  const db = new FakeDb();
  db.turns.push({
    run_id: "11111111-1111-1111-1111-111111111111", conversation_id: "conv-1",
    agent_id: "agent-1", state: "letta_processing", finished_at: null,
  });
  const { app } = harness(db);
  await app.ready();
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/v1/conversations/conv-1/archive",
    headers: { cookie: "eva_admin=session-1" },
    payload: { confirm: "conv-1" },
  });
  assert.equal(response.statusCode, 409, response.body);
  const payload = JSON.parse(response.body);
  assert.equal(payload.error.code, "deletion_blocked");
  assert.notEqual(payload.error.code, "internal_error");
  // Ответ объясняет причину, но не показывает содержимого разговора.
  assert.equal(response.body.includes("Разговор"), false);
  await app.close();
});

test("раздел подсистемы отвечает статусом, а не пустым списком без объяснения", async () => {
  const { app } = harness(new FakeDb());
  await app.ready();
  const response = await app.inject({
    method: "GET", url: "/api/admin/v1/subsystems/evals",
    headers: { cookie: "eva_admin=session-1" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const payload = JSON.parse(response.body);
  assert.equal(payload.status.implemented, false);
  assert.match(payload.status.planned_step, /22/);

  const missing = await app.inject({
    method: "GET", url: "/api/admin/v1/subsystems/несуществующая",
    headers: { cookie: "eva_admin=session-1" },
  });
  assert.equal(missing.statusCode, 404);
  await app.close();
});
