// Only fixed color names from our synthetic probe may enter its evaluation.
// No raw model answer, user image, prompt or credential is returned here.
import {createHash} from 'node:crypto';
const colors=new Set(['red','green','blue','yellow']);
export const PROBE_REPLY_FORMATS=['plain','inline_code','fenced','json_array','json_string','list','unrecognized'];
export function evaluateVisionProbe(reply,expected,{includeSequences=false}={}){
 const wanted=Array.isArray(expected)?expected:String(expected).trim().split(/\s+/);
 if(!wanted.length||wanted.length>32||!wanted.every(v=>colors.has(v)))throw new Error('invalid_synthetic_probe_spec');
 let text=typeof reply==='string'?reply.trim():'',format='plain',found=null;
 if(text.length<=4000&&text){
  const lines=text.split(/\r?\n/),open=lines[0].match(/^(`{3,}|~{3,})[a-z0-9_+-]*[ \t]*$/i);
  if(open&&lines.length>=3){const end=lines.at(-1).trim();if(end[0]===open[1][0]&&end.length>=open[1].length&&[...end].every(c=>c===open[1][0])){text=lines.slice(1,-1).join('\n').trim();format='fenced';}}
  const inline=text.match(/^(`+)([^\r\n]*)\1$/);if(inline&&!inline[2].includes(inline[1])){text=inline[2].trim();format='inline_code';}
  if(text.startsWith('[')||text.startsWith('"')){
   try{const json=JSON.parse(text);if(Array.isArray(json)){const flat=json.every(v=>Array.isArray(v)&&v.length===4)?json.flat():json;if(flat.length<=32&&flat.every(v=>typeof v==='string'&&colors.has(v.toLowerCase()))){found=flat.map(v=>v.toLowerCase());format='json_array';}}else if(typeof json==='string'){text=json.trim();format='json_string';}}catch{}
  }
  if(!found){
   const rows=text.split(/\r?\n/).filter(v=>v.trim());
   if(rows.length&&rows.every(v=>/^\s*(?:\d+[.)、]|[-*•])\s+/.test(v))){let ordinal=0,valid=true;const parts=rows.map(row=>row.replace(/^\s*(\d+[.)、]|[-*•])\s+/,(_,prefix)=>{if(/^\d/.test(prefix)&&Number.parseInt(prefix,10)!==++ordinal)valid=false;return'';}));if(valid){text=parts.join(' ');format='list';}}
   text=text.replace(/[.!。！]$/,'').trim().toLowerCase();
   if(/^[a-z\s,;，；、]+$/.test(text)){const tokens=text.split(/[\s,;，；、]+/).filter(Boolean);if(tokens.length<=32&&tokens.every(v=>colors.has(v)))found=tokens;}
  }
 }
 const recognized=found?.length??0,valid=!!found&&found.length===wanted.length,matchedPositions=valid?found.reduce((n,v,i)=>n+Number(v===wanted[i]),0):0,matched=valid&&matchedPositions===wanted.length;
 return{matched,reason:matched?'match':valid?'colors_mismatch':text?'format_unrecognized':'empty_response',format:found?format:'unrecognized',expectedCount:wanted.length,recognizedCount:recognized,matchedPositions,...(includeSequences?{expectedColors:[...wanted],observedColors:found?[...found]:null}:{})};
}

// Only the server-created synthetic probe opts in. Never retain image data,
// arbitrary model text, URLs, prompts, headers or user-image fingerprints.
export function safeProbeResponseModel(value,key=''){
 if(typeof value!=='string'||!value||value.length>160||!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)||/(?:sk-|bearer|secret|token|password)/i.test(value)||key&&value.includes(key))return null;
 return value;
}
export function serializedProbeImages(images,detail='auto'){
 if(!['auto','low','high'].includes(detail))return null;
 const payload=images.map(image=>{if(typeof image?.dataURL!=='string'||!image.dataURL.startsWith('data:image/png;base64,'))return null;const data=Buffer.from(image.dataURL.split(',')[1],'base64');if(data.length<24||data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return null;return{mime:'image/png',bytes:data.length,width:data.readUInt32BE(16),height:data.readUInt32BE(20),sha256:createHash('sha256').update(data).digest('hex'),detail};});
 return payload.length&&payload.every(Boolean)?payload:null;
}
export function cleanSyntheticProbeDiagnostic(value){
 if(value.syntheticVisionProbe!==true)return{};
 const sequence=a=>Array.isArray(a)&&a.length<=32&&a.every(v=>colors.has(v))?[...a]:null;
 const payload=Array.isArray(value.probeImagePayload)&&value.probeImagePayload.length>0&&value.probeImagePayload.length<=8&&value.probeImagePayload.every(v=>v&&v.mime==='image/png'&&Number.isSafeInteger(v.bytes)&&v.bytes>0&&v.bytes<=5242880&&Number.isSafeInteger(v.width)&&v.width>0&&v.width<=8192&&Number.isSafeInteger(v.height)&&v.height>0&&v.height<=8192&&typeof v.sha256==='string'&&/^[a-f0-9]{64}$/.test(v.sha256)&&['auto','low','high'].includes(v.detail))?value.probeImagePayload.map(v=>({mime:v.mime,bytes:v.bytes,width:v.width,height:v.height,sha256:v.sha256,detail:v.detail})):null;
 return{syntheticVisionProbe:true,probeExpectedSequence:sequence(value.probeExpectedSequence),probeObservedSequence:sequence(value.probeObservedSequence),probeImagePayload:payload,probeResponseModel:safeProbeResponseModel(value.probeResponseModel)};
}
