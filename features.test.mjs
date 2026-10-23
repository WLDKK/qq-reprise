import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, RecallReposter, validateResendExemptions } from './engine.mjs';
import { ResendQueue } from './send-queue.mjs';
import { PrivateRecallApp, startApp } from './qq-recall.mjs';
import { validateCommandReplies, defaultCommandReplies } from './command-confirmations.mjs';

const SELF = '90001', AUTHOR = '60001', OTHER = '60002', ADMIN = '60003', GROUP = '50001';
const text = value => [{ type: 'text', data: { text: value } }];
function message(author = AUTHOR, messageId = 70001, value = 'offline fixture', group = GROUP) {
  return { post_type: 'message', message_type: 'group', self_id: SELF, group_id: group,
    user_id: author, message_id: messageId, message: text(value) };
}
const recall = (author = AUTHOR, messageId = 70001, operator = author) => ({
  post_type: 'notice', notice_type: 'group_recall', self_id: SELF, group_id: GROUP,
  user_id: author, operator_id: operator, message_id: messageId,
});
function engineFixture(exempt = [], queue = new ResendQueue({ intervalMs: 0, jitterMs: 0 })) {
  const sends = [], states = [], records = [];
  const engine = new RecallReposter({ ...DEFAULTS, group_ids: [GROUP], expected_self_id: SELF,
    auto_resend: true, ignore_self_messages: false, recent_messages_per_chat: 10, recall_match_wait_ms: 10, resend_exempt_qq_ids: exempt }, () => {}, Date.now,
    async () => { throw new Error('Network forbidden in fixture'); }, queue);
  engine.onRecall = record => records.push(record);
  engine.onSendState = (_, state) => states.push(state);
  const api = { call: async (action, body) => { sends.push({ action, body }); return { message_id: 80000 + sends.length }; } };
  return { engine, api, sends, states, records, queue };
}
async function appFixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qq-recall-feature-tests-'));
  const configPath = join(dir, 'preferences.json');
  const preferences = { target_type: 'group', group_id: GROUP, group_name: 'offline group',
    auto_start: true, auto_resend: false, resend_self: true, auto_recovery: false,
    send_interval_seconds: 0, command_on: '开机', command_off: '关机',
    command_allow_others: false, command_permissions: [], command_account: SELF, ...overrides };
  await writeFile(configPath, JSON.stringify(preferences), 'utf8');
  const app = new PrivateRecallApp({ configPath, logger: () => {} });
  await app.initialize();
  app.selfId = SELF; app.connected = true; app.onlineConfirmed = true;
  app.ai.config.api_model = 'synthetic-command-model';app.ai.auth.meta.api_configured=true;
  app.ai.auth.meta.api_binding={platform:'custom',base_url:app.ai.config.api_base_url,format:app.ai.config.api_format};
  app.groups = [{ type: 'group', id: GROUP, name: 'offline group' }];
  app.activate(app.groups[0]);
  const sends = [];
  const api = { call: async (action, body) => { sends.push({ action, body }); return { message_id: 81000 + sends.length }; } };
  t.after(async () => {
    app.engine?.clear(); await app.resendTask.catch(() => {}); await app.saveTask.catch(() => {});
    app.ai.dispose();await app.ai.settingsFile.task.catch(()=>{});await app.ai.diagnostics.file.task.catch(()=>{});await rm(dir,{recursive:true,force:true});
  });
  return { app, api, sends, configPath, preferences };
}

test('whitelist defaults empty and accepts only bounded, normalized QQ IDs', () => {
  assert.deepEqual(validateResendExemptions(''), []);
  assert.deepEqual(validateResendExemptions('60001，60002\n60001 ; 60003'), [AUTHOR, OTHER, ADMIN]);
  for (const value of [['nickname'], ['00001'], ['-60001'], [null], [{}], ['1e5'], ['1234'], ['1234567890123'], null]) {
    assert.throws(() => validateResendExemptions(value));
  }
  assert.throws(() => validateResendExemptions(Array.from({ length: 101 }, (_, index) => String(10000 + index))));
});

test('a whitelisted original author is shown locally without entering the send queue', async () => {
  const f = engineFixture([AUTHOR]);
  await f.engine.handle(message(), f.api);
  assert.equal(await f.engine.handle(recall(), f.api), 'exempt');
  assert.equal(f.sends.length, 0); assert.equal(f.queue.pendingCount, 0);
  assert.equal(f.records[0].author_id, AUTHOR); assert.ok(f.states.includes('exempt'));
});

