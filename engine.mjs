import {packetErrorDetails} from './packet-diagnostic-error.mjs';
import { randomUUID } from 'node:crypto';
import {needsRichSnapshot,pendingRichMessage,snapshotRichMessage,recallSendPlan} from './recall-rich-message.mjs';
import { ResendQueue, messageMediaBytes, messageMediaStats } from './send-queue.mjs';

export const DEFAULTS = {
  ws_url: 'ws://127.0.0.1:3001/',
  access_token: '',
  friend_ids: [],
  group_ids: [],
  auto_resend: false,
  resend_exempt_qq_ids: [],
  send_interval_ms: 3000,
  ignore_self_messages: true,
  message_prefix: '',
  recent_messages_per_chat: 200,
  message_cache_ttl_ms: 1800000,
  recall_match_wait_ms: 3000,
  media_file_limit_mb: 20,
  media_cache_limit_mb: 64,
  media_timeout_ms: 5000,
  api_timeout_ms: 7000,
  expected_self_id: '',
  dry_run: false,
};
async function abortable(promise, signal) {
  signal.throwIfAborted();let cancel;
  const interrupted=new Promise((_,reject)=>{cancel=()=>reject(signal.reason);signal.addEventListener('abort',cancel,{once:true});});
  try{return await Promise.race([promise,interrupted]);}finally{signal.removeEventListener('abort',cancel);}
}

export function id(value, positive = false) {
  if (!['string', 'number'].includes(typeof value)) return null;
  if (!/^-?\d+$/.test(String(value))) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (positive && number <= 0)) return null;
  return String(number);
}

export function validateResendExemptions(input) {
  let entries;
  if (typeof input === 'string') {
    if (input.length > 3000) throw new Error('豁免白名单文字不能超过 3000 个字符。');
    entries = input.trim() ? input.trim().split(/[\s,，;；]+/u) : [];
  } else if (Array.isArray(input)) entries = input;
  else throw new Error('豁免白名单需为 QQ 号列表或分隔的 QQ 号文字。');
  if (entries.length > 500) throw new Error('豁免白名单最多 100 个不同 QQ 号。');
  const result = new Set();
  for (const entry of entries) {
    if (!['string', 'number'].includes(typeof entry)) throw new Error('白名单只能填写 QQ 号。');
    const value = String(entry).trim();
    if (!/^[1-9]\d{4,11}$/.test(value)) throw new Error('请填写 5～12 位正整数 QQ 号，不填写昵称、群号或备注。');
    result.add(value);
    if (result.size > 100) throw new Error('豁免白名单最多 100 个不同 QQ 号。');
  }
  return [...result];
}

export function validateCacheSettings(limit, minutes) {
  if (!Number.isSafeInteger(limit) || limit < 10 || limit > 1000 ||
      !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) {
    throw new Error('缓存容量需为 10～1000 条整数，保留时间需为 1～120 分钟整数。');
  }
  return { cache_messages_per_chat: limit, cache_ttl_minutes: minutes };
}

export function validateConfig(input, allowEmptyFriends = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('配置必须是 JSON 对象。');
  }
  const config = { ...DEFAULTS, ...input };
  config.resend_exempt_qq_ids = validateResendExemptions(config.resend_exempt_qq_ids);
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULTS)) throw new Error('未知配置项：' + key);
  }
  let url;
  try { url = new URL(config.ws_url); }
  catch { throw new Error('ws_url 不是有效的 WebSocket 地址。'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('ws_url 应为 ws:// 或 wss:// 地址。Token 请填写到 access_token。');
  }
  if (/(?:^|\/)(api|event)\/?$/.test(url.pathname)) {
    throw new Error('请连接同时提供事件和 API 的根路径，通常是 ws://127.0.0.1:3001/。');
  }
  for (const key of ['friend_ids', 'group_ids']) {
    if (!Array.isArray(config[key])) throw new Error(key + ' 必须是 QQ 号或群号数组。');
    config[key] = [...new Set(config[key].map((value) => {
      const normalized = id(value, true);
      if (!normalized) throw new Error('QQ 号或群号必须是正整数，请检查 ' + key + '。');
      return normalized;
    }))];
  }
  const targetCount = config.friend_ids.length + config.group_ids.length;
  if (!allowEmptyFriends && targetCount === 0) throw new Error('请先在页面中选择一个群聊或一位好友。');
  if (targetCount > 1) throw new Error('每次只监听一个群聊或一位好友，请在页面中切换。');
  for (const key of ['ignore_self_messages', 'dry_run', 'auto_resend']) {
    if (typeof config[key] !== 'boolean') throw new Error(key + ' 必须为 true 或 false。');
  }
  for (const key of ['access_token', 'message_prefix', 'expected_self_id']) {
    if (typeof config[key] !== 'string') throw new Error(key + ' 必须为字符串。');
  }
  if (config.expected_self_id && !id(config.expected_self_id, true)) {
    throw new Error('expected_self_id 必须是 QQ 号，或者留空。');
  }
  if (!Number.isSafeInteger(config.send_interval_ms) || config.send_interval_ms < 0 || config.send_interval_ms > 60000) {
    throw new Error('重发基准间隔必须为 0～60000 毫秒。');
  }
  for (const key of ['recent_messages_per_chat', 'media_file_limit_mb',
    'media_cache_limit_mb', 'media_timeout_ms', 'api_timeout_ms']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) {
      throw new Error(key + ' 必须为正整数。');
    }
  }
  validateCacheSettings(config.recent_messages_per_chat, config.message_cache_ttl_ms / 60000);
  if (!Number.isSafeInteger(config.recall_match_wait_ms) || config.recall_match_wait_ms < 10 || config.recall_match_wait_ms > 30000) {
    throw new Error('撤回等待匹配必须为 10～30000 毫秒。');
  }
  if (config.media_file_limit_mb > 100 ||
      config.media_cache_limit_mb > 512 || config.media_timeout_ms > 30000 ||
      config.api_timeout_ms < 100 || config.api_timeout_ms > 60000) {
    throw new Error('单个图片最多 100MB，总资源最多 512MB；请检查超时设置。');
  }
  return config;
}

