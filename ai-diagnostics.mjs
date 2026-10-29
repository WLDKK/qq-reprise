import { NETWORK_ERRORS } from './ai-network.mjs';
import { VISION_ERRORS } from './ai-vision.mjs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonFile } from './ai-storage.mjs';
import {safeCode} from './ai-auth.mjs';
import {INPUT_LENGTH_FIELDS} from './input-diagnostics.mjs';
const phases=new Set(['input','queue','preparing','privacy','budget','credentials','request_ready','http_request','http_response','streaming','reasoning','image_download','image_reference','response_incomplete','completed']);
const finishes=new Set(['stop','length','tool_calls','function_call','content_filter','completed','incomplete']);
const localErrors=new Set(['api_key_required','model_required','generation_incomplete','generation_failed','stream_interrupted','stream_required','stream_missing','stream_json_invalid','stream_event_too_large','stream_too_large','output_character_limit','empty_response','tools_not_supported','cancelled','test_cancelled','cancelled_or_timeout','api_backend_required','test_in_progress','generation_in_progress','unexpected_test_reply','daily_request_limit','network_or_provider_error','network_dns_error','network_connection_refused','network_connection_lost','network_timeout','tls_verification_failed','secure_storage_invalid','secure_storage_unavailable','interrupted_by_restart','invalid_upstream_response']);
for (const code of ['api_credential_target_mismatch','api_credential_selection_required','api_credential_target_required','api_credential_changed','api_draft_required','invalid_ai_settings','configuration_busy']) localErrors.add(code);
for(const code of NETWORK_ERRORS)localErrors.add(code);
for(const code of VISION_ERRORS)localErrors.add(code);
localErrors.add('request_timeout');
localErrors.add('qq_delivery_uncertain');localErrors.add('qq_not_submitted');
localErrors.add('group_input_rejected');
localErrors.add('participation_declined');
localErrors.add('empty_input');localErrors.add('input_too_long');
for(const code of ["pool_ledger_locked","pool_ledger_invalid","pool_configuration_invalid","pool_route_invalid","pool_target_mismatch","pool_credentials_required","pool_limit_review_required","pool_disable_before_edit","pool_review_required","pool_limits_required","pool_account_limits_conflict","pool_ledger_missing","pool_clock_rollback","pool_ledger_write_failed","pool_disabled","pool_ledger_unavailable","pool_request_invalid","pool_duplicate_request","pool_journal_full","pool_no_available_account","pool_route_scope_not_supported","pool_transport_invalid"])localErrors.add(code);
for(const code of ['vision_model_unsupported','vision_not_verified','vision_probe_mismatch','vision_image_too_large','vision_image_format_unsupported','vision_image_source_unsupported','vision_image_download_failed','vision_download_timeout','vision_sensitive_result','vision_current_image_only'])localErrors.add(code);
for(const code of ['vision_reference_scope_unknown','vision_image_ambiguous','vision_no_recent_image','vision_reference_unavailable','vision_reference_no_image'])localErrors.add(code);
for(const code of ['vision_animation_unsupported','vision_animation_timeout'])localErrors.add(code);
for(const stage of ['input','output'])for(const reason of ['credentials','identity','format','length'])localErrors.add('vision_'+stage+'_'+reason);
for(const code of ['ai_queue_full','ai_queue_expired','ai_backend_paused','ai_transport_unavailable','ai_sessions_full','queued_discarded_by_restart'])localErrors.add(code);
localErrors.add('image_instruction_merged');localErrors.add('private_hold_migration_pending');
localErrors.add('vision_reference_before_private_epoch');
const bounded=(value,max)=>Number.isSafeInteger(value)&&value>=0?Math.min(max,value):0;
const tokenCount=value=>Number.isSafeInteger(value)&&value>=0&&value<=1000000000?value:null;
const providerPhases=new Set(['http_request','http_response','streaming','reasoning','response_incomplete']);
const providerNetworkErrors=new Set(['network_or_provider_error','network_dns_error','network_connection_refused','network_connection_lost','network_timeout','tls_verification_failed','request_timeout','cancelled_or_timeout']);
const stamp=value=>Number.isSafeInteger(value)&&value>0&&value<=8640000000000000?value:null;

