import { createHash, randomBytes, randomUUID, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { JsonFile, ProtectedStore } from './ai-storage.mjs';
import{upstreamFailure}from'./upstream-limit.mjs';
import { apiBinding, sameAPIBinding, cleanNewAPIKey } from './ai-api-draft.mjs';
import { OAuthDiagnostic,oauthResponseMetadata,oauthClientReference,oauthCallbackMetadata } from './oauth-diagnostic.mjs';

export const SIWC = Object.freeze({ issuer: 'https://auth.openai.com', authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token', discovery: 'https://auth.openai.com/.well-known/openid-configuration',
  resource: 'https://api.openai.com/v1', scopes: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
export class AIError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
const publicCodes = new Set(['access_denied','invalid_request','invalid_scope','unauthorized_client','unsupported_response_type','server_error','temporarily_unavailable',
  'authorization_required','invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused',
  'invalid_api_key','insufficient_quota','rate_limit_exceeded','model_not_found','context_length_exceeded','invalid_user','unsupported_capability','route_not_supported',
  'subscription_sharing_user_not_eligible','subscription_sharing_usage_limit_exceeded','subscription_sharing_usage_unavailable','subscription_sharing_user_unavailable',
  'chatpass_v2_scope_not_authorized','invalid_authorization_context']);
export const safeCode = code => publicCodes.has(code) ? code : 'upstream_error';
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const secretString = value => typeof value === 'string' && value.length > 0 && value.length <= 65536 && !/[\r\n\u0000]/.test(value);
const officialURL = value => { const url = new URL(value); if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username || url.password || url.hash) throw new AIError('oidc_endpoint_invalid'); return url.href; };

export async function readJSONResponse(response, limit = 262144, options = {}) {
  const enrich=(error,body=null,shape=null)=>{if(options.oauthDiagnostic)error.oauthDiagnosticMeta=oauthResponseMetadata(response,body,error.code,shape);return error;};
  const reader = response.body?.getReader();
  if (!reader) throw enrich(new AIError('invalid_upstream_response', response.status),null,'empty');
  const chunks = []; let size = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length;
      if (size > limit) { await reader.cancel(); throw enrich(new AIError('upstream_response_too_large', response.status),null,'unavailable'); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    if(!response.ok){const info=upstreamFailure(response,null),error=new AIError(info.code,response.status);error.rateLimitKind=info.rateLimitKind;error.retryAfterSeconds=info.retryAfterSeconds;throw enrich(error,null,size?'non_json':'empty');}
    throw enrich(new AIError('invalid_upstream_response', response.status),null,size?'non_json':'empty');
  }
  if(!response.ok){const info=upstreamFailure(response,body),error=new AIError(info.code,response.status);error.rateLimitKind=info.rateLimitKind;error.retryAfterSeconds=info.retryAfterSeconds;throw enrich(error,body);}
  return body;
}

export class AIAuth {
  constructor({ dir, fetcher = globalThis.fetch, secrets = null, now = Date.now, onChange = () => {} } = {}) {
    this.fetcher = fetcher; this.now = now; this.onChange = onChange;
    this.metaFile = new JsonFile(join(dir, 'ai-accounts.json'), { profiles: [], active: '', api_configured: false, api_id: '' });
    this.hostFile = new JsonFile(join(dir, 'ai-host.json'), { host_id: '' });
    this.oauthDiagnostic = new OAuthDiagnostic(dir, now);
    this.secrets = secrets || new ProtectedStore(join(dir, 'ai-secrets.dpapi.json'));
    this.meta = { profiles: [], active: '', api_configured: false, api_id: '' };
    this.pending = null; this.refreshes = new Map(); this.revisions = new Map(); this.notice = ''; this.discovery = null;
  }
  async initialize() {
    const meta = await this.metaFile.read();
    if (!meta || !Array.isArray(meta.profiles) || meta.profiles.length > 10) throw new AIError('account_metadata_invalid');
    for (const profile of meta.profiles) if (!profile || !/^[a-f0-9]{40}$/.test(profile.id) || typeof profile.client_id !== 'string' || typeof profile.subject !== 'string') throw new AIError('account_metadata_invalid');
    this.meta = meta;
    await this.oauthDiagnostic.initialize();
  }
  publicState() {
    if (this.pending && this.pending.expires <= this.now()) this.pending = null;
    let binding = null;
    try { if (this.meta.api_binding) binding = apiBinding({ api_platform: this.meta.api_binding.platform, api_base_url: this.meta.api_binding.base_url, api_format: this.meta.api_binding.format }); } catch {}
    return { api_configured: this.meta.api_configured === true, api_id: this.meta.api_id || '', api_binding: binding, active: this.meta.active || '',
      oauth_diagnostic: this.oauthDiagnostic.state(), profiles: this.meta.profiles.map(profile => ({ id: profile.id, label: profile.label, plan_authorized: profile.plan_authorized === true,
        needs_sign_in: profile.needs_sign_in === true })), pending_sign_in: !!this.pending, notice: this.notice };
  }
  assertAPIBinding(config) {
    if (!this.meta.api_configured) throw new AIError('api_key_required');
    if (!sameAPIBinding(this.meta.api_binding, apiBinding(config))) throw new AIError('api_credential_target_mismatch');
  }
  async readAPIFor(config) {
    if (this.apiChanging) throw new AIError('configuration_busy');
    this.assertAPIBinding(config);
    const revision = this.apiRevision || 0;
    const key = await this.secrets.readAPI();
    if (this.apiChanging || revision !== (this.apiRevision || 0)) throw new AIError('api_credential_changed');
    this.assertAPIBinding(config);
    if (!key) throw new AIError('api_key_required');
    return key;
  }
  async setAPIKey(key, config) {
    if (this.apiChanging) throw new AIError('configuration_busy');
    try { key = cleanNewAPIKey(key); } catch { throw new AIError('invalid_api_key'); }
    let binding = null;
    if (key) { try { binding = apiBinding(config); } catch { throw new AIError('api_credential_target_required'); } }
    this.apiChanging = true; this.apiRevision = (this.apiRevision || 0) + 1; this.onChange();
    try {
      // Commit a disabled metadata checkpoint before replacing encrypted data.
      // A crash or metadata-write failure cannot associate a new key with an old host.
      this.meta.api_configured = false; this.meta.api_id = ''; this.meta.api_binding = null;
      await this.metaFile.write(this.meta);
      await this.secrets.setAPI(key || null);
      this.meta.api_configured = !!key; this.meta.api_id = key ? randomUUID() : ''; this.meta.api_binding = binding;
      try { await this.metaFile.write(this.meta); }
      catch (error) { this.meta.api_configured = false; this.meta.api_id = ''; this.meta.api_binding = null; throw error; }
    } finally { key = ''; this.apiChanging = false; this.onChange(); }
  }
  async hostId() {
    if (this.hostTask) return this.hostTask;
    this.hostTask = this.loadHostId().catch(error => { this.hostTask = null; throw error; }); return this.hostTask;
  }
  async loadHostId() {
    const saved = await this.hostFile.read();
    if (/^urn:uuid:[0-9a-f-]{36}$/i.test(saved.host_id || '')) return saved.host_id;
    const host_id = 'urn:uuid:' + randomUUID(); await this.hostFile.write({ host_id }); return host_id;
  }
  async start({ callbackURL, profileId = '', consent = false }) {
    const callback = new URL(callbackURL);
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.pathname !== '/auth/callback' || callback.search || callback.hash || callback.username || callback.password) throw new AIError('invalid_callback');
    const profile = profileId ? this.meta.profiles.find(item => item.id === profileId) : null;
    if (profileId && !profile) throw new AIError('profile_not_found');
    if (!profile && this.meta.profiles.length >= 10) throw new AIError('account_limit');
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const hostId = await this.hostId();
    this.pending = { state, nonce, verifier, callbackURL: callback.href,profile: profile ? structuredClone(profile) : null,
      hostId, expires: this.now() + 600000, claimed: false, diagnosticAttemptId:randomUUID() };
    const url = new URL(SIWC.authorize);
    const params = { client_id: profile?.client_id || 'dynamic_agent_client', ext_agent_host_id: hostId,
      response_type: 'code', redirect_uri: callback.href, scope: SIWC.scopes, resource: SIWC.resource,
      state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
    if (!profile) params.agent_name_hint = 'QQ Recall Assistant';
    if (consent && profile) params.prompt = 'consent';
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    this.pending.authorizationRedirectURI=url.searchParams.get('redirect_uri');this.pending.pkceChallenge=url.searchParams.get('code_challenge');
    await this.oauthDiagnostic.beginAttempt(this.pending.diagnosticAttemptId);
    this.notice = ''; return { url: url.href, expires_seconds: 600 };
  }
  cancelSignIn() { this.pending = null; }
  async getDiscovery(force = false) {
    if (!force && this.discovery && this.discovery.expires > this.now()) return this.discovery.value;
    const value = await readJSONResponse(await this.fetcher(SIWC.discovery, { redirect: 'error', signal: AbortSignal.timeout(15000) }));
    if (value.issuer !== SIWC.issuer) throw new AIError('oidc_issuer_invalid');
    officialURL(value.jwks_uri); if (value.revocation_endpoint) officialURL(value.revocation_endpoint);
    this.discovery = { value, expires: this.now() + 3600000 }; return value;
  }
  async validateIDToken(token, clientId, nonce = null, expectedSubject = '') {
    if (!secretString(token)) throw new AIError('id_token_invalid');
    const parts = token.split('.'); if (parts.length !== 3) throw new AIError('id_token_invalid');
    let header, claims; try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw new AIError('id_token_invalid'); }
    if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string' || header.kid.length > 200) throw new AIError('id_token_algorithm_invalid');
    const discovery = await this.getDiscovery();
    const jwks = await readJSONResponse(await this.fetcher(officialURL(discovery.jwks_uri), { redirect: 'error', signal: AbortSignal.timeout(15000) }));
    const matches = Array.isArray(jwks.keys) ? jwks.keys.filter(key => key.kid === header.kid && (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig')) : [];
    if (matches.length !== 1) throw new AIError('id_token_key_invalid');
    let valid = false;
    try { const key = createPublicKey({ key: matches[0], format: 'jwk' });
      valid = verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2], 'base64url'));
    } catch { throw new AIError('id_token_signature_invalid'); }
    if (!valid) throw new AIError('id_token_signature_invalid');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud], now = this.now() / 1000;
    if (claims.iss !== SIWC.issuer || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId) ||
      !Number.isFinite(claims.exp) || claims.exp <= now || (Number.isFinite(claims.nbf) && claims.nbf > now + 60) ||
      (Number.isFinite(claims.iat) && claims.iat > now + 60) || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 300 ||
      (nonce !== null && !equal(claims.nonce, nonce)) || (expectedSubject && claims.sub !== expectedSubject)) throw new AIError('id_token_claims_invalid');
    return claims;
  }
  async tokenRequest(parameters, diagnosticContext=null) {
    const response=await this.fetcher(SIWC.token, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters), signal: AbortSignal.timeout(20000) });
    if(diagnosticContext)Object.assign(diagnosticContext,oauthResponseMetadata(response,null,'','unavailable'));
    const body=await readJSONResponse(response,262144,{oauthDiagnostic:!!diagnosticContext});
    if(diagnosticContext)Object.assign(diagnosticContext,oauthResponseMetadata(response,body));return body;
  }
  credentials(response, prior = null) {
    if (!secretString(response.access_token) || !secretString(response.refresh_token || prior?.refresh_token) ||
      !Number.isFinite(response.expires_in) || response.expires_in < 1 || response.expires_in > 86400 ||
      String(response.token_type || '').toLowerCase() !== 'bearer') throw new AIError('token_response_invalid');
    const scope = typeof response.scope === 'string' ? response.scope : prior?.scope || '';
    const refreshAt = typeof response.earliest_refresh_at === 'number' ? response.earliest_refresh_at * 1000 : Date.parse(response.earliest_refresh_at || '');
    return { ...prior, access_token: response.access_token, refresh_token: response.refresh_token || prior.refresh_token,
      id_token: response.id_token || prior?.id_token, scope, expires_at: this.now() + response.expires_in * 1000,
      earliest_refresh_at: Number.isFinite(refreshAt) ? refreshAt : 0 };
  }
  async complete(callbackURL) {
    const url = new URL(callbackURL), attempt = this.pending;
    const rejectCallback=async(code,context)=>{const error=new AIError(code);await this.oauthDiagnostic.record('callback_validation',error,context);throw error;};
    const stateMatches=!!attempt&&equal(url.searchParams.get('state'),attempt.state);
    if (!attempt || attempt.expires <= this.now() || attempt.claimed || !stateMatches) {
      const reason=!attempt?'no_pending':attempt.expires<=this.now()?'expired':attempt.claimed?'already_claimed':'state_mismatch';
      return rejectCallback('oauth_state_invalid',{attemptId:stateMatches?attempt.diagnosticAttemptId:null,eventKind:reason==='expired'&&stateMatches?'result':'callback_rejection',callbackRejectionReason:reason,csrfValidated:attempt?stateMatches:null});
    }
    for (const key of ['state', 'code', 'client_id', 'error']) if (url.searchParams.getAll(key).length > 1) return rejectCallback('oauth_callback_invalid',{attemptId:attempt.diagnosticAttemptId,eventKind:'callback_rejection',callbackRejectionReason:'duplicate_parameter',csrfValidated:true});
    if (url.origin + url.pathname !== new URL(attempt.callbackURL).origin + '/auth/callback') return rejectCallback('invalid_callback',{attemptId:attempt.diagnosticAttemptId,eventKind:'callback_rejection',callbackRejectionReason:'target_mismatch',csrfValidated:true,callbackTargetMatches:false});
    attempt.claimed = true; let stage = 'callback_validation';
    const diagnosticContext={attemptId:attempt.diagnosticAttemptId,eventKind:'result',tokenEndpoint:'official_siwc_token',requestEncoding:'form_urlencoded',clientKind:'public_dynamic_oss',registrationKind:attempt.profile?'saved_issued':'new_dynamic',csrfValidated:true,callbackTargetMatches:true,redirectUriMatches:null,pkceMethod:'S256',pkceConsistent:null,clientReference:null};
    try {
      if (url.searchParams.has('error')) {const error=new AIError(safeCode(url.searchParams.get('error')));error.oauthDiagnosticMeta=oauthCallbackMetadata(url.searchParams.get('error'));throw error;}
      const clientId = url.searchParams.get('client_id') || attempt.profile?.client_id;
      if (!clientId || clientId === 'dynamic_agent_client' || !/^[a-zA-Z0-9_-]{3,200}$/.test(clientId) ||
        (attempt.profile && clientId !== attempt.profile.client_id)) throw new AIError('oauth_client_invalid');
      diagnosticContext.clientReference=oauthClientReference(clientId);
      const code = url.searchParams.get('code'); if (!secretString(code)) throw new AIError('oauth_code_missing');
      stage = 'token_exchange';
      const parameters={grant_type:'authorization_code',client_id:clientId,code,code_verifier:attempt.verifier,redirect_uri:attempt.callbackURL,resource:SIWC.resource};
      diagnosticContext.redirectUriMatches=parameters.redirect_uri===attempt.authorizationRedirectURI;diagnosticContext.pkceConsistent=createHash('sha256').update(parameters.code_verifier).digest('base64url')===attempt.pkceChallenge;
      const response = await this.tokenRequest(parameters,diagnosticContext);
      if (this.pending !== attempt) throw new AIError('oauth_attempt_cancelled');
      stage = 'id_token_validation';
      const claims = await this.validateIDToken(response.id_token, clientId, attempt.nonce, attempt.profile?.subject || '');
      stage = 'credential_validation';
      const credentials = this.credentials(response);
      if (this.pending !== attempt) throw new AIError('oauth_attempt_cancelled');
      const profileId = createHash('sha256').update(SIWC.issuer + '\0' + claims.sub + '\0' + clientId).digest('hex').slice(0, 40);
      const granted = new Set(credentials.scope.split(/\s+/));
      const profile = { id: profileId, client_id: clientId, subject: claims.sub,
        label: String(claims.email || 'ChatGPT账户').slice(0, 120) + ' · ' + profileId.slice(0, 6),
        plan_authorized: granted.has('chatgpt.tokens.use.direct') && granted.has('resource.invoke'), needs_sign_in: false };
      this.revisions.set(profileId, (this.revisions.get(profileId) || 0) + 1);
      this.onChange();
      stage = 'session_save';
      await this.secrets.setSession(profileId, { ...credentials, subject: claims.sub, client_id: clientId });
      if (this.pending !== attempt) { await this.secrets.setSession(profileId, null); throw new AIError('oauth_attempt_cancelled'); }
      this.meta.profiles = this.meta.profiles.filter(item => item.id !== profileId); this.meta.profiles.push(profile);
      this.meta.active = profileId; await this.metaFile.write(this.meta);
      this.notice = profile.plan_authorized ? 'ChatGPT授权已保存；AI仍需单独开启。' : '身份已登录，但未获得套餐推理权限。';
      await this.oauthDiagnostic.record('completed',null,diagnosticContext);
      this.onChange(); return { profile_id: profileId, plan_authorized: profile.plan_authorized };
    } catch (error) { await this.oauthDiagnostic.record(stage,error,diagnosticContext); throw error; }
    finally { if (this.pending === attempt) this.pending = null; }
  }
  async invalidate(id) {
    this.revisions.set(id, (this.revisions.get(id) || 0) + 1);
    await this.secrets.setSession(id, null);
    const profile = this.meta.profiles.find(item => item.id === id); if (profile) profile.needs_sign_in = true;
    await this.metaFile.write(this.meta); this.onChange();
  }
  async accessToken(id) {
    const revision = this.revisions.get(id) || 0;
    const profile = this.meta.profiles.find(item => item.id === id);
    if (!profile || profile.needs_sign_in) throw new AIError('authorization_required', 401);
    if (!profile.plan_authorized) throw new AIError('plan_permission_missing', 403);
    const session = await this.secrets.readSession(id);
    if ((this.revisions.get(id) || 0) !== revision || profile.needs_sign_in) throw new AIError('authorization_required', 401);
    if (!session) throw new AIError('authorization_required', 401);
    if (session.expires_at > this.now() + 60000) return session.access_token;
    if (session.earliest_refresh_at > this.now()) throw new AIError('refresh_not_ready');
    if (!this.refreshes.has(id)) {
      const task = (async () => {
        try {
          const response = await this.tokenRequest({ grant_type: 'refresh_token', client_id: profile.client_id,
            refresh_token: session.refresh_token, resource: SIWC.resource });
          if (response.id_token) await this.validateIDToken(response.id_token, profile.client_id, null, profile.subject);
          const updated = this.credentials(response, session), scopes = new Set(updated.scope.split(/\s+/));
          if (!scopes.has('chatgpt.tokens.use.direct') || !scopes.has('resource.invoke')) throw new AIError('plan_permission_missing', 403);
          if ((this.revisions.get(id) || 0) !== revision) throw new AIError('authorization_required', 401);
          await this.secrets.setSession(id, updated);
          if ((this.revisions.get(id) || 0) !== revision) { await this.secrets.setSession(id, null); throw new AIError('authorization_required', 401); }
          return updated.access_token;
        } catch (error) {
          if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error.code)) await this.invalidate(id);
          throw error;
        }
      })().finally(() => this.refreshes.delete(id));
      this.refreshes.set(id, task);
    }
    return this.refreshes.get(id);
  }
  async signOut(id) {
    const profile = this.meta.profiles.find(item => item.id === id);
    if (!profile) throw new AIError('profile_not_found');
    profile.needs_sign_in = true; this.revisions.set(id, (this.revisions.get(id) || 0) + 1); this.onChange();
    const session = await this.secrets.readSession(id); let confirmed = !session;
    if (session?.refresh_token) {
      try {
        const discovery = await this.getDiscovery(); if (!discovery.revocation_endpoint) throw new AIError('revocation_unavailable');
        const response = await this.fetcher(officialURL(discovery.revocation_endpoint), { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: session.refresh_token,
            token_type_hint: 'refresh_token', client_id: profile.client_id }), signal: AbortSignal.timeout(15000) });
        confirmed = response.status === 200; await response.body?.cancel();
      } catch { confirmed = false; }
    }
    await this.invalidate(id);
    this.notice = confirmed ? '已退出并确认结束可续期会话。' : '本地已退出，远端撤销未确认；可在ChatGPT设置中断开此应用。';
    return { remote_revocation_confirmed: confirmed };
  }
}
