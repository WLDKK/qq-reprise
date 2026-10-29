#!/usr/bin/env node
import {recallSendPlan,richPreview,dropPreviewMedia} from './recall-rich-message.mjs';
import { SettingsFieldError } from './settings-field-error.mjs';
import { RecallNameBindings } from './recall-name-bindings.mjs';
import { readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULTS, id, normalizeEvent, parseCQ, TTLCache, OneBotClient, RecallReposter, validateResendExemptions, validateCacheSettings } from './engine.mjs';
import { CommandConfirmations, defaultCommandReplies, validateCommandReplies } from './command-confirmations.mjs';
import { quickLogin, getLoginState, restartWorker } from './quick-login.mjs';
import { ResendQueue,messageMediaBytes } from './send-queue.mjs';
import { RecoveryWatchdog } from './recovery.mjs';
import { ConnectionWatchdog } from './connection-watchdog.mjs';
import { RetainedOutbox, validateDeliverySettings } from './retained-outbox.mjs';
import { AIChat } from './ai-chat.mjs';
import { publicAIError } from './ai-providers.mjs';
import { AIError } from './ai-auth.mjs';
import { OAUTH_DIAGNOSTIC_VERSION, renderOAuthResultPage } from './oauth-diagnostic.mjs';
import { inspectOneBotConnection } from './onebot-diagnostics.mjs';
import { GroupSignService } from './group-sign.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const COMMAND_DEFAULTS = { command_on: '开机', command_off: '关机' };
function commandPermissions(input) {
  if (!Array.isArray(input) || input.length > 50) throw new Error('授权名单最多 50 项。');
  const unique = new Map();
  for (const item of input) {
    if (!item || !['group', 'private'].includes(item.type) || !id(item.peer_id, true) ||
        !id(item.user_id, true) || (item.type === 'private' && id(item.peer_id, true) !== id(item.user_id, true))) {
      throw new Error('请选择授权来源和具体成员，私聊只能授权该好友本人。');
    }
    const rule = {
      type: item.type, peer_id: id(item.peer_id, true), user_id: id(item.user_id, true),
      peer_name: String(item.peer_name || item.peer_id).slice(0, 100),
      user_name: String(item.user_name || item.user_id).slice(0, 100),
    };
    unique.set(rule.type + ':' + rule.peer_id + ':' + rule.user_id, rule);
  }
  return [...unique.values()];
}
function mediaBytes(message) {return messageMediaBytes(message);}
async function readJSON(path) {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}

export async function discoverNapCat(extraRoots = []) {
  const roots = [
    ...extraRoots, process.env.NAPCAT_DIR, join(ROOT, 'NapCat.Shell'),
    join(ROOT, '..', 'NapCat.Shell'), join(homedir(), 'Desktop', 'NapCat.Shell'),
  ].filter(Boolean);
  for (const parent of [join(homedir(), 'Desktop'), join(homedir(), 'Downloads')]) {
    try {
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && /^napcat/i.test(entry.name)) roots.push(join(parent, entry.name));
      }
    } catch {}
  }
  const candidates = [];
  for (const root of new Set(roots.map((path) => resolve(path)))) {
    let entries;
    try { entries = await readdir(join(root, 'config')); } catch { continue; }
    for (const filename of entries.filter((name) => /^onebot11(?:_\d+)?\.json$/i.test(name))) {
      let config;
      try { config = await readJSON(join(root, 'config', filename)); } catch { continue; }
      for (const server of config.network?.websocketServers ?? []) {
        if (!server?.enable || !Number.isInteger(Number(server.port)) ||
            Number(server.port) < 1 || Number(server.port) > 65535) continue;
        const host = String(server.host || '127.0.0.1');
        if (!['0.0.0.0', '127.0.0.1', 'localhost', '::', '::1'].includes(host)) continue;
        const address = host.includes(':') ? '[::1]' : '127.0.0.1';
        candidates.push({
          ...DEFAULTS,
          ws_url: 'ws://' + address + ':' + Number(server.port) + '/',
          access_token: String(server.token || ''),
          expected_self_id: filename.match(/_(\d+)\.json$/i)?.[1] || '',
          report_self: server.reportSelfMessage === true,
        });
      }
    }
  }
  candidates.sort((a, b) => Number(!a.ws_url.includes(':3001/')) - Number(!b.ws_url.includes(':3001/')));
  return candidates;
}

