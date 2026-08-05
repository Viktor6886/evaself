/**
 * Жизненный цикл хода в shadow-режиме.
 *
 * Поддельная база здесь не «заглушка вместо проверки»: она разбирает
 * ровно те запросы, которые модуль и умеет отправлять, хранит строки и
 * журнал переходов и прогоняет каждый запрос через настоящую границу
 * арендатора (`withTenantScopes`). Поэтому тесты ниже проверяют
 * поведение — идемпотентность, отклонённый переход, восстановление, — а
 * не совпадение текста SQL с ожидаемым.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { EvaWorkflow } from "../dist/eva-workflow.js";
import { canTransition, TURN_STATES } from "../dist/turns/states.js";
import {
  TurnLifecycle,
  turnIdempotencyKey,
  type TurnHandle,
} from "../dist/turns/turn-lifecycle.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

interface TurnRow {
  run_id: string;
  idempotency_key: string;
  channel: string;
  user_id: number | null;
  telegram_user_id: number | null;
  update_id: number | null;
  agent_id: string | null;
  conversation_id: string | null;
  purpose: string | null;
  state: string;
  attempt: number;
  lease_owner: string | null;
  cancel_requested_at: string | null;
  cancel_reason: string | null;
  quota_metric: string | null;
  quota_charged: boolean;
  outbox_id: string | null;
  llm_request_id: string | null;
  letta_session_id: string | null;
  trace_id: string | null;
  prompt_version: string | null;
  flow_version: string | null;
  error_code: string | null;
  finished_at: string | null;
  wait_ms: number | null;
  duration_ms: number | null;
}

interface TransitionRow {
  run_id: string;
  from_state: string | null;
  to_state: string;
  attempt: number;
  error_code: string | null;
  detail: Record<string, unknown>;
}

/** Разбор `col = COALESCE($n, col)` из UPDATE, который строит link(). */
const ASSIGNMENT = /([a-z_]+)\s*=\s*COALESCE\(\$(\d+),\s*\1\)/gi;

class TurnStore {
  readonly rows = new Map<string, TurnRow>();
  readonly byKey = new Map<string, string>();
  readonly transitions: TransitionRow[] = [];
  readonly statements: Array<{ sql: string; values: unknown[] }> = [];
  /** Искусственный сбой записи: наблюдение не должно ронять ход. */
  failing = false;
  delayMs = 0;

  query = async (sql: string, values: unknown[] = []): Promise<{ rows: unknown[] }> => {
    this.statements.push({ sql, values });
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failing) throw new Error("shadow write failed");
    const text = sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();

