#!/usr/bin/env node

/**
 * Живая проверка: работает ли Ева на самом деле.
 *
 * Конфигурация — это намерение. Здесь проверяется поведение: помнит ли
 * Ева факт после настоящего сжатия истории, помнит ли его во втором
 * диалоге того же агента, обновляет ли устаревший факт, не превращает
 * ли сегодняшнее состояние в черту характера и остаются ли доступны
 * нативные возможности runtime.
 *
 * Нужен работающий App Server с настроенным провайдером модели: без
 * модели разговора нет, и притворяться, что проверка прошла, нельзя.
 *
 *   node scripts/smoke-eva-memory.mjs ws://127.0.0.1:4500 [токен]
 *
 * Скрипт создаёт временного агента, помеченного `evaself-smoke`, и
 * удаляет его за собой.
 */

import { readFile } from "node:fs/promises";

import { LettaService } from "../eva-agent-service/dist/letta.js";
import { evaluateReadiness } from "../eva-agent-service/dist/letta/readiness.js";

const url = process.argv[2] ?? process.env.LETTA_APP_SERVER_URL ?? "ws://127.0.0.1:4500";
const token = process.argv[3] ?? process.env.LETTA_APP_SERVER_TOKEN ?? "";
const silent = { debug() {}, info() {}, warn() {}, error() {} };

const service = new LettaService(
  {
    appServerUrl: url,
    appServerToken: token,
    appServerRequestTimeoutMs: 120_000,
    model: process.env.EVA_MODEL ?? "",
    sessionPoolSize: 3,
    sessionIdleMs: 120_000,
    turnTimeoutMs: 300_000,
    safeSessionManager: false,
    sessionDrainMs: 5_000,
  },
  silent,
  await readFile(new URL("../library/persona/eva.md", import.meta.url), "utf8"),
  await readFile(new URL("../library/system/letta_local_memfs.md", import.meta.url), "utf8"),
);

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const telegramId = 900_000 + Math.floor(Math.random() * 90_000);
let agentId = null;

/**
 * Продуктовые инструменты сессии.
 *
 * Без них проверка «продуктовый инструмент доступен» проверяла бы
 * пустоту: набор инструментов сессии складывается из нативных и тех,
 * что передал продукт. Здесь они настоящие по форме и безопасные по
 * содержанию — ни базы, ни сети, — и заодно дают увидеть, что Letta
 * действительно зовёт их сама.
 */
const toolCalls = [];
const smokeTool = (name, label, description, payload) => ({
  name,
  label,
  description,
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  execute: async () => {
    toolCalls.push(name);
    const text = JSON.stringify(payload);
    return { content: [{ type: "text", text }], details: payload };
  },
});
service.setToolFactory(() => [
  smokeTool(
    "get_user_time_context",
    "Время пользователя",
    "Текущие дата, время и часовой пояс пользователя. Вызывай, когда нужен ответ о времени.",
    { local_time: "2026-08-18T12:00:00+05:00", timezone: "Asia/Yekaterinburg" },
  ),
  smokeTool(
    "get_psychological_test_results",
    "Результаты тестов",
    "Результаты психологических тестов пользователя.",
    { status: "not_implemented", results: [] },
  ),
]);

