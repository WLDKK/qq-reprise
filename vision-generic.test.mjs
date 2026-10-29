import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inflateSync} from 'node:zlib';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {AIChat} from './ai-chat.mjs';
import {AIProviders} from './ai-providers.mjs';
import {AIError} from './ai-auth.mjs';
import {MemorySecrets} from './ai-storage.mjs';
import {AI_DEFAULTS,validateAISettings} from './ai-config.mjs';
import {apiBinding} from './ai-api-draft.mjs';
import {ResendQueue} from './send-queue.mjs';
import {AINetwork} from './ai-network.mjs';
import {APITestController} from './ai-test-ui.mjs';
import {validateAIHandoff} from './ai-state-handoff.mjs';
import {VISION_ERRORS,visionTarget,visionEnabled,visionLimits,makeVisionProbe,prepareVisionImages,RecentVisionImages} from './ai-vision.mjs';

const until=async f=>{for(let n=0;n<400;n++){if(f())return;await new Promise(r=>setTimeout(r,5));}assert.fail('synthetic operation did not finish');};
const config=(format='responses',count=2,enabled=true)=>({...structuredClone(AI_DEFAULTS),enabled:true,binding_qq:'90001',groups:['50001','50002'],api_platform:'custom',api_base_url:'https://vision-a.example.invalid/v1',api_model:'synthetic-vision-model',api_format:format,vision_enabled:enabled,vision_target:enabled?'https://vision-a.example.invalid/v1':'',vision_model:enabled?'synthetic-vision-model':'',vision_format:enabled?format:'',vision_verified_images:enabled?count:0,vision_verified_at:enabled?Date.now():0,vision_max_images:count,vision_reference_enabled:enabled,vision_recent_enabled:enabled,vision_instruction_grace_ms:0,cooldown_seconds:0});
const probes=[makeVisionProbe(),makeVisionProbe()],png=Buffer.from(probes[0].image.dataURL.split(',')[1],'base64');
const img=n=>({type:'image',data:{url:`https://gchat.qpic.cn/generic-synthetic-${n}.png`}});
const text=s=>({type:'text',data:{text:s}}),at={type:'at',data:{qq:90001}},reply=n=>({type:'reply',data:{id:n}});
const message=(n,parts,extra={})=>({post_type:'message',message_type:'group',self_id:90001,user_id:60001,group_id:50001,message_id:n,time:Math.floor(Date.now()/1000),message:parts,...extra});
function sse(format,text){return new Response(format==='responses'?`data: ${JSON.stringify({type:'response.output_text.delta',delta:text})}\n\ndata: {"type":"response.completed"}\n\n`:`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})}\n\n`,{headers:{'content-type':'text/event-stream'}});}
function probeWords(dataURL){
 const bytes=Buffer.from(dataURL.split(',')[1],'base64'),chunks=[];for(let p=8;p+12<=bytes.length;){const len=bytes.readUInt32BE(p);if(bytes.toString('ascii',p+4,p+8)==='IDAT')chunks.push(bytes.subarray(p+8,p+8+len));p+=len+12;}
 const raw=inflateSync(Buffer.concat(chunks)),names={'255,0,0':'red','0,255,0':'green','0,0,255':'blue','255,255,0':'yellow'};
 return [[16,16],[48,16],[16,48],[48,48]].map(([x,y])=>names[[...raw.subarray(y*193+1+x*3,y*193+4+x*3)].join(',')]).join(' ');
}
async function fixture(t,{format='responses',count=2,enabled=true,changes={},generate,fetcher,lookup,imageFetcher}={}){
 const dir=await mkdtemp(join(tmpdir(),'generic-vision-mock-')),calls=[],downloads=[],sends=[],lookups=[],secrets=new MemorySecrets();secrets.api='synthetic-generic-only';
 const app={selfId:'90001',connected:true,onlineConfirmed:true,sendQueue:new ResendQueue({intervalMs:0,jitterMs:0}),client:{call:async(action,body)=>{if(action==='get_msg'){lookups.push(body);return lookup(body);}sends.push({action,body});return{message_id:80000+sends.length};}}};
 const provider=fetcher?undefined:{generate:async(...args)=>{calls.push(structuredClone({config:args[0],history:args[1],prompt:args[2],options:args[5]}));return generate?generate(...args):'合成图比较结果。';}};
 const ai=new AIChat({dir,app,secrets,poolSecrets:new MemorySecrets(),provider,fetcher,imageFetcher:async(u,o)=>{downloads.push(u);return imageFetcher?imageFetcher(u,o):new Response(png);}});await ai.initialize();ai.config=validateAISettings({...config(format,count,enabled),...changes});
 ai.auth.meta.api_configured=true;ai.auth.meta.api_id='synthetic-credential';ai.auth.meta.api_binding=apiBinding(ai.config);
 t.after(async()=>{ai.dispose();await ai.budgetTask.catch(()=>{});await ai.settingsFile.task.catch(()=>{});await ai.diagnostics.file.task.catch(()=>{});await rm(dir,{recursive:true,force:true});});
 return{dir,ai,calls,downloads,sends,lookups,offer:event=>{ai.observe(event);return ai.offer(event);}};
}

