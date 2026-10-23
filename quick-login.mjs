import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { recoveryErrorFields, recoveryFailureMessage, isTransientRecoveryError } from './recovery-errors.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const accountId = value => /^[1-9]\d{4,11}$/.test(String(value ?? '').trim()) ? String(value).trim() : '';
const uniqueAccounts = values => [...new Set((Array.isArray(values) ? values : []).map(accountId).filter(Boolean))];
const active = context => context?.signal?.aborted !== true && context?.shouldContinue?.() !== false;
const busyPhase = phase => ['reconnecting', 'initializing', 'qrcode_scanned', 'logging_in', 'password_logging_in',
  'quick_login', 'booting', 'connecting', 'generating_qrcode'].includes(phase);
const safePhase = value => /^[a-z_]{1,40}$/.test(String(value || '')) ? String(value) : 'unknown';

function actionProblem(data, fallback = '') {
  if (data?.needCaptcha || data?.needNewDevice || data?.require2FA || data?.requiresUserAction) return 'verification_required';
  const message = String(data?.message || data?.loginError || fallback);
  if (/\brate[\s_-]*limit(?:ed)?\b|\btoo many requests\b|频率|限流|请求过于频繁/i.test(message)) return 'rate_limited';
  if (/Unauthorized|Authorization|token|凭证/i.test(message)) return 'auth_failed';
  if (/验证码|验证|新设备|安全确认|captcha|new.?device|verification|扫码|二维码|qr.?code/i.test(message)) return 'verification_required';
  return data?.result === false || data?.loginError || fallback ? 'action_failed' : '';
}
const cleanErrorCode = error => ['auth_failed', 'two_factor', 'rate_limited', 'verification_required',
  'account_mismatch', 'action_failed', 'api_unavailable'].includes(error?.message) ? error.message : 'unavailable';

