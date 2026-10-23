import { setTimeout as sleep } from 'node:timers/promises';

export function messageMediaStats(message) {
  const seen=new WeakSet();let total=0,largest=0;
  function walk(value) {
    if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);
    if(Array.isArray(value)){for(const v of value)walk(v);return;}
    const file=String(value.data?.file||'');
    if(file.startsWith('base64://')){const encoded=file.slice(9),bytes=Math.max(0,Math.floor(encoded.length*3/4)-(encoded.match(/=+$/)?.[0].length||0));total+=bytes;largest=Math.max(largest,bytes);}
    if(value.data?.content)walk(value.data.content);if(value.data?.messages)walk(value.data.messages);if(value.data?.message)walk(value.data.message);
    if(value.message)walk(value.message);
  }
  walk(message);return{total,largest};
}
export function messageMediaBytes(message) {return messageMediaStats(message).total;}

// 只调度已捕获的撤回；任何登录、重启操作都不属于发送队列。
export class ResendQueue {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs ?? 3000;
    this.jitterMs = options.jitterMs ?? 300;
    this.random = options.random || Math.random;
    this.limit = options.limit ?? 10;
    this.mediaLimit = options.mediaLimit ?? 64 * 1024 * 1024;
    this.now = options.now || Date.now;
    this.wait = options.wait || ((ms, signal) => sleep(ms, undefined, { signal }));
    this.jobs = [];
    this.current = null;
    this.running = false;
    this.mediaBytes = 0;
    this.lastStartedAt = null;
  }
  get pendingCount() {
    return this.jobs.length + (this.current && !this.current.started &&
      !this.current.controller.signal.aborted ? 1 : 0);
  }
  notify(job, state) {
    try { job.onState(state); } catch {}
  }
  setInterval(intervalMs) {
    if (!Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > 60000) throw new Error('发送间隔必须为 0～60 秒。');
    this.intervalMs = intervalMs;
    if (this.current && !this.current.started) this.current.waitController?.abort();
  }
  enqueue(task, options = {}) {
    const weight = Math.max(0, options.mediaBytes || 0);
    const onState = options.onState || (() => {});
    if (this.jobs.length + (this.current ? 1 : 0) >= this.limit ||
        this.mediaBytes + weight > this.mediaLimit) {
      try { onState('queue_full'); } catch {}
      return Promise.resolve('queue_full');
    }
    return new Promise(resolveResult => {
      const job = {
        task, onState, resolveResult, weight, enqueuedAt: this.now(), started: false,
        isSelf: options.isSelf === true,
        authorId: options.authorId || '',
        priority: options.priority || 0,
        key: options.key || '',
        offsetMs: Math.round((this.random() * 2 - 1) * this.jitterMs),
        controller: new AbortController(), done: false,
      };
      this.mediaBytes += weight;
      this.jobs.push(job);
      this.jobs.sort((a, b) => b.priority - a.priority);
      if (this.current && !this.current.started && job.priority > this.current.priority) {
        this.current.preempted = true; this.current.waitController?.abort();
      }
      this.notify(job, 'queued');
      void this.drain();
    });
  }
  finish(job, result) {
    if (job.done) return;
    job.done = true;
    this.mediaBytes -= job.weight;
    job.task = null;
    job.resolveResult(result);
  }
  cancel(predicate = () => true, reason = 'cancelled') {
    const result = reason === 'exempt' ? 'exempt' : 'cancelled';
    const cancelled = [], remaining = [];
    for (const job of this.jobs) (predicate(job) ? cancelled : remaining).push(job);
    this.jobs = remaining;
    for (const job of cancelled) {
      job.cancelResult = result;
      job.controller.abort();
      this.notify(job, result);
      this.finish(job, result);
    }
    // 已交给 QQ 接口的请求无法撤销；只取消尚未发出的任务。
    if (this.current && !this.current.started && predicate(this.current)) {
      this.current.cancelResult = result;
      this.current.controller.abort();
      this.notify(this.current, result);
    }
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs.shift();
        this.current = job;
        let result = 'cancelled';
        try {
          while (!job.controller.signal.aborted) {
            if (job.preempted) break;
            // 每条消息只抽取一次偏移；调速时沿用它，避免等待中反复随机。
            const delay = Math.max(0, this.intervalMs + job.offsetMs);
            const due = Math.max(job.enqueuedAt + delay,
              this.lastStartedAt === null ? -Infinity : this.lastStartedAt + delay);
            const remaining = due - this.now();
            if (remaining <= 0) break;
            job.waitController = new AbortController();
            const signal = AbortSignal.any([job.controller.signal, job.waitController.signal]);
            try { await this.wait(remaining, signal); }
            catch (error) { if (error.name !== 'AbortError') throw error; }
          }
          if (job.preempted && !job.controller.signal.aborted) {
            job.preempted = false; this.jobs.push(job); this.jobs.sort((a, b) => b.priority - a.priority); continue;
          }
          if (!job.controller.signal.aborted) {
            job.started = true;
            this.lastStartedAt = this.now();
            this.notify(job, 'sending');
            result = await job.task(job.controller.signal);
          }
        } catch {
          result = job.controller.signal.aborted ? (job.cancelResult || 'cancelled') : 'failed';
        } finally {
          if (job.controller.signal.aborted && !job.started) result = job.cancelResult || 'cancelled';
          if (!this.jobs.includes(job)) this.finish(job, result);
          this.current = null;
        }
      }
    } finally { this.running = false; }
  }
}
