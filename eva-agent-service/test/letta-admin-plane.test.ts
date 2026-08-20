/**
 * Административный control plane Letta: границы, честные статусы
 * синхронизации блоков и запрет удаления при незакончившемся ходе.
 *
 * База подменена таблицей в памяти, официальный клиент — фабрикой:
 * проверяется поведение адаптера и правила выборки, а не HTTP. Живой
 * App Server остаётся за smoke-стендом, и притворяться, что он здесь
 * есть, тест не должен.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DisabledAdminPlane,
  LettaAdminClient,
  buildAdminPlane,
} from "../dist/letta/admin-client.js";
import { DeleteGuard, BLOCKING_TURN_STATES } from "../dist/letta/delete-guard.js";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// --------------------------------------------------------------------
// граница: control plane не становится вторым путём диалога
// --------------------------------------------------------------------

test("у административного пути нет ни одного метода отправки сообщения", () => {
  // Инвариант 4 проверяется формой интерфейса, а не обещанием: если
  // однажды сюда добавят `send` или `stream`, тест упадёт раньше ревью.
  const forbidden = ["send", "stream", "prompt", "runTurn", "createSession", "resumeSession"];
  for (const implementation of [DisabledAdminPlane.prototype, LettaAdminClient.prototype]) {
    const methods = new Set(Object.getOwnPropertyNames(implementation));
    for (const name of forbidden) {
      assert.equal(methods.has(name), false, `${name} создаёт второй путь выполнения диалога`);
    }
  }
});

test("выключенный флаг и пустой адрес дают отказ, а не тишину", async () => {
  const off = buildAdminPlane({ enabled: false, baseUrl: "http://letta:8283", token: null, logger });
  const noUrl = buildAdminPlane({ enabled: true, baseUrl: "", token: null, logger });
  for (const plane of [off, noUrl]) {
    assert.equal(plane.available, false);
    await assert.rejects(
      () => plane.updateMemoryBlock("agent-1", "persona", "текст"),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "unsupported_operation");
        return true;
      },
    );
    await assert.rejects(() => plane.listMemoryBlocks("agent-1"));
  }
});

test("адаптер нормализует блок и не пишет его значение в журнал", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const recording = { ...logger, info: (_m: string, meta?: Record<string, unknown>) => {
    lines.push(meta ?? {});
  } };
  const secret = "очень личный текст пользователя";
  const client = new LettaAdminClient(
    { enabled: true, baseUrl: "http://letta:8283", token: null, logger: recording },
    async () => ({
      agents: {
        blocks: {
          list: async () => [{ label: "persona", value: "a", limit: 15_000, read_only: false }],
          update: async (label: string, params: Record<string, unknown>) => ({
            label,
            value: params.value,
            description: null,
          }),
        },
      },
    }) as never,
  );

  const blocks = await client.listMemoryBlocks("agent-1");
  assert.deepEqual(blocks[0], {
    // Без `id` блок нельзя ни присоединить, ни отсоединить: обе операции
    // адресуют его именно так, а не по метке.
    id: "",
    label: "persona",
    value: "a",
    description: null,
    limit: 15_000,
    readOnly: false,
  });

  const updated = await client.updateMemoryBlock("agent-1", "human", secret);
  assert.equal(updated.value, secret);
  const serialized = JSON.stringify(lines);
  assert.equal(serialized.includes(secret), false, "значение блока утекло в журнал");
  assert.equal(serialized.includes(String(secret.length)), true, "длина обязана остаться");
});

// --------------------------------------------------------------------
// запрет удаления
// --------------------------------------------------------------------

class FakeTurnDatabase {
  turns: Array<{ run_id: string; state: string; agent_id: string; conversation_id: string | null }> = [];
  reasons: string[] = [];
  crossUser: boolean[] = [];

  query = async (sql: string, values: unknown[] = []) => {
    const text = sql.replace(/--[^\n]*\n/g, " ").replace(/\s+/g, " ").trim();
    assert.match(text, /FROM turn_runs/);
    const [value, terminal] = values as [string, string[]];
    const byAgent = text.includes("WHERE agent_id");
    const rows = this.turns.filter(
      (turn) => (byAgent ? turn.agent_id : turn.conversation_id) === value
        && !terminal.includes(turn.state),
    );
    return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
  };

  withSystemScope = async <T>(
    reason: string,
    work: () => Promise<T>,
    options: { crossUser?: boolean } = {},
  ): Promise<T> => {
    this.reasons.push(reason);
    this.crossUser.push(options.crossUser === true);
    return await work();
  };
}

test("активный ход запрещает удаление агента", async () => {
  const db = new FakeTurnDatabase();
  db.turns.push({ run_id: "r1", state: "letta_processing", agent_id: "agent-1", conversation_id: "c1" });
  const guard = new DeleteGuard(db as never);

  await assert.rejects(
    () => guard.assertAgentDeletable("agent-1"),
    (error: unknown) => {
      const evaError = error as { code?: string; statusCode?: number; details?: Record<string, unknown> };
      assert.equal(evaError.code, "deletion_blocked");
      assert.equal(evaError.statusCode, 409);
      assert.equal(evaError.details?.blocking_turns, 1);
      assert.equal(evaError.details?.awaiting_approval, 0);
      return true;
    },
  );
  // Выборка обязана видеть чужого пользователя: удаляет администратор.
  assert.deepEqual(db.crossUser, [true]);
});

test("ожидающее подтверждение названо отдельно от выполняющегося хода", async () => {
  const db = new FakeTurnDatabase();
  db.turns.push({ run_id: "r1", state: "approval_pending", agent_id: "agent-1", conversation_id: "c1" });
  const guard = new DeleteGuard(db as never);

  await assert.rejects(
    () => guard.assertAgentDeletable("agent-1"),
    (error: unknown) => {
      assert.equal((error as { details?: Record<string, unknown> }).details?.awaiting_approval, 1);
      assert.match((error as Error).message, /ожидают подтверждения/);
      return true;
    },
  );
});

test("законченный ход удалению не мешает", async () => {
  const db = new FakeTurnDatabase();
  for (const state of ["completed", "cancelled", "failed_terminal"]) {
    db.turns.push({ run_id: state, state, agent_id: "agent-1", conversation_id: "c1" });
  }
  const guard = new DeleteGuard(db as never);
  await guard.assertAgentDeletable("agent-1");
  await guard.assertConversationDeletable("c1");
});

test("архивирование conversation проверяется тем же стражем", async () => {
  const db = new FakeTurnDatabase();
  db.turns.push({ run_id: "r1", state: "tools_pending", agent_id: "agent-1", conversation_id: "c1" });
  const guard = new DeleteGuard(db as never);

  await assert.rejects(() => guard.assertConversationDeletable("c1"));
  // Другой conversation того же агента не задет.
  await guard.assertConversationDeletable("c2");
});

test("новое состояние хода по умолчанию считается активным", () => {
  // Список выводится из канонического, а не выписан рядом: иначе
  // добавленное состояние молча разрешило бы удаление.
  assert.equal(BLOCKING_TURN_STATES.includes("approval_pending"), true);
  assert.equal(BLOCKING_TURN_STATES.includes("recovery_required"), true);
  assert.equal(BLOCKING_TURN_STATES.includes("completed"), false);
  assert.equal(BLOCKING_TURN_STATES.length, 18);
});

/**
 * Создание и отсоединение блока идут официальными операциями клиента.
 *
 * Проверяется именно то, чем сверка ядра памяти пользуется: `blocks.create`
 * заводит блок, `agents.blocks.attach` вешает его на агента, а значение
 * блока в журнал не попадает — только метка и длина.
 */
