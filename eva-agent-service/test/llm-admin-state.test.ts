/**
 * Единое состояние провайдера для панели «Искусственный интеллект».
 *
 * Раньше один провайдер приходил в браузер тремя кусками: конфигурация из
 * `/providers`, здоровье из `v_llm_provider_health` и место в маршрутах,
 * которое клиент вычислял сам, в двух разных функциях и с разным
 * пониманием того, что значит «работает». Здесь проверяется, что сборка
 * теперь одна и на сервере.
 *
 * Что здесь НЕ проверяется: сам SQL. Поддельный пул возвращает строки в
 * том виде, в каком их отдаёт схема, но соединение `v_llm_provider_health`
 * с `llm_providers` проверяется миграциями на живой базе в CI.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LlmRouterAdminService, providerStatus } from "../dist/admin/llm-router-service.js";

/**
 * Пул, отвечающий по первому опознанному куску запроса. Порядок вызовов
 * в `state()` — Promise.all, поэтому сопоставление идёт по тексту, а не по
 * счётчику.
 */
function fakePool(rows: {
  providers?: unknown[];
  routes?: unknown[];
  chains?: unknown[];
  failures?: unknown[];
  settings?: unknown[];
}) {
  return {
    async query(text: string) {
      if (text.includes("v_llm_provider_health")) return { rows: rows.providers ?? [] };
      if (text.includes("FROM llm_routes")) return { rows: rows.routes ?? [] };
      if (text.includes("llm_route_providers")) return { rows: rows.chains ?? [] };
      if (text.includes("llm_requests")) return { rows: rows.failures ?? [] };
      if (text.includes("llm_routing_settings")) return { rows: rows.settings ?? [{ mode: "adaptive" }] };
      throw new Error(`неожиданный запрос: ${text.slice(0, 60)}`);
    },
  } as never;
}

const PROVIDER = {
  id: "p-1", name: "Основной", model: "gpt-4o", enabled: true, priority: 10,
  protocol: "openai", base_url: "https://api.example.com", context_window: 128000,
  supports_tools: true, supports_json: true, supports_vision: false, supports_streaming: true,
  breaker_state: "closed", pinned_out: false, last_check_status: "ok", last_check_ok: true,
  api_key_configured: true, additional_parameters: {},
};

test("состояние собирает провайдера, здоровье и маршруты в одну запись", async () => {
  const service = new LlmRouterAdminService(fakePool({
    providers: [PROVIDER],
    routes: [{ code: "chat", title: "Разговор" }, { code: "deep", title: "Глубокий анализ" }],
    chains: [
      { route_code: "chat", position: 0, provider_id: "p-1", name: "Основной", model: "gpt-4o" },
      { route_code: "deep", position: 1, provider_id: "p-1", name: "Основной", model: "gpt-4o" },
    ],
  }));
  const state = await service.state();
  const provider = (state.providers as Array<Record<string, unknown>>)[0];

  // Один провайдер — одна запись, а не три источника для склейки в браузере.
  assert.equal((state.providers as unknown[]).length, 1);
  assert.equal(provider.protocol, "openai");
  assert.equal(provider.breaker_state, "closed");
  assert.deepEqual(provider.routes, [
    { code: "chat", title: "Разговор", position: 0 },
    { code: "deep", title: "Глубокий анализ", position: 1 },
  ]);
});

test("позиции маршрутов приходят отсортированными: основной первым", async () => {
  const service = new LlmRouterAdminService(fakePool({
    providers: [PROVIDER],
    routes: [{ code: "chat", title: "Разговор" }, { code: "fast", title: "Быстрый" }],
    // Порядок в ответе базы обратный ожидаемому.
    chains: [
      { route_code: "fast", position: 2, provider_id: "p-1" },
      { route_code: "chat", position: 0, provider_id: "p-1" },
    ],
  }));
  const state = await service.state();
  const routes = (state.providers as Array<Record<string, unknown>>)[0].routes as Array<{ position: number }>;
  assert.deepEqual(routes.map((route) => route.position), [0, 2]);
});

