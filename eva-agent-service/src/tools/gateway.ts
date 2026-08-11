import type { PermissionMode } from "@letta-ai/letta-agent-sdk";

import { OutboundGateway } from "../admin/outbound-gateway.js";
import type { SecretStore } from "../admin/secret-store.js";
import type { Database } from "../db.js";

export const TOOL_RISKS = ["read", "low_risk_write", "sensitive_write", "external_side_effect", "destructive"] as const;
export type ToolRisk = typeof TOOL_RISKS[number];

export interface ToolManifest {
  name: string; version: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  owner: string; purposes: string[]; risk: ToolRisk; approvalRequired: boolean; idempotent: boolean;
  timeoutMs: number; limits: { maxResultBytes: number }; sideEffect: boolean;
}

export class ToolManifestRegistry {
  private readonly manifests = new Map<string, ToolManifest>();
  register(manifest: ToolManifest): void {
    if (this.manifests.has(manifest.name)) throw new Error(`Tool already registered: ${manifest.name}`);
    if (!manifest.name || !manifest.version || manifest.timeoutMs < 1 || manifest.limits.maxResultBytes < 1) throw new Error("Invalid tool manifest");
    this.manifests.set(manifest.name, Object.freeze({ ...manifest, purposes: [...manifest.purposes] }));
  }
  get(name: string): ToolManifest | undefined { return this.manifests.get(name); }
  list(): ToolManifest[] { return [...this.manifests.values()]; }
}

interface GatewayStateRow {
  tool_name: string; enabled: boolean; breaker_state: "closed" | "open" | "half_open";
  consecutive_errors: number; probe_after: Date | null; generation: number;
}

// This supplements durable leases for one service process. Other replicas cannot see it and still rely on renewal + TTL.
const processLocalLeaseOwners = new Map<string, Set<string>>();
function registerProcessLocalOwner(name: string, ownerId: string): void {
  const owners = processLocalLeaseOwners.get(name) ?? new Set<string>();
  owners.add(ownerId); processLocalLeaseOwners.set(name, owners);
}
function unregisterProcessLocalOwner(name: string, ownerId: string): void {
  const owners = processLocalLeaseOwners.get(name); if (!owners) return;
  owners.delete(ownerId); if (owners.size === 0) processLocalLeaseOwners.delete(name);
}
function hasProcessLocalOwners(name: string): boolean { return (processLocalLeaseOwners.get(name)?.size ?? 0) > 0; }

