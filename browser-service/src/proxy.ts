/**
 * Локальный прокси исходящего трафика Chromium.
 *
 * Chromium запускается с `--proxy-server` на этот прокси, и каждое
 * соединение — страница, картинка, скрипт, WebSocket — проходит здесь.
 * Прокси сам разрешает имя через `EgressPolicy` и соединяется с тем
 * адресом, который проверил. Chromium адреса не выбирает: подменить DNS
 * между проверкой и соединением нельзя.
 *
 * Слушает только loopback внутри контейнера. Снаружи он недоступен и
 * никакой авторизации не держит.
 */

import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

import type { EgressPolicy } from "./egress.js";

const IDLE_TIMEOUT_MS = 60_000;
const MAX_CONNECTIONS = 256;

export interface ProxyStats {
  allowed: number;
  blocked: number;
  active: number;
}

export class EgressProxy {
  private server: http.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  readonly stats: ProxyStats = { allowed: 0, blocked: 0, active: 0 };

  constructor(private readonly policy: EgressPolicy) {}

  async start(): Promise<string> {
    const server = http.createServer((request, response) => void this.forward(request, response));
    server.on("connect", (request, socket, head) => void this.tunnel(request, socket as net.Socket, head));
    server.on("connection", (socket) => {
      if (this.sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
      this.sockets.add(socket);
      socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** HTTPS и WebSocket по TLS: туннель к проверенному адресу. */
  private async tunnel(request: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    const [host = "", portText = "443"] = splitHostPort(request.url ?? "");
    const port = Number(portText);
    const verdict = Number.isInteger(port) && port > 0 && port < 65_536
      ? await this.policy.checkHost(host)
      : ({ ok: false, reason: "hostname" } as const);
    if (!verdict.ok) {
      this.stats.blocked += 1;
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    this.stats.allowed += 1;
    this.stats.active += 1;
    const upstream = net.connect({ host: verdict.address, port, family: verdict.family });
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
    const finish = (): void => {
      client.destroy();
      upstream.destroy();
    };
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", finish);
    client.once("error", finish);
    upstream.once("close", () => { this.stats.active -= 1; client.destroy(); });
    client.once("close", () => upstream.destroy());
  }

  /** Обычный HTTP: запрос в абсолютной форме уходит на проверенный адрес. */
  private async forward(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end();
      return;
    }
    const verdict = target.protocol === "http:" ? await this.policy.checkUrl(target.toString()) : ({ ok: false, reason: "scheme" } as const);
    if (!verdict.ok) {
      this.stats.blocked += 1;
      response.writeHead(403).end();
      return;
    }
    this.stats.allowed += 1;
    const headers = { ...request.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request({
      host: verdict.address,
      family: verdict.family,
      port: Number(target.port || 80),
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...headers, host: target.host },
      timeout: IDLE_TIMEOUT_MS,
    }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  }
}

function splitHostPort(authority: string): [string, string] {
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return [authority.slice(1, end), authority.slice(end + 2) || "443"];
  }
  const index = authority.lastIndexOf(":");
  return index === -1 ? [authority, "443"] : [authority.slice(0, index), authority.slice(index + 1)];
}
