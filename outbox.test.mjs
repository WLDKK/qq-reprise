import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetainedOutbox, deliveryFailure, validateDeliverySettings } from './retained-outbox.mjs';
import { ResendQueue } from './send-queue.mjs';
import { DEFAULTS, RecallReposter, OneBotClient } from './engine.mjs';
import { PrivateRecallApp } from './qq-recall.mjs';
import { CommandConfirmations } from './command-confirmations.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
class Clock {
  time = 0; sequence = 0; jobs = new Map();
  timers = { setTimeout: (fn, ms) => { const t = { id: ++this.sequence, unref() {} }; this.jobs.set(t.id, { fn, due: this.time + ms }); return t; },
    clearTimeout: t => { if (t) this.jobs.delete(t.id); } };
  async advance(ms) { const end = this.time + ms; while (true) { const next = [...this.jobs].filter(([, v]) => v.due <= end).sort((a, b) => a[1].due - b[1].due)[0]; if (!next) break;
    this.time = next[1].due; this.jobs.delete(next[0]); next[1].fn(); await flush(); } this.time = end; await flush(); }
}
const payload = n => ({ key: '90001:group:50001:' + n, selfId: '90001', type: 'group', peerId: '50001',
  authorId: '60001', sourceMessageId: String(n), isSelf: false, mediaBytes: 0, message: [{ type: 'text', data: { text: String(n) } }] });
