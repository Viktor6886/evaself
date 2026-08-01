/**
 * Сценарии отказоустойчивости LLM Router (раздел 4.1 требований).
 *
 * Провайдеры здесь — управляемые заглушки, а не сеть: проверяется решение
 * роутера, а не поведение чужого API. Хранилище тоже поддельное, но
 * повторяет контракт RouterStore, включая атомарность claimProbe().
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildChain } from "../dist/router/chain.js";
import { ProviderLimits } from "../dist/router/limits.js";
import {
  BACKUP_PERSONA_DIRECTIVE,
  estimateTokens,
  normalizeForProvider,
  relaxAfterBadRequest,
  withBackupDirective,
} from "../dist/router/normalize.js";
import { LlmRouter, NoProviderAvailable, stripFence } from "../dist/router/router.js";
import { createRouterServer, fromOpenAi } from "../dist/router/server.js";
import { ProviderError } from "../dist/router/types.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------
// заглушки
// ---------------------------------------------------------------------
function provider(overrides = {}) {
  return {
    id: overrides.id ?? "p1",
    name: overrides.name ?? "primary",
    protocol: "openai-compatible",
    base_url: "https://example.test/v1",
    model: "model-a",
    api_key: "k",
    connect_timeout_ms: 1_000,
    request_timeout_ms: 5_000,
    max_retries: 2,
    max_concurrency: 8,
    max_rpm: null,
    max_tpm: null,
    context_window: 131_072,
    max_output_tokens: 4_096,
    max_latency_ms: null,
    supports_tools: true,
    supports_json: true,
    supports_vision: false,
    supports_streaming: true,
    quality_tier: 2,
    sensitive_data_allowed: true,
    price_in_micro: 1_000_000,
    price_out_micro: 2_000_000,
    daily_budget_micro: null,
    monthly_budget_micro: null,
    generation_defaults: {},
    additional_parameters: {},
    ...overrides,
  };
}

const ROUTE = {
  code: "chat",
  title: "Разговор",
  requires_tools: false,
  requires_json: false,
  requires_vision: false,
  requires_streaming: false,
  min_context_window: 8_192,
  max_quality_tier: 3,
  allows_sensitive: true,
  rotation_enabled: true,
};

function request(overrides = {}) {
  // overrides раскрывается ДО metadata: иначе частичный metadata из теста
  // затирает собранный объект целиком и route теряется.
  return {
    messages: [{ role: "user", content: "привет" }],
    system_prompt: "Ты — Ева.",
    tools: [],
    temperature: 0.7,
    max_tokens: 200,
    stream: false,
    response_format: null,
    ...overrides,
    metadata: {
      request_id: "req-1",
      user_id: "7",
      agent_id: "agent-1",
      route: "chat",
      sensitive: true,
      ...(overrides.metadata ?? {}),
    },
  };
}

/** Хранилище в памяти с тем же контрактом, что и RouterStore. */
class FakeStore {
  constructor(providers, chain) {
    this.providerRows = providers;
    this.chain = chain ?? providers.map((p) => p.id);
    this.breakerRows = new Map();
    this.spendRows = new Map();
    this.attempts = [];
    this.probeClaims = 0;
  }
  providers() { return Promise.resolve(this.providerRows); }
  routes() { return Promise.resolve(new Map([["chat", ROUTE]])); }
  chains() { return Promise.resolve(new Map([["chat", this.chain]])); }
  breakers() { return Promise.resolve(new Map(this.breakerRows)); }
  spend(id) { return Promise.resolve(this.spendRows.get(id) ?? { day: 0, month: 0 }); }
  addSpend(id, usage) {
    const current = this.spendRows.get(id) ?? { day: 0, month: 0 };
    this.spendRows.set(id, {
      day: current.day + usage.cost_micro,
      month: current.month + usage.cost_micro,
    });
    return Promise.resolve();
  }
  recordFailure(id, code, threshold) {
    const row = this.breakerRows.get(id)
      ?? { provider_id: id, state: "closed", consecutive_errors: 0, pinned_out: false,
           first_error_at: null, opened_at: null, probe_after: null,
           last_error_code: null, last_success_at: null };
    row.consecutive_errors += 1;
    row.last_error_code = code;
    if (row.consecutive_errors >= threshold && row.state !== "open") {
      row.state = "open";
      row.opened_at = new Date();
      row.probe_after = new Date(Date.now() + 60_000);
    }
    this.breakerRows.set(id, row);
    return Promise.resolve();
  }
  recordSuccess(id) {
    this.breakerRows.set(id, {
      provider_id: id, state: "closed", consecutive_errors: 0, pinned_out: false,
      first_error_at: null, opened_at: null, probe_after: null,
      last_error_code: null, last_success_at: new Date(),
    });
    return Promise.resolve();
  }
  claimProbe(id) {
    const row = this.breakerRows.get(id);
    if (!row || row.state !== "open" || row.pinned_out) return Promise.resolve(false);
    if (row.probe_after && row.probe_after > new Date()) return Promise.resolve(false);
    row.state = "half_open";
    this.probeClaims += 1;
    return Promise.resolve(true);
  }
  recordAttempt(record) { this.attempts.push(record); return Promise.resolve(); }
}