test('a non-whitelisted author keeps the original group and normal resend behavior', async () => {
  const f = engineFixture([OTHER]);
  await f.engine.handle(message(), f.api);
  assert.equal(await f.engine.handle(recall(), f.api), 'sent');
  assert.equal(f.sends[0].action, 'send_group_msg'); assert.equal(f.sends[0].body.group_id, Number(GROUP));
});

test('whitelisting a group administrator does not exempt another original author', async () => {
  const f = engineFixture([ADMIN]); await f.engine.handle(message(), f.api);
  assert.equal(await f.engine.handle(recall(AUTHOR, 70001, ADMIN), f.api), 'sent');
  assert.equal(f.sends.length, 1);
});

test('a whitelisted author remains exempt when a different administrator retracts it', async () => {
  const f = engineFixture([AUTHOR]); await f.engine.handle(message(), f.api);
  assert.equal(await f.engine.handle(recall(AUTHOR, 70001, ADMIN), f.api), 'exempt');
  assert.equal(f.sends.length, 0);
});

test('a third-party recall uses the exact unified template with the original body', async () => {
  const f = engineFixture();
  await f.engine.handle({ ...message(ADMIN, 70000), sender: { user_id: ADMIN, card: '管理员乙', nickname: '备用昵称' } }, f.api);
  await f.engine.handle({ ...message(), sender: { user_id: AUTHOR, card: '作者甲', nickname: '备用作者' } }, f.api);
  assert.equal(await f.engine.handle(recall(AUTHOR, 70001, ADMIN), f.api), 'sent');
  assert.deepEqual(f.sends[0].body.message, [
    ...text('管理员乙撤回作者甲发送的：'), ...text('offline fixture'),
  ]);
  assert.equal(f.records[0].author_id, AUTHOR); assert.equal(f.records[0].operator_id, ADMIN);
  assert.equal(f.records[0].operator_name, '管理员乙'); assert.equal(f.records[0].recall_kind, 'other');
  assert.deepEqual(f.records[0].message, text('offline fixture'));
});

test('self recall is explicitly distinguished from a third-party recall', async () => {
  const f = engineFixture(); await f.engine.handle(message(), f.api);
  assert.equal(await f.engine.handle(recall(), f.api), 'sent');
  assert.equal(f.records[0].recall_kind, 'self');
  assert.equal(f.records[0].operator_id, AUTHOR);
  assert.equal(f.sends[0].body.message[0].data.text, '60001撤回：');
});

test('missing operator stays unknown without guessing it is the author', async () => {
  for (const operator of [undefined, null, '', 0, 'invalid', '-60003']) {
    const f = engineFixture(); await f.engine.handle(message(), f.api);
    assert.equal(await f.engine.handle({ ...recall(AUTHOR, 70001, ADMIN), operator_id: operator }, f.api), 'sent');
    assert.equal(f.records[0].operator_id, null); assert.equal(f.records[0].recall_kind, 'unknown');
    assert.equal(f.sends[0].body.message[0].data.text, '未知操作者撤回60001发送的：');
  }
});

test('an uncached operator name uses its known QQ ID and never borrows the author name', async () => {
  const f = engineFixture();
  await f.engine.handle({ ...message(), sender: { user_id: AUTHOR, nickname: '作者甲' } }, f.api);
  await f.engine.handle({ ...recall(AUTHOR, 70001, ADMIN), operator_name: 'untrusted event name' }, f.api);
  assert.equal(f.sends[0].body.message[0].data.text, '60003撤回作者甲发送的：');
});

test('operator identities do not cross the selected group or survive an evicted message', async () => {
  const f = engineFixture();
  assert.equal(await f.engine.handle({ ...message(ADMIN, 69999, 'other group', '50002'),
    sender: { user_id: ADMIN, card: 'other group name' } }, f.api), 'ignored');
  await f.engine.handle({ ...message(ADMIN, 70000), sender: { user_id: ADMIN, card: 'expired name' } }, f.api);
  for (let index = 1; index <= 10; index++) await f.engine.handle(message(AUTHOR, 70000 + index), f.api);
  await f.engine.handle(recall(AUTHOR, 70010, ADMIN), f.api);
  assert.equal(f.records[0].operator_name, '');
  assert.equal(f.records[0].recall_label, '60003撤回60001发送的');
});

test('concurrent duplicate third-party recalls produce exactly one queue entry and send', async () => {
  const f = engineFixture(); await f.engine.handle(message(), f.api);
  const results = await Promise.all([f.engine.handle(recall(AUTHOR, 70001, ADMIN), f.api),
    f.engine.handle(recall(AUTHOR, 70001, ADMIN), f.api)]);
  assert.deepEqual(results, ['sent', 'duplicate']); assert.equal(f.sends.length, 1); assert.equal(f.records.length, 1);
});

