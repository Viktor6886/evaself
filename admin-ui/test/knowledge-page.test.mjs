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
import {
  COLLECTION, DOCS, UPLOADS, INDEX, VERSION, EMBEDDINGS, UPLOAD_SETTING, SETTINGS, ROUTES,
} from "./knowledge-fixtures.mjs";

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
      await panel.page.waitForSelector("[data-document-row]");
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

test("удаление одного документа и неудавшейся загрузки — только после подтверждения", async () => {
  const failed = UPLOADS[1];
  const panel = await openPanel({ routes: { ...ROUTES,
    "POST /knowledge/documents/delete": { deleted: [DOCS[0].id] },
    [`POST /knowledge/uploads/${failed.id}/delete`]: { deleted: failed.id },
  } });
  try {
    await panel.page.click('[data-page="knowledge"]');
    await panel.page.waitForSelector(`[data-document-delete="${DOCS[0].id}"]`);
    assert.equal(await panel.page.locator(`[data-upload-delete="${UPLOADS[0].id}"]`).count(), 0, "разобранная загрузка удаляется вместе с документом");
    await panel.page.click(`[data-document-delete="${DOCS[0].id}"]`);
    await panel.page.waitForFunction(() => document.querySelector("#confirm-dialog")?.open === true);
    assert.match(await panel.page.textContent("#confirm-description"), /Регламент\.pdf[\s\S]*Qdrant/u);
    assert.equal(panel.countTo("/knowledge/documents/delete"), 0, "до подтверждения ничего не удаляется");
    await panel.page.click('#confirm-form button[value="confirm"]');
    const request = await panel.waitForRequest((item) => item.path === "/knowledge/documents/delete");
    assert.deepEqual(request.body, { ids: [DOCS[0].id] });
    await panel.page.waitForFunction(() => document.querySelector("#confirm-dialog")?.open === false);
    await panel.page.click(`[data-upload-delete="${failed.id}"]`);
    await panel.page.waitForFunction(() => document.querySelector("#confirm-dialog")?.open === true);
    assert.equal(panel.countTo(`/knowledge/uploads/${failed.id}/delete`), 0);
    await panel.page.click('#confirm-form button[value="confirm"]');
    await panel.waitForRequest((item) => item.path === `/knowledge/uploads/${failed.id}/delete` && item.method === "POST");
    assert.deepEqual(panel.errors, []);
  } finally {
    await panel.close();
  }
});

/**
 * «Ждёт индексации» без причины висело вечно: без Qdrant, при выключенной
 * индексации и без построенной модели документ в индекс не попадёт, а Ева
 * уже находит его поиском по PostgreSQL.
 */
test("документ без Qdrant показывает причину вместо вечного «ждёт индексации»", async () => {
  const pending = { ...DOCS[0], id: "0e000000-0000-4000-8000-00000000000e", name: "Справочник.pdf", index_status: "pending", revision: 1 };
  const indexOff = { ...SETTINGS, settings: SETTINGS.settings.map((item) => item.key === "runtime.knowledge_index_enabled" ? { ...item, value: false } : item) };
  const draft = { ...VERSION, status: "draft", built_at: null, points: null, progress: null };
  const counts = { ...INDEX.scopes, global: { documents: 1, chunks: 8, lag_seconds: 120, by_status: { pending: 1 } } };
  for (const scenario of [
    { name: "индексация выключена", routes: { "/settings": indexOff }, reason: /индексация выключена/u, banner: /в блоке «Поиск по смыслу» вверху/u },
    { name: "нет модели", routes: { "/knowledge/embeddings": { ...EMBEDDINGS, versions: [draft] }, "/knowledge/index": { ...INDEX, scopes: counts, versions: [draft] } },
      reason: /нет построенной модели эмбеддингов/u, banner: /в блоке «Поиск по смыслу» вверху/u, build: true },
    { name: "Qdrant не настроен", routes: { "/knowledge/index": { ...INDEX, qdrant: false, qdrant_status: "not_configured", scopes: counts } },
      reason: /Qdrant не настроен/u, banner: /QDRANT_API_KEY не задан/u },
    { name: "индексировать есть куда", routes: {}, reason: null },
  ]) {
    const panel = await openPanel({ routes: { ...ROUTES, "/knowledge/documents": { documents: [pending], total: 1 },
      "/knowledge/index": { ...INDEX, scopes: counts }, ...scenario.routes } });
    try {
      await panel.page.click('[data-page="knowledge"]');
      await panel.page.waitForSelector(`[data-document-row="${pending.id}"]`);
      const row = await panel.page.textContent(`[data-document-row="${pending.id}"]`);
      const index = await panel.page.textContent("#knowledge-index");
      if (scenario.reason) {
        assert.match(row, /не в Qdrant/u, scenario.name);
        assert.match(row, scenario.reason, scenario.name);
        assert.match(row, /поиск по словам работает и без Qdrant/u, scenario.name);
        assert.doesNotMatch(row, /ждёт индексации/u, scenario.name);
        assert.match(index, scenario.banner, scenario.name);
        assert.match(index, /не в Qdrant 1/u, scenario.name);
        assert.doesNotMatch(index, /ждёт дольше всех/u, scenario.name);
        if (scenario.build) assert.match(await panel.page.textContent("#knowledge-setup-build"), /Построить индекс/u, "следующий шаг — в блоке наверху");
      } else {
        assert.match(row, /ждёт индексации/u, "версия построена: документ действительно в очереди");
        assert.match(index, /в очереди 1/u);
        assert.doesNotMatch(index, /Документы не попадают в Qdrant/u);
      }
      assert.deepEqual(panel.errors, [], scenario.name);
    } finally {
      await panel.close();
    }
  }
});

test("читающая роль видит базу, но не может ничего загрузить или изменить", async () => {
  const panel = await openPanel({ role: "viewer", routes: ROUTES });
  try {
    await panel.page.click('[data-page="knowledge"]');
    await panel.page.waitForSelector("[data-document-row]");
    assert.equal(await panel.page.isVisible("#knowledge-upload"), false);
    assert.equal(await panel.page.locator("[data-collection-delete], [data-document-select], [data-document-delete], [data-upload-delete], [data-upload-retry], [data-version-build], #knowledge-reconcile, #knowledge-collection-form, #knowledge-setup button, #knowledge-embedding-form").count(), 0);
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

