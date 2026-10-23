const DISCONNECTED_DELAY = 90_000;
import { recoveryFailureMessage, isTransientRecoveryError } from './recovery-errors.mjs';
const ROUND_COOLDOWN = 5 * 60_000;
const STABLE_ONLINE = 5 * 60_000;
const WORKER_TIMEOUT = 3 * 60_000;
const LOGIN_TIMEOUT = 90_000;
const READY_DELAY = 10_000;
const accountId = value => /^[1-9]\d{4,11}$/.test(String(value ?? '').trim()) ? String(value).trim() : '';
const busy = state => state?.recovering === true || ['reconnecting', 'initializing', 'qrcode_scanned',
  'logging_in', 'password_logging_in', 'quick_login', 'booting', 'connecting', 'generating_qrcode'].includes(state?.phase);

// The owner schedules tick(). This class never starts QQ, kills a process, or creates its own timer.
export class RecoveryWatchdog {
  constructor({ inspect, restart, login, now = Date.now, log = () => {} } = {}) {
    this.inspect = inspect;
    this.restart = restart;
    this.login = login;
    this.now = now;
    this.log = log;
    this.enabled = false;
    this.paused = false;
    this.phase = 'disabled';
    this.failures = 0;
    this.message = '自动恢复已关闭。';
    this.account = '';
    this.generation = 0;
    this.disposed = false;
    this.disconnectedSince = null;
    this.onlineSince = null;
    this.busySince = null;
    this.lastActionAt = -Infinity;
    this.cycle = null;
    this.task = null;
    this.inspectionFailures = 0;
    this.nextInspectionAt = 0;
    this.errorCode = '';
    this.lastOnlineInspection = -Infinity;
  }

  configure(enabled, account) {
    if (this.disposed) return this.snapshot();
    const nextEnabled = enabled === true;
    const nextAccount = accountId(account);
    if (nextEnabled === this.enabled && nextAccount === this.account) return this.snapshot();
    this.generation++;
    this.enabled = nextEnabled;
    this.account = nextAccount;
    this.paused = nextEnabled && !nextAccount;
    this.failures = 0;
    this.disconnectedSince = null;
    this.onlineSince = null;
    this.busySince = null;
    this.cycle = null;
    this.inspectionFailures = 0;
    this.nextInspectionAt = 0;
    this.errorCode = '';
    this.lastOnlineInspection = -Infinity;
    this.setState(!nextEnabled ? 'disabled' : this.paused ? 'paused' : 'monitoring',
      !nextEnabled ? '自动恢复已关闭。' : this.paused ? '请先绑定当前登录 QQ 的账号，再启用自动恢复。' :
        '自动恢复已开启：持续断线 90 秒后才检查，恢复轮次间隔至少 5 分钟。');
    return this.snapshot();
  }

  active(generation) {
    return !this.disposed && this.enabled && !this.paused && this.generation === generation;
  }

  context(generation) {
    return { automatic: true, shouldContinue: () => this.active(generation) };
  }

  setState(phase, message) {
    const changed = this.phase !== phase || this.message !== message;
    this.phase = phase;
    this.message = message;
    if (changed) {
      try { this.log(message); } catch {}
    }
  }

  pause(message) {
    this.paused = true;
    this.cycle = null;
    this.setState('paused', message || '自动恢复已暂停，请打开 NapCat 管理页面检查。');
  }

  fail(message) {
    this.failures++;
    this.cycle = null;
    this.busySince = null;
    this.lastActionAt = this.now();
    if (this.failures >= 3) {
      this.pause('自动恢复连续 3 次未完成，已暂停。请手动处理后重新开启。');
    } else {
      this.setState('cooldown', (message || '本轮恢复未完成。') + ' 已进入 5 分钟冷却（' + this.failures + '/3）。');
    }
  }

  deferInspection(message) {
    this.inspectionFailures++;
    if (this.inspectionFailures >= 3) {
      this.pause('状态查询连续 3 次异常，自动恢复已暂停；未确认需要本人验证，不重复登录或重启。');
      return;
    }
    const delay = 30_000 * 2 ** (this.inspectionFailures - 1);
    this.nextInspectionAt = this.now() + delay;
    this.setState('retrying_status', message + ' ' + delay / 1000 + ' 秒后只重试状态查询，不提交登录。');
  }

