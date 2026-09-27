/**
 * Защита от SSRF: куда браузеру можно ходить.
 *
 * Браузер открывает адреса, которые назвала модель, а страницы сами
 * тянут десятки ресурсов. Любой из них мог бы указывать внутрь: на
 * метаданные облака, на соседний контейнер, на loopback. Поэтому каждый
 * адрес проверяется дважды:
 *
 *   1. обработчик маршрутов браузера отсекает схему, метод и имя хоста
 *      ещё до запроса;
 *   2. весь трафик Chromium идёт через локальный прокси (`proxy.ts`),
 *      который сам разрешает имя, проверяет каждый адрес и соединяется
 *      с проверенным IP. Повторного разрешения имени после проверки нет —
 *      подмена DNS между проверкой и соединением (DNS rebinding) не
 *      проходит.
 *
 * Сетевой периметр контейнера — отдельная, третья граница: у
 * browser-service нет маршрута ни к PostgreSQL, ни к Valkey, ни к
 * Letta, ни к сокету Docker.
 */

import dns from "node:dns/promises";
import net from "node:net";

export type EgressVerdict =
  | { ok: true; address: string; family: 4 | 6 }
  | { ok: false; reason: "scheme" | "credentials" | "hostname" | "private_address" | "dns_failed" };

type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const BLOCKED_HOSTNAMES = /(?:^|\.)(?:localhost|local|internal|localdomain|home\.arpa)$/i;

function ipv4ToNumber(ip: string): number {
  return ip.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

const IPV4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function inIpv4Range(ip: string, [base, bits]: [string, number]): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(base) & mask);
}

function expandIpv6(ip: string): number[] | null {
  let address = ip.toLowerCase().split("%")[0]!;
  // Хвост IPv4 (::ffff:10.0.0.1) переводится в две группы.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (tail) {
    const value = ipv4ToNumber(tail[1]!);
    address = address.replace(tail[1]!, `${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`);
  }
  const [head, rest] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? left.length !== 8 : missing < 0) return null;
  const groups = [...left, ...Array(rest === undefined ? 0 : missing).fill("0"), ...right].map((group) => Number.parseInt(group || "0", 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return IPV4_BLOCKED.some((range) => inIpv4Range(ip, range)) || ip === "255.255.255.255";
  if (!net.isIPv6(ip)) return true;
  const groups = expandIpv6(ip);
  if (!groups) return true;
  const [g0, g1, , , , g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  if (groups.every((group) => group === 0)) return true; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // документация
  // IPv4 внутри IPv6: ::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d — судим по IPv4.
  const mapped = groups.slice(0, 5).every((group) => group === 0) && (g5 === 0xffff || g5 === 0);
  const nat64 = g0 === 0x64 && g1 === 0xff9b;
  if (mapped || nat64) {
    const v4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    return isBlockedAddress(v4);
  }
  return false;
}

export class EgressPolicy {
  private readonly cache = new Map<string, { expiresAt: number; verdict: EgressVerdict }>();

  constructor(private readonly options: {
    /** Только для тестов: разрешить loopback и частные сети. */
    allowPrivate?: boolean;
    /**
     * Только для тестов: какой адрес считать допустимым. Задаётся кодом
     * при сборке, из окружения не читается — production его не видит.
     */
    addressAllowed?: (address: string) => boolean;
    lookup?: Lookup;
    cacheMs?: number;
    now?: () => number;
  } = {}) {}

  get allowPrivate(): boolean {
    return this.options.allowPrivate === true;
  }

  private blocked(address: string): boolean {
    if (this.options.addressAllowed) return !this.options.addressAllowed(address);
    return !this.allowPrivate && isBlockedAddress(address);
  }

  /** Проверка адреса страницы или ресурса. */
  async checkUrl(raw: string): Promise<EgressVerdict> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: "scheme" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
    if (url.username || url.password) return { ok: false, reason: "credentials" };
    return await this.checkHost(url.hostname);
  }

  /** Проверка имени хоста: разрешение DNS и каждый полученный адрес. */
  async checkHost(rawHost: string): Promise<EgressVerdict> {
    const hostname = rawHost.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    if (!hostname) return { ok: false, reason: "hostname" };
    if (!this.allowPrivate && !this.options.addressAllowed
      && (BLOCKED_HOSTNAMES.test(hostname) || (!hostname.includes(".") && !net.isIP(hostname)))) {
      return { ok: false, reason: "hostname" };
    }
    const now = (this.options.now ?? Date.now)();
    const cached = this.cache.get(hostname);
    if (cached && cached.expiresAt > now) return cached.verdict;
    const verdict = await this.resolve(hostname);
    this.cache.set(hostname, { expiresAt: now + (this.options.cacheMs ?? 30_000), verdict });
    if (this.cache.size > 2_000) this.cache.delete(this.cache.keys().next().value!);
    return verdict;
  }

  private async resolve(hostname: string): Promise<EgressVerdict> {
    if (net.isIP(hostname)) {
      if (this.blocked(hostname)) return { ok: false, reason: "private_address" };
      return { ok: true, address: hostname, family: net.isIPv4(hostname) ? 4 : 6 };
    }
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await (this.options.lookup ?? ((host) => dns.lookup(host, { all: true, verbatim: true })))(hostname);
    } catch {
      return { ok: false, reason: "dns_failed" };
    }
    if (!addresses.length) return { ok: false, reason: "dns_failed" };
    // Один частный адрес среди публичных — отказ: какой из них выберет
    // соединение, заранее не известно.
    if (addresses.some((item) => this.blocked(item.address))) {
      return { ok: false, reason: "private_address" };
    }
    const first = addresses[0]!;
    return { ok: true, address: first.address, family: first.family === 6 ? 6 : 4 };
  }
}
