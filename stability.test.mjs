import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginHelper } from './quick-login.mjs';
import { RecoveryWatchdog } from './recovery.mjs';
import { ConnectionWatchdog } from './connection-watchdog.mjs';
import { ResendQueue } from './send-queue.mjs';
import { RecallReposter, DEFAULTS } from './engine.mjs';
import { startApp } from './qq-recall.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
const ACCOUNT = '90001';

function loginFixture(options = {}) {
  const calls = [];
  const helper = createLoginHelper({
    roots: ['C:/fixture/NapCat.Shell'],
    readFile: async () => JSON.stringify({ port: 6099, token: 'offline-fixture-only' }),
    readdir: async path => path.endsWith('config') ? (options.configAccounts || [ACCOUNT]).map(account => `onebot11_${account}.json`) : [],
    fetch: async (url, init) => {
      calls.push(new URL(url).pathname);
      if (url.endsWith('/webui/')) return new Response('<title>NapCat WebUI</title>');
      const route = url.slice(url.indexOf('/api'));
      if (options.override) {
        const override = await options.override(route, init);
        if (override) return override;
      }
      let data;
      if (route === '/api/auth/login') data = { Credential: 'offline-session-fixture' };
      else if (route === '/api/QQLogin/CheckLoginStatus') data = options.status || { isLogin: false, loginPhase: 'waiting_qrcode' };
      else if (route === '/api/QQLogin/GetQuickLoginList') data = options.accounts || [ACCOUNT];
      else if (route === '/api/QQLogin/GetQQLoginInfo') data = options.unknownAccount ? {} : { uin: ACCOUNT };
      else if (route === '/api/QQLogin/SetQuickLogin') data = {};
      else if (route === '/api/Process/Restart') data = { result: true };
      else throw new Error('Unexpected fixture route: ' + route);
      return Response.json({ code: 0, data });
    },
  });
  return { helper, calls };
}

test('temporary authentication transport failure remains retryable and is not cached as auth rejection', async () => {
  let attempts = 0;
  const { helper } = loginFixture({ override: route => {
    if (route === '/api/auth/login' && ++attempts === 1) throw new TypeError('fetch failed');
  } });
  const first = await helper.getLoginState();
  assert.equal(first.error_code, 'unavailable');
  assert.equal(first.requires_user_action, false);
  assert.equal(first.retryable, true);
  const second = await helper.getLoginState();
  assert.equal(second.phase, 'waiting_qrcode');
  assert.equal(attempts, 2);
});

for (const [name, response, code] of [
  ['authentication rejection', new Response('', { status: 401 }), 'auth_failed'],
  ['HTTP server failure', new Response('', { status: 503 }), 'api_unavailable'],
  ['two factor challenge', Response.json({ code: 0, data: { require2FA: true } }), 'two_factor'],
]) {
  test(name + ' has an accurate category', async () => {
    const { helper } = loginFixture({ override: route => route === '/api/auth/login' ? response.clone() : undefined });
    const result = await helper.getLoginState();
    assert.equal(result.error_code, code);
    assert.equal(result.requires_user_action, code !== 'api_unavailable');
  });
}

test('generic login API rejection does not claim a verified QR challenge', async () => {
  const { helper } = loginFixture({ override: route => route.endsWith('SetQuickLogin')
    ? Response.json({ code: -1, message: 'native action failed' }) : undefined });
  const result = await helper.quickLogin(ACCOUNT);
  assert.equal(result.error_code, 'action_failed');
  assert.match(result.message, /接口拒绝/);
  assert.doesNotMatch(result.message, /需要本人扫码或验证/);
});

test('a lost login response is marked uncertain rather than inviting duplicate submission', async () => {
  const { helper } = loginFixture({ override: route => { if (route.endsWith('SetQuickLogin')) throw new TypeError('fetch failed'); } });
  const result = await helper.quickLogin(ACCOUNT);
  assert.equal(result.submission_uncertain, true);
  assert.equal(result.requires_user_action, false);
});