  pauseForError(result) {
    this.errorCode = result?.error_code || 'unknown';
    this.pause(recoveryFailureMessage(this.errorCode));
  }

  snapshot() {
    let remaining = 0;
    if (this.enabled && !this.paused && !this.disposed) {
      if (this.nextInspectionAt > this.now()) {
        remaining = this.nextInspectionAt - this.now();
      } else if (this.phase === 'waiting_disconnect' && this.disconnectedSince !== null) {
        remaining = this.disconnectedSince + DISCONNECTED_DELAY - this.now();
      } else if (this.phase === 'cooldown') {
        remaining = this.lastActionAt + ROUND_COOLDOWN - this.now();
      } else if (this.cycle?.readySince != null && this.cycle.stage === 'worker') {
        remaining = this.cycle.readySince + READY_DELAY - this.now();
      }
    }
    return { enabled: this.enabled && !this.disposed, paused: this.paused, phase: this.phase,
      failures: this.failures, inspection_failures: this.inspectionFailures, error_code: this.errorCode,
      message: this.message, next_action_in_seconds: Math.max(0, Math.ceil(remaining / 1000)),
      account: this.account };
  }

  async tick({ connected = false, account = '', verifiedOnline = false } = {}) {
    if (!this.enabled || this.disposed) return this.snapshot();
    if (connected) {
      if (this.onlineSince === null) {
        // A restored message connection also cancels any late pre-action inspection.
        this.generation++;
        this.onlineSince = this.now();
        this.disconnectedSince = null;
        this.busySince = null;
        this.cycle = null;
        this.inspectionFailures = 0;
        this.nextInspectionAt = 0;
        if (!this.paused) this.errorCode = '';
      }
      // Observe an already authenticated, online connection. This performs no
      // login/restart and refreshes the helper's last verified account evidence.
      if (verifiedOnline && accountId(account) === this.account &&
          this.now() - this.lastOnlineInspection >= STABLE_ONLINE && typeof this.inspect === 'function') {
        this.lastOnlineInspection = this.now();
        const generation = this.generation;
        let state;
        try { state = await this.inspect({ automatic: true,
          shouldContinue: () => !this.disposed && this.enabled && this.generation === generation }); }
        catch { /* Keep an existing message connection intact on an observation failure. */ }
        if (this.disposed || !this.enabled || this.generation !== generation) return this.snapshot();
        if (state?.online === true && state.account === this.account && !state.requires_user_action) {
          if (Array.isArray(state.accounts) && state.accounts.map(String).includes(this.account)) {
            this.paused = false;
            this.errorCode = '';
          } else {
            this.pauseForError({ error_code: 'no_saved_account' });
          }
        } else if (state?.requires_user_action && !isTransientRecoveryError(state.error_code)) {
          this.pauseForError(state);
        }
      }
      if (this.now() - this.onlineSince >= STABLE_ONLINE) this.failures = 0;
      if (!this.paused) this.setState('online', '消息接口已连接，自动恢复保持待命。');
      return this.snapshot();
    }
    this.onlineSince = null;
    if (this.paused) return this.snapshot();
    if (this.disconnectedSince === null) this.disconnectedSince = this.now();
    if (this.now() - this.disconnectedSince < DISCONNECTED_DELAY) {
      this.setState('waiting_disconnect', '消息接口断开，先等待 NapCat 自身恢复；满 90 秒后再检查。');
      return this.snapshot();
    }
    if (this.task) return this.snapshot();
    if (this.now() < this.nextInspectionAt) return this.snapshot();
    if (!this.cycle && this.now() - this.lastActionAt < ROUND_COOLDOWN) {
      this.setState('cooldown', '恢复轮次间隔至少 5 分钟，正在冷却。');
      return this.snapshot();
    }
    const generation = this.generation;
    const task = Symbol('recovery');
    this.task = task;
    try {
      await this.step(generation);
    } catch {
      if (this.active(generation)) this.fail('无法确认本轮恢复结果。');
    } finally {
      if (this.task === task) this.task = null;
    }
    return this.snapshot();
  }

