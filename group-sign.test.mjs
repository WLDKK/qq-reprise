import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GroupSignService,GROUP_SIGN_DEFAULTS,validateSignSettings,signClock,signKey} from './group-sign.mjs';
const ID='90001',GROUP='50001';
const start=Date.UTC(2026,9,25,0,30);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await sleep(2);}assert.fail('synthetic condition timeout');}
async function fixture(t,{onCall,settings={},write,enabled=true,timeout=50}={}){
 const dir=await mkdtemp(join(tmpdir(),'group-sign-synthetic-'));let clock=start;const calls=[];
 const app={selfId:ID,connected:true,onlineConfirmed:true,groups:[{id:GROUP,name:'synthetic-group'}]};
 const client={config:{ws_url:'ws://127.0.0.1:3001/'},call:async(action,params)=>{calls.push({action,params});const custom=onCall?.(action,params);if(custom!==undefined)return custom;if(action==='get_version_info')return{app_name:'NapCat.Onebot',app_version:'synthetic'};if(action==='get_group_signed_list')return[];return{};}};app.client=client;
 const service=new GroupSignService({dir,app,now:()=>clock,write,autoTimer:false,callTimeoutMs:timeout,wait:async()=>{}});await service.initialize();
 await service.configure({...structuredClone(GROUP_SIGN_DEFAULTS),enabled,binding_qq:ID,groups:[{group_id:GROUP,enabled:true,time:'08:30',timezone:''}],...settings});
 const services=[service];t.after(async()=>{for(const s of services)await s.close();await rm(dir,{recursive:true,force:true});});
 return{dir,service,app,client,calls,services,now:()=>clock,setNow:v=>clock=v,advance:ms=>clock+=ms,count:()=>calls.filter(c=>c.action==='send_group_sign').length,run:()=>service.request(GROUP,{acknowledged:true})};
}
test('default has no enabled group or timer action and uses Asia/Shanghai',async t=>{
 assert.equal(GROUP_SIGN_DEFAULTS.enabled,false);assert.deepEqual(GROUP_SIGN_DEFAULTS.groups,[]);assert.equal(GROUP_SIGN_DEFAULTS.timezone,'Asia/Shanghai');
 const f=await fixture(t,{enabled:false});await f.service.tick();assert.equal(f.calls.length,0);await assert.rejects(f.run(),{code:'sign_disabled'});assert.equal(f.count(),0);
});
for(const [label,patch]of [['unknown field',{oops:true}],['time',{default_time:'24:00'}],['timezone',{timezone:'Mars/Olympus'}],['retries',{retry_attempts:0}],['unbounded retry',{retry_attempts:6}],['catchup',{missed_policy:'anything'}],['confirmation',{confirmation_mode:'assume_ok'}],['duplicate group',{groups:[{group_id:GROUP,enabled:false},{group_id:GROUP,enabled:true}]}]])test('invalid '+label+' is rejected',()=>{assert.throws(()=>validateSignSettings(patch),{code:'sign_invalid_settings'});});
test('local day/time handle midnight and DST folds with stable date key',()=>{
 assert.deepEqual(signClock(start,'Asia/Shanghai'),{day:'2026-10-25',minute:510,second:0});
 assert.equal(signClock(Date.UTC(2026,9,24,16,1),'Asia/Shanghai').day,'2026-10-25');
 assert.equal(signKey(ID,GROUP,'2026-10-25'),ID+':'+GROUP+':2026-10-25');
 assert.equal(signClock(Date.UTC(2026,10,1,5,30),'America/New_York').day,signClock(Date.UTC(2026,10,1,6,30),'America/New_York').day);
});
test('manual action requires explicit acknowledgement',async t=>{const f=await fixture(t);await assert.rejects(f.service.request(GROUP),{code:'sign_explicit_confirmation_required'});assert.equal(f.calls.length,0);});
test('API acknowledgement is submitted, never confirmed by itself; alias is never called',async t=>{
 const f=await fixture(t),r=await f.run();assert.equal(r.record.status,'submitted');assert.equal(f.count(),1);assert.ok(!f.calls.some(c=>c.action==='set_group_sign'));assert.equal(r.record.notSubmitted,false);
 const disk=JSON.parse(await readFile(join(f.dir,'group-sign-ledger.json'),'utf8'));assert.equal(disk.records[0].status,'submitted');
});
test('durable intent exists before the sign transport is invoked',async t=>{
 let f;f=await fixture(t,{onCall:action=>action==='send_group_sign'?(async()=>{const disk=JSON.parse(await readFile(join(f.dir,'group-sign-ledger.json'),'utf8'));assert.equal(disk.records[0].status,'intent');return{};})():undefined});await f.run();
});
test('parallel manual and scheduled requests invoke only once',async t=>{
 const f=await fixture(t);const values=await Promise.all([f.run(),f.service.request(GROUP,{source:'schedule'}),f.run()]);assert.equal(f.count(),1);assert.equal(values.filter(r=>r.deduplicated).length,2);
});
test('same-account/group/date is durable across restart; submitted becomes unknown',async t=>{
 const f=await fixture(t);await f.run();await f.service.close();const next=new GroupSignService({dir:f.dir,app:f.app,now:f.now,autoTimer:false});f.services.push(next);await next.initialize();assert.equal(next.state().records[0].status,'unknown');await next.request(GROUP,{acknowledged:true});assert.equal(f.count(),1);
});
test('persisted intent interrupted before result remains unknown on restart',async t=>{
 const f=await fixture(t);await f.run();await f.service.close();const path=join(f.dir,'group-sign-ledger.json'),disk=JSON.parse(await readFile(path,'utf8'));disk.records[0].status='intent';await writeFile(path,JSON.stringify(disk));const next=new GroupSignService({dir:f.dir,app:f.app,now:f.now,autoTimer:false});f.services.push(next);await next.initialize();assert.equal(next.state().records[0].errorCode,'sign_interrupted_by_restart');await next.request(GROUP,{acknowledged:true});assert.equal(f.count(),1);
});
test('another service observes durable reservation without holding a network-wide ledger lock',async t=>{
 let resolve;const held=new Promise(r=>resolve=r);const f=await fixture(t,{onCall:a=>a==='send_group_sign'?held:undefined});const next=new GroupSignService({dir:f.dir,app:f.app,now:f.now,autoTimer:false});f.services.push(next);await next.initialize();const first=f.run();await until(()=>f.count()===1);assert.equal((await next.request(GROUP,{acknowledged:true})).deduplicated,true);resolve({});await first;await next.request(GROUP,{acknowledged:true});assert.equal(f.count(),1);
});
test('own positive record in verified UTC request day confirms without a sign',async t=>{
 const f=await fixture(t,{onCall:a=>a==='get_group_signed_list'?[{user_id:Number(ID),nick:'synthetic',time:0,rank:1}]:undefined});const r=await f.run();assert.equal(r.record.status,'confirmed');assert.equal(r.record.confirmedBy,'napcat_utc_today_first_page');assert.equal(f.count(),0);assert.ok(!JSON.stringify(f.service.state().records).includes('synthetic'));
});
test('post-send positive own record confirms and repeated checks do not resubmit',async t=>{
 let positive=false;const f=await fixture(t,{onCall:a=>a==='get_group_signed_list'?(positive?[{user_id:ID}]:[]):undefined});await f.run();positive=true;assert.equal((await f.service.check(GROUP)).record.status,'confirmed');await f.service.check(GROUP);await f.run();assert.equal(f.count(),1);
});
test('missing from first page does not prove unsigned and cannot trigger re-sign',async t=>{
 const f=await fixture(t);await f.run();assert.equal((await f.service.check(GROUP)).record.status,'submitted');assert.equal((await f.service.check(GROUP)).record.status,'unknown');assert.equal(f.service.state().records[0].errorCode,'sign_record_not_in_first_page');f.advance(3600000);await f.service.tick();await f.run();assert.equal(f.count(),1);
});
test('other user record is not confirmation',async t=>{const f=await fixture(t,{onCall:a=>a==='get_group_signed_list'?[{user_id:'90002'}]:undefined});await f.run();await f.service.check(GROUP);assert.equal(f.service.state().confirmed,0);assert.equal(f.count(),1);});
test('unrecognized record shape stays unconfirmed',async t=>{const f=await fixture(t,{onCall:a=>a==='get_group_signed_list'?{users:[ID],success:true}:undefined});await f.run();await f.service.check(GROUP);assert.equal(f.service.state().records[0].errorCode,'sign_record_schema_unverified');assert.equal(f.service.state().confirmed,0);});
test('Beijing early morning cannot confirm from NapCat previous UTC query date',async t=>{
 const f=await fixture(t,{onCall:a=>a==='get_group_signed_list'?[{user_id:ID}]:undefined});f.setNow(Date.UTC(2026,9,24,16,1));const r=await f.run();assert.equal(r.record.day,'2026-10-25');assert.equal(r.record.status,'submitted');assert.equal((await f.service.check(GROUP)).record.errorCode,'sign_record_date_unverified');assert.equal(f.service.state().confirmed,0);assert.equal(f.count(),1);
});
test('manual-only confirmation never guesses from record date/timestamp',async t=>{const f=await fixture(t,{settings:{confirmation_mode:'manual_only'},onCall:a=>a==='get_group_signed_list'?[{user_id:ID,time:start}]:undefined});await f.run();assert.equal((await f.service.check(GROUP)).record.errorCode,'sign_record_manual_confirmation');assert.equal(f.service.state().confirmed,0);});
test('record query failure stays pending without retrying sign',async t=>{const f=await fixture(t,{onCall:a=>a==='get_group_signed_list'?Promise.reject(Error('synthetic')):undefined});await f.run();await f.service.check(GROUP);await f.service.check(GROUP);await f.run();assert.equal(f.service.state().records[0].status,'unknown');assert.equal(f.count(),1);});
test('sign timeout is unknown and not automatically repeated',async t=>{const f=await fixture(t,{onCall:a=>a==='send_group_sign'?new Promise(()=>{}):undefined,timeout:10});const r=await f.run();assert.equal(r.record.status,'unknown');assert.equal(r.record.errorCode,'sign_response_timeout');f.advance(3600000);await f.service.tick();await f.run();assert.equal(f.count(),1);});
test('API rejection after submission is conservative unknown',async t=>{const f=await fixture(t,{onCall:a=>a==='send_group_sign'?Promise.reject(Object.assign(Error('synthetic'),{retcode:1200})):undefined});assert.equal((await f.run()).record.status,'unknown');await f.run();assert.equal(f.count(),1);});
test('explicit not-submitted failure uses finite persisted exponential backoff',async t=>{
 const f=await fixture(t,{onCall:a=>a==='send_group_sign'?Promise.reject(Object.assign(Error('synthetic'),{notSubmitted:true})):undefined});const first=await f.run();assert.equal(first.record.status,'failed');assert.equal(first.record.nextRetryAt,f.now()+60000);await f.run();assert.equal(f.count(),1);f.advance(60000);await f.service.tick();assert.equal(f.count(),2);assert.equal(f.service.state().records[0].nextRetryAt,null);f.advance(3600000);await f.service.tick();await f.run();assert.equal(f.count(),2);
});
test('packet backend unavailable never invokes sign and retries are bounded',async t=>{const f=await fixture(t,{onCall:a=>a==='nc_get_packet_status'?Promise.reject(Error('synthetic')):undefined});const r=await f.run();assert.equal(r.record.errorCode,'sign_packet_unavailable');assert.equal(r.record.notSubmitted,true);assert.equal(f.count(),0);f.advance(60000);await f.service.tick();assert.equal(f.service.state().records[0].attempts,2);});
test('scheduler runs in the configured minute exactly once',async t=>{const f=await fixture(t);await f.service.tick();await f.service.tick();assert.equal(f.count(),1);});
test('missed schedule skips by default after sleep',async t=>{const f=await fixture(t);f.advance(3*60000);await f.service.tick();assert.equal(f.service.state().records[0].status,'skipped');assert.equal(f.calls.length,0);});
test('explicit manual action can perform the first sign after a scheduled skip',async t=>{const f=await fixture(t);f.advance(3*60000);await f.service.tick();assert.equal(f.count(),0);assert.equal((await f.run()).record.status,'submitted');assert.equal(f.count(),1);});
test('configured catch-up allows within window, never previous dates',async t=>{const f=await fixture(t,{settings:{missed_policy:'within_window',catch_up_minutes:30}});f.advance(20*60000);await f.service.tick();assert.equal(f.count(),1);});
test('catch-up window expiration is explicit skip',async t=>{const f=await fixture(t,{settings:{missed_policy:'within_window',catch_up_minutes:10}});f.advance(11*60000);await f.service.tick();assert.equal(f.count(),0);assert.equal(f.service.state().records[0].errorCode,'sign_missed_schedule');});
test('previous-day unknown pauses a group; acknowledgement does not re-sign old day',async t=>{
 const f=await fixture(t,{onCall:a=>a==='send_group_sign'?Promise.reject(Error('synthetic')):undefined});const first=await f.run();f.advance(86400000);await assert.rejects(f.run(),{code:'sign_previous_unknown'});assert.equal(f.count(),1);await f.service.acknowledge(first.record.key);assert.equal(f.count(),1);await f.run();assert.equal(f.count(),2);
});
test('allow-new-day policy permits a new key and keeps older unknown visible',async t=>{const f=await fixture(t,{settings:{previous_unknown_policy:'allow_new_day'},onCall:a=>a==='send_group_sign'?Promise.reject(Error('synthetic')):undefined});await f.run();f.advance(86400000);await f.run();assert.equal(f.count(),2);assert.equal(f.service.state().records.length,2);assert.equal(f.service.state().records[1].status,'unknown');});
test('changed QQ binding prevents execution without silently rebinding',async t=>{const f=await fixture(t);f.app.selfId='90002';await assert.rejects(f.run(),{code:'sign_account_changed'});assert.equal(f.calls.length,0);assert.equal(f.service.config.binding_qq,ID);});
test('removing and readding a group does not clear its unknown dedup record',async t=>{const f=await fixture(t,{onCall:a=>a==='send_group_sign'?Promise.reject(Error('synthetic')):undefined});await f.run();const before=structuredClone(f.service.config);await f.service.configure({...before,groups:[]});await f.service.configure(before);await f.run();assert.equal(f.count(),1);assert.equal(f.service.state().records[0].status,'unknown');});
test('UTC midnight crossing during query never confirms a previous query day',async t=>{let cross=false;let f;f=await fixture(t,{settings:{timezone:'UTC'},onCall:a=>a==='get_group_signed_list'?(cross?(f.advance(2000),[{user_id:ID}]):[]):undefined});f.setNow(Date.UTC(2026,9,25,23,59,59));await f.run();cross=true;const checked=await f.service.check(GROUP);assert.equal(checked.record.errorCode,'sign_record_date_unverified');assert.notEqual(checked.record.status,'confirmed');assert.equal(f.count(),1);});
test('account or transport switch during sign remains unknown for original owner',async t=>{
 let f;f=await fixture(t,{onCall:a=>a==='send_group_sign'?(async()=>{f.app.selfId='90002';return{};})():undefined});const r=await f.run();assert.equal(r.record.account,ID);assert.equal(r.record.status,'unknown');assert.equal(r.record.errorCode,'sign_connection_changed');
});
test('group not in connected membership is rejected before all calls',async t=>{const f=await fixture(t);f.app.groups=[];await assert.rejects(f.run(),{code:'sign_group_unavailable'});assert.equal(f.calls.length,0);});
test('ledger persistence failure before intent prevents sign and pauses only feature',async t=>{const f=await fixture(t,{write:async(path,value)=>{if(path.endsWith('group-sign-ledger.json'))throw Error('synthetic disk failure');await writeFile(path,JSON.stringify(value));}});await assert.rejects(f.run(),{code:'sign_ledger_write_failed'});assert.equal(f.count(),0);assert.equal(f.app.connected,true);assert.equal(f.service.state().error,'sign_ledger_write_failed');});
test('write failure after submission retains durable intent for unknown restart recovery',async t=>{
 const f=await fixture(t,{write:async(path,value)=>{if(path.endsWith('group-sign-ledger.json')&&value.records.some(r=>r.status==='submitted'))throw Error('synthetic disk failure');await writeFile(path,JSON.stringify(value));}});await assert.rejects(f.run(),{code:'sign_ledger_write_failed'});assert.equal(f.count(),1);await f.service.close();const next=new GroupSignService({dir:f.dir,app:f.app,now:f.now,autoTimer:false});f.services.push(next);await next.initialize();assert.equal(next.state().records[0].status,'unknown');await next.request(GROUP,{acknowledged:true});assert.equal(f.count(),1);
});
test('corrupt ledger is not discarded or replaced with empty state',async t=>{const f=await fixture(t);await f.service.close();await writeFile(join(f.dir,'group-sign-ledger.json'),'invalid synthetic JSON');const next=new GroupSignService({dir:f.dir,app:f.app,now:f.now,autoTimer:false});f.services.push(next);await next.initialize();assert.equal(next.state().error,'sign_storage_invalid');await assert.rejects(next.request(GROUP,{acknowledged:true}),{code:'sign_storage_invalid'});assert.equal(f.count(),0);});
test('backward wall clock is blocked without deleting dedup records',async t=>{const f=await fixture(t);await f.run();f.advance(-600000);await assert.rejects(f.run(),{code:'sign_clock_rollback_wait'});assert.equal(f.count(),1);assert.equal(f.service.state().records.length,1);});
test('health summary exposes no account/group ids or detailed records',async t=>{const f=await fixture(t);await f.run();const s=JSON.stringify(f.service.state(false));assert.ok(!s.includes(ID)&&!s.includes(GROUP));assert.ok(!s.includes('binding_qq'));assert.equal(f.service.state(false).configured_groups,1);});
test('separate settings file preserves private runtime and recall/AI settings',async t=>{const f=await fixture(t);for(const name of ['config.json','ai-settings.json','recall-name-bindings.json'])await writeFile(join(f.dir,name),'synthetic unchanged');await f.service.configure({...f.service.config,enabled:false});for(const name of ['config.json','ai-settings.json','recall-name-bindings.json'])assert.equal(await readFile(join(f.dir,name),'utf8'),'synthetic unchanged');assert.equal(f.count(),0);});
