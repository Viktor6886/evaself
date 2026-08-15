import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";

import type pg from "pg";

import { adminBadRequest } from "./errors.js";
import { globalSecretRedactor } from "./redactor.js";

export interface SecretEnvelope {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}

export interface SecretMetadata {
  secret_ref: string;
  configured: boolean;
  created_at: Date | string | null;
  last_rotated_at: Date | string | null;
  used_by: string[];
}

export interface SecretStoreOptions {
  masterKey: Buffer;
  pool: pg.Pool;
}

const KNOWN_SECRETS: Readonly<Record<string, string[]>> = {
  sec_eva_telegram_bot_token: ["telegram-runtime"],
  sec_eva_telegram_webhook_secret: ["telegram-runtime"],
  sec_eva_agent_api_key: ["agent-runtime"],
  sec_letta_app_server_token: ["agent-runtime", "app-server"],
  sec_eva_llm_api_key: ["agent-runtime", "app-server"],
  sec_eva_embedding_api_key: ["agent-runtime"],
  sec_llm_config_encryption_key: ["agent-runtime"],
  sec_todoist_api_token: ["agent-runtime"],
  sec_crawl4ai_api_token: ["crawl4ai"],
  sec_searxng_secret: ["searxng"],
  sec_media_asr_api_key: ["media-service"],
  sec_media_tts_api_key: ["media-service"],
  sec_nc_auth_jwt_secret: ["nocodb"],
  sec_nc_admin_password: ["nocodb"],
  sec_letta_ui_password: ["letta-ui"],
  sec_lava_webhook_user: ["payment-runtime"],
  sec_lava_webhook_password: ["payment-runtime"],
  sec_postgres_super_password: ["postgres"],
  sec_eva_db_password: ["postgres", "agent-runtime", "admin-api"],
  sec_eva_db_readonly_password: ["postgres", "nocodb"],
  sec_nocodb_db_password: ["postgres", "nocodb"],
  sec_letta_db_password: ["postgres", "app-server"],
  sec_valkey_password: ["valkey", "agent-runtime", "admin-api"],
};

/**
 * Кто читает этот секрет по объявлению каталога.
 *
 * Список потребителей уже задан в `KNOWN_SECRETS` и показывается в
 * панели; служебному вызову (не HTTP-маршруту) незачем повторять его
 * своей копией — разойдясь, две копии дают запись, у которой в панели
 * «Используют: не указано». Неизвестная ссылка даёт пустой список, а не
 * отказ: секрет всё равно должен сохраниться.
 */
export function declaredUsedBy(secretRef: string): string[] {
  return [...(KNOWN_SECRETS[secretRef] ?? [])];
}

export function parseMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32 && decoded.toString("base64").replace(/=+$/, "") === trimmed.replace(/=+$/, "")) {
    return decoded;
  }
  const raw = Buffer.from(trimmed, "utf8");
  if (raw.length === 32) return raw;
  throw new Error("EVA_SECRETS_MASTER_KEY должен содержать ровно 32 байта");
}

export async function loadMasterKey(env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  const file = (env.EVA_SECRETS_MASTER_KEY_FILE ?? "").trim();
  const inline = (env.EVA_SECRETS_MASTER_KEY ?? "").trim();
  const value = file ? await readFile(file, "utf8") : inline;
  if (!value.trim()) throw new Error("EVA_SECRETS_MASTER_KEY не настроен");
  const key = parseMasterKey(value);
  globalSecretRedactor.register(value.trim());
  return key;
}

function normalizedUsedBy(input: unknown): string[] {
  if (!Array.isArray(input)) throw adminBadRequest("used_by должен быть массивом строк");
  return [...new Set(
    input.map((item) => String(item).trim()).filter((item) => /^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(item)),
  )].sort();
}

export class SecretStore {
  constructor(private readonly options: SecretStoreOptions) {}

  seal(value: string): SecretEnvelope {
    if (!value) throw adminBadRequest("Секретное значение не может быть пустым");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.options.masterKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    globalSecretRedactor.register(value);
    return { ciphertext, nonce, authTag };
  }

