import { readFile, writeFile, rename, mkdir, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

export class JsonFile {
  constructor(path, fallback = {}, {maxChars=1048576}={}) { this.maxChars=maxChars;this.path = path; this.fallback = fallback; this.task = Promise.resolve(); }
  async read() {
    try {
      const raw = await readFile(this.path, 'utf8');
      if (raw.length > this.maxChars) throw new Error('AI本地数据超出上限。');
      return JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (error) { if (error.code === 'ENOENT') return structuredClone(this.fallback); throw error; }
  }
  write(value) {
    const data = JSON.stringify(value, null, 2);
    if(data.length>this.maxChars)return Promise.reject(new Error('AI本地数据超出JSON读取上限。'));
    this.task = this.task.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path + '.tmp', data, { encoding: 'utf8', mode: 0o600 });
      await rename(this.path + '.tmp', this.path);
    });
    return this.task;
  }
}

export async function windowsProtect(value, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('secure_storage_unavailable');
  // 秘密仅通过stdin/stdout管道在本进程与DPAPI之间传递，不进入命令行或日志。
  const action = decrypt
    ? '$b=[Convert]::FromBase64String($s);$r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($r))'
    : '$b=[Text.Encoding]::UTF8.GetBytes($s);$r=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($r))';
  const script = '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -AssemblyName System.Security;$s=[Console]::In.ReadToEnd();' + action;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); reject(new Error('secure_storage_unavailable')); }, 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1048576) { failed = true; child.kill(); } });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('secure_storage_unavailable')); });
    child.on('close', code => { clearTimeout(timer); if (failed || code !== 0) reject(new Error('secure_storage_unavailable')); else resolve(output); });
    child.stdin.on('error', () => {}); child.stdin.end(value);
  });
}

export class ProtectedStore {
  constructor(path, transform = windowsProtect) { this.file = new JsonFile(path, null); this.transform = transform; this.task = Promise.resolve(); this.value = null; }
  async present() { try { await access(this.file.path); return true; } catch { return false; } }
  async load() {
    if (this.value) return this.value;
    const encrypted = await this.file.read();
    if (!encrypted) return (this.value = { api: null, sessions: {} });
    if (encrypted.version !== 1 || typeof encrypted.dpapi !== 'string') throw new Error('secure_storage_invalid');
    const decoded = JSON.parse(await this.transform(encrypted.dpapi, true));
    if (!decoded || typeof decoded.sessions !== 'object' || Array.isArray(decoded.sessions)) throw new Error('secure_storage_invalid');
    return (this.value = decoded);
  }
  async readAPI() { return (await this.load()).api; }
  async readSession(id) { return structuredClone((await this.load()).sessions[id] || null); }
  update(change) {
    this.task = this.task.catch(() => {}).then(async () => {
      const draft = structuredClone(await this.load()); await change(draft);
      const protectedText = await this.transform(JSON.stringify(draft), false);
      await this.file.write({ version: 1, dpapi: protectedText }); this.value = draft;
    });
    return this.task;
  }
  async setAPI(key) { await this.update(value => { value.api = key || null; }); }
  async setSession(id, value) { await this.update(data => { if (value) data.sessions[id] = structuredClone(value); else delete data.sessions[id]; }); }
}

export class MemorySecrets {
  constructor() { this.api = null; this.sessions = new Map(); }
  async present() { return !!this.api || this.sessions.size > 0; }
  async readAPI() { return this.api; }
  async setAPI(value) { this.api = value || null; }
  async readSession(id) { return structuredClone(this.sessions.get(id) || null); }
  async setSession(id, value) { if (value) this.sessions.set(id, structuredClone(value)); else this.sessions.delete(id); }
}