    if (text.startsWith("INSERT INTO turn_runs")) return { rows: this.insertRun(values) };
    if (text.startsWith("INSERT INTO turn_transitions")) {
      return { rows: this.insertTransition(text, values) };
    }
    if (text.startsWith("SELECT state, attempt FROM turn_runs")) {
      const row = this.owned(values);
      return { rows: row ? [{ state: row.state, attempt: row.attempt }] : [] };
    }
    if (text.startsWith("SELECT cancel_requested_at")) {
      const row = this.owned(values);
      return { rows: row ? [{ cancelled: row.cancel_requested_at !== null }] : [] };
    }
    if (text.startsWith("UPDATE turn_runs")) return { rows: this.updateRun(text, values) };
    throw new Error(`поддельная база не знает запроса: ${text.slice(0, 60)}`);
  };

  transaction = async <T>(work: (client: { query: typeof this.query }) => Promise<T>) =>
    await work({ query: this.query });

  private owned(values: unknown[]): TurnRow | undefined {
    const row = this.rows.get(String(values[0]));
    if (!row) return undefined;
    // Владелец в запросе обязателен: без совпадения строка «не видна»,
    // ровно как её не видел бы PostgreSQL с этим WHERE.
    const owner = Number(values[1]);
    if (row.user_id !== owner && row.telegram_user_id !== owner) return undefined;
    return row;
  }

  private insertRun(values: unknown[]): unknown[] {
    const key = String(values[1]);
    const existing = this.byKey.get(key);
    if (existing) {
      const row = this.rows.get(existing)!;
      row.attempt += 1;
      return [{ run_id: row.run_id, state: row.state, inserted: false }];
    }
    const row: TurnRow = {
      run_id: String(values[0]),
      idempotency_key: key,
      channel: String(values[2]),
      user_id: values[3] === null ? null : Number(values[3]),
      telegram_user_id: values[4] === null ? null : Number(values[4]),
      update_id: values[5] === null ? null : Number(values[5]),
      agent_id: (values[6] as string | null) ?? null,
      conversation_id: (values[7] as string | null) ?? null,
      purpose: (values[8] as string | null) ?? null,
      state: "accepted",
      attempt: 1,
      lease_owner: null,
      cancel_requested_at: null,
      cancel_reason: null,
      quota_metric: null,
      quota_charged: false,
      outbox_id: null,
      llm_request_id: null,
      letta_session_id: null,
      trace_id: (values[9] as string | null) ?? null,
      prompt_version: null,
      flow_version: null,
      error_code: null,
      finished_at: null,
      wait_ms: null,
      duration_ms: null,
    };
    this.rows.set(row.run_id, row);
    this.byKey.set(key, row.run_id);
    return [{ run_id: row.run_id, state: row.state, inserted: true }];
  }

  private insertTransition(text: string, values: unknown[]): unknown[] {
    if (text.includes("VALUES ($1, NULL, 'accepted'")) {
      this.transitions.push({
        run_id: String(values[0]),
        from_state: null,
        to_state: "accepted",
        attempt: 1,
        error_code: null,
        detail: {},
      });
      return [];
    }
    const invalid = text.includes("'invalid_transition'");
    this.transitions.push({
      run_id: String(values[0]),
      from_state: (values[1] as string | null) ?? null,
      to_state: String(values[2]),
      attempt: Number(values[3]),
      error_code: invalid ? "invalid_transition" : (values[4] as string | null) ?? null,
      detail: invalid
        ? { rejected: true }
        : JSON.parse(String(values[5] ?? "{}")) as Record<string, unknown>,
    });
    return [];
  }

  private updateRun(text: string, values: unknown[]): unknown[] {
    const row = this.owned(values);
    if (!row) return [];
    if (text.includes("SET state = $3")) {
      row.state = String(values[2]);
      row.error_code = (values[3] as string | null) ?? row.error_code;
      if (values[4] === true) {
        row.finished_at = new Date().toISOString();
        row.duration_ms = 1;
      }
      return [];
    }
    if (text.includes("SET lease_owner = $3")) {
      row.lease_owner = String(values[2]);
      return [];
    }
    if (text.includes("SET cancel_requested_at")) {
      row.cancel_requested_at ??= new Date().toISOString();
      row.cancel_reason ??= String(values[2]);
      return [];
    }
    if (text.includes("SET wait_ms = $3")) {
      row.wait_ms = Number(values[2]);
      return [];
    }
    for (const match of text.matchAll(ASSIGNMENT)) {
      const column = match[1]! as keyof TurnRow;
      const value = values[Number(match[2]) - 1];
      if (value === null || value === undefined) continue;
      (row as unknown as Record<string, unknown>)[column] = value;
    }
    return [];
  }
}

function lifecycle(store: TurnStore, enabled = true): TurnLifecycle {
  return new TurnLifecycle(
    withTenantScopes({ query: store.query, transaction: store.transaction }) as never,
    logger,
    enabled,
  );
}

const TELEGRAM_ID = 4210;

function startInput(updateId: number) {
  return {
    channel: "telegram" as const,
    eventId: updateId,
    updateId,
    telegramUserId: TELEGRAM_ID,
    traceId: `telegram-update:${updateId}`,
  };
}

/** Полный прямой путь хода — тот же порядок, что и в eva-workflow. */
const HAPPY_PATH = [
  "queued",
  "claimed",
  "context_building",
  "context_built",
  "sent_to_letta",
  "letta_processing",
  "result_received",
  "outbox_committed",
  "delivering",
  "delivered",
  "completed",
] as const;

