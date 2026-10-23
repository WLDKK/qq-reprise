import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AccountPoolService,POOL_LIMITS,requestCeilings} from './account-pool-service.mjs';
import {APIAccountPool,PoolError} from './api-account-pool.mjs';
import {apiBinding,sameAPIBinding,cleanNewAPIKey} from './ai-api-draft.mjs';
import {AIProviders} from './ai-providers.mjs';
import {JsonFile} from './ai-storage.mjs';

export const CONNECTION_DEFAULTS=Object.freeze({version:2,enabled:false,mode:'primary_backup',primaryId:'',backupIds:[],connections:[],keys:{},ledgerRequired:false,revision:''});
const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v)&&!/^(?:sk-|Bearer)/i.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=code=>{throw new PoolError(code);};
export function connectionConfig(main,c){return {...main,backend:'api',api_platform:c.target.platform,api_base_url:c.target.base_url,api_format:c.target.format,api_model:c.target.model,api_max_output_tokens:c.maxOutputTokens,api_output_token_mode:'custom',timeout_seconds:c.timeoutSeconds};}
export function validateConnections(input){
 if(!exact(input,Object.keys(CONNECTION_DEFAULTS))||input.version!==2||typeof input.enabled!=='boolean'||typeof input.ledgerRequired!=='boolean'||!['primary_backup','round_robin'].includes(input.mode)||!Array.isArray(input.connections)||input.connections.length>10||!Array.isArray(input.backupIds)||!exact(input.keys,Object.keys(input.keys||{}))||typeof input.revision!=='string')fail('connection_configuration_invalid');
 const ids=new Set(),references=new Map();
 for(const c of input.connections){
  if(!exact(c,['id','name','accountId','target','credential','limits','maxOutputTokens','timeoutSeconds'])||!identifier(c.id)||!identifier(c.accountId)||ids.has(c.id))fail('pool_route_invalid');
  ids.add(c.id);
  if(typeof c.name!=='string'||!c.name.trim()||c.name.length>64||/[\x00-\x1f\x7f]/.test(c.name))fail('connection_name_invalid');
  if(!exact(c.target,['platform','base_url','format','model'])||typeof c.target.model!=='string'||!c.target.model.trim()||c.target.model.length>160||/[\x00-\x1f\x7f]/.test(c.target.model))fail('connection_target_invalid');
  try{if(!sameAPIBinding(apiBinding(connectionConfig({},c)),c.target))fail('connection_target_invalid');}catch{fail('connection_target_invalid');}
  if(!exact(c.credential,['kind','handle'])||!['existing','managed','legacy_pool'].includes(c.credential.kind)||!identifier(c.credential.handle))fail('connection_credential_invalid');
  if(c.credential.kind==='managed'&&c.credential.handle!==c.id)fail('connection_credential_invalid');
  if(!Number.isSafeInteger(c.maxOutputTokens)||c.maxOutputTokens<1||c.maxOutputTokens>1000000||!Number.isSafeInteger(c.timeoutSeconds)||c.timeoutSeconds<1||c.timeoutSeconds>3600)fail('connection_limits_invalid');
  const ref=c.credential.kind+':'+c.credential.handle,prior=references.get(ref);
  if(prior&&prior!==c.accountId)fail('connection_account_identity_conflict');references.set(ref,c.accountId);
 }
 if(input.connections.length){if(!ids.has(input.primaryId))fail('connection_primary_required');}else if(input.primaryId||input.enabled)fail('connection_primary_required');
 if(new Set(input.backupIds).size!==input.backupIds.length||input.backupIds.some(id=>!ids.has(id)||id===input.primaryId))fail('connection_backup_invalid');
 new APIAccountPool({routes:input.connections.map(c=>({id:c.id,accountId:c.accountId,limits:c.limits}))});
 if(Object.keys(input.keys).length>100)fail('connection_configuration_invalid');
 for(const [id,k] of Object.entries(input.keys)){
  if(!identifier(id)||!exact(k,['configured','target'])||typeof k.configured!=='boolean')fail('connection_configuration_invalid');
  try{if(!sameAPIBinding(apiBinding({api_platform:k.target.platform,api_base_url:k.target.base_url,api_format:k.target.format}),k.target))fail('connection_target_invalid');}catch{fail('connection_target_invalid');}
 }
 return structuredClone(input);
}

