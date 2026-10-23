export function validateDeliverySettings(limit, minutes, matchSeconds) {
  if (!Number.isSafeInteger(limit) || limit < 10 || limit > 500 ||
      !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120 ||
      !Number.isSafeInteger(matchSeconds) || matchSeconds < 1 || matchSeconds > 30) {
    throw new Error('待发送容量需为10～500条、保留1～120分钟，快速撤回匹配需为1～30秒。');
  }
  return { outbox_limit: limit, outbox_ttl_minutes: minutes, recall_match_seconds: matchSeconds };
}

// 只有调用本地 WebSocket.send 之前的明确失败可自动再试。
// NapCat 1200 是通用异常；超时、断线后的已提交请求一律保留为不确定。
export function deliveryFailure(error) {
  return error?.notSubmitted === true ? 'deferred' : 'uncertain';
}

export class RetainedOutbox {
  constructor({ inspect, submit, pace, onState = () => {}, now = Date.now,
    timers = { setTimeout, clearTimeout }, limit = 100, ttlMs = 1800000,
    byteLimit = 96 * 1024 * 1024, mediaLimit = 64 * 1024 * 1024, priority = 0 } = {}) {
    Object.assign(this, { inspect, submit, pace, onState, now, timers, limit, ttlMs, byteLimit, mediaLimit, priority });
    this.jobs = new Map(); this.completed = new Map(); this.bytes = 0; this.mediaBytes = 0;
    this.running = false; this.timer = null; this.disposed = false;
    this.counters = { sent: 0, dropped_oldest: 0, expired: 0, retries: 0, uncertain_total: 0 };
  }
  state(job, state) {
    job.state = state;
    try { this.onState(job, state); } catch {}
    if (['deferred', 'uncertain'].includes(state)) job.resolveFirst?.(state);
  }
  finish(job, state) {
    if (!this.jobs.has(job.key)) return;
    this.jobs.delete(job.key); this.bytes -= job.bytes; this.mediaBytes -= job.mediaBytes;
    this.completed.set(job.key, this.now() + 86400000);
    while (this.completed.size > 5000) this.completed.delete(this.completed.keys().next().value);
    if (state === 'sent') this.counters.sent++;
    if (state === 'dropped') this.counters.dropped_oldest++;
    if (state === 'expired') this.counters.expired++;
    this.state(job, state); job.resolveFirst?.(state); job.message = null;
  }
  prune() {
    for (const [key, expiry] of this.completed) if (expiry <= this.now()) this.completed.delete(key);
    for (const job of [...this.jobs.values()]) if (!job.inFlight && job.created + this.ttlMs <= this.now()) this.finish(job, 'expired');
  }
  configure(limit, ttlMs) {
    this.limit = limit; this.ttlMs = ttlMs; this.prune();
    while (this.jobs.size > limit) {
      const oldest = [...this.jobs.values()].find(job => !job.inFlight);
      if (!oldest) break; this.finish(oldest, 'dropped');
    }
    this.kick();
  }
  snapshot() {
    this.prune();
    return { pending: this.jobs.size, waiting: [...this.jobs.values()].filter(job => job.state !== 'uncertain').length,
      limit: this.limit, ttl_minutes: this.ttlMs / 60000, media_mb: Number((this.mediaBytes / 1048576).toFixed(1)), ...this.counters,
      // 当前不确定数量和累计数量分别提供。
      uncertain_count: [...this.jobs.values()].filter(job => job.state === 'uncertain').length };
  }
  enqueue(input) {
    this.prune();
    if (this.disposed) return Promise.resolve('cancelled');
    if (this.jobs.has(input.key) || this.completed.has(input.key)) return Promise.resolve('duplicate');
    const message = structuredClone(input.message), bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    const mediaBytes = input.mediaBytes || 0;
    if (bytes > this.byteLimit || mediaBytes > this.mediaLimit) return Promise.resolve('queue_full');
    while (this.jobs.size >= this.limit || this.bytes + bytes > this.byteLimit || this.mediaBytes + mediaBytes > this.mediaLimit) {
      const oldest = [...this.jobs.values()].find(job => !job.inFlight);
      if (!oldest) return Promise.resolve('queue_full');
      this.finish(oldest, 'dropped');
    }
    return new Promise(resolveFirst => {
      const job = { ...input, message, bytes, mediaBytes, resolveFirst, created: this.now(), attempts: 0, nextAt: 0,
        state: 'queued', inFlight: false, receipt: null };
      this.jobs.set(job.key, job); this.bytes += bytes; this.mediaBytes += mediaBytes;
      this.state(job, 'queued');
      // 入队确认不等待排在前面的离线任务恢复；每条通知可以立即完成接收。
      if (this.inspect(job) === 'offline') this.state(job, 'deferred');
      else if (this.running) resolveFirst('queued');
      void this.pump();
    });
  }
  confirm(key, messageId) {
    if (!/^-?\d+$/.test(String(messageId))) return;
    const job = this.jobs.get(key); if (!job || job.receipt) return;
    job.receipt = String(messageId); this.finish(job, 'sent'); this.kick();
  }
  cancel(predicate = () => true, reason = 'cancelled') {
    for (const job of [...this.jobs.values()]) if (!job.inFlight && predicate(job)) this.finish(job, reason);
    this.kick();
  }
  kick() { this.timers.clearTimeout(this.timer); this.timer = null; if (!this.disposed) void this.pump(); }
  suspend() { this.pace.cancel(); this.kick(); }
  resume() { for (const job of this.jobs.values()) if (job.state !== 'uncertain') job.nextAt = 0; this.kick(); }
  schedule() {
    this.timers.clearTimeout(this.timer); this.timer = null;
    if (!this.jobs.size || this.disposed) return;
    let delay = 5000;
    for (const job of this.jobs.values()) delay = Math.min(delay, Math.max(10, job.created + this.ttlMs - this.now()),
      job.nextAt > this.now() ? job.nextAt - this.now() : 5000);
    this.timer = this.timers.setTimeout(() => { this.timer = null; void this.pump(); }, delay);
    this.timer?.unref?.();
  }
  async pump() {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      this.prune();
      for (const job of [...this.jobs.values()]) {
        if (!this.jobs.has(job.key)) continue;
        const permission = this.inspect(job);
        if (['cancelled', 'exempt', 'scope_changed'].includes(permission)) { this.finish(job, permission); continue; }
        if (job.state === 'uncertain') continue; // 没有回执证明时绝不再次提交。
        if (permission !== 'ready') { this.state(job, 'deferred'); break; }
        if (job.nextAt > this.now()) break;
        job.attempts++; if (job.attempts > 1) this.counters.retries++;
        const result = await this.pace.enqueue(async signal => {
          if (!this.jobs.has(job.key)) return 'cancelled';
          const latest = this.inspect(job);
          if (signal.aborted || latest !== 'ready') return latest === 'offline' ? 'deferred' : latest;
          if (job.created + this.ttlMs <= this.now()) return 'expired';
          job.inFlight = true; this.state(job, 'sending');
          try {
            const response = await this.submit(job);
            if (/^-?\d+$/.test(String(response?.message_id))) { job.receipt = String(response.message_id); return 'sent'; }
            return 'uncertain';
          } catch (error) { return deliveryFailure(error); }
          finally { job.inFlight = false; }
        }, { authorId: job.authorId, isSelf: job.isSelf, mediaBytes: job.mediaBytes, priority: this.priority, key: job.key });
        if (!this.jobs.has(job.key)) continue; // 异步消息 ID 回执已确认。
        if (job.receipt) this.finish(job, 'sent');
        else if (['sent', 'exempt', 'scope_changed', 'expired'].includes(result)) this.finish(job, result);
        else if (result === 'uncertain') { this.counters.uncertain_total++; this.state(job, 'uncertain'); }
        else if (result === 'cancelled' && this.inspect(job) !== 'offline') this.finish(job, 'cancelled');
        else { job.nextAt = this.now() + Math.min(60000, 2000 * 2 ** Math.min(job.attempts - 1, 5)); this.state(job, 'deferred'); break; }
      }
    } finally {
      this.running = false;
      const next = [...this.jobs.values()].find(job => job.state !== 'uncertain');
      if (!this.disposed && next && next.nextAt <= this.now() && this.inspect(next) === 'ready') queueMicrotask(() => this.pump());
      else this.schedule();
    }
  }
  dispose() { this.disposed = true; this.timers.clearTimeout(this.timer); this.cancel(); this.pace.cancel(); }
}
