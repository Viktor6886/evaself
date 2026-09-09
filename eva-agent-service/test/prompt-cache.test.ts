/**
 * Три множителя входа модели: постоянный префикс, история, шаги хода.
 *
 * Проверяется то, что действительно уходит провайдеру, — тело запроса,
 * снятое подставным fetch. Утверждение «мы добавили кэширование» без
 * этого ничего не стоит: поле, поставленное не туда, выглядит в коде
 * так же убедительно, как поставленное правильно.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { anthropicAdapter, resetPromptCacheRejections } from "../dist/router/adapters/anthropic.js";
import {
  contextLimit, CONTEXT_BUDGET_TOKENS, CONTEXT_RESERVE_TOKENS, MIN_CONTEXT_WINDOW, safeContextWindow,
} from "../dist/letta/context-window.js";
import { prefixReport } from "../dist/letta/prefix-size.js";

const TOOL = {
  name: "lookup",
  description: "lookup",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
};

const request = (messages: unknown[]) => ({
  messages, system_prompt: "Ты Ева.", tools: [TOOL], temperature: 0,
  max_tokens: 4_096, stream: false, response_format: null,
  metadata: { request_id: "r1", user_id: null, agent_id: "a1", route: "chat", sensitive: false },
});

const profile = (fetcher: typeof fetch, parameters: Record<string, unknown> = {}) => ({
  id: "p", name: "p", protocol: "anthropic-compatible",
  base_url: "https://provider.invalid/v1", model: "m", api_key: "k",
  connect_timeout_ms: 1_000, request_timeout_ms: 1_000, max_retries: 0, max_concurrency: 1,
  max_rpm: null, max_tpm: null, context_window: 200_000, max_output_tokens: 8_192,
  max_latency_ms: null, supports_tools: true, supports_json: true, supports_vision: false,
  supports_streaming: true, quality_tier: 1, sensitive_data_allowed: true,
  price_in_micro: 0, price_out_micro: 0, daily_budget_micro: null, monthly_budget_micro: null,
  generation_defaults: {}, additional_parameters: parameters, fetcher,
});

const ANSWER = { content: [{ type: "text", text: "ок" }], stop_reason: "end_turn" };

/** Снимает тела всех обращений: повтор после отказа тоже виден. */
function recorder(responses: Array<{ status: number; body: unknown }>) {
  const bodies: Array<Record<string, unknown>> = [];
  let call = 0;
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { bodies, fetcher };
}

const run = async (provider: unknown, messages: unknown[]) =>
  await anthropicAdapter.complete(
    provider as never,
    request(messages) as never,
    AbortSignal.timeout(1_000),
  );

const HELLO = [{ role: "user", content: "привет" }];

test("без настройки провайдера тело запроса прежнее: кэш не включается сам", async () => {
  const { bodies, fetcher } = recorder([{ status: 200, body: ANSWER }]);
  await run(profile(fetcher), HELLO);
  const body = bodies[0]!;
  assert.equal(typeof body.system, "string", "системный промпт остаётся строкой");
  assert.doesNotMatch(JSON.stringify(body), /cache_control/);
});

test("включённый кэш ставит точку на системном блоке — она же закрывает инструменты", async () => {
  // Порядок рендера у Anthropic — tools, system, messages. Точка на
  // системном блоке кэширует и описания инструментов, поэтому отдельной
  // точки на инструментах быть не должно: их всего четыре.
  const { bodies, fetcher } = recorder([{ status: 200, body: ANSWER }]);
  await run(profile(fetcher, { prompt_cache: true }), HELLO);
  const body = bodies[0]! as { system: Array<Record<string, unknown>>; tools: unknown[] };
  assert.ok(Array.isArray(body.system), "системный промпт стал массивом блоков");
  assert.deepEqual(body.system[0]!.cache_control, { type: "ephemeral" });
  assert.doesNotMatch(JSON.stringify(body.tools), /cache_control/);
});

