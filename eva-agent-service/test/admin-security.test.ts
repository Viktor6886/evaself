import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_SUDO_SCOPES,
  AuthService,
  roleAllowed,
} from "../dist/admin/auth-service.js";
import {
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
} from "../dist/admin/password-policy.js";
import {
  auditParams,
  globalSecretRedactor,
  SecretRedactor,
} from "../dist/admin/redactor.js";
import { parseMasterKey, SecretStore } from "../dist/admin/secret-store.js";
import { createLogger } from "../dist/logger.js";

test("Secret Store uses AES-256-GCM and returns only metadata", async () => {
  const secret = "known-test-secret-value";
  let stored: unknown[] = [];
  const fakePool = {
    async query(_sql: string, values: unknown[]) {
      stored = values;
      return {
        rows: [{
          secret_ref: values[0],
          created_at: new Date("2026-07-29T18:00:00Z"),
          last_rotated_at: new Date("2026-07-29T18:00:00Z"),
          used_by_json: ["agent-runtime"],
        }],
      };
    },
  };
  const store = new SecretStore({
    masterKey: Buffer.alloc(32, 7),
    pool: fakePool as never,
  });
  const metadata = await store.put("sec_test_key", secret, ["agent-runtime"], null);
  assert.deepEqual(Object.keys(metadata).sort(), [
    "configured",
    "created_at",
    "last_rotated_at",
    "secret_ref",
    "used_by",
  ]);
  assert.equal(JSON.stringify(metadata).includes(secret), false);
  assert.ok(Buffer.isBuffer(stored[1]));
  assert.equal((stored[1] as Buffer).includes(Buffer.from(secret)), false);
  assert.equal((stored[2] as Buffer).length, 12);
  assert.equal((stored[3] as Buffer).length, 16);
});

test("master key parser accepts 32-byte base64 and rejects short keys", () => {
  const key = Buffer.alloc(32, 4);
  assert.deepEqual(parseMasterKey(key.toString("base64")), key);
  assert.throws(() => parseMasterKey("short"));
});

test("redactor removes known values, credentials and Authorization", () => {
  const redactor = new SecretRedactor();
  redactor.register("known-secret-123");
  const output = redactor.redact({
    message: "provider returned known-secret-123",
    Authorization: "Bearer token-value",
    nested: { api_key: "value", ordinary: "safe" },
  });
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes("known-secret-123"), false);
  assert.equal(serialized.includes("token-value"), false);
  assert.equal(serialized.includes('"value"'), false);
  assert.equal(serialized.includes("safe"), true);
  const params = auditParams(
    "/api/admin/v1/secrets/sec_test",
    { value: "known-secret-123", used_by: ["runtime"] },
    { secretRef: "sec_test" },
  );
  assert.equal(JSON.stringify(params).includes("known-secret-123"), false);
});

test("structured logger never writes a registered secret", () => {
  const secret = "provider-error-secret-acceptance";
  globalSecretRedactor.register(secret);
  let output = "";
  const original = process.stderr.write;
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    createLogger("debug", "test").error("Ошибка провайдера", {
      response: `upstream failed with ${secret}`,
      authorization: `Bearer ${secret}`,
    });
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  assert.equal(output.includes(secret), false);
  assert.match(output, /\[REDACTED\]/);
});

test("passwords use argon2id and compromised values are rejected", async () => {
  assert.throws(() => assertPasswordPolicy("password1234", "owner"));
  const password = "Long-Unique-Admin-Passphrase-2026!";
  assertPasswordPolicy(password, "owner");
  const encoded = await hashPassword(password);
  assert.match(encoded, /^\$argon2id\$/);
  assert.equal(await verifyPassword(encoded, password), true);
  assert.equal(await verifyPassword(encoded, "wrong-password-value"), false);
});

test("RBAC matrix for phase 1 is explicit", () => {
  const viewers = ["owner", "admin", "operator", "viewer"] as const;
  for (const role of viewers) assert.equal(roleAllowed(role, viewers), true);
  for (const role of viewers) {
    assert.equal(
      roleAllowed(role, ["owner", "admin"]),
      role === "owner" || role === "admin",
    );
  }
});

