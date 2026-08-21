/**
 * Contract-тесты Letta: что реестр возможностей обещает, то установленные
 * пакеты обязаны уметь.
 *
 * Тест ничего не подменяет. Оба клиента и сессия строятся настоящие —
 * конструктор соединения не открывает, — и путь из реестра ищется на живом
 * объекте. Поэтому «зелёный» здесь означает не «мы так думаем», а «метод с
 * этим именем есть в том пакете, который лежит в node_modules».
 *
 * Чего тест не проверяет и не притворяется, что проверяет: поведение
 * операции на живом App Server. Для этого нужен работающий сервер, его в
 * прогоне нет, и подделывать его ответы бессмысленно — подделка проверила
 * бы подделку. Живая часть остаётся за smoke-стендом.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

import {
  AGENT_SDK_PACKAGE,
  LETTA_CAPABILITIES,
  VERIFIED_VERSIONS,
  assertSupported,
  capability,
  capabilityMatrix,
  isSupported,
} from "../dist/letta/capabilities.js";

const require = createRequire(import.meta.url);

/** Никуда не ведущий адрес: соединение не открывается, объект строится. */
const OFFLINE_WS = "ws://127.0.0.1:1";

function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function agentClient(): LettaAgentClient {
  return new LettaAgentClient({ backend: "remote", url: OFFLINE_WS });
}

/**
 * Версия из манифеста установленного пакета.
 *
 * Через `require(pkg + "/package.json")` не читается: оба пакета
 * объявляют `exports` и манифест наружу не отдают. Поэтому от точки
 * входа поднимаемся вверх до манифеста с нужным именем — так версия
 * берётся у того файла, который реально загрузился, а не у первого
 * похожего каталога в дереве.
 */
function installedVersion(pkg: string): string {
  let dir = dirname(require.resolve(pkg));
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const meta = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (meta.name === pkg && meta.version) return meta.version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`не найден манифест установленного пакета ${pkg}`);
}

test("реестр подтверждён именно на тех версиях, что установлены", () => {
  // Версия SDK один раз уже уехала групповым обновлением зависимостей, и
  // заметить это было негде. Теперь подъём версии красит этот тест, пока
  // человек не перепроверит матрицу и не поднимет VERIFIED_VERSIONS.
  assert.equal(installedVersion(AGENT_SDK_PACKAGE), VERIFIED_VERSIONS.agentSdk);
});

test("Agent SDK закреплён точной версией, а не диапазоном", () => {
  const pkg = require("../package.json") as {
    dependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies[AGENT_SDK_PACKAGE], VERIFIED_VERSIONS.agentSdk);
});

test("каждый управляющий путь Agent SDK есть на живом клиенте", () => {
  const client = agentClient();
  const checked = LETTA_CAPABILITIES.filter(
    (entry) => entry.surface === "agent-sdk" && entry.check === "method",
  );
  assert.ok(checked.length >= 12, "управляющих операций стало подозрительно мало");
  for (const entry of checked) {
    assert.equal(
      typeof resolvePath(client, entry.path!),
      "function",
      `${entry.id}: нет метода ${entry.path} в ${AGENT_SDK_PACKAGE}`,
    );
  }
});

test("каждый путь сессии есть на живой сессии", () => {
  // Сессия — путь выполнения диалога: создание, стриминг, отмена,
  // восстановление после перезапуска и ожидающие approvals.
  const session = agentClient().resumeSession("contract-conversation", {
    cwd: "/data/letta",
  });
  const checked = LETTA_CAPABILITIES.filter(
    (entry) => entry.surface === "session" && entry.check === "method",
  );
  for (const entry of checked) {
    assert.equal(
      typeof resolvePath(session, entry.path!),
      "function",
      `${entry.id}: нет метода сессии ${entry.path}`,
    );
  }
  // Именно эти четыре операции задание требует подтвердить отдельно.
  for (const id of ["turn.stream", "turn.abort", "session.bootstrap", "approvals.recover"]) {
    assert.equal(isSupported(id), true, id);
  }
});

test("удаления conversation в Agent SDK нет, архивирование — поле обновления", () => {
  const client = agentClient();
  assert.equal(resolvePath(client, "conversations.delete"), undefined);
  assert.equal(capability("conversation.archive").path, "conversations.update");
  assert.equal(typeof resolvePath(client, "conversations.update"), "function");
  assert.equal(capability("conversation.delete").surface, null);
});

test("непроверяемая методом операция обязана объяснить, почему", () => {
  for (const entry of LETTA_CAPABILITIES) {
    if (entry.check !== "option") continue;
    assert.equal(entry.path, null, `${entry.id}: у опции не может быть пути метода`);
    assert.ok(
      (entry.note ?? "").length > 40,
      `${entry.id}: опция без объяснения выдаёт непроверенное за проверенное`,
    );
  }
});

test("неподдержанная операция видна как неподдержанная, а не как успех", () => {
  const missing = LETTA_CAPABILITIES.filter((entry) => entry.surface === null);
  assert.ok(missing.length > 0, "реестр обязан называть и то, чего нет");
  for (const entry of missing) {
    assert.equal(entry.path, null);
    assert.equal(isSupported(entry.id), false);
    assert.throws(
      () => assertSupported(entry.id),
      (error: unknown) => {
        const evaError = error as { code?: string; statusCode?: number; retryable?: boolean };
        assert.equal(evaError.code, "unsupported_operation");
        assert.equal(evaError.statusCode, 501);
        // Повтор не поможет: поддержка приходит обновлением пакета.
        assert.equal(evaError.retryable, false);
        return true;
      },
      entry.id,
    );
  }
});

test("поддержанная операция проходит проверку и не бросает", () => {
  for (const entry of LETTA_CAPABILITIES) {
    if (entry.surface === null) continue;
    assert.equal(assertSupported(entry.id).id, entry.id);
  }
});

test("матрица совместимости называет версию для каждой поддержанной операции", () => {
  const matrix = capabilityMatrix();
  assert.equal(matrix.length, LETTA_CAPABILITIES.length);
  for (const row of matrix) {
    if (!row.supported) {
      assert.equal(row.version, null);
      assert.equal(row.surface, null);
      continue;
    }
    assert.equal(
      row.version,
      VERIFIED_VERSIONS.agentSdk,
      row.operation,
    );
  }
  // Матрица нужна отчёту и админке — идентификаторы обязаны быть уникальны.
  assert.equal(new Set(matrix.map((row) => row.operation)).size, matrix.length);
});