test('healthy online instances do not receive login or restart requests', async () => {
  const { helper, calls } = loginFixture({ status: { isLogin: true, loginPhase: 'ready' } });
  await helper.quickLogin(ACCOUNT);
  await helper.restartWorker(ACCOUNT);
  assert.equal(calls.filter(path => /SetQuickLogin|\/Process\/Restart/.test(path)).length, 0);
});

test('manual recovery of an unidentified offline account requires the unique configured binding', async () => {
  const { helper, calls } = loginFixture({ unknownAccount: true });
  assert.equal((await helper.restartWorker(ACCOUNT, { automatic: true })).restarted, false);
  assert.equal((await helper.restartWorker(ACCOUNT)).restarted, true);
  assert.equal(calls.filter(path => path.endsWith('/Process/Restart')).length, 1);
  const ambiguous = loginFixture({ unknownAccount: true, accounts: [ACCOUNT, '90002'], configAccounts: [ACCOUNT, '90002'] });
  assert.equal((await ambiguous.helper.restartWorker(ACCOUNT)).restarted, false);
});

test('other saved records are never selected when manually recovering the unique configured binding', async () => {
  const { helper, calls } = loginFixture({ unknownAccount: true, accounts: [ACCOUNT, '90002', '90003'] });
  assert.equal((await helper.restartWorker(ACCOUNT)).restarted, true);
  assert.equal(calls.filter(path => path.endsWith('/Process/Restart')).length, 1);
  assert.equal(calls.filter(path => path.endsWith('/SetQuickLogin')).length, 0);
});

function recoveryFixture(inspect, login = async () => ({})) {
  let clock = 0, restarts = 0, logins = 0;
  const watchdog = new RecoveryWatchdog({ inspect, now: () => clock,
    restart: async () => { restarts++; return {}; }, login: async (...args) => { logins++; return login(...args); } });
  watchdog.configure(true, ACCOUNT);
  return { watchdog, setTime: value => { clock = value; }, counts: () => ({ restarts, logins }) };
}

test('transient status failures use bounded 30/60 second observation backoff without login or restart', async () => {
  let inspections = 0;
  const f = recoveryFixture(async () => { inspections++; return { running: true, error_code: 'api_unavailable', retryable: true }; });
  await f.watchdog.tick(); f.setTime(90_000); await f.watchdog.tick();
  assert.equal(f.watchdog.snapshot().phase, 'retrying_status');
  assert.equal(f.watchdog.snapshot().next_action_in_seconds, 30);
  f.setTime(100_000); await f.watchdog.tick(); assert.equal(inspections, 1);
  f.setTime(120_000); await f.watchdog.tick();
  assert.equal(f.watchdog.snapshot().next_action_in_seconds, 60);
  f.setTime(180_000); await f.watchdog.tick(); assert.equal(f.watchdog.paused, true);
  f.setTime(1_000_000); await f.watchdog.tick(); assert.equal(inspections, 3);
  assert.deepEqual(f.counts(), { logins: 0, restarts: 0 });
});

for (const code of ['verification_required', 'two_factor', 'auth_failed', 'rate_limited', 'action_failed']) {
  test(code + ' stops automatic actions with its own reason', async () => {
    const f = recoveryFixture(async () => ({ running: true, requires_user_action: true, error_code: code }));
    await f.watchdog.tick(); f.setTime(90_000); await f.watchdog.tick();
    assert.equal(f.watchdog.paused, true);
    assert.equal(f.watchdog.snapshot().error_code, code);
    f.setTime(1_000_000); await f.watchdog.tick();
    assert.deepEqual(f.counts(), { logins: 0, restarts: 0 });
  });
}

test('an uncertain login result is only observed and never resubmitted', async () => {
  const state = { running: true, account: ACCOUNT, accounts: [ACCOUNT], phase: 'waiting_qrcode', needs_quick_login: true };
  const f = recoveryFixture(async () => state, async () => ({ submission_uncertain: true, error_code: 'unavailable' }));
  await f.watchdog.tick(); f.setTime(90_000); await f.watchdog.tick();
  assert.equal(f.watchdog.snapshot().phase, 'waiting_login');
  f.setTime(110_000); await f.watchdog.tick();
  assert.equal(f.watchdog.paused, true);
  f.setTime(1_000_000); await f.watchdog.tick();
  assert.deepEqual(f.counts(), { logins: 1, restarts: 0 });
});

