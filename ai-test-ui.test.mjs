import test from 'node:test';
import assert from 'node:assert/strict';
import { APITestController } from './ai-test-ui.mjs';
const payload=()=>({target:{timeout_seconds:1},credential:{source:'new',key:'synthetic-only'}});
const success={ok:true,reply:'OK',phase:'completed',reply_complete:true,expected_reply_matched:true};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
for(const code of ['invalid_ai_settings','authorization_required','rate_limit_exceeded','network_connection_refused','local_request_failed'])test('failure always ends running state: '+code,async()=>{
  const states=[],calls=[];const ui=new APITestController({refresh:async()=>{},post:async(...args)=>{calls.push(args);throw Object.assign(new Error('secret vendor text must not render'),{code,field:'api_model'});},render:s=>states.push(s)});
  const p=payload();await ui.start(p);assert.equal(calls.length,1);assert.equal(ui.active,null);assert.equal(states.at(-1).busy,false);assert.equal(states.at(-1).status,'failed');assert.equal(states.at(-1).error_code,code);assert.doesNotMatch(JSON.stringify(states),/secret vendor text|synthetic-only/);assert.equal(p.credential.key,'');
});
test('HTTP 400/403/429 structured test results are final failures, not success or automatic retry',async()=>{
  for(const status of [400,403,429]){const calls=[],states=[];const ui=new APITestController({post:async(...args)=>{calls.push(args);return{ok:false,http_status:status,error_code:'upstream_error',phase:'http_response'};},render:s=>states.push(s)});await ui.start(payload());assert.equal(calls.length,1);assert.equal(states.at(-1).status,'failed');assert.equal(states.at(-1).result.http_status,status);}
});
test('completed result appears before a stalled refresh and refresh has its own deadline',async()=>{
  const states=[],gate=deferred();let refreshSignal;const ui=new APITestController({post:async()=>success,refresh:signal=>{refreshSignal=signal;return gate.promise;},refreshMs:15,render:s=>states.push(s)});
  await ui.start(payload());assert.equal(states.at(-1).status,'completed');assert.equal(ui.active,null);await new Promise(r=>setTimeout(r,25));assert.equal(refreshSignal.aborted,true);gate.resolve();
});
test('double clicks cannot submit two requests; observed phase/elapsed is independent of refresh',async()=>{
  const gate=deferred(),states=[];let calls=0,now=100;const ui=new APITestController({post:async()=>{calls++;return gate.promise;},now:()=>now,render:s=>states.push(s)});
  const pending=ui.start(payload());const id=ui.active.id;assert.deepEqual(await ui.start(payload()),{busy:true});now=900;ui.observe(id,'http_request');assert.equal(states.at(-1).elapsed_ms,800);assert.equal(states.at(-1).phase,'http_request');assert.equal(calls,1);gate.resolve(success);await pending;
});
test('cancel stops waiting, requests backend cancellation once and ignores late old results after a new test',async()=>{
  const gate=deferred(),states=[],calls=[];let first=true;const ui=new APITestController({post:async(path,body)=>{calls.push({path,body});if(path==='cancel-test')return{cancel_requested:true};if(first){first=false;return gate.promise;}return success;},render:s=>states.push(s)});
  const p=payload(),old=ui.start(p);await ui.cancel();await old;assert.equal(states.at(-1).status,'cancelled');assert.equal(states.at(-1).upstream_cancel_confirmed,false);await ui.start(payload());const final=states.at(-1);gate.resolve({ok:false,phase:'http_response'});await Promise.resolve();assert.equal(states.at(-1),final);assert.equal(calls.filter(c=>c.path==='test-api').length,2);assert.equal(calls.filter(c=>c.path==='cancel-test').length,1);
});
test('local deadline ends a post that ignores abort and never repeats the upstream test',async()=>{
  const states=[],calls=[];const ui=new APITestController({graceMs:-990,post:async(path)=>{calls.push(path);if(path==='cancel-test')return{cancel_requested:true};return new Promise(()=>{});},render:s=>states.push(s)});
  await ui.start(payload());assert.equal(states.at(-1).error_code,'local_test_deadline');assert.equal(states.at(-1).busy,false);assert.equal(calls.filter(c=>c==='test-api').length,1);assert.equal(calls.filter(c=>c==='cancel-test').length,1);
});
test('invalid/null local response cannot leave the test in progress',async()=>{
  for(const value of [null,{},'synthetic']){const states=[];const ui=new APITestController({post:async()=>value,render:s=>states.push(s)});await ui.start(payload());assert.equal(states.at(-1).error_code,'invalid_test_result');assert.equal(states.at(-1).busy,false);}
});