// ---------------------------------------------------------------------
// 1. Граф состояний
// ---------------------------------------------------------------------

test("канонический список состояний совпадает с CLAUDE.md и синонимов не имеет", () => {
  assert.deepEqual([...TURN_STATES], [
    "accepted", "aggregating", "queued", "claimed",
    "context_building", "context_built", "sent_to_letta",
    "letta_processing", "tools_pending", "approval_pending",
    "result_received", "outbox_committed", "delivering",
    "delivered", "completed", "cancelling", "cancelled",
    "failed_retryable", "recovery_required", "recovering",
    "failed_terminal",
  ]);
  assert.equal(new Set(TURN_STATES).size, TURN_STATES.length);
});

test("прямой путь хода допустим целиком, а прыжок через этап — нет", () => {
  let from: string = "accepted";
  for (const to of HAPPY_PATH) {
    assert.ok(canTransition(from as never, to as never), `${from} → ${to}`);
    from = to;
  }
  assert.equal(canTransition("accepted" as never, "delivered" as never), false);
  assert.equal(canTransition("completed" as never, "queued" as never), false);
  assert.equal(canTransition(null, "claimed" as never), false);
});

// ---------------------------------------------------------------------
// 2. Один ход на одно событие
// ---------------------------------------------------------------------

test("один update создаёт один логический ход с полной последовательностью состояний", async () => {
  const store = new TurnStore();
  const turns = lifecycle(store);

  const handle = await turns.start(startInput(901));
  assert.equal(handle.duplicate, false);
  assert.equal(handle.recorded, true);
  assert.equal(handle.idempotencyKey, "telegram:901:-");

  await turns.recordWait(handle, 42);
  await turns.lease(handle, "eva-agent-service:test", 180);
  for (const state of HAPPY_PATH) {
    assert.equal(await turns.transition(handle, state as never), true, state);
  }

  assert.equal(store.rows.size, 1);
  const row = [...store.rows.values()][0]!;
  assert.equal(row.state, "completed");
  assert.equal(row.wait_ms, 42);
  assert.equal(row.lease_owner, "eva-agent-service:test");
  assert.ok(row.finished_at);
  assert.deepEqual(
    store.transitions.map((item) => item.to_state),
    ["accepted", ...HAPPY_PATH],
  );
});

test("повторная доставка того же события не создаёт второй записи и второго списания", async () => {
  const store = new TurnStore();
  const turns = lifecycle(store);

  const first = await turns.start(startInput(902));
  for (const state of HAPPY_PATH) await turns.transition(first, state as never);
  await turns.link(first, { quotaMetric: "messages", quotaCharged: true });

  const second = await turns.start(startInput(902));
  assert.equal(second.duplicate, true);
  assert.equal(second.runId, first.runId);
  await turns.link(second, { quotaMetric: "messages", quotaCharged: true });

  assert.equal(store.rows.size, 1);
  const row = store.rows.get(first.runId)!;
  // Списание помечено ровно один раз: строка та же, значение то же.
  assert.equal(row.quota_charged, true);
  assert.equal(row.quota_metric, "messages");
  assert.equal(row.attempt, 2);
  assert.equal(
    store.transitions.filter((item) => item.to_state === "completed").length,
    1,
  );
});

test("ключ идемпотентности не меняется при повторе и различает назначения", () => {
  const identity = { channel: "telegram" as const, eventId: 17 };
  assert.equal(turnIdempotencyKey(identity), turnIdempotencyKey({ ...identity }));
  assert.notEqual(
    turnIdempotencyKey({ channel: "scheduler", eventId: 17, conversationId: "conv-a" }),
    turnIdempotencyKey({ channel: "scheduler", eventId: 17, conversationId: "conv-b" }),
  );
});

// ---------------------------------------------------------------------
// 3. Недопустимый переход
// ---------------------------------------------------------------------

