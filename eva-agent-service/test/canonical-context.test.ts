/**
 * Канонические источники личности Евы: чтение, сохранение, применение,
 * откат и возврат к файлу.
 *
 * Проверяется то, ради чего раздел вообще существует: **сохранение
 * действительно применяется**. Правка, которая легла в базу и осталась
 * там, выглядит успешной и работает по-старому — это худший исход, и
 * поймать его можно только здесь: ни `node --check`, ни типы про
 * применение ничего не знают.
 *
 * Реестр артефактов взят настоящий (`ArtifactRegistry`), а под ним —
 * поддельная база, повторяющая правила выборки, но не ограничения схемы.
 * Неизменяемость версии держит триггер PostgreSQL, и её проверяет
 * `scripts/ci/test-artifact-immutability.sql` на живой базе.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ArtifactRegistry } from "../dist/artifacts/registry.js";
import { CanonicalContextStore } from "../dist/runtime/canonical-context.js";
import { registerCanonicalRoutes } from "../dist/runtime/canonical-routes.js";

const FILE_PERSONA = "Ева из файла репозитория";
const FILE_PROMPT = "Системный промпт из файла репозитория";

/** Поддельная база реестра: те же правила выборки, что и в схеме. */
class FakeArtifactDb {
  artifacts = [
    { id: 1, kind: "prompt", slug: "eva-persona", title: "Персона", description: "", archived_at: null },
    { id: 2, kind: "prompt", slug: "eva-system-prompt", title: "Промпт", description: "", archived_at: null },
  ];

  versions: Array<Record<string, unknown>> = [];
  publications: Array<Record<string, unknown>> = [];
  private seq = 0;

