/**
 * One error shape for everything that can go wrong between the runtime and the
 * Letta App Server:
 *
 *   {"error": {"code": "app_server_unavailable", "message": "…", "retryable": true}}
 *
 * Callers only ever have to look at `code` and `retryable`.
 */

export class EvaError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    message: string,
    options: { code?: string; statusCode?: number; retryable?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = "EvaError";
    this.code = options.code ?? "internal_error";
    this.statusCode = options.statusCode ?? 500;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toPayload(): Record<string, unknown> {
    const error: Record<string, unknown> = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

export const unauthorized = (message: string) =>
  new EvaError(message, { code: "unauthorized", statusCode: 401 });

export const badRequest = (message: string, details?: unknown) =>
  new EvaError(message, { code: "bad_request", statusCode: 400, details });

export const notFound = (message: string) =>
  new EvaError(message, { code: "not_found", statusCode: 404 });

export const userBusy = (message: string, retryAfterSeconds: number) =>
  new EvaError(message, {
    code: "user_busy",
    statusCode: 409,
    retryable: true,
    details: { retry_after_seconds: retryAfterSeconds },
  });

export const tooManyRequests = (message: string, retryAfterSeconds: number) =>
  new EvaError(message, {
    code: "rate_limited",
    statusCode: 429,
    retryable: true,
    details: { retry_after_seconds: retryAfterSeconds },
  });

export const appServerUnavailable = (message: string, details?: unknown) =>
  new EvaError(message, {
    code: "app_server_unavailable",
    statusCode: 503,
    retryable: true,
    details,
  });

export const turnTimeout = (message: string) =>
  new EvaError(message, { code: "turn_timeout", statusCode: 504, retryable: true });

export const turnFailed = (message: string, details?: unknown) =>
  new EvaError(message, { code: "turn_failed", statusCode: 502, details });

export const databaseUnavailable = (message: string) =>
  new EvaError(message, { code: "database_unavailable", statusCode: 503, retryable: true });

/**
 * Map anything thrown by the SDK or a driver onto an EvaError.
 * Connection-shaped failures are retryable; protocol-shaped ones are not.
 */
export function toEvaError(error: unknown, context: string): EvaError {
  if (error instanceof EvaError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("socket hang up") ||
    lower.includes("websocket") ||
    lower.includes("disconnect") ||
    lower.includes("closed")
  ) {
    return appServerUnavailable(`${context}: ${message}`);
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return turnTimeout(`${context}: ${message}`);
  }
  return turnFailed(`${context}: ${message}`);
}
