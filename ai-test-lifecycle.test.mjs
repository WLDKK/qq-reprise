import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIChat } from './ai-chat.mjs';
import { MemorySecrets } from './ai-storage.mjs';
import { ResendQueue } from './send-queue.mjs';
import { apiBinding } from './ai-api-draft.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const id='01234567-89ab-cdef-0123-456789abcdef';
const until=async f=>{for(let n=0;n<200;n++){if(f())return;await new Promise(r=>setTimeout(r,2));}assert.fail('Synthetic phase not reached');};
async function setup(t,fetcher) {
  const dir=await mkdtemp(join(tmpdir(),'api-test-lifecycle-')),secrets=new MemorySecrets();secrets.api='synthetic-test-only';
  const app={connected:false,onlineConfirmed:false,selfId:'',sendQueue:new ResendQueue({intervalMs:0,jitterMs:0}),client:{call:()=>assert.fail('No QQ')}};
  const ai=new AIChat({dir,app,secrets,fetcher});await ai.initialize();ai.config={...ai.config,api_model:'synthetic',timeout_seconds:0.02};ai.auth.meta.api_configured=true;ai.auth.meta.api_binding=apiBinding(ai.config);
  t.after(async()=>{ai.dispose();await ai.budgetTask.catch(()=>{});await ai.diagnostics.file.task.catch(()=>{});await rm(dir,{recursive:true,force:true});});
  return {ai,dir};
}
test('whole-test deadline includes the local budget wait; no provider call escapes after timeout',async t=>{
  let calls=0;const {ai}=await setup(t,async()=>{calls++;assert.fail('No provider call');}),gate=deferred();ai.reserveBudget=()=>gate.promise;
  await assert.rejects(ai.testAPI(),e=>e.code==='request_timeout'&&e.testResult.error_code==='request_timeout');assert.equal(ai.testController,null);assert.equal(ai.diagnostics.state().test.status,'cancelled');gate.resolve();await Promise.resolve();assert.equal(calls,0);
});
test('response wait that ignores abort cannot pin the backend test lock or publish a late result',async t=>{
  let calls=0;const gate=deferred(),{ai}=await setup(t,async()=>{calls++;return gate.promise;});await assert.rejects(ai.testAPI(),/request_timeout/);const before=ai.diagnostics.state().test;
  assert.equal(ai.testController,null);gate.resolve(new Response('data: {"choices":[{"delta":{"content":"late"},"finish_reason":"stop"}]}\n\n',{headers:{'content-type':'text/event-stream'}}));await new Promise(r=>setTimeout(r,5));assert.deepEqual(ai.diagnostics.state().test,before);assert.equal(calls,1);
});
test('stream stall has a finite deadline and retains zero complete replies',async t=>{
  let cancelled=0;const {ai}=await setup(t,async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));},cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}}));
  await assert.rejects(ai.testAPI(),e=>e.testResult.reply_complete===false&&e.testResult.error_code==='request_timeout');assert.equal(ai.testController,null);assert.equal(cancelled,1);
});
test('cancel IDs are exact; an old page cannot cancel a different operation',async t=>{
  const gate=deferred(),{ai}=await setup(t,async()=>gate.promise);ai.config.timeout_seconds=10;
  const target={api_platform:'openai',api_base_url:'https://api.openai.com/v1',api_format:'responses',api_model:'synthetic',api_max_output_tokens:16,timeout_seconds:10};
  const pending=ai.testAPI({test_id:id,target,credential:{source:'new',key:'synthetic-new-only'}});await until(()=>ai.diagnostics.state().test.phase==='http_request');
  assert.equal(ai.cancelTest({test_id:'old-operation'}).cancel_requested,false);assert.equal(ai.testController.signal.aborted,false);
  assert.deepEqual(ai.cancelTest({test_id:id}),{cancel_requested:true,upstream_cancel_confirmed:false});await assert.rejects(pending,e=>e.code==='test_cancelled'&&e.testResult.test_id===id);assert.equal(ai.testController,null);gate.resolve(new Response(''));assert.equal(ai.cancelTest({test_id:id}).cancel_requested,false);
});
for(const status of [400,403,429])test('HTTP '+status+' settles once, records only safe metadata and never retries',async t=>{
  let calls=0;const {ai,dir}=await setup(t,async()=>{calls++;return new Response(JSON.stringify({error:{message:'synthetic-private-vendor-body',code:status===429?'rate_limit_exceeded':'invalid_request'}}),{status,headers:{'content-type':'application/json'}});});ai.config.timeout_seconds=1;
  await assert.rejects(ai.testAPI(),e=>e.testResult.http_status===status&&!e.testResult.ok);assert.equal(calls,1);assert.equal(ai.testController,null);assert.doesNotMatch(await readFile(join(dir,'ai-diagnostics.json'),'utf8'),/synthetic-private-vendor-body|synthetic-test-only/);
});
test('invalid draft releases the lock before any credential lookup or request',async t=>{
  const {ai}=await setup(t,async()=>assert.fail('No provider call'));await assert.rejects(ai.testAPI({target:{},credential:{source:'new',key:'synthetic'}}),/api_draft_required/);assert.equal(ai.testController,null);assert.equal(ai.testOperationId,null);assert.equal(ai.diagnostics.state().test,null);
});
