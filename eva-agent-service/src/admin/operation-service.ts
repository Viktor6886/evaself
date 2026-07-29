import { randomUUID } from "node:crypto";

import type { Redis } from "ioredis";
import type pg from "pg";

import { adminBadRequest, adminNotFound } from "./errors.js";
import { SERVICE_BY_ID } from "./service-catalog.js";
import { UpdaterClient } from "./updater-client.js";

export class OperationService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: Redis,
    private readonly updater: UpdaterClient,
  ) {}

  async restart(serviceId: string, actorId: string) {
    const service = SERVICE_BY_ID.get(serviceId);
    if (!service) throw adminNotFound("Сервис не найден");
    if (!service.restartable) throw adminBadRequest("Для сервиса перезапуск запрещён");
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO admin_operations
         (id, kind, status, target, requested_by)
       VALUES ($1, 'restart', 'pending', $2, $3)`,
      [id, serviceId, actorId],
    );
    setImmediate(() => void this.executeRestart(id, serviceId));
    return { operation_id: id, status: "pending", target: serviceId };
  }

  async get(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw adminBadRequest("Некорректный operation_id");
    const { rows } = await this.pool.query(
      `SELECT id, kind, status, target, requested_at, started_at, finished_at,
              result_json, error_code, error_message
         FROM admin_operations WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw adminNotFound("Операция не найдена");
    return rows[0];
  }

  async backups() {
    const { rows } = await this.pool.query(
      `SELECT id, archive_id, size, created_at, verified_at, status, checksum,
              encrypted, retention_until
         FROM backups
        WHERE status <> 'deleted'
        ORDER BY created_at DESC
        LIMIT 100`,
    );
    return { backups: rows };
  }

  async updates() {
    const [snapshot, history] = await Promise.all([
      this.pool.query<{ detail_json: Record<string, unknown>; last_check_at: Date | null }>(
        `SELECT detail_json, last_check_at
           FROM service_statuses
          WHERE target_id = 'infrastructure:updates'`,
      ),
      this.pool.query(
        `SELECT id, component, from_version, to_version, started_at, finished_at,
                status, rolled_back
           FROM update_history
          ORDER BY started_at DESC LIMIT 50`,
      ),
    ]);
    return {
      current: snapshot.rows[0]?.detail_json ?? {},
      last_checked_at: snapshot.rows[0]?.last_check_at ?? null,
      history: history.rows,
    };
  }

  async createBackup(actorId: string, idempotencyKey: string | undefined) {
    return await this.enqueueOperation("backup", "full", actorId, idempotencyKey);
  }

  async checkUpdate(actorId: string) {
    return await this.enqueueOperation("update-check", "repository", actorId);
  }

  async installUpdate(actorId: string, idempotencyKey: string | undefined) {
    return await this.enqueueOperation("update", "repository", actorId, idempotencyKey);
  }

  private async executeRestart(id: string, serviceId: string) {
    await this.pool.query(
      "UPDATE admin_operations SET status = 'running', started_at = now() WHERE id = $1",
      [id],
    );
    await this.pool.query(
      `UPDATE service_statuses
          SET state = 'checking', color = 'blue', operation = 'restart',
              updated_at = now()
        WHERE target_id = $1`,
      [serviceId],
    );
    try {
      const result = await this.updater.call<Record<string, unknown>>(
        "restart_service",
        { service: serviceId },
      );
      await this.pool.query(
        `UPDATE admin_operations
            SET status = 'success', finished_at = now(), result_json = $2::jsonb
          WHERE id = $1`,
        [id, JSON.stringify({ restarted: true, state: result.state ?? null })],
      );
    } catch {
      await this.pool.query(
        `UPDATE admin_operations
            SET status = 'failure', finished_at = now(),
                error_code = 'restart_failed',
                error_message = 'Сервис не перезапущен'
          WHERE id = $1`,
        [id],
      );
    }
    await this.publisher.publish("eva.admin.events", JSON.stringify({
      type: "operation.completed",
      operation_id: id,
      target: serviceId,
    }));
  }

  private async enqueueOperation(
    kind: "backup" | "update-check" | "update",
    target: string,
    actorId: string,
    idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined &&
        !/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
      throw adminBadRequest("Idempotency-Key должен содержать 8–100 безопасных символов");
    }
    if (idempotencyKey) {
      const existing = await this.pool.query(
        `SELECT id, kind, status, target, requested_at
           FROM admin_operations
          WHERE kind = $1 AND idempotency_key = $2`,
        [kind, idempotencyKey],
      );
      if (existing.rows[0]) return existing.rows[0];
    }
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO admin_operations
         (id, kind, status, target, requested_by, idempotency_key)
       VALUES ($1, $2, 'pending', $3, $4, $5)`,
      [id, kind, target, actorId, idempotencyKey ?? null],
    );
    setImmediate(() => void this.executeOperation(id, kind));
    return { operation_id: id, kind, status: "pending", target };
  }

  private async executeOperation(
    id: string,
    kind: "backup" | "update-check" | "update",
  ) {
    await this.pool.query(
      "UPDATE admin_operations SET status = 'running', started_at = now() WHERE id = $1",
      [id],
    );
    if (kind === "update") {
      const current = await this.pool.query<{ detail_json: Record<string, unknown> }>(
        "SELECT detail_json FROM service_statuses WHERE target_id = 'infrastructure:updates'",
      );
      await this.pool.query(
        `INSERT INTO update_history
           (component, from_version, to_version, status, operation_id)
         VALUES ('repository', $1, NULL, 'running', $2)`,
        [String(current.rows[0]?.detail_json.commit ?? "unknown"), id],
      );
    }
    try {
      const command = kind === "backup"
        ? "create_backup"
        : kind === "update-check"
          ? "check_update"
          : "pull_and_up";
      const result = await this.updater.call<Record<string, unknown>>(
        command,
        {},
        kind === "update" ? 35 * 60_000 : 20 * 60_000,
      );
      await this.pool.query(
        `UPDATE admin_operations
            SET status = 'success', finished_at = now(), result_json = $2::jsonb
          WHERE id = $1`,
        [id, JSON.stringify({
          completed: true,
          output_available: Boolean(result.output),
        })],
      );
      if (kind === "backup") await this.syncBackups();
      if (kind === "update-check") {
        const output = typeof result.output === "string" ? result.output : "";
        const matched = /(\d+)\s+image update\(s\) available/i.exec(output);
        const available = matched ? Number(matched[1]) : null;
        await this.pool.query(
          `UPDATE service_statuses
              SET detail_json = detail_json || $1::jsonb,
                  last_check_at = now(), updated_at = now()
            WHERE target_id = 'infrastructure:updates'`,
          [JSON.stringify({
            checked: true,
            update_available: available === null ? null : available > 0,
            available_components: available,
          })],
        );
      }
      if (kind === "update") {
        await this.pool.query(
          `UPDATE update_history
              SET status = 'success', finished_at = now()
            WHERE operation_id = $1 AND status = 'running'`,
          [id],
        );
      }
    } catch {
      await this.pool.query(
        `UPDATE admin_operations
            SET status = 'failure', finished_at = now(),
                error_code = $2, error_message = $3
          WHERE id = $1`,
        [
          id,
          `${kind.replace("-", "_")}_failed`,
          kind === "backup"
            ? "Backup не создан"
            : kind === "update"
              ? "Обновление не завершено; проверьте rollback и журнал"
              : "Проверка обновлений не завершена",
        ],
      );
      if (kind === "update") {
        await this.pool.query(
          `UPDATE update_history
              SET status = 'failure', finished_at = now()
            WHERE operation_id = $1 AND status = 'running'`,
          [id],
        );
      }
    }
    await this.publisher.publish("eva.admin.events", JSON.stringify({
      type: "operation.completed",
      operation_id: id,
      operation_kind: kind,
    }));
    if (kind === "update") {
      void this.updater.call("handoff_update").catch(() => {});
    }
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
         VALUES ($1, $1, $2, $3, 'ready', $4)
         ON CONFLICT (archive_id) DO UPDATE SET
           size = EXCLUDED.size, created_at = EXCLUDED.created_at,
           status = 'ready', encrypted = EXCLUDED.encrypted`,
        [item.archive_id, item.size, item.created_at, item.encrypted],
      );
    }
  }
}