export class TTLCache {
  constructor(ttlMs, limit, now = Date.now) {
    this.ttlMs = ttlMs;
    this.limit = limit;
    this.now = now;
    this.items = new Map();
  }
  prune() {
    const now = this.now();
    for (const [key, entry] of this.items) {
      if (entry.expires > now) break;
      this.items.delete(key);
    }
  }
  put(key, value) {
    this.prune();
    this.items.delete(key);
    this.items.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value);
  }
  get(key) {
    const entry = this.items.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) { this.items.delete(key); return undefined; }
    return entry.value;
  }
}

// 每条聊天消息占一个位置，混合消息内的多个消息段不会重复占位。
export class ConversationWindow {
  constructor(limit, dispose = () => {}, ttlMs = 1800000, now = Date.now, timers = { setTimeout, clearTimeout }) {
    this.limit = limit;
    this.ttlMs = ttlMs;
    this.now = now;
    this.timers = timers;
    this.timer = null;
    this.entries = new Map();
    this.stats = { capacity_evictions: 0, expired: 0 };
    this.dispose = dispose;
    this.peers = new Map();
    this.items = new Map();
  }
  put(event, value) {
    this.prune();
    const key = messageKey(event);
    if (this.items.has(key)) return false;
    const groupId = event.conversation_type + ':' + id(event.peer_id, true);
    let group = this.peers.get(groupId);
    if (!group) { group = new Map(); this.peers.set(groupId, group); }
    group.set(key, value);
    this.items.set(key, value);
    this.entries.set(key, { groupId, created: this.now(), expires: this.now() + this.ttlMs });
    while (group.size > this.limit) {
      const oldest = group.keys().next().value;
      this.remove(oldest, 'capacity_evictions');
    }
    this.schedule();
    return true;
  }
  remove(key, reason) {
    const entry = this.entries.get(key);
    if (!entry) return;
    const value = this.items.get(key);
    const group = this.peers.get(entry.groupId);
    group?.delete(key);
    if (!group?.size) this.peers.delete(entry.groupId);
    this.items.delete(key); this.entries.delete(key);
    if (reason) this.stats[reason]++;
    this.dispose(value);
  }
  schedule() {
    this.timers.clearTimeout(this.timer); this.timer = null;
    let expires = Infinity;
    for (const entry of this.entries.values()) expires = Math.min(expires, entry.expires);
    if (expires !== Infinity) {
      this.timer = this.timers.setTimeout(() => { this.timer = null; this.prune(); }, Math.max(1, expires - this.now()));
      this.timer?.unref?.();
    }
  }
  prune() {
    for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.remove(key, 'expired');
    this.schedule();
  }
  configure(limit, ttlMs) {
    this.prune(); this.limit = limit; this.ttlMs = ttlMs;
    for (const entry of this.entries.values()) entry.expires = entry.created + ttlMs;
    this.prune();
    for (const group of [...this.peers.values()]) {
      while (group.size > limit) this.remove(group.keys().next().value, 'capacity_evictions');
    }
    this.schedule();
  }
  get(key) { this.prune(); return this.items.get(key); }
  clear() {
    this.timers.clearTimeout(this.timer); this.timer = null;
    for (const item of this.items.values()) this.dispose(item);
    this.items.clear();
    this.peers.clear();
    this.entries.clear();
  }
}

