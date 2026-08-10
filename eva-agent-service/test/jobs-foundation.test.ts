/**
 * Слой фоновых заданий: реестр очередей, конверт, транзакционный job
 * outbox, расписания и остановка.
 *
 * Ни Valkey, ни BullMQ здесь не нужны: очередь подменена драйвером,
 * который считает вызовы, база — таблицей в памяти. Проверяются правила
 * слоя, а не библиотека: что реестр не заводит запрещённую очередь, что
 * payload с пользовательским текстом не уезжает в брокер, что задание,
 * зафиксированное в PostgreSQL, будет опубликовано, и что повтор
 * публикации не создаёт второго задания.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JOB_QUEUES,
  QueueRegistry,
} from "../dist/jobs/queue-registry.js";
import {
  JOB_SCHEMA_VERSION,
  assertSafePayload,
  buildJobEnvelope,
  parseJobEnvelope,
} from "../dist/jobs/envelope.js";
import { JobOutbox, jobIdempotencyKey } from "../dist/jobs/job-outbox.js";
import { JobRunJournal } from "../dist/jobs/job-runs.js";
import { JobScheduleRegistry } from "../dist/jobs/schedules.js";
import { JobRuntime } from "../dist/jobs/runtime.js";
import { classifyJobError, dedupKey, timingFor } from "../dist/jobs/policy.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------
// Поддельные очередь и база
// ---------------------------------------------------------------------

interface FakeJob {
  jobId: string;
  jobType: string;
  data: unknown;
}

/** Очередь в памяти: помнит задания и расписания, считает попытки постановки. */
class FakeQueue {
  jobs = new Map<string, FakeJob>();
  schedulers = new Map<string, { key: string; cron: string | null; timezone: string | null }>();
  /** Сколько раз задание действительно создавалось: это и есть «бизнес-эффект». */
  stored = 0;
  failNextAdds = 0;

  name: string;

  constructor(name: string) {
    this.name = name;
  }

  async add(jobType: string, data: unknown, options: { jobId: string; replacePending?: boolean }) {
    if (this.failNextAdds > 0) {
      this.failNextAdds -= 1;
      const error = new Error("Valkey недоступен") as Error & { code: string };
      error.code = "ECONNREFUSED";
      throw error;
    }
    if (this.jobs.has(options.jobId) && !options.replacePending) {
      return { jobId: options.jobId, duplicate: true };
    }
    this.jobs.set(options.jobId, { jobId: options.jobId, jobType, data });
    this.stored += 1;
    return { jobId: options.jobId, duplicate: false };
  }

  async upsertScheduler(key: string, spec: { cron: string; timezone: string }) {
    this.schedulers.set(key, { key, cron: spec.cron, timezone: spec.timezone });
  }

  async listSchedulers() {
    return [...this.schedulers.values()];
  }

  async removeScheduler(key: string) {
    return this.schedulers.delete(key);
  }

  async close() {}
}

class FakeDriver {
  queues = new Map<string, FakeQueue>();
  prefixes: string[] = [];

  open(name: string, prefix: string) {
    this.prefixes.push(prefix);
    const queue = new FakeQueue(name);
    this.queues.set(name, queue);
    return queue as never;
  }
}

interface OutboxRow {
  id: string;
  idempotency_key: string;
  queue: string;
  job_type: string;
  schema_version: number;
  user_id: number | null;
  envelope: unknown;
  dedup_key: string | null;
  attempts: number;
  status: string;
  available_at: number;
  lease_until: number | null;
  error_code: string | null;
}

/**
 * База в памяти. Понимает ровно те запросы, которые шлёт слой; всё
 * остальное — ошибка теста, а не пустой ответ, иначе забытый запрос
 * молча «проходил» бы.
 */
class FakeJobsDatabase {
  outbox: OutboxRow[] = [];
  runs: Record<string, unknown>[] = [];
  deadLetters: Record<string, unknown>[] = [];
  schedules: Record<string, unknown>[] = [];
  private nextId = 1;

