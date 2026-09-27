/**
 * Клиент browser-service.
 *
 * Сервис браузера не знает ни пользователей, ни conversations: сессия и
 * владелец приходят к нему непрозрачными псевдонимами. Ключ псевдонима
 * живёт только в памяти этого процесса — по псевдониму нельзя перебором
 * восстановить номер пользователя, а после перезапуска старые сессии
 * просто истекают по простою.
 *
 * Отказ самого сервиса (`{ ok: false, error }`) возвращается как есть:
 * модели полезно знать, что адрес закрыт или ссылка устарела. Сетевой
 * отказ — исключение: браузер недоступен целиком.
 */

import { createHmac, randomBytes } from "node:crypto";

export const BROWSER_OPERATIONS_REMOTE = ["open", "snapshot", "click", "type", "scroll", "back"] as const;
export type BrowserRemoteOperation = typeof BROWSER_OPERATIONS_REMOTE[number];

export interface BrowserServiceResult {
  ok: boolean;
  error?: string;
  message?: string;
  url?: string;
  title?: string;
  snapshot?: string;
  truncated?: boolean;
  totalLines?: number;
  nextOffset?: number | null;
  status?: number | null;
  blockedRequests?: number;
  closed?: boolean;
}

const PSEUDONYM_KEY = randomBytes(32);

export function browserIdentity(userId: number, conversationId: string): { session: string; owner: string } {
  const digest = (value: string) => createHmac("sha256", PSEUDONYM_KEY).update(value).digest("base64url").slice(0, 32);
  return { session: `s${digest(`session:${userId}:${conversationId}`)}`, owner: `o${digest(`owner:${userId}`)}` };
}

export class BrowserServiceClient {
  constructor(private readonly options: {
    baseUrl: string;
    token: string;
    timeoutMs?: number;
    fetcher?: typeof fetch;
  }) {}

  async operate(operation: BrowserRemoteOperation, session: string, body: Record<string, unknown>): Promise<BrowserServiceResult> {
    return await this.call("POST", `/v1/sessions/${encodeURIComponent(session)}/${operation}`, body);
  }

  async close(session: string, owner: string): Promise<BrowserServiceResult> {
    return await this.call("DELETE", `/v1/sessions/${encodeURIComponent(session)}`, { owner });
  }

  async health(): Promise<Record<string, unknown>> {
    return await this.call("GET", "/health") as unknown as Record<string, unknown>;
  }

  async sessions(): Promise<Record<string, unknown>> {
    return await this.call("GET", "/v1/sessions") as unknown as Record<string, unknown>;
  }

  private async call(method: string, path: string, body?: Record<string, unknown>): Promise<BrowserServiceResult> {
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(new URL(path, this.options.baseUrl), {
        method,
        headers: {
          "x-browser-key": this.options.token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 90_000),
      });
    } catch (error) {
      const failure = new Error("browser-service недоступен");
      failure.name = error instanceof Error && /Timeout|Abort/.test(error.name) ? "BrowserTimeout" : "BrowserUnavailable";
      throw failure;
    }
    let payload: BrowserServiceResult;
    try {
      payload = await response.json() as BrowserServiceResult;
    } catch {
      throw Object.assign(new Error("browser-service ответил не JSON"), { name: "BrowserUnavailable" });
    }
    if (response.status === 401) throw Object.assign(new Error("browser-service отверг ключ"), { name: "BrowserUnauthorized" });
    return payload;
  }
}
