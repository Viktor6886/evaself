import type { Redis } from "ioredis";
import type pg from "pg";

import type { Logger } from "../logger.js";
import {
  INTEGRATIONS,
  SERVICES,
  SERVICE_BY_ID,
  statusColor,
  type IntegrationDefinition,
  type ServiceDefinition,
} from "./service-catalog.js";
import { UpdaterClient } from "./updater-client.js";

interface ContainerStatus {
  exists: boolean;
  running: boolean;
  state: string;
  health: string | null;
  started_at?: string | null;
  restart_count?: number;
}

interface CheckResult {
  ok: boolean;
  running: boolean;
  enabled: boolean;
  configured: boolean;
  state: "healthy" | "running" | "degraded" | "failed" | "stopped" | "disabled";
  message: string;
  detail: Record<string, unknown>;
}

interface PendingCheck {
  id: string;
  target_type: "service" | "integration";
  target_id: string;
}

const INTERVAL_SECONDS = Math.max(
  15,
  Number.parseInt(process.env.EVA_HEALTH_INTERVAL_SECONDS ?? "60", 10) || 60,
);
const CHECK_TIMEOUT_MS = Math.min(
  10_000,
  Math.max(1_000, Number.parseInt(process.env.EVA_HEALTH_TIMEOUT_MS ?? "10000", 10) || 10_000),
);

export function optionalIntegrationEnabled(
  optional: boolean,
  configured: boolean,
  hasService: boolean,
  serviceEnabled: boolean,
): boolean {
  if (!optional) return true;
  return configured && (!hasService || serviceEnabled);
}

