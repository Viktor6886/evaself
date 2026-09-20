import assert from "node:assert/strict";
import test from "node:test";

import {
  quotaAllowsAmount,
  quotaRemaining,
} from "../dist/subscriptions/quota-policy.js";

test("message batch is limited by the smallest active quota period", () => {
  const quotas = [
    { metric: "messages", period: "month", remaining: 20 },
    { metric: "messages", period: "week", remaining: 4 },
    { metric: "messages", period: "day", remaining: 1 },
    { metric: "messages_out", period: "day", remaining: 0 },
  ];

  assert.equal(quotaRemaining(quotas, "messages"), 1);
  assert.equal(quotaAllowsAmount(quotas, "messages", 1), true);
  assert.equal(quotaAllowsAmount(quotas, "messages", 2), false);
});

test("unlimited quota accepts an aggregated batch", () => {
  const quotas = [
    { metric: "messages", period: "day", remaining: null },
    { metric: "messages", period: "month", remaining: null },
  ];

  assert.equal(quotaRemaining(quotas, "messages"), null);
  assert.equal(quotaAllowsAmount(quotas, "messages", 25), true);
});

test("invalid quota amount is rejected", () => {
  assert.throws(
    () => quotaAllowsAmount([], "messages", 0),
    /положительным целым/u,
  );
});
