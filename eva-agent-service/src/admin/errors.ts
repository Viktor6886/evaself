export class AdminApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

export const adminBadRequest = (message: string, details: Record<string, unknown> = {}) =>
  new AdminApiError("bad_request", message, 400, details);
export const adminUnauthorized = (message = "Требуется вход") =>
  new AdminApiError("unauthorized", message, 401);
export const adminForbidden = (message = "Недостаточно прав") =>
  new AdminApiError("forbidden", message, 403);
export const adminNotFound = (message = "Объект не найден") =>
  new AdminApiError("not_found", message, 404);
export const adminConflict = (message: string, details: Record<string, unknown> = {}) =>
  new AdminApiError("version_conflict", message, 409, details);
export const adminLocked = (message: string, details: Record<string, unknown> = {}) =>
  new AdminApiError("account_locked", message, 423, details);
export const preconditionRequired = () =>
  new AdminApiError("if_match_required", "Заголовок If-Match обязателен", 428);
export const adminTooManyRequests = (message: string, details: Record<string, unknown> = {}) =>
  new AdminApiError("rate_limited", message, 429, details);
