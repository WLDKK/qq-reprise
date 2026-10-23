import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIChat } from './ai-chat.mjs';
import { AI_DEFAULTS } from './ai-config.mjs';
import { apiBinding } from './ai-api-draft.mjs';
import { MemorySecrets } from './ai-storage.mjs';
import { ResendQueue } from './send-queue.mjs';
import { startApp } from './qq-recall.mjs';

const target = { api_platform: 'intern_discovery', api_base_url: 'https://discovery-api.intern-ai.org.cn/v1', api_format: 'chat_completions', api_model: 'deepseek-v4-flash-0731', api_max_output_tokens: 1536, timeout_seconds: 42 };
const old = { ...structuredClone(AI_DEFAULTS), api_platform: 'cmecloud', api_base_url: 'https://zhenze-huhehaote.cmecloud.cn/v1', api_model: 'DeepSeek-V4-Flash' };
const request = () => ({ target: { ...target }, credential: { source: 'new', key: 'synthetic-intern-new-key' } });
const stream = events => new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const ok = text => stream([{ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }]);
async function setup(t, fetcher = async () => ok('OK')) {
  const dir = await mkdtemp(join(tmpdir(), 'api-draft-mock-')), calls = [], secrets = new MemorySecrets();
  let secretReads = 0, secretWrites = 0;
  const originalRead = secrets.readAPI.bind(secrets), originalSet = secrets.setAPI.bind(secrets);
  secrets.readAPI = async () => { secretReads++; return originalRead(); };
  secrets.setAPI = async key => { secretWrites++; return originalSet(key); };
  secrets.api = 'synthetic-old-cme-key';
  const app = { connected: true, onlineConfirmed: true, selfId: '90001', sendQueue: new ResendQueue({ intervalMs: 0, jitterMs: 0 }), client: { call() { assert.fail('Draft operations must never send QQ'); } } };
  const ai = new AIChat({ dir, app, secrets, fetcher: async (...args) => { calls.push(args); return fetcher(...args); } });
  await ai.initialize(); ai.config = structuredClone(old); ai.auth.meta.api_configured = true; ai.auth.meta.api_binding = apiBinding(old);
  t.after(async () => { ai.dispose(); await ai.budgetTask.catch(() => {}); await ai.settingsFile.task.catch(() => {}); await ai.auth.metaFile.task.catch(() => {}); await ai.diagnostics.file.task.catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  return { ai, app, dir, secrets, calls, secretReads: () => secretReads, secretWrites: () => secretWrites };
}
test('unsaved test uses the exact draft platform, endpoint, model, format and new key without reading or saving old credentials', async t => {
  const f = await setup(t), before = structuredClone(f.ai.config), body = request();
  const result = await f.ai.testAPI(body), [url, options] = f.calls[0], posted = JSON.parse(options.body);
  assert.equal(url, target.api_base_url + '/chat/completions'); assert.equal(options.headers.Authorization, 'Bearer synthetic-intern-new-key');
  assert.equal(posted.model, target.api_model); assert.equal(posted.max_tokens, target.api_max_output_tokens); assert.equal(posted.stream, true); assert.equal(posted.messages.at(-1).content, 'Reply exactly OK.'); assert.equal(posted.messages.length, 2);
  assert.equal(result.target.platform, 'intern_discovery'); assert.equal(result.target.timeout_seconds, 42); assert.equal(result.reply, 'OK'); assert.equal(result.http_status, 200); assert.equal(result.phase, 'completed'); assert.equal(result.saved, false); assert.equal(result.qq_messages, 0);
  assert.deepEqual(f.ai.config, before); assert.equal(f.secretReads(), 0); assert.equal(f.secretWrites(), 0); assert.equal(f.ai.sessions.size, 0); assert.equal(f.ai.jobs.size, 0); assert.equal(f.ai.outbox.snapshot().pending, 0);
  assert.deepEqual((await readdir(f.dir)).sort(), ['ai-diagnostics.json', 'ai-usage.json']);
  for (const name of await readdir(f.dir)) assert.doesNotMatch(await readFile(join(f.dir, name), 'utf8'), /synthetic-intern-new-key|synthetic-old-cme-key/);
});
for (const [name, change] of Object.entries({ host: { api_base_url: 'https://other.invalid/v1' }, port: { api_base_url: 'https://zhenze-huhehaote.cmecloud.cn:444/v1' }, path: { api_base_url: 'https://zhenze-huhehaote.cmecloud.cn/other/v1' }, protocol: { api_format: 'responses' }, platform: { api_platform: 'custom' } })) {
  test('saved credential cannot cross ' + name + ' before any secret read or external request', async t => {
    const f = await setup(t), config = { ...old, ...change }, body = { target: Object.fromEntries(Object.keys(target).map(k => [k, config[k]])), credential: { source: 'saved' } };
    await assert.rejects(f.ai.testAPI(body), /api_credential_target_mismatch/);
    await assert.rejects(f.ai.provider.models(config), /api_credential_target_mismatch/);
    await assert.rejects(f.ai.configure({ ...config, enabled: true }), /api_credential_target_mismatch/);
    assert.equal(f.secretReads(), 0); assert.equal(f.calls.length, 0);
  });
}
test('unscoped legacy credentials are retained but cannot be silently bound or used', async t => {
  const f = await setup(t); delete f.ai.auth.meta.api_binding;
  await assert.rejects(f.ai.testAPI(), /api_credential_target_mismatch/);
  assert.equal(f.ai.auth.publicState().api_binding, null); assert.equal(f.secrets.api, 'synthetic-old-cme-key'); assert.equal(f.secretReads(), 0); assert.equal(f.secretWrites(), 0); assert.equal(f.calls.length, 0);
});
test('explicit same-target saved credential is allowed; missing selection is rejected', async t => {
  const f = await setup(t); const body = { target: Object.fromEntries(Object.keys(target).map(k => [k, old[k]])), credential: { source: 'saved' } };
  await assert.rejects(f.ai.testAPI({ target: body.target }), /api_credential_selection_required/);
  assert.equal(f.calls.length, 0); const result = await f.ai.testAPI(body); assert.equal(result.ok, true); assert.equal(f.secretReads(), 1); assert.equal(f.calls[0][1].headers.Authorization, 'Bearer synthetic-old-cme-key'); assert.equal(f.secretWrites(), 0);
});
test('save is explicit, binds the new credential and remains disabled until a separate enable action', async t => {
  const f = await setup(t); f.ai.config.enabled = true;
  await f.ai.saveAPIDraft({ settings: { ...old, ...target, enabled: true }, credential: request().credential });
  assert.equal(f.ai.config.enabled, false); assert.equal(f.secretWrites(), 1); assert.equal(f.calls.length, 0); assert.deepEqual(f.ai.auth.meta.api_binding, apiBinding(f.ai.config)); assert.equal(f.secrets.api, 'synthetic-intern-new-key');
  await f.ai.configure({ ...f.ai.config, enabled: true }); assert.equal(f.ai.config.enabled, true); assert.equal(f.calls.length, 0);
  const state = JSON.stringify(f.ai.state()); assert.doesNotMatch(state, /synthetic-intern-new-key|synthetic-old-cme-key/);
});
test('a failed save leaves AI disabled and prevents the new credential from being sent to the old target', async t => {
  const f = await setup(t); f.ai.config.enabled = true;
  const write = f.ai.settingsFile.write.bind(f.ai.settingsFile); let writes = 0;
  f.ai.settingsFile.write = async value => { if (++writes === 2) throw new Error('synthetic disk failure'); return write(value); };
  await assert.rejects(f.ai.saveAPIDraft({ settings: { ...old, ...target }, credential: request().credential }), /settings_save_failed/);
  assert.equal(f.ai.config.enabled, false); await assert.rejects(f.ai.provider.models(old), /api_credential_target_mismatch/); assert.equal(f.calls.length, 0);
});
test('partial replies and HTTP/network errors are returned as structured test evidence without saving body text', async t => {
  const f = await setup(t, async () => stream([{ choices: [{ index: 0, delta: { content: 'synthetic partial reply' } }] }]));
  await assert.rejects(f.ai.testAPI(request()), error => { const r = error.testResult; assert.equal(r.http_status, 200); assert.equal(r.error_code, 'stream_interrupted'); assert.equal(r.reply, 'synthetic partial reply'); assert.equal(r.reply_complete, false); assert.equal(r.phase, 'streaming'); return true; });
  assert.doesNotMatch(await readFile(f.ai.diagnostics.file.path, 'utf8'), /synthetic partial|synthetic-intern/);
});
test('even an upstream echo of the draft key is removed from displayed test replies', async t => {
  const f = await setup(t, async () => ok('synthetic-intern-new-key')); const r = await f.ai.testAPI(request()); assert.equal(r.reply, '[密钥已遮蔽]'); assert.doesNotMatch(JSON.stringify(r), /synthetic-intern-new-key/);
});
test('incomplete draft cannot silently inherit the old host or protocol', async t => {
  const f = await setup(t);
  await assert.rejects(f.ai.testAPI({ target: { api_model: target.api_model }, credential: request().credential }), /api_draft_required/);
  assert.equal(f.calls.length, 0); assert.equal(f.secretReads(), 0);
});
test('credential rotation cancels a pending saved-key lookup before it can escape to another host', async t => {
  const f = await setup(t); let resolve;
  f.secrets.readAPI = () => new Promise(r => { resolve = r; });
  const pending = f.ai.auth.readAPIFor(old); const rejected = assert.rejects(pending, /api_credential_changed/);
  await f.ai.auth.setAPIKey('synthetic-intern-new-key', { ...old, ...target });
  resolve('synthetic-intern-new-key'); await rejected; assert.equal(f.calls.length, 0);
});
test('metadata commit failure cannot leave a new key associated with the previous host after restart', async t => {
  const f = await setup(t), write = f.ai.auth.metaFile.write.bind(f.ai.auth.metaFile); let n = 0;
  f.ai.auth.metaFile.write = async value => { if (++n === 2) throw new Error('synthetic metadata disk failure'); return write(value); };
  await assert.rejects(f.ai.auth.setAPIKey('synthetic-intern-new-key', { ...old, ...target }), /metadata disk failure/);
  const disk = JSON.parse(await readFile(f.ai.auth.metaFile.path, 'utf8')); assert.equal(disk.api_configured, false); assert.equal(disk.api_binding, null);
  assert.equal(f.ai.auth.meta.api_configured, false); await assert.rejects(f.ai.auth.readAPIFor(old), /api_key_required/); assert.equal(f.calls.length, 0);
});
test('models discovery uses the unsaved target and key without saving or enabling', async t => {
  const f = await setup(t, async () => new Response(JSON.stringify({ data: [{ id: 'glm-5.3' }] }), { headers: { 'Content-Type': 'application/json' } }));
  assert.deepEqual(await f.ai.draftModels(request()), [{ id: 'glm-5.3', name: 'glm-5.3' }]); assert.equal(f.calls[0][0], target.api_base_url + '/models'); assert.equal(f.secretReads(), 0); assert.equal(f.secretWrites(), 0); assert.equal(f.ai.config.enabled, false);
});
test('HTTP route requires a draft and returns safe HTTP401 detail without exposing raw platform text', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'api-draft-route-')), secrets = new MemorySecrets(); let calls = 0; const logs = [];
  const running = await startApp({ configPath: join(dir, 'config.json'), discover: async () => [], logger: (...args) => logs.push(args), aiSecrets: secrets, aiFetcher: async () => { calls++; return new Response('Bearer synthetic-intern-new-key private vendor details', { status: 401 }); } });
  t.after(async () => { await running.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { 'X-QQ-Recall-Session': running.app.session, 'Content-Type': 'application/json', Origin: running.url.slice(0, -1) };
  const send = (path, body) => fetch(running.url + path, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await send('api/ai/test-api', {})).status, 400); assert.equal(calls, 0);
  const r = await send('api/ai/test-api', request()), data = await r.json(); assert.equal(r.status, 200); assert.equal(data.ok, false); assert.equal(data.http_status, 401); assert.equal(data.error_code, 'authorization_required'); assert.equal(data.phase, 'http_response'); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(data), /synthetic-intern-new-key|private vendor/);
  assert.equal(running.app.ai.config.enabled, false); assert.equal(await secrets.readAPI(), null); assert.doesNotMatch(JSON.stringify(logs), /synthetic-intern-new-key|private vendor/);
  assert.equal((await send('api/ai/key', { key: 'synthetic-block-unbound-save' })).status, 400);
});
