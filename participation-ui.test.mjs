import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const html=await readFile(new URL('./ui.html',import.meta.url),'utf8');
const start=html.indexOf('// participation-ui-state:');
const end=html.indexOf('// participation-ui-state:end',start);
assert.ok(start>=0&&end>start,'UI state helpers must be the code shipped to browsers');
const {view,consent,key}=runInNewContext(html.slice(start,end)+'\n({view:participationStatusView,consent:participationHasConsent,key:participationScopeKey})');
function state(){return{enabled:true,paused:false,config:{participation_enabled:true,backend:'api',api_base_url:'https://synthetic.example.invalid/v1',api_format:'responses',api_model:'synthetic',groups:['50001'],participation_group_blacklist:[],group_member_policy:'blacklist',group_allowed_users:[],group_blacklist:[],group_context_export:true,group_context_target:'https://synthetic.example.invalid/v1',participation_cooldown_seconds:0,participation_hourly_limit:0},group_participation:{lastReason:'disabled_or_scope',error:'',effective:{scope:{aiEnabled:true,participationEnabled:true,backendSupported:true,nearbyConsent:true,qqReady:true,sharedQueueIdle:true}}}};}
test('enabled intent with missing background consent is an explicit basic-mode blocker',()=>{const s=state();s.config.group_context_export=false;s.group_participation.effective.scope.nearbyConsent=false;assert.equal(view(s).kind,'blocked');assert.match(view(s).text,/已启用.*缺少背景文字授权/u);assert.doesNotMatch(view(s).text,/已就绪/u);assert.equal(consent(s),false);});
test('recipient mismatch cannot be described as authorized',()=>{const s=state();s.config.group_context_target='https://other.example.invalid/v1';assert.equal(consent(s),false);assert.match(view(s).text,/缺少背景文字授权/u);});
test('effective false consent overrides an apparently enabled raw setting',()=>{const s=state();s.group_participation.effective.scope.nearbyConsent=false;assert.equal(consent(s),false);});
test('closed intent stays closed without requiring or granting consent',()=>{const s=state();s.config.participation_enabled=false;s.config.group_context_export=false;assert.equal(view(s).kind,'off');assert.match(view(s).text,/已关闭/u);});
for(const[name,change,pattern]of[
  ['unconfirmed runtime intent',s=>s.group_participation.effective.scope.participationEnabled=false,/运行开关尚未/u],
  ['AI off',s=>s.enabled=false,/AI 总开关关闭/u],
  ['unsupported backend',s=>s.config.backend='chatgpt',/接入不支持/u],
  ['no AI groups',s=>s.config.groups=[],/尚未配置 AI 群/u],
  ['all groups excluded',s=>s.config.participation_group_blacklist=['50001'],/均已.*排除/u],
  ['empty member allowlist',s=>s.config.group_member_policy='allowlist',/白名单为空/u],
  ['paused AI',s=>s.paused=true,/AI 当前暂停/u],
  ['ledger error',s=>s.group_participation.error='synthetic',/计数不可用/u],
  ['QQ unavailable',s=>s.group_participation.effective.scope.qqReady=false,/QQ 未在线/u],
])test('saved status distinguishes '+name,()=>{const s=state();change(s);assert.equal(view(s).kind,'blocked');assert.match(view(s).text,pattern);});
test('busy queue is a waiting state with enabled intent',()=>{const s=state();s.group_participation.effective.scope.sharedQueueIdle=false;assert.equal(view(s).kind,'waiting');assert.match(view(s).text,/优先处理已有任务/u);});
test('missing runtime policy never claims ready',()=>{const s=state();delete s.group_participation.effective;assert.equal(view(s).kind,'loading');assert.doesNotMatch(view(s).text,/已就绪/u);});
test('self or unrelated-event scope reason does not hide a now ready global policy',()=>{const s=state();assert.equal(view(s).kind,'ready');assert.match(view(s).text,/等待.*新群消息/u);assert.doesNotMatch(view(s).text,/已.*发送/u);});
for(const[reason,pattern]of[['cooldown',/同群冷却/u],['no_suitable_topic',/共同话题条件/u],['model_declined',/选择保持沉默/u],['sent',/QQ确认回执/u],['hourly_limit',/同群每小时尝试上限/u]])test('last decision remains specific: '+reason,()=>{const s=state();s.group_participation.lastReason=reason;assert.match(view(s).text,pattern);});
test('status rendering preserves user zeros and all input state',()=>{const s=state(),before=JSON.stringify(s);view(s);consent(s);key(s.config);assert.equal(JSON.stringify(s),before);assert.equal(s.config.participation_cooldown_seconds,0);assert.equal(s.config.participation_hourly_limit,0);});
test('scope identity ignores ordering but detects changes in recipient, model, groups or allowed members',()=>{const a=state().config;a.groups.push('50002');const b=structuredClone(a);b.groups.reverse();assert.equal(key(a),key(b));for(const[k,v]of[['api_base_url','https://changed.example.invalid/v1'],['api_format','chat_completions'],['api_model','changed'],['backend','chatgpt'],['groups',['50003']],['group_allowed_users',['60001']],['group_blacklist',['60002']]])assert.notEqual(key(a),key({...a,[k]:v}),k);});
test('basic consent flow uses existing scoped endpoints and bounded local requests',()=>{assert.match(html,/participation-consent-notice/u);assert.match(html,/授权背景文字并保存主动参与/u);assert.match(html,/const participationRequest=\(path,body\)=>api\(path,body,AbortSignal\.timeout\(10000\)\)/u);assert.match(html,/submit\('\/api\/ai\/participation',patch/u);assert.match(html,/participationSaveState\.unknown/u);assert.match(html,/重新读取保存结果/u);});
