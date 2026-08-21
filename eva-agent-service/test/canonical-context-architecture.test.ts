import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("canonical sync has no HTTP control-plane fallback", async () => {
  const files = await Promise.all([
    "src/config.ts",
    "src/index.ts",
    "src/letta.ts",
    "src/letta/persona-sync.ts",
  ].map((file) => readFile(file, "utf8")));
  const source = files.join("\n");
  assert.doesNotMatch(source, /@letta-ai\/letta-client/);
  assert.doesNotMatch(source, /httpFromWebsocket|EVA_LETTA_ADMIN_(?:CLIENT|BASE_URL)/);
  assert.doesNotMatch(source, /parsed\.protocol\s*=.*https?/);
  const letta = await readFile("src/letta.ts", "utf8");
  assert.doesNotMatch(letta, /\.initialize\(\)/);
});

test("sync failure cannot gate a Telegram turn", async () => {
  const source = await readFile("src/eva-workflow.ts", "utf8");
  assert.match(source, /Canonical context sync degraded; continuing turn/);
  assert.doesNotMatch(source, /Канонический context агента не применён/);
  assert.doesNotMatch(source, /if \(syncOutcome[^}]+throw appServerUnavailable/s);
});

test("canonical files are mounted read-only and MemFS state is persisted", async (t) => {
  try {
    await access("../compose.yaml");
  } catch {
    t.skip("repository compose is outside the service Docker build context");
    return;
  }
  const compose = await readFile("../compose.yaml", "utf8");
  assert.match(compose, /\.\/library:\/app\/library:ro/);
  assert.match(compose, /letta_app_server_data:\/data\/letta:rw/);
});