  open(envelope: SecretEnvelope): string {
    const decipher = createDecipheriv("aes-256-gcm", this.options.masterKey, envelope.nonce);
    decipher.setAuthTag(envelope.authTag);
    const value = Buffer.concat([
      decipher.update(envelope.ciphertext),
      decipher.final(),
    ]).toString("utf8");
    globalSecretRedactor.register(value);
    return value;
  }

  async put(
    secretRef: string,
    value: string,
    usedByInput: unknown,
    actorId: string | null,
  ): Promise<SecretMetadata> {
    if (!/^sec_[a-z0-9_]+$/.test(secretRef)) {
      throw adminBadRequest("Некорректный secret_ref");
    }
    const usedBy = normalizedUsedBy(usedByInput);
    const envelope = this.seal(value);
    const { rows } = await this.options.pool.query<{
      secret_ref: string;
      created_at: Date;
      last_rotated_at: Date;
      used_by_json: unknown;
    }>(
      `INSERT INTO secret_records
         (secret_ref, ciphertext, nonce, auth_tag, rotated_by, used_by_json, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active')
       ON CONFLICT (secret_ref) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         nonce = EXCLUDED.nonce,
         auth_tag = EXCLUDED.auth_tag,
         last_rotated_at = now(),
         rotated_by = EXCLUDED.rotated_by,
         used_by_json = EXCLUDED.used_by_json,
         status = 'active'
       RETURNING secret_ref, created_at, last_rotated_at, used_by_json`,
      [
        secretRef,
        envelope.ciphertext,
        envelope.nonce,
        envelope.authTag,
        actorId,
        JSON.stringify(usedBy),
      ],
    );
    return this.toMetadata(rows[0]!);
  }

  async list(): Promise<SecretMetadata[]> {
    const { rows } = await this.options.pool.query<{
      secret_ref: string;
      created_at: Date;
      last_rotated_at: Date;
      used_by_json: unknown;
    }>(
      `SELECT secret_ref, created_at, last_rotated_at, used_by_json
         FROM secret_records
        WHERE status = 'active'
        ORDER BY secret_ref`,
    );
    const configured = new Map(rows.map((row) => [row.secret_ref, this.toMetadata(row)]));
    const result: SecretMetadata[] = [];
    for (const [secretRef, usedBy] of Object.entries(KNOWN_SECRETS)) {
      result.push(configured.get(secretRef) ?? {
        secret_ref: secretRef,
        configured: false,
        created_at: null,
        last_rotated_at: null,
        used_by: [...usedBy],
      });
      configured.delete(secretRef);
    }
    result.push(...configured.values());
    return result.sort((left, right) => left.secret_ref.localeCompare(right.secret_ref));
  }

  async get(secretRef: string): Promise<string | null> {
    const { rows } = await this.options.pool.query<{
      ciphertext: Buffer;
      nonce: Buffer;
      auth_tag: Buffer;
    }>(
      `SELECT ciphertext, nonce, auth_tag
         FROM secret_records
        WHERE secret_ref = $1 AND status = 'active'`,
      [secretRef],
    );
    const row = rows[0];
    return row
      ? this.open({ ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag })
      : null;
  }

  async primeRedactor(): Promise<void> {
    const { rows } = await this.options.pool.query<{
      ciphertext: Buffer;
      nonce: Buffer;
      auth_tag: Buffer;
    }>("SELECT ciphertext, nonce, auth_tag FROM secret_records WHERE status = 'active'");
    for (const row of rows) {
      this.open({ ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag });
    }
  }

  private toMetadata(row: {
    secret_ref: string;
    created_at: Date | string;
    last_rotated_at: Date | string;
    used_by_json: unknown;
  }): SecretMetadata {
    return {
      secret_ref: row.secret_ref,
      configured: true,
      created_at: row.created_at,
      last_rotated_at: row.last_rotated_at,
      used_by: Array.isArray(row.used_by_json)
        ? row.used_by_json.filter((item): item is string => typeof item === "string")
        : [],
    };
  }
}
