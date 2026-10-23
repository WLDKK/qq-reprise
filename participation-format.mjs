import {createHash} from 'node:crypto';
const uuid=/^[a-f0-9-]{36}$/u,scope=/^[a-f0-9]{64}$/u;
const timestamp=(value,at,now)=>Number.isSafeInteger(value)&&value>=at&&value<=now+5000;
const stableRequestId=(id,index)=>{const h=createHash('sha256').update(id+':'+index).digest('hex');return[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20,32)].join('-');};
export function normalizeParticipationLedger(saved,now=Date.now()){
 if(!saved||![1,2,3].includes(saved.version)||!Array.isArray(saved.entries))throw Error('participation_ledger_invalid');
 const seen=new Set(),requestsSeen=new Set();
 const entries=saved.entries.map(original=>{
  const v=structuredClone(original);
  if(!v||!Number.isSafeInteger(v.at)||v.at<0||v.at>now+5000||!scope.test(v.scope)||!uuid.test(v.id)||seen.has(v.id))throw Error('participation_ledger_invalid');seen.add(v.id);
  if(v.sourceHash!==undefined&&!scope.test(v.sourceHash)||v.callBudget!==undefined&&(!Number.isSafeInteger(v.callBudget)||v.callBudget<1)||v.expiresAt!==undefined&&(!Number.isSafeInteger(v.expiresAt)||v.expiresAt<v.at)||v.done!==undefined&&typeof v.done!=='boolean')throw Error('participation_ledger_invalid');
  if(v.modelCalls!==undefined&&(!Array.isArray(v.modelCalls)||v.modelCalls.some(at=>!timestamp(at,v.at,now))))throw Error('participation_ledger_invalid');
  for(const field of ['sentAt','deliveryReservedAt'])if(v[field]!==undefined&&!timestamp(v[field],v.at,now))throw Error('participation_ledger_invalid');
  v.callBudget??=1;v.expiresAt??=v.at+300000;
  if(v.requests===undefined&&Array.isArray(v.modelCalls))v.requests=v.modelCalls.map((at,n)=>({id:stableRequestId(v.id,n),preparedAt:at,state:'unknown'}));
  if(v.requests!==undefined){
   if(!Array.isArray(v.requests))throw Error('participation_ledger_invalid');
   for(const r of v.requests){if(!r||!uuid.test(r.id)||requestsSeen.has(r.id)||!['prepared','unknown','invoked','not_submitted'].includes(r.state)||!timestamp(r.preparedAt,v.at,now)||r.state==='invoked'&&!timestamp(r.invokedAt,r.preparedAt,now))throw Error('participation_ledger_invalid');requestsSeen.add(r.id);}
   if(v.requests.filter(r=>r.state!=='not_submitted').length>v.callBudget)throw Error('participation_ledger_invalid');
  }
  return v;
 });return{version:3,entries};
}
// v1 has no confirmed-send or invocation proof. Keep the complete v3 archive;
// projection is conservative and only used with AI disabled during rollback.
export function projectLedgerForBaseline(saved,now=Date.now()){
 const ledger=normalizeParticipationLedger(saved,now);if(ledger.entries.length>1000)return{compatible:false,reason:'baseline_entry_capacity',ledger};
 const entries=[];
 for(const v of ledger.entries){
  const at=Math.max(v.at,v.expiresAt-300000,...(v.requests||[]).filter(r=>r.state==='invoked').map(r=>r.invokedAt));
  if(v.callBudget>10||at>now+5000)return{compatible:false,reason:'baseline_budget_or_timer_range',ledger};
  entries.push({...v,at,expiresAt:Math.max(at,v.expiresAt)});
 }
 return{compatible:true,reason:'conservative_metadata_projection_ai_paused',ledger:{version:1,entries}};
}