// ---------------------------------------------------------------------
// нормализация и совместимость — чистые функции
// ---------------------------------------------------------------------
test("параметры подрезаются под возможности провайдера, а не роняют запрос", () => {
  const weak = provider({ supports_tools: false, supports_json: false, supports_streaming: false, max_output_tokens: 100 });
  const normalized = normalizeForProvider(
    request({
      tools: [{ name: "t", description: "d", parameters: {} }],
      response_format: { type: "json_object" },
      stream: true,
      max_tokens: 9_000,
      temperature: 5,
    }),
    weak,
  );
  assert.deepEqual(normalized.tools, []);
  assert.equal(normalized.response_format, null);
  assert.equal(normalized.stream, false);
  assert.equal(normalized.max_tokens, 100);
  assert.equal(normalized.temperature, 2);
});

test("после HTTP 400 снимается по одному полю, затем сдаёмся", () => {
  const first = relaxAfterBadRequest(request({ response_format: { type: "json_object" }, tools: [{ name: "t", description: "", parameters: {} }] }));
  assert.equal(first?.response_format, null);
  assert.equal(first?.tools.length, 1, "инструменты снимаются только следующим шагом");

  const second = relaxAfterBadRequest(first);
  assert.deepEqual(second?.tools, []);

  const third = relaxAfterBadRequest(second);
  assert.equal(third?.temperature, 1);

  assert.equal(relaxAfterBadRequest(third), null, "снимать больше нечего");
});

test("резерв получает инструкцию о личности, основной — нет", () => {
  const primary = withBackupDirective(request(), false);
  assert.equal(primary.system_prompt, "Ты — Ева.");
  const backup = withBackupDirective(request(), true);
  assert.ok(backup.system_prompt.includes(BACKUP_PERSONA_DIRECTIVE));
  assert.ok(backup.system_prompt.startsWith("Ты — Ева."));
});

test("модель без инструментов не попадает в цепочку маршрута tools", () => {
  const withTools = provider({ id: "a", name: "with-tools" });
  const without = provider({ id: "b", name: "no-tools", supports_tools: false });
  const chain = buildChain({
    route: { ...ROUTE, code: "tools", requires_tools: true },
    request: request(),
    providerIds: ["a", "b"],
    providers: new Map([["a", withTools], ["b", without]]),
    breakers: new Map(),
    now: new Date(),
  });
  assert.deepEqual(chain.usable.map((e) => e.provider.name), ["with-tools"]);
  assert.equal(chain.rejected[0]?.reason, "incompatible");
  assert.match(chain.rejected[0].detail, /tool calling/);
});

test("слабая модель не подставляется только потому, что доступна", () => {
  const weak = provider({ id: "b", name: "weak", quality_tier: 5 });
  const chain = buildChain({
    route: ROUTE,
    request: request(),
    providerIds: ["b"],
    providers: new Map([["b", weak]]),
    breakers: new Map(),
    now: new Date(),
  });
  assert.equal(chain.usable.length, 0);
  assert.match(chain.rejected[0].detail, /уровень качества/);
});

test("запрос, не помещающийся в окно, отсекается до отправки", () => {
  const small = provider({ id: "s", name: "small", context_window: 9_000 });
  const long = request({ messages: [{ role: "user", content: "я".repeat(40_000) }] });
  assert.ok(estimateTokens(long) > 9_000);
  const chain = buildChain({
    route: ROUTE, request: long, providerIds: ["s"],
    providers: new Map([["s", small]]), breakers: new Map(), now: new Date(),
  });
  assert.equal(chain.usable.length, 0);
  assert.match(chain.rejected[0].detail, /не помещается/);
});