test("недостающий блок заводится и присоединяется официальными вызовами", async () => {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const lines: Array<Record<string, unknown>> = [];
  const recording = { ...logger, info: (_m: string, meta?: Record<string, unknown>) => {
    lines.push(meta ?? {});
  } };
  const secret = "текст терапевтической рамки";
  const client = new LettaAdminClient(
    { enabled: true, baseUrl: "http://letta:8283", token: null, logger: recording },
    async () => ({
      agents: {
        blocks: {
          list: async () => [],
          update: async () => ({}),
          attach: async (...args: unknown[]) => { calls.push({ op: "attach", args }); return {}; },
          detach: async (...args: unknown[]) => { calls.push({ op: "detach", args }); return {}; },
        },
      },
      blocks: {
        create: async (params: Record<string, unknown>) => {
          calls.push({ op: "create", args: [params] });
          return { id: "block-new", label: params.label, value: params.value, description: null };
        },
      },
    }) as never,
  );

  const created = await client.createMemoryBlock("agent-1", {
    label: "therapeutic_framework", value: secret, description: "рамка", limit: 6_000,
  });

  assert.equal(created.id, "block-new");
  assert.deepEqual(calls.map((call) => call.op), ["create", "attach"]);
  assert.deepEqual(calls[1]?.args, ["block-new", { agent_id: "agent-1" }]);
  assert.doesNotMatch(JSON.stringify(lines), new RegExp(secret));
  assert.equal(lines[0]?.valueLength, secret.length);

  await client.detachMemoryBlock("agent-1", "block-old");
  assert.deepEqual(calls.at(-1), { op: "detach", args: ["block-old", { agent_id: "agent-1" }] });
});

