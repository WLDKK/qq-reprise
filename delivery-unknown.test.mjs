import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {AIChat} from './ai-chat.mjs';
import {AI_DEFAULTS} from './ai-config.mjs';
import {apiBinding} from './ai-api-draft.mjs';
import {MemorySecrets} from './ai-storage.mjs';
import {ResendQueue} from './send-queue.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<200;n++){if(fn())return;await sleep(5);}assert.fail('synthetic condition timeout');}
for(const kind of ['group','private'])test(kind+' unknown receipt remains visible without blocking later new work, replay or late context insertion',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'unknown-delivery-mock-')),calls=[],sent=[];
 const app={selfId:'90001',connected:true,onlineConfirmed:true,sendQueue:new ResendQueue({intervalMs:0,jitterMs:0}),client:{call:async(action,body,options)=>{sent.push({action,body,options});if(sent.length===1)throw Object.assign(new Error('synthetic unknown submission'),{retcode:1200});return{message_id:82000+sent.length};}}};
 const ai=new AIChat({dir,app,secrets:new MemorySecrets(),poolSecrets:new MemorySecrets(),provider:{generate:async(...args)=>{calls.push(args);return'synthetic answer '+calls.length;}}});await ai.initialize();
 ai.config={...structuredClone(AI_DEFAULTS),enabled:true,binding_qq:'90001',api_model:'synthetic-model',groups:['50001'],private_peers:['60001'],users:['60001'],cooldown_seconds:0};ai.auth.meta.api_configured=true;ai.auth.meta.api_id='synthetic-credential';ai.auth.meta.api_binding=apiBinding(ai.config);
 t.after(async()=>{ai.dispose();await ai.budgetTask.catch(()=>{});await ai.diagnostics.file.task.catch(()=>{});await ai.settingsFile.task.catch(()=>{});const rel=relative(tmpdir(),dir);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(dir,{recursive:true,force:true});});
 const message=n=>({post_type:'message',message_type:kind,...(kind==='group'?{group_id:50001}:{sub_type:'friend'}),self_id:90001,user_id:60001,message_id:n,time:Math.ceil(Date.now()/1000),message:[...(kind==='group'?[{type:'at',data:{qq:90001}}]:[]),{type:'text',data:{text:'synthetic ordinary question '+n}}]});
 assert.equal(ai.offer(message(1)),true);await until(()=>ai.active===0&&ai.counts.failed===1);
 assert.equal(ai.outbox.snapshot().uncertain_count,1,'The unknown delivery must remain observable');assert.equal(ai.counts.sent,0);
 const oldKey=[...ai.outbox.jobs.keys()][0];assert.equal(ai.jobs.has(oldKey),false,'Only the generation slot is released');
 ai.outbox.resume();await sleep(20);assert.equal(sent.length,1,'Never replay an unknown submission');
 assert.equal(ai.offer(message(2)),true);await until(()=>ai.counts.sent===1&&ai.active===0);assert.equal(calls.length,2);assert.equal(sent.length,2);assert.equal(calls[1][1].length,0,'Unconfirmed reply is absent from later context');assert.equal(ai.outbox.snapshot().uncertain_count,1);
 const session=[...ai.sessions.values()][0];assert.equal(session.turns.length,1);assert.equal(session.turns[0].answer,'synthetic answer 2');
 sent[0].options.onLateResult({message_id:82001});await until(()=>ai.outbox.snapshot().uncertain_count===0);sent[0].options.onLateResult({message_id:82001});
 assert.equal(session.turns.length,1,'Late confirmation must not insert the older answer out of order');assert.equal(ai.counts.sent,1);assert.equal(sent.length,2);assert.equal(ai.outbox.counters.sent,2);
});
