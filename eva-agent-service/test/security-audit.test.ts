import assert from "node:assert/strict";
import { test } from "node:test";

import { SecurityAuditService } from "../dist/admin/security-audit.js";

const HEALTHY_ENV = {
  EVA_AGENT_API_KEY: "9f2c1d5a8b3e47c6a0d9f1e2b7c4a8d3",
  MEDIA_SERVICE_TOKEN: "5b8e2f7a1c9d4e6b3a0f8c2d7e1b4a95",
  EVA_TELEGRAM_WEBHOOK_SECRET: "c3a7e1f9b5d2478c6e0a3f8b1d9c4e27",
  LLM_CONFIG_ENCRYPTION_KEY: "7d1b9e3f5a8c2046d7b1e9f3a5c8021d",
  EVA_ROUTER_API_KEY: "2e6a4c8f0b7d139e5a2c6f8b0d4e7a13",
  VALKEY_PASSWORD: "a1c5e93b7d0f248a6c2e4b8d0f3a5c71",
  EVA_SECRETS_MASTER_KEY_FILE: "/etc/evaself/secrets-master-key",
  EVA_ENV: "production",
};

/** База, в которой всё в порядке. */
function healthyDb() {
  return {
    async query(text: string) {
      if (text.includes("admin_audit_log")) {
        return { rows: [{ admins: "2", entries: "17" }] };
      }
      if (text.includes("password_changed_at")) return { rows: [{ count: "0" }] };
      if (text.includes("secret_records")) return { rows: [{ count: "4" }] };
      return { rows: [] };
    },
  };
}

test("на здоровой конфигурации находок нет", async () => {
  const audit = new SecurityAuditService({
    env: HEALTHY_ENV as never,
    db: healthyDb(),
  });
  const report = await audit.run();
  assert.deepEqual(
    report.findings,
    [],
    `неожиданные находки: ${JSON.stringify(report.findings)}`,
  );
  assert.equal(report.summary.critical, 0);
});

test("пустые ключи дают находки уровня critical и high", async () => {
  const audit = new SecurityAuditService({
    env: { ...HEALTHY_ENV, EVA_AGENT_API_KEY: "", VALKEY_PASSWORD: "" } as never,
    db: healthyDb(),
  });
  const report = await audit.run();
  const ids = report.findings.map((finding) => finding.id);
  assert.ok(ids.includes("secret.missing.EVA_AGENT_API_KEY"));
  assert.ok(ids.includes("secret.missing.VALKEY_PASSWORD"));
  assert.equal(report.summary.critical, 1);
  assert.equal(report.summary.high, 1);
  // Самое опасное — первым.
  assert.equal(report.findings[0]!.level, "critical");
});

test("дефолтные значения распознаются как заглушки", async () => {
  for (const weak of ["admin", "changeme", "password", "aaaaaaaaaaaa", "PLACEHOLDER"]) {
    const audit = new SecurityAuditService({
      env: { ...HEALTHY_ENV, EVA_ROUTER_API_KEY: weak } as never,
      db: healthyDb(),
    });
    const report = await audit.run();
    const ids = report.findings.map((finding) => finding.id);
    assert.ok(
      ids.includes("secret.weak.EVA_ROUTER_API_KEY"),
      `«${weak}» должно распознаваться как заглушка`,
    );
  }
});

test("каждая находка ссылается на конкретный параметр и не содержит значений", async () => {
  const secret = "super-secret-value-that-must-not-leak";
  const audit = new SecurityAuditService({
    env: {
      ...HEALTHY_ENV,
      EVA_ROUTER_API_KEY: "admin",
      EVA_TELEGRAM_WEBAPP_MAX_AGE_SECONDS: "3600",
      EVA_PUBLIC_RATE_LIMIT_PER_IP: "0",
      EVA_ENV: "staging",
      ACME_STAGING: "1",
      SOME_OTHER_SECRET: secret,
    } as never,
    db: healthyDb(),
  });
  const report = await audit.run();
  assert.ok(report.findings.length >= 5);

  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(secret), "значение секрета не должно попадать в отчёт");
  assert.ok(!serialized.includes("admin\""), "значение ключа не должно попадать в отчёт");

  for (const finding of report.findings) {
    assert.ok(finding.parameter.length > 0, `${finding.id} без параметра`);
    assert.ok(finding.level.length > 0, `${finding.id} без уровня`);
    assert.ok(finding.title.length > 0, `${finding.id} без заголовка`);
  }

  const ids = report.findings.map((finding) => finding.id);
  assert.ok(ids.includes("webapp.init_data_window"));
  assert.ok(ids.includes("ratelimit.disabled.EVA_PUBLIC_RATE_LIMIT_PER_IP"));
  assert.ok(ids.includes("env.not_production"));
  assert.ok(ids.includes("tls.staging_ca"));
});

test("отключённый аудит и bootstrap-пароль видны в отчёте", async () => {
  const audit = new SecurityAuditService({
    env: HEALTHY_ENV as never,
    db: {
      async query(text: string) {
        if (text.includes("admin_audit_log")) {
          return { rows: [{ admins: "3", entries: "0" }] };
        }
        if (text.includes("password_changed_at")) return { rows: [{ count: "2" }] };
        if (text.includes("secret_records")) return { rows: [{ count: "0" }] };
        return { rows: [] };
      },
    },
  });
  const report = await audit.run();
  const ids = report.findings.map((finding) => finding.id);
  assert.ok(ids.includes("audit.empty"));
  assert.ok(ids.includes("admin.bootstrap_password"));
  assert.ok(ids.includes("secret_store.empty"));
});

test("недоступная проверка даёт unknown, а не «всё хорошо»", async () => {
  const audit = new SecurityAuditService({
    env: HEALTHY_ENV as never,
    db: {
      async query() {
        throw new TypeError("relation does not exist: подробности запроса");
      },
    },
  });
  const report = await audit.run();
  assert.ok(report.summary.unknown >= 3, "все три проверки должны стать unknown");
  assert.equal(report.summary.critical, 0);

  // Текст ошибки не должен попадать в отчёт: он может содержать фрагмент
  // запроса или значения.
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("подробности запроса"));
  assert.ok(serialized.includes("TypeError"));
});