// Historical metadata only: old records have no endpoint/credential binding.
// Neither a local cooldown nor a retained successful response proves current availability.
export function summarizeUpstreamDiagnostics(records={}){
  const observed=[];
  const add=(r,source)=>{
    if(!r||typeof r!=='object')return;
    const http=Number.isInteger(r.httpStatus)&&r.httpStatus>=100&&r.httpStatus<=599?r.httpStatus:null;
    const error=typeof r.errorCode==='string'&&r.errorCode?(localErrors.has(r.errorCode)?r.errorCode:safeCode(r.errorCode)):'';
    if(http===null&&!(providerPhases.has(r.phase)&&(r.status==='running'||providerNetworkErrors.has(error))))return;
    const outputChars=Number.isSafeInteger(r.outputChars)&&r.outputChars>=0?Math.min(12000,r.outputChars):0;
    const complete=http!==null&&http>=200&&http<300&&outputChars>0&&['stop','completed'].includes(r.finishReason)&&
      (r.status==='completed'||r.status==='failed'&&['qq_delivery_uncertain','qq_not_submitted'].includes(error));
    const outcome=complete?'response_completed':http>=400?'request_failed':r.status==='running'?'request_pending':
      r.status==='cancelled'?'request_cancelled':http!==null&&http>=200&&http<300?'response_incomplete':'request_failed';
    observed.push({source,outcome,started_at:stamp(r.startedAt),finished_at:stamp(r.finishedAt),http_status:http,
      error_code:error,rate_limit_kind:['temporary','quota','unclassified'].includes(r.rateLimitKind)?r.rateLimitKind:null,
      retry_after_seconds:Number.isSafeInteger(r.retryAfterSeconds)&&r.retryAfterSeconds>=0&&r.retryAfterSeconds<=2147483?r.retryAfterSeconds:null,
      output_chars:outputChars,delivery:['queued','sending','sent','confirmed_late','uncertain','deferred','cancelled','expired','dropped','scope_changed'].includes(r.delivery)?r.delivery:null});
  };
  for(const r of Array.isArray(records.recent_generation)?records.recent_generation:[])add(r,'generation');
  add(records.generation,'generation');add(records.test,'test');
  observed.sort((a,b)=>(a.finished_at??a.started_at??0)-(b.finished_at??b.started_at??0));
  const last=condition=>observed.findLast(condition)||null;
  return {version:1,source_scope:'retained_diagnostics',configuration_match:'not_recorded',availability:'not_established',
    latest:observed.at(-1)||null,last_failure:last(r=>['request_failed','response_incomplete'].includes(r.outcome)),
    last_complete:last(r=>r.outcome==='response_completed')};
}

