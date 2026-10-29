// Pure UI operation state. No credentials/config persistence, no automatic retry.
export function bounded(promise,signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve,reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(() => signal.removeEventListener('abort',abort));
  });
}
export class APITestController {
  constructor({ post,refresh=async()=>{},render=()=>{},now=Date.now,id=()=>crypto.randomUUID(),graceMs=5000,refreshMs=3000,tickMs=250,action='test-api' } = {}) {
    Object.assign(this,{post,refresh,render,now,id,graceMs,refreshMs,tickMs,action});this.active=null;this.serial=0;
  }
  emit(operation,value) { if (operation.serial === this.serial) this.render({id:operation.id,elapsed_ms:Math.max(0,this.now()-operation.started),...value}); }
  observe(id,phase) { if (this.active?.id === id && /^[a-z_]{1,50}$/.test(phase || '')) { this.active.phase=phase;this.emit(this.active,{status:'running',busy:true,phase}); } }
  async cancelRemote(operation) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2000);
    try { return await bounded(this.post('cancel-test',{test_id:operation.id},controller.signal),controller.signal); }
    catch { return {cancel_requested:false,upstream_cancel_confirmed:false}; }
    finally { clearTimeout(timer); }
  }
  async cancel() {
    const op=this.active;if(!op)return;
    op.controller.abort(new Error('test_cancelled'));this.active=null;
    this.emit(op,{status:'cancelled',busy:false,phase:'cancel_requested',error_code:'test_cancelled',upstream_cancel_confirmed:false});
    const outcome=await this.cancelRemote(op);
    if(!this.active)this.emit(op,{status:'cancelled',busy:false,phase:'cancel_requested',error_code:'test_cancelled',upstream_cancel_confirmed:false,cancel_requested:outcome.cancel_requested===true});
  }
  backgroundRefresh() {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.refreshMs);
    void bounded(Promise.resolve().then(()=>this.refresh(controller.signal)),controller.signal).catch(()=>{}).finally(()=>clearTimeout(timer));
  }
  async start(payload) {
    if(this.active)return {busy:true};
    const op={id:this.id(),serial:++this.serial,started:this.now(),phase:'local_request',controller:new AbortController()};this.active=op;
    const seconds=Number(payload?.target?.timeout_seconds),ms=Math.min(2147483647,Math.max(1000,Number.isFinite(seconds)?seconds*1000:30000)+this.graceMs);
    const timer=setTimeout(()=>op.controller.abort(new Error('local_test_deadline')),ms);
    const ticker=setInterval(()=>{if(this.active===op)this.emit(op,{status:'running',busy:true,phase:op.phase});},this.tickMs);
    this.emit(op,{status:'running',busy:true,phase:op.phase});
    try {
      const result=await bounded(this.post(this.action,{...payload,test_id:op.id},op.controller.signal),op.controller.signal);
      if(this.active!==op)return;
      if(!result||typeof result.ok!=='boolean')throw Object.assign(new Error('invalid_test_result'),{code:'invalid_test_result'});
      this.emit(op,{status:result.ok?'completed':'failed',busy:false,phase:result.phase||'completed',result});
      return result;
    } catch(error) {
      if(this.active!==op)return;
      const code=op.controller.signal.aborted?op.controller.signal.reason?.message:/^[a-z][a-z0-9_]{1,79}$/.test(error?.code||'')?error.code:'local_request_failed';
      this.emit(op,{status:code==='test_cancelled'?'cancelled':'failed',busy:false,phase:code==='local_test_deadline'?'local_deadline':'local_request',error_code:code,field:/^[a-z_]{1,80}$/.test(error?.field||'')?error.field:null,upstream_cancel_confirmed:false});
      if(code==='local_test_deadline')void this.cancelRemote(op);
    } finally {
      clearTimeout(timer);clearInterval(ticker);if(this.active===op)this.active=null;
      if(payload?.credential)payload.credential.key='';
      this.backgroundRefresh();
    }
  }
}