  query = async (sql: string, values: unknown[] = []): Promise<{ rows: never[] }> => {
    const text = sql.replace(/--[^\n]*\n/g, " ").replace(/\s+/g, " ").trim();

    if (text.startsWith("INSERT INTO job_outbox")) {
      const key = String(values[0]);
      if (this.outbox.some((row) => row.idempotency_key === key)) return { rows: [] as never };
      this.outbox.push({
        id: `row-${this.nextId++}`,
        idempotency_key: key,
        queue: String(values[1]),
        job_type: String(values[2]),
        schema_version: Number(values[3]),
        user_id: values[4] === null ? null : Number(values[4]),
        envelope: JSON.parse(String(values[5])),
        dedup_key: values[6] === null ? null : String(values[6]),
        attempts: 0,
        status: "pending",
        available_at: values[8] ? Date.parse(String(values[8])) : Date.now(),
        lease_until: null,
        error_code: null,
      });
      return { rows: [{ idempotency_key: key, inserted: true }] as never };
    }

    if (text.startsWith("UPDATE job_outbox SET status = 'publishing'")) {
      const limit = Number(values[0]);
      const leaseSeconds = Number(values[1]);
      const now = Date.now();
      const claimed = this.outbox
        .filter((row) =>
          ["pending", "publishing"].includes(row.status)
          && row.available_at <= now
          && (row.lease_until === null || row.lease_until < now))
        .sort((left, right) => left.available_at - right.available_at)
        .slice(0, limit);
      for (const row of claimed) {
        row.status = "publishing";
        row.attempts += 1;
        row.lease_until = now + leaseSeconds * 1000;
      }
      return { rows: claimed.map((row) => ({ ...row })) as never };
    }

    if (text.startsWith("UPDATE job_outbox SET status = 'published'")) {
      const row = this.outbox.find((item) => item.id === values[0]);
      if (row) {
        row.status = "published";
        row.lease_until = null;
      }
      return { rows: [] as never };
    }

    if (text.startsWith("UPDATE job_outbox SET status = 'pending'")) {
      const row = this.outbox.find((item) => item.id === values[0]);
      if (row) {
        row.status = "pending";
        row.available_at = Date.now() + Number(values[1]) * 1000;
        row.lease_until = null;
        row.error_code = String(values[2]);
      }
      return { rows: [] as never };
    }

    if (text.startsWith("UPDATE job_outbox SET status = 'dead'")) {
      const row = this.outbox.find((item) => item.id === values[0]);
      if (row) {
        row.status = "dead";
        row.lease_until = null;
        row.error_code = String(values[1]);
      }
      return { rows: [] as never };
    }

    if (text.startsWith("INSERT INTO job_dead_letters")) {
      this.deadLetters.push({
        job_id: values[0],
        queue: values[1],
        job_type: values[2],
        error_code: values[5] ?? values[6],
        raw: values,
      });
      return { rows: [] as never };
    }

    if (text.startsWith("INSERT INTO job_runs")) {
      this.runs.push({
        run_id: values[0],
        job_id: values[1],
        queue: values[2],
        job_type: values[3],
        user_id: values[5],
        payload_checksum: values[6],
        status: "running",
        lease_owner: values[9],
        cancel_requested: false,
      });
      return { rows: [] as never };
    }

    if (text.startsWith("UPDATE job_runs SET lease_until")) {
      const run = this.runs.find((item) => item.run_id === values[0]);
      if (!run || run.status !== "running" || run.lease_owner !== values[1]) return { rows: [] as never };
      if (run.cancel_requested === true) return { rows: [] as never };
      return { rows: [{ cancel_requested: false }] as never };
    }

    if (text.startsWith("SELECT status, cancel_requested FROM job_runs")) {
      const run = this.runs.find((item) => item.run_id === values[0]);
      return { rows: (run ? [{ status: run.status, cancel_requested: run.cancel_requested }] : []) as never };
    }

    if (text.startsWith("UPDATE job_runs SET status")) {
      const run = this.runs.find((item) => item.run_id === values[0]);
      if (run) {
        run.status = String(values[1]);
        run.error_code = values[2];
      }
      return { rows: [] as never };
    }

    if (text.startsWith("UPDATE job_runs SET cancel_requested")) {
      const run = this.runs.find((item) => item.run_id === values[0]);
      if (!run || run.status !== "running") return { rows: [] as never };
      run.cancel_requested = true;
      return { rows: [{ run_id: run.run_id }] as never };
    }

    if (text.includes("FROM job_schedules")) {
      return { rows: this.schedules.filter((row) => row.enabled !== false) as never };
    }

    if (text.startsWith("UPDATE job_schedules SET last_synced_at")) {
      return { rows: [] as never };
    }

    throw new Error(`Неожиданный запрос: ${text.slice(0, 80)}`);
  };

