import assert from "node:assert/strict";
import { test } from "node:test";

import {
  McpHttpInvoker,
  ToolManifestRegistry,
  selectVisibleTools,
  minimalPermissionMode,
  validateMcpServerPolicy,
  McpServerPolicyRepository,
} from "../dist/tools/gateway.js";

const manifest = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  version: "1.0.0",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  owner: "test",
  purposes: ["chat"],
  risk: "read",
  approvalRequired: false,
  idempotent: true,
  timeoutMs: 1_000,
  limits: { maxResultBytes: 1024 },
  sideEffect: false,
  ...overrides,
});

test("registry is extensible and visibility intersects purpose, task, skill, and allowedTools", () => {
  const registry = new ToolManifestRegistry();
  registry.register(manifest("notes.read"));
  registry.register(manifest("notes.write", { risk: "low_risk_write", sideEffect: true }));
  registry.register(manifest("admin.delete", { purposes: ["admin"], risk: "destructive", approvalRequired: true, sideEffect: true }));

  assert.deepEqual(selectVisibleTools(registry, {
    purpose: "chat",
    taskTools: ["notes.read", "notes.write", "admin.delete"],
    skillTools: ["notes.read", "notes.write"],
    allowedTools: ["notes.read"],
    trusted: false,
  }).map((item) => item.name), ["notes.read"]);
});

test("untrusted content cannot expand tool visibility", () => {
  const registry = new ToolManifestRegistry();
  registry.register(manifest("safe"));
  registry.register(manifest("danger", { risk: "destructive", approvalRequired: true }));
  assert.deepEqual(selectVisibleTools(registry, {
    purpose: "chat", taskTools: ["safe"], skillTools: ["safe"], allowedTools: ["safe"],
    trusted: false, requestedByContent: ["danger"],
  }).map((item) => item.name), ["safe"]);
});

test("unrestricted permission mode is limited to explicit admin or isolated sessions", () => {
  assert.equal(minimalPermissionMode({ requested: "unrestricted", administrative: false, isolated: false }), "strict");
  assert.equal(minimalPermissionMode({ requested: "unrestricted", administrative: true, isolated: false }), "unrestricted");
  assert.equal(minimalPermissionMode({ requested: "acceptEdits", administrative: false, isolated: false }), "acceptEdits");
});

test("kill switch disables a tool immediately and breaker opens after repeated failures", async () => {
  const registry = new ToolManifestRegistry();
  registry.register(manifest("write", { sideEffect: true, risk: "low_risk_write" }));
  const { ToolGateway } = await import("../dist/tools/gateway.js");
  const gateway = new ToolGateway(registry, { breakerThreshold: 2, breakerCooldownMs: 60_000 });
  await gateway.kill("write");
  await assert.rejects(() => gateway.execute("write", async () => "no"), /disabled/);
  await gateway.enable("write");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(() => gateway.execute("write", async () => { throw new Error("down"); }), /down/);
  }
  await assert.rejects(() => gateway.execute("write", async () => "no"), /circuit/i);
});

test("kill switch state survives a gateway restart", async () => {
  const state = new Map<string, boolean>();
  const db = { async query(sql: string, values: unknown[]) {
    const name = String(values[0]);
    if (sql.includes("SELECT")) return { rows: state.has(name) ? [{ tool_name: name, enabled: state.get(name), breaker_state: "closed", consecutive_errors: 0, probe_after: null }] : [] };
    state.set(name, Boolean(values[1]));
    return { rows: [] };
  } };
  const { ToolGateway, ToolGatewayStateStore } = await import("../dist/tools/gateway.js");
  const registry = new ToolManifestRegistry();
  registry.register(manifest("write", { sideEffect: true, risk: "low_risk_write" }));
  await new ToolGateway(registry, { stateStore: new ToolGatewayStateStore(db as never) }).kill("write");
  const restarted = new ToolGateway(registry, { stateStore: new ToolGatewayStateStore(db as never) });
  await assert.rejects(() => restarted.execute("write", async () => "no"), /disabled/);
});

