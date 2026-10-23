// Test orchestration only. Never preload the guard into the running assistant.
import {readdir,readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {join,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const root=dirname(fileURLToPath(import.meta.url));
const guard=join(root,'test-tools','offline-guard.mjs');
if(process.platform!=='win32')throw Error('This project and its DPAPI tests require Windows.');
const work=await mkdtemp(join(tmpdir(),'qq-assistant-offline-'));
const tests=(await readdir(root)).filter(name=>/^[a-z0-9-]+\.test\.mjs$/.test(name)).sort();
if(!tests.length)throw Error('No synthetic tests found.');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function hashes(dir){const result={};for(const e of await readdir(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isSymbolicLink())throw Error('Test source must not contain links');if(e.isDirectory())Object.assign(result,await hashes(path));else if(e.isFile())result[relative(root,path)]=digest(await readFile(path));}return result;}
const before=await hashes(root),files=[];
const metric=(text,key)=>Number(new RegExp('^# '+key+' (\\d+)\\s*$','m').exec(text)?.[1]??0);
for(const name of tests){
 const run=join(work,name.replace(/\.test\.mjs$/,'')),temp=join(run,'tmp'),auditDir=join(run,'audit');
 await mkdir(temp,{recursive:true});await mkdir(auditDir);
 const env={...process.env,TEMP:temp,TMP:temp,TMPDIR:temp,QQ_OFFLINE_READ_ROOTS:JSON.stringify([root,run]),QQ_OFFLINE_WRITE_ROOTS:JSON.stringify([run]),QQ_OFFLINE_AUDIT_DIR:auditDir};
 delete env.NODE_OPTIONS;
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--test-reporter=tap','--import',pathToFileURL(guard).href,join(root,name)],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let text='',timedOut=false;child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',v=>{text+=v;});child.stderr.on('data',v=>{text+=v;});
  const timer=setTimeout(()=>{timedOut=true;child.kill();},180000);
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);resolve({code,text,timedOut});});
 });
 await writeFile(join(run,'result.tap'),result.text);
 const audits=[];for(const entry of await readdir(auditDir))if(/^guard-\d+\.json$/.test(entry))audits.push(JSON.parse(await readFile(join(auditDir,entry),'utf8')));
 const item={file:name,exitCode:result.code,timedOut:result.timedOut,tests:metric(result.text,'tests'),passed:metric(result.text,'pass'),failed:metric(result.text,'fail'),skipped:metric(result.text,'skipped'),cancelled:metric(result.text,'cancelled'),guardBlocks:audits.reduce((n,a)=>n+a.blocked.length,0)};
 files.push(item);console.log(name+': '+item.passed+'/'+item.tests+' passed; failures='+item.failed+', skips='+item.skipped+', guard blocks='+item.guardBlocks);
}
const after=await hashes(root),sourcesUnchanged=JSON.stringify(before)===JSON.stringify(after);
const totals=Object.fromEntries(['tests','passed','failed','skipped','cancelled','guardBlocks'].map(k=>[k,files.reduce((n,f)=>n+f[k],0)]));
const report={completedAtUTC:new Date().toISOString(),node:process.version,platform:process.platform,files,totals,sourcesUnchanged,productionReads:0,productionWrites:0,realModelCalls:0,realQQSends:0,resultsDirectory:work};
await writeFile(join(work,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({totals,sourcesUnchanged,resultsDirectory:work}));
if(!sourcesUnchanged||files.some(f=>f.exitCode!==0||f.tests===0||f.guardBlocks||f.timedOut)||totals.failed||totals.skipped||totals.cancelled)process.exitCode=1;
