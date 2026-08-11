import type pg from "pg";

import { adminBadRequest, adminConflict, adminNotFound, preconditionRequired } from "./errors.js";
import {
  ALL_SETTINGS,
  SETTING_PROFILES,
  SETTING_BY_KEY,
  type SettingDefinition,
  type SettingProfile,
} from "./settings-registry.js";

interface Publisher {
  publish(channel: string, message: string): Promise<number>;
}

interface SettingRow {
  key: string;
  value_json: unknown;
  version: string;
  updated_at: Date;
}

function validate(definition: SettingDefinition, value: unknown): unknown {
  if (definition.type === "boolean") {
    if (typeof value !== "boolean") throw adminBadRequest(`${definition.title}: ожидается true или false`);
    return value;
  }
  if (definition.type === "integer") {
    if (!Number.isSafeInteger(value)) throw adminBadRequest(`${definition.title}: ожидается целое число`);
    if (definition.min !== undefined && (value as number) < definition.min) {
      throw adminBadRequest(`${definition.title}: минимум ${definition.min}`);
    }
    if (definition.max !== undefined && (value as number) > definition.max) {
      throw adminBadRequest(`${definition.title}: максимум ${definition.max}`);
    }
    return value;
  }
  if (typeof value !== "string" || (definition.required && !value.trim())) {
    throw adminBadRequest(`${definition.title}: ожидается непустая строка`);
  }
  if (definition.key === "runtime.log_level" && !["debug", "info", "warn", "error"].includes(value)) {
    throw adminBadRequest("Допустимые уровни: debug, info, warn, error");
  }
  if (definition.key === "runtime.timezone") {
    try {
      new Intl.DateTimeFormat("ru-RU", { timeZone: value }).format();
    } catch {
      throw adminBadRequest("Укажите корректный часовой пояс IANA");
    }
  }
  return value.trim();
}

function parseEtag(value: string | undefined): number {
  if (!value) throw preconditionRequired();
  const matched = /^"?cfg-(\d+)"?$/.exec(value.trim());
  if (!matched) throw adminBadRequest("Некорректный If-Match");
  return Number(matched[1]);
}

