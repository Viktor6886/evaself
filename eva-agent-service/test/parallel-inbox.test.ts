/**
 * Параллельный диспетчер durable inbox и объединение быстрых сообщений.
 *
 * Поддельный inbox здесь повторяет правила настоящего claim, а не
 * подменяет их удобным поведением: одна запись на человека, строгий
 * порядок внутри человека, аренда с истечением, возврат записи без
 * траты попытки. Сам SQL проверяется отдельно, на настоящем PostgreSQL,
 * шагом «Claim параллельного диспетчера» в CI.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ParallelInboxDispatcher } from "../dist/delivery/dispatcher.js";
import { TelegramInboxWorker, type InboxRecord, type InboxResult } from "../dist/delivery/inbox.js";
import { userBusy } from "../dist/errors.js";
import { TurnAggregator, aggregatable, mediaReady } from "../dist/turns/aggregator.js";
import type { TelegramUpdate } from "../dist/telegram.js";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

interface Row {
  updateId: number;
  telegramUserId: number;
  chatId: number;
  payload: TelegramUpdate;
  receivedAt: number;
  status: "queued" | "processing" | "retry" | "completed" | "ignored" | "dead";
  attempts: number;
  availableAt: number;
  lockedAt: number | null;
  lockedBy: string | null;
  usageCharged: boolean;
}

const ACTIVE = new Set(["queued", "processing", "retry"]);

/** Поддельный durable inbox с теми же правилами выборки, что и SQL. */
class FakeInbox {
  readonly rows = new Map<number, Row>();
  /** Сколько раз запись отдавалась воркеру. Дубль хода виден отсюда. */
  readonly handedOut = new Map<number, number>();
  now = () => Date.now();

  enqueueUpdate(update: TelegramUpdate, receivedAt = this.rows.size): void {
    const message = update.message!;
    this.rows.set(update.update_id, {
      updateId: update.update_id,
      telegramUserId: message.from!.id,
      chatId: message.chat.id,
      payload: update,
      receivedAt,
      status: "queued",
      attempts: 0,
      availableAt: 0,
      lockedAt: null,
      lockedBy: null,
      usageCharged: false,
    });
  }

  async enqueue() {
    return { accepted: true, duplicate: false };
  }

  private ready(row: Row, leaseSeconds: number, maxAttempts: number): boolean {
    if (row.attempts >= maxAttempts) return false;
    if (row.status === "queued" || row.status === "retry") return row.availableAt <= this.now();
    if (row.status === "processing") {
      return row.lockedAt !== null && row.lockedAt < this.now() - leaseSeconds * 1_000;
    }
    return false;
  }

  private order(row: Row): [number, number] {
    return [row.receivedAt, row.updateId];
  }

  private before(left: Row, right: Row): boolean {
    const [la, lb] = this.order(left);
    const [ra, rb] = this.order(right);
    return la < ra || (la === ra && lb < rb);
  }

  async claimBatch(input: {
    workerId: string;
    leaseSeconds: number;
    maxAttempts: number;
    limit: number;
    excludeTelegramUsers?: number[];
  }): Promise<InboxRecord[]> {
    // Тот же sweeper, что и в SQL: запись с исчерпанными попытками и
    // истёкшей арендой уходит в dead, иначе она навсегда закрывает
    // очередь своего человека.
    for (const row of this.rows.values()) {
      if (
        row.status === "processing"
        && row.attempts >= input.maxAttempts
        && row.lockedAt !== null
        && row.lockedAt < this.now() - input.leaseSeconds * 1_000
      ) {
        row.status = "dead";
        row.lockedAt = null;
        row.lockedBy = null;
      }
    }
    const excluded = new Set(input.excludeTelegramUsers ?? []);
    const candidates = [...this.rows.values()]
      .filter((row) => this.ready(row, input.leaseSeconds, input.maxAttempts))
      .filter((row) => !excluded.has(row.telegramUserId))
      // Более раннее незавершённое сообщение того же человека блокирует.
      .filter((row) => ![...this.rows.values()].some(
        (other) => ACTIVE.has(other.status)
          && other.telegramUserId === row.telegramUserId
          && this.before(other, row),
      ))
      .sort((left, right) => (this.before(left, right) ? -1 : 1))
      .slice(0, input.limit);
    return candidates.map((row) => this.lock(row, input.workerId));
  }

