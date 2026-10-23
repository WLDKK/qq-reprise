import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,rm,readFile,readdir}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';
import{AIChat}from'./ai-chat.mjs';import{AI_DEFAULTS}from'./ai-config.mjs';import{MemorySecrets}from'./ai-storage.mjs';import{ResendQueue}from'./send-queue.mjs';import{apiBinding}from'./ai-api-draft.mjs';import{normalizeEvent}from'./engine.mjs';
import{RecentVisionImages,resolveVisionReference,makeVisionProbe,VISION_BASE,VISION_MODEL}from'./ai-vision.mjs';
const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('synthetic timeout');};
const text=value=>({type:'text',data:{text:value}}),image=(n=1)=>({type:'image',data:{url:'https://gchat.qpic.cn/synthetic-'+n+'.png'}}),at={type:'at',data:{qq:90001}},reply=id=>({type:'reply',data:{id}});
const msg=(id,message,extra={})=>({post_type:'message',message_type:'group',self_id:90001,group_id:50001,user_id:60001,message_id:id,time:Math.ceil(Date.now()/1000),message,...extra});
const config=()=>({...structuredClone(AI_DEFAULTS),enabled:true,binding_qq:'90001',groups:['50001','50002'],api_base_url:VISION_BASE,api_model:VISION_MODEL,vision_enabled:true,vision_target:VISION_BASE,vision_model:VISION_MODEL,vision_verified_at:Date.now(),vision_reference_enabled:true,vision_recent_enabled:true,cooldown_seconds:0});
async function fixture(t,options={}){
  const dir=await mkdtemp(join(tmpdir(),'vision-source-mock-')),calls=[],sends=[],lookups=[],downloads=[];const png=Buffer.from(makeVisionProbe().image.dataURL.split(',')[1],'base64');
  const app={selfId:'90001',connected:true,onlineConfirmed:true,sendQueue:new ResendQueue({intervalMs:0,jitterMs:0}),client:{call:async(action,body)=>{if(action==='get_msg'){lookups.push(body);if(options.lookup)return options.lookup(body);throw new Error('No lookup expected');}sends.push({action,body});return{message_id:80000+sends.length};}}};
  const ai=new AIChat({dir,app,secrets:new MemorySecrets(),imageFetcher:async(u)=>{downloads.push(u);return new Response(png);},provider:{generate:async(...args)=>{calls.push(args);return options.generate?options.generate(...args):'这是一张合成测试图。';}}});await ai.initialize();ai.config={...config(),...options.changes};ai.auth.meta.api_configured=true;ai.auth.meta.api_id='synthetic';ai.auth.meta.api_binding=apiBinding(ai.config);
  t.after(async()=>{ai.dispose();await ai.budgetTask.catch(()=>{});await ai.settingsFile.task.catch(()=>{});await ai.diagnostics.file.task.catch(()=>{});await rm(dir,{recursive:true,force:true});});return{ai,calls,sends,lookups,downloads,dir,offer:raw=>{ai.observe(raw);return ai.offer(raw);}};
}
test('photo followed by a natural same-person same-chat request uses one recent picture, never old caption',async t=>{
  const f=await fixture(t);assert.equal(f.offer(msg(1,[image(),text('source-caption-never-forwarded')])),false);assert.equal(f.calls.length,0);assert.equal(f.downloads.length,0);
  assert.equal(f.offer(msg(2,[at,text('这是什么？')])),true);await until(()=>f.ai.counts.sent===1);assert.equal(f.calls[0][5].image.mime,'image/png');assert.deepEqual(f.calls[0][1],[]);assert.equal(f.lookups.length,0);assert.equal(f.downloads.length,1);assert.doesNotMatch(JSON.stringify(f.calls),/source-caption|gchat|synthetic-1/);
  for(const file of await readdir(f.dir))if(!file.endsWith('.tmp'))assert.doesNotMatch(await readFile(join(f.dir,file),'utf8'),/source-caption|gchat|data:image/);
});
test('explicit same-chat quote selects only that cached picture even from another allowed group member',async t=>{
  const f=await fixture(t);f.offer(msg(10,[image(1)],{user_id:60002}));f.offer(msg(11,[image(2)],{user_id:60003}));
  assert.equal(f.offer(msg(12,[reply(10),at,text('帮我看看这个')])),true);await until(()=>f.ai.counts.sent===1);assert.deepEqual(f.downloads,['https://gchat.qpic.cn/synthetic-1.png']);assert.equal(f.lookups.length,0);
});
test('recent lookup cannot cross author or conversation and a real group @ remains required',async t=>{
  const f=await fixture(t);f.offer(msg(20,[image()]));
  assert.equal(f.offer(msg(21,[text('这张图是什么')])),false);assert.equal(f.ai.inputStats.last_result,'group_trigger_required');
  let expected=0;for(const extra of [{user_id:60002},{group_id:50002}]){expected++;f.offer(msg(22,[at,text('这张图是什么')],extra));await until(()=>f.ai.active===0&&f.ai.counts.failed===expected);assert.equal(f.sends.length,0);}
  await until(()=>f.ai.active===0);assert.equal(f.calls.length,0);assert.equal(f.downloads.length,0);assert.equal(f.ai.error,'vision_no_recent_image');
});
test('multiple candidates ask for an explicit single-picture quote and never guess newest',async t=>{
  const f=await fixture(t);f.offer(msg(30,[image(1)]));f.offer(msg(31,[image(2)]));f.offer(msg(32,[at,text('这张图是什么')]));await until(()=>f.ai.active===0&&f.ai.counts.failed===1);
  assert.equal(f.calls.length,0);assert.equal(f.downloads.length,0);assert.equal(f.sends.length,0);assert.equal(f.ai.error,'vision_image_ambiguous');
  f.offer(msg(33,[reply(31),at,text('图里写了什么')]));await until(()=>f.ai.counts.sent===1);assert.deepEqual(f.downloads,['https://gchat.qpic.cn/synthetic-2.png']);
});
test('explicit uncached quote fetches exactly one message id and validates scope before image download',async t=>{
  const f=await fixture(t,{changes:{context_ttl_minutes:10},lookup:async({message_id})=>({message_id,message_type:'group',group_id:50001,time:Math.floor(Date.now()/1000)-60,sender:{user_id:60002},message:[image(7),text('quoted-caption-never-forwarded')]})});
  f.offer(msg(40,[reply(99),at,text('这张图是什么')]));await until(()=>f.ai.counts.sent===1);assert.deepEqual(f.lookups,[{message_id:99}]);assert.deepEqual(f.downloads,['https://gchat.qpic.cn/synthetic-7.png']);assert.doesNotMatch(JSON.stringify(f.calls),/quoted-caption|gchat/);
});
for(const label of ['cross_group','missing_group','wrong_sender','expired','multi'])test('quoted '+label+' cannot produce a model image request and next text recovers',async t=>{
  const privateChat=label==='wrong_sender',f=await fixture(t,{changes:{context_ttl_minutes:10},lookup:async({message_id})=>({message_id,message_type:privateChat?'private':'group',...(!privateChat&&label!=='missing_group'?{group_id:label==='cross_group'?50002:50001}:{}),time:Math.floor(Date.now()/1000)-(label==='expired'?601:10),sender:{user_id:label==='wrong_sender'?60003:60001},message:label==='multi'?[image(1),image(2)]:[image()]})});
  const extra=privateChat?{message_type:'private',sub_type:'friend',group_id:undefined}:{};f.offer(msg(50,[reply(90),...(!privateChat?[at]:[]),text('这张图是什么')],extra));await until(()=>f.ai.active===0&&f.ai.counts.failed===1);assert.equal(f.sends.length,0);assert.equal(f.calls.length,0);assert.equal(f.downloads.length,0);assert.equal(f.ai.blocked,false);
  f.offer(msg(51,[...(!privateChat?[at]:[]),text('请解释排序算法')],extra));await until(()=>f.ai.counts.sent===1);assert.equal(f.sends.length,1);
});
test('two-minute cache expiry, capacity eviction and clear cannot silently choose a discarded candidate',()=>{
  let now=1000000;const cache=new RecentVisionImages(()=>now),c={...config(),context_ttl_minutes:2},raw=msg(1,[image()],{time:1000}),e={...normalizeEvent(raw),self_id:'90001',message_id:'1'};cache.put(e,raw,c);assert.equal(cache.recent(e,c).sourceId,'1');now+=120001;assert.throws(()=>cache.recent(e,c),/vision_no_recent_image/);
  for(let n=1;n<=51;n++){const r=msg(n,[image(n)],{time:Math.floor(now/1000)});cache.put({...normalizeEvent(r),self_id:'90001',message_id:String(n)},r,c);}assert.equal(cache.state().messages,50);assert.throws(()=>cache.recent(e,c),/vision_image_ambiguous/);assert.ok(cache.state().bytes<=8*1024*1024);cache.clear();assert.equal(cache.state().messages,0);
});
test('quoted lookup cancellation is bounded without retry or user-content persistence',async()=>{
  const controller=new AbortController(),c=config(),e={self_id:'90001',conversation_type:'group',peer_id:'50001',user_id:'60001',message_id:'1'},cache=new RecentVisionImages();let calls=0;
  const task=resolveVisionReference(e,'99',c,cache,{call:()=>{calls++;return new Promise(()=>{});}},controller.signal);controller.abort();await assert.rejects(task,e=>e.name==='AbortError');assert.equal(calls,1);
});
test('withdrawing the source during generation cancels its reply and never revives it',async t=>{
  let finish;const f=await fixture(t,{generate:()=>new Promise(r=>{finish=r;})});f.offer(msg(60,[image()]));f.offer(msg(61,[at,text('这张图是什么')]));await until(()=>f.calls.length===1);
  f.ai.fastRecall({post_type:'notice',notice_type:'group_recall',self_id:90001,group_id:50001,user_id:60001,operator_id:60001,message_id:60});finish('late synthetic response');await until(()=>f.ai.active===0);assert.equal(f.sends.length,0);
});
test('ordinary OCR concept question is text-only even with a recent photo',async t=>{
  const f=await fixture(t);f.offer(msg(70,[image()]));f.offer(msg(71,[at,text('什么是OCR？')]));await until(()=>f.ai.counts.sent===1);assert.equal(f.calls[0][5].image,undefined);assert.equal(f.downloads.length,0);
});
test('unrecognized private raw event records only safe metadata, never its body or account id',async t=>{
  const f=await fixture(t);f.ai.observe(msg(80,[text('synthetic-private-secret')],{message_type:'private',sub_type:'group',group_id:undefined}));const stats=f.ai.state().trigger_checks;assert.equal(stats.private_raw_received,1);assert.equal(stats.private_raw_last.reason,'private_nonfriend_session');assert.doesNotMatch(JSON.stringify(stats),/synthetic-private|60001|90001/);
});
test('fresh private integer-second timestamp is not older than a millisecond connection watermark',async t=>{
  const f=await fixture(t);const now=Date.now();f.ai.privateLiveSince=Math.floor(now/1000)*1000+999;
  f.offer(msg(90,[text('请解释排序算法')],{message_type:'private',sub_type:'friend',group_id:0,time:Math.floor(now/1000)}));await until(()=>f.ai.counts.sent===1);assert.equal(f.ai.inputStats.private_last_result,'accepted');
});
test('scope activation changes only the two approved scope flags and is bound to current verified target',async t=>{
  const f=await fixture(t,{changes:{vision_reference_enabled:false,vision_recent_enabled:false}}),before=structuredClone(f.ai.config);
  await assert.rejects(f.ai.configureVisionScope({expected_base:'https://other.invalid/v1',expected_model:VISION_MODEL,references:true,recent:true}),/vision_not_verified/);
  await f.ai.configureVisionScope({expected_base:VISION_BASE,expected_model:VISION_MODEL,references:true,recent:true});const after=structuredClone(f.ai.config);assert.equal(after.vision_reference_enabled,true);assert.equal(after.vision_recent_enabled,true);after.vision_reference_enabled=false;after.vision_recent_enabled=false;assert.deepEqual(after,before);assert.equal(f.calls.length,0);assert.equal(f.sends.length,0);
});
