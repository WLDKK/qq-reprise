import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AIDiagnostics} from './ai-diagnostics.mjs';
import {AIChat} from './ai-chat.mjs';
import {AI_DEFAULTS} from './ai-config.mjs';
import {MemorySecrets} from './ai-storage.mjs';
import {ResendQueue} from './send-queue.mjs';

const START=Date.UTC(2030,0,2,3,0);
async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'ai-observation-synthetic-'));
  const clock={value:START},d=new AIDiagnostics(dir,()=>clock.value);
  await d.initialize();
  t.after(async()=>{await d.file.task;await rm(dir,{recursive:true,force:true});});
  return {d,dir,clock};
}
async function finish(f,patch={},kind='generation'){
  f.clock.value+=1000;
  const id=f.d.begin(kind,AI_DEFAULTS,kind==='generation'?'group':null);
  f.clock.value+=25;
  await f.d.finish(kind,id,{status:'failed',phase:'http_response',httpStatus:429,errorCode:'rate_limit_exceeded',rateLimitKind:'temporary',...patch});
  return id;
}
function observation(d){const result=d.state().upstream_observation;assert.ok(result,'retain a separate historical upstream observation');return result;}
const success={status:'completed',phase:'completed',httpStatus:200,errorCode:'',rateLimitKind:null,finishReason:'stop',outputChars:2};

test('no provider observation is not evidence of availability',async t=>{
  const f=await setup(t),o=observation(f.d);
  assert.equal(o.latest,null);assert.equal(o.last_failure,null);assert.equal(o.last_complete,null);
  assert.equal(o.availability,'not_established');assert.equal(o.configuration_match,'not_recorded');
});

test('cooldown ends without a new request and keeps the last 429 visible',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-cooldown-observation-synthetic-'));
  let now=START,calls=0;
  const ai=new AIChat({dir,now:()=>now,secrets:new MemorySecrets(),poolSecrets:new MemorySecrets(),
    app:{connected:true,onlineConfirmed:true,selfId:'90001',preferences:{auto_resend:false},sendQueue:new ResendQueue({intervalMs:0,jitterMs:0}),client:{call(){assert.fail('No QQ calls');}}},
    fetcher:async()=>{calls++;assert.fail('No provider request when cooldown expires');},imageFetcher:async()=>assert.fail('No image download')});
  await ai.initialize();clearInterval(ai.maintenance);
  t.after(async()=>{ai.dispose();await ai.budgetTask;await ai.diagnostics.file.task;await ai.settingsFile.task;await ai.auth.metaFile.task;await rm(dir,{recursive:true,force:true});});
  ai.config={...ai.config,enabled:true};
  const id=ai.diagnostics.begin('generation',ai.config,'group');
  await ai.diagnostics.finish('generation',id,{status:'failed',phase:'http_response',httpStatus:429,errorCode:'rate_limit_exceeded',rateLimitKind:'temporary'});
  ai.error='rate_limit_exceeded';
  ai.pauseForUpstream({status:429,code:'rate_limit_exceeded',rateLimitKind:'temporary',retryAfterSeconds:null});
  assert.equal(ai.blocked,true);
  now=ai.rateLimitRecovery.until+1;
  ai.prune();
  const state=ai.state();
  assert.equal(state.paused,false);assert.equal(state.error,'');assert.equal(calls,0);
  assert.equal(state.diagnostics.upstream_observation.latest.outcome,'request_failed');
  assert.equal(state.diagnostics.upstream_observation.last_failure.http_status,429);
  assert.equal(state.diagnostics.upstream_observation.availability,'not_established');
});

test('queued and pause-rejected tasks do not hide the previous provider failure',async t=>{
  const f=await setup(t);await finish(f);
  f.clock.value+=1000;const id=f.d.begin('generation',AI_DEFAULTS,'group');
  await f.d.finish('generation',id,{status:'rejected',phase:'queue',errorCode:'ai_backend_paused'});
  assert.equal(observation(f.d).latest.http_status,429);
});

test('a newer completed response updates latest while retaining the older failure',async t=>{
  const f=await setup(t);await finish(f);await finish(f,success);
  const o=observation(f.d);assert.equal(o.latest.outcome,'response_completed');
  assert.equal(o.last_failure.http_status,429);assert.equal(o.last_complete.http_status,200);
  assert.ok(o.last_complete.finished_at>o.last_failure.finished_at);
});

