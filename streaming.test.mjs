import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AIProviders,publicAIError} from './ai-providers.mjs';
import {AI_DEFAULTS} from './ai-config.mjs';
import {AIChat} from './ai-chat.mjs';
import {PrivateRecallApp} from './qq-recall.mjs';
import {MemorySecrets} from './ai-storage.mjs';
import {apiBinding} from './ai-api-draft.mjs';
import {ResendQueue} from './send-queue.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await sleep(5);}assert.fail('synthetic timeout');};
const content=value=>({choices:[{index:0,delta:{content:value}}]}),stop={choices:[{index:0,delta:{},finish_reason:'stop'}]};
const encode=events=>new TextEncoder().encode(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
function provider(fetcher,changes={}){const calls=[];return{calls,config:{...structuredClone(AI_DEFAULTS),api_model:'synthetic',...changes},p:new AIProviders({auth:{readAPIFor:async()=> 'synthetic-key'},fetcher:async(...args)=>{calls.push(args);return fetcher(...args);}})};}
function openStream(events,cancel=()=>{}){return new Response(new ReadableStream({start(c){c.enqueue(encode(events));},cancel}),{headers:{'content-type':'text/event-stream'}});}
for(const format of ['chat_completions','responses'])test('terminal '+format+' completes without waiting for socket EOF or hanging cancel',async()=>{
  let cancelled=0;const events=format==='responses'?[{type:'response.output_text.delta',delta:'synthetic-answer'},{type:'response.completed',response:{status:'completed'}}]:[content('synthetic-answer'),stop];
  const f=provider(()=>openStream(events,()=>{cancelled++;return new Promise(()=>{});}),{api_format:format,timeout_seconds:0.1});
  assert.equal(await f.p.generate(f.config,[],'synthetic'),'synthetic-answer');assert.equal(f.calls.length,1);assert.equal(cancelled,1);
});
test('final SSE event without trailing blank line and case-insensitive media type are accepted',async()=>{
  const f=provider(()=>new Response('data: '+JSON.stringify(content('synthetic-answer'))+'\r\n\r\ndata: '+JSON.stringify(stop),{headers:{'content-type':'Text/Event-Stream; charset=UTF-8'}}));
  assert.equal(await f.p.generate(f.config,[],'synthetic'),'synthetic-answer');
});
test('reasoning-only stall times out with bounded metadata and never exposes reasoning as a reply',async()=>{
  const patches=[],f=provider(()=>openStream([{choices:[{index:0,delta:{reasoning_content:'synthetic-private-reasoning'}}]}]),{timeout_seconds:0.015});
  const alive=setTimeout(()=>{},200);try{await assert.rejects(f.p.generate(f.config,[],'synthetic',undefined,p=>patches.push(p)),e=>publicAIError(e)==='request_timeout');}finally{clearTimeout(alive);}
  const last=patches.at(-1);assert.equal(last.reasoningChars,27);assert.equal(last.outputChars,0);assert.equal(last.textDeltaEvents,0);assert.equal(last.firstContentMs,null);assert.doesNotMatch(JSON.stringify(patches),/synthetic-private/);assert.equal(f.calls.length,1);
});
test('a fetcher that ignores AbortSignal cannot hold a request or trigger an automatic retry',async()=>{
  let n=0;const f=provider(()=>++n===1?new Promise(()=>{}):new Response(encode([content('next-answer'),stop]),{headers:{'content-type':'text/event-stream'}}),{timeout_seconds:0.015});
  const alive=setTimeout(()=>{},200);try{await assert.rejects(f.p.generate(f.config,[],'first'),e=>publicAIError(e)==='request_timeout');assert.equal(f.calls.length,1);assert.equal(await f.p.generate(f.config,[],'next'),'next-answer');}finally{clearTimeout(alive);}assert.equal(f.calls.length,2);
});
test('length exhaustion remains an incomplete answer and records body/reasoning counts',async()=>{
  const patches=[],f=provider(()=>new Response(encode([{choices:[{index:0,delta:{reasoning_content:'synthetic-reason'}}]},content('partial'),{choices:[{index:0,delta:{},finish_reason:'length'}]}]),{headers:{'content-type':'text/event-stream'}}),{api_max_output_tokens:2048});
  await assert.rejects(f.p.generate(f.config,[],'synthetic',undefined,p=>patches.push(p)),/generation_incomplete/);assert.equal(patches.at(-1).outputChars,7);assert.equal(patches.at(-1).reasoningChars,16);assert.equal(f.calls.length,1);assert.equal(JSON.parse(f.calls[0][1].body).max_tokens,2048);
});
test('AI timeout frees the conversation and permits the next ordinary text without retrying the old job',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'stream-job-mock-')),secrets=new MemorySecrets(),sent=[];await secrets.setAPI('synthetic-key');let calls=0;
  const app={selfId:'90001',connected:true,onlineConfirmed:true,sendQueue:new ResendQueue({intervalMs:0,jitterMs:0}),client:{call:async(action,body)=>{sent.push({action,body});return{message_id:80000+sent.length};}}};
  const ai=new AIChat({dir,app,secrets,fetcher:async()=>++calls===1?openStream([{choices:[{index:0,delta:{reasoning_content:'synthetic-reason'}}]}]):new Response(encode([content('next-answer'),stop]),{headers:{'content-type':'text/event-stream'}})});await ai.initialize();
  t.after(async()=>{ai.dispose();await ai.budgetTask;await ai.diagnostics.file.task;await rm(dir,{recursive:true,force:true});});
  ai.config={...structuredClone(AI_DEFAULTS),enabled:true,binding_qq:'90001',api_model:'synthetic',timeout_seconds:0.015,cooldown_seconds:0};ai.auth.meta.api_configured=true;ai.auth.meta.api_id='synthetic';ai.auth.meta.api_binding=apiBinding(ai.config);
  const msg=(id,text)=>({post_type:'message',message_type:'private',sub_type:'friend',self_id:90001,user_id:60001,message_id:id,time:Math.ceil(Date.now()/1000),message:[{type:'text',data:{text}}]});
  ai.offer(msg(1,'请解释递归'));await until(()=>ai.counts.failed===1&&ai.active===0);assert.equal(ai.error,'request_timeout');assert.equal(ai.privateHolds.size,0);assert.equal(ai.jobs.size,0);assert.equal([...ai.sessions.values()][0].pending,null);assert.equal(sent.length,0);
  ai.offer(msg(2,'请解释排序'));await until(()=>ai.counts.sent===1&&ai.active===0);await ai.diagnostics.file.task;assert.equal(calls,2);assert.equal(ai.error,'');assert.equal(sent.length,1);assert.doesNotMatch(await readFile(ai.diagnostics.file.path,'utf8'),/synthetic-reason|next-answer/);
});
for(const mode of ['fetch_stall','body_stall','error'])test('image '+mode+' cannot block AI text or an independent withdrawal',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'image-isolation-mock-')),sent=[];let modelCalls=0;
  await writeFile(join(dir,'config.json'),JSON.stringify({target_type:'group',group_id:'50001',auto_start:true,auto_resend:true,send_interval_seconds:0,auto_recovery:false}));
  const app=new PrivateRecallApp({configPath:join(dir,'config.json'),logger:()=>{},aiSecrets:new MemorySecrets(),aiProvider:{generate:async()=>{modelCalls++;return'synthetic-answer';}},discover:async()=>[]});await app.initialize();
  t.after(async()=>{await app.shutdown();await app.ai.diagnostics.file.task;await rm(dir,{recursive:true,force:true});});
  app.selfId='90001';app.connected=true;app.onlineConfirmed=true;app.sendQueue.jitterMs=0;app.activate({type:'group',id:'50001',name:'synthetic'});app.engine.config.media_timeout_ms=15;
  app.engine.fetcher=()=>{if(mode==='error')throw new Error('synthetic');if(mode==='fetch_stall')return new Promise(()=>{});return Promise.resolve(new Response(new ReadableStream({start(c){c.enqueue(Uint8Array.from([71,73,70,56]));},cancel(){return new Promise(()=>{});}}),{headers:{'content-type':'image/gif'}}));};
  app.ai.config={...structuredClone(AI_DEFAULTS),enabled:true,binding_qq:'90001',groups:['50001'],api_model:'synthetic',cooldown_seconds:0};
  const api={call:async(action,body)=>{sent.push({action,body});return{message_id:85000+sent.length};}},msg=(id,message)=>({post_type:'message',message_type:'group',self_id:90001,group_id:50001,user_id:60001,message_id:id,message});
  await app.onEvent(msg(1,[{type:'at',data:{qq:90001}},{type:'image',data:{file:'https://offline.invalid/synthetic.gif'}}]),api);await until(()=>app.engine.downloadActive===0);
  assert.equal(modelCalls,0);assert.equal(app.ai.active,0);assert.equal(app.ai.privateHolds.size,0);assert.equal(app.ai.state().capabilities.image,false);
  await app.onEvent(msg(2,[{type:'at',data:{qq:90001}},{type:'text',data:{text:'请解释排序'}}]),api);await until(()=>app.ai.counts.sent===1);
  await app.onEvent(msg(3,[{type:'text',data:{text:'synthetic-withdrawal'}}]),api);await app.onEvent({post_type:'notice',notice_type:'group_recall',self_id:90001,group_id:50001,user_id:60001,operator_id:60001,message_id:3},api);
  assert.equal(modelCalls,1);assert.equal(sent.length,2);assert.equal(app.engine.downloadWaiters.length,0);assert.equal(app.preferences.auto_resend,true);
});
