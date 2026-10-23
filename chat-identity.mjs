import {DISPLAY_FIELDS,validateDisplayPatch,eventDisplayName,effectiveAddressMode} from './chat-display.mjs';
import {id} from './engine.mjs';
import {SettingsFieldError} from './settings-field-error.mjs';
import {inspectVisionText} from './vision-privacy.mjs';

export const CHAT_IDENTITY_FIELDS=['chat_owner_qq','chat_owner_address',...DISPLAY_FIELDS];
export function validateChatIdentityPatch(input){
 const out=validateDisplayPatch(input);
 if(Object.hasOwn(input,'chat_owner_qq')){const value=input.chat_owner_qq;if(typeof value!=='string'||value!==''&&!/^[1-9]\d{4,11}$/.test(value))throw new SettingsFieldError('chat_owner_qq','请填写完整的5～12位QQ号，留空表示不绑定。');out.chat_owner_qq=value;}
 if(Object.hasOwn(input,'chat_owner_address')){const value=input.chat_owner_address;if(typeof value!=='string'||value.length>1048576||/[\u0000-\u001f\u007f]/u.test(value)||value.trim()&&inspectVisionText(value,Math.max(1,value.length)).reason==='credentials')throw new SettingsFieldError('chat_owner_address','称呼整份配置最多1048576字符，不能包含控制字符或凭据。');out.chat_owner_address=value;}
 return out;
}
// Only transport authors participate in owner matching. Display names never grant authority.
// This result is conversational metadata and is never an authorization decision.
export function chatQuestioner(config,event,expectedSelfId){
 const address=typeof config.bot_address==='string'?config.bot_address:'你';
 const name=eventDisplayName(config,event,expectedSelfId);
 const ordinary={is_owner:false,address_user_as:name&&(effectiveAddressMode(config)==='auto'||(config.chat_display_overrides||[]).some(v=>v.user_id===String(event.sender?.user_id??event.user_id)&&v.group_id===(event.message_type==='group'?String(event.group_id):'')))?name:address,...(name?{display_name:name}:{})};
 if(!config.chat_owner_qq||!['message','message_sent'].includes(event?.post_type)||event.anonymous||event.sub_type==='anonymous'||event.from_history||event.message_source==='history')return ordinary;
 const self=id(event.self_id,true);if(!self||self!==id(expectedSelfId,true)||self!==id(config.binding_qq,true))return ordinary;
 const topPresent=event.user_id!==undefined&&event.user_id!==null,nestedPresent=event.sender?.user_id!==undefined&&event.sender?.user_id!==null;
 const top=topPresent?id(event.user_id,true):null,nested=nestedPresent?id(event.sender.user_id,true):null;
 if(topPresent&&!top||nestedPresent&&!nested||top&&nested&&top!==nested)return ordinary;
 const sender=nested||top;if(!sender||sender!==config.chat_owner_qq)return ordinary;
 return {...ordinary,is_owner:true,address_user_as:typeof config.chat_owner_address==='string'?config.chat_owner_address:ordinary.address_user_as};
}