function fixture(t, options = {}) {
  const clock = new Clock(), sent = [], states = [];
  const scope = { ready: false, user: '90001', peer: '50001', enabled: true, exempt: [] };
  const box = new RetainedOutbox({ now: () => clock.time, timers: clock.timers, pace: new ResendQueue({ intervalMs: 0, jitterMs: 0 }),
    inspect: job => job.selfId !== scope.user || job.peerId !== scope.peer ? 'scope_changed' : scope.exempt.includes(job.authorId) ? 'exempt'
      : !scope.enabled ? 'cancelled' : scope.ready ? 'ready' : 'offline',
    submit: async job => { sent.push(job.sourceMessageId); return { message_id: 80000 + sent.length }; },
    onState: (job, state) => states.push([job.sourceMessageId, state]), ...options });
  t.after(() => box.dispose()); return { box, clock, sent, states, scope };
}
test('delivery settings have finite validated bounds and conservative failure classification', () => {
  assert.equal(deliveryFailure(new Error('1200')), 'uncertain'); assert.equal(deliveryFailure({ notSubmitted: true }), 'deferred');
  for (const args of [[9, 30, 15], [501, 30, 15], [100, 121, 15], [100, 30, 31], [100, 30, 0]]) assert.throws(() => validateDeliverySettings(...args));
  assert.equal(validateDeliverySettings(100, 30, 15).recall_match_seconds, 15);
});
test('offline authorized items survive and drain in original order on same-scope recovery', async t => {
  const f = fixture(t); assert.equal(await f.box.enqueue(payload(1)), 'deferred'); assert.equal(await f.box.enqueue(payload(2)), 'deferred');
  assert.equal(f.box.snapshot().pending, 2); f.scope.ready = true; f.box.resume(); await flush();
  assert.deepEqual(f.sent, ['1', '2']); assert.equal(f.box.snapshot().pending, 0);
});
test('a provably unsubmitted request retries after bounded backoff', async t => {
  const f = fixture(t); f.scope.ready = true; let attempts = 0;
  f.box.submit = async () => { if (++attempts === 1) throw { notSubmitted: true }; return { message_id: 80001 }; };
  assert.equal(await f.box.enqueue(payload(1)), 'deferred'); await f.clock.advance(1999); assert.equal(attempts, 1);
  await f.clock.advance(1); assert.equal(attempts, 2); assert.equal(f.box.snapshot().sent, 1);
});
test('generic API 1200 and timeout results stay uncertain without blind retry', async t => {
  const f = fixture(t); f.scope.ready = true; let attempts = 0;
  f.box.submit = async () => { attempts++; throw Object.assign(new Error('API failed'), { retcode: 1200 }); };
  assert.equal(await f.box.enqueue(payload(1)), 'uncertain'); await f.clock.advance(60000); f.box.resume(); await flush();
  assert.equal(attempts, 1); assert.equal(f.box.snapshot().uncertain_count, 1);
  f.box.confirm(payload(1).key, 81001); f.box.confirm(payload(1).key, 81001);
  assert.equal(f.box.snapshot().sent, 1); assert.equal(f.box.snapshot().pending, 0);
});
test('uncertain send without a returned message ID is not declared successful', async t => {
  const f = fixture(t); f.scope.ready = true; f.box.submit = async () => ({});
  assert.equal(await f.box.enqueue(payload(1)), 'uncertain'); assert.equal(f.box.snapshot().sent, 0);
});
test('excess capacity discards the oldest unsent item and preserves newer FIFO order', async t => {
  const f = fixture(t, { limit: 2 }); await f.box.enqueue(payload(1)); await f.box.enqueue(payload(2)); await f.box.enqueue(payload(3));
  assert.equal(f.box.snapshot().pending, 2); assert.equal(f.box.snapshot().dropped_oldest, 1);
  f.scope.ready = true; f.box.resume(); await flush(); assert.deepEqual(f.sent, ['2', '3']);
});
test('media and total byte pressure also discard oldest entries within finite budgets', async t => {
  const f = fixture(t, { mediaLimit: 10 }); await f.box.enqueue({ ...payload(1), mediaBytes: 8 }); await f.box.enqueue({ ...payload(2), mediaBytes: 8 });
  assert.equal(f.box.snapshot().pending, 1); assert.equal(f.box.snapshot().dropped_oldest, 1);
  assert.equal(await f.box.enqueue({ ...payload(3), mediaBytes: 11 }), 'queue_full');
});
test('waiting and uncertain entries expire and cannot be replayed after expiry', async t => {
  const f = fixture(t, { ttlMs: 60000 }); await f.box.enqueue(payload(1)); await f.clock.advance(60000);
  f.scope.ready = true; f.box.resume(); await flush(); assert.equal(f.sent.length, 0); assert.equal(f.box.snapshot().expired, 1);
  assert.equal(await f.box.enqueue(payload(1)), 'duplicate');
});
test('manual disabling cancels old items instead of treating it as a transient outage', async t => {
  const f = fixture(t); await f.box.enqueue(payload(1)); f.scope.enabled = false; f.box.cancel();
  f.scope.enabled = true; f.scope.ready = true; f.box.resume(); await flush(); assert.equal(f.sent.length, 0);
});
test('author whitelist changes cancel retained work while an operator exemption does not', async t => {
  const f = fixture(t); await f.box.enqueue(payload(1)); f.scope.exempt = ['60001']; f.box.kick(); await flush();
  f.scope.exempt = ['60003']; f.scope.ready = true; f.box.resume(); await flush(); assert.equal(f.sent.length, 0);
  assert.equal(await f.box.enqueue(payload(2)), 'sent');
});
for (const field of ['user', 'peer']) test('changing ' + field + ' never routes old payloads to the new scope', async t => {
  const f = fixture(t); await f.box.enqueue(payload(1)); f.scope[field] = '99999'; f.scope.ready = true; f.box.resume(); await flush();
  assert.equal(f.sent.length, 0); assert.ok(f.states.some(([, state]) => state === 'scope_changed'));
});
test('duplicate original notices do not create a second retained job', async t => {
  const f = fixture(t); await f.box.enqueue(payload(1)); assert.equal(await f.box.enqueue(payload(1)), 'duplicate');
  f.scope.ready = true; f.box.resume(); await flush(); assert.deepEqual(f.sent, ['1']); assert.equal(await f.box.enqueue(payload(1)), 'duplicate');
});
test('overflow never causes an already removed pacing task to send', async t => {
  let task, done; const pace = { cancel() {}, enqueue(fn) { task = fn; return new Promise(resolve => { done = resolve; }); } };
  const f = fixture(t, { limit: 1, pace }); f.scope.ready = true; const first = f.box.enqueue(payload(1));
  f.scope.ready = false; const second = f.box.enqueue(payload(2)); assert.equal(await first, 'dropped');
  done(await task(new AbortController().signal)); await flush(); assert.equal(await second, 'deferred'); assert.equal(f.sent.length, 0);
});
test('a late native OneBot success reply reports its real message ID without resubmitting', async t => {
  let socket;
  class Socket extends EventTarget {
    readyState = 0; constructor() { super(); socket = this; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(packet) { this.packet = JSON.parse(packet); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const client = new OneBotClient({ ws_url: 'ws://127.0.0.1:1', api_timeout_ms: 10 }, () => {}, Socket); t.after(() => client.close());
  await client.open(); let receipt;
  await assert.rejects(client.call('send_group_msg', {}, { onLateResult: data => { receipt = data.message_id; } }));
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ echo: socket.packet.echo, status: 'ok', retcode: 0, data: { message_id: 80001 } }) }));
  assert.equal(receipt, 80001); assert.equal(client.latePending.size, 0);
});
test('native closed connection is unsubmitted but an arbitrary synchronous send exception remains uncertain', async () => {
  const client = new OneBotClient({ ws_url: 'ws://127.0.0.1:1', api_timeout_ms: 10 });
  await assert.rejects(client.call('send_group_msg'), error => error.notSubmitted === true);
  client.socket = { readyState: 1, send() { throw new Error('closed before frame'); } };
  await assert.rejects(client.call('send_group_msg'), error => error.notSubmitted !== true);
});
test('ambiguous identical own echoes do not confirm either uncertain request', async () => {
  const markers = new CommandConfirmations(); const scope = { self_id: '90001', conversation_type: 'group', peer_id: '50001' };
  let confirmed = 0;
  for (let n = 0; n < 2; n++) await assert.rejects(markers.track(scope, payload(1).message, async () => { throw new Error('unknown'); }, () => confirmed++));
  markers.consume({ post_type: 'message_sent', message_type: 'group', self_id: '90001', group_id: '50001', user_id: '90001', message_id: 80001, message: payload(1).message });
  markers.consume({ post_type: 'message_sent', message_type: 'group', self_id: '90001', group_id: '50001', user_id: '90001', message_id: 80002, message: payload(1).message });
  assert.equal(confirmed, 0);
});
async function appFixture(t, overrides = {}, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qq-outbox-')), configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ target_type: 'group', group_id: '50001', auto_start: true, auto_resend: true,
    resend_self: true, auto_recovery: false, send_interval_seconds: 0, ...overrides }));
  const app = new PrivateRecallApp({ configPath, logger: () => {}, ...options }); await app.initialize();
  app.selfId = '90001'; app.connected = true; app.onlineConfirmed = true; app.activate({ type: 'group', id: '50001', name: 'fixture' });
  const sent = [], api = { call: async (action, body) => { sent.push({ action, body }); return { message_id: 81000 + sent.length }; } };
  t.after(async () => { await app.shutdown(); await rm(configPath, { force: true }); await rm(configPath + '.tmp', { force: true }); await rmdir(dir); });
  return { app, sent, api, configPath };
}
const msg = (n = 70001, author = '60001') => ({ post_type: 'message', message_type: 'group', self_id: '90001', group_id: '50001', user_id: author,
  message_id: n, sender: { user_id: author, card: author === '90001' ? '本人名' : 'b' }, message: [{ type: 'text', data: { text: 'a' } }] });
