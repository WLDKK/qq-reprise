// Connection identity contains no credential. Bind more narrowly than origin so a
// different service path, protocol or platform cannot inherit a saved secret.
export function apiBinding(config) {
  const platform = config.api_platform || 'custom';
  if (!['custom', 'intern_discovery', 'cmecloud', 'openai'].includes(platform)) throw new Error('invalid_api_platform');
  const url = new URL(config.api_base_url);
  if (url.username || url.password || url.search || url.hash || url.pathname.length > 100 ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('invalid_api_target');
  if (!['chat_completions', 'responses'].includes(config.api_format)) throw new Error('invalid_api_format');
  return { platform, base_url: url.href.replace(/\/+$/, ''), format: config.api_format };
}
export function sameAPIBinding(a, b) {
  return !!a && !!b && a.platform === b.platform && a.base_url === b.base_url && a.format === b.format;
}
export function apiTarget(config) {
  return { ...apiBinding(config), model: config.api_model, output_token_mode:config.api_output_token_mode||'custom',output_token_limit:config.api_output_token_mode==='platform_default'?null:config.api_max_output_tokens, timeout_seconds: config.timeout_seconds };
}
export const apiDraftFields = ['api_platform', 'api_base_url', 'api_format', 'api_model', 'api_max_output_tokens', 'timeout_seconds'];
export const apiDraftOptionalFields=['api_output_token_mode'];
export function cleanNewAPIKey(key) {
  if (typeof key !== 'string' || key.length > 8192 || /[\r\n\u0000]/.test(key)) throw new Error('invalid_api_key');
  return key.trim();
}
export function redactTestReply(text, key = '') {
  let value = String(text || '');
  if (key) value = value.split(key).join('[密钥已遮蔽]');
  return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [已遮蔽]').slice(0, 4000);
}
