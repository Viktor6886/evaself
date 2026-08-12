import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("skills operational page is visible and loads protected Admin API", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../public/ui.js", import.meta.url), "utf8");
  assert.match(html, /data-page="skills"/);
  assert.match(html, /id="skills-status"/);
  assert.match(js, /request\("\/skills\/operations\?hours=24"\)/);
  for (const field of ["latency.p50", "latency.p95", "latency.p99", "reranker.ratio", "sticky_count", "fallback_count", "payload.reasons", "payload.selected"]) assert.match(js, new RegExp(field.replace(".", "\\.")));
  const loader = js.slice(js.indexOf("async function loadSkills"), js.indexOf("function openPage"));
  assert.doesNotMatch(loader, /skill\.source|conversation_id|message/);
});
