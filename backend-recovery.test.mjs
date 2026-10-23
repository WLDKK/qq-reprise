import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {AIChat} from './ai-chat.mjs';
import {AI_DEFAULTS,validateAISettings} from './ai-config.mjs';
import {MemorySecrets} from './ai-storage.mjs';
import {ResendQueue} from './send-queue.mjs';
import {apiBinding} from './ai-api-draft.mjs';
import {upstreamFailure,retryAfterSeconds} from './upstream-limit.mjs';
import {temporaryCooldown} from './rate-limit-cooldown.mjs';

const NOW=Date.UTC(2026,9,23,8,40);
const ok=()=>new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}]})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
async function setup(t,{fetcher=async()=>ok()}={}){
 const dir=await mkdtemp(join(tmpdir(),'recovery-memory-mock-'));
 const secrets=new MemorySecrets();secrets.api='synthetic-recovery-key';
 const app={connected:true,onlineConfirmed:true,selfId:'90001',preferences:{auto_resend:false},sendQueue:new ResendQueue({intervalMs:0,jitterMs:0}),client:{call(){assert.fail('No real or mock QQ sends during recovery');}},setResend(){assert.fail('Recovery must preserve independent switches');}};
 let modelCalls=0;
 const ai=new AIChat({dir,app,secrets,poolSecrets:new MemorySecrets(),now:()=>NOW,fetcher:async(...args)=>{modelCalls++;return fetcher(...args);},imageFetcher:async()=>{assert.fail('No image fetch');}});
 await ai.initialize();clearInterval(ai.maintenance);
 ai.config=validateAISettings({...structuredClone(AI_DEFAULTS),enabled:true,binding_qq:'90001',api_platform:'custom',api_base_url:'https://synthetic.example.invalid/v1',api_format:'chat_completions',api_model:'synthetic-model',api_max_output_tokens:32,timeout_seconds:5,groups:['90003'],context_ttl_minutes:0,group_cache_ttl_minutes:0});
 ai.auth.meta.api_configured=true;ai.auth.meta.api_binding=apiBinding(ai.config);ai.auth.meta.api_id='synthetic-credential-id';
 ai.blocked=true;ai.error='rate_limit_exceeded';ai.rateLimitRecoveryCount=3;
 const event={self_id:'90001',conversation_type:'group',peer_id:'90003',user_id:'90002',message_id:'91001'};
 for(let n=0;n<2;n++){
  ai.sessions.set('synthetic-session-'+n,{used:NOW,lastStarted:NOW,pending:null,turns:[{prompt:'synthetic question '+n,answer:'synthetic answer '+n}]});
  ai.groupContext.put({...event,message_id:String(91001+n)},{user_id:90002,sender:{user_id:90002,nickname:'Synthetic'},message:[{type:'text',data:{text:'synthetic nearby message '+n}}]},ai.config);
 }
 ai.privateHolds.set('90001:90009',{id:'00000000-0000-4000-8000-000000000001',selfId:'90001',peerId:'90009',reason:'credentials',count:1,firstAt:NOW,lastAt:NOW});
 const weakKey={};ai.modelReplies.set(weakKey,'synthetic retained reply');ai.inputSnapshots.set(weakKey,{synthetic:true});
 ai.seen.set('synthetic-seen',NOW+60000);ai.tombstones.set('synthetic-recalled',NOW+60000);
 const snapshot=()=>({config:structuredClone(ai.config),sessions:structuredClone([...ai.sessions]),group:structuredClone([...ai.groupContext.groups]),groupSequence:ai.groupContext.sequence,groupSalt:ai.groupContext.speakerSalt.toString('hex'),privateHolds:structuredClone([...ai.privateHolds]),seen:[...ai.seen],tombstones:[...ai.tombstones],modelReply:ai.modelReplies.get(weakKey),inputSnapshot:ai.inputSnapshots.get(weakKey),generation:ai.generation,recallSwitch:app.preferences.auto_resend});
 t.after(async()=>{ai.dispose();await ai.budgetTask.catch(()=>{});await ai.diagnostics.file.task.catch(()=>{});await ai.settingsFile.task.catch(()=>{});await ai.auth.metaFile.task.catch(()=>{});const rel=relative(tmpdir(),dir);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(dir,{recursive:true,force:true});});
 return{ai,app,snapshot,modelCalls:()=>modelCalls};
}
async function proof(f){const r=await f.ai.testAPI();assert.equal(r.ok,true);assert.equal(r.http_status,200);assert.ok(f.ai.backendProbe);return r;}

