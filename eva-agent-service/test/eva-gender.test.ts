/**
 * Женский род Евы на выходе.
 *
 * Ради чего файл существует — отрицательные проверки. Что правка НЕ
 * трогает: слова человека в кавычках, фразу, предложенную ему вслух,
 * чужое подлежащее и слова, для которых надёжного правила нет. Лишняя
 * правка хуже пропущенной: пропуск оставляет сегодняшнее положение дел,
 * а лишняя портит текст, которого никто не проверял.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  alignUserReference,
  explicitUserGrammaticalGender,
  feminineForm,
  feminizeSelfReference,
  normalizeReplyGender,
} from "../dist/i18n/eva-gender.js";

const fix = (text: string) => feminizeSelfReference(text).text;

test("короткая служебная реплика — самая частая ошибка — исправляется", () => {
  assert.equal(fix("Понял."), "Поняла.");
  assert.equal(fix("Приняла задачу. Сделал."), "Приняла задачу. Сделала.");
  assert.equal(fix("Готов!"), "Готова!");
  // Однородный ряд — тот же закрытый список, а не «что угодно за запятой».
  assert.equal(fix("Понял, записал."), "Поняла, записала.");
  assert.equal(fix("Понял, Пётр звонил."), "Поняла, Пётр звонил.");
});

test("сказуемое при «я» приводится к женскому роду", () => {
  assert.equal(fix("я понял тебя"), "я поняла тебя");
  assert.equal(fix("Я уже сохранил заметку."), "Я уже сохранила заметку.");
  assert.equal(fix("я не уверен в этом"), "я не уверена в этом");
  assert.equal(fix("Я был рядом, я нашёл ответ."), "Я была рядом, я нашла ответ.");
  assert.equal(fix("я должен признать"), "я должна признать");
  assert.equal(fix("я собрался с мыслями"), "я собралась с мыслями");
  assert.equal(fix("я смог помочь"), "я смогла помочь");
});

test("слова человека в кавычках остаются его словами", () => {
  assert.equal(
    fix("Ты написал: «я понял, что устал»."),
    "Ты написал: «я понял, что устал».",
  );
  assert.equal(fix('Он ответил "я готов" и ушёл.'), 'Он ответил "я готов" и ушёл.');
  assert.equal(fix("В коде было `я понял`."), "В коде было `я понял`.");
});

test("фраза, предложенная человеку, не меняет род", () => {
  assert.equal(
    fix("Попробуй сказать ему: я устал и мне тяжело."),
    "Попробуй сказать ему: я устал и мне тяжело.",
  );
  assert.equal(
    fix("Напиши ей: я подумал и решил остаться."),
    "Напиши ей: я подумал и решил остаться.",
  );
});

test("чужое подлежащее не трогается", () => {
  // Между «я» и словом стоит не служебное слово: подлежащее уже другое.
  assert.equal(fix("я думаю, Пётр опоздал"), "я думаю, Пётр опоздал");
  assert.equal(fix("твой друг понял тебя"), "твой друг понял тебя");
  assert.equal(fix("он сделал это сам"), "он сделал это сам");
});

test("подлежащее опущено — значит она: реплика без «я» тоже правится", () => {
  // Опущенное подлежащее в русском — это первое лицо. О человеке так не
  // говорят: о нём говорят с подлежащим.
  assert.equal(fix("Понял тебя."), "Поняла тебя.");
  assert.equal(fix("Был рад помочь."), "Была рада помочь.");
  assert.equal(fix("Записал, спасибо."), "Записала, спасибо.");
});

test("однородные сказуемые не оставляют половину предложения в мужском роде", () => {
  // Половина исправленного хуже, чем ничего: в одном предложении
  // оказывалось два рода сразу.
  assert.equal(
    fix("Я подумал и решил, что так лучше."),
    "Я подумала и решила, что так лучше.",
  );
  assert.equal(fix("Я устал и проголодался."), "Я устала и проголодалась.");
  // Известный предел: прошедшее время без «-л» правилом не выводится.
  // «Замёрз» → «замёрзла» требует словаря, а угадывать по окончанию
  // «-з» нельзя. Ряд на таком слове останавливается, а не портит его.
  assert.equal(fix("Я устал и замёрз."), "Я устала и замёрз.");
});

test("вводные слова между «я» и сказуемым не сбивают разбор", () => {
  assert.equal(fix("Я, кажется, понял, о чём ты."), "Я, кажется, поняла, о чём ты.");
  assert.equal(fix("Как я и говорил, это нормально."), "Как я и говорила, это нормально.");
  assert.equal(fix("Я тебе это уже говорил."), "Я тебе это уже говорила.");
});

test("чужое подлежащее обрывает ряд, а не подхватывается им", () => {
  // Разбор доходит до чужого подлежащего и останавливается: «он» и «ты»
  // исправить нечем, и дальше он не идёт.
  assert.equal(fix("Я спросил, он ответил уклончиво."), "Я спросила, он ответил уклончиво.");
  assert.equal(fix("Я думал, ты понял."), "Я думала, ты понял.");
  assert.equal(fix("Я и Пётр решили встретиться."), "Я и Пётр решили встретиться.");
});

test("вопрос человеку остаётся вопросом человеку", () => {
  // «Понял?» адресовано собеседнику, а не себе: вопросительный знак
  // выводит короткую реплику из-под правки намеренно.
  assert.equal(fix("Понял?"), "Понял?");
  assert.equal(fix("Ты понял меня?"), "Ты понял меня?");
  assert.equal(fix("Готов ли ты продолжить?"), "Готов ли ты продолжить?");
  // После «я» разбор останавливается на первом незнакомом слове:
  // дальше подлежащее уже не она.
  assert.equal(fix("я вижу, друг помог тебе"), "я вижу, друг помог тебе");
});

test("слово без надёжного правила остаётся как есть", () => {
  // «-г» общего правила не имеет: «я друг» — не «я другла».
  assert.equal(fix("я друг тебе"), "я друг тебе");
  assert.equal(fix("Хорошо."), "Хорошо.");
  assert.equal(fix("Спасибо!"), "Спасибо!");
  assert.equal(feminineForm("круг"), null);
  assert.equal(feminineForm("текст"), null);
});

test("исправленное перечисляется, а нетронутый текст возвращается тем же", () => {
  const untouched = "Расскажи, как прошёл твой день.";
  const result = feminizeSelfReference(untouched);
  assert.equal(result.text, untouched);
  assert.deepEqual(result.corrections, []);

  const fixed = feminizeSelfReference("Понял. Я сделал и я рад.");
  assert.deepEqual(fixed.corrections, ["понял→поняла", "сделал→сделала", "рад→рада"]);
  assert.equal(fixed.text, "Поняла. Я сделала и я рада.");
});

test("несколько правок в одной строке не сдвигают друг друга", () => {
  assert.equal(
    fix("Я записал, я проверил и я готов продолжать."),
    "Я записала, я проверила и я готова продолжать.",
  );
});

test("явное самоопределение пользователя распознаётся без догадки по имени", () => {
  assert.equal(explicitUserGrammaticalGender("Я мужчина."), "masculine");
  assert.equal(explicitUserGrammaticalGender("Я девушка из Перми"), "feminine");
  assert.equal(
    explicitUserGrammaticalGender("Обращайся ко мне в мужском роде"),
    "masculine",
  );
  assert.equal(explicitUserGrammaticalGender("Мой пол — мужской"), "masculine");
  assert.equal(
    explicitUserGrammaticalGender("Обращайся ко мне как к женщине"),
    "feminine",
  );
  assert.equal(explicitUserGrammaticalGender("Я не мужчина"), null);
  assert.equal(explicitUserGrammaticalGender("Виктор — мужчина"), null);
  assert.equal(explicitUserGrammaticalGender("Я мужчина. Я женщина."), null);
});

test("обращение через ты согласуется с подтверждённым мужским родом", () => {
  assert.equal(
    alignUserReference("Ты уже сделала всё, что могла.", "masculine").text,
    "Ты уже сделал всё, что могла.",
  );
  assert.equal(
    alignUserReference("Готова ли ты продолжить?", "masculine").text,
    "Готов ли ты продолжить?",
  );
  assert.equal(
    alignUserReference("Если ты устала, сделай паузу.", "masculine").text,
    "Если ты устал, сделай паузу.",
  );
  assert.equal(alignUserReference("Поняла меня?", "masculine").text, "Понял меня?");
  assert.equal(alignUserReference("Ты пришла?", "masculine").text, "Ты пришёл?");
  assert.equal(alignUserReference("Ты умная.", "masculine").text, "Ты умный.");
});

test("обращение через ты согласуется с подтверждённым женским родом", () => {
  assert.equal(
    alignUserReference("Ты не уверен, что готов?", "feminine").text,
    "Ты не уверена, что готов?",
  );
  assert.equal(
    alignUserReference("Готов ли ты продолжить?", "feminine").text,
    "Готова ли ты продолжить?",
  );
  assert.equal(alignUserReference("Устал?", "feminine").text, "Устала?");
  assert.equal(alignUserReference("Ты пришёл?", "feminine").text, "Ты пришла?");
  assert.equal(alignUserReference("Ты сильный.", "feminine").text, "Ты сильная.");
});

test("профиль пользователя не меняет цитаты, код и третьих лиц", () => {
  const original = "Ты сказал: «она устала». В коде `ты готова`. Пётр был рад.";
  assert.equal(alignUserReference(original, "masculine").text, original);
  assert.equal(alignUserReference("Она устала?", "masculine").text, "Она устала?");
  assert.equal(alignUserReference("Ты готова?", null).text, "Ты готова?");
  assert.equal(
    alignUserReference("Если пошла посылка, сообщи мне.", "masculine").text,
    "Если пошла посылка, сообщи мне.",
  );
  assert.equal(alignUserReference("Начался дождь?", "feminine").text, "Начался дождь?");
  assert.equal(
    alignUserReference("Ты устала, была проблема с сетью.", "masculine").text,
    "Ты устал, была проблема с сетью.",
  );
});

test("единый барьер различает род Евы и пользователя", () => {
  assert.equal(
    normalizeReplyGender("Я понял тебя. Ты устала?", "masculine").text,
    "Я поняла тебя. Ты устал?",
  );
  assert.equal(
    normalizeReplyGender("Я понял тебя. Ты устал?", "feminine").text,
    "Я поняла тебя. Ты устала?",
  );
  assert.equal(
    normalizeReplyGender("Я женщина, а ты женщина.", "masculine").text,
    "Я женщина, а ты мужчина.",
  );
});
