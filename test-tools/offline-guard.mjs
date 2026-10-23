// Test harness only. Never install this preload into the production assistant.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

const rawWrite=fs.writeFileSync.bind(fs),rawMkdir=fs.mkdirSync.bind(fs);
const canonical=value=>{
 let s=value instanceof URL?fileURLToPath(value):Buffer.isBuffer(value)?value.toString():String(value);
 if(process.platform==='win32'&&/^\/[a-z]:[\\/]/i.test(s))s=s.slice(1);
 return path.resolve(s).toLowerCase();
};
const roots=key=>JSON.parse(process.env[key]||'[]').map(canonical);
const readRoots=roots('QQ_OFFLINE_READ_ROOTS'),writeRoots=roots('QQ_OFFLINE_WRITE_ROOTS');
if(!readRoots.length||!writeRoots.length||!process.env.QQ_OFFLINE_AUDIT_DIR)throw Error('Offline guard requires explicit roots');
const auditDir=canonical(process.env.QQ_OFFLINE_AUDIT_DIR);
const within=(p,list)=>list.some(root=>p===root||p.startsWith(root+path.sep));
if(!within(auditDir,writeRoots))throw Error('Audit path is outside test write roots');
const audit={pid:process.pid,startedUTC:new Date().toISOString(),filesystemAllowed:0,networkAllowed:0,dpapiSyntheticProcessesAllowed:0,nodeTestWorkersAllowed:0,blocked:[]};
function reject(kind,operation,reason){
 if(audit.blocked.length<100)audit.blocked.push({kind,operation,reason,atUTC:new Date().toISOString()});
 const e=Object.assign(new Error('OFFLINE_GUARD_'+kind.toUpperCase()+': '+operation+' '+reason),{code:'EACCES',offlineGuard:true});throw e;
}
function checkFile(value,write=false,operation='fs'){
 if(typeof value==='number')return;
 let p;try{p=canonical(value);}catch{return reject('filesystem',operation,'invalid_path');}
 if(!within(p,write?writeRoots:readRoots))return reject('filesystem',operation,/^[a-z]:\\[a-z]:\\/i.test(p)?'malformed_windows_drive_prefix':write?'outside_test_write_roots':'outside_test_read_roots');
 audit.filesystemAllowed++;
}
for(const name of ['readFile','readdir','readlink','stat','lstat','access','realpath','opendir']){
 if(typeof fs[name]==='function'){const old=fs[name];fs[name]=function(p,...args){checkFile(p,false,name);return old.call(this,p,...args);};}
 if(typeof fs[name+'Sync']==='function'){const old=fs[name+'Sync'];fs[name+'Sync']=function(p,...args){checkFile(p,false,name+'Sync');return old.call(this,p,...args);};}
 if(typeof fsp[name]==='function'){const old=fsp[name];fsp[name]=async function(p,...args){checkFile(p,false,name);return old.call(this,p,...args);};}
}
for(const name of ['writeFile','appendFile','mkdir','mkdtemp','unlink','rm','rmdir','chmod','chown','truncate','utimes']){
 if(typeof fs[name]==='function'){const old=fs[name];fs[name]=function(p,...args){checkFile(p,true,name);return old.call(this,p,...args);};}
 if(typeof fs[name+'Sync']==='function'){const old=fs[name+'Sync'];fs[name+'Sync']=function(p,...args){checkFile(p,true,name+'Sync');return old.call(this,p,...args);};}
 if(typeof fsp[name]==='function'){const old=fsp[name];fsp[name]=async function(p,...args){checkFile(p,true,name);return old.call(this,p,...args);};}
}
for(const name of ['rename','copyFile','cp','link','symlink']){
 if(typeof fs[name]==='function'){const old=fs[name];fs[name]=function(a,b,...args){checkFile(a,name==='rename',name+' source');checkFile(b,true,name+' destination');return old.call(this,a,b,...args);};}
 if(typeof fs[name+'Sync']==='function'){const old=fs[name+'Sync'];fs[name+'Sync']=function(a,b,...args){checkFile(a,name==='rename',name+' source');checkFile(b,true,name+' destination');return old.call(this,a,b,...args);};}
 if(typeof fsp[name]==='function'){const old=fsp[name];fsp[name]=async function(a,b,...args){checkFile(a,name==='rename',name+' source');checkFile(b,true,name+' destination');return old.call(this,a,b,...args);};}
}
const writing=flags=>typeof flags==='number'?!!(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND)):/[wa+]/.test(String(flags));
for(const [obj,name]of [[fs,'open'],[fs,'openSync'],[fsp,'open']]){const old=obj[name];obj[name]=function(p,flags,...args){checkFile(p,writing(flags),name);return old.call(this,p,flags,...args);};}
for(const name of ['createReadStream','createWriteStream']){const old=fs[name];fs[name]=function(p,...args){checkFile(p,name==='createWriteStream',name);return old.call(this,p,...args);};}
const oldExists=fs.existsSync;fs.existsSync=function(p){checkFile(p,false,'existsSync');return oldExists.call(this,p);};

