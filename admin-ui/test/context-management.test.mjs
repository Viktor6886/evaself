import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openPanel } from "./harness.mjs";

let panel;
after(async () => await panel?.close());

test("панель сохраняет SDK context, dreaming и автоматическую rotation", async () => {
  const sdk = {
    default_context_window: 180000,
    dreaming: { trigger: "compaction-event" },
    automatic_context_management: {
      enabled: true,
      compaction_message_threshold: 300,
      rotation_message_threshold: 600,
    },
  };
  panel = await openPanel({ routes: {
    "/settings": { settings: [], profiles: [] },
    "/context-management": { settings: sdk, conversations: [{
      conversation_id: "local-conv-6", agent_id: "agent-1", message_count: 764,
      context_window_limit: 1000000,
    }] },
    "PUT /context-management": () => ({ settings: sdk }),
    "PATCH /context-management/conversations/local-conv-6": () => ({ conversation: { id: "local-conv-6", context_window_limit: 180000 } }),
  }});
  await panel.page.evaluate(() => openPage("settings"));
  await panel.page.waitForSelector("#context-management-form:not([hidden])");
  assert.equal(await panel.page.inputValue('[name="default_context_window"]'), "180000");
  assert.equal(await panel.page.inputValue('[name="dreaming_trigger"]'), "compaction-event");
  await panel.page.fill('[data-conversation-limit="local-conv-6"]', "180000");
  await panel.page.click('[data-save-conversation-limit="local-conv-6"]');
  await panel.page.waitForFunction(() => window.__contextSaved === true || document.querySelector("#toast").textContent.includes("Диалог"));
  assert.equal(panel.requests.some((r) => r.method === "PATCH" && r.path.includes("local-conv-6") && r.body.context_window_limit === 180000), true);
});