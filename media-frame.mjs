import{spawn}from'node:child_process';import{fileURLToPath}from'node:url';import{AIError}from'./ai-auth.mjs';
export function decodeStaticFrame(bytes,signal,timeoutMs=5000){
 if(process.platform!=='win32')return Promise.reject(new AIError('vision_animation_unsupported'));
 if(!Buffer.isBuffer(bytes)||bytes.length>5*1024*1024)return Promise.reject(new AIError('vision_image_too_large'));
 if(signal?.aborted)return Promise.reject(signal.reason);
 return new Promise((resolve,reject)=>{let size=0,settled=false;const chunks=[],child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./media-frame.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();if(error){child.kill();reject(error);}else resolve(value);};
  const cancel=()=>finish(signal.reason),timer=setTimeout(()=>finish(new AIError('vision_animation_timeout')),Math.min(5000,Math.max(1,timeoutMs)));
  signal?.addEventListener('abort',cancel,{once:true});child.on('error',()=>finish(new AIError('vision_animation_unsupported')));child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>5*1024*1024)return finish(new AIError('vision_image_too_large'));chunks.push(chunk);});child.on('close',code=>code===0?finish(null,Buffer.concat(chunks,size)):finish(new AIError('vision_animation_unsupported')));
  child.stdin.end(bytes);if(signal?.aborted)cancel();
 });
}
