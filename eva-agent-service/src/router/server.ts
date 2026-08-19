/**
 * OpenAI-совместимый фасад роутера.
 *
 * Letta App Server настраивается на него один раз как на единственный
 * провайдер и больше не перенастраивается: смена модели, добавление
 * резерва и failover происходят внутри и не требуют ни рестарта App
 * Server, ни правки чего-либо на стороне Letta.
 *
 * Имя модели в запросе — это код маршрута: "eva/chat", "eva/tools",
 * "eva/json", "eva/deep". Неизвестное имя уходит в маршрут chat.
 */

import Fastify from "fastify";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";

import type { Logger } from "../logger.js";
import { LlmRouter, NoProviderAvailable } from "./router.js";
import { containsImage, parseContent, pickProviderState } from "./content.js";
import { extractRoutingMarker, type RoutingMarkerClaims } from "./routing-marker.js";
import type { RouterStore } from "./store.js";
import type { LlmMessage, LlmRequest, LlmTool } from "./types.js";

const MODEL_PREFIX = "eva/";
const DEFAULT_ROUTE = "chat";

export interface RouterServerInput {
  router: LlmRouter;
  store: RouterStore;
  logger: Logger;
  apiKey: string;
  embed?: (texts: string[]) => Promise<number[][]>;
}

export function createRouterServer(input: RouterServerInput): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  // Роутер живёт во внутренней сети и наружу не публикуется, но ключ всё
  // равно обязателен: сеть agent общая для нескольких контейнеров.
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    const header = request.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!input.apiKey || provided !== input.apiKey) {
      await reply.code(401).send({ error: { message: "неверный ключ роутера", type: "auth" } });
    }
  });

  app.get("/health", async () => {
    const providers = await input.store.providers();
    const breakers = await input.store.breakers();
    const open = [...breakers.values()].filter((row) => row.state === "open").length;
    return {
      status: providers.length > 0 ? "ok" : "degraded",
      providers: providers.length,
      breakers_open: open,
    };
  });

  app.post("/embeddings", async (request, reply) => {
    if (!input.embed) return reply.code(503).send({ error: { message: "embeddings route is not configured", type: "service_unavailable" } });
    const body = request.body as { input?: unknown };
    const texts = typeof body?.input === "string" ? [body.input] : Array.isArray(body?.input) && body.input.every(x => typeof x === "string") ? body.input as string[] : null;
    if (!texts || texts.length > 64) return reply.code(400).send({ error: { message: "input must be a string or up to 64 strings", type: "invalid_request_error" } });
    const vectors = await input.embed(texts);
    return { object:"list", data:vectors.map((embedding,index)=>({object:"embedding",index,embedding})) };
  });

  /**
   * OpenAI-совместимая часть висит и в корне, и под /v1.
   *
   * Клиенты не сходятся в том, где кончается base_url. Внутренний вызов из
   * llm.ts складывает адрес роутера с "/chat/completions", а коннектор LM
   * Studio, через который Letta ходит сюда, ждёт базу в стиле LM Studio и
   * опрашивает "/v1/models". Пока каталог лежал только в корне, App Server
   * получал 404, не находил ни одной модели, и lmstudio/eva/chat не
   * появлялся в каталоге: активация провайдера падала с «модель не
   * появилась», перечисляя встроенные модели App Server и ни одной своей.
   *
   * Отвечать по обоим путям дешевле, чем угадывать соглашение клиента.
   */
  const openAiSurface: FastifyPluginAsync = async (scope) => {
    /** Каталог маршрутов в формате /v1/models — его читает Letta. */
    scope.get("/models", async () => {
      const routes = await input.store.routes();
      return {
        object: "list",
        data: [...routes.values()].map((route) => ({
          id: `${MODEL_PREFIX}${route.code}`,
          object: "model",
          owned_by: "evaself",
          created: 0,
        })),
      };
    });

    scope.post("/chat/completions", async (request, reply) => {
    let parsed: LlmRequest;
    try {
      parsed = fromOpenAi(request.body, input.apiKey);
    } catch (error) {
      return reply.code(400).send({
        error: {
          message: error instanceof Error ? error.message : "некорректный запрос",
          type: "invalid_request_error",
        },
      });
    }

    if (!parsed.stream) {
      try {
        const result = await input.router.complete(parsed);
        return reply.send(toOpenAi(result.response, result));
      } catch (error) {
        return sendFailure(reply, error, input.logger, parsed);
      }
    }

    // Потоковый ответ. Заголовки отправляются только перед первым
    // фрагментом: пока их нет, ошибка ещё может уйти обычным JSON.
    let headersSent = false;
    try {
      for await (const chunk of input.router.stream(parsed)) {
        if (!headersSent) {
          headersSent = true;
          reply.raw.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
        }
        reply.raw.write(`data: ${JSON.stringify(toOpenAiChunk(chunk, parsed))}\n\n`);
      }
      if (!headersSent) {
        reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      }
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return reply;
    } catch (error) {
      if (!headersSent) return sendFailure(reply, error, input.logger, parsed);
      // Поток уже начался: HTTP-код изменить нельзя, поэтому ошибка
      // передаётся событием и соединение закрывается.
      input.logger.error("LLM Router: обрыв уже начатого потока", {
        request_id: parsed.metadata.request_id,
        error: error instanceof Error ? error.message : String(error),
      });
      reply.raw.write(
        `data: ${JSON.stringify({ error: { message: "поток прерван", type: "server_error" } })}\n\n`,
      );
      reply.raw.end();
      return reply;
    }
    });
  };

  void app.register(openAiSurface);
  void app.register(openAiSurface, { prefix: "/v1" });

  return app;
}