test('an invalid author notice cannot suppress a later valid administrator recall', async () => {
  const f = engineFixture(); await f.engine.handle(message(), f.api);
  assert.equal(await f.engine.handle(recall(OTHER, 70001, ADMIN), f.api), 'missing');
  assert.equal(await f.engine.handle(recall(AUTHOR, 70001, ADMIN), f.api), 'sent');
  assert.equal(f.records[0].author_id, AUTHOR); assert.equal(f.sends.length, 1);
});

test('third-party recall without an original body never constructs or sends a replacement', async () => {
  const f = engineFixture();
  assert.equal(await f.engine.handle(recall(AUTHOR, 70001, ADMIN), f.api), 'missing');
  await f.engine.handle(message(AUTHOR, 70002, ''), f.api);
  // An empty text segment is valid OneBot data, but an empty prepared message is not.
  await f.engine.handle({ ...message(AUTHOR, 70003), message: [] }, f.api);
  assert.equal(await f.engine.handle(recall(AUTHOR, 70003, ADMIN), f.api), 'missing');
  assert.equal(f.records.length, 0); assert.equal(f.sends.length, 0);
});

test('the off switch keeps both third-party identities in local records without sending', async () => {
  const f = engineFixture(); f.engine.config.auto_resend = false;
  await f.engine.handle(message(), f.api);
  assert.equal(await f.engine.handle(recall(AUTHOR, 70001, ADMIN), f.api), 'shown');
  assert.equal(f.records[0].operator_id, ADMIN); assert.equal(f.sends.length, 0);
});

test('the existing own-author switch is preserved and an enabled own author is omitted', async () => {
  const f = engineFixture(); await f.engine.handle(message(SELF), f.api);
  f.engine.config.ignore_self_messages = true;
  assert.equal(await f.engine.handle(recall(SELF, 70001, ADMIN), f.api), 'ignored');
  f.engine.setSelfRecall(true);
  assert.equal(await f.engine.handle(recall(SELF, 70001, ADMIN), f.api), 'sent');
  assert.equal(f.sends[0].body.message[0].data.text, '60003撤回了：');
  await f.engine.handle(message(SELF, 70002, 'own original'), f.api);
  assert.equal(await f.engine.handle(recall(SELF, 70002, SELF), f.api), 'sent');
  assert.deepEqual(f.sends[1].body.message, text('own original'));
});

test('third-party attribution remains a plain text segment ahead of original media', async () => {
  const f = engineFixture();
  const media = [{ type: 'image', data: { file: 'base64://R0lGODlh', summary: 'fixture gif' } }];
  await f.engine.handle({ ...message(), message: media, sender: { user_id: AUTHOR, card: '作者\n甲\t' } }, f.api);
  await f.engine.handle(recall(AUTHOR, 70001, ADMIN), f.api);
  assert.equal(f.sends[0].body.message[0].type, 'text');
  assert.equal(f.sends[0].body.message[0].data.text, '60003撤回作者 甲发送的：');
  assert.deepEqual(f.sends[0].body.message.slice(1), media);
});

test('app state preserves both identities and suppresses the echo and recall of its own attributed resend', async t => {
  const f = await appFixture(t, { auto_resend: true });
  let outputId;
  f.api.call = async (action, body) => {
    f.sends.push({ action, body }); outputId = 82001;
    // Simulate an own echo arriving before the send API response.
    await f.app.onEvent({ ...message(SELF, outputId), message: structuredClone(body.message) }, f.api);
    return { message_id: outputId };
  };
  await f.app.onEvent(message(AUTHOR, 70001, '开机'), f.api);
  await f.app.onEvent(recall(AUTHOR, 70001, ADMIN), f.api);
  const record = f.app.state().recalls[0];
  assert.equal(record.author_id, AUTHOR); assert.equal(record.operator_id, ADMIN);
  assert.equal(record.recall_kind, 'other'); assert.equal(record.recall_label, '60003撤回60001发送的');
  assert.equal(f.sends.length, 1); assert.equal(f.app.preferences.auto_resend, true);
  await f.app.onEvent(recall(SELF, outputId, ADMIN), f.api);
  assert.equal(f.sends.length, 1);
});

