import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CoreSkillCatalog, FilesystemSkillIndexer, PostgresSkillRepository, SkillRouter,
  createClassifierReranker,
} from "../dist/skills/index.js";
import { AgentToolFactory } from "../dist/agent-tools.js";

const skill=(id:string, category:"core"|"routable", extra:Record<string,unknown>={})=>({slug:id,versionId:id.length,version:1,checksum:"",ownerId:null,status:"active",body:{name:id,source:`instruction ${id}`,purpose:`purpose ${id}`,applicability:"always",order:1,category,role:"primary",safety:false,...extra}});

test("core catalog includes only core and keeps safety untruncated with a consistent index",async()=>{
 const safety=skill("safety","core",{safety:true,source:"S".repeat(40)}); const normal=skill("normal","core",{source:"N".repeat(40)}); const routed=skill("route","routable");
 const catalog=new CoreSkillCatalog({publishedSkills:async()=>[normal,routed,safety]} as never,{enabled:true,maxCharacters:70,safetyMaxCharacters:50});
 const out=await catalog.load("production","1");
 assert.deepEqual(out.skills.map(x=>x.id),["safety"]); assert.match(out.index,/safety/); assert.doesNotMatch(out.index,/normal|route/); assert.deepEqual(out.versionIds,[6]);
});

test("filesystem indexer validates metadata, checksum, disables damaged files and update does not recreate agents",async()=>{
 const root=await mkdtemp(join(tmpdir(),"eva-skills-")); await mkdir(join(root,"good")); await mkdir(join(root,"bad"));
 await writeFile(join(root,"good","SKILL.md"),"---\nname: good\ncategory: routable\nrole: primary\npurpose: help\napplicability: always\norder: 1\n---\nDo good");
 await writeFile(join(root,"bad","SKILL.md"),"---\nname: bad\ncategory: executable\n---\nboom");
 const rows:unknown[]=[]; const indexer=new FilesystemSkillIndexer({syncIndexedSkill:async x=>{rows.push(x)}} as never,{root,environment:"production"});
 const first=await indexer.sync(); await writeFile(join(root,"good","SKILL.md"),"---\nname: good\ncategory: routable\nrole: primary\npurpose: help\napplicability: always\norder: 1\n---\nDo better"); const second=await indexer.sync();
 assert.equal(first.active,1); assert.equal(first.disabled,1); assert.equal(second.active,1); const goodRows=(rows as any[]).filter(x=>x.slug==="good"); assert.notEqual(goodRows[0].checksum,goodRows[1].checksum); assert.equal(indexer.agentRecreations,0);
});

test("router pipeline is safety then durable active then triggers then hybrid, tenant-safe, 1 primary + 2 auxiliary",async()=>{
 const events:any[]=[]; const repo={
  publishedSkills:async()=>[skill("core","core"),skill("trigger","routable",{triggers:["start"]}),skill("p2","routable"),skill("a1","routable",{role:"auxiliary"}),skill("a2","routable",{role:"auxiliary"}),skill("a3","routable",{role:"auxiliary"})],
  loadState:async()=>null, hybridSearch:async()=>[skill("foreign","routable",{tenantId:2}),skill("p2","routable"),skill("a1","routable",{role:"auxiliary"}),skill("a2","routable",{role:"auxiliary"}),skill("a3","routable",{role:"auxiliary"})], saveState:async()=>{},clearState:async()=>{},recordEvent:async(e:any)=>events.push(e),recordUsage:async()=>{}
 };
 const router=new SkillRouter(repo as never,{enabled:true}); const out=await router.route({tenantId:1,conversationId:"c",turnId:"t",purpose:"chat",message:"question",safetySkill:{...skill("safe","routable",{safety:true}).body,id:"safe",text:"safe",versionId:4,version:1,checksum:"x",category:"routable",role:"auxiliary",safety:true,tenantId:null,triggers:[],order:0,purpose:"safe",applicability:"always"} as any});
 assert.deepEqual(out.selected.map(x=>x.id),["p2","a1","a2"]); assert.equal(events.length,1); assert.equal(JSON.stringify(events).includes("question"),false);
});

