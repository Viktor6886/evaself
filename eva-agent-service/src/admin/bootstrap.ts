import { randomUUID } from "node:crypto";

import type pg from "pg";

import { assertPasswordPolicy, hashPassword } from "./password-policy.js";
import { globalSecretRedactor } from "./redactor.js";
import { SecretStore } from "./secret-store.js";
import { ALL_SETTINGS, parseBootstrapSetting } from "./settings-registry.js";

const SECRET_NAME =
  /(_API_KEY|_TOKEN|_PASSWORD|_SECRET|_CREDENTIALS?|_AUTH|_HASH|ENCRYPTION_KEY)$/i;

const EXCLUDED = new Set([
  "EVA_SECRETS_MASTER_KEY",
  "EVA_SECRETS_MASTER_KEY_FILE",
  "EVA_ADMIN_BOOTSTRAP_PASSWORD",
  "DATABASE_URL",
  "VALKEY_URL",
]);

const SAFE_EXTRA_SETTINGS = new Set([
  "DOMAIN", "DOMAIN_APP", "DOMAIN_API", "DOMAIN_LETTA", "DOMAIN_STATUS",
  "ACME_EMAIL", "ACME_CA", "EVA_ENV", "EVA_ADMIN_BIND",
  "EVA_LLM_PROVIDER_NAME", "EVA_LLM_PROTOCOL", "EVA_LLM_BASE_URL", "EVA_LLM_MODEL",
  "EVA_LLM_CONTEXT_WINDOW", "EVA_LLM_ADDITIONAL_PARAMETERS", "EVA_LLM_PROBE_TIMEOUT_MS",
  "EVA_EMBEDDING_BASE_URL", "EVA_EMBEDDING_MODEL", "EVA_EMBEDDING_DIM",
  "EVA_TELEGRAM_API_BASE_URL", "EVA_TELEGRAM_WEBAPP_MAX_AGE_SECONDS",
  "OWNER_TELEGRAM_ID",
  "SEARXNG_BASE_URL", "MEDIA_ASR_BASE_URL", "MEDIA_ASR_MODEL",
  "MEDIA_TTS_BASE_URL", "MEDIA_TTS_MODEL", "MEDIA_TTS_VOICE",
  "MEDIA_MAX_UPLOAD_MB", "MEDIA_MAX_AUDIO_SECONDS", "MEDIA_TMP_TTL_SECONDS",
  "NC_ADMIN_EMAIL", "NC_INVITE_ONLY_SIGNUP", "LETTA_UI_USER",
]);

const SECRET_USED_BY: Record<string, string[]> = {
  EVA_TELEGRAM_BOT_TOKEN: ["telegram-runtime"],
  EVA_TELEGRAM_WEBHOOK_SECRET: ["telegram-runtime"],
  EVA_AGENT_API_KEY: ["agent-runtime"],
  LETTA_APP_SERVER_TOKEN: ["agent-runtime", "app-server"],
  EVA_LLM_API_KEY: ["agent-runtime", "app-server"],
  LLM_CONFIG_ENCRYPTION_KEY: ["agent-runtime"],
  CRAWL4AI_API_TOKEN: ["crawl4ai"],
  SEARXNG_SECRET: ["searxng"],
  MEDIA_SERVICE_TOKEN: ["media-service", "agent-runtime", "admin-api"],
  MEDIA_ASR_API_KEY: ["media-service"],
  MEDIA_TTS_API_KEY: ["media-service"],
  LETTA_UI_PASSWORD: ["letta-ui"],
  LAVA_WEBHOOK_USER: ["payment-runtime"],
  LAVA_WEBHOOK_PASSWORD: ["payment-runtime"],
  POSTGRES_SUPER_PASSWORD: ["postgres"],
  EVA_DB_PASSWORD: ["postgres", "agent-runtime"],
  EVA_DB_READONLY_PASSWORD: ["postgres"],
  LETTA_DB_PASSWORD: ["postgres", "app-server"],
  VALKEY_PASSWORD: ["valkey", "agent-runtime", "admin-api"],
};

