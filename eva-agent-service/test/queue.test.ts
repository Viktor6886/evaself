/**
 * Queue and lock semantics, against a minimal in-memory Valkey stand-in that
 * implements exactly the commands UserQueue uses.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { EvaError } from "../dist/errors.js";
import { UserQueue } from "../dist/queue.js";

class FakeRedis {
  store = new Map<string, string>();
  ttls = new Map<string, number>();

  async set(key: string, value: string, _ex: "EX", seconds: number, _nx: "NX") {
    if (this.store.has(key)) return null;
    this.store.set(key, value);
    this.ttls.set(key, seconds);
    return "OK";
  }
  async ttl(key: string) {
    return this.ttls.get(key) ?? -1;
  }
  // UserQueue uses two Lua scripts against the same key: compare-and-delete
  // on release, compare-and-expire on renewal. Both are no-ops for a foreign
  // token, which is the property that makes the lock safe.
  async eval(script: string, _numkeys: number, key: string, token: string, seconds?: string) {
    if (this.store.get(key) !== token) return 0;
    if (script.includes("EXPIRE")) {
      this.ttls.set(key, Number(seconds));
      return 1;
    }
    this.store.delete(key);
    this.ttls.delete(key);
    return 1;
  }
  async del(key: string) {
    const existed = this.store.has(key);
    this.store.delete(key);
    return existed ? 1 : 0;
  }
  async exists(key: string) {
    return this.store.has(key) ? 1 : 0;
  }
}

const makeQueue = (maxQueueDepth = 3) =>
  new UserQueue(new FakeRedis() as never, { ttlSeconds: 30, maxQueueDepth });

test("a turn runs and releases the lock afterwards", async () => {
  const queue = makeQueue();
  const result = await queue.run(1, async () => "done");
  assert.equal(result, "done");
  assert.equal(await queue.isLocked(1), false);
});

test("messages from one user are serialised, not rejected", async () => {
  const queue = makeQueue();
  const order: string[] = [];

  const first = queue.run(1, async () => {
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 40));
    order.push("first-end");
    return 1;
  });
  const second = queue.run(1, async () => {
    order.push("second-start");
    return 2;
  });

  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("different users do not block each other", async () => {
  const queue = makeQueue();
  const results = await Promise.all([
    queue.run(1, async () => "a"),
    queue.run(2, async () => "b"),
  ]);
  assert.deepEqual(results, ["a", "b"]);
});

test("a burst deeper than the queue is rejected as retryable user_busy", async () => {
  const queue = makeQueue(1);
  const running = queue.run(1, async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return "first";
  });
  const queued = queue.run(1, async () => "second");

  await assert.rejects(
    () => queue.run(1, async () => "third"),
    (error: unknown) => {
      assert.ok(error instanceof EvaError);
      assert.equal(error.code, "user_busy");
      assert.equal(error.retryable, true);
      assert.equal(error.statusCode, 409);
      return true;
    },
  );

  await Promise.all([running, queued]);
});

test("the lock is released even when the turn throws", async () => {
  const queue = makeQueue();
  await assert.rejects(() =>
    queue.run(1, async () => {
      throw new Error("letta blew up");
    }),
  );
  assert.equal(await queue.isLocked(1), false);
  // and the user can immediately try again
  assert.equal(await queue.run(1, async () => "recovered"), "recovered");
});

test("a lock held by another instance produces user_busy with a retry hint", async () => {
  const redis = new FakeRedis();
  redis.store.set("eva:lock:user:1", "someone-else");
  redis.ttls.set("eva:lock:user:1", 17);
  const queue = new UserQueue(redis as never, { ttlSeconds: 30 });

  await assert.rejects(
    () => queue.run(1, async () => "never"),
    (error: unknown) => {
      assert.ok(error instanceof EvaError);
      assert.equal(error.code, "user_busy");
      assert.deepEqual(error.details, { retry_after_seconds: 17 });
      return true;
    },
  );
});

test("forceRelease clears a stuck lock", async () => {
  const redis = new FakeRedis();
  redis.store.set("eva:lock:user:5", "stuck");
  const queue = new UserQueue(redis as never, { ttlSeconds: 30 });
  assert.equal(await queue.forceRelease(5), true);
  assert.equal(await queue.isLocked(5), false);
});

test("releasing with a foreign token is a no-op", async () => {
  const redis = new FakeRedis();
  const queue = new UserQueue(redis as never, { ttlSeconds: 30 });
  await queue.run(9, async () => {
    // simulate the lock expiring and being taken by someone else mid-turn
    redis.store.set("eva:lock:user:9", "another-owner");
    return null;
  });
  assert.equal(redis.store.get("eva:lock:user:9"), "another-owner");
});

test("the lease is renewed while a long turn is still running", async () => {
  // The default lock TTL is shorter than the default turn timeout: without
  // renewal a slow answer loses its lock mid-turn and a second worker can
  // start a concurrent turn on the same Letta conversation.
  const redis = new FakeRedis();
  const queue = new UserQueue(redis as never, { ttlSeconds: 1 });

  const renewals: number[] = [];
  const originalEval = redis.eval.bind(redis);
  redis.eval = (script: string, ...rest: unknown[]) => {
    if (script.includes("EXPIRE")) renewals.push(Date.now());
    return originalEval(script, ...(rest as [number, ...unknown[]]));
  };

  await queue.run(1, async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_400));
    assert.ok(await queue.isLocked(1), "the lock must still be held mid-turn");
  });

  assert.ok(renewals.length >= 2, `expected renewals, got ${renewals.length}`);
  assert.equal(await queue.isLocked(1), false, "the lock is released afterwards");
});

test("renewal stops once the turn ends", async () => {
  const redis = new FakeRedis();
  const queue = new UserQueue(redis as never, { ttlSeconds: 1 });
  let renewals = 0;
  const originalEval = redis.eval.bind(redis);
  redis.eval = (script: string, ...rest: unknown[]) => {
    if (script.includes("EXPIRE")) renewals += 1;
    return originalEval(script, ...(rest as [number, ...unknown[]]));
  };

  await queue.run(2, () => Promise.resolve("done"));
  const afterTurn = renewals;
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(renewals, afterTurn, "the renewal timer must not outlive the turn");
});