// Ordinary reconnect code must not log in. Only a deliberate click or an enabled, bound watchdog may do so.
// WebUI Token, its hash, and the temporary Credential remain in this module's memory.
export function createLoginHelper(options = {}) {
  const fetcher = options.fetch || globalThis.fetch;
  const read = options.readFile || readFile;
  const list = options.readdir || readdir;
  const startProcess = options.spawn || spawn;
  const platform = options.platform || process.platform;
  const now = options.now || Date.now;
  const sessions = new Map();
  const verifiedAccounts = new Map();
  let inFlight;
  let restartInFlight;
  let launchedAt = -Infinity;
  let loginAttemptAt = -Infinity;

  async function readJSON(path) {
    return JSON.parse(String(await read(path, 'utf8')).replace(/^\uFEFF/, ''));
  }

  async function discover() {
    const roots = options.roots ? [...options.roots] : [
      process.env.NAPCAT_DIR, join(HERE, 'NapCat.Shell'), join(HERE, '..', 'NapCat.Shell'),
      join(homedir(), 'Desktop', 'NapCat.Shell'),
    ].filter(Boolean);
    if (!options.roots) {
      for (const parent of [join(homedir(), 'Desktop'), join(homedir(), 'Downloads')]) {
        try {
          for (const entry of await list(parent, { withFileTypes: true })) {
            if (entry.isDirectory() && /^napcat/i.test(entry.name)) roots.push(join(parent, entry.name));
          }
        } catch {}
      }
    }
    const found = [];
    for (const root of new Set(roots.map(value => resolve(value)))) {
      try {
        const config = await readJSON(join(root, 'config', 'webui.json'));
        const port = Number(config.port || 6099);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        const host = String(config.host || '127.0.0.1');
        if (!['::', '::1', '0.0.0.0', 'localhost', '127.0.0.1'].includes(host)) continue;
        const configFiles = await list(join(root, 'config'));
        const accounts = uniqueAccounts(configFiles.map(name => String(name).match(/^(?:onebot11|napcat)_(\d+)\.json$/i)?.[1]));
        const rootFiles = await list(root);
        const launcherName = ['launcher-win10-user.bat', 'launcher-user.bat'].find(name => rootFiles.includes(name));
        const address = host === '::1' ? '[::1]' : '127.0.0.1';
        const base = 'http://' + address + ':' + port;
        found.push({ root, base, accounts, preferred: accountId(config.autoLoginAccount),
          token: String(config.token || ''), disabled: config.disableWebUI === true,
          launcher: launcherName ? join(root, launcherName) : '' });
      } catch {}
    }
    return found;
  }

  function visible(candidate, values = {}) {
    return { running: false, online: false, account: '', accounts: candidate?.accounts || [],
      webui_url: candidate ? candidate.base + '/webui/' : '', requires_user_action: false,
      recovering: false, phase: 'unavailable', needs_quick_login: false,
      login_requested: false, restarted: false, started: false, message: '', ...values };
  }

  async function request(url, init = {}) {
    return fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs || 3000) });
  }

  function connectionRefused(error) {
    if (error?.code === 'ECONNREFUSED') return true;
    if (error?.cause) return connectionRefused(error.cause);
    return Array.isArray(error?.errors) && error.errors.length > 0 && error.errors.every(connectionRefused);
  }

  async function api(candidate, route, body = {}, credential = '') {
    const response = await request(candidate.base + '/api' + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(credential ? { Authorization: 'Bearer ' + credential } : {}) }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error([401, 403].includes(response.status) ? 'auth_failed' : 'api_unavailable');
    let result;
    try { result = await response.json(); } catch { throw new Error('api_unavailable'); }
    if (result?.code !== 0) {
      // Never return arbitrary server messages: they may contain a QR URL or authentication material.
      throw new Error(actionProblem(result, result?.message) || 'action_failed');
    }
    return result.data;
  }

  async function credentialFor(candidate) {
    const hash = createHash('sha256').update(candidate.token + '.napcat').digest('hex');
    const cached = sessions.get(candidate.base);
    if (cached?.hash === hash && cached.expires > now()) {
      if (cached.error) throw new Error(cached.error);
      return cached.credential;
    }
    if (!candidate.token) throw new Error('auth_failed');
    try {
      const data = await api(candidate, '/auth/login', { hash });
      if (data?.require2FA) throw new Error('two_factor');
      if (typeof data?.Credential !== 'string' || !data.Credential) throw new Error('auth_failed');
      sessions.set(candidate.base, { hash, credential: data.Credential, expires: now() + 45 * 60_000 });
      return data.Credential;
    } catch (error) {
      const code = cleanErrorCode(error);
      if (!isTransientRecoveryError(code)) sessions.set(candidate.base, { hash, error: code, expires: now() + 60_000 });
      throw new Error(code);
    }
  }

  function failureMessage(error) {
    return recoveryFailureMessage(cleanErrorCode(error));
  }

  async function inspect() {
    const candidates = await discover();
    let firstStopped;
    for (const candidate of candidates) {
      if (candidate.disabled) {
        return { candidate, view: visible(candidate, { requires_user_action: true,
          message: 'NapCat 的管理页面已禁用，请先在原 NapCat 配置中启用；不会另开 QQ。' }) };
      }
      try {
        const probe = await request(candidate.base + '/webui/');
        const html = await probe.text();
        if (!probe.ok || !/NapCat\s*WebUI/i.test(html)) {
          return { candidate, view: visible(candidate, { running: true, requires_user_action: true,
            message: '管理页面端口已有服务，但无法确认是 NapCat；不会向它提交凭据或另开 QQ。' }) };
        }
      } catch (error) {
        if (connectionRefused(error)) { firstStopped ||= candidate; continue; }
        return { candidate, view: visible(candidate, { ...recoveryErrorFields('unavailable') }) };
      }
      let credential = '';
      try {
        credential = await credentialFor(candidate);
        const status = await api(candidate, '/QQLogin/CheckLoginStatus', {}, credential);
        const accounts = uniqueAccounts((await api(candidate, '/QQLogin/GetQuickLoginList', {}, credential)) || []);
        let info = {};
        try { info = await api(candidate, '/QQLogin/GetQQLoginInfo', {}, credential) || {}; } catch {}
        const online = status?.isLogin === true;
        const observedAccount = accountId(info.uin ?? info.user_id ?? info.qq);
        if (observedAccount) verifiedAccounts.set(candidate.base, observedAccount);
        const account = observedAccount || verifiedAccounts.get(candidate.base) || '';
        const phase = safePhase(status?.loginPhase);
        const busy = busyPhase(phase) || status?.qrLoginAccepted === true;
        const verification = /captcha|verify|verification|new_device|two_factor/.test(phase);
        const problem = !online ? actionProblem(status, status?.loginError) : '';
        const needsHuman = !online && (verification || (!!problem && !isTransientRecoveryError(problem)) || (!busy && !accounts.length));
        const message = online ? 'QQ 已在线，无需重新登录。' : busy ? 'NapCat 正在登录或恢复连接，请稍候，不会重复发起登录。' :
          accounts.length ? '可使用本机保存的账号进行一次快捷登录。' : '没有可用的快捷登录记录，请打开 NapCat 管理页面扫码。';
        return { candidate, credential, status, busy, view: visible(candidate, { running: true, online,
          account, accounts, phase, recovering: busy, needs_quick_login: !online && !busy && !needsHuman && accounts.length > 0,
          requires_user_action: needsHuman, retryable: isTransientRecoveryError(problem), error_code: verification ? 'verification_required' : problem,
          message: needsHuman && (verification || problem) ? failureMessage(new Error(verification ? 'verification_required' : problem)) : message }) };
      } catch (error) {
        if (credential && error.message === 'auth_failed') {
          const hash = createHash('sha256').update(candidate.token + '.napcat').digest('hex');
          sessions.set(candidate.base, { hash, error: 'auth_failed', expires: now() + 60_000 });
        }
        return { candidate, view: visible(candidate, { running: true, account: verifiedAccounts.get(candidate.base) || '',
          phase: 'unavailable', ...recoveryErrorFields(cleanErrorCode(error)) }) };
      }
    }
    return { candidate: firstStopped, stopped: !!firstStopped, view: visible(firstStopped, {
      message: firstStopped ? 'NapCat 尚未启动，点击快捷登录可尝试启动一次。' : '未找到本机 NapCat 安装目录，请先打开 NapCat。',
      requires_user_action: !firstStopped,
    }) };
  }

  async function isQQRunning() {
    if (options.isQQRunning) return options.isQQRunning();
    if (platform !== 'win32') return true;
    return new Promise(resolveResult => {
      let output = '';
      let child;
      try {
        child = startProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "@(Get-Process -Name QQ,NapCatWinBootMain -ErrorAction SilentlyContinue).Count -gt 0"],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { resolveResult(true); return; }
      const timer = setTimeout(() => { child.kill?.(); resolveResult(true); }, 3000);
      child.stdout?.on('data', data => { output += data; });
      child.once('error', () => { clearTimeout(timer); resolveResult(true); });
      child.once('close', code => { clearTimeout(timer); resolveResult(code !== 0 || output.trim() !== 'False'); });
    });
  }

  async function launch(candidate, account) {
    if (platform !== 'win32' || !candidate.launcher || /[%!"\r\n]/.test(candidate.launcher)) return false;
    const command = '""' + candidate.launcher + '"' + (account ? ' ' + account : '') + '"';
    return new Promise(resolveResult => {
      let child;
      try {
        child = startProcess(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
          cwd: candidate.root, windowsHide: true, detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
        });
      } catch { resolveResult(false); return; }
      child.once('error', () => resolveResult(false));
      child.once('spawn', () => { child.unref?.(); resolveResult(true); });
    });
  }

  async function getLoginState() {
    try { return (await inspect()).view; }
    catch { return visible(null, { ...recoveryErrorFields('unavailable') }); }
  }

  async function performQuickLogin(account, context = {}) {
    if (!active(context)) return visible(null, { message: '操作已取消。' });
    const requested = String(account ?? '').trim();
    if (requested && !accountId(requested)) return visible(null, { requires_user_action: true, message: '请选择有效的本机已保存 QQ 账号。' });
    const result = await inspect();
    const { candidate, view } = result;
    if (!active(context)) return { ...view, message: '操作已取消。' };
    if (context.automatic && (!accountId(requested) || (view.account && view.account !== requested))) return { ...view,
      requires_user_action: true, error_code: 'account_mismatch', message: '无法确认当前 NapCat 属于绑定账号，自动恢复已停止。' };
    if (view.online || result.busy || !candidate) return view;
    if (view.retryable === true) return view;
    if (view.running && !result.credential) return view;
    if (view.requires_user_action && ['verification_required', 'rate_limited', 'auth_failed', 'two_factor'].includes(view.error_code)) return view;
    if (context.automatic && (view.requires_user_action || !view.running)) return { ...view, requires_user_action: true,
      message: view.running ? view.message : 'NapCat 管理页面不可用，自动恢复不会启动未知 QQ，请手动打开原 NapCat。' };
    if (context.automatic && (!accountId(requested) || view.account !== requested)) return { ...view,
      requires_user_action: true, error_code: 'account_mismatch', message: '无法确认当前 NapCat 属于绑定账号，自动恢复已停止。' };
    const accounts = view.accounts;
    const preferred = accounts.includes(candidate.preferred) ? candidate.preferred :
      candidate.accounts.length === 1 && accounts.includes(candidate.accounts[0]) ? candidate.accounts[0] : '';
    const selected = requested || preferred || (accounts.length === 1 ? accounts[0] : '');
    if (selected && !accounts.includes(selected)) return { ...view, requires_user_action: true, message: '此账号不在本机保存的登录记录中，请先在 NapCat 管理页面扫码。' };
    if (!selected && accounts.length > 1) return { ...view, requires_user_action: true, message: '发现多个已保存账号，请先选择一个，再点击快捷登录。' };
    if (result.stopped) {
      if (now() - launchedAt < 60_000) return { ...view, message: '刚刚已启动 NapCat，请稍候打开管理页面；不会重复启动。' };
      if (await isQQRunning()) return { ...view, requires_user_action: true,
        message: '检测到 QQ 或 NapCat 进程正在运行，请使用已有管理页面；不会再启动第二个 QQ。' };
      if (!active(context)) return { ...view, message: '操作已取消。' };
      // Final presence check narrows the race with a manually started instance.
      try {
        await request(candidate.base + '/webui/');
        return { ...view, running: true, message: 'NapCat 管理页面已经启动，请打开页面；不会重复启动。' };
      } catch (error) {
        if (!connectionRefused(error)) return { ...view, requires_user_action: true, message: '无法确认启动状态，请打开管理页面检查；不会重复启动。' };
      }
      if (!active(context)) return { ...view, message: '操作已取消。' };
      launchedAt = now();
      if (!await launch(candidate, selected)) return { ...view, requires_user_action: true, message: '未能启动 NapCat，请使用原 NapCat 启动入口。' };
      return { ...view, account: selected, started: true, login_requested: !!selected, requires_user_action: true,
        message: selected ? '已启动 NapCat，并请求一次快捷登录。请打开管理页面查看结果，必要时由本人扫码或验证。' :
          '已启动 NapCat。请打开管理页面扫码，完成首次登录。' };
    }
    if (!selected) return { ...view, requires_user_action: true, message: '没有可用的快捷登录记录，请打开 NapCat 管理页面扫码。' };
    if (now() - loginAttemptAt < 15_000) return { ...view, account: selected, message: '刚刚已请求快捷登录，请在管理页面查看结果；不会重复提交。' };
    if (!active(context)) return { ...view, message: '操作已取消。' };
    loginAttemptAt = now();
    try {
      const action = await api(candidate, '/QQLogin/SetQuickLogin', { uin: selected }, result.credential);
      const problem = actionProblem(action);
      if (problem) throw new Error(problem);
      return { ...view, account: selected, login_requested: true, phase: 'quick_login', recovering: true,
        needs_quick_login: false, requires_user_action: false,
        message: '已请求一次快捷登录，请在 NapCat 管理页面查看结果；需要扫码或验证时由本人完成。' };
    } catch (error) {
      const code = cleanErrorCode(error);
      return { ...view, account: selected, ...recoveryErrorFields(code),
        submission_uncertain: isTransientRecoveryError(code), login_requested: false };
    }
  }

  function quickLogin(account = '', context = {}) {
    if (restartInFlight) return Promise.resolve(visible(null, { recovering: true, phase: 'reconnecting', message: 'NapCat 重启请求正在处理，请稍候。' }));
    if (inFlight) return inFlight;
    inFlight = performQuickLogin(account, context).catch(() => visible(null, {
      ...recoveryErrorFields('unavailable'), submission_uncertain: true })).finally(() => { inFlight = undefined; });
    return inFlight;
  }

  async function performRestart(expectedAccount, context = {}) {
    if (!active(context)) return visible(null, { message: '操作已取消。' });
    const expected = accountId(expectedAccount);
    if (!expected) return visible(null, { requires_user_action: true, error_code: 'account_mismatch', message: '自动恢复需要绑定明确的 QQ 账号。' });
    const result = await inspect();
    const { candidate, view } = result;
    if (!active(context)) return { ...view, message: '操作已取消。' };
    if (view.account && view.account !== expected) return { ...view, requires_user_action: true,
      error_code: 'account_mismatch', message: 'NapCat 当前账号与绑定账号不一致，自动恢复已停止。' };
    if (view.online || result.busy) return view;
    if (!candidate || !view.running || !result.credential || view.requires_user_action) return { ...view, requires_user_action: true };
    // Deliberate recovery may use the project's unique configured binding even
    // if QQ has other saved records. Never select one of those other accounts.
    const singleBoundOffline = !context.automatic && !view.account && view.phase === 'waiting_qrcode' &&
      view.accounts.includes(expected) && candidate.accounts.length === 1 && candidate.accounts[0] === expected &&
      (!candidate.preferred || candidate.preferred === expected);
    if ((!singleBoundOffline && view.account !== expected) || !view.accounts.includes(expected)) return { ...view, requires_user_action: true,
      error_code: 'account_mismatch', message: '当前账号或已保存快捷登录记录与绑定账号不一致，自动恢复已停止。' };
    if (!active(context)) return { ...view, message: '操作已取消。' };
    try {
      const action = await api(candidate, '/Process/Restart', {}, result.credential);
      const problem = action?.result === false || action?.needCaptcha || action?.needNewDevice ? actionProblem(action) : '';
      if (problem) throw new Error(problem);
      return { ...view, restarted: true, recovering: true, phase: 'reconnecting', needs_quick_login: false,
        requires_user_action: false, message: '已请求 NapCat 重启自己的 Worker，尚未确认恢复在线。' };
    } catch (error) {
      return { ...view, ...recoveryErrorFields(cleanErrorCode(error)) };
    } finally {
      sessions.delete(candidate.base);
    }
  }

  function restartWorker(expectedAccount, context = {}) {
    if (inFlight) return Promise.resolve(visible(null, { recovering: true, phase: 'quick_login', message: '快捷登录请求正在处理，请稍候。' }));
    if (restartInFlight) return restartInFlight;
    restartInFlight = performRestart(expectedAccount, context).catch(() => visible(null, { requires_user_action: true,
      message: '无法确认 NapCat 重启条件，请打开原管理页面检查。' })).finally(() => { restartInFlight = undefined; });
    return restartInFlight;
  }

  return { getLoginState, quickLogin, restartWorker };
}

const defaultHelper = createLoginHelper();
export const getLoginState = () => defaultHelper.getLoginState();
export const quickLogin = (account = '', context = {}) => defaultHelper.quickLogin(account, context);
export const restartWorker = (account, context = {}) => defaultHelper.restartWorker(account, context);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await quickLogin(process.argv[2] || '');
  console.log(result.message);
  if (result.webui_url) console.log(result.webui_url);
}
