export const MAX_TEMPORARY_RECOVERIES=3;
const MAX_WAIT_SECONDS=2147483;
const terminalCodes=new Set(['insufficient_quota','quota_exceeded','billing_hard_limit_reached','credit_balance_exhausted','invalid_api_key','authorization_required','unauthorized_client','access_denied','request_forbidden','unsupported_country_region_territory','subscription_sharing_user_not_eligible','invalid_scope','invalid_request','model_not_found','unsupported_capability','route_not_supported']);
export function temporaryCooldown(error,attempts,now,generation,config={}){
 const limit=config.temporary_recovery_attempts??MAX_TEMPORARY_RECOVERIES,max=config.temporary_recovery_max_retry_after_seconds??300,min=config.temporary_recovery_min_seconds??10;
 if(config.temporary_recovery_enabled===false||!Number.isSafeInteger(attempts)||attempts<0||error?.status!==429||error.rateLimitKind!=='temporary'||terminalCodes.has(typeof error.code==='string'?error.code.toLowerCase():'')||(limit>0&&attempts>=limit))return null;
 const retry=error.retryAfterSeconds;
 if(retry!==null&&retry!==undefined&&(!Number.isFinite(retry)||retry<0||retry>MAX_WAIT_SECONDS||(max>0&&retry>max)))return null;
 const base=Math.max(1,min),ceiling=Math.max(base,max>0?max:MAX_WAIT_SECONDS);
 const backoff=Math.min(MAX_WAIT_SECONDS,ceiling,base*2**Math.min(attempts,30));
 const seconds=Math.max(backoff,Math.ceil(retry??0));
 return{until:now+seconds*1000,generation,seconds,startedAt:now,retryAfterSeconds:retry??null,strategy:retry===null||retry===undefined?'exponential_backoff':'retry_after_and_backoff'};
}
