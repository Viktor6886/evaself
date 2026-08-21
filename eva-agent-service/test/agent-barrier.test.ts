/**
 * Барьер обслуживания агента.
 *
 * Проверяется именно то, чего не давал снимок пула сессий: пока
 * канонический контекст агента правят, новый ход этого агента не
 * стартует, идущий договаривает, а другой агент ничего не ждёт.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { AgentMaintenanceBarrier } from "../dist/letta/agent-barrier.js";

// Ожидание барьера намеренно не держит event loop (`unref`): остановка
// сервиса не должна ждать окно drain. В тесте кроме него ждать нечего,
// поэтому цикл удерживается явно — иначе раннер завершался бы посреди
// проверки.
const keepAlive = setInterval(() => {}, 20);
after(() => clearInterval(keepAlive));

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("maintenance blocks a new turn of the same agent and releases it afterwards", async () => {
  const barrier = new AgentMaintenanceBarrier();
  barrier.bind("conv-1", "agent-1");

  let finishWork!: () => void;
  const work = new Promise<void>((resolve) => { finishWork = resolve; });
  const maintenance = barrier.runMaintenance("agent-1", async () => {
    await work;
    return "applied";
  }, { drainTimeoutMs: 1_000 });
  await tick();
  assert.equal(barrier.isMaintaining("agent-1"), true);

  let entered = false;
  const turn = barrier.enterTurn("conv-1").then((leave) => { entered = true; return leave; });
  await tick();
  await tick();
  assert.equal(entered, false, "a turn started in the middle of a canonical mutation");

  finishWork();
  assert.deepEqual(await maintenance, { status: "done", value: "applied" });
  (await turn)();
  assert.equal(entered, true, "the turn was not released after maintenance finished");
  assert.equal(barrier.isMaintaining("agent-1"), false);
});

test("another agent keeps running while one agent is maintained", async () => {
  const barrier = new AgentMaintenanceBarrier();
  barrier.bind("conv-1", "agent-1");
  barrier.bind("conv-2", "agent-2");

  let finishWork!: () => void;
  const work = new Promise<void>((resolve) => { finishWork = resolve; });
  const maintenance = barrier.runMaintenance("agent-1", () => work, { drainTimeoutMs: 1_000 });
  await tick();

  // Ход другого агента не ждёт вообще: ожидание здесь было бы общим
  // стоп-краном на все разговоры сразу.
  const leaveOther = await barrier.enterTurn("conv-2");
  assert.equal(barrier.activeTurns("agent-2"), 1);
  leaveOther();

  finishWork();
  await maintenance;
});

test("the current turn finishes gracefully before maintenance starts", async () => {
  const barrier = new AgentMaintenanceBarrier();
  barrier.bind("conv-1", "agent-1");
  const leave = await barrier.enterTurn("conv-1");

  let started = false;
  const maintenance = barrier.runMaintenance("agent-1", async () => {
    started = true;
    return true;
  }, { drainTimeoutMs: 1_000 });
  await tick();
  await tick();
  assert.equal(started, false, "maintenance began while a turn was still running");

  leave();
  assert.deepEqual(await maintenance, { status: "done", value: true });
  assert.equal(started, true);
});

test("maintenance reports busy instead of interrupting a long turn", async () => {
  const barrier = new AgentMaintenanceBarrier();
  barrier.bind("conv-1", "agent-1");
  const leave = await barrier.enterTurn("conv-1");

  let started = false;
  const outcome = await barrier.runMaintenance("agent-1", async () => {
    started = true;
    return true;
  }, { drainTimeoutMs: 40 });
  assert.deepEqual(outcome, { status: "busy" });
  assert.equal(started, false, "a partially applied mutation started beside a live turn");
  // Отказавшись, барьер не остаётся закрытым: следующий ход идёт сразу.
  assert.equal(barrier.isMaintaining("agent-1"), false);
  leave();
  (await barrier.enterTurn("conv-1"))();
});

test("two conversations of one agent do not race with a single sync", async () => {
  const barrier = new AgentMaintenanceBarrier();
  barrier.bind("conv-a", "agent-1");
  barrier.bind("conv-b", "agent-1");

  const first = await barrier.enterTurn("conv-a");
  let started = false;
  let finishWork!: () => void;
  const work = new Promise<void>((resolve) => { finishWork = resolve; });
  const maintenance = barrier.runMaintenance("agent-1", async () => {
    started = true;
    await work;
    return true;
  }, { drainTimeoutMs: 1_000 });
  await tick();
  assert.equal(started, false);

  // Второй разговор того же агента тоже ждёт: MemFS у них общий, и
  // «другая conversation» не делает состояние другим.
  let secondEntered = false;
  const second = barrier.enterTurn("conv-b").then((leave) => { secondEntered = true; return leave; });
  first();
  await tick();
  await tick();
  assert.equal(started, true, "maintenance did not start after the only live turn ended");
  assert.equal(secondEntered, false, "the second conversation entered mid-mutation");

  finishWork();
  await maintenance;
  (await second)();
  assert.equal(secondEntered, true);
});

test("a conversation whose agent is not known yet is still gated", async () => {
  const barrier = new AgentMaintenanceBarrier();
  // До первого хода агент неизвестен: место занимается по conversation,
  // и обслуживание, знающее её агента, всё равно её закрывает.
  const leave = await barrier.enterTurn("conv-1");
  const outcome = await barrier.runMaintenance("agent-1", async () => true, {
    drainTimeoutMs: 30,
    conversationIds: ["conv-1"],
  });
  assert.deepEqual(outcome, { status: "busy" });
  leave();
  assert.deepEqual(
    await barrier.runMaintenance("agent-1", async () => true, {
      drainTimeoutMs: 30,
      conversationIds: ["conv-1"],
    }),
    { status: "done", value: true },
  );
});

test("two mutations of one agent are serialized", async () => {
  const barrier = new AgentMaintenanceBarrier();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstWork = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = barrier.runMaintenance("agent-1", async () => {
    order.push("first:start");
    await firstWork;
    order.push("first:end");
  }, { drainTimeoutMs: 500 });
  await tick();
  const second = barrier.runMaintenance("agent-1", async () => {
    order.push("second:start");
  }, { drainTimeoutMs: 500 });
  await tick();
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
});