test("открытый breaker исключает провайдера, пока не вышла выдержка", () => {
  const p = provider({ id: "a", name: "primary" });
  const future = new Date(Date.now() + 60_000);
  const closedOut = buildChain({
    route: ROUTE, request: request(), providerIds: ["a"],
    providers: new Map([["a", p]]),
    breakers: new Map([["a", { state: "open", probe_after: future, pinned_out: false }]]),
    now: new Date(),
  });
  assert.equal(closedOut.usable.length, 0);
  assert.equal(closedOut.rejected[0].reason, "breaker_open");

  const past = new Date(Date.now() - 1_000);
  const ready = buildChain({
    route: ROUTE, request: request(), providerIds: ["a"],
    providers: new Map([["a", p]]),
    breakers: new Map([["a", { state: "open", probe_after: past, pinned_out: false }]]),
    now: new Date(),
  });
  assert.equal(ready.usable.length, 1, "после выдержки провайдер снова в цепочке");
});

test("выключенная ротация оставляет в цепочке только основного", () => {
  const primary = provider({ id: "a", name: "primary" });
  const backup = provider({ id: "b", name: "backup" });
  const input = {
    request: request(),
    providerIds: ["a", "b"],
    providers: new Map([["a", primary], ["b", backup]]),
    breakers: new Map(),
    now: new Date(),
  };

  const rotating = buildChain({ ...input, route: ROUTE });
  assert.deepEqual(rotating.usable.map((e) => e.provider.name), ["primary", "backup"]);

  const pinned = buildChain({ ...input, route: { ...ROUTE, rotation_enabled: false } });
  assert.deepEqual(pinned.usable.map((e) => e.provider.name), ["primary"]);
  // Причина названа, а не проглочена: иначе в телеметрии это выглядит
  // как «резерв почему-то не сработал».
  assert.equal(pinned.rejected[0]?.reason, "rotation_disabled");
  assert.match(pinned.rejected[0].detail, /ротация/);
});

test("выключенная ротация не мешает основному быть отвергнутым по существу", () => {
  // Несовместимость важнее выключателя: подставлять модель без
  // инструментов в маршрут, который их требует, нельзя ни при каких
  // настройках ротации.
  const without = provider({ id: "a", name: "no-tools", supports_tools: false });
  const chain = buildChain({
    route: { ...ROUTE, code: "tools", requires_tools: true, rotation_enabled: false },
    request: request(),
    providerIds: ["a"],
    providers: new Map([["a", without]]),
    breakers: new Map(),
    now: new Date(),
  });
  assert.equal(chain.usable.length, 0);
  assert.equal(chain.rejected[0]?.reason, "incompatible");
});

test("снятый администратором провайдер не возвращается автоматически", () => {
  const p = provider({ id: "a", name: "primary" });
  const chain = buildChain({
    route: ROUTE, request: request(), providerIds: ["a"],
    providers: new Map([["a", p]]),
    breakers: new Map([["a", { state: "closed", probe_after: null, pinned_out: true }]]),
    now: new Date(),
  });
  assert.equal(chain.usable.length, 0);
  assert.match(chain.rejected[0].detail, /администратор/);
});

// ---------------------------------------------------------------------
// лимиты
// ---------------------------------------------------------------------
test("RPM, TPM и параллелизм считаются в скользящем окне", () => {
  const limits = new ProviderLimits();
  const config = { max_rpm: 2, max_tpm: 1_000, max_concurrency: 1 };
  const now = 1_000_000;

  assert.equal(limits.check("p", config, 100, now).allowed, true);
  const release = limits.acquire("p", 100, now);
  assert.deepEqual(limits.check("p", config, 100, now), { allowed: false, reason: "concurrency" });
  release();

  limits.acquire("p", 100, now)();
  assert.deepEqual(limits.check("p", config, 100, now), { allowed: false, reason: "rpm" });

  // Через минуту окно очищается.
  assert.equal(limits.check("p", config, 100, now + 61_000).allowed, true);

  const tpm = new ProviderLimits();
  tpm.acquire("q", 900, now)();
  assert.deepEqual(
    tpm.check("q", { max_rpm: null, max_tpm: 1_000, max_concurrency: 4 }, 200, now),
    { allowed: false, reason: "tpm" },
  );
});