  async step(generation) {
    if (!this.active(generation)) return;
    if (typeof this.inspect !== 'function' || typeof this.restart !== 'function' || typeof this.login !== 'function') {
      this.pause('自动恢复接口尚未就绪，请重新打开助手。');
      return;
    }
    const state = await this.inspect(this.context(generation));
    if (!this.active(generation)) return;
    if (!state || typeof state !== 'object') { this.fail('未能读取 NapCat 状态。'); return; }
    if (state.account && String(state.account) !== this.account) {
      this.pause('NapCat 当前账号与绑定账号不一致，自动恢复已停止。');
      return;
    }
    const workerStarting = this.cycle?.stage === 'worker' && this.now() - this.cycle.startedAt < WORKER_TIMEOUT;
    if (state.retryable === true || isTransientRecoveryError(state.error_code)) {
      this.errorCode = state.error_code || 'unavailable';
      if (workerStarting) {
        this.nextInspectionAt = this.now() + 30_000;
        this.setState('waiting_worker', '现有 Worker 的管理接口暂时不可达，30 秒后仅查询状态，不追加重启或登录。');
      } else {
        this.deferInspection(recoveryFailureMessage(this.errorCode));
      }
      return;
    }
    this.inspectionFailures = 0;
    this.nextInspectionAt = 0;
    this.errorCode = '';
    if (state.online === true) {
      this.cycle = null;
      this.busySince = null;
      this.setState('waiting_connection', 'QQ 已在线，正在等待消息接口重新连接；不会重复登录或重启。');
      return;
    }
    if (state.running !== true) {
      if (workerStarting) {
        this.setState('waiting_worker', '已请求 Worker 重启，正在等待原 NapCat 管理接口恢复。');
      } else if (this.cycle?.stage === 'worker') {
        this.fail('Worker 重启后管理接口仍未恢复。');
      } else {
        this.pause('NapCat 管理接口不可达，自动恢复不会结束或另开未知 QQ，请手动打开原 NapCat。');
      }
      return;
    }
    if (state.requires_user_action) {
      if (workerStarting && (['unavailable', 'api_unavailable'].includes(state.error_code) ||
          (!state.error_code && Array.isArray(state.accounts) && !state.accounts.length))) {
        this.setState('waiting_worker', '原 NapCat 管理接口正在恢复，暂不提交新的登录请求。');
      } else {
        this.pauseForError(state);
      }
      return;
    }
    if (busy(state)) {
      this.busySince ??= this.now();
      if (this.now() - this.busySince >= WORKER_TIMEOUT) {
        this.pause('NapCat 长时间处于登录或恢复阶段，请打开管理页面检查，自动恢复已暂停。');
      } else {
        if (this.cycle?.stage === 'worker') this.cycle.readySince = null;
        this.setState('waiting_worker', 'NapCat 正在登录或恢复连接，等待完成，不重复提交动作。');
      }
      return;
    }
    this.busySince = null;
    if (state.account !== this.account) {
      if (workerStarting) {
        this.setState('waiting_worker', '正在等待原 NapCat 恢复绑定账号信息。');
      } else {
        this.pauseForError({ error_code: Array.isArray(state.accounts) && !state.accounts.map(String).includes(this.account)
          ? 'no_saved_account' : 'account_mismatch' });
      }
      return;
    }
    if (!Array.isArray(state.accounts) || !state.accounts.map(String).includes(this.account)) {
      if (workerStarting) {
        this.setState('waiting_worker', '正在等待原 NapCat 载入已保存的快捷登录记录。');
      } else {
        this.pause('没有绑定账号的可用快捷登录记录，请手动扫码，自动恢复已暂停。');
      }
      return;
    }
    if (this.cycle?.stage === 'login') {
      if (this.now() - this.cycle.submittedAt >= 15_000 &&
          (state.phase === 'waiting_qrcode' || state.needs_quick_login === true)) {
        this.pause(this.cycle.uncertain
          ? '快捷登录请求结果仍无法确认，已停止重复提交，请检查原 NapCat 管理页面。'
          : '一次快捷登录后仍未恢复，具体原因未确认，已停止重复提交，请检查原 NapCat 管理页面。');
      } else if (this.now() - this.cycle.submittedAt >= LOGIN_TIMEOUT) {
        this.fail('快捷登录请求已提交，但未确认恢复在线。');
      } else {
        this.setState('waiting_login', '本轮已提交一次快捷登录，等待真实在线结果，不重复登录。');
      }
      return;
    }
    if (this.cycle?.stage === 'worker') {
      if (!state.needs_quick_login) {
        if (this.now() - this.cycle.startedAt >= WORKER_TIMEOUT) this.fail('Worker 恢复后仍未具备快捷登录条件。');
        else this.setState('waiting_worker', '等待 Worker 登录状态稳定后，再提交本轮唯一一次快捷登录。');
        return;
      }
      this.cycle.readySince ??= this.now();
      if (this.now() - this.cycle.readySince < READY_DELAY) {
        this.setState('waiting_worker', 'Worker 管理接口已恢复，确认状态稳定后尝试一次快捷登录。');
        return;
      }
      await this.submitLogin(generation);
      return;
    }
    // A worker already waiting for QR login can use its saved account once without another restart.
    if (state.phase === 'waiting_qrcode' && state.needs_quick_login === true) {
      this.cycle = { stage: 'worker', startedAt: this.now(), readySince: this.now(), restarted: false };
      await this.submitLogin(generation);
      return;
    }
    if (!this.active(generation)) return;
    this.lastActionAt = this.now();
    this.cycle = { stage: 'worker', startedAt: this.now(), readySince: null, restarted: false };
    this.setState('restarting', '已确认绑定账号离线，正在请求原 NapCat 重启自己的 Worker。');
    const result = await this.restart(this.account, this.context(generation));
    if (!this.active(generation)) return;
    if (result?.account && String(result.account) !== this.account) {
      this.pause('NapCat 账号在恢复期间发生变化，自动恢复已停止。');
      return;
    }
    if (result?.online) {
      this.cycle = null;
      this.setState('waiting_connection', 'QQ 已恢复在线，等待消息接口连接。');
    } else if (result?.restarted === true) {
      this.cycle.restarted = true;
      this.setState('waiting_worker', '已请求本轮唯一一次 Worker 重启，等待原接口恢复。');
    } else if (result?.recovering) {
      this.cycle = null;
      this.setState('waiting_worker', 'NapCat 已在恢复中，不追加重启请求。');
    } else if (result?.requires_user_action && !['unavailable', 'api_unavailable'].includes(result.error_code)) {
      this.pauseForError(result);
    } else {
      this.fail('本轮 Worker 重启未确认完成。');
    }
  }