test('late status results cannot restart an instance after its connection has recovered', async () => {
  let complete;
  const f = recoveryFixture(() => new Promise(resolve => { complete = resolve; }));
  await f.watchdog.tick(); f.setTime(90_000); const pending = f.watchdog.tick();
  await f.watchdog.tick({ connected: true });
  complete({ running: true, account: ACCOUNT, accounts: [ACCOUNT], phase: 'offline' });
  await pending;
  assert.deepEqual(f.counts(), { logins: 0, restarts: 0 });
});

test('manual login to the bound account restores monitoring using observations only', async () => {
  let inspections = 0;
  const f = recoveryFixture(async () => { inspections++; return {
    running: true, online: true, account: ACCOUNT, accounts: [ACCOUNT] }; });
  f.watchdog.pauseForError({ error_code: 'verification_required' });
  await f.watchdog.tick({ connected: true, account: ACCOUNT, verifiedOnline: true });
  assert.equal(f.watchdog.paused, false);
  assert.equal(f.watchdog.snapshot().phase, 'online');
  f.setTime(10_000); await f.watchdog.tick({ connected: true, account: ACCOUNT, verifiedOnline: true });
  assert.equal(inspections, 1);
  assert.deepEqual(f.counts(), { logins: 0, restarts: 0 });
});

test('unverified connections, different accounts and management verification do not clear a pause', async () => {
  let inspections = 0;
  const f = recoveryFixture(async () => { inspections++; return {
    running: true, online: true, account: ACCOUNT, accounts: [ACCOUNT], requires_user_action: true, error_code: 'two_factor' }; });
  f.watchdog.pauseForError({ error_code: 'verification_required' });
  await f.watchdog.tick({ connected: true, account: ACCOUNT });
  await f.watchdog.tick({ connected: true, account: '90002', verifiedOnline: true });
  assert.equal(inspections, 0); assert.equal(f.watchdog.paused, true);
  await f.watchdog.tick({ connected: true, account: ACCOUNT, verifiedOnline: true });
  assert.equal(f.watchdog.paused, true); assert.equal(f.watchdog.snapshot().error_code, 'two_factor');
  assert.deepEqual(f.counts(), { logins: 0, restarts: 0 });
});

test('missing original saved record keeps recovery paused even if QQ is online', async () => {
  const f = recoveryFixture(async () => ({ running: true, online: true, account: ACCOUNT, accounts: ['90002'] }));
  f.watchdog.pauseForError({ error_code: 'account_mismatch' });
  await f.watchdog.tick({ connected: true, account: ACCOUNT, verifiedOnline: true });
  assert.equal(f.watchdog.paused, true);
  assert.equal(f.watchdog.snapshot().error_code, 'no_saved_account');
  assert.deepEqual(f.counts(), { logins: 0, restarts: 0 });
});

test('online observation remembers verified identity for a later worker logout', async () => {
  const options = { status: { isLogin: true, loginPhase: 'ready' } };
  const { helper, calls } = loginFixture(options);
  const f = recoveryFixture(() => helper.getLoginState());
  await f.watchdog.tick({ connected: true, account: ACCOUNT, verifiedOnline: true });
  options.unknownAccount = true; options.status.isLogin = false; options.status.loginPhase = 'waiting_qrcode';
  const offline = await helper.getLoginState();
  assert.equal(offline.account, ACCOUNT);
  assert.equal(calls.filter(path => /SetQuickLogin|\/Process\/Restart/.test(path)).length, 0);
});

