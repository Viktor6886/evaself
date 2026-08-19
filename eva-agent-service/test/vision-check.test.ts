/**
 * Проверка распознавания медиа: настоящая картинка, настоящий путь.
 *
 * Наружу ничего не уходит — `fetch` подменяется, и тест видит ровно то
 * тело, которое ушло бы роутеру. Ценность проверки не в том, что модель
 * ответила, а в том, что ответ невозможно получить, не увидев картинку:
 * поэтому здесь проверяется и содержимое запроса, и разбор ответа.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";

import { runVisionCheck, solidPng } from "../dist/llm/vision-check.js";

const OPTIONS = { routerUrl: "http://router.invalid", routerApiKey: "router-key", timeoutMs: 2_000 };

/** Каталог, объявляющий зрение: без него App Server заменит картинку заглушкой. */
const SEEING_CATALOG = { data: [{ id: "eva/chat", type: "vlm", capabilities: ["vision"] }] };

/**
 * Подменённый fetch: тело запроса остаётся тесту, ответ задаёт тест.
 *
 * Проверка спрашивает роутер дважды — сначала нативный каталог, потом
 * сам ход с картинкой. В `sent` попадает только второй: он и есть путь
 * фотографии из Telegram.
 */
function stubFetch(payload: unknown, status = 200, catalog: unknown = SEEING_CATALOG) {
  const sent: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const catalogUrls: string[] = [];
  const fetcher = (async (url: unknown, init: RequestInit = {}) => {
    if (String(url).endsWith("/api/v0/models")) {
      catalogUrls.push(String(url));
      if (catalog === null) throw new Error("каталог недоступен");
      return new Response(JSON.stringify(catalog), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    sent.push({
      url: String(url),
      body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { sent, catalogUrls, fetcher };
}

function answer(content: string, router: Record<string, unknown> = { provider: "vision-1", route: "vision", switches: 0 }) {
  return {
    model: "gpt-vision",
    choices: [{ message: { content }, finish_reason: "stop" }],
    x_eva_router: router,
  };
}

test("тестовая картинка — настоящий PNG заданного цвета", () => {
  const png = solidPng(4, 3, [0x2f, 0xa8, 0x4a]);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), 4);
  assert.equal(png.readUInt32BE(20), 3);

  // Пиксели действительно того цвета, про который спрашивают модель:
  // разъехавшийся цвет превратил бы проверку в лотерею.
  const start = png.indexOf(Buffer.from("IDAT", "ascii"));
  const length = png.readUInt32BE(start - 4);
  const raw = inflateSync(png.subarray(start + 4, start + 4 + length));
  assert.equal(raw.length, 3 * (4 * 3 + 1));
  assert.equal(raw[0], 0, "фильтр строки нулевой");
  assert.deepEqual([...raw.subarray(1, 4)], [0x2f, 0xa8, 0x4a]);
});

test("запрос уходит тем же путём, что и фотография из Telegram", async () => {
  const stub = stubFetch(answer("зелёный"));
  const result = await runVisionCheck({ ...OPTIONS, fetcher: stub.fetcher });

  const request = stub.sent[0]!;
  assert.equal(request.url, "http://router.invalid/chat/completions");
  assert.equal(request.headers.authorization, "Bearer router-key");
  // Указатель модели тот же, что у агента: маршрут выбирает роутер.
  // Явный `eva/vision` проверял бы провайдера в обход того решения,
  // которое и ломалось.
  assert.equal(request.body.model, "eva/chat");
  const content = (request.body.messages as Array<{ content: Array<Record<string, any>> }>)[0]!.content;
  assert.equal(content[0]!.type, "text");
  assert.equal(content[1]!.type, "image_url");
  assert.match(String(content[1]!.image_url.url), /^data:image\/png;base64,iVBORw0KGgo/);
  assert.equal(result.recognized, true);
  assert.equal(result.provider, "vision-1");
  assert.equal(result.route, "vision");
  assert.equal(result.error, null);
});

test("ответ обычной модели на запрос с картинкой — это отказ, а не успех", async () => {
  // Ровно тот дефект, ради которого проверка написана: картинка теряется
  // по дороге, запрос уходит обычным чатом, модель отвечает уверенно.
  const stub = stubFetch(answer("зелёный", { provider: "chat-1", route: "chat", switches: 0 }));
  const result = await runVisionCheck({ ...OPTIONS, fetcher: stub.fetcher });
  assert.equal(result.ok, true);
  assert.equal(result.recognized, false);
  assert.match(String(result.error), /vision/);
});

test("модель, не увидевшая изображения, проверку не проходит", async () => {
  const stub = stubFetch(answer("Я не вижу изображения."));
  const result = await runVisionCheck({ ...OPTIONS, fetcher: stub.fetcher });
  assert.equal(result.ok, true);
  assert.equal(result.recognized, false);
  assert.equal(result.answer, "Я не вижу изображения.");
});

test("цвет засчитывается и по-английски, и с падежным окончанием", async () => {
  for (const text of ["Зелёный.", "зеленый", "The image is green.", "verde"]) {
    const stub = stubFetch(answer(text));
    const result = await runVisionCheck({ ...OPTIONS, fetcher: stub.fetcher });
    assert.equal(result.recognized, true, text);
  }
});

test("отказ роутера возвращается фактом, а не исключением", async () => {
  const stub = stubFetch({ error: { message: "нет провайдера" } }, 503);
  const result = await runVisionCheck({ ...OPTIONS, fetcher: stub.fetcher });
  assert.equal(result.ok, false);
  assert.equal(result.recognized, false);
  assert.match(String(result.error), /503/);
});

test("без ключа роутера проверка не ходит в сеть", async () => {
  const stub = stubFetch(answer("зелёный"));
  const result = await runVisionCheck({ ...OPTIONS, routerApiKey: "", fetcher: stub.fetcher });
  assert.equal(stub.sent.length, 0);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /EVA_ROUTER_API_KEY/);
});

test("зрение без объявления в каталоге не засчитывается", async () => {
  // Ровно то состояние, в котором Ева отвечала, что картинок не видит:
  // роутер картинку принимает и цвет называет, а App Server считает
  // модель текстовой и заменяет изображение заглушкой.
  const stub = stubFetch(answer("зелёный"), 200, {
    data: [{ id: "eva/chat", type: "llm", capabilities: [] }],
  });
  const result = await runVisionCheck({ ...OPTIONS, fetcher: stub.fetcher });

  assert.equal(stub.catalogUrls[0], "http://router.invalid/api/v0/models");
  assert.equal(result.catalog_vision, false);
  assert.equal(result.ok, true, "ответ модели получен");
  assert.equal(result.recognized, false, "проверка не должна быть зелёной");
  assert.match(String(result.error), /каталог/);
});

test("недоступный каталог виден как «не могу подтвердить»", async () => {
  const stub = stubFetch(answer("зелёный"), 200, null);
  const result = await runVisionCheck({ ...OPTIONS, fetcher: stub.fetcher });
  assert.equal(result.catalog_vision, null);
  assert.equal(result.recognized, false);
});
