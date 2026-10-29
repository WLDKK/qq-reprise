// AI model/model-list requests only. Never replace a process-global agent/fetch.
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { join } from 'node:path';
import { JsonFile } from './ai-storage.mjs';
import { AIError } from './ai-auth.mjs';

export const NETWORK_DEFAULTS = Object.freeze({ version: 1, mode: 'legacy', proxy_url: '' });
export const NETWORK_ERRORS = ['ai_network_invalid','ai_network_busy','ai_network_runtime_unsupported','ai_network_load_failed','ai_network_save_failed','proxy_credentials_not_supported','proxy_protocol_unsupported','proxy_environment_missing','proxy_connection_failed','proxy_authentication_required','network_encoding_unsupported','network_access_denied'];
const fail = code => { throw new AIError(code); };
export function proxyURL(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\x00-\x1f\x7f]/.test(value)) fail('ai_network_invalid');
  let u; try { u = new URL(value); } catch { fail('ai_network_invalid'); }
  // Never echo or persist inline proxy credentials. An authenticated local proxy
  // client can expose a separate unauthenticated loopback HTTP/Mixed listener.
  if (u.username || u.password) fail('proxy_credentials_not_supported');
  if (!['http:','https:'].includes(u.protocol)) fail('proxy_protocol_unsupported');
  if (u.search || u.hash || u.pathname !== '/' || !u.hostname) fail('ai_network_invalid');
  return u.origin;
}
export function validateNetwork(value = NETWORK_DEFAULTS) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['version','mode','proxy_url'].includes(k)) || value.version !== undefined && value.version !== 1 || !['legacy','direct','environment','manual'].includes(value.mode)) fail('ai_network_invalid');
  const proxy = value.proxy_url ?? '';
  if (typeof proxy !== 'string') fail('ai_network_invalid');
  return { version: 1, mode: value.mode, proxy_url: proxy ? proxyURL(proxy) : value.mode === 'manual' ? fail('ai_network_invalid') : '' };
}
export const localTarget = hostname => /^(?:localhost|\[?::1\]?|127(?:\.\d{1,3}){3})$/i.test(hostname);
export function environmentProxy(env) {
  const values = {};
  for (const [upper, lower] of [['HTTP_PROXY','http_proxy'],['HTTPS_PROXY','https_proxy']]) {
    const value = env[lower] ?? env[upper];
    if (value) values[lower] = proxyURL(value);
  }
  if (!values.http_proxy && !values.https_proxy) fail('proxy_environment_missing');
  if(!values.https_proxy&&values.http_proxy)values.https_proxy=values.http_proxy;
  const bypass = env.no_proxy ?? env.NO_PROXY ?? '';
  if (typeof bypass !== 'string' || bypass.length > 8192 || /[\r\n\x00]/.test(bypass)) fail('ai_network_invalid');
  values.no_proxy = [bypass,'localhost','127.0.0.1','::1','[::1]'].filter(Boolean).join(',');
  return values;
}
export function networkFailure(error, signal) {
  if (signal?.aborted) return signal.reason || new AIError('cancelled_or_timeout');
  if (error instanceof AIError) return error;
  const code = error?.cause?.code || error?.code;
  const known = { EACCES:'network_access_denied', EPERM:'network_access_denied', ECONNREFUSED:'network_connection_refused', ENOTFOUND:'network_dns_error', EAI_AGAIN:'network_dns_error', ECONNRESET:'network_connection_lost', ERR_STREAM_PREMATURE_CLOSE:'network_connection_lost', ETIMEDOUT:'network_timeout', CERT_HAS_EXPIRED:'tls_verification_failed', ERR_TLS_CERT_ALTNAME_INVALID:'tls_verification_failed', UNABLE_TO_VERIFY_LEAF_SIGNATURE:'tls_verification_failed', UNABLE_TO_GET_ISSUER_CERT_LOCALLY:'tls_verification_failed', DEPTH_ZERO_SELF_SIGNED_CERT:'tls_verification_failed' };
  if (known[code]) return new AIError(known[code]);
  if (/407/.test(String(error?.message || ''))) return new AIError('proxy_authentication_required');
  return new AIError(String(code||'').startsWith('ERR_HTTP_PROXY')?'proxy_connection_failed':'network_or_provider_error');
}

