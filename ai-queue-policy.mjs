// A finite admission-time allowance: subsequent arrivals cannot extend it.
const number=(value,fallback,max)=>Number.isFinite(value)&&value>=0?Math.min(max,value):fallback;
export function workAllowanceMs(config,{vision=false,intervalMs=0,jitterMs=0,apiTimeoutMs=7000,timeoutSeconds=config.timeout_seconds}={}){
 return Math.ceil(number(timeoutSeconds,30,Number.MAX_SAFE_INTEGER)*1000+(vision?15000:0)+(config.private_local_review?20000:0)+number(config.cooldown_seconds,0,Number.MAX_SAFE_INTEGER)*1000+number(intervalMs,0,60000)+number(jitterMs,0,10000)+number(apiTimeoutMs,7000,60000)+5000);
}
export function queueAllowanceMs(config,predecessors,{cooldownMs=0,testing=false,...transport}={}){
 const base=number(config.queue_wait_seconds,60,Number.MAX_SAFE_INTEGER)*1000;
 const prior=predecessors.filter(j=>!j.cancelled).reduce((sum,j)=>sum+workAllowanceMs(j.config||config,{...transport,vision:!!j.visionRequest,timeoutSeconds:j.queueTimeoutSeconds??(j.config||config).timeout_seconds}),0);
 return Math.min(2147483647,Math.ceil(base+number(cooldownMs,0,Number.MAX_SAFE_INTEGER)+prior+(testing?workAllowanceMs(config,transport):0)));
}
export const queueDeadline=(job,config)=>job.created+(Number.isFinite(job.queueAllowanceMs)?job.queueAllowanceMs:config.queue_wait_seconds*1000);
