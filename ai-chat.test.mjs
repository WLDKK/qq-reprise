import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIChat } from './ai-chat.mjs';
import { AI_DEFAULTS } from './ai-config.mjs';
import { apiBinding } from './ai-api-draft.mjs';
import { MemorySecrets } from './ai-storage.mjs';
import { ResendQueue } from './send-queue.mjs';
import { PrivateRecallApp } from './qq-recall.mjs';
import { AIError } from './ai-auth.mjs';
import { DEFAULTS, OneBotClient } from './engine.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async fn => { for (let n = 0; n < 200; n++) { if (fn()) return; await sleep(5); } assert.fail('mock condition timeout'); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const message = (n, options = {}) => ({ post_type: 'message', message_type: 'group', self_id: 90001, group_id: 50001, user_id: 60001, message_id: n, message: [{ type: 'at', data: { qq: 90001 } }, { type: 'text', data: { text: '/ai prompt-' + n } }], ...options });
const recall = (n, options = {}) => ({ post_type: 'notice', notice_type: 'group_recall', self_id: 90001, group_id: 50001, user_id: 60001, operator_id: 60001, message_id: n, ...options });
async function fixture(t, { generate, send, config = {}, pace } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-chat-mock-')), calls = [], sent = [];
  const app = { connected: true, onlineConfirmed: true, selfId: '90001', sendQueue: pace || new ResendQueue({ intervalMs: 0, jitterMs: 0 }),
    client: { call: async (action, body, options) => { sent.push({ action, body, options }); return send ? send(action, body, options) : { message_id: 80000 + sent.length }; } } };
  const provider = { generate: async (...args) => { calls.push(args); return generate ? generate(...args) : 'answer-' + calls.length; } };
  const ai = new AIChat({ dir, app, secrets: new MemorySecrets(), provider }); await ai.initialize();
  ai.auth.meta.api_configured = true; ai.auth.meta.api_id = 'mock-credential';
  ai.config = { ...structuredClone(AI_DEFAULTS), enabled: true, binding_qq: app.selfId, groups: ['50001'], private_peers: ['60001'], users: ['60001', '60002'], api_model: 'mock', cooldown_seconds: 0, ...config };
  ai.auth.meta.api_binding = apiBinding(ai.config);
  t.after(async () => { ai.dispose(); await ai.budgetTask.catch(() => {}); await ai.settingsFile.task.catch(() => {}); await ai.diagnostics.file.task.catch(()=>{}); await rm(dir, { recursive: true, force: true }); });
  return { ai, app, calls, sent, dir };
}
test('one runtime duplicate event makes at most one model call and plain structured-text send', async t => {
  const f = await fixture(t, { generate: async () => '[CQ:at,qq=all] literal' }); f.ai.offer(message(1)); f.ai.offer(message('1')); await until(() => f.ai.counts.sent === 1);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.sent[0].body.message, [{ type: 'text', data: { text: '[CQ:at,qq=all] literal' } }]); assert.equal(f.ai.sessions.values().next().value.turns.length, 1);
});
test('unauthorized group, blacklisted user, account, anonymous, at-all and image cannot trigger', async t => {
  const f = await fixture(t, { config: { group_blacklist: ['60003'] } });
  for (const event of [message(1, { group_id: 50002 }), message(2, { user_id: 60003 }), message(3, { self_id: 90002 }), message(4, { anonymous: { id: 1 } }), message(5, { message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '/ai hello' } }] }), message(6, { message: [{ type: 'image', data: { file: 'private' } }] })]) assert.equal(f.ai.offer(event), false);
  await sleep(10); assert.equal(f.calls.length, 0);
});
test('actual self mention works, false mention and private input without freshness proof do not', async t => {
  const f = await fixture(t); assert.equal(f.ai.offer(message(1, { message: [{ type: 'at', data: { qq: 90001 } }, { type: 'text', data: { text: 'hello' } }] })), true);
  assert.equal(f.ai.offer(message(2, { message: [{ type: 'at', data: { qq: 90002 } }, { type: 'text', data: { text: 'hello' } }] })), false);
  assert.equal(f.ai.offer(message(3, { message_type: 'private', group_id: undefined, message: [{ type: 'text', data: { text: 'hello' } }] })), false); await until(() => f.ai.counts.sent === 1);
});
test('plan backend is owner-only even when other-user API list is configured', async t => {
  const f = await fixture(t, { config: { backend: 'chatgpt' } }); assert.equal(f.ai.offer(message(1)), false); assert.equal(f.ai.offer(message(2, { user_id: 90001 })), true); await until(() => f.ai.counts.sent === 1);
});
test('recall arriving before message and while generation is queued suppresses calls', async t => {
  const gate = deferred(); const f = await fixture(t, { generate: () => gate.promise });
  f.ai.fastRecall(recall(1)); assert.equal(f.ai.offer(message(1)), true); assert.equal(f.calls.length, 0);
  f.ai.offer(message(2)); await until(() => f.calls.length === 1); f.ai.offer(message(3, { user_id: 60002 })); f.ai.fastRecall(recall(3, { user_id: 60002 }));
  gate.resolve('ok'); await until(() => f.ai.active === 0); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
});
test('recall cancellation is synchronous and suppresses provider that ignores AbortSignal', async t => {
  const gate = deferred(); const f = await fixture(t, { generate: () => gate.promise }); f.ai.offer(message(1)); await until(() => f.calls.length === 1);
  f.ai.fastRecall(recall(1)); assert.equal(f.calls[0][3].aborted, true); gate.resolve('late answer'); await until(() => f.ai.active === 0); assert.equal(f.sent.length, 0); assert.equal(f.ai.jobs.size, 0);
});
test('recall while QQ send is pacing prevents submission and retains no context', async t => {
  const waiting = deferred(); const pace = new ResendQueue({ intervalMs: 3000, jitterMs: 0, wait: async (_ms, signal) => { await Promise.race([waiting.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]); } });
  const f = await fixture(t, { pace }); f.ai.offer(message(1)); await until(() => !!pace.current); f.ai.fastRecall(recall(1)); assert.equal(f.sent.length, 0); pace.cancel(); waiting.resolve(); await until(() => f.ai.active === 0); assert.equal(f.sent.length, 0); assert.equal(f.ai.history(f.ai.sessions.values().next().value).length, 0);
});
test('reset, off, config and credential changes suppress late generation', async t => {
  for (const kind of ['reset', 'off', 'config', 'credential']) { const gate = deferred(); const f = await fixture(t, { generate: () => gate.promise }); f.ai.offer(message(1)); await until(() => f.calls.length === 1);
    if (kind === 'reset') f.ai.reset(); else if (kind === 'credential') f.ai.credentialsChanged(); else await f.ai.configure({ ...f.ai.config, enabled: kind !== 'off', api_model: 'changed' });
    gate.resolve('late answer'); await until(() => f.ai.active === 0); assert.equal(f.sent.length, 0, kind); }
});
test('history is isolated by user and peer and never includes an undelivered response', async t => {
  const f = await fixture(t); f.ai.offer(message(1)); await until(() => f.ai.counts.sent === 1); f.ai.offer(message(2, { user_id: 60002 })); await until(() => f.ai.counts.sent === 2);
  f.ai.config.groups.push('50002'); f.ai.offer(message(3, { group_id: 50002 })); await until(() => f.ai.counts.sent === 3); f.ai.offer(message(4,{message:[{type:'reply',data:{id:1}},{type:'at',data:{qq:90001}},{type:'text',data:{text:'/ai 请继续解释上面的步骤'}}]})); await until(() => f.ai.counts.sent === 4);
  assert.deepEqual(f.calls.slice(0, 3).map(c => c[1].length), [0, 0, 0]); assert.equal(f.calls[3][1].length, 2); assert.equal(f.calls[3][1][0].content, 'prompt-1');
});
test('withdrawn input plus its answer disappears from later model history', async t => {
  const f = await fixture(t); f.ai.offer(message(1)); await until(() => f.ai.counts.sent === 1); f.ai.fastRecall(recall(1)); f.ai.offer(message(2)); await until(() => f.ai.counts.sent === 2); assert.deepEqual(f.calls[1][1], []);
});
test('recall in a different account or group cannot cancel current generation', async t => {
  const gate = deferred(); const f = await fixture(t, { generate: () => gate.promise }); f.ai.offer(message(1)); await until(() => f.calls.length === 1);
  f.ai.fastRecall(recall(1, { group_id: 50002 })); f.ai.fastRecall(recall(1, { self_id: 90002 })); assert.equal(f.calls[0][3].aborted, false); gate.resolve('ok'); await until(() => f.ai.counts.sent === 1);
});
test('unknown QQ submission is held, not retried or committed as delivered context', async t => {
  let attempt=0;const f = await fixture(t, { send: async () => { if(++attempt===1)throw Object.assign(new Error('unknown'), { retcode: 1200 });return{message_id:88002}; } }); f.ai.offer(message(1)); await until(() => f.ai.outbox.snapshot().uncertain_count === 1&&f.ai.active===0);
  assert.equal(f.ai.counts.sent, 0); const session = f.ai.sessions.values().next().value; assert.deepEqual(f.ai.history(session), []);
  f.ai.outbox.resume(); await sleep(20); assert.equal(f.sent.length, 1);
  f.ai.offer(message(2));await until(()=>f.ai.counts.sent===1&&f.ai.active===0);assert.equal(f.calls.length,2);assert.equal(f.calls[1][1].length,0);assert.equal(f.ai.outbox.snapshot().uncertain_count,1);
  f.sent[0].options.onLateResult({ message_id: 88001 });await until(()=>f.ai.outbox.snapshot().uncertain_count===0);assert.equal(f.ai.counts.sent,1);assert.equal(session.turns.length,1);assert.equal(session.turns[0].answer,'answer-2');
});
test('confirmed unique own echo marks AI output and does not form a new AI loop', async t => {
  const f = await fixture(t); f.ai.offer(message(1)); await until(() => f.ai.counts.sent === 1);
  assert.equal(f.ai.markers.consume(message(80001, { user_id: 90001, message: f.sent[0].body.message })), true);
});
test('daily request count persists before model call and blocks future calls', async t => {
  const f = await fixture(t, { config: { daily_requests: 1 } }); f.ai.offer(message(1)); await until(() => f.ai.counts.sent === 1); f.ai.offer(message(2)); await until(() => f.ai.blocked);
  assert.equal(f.calls.length, 1); const disk = await readFile(join(f.dir, 'ai-usage.json'), 'utf8'); assert.equal(JSON.parse(disk).count, 1); assert.doesNotMatch(disk, /prompt|answer/);
});
test('quota/policy stops selected backend without fallback; transient error preserves credentials', async t => {
  const f = await fixture(t, { generate: () => { throw new AIError('subscription_sharing_usage_limit_exceeded', 429); } }); f.ai.offer(message(1)); await until(() => f.ai.blocked); f.ai.offer(message(2)); await sleep(10); assert.equal(f.calls.length, 1); assert.equal(f.ai.auth.meta.api_configured, true);
});
test('same conversation is serialized; distinct conversations fit global concurrency', async t => {
  const gate = deferred(); const f = await fixture(t, { config: { concurrency: 2,groups:['50001','50002'] }, generate: () => gate.promise }); f.ai.offer(message(1)); f.ai.offer(message(2)); f.ai.offer(message(3, { user_id: 60002,group_id:50002 }));
  await until(() => f.calls.length === 2); assert.equal(f.ai.active, 2); assert.deepEqual(f.calls.map(c => c[2]), ['prompt-1', 'prompt-3']); gate.resolve('ok'); await until(() => f.ai.counts.sent === 3); assert.equal(f.calls.length, 3);
});
test('disconnect cancels generating work; completed unsent output waits for verified reconnection', async t => {
  const gate = deferred(); const f = await fixture(t, { generate: () => gate.promise }); f.ai.offer(message(1)); await until(() => f.calls.length === 1); f.app.connected = false; f.app.onlineConfirmed = false; f.ai.disconnected(); gate.resolve('late'); await until(() => f.ai.active === 0); assert.equal(f.sent.length, 0);
});
test('zero context turns sends no old messages', async t => { const f = await fixture(t, { config: { context_turns: 0 } }); f.ai.offer(message(1)); await until(() => f.ai.counts.sent === 1); f.ai.offer(message(2)); await until(() => f.ai.counts.sent === 2); assert.deepEqual(f.calls[1][1], []); });
test('main event fast cancellation runs before an awaited command path', async t => {
  const gate = deferred(); const dir = await mkdtemp(join(tmpdir(), 'ai-app-mock-')); const app = new PrivateRecallApp({ configPath: join(dir, 'config.json'), logger: () => {}, discover: async () => [] });
  t.after(async () => { gate.resolve(); await app.shutdown(); await rm(dir, { recursive: true, force: true }); });
  let called = false; app.ai.fastRecall = () => { called = true; }; app.handleOwnCommand = () => gate.promise;
  const task = app.onEvent(recall(1), {}); assert.equal(called, true); gate.resolve(false); await task;
});
test('bounded queue overflow is rejected and cooldown expiry does not revive cancelled input', async t => {
  const gate = deferred(); const f = await fixture(t, { generate: () => gate.promise, config: { queue_limit: 1, cooldown_seconds: 100 } });
  f.ai.offer(message(1)); await until(() => f.calls.length === 1); f.ai.offer(message(2)); f.ai.offer(message(3)); assert.equal(f.ai.queue.length, 1); assert.equal(f.ai.counts.rejected, 1);
  f.ai.fastRecall(recall(2)); gate.resolve('ok'); await until(() => f.ai.active === 0); assert.equal(f.calls.length, 1);
});
test('queue TTL, session TTL and session count bounds discard old work', async t => {
  const f = await fixture(t, { config: { cooldown_seconds: 300, sessions_limit: 1,queue_wait_seconds:1,timeout_seconds:1,context_ttl_minutes:120 } }); f.ai.offer(message(1)); await until(() => f.ai.counts.sent === 1);
  f.ai.offer(message(2)); const queued = f.ai.queue[0]; queued.created -= 601000; f.ai.pump(); assert.equal(f.ai.queue.length, 0);
  f.ai.offer(message(3, { user_id: 60002 })); await until(() => f.ai.counts.sent === 2); assert.equal(f.ai.sessions.size, 1);
  const session = f.ai.sessions.values().next().value; session.used -= 121 * 60000; f.ai.prune(); assert.equal(f.ai.sessions.size, 0);
});
test('clear command cancels same-user work, removes history and is not sent to model', async t => {
  const gate = deferred(); const f = await fixture(t, { generate: () => gate.promise }); f.ai.offer(message(1)); await until(() => f.calls.length === 1);
  f.ai.offer(message(2, { message: [{ type:'at',data:{qq:90001} }, { type: 'text', data: { text: '/ai clear' } }] })); assert.equal(f.calls[0][3].aborted, true); gate.resolve('late'); await until(() => f.ai.active === 0); assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 1);
});
test('recalling a delivered AI reply removes that question-answer pair', async t => {
  const f = await fixture(t); f.ai.offer(message(1)); await until(() => f.ai.counts.sent === 1); f.ai.fastRecall(recall(80001, { user_id: 90001, operator_id: 60002 }));
  f.ai.offer(message(2)); await until(() => f.ai.counts.sent === 2); assert.deepEqual(f.calls[1][1], []);
});
test('completed output stays offline and sends once after verified same-account recovery', async t => {
  let f; f = await fixture(t, { generate: async () => { f.app.connected = false; f.app.onlineConfirmed = false; return 'retained output'; } });
  f.ai.offer(message(1)); await until(() => f.ai.outbox.snapshot().pending === 1); assert.equal(f.sent.length, 0);
  f.app.connected = true; f.app.onlineConfirmed = true; f.ai.reconnected(); await until(() => f.ai.counts.sent === 1); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
});
test('new QQ account cancels retained output rather than changing its destination', async t => {
  let f; f = await fixture(t, { generate: async () => { f.app.connected = false; return 'retained'; } }); f.ai.offer(message(1)); await until(() => f.ai.outbox.snapshot().pending === 1);
  f.app.selfId = '90002'; f.app.connected = true; f.ai.reconnected(); await sleep(10); assert.equal(f.ai.outbox.snapshot().pending, 0); assert.equal(f.sent.length, 0);
});
test('queue priority allows withdrawal to overtake a waiting AI reply', async () => {
  let now = 0, waiting = []; const order = [];
  const pace = new ResendQueue({ intervalMs: 1000, jitterMs: 0, now: () => now,
    wait: (ms, signal) => new Promise((resolve, reject) => { const item = { ms, resolve }; waiting.push(item); signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })), { once: true }); }) });
  const ai = pace.enqueue(async () => { order.push('ai'); return 'sent'; }, { priority: -10 }); await until(() => waiting.length === 1);
  const recall = pace.enqueue(async () => { order.push('recall'); return 'sent'; }); await until(() => waiting.length === 2); now = 1000; waiting[1].resolve(); await until(() => order.length === 1); assert.equal(order[0], 'recall');
  await until(() => waiting.length === 3); now = 2000; waiting[2].resolve(); await Promise.all([ai, recall]); assert.deepEqual(order, ['recall', 'ai']); assert.equal(pace.mediaBytes, 0);
});
test('withdrawal off, exemptions and self switches do not cancel independent AI reply', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-independent-mock-')); let release; const waiting = new Promise(resolve => { release = resolve; });
  const pace = new ResendQueue({ intervalMs: 0, jitterMs: 0 }); const app = new PrivateRecallApp({ configPath: join(dir, 'config.json'), sendQueue: pace, logger: () => {} });
  t.after(async () => { release(); await app.shutdown(); await rm(dir, { recursive: true, force: true }); });
  app.selfId = '90001'; app.connected = true; app.groups = [{ type: 'group', id: '50001', name: 'mock' }]; app.activate(app.groups[0]);
  // Hold one submitted task, then queue an AI task that must survive withdrawal control changes.
  const held = pace.enqueue(() => waiting); const ai = pace.enqueue(async () => 'survived', { priority: -10, isSelf: true, authorId: '60001' });
  await app.setResend(false); await app.setResendExemptions(['60001']); await app.setSelfResend(false); release(); await held; assert.equal(await ai, 'survived');
});
test('OneBot async acknowledgement is unknown until correlated final receipt', async () => {
  class Socket extends EventTarget {
    readyState = 0; sent = [];
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(value) { this.sent.push(JSON.parse(value)); }
    receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const api = new OneBotClient({ ...DEFAULTS, api_timeout_ms: 1000 }, () => {}, Socket); await api.open(); let confirmed = null;
  const task = api.call('send_group_msg', { group_id: 50001, message: [] }, { onLateResult: result => { confirmed = result.message_id; } });
  const echo = api.socket.sent[0].echo; api.socket.receive({ echo, status: 'async', retcode: 1, data: { message_id: 777 } });
  await assert.rejects(task); assert.equal(confirmed, null); api.socket.receive({ echo, status: 'async', retcode: 1 }); assert.equal(confirmed, null);
  api.socket.receive({ echo, status: 'ok', retcode: 0, data: { message_id: 888 } }); assert.equal(confirmed, 888); api.close();
});
test('config disable invalidates generation before settings write finishes', async t => {
  const model = deferred(), save = deferred(); const f = await fixture(t, { generate: () => model.promise }); f.ai.offer(message(1)); await until(() => f.calls.length === 1);
  const original = f.ai.settingsFile.write.bind(f.ai.settingsFile); f.ai.settingsFile.write = async value => { await save.promise; return original(value); };
  const config = f.ai.configure({ ...f.ai.config, enabled: false }); model.resolve('late'); await until(() => f.ai.active === 0); assert.equal(f.sent.length, 0); save.resolve(); await config;
});
test('idle maintenance removes expired queued prompts while backend is paused', async t => {
  const f = await fixture(t); f.ai.blocked = true;
  const fake = { key: 'stale', created: Date.now() - 1000000, controller: new AbortController(), session: { pending: null }, cancelled: false };
  f.ai.queue.push(fake); f.ai.jobs.set(fake.key, fake); f.ai.prune(); assert.equal(f.ai.queue.length, 0); assert.equal(f.ai.jobs.size, 0); assert.equal(fake.controller.signal.aborted, true);
});
test('own private recall without target removes only uniquely proven delivered source or answer', async t => {
  for (const recallId of [37, 80001]) {
    const f = await fixture(t, { config: { backend: 'chatgpt' } }); const privateMessage = n => message(n, { group_id: undefined, message_type: 'private', user_id: 90001, target_id: 60001 });
    f.ai.offer(privateMessage(37)); await until(() => f.ai.counts.sent === 1);
    f.ai.fastRecall({ post_type: 'notice', notice_type: 'friend_recall', self_id: 90001, user_id: 90001, message_id: recallId });
    f.ai.offer(privateMessage(38)); await until(() => f.ai.counts.sent === 2); assert.deepEqual(f.calls[1][1], []); assert.equal(f.sent[1].body.user_id, 60001);
  }
});
test('manual API connection test works with AI off, uses only fixed input and never enters QQ/history', async t => {
  const f = await fixture(t, { config: { enabled: false }, generate: async () => 'OK' });
  const result = await f.ai.testAPI(); assert.equal(result.expected_reply_matched, true); assert.equal(f.ai.config.enabled, false);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0][1], []); assert.equal(f.calls[0][2], 'Reply exactly OK.'); assert.equal(f.calls[0][0].api_max_output_tokens, 512);
  assert.equal(f.sent.length, 0); assert.equal(f.ai.jobs.size, 0); assert.equal(f.ai.sessions.size, 0); assert.equal(f.ai.outbox.snapshot().pending, 0);
});
test('manual API test requires newly configured API credential and API backend', async t => {
  const f = await fixture(t); f.ai.auth.meta.api_configured = false; await assert.rejects(f.ai.testAPI(), /api_key_required/);
  f.ai.auth.meta.api_configured = true; f.ai.config.backend = 'chatgpt'; await assert.rejects(f.ai.testAPI(), /api_backend_required/); assert.equal(f.calls.length, 0);
});
test('manual tests cannot overlap and reset suppresses ignored-abort late result', async t => {
  const gate = deferred(); const f = await fixture(t, { config: { enabled: false }, generate: () => gate.promise }); const task = f.ai.testAPI(); await until(() => f.calls.length === 1);
  await assert.rejects(f.ai.testAPI(), /test_in_progress/); f.ai.reset(); gate.resolve('OK'); await assert.rejects(task, /test_cancelled/); assert.equal(f.sent.length, 0);
});
test('manual API test returns the actual reply only to its caller without changing backend or sending QQ', async t => {
  const f = await fixture(t, { config: { enabled: false }, generate: async () => 'synthetic-private-upstream-content' }); const result = await f.ai.testAPI();
  assert.equal(result.expected_reply_matched, false); assert.equal(result.reply, 'synthetic-private-upstream-content'); assert.equal(f.ai.config.backend, 'api'); assert.equal(f.sent.length, 0);
  assert.doesNotMatch(await readFile(f.ai.diagnostics.file.path,'utf8'), /synthetic-private/);
});
for (const trigger of ['both','mention','command']) test('SIWC owner private prefix works without @ for group trigger mode ' + trigger, async t => {
  const f = await fixture(t, { config: { trigger, backend: 'chatgpt' } }); const event = message(41, { group_id: undefined, message_type: 'private', user_id: 90001, target_id: 60001 });
  assert.equal(f.ai.offer(event), true); await until(() => f.ai.counts.sent === 1); assert.equal(f.sent[0].action, 'send_private_msg'); assert.equal(f.sent[0].body.user_id, 60001);
});
test('SIWC private still requires owner, explicit prefix and allowed peer', async t => {
  const f = await fixture(t, { config: { trigger: 'mention', users: [], backend: 'chatgpt' } });
  const privateEvent = (n, options={}) => message(n, { group_id: undefined, message_type: 'private', ...options });
  assert.equal(f.ai.offer(privateEvent(42)), false); assert.equal(f.ai.inputStats.last_result, 'plan_owner_only');
  assert.equal(f.ai.offer(privateEvent(43, { user_id: 90001, target_id: 60002 })), false);
  assert.equal(f.ai.offer(privateEvent(44, { user_id: 90001, target_id: 60001, message: [{type:'text',data:{text:'你好'}}] })), false);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.ai.config.users, []); assert.deepEqual(f.ai.config.private_peers, ['60001']);
});
test('own private message_sent triggers in its friend window without using own QQ as peer', async t => {
  const f = await fixture(t, { config: { users: [], trigger: 'mention', backend: 'chatgpt' } });
  assert.equal(f.ai.offer(message(45, { post_type: 'message_sent', message_type: 'private', group_id: undefined, user_id: 90001, target_id: 60001 })), true);
  await until(() => f.ai.counts.sent === 1); assert.equal(f.sent[0].body.user_id, 60001); assert.equal(f.sent[0].body.user_id === 90001, false);
});
test('own private sender identity can be explicit while event user_id names the friend', async t => {
  const f = await fixture(t, { config: { users: [], backend: 'chatgpt' } });
  const event = message(46, { post_type: 'message_sent', message_type: 'private', group_id: undefined, user_id: 60001, target_id: 60001, sender: { user_id: 90001 } });
  assert.equal(f.ai.offer(event), true); await until(() => f.ai.counts.sent === 1); assert.equal(f.sent[0].body.user_id, 60001);
});
test('self chat, temporary chat and unreported sender are not granted private owner rights', async t => {
  const f = await fixture(t, { config: { users: [] } });
  const privateEvent = (n, options={}) => message(n, { group_id: undefined, message_type: 'private', ...options });
  assert.equal(f.ai.offer(privateEvent(47, { user_id: 90001, target_id: 90001 })), false);
  assert.equal(f.ai.offer(privateEvent(48, { user_id: 90001, target_id: 60001, sub_type: 'group' })), false);
  assert.equal(f.ai.offer(privateEvent(49, { post_type: 'message_sent', user_id: 60001, target_id: 60001 })), false); assert.equal(f.calls.length, 0);
});
test('mention-only groups keep rejecting commands while private commands are fixed', async t => {
  const f = await fixture(t, { config: { trigger: 'mention' } }); assert.equal(f.ai.offer(message(50,{message:[{type:'text',data:{text:'/ai 你好'}}]})), false);
  assert.equal(f.ai.offer(message(51, { message: [{ type: 'at', data: { qq: 90001 } }, { type: 'text', data: { text: '你好' } }] })), true); await until(() => f.ai.counts.sent === 1);
});
test('legacy command-mode setting cannot bypass the new real-mention requirement', async t => {
  const f = await fixture(t, { config: { trigger: 'command', users: [] } });
  assert.equal(f.ai.offer(message(52, { user_id: 90001, message:[{type:'text',data:{text:'/ai 你好'}}] })), false);
  assert.equal(f.ai.offer(message(53, { user_id: 90001 })), true); await until(() => f.ai.counts.sent === 1);
});
test('prefix supports full-width whitespace without accepting concatenated commands', async t => {
  const f = await fixture(t); assert.equal(f.ai.offer(message(54, { message: [{type:'text',data:{text:'/ai你好'}}] })), false);
  assert.equal(f.ai.offer(message(55, { message: [{type:'at',data:{qq:90001}},{type:'text',data:{text:'/ai　你好'}}] })), true); await until(() => f.ai.counts.sent === 1); assert.equal(f.calls[0][2], '你好');
});
test('diagnostics contain only counts and reasons, no message bodies, QQ IDs or credentials', async t => {
  const f = await fixture(t); f.app.client.config = { report_self: false }; const event = message(56, { user_id: 90001 }); f.ai.observe(event);
  const state = f.ai.state(); assert.equal(state.self_messages_reported, false); assert.equal(state.trigger_checks.own_received, 1);
  assert.doesNotMatch(JSON.stringify(state.trigger_checks), /90001|50001|prompt-56|mock-credential/); assert.equal(f.calls.length, 0);
});
const incomingPrivate = (n, text='你好', options={}) => message(n, { group_id:undefined, message_type:'private', sub_type:'friend', time:Math.ceil(Date.now()/1000), message:[{type:'text',data:{text}}], ...options });
test('ordinary new incoming API private text needs neither whitelist nor prefix nor mention', async t => {
  const f=await fixture(t,{config:{groups:[],private_peers:[],users:[],trigger:'mention'},generate:async()=> '你好'});
  assert.equal(f.ai.offer(incomingPrivate(101)),true); await until(()=>f.ai.counts.sent===1); assert.equal(f.sent[0].action,'send_private_msg'); assert.equal(f.calls[0][2],'你好');
});
test('private blacklist rejects incoming and config validator keeps it bounded', async t => {
  const f=await fixture(t,{config:{private_blacklist:['60001']}}); assert.equal(f.ai.offer(incomingPrivate(102)),false); assert.equal(f.ai.inputStats.last_result,'private_blacklisted'); assert.equal(f.calls.length,0);
});
test('ordinary API private own messages never auto trigger, even with allow_self on', async t => {
  const f=await fixture(t); for(const post_type of ['message','message_sent']) assert.equal(f.ai.offer(incomingPrivate(103,'你好',{post_type,user_id:90001,target_id:60001})),false); assert.equal(f.calls.length,0);
});
test('stale, missing-time, future or history-tagged private messages never export', async t => {
  const f=await fixture(t); for(const options of [{time:undefined},{time:1},{time:Math.ceil(Date.now()/1000)+100},{from_history:true},{message_source:'history'}]) assert.equal(f.ai.offer(incomingPrivate(104,'你好',options)),false); assert.equal(f.calls.length,0);
});
for(const text of ['password=synthetic-private-health','api_key=synthetic-private-finance','token=synthetic-private-identity','api_key=synthetic']) test('private pause never calls provider or sends pause message: '+text, async t => {
  const f=await fixture(t); assert.equal(f.ai.offer(incomingPrivate(105,text)),true); await sleep(10); assert.equal(f.calls.length,0); assert.equal(f.sent.length,0); assert.equal(f.ai.privateHolds.size,1); assert.equal(f.ai.usage.count,0);
  assert.doesNotMatch(JSON.stringify(f.ai.state().private_reviews),new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});
test('non-text private content skips only that message without media download, inference or a permanent hold', async t => {
  const f=await fixture(t); assert.equal(f.ai.offer(incomingPrivate(106,'',{message:[{type:'image',data:{file:'https://private.invalid/picture'}}]})),false);
  assert.equal(f.ai.privateHolds.size,0); assert.equal(f.calls.length,0); assert.equal(f.sent.length,0); assert.equal(f.ai.inputStats.last_result,'unsupported_message');
});
test('one sensitive message holds the private conversation and later benign text stays local', async t => {
  const f=await fixture(t); f.ai.offer(incomingPrivate(107,'password=synthetic-private-hold')); f.ai.offer(incomingPrivate(108)); await sleep(10); assert.equal(f.calls.length,0); assert.equal(f.ai.privateHolds.values().next().value.count,2);
});
test('manual skip clears context and hold but never replays the paused message', async t => {
  const f=await fixture(t,{generate:async()=> '你好'}); f.ai.offer(incomingPrivate(109,'私密病历')); f.ai.clearPrivateReviews(); await sleep(10); assert.equal(f.calls.length,0); assert.equal(f.ai.sessions.size,0);
  f.ai.offer(incomingPrivate(110)); await until(()=>f.ai.counts.sent===1); assert.equal(f.calls.length,1); assert.equal(f.calls[0][2],'你好'); assert.deepEqual(f.calls[0][1],[]);
});
test('private payload applies the saved owner-selected role without changing settings', async t => {
  const f=await fixture(t,{config:{instructions:'synthetic-owner-selected-role'},generate:async()=> '你好'}); f.ai.offer(incomingPrivate(111)); await until(()=>f.ai.counts.sent===1);
  assert.match(f.calls[0][0].instructions,/synthetic-owner-selected-role/); assert.equal(f.ai.config.instructions,'synthetic-owner-selected-role');
});
test('sensitive history blocks follow-up before budget or provider call', async t => {
  const f=await fixture(t,{generate:async()=> '你好'}); f.ai.offer(incomingPrivate(112)); await until(()=>f.ai.counts.sent===1); const session=f.ai.sessions.values().next().value;
  session.turns[0].answer='我的健康病历'; f.ai.offer(incomingPrivate(113)); await until(()=>f.ai.privateHolds.size===1); assert.equal(f.calls.length,1); assert.equal(f.ai.usage.count,1); assert.equal(f.ai.sessions.size,0);
});
test('confirmed model history keeps its exact natural reply without a finite phrase requirement', async t => {
  const f=await fixture(t,{generate:async()=> '超出本地规则的自由回复'}); f.ai.offer(incomingPrivate(114)); await until(()=>f.ai.counts.sent===1); f.ai.offer(incomingPrivate(115)); await until(()=>f.ai.counts.sent===2); assert.equal(f.calls.length,2);assert.equal(f.calls[1][1][1].content,'超出本地规则的自由回复');assert.equal(f.ai.privateHolds.size,0);
});
test('sensitive private input cancels an earlier same-conversation generation even if abort ignored', async t => {
  const gate=deferred(); const f=await fixture(t,{generate:()=>gate.promise}); f.ai.offer(incomingPrivate(116)); await until(()=>f.calls.length===1);
  f.ai.offer(incomingPrivate(117,'password=synthetic-private-cancel')); assert.equal(f.calls[0][3].aborted,true); gate.resolve('你好'); await until(()=>f.ai.active===0); assert.equal(f.sent.length,0); assert.equal(f.calls.length,1);
});
test('private recall while generating suppresses ignored-abort result and replay', async t => {
  const gate=deferred(); const f=await fixture(t,{generate:()=>gate.promise}); const event=incomingPrivate(118); f.ai.offer(event); await until(()=>f.calls.length===1);
  f.ai.fastRecall({post_type:'notice',notice_type:'friend_recall',self_id:90001,user_id:60001,message_id:118}); gate.resolve('你好'); await until(()=>f.ai.active===0); f.ai.offer(event); assert.equal(f.sent.length,0); assert.equal(f.calls.length,1);
});
test('private recall before incoming text never starts a model request', async t => {
  const f=await fixture(t); f.ai.fastRecall({post_type:'notice',notice_type:'friend_recall',self_id:90001,user_id:60001,message_id:119}); f.ai.offer(incomingPrivate(119)); await sleep(10); assert.equal(f.calls.length,0);
});
test('blacklisting while generation waits suppresses late output', async t => {
  const gate=deferred(); const f=await fixture(t,{generate:()=>gate.promise}); f.ai.offer(incomingPrivate(120)); await until(()=>f.calls.length===1);
  await f.ai.configure({...f.ai.config,private_blacklist:['60001']}); gate.resolve('你好'); await until(()=>f.ai.active===0); assert.equal(f.sent.length,0);
});
test('unknown private QQ send is not retried or committed as delivered history', async t => {
  const f=await fixture(t,{generate:async()=> '你好',send:async()=>{throw new Error('unknown')}}); f.ai.offer(incomingPrivate(121)); await until(()=>f.ai.outbox.snapshot().uncertain_count===1);
  f.ai.outbox.resume(); await sleep(20); assert.equal(f.sent.length,1); assert.equal(f.ai.sessions.values().next().value.turns.length,0);
});
test('private pause capacity fails closed and does not evict another held peer into service', async t => {
  const f=await fixture(t); for(let n=0;n<101;n++) f.ai.offer(incomingPrivate(200+n,'password=synthetic-private-capacity',{user_id:60001+n})); assert.equal(f.ai.privateHolds.size,100); assert.equal(f.ai.privateReviewFull,true);
  assert.equal(f.ai.offer(incomingPrivate(400,'你好',{user_id:70001})),false); assert.equal(f.calls.length,0); assert.equal(f.sent.length,0);
});
test('SIWC remains owner-only and is not broadened into other-person private service', async t => {
  const f=await fixture(t,{config:{backend:'chatgpt'}}); assert.equal(f.ai.offer(incomingPrivate(122)),false); assert.equal(f.ai.inputStats.last_result,'plan_owner_only'); assert.equal(f.calls.length,0);
});
test('private queued recall never starts its model call', async t => {
  const gate=deferred(); const f=await fixture(t,{generate:()=>gate.promise}); f.ai.offer(incomingPrivate(123)); await until(()=>f.calls.length===1);
  f.ai.offer(incomingPrivate(124,'你好',{user_id:60002})); f.ai.fastRecall({post_type:'notice',notice_type:'friend_recall',self_id:90001,user_id:60002,message_id:124}); gate.resolve('你好'); await until(()=>f.ai.active===0); assert.equal(f.calls.length,1);
});
test('private history is rechecked after budget await immediately before provider submission', async t => {
  const gate=deferred(); const f=await fixture(t,{generate:async()=> '你好'}); f.ai.reserveBudget=()=>gate.promise; f.ai.offer(incomingPrivate(125)); await until(()=>f.ai.active===1);
  const session=f.ai.sessions.values().next().value; session.turns.push({prompt:'你好',answer:'我的银行卡财务信息'}); gate.resolve(); await until(()=>f.ai.active===0); assert.equal(f.calls.length,0); assert.equal(f.ai.privateHolds.size,1);
});
test('private recall at final QQ pacing check prevents the generated reply from submission', async t => {
  const gate=deferred(); const pace=new ResendQueue({intervalMs:0,jitterMs:0}); const held=pace.enqueue(()=>gate.promise);
  const f=await fixture(t,{pace,generate:async()=> '你好'}); f.ai.offer(incomingPrivate(126)); await until(()=>f.ai.outbox.snapshot().pending===1);
  f.ai.fastRecall({post_type:'notice',notice_type:'friend_recall',self_id:90001,user_id:60001,message_id:126}); gate.resolve('done'); await held; await until(()=>f.ai.active===0); assert.equal(f.sent.length,0);
});
test('sensitive private input cancels an already generated reply waiting in QQ queue', async t => {
  const gate=deferred(); const pace=new ResendQueue({intervalMs:0,jitterMs:0}); const held=pace.enqueue(()=>gate.promise);
  const f=await fixture(t,{pace,generate:async()=> '你好'}); f.ai.offer(incomingPrivate(127)); await until(()=>f.ai.outbox.snapshot().pending===1);
  f.ai.offer(incomingPrivate(128,'password=synthetic-private-queued')); gate.resolve('done'); await held; await until(()=>f.ai.active===0); assert.equal(f.sent.length,0); assert.equal(f.ai.privateHolds.size,1); assert.equal(f.calls.length,1);
});
test('main app caches first and completes a withdrawal while an AI model is still waiting',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dual-parallel-mock-')),gate=deferred(),sent=[];let modelCalls=0;
  await writeFile(join(dir,'config.json'),JSON.stringify({target_type:'group',group_id:'50001',auto_start:true,auto_resend:true,send_interval_seconds:0,auto_recovery:false}));
  const app=new PrivateRecallApp({configPath:join(dir,'config.json'),logger:()=>{},aiSecrets:new MemorySecrets(),aiProvider:{generate:async()=>{modelCalls++;return gate.promise}},discover:async()=>[]});await app.initialize();
  t.after(async()=>{gate.resolve('synthetic-model-answer');await app.shutdown();await rm(dir,{recursive:true,force:true})});
  app.selfId='90001';app.connected=true;app.onlineConfirmed=true;app.sendQueue.jitterMs=0;app.activate({type:'group',id:'50001',name:'mock'});
  app.ai.config={...structuredClone(AI_DEFAULTS),enabled:true,binding_qq:'90001',groups:['50001'],users:['60001'],api_model:'mock',cooldown_seconds:0};
  const api={call:async(action,body)=>{sent.push({action,body});return{message_id:82000+sent.length}}};
  await app.onEvent(message(900),api);await until(()=>modelCalls===1);assert.equal(app.engine.cacheSnapshot().cached,1);
  await app.onEvent(message(901,{message:[{type:'text',data:{text:'synthetic-original-for-withdrawal'}}]}),api);
  const finished=await Promise.race([app.onEvent(recall(901),api).then(()=>true),sleep(500).then(()=>false)]);assert.equal(finished,true);assert.equal(sent.length,1);assert.equal(app.ai.active,1);assert.equal(modelCalls,1);
  gate.resolve('synthetic-model-answer');await until(()=>app.ai.active===0);assert.equal(sent.length,2);
});
