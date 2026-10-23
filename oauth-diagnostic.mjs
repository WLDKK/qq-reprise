// Fixed field paths and bounded machine identifiers only. Never persist raw responses or authorization values.
import { JsonFile } from './ai-storage.mjs';
import { join } from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const stages = new Set(['callback_validation', 'token_exchange', 'id_token_validation', 'credential_validation', 'session_save', 'completed']);
const codes = new Set(['access_denied', 'invalid_request', 'invalid_scope', 'unauthorized_client', 'server_error', 'temporarily_unavailable',
  'authorization_required', 'invalid_grant', 'token_response_invalid', 'invalid_upstream_response', 'upstream_response_too_large',
  'oidc_endpoint_invalid', 'oidc_issuer_invalid', 'id_token_invalid', 'id_token_algorithm_invalid', 'id_token_key_invalid',
  'id_token_signature_invalid', 'id_token_claims_invalid', 'oauth_attempt_cancelled', 'secure_storage_unavailable', 'secure_storage_invalid']);
for(const code of ['invalid_client','unsupported_grant_type','unsupported_response_type','oauth_state_invalid','oauth_callback_invalid','oauth_client_invalid','oauth_code_missing','invalid_callback','subscription_sharing_user_not_eligible','subscription_sharing_user_unavailable','chatpass_v2_scope_not_authorized','invalid_authorization_context'])codes.add(code);
codes.add('chatpass_v2_invalid_authorization_context');
const sources=new Set(['provider_json','provider_callback','http_status_mapping','local_validation','transport','unknown','none']);
const shapes=new Set(['oauth_error_string','error_object','detail_object','json_other','non_json','empty','unavailable']);
const providerStatuses=new Set(['recognized','safe_identifier','redacted','unrecognized','malformed','absent_in_supported_paths','non_json','empty','unavailable','unknown']);
const requestStatuses=new Set(['captured','present_rejected','absent_in_supported_headers','unknown']);
const requestHeaders=['openai-request-id','x-request-id','request-id'];
const responseCodeFields=['error','error.code','error.type','code','error_code','detail.code','detail.type','detail.error','detail.error.code','detail.error.type','error.error.code','error.error.type',...Array.from({length:4},(_,n)=>['errors.'+n+'.code','errors.'+n+'.type']).flat()];
const codeFields=new Set([...responseCodeFields,'callback.error']);
const mediaTypes=new Set(['application/json','application/problem+json','application/*+json','text/html','text/plain','application/octet-stream','other','absent','invalid']);
export function safeOAuthContentType(value){
 if(value===null||value===undefined)return'absent';
 if(typeof value!=='string'||value.length>512||/[\r\n\u0000]/.test(value))return'invalid';
 const type=value.split(';',1)[0].trim().toLowerCase();
 if(['application/json','application/problem+json','text/html','text/plain','application/octet-stream'].includes(type))return type;
 if(/^application\/[a-z0-9][a-z0-9.+-]{0,100}\+json$/.test(type))return'application/*+json';
 return/^[a-z0-9][a-z0-9.+-]{0,100}\/[a-z0-9][a-z0-9.+-]{0,100}$/.test(type)?'other':'invalid';
}
export function oauthClientReference(value){return typeof value==='string'&&/^[A-Za-z0-9_-]{3,200}$/.test(value)&&value!=='dynamic_agent_client'?'sha256:'+createHash('sha256').update(value).digest('hex').slice(0,24):null;}
export function safeOAuthProviderCode(value){
 if(codes.has(value))return value;
 if(typeof value!=='string'||value.length<3||value.length>96)return null;
 // Reject free text, mixed-case opaque strings, long opaque runs, and secret markers.
 if(!/^(?:[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*|[A-Z][A-Z0-9]*(?:[._:-][A-Z0-9]+)*)$/.test(value))return null;
 if(/(?:sk[-_]|rk[-_]|pk[-_]|gh[pousr]_|eyj|bearer|cookie|password|passwd|secret|private|verifier|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization[_-]?code|client[_-]?secret)/i.test(value))return null;
 if(/[a-z0-9]{24,}/i.test(value)||/[0-9]{9,}/.test(value)||(value.match(/[0-9]/g)||[]).length>12||!/[a-z]/i.test(value))return null;
 if(/[0-9]/.test(value)&&!/[._:-]/.test(value))return null;
 return value;
}
export function safeOAuthRequestId(value){return typeof value==='string'&&value.length<=128&&/^(?:req_[A-Za-z0-9_-]{6,100}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/.test(value)&&!/(?:sk[-_]|rk[-_]|bearer|eyJ|secret|verifier|cookie|password|passwd|private|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token)/i.test(value)?value:null;}
function observeIdentifier(candidates,fallback='absent_in_supported_paths'){
 const safe=candidates.find(v=>safeOAuthProviderCode(v.value));
 if(safe){const value=safeOAuthProviderCode(safe.value);return{value,field:safe.field,status:codes.has(value)?'recognized':'safe_identifier'};}
 const rejected=candidates.find(v=>typeof v.value==='string'&&v.value.length>0),candidate=rejected||candidates[0];
 return{value:null,field:candidate?.field||null,status:rejected?'redacted':candidate?'malformed':fallback};
}
function codeObservation(body,shape){
 if(['non_json','empty','unavailable'].includes(shape))return{providerErrorCode:null,providerErrorField:null,providerCodeStatus:shape,providerErrorType:null,providerErrorTypeField:null,providerTypeStatus:shape};
 const candidates=[];
 for(const field of responseCodeFields){
  let value=body,present=true;
  for(const part of field.split('.')){if(value===null||typeof value!=='object'||!Object.hasOwn(value,part)){present=false;break;}value=value[part];}
  if(!present)continue;
  if(['error','detail.error'].includes(field)&&value&&typeof value==='object'&&!Array.isArray(value))continue;
  candidates.push({field,value});
 }
 const typeCandidates=candidates.filter(v=>v.field.endsWith('.type'));
 const codeCandidates=candidates.filter(v=>!v.field.endsWith('.type'));
 let code=observeIdentifier(codeCandidates);const type=observeIdentifier(typeCandidates);
 if(!code.value&&(type.value||!codeCandidates.length&&typeCandidates.length))code=type;
 return{providerErrorCode:code.value,providerErrorField:code.field,providerCodeStatus:code.status,providerErrorType:type.value,providerErrorTypeField:type.field,providerTypeStatus:type.status};
}
export function oauthCallbackMetadata(value){const code=safeOAuthProviderCode(value);return{providerErrorCode:code,providerErrorField:'callback.error',providerCodeStatus:code?codes.has(code)?'recognized':'safe_identifier':typeof value==='string'&&value?'redacted':'malformed',classificationSource:'provider_callback'};}
export function oauthResponseMetadata(response,body,localCode='',bodyShape=null){
 const shape=shapes.has(bodyShape)?bodyShape:typeof body?.error==='string'?'oauth_error_string':body?.error&&typeof body.error==='object'?'error_object':body&&typeof body==='object'&&Object.hasOwn(body,'detail')?'detail_object':'json_other';
 const observed=codeObservation(body,shape);
 let requestId=null,requestIdHeader=null,headerPresent=false;
 for(const header of requestHeaders){const value=response.headers?.get(header);if(value!==null&&value!==undefined){headerPresent=true;requestIdHeader||=header;}const safe=safeOAuthRequestId(value);if(safe){requestId=safe;requestIdHeader=header;break;}}
 return {httpStatus:Number.isInteger(response.status)?response.status:null,...observed,requestId,requestIdHeader,requestIdStatus:requestId?'captured':headerPresent?'present_rejected':'absent_in_supported_headers',
  classificationSource:response.ok?'none':observed.providerErrorCode&&observed.providerErrorCode===localCode?'provider_json':'http_status_mapping',bodyShape:shape,responseContentType:safeOAuthContentType(response.headers?.get('content-type'))};
}
export function oauthDiagnosticCode(error) {
  if (codes.has(error?.code)) return error.code;
  if (error?.name === 'TimeoutError') return 'request_timeout';
  if (error?.name === 'AbortError') return 'cancelled';
  const cause = error?.cause?.code || error?.code;
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(cause)) return 'network_dns_error';
  if (['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(cause)) return 'tls_verification_failed';
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(cause)) return 'network_connection_error';
  return 'oauth_step_failed';
}
const allCodes = new Set([...codes, 'request_timeout', 'cancelled', 'network_dns_error', 'tls_verification_failed', 'network_connection_error', 'oauth_step_failed']);
const rejectionReasons=new Set(['no_pending','expired','already_claimed','state_mismatch','duplicate_parameter','target_mismatch']);
const attemptID=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)?value:null;
export const OAUTH_DIAGNOSTIC_VERSION='oauth-provider-identifiers-v5-20261018';
export function renderOAuthResultPage(state){
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const describe=record=>record?new Date(record.at).toISOString()+' · '+record.stage+' · '+record.status+(record.httpStatus?' · HTTP '+record.httpStatus:'')+(record.errorCode?' · 本地归类 '+record.errorCode+'（'+({http_status_mapping:'HTTP状态映射',provider_json:'服务端已知代码',provider_callback:'已验证回调代码',local_validation:'本地检查',transport:'传输错误'}[record.classificationSource]||'来源未记录')+'）':'')+' · 上游错误代码 '+(record.providerErrorCode||'未记录')+(record.providerErrorField?' ['+record.providerErrorField+']':'')+' · 代码记录状态 '+(record.providerCodeStatus||'unknown')+' · 上游错误类型 '+(record.providerErrorType||'未记录')+(record.providerErrorTypeField?' ['+record.providerErrorTypeField+']':'')+' · 响应Content-Type '+(record.responseContentType||'未记录')+' · 响应形态 '+(record.bodyShape||'未记录')+' · 请求ID '+(record.requestId||'未记录')+'（'+(record.requestIdStatus||'unknown')+'）'+(record.callbackRejectionReason?' · 回调原因 '+record.callbackRejectionReason:''):'未保留首次结果；不能根据刷新错误推断首次失败原因。';
  const first=state?.primary;
  const latest=state?.last;
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT授权结果</title><style>body{font:16px/1.7 system-ui;max-width:800px;margin:48px auto;padding:0 24px;overflow-wrap:anywhere}h1{font-size:26px}p{white-space:pre-wrap}</style><h1>ChatGPT授权结果</h1><p>本次首次结果：'+escape(describe(first))+'</p>'+(latest&&(!first||latest.at!==first.at||latest.eventKind!==first.eventKind)?'<p>最近后续事件：'+escape(describe(latest))+'</p>':'')+'<p>刷新此页只查看结果，不会再次处理授权。授权邮件不代表绑定已保存，请以助手中的账户状态为准。</p>'+(state?.persistenceOK===false?'<p>本机诊断保存失败；请先核对存储状态。</p>':'')+'<p><a href="/">返回QQ助手查看账户状态</a></p></html>';
}
export class OAuthDiagnostic {
  constructor(dir, now = Date.now) { this.file = new JsonFile(join(dir, 'ai-oauth-diagnostic.json'), null); this.now = now; this.last = null; this.history=[];this.attempts=[];this.currentAttemptId=null;this.persistenceOK=true; }
  clean(value) {
    if (!value || !stages.has(value.stage) || !['completed', 'failed'].includes(value.status) || !Number.isSafeInteger(value.at) || value.at < 0) return null;
    const providerErrorCode=safeOAuthProviderCode(value.providerErrorCode),providerCodeStatus=providerErrorCode?codes.has(providerErrorCode)?'recognized':'safe_identifier':providerStatuses.has(value.providerCodeStatus)&&!['recognized','safe_identifier'].includes(value.providerCodeStatus)?value.providerCodeStatus:'unknown';
    const providerErrorType=safeOAuthProviderCode(value.providerErrorType),providerTypeStatus=providerErrorType?codes.has(providerErrorType)?'recognized':'safe_identifier':providerStatuses.has(value.providerTypeStatus)&&!['recognized','safe_identifier'].includes(value.providerTypeStatus)?value.providerTypeStatus:'unknown';
    const requestId=safeOAuthRequestId(value.requestId),requestIdStatus=requestId?'captured':requestStatuses.has(value.requestIdStatus)&&value.requestIdStatus!=='captured'?value.requestIdStatus:'unknown';
    return { version:4,at:value.at,stage:value.stage,status:value.status,attemptId:attemptID(value.attemptId),eventKind:value.eventKind==='callback_rejection'?'callback_rejection':'result',callbackRejectionReason:rejectionReasons.has(value.callbackRejectionReason)?value.callbackRejectionReason:null,errorCode:value.status==='completed'?'':allCodes.has(value.errorCode)?value.errorCode:'oauth_step_failed',httpStatus:Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599?value.httpStatus:null,
      classificationSource:value.status==='completed'?'none':sources.has(value.classificationSource)&&value.classificationSource!=='none'?value.classificationSource:'unknown',providerErrorCode,providerCodeStatus,providerErrorField:['recognized','safe_identifier','redacted','unrecognized','malformed'].includes(providerCodeStatus)&&codeFields.has(value.providerErrorField)?value.providerErrorField:null,providerErrorType,providerTypeStatus,providerErrorTypeField:codeFields.has(value.providerErrorTypeField)&&value.providerErrorTypeField.endsWith('.type')?value.providerErrorTypeField:null,requestId,requestIdStatus,requestIdHeader:['captured','present_rejected'].includes(requestIdStatus)&&requestHeaders.includes(value.requestIdHeader)?value.requestIdHeader:null,bodyShape:shapes.has(value.bodyShape)?value.bodyShape:null,responseContentType:mediaTypes.has(value.responseContentType)?value.responseContentType:null,
      tokenEndpoint:value.tokenEndpoint==='official_siwc_token'?value.tokenEndpoint:null,requestEncoding:value.requestEncoding==='form_urlencoded'?value.requestEncoding:null,clientKind:value.clientKind==='public_dynamic_oss'?value.clientKind:null,registrationKind:['new_dynamic','saved_issued'].includes(value.registrationKind)?value.registrationKind:null,clientReference:typeof value.clientReference==='string'&&/^sha256:[a-f0-9]{24}$/.test(value.clientReference)?value.clientReference:null,
      csrfValidated:typeof value.csrfValidated==='boolean'?value.csrfValidated:null,callbackTargetMatches:typeof value.callbackTargetMatches==='boolean'?value.callbackTargetMatches:null,redirectUriMatches:typeof value.redirectUriMatches==='boolean'?value.redirectUriMatches:null,pkceMethod:value.pkceMethod==='S256'?value.pkceMethod:null,pkceConsistent:typeof value.pkceConsistent==='boolean'?value.pkceConsistent:null};
  }
  async initialize() {
    try {
      const saved=await this.file.read();
      if(saved?.version===4&&Array.isArray(saved.history)&&Array.isArray(saved.attempts)){
        this.history=saved.history.slice(-32).map(v=>this.clean(v)).filter(Boolean);
        this.last=this.clean(saved.last)||this.history.at(-1)||null;
        this.attempts=saved.attempts.slice(-12).flatMap(v=>{const id=attemptID(v?.id);if(!id||!Number.isSafeInteger(v.startedAt)||v.startedAt<0)return[];const firstResult=this.clean(v.firstResult);return[{id,startedAt:v.startedAt,firstResult:firstResult?.attemptId===id?firstResult:null}];});
        this.currentAttemptId=this.attempts.some(v=>v.id===saved.currentAttemptId)?saved.currentAttemptId:null;
      } else {
        this.last=this.clean(saved);
        if(this.last){
          this.history=[this.last];
          // A legacy rejection cannot establish the lost first outcome.
          if(this.last.stage!=='callback_validation'||this.last.csrfValidated===true&&this.last.callbackTargetMatches===true){
            const id=randomUUID();this.last={...this.last,attemptId:id};this.history=[this.last];this.attempts=[{id,startedAt:this.last.at,firstResult:this.last}];this.currentAttemptId=id;
          }else this.last={...this.last,eventKind:'callback_rejection'},this.history=[this.last];
        }
      }
    } catch {this.persistenceOK=false;}
  }
  async persist(){
    try{await this.file.write({version:4,currentAttemptId:this.currentAttemptId,attempts:this.attempts,history:this.history,last:this.last});this.persistenceOK=true;}catch{this.persistenceOK=false;}
  }
  async beginAttempt(id){
    if(!attemptID(id))return;
    this.currentAttemptId=id;
    if(!this.attempts.some(v=>v.id===id))this.attempts.push({id,startedAt:this.now(),firstResult:null});
    this.attempts=this.attempts.slice(-12);await this.persist();
  }
  async record(stage, error = null, context = {}) {
    const responseMeta=error?.oauthDiagnosticMeta||{},httpStatus=Number.isInteger(error?.status)&&error.status>=100?error.status:responseMeta.httpStatus??context.httpStatus;
    const classified=error?oauthDiagnosticCode(error):'',source=responseMeta.classificationSource&&responseMeta.classificationSource!=='none'?responseMeta.classificationSource:/^network_|^tls_|request_timeout|cancelled$/.test(classified)?'transport':error?'local_validation':'none';
    let id=attemptID(context.attemptId);
    if(!id&&context.eventKind!=='callback_rejection'&&(stage!=='callback_validation'||context.csrfValidated===true&&context.callbackTargetMatches===true)){
      id=this.currentAttemptId||randomUUID();
      if(!this.attempts.some(v=>v.id===id)){this.currentAttemptId=id;this.attempts.push({id,startedAt:this.now(),firstResult:null});this.attempts=this.attempts.slice(-12);}
    }
    this.last=this.clean({...context,...responseMeta,attemptId:id,at:this.now(),stage,status:error?'failed':'completed',errorCode:classified,httpStatus,classificationSource:source});
    if(!this.last)return;
    this.history.push(this.last);this.history=this.history.slice(-32);
    const attempt=this.attempts.find(v=>v.id===id);
    if(attempt&&!attempt.firstResult&&this.last.eventKind!=='callback_rejection')attempt.firstResult=this.last;
    await this.persist(); // Diagnostic storage failures must not change authentication.
  }
  state() {
    if(!this.last&&!this.attempts.length)return null;
    const first=this.attempts.find(v=>v.id===this.currentAttemptId)?.firstResult||null;
    return structuredClone({...first||this.last||{},version:4,patchVersion:OAUTH_DIAGNOSTIC_VERSION,primary:first,primaryResultAvailable:!!first,currentAttemptId:this.currentAttemptId,last:this.last,latestCallbackError:this.history.findLast(v=>v.eventKind==='callback_rejection')||null,attempts:this.attempts,history:this.history,persistenceOK:this.persistenceOK});
  }
}