export class AIDiagnostics {
  constructor(dir,now=Date.now){this.file=new JsonFile(join(dir,'ai-diagnostics.json'),{version:1,test:null,generation:null});this.now=now;this.records={version:1,test:null,generation:null};this.recent=[];this.persistSequence=0;this.persistCompleted=0;this.persistence={status:'unknown',failureCount:0,lastFailureAt:null,lastSuccessAt:null,errorCode:''};}
  async initialize(){try{const data=await this.file.read();if(Array.isArray(data?.recent_generation))this.recent=data.recent_generation.slice(-80).map(value=>{const record=this.clean(value);if(['running','queued'].includes(record.status)){const queued=record.status==='queued';record.status=queued?'cancelled':'failed';record.errorCode=queued?'queued_discarded_by_restart':'interrupted_by_restart';record.finishedAt=this.now();}return record;});if(data?.version===1)for(const kind of ['test','generation'])if(data[kind]){this.records[kind]=this.clean(data[kind]);if(['running','queued'].includes(this.records[kind].status)){const queued=this.records[kind].status==='queued';this.records[kind].status=queued?'cancelled':'failed';this.records[kind].errorCode=queued?'queued_discarded_by_restart':'interrupted_by_restart';this.records[kind].finishedAt=this.now();}}this.trimRecent();}catch{}}
  clean(value){return {id:typeof value.id==='string'&&/^[a-f0-9-]{36}$/.test(value.id)?value.id:randomUUID(),
    startedAt:Number.isFinite(value.startedAt)?value.startedAt:0,finishedAt:Number.isFinite(value.finishedAt)?value.finishedAt:null,
    conversationType:['group','private'].includes(value.conversationType)?value.conversationType:null,backend:value.backend==='chatgpt'?'chatgpt':'api',format:value.format==='responses'?'responses':'chat_completions',
    phase:phases.has(value.phase)?value.phase:'preparing',status:['queued','running','completed','unexpected_reply','failed','cancelled','rejected','expired'].includes(value.status)?value.status:'failed',
    httpStatus:Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599?value.httpStatus:null,
    tokenUsage:value.tokenUsage&&typeof value.tokenUsage==='object'?Object.fromEntries(['input','output','total','reasoning'].map(key=>[key,tokenCount(value.tokenUsage[key])])):null,
    participationRequested:value.participationRequested===true,visionRequested:value.visionRequested===true,visionSelection:['current','recent','reference'].includes(value.visionSelection)?value.visionSelection:null,visionTask:['solve','recognize'].includes(value.visionTask)?value.visionTask:null,provisionalImage:value.provisionalImage===true,historyMessages:bounded(value.historyMessages,41),rateLimitKind:['temporary','quota','unclassified'].includes(value.rateLimitKind)?value.rateLimitKind:null,retryAfterSeconds:Number.isFinite(value.retryAfterSeconds)&&value.retryAfterSeconds>=0?Math.min(86400,value.retryAfterSeconds):null,
    generationStartedAt:Number.isFinite(value.generationStartedAt)?value.generationStartedAt:null,queuePosition:bounded(value.queuePosition,50),queueAllowanceMs:bounded(value.queueAllowanceMs,86400000),queueWaitMs:bounded(value.queueWaitMs,86400000),
    privacyStage:['input','output'].includes(value.privacyStage)?value.privacyStage:null,privacyReason:['credentials','identity','format','length','health','finance','contact_location','personal_sensitive','confidential','unreviewed'].includes(value.privacyReason)?value.privacyReason:null,
    ...Object.fromEntries(INPUT_LENGTH_FIELDS.map(key=>[key,Number.isSafeInteger(value[key])&&value[key]>=0?value[key]:null])),
    imageHTTPStatus:Number.isInteger(value.imageHTTPStatus)&&value.imageHTTPStatus>=100&&value.imageHTTPStatus<=599?value.imageHTTPStatus:null,
    imageMime:['image/png','image/jpeg','image/webp'].includes(value.imageMime)?value.imageMime:null,imageBytes:bounded(value.imageBytes,5242880),imageCount:bounded(value.imageCount,8),imageTotalBytes:bounded(value.imageTotalBytes,20971520),imageStaticFrame:value.imageStaticFrame===true,
    finishReason:finishes.has(value.finishReason)?value.finishReason:null,outputChars:Number.isSafeInteger(value.outputChars)&&value.outputChars>=0?Math.min(value.outputChars,12000):0,
    outputTokenMode:['custom','platform_default','chatgpt_managed'].includes(value.outputTokenMode)?value.outputTokenMode:value.backend==='chatgpt'?'chatgpt_managed':'custom',
    outputTokenLimit:['platform_default','chatgpt_managed'].includes(value.outputTokenMode)||value.backend==='chatgpt'?null:Number.isSafeInteger(value.outputTokenLimit)&&value.outputTokenLimit>=0?value.outputTokenLimit:0,
    localReservationTokens:tokenCount(value.localReservationTokens),localBudgetUsed:tokenCount(value.localBudgetUsed),localBudgetLimit:tokenCount(value.localBudgetLimit),localCapacityWaitMs:bounded(value.localCapacityWaitMs,2147483647),localCapacityWaitPlannedMs:bounded(value.localCapacityWaitPlannedMs,2147483647),localAdmissionState:['checking','waiting','admitted','rejected','cancelled'].includes(value.localAdmissionState)?value.localAdmissionState:null,localBudgetReason:['checking','rpm','tpm','tokens5h','tokens7d','held','cooldown','concurrency','record_limit'].includes(value.localBudgetReason)?value.localBudgetReason:null,
    requestedTokenField:['max_tokens','max_completion_tokens','max_output_tokens'].includes(value.requestedTokenField)?value.requestedTokenField:null,
    requestedTokenLimit:Number.isSafeInteger(value.requestedTokenLimit)&&value.requestedTokenLimit>0?value.requestedTokenLimit:null,
    outputCharLimit:Number.isSafeInteger(value.outputCharLimit)&&value.outputCharLimit>0?Math.min(12000,value.outputCharLimit):null,
     streamEvents:bounded(value.streamEvents,100000),textDeltaEvents:bounded(value.textDeltaEvents,100000),reasoningChars:bounded(value.reasoningChars,2097152),
     firstContentMs:Number.isSafeInteger(value.firstContentMs)&&value.firstContentMs>=0?Math.min(36000000,value.firstContentMs):null,
     timeoutSeconds:bounded(value.timeoutSeconds,3600),
    errorCode:typeof value.errorCode==='string'&&value.errorCode?(localErrors.has(value.errorCode)?value.errorCode:safeCode(value.errorCode)):'',
    delivery:['queued','sending','sent','confirmed_late','uncertain','deferred','cancelled','expired','dropped','scope_changed'].includes(value.delivery)?value.delivery:null,deliverySubmission:['not_submitted','uncertain','confirmed'].includes(value.deliverySubmission)?value.deliverySubmission:null};}
  begin(kind,config,conversationType=null){const record=this.clean({id:randomUUID(),startedAt:this.now(),conversationType,backend:config.backend,format:config.backend==='chatgpt'?'responses':config.api_format,phase:'preparing',status:'running',outputTokenMode:config.backend==='chatgpt'?'chatgpt_managed':config.api_output_token_mode||'custom',outputTokenLimit:config.backend==='api'?config.api_max_output_tokens:0,outputCharLimit:config.output_chars,timeoutSeconds:config.timeout_seconds});this.records[kind]=record;if(kind==='generation'){this.recent.push(record);this.trimRecent();}void this.persist().catch(()=>{});return record.id;}
  trimRecent(){const active=this.recent.filter(r=>['queued','running'].includes(r.status)).slice(-60),done=this.recent.filter(r=>!['queued','running'].includes(r.status)).slice(-20),keep=new Set([...active,...done].map(r=>r.id));this.recent=this.recent.filter(r=>keep.has(r.id));}
  async persist(){const sequence=++this.persistSequence;try{await this.file.write({...this.records,recent_generation:this.recent});if(sequence>=this.persistCompleted){this.persistCompleted=sequence;this.persistence.status='ok';this.persistence.errorCode='';this.persistence.lastSuccessAt=this.now();}}catch{this.persistence.failureCount=Math.min(1000000,this.persistence.failureCount+1);this.persistence.lastFailureAt=this.now();if(sequence>=this.persistCompleted){this.persistCompleted=sequence;this.persistence.status='failed';this.persistence.errorCode='diagnostics_write_failed';}}}
  update(kind,id,patch){const current=this.records[kind],old=current?.id===id?current:kind==='generation'?this.recent.find(r=>r.id===id):null;if(!old)return false;const record=this.clean({...old,...patch});if(current?.id===id)this.records[kind]=record;if(kind==='generation')this.recent=this.recent.map(r=>r.id===id?record:r);this.trimRecent();return true;}
  progress(kind,id,patch){if(this.update(kind,id,patch))void this.persist().catch(()=>{});}
  async finish(kind,id,patch){if(this.update(kind,id,{...patch,finishedAt:this.now()}))await this.persist().catch(()=>{});}
  state(){const records={test:this.records.test,generation:this.records.generation,recent_generation:this.recent};return structuredClone({...records,upstream_observation:summarizeUpstreamDiagnostics(records),persistence:this.persistence});}

}