test('successful saved-config probe then resume retains both sessions, nearby context, holds, deduplication, weak references and switches',async t=>{
 const f=await setup(t);await proof(f);const before=f.snapshot();
 const state=await f.ai.resumeBackendAfterProbe();await new Promise(r=>setImmediate(r));
 assert.deepEqual(f.snapshot(),before);assert.equal(state.paused,false);assert.equal(state.error,'');assert.equal(state.enabled,true);assert.equal(state.contexts,2);assert.equal(state.group_context.messages,2);assert.equal(f.ai.rateLimitRecoveryCount,0);assert.equal(f.ai.backendProbe,null);assert.equal(f.modelCalls(),1);
 await assert.rejects(f.ai.resumeBackendAfterProbe(),/backend_probe_required/);assert.deepEqual(f.snapshot(),before);
});
test('legacy enable=true is a no-op for enabled AI and never switches recall on or resets memory',async t=>{
 const f=await setup(t);await proof(f);const before=f.snapshot();await f.ai.resumeBackendAfterProbe({enable:true});assert.deepEqual(f.snapshot(),before);assert.equal(f.app.preferences.auto_resend,false);
});
test('resume never implicitly enables AI that the user disabled',async t=>{
 const f=await setup(t);f.ai.config.enabled=false;await proof(f);const before=f.snapshot();await assert.rejects(f.ai.resumeBackendAfterProbe({enable:true}),/ai_disabled/);assert.deepEqual(f.snapshot(),before);assert.equal(f.ai.blocked,true);
});
for(const [name,change] of Object.entries({expired:f=>{f.ai.backendProbe.checkedAt=NOW-120001;},model:f=>{f.ai.backendProbe.model='different';},endpoint:f=>{f.ai.backendProbe.base='https://other.example.invalid/v1';},format:f=>{f.ai.backendProbe.format='responses';},credential:f=>{f.ai.backendProbe.credentialId='different';},generation:f=>{f.ai.backendProbe.generation++;},offline:f=>{f.app.connected=false;},qq_unconfirmed:f=>{f.app.onlineConfirmed=false;},binding:f=>{f.ai.config.binding_qq='90008';}})){
 test('invalid probe proof is rejected without state loss: '+name,async t=>{const f=await setup(t);await proof(f);change(f);const before=f.snapshot();await assert.rejects(f.ai.resumeBackendAfterProbe(),/backend_probe_required/);assert.deepEqual(f.snapshot(),before);assert.equal(f.ai.blocked,true);assert.equal(f.modelCalls(),1);});
}
for(const [name,change] of Object.entries({generating:f=>{f.ai.active=1;},queued:f=>{f.ai.queue.push({synthetic:true});},testing:f=>{f.ai.testController=new AbortController();},uncertain_delivery:f=>{f.ai.outbox.jobs.set('synthetic-unknown',{key:'synthetic-unknown',created:NOW,state:'uncertain',bytes:0,mediaBytes:0,inFlight:false});}})){
 test('busy or unknown delivery blocks resume without cancelling or replaying it: '+name,async t=>{const f=await setup(t);await proof(f);change(f);const before=f.snapshot(),pending=f.ai.outbox.jobs.size;await assert.rejects(f.ai.resumeBackendAfterProbe(),/generation_in_progress/);assert.deepEqual(f.snapshot(),before);assert.equal(f.ai.outbox.jobs.size,pending);assert.equal(f.ai.blocked,true);f.ai.active=0;f.ai.queue=[];});
}
test('missing successful proof leaves existing memory and pause intact',async t=>{const f=await setup(t);const before=f.snapshot();await assert.rejects(f.ai.resumeBackendAfterProbe(),/backend_probe_required/);assert.deepEqual(f.snapshot(),before);assert.equal(f.modelCalls(),0);});
test('a failed 429 probe cannot unlock the backend or erase context',async t=>{
 const f=await setup(t,{fetcher:async()=>new Response(JSON.stringify({error:{code:'rate_limit_exceeded'}}),{status:429,headers:{'Content-Type':'application/json'}})});const before=f.snapshot();
 await assert.rejects(f.ai.testAPI(),e=>e.testResult?.http_status===429&&e.testResult.rate_limit_kind==='temporary');assert.equal(f.ai.backendProbe,null);await assert.rejects(f.ai.resumeBackendAfterProbe(),/backend_probe_required/);assert.deepEqual(f.snapshot(),before);assert.equal(f.modelCalls(),1);
});

const response=(status,after)=>({status,headers:new Headers(after===undefined?{}:{'Retry-After':after})});
test('plain HTTP429 without authoritative error metadata remains unclassified',()=>{const e=upstreamFailure(response(429),{});assert.equal(e.rateLimitKind,'unclassified');assert.equal(e.code,'rate_limit_exceeded');assert.equal(temporaryCooldown({...e,status:429},0,NOW,0),null);});
for(const code of ['rate_limit_exceeded','too_many_requests','requests_per_minute','tokens_per_minute']){
 test('recognized temporary provider code permits bounded cooldown: '+code,()=>{const e=upstreamFailure(response(429),{error:{code}});assert.equal(e.rateLimitKind,'temporary');assert.equal(temporaryCooldown({...e,status:429},0,NOW,0).seconds,10);});
}
for(const code of ['insufficient_quota','quota_exceeded','billing_hard_limit_reached','credit_balance_exhausted']){
 test('explicit quota error remains manual even with Retry-After: '+code,()=>{const e=upstreamFailure(response(429,'1'),{error:{code}});assert.equal(e.code,'insufficient_quota');assert.equal(e.rateLimitKind,'quota');assert.equal(temporaryCooldown({...e,status:429},0,NOW,0),null);});
}
for(const [status,code]of[[401,'invalid_api_key'],[403,'access_denied'],[429,'model_not_found']]){
 test('authorization or unsupported model does not become automatic retry: '+code,()=>{const e=upstreamFailure(response(status,'1'),{error:{code}});assert.notEqual(e.rateLimitKind,'temporary');assert.equal(temporaryCooldown({...e,status},0,NOW,0),null);});
}
test('Retry-After lower bound, bounded recoveries and manual stop are retained',()=>{const e=upstreamFailure(response(429,'25'),{});assert.equal(e.rateLimitKind,'temporary');assert.deepEqual([0,1,2].map(n=>temporaryCooldown({...e,status:429},n,NOW,7).seconds),[25,25,40]);assert.equal(temporaryCooldown({...e,status:429},3,NOW,7),null);assert.equal(temporaryCooldown({...e,status:429,retryAfterSeconds:301},0,NOW,7),null);});
test('Retry-After parser accepts official date/seconds and rejects malformed values',()=>{assert.equal(retryAfterSeconds('12',NOW),12);assert.equal(retryAfterSeconds(new Date(NOW+15000).toUTCString(),NOW),15);for(const v of['-1','0.5','soon','Infinity'])assert.equal(retryAfterSeconds(v,NOW),null);});
