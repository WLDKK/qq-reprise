import {readFile,writeFile,rename,mkdir,open,unlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

export const GROUP_SIGN_VERSION=1;
export const GROUP_SIGN_DEFAULTS=Object.freeze({version:1,enabled:false,binding_qq:'',timezone:'Asia/Shanghai',default_time:'08:30',missed_policy:'skip',catch_up_minutes:60,retry_attempts:2,retry_base_seconds:60,retry_max_seconds:900,confirmation_mode:'napcat_utc_today',confirmation_delay_seconds:3,confirmation_checks:2,confirmation_interval_seconds:15,previous_unknown_policy:'pause_group',retention_days:90,record_limit:2000,dispatch_concurrency:1,dispatch_interval_ms:500,groups:[]});
const statuses=new Set(['intent','submitted','confirmed','unknown','failed','skipped']);
const validID=v=>typeof v==='string'&&/^[1-9]\d{4,11}$/.test(v);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const isZone=v=>{try{return typeof v==='string'&&v.length<=100&&!!new Intl.DateTimeFormat('en',{timeZone:v}).format(0);}catch{return false;}};
const isTime=v=>typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export function signClock(at,zone){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(at).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));return{day:p.year+'-'+p.month+'-'+p.day,minute:Number(p.hour)*60+Number(p.minute),second:Number(p.second)};}
export const signKey=(account,group,day)=>account+':'+group+':'+day;
export function validateSignSettings(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(GROUP_SIGN_DEFAULTS,k)))fail('sign_invalid_settings');
 const c={...structuredClone(GROUP_SIGN_DEFAULTS),...structuredClone(input)};
 if(c.version!==1||typeof c.enabled!=='boolean'||typeof c.binding_qq!=='string'||c.binding_qq&&!validID(c.binding_qq)||!isZone(c.timezone)||!isTime(c.default_time)||!['skip','within_window'].includes(c.missed_policy)||!['napcat_utc_today','manual_only'].includes(c.confirmation_mode)||!['pause_group','allow_new_day'].includes(c.previous_unknown_policy))fail('sign_invalid_settings');
 for(const[k,min,max]of [['catch_up_minutes',1,1439],['retry_attempts',1,5],['retry_base_seconds',1,3600],['retry_max_seconds',1,86400],['confirmation_delay_seconds',0,3600],['confirmation_checks',0,10],['confirmation_interval_seconds',1,3600],['retention_days',1,3650],['record_limit',10,10000],['dispatch_concurrency',1,4],['dispatch_interval_ms',250,60000]])if(!Number.isSafeInteger(c[k])||c[k]<min||c[k]>max)fail('sign_invalid_settings');
 if(c.retry_max_seconds<c.retry_base_seconds||!Array.isArray(c.groups)||c.groups.length>200)fail('sign_invalid_settings');
 const seen=new Set();c.groups=c.groups.map(g=>{if(!g||typeof g!=='object'||Object.keys(g).some(k=>!['group_id','enabled','time','timezone'].includes(k))||!validID(g.group_id)||seen.has(g.group_id)||typeof g.enabled!=='boolean'||g.time!==undefined&&g.time!==''&&!isTime(g.time)||g.timezone!==undefined&&g.timezone!==''&&!isZone(g.timezone))fail('sign_invalid_settings');seen.add(g.group_id);return{group_id:g.group_id,enabled:g.enabled,time:g.time||'',timezone:g.timezone||''};});
 return c;
}
async function readJSON(path,fallback){try{const s=await readFile(path,'utf8');if(s.length>4*1024*1024)fail('sign_storage_too_large');return JSON.parse(s.replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')return structuredClone(fallback);throw e;}}
async function atomicJSON(path,value){await mkdir(dirname(path),{recursive:true});const tmp=path+'.tmp-'+randomUUID();try{await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(tmp,path);}finally{await unlink(tmp).catch(()=>{});}}
const codeOf=e=>e?.code==='sign_timeout'?'sign_response_timeout':e?.notSubmitted===true?'sign_not_submitted':Number.isInteger(e?.retcode)?'sign_api_rejected':'sign_transport_unknown';
const unresolved=r=>['intent','submitted','unknown'].includes(r.status)&&!r.acknowledged;
function validateLedger(value){
 if(!value||value.version!==1||!Number.isFinite(value.clockAt)||!Array.isArray(value.records)||value.records.length>10000)fail('sign_ledger_invalid');
 const fields=new Set(['key','account','group_id','day','timezone','status','attempts','createdAt','updatedAt','source','notSubmitted','acknowledged','errorCode','nextRetryAt','nextCheckAt','checks','submittedAt','confirmedAt','confirmedBy']);
 const keys=new Set();for(const r of value.records){if(!r||Object.keys(r).some(k=>!fields.has(k))||!validID(r.account)||!validID(r.group_id)||!/^\d{4}-\d{2}-\d{2}$/.test(r.day)||!Number.isFinite(Date.parse(r.day+'T00:00:00Z'))||r.key!==signKey(r.account,r.group_id,r.day)||keys.has(r.key)||!statuses.has(r.status)||!Number.isSafeInteger(r.attempts)||r.attempts<0||r.attempts>100||!Number.isFinite(r.updatedAt)||!Number.isFinite(r.createdAt)||!isZone(r.timezone)||!['manual','schedule'].includes(r.source)||typeof r.notSubmitted!=='boolean'||typeof r.acknowledged!=='boolean'||r.errorCode&&(!/^[a-z0-9_]{1,80}$/.test(r.errorCode))||!Number.isSafeInteger(r.checks)||r.checks<0||r.checks>1000||!['nextRetryAt','nextCheckAt'].every(k=>r[k]===null||Number.isFinite(r[k]))||!['submittedAt','confirmedAt'].every(k=>r[k]===undefined||Number.isFinite(r[k]))||r.confirmedBy!==undefined&&r.confirmedBy!=='napcat_utc_today_first_page')fail('sign_ledger_invalid');keys.add(r.key);}
 return value;
}

export class GroupSignService {
 constructor({dir,app,now=Date.now,write=atomicJSON,autoTimer=true,callTimeoutMs=15000,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){this.dir=dir;this.app=app;this.now=now;this.write=write;this.autoTimer=autoTimer;this.callTimeoutMs=callTimeoutMs;this.settingsPath=join(dir,'group-sign-settings.json');this.ledgerPath=join(dir,'group-sign-ledger.json');this.lockPath=join(dir,'.group-sign.lock');this.config=structuredClone(GROUP_SIGN_DEFAULTS);this.ledger={version:1,clockAt:0,records:[]};this.error='';this.serial=Promise.resolve();this.timer=null;this.disposed=false;this.busy=false;this.inflight=new Set();this.wait=wait;this.dispatchQueue=[];this.dispatchTasks=new Set();this.dispatchActive=0;this.dispatchLast=-Infinity;this.dispatchSpacing=Promise.resolve();this.settingsGeneration=0;this.capabilities={checkedAt:0,version:null,packetAvailable:null,recordQueryDay:'UTC (verified NapCat implementation; other versions may differ)'};}
 async initialize(){
  try{this.config=validateSignSettings(await readJSON(this.settingsPath,this.config));await this.lock(async()=>{this.ledger=validateLedger(await readJSON(this.ledgerPath,this.ledger));let recovered=false;for(const r of this.ledger.records)if(['intent','submitted'].includes(r.status)){recovered=true;r.status='unknown';r.errorCode='sign_interrupted_by_restart';r.notSubmitted=false;r.nextCheckAt=null;r.nextRetryAt=null;r.updatedAt=this.now();}if(recovered)await this.persist();});}
  catch{this.error='sign_storage_invalid';}
  if(this.autoTimer){this.timer=setInterval(()=>void this.tick().catch(()=>{}),15000);this.timer.unref?.();}
 }
 queue(fn){const task=this.serial.then(fn);this.serial=task.catch(()=>{});return task;}
 async lock(fn){
  await mkdir(this.dir,{recursive:true});const token=randomUUID();let handle;
  try{handle=await open(this.lockPath,'wx');await handle.writeFile(JSON.stringify({pid:process.pid,token}));}
  catch(e){await handle?.close().catch(()=>{});if(e.code==='EEXIST'){try{const owner=await readJSON(this.lockPath,null);if(Number.isSafeInteger(owner?.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(probe){if(probe.code==='ESRCH'){await unlink(this.lockPath);return this.lock(fn);}}}}catch{}fail('sign_process_busy');}fail('sign_lock_failed');}
  try{return await fn();}finally{await handle.close().catch(()=>{});try{const current=await readJSON(this.lockPath,null);if(current?.token===token)await unlink(this.lockPath);}catch{}}
 }
 async persist(){try{await this.write(this.ledgerPath,this.ledger);}catch{this.error='sign_ledger_write_failed';fail(this.error);}}
 prune(){const cutoff=this.now()-this.config.retention_days*86400000;this.ledger.records=this.ledger.records.filter(r=>unresolved(r)||r.updatedAt>=cutoff);}
 async withLedger(fn){return this.queue(()=>this.lock(async()=>{if(this.error)fail(this.error);const disk=validateLedger(await readJSON(this.ledgerPath,this.ledger));if(disk.clockAt>this.ledger.clockAt||disk.records.length)this.ledger=disk;this.prune();if(this.now()+5000<this.ledger.clockAt)fail('sign_clock_rollback_wait');this.ledger.clockAt=Math.max(this.now(),this.ledger.clockAt);return fn();}));}
 sameConnection(client,account){return!this.disposed&&this.app.connected===true&&this.app.onlineConfirmed===true&&this.app.client===client&&this.app.selfId===account;}
 authorize(group,{send=false}={}){if(this.disposed)fail('sign_disposed');if(this.error)fail(this.error);const g=this.config.groups.find(g=>g.group_id===group);if(!g)fail('sign_group_not_configured');if(!validID(this.app.selfId)||!this.app.connected||!this.app.onlineConfirmed||!this.app.client)fail('sign_qq_unavailable');if(this.config.binding_qq!==this.app.selfId)fail('sign_account_changed');if(!this.app.groups?.some(g=>String(g.id??g.group_id)===group))fail('sign_group_unavailable');if(send&&(!this.config.enabled||!g.enabled))fail('sign_disabled');return g;}
 async bounded(client,action,params={}){let timer;const request=Promise.resolve().then(()=>client.call(action,params));request.catch(()=>{});try{return await Promise.race([request,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('sign_timeout'),{code:'sign_timeout'})),this.callTimeoutMs);})]);}finally{clearTimeout(timer);}}
 async inspectCapabilities(){const client=this.app.client,account=this.app.selfId;if(!this.sameConnection(client,account))fail('sign_qq_unavailable');let version=null,packetAvailable=false;try{const v=await this.bounded(client,'get_version_info');if(typeof v?.app_name==='string'&&/napcat/i.test(v.app_name))version={app_name:v.app_name.slice(0,80),app_version:String(v.app_version||'').slice(0,80)};}catch{}
  try{await this.bounded(client,'nc_get_packet_status');packetAvailable=true;}catch{}
  if(!this.sameConnection(client,account))fail('sign_connection_changed');this.capabilities={checkedAt:this.now(),version,packetAvailable,recordQueryDay:'UTC (verified NapCat implementation; other versions may differ)'};return structuredClone(this.capabilities);}
 async configure(input){return this.queue(()=>this.lock(async()=>{if(this.error)fail(this.error);const c=validateSignSettings(input);if(c.enabled){if(!validID(this.app.selfId)||!this.app.connected||!this.app.onlineConfirmed)fail('sign_qq_unavailable');if(c.binding_qq!==this.app.selfId)fail('sign_account_changed');for(const g of c.groups)if(g.enabled&&!this.app.groups?.some(x=>String(x.id??x.group_id)===g.group_id))fail('sign_group_unavailable');}try{await this.write(this.settingsPath,c);}catch{fail('sign_settings_write_failed');}this.config=c;this.settingsGeneration++;this.schedulerError='';this.pumpDispatch();return this.state();}));}
 async lookup(client,account,group,day){
  const before=signClock(this.now(),'UTC').day;let data;
  try{data=await this.bounded(client,'get_group_signed_list',{group_id:group});}catch{return{confirmed:false,code:'sign_record_query_failed'};}
  if(!this.sameConnection(client,account))return{confirmed:false,code:'sign_connection_changed'};
  if(!Array.isArray(data))return{confirmed:false,code:'sign_record_schema_unverified'};
  if(this.config.confirmation_mode!=='napcat_utc_today')return{confirmed:false,code:'sign_record_manual_confirmation'};
  let local=false;try{local=['127.0.0.1','localhost','[::1]'].includes(new URL(client.config?.ws_url).hostname);}catch{}
  if(!local||!this.capabilities.version)return{confirmed:false,code:'sign_record_contract_unverified'};
  if(before!==signClock(this.now(),'UTC').day||before!==day)return{confirmed:false,code:'sign_record_date_unverified'};
  // Installed NapCat explicitly requests UTC dayYmd and only page[0].
  // No timestamp unit is invented; an absence cannot prove an unsigned group.
  return data.some(r=>r&&String(r.user_id)===account)?{confirmed:true,code:''}:{confirmed:false,code:'sign_record_not_in_first_page'};
 }
 dispatch(fn){const promise=new Promise((resolve,reject)=>this.dispatchQueue.push({fn,resolve,reject}));this.pumpDispatch();return promise;}
 pumpDispatch(){
  if(this.disposed){for(const job of this.dispatchQueue.splice(0))job.reject(Object.assign(new Error('sign_disposed'),{code:'sign_disposed'}));return;}
  while(this.dispatchActive<this.config.dispatch_concurrency&&this.dispatchQueue.length){const job=this.dispatchQueue.shift();this.dispatchActive++;
   const task=(async()=>{const space=this.dispatchSpacing.then(async()=>{if(this.disposed)fail('sign_disposed');const delay=this.config.dispatch_interval_ms-(performance.now()-this.dispatchLast);if(delay>0)await this.wait(delay);if(this.disposed)fail('sign_disposed');this.dispatchLast=performance.now();});this.dispatchSpacing=space.catch(()=>{});await space;return job.fn();})();
   this.dispatchTasks.add(task);task.then(job.resolve,job.reject).finally(()=>{this.dispatchTasks.delete(task);this.dispatchActive--;this.pumpDispatch();});
  }
 }
 async request(group,{source='manual',acknowledged=false}={}){
  if(!['manual','schedule'].includes(source))fail('sign_invalid_source');
  if(source==='manual'&&acknowledged!==true)fail('sign_explicit_confirmation_required');
  const initial=this.authorize(group,{send:true}),generation=this.settingsGeneration,expectedDay=signClock(this.now(),initial.timezone||this.config.timezone).day;
  return this.dispatch(async()=>{
   let key,account,client,zone,day;
   const reserved=await this.withLedger(async()=>{
    const g=this.authorize(group,{send:true});if(generation!==this.settingsGeneration)fail('sign_settings_changed');
    account=this.app.selfId;client=this.app.client;zone=g.timezone||this.config.timezone;day=signClock(this.now(),zone).day;if(day!==expectedDay)fail('sign_schedule_date_changed');key=signKey(account,group,day);
    let r=this.ledger.records.find(r=>r.key===key);
    if(r?.status==='skipped'&&source==='manual'&&r.attempts===0&&r.notSubmitted){r.status='failed';r.source='manual';r.errorCode='';r.nextRetryAt=null;}
    if(r&&(r.status!=='failed'||!r.notSubmitted||r.attempts>=this.config.retry_attempts||r.nextRetryAt>this.now()))return{deduplicated:true,record:structuredClone(r)};
    if(this.config.previous_unknown_policy==='pause_group'&&this.ledger.records.some(x=>x.account===account&&x.group_id===group&&x.day!==day&&unresolved(x)))fail('sign_previous_unknown');
    if(!r){if(this.ledger.records.length>=this.config.record_limit)fail('sign_ledger_full');r={key,account,group_id:group,day,timezone:zone,status:'failed',attempts:0,createdAt:this.now(),updatedAt:this.now(),source,notSubmitted:true,acknowledged:false,errorCode:'',nextRetryAt:null,nextCheckAt:null,checks:0};this.ledger.records.push(r);}
    // Reserve the durable key before releasing the ledger lock for network I/O.
    // Another process observes intent and cannot submit the same account/group/day.
    r.status='intent';r.notSubmitted=false;r.errorCode='';r.nextRetryAt=null;r.updatedAt=this.now();await this.persist();return{reserved:true};
   });
   if(reserved.deduplicated)return reserved;
   const update=fn=>this.withLedger(async()=>{const r=this.ledger.records.find(r=>r.key===key);if(!r)fail('sign_ledger_invalid');fn(r);r.updatedAt=this.now();await this.persist();return{record:structuredClone(r)};});
   const stillAllowed=()=>{this.authorize(group,{send:true});if(generation!==this.settingsGeneration)fail('sign_settings_changed');if(!this.sameConnection(client,account)||signClock(this.now(),zone).day!==day)fail('sign_connection_changed');};
   this.inflight.add(key);this.busy=true;let submitted=false;
   try{
    const caps=await this.inspectCapabilities();stillAllowed();
    if(!caps.packetAvailable)return update(r=>{r.attempts++;r.status='failed';r.notSubmitted=true;r.errorCode='sign_packet_unavailable';r.nextRetryAt=this.retryAt(r);});
    const prior=await this.lookup(client,account,group,day);stillAllowed();
    if(prior.confirmed)return update(r=>{r.status='confirmed';r.confirmedAt=this.now();r.confirmedBy='napcat_utc_today_first_page';r.notSubmitted=true;r.errorCode='';});
    await update(r=>{r.status='intent';r.attempts++;r.notSubmitted=false;r.nextRetryAt=null;});stillAllowed();
    let responseError=null;submitted=true;
    try{await this.bounded(client,'send_group_sign',{group_id:group});}catch(error){responseError=error;}
    return await update(r=>{
     if(!responseError){r.status=this.sameConnection(client,account)?'submitted':'unknown';r.submittedAt=this.now();r.errorCode=r.status==='submitted'?'':'sign_connection_changed';r.nextCheckAt=r.status==='submitted'&&this.config.confirmation_checks?this.now()+this.config.confirmation_delay_seconds*1000:null;}
     else{r.notSubmitted=responseError?.notSubmitted===true;r.status=r.notSubmitted?'failed':'unknown';r.errorCode=codeOf(responseError);r.nextRetryAt=r.notSubmitted?this.retryAt(r):null;r.nextCheckAt=null;}
    });
   }catch(error){
    if(!submitted&&!this.error)await update(r=>{r.status='failed';r.notSubmitted=true;r.errorCode=/^sign_[a-z0-9_]+$/.test(error.code||'')?error.code:'sign_preflight_failed';r.nextRetryAt=null;});
    throw error;
   }finally{this.inflight.delete(key);this.busy=this.inflight.size>0;}
  });
 }
 retryAt(r){return r.attempts<this.config.retry_attempts?this.now()+Math.min(this.config.retry_max_seconds,this.config.retry_base_seconds*2**Math.max(0,r.attempts-1))*1000:null;}
 async check(group){return this.withLedger(async()=>{const g=this.authorize(group),account=this.app.selfId,client=this.app.client,day=signClock(this.now(),g.timezone||this.config.timezone).day,r=this.ledger.records.find(r=>r.key===signKey(account,group,day));if(!r)fail('sign_no_record');if(r.status==='confirmed')return{record:structuredClone(r)};if(!this.capabilities.checkedAt)await this.inspectCapabilities();
  const answer=await this.lookup(client,account,group,day);r.checks=(r.checks||0)+1;r.updatedAt=this.now();if(answer.confirmed){r.status='confirmed';r.confirmedAt=this.now();r.confirmedBy='napcat_utc_today_first_page';r.errorCode='';r.nextCheckAt=null;r.nextRetryAt=null;}else{r.errorCode=answer.code;if(r.status==='submitted'&&r.checks<this.config.confirmation_checks)r.nextCheckAt=this.now()+this.config.confirmation_interval_seconds*1000;else{if(['intent','submitted'].includes(r.status))r.status='unknown';r.nextCheckAt=null;}}
  await this.persist();return{record:structuredClone(r)};});}
 async acknowledge(key){return this.withLedger(async()=>{const r=this.ledger.records.find(r=>r.key===key);if(!r||r.account!==this.app.selfId||!unresolved(r))fail('sign_record_not_acknowledgeable');r.status='unknown';r.acknowledged=true;r.nextRetryAt=null;r.nextCheckAt=null;r.updatedAt=this.now();await this.persist();return this.state();});}
 async tick(){
  if(this.ticking||this.disposed||this.error||!this.config.enabled)return;this.ticking=true;
  try{
   this.schedulerError='';if(!this.app.connected||!this.app.onlineConfirmed){this.schedulerError='sign_qq_unavailable';return;}if(this.app.selfId!==this.config.binding_qq){this.schedulerError='sign_account_changed';return;}
   const work=[];for(const g of this.config.groups){if(!g.enabled||this.disposed)continue;const clock=signClock(this.now(),g.timezone||this.config.timezone),[hh,mm]=(g.time||this.config.default_time).split(':').map(Number),late=clock.minute-(hh*60+mm);const r=this.ledger.records.find(r=>r.key===signKey(this.app.selfId,g.group_id,clock.day));
    if(r?.status==='submitted'&&r.nextCheckAt!==null&&r.nextCheckAt<=this.now()){work.push(this.check(g.group_id).catch(e=>{this.schedulerError=e.code||'sign_operation_failed';}));continue;}
    if(r&&!(r.status==='failed'&&r.notSubmitted&&r.nextRetryAt!==null&&r.nextRetryAt<=this.now()&&r.attempts<this.config.retry_attempts))continue;
    if(late<0)continue;if(!r&&late>0&&(this.config.missed_policy==='skip'||late>this.config.catch_up_minutes)){await this.withLedger(async()=>{const key=signKey(this.app.selfId,g.group_id,clock.day);if(this.ledger.records.some(x=>x.key===key))return;if(this.ledger.records.length>=this.config.record_limit)fail('sign_ledger_full');this.ledger.records.push({key,account:this.app.selfId,group_id:g.group_id,day:clock.day,timezone:g.timezone||this.config.timezone,status:'skipped',attempts:0,createdAt:this.now(),updatedAt:this.now(),source:'schedule',notSubmitted:true,acknowledged:false,errorCode:'sign_missed_schedule',nextRetryAt:null,nextCheckAt:null,checks:0});await this.persist();}).catch(e=>{this.schedulerError=e.code||'sign_operation_failed';});continue;}
    work.push(this.request(g.group_id,{source:'schedule'}).catch(e=>{this.schedulerError=e.code||'sign_operation_failed';}));
   }await Promise.all(work);
  }finally{this.ticking=false;}
 }
 nextExecution(g){
  if(!this.config.enabled||!g.enabled)return null;
  const zone=g.timezone||this.config.timezone,clock=signClock(this.now(),zone),[hour,minute]=(g.time||this.config.default_time).split(':').map(Number),late=clock.minute-hour*60-minute;
  const current=this.ledger.records.find(r=>r.key===signKey(this.config.binding_qq,g.group_id,clock.day));
  if(!current&&late>=0&&(late===0||this.config.missed_policy==='within_window'&&late<=this.config.catch_up_minutes))return this.now();
  for(let offset=late<0?0:1;offset<=3;offset++){
   const date=new Date(Date.parse(clock.day+'T12:00:00Z')+offset*86400000).toISOString().slice(0,10),wanted=Date.parse(date+'T'+(g.time||this.config.default_time)+':00Z');let at=wanted;
   for(let i=0;i<4;i++){const parts=signClock(at,zone),civil=Date.parse(parts.day+'T00:00:00Z')+parts.minute*60000+parts.second*1000;const next=at+wanted-civil;if(next===at)break;at=next;}
   const actual=signClock(at,zone);if(actual.day===date&&actual.minute===hour*60+minute&&at>this.now()&&!this.ledger.records.some(r=>r.key===signKey(this.config.binding_qq,g.group_id,date)))return at;
  }return null;
 }
 state(full=true){const value={version:GROUP_SIGN_VERSION,enabled:this.config.enabled,error:this.error||this.schedulerError||'',busy:this.busy,inflight:this.inflight.size,configured_groups:this.config.groups.length,enabled_groups:this.config.groups.filter(g=>g.enabled).length,unknown:this.ledger.records.filter(unresolved).length,confirmed:this.ledger.records.filter(r=>r.status==='confirmed').length};if(full)Object.assign(value,{config:structuredClone(this.config),capabilities:structuredClone(this.capabilities),records:structuredClone(this.ledger.records.slice(-100).reverse()),schedule:this.config.groups.map(g=>({group_id:g.group_id,time:g.time||this.config.default_time,timezone:g.timezone||this.config.timezone,nextAt:this.nextExecution(g)}))});return value;}
 async close(){this.disposed=true;clearInterval(this.timer);this.pumpDispatch();await Promise.allSettled([...this.dispatchTasks]);await this.serial.catch(()=>{});}
}
