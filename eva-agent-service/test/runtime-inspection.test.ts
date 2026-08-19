/**
 * Самопроверка рантайма отвечает фактами, а не впечатлением.
 *
 * Главное здесь — разница между «наблюдаю» и «не могу подтвердить».
 * Раньше на вопрос о собственной памяти и навыках Ева отвечала
 * самоотчётом, и он расходился с действительностью; отчёт обязан
 * отличать пустое наблюдение от отрицательного ответа.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectRuntime } from "../dist/letta/runtime-inspection.js";
import { CoreToolFactory } from "../dist/tools/core-tools.js";

const tool = (
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  execute: (args: Record<string, unknown>, runtime: unknown) => Promise<unknown>,
) => ({
  name, label, description, parameters,
  execute: async (_callId: string, args: Record<string, unknown>, runtime: unknown) =>
    ({ details: await execute(args, runtime) }),
});

async function skillsRoot(names: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eva-skills-"));
  for (const name of names) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(
      join(root, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Когда нужен ${name}.\n---\n\nТело.\n`,
      "utf8",
    );
  }
  return root;
}

const RUNTIME = {
  memfsEnabled: true,
  skillSources: ["bundled", "project"],
  tools: ["Skill", "memory"],
  observedAt: "2026-08-19T10:00:00.000Z",
};

test("наблюдаемое и ненаблюдаемое различаются, а не сливаются в «нет»", async () => {
  const root = await skillsRoot(["cbt"]);
  const blind = await inspectRuntime({
    runtime: null, session: null, memory: null, skillsRoot: root,
    calls: { skillCalls: 0, last: null },
  });

  // Ни одного факта не наблюдали — и отчёт говорит именно это.
  assert.equal(blind.memory.present, null);
  assert.equal(blind.memory.missing, null);
  assert.equal(blind.memory.complete, null);
  assert.equal(blind.memfs.enabled, null);
  assert.equal(blind.memfs.directoryPresent, null);
  assert.equal(blind.skills.nativeSkillTool, null, "состав инструментов неизвестен");
  assert.equal(blind.observedAt, null);
});

test("полное ядро памяти и неполное различаются по фактическим меткам", async () => {
  const root = await skillsRoot(["cbt"]);
  const full = await inspectRuntime({
    runtime: RUNTIME,
    session: { tools: ["Skill"], memoryDirectory: "/data/agent/memory", observedAt: "2026-08-19T10:05:00.000Z" },
    memory: {
      checked: true,
      canonicalPresent: ["persona", "human", "current_state", "therapeutic_framework"],
      legacy: [],
    },
    skillsRoot: root,
    calls: { skillCalls: 3, last: { skillName: "cbt", at: "2026-08-19T09:00:00.000Z", succeeded: true } },
  });
  assert.equal(full.memory.complete, true);
  assert.deepEqual(full.memory.missing, []);
  assert.equal(full.memfs.enabled, true);
  assert.equal(full.memfs.directoryPresent, true);
  // Путь к памяти наружу не уходит — только факт наличия.
  assert.doesNotMatch(JSON.stringify(full), /\/data\/agent\/memory/);
  assert.equal(full.skills.nativeSkillTool, true);
  assert.equal(full.calls.skillCalls, 3);

  const partial = await inspectRuntime({
    runtime: RUNTIME, session: null, skillsRoot: root,
    memory: {
      checked: true,
      canonicalPresent: ["persona", "human", "current_state"],
      legacy: [{
        id: "b1", label: "goals_and_commitments", description: null,
        size: 812, status: "legacy_pending_migration",
      }],
    },
    calls: { skillCalls: 0, last: null },
  });
  assert.equal(partial.memory.complete, false);
  assert.deepEqual(partial.memory.missing, ["therapeutic_framework"]);
  assert.deepEqual(partial.memory.legacy, [
    { label: "goals_and_commitments", status: "legacy_pending_migration", size: 812 },
  ]);
});

test("инструмент самопроверки ничего не меняет и отказывает честно", async () => {
  const root = await skillsRoot(["cbt", "act"]);
  const writes: string[] = [];
  const db = {
    withUserScope: async <T>(_scope: unknown, work: () => Promise<T>) => await work(),
    query: async (sql: string) => { writes.push(sql); return { rows: [] }; },
    skillCallStats: async () => ({
      total: 2, last: { skillName: "cbt", at: "2026-08-19T09:00:00.000Z", succeeded: true },
    }),
  };
  const observed: string[] = [];
  const factory = new CoreToolFactory(
    { routerUrl: "", routerApiKey: "", skillsDir: root } as never,
    db as never,
    {} as never,
    undefined,
    {
      facts: () => ({ runtime: RUNTIME, session: null }),
      memory: async (agentId: string) => {
        observed.push(agentId);
        return {
          checked: true,
          canonicalPresent: ["persona", "human", "current_state", "therapeutic_framework"],
          legacy: [],
        };
      },
      agentOf: async () => "agent-1",
    },
  );
  const tools = new Map(factory.build(tool as never).map((entry) => [entry.name, entry]));
  assert.ok(tools.has("inspect_eva_runtime"), "инструмент не зарегистрирован");

  const runtime = { userId: 77, telegramId: 42, chatId: 42, conversationId: "c", purpose: "chat" };
  const result = await tools.get("inspect_eva_runtime")!.execute("call-1", {}, runtime as never);
  const details = result.details as {
    ok: boolean;
    memory: { complete: boolean | null };
    calls: { skillCalls: number };
  };
  assert.equal(details.ok, true);
  assert.equal(details.memory.complete, true);
  assert.equal(details.calls.skillCalls, 2);
  assert.deepEqual(observed, ["agent-1"], "состав блоков читается ровно один раз");
  assert.deepEqual(writes, [], "самопроверка не должна писать в базу");

  // Без наблюдателя инструмент отказывает названной причиной, а не
  // выдаёт пустой отчёт за наблюдение.
  const blindFactory = new CoreToolFactory(
    { routerUrl: "", routerApiKey: "", skillsDir: root } as never,
    db as never,
    {} as never,
  );
  const blind = new Map(blindFactory.build(tool as never).map((entry) => [entry.name, entry]));
  const refused = await blind.get("inspect_eva_runtime")!.execute("call-2", {}, runtime as never);
  assert.equal((refused.details as { ok: boolean }).ok, false);
});
