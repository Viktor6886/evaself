/**
 * Зрение: почему картинка не доходила до модели и что теперь этому мешает.
 *
 * Letta ходит к роутеру коннектором LM Studio. Тот спрашивает модели
 * двумя способами: сначала нативным `/api/v0/models`, где у модели есть
 * тип и список возможностей, и только если он не ответил — обычным
 * `/v1/models`, где есть одни идентификаторы. Модель, найденная вторым
 * способом, считается текстовой, а App Server, собирая запрос к
 * провайдеру, заменяет каждое изображение строкой-заглушкой. Картинка не
 * доезжала даже до роутера, и Ева честно отвечала, что ничего не видела.
 *
 * Здесь проверяется обе стороны договора: что установленный App Server
 * по-прежнему решает так же, и что наш нативный каталог отвечает по
 * фактам цепочек, а не обещаниями.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createRouterServer } from "../dist/router/server.js";

const appServerBundle = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "@letta-ai",
  "letta-code",
  "letta.js",
);

test("установленный App Server по-прежнему решает зрение по каталогу", () => {
  const bundle = readFileSync(appServerBundle, "utf8");

  // Договор неписаный, поэтому он закреплён здесь: если следующая версия
  // App Server изменит любое из этих правил, тест покраснеет, и человек
  // перепроверит нативный каталог, а не узнает об этом от пользователя.
  assert.ok(
    bundle.includes("/api/v0/models"),
    "коннектор больше не спрашивает нативный каталог LM Studio",
  );
  assert.ok(
    bundle.includes('type === "vlm"'),
    "зрение больше не выводится из типа модели vlm",
  );
  assert.ok(
    bundle.includes('capabilities.includes("vision")'),
    "зрение больше не выводится из списка возможностей",
  );
  assert.ok(
    bundle.includes('input.includes("image")'),
    "передача изображений больше не зависит от input модели",
  );
  assert.ok(
    bundle.includes("(image omitted: model does not support images)"),
    "заглушка вместо изображения больше не подставляется",
  );
});

function surface(options: {
  chains: Map<string, string[]>;
  providers: Array<{ id: string; supports_vision: boolean; context_window: number }>;
}) {
  const routes = new Map([
    ["chat", { code: "chat" }],
    ["vision", { code: "vision" }],
  ]);
  return createRouterServer({
    apiKey: "test-key",
    logger: { info() {}, error() {}, warn() {}, debug() {} },
    store: {
      routes: async () => routes,
      chains: async () => options.chains,
      providers: async () => options.providers,
      breakers: async () => new Map(),
    },
    router: {
      complete: async () => { throw new Error("не используется"); },
      stream: async function* () { throw new Error("не используется"); },
    },
  } as never);
}

async function catalog(app: ReturnType<typeof surface>) {
  const response = await app.inject({
    method: "GET", url: "/api/v0/models", headers: { authorization: "Bearer test-key" },
  });
  assert.equal(response.statusCode, 200);
  const byId = new Map<string, Record<string, unknown>>(
    (JSON.parse(response.body).data as Array<Record<string, unknown>>)
      .map((entry) => [String(entry.id), entry]),
  );
  return byId;
}

test("зрячий провайдер в цепочке делает модель зрячей", async () => {
  const app = surface({
    chains: new Map([["chat", ["p-text"]], ["vision", ["p-eyes"]]]),
    providers: [
      { id: "p-text", supports_vision: false, context_window: 128_000 },
      { id: "p-eyes", supports_vision: true, context_window: 200_000 },
    ],
  });
  await app.ready();
  try {
    const models = await catalog(app);
    const chat = models.get("eva/chat")!;
    // Изображение уводится на маршрут зрения самим содержимым хода, какую
    // бы модель ни назвал вызывающий: цепочка chat своих глаз не имеет, а
    // ход с картинкой всё равно будет обслужен.
    assert.equal(chat.type, "vlm");
    assert.deepEqual(chat.capabilities, ["vision"]);
    assert.equal(chat.max_context_length, 128_000, "окно берётся из своей цепочки");
    assert.equal(models.get("eva/vision")!.type, "vlm");
  } finally {
    await app.close();
  }
});

test("без зрячего провайдера модель зрячей не объявляется", async () => {
  const app = surface({
    chains: new Map([["chat", ["p-text"]], ["vision", []]]),
    providers: [{ id: "p-text", supports_vision: false, context_window: 64_000 }],
  });
  await app.ready();
  try {
    const models = await catalog(app);
    // Обещать зрение, которого нет, — значит отправить картинку в модель,
    // которая её не примет, и получить отказ вместо честного «не вижу».
    assert.equal(models.get("eva/chat")!.type, "llm");
    assert.deepEqual(models.get("eva/chat")!.capabilities, []);
  } finally {
    await app.close();
  }
});

test("выключенный провайдер зрения не считается", async () => {
  const app = surface({
    // `providers()` отдаёт только включённых: выключенный остаётся в
    // цепочке, но обслужить ход не может.
    chains: new Map([["chat", ["p-text"]], ["vision", ["p-off"]]]),
    providers: [{ id: "p-text", supports_vision: false, context_window: 64_000 }],
  });
  await app.ready();
  try {
    assert.equal((await catalog(app)).get("eva/chat")!.type, "llm");
  } finally {
    await app.close();
  }
});

test("нативный каталог закрыт тем же ключом", async () => {
  const app = surface({
    chains: new Map(),
    providers: [],
  });
  await app.ready();
  try {
    const response = await app.inject({ method: "GET", url: "/api/v0/models" });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});
