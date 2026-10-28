// Offline preflight only. Do not import or start the assistant here.
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const MINIMUM_NODE='22.4.0';
export const TESTED_NODE='24.14.0';
const featureNames=['fetch','WebSocket','AbortSignal.any','AbortSignal.timeout','structuredClone'];
function version(value){
  if(typeof value!=='string')return null;
  const m=/^v?(\d{1,3})\.(\d{1,3})\.(\d{1,3})(-[A-Za-z0-9.-]{1,40})?$/.exec(value);
  return m?{numbers:m.slice(1,4).map(Number),text:m.slice(1,4).join('.')+(m[4]||''),prerelease:!!m[4]}:null;
}
export function evaluateEnvironment({platform,nodeVersion,arch,features={},powershellAvailable=false}){
  const parsed=version(nodeVersion),numbers=parsed?.numbers;
  const nodeOK=!!numbers&&(numbers[0]>22||numbers[0]===22&&(numbers[1]>4||numbers[1]===4&&numbers[2]>=0));
  const checks=[
    {id:'windows',status:platform==='win32'?'pass':'fail',message:platform==='win32'?'Windows 平台':'此版本运行路径需要 Windows；未验证其他系统'},
    {id:'node_version',status:nodeOK?'pass':'fail',message:nodeOK?'Node 版本达到最低前置条件':'需要 Node.js '+MINIMUM_NODE+' 或更高版本'},
    ...featureNames.map(name=>({id:name,status:features[name]===true?'pass':'fail',message:features[name]===true?name+' 可用':name+' 不可用；核对 Node 版本及禁用功能的启动参数'})),
    {id:'powershell_file',status:platform!=='win32'?'not_checked':powershellAvailable?'pass':'fail',message:platform!=='win32'?'非 Windows，不检查 PowerShell 文件':powershellAvailable?'Windows PowerShell 文件可读（未执行）':'未确认 Windows PowerShell 文件可读；检查安装或权限，本工具不安装或修改它'}
  ];
  const warnings=[];
  if(parsed&&parsed.text!==TESTED_NODE)warnings.push('当前 Node 构建不在本项目本次实测版本 '+TESTED_NODE+' 内；前置条件通过不等于完整兼容验证');
  if(parsed?.prerelease)warnings.push('当前是 Node 预发布构建');
  return {schema:1,ok:checks.every(c=>c.status!=='fail'),scope:'offline_runtime_prerequisites_only',platform:['win32','linux','darwin'].includes(platform)?platform:'other',arch:['x64','arm64','ia32'].includes(arch)?arch:'other',nodeVersion:parsed?.text||'unrecognized',minimumNode:MINIMUM_NODE,testedNode:TESTED_NODE,checks,warnings,
    notChecked:['QQ_online','NapCat_version_and_PacketBackend','account_or_group_binding','API_credentials_quota_or_billing','real_message_or_sign_success'],
    sideEffects:{networkRequests:0,childProcesses:0,configurationReads:0,configurationWrites:0,credentialReads:0}};
}
export async function inspectEnvironment({platform=process.platform,nodeVersion=process.version,arch=process.arch,globals=globalThis,windowsRoot=process.env.SystemRoot||process.env.WINDIR||'C:\\Windows',probeFile=path=>access(path,constants.R_OK)}={}){
  let powershellAvailable=false;
  if(platform==='win32'){
    try{await probeFile(join(windowsRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'));powershellAvailable=true;}catch{}
  }
  return evaluateEnvironment({platform,nodeVersion,arch,powershellAvailable,features:{fetch:typeof globals.fetch==='function',WebSocket:typeof globals.WebSocket==='function','AbortSignal.any':typeof globals.AbortSignal?.any==='function','AbortSignal.timeout':typeof globals.AbortSignal?.timeout==='function',structuredClone:typeof globals.structuredClone==='function'}});
}
export async function runCLI(args,{inspect=inspectEnvironment,write=value=>process.stdout.write(value)}={}){
  if(args.length===1&&['--help','-h'].includes(args[0])){write('用法：node scripts/check-environment.mjs [--json]\n离线前置检查；不连接 QQ、NapCat 或模型。\n');return 0;}
  if(args.length>1||args.length===1&&args[0]!=='--json'){write('不支持此参数；请用 --help 查看用法。本次未执行检查。\n');return 2;}
  const report=await inspect();
  // ASCII escapes survive legacy PowerShell/native-output code-page conversions.
  if(args[0]==='--json')write(JSON.stringify(report,null,2).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))+'\n');
  else{
    write('回响 QQ 助手：离线运行前置检查\n');
    for(const c of report.checks)write('['+({pass:'通过',fail:'未满足',not_checked:'未检查'}[c.status])+'] '+c.message+'\n');
    for(const warning of report.warnings)write('[说明] '+warning+'\n');
    write('仅检查离线前置条件：未连接 QQ、NapCat 或模型，未读取运行配置或凭据。通过不代表真实链路可用。\n');
  }
  return report.ok?0:1;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)process.exitCode=await runCLI(process.argv.slice(2));
