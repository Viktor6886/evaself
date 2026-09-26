/**
 * HTTP API browser-service.
 *
 * Вызывает его только eva-agent-service: общий секрет в заголовке
 * `X-Browser-Key`, сравнение за постоянное время. Сервис не знает ни
 * пользователей, ни их данных: владелец сессии — непрозрачный псевдоним,
 * который выдаёт вызывающий. Базы, Valkey, Letta и сокета Docker у
 * сервиса нет — ни в коде, ни в сети.
 *
 * В журнал не пишутся адреса страниц, введённый текст и содержимое
 * снимков: только операция, код исхода и длительность.
 */

import { timingSafeEqual } from "node:crypto";
import http from "node:http";

import { loadConfig, type BrowserServiceConfig } from "./config.js";
import { EgressPolicy } from "./egress.js";
import { EgressProxy } from "./proxy.js";
import { BrowserError, SessionManager } from "./sessions.js";

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_BODY_BYTES = 32 * 1024;

type Json = Record<string, unknown>;

function send(response: http.ServerResponse, status: number, body: Json): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(payload);
}

async function readJson(request: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BrowserError("invalid_request", "Тело запроса слишком большое");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Json;
  } catch {
    throw new BrowserError("invalid_request", "Тело запроса — JSON-объект");
  }
}

function authorized(config: BrowserServiceConfig, header: string | string[] | undefined): boolean {
  if (!config.token) return !config.production;
  const given = Buffer.from(typeof header === "string" ? header : "");
  const expected = Buffer.from(config.token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const STATUS: Record<string, number> = {
  blocked_url: 403, forbidden: 403, sensitive_field: 422, invalid_ref: 422, invalid_request: 400,
  not_found: 404, session_limit: 429, timeout: 504, navigation_failed: 502, unavailable: 503,
};

function log(fields: Json): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), service: "browser-service", ...fields })}\n`);
}

export function createServer(config: BrowserServiceConfig, sessions: SessionManager, proxy: EgressProxy): http.Server {
  return http.createServer((request, response) => {
    const started = Date.now();
    const url = new URL(request.url ?? "/", "http://browser-service");
    const handle = async (): Promise<void> => {
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, {
          ok: true,
          browser: sessions.connected ? "connected" : "idle",
          sessions: sessions.list().length,
          limits: {
            max_sessions: config.maxSessions,
            max_sessions_per_owner: config.maxSessionsPerOwner,
            session_idle_ms: config.sessionIdleMs,
            session_max_age_ms: config.sessionMaxAgeMs,
            operation_timeout_ms: config.operationTimeoutMs,
            snapshot_max_chars: config.snapshotMaxChars,
          },
          counters: sessions.counters,
          egress: proxy.stats,
        });
        return;
      }
      if (!authorized(config, request.headers["x-browser-key"])) {
        send(response, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/sessions") {
        send(response, 200, { ok: true, sessions: sessions.list() });
        return;
      }
      const match = /^\/v1\/sessions\/([^/]+)(?:\/(open|snapshot|click|type|scroll|back))?$/.exec(url.pathname);
      if (!match || !ID.test(match[1]!)) throw new BrowserError("invalid_request", "Неизвестный маршрут");
      const id = match[1]!;
      const operation = match[2] ?? (request.method === "DELETE" ? "close" : "");
      const body = await readJson(request);
      const owner = typeof body.owner === "string" && ID.test(body.owner) ? body.owner : "";
      if (!owner) throw new BrowserError("invalid_request", "owner — непрозрачный идентификатор владельца");
      const text = (name: string, max = 4_096): string => {
        const value = body[name];
        if (typeof value !== "string" || !value.trim()) throw new BrowserError("invalid_request", `${name}: нужна строка`);
        return value.slice(0, max);
      };
      let result: Json;
      switch (operation) {
        case "open": result = { ...(await sessions.open(id, owner, text("url"))) }; break;
        case "snapshot": result = { ...(await sessions.snapshot(id, owner, Math.max(0, Number(body.offset) || 0))) }; break;
        case "click": result = { ...(await sessions.click(id, owner, text("ref", 32))) }; break;
        case "type": result = { ...(await sessions.type(id, owner, text("ref", 32), typeof body.text === "string" ? body.text : "", body.submit === true)) }; break;
        case "scroll": result = { ...(await sessions.scroll(id, owner, body.direction === "up" ? "up" : "down", Number(body.pages) || 1)) }; break;
        case "back": result = { ...(await sessions.back(id, owner)) }; break;
        case "close": result = { closed: await sessions.close(id, owner) }; break;
        default: throw new BrowserError("invalid_request", "Неизвестная операция");
      }
      send(response, 200, { ok: true, ...result });
      log({ operation, outcome: "ok", duration_ms: Date.now() - started });
    };
    handle().catch((error: unknown) => {
      const code = error instanceof BrowserError ? error.code : "unavailable";
      const message = error instanceof BrowserError ? error.message : "Браузер недоступен";
      if (!response.headersSent) send(response, STATUS[code] ?? 500, { ok: false, error: code, message });
      log({ path: url.pathname.replace(/\/v1\/sessions\/[^/]+/, "/v1/sessions/:id"), outcome: code, duration_ms: Date.now() - started });
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const policy = new EgressPolicy();
  const proxy = new EgressProxy(policy);
  const proxyUrl = await proxy.start();
  const sessions = new SessionManager(config, policy, proxyUrl);
  await sessions.start();
  const server = createServer(config, sessions, proxy);
  server.listen(config.port, config.host, () => log({ event: "listening", port: config.port }));
  const shutdown = async (): Promise<void> => {
    server.close();
    await sessions.stop();
    await proxy.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    log({ event: "startup_failed", message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}
