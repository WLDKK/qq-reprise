import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,copyFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {startApp} from './qq-recall.mjs';
import {MemorySecrets} from './ai-storage.mjs';
import {GROUP_SIGN_DEFAULTS,validateSignSettings} from './group-sign.mjs';
const root=dirname(fileURLToPath(import.meta.url));
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'group-sign-http-synthetic-'));await copyFile(join(root,'examples','config.example.json'),join(dir,'config.json'));await copyFile(join(root,'examples','ai-settings.example.json'),join(dir,'ai-settings.json'));
 let external=0,positive=false;const calls=[];const deny=async()=>{external++;throw Error('synthetic external request forbidden');};
 const f=await startApp({configPath:join(dir,'config.json'),logger:()=>{},discover:async()=>[],aiSecrets:new MemorySecrets(),aiPoolSecrets:new MemorySecrets(),aiFetcher:deny,aiImageFetcher:deny,groupSignOptions:{autoTimer:false,callTimeoutMs:100,wait:async()=>{}},now:()=>Date.UTC(2026,9,25,0,30)});
 const headers={'X-QQ-Recall-Session':f.app.session,'Content-Type':'application/json',Origin:new URL(f.url).origin};
 const request=async(path,body={},override)=>{const r=await fetch(f.url+'api/group-sign/'+path,{method:'POST',headers:override??headers,body:JSON.stringify(body)});return{status:r.status,data:await r.json()};};
 const connect=()=>{f.app.selfId='90001';f.app.connected=true;f.app.onlineConfirmed=true;f.app.groups=[{id:'50001',name:'synthetic group'}];f.app.client={config:{ws_url:'ws://127.0.0.1:3001/'},socket:{readyState:1},close(){},call:async(action,params)=>{calls.push({action,params});if(action==='get_version_info')return{app_name:'NapCat.Onebot',app_version:'synthetic'};if(action==='get_group_signed_list')return positive?[{user_id:90001}]:[];return{};}};};
 const settings=()=>({...structuredClone(GROUP_SIGN_DEFAULTS),enabled:true,binding_qq:'90001',groups:[{group_id:'50001',enabled:true,time:'08:30',timezone:''}]});
 t.after(async()=>{await f.close();assert.equal(external,0);await rm(dir,{recursive:true,force:true});});return{...f,dir,headers,request,connect,settings,calls,positive:v=>positive=v};
}
test('fresh application exposes default-off sign feature and redacted health',async t=>{
 const f=await fixture(t),s=f.app.state().group_sign;assert.equal(s.enabled,false);assert.deepEqual(s.config.groups,[]);assert.equal(s.config.timezone,'Asia/Shanghai');assert.equal(s.records.length,0);const h=await(await fetch(f.url+'health')).json();assert.equal(h.group_sign_version,1);assert.deepEqual(h.status_summary.group_sign.enabled_groups,0);assert.ok(!Object.hasOwn(h.status_summary.group_sign,'config'));assert.equal(f.calls.length,0);
});
test('group-sign mutations require existing session and same-origin protection',async t=>{
 const f=await fixture(t);f.connect();assert.equal((await f.request('settings',f.settings(),{})).status,403);assert.equal((await f.request('manual',{group_id:'50001',acknowledged:true},{...f.headers,Origin:'https://example.invalid'})).status,403);assert.equal(f.calls.length,0);
});
test('new anonymous sign example loads disabled and contains no identities',async()=>{
 const c=validateSignSettings(JSON.parse(await readFile(join(root,'examples','group-sign-settings.example.json'),'utf8')));assert.equal(c.enabled,false);assert.equal(c.binding_qq,'');assert.deepEqual(c.groups,[]);assert.equal(c.timezone,'Asia/Shanghai');assert.equal(c.missed_policy,'skip');
});
test('saving sign settings preserves existing AI, recall and nickname configuration',async t=>{
 const f=await fixture(t);f.connect();const beforeAI=JSON.stringify(f.app.ai.config),beforeRecall=JSON.stringify(f.app.preferences),beforeNames=JSON.stringify(f.app.recallNames.state());const beforeDisk=await readFile(join(f.dir,'config.json'),'utf8');const r=await f.request('settings',f.settings());assert.equal(r.status,200);assert.equal(r.data.enabled,true);assert.equal(JSON.stringify(f.app.ai.config),beforeAI);assert.equal(JSON.stringify(f.app.preferences),beforeRecall);assert.equal(JSON.stringify(f.app.recallNames.state()),beforeNames);assert.equal(await readFile(join(f.dir,'config.json'),'utf8'),beforeDisk);assert.equal(f.calls.length,0);
});
test('HTTP manual sign is guarded, deduplicated and confirmed only by own record',async t=>{
 const f=await fixture(t);f.connect();await f.request('settings',f.settings());assert.equal((await f.request('manual',{group_id:'50001'})).status,400);assert.equal((await f.request('manual',{group_id:'50001',source:'schedule',acknowledged:true})).status,400);assert.equal(f.calls.length,0);const r=await f.request('manual',{group_id:'50001',acknowledged:true});assert.equal(r.status,200);assert.equal(r.data.outcome.record.status,'submitted');await f.request('manual',{group_id:'50001',acknowledged:true});assert.equal(f.calls.filter(c=>c.action==='send_group_sign').length,1);f.positive(true);const checked=await f.request('check',{group_id:'50001'});assert.equal(checked.data.outcome.record.status,'confirmed');assert.equal(f.calls.filter(c=>c.action==='send_group_sign').length,1);assert.ok(!f.calls.some(c=>c.action==='set_group_sign'));
});
test('disabling master keeps records and blocks further actual actions',async t=>{
 const f=await fixture(t);f.connect();await f.request('settings',f.settings());await f.request('manual',{group_id:'50001',acknowledged:true});const config={...f.settings(),enabled:false};assert.equal((await f.request('settings',config)).status,200);const r=await f.request('manual',{group_id:'50001',acknowledged:true});assert.equal(r.status,400);assert.equal(r.data.error,'sign_disabled');assert.equal(f.app.groupSign.state().records.length,1);assert.equal(f.calls.filter(c=>c.action==='send_group_sign').length,1);
});
test('readonly capability endpoint never calls sign or changes configuration',async t=>{
 const f=await fixture(t);f.connect();const before=JSON.stringify(f.app.groupSign.config);const r=await f.request('capabilities');assert.equal(r.status,200);assert.equal(r.data.capabilities.packetAvailable,true);assert.equal(JSON.stringify(f.app.groupSign.config),before);assert.deepEqual(f.calls.map(c=>c.action),['get_version_info','nc_get_packet_status']);
});
test('API errors remain classified without raw upstream wording or credentials',async t=>{
 const f=await fixture(t);f.connect();const r=await f.request('settings',{...f.settings(),groups:[{group_id:'invalid',enabled:true}]});assert.equal(r.status,400);assert.equal(r.data.error,'sign_invalid_settings');assert.equal(f.calls.length,0);assert.ok(!Object.hasOwn(r.data,'stack'));
});