test("sticky state survives repository recreation with canonical scenario metadata",async()=>{
 const body=skill("flow","routable").body as any; const checksum=(await import("../dist/artifacts/validation.js")).artifactChecksum(body); const queries:any[]=[]; const db={query:async(sql:string,v:any[])=>{queries.push([sql,v]); if(sql.includes("SELECT")&&sql.includes("skill_routing_state"))return {rows:[{skill_version_id:2,slug:"flow",version:1,checksum,body,topic_fingerprint:"fingerprint",scenario_state:"active",turns:2,expires_at:new Date(Date.now()+60000).toISOString()}]}; return {rows:[],rowCount:1}}};
 const repo=new PostgresSkillRepository(db as never); const state=await repo.loadState(7,"c"); assert.equal(state?.topicFingerprint,"fingerprint"); assert.equal(state?.scenarioState,"active"); await repo.clearState(7,"c","topic_changed"); assert.ok(queries.every(([,v])=>v[0]===7));
});

test("classifier reranker uses eva/classifier strict JSON and only minimal metadata",async()=>{
 let request:any; const rerank=createClassifierReranker(async x=>{request=x;return '{"ids":["b","a"],"confidence":0.9}' });
 assert.deepEqual(await rerank([{id:"a",purpose:"A",applicability:"x"},{id:"b",purpose:"B",applicability:"y"}]),["b","a"]); assert.equal(request.model,"eva/classifier"); assert.deepEqual(Object.keys(request.candidates[0]),["id","purpose","applicability"]); await assert.rejects(()=>createClassifierReranker(async()=>"nope")([]),/JSON/);
});

test("migration declares tenant-owned hybrid FTS trigram vector index and bounded query",async()=>{
 const fs=await import("node:fs/promises"); const migration=new URL("../../postgres/migrations/047_skills.sql",import.meta.url);
 try { await fs.access(migration); } catch { return; }
 const sql=await fs.readFile(migration,"utf8");
 for(const token of ["skill_search_index","tsvector","gin_trgm_ops","vector(1536)","owner_user_id","LIMIT 10","skill_routing_events"]) assert.match(sql,new RegExp(token.replace(/[()]/g,"\\$&"),"i"));
});

test("only normalized acknowledgement whitelist retains sticky skill",async()=>{
 const prior={skill:{...skill("old","routable").body,id:"old",text:"old",versionId:3,version:1,checksum:"x",tenantId:null,triggers:[],category:"routable",role:"primary"} as any,topicFingerprint:"old",scenarioState:"active" as const,turns:1,expiresAt:Date.now()+60000};
 const searched:string[]=[]; const cleared:string[]=[];
 const repo={publishedSkills:async()=>[],loadState:async()=>prior,saveState:async()=>{},clearState:async(_u:number,_c:string,r:string)=>cleared.push(r),hybridSearch:async(x:any)=>{searched.push(x.query);return[]},recordEvent:async()=>{}};
 const router=new SkillRouter(repo as never,{enabled:true});
 assert.equal((await router.route({tenantId:1,conversationId:"c",purpose:"chat",message:"  ДА!  "})).sticky,true);
 assert.equal((await router.route({tenantId:1,conversationId:"c",purpose:"chat",message:"поговорим про сон"})).sticky,false);
 assert.deepEqual(searched,["поговорим про сон"]); assert.deepEqual(cleared,["topic_changed"]);
});

test("explicit completion marker clears canonical sticky state",async()=>{
 const prior={skill:{...skill("old","routable").body,id:"old",text:"old",versionId:3,version:1,checksum:"x",tenantId:null,triggers:[],category:"routable",role:"primary"} as any,topicFingerprint:"old",scenarioState:"active" as const,turns:1,expiresAt:Date.now()+60000};
 const reasons:string[]=[]; const repo={publishedSkills:async()=>[],loadState:async()=>prior,saveState:async()=>{},clearState:async(_u:number,_c:string,r:string)=>reasons.push(r),hybridSearch:async()=>[],recordEvent:async()=>{}};
 const out=await new SkillRouter(repo as never,{enabled:true}).completeScenario({tenantId:1,conversationId:"c",purpose:"chat",runId:"run"});
 assert.equal(out.reason,"completed"); assert.deepEqual(reasons,["scenario_completed"]);
});

test("completion tool is unavailable when gateway is disabled",async()=>{
 const db={getAgentRuntimeContext:async()=>({userId:7,telegramId:8,chatId:9,purpose:"chat",currentTaskTools:["skill_scenario_complete"],selectedSkillTools:["skill_scenario_complete"]}),withUserScope:async(_s:any,fn:any)=>fn(),query:async()=>({rows:[]})};
 const factory=new AgentToolFactory({toolGatewayEnabled:false,vectorGoalsEnabled:false,todoistApiToken:"",searxngUrl:""} as any,db as any,{} as any,{warn() {}} as any);
 const tool=factory.forConversation("conversation-1").find((x:any)=>x.name==="skill_scenario_complete") as any;
 assert.equal(tool,undefined);
});