for (const scenario of [
  { name: 'b recalls their own a', author: AUTHOR, authorName: 'b', operator: AUTHOR, expected: 'b撤回：a' },
  { name: 'c recalls b original a', author: AUTHOR, authorName: 'b', operator: ADMIN, operatorName: 'c', expected: 'c撤回b发送的：a' },
  { name: 'c recalls the verified current user original a', author: SELF, authorName: '用户本名', operator: ADMIN, operatorName: 'c', expected: 'c撤回了：a' },
  { name: 'current user recalls their own a without attribution', author: SELF, authorName: '用户本名', operator: SELF, expected: 'a' },
  { name: 'current user is operator of b original a', author: AUTHOR, authorName: 'b', operator: SELF, operatorName: '用户本名', expected: '用户本名撤回b发送的：a' },
  { name: 'unknown operator recalls b original a', author: AUTHOR, authorName: 'b', operator: undefined, expected: '未知操作者撤回b发送的：a' },
  { name: 'unknown operator recalls the current user original a', author: SELF, authorName: '用户本名', operator: undefined, expected: '未知操作者撤回了：a' },
  { name: 'known c ID has no cached name', author: AUTHOR, authorName: 'b', operator: ADMIN, expected: '60003撤回b发送的：a' },
  { name: 'uncached author name keeps the original QQ fallback', author: AUTHOR, operator: ADMIN, operatorName: 'c', expected: 'c撤回60001发送的：a' },
  { name: 'a bot role or same display name is not the current user', author: AUTHOR, authorName: '用户本名', operator: ADMIN, operatorName: 'c', expected: 'c撤回用户本名发送的：a' },
]) {
  test('exact recall template: ' + scenario.name, async () => {
    const f = engineFixture();
    f.engine.config.message_prefix = 'legacy group prefix must not be added';
    if (scenario.operatorName) {
      await f.engine.handle({ ...message(scenario.operator, 70000),
        sender: { user_id: scenario.operator, card: scenario.operatorName } }, f.api);
    }
    await f.engine.handle({ ...message(scenario.author, 70001, 'a'),
      sender: { user_id: scenario.author, nickname: scenario.authorName, role: 'bot' } }, f.api);
    const notice = { ...recall(scenario.author, 70001), operator_id: scenario.operator };
    assert.equal(await f.engine.handle(notice, f.api), 'sent');
    assert.equal(f.sends[0].body.message.map(segment => segment.data.text).join(''), scenario.expected);
    assert.deepEqual(f.sends[0].body.message.at(-1), text('a')[0]);
    assert.equal(f.records[0].author_id, scenario.author);
    if (scenario.author === SELF) assert.ok(!f.records[0].recall_label.includes('用户本名'));
    if (scenario.author === SELF && scenario.operator === SELF) assert.equal(f.records[0].recall_label, '');
  });
}

test('the verified current account guard rejects a different self_id before applying templates', async () => {
  const f = engineFixture();
  await f.engine.handle({ ...message(SELF, 70001, 'a'), sender: { user_id: SELF, nickname: '用户本名' } }, f.api);
  assert.equal(await f.engine.handle({ ...recall(SELF, 70001, ADMIN), self_id: OTHER }, f.api), 'ignored');
  assert.equal(f.sends.length, 0); assert.equal(f.records.length, 0);
});

test('missing authors, absent cache and mismatched notices never fall back to the operator', async () => {
  const f = engineFixture([OTHER]);
  assert.equal(await f.engine.handle(recall(), f.api), 'missing');
  await f.engine.handle(message(AUTHOR, 70002), f.api);
  assert.equal(await f.engine.handle({ ...recall(AUTHOR, 70002, ADMIN), user_id: undefined }, f.api), 'ignored');
  assert.equal(await f.engine.handle(recall(OTHER, 70002, AUTHOR), f.api), 'missing');
  assert.equal(f.sends.length, 0);
});

test('private-chat and own-message exemptions use the cached original author', async () => {
  const sends = [];
  const engine = new RecallReposter({ ...DEFAULTS, friend_ids: [AUTHOR], expected_self_id: SELF,
    auto_resend: true, ignore_self_messages: false, resend_exempt_qq_ids: [SELF], send_interval_ms: 0 });
  const api = { call: async (...args) => { sends.push(args); return { message_id: 80000 }; } };
  await engine.handle({ post_type: 'message_sent', message_type: 'private', self_id: SELF, user_id: SELF,
    target_id: AUTHOR, message_id: 70001, message: text('offline own fixture') }, api);
  assert.equal(await engine.handle({ post_type: 'notice', notice_type: 'friend_recall', self_id: SELF,
    user_id: AUTHOR, message_id: 70001 }, api), 'exempt');
  assert.equal(sends.length, 0);
});