test("gateway enforces timeout and result cap as breaker failures", async () => {
  const events: string[] = [];
  const store = { get: async () => ({ tool_name: "bounded", enabled: true, breaker_state: "closed", consecutive_errors: 0, probe_after: null, generation: 1 }),
    acquireLease: async () => { events.push("lease"); return { ownerId: "00000000-0000-4000-8000-000000000010", generation: 1 }; }, releaseLease: async () => { events.push("release"); },
    recordFailure: async () => { events.push("failure"); return {}; }, recordSuccess: async () => { events.push("success"); }, claimProbe: async () => false };
  const registry = new ToolManifestRegistry(); registry.register(manifest("bounded", { sideEffect: true, timeoutMs: 10, limits: { maxResultBytes: 12 } }));
  const { ToolGateway } = await import("../dist/tools/gateway.js");
  const gateway = new ToolGateway(registry, { stateStore: store as never });
  await assert.rejects(gateway.execute("bounded", async (signal: AbortSignal) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }), /timed out/i);
  assert.deepEqual(events, ["lease", "failure", "release"]);
  events.length = 0;
  await assert.rejects(gateway.execute("bounded", async () => ({ value: "éé" })), /result.*bytes|limit/i);
  assert.deepEqual(events, ["lease", "failure", "release"]);
});

test("MCP policy forbids non-admin, stdio/npx/wildcards and requires strict HTTP/SSE controls", async () => {
  const gateway = { validate: async (url: string) => new URL(url) };
  await assert.rejects(() => validateMcpServerPolicy({ adminAdded: true, transport: "stdio", command: "npx -y x", url: "https://mcp.test", allowedTools: ["x"], secretIds: ["s"], timeoutMs: 1000, maxResultBytes: 1024 }, gateway as never), /HTTP|SSE/);
  await assert.rejects(() => validateMcpServerPolicy({ adminAdded: true, transport: "http", url: "https://mcp.test", allowedTools: ["*"], secretIds: ["s"], timeoutMs: 1000, maxResultBytes: 1024 }, gateway as never), /wildcard/i);
  const valid = await validateMcpServerPolicy({ adminAdded: true, transport: "sse", url: "https://mcp.test", allowedTools: ["search"], secretIds: ["secret-record-id"], timeoutMs: 1000, maxResultBytes: 1024 }, gateway as never);
  assert.equal(valid.transport, "sse");
});

test("durable breaker opens atomically and permits exactly one half-open probe after restart", async () => {
  const rows = new Map<string, { enabled: boolean; breaker_state: string; consecutive_errors: number; probe_after: Date | null }>();
  const db = { async query(sql: string, values: unknown[] = []) {
    const name = String(values[0]);
    const row = rows.get(name) ?? { enabled: true, breaker_state: "closed", consecutive_errors: 0, probe_after: null };
    if (sql.includes("INSERT INTO tool_gateway_state") && sql.includes("consecutive_errors")) {
      row.consecutive_errors += 1;
      if (row.consecutive_errors >= Number(values[1])) { row.breaker_state = "open"; row.probe_after = new Date(Date.now() + Number(values[2])); }
      rows.set(name, row); return { rows: [{ ...row, tool_name: name }] };
    }
    if (sql.includes("breaker_state = 'half_open'")) {
      if (row.breaker_state === "open" && row.probe_after! <= new Date()) { row.breaker_state = "half_open"; rows.set(name, row); return { rows: [{ ...row, tool_name: name }] }; }
      return { rows: [] };
    }
    if (sql.includes("breaker_state = 'closed'")) { Object.assign(row, { breaker_state: "closed", consecutive_errors: 0, probe_after: null }); rows.set(name, row); return { rows: [] }; }
    return { rows: rows.has(name) ? [{ ...row, tool_name: name }] : [] };
  } };
  const { ToolGateway, ToolGatewayStateStore } = await import("../dist/tools/gateway.js");
  const registry = new ToolManifestRegistry(); registry.register(manifest("remote"));
  const store = new ToolGatewayStateStore(db as never);
  const first = new ToolGateway(registry, { stateStore: store, breakerThreshold: 2, breakerCooldownMs: 50 });
  await assert.rejects(first.execute("remote", async () => { throw new Error("down"); }));
  await assert.rejects(first.execute("remote", async () => { throw new Error("down"); }));
  await assert.rejects(new ToolGateway(registry, { stateStore: store }).execute("remote", async () => "blocked"), /circuit/i);
  rows.get("remote")!.probe_after = new Date(Date.now() - 1);
  let probes = 0;
  const restarted = new ToolGateway(registry, { stateStore: store });
  assert.equal(await restarted.execute("remote", async () => { probes += 1; return "ok"; }), "ok");
  assert.equal(probes, 1);
});

