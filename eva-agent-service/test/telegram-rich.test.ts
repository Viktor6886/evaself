import assert from "node:assert/strict";
import test from "node:test";

import {
  TelegramApiError,
  TelegramClient,
} from "../dist/telegram.js";
import {
  richMarkdownForTelegram,
  speechTextFromReply,
} from "../dist/telegram-format.js";

function client() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const telegram = new TelegramClient(
    { telegramBotToken: "test-token", telegramApiBaseUrl: "https://api.telegram.invalid" } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  telegram.call = async (method, body) => {
    calls.push({ method, body });
    if (method === "sendRichMessage" || method === "sendMessage") return { message_id: 701 } as never;
    return true as never;
  };
  return { telegram, calls };
}

const richReply = [
  "# Сравнение",
  "",
  "> **Главное:** B лучше подходит.",
  "",
  "| Вариант | Цена | Итог |",
  "|---|---:|---|",
  "| A | 500 ₽ | нормально |",
  "| B | 700 ₽ | **лучше** |",
  "",
  "<details><summary>Почему</summary>",
  "У B выше качество.",
  "</details>",
  "",
  "||Цена может измениться.||",
].join("\n");

test("safe rich markdown keeps quote, spoiler, details and native table", () => {
  const markdown = richMarkdownForTelegram(richReply);
  assert.match(markdown, /^# Сравнение/m);
  assert.match(markdown, /^\| Вариант \| Цена \| Итог \|/m);
  assert.match(markdown, /<details><summary>Почему<\/summary>/);
  assert.match(markdown, /\|\|Цена может измениться\.\|\|/);
});

test("legacy double quote becomes native collapsible details", () => {
  const markdown = richMarkdownForTelegram(">> Длинная второстепенная деталь\n>> продолжение");
  assert.equal(
    markdown,
    "<details><summary>Подробнее</summary>\nДлинная второстепенная деталь\nпродолжение\n</details>",
  );
});

test("rich markdown removes model-controlled media, map and custom rich actions", () => {
  const source = [
    "Текст",
    "![](https://example.com/a.jpg)",
    '<tg-map lat="1" long="2"/>',
    "<tg-collage><img src=\"https://example.com/a.jpg\"/></tg-collage>",
    "<tg-thinking>secret</tg-thinking>",
  ].join("\n");
  const markdown = richMarkdownForTelegram(source);
  assert.doesNotMatch(markdown, /!\[|tg-map|tg-collage|<img|tg-thinking/i);
  assert.match(markdown, /Текст/);
});

test("code and pre stay literal while the same media syntax outside code is blocked", () => {
  const source = "`<img src=x>`\n\n```html\n<tg-map lat=\"1\"/>\n![](https://example.com/a.jpg)\n```\n\n![](https://example.com/live.jpg)";
  const markdown = richMarkdownForTelegram(source);
  assert.match(markdown, /`<img src=x>`/);
  assert.match(markdown, /```html[\s\S]*<tg-map lat="1"\/>[\s\S]*!\[\]/);
  assert.doesNotMatch(markdown, /live\.jpg/);
});

test("assistant reply is sent as a Telegram rich message", async () => {
  const { telegram, calls } = client();
  await telegram.sendAssistantMessage(42, richReply);
  assert.equal(calls[0]?.method, "sendRichMessage");
  assert.deepEqual(calls[0]?.body.rich_message, {
    markdown: richMarkdownForTelegram(richReply),
    skip_entity_detection: false,
  });
});

test("rich streaming edits the same persistent message and adds keyboard only at finish", async () => {
  const { telegram, calls } = client();
  const live = telegram.startLiveMessage(42, { intervalMs: 0 });
  live.push("# Сравнение");
  await new Promise((resolve) => setTimeout(resolve, 20));
  live.push(`${richReply}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const keyboard = { inline_keyboard: [[{ text: "B", callback_data: "opaque" }]] };
  await live.finish(richReply, keyboard);

  assert.equal(calls[0]?.method, "sendRichMessage");
  assert.ok(calls.slice(1).every((call) => call.method === "editMessageText"));
  assert.ok(calls.slice(1).every((call) => call.body.message_id === 701));
  assert.ok(calls.slice(0, -1).every((call) => !("reply_markup" in call.body)));
  assert.deepEqual(calls.at(-1)?.body.reply_markup, keyboard);
  assert.ok(calls.slice(1).every((call) => "rich_message" in call.body));
});

/**
 * «Печатает» во время растущего ответа.
 *
 * Telegram гасит индикатор на клиенте, как только от бота приходит
 * сообщение, — правка растущего ответа считается таким же приходом.
 * Поэтому его мало включить один раз: после каждой записи он снимается,
 * и человек видит курсор в конце текста, а под именем собеседника —
 * ничего. Прежде индикатор вдобавок снимался нарочно, на первом же
 * срезе: тогда появление сообщения означало готовый ответ.
 */
test("каждая правка растущего ответа переподтверждает «печатает»", async () => {
  const { telegram, calls } = client();
  const refreshes: number[] = [];
  const live = telegram.startLiveMessage(42, {
    intervalMs: 0,
    onUpdate: () => refreshes.push(calls.length),
  });
  live.push("Первая часть");
  await new Promise((resolve) => setTimeout(resolve, 20));
  live.push("Первая часть и вторая");
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Отправка и правка — каждая зовёт хук: обе гасят индикатор.
  assert.ok(refreshes.length >= 2, `ожидались отправка и правка, было ${refreshes.length}`);
  await live.finish("Первая часть и вторая");
  // Финальная правка хук не зовёт: она гасит индикатор на клиенте, и
  // ставить его заново значило бы обещать продолжение, которого нет.
  const afterFinish = refreshes.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(refreshes.length, afterFinish);
});

test("контроллер действия умеет переподтвердить то же самое действие", async () => {
  const { telegram, calls } = client();
  const controller = telegram.startChatActionController(42, 60_000);
  controller.transition("typing");
  const afterFirst = calls.filter((call) => call.method === "sendChatAction").length;
  assert.equal(afterFirst, 1);

  // transition при том же действии выходит сразу — иначе он сбивал бы
  // интервал. Для повтора есть refresh.
  controller.transition("typing");
  assert.equal(calls.filter((call) => call.method === "sendChatAction").length, 1);

  controller.refresh();
  assert.equal(calls.filter((call) => call.method === "sendChatAction").length, 2);
  controller.stop();
  controller.refresh();
  assert.equal(calls.filter((call) => call.method === "sendChatAction").length, 2,
    "после остановки индикатор не воскресает");
});

test("unsupported rich endpoint falls back to regular formatter without losing reply", async () => {
  const { telegram, calls } = client();
  telegram.call = async (method, body) => {
    calls.push({ method, body });
    if (method === "sendRichMessage") {
      throw new TelegramApiError("Telegram sendRichMessage: Bad Request: method not found");
    }
    return { message_id: 702 } as never;
  };
  const sent = await telegram.sendAssistantMessage(42, richReply);
  assert.deepEqual(calls.map((call) => call.method), ["sendRichMessage", "sendMessage"]);
  assert.equal(calls[1]?.body.parse_mode, "HTML");
  assert.equal(sent.length, 1);
});

test("TTS receives semantic text rather than rich markup or table syntax", () => {
  const speech = speechTextFromReply(richReply);
  assert.doesNotMatch(speech, /\|---|<details>|<\/details>|\|\||^#/m);
  assert.match(speech, /Сравнение/);
  assert.match(speech, /Вариант\. Цена\. Итог\./);
  assert.match(speech, /A\. 500 ₽\. нормально\./);
  assert.match(speech, /B\. 700 ₽\. лучше\./);
});