test('updating whitelist cancels that author in current wait and leaves other authors queued', async () => {
  let clock = 0;
  const waits = [];
  const queue = new ResendQueue({ intervalMs: 1000, jitterMs: 0, now: () => clock,
    wait: (_, signal) => new Promise((resolve, reject) => {
      waits.push(resolve); signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })), { once: true });
    }) });
  const f = engineFixture([], queue);
  await f.engine.handle(message(AUTHOR, 70001), f.api); await f.engine.handle(message(OTHER, 70002), f.api);
  const first = f.engine.handle(recall(AUTHOR, 70001), f.api), second = f.engine.handle(recall(OTHER, 70002), f.api);
  f.engine.setResendExemptions([AUTHOR]);
  await new Promise(resolve => setImmediate(resolve));
  clock = 1000; for (const release of waits) release();
  assert.deepEqual(await Promise.all([first, second]), ['exempt', 'sent']);
  assert.equal(f.sends.length, 1); assert.equal(f.records[1].author_id, OTHER);
});

test('actual-send check blocks exempt authors even if a queue cannot cancel a selected task', async () => {
  let task, complete;
  const queue = { cancel() {}, enqueue(fn) { task = fn; return new Promise(resolve => { complete = resolve; }); } };
  const f = engineFixture([], queue); await f.engine.handle(message(), f.api);
  const pending = f.engine.handle(recall(), f.api);
  f.engine.setResendExemptions([AUTHOR]);
  complete(await task(new AbortController().signal));
  assert.equal(await pending, 'exempt'); assert.equal(f.sends.length, 0);
});

test('removing an exemption does not replay an already handled withdrawal', async () => {
  const f = engineFixture([AUTHOR]); await f.engine.handle(message(), f.api);
  assert.equal(await f.engine.handle(recall(), f.api), 'exempt');
  f.engine.setResendExemptions([]);
  assert.equal(await f.engine.handle(recall(), f.api), 'duplicate'); assert.equal(f.sends.length, 0);
});

test('an API request already submitted cannot be retroactively cancelled', async () => {
  const f = engineFixture(); let complete;
  f.api.call = async () => { f.sends.push('submitted'); return new Promise(resolve => { complete = resolve; }); };
  await f.engine.handle(message(), f.api); const pending = f.engine.handle(recall(), f.api);
  f.engine.setResendExemptions([AUTHOR]); complete({ message_id: 80000 });
  assert.equal(await pending, 'sent'); assert.equal(f.sends.length, 1);
});

test('saved whitelist survives restart without changing target, self rule or command authorization', async t => {
  const f = await appFixture(t, { resend_self: true, command_allow_others: true,
    command_permissions: [{ type: 'group', peer_id: GROUP, user_id: OTHER, peer_name: 'fixture', user_name: 'fixture' }] });
  assert.deepEqual(f.app.state().resend_exempt_qq_ids, []);
  await f.app.setResendExemptions('60001,60002,60001');
  const app2 = new PrivateRecallApp({ configPath: f.configPath, logger: () => {} }); await app2.initialize();
  assert.deepEqual(app2.exemptQQIds, [AUTHOR, OTHER]);
  assert.equal(app2.preferences.group_id, GROUP); assert.equal(app2.preferences.resend_self, true);
  assert.equal(app2.preferences.command_permissions.length, 1); assert.equal(app2.preferences.command_allow_others, true);
});

test('invalid saved whitelist fails closed without dropping unrelated preferences', async t => {
  const f = await appFixture(t, { auto_resend: true, resend_exempt_qq_ids: ['nickname'] });
  assert.equal(f.app.state().auto_resend, false); assert.match(f.app.state().resend_exempt_error, /配置无效/);
  assert.equal(f.app.preferences.group_id, GROUP); assert.equal(f.app.preferences.resend_self, true);
  await assert.rejects(f.app.setResend(true));
  await assert.rejects(f.app.setResendExemptions(['bad']));
  await f.app.setResendExemptions([AUTHOR]); assert.equal(f.app.state().auto_resend, true);
});

test('confirmation defaults and validation prevent loops without reserving unused prefixes', () => {
  assert.deepEqual(defaultCommandReplies('开机', '关机'), { command_reply_on: '开了', command_reply_off: '关了' });
  for (const value of ['', 'x'.repeat(201), 'a\nb', '开机']) assert.throws(() => validateCommandReplies('开机', '关机', value, '关了'));
  assert.doesNotThrow(() => validateCommandReplies('当前已开启：开了', '关机', '开了', '关了'));
  const legacy = defaultCommandReplies('开了', '关了');
  assert.doesNotThrow(() => validateCommandReplies('开了', '关了', legacy.command_reply_on, legacy.command_reply_off));
});

