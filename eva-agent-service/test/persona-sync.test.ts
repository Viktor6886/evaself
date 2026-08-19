import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PersonaSync, personaSyncState, canonicalMemoryVersion } from "../dist/letta/persona-sync.js";
import { evaMemoryBlocks } from "../dist/letta.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

// Запасной текст на случай, когда каталог `library` вне образа
// сервиса. Он обязан нести те же формы, что проверяются ниже:
// иначе проверка падает не на персоне, а на собственной заглушке —
// ровно это и случилось в сборке образа.
const PERSONA = "# Ева\n\nО себе говорю в женском роде: поняла, приняла, сделала, готова, рада помочь.";

/** Текст канонической персоны или `null`, если каталог вне образа сервиса. */
async function personaText(): Promise<string | null> {
  try {
    return await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
  } catch {
    return null;
  }
}

function fakeDb(agents: Array<{ agentId: string; userId: number; personaVersion: string | null }>) {
  const recorded: Array<{ agentId: string; version: string }> = [];
  return {
    recorded,
    listAgentsForPersonaSync: async () => agents,
    recordMemoryReconciled: async (
      agentId: string,
      _userId: number,
      state: { version: string; legacy: string[] },
    ) => {
      recorded.push({ agentId, version: state.version });
    },
  };
}

/**
 * Поддельный control plane.
 *
 * `blocks` задаёт текст персоны агента, `extra` — блоки прежней схемы.
 * По умолчанию у агента есть только персона: ровно та ситуация, ради
 * которой сверка и написана — три канонических блока отсутствуют.
 */
function fakePlane(options: {
  blocks?: Record<string, string>;
  extra?: Array<{ id: string; label: string; value: string; description?: string | null }>;
  present?: string[];
  failOn?: string;
  available?: boolean;
} = {}) {
  const updates: Array<{ agentId: string; label: string; value: string }> = [];
  const created: Array<{ agentId: string; label: string; value: string }> = [];
  const detached: Array<{ agentId: string; blockId: string }> = [];
  const store = new Map<string, Map<string, { id: string; value: string; description: string | null }>>();
  return {
    updates,
    created,
    detached,
    available: options.available ?? true,
    listMemoryBlocks: async (agentId: string) => {
      if (options.failOn === agentId) throw new Error("control plane недоступен");
      const own = store.get(agentId) ?? new Map();
      if (!store.has(agentId)) {
        own.set("persona", {
          id: "block-persona",
          value: options.blocks?.[agentId] ?? "старый текст персоны",
          description: null,
        });
        for (const label of options.present ?? []) {
          own.set(label, { id: `block-${label}`, value: `накопленное про ${label}`, description: null });
        }
        for (const block of options.extra ?? []) {
          own.set(block.label, {
            id: block.id, value: block.value, description: block.description ?? null,
          });
        }
        store.set(agentId, own);
      }
      return [...own.entries()].map(([label, block]) => ({
        id: block.id, label, value: block.value,
        description: block.description, limit: null, readOnly: false,
      }));
    },
    updateMemoryBlock: async (agentId: string, label: string, value: string) => {
      updates.push({ agentId, label, value });
      store.get(agentId)?.set(label, { id: `block-${label}`, value, description: null });
      return { id: `block-${label}`, label, value, description: null, limit: null, readOnly: false };
    },
    createMemoryBlock: async (
      agentId: string,
      block: { label: string; value: string; description?: string | null },
    ) => {
      created.push({ agentId, label: block.label, value: block.value });
      store.get(agentId)?.set(block.label, {
        id: `block-${block.label}`, value: block.value, description: block.description ?? null,
      });
      return {
        id: `block-${block.label}`, label: block.label, value: block.value,
        description: block.description ?? null, limit: null, readOnly: false,
      };
    },
    detachMemoryBlock: async (agentId: string, blockId: string) => {
      detached.push({ agentId, blockId });
    },
  };
}

