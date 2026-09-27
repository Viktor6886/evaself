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

/** Инструмент, объявленный сервером в ответе `tools/list`. */
export interface McpDiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Версия протокола, которую Evaself предлагает серверу. Сервер отвечает
 * своей; её мы и шлём дальше в заголовке `MCP-Protocol-Version`.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_LIST_PAGES = 10;
const MAX_LISTED_TOOLS = 200;
/** Сессия MCP живёт на сервере; наша копия идентификатора — не дольше. */
const SESSION_TTL_MS = 10 * 60_000;

class McpRpcError extends Error {
  constructor(message: string, readonly rpcCode: number | null, readonly httpStatus: number | null) {
    super(message);
    this.name = "McpRpcError";
  }
}

interface McpSession { id: string | null; protocolVersion: string; expiresAt: number }

/**
 * Вызов MCP-сервера по Streamable HTTP.
 *
 * Раньше сюда уходил голый `tools/call` без рукопожатия. Сервер со
 * своей сессией отвечал на него «нет сессии», а ответ потоком
 * (`text/event-stream`) не разбирался вовсе. Теперь обращение идёт по
 * протоколу: `initialize` → `notifications/initialized` → запрос с
 * `Mcp-Session-Id`; истёкшая сессия (HTTP 404) переоткрывается один раз.
 * Сервер без `initialize` (простой JSON-RPC) работает как прежде — без
 * сессии.
 */
export class McpHttpInvoker {
  private readonly sessions = new Map<string, McpSession>();

  constructor(private readonly dependencies: { gatewayFactory?: (options: { timeoutMs: number; maxBodyBytes: number }) => Pick<OutboundGateway, "validate" | "request">; secrets: Pick<SecretStore, "get">; audit: McpAudit; policies?: McpServerPolicyRepository; now?: () => number }) {}

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

