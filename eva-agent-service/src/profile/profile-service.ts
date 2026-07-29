import type { Database } from "../db.js";
import type { GraphRepository } from "../memory/graph-repository.js";
import type { RuntimeContextBuilder } from "../runtime/runtime-context.js";
import type { TimezoneResolver } from "../time/timezone-resolver.js";

export type ProfileStatus =
  | "missing"
  | "candidate"
  | "confirmed"
  | "declined"
  | "not_applicable"
  | "superseded";

export interface ProfileFieldDefinition {
  field_key: string;
  title: string;
  value_type: "string" | "string_array" | "object";
  priority: number;
  required_level: "essential" | "useful" | "optional";
  sensitivity: "normal" | "sensitive" | "high";
  prompt_hint: string;
  confirmation_required: boolean;
  cooldown_days: number;
  max_ask_count: number;
  enabled: boolean;
  sort_order: number;
}

export interface ProfileField {
  id: string;
  field_key: string;
  field_value: string | null;
  field_json: unknown;
  status: ProfileStatus;
  confidence: string | null;
  source_type: string | null;
  source_id: string | null;
  source_quote: string | null;
  last_asked_at: Date | null;
  ask_count: number;
  declined_at: Date | null;
  confirmed_at: Date | null;
  sensitivity: "normal" | "sensitive" | "high";
  meta: Record<string, unknown>;
  updated_at: Date;
}

export class UserProfileService {
  constructor(
    private readonly db: Database,
    private readonly timezoneResolver?: TimezoneResolver,
    private readonly runtimeContext?: RuntimeContextBuilder,
    private readonly graph?: GraphRepository,
  ) {}

  async upsert(input: {
    userId: number;
    fieldKey: string;
    value: unknown;
    sourceQuote?: string | null;
    sourceType?: string;
    sourceId?: string | null;
    confidence?: number;
    explicitlyStated?: boolean;
  }): Promise<ProfileField> {
    const definition = await this.definition(input.fieldKey);
    const normalized = normalizeProfileValue(input.value, definition.value_type);
    const confidence = clamp(input.confidence ?? (input.explicitlyStated ? 1 : 0.7), 0, 1);
    const needsConfirmation =
      definition.confirmation_required || definition.sensitivity !== "normal";
    const status: ProfileStatus = needsConfirmation ? "candidate" : "confirmed";
    const persist = async (queryable: Pick<Database, "query">): Promise<ProfileField> => {
      const { rows } = await queryable.query<ProfileField>(
        `INSERT INTO onboarding_fields
         (user_id, field_key, field_value, field_json, status, confidence,
          source_type, source_id, source_quote, confirmed_at, sensitivity, meta)
       VALUES
         ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9,
          CASE WHEN $5 = 'confirmed' THEN now() ELSE NULL END,
          $10, $11::jsonb)
       ON CONFLICT (user_id, field_key) DO UPDATE SET
         field_value = EXCLUDED.field_value,
         field_json = EXCLUDED.field_json,
         status = EXCLUDED.status,
         confidence = EXCLUDED.confidence,
         source_type = EXCLUDED.source_type,
         source_id = EXCLUDED.source_id,
         source_quote = EXCLUDED.source_quote,
         declined_at = NULL,
         confirmed_at = EXCLUDED.confirmed_at,
         sensitivity = EXCLUDED.sensitivity,
         meta = EXCLUDED.meta,
         answered_at = now()
         RETURNING *`,
        [
          input.userId,
          definition.field_key,
          normalized.text,
          normalized.json === null ? null : JSON.stringify(normalized.json),
          status,
          confidence,
          (input.sourceType ?? "conversation").slice(0, 100),
          input.sourceId?.slice(0, 300) ?? null,
          input.sourceQuote?.trim().slice(0, 2_000) ?? null,
          definition.sensitivity,
          JSON.stringify({ explicitly_stated: input.explicitlyStated === true }),
        ],
      );
      const saved = rows[0]!;
      await this.graph?.syncProfile(queryable, input.userId, saved);
      return saved;
    };
    const saved = this.graph
      ? await this.db.transaction(async (client) => await persist(client as never))
      : await persist(this.db);
    if (status === "confirmed") await this.syncConfirmed(input.userId, saved);
    this.runtimeContext?.invalidate(input.userId);
    return saved;
  }

