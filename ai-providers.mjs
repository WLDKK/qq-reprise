import { AIError, SIWC, readJSONResponse, safeCode } from './ai-auth.mjs';
import { redactTestReply } from './ai-api-draft.mjs';
import {visionTarget,VISION_MAX_BYTES} from './ai-vision.mjs';
import{retryAfterSeconds}from'./upstream-limit.mjs';

export function publicAIError(error) {
  if (error?.name === 'TimeoutError') return 'request_timeout';
  if (error?.name === 'AbortError') return 'cancelled_or_timeout';
  if(['secure_storage_unavailable','secure_storage_invalid'].includes(error?.message))return error.message;
  const code=error?.cause?.code||error?.code;
  if(['CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code))return 'tls_verification_failed';
  if(['ENOTFOUND','EAI_AGAIN'].includes(code))return 'network_dns_error';
  if(code==='ECONNREFUSED')return 'network_connection_refused';
  if(['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code))return 'network_timeout';
  if(['ECONNRESET','UND_ERR_SOCKET'].includes(code))return 'network_connection_lost';
  return error instanceof AIError ? error.code : 'network_or_provider_error';
}
function parseSSEBlock(block) {
  const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data) return null;
  if (data === '[DONE]') return { type: 'done' };
  let value;try { value = JSON.parse(data); } catch { throw new AIError('stream_json_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AIError('invalid_upstream_response');
  return value;
}
async function withAbort(promise, signal) {
  signal.throwIfAborted(); let cancel;
  const interrupted = new Promise((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([promise, interrupted]); } finally { signal.removeEventListener('abort', cancel); }
}

export async function* sseEvents(response, signal) {
  if (!response.ok) { await readJSONResponse(response); return; }
  if (!String(response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')) throw new AIError('stream_required');
  const reader = response.body?.getReader(); if (!reader) throw new AIError('stream_missing');
  const decoder = new TextDecoder(); let buffer = '', bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const part = await (signal ? withAbort(reader.read(), signal) : reader.read()); if (part.done) break;
      bytes += part.value.length; if (bytes > 2097152) throw new AIError('stream_too_large');
      buffer += decoder.decode(part.value, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 262144) throw new AIError('stream_event_too_large');
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const event = parseSSEBlock(block); if (event) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) { const event = parseSSEBlock(buffer); if (event) yield event; }
    signal?.throwIfAborted();
  } finally { signal?.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch {} }
}

export class AIProviders {
  constructor({ auth, fetcher = globalThis.fetch } = {}) { this.auth = auth; this.fetcher = fetcher; }
  async details(config, options = {}) {
    if (config.backend === 'chatgpt') return { base: SIWC.resource, key: await this.auth.accessToken(config.active_profile), model: config.siwc_model, responses: true };
    const key = options.key || await this.auth.readAPIFor(config); if (!key) throw new AIError('api_key_required');
    return { base: config.api_base_url, key, model: config.api_model, responses: config.api_format === 'responses' };
  }
  async models(config, options = {}) {
    const detail = await this.details(config, options);
    const body = await readJSONResponse(await this.fetcher(detail.base + '/models', { headers: { Authorization: 'Bearer ' + detail.key }, redirect: 'error', signal: AbortSignal.timeout(15000) }));
    const models = config.backend === 'chatgpt' ? (body.models || []).filter(m => m.visibility === 'list').map(m => ({ id: m.slug, name: m.display_name || m.slug }))
      : (body.data || []).map(m => ({ id: m.id, name: m.id }));
    return models.filter(m => typeof m.id === 'string' && /^[\w.\-:/]{1,160}$/.test(m.id)).slice(0, 200);
  }
  async generate(config, history, prompt, signal, onProgress=()=>{}, options = {}) {
    if(options.image&&(!visionTarget(config)||typeof options.image.dataURL!=='string'||options.image.dataURL.length>Math.ceil(VISION_MAX_BYTES/3)*4+100||!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(options.image.dataURL)))throw new AIError('vision_model_unsupported');
    const progress=value=>{try{onProgress(value);}catch{}};
    const began = Date.now();
    progress({phase:'credentials'});
    const combined = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(config.timeout_seconds * 1000)]);
    combined.throwIfAborted();
    const detail = await withAbort(this.details(config, options), combined); combined.throwIfAborted();
    if (!detail.model) throw new AIError('model_required');
    const outputMode=config.backend==='chatgpt'?'chatgpt_managed':config.api_output_token_mode??'custom';
    if(!['custom','platform_default','chatgpt_managed'].includes(outputMode)||config.backend!=='chatgpt'&&outputMode==='chatgpt_managed')throw new AIError('invalid_ai_settings');
    if(outputMode==='custom'&&(!Number.isSafeInteger(config.api_max_output_tokens)||config.api_max_output_tokens<=0))throw new AIError('invalid_ai_settings');
    progress({phase:'request_ready'});
    const messages = [...history, { role: 'user', content: options.image?[{type:'text',text:prompt},{type:'image_url',image_url:{url:options.image.dataURL}}]:prompt }];
    let body;
    if (detail.responses) {
      body = { model: detail.model, store: false, stream: true, instructions: config.instructions,
        input: messages.map(m => ({ role: m.role, content: m.content })) };
      if (outputMode==='custom') body.max_output_tokens = config.api_max_output_tokens;
    } else {
      const tokenField = config.api_platform === 'openai' && detail.base === 'https://api.openai.com/v1' ? 'max_completion_tokens' : 'max_tokens';
      body = { model: detail.model, stream: true, messages: [{ role: 'system', content: config.instructions }, ...messages] };
      if(outputMode==='custom')body[tokenField]=config.api_max_output_tokens;
    }
    const sentTokenField=['max_tokens','max_completion_tokens','max_output_tokens'].find(key=>Object.hasOwn(body,key))||null;
    progress({format:detail.responses?'responses':'chat_completions',timeoutSeconds:config.timeout_seconds,outputTokenMode:outputMode,outputTokenLimit:outputMode==='custom'?body[sentTokenField]:null,requestedTokenField:sentTokenField,requestedTokenLimit:sentTokenField?body[sentTokenField]:null,outputCharLimit:config.output_chars});
    const submission=await options.beforeSubmit?.();try{combined.throwIfAborted();}catch(error){await options.onNotSubmitted?.(submission);throw error;}
    progress({phase:'http_request'});
    let responsePromise;try{responsePromise=Promise.resolve(this.fetcher(detail.base + (detail.responses ? '/responses' : '/chat/completions'), {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + detail.key }, body: JSON.stringify(body), signal: combined
    }));}catch(error){responsePromise=Promise.reject(error);}responsePromise.catch(()=>{});
    await options.onSubmitted?.(submission);
    const response=await withAbort(responsePromise,combined);
    let text = '', completed = false, streamEvents = 0, textDeltaEvents = 0, reasoningChars = 0, firstContentMs = null, lastStatsAt = 0;
    const stats = (force = false) => { const now = Date.now(); if (force || now - lastStatsAt >= 1000) { progress({streamEvents,textDeltaEvents,reasoningChars,firstContentMs,outputChars:text.length,timeoutSeconds:config.timeout_seconds}); lastStatsAt = now; } };
    const appendText = value => { if (typeof value !== 'string') throw new AIError('invalid_upstream_response'); text += value; if (value) { textDeltaEvents++; if (firstContentMs === null) { firstContentMs = Date.now() - began; progress({phase:'streaming'}); } } };
    const preview = () => { if (options.onText) options.onText(redactTestReply(text, detail.key)); };
    progress({phase:'http_response',httpStatus:response.status,retryAfterSeconds:retryAfterSeconds(response.headers.get('retry-after'))});let firstEvent=true;
    try { for await (const event of sseEvents(response, combined)) {
      streamEvents++;
      if(firstEvent){progress({phase:'streaming'});firstEvent=false;}
      if (event.type === 'done') break;
      const usage=event.usage||event.response?.usage;if(usage&&typeof usage==='object'){const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=1000000000?v:null;progress({tokenUsage:{input:count(usage.prompt_tokens??usage.input_tokens),output:count(usage.completion_tokens??usage.output_tokens),total:count(usage.total_tokens),reasoning:count(usage.completion_tokens_details?.reasoning_tokens??usage.output_tokens_details?.reasoning_tokens)}});}
      if (event.error || ['error', 'response.failed', 'response.incomplete'].includes(event.type)) {
        const code = event.error?.code || event.response?.error?.code || event.code;
        throw new AIError(code ? safeCode(code) : 'generation_failed');
      }
      if (detail.responses) {
        if (event.type === 'response.output_text.delta') { appendText(event.delta || ''); preview(); }
        if (event.type === 'response.completed') {
          if (event.response?.status && event.response.status !== 'completed') throw new AIError('generation_incomplete');
          completed = true;
          progress({finishReason:'completed'});
        }
      } else {
        const choices = event.choices || [];
        if (choices.some(c => c.delta?.tool_calls || c.delta?.function_call)) throw new AIError('tools_not_supported');
        const choice = choices.find(c => c.index === 0) || choices[0];
        const reasoning=typeof choice?.delta?.reasoning_content==='string'?choice.delta.reasoning_content:choice?.delta?.reasoning;
        if (typeof reasoning === 'string') { const firstReasoning = reasoningChars === 0; reasoningChars += reasoning.length; if (firstReasoning && !text.length) progress({phase:'reasoning'}); }
        if (choice?.delta?.content) { appendText(choice.delta.content); preview(); }
        if (choice?.finish_reason) {
          progress({finishReason:['stop','length','tool_calls','function_call','content_filter'].includes(choice.finish_reason)?choice.finish_reason:null});
          if(choice.finish_reason!=='stop')progress({phase:'response_incomplete'});
          if (choice.finish_reason !== 'stop') throw new AIError('generation_incomplete');
          completed = true;
        }
      }
      if (text.length > config.output_chars) throw new AIError('output_character_limit');
      stats();
      // A valid terminal event completes the answer. A provider can leave the
      // HTTP stream open afterwards; socket EOF must not turn success into timeout.
      if (completed) break;
    } } finally { stats(true); }
    combined.throwIfAborted();
    if (!completed || !text.trim()) throw new AIError(completed ? 'empty_response' : 'stream_interrupted');
    progress({phase:'completed',outputChars:text.length});
    return options.testReply ? redactTestReply(text, detail.key) : text;
  }
}