  async claimFollowUps(input: {
    workerId: string;
    telegramUserId: number;
    afterUpdateId: number;
    maxAttempts: number;
    limit: number;
  }): Promise<InboxRecord[]> {
    const candidates = [...this.rows.values()]
      .filter((row) => row.telegramUserId === input.telegramUserId)
      .filter((row) => row.updateId > input.afterUpdateId)
      .filter((row) => (row.status === "queued" || row.status === "retry")
        && row.availableAt <= this.now()
        && row.attempts < input.maxAttempts)
      .sort((left, right) => (this.before(left, right) ? -1 : 1))
      .slice(0, input.limit);
    return candidates.map((row) => this.lock(row, input.workerId));
  }

  private lock(row: Row, workerId: string): InboxRecord {
    row.status = "processing";
    row.attempts += 1;
    row.lockedAt = this.now();
    row.lockedBy = workerId;
    this.handedOut.set(row.updateId, (this.handedOut.get(row.updateId) ?? 0) + 1);
    return {
      updateId: row.updateId,
      payload: row.payload,
      attempts: row.attempts,
      chatId: row.chatId,
      telegramUserId: row.telegramUserId,
    };
  }

  async claim(workerId: string, leaseSeconds: number, maxAttempts: number) {
    const [record] = await this.claimBatch({ workerId, leaseSeconds, maxAttempts, limit: 1 });
    return record ?? null;
  }

  async release(updateId: number, delaySeconds: number, workerId?: string): Promise<void> {
    const row = this.rows.get(updateId);
    if (!row || row.status !== "processing") return;
    // Возвращаем только свою аренду: чужую запись трогать нельзя.
    if (workerId !== undefined && row.lockedBy !== workerId) return;
    row.status = "queued";
    row.attempts = Math.max(0, row.attempts - 1);
    row.availableAt = this.now() + delaySeconds * 1_000;
    row.lockedAt = null;
    row.lockedBy = null;
  }

  async complete(updateId: number, result: InboxResult): Promise<void> {
    const row = this.rows.get(updateId);
    if (!row) return;
    row.status = result.status;
    row.usageCharged = row.usageCharged || Boolean(result.usageCharged);
    row.lockedAt = null;
    row.lockedBy = null;
  }

  async fail(updateId: number, _error: unknown, attempts: number, maxAttempts: number) {
    const row = this.rows.get(updateId);
    const dead = attempts >= maxAttempts;
    if (row) {
      row.status = dead ? "dead" : "retry";
      row.availableAt = this.now();
      row.lockedAt = null;
      row.lockedBy = null;
    }
    return { dead };
  }

  statuses(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of this.rows.values()) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }
}

function textUpdate(updateId: number, telegramId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: telegramId },
      from: { id: telegramId, first_name: "Тест" },
      text,
    },
  } as TelegramUpdate;
}

function voiceUpdate(updateId: number, telegramId: number, fileId: string | null): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: telegramId },
      from: { id: telegramId, first_name: "Тест" },
      voice: fileId ? { file_id: fileId, file_unique_id: fileId } : {},
    },
  } as TelegramUpdate;
}

const OPTIONS = {
  pollMs: 10_000,
  leaseSeconds: 30,
  maxAttempts: 3,
  concurrency: 8,
  batchSize: 16,
};

/** Прогнать диспетчер до опустошения очереди. */
async function drain(dispatcher: ParallelInboxDispatcher, inbox: FakeInbox): Promise<void> {
  for (let round = 0; round < 400; round += 1) {
    await dispatcher.tick();
    await dispatcher.drain();
    const pending = [...inbox.rows.values()].some((row) => ACTIVE.has(row.status));
    if (!pending) return;
  }
  throw new Error("очередь не опустела за отведённое число проходов");
}

// ---------------------------------------------------------------------
// 1. Приём и отсутствие потерь
// ---------------------------------------------------------------------

