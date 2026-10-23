import {deflateSync} from 'node:zlib';
import {randomInt} from 'node:crypto';
import {AIError} from './ai-auth.mjs';
import {imageSegments} from './media-segments.mjs';
import {decodeStaticFrame} from './media-frame.mjs';
import {id,parseCQ} from './engine.mjs';
export const VISION_BASE='https://discovery-api.intern-ai.org.cn/v1';
export const VISION_MODEL='deepseek-v4-flash-vision';
export const VISION_MAX_BYTES=5*1024*1024;
export const VISION_RECENT_MS=120000,VISION_REFERENCE_MS=600000;
export const wantsVision=text=>!/^(?:(?:什么是|何谓|介绍一下|请解释|解释一下)\s*OCR\b.*|OCR\s*(?:是什么|如何工作|的原理).*)$/iu.test(text.trim())&&/(?:识图|识别(?:这|一下|图片|照片|图中|文字)|(?:看看|看下|看一下|看一看|请看|分析|描述|解释|读取|提取|辨认).{0,12}(?:这张|图片|照片|图中|图里)|(?:这张|这图|图片|照片|图中|图里).{0,12}(?:什么|啥|内容|文字|识别)|\bOCR\b)/iu.test(text);
export const visionTarget=config=>config.backend==='api'&&config.api_format==='chat_completions'&&config.api_base_url===VISION_BASE&&config.api_model===VISION_MODEL;
export const visionEnabled=config=>visionTarget(config)&&config.vision_enabled&&config.vision_target===VISION_BASE&&config.vision_model===VISION_MODEL&&config.vision_verified_at>0;
const scope=e=>`${e.self_id}:${e.conversation_type}:${e.peer_id}:`;
export function visionSourceAllowed(e,c,{allowOwnPrivate=false}={}){
  if(!c.enabled||!visionEnabled(c)||e.self_id!==c.binding_qq)return false;
  if(e.conversation_type==='group')return c.groups.includes(e.peer_id)&&!c.group_blacklist.includes(e.user_id)&&(e.user_id!==e.self_id||c.allow_self);
  return e.conversation_type==='private'&&!c.private_blacklist.includes(e.peer_id)&&(e.user_id===e.peer_id||(allowOwnPrivate&&e.user_id===e.self_id));
}
export class RecentVisionImages{
  constructor(now=Date.now){this.now=now;this.items=new Map();this.overflow=new Map();this.bytes=0;this.sequence=0;this.ttlMs=0;}
  configure(c){this.limit=c.vision_cache_limit??50;this.byteLimit=c.vision_cache_bytes??8388608;this.overflowLimit=c.vision_overflow_limit??100;this.ttlMs=Number.isSafeInteger(c?.context_ttl_minutes)&&c.context_ttl_minutes>0?c.context_ttl_minutes*60000:0;this.prune();}
  clear(){this.items.clear();this.overflow.clear();this.bytes=0;this.sequence=0;}
  drop(key,overflow=false){const item=this.items.get(key);if(!item)return;this.items.delete(key);this.bytes-=item.bytes;if(overflow)this.overflow.set(item.owner,this.ttlMs?item.at+this.ttlMs:Infinity);}
  prune(){const now=this.now();for(const[k,v]of this.items)if(this.ttlMs&&v.at+this.ttlMs<=now)this.drop(k);for(const[k,t]of this.overflow)if(t<=now)this.overflow.delete(k);while(this.items.size>(this.limit??50)||this.bytes>(this.byteLimit??8388608))this.drop(this.items.keys().next().value,true);while(this.overflow.size>(this.overflowLimit??100))this.overflow.delete(this.overflow.keys().next().value);}
  put(e,event,c){
    this.configure(c);if((!c.vision_reference_enabled&&!c.vision_recent_enabled)||!visionSourceAllowed(e,c)||(e.conversation_type==='private'&&event.post_type!=='message')||event.anonymous||event.from_history||event.message_source==='history'||!['message','message_sent'].includes(event.post_type)||!Number.isSafeInteger(event.time)||event.time*1000<this.now()-10000||event.time*1000>this.now()+5000)return;
    const segments=typeof event.message==='string'?parseCQ(event.message):event.message;if(!Array.isArray(segments)||segments.some(s=>s?.type==='reply'))return;
    const images=imageSegments(segments);if(!images.length)return;const key=scope(e)+e.message_id;if(this.items.has(key))return;
    const d=images.length===1?images[0].data:null;const source=typeof d?.url==='string'&&d.url?d.url:d?.file;
    const input=images.length===1&&typeof source==='string'&&source.length<Math.ceil(VISION_MAX_BYTES/3)*4+100?{url:typeof d.url==='string'?d.url:'',file:typeof d.file==='string'?d.file:''}:null;
    const bytes=input?Buffer.byteLength(JSON.stringify(input)):0,owner=scope(e)+e.user_id;
    if(bytes>this.byteLimit){this.overflow.set(owner,this.ttlMs?this.now()+this.ttlMs:Infinity);return;}
    this.items.set(key,{scope:scope(e),owner,id:e.message_id,sender:e.user_id,at:event.time*1000,observedAt:this.now(),count:images.length,input,bytes,sequence:++this.sequence});this.bytes+=bytes;
    while(this.items.size>this.limit||this.bytes>this.byteLimit)this.drop(this.items.keys().next().value,true);
  }
  reference(e,messageId,c){this.configure(c);const v=this.items.get(scope(e)+messageId);if(!v)return null;if(!visionSourceAllowed({...e,user_id:v.sender},c))throw new AIError('vision_reference_scope_unknown');if(v.count!==1||!v.input)throw new AIError('vision_image_ambiguous');return{input:structuredClone(v.input),sourceId:v.id,sourceAt:v.at};}
  recent(e,c,throughSequence=Infinity){this.configure(c);const owner=scope(e)+e.user_id,values=[...this.items.values()].filter(v=>v.owner===owner&&v.sequence<=throughSequence);if(this.overflow.has(owner)||values.length>1||values.some(v=>v.count!==1||!v.input))throw new AIError('vision_image_ambiguous');if(!values.length)throw new AIError('vision_no_recent_image');return this.reference(e,values[0].id,c);}
  hasRecent(e,throughSequence=Infinity){this.prune();return[...this.items.values()].some(v=>v.owner===scope(e)+e.user_id&&v.sequence<=throughSequence)||this.overflow.has(scope(e)+e.user_id);}
  latestAt(e,throughSequence=Infinity){this.prune();return Math.max(0,...[...this.items.values()].filter(v=>v.owner===scope(e)+e.user_id&&v.sequence<=throughSequence).map(v=>v.observedAt));}
  hasReference(e,messageId){this.prune();return this.items.has(scope(e)+messageId);}
  recall(e){this.drop(scope(e)+e.message_id);}
  state(){this.prune();return{messages:this.items.size,bytes:this.bytes,ttlSeconds:this.ttlMs/1000,limit:this.limit??50,byteLimit:this.byteLimit??8388608};}
}
export async function resolveVisionReference(e,reference,c,cache,api,signal,now=Date.now){
  const referenceId=id(reference);if(referenceId===null)throw new AIError('vision_reference_scope_unknown');
  const cached=cache.reference(e,referenceId,c);if(cached)return cached;
  if(!api?.call)throw new AIError('vision_reference_scope_unknown');
  const combined=AbortSignal.any([signal,AbortSignal.timeout(5000)]);let value;
  try{value=await abortable(api.call('get_msg',{message_id:Number(referenceId)}),combined);}catch(error){if(error?.name==='AbortError')throw error;throw new AIError('vision_reference_unavailable');}
  combined.throwIfAborted();const sender=id(value?.sender?.user_id,true)||id(value?.user_id,true),messageId=id(value?.message_id),time=Number(value?.time);
  if(messageId!==referenceId||!sender||!Number.isSafeInteger(time)||(c.context_ttl_minutes>0&&time*1000<now()-c.context_ttl_minutes*60000)||time*1000>now()+5000||(value.self_id!==undefined&&id(value.self_id,true)!==e.self_id))throw new AIError('vision_reference_scope_unknown');
  if(e.conversation_type==='group'){if(value.message_type!=='group'||id(value.group_id,true)!==e.peer_id)throw new AIError('vision_reference_scope_unknown');}
  else if(value.message_type!=='private'||id(value.group_id,true)!==null||!(sender===e.peer_id||(sender===e.self_id&&id(value.target_id,true)===e.peer_id)))throw new AIError('vision_reference_scope_unknown');
  if(!visionSourceAllowed({...e,user_id:sender},c,{allowOwnPrivate:true}))throw new AIError('vision_reference_scope_unknown');
  const segments=typeof value.message==='string'?parseCQ(value.message):value.message;if(!Array.isArray(segments))throw new AIError('vision_reference_unavailable');const images=imageSegments(segments);
  if(images.length!==1)throw new AIError(images.length?'vision_image_ambiguous':'vision_reference_no_image');
  return{input:structuredClone(images[0].data),sourceId:referenceId,sourceAt:time*1000};
}
async function abortable(promise,signal){signal.throwIfAborted();let stop;const canceled=new Promise((_,reject)=>{stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});});try{return await Promise.race([promise,canceled]);}finally{signal.removeEventListener('abort',stop);}}
export function imageData(bytes){
  if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);
  if(!bytes.length||bytes.length>VISION_MAX_BYTES)throw new AIError('vision_image_too_large');
  let mime,width=0,height=0;
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){mime='image/png';width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);}
  else if(bytes.length>8&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255){mime='image/jpeg';for(let p=2,n=0;p+8<bytes.length&&n++<256;){if(bytes[p++]!==255)break;const marker=bytes[p++];if(marker===217||marker===218)break;if(marker===0||marker===255)continue;const len=bytes.readUInt16BE(p);if(len<2||p+len>bytes.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){height=bytes.readUInt16BE(p+3);width=bytes.readUInt16BE(p+5);break;}p+=len;}}
  else if(bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'){
    mime='image/webp';const tag=bytes.toString('ascii',12,16);
    if(tag==='VP8X'){if(bytes[20]&2)throw new AIError('vision_image_format_unsupported');width=1+bytes.readUIntLE(24,3);height=1+bytes.readUIntLE(27,3);}
    else if(tag==='VP8 '&&bytes[23]===157&&bytes[24]===1&&bytes[25]===42){width=bytes.readUInt16LE(26)&16383;height=bytes.readUInt16LE(28)&16383;}
    else if(tag==='VP8L'&&bytes[20]===47){const v=bytes.readUInt32LE(21);width=(v&16383)+1;height=((v>>>14)&16383)+1;}
  }
  if(!mime||!width||!height||width>8192||height>8192||width*height>20000000)throw new AIError('vision_image_format_unsupported');
  return{dataURL:'data:'+mime+';base64,'+bytes.toString('base64'),mime,bytes:bytes.length};
}
export async function prepareImageBytes(bytes,signal,decoder=decodeStaticFrame){
  signal.throwIfAborted();if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);
  if(!bytes.length||bytes.length>VISION_MAX_BYTES)throw new AIError('vision_image_too_large');
  const gif=bytes.length>=10&&/^GIF8[79]a$/.test(bytes.toString('ascii',0,6));
  const webp=bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,16)==='WEBPVP8X'&&(bytes[20]&2);
  let apng=false;if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){for(let p=8,n=0;p+12<=bytes.length&&n++<10000;){const len=bytes.readUInt32BE(p);if(len>bytes.length-p-12)break;const tag=bytes.toString('ascii',p+4,p+8);if(tag==='acTL'){apng=true;break;}p+=len+12;}}
  if(!gif&&!webp&&!apng)return imageData(bytes);
  const width=gif?bytes.readUInt16LE(6):webp?1+bytes.readUIntLE(24,3):bytes.readUInt32BE(16),height=gif?bytes.readUInt16LE(8):webp?1+bytes.readUIntLE(27,3):bytes.readUInt32BE(20);
  if(!width||!height||width>8192||height>8192||width*height>20000000)throw new AIError('vision_image_format_unsupported');
  const frame=await decoder(bytes,signal);signal.throwIfAborted();const result=imageData(frame);
  if(result.mime!=='image/png')throw new AIError('vision_animation_unsupported');
  return{...result,animation:'static_frame'};
}
export async function prepareVisionImage(input,signal,fetcher=globalThis.fetch,timeoutMs=10000){
  const combined=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.min(10000,timeoutMs)))]);let reader;
  try{
    const source=typeof input?.url==='string'&&input.url?input.url:input?.file;
    if(typeof source!=='string')throw new AIError('vision_image_source_unsupported');
    if(source.startsWith('base64://')){const b=source.slice(9);if(b.length>Math.ceil(VISION_MAX_BYTES/3)*4||!b||!/^[A-Za-z0-9+/]*={0,2}$/.test(b))throw new AIError('vision_image_too_large');return await prepareImageBytes(Buffer.from(b,'base64'),combined);}
    let url;try{url=new URL(source);}catch{throw new AIError('vision_image_source_unsupported');}
    if(url.username||url.password||url.hash||!['http:','https:'].includes(url.protocol)||!/(?:^|\.)(?:qpic\.cn|gtimg\.cn|qq\.com|qq\.com\.cn)$/i.test(url.hostname)||url.port)throw new AIError('vision_image_source_unsupported');
    url.protocol='https:';
    const response=await abortable(Promise.resolve(fetcher(url.href,{redirect:'error',headers:{Accept:'image/png,image/jpeg,image/webp,image/gif'},signal:combined})).then(r=>{if(combined.aborted){void r.body?.cancel().catch(()=>{});combined.throwIfAborted();}return r;}),combined);
    if(!response.ok||!response.body){void response.body?.cancel().catch(()=>{});const error=new AIError('vision_image_download_failed');if(Number.isInteger(response.status)&&response.status>=100&&response.status<=599)error.imageHTTPStatus=response.status;throw error;}
    if(Number(response.headers.get('content-length'))>VISION_MAX_BYTES){void response.body.cancel().catch(()=>{});throw new AIError('vision_image_too_large');}
    reader=response.body.getReader();const cancel=()=>{void reader.cancel().catch(()=>{});};combined.addEventListener('abort',cancel,{once:true});const chunks=[];let size=0;
    try{for(;;){const part=await abortable(reader.read(),combined);combined.throwIfAborted();if(part.done)break;size+=part.value.length;if(size>VISION_MAX_BYTES)throw new AIError('vision_image_too_large');chunks.push(part.value);}}finally{combined.removeEventListener('abort',cancel);cancel();try{reader.releaseLock();}catch{}}
    return await prepareImageBytes(Buffer.concat(chunks,size),combined);
  }catch(error){if(error?.name==='TimeoutError')throw new AIError('vision_download_timeout');throw error;}
}
function crc32(bytes){let c=0xffffffff;for(const byte of bytes){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);t.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([t,data])),data.length+8);return out;}
export function makeVisionProbe(){
  const colors=[['red',[255,0,0]],['green',[0,255,0]],['blue',[0,0,255]],['yellow',[255,255,0]]];for(let i=3;i>0;i--){const j=randomInt(i+1);[colors[i],colors[j]]=[colors[j],colors[i]];}
  const size=64,raw=Buffer.alloc(size*(1+size*3));for(let y=0;y<size;y++){const row=y*(1+size*3);for(let x=0;x<size;x++){const rgb=colors[(y>=32?2:0)+(x>=32?1:0)][1];for(let k=0;k<3;k++)raw[row+1+x*3+k]=rgb[k];}}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=2;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
  return{image:imageData(png),expected:colors.map(c=>c[0]).join(' '),prompt:'Name the four solid-color quadrants in this image, in order: top-left, top-right, bottom-left, bottom-right. Use only the words red, green, blue, yellow. Reply only with four English lowercase color names separated by spaces.'};
}
