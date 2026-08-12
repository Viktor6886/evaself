import assert from "node:assert/strict";
import pg from "../../eva-agent-service/node_modules/pg/lib/index.js";
import { ArtifactRegistry } from "../../eva-agent-service/dist/artifacts/registry.js";
import { PostgresSkillRepository } from "../../eva-agent-service/dist/skills/index.js";
import { EffectJournal, effectKey } from "../../eva-agent-service/dist/turns/effect-journal.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const registry = new ArtifactRegistry({
  query: (sql, values) => pool.query(sql, values),
  transactionClient: () => pool.connect(),
});
const body = (name, source = "focus breathing") => ({ name, source, purpose: "chat", applicability: "focus", order: 1, category: "routable", role: "primary", safety: false, triggers: ["focus"] });
const user = async (telegramId) => Number((await pool.query("INSERT INTO users(telegram_id,first_name) VALUES($1,'CI') ON CONFLICT(telegram_id) DO UPDATE SET first_name=EXCLUDED.first_name RETURNING id", [telegramId])).rows[0].id);
try {
  const u1 = await user(-90470001), u2 = await user(-90470002);
  for (const [u, c] of [[u1,"ci-skill-1"],[u2,"ci-skill-2"]]) await pool.query("INSERT INTO agent_conversations(user_id,agent_id,conversation_id) VALUES($1,$2,$3) ON CONFLICT(conversation_id) DO NOTHING", [u,`agent-${u}`,c]);

  // Concurrent canonical publication/projection is idempotent.
  const versionsBefore = Number((await pool.query("SELECT count(*) n FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.slug='ci-focus'")).rows[0].n);
  await Promise.all(Array.from({length: 8}, () => registry.syncIndexedSkill({ slug: "ci-focus", environment: "production", body: body("ci-focus"), status: "active" })));
  assert.equal(Number((await pool.query("SELECT count(*) n FROM skill_search_index WHERE slug='ci-focus' AND environment='production' AND status='active'")).rows[0].n), 1);
  const versionsAfter = Number((await pool.query("SELECT count(*) n FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.slug='ci-focus'")).rows[0].n);
  assert.ok(versionsAfter === versionsBefore || versionsAfter === versionsBefore + 1);
  const oldChecksum=(await pool.query("SELECT checksum FROM skill_search_index WHERE slug='ci-focus' AND status='active'")).rows[0].checksum;
  await Promise.all([
    registry.syncIndexedSkill({ slug: "ci-focus", environment: "production", body: body("ci-focus","changed checksum generation-a"), status: "active" }),
    registry.syncIndexedSkill({ slug: "ci-focus", environment: "production", body: body("ci-focus","changed checksum uniquephrase generation-b"), status: "active" }),
  ]);
  const current=await pool.query("SELECT checksum,body FROM skill_search_index WHERE slug='ci-focus' AND environment='production' AND status='active'");
  assert.equal(current.rowCount,1); assert.notEqual(current.rows[0].checksum,oldChecksum);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM artifact_publications p JOIN artifacts a ON a.id=p.artifact_id WHERE a.slug='ci-focus' AND p.environment='production' AND p.retired_at IS NULL")).rows[0].n),1);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM skill_search_index WHERE slug='ci-focus' AND environment='production'")).rows[0].n),1);
  const generations=await pool.query("SELECT version FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.slug='ci-focus' ORDER BY version");
  assert.deepEqual(generations.rows.map(x=>Number(x.version)),generations.rows.map((_,i)=>i+1));
  const winnerPhrase=String(current.rows[0].body.source).split(/\s+/).at(-1);
  assert.equal((await new PostgresSkillRepository(pool).hybridSearch({tenantId:u1,environment:"production",query:winnerPhrase,limit:10})).filter(x=>x.slug==="ci-focus").length,1);
  await registry.syncIndexedSkill({ slug: "ci-focus", environment: "production", status: "disabled", error: "metadata_invalid" });
  assert.deepEqual((await pool.query("SELECT status,error_code FROM skill_search_index WHERE slug='ci-focus' AND environment='production'")).rows[0], {status:"disabled",error_code:"metadata_invalid"});
  await registry.syncIndexedSkill({ slug: "ci-focus", environment: "production", body: body("ci-focus"), status: "active" });
  await registry.syncIndexedSkill({ slug: "ci-canary", environment: "canary", body: body("ci-canary","canary only"), status: "active" });

  const repo = new PostgresSkillRepository(pool);
  assert.equal((await repo.hybridSearch({tenantId:u1,environment:"production",query:"focus",limit:10}))[0].slug, "ci-focus");
  assert.equal((await repo.hybridSearch({tenantId:u1,environment:"production",query:"canary",limit:10})).some(x=>x.slug==="ci-canary"), false);
  const vector = Array(1536).fill(0); vector[0]=1;
  await pool.query("UPDATE skill_search_index SET embedding=$1::vector WHERE slug='ci-focus'", [`[${vector.join(",")}]`]);
  assert.equal((await repo.hybridSearch({tenantId:u1,environment:"production",query:"focus",vector,limit:10}))[0].slug, "ci-focus");

  // Tenant-owned projection cannot leak through either search branch.
  const versionId = Number((await pool.query("SELECT version_id FROM skill_search_index WHERE slug='ci-focus'")).rows[0].version_id);
  await pool.query("UPDATE skill_search_index SET owner_user_id=$1 WHERE version_id=$2", [u1,versionId]);
  assert.equal((await repo.hybridSearch({tenantId:u2,environment:"production",query:"focus",limit:10})).length, 0);
  await pool.query("UPDATE skill_search_index SET owner_user_id=NULL WHERE version_id=$1", [versionId]);

  const skill = (await repo.hybridSearch({tenantId:u1,environment:"production",query:"focus",limit:10}))[0];
  const state = { skill: { id:skill.slug,text:body("ci-focus").source,versionId,version:skill.version,checksum:skill.checksum,purpose:"chat",applicability:"focus",order:1,safety:false,tenantId:null,triggers:["focus"],role:"primary",category:"routable" }, topicFingerprint:"topic",scenarioState:"active",turns:1,expiresAt:Date.now()+60000 };
  await repo.saveState(u1,"ci-skill-1",state); await repo.saveState(u1,"ci-skill-1",{...state,turns:2});
  const restarted = new PostgresSkillRepository(pool); assert.equal((await restarted.loadState(u1,"ci-skill-1")).turns,2);

  // Successful terminal gateway effect is the sole durable authority to clear sticky state.
  const completionRun="33333333-3333-3333-3333-333333333333", completionCall="completion-call";
  await pool.query("INSERT INTO turn_runs(run_id,idempotency_key,user_id,conversation_id,purpose) VALUES($1,$2,$3,$4,'chat') ON CONFLICT(run_id) DO UPDATE SET user_id=EXCLUDED.user_id,conversation_id=EXCLUDED.conversation_id",[completionRun,"ci-completion",u1,"ci-skill-1"]);
  const scoped={query:(sql,values)=>pool.query(sql,values),withUserScope:(_scope,fn)=>fn(),withSystemScope:(_label,fn)=>fn()};
  const effects=new EffectJournal(scoped,{warn(){}},true,true);
  const key=effectKey(completionRun,completionCall,"skill_scenario_complete");
  await effects.begin({key,runId:completionRun,userId:u1,toolName:"skill_scenario_complete",toolCallId:completionCall});
  assert.equal(await effects.consumeSuccessfulCompletion({runId:completionRun,userId:u1,conversationId:"ci-skill-1",toolCallId:completionCall}),false); // running denied
  await effects.fail(key,u1,"test_failure",false);
  assert.equal(await effects.consumeSuccessfulCompletion({runId:completionRun,userId:u1,conversationId:"ci-skill-1",toolCallId:completionCall}),false); // failed denied
  assert.notEqual(await restarted.loadState(u1,"ci-skill-1"),null);
  await pool.query("UPDATE tool_effects SET status='succeeded',result='{" + "\"ok\":true" + "}'::jsonb WHERE effect_key=$1",[key]);
  assert.equal(await effects.consumeSuccessfulCompletion({runId:completionRun,userId:u2,conversationId:"ci-skill-1",toolCallId:completionCall}),false); // owner mismatch
  assert.equal(await effects.consumeSuccessfulCompletion({runId:completionRun,userId:u1,conversationId:"ci-skill-2",toolCallId:completionCall}),false); // conversation mismatch
  assert.notEqual(await restarted.loadState(u1,"ci-skill-1"),null);
  const afterRestart=new EffectJournal(scoped,{warn(){}},true,true);
  assert.equal((await afterRestart.pendingSuccessfulCompletions()).some(x=>x.runId===completionRun&&x.toolCallId===completionCall),true);
  assert.equal(await afterRestart.consumeSuccessfulCompletion({runId:completionRun,userId:u1,conversationId:"ci-skill-1",toolCallId:completionCall}),true);
  assert.equal(await restarted.loadState(u1,"ci-skill-1"),null);
  assert.equal(await effects.consumeSuccessfulCompletion({runId:completionRun,userId:u1,conversationId:"ci-skill-1",toolCallId:completionCall}),false); // duplicate idempotent

  await repo.recordEvent({userId:u1,conversationId:"ci-skill-1",selected:[{id:"ci-focus",version_id:versionId,version:1,score:.9}],reason:"hybrid",sticky:false,fallback:false,reranked:true,latencyMs:12});
  const event = (await pool.query("SELECT selected,reason_code,sticky,fallback,reranker_called,latency_ms FROM skill_routing_events WHERE user_id=$1 ORDER BY id DESC LIMIT 1",[u1])).rows[0];
  assert.equal(JSON.stringify(event).includes("focus breathing"),false); assert.equal(JSON.stringify(event).includes("ci-skill-1"),false);
  const runId="22222222-2222-2222-2222-222222222222"; await repo.recordUsage(runId,[versionId,versionId]); await repo.recordUsage(runId,[versionId]);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM artifact_usages WHERE run_kind='turn' AND run_id=$1",[runId])).rows[0].n),1);
  console.log("skills PostgreSQL integration: publication/projection, invalid state, FTS/trigram/vector, tenant/environment, sticky restart, privacy, runId and concurrency PASS");
} finally {
  await pool.query("DELETE FROM users WHERE telegram_id IN (-90470001,-90470002)");
  await pool.end();
}
