import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LlmManager,
  SecretBox,
  catalogVisionHint,
  modelHandle,
  keyPool,
  probeGeminiProvider,
  probeOpenAiProvider,
} from "../dist/llm.js";
import { summarize } from "../dist/llm/capability-probe.js";

test("OpenRouter-style input_modalities is a hint, not a model-id rule", () => {
  const models = [{
    id: "vendor/future-model",
    architecture: { input_modalities: ["text", "image"] },
  }];
  assert.equal(catalogVisionHint(models, "vendor/future-model"), true);
  assert.equal(catalogVisionHint([{ id: "vendor/text", architecture: { input_modalities: ["text"] } }], "vendor/text"), false);
  assert.equal(catalogVisionHint(models, "missing"), null);
});

test("API key encrypts with authenticated random ciphertext", () => {
  const box = new SecretBox("x".repeat(64));
  const first = box.encrypt("sk-very-secret");
  const second = box.encrypt("sk-very-secret");

  assert.notEqual(first, second);
  assert.ok(!first.includes("sk-very-secret"));
  assert.equal(box.decrypt(first), "sk-very-secret");
  assert.throws(() => box.decrypt(`${first.slice(0, -2)}aa`));
});

test("modelHandle routes arbitrary OpenAI-compatible IDs through dynamic discovery", () => {
  assert.equal(modelHandle("gpt-compatible"), "lmstudio/gpt-compatible");
  assert.equal(modelHandle("vendor/model"), "lmstudio/vendor/model");
  assert.equal(modelHandle("lmstudio/already-qualified"), "lmstudio/already-qualified");
});

