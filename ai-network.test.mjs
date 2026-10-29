import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp,readFile,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { AINetwork,validateNetwork,environmentProxy,NETWORK_DEFAULTS,localTarget } from './ai-network.mjs';
import { AIProviders,publicAIError } from './ai-providers.mjs';
import { AI_DEFAULTS } from './ai-config.mjs';
import { AIChat } from './ai-chat.mjs';
import { MemorySecrets } from './ai-storage.mjs';
import { ResendQueue } from './send-queue.mjs';

async function fixture(t,options={}) {
  const dir=await mkdtemp(join(tmpdir(),'ai-network-synthetic-'));
  const network=new AINetwork({dir,...options});await network.initialize();
  t.after(async()=>{network.dispose();await network.file.task.catch(()=>{});await rm(dir,{recursive:true,force:true});});
  return {network,dir};
}
function mockWire({body='OK',status=200,error=null,encoding=null,stall=false}={}) {
  const calls=[],agents=[];
  return {calls,agents,agent:(secure,options)=>{const a={secure,options,destroyed:false,destroy(){this.destroyed=true;}};agents.push(a);return a;},request:(url,options,callback)=>{
    const req=new EventEmitter();req.destroy=e=>{req.destroyed=true;if(e)queueMicrotask(()=>req.emit('error',e));};
    req.end=data=>{calls.push({url:url.href,options,body:data,request:req});if(stall)return;queueMicrotask(()=>{if(error)return req.emit('error',error);const stream=Readable.from([encoding==='gzip'?gzipSync(body):Buffer.from(body)]);stream.statusCode=status;stream.rawHeaders=['Content-Type','text/plain',...(encoding?['Content-Encoding',encoding]:[])];callback(stream);});};return req;
  }};
}
test('default preserves legacy fetch, creates no settings, reads no proxy environment',async t=>{
  let calls=0;const {network,dir}=await fixture(t,{fetcher:async()=>{calls++;return new Response('legacy');},environment:()=>assert.fail('No opt-in')});
  assert.deepEqual(network.config,NETWORK_DEFAULTS);assert.equal(await(await network.fetch('https://service.invalid/v1')).text(),'legacy');assert.equal(calls,1);assert.deepEqual(await readdir(dir),[]);
});
for(const mode of ['direct','environment','manual'])test(mode+' mode is gated on an actually supported runtime',async t=>{
  const {network}=await fixture(t,{runtime:'22.4.0'});await assert.rejects(network.configure({mode,proxy_url:mode==='manual'?'http://proxy.invalid:8123':''}),/ai_network_runtime_unsupported/);
});
for(const value of ['http://synthetic-user:synthetic-pass@proxy.invalid:8123','https://synthetic-user@proxy.invalid:8123'])test('inline authentication is rejected without persistence '+value.split(':')[0],async t=>{
  const {network,dir}=await fixture(t);await assert.rejects(network.configure({mode:'manual',proxy_url:value}),e=>e.code==='proxy_credentials_not_supported'&&!e.message.includes('synthetic'));assert.deepEqual(await readdir(dir),[]);
});
for(const value of ['socks5://proxy.invalid:8123','ftp://proxy.invalid','http://proxy.invalid/path','http://proxy.invalid/?token=synthetic','http://proxy.invalid/#synthetic','http://proxy.invalid:99999','http://proxy.invalid\n'])test('invalid proxy cannot fall back to direct '+value.slice(0,8),()=>{assert.throws(()=>validateNetwork({mode:'manual',proxy_url:value}));});
test('environment selection is explicit, validates both proxies and retains NO_PROXY without disclosure',()=>{
  const selected=environmentProxy({HTTP_PROXY:'http://upper.invalid:8123',http_proxy:'http://lower.invalid:8124',HTTPS_PROXY:'https://secure.invalid:8125',NO_PROXY:'example.invalid'});
  assert.equal(selected.http_proxy,'http://lower.invalid:8124');assert.equal(selected.https_proxy,'https://secure.invalid:8125');assert.match(selected.no_proxy,/example.invalid,localhost,127\.0\.0\.1/);
  assert.throws(()=>environmentProxy({ALL_PROXY:'http://ignored.invalid'}),/proxy_environment_missing/);
  assert.throws(()=>environmentProxy({HTTPS_PROXY:'http://user:synthetic@proxy.invalid'}),/proxy_credentials_not_supported/);
});
for(const host of ['localhost','127.0.0.1','127.0.0.2','[::1]','::1'])test('loopback recognition '+host,()=>assert.equal(localTarget(host),true));
for(const mode of ['direct','environment','manual'])test(mode+' supplies only a private per-request agent and never alters global fetch',async t=>{
  const wire=mockWire(),fetchBefore=globalThis.fetch,agentBefore=http.globalAgent;
  const {network}=await fixture(t,{...wire,environment:()=>({HTTPS_PROXY:'http://env.invalid:8123'})});
  const response=await network.fetch('https://service.invalid/v1',{aiNetwork:{mode,proxy_url:mode==='manual'?'https://manual.invalid:8124':''},headers:{Authorization:'Bearer synthetic-only'},method:'POST',body:'synthetic'});
  assert.equal(await response.text(),'OK');assert.equal(globalThis.fetch,fetchBefore);assert.equal(http.globalAgent,agentBefore);assert.equal(wire.calls.length,1);
  assert.equal(wire.calls[0].options.headers.authorization,'Bearer synthetic-only');assert.equal(Object.hasOwn(wire.calls[0].options.headers,'proxy-authorization'),false);
  const p=wire.agents[0].options.proxyEnv;assert.equal(mode==='direct'?Object.keys(p).length===0:mode==='manual'?p.https_proxy==='https://manual.invalid:8124':p.https_proxy==='http://env.invalid:8123',true);
  assert.equal(network.active,0);
});
test('every explicit network mode forces loopback direct without reading environment',async t=>{
  const wire=mockWire(),{network}=await fixture(t,{...wire,environment:()=>assert.fail('loopback must not inspect proxy secrets')});
  for(const mode of ['direct','environment','manual']){const r=await network.fetch('http://127.0.0.1:8123/mock',{aiNetwork:{mode,proxy_url:mode==='manual'?'http://proxy.invalid:8124':''}});await r.text();assert.deepEqual(wire.agents.at(-1).options.proxyEnv,{});}
});
test('connection refusal exposes a bounded category, not the native message or URL',async t=>{
  const wire=mockWire({error:Object.assign(new Error('private proxy metadata synthetic-secret'),{code:'ECONNREFUSED'})});const {network}=await fixture(t,wire);
  await assert.rejects(network.fetch('https://service.invalid',{aiNetwork:{mode:'manual',proxy_url:'http://proxy.invalid:8123'}}),e=>publicAIError(e)==='network_connection_refused'&&!JSON.stringify(e).includes('synthetic-secret'));
  assert.equal(network.active,0);
});
test('local HTTP transport preserves response/error statuses and decodes gzip',async t=>{
  const server=http.createServer((req,res)=>{assert.equal(req.headers['proxy-authorization'],undefined);res.writeHead(req.url==='/error'?429:200,{'content-type':'application/json','content-encoding':'gzip'});res.end(gzipSync(JSON.stringify({synthetic:true})));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {network}=await fixture(t);for(const path of ['/ok','/error']){const r=await network.fetch('http://127.0.0.1:'+server.address().port+path,{aiNetwork:{mode:'direct'}});assert.equal(r.status,path==='/error'?429:200);assert.deepEqual(await r.json(),{synthetic:true});}
});
test('stalled headers are aborted and cannot keep a private agent alive',async t=>{
  const wire=mockWire({stall:true}),{network}=await fixture(t,wire),controller=new AbortController();
  const pending=network.fetch('https://service.invalid',{aiNetwork:{mode:'manual',proxy_url:'http://proxy.invalid:8123'},signal:controller.signal});controller.abort();await assert.rejects(pending);assert.equal(wire.agents[0].destroyed,true);assert.equal(network.active,0);
});
test('saving is explicit, survives reload, remains separate from API credentials and refuses busy edits',async t=>{
  const {network,dir}=await fixture(t);await network.configure({mode:'manual',proxy_url:'http://proxy.invalid:8123'});assert.deepEqual((await readdir(dir)),['ai-network.json']);
  const another=new AINetwork({dir});await another.initialize();assert.equal(another.config.mode,'manual');assert.equal(another.state(false).config,undefined);assert.equal(JSON.stringify(another.state(false)).includes('proxy.invalid'),false);
  another.active=1;await assert.rejects(another.configure({mode:'direct'}),/ai_network_busy/);assert.equal(another.config.mode,'manual');
});
test('official endpoint in custom mode uses max_completion_tokens; both formats/models share the same explicit network options',async()=>{
  const calls=[],provider=new AIProviders({auth:{readAPIFor:async()=> 'synthetic-only'},fetcher:async(url,options)=>{calls.push({url,options});return url.endsWith('/models')?Response.json({data:[{id:'synthetic-model'}]}):new Response('data: '+JSON.stringify(url.endsWith('/responses')?{type:'response.output_text.delta',delta:'OK'}:{choices:[{delta:{content:'OK'},finish_reason:'stop'}]})+'\n\n'+(url.endsWith('/responses')?'data: {"type":"response.completed"}\n\n':''),{headers:{'content-type':'text/event-stream'}});}});
  const network={mode:'direct'},base={...AI_DEFAULTS,backend:'api',api_platform:'custom',api_base_url:'https://api.openai.com/v1',api_model:'synthetic-model'};
  for(const format of ['chat_completions','responses']){await provider.generate({...base,api_format:format},[],'synthetic',undefined,()=>{},{network});const body=JSON.parse(calls.at(-1).options.body);assert.equal(body[format==='responses'?'max_output_tokens':'max_completion_tokens'],512);assert.equal(body.max_tokens,undefined);assert.equal(calls.at(-1).options.aiNetwork,network);}
  await provider.models(base,{network});assert.equal(calls.at(-1).options.aiNetwork,network);
});
test('unsaved test clears incompatible vision/context flags only in the copy, uses one request, and does not persist proxy or API credentials',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-network-draft-')),secrets=new MemorySecrets();let calls=0;
  const app={connected:false,onlineConfirmed:false,selfId:'',sendQueue:new ResendQueue({intervalMs:0,jitterMs:0})};
  const ai=new AIChat({dir,app,secrets,fetcher:async()=>{calls++;return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',{headers:{'content-type':'text/event-stream'}});}});await ai.initialize();
  t.after(async()=>{ai.dispose();await ai.budgetTask;await ai.diagnostics.file.task;await rm(dir,{recursive:true,force:true});});
  ai.config={...ai.config,group_context_export:true,group_context_target:ai.config.api_base_url,vision_enabled:true,vision_reference_enabled:true};const before=structuredClone(ai.config);
  const target={api_platform:'openai',api_base_url:'https://api.openai.com/v1',api_format:'chat_completions',api_model:'synthetic-model',api_max_output_tokens:32,timeout_seconds:1};
  const result=await ai.testAPI({target,credential:{source:'new',key:'synthetic-unsaved-key'},network:{mode:'legacy'}});assert.equal(result.ok,true);assert.equal(calls,1);assert.deepEqual(ai.config,before);assert.equal(secrets.api,null);
  for(const name of await readdir(dir))assert.doesNotMatch(await readFile(join(dir,name),'utf8'),/synthetic-unsaved-key|proxy_url/);
});