for(const format of ['responses','chat_completions'])test(format+' serializes current multi-image parts and strips historical image parts',async()=>{
 let body,reads=0;const provider=new AIProviders({auth:{readAPIFor:async()=>{reads++;return'synthetic-only';}},fetcher:async(u,o)=>{assert.equal(u,'https://vision-a.example.invalid/v1/'+(format==='responses'?'responses':'chat/completions'));body=JSON.parse(o.body);return sse(format,'synthetic result');}});
 const history=[{role:'user',content:[{type:'text',text:'old text only'},{type:'image_url',image_url:{url:'https://old.invalid/never-send'}}]}];
 assert.equal(await provider.generate(config(format),history,'compare these',undefined,()=>{},{images:probes.map(p=>p.image)}),'synthetic result');
 const messages=format==='responses'?body.input:body.messages,last=messages.at(-1).content;
 assert.equal(last.length,3);assert.equal(last[0].type,format==='responses'?'input_text':'text');assert.deepEqual(last.slice(1).map(p=>p.type),Array(2).fill(format==='responses'?'input_image':'image_url'));
 assert.deepEqual(last.slice(1).map(p=>format==='responses'?p.image_url:p.image_url.url),probes.map(p=>p.image.dataURL));assert.doesNotMatch(JSON.stringify(body),/old\.invalid/);assert.equal(reads,1);
});
test('an arbitrary model is not a verified vision model and normal image calls stop before credential access',async()=>{
 const c=config('responses',2,false),provider=new AIProviders({auth:{readAPIFor:async()=>assert.fail('No credential read for unverified image')},fetcher:async()=>assert.fail('No HTTP')});
 assert.equal(visionTarget(c),true);assert.equal(visionEnabled(c),false);await assert.rejects(provider.generate(c,[],'see',undefined,()=>{},{images:[probes[0].image]}),/vision_not_verified/);
});
for(const field of ['api_base_url','api_format','api_model'])test('proof cannot cross '+field,()=>{
 const c=config(),other={...c,[field]:field==='api_base_url'?'https://vision-b.example.invalid/other':field==='api_format'?'chat_completions':'other-model'};
 assert.equal(visionEnabled(other),false);assert.throws(()=>validateAISettings(other));
});
test('larger picture count requires a new count-bound proof',()=>{const c=config('responses',1);assert.equal(visionEnabled({...c,vision_max_images:2}),false);assert.throws(()=>validateAISettings({...c,vision_max_images:2}));});
for(const format of ['responses','chat_completions'])test(format+' synthetic verification uses the saved target and does not enable image export',async t=>{
 let calls=0;const f=await fixture(t,{format,enabled:false,fetcher:async(u,o)=>{calls++;const b=JSON.parse(o.body),parts=(format==='responses'?b.input:b.messages).at(-1).content;const urls=parts.slice(1).map(v=>format==='responses'?v.image_url:v.image_url.url);assert.equal(urls.length,2);return sse(format,urls.map(probeWords).join(' '));}});
 const before=structuredClone(f.ai.config),r=await f.ai.testVision();assert.equal(r.ok,true);assert.equal(r.imageCount,2);assert.equal(calls,1);assert.equal(f.ai.config.vision_enabled,false);assert.deepEqual(f.ai.config,before);assert.equal(f.sends.length,0);
 await f.ai.configureVisionSettings({vision_enabled:true,vision_reference_enabled:false,vision_recent_enabled:false});assert.equal(f.ai.state().capabilities.image,true);assert.equal(f.ai.config.vision_format,format);assert.equal(f.ai.config.vision_verified_images,2);
 for(const file of await readdir(f.dir))if(!file.endsWith('.tmp'))assert.doesNotMatch(await readFile(join(f.dir,file),'utf8'),/data:image|base64|synthetic-generic-only/);
});
for(const status of [400,403,429])test('vision HTTP '+status+' does not create a successful proof or retry',async t=>{
 let calls=0;const f=await fixture(t,{enabled:false,fetcher:async()=>{calls++;return Response.json({error:{code:status===400?'unsupported_capability':status===403?'access_denied':'rate_limit_exceeded',message:'synthetic upstream private detail'}},{status});}});const r=await f.ai.testVision();assert.equal(r.ok,false);assert.equal(r.http_status,status);assert.equal(f.ai.visionVerification,null);assert.equal(calls,1);assert.equal(f.ai.config.vision_enabled,false);assert.doesNotMatch(JSON.stringify(r),/private detail|synthetic-generic-only/);
});
test('text-only or mismatching vision answer is not a successful visual verification',async t=>{const f=await fixture(t,{enabled:false,fetcher:async()=>sse('responses','I cannot see images')});const r=await f.ai.testVision();assert.equal(r.ok,false);assert.equal(r.error_code,'vision_probe_mismatch');await assert.rejects(f.ai.configureVision({enabled:true}),/vision_not_verified/);});
test('duplicate verification, wrong-operation cancel and late completion are isolated',async t=>{
 let finish;const f=await fixture(t,{enabled:false,generate:()=>new Promise(r=>{finish=r;})}),id='00000000-0000-4000-8000-000000000001';const pending=f.ai.testVision({test_id:id});await until(()=>f.calls.length===1);
 await assert.rejects(f.ai.testVision(),/generation_in_progress/);assert.equal(f.ai.cancelTest({test_id:'other'}).cancel_requested,false);assert.equal(f.ai.cancelTest({test_id:id}).upstream_cancel_confirmed,false);const result=await pending;assert.equal(result.ok,false);assert.equal(result.error_code,'test_cancelled');finish('red green blue yellow red green blue yellow');await new Promise(r=>setTimeout(r,10));assert.equal(f.ai.visionVerification,null);assert.equal(f.ai.testController,null);
});
test('ignored provider abort still meets the configured verification deadline',async t=>{
 const f=await fixture(t,{enabled:false,changes:{vision_request_timeout_seconds:1},generate:()=>new Promise(()=>{})});const began=Date.now(),r=await f.ai.testVision();assert.equal(r.ok,false);assert.equal(r.error_code,'request_timeout');assert.ok(Date.now()-began<1800);assert.equal(f.ai.testController,null);
});
test('changing the saved model cancels verification and invalidates all vision scopes',async t=>{
 let finish;const f=await fixture(t,{enabled:false,generate:()=>new Promise(r=>{finish=r;})});const pending=f.ai.testVision();await until(()=>f.calls.length===1);await f.ai.configure({...f.ai.config,enabled:false,api_model:'next-synthetic-model'});const r=await pending;finish('red green blue yellow');assert.equal(r.ok,false);assert.equal(f.ai.visionVerification,null);assert.equal(f.ai.config.vision_enabled,false);assert.equal(f.ai.config.vision_verified_at,0);assert.equal(f.ai.config.vision_format,'');
});
test('generic settings cannot forge a successful visual proof',async t=>{const f=await fixture(t,{enabled:false});await assert.rejects(f.ai.configure({...config(),enabled:false}),/vision_not_verified/);assert.equal(f.ai.config.vision_enabled,false);assert.equal(f.calls.length,0);});
test('current two-image message sends exactly that bundle, with no cached extra image',async t=>{
 const f=await fixture(t);f.offer(message(1,[img(99)]));assert.equal(f.offer(message(2,[at,img(1),img(2),text('请比较这些图片')])),true);await until(()=>f.ai.counts.sent===1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.images.length,2);assert.deepEqual(f.downloads,['https://gchat.qpic.cn/generic-synthetic-1.png','https://gchat.qpic.cn/generic-synthetic-2.png']);assert.doesNotMatch(JSON.stringify(f.calls[0].history),/image_url|base64|qpic/);
});
test('one explicitly quoted same-chat multi-image message is selected without source caption',async t=>{
 const f=await fixture(t);f.offer(message(10,[img(1),img(2),text('do-not-export-source-caption')],{user_id:60002}));f.offer(message(11,[reply(10),at,text('对比这些图片')]));await until(()=>f.ai.counts.sent===1);assert.equal(f.calls[0].options.images.length,2);assert.equal(f.lookups.length,0);assert.doesNotMatch(JSON.stringify(f.calls),/do-not-export-source-caption/);
});
test('recent same-author album is supported, while several independent messages stay ambiguous',async t=>{
 const f=await fixture(t);f.offer(message(20,[img(1),img(2)]));f.offer(message(21,[at,text('这些图片是什么')]));await until(()=>f.ai.counts.sent===1);assert.equal(f.calls[0].options.images.length,2);
 f.offer(message(22,[img(3)]));f.offer(message(23,[at,text('这些图片是什么')]));await until(()=>f.ai.active===0&&f.ai.counts.failed===1);assert.equal(f.ai.error,'vision_image_ambiguous');assert.equal(f.calls.length,1);
});
test('uncached quote verifies its conversation before downloading every image',async t=>{
 const f=await fixture(t,{lookup:async({message_id})=>({message_id,message_type:'group',group_id:50002,time:Math.floor(Date.now()/1000),sender:{user_id:60002},message:[img(1),img(2)]})});f.offer(message(30,[reply(99),at,text('比较这些图片')]));await until(()=>f.ai.active===0&&f.ai.counts.failed===1);assert.equal(f.lookups.length,1);assert.equal(f.downloads.length,0);assert.equal(f.calls.length,0);assert.equal(f.ai.error,'vision_reference_scope_unknown');
});
test('configured picture-count limit rejects the whole request before downloads',async t=>{const f=await fixture(t,{count:1});f.offer(message(40,[at,img(1),img(2),text('请识图')]));await until(()=>f.ai.active===0&&f.ai.counts.failed===1);assert.equal(f.ai.error,'vision_image_count_exceeded');assert.equal(f.downloads.length,0);assert.equal(f.calls.length,0);});
test('per-image and cumulative byte ceilings are checked before model submission',async()=>{
 const bytes=Buffer.concat([png,Buffer.alloc(700-png.length)]),base={...config(),vision_max_image_bytes:1024,vision_max_total_bytes:1024};let calls=0;
 await assert.rejects(prepareVisionImages([img(1).data,img(2).data],new AbortController().signal,async()=>{calls++;return new Response(bytes,{headers:{'content-length':'700'}});},base),/vision_total_bytes_exceeded/);assert.equal(calls,2);
 await assert.rejects(prepareVisionImages([img(1).data],new AbortController().signal,async()=>new Response(Buffer.alloc(1025)),base),/vision_image_too_large/);
});
test('image redirect, authenticated URL and local file cannot be followed',async()=>{
 let calls=0;for(const input of [{file:'C:\\private.png'},{url:'https://user:synthetic@gchat.qpic.cn/a'},{url:'https://127.0.0.1/a'}])await assert.rejects(prepareVisionImages([input],new AbortController().signal,async()=>{calls++;return new Response(png);},config()),/vision_image_source_unsupported/);assert.equal(calls,0);
 await assert.rejects(prepareVisionImages([img(1).data],new AbortController().signal,async(u,o)=>{assert.equal(o.redirect,'error');return Response.redirect('https://outside.invalid/a');},config()),/vision_image_download_failed/);
});
test('cancelling a stalled second picture never submits a partial bundle',async t=>{
 let signal;const f=await fixture(t,{imageFetcher:async(u,o)=>{signal=o.signal;return u.includes('-1.png')?new Response(png):new Promise(()=>{});}});f.offer(message(50,[at,img(1),img(2),text('比较这些图片')]));await until(()=>f.downloads.length===2);f.ai.fastRecall({post_type:'notice',notice_type:'group_recall',self_id:90001,group_id:50001,user_id:60001,operator_id:60001,message_id:50});await until(()=>f.ai.active===0);assert.equal(signal.aborted,true);assert.equal(f.calls.length,0);assert.equal(f.sends.length,0);
});
test('vision limits save is narrow, survives reload and a larger count disables old permission',async t=>{
 const f=await fixture(t,{count:1}),before=structuredClone(f.ai.config);await f.ai.network.configure({mode:'manual',proxy_url:'http://synthetic-proxy.invalid:8123'});const net=structuredClone(f.ai.network.config);
 await f.ai.configureVisionLimits({...visionLimits(f.ai.config),vision_max_images:2,vision_download_timeout_seconds:7});assert.equal(f.ai.config.enabled,before.enabled);assert.equal(f.ai.config.vision_enabled,false);assert.deepEqual(f.ai.config.groups,before.groups);assert.deepEqual(f.ai.network.config,net);const saved=JSON.parse(await readFile(join(f.dir,'ai-settings.json'),'utf8'));assert.equal(validateAISettings(saved).vision_max_images,2);assert.equal(f.calls.length,0);
});
for(const format of ['responses','chat_completions'])test(format+' images reuse the saved AI-only manual proxy without global mutation',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vision-network-mock-')),agents=[],calls=[],beforeFetch=globalThis.fetch;
 const network=new AINetwork({dir,agent:(secure,options)=>{const a={options,destroy(){}};agents.push(a);return a;},request:(url,options,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{calls.push({url:url.href,options,body:JSON.parse(body)});queueMicrotask(()=>{const stream=Readable.from([Buffer.from(format==='responses'?'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed"}\n\n':'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n')]);stream.statusCode=200;stream.rawHeaders=['Content-Type','text/event-stream'];callback(stream);});};return req;}});await network.initialize();await network.configure({mode:'manual',proxy_url:'http://synthetic-proxy.invalid:8123'});
 t.after(async()=>{network.dispose();await network.file.task;await rm(dir,{recursive:true,force:true});});const provider=new AIProviders({auth:{readAPIFor:async()=>'synthetic-only'},fetcher:network.fetch});await provider.generate(config(format),[],'compare',undefined,()=>{},{images:probes.map(p=>p.image)});assert.equal(calls.length,1);assert.equal(agents[0].options.proxyEnv.https_proxy,'http://synthetic-proxy.invalid:8123');assert.equal(calls[0].url.includes('qpic'),false);assert.equal(network.config.mode,'manual');assert.equal(globalThis.fetch,beforeFetch);
});
test('multi-image options never enter account-pool failover even when a request id is present',async t=>{
 const f=await fixture(t);f.ai.poolService.manager={enabled:true};const options={images:probes.map(p=>p.image),requestId:'synthetic-current'};await f.ai.poolService.generate(f.ai.config,[],'compare',new AbortController().signal,()=>{},options);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].config.api_base_url,f.ai.config.api_base_url);f.ai.poolService.manager=null;
});
test('vision UI controller uses the vision endpoint, suppresses duplicate clicks and finalizes cancellation',async()=>{
 let finish;const calls=[],states=[],controller=new APITestController({action:'test-vision',id:()=> '00000000-0000-4000-8000-000000000002',post:async(action,body)=>{calls.push({action,body});if(action==='cancel-test')return{cancel_requested:true};return new Promise(r=>{finish=r;});},render:s=>states.push(s),refreshMs:10});
 const pending=controller.start({target:{timeout_seconds:1}});assert.deepEqual(await controller.start({}),{busy:true});await controller.cancel();await pending;finish({ok:true});await new Promise(r=>setTimeout(r,5));assert.equal(calls[0].action,'test-vision');assert.equal(calls.filter(c=>c.action==='test-vision').length,1);assert.equal(states.at(-1).status,'cancelled');assert.equal(states.at(-1).upstream_cancel_confirmed,false);
});
test('all bounded vision errors survive controlled handoff, while arbitrary error text remains rejected',()=>{
 const now=Date.now(),base={version:1,bindingQQ:'90001',createdAt:now,blocked:false,error:'',privateReviewFull:false,privateHolds:[]};for(const error of VISION_ERRORS)assert.equal(validateAIHandoff({...base,error},'90001',now).error,error);assert.throws(()=>validateAIHandoff({...base,error:'vision_private-token-example'},'90001',now));
});
test('whole vision deadline also interrupts a stalled local budget wait',async t=>{
 const f=await fixture(t,{changes:{vision_request_timeout_seconds:1}});f.ai.reserveBudget=()=>new Promise(()=>{});f.offer(message(60,[at,img(1),text('请识图')]));await until(()=>f.ai.active===0&&f.ai.counts.failed===1);assert.equal(f.ai.error,'vision_request_timeout');assert.equal(f.calls.length,0);assert.equal(f.sends.length,0);
});
test('cancelled/expired verification does not hang on diagnostic persistence',async t=>{
 const f=await fixture(t,{enabled:false,changes:{vision_request_timeout_seconds:1},generate:async(...args)=>args[5].images.map(v=>probeWords(v.dataURL)).join(' ')});f.ai.diagnostics.finish=()=>new Promise(()=>{});const began=Date.now(),r=await f.ai.testVision();assert.equal(r.ok,false);assert.equal(r.error_code,'request_timeout');assert.equal(f.ai.testController,null);assert.equal(f.ai.visionVerification,null);assert.ok(Date.now()-began<1800);
});
test('empty image arrays and malformed verification metadata fail before network calls',async t=>{
 const provider=new AIProviders({auth:{readAPIFor:async()=>assert.fail('No key read')},fetcher:async()=>assert.fail('No HTTP')});await assert.rejects(provider.generate(config(),[],'read',undefined,()=>{},{images:[]}),/vision_image_missing/);
 const f=await fixture(t,{enabled:false});for(const input of [[],{target:null},{expected_base:'https://other.example.invalid/v1'}])await assert.rejects(f.ai.testVision(input));assert.equal(f.calls.length,0);
});
test('uncached same-chat quote can select a whole album and no other message',async t=>{
 const f=await fixture(t,{lookup:async({message_id})=>({message_id,message_type:'group',group_id:50001,time:Math.floor(Date.now()/1000),sender:{user_id:60002},message:[img(1),img(2)]})});f.offer(message(70,[reply(99),at,text('比较这些图片')]));await until(()=>f.ai.counts.sent===1);assert.deepEqual(f.lookups,[{message_id:99}]);assert.equal(f.calls[0].options.images.length,2);assert.equal(f.downloads.length,2);
});
test('a large animated source cannot hide behind a smaller decoded frame in the cumulative limit',async()=>{
 const gif=Buffer.alloc(700);gif.write('GIF89a');gif.writeUInt16LE(1,6);gif.writeUInt16LE(1,8);let decodes=0;
 await assert.rejects(prepareVisionImages([img(1).data,img(2).data],new AbortController().signal,async()=>new Response(gif,{headers:{'content-length':'700'}}),{...config(),vision_max_image_bytes:1024,vision_max_total_bytes:1024},async()=>{decodes++;return png;}),/vision_total_bytes_exceeded/);assert.equal(decodes,1);
});
