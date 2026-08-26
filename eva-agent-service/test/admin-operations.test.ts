import assert from "node:assert/strict";
import test from "node:test";

import {
  isBlockedAddress,
  OutboundGateway,
} from "../dist/admin/outbound-gateway.js";
import { optionalIntegrationEnabled } from "../dist/admin/health-worker.js";
import { OperationService } from "../dist/admin/operation-service.js";
import {
  SERVICES,
  statusColor,
} from "../dist/admin/service-catalog.js";

test("единая функция статуса соблюдает приоритет состояний", () => {
  const fresh = new Date("2026-07-30T00:00:00Z");
  assert.equal(statusColor({
    enabled: false,
    configured: false,
    running: false,
    ok: false,
  }), "gray");
  assert.equal(statusColor({
    enabled: true,
    configured: true,
    checking: true,
    running: false,
    ok: false,
  }), "blue");
  assert.equal(statusColor({
    enabled: true,
    configured: true,
    running: false,
    ok: false,
  }), "red");
  assert.equal(statusColor({
    enabled: true,
    configured: false,
    running: true,
    ok: true,
    lastOkAt: fresh,
    now: fresh,
  }), "yellow");
  assert.equal(statusColor({
    enabled: true,
    configured: true,
    running: true,
    ok: true,
    lastOkAt: fresh,
    now: fresh,
  }), "green");
});

test("выключенный optional-сервис не становится аварийной интеграцией", () => {
  assert.equal(optionalIntegrationEnabled(true, true, true, false), false);
  assert.equal(optionalIntegrationEnabled(true, true, true, true), true);
  assert.equal(optionalIntegrationEnabled(true, false, true, true), false);
  assert.equal(optionalIntegrationEnabled(false, false, true, false), true);
});

test("Caddy проверяется штатным Docker healthcheck без чтения admin API", () => {
  const caddy = SERVICES.find((service) => service.id === "caddy");
  assert.ok(caddy);
  assert.equal(caddy.healthUrl, undefined);
});

test("OutboundGateway блокирует локальные и служебные адреса", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "fd00::1",
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress("8.8.8.8"), false);

  const gateway = new OutboundGateway({
    lookup: (async () => [{ address: "127.0.0.1", family: 4 }]) as never,
  });
  await assert.rejects(
    () => gateway.validate("http://provider.example/v1"),
    (error: unknown) => (
      error instanceof Error &&
      (error as { code?: string }).code === "outbound_address_blocked"
    ),
  );
});

test("OutboundGateway повторно проверяет redirect и не следует во внутреннюю сеть", async () => {
  let calls = 0;
  const gateway = new OutboundGateway({
    lookup: (async (host: string) => [{
      address: host === "safe.example" ? "8.8.8.8" : "169.254.169.254",
      family: 4,
    }]) as never,
    fetcher: (async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { Location: "http://metadata.example/latest" },
      });
    }) as never,
  });
  await assert.rejects(
    () => gateway.request("https://safe.example/v1/models"),
    (error: unknown) => (
      error instanceof Error &&
      (error as { code?: string }).code === "outbound_address_blocked"
    ),
  );
  assert.equal(calls, 1);
});

/*
 * Вид операции, который пишет панель, обязан быть в схеме.
 *
 * Кнопки «Запустить» и «Остановить» падали именно здесь: `lifecycle()`
 * передаёт действие в `admin_operations.kind`, а CHECK колонки знал
 * только `restart`. Оператор получал «внутренняя ошибка», в журнале
 * лежало нарушение ограничения — и связать одно с другим было нечем.
 *
 * Поддельная база ограничений схемы не проверяет, поэтому сама вставка
 * проверяется на живом PostgreSQL (`scripts/ci/test-operation-kinds.sql`).
 * Здесь — вторая половина той же пары: что сервис не начал писать вид,
 * которого в списке нет. Список продублирован намеренно: тест обязан
 * сломаться, когда его меняют, — иначе он подтвердит любое расхождение.
 */
test("панель пишет только те виды операций, которые знает схема", async () => {
  const written: string[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO admin_operations")) written.push(String(values[1]));
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }),
  };
  const service = new OperationService(
    pool as never,
    { publish: async () => 1 } as never,
    { call: async () => ({}) } as never,
  );

  await service.restart("searxng", "actor");
  await service.start("searxng", "actor");
  await service.stop("searxng", "actor");
  await service.createBackup("actor", undefined);
  await service.checkUpdate("actor");
  await service.installUpdate("actor", undefined);

  // Ровно те значения, которые перечисляет CHECK в миграции 068.
  const allowed = new Set([
    "restart", "start", "stop", "backup", "restore",
    "update-check", "update", "rollback", "migration",
  ]);
  assert.deepEqual(written, ["restart", "start", "stop", "backup", "update-check", "update"]);
  for (const kind of written) {
    assert.ok(allowed.has(kind), `вид «${kind}» схема не примет: кнопка не сработает`);
  }
});
