/**
 * «Поиск по смыслу» в разделе «База знаний»: модель эмбеддингов, индекс
 * в Qdrant и включение — три шага, у текущего одна кнопка.
 *
 * Проверяется то, что делает администратор: «Подключить модель»
 * проверяет модель, заводит версию и строит индекс (выключенную
 * индексацию включает сама); первая настройка включается сама после
 * построения; смена модели и откат — только по подтверждению; Qdrant
 * нельзя включить без построенного индекса, и отказ называет причину;
 * читающая роль видит шаги, но не получает кнопок.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { openPanel } from "./harness.mjs";
import {
  INDEX, VERSION, EMBEDDINGS, RECOMMENDED, SETTINGS, ACTIVE, ACTIVE_ROUTES, ROUTES,
  enterKnowledge, openModelForm, stepState, toastText, EMPTY_ROUTES, LIVE_SETTINGS, INDEX_OFF, DRAFT,
} from "./knowledge-fixtures.mjs";

test("поиск по смыслу: включённая модель видна, форма смены — без секретов и с её значениями", async () => {
  const panel = await openPanel({ routes: { ...ROUTES, ...ACTIVE_ROUTES } });
  try {
    await enterKnowledge(panel);
    assert.equal(panel.countTo("/knowledge/embeddings"), 1);
    assert.deepEqual([await stepState(panel, 1), await stepState(panel, 2), await stepState(panel, 3)], ["done", "done", "current"]);
    assert.match(await panel.page.textContent("#knowledge-use-qdrant"), /Включить поиск по смыслу/);
    const active = await panel.page.textContent("#knowledge-active-embedding");
    for (const text of ["v2", "OpenRouter", "bge-m3", "1024", "активен"]) assert.ok(active.includes(text));
    assert.match(await panel.page.textContent("#knowledge-status"), /pgvector \(режим legacy\)/);
    assert.equal(await panel.page.locator("#knowledge-embedding-form").count(), 0, "форма закрыта, пока модель не меняют");
    await openModelForm(panel);
    assert.deepEqual(await panel.page.locator('#knowledge-embedding-form [name="provider_id"] option').allTextContents(), ["Выберите провайдера", "OpenRouter", "Jina"]);
    assert.equal(await panel.page.locator('#knowledge-embedding-form [name="api_key"], #knowledge-embedding-form [name="base_url"]').count(), 0);
    assert.equal(await panel.page.inputValue('#knowledge-embedding-form [name="model"]'), "bge-m3");
    assert.equal(await panel.page.inputValue('#knowledge-embedding-form [name="dimension"]'), "", "размерность другой модели узнаётся при проверке");
    await panel.page.click("#knowledge-setup-cancel");
    assert.equal(await panel.page.locator("#knowledge-embedding-form").count(), 0);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("«Сменить модель»: размерность переносится, только если её задавали провайдеру явно", async () => {
  const explicit = { ...ACTIVE, request_dimensions: true, dimension: 512 };
  const panel = await openPanel({ routes: { ...ROUTES,
    "/knowledge/embeddings": { ...ACTIVE_ROUTES["/knowledge/embeddings"], versions: [explicit] },
    "/knowledge/index": { ...ACTIVE_ROUTES["/knowledge/index"], versions: [explicit] },
  } });
  try {
    await enterKnowledge(panel);
    await openModelForm(panel);
    assert.equal(await panel.page.inputValue('#knowledge-embedding-form [name="dimension"]'), "512");
    assert.equal(await panel.page.isChecked('#knowledge-embedding-form [name="request_dimensions"]'), true);
  } finally { await panel.close(); }
});

test("«Только проверить» показывает размерность и latency; изменение модели стирает результат", async () => {
  const panel = await openPanel({ routes: { ...ROUTES,
    "POST /knowledge/embeddings/probe": { ok: true, dimension: 768, latency_ms: 73 },
  } });
  try {
    await enterKnowledge(panel);
    await openModelForm(panel);
    await panel.page.selectOption('#knowledge-embedding-form [name="provider_id"]', "p2");
    await panel.page.fill('#knowledge-embedding-form [name="model"]', "jina-embeddings-v3");
    await panel.page.fill('#knowledge-embedding-form [name="dimension"]', "");
    await panel.page.click("#knowledge-embedding-probe");
    await panel.page.waitForFunction(() => document.querySelector("#knowledge-embedding-probe-result").textContent.includes("Модель доступна"));
    assert.match(await panel.page.textContent("#knowledge-embedding-probe-result"), /Модель доступна.*768.*73 мс/);
    const request = await panel.waitForRequest((r) => r.path === "/knowledge/embeddings/probe");
    assert.deepEqual(request.body, { provider_id: "p2", model: "jina-embeddings-v3", dimension: null, request_dimensions: false,
      distance: "Cosine", hnsw_m: 16, hnsw_ef_construct: 100, on_disk: false, fallback_provider_id: null, fallback_model: null });
    await panel.page.fill('#knowledge-embedding-form [name="model"]', "other-model");
    assert.equal(await panel.page.textContent("#knowledge-embedding-probe-result"), "");
    assert.equal(panel.countTo("/knowledge/embeddings/versions"), 0, "проверка ничего не сохраняет");
  } finally { await panel.close(); }
});

test("«Подключить модель»: отказ проверки и несовместимый запасной провайдер не создают версию", async () => {
  let answer = { ok: false, message: "Провайдер отклонил ключ", error_code: "embedding_auth" };
  const panel = await openPanel({ routes: { ...ROUTES, ...EMPTY_ROUTES, "POST /knowledge/embeddings/probe": () => answer } });
  try {
    await enterKnowledge(panel);
    assert.equal(await stepState(panel, 1), "current");
    await panel.page.fill('#knowledge-embedding-form [name="model"]', "bge-m3");
    await panel.page.click("#knowledge-embedding-connect");
    await panel.page.waitForFunction(() => document.querySelector("#knowledge-embedding-probe-result").textContent.includes("отклонил ключ"));
    answer = { ok: true, dimension: 1024, latency_ms: 9, compare: { ok: true, same_space: false } };
    await panel.page.click("#knowledge-embedding-connect");
    await panel.page.waitForFunction(() => document.querySelector("#knowledge-embedding-probe-result").textContent.includes("несовместим"));
    assert.equal(panel.countTo("/knowledge/embeddings/versions"), 0);
    assert.equal(panel.requests.filter((r) => r.method === "PUT").length, 0);
  } finally { await panel.close(); }
});

test("«Подключить модель» с нуля: проверка, версия, включение индексации и построение — одним нажатием", async () => {
  const panel = await openPanel({ routes: { ...ROUTES, ...EMPTY_ROUTES, "/settings": INDEX_OFF,
    "POST /knowledge/embeddings/probe": { ok: true, dimension: 3072, latency_ms: 40 },
    "POST /knowledge/embeddings/versions": DRAFT,
    "PUT /settings": { saved: true },
    "POST /knowledge/embeddings/versions/1/build": { version: 1, status: "building" },
  } });
  try {
    await enterKnowledge(panel);
    assert.deepEqual([await stepState(panel, 1), await stepState(panel, 2), await stepState(panel, 3)], ["current", "todo", "todo"]);
    assert.equal(await panel.page.inputValue('#knowledge-embedding-form [name="provider_id"]'), "p1");
    await panel.page.fill('#knowledge-embedding-form [name="model"]', "openai/text-embedding-3-large");
    await panel.page.fill('#knowledge-embedding-form [name="dimension"]', "3072");
    await panel.page.click("#knowledge-embedding-connect");
    const build = await panel.waitForRequest((r) => r.path === "/knowledge/embeddings/versions/1/build");
    assert.deepEqual(build.body, { full: true });
    const at = (predicate) => panel.requests.findIndex(predicate);
    const probe = at((r) => r.path === "/knowledge/embeddings/probe");
    const create = at((r) => r.path === "/knowledge/embeddings/versions" && r.method === "POST");
    const enable = at((r) => r.path === "/settings" && r.method === "PUT");
    assert.ok(probe >= 0 && probe < create && create < enable && enable < panel.requests.indexOf(build), "проверка → версия → индексация → построение");
    assert.equal(panel.requests[create].body.model, "openai/text-embedding-3-large");
    assert.deepEqual(panel.requests[enable].body, { settings: { "runtime.knowledge_index_enabled": true } });
    assert.equal(panel.requests.filter((r) => r.path.endsWith("/activate")).length, 0, "черновик не активируется");
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("от загрузки до поиска по смыслу: индекс строится, затем поиск включается сам", async () => {
  let phase = "none";
  const at = "2026-10-06T19:00:00Z";
  const shape = {
    draft: { status: "draft", building: false, build_started_at: null, built_at: null, activated_at: null, points: null, progress: null },
    building: { status: "building", building: true, build_started_at: at, built_at: null, activated_at: null, points: 41, progress: 0.5 },
    ready: { status: "ready", building: false, build_started_at: at, built_at: at, activated_at: null, points: 82, progress: 1 },
    active: { status: "active", building: false, build_started_at: at, built_at: at, activated_at: at, points: 82, progress: 1 },
  };
  const versions = () => phase === "none" ? [] : [{ ...DRAFT, ...shape[phase === "live" ? "active" : phase] }];
  const live = () => ["active", "live"].includes(phase);
  const panel = await openPanel({ routes: { ...ROUTES,
    "/knowledge/embeddings": () => ({ ...EMBEDDINGS, active: live() ? 1 : null, versions: versions() }),
    "/knowledge/index": () => ({ ...INDEX, aliases: live() ? { private: 1, global: 1 } : { private: null, global: null }, aliases_match_active: true, versions: versions() }),
    "/settings": () => phase === "live" ? LIVE_SETTINGS : SETTINGS,
    "POST /knowledge/embeddings/probe": { ok: true, dimension: 3072, latency_ms: 40 },
    "POST /knowledge/embeddings/versions": () => { phase = "draft"; return { ...DRAFT }; },
    "POST /knowledge/embeddings/versions/1/build": () => { phase = "building"; return { version: 1, status: "building" }; },
    "POST /knowledge/embeddings/versions/1/activate": () => { if (phase === "ready") phase = "active"; return { version: 1, status: "active" }; },
    "PUT /settings": () => { phase = "live"; return { saved: true }; },
  } });
  try {
    await enterKnowledge(panel);
    await panel.page.fill('#knowledge-embedding-form [name="model"]', "openai/text-embedding-3-large");
    await panel.page.click("#knowledge-embedding-connect");
    await panel.page.waitForFunction(() => document.querySelector('[data-setup-step="2"]')?.dataset.state === "busy");
    assert.match(await panel.page.textContent('[data-setup-step="2"]'), /Строится… 50%/);
    assert.match(await panel.page.textContent('[data-setup-step="3"]'), /Включится само/);
    phase = "ready";
    await panel.page.click("#reload-knowledge");
    await panel.page.waitForFunction(() => document.querySelector('[data-setup-step="3"]')?.dataset.state === "done", null, { timeout: 10_000 });
    const activations = panel.requests.filter((r) => r.path.endsWith("/1/activate")).map((r) => r.body);
    assert.deepEqual(activations, [{ expected_active_version: null }, { verify_only: true }], "включение, затем проверка перед Qdrant");
    const saved = panel.requests.find((r) => r.path === "/settings" && r.method === "PUT");
    assert.deepEqual(saved.body, { settings: RECOMMENDED });
    assert.match(await panel.page.textContent("#knowledge-setup"), /работает/);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("черновик из прошлой попытки: «Построить индекс» в блоке наверху, индексация включается сама", async () => {
  const panel = await openPanel({ routes: { ...ROUTES, "/settings": INDEX_OFF,
    "/knowledge/embeddings": { ...EMBEDDINGS, versions: [DRAFT] },
    "/knowledge/index": { ...INDEX, versions: [DRAFT] },
    "PUT /settings": { saved: true },
    "POST /knowledge/embeddings/versions/1/build": { version: 1, status: "building" },
  } });
  try {
    await enterKnowledge(panel);
    assert.deepEqual([await stepState(panel, 1), await stepState(panel, 2), await stepState(panel, 3)], ["done", "current", "todo"]);
    assert.match(await panel.page.textContent('[data-setup-step="1"]'), /openai\/text-embedding-3-large/);
    await panel.page.click("#knowledge-setup-build");
    const build = await panel.waitForRequest((r) => r.path === "/knowledge/embeddings/versions/1/build");
    assert.deepEqual(build.body, { full: true });
    const enable = panel.requests.find((r) => r.path === "/settings" && r.method === "PUT");
    assert.deepEqual(enable.body, { settings: { "runtime.knowledge_index_enabled": true } });
    assert.ok(panel.requests.indexOf(enable) < panel.requests.indexOf(build));
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("версии в «Векторном индексе»: построение при выключенной индексации включает её, а не стоит серым", async () => {
  const panel = await openPanel({ routes: { ...ROUTES,
    "/knowledge/embeddings": { ...EMBEDDINGS, versions: [DRAFT] }, "/knowledge/index": { ...INDEX, versions: [DRAFT] },
    "/settings": INDEX_OFF,
    "PUT /settings": { saved: true },
    "POST /knowledge/embeddings/versions/1/build": { version: 1, status: "building" },
  } });
  try {
    await enterKnowledge(panel);
    assert.equal(await panel.page.isDisabled('[data-version-build="1"]'), false);
    await panel.page.click('[data-version-build="1"]');
    assert.match(await panel.confirmTitle(), /Перестроить индекс v1/);
    await panel.confirmAccept();
    const build = await panel.waitForRequest((r) => r.path === "/knowledge/embeddings/versions/1/build");
    assert.deepEqual(build.body, { full: true });
    const enable = panel.requests.find((r) => r.path === "/settings" && r.method === "PUT");
    assert.deepEqual(enable.body, { settings: { "runtime.knowledge_index_enabled": true } });
    assert.ok(panel.requests.indexOf(enable) < panel.requests.indexOf(build));
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("версии в «Векторном индексе»: первая активация требует подтверждения, незавершённую активировать нельзя", async () => {
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
    assert.equal(panel.requests.filter((r) => r.method === "PUT" && r.path === "/settings").length, 0, "активация из таблицы не меняет режим поиска");
  } finally { await panel.close(); }
});

test("версии в «Векторном индексе»: смена модели и откат доступны только построенным версиям", async () => {
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

test("переключение на новую модель — кнопкой в блоке наверху и только после подтверждения", async () => {
  const ready = { ...VERSION, version: 3, model: "new-model", status: "ready" };
  const panel = await openPanel({ routes: { ...ROUTES, ...ACTIVE_ROUTES, "/settings": LIVE_SETTINGS,
    "/knowledge/embeddings": { ...EMBEDDINGS, active: 2, versions: [ready, ACTIVE] },
    "/knowledge/index": { ...ACTIVE_ROUTES["/knowledge/index"], versions: [ready, ACTIVE] },
    "POST /knowledge/embeddings/versions/3/activate": { version: 3, status: "active" },
  } });
  try {
    await enterKnowledge(panel);
    assert.equal(await stepState(panel, 3), "current");
    assert.match(await panel.page.textContent("#knowledge-use-qdrant"), /Переключить на новую модель/);
    await panel.page.click("#knowledge-use-qdrant");
    assert.match(await panel.confirmTitle(), /Переключить Еву на модель v3/);
    assert.equal(panel.countTo("/versions/3/activate"), 0);
    await panel.confirmAccept();
    assert.deepEqual(panel.requests.find((r) => r.path.endsWith("/3/activate")).body, { expected_active_version: 2 });
    assert.equal(panel.requests.filter((r) => r.method === "PUT").length, 0, "поиск уже на Qdrant — параметры не трогаются");
  } finally { await panel.close(); }
});

test("«Включить поиск по смыслу» при включённой модели: серверная проверка, затем все шесть настроек с etag", async () => {
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

test("Qdrant нельзя включить без построенного индекса: ручной выбор объясняет причину, отказ проверки не меняет параметры", async () => {
  const panel = await openPanel({ routes: { ...ROUTES,
    "/knowledge/embeddings": { ...EMBEDDINGS, versions: [DRAFT] }, "/knowledge/index": { ...INDEX, versions: [DRAFT] } } });
  try {
    await enterKnowledge(panel);
    assert.equal(await panel.page.locator("#knowledge-use-qdrant").count(), 0, "включать нечего, пока индекс не построен");
    await panel.page.click("#knowledge-manual summary");
    await panel.page.selectOption('[data-knowledge-setting="runtime.knowledge_vector_backend"]', "qdrant");
    await panel.page.click("#knowledge-runtime-save");
    await panel.page.waitForFunction(() => document.querySelector("#toast").classList.contains("show"));
    const message = await toastText(panel);
    assert.match(message, /Сначала постройте и включите индекс/);
    assert.doesNotMatch(message, /Раздел не отрисовался/, "отказ проверки — не поломка отрисовки");
    assert.equal(panel.requests.filter((r) => r.method === "PUT").length, 0);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
  const failed = await openPanel({ routes: { ...ROUTES, ...ACTIVE_ROUTES,
    "POST /knowledge/embeddings/versions/2/activate": { __status: 409, __body: { error: { message: "Индекс неполон" } } },
  } });
  try {
    await enterKnowledge(failed);
    await failed.page.click("#knowledge-use-qdrant");
    await failed.waitForRequest((r) => r.path.endsWith("/2/activate"));
    await failed.page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Индекс неполон"));
    assert.equal(failed.requests.filter((r) => r.method === "PUT").length, 0);
  } finally { await failed.close(); }
});

test("отказ Qdrant виден наверху и не мешает выключить поиск и приостановить индексацию", async () => {
  const panel = await openPanel({ routes: { ...ROUTES, ...ACTIVE_ROUTES, "/settings": LIVE_SETTINGS,
    "/knowledge/index": { ...ACTIVE_ROUTES["/knowledge/index"], qdrant_status: "unavailable", aliases: null, aliases_match_active: null },
    "PUT /settings": { saved: true },
  } });
  try {
    await enterKnowledge(panel);
    assert.equal(await panel.page.locator("#knowledge-use-qdrant").count(), 0);
    assert.match(await panel.page.textContent("#knowledge-setup"), /не работает/);
    await panel.page.click("#knowledge-manual summary");
    await panel.page.selectOption('[data-knowledge-setting="runtime.knowledge_search_enabled"]', "false");
    await panel.page.selectOption('[data-knowledge-setting="runtime.knowledge_index_enabled"]', "false");
    await panel.page.click("#knowledge-runtime-save");
    const saved = await panel.waitForRequest((r) => r.path === "/settings" && r.method === "PUT");
    assert.deepEqual(saved.body, { settings: { ...RECOMMENDED, "runtime.knowledge_search_enabled": false, "runtime.knowledge_index_enabled": false } });
    assert.equal(panel.requests.filter((r) => r.path.endsWith("/activate")).length, 0);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("индексация выключена при включённой модели: «Включить индексацию» включает её и запускает сверку", async () => {
  const off = { ...LIVE_SETTINGS, settings: LIVE_SETTINGS.settings.map((s) => s.key === "runtime.knowledge_index_enabled" ? { ...s, value: false } : s) };
  const panel = await openPanel({ routes: { ...ROUTES, ...ACTIVE_ROUTES, "/settings": off,
    "PUT /settings": { saved: true }, "POST /knowledge/index/reconcile": { scheduled: true },
  } });
  try {
    await enterKnowledge(panel);
    assert.equal(await stepState(panel, 2), "off");
    await panel.page.click("#knowledge-setup-indexing");
    const reconcile = await panel.waitForRequest((r) => r.path === "/knowledge/index/reconcile");
    const enable = panel.requests.find((r) => r.path === "/settings" && r.method === "PUT");
    assert.deepEqual(enable.body, { settings: { "runtime.knowledge_index_enabled": true } });
    assert.ok(panel.requests.indexOf(enable) < panel.requests.indexOf(reconcile));
  } finally { await panel.close(); }
});

test("недоступный реестр или выключенная загрузка видны; читающая роль не получает формы и кнопок настройки", async () => {
  const panel = await openPanel({ routes: { ...ROUTES,
    "/knowledge/embeddings": { __status: 503, __body: { error: { message: "Router недоступен" } } },
    "/knowledge/index": { ...INDEX, uploads_enabled: false },
  } });
  try {
    await panel.page.click('[data-page="knowledge"]');
    await panel.page.waitForSelector("[data-document-row]");
    assert.match(await panel.page.textContent("#knowledge-setup"), /недоступны/);
    assert.equal(await panel.page.isVisible("#knowledge-setup-steps"), false, "без реестра шаги не гадают о состоянии");
    assert.equal(await panel.page.locator("#knowledge-embedding-form").count(), 0);
    assert.equal(await panel.page.isDisabled("#knowledge-upload-button"), true);
    assert.equal(await panel.page.locator("#knowledge-use-qdrant").count(), 0);
  } finally { await panel.close(); }
  const reader = await openPanel({ role: "viewer", routes: { ...ROUTES, ...ACTIVE_ROUTES } });
  try {
    await reader.page.click('[data-page="knowledge"]');
    await reader.page.waitForSelector("[data-document-row]");
    assert.match(await reader.page.textContent("#knowledge-active-embedding"), /bge-m3/);
    assert.equal(await reader.page.isVisible("#knowledge-setup-steps"), true, "читающая роль видит, на каком шаге настройка");
    assert.equal(await stepState(reader, 3), "current");
    assert.equal(await reader.page.locator("#knowledge-embedding-form, #knowledge-runtime-form, #knowledge-setup button").count(), 0);
  } finally { await reader.close(); }
});

test("конфликт показывает причину сервера; устаревшие настройки — просьбу обновить страницу", async () => {
  const panel = await openPanel({ routes: { ...ROUTES,
    "/knowledge/embeddings": { ...EMBEDDINGS, versions: [DRAFT] }, "/knowledge/index": { ...INDEX, versions: [DRAFT] },
    "POST /knowledge/embeddings/versions/1/build": { __status: 409, __body: { error: { code: "version_conflict", message: "Построить можно черновик, неудавшуюся, готовую, активную или выведенную версию" } } },
    "PUT /settings": { __status: 409, __body: { error: { code: "version_conflict", message: "Настройки изменены другим администратором", details: { current_version: 5 } } } },
  } });
  try {
    await enterKnowledge(panel);
    await panel.page.click("#knowledge-setup-build");
    await panel.page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Построить можно черновик"));
    await panel.page.click("#knowledge-manual summary");
    await panel.page.selectOption('[data-knowledge-setting="runtime.knowledge_search_enabled"]', "false");
    await panel.page.click("#knowledge-runtime-save");
    await panel.page.waitForFunction(() => document.querySelector("#toast").textContent.includes("в другой сессии"));
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});