test('custom on/off confirmation texts persist across restart', async t => {
  const f = await appFixture(t);
  await f.app.setCommands('开机', '关机', { reply_on: '正在工作', reply_off: '暂停了' });
  const app2 = new PrivateRecallApp({ configPath: f.configPath, logger: () => {} }); await app2.initialize();
  assert.equal(app2.preferences.command_reply_on, '正在工作'); assert.equal(app2.preferences.command_reply_off, '暂停了');
});

test('on and off confirmations occur only after persistence, including while resend is off', async t => {
  const f = await appFixture(t);
  f.api.call = async (action, body) => {
    const saved = JSON.parse(await readFile(f.configPath, 'utf8'));
    assert.equal(saved.auto_resend, body.message[0].data.text === '开了');
    f.sends.push({ action, body }); return { message_id: 81000 + f.sends.length };
  };
  await f.app.onEvent(message(SELF, 71001, '开机'), f.api);
  await f.app.onEvent(message(SELF, 71002, '关机'), f.api);
  assert.deepEqual(f.sends.map(item => item.body.message[0].data.text), ['开了', '关了']);
  assert.equal(f.app.preferences.auto_resend, false);
  assert.ok(f.sends.every(item => item.body.group_id === Number(GROUP)));
});

test('a repeated-state command confirms current state while a duplicate event is silent', async t => {
  const f = await appFixture(t);
  const command = message(SELF, 71001, '关机');
  await f.app.onEvent(command, f.api); await f.app.onEvent(command, f.api);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].body.message[0].data.text, '关了');
});

test('an already enabled command also replies exactly the configured default text', async t => {
  const f = await appFixture(t, { auto_resend: true });
  await f.app.onEvent(message(SELF, 71001, '开机'), f.api);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].body.message[0].data.text, '开了');
});

test('custom texts stay byte-exact for state changes, idempotent commands and restart', async t => {
  const f = await appFixture(t);
  const onReply = '  已开工 ✅  ', offReply = '  已休息 💤  ';
  await f.app.setCommands('开机', '关机', { reply_on: onReply, reply_off: offReply });
  for (const [index, command] of ['开机', '开机', '关机', '关机'].entries()) {
    await f.app.onEvent(message(SELF, 73000 + index, command), f.api);
  }
  assert.deepEqual(f.sends.map(item => item.body.message[0].data.text), [onReply, onReply, offReply, offReply]);
  const restarted = new PrivateRecallApp({ configPath: f.configPath, logger: () => {} });
  await restarted.initialize(); restarted.selfId = SELF; restarted.connected = true; restarted.onlineConfirmed=true;
  restarted.ai.auth.meta.api_configured=true;restarted.ai.auth.meta.api_binding={platform:'custom',base_url:restarted.ai.config.api_base_url,format:restarted.ai.config.api_format};
  restarted.activate({ type: 'group', id: GROUP, name: 'offline group' });
  await restarted.onEvent(message(SELF, 74001, '关机'), f.api);
  await restarted.onEvent(message(SELF, 74002, '开机'), f.api);
  assert.deepEqual(f.sends.slice(-2).map(item => item.body.message[0].data.text), [offReply, onReply]);
  const saved = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.equal(saved.command_reply_on, onReply); assert.equal(saved.command_reply_off, offReply);
  restarted.engine.clear();restarted.ai.dispose();await restarted.ai.settingsFile.task.catch(()=>{});
});