test("500 сообщений принимаются и обрабатываются без потерь", async () => {
  const inbox = new FakeInbox();
  for (let index = 0; index < 500; index += 1) {
    inbox.enqueueUpdate(textUpdate(1_000 + index, 100 + (index % 50), `сообщение ${index}`), index);
  }
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async () => ({ status: "completed", usageCharged: true }),
    logger,
    { ...OPTIONS, concurrency: 16 },
  );

  const started = Date.now();
  await drain(dispatcher, inbox);
  const elapsed = Date.now() - started;

  assert.deepEqual(inbox.statuses(), { completed: 500 });
  assert.ok(elapsed < 10_000, `обработка заняла ${elapsed} мс`);
  // Ни одна запись не выдавалась дважды: дубль хода — это дубль ответа.
  for (const [updateId, times] of inbox.handedOut) {
    assert.equal(times, 1, `запись ${updateId} выдана ${times} раза`);
  }
});

// ---------------------------------------------------------------------
// 2. Параллельность и порядок
// ---------------------------------------------------------------------

test("разные пользователи выполняются одновременно, а не по очереди", async () => {
  const inbox = new FakeInbox();
  for (let index = 0; index < 8; index += 1) {
    inbox.enqueueUpdate(textUpdate(200 + index, 300 + index, "привет"), index);
  }
  let peak = 0;
  let active = 0;
  let release: (() => void) | null = null;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 8) release!();
      await barrier;
      active -= 1;
      return { status: "completed" };
    },
    logger,
    OPTIONS,
  );

  await dispatcher.tick();
  await dispatcher.drain();
  assert.equal(peak, 8, `одновременно выполнялось ${peak} ходов вместо восьми`);
});

test("у одного человека нет двух ходов одновременно, и порядок сообщений строгий", async () => {
  const inbox = new FakeInbox();
  // Три сообщения одного человека и одно чужое.
  inbox.enqueueUpdate(textUpdate(11, 500, "первое"), 0);
  inbox.enqueueUpdate(textUpdate(12, 500, "второе"), 1);
  inbox.enqueueUpdate(textUpdate(13, 500, "третье"), 2);
  inbox.enqueueUpdate(textUpdate(14, 501, "чужое"), 3);

  const order: number[] = [];
  let concurrentForUser = 0;
  let peakForUser = 0;

  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async (records) => {
      const record = records[0]!;
      if (record.telegramUserId === 500) {
        concurrentForUser += 1;
        peakForUser = Math.max(peakForUser, concurrentForUser);
        order.push(record.updateId);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (record.telegramUserId === 500) concurrentForUser -= 1;
      return { status: "completed" };
    },
    logger,
    OPTIONS,
  );

  await drain(dispatcher, inbox);

  assert.equal(peakForUser, 1, "у одного человека выполнялось два хода сразу");
  assert.deepEqual(order, [11, 12, 13], "порядок сообщений внутри человека нарушен");
  assert.deepEqual(inbox.statuses(), { completed: 4 });
});

test("сообщения разных людей не смешиваются в одном ходе", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(21, 600, "моё"), 0);
  inbox.enqueueUpdate(textUpdate(22, 601, "чужое"), 1);

  const groups: number[][] = [];
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async (records) => {
      groups.push(records.map((record) => record.telegramUserId!));
      return { status: "completed" };
    },
    logger,
    OPTIONS,
    undefined,
    new TurnAggregator(inbox as never, logger, { debounceMs: 1, maxWindowMs: 5 }, async () => {}),
  );

  await drain(dispatcher, inbox);
  for (const group of groups) {
    assert.equal(new Set(group).size, 1, `в одном ходе оказались разные люди: ${group}`);
  }
});

// ---------------------------------------------------------------------
// 3. Перезапуск и аренда
// ---------------------------------------------------------------------

test("перезапуск воркера не теряет запись: истёкшая аренда возвращает её в работу", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(31, 700, "сообщение"), 0);

  // Прежний процесс взял запись и упал, не завершив её.
  const row = inbox.rows.get(31)!;
  row.status = "processing";
  row.attempts = 1;
  row.lockedAt = Date.now() - 60_000;
  row.lockedBy = "умерший-процесс";

  const seen: number[] = [];
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async (records) => {
      seen.push(records[0]!.updateId);
      return { status: "completed", usageCharged: true };
    },
    logger,
    OPTIONS,
  );

  await drain(dispatcher, inbox);
  assert.deepEqual(seen, [31], "запись после перезапуска не подобрана");
  assert.equal(inbox.rows.get(31)!.status, "completed");
});

