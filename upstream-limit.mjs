import{safeCode}from'./ai-auth.mjs';
const MAX_WAIT_SECONDS=2147483;
const quotaCodes=new Set(['insufficient_quota','quota_exceeded','billing_hard_limit_reached','credit_balance_exhausted']);
const terminalCodes=new Set(['invalid_api_key','authorization_required','unauthorized_client','access_denied','request_forbidden','unsupported_country_region_territory','subscription_sharing_user_not_eligible','chatpass_v2_scope_not_authorized','chatpass_v2_invalid_authorization_context','invalid_authorization_context','invalid_user','invalid_scope','invalid_request','model_not_found','unsupported_capability','route_not_supported']);
const rateCodes=new Set(['rate_limit_exceeded','too_many_requests','requests_per_minute','tokens_per_minute']);
const httpDate=/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/i;
export function retryAfterSeconds(value,now=Date.now()){
 if(typeof value!=='string'||value.length>100)return null;const text=value.trim();let seconds;
 if(/^\d+$/.test(text))seconds=Number(text);else if(httpDate.test(text)){const date=Date.parse(/ GMT$/i.test(text)?text:text+' GMT');if(Number.isFinite(date))seconds=Math.max(0,Math.ceil((date-now)/1000));}
 return Number.isSafeInteger(seconds)&&seconds>=0&&seconds<=MAX_WAIT_SECONDS?seconds:null;
}
export function upstreamFailure(response,body,now=Date.now()){
 const candidates=[body?.error?.code,body?.error?.type,typeof body?.error==='string'?body.error:null].filter(v=>typeof v==='string').map(v=>v.toLowerCase());
 const raw=body?.error?.code||body?.error?.type||(typeof body?.error==='string'?body.error:''),safe=safeCode(raw),retryAfter=retryAfterSeconds(response.headers?.get('retry-after'),now);
 let code=safe!=='upstream_error'?safe:({401:'authorization_required',403:'access_denied',429:'rate_limit_exceeded'})[response.status]||(response.status>=500?'server_error':'upstream_error');
 let kind=null;if(response.status===429){
  if(candidates.some(v=>quotaCodes.has(v))){code='insufficient_quota';kind='quota';}
  else if(candidates.some(v=>terminalCodes.has(v))){const terminal=candidates.find(v=>terminalCodes.has(v));code=safeCode(terminal)==='upstream_error'?'access_denied':safeCode(terminal);kind='unclassified';}
  else if(candidates.some(v=>rateCodes.has(v))||retryAfter!==null){code='rate_limit_exceeded';kind='temporary';}
  else kind='unclassified';
 }
 return{code,rateLimitKind:kind,retryAfterSeconds:retryAfter};
}
