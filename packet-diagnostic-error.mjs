// Only fixed readonly PacketBackend diagnostics may opt in to these fields.
function text(value){
 const raw=String(value??'');
 const message=raw.slice(0,65536)
  .replace(/[A-Z]:[\\/]Users[\\/][^\\/\s]+/gi,'[USERHOME]')
  .replace(/^(\s*(?:authorization|cookie|set-cookie|x-api-key|api-key)\s*:)\s*[^\r\n]*/gim,'$1 [REDACTED]')
  .replace(/Bearer\s+[^\s]+/gi,'Bearer [REDACTED]')
  .replace(/(["']?(?:authorization|access_token|token|cookie|set-cookie|x-api-key|api[_-]?key|pskey|skey|rkey|secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,'$1[REDACTED]')
  .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g,'[REDACTED]')
  .replace(/https?:\/\/[^\s<>]+/gi,value=>{try{const url=new URL(value);if(url.username||url.password||url.search)return '[URL REDACTED]';return ['github.com','doc.napneko.icu','napneko.github.io'].includes(url.hostname)?value:'[URL REDACTED]';}catch{return '[URL REDACTED]';}})
  .replace(/\b\d{7,12}\b/g,'[ID]');
 return{message,truncated:raw.length>65536};
}
export function packetErrorDetails(error){const value=text(error?.message);const fields={message:value.message,messageTruncated:value.truncated};if(error?.wording!==undefined){const other=text(error.wording);fields.wording=other.message;fields.wordingTruncated=other.truncated;}return fields;}
