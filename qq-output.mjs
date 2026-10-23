const lineParts=text=>text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean);
const withoutEOL=line=>line.replace(/(?:\r\n|\r|\n)$/,'');
const escaped=(text,index)=>{let n=0;while(index>0&&text[--index]==='\\')n++;return n%2===1;};
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
function proseForQQ(text,warnings){
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
  output+=text[i++];
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