test("живая аренда чужого воркера не отдаёт запись второму: дубля хода нет", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(voiceUpdate(41, 800, "voice-1"), 0);
  const row = inbox.rows.get(41)!;
  row.status = "processing";
  row.attempts = 1;
  // Расшифровка идёт долго, но аренда ещё наша.
  row.lockedAt = Date.now() - 5_000;
  row.lockedBy = "воркер-1";

  const batch = await inbox.claimBatch({
    workerId: "воркер-2",
    leaseSeconds: 30,
    maxAttempts: 3,
    limit: 10,
  });
  assert.deepEqual(batch, [], "запись отдана второму воркеру при живой аренде");
  assert.equal(inbox.handedOut.get(41) ?? 0, 0);
});

// ---------------------------------------------------------------------
// 4. Ёмкость
// ---------------------------------------------------------------------

test("при нехватке слота запись остаётся durable и не тратит попытку", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(51, 900, "сообщение"), 0);
  let processed = 0;

  const noSlots = { acquire: async () => null };
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async () => {
      processed += 1;
      return { status: "completed" };
    },
    logger,
    { ...OPTIONS, releaseDelaySeconds: 0 },
    noSlots as never,
  );

  await dispatcher.tick();
  await dispatcher.drain();

  assert.equal(processed, 0, "ход выполнился без слота");
  const row = inbox.rows.get(51)!;
  assert.equal(row.status, "queued", "запись не осталась durable");
  assert.equal(row.attempts, 0, "нехватка ёмкости съела попытку");
});

// ---------------------------------------------------------------------
// 5. Объединение быстрых сообщений
// ---------------------------------------------------------------------

test("два быстрых сообщения дают один ход и одно списание квоты", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(61, 1_000, "я хотел сказать"), 0);
  inbox.enqueueUpdate(textUpdate(62, 1_000, "что мне тяжело"), 1);

  const turns: string[][] = [];
  const aggregator = new TurnAggregator(
    inbox as never,
    logger,
    { debounceMs: 5, maxWindowMs: 20 },
    async () => {},
  );
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async (records) => {
      turns.push(records.map((record) => record.payload.message!.text!));
      return { status: "completed", usageCharged: true };
    },
    logger,
    OPTIONS,
    undefined,
    aggregator,
  );

  await drain(dispatcher, inbox);

  assert.equal(turns.length, 1, `ходов оказалось ${turns.length}, а не один`);
  assert.deepEqual(turns[0], ["я хотел сказать", "что мне тяжело"]);
  // Квота снимается ровно один раз: ход один.
  const charged = [...inbox.rows.values()].filter((row) => row.usageCharged);
  assert.equal(charged.length, 1, "объединённый ход списал квоту дважды");
  assert.deepEqual(inbox.statuses(), { completed: 2 });
});

/**
 * Пока Ева отвечает, человек продолжает писать.
 *
 * Поле ввода теперь свободно всё время ответа, поэтому это не редкий
 * случай, а обычный. Такие сообщения обязаны приниматься сразу, лежать
 * durable, не прерывать текущий ход и стать следующим — одним, а не
 * тремя.
 */
test("сообщения во время ответа не прерывают ход и становятся следующим", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(91, 1_300, "первый вопрос"), 0);

  const turns: string[][] = [];
  let interrupted = false;
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async (records) => {
      if (records[0]!.updateId === 91) {
        // Человек пишет ещё три сообщения, пока идёт ответ на первое.
        inbox.enqueueUpdate(textUpdate(92, 1_300, "и ещё"), 1);
        inbox.enqueueUpdate(textUpdate(93, 1_300, "вот что"), 2);
        inbox.enqueueUpdate(textUpdate(94, 1_300, "я думаю"), 3);
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Ход дошёл до конца сам: никто его не оборвал.
        if (records.length !== 1) interrupted = true;
      }
      turns.push(records.map((record) => record.payload.message!.text!));
      return { status: "completed", usageCharged: true };
    },
    logger,
    OPTIONS,
    undefined,
    new TurnAggregator(inbox as never, logger, { debounceMs: 5, maxWindowMs: 20 }, async () => {}),
  );

  await drain(dispatcher, inbox);

  assert.equal(interrupted, false, "текущий ход прервали новые сообщения");
  assert.deepEqual(turns, [
    ["первый вопрос"],
    ["и ещё", "вот что", "я думаю"],
  ]);
  // Ничего не потеряно и порядок сохранён.
  assert.deepEqual(inbox.statuses(), { completed: 4 });
});

