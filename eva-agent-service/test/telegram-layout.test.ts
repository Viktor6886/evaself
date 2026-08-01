/**
 * Оформление сообщений Евы: цитаты, спойлеры, сборка из структуры,
 * разбиение длинных ответов и поведение при отказе Telegram.
 *
 * Десять типов сообщений из приёмки проверяются здесь целиком — от
 * исходного текста до того, что уйдёт в sendMessage.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  formatEvaReply,
  isValidTelegramHtml,
  markdownToTelegramHtml,
  parseEvaMessage,
  renderEvaMessage,
  splitTelegramHtml,
  stripTags,
} from "../dist/telegram-format.js";

const md = markdownToTelegramHtml;
/** Всё, что уходит в Telegram, обязано быть валидным. */
const assertValid = (html: string, label: string) => {
  assert.ok(isValidTelegramHtml(html), `невалидный HTML (${label}): ${html.slice(0, 160)}`);
};

// ---------------------------------------------------------------------
describe("новые блоки разметки", () => {
  test("обычная цитата для главного вывода", () => {
    assert.equal(md("> Выбери одну задачу на сегодня"),
      "<blockquote>Выбери одну задачу на сегодня</blockquote>");
  });

  test("сворачиваемая цитата через >>", () => {
    assert.equal(md(">> Длинное пояснение"),
      "<blockquote expandable>Длинное пояснение</blockquote>");
  });

  test("многострочная цитата собирается в один блок", () => {
    assert.equal(md("> Первая строка\n> Вторая строка"),
      "<blockquote>Первая строка\nВторая строка</blockquote>");
  });

  test("скрытый текст через ||", () => {
    assert.equal(md("||это спойлер||"), "<tg-spoiler>это спойлер</tg-spoiler>");
  });

  test("разметка внутри спойлера работает", () => {
    assert.equal(md("||**важное** внутри||"),
      "<tg-spoiler><b>важное</b> внутри</tg-spoiler>");
  });

  test("одиночная вертикальная черта не ломает текст", () => {
    const html = md("Полная лента 59.ru | Рифей-Пермь");
    assert.equal(html, "Полная лента 59.ru | Рифей-Пермь");
    assertValid(html, "одиночная черта");
  });
});

// ---------------------------------------------------------------------
describe("сборка сообщения из структуры", () => {
  const full = {
    title: "Похоже, сейчас тебе не хватает ясности",
    intro: "Ты одновременно решаешь несколько задач, поэтому внимание переключается.",
    key_point: "Выбери одну задачу на 30–60 минут, остальные отложи.",
    body: ["записать все задачи", "выбрать самую важную", "определить первый шаг"],
    hidden_text: "Попытка сделать всё сразу даёт занятость без завершённости.",
    details: "К".repeat(400),
    action: "Какую одну задачу выберешь сейчас?",
  };

  test("каждый раздел попадает в свой блок", () => {
    const html = renderEvaMessage(full);
    assertValid(html, "полная структура");

    assert.match(html, /^<b>Похоже, сейчас тебе не хватает ясности<\/b>/);
    assert.match(html, /<blockquote><b>Главное<\/b>\n/);
    assert.match(html, /<tg-spoiler>Попытка сделать всё сразу/);
    // Длинное пояснение сворачивается, короткое — нет.
    assert.match(html, /<blockquote expandable><b>Подробнее<\/b>/);
    // Вопрос последним и жирным: с ним пользователь остаётся.
    assert.match(html, /<b>Какую одну задачу выберешь сейчас\?<\/b>$/);
    // Несколько пунктов — список.
    assert.match(html, /• записать все задачи\n• выбрать самую важную/);
  });

  test("пустые разделы не выводятся", () => {
    const html = renderEvaMessage({ title: "Заголовок", intro: "Текст", key_point: "" });
    assert.ok(!html.includes("<blockquote"), "пустая цитата выглядит как ошибка вёрстки");
    assert.ok(!html.includes("<tg-spoiler"));
    assertValid(html, "пустые разделы");
  });

  test("короткий ответ не перегружается оформлением", () => {
    const html = renderEvaMessage({ intro: "Да, в 13:00 напомню." });
    assert.equal(html, "Да, в 13:00 напомню.");
  });

  test("короткое пояснение не прячется под «Подробнее»", () => {
    const html = renderEvaMessage({
      title: "Итог", details: "Две строки пояснения, прятать незачем.",
    });
    assert.ok(!html.includes("expandable"), "лишний клик ради двух строк");
  });

  test("пользовательский ввод в структуре экранируется", () => {
    const html = renderEvaMessage({
      title: "<script>alert(1)</script>",
      key_point: "Рога & Копыта",
      hidden_text: "a < b > c",
    });
    assert.ok(!html.includes("<script>"), "тег из данных не должен ожить");
    assert.match(html, /&amp;/);
    assert.match(html, /&lt;/);
    assertValid(html, "экранирование структуры");
  });
});

// ---------------------------------------------------------------------
describe("разбор структуры из ответа модели", () => {
  test("JSON в ограде распознаётся", () => {
    const parts = parseEvaMessage('```json\n{"title":"Т","key_point":"К"}\n```');
    assert.equal(parts?.title, "Т");
    assert.equal(parts?.key_point, "К");
  });

  test("голый JSON тоже", () => {
    assert.equal(parseEvaMessage('{"intro":"привет"}')?.intro, "привет");
  });

  test("обычный текст структурой не считается", () => {
    // Требовать JSON от агента в цикле с инструментами — верный способ
    // иногда получать пустое сообщение вместо ответа.
    assert.equal(parseEvaMessage("Просто ответ от Евы"), null);
    assert.equal(parseEvaMessage("Стоимость: {примерно 5000 руб}"), null);
  });

  test("чужой JSON не превращается в сообщение", () => {
    assert.equal(parseEvaMessage('{"temperature":21,"city":"Пермь"}'), null);
  });

  test("битый JSON откатывается на markdown", () => {
    const html = formatEvaReply('{"title": "не закрыт');
    assertValid(html, "битый json");
    assert.ok(html.includes("не закрыт"));
  });

  test("formatEvaReply выбирает путь сам", () => {
    assert.match(formatEvaReply('{"title":"Итог","intro":"текст"}'), /^<b>Итог<\/b>/);
    assert.equal(formatEvaReply("**жирный** ответ"), "<b>жирный</b> ответ");
  });
});

