import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {formatQQOutput,qqOutputBlocks,QQ_PLAINTEXT_INSTRUCTIONS} from './qq-output.mjs';
import {AIChat} from './ai-chat.mjs';import {AI_DEFAULTS} from './ai-config.mjs';import {MemorySecrets} from './ai-storage.mjs';import {ResendQueue} from './send-queue.mjs';import {apiBinding} from './ai-api-draft.mjs';
const cases=[
 ['headings and bold','# 解题思路\n## 复杂度 **O(n)**\n','解题思路\n复杂度 O(n)\n'],
 ['nested emphasis','***重点*** 与 **外层 *内层* 内容**','重点 与 外层 内层 内容'],
 ['underscore identifiers','left_value __name__ test_case __中文强调__','left_value __name__ test_case 中文强调'],
 ['inline code operators','值：`a*b + c_d`；`#define N 8`','值：a*b + c_d；#define N 8'],
 ['nested-parenthesis link','[题目](https://example.invalid/a_(b)?q=x*y#case_id)','题目（https://example.invalid/a_(b)?q=x*y#case_id）'],
 ['plain URL punctuation','https://example.invalid/a_b?q=*a*&v=__name__#tag','https://example.invalid/a_b?q=*a*&v=__name__#tag'],
 ['automatic link','<https://example.invalid/a_b>','https://example.invalid/a_b'],
 ['image reference text','![合成图](https://example.invalid/x_y.png)','图片：合成图（https://example.invalid/x_y.png）'],
 ['nested list','- **思路**\n  * 维护 `a_b`\n    - [x] 完成\n','• 思路\n  • 维护 a_b\n    • ☑ 完成\n'],
 ['ordered plain list','1. 初始化\n2. 返回答案\n','1. 初始化\n2. 返回答案\n'],
 ['setext heading','思路\n===\n解释正文\n','思路\n解释正文\n'],
 ['ordinary operators','a*b + c_d # C++ && --i','a*b + c_d # C++ && --i'],
 ['quoted literal prose','> **用户原文** a*b _name_\n','引用：**用户原文** a*b _name_\n'],
 ['link label inline code','[`a_b`](https://example.invalid/x_y)','a_b（https://example.invalid/x_y）'],
 ['array indices','a[i] * b[j] + value_name','a[i] * b[j] + value_name'],
 ['preprocessor outside fence','# include <iostream>\n#define X a*b\n','\# include <iostream>\n#define X a*b\n'.replace('\\#','#')],
 ['Python assignment outside fence','name_value = "**raw** # _literal_"\n','name_value = "**raw** # _literal_"\n'],
 ['indented code','    # comment **literal**\n    value_a *= b_c\n','    # comment **literal**\n    value_a *= b_c\n'],
 ['horizontal separator','前文\n\n---\n后文','前文\n\n────────\n后文'],
 ['nested label link','[a [b]](https://example.invalid/x_(y))','a [b]（https://example.invalid/x_(y)）'],
];
for(const [name,input,expected]of cases)test('QQ plaintext '+name,()=>assert.equal(formatQQOutput(input).text,expected));
test('C++ fenced bytes including CRLF, pointer stars and strings are unchanged',()=>{
 const code='# include <iostream>\r\n#define MUL(a,b) ((a)*(b))\r\nint **p = nullptr;\r\n\tstd::string s = "**literal** _name_ # `";\r\n';
 const output=formatQQOutput('说明：\r\n```cpp\r\n'+code+'```\r\n结束。');assert.equal(output.text,'说明：\r\n'+code+'结束。');assert.equal(output.blocks.find(v=>v.type==='code').text,code);
});
test('C fence never treats operators or preprocessor as Markdown',()=>{const code='#define N 100\nchar *p = "# __ * `";\nint x = a * b;\n';assert.equal(formatQQOutput('```c\n'+code+'```').text,code);});
test('Python indentation, dunders, comments and string characters are byte-for-byte retained',()=>{const code='def solve(a_b):\n\tif __name__ == "__main__":\n\t\tprint("**raw** # _name_ `")\n\treturn a_b ** 2 # comment\n';assert.equal(formatQQOutput('```python\n'+code+'```').text,code);});
test('long outer fence does not close at a shorter inner fence',()=>{const code='print("start")\n```\n# literal\n';assert.equal(formatQQOutput('````python\n'+code+'````\n').text,code);});
test('unclosed fence is explicit and retains its entire body',()=>{const code='  int *p = a_b;\n';const out=formatQQOutput('```cpp\n'+code);assert(out.text.endsWith(code));assert(out.warnings.includes('unclosed_code_fence'));});
test('simple and complex formulas keep their mathematical information',()=>{
 const simple=formatQQOutput('式子：$a_i * b_j$，$n^{2}$ 和 \\(x\\leq y\\)');assert.equal(simple.text,'式子：a_i * b_j，n^2 和 x≤ y');
 const raw='$$\\sum_{i=1}^{n} i$$',complex=formatQQOutput(raw);assert(complex.text.includes(raw));assert(complex.warnings.includes('complex_math_unrendered'));
});
test('table rows become labels without losing inline code pipes or formulas',()=>{
 const out=formatQQOutput('| **变量** | 含义 |\n| --- | :---: |\n| `a|b` | $x_i$ |\n| `c_d` | **计数** |\n');
 assert.equal(out.text,'1. 变量：a|b；含义：x_i\n2. 变量：c_d；含义：计数\n');assert(out.warnings.includes('table_to_rows'));
});
test('irregular tables preserve their original rows and do not invent values',()=>{const raw='| a | b |\n| --- | --- |\n| one |\n';const out=formatQQOutput(raw);assert.equal(out.text,raw);assert(out.warnings.includes('table_shape_preserved'));});
test('empty table keeps its original headers',()=>assert.equal(formatQQOutput('a | b\n--- | ---\n').text,'a；b\n'));
test('escaped table pipes are not misread as extra columns',()=>{const out=formatQQOutput('| a | b |\n| --- | --- |\n| a\\|b | c |\n');assert.equal(out.text,'1. a：a\\|b；b：c\n');});
test('formula pipes are not mistaken for table column separators',()=>{const out=formatQQOutput('| 公式 | 含义 |\n| --- | --- |\n| $a|b$ | 位或 |\n');assert.equal(out.text,'1. 公式：a|b；含义：位或\n');});
test('unfenced Python comment before code retains its literal hash and content',()=>{const code='# explanation **literal**\ndef solve(a_b):\n    return a_b * 2\n';assert.equal(formatQQOutput(code).text,code);});
test('mixed code and prose stays one text segment without code or formula splitting',()=>{
 const code='int *p = a_b;\n',out=formatQQOutput('## 解法\n**说明**\n```cpp\n'+code+'```\n复杂度 $O(n)$');assert.equal(out.message.length,1);assert.equal(out.message[0].type,'text');assert.equal(out.message[0].data.text,out.text);assert(out.text.includes(code));assert(out.text.endsWith('复杂度 O(n)'));
});
test('already plain Unicode text is unchanged',()=>{const text='时间复杂度 O(n log n)，空间 O(n)。\n变量 a_b，乘法 a*b，字符串 "x_y"。';assert.equal(formatQQOutput(text).text,text);});
test('very long prose falls back without truncating user-visible content',()=>{const text='**word** '.repeat(9000);const out=formatQQOutput(text);assert.equal(out.text,text);assert(out.warnings.includes('formatting_budget_preserved'));});
test('nontext values never stringify into QQ payloads',()=>assert.throws(()=>formatQQOutput({message:'synthetic'}),TypeError));
test('AI reply formatting changes only the outgoing model answer and adds QQ presentation guidance',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'qq-plaintext-mock-')),calls=[],sent=[],question='问题原文 **保留** 与 a*b',answer='## 思路\n**维护计数**\n```cpp\nint x = a * b;\n```\n[参考](https://example.invalid/a_b)';
 const app={selfId:'90001',connected:true,onlineConfirmed:true,sendQueue:new ResendQueue({intervalMs:0,jitterMs:0}),client:{call:async(action,body)=>{sent.push({action,body});return{message_id:80001};}}};
 const ai=new AIChat({dir,app,secrets:new MemorySecrets(),poolSecrets:new MemorySecrets(),provider:{generate:async(config,history,prompt)=>{calls.push({config:structuredClone(config),prompt});return answer;}}});await ai.initialize();ai.config={...structuredClone(AI_DEFAULTS),enabled:true,binding_qq:'90001',api_model:'synthetic',cooldown_seconds:0};ai.auth.meta.api_configured=true;ai.auth.meta.api_id='synthetic';ai.auth.meta.api_binding=apiBinding(ai.config);
 t.after(async()=>{ai.dispose();await ai.budgetTask;await ai.settingsFile.task;await ai.diagnostics.file.task;await rm(dir,{recursive:true,force:true});});
 const event={post_type:'message',message_type:'private',sub_type:'friend',self_id:90001,user_id:60001,message_id:1,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:question}}]},original=structuredClone(event.message);ai.observe(event);assert.equal(ai.offer(event),true);
 for(let i=0;i<300&&ai.counts.sent!==1;i++)await new Promise(r=>setTimeout(r,5));assert.equal(ai.counts.sent,1);assert.deepEqual(event.message,original);assert(calls[0].prompt.includes(question));assert(calls[0].config.instructions.includes(QQ_PLAINTEXT_INSTRUCTIONS));
 const output=sent[0].body.message.filter(v=>v.type==='text').map(v=>v.data.text).join('');assert.equal(output,'思路\n维护计数\nint x = a * b;\n参考（https://example.invalid/a_b）');
});