test("команда не поглощается обычным текстом, а становится своим ходом", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(71, 1_100, "привет"), 0);
  inbox.enqueueUpdate(textUpdate(72, 1_100, "/help"), 1);

  const turns: string[][] = [];
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async (records) => {
      turns.push(records.map((record) => record.payload.message!.text!));
      return { status: "completed", usageCharged: true };
    },
    logger,
    OPTIONS,
    undefined,
    new TurnAggregator(inbox as never, logger, { debounceMs: 5, maxWindowMs: 20 }, async () => {}),
  );

  await drain(dispatcher, inbox);

  assert.deepEqual(turns, [["привет"], ["/help"]], "команда попала в чужой ход");
});

test("голос без готового медиа не объединяется и не создаёт дубль хода", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(81, 1_200, "смотри"), 0);
  // Расшифровки ещё нет и файла тоже: объединять нечего.
  inbox.enqueueUpdate(voiceUpdate(82, 1_200, null), 1);

  const turns: number[][] = [];
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async (records) => {
      turns.push(records.map((record) => record.updateId));
      return { status: "completed", usageCharged: true };
    },
    logger,
    OPTIONS,
    undefined,
    new TurnAggregator(inbox as never, logger, { debounceMs: 5, maxWindowMs: 20 }, async () => {}),
  );

  await drain(dispatcher, inbox);

  assert.deepEqual(turns, [[81], [82]], "неготовое медиа было объединено");
  // Каждое сообщение попало ровно в один ход. Голосовое окно успело
  // подобрать запись и вернуть её как границу — но возврат не считается
  // обработкой и не тратит попытку, иначе задержанная расшифровка
  // съедала бы попытки и умирала на третьей.
  const inTurns = turns.flat();
  assert.deepEqual([...inTurns].sort(), [81, 82]);
  assert.equal(inbox.rows.get(82)!.attempts, 1, "возврат по границе потратил попытку");
});

test("кризисное сообщение объединению не подлежит", () => {
  assert.equal(aggregatable(textUpdate(91, 1_300, "обычная мысль")), true);
  assert.equal(aggregatable(textUpdate(92, 1_300, "/start")), false);
  assert.equal(aggregatable(textUpdate(93, 1_300, "я не хочу больше жить")), false);
  assert.equal(mediaReady(voiceUpdate(94, 1_300, null)), false);
  assert.equal(mediaReady(voiceUpdate(95, 1_300, "file-1")), true);
});

// ---------------------------------------------------------------------
// 6. Откат по флагу
// ---------------------------------------------------------------------

test("выключение флага возвращает последовательный воркер и те же данные", async () => {
  const scenario = () => {
    const inbox = new FakeInbox();
    for (let index = 0; index < 12; index += 1) {
      inbox.enqueueUpdate(textUpdate(3_000 + index, 1_400 + (index % 4), `текст ${index}`), index);
    }
    return inbox;
  };

  const parallelInbox = scenario();
  const parallelOrder: number[] = [];
  await drain(
    new ParallelInboxDispatcher(
      parallelInbox as never,
      async (records) => {
        parallelOrder.push(records[0]!.updateId);
        return { status: "completed", usageCharged: true };
      },
      logger,
      OPTIONS,
    ),
    parallelInbox,
  );

  const sequentialInbox = scenario();
  const sequentialOrder: number[] = [];
  const worker = new TelegramInboxWorker(
    sequentialInbox as never,
    async (update) => {
      sequentialOrder.push(update.update_id);
      return { status: "completed", usageCharged: true };
    },
    logger,
    { pollMs: 10_000, leaseSeconds: 30, maxAttempts: 3 },
  );
  for (let round = 0; round < 20; round += 1) {
    await worker.tick();
    if (![...sequentialInbox.rows.values()].some((row) => ACTIVE.has(row.status))) break;
  }

  // Данные после обоих путей совпадают строка в строку.
  const shape = (inbox: FakeInbox) =>
    [...inbox.rows.values()]
      .map((row) => `${row.updateId}:${row.status}:${row.attempts}:${row.usageCharged}`)
      .sort();
  assert.deepEqual(shape(parallelInbox), shape(sequentialInbox));
  assert.deepEqual([...parallelOrder].sort(), [...sequentialOrder].sort());
});