test("провайдер без единого маршрута отдаёт пустой список, а не отсутствующее поле", async () => {
  const service = new LlmRouterAdminService(fakePool({ providers: [PROVIDER] }));
  const state = await service.state();
  assert.deepEqual((state.providers as Array<Record<string, unknown>>)[0].routes, []);
});

test("режим одной модели помечает ровно выбранного провайдера", async () => {
  const service = new LlmRouterAdminService(fakePool({
    providers: [PROVIDER, { ...PROVIDER, id: "p-2", name: "Резервный" }],
    settings: [{ mode: "single", single_provider_id: "p-2" }],
  }));
  const state = await service.state();
  const flags = (state.providers as Array<Record<string, unknown>>)
    .map((provider) => [provider.id, provider.single_selected]);
  assert.deepEqual(flags, [["p-1", false], ["p-2", true]]);
});

test("ключ и секреты из additional_parameters наружу не выходят", async () => {
  const service = new LlmRouterAdminService(fakePool({
    providers: [{
      ...PROVIDER,
      // База не отдаёт api_key_encrypted этим запросом, но параметры —
      // произвольный JSON, и в него ключ положить можно.
      additional_parameters: { temperature: 0.3, api_key: "sk-secret", authorization: "Bearer x" },
    }],
  }));
  const state = await service.state();
  const provider = (state.providers as Array<Record<string, unknown>>)[0];
  assert.deepEqual(provider.additional_parameters, { temperature: 0.3 });
  assert.equal(provider.api_key_configured, true);

  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes("sk-secret"));
  assert.ok(!serialized.includes("Bearer x"));
  assert.ok(!serialized.includes("api_key_encrypted"));
});

// ---------------------------------------------------------------------
// Один операционный статус вместо двух несогласованных
// ---------------------------------------------------------------------

test("причина важнее очерёдности: ошибка конфигурации перебивает breaker", () => {
  // Провайдер и закрыт breaker'ом, и выключен, и не настроен. Показать
  // надо то, что чинят первым, — иначе администратор жмёт «вернуть в
  // строй» на провайдере с неверным ключом.
  const status = providerStatus({
    last_check_status: "config_error", enabled: false,
    pinned_out: true, breaker_state: "open",
  });
  assert.equal(status.code, "config_error");
  assert.equal(status.color, "red");
  assert.deepEqual(status.detail, { check: "config_error", router: "pinned_out" });
});

test("состояния breaker различаются, а проба остаётся жёлтой", () => {
  assert.equal(providerStatus({ breaker_state: "open", last_check_status: "ok" }).code, "breaker_open");
  const probe = providerStatus({ breaker_state: "half_open", last_check_status: "ok" });
  assert.equal(probe.code, "breaker_probe");
  assert.equal(probe.color, "yellow");
});

test("снятый с автовозврата не выглядит рабочим", () => {
  const status = providerStatus({ pinned_out: true, breaker_state: "closed", last_check_status: "ok" });
  assert.equal(status.code, "pinned_out");
  assert.equal(status.detail.router, "pinned_out");
});

test("проба возможностей и состояние роутера не смешиваются", () => {
  // Модель отвечает, но без инструментов: роутер здоров, ограничение —
  // у провайдера. Два разных факта, и в подробностях они видны отдельно.
  const status = providerStatus({ last_check_status: "limited", breaker_state: "closed" });
  assert.equal(status.code, "limited");
  assert.equal(status.color, "yellow");
  assert.deepEqual(status.detail, { check: "limited", router: "closed" });
});

test("выключенный вручную не выдаётся за отказ", () => {
  assert.equal(providerStatus({ enabled: false, last_check_status: "ok" }).code, "disabled");
});

test("непроверенный провайдер не считается рабочим", () => {
  assert.equal(providerStatus({ enabled: true, breaker_state: "closed" }).code, "unchecked");
});

test("старая запись без last_check_status читается как ошибка конфигурации", () => {
  // До миграции 066 был только булев last_check_ok. Такие строки в базе
  // остались, и «не проверялся» для них — неправда.
  assert.equal(providerStatus({ last_check_ok: false, breaker_state: "closed" }).code, "config_error");
  assert.equal(providerStatus({ last_check_ok: true, breaker_state: "closed" }).code, "ok");
});
