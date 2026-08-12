import assert from "node:assert/strict";
import test from "node:test";
import { CoreSkillCatalog, SkillRouter } from "../dist/skills/index.js";

test("malformed mandatory core falls back to immutable safe baseline without throwing", async () => {
  const core = new CoreSkillCatalog({ publishedSkills: async () => [] }, { enabled: true });
  const loaded = await core.load("production", "1");
  assert.equal(loaded.featureEnabled, false);
  assert.match(loaded.index, /immutable-safe-baseline/);
  assert.deepEqual(loaded.versionIds, []);
});

test("active sticky skill wins for an exact acknowledgement without catalogue search", async () => {
  const skill = { id:"guided",text:"guide",versionId:1,version:1,checksum:"x",purpose:"chat",applicability:"topic",order:1,safety:false,tenantId:null,triggers:[],role:"primary" as const,category:"routable" as const };
  let searched = 0;
  const repo = { loadState:async()=>({skill,purpose:"chat",topicKey:"chat",scenarioActive:true,turns:1,expiresAt:Date.now()+60_000}),saveState:async()=>{},clearState:async()=>{},publishedSkills:async()=>{searched++;return[]},hybridSearch:async()=>{searched++;return[]},recordEvent:async()=>{} };
  const routed = await new SkillRouter(repo,{enabled:true}).route({tenantId:1,conversationId:"c",purpose:"chat",topicKey:"chat",scenarioComplete:false,message:"да"});
  assert.equal(routed.reason,"active"); assert.equal(routed.selected[0]?.id,"guided"); assert.equal(searched,0);
});
const body=(id:string,order:number,extra={})=>({name:id,source:`instruction ${id}`,purpose:`purpose ${id}`,applicability:"always",order,category:"core",role:"primary",...extra});
test("core index is deterministic, safety first, budgeted, and corrupt entries degrade",async()=>{const errors:string[]=[];const registry={publishedSkills:async()=>[{slug:"goal",versionId:2,version:1,checksum:"",body:body("goal",40)},{slug:"unsafe",versionId:3,version:1,checksum:"",body:{name:"unsafe",source:"x",order:2,tools:["shell"]}},{slug:"safety",versionId:1,version:2,checksum:"",body:body("safety",10,{safety:true,role:"auxiliary"})}]};const catalog=new CoreSkillCatalog(registry as never,{enabled:true,onError:(e:{code:string})=>errors.push(e.code)});const loaded=await catalog.load("production","u1");assert.deepEqual(loaded.skills.map(x=>x.id),["safety","goal"]);assert.match(loaded.index,/01 safety.*02 goal/s);assert.ok(loaded.characters<=12000);assert.deepEqual(loaded.versionIds,[1,2]);});
test("router handles 300+ tenant candidates, sticky continuation, safety and fallback without raw text",async()=>{const rows=Array.from({length:305},(_,i)=>({slug:`s${i}`,versionId:i+1,version:1,checksum:"",ownerId:i===7?42:null,body:{...body(`s${i}`,50,{category:"routable",triggers:[`topic${i}`]}),role:i===7||i%3===0?"primary":"auxiliary"}}));const logs:any[]=[];let state:any=null;const repo={publishedSkills:async()=>rows,loadState:async()=>state,saveState:async(_u:number,_c:string,s:any)=>{state=s},clearState:async()=>{state=null},hybridSearch:async()=>rows.slice(7,17),recordEvent:async(e:any)=>logs.push(e)};const router=new SkillRouter(repo as never,{enabled:true});const first=await router.route({tenantId:42,conversationId:"c",purpose:"chat",message:"topic7"});assert.equal(first.selected[0]?.id,"s7");assert.ok(first.selected.length<=3);const second=await router.route({tenantId:42,conversationId:"c",purpose:"chat",message:"да"});assert.equal(second.sticky,true);assert.ok(!JSON.stringify(logs).includes("topic7"));const fallbackRepo={...repo,publishedSkills:async()=>{throw Error("down")},loadState:async()=>null};const fallback=new SkillRouter(fallbackRepo as never,{enabled:true});assert.equal((await fallback.route({tenantId:42,conversationId:"x",purpose:"chat",message:"anything"})).fallback,true);});