test("недопустимый переход отклоняется, но остаётся в журнале как диагностика", async () => {
  const store = new TurnStore();
  const turns = lifecycle(store);
  const handle = await turns.start(startInput(903));

  assert.equal(await turns.transition(handle, "delivered" as never), false);

  const row = store.rows.get(handle.runId)!;
  assert.equal(row.state, "accepted", "состояние изменилось при отклонённом переходе");
  const rejected = store.transitions.at(-1)!;
  assert.equal(rejected.to_state, "delivered");
  assert.equal(rejected.error_code, "invalid_transition");
  assert.deepEqual(rejected.detail, { rejected: true });
});

// ---------------------------------------------------------------------
// 4. Восстановление после перезапуска и барьер отмены
// ---------------------------------------------------------------------

test("ход продолжается после перезапуска процесса, а не начинается заново", async () => {
  const store = new TurnStore();
  const before = lifecycle(store);
  const handle = await before.start(startInput(904));
  for (const state of ["queued", "claimed", "context_building"] as const) {
    await before.transition(handle, state as never);
  }
  await before.transition(handle, "failed_retryable" as never, { errorCode: "Error" });

  // Новый процесс: своя TurnLifecycle, тот же durable-журнал.
  const after = lifecycle(store);
  const resumed = await after.start(startInput(904));
  assert.equal(resumed.duplicate, true);
  assert.equal(resumed.runId, handle.runId);
  assert.equal(resumed.state, "failed_retryable");
  assert.equal(store.rows.get(resumed.runId)!.error_code, "Error");

  assert.equal(await after.transition(resumed, "queued" as never), true);
  assert.equal(await after.transition(resumed, "claimed" as never), true);
  assert.equal(store.rows.size, 1);
});

test("барьер отмены виден исполнителю и переводит ход в отменённый", async () => {
  const store = new TurnStore();
  const turns = lifecycle(store);
  const handle = await turns.start(startInput(905));
  await turns.transition(handle, "queued" as never);

  assert.equal(await turns.isCancelled(handle), false);
  await turns.requestCancel(handle, "user_blocked");
  assert.equal(await turns.isCancelled(handle), true);

  await turns.transition(handle, "cancelling" as never, { detail: { reason: "user_blocked" } });
  await turns.transition(handle, "cancelled" as never);
  const row = store.rows.get(handle.runId)!;
  assert.equal(row.state, "cancelled");
  assert.equal(row.cancel_reason, "user_blocked");
  assert.ok(row.finished_at);
});

test("чужой ход не правится: запрос без совпадения владельца ничего не меняет", async () => {
  const store = new TurnStore();
  const turns = lifecycle(store);
  const handle = await turns.start(startInput(906));
  await turns.transition(handle, "queued" as never);

  const stranger: TurnHandle = {
    ...handle,
    owner: { column: "telegram_user_id", value: TELEGRAM_ID + 1 },
  };
  assert.equal(await turns.transition(stranger, "claimed" as never), false);
  assert.equal(store.rows.get(handle.runId)!.state, "queued");
});

// ---------------------------------------------------------------------
// 5. Выключенный флаг и сбой записи
// ---------------------------------------------------------------------

test("при выключенном флаге не выполняется ни одного запроса", async () => {
  const store = new TurnStore();
  const turns = lifecycle(store, false);
  const handle = await turns.start(startInput(907));
  await turns.transition(handle, "queued" as never);
  await turns.link(handle, { quotaCharged: true });
  await turns.lease(handle, "test", 10);
  await turns.recordWait(handle, 5);
  await turns.requestCancel(handle, "test");

  assert.equal(store.statements.length, 0);
  assert.equal(handle.recorded, false);
  assert.ok(handle.runId, "run_id выдаётся и без записи");
});

test("сбой теневой записи не превращается в ошибку хода", async () => {
  const store = new TurnStore();
  store.failing = true;
  const turns = lifecycle(store);
  const handle = await turns.start(startInput(908));
  assert.equal(handle.recorded, false);
  assert.equal(await turns.transition(handle, "queued" as never), false);
  assert.equal(await turns.isCancelled(handle), false);
});

