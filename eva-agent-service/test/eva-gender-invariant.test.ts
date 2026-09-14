import assert from "node:assert/strict";
import { test } from "node:test";

import {
  feminineForm,
  feminizeSelfReference,
  normalizeReplyGender,
} from "../dist/i18n/eva-gender.js";

const fix = (text: string) => feminizeSelfReference(text).text;

test("Ева не оставляет мужской род в частых нерегулярных формах", () => {
  assert.equal(fix("Я устал и замёрз."), "Я устала и замёрзла.");
  assert.equal(fix("Я устал и замерз."), "Я устала и замерзла.");
  assert.equal(fix("Я был вынужден это проверить."), "Я была вынуждена это проверить.");
  assert.equal(fix("Я убеждён, что это верно."), "Я убеждена, что это верно.");
  assert.equal(fix("Я заинтересован в результате."), "Я заинтересована в результате.");
  assert.equal(fix("Я сосредоточен на задаче."), "Я сосредоточена на задаче.");
  assert.equal(fix("Я озадачен результатом."), "Я озадачена результатом.");
  assert.equal(fix("Я впечатлён прогрессом."), "Я впечатлена прогрессом.");
});

test("нерегулярные формы доступны единому выходному барьеру", () => {
  assert.equal(feminineForm("замёрз"), "замёрзла");
  assert.equal(feminineForm("Вынужден"), "Вынуждена");
  assert.equal(
    normalizeReplyGender("Я замёрз, но я готов продолжать.", null).text,
    "Я замёрзла, но я готова продолжать.",
  );
});

test("усиление не меняет цитаты, код и фразы пользователя", () => {
  assert.equal(
    fix("Ты написал: «я замёрз и был вынужден уйти»."),
    "Ты написал: «я замёрз и был вынужден уйти».",
  );
  assert.equal(fix("В коде `я замёрз`."), "В коде `я замёрз`.");
  assert.equal(
    fix("Попробуй сказать: я замёрз и был вынужден уйти."),
    "Попробуй сказать: я замёрз и был вынужден уйти.",
  );
});
