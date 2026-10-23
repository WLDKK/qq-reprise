import test from 'node:test';
import assert from 'node:assert/strict';
import { privateTextDecision, privatePayloadDecision, PRIVATE_INSTRUCTIONS } from './private-privacy.mjs';
for (const text of ['你好','您好！','在吗','讲个笑话','写一首关于春天的诗','什么是光合作用','为什么天空是蓝色的','Hi!','1 + 2 等于几','一加一等于几']) test('explicit ordinary short text can pass locally: ' + text, () => { assert.equal(privateTextDecision(text).allowed, true); });
for (const [category, texts] of Object.entries({
  health:['我生病了，这是诊断报告','My diagnosis is private','最近总失眠，不想告诉别人'],
  finance:['我的银行卡余额和贷款','工资是5000，负债很多','My salary and credit score'],
  identity:['我的身份证号码是110101200001011234','我姓张，叫张三','My passport is private'],
  credentials:['api_key=synthetic-new-key','密码是合成测试','密\u200b钥是合成文字'],
  location:['我的住址在某路，电话13800000000','Email me at synthetic@example.invalid'],
  sensitive:['我的宗教信仰和性取向','我和女朋友分手了','公司客户资料请保密'],
  invalid:['你好\u200b','普通文字\u0000'],
})) for (const text of texts) {
  const blocked=category==='credentials'||category==='location'||(category==='identity'&&text.includes('110101200001011234'))||(category==='invalid'&&text.includes('\u0000'));
  test((blocked?'concrete sensitive value remains local: ':'topic-only ordinary text is allowed: ')+category+'/'+text.slice(0,12),()=>{assert.equal(privateTextDecision(text).allowed,!blocked);});
}
test('authorized ordinary text is not restricted to fixed phrases; no claim of a complete privacy classifier', () => { for(const text of ['继续刚才那个','帮我判断这件事','请比较积云和卷云的外形','普通但是超出原有固定句式的一大段话'])assert.equal(privateTextDecision(text).allowed,true); assert.equal(PRIVATE_INSTRUCTIONS.includes('个人资料'), true); });
test('context scans user and assistant turns; prior sensitive data blocks benign follow-up', () => {
  assert.equal(privatePayloadDecision('你好',[{role:'user',content:'我的私人病历'}]).allowed,true);
  for (const role of ['user','assistant']) { const result = privatePayloadDecision('你好', [{ role, content:'password=synthetic-history-credential' }]); assert.equal(result.allowed,false); assert.equal(result.reason,'context_credentials'); }
  assert.equal(privatePayloadDecision('你好', [{role:'assistant',content:'不确定的自由形式回复'}]).reason,'context_unreviewed');
  assert.equal(privatePayloadDecision('你好', [{role:'user',content:'hi!'}]).allowed,true);
});
test('ordinary text keeps its original wording and punctuation', () => { const result=privatePayloadDecision('Ｈｉ！！！', []); assert.equal(result.allowed,true); assert.equal(result.prompt,'Ｈｉ！！！'); });