  async confirm(userId: number, fieldKey: string): Promise<ProfileField> {
    const candidate = await this.db.query<ProfileField>(
      `SELECT * FROM onboarding_fields
        WHERE user_id = $1 AND field_key = $2 AND status = 'candidate'`,
      [userId, fieldKey],
    );
    if (!candidate.rows[0]) throw new Error("Сведение для подтверждения не найдено");
    // Validate and synchronize denormalized fields before changing the source
    // of truth to confirmed. A failed timezone resolution therefore leaves the
    // candidate available for correction.
    await this.syncConfirmed(userId, candidate.rows[0]);
    const save = async (queryable: Pick<Database, "query">): Promise<ProfileField> => {
      const { rows } = await queryable.query<ProfileField>(
        `UPDATE onboarding_fields
          SET status = 'confirmed',
              confirmed_at = now(),
              declined_at = NULL,
              confidence = GREATEST(COALESCE(confidence, 0), 0.9)
        WHERE user_id = $1
          AND field_key = $2
          AND status = 'candidate'
         RETURNING *`,
        [userId, fieldKey],
      );
      const saved = rows[0];
      if (!saved) throw new Error("Сведение для подтверждения не найдено");
      await this.graph?.syncProfile(queryable, userId, saved);
      return saved;
    };
    const saved = this.graph
      ? await this.db.transaction(async (client) => await save(client as never))
      : await save(this.db);
    this.runtimeContext?.invalidate(userId);
    return saved;
  }

  async decline(userId: number, fieldKey: string): Promise<ProfileField> {
    const save = async (queryable: Pick<Database, "query">): Promise<ProfileField> => {
      const { rows } = await queryable.query<ProfileField>(
        `INSERT INTO onboarding_fields
         (user_id, field_key, status, declined_at, sensitivity)
       SELECT $1, d.field_key, 'declined', now(), d.sensitivity
         FROM profile_field_definitions d
        WHERE d.field_key = $2 AND d.enabled
       ON CONFLICT (user_id, field_key) DO UPDATE SET
         status = 'declined',
         declined_at = now(),
         confirmed_at = NULL,
         field_value = NULL,
         field_json = NULL,
         source_quote = NULL,
         source_id = NULL
         RETURNING *`,
        [userId, fieldKey],
      );
      if (!rows[0]) throw new Error("Неизвестное поле профиля");
      await this.graph?.syncProfile(queryable, userId, rows[0]);
      return rows[0];
    };
    const saved = this.graph
      ? await this.db.transaction(async (client) => await save(client as never))
      : await save(this.db);
    this.runtimeContext?.invalidate(userId);
    return saved;
  }

  async markAsked(userId: number, fieldKey: string): Promise<void> {
    await this.db.query(
      `INSERT INTO onboarding_fields
         (user_id, field_key, status, last_asked_at, ask_count, sensitivity)
       SELECT $1, d.field_key, 'missing', now(), 1, d.sensitivity
         FROM profile_field_definitions d
        WHERE d.field_key = $2 AND d.enabled
       ON CONFLICT (user_id, field_key) DO UPDATE SET
         last_asked_at = now(),
         ask_count = onboarding_fields.ask_count + 1`,
      [userId, fieldKey],
    );
    this.runtimeContext?.invalidate(userId);
  }

