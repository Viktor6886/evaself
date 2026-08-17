#!/usr/bin/env node

/**
 * Три проверки памяти и работы Евы на живом App Server.
 *
 * Проверяется не конфигурация, а поведение: конфигурацию видно и так, а
 * вопрос «помнит ли Ева имя брата через несколько сообщений» на неё не
 * отвечает. Поэтому скрипт открывает настоящую сессию, ведёт настоящий
 * разговор и смотрит на ответы.
 *
 * Нужен работающий App Server с настроенным провайдером модели: без
 * модели разговора нет, и притворяться, что проверка прошла, нельзя.
 *
 *   node scripts/smoke-eva-memory.mjs ws://127.0.0.1:4500 [токен]
 *
 * Скрипт создаёт временного агента, помеченного `evaself-smoke`, и
 * удаляет его за собой.
 */

import { LettaService } from "../eva-agent-service/dist/letta.js";

const url = process.argv[2] ?? process.env.LETTA_APP_SERVER_URL ?? "ws://127.0.0.1:4500";
const token = process.argv[3] ?? process.env.LETTA_APP_SERVER_TOKEN ?? "";
const silent = { debug() {}, info() {}, warn() {}, error() {} };

const service = new LettaService(
  {
    appServerUrl: url,
    appServerToken: token,
    appServerRequestTimeoutMs: 120_000,
    model: process.env.EVA_MODEL ?? "",
    sessionPoolSize: 2,
    sessionIdleMs: 120_000,
    turnTimeoutMs: 300_000,
    safeSessionManager: false,
    sessionDrainMs: 5_000,
  },
  silent,
  await (await import("node:fs/promises")).readFile(
    new URL("../library/persona/eva.md", import.meta.url),
    "utf8",
  ),
);

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const telegramId = 900_000 + Math.floor(Math.random() * 90_000);
let agentId = null;

try {
  agentId = await service.createAgent({ telegramId, displayName: "Smoke" });
  const conversationId = await service.createConversation(agentId);
  const say = async (text) => (await service.runTurn(conversationId, text)).reply;

  // Факты runtime: без MemFS и без навыков остальные проверки
  // бессмысленны — Еве было бы нечем помнить.
  const facts = service.runtimeFacts;
  check(
    "runtime: MemFS включён",
    facts?.memfsEnabled === true,
    `memfs=${facts?.memfsEnabled}, skills=${facts?.skillSources?.join(",") ?? "?"}`,
  );

  // 1. Простой факт переживает несколько посторонних сообщений.
  await say("Моего брата зовут Сергей.");
  await say("Кстати, сегодня был долгий день на работе.");
  await say("Ещё я на выходных хочу съездить за город.");
  const brother = await say("Напомни, как зовут моего брата?");
  check("память: имя брата", /Сергей/i.test(brother), brother.slice(0, 120));

  // 2. Новое явное сообщение важнее старой записи.
  await say("Я работаю в компании «Астра».");
  await say("Я уволился и теперь работаю в «Бореалис».");
  const employer = await say("Где я сейчас работаю?");
  check(
    "память: актуальное место работы",
    /Бореалис/i.test(employer) && !/Астра/i.test(employer),
    employer.slice(0, 160),
  );

  // 3. Короткий рассказ не превращается в список техник: сначала Ева
  //    разбирается, что происходит.
  const psychological = await say(
    "Последние недели постоянно откладываю важный разговор с руководителем. "
    + "Каждый раз нахожу причину не начинать.",
  );
  const bullets = (psychological.match(/^\s*(?:[-*•]|\d+[.)])\s+/gmu) ?? []).length;
  const questions = (psychological.match(/\?/gu) ?? []).length;
  check(
    "терапия: сначала понять, потом предлагать",
    bullets <= 2 && questions >= 1 && questions <= 2,
    `пунктов списка ${bullets}, вопросов ${questions}`,
  );
} finally {
  if (agentId) await service.deleteAgent(agentId).catch(() => undefined);
  service.shutdown();
}

const failed = results.filter((entry) => !entry.passed);
console.log(`\n${results.length - failed.length}/${results.length} проверок прошли`);
process.exitCode = failed.length === 0 ? 0 : 1;
