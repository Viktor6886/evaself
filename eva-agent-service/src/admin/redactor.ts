const SENSITIVE_KEY =
  /(authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|ciphertext|nonce|auth[_-]?tag|master[_-]?key)/i;

const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/** Shared redactor for structured logs, audit payloads and safe errors. */
export class SecretRedactor {
  private readonly knownValues = new Set<string>();

  register(value: string): void {
    if (value.length >= 4) this.knownValues.add(value);
  }

  redact<T>(input: T): T {
    return this.walk(input, new WeakSet<object>()) as T;
  }

  redactText(input: string): string {
    let result = input.replace(AUTHORIZATION_VALUE, "$1 [REDACTED]");
    for (const secret of this.knownValues) {
      result = result.split(secret).join("[REDACTED]");
    }
    return result;
  }

  private walk(value: unknown, seen: WeakSet<object>, key = ""): unknown {
    if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (typeof value === "string") return this.redactText(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => this.walk(item, seen));
    }
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = this.walk(childValue, seen, childKey);
    }
    return output;
  }
}

export const globalSecretRedactor = new SecretRedactor();

export function redactForLogs<T>(value: T): T {
  return globalSecretRedactor.redact(value);
}

export function auditParams(
  url: string,
  body: unknown,
  params: unknown,
): Record<string, unknown> {
  if (url.includes("/secrets/")) {
    const usedBy =
      body && typeof body === "object" && Array.isArray((body as { used_by?: unknown }).used_by)
        ? (body as { used_by: unknown[] }).used_by.filter((item) => typeof item === "string")
        : [];
    return globalSecretRedactor.redact({ params, used_by: usedBy });
  }
  return globalSecretRedactor.redact({ params, body });
}