test('a successful interface probe is labeled as a test and does not establish QQ delivery or current target identity',async t=>{
  const f=await setup(t);await finish(f);await finish(f,success,'test');
  const o=observation(f.d);assert.equal(o.latest.source,'test');assert.equal(o.latest.outcome,'response_completed');
  assert.equal(o.latest.delivery,null);assert.equal(o.configuration_match,'not_recorded');assert.equal(o.availability,'not_established');
});

test('model completion remains distinct from a QQ delivery failure',async t=>{
  const f=await setup(t);await finish(f);await finish(f,{...success,status:'failed',errorCode:'qq_delivery_uncertain',delivery:'uncertain',deliverySubmission:'uncertain'});
  const o=observation(f.d);assert.equal(o.latest.outcome,'response_completed');
  assert.equal(o.latest.delivery,'uncertain');assert.equal(o.last_failure.http_status,429);
});

test('HTTP 200 headers alone do not imply a complete model response',async t=>{
  const f=await setup(t);await finish(f,{status:'running',phase:'http_response',httpStatus:200,errorCode:'',rateLimitKind:null});
  const o=observation(f.d);assert.equal(o.latest.outcome,'request_pending');assert.equal(o.last_complete,null);
});

test('a 200 stream interrupted before a terminal response stays incomplete',async t=>{
  const f=await setup(t);await finish(f,{httpStatus:200,errorCode:'stream_interrupted',rateLimitKind:null,outputChars:4});
  const o=observation(f.d);assert.equal(o.latest.outcome,'response_incomplete');
  assert.equal(o.last_complete,null);assert.equal(o.last_failure.error_code,'stream_interrupted');
});

test('cancelling an unfinished request does not invent a provider failure or complete response',async t=>{
  const f=await setup(t);await finish(f,{status:'cancelled',httpStatus:200,errorCode:'cancelled',rateLimitKind:null});
  const o=observation(f.d);assert.equal(o.latest.outcome,'request_cancelled');assert.equal(o.last_failure,null);assert.equal(o.last_complete,null);
});

test('network timeout is observable without inventing an HTTP status',async t=>{
  const f=await setup(t);await finish(f,{phase:'http_request',httpStatus:null,errorCode:'network_timeout',rateLimitKind:null});
  const o=observation(f.d);assert.equal(o.latest.outcome,'request_failed');assert.equal(o.latest.http_status,null);
});

test('local image download errors are not classified as provider HTTP failures',async t=>{
  const f=await setup(t);await finish(f,{phase:'image_download',httpStatus:null,imageHTTPStatus:403,errorCode:'vision_image_download_failed',rateLimitKind:null});
  assert.equal(observation(f.d).latest,null);
});

test('local credential rejection does not overwrite retained provider evidence',async t=>{
  const f=await setup(t);await finish(f);await finish(f,{phase:'credentials',httpStatus:null,errorCode:'api_key_required',rateLimitKind:null});
  assert.equal(observation(f.d).latest.http_status,429);
});

test('historical evidence survives diagnostic reload without persisting a new schema',async t=>{
  const f=await setup(t);await finish(f);const before=observation(f.d);
  const reloaded=new AIDiagnostics(f.dir,()=>f.clock.value+1000);await reloaded.initialize();
  assert.deepEqual(observation(reloaded),before);
});

test('old evidence is not asserted to match a newly edited endpoint or model',async t=>{
  const f=await setup(t);await finish(f);
  f.d.begin('test',{...AI_DEFAULTS,api_base_url:'https://synthetic-new-target.example.invalid/v1',api_model:'synthetic-new-model'});
  const o=observation(f.d);assert.equal(o.configuration_match,'not_recorded');
  assert.equal(o.availability,'not_established');assert.equal(o.latest.http_status,429);
  assert.doesNotMatch(JSON.stringify(o),/synthetic-new-target|synthetic-new-model/);
});

test('summary allows only bounded diagnostic metadata and no raw payload or credential fields',async t=>{
  const f=await setup(t);await finish(f);
  Object.assign(f.d.records.generation,{errorCode:'synthetic_private_body_code',headers:{Authorization:'Bearer SYNTHETIC_SECRET'},prompt:'SYNTHETIC_CHAT_BODY',url:'https://synthetic.example.invalid/?key=SYNTHETIC_SECRET',finishedAt:Infinity});
  const o=observation(f.d),raw=JSON.stringify(o);
  assert.doesNotMatch(raw,/SYNTHETIC_SECRET|SYNTHETIC_CHAT_BODY|synthetic_private_body|Authorization|https:/);
  assert.ok(Number.isFinite(o.latest.started_at));assert.equal(o.latest.finished_at,null);
});
