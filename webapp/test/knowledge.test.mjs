import assert from "node:assert/strict";
import { test } from "node:test";

import { documentWidth, openApp, PHONES } from "./harness.mjs";

/**
 * Вкладка «База знаний» в Mini App: личные документы.
 *
 * Главное: вкладки нет, пока функция выключена на сервере; включённая —
 * показывает свои документы со статусами, загружает файл multipart-запросом,
 * удаляет документ после подтверждения; на узком экране пять кнопок меню
 * помещаются без горизонтальной прокрутки.
 */

const DOCS = [
  { id: "0a000000-0000-4000-8000-00000000000a", name: "Договор аренды.pdf", mime: "application/pdf", size_bytes: 204800,
    chunk_count: 8, state: "ready", revision: 2, created_at: "2026-08-13T09:00:00.000Z", updated_at: "2026-08-14T08:00:00.000Z" },
  { id: "0b000000-0000-4000-8000-00000000000b", name: "Заметки.md", mime: "text/markdown", size_bytes: 2048,
    chunk_count: 2, state: "indexing", revision: 1, created_at: "2026-08-14T08:30:00.000Z", updated_at: "2026-08-14T08:30:00.000Z" },
];
const UPLOADS = [
  { id: "0c000000-0000-4000-8000-00000000000c", name: "Копия.pdf", size_bytes: 204800, status: "ready", outcome: "duplicate",
    error_code: null, created_at: "2026-08-14T08:40:00.000Z" },
];
const ENABLED = { enabled: true, documents: DOCS, total: 2, uploads: UPLOADS };

