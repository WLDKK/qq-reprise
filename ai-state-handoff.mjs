const id=v=>typeof v==='string'&&/^[1-9]\d{4,11}$/.test(v);
const reason=v=>typeof v==='string'&&/^(?:context_)?(?:credentials|health|finance|identity|contact_location|personal_sensitive|confidential|unreviewed|format|length|pending|capacity)$/.test(v);
import { NETWORK_ERRORS } from './ai-network.mjs';
export const AI_HANDOFF_ERRORS=Object.freeze(['','upstream_error','rate_limit_exceeded','insufficient_quota','authorization_required','access_denied','invalid_api_key','ai_safety_blocked','private_hold_migration_pending','network_timeout','network_dns_error','network_connection_refused','network_connection_lost','network_or_provider_error','tls_verification_failed','request_timeout','cancelled_or_timeout',...NETWORK_ERRORS]);
const errors=new Set(AI_HANDOFF_ERRORS);
export function validateAIHandoff(input,binding,now=Date.now(),capacity=100){
 if(!input||input.version!==1||input.bindingQQ!==binding||!id(binding)||!Number.isFinite(input.createdAt)||input.createdAt<now-120000||input.createdAt>now+5000||typeof input.blocked!=='boolean'||!errors.has(input.error)||typeof input.privateReviewFull!=='boolean'||!Array.isArray(input.privateHolds)||input.privateHolds.length>capacity)throw new Error('invalid_ai_handoff');
 const peers=new Set();for(const h of input.privateHolds){if(!h||h.selfId!==binding||!id(h.peerId)||peers.has(h.peerId)||typeof h.id!=='string'||!/^[-a-f0-9]{36}$/.test(h.id)||!reason(h.reason)||!Number.isSafeInteger(h.count)||h.count<1||h.count>1000000||!Number.isFinite(h.firstAt)||!Number.isFinite(h.lastAt)||h.firstAt>h.lastAt||h.lastAt>now+5000)throw new Error('invalid_ai_handoff');peers.add(h.peerId);}
 const opaque=input.opaquePrivateHolds??[];
 if(!Array.isArray(opaque)||opaque.length+input.privateHolds.length>capacity||opaque.length&&!input.blocked&&input.privateAllPaused!==true)throw new Error('invalid_ai_handoff');
 for(const h of opaque)if(!h||typeof h.id!=='string'||!/^[-a-f0-9]{36}$/.test(h.id)||typeof h.peer!=='string'||!/^QQ尾号\d{4}$/.test(h.peer)||!reason(h.reason)||!Number.isSafeInteger(h.count)||h.count<1||h.count>1000000||!Number.isFinite(h.first_at)||!Number.isFinite(h.last_at)||h.first_at>h.last_at||h.last_at>now+5000)throw new Error('invalid_ai_handoff');
 return{blocked:input.blocked,error:input.error,privateReviewFull:input.privateReviewFull,privateHolds:structuredClone(input.privateHolds),opaquePrivateHolds:structuredClone(opaque)};
}
