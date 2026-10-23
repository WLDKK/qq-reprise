import { join } from 'node:path';
import { readFile, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { JsonFile, ProtectedStore } from './ai-storage.mjs';
import { apiBinding, sameAPIBinding, cleanNewAPIKey } from './ai-api-draft.mjs';
import { APIAccountPool, PoolError } from './api-account-pool.mjs';
import { AIProviders } from './ai-providers.mjs';
export function requestCeilings(config,options={}){const next={...config};if(Number.isSafeInteger(options.outputTokenCeiling)&&options.outputTokenCeiling>0){next.api_output_token_mode='custom';next.api_max_output_tokens=Math.min(config.api_max_output_tokens,options.outputTokenCeiling);}if(Number.isSafeInteger(options.timeoutCeilingSeconds)&&options.timeoutCeilingSeconds>0)next.timeout_seconds=Math.min(config.timeout_seconds,options.timeoutCeilingSeconds);return next;}

export const POOL_LIMITS = Object.freeze({ concurrency: 1, rpm: 0, tpm: 0, tokens5h: 0, tokens7d: 0 });
export const POOL_DEFAULTS = Object.freeze({ version: 1, enabled: false, mode: 'primary_backup', target: null, ledgerRequired: false,
  routes: [{ id: 'primary', accountId: 'account-1', limits: { ...POOL_LIMITS } }, { id: 'backup', accountId: 'account-2', limits: { ...POOL_LIMITS } }], credentials: {} });
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value) && !/^(?:sk-|Bearer)/i.test(value) && !['__proto__','constructor','prototype'].includes(value);
const targetOf = config => ({ ...apiBinding(config), model: config.api_model });
const matches = (a, b) => sameAPIBinding(a, b) && a.model === b.model;
export class PoolLedger {
  constructor(path) { this.path = path; this.file = new JsonFile(path, null); this.lockPath = path + '.lock'; this.nonce = randomUUID(); this.lockHeld = false; this.acquiring = null; }
  async acquire() {
    if(this.lockHeld)return;
    if(this.acquiring)return this.acquiring;
    this.acquiring=(async()=>{for(let n=0;n<2;n++){let handle;try{handle=await open(this.lockPath,'wx');await handle.writeFile(JSON.stringify({pid:process.pid,nonce:this.nonce}));this.lockHeld=true;return;}catch(error){if(error.code!=='EEXIST')throw new PoolError('pool_ledger_locked');let owner;try{owner=JSON.parse(await readFile(this.lockPath,'utf8'));}catch{throw new PoolError('pool_ledger_locked');}if(!Number.isInteger(owner.pid)||owner.pid<=0)throw new PoolError('pool_ledger_locked');let alive=true;try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}if(alive)throw new PoolError('pool_ledger_locked');await unlink(this.lockPath);}finally{await handle?.close();}}throw new PoolError('pool_ledger_locked');})();
    try{await this.acquiring;}finally{this.acquiring=null;}
  }
  async read() {
    let raw; try { raw = await readFile(this.path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw new PoolError('pool_ledger_invalid'); }
    await this.acquire();
    raw = await readFile(this.path, 'utf8');
    if (Buffer.byteLength(raw) > 8388608) throw new PoolError('pool_ledger_invalid');
    try { return JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new PoolError('pool_ledger_invalid'); }
  }
  async write(value) { await this.acquire(); return this.file.write(value); }
  async close(){await this.file.task.catch(()=>{});if(!this.lockHeld)return;const owner=JSON.parse(await readFile(this.lockPath,'utf8'));if(owner.nonce===this.nonce)await unlink(this.lockPath);this.lockHeld=false;}
}
export function validatePoolConfig(value) {
  if (!value || Object.keys(value).sort().join() !== Object.keys(POOL_DEFAULTS).sort().join() || value.version !== 1 ||
      typeof value.enabled !== 'boolean' || typeof value.ledgerRequired !== 'boolean' || !['primary_backup','round_robin'].includes(value.mode) ||
      !Array.isArray(value.routes) || value.routes.length < 1 || value.routes.length > 10 || !value.credentials || Array.isArray(value.credentials) ||
      Object.keys(value.credentials).length > 100) throw new PoolError('pool_configuration_invalid');
  for (const route of value.routes) if (!identifier(route?.id) || !identifier(route?.accountId)) throw new PoolError('pool_route_invalid');
  new APIAccountPool({ routes: value.routes });
  const validTarget = target => {
    if (!target || Object.keys(target).sort().join() !== ['platform','base_url','format','model'].sort().join() || typeof target.model !== 'string' || !target.model || target.model.length > 160) throw new PoolError('pool_target_mismatch');
    const binding = apiBinding({ api_platform: target.platform, api_base_url: target.base_url, api_format: target.format });
    if (!sameAPIBinding(binding, target)) throw new PoolError('pool_target_mismatch');
  };
  if (value.target) validTarget(value.target);
  if (value.enabled && !value.target) throw new PoolError('pool_target_mismatch');
  for (const [accountId, metadata] of Object.entries(value.credentials)) {
    if (!identifier(accountId) || !metadata || Object.keys(metadata).sort().join() !== ['configured','target'].sort().join() || typeof metadata.configured !== 'boolean') throw new PoolError('pool_configuration_invalid');
    validTarget(metadata.target);
  }
  return structuredClone(value);
}
export class AccountPoolService {
  constructor({ dir, fallback, fetcher = globalThis.fetch, secrets = null, now = Date.now, isBusy = () => false } = {}) {
    this.fallback = fallback; this.fetcher = fetcher; this.now = now; this.isBusy = isBusy;
    this.configFile = new JsonFile(join(dir, 'ai-pool-config.json'), null);
    this.ledger = new PoolLedger(join(dir, 'ai-pool-ledger.json'));
    // Separate file: never reads/copies the existing single-account or Codex credentials.
    this.secrets = secrets || new ProtectedStore(join(dir, 'ai-pool-secrets.dpapi.json'));
    this.config = structuredClone(POOL_DEFAULTS); this.pool = this.buildPool(this.config); this.error = ''; this.changing = false; this.loadFailed = false;
  }
  configured(accountId, config = this.config) { const meta = config.credentials[accountId]; return meta?.configured === true && matches(meta.target, config.target); }
  buildPool(config) {
    const pool = new APIAccountPool({ enabled: config.enabled, mode: config.mode, routes: config.routes, now: this.now, store: this.ledger, storageRequired: config.ledgerRequired });
    pool.routes = pool.routes.filter(r => this.configured(r.accountId, config));
    return pool;
  }
  async initialize() {
    try {
      const saved = await this.configFile.read(); if (saved) this.config = validatePoolConfig(saved);
      this.pool = this.buildPool(this.config); await this.pool.initialize();
    } catch (e) { this.error = e instanceof PoolError ? e.code : 'pool_configuration_invalid'; this.loadFailed = true; }
  }
  state(includeConfig = true) {
    const pool = this.pool.state();
    return { version: 1, enabled: this.config.enabled, mode: this.config.mode, error: this.error || (pool.persistenceError ? 'pool_ledger_unavailable' : ''), changing: this.changing,
      persistent: true, reviewRequired: pool.reviewRequired, persistenceError: pool.persistenceError, recoveredUncertain: pool.recoveredUncertain,
      ...(includeConfig ? { target: this.config.target, routes: this.config.routes.map(r => ({ ...structuredClone(r), keyConfigured: this.configured(r.accountId) })), accounts: pool.accounts, requestsRemembered: pool.requestsRemembered } : {}) };
  }
  assertReady(config) {
    if (this.error || this.pool.persistenceError || !this.pool.initialized) throw new PoolError(this.error || 'pool_ledger_unavailable');
    if (this.changing) throw new PoolError('configuration_busy');
    if (config.backend !== 'api' || !matches(this.config.target, targetOf(config))) throw new PoolError('pool_target_mismatch');
    if (!this.pool.routes.length) throw new PoolError('pool_credentials_required');
    if (this.pool.reviewRequired) throw new PoolError('pool_limit_review_required');
  }
  async mutate(action) {
    if (this.changing || this.isBusy() || [...this.pool.accounts.values()].some(a => a.active)) throw new PoolError('configuration_busy');
    this.changing = true;
    try { return await action(); } finally { this.changing = false; }
  }
  async configure(input, mainConfig) {
    return this.mutate(async () => {
      if (!input || Object.keys(input).sort().join() !== ['enabled','mode','routes'].sort().join() || typeof input.enabled !== 'boolean') throw new PoolError('pool_configuration_invalid');
      if (this.error || this.pool.persistenceError) throw new PoolError(this.error || 'pool_ledger_unavailable');
      const next = validatePoolConfig({ ...this.config, ...input, target: targetOf(mainConfig), ledgerRequired: true });
      if (mainConfig.backend !== 'api' || (next.enabled && !next.routes.some(r => this.configured(r.accountId, next)))) throw new PoolError('pool_credentials_required');
      await this.pool.checkpoint(); // Existing counters/holds survive every config edit.
      const candidate = this.buildPool(next); await candidate.initialize();
      await this.configFile.write(next); this.config = next; this.pool = candidate;
      return this.state();
    });
  }
  async setKey(input, mainConfig) {
    return this.mutate(async () => {
      if (this.config.enabled) throw new PoolError('pool_disable_before_edit');
      if (!input || Object.keys(input).sort().join() !== ['accountId','key'].sort().join() || !this.config.routes.some(r => r.accountId === input.accountId)) throw new PoolError('pool_route_invalid');
      if (this.error || !this.config.target || !matches(this.config.target, targetOf(mainConfig))) throw new PoolError('pool_target_mismatch');
      let key; try { key = cleanNewAPIKey(input.key); } catch { throw new PoolError('invalid_api_key'); }
      const next = structuredClone(this.config);
      next.credentials[input.accountId] = { configured: false, target: next.target };
      await this.configFile.write(next); this.config = next; this.pool.routes = this.pool.routes.filter(r => r.accountId !== input.accountId);
      try {
        await this.secrets.setSession(input.accountId, key ? { key, target: next.target } : null);
        next.credentials[input.accountId].configured = !!key; await this.configFile.write(next);
        this.config = next; const candidate = this.buildPool(next); await candidate.initialize(); this.pool = candidate;
      } finally { key = ''; }
      return this.state();
    });
  }
  async review(input) {
    return this.mutate(async () => {
      if (this.config.enabled) throw new PoolError('pool_disable_before_edit');
      if (!input || input.acknowledged !== true || Object.keys(input).sort().join() !== ['accountId','acknowledged'].sort().join() || !this.pool.accounts.has(input.accountId)) throw new PoolError('pool_review_required');
      const account = this.pool.accounts.get(input.accountId); account.held = '';
      this.pool.reviewRequired = [...this.pool.accounts.values()].some(a => ['quota','unclassified_limit','reservation_exceeded'].includes(a.held));
      await this.pool.checkpoint(); return this.state();
    });
  }
  models(...args) { return this.fallback.models(...args); }
  queueTimeoutSeconds(config){return this.config.enabled&&config.backend==='api'?config.timeout_seconds*this.config.routes.length:config.timeout_seconds;}
  async generate(config, history, prompt, signal, onProgress = () => {}, options = {}) {
    config=requestCeilings(config,options);
    if(this.loadFailed)throw new PoolError(this.error);
    // Images and explicit existing API tests retain their original verified path.
    if (!this.config.enabled || config.backend !== 'api' || options.image || options.testReply || options.key || !options.requestId) return this.fallback.generate(config, history, prompt, signal, onProgress, options);
    try {
      this.assertReady(config);
      // A finite pool reservation requires the same finite output cap on the wire.
      const boundedConfig={...config,api_output_token_mode:'custom'};
      // Conservative UTF-8 byte upper bound + framing allowance + output/reasoning cap.
      const reservationTokens = Buffer.byteLength(JSON.stringify([config.instructions, history, prompt]), 'utf8') + 2048 + config.api_max_output_tokens;
      const result = await this.pool.run({ requestId: options.requestId, reservationTokens, signal,maxAttempts:options.maxModelCalls??10, execute: async (route, context) => {
        const saved = await this.secrets.readSession(route.accountId);
        if (!saved?.key || !matches(saved.target, targetOf(config))) throw new PoolError('pool_credentials_required');
        const provider = new AIProviders({ auth: { readAPIFor: async () => saved.key }, fetcher: this.fetcher });
        try { return await provider.generate(boundedConfig, history, prompt, signal, p => { context.progress(p); try { onProgress(p); } catch {} },{beforeSubmit:options.beforeSubmit,onSubmitted:options.onSubmitted,onNotSubmitted:options.onNotSubmitted}); }
        finally { saved.key = ''; }
      } });
      return result.answer;
    } catch (error) { error.accountPoolHandled = true; throw error; }
  }
  async flush() { await this.pool.writes; await this.configFile.task; await this.ledger.file.task; }
  async close() { try { await this.flush(); } finally { await this.ledger.close(); } }
}

