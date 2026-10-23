import{inspectVisionText}from'./vision-privacy.mjs';
export const IMAGE_INSTRUCTION_GRACE_MS=1200;
export function isVisualTask(text){return /(?:解答|解题|求解|解(?:这|此|那)(?:一)?道?题|做(?:这|此|那)(?:一)?道?题|(?:这|此|那)(?:一)?道?题.{0,12}(?:怎么|如何)|(?:帮我|请).{0,5}(?:解|算).{0,5}(?:它|他|此题)|(?:给出|写出|提供).{0,8}(?:题解|解法)|(?:换|再来|另一|再给).{0,8}(?:解法|解答|思路)|继续解答)/u.test(text);}
export function sameImageHistory(job,modelReplies,history){
 if(!job.visionSourceKey)return[];
 const turns=job.session.turns.filter(t=>t.vision&&t.visionSourceKey===job.visionSourceKey&&modelReplies.get(t)===t.answer&&inspectVisionText(t.prompt,12000,{identityFilter:job.config.local_identity_filter===true}).allowed&&inspectVisionText(t.answer,12000,{identityFilter:job.config.local_identity_filter===true}).allowed);
 return history({turns});
}