  transaction = async <T>(work: (client: { query: typeof this.query }) => Promise<T>): Promise<T> =>
    await work({ query: this.query });
}

function buildLayer(options: { outbox?: ConstructorParameters<typeof JobOutbox>[3] } = {}) {
  const fake = new FakeJobsDatabase();
  const db = withTenantScopes(fake as never) as never;
  const driver = new FakeDriver();
  const registry = new QueueRegistry(driver as never, logger as never);
  const outbox = new JobOutbox(db, registry, logger as never, options.outbox ?? {});
  return { fake, db, driver, registry, outbox };
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    type: "memory_compaction",
    queue: "memory" as const,
    idempotencyKey: jobIdempotencyKey({
      type: "memory_compaction",
      userId: 42,
      discriminator: "2026-08-10",
    }),
    traceId: "trace-1",
    userId: 42,
    payload: { conversation_id: "c-1", window: 20 },
    deadlineMs: 60_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// Реестр очередей
// ---------------------------------------------------------------------

test("реестр открывает только шесть разрешённых очередей", () => {
  const driver = new FakeDriver();
  const registry = new QueueRegistry(driver as never, logger as never);

  for (const name of JOB_QUEUES) {
    assert.equal(registry.queue(name).name, name);
  }
  assert.deepEqual(registry.openQueues.sort(), [...JOB_QUEUES].sort());
  // Физическая очередь на класс одна, сколько бы её ни просили.
  assert.equal(registry.queue("memory"), registry.queue("memory"));
  assert.equal(driver.queues.size, JOB_QUEUES.length);
  assert.ok(driver.prefixes.every((prefix) => prefix === "evaself:bullmq"));
});

test("реестр отказывает запрещённым и незнакомым очередям", () => {
  const registry = new QueueRegistry(new FakeDriver() as never, logger as never);

  for (const forbidden of ["telegram-ingress", "agent-runs", "turns"]) {
    assert.throws(
      () => registry.queue(forbidden),
      (error: Error & { code?: string }) => error.code === "job_queue_forbidden",
      `${forbidden} обязана быть запрещена явно`,
    );
  }
  assert.throws(
    () => registry.queue("memory-v2"),
    (error: Error & { code?: string }) => error.code === "job_queue_unknown",
  );
});

// ---------------------------------------------------------------------
// Конверт и приватность payload
// ---------------------------------------------------------------------

test("payload с пользовательскими данными в очередь не попадает", () => {
  const forbidden: Record<string, unknown>[] = [
    { message_text: "мне снова тяжело" },
    { transcript: "abc" },
    { diary_entry: "x" },
    { api_key: "sk-1" },
    { card_number: "4111111111111111" },
    { media_url: "https://example.invalid/a.ogg" },
    { note: "заметка" },
    { summary: "итог разговора" },
  ];
  for (const payload of forbidden) {
    assert.throws(
      () => assertSafePayload(payload),
      (error: Error & { code?: string }) => error.code === "job_payload_forbidden_field",
      `${Object.keys(payload)[0]} обязано быть отклонено`,
    );
  }

  // Строка допускается только в форме идентификатора.
  assert.throws(
    () => assertSafePayload({ label: "две строки\nвторая" }),
    (error: Error & { code?: string }) => error.code === "job_payload_value_not_identifier",
  );
  assert.throws(
    () => assertSafePayload({ items: [1, 2, 3] }),
    (error: Error & { code?: string }) => error.code === "job_payload_value_not_scalar",
  );

  // Идентификаторы, счётчики и флаги проходят.
  assertSafePayload({ conversation_id: "c-1", window: 20, force: false, parent: null });
});

test("неизвестная версия схемы даёт неповторяемый отказ", () => {
  const envelope = buildJobEnvelope(intent() as never);
  assert.equal(envelope.schemaVersion, JOB_SCHEMA_VERSION);
  assert.ok(parseJobEnvelope(envelope).ok);

  const future = parseJobEnvelope({ ...envelope, schemaVersion: 99 });
  assert.equal(future.ok, false);
  assert.equal(future.ok === false && future.code, "job_schema_unsupported");
  assert.equal(future.ok === false && future.retryable, false);

  const broken = parseJobEnvelope({ ...envelope, traceId: "" });
  assert.equal(broken.ok, false);
  assert.equal(broken.ok === false && broken.retryable, false);
});

// ---------------------------------------------------------------------
// Транзакционный outbox
// ---------------------------------------------------------------------

test("зафиксированное намерение публикуется после падения до публикации", async () => {
  const layer = buildLayer();

  // Транзакция бизнес-намерения: запись есть, публикации ещё нет —
  // именно так выглядит падение процесса сразу после COMMIT.
  await layer.db.withUserScope({ userId: 42, label: "test.intent" }, async () =>
    await layer.db.transaction(async (client: never) =>
      await layer.outbox.record(client, intent() as never)));

  assert.equal(layer.fake.outbox.length, 1);
  assert.equal(layer.fake.outbox[0]?.status, "pending");
  assert.equal(layer.driver.queues.size, 0);

  const summary = await layer.outbox.publishPending();
  assert.deepEqual(
    { claimed: summary.claimed, published: summary.published, dead: summary.dead },
    { claimed: 1, published: 1, dead: 0 },
  );
  assert.equal(layer.fake.outbox[0]?.status, "published");
  assert.equal(layer.driver.queues.get("memory")?.jobs.size, 1);
});

test("повторная публикация не создаёт второго задания", async () => {
  const layer = buildLayer();
  await layer.db.withUserScope({ userId: 42, label: "test.intent" }, async () =>
    await layer.db.transaction(async (client: never) =>
      await layer.outbox.record(client, intent() as never)));

  // Второе намерение с тем же ключом идемпотентности второй строки не создаёт.
  const second = await layer.db.withUserScope({ userId: 42, label: "test.intent" }, async () =>
    await layer.db.transaction(async (client: never) =>
      await layer.outbox.record(client, intent() as never)));
  assert.equal(second.duplicate, true);
  assert.equal(layer.fake.outbox.length, 1);

  await layer.outbox.publishPending();
  // Строка снова доступна публикатору — так выглядит истёкшая аренда
  // после падения первого публикатора уже ПОСЛЕ постановки в очередь.
  layer.fake.outbox[0]!.status = "pending";
  layer.fake.outbox[0]!.lease_until = null;
  const repeat = await layer.outbox.publishPending();

  assert.equal(repeat.duplicates, 1);
  const queue = layer.driver.queues.get("memory")!;
  assert.equal(queue.jobs.size, 1, "второго задания появиться не должно");
  assert.equal(queue.stored, 1, "повтор не создаёт второй бизнес-эффект");
});

test("недоступный брокер откладывает публикацию, а не теряет намерение", async () => {
  const layer = buildLayer();
  await layer.db.withUserScope({ userId: 42, label: "test.intent" }, async () =>
    await layer.db.transaction(async (client: never) =>
      await layer.outbox.record(client, intent() as never)));

  layer.registry.queue("memory");
  layer.driver.queues.get("memory")!.failNextAdds = 1;

  const summary = await layer.outbox.publishPending();
  assert.equal(summary.retried, 1);
  assert.equal(summary.published, 0);
  assert.equal(layer.fake.outbox[0]?.status, "pending");
  assert.equal(layer.fake.outbox[0]?.error_code, "ECONNREFUSED");

  // Отказ брокера не выполнил работу синхронно и намерение не потерял:
  // после восстановления оно публикуется обычным заходом.
  layer.fake.outbox[0]!.available_at = Date.now() - 1;
  const recovered = await layer.outbox.publishPending();
  assert.equal(recovered.published, 1);
});

test("испорченный конверт уходит в DLQ без повторов", async () => {
  const layer = buildLayer();
  await layer.db.withUserScope({ userId: 42, label: "test.intent" }, async () =>
    await layer.db.transaction(async (client: never) =>
      await layer.outbox.record(client, intent() as never)));
  // Строка старой версии: конверт записан кодом, которого уже нет.
  layer.fake.outbox[0]!.envelope = {
    ...(layer.fake.outbox[0]!.envelope as Record<string, unknown>),
    schemaVersion: 99,
  };

  const summary = await layer.outbox.publishPending();
  assert.equal(summary.dead, 1);
  assert.equal(summary.published, 0);
  assert.equal(layer.fake.outbox[0]?.status, "dead");
  assert.equal(layer.fake.deadLetters.length, 1);

  // Второй заход её уже не видит: бесконечного повтора нет.
  const again = await layer.outbox.publishPending();
  assert.equal(again.claimed, 0);
  assert.equal(layer.fake.deadLetters.length, 1);
});

// ---------------------------------------------------------------------
// Расписания
// ---------------------------------------------------------------------

test("сверка при старте восстанавливает пропущенное расписание и убирает лишнее", async () => {
  const layer = buildLayer();
  const schedules = new JobScheduleRegistry(layer.db, layer.registry, logger as never);
  layer.fake.schedules = [
    {
      code: "memory_nightly",
      queue: "memory",
      job_type: "memory_compaction",
      schema_version: 1,
      cron: "0 3 * * *",
      timezone: "Europe/Moscow",
      dedup_mode: "simple",
      payload: { window: 20 },
      payload_ref: null,
    },
    {
      code: "broken_queue",
      queue: "telegram-ingress",
      job_type: "x",
      schema_version: 1,
      cron: "* * * * *",
      timezone: "Europe/Moscow",
      dedup_mode: "simple",
      payload: {},
      payload_ref: null,
    },
  ];

  // Том Valkey потерян: в очереди расписаний нет вовсе.
  const first = await schedules.reconcile();
  assert.equal(first.expected, 1);
  assert.equal(first.restored, 1);
  assert.equal(first.rejected, 1, "расписание запрещённой очереди в очередь не попадает");
  assert.deepEqual(
    [...layer.driver.queues.get("memory")!.schedulers.keys()],
    ["memory_nightly"],
  );

  // Повторная сверка ничего не меняет.
  const second = await schedules.reconcile();
  assert.deepEqual(
    { restored: second.restored, updated: second.updated, removed: second.removed },
    { restored: 0, updated: 0, removed: 0 },
  );

  // Правка cron в PostgreSQL доходит до очереди, а лишний планировщик снимается.
  layer.fake.schedules[0]!.cron = "0 4 * * *";
  layer.driver.queues.get("memory")!.schedulers.set("orphan", {
    key: "orphan",
    cron: "* * * * *",
    timezone: "UTC",
  });
  const third = await schedules.reconcile();
  assert.equal(third.updated, 1);
  assert.equal(third.removed, 1);
  assert.equal(
    layer.driver.queues.get("memory")!.schedulers.get("memory_nightly")?.cron,
    "0 4 * * *",
  );
});

// ---------------------------------------------------------------------
// Исполнение и остановка
// ---------------------------------------------------------------------

function buildRuntime() {
  const layer = buildLayer();
  const runs = new JobRunJournal(layer.db, logger as never);
  const runtime = new JobRuntime(layer.db, layer.registry, runs, logger as never);
  return { ...layer, runs, runtime };
}

test("graceful shutdown дожидается активного задания и не рвёт его", async () => {
  const { runtime, fake, driver, registry } = buildRuntime();
  registry.queue("memory");
  let released: (() => void) | null = null;
  let aborted = false;
  runtime.register("memory_compaction", async (context: { signal: AbortSignal }) => {
    context.signal.addEventListener("abort", () => {
      aborted = true;
    });
    await new Promise<void>((resolve) => {
      released = resolve;
    });
  });

  const envelope = buildJobEnvelope(intent() as never);
  const execution = runtime.execute(envelope);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runtime.activeJobs, 1);

  const stopping = runtime.stop(2_000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(aborted, false, "остановка не прерывает начатое задание");
  released!();

  const outcome = await execution;
  const stopped = await stopping;
  assert.equal(outcome.status, "succeeded");
  assert.deepEqual({ drained: stopped.drained, active: stopped.active }, { drained: true, active: 0 });
  assert.equal(fake.runs[0]?.status, "succeeded");
  assert.equal(driver.queues.get("memory")?.jobs.size, 0);

  // Новое задание во время остановки не начинается и не хоронится.
  const refused = await runtime.execute(envelope);
  assert.equal(refused.status, "failed");
  assert.equal(refused.status === "failed" && refused.retry, true);
});

test("задание после жёсткого дедлайна не выполняется", async () => {
  const { runtime, fake } = buildRuntime();
  let ran = false;
  runtime.register("memory_compaction", async () => {
    ran = true;
  });

  const envelope = buildJobEnvelope({ ...intent(), deadlineMs: 1 } as never);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const outcome = await runtime.execute(envelope);

  assert.equal(ran, false);
  assert.equal(outcome.status === "failed" && outcome.code, "job_deadline_exceeded");
  assert.equal(outcome.status === "failed" && outcome.retry, false);
  assert.equal(fake.deadLetters.length, 1);
});

test("потеря аренды прекращает локальную работу", async () => {
  const { runtime, runs, fake } = buildRuntime();
  let aborted = false;
  runtime.register(
    "memory_compaction",
    async (context: { signal: AbortSignal; runId: string }) => {
      // Отмена приходит извне, как это делает оператор или восстановление.
      await runs.requestCancel(context.runId, 42, "token-1");
      await new Promise<void>((resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted by lease"));
        });
        setTimeout(resolve, 2_000);
      });
    },
    // Сроки этого типа сжаты, чтобы проверить продление аренды, а не
    // ждать его штатных пятнадцати секунд.
    {
      leaseDurationMs: 200,
      leaseRenewIntervalMs: 50,
      softTimeoutMs: 1_500,
      externalRequestTimeoutMs: 500,
    },
  );

  const envelope = buildJobEnvelope(intent() as never);
  const outcome = await runtime.execute(envelope);

  assert.equal(aborted, true);
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.status === "cancelled" && outcome.reason, "cancelled");
  assert.equal(fake.runs[0]?.status, "cancelled");
});

