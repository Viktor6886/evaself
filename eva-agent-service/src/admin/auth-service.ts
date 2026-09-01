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
  last_failed_at: Date | null;
}

interface RateStore {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number | boolean>;
  del(...keys: string[]): Promise<number>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

export interface LoginResult {
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
  user: AdminUser;
}

const SESSION_SECONDS = 12 * 60 * 60;
/**
 * Политика неудачных входов.
 *
 * Десять ошибок подряд — минута блокировки. После неё даётся ещё одна
 * попытка, и каждая следующая ошибка снова стоит минуты: подбирать пароль
 * по одному разу в минуту бессмысленно, а человек, который просто
 * перепутал раскладку, ждёт минуту, а не четверть часа.
 *
 * Счётчик обнуляется сам: если с последней ошибки прошло больше суток,
 * попыток снова десять. Успешный вход обнуляет его сразу.
 */
const MAX_ATTEMPTS = 10;
const LOCK_SECONDS = 60;
const ATTEMPT_RESET_SECONDS = 24 * 60 * 60;
export const ADMIN_SUDO_SCOPES = Object.freeze([
  "operations:update",
  "providers:activate",
  "secrets:write",
  "services:restart",
  // Канонический текст персоны и системного промпта и настройки SDK.
  // Раньше маршруты требовали этот scope, а выдать его было нельзя:
  // в списке его не было, и `/sudo` отвечал «недопустимый scope».
  // Панель персоны из-за этого не сохранялась вовсе.
  "settings:write",
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

/** Ключ блокировки рядом со счётчиком: счётчик живёт сутки, блокировка — минуту. */
function lockKey(counterKey: string): string {
  return `${counterKey}:lock`;
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
              password_changed_at, failed_attempts, locked_until, last_failed_at
         FROM admin_users
        WHERE lower(username) = lower($1)`,
      [username],
    );
    const user = rows[0];
    if (!user || user.status !== "active") {
      // Несуществующее имя считается по той же политике: иначе перебор
      // имён обходил бы блокировку, а разница в ответах подсказывала бы,
      // какое имя существует.
      const locked = await this.recordRateFailure([ipKey, accountKey]);
      if (locked) throw adminLocked("Вход временно заблокирован", { retry_after_seconds: locked });
      throw adminUnauthorized("Неверное имя пользователя или пароль");
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      const retry = Math.max(1, Math.ceil((user.locked_until.getTime() - Date.now()) / 1000));
      throw adminLocked("Вход временно заблокирован", { retry_after_seconds: retry });
    }
    if (!await verifyPassword(user.password_hash, password)) {
      // Счётчик и срок считает PostgreSQL: и порог, и сутки тишины
      // меряются его часами, а не часами процесса. Иначе рассинхрон
      // времени между сервисом и базой давал бы то лишнюю попытку, то
      // блокировку раньше десятой ошибки.
      const { rows: updated } = await this.pool.query<{ locked_until: Date | null }>(
        `UPDATE admin_users AS u
            SET failed_attempts = next.attempts,
                last_failed_at = now(),
                locked_until = CASE
                  WHEN next.attempts >= $2 THEN now() + ($3 * interval '1 second')
                  ELSE NULL
                END
           FROM (
             SELECT CASE
                      WHEN last_failed_at IS NULL
                        OR last_failed_at < now() - ($4 * interval '1 second')
                      THEN 1
                      ELSE failed_attempts + 1
                    END AS attempts
               FROM admin_users
              WHERE id = $1
           ) AS next
          WHERE u.id = $1
        RETURNING u.locked_until`,
        [user.id, MAX_ATTEMPTS, LOCK_SECONDS, ATTEMPT_RESET_SECONDS],
      );
      const rateLock = await this.recordRateFailure([ipKey, accountKey]);
      const lockedUntil = updated[0]?.locked_until ?? null;
      const dbLock = lockedUntil
        ? Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000))
        : 0;
      const retryAfter = Math.max(dbLock, rateLock);
      if (retryAfter > 0) {
        throw adminLocked("Вход временно заблокирован", { retry_after_seconds: retryAfter });
      }
      throw adminUnauthorized("Неверное имя пользователя или пароль");
    }

    await this.rates.del(ipKey, accountKey, lockKey(ipKey), lockKey(accountKey));
    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);
    const { rows: created } = await this.pool.query<{ id: string }>(
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
    // Пароль подтверждает личность один раз — при входе. Дальше правами
    // распоряжается роль сессии, а не повторный ввод того же пароля:
    // человек, уже вошедший в панель, вводил его в то же поле минуту
    // назад, и второй ввод ничего не доказывает — он лишь приучает
    // набирать пароль по любому запросу окна.
    const sessionId = created[0]?.id;
    if (sessionId) await this.issueSessionGrants(sessionId, expiresAt);
    await this.pool.query(
      `UPDATE admin_users
          SET failed_attempts = 0, locked_until = NULL, last_failed_at = NULL,
              last_login_at = now()
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

  /**
   * Права сессии выдаются один раз — при входе.
   *
   * Гранты остались: по ним маршрут по-прежнему проверяет право, а
   * журнал — кто и что мог. Исчез только повторный ввод пароля: он
   * подтверждал не намерение, а способность набрать те же символы во
   * второй раз, и в панели, где настройка меняется десятками, приучал
   * вводить пароль в любое всплывшее окно.
   *
   * Срок гранта равен сроку сессии: выход и смена пароля снимают их
   * тем же запросом, что и раньше.
   */
  private async issueSessionGrants(sessionId: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO sudo_grants (session_id, expires_at, scope)
       SELECT $1, $2, scope FROM unnest($3::text[]) AS scope`,
      [sessionId, expiresAt, [...ADMIN_SUDO_SCOPES]],
    );
  }

  /**
   * Повторная выдача гранта на действующую сессию.
   *
   * Пароль здесь больше не спрашивается: сессия уже подтверждена входом,
   * а роль маршрута проверяется отдельно. Метод остаётся ради панелей,
   * закэшированных браузером до этой выкладки: они всё ещё зовут `/sudo`
   * перед мутацией, и без ответа у них ломается сохранение.
   */
  async grantSudo(session: AuthenticatedSession, scope: string): Promise<Date> {
    if (!ALLOWED_SUDO_SCOPES.has(scope)) throw adminBadRequest("Недопустимый scope sudo");
    const { rows } = await this.pool.query<{ expires_at: Date }>(
      `SELECT expires_at FROM admin_sessions
        WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [session.id],
    );
    const expiresAt = rows[0]?.expires_at ?? new Date(Date.now() + SESSION_SECONDS * 1000);
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
    if (!rowCount) throw adminForbidden("Сессия не имеет права на эту операцию; войдите в панель заново");
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
                failed_attempts = 0, locked_until = NULL, last_failed_at = NULL
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

  /**
   * Блокировка до обращения к базе.
   *
   * Валяется на Valkey и потому действует и на несуществующие имена: без
   * неё перебор по чужому логину не встречал бы вообще никакого предела,
   * потому что счётчик в `admin_users` есть только у существующей строки.
   */
  private async enforceRate(keys: string[]): Promise<void> {
    for (const key of keys) {
      const until = Number(await this.rates.get(lockKey(key)) ?? 0);
      if (!until) continue;
      const retry = Math.ceil((until - Date.now()) / 1000);
      if (retry > 0) {
        throw adminLocked("Вход временно заблокирован", { retry_after_seconds: retry });
      }
    }
  }

  /**
   * Учёт неудачной попытки. Возвращает оставшиеся секунды блокировки.
   *
   * Срок счётчика продлевается на сутки при каждой ошибке: «прошло больше
   * суток» отсчитывается от последней ошибки, а не от первой, — иначе
   * подбор просто ждал бы истечения общего окна.
   */
  private async recordRateFailure(keys: string[]): Promise<number> {
    let lockedFor = 0;
    for (const key of keys) {
      const count = await this.rates.incr(key);
      await this.rates.expire(key, ATTEMPT_RESET_SECONDS);
      if (count < MAX_ATTEMPTS) continue;
      await this.rates.set(
        lockKey(key),
        String(Date.now() + LOCK_SECONDS * 1000),
        "EX",
        LOCK_SECONDS,
      );
      lockedFor = LOCK_SECONDS;
    }
    return lockedFor;
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