test('heartbeat reads status only, tolerates one error and closes after two', async () => {
  const actions = []; let closes = 0;
  const pulse = new ConnectionWatchdog({ call: async action => { actions.push(action); throw new Error('timeout'); }, close: () => { closes++; } });
  await pulse.check(); assert.equal(closes, 0);
  await pulse.check(); assert.equal(closes, 1);
  await pulse.check(); assert.deepEqual(actions, ['get_status', 'get_status']);
});

test('healthy heartbeat resets failure count; offline status closes immediately', async () => {
  let result = 'fail', closes = 0;
  const pulse = new ConnectionWatchdog({ call: async () => { if (result === 'fail') throw new Error('timeout'); return { online: result }; }, close: () => { closes++; } });
  await pulse.check(); result = true; await pulse.check(); assert.equal(pulse.failures, 0);
  result = false; await pulse.check(); assert.equal(closes, 1);
});

test('hanging heartbeat is bounded and stopped connections ignore late results', async () => {
  let closes = 0, complete;
  const hanging = new ConnectionWatchdog({ call: () => new Promise(() => {}), close: () => { closes++; } }, { timeoutMs: 5, failureLimit: 1 });
  await hanging.check(); assert.equal(closes, 1);
  const stale = new ConnectionWatchdog({ call: () => new Promise(resolve => { complete = resolve; }), close: () => { closes++; } });
  const pending = stale.check(); stale.stop(); complete({ online: false }); await pending;
  assert.equal(closes, 1);
});

test('disconnect cancellation prevents unsent queued messages from being replayed', async () => {
  let sends = 0;
  const queue = new ResendQueue({ intervalMs: 1000, jitterMs: 0,
    wait: (_, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })), { once: true })) });
  const first = queue.enqueue(async () => { sends++; return 'sent'; });
  const second = queue.enqueue(async () => { sends++; return 'sent'; });
  queue.cancel(); assert.deepEqual(await Promise.all([first, second]), ['cancelled', 'cancelled']);
  assert.equal(sends, 0);
});

test('failed message sends retain duplicate prevention and are not automatically retried', async () => {
  let sends = 0;
  const queue = new ResendQueue({ intervalMs: 0, jitterMs: 0 });
  const engine = new RecallReposter({ ...DEFAULTS, group_ids: ['50001'], expected_self_id: ACCOUNT, auto_resend: true },
    () => {}, Date.now, async () => { throw new Error('No network in fixture'); }, queue);
  const api = { call: async () => { sends++; throw new Error('uncertain result'); } };
  await engine.handle({ post_type: 'message', message_type: 'group', group_id: 50001, user_id: 60001, self_id: Number(ACCOUNT), message_id: 70001,
    message: [{ type: 'text', data: { text: 'offline fixture' } }] }, api);
  const notice = { post_type: 'notice', notice_type: 'group_recall', group_id: 50001, user_id: 60001, self_id: Number(ACCOUNT), message_id: 70001 };
  assert.equal(await engine.handle(notice, api), 'failed');
  assert.equal(await engine.handle(notice, api), 'duplicate');
  assert.equal(sends, 1); engine.clear();
});

test('health summary exposes operational counters without account, chat or session data', async t => {
  const fixtureDir=await mkdtemp(join(tmpdir(),'qq-stability-health-'));
  t.after(async()=>{assert.ok(resolve(fixtureDir).startsWith(resolve(tmpdir())+sep));await rm(fixtureDir,{recursive:true,force:true});});
  const running = await startApp({ configPath: join(fixtureDir,'config.json'),
    discover: async () => [], logger: () => {}, recoveryActions: { inspect: async () => ({}), login: async () => ({}), restart: async () => ({}) } });
  try {
    running.app.selfId = 'private-fixture-account';
    running.app.recalls = [{ message: [{ type: 'text', data: { text: 'private-fixture-chat' } }] }];
    const response = await fetch(running.url + 'health');
    const data = await response.json();
    assert.equal(data.connection_watchdog, true);
    assert.equal(data.status_summary.connected, false);
    const text = JSON.stringify(data);
    assert.doesNotMatch(text, /private-fixture|account|session|token/);
  } finally {
    running.app.recalls = [];
    await running.close();
  }
});