test("существующий агент получает канонический текст персоны", async () => {
  const version = canonicalMemoryVersion(PERSONA);
  const db = fakeDb([
    { agentId: "agent-old", userId: 1, personaVersion: null },
    { agentId: "agent-fresh", userId: 2, personaVersion: version },
  ]);
  const plane = fakePlane();

  const result = await new PersonaSync(db as never, plane as never, logger).sync(PERSONA);

  assert.deepEqual(result, {
    checked: 2, updated: 1, upToDate: 1, failed: 0, legacyAgents: 0, version,
  });
  assert.deepEqual(plane.updates, [{ agentId: "agent-old", label: "persona", value: PERSONA }]);
  // Отметка версии — не копия блока: в базе остаётся отпечаток, а не текст.
  assert.deepEqual(db.recorded, [{ agentId: "agent-old", version }]);
  assert.doesNotMatch(JSON.stringify(db.recorded), /женском роде/);
});

test("агент с тем же текстом не переписывается зря", async () => {
  const db = fakeDb([{ agentId: "agent-1", userId: 1, personaVersion: "старая-версия" }]);
  const plane = fakePlane({ blocks: { "agent-1": `${PERSONA}\n` } });

  const result = await new PersonaSync(db as never, plane as never, logger).sync(PERSONA);

  assert.equal(result.updated, 1, "три недостающих блока — это работа, а не «нечего делать»");
  assert.deepEqual(plane.updates, [], "лишняя запись в существующий блок");
  // Персона совпала и не переписана, а недостающие блоки заведены.
  assert.deepEqual(
    plane.created.map((entry) => entry.label).sort(),
    ["current_state", "human", "therapeutic_framework"],
  );
  // Но отметка версии всё равно ставится: иначе агент проверялся бы каждый раз.
  assert.equal(db.recorded.length, 1);
});

test("отказ на одном агенте не оставляет остальных без персоны", async () => {
  const db = fakeDb([
    { agentId: "agent-broken", userId: 1, personaVersion: null },
    { agentId: "agent-ok", userId: 2, personaVersion: null },
  ]);
  const plane = fakePlane({ failOn: "agent-broken" });

  const result = await new PersonaSync(db as never, plane as never, logger).sync(PERSONA);

  assert.equal(result.failed, 1);
  assert.equal(result.updated, 1);
  assert.deepEqual(plane.updates.map((update) => update.agentId), ["agent-ok"]);
  assert.deepEqual(db.recorded.map((entry) => entry.agentId), ["agent-ok"]);
});

test("выключенный control plane ничего не пишет и говорит об этом", async () => {
  const db = fakeDb([{ agentId: "agent-1", userId: 1, personaVersion: null }]);
  const plane = fakePlane({ available: false });

  const result = await new PersonaSync(db as never, plane as never, logger).sync(PERSONA);

  assert.deepEqual(result, {
    checked: 0, updated: 0, upToDate: 0, failed: 0, legacyAgents: 0,
    version: canonicalMemoryVersion(PERSONA),
  });
  assert.deepEqual(plane.updates, []);
});

test("и новый, и существующий агент получают одну и ту же персону женского рода", async () => {
  const persona = await personaText();
  if (persona === null) {
    // Каталог `library` монтируется в контейнер и в образ сервиса не входит.
    return;
  }

  // Новый агент: персона приходит в блок при создании.
  const created = evaMemoryBlocks(persona).find((block) => block.label === "persona");
  assert.equal(created?.value, persona);

  // Существующий: тот же текст доставляет синхронизация.
  const db = fakeDb([{ agentId: "agent-old", userId: 1, personaVersion: null }]);
  const plane = fakePlane();
  await new PersonaSync(db as never, plane as never, logger).sync(persona);
  assert.equal(plane.updates[0]?.value, persona);

  // И этот текст говорит о Еве в женском роде.
  for (const form of ["женском роде", "поняла", "сделала", "готова", "рада"]) {
    assert.ok(persona.includes(form), `персона потеряла форму «${form}»`);
  }
  // Мужских форм о себе в персоне нет.
  assert.doesNotMatch(persona, /\bя\s+(понял|сделал|рад|готов)\b/iu);
});