test("ход без известного владельца не записывается", async () => {
  const store = new TurnStore();
  const turns = lifecycle(store);
  const handle = await turns.start({ channel: "internal", eventId: "no-owner" });
  assert.equal(handle.recorded, false);
  assert.equal(store.statements.length, 0);
});

// ---------------------------------------------------------------------
// 6. Shadow-режим внутри хода: ответ и бюджет задержки
// ---------------------------------------------------------------------

/**
 * Согласованный бюджет теневой записи на один ход. Число намеренно
 * грубое: смысл проверки не в микросекундах, а в том, что запись хода не
 * добавляет к ответу порядок величины.
 */
const SHADOW_BUDGET_MS = 250;

interface WorkflowProbe {
  sent: string[];
  result: unknown;
  elapsedMs: number;
  /** Чем ход представился блокировке пользователя. */
  lockClaims: Array<Record<string, unknown>>;
  /** Каким записям проставили владельца. */
  attached: number[];
  /** Что ушло в модель. */
  prompts: string[];
}

async function runTelegramTurn(
  turns: TurnLifecycle | undefined,
  options: {
    quota?: Array<Record<string, unknown>>;
    extraUpdates?: unknown[];
    onlyVoice?: boolean;
  } = {},
): Promise<WorkflowProbe> {
  const sent: string[] = [];
  const attached: number[] = [];
  const prompts: string[] = [];
  const user = { id: 77, telegram_id: TELEGRAM_ID, state: "active", is_blocked: false };
  const link = { agent_id: "agent-1", conversation_id: "conv-1", user_id: user.id };
  const db = {
    withQueryMetrics: async <T>(work: () => Promise<T>) => ({
      result: await work(),
      queryCount: 0,
    }),
    withUserScope: async <T>(_input: unknown, work: () => Promise<T>) => await work(),
    bindScopeUserId() {},
    upsertUser: async () => user,
    getAgentLink: async () => link,
    attachTelegramUpdateToUser: async (updateId: number) => {
      attached.push(Number(updateId));
    },
    getQuotaStatus: async () =>
      options.quota ?? [{ metric: "messages", remaining: 10 }],
    recordUserMessage: async () => {},
    markAgentUsed: async () => {},
    incrementUsage: async () => {},
    query: async () => ({ rows: [] }),
  };
  const telegram = {
    withDeliveryContext: async <T>(_prefix: string, work: () => Promise<T>) => await work(),
    startTyping: () => () => {},
    startMessageDraft: async () => null,
    sendProgressiveMessage: async (_chatId: number, text: string) => {
      sent.push(text);
    },
    sendMessage: async (_chatId: number, text: string) => {
      sent.push(text);
    },
    getDeliveryMetrics: () => ({ outboxInsertMs: 0, telegramSendMs: 0 }),
    getDeliveryOutboxId: () => "555",
  };
  const letta = {
    promptVersion: "abcdef123456",
    runTurn: async (_conversationId: string, message: string) => {
      prompts.push(String(message));
      return {
      reply: "Понимаю. Расскажи, что было дальше.",
      reasoning: [],
      assistantGroups: 1,
      assistantHadIds: true,
      toolCalls: [],
      trace: [],
      stopReason: null,
      usage: null,
      messageCount: 1,
      agentId: "agent-1",
      conversationId: "conv-1",
      durationMs: 1,
      };
    },
  };
  const runtimeContext = {
    build: async () => ({
      userId: user.id,
      conversationId: "conv-1",
      responseMode: "text",
      metrics: { runtimeContextMs: 0, profileCheckMs: 0, cacheHit: false },
    }),
    wrapUserMessage: (_context: unknown, prompt: string) => prompt,
  };
  const lockClaims: Array<Record<string, unknown>> = [];
  const queue = {
    run: async <T>(
      _telegramId: number,
      work: () => Promise<T>,
      claim: Record<string, unknown> = {},
    ) => {
      lockClaims.push(claim);
      return await work();
    },
  };
  const workflow = new EvaWorkflow(
    { typingIntervalMs: 4000, lockTtlSeconds: 180 } as never,
    db as never,
    letta as never,
    {} as never,
    queue as never,
    telegram as never,
    runtimeContext as never,
    {} as never,
    logger as never,
    undefined,
    undefined,
    undefined,
    turns as never,
  );

  const started = performance.now();
  const updates = [
    ...(options.extraUpdates ?? []),
    {
      update_id: 3001,
      message: {
        message_id: 5,
        chat: { id: TELEGRAM_ID },
        from: { id: TELEGRAM_ID, first_name: "Анна" },
        ...(options.onlyVoice
          ? { voice: { file_id: "voice-only", file_unique_id: "voice-only" } }
          : { text: "мне снова тяжело собраться" }),
      },
    },
  ];
  const result = await workflow.processAggregated(updates as never);
  return {
    sent,
    result,
    elapsedMs: performance.now() - started,
    lockClaims,
    attached,
    prompts,
  };
}