export class HealthWorker {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly redis: Redis,
    private readonly updater: UpdaterClient,
    private readonly logger: Logger,
  ) {}

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 1_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async runScheduledCycle() {
    await Promise.allSettled(SERVICES.map((service) => this.checkAndStoreService(service)));
    await Promise.allSettled(INTEGRATIONS.map((integration) =>
      this.checkAndStoreIntegration(integration)));
    await Promise.allSettled([
      this.captureHost(),
      this.captureUpdates(),
      this.syncBackups(),
    ]);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.processPending();
      const due = await this.pool.query(
        `SELECT 1
           FROM service_statuses
          WHERE target_id = 'infrastructure:host'
            AND last_check_at > now() - ($1::text || ' seconds')::interval
          LIMIT 1`,
        [INTERVAL_SECONDS],
      );
      if (!due.rowCount) await this.runScheduledCycle();
      if (Math.random() < 0.01) {
        await this.pool.query(
          "DELETE FROM health_checks WHERE requested_at < now() - interval '30 days'",
        );
      }
    } catch (error) {
      this.logger.warn("Цикл health-worker завершился ошибкой", {
        code: error instanceof Error ? error.name : "unknown_error",
      });
    } finally {
      this.running = false;
    }
  }

  private async processPending() {
    const client = await this.pool.connect();
    let pending: PendingCheck | undefined;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<PendingCheck>(
        `SELECT id, target_type, target_id
           FROM health_checks
          WHERE status = 'pending'
          ORDER BY requested_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
      );
      pending = rows[0];
      if (pending) {
        await client.query(
          "UPDATE health_checks SET status = 'checking', started_at = now() WHERE id = $1",
          [pending.id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!pending) return;

    const started = Date.now();
    try {
      let result: CheckResult;
      if (pending.target_type === "service") {
        const definition = SERVICE_BY_ID.get(pending.target_id);
        if (!definition) throw new Error("Сервис удалён из каталога");
        result = await this.checkAndStoreService(definition);
      } else {
        const definition = INTEGRATIONS.find((item) => item.id === pending!.target_id);
        if (!definition) throw new Error("Интеграция удалена из каталога");
        result = await this.checkAndStoreIntegration(definition);
      }
      await this.pool.query(
        `UPDATE health_checks SET
           status = $2, finished_at = now(), ok = $3, duration_ms = $4,
           error_code = $5, error_message_short = $6, detail_json = $7::jsonb
         WHERE id = $1`,
        [
          pending.id,
          result.ok ? "success" : "failure",
          result.ok,
          Date.now() - started,
          result.ok ? null : "health_check_failed",
          result.ok ? null : result.message.slice(0, 300),
          JSON.stringify({ state: result.state }),
        ],
      );
    } catch {
      await this.pool.query(
        `UPDATE health_checks SET status = 'failure', finished_at = now(),
           ok = false, duration_ms = $2, error_code = 'health_check_failed',
           error_message_short = 'Проверка не завершена'
         WHERE id = $1`,
        [pending.id, Date.now() - started],
      );
    }
    await this.redis.publish("eva.admin.events", JSON.stringify({
      type: "health-check.completed",
      check_id: pending.id,
      target_type: pending.target_type,
      target_id: pending.target_id,
    }));
  }

  private async checkAndStoreService(definition: ServiceDefinition): Promise<CheckResult> {
    const started = Date.now();
    let result: CheckResult;
    try {
      const container = await this.updater.call<ContainerStatus>(
        "get_service_status",
        { service: definition.id },
      );
      const enabled = definition.optional ? container.exists : true;
      if (!enabled) {
        result = {
          ok: true,
          running: false,
          enabled: false,
          configured: true,
          state: "disabled",
          message: "Профиль выключен",
          detail: { container: "not-created" },
        };
      } else if (!container.running) {
        result = {
          ok: false,
          running: false,
          enabled: true,
          configured: true,
          state: "stopped",
          message: "Контейнер не запущен",
          detail: { container: container.state },
        };
      } else if (definition.healthUrl) {
        const response = await boundedFetch(definition.healthUrl);
        let endpointDetail: Record<string, unknown> = {};
        if (definition.id === "agent-runtime") {
          try {
            const body = response.body as {
              checks?: { telegram_stickers?: unknown };
            };
            endpointDetail = { telegram_stickers: body.checks?.telegram_stickers ?? null };
          } catch {
            endpointDetail = { telegram_stickers: null };
          }
        }
        result = {
          ok: response.ok,
          running: true,
          enabled: true,
          configured: true,
          state: response.ok ? "healthy" : "degraded",
          message: response.ok ? "Сервис отвечает" : `Health endpoint: HTTP ${response.status}`,
          detail: {
            container: container.state,
            docker_health: container.health,
            http_status: response.status,
            restart_count: container.restart_count ?? 0,
            ...endpointDetail,
          },
        };
      } else {
        const healthy = container.health === null || container.health === "healthy";
        result = {
          ok: healthy,
          running: true,
          enabled: true,
          configured: true,
          state: healthy ? "running" : "degraded",
          message: healthy ? "Контейнер запущен" : "Docker healthcheck неуспешен",
          detail: {
            container: container.state,
            docker_health: container.health,
            restart_count: container.restart_count ?? 0,
          },
        };
      }
    } catch {
      result = {
        ok: false,
        running: false,
        enabled: !definition.optional,
        configured: true,
        state: definition.optional ? "disabled" : "failed",
        message: "Сервис недоступен",
        detail: {},
      };
    }
    await this.storeStatus(definition.id, "service", result, Date.now() - started);
    return result;
  }

  private async checkAndStoreIntegration(
    definition: IntegrationDefinition,
  ): Promise<CheckResult> {
    const started = Date.now();
    const [secrets, settings, service] = await Promise.all([
      definition.requiredSecrets?.length
        ? this.pool.query<{ secret_ref: string }>(
            `SELECT secret_ref FROM secret_records
              WHERE status = 'active' AND secret_ref = ANY($1::text[])`,
            [definition.requiredSecrets],
          )
        : Promise.resolve({ rows: [] as Array<{ secret_ref: string }> }),
      definition.requiredSettings?.length
        ? this.pool.query<{ key: string; value_json: unknown }>(
            `SELECT key, value_json FROM system_settings
              WHERE key = ANY($1::text[])`,
            [definition.requiredSettings],
          )
        : Promise.resolve({ rows: [] as Array<{ key: string; value_json: unknown }> }),
      definition.serviceId
        ? this.pool.query<{
            enabled: boolean;
            state: string;
            last_ok_at: Date | null;
          }>("SELECT enabled, state, last_ok_at FROM service_statuses WHERE target_id = $1", [
            definition.serviceId,
          ])
        : Promise.resolve({ rows: [] }),
    ]);
    const hasSecrets = (definition.requiredSecrets?.length ?? 0) === secrets.rows.length;
    const presentSettings = new Map(settings.rows.map((row) => [row.key, row.value_json]));
    const hasSettings = (definition.requiredSettings ?? []).every((key) => {
      const value = presentSettings.get(key);
      return value !== undefined && value !== null && value !== "";
    });
    const configured = hasSecrets && hasSettings;
    const serviceRow = service.rows[0];
    const enabled = optionalIntegrationEnabled(
      definition.optional === true,
      configured,
      Boolean(definition.serviceId),
      serviceRow?.enabled === true,
    );
    const ok = Boolean(serviceRow && ["healthy", "running"].includes(serviceRow.state));
    const result: CheckResult = {
      ok: enabled ? ok && configured : true,
      running: ok,
      enabled,
      configured,
      state: !enabled
        ? "disabled"
        : !configured
          ? "degraded"
          : ok
            ? "healthy"
            : "failed",
      message: !enabled
        ? "Интеграция не включена"
        : !configured
          ? "Заполнены не все обязательные параметры"
          : ok
            ? "Интеграция настроена, базовый сервис работает"
            : "Базовый сервис недоступен",
      detail: {
        service_id: definition.serviceId ?? null,
        missing_secrets: (definition.requiredSecrets ?? []).filter(
          (ref) => !secrets.rows.some((row) => row.secret_ref === ref),
        ),
        missing_settings: (definition.requiredSettings ?? []).filter(
          (key) => !presentSettings.has(key),
        ),
      },
    };
    await this.storeStatus(
      `integration:${definition.id}`,
      "integration",
      result,
      Date.now() - started,
    );
    return result;
  }

  private async storeStatus(
    targetId: string,
    targetType: "service" | "integration",
    result: CheckResult,
    durationMs: number,
  ) {
    const color = statusColor({
      enabled: result.enabled,
      configured: result.configured,
      running: result.running,
      ok: result.ok,
      lastOkAt: result.ok ? new Date() : null,
      intervalSeconds: INTERVAL_SECONDS,
      degraded: result.state === "degraded",
    });
    await this.pool.query(
      `INSERT INTO service_statuses
         (target_id, target_type, enabled, configured, state, color,
          operation, last_ok_at, last_check_at, duration_ms, detail_json)
       VALUES ($1, $2, $3, $4, $5, $6, NULL,
               CASE WHEN $7 THEN now() ELSE NULL END, now(), $8, $9::jsonb)
       ON CONFLICT (target_id) DO UPDATE SET
         target_type = EXCLUDED.target_type,
         enabled = EXCLUDED.enabled,
         configured = EXCLUDED.configured,
         state = EXCLUDED.state,
         color = EXCLUDED.color,
         operation = NULL,
         last_ok_at = CASE WHEN $7 THEN now() ELSE service_statuses.last_ok_at END,
         last_check_at = now(),
         duration_ms = EXCLUDED.duration_ms,
         detail_json = EXCLUDED.detail_json,
         updated_at = now()`,
      [
        targetId,
        targetType,
        result.enabled,
        result.configured,
        result.state,
        color,
        result.ok,
        durationMs,
        JSON.stringify({ ...result.detail, message: result.message }),
      ],
    );
  }

  private async captureHost() {
    const detail = await this.updater.call<Record<string, unknown>>("host_metrics");
    await this.storeInfrastructure("infrastructure:host", detail);
  }

  private async captureUpdates() {
    const detail = await this.updater.call<Record<string, unknown>>("get_update_info");
    await this.storeInfrastructure("infrastructure:updates", detail);
  }

  private async syncBackups() {
    const items = await this.updater.call<Array<{
      archive_id: string;
      size: number;
      created_at: string;
      encrypted: boolean;
    }>>("list_backups");
    for (const item of items) {
      await this.pool.query(
        `INSERT INTO backups
           (archive_id, path, size, created_at, status, encrypted)
         VALUES ($1, $2, $3, $4, 'ready', $5)
         ON CONFLICT (archive_id) DO UPDATE SET
           size = EXCLUDED.size, created_at = EXCLUDED.created_at,
           encrypted = EXCLUDED.encrypted`,
        [
          item.archive_id,
          item.archive_id,
          item.size,
          item.created_at,
          item.encrypted,
        ],
      );
    }
  }

  private async storeInfrastructure(targetId: string, detail: Record<string, unknown>) {
    await this.pool.query(
      `INSERT INTO service_statuses
         (target_id, target_type, state, color, last_ok_at, last_check_at, detail_json)
       VALUES ($1, 'infrastructure', 'healthy', 'green', now(), now(), $2::jsonb)
       ON CONFLICT (target_id) DO UPDATE SET
         state = 'healthy', color = 'green', last_ok_at = now(),
         last_check_at = now(),
         detail_json = service_statuses.detail_json || EXCLUDED.detail_json,
         updated_at = now()`,
      [targetId, JSON.stringify(detail)],
    );
  }
}

async function boundedFetch(url: string) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    redirect: "error",
  });
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 256 * 1024) throw new Error("Health response too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("Health response too large");
  let body: unknown = null;
  try { body = JSON.parse(raw) as unknown; } catch { /* diagnostics stay null */ }
  return { ok: response.ok, status: response.status, body };
}
