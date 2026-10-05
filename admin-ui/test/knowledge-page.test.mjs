/**
 * Раздел «База знаний»: общая база документов для всех пользователей.
 *
 * Проверяется то, что видит и делает администратор: коллекции и
 * документы приходят с сервера и показываются со статусами; файлы
 * уходят multipart-запросом в выбранную коллекцию; массовое удаление
 * спрашивает подтверждение и отправляет выбранные id; читающая роль не
 * получает ни загрузки, ни кнопок изменения; личные базы — только числа.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { openPanel, PHONE, smallTapTargets } from "./harness.mjs";

const COLLECTION = { id: "1c000000-0000-4000-8000-000000000001", code: "faq", title: "FAQ", description: "Частые вопросы",
  enabled: true, position: 0, documents: 2, indexed: 1, failed: 1, chunks: 12, created_at: "2026-09-30T10:00:00Z", updated_at: "2026-09-30T10:00:00Z" };
const DOCS = [
  { id: "0a000000-0000-4000-8000-00000000000a", collection_id: COLLECTION.id, name: "Регламент.pdf", mime: "application/pdf",
    size_bytes: 204800, chunk_count: 8, status: "ready", index_status: "ready", index_error: null, revision: 2,
    created_at: "2026-09-30T10:00:00Z", updated_at: "2026-09-30T11:00:00Z" },
  { id: "0b000000-0000-4000-8000-00000000000b", collection_id: COLLECTION.id, name: "FAQ.md", mime: "text/markdown",
    size_bytes: 2048, chunk_count: 4, status: "ready", index_status: "failed", index_error: "qdrant_unavailable", revision: 1,
    created_at: "2026-09-30T10:00:00Z", updated_at: "2026-09-30T10:05:00Z" },
];
const UPLOADS = [
  { id: "0c000000-0000-4000-8000-00000000000c", collection_id: COLLECTION.id, name: "Копия.pdf", mime: "application/pdf",
    size_bytes: 204800, status: "ready", outcome: "duplicate", error_code: null, created_at: "2026-09-30T11:00:00Z" },
  { id: "0d000000-0000-4000-8000-00000000000d", collection_id: COLLECTION.id, name: "Битый.pdf", mime: "application/pdf",
    size_bytes: 10, status: "failed", outcome: null, error_code: "document_empty", created_at: "2026-09-30T11:05:00Z" },
];
const INDEX = {
  qdrant: true,
  qdrant_status: "ready", aliases: { private: null, global: null }, aliases_match_active: true, uploads_enabled: true,
  private_owners: 3,
  scopes: {
    private: { documents: 7, chunks: 70, lag_seconds: 0, by_status: { ready: 7 } },
    global: { documents: 2, chunks: 12, lag_seconds: 0, by_status: { ready: 1, failed: 1 } },
  },
  versions: [{ version: 2, model: "bge-m3", dimension: 1024, status: "ready", error_code: null, building: false,
    build_started_at: "2026-09-30T09:00:00Z", built_at: "2026-09-30T09:10:00Z", activated_at: null, points: 82, progress: 1 }],
};

const PROVIDERS = [{ id: "p1", name: "OpenRouter", chat_model: "openai/gpt-5" }, { id: "p2", name: "Jina", chat_model: "jina-chat" }];
const VERSION = { ...INDEX.versions[0], provider_id: "p1", provider_name: "OpenRouter", request_dimensions: false,
  distance: "Cosine", hnsw_m: 16, hnsw_ef_construct: 100, on_disk: false, fallback_provider_id: null, fallback_model: null };
const EMBEDDINGS = { providers: PROVIDERS, versions: [VERSION], active: null };
const RECOMMENDED = {
  "runtime.knowledge_index_enabled": true, "runtime.knowledge_search_enabled": true,
  "runtime.knowledge_search_mode": "hybrid", "runtime.knowledge_vector_backend": "qdrant",
  "runtime.knowledge_private_enabled": true, "runtime.knowledge_global_enabled": true,
};
const UPLOAD_SETTING = { key: "runtime.knowledge_uploads_enabled", title: "База знаний: загрузка файлов", value: true };
const SETTINGS = { etag: '"kb-1"', settings: [UPLOAD_SETTING, ...Object.entries(RECOMMENDED).map(([key, value]) => ({ key, title: key,
  value: key.endsWith("search_mode") ? "legacy" : key.endsWith("vector_backend") ? "pgvector" : value,
  presets: typeof value === "boolean" ? undefined : (key.endsWith("search_mode") ? ["legacy", "hybrid", "vector", "lexical"] : ["pgvector", "qdrant"]).map((v) => ({ value: v, title: v })),
}))] };
const ACTIVE = { ...VERSION, status: "active", activated_at: "2026-09-30T10:00:00Z" };
const ACTIVE_ROUTES = {
  "/knowledge/embeddings": { ...EMBEDDINGS, active: 2, versions: [ACTIVE] },
  "/knowledge/index": { ...INDEX, aliases: { private: 2, global: 2 }, versions: [ACTIVE] },
};

const ROUTES = {
  "/knowledge/collections": { collections: [COLLECTION] },
  "/knowledge/documents": { documents: DOCS, total: 2 },
  "/knowledge/uploads": { uploads: UPLOADS },
  "/knowledge/index": INDEX,
  "/knowledge/embeddings": EMBEDDINGS,
  "/settings": SETTINGS,
};

test("раздел показывает коллекции, документы со статусами, исход загрузок и счётчики личных баз", async () => {
  const panel = await openPanel({ routes: ROUTES });
  try {
    await panel.page.click('[data-page="knowledge"]');
    await panel.page.waitForSelector('[data-document-row]');
    const collections = await panel.page.textContent("#knowledge-collections");
    assert.match(collections, /FAQ/);
    const documents = await panel.page.textContent("#knowledge-documents");
    assert.match(documents, /Регламент\.pdf/);
    assert.match(documents, /v2/);
    assert.match(documents, /ошибка индексации/);
    assert.match(documents, /qdrant_unavailable/);
    const uploads = await panel.page.textContent("#knowledge-uploads");
    assert.match(uploads, /дубликат/);
    assert.match(uploads, /document_empty/);
    const index = await panel.page.textContent("#knowledge-index");
    assert.match(index, /людей: 3/);
    assert.match(index, /Активировать/);
    assert.deepEqual(panel.errors, []);
  } finally {
    await panel.close();
  }
});

test("загрузка: файлы уходят multipart в выбранную коллекцию, формат вне списка не отправляется", async () => {
  const panel = await openPanel({
    routes: { ...ROUTES, "POST /knowledge/uploads": { id: "u1", status: "queued" } },
  });
  try {
    await panel.page.click('[data-page="knowledge"]');
    await panel.page.waitForSelector("#knowledge-upload-button:not([disabled])");
    const uploads = [];
    panel.page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/knowledge/uploads")) uploads.push({ url: req.url(), body: req.postData() || "" });
    });
    await panel.page.setInputFiles("#knowledge-file", [
      { name: "Регламент.md", mimeType: "text/markdown", buffer: Buffer.from("# Регламент") },
      { name: "вирус.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ") },
    ]);
    await panel.page.waitForFunction(() => /Принято 1 из 2/.test(document.getElementById("knowledge-upload-progress")?.textContent || ""));
    assert.equal(uploads.length, 1, "exe не отправляется");
    assert.match(uploads[0].url, new RegExp(`collection_id=${COLLECTION.id}`));
    assert.match(uploads[0].body, /name="file"; filename=/);
  } finally {
    await panel.close();
  }
});

test("загрузка включается на телефоне, кнопка открывает выбор файла; настройка переживает reload без Qdrant", async () => {
  let enabled = false;
  let version = 1;
  const settings = () => ({ ...SETTINGS, etag: `"cfg-${version}"`, settings: SETTINGS.settings.map((s) =>
    s.key === UPLOAD_SETTING.key ? { ...s, value: enabled } : s) });
  const panel = await openPanel({ viewport: PHONE, routes: { ...ROUTES,
    "/settings": settings,
    "/knowledge/index": () => ({ ...INDEX, qdrant: false, qdrant_status: "not_configured", uploads_enabled: enabled, uploads_worker_enabled: true }),
    "PUT /settings": () => {
      const change = panel.requests.at(-1).body.settings;
      assert.deepEqual(Object.keys(change), [UPLOAD_SETTING.key], "включение загрузки не меняет режим поиска");
      enabled = change[UPLOAD_SETTING.key];
      version += 1;
      return settings();
    },
    "POST /knowledge/uploads": { id: "u1", status: "queued" },
  } });
  try {
    await panel.page.evaluate(() => document.querySelector('[data-page="knowledge"]').click());
    await panel.page.waitForSelector("#knowledge-upload-toggle:not([hidden])");
    assert.equal(await panel.page.isDisabled("#knowledge-upload-button"), true);
    assert.match(await panel.page.textContent("#knowledge-upload-availability"), /Загрузка файлов выключена/);
    // Сервер входа выдаёт отдельную читаемую CSRF-cookie; мок /me её не ставит.
    await panel.page.evaluate(() => { document.cookie = "eva_admin_csrf=test-csrf; Path=/; SameSite=Strict"; });
    let headers;
    panel.page.on("request", (r) => { if (r.method() === "PUT") headers = r.headers(); });
    await panel.page.click("#knowledge-upload-toggle");
    await panel.page.waitForSelector("#knowledge-upload-button:not([disabled])");
    assert.equal(headers["if-match"], '"cfg-1"');
    assert.equal(headers["x-csrf-token"], "test-csrf");
    assert.equal(await panel.page.isDisabled("#knowledge-file"), false);
    const chooserPromise = panel.page.waitForEvent("filechooser");
    await panel.page.click("#knowledge-upload-button");
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: "Психология.md", mimeType: "text/markdown", buffer: Buffer.from("# Прокрастинация\nСложную задачу можно разделить на шаги.") });
    const upload = await panel.waitForRequest((r) => r.path === "/knowledge/uploads" && r.method === "POST");
    assert.match(upload.search, new RegExp(`collection_id=${COLLECTION.id}`));
    assert.match(upload.body, /Психология\.md/);
    await panel.page.waitForFunction(() => /Принято 1 из 1/.test(document.querySelector("#knowledge-upload-progress")?.textContent));
    await panel.page.reload();
    await panel.page.waitForSelector("#knowledge-upload-button:not([disabled])");
    assert.equal(await panel.page.textContent("#knowledge-upload-toggle"), "Выключить загрузку");
    assert.match(await panel.page.textContent("#knowledge-upload-availability"), /Загрузка включена/);
    await panel.page.click("#knowledge-upload-toggle");
    await panel.page.waitForSelector("#knowledge-upload-button[disabled]");
    assert.equal(enabled, false);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("причина блокировки видна рядом с кнопкой: нет коллекции, нет обработчика или статус недоступен", async () => {
  for (const scenario of [
    { routes: { "/knowledge/collections": { collections: [] } }, message: /Сначала создайте коллекцию/, toggleDisabled: false },
    { routes: { "/knowledge/index": { ...INDEX, uploads_enabled: false, uploads_worker_enabled: false } }, message: /EVA_BULLMQ_JOBS/, toggleDisabled: true },
    { routes: { "/knowledge/index": { __status: 503, __body: { error: { message: "недоступно" } } } }, message: /Нажмите «Обновить»/, toggleDisabled: true },
    { routes: { "/knowledge/index": { ...INDEX, uploads_enabled: false }, "/settings": { __status: 503, __body: { error: { message: "недоступно" } } } }, message: /настройка для включения недоступна/, toggleDisabled: true },
  ]) {
    const panel = await openPanel({ routes: { ...ROUTES, ...scenario.routes } });
    try {
      await panel.page.click('[data-page="knowledge"]');
      await panel.page.waitForSelector("#knowledge-embedding-form");
      assert.equal(await panel.page.isDisabled("#knowledge-upload-button"), true);
      assert.equal(await panel.page.isDisabled("#knowledge-file"), true);
      assert.match(await panel.page.textContent("#knowledge-upload-availability"), scenario.message);
      assert.equal(await panel.page.isDisabled("#knowledge-upload-toggle"), scenario.toggleDisabled);
      assert.deepEqual(panel.errors, []);
    } finally { await panel.close(); }
  }
});

test("отказ сохранения не включает загрузку в DOM и не отправляет файлы перетаскиванием", async () => {
  const panel = await openPanel({ routes: { ...ROUTES,
    "/knowledge/index": { ...INDEX, uploads_enabled: false },
    "PUT /settings": { __status: 409, __body: { error: { message: "Настройки изменены другим администратором" } } },
  } });
  try {
    await panel.page.click('[data-page="knowledge"]');
    await panel.page.waitForSelector("#knowledge-upload-toggle:not([hidden])");
    await panel.page.click("#knowledge-upload-toggle");
    await panel.waitForRequest((r) => r.path === "/settings" && r.method === "PUT");
    await panel.page.waitForSelector("#knowledge-upload-toggle:not([disabled])");
    assert.equal(await panel.page.isDisabled("#knowledge-upload-button"), true);
    await panel.page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["# Психология"], "психология.md", { type: "text/markdown" }));
      document.querySelector("#knowledge-drop").dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    });
    assert.equal(panel.requests.filter((r) => r.path === "/knowledge/uploads" && r.method === "POST").length, 0);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("массовое удаление: только после подтверждения и только выбранные документы", async () => {
  const panel = await openPanel({
    routes: { ...ROUTES, "POST /knowledge/documents/delete": { deleted: [DOCS[1].id] } },
  });
  try {
    await panel.page.click('[data-page="knowledge"]');
    await panel.page.waitForSelector(`[data-document-select="${DOCS[1].id}"]`);
    await panel.page.check(`[data-document-select="${DOCS[1].id}"]`);
    assert.match(await panel.page.textContent("#knowledge-bulk-count"), /Выбрано: 1/);
    await panel.page.click("#knowledge-bulk-delete");
    await panel.page.waitForFunction(() => document.querySelector("#confirm-dialog")?.open === true);
    assert.equal(panel.countTo("/knowledge/documents/delete"), 0, "до подтверждения ничего не удаляется");
    await panel.page.click('#confirm-form button[value="confirm"]');
    const request = await panel.waitForRequest((item) => item.path === "/knowledge/documents/delete");
    assert.deepEqual(request.body, { ids: [DOCS[1].id] });
  } finally {
    await panel.close();
  }
});

test("читающая роль видит базу, но не может ничего загрузить или изменить", async () => {
  const panel = await openPanel({ role: "viewer", routes: ROUTES });
  try {
    await panel.page.click('[data-page="knowledge"]');
    await panel.page.waitForSelector("[data-document-row]");
    assert.equal(await panel.page.isVisible("#knowledge-upload"), false);
    assert.equal(await panel.page.locator("[data-collection-delete], [data-document-select], [data-version-build], #knowledge-reconcile, #knowledge-collection-form").count(), 0);
    assert.equal(await panel.page.isVisible("#knowledge-bulk"), false);
  } finally {
    await panel.close();
  }
});

test("на телефоне раздел без горизонтальной прокрутки и с крупными кнопками", async () => {
  const panel = await openPanel({ routes: ROUTES, viewport: PHONE });
  try {
    await panel.page.evaluate(() => document.querySelector('[data-page="knowledge"]').click());
    await panel.page.waitForSelector("[data-document-row]");
    const width = await panel.page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= PHONE.width, `ширина ${width}`);
    assert.deepEqual(await smallTapTargets(panel.page), []);
  } finally {
    await panel.close();
  }
});

const SECOND = { ...COLLECTION, id: "2c000000-0000-4000-8000-000000000002", code: "rules", title: "Регламенты", documents: 0, indexed: 0, failed: 0 };

test("выбранная коллекция загрузки переживает перерисовку, и следующий файл уходит в неё", async () => {
  const panel = await openPanel({
    routes: { ...ROUTES, "/knowledge/collections": { collections: [COLLECTION, SECOND] }, "POST /knowledge/uploads": { id: "u1", status: "queued" } },
  });
  try {
    await panel.page.click('[data-page="knowledge"]');
    await panel.page.waitForSelector("#knowledge-upload-button:not([disabled])");
    await panel.page.selectOption("#knowledge-upload-collection", SECOND.id);
    // Перерисовка: «Обновить» — то же, что опрос и перезагрузка после файла.
    await panel.page.click("#reload-knowledge");
    await panel.waitForRequest((item) => item.path === "/knowledge/collections" && panel.countTo("/knowledge/collections") >= 2);
    await panel.page.waitForTimeout(100);
    assert.equal(await panel.page.inputValue("#knowledge-upload-collection"), SECOND.id);

    const uploads = [];
    panel.page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/knowledge/uploads")) uploads.push(req.url());
    });
    await panel.page.setInputFiles("#knowledge-file", [
      { name: "первый.md", mimeType: "text/markdown", buffer: Buffer.from("# 1") },
    ]);
    await panel.page.waitForFunction(() => /Принято 1 из 1/.test(document.getElementById("knowledge-upload-progress")?.textContent || ""));
    await panel.page.setInputFiles("#knowledge-file", [
      { name: "второй.md", mimeType: "text/markdown", buffer: Buffer.from("# 2") },
    ]);
    await panel.page.waitForFunction(() => /второй|Принято 1 из 1/.test(document.getElementById("knowledge-upload-progress")?.textContent || ""));
    await panel.page.waitForTimeout(200);
    assert.equal(uploads.length, 2);
    for (const url of uploads) assert.match(url, new RegExp(`collection_id=${SECOND.id}`), "файл ушёл не в выбранную коллекцию");
  } finally {
    await panel.close();
  }
});

test("недоступное состояние индекса не прячет коллекции и документы", async () => {
  const panel = await openPanel({ routes: { ...ROUTES, "/knowledge/index": { __status: 503, __body: { error: { code: "unavailable", message: "нет" } } } } });
  try {
    await panel.page.click('[data-page="knowledge"]');
    await panel.page.waitForSelector("[data-document-row]");
    assert.match(await panel.page.textContent("#knowledge-collections"), /FAQ/);
    assert.match(await panel.page.textContent("#knowledge-index"), /недоступны/);
  } finally {
    await panel.close();
  }
});

test("«Показать ещё» запрашивает следующую порцию документов", async () => {
  const panel = await openPanel({ routes: { ...ROUTES, "/knowledge/documents": { documents: DOCS, total: 120 } } });
  try {
    await panel.page.click('[data-page="knowledge"]');
    await panel.page.waitForSelector("#knowledge-more:not([hidden])");
    await panel.page.click("#knowledge-more");
    const request = await panel.waitForRequest((item) => item.path === "/knowledge/documents" && /limit=100/.test(item.search));
    assert.ok(request);
  } finally {
    await panel.close();
  }
});

async function enterKnowledge(panel) {
  await panel.page.click('[data-page="knowledge"]');
  await panel.page.waitForSelector("#knowledge-embedding-form");
}

test("embedding: реестр провайдеров и активная модель видны на одном экране без секретов", async () => {
  const panel = await openPanel({ routes: { ...ROUTES, ...ACTIVE_ROUTES } });
  try {
    await enterKnowledge(panel);
    assert.equal(panel.countTo("/knowledge/embeddings"), 1);
    assert.deepEqual(await panel.page.locator('#knowledge-embedding-form [name="provider_id"] option').allTextContents(), ["Выберите провайдера", "OpenRouter", "Jina"]);
    const active = await panel.page.textContent("#knowledge-active-embedding");
    for (const text of ["v2", "OpenRouter", "bge-m3", "1024", "активен"]) assert.ok(active.includes(text));
    assert.match(await panel.page.textContent("#knowledge-status"), /pgvector \(режим legacy\)/);
    assert.equal(await panel.page.locator('#knowledge-embedding-form [name="api_key"], #knowledge-embedding-form [name="base_url"]').count(), 0);
    assert.equal(await panel.page.inputValue('#knowledge-embedding-form [name="model"]'), "bge-m3");
    assert.equal(await panel.page.inputValue('#knowledge-embedding-form [name="dimension"]'), "1024");
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("embedding: проверка показывает размерность и latency; изменение модели отменяет результат", async () => {
  const panel = await openPanel({ routes: { ...ROUTES,
    "POST /knowledge/embeddings/probe": { ok: true, dimension: 768, latency_ms: 73 },
  } });
  try {
    await enterKnowledge(panel);
    await panel.page.selectOption("#knowledge-embedding-configuration", "");
    await panel.page.selectOption('#knowledge-embedding-form [name="provider_id"]', "p2");
    await panel.page.fill('#knowledge-embedding-form [name="model"]', "jina-embeddings-v3");
    assert.equal(await panel.page.isDisabled("#knowledge-embedding-save"), true);
    await panel.page.click("#knowledge-embedding-probe");
    await panel.page.waitForSelector("#knowledge-embedding-save:not([disabled])");
    const result = await panel.page.textContent("#knowledge-embedding-probe-result");
    assert.match(result, /Модель доступна.*768.*73 мс/);
    const request = await panel.waitForRequest((r) => r.path === "/knowledge/embeddings/probe");
    assert.deepEqual(request.body, { provider_id: "p2", model: "jina-embeddings-v3", dimension: null, request_dimensions: false,
      distance: "Cosine", hnsw_m: 16, hnsw_ef_construct: 100, on_disk: false, fallback_provider_id: null, fallback_model: null });
    await panel.page.fill('#knowledge-embedding-form [name="model"]', "other-model");
    assert.equal(await panel.page.isDisabled("#knowledge-embedding-save"), true);
    assert.equal(panel.countTo("/knowledge/embeddings/versions"), 0);
  } finally { await panel.close(); }
});

test("embedding: читаемый отказ probe и несовместимый fallback не разрешают сохранить", async () => {
  let answer = { ok: false, message: "Провайдер отклонил ключ", error_code: "embedding_auth" };
  const panel = await openPanel({ routes: { ...ROUTES, "POST /knowledge/embeddings/probe": () => answer } });
  try {
    await enterKnowledge(panel);
    await panel.page.click("#knowledge-embedding-probe");
    await panel.page.waitForFunction(() => document.querySelector("#knowledge-embedding-probe-result").textContent.includes("отклонил ключ"));
    assert.equal(await panel.page.isDisabled("#knowledge-embedding-save"), true);
    answer = { ok: true, dimension: 1024, latency_ms: 9, compare: { ok: true, same_space: false } };
    await panel.page.click("#knowledge-embedding-probe");
    await panel.page.waitForFunction(() => document.querySelector("#knowledge-embedding-probe-result").textContent.includes("несовместим"));
    assert.equal(await panel.page.isDisabled("#knowledge-embedding-save"), true);
    assert.equal(panel.countTo("/knowledge/embeddings/versions"), 0);
  } finally { await panel.close(); }
});

test("embedding: версия сохраняется серверно, восстанавливается после reload и строится через прежний маршрут", async () => {
  let created = null;
  const panel = await openPanel({ routes: { ...ROUTES,
    "/knowledge/embeddings": () => ({ ...EMBEDDINGS, versions: created ? [created, VERSION] : [VERSION] }),
    "/knowledge/index": () => ({ ...INDEX, versions: created ? [created, VERSION] : [VERSION] }),
    "POST /knowledge/embeddings/probe": { ok: true, dimension: 768, latency_ms: 20 },
    "POST /knowledge/embeddings/versions": () => (created = { ...VERSION, version: 3, provider_id: "p2", provider_name: "Jina", model: "jina-embeddings-v3", dimension: 768,
      status: "draft", building: false, build_started_at: null, built_at: null, activated_at: null, points: null, progress: null }),
    "POST /knowledge/embeddings/versions/3/build": { version: 3, status: "building" },
  } });
  try {
    await enterKnowledge(panel);
    await panel.page.selectOption("#knowledge-embedding-configuration", "");
    await panel.page.selectOption('#knowledge-embedding-form [name="provider_id"]', "p2");
    await panel.page.fill('#knowledge-embedding-form [name="model"]', "jina-embeddings-v3");
    await panel.page.click("#knowledge-embedding-probe");
    await panel.page.waitForSelector("#knowledge-embedding-save:not([disabled])");
    await panel.page.click("#knowledge-embedding-save");
    await panel.page.waitForSelector('[data-version-build="3"]');
    const save = panel.requests.find((r) => r.path === "/knowledge/embeddings/versions");
    assert.equal(save.body.provider_id, "p2");
    assert.equal(save.body.model, "jina-embeddings-v3");
    assert.equal(await panel.page.locator('[data-version-activate="3"]').count(), 0, "черновик не активируется");
    await panel.page.reload();
    await enterKnowledge(panel);
    assert.equal(await panel.page.inputValue('#knowledge-embedding-form [name="provider_id"]'), "p2");
    assert.equal(await panel.page.inputValue('#knowledge-embedding-form [name="model"]'), "jina-embeddings-v3");
    assert.equal(await panel.page.inputValue('#knowledge-embedding-form [name="dimension"]'), "768");
    assert.equal(await panel.page.isDisabled("#knowledge-embedding-save"), true, "повторная проверка перед новой версией");
    assert.equal(await panel.page.isDisabled("#knowledge-embedding-probe"), false);
    await panel.page.click('[data-version-build="3"]');
    assert.equal(panel.countTo("/versions/3/build"), 0);
    await panel.confirmAccept();
    assert.equal(panel.countTo("/versions/3/build"), 1);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("embedding: первая активация требует подтверждения, незавершённую версию активировать нельзя", async () => {
  const unfinished = { ...VERSION, version: 4, status: "ready", built_at: null, building: true };
  const panel = await openPanel({ routes: { ...ROUTES,
    "/knowledge/embeddings": { ...EMBEDDINGS, versions: [unfinished, VERSION] },
    "/knowledge/index": { ...INDEX, versions: [unfinished, VERSION] },
    "POST /knowledge/embeddings/versions/2/activate": { version: 2, status: "active" },
  } });
  try {
    await enterKnowledge(panel);
    assert.equal(await panel.page.locator('[data-version-activate="4"]').count(), 0);
    await panel.page.click('[data-version-activate="2"]');
    assert.equal(panel.countTo("/versions/2/activate"), 0);
    await panel.confirmAccept();
    assert.deepEqual(panel.requests.find((r) => r.path.endsWith("/2/activate")).body, { expected_active_version: null });
    assert.equal(panel.requests.filter((r) => r.method === "PUT" && r.path === "/settings").length, 0, "активация не меняет режим поиска");
  } finally { await panel.close(); }
});

test("embedding: смена модели и откат доступны только построенным версиям", async () => {
  const ready = { ...VERSION, version: 3, model: "new-model" };
  const retired = { ...VERSION, version: 1, status: "retired" };
  const panel = await openPanel({ routes: { ...ROUTES, ...ACTIVE_ROUTES,
    "/knowledge/embeddings": { ...EMBEDDINGS, active: 2, versions: [ready, ACTIVE, retired] },
    "/knowledge/index": { ...ACTIVE_ROUTES["/knowledge/index"], versions: [ready, ACTIVE, retired] },
    "POST /knowledge/embeddings/versions/3/activate": { version: 3, status: "active" },
  } });
  try {
    await enterKnowledge(panel);
    assert.match(await panel.page.textContent('[data-version-activate="3"]'), /Активировать новую модель/);
    assert.match(await panel.page.textContent('[data-version-activate="1"]'), /Откатить/);
    await panel.page.click('[data-version-activate="3"]');
    await panel.confirmAccept();
    assert.deepEqual(panel.requests.find((r) => r.path.endsWith("/3/activate")).body, { expected_active_version: 2 });
  } finally { await panel.close(); }
});

test("hybrid + qdrant включается явно после серверной проверки; сохраняются все шесть настроек и etag", async () => {
  const panel = await openPanel({ routes: { ...ROUTES, ...ACTIVE_ROUTES,
    "POST /knowledge/embeddings/versions/2/activate": { version: 2, status: "active" }, "PUT /settings": { saved: true },
  } });
  try {
    await enterKnowledge(panel);
    assert.equal(panel.requests.filter((r) => r.method === "PUT").length, 0);
    let etag;
    panel.page.on("request", (r) => { if (r.method() === "PUT") etag = r.headers()["if-match"]; });
    await panel.page.click("#knowledge-use-qdrant");
    const saved = await panel.waitForRequest((r) => r.path === "/settings" && r.method === "PUT");
    assert.deepEqual(saved.body, { settings: RECOMMENDED });
    assert.equal(etag, SETTINGS.etag);
    const verify = panel.requests.findIndex((r) => r.path.endsWith("/2/activate"));
    assert.deepEqual(panel.requests[verify].body, { verify_only: true }, "проверка не переключит устаревшую версию");
    assert.ok(verify < panel.requests.indexOf(saved));
  } finally { await panel.close(); }
});

test("Qdrant нельзя включить без активного индекса или при отказе серверной проверки", async () => {
  const panel = await openPanel({ routes: { ...ROUTES } });
  try {
    await enterKnowledge(panel);
    assert.equal(await panel.page.isDisabled("#knowledge-use-qdrant"), true);
    await panel.page.selectOption('[data-knowledge-setting="runtime.knowledge_vector_backend"]', "qdrant");
    await panel.page.click("#knowledge-runtime-save");
    await panel.page.waitForTimeout(100);
    assert.equal(panel.requests.filter((r) => r.method === "PUT").length, 0);
  } finally { await panel.close(); }
  const failed = await openPanel({ routes: { ...ROUTES, ...ACTIVE_ROUTES,
    "POST /knowledge/embeddings/versions/2/activate": { __status: 409, __body: { error: { message: "Индекс неполон" } } },
  } });
  try {
    await enterKnowledge(failed);
    await failed.page.click("#knowledge-use-qdrant");
    await failed.waitForRequest((r) => r.path.endsWith("/2/activate"));
    await failed.page.waitForTimeout(100);
    assert.equal(failed.requests.filter((r) => r.method === "PUT").length, 0);
  } finally { await failed.close(); }
});

test("отказ Qdrant не мешает выключить поиск и приостановить индексацию", async () => {
  const panel = await openPanel({ routes: { ...ROUTES, ...ACTIVE_ROUTES,
    "/settings": { ...SETTINGS, settings: SETTINGS.settings.map((s) => ({ ...s, value: RECOMMENDED[s.key] ?? s.value })) },
    "/knowledge/index": { ...ACTIVE_ROUTES["/knowledge/index"], qdrant_status: "unavailable", aliases: null, aliases_match_active: null },
    "PUT /settings": { saved: true },
  } });
  try {
    await enterKnowledge(panel);
    assert.equal(await panel.page.isDisabled("#knowledge-use-qdrant"), true);
    await panel.page.selectOption('[data-knowledge-setting="runtime.knowledge_search_enabled"]', "false");
    await panel.page.selectOption('[data-knowledge-setting="runtime.knowledge_index_enabled"]', "false");
    await panel.page.click("#knowledge-runtime-save");
    const saved = await panel.waitForRequest((r) => r.path === "/settings" && r.method === "PUT");
    assert.deepEqual(saved.body, { settings: { ...RECOMMENDED, "runtime.knowledge_search_enabled": false, "runtime.knowledge_index_enabled": false } });
    assert.equal(panel.requests.filter((r) => r.path.endsWith("/activate")).length, 0);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("недоступный реестр или выключенная загрузка видны; читающая роль не получает формы настройки", async () => {
  const panel = await openPanel({ routes: { ...ROUTES,
    "/knowledge/embeddings": { __status: 503, __body: { error: { message: "Router недоступен" } } },
    "/knowledge/index": { ...INDEX, uploads_enabled: false },
  } });
  try {
    await panel.page.click('[data-page="knowledge"]');
    await panel.page.waitForSelector("[data-document-row]");
    assert.match(await panel.page.textContent("#knowledge-embedding-editor"), /недоступны/);
    assert.equal(await panel.page.isDisabled("#knowledge-upload-button"), true);
    assert.equal(await panel.page.isDisabled("#knowledge-use-qdrant"), true);
  } finally { await panel.close(); }
  const reader = await openPanel({ role: "viewer", routes: { ...ROUTES, ...ACTIVE_ROUTES } });
  try {
    await reader.page.click('[data-page="knowledge"]');
    await reader.page.waitForSelector("[data-document-row]");
    assert.match(await reader.page.textContent("#knowledge-active-embedding"), /bge-m3/);
    assert.equal(await reader.page.locator("#knowledge-embedding-form, #knowledge-runtime-form").count(), 0);
  } finally { await reader.close(); }
});
