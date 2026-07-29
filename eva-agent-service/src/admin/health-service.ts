import { randomUUID } from "node:crypto";

import type { Redis } from "ioredis";
import type pg from "pg";

import { adminBadRequest, adminNotFound, adminTooManyRequests } from "./errors.js";
import {
  INTEGRATIONS,
  INTEGRATION_BY_ID,
  SERVICES,
  SERVICE_BY_ID,
  type TargetType,
} from "./service-catalog.js";

interface StatusRow {
  target_id: string;
  target_type: TargetType;
  enabled: boolean;
  configured: boolean;
  state: string;
  color: string;
  operation: string | null;
  last_ok_at: Date | null;
  last_check_at: Date | null;
  duration_ms: number | null;
  detail_json: Record<string, unknown>;
  updated_at: Date;
}

interface CheckRow {
  id: string;
  target_type: TargetType;
  target_id: string;
  status: string;
  requested_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  ok: boolean | null;
  duration_ms: number | null;
  error_code: string | null;
  error_message_short: string | null;
  detail_json: Record<string, unknown>;
}

const SETTING_KEYS = [
  "bootstrap.env.domain",
  "bootstrap.env.domain.app",
  "bootstrap.env.domain.nocodb",
  "bootstrap.env.domain.letta",
  "bootstrap.env.domain.status",
] as const;

function publicUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const host = value.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return /^[a-z0-9.-]+$/i.test(host) ? `https://${host}` : null;
}