function decodeCQ(text, parameter = false) {
  let value = text.replace(/&#91;/g, '[').replace(/&#93;/g, ']');
  if (parameter) value = value.replace(/&#44;/g, ',');
  return value.replace(/&amp;/g, '&');
}

export function parseCQ(message) {
  const parts = [];
  const regex = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g;
  let offset = 0;
  for (const match of message.matchAll(regex)) {
    if (match.index > offset) {
      parts.push({ type: 'text', data: { text: decodeCQ(message.slice(offset, match.index)) } });
    }
    const data = {};
    for (const field of match[2].split(',').slice(1)) {
      const separator = field.indexOf('=');
      if (separator > 0) {
        data[field.slice(0, separator)] = decodeCQ(field.slice(separator + 1), true);
      }
    }
    parts.push({ type: match[1], data });
    offset = match.index + match[0].length;
  }
  if (offset < message.length) {
    parts.push({ type: 'text', data: { text: decodeCQ(message.slice(offset)) } });
  }
  return parts;
}

export function prepareMessage(message) {
  const input = typeof message === 'string' ? parseCQ(message) : message;
  if (!Array.isArray(input)) return [];
  const output = [];
  for (const segment of input) {
    if (!segment || typeof segment.type !== 'string' ||
        !segment.data || typeof segment.data !== 'object' || Array.isArray(segment.data)) continue;
    // 重发内容，不引用可能已经消失的旧消息。
    if (segment.type === 'reply') continue;
    const copy = structuredClone(segment);
    if (copy.type === 'mface' && copy.data.url) {
      copy.type = 'image';
      copy.data.file = copy.data.url;
    }
    if (['image', 'record', 'video', 'file'].includes(copy.type) && copy.data.url) {
      copy.data.file = copy.data.url;
      delete copy.data.url;
    }
    output.push(copy);
  }
  return output;
}

export function normalizePrivateEvent(event) {
  if (!event || typeof event !== 'object' || (event.group_id !== undefined && event.group_id !== null && id(event.group_id) !== '0')) return null;
  const self = id(event.self_id, true);
  if (!self || id(event.message_id) === null) return null;
  if (event.post_type === 'notice' && event.notice_type === 'friend_recall') {
    const sender = id(event.user_id, true);
    const peer = sender === self ? id(event.target_id, true) : sender;
    if (!peer || peer === self) return null;
    return { ...event, conversation_type: 'private', peer_id: peer, user_id: sender };
  }
  if (!['message', 'message_sent'].includes(event.post_type) ||
      event.message_type !== 'private' ||
      (event.sub_type && event.sub_type !== 'friend')) return null;
  const sender = id(event.sender?.user_id, true) || id(event.user_id, true);
  const peer = sender === self || event.post_type === 'message_sent'
    ? id(event.target_id, true) || (id(event.user_id, true) !== self ? id(event.user_id, true) : null)
    : id(event.user_id, true);
  if (!peer || peer === self || !sender) return null;
  return { ...event, conversation_type: 'private', peer_id: peer, user_id: sender };
}

export function normalizeGroupEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const self = id(event.self_id, true);
  const group = id(event.group_id, true);
  if (!self || !group || id(event.message_id) === null) return null;
  const message = ['message', 'message_sent'].includes(event.post_type) && event.message_type === 'group';
  const notice = event.post_type === 'notice' && event.notice_type === 'group_recall';
  if (!message && !notice) return null;
  const sender = id(message ? event.sender?.user_id : event.user_id, true) || id(event.user_id, true);
  if (!sender) return null;
  return { ...event, conversation_type: 'group', peer_id: group, user_id: sender };
}

export function normalizeEvent(event) {
  if(event?.message_type==='private'||(event?.post_type==='notice'&&event.notice_type==='friend_recall'))return normalizePrivateEvent(event);
  return event?.group_id !== undefined ? normalizeGroupEvent(event) : normalizePrivateEvent(event);
}

function messageKey(event) {
  const self = id(event.self_id, true);
  const group = id(event.peer_id, true);
  const message = id(event.message_id);
  return self && group && message !== null
    ? self + ':' + event.conversation_type + ':' + group + ':' + message : null;
}

function identityName(name, qqId) {
  const clean = String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100);
  return clean || qqId || '未知操作者';
}