test('authorized control commands switch both features and send only one byte-exact confirmation',async t=>{
  const f=await appFixture(t);await f.app.setCommands('开机','关机',{reply_on:'  准备好了 ',reply_off:'暂停啦'});
  await f.app.onEvent(message(SELF,78001,'开机'),f.api);assert.equal(f.app.preferences.auto_resend,true);assert.equal(f.app.ai.config.enabled,true);assert.deepEqual(f.sends.map(s=>s.body.message[0].data.text),['  准备好了 ']);
  await f.app.onEvent(message(SELF,78002,'关机'),f.api);assert.equal(f.app.preferences.auto_resend,false);assert.equal(f.app.ai.config.enabled,false);assert.deepEqual(f.sends.map(s=>s.body.message[0].data.text),['  准备好了 ','暂停啦']);
});
test('combined enable fails closed when AI credentials are missing and never sends a false success confirmation',async t=>{
  const f=await appFixture(t);f.app.ai.auth.meta.api_configured=false;await f.app.onEvent(message(SELF,78003,'开机'),f.api);
  assert.equal(f.app.preferences.auto_resend,false);assert.equal(f.app.ai.config.enabled,false);assert.equal(f.app.combinedControlError,'api_key_required');assert.equal(f.sends.length,1);assert.match(f.sends[0].body.message[0].data.text,/未开启/);assert.doesNotMatch(f.sends[0].body.message[0].data.text,/已开启/);
});
test('combined enable does not clear an AI safety block or let ordinary users control either feature',async t=>{
  const f=await appFixture(t);f.app.ai.blocked=true;f.app.ai.error='authorization_required';await f.app.onEvent(message(SELF,78004,'开机'),f.api);
  assert.equal(f.app.ai.blocked,true);assert.equal(f.app.ai.error,'authorization_required');assert.equal(f.app.combinedControlError,'ai_safety_blocked');assert.equal(f.sends.length,1);assert.match(f.sends[0].body.message[0].data.text,/未开启/);
  await f.app.onEvent(message(OTHER,78005,'开机'),f.api);assert.equal(f.app.preferences.auto_resend,false);assert.equal(f.app.ai.config.enabled,false);assert.equal(f.sends.length,1);
});
test('combined off aborts an in-flight AI reply and late model output cannot revive after enable',async t=>{
  const f=await appFixture(t);let resolve,started=false;f.app.ai.provider={generate:async()=>{started=true;return new Promise(r=>{resolve=r})}};
  f.app.ai.config={...f.app.ai.config,enabled:true,binding_qq:SELF,groups:[GROUP],users:[AUTHOR],cooldown_seconds:0};
  f.app.ai.offer({...message(AUTHOR,78006,'你好'),message:[{type:'at',data:{qq:SELF}},{type:'text',data:{text:'你好'}}]});
  for(let n=0;n<100&&!started;n++)await new Promise(r=>setTimeout(r,2));assert.equal(started,true);
  await f.app.onEvent(message(SELF,78007,'关机'),f.api);assert.equal(f.app.ai.config.enabled,false);assert.equal(f.app.preferences.auto_resend,false);
  resolve('synthetic late AI answer');for(let n=0;n<100&&f.app.ai.active;n++)await new Promise(r=>setTimeout(r,2));
  await f.app.onEvent(message(SELF,78008,'开机'),f.api);assert.deepEqual(f.sends.map(s=>s.body.message[0].data.text),['关了','开了']);assert.equal(f.app.ai.outbox.snapshot().pending,0);assert.equal(f.app.ai.counts.generated,0);
});

test('unauthorized, anonymous and owner commands outside the original target cannot trigger replies', async t => {
  const f = await appFixture(t);
  await f.app.onEvent(message(OTHER, 71001, '开机'), f.api);
  await f.app.onEvent({ ...message(SELF, 71002, '开机'), anonymous: { id: 1 } }, f.api);
  await f.app.onEvent(message(SELF, 71003, '开机', '50002'), f.api);
  assert.equal(f.sends.length, 0); assert.equal(f.app.preferences.auto_resend, false);
});

test('authorized commands reply to their allowed source without moving the monitored group', async t => {
  const f = await appFixture(t, { command_allow_others: true,
    command_permissions: [{ type: 'group', peer_id: '50002', user_id: OTHER, peer_name: 'fixture', user_name: 'fixture' }] });
  await f.app.onEvent(message(OTHER, 71001, '开机', '50002'), f.api);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].body.group_id, 50002);
  assert.equal(f.app.target.id, GROUP); assert.equal(f.app.preferences.group_id, GROUP);
});

test('private authorized commands are confirmed only in the same private conversation', async t => {
  const f = await appFixture(t, { command_allow_others: true,
    command_permissions: [{ type: 'private', peer_id: OTHER, user_id: OTHER, peer_name: 'fixture', user_name: 'fixture' }] });
  await f.app.onEvent({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF,
    user_id: OTHER, message_id: 71001, message: text('开机') }, f.api);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].action, 'send_private_msg');
  assert.equal(f.sends[0].body.user_id, Number(OTHER)); assert.equal(f.app.target.id, GROUP);
});

test('confirmation echoes do not retrigger controls and their self-recall is resent at most once', async t => {
  const f = await appFixture(t);
  f.api.call = async (action, body) => {
    f.sends.push({ action, body });
    await f.app.onEvent(message(SELF, 82001, body.message[0].data.text), f.api);
    await f.app.onEvent(recall(SELF, 82001), f.api);
    return { message_id: 82001 };
  };
  await f.app.onEvent(message(SELF, 71001, '开机'), f.api);
  const count = f.app.engine.messages.items.size;
  await f.app.onEvent(message(SELF, 82001, '开了'), f.api);
  await f.app.onEvent(recall(SELF, 82001), f.api);
  assert.equal(f.app.engine.messages.items.size, count);assert.equal(count,2);assert.equal(f.sends.length,2);assert.equal(f.app.preferences.resend_self,true);
});