test("MCP invocation resolves secret refs, uses bounded outbound gateway, allowlist and audit", async () => {
  const calls: unknown[] = []; const audits: unknown[] = [];
  const invoker = new McpHttpInvoker({
    gatewayFactory: (options) => ({ validate: async (url: string) => new URL(url), request: async (url: string, init: RequestInit) => { calls.push({ options, url, init }); return { ok: true, status: 200, headers: new Headers(), body: new TextEncoder().encode('{"jsonrpc":"2.0","result":{"ok":true}}'), json() { return { jsonrpc: "2.0", result: { ok: true } }; } }; } }) as never,
    secrets: { get: async (ref: string) => ref === "sec_mcp" ? "token" : null },
    audit: { record: async (entry: unknown) => { audits.push(entry); } },
  });
  const policy = { adminAdded: true, transport: "http" as const, url: "https://mcp.test/rpc", allowedTools: ["search"], secretIds: ["sec_mcp"], timeoutMs: 500, maxResultBytes: 2048 };
  assert.deepEqual(await invoker.invoke(policy, "search", { q: "safe" }), { ok: true });
  assert.equal(calls.length, 1); assert.equal(audits.length, 1);
  await assert.rejects(invoker.invoke(policy, "delete", {}), /allowlist/i);
  assert.equal(audits.length, 2, "allowlist rejection is audited");
});