test("вторая точка — в конце истории: следующий шаг читает разговор из кэша", async () => {
  const { bodies, fetcher } = recorder([{ status: 200, body: ANSWER }]);
  await run(profile(fetcher, { prompt_cache: true }), [
    { role: "user", content: "первое" },
    { role: "assistant", content: "ответ" },
    { role: "user", content: "второе" },
  ]);
  const body = bodies[0]! as { messages: Array<{ content: Array<Record<string, unknown>> }> };
  const last = body.messages[body.messages.length - 1]!;
  assert.deepEqual(last.content[last.content.length - 1]!.cache_control, { type: "ephemeral" });
});

test("точек ровно две: предел Anthropic — четыре, и запас нужен", async () => {
  const { bodies, fetcher } = recorder([{ status: 200, body: ANSWER }]);
  await run(profile(fetcher, { prompt_cache: true }), [
    { role: "user", content: "первое" },
    { role: "assistant", content: "ответ" },
    { role: "user", content: "второе" },
  ]);
  const marks = JSON.stringify(bodies[0]).match(/"cache_control"/g) ?? [];
  assert.equal(marks.length, 2);
});

test("блок размышления точкой не помечается: Anthropic его так не принимает", async () => {
  const { bodies, fetcher } = recorder([{ status: 200, body: ANSWER }]);
  await run(profile(fetcher, { prompt_cache: true }), [
    { role: "user", content: "привет" },
    {
      role: "assistant",
      content: "",
      provider_state: { thinking_blocks: [{ type: "thinking", thinking: "…", signature: "s" }] },
    },
  ]);
  const body = bodies[0]! as { messages: Array<{ content: Array<Record<string, unknown>> }> };
  const marked = body.messages
    .flatMap((message) => message.content)
    .filter((block) => block.cache_control !== undefined);
  assert.equal(marked.length, 1, "помечен ровно один блок сообщения");
  assert.notEqual(marked[0]!.type, "thinking");
});

test("часовой срок доезжает до провайдера", async () => {
  const { bodies, fetcher } = recorder([{ status: 200, body: ANSWER }]);
  await run(profile(fetcher, { prompt_cache: true, prompt_cache_ttl: "1h" }), HELLO);
  const body = bodies[0]! as { system: Array<Record<string, unknown>> };
  assert.deepEqual(body.system[0]!.cache_control, { type: "ephemeral", ttl: "1h" });
});

test("настройки кэша не уходят в тело как параметры вывода", async () => {
  // Gemini уже отвечал 400 на транспортный ключ в теле. Строгий
  // anthropic-совместимый endpoint ответит так же.
  const { bodies, fetcher } = recorder([{ status: 200, body: ANSWER }]);
  await run(profile(fetcher, { prompt_cache: true, prompt_cache_ttl: "1h" }), HELLO);
  assert.equal(bodies[0]!.prompt_cache, undefined);
  assert.equal(bodies[0]!.prompt_cache_ttl, undefined);
});

test("endpoint, не понявший cache_control, получает повтор без кэша", async () => {
  // Совместимость с Anthropic заявляют многие, разбирают строго не все.
  // Отказ на незнакомом поле не должен доходить до человека.
  resetPromptCacheRejections();
  const { bodies, fetcher } = recorder([
    { status: 400, body: { error: { message: "unknown field: cache_control" } } },
    { status: 200, body: ANSWER },
  ]);
  const answer = await run(profile(fetcher, { prompt_cache: true }), HELLO);
  assert.equal(answer.content, "ок");
  assert.equal(bodies.length, 2, "ровно один повтор");
  assert.match(JSON.stringify(bodies[0]), /cache_control/);
  assert.doesNotMatch(JSON.stringify(bodies[1]), /cache_control/);
  resetPromptCacheRejections();
});

test("чужой отказ 400 остаётся отказом и повтора не вызывает", async () => {
  resetPromptCacheRejections();
  const { bodies, fetcher } = recorder([
    { status: 400, body: { error: { message: "max_tokens is too large" } } },
  ]);
  await assert.rejects(run(profile(fetcher, { prompt_cache: true }), HELLO));
  assert.equal(bodies.length, 1);
  resetPromptCacheRejections();
});

// ---------------------------------------------------------------------
// Бюджет истории
// ---------------------------------------------------------------------