const notice = (n = 70001, author = '60001') => ({ post_type: 'notice', notice_type: 'group_recall', self_id: '90001', group_id: '50001', user_id: author,
  message_id: String(n), operator_id: '60003' });
test('app retains known messages through disconnect and uses the recovered transport', async t => {
  const f = await appFixture(t); await f.app.onEvent(msg(), f.api); f.app.connected = false; f.app.onlineConfirmed = false;
  await f.app.onEvent(notice(), f.api); assert.equal(f.app.outbox.snapshot().pending, 1); assert.equal(f.sent.length, 0);
  const recovered = []; f.app.latestEventApi = { call: async (_, body) => { recovered.push(body); return { message_id: 82001 }; } };
  f.app.connected = true; f.app.onlineConfirmed = true; f.app.outbox.resume();
  for (let n = 0; n < 10 && !recovered.length; n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(recovered.length, 1); assert.equal(f.sent.length, 0);
});
test('real app generic failure is retained uncertain and a uniquely correlated own-message ID confirms it', async t => {
  const f = await appFixture(t); let output, attempts = 0;
  const api = { call: async (_, body) => { output = body.message; attempts++; throw Object.assign(new Error('generic'), { retcode: 1200 }); } };
  await f.app.onEvent(msg(), api); await f.app.onEvent(notice(), api);
  assert.equal(f.app.outbox.snapshot().uncertain_count, 1); assert.equal(f.app.sentCount, 0);
  await f.app.onEvent({ ...msg(83001, '90001'), message: structuredClone(output) }, api);
  assert.equal(f.app.outbox.snapshot().pending, 0); assert.equal(f.app.sentCount, 1); assert.equal(attempts, 1);
});
test('app queues only authorized on-period recalls and never replays the disabled period', async t => {
  const f = await appFixture(t); await f.app.setResend(false); await f.app.onEvent(msg(), f.api); await f.app.onEvent(notice(), f.api);
  await f.app.setResend(true); f.app.outbox.resume(); await flush(); assert.equal(f.sent.length, 0); assert.equal(f.app.outbox.snapshot().pending, 0);
});
test('app queue settings persist while payloads remain only in memory', async t => {
  const f = await appFixture(t); await f.app.setDeliverySettings(80, 20, 20);
  f.app.connected = false; f.app.onlineConfirmed = false; await f.app.onEvent(msg(), f.api); await f.app.onEvent(notice(), f.api);
  const saved = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.equal(saved.outbox_limit, 80); assert.equal(saved.recall_match_seconds, 20); assert.equal(saved.outbox_ttl_minutes, 20);
  assert.equal(saved.message, undefined); assert.equal(saved.jobs, undefined); assert.equal(f.app.outbox.snapshot().pending, 1);
});
test('late original after the old three-second window is scoped, normalized and captured once', async t => {
  const f = fixture(t), e = new RecallReposter({ ...DEFAULTS, group_ids: ['50001'], expected_self_id: '90001', auto_resend: true,
    ignore_self_messages: false, recall_match_wait_ms: 15000 }, () => {}, () => f.clock.time, async () => {}, f.box.pace, f.clock.timers);
  t.after(() => e.clear()); e.deliver = item => f.box.enqueue(item);
  const pending = e.handle(notice(), {}); await f.clock.advance(4000);
  await e.handle({ ...msg(), group_id: '50002' }, {}); assert.equal(e.pendingRecalls.size, 1);
  await e.handle(msg(), {}); assert.equal(await pending, 'outbox'); assert.equal(f.box.snapshot().pending, 1);
  f.scope.ready = true; f.box.resume(); await flush(); assert.deepEqual(f.sent, ['70001']);
});
test('reloading an already paused recovery keeps login and restart actions stopped', async t => {
  let actions = 0;
  const f = await appFixture(t, { auto_recovery: true, recovery_account: '90001' }, {
    initialRecoveryPause: true, recoveryActions: { inspect: async () => ({ ok: false, error_code: 'action_failed' }),
      login: async () => { actions++; }, restart: async () => { actions++; } },
  });
  f.app.connected = false; f.app.onlineConfirmed = false;
  await f.app.runRecoveryTick(); assert.equal(f.app.recovery.snapshot().paused, true); assert.equal(actions, 0);
  assert.equal(f.app.preferences.auto_recovery, true);
});
test('validated recalled media survives cache eviction during preparation in retained-delivery mode', async t => {
  const f = await appFixture(t, { cache_messages_per_chat: 10 });
  f.app.engine.fetcher = (_, { signal }) => new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('fixture evicted'), { name: 'AbortError' }));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  await f.app.onEvent({ ...msg(), message: [{ type: 'image', data: { file: 'https://offline.invalid/fixture.gif' } }] }, f.api);
  f.app.connected = false; f.app.onlineConfirmed = false;
  const pending = f.app.onEvent(notice(), f.api); await flush();
  for (let n = 1; n <= 10; n++) await f.app.onEvent(msg(70001 + n), f.api);
  await pending; assert.equal(f.app.outbox.snapshot().pending, 1);
  const job = [...f.app.outbox.jobs.values()][0];
  assert.equal(job.message[1].data.file, 'https://offline.invalid/fixture.gif');
  assert.equal(f.sent.length, 0);
});