// ---------------------------------------------------------------------
// разбор входящего запроса
// ---------------------------------------------------------------------
test("имя модели разворачивается в маршрут, ведущий system уходит в system_prompt", () => {
  const parsed = fromOpenAi({
    model: "eva/tools",
    messages: [
      { role: "system", content: "Ты — Ева." },
      { role: "user", content: "привет" },
    ],
    tools: [{ type: "function", function: { name: "save", description: "d", parameters: { type: "object" } } }],
  });
  assert.equal(parsed.metadata.route, "tools");
  assert.equal(parsed.system_prompt, "Ты — Ева.");
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.tools[0]?.name, "save");
});

test("неизвестное имя модели уходит в маршрут chat, пустой запрос отвергается", () => {
  assert.equal(fromOpenAi({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }).metadata.route, "chat");
  assert.throws(() => fromOpenAi({ messages: [] }), /messages/);
  assert.throws(() => fromOpenAi("нет"), /объектом/);
  assert.throws(() => fromOpenAi({ messages: [{ role: "system", content: "только system" }] }), /кроме system/);
});

test("результаты уже выполненных инструментов сохраняются при разборе", () => {
  const parsed = fromOpenAi({
    model: "eva/tools",
    messages: [
      { role: "user", content: "запиши" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "save", arguments: '{"x":1}' } }] },
      { role: "tool", tool_call_id: "c1", content: "сохранено" },
    ],
  });
  assert.equal(parsed.messages[1]?.tool_calls?.[0]?.id, "c1");
  assert.equal(parsed.messages[2]?.role, "tool");
  assert.equal(parsed.messages[2]?.tool_call_id, "c1");
});

test("JSON в markdown-обёртке распознаётся", () => {
  assert.equal(stripFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFence('{"a":1}'), '{"a":1}');
});


// ---------------------------------------------------------------------
// сам failover
// ---------------------------------------------------------------------
/**
 * Роутер с подставленными адаптерами. `script[имя провайдера]` — функция,
 * получающая номер попытки и возвращающая либо ответ, либо ошибку.
 */
function harness(providers, script, chain) {
  const store = new FakeStore(providers, chain);
  const calls = [];
  const attemptsByProvider = new Map();

  const adapterFor = (p) => ({
    protocol: p.protocol,
    complete(target, req) {
      const n = (attemptsByProvider.get(target.name) ?? 0) + 1;
      attemptsByProvider.set(target.name, n);
      calls.push({ provider: target.name, attempt: n, stream: false, request: req });
      return script[target.name].complete(n, req);
    },
    async *stream(target, req) {
      const n = (attemptsByProvider.get(target.name) ?? 0) + 1;
      attemptsByProvider.set(target.name, n);
      calls.push({ provider: target.name, attempt: n, stream: true, request: req });
      yield* script[target.name].stream(n, req);
    },
  });

  const router = new LlmRouter(
    store,
    silentLogger,
    { breakerThreshold: 3, breakerWindowMs: 300_000, breakerCooldownMs: 60_000, retryBackoffMs: [0, 0, 0] },
    () => Promise.resolve(),
    adapterFor,
  );
  return { router, store, calls };
}

function ok(text = "готово", usage = { tokens_in: 10, tokens_out: 5 }) {
  return { content: text, tool_calls: [], finish_reason: "stop", usage, model: "model-a" };
}

const always = (fn) => ({
  complete: (n, req) => fn(n, req),
  stream: async function* (n, req) {
    const result = await fn(n, req);
    yield { type: "text", delta: result.content };
    yield { type: "done", response: result };
  },
});

const fails = (error: Error) => ({
  complete: () => Promise.reject(error),
  stream: async function* () { throw error; },
});

test("основной отвечает — резерв не трогается", async () => {
  const p = provider({ id: "a", name: "primary" });
  const b = provider({ id: "b", name: "backup" });
  const { router, calls } = harness([p, b], {
    primary: always(() => Promise.resolve(ok())),
    backup: always(() => Promise.resolve(ok("не должно"))),
  });
  const result = await router.complete(request());
  assert.equal(result.provider_name, "primary");
  assert.equal(result.switches, 0);
  assert.deepEqual(calls.map((c) => c.provider), ["primary"]);
});

