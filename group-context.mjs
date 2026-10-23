import {extractInputMentions,buildInputMentions,mentionScope} from './input-mentions.mjs';
import {eventDisplayName,displayFor} from './chat-display.mjs';
import { privateTextDecision } from './private-privacy.mjs';
import {id,parseCQ} from './engine.mjs';
import {randomBytes,createHmac} from 'node:crypto';
import {usefulText,dominantTopic} from './group-topics.mjs';

// Separate, bounded, RAM-only cache. Never loads recall caches or old QQ history.
export class LocalGroupContext {
  constructor(now = Date.now) { this.now = now; this.groups = new Map();this.sequence=0;this.speakerSalt=randomBytes(32); }
  clear() { this.groups.clear();this.sequence=0;this.speakerSalt=randomBytes(32); }
  scope(e){return e.self_id+':group:'+e.peer_id;}
  speaker(e,sender){return '成员_'+createHmac('sha256',this.speakerSalt).update(this.scope(e)+':'+sender).digest('hex').slice(0,12);}
  displayName(e,sender,config,throughSequence=Infinity){const values=this.groups.get(this.scope(e))||[];return displayFor(config,e,sender,values.findLast(v=>v.sender===sender&&v.sequence<=throughSequence)?.displayName||'');}
  label(item){return '消息'+item.sequence;}
  available(e,config,throughSequence=Infinity){this.prune(config);if(e.conversation_type!=='group'||!config.groups.includes(e.peer_id))return[];return(this.groups.get(this.scope(e))||[]).filter(v=>v.sequence<=throughSequence&&v.id!==e.message_id&&!config.group_blacklist.includes(v.sender)&&(v.sender!==e.self_id||config.allow_self));}
  chain(e,messageId,config,throughSequence=Infinity,maxHops=config.context_reference_hops??4){
    const messages=[],seen=new Set(),reasons={};let next=messageId;
    for(let n=0;next&&n<maxHops;n++){
      if(seen.has(next)){reasons.cycle=1;break;}seen.add(next);
      const item=this.available({...e,message_id:''},config,throughSequence).find(v=>v.id===next);
      if(!item){reasons.missing_reference=1;break;}
      messages.unshift(item);next=item.replyTo;
      if(next&&n===maxHops-1)reasons.hop_limit=1;
    }
    return{messages,reasons};
  }
  prune(config) {
    const cutoff = config.group_cache_ttl_minutes===0 ? -Infinity : this.now() - config.group_cache_ttl_minutes * 60000;
    for (const [key, values] of this.groups) {
      const kept = values.filter(v => v.at > cutoff).slice(-config.group_cache_limit);
      if (kept.length) this.groups.set(key, kept); else this.groups.delete(key);
    }
    let entries = [...this.groups.values()].flat().sort((a,b) => a.at - b.at);
    let bytes = entries.reduce((n,v) => n + Buffer.byteLength(v.text+(v.displayName||'')+JSON.stringify(v.mentions||[]), 'utf8'), 0);
    while (entries.length > (config.group_cache_total_messages??500) || bytes > (config.group_cache_total_bytes??1048576)) {
      const drop = entries.shift(); bytes -= Buffer.byteLength(drop.text+(drop.displayName||'')+JSON.stringify(drop.mentions||[]), 'utf8');
      const values = this.groups.get(drop.scope).filter(v => v !== drop);
      if (values.length) this.groups.set(drop.scope, values); else this.groups.delete(drop.scope);
    }
  }
  put(e, event, config) {
    this.prune(config);
    if (!config.enabled || config.backend !== 'api' || !config.groups.includes(e.peer_id) || e.conversation_type !== 'group' ||
        event.from_history === true || event.message_source === 'history' || event.anonymous) return;
    if(event.user_id!==undefined&&event.sender?.user_id!==undefined&&id(event.user_id,true)!==id(event.sender.user_id,true))return;
    const segments=typeof event.message==='string'?parseCQ(event.message):event.message;
    if(!Array.isArray(segments)||segments.some(s=>!s||!['text','at','reply','image','mface','face'].includes(s.type)||(s.type==='text'&&typeof s.data?.text!=='string')))return;
    if(segments.some(s=>s.type==='at'&&s.data?.qq!=='all'&&id(s.data?.qq,true)===null))return;
    const mentions=extractInputMentions(segments).mentions;
    const replies = segments.filter(s => s.type === 'reply');
    if (replies.length > 1 || replies.some(s=>id(s.data?.id)===null)) return;
    if (Number.isSafeInteger(event.time) && (event.time * 1000 < this.now() - 10000 || event.time * 1000 > this.now() + 5000)) return;
    const text = segments.filter(s => s.type === 'text').map(s => String(s.data?.text || '')).join('').trim(),imageCount=segments.filter(s=>['image','mface'].includes(s.type)).length;
    if ((!text&&!imageCount&&!mentions.some(v=>v.qq!==e.self_id)) || text.length > (config.group_cache_message_chars??8000)) return;
    const scope = e.self_id + ':group:' + e.peer_id, values = this.groups.get(scope) || [];
    if (values.some(v => v.id === e.message_id)) return;
    const record={scope,id:e.message_id,sender:e.user_id,displayName:eventDisplayName(config,event,e.self_id),text,mentions,at:this.now(),sequence:++this.sequence,replyTo:replies.length?id(replies[0].data.id):null,imageCount,addressedToBot:segments.some(s=>s.type==='at'&&String(s.data?.qq)===e.self_id),bot:e.user_id===e.self_id||event.is_bot===true||event.sender?.is_bot===true||event.sender?.bot===true||event.sender?.role==='bot'};
    values.push(record);this.groups.set(scope,values);this.prune(config);return record;
  }
  recall(e) {
    const scope = e.self_id + ':group:' + e.peer_id, values = this.groups.get(scope);
    if (values) this.groups.set(scope, values.filter(v => v.id !== e.message_id));
  }
  hasReference(e, messageId, config) {
    this.prune(config);
    if (e.conversation_type !== 'group' || !config.groups.includes(e.peer_id)) return false;
    return (this.groups.get(e.self_id + ':group:' + e.peer_id) || []).some(v => v.id === messageId && !v.imageCount && (v.text||v.mentions?.some(m=>m.qq!==e.self_id)) &&
      !config.group_blacklist.includes(v.sender) && (v.sender !== e.self_id || config.allow_self));
  }
  referenceChars(e,messageId,config) {
    if(!this.hasReference(e,messageId,config))return null;
    return (this.groups.get(e.self_id+':group:'+e.peer_id)||[]).find(v=>v.id===messageId)?.text.length??null;
  }
  referenceText(e, messageId, config) {
    if (!this.hasReference(e, messageId, config)) return null;
    return (this.groups.get(e.self_id + ':group:' + e.peer_id) || []).find(v => v.id === messageId) || null;
  }
  forEmptyMention(e, config, throughSequence = Infinity) {
    this.prune(config);
    if (!config.group_context_export || config.group_context_target !== config.api_base_url || config.backend !== 'api' || !config.groups.includes(e.peer_id)) return null;
    const values = this.available(e,config,throughSequence).filter(v=>!v.bot&&usefulText(v.text)&&privateTextDecision(v.text,Math.max(config.group_cache_message_chars??8000,config.context_chars),{identityFilter:config.local_identity_filter===true}).allowed);
    const own = values.filter(v => v.sender === e.user_id).at(-1);
    if (own) return { ...own, own: true };
    // A single substantive nearby topic is reasonable evidence; multiple
    // unrelated authors/topics require clarification rather than guessing.
    const recent=values.filter(v=>v.at>=this.now()-(config.context_empty_window_seconds??120)*1000).slice(-(config.context_empty_lookback??12)),topic=dominantTopic(recent);
    const unique = [...new Map(values.map(v => [v.text, v])).values()];
    return topic?{...topic.seed,own:false}:unique.length===1?{...unique[0],own:false}:null;
  }
  select(e, config,throughSequence=Infinity) {
    this.prune(config);
    if (!config.group_context_export || config.group_context_target!==config.api_base_url || config.backend !== 'api' || !config.groups.includes(e.peer_id)) return { messages: [], omitted: 0 };
    const blocked = new Set(config.group_blacklist);
    const values = this.groups.get(e.self_id + ':group:' + e.peer_id) || [], messages = []; let chars = 0, omitted = 0;
    for (const item of values.filter(v => v.id !== e.message_id&&v.sequence<=throughSequence).slice().reverse()) {
      if (blocked.has(item.sender) || (item.sender === e.self_id && !config.allow_self)) { omitted++; continue; }
      // Apply the same recognized-sensitive-content checks to the authorized
      // nearby text. These checks do not guarantee detection of every secret.
      const check = privateTextDecision(item.text,Math.max(config.group_cache_message_chars??8000,config.context_chars,config.output_chars),{identityFilter:config.local_identity_filter===true});
      if (!check.allowed || chars + check.text.length > config.group_context_chars) { omitted++; continue; }
      const mentions=buildInputMentions(e,item,config,this,throughSequence).context;messages.unshift({ speaker: this.speaker(e,item.sender), text: check.text,...(mentions?{input_mentions:mentions}:{}) }); chars += check.text.length;
    }
    return { messages, omitted };
  }
  state(config) { this.prune(config); return { groups: this.groups.size, messages: [...this.groups.values()].reduce((n,v) => n + v.length, 0), exportEnabled: config.group_context_export, limitPerGroup: config.group_cache_limit, ttlMinutes: config.group_cache_ttl_minutes }; }
}