test('failed persistence rolls back the mode and never sends a success confirmation', async t => {
  const f = await appFixture(t);
  f.app.savePreferences = async () => { throw new Error('fixture write refused'); };
  await f.app.onEvent(message(SELF, 71001, '开机'), f.api);
  assert.equal(f.sends.length, 0); assert.equal(f.app.preferences.auto_resend, false);
  assert.equal(f.app.engine.config.auto_resend, false);
});

test('a bot resend that equals a control command cannot trigger another command confirmation', async t => {
  const f = await appFixture(t, { auto_resend: true });
  await f.app.engine.handle(message(SELF, 72001, '开机'), f.api);
  f.api.call = async (action, body) => {
    f.sends.push({ action, body });
    await f.app.onEvent(message(SELF, 82001, body.message[0].data.text), f.api);
    await f.app.onEvent(recall(SELF, 82001), f.api);
    return { message_id: 82001 };
  };
  await f.app.onEvent(recall(SELF, 72001), f.api);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].body.message[0].data.text, '开机');
  assert.equal(f.app.engine.messages.items.size, 2);
});

test('an uncertain confirmation leaves the persisted state intact and is not retried', async t => {
  const f = await appFixture(t); let attempts = 0;
  f.api.call = async () => { attempts++; throw new Error('fixture unknown result'); };
  const command = message(SELF, 71001, '开机');
  await f.app.onEvent(command, f.api); await f.app.onEvent(command, f.api);
  assert.equal(attempts, 1); assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).auto_resend, true);
  assert.ok(f.app.logs.some(item => item.message.includes('确认回复未获接口确认')));
});

test('concurrent on/off commands are persisted and acknowledged in order', async t => {
  const f = await appFixture(t);
  await Promise.all([f.app.onEvent(message(SELF, 71001, '开机'), f.api), f.app.onEvent(message(SELF, 71002, '关机'), f.api)]);
  assert.deepEqual(f.sends.map(item => item.body.message[0].data.text), ['开了', '关了']);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).auto_resend, false);
});

test('revoked permissions are rechecked before a queued command can change state', async t => {
  const f = await appFixture(t, { command_allow_others: true,
    command_permissions: [{ type: 'group', peer_id: GROUP, user_id: OTHER, peer_name: 'fixture', user_name: 'fixture' }] });
  let release; f.app.resendTask = new Promise(resolve => { release = resolve; });
  const pending = f.app.onEvent(message(OTHER, 71001, '开机'), f.api);
  await new Promise(resolve => setImmediate(resolve));
  f.app.preferences.command_allow_others = false; release(); await pending;
  assert.equal(f.sends.length, 0); assert.equal(f.app.preferences.auto_resend, false);
});

test('whitelist exemption does not grant or revoke the separate command authorization', async t => {
  const f = await appFixture(t, { command_allow_others: true,
    command_permissions: [{ type: 'group', peer_id: GROUP, user_id: OTHER, peer_name: 'fixture', user_name: 'fixture' }] });
  await f.app.setResendExemptions([OTHER, AUTHOR]);
  await f.app.onEvent(message(AUTHOR, 71001, '开机'), f.api); assert.equal(f.sends.length, 0);
  await f.app.onEvent(message(OTHER, 71002, '开机'), f.api); assert.equal(f.sends.length, 1);
});

test('HTTP whitelist and command settings persist and reject invalid updates without QQ traffic', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-recall-feature-tests-')), configPath = join(dir, 'preferences.json');
  await writeFile(configPath, JSON.stringify({ auto_recovery: false }));
  const running = await startApp({ configPath, discover: async () => [], logger: () => {} });
  t.after(async () => { await running.close(); await rm(configPath, { force: true }); await rm(configPath + '.tmp', { force: true }); await rmdir(dir); });
  const post = (path, body) => fetch(running.url + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-qq-recall-session': running.app.session }, body: JSON.stringify(body) });
  assert.equal((await post('api/resend-exemptions', { qq_ids: '60001,60002' })).status, 200);
  assert.equal((await post('api/resend-exemptions', { qq_ids: ['bad'] })).status, 400);
  assert.deepEqual(running.app.exemptQQIds, [AUTHOR, OTHER]);
  assert.equal((await post('api/commands', { on: '开机', off: '关机', reply_on: '开启成功', reply_off: '关闭成功' })).status, 200);
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(saved.resend_exempt_qq_ids, [AUTHOR, OTHER]); assert.equal(saved.command_reply_off, '关闭成功');
});