/**
 * Агент, созданный со старой персоной, не должен успеть ответить о себе
 * в мужском роде.
 *
 * Массовая синхронизация идёт при старте и может не дойти до него к
 * первому сообщению человека, поэтому у хода есть свой короткий проход.
 */
test("устаревший агент получает каноническую персону до хода", async () => {
  const persona = await personaText();
  const canonical = persona ?? PERSONA;
  const db = fakeDb([]);
  const plane = fakePlane({ blocks: { "agent-old": "Я Ева. Понял, сделал, рад помочь." } });
  const sync = new PersonaSync(db as never, plane as never, logger);

  const outcome = await sync.syncAgent(
    { agentId: "agent-old", userId: 1, storedVersion: "прошлогодняя" },
    canonical,
  );

  assert.equal(outcome, "updated");
  const written = plane.updates[0]?.value ?? "";
  for (const form of ["поняла", "сделала", "готова", "рада"]) {
    assert.ok(written.includes(form), `в блок агента не попала форма «${form}»`);
  }
  assert.doesNotMatch(written, /\bПонял, сделал\b/);
  assert.deepEqual(db.recorded, [{ agentId: "agent-old", version: canonicalMemoryVersion(canonical) }]);
});

test("агент с актуальной версией не тревожится перед ходом", async () => {
  const db = fakeDb([]);
  const plane = fakePlane();
  const sync = new PersonaSync(db as never, plane as never, logger);
  const outcome = await sync.syncAgent(
    { agentId: "agent-1", userId: 1, storedVersion: canonicalMemoryVersion(PERSONA) },
    PERSONA,
  );
  assert.equal(outcome, "up_to_date");
  assert.deepEqual(plane.updates, [], "лишний поход в control plane перед ходом");
});

test("выключенная синхронизация видна в состоянии, а не пропадает молча", async () => {
  const db = fakeDb([{ agentId: "agent-1", userId: 1, personaVersion: null }]);
  const plane = fakePlane({ available: false });
  await new PersonaSync(db as never, plane as never, logger).sync(PERSONA);

  const state = personaSyncState();
  assert.equal(state.enabled, false);
  assert.equal(state.status, "disabled");
  assert.equal(typeof state.lastRunAt, "string");
});

test("молчащий control plane не задерживает ход дольше отведённого", async () => {
  const db = fakeDb([]);
  const stuck = {
    available: true,
    updates: [] as unknown[],
    // Control plane отвечает, но позже, чем ход готов ждать.
    listMemoryBlocks: async () => await new Promise((resolve) => setTimeout(() => resolve([]), 200)),
    updateMemoryBlock: async () => { throw new Error("не должно вызываться"); },
  };
  const sync = new PersonaSync(db as never, stuck as never, logger);
  const started = Date.now();
  const outcome = await sync.syncAgent(
    { agentId: "agent-slow", userId: 1, storedVersion: null },
    PERSONA,
    { timeoutMs: 250 },
  );
  const waited = Date.now() - started;

  assert.equal(outcome, "failed");
  assert.ok(waited < 1_000, `ход ждал синхронизацию ${waited} мс`);
  assert.equal(personaSyncState().status, "stale");
  // Дать запоздавшему ответу дойти, чтобы он не повис после теста.
  await new Promise((resolve) => setTimeout(resolve, 250));
});

test("резервный провайдер получает личность в женском роде", async () => {
  const { BACKUP_PERSONA_DIRECTIVE } = await import("../dist/router/normalize.js");
  // Резерв не видит memory block: если род не назвать здесь, Ева
  // посреди разговора начнёт говорить о себе в мужском роде.
  for (const form of ["женском роде", "поняла", "приняла", "сделала", "готова", "рада"]) {
    assert.ok(BACKUP_PERSONA_DIRECTIVE.includes(form), `в резервной персоне нет формы «${form}»`);
  }
});

