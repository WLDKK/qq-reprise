import { apiBinding, sameAPIBinding } from './ai-api-draft.mjs';
import { createHash } from 'node:crypto';
import { AIError } from './ai-auth.mjs';
// Shared scheduling core; callers supply already-authorized transports.
// Per-route bounds and local waiting never relax limits or replay sent requests.
export class PoolError extends AIError {
  constructor(code) { super(code); this.code = code; }
}
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 1000000000;
const waitForCapacity=(ms,signal)=>new Promise((resolve,reject)=>{let timer;const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);},abort=()=>{cleanup();reject(signal.reason);};timer=setTimeout(()=>{cleanup();resolve();},ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
const routeTokens=(reservation,route)=>typeof reservation==='number'?reservation:reservation[route.id];
const optionalLimit = value => Number.isSafeInteger(value) && value >= 0;
const windows = { rpm: 60000, tpm: 60000, tokens5h: 18000000, tokens7d: 604800000 };
const quotaCodes = new Set(['insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached', 'credit_balance_exhausted']);
export function poolFailure(error, streamStarted = false) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'cancelled_or_uncertain';
  if (quotaCodes.has(error?.code) || error?.rateLimitKind === 'quota') return 'quota';
  if (error?.status === 401 || error?.status === 403) return 'authorization';
  if (error?.status === 429) return error.rateLimitKind === 'temporary' ? 'rate_limit' : 'unclassified_limit';
  if (streamStarted) return 'stream_started';
  if ([502, 503, 504].includes(error?.status)) return 'outage';
  if (error?.status >= 400) return 'terminal_or_uncertain';
  if (error?.notSubmitted === true) return 'not_submitted';
  return 'terminal_or_uncertain';
}
export class APIAccountPool {
  constructor({ enabled = false, mode = 'primary_backup', routes = [], now = Date.now, cooldownMs = 30000, journalLimit = 2000, store = null, storageRequired = false, wait = waitForCapacity } = {}) {
    if (typeof enabled !== 'boolean' || !['primary_backup', 'round_robin'].includes(mode) || !Array.isArray(routes) || routes.length > 10 || !positive(cooldownMs) || !positive(journalLimit)) throw new PoolError('pool_configuration_invalid');
    if(typeof wait!=='function')throw new PoolError('pool_configuration_invalid');this.wait=wait;this.enabled = enabled; this.mode = mode; this.now = now; this.cooldownMs = cooldownMs; this.journalLimit = journalLimit;
    this.routes = []; this.accounts = new Map(); this.journal = new Map(); this.cursor = 0; this.reviewRequired = false; this.store = store; this.storageRequired = storageRequired; this.initialized = !store; this.persistenceError = false; this.writes = Promise.resolve(); this.recoveredUncertain = 0;
    const routeIDs = new Set();
    for (const route of routes) {
      if (!route || Object.keys(route).some(k => !['id', 'accountId', 'limits'].includes(k)) || !id(route.id) || !id(route.accountId) || routeIDs.has(route.id)) throw new PoolError('pool_route_invalid');
      if (!route.limits || Object.keys(route.limits).sort().join() !== ['concurrency', ...Object.keys(windows)].sort().join() || !positive(route.limits.concurrency) || Object.keys(windows).some(k => !optionalLimit(route.limits[k])) || route.limits.concurrency > 3) throw new PoolError('pool_limits_required');
      const limits = Object.fromEntries(['concurrency', ...Object.keys(windows)].map(k => [k, route.limits[k]]));
      const prior = this.accounts.get(route.accountId);
      if (prior && JSON.stringify(prior.limits) !== JSON.stringify(limits)) throw new PoolError('pool_account_limits_conflict');
      if (!prior) this.accounts.set(route.accountId, { limits, active: 0, records: [], cooldownUntil: 0, held: '' });
      routeIDs.add(route.id); this.routes.push(Object.freeze({ id: route.id, accountId: route.accountId }));
    }
  }
  async initialize() {
    if (!this.store) return;
    try {
      const saved = await this.store.read();
      if (!saved && this.storageRequired) throw new PoolError('pool_ledger_missing');
      if (saved) this.restore(saved);
      this.initialized = true;
      if (saved) await this.checkpoint();
    } catch (error) { this.persistenceError = true; throw error instanceof PoolError ? error : new PoolError('pool_ledger_invalid'); }
  }
  snapshot() {
    return { version: 1, clockAt: this.now(), cursor: this.cursor, reviewRequired: this.reviewRequired,
      accounts: [...this.accounts].map(([accountId, s]) => ({ accountId, limits: s.limits, records: s.records, cooldownUntil: s.cooldownUntil, held: s.held })),
      journal: [...this.journal].map(([key, r]) => ({ key, at: r.at, pending: r.pending })) };
  }
  restore(saved) {
    const fail = () => { throw new PoolError('pool_ledger_invalid'); };
    if (!saved || Object.keys(saved).sort().join() !== ['version','clockAt','cursor','reviewRequired','accounts','journal'].sort().join() || saved.version !== 1 ||
        !Number.isSafeInteger(saved.clockAt) || saved.clockAt < 0 || typeof saved.reviewRequired !== 'boolean' || !Number.isSafeInteger(saved.cursor) || saved.cursor < 0 ||
        !Array.isArray(saved.accounts) || saved.accounts.length > 100 || !Array.isArray(saved.journal) || saved.journal.length > this.journalLimit) fail();
    if (this.now() + 1000 < saved.clockAt) throw new PoolError('pool_clock_rollback');
    const configured = this.accounts, restored = new Map(); let count = 0;
    for (const item of saved.accounts) {
      if (!item || Object.keys(item).sort().join() !== ['accountId','limits','records','cooldownUntil','held'].sort().join() ||
          !id(item.accountId) || restored.has(item.accountId) || !Array.isArray(item.records) ||
          !Number.isSafeInteger(item.cooldownUntil) || item.cooldownUntil < 0 || !['','quota','unclassified_limit','authorization','reservation_exceeded'].includes(item.held)) fail();
      const validator = new APIAccountPool({ routes: [{ id: 'validate', accountId: item.accountId, limits: item.limits }] });
      const records = item.records.map(r => {
        if (!r || Object.keys(r).sort().join() !== ['at','tokens','pending'].sort().join() || !Number.isSafeInteger(r.at) || r.at < 0 || !positive(r.tokens) || typeof r.pending !== 'boolean') fail();
        if (++count > 10000) fail();
        return { at: r.at, tokens: r.tokens, pending: false };
      });
      restored.set(item.accountId, { limits: configured.get(item.accountId)?.limits || validator.accounts.get(item.accountId).limits, records, active: 0, cooldownUntil: item.cooldownUntil, held: item.held });
    }
    for (const [key, state] of configured) if (!restored.has(key)) restored.set(key, state);
    if (restored.size > 100) fail();
    const journal = new Map();
    for (const r of saved.journal) {
      if (!r || Object.keys(r).sort().join() !== ['key','at','pending'].sort().join() || !/^[a-f0-9]{64}$/.test(r.key) || journal.has(r.key) ||
          !Number.isSafeInteger(r.at) || r.at < 0 || typeof r.pending !== 'boolean') fail();
      if (r.pending) this.recoveredUncertain++;
      journal.set(r.key, { at: r.pending ? this.now() : r.at, pending: false });
    }
    this.accounts = restored; this.journal = journal; this.cursor = this.routes.length ? saved.cursor % this.routes.length : 0;
    this.reviewRequired = saved.reviewRequired; this.prune();
  }
  checkpoint() {
    if (!this.store) return Promise.resolve();
    const snapshot = structuredClone(this.snapshot());
    this.writes = this.writes.then(() => this.store.write(snapshot)).catch(() => { this.persistenceError = true; throw new PoolError('pool_ledger_write_failed'); });
    return this.writes;
  }
  prune() {
    const now = this.now();
    for (const state of this.accounts.values()) state.records = state.records.filter(r => r.pending || now - r.at < windows.tokens7d);
    for (const [key, record] of this.journal) if (!record.pending && now - record.at >= 86400000) this.journal.delete(key);
  }
  available(route, tokens) {
    const state = this.accounts.get(route.accountId), now = this.now();
    if (state.held || state.cooldownUntil > now || state.active >= state.limits.concurrency || [...this.accounts.values()].reduce((n, s) => n + s.records.length, 0) >= 10000) return false;
    return Object.entries(windows).every(([name, ms]) => {
      const used = state.records.filter(r => now - r.at < ms || r.pending).reduce((sum, r) => sum + (name === 'rpm' ? 1 : r.tokens), 0);
      return state.limits[name] === 0 || (name === 'rpm' ? 1 : tokens) <= state.limits[name] - used;
    });
  }
  admissionInfo(route,tokens){const state=this.accounts.get(route.accountId),now=this.now();let reason=state.held?'held':state.cooldownUntil>now?'cooldown':state.active>=state.limits.concurrency?'concurrency':'';if(reason)return{localBudgetReason:reason,localReservationTokens:tokens,localBudgetUsed:0,localBudgetLimit:0};for(const[name,ms]of Object.entries(windows)){if(state.limits[name]===0)continue;const used=state.records.filter(r=>r.pending||now-r.at<ms).reduce((sum,r)=>sum+(name==='rpm'?1:r.tokens),0),needed=name==='rpm'?1:tokens;if(used+needed>state.limits[name])return{localBudgetReason:name,localReservationTokens:tokens,localBudgetUsed:used,localBudgetLimit:state.limits[name]};}return{localBudgetReason:'record_limit',localReservationTokens:tokens,localBudgetUsed:0,localBudgetLimit:0};}
  nextAvailableAt(route,tokens){const state=this.accounts.get(route.accountId),now=this.now();if(state.held||state.active>=state.limits.concurrency||[...this.accounts.values()].reduce((n,s)=>n+s.records.length,0)>=10000)return Infinity;let at=Math.max(now,state.cooldownUntil);for(const[name,ms]of Object.entries(windows)){if(state.limits[name]===0)continue;const needed=name==='rpm'?1:tokens,records=state.records.filter(r=>r.pending||now-r.at<ms);let used=records.reduce((sum,r)=>sum+(name==='rpm'?1:r.tokens),0);if(needed>state.limits[name])return Infinity;if(used+needed<=state.limits[name])continue;let freedAt=Infinity;for(const r of records.filter(r=>!r.pending).sort((a,b)=>a.at-b.at)){used-=name==='rpm'?1:r.tokens;if(used+needed<=state.limits[name]){freedAt=r.at+ms;break;}}at=Math.max(at,freedAt);}return at;}
  validReservation(value){if(positive(value))return true;return value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Object.keys(value).length===this.routes.length&&this.routes.every(r=>Object.hasOwn(value,r.id)&&positive(value[r.id]));}
  // requestId must be the stable source-event ID (account/chat/message), never text.
  // reservationTokens must bound input + all output/reasoning, not a char estimate.
  async run({ requestId, reservationTokens, execute, signal, availabilityWaitMs=0, onWait=()=>{},waitRoundsLimit=8,maxAttempts=10 } = {}) {
    if (!this.enabled) throw new PoolError('pool_disabled');
    if (!this.initialized || this.persistenceError) throw new PoolError('pool_ledger_unavailable');
    if (typeof requestId !== 'string' || !/^[\w:.-]{1,200}$/.test(requestId) || !this.validReservation(reservationTokens) || typeof execute !== 'function' || !Number.isSafeInteger(availabilityWaitMs) || availabilityWaitMs<0 || availabilityWaitMs>2147483647 || typeof onWait!=='function') return Promise.reject(new PoolError('pool_request_invalid'));
    if(!Number.isSafeInteger(waitRoundsLimit)||waitRoundsLimit<0)throw new PoolError('pool_request_invalid');
    if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1)throw new PoolError('pool_request_invalid');
    requestId = createHash('sha256').update(requestId).digest('hex');
    this.prune();
    if (this.journal.has(requestId)) return Promise.reject(new PoolError('pool_duplicate_request'));
    if (this.reviewRequired) return Promise.reject(new PoolError('pool_limit_review_required'));
    if (this.journal.size >= this.journalLimit) return Promise.reject(new PoolError('pool_journal_full'));
    const record = { at: this.now(), pending: true };
    this.journal.set(requestId, record);
    await this.checkpoint();
    try { return await this.execute({ reservationTokens, execute, signal, availabilityWaitMs, onWait,waitRoundsLimit,maxAttempts }); }
    finally { record.pending = false; record.at = this.now(); await this.checkpoint(); }
  }
  async execute({ reservationTokens, execute, signal, availabilityWaitMs=0, onWait=()=>{}, waitRounds=0, capacityWaitedMs=0,waitRoundsLimit=8,maxAttempts=10 }) {
    const routes = this.mode === 'round_robin' ? [...this.routes.slice(this.cursor), ...this.routes.slice(0, this.cursor)] : this.routes;
    const attempted = new Set(); let previousError;
    if(availabilityWaitMs>0&&(waitRoundsLimit===0||waitRounds<waitRoundsLimit)&&!routes.some(route=>this.available(route,routeTokens(reservationTokens,route)))){
      const began=this.now(),next=Math.min(...routes.map(route=>this.nextAvailableAt(route,routeTokens(reservationTokens,route)))),delay=next-began;
      if(Number.isFinite(next)&&delay>0&&delay<=availabilityWaitMs){
        const route=routes.find(r=>this.nextAvailableAt(r,routeTokens(reservationTokens,r))===next),info=this.admissionInfo(route,routeTokens(reservationTokens,route));
        try{onWait({...info,localAdmissionState:'waiting',localCapacityWaitMs:capacityWaitedMs,localCapacityWaitPlannedMs:delay});}catch{}
        try{signal?.throwIfAborted();await this.wait(delay,signal);signal?.throwIfAborted();}
        catch(error){try{onWait({...info,localAdmissionState:'cancelled',localCapacityWaitMs:Math.min(2147483647,capacityWaitedMs+Math.max(0,this.now()-began)),localCapacityWaitPlannedMs:0});}catch{}throw error;}
        const elapsed=Math.max(0,this.now()-began);
        return this.execute({reservationTokens,execute,signal,availabilityWaitMs:Math.max(0,availabilityWaitMs-Math.max(delay,elapsed)),onWait,waitRounds:waitRounds+1,capacityWaitedMs:Math.min(2147483647,capacityWaitedMs+elapsed),waitRoundsLimit,maxAttempts});
      }
    }
    for (const route of routes) {
      signal?.throwIfAborted();
      if(attempted.size>=maxAttempts)break;
      if (attempted.has(route.accountId) || !this.available(route, routeTokens(reservationTokens,route))) continue;
      attempted.add(route.accountId);
      this.cursor = (this.routes.indexOf(route) + 1) % this.routes.length;
      const state = this.accounts.get(route.accountId), charge = { at: this.now(), tokens: routeTokens(reservationTokens,route), pending: true };
      try{onWait({localBudgetReason:'checking',localAdmissionState:'admitted',localCapacityWaitMs:capacityWaitedMs,localCapacityWaitPlannedMs:0,localReservationTokens:charge.tokens,localBudgetUsed:state.records.filter(r=>r.pending||this.now()-r.at<60000).reduce((sum,r)=>sum+r.tokens,0),localBudgetLimit:state.limits.tpm});}catch{}
      // Reserve synchronously before awaiting; keys of one account share this ledger.
      state.active++; state.records.push(charge);
      let streamStarted = false;
      const progress = value => {
        if (value?.streamEvents > 0 || value?.outputChars > 0 || ['streaming', 'reasoning'].includes(value?.phase)) streamStarted = true;
        const total = value?.tokenUsage?.total;
        // Keep the upper-bound reservation if reporting is absent or smaller.
        if (positive(total) && total > charge.tokens) { charge.tokens = total; state.held = 'reservation_exceeded'; this.reviewRequired = true; }
      };
      try {
        await this.checkpoint();
        const answer = await execute(route, { signal, progress });
        signal?.throwIfAborted();
        return { routeId: route.id, accountId: route.accountId, answer };
      } catch (error) {
        previousError = error;
        const kind = poolFailure(error, streamStarted);
        if (kind === 'quota' || kind === 'unclassified_limit') { state.held = kind; this.reviewRequired = true; }
        if (kind === 'authorization') state.held = kind;
        if (kind === 'rate_limit' || kind === 'outage' || kind === 'not_submitted') {
          const seconds = error?.retryAfterSeconds;
          state.cooldownUntil = this.now() + (Number.isFinite(seconds) && seconds >= 0 && seconds <= 2147483 ? Math.max(this.cooldownMs, seconds * 1000) : this.cooldownMs);
        }
        // Never rotate accounts to replay quota, auth, 429, output, or uncertain errors.
        if (!['outage', 'not_submitted'].includes(kind) || this.reviewRequired || signal?.aborted) throw error;
      } finally { state.active--; charge.pending = false; charge.at = this.now(); await this.checkpoint(); }
    }
    if(!previousError&&routes[0])try{onWait({...this.admissionInfo(routes[0],routeTokens(reservationTokens,routes[0])),localAdmissionState:'rejected',localCapacityWaitMs:capacityWaitedMs,localCapacityWaitPlannedMs:0});}catch{}
    throw previousError || Object.assign(new PoolError('pool_no_available_account'),{notSubmitted:true});
  }
  state() {
    this.prune();
    return { enabled: this.enabled, mode: this.mode, reviewRequired: this.reviewRequired, persistenceError: this.persistenceError, recoveredUncertain: this.recoveredUncertain, requestsRemembered: this.journal.size,
      accounts: [...this.accounts].map(([accountId, s]) => ({ accountId, active: s.active, held: s.held, cooldownUntil: s.cooldownUntil,
        usage: Object.fromEntries(Object.entries(windows).map(([name, ms]) => [name, s.records.filter(r => r.pending || this.now() - r.at < ms).reduce((n, r) => n + (name === 'rpm' ? 1 : r.tokens), 0)])) })) };
  }
}

// Drop-in provider seam for later explicit integration. No credential lookup here.
export class PooledAPIProvider {
  constructor({ fallback, pool = new APIAccountPool(), providerForRoute } = {}) { Object.assign(this, { fallback, pool, providerForRoute }); }
  models(...args) { return this.fallback.models(...args); }
  async generate(config, history, prompt, signal, onProgress = () => {}, options = {}) {
    if (!this.pool.enabled) return this.fallback.generate(config, history, prompt, signal, onProgress, options);
    if (config.backend !== 'api' || options.image || options.testReply || options.key || options.onText) throw new PoolError('pool_route_scope_not_supported');
    const result = await this.pool.run({ requestId: options.requestId, reservationTokens: options.reservationTokens, signal,
      execute: async (route, context) => {
        const target = await this.providerForRoute(route); signal?.throwIfAborted();
        if (!target?.provider || target.config?.backend !== 'api' || !sameAPIBinding(apiBinding(config), apiBinding(target.config)) || target.config.api_model !== config.api_model) throw new PoolError('pool_transport_invalid');
        return target.provider.generate(target.config, history, prompt, signal, p => { context.progress(p); try { onProgress(p); } catch {} });
      } });
    return result.answer;
  }
}
