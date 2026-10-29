import {AIError} from './ai-auth.mjs';
export const PROBE_SIZES=[64,256,512,1024];
export const IMAGE_DETAILS=['auto','low','high'];
const colors=new Set(['red','green','blue','yellow']);
// Per-operation synthetic test controls. Never enable user-image export or
// reuse an old success. A replay reuses only locally generated color stimuli.
export function visionTestOptions(input,count,last){
 const size=input.probe_size??64,detail=input.image_detail??'auto',reuse=input.reuse_last_probe??false;
 if(!PROBE_SIZES.includes(size)||!IMAGE_DETAILS.includes(detail)||typeof reuse!=='boolean')throw new AIError('vision_probe_options_invalid');
 if(!reuse&&input.expected_probe_finished_at!==undefined)throw new AIError('vision_probe_options_invalid');
 let wanted=null;
 if(reuse){
  const value=last?.probeExpectedSequence;
  if(last?.syntheticVisionProbe!==true||!Number.isSafeInteger(input.expected_probe_finished_at)||input.expected_probe_finished_at!==last.finishedAt||!Array.isArray(value)||value.length!==count*4||!value.every(v=>colors.has(v)))throw new AIError('vision_probe_replay_unavailable');
  for(let i=0;i<value.length;i+=4)if(new Set(value.slice(i,i+4)).size!==4)throw new AIError('vision_probe_replay_unavailable');
  wanted=[...value];
 }
 return{size,detail,reuse,colors:wanted,referenceFinishedAt:reuse?last.finishedAt:null};
}
