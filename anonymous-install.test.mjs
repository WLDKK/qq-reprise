import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,copyFile,readdir,rm} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {startApp} from './qq-recall.mjs';
import {validateAISettings} from './ai-config.mjs';
import {MemorySecrets} from './ai-storage.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const json=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
async function environment(t,examples=true){
 const parent=tmpdir(),dir=await mkdtemp(join(parent,'anonymous-install-'));
 if(examples){await copyFile(join(root,'examples','config.example.json'),join(dir,'config.json'));await copyFile(join(root,'examples','ai-settings.example.json'),join(dir,'ai-settings.json'));}
 let externalAttempts=0;
 const blocked=async()=>{externalAttempts++;throw Error('Unexpected synthetic external call');};
 const running=await startApp({configPath:join(dir,'config.json'),discover:async()=>[],logger:()=>{},aiSecrets:new MemorySecrets(),aiPoolSecrets:new MemorySecrets(),aiFetcher:blocked,aiImageFetcher:blocked});
 t.after(async()=>{await running.close();assert.equal(externalAttempts,0);assert.ok(resolve(dir).startsWith(resolve(parent)+sep));await rm(dir,{recursive:true,force:true});});
 return{...running,dir};
}
test('anonymous examples preserve every supplied setting, empty identity and disabled outbound switch',async()=>{
 const example=await json(join(root,'examples','ai-settings.example.json')),c=validateAISettings(example);
 for(const[k,v]of Object.entries(example))assert.deepEqual(c[k],v,k);
 for(const k of['enabled','allow_self','plan_allow_self','group_context_export','participation_enabled','vision_enabled','vision_reference_enabled','vision_recent_enabled'])assert.equal(c[k],false,k);
 for(const k of['groups','private_peers','users','chat_display_overrides'])assert.deepEqual(c[k],[],k);
 assert.equal(c.binding_qq,'');assert.equal(c.chat_owner_qq,'');assert.equal(c.private_reply_mode,'disabled');
});
test('fresh anonymous installation serves a local page and health without an account, credential or outbound work',async t=>{
 const f=await environment(t),s=f.app.state(),example=await json(join(root,'examples','ai-settings.example.json'));
 for(const[k,v]of Object.entries(example))assert.deepEqual(s.ai.config[k],v,k);
 assert.equal(s.ai.error,'');assert.equal(s.ai.enabled,false);assert.equal(s.connected,false);assert.equal(s.active,false);assert.equal(s.auto_resend,false);assert.equal(s.resend_self,false);assert.equal(f.app.preferences.auto_start,false);assert.equal(f.app.preferences.auto_recovery,false);
 assert.equal(s.ai.auth.api_configured,false);assert.deepEqual(s.ai.auth.profiles,[]);assert.deepEqual(s.recall_name_bindings.bindings,[]);assert.equal(s.ai.delivery.pending,0);assert.equal(s.ai.generating,0);assert.equal(s.ai.queued,0);
 const h=await(await fetch(new URL('health',f.url))).json();assert.equal(h.pid,process.pid);assert.equal(h.status_summary.ai.backend_recovery_version,2);
 const response=await fetch(f.url);assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.doesNotMatch(await response.text(),/__SESSION_TOKEN__/);
 assert.equal((await readdir(f.dir)).includes('.instance.json'),false,'The CLI entry is never started by this fixture');
});
test('an empty installation directory loads default-off AI without borrowing another local profile',async t=>{
 const f=await environment(t,false),s=f.app.state();assert.equal(s.ai.enabled,false);assert.equal(s.ai.error,'');assert.equal(s.connected,false);assert.equal(s.active,false);assert.equal(s.auto_resend,false);assert.equal(s.ai.auth.api_configured,false);assert.deepEqual(s.ai.auth.profiles,[]);
});
test('release documentation has valid local links and no absolute personal Windows home path',async()=>{
 const docs=[];
 async function collect(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(e.isDirectory()&&e.name==='docs')await collect(join(dir,e.name));else if(e.isFile()&&e.name.endsWith('.md'))docs.push(join(dir,e.name));}}
 await collect(root);assert.ok(docs.length>=7);
 for(const path of docs){const body=await readFile(path,'utf8');assert.doesNotMatch(body,/[A-Za-z]:[\\/]Users[\\/][^\\/\s<]+/i);
  for(const m of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){if(/^(https?:|#)/.test(m[1]))continue;const target=decodeURIComponent(m[1].split('#')[0]);if(target)await readFile(resolve(dirname(path),target));}
 }
});
