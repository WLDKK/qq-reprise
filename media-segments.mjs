// Metadata only: image sources are normalized without loading any pixels.
export function imageSegments(segments){return segments.filter(s=>s?.type==='image'||s?.type==='mface').map(s=>({type:'image',data:{...s.data,source_kind:s.type==='mface'?'sticker':'image'}}));}
export function faceDescription(segments){const faces=segments.filter(s=>s?.type==='face');if(!faces.length)return '';return '用户发送了QQ内置表情元数据：'+faces.slice(0,8).map(s=>{const id=String(s.data?.id??'');return /^\d{1,4}$/.test(id)?'编号'+id:'未知编号';}).join('、')+'。本次没有表情图片像素，无法确定具体外观；不要声称已经看图。';}
