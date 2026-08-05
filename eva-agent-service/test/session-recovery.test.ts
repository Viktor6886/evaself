/**
 * Безопасный менеджер сессий, барьер отмены, журнал побочных эффектов и
 * восстановление хода.
 *
 * Проверяется поведение, а не наличие полей: активную сессию пытаются
 * вытеснить и закрыть по-настоящему, отмену объявляют посреди потока,
 * инструмент вызывают дважды с тем же ключом, а сбой вставляют в каждую
 * из семи точек хода.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentToolFactory } from "../dist/agent-tools.js";
import { EvaError } from "../dist/errors.js";
import { LettaService } from "../dist/letta.js";
import { EffectJournal, effectKey } from "../dist/turns/effect-journal.js";
import { TurnRecoveryService } from "../dist/turns/recovery.js";
import { TERMINAL_STATES, TURN_STATES } from "../dist/turns/states.js";
import { TurnLifecycle } from "../dist/turns/turn-lifecycle.js";
import { runInTurn } from "../dist/turns/turn-context.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const CONFIG = {
  appServerUrl: "ws://localhost:4500",
  appServerToken: "",
  model: "test-model",
  sessionPoolSize: 2,
  sessionIdleMs: 60_000,
  turnTimeoutMs: 5_000,
  appServerRequestTimeoutMs: 5_000,
  safeSessionManager: true,
  sessionDrainMs: 300,
};

interface FakeSession {
  closed: boolean;
  aborted: boolean;
  events: unknown[];
  failAt: "send" | "stream" | null;
}

/** Сессия SDK ровно в том объёме, в каком её использует ход. */
function fakeSession(events: unknown[] = [], failAt: "send" | "stream" | null = null) {
  const state: FakeSession = { closed: false, aborted: false, events, failAt };
  return {
    state,
    session: {
      agentId: "agent-1",
      conversationId: "conv-1",
      initialize: async () => {},
      bootstrapState: async () => ({}),
      recoverPendingApprovals: async () => ({ recovered: false }),
      send: async () => {
        if (state.failAt === "send") throw new Error("App Server недоступен");
      },
      stream: () => {
        let index = 0;
        return {
          next: async () => {
            if (state.failAt === "stream" && index === 1) throw new Error("поток оборвался");
            if (index >= state.events.length) return { done: true, value: undefined };
            return { done: false, value: state.events[index++] };
          },
        };
      },
      abort: async () => {
        state.aborted = true;
      },
      close: () => {
        state.closed = true;
      },
    },
  };
}

const REPLY = [
  { type: "assistant", content: "Понимаю." },
  { type: "result", stopReason: "end_turn", usage: {} },
];

interface Harness {
  service: LettaService;
  sessions: Map<string, { activeTurns: number; closing: boolean; shardId: string }>;
  made: Array<ReturnType<typeof fakeSession>>;
}

function harness(config: Partial<typeof CONFIG> = {}, events: unknown[] = REPLY): Harness {
  const service = new LettaService({ ...CONFIG, ...config } as never, logger as never, "персона");
  const internal = service as unknown as {
    client: Record<string, unknown>;
    sessions: Map<string, { activeTurns: number; closing: boolean; shardId: string }>;
  };
  const made: Array<ReturnType<typeof fakeSession>> = [];
  internal.client = {
    resumeSession: () => {
      const created = fakeSession([...events]);
      made.push(created);
      return created.session;
    },
  };
  return { service, sessions: internal.sessions, made };
}

// ---------------------------------------------------------------------
// 1. Активная сессия не вытесняется
// ---------------------------------------------------------------------

test("активная сессия не вытесняется ни по LRU, ни по простою", async () => {
  const { service, sessions } = harness({ sessionPoolSize: 1, sessionIdleMs: 0 });
  const internal = service as unknown as {
    acquirePooled: (id: string) => Promise<{ activeTurns: number }>;
    evictIdleSessions: () => void;
  };

  const busy = await internal.acquirePooled("conv-busy");
  busy.activeTurns = 1;
  const idle = await internal.acquirePooled("conv-idle");
  idle.activeTurns = 0;

  // Пул размером 1 и нулевой простой: без защиты вытеснило бы обе.
  internal.evictIdleSessions();

  assert.ok(sessions.has("conv-busy"), "активная сессия вытеснена");
  assert.ok(!sessions.has("conv-idle"), "простаивающая сессия не вытеснена");
});

test("закрытие активной сессии откладывается до конца хода", async () => {
  const { service, sessions, made } = harness();
  const internal = service as unknown as {
    acquirePooled: (id: string) => Promise<{ activeTurns: number; closing: boolean }>;
    closeIfDrained: (pooled: unknown) => void;
  };

  const pooled = await internal.acquirePooled("conv-1");
  pooled.activeTurns = 1;

  assert.equal(service.closeSession("conv-1"), false, "закрытие не было отложено");
  assert.ok(sessions.has("conv-1"), "сессия закрыта посреди хода");
  assert.equal(made[0]!.state.closed, false);
  assert.equal(pooled.closing, true);

  // Ход закончился — сессия уходит сама.
  pooled.activeTurns = 0;
  internal.closeIfDrained(pooled);
  assert.ok(!sessions.has("conv-1"));
  assert.equal(made[0]!.state.closed, true);
});