test("выключенная функция: вкладки «База знаний» нет", async () => {
  const app = await openApp({ routes: { "/public/knowledge": { enabled: false, documents: [], uploads: [] } } });
  try {
    await app.page.waitForTimeout(200);
    assert.equal(await app.page.isVisible('.nav-item[data-target="knowledge"]'), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("включённая функция: документы со статусами, дубликат виден, удаление после подтверждения", async () => {
  const app = await openApp({
    routes: {
      "/public/knowledge": ENABLED,
      "DELETE /public/knowledge/documents/0a000000-0000-4000-8000-00000000000a": { deleted: true },
    },
  });
  try {
    await app.page.waitForSelector('.nav-item[data-target="knowledge"]:not([hidden])');
    await app.openScreen("knowledge");
    await app.page.waitForSelector("[data-knowledge-document]");
    const text = await app.page.textContent("#knowledge-content");
    assert.match(text, /Договор аренды\.pdf/);
    assert.match(text, /версия 2/);
    assert.match(text, /Готов/);
    assert.match(text, /Индексируется/);
    assert.match(text, /Дубликат/);

    await app.page.click('[data-knowledge-delete="0a000000-0000-4000-8000-00000000000a"]');
    await app.page.waitForSelector("#confirm-dialog[open]");
    await app.page.click("#confirm-accept");
    await app.page.waitForTimeout(200);
    assert.ok(app.requests.some((item) => item.method === "DELETE" && item.path === "/public/knowledge/documents/0a000000-0000-4000-8000-00000000000a"));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("загрузка уходит multipart-запросом с полем file", async () => {
  const app = await openApp({ routes: { "/public/knowledge": ENABLED, "POST /public/knowledge/uploads": { id: "u1", status: "queued" } } });
  try {
    await app.openScreen("knowledge");
    await app.page.waitForSelector("#knowledge-upload");
    await app.page.setInputFiles("#knowledge-file", { name: "план.md", mimeType: "text/markdown", buffer: Buffer.from("# План") });
    await app.page.waitForTimeout(300);
    const upload = app.requests.find((item) => item.method === "POST" && item.path === "/public/knowledge/uploads");
    assert.ok(upload, "загрузка не ушла");
    assert.match(String(upload.body), /name="file"; filename="план\.md"/);
  } finally {
    await app.close();
  }
});

test("«Обновить» загружает новую версию: id документа в строке запроса", async () => {
  const app = await openApp({ routes: { "/public/knowledge": ENABLED, "POST /public/knowledge/uploads": { id: "u2", status: "queued" } } });
  try {
    await app.openScreen("knowledge");
    await app.page.waitForSelector("[data-knowledge-document]");
    const chooser = app.page.waitForEvent("filechooser");
    await app.page.click('[data-knowledge-replace="0a000000-0000-4000-8000-00000000000a"]');
    await (await chooser).setFiles({ name: "Договор аренды.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
    await app.page.waitForTimeout(300);
    const upload = app.requests.find((item) => item.method === "POST" && item.path === "/public/knowledge/uploads");
    assert.ok(upload, "загрузка не ушла");
    assert.equal(upload.search, "?replaces=0a000000-0000-4000-8000-00000000000a");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("очистка базы — только после подтверждения и с confirm:true в теле", async () => {
  const app = await openApp({ routes: { "/public/knowledge": ENABLED, "DELETE /public/knowledge/documents": { deleted: 2 } } });
  try {
    await app.openScreen("knowledge");
    await app.page.waitForSelector("#knowledge-clear");
    await app.page.click("#knowledge-clear");
    await app.page.waitForSelector("#confirm-dialog[open]");
    assert.ok(!app.requests.some((item) => item.method === "DELETE"), "очистка ушла без подтверждения");
    await app.page.click("#confirm-accept");
    await app.page.waitForTimeout(200);
    const clear = app.requests.find((item) => item.method === "DELETE" && item.path === "/public/knowledge/documents");
    assert.ok(clear, "очистка не ушла");
    assert.deepEqual(clear.body, { confirm: true });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("документов больше, чем в списке — это видно, и подтверждение очистки называет все", async () => {
  const app = await openApp({ routes: { "/public/knowledge": { ...ENABLED, total: 350 } } });
  try {
    await app.openScreen("knowledge");
    await app.page.waitForSelector("[data-knowledge-document]");
    assert.match(await app.page.textContent("#knowledge-content"), /показаны 2 из 350/u);
    await app.page.click("#knowledge-clear");
    await app.page.waitForSelector("#confirm-dialog[open]");
    assert.match(await app.page.textContent("#confirm-dialog"), /\(350\)/u, "подтверждение называет не все документы");
  } finally {
    await app.close();
  }
});

test("неудавшаяся загрузка — понятная причина, а не код; удалённый документ — «уже удалён»", async () => {
  const failed = { id: "0d000000-0000-4000-8000-00000000000d", name: "Скан.pdf", size_bytes: 1024, status: "failed", outcome: null,
    error_code: "document_pdf_malformed_or_encrypted", created_at: "2026-08-14T08:50:00.000Z" };
  const app = await openApp({ routes: {
    "/public/knowledge": { ...ENABLED, uploads: [...UPLOADS, failed] },
    "DELETE /public/knowledge/documents/0a000000-0000-4000-8000-00000000000a": { __status: 404, __body: { error: { code: "not_found", message: "Документ не найден" } } },
  } });
  try {
    await app.openScreen("knowledge");
    await app.page.waitForSelector("[data-knowledge-document]");
    const text = await app.page.textContent("#knowledge-content");
    assert.match(text, /PDF повреждён или защищён паролем/u);
    assert.doesNotMatch(text, /document_pdf_malformed/u);
    await app.page.click('[data-knowledge-delete="0a000000-0000-4000-8000-00000000000a"]');
    await app.page.waitForSelector("#confirm-dialog[open]");
    await app.page.click("#confirm-accept");
    await app.page.waitForFunction(() => /уже удалён/u.test(document.body.textContent || ""));
  } finally {
    await app.close();
  }
});

for (const device of PHONES) {
  test(`пять кнопок меню помещаются: ${device.name}`, async () => {
    const app = await openApp({ viewport: { width: device.width, height: device.height }, routes: { "/public/knowledge": ENABLED } });
    try {
      await app.page.waitForSelector('.nav-item[data-target="knowledge"]:not([hidden])');
      await app.openScreen("knowledge");
      await app.page.waitForSelector("[data-knowledge-document]");
      const width = await documentWidth(app.page);
      assert.ok(width.document <= width.screen, `горизонтальная прокрутка: ${width.document} > ${width.screen}`);
      const label = await app.page.$eval('.nav-item[data-target="knowledge"] b', (node) => {
        const box = node.getBoundingClientRect();
        const parent = node.parentElement.getBoundingClientRect();
        return { overflow: box.right > parent.right + 1 || box.left < parent.left - 1 };
      });
      assert.equal(label.overflow, false, "подпись вкладки не помещается");
    } finally {
      await app.close();
    }
  });
}
