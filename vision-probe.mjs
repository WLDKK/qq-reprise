// Only fixed color names from our synthetic probe may enter its evaluation.
// No raw model answer, user image, prompt or credential is returned here.
const colors=new Set(['red','green','blue','yellow']);
export const PROBE_REPLY_FORMATS=['plain','inline_code','fenced','json_array','json_string','list','unrecognized'];
export function evaluateVisionProbe(reply,expected){
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
 return{matched,reason:matched?'match':valid?'colors_mismatch':text?'format_unrecognized':'empty_response',format:found?format:'unrecognized',expectedCount:wanted.length,recognizedCount:recognized,matchedPositions};
}
