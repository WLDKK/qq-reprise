// Local lexical hints, not a semantic model or a tokenizer. No network calls.
const stop=new Set(('什么 怎么 如何 为什么 这个 那个 这些 那些 就是 还是 可以 一个 一下 我们 你们 他们 现在 刚才 上面 下面 继续 问题 任务 解释 请问 请你 帮我 麻烦 谢谢 觉得 感觉 真的 知道 有点 这样 那样 的话 了吗 的吗 么了 你好 大家 收到 好的 哈哈 呵呵').split(' '));
const englishStop=new Set(['the','and','for','this','that','what','how','you','are','can','with','please','have','why','then','about']);
export function topicTerms(text){
 const result=new Set(),value=String(text||'').normalize('NFKC').toLowerCase();
 for(const word of value.match(/[a-z][a-z0-9_+#.-]{2,30}/gu)||[])if(!englishStop.has(word))result.add(word);
 for(const run of value.match(/[\p{Script=Han}]{2,}/gu)||[])for(let n=0;n<run.length-1;n++){const pair=run.slice(n,n+2);if(!stop.has(pair)&&!/(.)\1/u.test(pair))result.add(pair);}
 return result;
}
export function affinity(a,b){const left=topicTerms(a),right=topicTerms(b);let score=0;for(const term of left)if(right.has(term))score+=/^[a-z]/u.test(term)?3:1;return score;}
export function usefulText(text){const s=String(text||'').trim();return /[\p{L}\p{N}].*[\p{L}\p{N}]/u.test(s)&&! /^(?:[?？!！。,.，\s]|嗯|哦|啊|好|哈|呵|收到|好的|谢谢|知道了|同意|确实|笑死|路过|在的|我也是|加一|\+1)+$/u.test(s);}
export function isTaskFollowup(text){const s=String(text||'').trim();return s.length<=200&&(/刚才|前面|继续|换一种|再用.{0,6}类比/u.test(s)||/^(?:(?:那|所以|然后|那么)?(?:第[一二三四五六七八九十\d]+步|这一步|它|这个|那张|这张)|(?:能|可以).{0,8}(?:换|再|类比)|(?:怎么|如何)(?:做|解|写|实现|理解)(?:它|这个|呢)?[?？。!！\s]*$|(?:为什么|为啥)(?:这样|会这样|呢)?[?？。!！\s]*$|[?？])/u.test(s));}
// Explicit short follow-ups often share no topic words with the original question.
export function isConversationalFollowup(text){
 const s=String(text||'').trim();
 return s.length<=100&&/^(?:(?:好[的吧]?|嗯|那|所以|那么)[，,、\s]*)?(?:还有呢|然后呢|接着(?:说|讲)|再(?:详细|具体|简单)(?:一)?(?:点|些)|详细(?:一)?(?:点|些)|举(?:个|一个|些)例子|解释(?:一)?下|展开(?:说|讲)(?:说|讲)?|为什么|为啥|为什么不(?:行|是)|能再说(?:一遍|清楚点)|说的是什么|你(?:还)?记得(?:我)?(?:刚才|之前|前面)说(?:了)?什么吗)[?？。!！\s]*$/u.test(s);
}
export function dominantTopic(records,{minMessages=2,minSpeakers=2,seedLimit=12,filterSmalltalk=true}={}){
 const useful=filterSmalltalk?records.filter(v=>usefulText(v.text)):records.filter(v=>v.text);let best=null;
 for(const seed of useful.slice(-seedLimit)){
  const linked=useful.filter(v=>v.id===seed.id||affinity(seed.text,v.text)>0||v.replyTo===seed.id||seed.replyTo===v.id);
  if(linked.length<minMessages||new Set(linked.map(v=>v.sender)).size<minSpeakers)continue;
  const score=linked.length*10+linked.reduce((n,v)=>n+affinity(seed.text,v.text),0);
  if(!best||score>best.score||score===best.score&&seed.sequence>best.seed.sequence)best={seed,records:linked,score};
 }
 return best;
}
