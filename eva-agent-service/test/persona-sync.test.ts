import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PersonaSync, personaSyncState, personaVersion } from "../dist/letta/persona-sync.js";
import { evaMemoryBlocks } from "../dist/letta.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const PERSONA = "# Ева\n\nО себе говорю в женском роде: поняла, сделала, готова.";

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
    recordPersonaVersion: async (agentId: string, _userId: number, version: string) => {
      recorded.push({ agentId, version });
    },
  };
}

function fakePlane(options: {
  blocks?: Record<string, string>;
  failOn?: string;
  available?: boolean;
} = {}) {
  const updates: Array<{ agentId: string; label: string; value: string }> = [];
  return {
    updates,
    available: options.available ?? true,
    listMemoryBlocks: async (agentId: string) => {
      if (options.failOn === agentId) throw new Error("control plane недоступен");
      const value = options.blocks?.[agentId] ?? "старый текст персоны";
      return [{ label: "persona", value, description: null, limit: null, readOnly: false }];
    },
    updateMemoryBlock: async (agentId: string, label: string, value: string) => {
      updates.push({ agentId, label, value });
      return { label, value, description: null, limit: null, readOnly: false };
    },
  };
}

test("существующий агент получает канонический текст персоны", async () => {
  const version = personaVersion(PERSONA);
  const db = fakeDb([
    { agentId: "agent-old", userId: 1, personaVersion: null },
    { agentId: "agent-fresh", userId: 2, personaVersion: version },
  ]);
  const plane = fakePlane();

  const result = await new PersonaSync(db as never, plane as never, logger).sync(PERSONA);

  assert.deepEqual(result, { checked: 2, updated: 1, upToDate: 1, failed: 0, version });
  assert.deepEqual(plane.updates, [{ agentId: "agent-old", label: "persona", value: PERSONA }]);
  // Отметка версии — не копия блока: в базе остаётся отпечаток, а не текст.
  assert.deepEqual(db.recorded, [{ agentId: "agent-old", version }]);
  assert.doesNotMatch(JSON.stringify(db.recorded), /женском роде/);
});

test("агент с тем же текстом не переписывается зря", async () => {
  const db = fakeDb([{ agentId: "agent-1", userId: 1, personaVersion: "старая-версия" }]);
  const plane = fakePlane({ blocks: { "agent-1": `${PERSONA}\n` } });

  const result = await new PersonaSync(db as never, plane as never, logger).sync(PERSONA);

  assert.equal(result.updated, 0);
  assert.equal(result.upToDate, 1);
  assert.deepEqual(plane.updates, [], "лишняя запись в память агента");
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
    checked: 0, updated: 0, upToDate: 0, failed: 0, version: personaVersion(PERSONA),
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
  assert.deepEqual(db.recorded, [{ agentId: "agent-old", version: personaVersion(canonical) }]);
});

test("агент с актуальной версией не тревожится перед ходом", async () => {
  const db = fakeDb([]);
  const plane = fakePlane();
  const sync = new PersonaSync(db as never, plane as never, logger);
  const outcome = await sync.syncAgent(
    { agentId: "agent-1", userId: 1, storedVersion: personaVersion(PERSONA) },
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