test("HTTP 429 у основного уводит на резерв после повторов", async () => {
  const p = provider({ id: "a", name: "primary", max_retries: 2 });
  const b = provider({ id: "b", name: "backup" });
  const { router, calls, store } = harness([p, b], {
    primary: fails(new ProviderError("429", "rate_limited", { retryable: true, httpStatus: 429 })),
    backup: always(() => Promise.resolve(ok("резерв ответил"))),
  });
  const result = await router.complete(request());
  assert.equal(result.provider_name, "backup");
  assert.equal(result.switches, 1);
  // 3 попытки основному (1 + 2 повтора), затем одна резерву.
  assert.deepEqual(calls.map((c) => c.provider), ["primary", "primary", "primary", "backup"]);
  assert.equal(store.attempts.filter((a) => a.succeeded).length, 1, "успех записан ровно один раз");
});

test("HTTP 500, таймаут и обрыв соединения — тоже причины переключения", async () => {
  for (const error of [
    new ProviderError("500", "server_error", { retryable: true, httpStatus: 500 }),
    new ProviderError("timeout", "timeout", { retryable: true }),
    new ProviderError("ENOTFOUND", "connection_failed", { retryable: false }),
  ]) {
    const { router } = harness(
      [provider({ id: "a", name: "primary", max_retries: 0 }), provider({ id: "b", name: "backup" })],
      { primary: fails(error), backup: always(() => Promise.resolve(ok())) },
    );
    const result = await router.complete(request());
    assert.equal(result.provider_name, "backup", error.reason);
  }
});

test("пустой ответ и повреждённый JSON приводят к переключению", async () => {
  const { router, calls } = harness(
    [provider({ id: "a", name: "primary", max_retries: 0 }), provider({ id: "b", name: "backup" })],
    {
      primary: always(() => Promise.resolve({ ...ok(), content: "не json" })),
      backup: always(() => Promise.resolve({ ...ok(), content: '{"ok":true}' })),
    },
  );
  const result = await router.complete(request({ response_format: { type: "json_object" } }));
  assert.equal(result.provider_name, "backup");
  assert.equal(calls.length, 2);
});

test("HTTP 400 сначала нормализуется у того же провайдера, а не гонится по цепочке", async () => {
  const p = provider({ id: "a", name: "primary" });
  const b = provider({ id: "b", name: "backup" });
  const seen = [];
  const { router, calls } = harness([p, b], {
    primary: {
      complete: (n, req) => {
        seen.push({ tools: req.tools.length, json: Boolean(req.response_format) });
        // Отвергаем, пока в запросе есть response_format.
        if (req.response_format) {
          return Promise.reject(new ProviderError("bad", "model_error", {
            retryable: false, httpStatus: 400, badRequest: true,
          }));
        }
        return Promise.resolve(ok('{"ok":1}'));
      },
      stream: async function* () { throw new Error("не используется"); },
    },
    backup: always(() => Promise.resolve(ok("резерв"))),
  });
  const result = await router.complete(request({ response_format: { type: "json_object" }, tools: [] }));
  assert.equal(result.provider_name, "primary", "нормализация спасла основного");
  assert.equal(calls.filter((c) => c.provider === "backup").length, 0, "резерв не понадобился");
  assert.equal(seen[0].json, true);
  assert.equal(seen[1].json, false, "второй раз response_format снят");
});

test("исчерпанный дневной бюджет уводит на резерв, а не на ошибку", async () => {
  const p = provider({ id: "a", name: "primary", daily_budget_micro: 100 });
  const b = provider({ id: "b", name: "backup" });
  const { router, store, calls } = harness([p, b], {
    primary: always(() => Promise.resolve(ok())),
    backup: always(() => Promise.resolve(ok("резерв"))),
  });
  store.spendRows.set("a", { day: 500, month: 500 });
  const result = await router.complete(request());
  assert.equal(result.provider_name, "backup");
  assert.equal(calls.filter((c) => c.provider === "primary").length, 0, "основного даже не спрашивали");
  assert.equal(store.attempts[0].switch_reason, "budget_exceeded");
});

test("отказ основного и первого резерва — отвечает второй", async () => {
  const chain = ["a", "b", "c"];
  const { router, calls } = harness(
    [
      provider({ id: "a", name: "primary", max_retries: 0 }),
      provider({ id: "b", name: "backup1", max_retries: 0 }),
      provider({ id: "c", name: "backup2" }),
    ],
    {
      primary: fails(new ProviderError("500", "server_error", { retryable: false })),
      backup1: fails(new ProviderError("500", "server_error", { retryable: false })),
      backup2: always(() => Promise.resolve(ok("третий"))),
    },
    chain,
  );
  const result = await router.complete(request());
  assert.equal(result.provider_name, "backup2");
  assert.equal(result.switches, 2);
  assert.deepEqual(calls.map((c) => c.provider), ["primary", "backup1", "backup2"]);
});

