// RAM-only snapshots of received messages. No history scan, local file reads or retries of sends.
const mediaTypes = new Set(['image','record','video','file']);
const plain = text => ({type:'text',data:{text}});
const notice = text => plain('〔'+text+'〕');
const qqId = value => /^\d{5,20}$/.test(String(value??'')) ? String(value) : '';
const supported = new Set(['text','face','at','image','record','video','file','json','xml']);
const mediaName = type => ({image:'图片',record:'语音',video:'视频',file:'文件'}[type]||type);

export function needsRichSnapshot(message) {
  return message.some(s=>['forward','node','record','video','file','json','xml','miniapp','markdown','onlinefile','flashtransfer'].includes(s.type));
}
export function pendingRichMessage(message) {
  return message.map(s=>['text','face'].includes(s.type)?structuredClone(s):notice(s.type==='forward'||s.type==='node'?'转发节点未完成缓存，无法还原原记录':'消息资源未完成缓存，无法保证恢复'));
}
function safeMediaUrl(value) {
  try {
    const u=new URL(value);
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port&& !['80','443'].includes(u.port))return null;
    // QQ typed media fields only; arbitrary chat URLs and private/local addresses are never fetched.
    if(!['qq.com','qpic.cn','qlogo.cn','gtimg.cn'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))return null;
    return u.href;
  } catch {return null;}
}
async function bounded(promise,signal) {
  signal.throwIfAborted();let stop;
  try {return await Promise.race([promise,new Promise((_,reject)=>{stop=()=>reject(signal.reason||new Error('aborted'));signal.addEventListener('abort',stop,{once:true});})]);}
  finally {signal.removeEventListener('abort',stop);}
}
const encodedBytes = value => {
  const raw=value.slice(9);return Math.max(0,Math.floor(raw.length*3/4)-(raw.match(/=+$/)?.[0].length||0));
};