function sendFailure(
  reply: FastifyReply,
  error: unknown,
  logger: Logger,
  request: LlmRequest,
) {
  if (error instanceof NoProviderAvailable) {
    logger.error("LLM Router: ни один провайдер не ответил", {
      request_id: request.metadata.request_id,
      route: request.metadata.route,
      detail: error.detail,
    });
    // 503 — Letta и вызывающие трактуют это как временную недоступность и
    // не считают запрос некорректным.
    return reply.code(503).send({
      error: { message: error.detail, type: "service_unavailable" },
    });
  }
  logger.error("LLM Router: непредвиденная ошибка", {
    request_id: request.metadata.request_id,
    error: error instanceof Error ? error.message : String(error),
  });
  return reply.code(500).send({
    error: { message: "внутренняя ошибка роутера", type: "server_error" },
  });
}

// ---------------------------------------------------------------------
// преобразование OpenAI ⇄ внутренний формат
// ---------------------------------------------------------------------
interface OpenAiIn {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  stream?: unknown;
  response_format?: { type?: unknown } | null;
  metadata?: { request_id?: unknown; user_id?: unknown; agent_id?: unknown; sensitive?: unknown };
  user?: unknown;
}

export function fromOpenAi(raw: unknown, markerSecret = ""): LlmRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("тело запроса должно быть объектом");
  }
  const body = raw as OpenAiIn;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("messages обязателен и не может быть пустым");
  }

  const messages: LlmMessage[] = [];
  let systemPrompt = "";
  let routingClaims: RoutingMarkerClaims | null = null;
  for (const item of body.messages as Array<Record<string, unknown>>) {
    const role = String(item.role ?? "user");
    const parsed = parseContent(item.content);
    const extracted = extractRoutingMarker(parsed.text, markerSecret);
    const content = extracted.text;
    if (extracted.claims) routingClaims = extracted.claims;
    if (role === "system" && messages.length === 0) {
      // Ведущий system становится system_prompt: Anthropic принимает его
      // только отдельным полем.
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${content}` : content;
      continue;
    }
    const message: LlmMessage = {
      role: role === "system" || role === "assistant" || role === "tool" ? role : "user",
      content,
    };
    if (parsed.parts) {
      // Маркер маршрутизации вырезан из текстовой выжимки — вырезаем его и
      // из текстовых частей, иначе он уедет к провайдеру.
      message.parts = parsed.parts.map((part) => part.type === "text"
        ? { type: "text" as const, text: extractRoutingMarker(part.text, markerSecret).text }
        : part);
    }
    // Служебные поля reasoning-моделей переносятся как есть: их читает
    // провайдер, а не роутер.
    const state = pickProviderState(item);
    if (state) message.provider_state = state;
    if (typeof item.tool_call_id === "string") message.tool_call_id = item.tool_call_id;
    if (Array.isArray(item.tool_calls)) {
      message.tool_calls = (item.tool_calls as Array<Record<string, unknown>>)
        .map((call, index) => {
          const fn = (call.function ?? {}) as Record<string, unknown>;
          return {
            id: typeof call.id === "string" ? call.id : `call_${index}`,
            name: typeof fn.name === "string" ? fn.name : "",
            arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
          };
        })
        .filter((call) => call.name);
    }
    messages.push(message);
  }
  if (messages.length === 0) throw new Error("в запросе нет ни одного сообщения кроме system");

  const tools: LlmTool[] = Array.isArray(body.tools)
    ? (body.tools as Array<Record<string, unknown>>)
        .map((tool) => {
          const fn = (tool.function ?? tool) as Record<string, unknown>;
          return {
            name: typeof fn.name === "string" ? fn.name : "",
            description: typeof fn.description === "string" ? fn.description : "",
            parameters: (fn.parameters as Record<string, unknown>) ?? { type: "object" },
          };
        })
        .filter((tool) => tool.name)
    : [];

  const model = typeof body.model === "string" ? body.model : "";
  const route = model.startsWith(MODEL_PREFIX)
    ? model.slice(MODEL_PREFIX.length).trim() || DEFAULT_ROUTE
    : DEFAULT_ROUTE;

  const metadata = body.metadata ?? {};
  return {
    messages,
    system_prompt: systemPrompt,
    tools,
    temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
    max_tokens: typeof body.max_tokens === "number" && body.max_tokens > 0
      ? Math.floor(body.max_tokens)
      : 2_000,
    stream: body.stream === true,
    response_format: (body.response_format?.type === "json_object")
      ? { type: "json_object" }
      : null,
    metadata: {
      request_id: routingClaims?.correlation_id && /^[0-9a-f-]{36}$/i.test(routingClaims.correlation_id)
        ? routingClaims.correlation_id
        : typeof metadata.request_id === "string" ? metadata.request_id : "",
      user_id: typeof metadata.user_id === "string"
        ? metadata.user_id
        : typeof body.user === "string" ? body.user : null,
      agent_id: typeof metadata.agent_id === "string" ? metadata.agent_id : null,
      route,
      requested_route: route,
      sensitive: metadata.sensitive !== false,
      purpose: routingClaims?.purpose ?? "chat",
      internal_operation_type: routingClaims?.internal_operation_type,
      user_mode: routingClaims?.user_mode ?? "auto",
      message_source: routingClaims?.message_source,
      // Изображение объявляет само содержимое: маркер приходит от
      // вызывающего, а картинка — это факт запроса.
      has_image: containsImage(messages) || routingClaims?.message_source === "image",
      has_document: routingClaims?.message_source === "document",
      has_voice: routingClaims?.message_source === "voice",
    },
  };
}

function toOpenAi(
  response: {
    content: string;
    tool_calls: Array<{ id: string; name: string; arguments: string }>;
    finish_reason: string;
    usage: { tokens_in: number; tokens_out: number };
    model: string;
    provider_state?: Record<string, unknown>;
  },
  result: { request_id: string; provider_name: string; switches: number },
) {
  return {
    id: `chatcmpl-${result.request_id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: response.content,
        // Служебные поля провайдера возвращаются вызывающему как есть:
        // на следующем ходе он обязан прислать их обратно вместе с
        // результатом инструмента, иначе reasoning-модель замолчит.
        ...(response.provider_state ?? {}),
        ...(response.tool_calls.length
          ? {
            tool_calls: response.tool_calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          }
          : {}),
      },
      finish_reason: response.finish_reason === "unknown" ? "stop" : response.finish_reason,
    }],
    usage: {
      prompt_tokens: response.usage.tokens_in,
      completion_tokens: response.usage.tokens_out,
      total_tokens: response.usage.tokens_in + response.usage.tokens_out,
    },
    // Служебные поля: кто фактически ответил. Требование 1.8 — фиксировать
    // фактического провайдера, но не сообщать о переключении пользователю.
    x_eva_router: {
      provider: result.provider_name,
      switches: result.switches,
      request_id: result.request_id,
    },
  };
}

function toOpenAiChunk(
  chunk: { type: string; delta?: string; call?: { id: string; name: string; arguments: string }; response?: { model: string } },
  request: LlmRequest,
) {
  const base = {
    id: `chatcmpl-${request.metadata.request_id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: chunk.response?.model ?? `${MODEL_PREFIX}${request.metadata.route}`,
  };
  if (chunk.type === "text") {
    return { ...base, choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null }] };
  }
  if (chunk.type === "tool_call" && chunk.call) {
    return {
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: chunk.call.id,
            type: "function",
            function: { name: chunk.call.name, arguments: chunk.call.arguments },
          }],
        },
        finish_reason: null,
      }],
    };
  }
  return { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
}