  async submitLogin(generation) {
    if (!this.active(generation) || !this.cycle || this.cycle.stage === 'login') return;
    this.cycle.stage = 'login';
    this.cycle.submittedAt = this.now();
    this.lastActionAt = this.now();
    this.setState('logging_in', '正在使用绑定账号的已保存记录，提交本轮唯一一次快捷登录。');
    const result = await this.login(this.account, this.context(generation));
    if (!this.active(generation)) return;
    if (result?.account && String(result.account) !== this.account) {
      this.pause('NapCat 账号在登录期间发生变化，自动恢复已停止。');
      return;
    }
    if (result?.online) {
      this.cycle = null;
      this.setState('waiting_connection', 'QQ 已在线，等待消息接口恢复。');
    } else if (result?.submission_uncertain === true) {
      this.cycle.uncertain = true;
      this.errorCode = result.error_code || 'unavailable';
      this.setState('waiting_login', '快捷登录请求响应中断，结果尚不确定；仅查询是否在线，不重复提交登录。');
    } else if (result?.login_requested === true || result?.recovering === true) {
      this.setState('waiting_login', '已提交或已有一次快捷登录，等待真实在线结果；不会重复提交。');
    } else if (result?.requires_user_action) {
      this.pauseForError(result);
    } else {
      this.fail('本轮快捷登录请求未确认完成。');
    }
  }

  dispose() {
    this.generation++;
    this.disposed = true;
    this.enabled = false;
    this.cycle = null;
    this.setState('disabled', '助手已关闭，自动恢复监控已停止。');
  }
}
