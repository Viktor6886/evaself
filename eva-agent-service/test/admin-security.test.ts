import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_SUDO_SCOPES,
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
    "users:write",
    "users:messages",
  ]);
  assert.equal(ADMIN_SUDO_SCOPES.includes("shell:execute" as never), false);
});
