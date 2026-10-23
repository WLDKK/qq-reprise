import {SETTING_RULES,FREEDOM_DEFAULTS,FREEDOM_BOOLEAN_FIELDS,CONFIGURATION_BOUNDARIES} from './settings-rules.mjs';
import { id } from './engine.mjs';
import { DEFAULT_PERSONA, normalizeBotAliases, validatePersonaPatch } from './ai-persona.mjs';
import {validateChatIdentityPatch} from './chat-identity.mjs';
import { SettingsFieldError } from './settings-field-error.mjs';
import {visionTarget,VISION_BASE,VISION_MODEL} from './ai-vision.mjs';

export const AI_DEFAULTS = Object.freeze({ enabled: false, backend: 'api', api_platform: 'custom', api_format: 'chat_completions',
  api_base_url: 'https://api.openai.com/v1', api_model: '', siwc_model: '', active_profile: '',
  binding_qq: '', groups: [], private_peers: [], private_blacklist: [], group_blacklist: [], users: [], allow_self: true, trigger: 'both', prefix: '/ai',
  instructions: '你是聊天助手。只输出对话文字，不执行命令、工具或本机操作。',
  chat_address_mode:'auto',chat_display_overrides:[],chat_mention_mode:'when_needed',bot_name: '本地助手', bot_address: '你', bot_persona: DEFAULT_PERSONA, bot_aliases:['撤回姬'],chat_owner_qq:'',chat_owner_address:'你',group_name_trigger:false,name_trigger_position:'prefix',group_trigger_mode:'mention_or_name',plan_allow_self: true,
  group_cache_limit: 50, group_cache_ttl_minutes: 0, group_context_chars: 4000, group_context_export: false, group_context_target: '',
  participation_enabled:true,participation_cooldown_seconds:0,participation_hourly_limit:0,participation_daily_limit:0,participation_activity_min_messages:8,participation_activity_window_seconds:120,participation_group_blacklist:[],
  participation_min_text_chars:8,participation_min_speakers:3,participation_topic_min_messages:3,participation_topic_min_speakers:2,participation_quiet_seconds:3,participation_output_tokens:384,participation_output_chars:280,participation_timeout_seconds:30,participation_stale_seconds:45,participation_max_model_calls:1,participation_hourly_model_calls:0,
  private_local_review: false,
  vision_enabled:false,vision_target:'',vision_model:'',vision_verified_at:0,
  vision_reference_enabled:false,vision_recent_enabled:false,
  concurrency: 1, queue_limit: 5, queue_wait_seconds: 60, timeout_seconds: 30, cooldown_seconds: 0,
  daily_requests: 0, input_chars: 2000, output_chars: 4000, api_max_output_tokens: 512,api_output_token_mode:'custom',
  context_turns: 8, context_chars: 8000, context_ttl_minutes: 0, sessions_limit: 100,
  memory_retention_version:1, delivery_limit: 10, delivery_ttl_minutes: 10, ...FREEDOM_DEFAULTS });

