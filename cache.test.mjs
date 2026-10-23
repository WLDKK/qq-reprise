import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, RecallReposter, validateCacheSettings } from './engine.mjs';
import { ResendQueue } from './send-queue.mjs';
import { PrivateRecallApp, startApp } from './qq-recall.mjs';

const SELF = '90001', AUTHOR = '60001', ADMIN = '60003', GROUP = '50001';
const flush = () => new Promise(resolve => setImmediate(resolve));
const text = value => [{ type: 'text', data: { text: value } }];
const message = (messageId = 70001, author = AUTHOR, value = 'a') => ({
  post_type: 'message', message_type: 'group', self_id: SELF, group_id: GROUP,
  user_id: author, message_id: messageId, sender: { user_id: author, card: author === SELF ? '本人名' : 'b' }, message: text(value),
});
const recall = (messageId = 70001, author = AUTHOR, operator = author) => ({
  post_type: 'notice', notice_type: 'group_recall', self_id: SELF, group_id: GROUP,
  user_id: author, operator_id: operator, message_id: messageId,
});
class Clock {
  time = 0; sequence = 0; jobs = new Map();
  timers = {
    setTimeout: (fn, delay) => {
      const timer = { id: ++this.sequence, unref() {} };
      this.jobs.set(timer.id, { timer, fn, due: this.time + delay }); return timer;
    },
    clearTimeout: timer => { if (timer) this.jobs.delete(timer.id); },
  };
  async advance(ms) {
    const end = this.time + ms;
    while (true) {
      const job = [...this.jobs.values()].filter(item => item.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!job) break;
      this.time = job.due; this.jobs.delete(job.timer.id); job.fn(); await flush();
    }
    this.time = end; await flush();
  }
}
function fixture(t, overrides = {}) {
  const clock = new Clock(), sends = [], records = [], states = [];
  const engine = new RecallReposter({ ...DEFAULTS, group_ids: [GROUP], expected_self_id: SELF,
    auto_resend: true, ignore_self_messages: false, ...overrides }, () => {}, () => clock.time,
    async () => { throw new Error('External network forbidden'); }, new ResendQueue({ intervalMs: 0, jitterMs: 0 }), clock.timers);
  engine.onRecall = record => records.push(record); engine.onSendState = (_, state) => states.push(state);
  const api = { call: async (action, body) => { sends.push({ action, body }); return { message_id: 90000 + sends.length }; } };
  t.after(() => engine.clear());
  return { engine, clock, sends, records, states, api };
}
function blockedMedia(f) {
  const requests = [];
  f.engine.fetcher = (_, { signal }) => new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('Fixture aborted'), { name: 'AbortError' }));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    requests.push({ resolve, signal });
  });
  return requests;
}
const imageMessage = messageId => ({ ...message(messageId), message: [{ type: 'image', data: { file: 'https://offline.invalid/fixture.gif' } }] });
async function appFixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qq-recall-cache-tests-')), configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ target_type: 'group', group_id: GROUP, group_name: 'offline group',
    auto_start: true, auto_resend: true, resend_self: true, auto_recovery: false, send_interval_seconds: 0,
    command_account: SELF, command_allow_others: false, command_permissions: [], ...overrides }));
  const app = new PrivateRecallApp({ configPath, logger: () => {} }); await app.initialize();
  app.selfId = SELF; app.connected = true; app.onlineConfirmed = true;
  app.groups = [{ type: 'group', id: GROUP, name: 'offline group' }]; app.activate(app.groups[0]);
  const sends = [], api = { call: async (action, body) => { sends.push({ action, body }); return { message_id: 90000 + sends.length }; } };
  t.after(async () => { await app.shutdown();await app.ai.settingsFile.task.catch(()=>{});await app.ai.diagnostics.file.task.catch(()=>{});await rm(dir,{recursive:true,force:true}); });
  return { app, api, sends, configPath };
}

