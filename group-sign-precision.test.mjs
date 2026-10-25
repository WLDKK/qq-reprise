import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GroupSignService,GROUP_SIGN_DEFAULTS,validateSignSettings} from './group-sign.mjs';
const account='90001',group='50001',start=Date.UTC(2026,9,25,16,22);
async function until(fn){for(let i=0;i<250;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}assert.fail('synthetic async task did not finish');}
async function fixture(t,{enabled=false,now=start,settings={},clientCall}={}){
 const dir=await mkdtemp(join(tmpdir(),'sign-precision-synthetic-'));t.mock.timers.enable({apis:['setInterval','Date'],now});const calls=[];
 const app={selfId:account,connected:true,onlineConfirmed:true,groups:[{id:group}],client:{config:{ws_url:'ws://127.0.0.1:3001/'},call:async(action,params)=>{calls.push({action,params});if(clientCall)return clientCall(action,params);if(action==='get_version_info')return{app_name:'NapCat.Onebot',app_version:'synthetic'};if(action==='get_group_signed_list')return[];return{};}}};
 const services=[];const create=async()=>{const service=new GroupSignService({dir,app,autoTimer:true,now:()=>Date.now(),wait:async()=>{},callTimeoutMs:100});services.push(service);await service.initialize();return service;};
 const service=await create();await service.configure({...structuredClone(GROUP_SIGN_DEFAULTS),enabled,binding_qq:account,default_time:'00:00',groups:[{group_id:group,enabled:true,time:'',timezone:''}],...settings});
 t.after(async()=>{for(const s of services)await s.close();await rm(dir,{recursive:true,force:true});});return{dir,service,services,create,app,calls};
}
test('legacy settings default to an independent one-second scheduler with bounded precision',()=>{
 const c=validateSignSettings({enabled:false});assert.equal(c.scheduler_interval_ms,1000);for(const ms of[250,1000,60000])assert.equal(validateSignSettings({scheduler_interval_ms:ms}).scheduler_interval_ms,ms);for(const ms of[249,60001,1.5,'1000'])assert.throws(()=>validateSignSettings({scheduler_interval_ms:ms}));
});
test('default timer checks within the next second and counts the real callback cadence',async t=>{
 const f=await fixture(t);t.mock.timers.tick(999);assert.equal(f.service.state().scheduler.ticks,0);t.mock.timers.tick(1);assert.equal(f.service.state().scheduler.ticks,1);for(let i=0;i<4;i++)t.mock.timers.tick(1000);assert.equal(f.service.state().scheduler.ticks,5);assert.equal(f.service.state().scheduler.last_gap_ms,1000);assert.equal(f.calls.length,0);
});
test('changing precision replaces only this timer and never duplicates callbacks',async t=>{
 const f=await fixture(t);await f.service.configure({...f.service.config,scheduler_interval_ms:250});t.mock.timers.tick(1000);assert.equal(f.service.state().scheduler.ticks,4);await f.service.configure({...f.service.config,scheduler_interval_ms:500});t.mock.timers.tick(1000);assert.equal(f.service.state().scheduler.ticks,6);assert.equal(f.calls.length,0);
});
test('a legacy settings save preserves an already configured precision when the new field is omitted',async t=>{
 const f=await fixture(t,{settings:{scheduler_interval_ms:500}});const legacy={...f.service.config};delete legacy.scheduler_interval_ms;await f.service.configure(legacy);assert.equal(f.service.config.scheduler_interval_ms,500);t.mock.timers.tick(1000);assert.equal(f.service.state().scheduler.ticks,2);assert.equal(f.calls.length,0);
});
test('high-frequency checks before the configured time perform zero group API calls',async t=>{
 const f=await fixture(t,{enabled:true,settings:{default_time:'01:00',scheduler_interval_ms:250}});t.mock.timers.tick(10000);assert.equal(f.service.state().scheduler.ticks,40);assert.equal(f.service.state().scheduler.metadata_calls,0);assert.equal(f.service.state().scheduler.sign_calls,0);assert.equal(f.calls.length,0);assert.equal(f.service.state().records.length,0);
});
test('first activation after midnight skips today without API calls and keeps next midnight',async t=>{
 const f=await fixture(t,{enabled:true});t.mock.timers.tick(1000);await until(()=>!f.service.ticking);t.mock.timers.tick(4000);await until(()=>!f.service.ticking);assert.equal(f.calls.length,0);assert.equal(f.service.state().records[0].status,'skipped');assert.equal(f.service.state().schedule[0].nextAt,Date.UTC(2026,9,26,16));
});
test('crossing Shanghai midnight submits once even with a matching previous UTC-day row',async t=>{
 const f=await fixture(t,{enabled:true,now:Date.UTC(2026,9,25,15,59,58),clientCall:async action=>action==='get_version_info'?{app_name:'NapCat.Onebot',app_version:'synthetic'}:action==='get_group_signed_list'?[{user_id:account}]:{}});t.mock.timers.tick(1000);await until(()=>!f.service.ticking);assert.equal(f.calls.length,0);t.mock.timers.tick(1000);await until(()=>!f.service.ticking);assert.equal(f.calls.filter(c=>c.action==='send_group_sign').length,1);assert.equal(f.service.state().records[0].status,'submitted');assert.equal(f.service.state().records[0].day,'2026-10-26');t.mock.timers.tick(1000);await until(()=>!f.service.ticking);assert.equal(f.service.state().scheduler.sign_calls,1);
});
test('restart loads legacy precision without changing the independent midnight plan',async t=>{
 const f=await fixture(t,{enabled:true});const legacy={...f.service.config};delete legacy.scheduler_interval_ms;await writeFile(join(f.dir,'group-sign-settings.json'),JSON.stringify(legacy));await f.service.close();const next=await f.create();assert.equal(next.config.scheduler_interval_ms,1000);assert.equal(next.state().schedule[0].nextAt,Date.UTC(2026,9,26,16));t.mock.timers.tick(1000);await until(()=>!next.ticking);assert.equal(f.calls.length,0);assert.equal(next.state().schedule[0].nextAt,Date.UTC(2026,9,26,16));
});
test('per-group clock and timezone overrides survive precision changes',async t=>{
 const f=await fixture(t,{enabled:true,settings:{default_time:'01:00',groups:[{group_id:group,enabled:true,time:'12:00',timezone:'UTC'}]}});const before=f.service.state().schedule;await f.service.configure({...f.service.config,scheduler_interval_ms:250});assert.deepEqual(f.service.state().schedule,before);t.mock.timers.tick(1000);assert.equal(f.calls.length,0);
});
test('health scheduler counters contain no account/group identifiers or configuration',async t=>{
 const f=await fixture(t);t.mock.timers.tick(1000);const s=f.service.state(false).scheduler;assert.equal(s.version,2);assert.equal(s.interval_ms,1000);assert.ok(!JSON.stringify(s).includes(account));assert.ok(!JSON.stringify(s).includes(group));assert.equal(s.timer_active,true);
});
test('close cancels the independent timer without another tick or API request',async t=>{
 const f=await fixture(t);t.mock.timers.tick(1000);await f.service.close();const before=f.service.state().scheduler.ticks;t.mock.timers.tick(10000);assert.equal(f.service.state().scheduler.ticks,before);assert.equal(f.service.state().scheduler.timer_active,false);assert.equal(f.calls.length,0);
});
