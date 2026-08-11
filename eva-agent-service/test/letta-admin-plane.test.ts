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
import { appServerUnavailable, unsupportedOperation } from "../dist/errors.js";
import { DeleteGuard, BLOCKING_TURN_STATES } from "../dist/letta/delete-guard.js";
import {
  MemoryBlockSync,
  SYNCED_BLOCK_LABELS,
  blockChecksum,
} from "../dist/letta/memory-block-sync.js";

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
// синхронизация блоков
// --------------------------------------------------------------------

interface SyncRow {
  user_id: number;
  agent_id: string;
  label: string;
  desired_value: string;
  status: string;
  synced_checksum: string | null;
  attempts: number;
  last_error: string | null;
}

class FakeSyncDatabase {
  rows: SyncRow[] = [];
  scopes: string[] = [];

  query = async (sql: string, values: unknown[] = []) => {
    const text = sql.replace(/--[^\n]*\n/g, " ").replace(/\s+/g, " ").trim();
    if (text.startsWith("INSERT INTO letta_memory_block_sync")) {
      const [userId, agentId, label, value, checksum] = values as [
        number, string, string, string, string,
      ];
      const existing = this.rows.find((row) => row.agent_id === agentId && row.label === label);
      if (!existing) {
        this.rows.push({
          user_id: userId,
          agent_id: agentId,
          label,
          desired_value: value,
          status: "pending",
          synced_checksum: null,
          attempts: 0,
          last_error: null,
        });
      } else {
        existing.desired_value = value;
        // Подтверждённым остаётся только то значение, которое подтвердили.
        if (existing.synced_checksum !== checksum) existing.status = "pending";
      }
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("SELECT agent_id, label")) {
      const [userId, agentId] = values as [number, string];
      const rows = this.rows
        .filter((row) => row.user_id === userId && row.agent_id === agentId)
        .sort((a, b) => a.label.localeCompare(b.label));
      return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
    }
    if (text.startsWith("UPDATE letta_memory_block_sync")) {
      const [userId, agentId, label, status, checksum, error] = values as [
        number, string, string, string, string | null, string | null,
      ];
      const row = this.rows.find(
        (item) => item.user_id === userId && item.agent_id === agentId && item.label === label,
      );
      if (row) {
        row.status = status;
        if (checksum !== null) row.synced_checksum = checksum;
        row.attempts += 1;
        row.last_error = error;
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`Неожиданный запрос: ${text.slice(0, 60)}`);
  };

  withUserScope = async <T>(input: { label: string }, work: () => Promise<T>): Promise<T> => {
    this.scopes.push(input.label);
    return await work();
  };
}

/**
 * Управляемый control plane: успех, отсутствие пути и отказ сервера.
 *
 * Ошибки настоящие — те же фабрики, которыми пользуются `DisabledAdminPlane`
 * и `toEvaError` в адаптере. Синхронизация различает исходы по коду
 * `EvaError`, и фейк, бросающий голый `Error` с полем `code`, проверял бы
 * не тот путь, что выполняется в бою.
 */
function fakePlane(mode: "ok" | "unsupported" | "broken", remote = new Map<string, string>()) {
  const written: Array<{ label: string; value: string }> = [];
  const refuse = () => {
    throw mode === "unsupported"
      ? unsupportedOperation("административный клиент выключен")
      : appServerUnavailable("нет связи с App Server");
  };
  const plane = {
    available: mode !== "unsupported",
    listMemoryBlocks: async () => {
      if (mode !== "ok") refuse();
      return [...remote].map(([label, value]) => ({
        label, value, description: null, limit: null, readOnly: false,
      }));
    },
    updateMemoryBlock: async (_agentId: string, label: string, value: string) => {
      if (mode !== "ok") refuse();
      written.push({ label, value });
      remote.set(label, value);
      return { label, value, description: null, limit: null, readOnly: false };
    },
  };
  return { plane, written };
}

test("намерение записывается до всякого обращения к Letta", async () => {
  const db = new FakeSyncDatabase();
  const { plane } = fakePlane("broken");
  const sync = new MemoryBlockSync(db as never, plane as never);

  await sync.record(7, "agent-1", "persona", "новая персона");
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0]!.status, "pending");
  // Каждый запрос назвал своего арендатора.
  assert.ok(db.scopes.every((label) => label.startsWith("letta.blocks.")));
});

test("успешная официальная запись даёт synced и повтор её не трогает", async () => {
  const db = new FakeSyncDatabase();
  const { plane, written } = fakePlane("ok");
  const sync = new MemoryBlockSync(db as never, plane as never);

  await sync.record(7, "agent-1", "persona", "персона");
  assert.deepEqual([...(await sync.apply(7, "agent-1"))], [["persona", "synced"]]);
  assert.equal(written.length, 1);

  // Повторное применение того же значения не пишет второй раз: запись в
  // блок необратима, и лишний вызов — это лишний риск, а не идемпотентность.
  assert.deepEqual([...(await sync.apply(7, "agent-1"))], [["persona", "synced"]]);
  assert.equal(written.length, 1);
  assert.equal((await sync.pending(7, "agent-1")).length, 0);
});