test("kill is durable before local publication and waits for an acquired side-effect lease", async () => {
  const events: string[] = [];
  let enabled = true; let generation = 0; let leases = 0;
  const store = {
    get: async () => ({ tool_name: "write", enabled, breaker_state: "closed", consecutive_errors: 0, probe_after: null, generation }),
    acquireLease: async () => { if (!enabled) return null; leases += 1; return { ownerId: crypto.randomUUID(), generation }; },
    releaseLease: async () => { leases -= 1; },
    setEnabled: async (_name: string, value: boolean) => {
      events.push("durable"); enabled = value; generation += 1;
      while (!value && leases) await new Promise((resolve) => setTimeout(resolve, 1));
    },
    recordSuccess: async () => {}, recordFailure: async () => ({}), claimProbe: async () => false,
  };
  const registry = new ToolManifestRegistry(); registry.register(manifest("write", { sideEffect: true }));
  const { ToolGateway } = await import("../dist/tools/gateway.js");
  const gateway = new ToolGateway(registry, { stateStore: store as never });
  let finish!: () => void;
  const running = gateway.execute("write", async () => { events.push("work"); await new Promise<void>((resolve) => { finish = resolve; }); });
  await new Promise((resolve) => setImmediate(resolve));
  const killing = gateway.kill("write").then(() => events.push("published"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["work", "durable"]);
  finish(); await running; await killing;
  assert.deepEqual(events, ["work", "durable", "published"]);
});

test("expired durable lease from a dead process cannot block kill forever", async () => {
  const queries: string[] = []; let polls = 0;
  const db = { async query(sql: string) {
    queries.push(sql);
    if (sql.includes("SELECT EXISTS")) return { rows: [{ has_live_leases: polls++ === 0 }] };
    return { rows: [] };
  } };
  const { ToolGatewayStateStore } = await import("../dist/tools/gateway.js");
  await new ToolGatewayStateStore(db as never).setEnabled("write", false);
  assert.ok(queries.some((sql) => /DELETE FROM tool_gateway_leases[\s\S]*expires_at <= now\(\)/.test(sql)));
  assert.ok(queries.some((sql) => /SELECT EXISTS[\s\S]*released_at IS NULL[\s\S]*expires_at > now\(\)/.test(sql)));
});

test("timeout aborts work but retains its lease until abort-ignoring work actually settles", async () => {
  let enabled = true; const leases = new Set<string>();
  const store = {
    get: async () => ({ tool_name: "write", enabled, breaker_state: "closed", consecutive_errors: 0, probe_after: null, generation: 1 }),
    acquireLease: async () => { const ownerId = crypto.randomUUID(); leases.add(ownerId); return { ownerId, generation: 1 }; },
    releaseLease: async (_name: string, ownerId: string) => { leases.delete(ownerId); },
    setEnabled: async (_name: string, value: boolean) => { enabled = value; while (!value && leases.size) await new Promise((resolve) => setTimeout(resolve, 1)); },
    recordSuccess: async () => {}, recordFailure: async () => ({}), claimProbe: async () => false,
  };
  const registry = new ToolManifestRegistry(); registry.register(manifest("write", { sideEffect: true, timeoutMs: 10 }));
  const { ToolGateway } = await import("../dist/tools/gateway.js");
  const gateway = new ToolGateway(registry, { stateStore: store as never });
  let settle!: () => void; let sawAbort = false;
  const execution = gateway.execute("write", async (signal: AbortSignal) => {
    signal.addEventListener("abort", () => { sawAbort = true; }, { once: true });
    await new Promise<void>((resolve) => { settle = resolve; });
  });
  await assert.rejects(execution, /timed out/i);
  assert.equal(sawAbort, true); assert.equal(leases.size, 1);
  let killed = false; const killing = gateway.kill("write").then(() => { killed = true; });
  await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(killed, false);
  settle(); await killing; assert.equal(leases.size, 0);
});

// Часы здесь виртуальные: и таймер heartbeat внутри шлюза, и срок аренды в
// поддельном хранилище читают одно время, которое двигает только тест. На
// настоящих таймерах проверка мерила загрузку машины, а не поведение
// heartbeat: под нехваткой CPU в сборке образа планировщик задерживал тик
// на 10 мс дольше, чем весь TTL в 30 мс, аренда «истекала», и kill законно
// проходил сквозь незавершённую работу — CI на `main` падал на этом одном
// тесте из 735. Удлинять TTL нельзя: тогда и проверялась бы не выдержка
// heartbeat, а величина паузы.
test("heartbeat keeps abort-ignoring work contained beyond multiple initial lease TTLs and stops after settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  // setImmediate остаётся настоящим: он даёт микрозадачам обещаний шлюза
  // выполниться между тиками виртуальных часов.
  const drain = () => new Promise((resolve) => setImmediate(resolve));
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await drain(); };
  let enabled = true; let expiresAt = 0; let released = false; let renewals = 0;
  const ownerId = "00000000-0000-4000-8000-000000000020";
  const store = {
    get: async () => ({ tool_name: "write", enabled, breaker_state: "closed", consecutive_errors: 0, probe_after: null, generation: 4 }),
    acquireLease: async (_name: string, ttlMs: number) => { expiresAt = Date.now() + ttlMs; return { ownerId, generation: 4 }; },
    renewLease: async (_name: string, renewedOwnerId: string, generation: number, ttlMs: number) => {
      assert.equal(renewedOwnerId, ownerId); assert.equal(generation, 4);
      if (released || Date.now() >= expiresAt) return false;
      renewals += 1; expiresAt = Date.now() + ttlMs; return true;
    },
    releaseLease: async () => { released = true; },
    setEnabled: async (_name: string, value: boolean) => {
      enabled = value;
      while (!value && !released && Date.now() < expiresAt) await new Promise((resolve) => setTimeout(resolve, 1));
    },
    recordSuccess: async () => {}, recordFailure: async () => ({}), claimProbe: async () => false,
  };
  const registry = new ToolManifestRegistry(); registry.register(manifest("write", { sideEffect: true, timeoutMs: 5 }));
  const { ToolGateway } = await import("../dist/tools/gateway.js");
  const gateway = new ToolGateway(registry, { stateStore: store as never, leaseTtlMs: 30 });
  let settle!: () => void;
  const execution = assert.rejects(
    gateway.execute("write", async () => { await new Promise<void>((resolve) => { settle = resolve; }); }),
    /timed out/i,
  );
  await drain();            // аренда взята, heartbeat поставлен
  await advance(5);         // истёк timeoutMs, работа продолжает игнорировать abort
  await execution;
  let killed = false; const killing = gateway.kill("write").then(() => { killed = true; });
  await drain();
  for (let tick = 0; tick < 10; tick += 1) await advance(10);
  // 105 мс виртуального времени — три с половиной начальных TTL: без продления
  // аренда истекла бы на 30 мс и kill прошёл бы насквозь.
  assert.ok(Date.now() > 3 * 30, `expected to outlive multiple TTLs, virtual clock is ${Date.now()}`);
  assert.equal(killed, false); assert.ok(renewals >= 3, `expected multiple renewals, got ${renewals}`);
  settle();
  for (let tick = 0; tick < 50 && !killed; tick += 1) await advance(1);
  await killing; assert.equal(killed, true);
  const renewalsAtSettlement = renewals;
  await advance(200);
  assert.equal(renewals, renewalsAtSettlement, "heartbeat timer leaked after work settled");
});

