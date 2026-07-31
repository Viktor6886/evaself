/**
 * Рассуждения модели не должны доходить до пользователя.
 *
 * Воспроизводит наблюдавшееся поведение: провайдер, обслуживаемый без
 * reasoning-парсера, отдаёт ход мыслей прямо в content, и он уходил в
 * Telegram вместе с ответом — без разделителя, потому что Ева склеивает
 * дельты ассистента как есть.
 *
 * Проверяется граница роутера: именно там рассуждение надо отсечь, иначе
 * оно попадает в историю conversation и портит уже не сообщение, а память
 * агента.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";

import { openAiAdapter } from "../dist/router/adapters/openai.js";
import { ReasoningStripper, stripReasoning } from "../dist/router/normalize.js";
import { summarizeStream } from "../dist/letta.js";

// ---------------------------------------------------------------------
// разбор текста
// ---------------------------------------------------------------------
describe("вырезание рассуждений из текста", () => {
  test("убирает <think> и оставляет только ответ", () => {
    const { content, reasoning } = stripReasoning(
      "<think>The user is asking about weather. Let me search.</think>Виктор, что нашла: +24°C",
    );
    assert.equal(content, "Виктор, что нашла: +24°C");
    assert.match(reasoning, /Let me search/);
  });

  test("понимает все распространённые написания тега", () => {
    for (const tag of ["think", "thinking", "reason", "reasoning", "thought"]) {
      const { content } = stripReasoning(`<${tag}>внутреннее</${tag}>Ответ`);
      assert.equal(content, "Ответ", `тег ${tag} не распознан`);
    }
    assert.equal(stripReasoning("<|thinking|>ход мыслей<|/thinking|>Ответ").content, "Ответ");
  });

  test("тег с атрибутами тоже вырезается", () => {
    assert.equal(stripReasoning('<think duration="4s">мысли</think>Ответ').content, "Ответ");
  });

  test("несколько блоков подряд", () => {
    const { content } = stripReasoning(
      "<think>шаг один</think>Начало. <think>шаг два</think>Конец.",
    );
    assert.equal(content, "Начало. Конец.");
  });

  test("незакрытый блок не выдаётся за ответ", () => {
    // Модель не закрыла тег или поток оборвался: всё после открывающего
    // тега — не ответ, показывать это нельзя.
    const { content } = stripReasoning("Ответ до размышления.<think>а дальше мысли без конца");
    assert.equal(content, "Ответ до размышления.");
  });

  test("обычный текст не портится", () => {
    for (const text of [
      "Просто ответ без тегов",
      "Код: if (a < b) { return 1; }",
      "Сравнение 5 < 10 и 20 > 3",
      "",
    ]) {
      assert.equal(stripReasoning(text).content, text.trim() === "" ? "" : text);
    }
  });

  test("html-подобный текст без тегов рассуждения не трогается", () => {
    const text = "<b>жирный</b> и <i>курсив</i>";
    assert.equal(stripReasoning(text).content, text);
  });
});

// ---------------------------------------------------------------------
// поток
// ---------------------------------------------------------------------
describe("вырезание рассуждений в потоке", () => {
  const run = (chunks: string[]) => {
    const stripper = new ReasoningStripper();
    let out = "";
    for (const chunk of chunks) out += stripper.push(chunk);
    out += stripper.flush();
    return out;
  };

  test("тег, разрезанный между чанками", () => {
    // Именно так это и приходит по SSE: <thi | nk> — и наивная очистка
    // по каждому чанку отдельно тег не увидит.
    assert.equal(run(["<thi", "nk>мыс", "ли</thi", "nk>От", "вет"]), "Ответ");
  });

  test("рассуждение в середине потока", () => {
    assert.equal(run(["Начало. ", "<think>", "мысли", "</think>", "Конец."]), "Начало. Конец.");
  });

  test("текст без тегов проходит целиком и по частям", () => {
    assert.equal(run(["При", "вет, ", "Виктор"]), "Привет, Виктор");
  });

  test("одиночный символ < не съедает остаток", () => {
    assert.equal(run(["a < b", " и всё"]), "a < b и всё");
  });

  test("незакрытый блок в конце потока наружу не уходит", () => {
    assert.equal(run(["Ответ.", "<think>мысли без конца"]), "Ответ.");
  });
});

// ---------------------------------------------------------------------
// адаптер против настоящего HTTP
// ---------------------------------------------------------------------
describe("адаптер OpenAI-совместимого провайдера", () => {
  let server: http.Server;
  let baseUrl = "";
  let reply: { status: number; body: string; sse?: string[] } = { status: 200, body: "{}" };
  let lastRequest: Record<string, unknown> = {};

  before(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        try {
          lastRequest = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          lastRequest = {};
        }
        if (reply.sse) {
          response.writeHead(reply.status, { "content-type": "text/event-stream" });
          for (const event of reply.sse) response.write(`data: ${event}\n\n`);
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(() => server.close());

  const provider = (overrides: Record<string, unknown> = {}) => ({
    id: "p-custom",
    name: "custom",
    protocol: "openai-compatible",
    base_url: baseUrl,
    model: "custom-reasoner",
    api_key: "k",
    connect_timeout_ms: 5_000,
    request_timeout_ms: 10_000,
    max_retries: 0,
    max_concurrency: 4,
    max_rpm: null,
    max_tpm: null,
    context_window: 32_000,
    max_output_tokens: 1_024,
    max_latency_ms: null,
    supports_tools: true,
    supports_json: true,
    supports_vision: false,
    supports_streaming: true,
    quality_tier: 2,
    sensitive_data_allowed: true,
    price_in_micro: 0,
    price_out_micro: 0,
    daily_budget_micro: null,
    monthly_budget_micro: null,
    currency: "USD",
    priority: 100,
    enabled: true,
    languages: ["ru"],
    generation_defaults: {},
    additional_parameters: {},
    ...overrides,
  });

  const request = {
    messages: [{ role: "user" as const, content: "Какая погода в Перми?" }],
    system_prompt: "",
    tools: [],
    temperature: 0.7,
    max_tokens: 512,
    response_format: null,
    stream: false,
  };

  test("рассуждение в content не доходит до ответа", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({
        model: "custom-reasoner",
        choices: [{
          message: {
            content:
              "<think>The user is asking about the weather in Perm. Let me search.</think>"
              + "Виктор, что нашла: +24°C, ясно.",
          },
          finish_reason: "stop",
        }],
      }),
    };

    const result = await openAiAdapter.complete(
      provider() as never, request as never, AbortSignal.timeout(5_000),
    );

    assert.equal(result.content, "Виктор, что нашла: +24°C, ясно.");
    assert.ok(!result.content.includes("The user is asking"), "рассуждение просочилось в ответ");
  });

  test("отдельное поле reasoning_content в ответ не подмешивается", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({
        model: "custom-reasoner",
        choices: [{
          message: {
            reasoning_content: "Let me think about this carefully.",
            content: "Привет, Виктор 😄",
          },
          finish_reason: "stop",
        }],
      }),
    };

    const result = await openAiAdapter.complete(
      provider() as never, request as never, AbortSignal.timeout(5_000),
    );
    assert.equal(result.content, "Привет, Виктор 😄");
  });

  test("ответ из одного рассуждения объясняет причину, а не молчит", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({
        model: "custom-reasoner",
        choices: [{ message: { content: "<think>только мысли и ничего больше</think>" } }],
      }),
    };

    await assert.rejects(
      () => openAiAdapter.complete(provider() as never, request as never, AbortSignal.timeout(5_000)),
      (error: Error) => /рассужден/i.test(error.message) && /thinking|парсер/i.test(error.message),
      "оператор должен понять, что дело в настройке провайдера",
    );
  });

  test("в потоке рассуждение не уходит пользователю", async () => {
    const delta = (text: string) => JSON.stringify({
      model: "custom-reasoner",
      choices: [{ delta: { content: text } }],
    });
    reply = {
      status: 200,
      body: "",
      // Тег намеренно разрезан между событиями — так и приходит по SSE.
      sse: [
        delta("<thi"), delta("nk>Let me "), delta("check the weather."),
        delta("</thi"), delta("nk>Виктор, "), delta("нашла: +24°C"),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      ],
    };

    let streamed = "";
    let final = "";
    for await (const event of openAiAdapter.stream(
      provider() as never, { ...request, stream: true } as never, AbortSignal.timeout(5_000),
    )) {
      if (event.type === "text") streamed += event.delta;
      if (event.type === "done") final = event.response.content;
    }

    assert.equal(streamed, "Виктор, нашла: +24°C");
    assert.equal(final, "Виктор, нашла: +24°C");
    assert.ok(!streamed.includes("Let me check"), "рассуждение утекло в поток");
  });

  test("additional_parameters доходят до провайдера", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({
        model: "custom-reasoner",
        choices: [{ message: { content: "Ответ" }, finish_reason: "stop" }],
      }),
    };

    await openAiAdapter.complete(
      provider({
        additional_parameters: { chat_template_kwargs: { enable_thinking: false } },
      }) as never,
      request as never,
      AbortSignal.timeout(5_000),
    );

    // Без этого у оператора нет способа отключить размышления у
    // провайдера, который отдаёт их без тегов.
    assert.deepEqual(
      lastRequest.chat_template_kwargs,
      { enable_thinking: false },
      "additional_parameters не дошли до провайдера",
    );
  });

  test("additional_parameters не перебивают поля самого роутера", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({
        model: "custom-reasoner",
        choices: [{ message: { content: "Ответ" }, finish_reason: "stop" }],
      }),
    };

    await openAiAdapter.complete(
      provider({
        additional_parameters: { model: "чужая-модель", messages: [], stream: true },
      }) as never,
      request as never,
      AbortSignal.timeout(5_000),
    );

    assert.equal(lastRequest.model, "custom-reasoner", "модель роутера должна побеждать");
    assert.equal(lastRequest.stream, false);
    assert.equal((lastRequest.messages as unknown[]).length, 1);
  });
});

// ---------------------------------------------------------------------
// то, из-за чего это выглядело именно так
// ---------------------------------------------------------------------
test("Ева склеивает дельты ассистента без разделителя", () => {
  // Это не дефект, а причина, по которой утёкшее рассуждение выглядело
  // слипшимся с ответом: «Let me search for both.The search didn't…».
  // Вставлять разделители нельзя — провайдер рвёт слова между событиями.
  const summary = summarizeStream([
    { type: "assistant", content: "Let me search for both." },
    { type: "assistant", content: "The search didn't help." },
    { type: "assistant", content: "Виктор, что нашла:" },
  ] as never);

  assert.equal(summary.reply, "Let me search for both.The search didn't help.Виктор, что нашла:");
});

test("сообщения типа reasoning в ответ не попадают", () => {
  const summary = summarizeStream([
    { type: "reasoning", reasoning: "ход мыслей" },
    { type: "assistant", content: "Привет" },
  ] as never);

  assert.equal(summary.reply, "Привет");
  assert.deepEqual(summary.reasoning, ["ход мыслей"]);
});