test("недоступный официальный путь даёт runtime_override, а не молчаливый успех", async () => {
  const db = new FakeSyncDatabase();
  const { plane } = fakePlane("unsupported");
  const sync = new MemoryBlockSync(db as never, plane as never);

  await sync.record(7, "agent-1", "human", "сведения");
  const applied = await sync.apply(7, "agent-1");

  assert.equal(applied.get("human"), "runtime_override");
  const row = db.rows[0]!;
  assert.equal(row.status, "runtime_override");
  // Ключевое: подтверждения записи нет. Иначе система считала бы блок
  // записанным, не записав его.
  assert.equal(row.synced_checksum, null);
  assert.equal(row.last_error, "unsupported_operation");
  assert.equal((await sync.pending(7, "agent-1")).length, 1);
});

test("отказ App Server отличается от отсутствия пути", async () => {
  const db = new FakeSyncDatabase();
  const { plane } = fakePlane("broken");
  const sync = new MemoryBlockSync(db as never, plane as never);

  await sync.record(7, "agent-1", "current_state", "состояние");
  assert.equal((await sync.apply(7, "agent-1")).get("current_state"), "failed");
  assert.equal(db.rows[0]!.status, "failed");
});

test("повтор превращает runtime_override в synced, когда путь появился", async () => {
  const db = new FakeSyncDatabase();
  const offline = fakePlane("unsupported");
  const sync = new MemoryBlockSync(db as never, offline.plane as never);

  await sync.record(7, "agent-1", "goals_and_commitments", "цели");
  assert.equal((await sync.apply(7, "agent-1")).get("goals_and_commitments"), "runtime_override");

  // Выключенный путь не повторяет впустую.
  assert.equal((await sync.resync(7, "agent-1")).size, 0);

  const online = fakePlane("ok");
  const resumed = new MemoryBlockSync(db as never, online.plane as never);
  assert.equal((await resumed.resync(7, "agent-1")).get("goals_and_commitments"), "synced");
  assert.equal(db.rows[0]!.status, "synced");
  assert.equal(online.written[0]!.value, "цели");
});

test("новое намерение снимает подтверждение прежнего значения", async () => {
  const db = new FakeSyncDatabase();
  const { plane, written } = fakePlane("ok");
  const sync = new MemoryBlockSync(db as never, plane as never);

  await sync.record(7, "agent-1", "persona", "первая");
  await sync.apply(7, "agent-1");
  await sync.record(7, "agent-1", "persona", "вторая");
  assert.equal(db.rows[0]!.status, "pending");
  await sync.apply(7, "agent-1");
  assert.deepEqual(written.map((entry) => entry.value), ["первая", "вторая"]);
});

test("предпросмотр показывает расхождение отпечатками, а не текстом", async () => {
  const db = new FakeSyncDatabase();
  const remote = new Map([["persona", "старое значение"]]);
  const { plane } = fakePlane("ok", remote);
  const sync = new MemoryBlockSync(db as never, plane as never);

  await sync.record(7, "agent-1", "persona", "новое значение");
  const preview = await sync.preview(7, "agent-1");

  assert.equal(preview.length, 1);
  const row = preview[0]!;
  assert.equal(row.changed, true);
  assert.equal(row.desiredChecksum, blockChecksum("новое значение"));
  assert.equal(row.remoteChecksum, blockChecksum("старое значение"));
  assert.equal(row.desiredLength, "новое значение".length);
  // Ни одного поля с самим текстом: предпросмотр смотрит человек.
  const serialized = JSON.stringify(row);
  assert.equal(serialized.includes("новое значение"), false);
  assert.equal(serialized.includes("старое значение"), false);
});

test("непрочитанная удалённая сторона не выдаётся за совпадение", async () => {
  const db = new FakeSyncDatabase();
  const { plane } = fakePlane("broken");
  const sync = new MemoryBlockSync(db as never, plane as never);

  await sync.record(7, "agent-1", "persona", "значение");
  const row = (await sync.preview(7, "agent-1"))[0]!;
  assert.equal(row.remoteChecksum, null);
  assert.equal(row.changed, true, "неизвестное состояние обязано считаться расхождением");
  assert.match(row.reason, /не прочитано/);
});

test("метка вне закрытого набора не синхронизируется", async () => {
  const db = new FakeSyncDatabase();
  const { plane, written } = fakePlane("ok");
  const sync = new MemoryBlockSync(db as never, plane as never);

  // Строка из восстановленной копии со старой схемой блоков.
  db.rows.push({
    user_id: 7,
    agent_id: "agent-1",
    label: "legacy_block",
    desired_value: "наследие",
    status: "pending",
    synced_checksum: null,
    attempts: 0,
    last_error: null,
  });
  assert.equal((await sync.apply(7, "agent-1")).size, 0);
  assert.equal(written.length, 0);
  assert.equal(SYNCED_BLOCK_LABELS.length, 6);
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