export class PrivateRecallApp {
  constructor(options = {}) {
    this.configPath = options.configPath || join(ROOT, 'config.json');
    this.recallNames = new RecallNameBindings(dirname(this.configPath));
    this.initialRecoveryPause = options.initialRecoveryPause === true;
    this.discover = options.discover || discoverNapCat;
    this.logger = options.logger || console.log;
    this.session = randomBytes(24).toString('hex');
    this.controller = new AbortController();
    this.preferences = {
      target_type: 'group', group_id: '', group_name: '',
      friend_id: '', friend_name: '', auto_start: false, auto_resend: false,
      resend_self: false,
      resend_exempt_qq_ids: [],
      cache_messages_per_chat: 200, cache_ttl_minutes: 30,
      outbox_limit: 100, outbox_ttl_minutes: 30, recall_match_seconds: 15,
      send_interval_seconds: 3, auto_recovery: false, recovery_account: '',
      command_allow_others: false, command_permissions: [], command_account: '',
      ...COMMAND_DEFAULTS,
      ...defaultCommandReplies(COMMAND_DEFAULTS.command_on, COMMAND_DEFAULTS.command_off),
    };
    this.friends = [];
    this.groups = [];
    this.client = null;
    this.engine = null;
    this.active = false;
    this.connected = false;
    this.error = '';
    this.selfId = '';
    this.target = null;
    this.logs = [];
    this.sentCount = 0;
    this.missingCount = 0;
    this.recalls = [];
    this.recallBytes = 0;
    this.recallMediaLimit = options.recallMediaLimit ?? 32 * 1024 * 1024;
    this.commandSeen = new TTLCache(3600000, 1000);
    this.commandConfirmations = new CommandConfirmations();
    this.resendOutputMarkers = new CommandConfirmations();
    this.resendTask = Promise.resolve();
    this.exemptQQIds = [];
    this.exemptionsError = '';
    this.reconnectAttempt = 0;
    this.nextReconnectAt = 0;
    this.lastDisconnect = '';
    this.connectionWatchdog = null;
    this.lastStatusCheck = '';
    this.statusFailures = 0;
    this.onlineConfirmed = false;
    this.sendQueue = options.sendQueue || new ResendQueue({ intervalMs: 3000 });
    this.latestEventApi = null;
    this.outbox = new RetainedOutbox({ pace: this.sendQueue, inspect: job => this.outboxPermission(job),
      submit: job => this.submitOutbox(job), onState: (job, state) => this.outboxState(job, state) });
    this.ai = new AIChat({ dir: dirname(this.configPath), app: this, fetcher: options.aiFetcher, secrets: options.aiSecrets, poolSecrets: options.aiPoolSecrets, provider: options.aiProvider,initialState:options.initialAIState });
    this.groupSign = new GroupSignService({dir:dirname(this.configPath),app:this,now:options.now||Date.now,...options.groupSignOptions});
    this.saveTask = Promise.resolve();
    this.recoveryActions = options.recoveryActions || { inspect: getLoginState, restart: restartWorker, login: quickLogin };
    this.recovery = new RecoveryWatchdog({
      ...this.recoveryActions, now: options.now || Date.now, log: message => this.log(message),
    });
    this.recoverySettingsGeneration = 0;
    this.recoveryTimer = null;
    this.recoveryTickTask = null;
  }
  log(message) {
    const entry = {
      time: new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      message,
    };
    this.logs.push(entry);
    if (this.logs.length > 60) this.logs.shift();
    this.logger('[' + entry.time + '] ' + message);
  }
  async initialize() {
    await this.recallNames.initialize();
    await this.ai.initialize();
    await this.groupSign.initialize();
    try {
      const saved = await readJSON(this.configPath);
      this.preferences = {
        target_type: ['group', 'private'].includes(saved.target_type)
          ? saved.target_type : id(saved.friend_id, true) ? 'private' : 'group',
        group_id: id(saved.group_id, true) || '',
        group_name: typeof saved.group_name === 'string' ? saved.group_name : '',
        friend_id: id(saved.friend_id, true) || '',
        friend_name: typeof saved.friend_name === 'string' ? saved.friend_name : '',
        auto_start: saved.auto_start === true,
        auto_resend: saved.auto_resend === true,
        resend_self: saved.resend_self === true,
        resend_exempt_qq_ids: saved.resend_exempt_qq_ids ?? [],
        cache_messages_per_chat: 200, cache_ttl_minutes: 30,
        outbox_limit: 100, outbox_ttl_minutes: 30, recall_match_seconds: 15,
        send_interval_seconds: Number.isFinite(saved.send_interval_seconds) &&
          saved.send_interval_seconds >= 0 && saved.send_interval_seconds <= 60 ? saved.send_interval_seconds : 3,
        command_allow_others: false, command_permissions: [], command_account: '',
        auto_recovery: saved.auto_recovery === true && /^[1-9]\d{4,11}$/.test(String(saved.recovery_account || '')),
        recovery_account: id(saved.recovery_account, true) || '',
        command_on: typeof saved.command_on === 'string' && saved.command_on.trim()
          ? saved.command_on.trim() : COMMAND_DEFAULTS.command_on,
        command_off: typeof saved.command_off === 'string' && saved.command_off.trim()
          ? saved.command_off.trim() : COMMAND_DEFAULTS.command_off,
      };
      if (this.preferences.command_on === this.preferences.command_off) {
        Object.assign(this.preferences, COMMAND_DEFAULTS);
      }
      try {
        Object.assign(this.preferences, validateCacheSettings(saved.cache_messages_per_chat ?? 200, saved.cache_ttl_minutes ?? 30));
      } catch { this.log('缓存设置无效，已使用 200 条、30 分钟的有界默认值；其他设置保留。'); }
      try { Object.assign(this.preferences, validateDeliverySettings(saved.outbox_limit ?? 100, saved.outbox_ttl_minutes ?? 30, saved.recall_match_seconds ?? 15)); }
      catch { this.log('待发送设置无效，已使用有界默认值，其他规则保留。'); }
      this.outbox.configure(this.preferences.outbox_limit, this.preferences.outbox_ttl_minutes * 60000);
      try {
        this.exemptQQIds = validateResendExemptions(this.preferences.resend_exempt_qq_ids);
        this.preferences.resend_exempt_qq_ids = this.exemptQQIds;
      } catch {
        this.exemptionsError = '豁免白名单配置无效，自动重发已暂停；请填写有效 QQ 号并保存。';
        this.log(this.exemptionsError);
      }
      const replyDefaults = defaultCommandReplies(this.preferences.command_on, this.preferences.command_off);
      try {
        Object.assign(this.preferences, validateCommandReplies(this.preferences.command_on, this.preferences.command_off,
          saved.command_reply_on ?? replyDefaults.command_reply_on, saved.command_reply_off ?? replyDefaults.command_reply_off));
      } catch {
        Object.assign(this.preferences, replyDefaults);
        this.log('无效的命令确认回复已恢复为安全默认文本，原口令和授权保留。');
      }
      try {
        this.preferences.command_permissions = commandPermissions(saved.command_permissions ?? []);
        this.preferences.command_account = id(saved.command_account, true) || '';
        this.preferences.command_allow_others = saved.command_allow_others === true && !!this.preferences.command_account;
      } catch { this.log('已忽略无效的口令授权名单，仅本人可控制。'); }
      this.sendQueue.setInterval(this.preferences.send_interval_seconds * 1000);
      if (this.preferences.auto_recovery) {
        // 只读预热身份；后台重连本身不提交任何登录或重启。
        await this.recoveryActions.inspect().catch(() => null);
        this.recovery.configure(true, this.preferences.recovery_account);
        if (this.initialRecoveryPause) {
          this.recovery.errorCode = 'action_failed';
          this.recovery.pause('沿用升级前自动恢复暂停状态；只观察已有连接，不重新提交登录或重启。');
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('已忽略无法读取的旧配置，请重新选择会话。');
    }
  }
  savedTarget() {
    const type = this.preferences.target_type;
    const value = type === 'group' ? this.preferences.group_id : this.preferences.friend_id;
    const name = type === 'group' ? this.preferences.group_name : this.preferences.friend_name;
    return value ? { type, id: value, name, [type === 'group' ? 'group_id' : 'user_id']: value } : null;
  }
  targets(type) { return type === 'group' ? this.groups : this.friends; }
  state() {
    const cache = this.engine?.cacheSnapshot();
    return {
      ai: this.ai.state(),
      group_sign: this.groupSign.state(),
      recall_name_bindings: this.recallNames.state(),
      recall_cycle_version: 2,
      combined_control_error: this.combinedControlError || '',
      connected: this.connected, active: this.active, error: this.error,
      auto_resend: this.preferences.auto_resend && !this.exemptionsError,
      resend_exempt_qq_ids: [...this.exemptQQIds], resend_exempt_error: this.exemptionsError,
      resend_self: this.preferences.resend_self,
      send_interval_seconds: this.preferences.send_interval_seconds,
      send_jitter_seconds: 0.3,
      pending_resends: this.outbox.snapshot().pending,
      delivery: this.outbox.snapshot(),
      outbox_limit: this.preferences.outbox_limit, outbox_ttl_minutes: this.preferences.outbox_ttl_minutes,
      recall_match_seconds: this.preferences.recall_match_seconds,
      cache_messages_per_chat: this.preferences.cache_messages_per_chat,
      cache_ttl_minutes: this.preferences.cache_ttl_minutes,
      pending_recall_matches: cache?.pending_matches ?? 0,
      cache_stats: cache ?? null,
      queued_media_mb: Number((this.sendQueue.mediaBytes / 1024 / 1024).toFixed(1)),
      recovery: this.recovery.snapshot(),
      commands: { on: this.preferences.command_on, off: this.preferences.command_off,
        reply_on: this.preferences.command_reply_on, reply_off: this.preferences.command_reply_off,
        allow_others: this.preferences.command_allow_others,
        permissions: structuredClone(this.preferences.command_permissions) },
      reconnect_in_seconds: this.connected ? 0 : Math.max(0, Math.ceil((this.nextReconnectAt - Date.now()) / 1000)),
      last_disconnect: this.lastDisconnect,
      recall_media_mb: Number((this.recallBytes / 1024 / 1024).toFixed(1)),
      self_id: this.selfId,
      target_type: this.preferences.target_type,
      target: this.target || this.savedTarget(),
      cached: cache?.cached ?? 0,
      sent: this.sentCount, missing: this.missingCount,
      friend_count: this.friends.length, group_count: this.groups.length, logs: this.logs,
      recalls: this.recalls.map((record) => ({
        id: record.id, time: record.time, message_id: record.message_id, status: record.status,
        sender_name: record.sender_name,
        author_id: record.author_id, operator_id: record.operator_id,
        operator_name: record.operator_name, recall_kind: record.recall_kind,
        recall_label: record.recall_label,
        conversation_type: record.conversation_type,recovery:record.recovery||null,
        segments: record.message.map((segment, index) => {
          if (segment.type === 'text') return { type: 'text', text: String(segment.data.text || '') };
          if (segment.type === 'image') return {
            type: 'image',
            url: String(segment.data.file || '').startsWith('base64://') ? '/media/' + record.id + '/' + index : '',
            summary: String(segment.data.summary || '照片 / 图片表情包'),
          };
          if (segment.type === 'face') return { type: 'face', text: 'QQ 表情 #' + String(segment.data.id ?? '') };
          return { type: 'other', text: richPreview(segment) };
        }),
      })),
    };
  }
  async savePreferences() {
    const temporary = this.configPath + '.tmp';
    this.saveTask = this.saveTask.catch(() => {}).then(async () => {
      const payload = JSON.stringify(this.preferences, null, 2) + '\n';
      await writeFile(temporary, payload, 'utf8');
      await rename(temporary, this.configPath);
    });
    return this.saveTask;
  }
  clearRecalls() {
    this.recalls = [];
    this.recallBytes = 0;
  }
  rememberRecall(record) {
    const entry = {
      ...record, id: randomBytes(12).toString('hex'),
      time: new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      status: this.preferences.auto_resend ? '等待发送确认' : '仅在本页显示',
    };
    entry.mediaBytes = mediaBytes(entry.message);
    if (entry.mediaBytes > this.recallMediaLimit) {
      entry.message = dropPreviewMedia(entry.message);
      entry.mediaBytes = 0;
    }
    this.recalls.unshift(entry);
    this.recallBytes += entry.mediaBytes;
    while (this.recalls.length > 10 || this.recallBytes > this.recallMediaLimit) {
      this.recallBytes -= this.recalls.pop().mediaBytes;
    }
  }
  activate(target) {
    this.outbox.cancel(() => true, 'scope_changed');
    this.engine?.clear();
    this.engine = new RecallReposter({
      ...DEFAULTS,
      friend_ids: target.type === 'private' ? [target.id] : [],
      group_ids: target.type === 'group' ? [target.id] : [],
      expected_self_id: this.selfId,
      auto_resend: this.preferences.auto_resend && !this.exemptionsError,
      resend_exempt_qq_ids: [...this.exemptQQIds],
      ignore_self_messages: !this.preferences.resend_self,
      recent_messages_per_chat: this.preferences.cache_messages_per_chat,
      message_cache_ttl_ms: this.preferences.cache_ttl_minutes * 60000,
      recall_match_wait_ms: this.preferences.recall_match_seconds * 1000,
      send_interval_ms: Math.round(this.preferences.send_interval_seconds * 1000),
    }, (message) => this.log(message), Date.now, globalThis.fetch, this.sendQueue);
    this.clearRecalls();
    this.engine.onRecall = (record) => this.rememberRecall(record);
    this.engine.resolveRecallName = (group, qq, fallback) => this.recallNames.resolve(group, qq, fallback);
    this.engine.deliver = payload => this.outbox.enqueue(payload);
    const engine = this.engine;
    this.engine.onSendState = (messageId, state) => {
      if (this.engine !== engine) return;
      const record = this.recalls.find(item => item.message_id === messageId);
      if (!record) return;
      const labels = {
        queued: '排队等待重发', sending: '正在等待发送确认',
        cancelled: '已取消重发，仅在本页显示', queue_full: '发送队列已满，仅在本页显示',
        exempt: '原作者在豁免白名单，仅在本页显示',
      };
      record.status = labels[state] || record.status;
    };
    this.target = target;
    this.active = true;
    this.sentCount = 0;
    this.missingCount = 0;
    this.log('开始监听' + (target.type === 'group' ? '群聊 ' : '好友 ') +
      target.name + '；内存缓存最多 ' + this.preferences.cache_messages_per_chat + ' 条、' + this.preferences.cache_ttl_minutes + ' 分钟。');
  }
  async selectTarget(type, value) {
    if (!this.connected) throw new Error('NapCat 尚未连接，请稍候。');
    if (!['group', 'private'].includes(type)) throw new Error('请选择群聊或好友模式。');
    const target = this.targets(type).find((item) => item.id === id(value, true));
    if (!target) throw new Error(type === 'group' ? '请从群聊列表中选择一个群。' : '请从好友列表中选择一位好友。');
    const prefix = type === 'group' ? 'group' : 'friend';
    this.preferences = {
      ...this.preferences, target_type: type,
      [prefix + '_id']: target.id, [prefix + '_name']: target.name, auto_start: true,
    };
    await this.savePreferences();
    this.activate(target);
  }
  async selectFriend(value) { return this.selectTarget('private', value); }
  async selectGroup(value) { return this.selectTarget('group', value); }
  async stopMonitoring() {
    this.outbox.cancel();
    this.active = false;
    this.engine?.clear();
    this.engine = null;
    this.clearRecalls();
    this.preferences.auto_start = false;
    await this.savePreferences();
    this.log('已停止监听。');
  }
  async setResend(enabled, hooks = {}) {
    if (typeof enabled !== 'boolean') throw new Error('开关值必须是 true 或 false。');
    const task = this.resendTask.catch(() => {}).then(async () => {
      if (hooks.isAuthorized && !hooks.isAuthorized()) return { changed: false, skipped: true };
      if (enabled && this.exemptionsError) throw new Error(this.exemptionsError);
      if (hooks.combined) {
        try { await this.ai.setOperationalEnabled(enabled); this.combinedControlError = ''; }
        catch (error) {
          this.combinedControlError = publicAIError(error); this.ai.suspendOperational();
          this.preferences.auto_resend = false; if (this.engine) {this.engine.config.auto_resend=false;this.engine.cancelPendingSends();} this.outbox.cancel();
          await this.ai.settingsFile.write(this.ai.config).catch(()=>{});await this.savePreferences().catch(()=>{});throw error;
        }
        if (hooks.isAuthorized && !hooks.isAuthorized()) {await this.ai.setOperationalEnabled(false);return {changed:false,skipped:true};}
      }
      const previous = this.preferences.auto_resend;
      this.preferences.auto_resend = enabled;
      if (this.engine) {
        this.engine.config.auto_resend = enabled;
        if (!enabled) this.engine.cancelPendingSends();
      }
      if (!enabled) this.outbox.cancel();
      try { await this.savePreferences(); }
      catch (error) {
        if (hooks.combined) {
          this.combinedControlError = 'settings_save_failed'; await this.ai.setOperationalEnabled(false).catch(()=>{});
          this.preferences.auto_resend=false;if(this.engine){this.engine.config.auto_resend=false;this.engine.cancelPendingSends();}this.outbox.cancel();throw error;
        }
        this.preferences.auto_resend = previous;
        if (this.engine) this.engine.config.auto_resend = previous && !this.exemptionsError;
        throw error;
      }
      const changed = previous !== enabled;
      this.log(changed ? (enabled ? '自动重发已开启。' : '自动重发已关闭，未发出的队列已取消。')
        : (enabled ? '自动重发原本已开启，状态已确认。' : '自动重发原本已关闭，状态已确认。'));
      if (hooks.afterPersist) {
        try { await hooks.afterPersist({ changed }); }
        catch { this.log('命令状态已保存，但确认回复未获接口确认；不重复发送确认。'); }
      }
      return { changed };
    });
    this.resendTask = task;
    return task;
  }
  async setResendExemptions(input) {
    const values = validateResendExemptions(input);
    this.preferences.resend_exempt_qq_ids = values;
    this.exemptQQIds = values;
    this.outbox.cancel(job => values.includes(job.authorId), 'exempt');
    this.exemptionsError = '';
    if (this.engine) {
      this.engine.setResendExemptions(values);
      this.engine.config.auto_resend = this.preferences.auto_resend;
    } else this.sendQueue.cancel(job => (job.priority || 0) >= 0 && values.includes(job.authorId), 'exempt');
    await this.savePreferences();
    this.log('撤回重发豁免白名单已保存，按原作者 QQ 号判断，未发送队列已同步过滤。');
  }
  async setSendInterval(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) {
      throw new Error('请设置 0～60 秒的重发基准间隔。');
    }
    this.preferences.send_interval_seconds = seconds;
    this.sendQueue.setInterval(Math.round(seconds * 1000));
    await this.savePreferences();
    this.log('重发基准间隔已设为 ' + seconds + ' 秒，每条随机浮动 ±0.3 秒且不低于 0；已排队消息也生效。');
  }
  async setCacheSettings(limit, minutes) {
    const values = validateCacheSettings(limit, minutes);
    const previous = { cache_messages_per_chat: this.preferences.cache_messages_per_chat,
      cache_ttl_minutes: this.preferences.cache_ttl_minutes };
    Object.assign(this.preferences, values);
    try { await this.savePreferences(); }
    catch (error) { Object.assign(this.preferences, previous); throw error; }
    this.engine?.setCacheSettings(limit, minutes);
    this.log('内存缓存已设为最多 ' + limit + ' 条、' + minutes + ' 分钟；调小立即淘汰超界消息，不保存正文到磁盘。');
  }
  async setDeliverySettings(limit, minutes, matchSeconds) {
    const settings = validateDeliverySettings(limit, minutes, matchSeconds);
    const previous = { outbox_limit: this.preferences.outbox_limit, outbox_ttl_minutes: this.preferences.outbox_ttl_minutes,
      recall_match_seconds: this.preferences.recall_match_seconds };
    Object.assign(this.preferences, settings);
    try { await this.savePreferences(); } catch (error) { Object.assign(this.preferences, previous); throw error; }
    this.outbox.configure(limit, minutes * 60000);
    if (this.engine) this.engine.config.recall_match_wait_ms = matchSeconds * 1000;
    this.log('待发送内存队列：最多' + limit + '条、' + minutes + '分钟；快速撤回等待' + matchSeconds + '秒。');
  }
  outboxPermission(job) {
    if (job.selfId !== this.selfId || !this.target || job.type !== this.target.type || job.peerId !== this.target.id) return 'scope_changed';
    if (this.exemptQQIds.includes(job.authorId)) return 'exempt';
    if (!this.active || !this.preferences.auto_resend || this.exemptionsError || (job.isSelf && !this.preferences.resend_self)) return 'cancelled';
    return this.connected && this.onlineConfirmed ? 'ready' : 'offline';
  }
  async submitOutbox(job) {
    const api = this.client || this.latestEventApi;
    if (!api) throw Object.assign(new Error('未提交：无可用连接'), { notSubmitted: true });
    const scope = { self_id: job.selfId, conversation_type: job.type, peer_id: job.peerId };
    const receipt = result => {
      const messageId = id(result?.message_id ?? result);
      if (messageId === null) return;
      this.resendOutputMarkers.ids.set(job.selfId + ':' + job.type + ':' + job.peerId + ':' + messageId, Date.now() + 86400000);
      this.outbox.confirm(job.key, messageId);
    };
    try {
      const plan=recallSendPlan(job.message,job);
      return await this.resendOutputMarkers.track(scope, job.message, () => api.call(plan.action,plan.body,{ onLateResult: receipt }), receipt);
    } catch (error) {
      this.log('重发保留：' + (error.notSubmitted ? '连接不可用，明确尚未提交' : '结果不确定，不自动再次提交') +
        (Number.isFinite(error.retcode) ? '；retcode=' + error.retcode : '') + (error.category ? '；类别=' + error.category : '') + '。');
      throw error;
    }
  }
  outboxState(job, state) {
    const labels = { queued: '排队等待重发', sending: '正在等待发送确认', deferred: '暂不能发送，已留存待恢复',
      uncertain: '发送结果不确定，保留等待回执，不自动重试', sent: '已重发到原会话',
      cancelled: '已取消重发', exempt: '原作者已豁免，已取消', scope_changed: '账号或会话已变，已取消',
      dropped: '队列超量，已舍弃最早项', expired: '待发送保留期已满，已舍弃' };
    const record = this.recalls.find(item => item.message_id === job.sourceMessageId && item.conversation_type === job.type && item.conversation_id === job.peerId);
    if (record) record.status = labels[state] || record.status;
    if (state === 'sent') this.sentCount++;
  }
  async setSelfResend(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('本人撤回开关值必须为 true 或 false。');
    if (!enabled) this.outbox.cancel(job => job.isSelf);
    this.preferences.resend_self = enabled;
    this.engine?.setSelfRecall(enabled);
    await this.savePreferences();
    this.log(enabled ? '已允许重发本人原消息：自行撤回原样发送，代撤按统一模板；仍受自动重发总开关控制。'
      : '已关闭本人撤回重发，尚未发出的本人消息已取消。');
  }
  async setRecallName(input) {
    await this.recallNames.set(input);
  }
  async setRecovery(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('自动恢复开关值必须是 true 或 false。');
    const generation = ++this.recoverySettingsGeneration;
    if (!enabled) {
      this.preferences.auto_recovery = false;
      this.recovery.configure(false, this.preferences.recovery_account);
      await this.savePreferences();
      return;
    }
    const account = this.selfId || this.preferences.recovery_account;
    if (!/^[1-9]\d{4,11}$/.test(account || '')) throw new Error('请先成功登录 QQ 并连接助手一次，再开启自动恢复。');
    const status = await this.recoveryActions.inspect();
    if (generation !== this.recoverySettingsGeneration || this.controller.signal.aborted) return;
    if (!status || status.account !== account || status.requires_user_action) {
      throw new Error('尚未确认当前 QQ 的身份或登录记录。请先完成快捷登录/本人验证，再开启自动恢复。');
    }
    this.preferences.auto_recovery = true;
    this.preferences.recovery_account = account;
    this.recovery.configure(true, account);
    await this.savePreferences();
    await this.runRecoveryTick();
  }
  async runRecoveryTick() {
    if (this.recoveryTickTask) return this.recoveryTickTask;
    const task = this.recovery.tick({ connected: this.connected,
      account: this.selfId, verifiedOnline: this.onlineConfirmed });
    this.recoveryTickTask = task;
    try { return await task; }
    finally { if (this.recoveryTickTask === task) this.recoveryTickTask = null; }
  }
  async commandMembers(groupId) {
    const group = this.groups.find(item => item.id === id(groupId, true));
    const client = this.client;
    if (!this.connected || !client) throw new Error('请先连接 NapCat 再读取群成员。');
    if (!group) throw new Error('请从当前 QQ 的群聊列表选择授权来源。');
    const members = await client.call('get_group_member_list', { group_id: Number(group.id) });
    if (client !== this.client || !this.connected) throw new Error('连接已变化，请重新读取成员。');
    if (!Array.isArray(members)) throw new Error('暂时无法读取群成员，请稍后再试。');
    return members.map(item => ({ id: id(item.user_id, true),
      name: String(item.card || item.nickname || item.user_id) })).filter(item => item.id && item.id !== this.selfId);
  }
  async setCommands(on, off, authorization = {}) {
    if (typeof on !== 'string' || typeof off !== 'string') throw new Error('口令必须是文字。');
    on = on.trim(); off = off.trim();
    if (!on || !off || on === off || on.length > 40 || off.length > 40 || /[\r\n]/.test(on + off)) {
      throw new Error('请设置不同的开启和关闭口令，每条 1～40 个字符且不换行。');
    }
    const allowOthers = authorization.allow_others ?? this.preferences.command_allow_others;
    if (typeof allowOthers !== 'boolean') throw new Error('授权开关值必须为 true 或 false。');
    const permissions = commandPermissions(authorization.permissions ?? this.preferences.command_permissions);
    const replies = validateCommandReplies(on, off,
      authorization.reply_on ?? this.preferences.command_reply_on,
      authorization.reply_off ?? this.preferences.command_reply_off);
    if (allowOthers && (!this.connected || !this.selfId)) throw new Error('请先连接 QQ，再保存他人口令授权。');
    Object.assign(this.preferences, { command_on: on, command_off: off,
      ...replies,
      command_allow_others: allowOthers, command_permissions: permissions,
      command_account: this.selfId || this.preferences.command_account });
    await this.savePreferences();
    this.log('启停口令已更新；' + (allowOthers ? permissions.length + ' 项授权已启用' : '仅本人可控制') + '，只控制当前监听会话的自动重发。');
  }
  commandAuthorized(normalized, event) {
    const target = this.target || this.savedTarget();
    if (!normalized || !target || !['message', 'message_sent'].includes(event.post_type) ||
        String(normalized.self_id) !== this.selfId || event.anonymous || event.sub_type === 'anonymous') return false;
    const own = normalized.user_id === this.selfId;
    const inTarget = normalized.conversation_type === target.type && normalized.peer_id === target.id;
    const permitted = !own && this.preferences.command_allow_others &&
      this.preferences.command_account === this.selfId && this.preferences.command_permissions.some(rule =>
        rule.type === normalized.conversation_type && rule.peer_id === normalized.peer_id && rule.user_id === normalized.user_id);
    return (own && inTarget) || permitted;
  }
  async handleOwnCommand(event, api) {
    const normalized = normalizeEvent(event);
    if (!this.commandAuthorized(normalized, event)) return false;
    const target = this.target || this.savedTarget();
    const own = normalized.user_id === this.selfId;
    const inTarget = normalized.conversation_type === target.type && normalized.peer_id === target.id;
    const segments = typeof event.message === 'string' ? parseCQ(event.message) : event.message;
    if (!Array.isArray(segments) || !segments.length || segments.some((part) => part.type !== 'text')) return false;
    const content = segments.map((part) => String(part.data?.text || '')).join('').trim();
    let enabled;
    if (content === this.preferences.command_on) enabled = true;
    else if (content === this.preferences.command_off) enabled = false;
    else return false;
    const key = this.selfId + ':' + normalized.conversation_type + ':' + normalized.peer_id + ':' + event.message_id;
    if (this.commandSeen.get(key)) return true;
    this.commandSeen.put(key, true);
    if (!enabled) this.ai.suspendOperational();
    // 原始有效口令计入聊天窗口；自动确认回声只缓存，不触发口令或AI。
    if (inTarget && this.active && this.engine) await this.engine.handle(event, api);
    try {
      const outcome = await this.setResend(enabled, {
        combined: true,
        isAuthorized: () => this.commandAuthorized(normalized, event) &&
          content === this.preferences[enabled ? 'command_on' : 'command_off'],
        afterPersist: async () => {
          if (!this.commandAuthorized(normalized, event)) return;
          const reply = this.preferences[enabled ? 'command_reply_on' : 'command_reply_off'];
          await this.commandConfirmations.send(normalized, reply, api);
        },
      });
      if (outcome.skipped) { this.log('口令执行前授权或设置已变化，已跳过，不发送状态确认。'); return true; }
    } catch(error) {
      const code=this.combinedControlError||publicAIError(error);this.log('口令执行未完成：'+code+'；未发送成功确认。');
      if(enabled&&['ai_safety_blocked','private_hold_migration_pending','api_key_required','plan_permission_missing','qq_verification_required'].includes(code)&&this.commandAuthorized(normalized,event)){
        const reason=code==='ai_safety_blocked'?'AI接口仍处于安全暂停':code==='private_hold_migration_pending'?'旧私聊待处理保护尚未核对':code==='api_key_required'?'AI接口尚未配置':code==='qq_verification_required'?'QQ在线身份尚未核实':'AI账户权限尚未就绪';
        try{await this.commandConfirmations.send(normalized,'未开启：'+reason+'；AI和撤回均保持关闭。请查看管理页状态。',api);}catch{this.log('口令失败说明未确认送达，不自动重试。');}
      }
      return true;
    }
    this.log('已识别' + (own ? '本人' : '授权 QQ ' + normalized.user_id + ' 在' +
      (normalized.conversation_type === 'group' ? '群 ' : '私聊 ') + normalized.peer_id + ' 的') +
      (enabled ? '开启' : '关闭') + '口令。');
    return true;
  }
  async onEvent(event, api) {
    this.latestEventApi = api;
    this.ai.observe(event);
    this.ai.fastRecall(event);
    const eventEngine = this.engine;
    const fromAI = this.ai.markers.consume(event);
    const fromCommand = this.commandConfirmations.consume(event);
    const fromResend = this.resendOutputMarkers.consume(event);
    if(fromAI||fromCommand||fromResend)this.ai.inputDiagnostics?.note(event,'bot_echo_ignored');
    // Output echoes must not trigger AI or commands, but a later real recall of
    // that output is an independent event. The recall engine deduplicates by
    // account, conversation and source message ID before any asynchronous send.
    if (event?.post_type === 'meta_event' && event.meta_event_type === 'heartbeat' &&
        event.status?.online === false) {
      this.error = 'QQ 已离线，请使用快捷登录或在 NapCat 中完成登录确认。';
      this.client?.close();
      return;
    }
    if (!fromCommand && !fromResend && !fromAI && await this.handleOwnCommand(event, api)) return;
    if (!this.active || !this.engine || this.engine !== eventEngine) { if (!fromCommand && !fromResend && !fromAI) this.ai.offer(event); return; }
    const engine = this.engine;
    const resendApi = { call: (action, body) => {
      if (!['send_group_msg', 'send_private_msg','send_group_forward_msg','send_private_forward_msg'].includes(action)) return api.call(action, body);
      const group = action === 'send_group_msg'||action === 'send_group_forward_msg';
      const scope = { self_id: this.selfId, conversation_type: group ? 'group' : 'private',
        peer_id: String(group ? body.group_id : body.user_id) };
      return this.resendOutputMarkers.track(scope, body.message||body.messages, () => api.call(action, body));
    } };
    const recallHandling = engine.handle(event, resendApi);
    if (!fromCommand && !fromResend && !fromAI) this.ai.offer(event);
    const result = await recallHandling;
    if (this.engine !== engine) return;
    if (result === 'sent') this.sentCount++;
    if (result === 'missing') this.missingCount++;
    const record = this.recalls.find((item) => item.message_id === String(event.message_id));
    if (record && result === 'sent') record.status = '已重发到原会话';
    if (record && result === 'failed') record.status = '重发未确认';
    if (record && result === 'cancelled') record.status = '已取消重发，仅在本页显示';
    if (record && result === 'exempt') record.status = '原作者在豁免白名单，仅在本页显示';
    if (record && result === 'dry-run') record.status = '测试模式，仅在本页显示';
  }
  async connectLoop() {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      try {
        const candidates = await this.discover();
        if (!candidates.length) {
          throw new Error('没有找到已启用的本机 NapCat 接口。请保持 NapCat 运行，并在网络配置里启用 WebSocket 服务端。');
        }
        let connectedClient = null;
        let connectError = '';
        for (const candidate of candidates) {
          if (signal.aborted) break;
          const client = new OneBotClient(candidate, (event, api) => {
            if (api !== this.client || !this.connected || api.socket?.readyState !== 1) return;
            return this.onEvent(event, api);
          });
          this.client = client;
          try {
            await client.open();
            const login = await client.call('get_login_info');
            const status = await client.call('get_status').catch(() => null);
            if (status?.online === false) {
              this.error = 'QQ 已离线，请使用快捷登录或在 NapCat 中完成登录确认。';
              throw new Error(this.error);
            }
            const selfId = id(login.user_id, true);
            if (!selfId || (candidate.expected_self_id && candidate.expected_self_id !== selfId)) {
              throw new Error('登录账号与 NapCat 配置不一致。');
            }
            const [rawFriends, rawGroups] = await Promise.all([
              client.call('get_friend_list'), client.call('get_group_list'),
            ]);
            if (!Array.isArray(rawFriends) || !Array.isArray(rawGroups)) throw new Error('无法获取好友或群聊列表。');
            if (this.selfId && this.selfId !== selfId) {
              this.active = false; this.engine?.clear(); this.engine = null; this.target = null;
              this.clearRecalls();
              this.preferences = {
                target_type: 'group', group_id: '', group_name: '',
                friend_id: '', friend_name: '', auto_start: false, auto_resend: false,
                resend_self: false,
                resend_exempt_qq_ids: this.preferences.resend_exempt_qq_ids,
                send_interval_seconds: this.preferences.send_interval_seconds,
                auto_recovery: false, recovery_account: '',
                command_allow_others: false, command_permissions: [], command_account: '',
                command_on: this.preferences.command_on, command_off: this.preferences.command_off,
                command_reply_on: this.preferences.command_reply_on, command_reply_off: this.preferences.command_reply_off,
              };
              this.recoverySettingsGeneration++;
              this.recovery.configure(false, '');
              await this.savePreferences();
            }
            if (this.preferences.auto_recovery && this.preferences.recovery_account !== selfId) {
              this.preferences.auto_recovery = false;
              this.preferences.recovery_account = '';
              this.preferences.auto_start = false;
              this.preferences.auto_resend = false;
              this.recoverySettingsGeneration++;
              this.recovery.configure(false, '');
              await this.savePreferences();
              this.log('当前登录账号与自动恢复绑定账号不同，已停止自动恢复和自动开始，请重新选择。');
            }
            const accountChanged = !!this.selfId && this.selfId !== selfId;
            if (accountChanged) { this.outbox.cancel(() => true, 'scope_changed'); this.engine?.clear(); this.engine = null; this.active = false; }
            this.selfId = selfId;
            if (this.preferences.command_allow_others && this.preferences.command_account !== selfId) {
              this.preferences.command_allow_others = false;
              await this.savePreferences();
              this.log('登录账号已变化，他人口令授权已关闭，请重新确认并保存。');
            }
            this.friends = rawFriends.map((friend) => ({
              type: 'private', id: id(friend.user_id, true),
              user_id: id(friend.user_id, true),
              name: String(friend.remark || friend.nickname || friend.user_id),
              nickname: String(friend.nickname || ''),
            })).filter((friend) => friend.user_id && friend.user_id !== selfId);
            this.groups = rawGroups.map((group) => ({
              type: 'group', id: id(group.group_id, true), group_id: id(group.group_id, true),
              name: String(group.group_name || group.group_id), nickname: '',
            })).filter((group) => group.id);
            this.connected = true; this.error = ''; connectedClient = client;
            this.onlineConfirmed = status?.online === true;
            this.lastStatusCheck = this.onlineConfirmed ? new Date().toISOString() : '';
            this.statusFailures = 0;
            this.reconnectAttempt = 0; this.nextReconnectAt = 0;
            this.log('已自动连接 NapCat，群聊和好友列表已载入。');
            if (!candidate.report_self) {
              this.log('请在 NapCat 开启“上报自身消息”，用于最新 10 条计数、本人口令和本人撤回重发。');
            }
            const savedId = this.savedTarget()?.id;
            const saved = this.targets(this.preferences.target_type).find((target) => target.id === savedId);
            if (saved && this.preferences.auto_start && !this.active && !accountChanged) this.activate(saved);
            if (!saved && this.active) {
              this.active = false; this.engine?.clear(); this.engine = null;
              this.log('已保存的会话不在当前列表中，请重新选择。');
            }
            this.outbox.resume();
            this.ai.reconnected();
            break;
          } catch (error) {
            connectError = error.message;
            client.close();
          }
        }
        if (!connectedClient && !signal.aborted) {
          throw new Error(connectError || '接口未连接。请确认 NapCat 已登录、WebSocket 服务端和 Token 设置有效；程序会退避重连。');
        }
        if (connectedClient) {
          const client = connectedClient;
          this.connectionWatchdog = new ConnectionWatchdog(client, {
            onHealthy: () => { this.lastStatusCheck = new Date().toISOString(); this.statusFailures = 0; this.onlineConfirmed = true; this.outbox.kick(); this.ai.reconnected(); },
            onProbeFailure: failures => { this.statusFailures = failures; },
            onDisconnect: message => {
              if (this.client === client && this.connected) { this.error = message; this.log(message); }
            },
          });
          this.connectionWatchdog.start();
          await connectedClient.closed;
        }
      } catch (error) {
        const message = error.message;
        if (!signal.aborted && this.error !== message) this.log(message);
        this.error = message;
      } finally {
        this.connectionWatchdog?.stop();
        this.connectionWatchdog = null;
        if (this.connected) {
          this.lastDisconnect = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
          this.connected = false; this.onlineConfirmed = false;
          this.outbox.suspend();
          this.ai.disconnected();
          if (!signal.aborted) {
            if (!this.error) this.error = '连接已断开，正在等待重连。';
            this.log('连接暂时断开，已捕获的原文和待发项在各自内存期限内保留；同账号原会话恢复后继续，结果不明项不重试。');
          }
        }
        this.connected = false;
        this.onlineConfirmed = false;
        this.client?.close();
      }
      if (signal.aborted) break;
      const delay = Math.min(5000 * 2 ** Math.min(this.reconnectAttempt++, 3), 30000);
      this.nextReconnectAt = Date.now() + delay;
      try { await sleep(delay, undefined, { signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
  }
  async shutdown() {
    await this.groupSign.close();
    this.ai.dispose();
    this.outbox.dispose();
    this.connectionWatchdog?.stop();
    this.recoverySettingsGeneration++;
    clearInterval(this.recoveryTimer);
    this.recovery.dispose();
    this.sendQueue.cancel();
    this.active = false;
    this.engine?.clear();
    this.engine = null;
    this.clearRecalls();
    this.controller.abort();
    this.client?.close();
    await this.connectionTask;
    await this.recoveryTickTask?.catch(() => {});
    await this.saveTask.catch(() => {});
    await this.recallNames.task.catch(() => {});
    await this.resendTask.catch(() => {});
    await this.ai.diagnostics.file.task.catch(()=>{});
    await this.ai.poolService.close().catch(()=>{});
  }
}

export async function startApp(options = {}) {
  const app = new PrivateRecallApp(options);
  await app.initialize();
  const template = await readFile(join(ROOT, 'ui.html'), 'utf8');
  const html = template.replaceAll('__SESSION_TOKEN__', app.session);
  const server = createServer(async (request, response) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, {
        'Content-Type': type, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'nonce-" + app.session +
          "'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      const host = '127.0.0.1:' + server.address().port;
      if (request.headers.host !== host) return send(403, { error: '地址不匹配。' });
      if (request.url === '/' && request.method === 'GET') return send(200, html, 'text/html; charset=utf-8');
      if (request.method === 'GET' && new URL(request.url, 'http://' + host).pathname === '/auth/callback') {
        try { await app.ai.auth.complete('http://' + host + request.url); }
        catch {} // The sanitized result is retained by AIAuth; never echo callback values.
        response.writeHead(303, {'Location':'/auth/result','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
        return response.end();
      }
      if(request.method==='GET'&&request.url==='/auth/result')return send(200,renderOAuthResultPage(app.ai.auth.oauthDiagnostic.state()),'text/html; charset=utf-8');
      if (request.url === '/health' && request.method === 'GET') {
        const recovery = app.recovery.snapshot();
        const cache = app.engine?.cacheSnapshot();
        return send(200, { app: 'qq-recall-private', group_sign_version:1,local_policy_version:'recall-rich-flow-v1-20261021',recall_rich_version:1,input_mentions_version:1,nickname_identity_version:1,structured_ai_mentions:true, display_name:'QQ 双功能助手', dual_ui:true, persistent_diagnostics:true, api_draft_test:true, real_group_mentions:true, unified_commands:true, ui_version:'chat-20261015', pid: process.pid, groups: true, commands: true, pacing: true,
          recovery: true, command_permissions: true, dynamic_pacing: true, self_recall: true,
          connection_watchdog: true, recovery_error_categories: true, verified_login_resume: true,
          resend_exemptions: true, command_confirmations: true, exact_command_replies: true,
          recall_name_bindings: true, contextual_empty_mentions: true, topic_value_checks: true, nickname_context_patch_version: '20261018-v1',
          oauth_callback_history: true, oauth_diagnostic_patch_version: OAUTH_DIAGNOSTIC_VERSION,
          dual_recall_attribution: true,
          unified_recall_templates: true,
          bounded_cache: true, out_of_order_recalls: true,
          retained_outbox: true,
          ai_chat: true, ai_dual_auth: true,
          status_summary: { connected: app.connected, active: app.active,
            group_sign:app.groupSign.state(false),
            ai: app.ai.state(false),
            auto_resend: app.preferences.auto_resend && !app.exemptionsError,
            resend_exemption_count: app.exemptQQIds.length, resend_exempt_error: app.exemptionsError,
            pending_resends: app.outbox.snapshot().pending, cached: cache?.cached ?? 0,
            cache_limit: app.preferences.cache_messages_per_chat, cache_ttl_minutes: app.preferences.cache_ttl_minutes,
            pending_recall_matches: cache?.pending_matches ?? 0, cache_stats: cache ?? null,
            delivery: app.outbox.snapshot(), recall_match_seconds: app.preferences.recall_match_seconds,
            resend_self: app.preferences.resend_self,
            last_disconnect: app.lastDisconnect, last_status_check: app.lastStatusCheck, qq_online_confirmed: app.onlineConfirmed,
            status_failures: app.statusFailures, recovery: { enabled: recovery.enabled,
              paused: recovery.paused, phase: recovery.phase, error_code: recovery.error_code,
              message: recovery.message, next_action_in_seconds: recovery.next_action_in_seconds } } });
      }
      const mediaMatch = /^\/media\/([a-f0-9]{24})\/(\d+)$/.exec(request.url || '');
      if (mediaMatch && request.method === 'GET') {
        const record = app.recalls.find((item) => item.id === mediaMatch[1]);
        const segment = record?.message[Number(mediaMatch[2])];
        const file = segment?.type === 'image' ? String(segment.data.file || '') : '';
        if (!file.startsWith('base64://')) return send(404, { error: '图片缓存不可用。' });
        const bytes = Buffer.from(file.slice(9), 'base64');
        const type = bytes.subarray(0, 4).toString() === 'GIF8' ? 'image/gif'
          : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg'
          : bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/png';
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(bytes);
        return;
      }
      if(request.method==='GET'&&request.url==='/ai-test-ui.mjs')return send(200,await readFile(join(ROOT,'ai-test-ui.mjs'),'utf8'),'text/javascript; charset=utf-8');
      if (request.headers['x-qq-recall-session'] !== app.session) {
        return send(403, { error: '请刷新控制页面。' });
      }
      if (request.url === '/api/state' && request.method === 'GET') return send(200, app.state());
      if (request.url === '/api/friends' && request.method === 'GET') return send(200, app.friends);
      if (request.url === '/api/groups' && request.method === 'GET') return send(200, app.groups);
      const requestURL = new URL(request.url, 'http://' + host);
      if(requestURL.pathname==='/api/onebot-diagnostics'&&request.method==='GET'){
        const expectedNickname=String(requestURL.searchParams.get('expected_nickname')||'').slice(0,80);
        if(!app.connectionDiagnosticTask)app.connectionDiagnosticTask=inspectOneBotConnection(app,{expectedNickname}).finally(()=>{app.connectionDiagnosticTask=null;});
        return send(200,await app.connectionDiagnosticTask);
      }
      if (requestURL.pathname === '/api/command-members' && request.method === 'GET') {
        return send(200, await app.commandMembers(requestURL.searchParams.get('group_id')));
      }
      if (request.method !== 'POST') return send(404, { error: '页面不存在。' });
      if (request.headers.origin && request.headers.origin !== 'http://' + host) {
        return send(403, { error: '请从本机控制页面操作。' });
      }
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > (request.url.startsWith('/api/group-sign/')?65536:request.url === '/api/commands' || request.url.startsWith('/api/ai/') ? 1048576 : 4096)) return send(413, { error: '请求过大。' });
      }
      if(request.url.startsWith('/api/group-sign/')){
        try{const value=JSON.parse(body||'{}');let outcome;
          if(request.url==='/api/group-sign/settings')await app.groupSign.configure(value);
          else if(request.url==='/api/group-sign/manual'){if(Object.keys(value).some(k=>!['group_id','acknowledged'].includes(k)))throw{code:'sign_invalid_settings'};outcome=await app.groupSign.request(value.group_id,{acknowledged:value.acknowledged===true});}
          else if(request.url==='/api/group-sign/check'){if(Object.keys(value).some(k=>k!=='group_id'))throw{code:'sign_invalid_settings'};outcome=await app.groupSign.check(value.group_id);}
          else if(request.url==='/api/group-sign/capabilities'){if(Object.keys(value).length)throw{code:'sign_invalid_settings'};outcome=await app.groupSign.inspectCapabilities();}
          else if(request.url==='/api/group-sign/acknowledge'){if(value.acknowledged!==true||Object.keys(value).some(k=>!['key','acknowledged'].includes(k)))throw{code:'sign_explicit_confirmation_required'};await app.groupSign.acknowledge(value.key);}
          else return send(404,{error:'sign_operation_not_found'});
          return send(200,{...app.groupSign.state(),outcome});
        }catch(error){return send(400,{error:/^sign_[a-z0-9_]{1,75}$/.test(error?.code||'')?error.code:'sign_operation_failed'});}
      }
      if (request.url.startsWith('/api/ai/')) {
        try {
          const value = JSON.parse(body || '{}');
          if (request.url === '/api/ai/connections/config') await app.ai.poolService.configureConnections(value);
          else if (request.url === '/api/ai/connections/key') await app.ai.poolService.setConnectionKey(value);
          else if (request.url === '/api/ai/connections/enabled') await app.ai.poolService.setRouting(value,app.ai.config);
          else if (request.url === '/api/ai/connections/review') await app.ai.poolService.reviewConnection(value);
          else if (request.url === '/api/ai/pool/config') await app.ai.poolService.configure(value,app.ai.config);
          else if (request.url === '/api/ai/pool/key') await app.ai.poolService.setKey(value,app.ai.config);
          else if (request.url === '/api/ai/pool/review') await app.ai.poolService.review(value);
          else if (request.url === '/api/ai/group-settings') await app.ai.configureGroupSettings(value);
          else if (request.url === '/api/ai/context-permission') await app.ai.configureContextPermission(value);
          else if (request.url === '/api/ai/context-settings') await app.ai.configureContext(value);
          else if (request.url === '/api/ai/runtime-settings') await app.ai.configureRuntime(value);
          else if (request.url === '/api/ai/retention') await app.ai.configureRetention(value);
          else if (request.url === '/api/ai/participation') await app.ai.configureParticipation(value);
          else if (request.url === '/api/ai/private-settings') await app.ai.configurePrivateSettings(value);
          else if (request.url === '/api/ai/persona') await app.ai.configurePersona(value);
          else if (request.url === '/api/ai/chat-identity') await app.ai.configureChatIdentity(value);
          else if (request.url === '/api/ai/output-budget') await app.ai.configureOutputBudget(value);
          else if (request.url === '/api/ai/settings') await app.ai.configure(value);
          else if (request.url === '/api/ai/group-context') await app.ai.configureNearbyContext(value);
          else if (request.url === '/api/ai/test-vision') return send(200,await app.ai.testVision());
          else if (request.url === '/api/ai/vision-settings') await app.ai.configureVisionSettings(value);
          else if (request.url === '/api/ai/vision') await app.ai.configureVision(value);
          else if (request.url === '/api/ai/vision-scope') await app.ai.configureVisionScope(value);
          else if (request.url === '/api/ai/enabled') await app.ai.configure({...app.ai.config,enabled:value.enabled});
          else if (request.url === '/api/ai/key') { if (value.key !== '') throw new AIError('api_draft_required'); await app.ai.auth.setAPIKey(''); }
          else if (request.url === '/api/ai/api-save') await app.ai.saveAPIDraft(value);
          else if (request.url === '/api/ai/sign-in') return send(200, await app.ai.auth.start({ callbackURL: 'http://' + host + '/auth/callback', profileId: value.profile_id || '', consent: value.consent === true }));
          else if (request.url === '/api/ai/cancel-sign-in') app.ai.auth.cancelSignIn();
          else if (request.url === '/api/ai/sign-out') await app.ai.auth.signOut(value.profile_id);
          else if (request.url === '/api/ai/models') return send(200, { models: value.target ? await app.ai.draftModels(value) : await app.ai.provider.models(app.ai.config) });
          else if (request.url === '/api/ai/test-api') return send(200, await app.ai.testAPI(value));
          else if(request.url==='/api/ai/cancel-test')return send(200,app.ai.cancelTest(value));
          else if(request.url==='/api/ai/network-settings')return send(200,await app.ai.network.configure(value));
            else if (request.url === '/api/ai/resume-backend') await app.ai.resumeBackendAfterProbe(value);
          else if (request.url === '/api/ai/reset') app.ai.reset();
          else if (request.url === '/api/ai/private-clear') app.ai.clearPrivateReviews();
          else return send(404, { error: 'AI操作不存在。' });
          return send(200, app.state());
        } catch (error) { if (request.url === '/api/ai/test-api' && error.testResult) return send(200, error.testResult); return send(400, { error: error instanceof SettingsFieldError?'invalid_ai_settings':publicAIError(error), ...(error instanceof SettingsFieldError?{field:error.field,message:error.userMessage}:{}) }); }
      }
      if (request.url === '/api/start') {
        const selection = JSON.parse(body || '{}');
        const type = selection.target_type || (selection.group_id !== undefined ? 'group' : 'private');
        const value = selection.target_id ?? (type === 'group' ? selection.group_id : selection.friend_id);
        await app.selectTarget(type, value);
      }
      else if (request.url === '/api/stop') await app.stopMonitoring();
      else if (request.url === '/api/mode') await app.setResend(JSON.parse(body || '{}').auto_resend);
      else if (request.url === '/api/self-resend') await app.setSelfResend(JSON.parse(body || '{}').enabled);
      else if (request.url === '/api/recall-name-binding') await app.setRecallName(JSON.parse(body || '{}'));
      else if (request.url === '/api/cache-settings') {
        const settings = JSON.parse(body || '{}');
        await app.setCacheSettings(settings.limit, settings.ttl_minutes);
      }
      else if (request.url === '/api/delivery-settings') {
        const settings = JSON.parse(body || '{}');
        await app.setDeliverySettings(settings.limit, settings.ttl_minutes, settings.match_seconds);
      }
      else if (request.url === '/api/resend-exemptions') await app.setResendExemptions(JSON.parse(body || '{}').qq_ids);
      else if (request.url === '/api/commands') {
        const command = JSON.parse(body || '{}');
        await app.setCommands(command.on, command.off, command);
      }
      else if (request.url === '/api/login') {
        return send(200, await quickLogin());
      }
      else if (request.url === '/api/send-interval') {
        await app.setSendInterval(JSON.parse(body || '{}').seconds);
      }
      else if (request.url === '/api/recovery') {
        await app.setRecovery(JSON.parse(body || '{}').enabled);
      }
      else return send(404, { error: '操作不存在。' });
      send(200, app.state());
    } catch (error) {
      send(400, { error: error instanceof SyntaxError ? '请求格式错误。' : error.message });
    }
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', accept);
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  app.connectionTask = app.connectLoop();
  app.recoveryTimer = setInterval(() => {
    void app.runRecoveryTick().catch(() => app.log('自动恢复检查未完成，请查看当前状态。'));
  }, 10000);
  app.recoveryTimer.unref();
  return {
    app, server, url,
    async close() {
      await app.shutdown();
      server.closeAllConnections();
      await new Promise((accept) => server.close(accept));
    },
  };
}

function openBrowser(url) {
  if (process.platform !== 'win32') return;
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', url], {
    windowsHide: true, stdio: 'ignore', detached: true,
  });
  child.on('error', () => {});
  child.unref();
}

async function main() {
  if (typeof WebSocket !== 'function') throw new Error('需要 Node.js 22.4 或更高版本。');
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--no-browser', '--setup', '--preserve-recovery-pause','--preserve-ai-state'].includes(arg))) {
    throw new Error('支持的参数：--no-browser、--setup、--preserve-recovery-pause。');
  }
  const lockPath = join(ROOT, '.instance.json');
  try {
    const previous = await readJSON(lockPath);
    if (/^http:\/\/127\.0\.0\.1:\d+\/$/.test(previous.url)) {
      const health = await fetch(previous.url + 'health', { signal: AbortSignal.timeout(1000) }).then((r) => r.json());
      if (health.app === 'qq-recall-private' && health.pid === previous.pid) {
        if (!health.pacing || !health.recovery || !health.command_permissions || !health.dynamic_pacing || !health.self_recall ||
            !health.resend_exemptions || !health.command_confirmations || !health.exact_command_replies ||
            !health.dual_recall_attribution || !health.unified_recall_templates ||
            !health.bounded_cache || !health.out_of_order_recalls || !health.retained_outbox || !health.dual_ui || !health.persistent_diagnostics) {
          console.log('旧版工具仍在运行。请先关闭旧版启动窗口，再重新双击 start.cmd，新功能才会生效。');
          return;
        }
        console.log('程序已在运行：' + previous.url);
        if (!args.includes('--no-browser')) openBrowser(previous.url);
        return;
      }
    }
  } catch {}
  const handoffPath=join(ROOT,'.ai-upgrade-handoff.json');
  const initialAIState=args.includes('--preserve-ai-state')?await readJSON(handoffPath):null;
  const running = await startApp({ initialRecoveryPause: args.includes('--preserve-recovery-pause'),initialAIState });
  if(initialAIState)await unlink(handoffPath).catch(()=>{});
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, url: running.url }), 'utf8');
  console.log('\nQQ 双功能助手页面：' + running.url);
  console.log('撤回重发与AI聊天可独立运行；在页面顶部选择功能。保持本窗口开启，按 Ctrl+C 退出。\n');
  if (!args.includes('--no-browser')) openBrowser(running.url);
  const stop = async () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await running.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error('启动失败：' + error.message); process.exitCode = 1; });
}
