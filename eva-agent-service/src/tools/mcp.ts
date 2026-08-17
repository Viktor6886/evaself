/**
 * Политики MCP-серверов и их вызов.
 *
 * Это продуктовая интеграция, а не выбор инструментов моделью: список
 * серверов и разрешённых на них инструментов заводит администратор, а
 * секреты приходят из Secret Store. Проверки здесь — авторизация и
 * валидация обращения к внешнему сервису; выбором того, какой инструмент
 * увидит модель, этот модуль не занимается.
 */

import { OutboundGateway } from "../admin/outbound-gateway.js";
import type { SecretStore } from "../admin/secret-store.js";
import type { Database } from "../db.js";

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