export class HealthService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: Redis,
  ) {}

  async overview() {
    const started = performance.now();
    const [statuses, settings, config, backups, audit, version] = await Promise.all([
      this.statusMap(),
      this.publicSettings(),
      this.pool.query<{ missing: string }>(
        `SELECT count(*)::text AS missing
           FROM system_settings
          WHERE key LIKE 'admin.missing.%' AND value_json = 'true'::jsonb`,
      ),
      this.pool.query<{ created_at: Date; size: string | null; status: string }>(
        `SELECT created_at, size::text, status
           FROM backups
          WHERE status <> 'deleted'
          ORDER BY created_at DESC LIMIT 1`,
      ),
      this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM audit_log
          WHERE at >= now() - interval '24 hours' AND result = 'failure'`,
      ),
      this.pool.query<{ version: string }>(
        "SELECT COALESCE(max(id), 0)::text AS version FROM config_versions",
      ),
    ]);
    const serviceCards = SERVICES.map((item) =>
      this.serviceCard(item.id, statuses.get(item.id), settings));
    const integrationCards = INTEGRATIONS.map((item) =>
      this.integrationCard(item.id, statuses.get(`integration:${item.id}`), settings));
    const host = statuses.get("infrastructure:host")?.detail_json ?? {};
    const update = statuses.get("infrastructure:updates")?.detail_json ?? {};
    const colors = [...serviceCards, ...integrationCards].map((item) => item.status.color);
    const overall = colors.includes("red")
      ? "red"
      : colors.includes("yellow")
        ? "yellow"
        : colors.includes("blue")
          ? "blue"
          : "green";
    return {
      generated_at: new Date().toISOString(),
      query_duration_ms: Math.round(performance.now() - started),
      overall_status: overall,
      installation: {
        environment: process.env.EVA_ENV ?? "production",
        version: process.env.EVA_RELEASE_VERSION ?? "0.3.0",
        branch: update.branch ?? process.env.EVA_GIT_BRANCH ?? "unknown",
        commit: update.commit ?? process.env.EVA_GIT_COMMIT ?? "unknown",
        config_version: Number(version.rows[0]?.version ?? 0),
      },
      host,
      summary: {
        services: serviceCards.length,
        healthy: colors.filter((color) => color === "green").length,
        warnings: colors.filter((color) => color === "yellow").length,
        critical: colors.filter((color) => color === "red").length,
        missing_required: Number(config.rows[0]?.missing ?? 0),
        critical_events_24h: Number(audit.rows[0]?.count ?? 0),
      },
      last_backup: backups.rows[0] ?? null,
      update,
      groups: {
        core: serviceCards.filter((item) => item.group === "core"),
        storage: serviceCards.filter((item) => item.group === "storage"),
        ai: serviceCards.filter((item) => item.group === "ai"),
        external: integrationCards,
        infrastructure: serviceCards.filter((item) => item.group === "infrastructure"),
      },
    };
  }

  async services() {
    const [statuses, settings] = await Promise.all([
      this.statusMap(),
      this.publicSettings(),
    ]);
    return {
      services: SERVICES.map((item) =>
        this.serviceCard(item.id, statuses.get(item.id), settings)),
    };
  }

  async integrations() {
    const [statuses, settings] = await Promise.all([
      this.statusMap(),
      this.publicSettings(),
    ]);
    return {
      integrations: INTEGRATIONS.map((item) =>
        this.integrationCard(item.id, statuses.get(`integration:${item.id}`), settings)),
    };
  }

  async enqueue(
    targetType: "service" | "integration",
    targetId: string,
    actorId: string,
  ) {
    if (targetType === "service" && !SERVICE_BY_ID.has(targetId)) {
      throw adminNotFound("Сервис не найден");
    }
    if (targetType === "integration" && !INTEGRATION_BY_ID.has(targetId)) {
      throw adminNotFound("Интеграция не найдена");
    }
    const recent = await this.pool.query(
      `SELECT 1 FROM health_checks
        WHERE target_type = $1 AND target_id = $2
          AND requested_at > now() - interval '10 seconds'
        LIMIT 1`,
      [targetType, targetId],
    );
    if (recent.rowCount) {
      throw adminTooManyRequests("Повторную проверку можно запустить через 10 секунд", {
        retry_after_seconds: 10,
      });
    }
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO health_checks
         (id, target_type, target_id, status, requested_by)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [id, targetType, targetId, actorId],
    );
    await this.pool.query(
      `INSERT INTO service_statuses
         (target_id, target_type, state, color, operation, last_check_at)
       VALUES ($1, $2, 'checking', 'blue', 'health-check', now())
       ON CONFLICT (target_id) DO UPDATE SET
         state = 'checking', color = 'blue', operation = 'health-check',
         last_check_at = now(), updated_at = now()`,
      [targetType === "integration" ? `integration:${targetId}` : targetId, targetType],
    );
    await this.publisher.publish("eva.admin.health.requested", JSON.stringify({
      check_id: id,
      target_type: targetType,
      target_id: targetId,
    }));
    return { check_id: id, status: "pending" };
  }

  async check(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw adminBadRequest("Некорректный check_id");
    const { rows } = await this.pool.query<CheckRow>(
      `SELECT id, target_type, target_id, status, requested_at, started_at,
              finished_at, ok, duration_ms, error_code, error_message_short,
              detail_json
         FROM health_checks WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw adminNotFound("Проверка не найдена");
    return rows[0];
  }

  async statusMap(): Promise<Map<string, StatusRow>> {
    const { rows } = await this.pool.query<StatusRow>(
      `SELECT target_id, target_type, enabled, configured, state, color,
              operation, last_ok_at, last_check_at, duration_ms, detail_json,
              updated_at
         FROM service_statuses`,
    );
    return new Map(rows.map((row) => [row.target_id, row]));
  }

  private async publicSettings(): Promise<Map<string, unknown>> {
    const { rows } = await this.pool.query<{ key: string; value_json: unknown }>(
      "SELECT key, value_json FROM system_settings WHERE key = ANY($1::text[])",
      [SETTING_KEYS],
    );
    return new Map(rows.map((row) => [row.key, row.value_json]));
  }

  private serviceCard(
    id: string,
    status: StatusRow | undefined,
    settings: Map<string, unknown>,
  ) {
    const definition = SERVICE_BY_ID.get(id)!;
    return {
      id: definition.id,
      type: "service",
      title: definition.title,
      purpose: definition.purpose,
      group: definition.group,
      restartable: definition.restartable === true,
      public_url: definition.publicSetting
        ? publicUrl(settings.get(definition.publicSetting))
        : null,
      status: this.publicStatus(status, definition.optional === true),
    };
  }

  private integrationCard(
    id: string,
    status: StatusRow | undefined,
    settings: Map<string, unknown>,
  ) {
    const definition = INTEGRATION_BY_ID.get(id)!;
    return {
      id: definition.id,
      type: "integration",
      title: definition.title,
      purpose: definition.purpose,
      group: definition.group,
      public_url: definition.publicSetting
        ? publicUrl(settings.get(definition.publicSetting))
        : null,
      status: this.publicStatus(status, definition.optional === true),
    };
  }

  private publicStatus(status: StatusRow | undefined, optional: boolean) {
    return status
      ? {
          enabled: status.enabled,
          configured: status.configured,
          state: status.state,
          color: status.color,
          operation: status.operation,
          last_ok_at: status.last_ok_at,
          last_check_at: status.last_check_at,
          duration_ms: status.duration_ms,
          message: typeof status.detail_json.message === "string"
            ? status.detail_json.message
            : null,
          container: typeof status.detail_json.container === "string"
            ? status.detail_json.container
            : null,
        }
      : {
          enabled: !optional,
          configured: false,
          state: optional ? "disabled" : "unknown",
          color: optional ? "gray" : "yellow",
          operation: null,
          last_ok_at: null,
          last_check_at: null,
          duration_ms: null,
          message: "Ожидается первый снимок health-worker",
          container: null,
        };
  }
}
