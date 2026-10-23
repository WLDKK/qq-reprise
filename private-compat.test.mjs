import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeEvent}from'./engine.mjs';
const msg={post_type:'message',message_type:'private',sub_type:'friend',self_id:90001,user_id:60001,message_id:1,time:Math.ceil(Date.now()/1000),message:[{type:'text',data:{text:'synthetic'}}]};
test('friend private events with absent/null/zero group metadata remain private',()=>{for(const group_id of [undefined,null,0,'0']){const e=normalizeEvent({...msg,group_id});assert.equal(e.conversation_type,'private');assert.equal(e.peer_id,'60001');}});
test('positive group context, temporary sessions and self chat are not granted private scope',()=>{for(const extra of [{group_id:50001},{sub_type:'group'},{sub_type:'other'},{user_id:90001,target_id:90001}])assert.equal(normalizeEvent({...msg,...extra}),null);});