test("три подряд ошибки открывают breaker и исключают провайдера", async () => {
  const p = provider({ id: "a", name: "primary", max_retries: 0 });
  const b = provider({ id: "b", name: "backup" });
  const { router, store, calls } = harness([p, b], {
    primary: fails(new ProviderError("500", "server_error", { retryable: false })),
    backup: always(() => Promise.resolve(ok())),
  });
  for (let i = 0; i < 3; i += 1) await router.complete(request());
  assert.equal(store.breakerRows.get("a").state, "open");

  const before = calls.filter((c) => c.provider === "primary").length;
  await router.complete(request());
  assert.equal(
    calls.filter((c) => c.provider === "primary").length,
    before,
    "открытый breaker больше не пропускает запросы к провайдеру",
  );
});

test("после выдержки уходит ровно один пробный запрос, успех закрывает breaker", async () => {
  const p = provider({ id: "a", name: "primary", max_retries: 0 });
  const b = provider({ id: "b", name: "backup" });
  let primaryHealthy = false;
  const { router, store, calls } = harness([p, b], {
    primary: {
      complete: () => primaryHealthy
        ? Promise.resolve(ok("основной вернулся"))
        : Promise.reject(new ProviderError("500", "server_error", { retryable: false })),
      stream: async function* () { throw new Error("не используется"); },
    },
    backup: always(() => Promise.resolve(ok("резерв"))),
  });
  for (let i = 0; i < 3; i += 1) await router.complete(request());
  assert.equal(store.breakerRows.get("a").state, "open");

  // Выдержка вышла, основной восстановился.
  store.breakerRows.get("a").probe_after = new Date(Date.now() - 1_000);
  primaryHealthy = true;
  const primaryCallsBefore = calls.filter((c) => c.provider === "primary").length;
  const result = await router.complete(request());

  assert.equal(result.provider_name, "primary", "основной возвращается автоматически");
  assert.equal(store.probeClaims, 1, "пробный запрос занят ровно один раз");
  assert.equal(calls.filter((c) => c.provider === "primary").length, primaryCallsBefore + 1);
  assert.equal(store.breakerRows.get("a").state, "closed");
});

test("streaming: переключение до первого фрагмента незаметно", async () => {
  const { router } = harness(
    [provider({ id: "a", name: "primary" }), provider({ id: "b", name: "backup" })],
    {
      primary: { complete: () => Promise.reject(new Error("нет")), stream: async function* () {
        throw new ProviderError("500", "server_error", { retryable: false });
      } },
      backup: always(() => Promise.resolve(ok("ответ резерва"))),
    },
  );
  const chunks = [];
  for await (const chunk of router.stream(request({ stream: true }))) chunks.push(chunk);
  const text = chunks.filter((c) => c.type === "text").map((c) => c.delta).join("");
  assert.equal(text, "ответ резерва");
  assert.equal(chunks.filter((c) => c.type === "done").length, 1, "ровно один финальный ответ");
});

test("streaming: обрыв после первого фрагмента не порождает второй ответ", async () => {
  const { router } = harness(
    [provider({ id: "a", name: "primary" }), provider({ id: "b", name: "backup" })],
    {
      primary: { complete: () => Promise.reject(new Error("нет")), stream: async function* () {
        yield { type: "text", delta: "начало" };
        throw new ProviderError("обрыв", "connection_failed", { retryable: false });
      } },
      backup: always(() => Promise.resolve(ok("резерв дописал бы"))),
    },
  );
  const chunks = [];
  await assert.rejects(async () => {
    for await (const chunk of router.stream(request({ stream: true }))) chunks.push(chunk);
  }, /обрыв/);
  const text = chunks.filter((c) => c.type === "text").map((c) => c.delta).join("");
  assert.equal(text, "начало");
  assert.ok(!text.includes("резерв"), "второй ответ пользователю не ушёл");
});