test("при выключенном флаге поведение прежнее: закрывается что угодно", async () => {
  const { service, sessions } = harness({ safeSessionManager: false });
  const internal = service as unknown as {
    acquirePooled: (id: string) => Promise<{ activeTurns: number }>;
  };
  const pooled = await internal.acquirePooled("conv-1");
  pooled.activeTurns = 1;

  assert.equal(service.closeSession("conv-1"), true);
  assert.ok(!sessions.has("conv-1"), "выключенный флаг должен возвращать прежнее поведение");
});

test("ход держит счётчик и отпускает его в любом случае", async () => {
  const { service, sessions } = harness();
  await service.runTurn("conv-1", { role: "user", content: "привет" } as never);
  assert.equal(sessions.get("conv-1")?.activeTurns, 0, "счётчик не отпущен после хода");

  const broken = harness({}, []);
  const internalBroken = broken.service as unknown as { client: Record<string, unknown> };
  internalBroken.client = {
    resumeSession: () => {
      const created = fakeSession([], "send");
      broken.made.push(created);
      return created.session;
    },
  };
  await assert.rejects(() => broken.service.runTurn("conv-2", { role: "user" } as never));
  assert.ok(!broken.sessions.has("conv-2"), "повреждённая сессия осталась в пуле");
});

test("сбой хода закрывает только повреждённую сессию", async () => {
  const { service, sessions, made } = harness();
  const internal = service as unknown as { client: Record<string, unknown> };
  await service.runTurn("conv-healthy", { role: "user" } as never);
  assert.ok(sessions.has("conv-healthy"));

  internal.client = {
    resumeSession: () => {
      const created = fakeSession([], "send");
      made.push(created);
      return created.session;
    },
  };
  await assert.rejects(() => service.runTurn("conv-broken", { role: "user" } as never));

  assert.ok(sessions.has("conv-healthy"), "здоровая сессия закрыта вместе с повреждённой");
  assert.ok(!sessions.has("conv-broken"));
});

test("смена настроек SDK не рвёт идущий ход, а дожидается его", async () => {
  const { service, sessions, made } = harness();
  const internal = service as unknown as {
    acquirePooled: (id: string) => Promise<{ activeTurns: number }>;
    runtime: Record<string, unknown>;
  };
  const pooled = await internal.acquirePooled("conv-1");
  pooled.activeTurns = 1;

  const drain = service.drainSessions(150);
  // Пока ход идёт, сессия на месте.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(sessions.has("conv-1"), "сессия закрыта, не дождавшись хода");
  assert.equal(made[0]!.state.closed, false);

  pooled.activeTurns = 0;
  const outcome = await drain;
  assert.ok(!sessions.has("conv-1"), "сессия не закрылась после освобождения");
  assert.equal(outcome.forced, 0, "сессию закрыли силой, хотя она освободилась сама");
});

test("drain не ждёт вечно: по истечении срока сессии закрываются силой", async () => {
  const { service, sessions } = harness();
  const internal = service as unknown as {
    acquirePooled: (id: string) => Promise<{ activeTurns: number }>;
  };
  const pooled = await internal.acquirePooled("conv-1");
  pooled.activeTurns = 1;

  const started = Date.now();
  const outcome = await service.drainSessions(120);
  const waited = Date.now() - started;

  assert.ok(waited < 800, `drain ждал ${waited} мс вместо отведённых 120`);
  assert.equal(outcome.forced, 1, "зависшая сессия не закрыта силой");
  assert.ok(!sessions.has("conv-1"));
});

// ---------------------------------------------------------------------
// 2. Барьер отмены
// ---------------------------------------------------------------------

