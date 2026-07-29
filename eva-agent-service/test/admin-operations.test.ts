import assert from "node:assert/strict";
import test from "node:test";

import {
  isBlockedAddress,
  OutboundGateway,
} from "../dist/admin/outbound-gateway.js";
import { statusColor } from "../dist/admin/service-catalog.js";

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