test("provider probe reads an OpenAI-compatible /models response", async () => {
  let authorization = "";
  const result = await probeOpenAiProvider(
    { baseUrl: "https://llm.example/v1/", apiKey: "hidden", timeoutMs: 1000 },
    (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), "https://llm.example/v1/models");
      authorization = String((init?.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  );

  assert.equal(authorization, "Bearer hidden");
  assert.equal(result.ok, true);
  assert.equal(result.models_supported, true);
  assert.deepEqual(result.models.map((item) => item.id), ["model-a", "model-b"]);
});

test("provider probe allows manual model entry when /models is unsupported", async () => {
  const result = await probeOpenAiProvider(
    { baseUrl: "https://llm.example/v1", apiKey: "hidden", timeoutMs: 1000 },
    (async () => new Response("", { status: 404 })) as typeof fetch,
  );
  assert.equal(result.ok, true);
  assert.equal(result.models_supported, false);
});

/**
 * У Google другой ключевой заголовок и другая форма ответа. Послать сюда
 * `Authorization: Bearer` — получить 401 и объявить недоступным
 * провайдера, который вполне доступен.
 */
test("provider probe reads a native Gemini /models response", async () => {
  let headers: Record<string, string> = {};
  const result = await probeGeminiProvider(
    { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "hidden", timeoutMs: 1000 },
    (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/models");
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({
        models: [
          { name: "models/gemini-3.7-flash", inputTokenLimit: 1_000_000 },
          { name: "models/gemini-3.7-pro" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  );

  assert.equal(headers["x-goog-api-key"], "hidden");
  assert.equal(headers.Authorization, undefined, "Bearer у Google означает 401");
  assert.equal(result.ok, true);
  // Префикс `models/` снят: адаптер подставляет имя в путь
  // `/models/{model}:generateContent`, и с ним вышло бы `models%2F…`.
  assert.deepEqual(result.models.map((item) => item.id), ["gemini-3.7-flash", "gemini-3.7-pro"]);
});

test("gemini probe reports an HTTP failure instead of an empty catalogue", async () => {
  const result = await probeGeminiProvider(
    { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "bad", timeoutMs: 1000 },
    (async () => new Response("", { status: 403 })) as typeof fetch,
  );
  assert.equal(result.ok, false);
  assert.equal(result.status_code, 403);
  assert.deepEqual(result.models, []);
});

/**
 * Проба обходит пул так же, как роутер.
 *
 * Иначе панель врёт: первый ключ упирается в квоту, роутер берёт
 * следующий и Ева отвечает, а «Проверить» бьёт в тот же исчерпанный ключ
 * и показывает «временно недоступен». Человек видит рабочего провайдера
 * с красной подписью и не знает, кому верить.
 */
test("исчерпанный ключ уводит пробу на следующий ключ пула", async () => {
  const master = "q".repeat(64);
  const box = new SecretBox(master);
  const tried: string[] = [];
  const row = {
    ...providerRow("pooled", true, box.encrypt("dead")),
    api_keys_encrypted: [box.encrypt("dead"), box.encrypt("alive")],
  };
  const manager = new LlmManager(
    config(master),
    { getLlmProvider: async () => row, getActiveLlmProvider: async () => row,
      recordLlmCheck: async () => row, setLlmProviderCapabilities: async () => row } as never,
    { setDefaultModel() {} } as never,
    logger() as never,
    {
      probeProvider: async (_provider: unknown, apiKey: string) => {
        tried.push(apiKey);
        return { ok: true, models_supported: true, models: [], message: "ok", status_code: 200 };
      },
      probeCapabilities: async (_provider: unknown, apiKey: string) => (apiKey === "alive"
        ? { ok: true, status: "ok", checks: [], message: "", warnings: "",
            detected: { vision: null, streaming: null, tools: null, json: null } }
        : { ok: false, status: "unavailable", checks: [], message: "квота", warnings: "",
            detected: { vision: null, streaming: null, tools: null, json: null },
            keyExhausted: true }),
    } as never,
  );

  const result = await manager.test(row.id);
  assert.deepEqual(tried, ["dead", "alive"], "пул перебирается по порядку");
  assert.equal(result.ok, true, "рабочий ключ найден — провайдер исправен");
});

test("занятый сервис пул не перебирает", async () => {
  const master = "w".repeat(64);
  const box = new SecretBox(master);
  const tried: string[] = [];
  const row = {
    ...providerRow("busy", true, box.encrypt("k1")),
    api_keys_encrypted: [box.encrypt("k1"), box.encrypt("k2"), box.encrypt("k3")],
  };
  const manager = new LlmManager(
    config(master),
    { getLlmProvider: async () => row, getActiveLlmProvider: async () => row,
      recordLlmCheck: async () => row, setLlmProviderCapabilities: async () => row } as never,
    { setDefaultModel() {} } as never,
    logger() as never,
    {
      probeProvider: async (_provider: unknown, apiKey: string) => {
        tried.push(apiKey);
        return { ok: true, models_supported: true, models: [], message: "ok", status_code: 200 };
      },
      // 503 high demand: к ключу отношения не имеет, следующий ответит
      // тем же. Полная проба десять раз — минуты ожидания ни за что.
      probeCapabilities: async () => ({
        ok: false, status: "unavailable", checks: [], message: "503 high demand", warnings: "",
        detected: { vision: null, streaming: null, tools: null, json: null },
        keyExhausted: false,
      }),
    } as never,
  );

  await manager.test(row.id);
  assert.deepEqual(tried, ["k1"], "занятость сервиса не повод жечь пул");
});

test("пул ключей сохраняет порядок, убирает повторы и держит предел", () => {
  // Порядок значим: роутер обходит пул сверху вниз.
  assert.deepEqual(keyPool("main", ["spare-1", "spare-2"]), ["main", "spare-1", "spare-2"]);
  // Повтор выбрасывается, а не переставляется.
  assert.deepEqual(keyPool("main", ["main", "spare"]), ["main", "spare"]);
  // Пустые строки — след копирования из документа, а не ключ.
  assert.deepEqual(keyPool("main", ["", "  ", "spare"]), ["main", "spare"]);
  // Основного может не быть: тогда первый запасной становится основным.
  assert.deepEqual(keyPool("", ["only"]), ["only"]);
  assert.throws(() => keyPool("", []), /хотя бы один/u);
  assert.throws(
    () => keyPool("main", Array.from({ length: 10 }, (_, index) => `k${index}`)),
    /не больше десяти/u,
  );
});

test("public provider responses never expose ciphertext or API key", async () => {
  const box = new SecretBox("k".repeat(64));
  const row = providerRow("candidate", false, box.encrypt("sk-browser-must-not-see"));
  const db = {
    createLlmProvider: async () => row,
  };
  const manager = new LlmManager(
    config("k".repeat(64)),
    db as never,
    {} as never,
    logger() as never,
  );

  const result = await manager.create({
    name: "candidate",
    base_url: "https://llm.example/v1",
    api_key: "sk-browser-must-not-see",
    model: "model-a",
    context_window: 32768,
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("sk-browser-must-not-see"));
  assert.ok(!serialized.includes("api_key_encrypted"));
  assert.equal(result.api_key_configured, true);
});

test("смена chat-модели обновляет metadata за eva/chat без рестарта Letta", async () => {
  const master = "z".repeat(64);
  const box = new SecretBox(master);
  const previous = providerRow("previous", true, box.encrypt("old-key"));
  const candidate = {
    ...providerRow("candidate", false, box.encrypt("new-key")),
    context_window: 65_536,
    additional_parameters: { model_settings: { reasoning_effort: "high" } },
  };
  let active = previous;
  const configured: string[] = [];
  const applied: Array<{ model: string; context: number; settings: unknown }> = [];
  let restarts = 0;
  let closed = 0;
  const order: string[] = [];

  const db = {
    getLlmProvider: async (id: string) => (id === candidate.id ? candidate : previous),
    getActiveLlmProvider: async () => active,
    getLlmRouteChain: async () => [previous.id],
    replaceLlmRouteChain: async () => undefined,
    recordLlmCheck: async () => candidate,
    setAgentModels: async () => undefined,
    activateLlmProvider: async (id: string) => {
      order.push(`activate:${id}`);
      active = id === previous.id ? previous : candidate;
      return active;
    },
  };
  const letta = {
    closeAllSessions: () => { closed += 1; },
    setDefaultModel: () => undefined,
    waitForModel: async () => undefined,
    listAllModelMappings: async () => [{ agentId: "agent-1", conversationIds: ["conv-1"] }],
    // Handle больше не кодирует модель провайдера: Letta всегда видит один
    // маршрут роутера, а конкретную модель выбирает роутер. Поэтому сбой
    // привязывается к номеру попытки, а не к имени модели.
    applyModelToMappings: async (_mappings: unknown, model: string, context: number, settings: unknown) => {
      order.push("apply-metadata");
      applied.push({ model, context, settings });
    },
  };
  const manager = new LlmManager(
    config(master),
    db as never,
    letta as never,
    logger() as never,
    {
      configureProvider: async (provider) => {
        configured.push(provider.name);
      },
      restartAppServer: async () => { restarts += 1; },
      probeProvider: async () => ({
        ok: true,
        models_supported: true,
        models: [{ id: "candidate-model" }],
        message: "ok",
        status_code: 200,
      }),
      // Совместимость модели — отдельная проверка; здесь проверяется
      // переключение, поэтому она подменена заведомо успешной.
      probeCapabilities: async () => ({ ok: true, checks: [], message: "", warnings: "" }),
    },
  );

  const result = await manager.activate(candidate.id);
  assert.equal(result.id, candidate.id);
  assert.deepEqual(configured, []);
  assert.deepEqual(applied, [{
    model: modelHandle("eva/chat"),
    context: candidate.context_window,
    settings: { reasoning_effort: "high" },
  }]);
  assert.equal(restarts, 0);
  assert.equal(closed, 0);
  assert.equal(active.id, candidate.id);
  assert.deepEqual(order, [`activate:${candidate.id}`, "apply-metadata"]);
});

test("startup discovers legacy vision=false before Letta opens a session", async () => {
  const master = "v".repeat(64);
  const row = {
    ...providerRow("active", true, new SecretBox(master).encrypt("provider-key")),
    supports_vision: false,
  };
  const order: string[] = [];
  const db = {
    getActiveLlmProvider: async () => row,
    setLlmProviderCapabilities: async (
      _id: string,
      values: { vision?: boolean },
    ) => {
      order.push(`persist:${values.vision}`);
      return { ...row, supports_vision: values.vision === true };
    },
  };
  const letta = {
    setDefaultModel: (model: string) => { order.push(`default:${model}`); },
  };
  const manager = new LlmManager(
    config(master),
    db as never,
    letta as never,
    logger() as never,
    {
      probeVision: async () => ({
        name: "vision", status: "ok", detail: "image recognized", blocking: false,
      }),
    },
  );

  await manager.initializeDefaultModel();

  assert.deepEqual(order, [
    `default:${modelHandle("eva/chat")}`,
    "persist:true",
  ]);
});

test("startup clears stale vision=true after factual probe fails", async () => {
  const master = "s".repeat(64);
  const row = {
    ...providerRow("active", true, new SecretBox(master).encrypt("provider-key")),
    supports_vision: true,
  };
  const persisted: boolean[] = [];
  const manager = new LlmManager(
    config(master),
    {
      getActiveLlmProvider: async () => row,
      setLlmProviderCapabilities: async (
        _id: string,
        values: { vision?: boolean },
      ) => {
        persisted.push(values.vision === true);
        return { ...row, supports_vision: values.vision === true };
      },
    } as never,
    { setDefaultModel() {} } as never,
    logger() as never,
    { probeVision: async () => ({ name: "vision", status: "failed", detail: "image rejected", blocking: true }) },
  );
  await manager.initializeDefaultModel();
  assert.deepEqual(persisted, [false]);
});

test("activation persists discovered vision before Router catalog is refreshed", async () => {
  const master = "w".repeat(64);
  const candidate = {
    ...providerRow("candidate", false, new SecretBox(master).encrypt("provider-key")),
    supports_vision: false,
  };
  const order: string[] = [];
  const db = {
    getLlmProvider: async () => candidate,
    getActiveLlmProvider: async () => null,
    setLlmProviderCapabilities: async () => {
      order.push("persist-vision");
      return { ...candidate, supports_vision: true };
    },
    recordLlmCheck: async () => undefined,
    activateLlmProvider: async () => {
      order.push("activate-route");
      return { ...candidate, supports_vision: true, is_active: true };
    },
    setAgentModels: async () => undefined,
  };
  const letta = {
    setDefaultModel: () => undefined,
    closeAllSessions: () => undefined,
    listAllModelMappings: async () => [],
    waitForModel: async () => { order.push("read-catalog"); },
    applyModelToMappings: async () => undefined,
  };
  const manager = new LlmManager(
    config(master),
    db as never,
    letta as never,
    logger() as never,
    {
      configureProvider: async () => undefined,
      restartAppServer: async () => undefined,
      probeProvider: async () => ({
        ok: true, models_supported: true, models: [], message: "ok", status_code: 200,
      }),
      // Результат собирается настоящей сводкой: подделанная форма разошлась
      // бы с рабочей и перестала проверять то, ради чего тест написан.
      probeCapabilities: async () => summarize([
        { name: "vision", status: "ok", detail: "image recognized", blocking: false },
      ]),
    },
  );

  await manager.activate(candidate.id);

  assert.deepEqual(order.slice(0, 3), ["persist-vision", "activate-route", "read-catalog"]);
});

function providerRow(name: string, isActive: boolean, encrypted: string) {
  const now = new Date("2026-07-28T00:00:00Z");
  return {
    id: `${name}-id`,
    name,
    protocol: "openai-compatible" as const,
    base_url: "https://llm.example/v1",
    model: `${name}-model`,
    context_window: 32768,
    additional_parameters: {},
    api_key_encrypted: encrypted,
    is_active: isActive,
    last_checked_at: null,
    last_check_ok: null,
    last_check_message: null,
    last_models: null,
    created_at: now,
    updated_at: now,
  };
}

function config(master: string) {
  return {
    llmEncryptionKey: master,
    llmProbeTimeoutMs: 1000,
    lettaCliPath: "letta",
    llmProviderConfigDir: "/tmp/providers",
    llmControlFile: "/tmp/restart",
  } as never;
}

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

/**
 * Старт сервиса выясняет у активной модели только зрение.
 *
 * Раньше он писал заодно «не умеет инструменты, поток и строгий JSON» —
 * просто потому, что этих проверок в сводке не было. Установка в режиме
 * одной модели после этого отвечала пятисоткой на каждое сообщение:
 * роутер отсекает провайдера без инструментов от всех ходов, а панель не
 * даёт пересохранить режим, пока у модели нет инструментов.
 */
test("старт выясняет зрение и не трогает остальные возможности", async () => {
  const master = "v".repeat(64);
  const row = {
    ...providerRow("active", true, new SecretBox(master).encrypt("provider-key")),
    supports_vision: false, supports_tools: true, supports_json: true, supports_streaming: true,
  };
  const written: Array<Record<string, unknown>> = [];
  const manager = new LlmManager(
    config(master),
    {
      getActiveLlmProvider: async () => row,
      setLlmProviderCapabilities: async (_id: string, values: Record<string, unknown>) => {
        written.push(values);
        return { ...row, supports_vision: true };
      },
    } as never,
    { setDefaultModel() {} } as never,
    logger() as never,
    {
      probeVision: async () => ({
        name: "vision", status: "ok", detail: "image recognized", blocking: false,
      }),
    },
  );

  await manager.initializeDefaultModel();

  assert.deepEqual(written, [{ vision: true }], "старт вправе записать только проверенное зрение");
});

/**
 * Панель не позволяет снять инструменты у модели, на которой держится
 * установка (`updateProvider`). Проба писала в ту же колонку мимо этой
 * проверки, и выйти из тупика было нельзя: роутер модель не берёт,
 * панель режим не пересохраняет.
 */
test("проба не выключает инструменты у модели режима одной модели", async () => {
  const master = "t".repeat(64);
  const row = {
    ...providerRow("selected", true, new SecretBox(master).encrypt("provider-key")),
    supports_vision: false, supports_tools: true,
  };
  const written: Array<Record<string, unknown>> = [];
  const manager = new LlmManager(
    config(master),
    {
      getLlmProvider: async () => row,
      isLlmSingleProviderSelected: async () => true,
      setLlmProviderCapabilities: async (_id: string, values: Record<string, unknown>) => {
        written.push(values);
        return { ...row, ...values };
      },
      recordLlmCheck: async () => undefined,
    } as never,
    { setDefaultModel() {} } as never,
    logger() as never,
    {
      probeProvider: async () => ({
        ok: true, models_supported: true, models: [], message: "ok", status_code: 200,
      }),
      probeCapabilities: async () => summarize([
        { name: "completion", status: "ok", detail: "ответ получен", blocking: true },
        { name: "vision", status: "ok", detail: "изображение распознано", blocking: false },
        { name: "tool_call", status: "failed", detail: "модель не вызвала инструмент", blocking: true },
        { name: "tool_result_loop", status: "failed", detail: "вызова инструмента не было", blocking: true },
      ]),
    },
  );

  await manager.test(row.id);

  assert.deepEqual(written, [{ vision: true }], "выясненное зрение записывается, инструменты — нет");
});