test("отмена во время генерации останавливает поток и не отдаёт ответ", async () => {
  const { service, made } = harness({}, [
    { type: "assistant", content: "начал отвечать" },
    { type: "assistant", content: "продолжаю" },
    { type: "result", stopReason: "end_turn" },
  ]);

  let cancelled = false;
  await assert.rejects(
    () => service.runTurn("conv-1", { role: "user" } as never, {
      cancelPollMs: 0,
      isCancelled: async () => {
        // Отмена объявляется после первого события потока.
        const now = cancelled;
        cancelled = true;
        return now;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof EvaError);
      assert.equal(error.code, "turn_cancelled");
      return true;
    },
  );

  assert.equal(made[0]!.state.aborted, true, "генерация не остановлена");
});

test("отменённый ход не считается поломкой сессии", async () => {
  const { service, sessions } = harness({}, [
    { type: "assistant", content: "первое" },
    { type: "result", stopReason: "end_turn" },
  ]);
  await assert.rejects(() =>
    service.runTurn("conv-1", { role: "user" } as never, {
      cancelPollMs: 0,
      isCancelled: async () => true,
    }));

  const pooled = sessions.get("conv-1");
  assert.ok(pooled, "сессия закрыта из-за отмены");
  assert.equal(pooled!.closing, false, "сессия помечена уходящей из-за отмены");
  assert.equal(pooled!.activeTurns, 0);
});

// ---------------------------------------------------------------------
// 3. Журнал побочных эффектов
// ---------------------------------------------------------------------

interface EffectRow {
  effect_key: string;
  run_id: string;
  user_id: number | null;
  status: string;
  attempt: number;
  result: unknown;
  result_hash: string | null;
  error_code: string | null;
  retryable: boolean;
}

/** База ровно в том объёме, в каком её использует журнал. */
class FakeEffectDb {
  readonly rows = new Map<string, EffectRow>();

  query = async (sql: string, values: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const text = sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
    // Поддельная база повторяет ровно те запросы, которые шлёт журнал.
    // Их семантика отдельно проверяется на настоящем PostgreSQL —
    // scripts/ci/test-effect-journal.sql.
    if (text.startsWith("INSERT INTO tool_effects")) {
      const key = String(values[0]);
      if (this.rows.has(key)) return { rows: [] };
      this.rows.set(key, {
        effect_key: key,
        run_id: String(values[1]),
        user_id: values[2] === null ? null : Number(values[2]),
        status: "running",
        attempt: 1,
        result: null,
        result_hash: null,
        error_code: null,
        retryable: true,
      });
      return { rows: [{ effect_key: key }] };
    }
    if (text.startsWith("SELECT status, attempt")) {
      const row = this.rows.get(String(values[0]));
      if (!row || row.user_id !== Number(values[1])) return { rows: [] };
      return { rows: [{ ...row }] };
    }
    if (text.includes("SET status = 'running'")) {
      const row = this.rows.get(String(values[0]));
      // Право на повтор забирает только тот, кто застал строку в отказе.
      if (!row || row.user_id !== Number(values[1]) || row.status !== "failed") {
        return { rows: [] };
      }
      row.status = "running";
      row.attempt += 1;
      return { rows: [{ attempt: row.attempt }] };
    }
    if (text.startsWith("UPDATE tool_effects")) {
      const row = this.rows.get(String(values[0]));
      // Владелец обязателен: без совпадения строка «не видна».
      if (!row || row.user_id !== Number(values[1])) return { rows: [] };
      if (text.includes("'succeeded'")) {
        row.status = "succeeded";
        row.result = values[2] === null ? null : JSON.parse(String(values[2]));
        row.result_hash = (values[3] as string | null) ?? null;
      } else {
        row.status = "failed";
        row.error_code = String(values[2]);
        row.retryable = values[3] === true;
      }
      return { rows: [] };
    }
    if (text.startsWith("SELECT status, count(*)")) {
      const counts = new Map<string, number>();
      for (const row of this.rows.values()) {
        if (row.run_id !== values[0] || row.user_id !== Number(values[1])) continue;
        counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      }
      return { rows: [...counts].map(([status, count]) => ({ status, count: String(count) })) };
    }
    throw new Error(`поддельная база не знает запроса: ${text.slice(0, 50)}`);
  };
}

function journal(db: FakeEffectDb, enabled = true): EffectJournal {
  return new EffectJournal(withTenantScopes({ query: db.query }) as never, logger as never, enabled);
}

test("повторный вызов инструмента с тем же ключом не выполняется второй раз", async () => {
  const db = new FakeEffectDb();
  const effects = journal(db);
  const key = effectKey("run-1", "call-1", "save_task");
  const input = { key, runId: "run-1", userId: 42, toolName: "save_task", toolCallId: "call-1" };

  let executions = 0;
  const runOnce = async () => {
    const decision = await effects.begin(input);
    if (decision.action !== "execute") return decision;
    executions += 1;
    await effects.succeed(key, 42, { task_id: 7 });
    return decision;
  };

  await runOnce();
  const second = await runOnce();

  assert.equal(executions, 1, "инструмент выполнился дважды");
  assert.equal(second.action, "replay");
  assert.deepEqual(
    (second as { result: unknown }).result,
    { task_id: 7 },
    "повтор не вернул прежний результат",
  );
});

test("тот же вызов, идущий прямо сейчас, не повторяется", async () => {
  const db = new FakeEffectDb();
  const effects = journal(db);
  const key = effectKey("run-2", "call-1", "send_message");
  const input = { key, runId: "run-2", userId: 42, toolName: "send_message", toolCallId: "call-1" };

  assert.equal((await effects.begin(input)).action, "execute");
  const second = await effects.begin(input);
  assert.equal(second.action, "skip");
  assert.equal((second as { reason: string }).reason, "in_flight");
});

test("повторяемый отказ пробуют снова, неповторяемый — нет", async () => {
  const db = new FakeEffectDb();
  const effects = journal(db);
  const retryKey = effectKey("run-3", "call-1", "search");
  const fatalKey = effectKey("run-3", "call-2", "save_task");

  await effects.begin({
    key: retryKey, runId: "run-3", userId: 42, toolName: "search", toolCallId: "call-1",
  });
  await effects.fail(retryKey, 42, "Error", true);
  const retried = await effects.begin({
    key: retryKey, runId: "run-3", userId: 42, toolName: "search", toolCallId: "call-1",
  });
  assert.equal(retried.action, "execute");
  assert.equal((retried as { attempt: number }).attempt, 2);

  await effects.begin({
    key: fatalKey, runId: "run-3", userId: 42, toolName: "save_task", toolCallId: "call-2",
  });
  await effects.fail(fatalKey, 42, "TypeError", false);
  const blocked = await effects.begin({
    key: fatalKey, runId: "run-3", userId: 42, toolName: "save_task", toolCallId: "call-2",
  });
  assert.equal(blocked.action, "skip");
  assert.equal((blocked as { reason: string }).reason, "not_retryable");
});

test("в журнал не попадает пользовательский текст: строки сводятся к хэшу", async () => {
  const db = new FakeEffectDb();
  const effects = journal(db);
  const key = effectKey("run-4", "call-1", "eva_notes_search");
  await effects.begin({
    key, runId: "run-4", userId: 42, toolName: "eva_notes_search", toolCallId: "call-1",
  });
  await effects.succeed(key, 42, { note: "мне снова тяжело собраться", ok: true });

  const row = db.rows.get(key)!;
  assert.equal(row.result, null, "пользовательский текст записан как есть");
  assert.ok(row.result_hash, "результат не сведён к хэшу");
  assert.ok(!JSON.stringify([...db.rows.values()]).includes("тяжело"));

  // Чистые счётчики и флаги сохраняются целиком: по ним и читают журнал.
  const plainKey = effectKey("run-4", "call-2", "record_work_block");
  await effects.begin({
    key: plainKey, runId: "run-4", userId: 42, toolName: "record_work_block", toolCallId: "call-2",
  });
  await effects.succeed(plainKey, 42, { minutes: 25, ok: true });
  assert.deepEqual(db.rows.get(plainKey)!.result, { minutes: 25, ok: true });
});

test("выключенный журнал не выполняет запросов и не мешает инструменту", async () => {
  const db = new FakeEffectDb();
  const effects = journal(db, false);
  const decision = await effects.begin({
    key: "k", runId: "r", userId: 1, toolName: "t", toolCallId: "c",
  });
  assert.equal(decision.action, "execute");
  assert.equal(db.rows.size, 0);
});

// ---------------------------------------------------------------------
// 4. Восстановление: таблица инъекции сбоев
// ---------------------------------------------------------------------

interface RecoveryProbe {
  runs: Map<string, Record<string, unknown>>;
  outbox: Map<string, string>;
  effects: Map<string, string[]>;
  attempts: Array<Record<string, unknown>>;
  /** Переходы, записанные жизненным циклом: они и есть доказательство. */
  transitions: Array<{ to: string; from: string | null }>;
  /** Отклонённые графом переходы. Их быть не должно. */
  rejected: string[];
  /** С каких ходов снята аренда: без этого ход не выйдет из выборки. */
  released?: Set<string>;
}

/** Настоящий жизненный цикл: переходы обязаны проходить через его граф. */
function lifecycleFor(db: unknown): TurnLifecycle {
  return new TurnLifecycle(db as never, logger as never, true);
}

function recoveryHarness(probe: RecoveryProbe) {
  const query = async (sql: string, values: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const text = sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
    if (text.includes("SELECT state, attempt FROM turn_runs")) {
      // Запрос жизненного цикла перед переходом.
      const row = probe.runs.get(String(values[0]));
      return { rows: row ? [{ state: row.state, attempt: row.attempt }] : [] };
    }
    if (text.includes("FROM turn_runs")) {
      // Настоящая выборка берёт ходы по истёкшей аренде
      // (`lease_expires_at IS NOT NULL`). Поддельная обязана вести себя
      // так же, иначе тест не заметит хода, который из выборки не вышел.
      return { rows: [...probe.runs.values()].filter((row) => row.lease_owner != null) };
    }
    if (text.includes("FROM turn_recovery_attempts")) {
      const count = probe.attempts.filter((item) => item.run_id === values[0]).length;
      return { rows: [{ count: String(count) }] };
    }
    if (text.startsWith("INSERT INTO turn_transitions")) {
      // Отклонённый переход тоже пишется в журнал, но переходом не
      // является: без этого различия тест принял бы отказ за успех.
      if (!text.includes("'invalid_transition'")) {
        probe.transitions.push({ to: String(values[2]), from: values[1] as string | null });
      } else {
        probe.rejected.push(String(values[2]));
      }
      return { rows: [] };
    }
    if (text.includes("FROM telegram_outbox")) {
      const status = probe.outbox.get(String(values[0]));
      return { rows: status ? [{ status }] : [] };
    }
    if (text.includes("FROM tool_effects")) {
      const statuses = probe.effects.get(String(values[0])) ?? [];
      const counts = new Map<string, number>();
      for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
      return { rows: [...counts].map(([status, count]) => ({ status, count: String(count) })) };
    }
    if (text.startsWith("UPDATE turn_runs")) {
      // Жизненный цикл адресует строку по run_id и владельцу.
      const row = probe.runs.get(String(values[0]));
      // Снятие аренды — тоже UPDATE, но состояния не меняет: без этого
      // различия поддельная база записала бы состоянием `undefined`.
      if (text.includes("lease_owner = NULL")) {
        if (row) row.lease_owner = null;
        probe.released?.add(String(values[0]));
        return { rows: [] };
      }
      if (row) row.state = values[2];
      return { rows: [] };
    }
    if (text.startsWith("INSERT INTO turn_recovery_attempts")) {
      probe.attempts.push({
        run_id: values[0],
        reason: values[2],
        found_state: values[3],
        decision: values[4],
        outcome: values[5],
        detail: JSON.parse(String(values[6])),
      });
      return { rows: [] };
    }
    throw new Error(`поддельная база не знает запроса: ${text.slice(0, 50)}`);
  };
  const db = withTenantScopes({
    query,
    transaction: async <T>(work: (client: { query: typeof query }) => Promise<T>) =>
      await work({ query }),
  }) as never;
  return new TurnRecoveryService(
    db,
    logger as never,
    new EffectJournal(db, logger as never, true),
    lifecycleFor(db),
    true,
  );
}

/**
 * Семь точек сбоя из задания шага. Для каждой — следы, которые ход
 * успел оставить, решение, которое обязано быть принято, и состояние,
 * в котором ход обязан оказаться.
 *
 * Проверять одно решение мало: решение, которое не удалось применить,
 * выглядит в отчёте так же, как применённое, а ход при этом остаётся
 * с истёкшей арендой и осматривается снова и снова.
 */
const INJECTION_POINTS: Array<{
  point: string;
  state: string;
  outbox: string | null;
  effects: string[];
  decision: string;
  /** Куда обязан прийти ход после применения решения. */
  ends: string;
}> = [
  {
    point: "до отправки в Letta",
    state: "context_built",
    outbox: null,
    effects: [],
    decision: "retry",
    ends: "queued",
  },
  {
    point: "после отправки",
    state: "sent_to_letta",
    outbox: null,
    effects: [],
    decision: "retry",
    ends: "queued",
  },
  {
    point: "во время стриминга",
    state: "letta_processing",
    outbox: null,
    effects: [],
    decision: "retry",
    ends: "queued",
  },
  {
    // Строки outbox у хода нет, а отправка предшествует записи ссылки:
    // доказать, что ответ не ушёл, нечем — значит повтор запрещён.
    point: "после получения результата",
    state: "result_received",
    outbox: null,
    effects: [],
    decision: "abandon",
    ends: "failed_terminal",
  },
  {
    point: "до фиксации outbox",
    state: "result_received",
    outbox: null,
    effects: ["succeeded"],
    decision: "abandon",
    ends: "failed_terminal",
  },
  {
    point: "после фиксации outbox",
    state: "outbox_committed",
    outbox: "pending",
    effects: [],
    decision: "deliver",
    ends: "delivering",
  },
  {
    point: "во время доставки",
    state: "delivering",
    outbox: "sent",
    effects: [],
    decision: "abandon",
    ends: "completed",
  },
];

test("инъекция сбоя в семи точках: ни одна не приводит ко второму ответу", async () => {
  const table: Array<{ point: string; decision: string; ends: string }> = [];
  for (const [index, injection] of INJECTION_POINTS.entries()) {
    const runId = `run-${index}`;
    const probe: RecoveryProbe = {
      runs: new Map([[runId, {
        run_id: runId,
        user_id: "42",
        state: injection.state,
        attempt: 1,
        outbox_id: injection.outbox ? `outbox-${index}` : null,
        conversation_id: "conv-1",
        lease_owner: "умерший",
        cancel_requested_at: null,
      }]]),
      outbox: new Map(injection.outbox ? [[`outbox-${index}`, injection.outbox]] : []),
      effects: new Map([[runId, injection.effects]]),
      attempts: [],
      transitions: [],
      rejected: [],
      released: new Set(),
    };

    const outcomes = await recoveryHarness(probe).sweep();
    assert.equal(outcomes.length, 1, `${injection.point}: разобрано не одно решение`);
    assert.equal(
      outcomes[0]!.decision,
      injection.decision,
      `${injection.point}: решение ${outcomes[0]!.decision} вместо ${injection.decision}`,
    );
    // Решение обязано быть применённым, а не только объявленным.
    assert.deepEqual(
      probe.rejected,
      [],
      `${injection.point}: граф отклонил переходы ${probe.rejected.join(", ")}`,
    );
    assert.equal(
      probe.runs.get(runId)!.state,
      injection.ends,
      `${injection.point}: ход остался в ${probe.runs.get(runId)!.state}, ожидалось ${injection.ends}`,
    );
    // Аренда снята — иначе тот же ход вернётся в выборку через
    // тридцать секунд и будет возвращаться в неё вечно.
    assert.ok(probe.released!.has(runId), `${injection.point}: аренда не снята`);
    // Каждая попытка оставила запись с причиной, найденным и решением.
    assert.equal(probe.attempts.length, 1);
    assert.equal(probe.attempts[0]!.reason, "lease_expired");
    assert.equal(probe.attempts[0]!.decision, injection.decision);
    assert.ok(String(probe.attempts[0]!.found_state).includes("state="));
    table.push({
      point: injection.point,
      decision: outcomes[0]!.decision,
      ends: String(probe.runs.get(runId)!.state),
    });
  }

  // Ни одна точка сбоя не даёт повтора после доставленного ответа.
  const afterDelivery = table.find((row) => row.point === "во время доставки");
  assert.equal(afterDelivery?.decision, "abandon");
  assert.equal(afterDelivery?.ends, "completed");
  // Повтор допустим только там, где ответа заведомо не было.
  for (const row of table.filter((item) => item.decision === "retry")) {
    assert.equal(row.ends, "queued", `${row.point}: повтор не довёл ход до очереди`);
  }
  console.log("таблица инъекции сбоев:", JSON.stringify(table));
});

test("повторный осмотр не гоняет ход по кругу и не копит отклонённые переходы", async () => {
  // Ход, по которому решение уже применено, обязан выйти из выборки.
  // Проверяется на всех семи точках сразу: заход второй раз видит
  // только те строки, у которых аренда осталась.
  for (const [index, injection] of INJECTION_POINTS.entries()) {
    const runId = `run-loop-${index}`;
    const probe: RecoveryProbe = {
      runs: new Map([[runId, {
        run_id: runId,
        user_id: "42",
        state: injection.state,
        attempt: 1,
        outbox_id: injection.outbox ? `outbox-${index}` : null,
        conversation_id: "conv-1",
        lease_owner: "умерший",
        cancel_requested_at: null,
      }]]),
      outbox: new Map(injection.outbox ? [[`outbox-${index}`, injection.outbox]] : []),
      effects: new Map([[runId, injection.effects]]),
      attempts: [],
      transitions: [],
      rejected: [],
      released: new Set(),
    };
    const service = recoveryHarness(probe);
    await service.sweep();
    assert.ok(probe.released!.has(runId), `${injection.point}: аренда не снята на первом заходе`);
    const stateAfterFirst = probe.runs.get(runId)!.state;

    for (let pass = 0; pass < 5; pass += 1) {
      const outcomes = await service.sweep();
      assert.deepEqual(
        outcomes,
        [],
        `${injection.point}: разобранный ход вернулся в выборку на заходе ${pass + 2}`,
      );
    }
    assert.deepEqual(
      probe.rejected,
      [],
      `${injection.point}: повторные заходы копят отклонённые переходы ${probe.rejected.join(", ")}`,
    );
    assert.equal(probe.attempts.length, 1, `${injection.point}: записей попыток больше одной`);
    assert.equal(
      probe.runs.get(runId)!.state,
      stateAfterFirst,
      `${injection.point}: повторный заход увёл ход из ${String(stateAfterFirst)}`,
    );
  }
});

test("ни одно состояние сбоя не даёт отклонённого графом перехода", async () => {
  // Семи точек задания мало: сбой застаёт ход в том состоянии, в каком
  // застаёт, а не в том, которое мы предусмотрели. Здесь перебираются
  // все незавершённые состояния во всех сочетаниях со следами outbox и
  // отмены. Требование одно и одинаковое для всех: путь, который
  // восстановление строит, обязан проходить по графу целиком.
  const cases: Array<{ state: string; outbox: string | null; cancelled: boolean }> = [];
  for (const state of TURN_STATES) {
    if (TERMINAL_STATES.has(state)) continue;  // такие ходы выборка не берёт
    for (const outbox of [null, "pending", "sent"]) {
      for (const cancelled of [false, true]) cases.push({ state, outbox, cancelled });
    }
  }
  assert.ok(cases.length >= 100, `перебор оказался мал: ${cases.length}`);

  const stuck: string[] = [];
  for (const [index, item] of cases.entries()) {
    const runId = `run-all-${index}`;
    const probe: RecoveryProbe = {
      runs: new Map([[runId, {
        run_id: runId,
        user_id: "42",
        state: item.state,
        attempt: 1,
        outbox_id: item.outbox ? `outbox-${index}` : null,
        conversation_id: "conv-1",
        lease_owner: "умерший",
        cancel_requested_at: item.cancelled ? new Date() : null,
      }]]),
      outbox: new Map(item.outbox ? [[`outbox-${index}`, item.outbox]] : []),
      effects: new Map(),
      attempts: [],
      transitions: [],
      rejected: [],
      released: new Set(),
    };
    const service = recoveryHarness(probe);
    const [outcome] = await service.sweep();
    const label = `${item.state}/outbox=${item.outbox ?? "нет"}/отмена=${item.cancelled}`;
    assert.deepEqual(probe.rejected, [], `${label}: граф отклонил ${probe.rejected.join(", ")}`);
    if (outcome!.decision === "wait") continue;
    assert.ok(probe.released!.has(runId), `${label}: аренда не снята`);
    // Второй заход этот ход уже не видит: аренды у него нет.
    const before = probe.runs.get(runId)!.state;
    assert.deepEqual(await service.sweep(), [], `${label}: ход вернулся в выборку`);
    if (probe.runs.get(runId)!.state !== before) stuck.push(label);
  }
  assert.deepEqual(stuck, [], `состояние изменилось после выхода из выборки: ${stuck.join(", ")}`);
});

test("ожидание ограничено пределом попыток и не держит ход вечно", async () => {
  // Единственное решение, которое аренду не снимает, — `wait`. Значит
  // именно оно обязано упираться в предел, иначе ход с незакрытым
  // эффектом осматривался бы бесконечно.
  const runId = "run-wait";
  const probe: RecoveryProbe = {
    runs: new Map([[runId, {
      run_id: runId,
      user_id: "42",
      state: "tools_pending",
      attempt: 1,
      outbox_id: null,
      conversation_id: "conv-1",
      lease_owner: "умерший",
      cancel_requested_at: null,
    }]]),
    outbox: new Map(),
    effects: new Map([[runId, ["running"]]]),
    attempts: [],
    transitions: [],
    rejected: [],
    released: new Set(),
  };
  const service = recoveryHarness(probe);
  const decisions: string[] = [];
  for (let pass = 0; pass < 6; pass += 1) {
    const [outcome] = await service.sweep();
    if (outcome) decisions.push(outcome.decision);
  }
  assert.deepEqual(
    decisions,
    ["wait", "wait", "wait", "abandon"],
    `ожидание не упёрлось в предел: ${decisions.join(", ")}`,
  );
  assert.equal(probe.runs.get(runId)!.state, "failed_terminal");
  assert.deepEqual(probe.rejected, []);
  assert.ok(probe.released!.has(runId), "аренда не снята после исчерпания попыток");
});

test("незакрытый побочный эффект запрещает повтор", async () => {
  const probe: RecoveryProbe = {
    runs: new Map([["run-x", {
      run_id: "run-x",
      user_id: "42",
      state: "tools_pending",
      attempt: 1,
      outbox_id: null,
      conversation_id: "conv-1",
      lease_owner: "умерший",
      cancel_requested_at: null,
    }]]),
    outbox: new Map(),
    effects: new Map([["run-x", ["running"]]]),
    attempts: [],
    transitions: [],
    rejected: [],
  };

  const [outcome] = await recoveryHarness(probe).sweep();
  assert.equal(outcome!.decision, "wait", "ход с незакрытым эффектом ушёл в повтор");
  assert.equal(probe.runs.get("run-x")!.state, "tools_pending", "состояние тронуто без нужды");
});

test("отменённый до сбоя ход не воскрешается", async () => {
  const probe: RecoveryProbe = {
    runs: new Map([["run-c", {
      run_id: "run-c",
      user_id: "42",
      state: "letta_processing",
      attempt: 1,
      outbox_id: null,
      conversation_id: "conv-1",
      lease_owner: "умерший",
      cancel_requested_at: new Date(),
    }]]),
    outbox: new Map(),
    effects: new Map(),
    attempts: [],
    transitions: [],
    rejected: [],
    released: new Set(),
  };

  const [outcome] = await recoveryHarness(probe).sweep();
  assert.equal(outcome!.decision, "abandon");
  assert.equal(probe.attempts[0]!.outcome, "ход отменён до сбоя");
  // Отменённый ход не отказал — его остановили, и в канонических
  // состояниях для этого есть своя пара. Пометить его отказом значило
  // бы считать отменённые ходы отказами во всех метриках.
  assert.deepEqual(
    probe.transitions.map((item) => item.to),
    ["cancelling", "cancelled"],
    "отменённый ход помечен не отменой",
  );
  assert.equal(probe.runs.get("run-c")!.state, "cancelled");
  assert.deepEqual(probe.rejected, []);
});

test("выключенное восстановление не трогает ничего", async () => {
  const probe: RecoveryProbe = {
    runs: new Map([["run-off", { run_id: "run-off", user_id: "42", state: "queued", attempt: 1 }]]),
    outbox: new Map(),
    effects: new Map(),
    attempts: [],
    transitions: [],
    rejected: [],
  };
  const query = async () => {
    throw new Error("выключенное восстановление обратилось к базе");
  };
  const service = new TurnRecoveryService(
    withTenantScopes({ query }) as never,
    logger as never,
    new EffectJournal(withTenantScopes({ query }) as never, logger as never, false),
    new TurnLifecycle(withTenantScopes({ query }) as never, logger as never, false),
    false,
  );
  assert.deepEqual(await service.sweep(), []);
  assert.equal(probe.attempts.length, 0);
});

test("защита от одновременного выполнения переживает повторяемый отказ", async () => {
  const db = new FakeEffectDb();
  const effects = journal(db);
  const key = effectKey("run-race", "call-1", "save_task");
  const input = {
    key, runId: "run-race", userId: 42, toolName: "save_task", toolCallId: "call-1",
  };

  await effects.begin(input);
  await effects.fail(key, 42, "Error", true);

  // Первый забирает право на повтор...
  const retry = await effects.begin(input);
  assert.equal(retry.action, "execute");
  assert.equal((retry as { attempt: number }).attempt, 2);

  // ...второй его уже не получает. Прежнее условие `attempt === 1`
  // отдавало бы ему `execute`, и действие выполнилось бы дважды.
  const concurrent = await effects.begin(input);
  assert.equal(concurrent.action, "skip");
  assert.equal((concurrent as { reason: string }).reason, "in_flight");
});

test("повтор идёт через recovery_required и recovering, а не прыжком в очередь", async () => {
  const probe: RecoveryProbe = {
    runs: new Map([["run-r", {
      run_id: "run-r",
      user_id: "42",
      state: "letta_processing",
      attempt: 1,
      outbox_id: null,
      conversation_id: "conv-1",
      lease_owner: "умерший",
      cancel_requested_at: null,
    }]]),
    outbox: new Map(),
    effects: new Map(),
    attempts: [],
    transitions: [],
    rejected: [],
  };

  const [outcome] = await recoveryHarness(probe).sweep();
  assert.equal(outcome!.decision, "retry");
  // Состояния заведены ровно под этот путь, и прыжок сразу в `queued`
  // оставил бы историю хода без объяснения, откуда он там взялся.
  assert.deepEqual(
    probe.transitions.map((item) => item.to),
    ["failed_retryable", "recovery_required", "recovering", "queued"],
  );
  assert.deepEqual(probe.rejected, [], "путь повтора содержит переход, отклонённый графом");
  assert.equal(probe.runs.get("run-r")!.state, "queued");
});

test("доставленный ход завершается, а не помечается отказом", async () => {
  const probe: RecoveryProbe = {
    runs: new Map([["run-d", {
      run_id: "run-d",
      user_id: "42",
      state: "delivering",
      attempt: 1,
      outbox_id: "outbox-d",
      conversation_id: "conv-1",
      lease_owner: "умерший",
      cancel_requested_at: null,
    }]]),
    outbox: new Map([["outbox-d", "sent"]]),
    effects: new Map(),
    attempts: [],
    transitions: [],
    rejected: [],
  };

  const [outcome] = await recoveryHarness(probe).sweep();
  assert.equal(outcome!.decision, "abandon");
  // Ответ дошёл — ход честно завершён. Помечать его `failed_terminal`
  // значило бы записать успешную доставку отказом.
  assert.deepEqual(probe.transitions.map((item) => item.to), ["delivered", "completed"]);
  assert.deepEqual(probe.rejected, [], "решение шло через переход, отклонённый графом");
  assert.equal(probe.runs.get("run-d")!.state, "completed");
});

test("ход не осматривается бесконечно: предел считается по попыткам восстановления", async () => {
  const probe: RecoveryProbe = {
    runs: new Map([["run-w", {
      run_id: "run-w",
      user_id: "42",
      state: "tools_pending",
      attempt: 1,
      outbox_id: null,
      conversation_id: "conv-1",
      lease_owner: "умерший",
      cancel_requested_at: null,
    }]]),
    outbox: new Map(),
    effects: new Map([["run-w", ["running"]]]),
    attempts: [],
    transitions: [],
    rejected: [],
  };
  const service = recoveryHarness(probe);

  // Первые три захода ждут — эффект так и не закрылся.
  for (let round = 0; round < 3; round += 1) {
    const [outcome] = await service.sweep();
    assert.equal(outcome!.decision, "wait", `заход ${round + 1}`);
  }
  // Четвёртый прекращает: иначе ход и таблица попыток росли бы вечно.
  const [last] = await service.sweep();
  assert.equal(last!.decision, "abandon");
  assert.equal(probe.runs.get("run-w")!.state, "failed_terminal");
});

// ---------------------------------------------------------------------
// 5. Отмена во время выполнения инструмента
// ---------------------------------------------------------------------

test("отменённый ход не выполняет побочный эффект инструмента", async () => {
  const db = new FakeEffectDb();
  let executed = 0;
  const runtime = {
    userId: 42,
    telegramId: 4242,
    conversationId: "conv-1",
    agentId: "agent-1",
    purpose: "chat",
  };
  const factory = new AgentToolFactory(
    { vectorGoalsEnabled: false, todoistApiToken: "" } as never,
    withTenantScopes({
      query: db.query,
      getAgentRuntimeContext: async () => runtime,
    }) as never,
    {} as never,
    logger as never,
    undefined,
    undefined,
    undefined,
    journal(db),
  );
  const builder = (factory as unknown as {
    builder: (id: string) => (
      name: string,
      label: string,
      description: string,
      parameters: unknown,
      execute: () => Promise<unknown>,
    ) => { execute: (id: string, args: unknown) => Promise<unknown> };
  }).builder("conv-1");
  const tool = builder("save_task", "Задача", "", {}, async () => {
    executed += 1;
    return { task_id: 1 };
  });

  // Ход отменён — инструмент не должен ничего сделать.
  const cancelled = await runInTurn(
    { runId: "run-cancel", recorded: true, isCancelled: async () => true },
    async () => await tool.execute("call-1", {}),
  );
  assert.equal(executed, 0, "отменённый ход выполнил побочный эффект");
  assert.match(JSON.stringify(cancelled), /отмен/);
  assert.equal(db.rows.size, 0, "отменённый вызов оставил запись эффекта");

  // Живой ход выполняет как обычно.
  await runInTurn(
    { runId: "run-live", recorded: true, isCancelled: async () => false },
    async () => await tool.execute("call-2", {}),
  );
  assert.equal(executed, 1);
});

// ---------------------------------------------------------------------
// 6. Потеря блокировки и перезапуск при активных ходах
// ---------------------------------------------------------------------

test("потеря блокировки посреди хода не закрывает его сессию", async () => {
  // Блокировка живёт в Valkey и может истечь; сессия к этому отношения
  // не имеет. Проверяем, что потеря лока не превращается в закрытие
  // сессии посреди генерации — иначе один сбой Valkey рвал бы ходы.
  const { service, sessions } = harness();
  const internal = service as unknown as {
    acquirePooled: (id: string) => Promise<{ activeTurns: number; closing: boolean }>;
  };
  const pooled = await internal.acquirePooled("conv-1");
  pooled.activeTurns = 1;

  // Внешний владелец лока пропал — сервис об этом узнаёт только по
  // очередному продлению. Сессия при этом не трогается ничем.
  assert.equal(service.closeSession("conv-1"), false);
  assert.ok(sessions.has("conv-1"), "потеря блокировки закрыла активную сессию");
  assert.equal(pooled.activeTurns, 1);
});

test("перезапуск при активных ходах: ход дописывается, а не обрывается", async () => {
  const { service, sessions, made } = harness();
  const internal = service as unknown as {
    acquirePooled: (id: string) => Promise<{ activeTurns: number }>;
  };
  const busy = await internal.acquirePooled("conv-busy");
  busy.activeTurns = 1;
  const idle = await internal.acquirePooled("conv-idle");
  idle.activeTurns = 0;

  const stopping = service.drainSessions(400);
  await new Promise((resolve) => setTimeout(resolve, 80));

  // Простаивающая уже ушла, занятая — нет.
  assert.ok(!sessions.has("conv-idle"), "простаивающая сессия не закрыта при остановке");
  assert.ok(sessions.has("conv-busy"), "занятая сессия закрыта посреди хода");

  busy.activeTurns = 0;
  const outcome = await stopping;
  assert.equal(outcome.forced, 0, "ход не успел дописать");
  assert.ok(made.every((item) => item.state.closed), "не все сессии закрыты после остановки");
});

test("ход, начатый во время остановки, не обрывается на дедлайне", async () => {
  const { service } = harness();
  const internal = service as unknown as {
    acquirePooled: (id: string) => Promise<{ activeTurns: number }>;
  };
  const old = await internal.acquirePooled("conv-old");
  old.activeTurns = 1;

  const stopping = service.drainSessions(150);
  // Новый ход приходит уже во время окна и получает свою сессию.
  const fresh = await internal.acquirePooled("conv-new");
  fresh.activeTurns = 1;

  const outcome = await stopping;
  // Силой закрыта только та сессия, что была в пуле на входе: окно
  // ничего не обещало ходу, начавшемуся посреди него, но и убивать его
  // раньше срока незачем.
  assert.equal(outcome.forced, 1, "силой закрыто не то количество сессий");
  assert.equal(fresh.activeTurns, 1, "ход, начатый во время остановки, оборван");
});
