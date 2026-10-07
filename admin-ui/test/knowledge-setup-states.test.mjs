/**
 * «Поиск по смыслу»: реалистичные состояния, в которых шаги должны
 * говорить правду, — остатки прошлых попыток и откат, новая модель рядом
 * с включённой, недоиндексированные документы, повтор неудачной попытки,
 * недоступный Qdrant, выключенные базы, прежний режим поиска, отсутствие
 * QDRANT_API_KEY; опрос раз в 5 секунд не мешает вводу.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { openPanel } from "./harness.mjs";
import {
  UPLOADS, INDEX, VERSION, EMBEDDINGS, RECOMMENDED, SETTINGS, ACTIVE, ACTIVE_ROUTES,
  ROUTES, enterKnowledge, stepState, toastText, EMPTY_ROUTES, LIVE_SETTINGS, DRAFT,
} from "./knowledge-fixtures.mjs";

test("обе базы выключены — поиск не идёт: «Включение» не отмечено, кнопка возвращает все шесть настроек", async () => {
  const scopesOff = { ...LIVE_SETTINGS, settings: LIVE_SETTINGS.settings.map((s) => /_(private|global)_enabled$/.test(s.key) ? { ...s, value: false } : s) };
  const panel = await openPanel({ routes: { ...ROUTES, ...ACTIVE_ROUTES, "/settings": scopesOff,
    "POST /knowledge/embeddings/versions/2/activate": { version: 2, status: "active" }, "PUT /settings": { saved: true },
  } });
  try {
    await enterKnowledge(panel);
    assert.equal(await stepState(panel, 3), "current");
    const status = await panel.page.textContent("#knowledge-setup-status");
    assert.doesNotMatch(status, /работает/, "сервер при выключенных базах не ищет вовсе");
    assert.match(status, /не ищет в документах/);
    await panel.page.click("#knowledge-use-qdrant");
    const saved = await panel.waitForRequest((r) => r.path === "/settings" && r.method === "PUT");
    assert.deepEqual(saved.body, { settings: RECOMMENDED });
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("черновики и неудачи прошлых попыток позади включённой версии не становятся следующим шагом", async () => {
  const live = { ...ACTIVE, version: 3, model: "openai/text-embedding-3-large", dimension: 3072 };
  const failed = { ...VERSION, status: "failed", error_code: "job_publish_failed", built_at: null, points: null, progress: null };
  const versions = [live, failed, DRAFT];
  const panel = await openPanel({ routes: { ...ROUTES, "/settings": LIVE_SETTINGS,
    "/knowledge/embeddings": { ...EMBEDDINGS, active: 3, versions },
    "/knowledge/index": { ...INDEX, aliases: { private: 3, global: 3 }, versions },
  } });
  try {
    await enterKnowledge(panel);
    assert.deepEqual([await stepState(panel, 1), await stepState(panel, 2), await stepState(panel, 3)], ["done", "done", "done"]);
    assert.match(await panel.page.textContent('[data-setup-step="1"]'), /text-embedding-3-large.*v3/);
    const status = await panel.page.textContent("#knowledge-setup-status");
    assert.match(status, /работает/);
    assert.doesNotMatch(status, /Новая модель/);
    assert.equal(await panel.page.locator("#knowledge-setup-build, #knowledge-use-qdrant").count(), 0, "мёртвые версии не получают главной кнопки");
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
  // Откат: включена v1, выведенная v3 новее неудачной v2 — v2 тоже прошлое.
  const rolledBack = [{ ...live, status: "retired" }, failed, { ...ACTIVE, version: 1 }];
  const after = await openPanel({ routes: { ...ROUTES, "/settings": LIVE_SETTINGS,
    "/knowledge/embeddings": { ...EMBEDDINGS, active: 1, versions: rolledBack },
    "/knowledge/index": { ...INDEX, aliases: { private: 1, global: 1 }, versions: rolledBack },
  } });
  try {
    await enterKnowledge(after);
    assert.deepEqual([await stepState(after, 1), await stepState(after, 2), await stepState(after, 3)], ["done", "done", "done"]);
    assert.match(await after.page.textContent('[data-setup-step="1"]'), /v1/);
    assert.doesNotMatch(await after.page.textContent("#knowledge-setup-status"), /Новая модель/);
  } finally { await after.close(); }
});

test("новые документы ещё индексируются: Qdrant работает, а полноту при включении проверяет сервер", async () => {
  const partial = { ...ACTIVE, points: 74, progress: 0.9 };
  const routes = { ...ROUTES,
    "/knowledge/embeddings": { ...EMBEDDINGS, active: 2, versions: [partial] },
    "/knowledge/index": { ...INDEX, aliases: { private: 2, global: 2 }, versions: [partial] },
  };
  const live = await openPanel({ routes: { ...routes, "/settings": LIVE_SETTINGS } });
  try {
    await enterKnowledge(live);
    assert.equal(await stepState(live, 3), "done");
    const status = await live.page.textContent("#knowledge-setup-status");
    assert.match(status, /работает/);
    assert.doesNotMatch(status, /не работает/, "неполный индекс поиск не останавливает");
    assert.match(status, /Часть документов ещё не в Qdrant/);
  } finally { await live.close(); }
  const incomplete = "Не все фрагменты PostgreSQL представлены в индексе. Дождитесь индексации или постройте версию заново.";
  const panel = await openPanel({ routes: { ...routes,
    "POST /knowledge/embeddings/versions/2/activate": { __status: 409, __body: { error: { code: "version_conflict", message: incomplete, details: { code: "knowledge_index_incomplete" } } } },
    "PUT /settings": { saved: true },
  } });
  try {
    await enterKnowledge(panel);
    await panel.page.click("#knowledge-use-qdrant");
    const verify = await panel.waitForRequest((r) => r.path.endsWith("/2/activate"));
    assert.deepEqual(verify.body, { verify_only: true }, "решает сервер, а не счётчик точек в обзоре");
    await panel.page.waitForFunction((text) => document.querySelector("#toast").textContent.includes(text), incomplete);
    assert.equal(panel.requests.filter((r) => r.method === "PUT").length, 0);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("попытка построения не удалась, но очередь её повторит: причина словами, опрос и автовключение продолжаются", async () => {
  let phase = "draft";
  const at = "2026-10-06T19:00:00Z";
  const shape = {
    draft: {},
    retrying: { status: "building", building: false, build_started_at: at, error_code: "embedding_timeout", points: 0, progress: 0 },
    ready: { status: "ready", building: false, build_started_at: at, built_at: at, points: 82, progress: 1 },
    active: { status: "active", building: false, build_started_at: at, built_at: at, activated_at: at, points: 82, progress: 1 },
  };
  const versions = () => [{ ...DRAFT, ...shape[phase === "live" ? "active" : phase] }];
  const live = () => ["active", "live"].includes(phase);
  const panel = await openPanel({ routes: { ...ROUTES,
    "/knowledge/embeddings": () => ({ ...EMBEDDINGS, active: live() ? 1 : null, versions: versions() }),
    "/knowledge/index": () => ({ ...INDEX, aliases: live() ? { private: 1, global: 1 } : { private: null, global: null }, aliases_match_active: true, versions: versions() }),
    "/settings": () => phase === "live" ? LIVE_SETTINGS : SETTINGS,
    "POST /knowledge/embeddings/versions/1/build": () => { phase = "retrying"; return { version: 1, status: "building" }; },
    "POST /knowledge/embeddings/versions/1/activate": () => { if (phase === "ready") phase = "active"; return { version: 1, status: "active" }; },
    "PUT /settings": () => { phase = "live"; return { saved: true }; },
  } });
  try {
    // Опрос раз в 5 секунд — на виртуальных часах, без настоящего ожидания.
    await panel.page.clock.install();
    await enterKnowledge(panel);
    await panel.page.click("#knowledge-setup-build");
    await panel.page.waitForFunction(() => /Сервер повторит/.test(document.querySelector('[data-setup-step="2"]')?.textContent || ""));
    assert.match(await panel.page.textContent('[data-setup-step="2"]'), /провайдер не ответил вовремя \(embedding_timeout\)/);
    assert.match(await panel.page.textContent('[data-setup-step="3"]'), /Включится само/, "повтор не снимает автовключение");
    phase = "ready";
    await panel.page.clock.runFor(5_000);
    await panel.page.waitForFunction(() => document.querySelector('[data-setup-step="3"]')?.dataset.state === "done");
    const activations = panel.requests.filter((r) => r.path.endsWith("/1/activate")).map((r) => r.body);
    assert.deepEqual(activations, [{ expected_active_version: null }, { verify_only: true }]);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("опрос раз в 5 секунд не пересоздаёт форму модели: введённое, фокус и «Дополнительно» на месте", async () => {
  const panel = await openPanel({ routes: { ...ROUTES, ...EMPTY_ROUTES,
    "/knowledge/uploads": { uploads: [{ ...UPLOADS[1], status: "processing", error_code: null }] },
  } });
  try {
    await panel.page.clock.install();
    await enterKnowledge(panel);
    await panel.page.click("#knowledge-embedding-form details summary");
    await panel.page.fill('#knowledge-embedding-form [name="model"]', "openai/text-emb");
    // Метка в списке документов исчезает при следующей загрузке раздела:
    // он перерисовывается всегда, а форма и шаги — в том же вызове. Метки
    // в неизменившихся статусе, сводке и теле шага должны пережить опрос.
    await panel.page.evaluate(() => {
      const mark = (selector, id) => document.querySelector(selector).append(Object.assign(document.createElement("i"), { id }));
      mark("#knowledge-documents", "poll-marker");
      mark("#knowledge-setup-status", "status-marker");
      mark("#knowledge-status", "summary-marker");
      mark('[data-setup-step="2"] [data-step-body]', "step-marker");
    });
    await panel.page.clock.runFor(5_000);
    await panel.page.waitForFunction(() => !document.querySelector("#poll-marker"));
    assert.deepEqual(await panel.page.evaluate(() => ["status-marker", "summary-marker", "step-marker"].filter((id) => !document.getElementById(id))), [],
      "неизменившееся не перерисовывается: экранный диктор не повторяет, фокус не теряется");
    assert.equal(await panel.page.evaluate(() => document.activeElement?.getAttribute("name")), "model");
    assert.equal(await panel.page.inputValue('#knowledge-embedding-form [name="model"]'), "openai/text-emb");
    assert.equal(await panel.page.evaluate(() => document.querySelector("#knowledge-embedding-form details").open), true);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.close(); }
});

test("включить сейчас нельзя — шаг «Включение» называет причину вместо кнопки, которая откажет", async () => {
  const unavailable = { qdrant_status: "unavailable", aliases: null, aliases_match_active: null };
  const panel = await openPanel({ routes: { ...ROUTES, ...ACTIVE_ROUTES,
    "/knowledge/index": { ...ACTIVE_ROUTES["/knowledge/index"], ...unavailable },
  } });
  try {
    await enterKnowledge(panel);
    assert.equal(await stepState(panel, 3), "error");
    assert.match(await panel.page.textContent('[data-setup-step="3"]'), /Qdrant сейчас недоступен/);
    assert.equal(await panel.page.locator("#knowledge-use-qdrant").count(), 0);
  } finally { await panel.close(); }
  const next = { ...VERSION, version: 3, model: "openai/text-embedding-3-large", dimension: 3072 };
  const switching = await openPanel({ routes: { ...ROUTES,
    "/knowledge/embeddings": { ...EMBEDDINGS, active: 2, versions: [next, ACTIVE] },
    "/knowledge/index": { ...INDEX, ...unavailable, versions: [next, ACTIVE] },
  } });
  try {
    await enterKnowledge(switching);
    assert.equal(await stepState(switching, 3), "error");
    assert.match(await switching.page.textContent('[data-setup-step="3"]'), /переключить на новую модель нельзя/);
    assert.equal(await switching.page.locator("#knowledge-use-qdrant").count(), 0);
  } finally { await switching.close(); }
});

test("новая модель готовится рядом с включённой: Ева ищет по прежней, статус говорит, что дальше", async () => {
  const next = { ...VERSION, version: 3, model: "openai/text-embedding-3-large", dimension: 3072, status: "building", building: true,
    build_started_at: "2026-10-06T19:00:00Z", built_at: null, points: 41, progress: 0.5 };
  const panel = await openPanel({ routes: { ...ROUTES, "/settings": LIVE_SETTINGS,
    "/knowledge/embeddings": { ...EMBEDDINGS, active: 2, versions: [next, ACTIVE] },
    "/knowledge/index": { ...INDEX, aliases: { private: 2, global: 2 }, versions: [next, ACTIVE] },
  } });
  try {
    await enterKnowledge(panel);
    assert.deepEqual([await stepState(panel, 1), await stepState(panel, 2), await stepState(panel, 3)], ["done", "busy", "todo"]);
    assert.match(await panel.page.textContent('[data-setup-step="1"]'), /text-embedding-3-large.*v3/);
    const status = await panel.page.textContent("#knowledge-setup-status");
    assert.match(status, /работает/);
    assert.match(status, /Новая модель строится рядом/);
  } finally { await panel.close(); }
});

test("смена модели при выключенном поиске по смыслу: подтверждение говорит, что включится и он", async () => {
  const next = { ...VERSION, version: 3, model: "openai/text-embedding-3-large", dimension: 3072 };
  const panel = await openPanel({ routes: { ...ROUTES,
    "/knowledge/embeddings": { ...EMBEDDINGS, active: 2, versions: [next, ACTIVE] },
    "/knowledge/index": { ...INDEX, aliases: { private: 2, global: 2 }, versions: [next, ACTIVE] },
  } });
  try {
    await enterKnowledge(panel);
    await panel.page.click("#knowledge-use-qdrant");
    assert.match(await panel.confirmTitle(), /Переключить Еву на модель v3/);
    assert.match(await panel.page.textContent("#confirm-description"), /включит и его/);
    assert.equal(panel.countTo("/activate"), 0, "без подтверждения ничего не уходит");
  } finally { await panel.close(); }
});

test("пока поиск по смыслу не включён, статус говорит, как Ева ищет сейчас: прежний режим — ещё и pgvector", async () => {
  const lexical = { ...SETTINGS, settings: SETTINGS.settings.map((s) => s.key.endsWith("search_mode") ? { ...s, value: "lexical" } : s) };
  // Qdrant без включённой версии векторной половины не даёт — остаются слова.
  const qdrantWithoutVersion = { ...SETTINGS, settings: SETTINGS.settings.map((s) => ({ ...s, value: RECOMMENDED[s.key] ?? s.value })) };
  for (const [settings, expected] of [[SETTINGS, /по словам и через pgvector/], [lexical, /только по словам/], [qdrantWithoutVersion, /только по словам/]]) {
    const panel = await openPanel({ routes: { ...ROUTES, ...EMPTY_ROUTES, "/settings": settings } });
    try {
      await enterKnowledge(panel);
      assert.match(await panel.page.textContent("#knowledge-setup-status"), expected);
    } finally { await panel.close(); }
  }
});

test("без QDRANT_API_KEY ручной выбор Qdrant называет настоящую причину, а не «постройте индекс»", async () => {
  const panel = await openPanel({ routes: { ...ROUTES, ...EMPTY_ROUTES,
    "/knowledge/index": { ...INDEX, qdrant: false, qdrant_status: "not_configured", aliases: null, aliases_match_active: null, versions: [] },
  } });
  try {
    await enterKnowledge(panel);
    assert.match(await panel.page.textContent("#knowledge-setup-status"), /QDRANT_API_KEY/);
    await panel.page.click("#knowledge-manual summary");
    await panel.page.selectOption('[data-knowledge-setting="runtime.knowledge_vector_backend"]', "qdrant");
    await panel.page.click("#knowledge-runtime-save");
    await panel.page.waitForFunction(() => document.querySelector("#toast").classList.contains("show"));
    const message = await toastText(panel);
    assert.match(message, /QDRANT_API_KEY/);
    assert.doesNotMatch(message, /Сначала постройте/);
    assert.equal(panel.requests.filter((r) => r.method === "PUT").length, 0);
  } finally { await panel.close(); }
});
