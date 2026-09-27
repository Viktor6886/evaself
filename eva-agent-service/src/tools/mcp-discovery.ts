/**
 * Обнаружение инструментов MCP-серверов.
 *
 * Сервер сам объявляет свои инструменты (`tools/list`): имя, описание и
 * схему аргументов. Администратор разрешает имена явно. Действующий
 * набор — пересечение: объявленное сервером и разрешённое администратором.
 * Ни то, ни другое по отдельности инструмента не создаёт: разрешённое, но
 * не объявленное — опечатка или удалённый инструмент; объявленное, но не
 * разрешённое — чужая возможность, на которую согласия не было. Шаблон
 * `*` запрещён и здесь, а не только при сохранении политики.
 *
 * Результат — восстановимое состояние процесса, а не данные: он живёт в
 * памяти и обновляется по сроку. Ход не ждёт медленного сервера: старый
 * список отдаётся сразу, свежий запрашивается в фоне. Первый запрос ждёт
 * ограниченное время; не успел — в этом ходе инструментов сервера нет.
 */

import type { Logger } from "../logger.js";
import type { McpDiscoveredTool, McpHttpInvoker, McpServerPolicy } from "./mcp.js";

export type McpDiscoveryState = "pending" | "ok" | "error";

export interface McpServerDiscovery {
  server: string;
  state: McpDiscoveryState;
  discoveredAt: string | null;
  checkedAt: string | null;
  /** Код отказа, без текста ответа сервера. */
  error: string | null;
  durationMs: number | null;
  discovered: McpDiscoveredTool[];
  allowed: string[];
  effective: McpDiscoveredTool[];
  /** Разрешено администратором, но сервер такого не объявил. */
  missing: string[];
}

export function effectiveMcpTools(discovered: readonly McpDiscoveredTool[], allowed: readonly string[]): {
  effective: McpDiscoveredTool[];
  missing: string[];
} {
  if (allowed.some((name) => name.includes("*"))) {
    throw new Error("MCP wildcard allowlist is forbidden");
  }
  const allow = new Set(allowed.map((name) => name.trim()).filter(Boolean));
  const effective = discovered.filter((tool) => allow.has(tool.name));
  const present = new Set(discovered.map((tool) => tool.name));
  return { effective, missing: [...allow].filter((name) => !present.has(name)).sort() };
}

interface Entry {
  state: McpDiscoveryState;
  discovered: McpDiscoveredTool[];
  discoveredAt: number | null;
  checkedAt: number | null;
  error: string | null;
  durationMs: number | null;
  inFlight: Promise<void> | null;
  allowed: string[];
}

export class McpDiscovery {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: {
    invoker: Pick<McpHttpInvoker, "listTools">;
    ttlMs: number;
    /** Сколько первый запрос готов ждать, прежде чем ход пойдёт без сервера. */
    firstLoadTimeoutMs?: number;
    /** Пауза после отказа, чтобы упавший сервер не опрашивался на каждом ходе. */
    errorBackoffMs?: number;
    now?: () => number;
    logger?: Logger;
    onResult?(outcome: "ok" | "error", durationMs: number): void;
  }) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Действующие инструменты сервера для открывающейся сессии. */
  async effective(server: string, policy: Pick<McpServerPolicy, "allowedTools">): Promise<McpDiscoveredTool[]> {
    const entry = this.entry(server);
    entry.allowed = [...policy.allowedTools];
    const now = this.now();
    const fresh = entry.checkedAt !== null
      && now - entry.checkedAt < (entry.state === "error" ? this.deps.errorBackoffMs ?? 60_000 : this.deps.ttlMs);
    if (!fresh) {
      const refresh = this.start(server, entry);
      if (entry.discoveredAt === null) {
        // Первая загрузка: ждём, но не дольше предела. Опоздавший ответ
        // всё равно ляжет в кэш и достанется следующей сессии.
        const limit = this.deps.firstLoadTimeoutMs ?? 5_000;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          refresh,
          new Promise<void>((resolve) => { timer = setTimeout(resolve, limit); timer.unref?.(); }),
        ]);
        if (timer) clearTimeout(timer);
      }
    }
    return effectiveMcpTools(entry.discovered, entry.allowed).effective;
  }

  /** Принудительное обновление — из панели. */
  async refresh(server: string, policy: Pick<McpServerPolicy, "allowedTools">): Promise<McpServerDiscovery> {
    const entry = this.entry(server);
    entry.allowed = [...policy.allowedTools];
    await this.start(server, entry);
    return this.view(server, entry);
  }

  /** Серверы, которых больше нет среди включённых, забываются. */
  retain(servers: Iterable<string>): void {
    const keep = new Set(servers);
    for (const server of [...this.entries.keys()]) if (!keep.has(server)) this.entries.delete(server);
  }

  snapshot(): McpServerDiscovery[] {
    return [...this.entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([server, entry]) => this.view(server, entry));
  }

  private entry(server: string): Entry {
    let entry = this.entries.get(server);
    if (!entry) {
      entry = { state: "pending", discovered: [], discoveredAt: null, checkedAt: null, error: null, durationMs: null, inFlight: null, allowed: [] };
      this.entries.set(server, entry);
    }
    return entry;
  }

  private start(server: string, entry: Entry): Promise<void> {
    if (entry.inFlight) return entry.inFlight;
    const started = this.now();
    entry.inFlight = this.deps.invoker.listTools(server).then((tools) => {
      entry.state = "ok";
      entry.discovered = tools;
      entry.discoveredAt = this.now();
      entry.error = null;
      this.deps.onResult?.("ok", this.now() - started);
    }, (error: unknown) => {
      // Последний удачный список остаётся: сервер, моргнувший на
      // обновлении, не должен отнимать инструменты у идущих разговоров.
      // Вызов к недоступному серверу откажет сам.
      entry.state = "error";
      entry.error = errorCode(error);
      this.deps.onResult?.("error", this.now() - started);
      this.deps.logger?.warn("MCP discovery не удался", { server, code: entry.error });
    }).finally(() => {
      entry.checkedAt = this.now();
      entry.durationMs = this.now() - started;
      entry.inFlight = null;
    });
    return entry.inFlight;
  }

  private view(server: string, entry: Entry): McpServerDiscovery {
    const { effective, missing } = effectiveMcpTools(entry.discovered, entry.allowed);
    return {
      server,
      state: entry.state,
      discoveredAt: entry.discoveredAt === null ? null : new Date(entry.discoveredAt).toISOString(),
      checkedAt: entry.checkedAt === null ? null : new Date(entry.checkedAt).toISOString(),
      error: entry.error,
      durationMs: entry.durationMs,
      discovered: entry.discovered,
      allowed: [...entry.allowed],
      effective,
      missing,
    };
  }
}

/**
 * Код отказа для панели. Текст ошибки может содержать ответ сервера —
 * наружу уходит только распознанная причина.
 */
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const http = /HTTP (\d{3})/.exec(message);
  if (http) return `http_${http[1]}`;
  if (/policy not found/i.test(message)) return "policy_disabled";
  if (/Secret Store/i.test(message)) return "secret_missing";
  if (/timeout|timed out|aborted/i.test(message) || (error instanceof Error && /Timeout|Abort/.test(error.name))) return "timeout";
  if (/not JSON|stream ended/i.test(message)) return "invalid_response";
  if (error instanceof Error && error.name === "McpRpcError") return "rpc_error";
  if (error instanceof Error && /AdminApiError/.test(error.name)) return "blocked_url";
  return "unreachable";
}