/**
 * Отказ массового прохода не остаётся навсегда.
 *
 * Массовый проход идёт при старте сервиса, и control plane в этот момент
 * может ещё подниматься. Пока состояние было «отказ» до следующего
 * перезапуска, `doctor` показывал поломку там, где её уже нет: каждый
 * такой агент получает персону в своём же ходе.
 */
test("удачный проход перед ходом снимает отказ массового прохода", async () => {
  const db = fakeDb([{ agentId: "agent-1", userId: 1, personaVersion: null }]);
  const broken = fakePlane({ failOn: "agent-1" });
  await new PersonaSync(db as never, broken as never, logger).sync(PERSONA);
  assert.equal(personaSyncState().status, "failed");
  assert.equal(personaSyncState().failed, 1);

  const working = fakePlane({ blocks: { "agent-1": "Я Ева. Понял, сделал." } });
  const outcome = await new PersonaSync(db as never, working as never, logger)
    .syncAgent({ agentId: "agent-1", userId: 1, storedVersion: null }, PERSONA);

  assert.equal(outcome, "updated");
  assert.equal(personaSyncState().status, "ok", "прошлый отказ остался текущим состоянием");
  // Счётчик отказа остаётся: он про то, что было, а не про то, что есть.
  assert.equal(personaSyncState().failed, 1);
});

/**
 * Состояние синхронизации видно в `/health`, и оно не роняет сервис.
 *
 * Первая версия роняла: `status` уходил в `degraded` от любого отказа
 * персоны, и один неудачный проход на старте означал «сервис нездоров»
 * навсегда — стенд не дожидался здорового сервиса вовсе.
 */
test("/health показывает синхронизацию персоны и не падает из-за неё", async () => {
  const { buildServer } = await import("../dist/server.js");
  const { withTenantScopes } = await import("./tenant-scope-helper.ts");

  const db = fakeDb([{ agentId: "agent-1", userId: 1, personaVersion: null }]);
  await new PersonaSync(db as never, fakePlane({ failOn: "agent-1" }) as never, logger).sync(PERSONA);
  assert.equal(personaSyncState().status, "failed");

  const app = buildServer({
    config: {
      apiKey: "test-internal-key-32-characters!!", port: 0, host: "127.0.0.1",
      domains: { root: "", app: "", api: "", nocodb: "", letta: "", status: "" },
      turnLifecycleEnabled: false, healthRateLimitPerIp: 100, rateLimitWindowSeconds: 60,
      publicRateLimitPerIp: 100, publicRateLimitPerUser: 100, webhookRateLimitPerIp: 100,
      appServerUrl: "ws://letta:4500/ws",
    } as never,
    logger: logger as never,
    db: withTenantScopes({
      query: async () => ({ rows: [] }),
      poolStats: () => ({ total: 0, idle: 0, waiting: 0 }),
      ping: async () => true,
    }) as never,
    letta: {
      sessionStats: () => ({ active: 0, idle: 0 }),
      ping: async () => ({ ok: true, models: 1 }),
      openSessions: 0,
      runtimeFacts: null,
    } as never,
    sdk: {} as never, llm: {} as never, inbox: {} as never, profile: {} as never,
    goals: {} as never, payments: {} as never,
    queue: { activeUsers: 0, queuedUsers: 0 } as never,
    telegram: {} as never,
    redisPing: async () => true,
  } as never);

  try {
    const response = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(response.body) as {
      status: string;
      checks: { persona_sync?: { status: string; failed: number } };
    };
    assert.equal(body.checks.persona_sync?.status, "failed", "состояние синхронизации не видно");
    assert.equal(body.checks.persona_sync?.failed, 1);
    assert.equal(body.status, "ok", "отказ синхронизации персоны уронил весь сервис");
    assert.equal(response.statusCode, 200);
  } finally {
    await app.close();
  }
});

/**
 * Сверка ядра памяти существующих агентов.
 *
 * Продакшен-агент, созданный до текущей схемы, приходит с прежним
 * набором блоков: часть канонических отсутствует, часть меток вообще из
 * старой схемы. Проверяется главное — недостающее появляется, чужое не
 * переписывается, а прежние блоки остаются на месте вместе с данными.
 */