test("sudo accepts only the privileged scopes used by the admin API", () => {
  assert.deepEqual([...ADMIN_SUDO_SCOPES], [
    "operations:update",
    "providers:activate",
    "secrets:write",
    "services:restart",
    // Канонический текст персоны и системного промпта. Маршруты требовали
    // этот scope и раньше, но выдать его было нельзя: в списке его не
    // было, и панель персоны не сохранялась вовсе.
    "settings:write",
    "users:write",
    "users:messages",
    // Возврат звёзд: Telegram вернёт списание, подписка закроется, и
    // отменить это нельзя. Список закрытый намеренно — новое
    // привилегированное действие добавляется осознанно, а не попутно.
    "payments:refund",
    // Распознавание речи: запись ключа провайдера и перевод живого
    // трафика на другого провайдера — оба осознанные действия, а не
    // побочный эффект перехода по разделу.
    "stt:write",
    "stt:activate",
  ]);
  assert.equal(ADMIN_SUDO_SCOPES.includes("shell:execute" as never), false);
});

/* =====================================================================
 * Вход в панель: попытки, блокировка и права сессии
 *
 * Проверяется вся политика, которую человек видит снаружи: десять
 * ошибок — минута ожидания, после неё одна попытка и снова минута, а
 * сутки тишины возвращают полные десять. И то, ради чего пароль вообще
 * перестали спрашивать повторно: права сессия получает при входе, а не
 * по второму вводу того же пароля.
 * ===================================================================== */

interface FakeUserState {
  failed_attempts: number;
  last_failed_at: Date | null;
  locked_until: Date | null;
}

/** Valkey с настоящим TTL: без него «через сутки» нечем проверить. */
function fakeRates() {
  const values = new Map<string, { value: string; expiresAt: number }>();
  const alive = (key: string) => {
    const item = values.get(key);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      values.delete(key);
      return null;
    }
    return item;
  };
  return {
    async get(key: string) { return alive(key)?.value ?? null; },
    async incr(key: string) {
      const next = String(Number(alive(key)?.value ?? 0) + 1);
      values.set(key, { value: next, expiresAt: alive(key)?.expiresAt ?? Infinity });
      return Number(next);
    },
    async expire(key: string, seconds: number) {
      const item = alive(key);
      if (!item) return 0;
      values.set(key, { value: item.value, expiresAt: Date.now() + seconds * 1000 });
      return 1;
    },
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys) if (values.delete(key)) removed += 1;
      return removed;
    },
    async set(key: string, value: string, _mode: "EX", seconds: number) {
      values.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
      return "OK";
    },
  };
}

/**
 * PostgreSQL считает попытки сам, поэтому фейк повторяет ровно ту
 * арифметику, что и SQL, — и берёт порог, срок блокировки и срок
 * обнуления из параметров запроса. Если код перестанет их передавать,
 * тест это увидит.
 */
