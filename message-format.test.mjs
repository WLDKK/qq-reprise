import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AIChat} from './ai-chat.mjs';
import {AI_DEFAULTS} from './ai-config.mjs';
import {MemorySecrets} from './ai-storage.mjs';
import {ResendQueue} from './send-queue.mjs';
import {apiBinding} from './ai-api-draft.mjs';
const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('synthetic timeout');};
const at=qq=>({type:'at',data:{qq}}),text=value=>({type:'text',data:{text:value}}),reply=(id,extra={})=>({type:'reply',data:{id,...extra}});
const group=(id,value,extra={})=>({post_type:'message',message_type:'group',self_id:90001,group_id:50001,user_id:60001,message_id:id,message:[at(90001),text(value)],...extra});
const pm=(id,value,extra={})=>({post_type:'message',message_type:'private',sub_type:'friend',self_id:90001,user_id:60001,message_id:id,time:Math.ceil(Date.now()/1000),message:[text(value)],...extra});
async function fixture(t,changes={}){
  const dir=await mkdtemp(join(tmpdir(),'message-format-mock-')),calls=[],sent=[];
  const app={selfId:'90001',connected:true,onlineConfirmed:true,sendQueue:new ResendQueue({intervalMs:0,jitterMs:0}),client:{call:async(action,body)=>{sent.push({action,body});return{message_id:80000+sent.length};}}};
  const ai=new AIChat({dir,app,secrets:new MemorySecrets(),provider:{generate:async(...args)=>{calls.push(args);return'这是本次已确认的合成回答。';}}});await ai.initialize();
  ai.config={...structuredClone(AI_DEFAULTS),enabled:true,binding_qq:'90001',api_model:'mock',groups:['50001'],users:[],cooldown_seconds:0,...changes};
  ai.auth.meta.api_configured=true;ai.auth.meta.api_id='synthetic';ai.auth.meta.api_binding=apiBinding(ai.config);
  t.after(async()=>{ai.dispose();await ai.budgetTask.catch(()=>{});await ai.settingsFile.task.catch(()=>{});await ai.diagnostics.file.task.catch(()=>{});await rm(dir,{recursive:true,force:true});});
  return{ai,calls,sent,offer:raw=>{ai.observe(raw);return ai.offer(raw);}};
}
test('group real at+text and verified reply+at+text support three non-greeting rounds',async t=>{
  const f=await fixture(t);const questions=['请解释快速排序的大致思路','换成整理卡片的类比再讲一次','接着说明这个过程为什么会结束'];
  for(let i=0;i<3;i++){
    const raw=group(100+i,questions[i]);if(i)raw.message.unshift(reply(80000+i,{text:'api_key=synthetic-ignored-metadata'}));
    assert.equal(f.offer(raw),true);await until(()=>f.ai.counts.sent===i+1);
  }
  assert.deepEqual(f.calls.map(c=>c[1].length),[0,2,4]);assert.deepEqual(f.calls.map(c=>c[2]),questions);assert.doesNotMatch(JSON.stringify(f.calls),/ignored-metadata|80001|80002/);
});
test('unsupported messages do not lock private conversation; supported non-greeting text resumes for three rounds',async t=>{
  const f=await fixture(t);const questions=['什么是光合作用','解释一下光合作用','为什么天空是蓝色的'];
  assert.equal(f.offer(pm(200,questions[0])),true);await until(()=>f.ai.counts.sent===1);
  for(const [i,type]of ['image','file','record','face','forward','unknown'].entries()){
    assert.equal(f.offer(pm(210+i,'',{message:[{type,data:{file:'https://private.invalid/synthetic'}},text('混合正文也不单独外发')]})),false);
    assert.equal(f.ai.inputStats.private_last_result,'unsupported_message');
  }
  for(const [i,message]of [null,[],[null],[text('')],[text('x'.repeat(2001))]].entries())assert.equal(f.offer(pm(220+i,'',{message})),false);
  assert.equal(f.ai.privateHolds.size,0);assert.equal(f.calls.length,1);
  assert.equal(f.offer(pm(230,'',{message:[reply(80001,{text:'api_key=synthetic-ignored-metadata'}),at(90001),text(questions[1])]})),true);await until(()=>f.ai.counts.sent===2);
  assert.equal(f.offer(pm(231,'',{message:[reply(80002),text(questions[2])]})),true);await until(()=>f.ai.counts.sent===3);
  assert.deepEqual(f.calls.map(c=>c[1].length),[0,2,4]);assert.deepEqual(f.calls.map(c=>c[2]),questions);assert.equal(f.ai.privateHolds.size,0);
  assert.doesNotMatch(JSON.stringify(f.calls),/ignored-metadata|private\.invalid|80001|80002/);
});
test('CQ-string metadata follows the same real-mention and local-reference rules',async t=>{
  const f=await fixture(t);assert.equal(f.offer(group(300,'',{message:'[CQ:at,qq=90001] 请解释二分查找'})),true);await until(()=>f.ai.counts.sent===1);
  assert.equal(f.offer(group(301,'',{message:'[CQ:reply,id=80001][CQ:at,qq=90001] 再举一个简单例子'})),true);await until(()=>f.ai.counts.sent===2);
  assert.equal(f.calls[1][2],'再举一个简单例子');
});
test('reply metadata cannot invent a real mention, fetch missing history or cross conversations',async t=>{
  const f=await fixture(t,{groups:['50001','50002']});
  f.offer(group(400,'什么是彩虹',{group_id:50002,message:[text('什么是彩虹')]}));
  for(const ref of [400,99999]){assert.equal(f.offer(group(401+ref,'请继续',{message:[reply(ref),at(90001),text('请继续')]})),false);assert.equal(f.ai.inputStats.group_last_result,'reply_not_in_conversation');}
  f.offer(group(410,'什么是彩虹',{message:[text('什么是彩虹')]}));
  assert.equal(f.offer(group(411,'',{message:[reply(410,{text:'[CQ:at,qq=90001]'}),text('请继续')]})),false);assert.equal(f.ai.inputStats.group_last_result,'group_trigger_required');
  assert.equal(f.offer(pm(420,'你好')),true);await until(()=>f.ai.counts.sent===1);
  assert.equal(f.offer(pm(421,'',{user_id:60002,message:[reply(80001),text('你好')]})),false);assert.equal(f.ai.inputStats.private_last_result,'reply_not_in_conversation');assert.equal(f.ai.privateHolds.size,0);
});
test('additional mentions do not cancel a real bot mention or grant access without it',async t=>{
  const f=await fixture(t);
  assert.equal(f.offer(group(500,'',{message:[at(60002),at(90001),text('请解释排序的目标')]})),true);await until(()=>f.ai.counts.sent===1);
  assert.equal(f.offer(group(501,'',{message:[at(60002),text('请解释排序的目标')]})),false);assert.equal(f.ai.inputStats.group_last_result,'wrong_mention');
  assert.equal(f.offer(group(502,'',{message:[at('all'),text('请解释排序的目标')]})),false);
});
test('metadata stripping permits authorized ordinary questions and preserves sensitive-content holds',async t=>{
  const f=await fixture(t);f.offer(pm(600,'你好'));await until(()=>f.ai.counts.sent===1);
  assert.equal(f.offer(pm(601,'',{message:[reply(80001),at(90001),text('不在既有普通短句范围的自由提问')]})),true);
  await until(()=>f.ai.counts.sent===2);assert.equal(f.ai.privateHolds.size,0);assert.equal(f.calls.length,2);
  f.ai.clearPrivateReviews();assert.equal(f.offer(pm(602,'',{message:[at(90001),text('我的密码是合成测试')]})),true);
  assert.equal(f.ai.privateHolds.values().next().value.reason,'credentials');assert.equal(f.calls.length,2);assert.equal(f.ai.usage.count,2);
});
test('blacklist, QQ binding and ChatGPT owner-only boundaries survive metadata parsing',async t=>{
  const f=await fixture(t,{group_blacklist:['60003'],private_blacklist:['60002']});
  assert.equal(f.offer(group(700,'你好',{user_id:60003})),false);assert.equal(f.ai.inputStats.group_last_result,'group_blacklisted');
  assert.equal(f.offer(pm(701,'你好',{user_id:60002})),false);assert.equal(f.ai.inputStats.private_last_result,'private_blacklisted');
  assert.equal(f.offer(group(702,'你好',{self_id:90002})),false);assert.equal(f.calls.length,0);
  const plan=await fixture(t,{backend:'chatgpt'});assert.equal(plan.offer(group(703,'你好')),false);assert.equal(plan.ai.inputStats.group_last_result,'plan_owner_only');assert.equal(plan.calls.length,0);
});