export class RecallReposter {
  constructor(config, log = () => {}, now = Date.now, fetcher = globalThis.fetch, sendQueue = null,
      timers = { setTimeout, clearTimeout }) {
    this.config = validateConfig(config);
    this.peers = new Set(this.config.friend_ids);
    this.groupPeers = new Set(this.config.group_ids);
    this.log = log;
    this.fetcher = fetcher;
    this.now = now; this.timers = timers;
    this.pendingRecalls = new Map();
    this.activeRecalls = new Set();
    this.sendGeneration = 0; this.selfGeneration = 0; this.cacheGeneration = 0;
    this.windowStartedAt = now();
    this.cacheStats = { matched_early: 0, wait_timeouts: 0, wait_queue_full: 0, media_wait_timeouts: 0, resource_rejections: 0 };
    this.recallMisses = new TTLCache(86400000, 5000, now);
    this.onRecall = () => {};
    this.resolveRecallName = (_group, _qq, fallback) => fallback;
    this.onSendState = () => {};
    this.sendQueue = sendQueue || new ResendQueue({ intervalMs: this.config.send_interval_ms });
    this.mediaBytes = 0;
    this.messages = new ConversationWindow(this.config.recent_messages_per_chat, (original) => {
      original.evicted = true;
      original.controller.abort();
      this.mediaBytes -= original.mediaBytes;
      original.mediaBytes = 0;
      original.message = [];
    }, this.config.message_cache_ttl_ms, now, timers);
    this.sent = new TTLCache(86400000, 1000, now);
    this.seenMessages = new TTLCache(86400000, 5000, now);
    this.downloadActive = 0;
    this.downloadWaiters = [];
  }
  acquireDownload(original) {
    if (original.evicted) return Promise.resolve(false);
    if (this.downloadActive < 2) { this.downloadActive++; return Promise.resolve(true); }
    return new Promise((accept) => {
      const waiter = { original, accept };
      waiter.cancel = () => {
        const index = this.downloadWaiters.indexOf(waiter);
        if (index >= 0) this.downloadWaiters.splice(index, 1);
        accept(false);
      };
      original.controller.signal.addEventListener('abort', waiter.cancel, { once: true });
      this.downloadWaiters.push(waiter);
    });
  }
  releaseDownload() {
    this.downloadActive--;
    while (this.downloadActive < 2 && this.downloadWaiters.length) {
      const waiter = this.downloadWaiters.shift();
      waiter.original.controller.signal.removeEventListener('abort', waiter.cancel);
      if (waiter.original.evicted) { waiter.accept(false); continue; }
      this.downloadActive++;
      waiter.accept(true);
    }
  }
  async cacheRich(original, message, event, api) {
    if(!await this.acquireDownload(original))return;
    let credit=original.mediaBytes;
    try {
      const result=await snapshotRichMessage(message,{api,fetcher:this.fetcher,signal:original.controller.signal,parseCQ,
        selfId:event.self_id,authorId:event.user_id,senderName:original.sender_name,
        timeoutMs:this.config.media_timeout_ms,maxFileBytes:this.config.media_file_limit_mb*1024*1024,
        reserveBytes:size=>{
          if(original.evicted||original.controller.signal.aborted)return false;
          const reused=Math.min(credit,size),extra=size-reused;
          if(this.mediaBytes+extra>this.config.media_cache_limit_mb*1024*1024)return false;
          credit-=reused;this.mediaBytes+=extra;original.mediaBytes+=extra;return true;
        }});
      if(!original.evicted&&!original.controller.signal.aborted){
        const actual=messageMediaBytes(result.message);this.mediaBytes+=actual-original.mediaBytes;original.mediaBytes=actual;
        original.message=result.message;original.recovery={issues:result.issues,nodes:result.nodes};
      }
    } catch {if(!original.evicted)original.recovery={issues:['snapshot_failed'],nodes:0};}
    finally {
      if(!original.evicted){
        const actual=messageMediaBytes(original.message);this.mediaBytes+=actual-original.mediaBytes;original.mediaBytes=actual;
        if(original.controller.signal.aborted)original.recovery={issues:['snapshot_timeout'],nodes:0};
      }
      this.releaseDownload();
    }
  }
  async cacheImages(original, key) {
    if (!await this.acquireDownload(original)) return;
    try {
      if (!original.evicted) await this.downloadImages(original, key);
    } finally { this.releaseDownload(); }
  }
  async downloadImages(original, key) {
    for (const segment of original.message) {
      if (original.evicted) break;
      if (segment.type !== 'image' || !/^https?:\/\//i.test(segment.data.file ?? '')) continue;
      try {
        const signal = AbortSignal.any([
          original.controller.signal,
          AbortSignal.timeout(this.config.media_timeout_ms),
        ]);
        const response = await abortable(Promise.resolve(this.fetcher(segment.data.file, { signal })).then(value=>{
          if(signal.aborted){void value.body?.cancel().catch(()=>{});signal.throwIfAborted();}return value;
        }),signal);
        if (!response.ok || !response.body) {
          void response.body?.cancel().catch(()=>{});
          throw new Error('资源不可用');
        }
        const limit = this.config.media_file_limit_mb * 1024 * 1024;
        if (Number(response.headers.get('content-length')) > limit ||
            /text\/html/i.test(response.headers.get('content-type') ?? '')) {
          void response.body.cancel().catch(()=>{});
          throw new Error('资源过大或不是图片');
        }
        const reader = response.body.getReader();
        const cancel=()=>{void reader.cancel().catch(()=>{});};
        signal.addEventListener('abort',cancel,{once:true});
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await abortable(reader.read(),signal);
            signal.throwIfAborted();
            if (done) break;
            size += value.byteLength;
            if (size > limit) {
              cancel();
              throw new Error('资源过大');
            }
            chunks.push(value);
          }
        } finally {signal.removeEventListener('abort',cancel);cancel();try{reader.releaseLock();}catch{}}
        if (!size || original.evicted) continue;
        if (this.mediaBytes + size > this.config.media_cache_limit_mb * 1024 * 1024) {
          throw new Error('预缓存资源达到总量上限');
        }
        // 保留原始图片字节，GIF 不转成静态图片；base64 是 OneBot 的文件输入格式。
        segment.data.file = 'base64://' + Buffer.concat(chunks, size).toString('base64');
        this.mediaBytes += size;
        original.mediaBytes += size;
      } catch {
        if (!original.evicted) {
          this.log('图片/表情包预缓存未完成（消息 ' + key.split(':').at(-1) +
            '），撤回时将尝试原资源链接。');
        }
      }
    }
  }
  clear() {
    this.cacheGeneration++;
    this.windowStartedAt = this.now();
    this.cancelPendingSends();
    for (const pending of [...this.pendingRecalls.values()]) pending.finish({ state: 'cancelled' });
    this.messages.clear();
  }
  cancelPendingSends() { this.sendGeneration++; this.sendQueue.cancel(job => (job.priority || 0) >= 0); }
  setCacheSettings(limit, minutes) {
    validateCacheSettings(limit, minutes);
    this.config.recent_messages_per_chat = limit;
    this.config.message_cache_ttl_ms = minutes * 60000;
    this.messages.configure(limit, minutes * 60000);
  }
  cacheSnapshot() {
    this.messages.prune();
    return { limit: this.config.recent_messages_per_chat, ttl_minutes: this.config.message_cache_ttl_ms / 60000,
      cached: this.messages.items.size, pending_matches: this.pendingRecalls.size,
      match_wait_ms: this.config.recall_match_wait_ms, match_queue_limit: 50,
      ...this.messages.stats, ...this.cacheStats };
  }
  waitForOriginal(event, key) {
    const pendingKey = key + ':author:' + event.user_id;
    if (this.pendingRecalls.has(pendingKey) || this.recallMisses.get(pendingKey)) return Promise.resolve({ state: 'duplicate' });
    if (this.pendingRecalls.size >= 50) {
      this.cacheStats.wait_queue_full++; this.recallMisses.put(pendingKey, true);
      return Promise.resolve({ state: 'missing' });
    }
    return new Promise(resolve => {
      const pending = { key, authorId: id(event.user_id, true), private: event.conversation_type === 'private',
        selfId: id(event.self_id, true), deadline: this.now() + this.config.recall_match_wait_ms };
      pending.finish = result => {
        if (this.pendingRecalls.get(pendingKey) !== pending) return;
        this.pendingRecalls.delete(pendingKey); this.timers.clearTimeout(pending.timer);
        if (result.state === 'missing') {
          if (!result.reason) this.cacheStats.wait_timeouts++;
          this.recallMisses.put(pendingKey, true);
        }
        resolve(result);
      };
      this.pendingRecalls.set(pendingKey, pending);
      pending.timer = this.timers.setTimeout(() => pending.finish({ state: 'missing' }), this.config.recall_match_wait_ms);
    });
  }
  matchWaiting(key, original) {
    for (const pending of [...this.pendingRecalls.values()]) {
      if (pending.key !== key) continue;
      if (pending.deadline <= this.now()) { pending.finish({ state: 'missing' }); continue; }
      const authorId = id(original.user_id, true);
      if (authorId !== pending.authorId && !(pending.private && authorId === pending.selfId)) continue;
      this.cacheStats.matched_early++;
      pending.finish({ state: 'matched', original });
    }
  }
  async waitForMedia(original) {
    if (!original.ready) return;
    let timer;
    const deadline = new Promise(resolve => {
      timer = this.timers.setTimeout(() => {
        this.cacheStats.media_wait_timeouts++; original.controller.abort(); resolve();
      }, this.config.media_timeout_ms);
    });
    try { await Promise.race([original.ready, deadline]); }
    finally { this.timers.clearTimeout(timer); }
  }
  setResendExemptions(values) {
    const list = validateResendExemptions(values);
    this.config.resend_exempt_qq_ids = list;
    for (const policy of this.activeRecalls) for (const author of list) policy.exemptIds.add(author);
    this.sendQueue.cancel(job => (job.priority || 0) >= 0 && list.includes(job.authorId), 'exempt');
  }
  isExemptAuthor(authorId) { return this.config.resend_exempt_qq_ids.includes(authorId); }
  cachedGroupName(event, qqId) {
    if (!qqId) return '';
    const prefix = id(event.self_id, true) + ':group:' + id(event.peer_id, true) + ':';
    let name = '';
    // 只使用当前会话最新十条缓存中的身份，不读取其他群或猜测操作者姓名。
    for (const [key, original] of this.messages.items) {
      if (key.startsWith(prefix) && id(original.user_id, true) === qqId) name = original.sender_name;
    }
    return name;
  }
  setSelfRecall(enabled) {
    this.config.ignore_self_messages = !enabled;
    if (!enabled) { this.selfGeneration++; this.sendQueue.cancel(job => (job.priority || 0) >= 0 && job.isSelf); return; }
    for (const [key, original] of this.messages.items) {
      if (id(original.user_id, true) === key.split(':')[0] && !original.handled &&
          !original.ready && original.message.some(part => part.type === 'image')) {
        original.ready = this.cacheImages(original, key);
      }
    }
  }
  async handle(event, api) {
    // NapCat 的本人私聊撤回可能只有本人 QQ 和消息 ID。必须有当前会话的
    // 原消息到达前只在所选好友范围暂存通知；必须取得同会话本人原文证据后才能发送。
    if (event?.post_type === 'notice' && event.notice_type === 'friend_recall' &&
        id(event.user_id, true) === id(event.self_id, true) && !id(event.target_id, true)) {
      const peer = [...this.peers][0];
      const key = messageKey({ ...event, conversation_type: 'private', peer_id: peer });
      const original = key && this.messages.get(key);
      if (!key || (original && id(original.user_id, true) !== id(event.self_id, true) && !this.sent.get(key))) return 'ignored';
      event = { ...event, target_id: peer };
    }
    event = normalizeEvent(event);
    if (!event) return 'ignored';
    const targets = event.conversation_type === 'group' ? this.groupPeers : this.peers;
    if (!targets.has(id(event.peer_id, true))) return 'ignored';
    if (this.config.expected_self_id &&
        id(event.self_id, true) !== id(this.config.expected_self_id, true)) return 'ignored';
    const key = messageKey(event);
    if (!key) return 'ignored';
    const timestamp = Number(event.time);
    // OneBot 时间以秒计；允许秒级取整误差，不回放本轮监听开始前的历史事件。
    if (Number.isFinite(timestamp) && timestamp > 0 && timestamp * 1000 < this.windowStartedAt - 2000) return 'ignored';
    this.messages.prune();
    const own = id(event.user_id, true) === id(event.self_id, true);
    if (['message', 'message_sent'].includes(event.post_type)) {
      if (this.seenMessages.get(key)) return 'duplicate-message';
      this.seenMessages.put(key, true);
      const message = prepareMessage(event.message);
      const inlineBytes = messageMediaBytes(message);
      if (this.mediaBytes + inlineBytes > this.config.media_cache_limit_mb * 1024 * 1024 ||
          messageMediaStats(message).largest > this.config.media_file_limit_mb * 1024 * 1024) {
        this.cacheStats.resource_rejections++;
        for (const pending of [...this.pendingRecalls.values()]) if (pending.key === key) pending.finish({ state: 'missing', reason: 'resource-limit' });
        this.log('消息内嵌媒体超过内存资源上限，未缓存；不保存正文到磁盘。');
        return 'cache-limit';
      }
      const original = {
        message, user_id: event.user_id, handled: false, evicted: false,
        sender_name: String(event.sender?.card || event.sender?.nickname || event.user_id),
        controller: new AbortController(), mediaBytes: inlineBytes, ready: null,
      };
      if (!this.messages.put(event, original)) return 'duplicate-message';
      this.mediaBytes += inlineBytes;
      if(needsRichSnapshot(message)&&!(own&&this.config.ignore_self_messages)) {
        original.message=pendingRichMessage(message);original.recovery={issues:['snapshot_pending'],nodes:0};
        original.ready=this.cacheRich(original,message,event,api);
      } else if (message.some((segment) => segment.type === 'image') &&
          !(own && this.config.ignore_self_messages)) {
        original.ready = this.cacheImages(original, key);
      }
      this.matchWaiting(key, original);
      return 'cached';
    }
    const recallType = event.conversation_type === 'group' ? 'group_recall' : 'friend_recall';
    if (event.post_type !== 'notice' || event.notice_type !== recallType) return 'ignored';
    if (own && this.config.ignore_self_messages) return 'ignored';
    // A confirmed output may itself be explicitly recalled. Its new message ID
    // is distinct from its source; message echoes only cache and never resend.
    if (this.recallMisses.get(key + ':author:' + event.user_id)) return 'duplicate';
    const policy = { allowed: this.config.auto_resend, sendGeneration: this.sendGeneration,
      selfAllowed: !this.config.ignore_self_messages, selfGeneration: this.selfGeneration,
      cacheGeneration: this.cacheGeneration, exemptIds: new Set(this.config.resend_exempt_qq_ids) };
    this.activeRecalls.add(policy);
    try {
      const label = (event.conversation_type === 'group' ? '群 ' : '好友 ') +
        event.peer_id + '，消息 ' + event.message_id;
      let original = this.messages.get(key);
      if (!original && !this.seenMessages.get(key)) {
        const matched = await this.waitForOriginal(event, key);
        if (matched.state !== 'matched') return matched.state;
        original = matched.original;
      }
      if (policy.cacheGeneration !== this.cacheGeneration) return 'cancelled';
      if (!original) {
        this.log('跳过撤回：原文已超出 ' + this.config.recent_messages_per_chat +
          ' 条或 ' + this.config.message_cache_ttl_ms / 60000 + ' 分钟缓存（' + label + '）。');
        return 'missing';
      }
      const authorId = id(original.user_id, true);
      if (!authorId) return 'missing';
      const originalOwn = authorId === id(event.self_id, true);
      if (originalOwn && (!policy.selfAllowed || this.config.ignore_self_messages || policy.selfGeneration !== this.selfGeneration)) return 'ignored';
      if (original.handled) return 'duplicate';
      // 标准 friend_recall 的 user_id 表示好友；本人身份以缓存原消息为准。
      if (!(event.conversation_type === 'private' && originalOwn) &&
          id(original.user_id, true) !== id(event.user_id, true)) {
        this.log('跳过：缓存发送者与撤回通知不一致（' + label + '）。');
        return 'missing';
      }
      // 先验证原作者，再在第一次等待前去重。无效通知不能消耗有效原文。
      original.handled = true;
      const held = this.deliver ? structuredClone(original.message) : null;
      if (original.ready) await this.waitForMedia(original);
      if (policy.cacheGeneration !== this.cacheGeneration) return 'cancelled';
      if (originalOwn && (this.config.ignore_self_messages || policy.selfGeneration !== this.selfGeneration)) return 'ignored';
      // 下载期间若被容量/时间边界淘汰，不恢复过期或已经退出监听的消息。
      if (this.messages.get(key) !== original && !held) return 'evicted';
      const prepared = this.messages.get(key) === original ? original.message : held;
      if (!prepared.length) {
        this.log('无法重发：没有可发送的正文（' + label + '）。');
        return 'missing';
      }
      const message = structuredClone(prepared);
      const group = event.conversation_type === 'group';
      const operatorId = group ? id(event.operator_id, true) : null;
      const authorName = group ? this.resolveRecallName(event.peer_id, authorId, original.sender_name) : original.sender_name;
      const operatorFallback = operatorId === authorId ? original.sender_name : this.cachedGroupName(event, operatorId);
      const operatorName = group && operatorId ? this.resolveRecallName(event.peer_id, operatorId, operatorFallback) : operatorFallback;
      const recallKind = !operatorId ? 'unknown' : operatorId === authorId ? 'self' : 'other';
      // 本人只以已核对的 self_id 和原消息作者判断，操作者不同不能改变原作者身份。
      // 本人自行撤回仍直接发送原内容；其余群聊统一采用用户指定的三个模板。
      const recallLabel = !group || (originalOwn && recallKind === 'self') ? '' : recallKind === 'self'
        ? identityName(authorName, authorId) + '撤回'
        : identityName(operatorName, operatorId) + (originalOwn ? '撤回了'
          : '撤回' + identityName(authorName, authorId) + '发送的');
      this.onRecall({
        conversation_type: event.conversation_type,
        conversation_id: event.peer_id,
        sender_name: authorName,
        author_id: authorId,
        operator_id: operatorId,
        operator_name: operatorName,
        recall_kind: group ? recallKind : null,
        recall_label: recallLabel,
        message_id: String(event.message_id),
        message: structuredClone(message),recovery:original.recovery||null,
      });
      if (this.isExemptAuthor(authorId) || policy.exemptIds.has(authorId)) {
        this.onSendState(String(event.message_id), 'exempt');
        this.log('已按原作者 QQ 号豁免重发，撤回内容仅在本页显示。');
        return 'exempt';
      }
      if (!policy.allowed || !this.config.auto_resend) {
        this.log('撤回内容已显示在本页，未发送到会话（' + label + '）。');
        return 'shown';
      }
      if (policy.sendGeneration !== this.sendGeneration) {
        this.onSendState(String(event.message_id), 'cancelled');
        return 'cancelled';
      }
      if (!group && !originalOwn && this.config.message_prefix) {
        message.unshift({ type: 'text', data: { text: this.config.message_prefix } });
      }
      if (recallLabel) {
        message.unshift({ type: 'text', data: { text: recallLabel + '：' } });
      }
      if (this.config.dry_run) {
        this.log('模拟检测成功，未发送（' + label + '）。');
        return 'dry-run';
      }
      if (this.deliver) {
        await this.deliver({ key, selfId: id(event.self_id, true), type: event.conversation_type,
          peerId: id(event.peer_id, true), authorId, isSelf: originalOwn,
          sourceMessageId: String(event.message_id), message, mediaBytes: messageMediaBytes(message) });
        return 'outbox';
      }
      return await this.sendQueue.enqueue(async signal => {
        if (signal.aborted || !this.config.auto_resend || policy.sendGeneration !== this.sendGeneration ||
            (originalOwn && (this.config.ignore_self_messages || policy.selfGeneration !== this.selfGeneration))) return 'cancelled';
        if (this.messages.get(key) !== original) return 'cancelled';
        if (this.isExemptAuthor(authorId) || policy.exemptIds.has(authorId)) {
          this.onSendState(String(event.message_id), 'exempt');
          return 'exempt';
        }
        try {
          const group = event.conversation_type === 'group';
          const plan=recallSendPlan(message,{type:event.conversation_type,peerId:event.peer_id,selfId:event.self_id});
          const result = await api.call(plan.action,plan.body);
          if (id(result.message_id) !== null) {
            this.sent.put(messageKey({ ...event, message_id: result.message_id }), true);
          }
          this.log('接口确认重发成功（' + label + '）。');
          return 'sent';
        } catch (error) {
          this.log('重发未确认（' + label + '）：' + error.message +
            '。为避免重复发言，不自动重试这次发送。');
          return 'failed';
        }
      }, {
        isSelf: originalOwn,
        authorId,
        mediaBytes: messageMediaBytes(message),
        onState: state => this.onSendState(String(event.message_id), state),
      });
    } finally { this.activeRecalls.delete(policy); }
  }
}