function ids(input) {
  const list = typeof input === 'string' ? input.trim().split(/[\s,，;；]+/u).filter(Boolean) : input;
  if (!Array.isArray(list)) throw new Error('请填写QQ号或群号列表。');
  return [...new Set(list.map(value => {
    if (!/^[1-9]\d{4,11}$/.test(String(value))) throw new Error('AI授权列表需填写5～12位QQ号或群号。');
    return String(value);
  }))];
}
export function validateAISettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('AI设置格式无效。');
  for (const key of Object.keys(input)) if (!(key in AI_DEFAULTS)) throw new Error('未知AI设置项：' + key);
  const result = { ...structuredClone(AI_DEFAULTS), ...input };
  if(!Object.hasOwn(input,'chat_address_mode'))result.chat_address_mode=input.bot_address&&input.bot_address!=='你'?'fixed':'auto';
  if (!Object.hasOwn(input, 'plan_allow_self')) result.plan_allow_self = result.allow_self;
  for (const key of ['enabled', 'allow_self', 'plan_allow_self', 'group_context_export','private_local_review','vision_enabled','vision_reference_enabled','vision_recent_enabled','group_name_trigger','participation_enabled','temporary_recovery_enabled',...FREEDOM_BOOLEAN_FIELDS]) if (typeof result[key] !== 'boolean') throw new Error('AI开关必须为true或false。');
  if (!['custom','intern_discovery','cmecloud','openai'].includes(result.api_platform) || !['api', 'chatgpt'].includes(result.backend) || !['responses', 'chat_completions'].includes(result.api_format) || !['mention', 'command', 'both'].includes(result.trigger)) throw new Error('AI后端或触发方式无效。');
  for (const key of ['groups', 'private_peers', 'private_blacklist', 'group_blacklist', 'users','participation_group_blacklist','group_allowed_users']) result[key] = ids(result[key]);
  for (const key of ['api_model', 'siwc_model', 'active_profile', 'binding_qq', 'prefix', 'instructions', 'api_base_url']) if (typeof result[key] !== 'string') throw new Error('AI文本设置无效。');
  if (result.binding_qq && !id(result.binding_qq, true)) throw new Error('AI绑定QQ无效。');
  if ((!result.prefix.trim()||/[\s\u0000-\u001f\u007f]/u.test(result.prefix))) throw new Error('聊天口令须为不含空白或控制字符的非空文字，可使用中文。');
  if (/[\u0000\u0008]/.test(result.instructions)) throw new SettingsFieldError('instructions','含不可保存的控制字符。');
  Object.assign(result,validatePersonaPatch(result));
  Object.assign(result,validateChatIdentityPatch(result));
  if(!['mention_or_name','mention','name','command'].includes(result.group_trigger_mode))throw new SettingsFieldError('group_trigger_mode','请选择可用的触发方式。');
  for (const key of ['api_model', 'siwc_model', 'active_profile']) if (result[key].length > 160 || /[\u0000-\u001f\u007f]/.test(result[key])) throw new Error('AI模型或配置ID无效。');
  let url; try { url = new URL(result.api_base_url); } catch { throw new Error('API地址无效。'); }
  if (url.username || url.password || url.search || url.hash || url.href.length > 1048576 ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('API地址须为HTTPS或本机HTTP，不包含凭据、参数或片段。');
  result.api_base_url = url.href.replace(/\/+$/, '');
  if(typeof result.vision_target!=='string'||typeof result.vision_model!=='string'||!Number.isSafeInteger(result.vision_verified_at)||result.vision_verified_at<0)throw new Error('识图设置无效。');
  if(result.vision_enabled&&(!visionTarget(result)||result.vision_target!==VISION_BASE||result.vision_model!==VISION_MODEL||!result.vision_verified_at))throw new Error('识图必须绑定已验证的当前Discovery模型。');
  if((result.vision_reference_enabled||result.vision_recent_enabled)&&!result.vision_enabled)throw new Error('引用和近期图片须先启用已验证的识图范围。');
  if(typeof result.group_context_target!=='string'||(result.group_context_export&&(result.backend!=='api'||result.group_context_target!==result.api_base_url)))throw new Error('附近消息外发须明确绑定当前普通API接收方。');
  if(!Number.isSafeInteger(result.api_max_output_tokens)||result.api_max_output_tokens<=0)throw new SettingsFieldError('api_max_output_tokens','需为可准确表示的正整数；供应商和模型的实际限制另计。');
  if(!['custom','platform_default'].includes(result.api_output_token_mode))throw new SettingsFieldError('api_output_token_mode','请选择由平台决定或自定义预算。');
  for(const [key,rule] of Object.entries(SETTING_RULES))if(!Number.isSafeInteger(result[key])||result[key]<rule.min||result[key]>rule.max)throw new SettingsFieldError(key,rule.label+'需为'+rule.min+'～'+rule.max+'的整数。'+(rule.zero?'0表示'+rule.zero+'。':''));
  if(result.participation_stale_seconds<=result.participation_quiet_seconds)throw new SettingsFieldError('participation_stale_seconds','候选有效期需大于等待间隙。');
  if(!['blacklist','allowlist'].includes(result.group_member_policy))throw new SettingsFieldError('group_member_policy','请选择所有未拉黑成员或仅名单成员。');
  if(!['all','allowlist','disabled'].includes(result.private_reply_mode))throw new SettingsFieldError('private_reply_mode','请选择所有未拉黑私聊、仅名单或关闭。');
  try{new Intl.DateTimeFormat('en',{timeZone:result.daily_reset_timezone}).format();}catch{throw new SettingsFieldError('daily_reset_timezone','请填写有效IANA时区，如UTC或Asia/Shanghai。');}
  if(typeof result.participation_instructions!=='string'||/[\u0000\u0008]/u.test(result.participation_instructions))throw new SettingsFieldError('participation_instructions','请填写不含控制字符的文字。');
  const overrides=result.participation_group_overrides;
  if(!overrides||typeof overrides!=='object'||Array.isArray(overrides))throw new SettingsFieldError('participation_group_overrides','请填写群号到规则的JSON对象。');
  const names={cooldown_seconds:'participation_cooldown_seconds',hourly_attempts:'participation_hourly_limit',daily_attempts:'participation_group_daily_limit',hourly_sent:'participation_group_hourly_sent_limit',daily_sent:'participation_group_daily_sent_limit'};
  for(const [group,values] of Object.entries(overrides)){
   if(!/^[1-9]\d{4,11}$/u.test(group)||!values||typeof values!=='object'||Array.isArray(values))throw new SettingsFieldError('participation_group_overrides','群号须为5～12位，规则须为对象。');
   for(const [key,value]of Object.entries(values)){const rule=SETTING_RULES[names[key]];if(!rule||!Number.isSafeInteger(value)||value<rule.min||value>rule.max)throw new SettingsFieldError('participation_group_overrides','可设置cooldown_seconds、hourly_attempts、daily_attempts、hourly_sent、daily_sent；均为非负安全整数，0取消对应限制。');}
  }
  if(JSON.stringify(result).length>CONFIGURATION_BOUNDARIES.configurationJsonChars)throw new SettingsFieldError('instructions','整份配置超过本机JSON读取能力（1048576字符）。');
  return result;
}