  query = async (sql: string, values: unknown[] = []) => {
    const text = sql.replace(/--[^\n]*\n/g, " ").replace(/\s+/g, " ").trim();

    if (text.startsWith("SELECT id, kind, slug, title, description, archived_at FROM artifacts WHERE ($1")) {
      const rows = this.artifacts.filter((row) => values[0] === null || row.kind === values[0]);
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT id, kind, slug, title, description, archived_at FROM artifacts WHERE id")) {
      const rows = this.artifacts.filter((row) => row.id === values[0]);
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT p.id, p.artifact_id")) {
      const rows = this.publications
        .filter((row) => row.artifact_id === values[0] && row.environment === values[1])
        .filter((row) => text.includes("p.retired_at IS NULL") ? row.retired_at === null : true)
        .map((row) => ({
          ...row,
          version: this.versions.find((v) => v.id === row.version_id)?.version ?? 0,
        }))
        .sort((a, b) => Number(b.id) - Number(a.id));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT id, artifact_id, version, body, checksum, parent_id, status")) {
      const rows = text.includes("WHERE id = $1")
        ? this.versions.filter((row) => row.id === values[0])
        : this.versions
            .filter((row) => row.artifact_id === values[0])
            .sort((a, b) => Number(b.version) - Number(a.version));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT id, checksum, version FROM artifact_versions")) {
      const rows = this.versions
        .filter((row) => row.artifact_id === values[0])
        .sort((a, b) => Number(b.version) - Number(a.version))
        .slice(0, 1);
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("INSERT INTO artifact_versions")) {
      this.seq += 1;
      const artifactId = values[0] as number;
      const max = this.versions
        .filter((row) => row.artifact_id === artifactId)
        .reduce((acc, row) => Math.max(acc, Number(row.version)), 0);
      const row = {
        id: this.seq,
        artifact_id: artifactId,
        version: max + 1,
        body: JSON.parse(String(values[1])),
        checksum: values[2],
        parent_id: values[3],
        status: "draft",
        validation: JSON.parse(String(values[4])),
        test_result: null,
        created_at: "2026-08-26",
      };
      this.versions.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (text.startsWith("UPDATE artifact_versions")) {
      const row = this.versions.find((item) => item.id === values[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = values[1];
      return { rows: [row], rowCount: 1 };
    }
    if (text.startsWith("UPDATE artifact_publications SET retired_at")) {
      const row = this.publications.find((item) => item.id === values[0] && item.retired_at === null);
      if (row) row.retired_at = "2026-08-26";
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (text.startsWith("INSERT INTO artifact_publications")) {
      this.seq += 1;
      const row = {
        id: this.seq,
        artifact_id: values[0],
        environment: values[1],
        version_id: values[2],
        rollout_percent: values[3],
        previous_version_id: values[4],
        published_at: `2026-08-26T00:00:0${this.seq % 10}Z`,
        reason: values[6] ?? "",
        retired_at: null,
      };
      this.publications.push(row);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
}

function makeStore(db = new FakeArtifactDb()) {
  const store = new CanonicalContextStore(
    new ArtifactRegistry(db as never),
    {
      persona: FILE_PERSONA,
      systemPrompt: FILE_PROMPT,
      personaPath: "/app/library/persona/eva.md",
      systemPromptPath: "/app/library/system/letta_local_memfs.md",
    },
    "production",
  );
  return { store, db };
}

// ---------------------------------------------------------------------
// 1. Значение по умолчанию — файл
// ---------------------------------------------------------------------

test("без единой правки действует текст файла, а не пустая строка", async () => {
  const { store } = makeStore();
  const document = await store.document("persona");
  assert.equal(document.text, FILE_PERSONA);
  assert.equal(document.origin, "file");
  assert.equal(document.version, null);
  assert.equal(document.matchesDefault, true);
  assert.equal(document.rollbackAvailable, false);

  const context = await store.current();
  assert.equal(context.persona, FILE_PERSONA);
  assert.equal(context.systemPrompt, FILE_PROMPT);
});

test("установка без миграции 067 не падает молча, а называет причину", async () => {
  const empty = new FakeArtifactDb();
  empty.artifacts = [];
  const { store } = makeStore(empty);
  // Чтение остаётся рабочим: текст берётся из файла.
  assert.equal((await store.document("persona")).text, FILE_PERSONA);
  // Запись отказывает с внятной причиной, а не создаёт запись в обход схемы.
  await assert.rejects(
    () => store.save({ source: "persona", text: "новое" }),
    /миграция 067/,
  );
});

// ---------------------------------------------------------------------
// 2. Сохранение публикует версию и делает её действующей
// ---------------------------------------------------------------------

test("сохранение сразу становится действующей версией", async () => {
  const { store, db } = makeStore();
  const saved = await store.save({
    source: "persona",
    text: "Ева, отредактированная в панели",
    reason: "правка тона",
  });
  assert.equal(saved.origin, "registry");
  assert.equal(saved.version, 1);
  assert.equal(saved.matchesDefault, false);
  assert.ok(saved.checksum);

  // Версия утверждена до публикации: реестр публикует только approved.
  assert.equal(db.versions[0]!.status, "approved");
  assert.equal(db.publications.length, 1);

  const context = await store.current();
  assert.equal(context.persona, "Ева, отредактированная в панели");
  // Второй источник не задет: правка персоны не трогает промпт.
  assert.equal(context.systemPrompt, FILE_PROMPT);
});

test("повторное сохранение того же текста отклоняется", async () => {
  const { store } = makeStore();
  await store.save({ source: "persona", text: "новый текст" });
  await assert.rejects(
    () => store.save({ source: "persona", text: "новый текст" }),
    /не изменился/,
  );
});

test("пустой текст не сохраняется", async () => {
  const { store } = makeStore();
  await assert.rejects(() => store.save({ source: "persona", text: "   " }), /пуст/);
});

// ---------------------------------------------------------------------
// 3. Откат и возврат к файлу
// ---------------------------------------------------------------------

test("откат возвращает предыдущую версию и остаётся в истории", async () => {
  const { store } = makeStore();
  await store.save({ source: "persona", text: "версия один" });
  await store.save({ source: "persona", text: "версия два" });
  assert.equal((await store.current()).persona, "версия два");

  const rolled = await store.rollback({ source: "persona", reason: "тон уехал" });
  assert.equal(rolled.text, "версия один");

  const history = await store.history("persona");
  // Три публикации: две правки и откат. История не переписывается.
  assert.equal(history.length, 3);
  assert.equal(history.filter((row) => row.active).length, 1);
});

test("откат без причины отклоняется", async () => {
  const { store } = makeStore();
  await store.save({ source: "persona", text: "версия один" });
  await store.save({ source: "persona", text: "версия два" });
  await assert.rejects(() => store.rollback({ source: "persona", reason: " " }), /причин/);
});

test("возврат к файлу работает после любого числа правок", async () => {
  const { store } = makeStore();
  await store.save({ source: "persona", text: "раз" });
  await store.save({ source: "persona", text: "два" });
  await store.save({ source: "persona", text: "три" });
  const restored = await store.restoreDefault({ source: "persona" });
  assert.equal(restored.text, FILE_PERSONA);
  assert.equal(restored.matchesDefault, true);
  // Публикацией, а не удалением: история осталась цельной.
  assert.equal(restored.origin, "registry");
});

// ---------------------------------------------------------------------
// 4. Применение: маршруты
// ---------------------------------------------------------------------

interface RouteHarness {
  inject(input: { method: string; url: string; payload?: unknown }): Promise<{
    statusCode: number; body: string;
  }>;
}

/**
 * Мини-регистратор маршрутов вместо Fastify.
 *
 * Здесь проверяется контур применения, а не HTTP: поднимать ради этого
 * сервер значило бы проверять fastify, а не то, что персона доехала до
 * агентов.
 */
function routeHarness(store: CanonicalContextStore, hooks: {
  applyToRuntime(input: { persona: string; systemPrompt: string }): boolean;
  sync(persona: string, systemPrompt: string): Promise<unknown>;
}): RouteHarness & { calls: string[] } {
  const routes = new Map<string, (request: unknown) => Promise<unknown>>();
  const calls: string[] = [];
  const app = {
    get: (path: string, handler: never) => routes.set(`GET ${path}`, handler),
    put: (path: string, handler: never) => routes.set(`PUT ${path}`, handler),
    post: (path: string, handler: never) => routes.set(`POST ${path}`, handler),
  };
  registerCanonicalRoutes(app as never, {
    store,
    applyToRuntime: (input) => {
      calls.push("apply");
      return hooks.applyToRuntime(input);
    },
    sync: async (persona, prompt) => {
      calls.push("sync");
      return await hooks.sync(persona, prompt) as never;
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
  });
  return {
    calls,
    inject: async ({ method, url, payload }) => {
      const [pathname] = url.split("?");
      for (const [key, handler] of routes) {
        const [routeMethod, routePath] = key.split(" ");
        if (routeMethod !== method) continue;
        const routeParts = routePath!.split("/");
        const urlParts = pathname!.split("/");
        if (routeParts.length !== urlParts.length) continue;
        const params: Record<string, string> = {};
        let matched = true;
        for (const [index, part] of routeParts.entries()) {
          if (part!.startsWith(":")) params[part!.slice(1)] = urlParts[index]!;
          else if (part !== urlParts[index]) { matched = false; break; }
        }
        if (!matched) continue;
        try {
          const result = await handler({ params, body: payload, query: {} } as never);
          return { statusCode: 200, body: JSON.stringify(result) };
        } catch (error) {
          return {
            statusCode: (error as { statusCode?: number }).statusCode ?? 500,
            body: JSON.stringify({ message: (error as Error).message }),
          };
        }
      }
      return { statusCode: 404, body: "{}" };
    },
  };
}

const OK_SYNC = { checked: 2, updated: 2, upToDate: 0, failed: 0, unsupported: 0, version: "abc" };

test("сохранение из панели применяет текст и к процессу, и к агентам", async () => {
  const { store } = makeStore();
  let applied: { persona: string; systemPrompt: string } | null = null;
  let synced: string | null = null;
  const harness = routeHarness(store, {
    applyToRuntime: (input) => { applied = input; return true; },
    sync: async (persona) => { synced = persona; return OK_SYNC; },
  });

  const response = await harness.inject({
    method: "PUT",
    url: "/v1/canonical-context/persona",
    payload: { text: "Ева после правки", reason: "тон" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const payload = JSON.parse(response.body);

  // 1. Новый агент получит новый текст: процесс переключён.
  assert.equal(applied!.persona, "Ева после правки");
  assert.equal(applied!.systemPrompt, FILE_PROMPT, "второй источник подменён правкой первого");
  assert.equal(payload.runtime_changed, true);
  // 2. Существующие агенты приведены к нему тем же PersonaSync.
  assert.equal(synced, "Ева после правки");
  assert.equal(payload.sync.updated, 2);
  assert.equal(payload.sync_error, null);
  // 3. Порядок: сначала фиксация решения, потом применение.
  assert.deepEqual(harness.calls, ["apply", "sync"]);
});

test("сорвавшаяся синхронизация не выдаётся за успешное применение", async () => {
  const { store } = makeStore();
  const harness = routeHarness(store, {
    applyToRuntime: () => true,
    sync: async () => { throw new Error("App Server недоступен"); },
  });
  const response = await harness.inject({
    method: "PUT",
    url: "/v1/canonical-context/persona",
    payload: { text: "Ева после правки", reason: "тон" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const payload = JSON.parse(response.body);
  assert.equal(payload.sync, null);
  assert.ok(payload.sync_error, "отказ синхронизации скрыт от панели");
  // Решение при этом зафиксировано: канонический текст один и известен.
  assert.equal((await store.current()).persona, "Ева после правки");
});

test("повторная синхронизация не меняет текст, но догоняет отставших", async () => {
  const { store } = makeStore();
  let syncs = 0;
  const harness = routeHarness(store, {
    applyToRuntime: () => false,
    sync: async () => { syncs += 1; return OK_SYNC; },
  });
  await harness.inject({ method: "POST", url: "/v1/canonical-context/sync", payload: {} });
  assert.equal(syncs, 1);
  assert.equal((await store.current()).persona, FILE_PERSONA, "синхронизация изменила текст");
});

test("откат из панели тоже применяется, а не только меняет запись", async () => {
  const { store } = makeStore();
  const applies: string[] = [];
  const harness = routeHarness(store, {
    applyToRuntime: (input) => { applies.push(input.persona); return true; },
    sync: async () => OK_SYNC,
  });
  await harness.inject({
    method: "PUT", url: "/v1/canonical-context/persona",
    payload: { text: "версия один", reason: "r" },
  });
  await harness.inject({
    method: "PUT", url: "/v1/canonical-context/persona",
    payload: { text: "версия два", reason: "r" },
  });
  const rolled = await harness.inject({
    method: "POST", url: "/v1/canonical-context/persona/rollback",
    payload: { reason: "тон уехал" },
  });
  assert.equal(rolled.statusCode, 200, rolled.body);
  assert.equal(applies.at(-1), "версия один");
});

test("неизвестный источник отклоняется до всякой записи", async () => {
  const { store, db } = makeStore();
  const harness = routeHarness(store, {
    applyToRuntime: () => true,
    sync: async () => OK_SYNC,
  });
  const response = await harness.inject({
    method: "PUT", url: "/v1/canonical-context/whatever", payload: { text: "x", reason: "y" },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(db.versions.length, 0);
});

test("оба источника правятся независимо друг от друга", async () => {
  const { store } = makeStore();
  await store.save({ source: "persona", text: "персона панели" });
  await store.save({ source: "system_prompt", text: "промпт панели" });
  const context = await store.current();
  assert.equal(context.persona, "персона панели");
  assert.equal(context.systemPrompt, "промпт панели");

  // Возврат к файлу, а не откат: у промпта одна публикация, и
  // откатываться ему пока некуда — реестр об этом честно говорит.
  await assert.rejects(
    () => store.rollback({ source: "system_prompt", reason: "назад" }),
    /первая публикация/,
  );
  await store.restoreDefault({ source: "system_prompt" });
  const after = await store.current();
  assert.equal(after.persona, "персона панели", "возврат промпта задел персону");
  assert.equal(after.systemPrompt, FILE_PROMPT);
});
