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
  private_owners: 3,
  scopes: {
    private: { documents: 7, chunks: 70, lag_seconds: 0, by_status: { ready: 7 } },
    global: { documents: 2, chunks: 12, lag_seconds: 0, by_status: { ready: 1, failed: 1 } },
  },
  versions: [{ version: 2, model: "bge-m3", dimension: 1024, status: "ready", error_code: null, building: false,
    build_started_at: "2026-09-30T09:00:00Z", built_at: "2026-09-30T09:10:00Z", activated_at: null, points: 82, progress: 1 }],
};

const ROUTES = {
  "/knowledge/collections": { collections: [COLLECTION] },
  "/knowledge/documents": { documents: DOCS, total: 2 },
  "/knowledge/uploads": { uploads: UPLOADS },
  "/knowledge/index": INDEX,
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
    assert.match(index, /Включить поиск/);
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
