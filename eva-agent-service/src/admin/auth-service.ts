import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type pg from "pg";

import {
  adminBadRequest,
  adminForbidden,
  adminLocked,
  adminUnauthorized,
} from "./errors.js";
import {
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
} from "./password-policy.js";
import { globalSecretRedactor } from "./redactor.js";

export type AdminRole = "owner" | "admin" | "operator" | "viewer";

export interface AdminUser {
  id: string;
  username: string;
  role: AdminRole;
  status: "active" | "disabled";
  last_login_at: Date | null;
  password_changed_at: Date;
}

export interface AuthenticatedSession {
  id: string;
  user: AdminUser;
  csrfHash: Buffer;
}

interface UserRow extends AdminUser {
  password_hash: string;
  failed_attempts: number;
  locked_until: Date | null;
}

interface RateStore {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number | boolean>;
  del(...keys: string[]): Promise<number>;
}

export interface LoginResult {
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
  user: AdminUser;
}

const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 5;
export const ADMIN_SUDO_SCOPES = Object.freeze([
  "operations:update",
  "providers:activate",
  "secrets:write",
  "services:restart",
  // Блокировка отрезает человека от Евы, а чтение переписки открывает его
  // личный разговор: оба — осознанные действия, а не побочный эффект
  // перехода по разделу.
  "users:write",
  "users:messages",
  // Возврат звёзд — необратимое денежное действие: Telegram вернёт
  // списание, а подписка закроется. Ошибиться здесь дороже, чем в любой
  // настройке, поэтому подтверждение отдельное.
  "payments:refund",
  // Распознавание речи. Два scope, а не семь отдельных прав из
  // постановки: права здесь ролевые (owner/admin/operator/viewer), и
  // отдельный пермишенный слой рядом с ролевым был бы вторым механизмом
  // доступа — ровно тем, что задача запрещает.
  //
  //   stt:write    — сохранение и замена ключа, разрешение нестандартного
  //                  base URL, архивирование;
  //   stt:activate — активация конфигурации и смена primary/fallback,
  //                  то есть перевод живого трафика на другого провайдера.
  "stt:write",
  "stt:activate",
] as const);
const ALLOWED_SUDO_SCOPES = new Set<string>(ADMIN_SUDO_SCOPES);

function tokenHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeIp(ip: string): string | null {
  const value = ip.replace(/^::ffff:/, "");
  return /^[0-9a-f:.]+$/i.test(value) ? value : null;
}

function publicUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    last_login_at: row.last_login_at,
    password_changed_at: row.password_changed_at,
  };
}

export function roleAllowed(actual: AdminRole, allowed: readonly AdminRole[]): boolean {
  return allowed.includes(actual);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      // An invalid cookie is ignored instead of reaching logs or errors.
    }
  }
  return result;
}