test("бюджет опускает предел ниже того, что модель физически принимает", () => {
  // Окно 256к разрешало контексту дорасти до двухсот тысяч токенов, и
  // столько же уходило заново в каждом шаге каждого хода.
  const providers = [{ context_window: 256_000, max_output_tokens: 8_000 }];
  const safe = safeContextWindow(providers)!;
  const limit = contextLimit(providers)!;
  assert.ok(safe > CONTEXT_BUDGET_TOKENS, "исходный предел заведомо больше бюджета");
  assert.equal(limit, CONTEXT_BUDGET_TOKENS);
});

test("после постоянного префикса разговору остаётся место, иначе сжатие идёт каждый ход", () => {
  // Тот самый отказ: Letta понимает `context_window_limit` как ПОЛНОЕ
  // окно и меряет им весь собранный контекст вместе с префиксом. Бюджет,
  // названный «историей» и выставленный в 60 000, оставлял разговору
  // тридцать тысяч вместо ста семидесяти — Ева начинала подолгу думать
  // перед ответом, потому что почти каждый ход упирался в сжатие, а на
  // событии сжатия заводится ещё и рефлексия.
  //
  // Разговору должно оставаться не меньше, чем занимает сам префикс:
  // окно, которое больше чем наполовину занято постоянной частью, —
  // это не бюджет, а непрерывное сжатие.
  const limit = contextLimit([{ context_window: 256_000, max_output_tokens: 16_000 }])!;
  const conversation = limit - CONTEXT_RESERVE_TOKENS;
  assert.ok(
    conversation >= CONTEXT_RESERVE_TOKENS,
    `на разговор осталось ${conversation} токенов при префиксе ${CONTEXT_RESERVE_TOKENS}`,
  );
});

test("бюджет предел только опускает: выше безопасного он не поднимает", () => {
  // Иначе вернулась бы смерть диалога, ради которой предел и появился.
  const providers = [{ context_window: 128_000, max_output_tokens: 8_000 }];
  const safe = safeContextWindow(providers)!;
  assert.ok(safe < CONTEXT_BUDGET_TOKENS, "у этой модели безопасный предел меньше бюджета");
  assert.equal(contextLimit(providers), safe);
});

test("бюджет не опускает предел ниже того, при котором разговор не помещается в себя", () => {
  // Большая модель и заведомо слишком маленький бюджет: без нижней
  // границы предел стал бы равен бюджету, и разговор перестал бы
  // помещаться сам в себя — сжатие пошло бы по кругу.
  const roomy = [{ context_window: 256_000, max_output_tokens: 8_000 }];
  assert.ok(safeContextWindow(roomy)! > MIN_CONTEXT_WINDOW);
  assert.equal(contextLimit(roomy, 1_000), MIN_CONTEXT_WINDOW);

  assert.ok(contextLimit([{ context_window: 32_000, max_output_tokens: 4_000 }])! >= MIN_CONTEXT_WINDOW);
  assert.equal(contextLimit([], 1_000), null);
});

// ---------------------------------------------------------------------
// Состав префикса
// ---------------------------------------------------------------------

test("состав префикса показывает, какая часть занимает место", () => {
  const report = prefixReport({
    systemPrompt: "с".repeat(300),
    persona: "п".repeat(500),
    sharedBlocks: [{ label: "therapeutic_framework", value: "р".repeat(200) }],
    tools: [
      { name: "big", description: "о".repeat(400), parameters: { type: "object" } },
      { name: "small", description: "к", parameters: { type: "object" } },
    ],
  });
  assert.equal(report.tools.count, 2);
  assert.equal(report.tools.largest[0]!.name, "big", "самое дорогое описание — первым");
  assert.ok(report.parts[0]!.chars >= report.parts[1]!.chars, "части идут по убыванию");
  assert.equal(
    report.parts.reduce((sum, part) => sum + part.chars, 0),
    report.total_chars,
  );
  assert.ok(report.parts.every((part) => part.share_pct >= 0 && part.share_pct <= 100));
});

test("пустая установка не даёт NaN вместо долей", () => {
  const report = prefixReport({ systemPrompt: "", persona: "", sharedBlocks: [], tools: [] });
  assert.equal(report.total_chars, 0);
  assert.ok(report.parts.every((part) => Number.isFinite(part.share_pct)));
});