test("устаревший агент получает недостающие канонические блоки", async () => {
  const db = fakeDb([]);
  const plane = fakePlane();
  const report = await new PersonaSync(db as never, plane as never, logger)
    .reconcileAgent({ agentId: "agent-old", userId: 1 }, PERSONA);

  assert.equal(report.canonical, 4, "канонических блоков должно стать четыре");
  assert.deepEqual(report.created.sort(), ["current_state", "human", "therapeutic_framework"]);
  assert.deepEqual(report.updated, ["persona"]);
  assert.deepEqual(report.legacy, []);
});

test("накопленное в human и current_state не затирается стартовым значением", async () => {
  const db = fakeDb([]);
  const plane = fakePlane({ present: ["human", "current_state"] });
  const report = await new PersonaSync(db as never, plane as never, logger)
    .reconcileAgent({ agentId: "agent-old", userId: 1 }, PERSONA);

  assert.deepEqual(report.created, ["therapeutic_framework"]);
  assert.ok(report.kept.includes("human"), "human обязан остаться нетронутым");
  assert.ok(report.kept.includes("current_state"));
  // Ни одной записи в блоки человека: их ведёт Ева, а не сверка схемы.
  assert.deepEqual(
    plane.updates.map((entry) => entry.label),
    ["persona"],
    "сверка полезла в блок человека",
  );
});

test("повторная сверка ничего не создаёт и не переписывает", async () => {
  const db = fakeDb([]);
  const plane = fakePlane();
  const sync = new PersonaSync(db as never, plane as never, logger);

  await sync.reconcileAgent({ agentId: "agent-old", userId: 1 }, PERSONA);
  const before = { created: plane.created.length, updated: plane.updates.length };
  const second = await sync.reconcileAgent({ agentId: "agent-old", userId: 1 }, PERSONA);

  assert.deepEqual(second.created, []);
  assert.deepEqual(second.updated, []);
  assert.equal(second.kept.length, 4);
  assert.equal(plane.created.length, before.created, "второй проход завёл блок заново");
  assert.equal(plane.updates.length, before.updated, "второй проход переписал блок заново");
});

/**
 * Блок прежней схемы остаётся у агента.
 *
 * Официального пути перенести его содержимое во внешнюю память на
 * установленных версиях нет, и это записано в реестре возможностей.
 * Снять блок, не сохранив содержимое, значило бы потерять память
 * человека ради красивой схемы «4 из 4».
 */
test("блок прежней схемы не отсоединяется, а ждёт переноса", async () => {
  const db = fakeDb([]);
  const plane = fakePlane({
    extra: [
      { id: "block-goals", label: "goals_and_commitments", value: "цели человека" },
      { id: "block-progress", label: "progress_and_hypotheses", value: "гипотезы" },
    ],
  });
  const report = await new PersonaSync(db as never, plane as never, logger)
    .reconcileAgent({ agentId: "agent-old", userId: 1 }, PERSONA);

  assert.deepEqual(
    report.legacy.map((block) => block.label).sort(),
    ["goals_and_commitments", "progress_and_hypotheses"],
  );
  for (const block of report.legacy) {
    assert.equal(block.status, "legacy_pending_migration");
    assert.ok(block.size > 0, "размер блока обязан быть виден");
  }
  assert.deepEqual(plane.detached, [], "блок прежней схемы отсоединён без переноса данных");
  // В инвентаре только метаданные: содержимое блока никуда не уходит.
  assert.doesNotMatch(JSON.stringify(report.legacy), /цели человека|гипотезы/);
});

test("перенос блока во внешнюю память объявлен неподдержанным, а не забыт", async () => {
  const { capability } = await import("../dist/letta/capabilities.js");
  const entry = capability("memory-block.export-to-memfs");
  assert.equal(entry.surface, null, "путь объявлен поддержанным, но кода переноса нет");
  assert.match(String(entry.note), /MemFS/);
});