export class AuthService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly rates: RateStore,
  ) {}

  async login(usernameInput: string, password: string, ip: string, userAgent: string): Promise<LoginResult> {
    const username = usernameInput.trim();
    if (!username || !password) throw adminUnauthorized("Неверное имя пользователя или пароль");
    globalSecretRedactor.register(password);
    const ipKey = `eva:admin:login:ip:${createHash("sha256").update(ip).digest("hex")}`;
    const accountKey = `eva:admin:login:account:${createHash("sha256").update(username.toLowerCase()).digest("hex")}`;
    await this.enforceRate([ipKey, accountKey]);

    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, username, password_hash, role, status, last_login_at,
              password_changed_at, failed_attempts, locked_until
         FROM admin_users
        WHERE lower(username) = lower($1)`,
      [username],
    );
    const user = rows[0];
    if (!user || user.status !== "active") {
      await this.recordRateFailure([ipKey, accountKey]);
      throw adminUnauthorized("Неверное имя пользователя или пароль");
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      const retry = Math.max(1, Math.ceil((user.locked_until.getTime() - Date.now()) / 1000));
      throw adminLocked("Вход временно заблокирован", { retry_after_seconds: retry });
    }
    if (!await verifyPassword(user.password_hash, password)) {
      const failedAttempts = user.failed_attempts + 1;
      const delaySeconds = failedAttempts >= MAX_ATTEMPTS
        ? Math.min(900, 30 * 2 ** Math.min(5, failedAttempts - MAX_ATTEMPTS))
        : 0;
      await this.pool.query(
        `UPDATE admin_users
            SET failed_attempts = $2,
                locked_until = CASE WHEN $3 > 0 THEN now() + ($3 * interval '1 second') ELSE NULL END
          WHERE id = $1`,
        [user.id, failedAttempts, delaySeconds],
      );
      await this.recordRateFailure([ipKey, accountKey]);
      if (delaySeconds > 0) {
        throw adminLocked("Вход временно заблокирован", { retry_after_seconds: delaySeconds });
      }
      throw adminUnauthorized("Неверное имя пользователя или пароль");
    }

    await this.rates.del(ipKey, accountKey);
    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);
    await this.pool.query<{ id: string }>(
      `INSERT INTO admin_sessions
         (user_id, token_hash, csrf_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5::inet, $6)
       RETURNING id`,
      [
        user.id,
        tokenHash(sessionToken),
        tokenHash(csrfToken),
        expiresAt,
        safeIp(ip),
        userAgent.slice(0, 500),
      ],
    );
    await this.pool.query(
      `UPDATE admin_users
          SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
        WHERE id = $1`,
      [user.id],
    );
    globalSecretRedactor.register(sessionToken);
    globalSecretRedactor.register(csrfToken);
    return {
      sessionToken,
      csrfToken,
      expiresAt,
      user: { ...publicUser(user), last_login_at: new Date() },
    };
  }

  async authenticate(cookieHeader: string | undefined): Promise<AuthenticatedSession> {
    const token = parseCookies(cookieHeader).eva_admin_session;
    if (!token) throw adminUnauthorized();
    globalSecretRedactor.register(token);
    const { rows } = await this.pool.query<UserRow & {
      session_id: string;
      csrf_hash: Buffer;
    }>(
      `SELECT u.id, u.username, u.password_hash, u.role, u.status,
              u.last_login_at, u.password_changed_at, u.failed_attempts,
              u.locked_until, s.id AS session_id, s.csrf_hash
         FROM admin_sessions s
         JOIN admin_users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.status = 'active'`,
      [tokenHash(token)],
    );
    const row = rows[0];
    if (!row) throw adminUnauthorized("Сессия недействительна или истекла");
    // Отметка «был здесь» не обязана удаться и не имеет права уронить
    // процесс. Запрос отправляется без ожидания намеренно: держать из-за
    // него каждый запрос панели незачем. Но отклонённый промис без
    // обработчика Node считает необработанным отказом и завершает
    // процесс — а этот код выполняется на КАЖДОМ авторизованном запросе,
    // так что секундная недоступность PostgreSQL роняла admin-api.
    void this.pool.query(
      "UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1",
      [row.session_id],
    ).catch(() => undefined);
    return {
      id: row.session_id,
      user: publicUser(row),
      csrfHash: row.csrf_hash,
    };
  }

  requireCsrf(
    session: AuthenticatedSession,
    cookieHeader: string | undefined,
    headerValue: string | string[] | undefined,
  ): void {
    const cookieToken = parseCookies(cookieHeader).eva_admin_csrf ?? "";
    const headerToken = typeof headerValue === "string" ? headerValue : "";
    globalSecretRedactor.register(cookieToken);
    globalSecretRedactor.register(headerToken);
    const cookieBuffer = Buffer.from(cookieToken);
    const headerBuffer = Buffer.from(headerToken);
    if (
      !cookieToken ||
      cookieBuffer.length !== headerBuffer.length ||
      !timingSafeEqual(cookieBuffer, headerBuffer)
    ) {
      throw adminForbidden("Проверка CSRF не пройдена");
    }
    const suppliedHash = tokenHash(cookieToken);
    if (
      suppliedHash.length !== session.csrfHash.length ||
      !timingSafeEqual(suppliedHash, session.csrfHash)
    ) {
      throw adminForbidden("Проверка CSRF не пройдена");
    }
  }

  async logout(sessionId: string): Promise<void> {
    await this.pool.query(
      `WITH revoked AS (
         UPDATE admin_sessions SET revoked_at = now()
          WHERE id = $1 AND revoked_at IS NULL
          RETURNING id
       )
       UPDATE sudo_grants SET revoked_at = now()
        WHERE session_id IN (SELECT id FROM revoked) AND revoked_at IS NULL`,
      [sessionId],
    );
  }

  async grantSudo(session: AuthenticatedSession, password: string, scope: string): Promise<Date> {
    if (!ALLOWED_SUDO_SCOPES.has(scope)) throw adminBadRequest("Недопустимый scope sudo");
    globalSecretRedactor.register(password);
    const { rows } = await this.pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM admin_users WHERE id = $1 AND status = 'active'",
      [session.user.id],
    );
    if (!rows[0] || !await verifyPassword(rows[0].password_hash, password)) {
      throw adminForbidden("Пароль не подтверждён");
    }
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await this.pool.query(
      `INSERT INTO sudo_grants (session_id, expires_at, scope)
       VALUES ($1, $2, $3)`,
      [session.id, expiresAt, scope],
    );
    return expiresAt;
  }

  async requireSudo(sessionId: string, scope: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `SELECT 1
         FROM sudo_grants
        WHERE session_id = $1
          AND scope IN ($2, split_part($2, ':', 1) || ':*')
          AND revoked_at IS NULL
          AND expires_at > now()
        LIMIT 1`,
      [sessionId, scope],
    );
    if (!rowCount) throw adminForbidden("Для операции требуется повторное подтверждение пароля");
  }

  async changePassword(
    session: AuthenticatedSession,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    globalSecretRedactor.register(currentPassword);
    globalSecretRedactor.register(newPassword);
    assertPasswordPolicy(newPassword, session.user.username);
    const { rows } = await this.pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM admin_users WHERE id = $1",
      [session.user.id],
    );
    if (!rows[0] || !await verifyPassword(rows[0].password_hash, currentPassword)) {
      throw adminForbidden("Текущий пароль неверен");
    }
    const nextHash = await hashPassword(newPassword);
    await this.pool.query(
      `WITH changed AS (
         UPDATE admin_users
            SET password_hash = $2, password_changed_at = now(),
                failed_attempts = 0, locked_until = NULL
          WHERE id = $1
          RETURNING id
       ), revoked_sessions AS (
         UPDATE admin_sessions
            SET revoked_at = now()
          WHERE user_id = $1 AND id <> $3 AND revoked_at IS NULL
          RETURNING id
       )
       UPDATE sudo_grants
          SET revoked_at = now()
        WHERE revoked_at IS NULL
          AND session_id IN (
            SELECT id FROM admin_sessions WHERE user_id = $1
          )`,
      [session.user.id, nextHash, session.id],
    );
  }

  private async enforceRate(keys: string[]): Promise<void> {
    for (const key of keys) {
      const count = Number(await this.rates.get(key) ?? 0);
      if (count >= MAX_ATTEMPTS) {
        throw adminLocked("Слишком много попыток входа", { retry_after_seconds: LOGIN_WINDOW_SECONDS });
      }
    }
  }

  private async recordRateFailure(keys: string[]): Promise<void> {
    for (const key of keys) {
      const count = await this.rates.incr(key);
      if (count === 1) await this.rates.expire(key, LOGIN_WINDOW_SECONDS);
    }
  }
}

export function sessionCookies(result: LoginResult): string[] {
  const maxAge = Math.max(1, Math.floor((result.expiresAt.getTime() - Date.now()) / 1000));
  return [
    `eva_admin_session=${encodeURIComponent(result.sessionToken)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
    `eva_admin_csrf=${encodeURIComponent(result.csrfToken)}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict`,
  ];
}

export function expiredSessionCookies(): string[] {
  return [
    "eva_admin_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
    "eva_admin_csrf=; Path=/; Max-Age=0; Secure; SameSite=Strict",
  ];
}
