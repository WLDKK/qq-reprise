import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GroupSignService,GROUP_SIGN_DEFAULTS,validateSignSettings} from './group-sign.mjs';
const ID='90001',GROUP='50001';
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}assert.fail('synthetic condition timeout');}
async function fixture(t,{settings={},onCall}={}){
 const dir=await mkdtemp(join(tmpdir(),'group-sign-scheduling-')),calls=[];let clock=Date.UTC(2026,9,25,0,30);
 const app={selfId:ID,connected:true,onlineConfirmed:true,groups:[{id:GROUP},{id:'50002'}]};
 app.client={config:{ws_url:'ws://127.0.0.1:3001'},call:async(action,params)=>{calls.push({action,params});const answer=onCall?.(action,params);if(answer!==undefined)return answer;if(action==='get_version_info')return{app_name:'NapCat.Onebot',app_version:'synthetic'};if(action==='get_group_signed_list')return[];return{};}};
 const service=new GroupSignService({dir,app,now:()=>clock,autoTimer:false,callTimeoutMs:1000,wait:async()=>{}});await service.initialize();await service.configure({...structuredClone(GROUP_SIGN_DEFAULTS),enabled:true,binding_qq:ID,groups:[{group_id:GROUP,enabled:true}],...settings});
 t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
 return{dir,service,app,calls,setNow:v=>clock=v,advance:v=>clock+=v,count:()=>calls.filter(c=>c.action==='send_group_sign').length,run:()=>service.request(GROUP,{acknowledged:true})};
}
test('legacy settings gain bounded scheduling defaults without replacing existing values',()=>{
 const c=validateSignSettings({default_time:'00:00',groups:[{group_id:GROUP,enabled:true,time:'12:34',timezone:'UTC'}]});assert.equal(c.dispatch_concurrency,1);assert.equal(c.dispatch_interval_ms,500);assert.equal(c.groups[0].time,'12:34');
 for(const patch of [{dispatch_concurrency:0},{dispatch_concurrency:5},{dispatch_interval_ms:249},{dispatch_interval_ms:60001}])assert.throws(()=>validateSignSettings(patch),{code:'sign_invalid_settings'});
});
test('initial midnight schedule after midnight starts next date without catchup',async t=>{
 const f=await fixture(t,{settings:{default_time:'00:00'}});f.setNow(Date.UTC(2026,9,25,16,22));assert.equal(f.service.state().schedule[0].nextAt,Date.UTC(2026,9,26,16));await f.service.tick();assert.equal(f.count(),0);assert.equal(f.service.state().records[0].status,'skipped');f.setNow(Date.UTC(2026,9,26,16));await f.service.tick();assert.equal(f.count(),1);assert.equal(f.service.state().records[0].day,'2026-10-27');
});
test('inherited time and timezone remain editable independently of explicit group values',async t=>{
 const f=await fixture(t,{settings:{default_time:'09:00',groups:[{group_id:GROUP,enabled:true,time:'',timezone:''},{group_id:'50002',enabled:false,time:'10:00',timezone:'UTC'}]}});assert.equal(f.service.state().schedule[0].time,'09:00');await f.service.configure({...f.service.config,default_time:'11:00',timezone:'UTC'});const s=f.service.state().schedule;assert.equal(s[0].time,'11:00');assert.equal(s[0].timezone,'UTC');assert.equal(s[1].time,'10:00');assert.equal(s[1].nextAt,null);assert.equal(f.service.config.groups[0].time,'');
});
test('new-day policy keeps prior unknown without resubmitting either date',async t=>{
 const f=await fixture(t,{settings:{default_time:'00:00',previous_unknown_policy:'allow_new_day'}});f.setNow(Date.UTC(2026,9,25,16));await f.service.tick();await f.service.check(GROUP);await f.service.check(GROUP);assert.equal(f.service.state().records[0].status,'unknown');f.advance(86400000);await f.service.tick();assert.equal(f.count(),2);assert.equal(f.service.state().records.filter(r=>r.status==='unknown').length,1);await f.run();assert.equal(f.count(),2);
});
test('multiple groups execute with bounded concurrency while each durable key is reserved',async t=>{
 let release;const gate=new Promise(r=>release=r);let active=0,peak=0;const f=await fixture(t,{settings:{dispatch_concurrency:2,groups:[{group_id:GROUP,enabled:true},{group_id:'50002',enabled:true}]},onCall:a=>a==='send_group_sign'?(async()=>{active++;peak=Math.max(peak,active);await gate;active--;return{};})():undefined});
 const a=f.run(),b=f.service.request('50002',{acknowledged:true});await until(()=>f.count()===2);assert.equal(peak,2);const disk=JSON.parse(await readFile(join(f.dir,'group-sign-ledger.json'),'utf8'));assert.equal(disk.records.filter(r=>r.status==='intent').length,2);release();await Promise.all([a,b]);assert.equal(f.count(),2);
});
test('task-start interval applies without holding the ledger lock during network I/O',async t=>{
 const waits=[],f=await fixture(t,{settings:{dispatch_concurrency:2,dispatch_interval_ms:1000,groups:[{group_id:GROUP,enabled:true},{group_id:'50002',enabled:true}]}});f.service.wait=async ms=>waits.push(ms);await Promise.all([f.run(),f.service.request('50002',{acknowledged:true})]);assert.equal(f.count(),2);assert.ok(waits.some(ms=>ms>0&&ms<=1000));
});
test('configuration disabled during preflight cancels transport and preserves not-sent record',async t=>{
 let release;const gate=new Promise(r=>release=r);const f=await fixture(t,{onCall:a=>a==='get_version_info'?gate:undefined});const caught=f.run().catch(e=>e);await until(()=>f.service.inflight.size===1);await f.service.configure({...f.service.config,enabled:false});release({app_name:'NapCat.Onebot',app_version:'synthetic'});assert.equal((await caught).code,'sign_disabled');assert.equal(f.count(),0);assert.equal(f.service.state().records[0].notSubmitted,true);assert.equal(f.service.state().records[0].status,'failed');
});
test('queued request crossing its original local date is cancelled before transport',async t=>{
 let release;const gate=new Promise(r=>release=r);const f=await fixture(t,{settings:{dispatch_concurrency:1,groups:[{group_id:GROUP,enabled:true},{group_id:'50002',enabled:true}]},onCall:a=>a==='send_group_sign'?gate:undefined});const first=f.run();await until(()=>f.count()===1);const second=f.service.request('50002',{acknowledged:true}).catch(e=>e);f.advance(86400000);release({});await first;assert.equal((await second).code,'sign_schedule_date_changed');assert.equal(f.count(),1);
});
test('closing cancels queued groups and waits for the active bounded operation',async t=>{
 let release;const gate=new Promise(r=>release=r);const f=await fixture(t,{settings:{dispatch_concurrency:1,groups:[{group_id:GROUP,enabled:true},{group_id:'50002',enabled:true}]},onCall:a=>a==='send_group_sign'?gate:undefined});const first=f.run();await until(()=>f.count()===1);const second=f.service.request('50002',{acknowledged:true}).catch(e=>e);const closed=f.service.close();release({});await Promise.all([first,closed]);assert.equal((await second).code,'sign_disposed');assert.equal(f.count(),1);assert.equal(f.service.state().records[0].status,'unknown');
});
test('next schedule skips nonexistent DST civil time rather than promising an invalid time',async t=>{
 const f=await fixture(t,{settings:{timezone:'America/New_York',default_time:'02:30'}});f.setNow(Date.UTC(2026,2,8,5));assert.equal(f.service.state().schedule[0].nextAt,Date.UTC(2026,2,9,6,30));
});