export class AINetwork {
  constructor({ dir, fetcher = globalThis.fetch, isBusy = () => false, environment = () => ({ HTTP_PROXY:process.env.HTTP_PROXY, HTTPS_PROXY:process.env.HTTPS_PROXY, NO_PROXY:process.env.NO_PROXY, http_proxy:process.env.http_proxy, https_proxy:process.env.https_proxy, no_proxy:process.env.no_proxy }), runtime = process.versions.node, request = (u,o,cb) => (u.protocol === 'https:' ? https : http).request(u,o,cb), agent = (secure,o) => new (secure ? https.Agent : http.Agent)(o) } = {}) {
    Object.assign(this,{ fetcher,isBusy,environment,runtime,request,agent });
    this.file = new JsonFile(join(dir,'ai-network.json'),NETWORK_DEFAULTS); this.config = { ...NETWORK_DEFAULTS }; this.error = ''; this.active = 0; this.saving = false; this.pending = new Set();
    this.fetch = this.fetch.bind(this);
  }
  async initialize() { try { this.config = validateNetwork(await this.file.read()); } catch { this.error = 'ai_network_load_failed'; } }
  state(includeConfig = true) { return { version:1, mode:this.config.mode, error:this.error, active_requests:this.active, protocols:['http','https'], authenticated_proxy:false, scope:'ai_model_and_models_only', ...(includeConfig ? { config:{ ...this.config } } : {}) }; }
  supported() { const [major,minor] = this.runtime.split('.').map(Number); return major > 24 || major === 24 && minor >= 14; }
  async configure(value) {
    const next = validateNetwork(value);
    if (this.saving || this.active || this.isBusy()) fail('ai_network_busy');
    if (next.mode !== 'legacy' && !this.supported()) fail('ai_network_runtime_unsupported');
    this.saving = true;
    try { await this.file.write(next); this.config = next; this.error = ''; }
    catch { fail('ai_network_save_failed'); }
    finally { this.saving = false; }
    return this.state();
  }
  async fetch(input, options = {}) {
    const { aiNetwork, ...init } = options;
    if (this.saving) fail('ai_network_busy');
    if (this.error && aiNetwork === undefined) fail(this.error);
    const config = validateNetwork(aiNetwork ?? this.config);
    if (config.mode === 'legacy') return this.fetcher(input,init);
    if (!this.supported()) fail('ai_network_runtime_unsupported');
    let url; try { url = new URL(input); } catch { fail('ai_network_invalid'); }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) fail('ai_network_invalid');
    // Loopback stays direct even when a custom NO_PROXY omits it. QQ/NapCat do
    // not use this wrapper at all. Environment values are read only on opt-in.
    const proxyEnv = localTarget(url.hostname) || config.mode === 'direct' ? {} : config.mode === 'environment' ? environmentProxy(this.environment()) : { http_proxy:config.proxy_url, https_proxy:config.proxy_url, no_proxy:'localhost,127.0.0.1,::1,[::1]' };
    const agent = this.agent(url.protocol === 'https:',{ keepAlive:false, proxyEnv });
    const signal = init.signal;
    if (signal?.aborted) { agent.destroy(); throw signal.reason; }
    this.active++;
    return new Promise((resolve,reject) => {
      let response, stream, settled = false, released = false;
      const release = () => { if (released) return; released = true; this.active--; this.pending.delete(abort); signal?.removeEventListener('abort',abort); agent.destroy(); };
      const abort = () => { const e = signal?.reason || new AIError('cancelled_or_timeout'); request?.destroy(e); stream?.destroy(e); if (!settled) { settled = true; reject(e); } release(); };
      const failRequest = e => { const safe = networkFailure(e,signal); if (!settled) { settled = true; reject(safe); } else stream?.destroy(safe); release(); };
      let request;
      try {
        const headers = new Headers(init.headers); headers.set('accept-encoding','gzip, deflate, br');
        request = this.request(url,{ method:init.method || 'GET', headers:Object.fromEntries(headers), agent },incoming => {
          response = incoming;
          try {
            const headers = new Headers(); for (let i=0;i<incoming.rawHeaders.length;i+=2) headers.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
            const encoding = (headers.get('content-encoding') || '').toLowerCase();
            stream = incoming;
            if (encoding && encoding !== 'identity') {
              const decoder = { gzip:createGunzip, deflate:createInflate, br:createBrotliDecompress }[encoding];
              if (!decoder) fail('network_encoding_unsupported');
              stream = incoming.pipe(decoder()); headers.delete('content-encoding'); headers.delete('content-length'); incoming.on('error',e => stream.destroy(networkFailure(e,signal)));
            }
            incoming.once('error',failRequest); stream.once('error',failRequest); stream.once('end',release); stream.once('close',() => { incoming.destroy(); release(); });
            const noBody = init.method === 'HEAD' || [204,205,304].includes(incoming.statusCode);
            const result = new Response(noBody ? null : Readable.toWeb(stream),{ status:incoming.statusCode, headers });
            settled = true; resolve(result); if (noBody) { incoming.resume(); }
          } catch (error) { incoming.destroy(); failRequest(error); }
        });
        request.once('error',failRequest); this.pending.add(abort); signal?.addEventListener('abort',abort,{once:true});
        if (signal?.aborted) return abort();
        request.end(init.body);
      } catch (error) { response?.destroy(); failRequest(error); }
    });
  }
  dispose() { for (const cancel of [...this.pending]) cancel(); }
}