test("теневая запись не меняет ответ пользователя и укладывается в бюджет", async () => {
  const without = await runTelegramTurn(undefined);
  const store = new TurnStore();
  const withShadow = await runTelegramTurn(lifecycle(store));

  assert.deepEqual(withShadow.sent, without.sent);
  assert.deepEqual(withShadow.result, without.result);
  assert.deepEqual(withShadow.result, { status: "completed", usageCharged: true });
  assert.ok(
    withShadow.elapsedMs - without.elapsedMs < SHADOW_BUDGET_MS,
    `теневая запись добавила ${Math.round(withShadow.elapsedMs - without.elapsedMs)} мс`,
  );
});

test("ход в Telegram записан полностью: состояния, связи и владелец", async () => {
  const store = new TurnStore();
  await runTelegramTurn(lifecycle(store));

  assert.equal(store.rows.size, 1);
  const row = [...store.rows.values()][0]!;
  assert.equal(row.state, "completed");
  assert.equal(row.channel, "telegram");
  assert.equal(row.telegram_user_id, TELEGRAM_ID);
  assert.equal(row.user_id, 77);
  assert.equal(row.update_id, 3001);
  assert.equal(row.agent_id, "agent-1");
  assert.equal(row.conversation_id, "conv-1");
  assert.equal(row.purpose, "chat");
  assert.equal(row.outbox_id, "555");
  assert.equal(row.letta_session_id, "conv-1");
  assert.equal(row.quota_metric, "messages");
  assert.equal(row.quota_charged, true);
  assert.equal(row.prompt_version, "abcdef123456");
  assert.equal(row.flow_version, "telegram-shadow-1");
  assert.equal(row.trace_id, "telegram-update:3001");
  assert.ok(row.lease_owner?.startsWith("eva-agent-service:"));
  assert.equal(typeof row.wait_ms, "number");

  assert.deepEqual(
    store.transitions.map((item) => item.to_state),
    ["accepted", ...HAPPY_PATH],
  );
  assert.equal(
    store.transitions.filter((item) => item.error_code === "invalid_transition").length,
    0,
    "в записи есть отклонённые переходы",
  );
});

test("в записи хода нет ни одного фрагмента пользовательского текста", async () => {
  const store = new TurnStore();
  await runTelegramTurn(lifecycle(store));

  const written = JSON.stringify([
    [...store.rows.values()],
    store.transitions,
    store.statements.map((item) => item.values),
  ]);
  for (const fragment of ["тяжело", "собраться", "Понимаю", "Расскажи", "Анна"]) {
    assert.ok(!written.includes(fragment), `в записи хода оказался текст: ${fragment}`);
  }
});

test("сбой теневой записи не мешает пользователю получить ответ", async () => {
  const store = new TurnStore();
  store.failing = true;
  const probe = await runTelegramTurn(lifecycle(store));
  assert.deepEqual(probe.result, { status: "completed", usageCharged: true });
  assert.equal(probe.sent.length, 1);
});

