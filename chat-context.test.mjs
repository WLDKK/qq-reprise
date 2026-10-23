import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIChat } from './ai-chat.mjs';
import { AI_DEFAULTS, validateAISettings } from './ai-config.mjs';
import { MemorySecrets } from './ai-storage.mjs';
import { ResendQueue } from './send-queue.mjs';
import { apiBinding } from './ai-api-draft.mjs';
import { LocalGroupContext } from './group-context.mjs';
import { privatePayloadDecision } from './private-privacy.mjs';
import { LocalContentReviewer } from './local-content-review.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async fn => { for (let i=0;i<200;i++) { if(fn()) return; await sleep(5); } assert.fail('mock timeout'); };
const group = (id,text,{at=false,sender='60001',peer='50001',self='90001',...extra}={}) => ({post_type:'message',message_type:'group',self_id:self,group_id:peer,user_id:sender,message_id:id,message:[...(at?[{type:'at',data:{qq:self}}]:[]),{type:'text',data:{text}}],...extra});
const pm = (id,text) => ({post_type:'message',message_type:'private',sub_type:'friend',self_id:'90001',user_id:'60001',message_id:id,time:Math.ceil(Date.now()/1000),message:[{type:'text',data:{text}}]});
const event = raw => ({self_id:String(raw.self_id),peer_id:String(raw.group_id),user_id:String(raw.user_id),message_id:String(raw.message_id),conversation_type:'group'});
async function fixture(t, changes={}, generate, localReviewer) {
  const dir=await mkdtemp(join(tmpdir(),'chat-context-mock-')),calls=[],sent=[];
  const app={selfId:'90001',connected:true,onlineConfirmed:true,sendQueue:new ResendQueue({intervalMs:0,jitterMs:0}),client:{call:async(action,body)=>{sent.push({action,body});return{message_id:80000+sent.length}}}};
  const ai=new AIChat({dir,app,secrets:new MemorySecrets(),localReviewer,provider:{generate:async(...args)=>{calls.push(args);return generate?generate(...args):'你好，我是小晴，有什么想一起聊聊的？'}}});await ai.initialize();
  ai.config={...structuredClone(AI_DEFAULTS),enabled:true,binding_qq:'90001',api_model:'mock',groups:['50001'],users:['60001'],cooldown_seconds:0,...changes};ai.auth.meta.api_configured=true;ai.auth.meta.api_binding=apiBinding(ai.config);ai.auth.meta.api_id='synthetic';
  if(changes.group_context_export)ai.config.group_context_target=ai.config.api_base_url;
  t.after(async()=>{ai.dispose();await ai.budgetTask.catch(()=>{});await ai.diagnostics.file.task.catch(()=>{});await ai.settingsFile.task.catch(()=>{});await rm(dir,{recursive:true,force:true})});
  return{ai,app,calls,sent,dir,offer:raw=>{ai.observe(raw);return ai.offer(raw)}};
}
test('quiet group messages are RAM-only: no model, budget or QQ send; text name and command do not wake',async t=>{
  const f=await fixture(t);for(const [n,text]of ['你好','@小晴 解释这个','/ai 普通问题'].entries())assert.equal(f.offer(group(n+1,text)),false);
  await sleep(10);assert.equal(f.ai.groupContext.state(f.ai.config).messages,3);assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);assert.equal(f.ai.usage.count,0);assert.equal(f.ai.inputStats.group_last_result,'group_trigger_required');
  assert.equal(f.ai.state().group_context.exportEnabled,false);assert.doesNotMatch(JSON.stringify(f.ai.state()),/解释这个|普通问题/);
});
test('real @ requires the original group and excludes blacklisted senders; empty legacy whitelist does not block members',async t=>{
  const f=await fixture(t,{allow_self:false,users:[],group_blacklist:['60003']});assert.equal(f.offer(group(1,'解释彩虹',{at:true,sender:'60003'})),false);assert.equal(f.ai.inputStats.group_last_result,'group_blacklisted');
  assert.equal(f.offer(group(2,'解释彩虹',{at:true,sender:'90001'})),false);assert.equal(f.ai.inputStats.group_last_result,'self_not_allowed');
  assert.equal(f.offer(group(3,'解释彩虹',{at:true,peer:'50002'})),false);assert.equal(f.calls.length,0);
  assert.equal(f.offer(group(4,'请比较积云和卷云如何形成',{at:true})),true);await until(()=>f.ai.counts.sent===1);assert.equal(f.calls.length,1);
});
test('nearby export is off by default even for a real mention',async t=>{
  const f=await fixture(t);f.offer(group(1,'什么是彩虹'));f.offer(group(2,'解释刚才的现象',{at:true}));await until(()=>f.ai.counts.sent===1);assert.deepEqual(f.calls[0][1],[]);
});
test('consented nearby ordinary context stays within group and excludes blacklisted and recognized sensitive text',async t=>{
  const f=await fixture(t,{group_context_export:true,groups:['50001','50002'],group_blacklist:['60003']});
  for(const raw of [group(1,'什么是彩虹'),group(2,'彩虹解释 password=synthetic-context-credential'),group(3,'陌生内容不能默认视为安全'),group(4,'你好',{sender:'60003'}),group(5,'讲个笑话',{peer:'50002'})])f.offer(raw);
  f.offer(group(6,'请根据前面的讨论解释彩虹的成因',{at:true}));await until(()=>f.ai.counts.sent===1);
  const history=f.calls[0][1];assert.equal(history.length,1);assert.match(history[0].content,/untrusted_group_context/);assert.match(history[0].content,/什么是彩虹/);
  assert.doesNotMatch(history[0].content,/陌生内容/);assert.doesNotMatch(history[0].content,/密码|讲个笑话|60003|50002/);assert.equal(history[0].role,'user');assert.match(f.calls[0][0].instructions,/仅是数据/);assert.equal(f.ai.inputStats.group_context_omitted,3);
});
test('ordinary API members outside the legacy whitelist can trigger and contribute safe same-group context',async t=>{
  const f=await fixture(t,{users:[],group_context_export:true});
  f.offer(group(601,'什么是彩虹',{sender:'60004'}));
  assert.equal(f.offer(group(602,'请解释彩虹的形成',{sender:'60005',at:true})),true);await until(()=>f.ai.counts.sent===1);
  assert.match(f.calls[0][1][0].content,/什么是彩虹/);assert.doesNotMatch(f.calls[0][1][0].content,/60004|60005/);
  assert.equal(f.ai.state().group_sender_policy,'blacklist');assert.equal(f.ai.inputStats.group_last_result,'accepted');
});
test('group blacklist wins over the legacy whitelist and self opt-in; it does not become a private blacklist',async t=>{
  const f=await fixture(t,{users:['60001'],group_blacklist:['60001','90001'],allow_self:true});
  for(const sender of ['60001','90001']){assert.equal(f.offer(group(610+Number(sender),'你好',{sender,at:true})),false);assert.equal(f.ai.inputStats.group_last_result,'group_blacklisted');}
  assert.equal(f.calls.length,0);assert.equal(f.offer(pm(613,'你好')),true);await until(()=>f.ai.counts.sent===1);assert.equal(f.sent[0].action,'send_private_msg');
});
test('API group blacklist migration supplies an empty default and validates entries without reinterpreting legacy users',()=>{
  const {group_blacklist,...legacy}=structuredClone(AI_DEFAULTS);legacy.users=['60001'];
  const migrated=validateAISettings(legacy);assert.deepEqual(migrated.group_blacklist,[]);assert.deepEqual(migrated.users,['60001']);
  assert.deepEqual(validateAISettings({...legacy,group_blacklist:'60002, 60002 60003'}).group_blacklist,['60002','60003']);
  assert.throws(()=>validateAISettings({...legacy,group_blacklist:['invalid']}));assert.deepEqual(validateAISettings({...legacy,group_blacklist:Array(101).fill('60002')}).group_blacklist,['60002']);
});
test('ChatGPT group access stays owner-only with an empty blacklist and legacy allowed members',async t=>{
  const f=await fixture(t,{backend:'chatgpt',users:['60003'],group_blacklist:[]});
  assert.equal(f.offer(group(621,'你好',{sender:'60003',at:true})),false);assert.equal(f.ai.inputStats.group_last_result,'plan_owner_only');
  assert.equal(f.ai.state().group_sender_policy,'owner_only');assert.equal(f.calls.length,0);
});
test('group free questions keep three rounds and the exact previous model answers',async t=>{
  let n=0;const answers=['卷云通常由高空的冰晶构成。','积云的外形更像蓬松的棉花。','可以先观察高度、形状和天气变化。'];
  const f=await fixture(t,{},async()=>answers[n++]);const questions=['请比较积云和卷云有哪些明显区别','能换一种适合初学者的解释方式吗','再用一个类比把刚才的区别串起来'];
  for(let i=0;i<3;i++){f.offer(group(10+i,questions[i],{at:true}));await until(()=>f.ai.counts.sent===i+1)}
  assert.deepEqual(f.calls.map(c=>c[1].length),[0,2,4]);assert.equal(f.calls[2][1][1].content,answers[0]);assert.equal(f.calls[2][1][3].content,answers[1]);assert.equal(f.calls[2][1][2].content,questions[1]);
});
test('private three rounds no longer reject natural assistant replies or require finite input phrases',async t=>{
  const answers=['你好，我是小晴，可以陪你聊些有趣的知识。','植物会把光能转变为化学能。','叶绿素吸收光，参与把水和二氧化碳转化为糖。'];let n=0;
  const f=await fixture(t,{},async()=>answers[n++]);const prompts=['你好','什么是光合作用','解释一下光合作用'];
  for(let i=0;i<3;i++){f.offer(pm(20+i,prompts[i]));await until(()=>f.ai.counts.sent===i+1)}
  assert.deepEqual(f.calls.map(c=>c[1].length),[0,2,4]);assert.equal(f.calls[2][1][3].content,answers[1]);assert.equal(f.ai.privateHolds.size,0);
  assert.equal(privatePayloadDecision('不在既有审核范围的一般自由问题').allowed,true);
  await f.ai.diagnostics.file.task;await f.ai.budgetTask;
  for(const file of (await readdir(f.dir)).filter(name=>!name.endsWith('.tmp')))assert.doesNotMatch(await readFile(join(f.dir,file),'utf8'),/叶绿素|有趣的知识/);
});
test('three ordinary private questions survive unsupported messages and strip verified at/reply metadata',async t=>{
  const questions=['请解释快速排序的大致思路','换成整理卡片的类比再讲一次','接着说明这个过程为什么会结束'];
  const answers=['先选一个基准，再把元素分到两边。','想象把卡片按大小分成两堆。','每次都处理更小的一堆，直到只剩一张。'];let n=0;
  const f=await fixture(t,{},async()=>answers[n++]);
  assert.equal(f.offer(pm(700,' '+questions[0]+' ')),true);await until(()=>f.ai.counts.sent===1);
  for(const [i,type]of ['image','file','record','face','forward','unsupported'].entries()){
    const raw=pm(710+i,'');raw.message=[{type,data:{file:'https://private.invalid/synthetic'}},{type:'text',data:{text:'不应单独转发的混合正文'}}];
    assert.equal(f.offer(raw),false);assert.equal(f.ai.inputStats.last_result,'unsupported_message');
  }
  assert.equal(f.ai.privateHolds.size,0);assert.equal(f.calls.length,1);
  const second=pm(720,questions[1]);second.message.unshift({type:'reply',data:{id:80001,text:'api_key=metadata-must-not-be-exported'}},{type:'at',data:{qq:'90001'}});
  assert.equal(f.offer(second),true);await until(()=>f.ai.counts.sent===2);
  const third=pm(721,questions[2]);third.message.unshift({type:'reply',data:{id:80002}});
  assert.equal(f.offer(third),true);await until(()=>f.ai.counts.sent===3);
  assert.deepEqual(f.calls.map(c=>c[1].length),[0,2,4]);assert.deepEqual(f.calls.map(c=>c[2]),questions);
  assert.doesNotMatch(JSON.stringify(f.calls),/metadata-must-not-be-exported|private\.invalid|80001|80002/);assert.equal(f.ai.privateHolds.size,0);
});
test('group at+text works and verified same-group reply+at+text ignores quoted metadata',async t=>{
  const f=await fixture(t,{group_context_export:true,users:[]});
  assert.equal(f.offer(group(730,'请解释二分查找的思路',{at:true,sender:'60005'})),true);await until(()=>f.ai.counts.sent===1);
  const raw=group(731,'请举一个简单例子',{at:true,sender:'60005'});raw.message.unshift({type:'reply',data:{id:80001,text:'api_key=synthetic-quoted-metadata'}});
  assert.equal(f.offer(raw),true);await until(()=>f.ai.counts.sent===2);assert.equal(f.calls[1][2],'请举一个简单例子');assert.doesNotMatch(JSON.stringify(f.calls),/synthetic-quoted-metadata|80001/);
  const noAt=group(732,'继续这个例子',{sender:'60005'});noAt.message.unshift({type:'reply',data:{id:80001,text:'[CQ:at,qq=90001]'}});
  assert.equal(f.offer(noAt),false);assert.equal(f.ai.inputStats.group_last_result,'group_trigger_required');assert.equal(f.calls.length,2);
});
test('a real bot mention still works alongside other mentions; private mentions do not change scope',async t=>{
  const f=await fixture(t);const raw=group(735,'请解释归并排序',{at:true});raw.message.unshift({type:'at',data:{qq:'60002'}});
  assert.equal(f.offer(raw),true);await until(()=>f.ai.counts.sent===1);assert.ok(f.calls[0][2].startsWith('请解释归并排序\n'));const relation=JSON.parse(f.calls[0][2].split('\n').at(-1));assert.equal(relation.version,1);assert.ok(relation.parts.some(p=>p.role==='referenced_member'));assert.ok(relation.parts.some(p=>p.role==='assistant'));
  const direct=pm(736,'请解释递归的终止条件');direct.message.unshift({type:'at',data:{qq:'60002'}});
  assert.equal(f.offer(direct),true);await until(()=>f.ai.counts.sent===2);assert.equal(f.calls[1][2],'请解释递归的终止条件');
  assert.doesNotMatch(JSON.stringify(f.calls),/60002/);
});
test('unverified and cross-conversation replies skip only that message and never fetch quoted content',async t=>{
  const f=await fixture(t,{groups:['50001','50002']});f.offer(group(740,'请解释排序',{peer:'50002'}));
  for(const reference of [740,999999]){const raw=group(741+reference,'请继续',{at:true});raw.message.unshift({type:'reply',data:{id:reference}});assert.equal(f.offer(raw),false);assert.equal(f.ai.inputStats.group_last_result,'reply_not_in_conversation');}
  assert.equal(f.offer(pm(750,'请解释排序的目标')),true);await until(()=>f.ai.counts.sent===1);
  const cross=pm(751,'请继续');cross.user_id='60002';cross.message.unshift({type:'reply',data:{id:80001}});assert.equal(f.offer(cross),false);
  assert.equal(f.ai.inputStats.last_result,'reply_not_in_conversation');assert.equal(f.ai.privateHolds.size,0);assert.equal(f.calls.length,1);
  assert.equal(f.offer(pm(752,'再举一个例子')),true);await until(()=>f.ai.counts.sent===2);
});
test('mention metadata cannot grant another sender permission or bypass sensitive-body protection',async t=>{
  const f=await fixture(t,{group_blacklist:['60003']});
  assert.equal(f.offer(group(760,'你好',{at:true,sender:'60003'})),false);assert.equal(f.ai.inputStats.group_last_result,'group_blacklisted');
  const raw=pm(761,'我的密码是合成测试');raw.message.unshift({type:'at',data:{qq:'90001'}});assert.equal(f.offer(raw),true);
  assert.equal(f.ai.privateHolds.size,1);assert.equal(f.calls.length,0);assert.equal(f.ai.usage.count,0);
});
test('unproven or modified assistant history cannot acquire trust just by claiming the role',async t=>{
  assert.equal(privatePayloadDecision('你好',[{role:'assistant',content:'未知的自由回复'}]).allowed,false);
  const f=await fixture(t);f.offer(pm(30,'你好'));await until(()=>f.ai.counts.sent===1);f.ai.sessions.values().next().value.turns[0].answer='未经证明的替换内容';f.offer(pm(31,'你好'));await until(()=>f.ai.privateHolds.size===1);assert.equal(f.calls.length,1);
});
test('sensitive history remains local even when modifying an otherwise proven turn',async t=>{
  const f=await fixture(t);f.offer(pm(40,'你好'));await until(()=>f.ai.counts.sent===1);f.ai.sessions.values().next().value.turns[0].answer='合成的健康病历';f.offer(pm(41,'你好'));await until(()=>f.ai.privateHolds.size===1);assert.equal(f.calls.length,1);
});
test('group cache never mixes into private history or a different group',async t=>{
  const f=await fixture(t,{group_context_export:true,groups:['50001','50002']});f.offer(group(50,'什么是彩虹'));f.offer(pm(51,'你好'));await until(()=>f.ai.counts.sent===1);assert.deepEqual(f.calls[0][1],[]);
  f.offer(group(52,'解释一个一般问题',{at:true,peer:'50002'}));await until(()=>f.ai.counts.sent===2);assert.deepEqual(f.calls[1][1],[]);
});
test('cache count/TTL, recall, reset and restart boundaries are enforced without disk storage',()=>{
  let now=1000000;const cache=new LocalGroupContext(()=>now),config={...AI_DEFAULTS,enabled:true,groups:['50001'],group_cache_limit:2,group_cache_ttl_minutes:1};
  for(let n=1;n<=3;n++){const raw=group(n,'你好');cache.put(event(raw),raw,config);now++}assert.equal(cache.state(config).messages,2);
  cache.recall(event(group(3,'')));assert.equal(cache.state(config).messages,1);now+=60001;assert.equal(cache.state(config).messages,0);
  const raw=group(4,'你好');cache.put(event(raw),raw,config);cache.clear();assert.equal(cache.state(config).messages,0);assert.equal(new LocalGroupContext(()=>now).state(config).messages,0);
});
test('persona is editable text with stable permissions and no external profile actions',()=>{
  const c=validateAISettings({...AI_DEFAULTS,bot_name:'小晴',bot_address:'朋友',bot_persona:'活泼亲切，清楚解释问题，适量使用颜文字。'});assert.equal(c.group_context_export,false);assert.deepEqual(c.groups,[]);assert.deepEqual(c.users,[]);
  assert.match(c.bot_persona,/活泼/);assert.throws(()=>validateAISettings({...c,bot_persona:'api_key=synthetic-secret'}));assert.equal(validateAISettings({...c,group_cache_limit:101}).group_cache_limit,101);assert.throws(()=>validateAISettings({...c,group_cache_limit:0}));
});
test('local semantic review supports three free private turns with prior answers in context, without a finite phrase match',async t=>{
  const inspected=[];const reviewer=new LocalContentReviewer({transport:async body=>{inspected.push(JSON.parse(body.prompt));return{model:'qwen3:4b',done:true,done_reason:'stop',response:JSON.stringify({verdict:'public_nonpersonal',contains_sensitive:false,ambiguous:false})}}});
  let n=0;const answers=['快速排序先选一个基准，再把元素分到两侧。','可以把它想成给一堆卡片分组。','每组继续采用相同方式，直到足够小。'];
  const f=await fixture(t,{private_local_review:true},async()=>answers[n++],reviewer);
  for(const [i,text]of ['请解释快速排序的基本思路','能用一堆卡片的类比解释刚才的过程吗','接着说明这为何属于递归思路'].entries()){f.offer(pm(100+i,text));await until(()=>f.ai.counts.sent===i+1)}
  assert.deepEqual(f.calls.map(c=>c[1].length),[0,2,4]);assert.equal(f.calls[2][1][3].content,answers[1]);assert.ok(inspected.some(x=>x.context.some(h=>h.content===answers[1])));assert.equal(f.ai.privateHolds.size,0);
});
test('local model absence and uncertain verdict never fall back to a cloud classification or consume cloud budget',async t=>{
  const reviewer=new LocalContentReviewer({transport:async()=>{throw new Error('not installed')}});const f=await fixture(t,{private_local_review:true},undefined,reviewer);
  f.offer(pm(110,'请用类比解释一种算法'));await until(()=>f.ai.privateHolds.size===1);assert.equal(f.calls.length,0);assert.equal(f.ai.usage.count,0);assert.equal(reviewer.state().status,'unavailable');
});
test('one local rejection does not permanently block a later independently approved ordinary question',async t=>{
  const reviewer=new LocalContentReviewer({transport:async body=>({model:'qwen3:4b',done:true,done_reason:'stop',response:JSON.stringify({verdict:JSON.parse(body.prompt).text.includes('暗示')?'uncertain':'public_nonpersonal',contains_sensitive:false,ambiguous:JSON.parse(body.prompt).text.includes('暗示')})})});
  const f=await fixture(t,{private_local_review:true},undefined,reviewer);f.offer(pm(120,'继续那件有暗示的事'));await until(()=>f.ai.privateHolds.size===1);f.offer(pm(121,'请解释排序算法的共同目标'));await until(()=>f.ai.counts.sent===1);assert.equal(f.calls.length,1);
});
test('local review output must affirm ordinary nonpersonal text; keywords absent or malformed JSON is insufficient',async()=>{
  for(const response of ['{}',JSON.stringify({verdict:'uncertain',contains_sensitive:false,ambiguous:false}),JSON.stringify({verdict:'public_nonpersonal',contains_sensitive:false,ambiguous:true})]){
    const reviewer=new LocalContentReviewer({transport:async()=>({model:'qwen3:4b',done:true,done_reason:'stop',response})});assert.equal((await reviewer.review('一般文字不能靠关键词缺失就直接外发')).allowed,false);
  }
  let calls=0;const reviewer=new LocalContentReviewer({transport:async()=>{calls++;throw new Error()}});assert.equal((await reviewer.review('密码是合成文字')).allowed,false);assert.equal(calls,0);
});
test('approved 50/30 nearby-context change preserves enable/safety state and refuses a changed recipient',async t=>{
  const f=await fixture(t);f.ai.blocked=true;f.ai.error='authorization_required';
  await assert.rejects(f.ai.configureNearbyContext({expected_base:'https://other.invalid/v1',enabled:true,limit:50,ttl_minutes:30,max_chars:4000}),/context_recipient_changed/);
  await f.ai.configureNearbyContext({expected_base:f.ai.config.api_base_url,enabled:true,limit:50,ttl_minutes:30,max_chars:4000});
  assert.equal(f.ai.config.enabled,true);assert.equal(f.ai.blocked,true);assert.equal(f.ai.error,'authorization_required');assert.equal(f.ai.config.group_cache_limit,50);assert.equal(f.ai.config.group_cache_ttl_minutes,30);assert.deepEqual(f.ai.config.users,['60001']);assert.equal(f.calls.length,0);
});
