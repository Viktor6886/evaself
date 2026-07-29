import dns from "node:dns/promises";
import net from "node:net";

import { AdminApiError, adminBadRequest } from "./errors.js";

export interface GatewayResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: Uint8Array;
  json<T>(): T;
}

interface GatewayOptions {
  allowlist?: string[];
  lookup?: typeof dns.lookup;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export class OutboundGateway {
  private readonly allowlist: string[];
  private readonly lookup: typeof dns.lookup;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;

  constructor(options: GatewayOptions = {}) {
    this.allowlist = options.allowlist ??
      (process.env.EVA_OUTBOUND_HOST_ALLOWLIST ?? "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    this.lookup = options.lookup ?? dns.lookup;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = Math.min(30_000, Math.max(1_000, options.timeoutMs ?? 10_000));
    this.maxBodyBytes = Math.min(
      4 * 1024 * 1024,
      Math.max(1024, options.maxBodyBytes ?? 512 * 1024),
    );
  }

  async validate(rawUrl: unknown): Promise<URL> {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
      throw adminBadRequest("Base URL обязателен");
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw adminBadRequest("Укажите корректный Base URL");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw adminBadRequest("Разрешены только http/https URL без логина и пароля");
    }
    if (url.port && !/^\d{1,5}$/.test(url.port)) {
      throw adminBadRequest("Некорректный порт в Base URL");
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname || hostname === "localhost") throw ssrfBlocked();
    if (this.isAllowlisted(hostname)) return url;

    if (net.isIP(hostname)) {
      if (isBlockedAddress(hostname)) throw ssrfBlocked();
      return url;
    }
    let addresses: Array<{ address: string }>;
    try {
      const result = await this.lookup(hostname, { all: true, verbatim: true });
      addresses = result as Array<{ address: string }>;
    } catch {
      throw new AdminApiError(
        "provider_dns_failed",
        "Не удалось определить адрес провайдера",
        422,
      );
    }
    if (!addresses.length || addresses.some((item) => isBlockedAddress(item.address))) {
      throw ssrfBlocked();
    }
    return url;
  }

  async request(
    rawUrl: string,
    init: RequestInit = {},
  ): Promise<GatewayResponse> {
    let url = await this.validate(rawUrl);
    let method = init.method ?? "GET";
    let body = init.body;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const response = await this.fetcher(url, {
        ...init,
        method,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect === 3) {
          throw new AdminApiError(
            "provider_redirect_limit",
            "Провайдер выполнил слишком много перенаправлений",
            502,
          );
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new AdminApiError(
            "provider_invalid_redirect",
            "Провайдер вернул перенаправление без адреса",
            502,
          );
        }
        url = await this.validate(new URL(location, url).toString());
        if (response.status === 303) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > this.maxBodyBytes) throw responseTooLarge();
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.length;
          if (size > this.maxBodyBytes) {
            await reader.cancel();
            throw responseTooLarge();
          }
          chunks.push(result.value);
        }
      }
      const output = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        body: output,
        json<T>() {
          return JSON.parse(new TextDecoder().decode(output)) as T;
        },
      };
    }
    throw new AdminApiError("provider_unreachable", "Провайдер недоступен", 502);
  }

  private isAllowlisted(hostname: string): boolean {
    return this.allowlist.some((pattern) =>
      pattern.startsWith("*.")
        ? hostname.endsWith(pattern.slice(1)) && hostname !== pattern.slice(2)
        : hostname === pattern);
  }
}

function ssrfBlocked() {
  return new AdminApiError(
    "outbound_address_blocked",
    "Адрес относится к локальной или служебной сети и запрещён политикой безопасности",
    422,
  );
}

function responseTooLarge() {
  return new AdminApiError(
    "provider_response_too_large",
    "Ответ провайдера превышает допустимый размер",
    502,
  );
}

export function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    return a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224;
  }
  if (!net.isIPv6(normalized)) return true;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith("ff")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  return mapped ? isBlockedAddress(mapped[1]!) : false;
}
