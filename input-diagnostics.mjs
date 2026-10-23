import{normalizeEvent,parseCQ,id}from'./engine.mjs';
const types=new Set(['text','at','reply','image','mface','face','record','video','file']);
export const INPUT_LENGTH_FIELDS=['bodyChars','inputChars','inputLimit','replyCount','cachedQuoteChars','embeddedQuoteChars'];
export function inputLengths(segments){
 const textLength=value=>typeof value==='string'?value.length:Array.isArray(value)?value.filter(s=>s?.type==='text'&&typeof s.data?.text==='string').reduce((n,s)=>n+s.data.text.length,0):null;
 const replies=segments.filter(s=>s?.type==='reply'),embedded=replies.map(s=>textLength(s.data?.text)??textLength(s.data?.message));
 return {bodyChars:segments.filter(s=>s?.type==='text'&&typeof s.data?.text==='string').reduce((n,s)=>n+s.data.text.length,0),inputChars:null,inputLimit:null,replyCount:replies.length,cachedQuoteChars:replies.length?null:0,embeddedQuoteChars:embedded.every(n=>n!==null)?embedded.reduce((a,b)=>a+b,0):null};
}
const cleanLengths=value=>Object.fromEntries(INPUT_LENGTH_FIELDS.filter(k=>Object.hasOwn(value,k)).map(k=>[k,Number.isSafeInteger(value[k])&&value[k]>=0?value[k]:null]));
export class InputDiagnostics{
 constructor(now=Date.now){this.now=now;this.since=now();this.events=new WeakMap();this.recent=[];this.sequence=0;}
 observe(event){
  if(!event||!['message','message_sent'].includes(event.post_type))return;
  const e=normalizeEvent(event),segments=typeof event.message==='string'?parseCQ(event.message):Array.isArray(event.message)?event.message:[],self=id(event.self_id,true);
  const record={sequence:++this.sequence,at:this.now(),postType:event.post_type,rawType:['group','private'].includes(event.message_type)?event.message_type:event.message_type?'other':'missing',
   conversation:e?.conversation_type||'unclassified',subType:['friend','group','normal','anonymous'].includes(event.sub_type)?event.sub_type:event.sub_type?'other':'missing',
   normalized:!!e,own:!!self&&(id(event.sender?.user_id,true)||id(event.user_id,true))===self,hasTime:Number.isSafeInteger(event.time),ageSeconds:Number.isSafeInteger(event.time)?Math.round(this.now()/1000-event.time):null,
   segmentTypes:[...new Set(segments.map(s=>types.has(s?.type)?s.type:'other'))].slice(0,16),imageCount:segments.filter(s=>['image','mface'].includes(s?.type)).length,
   ownMention:segments.some(s=>s?.type==='at'&&String(s.data?.qq)===self),otherMention:segments.some(s=>s?.type==='at'&&String(s.data?.qq)!==self),...inputLengths(segments),result:'observed'};
  this.events.set(event,record);this.recent.push(record);this.recent=this.recent.slice(-40);
 }
 noteRecord(value,result,metrics={}){if(!value)return;if(typeof result==='string'&&/^[a-z_]{1,64}$/.test(result))value.result=result;Object.assign(value,cleanLengths(metrics));}
 note(event,result,metrics){this.noteRecord(this.events.get(event),result,metrics);}
 sequenceOf(event){return this.events.get(event)?.sequence??null;}
 lengthsOf(event){return cleanLengths(this.events.get(event)||{});}
 noteSequence(sequence,result){this.noteRecord(this.recent.find(r=>r.sequence===sequence),result);}
 state(){return{since:this.since,recent:this.recent.map(r=>({...r,segmentTypes:[...r.segmentTypes]}))};}
}