test("при полном отказе цепочки поднимается NoProviderAvailable, а не тишина", async () => {
  const { router } = harness(
    [provider({ id: "a", name: "primary", max_retries: 0 }), provider({ id: "b", name: "backup", max_retries: 0 })],
    {
      primary: fails(new ProviderError("500", "server_error", { retryable: false })),
      backup: fails(new ProviderError("500", "server_error", { retryable: false })),
    },
  );
  await assert.rejects(() => router.complete(request()), NoProviderAvailable);
});

test("контекст, инструменты и их результаты доходят до резерва без изменений", async () => {
  let seenByBackup = null;
  const { router } = harness(
    [provider({ id: "a", name: "primary", max_retries: 0 }), provider({ id: "b", name: "backup" })],
    {
      primary: fails(new ProviderError("500", "server_error", { retryable: false })),
      backup: {
        complete: (_n, req) => { seenByBackup = req; return Promise.resolve(ok()); },
        stream: async function* () { throw new Error("не используется"); },
      },
    },
  );
  const original = request({
    messages: [
      { role: "user", content: "запиши задачу" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "save", arguments: '{"t":1}' }] },
      { role: "tool", tool_call_id: "c1", content: "сохранено" },
    ],
    tools: [{ name: "save", description: "d", parameters: { type: "object" } }],
  });
  await router.complete(original);

  assert.deepEqual(seenByBackup.messages, original.messages, "переписка передана дословно");
  assert.equal(seenByBackup.messages[2].content, "сохранено", "результат инструмента не потерян");
  assert.equal(seenByBackup.tools.length, 1, "инструменты переданы резерву");
  assert.ok(seenByBackup.system_prompt.includes("Ева"), "личность сохранена");
});

test("один request_id на все попытки, фактический провайдер зафиксирован", async () => {
  const { router, store } = harness(
    [provider({ id: "a", name: "primary", max_retries: 0 }), provider({ id: "b", name: "backup" })],
    {
      primary: fails(new ProviderError("500", "server_error", { retryable: false })),
      backup: always(() => Promise.resolve(ok())),
    },
  );
  const result = await router.complete(request());
  const ids = new Set(store.attempts.map((a) => a.request_id));
  assert.equal(ids.size, 1, "обе попытки под одним request_id");
  assert.equal(result.request_id, [...ids][0]);
  const success = store.attempts.find((a) => a.succeeded);
  assert.equal(success.actual_provider_id, "b");
  assert.equal(success.primary_provider_id, "a");
});

test("в телеметрию не попадает ни текст запроса, ни текст ответа", async () => {
  const { router, store } = harness(
    [provider({ id: "a", name: "primary" })],
    { primary: always(() => Promise.resolve(ok("секретный ответ Евы"))) },
  );
  await router.complete(request({ messages: [{ role: "user", content: "очень личное сообщение" }] }));
  const dump = JSON.stringify(store.attempts);
  assert.ok(!dump.includes("очень личное"), "сообщение пользователя не в журнале");
  assert.ok(!dump.includes("секретный ответ"), "ответ модели не в журнале");
  assert.ok(dump.includes('"tokens_in"'), "счётчики при этом записаны");
});

test("20 одновременных запросов обслуживаются без потерь и без дублей", async () => {
  const p = provider({ id: "a", name: "primary", max_concurrency: 64 });
  const { router, store } = harness([p], {
    primary: always((n) => Promise.resolve(ok(`ответ ${n}`))),
  });
  const results = await Promise.all(
    Array.from({ length: 20 }, (_unused, i) =>
      router.complete(request({ metadata: { request_id: `req-${i}` } }))),
  );
  assert.equal(results.length, 20);
  assert.equal(new Set(results.map((r) => r.request_id)).size, 20, "request_id не перепутались");
  assert.equal(store.attempts.filter((a) => a.succeeded).length, 20, "по одному успеху на запрос");
});

test("параллельные запросы упираются в max_concurrency и уходят на резерв", async () => {
  const p = provider({ id: "a", name: "primary", max_concurrency: 2 });
  const b = provider({ id: "b", name: "backup" });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { router, calls } = harness([p, b], {
    primary: always(() => held.then(() => ok("основной"))),
    backup: always(() => Promise.resolve(ok("резерв"))),
  });
  const pending = [router.complete(request()), router.complete(request())];
  // Дать первым двум занять слоты.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const third = router.complete(request());
  release();
  const [, , thirdResult] = await Promise.all([...pending, third]);
  assert.equal(thirdResult.provider_name, "backup");
  assert.equal(calls.filter((c) => c.provider === "primary").length, 2);
});