// The existing service remains available for already-authorized legacy pools.
// Reading this manager's state only reads public metadata, never a secret store.
export class ConnectionPoolService extends AccountPoolService {
 constructor(options={}){
  super(options);this.auth=options.auth;this.mainConfig=options.getMainConfig||(()=>null);
  this.connectionFile=new JsonFile(join(options.dir,'ai-connections.json'),null);this.manager=null;this.connectionLoadFailed=false;
 }
 get routingEnabled(){return this.manager?this.manager.enabled:this.config.enabled;}
 async initialize(){
  await super.initialize();
  try{const saved=await this.connectionFile.read();if(saved){this.manager=validateConnections(saved);this.pool=this.buildConnectionPool(this.manager);await this.pool.initialize();}}
  catch(e){this.error=e instanceof PoolError?e.code:'connection_configuration_invalid';this.connectionLoadFailed=true;}
 }
 existingConnection(){
  const config=this.mainConfig(),meta=this.auth?.publicState?.();if(!config||!meta?.api_configured||!identifier(meta.api_id))return null;
  let target;try{target={...apiBinding(config),model:config.api_model};}catch{return null;}
  return {id:'saved-original',name:'原已保存API连接',target,credential:{kind:'existing',handle:meta.api_id},configured:sameAPIBinding(meta.api_binding,target),maxOutputTokens:config.api_max_output_tokens,timeoutSeconds:config.timeout_seconds};
 }
 referenceReady(c,config=this.manager){
  if(c.credential.kind==='existing'){
   const meta=this.auth?.publicState?.();return meta?.api_configured===true&&meta.api_id===c.credential.handle&&sameAPIBinding(meta.api_binding,c.target);
  }
  const k=c.credential.kind==='legacy_pool'?this.config.credentials[c.credential.handle]:config?.keys[c.credential.handle];
  return k?.configured===true&&sameAPIBinding(k.target,c.target);
 }
 selected(config=this.manager){if(!config)return [];const ids=[config.primaryId,...config.backupIds];return ids.filter(Boolean).map(id=>config.connections.find(c=>c.id===id));}
 buildConnectionPool(config){
  const selected=this.selected(config),pool=new APIAccountPool({enabled:config.enabled,mode:config.mode,routes:selected.map(c=>({id:c.id,accountId:c.accountId,limits:c.limits})),now:this.now,store:this.ledger,storageRequired:config.ledgerRequired});
  pool.routes=pool.routes.filter(r=>this.referenceReady(selected.find(c=>c.id===r.id),config));return pool;
 }
 managerState(){
  const m=this.manager||CONNECTION_DEFAULTS,p=this.pool.state(),selected=this.selected(m),configured=selected.filter(c=>this.referenceReady(c,m)).length;
  return {...structuredClone(m),keys:undefined,connections:m.connections.map(c=>({...structuredClone(c),credentialConfigured:this.referenceReady(c,m)})),existingConnection:this.existingConnection(),legacyPoolEnabled:!this.manager&&this.config.enabled,legacyConfiguredCount:Object.values(this.config.credentials).filter(c=>c.configured).length,legacyCredentials:Object.entries(this.config.credentials).filter(([,v])=>v.configured).map(([handle,v])=>({handle,target:v.target})),error:this.error|| (p.persistenceError?'pool_ledger_unavailable':''),canEnable:!!m.primaryId&&selected.length>0&&configured===selected.length&&!this.error&&!p.persistenceError&&!p.reviewRequired,status:this.routingEnabled?'enabled':m.connections.length?'configured_disabled':'unconfigured',accounts:p.accounts,reviewRequired:p.reviewRequired};
 }
 state(includeConfig=true){const value=super.state(includeConfig);return {...value,enabled:this.routingEnabled,mode:this.manager?.mode||value.mode,...(includeConfig?{connectionManager:this.managerState()}:{} )};}
 assertReady(main,insideMutation=false){
  if(!this.manager)return super.assertReady(main);
  if(this.connectionLoadFailed||this.error||this.pool.persistenceError||!this.pool.initialized)fail(this.error||'pool_ledger_unavailable');
  if((this.changing&&!insideMutation)||main.backend!=='api')fail('configuration_busy');
  const selected=this.selected();if(!selected.length||selected.some(c=>!this.referenceReady(c)))fail('connection_credentials_required');
  if(this.pool.reviewRequired)fail('pool_limit_review_required');
 }
 async configureConnections(input){
  return this.mutate(async()=>{
   if(this.routingEnabled)fail('pool_disable_before_edit');
   if(this.error||this.pool.persistenceError||this.connectionLoadFailed)fail(this.error||'pool_ledger_unavailable');
   if(!exact(input,['connections','mode','primaryId','backupIds','acknowledgeExisting'])||typeof input.acknowledgeExisting!=='boolean')fail('connection_configuration_invalid');
   const prior=this.manager||CONNECTION_DEFAULTS,next=validateConnections({...structuredClone(prior),connections:input.connections,mode:input.mode,primaryId:input.primaryId,backupIds:input.backupIds,enabled:false,ledgerRequired:true,revision:randomUUID()});
   for(const c of next.connections){
    if(c.credential.kind==='managed')continue;
    const old=prior.connections.find(v=>v.id===c.id);
    if((!old||!same(old.credential,c.credential)||!same(old.target,c.target)||old.accountId!==c.accountId)&&input.acknowledgeExisting!==true)fail('connection_reference_confirmation_required');
    if(!this.referenceReady(c,next))fail('connection_reference_unavailable');
   }
   await this.pool.checkpoint();const candidate=this.buildConnectionPool(next);await candidate.initialize();
   await this.connectionFile.write(next);this.manager=next;this.pool=candidate;return this.state();
  });
 }
 async setConnectionKey(input){
  return this.mutate(async()=>{
   if(this.routingEnabled)fail('pool_disable_before_edit');
   if(!exact(input,['connectionId','key'])||!this.manager)fail('connection_configuration_invalid');
   const c=this.manager.connections.find(c=>c.id===input.connectionId);if(!c||c.credential.kind!=='managed')fail('connection_credential_invalid');
   let key;try{key=cleanNewAPIKey(input.key);}catch{fail('invalid_api_key');}
   const next=structuredClone(this.manager);next.keys[c.id]={configured:false,target:apiBinding(connectionConfig({},c))};next.revision=randomUUID();
   await this.connectionFile.write(next);this.manager=next;this.pool.routes=this.pool.routes.filter(r=>r.id!==c.id);
   try{
    await this.secrets.setSession('connections.v2:'+c.id,key?{key,target:next.keys[c.id].target}:null);
    next.keys[c.id].configured=!!key;await this.connectionFile.write(next);this.manager=next;
    const candidate=this.buildConnectionPool(next);await candidate.initialize();this.pool=candidate;
   }finally{key='';}
   return this.state();
  });
 }
 async setRouting(input,main){
  return this.mutate(async()=>{
   if(!exact(input,['enabled','acknowledged','revision'])||typeof input.enabled!=='boolean'||typeof input.acknowledged!=='boolean'||!this.manager||input.revision!==this.manager.revision)fail('connection_stale_confirmation');
   if(input.enabled){if(!input.acknowledged)fail('connection_enable_confirmation_required');this.assertReady(main,true);}
   const next={...structuredClone(this.manager),enabled:input.enabled,revision:randomUUID()};
   await this.pool.checkpoint();const candidate=this.buildConnectionPool(next);await candidate.initialize();await this.connectionFile.write(next);this.manager=next;this.pool=candidate;return this.state();
  });
 }
 async reviewConnection(input){
  if(this.routingEnabled)fail('pool_disable_before_edit');return super.review(input);
 }
 async configure(input,main){if(this.manager)fail('connection_use_manager');return super.configure(input,main);}
 async setKey(input,main){if(this.manager)fail('connection_use_manager');return super.setKey(input,main);}
 async review(input){if(this.manager)fail('connection_use_manager');return super.review(input);}
 queueTimeoutSeconds(main){return this.manager?this.manager.enabled&&main.backend==='api'?this.selected().reduce((sum,c)=>sum+c.timeoutSeconds,0)+(main.account_capacity_wait_seconds??60):main.timeout_seconds:super.queueTimeoutSeconds(main);}
 async generate(main,history,prompt,signal,onProgress=()=>{},options={}){
  main=requestCeilings(main,options);
  if(this.connectionLoadFailed)fail(this.error);
  if(!this.manager)return super.generate(main,history,prompt,signal,onProgress,options);
  if(!this.manager.enabled||main.backend!=='api'||options.image||options.testReply||options.key||!options.requestId)return this.fallback.generate(main,history,prompt,signal,onProgress,options);
  try{
   this.assertReady(main);const tokenCeiling=Number.isSafeInteger(options.outputTokenCeiling)&&options.outputTokenCeiling>0?options.outputTokenCeiling:Infinity,timeoutCeiling=Number.isSafeInteger(options.timeoutCeilingSeconds)&&options.timeoutCeilingSeconds>0?options.timeoutCeilingSeconds:Infinity;const connections=this.selected().map(c=>({...c,maxOutputTokens:Math.min(c.maxOutputTokens,tokenCeiling),timeoutSeconds:Math.min(c.timeoutSeconds,timeoutCeiling)}));
   const inputBound=Buffer.byteLength(JSON.stringify([main.instructions,history,prompt]),'utf8')+2048,reservationTokens=Object.fromEntries(connections.map(c=>[c.id,inputBound+c.maxOutputTokens]));
   const reportAdmission=progress=>{try{onProgress({phase:'budget',outputTokenMode:'custom',outputTokenLimit:progress.localReservationTokens-inputBound,...progress});}catch{}};
   reportAdmission({localBudgetReason:'checking',localAdmissionState:'checking',localReservationTokens:reservationTokens[connections[0].id],localCapacityWaitMs:0,localCapacityWaitPlannedMs:0});
   const result=await this.pool.run({requestId:options.requestId,reservationTokens,signal,maxAttempts:options.maxModelCalls??10,availabilityWaitMs:(main.account_capacity_wait_seconds??60)*1000,waitRoundsLimit:main.account_capacity_wait_rounds??8,onWait:reportAdmission,execute:async(route,context)=>{
    const c=connections.find(c=>c.id===route.id),config=connectionConfig(main,c),progress=p=>{context.progress(p);try{onProgress(p);}catch{}};
    if(!this.referenceReady(c))fail('connection_reference_unavailable');
    if(c.credential.kind==='existing'){
     const provider=new AIProviders({auth:{readAPIFor:async target=>{if(!this.referenceReady(c))fail('connection_reference_unavailable');const key=await this.auth.readAPIFor(target);if(!this.referenceReady(c))fail('connection_reference_unavailable');return key;}},fetcher:this.fetcher});
     return provider.generate(config,history,prompt,signal,progress,{beforeSubmit:options.beforeSubmit,onSubmitted:options.onSubmitted,onNotSubmitted:options.onNotSubmitted});
    }
    const sessionId=c.credential.kind==='managed'?'connections.v2:'+c.id:c.credential.handle,saved=await this.secrets.readSession(sessionId);
    if(!saved?.key||!sameAPIBinding(saved.target,c.target))fail('connection_credentials_required');
    const provider=new AIProviders({auth:{readAPIFor:async()=>saved.key},fetcher:this.fetcher});
    try{return await provider.generate(config,history,prompt,signal,progress,{beforeSubmit:options.beforeSubmit,onSubmitted:options.onSubmitted,onNotSubmitted:options.onNotSubmitted});}finally{saved.key='';}
   }});return result.answer;
  }catch(error){error.accountPoolHandled=true;throw error;}
 }
 async flush(){await super.flush();await this.connectionFile.task;}
}

export function draftFromExisting(existing,id='saved-main'){
 if(!existing?.configured)fail('connection_reference_unavailable');
 return {id,name:existing.name,accountId:'saved-original-account',target:structuredClone(existing.target),credential:structuredClone(existing.credential),limits:{...POOL_LIMITS},maxOutputTokens:existing.maxOutputTokens,timeoutSeconds:existing.timeoutSeconds};
}