export const GROUP_SECTION_FIELDS=['groups','group_blacklist','allow_self','group_trigger_mode','prefix','group_member_policy','group_allowed_users'];
export function validateGroupPatch(input){
 const out={};
 for(const key of ['groups','group_blacklist','group_allowed_users'])if(Object.hasOwn(input,key)){try{out[key]=ids(input[key]);}catch(e){throw new SettingsFieldError(key,e.message);}}
 if(Object.hasOwn(input,'allow_self')){if(typeof input.allow_self!=='boolean')throw new SettingsFieldError('allow_self','请选择开或关。');out.allow_self=input.allow_self;}
 if(Object.hasOwn(input,'group_trigger_mode')){if(!['mention_or_name','mention','name','command'].includes(input.group_trigger_mode))throw new SettingsFieldError('group_trigger_mode','请选择可用的触发方式。');out.group_trigger_mode=input.group_trigger_mode;if(input.group_trigger_mode==='name')out.group_name_trigger=true;}
 if(Object.hasOwn(input,'prefix')){if(typeof input.prefix!=='string'||(!input.prefix.trim()||/[\s\u0000-\u001f\u007f]/u.test(input.prefix)))throw new SettingsFieldError('prefix','请填写不含空白或控制字符的口令，可使用中文。');out.prefix=input.prefix;}
 if(Object.hasOwn(input,'group_member_policy')){if(!['blacklist','allowlist'].includes(input.group_member_policy))throw new SettingsFieldError('group_member_policy','请选择可用的群成员范围。');out.group_member_policy=input.group_member_policy;}
 return out;
}
