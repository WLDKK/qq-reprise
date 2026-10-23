import { id, normalizeEvent, parseCQ } from './engine.mjs';

export function validateCommandReplies(on, off, replyOn, replyOff) {
  for (const text of [replyOn, replyOff]) {
    if (typeof text !== 'string' || !text.trim() || text.length > 200 || /[\u0000-\u001f\u007f]/u.test(text)) {
      throw new Error('确认回复需为 1～200 个字符的单行文字。');
    }
    if ([on, off].includes(text.trim())) throw new Error('确认回复不能与开启或关闭口令相同，以免形成消息循环。');
  }
  return { command_reply_on: replyOn, command_reply_off: replyOff };
}

export function defaultCommandReplies(on, off) {
  const pick = candidates => candidates.find(text => ![on, off].includes(text));
  return { command_reply_on: pick(['开了', '自动重发已开启。', '开启成功。']),
    command_reply_off: pick(['关了', '自动重发已关闭。', '关闭成功。']) };
}

function textOf(event) {
  const parts = typeof event.message === 'string' ? parseCQ(event.message) : event.message;
  return Array.isArray(parts) && parts.length && parts.every(part => part.type === 'text')
    ? parts.map(part => String(part.data?.text || '')).join('').trim() : null;
}

export class CommandConfirmations {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.ids = new Map();
    this.pending = [];
  }
  key(event) {
    return event.self_id + ':' + event.conversation_type + ':' + event.peer_id + ':' + event.message_id;
  }
  prune() {
    const now = this.now();
    for (const [key, expires] of this.ids) if (expires <= now) this.ids.delete(key);
    this.pending = this.pending.filter(item => item.expires > now);
    while (this.ids.size > 1000) this.ids.delete(this.ids.keys().next().value);
  }
  consume(event) {
    const normalized = normalizeEvent(event);
    if (!normalized) return false;
    this.prune();
    if (this.ids.has(this.key(normalized))) return true;
    if (!['message', 'message_sent'].includes(event.post_type) || normalized.user_id !== String(normalized.self_id)) return false;
    const content = textOf(event);
    const matches = this.pending.filter(item => !item.matched && item.self === String(normalized.self_id) &&
      item.type === normalized.conversation_type && item.peer === normalized.peer_id && item.text === content);
    const expected = matches[0];
    if (!expected) return false;
    if (matches.length > 1) for (const match of matches) match.receiptAmbiguous = true;
    expected.matched = true;
    this.ids.set(this.key(normalized), this.now() + 86400000);
    if (matches.length === 1 && !expected.receiptAmbiguous) expected.onReceipt?.(normalized.message_id);
    return true;
  }
  async send(event, text, api) {
    const group = event.conversation_type === 'group';
    const result = await this.track(event, [{ type: 'text', data: { text } }], () =>
      api.call(group ? 'send_group_msg' : 'send_private_msg', {
        [group ? 'group_id' : 'user_id']: Number(event.peer_id),
        message: [{ type: 'text', data: { text } }],
      }));
    if (id(result?.message_id) === null) throw new Error('confirmation_unconfirmed');
  }
  async track(event, message, submit, onReceipt = null) {
    this.prune();
    const text = textOf({ message });
    const expected = { self: String(event.self_id), type: event.conversation_type, peer: event.peer_id,
      text, expires: this.now() + 20000, matched: false, onReceipt };
    if (text !== null) this.pending.push(expected);
    if (this.pending.length > 50) this.pending.shift();
    const result = await submit();
    const messageId = id(result?.message_id);
    if (messageId !== null) {
      this.ids.set(this.key({ ...event, message_id: messageId }), this.now() + 86400000);
      this.pending = this.pending.filter(item => item !== expected);
      onReceipt?.(messageId);
    }
    return result;
  }
}