const ownedPorts=new Set(),loopback=h=>['127.0.0.1','localhost','::1','[::1]','::ffff:127.0.0.1'].includes(String(h||'').toLowerCase());
function checkAddress(host,port,operation){
 if(!loopback(host)||!ownedPorts.has(Number(port)))return reject('network',operation,loopback(host)?'loopback_port_not_owned_by_test':'external_or_non_loopback');
 audit.networkAllowed++;
}
function checkURL(value,operation){
 let u;try{u=new URL(value instanceof Request?value.url:value instanceof URL?value.href:String(value));}catch{return reject('network',operation,'invalid_url');}
 if(u.username||u.password||!['http:','https:','ws:','wss:'].includes(u.protocol))return reject('network',operation,'scheme_or_credentials_not_allowed');
 checkAddress(u.hostname,u.port||(['https:','wss:'].includes(u.protocol)?443:80),operation);
}
const oldListen=net.Server.prototype.listen;
net.Server.prototype.listen=function(...args){
 if(typeof args[0]==='object'&&args[0]!==null){const o={...args[0]};if(Number(o.port)!==0)return reject('network','listen','only_ephemeral_test_port_allowed');if(o.host&&!loopback(o.host))return reject('network','listen','non_loopback_bind');o.host||='127.0.0.1';args[0]=o;}
 else if(typeof args[0]==='number'&&args[0]===0){if(typeof args[1]==='string'){if(!loopback(args[1]))return reject('network','listen','non_loopback_bind');}else args.splice(1,0,'127.0.0.1');}
 else return reject('network','listen','only_ephemeral_test_port_allowed');
 return oldListen.apply(this,args);
};
const oldEmit=net.Server.prototype.emit;
net.Server.prototype.emit=function(event,...args){if(event==='listening'){const addr=this.address();if(addr&&typeof addr==='object')ownedPorts.add(addr.port);}return oldEmit.call(this,event,...args);};
const oldConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const input=args.length===1&&Array.isArray(args[0])?args[0]:args;
 const normalized=net._normalizeArgs(input),o=normalized[0];if(o.path)return reject('network','socket.connect','local_pipe_not_allowed');
 checkAddress(o.host||'localhost',o.port,'socket.connect');return oldConnect.apply(this,args);
};
const oldTLS=tls.connect;tls.connect=function(...args){const o=typeof args[0]==='object'?args[0]:{port:args[0],host:typeof args[1]==='string'?args[1]:'localhost'};if(!o.socket)checkAddress(o.host||'localhost',o.port,'tls.connect');return oldTLS.apply(this,args);};
for(const module of [http,https])for(const method of ['request','get']){const old=module[method];module[method]=function(...args){const arg=args[0];if(typeof arg==='string'||arg instanceof URL)checkURL(arg,'http.'+method);else checkAddress(arg?.hostname||arg?.host||'localhost',arg?.port||(module===https?443:80),'http.'+method);return old.apply(this,args);};}
const oldFetch=globalThis.fetch;globalThis.fetch=async function(input,...args){checkURL(input,'fetch');return oldFetch.call(this,input,...args);};
if(globalThis.WebSocket){const Original=globalThis.WebSocket;globalThis.WebSocket=class OfflineWebSocket extends Original{constructor(url,...args){checkURL(url,'WebSocket');super(url,...args);}};}
const oldLookup=dns.lookup;dns.lookup=function(host,...args){if(!loopback(host))return reject('network','dns.lookup','external_dns_not_allowed');return oldLookup.call(this,host,...args);};
for(const method of ['resolve','resolve4','resolve6','resolveAny','reverse'])if(dns[method])dns[method]=function(){return reject('network','dns.'+method,'external_dns_not_allowed');};

const dpapiPrefix='[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -AssemblyName System.Security;$s=[Console]::In.ReadToEnd();';
const dpapiScripts=new Set([
 "$b=[Convert]::FromBase64String($s);$r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($r))",
 "$b=[Text.Encoding]::UTF8.GetBytes($s);$r=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($r))"
].map(v=>dpapiPrefix+v));
function checkChild(command,args=[],options={}){
 if(path.basename(String(command)).toLowerCase()==='powershell.exe'&&args.length===5&&args.slice(0,4).join('|')==='-NoLogo|-NoProfile|-NonInteractive|-Command'&&dpapiScripts.has(args[4])&&options.windowsHide===true){audit.dpapiSyntheticProcessesAllowed++;return;}
 return reject('process','spawn','child_process_not_allowed');
}
const oldSpawn=child.spawn;child.spawn=function(command,args,options){checkChild(command,args,options);return oldSpawn.call(this,command,args,options);};
for(const method of ['spawnSync','exec','execSync','execFile','execFileSync','fork'])child[method]=function(){return reject('process',method,'child_process_not_allowed');};
syncBuiltinESMExports();
process.once('exit',()=>{try{rawMkdir(auditDir,{recursive:true});rawWrite(path.join(auditDir,'guard-'+process.pid+'.json'),JSON.stringify({...audit,finishedUTC:new Date().toISOString()},null,2));}catch{}});