// ---------------------------------------------------------------------
// HTTP-поверхность
// ---------------------------------------------------------------------

/**
 * Каталог должен отвечать и в корне, и под /v1.
 *
 * Клиенты не сходятся в том, где кончается base_url: внутренний вызов из
 * llm.ts складывает адрес роутера с "/chat/completions", а коннектор LM
 * Studio, через который Letta ходит сюда, опрашивает "/v1/models". Пока
 * каталог лежал только в корне, App Server получал 404 и не находил ни
 * одной модели — активация провайдера падала с «lmstudio/eva/chat не
 * появилась в каталоге», перечисляя встроенные модели и ни одной своей.
 */
function surface() {
  const routes = new Map([["chat", { code: "chat" }], ["deep", { code: "deep" }]]);
  return createRouterServer({
    apiKey: "test-key",
    logger: { info() {}, error() {}, warn() {}, debug() {} },
    store: {
      routes: async () => routes,
      providers: async () => [{ id: "p1" }],
      breakers: async () => new Map(),
    },
    router: {
      complete: async () => ({
        response: {
          content: "ok", tool_calls: [], finish_reason: "stop",
          usage: { tokens_in: 1, tokens_out: 1 }, model: "eva/chat",
        },
        request_id: "r1", provider_name: "primary", switches: 0,
      }),
      stream: async function* () { throw new Error("не используется"); },
    },
  });
}

test("каталог моделей отвечает и в корне, и под /v1", async () => {
  const app = surface();
  await app.ready();
  try {
    for (const path of ["/models", "/v1/models"]) {
      const response = await app.inject({
        method: "GET", url: path, headers: { authorization: "Bearer test-key" },
      });
      assert.equal(response.statusCode, 200, `${path} должен отвечать`);
      const ids = JSON.parse(response.body).data.map((entry) => entry.id);
      assert.ok(ids.includes("eva/chat"), `${path} не отдал eva/chat`);
    }
  } finally {
    await app.close();
  }
});

test("завершения принимаются по обоим путям", async () => {
  const app = surface();
  await app.ready();
  try {
    for (const path of ["/chat/completions", "/v1/chat/completions"]) {
      const response = await app.inject({
        method: "POST", url: path,
        headers: { authorization: "Bearer test-key", "content-type": "application/json" },
        payload: { model: "eva/chat", messages: [{ role: "user", content: "x" }] },
      });
      assert.equal(response.statusCode, 200, `${path} должен отвечать`);
    }
  } finally {
    await app.close();
  }
});

test("ключ обязателен на обоих путях", async () => {
  const app = surface();
  await app.ready();
  try {
    for (const path of ["/models", "/v1/models"]) {
      const response = await app.inject({ method: "GET", url: path });
      assert.equal(response.statusCode, 401, `${path} ответил без ключа`);
    }
  } finally {
    await app.close();
  }
});

/**
 * Запрос без явной пометки считается чувствительным, поэтому провайдер,
 * которому личные данные не разрешены, не обслужит вообще ничего.
 *
 * Именно так установка и вставала намертво: умолчание схемы было false,
 * фикстура здесь — true, и расхождение никто не сверял. Роутер возвращал
 * 503 «провайдеру не разрешены чувствительные данные» на весь трафик.
 * Умолчание исправлено миграцией 023; тест фиксирует само правило, чтобы
 * следующая такая пара не разошлась молча.
 */
test("провайдер без разрешения на личные данные не обслуживает обычный запрос", async () => {
  const denied = provider({ id: "a", name: "denied", sensitive_data_allowed: false });
  const { router } = harness([denied], {
    denied: always(() => Promise.resolve(ok("не должно случиться"))),
  });
  await assert.rejects(
    async () => await router.complete(request()),
    (error) => {
      assert.ok(error instanceof NoProviderAvailable);
      assert.match(String(error.message), /чувствительные данные/);
      return true;
    },
  );
});

test("тот же провайдер с разрешением запрос обслуживает", async () => {
  const allowed = provider({ id: "a", name: "allowed", sensitive_data_allowed: true });
  const { router } = harness([allowed], {
    allowed: always(() => Promise.resolve(ok("ответ"))),
  });
  const result = await router.complete(request());
  assert.equal(result.provider_name, "allowed");
});