export class ConfigService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: Publisher,
  ) {}

  async getAll(): Promise<{
    etag: string;
    version: number;
    settings: Array<SettingDefinition & {
      value: unknown;
      configured: boolean;
      version: number;
      updated_at: Date | null;
    }>;
    missing_required: number;
    profiles: readonly SettingProfile[];
  }> {
    const [{ rows }, version] = await Promise.all([
      this.pool.query<SettingRow>(
        `SELECT key, value_json, version, updated_at
           FROM system_settings
          WHERE key = ANY($1::text[])`,
        [ALL_SETTINGS.map((item) => item.key)],
      ),
      this.currentVersion(),
    ]);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const settings = ALL_SETTINGS.map((definition) => {
      const row = byKey.get(definition.key);
      return {
        ...definition,
        value: row?.value_json ?? definition.default,
        configured: Boolean(row),
        version: Number(row?.version ?? 0),
        updated_at: row?.updated_at ?? null,
      };
    });
    const missingRequired = settings.filter(
      (item) => item.required && (item.value === null || item.value === ""),
    ).length;
    return {
      etag: `"cfg-${version}"`,
      version,
      settings,
      missing_required: missingRequired,
      profiles: SETTING_PROFILES,
    };
  }

  async update(
    input: unknown,
    ifMatch: string | undefined,
    actorId: string,
  ): Promise<Awaited<ReturnType<ConfigService["getAll"]>>> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw adminBadRequest("settings должен быть объектом");
    }
    const expected = parseEtag(ifMatch);
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) throw adminBadRequest("Нет настроек для сохранения");
    const validated = entries.map(([key, value]) => {
      const definition = SETTING_BY_KEY.get(key);
      if (!definition) throw adminBadRequest(`Неизвестная настройка: ${key}`);
      return { key, value: validate(definition, value), definition };
    });

    const client = await this.pool.connect();
    let nextVersion = expected;
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE config_versions IN EXCLUSIVE MODE");
      const current = await this.currentVersion(client);
      if (current !== expected) {
        const { rows } = await client.query<{ key: string }>(
          "SELECT DISTINCT key FROM config_versions WHERE id > $1 ORDER BY key",
          [expected],
        );
        throw adminConflict("Настройки изменены другим администратором", {
          expected_version: expected,
          current_version: current,
          changed_keys: rows.map((row) => row.key),
        });
      }
      for (const item of validated) {
        const previous = await client.query<{ value_json: unknown; version: string }>(
          "SELECT value_json, version FROM system_settings WHERE key = $1 FOR UPDATE",
          [item.key],
        );
        const oldValue = previous.rows[0]?.value_json ?? null;
        const rowVersion = Number(previous.rows[0]?.version ?? 0) + 1;
        await client.query(
          `INSERT INTO system_settings (key, value_json, updated_by, version)
           VALUES ($1, $2::jsonb, $3, $4)
           ON CONFLICT (key) DO UPDATE SET
             value_json = EXCLUDED.value_json,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by,
             version = EXCLUDED.version`,
          [item.key, JSON.stringify(item.value), actorId, rowVersion],
        );
        const versionRow = await client.query<{ id: string }>(
          `INSERT INTO config_versions
             (scope, key, old_value_json, new_value_json, changed_by)
           VALUES ('system', $1, $2::jsonb, $3::jsonb, $4)
           RETURNING id`,
          [item.key, JSON.stringify(oldValue), JSON.stringify(item.value), actorId],
        );
        nextVersion = Number(versionRow.rows[0]!.id);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await this.publisher.publish("eva.config.changed", JSON.stringify({
      scope: "system",
      keys: validated.map((item) => item.key),
      version: nextVersion,
    }));
    return await this.getAll();
  }

  async rollback(versionId: number, actorId: string): Promise<Awaited<ReturnType<ConfigService["getAll"]>>> {
    if (!Number.isSafeInteger(versionId) || versionId <= 0) throw adminBadRequest("Некорректная версия");
    const client = await this.pool.connect();
    let key = "";
    let nextVersion = 0;
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE config_versions IN EXCLUSIVE MODE");
      const { rows } = await client.query<{
        key: string;
        old_value_json: unknown;
      }>(
        `SELECT key, old_value_json
           FROM config_versions
          WHERE id = $1 AND scope = 'system'
          FOR UPDATE`,
        [versionId],
      );
      const version = rows[0];
      if (!version || !SETTING_BY_KEY.has(version.key)) throw adminNotFound("Версия настройки не найдена");
      key = version.key;
      const current = await client.query<{ value_json: unknown; version: string }>(
        "SELECT value_json, version FROM system_settings WHERE key = $1 FOR UPDATE",
        [key],
      );
      const currentValue = current.rows[0]?.value_json ?? null;
      if (version.old_value_json === null) {
        await client.query("DELETE FROM system_settings WHERE key = $1", [key]);
      } else {
        await client.query(
          `INSERT INTO system_settings (key, value_json, updated_by, version)
           VALUES ($1, $2::jsonb, $3, 1)
           ON CONFLICT (key) DO UPDATE SET
             value_json = EXCLUDED.value_json,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by,
             version = system_settings.version + 1`,
          [key, JSON.stringify(version.old_value_json), actorId],
        );
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO config_versions
           (scope, key, old_value_json, new_value_json, changed_by)
         VALUES ('system', $1, $2::jsonb, $3::jsonb, $4)
         RETURNING id`,
        [key, JSON.stringify(currentValue), JSON.stringify(version.old_value_json), actorId],
      );
      nextVersion = Number(inserted.rows[0]!.id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await this.publisher.publish("eva.config.changed", JSON.stringify({
      scope: "system",
      keys: [key],
      version: nextVersion,
    }));
    return await this.getAll();
  }

  private async currentVersion(client: pg.Pool | pg.PoolClient = this.pool): Promise<number> {
    const { rows } = await client.query<{ version: string }>(
      "SELECT COALESCE(max(id), 0)::text AS version FROM config_versions",
    );
    return Number(rows[0]?.version ?? 0);
  }
}