export async function snapshotRichMessage(message,options={}) {
  const {api,fetcher=globalThis.fetch,signal:parentSignal=new AbortController().signal,parseCQ=text=>[plain(text)],selfId='10000',senderName='消息作者',
    maxFileBytes=20*1024*1024,reserveBytes=()=>true,maxDepth=8,maxNodes=200,maxTextChars=256000,timeoutMs=5000}=options;
  const signal=AbortSignal.any([parentSignal,AbortSignal.timeout(timeoutMs)]);
  const issues=new Set(),forwardCache=new Map();let nodeCount=0,segmentCount=0,textChars=0,mediaBytes=0;
  const fail=(code,text)=>{issues.add(code);return notice(text);};
  const text = value => {
    const raw=String(value??''),room=Math.max(0,maxTextChars-textChars);textChars+=Math.min(raw.length,room);
    return raw.length>room?{type:'text',data:{text:raw.slice(0,room)+'〔转发文本超过缓存边界，后文未保存〕'}}:plain(raw);
  };
  const contentOf = value => Array.isArray(value)?value:typeof value==='string'?parseCQ(value):[];
  const node = (author,name,content,time) => ({type:'node',data:{user_id:qqId(author)||qqId(selfId)||'10000',nickname:String(name||'消息作者').slice(0,120),
    content,...(Number.isFinite(Number(time))&&Number(time)>0?{time:Number(time)}:{})}});
  async function readMedia(segment) {
    const type=segment.type,data=segment.data||{},file=String(data.url||data.file||data.path||''),name=String(data.name||data.file_name||'').slice(0,255);
    const unavailable=(code)=>fail(code,mediaName(type)+(name?' '+name:'')+'未成功缓存，原资源无法保证恢复');
    try {
      let encoded;
      if(file.startsWith('base64://')) {
        if(!/^[A-Za-z0-9+/]*={0,2}$/.test(file.slice(9)))return unavailable('invalid_media');
        const bytes=encodedBytes(file);if(!bytes||bytes>maxFileBytes||!reserveBytes(bytes))return unavailable('media_limit');
        mediaBytes+=bytes;encoded=file;
      } else {
        let url=safeMediaUrl(file);if(!url)return unavailable('media_source_unavailable');
        let response;
        for(let redirects=0;redirects<=3;redirects++) {
          response=await bounded(Promise.resolve(fetcher(url,{signal,redirect:'manual'})).then(r=>{if(signal.aborted){void r.body?.cancel().catch(()=>{});signal.throwIfAborted();}return r;}),signal);
          if(response.status<300||response.status>=400)break;
          void response.body?.cancel().catch(()=>{});
          const location=response.headers.get('location');url=location?safeMediaUrl(new URL(location,url).href):null;
          if(!url||redirects===3)throw new Error('redirect');
        }
        if(!response.ok||!response.body||Number(response.headers.get('content-length'))>maxFileBytes||/text\/html/i.test(response.headers.get('content-type')||'')) {
          void response.body?.cancel().catch(()=>{});return unavailable('media_unavailable');
        }
        const reader=response.body.getReader(),chunks=[];let size=0;
        const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
        try {
          while(true) {
            const {done,value}=await bounded(reader.read(),signal);signal.throwIfAborted();if(done)break;
            size+=value.byteLength;if(size>maxFileBytes)throw new Error('limit');chunks.push(value);
          }
        } finally {signal.removeEventListener('abort',cancel);cancel();try{reader.releaseLock();}catch{}}
        if(!size||!reserveBytes(size))return unavailable('media_limit');mediaBytes+=size;
        encoded='base64://'+Buffer.concat(chunks,size).toString('base64');
      }
      // Do not carry receive-only file IDs, URLs, paths or credentials into a send.
      return {type,data:{file:encoded,...(name?{name}:{}),...(type==='image'&&data.summary?{summary:String(data.summary).slice(0,200)}:{})}};
    } catch {return unavailable(signal.aborted?'snapshot_timeout':'media_unavailable');}
  }
  async function leaf(segment) {
    const type=segment?.type,data=segment?.data||{};
    if(type==='reply')return null;
    if(type==='mface'&&data.url)return readMedia({type:'image',data});
    if(!supported.has(type))return fail('unsupported_'+String(type).slice(0,30),'未支持的消息类型：'+String(type).slice(0,30));
    if(type==='text')return text(data.text);
    if(mediaTypes.has(type))return readMedia(segment);
    if(type==='at')return text(data.qq==='all'?'@全体成员':'@'+(qqId(data.qq)||'成员')); // archived mentions must not ping new recipients
    if(type==='face')return /^\d{1,8}$/.test(String(data.id))?{type,data:{id:String(data.id)}}:fail('invalid_face','表情数据无效');
    if(type==='json'||type==='xml') {
      const value=String(data.data??'');if(!value||value.length>64000)return fail('invalid_card','卡片内容未成功缓存');
      try {if(type==='json')JSON.parse(value);else if(/<!DOCTYPE|<!ENTITY/i.test(value)||!/^\s*</.test(value))throw new Error('xml');}
      catch {return fail('invalid_card','卡片内容无效，未重建');}
      return {type,data:{data:value}};
    }
    return null;
  }
  async function forwardEntries(segment,path) {
    const data=segment.data||{},inline=data.content??data.messages;
    if(Array.isArray(inline))return inline;
    const resource=String(data.id??'');
    if(!resource||resource.length>512)throw new Error('missing');
    if(path.has(resource))throw Object.assign(new Error('cycle'),{cycle:true});
    if(!forwardCache.has(resource))forwardCache.set(resource,bounded(Promise.resolve().then(()=>api.call('get_forward_msg',{id:resource})),signal).then(result=>{
      const entries=result?.messages??result?.data?.messages;if(!Array.isArray(entries)||!entries.length)throw new Error('empty');return entries;
    }));
    return await forwardCache.get(resource);
  }
  async function walk(segments,author,name,depth,path) {
    const output=[];let run=[];
    const flush=()=>{if(run.length){output.push(node(author,name,run));run=[];}};
    for(const segment of contentOf(segments)) {
      if(++segmentCount>2000){run.push(fail('segment_limit','消息片段超过缓存边界，后续未恢复'));break;}
      if(!segment||typeof segment.type!=='string')continue;
      if(signal.aborted){run.push(fail('snapshot_timeout','后续内容缓存超时，未恢复'));break;}
      if(segment.type!=='forward'&&segment.type!=='node') {const s=await leaf(segment);if(s)run.push(s);continue;}
      flush();
      if(depth>=maxDepth||nodeCount>=maxNodes){output.push(node(author,name,[fail('forward_limit','转发层级或节点超过缓存边界，后续未恢复')]));break;}
      if(segment.type==='node') {
        const data=segment.data||{};nodeCount++;
        const raw=data.content??data.message;
        if(raw===undefined){output.push(node(author,name,[fail('node_unavailable','原始节点仅含消息引用，未缓存正文')]));continue;}
        const children=await walk(contentOf(raw),data.user_id??data.uin??author,data.nickname??data.name??name,depth+1,path);
        if(children.length)output.push(...children);else output.push(node(author,name,[fail('empty_node','转发节点为空')]));
      } else {
        const resource=String(segment.data?.id??''),nextPath=new Set(path);if(resource)nextPath.add(resource);
        let entries;
        try {entries=await forwardEntries(segment,path);if(!entries.length)throw new Error('empty');}catch(error){output.push(node(author,name,[fail(error.cycle?'forward_cycle':'forward_unavailable',error.cycle?'嵌套转发存在循环，已停止展开':'转发节点获取失败或已失效，无法还原原记录')]));continue;}
        if(depth>0){issues.add('nested_flattened');output.push(node(author,name,[notice('嵌套转发第'+(depth+1)+'层，已按原顺序展开')]));}
        for(const entry of entries) {
          if(nodeCount>=maxNodes){output.push(node(author,name,[fail('forward_limit','转发节点超过缓存边界，后续未恢复')]));break;}
          nodeCount++;
          const d=entry?.type==='node'?entry.data||{}:entry||{};
          const raw=d.content??d.message;
          if(raw===undefined){output.push(node(author,name,[fail('node_unavailable','转发节点正文不可用')]));continue;}
          const user=d.user_id??d.uin??d.sender?.user_id??author,nick=d.nickname??d.name??d.sender?.card??d.sender?.nickname??name;
          const children=await walk(contentOf(raw),user,nick,depth+1,nextPath);
          for(const child of children)if(d.time)child.data.time=Number(d.time);
          output.push(...(children.length?children:[node(user,nick,[fail('empty_node','转发节点为空')])]));
        }
      }
    }
    flush();return output;
  }
  const hasForward=message.some(s=>s.type==='forward'||s.type==='node');
  let result;
  if(hasForward)result=await walk(message,options.authorId||selfId,senderName,0,new Set());
  else {result=[];for(const segment of message){const s=await leaf(segment);if(s)result.push(s);}}
  if(textChars>=maxTextChars)issues.add('text_limit');
  return {message:result,issues:[...issues],nodes:nodeCount,mediaBytes};
}