// ---------------------------------------------------------------------
// 7. Бюджет ожидания
// ---------------------------------------------------------------------

test("p95 ожидания начала обработки не превышает секунды на 100 ходах", async () => {
  const inbox = new FakeInbox();
  const enqueuedAt = new Map<number, number>();
  const started = new Map<number, number>();
  for (let index = 0; index < 100; index += 1) {
    inbox.enqueueUpdate(textUpdate(4_000 + index, 2_000 + index, `сообщение ${index}`), index);
    enqueuedAt.set(4_000 + index, Date.now());
  }

  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async (records) => {
      started.set(records[0]!.updateId, Date.now());
      // Mock-LLM: ход не бесплатный, но и не бесконечный.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: "completed", usageCharged: true };
    },
    logger,
    { ...OPTIONS, concurrency: 32, batchSize: 32 },
  );

  await drain(dispatcher, inbox);

  const waits = [...started].map(([updateId, at]) => at - enqueuedAt.get(updateId)!).sort(
    (left, right) => left - right,
  );
  assert.equal(waits.length, 100, "не все ходы начались");
  const percentile = (value: number) => waits[Math.min(waits.length - 1, Math.floor(waits.length * value))]!;
  const p95 = percentile(0.95);
  assert.ok(p95 <= 1_000, `p95 ожидания ${p95} мс превышает секунду`);
  // Печатается намеренно: отчёт шага требует измеренные значения.
  console.log(
    `ожидание начала обработки: p50=${percentile(0.5)} мс, p95=${p95} мс, p99=${percentile(0.99)} мс`,
  );
});

// ---------------------------------------------------------------------
// 8. Найдено независимой проверкой
// ---------------------------------------------------------------------

test("запись с исчерпанными попытками не блокирует очередь человека навсегда", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(101, 3_100, "застрявшее"), 0);
  inbox.enqueueUpdate(textUpdate(102, 3_100, "следующее"), 1);

  // Прежний воркер брал запись трижды и каждый раз падал, а последняя
  // аренда истекла: попытки кончились, статус остался processing.
  const stuck = inbox.rows.get(101)!;
  stuck.status = "processing";
  stuck.attempts = 3;
  stuck.lockedAt = Date.now() - 600_000;
  stuck.lockedBy = "умерший-процесс";

  const seen: number[] = [];
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async (records) => {
      seen.push(records[0]!.updateId);
      return { status: "completed", usageCharged: true };
    },
    logger,
    OPTIONS,
  );

  await drain(dispatcher, inbox);

  assert.equal(inbox.rows.get(101)!.status, "dead", "застрявшая запись не похоронена");
  assert.deepEqual(seen, [102], "следующее сообщение человека не дошло до обработки");
});

test("занятая чужим процессом блокировка возвращает запись, а не тратит попытку", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(111, 3_200, "сообщение"), 0);
  let processed = 0;

  // Тот же ключ Valkey держит фоновая часть сервиса: из базы это не видно.
  const heldLock = { isLocked: async () => true };
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async () => {
      processed += 1;
      return { status: "completed" };
    },
    logger,
    { ...OPTIONS, releaseDelaySeconds: 0 },
    undefined,
    undefined,
    heldLock as never,
  );

  await dispatcher.tick();
  await dispatcher.drain();

  assert.equal(processed, 0, "ход пошёл поверх чужой блокировки");
  const row = inbox.rows.get(111)!;
  assert.equal(row.status, "queued", "запись не осталась durable");
  assert.equal(row.attempts, 0, "чужая занятость съела попытку");
});