function secretRef(name: string): string {
  return `sec_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function settingKey(name: string): string {
  return `bootstrap.env.${name.toLowerCase().replace(/_/g, ".")}`;
}

function safeJsonValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (/^-?\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (Number.isSafeInteger(value)) return value;
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export interface BootstrapResult {
  alreadyCompleted: boolean;
  ownerCreated: boolean;
  settingsImported: number;
  secretsImported: number;
}

export async function runAdminBootstrap(
  pool: pg.Pool,
  secretStore: SecretStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootstrapResult> {
  const requestId = `bootstrap-${randomUUID()}`;
  const auditId = randomUUID();
  const startedAt = Date.now();
  await pool.query(
    `INSERT INTO audit_log
       (id, actor, operation, target, params_redacted_json, result, request_id)
     VALUES ($1, 'system', 'admin.bootstrap', 'environment',
             '{"source":"environment"}'::jsonb, 'pending', $2)`,
    [auditId, requestId],
  );
  try {
    const result = await bootstrapTransaction(pool, secretStore, env);
    await pool.query(
      `UPDATE audit_log
          SET result = 'success', completed_at = now(), duration_ms = $2,
              message = $3
        WHERE id = $1 AND result = 'pending'`,
      [
        auditId,
        Date.now() - startedAt,
        `Настройки: ${result.settingsImported}; секреты: ${result.secretsImported}`,
      ],
    );
    return result;
  } catch (error) {
    await pool.query(
      `UPDATE audit_log
          SET result = 'failure', completed_at = now(), duration_ms = $2,
              message = 'Bootstrap не завершён'
        WHERE id = $1 AND result = 'pending'`,
      [auditId, Date.now() - startedAt],
    );
    throw error;
  }
}

async function bootstrapTransaction(
  pool: pg.Pool,
  secretStore: SecretStore,
  env: NodeJS.ProcessEnv,
): Promise<BootstrapResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evaself-admin-bootstrap'))");
    const marker = await client.query<{ value_json: unknown }>(
      "SELECT value_json FROM system_settings WHERE key = 'admin.bootstrap.env_import'",
    );
    const userCount = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM admin_users");
    let ownerCreated = false;
    if (Number(userCount.rows[0]?.count ?? 0) === 0) {
      const username = (env.EVA_ADMIN_USERNAME ?? env.LETTA_UI_USER ?? "admin").trim();
      const password = (env.EVA_ADMIN_BOOTSTRAP_PASSWORD || env.LETTA_UI_PASSWORD || "").trim();
      if (!password) throw new Error("EVA_ADMIN_BOOTSTRAP_PASSWORD не настроен для первого запуска");
      globalSecretRedactor.register(password);
      assertPasswordPolicy(password, username);
      await client.query(
        `INSERT INTO admin_users (username, password_hash, role, status)
         VALUES ($1, $2, 'owner', 'active')`,
        [username, await hashPassword(password)],
      );
      ownerCreated = true;
    }
    const markerValue = marker.rows[0]?.value_json;
    const markerSchema = markerValue && typeof markerValue === "object" &&
      !Array.isArray(markerValue)
      ? Number((markerValue as { schema?: unknown }).schema ?? 0)
      : 0;
    if (markerSchema >= 2) {
      await client.query("COMMIT");
      return { alreadyCompleted: true, ownerCreated, settingsImported: 0, secretsImported: 0 };
    }

    let settingsImported = 0;
    let secretsImported = 0;
    const registryEnv = new Map(ALL_SETTINGS.map((definition) => [definition.env, definition]));
    for (const [name, rawValue] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
      const value = rawValue?.trim() ?? "";
      if (!value || EXCLUDED.has(name)) continue;
      const explicitlySecret = name === "LAVA_WEBHOOK_USER";
      if (explicitlySecret || SECRET_NAME.test(name)) {
        const ref = secretRef(name);
        const envelope = secretStore.seal(value);
        const inserted = await client.query(
          `INSERT INTO secret_records
             (secret_ref, ciphertext, nonce, auth_tag, used_by_json, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'active')
           ON CONFLICT (secret_ref) DO NOTHING`,
          [
            ref,
            envelope.ciphertext,
            envelope.nonce,
            envelope.authTag,
            JSON.stringify(SECRET_USED_BY[name] ?? ["config-service"]),
          ],
        );
        if (inserted.rowCount) secretsImported += 1;
        continue;
      }
      const definition = registryEnv.get(name);
      if (!definition && !SAFE_EXTRA_SETTINGS.has(name)) continue;
      const key = definition?.key ?? settingKey(name);
      const parsed = definition ? parseBootstrapSetting(definition, value) : safeJsonValue(value);
      const inserted = await client.query(
        `INSERT INTO system_settings (key, value_json)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        [key, JSON.stringify(parsed)],
      );
      if (inserted.rowCount) {
        settingsImported += 1;
        await client.query(
          `INSERT INTO config_versions
             (scope, key, old_value_json, new_value_json)
           VALUES ('bootstrap', $1, NULL, $2::jsonb)`,
          [key, JSON.stringify(parsed)],
        );
      }
    }
    await client.query(
      `INSERT INTO system_settings (key, value_json)
       VALUES ('admin.bootstrap.env_import',
               jsonb_build_object('completed', true, 'schema', 2, 'source', 'environment'))
       ON CONFLICT (key) DO UPDATE SET
         value_json = EXCLUDED.value_json,
         updated_at = now()`,
    );
    await client.query("COMMIT");
    return { alreadyCompleted: false, ownerCreated, settingsImported, secretsImported };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
