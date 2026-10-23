import { JsonFile } from './ai-storage.mjs';
import { join } from 'node:path';

export const NAME_BINDING_LIMIT = 200;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
export function bindingID(value) {
  if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{4,11}$/.test(String(value).trim())) throw new Error('群号和QQ号需为5～12位正整数。');
  return String(value).trim();
}
export function bindingName(value) {
  if (typeof value !== 'string') throw new Error('自定义名称需为文字。');
  const clean = value.replace(/[\u0000-\u001f\u007f\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if ([...clean].length > 60) throw new Error('自定义名称最多60个字符。');
  return clean;
}
const row = input => {
  if (!exact(input, ['group_id', 'qq_id', 'name'])) throw new Error('仅接受群号、QQ号和自定义名称。');
  return { group_id: bindingID(input.group_id), qq_id: bindingID(input.qq_id), name: bindingName(input.name) };
};
const keyOf = value => value.group_id + ':' + value.qq_id;
export class RecallNameBindings {
  constructor(dir) { this.file = new JsonFile(join(dir, 'recall-name-bindings.json'), { version: 1, bindings: [] }); this.entries = new Map(); this.task = Promise.resolve(); this.error = ''; }
  async initialize() {
    try {
      const saved = await this.file.read();
      if (!exact(saved, ['version', 'bindings']) || saved.version !== 1 || !Array.isArray(saved.bindings) || saved.bindings.length > NAME_BINDING_LIMIT) throw Error();
      const entries = new Map();
      for (const item of saved.bindings) { const clean = row(item); if (!clean.name || entries.has(keyOf(clean))) throw Error(); entries.set(keyOf(clean), clean); }
      this.entries = entries;
    } catch { this.error = '昵称绑定文件无法读取或格式无效；原文件已保留，请先检查备份。'; }
  }
  resolve(group, qq, fallback = '') { return this.entries.get(String(group) + ':' + String(qq))?.name || fallback; }
  state() { return { bindings: [...this.entries.values()].map(v => ({ ...v })), limit: NAME_BINDING_LIMIT, error: this.error }; }
  set(input) {
    const nextRow = row(input);
    const task = this.task.catch(() => {}).then(async () => {
      if (this.error) throw new Error(this.error);
      const entries = new Map(this.entries), key = keyOf(nextRow);
      if (!nextRow.name) entries.delete(key); else entries.set(key, nextRow);
      if (entries.size > NAME_BINDING_LIMIT) throw new Error('最多保存200条群内昵称绑定。');
      await this.file.write({ version: 1, bindings: [...entries.values()] });
      this.entries = entries;
      return this.state();
    });
    this.task = task; return task;
  }
}