export class ToolGatewayStateStore {
  constructor(private readonly db: Pick<Database, "query">) {}
  async list(): Promise<GatewayStateRow[]> {
    const { rows } = await this.db.query<GatewayStateRow>(`SELECT tool_name, enabled, breaker_state, consecutive_errors, probe_after, generation FROM tool_gateway_state ORDER BY tool_name`);
    return rows;
  }
  async get(name: string): Promise<GatewayStateRow | null> {
    const { rows } = await this.db.query<GatewayStateRow>(`SELECT tool_name, enabled, breaker_state, consecutive_errors, probe_after, generation FROM tool_gateway_state WHERE tool_name = $1`, [name]);
    return rows[0] ?? null;
  }
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.db.query(`INSERT INTO tool_gateway_state (tool_name, enabled, generation) VALUES ($1, $2, 1)
      ON CONFLICT (tool_name) DO UPDATE SET enabled = $2, generation = tool_gateway_state.generation + 1, updated_at = now()`, [name, enabled]);
    if (!enabled) {
      // The durable kill is already visible; crashed owners age out by TTL.
      for (;;) {
        await this.db.query(`DELETE FROM tool_gateway_leases WHERE tool_name = $1 AND released_at IS NULL AND expires_at <= now()`, [name]);
        const { rows } = await this.db.query<{ has_live_leases: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM tool_gateway_leases WHERE tool_name = $1 AND released_at IS NULL AND expires_at > now()
        ) AS has_live_leases`, [name]);
        if (!rows[0]?.has_live_leases && !hasProcessLocalOwners(name)) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }
  async acquireLease(name: string, ttlMs: number): Promise<{ ownerId: string; generation: number } | null> {
    const ownerId = crypto.randomUUID();
    const { rows } = await this.db.query<{ generation: number }>(`WITH state AS (
      INSERT INTO tool_gateway_state (tool_name) VALUES ($1)
      ON CONFLICT (tool_name) DO UPDATE SET updated_at = tool_gateway_state.updated_at
      WHERE tool_gateway_state.enabled RETURNING generation
    ) INSERT INTO tool_gateway_leases (owner_id, tool_name, generation, expires_at)
      SELECT $2::uuid, $1, generation, now() + make_interval(secs => $3::double precision / 1000) FROM state
      RETURNING generation`, [name, ownerId, ttlMs]);
    if (!rows[0]) return null;
    registerProcessLocalOwner(name, ownerId);
    return { ownerId, generation: rows[0].generation };
  }
  async releaseLease(name: string, ownerId: string): Promise<void> {
    try {
      await this.db.query(`UPDATE tool_gateway_leases SET released_at = now() WHERE tool_name = $1 AND owner_id = $2::uuid AND released_at IS NULL`, [name, ownerId]);
    } finally {
      unregisterProcessLocalOwner(name, ownerId);
    }
  }
  async renewLease(name: string, ownerId: string, generation: number, ttlMs: number): Promise<boolean> {
    const { rows } = await this.db.query<{ renewed: boolean }>(`UPDATE tool_gateway_leases
      SET expires_at = now() + make_interval(secs => $4::double precision / 1000)
      WHERE tool_name = $1 AND owner_id = $2::uuid AND generation = $3 AND released_at IS NULL
      RETURNING true AS renewed`, [name, ownerId, generation, ttlMs]);
    return rows[0]?.renewed === true;
  }
  async recordFailure(name: string, threshold: number, cooldownMs: number, generation?: number, probe = false): Promise<GatewayStateRow> {
    const { rows } = await this.db.query<GatewayStateRow>(`INSERT INTO tool_gateway_state (tool_name, consecutive_errors) VALUES ($1, 1)
      ON CONFLICT (tool_name) DO UPDATE SET
        consecutive_errors = tool_gateway_state.consecutive_errors + 1,
        breaker_state = CASE WHEN tool_gateway_state.consecutive_errors + 1 >= $2 THEN 'open' ELSE tool_gateway_state.breaker_state END,
        opened_at = CASE WHEN tool_gateway_state.consecutive_errors + 1 >= $2 THEN now() ELSE tool_gateway_state.opened_at END,
        probe_after = CASE WHEN tool_gateway_state.consecutive_errors + 1 >= $2 THEN now() + make_interval(secs => $3::double precision / 1000) ELSE tool_gateway_state.probe_after END,
        generation = CASE WHEN tool_gateway_state.consecutive_errors + 1 >= $2 THEN tool_gateway_state.generation + 1 ELSE tool_gateway_state.generation END,
        updated_at = now()
      WHERE ($4::bigint IS NULL OR tool_gateway_state.generation = $4) AND (NOT $5::boolean OR tool_gateway_state.breaker_state = 'half_open')
      RETURNING tool_name, enabled, breaker_state, consecutive_errors, probe_after, generation`, [name, threshold, cooldownMs, generation ?? null, probe]);
    return rows[0]!;
  }
  async claimProbe(name: string): Promise<number | true | false> {
    const { rows } = await this.db.query<{ generation: number }>(`UPDATE tool_gateway_state SET breaker_state = 'half_open', generation = generation + 1, updated_at = now()
      WHERE tool_name = $1 AND enabled AND breaker_state = 'open' AND probe_after <= now() RETURNING generation`, [name]);
    return rows.length ? (rows[0]?.generation ?? true) : false;
  }
  async recordSuccess(name: string, generation?: number, probe = false): Promise<void> {
    await this.db.query(`UPDATE tool_gateway_state SET breaker_state = 'closed', consecutive_errors = 0, opened_at = NULL, probe_after = NULL, updated_at = now()
      WHERE tool_name = $1 AND ($2::bigint IS NULL OR generation = $2) AND (NOT $3::boolean OR breaker_state = 'half_open')`, [name, generation ?? null, probe]);
  }
}

export class ToolGateway {
  private readonly disabled = new Set<string>();
  private readonly failures = new Map<string, { count: number; openedAt: number | null }>();
  private readonly threshold: number; private readonly cooldownMs: number; private readonly stateStore?: ToolGatewayStateStore; private readonly leaseTtlMs?: number;
  constructor(private readonly registry: ToolManifestRegistry, options: { breakerThreshold?: number; breakerCooldownMs?: number; stateStore?: ToolGatewayStateStore; leaseTtlMs?: number } = {}) {
    this.threshold = Math.max(1, options.breakerThreshold ?? 3); this.cooldownMs = Math.max(1, options.breakerCooldownMs ?? 30_000); this.stateStore = options.stateStore; this.leaseTtlMs = options.leaseTtlMs;
  }
  async kill(name: string): Promise<void> { this.require(name); await this.stateStore?.setEnabled(name, false); this.disabled.add(name); }
  async enable(name: string): Promise<void> { this.require(name); await this.stateStore?.setEnabled(name, true); this.disabled.delete(name); }
  async execute<T>(name: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const manifest = this.require(name);
    if (this.disabled.has(name)) throw new Error(`Tool ${name} is disabled by kill switch`);
    const durable = await this.stateStore?.get(name);
    if (durable?.enabled === false) throw new Error(`Tool ${name} is disabled by kill switch`);
    if (durable?.breaker_state === "half_open") throw new Error(`Tool ${name} circuit is open`);
    let generation = durable?.generation; let probe = false;
    if (durable?.breaker_state === "open") {
      if (!durable.probe_after || durable.probe_after.getTime() > Date.now()) throw new Error(`Tool ${name} circuit is open`);
      const claim = await this.stateStore!.claimProbe(name); if (claim === false) throw new Error(`Tool ${name} circuit is open`);
      generation = typeof claim === "number" ? claim : generation; probe = true;
    }
    const local = this.failures.get(name);
    if (local?.openedAt != null && Date.now() - local.openedAt < this.cooldownMs) throw new Error(`Tool ${name} circuit is open`);
    let lease: { ownerId: string; generation: number } | null = null;
    const leaseTtlMs = this.leaseTtlMs ?? Math.max(manifest.timeoutMs * 2, 1_000);
    if (manifest.sideEffect && this.stateStore) {
      lease = await this.stateStore.acquireLease(name, leaseTtlMs);
      if (lease === null) throw new Error(`Tool ${name} is disabled by kill switch`);
      generation = lease.generation;
    }
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined; let heartbeatStopped = false;
    let timedOut = false; let workSettled = false; let workPromise: Promise<T> | undefined;
    const stopHeartbeat = () => { heartbeatStopped = true; if (heartbeat) { clearTimeout(heartbeat); heartbeat = undefined; } };
    const release = async () => { if (lease) { stopHeartbeat(); const owned = lease; lease = null; await this.stateStore!.releaseLease(name, owned.ownerId); } };
    const scheduleHeartbeat = () => {
      if (!lease || heartbeatStopped) return;
      heartbeat = setTimeout(() => { void heartbeatTick(); }, Math.max(1, Math.floor(leaseTtlMs / 3)));
      heartbeat.unref?.();
    };
    const heartbeatTick = async () => {
      heartbeat = undefined;
      if (!lease || heartbeatStopped) return;
      const owned = lease;
      try {
        const renewed = await this.stateStore!.renewLease(name, owned.ownerId, owned.generation, leaseTtlMs);
        if (!renewed && !controller.signal.aborted) controller.abort(new Error(`Tool ${name} lost its durable lease`));
      } catch (error) {
        // A transient store failure must not be interpreted as release; retain ownership and retry until settlement.
        if (!controller.signal.aborted) controller.abort(error);
      }
      scheduleHeartbeat();
    };
    scheduleHeartbeat();
    try {
      const timeoutError = new Error(`Tool ${name} timed out after ${manifest.timeoutMs}ms`);
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { timedOut = true; controller.abort(timeoutError); reject(timeoutError); }, manifest.timeoutMs);
      });
      workPromise = Promise.resolve().then(() => work(controller.signal));
      void workPromise.then(() => { workSettled = true; if (timedOut) void release().catch(() => {}); }, () => { workSettled = true; if (timedOut) void release().catch(() => {}); });
      const result = await Promise.race([workPromise, timeoutPromise]);
      const serialized = JSON.stringify(result);
      const resultBytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
      if (resultBytes > manifest.limits.maxResultBytes) {
        throw new Error(`Tool ${name} result exceeds ${manifest.limits.maxResultBytes} byte limit (${resultBytes} bytes)`);
      }
      this.failures.delete(name); await this.stateStore?.recordSuccess(name, generation, probe); return result;
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error);
      await this.stateStore?.recordFailure(name, this.threshold, this.cooldownMs, generation, probe);
      const count = (local?.count ?? 0) + 1; this.failures.set(name, { count, openedAt: count >= this.threshold ? Date.now() : null }); throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (!timedOut || workSettled) await release();
    }
  }
  private require(name: string): ToolManifest { const manifest = this.registry.get(name); if (!manifest) throw new Error(`Unknown tool: ${name}`); return manifest; }
}

export function selectVisibleTools(registry: ToolManifestRegistry, input: { purpose: string; taskTools: readonly string[]; skillTools: readonly string[]; allowedTools: readonly string[]; trusted: boolean; requestedByContent?: readonly string[] }): ToolManifest[] {
  const task = new Set(input.taskTools), skill = new Set(input.skillTools), boundary = new Set(input.allowedTools);
  return registry.list().filter((tool) => tool.purposes.includes(input.purpose) && task.has(tool.name) && skill.has(tool.name) && boundary.has(tool.name));
}
export function minimalPermissionMode(input: { requested: PermissionMode; administrative: boolean; isolated: boolean }): PermissionMode {
  if (input.requested !== "unrestricted") return input.requested; return input.administrative || input.isolated ? "unrestricted" : "strict";
}

export interface McpServerPolicy { adminAdded: boolean; transport: "http" | "sse" | "stdio"; url: string; command?: string; allowedTools: string[]; secretIds: string[]; timeoutMs: number; maxResultBytes: number; }
interface McpPolicyRow { name: string; url: string; transport: "http" | "sse"; allowed_tools: string[]; secret_record_ids: string[]; timeout_ms: number; max_result_bytes: number; enabled?: boolean }
export interface McpPolicyWrite extends Omit<McpServerPolicy, "adminAdded" | "command"> { name: string; createdBy: string }

export class McpServerPolicyRepository {
  constructor(private readonly db: Pick<Database, "query">) {}
  async getEnabled(name: string): Promise<McpServerPolicy | null> {
    const { rows } = await this.db.query<McpPolicyRow>(
      `SELECT name, url, transport, allowed_tools, secret_record_ids, timeout_ms, max_result_bytes FROM mcp_server_policies WHERE name = $1 AND enabled`, [name]);
    return rows[0] ? this.policy(rows[0]) : null;
  }
  async listEnabled(): Promise<Array<{ name: string; policy: McpServerPolicy }>> {
    const { rows } = await this.db.query<McpPolicyRow>(`SELECT name, url, transport, allowed_tools, secret_record_ids, timeout_ms, max_result_bytes FROM mcp_server_policies WHERE enabled ORDER BY name`);
    return rows.map((row) => ({ name: row.name, policy: this.policy(row) }));
  }
  async create(input: McpPolicyWrite): Promise<Record<string, unknown>> {
    this.validateWrite(input);
    const { rows } = await this.db.query<Record<string, unknown>>(`INSERT INTO mcp_server_policies (name, url, transport, allowed_tools, secret_record_ids, timeout_ms, max_result_bytes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, url, transport, allowed_tools, secret_record_ids, timeout_ms, max_result_bytes, enabled, created_at, updated_at`,
    [input.name, input.url, input.transport, input.allowedTools, input.secretIds, input.timeoutMs, input.maxResultBytes, input.createdBy]);
    return rows[0]!;
  }
  async update(name: string, input: Omit<McpPolicyWrite, "name" | "createdBy">): Promise<Record<string, unknown>> {
    this.validateWrite({ ...input, name, createdBy: "update" });
    const { rows } = await this.db.query<Record<string, unknown>>(`UPDATE mcp_server_policies SET url=$2, transport=$3, allowed_tools=$4, secret_record_ids=$5, timeout_ms=$6, max_result_bytes=$7
      WHERE name=$1 RETURNING id, name, url, transport, allowed_tools, secret_record_ids, timeout_ms, max_result_bytes, enabled, created_at, updated_at`,
    [name, input.url, input.transport, input.allowedTools, input.secretIds, input.timeoutMs, input.maxResultBytes]);
    if (!rows[0]) throw new Error("MCP server policy not found"); return rows[0];
  }
  async setEnabled(name: string, enabled: boolean): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query<Record<string, unknown>>(`UPDATE mcp_server_policies SET enabled=$2 WHERE name=$1 RETURNING id, name, enabled, updated_at`, [name, enabled]);
    if (!rows[0]) throw new Error("MCP server policy not found"); return rows[0];
  }
  async delete(name: string): Promise<void> { const result = await this.db.query(`DELETE FROM mcp_server_policies WHERE name=$1`, [name]); if (!result.rowCount) throw new Error("MCP server policy not found"); }
  private policy(row: McpPolicyRow): McpServerPolicy { return { adminAdded: true, transport: row.transport, url: row.url, allowedTools: row.allowed_tools, secretIds: row.secret_record_ids.map(String), timeoutMs: row.timeout_ms, maxResultBytes: row.max_result_bytes }; }
  private validateWrite(input: McpPolicyWrite): void {
    if (!input.name.trim() || input.name.includes("*") || !/^[A-Za-z0-9_-]+$/.test(input.name)) throw new Error("Invalid MCP server name");
    if (input.transport !== "http" && input.transport !== "sse") throw new Error("Only HTTP or SSE MCP transports are allowed");
    if (!/^https?:\/\//.test(input.url)) throw new Error("MCP URL must be exact HTTP(S)");
    if (!input.allowedTools.length || input.allowedTools.some((tool) => !tool.trim() || tool.includes("*"))) throw new Error("MCP wildcard or empty allowlist is forbidden");
    if (!input.secretIds.length || input.secretIds.some((id) => !id.trim())) throw new Error("MCP secrets must reference Secret Store records");
    if (input.timeoutMs < 100 || input.timeoutMs > 30_000) throw new Error("MCP timeout is outside policy");
    if (input.maxResultBytes < 1 || input.maxResultBytes > 4 * 1024 * 1024) throw new Error("MCP result cap is outside policy");
  }
}
export async function validateMcpServerPolicy(policy: McpServerPolicy, gateway: Pick<OutboundGateway, "validate">): Promise<McpServerPolicy & { validatedUrl: string }> {
  if (!policy.adminAdded) throw new Error("MCP server must be added by an administrator");
  if (policy.transport !== "http" && policy.transport !== "sse") throw new Error("Only HTTP or SSE MCP transports are allowed");
  if (policy.command || /\bnpx\s+-y\b/i.test(policy.command ?? "")) throw new Error("MCP commands are forbidden");
  if (!policy.allowedTools.length || policy.allowedTools.some((name) => name === "*" || name.includes("*"))) throw new Error("MCP wildcard or empty allowlist is forbidden");
  if (!policy.secretIds.length || policy.secretIds.some((id) => !id.trim())) throw new Error("MCP secrets must reference Secret Store records");
  if (policy.timeoutMs < 100 || policy.timeoutMs > 30_000) throw new Error("MCP timeout is outside policy");
  if (policy.maxResultBytes < 1 || policy.maxResultBytes > 4 * 1024 * 1024) throw new Error("MCP result cap is outside policy");
  const validated = await gateway.validate(policy.url); return { ...policy, validatedUrl: validated.toString() };
}
interface McpAudit { record(entry: Record<string, unknown>): Promise<void> }
export class McpHttpInvoker {
  constructor(private readonly dependencies: { gatewayFactory?: (options: { timeoutMs: number; maxBodyBytes: number }) => Pick<OutboundGateway, "validate" | "request">; secrets: Pick<SecretStore, "get">; audit: McpAudit; policies?: McpServerPolicyRepository }) {}
  async invokeServer(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const started = Date.now(); let stage = "policy_load";
    try { const policy = await this.dependencies.policies?.getEnabled(serverName); if (!policy) throw new Error("MCP server policy not found or disabled"); return await this.invokeAttempt(policy, toolName, args, started, serverName, (value) => { stage = value; }); }
    catch (error) { await this.dependencies.audit.record({ operation: "mcp.tool.call", server: serverName, tool: toolName, ok: false, stage, duration_ms: Date.now() - started }); throw error; }
  }
  async invoke(policy: McpServerPolicy, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const started = Date.now(); let stage = "allowlist";
    try { return await this.invokeAttempt(policy, toolName, args, started, undefined, (value) => { stage = value; }); }
    catch (error) { await this.dependencies.audit.record({ operation: "mcp.tool.call", tool: toolName, ok: false, stage, duration_ms: Date.now() - started }); throw error; }
  }
  private async invokeAttempt(policy: McpServerPolicy, toolName: string, args: Record<string, unknown>, started: number, serverName: string | undefined, setStage: (stage: string) => void): Promise<unknown> {
    if (!policy.allowedTools.includes(toolName)) throw new Error(`MCP tool ${toolName} is outside the explicit allowlist`);
    const gateway = (this.dependencies.gatewayFactory ?? ((options) => new OutboundGateway(options)))({ timeoutMs: policy.timeoutMs, maxBodyBytes: policy.maxResultBytes });
    setStage("validation"); const valid = await validateMcpServerPolicy(policy, gateway);
    setStage("secret"); const secrets = await Promise.all(policy.secretIds.map((ref) => this.dependencies.secrets.get(ref))); if (secrets.some((value) => value === null)) throw new Error("MCP Secret Store reference is missing");
    setStage("request"); const response = await gateway.request(valid.validatedUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secrets[0]!}` }, body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: toolName, arguments: args } }) });
    if (!response.ok) throw new Error(`MCP server returned HTTP ${response.status}`); const payload = response.json<{ result?: unknown; error?: { message?: string } }>(); if (payload.error) throw new Error(payload.error.message ?? "MCP call failed");
    await this.dependencies.audit.record({ operation: "mcp.tool.call", server: serverName ?? new URL(valid.validatedUrl).host, tool: toolName, ok: true, stage: "complete", duration_ms: Date.now() - started }); return payload.result;
  }
}
