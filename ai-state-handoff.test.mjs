import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAIHandoff} from './ai-state-handoff.mjs';
const now=1700000000000,binding='90001';
const state=()=>({version:1,bindingQQ:binding,createdAt:now,blocked:false,error:'',privateReviewFull:false,privateHolds:[],opaquePrivateHolds:[]});
for(const error of ['network_timeout','network_dns_error','network_connection_refused','network_connection_lost','network_or_provider_error','tls_verification_failed','request_timeout','cancelled_or_timeout','proxy_connection_failed','proxy_environment_missing'])test('handoff preserves known failure without clearing or turning it into recovery: '+error,()=>{
  const before={...state(),error};const after=validateAIHandoff(before,binding,now);assert.equal(after.error,error);assert.equal(after.blocked,false);assert.deepEqual(after.privateHolds,[]);
});
test('unknown or credential-shaped errors remain rejected without echoing their value',()=>{
  for(const error of ['synthetic-unknown-failure','Bearer synthetic-private-token',{code:'network_timeout'},null])assert.throws(()=>validateAIHandoff({...state(),error},binding,now),e=>e.message==='invalid_ai_handoff');
});
test('recognizing network errors never relaxes binding, freshness, private holds or pause protection',()=>{
  const paused={...state(),blocked:true,error:'network_timeout'};assert.equal(validateAIHandoff(paused,binding,now).blocked,true);
  assert.throws(()=>validateAIHandoff(paused,'90002',now),/invalid_ai_handoff/);
  assert.throws(()=>validateAIHandoff({...paused,createdAt:now-120001},binding,now),/invalid_ai_handoff/);
  assert.throws(()=>validateAIHandoff({...paused,privateHolds:[{}]},binding,now),/invalid_ai_handoff/);
});