test('cache defaults and all user setting bounds are finite and validated', () => {
  assert.equal(DEFAULTS.recent_messages_per_chat, 200); assert.equal(DEFAULTS.message_cache_ttl_ms, 1800000);
  assert.equal(DEFAULTS.recall_match_wait_ms, 3000);
  for (const [limit, minutes] of [[9, 30], [1001, 30], [20.5, 30], [200, 0], [200, 121], [200, 1.5], ['200', 30]]) {
    assert.throws(() => validateCacheSettings(limit, minutes));
  }
  assert.deepEqual(validateCacheSettings(1000, 120), { cache_messages_per_chat: 1000, cache_ttl_minutes: 120 });
});
test('the default cache keeps and resends messages beyond the former ten-message boundary', async t => {
  const f = fixture(t); for (let n = 0; n < 30; n++) await f.engine.handle(message(70001 + n), f.api);
  assert.equal(f.engine.cacheSnapshot().cached, 30);
  assert.equal(await f.engine.handle(recall(), f.api), 'sent'); assert.equal(f.sends.length, 1);
});
test('capacity eviction remains strict FIFO and evicted messages are not restored by duplicate events', async t => {
  const f = fixture(t, { recent_messages_per_chat: 10 });
  for (let n = 0; n < 11; n++) await f.engine.handle(message(70001 + n), f.api);
  assert.equal(f.engine.cacheSnapshot().cached, 10); assert.equal(f.engine.cacheSnapshot().capacity_evictions, 1);
  assert.equal(await f.engine.handle(recall(), f.api), 'missing');
  assert.equal(await f.engine.handle(message(), f.api), 'duplicate-message'); assert.equal(f.sends.length, 0);
});
test('TTL releases idle original bodies without needing another message or page refresh', async t => {
  const f = fixture(t, { message_cache_ttl_ms: 60000 }); await f.engine.handle(message(), f.api);
  const original = [...f.engine.messages.items.values()][0];
  await f.clock.advance(60000);
  assert.equal(f.engine.messages.items.size, 0); assert.deepEqual(original.message, []);
  assert.equal(original.controller.signal.aborted, true); assert.equal(f.engine.cacheSnapshot().expired, 1);
  assert.equal(await f.engine.handle(recall(), f.api), 'missing');
});
test('cache reads never extend original arrival TTL', async t => {
  const f = fixture(t, { message_cache_ttl_ms: 60000 }); await f.engine.handle(message(), f.api);
  await f.clock.advance(59000); assert.equal(f.engine.cacheSnapshot().cached, 1);
  await f.clock.advance(1000); assert.equal(f.engine.cacheSnapshot().cached, 0);
});
test('reducing cache capacity or TTL immediately removes old entries and cannot resurrect them', async t => {
  const f = fixture(t); for (let n = 0; n < 20; n++) await f.engine.handle(message(70001 + n), f.api);
  f.engine.setCacheSettings(10, 30); assert.equal(f.engine.cacheSnapshot().cached, 10);
  await f.clock.advance(120000); f.engine.setCacheSettings(200, 1); assert.equal(f.engine.cacheSnapshot().cached, 0);
  f.engine.setCacheSettings(1000, 120); assert.equal(f.engine.cacheSnapshot().cached, 0);
});
test('recall arriving before its original matches once and duplicate notices stay silent', async t => {
  const f = fixture(t); const pending = f.engine.handle(recall(), f.api);
  assert.equal(f.engine.pendingRecalls.size, 1);
  assert.equal(await f.engine.handle(recall(), f.api), 'duplicate');
  assert.equal(await f.engine.handle(message(), f.api), 'cached');
  assert.equal(await pending, 'sent'); assert.equal(f.sends.length, 1);
  assert.equal(f.engine.cacheSnapshot().matched_early, 1); assert.equal(f.engine.pendingRecalls.size, 0);
  assert.deepEqual(f.sends.map(item => item.action), ['send_group_msg']);
});
test('same message ID in a different group or account cannot satisfy a pending recall', async t => {
  const f = fixture(t); const pending = f.engine.handle(recall(), f.api);
  assert.equal(await f.engine.handle({ ...message(), group_id: '50002' }, f.api), 'ignored');
  assert.equal(await f.engine.handle({ ...message(), self_id: '90002' }, f.api), 'ignored');
  assert.equal(f.engine.pendingRecalls.size, 1); assert.equal(f.sends.length, 0);
  await f.engine.handle(message(), f.api); assert.equal(await pending, 'sent');
});
test('a wrong author pending notice cannot consume or block the valid original', async t => {
  const f = fixture(t); const wrong = f.engine.handle(recall(70001, '60002', ADMIN), f.api);
  const correct = f.engine.handle(recall(70001, AUTHOR, ADMIN), f.api);
  await f.engine.handle(message(), f.api); assert.equal(await correct, 'sent');
  await f.clock.advance(3000); assert.equal(await wrong, 'missing'); assert.equal(f.sends.length, 1);
});
test('expired pending recalls do not replay when the original or duplicate recall arrives later', async t => {
  const f = fixture(t); const pending = f.engine.handle(recall(), f.api);
  await f.clock.advance(3000); assert.equal(await pending, 'missing');
  await f.engine.handle(message(), f.api);
  assert.equal(await f.engine.handle(recall(), f.api), 'duplicate'); assert.equal(f.sends.length, 0);
  assert.equal(f.engine.cacheSnapshot().wait_timeouts, 1);
});
test('pending recall matching has a strict fifty-item limit and a single deadline per item', async t => {
  const f = fixture(t); const pending = [];
  for (let n = 0; n < 51; n++) pending.push(f.engine.handle(recall(70001 + n), f.api));
  assert.equal(f.engine.pendingRecalls.size, 50); assert.equal(f.engine.cacheSnapshot().wait_queue_full, 1);
  await f.clock.advance(3000); assert.deepEqual(await Promise.all(pending), Array(51).fill('missing'));
  assert.equal(f.engine.pendingRecalls.size, 0); assert.equal(f.sends.length, 0);
});
test('disconnect or stop clearing cancels pending recalls and never replays them on later arrivals', async t => {
  const f = fixture(t); const pending = f.engine.handle(recall(), f.api); f.engine.clear();
  assert.equal(await pending, 'cancelled'); await f.engine.handle(message(), f.api);
  assert.equal(f.sends.length, 0); assert.equal(f.engine.pendingRecalls.size, 0);
});
test('a recall first observed while disabled remains local after re-enabling before its original arrives', async t => {
  const f = fixture(t, { auto_resend: false }); const pending = f.engine.handle(recall(), f.api);
  f.engine.config.auto_resend = true; await f.engine.handle(message(), f.api);
  assert.equal(await pending, 'shown'); assert.equal(f.sends.length, 0); assert.equal(f.records.length, 1);
});
test('turning resend off then on during matching cancels the old recall permanently', async t => {
  const f = fixture(t); const pending = f.engine.handle(recall(), f.api);
  f.engine.config.auto_resend = false; f.engine.cancelPendingSends(); f.engine.config.auto_resend = true;
  await f.engine.handle(message(), f.api); assert.equal(await pending, 'cancelled'); assert.equal(f.sends.length, 0);
});
test('removing an original-author exemption while waiting does not retroactively resend it', async t => {
  const f = fixture(t, { resend_exempt_qq_ids: [AUTHOR] }); const pending = f.engine.handle(recall(), f.api);
  f.engine.setResendExemptions([]); await f.engine.handle(message(), f.api);
  assert.equal(await pending, 'exempt'); assert.equal(f.sends.length, 0);
});
test('adding then removing an exemption while waiting still suppresses the already observed recall', async t => {
  const f = fixture(t); const pending = f.engine.handle(recall(), f.api);
  f.engine.setResendExemptions([AUTHOR]); f.engine.setResendExemptions([]);
  await f.engine.handle(message(), f.api); assert.equal(await pending, 'exempt'); assert.equal(f.sends.length, 0);
});
test('only whitelisting the operator does not exempt a delayed original author', async t => {
  const f = fixture(t, { resend_exempt_qq_ids: [ADMIN] }); const pending = f.engine.handle(recall(70001, AUTHOR, ADMIN), f.api);
  await f.engine.handle(message(), f.api); assert.equal(await pending, 'sent'); assert.equal(f.sends.length, 1);
});
test('turning own-message support off then on while matching never replays that own recall', async t => {
  const f = fixture(t); const pending = f.engine.handle(recall(70001, SELF, ADMIN), f.api);
  f.engine.setSelfRecall(false); f.engine.setSelfRecall(true); await f.engine.handle(message(70001, SELF), f.api);
  assert.equal(await pending, 'ignored'); assert.equal(f.sends.length, 0);
});
test('delayed own private recall requires the original cached self message in the configured friend scope', async t => {
  const f = fixture(t, { group_ids: [], friend_ids: [AUTHOR] });
  const pending = f.engine.handle({ post_type: 'notice', notice_type: 'friend_recall', self_id: SELF, user_id: SELF, message_id: 70001 }, f.api);
  await f.engine.handle({ post_type: 'message_sent', message_type: 'private', self_id: SELF, target_id: AUTHOR,
    user_id: SELF, message_id: 70001, message: text('private original') }, f.api);
  assert.equal(await pending, 'sent'); assert.equal(f.sends[0].body.user_id, Number(AUTHOR));
  assert.deepEqual(f.sends[0].body.message, text('private original'));
});
test('media preparation tolerates a burst beyond ten messages and duplicate recall while preparing', async t => {
  const f = fixture(t), requests = blockedMedia(f);
  await f.engine.handle(imageMessage(70001), f.api); await flush();
  const pending = f.engine.handle(recall(), f.api);
  assert.equal(await f.engine.handle(recall(), f.api), 'duplicate');
  for (let n = 0; n < 30; n++) await f.engine.handle(message(70002 + n), f.api);
  requests[0].resolve(new Response(Uint8Array.from([71, 73, 70, 56]), { headers: { 'content-type': 'image/gif' } }));
  assert.equal(await pending, 'sent'); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].body.message[1].data.file, 'base64://R0lGOA==');
});
test('a recalled image waiting behind two downloads has bounded preparation and falls back to its original URL', async t => {
  const f = fixture(t); blockedMedia(f);
  for (let n = 0; n < 3; n++) await f.engine.handle(imageMessage(70001 + n), f.api);
  await flush(); assert.equal(f.engine.downloadActive, 2); assert.equal(f.engine.downloadWaiters.length, 1);
  const pending = f.engine.handle(recall(70003), f.api); await f.clock.advance(5000);
  assert.equal(await pending, 'sent'); assert.equal(f.engine.downloadWaiters.length, 0);
  assert.equal(f.sends[0].body.message[1].data.file, 'https://offline.invalid/fixture.gif');
  assert.equal(f.engine.cacheSnapshot().media_wait_timeouts, 1);
});
test('capacity eviction during media preparation aborts the old body and cannot send it', async t => {
  const f = fixture(t, { recent_messages_per_chat: 10 }); blockedMedia(f);
  await f.engine.handle(imageMessage(70001), f.api); const pending = f.engine.handle(recall(), f.api);
  for (let n = 0; n < 10; n++) await f.engine.handle(message(70002 + n), f.api);
  assert.equal(await pending, 'evicted'); assert.equal(f.sends.length, 0);
});
test('TTL expiry during media preparation cannot send an expired body', async t => {
  const f = fixture(t, { message_cache_ttl_ms: 60000 }); blockedMedia(f);
  await f.engine.handle(imageMessage(70001), f.api); await f.clock.advance(59000);
  const pending = f.engine.handle(recall(), f.api); await f.clock.advance(1000);
  assert.equal(await pending, 'evicted'); assert.equal(f.sends.length, 0);
});
test('app counters and the unified template are correct for actual concurrent event entry points', async t => {
  const f = await appFixture(t); const pending = f.app.onEvent(recall(70001, AUTHOR, ADMIN), f.api);
  await flush(); await f.app.onEvent(message(), f.api); await pending;
  assert.equal(f.app.sentCount, 1); assert.equal(f.app.missingCount, 0);
  assert.equal(f.sends.map(item => item.body.message.map(segment => segment.data.text).join('')).join(''), '60003撤回b发送的：a');
});
test('cache preferences persist without persisting original message bodies or changing old rules', async t => {
  const f = await appFixture(t, { resend_exempt_qq_ids: [ADMIN] });
  await f.app.onEvent(message(70001, AUTHOR, 'PRIVATE_OFFLINE_BODY_MUST_STAY_IN_MEMORY'), f.api);
  await f.app.setCacheSettings(80, 5);
  const savedText = await readFile(f.configPath, 'utf8'), saved = JSON.parse(savedText);
  assert.equal(saved.cache_messages_per_chat, 80); assert.equal(saved.cache_ttl_minutes, 5);
  assert.ok(!savedText.includes('PRIVATE_OFFLINE_BODY_MUST_STAY_IN_MEMORY'));
  assert.equal(saved.group_id, GROUP); assert.equal(saved.auto_resend, true); assert.equal(saved.resend_self, true);
  assert.deepEqual(saved.resend_exempt_qq_ids, [ADMIN]);
  const restored = new PrivateRecallApp({ configPath: f.configPath, logger: () => {} }); await restored.initialize();
  assert.equal(restored.preferences.cache_messages_per_chat, 80); assert.equal(restored.preferences.cache_ttl_minutes, 5);
  await restored.shutdown();
});
test('a save failure leaves current engine cache settings and old preferences intact', async t => {
  const f = await appFixture(t); const before = f.app.engine.cacheSnapshot();
  f.app.savePreferences = async () => { throw new Error('Fixture save failure'); };
  await assert.rejects(f.app.setCacheSettings(80, 5));
  assert.equal(f.app.preferences.cache_messages_per_chat, 200); assert.equal(f.app.preferences.cache_ttl_minutes, 30);
  assert.equal(f.app.engine.cacheSnapshot().limit, before.limit);
});
test('off/on commands keep exact replies and do not revive a pending recall', async t => {
  const f = await appFixture(t);f.app.onlineConfirmed=true;f.app.ai.config.api_model='synthetic';f.app.ai.auth.meta.api_configured=true;f.app.ai.auth.meta.api_binding={platform:'custom',base_url:f.app.ai.config.api_base_url,format:f.app.ai.config.api_format}; const pending = f.app.onEvent(recall(), f.api); await flush();
  await f.app.onEvent(message(70002, SELF, '关机'), f.api);
  await f.app.onEvent(message(70003, SELF, '开机'), f.api);
  await f.app.onEvent(message(), f.api); await pending;
  assert.deepEqual(f.sends.map(item => item.body.message[0].data.text), ['关了', '开了']);
  assert.equal(f.app.sentCount, 0); assert.equal(f.app.preferences.auto_resend, true);
});
test('HTTP cache settings reject invalid values and retain original target and other preferences', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-recall-cache-http-')), configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ auto_recovery: false, target_type: 'group', group_id: GROUP, resend_self: true }));
  const running = await startApp({ configPath, discover: async () => [], logger: () => {} });
  t.after(async () => { await running.close(); await rm(configPath, { force: true }); await rm(configPath + '.tmp', { force: true }); await rmdir(dir); });
  const post = body => fetch(running.url + 'api/cache-settings', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'x-qq-recall-session': running.app.session }, body: JSON.stringify(body) });
  assert.equal((await post({ limit: 80, ttl_minutes: 5 })).status, 200);
  assert.equal((await post({ limit: 1001, ttl_minutes: 5 })).status, 400);
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.cache_messages_per_chat, 80); assert.equal(saved.cache_ttl_minutes, 5);
  assert.equal(saved.group_id, GROUP); assert.equal(saved.resend_self, true);
});