try {
  agentId = await service.createAgent({ telegramId, displayName: "Smoke" });
  const first = await service.createConversation(agentId);
  const say = async (conversationId, text) =>
    (await service.runTurn(conversationId, text)).reply;

  // --- E. Нативные возможности ------------------------------------
  // Проверяются точными именами: расплывчатое совпадение по «task» или
  // «agent» зелёное всегда и не значит ничего. Тот же разбор, что
  // используется маршрутом готовности.
  await say(first, "Привет.");
  const productTools = ["get_user_time_context", "get_psychological_test_results"];
  const readiness = evaluateReadiness(service.observedRuntime, {
    productTools,
    dreamingTrigger: null,
    permissionMode: "standard",
    modelCatalogSize: -1,
  });
  for (const entry of readiness.checks) {
    if (entry.status === "not_reported") continue;
    check(`возможности: ${entry.name}`, entry.status === "ok", entry.detail);
  }

  // --- Продуктовый инструмент зовёт сама Letta ----------------------
  // Регистрация инструмента — это намерение. Факт — вызов: маршрут
  // готовности видит инструмент в наборе сессии, а здесь видно, что
  // модель к нему обратилась, когда он понадобился.
  toolCalls.length = 0;
  const timeAnswer = await say(first, "Который сейчас час у меня?");
  check(
    "инструменты: продуктовый инструмент вызван самой моделью",
    toolCalls.includes("get_user_time_context"),
    `вызовы: ${toolCalls.join(", ") || "нет"}; ответ: ${timeAnswer.slice(0, 80)}`,
  );

  // --- A. Факт переживает настоящее сжатие истории ------------------
  await say(first, "Моего брата зовут Сергей.");
  await say(first, "Кстати, сегодня был долгий день на работе.");
  await say(first, "Ещё я на выходных хочу съездить за город.");

  const before = (await service.listMessages(first, 200)).messages?.length ?? 0;
  const compaction = await service.requestCompaction(first);
  const after = (await service.listMessages(first, 200)).messages?.length ?? 0;
  // Сжатие подтверждается изменением состояния, а не тем, что вызов
  // вернул «ок» с непустым полем. Пустой ответ, отказ и «сжали ноль
  // сообщений» — это не сжатие: проверка, засчитывающая их, зелёная
  // всегда и не доказывает, что факт пережил именно сжатие.
  const detail = compaction.detail ?? {};
  const summarized = Number(
    detail.messagesSummarized ?? detail.messages_summarized ?? detail.summarized ?? Number.NaN,
  );
  const historyShrank = after < before;
  const runtimeReportedWork = Number.isFinite(summarized) ? summarized > 0 : historyShrank;
  check(
    "compaction: сжатие действительно произошло",
    compaction.ok === true && runtimeReportedWork,
    `сообщений было ${before}, стало ${after}; runtime: ${JSON.stringify(detail).slice(0, 200)}`,
  );

  const brother = await say(first, "Напомни, как зовут моего брата?");
  check("память: имя брата после сжатия", /Сергей/i.test(brother), brother.slice(0, 120));

  // --- B. Тот же агент, другой conversation -------------------------
  // Conversation — ветка сообщений, агент — постоянная сущность. Память
  // принадлежит агенту, а не ветке.
  const second = await service.createConversation(agentId);
  const brotherElsewhere = await say(second, "Как зовут моего брата?");
  check(
    "память: факт доступен в другом диалоге того же агента",
    /Сергей/i.test(brotherElsewhere),
    brotherElsewhere.slice(0, 120),
  );

  // --- C. Новое явное сообщение важнее старой записи ----------------
  await say(first, "Я работаю в компании «Астра».");
  await say(first, "Я уволился и теперь работаю в «Бореалис».");
  const employer = await say(second, "Где я сейчас работаю?");
  check(
    "память: устаревший факт обновлён, а не сложен рядом",
    /Бореалис/i.test(employer) && !/Астра/i.test(employer),
    employer.slice(0, 160),
  );

  // --- D. Временное состояние — не черта характера ------------------
  await say(first, "Сегодня я очень тревожный.");
  const traits = await say(second, "Опиши коротко, что ты знаешь обо мне как о человеке.");
  const traitClaim = /(ты|человек)\s+(очень\s+)?тревожн\w+(?!\s+(сегодня|сейчас))/i.test(traits)
    || /тревожность\s*[—-]\s*(тво|его)\w*\s+черт/i.test(traits);
  check(
    "память: сегодняшнее состояние не стало чертой характера",
    !traitClaim,
    traits.slice(0, 200),
  );

  // --- F. Психологический ответ -------------------------------------
  const psychological = await say(
    second,
    "Последние недели постоянно откладываю важный разговор с руководителем. "
    + "Каждый раз нахожу причину не начинать. Наверное, я просто трус.",
  );
  const bullets = (psychological.match(/^\s*(?:[-*•]|\d+[.)])\s+/gmu) ?? []).length;
  const questions = (psychological.match(/\?/gu) ?? []).length;
  check(
    "терапия: сначала понять, потом предлагать",
    bullets <= 2 && questions >= 1 && questions <= 2,
    `пунктов списка ${bullets}, вопросов ${questions}`,
  );
  check(
    "терапия: без диагноза",
    !/(депресси|тревожное расстройство|СДВГ|диагноз|расстройств\w+ личности)/i.test(psychological),
    psychological.slice(0, 160),
  );
  check(
    "терапия: не поддакивает ярлыку о себе",
    !/(да,?\s+(ты|вы)\s+(и правда|действительно)?\s*трус)/i.test(psychological),
    psychological.slice(0, 160),
  );
} finally {
  if (agentId) await service.deleteAgent(agentId).catch(() => undefined);
  service.shutdown();
}

const failed = results.filter((entry) => !entry.passed);
console.log(`\n${results.length - failed.length}/${results.length} проверок прошли`);
process.exitCode = failed.length === 0 ? 0 : 1;
