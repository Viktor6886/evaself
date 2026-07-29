import type { Database } from "../db.js";
import { isValidIanaTimezone } from "./local-date-time.js";

export interface TimezoneCandidate {
  city: string | null;
  countryCode: string | null;
  timezone: string;
  source: "iana" | "alias";
  confidence: number;
}

export interface TimezoneResolution {
  resolved: TimezoneCandidate | null;
  candidates: TimezoneCandidate[];
  ambiguous: boolean;
}

interface AliasRow {
  city: string;
  country_code: string;
  timezone: string;
}

export class TimezoneResolver {
  private readonly cache = new Map<string, { expiresAt: number; value: TimezoneResolution }>();

  constructor(
    private readonly db: Database,
    private readonly cacheTtlMs = 5 * 60_000,
  ) {}

  async resolve(input: string, countryCode?: string | null): Promise<TimezoneResolution> {
    const value = input.trim();
    if (!value) return { resolved: null, candidates: [], ambiguous: false };
    if (isValidIanaTimezone(value)) {
      const candidate: TimezoneCandidate = {
        city: null,
        countryCode: normalizeCountry(countryCode),
        timezone: value,
        source: "iana",
        confidence: 1,
      };
      return { resolved: candidate, candidates: [candidate], ambiguous: false };
    }

    const alias = normalizeAlias(value);
    const country = normalizeCountry(countryCode);
    const cacheKey = `${alias}|${country ?? ""}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const { rows } = await this.db.query<AliasRow>(
      `SELECT city, country_code, timezone
         FROM timezone_aliases
        WHERE enabled
          AND lower(alias) = $1
          AND ($2::text IS NULL OR country_code = $2)
        ORDER BY
          CASE WHEN country_code = $2 THEN 0 ELSE 1 END,
          priority,
          city
        LIMIT 3`,
      [alias, country],
    );
    const candidates = deduplicate(rows.map((row) => ({
      city: row.city,
      countryCode: row.country_code || null,
      timezone: row.timezone,
      source: "alias" as const,
      confidence: rows.length === 1 ? 0.98 : 0.75,
    })));
    const result: TimezoneResolution = {
      resolved: candidates.length === 1 ? candidates[0]! : null,
      candidates,
      ambiguous: candidates.length > 1,
    };
    this.cache.set(cacheKey, { expiresAt: Date.now() + this.cacheTtlMs, value: result });
    return result;
  }

  async saveConfirmed(userId: number, candidate: TimezoneCandidate): Promise<void> {
    if (!isValidIanaTimezone(candidate.timezone)) {
      throw new Error(`Некорректный часовой пояс IANA: ${candidate.timezone}`);
    }
    await this.db.query(
      `UPDATE users
          SET city = COALESCE($2, city),
              country_code = COALESCE($3, country_code),
              timezone = $4,
              timezone_source = $5,
              timezone_confidence = $6,
              timezone_updated_at = now()
        WHERE id = $1`,
      [
        userId,
        candidate.city,
        candidate.countryCode,
        candidate.timezone,
        candidate.source,
        candidate.confidence,
      ],
    );
  }

  clearCache(): void {
    this.cache.clear();
  }
}

function normalizeAlias(value: string): string {
  return value
    .toLocaleLowerCase("ru")
    .replace(/[.,()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCountry(value: string | null | undefined): string | null {
  const country = value?.trim().toUpperCase();
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
}

function deduplicate(values: TimezoneCandidate[]): TimezoneCandidate[] {
  return [...new Map(values.map((item) => [item.timezone, item])).values()];
}