// ---------------------------------------------------------------------
describe("десять типов сообщений из приёмки", () => {
  const cases: Array<[string, string]> = [
    ["короткий ответ", "Да, договорились 👍"],
    ["длинный анализ", `# Итоги недели\n\n${"Разбор ситуации. ".repeat(120)}\n\n> Главное: отдохни`],
    ["результат теста", "**Результат:** 42 из 60\n\n- внимание: 8\n- энергия: 6\n\n> Стоит выспаться"],
    ["сообщение со ссылкой", "Смотри [59.ru](https://59.ru/text/2026/07/31/) — там подробности"],
    ["спецсимволы", "Цена < 5000 & доставка > 2 дней; путь C:\\Users\\test; 50% скидка"],
    ["спойлер", "Ответ на задание: ||сорок два||"],
    ["обычная цитата", "> Выбери одну задачу и начни с неё"],
    ["сворачиваемая цитата", `>> ${"Подробное объяснение механики. ".repeat(30)}`],
    ["сообщение с кнопками", "Выбери вариант подписки ниже"],
    ["длиннее 4096", "Очень длинный ответ. ".repeat(400)],
    ["напоминание", "⏰ **13:00** — исследование рынка\n\n> Начни с одного конкурента"],
    ["квота", "Голосовые на сегодня закончились.\n\n||Обновится в полночь по твоему времени||"],
  ];

  for (const [label, source] of cases) {
    test(label, () => {
      const html = formatEvaReply(source);
      assertValid(html, label);
      // HTML-теги не должны показаться пользователю как текст.
      assert.ok(!/&lt;(b|i|blockquote|tg-spoiler)&gt;/.test(html), "тег утёк в видимый текст");

      for (const chunk of splitTelegramHtml(html)) {
        assertValid(chunk, `${label} — кусок`);
        assert.ok(
          chunk.replace(/<\/?[a-z][a-z-]*[^>]*>/gi, "").length <= 4_096,
          `${label}: кусок длиннее предела Telegram`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------
describe("разбиение длинных сообщений", () => {
  test("цитата не разрывается посередине", () => {
    const quote = `<blockquote>${"Длинная цитата. ".repeat(60)}</blockquote>`;
    const html = `<b>Заголовок</b>\n\n${quote}\n\n${"Хвост. ".repeat(300)}`;

    for (const chunk of splitTelegramHtml(html, 800)) {
      assertValid(chunk, "разрыв цитаты");
      const opened = (chunk.match(/<blockquote/g) ?? []).length;
      const closed = (chunk.match(/<\/blockquote>/g) ?? []).length;
      assert.equal(opened, closed, `половина цитаты в куске: ${chunk.slice(0, 100)}`);
    }
  });

  test("спойлер не разрывается посередине", () => {
    const html = `${"Вступление. ".repeat(60)}<tg-spoiler>${"Тайна. ".repeat(40)}</tg-spoiler>`;
    for (const chunk of splitTelegramHtml(html, 500)) {
      const opened = (chunk.match(/<tg-spoiler>/g) ?? []).length;
      const closed = (chunk.match(/<\/tg-spoiler>/g) ?? []).length;
      assert.equal(opened, closed, "спойлер, разрезанный пополам, перестаёт быть спойлером");
    }
  });

  test("порядок частей сохраняется", () => {
    const html = ["<b>Раз</b>", "<b>Два</b>", "<b>Три</b>", "Хвост ".repeat(400)].join("\n");
    const joined = splitTelegramHtml(html, 400).join(" ");
    assert.ok(joined.indexOf("Раз") < joined.indexOf("Два"));
    assert.ok(joined.indexOf("Два") < joined.indexOf("Три"));
  });

  test("блок длиннее лимита теряет обёртку, но не текст", () => {
    // Показать текст без цитаты лучше, чем не показать его вовсе.
    const html = `<blockquote>${"Слово ".repeat(2_000)}</blockquote>`;
    const chunks = splitTelegramHtml(html, 500);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assertValid(chunk, "переросший блок");
    assert.ok(chunks.join(" ").includes("Слово"));
  });

  test("короткое сообщение не режется", () => {
    assert.deepEqual(splitTelegramHtml("<b>коротко</b>"), ["<b>коротко</b>"]);
  });

  test("пустое сообщение не порождает пустых кусков", () => {
    assert.deepEqual(splitTelegramHtml("   "), []);
  });
});

// ---------------------------------------------------------------------
test("аварийный откат сохраняет текст всех новых блоков", () => {
  // Если Telegram всё же отвергнет разметку, сообщение уходит без неё —
  // но содержание при этом теряться не должно.
  const html = renderEvaMessage({
    title: "Итог", key_point: "Главное", hidden_text: "Скрытое", details: "Подробности",
  });
  const plain = stripTags(html);
  for (const word of ["Итог", "Главное", "Скрытое", "Подробности"]) {
    assert.ok(plain.includes(word), `${word} потерялось при откате`);
  }
  assert.ok(!plain.includes("<"), "теги остались в откате");
});
