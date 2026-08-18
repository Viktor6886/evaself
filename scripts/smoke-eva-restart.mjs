#!/usr/bin/env node

/**
 * Canary: переживает ли память перезапуск App Server.
 *
 * Отдельно от `smoke-eva-memory.mjs` намеренно. Перезапуск App Server
 * стоит минуты и роняет все открытые сессии, поэтому в общий прогон CI
 * он не входит: там он превратился бы в источник ложных отказов, а не
 * в проверку. Запускается руками перед выпуском и на canary-стенде.
 *
 *   node scripts/smoke-eva-restart.mjs ws://127.0.0.1:4500 [токен]
 *
 * Перезапуск делает сам скрипт, если задана RESTART_COMMAND, иначе
 * ждёт, пока перезапустит человек:
 *
 *   RESTART_COMMAND="docker compose restart letta-app-server" \
 *     node scripts/smoke-eva-restart.mjs
 *
 * Агент остаётся жив: удалять его после перезапуска нечестно — canary
 * должен уметь показать состояние, которое пережило перезапуск.
 */

import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { LettaService } from "../eva-agent-service/dist/letta.js";

const run = promisify(exec);
const url = process.argv[2] ?? process.env.LETTA_APP_SERVER_URL ?? "ws://127.0.0.1:4500";
const token = process.argv[3] ?? process.env.LETTA_APP_SERVER_TOKEN ?? "";
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function build() {
  return new LettaService(
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
    persona,
  );
}

const persona = await readFile(new URL("../library/persona/eva.md", import.meta.url), "utf8");

async function restart() {
  const command = process.env.RESTART_COMMAND;
  if (command) {
    console.log(`перезапуск: ${command}`);
    await run(command, { timeout: 300_000 });
    return;
  }
  console.log("Перезапустите App Server и нажмите Enter…");
  await new Promise((resolve) => process.stdin.once("data", resolve));
}

/** Дождаться, пока App Server снова отвечает: сразу после рестарта он не готов. */
async function waitUntilAnswering(service, attempts = 60) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ping = await service.ping();
    if (ping.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

let service = build();
let agentId = null;
let passed = false;

try {
  const telegramId = 910_000 + Math.floor(Math.random() * 80_000);
  agentId = await service.createAgent({ telegramId, displayName: "Restart canary" });
  const conversationId = await service.createConversation(agentId);

  await service.runTurn(conversationId, "Моего брата зовут Сергей, он живёт в Казани.");
  console.log("факт записан, агент:", agentId);

  service.shutdown();
  await restart();

  service = build();
  if (!await waitUntilAnswering(service)) {
    console.log("FAIL  App Server не поднялся за две минуты");
    process.exitCode = 1;
  } else {
    // Тот же агент и тот же conversation: сессия открывается заново,
    // память приходит из Letta, а не из памяти процесса.
    const { reply } = await service.runTurn(conversationId, "Напомни, как зовут моего брата и где он живёт?");
    passed = /Сергей/i.test(reply) && /Казан/i.test(reply);
    console.log(`${passed ? "PASS" : "FAIL"}  память пережила перезапуск — ${reply.slice(0, 160)}`);
    process.exitCode = passed ? 0 : 1;
  }
} finally {
  console.log(`агент ${agentId ?? "—"} оставлен для разбора; удалите его вручную, когда он не нужен`);
  service.shutdown();
}
