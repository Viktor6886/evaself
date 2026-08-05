/**
 * Глобальные семафоры слотов хода.
 *
 * Проверяется не «скрипт выполнился», а три свойства, ради которых
 * семафоры и заводились: предел действительно предел, резерв достаётся
 * интерактивным ходам и никому больше, а слот упавшего процесса
 * возвращается сам.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { slotBudget, TurnSemaphores } from "../dist/turns/semaphores.js";

/**
 * Valkey ровно в том объёме, в каком его использует модуль: сортированное
 * множество держателей со сроком годности в качестве веса.
 */
class FakeRedis {
  zsets = new Map<string, Map<string, number>>();

  private set(key: string): Map<string, number> {
    const existing = this.zsets.get(key);
    if (existing) return existing;
    const created = new Map<string, number>();
    this.zsets.set(key, created);
    return created;
  }

  async eval(script: string, _numkeys: number, key: string, ...args: string[]) {
    const zset = this.set(key);
    if (script.includes("ZREMRANGEBYSCORE")) {
      const [now, limit, holder, expiresAt] = args;
      for (const [member, score] of [...zset]) {
        if (score <= Number(now)) zset.delete(member);
      }
      if (zset.size >= Number(limit)) return 0;
      zset.set(holder!, Number(expiresAt));
      return 1;
    }
    const [holder, expiresAt] = args;
    if (!zset.has(holder!)) return 0;
    zset.set(holder!, Number(expiresAt));
    return 1;
  }

  async zrem(key: string, member: string) {
    return this.set(key).delete(member) ? 1 : 0;
  }

  async zcount(key: string, min: number) {
    let count = 0;
    for (const score of this.set(key).values()) if (score > min) count += 1;
    return count;
  }
}

const semaphores = (total = 128) =>
  new TurnSemaphores(new FakeRedis() as never, { total, leaseSeconds: 60 });

test("раскладка слотов повторяет бюджет CLAUDE.md и отдаёт интерактивным не меньше 80%", () => {
  const budget = slotBudget(128);
  assert.deepEqual(budget, {
    total: 128,
    interactive: 104,
    background: 12,
    research: 8,
    reserve: 4,
  });
  assert.ok(
    (budget.interactive + budget.reserve) / budget.total >= 0.8,
    "интерактивным досталось меньше 80% слотов",
  );
  // Пропорция сохраняется и на другом пределе, и ни один класс не
  // обнуляется округлением: класс с нулём слотов — это выключенный
  // класс, а такое решение принимает человек.
  const small = slotBudget(32);
  assert.equal(small.total, 32);
  assert.ok(small.background >= 1 && small.research >= 1 && small.reserve >= 1);
  assert.equal(
    small.interactive + small.background + small.research + small.reserve,
    32,
  );
});

test("предел класса — это предел: сверх него слот не выдаётся", async () => {
  const slots = semaphores(128);
  const held = [];
  for (let index = 0; index < 12; index += 1) {
    const slot = await slots.acquire("background", `worker-${index}`);
    assert.ok(slot, `фоновый слот ${index} не выдан`);
    held.push(slot!);
  }
  assert.equal(await slots.acquire("background", "worker-13"), null);

  // Освобождение возвращает место — и следующий получает его сразу.
  await held[0]!.release();
  const next = await slots.acquire("background", "worker-13");
  assert.ok(next, "после освобождения слот не выдан");
});

test("резерв достаётся интерактивным ходам, а фон до него не дотягивается", async () => {
  const slots = semaphores(128);
  // Интерактивных 104 плюс 4 резерва — 108 подряд.
  for (let index = 0; index < 108; index += 1) {
    assert.ok(
      await slots.acquire("interactive", `interactive-${index}`),
      `интерактивный слот ${index} не выдан`,
    );
  }
  assert.equal(await slots.acquire("interactive", "interactive-109"), null);

  // Фон в это же время держит только свои 12 и в резерв не попадает,
  // хотя интерактивные места уже кончились.
  for (let index = 0; index < 12; index += 1) {
    assert.ok(await slots.acquire("background", `background-${index}`));
  }
  assert.equal(await slots.acquire("background", "background-13"), null);

  const usage = await slots.usage();
  assert.equal(usage.interactive.limit, 108, "резерв не входит в интерактивный предел");
  assert.equal(usage.background.limit, 12);
  assert.equal(usage.research.limit, 8);
});

test("слот упавшего процесса возвращается сам: держатель просрочен", async () => {
  const redis = new FakeRedis();
  const slots = new TurnSemaphores(redis as never, { total: 128, leaseSeconds: 60 });
  for (let index = 0; index < 8; index += 1) {
    assert.ok(await slots.acquire("research", `research-${index}`));
  }
  assert.equal(await slots.acquire("research", "research-9"), null);

  // Процесс упал, продлевать аренду некому: срок годности в прошлом.
  for (const [member] of redis.zsets.get("eva:slots:research")!) {
    redis.zsets.get("eva:slots:research")!.set(member, Date.now() - 1);
  }
  assert.ok(
    await slots.acquire("research", "research-9"),
    "просроченные держатели не были вычищены",
  );
});

test("продление работает только для того, кто слот держит", async () => {
  const slots = semaphores(128);
  const slot = await slots.acquire("interactive", "mine");
  assert.ok(slot);
  assert.equal(await slot!.renew(), true);
  await slot!.release();
  assert.equal(await slot!.renew(), false, "освобождённый слот продлевать нечем");
});