test("неизвестный тип задания не повторяется", async () => {
  const { runtime, fake } = buildRuntime();
  const outcome = await runtime.execute(buildJobEnvelope(intent() as never));
  assert.equal(outcome.status === "failed" && outcome.code, "job_handler_missing");
  assert.equal(outcome.status === "failed" && outcome.retry, false);
  assert.equal(fake.deadLetters.length, 1);
});

// ---------------------------------------------------------------------
// Общие правила
// ---------------------------------------------------------------------

test("отказы делятся на временные, постоянные и неопределённые", () => {
  const abort = new Error("stopped");
  abort.name = "AbortError";
  assert.equal(classifyJobError(abort).failureClass, "transient");

  const network = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  assert.equal(classifyJobError(network).failureClass, "transient");

  const permanent = Object.assign(new Error("bad"), { code: "job_schema_unsupported", retryable: false });
  assert.equal(classifyJobError(permanent).failureClass, "permanent");

  const indeterminate = Object.assign(new Error("payment"), { code: "payment_unknown" });
  indeterminate.name = "IndeterminateExternalWrite";
  // Класс объявляется типом ошибки, а не именем: чужой объект с тем же
  // именем остаётся временным отказом.
  assert.equal(classifyJobError(indeterminate).failureClass, "transient");

  // Текст ошибки в код не попадает — только безопасный идентификатор.
  assert.equal(classifyJobError(new Error("токен sk-123 отклонён")).code, "Error");
});

