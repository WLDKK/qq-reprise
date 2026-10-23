import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProviders } from './ai-providers.mjs';
import { AI_DEFAULTS, validateAISettings } from './ai-config.mjs';
const base = 'https://zhenze-huhehaote.cmecloud.cn/v1';
const models = ['DeepSeek-V4-Flash','Qwen/Qwen3.6-Plus','MiniMax-M2.5','Qwen/Qwen3.7-Max','ZHIPU/GLM-5.1','ZHIPU/GLM-5.2','Minimax/Minimax-M3','Minimax/Minimax-M2.7','Kimi/Kimi-K2.6','Kimi/Kimi-K2.7-code'];
const sse = events => new Response(events.map(e => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\r\n\r\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
for (const model of models) test('competition model identifier preserved exactly: ' + model, async () => {
  let called = 0;
  const config = validateAISettings({ ...structuredClone(AI_DEFAULTS), api_base_url: base, api_model: model, api_format: 'chat_completions' });
  const provider = new AIProviders({ auth: { readAPIFor: async () => 'synthetic-test-key' }, fetcher: async (url, options) => {
    called++; assert.equal(url, base + '/chat/completions'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-key'); const body = JSON.parse(options.body);
    assert.equal(body.model, model); assert.equal(body.stream, true); assert.equal(body.max_tokens, 512); assert.equal(body.messages.at(-1).content, 'Reply exactly OK.');
    return sse([{ choices: [{ index: 0, delta: { reasoning_content: 'private internal reasoning' } }] }, { choices: [{ index: 0, delta: { content: 'OK' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { completion_tokens: 2 } }, '[DONE]']);
  } });
  assert.equal(await provider.generate(config, [], 'Reply exactly OK.'), 'OK'); assert.equal(called, 1); assert.equal(config.enabled, false);
});
for (const [status, code] of [[401,'authorization_required'],[403,'access_denied'],[429,'rate_limit_exceeded'],[503,'server_error']]) test('plaintext platform error is safely classified: ' + status, async () => {
  let called = 0; const provider = new AIProviders({ auth: { readAPIFor: async () => 'synthetic' }, fetcher: async () => { called++; return new Response('private error body never returned', { status }); } });
  await assert.rejects(provider.generate({ ...AI_DEFAULTS, api_base_url: base, api_model: models[0] }, [], 'Reply exactly OK.'), e => e.status === status && e.code === code && !e.message.includes('private error'));
  assert.equal(called, 1);
});
test('remote HTTP and insecure URL forms are rejected for competition backend', () => {
  for (const url of [base.replace('https:', 'http:'), base + '?api_key=synthetic', base.replace('https://','https://synthetic@')]) assert.throws(() => validateAISettings({ api_base_url: url }));
});