  /**
   * Что сервер объявляет сам: `tools/list` со всеми страницами.
   *
   * Список не расширяет права: действующий набор — пересечение
   * объявленного с разрешённым администратором (`effectiveMcpTools`).
   */
  async listTools(serverName: string): Promise<McpDiscoveredTool[]> {
    const started = Date.now(); let stage = "policy_load";
    try {
      const policy = await this.dependencies.policies?.getEnabled(serverName);
      if (!policy) throw new Error("MCP server policy not found or disabled");
      const tools: McpDiscoveredTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result = await this.rpc(serverName, policy, "tools/list", cursor ? { cursor } : {}, (value) => { stage = value; }) as { tools?: unknown; nextCursor?: unknown };
        for (const raw of Array.isArray(result?.tools) ? result.tools : []) {
          const tool = discoveredTool(raw);
          if (tool && tools.length < MAX_LISTED_TOOLS) tools.push(tool);
        }
        cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
        if (!cursor || tools.length >= MAX_LISTED_TOOLS) break;
      }
      await this.dependencies.audit.record({ operation: "mcp.tools.list", server: serverName, ok: true, stage: "complete", count: tools.length, duration_ms: Date.now() - started });
      return tools;
    } catch (error) {
      await this.dependencies.audit.record({ operation: "mcp.tools.list", server: serverName, ok: false, stage, duration_ms: Date.now() - started });
      throw error;
    }
  }

  private async invokeAttempt(policy: McpServerPolicy, toolName: string, args: Record<string, unknown>, started: number, serverName: string | undefined, setStage: (stage: string) => void): Promise<unknown> {
    if (!policy.allowedTools.includes(toolName)) throw new Error(`MCP tool ${toolName} is outside the explicit allowlist`);
    const result = await this.rpc(serverName ?? policy.url, policy, "tools/call", { name: toolName, arguments: args }, setStage);
    await this.dependencies.audit.record({ operation: "mcp.tool.call", server: serverName ?? new URL(policy.url).host, tool: toolName, ok: true, stage: "complete", duration_ms: Date.now() - started });
    return result;
  }

  private async rpc(sessionKey: string, policy: McpServerPolicy, method: string, params: Record<string, unknown>, setStage: (stage: string) => void): Promise<unknown> {
    const gateway = (this.dependencies.gatewayFactory ?? ((options) => new OutboundGateway(options)))({ timeoutMs: policy.timeoutMs, maxBodyBytes: policy.maxResultBytes });
    setStage("validation"); const valid = await validateMcpServerPolicy(policy, gateway);
    setStage("secret"); const secrets = await Promise.all(policy.secretIds.map((ref) => this.dependencies.secrets.get(ref))); if (secrets.some((value) => value === null)) throw new Error("MCP Secret Store reference is missing");
    const token = secrets[0]!;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      setStage("session");
      const session = await this.session(sessionKey, gateway, valid.validatedUrl, token);
      setStage("request");
      try {
        return await this.post(gateway, valid.validatedUrl, token, session, method, params);
      } catch (error) {
        // Сервер забыл сессию — открываем новую, но один раз: повторный
        // отказ означает не истёкшую сессию, а поломку сервера.
        if (error instanceof McpRpcError && error.httpStatus === 404 && session.id && attempt === 0) {
          this.sessions.delete(sessionKey);
          continue;
        }
        throw error;
      }
    }
    throw new Error("MCP session could not be established");
  }

  private async session(key: string, gateway: Pick<OutboundGateway, "request">, url: string, token: string): Promise<McpSession> {
    const now = (this.dependencies.now ?? Date.now)();
    const cached = this.sessions.get(key);
    if (cached && cached.expiresAt > now) return cached;
    const draft: McpSession = { id: null, protocolVersion: MCP_PROTOCOL_VERSION, expiresAt: now + SESSION_TTL_MS };
    let initialized: { result: unknown; sessionId: string | null };
    try {
      initialized = await this.exchange(gateway, url, token, draft, "initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "evaself", version: "0.3.0" },
      });
    } catch (error) {
      // Простой JSON-RPC без рукопожатия: работаем без сессии, как прежде.
      if (error instanceof McpRpcError && (error.rpcCode === -32601 || error.httpStatus === 404 || error.httpStatus === 405)) {
        this.sessions.set(key, draft);
        return draft;
      }
      throw error;
    }
    const result = initialized.result as { protocolVersion?: unknown } | null;
    const session: McpSession = {
      id: initialized.sessionId,
      protocolVersion: typeof result?.protocolVersion === "string" ? result.protocolVersion : MCP_PROTOCOL_VERSION,
      expiresAt: draft.expiresAt,
    };
    // Уведомление без ответа: сервер отвечает 202. Его отказ не мешает
    // работе серверов, которые уведомление не ждут.
    await gateway.request(url, { method: "POST", headers: this.headers(token, session), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).catch(() => undefined);
    this.sessions.set(key, session);
    return session;
  }

  private async post(gateway: Pick<OutboundGateway, "request">, url: string, token: string, session: McpSession, method: string, params: Record<string, unknown>): Promise<unknown> {
    return (await this.exchange(gateway, url, token, session, method, params)).result;
  }

  private async exchange(gateway: Pick<OutboundGateway, "request">, url: string, token: string, session: McpSession, method: string, params: Record<string, unknown>): Promise<{ result: unknown; sessionId: string | null }> {
    const id = crypto.randomUUID();
    const response = await gateway.request(url, { method: "POST", headers: this.headers(token, session), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    if (!response.ok) throw new McpRpcError(`MCP server returned HTTP ${response.status}`, null, response.status);
    const payload = rpcPayload(response.headers.get("content-type") ?? "", new TextDecoder().decode(response.body), id);
    if (payload.error) throw new McpRpcError(payload.error.message ?? "MCP call failed", typeof payload.error.code === "number" ? payload.error.code : null, null);
    return { result: payload.result, sessionId: response.headers.get("mcp-session-id") };
  }

  private headers(token: string, session: McpSession): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(session.id ? { "mcp-session-id": session.id, "mcp-protocol-version": session.protocolVersion } : {}),
    };
  }
}

type RpcPayload = { id?: unknown; result?: unknown; error?: { message?: string; code?: unknown } };

/**
 * Ответ JSON-RPC из тела: обычный JSON или поток событий, в котором
 * ответ на наш `id` — одно из сообщений.
 */
function rpcPayload(contentType: string, body: string, id: string): RpcPayload {
  if (!contentType.includes("text/event-stream")) {
    try { return JSON.parse(body) as RpcPayload; } catch { throw new McpRpcError("MCP response is not JSON", null, null); }
  }
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try {
      const message = JSON.parse(data) as RpcPayload;
      if (message.id === id) return message;
    } catch {
      // Не JSON — чужое событие потока, пропускаем.
    }
  }
  throw new McpRpcError("MCP stream ended without a response", null, null);
}

const MCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_SCHEMA_BYTES = 16 * 1024;

/**
 * Проверка объявленного инструмента. Имя и схема — чужие данные: имя
 * должно годиться в имя инструмента, схема — быть объектом разумного
 * размера. Остальное отклоняется, а не чинится.
 */
function discoveredTool(raw: unknown): McpDiscoveredTool | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { name, description, inputSchema } = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
  if (typeof name !== "string" || !MCP_TOOL_NAME.test(name)) return null;
  const schema = inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)
    ? inputSchema as Record<string, unknown>
    : { type: "object" };
  if (schema.type !== undefined && schema.type !== "object") return null;
  if (Buffer.byteLength(JSON.stringify(schema)) > MAX_SCHEMA_BYTES) return null;
  return {
    name,
    description: typeof description === "string" ? description.slice(0, 1_024) : "",
    inputSchema: { type: "object", ...schema },
  };
}