test("ход представляется блокировке своим run_id, а не безымянной строкой", async () => {
  const store = new TurnStore();
  const probe = await runTelegramTurn(lifecycle(store));

  assert.equal(probe.lockClaims.length, 1, "блокировка бралась не один раз");
  const runId = [...store.rows.values()][0]!.run_id;
  assert.equal(
    probe.lockClaims[0]!.runId,
    runId,
    "владение блокировкой не связано с ходом: в Valkey ушёл null",
  );

  // Без наблюдателя ход всё равно берёт блокировку — просто без run_id.
  const without = await runTelegramTurn(undefined);
  assert.equal(without.lockClaims.length, 1);
  assert.equal(without.lockClaims[0]!.runId, null);
});

test("при выключенной записи хода в блокировку не уходит идентификатор-призрак", async () => {
  // Наблюдатель есть, флаг выключен — это конфигурация по умолчанию.
  // `run_id` при этом существует в памяти, но не резолвится ни во что:
  // оператор искал бы строку, которой нет.
  const store = new TurnStore();
  const probe = await runTelegramTurn(lifecycle(store, false));

  assert.equal(store.rows.size, 0, "выключенный флаг всё же что-то записал");
  assert.equal(probe.lockClaims.length, 1);
  assert.equal(
    probe.lockClaims[0]!.runId,
    null,
    "в блокировку ушёл run_id, которому не соответствует ни одна строка",
  );
});

test("объединённый ход не проносит голос мимо исчерпанной квоты минут", async () => {
  // Голосовое плюс быстрый текст: отвечаем на текст, но расшифровать
  // придётся и голос. Гейт, смотрящий только на последнее сообщение,
  // пропустил бы списание минут сверх нуля.
  const store = new TurnStore();
  const probe = await runTelegramTurn(lifecycle(store), {
    quota: [
      { metric: "messages", remaining: 10 },
      { metric: "voice_minutes", remaining: 0 },
    ],
    extraUpdates: [
      {
        update_id: 3000,
        message: {
          message_id: 4,
          chat: { id: TELEGRAM_ID },
          from: { id: TELEGRAM_ID, first_name: "Анна" },
          voice: { file_id: "voice-1", file_unique_id: "voice-1" },
        },
      },
    ],
  });

  // Про исчерпанную квоту человеку сказали...
  assert.ok(probe.sent.length >= 1, "человеку не сказали про исчерпанную квоту");
  // ...но текст, написанный в том же окне, ответа заслуживает: молчать
  // про него значит потерять сообщение.
  assert.deepEqual(probe.result, { status: "completed", usageCharged: true });
  assert.equal(probe.prompts.length, 1, "ход к модели не пошёл");
  assert.ok(
    probe.prompts[0]!.includes("мне снова тяжело собраться"),
    "текст окна не дошёл до модели",
  );
  const row = [...store.rows.values()][0]!;
  assert.equal(row.state, "completed");
});

test("окно из одного голосового при исчерпанной квоте прекращается целиком", async () => {
  const store = new TurnStore();
  const probe = await runTelegramTurn(lifecycle(store), {
    quota: [
      { metric: "messages", remaining: 10 },
      { metric: "voice_minutes", remaining: 0 },
    ],
    onlyVoice: true,
  });

  assert.deepEqual(probe.result, { status: "ignored" });
  assert.equal(probe.prompts.length, 0, "ход пошёл к модели без квоты на голос");
  const row = [...store.rows.values()][0]!;
  assert.equal(row.state, "cancelled");
  assert.equal(row.cancel_reason, "quota_voice");
});

test("владельца получает каждая запись объединённого окна", async () => {
  const store = new TurnStore();
  const probe = await runTelegramTurn(lifecycle(store), {
    extraUpdates: [
      {
        update_id: 2999,
        message: {
          message_id: 3,
          chat: { id: TELEGRAM_ID },
          from: { id: TELEGRAM_ID, first_name: "Анна" },
          text: "я хотел сказать",
        },
      },
    ],
  });

  assert.deepEqual(probe.result, { status: "completed", usageCharged: true });
  assert.deepEqual(
    [...probe.attached].sort((left, right) => left - right),
    [2999, 3001],
    "присоединённая запись осталась без владельца",
  );
});
