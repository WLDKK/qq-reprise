const lineParts=text=>text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean);
const withoutEOL=line=>line.replace(/(?:\r\n|\r|\n)$/,'');
const escaped=(text,index)=>{let n=0;while(index>0&&text[--index]==='\\')n++;return n%2===1;};
export const QQ_PLAINTEXT_INSTRUCTIONS='回复用于QQ普通文本，QQ不渲染Markdown。用普通标题和清楚的数字/项目列表，不使用#标题、粗体标记、Markdown链接包装或表格；表格信息改为逐项说明并保留原意。代码必须保留逐行缩进、运算符、标识符与字符串；代码可放在独立围栏中供发送端可靠识别，围栏仅用于区分代码，QQ发送时会去掉。公式优先用可读纯文本，不为追求排版改动数学含义。';
export function qqOutputBlocks(text){
 if(typeof text!=='string')throw new TypeError('Reply must be text');
 const blocks=[];let prose='',code=null;
 const flush=()=>{if(prose){blocks.push({type:'text',text:prose});prose='';}};
 for(const line of lineParts(text)){
  const raw=withoutEOL(line);
  if(code){
   const close=raw.match(/^ {0,3}(`+|~+)[ \t]*$/);
   if(close&&close[1][0]===code.fence[0]&&close[1].length>=code.fence.length){blocks.push({type:'code',text:code.text,language:code.language,closed:true});code=null;}
   else code.text+=line;
  }else{
   const open=raw.match(/^ {0,3}(`{3,}|~{3,})([^`\r\n]*)$/);
   if(open){flush();code={fence:open[1],language:open[2].trim(),text:''};}else prose+=line;
  }
 }
 if(code)blocks.push({type:'code',text:code.text,language:code.language,closed:false});flush();return blocks;
}
const mathCommands={le:'≤',leq:'≤',ge:'≥',geq:'≥',ne:'≠',neq:'≠',times:'×',cdot:'·',pm:'±',infty:'∞',alpha:'α',beta:'β',gamma:'γ',theta:'θ',pi:'π',sigma:'σ',Delta:'Δ'};
export function simpleMath(source){
 let value=source.trim();
 value=value.replace(/\\frac\{([A-Za-z0-9]+)\}\{([A-Za-z0-9]+)\}/g,'($1)/($2)');
 value=value.replace(/([_^])\{([A-Za-z0-9]+)\}/g,(_,op,v)=>op+(v.length===1?v:'('+v+')'));
 value=value.replace(/\\([A-Za-z]+)/g,(all,name)=>mathCommands[name]??all);
 if(!value||!/^[\p{L}\p{N}\s+\-=<>.,:;()[\]|\/*^_!%×·±∞≤≥≠]+$/u.test(value))return null;
 return value;
}
function markdownLink(text,start){
 const image=text.startsWith('![',start),begin=start+(image?1:0);if(text[begin]!=='[')return null;
 let close=begin+1,nesting=1;for(;close<text.length&&close-start<4096;close++){if(escaped(text,close))continue;if(text[close]==='[')nesting++;if(text[close]===']'&&!--nesting)break;if(nesting>8)return null;}
 if(nesting||text[close+1]!=='(')return null;
 let end=close+2,depth=1;for(;end<text.length&&end-start<4096;end++){if(escaped(text,end))continue;if(text[end]==='(')depth++;if(text[end]===')'&&!--depth)break;if(depth>8)return null;}
 if(depth)return null;const target=text.slice(close+2,end).trim();if(!target||/[\r\n]/.test(target))return null;
 return{length:end+1-start,label:text.slice(begin+1,close),target:target.startsWith('<')&&target.endsWith('>')?target.slice(1,-1):target,image};
}
const word=ch=>!!ch&&/[\p{L}\p{N}_]/u.test(ch);
function inlineForQQ(text,warnings,depth=0){
 if(depth>4||text.length>65536){warnings.add('formatting_budget_preserved');return text;}
 let output='',i=0;
 while(i<text.length){
  if(text[i]==='`'&&!escaped(text,i)){
   let end=i;while(text[end]==='`')end++;const delimiter=text.slice(i,end);let close=text.indexOf(delimiter,end);
   while(close>=0&&(text[close-1]==='`'||text[close+delimiter.length]==='`'||escaped(text,close)))close=text.indexOf(delimiter,close+delimiter.length);
   if(close>=0&&!/[\r\n]/.test(text.slice(end,close))){output+=text.slice(end,close);i=close+delimiter.length;continue;}
  }
  let opener='',closer='';
  if(text.startsWith('\\(',i)&&!escaped(text,i)){opener='\\(';closer='\\)';}
  else if(text.startsWith('\\[',i)&&!escaped(text,i)){opener='\\[';closer='\\]';}
  else if(text[i]==='$'&&!escaped(text,i)){opener=text[i+1]==='$'?'$$':'$';closer=opener;}
  if(opener){
   const end=text.indexOf(closer,i+opener.length);
   if(end>=0){const source=text.slice(i+opener.length,end),raw=text.slice(i,end+closer.length);
    if(opener==='$'&&/^\d/.test(source)&&/\s[A-Za-z]{2,}/.test(source)){output+=text[i++];continue;}
    const readable=simpleMath(source);if(readable===null){warnings.add('complex_math_unrendered');output+='〔公式原文（QQ不渲染）：'+raw+'〕';}else output+=readable;
    i=end+closer.length;continue;
   }
   if(opener.startsWith('\\')){warnings.add('unclosed_math');output+=text.slice(i);break;}
  }
  if(!escaped(text,i)){
   const link=markdownLink(text,i);
   if(link){const label=inlineForQQ(link.label,warnings,depth+1);output+=(link.image?'图片：':'')+(label&&label!==link.target?label+'（'+link.target+'）':link.target);i+=link.length;continue;}
   const auto=text.slice(i).match(/^<(https?:\/\/[^<>\s]+)>/i);if(auto){output+=auto[1];i+=auto[0].length;continue;}
   const url=text.slice(i).match(/^(?:https?:\/\/|mailto:)[^\s<>]+/i);if(url){output+=url[0];i+=url[0].length;continue;}
   let emphasis=false;
   for(const marker of ['***','**','*','___','__','_']){
    if(!text.startsWith(marker,i)||word(text[i-1])||/\s/.test(text[i+marker.length]||' '))continue;
    let close=text.indexOf(marker,i+marker.length),attempts=0;
    while(close>=0&&attempts++<64){
     const inner=text.slice(i+marker.length,close);
     if(inner&&!/\s$/.test(inner)&&!word(text[close+marker.length])&&!escaped(text,close)&&!/[\r\n]/.test(inner)){
      // A dunder/underscore identifier is also legal plain Python/pseudocode.
      if(marker[0]==='_'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner))break;
      output+=inlineForQQ(inner,warnings,depth+1);i=close+marker.length;emphasis=true;break;
     }
     close=text.indexOf(marker,close+marker.length);
    }
    if(emphasis)break;
   }
   if(emphasis)continue;
  }
  output+=text[i++];
 }
 return output;
}
function codeLike(line){
 if(/^(?: {4,}|\t)/.test(line)&&!/^\s*(?:[-+*]|\d+[.)])\s+/.test(line))return true;
 if(/^\s*(?:#\s*(?:include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma|error|warning|line)\b|#!|\/\/|\/\*|\*\/)/.test(line))return true;
 if(/[;{}]\s*(?:\/\/.*)?$/.test(line))return true;
 if(/^\s*(?:(?:async\s+)?(?:def|class)\s|(?:from\s+\S+\s+import|import\s+\S+)|(?:if|elif|else|for|while|try|except|finally|with)\b.*:|(?:return|yield)\b|(?:print|printf|scanf)\s*\(|std::|using\s+namespace|template\s*<)/.test(line))return true;
 return /^\s*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^\]\r\n]*\])*\s*(?:=(?!=)|\+=|-=|\*=|\/=|:=|<-)/.test(line);
}
function tableCells(raw){
 const text=raw.trim(),cells=[];let current='',code='',math='';
 for(let i=0;i<text.length;i++){
  if(text[i]==='`'&&!escaped(text,i)){let end=i;while(text[end]==='`')end++;const run=text.slice(i,end);if(!code)code=run;else if(code===run)code='';current+=run;i=end-1;continue;}
  if(!code){
   if(math){if(text.startsWith(math,i)&&!escaped(text,i)){current+=math;i+=math.length-1;math='';continue;}}
   else if(text.startsWith('\\(',i)&&!escaped(text,i)){current+='\\(';i++;math='\\)';continue;}
   else if(text.startsWith('\\[',i)&&!escaped(text,i)){current+='\\[';i++;math='\\]';continue;}
   else if(text[i]==='$'&&!escaped(text,i)){math=text[i+1]==='$'?'$$':'$';current+=math;i+=math.length-1;continue;}
  }
  if(text[i]==='|'&&!code&&!math&&!escaped(text,i)){cells.push(current.trim());current='';}else current+=text[i];
 }
 cells.push(current.trim());if(text.startsWith('|'))cells.shift();if(text.endsWith('|')&&!escaped(text,text.length-1))cells.pop();return cells;
}
function proseForQQ(text,warnings){
 const lines=lineParts(text);let output='',codeRun=false;
 for(let i=0;i<lines.length;i++){
  const raw=withoutEOL(lines[i]),eol=lines[i].slice(raw.length);
  const following=lines.slice(i+1,i+4).map(withoutEOL).find(v=>v.trim()),codeComment=/^\s*#\s/.test(raw)&&following&&codeLike(following);
  if(codeLike(raw)||codeRun&&/^\s*#/.test(raw)||codeComment){output+=lines[i];codeRun=true;continue;}
  if(raw.trim())codeRun=false;
  const heads=tableCells(raw),separator=i+1<lines.length?tableCells(withoutEOL(lines[i+1])):[];
  if(raw.includes('|')&&heads.length>1&&separator.length===heads.length&&separator.every(v=>/^:?-{3,}:?$/.test(v))){
   let end=i+2,valid=true;const rows=[];while(end<lines.length&&withoutEOL(lines[end]).includes('|')&&withoutEOL(lines[end]).trim()){const cells=tableCells(withoutEOL(lines[end]));if(cells.length!==heads.length)valid=false;rows.push({cells,line:lines[end]});end++;}
   if(!valid){warnings.add('table_shape_preserved');output+=lines.slice(i,end).join('');i=end-1;continue;}
   const labels=heads.map((v,n)=>inlineForQQ(v,warnings)||'列'+(n+1));
   if(!rows.length)output+=labels.join('；')+(eol||'\n');
   else for(let n=0;n<rows.length;n++){const row=rows[n],tail=row.line.slice(withoutEOL(row.line).length);output+=(n+1)+'. '+row.cells.map((v,j)=>labels[j]+'：'+inlineForQQ(v,warnings)).join('；')+tail;}
   warnings.add('table_to_rows');i=end-1;continue;
  }
  const quote=raw.match(/^(\s*)> ?(.*)$/);if(quote){output+=quote[1]+'引用：'+quote[2]+eol;continue;}
  if(/^ {0,3}(?:-\s*){3,}$/.test(raw)||/^ {0,3}(?:\*\s*){3,}$/.test(raw)){output+='────────'+eol;continue;}
  const heading=raw.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/);
  const list=raw.match(/^(\s*)([-+*]|\d+[.)])[ \t]+(.+)$/);
  if(heading)output+=inlineForQQ(heading[1],warnings)+eol;
  else if(list){let body=list[3];body=body.replace(/^\[([ xX])\][ \t]+/,(_,v)=>v===' '?'☐ ':'☑ ');output+=list[1]+(/^\d/.test(list[2])?list[2]:'•')+' '+inlineForQQ(body,warnings)+eol;}
  else output+=inlineForQQ(raw,warnings)+eol;
  if(i+1<lines.length&&raw.trim()&&/^ {0,3}(?:={3,}|-{3,})[ \t]*$/.test(withoutEOL(lines[i+1]))){i++;}
 }
 return output;
}
export function formatQQOutput(text){
 const blocks=qqOutputBlocks(text),warnings=new Set();let display='';
 for(const block of blocks){
  if(block.type==='code'){
   if(!block.closed){warnings.add('unclosed_code_fence');display+='代码块未闭合，以下保留原内容：\n';}
   display+=block.text;
  }else display+=proseForQQ(block.text,warnings);
 }
 // One retained-outbox item and one QQ call: never split a code block/formula
 // across independent deliveries or race their ordering. No file is sent.
 return {text:display,blocks,warnings:[...warnings],message:[{type:'text',data:{text:display}}]};
}