  async setLanguage(
    userId: number,
    language: "ru" | "en" | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE users
          SET language_mode = CASE WHEN $2::text IS NULL THEN 'auto' ELSE 'fixed' END,
              preferred_language = $2,
              language_updated_at = now()
        WHERE id = $1`,
      [userId, language],
    );
    this.runtimeContext?.invalidate(userId);
  }

  async getProfile(userId: number): Promise<{
    confirmed: ProfileField[];
    candidates: ProfileField[];
    completeness: number;
  }> {
    const [{ rows }, definitions] = await Promise.all([
      this.db.query<ProfileField>(
        `SELECT * FROM onboarding_fields
          WHERE user_id = $1 AND status IN ('confirmed', 'candidate')
          ORDER BY field_key`,
        [userId],
      ),
      this.listDefinitions(),
    ]);
    const confirmed = rows.filter((row) => row.status === "confirmed");
    const useful = definitions.filter((item) => item.required_level !== "optional");
    const confirmedUseful = new Set(
      confirmed
        .filter((item) => useful.some((definition) => definition.field_key === item.field_key))
        .map((item) => item.field_key),
    );
    return {
      confirmed,
      candidates: rows.filter((row) => row.status === "candidate"),
      completeness: useful.length === 0
        ? 1
        : Math.round((confirmedUseful.size / useful.length) * 100) / 100,
    };
  }

  async listDefinitions(): Promise<ProfileFieldDefinition[]> {
    const { rows } = await this.db.query<ProfileFieldDefinition>(
      `SELECT * FROM profile_field_definitions
        WHERE enabled
        ORDER BY priority, sort_order, field_key`,
    );
    return rows;
  }

  private async definition(fieldKey: string): Promise<ProfileFieldDefinition> {
    const { rows } = await this.db.query<ProfileFieldDefinition>(
      "SELECT * FROM profile_field_definitions WHERE field_key = $1 AND enabled",
      [fieldKey.trim()],
    );
    if (!rows[0]) throw new Error(`Поле профиля «${fieldKey}» не разрешено`);
    return rows[0];
  }

  private async syncConfirmed(userId: number, field: ProfileField): Promise<void> {
    const value = field.field_value;
    if (field.field_key === "city" && value) {
      await this.db.query("UPDATE users SET city = $2 WHERE id = $1", [userId, value]);
    } else if (field.field_key === "timezone" && value) {
      if (!this.timezoneResolver) {
        throw new Error("TimezoneResolver не настроен");
      }
      const resolution = await this.timezoneResolver.resolve(value);
      if (!resolution.resolved) {
        const options = resolution.candidates.map((item) => item.timezone).join(", ");
        throw new Error(
          resolution.ambiguous
            ? `Часовой пояс неоднозначен; варианты: ${options}`
            : "Не удалось подтвердить IANA timezone",
        );
      }
      await this.timezoneResolver.saveConfirmed(userId, resolution.resolved);
      await this.db.query(
        `UPDATE onboarding_fields
            SET field_value = $3
          WHERE user_id = $1 AND field_key = $2`,
        [userId, field.field_key, resolution.resolved.timezone],
      );
    } else if (field.field_key === "communication_style" && value) {
      await this.db.query(
        `INSERT INTO user_preferences (user_id, character)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET character = EXCLUDED.character`,
        [userId, value],
      );
    }
  }
}

export function normalizeProfileValue(
  value: unknown,
  valueType: ProfileFieldDefinition["value_type"],
): { text: string | null; json: unknown } {
  if (valueType === "string") {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error("Ожидается строковое значение профиля");
    }
    const text = cleanString(String(value), 2_000);
    if (!text) throw new Error("Значение профиля не должно быть пустым");
    return { text, json: null };
  }
  if (valueType === "string_array") {
    const raw = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/[,;\n]/)
        : [];
    const unique = new Map<string, string>();
    for (const item of raw) {
      if (typeof item !== "string" && typeof item !== "number") continue;
      const clean = cleanString(String(item), 200);
      const key = clean.toLocaleLowerCase("ru");
      if (clean && !unique.has(key)) unique.set(key, clean);
      if (unique.size >= 30) break;
    }
    const values = [...unique.values()];
    if (values.length === 0) throw new Error("Массив профиля не должен быть пустым");
    return { text: null, json: values };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ожидается JSON-объект профиля");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 10_000) throw new Error("JSON-значение профиля слишком велико");
  return { text: null, json: JSON.parse(serialized) };
}

function cleanString(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
