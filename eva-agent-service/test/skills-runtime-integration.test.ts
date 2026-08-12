import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { SkillRuntimeMetrics, createRouterLlmAdapters } from "../dist/skills/runtime.js";
import { RuntimeContextBuilder } from "../dist/runtime/runtime-context.js";

test("production skill adapters use router endpoints and strict JSON", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const adapters = createRouterLlmAdapters({
    baseUrl: "http://router:8073",
    apiKey: "secret",
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      if (String(url).endsWith("/embeddings")) return new Response(JSON.stringify({ data: [{ index: 0, embedding: Array(1536).fill(1) }] }), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ids":["a"],"confidence":0.9}' } }] }), { status: 200 });
    },
  });
  assert.equal((await adapters.embed("hello")).length, 1536);
  assert.deepEqual(await adapters.rerank([{ id: "a", purpose: "p", applicability: "x" }]), ["a"]);
  assert.deepEqual(calls.map(x => x.url), ["http://router:8073/embeddings", "http://router:8073/chat/completions"]);
  assert.equal(calls[1]!.body.response_format.type, "json_schema");
});

test("skill metrics expose histogram buckets and bounded reranker ratio", () => {
  const metrics = new SkillRuntimeMetrics();
  metrics.observe({ reason: "hybrid", latencyMs: 12, reranked: true });
  metrics.observe({ reason: "unknown-user-text", latencyMs: 40, reranked: false });
  const rendered = metrics.render();
  assert.match(rendered, /eva_skill_router_latency_ms_bucket\{reason="hybrid",le="25"\} 1/);
  assert.match(rendered, /eva_skill_routes_total 2/); assert.match(rendered,/eva_skill_reranker_calls_total 1/);
  assert.doesNotMatch(rendered, /unknown-user-text/);
});

test("runtime context forwards canonical lifecycle turn id to skills", async () => {
  let seen: Parameters<NonNullable<ConstructorParameters<typeof RuntimeContextBuilder>[1]["skillContext"]>>[0] | undefined;
  const db = { query: async () => ({ rows: [{ user_id:"1",telegram_id:"2",language_code:"ru",language_mode:"fixed",preferred_language:"ru",last_message_language:"ru",timezone:"UTC",city:null,country_code:null,agent_id:"a",conversation_id:"c",purpose:"chat",response_mode:"text",use_emoji:false,communication_style:null,profile_field_key:null,profile_title:null,profile_prompt_hint:null,profile_status:null,active_goal_title:null,next_result_title:null,next_action:null,llm_quality_mode:"auto" }] }) };
  const builder = new RuntimeContextBuilder(db as never, { defaultTimezone:"UTC", profileCompletionEnabled:false, vectorGoalsEnabled:false, skillContext: async input => { seen=input; return ["core_index:", "01 safety | safe | always | v2"]; } });
  const context = await builder.build({ userId:1, conversationId:"c", userMessage:"hello", turnId:"canonical-turn" });
  assert.equal(seen?.turnId, "canonical-turn");
  const routedInput = seen as Record<string, unknown> | undefined;
  assert.equal(Object.hasOwn(routedInput ?? {}, "topicKey"), false);
  assert.equal(routedInput?.scenarioComplete, undefined);
  assert.match(builder.wrapUserMessage(context,"hello"), /core_index:\n01 safety \| safe \| always \| v2/);
});

test("production startup has filesystem publication sync and no synthetic turn id", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /FilesystemSkillIndexer/);
  assert.match(source, /await syncSkills\(\)/);
  assert.match(source, /turnId/);
  assert.doesNotMatch(source, /conversationId}:\$\{Date\.now\(\)}/);
});

test("Docker has one canonical project .skills and Letta uses project source", async () => {
  const dockerUrl=new URL("../Dockerfile", import.meta.url);
  try { await import("node:fs/promises").then(fs=>fs.access(dockerUrl)); } catch { return; }
  const docker = await readFile(dockerUrl, "utf8");
  const letta = await readFile(new URL("../src/letta.ts", import.meta.url), "utf8");
  assert.equal((docker.match(/COPY \.skills \.\/\.skills/g) ?? []).length, 1);
  assert.match(letta, /skillSources:\s*\["project"\]/);
});

test("model-shaped completion is rejected; canonical lifecycle API remains server-only", async () => {
  const seen:any[]=[];
  const db = { query: async () => ({ rows: [] }) };
  const builder = new RuntimeContextBuilder(db as never,{defaultTimezone:"UTC",skillContext:async input=>{seen.push(input);return[]}});
  await builder.completeSkillScenario({userId:1,conversationId:"c",purpose:"chat",turnId:"canonical-run"});
  assert.deepEqual(seen,[{userId:1,conversationId:"c",purpose:"chat",message:"",turnId:"canonical-run",scenarioComplete:true}]);
  assert.equal("completeSkillScenarioOnMarker" in builder,false);
});

test("compose shares validated runtime volume at exact SDK cwd and excludes raw bind",async()=>{
 const composeUrl=new URL("../../compose.yaml",import.meta.url);
 try { await import("node:fs/promises").then(fs=>fs.access(composeUrl)); } catch { return; }
 const compose=await readFile(composeUrl,"utf8");
 assert.match(compose,/skill-indexer:[\s\S]*validated_skills:\/data\/letta\/\.skills/);
 assert.match(compose,/letta-app-server:[\s\S]*validated_skills:\/data\/letta\/\.skills:ro/);
 assert.match(compose,/eva-agent-service:[\s\S]*validated_skills:\/data\/letta\/\.skills/);
 assert.match(compose,/letta-app-server:[\s\S]*skill-indexer:[\s\S]*condition: service_completed_successfully/);
 assert.doesNotMatch(compose,/\.\/eva-agent-service\/\.skills:\/data\/letta\/\.skills/);
});
