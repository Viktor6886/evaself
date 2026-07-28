import assert from "node:assert/strict";
import { test } from "node:test";

import { EvaError, toEvaError, userBusy } from "../dist/errors.js";

test("the error payload is the shape n8n branches on", () => {
  const payload = userBusy("busy", 12).toPayload() as {
    error: { code: string; retryable: boolean; details: unknown };
  };
  assert.equal(payload.error.code, "user_busy");
  assert.equal(payload.error.retryable, true);
  assert.deepEqual(payload.error.details, { retry_after_seconds: 12 });
});

test("connection failures map to a retryable app_server_unavailable", () => {
  for (const message of [
    "connect ECONNREFUSED 10.0.0.5:4500",
    "getaddrinfo ENOTFOUND letta-app-server",
    "WebSocket closed unexpectedly",
    "socket hang up",
  ]) {
    const error = toEvaError(new Error(message), "running a turn");
    assert.equal(error.code, "app_server_unavailable", message);
    assert.equal(error.retryable, true, message);
    assert.equal(error.statusCode, 503, message);
  }
});

test("timeouts map to a retryable turn_timeout", () => {
  const error = toEvaError(new Error("request timed out after 180000ms"), "running a turn");
  assert.equal(error.code, "turn_timeout");
  assert.equal(error.retryable, true);
  assert.equal(error.statusCode, 504);
});

test("anything else is a non-retryable turn_failed", () => {
  const error = toEvaError(new Error("model refused the request"), "running a turn");
  assert.equal(error.code, "turn_failed");
  assert.equal(error.retryable, false);
  assert.equal(error.statusCode, 502);
});

test("an EvaError passes through unchanged", () => {
  const original = userBusy("busy", 5);
  assert.equal(toEvaError(original, "ctx"), original);
});

test("the context is kept in the message", () => {
  const error = toEvaError(new Error("boom"), "creating an agent");
  assert.match(error.message, /creating an agent: boom/);
});

test("EvaError defaults are conservative", () => {
  const error = new EvaError("something");
  assert.equal(error.code, "internal_error");
  assert.equal(error.statusCode, 500);
  assert.equal(error.retryable, false);
});