test('an out-of-order image original matches before preparation and still sends exactly once', async t => {
  const f = fixture(t), requests = blockedMedia(f);
  const pending = f.engine.handle(recall(), f.api);
  await f.engine.handle(imageMessage(70001), f.api); await flush();
  assert.equal(await f.engine.handle(recall(), f.api), 'duplicate');
  requests[0].resolve(new Response(Uint8Array.from([71, 73, 70, 56]), { headers: { 'content-type': 'image/gif' } }));
  assert.equal(await pending, 'sent'); assert.equal(f.sends.length, 1); assert.equal(f.engine.cacheSnapshot().matched_early, 1);
});
test('the production-width matching window also accepts original arrival shortly before its deadline', async t => {
  const f = fixture(t); const pending = f.engine.handle(recall(), f.api);
  await f.clock.advance(2999); await f.engine.handle(message(), f.api);
  assert.equal(await pending, 'sent'); assert.equal(f.engine.cacheSnapshot().wait_timeouts, 0);
});
test('a matched recall that expires while queued is cancelled before calling the QQ send interface', async t => {
  const f = fixture(t, { message_cache_ttl_ms: 60000 }); let task, complete;
  f.engine.sendQueue = { cancel() {}, enqueue(fn) { task = fn; return new Promise(resolve => { complete = resolve; }); } };
  await f.engine.handle(message(), f.api); const pending = f.engine.handle(recall(), f.api);
  await f.clock.advance(60000); complete(await task(new AbortController().signal));
  assert.equal(await pending, 'cancelled'); assert.equal(f.sends.length, 0);
});
test('events predating a cleared monitoring session do not become history replays', async t => {
  const f = fixture(t); await f.clock.advance(1000000); f.engine.clear();
  assert.equal(await f.engine.handle({ ...message(), time: 997 }, f.api), 'ignored');
  assert.equal(await f.engine.handle({ ...recall(), time: 997 }, f.api), 'ignored');
  assert.equal(f.engine.pendingRecalls.size, 0);
  await f.engine.handle({ ...message(70002), time: 1000 }, f.api);
  assert.equal(await f.engine.handle({ ...recall(70002), time: 1000 }, f.api), 'sent');
});
test('received inline media shares the bounded media budget and is released on expiry', async t => {
  const f = fixture(t, { message_cache_ttl_ms: 60000, media_cache_limit_mb: 1, media_file_limit_mb: 1 });
  const inline = 'base64://' + Buffer.alloc(800000).toString('base64');
  const one = { ...message(), message: [{ type: 'image', data: { file: inline } }] };
  assert.equal(await f.engine.handle(one, f.api), 'cached'); assert.equal(f.engine.mediaBytes, 800000);
  assert.equal(await f.engine.handle({ ...one, message_id: 70002 }, f.api), 'cache-limit');
  assert.equal(f.engine.cacheSnapshot().resource_rejections, 1); assert.equal(f.engine.messages.items.size, 1);
  await f.clock.advance(60000); assert.equal(f.engine.mediaBytes, 0);
});
test('whitelist changes while media is being prepared cannot revive an already exempt recall', async t => {
  const f = fixture(t); const requests = blockedMedia(f);
  await f.engine.handle(imageMessage(70001), f.api); await flush();
  const pending = f.engine.handle(recall(), f.api);
  f.engine.setResendExemptions([AUTHOR]); f.engine.setResendExemptions([]);
  requests[0].resolve(new Response(Uint8Array.from([71, 73, 70, 56])));
  assert.equal(await pending, 'exempt'); assert.equal(f.sends.length, 0);
});
