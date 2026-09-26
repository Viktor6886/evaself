/**
 * Клиенты osint-harvester (theHarvester) и osint-spiderfoot.
 *
 * Оба сервиса — отдельные контейнеры со своими закрытыми списками
 * источников: что разрешено, решается там, и клиент не может попросить
 * больше. Прогон долгий и ходит во внешние источники, поэтому не
 * повторяется при сбое: повтор — решение оркестратора с его бюджетом.
 */

import { OsintHttpClient, list, record, text, type OsintWorkerOptions } from "./worker-client.js";

export interface HarvestResult {
  status: "ok" | "degraded";
  requests: number;
  sources: string[];
  hosts: string[];
  ips: string[];
  emails: string[];
  asns: string[];
}

export class HarvesterClient extends OsintHttpClient {
  constructor(options: OsintWorkerOptions) {
    super({ scanTimeoutMs: 200_000, ...options }, "osint-harvester");
  }

  async harvest(domain: string): Promise<HarvestResult> {
    const body = record(await this.call("POST", "/v1/domain/harvest", { domain }, { timeoutMs: this.scanTimeoutMs, retry: false }));
    return {
      status: body.status === "degraded" ? "degraded" : "ok",
      requests: typeof body.requests === "number" && body.requests >= 0 ? Math.floor(body.requests) : 0,
      sources: list(body.sources).map(text),
      hosts: list(body.hosts).map(text).filter(Boolean),
      ips: list(body.ips).map(text).filter(Boolean),
      emails: list(body.emails).map(text).filter(Boolean),
      asns: list(body.asns).map(text).filter(Boolean),
    };
  }
}

export interface SpiderfootEvent {
  type: string;
  data: string;
  module: string;
}

export interface SpiderfootResult {
  status: "ok" | "degraded";
  modules: number;
  hosts: string[];
  domains: string[];
  ips: string[];
  asns: string[];
  netblocks: string[];
  organizations: string[];
  lei: string[];
  dns: SpiderfootEvent[];
  reputation: SpiderfootEvent[];
}

export class SpiderfootClient extends OsintHttpClient {
  constructor(options: OsintWorkerOptions) {
    super({ scanTimeoutMs: 270_000, ...options }, "osint-spiderfoot");
  }

  async scan(kind: "domain" | "ip", target: string): Promise<SpiderfootResult> {
    const body = record(await this.call("POST", "/v1/scan", { kind, target }, { timeoutMs: this.scanTimeoutMs, retry: false }));
    const strings = (value: unknown) => list(value).map(text).filter(Boolean);
    const events = (value: unknown): SpiderfootEvent[] => list(value).flatMap((raw) => {
      const item = record(raw);
      const data = text(item.data);
      return data ? [{ type: text(item.type), data, module: text(item.module) }] : [];
    });
    return {
      status: body.status === "degraded" ? "degraded" : "ok",
      modules: typeof body.modules === "number" ? body.modules : 0,
      hosts: strings(body.hosts),
      domains: strings(body.domains),
      ips: strings(body.ips),
      asns: strings(body.asns),
      netblocks: strings(body.netblocks),
      organizations: strings(body.organizations),
      lei: strings(body.lei),
      dns: events(body.dns),
      reputation: events(body.reputation),
    };
  }
}
