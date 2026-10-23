import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { AIAuth, SIWC } from './ai-auth.mjs';
import { validateAISettings } from './ai-config.mjs';
import { MemorySecrets, ProtectedStore, windowsProtect } from './ai-storage.mjs';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-auth-mock-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = []; let now = Date.now(), claims = {}, tokenChanges = {}, tokenGate = null, refreshFailure = null;
  let auth;
  const jwt = values => { const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: SIWC.issuer, aud: 'issued_client', sub: 'mock-user', exp: Math.floor(now / 1000) + 3600, nonce: auth.pending?.nonce, ...values })).toString('base64url');
    return header + '.' + body + '.' + sign('sha256', Buffer.from(header + '.' + body), privateKey).toString('base64url'); };
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === SIWC.discovery) return json({ issuer: SIWC.issuer, jwks_uri: SIWC.issuer + '/mock-jwks', revocation_endpoint: SIWC.issuer + '/mock-revoke' });
    if (url === SIWC.issuer + '/mock-jwks') return json({ keys: [jwk] });
    if (url === SIWC.issuer + '/mock-revoke') return new Response('', { status: 200 });
    if (url === SIWC.token) { const form = new URLSearchParams(options.body); if (tokenGate) await tokenGate.promise;
      if (form.get('grant_type') === 'refresh_token' && refreshFailure) return json({ error: refreshFailure }, 400);
      return json({ access_token: 'mock-access', refresh_token: 'mock-refresh-' + calls.length, id_token: jwt(claims), token_type: 'Bearer', expires_in: 3600, scope: SIWC.scopes, ...tokenChanges }); }
    throw new Error('Unexpected mock request');
  };
  auth = new AIAuth({ dir, fetcher, secrets: new MemorySecrets(), now: () => now }); await auth.initialize();
  const start = options => auth.start({ callbackURL: 'http://127.0.0.1:47001/auth/callback', ...options });
  const complete = (params = {}) => { const url = new URL('http://127.0.0.1:47001/auth/callback');
    for (const [k, v] of Object.entries({ state: auth.pending?.state, code: 'mock-code', client_id: 'issued_client', ...params })) url.searchParams.set(k, v);
    return auth.complete(url.href); };
  return { auth, calls, dir, jwt, start, complete, setClaims: v => { claims = v; }, setTokens: v => { tokenChanges = v; }, advance: ms => { now += ms; }, gate: value => { tokenGate = value; }, failRefresh: v => { refreshFailure = v; } };
}
test('new auth starts offline with no files, secret reads or remote traffic', async t => { const f = await fixture(t); assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.dir), []); assert.equal(f.auth.publicState().profiles.length, 0); });
test('PKCE registration uses stable host, exact loopback callback and issued client', async t => {
  const f = await fixture(t); const first = new URL((await f.start()).url); const state = f.auth.pending;
  assert.equal(first.origin + first.pathname, SIWC.authorize); assert.equal(first.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.searchParams.get('scope'), SIWC.scopes); assert.equal(first.searchParams.get('resource'), SIWC.resource);
  assert.equal(first.searchParams.get('code_challenge'), createHash('sha256').update(state.verifier).digest('base64url'));
  assert.equal(first.searchParams.get('code_challenge_method'), 'S256'); assert.match(first.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  const result = await f.complete(); assert.equal(result.plan_authorized, true);
  const form = new URLSearchParams(f.calls.find(c => c.url === SIWC.token).options.body);
  assert.equal(form.get('client_id'), 'issued_client'); assert.equal(form.get('redirect_uri'), state.callbackURL); assert.equal(form.has('client_secret'), false);
  const second = new URL((await f.start({ profileId: result.profile_id, consent: true })).url);
  assert.equal(second.searchParams.get('client_id'), 'issued_client'); assert.equal(second.searchParams.get('agent_name_hint'), null);
  assert.equal(second.searchParams.get('ext_agent_host_id'), first.searchParams.get('ext_agent_host_id')); assert.equal(second.searchParams.get('prompt'), 'consent');
  assert.notEqual(second.searchParams.get('state'), first.searchParams.get('state')); assert.notEqual(second.searchParams.get('nonce'), first.searchParams.get('nonce'));
});
test('callback rejects bad state, duplicate params, wrong address and dynamic client', async t => {
  const f = await fixture(t); await f.start(); await assert.rejects(f.complete({ state: 'wrong' }), /oauth_state_invalid/);
  const base = 'http://127.0.0.1:47001/auth/callback?state=' + f.auth.pending.state;
  await assert.rejects(f.auth.complete(base + '&code=a&code=b&client_id=issued_client'), /oauth_callback_invalid/);
  await assert.rejects(f.auth.complete(base.replace('47001', '47002') + '&code=a'), /invalid_callback/);
  await assert.rejects(f.complete({ client_id: 'dynamic_agent_client' }), /oauth_client_invalid/); assert.equal(f.calls.length, 0);
});
for (const [label, claims] of Object.entries({ nonce: { nonce: 'bad' }, audience: { aud: 'wrong_client' }, issuer: { iss: 'https://example.invalid' }, expiry: { exp: 1 } })) {
  test('ID token rejects wrong ' + label + ' without saving credentials', async t => { const f = await fixture(t); await f.start(); f.setClaims(claims); await assert.rejects(f.complete(), /id_token_claims_invalid/); assert.equal(f.auth.secrets.sessions.size, 0); });
}
test('identity-only grant never becomes plan-authorized', async t => { const f = await fixture(t); await f.start(); f.setTokens({ scope: 'openid profile email' }); const result = await f.complete(); assert.equal(result.plan_authorized, false); await assert.rejects(f.auth.accessToken(result.profile_id), /plan_permission_missing/); });
test('signature tampering fails validation', async t => { const f = await fixture(t); const jwt = f.jwt({ nonce: 'x' }); await assert.rejects(f.auth.validateIDToken(jwt.slice(0, -10) + 'AAAAAAAAAA', 'issued_client', 'x'), /id_token_signature_invalid/); });
test('expired OAuth attempt and cancelled code exchange cannot save a session', async t => {
  const f = await fixture(t); await f.start(); f.advance(600001); await assert.rejects(f.complete(), /oauth_state_invalid/);
  await f.start(); const gate = deferred(); f.gate(gate); const pending = f.complete(); await new Promise(r => setImmediate(r)); f.auth.cancelSignIn(); gate.resolve(); await assert.rejects(pending, /oauth_attempt_cancelled/); assert.equal(f.auth.secrets.sessions.size, 0);
});
test('refresh is single-flight, rotates tokens, omits scope and retains issued client', async t => {
  const f = await fixture(t); await f.start(); const p = await f.complete(); f.advance(3600000); const gate = deferred(); f.gate(gate);
  const tasks = [f.auth.accessToken(p.profile_id), f.auth.accessToken(p.profile_id), f.auth.accessToken(p.profile_id)]; await new Promise(r => setImmediate(r));
  const refresh = f.calls.filter(c => c.url === SIWC.token && new URLSearchParams(c.options.body).get('grant_type') === 'refresh_token'); assert.equal(refresh.length, 1);
  const form = new URLSearchParams(refresh[0].options.body); assert.equal(form.has('scope'), false); assert.equal(form.get('client_id'), 'issued_client'); gate.resolve();
  assert.deepEqual(await Promise.all(tasks), ['mock-access', 'mock-access', 'mock-access']); assert.notEqual((await f.auth.secrets.readSession(p.profile_id)).refresh_token, 'mock-refresh-1');
});
test('refresh honors earliest refresh, terminal failure invalidates only that profile', async t => {
  const f = await fixture(t); await f.start(); f.setTokens({ earliest_refresh_at: Date.now() / 1000 + 7200 }); const p = await f.complete(); f.advance(3600000);
  await assert.rejects(f.auth.accessToken(p.profile_id), /refresh_not_ready/); f.advance(7200000); f.failRefresh('invalid_grant');
  await assert.rejects(f.auth.accessToken(p.profile_id), /invalid_grant/); assert.equal(await f.auth.secrets.readSession(p.profile_id), null);
  assert.equal(f.auth.meta.profiles[0].client_id, 'issued_client'); assert.equal(f.auth.meta.profiles[0].needs_sign_in, true);
});
test('sign out prevents a late refresh restoring tokens and confirms empty revoke 200', async t => {
  const f = await fixture(t); await f.start(); const p = await f.complete(); f.advance(3600000); const gate = deferred(); f.gate(gate);
  const refresh = f.auth.accessToken(p.profile_id); await new Promise(r => setImmediate(r)); const result = await f.auth.signOut(p.profile_id);
  assert.equal(result.remote_revocation_confirmed, true); gate.resolve(); await assert.rejects(refresh, /authorization_required/); assert.equal(await f.auth.secrets.readSession(p.profile_id), null);
});
test('public state and ordinary metadata never contain access, refresh or API keys', async t => {
  const f = await fixture(t); await f.auth.setAPIKey('mock-secret-new-key', {api_base_url:'https://api.openai.com/v1',api_format:'chat_completions'}); await f.start(); await f.complete();
  const state = JSON.stringify(f.auth.publicState()) + await readFile(join(f.dir, 'ai-accounts.json'), 'utf8');
  assert.doesNotMatch(state, /mock-access|mock-refresh|mock-secret-new-key|id_token|code_verifier/);
});
test('protected storage serializes concurrent changes and writes only protected envelopes', async t => {
  const f = await fixture(t); const path = join(f.dir, 'synthetic-encrypted.json'); const transform = async (s, decrypt) => decrypt ? Buffer.from(s, 'base64').toString() : Buffer.from(s).toString('base64');
  const store = new ProtectedStore(path, transform); await Promise.all([store.setAPI('new-test-only'), store.setSession('profile', { access_token: 'new-test-session' })]);
  const raw = await readFile(path, 'utf8'); assert.doesNotMatch(raw, /new-test-only|new-test-session/); const loaded = new ProtectedStore(path, transform);
  assert.equal(await loaded.readAPI(), 'new-test-only'); assert.equal((await loaded.readSession('profile')).access_token, 'new-test-session');
});
test('Windows DPAPI roundtrip preserves generated synthetic Unicode data', { skip: process.platform !== 'win32' }, async () => { const text = '合成测试-不是凭据-' + Date.now(); const encoded = await windowsProtect(text); assert.notEqual(encoded, text); assert.equal(await windowsProtect(encoded, true), text); });


// Release boundary: official OSS dynamic registration is a public entrypoint,
// never a pre-issued account registration copied from another application.
test('release defaults use standard API and carry no preselected OAuth registration',async t=>{
  const f=await fixture(t),example=validateAISettings(JSON.parse(await readFile(new URL('./examples/ai-settings.example.json',import.meta.url),'utf8')));
  assert.equal(example.backend,'api');assert.equal(example.enabled,false);assert.equal(example.active_profile,'');assert.equal(f.auth.pending,null);assert.deepEqual(f.auth.meta.profiles,[]);assert.equal(f.calls.length,0);
});
test('public registration entrypoint is used only before the issuer returns an account-bound client',async t=>{
  const f=await fixture(t),url=new URL((await f.start()).url);assert.equal(url.origin+url.pathname,SIWC.authorize);assert.equal(url.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(url.searchParams.get('agent_name_hint'),'QQ Recall Assistant');assert.match(url.searchParams.get('ext_agent_host_id'),/^urn:uuid:/);assert.equal(f.calls.length,0);assert.equal(f.auth.secrets.sessions.size,0);assert.deepEqual(f.auth.meta.profiles,[]);
});
test('new registration missing its issued client is rejected before any token exchange',async t=>{
  const f=await fixture(t);await f.start();await assert.rejects(f.complete({client_id:''}),/oauth_client_invalid/);assert.equal(f.calls.length,0);assert.equal(f.auth.secrets.sessions.size,0);assert.deepEqual(f.auth.meta.profiles,[]);
});
test('reauthorization cannot replace the selected registration with another callback client',async t=>{
  const f=await fixture(t);await f.start();const saved=await f.complete(),before=structuredClone(f.auth.meta.profiles),calls=f.calls.length;
  const url=new URL((await f.start({profileId:saved.profile_id})).url);assert.equal(url.searchParams.get('client_id'),'issued_client');assert.equal(url.searchParams.has('agent_name_hint'),false);
  await assert.rejects(f.complete({client_id:'synthetic_other_registration'}),/oauth_client_invalid/);assert.equal(f.calls.length,calls);assert.deepEqual(f.auth.meta.profiles,before);assert.equal(f.auth.secrets.sessions.size,1);
});
test('an unknown profile cannot borrow a registration or read another applications account store',async t=>{
  const f=await fixture(t);await assert.rejects(f.start({profileId:'a'.repeat(40)}),/profile_not_found/);assert.equal(f.calls.length,0);assert.equal(f.auth.secrets.sessions.size,0);assert.deepEqual(await readdir(f.dir),[]);
});
