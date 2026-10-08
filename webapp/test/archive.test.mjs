import assert from "node:assert/strict";
import { test } from "node:test";

import { documentWidth, openApp, smallTapTargets } from "./harness.mjs";

/**
 * «Мои данные» в профиле Mini App: архив в Excel (docs/data-archive.md).
 *
 * Главное: строки нет, пока функция выключена на сервере; выгрузка —
 * одна кнопка, и человеку сказано, что файл придёт в чат; загрузка идёт
 * в два шага — сначала «что добавится», запись только по второму нажатию
 * и именно того файла, что был в предпросмотре; память из файла не
 * пишется сама, а предлагается передать Еве.
 */

const ENABLED = { enabled: true, memory: true, max_bytes: 10 * 1024 * 1024 };
const SHA = "a".repeat(64);
const PREVIEW = {
  recognized: true,
  applied: false,
  file_sha256: SHA,
  sheets: [
    { id: "goals", name: "Цели", added: 2, existing: 1 },
    { id: "tasks", name: "Задачи и напоминания", added: 3, existing: 0 },
    { id: "journal", name: "Дневник", added: 0, existing: 4 },
  ],
  added_total: 5,
  existing_total: 5,
  errors: [{ sheet: "Задачи и напоминания", row: 7, message: "«Срок»: такой даты нет" }],
  error_count: 1,
  warnings: ["Цели «в работе» без отметки «Подтверждена мной» загружены черновиками: 1."],
  paused_actions: 1,
  read_only_sheets: ["Рабочие блоки", "Платежи"],
  memory_handoff: "Это из моего архива — то, что ты знала обо мне раньше.\n\nЧто Ева знает обо мне:\nЛюбит горы.",
};
const XLSX = { name: "eva-archive-2026-10-07.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("PK\u0003\u0004 архив") };

async function openArchive(app) {
  await app.openScreen("profile");
  await app.page.waitForSelector('[data-setting="archive"]');
  await app.page.click('[data-setting="archive"]');
  await app.page.waitForSelector("#archive-host #archive-export");
}

test("выключенная функция: строки «Мои данные» в профиле нет", async () => {
  const app = await openApp({ routes: { "/public/archive": { enabled: false, memory: false, max_bytes: 0 } } });
  try {
    await app.openScreen("profile");
    await app.page.waitForSelector(".ios-profile-groups");
    assert.equal(await app.page.$('[data-setting="archive"]'), null);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("строка в группе «Ева и данные»; выгрузка уходит одним запросом и сообщает про чат", async () => {
  const app = await openApp({
    routes: {
      "/public/archive": ENABLED,
      "POST /public/archive/export": { sent: true, filename: "eva-archive-2026-10-07.xlsx", sheets: 27, rows: 140, bytes: 26364 },
    },
  });
  try {
    await app.openScreen("profile");
    await app.page.waitForSelector('[data-setting="archive"]');
    const group = await app.page.$eval('[data-setting="archive"]', (row) =>
      row.closest(".ios-profile-group")?.querySelector(".ios-profile-label")?.textContent);
    assert.equal(group, "Ева и данные");
    await app.page.click('[data-setting="archive"]');
    await app.page.waitForSelector("#archive-host #archive-export");
    const intro = await app.page.textContent("#archive-host");
    assert.match(intro, /придёт в чат с Евой/);
    assert.match(intro, /то, что Ева знает о тебе/);
    assert.match(intro, /только добавляет/);

    await app.page.click("#archive-export");
    await app.page.waitForSelector("#archive-exported");
    assert.match(await app.page.textContent("#archive-exported"), /eva-archive-2026-10-07\.xlsx/);
    const exports = app.requests.filter((item) => item.method === "POST" && item.path === "/public/archive/export");
    assert.equal(exports.length, 1);
    assert.ok(await app.page.isVisible("#archive-open-chat"));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("загрузка: предпросмотр, затем запись того же файла по отметке; память предлагается передать Еве", async () => {
  const app = await openApp({
    routes: {
      "/public/archive": ENABLED,
      "POST /public/archive/import/preview": PREVIEW,
      "POST /public/archive/import": { ...PREVIEW, applied: true, errors: [], error_count: 0 },
    },
  });
  try {
    await openArchive(app);
    await app.page.setInputFiles("#archive-file", XLSX);
    await app.page.waitForSelector("#archive-preview");
    const preview = app.requests.find((item) => item.method === "POST" && item.path === "/public/archive/import/preview");
    assert.ok(preview, "предпросмотр не запрошен");
    assert.match(String(preview.body), /name="file"; filename="eva-archive-2026-10-07\.xlsx"/);
    assert.equal(app.requests.some((item) => item.path === "/public/archive/import"), false, "запись до подтверждения");

    const text = await app.page.textContent("#archive-preview");
    assert.match(text, /Цели\s*\+2\s*уже есть: 1/);
    assert.match(text, /Дневник\s*—\s*уже есть: 4/);
    assert.match(text, /Поручений Еве: 1/);
    assert.match(text, /черновиками: 1/);
    assert.match(text, /Строки с ошибками: 1/);
    assert.match(text, /«Рабочие блоки», «Платежи»/);
    assert.match(text, /Память Евы из файла сама в память не записывается/);
    assert.match(await app.page.textContent("#archive-apply"), /Добавить 5 записей/);

    await app.page.click("#archive-apply");
    await app.page.waitForSelector("#archive-result");
    const applied = app.requests.find((item) => item.method === "POST" && item.path === "/public/archive/import");
    assert.ok(applied, "запись не ушла");
    assert.equal(applied.search, `?sha256=${SHA}`);
    assert.match(String(applied.body), /name="file"; filename="eva-archive-2026-10-07\.xlsx"/);
    assert.match(await app.page.textContent("#archive-result"), /Добавлено: 5 записей/);

    await app.page.click("#archive-handoff");
    await app.page.waitForSelector("#open-eva-chat");
    assert.match(await app.page.textContent("#sheet-content"), /Любит горы/);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("загрузка: всё уже есть — кнопки «Добавить» нет; ошибка сервера показана словами", async () => {
  let calls = 0;
  const app = await openApp({
    routes: {
      "/public/archive": ENABLED,
      "POST /public/archive/import/preview": () => {
        calls += 1;
        return calls === 1
          ? { ...PREVIEW, sheets: [{ id: "goals", name: "Цели", added: 0, existing: 3 }], added_total: 0, existing_total: 3,
            errors: [], error_count: 0, warnings: [], paused_actions: 0, read_only_sheets: [], memory_handoff: null }
          : { __status: 400, __body: { error: { code: "bad_request", message: "Это не файл Excel (.xlsx). Загрузи архив, выгруженный из Евы." } } };
      },
    },
  });
  try {
    await openArchive(app);
    await app.page.setInputFiles("#archive-file", XLSX);
    await app.page.waitForSelector("#archive-preview");
    assert.match(await app.page.textContent("#archive-preview"), /Новых записей нет/);
    assert.equal(await app.page.$("#archive-apply"), null);
    await app.page.click("#archive-back");
    await app.page.waitForSelector("#archive-pick");
    await app.page.setInputFiles("#archive-file", XLSX);
    await app.page.waitForSelector(".toast, #toast", { timeout: 3_000 }).catch(() => undefined);
    await app.page.waitForTimeout(200);
    assert.match(await app.page.textContent("body"), /Это не файл Excel/);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("не .xlsx файл не уходит на сервер", async () => {
  const app = await openApp({ routes: { "/public/archive": ENABLED } });
  try {
    await openArchive(app);
    await app.page.setInputFiles("#archive-file", { name: "заметки.csv", mimeType: "text/csv", buffer: Buffer.from("a,b") });
    await app.page.waitForTimeout(200);
    assert.equal(app.requests.some((item) => item.path.startsWith("/public/archive/import")), false);
    assert.match(await app.page.textContent("body"), /Нужен файл Excel/);
  } finally {
    await app.close();
  }
});

test("на 320 пикселях без боковой прокрутки, кнопки не мельче 44", async () => {
  const app = await openApp({
    viewport: { width: 320, height: 568 },
    routes: { "/public/archive": ENABLED, "POST /public/archive/import/preview": PREVIEW },
  });
  try {
    await openArchive(app);
    await app.page.setInputFiles("#archive-file", XLSX);
    await app.page.waitForSelector("#archive-preview");
    const width = await documentWidth(app.page);
    assert.ok(width.document <= width.screen, `боковая прокрутка: ${width.document} > ${width.screen}`);
    const small = (await smallTapTargets(app.page)).filter((item) => /archive/.test(item.className) || /Добавить|Отмена/.test(item.text));
    assert.deepEqual(small, []);
  } finally {
    await app.close();
  }
});