test("user_busy не убивает сообщение: запись возвращается, а не идёт к отказу", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(121, 3_300, "сообщение"), 0);
  let calls = 0;

  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async () => {
      calls += 1;
      if (calls === 1) throw userBusy("слот занят", 1);
      return { status: "completed", usageCharged: true };
    },
    logger,
    { ...OPTIONS, releaseDelaySeconds: 0 },
  );

  await dispatcher.tick();
  await dispatcher.drain();
  assert.equal(inbox.rows.get(121)!.status, "queued");
  assert.equal(inbox.rows.get(121)!.attempts, 0, "занятость слота потратила попытку");

  await drain(dispatcher, inbox);
  assert.equal(inbox.rows.get(121)!.status, "completed");
});

test("недоступная Valkey не роняет процесс и не теряет запись", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(131, 3_400, "сообщение"), 0);
  let processed = 0;

  const brokenSlots = {
    acquire: async () => {
      throw new Error("Valkey недоступна");
    },
  };
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async () => {
      processed += 1;
      return { status: "completed" };
    },
    logger,
    { ...OPTIONS, releaseDelaySeconds: 0 },
    brokenSlots as never,
  );

  // Падения быть не должно: unhandled rejection здесь означал бы
  // остановленный сервис, а не пропущенное сообщение.
  await dispatcher.tick();
  await dispatcher.drain();

  assert.equal(processed, 0);
  const row = inbox.rows.get(131)!;
  assert.equal(row.status, "queued", "запись потеряна при отказе Valkey");
  assert.equal(row.attempts, 0);
});

test("чужую аренду возврат не трогает", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(141, 3_500, "сообщение"), 0);
  const [record] = await inbox.claimBatch({
    workerId: "воркер-1",
    leaseSeconds: 30,
    maxAttempts: 3,
    limit: 1,
  });
  assert.ok(record);

  await inbox.release(141, 0, "воркер-2");
  assert.equal(inbox.rows.get(141)!.status, "processing", "чужой возврат сбросил аренду");
  assert.equal(inbox.rows.get(141)!.lockedBy, "воркер-1");

  await inbox.release(141, 0, "воркер-1");
  assert.equal(inbox.rows.get(141)!.status, "queued");
});

test("списание квоты помечает то сообщение, на которое ход отвечает", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(151, 3_600, "я хотел"), 0);
  inbox.enqueueUpdate(textUpdate(152, 3_600, "сказать вот что"), 1);

  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async () => ({ status: "completed", usageCharged: true }),
    logger,
    OPTIONS,
    undefined,
    new TurnAggregator(inbox as never, logger, { debounceMs: 5, maxWindowMs: 20 }, async () => {}),
  );

  await drain(dispatcher, inbox);

  const charged = [...inbox.rows.values()].filter((row) => row.usageCharged);
  assert.equal(charged.length, 1);
  assert.equal(charged[0]!.updateId, 152, "квота списана не с того сообщения, на которое отвечали");
});

test("остановка посреди опроса возвращает уже взятый батч в очередь", async () => {
  const inbox = new FakeInbox();
  for (let index = 0; index < 4; index += 1) {
    inbox.enqueueUpdate(textUpdate(161 + index, 3_700 + index, "сообщение"), index);
  }
  let processed = 0;
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async () => {
      processed += 1;
      return { status: "completed" };
    },
    logger,
    OPTIONS,
  );

  // Остановка приходит между claim и запуском ходов.
  const original = inbox.claimBatch.bind(inbox);
  inbox.claimBatch = async (input) => {
    const batch = await original(input);
    dispatcher.stop();
    return batch;
  };

  await dispatcher.tick();
  await dispatcher.drain();

  assert.equal(processed, 0, "остановленный диспетчер всё равно начал ходы");
  assert.deepEqual(inbox.statuses(), { queued: 4 }, "взятый батч не вернулся в очередь");
  for (const row of inbox.rows.values()) {
    assert.equal(row.attempts, 0, "остановка потратила попытку");
  }
});