test("выключенный путь отказывает и созданию блока, и отсоединению", async () => {
  const plane = new DisabledAdminPlane("флаг выключен");
  await assert.rejects(
    () => plane.createMemoryBlock("agent-1", { label: "human", value: "x" }),
    /недоступен/,
  );
  await assert.rejects(() => plane.detachMemoryBlock("agent-1", "block-1"), /недоступен/);
  await assert.rejects(() => plane.recompileAgentConversations("agent-1"), /недоступен/);
});

test("explicit conversations пересобираются официальным conversations.recompile", async () => {
  const calls: Array<{ conversationId: string; params: Record<string, unknown> }> = [];
  const listed: Record<string, unknown>[] = [];
  const client = new LettaAdminClient(
    { enabled: true, baseUrl: "http://letta:8283", token: null, logger },
    async () => ({
      conversations: {
        // Реальный @letta-ai/letta-client@1.12.1 возвращает
        // APIPromise<Array<Conversation>>, а не AsyncIterable.
        list: (params: Record<string, unknown>) => {
          listed.push(params);
          return Promise.resolve([{ id: "conv-1" }, { id: "conv-2" }]);
        },
        recompile: async (conversationId: string, params: Record<string, unknown>) => {
          calls.push({ conversationId, params });
          return "compiled";
        },
      },
    }) as never,
  );

  const ids = await client.recompileAgentConversations("agent-1");

  assert.deepEqual(ids, ["conv-1", "conv-2"]);
  assert.deepEqual(listed, [{ agent_id: "agent-1", archive_status: "all" }]);
  assert.deepEqual(calls, [
    { conversationId: "conv-1", params: { agent_id: "agent-1" } },
    { conversationId: "conv-2", params: { agent_id: "agent-1" } },
  ]);
});

test("conversations.list() возвращает Promise/массив, а не AsyncIterable — regression", async () => {
  // Проверяем, что реальный SDK-контракт совместим с нашим кодом:
  // conversations.list() — это APIPromise<Array<Conversation>>.
  // Если кто-то снова объявит его как AsyncIterable, этот тест поймает.
  const client = new LettaAdminClient(
    { enabled: true, baseUrl: "http://letta:8283", token: null, logger },
    async () => ({
      conversations: {
        list: () => Promise.resolve([{ id: "c1" }]),
        recompile: async () => ({}),
      },
    }) as never,
  );
  const ids = await client.recompileAgentConversations("agent-x");
  assert.deepEqual(ids, ["c1"]);
});
