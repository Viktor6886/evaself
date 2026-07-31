/**
 * Разметка ответов в Telegram.
 *
 * Сообщения уходили без parse_mode, и пользователь видел сырой markdown:
 * «**Сегодня в Перми:** +21..+23°C». Здесь проверяется перевод в HTML,
 * который Telegram действительно принимает, и — что важнее — что ни один
 * обычный текст не превращается в невалидную разметку: за неё Telegram
 * отвечает 400, и ответ Евы не доходит вовсе.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  escapeHtml,
  isValidTelegramHtml,
  markdownToTelegramHtml,
  splitTelegramHtml,
  stripTags,
} from "../dist/telegram-format.js";

const md = markdownToTelegramHtml;

describe("перевод markdown в HTML Telegram", () => {
  test("жирный, курсив, зачёркнутый", () => {
    assert.equal(md("**Сегодня в Перми:** тепло"), "<b>Сегодня в Перми:</b> тепло");
    assert.equal(md("это *важно* сейчас"), "это <i>важно</i> сейчас");
    assert.equal(md("это _важно_ сейчас"), "это <i>важно</i> сейчас");
    assert.equal(md("__точно__ так"), "<b>точно</b> так");
    assert.equal(md("~~было~~ стало"), "<s>было</s> стало");
    assert.equal(md("***очень важно***"), "<b><i>очень важно</i></b>");
  });

  test("именно тот случай со скриншота", () => {
    const source = [
      "**Сегодня в Перми:** +21..+23°C, без осадков, лёгкий ветер",
      "**Завтра:** +17..+20°C, дождь, умеренный ветер",
    ].join("\n");
    assert.equal(md(source), [
      "<b>Сегодня в Перми:</b> +21..+23°C, без осадков, лёгкий ветер",
      "<b>Завтра:</b> +17..+20°C, дождь, умеренный ветер",
    ].join("\n"));
  });

  test("списки получают настоящий буллет", () => {
    assert.equal(
      md("- **ЖКХ:** привели в порядок\n- **Суды:** взыскание"),
      "• <b>ЖКХ:</b> привели в порядок\n• <b>Суды:</b> взыскание",
    );
  });

  test("нумерованный список сохраняет номера", () => {
    assert.equal(md("1. Первое\n2. Второе"), "1. Первое\n2. Второе");
  });

  test("заголовки становятся жирной строкой", () => {
    // Своих заголовков в Telegram нет, а «###» в тексте — мусор.
    assert.equal(md("# Ипотека сейчас vs. ожидание"), "<b>Ипотека сейчас vs. ожидание</b>");
    assert.equal(md("## Почему «ждать» опасно"), "<b>Почему «ждать» опасно</b>");
  });

  test("ссылки", () => {
    assert.equal(
      md("[59.ru — новости](https://59.ru/text/2026/07/31/)"),
      '<a href="https://59.ru/text/2026/07/31/">59.ru — новости</a>',
    );
  });

  test("опасная схема в ссылке не проходит", () => {
    // Модель может подставить что угодно из результата поиска.
    const out = md("[клик](javascript:alert(1))");
    assert.ok(!out.includes("<a"), "javascript: не должен стать ссылкой");
    assert.ok(!out.includes("javascript:"));
  });

  test("код и блоки кода", () => {
    assert.equal(md("вот `git status` команда"), "вот <code>git status</code> команда");
    assert.equal(
      md("```bash\nmake update\n```"),
      '<pre><code class="language-bash">make update</code></pre>',
    );
  });

  test("разметка внутри кода остаётся текстом", () => {
    assert.equal(md("`a ** b`"), "<code>a ** b</code>");
  });

  test("числа в тексте не путаются с метками кода", () => {
    // Ранняя версия помечала вырезанный код как « 0 » и съедала любой
    // номер в тексте пользователя.
    assert.equal(md("у меня 0 яблок и 1 груша"), "у меня 0 яблок и 1 груша");
    assert.equal(md("`код` и 0 и 1"), "<code>код</code> и 0 и 1");
  });

  test("цитата", () => {
    assert.equal(md("> так сказал классик"), "<blockquote>так сказал классик</blockquote>");
  });
});

describe("безопасность разметки", () => {
  test("угловые скобки экранируются", () => {
    assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
    assert.ok(!md("текст <script>alert(1)</script>").includes("<script>"));
  });

  test("амперсанд не ломает разметку", () => {
    assert.equal(md("Рога & Копыта"), "Рога &amp; Копыта");
  });

  test("подчёркивание внутри слова не рвёт текст", () => {
    // file_name_here не должен превратиться в курсив.
    assert.equal(md("файл file_name_here.txt"), "файл file_name_here.txt");
  });

  test("одиночная звёздочка и математика переживают перевод", () => {
    for (const text of [
      "5 * 3 = 15",
      "a < b и c > d",
      "звёздочка * просто так",
      "50% скидка",
      "путь C:\\Users\\test",
    ]) {
      const html = md(text);
      assert.ok(isValidTelegramHtml(html), `невалидный HTML для «${text}»: ${html}`);
    }
  });

  test("любой обычный текст даёт валидную разметку", () => {
    const samples = [
      "Привет, Виктор 😄",
      "**незакрытый жирный",
      "[ссылка без url]",
      "```без закрывающей ограды\nкод",
      "смайлик <3 и стрелка ->",
      "",
      "\n\n\n",
    ];
    for (const sample of samples) {
      assert.ok(isValidTelegramHtml(md(sample)), `невалидно для ${JSON.stringify(sample)}`);
    }
  });
});

describe("проверка валидности HTML", () => {
  test("принимает поддерживаемые теги", () => {
    assert.equal(isValidTelegramHtml("<b>жирный</b> и <i>курсив</i>"), true);
    assert.equal(isValidTelegramHtml('<a href="https://x.ru">тут</a>'), true);
  });

  test("отвергает чужой тег", () => {
    // Telegram отвечает 400 на неподдерживаемый тег, и сообщение теряется.
    assert.equal(isValidTelegramHtml("<div>текст</div>"), false);
    assert.equal(isValidTelegramHtml("<script>x</script>"), false);
  });

  test("отвергает незакрытый и перепутанный тег", () => {
    assert.equal(isValidTelegramHtml("<b>жирный"), false);
    assert.equal(isValidTelegramHtml("<b><i>текст</b></i>"), false);
  });
});

describe("разбиение длинных ответов", () => {
  test("короткий текст не режется", () => {
    assert.deepEqual(splitTelegramHtml("<b>коротко</b>"), ["<b>коротко</b>"]);
  });

  test("каждый кусок остаётся валидным", () => {
    const long = Array.from({ length: 200 }, (_, i) => `• <b>Пункт ${i}</b> с текстом`).join("\n");
    const chunks = splitTelegramHtml(long, 1_000);

    assert.ok(chunks.length > 1, "длинный текст должен разрезаться");
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 1_000, `кусок длиннее лимита: ${chunk.length}`);
      assert.ok(isValidTelegramHtml(chunk), `невалидный кусок: ${chunk.slice(0, 80)}`);
    }
  });

  test("разрез не рассекает тег пополам", () => {
    const long = `<b>${"я".repeat(3_000)}</b> хвост`;
    for (const chunk of splitTelegramHtml(long, 500)) {
      assert.ok(isValidTelegramHtml(chunk) || !chunk.includes("<"), "тег разрезан");
    }
  });
});

test("аварийный откат возвращает читаемый текст", () => {
  assert.equal(stripTags("<b>Привет</b>, Виктор"), "Привет, Виктор");
  assert.equal(stripTags("Рога &amp; Копыта"), "Рога & Копыта");
});