test("сроки согласованы, а ключ дедупликации всегда называет арендатора", () => {
  for (const queue of JOB_QUEUES) {
    const timing = timingFor(queue);
    assert.ok(timing.softTimeoutMs < timing.hardDeadlineMs);
    assert.ok(timing.externalRequestTimeoutMs <= timing.softTimeoutMs);
    assert.ok(timing.leaseRenewIntervalMs * 2 <= timing.leaseDurationMs);
  }
  assert.throws(
    () => timingFor("memory", { leaseRenewIntervalMs: 59_000 }),
    (error: Error & { code?: string }) => error.code === "job_timing_invalid",
  );

  const first = dedupKey({ mode: "simple", queue: "memory", type: "compaction", userId: 1 });
  const second = dedupKey({ mode: "simple", queue: "memory", type: "compaction", userId: 2 });
  assert.notEqual(first, second, "задания разных людей не склеиваются");
  assert.match(
    dedupKey({ mode: "simple", queue: "memory", type: "compaction", userId: null }),
    /:system:/,
  );

  const window = 60_000;
  const early = dedupKey({
    mode: "throttle", queue: "memory", type: "c", userId: 1, windowMs: window, now: 0,
  });
  const same = dedupKey({
    mode: "throttle", queue: "memory", type: "c", userId: 1, windowMs: window, now: window - 1,
  });
  const next = dedupKey({
    mode: "throttle", queue: "memory", type: "c", userId: 1, windowMs: window, now: window,
  });
  assert.equal(early, same);
  assert.notEqual(early, next);
  assert.throws(
    () => dedupKey({ mode: "throttle", queue: "memory", type: "c", userId: 1 }),
    (error: Error & { code?: string }) => error.code === "job_dedup_window_required",
  );
});