export class OneBotClient {
  constructor(config, onEvent = () => {}, Socket = globalThis.WebSocket) {
    this.config = config;
    this.onEvent = onEvent;
    this.Socket = Socket;
    this.pending = new Map();
    this.latePending = new Map();
    this.socket = null;
  }
  open() {
    const url = new URL(this.config.ws_url);
    const token = process.env.QQ_RECALL_TOKEN || this.config.access_token;
    if (token) url.searchParams.set('access_token', token);
    this.closed = new Promise((resolveClosed) => { this.resolveClosed = resolveClosed; });
    return new Promise((resolveOpen, rejectOpen) => {
      let opened = false;
      const timeout = setTimeout(() => {
        rejectOpen(new Error('连接超时，请检查 NapCat 是否启动以及端口是否一致'));
        this.close();
      }, 10000);
      try { this.socket = new this.Socket(url.href); }
      catch {
        clearTimeout(timeout);
        this.resolveClosed();
        rejectOpen(new Error('无法创建 WebSocket 连接'));
        return;
      }
      this.socket.addEventListener('open', () => {
        clearTimeout(timeout);
        opened = true;
        resolveOpen();
      });
      this.socket.addEventListener('message', (event) => {
        let data;
        try { data = JSON.parse(String(event.data)); } catch { return; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return;
        for (const [echo, item] of this.latePending) if (item.expires <= Date.now()) this.latePending.delete(echo);
        const late = this.latePending.get(data.echo);
        if (late) {
          if (data.status === 'async' || data.retcode === 1) return;
          this.latePending.delete(data.echo);
          if (data.status === 'ok' && data.retcode === 0) late.onLateResult?.(data.data ?? {});
          return;
        }
        const pending = this.pending.get(data.echo);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(data.echo);
          if (data.status === 'ok' && data.retcode === 0) pending.resolve(data.data ?? {});
          else {
            if ((data.status === 'async' || data.retcode === 1) && pending.onLateResult) {
              this.latePending.set(data.echo, { onLateResult: pending.onLateResult, expires: Date.now() + 900000 });
              while (this.latePending.size > 100) this.latePending.delete(this.latePending.keys().next().value);
            }
            const error = new Error('OneBot 接口拒绝请求，retcode=' + String(data.retcode));
            error.retcode = Number(data.retcode);
            if(pending.packetDiagnostic)error.packetDiagnostic=packetErrorDetails({message:data.message,wording:data.wording});
            // 仅保留安全分类，不记录可能包含消息、链接或凭据的原始错误正文。
            const description = String(data.message || data.wording || '');
            error.category = /禁言|muted/i.test(description) ? 'muted' : /离线|offline|not.?login/i.test(description) ? 'offline_reported'
              : /撤回|不存在|not.?found/i.test(description) ? 'unavailable' : 'api_error';
            pending.reject(error);
          }
          return;
        }
        if (data.post_type) {
          Promise.resolve().then(() => this.onEvent(data, this)).catch(() => {});
        }
      });
      this.socket.addEventListener('error', () => {
        clearTimeout(timeout);
        if (!opened) rejectOpen(new Error('连接失败，请检查 NapCat 正向 WS 服务、地址和 Token'));
        this.close();
      });
      this.socket.addEventListener('close', () => {
        clearTimeout(timeout);
        if (!opened) rejectOpen(new Error('QQ 接口在连接完成前关闭'));
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('QQ 接口连接已断开'));
        }
        this.pending.clear();
        this.resolveClosed();
      });
    });
  }
  call(action, params = {}, options = {}) {
    if (!this.socket || this.socket.readyState !== 1) {
      return Promise.reject(Object.assign(new Error('QQ 接口未连接'), { notSubmitted: true }));
    }
    const echo = randomUUID();
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        if (options.onLateResult) {
          this.latePending.set(echo, { onLateResult: options.onLateResult, expires: Date.now() + 900000 });
          while (this.latePending.size > 100) this.latePending.delete(this.latePending.keys().next().value);
        }
        rejectCall(new Error('接口响应超时，结果未知'));
      }, this.config.api_timeout_ms);
      this.pending.set(echo, { resolve: resolveCall, reject: rejectCall, timer, onLateResult: options.onLateResult, packetDiagnostic:action==='nc_get_packet_status'&&options.packetDiagnostic===true });
      try { this.socket.send(JSON.stringify({ action, params, echo })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        rejectCall(Object.assign(new Error('请求发送失败'), { notSubmitted: error?.name === 'InvalidStateError' }));
      }
    });
  }
  close() {
    try { if (this.socket?.readyState < 2) this.socket.close(); } catch {}
  }
}