function fakePool(passwordHash: string, user: FakeUserState) {
  const queries: { text: string; values: unknown[] }[] = [];
  const grants: string[][] = [];
  return {
    queries,
    grants,
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (text.includes("FROM admin_users\n        WHERE lower(username)")) {
        return {
          rows: [{
            id: "admin-1",
            username: "owner",
            password_hash: passwordHash,
            role: "owner",
            status: "active",
            last_login_at: null,
            password_changed_at: new Date(),
            failed_attempts: user.failed_attempts,
            locked_until: user.locked_until,
            last_failed_at: user.last_failed_at,
          }],
        };
      }
      if (text.includes("UPDATE admin_users AS u")) {
        const [, maxAttempts, lockSeconds, resetSeconds] = values as [string, number, number, number];
        const stale = !user.last_failed_at
          || user.last_failed_at.getTime() < Date.now() - resetSeconds * 1000;
        user.failed_attempts = stale ? 1 : user.failed_attempts + 1;
        user.last_failed_at = new Date();
        user.locked_until = user.failed_attempts >= maxAttempts
          ? new Date(Date.now() + lockSeconds * 1000)
          : null;
        return { rows: [{ locked_until: user.locked_until }] };
      }
      if (text.includes("INSERT INTO admin_sessions")) return { rows: [{ id: "session-1" }] };
      if (text.includes("INSERT INTO sudo_grants")) {
        grants.push(values[2] as string[]);
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("SET failed_attempts = 0")) {
        user.failed_attempts = 0;
        user.last_failed_at = null;
        user.locked_until = null;
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const LOGIN_PASSWORD = "Long-Unique-Admin-Passphrase-2026!";

async function loginError(
  auth: { login: (u: string, p: string, ip: string, ua: string) => Promise<unknown> },
  password: string,
): Promise<{ statusCode?: number; details?: Record<string, unknown> }> {
  try {
    await auth.login("owner", password, "10.0.0.1", "test");
    return {};
  } catch (error) {
    return error as { statusCode?: number; details?: Record<string, unknown> };
  }
}

test("десять ошибок подряд дают минуту блокировки, а не четверть часа", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-01T10:00:00Z") });
  const passwordHash = await hashPassword(LOGIN_PASSWORD);
  const state: FakeUserState = { failed_attempts: 0, last_failed_at: null, locked_until: null };
  const pool = fakePool(passwordHash, state);
  const auth = new AuthService(pool as never, fakeRates() as never);

  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const error = await loginError(auth, "неверный-пароль");
    assert.equal(error.statusCode, 401, `попытка ${attempt} заблокирована раньше десятой`);
  }
  const tenth = await loginError(auth, "неверный-пароль");
  assert.equal(tenth.statusCode, 423, "десятая ошибка не заблокировала вход");
  assert.equal(tenth.details?.retry_after_seconds, 60);

  // Внутри минуты пароль вообще не проверяется: отказ приходит раньше.
  t.mock.timers.tick(30_000);
  const during = await loginError(auth, LOGIN_PASSWORD);
  assert.equal(during.statusCode, 423, "правильный пароль прошёл во время блокировки");

  // Минута прошла — даётся ещё одна попытка, и ошибка в ней снова стоит
  // минуты: одиннадцатая не ждёт ещё десяти.
  t.mock.timers.tick(31_000);
  const eleventh = await loginError(auth, "неверный-пароль");
  assert.equal(eleventh.statusCode, 423, "после блокировки ошибка не заблокировала снова");
  assert.equal(eleventh.details?.retry_after_seconds, 60);
});

test("сутки без ошибок возвращают полные десять попыток", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-01T10:00:00Z") });
  const passwordHash = await hashPassword(LOGIN_PASSWORD);
  const state: FakeUserState = { failed_attempts: 0, last_failed_at: null, locked_until: null };
  const pool = fakePool(passwordHash, state);
  const auth = new AuthService(pool as never, fakeRates() as never);

  for (let attempt = 1; attempt <= 10; attempt += 1) await loginError(auth, "неверный-пароль");
  assert.equal(state.failed_attempts, 10);

  // Сутки и минута тишины: счётчик начинается заново, и до следующей
  // блокировки снова десять ошибок, а не одна.
  t.mock.timers.tick(24 * 60 * 60 * 1000 + 60_000);
  const first = await loginError(auth, "неверный-пароль");
  assert.equal(first.statusCode, 401, "после суток первая ошибка сразу заблокировала вход");
  assert.equal(state.failed_attempts, 1, "счётчик не обнулился через сутки");
});

test("права сессии выдаются при входе, а не по второму вводу пароля", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-01T10:00:00Z") });
  const passwordHash = await hashPassword(LOGIN_PASSWORD);
  const state: FakeUserState = { failed_attempts: 3, last_failed_at: new Date(), locked_until: null };
  const pool = fakePool(passwordHash, state);
  const auth = new AuthService(pool as never, fakeRates() as never);

  const result = await auth.login("owner", LOGIN_PASSWORD, "10.0.0.1", "test");
  assert.ok(result.sessionToken.length > 0);
  assert.equal(state.failed_attempts, 0, "успешный вход не обнулил счётчик");

  assert.equal(pool.grants.length, 1, "вход не выдал прав сессии");
  const issued = pool.grants[0]!;
  for (const scope of ADMIN_SUDO_SCOPES) {
    assert.ok(issued.includes(scope), `сессия вошла без права ${scope}`);
  }
  // Правка канонического текста персоны требует именно его: раньше этого
  // scope не было в списке, и панель персоны не сохранялась вовсе.
  assert.ok(issued.includes("settings:write"));
});