export function recallSendPlan(message,{type,peerId,selfId}) {
  const group=type==='group',base={[group?'group_id':'user_id']:Number(peerId)};
  if(!message.some(s=>s.type==='node'))return{action:group?'send_group_msg':'send_private_msg',body:{...base,message}};
  const messages=[];let run=[];
  const flush=()=>{if(run.length){messages.push({type:'node',data:{user_id:qqId(selfId)||'10000',nickname:'撤回重发',content:run}});run=[];}};
  for(const s of message){if(s.type==='node'){flush();messages.push(s);}else run.push(s);}flush();
  return{action:group?'send_group_forward_msg':'send_private_forward_msg',body:{...base,messages}};
}

export function richPreview(segment) {
  if(segment.type==='node') {
    const nodes=segment.data?.content||[];
    return String(segment.data?.nickname||'消息作者')+'：'+nodes.map(s=>s.type==='text'?String(s.data?.text||''):mediaTypes.has(s.type)?'['+mediaName(s.type)+(s.data?.name?' '+s.data.name:'')+(!s.data?.file&&s.data?.summary?'：'+s.data.summary:'')+']':s.type==='json'||s.type==='xml'?'['+s.type+' 卡片]':s.type==='face'?'[表情]':'['+s.type+']').join('').slice(0,4000);
  }
  if(mediaTypes.has(segment.type))return '['+mediaName(segment.type)+(segment.data?.name?' '+segment.data.name:'')+']';
  if(['json','xml'].includes(segment.type))return '['+segment.type+' 卡片，已缓存]';
  return String(segment.data?.summary||'['+segment.type+' 消息]');
}

export function dropPreviewMedia(message) {
  return message.map(segment=>{
    if(segment.type==='node')return {...segment,data:{...segment.data,content:dropPreviewMedia(segment.data?.content||[])}};
    if(segment.type==='image')return {type:'image',data:{summary:'图片超过展示缓存上限，已跳过预览'}};
    if(mediaTypes.has(segment.type))return notice(mediaName(segment.type)+'超过展示缓存上限，已跳过预览');
    return segment;
  });
}
