#!/usr/bin/env node

/**
 * Проверяет архитектурную границу Letta.
 *
 * eva-agent-service вправе публиковать собственные маршруты /v1/agents/*.
 * Запрещено другое: прямой HTTP/WebSocket-клиент Letta в обход официального
 * @letta-ai/letta-agent-sdk. Поэтому проверяем транспортные признаки, а не
 * совпадение строк с маршрутами административного API Evaself.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";

const root = process.argv[2] ?? process.cwd();
const sourceRoot = join(root, "src");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const sdk = packageJson.dependencies?.["@letta-ai/letta-agent-sdk"];

if (!sdk) {
  console.error("Официальный @letta-ai/letta-agent-sdk отсутствует в dependencies.");
  process.exit(1);
}

async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts")) result.push(path);
  }
  return result;
}

const files = await sourceFiles(sourceRoot);
const sources = await Promise.all(files.map(async (path) => ({
  path,
  text: await readFile(path, "utf8"),
})));

const lettaSource = sources.find(({ path }) => path.endsWith(`${join("src", "letta.ts")}`));
if (!lettaSource?.text.includes('from "@letta-ai/letta-agent-sdk"')) {
  console.error("src/letta.ts не импортирует официальный Agent SDK.");
  process.exit(1);
}

const forbidden = [
  [/\bX-BARE-PASSWORD\b/i, "устаревшая REST-аутентификация Letta"],
  [/\bLETTA_BASE_URL\b/, "адрес устаревшего REST-сервера Letta"],
  [/\bhttps?:\/\/[^"'`\s]*letta[^"'`\s]*\/v1\/agents\b/i, "прямой REST URL Letta"],
  [/\bfetch\s*\(\s*[^)]*\/v1\/agents\b/is, "прямой fetch к Letta agents API"],
  [/\bnew\s+WebSocket\s*\(/, "самописный WebSocket-клиент"],
  [/from\s+["']@letta-ai\/letta-client["']/, "устаревший Letta REST client"],
];

const violations = [];
for (const source of sources) {
  for (const [pattern, reason] of forbidden) {
    if (pattern.test(source.text)) {
      violations.push(`${relative(root, source.path)}: ${reason}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Обнаружён доступ к Letta в обход Agent SDK:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`SDK-only доступ подтверждён: @letta-ai/letta-agent-sdk ${sdk}`);
