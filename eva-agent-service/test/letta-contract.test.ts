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
  ADMIN_CLIENT_PACKAGE,
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

function adminClient(): unknown {
  const module = require(ADMIN_CLIENT_PACKAGE) as Record<string, unknown>;
  const Ctor = (module.Letta ?? module.default) as new (options: {
    apiKey: string;
    baseURL: string;
  }) => unknown;
  return new Ctor({ apiKey: "contract-test", baseURL: "http://127.0.0.1:1" });
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
  assert.equal(installedVersion(ADMIN_CLIENT_PACKAGE), VERIFIED_VERSIONS.adminClient);
});

test("административный клиент закреплён точной версией, а не диапазоном", () => {
  // `@latest` и диапазон запрещены заданием шага: обновление control plane
  // обязано быть отдельным осознанным изменением lock-файла.
  const pkg = require("../package.json") as {
    dependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies[ADMIN_CLIENT_PACKAGE], VERIFIED_VERSIONS.adminClient);
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

test("каждый административный путь есть на живом официальном клиенте", () => {
  const client = adminClient();
  const checked = LETTA_CAPABILITIES.filter(
    (entry) => entry.surface === "admin-client" && entry.check === "method",
  );
  assert.ok(checked.length >= 10, "административных операций стало подозрительно мало");
  for (const entry of checked) {
    assert.equal(
      typeof resolvePath(client, entry.path!),
      "function",
      `${entry.id}: нет метода ${entry.path} в ${ADMIN_CLIENT_PACKAGE}`,
    );
  }
});

test("точечное изменение memory block — операция официального клиента", () => {
  // Ключевая развилка шага: если бы записи в блок не было ни в одном
  // пакете, единственным честным путём остался бы runtime override.
  const entry = capability("memory-block.update");
  assert.equal(entry.surface, "admin-client");
  assert.equal(
    typeof resolvePath(adminClient(), entry.path!),
    "function",
  );
  // И её действительно нет в Agent SDK — иначе адаптер был бы не нужен.
  assert.equal(resolvePath(agentClient(), "agents.blocks"), undefined);
});

test("удаления conversation в Agent SDK нет, архивирование — поле обновления", () => {
  const client = agentClient();
  assert.equal(resolvePath(client, "conversations.delete"), undefined);
  assert.equal(capability("conversation.archive").path, "conversations.update");
  assert.equal(typeof resolvePath(client, "conversations.update"), "function");
  assert.equal(capability("conversation.delete").surface, "admin-client");
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
    assert.ok((entry.note ?? "").length > 40, `${entry.id}: отсутствие без причины`);
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
      assert.ok(row.note);
      continue;
    }
    assert.equal(
      row.version,
      row.surface === "admin-client" ? VERIFIED_VERSIONS.adminClient : VERIFIED_VERSIONS.agentSdk,
      row.operation,
    );
  }
  // Матрица нужна отчёту и админке — идентификаторы обязаны быть уникальны.
  assert.equal(new Set(matrix.map((row) => row.operation)).size, matrix.length);
});
