import test from 'node:test';
import assert from 'node:assert/strict';
import {OneBotClient} from './engine.mjs';
import {inspectOneBotConnection} from './onebot-diagnostics.mjs';
let rejectPacket=true;
const raw='packetBackend unavailable\nNativePacketClient module load failed C:\\Users\\SyntheticOwner\\native.node token=synthetic-secret-value';
class Socket extends EventTarget{
 constructor(){super();this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
 send(text){const request=JSON.parse(text);queueMicrotask(()=>{let response;if(request.action==='nc_get_packet_status'&&rejectPacket)response={status:'failed',retcode:1400,message:raw,wording:raw};else if(request.action==='send_group_msg')response={status:'failed',retcode:1200,message:'private message body token=synthetic-secret-value'};else response={status:'ok',retcode:0,data:request.action.endsWith('_list')?[]:request.action==='get_login_info'?{user_id:'90001'}:{}};this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({...response,echo:request.echo})}));});}
 close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
}
async function client(t){rejectPacket=true;const c=new OneBotClient({ws_url:'ws://127.0.0.1:3001',api_timeout_ms:500},()=>assert.fail('unexpected incoming event'),Socket);await c.open();t.after(()=>c.close());return c;}
test('ordinary packet failure retains only existing generic error classification',async t=>{const c=await client(t);try{await c.call('nc_get_packet_status');assert.fail();}catch(e){assert.equal(e.retcode,1400);assert.equal(e.packetDiagnostic,undefined);assert.ok(!e.message.includes('module load'));assert.ok(!e.message.includes('secret'));}});
test('explicit packet-only diagnostic preserves sanitized complete message and wording',async t=>{const c=await client(t);try{await c.call('nc_get_packet_status',{}, {packetDiagnostic:true});assert.fail();}catch(e){assert.equal(e.retcode,1400);assert.ok(e.packetDiagnostic.message.includes('module load failed'));assert.equal(e.packetDiagnostic.wording,e.packetDiagnostic.message);assert.equal(e.packetDiagnostic.messageTruncated,false);assert.ok(!JSON.stringify(e).includes('SyntheticOwner'));assert.ok(!JSON.stringify(e).includes('synthetic-secret-value'));}});
test('outbound message error cannot opt into diagnostic body',async t=>{const c=await client(t);try{await c.call('send_group_msg',{group_id:'50001',message:'synthetic'}, {packetDiagnostic:true});assert.fail();}catch(e){assert.equal(e.packetDiagnostic,undefined);assert.ok(!JSON.stringify(e).includes('private message body'));assert.ok(!JSON.stringify(e).includes('synthetic-secret-value'));}});
test('real transport-to-diagnostic path retains backend cause with no message send',async t=>{const c=await client(t);const out=await inspectOneBotConnection({client:c,selfId:'90001',connected:true,friends:[],groups:[]});assert.equal(out.packetBackend.retcode,1400);assert.ok(out.packetBackend.message.includes('NativePacketClient'));assert.ok(!out.packetBackend.message.includes('synthetic-secret-value'));assert.equal(out.packetBackend.wording,out.packetBackend.message);});
test('healthy packet transport does not create an error diagnostic',async t=>{const c=await client(t);rejectPacket=false;assert.deepEqual(await c.call('nc_get_packet_status',{}, {packetDiagnostic:true}),{});});