test("process-local owner fence blocks kill from another store after renewal errors outlive durable TTL", async () => {
  let enabled = true; let expiresAt = 0; let released = false;
  const db = { async query(sql: string, values: unknown[] = []) {
    if (sql.includes("ON CONFLICT (tool_name) DO UPDATE SET enabled")) { enabled = Boolean(values[1]); return { rows: [] }; }
    if (sql.includes("INSERT INTO tool_gateway_leases")) {
      if (!enabled) return { rows: [] };
      expiresAt = Date.now() + Number(values[2]); return { rows: [{ generation: 1 }] };
    }
    if (sql.includes("SET expires_at")) throw new Error("database unavailable");
    if (sql.includes("SET released_at")) { released = true; return { rows: [] }; }
    if (sql.includes("DELETE FROM tool_gateway_leases") && Date.now() >= expiresAt) released = true;
    if (sql.includes("SELECT EXISTS")) return { rows: [{ has_live_leases: !released && Date.now() < expiresAt }] };
    if (sql.includes("WHERE tool_name = $1")) return { rows: [{ tool_name: "write", enabled, breaker_state: "closed", consecutive_errors: 0, probe_after: null, generation: 1 }] };
    return { rows: [] };
  } };
  const { ToolGateway, ToolGatewayStateStore } = await import("../dist/tools/gateway.js");
  const registry = new ToolManifestRegistry(); registry.register(manifest("write", { sideEffect: true, timeoutMs: 5 }));
  const gateway = new ToolGateway(registry, { stateStore: new ToolGatewayStateStore(db as never), leaseTtlMs: 20 });
  let settle!: () => void;
  await assert.rejects(gateway.execute("write", async () => { await new Promise<void>((resolve) => { settle = resolve; }); }), /timed out/i);
  await new Promise((resolve) => setTimeout(resolve, 70));
  let killed = false;
  const killing = new ToolGatewayStateStore(db as never).setEnabled("write", false).then(() => { killed = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(killed, false, "expired durable row must not hide live process-local work");
  settle(); await killing;
  assert.equal(released, true);
});

test("hung renewal cannot bypass the local fence and leaves no owner or heartbeat timer after settlement", async () => {
  let enabled = true; let released = false; let renewals = 0;
  const db = { async query(sql: string, values: unknown[] = []) {
    if (sql.includes("ON CONFLICT (tool_name) DO UPDATE SET enabled")) { enabled = Boolean(values[1]); return { rows: [] }; }
    if (sql.includes("INSERT INTO tool_gateway_leases")) return { rows: enabled ? [{ generation: 2 }] : [] };
    if (sql.includes("SET expires_at")) { renewals += 1; return new Promise<never>(() => {}); }
    if (sql.includes("SET released_at")) { released = true; return { rows: [] }; }
    if (sql.includes("SELECT EXISTS")) return { rows: [{ has_live_leases: false }] };
    if (sql.includes("WHERE tool_name = $1")) return { rows: [{ tool_name: "write", enabled, breaker_state: "closed", consecutive_errors: 0, probe_after: null, generation: 2 }] };
    return { rows: [] };
  } };
  const { ToolGateway, ToolGatewayStateStore } = await import("../dist/tools/gateway.js");
  const registry = new ToolManifestRegistry(); registry.register(manifest("write", { sideEffect: true, timeoutMs: 5 }));
  const gateway = new ToolGateway(registry, { stateStore: new ToolGatewayStateStore(db as never), leaseTtlMs: 15 });
  let settle!: () => void;
  await assert.rejects(gateway.execute("write", async () => { await new Promise<void>((resolve) => { settle = resolve; }); }), /timed out/i);
  await new Promise((resolve) => setTimeout(resolve, 60));
  let killed = false;
  const killing = new ToolGatewayStateStore(db as never).setEnabled("write", false).then(() => { killed = true; });
  await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(killed, false);
  settle(); await killing; assert.equal(released, true); assert.equal(renewals, 1);
  await new ToolGatewayStateStore(db as never).setEnabled("write", false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(renewals, 1, "no heartbeat timer was scheduled behind the hung renewal");
});

test("failed durable acquire does not leak a process-local owner", async () => {
  const db = { async query(sql: string) {
    if (sql.includes("INSERT INTO tool_gateway_leases")) return { rows: [] };
    if (sql.includes("SELECT EXISTS")) return { rows: [{ has_live_leases: false }] };
    return { rows: [] };
  } };
  const { ToolGatewayStateStore } = await import("../dist/tools/gateway.js");
  const acquiring = new ToolGatewayStateStore(db as never);
  assert.equal(await acquiring.acquireLease("never-acquired", 10), null);
  await new ToolGatewayStateStore(db as never).setEnabled("never-acquired", false);
});

test("release failure removes the local fence only after work has settled", async () => {
  let enabled = true;
  const db = { async query(sql: string, values: unknown[] = []) {
    if (sql.includes("ON CONFLICT (tool_name) DO UPDATE SET enabled")) { enabled = Boolean(values[1]); return { rows: [] }; }
    if (sql.includes("INSERT INTO tool_gateway_leases")) return { rows: [{ generation: 3 }] };
    if (sql.includes("SET released_at")) throw new Error("release unavailable");
    if (sql.includes("SELECT EXISTS")) return { rows: [{ has_live_leases: false }] };
    if (sql.includes("WHERE tool_name = $1")) return { rows: [{ tool_name: "release-fails", enabled, breaker_state: "closed", consecutive_errors: 0, probe_after: null, generation: 3 }] };
    return { rows: [] };
  } };
  const { ToolGateway, ToolGatewayStateStore } = await import("../dist/tools/gateway.js");
  const registry = new ToolManifestRegistry(); registry.register(manifest("release-fails", { sideEffect: true }));
  let settle!: () => void;
  const running = new ToolGateway(registry, { stateStore: new ToolGatewayStateStore(db as never) })
    .execute("release-fails", async () => { await new Promise<void>((resolve) => { settle = resolve; }); });
  await new Promise((resolve) => setImmediate(resolve));
  let killed = false;
  const killing = new ToolGatewayStateStore(db as never).setEnabled("release-fails", false).then(() => { killed = true; });
  await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(killed, false);
  settle(); await assert.rejects(running, /release unavailable/); await killing; assert.equal(killed, true);
});

test("cooperative abort releases the durable lease after timeout", async () => {
  const events: string[] = [];
  const store = {
    get: async () => ({ tool_name: "write", enabled: true, breaker_state: "closed", consecutive_errors: 0, probe_after: null, generation: 2 }),
    acquireLease: async () => ({ ownerId: "00000000-0000-4000-8000-000000000001", generation: 2 }),
    releaseLease: async () => { events.push("released"); }, recordSuccess: async () => {}, recordFailure: async () => ({}), claimProbe: async () => false,
  };
  const registry = new ToolManifestRegistry(); registry.register(manifest("write", { sideEffect: true, timeoutMs: 10 }));
  const { ToolGateway } = await import("../dist/tools/gateway.js");
  await assert.rejects(new ToolGateway(registry, { stateStore: store as never }).execute("write", async (signal: AbortSignal) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }), /timed out/i);
  await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(events, ["released"]);
});

test("concurrent side effects hold independent owner leases", async () => {
  const owners = new Set<string>(); let max = 0;
  const store = {
    get: async () => ({ tool_name: "write", enabled: true, breaker_state: "closed", consecutive_errors: 0, probe_after: null, generation: 3 }),
    acquireLease: async () => { const ownerId = crypto.randomUUID(); owners.add(ownerId); max = Math.max(max, owners.size); return { ownerId, generation: 3 }; },
    releaseLease: async (_name: string, ownerId: string) => { owners.delete(ownerId); },
    recordSuccess: async () => {}, recordFailure: async () => ({}), claimProbe: async () => false,
  };
  const registry = new ToolManifestRegistry(); registry.register(manifest("write", { sideEffect: true }));
  const { ToolGateway } = await import("../dist/tools/gateway.js"); const gateway = new ToolGateway(registry, { stateStore: store as never });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const runs = [gateway.execute("write", async () => gate), gateway.execute("write", async () => gate)];
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(max, 2);
  release(); await Promise.all(runs); assert.equal(owners.size, 0);
});

test("lease renewal is owner-, generation-, and unreleased-state safe", async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db = { async query(sql: string, values: unknown[]) {
    queries.push({ sql, values });
    return { rows: [{ renewed: true }] };
  } };
  const { ToolGatewayStateStore } = await import("../dist/tools/gateway.js");
  const renewed = await new ToolGatewayStateStore(db as never).renewLease("write", "00000000-0000-4000-8000-000000000021", 9, 3000);
  assert.equal(renewed, true);
  assert.match(queries[0]!.sql, /tool_name = \$1[\s\S]*owner_id = \$2::uuid[\s\S]*generation = \$3[\s\S]*released_at IS NULL/);
  assert.deepEqual(queries[0]!.values, ["write", "00000000-0000-4000-8000-000000000021", 9, 3000]);
});

test("stale breaker completions are generation-safe and only probe owner may close", async () => {
  const sql: string[] = [];
  const db = { async query(text: string) { sql.push(text); return { rows: [], rowCount: 0 }; } };
  const { ToolGatewayStateStore } = await import("../dist/tools/gateway.js");
  const store = new ToolGatewayStateStore(db as never);
  await store.recordSuccess("remote", 7, true);
  await store.recordFailure("remote", 3, 1000, 7, true);
  assert.match(sql[0]!, /generation = \$2[\s\S]*breaker_state = 'half_open'/);
  assert.match(sql[1]!, /generation = \$4[\s\S]*breaker_state = 'half_open'/);
});

test("MCP policies load canonically from DB and every preflight failure is audited", async () => {
  const db = { async query(_sql: string, values: unknown[]) { return { rows: values[0] === "main" ? [{
    name: "main", url: "http://127.0.0.1/rpc", transport: "http", allowed_tools: ["search"],
    secret_record_ids: ["sec_mcp"], timeout_ms: 500, max_result_bytes: 2048, enabled: true,
  }] : [] }; } };
  const repository = new McpServerPolicyRepository(db as never);
  const loaded = await repository.getEnabled("main"); assert.equal(loaded?.adminAdded, true);
  const audits: Record<string, unknown>[] = [];
  const invoker = new McpHttpInvoker({
    policies: repository,
    gatewayFactory: () => ({ validate: async () => { throw new Error("SSRF blocked"); }, request: async () => { throw new Error("unused"); } }) as never,
    secrets: { get: async () => null } as never,
    audit: { record: async (entry) => { audits.push(entry); } },
  });
  await assert.rejects(invoker.invokeServer("main", "search", {}), /SSRF/);
  await assert.rejects(invoker.invokeServer("missing", "search", {}), /not found|disabled/i);
  assert.equal(audits.length, 2);
  assert.deepEqual(audits.map((entry) => entry.stage), ["validation", "policy_load"]);
});

test("MCP policy repository CRUD preserves exact HTTP policy and rejects wildcard/stdio", async () => {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const db = { async query(sql: string, values: unknown[] = []) { writes.push({ sql, values }); return { rows: [{ id: 4, name: values[0], enabled: false }] }; } };
  const repository = new McpServerPolicyRepository(db as never);
  await assert.rejects(repository.create({ name: "bad", url: "https://x.test", transport: "stdio" as never, allowedTools: ["x"], secretIds: ["s"], timeoutMs: 500, maxResultBytes: 10, createdBy: "00000000-0000-0000-0000-000000000001" }), /HTTP|SSE/);
  await assert.rejects(repository.create({ name: "bad", url: "https://x.test", transport: "http", allowedTools: ["*"], secretIds: ["s"], timeoutMs: 500, maxResultBytes: 10, createdBy: "00000000-0000-0000-0000-000000000001" }), /wildcard/i);
  await repository.create({ name: "exact", url: "https://x.test/rpc", transport: "sse", allowedTools: ["lookup"], secretIds: ["sec-1"], timeoutMs: 500, maxResultBytes: 2048, createdBy: "00000000-0000-0000-0000-000000000001" });
  assert.match(writes[0]!.sql, /INSERT INTO mcp_server_policies/);
  assert.deepEqual(writes[0]!.values.slice(0, 7), ["exact", "https://x.test/rpc", "sse", ["lookup"], ["sec-1"], 500, 2048]);
});
