// Vision uses only the authorized current prompt/image. Topic words alone do not
// identify private information. Never return matched values in diagnostics.
const placeholders=/^(?:用于|用来|一种|指的是|请勿|请不要|不要|不能|需要|未设置|未提供|未显示|不存在|已隐藏|已遮|已脱敏|隐藏|脱敏|redacted|masked|not\b|none\b|null\b|[＊*•●]{3,})/iu;
function containsCredential(text){
 if(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[A-Z0-9]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9_.~+\/-]{8,}|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/iu.test(text))return true;
 if(/(?:https?:\/\/[^\s/:@]{1,80}:[^\s/@]{1,160}@|\b(?:ss|ssr|vmess|vless|trojan):\/\/[^\s]{8,}|[?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)=[^\s&#]{4,})/iu.test(text))return true;
 const assignments=/(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|password|passwd|pwd|secret|token|私钥|密钥|密码|口令|验证码|助记词|订阅链接|登录凭据)\s*(?:[=:：]|是|为)\s*["'`]?([^\s"'`，。；;<>]{4,})/giu;
 for(const m of text.matchAll(assignments))if(!placeholders.test(m[1]))return true;
 return /(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token)\s+[A-Za-z0-9_=-]{16,}/iu.test(text);
}
export function inspectVisionText(text,limit=4000,{identityFilter=true}={}){
 if(typeof text!=='string'||!text.trim()||text.length>limit)return{allowed:false,reason:'length'};
 if(/[\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))return{allowed:false,reason:'format'};
 const normalized=text.normalize('NFKC').replace(/\p{Cf}/gu,'');
 if(containsCredential(normalized))return{allowed:false,reason:'credentials'};
 // Concrete identifiers remain guarded; "phone", "birthday", "address", etc.
 // without a value are ordinary descriptions, not proof of private data.
 // An explicitly labelled QQ/group account can have the same digits as a
 // telephone. Do not infer a phone number from that label; credential checks
 // above still inspect the complete unmodified text first.
 const identifiers = normalized.replace(/(?:QQ(?:号)?|群号)\s*(?:[=:：]|是|为)?\s*[1-9]\d{4,11}(?!\d)/giu, 'QQ标识');
 if(identityFilter&&/(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)[1-9]\d{16}[0-9Xx](?!\d)|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:银行卡号|身份证号|护照号码)\s*(?:[=:：]|是|为)\s*[A-Za-z0-9]{6,}/u.test(identifiers))return{allowed:false,reason:'identity'};
 return{allowed:true,reason:''};
}
export function visionPrivacyMessage(code){
 const m=/^vision_(input|output)_(credentials|identity|format|length)$/.exec(code);if(!m)return '';
 const source=m[1]==='input'?'识图要求':'识图结果',reason={credentials:'可识别的密码值、API凭据或登录连接凭据',identity:'可识别的电话、邮箱或证件号码',format:'无法安全处理的控制字符',length:'空白或超出长度上限'}[m[2]];
 return source+'检测到'+reason+'，已在本地拦截'+(m[1]==='input'?'；本次未下载图片或调用模型。':'，未展示或保存原文。');
}
