import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProviders, publicAIError } from './ai-providers.mjs';
import { AI_DEFAULTS, validateAISettings } from './ai-config.mjs';
import { AIError, SIWC } from './ai-auth.mjs';
const response = events => new Response(events.map(e => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const delta = text => ({ type: 'response.output_text.delta', delta: text });
const complete = { type: 'response.completed', response: { status: 'completed' } };
function setup(events, changes = {}) {
  const calls = [], auth = { readAPIFor: async () => 'mock-api-key', accessToken: async id => { assert.equal(id, 'profile'); return 'mock-oauth-token'; } };
  const provider = new AIProviders({ auth, fetcher: async (url, options) => { calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null }); return typeof events === 'function' ? events() : response(events); } });
  return { provider, calls, config: { ...structuredClone(AI_DEFAULTS), api_model: 'mock-model', siwc_model: 'mock-plan-model', active_profile: 'profile', ...changes } };
}
test('ChatGPT sends direct public Responses with arrays, store false, streaming and no unsupported fields', async () => {
  const f = setup([delta('完成'), complete], { backend: 'chatgpt' }); assert.equal(await f.provider.generate(f.config, [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'prior' }], 'new', new AbortController().signal), '完成');
  const call = f.calls[0]; assert.equal(call.url, SIWC.resource + '/responses'); assert.equal(call.options.headers.Authorization, 'Bearer mock-oauth-token');
  assert.equal(call.body.store, false); assert.equal(call.body.stream, true); assert.equal(call.body.input.length, 3);
  assert.deepEqual(Object.keys(call.body).sort(), ['model', 'store', 'stream', 'instructions', 'input'].sort());
  assert.equal(call.body.input.some(x => x.role === 'system'), false);
});
test('ordinary API Responses uses API token and configured token cap', async () => { const f = setup([delta('ok'), complete], { api_format: 'responses' }); await f.provider.generate(f.config, [], 'new'); assert.equal(f.calls[0].body.max_output_tokens, 512); assert.equal(f.calls[0].options.headers.Authorization, 'Bearer mock-api-key'); });
test('Chat Completions finishes only on stop and sends configured system instructions', async () => {
  const f = setup([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
  assert.equal(await f.provider.generate(f.config, [], 'new'), 'ok'); assert.equal(f.calls[0].body.messages[0].role, 'system'); assert.equal(f.calls[0].body.max_tokens, 512);
});
for (const [name, events] of Object.entries({ interrupted: [delta('partial')], incomplete: [delta('partial'), { type: 'response.incomplete' }], quota: [delta('partial'), { type: 'error', error: { code: 'subscription_sharing_usage_limit_exceeded' } }] })) {
  test('no partial output on ' + name, async () => { const f = setup(events, { backend: 'chatgpt' }); await assert.rejects(f.provider.generate(f.config, [], 'new')); assert.equal(f.calls.length, 1); });
}
test('tool call or length-truncated Chat Completions never becomes a reply', async () => {
  for (const event of [{ choices: [{ delta: { tool_calls: [{}] } }] }, { choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }]) {
    const f = setup([event]); await assert.rejects(f.provider.generate(f.config, [], 'new')); }
});
test('character cap fails closed and missing credentials never calls remote', async () => {
  const f = setup([delta('x'.repeat(101)), complete], { backend: 'chatgpt', output_chars: 100 }); await assert.rejects(f.provider.generate(f.config, [], 'new'), /output_character_limit/);
  f.provider.auth.readAPIFor = async () => null; const n = f.calls.length; await assert.rejects(f.provider.generate({ ...f.config, backend: 'api' }, [], 'new'), /api_key_required/); assert.equal(f.calls.length, n);
});
test('stream parser handles split CRLF and UTF8 bytes', async () => {
  const bytes = new TextEncoder().encode('data: ' + JSON.stringify(delta('你好')) + '\r\n\r\ndata: ' + JSON.stringify(complete) + '\r\n\r\n');
  const f = setup(() => new Response(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }), { backend: 'chatgpt' });
  assert.equal(await f.provider.generate(f.config, [], 'new'), '你好');
});
test('SSE errors after deltas and HTTP200 non-SSE cannot be mistaken for success', async () => {
  const f = setup(() => new Response(JSON.stringify({ output: 'not-completed' }), { headers: { 'Content-Type': 'application/json' } }), { backend: 'chatgpt' }); await assert.rejects(f.provider.generate(f.config, [], 'new'), /stream_required/);
});
test('provider errors expose only safe codes and never raw upstream details', async () => {
  const f = setup(() => new Response(JSON.stringify({ error: { code: 'subscription_sharing_user_not_eligible', message: 'secret-private-detail' } }), { status: 403 }), { backend: 'chatgpt' });
  try { await f.provider.generate(f.config, [], 'new'); assert.fail(); } catch (error) { assert.equal(error.status, 403); assert.equal(publicAIError(error), 'subscription_sharing_user_not_eligible'); assert.doesNotMatch(error.message, /secret-private/); }
  assert.equal(publicAIError(new Error('Bearer secret')), 'network_or_provider_error'); assert.equal(publicAIError(new AIError('quota')), 'quota');
});
test('model catalog uses backend credential and preserves visible SIWC server ordering', async () => {
  const f = setup(() => new Response(JSON.stringify({ models: [{ slug: 'b', display_name: 'B', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }, { slug: 'a', visibility: 'list' }] })), { backend: 'chatgpt' });
  assert.deepEqual(await f.provider.models(f.config), [{ id: 'b', name: 'B' }, { id: 'a', name: 'a' }]); assert.equal(f.calls[0].url, SIWC.resource + '/models');
});
test('config validation is bounded, default-off and rejects credential URLs or unknown fields', () => {
  assert.equal(validateAISettings({}).enabled, false);assert.equal(validateAISettings({concurrency:4,context_turns:21}).context_turns,21);
  for (const bad of [{ concurrency: 0 }, { context_turns: -1 }, {concurrency:Infinity}, {context_turns:1.5}, { groups: ['all'] }, { users: ['123'] }, { api_base_url: 'http://public.invalid/v1' }, { api_base_url: 'https://user:password@example.invalid' }, { api_key: 'x' }, { backend: 'unknown' }]) assert.throws(() => validateAISettings(bad));
  assert.deepEqual(validateAISettings({ groups: '12345, 67890 12345' }).groups, ['12345', '67890']);
});
test('timeout includes credential refresh wait and aborted stream cannot return partial text', async () => {
  const f = setup([delta('partial')], { backend: 'chatgpt', timeout_seconds: 0.01 }); f.provider.auth.accessToken = () => new Promise(() => {});
  const alive = setTimeout(() => {}, 100); try { await assert.rejects(f.provider.generate(f.config, [], 'new'), e => e.name === 'TimeoutError'); } finally { clearTimeout(alive); }
  assert.equal(f.calls.length, 0);
  const c = new AbortController(); c.abort(); await assert.rejects(f.provider.generate(f.config, [], 'new', c.signal), e => e.name === 'AbortError');
});
test('an upstream key-shaped error code is hidden', async () => {
  const f = setup(() => new Response(JSON.stringify({ error: { code: 'sk-new-synthetic-secret', message: 'private' } }), { status: 401 }), { backend: 'chatgpt' });
  await assert.rejects(f.provider.generate(f.config, [], 'new'), e => e.code === 'authorization_required' && !e.message.includes('synthetic-secret'));
});
