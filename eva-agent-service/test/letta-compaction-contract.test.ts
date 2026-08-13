import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("patched Letta Agent SDK maps compactionSettings to App Server compaction_settings", () => {
  const sdk = readFileSync(new URL("../node_modules/@letta-ai/letta-agent-sdk/dist/index.js", import.meta.url), "utf8");
  const mapper = sdk.match(/function agentUpdateBody\(options\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(mapper, "agentUpdateBody mapper must exist in installed SDK");
  assert.match(mapper, /compaction_settings:\s*options\.compactionSettings/);
});
