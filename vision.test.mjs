import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AIChat} from './ai-chat.mjs';
import {AIProviders} from './ai-providers.mjs';
import {AIError} from './ai-auth.mjs';
import {MemorySecrets} from './ai-storage.mjs';
import {AI_DEFAULTS,validateAISettings} from './ai-config.mjs';
import {apiBinding} from './ai-api-draft.mjs';
import {ResendQueue} from './send-queue.mjs';
import {makeVisionProbe,prepareVisionImage,visionEnabled,wantsVision,VISION_BASE,VISION_MODEL,VISION_MAX_BYTES} from './ai-vision.mjs';
const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('synthetic timeout');};
const probe=makeVisionProbe(),png=Buffer.from(probe.image.dataURL.split(',')[1],'base64');
const text=value=>({type:'text',data:{text:value}}),image=()=>({type:'image',data:{url:'https://gchat.qpic.cn/synthetic.png'}});
const raw=(id,privateChat=false,extra={})=>({post_type:'message',message_type:privateChat?'private':'group',sub_type:privateChat?'friend':undefined,self_id:90001,user_id:60001,...(!privateChat?{group_id:50001}:{}),message_id:id,time:Math.ceil(Date.now()/1000),message:[...(!privateChat?[{type:'at',data:{qq:90001}}]:[]),image(),text('请识图并描述这张图片')],...extra});
async function fixture(t,{changes={},generate,imageFetcher=async()=>new Response(png,{headers:{'content-type':'image/png'}})}={}){
  const dir=await mkdtemp(join(tmpdir(),'vision-mock-')),calls=[],sends=[];
  const app={selfId:'90001',connected:true,onlineConfirmed:true,sendQueue:new ResendQueue({intervalMs:0,jitterMs:0}),client:{call:async(action,body)=>{sends.push({action,body});return{message_id:80000+sends.length};}}};
  const ai=new AIChat({dir,app,secrets:new MemorySecrets(),imageFetcher,provider:{generate:async(...args)=>{calls.push(args);return generate?generate(...args):'这是由几种颜色构成的示意图。';}}});await ai.initialize();
  ai.config={...structuredClone(AI_DEFAULTS),enabled:true,binding_qq:'90001',groups:['50001'],api_base_url:VISION_BASE,api_model:VISION_MODEL,api_platform:'intern_discovery',cooldown_seconds:0,vision_enabled:true,vision_target:VISION_BASE,vision_model:VISION_MODEL,vision_verified_at:Date.now(),...changes};
  ai.auth.meta.api_configured=true;ai.auth.meta.api_id='synthetic';ai.auth.meta.api_binding=apiBinding(ai.config);
  t.after(async()=>{ai.dispose();await ai.budgetTask.catch(()=>{});await ai.settingsFile.task.catch(()=>{});await ai.diagnostics.file.task.catch(()=>{});await rm(dir,{recursive:true,force:true});});return{ai,calls,sends,dir};
}
test('image_url data URL uses the exact configured Discovery alias and only current text/image',async()=>{
  let posted;const p=new AIProviders({auth:{readAPIFor:async()=> 'synthetic-key'},fetcher:async(u,o)=>{assert.equal(u,VISION_BASE+'/chat/completions');posted=JSON.parse(o.body);return new Response('data: '+JSON.stringify({choices:[{delta:{content:'synthetic-result'},finish_reason:'stop'}]})+'\n\n',{headers:{'content-type':'text/event-stream'}});}});
  const c={...AI_DEFAULTS,api_platform:'intern_discovery',api_base_url:VISION_BASE,api_model:VISION_MODEL};assert.equal(await p.generate(c,[],'current request',undefined,()=>{},{image:probe.image}),'synthetic-result');
  assert.equal(posted.model,VISION_MODEL);assert.deepEqual(posted.messages.at(-1).content,[{type:'text',text:'current request'},{type:'image_url',image_url:{url:probe.image.dataURL}}]);assert.equal(posted.messages.length,2);
  await assert.rejects(p.generate({...c,api_model:'other'},[],'new',undefined,()=>{},{image:probe.image}),/vision_model_unsupported/);
});
for(const privateChat of [false,true])test((privateChat?'private':'group')+' explicit single fresh image succeeds and does not enter later image history or disk',async t=>{
  const f=await fixture(t);assert.equal(f.ai.offer(raw(1,privateChat)),true);await until(()=>f.ai.counts.sent===1);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].length,0);assert.equal(f.calls[0][5].image.mime,'image/png');assert.equal(f.ai.active,0);
  const next=raw(2,privateChat,{message:[...(!privateChat?[{type:'at',data:{qq:90001}}]:[]),text('请再解释一下这个结果')]});f.ai.offer(next);await until(()=>f.ai.counts.sent===2);
  assert.equal(f.calls[1][5].image,undefined);assert.doesNotMatch(JSON.stringify(f.calls[1][1]),/base64|qpic|image_url/);
  for(const name of await readdir(f.dir))if(!name.endsWith('.tmp'))assert.doesNotMatch(await readFile(join(f.dir,name),'utf8'),/gchat|data:image|base64|示意图/);
});
test('unsolicited, stale, history, quoted and multiple pictures cannot become a model image request',async t=>{
  const f=await fixture(t);
  assert.equal(f.ai.offer(raw(10,false,{message:[image(),text('普通附件')]})),false);
  for(const extra of [{time:1},{from_history:true},{message_source:'history'}])assert.equal(f.ai.offer(raw(11,false,extra)),false);
  assert.equal(f.ai.offer(raw(12,false,{message:[{type:'at',data:{qq:90001}},{type:'reply',data:{id:999}},image(),text('请识图')]})),true);await until(()=>f.ai.active===0&&f.ai.counts.failed===1);
  assert.equal(f.calls.length,0);assert.equal(f.ai.blocked,false);assert.equal(f.ai.privateHolds.size,0);
  assert.equal(f.ai.offer(raw(13,true,{message:[image(),image(),text('请识图')]})),true);await until(()=>f.ai.active===0&&f.ai.counts.failed===2);assert.equal(f.calls.length,0);
});
for(const mode of ['download','timeout','unsupported','incomplete'])test('vision '+mode+' fails explicitly once and the next text proceeds',async t=>{
  let n=0;const f=await fixture(t,{imageFetcher:async()=>{if(mode==='download')throw new AIError('vision_image_download_failed');if(mode==='timeout'&&n===0){n++;throw new DOMException('synthetic','TimeoutError');}return new Response(png);},generate:async(...args)=>{if(args[5].image&&(mode==='unsupported'||mode==='incomplete'))throw new AIError(mode==='unsupported'?'unsupported_capability':'generation_incomplete',400);return'后续普通文字回复正常。';}});
  f.ai.offer(raw(20,true));await until(()=>f.ai.active===0&&f.ai.counts.failed===1);assert.equal(f.ai.blocked,false);assert.equal(f.ai.privateHolds.size,0);assert.equal([...f.ai.sessions.values()][0].turns.length,0);assert.equal(f.sends.length,0);assert.ok(f.ai.diagnostics.state().generation.errorCode);
  f.ai.offer(raw(21,true,{message:[text('请解释快速排序')]}));await until(()=>f.ai.counts.sent===1);assert.equal(f.sends.length,1);assert.equal(f.ai.error,'');
});
test('image fetch is size/type bounded and refuses local files, private hosts and redirects',async()=>{
  const signal=new AbortController().signal;let fetches=0;const fetcher=async()=>{fetches++;return new Response(png);};
  for(const url of ['file:///C:/private.png','http://127.0.0.1/private','https://outside.invalid/a','https://gchat.qpic.cn@outside.invalid/a'])await assert.rejects(prepareVisionImage({url},signal,fetcher),/vision_image_source_unsupported/);assert.equal(fetches,0);
  await assert.rejects(prepareVisionImage({url:'https://gchat.qpic.cn/a'},signal,async()=>new Response('x',{headers:{'content-length':String(VISION_MAX_BYTES+1)}})),/vision_image_too_large/);
  await assert.rejects(prepareVisionImage({url:'https://gchat.qpic.cn/a'},signal,async()=>new Response('<html>not an image</html>')),/vision_image_format_unsupported/);
  const result=await prepareVisionImage({url:'http://gchat.qpic.cn/a'},signal,async(u,o)=>{assert.match(u,/^https:/);assert.equal(o.redirect,'error');assert.deepEqual(Object.keys(o.headers),['Accept']);return new Response(png);});assert.equal(result.mime,'image/png');
});
test('hanging image body/cancel is stopped by deadline without holding the next operation',async()=>{
  const alive=setTimeout(()=>{},200);try{await assert.rejects(prepareVisionImage({url:'https://gchat.qpic.cn/a'},new AbortController().signal,async()=>new Response(new ReadableStream({cancel(){return new Promise(()=>{});}})),15),/vision_download_timeout/);}finally{clearTimeout(alive);}
});
test('blacklist, current group, model binding and ChatGPT owner scope remain enforced',async t=>{
  const f=await fixture(t,{changes:{group_blacklist:['60001'],private_blacklist:['60001']}});assert.equal(f.ai.offer(raw(30)),false);assert.equal(f.ai.offer(raw(31,true)),false);assert.equal(f.calls.length,0);
  const c={...AI_DEFAULTS,api_base_url:VISION_BASE,api_model:VISION_MODEL,vision_enabled:true,vision_target:VISION_BASE,vision_model:VISION_MODEL,vision_verified_at:Date.now()};assert.equal(visionEnabled(validateAISettings(c)),true);assert.throws(()=>validateAISettings({...c,backend:'chatgpt'}));assert.throws(()=>validateAISettings({...c,api_model:'different'}));assert.equal(visionEnabled(AI_DEFAULTS),false);
});
test('credentials recognized in OCR result are not delivered or committed to history',async t=>{
  const f=await fixture(t,{generate:async()=> '密码是synthetic-only'});f.ai.offer(raw(40,true));await until(()=>f.ai.active===0&&f.ai.counts.failed===1);assert.equal(f.sends.length,0);assert.equal(f.ai.error,'vision_output_credentials');assert.doesNotMatch(JSON.stringify(f.sends),/synthetic-only/);assert.equal([...f.ai.sessions.values()][0].turns.length,0);assert.equal(f.ai.blocked,false);
});
test('vision activation requires an exact target-bound successful probe',async t=>{
  const f=await fixture(t,{changes:{vision_enabled:false,vision_target:'',vision_model:'',vision_verified_at:0}});await assert.rejects(f.ai.configureVision({enabled:true}),/vision_not_verified/);
  f.ai.visionVerification={supported:true,base:VISION_BASE,model:VISION_MODEL,checkedAt:Date.now(),protocol:'chat_completions_image_url_data_url'};await f.ai.configureVision({enabled:true});assert.equal(f.ai.state().capabilities.image,true);
});
test('explicit common captions work; reply-only request stays a local error without fetching history',async t=>{
  for(const caption of ['请识图','帮我看一下这张图片','这图是啥','请OCR提取文字'])assert.equal(wantsVision(caption),true);
  const f=await fixture(t);f.ai.offer(raw(50,true,{message:[{type:'reply',data:{id:99999}},text('请识图')]}));await until(()=>f.ai.active===0&&f.ai.counts.failed===1);
  assert.equal(f.calls.length,0);assert.equal(f.sends.length,0);assert.match(f.ai.error,/^vision_/);
  f.ai.offer(raw(51,true,{message:[text('请解释排序算法')]}));await until(()=>f.ai.counts.sent===1);assert.match(f.calls[0][0].instructions,/没有当前图片输入/);
});
