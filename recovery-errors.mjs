const transient = new Set(['unavailable', 'api_unavailable']);
export const isTransientRecoveryError = code => transient.has(code);
export function recoveryFailureMessage(code) {
  const messages = {
    verification_required: 'QQ 明确要求扫码或本人验证，自动恢复已暂停，请由本人完成验证。',
    two_factor: 'NapCat 管理页面要求二次验证，自动恢复已暂停，请由本人完成。',
    auth_failed: 'NapCat 管理接口认证未通过，自动恢复已暂停；这不等于 QQ 要求扫码。',
    rate_limited: '登录接口限制了请求频率，自动恢复已暂停，不再重复提交登录。',
    account_mismatch: '无法确认当前实例属于绑定账号，自动恢复已暂停，不切换账号。',
    no_saved_account: '原绑定账号没有可用的快捷登录记录，自动恢复已暂停，请先在电脑上完成该账号的官方登录。',
    action_failed: '快捷登录请求被接口拒绝，具体原因未确认，自动恢复已暂停；尚未确认需要扫码或验证码。',
    unavailable: '本机管理接口暂时无法连接或响应超时。',
    api_unavailable: '本机管理接口暂时异常或返回了无法解析的响应。',
  };
  return messages[code] || '无法确认恢复条件，已暂停自动操作，请检查原 NapCat 管理页面。';
}
export function recoveryErrorFields(code) {
  const retryable = isTransientRecoveryError(code);
  return { error_code: code, retryable, requires_user_action: !retryable,
    message: recoveryFailureMessage(code) };
}