test("оборванное окно объединения отдаёт уже собранное, а не теряет его", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(171, 3_800, "первое"), 0);
  inbox.enqueueUpdate(textUpdate(172, 3_800, "второе"), 1);

  // Второй заход в базу падает: окно оборвано на полпути.
  let calls = 0;
  const original = inbox.claimFollowUps.bind(inbox);
  inbox.claimFollowUps = async (input) => {
    calls += 1;
    if (calls === 2) throw new Error("база отказала");
    return await original(input);
  };

  const turns: number[][] = [];
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async (records) => {
      turns.push(records.map((record) => record.updateId));
      return { status: "completed", usageCharged: true };
    },
    logger,
    OPTIONS,
    undefined,
    new TurnAggregator(inbox as never, logger, { debounceMs: 1, maxWindowMs: 50 }, async () => {}),
  );

  await drain(dispatcher, inbox);

  // Обе записи собраны первым заходом и дошли до хода: брошенная на
  // полпути запись иначе висела бы `processing` до истечения аренды.
  assert.deepEqual(turns, [[171, 172]]);
  assert.deepEqual(inbox.statuses(), { completed: 2 });
});

test("отказ базы в окне отличим от границы темы и не оставляет записей занятыми", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(181, 3_900, "первое"), 0);
  inbox.enqueueUpdate(textUpdate(182, 3_900, "/help"), 1);
  inbox.enqueueUpdate(textUpdate(183, 3_900, "третье"), 2);

  // Возврат сообщения-границы падает: записи батча, до которых цикл не
  // дошёл, иначе остались бы занятыми до истечения аренды.
  const original = inbox.release.bind(inbox);
  let failed = false;
  inbox.release = async (updateId, delaySeconds, workerId) => {
    if (updateId === 182 && !failed) {
      failed = true;
      throw new Error("база отказала");
    }
    return await original(updateId, delaySeconds, workerId);
  };

  const aggregator = new TurnAggregator(
    inbox as never,
    logger,
    { debounceMs: 1, maxWindowMs: 30 },
    async () => {},
  );
  const [primary] = await inbox.claimBatch({
    workerId: "воркер-1",
    leaseSeconds: 30,
    maxAttempts: 3,
    limit: 1,
  });
  const collected = await aggregator.collect(primary!, {
    workerId: "воркер-1",
    maxAttempts: 3,
  });

  // Окно закрылось границей, а не обрывом: упал только возврат.
  assert.deepEqual(collected.records.map((record) => record.updateId), [181]);
  assert.equal(collected.stop, "boundary");
  // 183 не осталось занятым из-за чужой неудачи.
  assert.notEqual(inbox.rows.get(183)!.status, "processing");
});

test("оборванное окно помечается отдельной причиной, а не границей темы", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(191, 4_500, "первое"), 0);
  inbox.claimFollowUps = async () => {
    throw new Error("база отказала");
  };

  const aggregator = new TurnAggregator(
    inbox as never,
    logger,
    { debounceMs: 1, maxWindowMs: 20 },
    async () => {},
  );
  const [primary] = await inbox.claimBatch({
    workerId: "воркер-1",
    leaseSeconds: 30,
    maxAttempts: 3,
    limit: 1,
  });
  const collected = await aggregator.collect(primary!, {
    workerId: "воркер-1",
    maxAttempts: 3,
  });

  assert.equal(collected.stop, "interrupted", "отказ базы неотличим от границы темы");
  assert.deepEqual(collected.records.map((record) => record.updateId), [191]);
});

test("остановка не ждёт зависший ход дольше отведённого срока", async () => {
  const inbox = new FakeInbox();
  inbox.enqueueUpdate(textUpdate(201, 4_600, "сообщение"), 0);

  let unblock: (() => void) | null = null;
  const stuck = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const dispatcher = new ParallelInboxDispatcher(
    inbox as never,
    async () => {
      await stuck;
      return { status: "completed" };
    },
    logger,
    OPTIONS,
  );

  await dispatcher.tick();
  dispatcher.stop();

  const started = Date.now();
  await dispatcher.drain(120);
  const waited = Date.now() - started;

  // Допуск на планировщик, а не на порядок величины: срок в восемь раз
  // больше отведённого прошёл бы проверку «меньше секунды».
  assert.ok(waited < 400, `остановка ждала ${waited} мс вместо отведённых 120`);
  unblock!();
  await dispatcher.drain(1_000);
});
