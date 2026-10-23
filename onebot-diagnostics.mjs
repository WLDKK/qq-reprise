// Read-only probes through the existing authenticated connection. No messages or history.
export async function inspectOneBotConnection(app, {expectedNickname='',timeoutMs=5000}={}) {
 const client=app.client,self=app.selfId,startedAt=Date.now();
 const out={startedAt,connected:!!app.connected,socketOpen:client?.socket?.readyState===1,cachedFriendCount:app.friends?.length||0,cachedGroupCount:app.groups?.length||0};
 if(!out.connected||!out.socketOpen)return {...out,result:'disconnected'};
 try{const u=new URL(client.config.ws_url);out.route={loopback:['127.0.0.1','localhost','[::1]'].includes(u.hostname),port:Number(u.port),rootPath:u.pathname==='/'};}catch{out.route={valid:false};}
 const read=async(action,select,params={})=>{let timer;try{const data=await Promise.race([client.call(action,params),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('diagnostic_timeout')),Math.min(5000,Math.max(1,timeoutMs)));})]);return {result:'ok',...select(data)};}catch(e){return{result:e?.message==='diagnostic_timeout'?'timeout':'failed',...(Number.isInteger(e?.retcode)?{retcode:e.retcode}:{})};}finally{clearTimeout(timer);}};
 const [login,status,friends,groups,version,packetBackend,selfPresence]=await Promise.all([
  read('get_login_info',d=>({accountMatches:String(d?.user_id)===self,...(expectedNickname?{nicknameMatchesExpected:d?.nickname===expectedNickname}:{})})),
  read('get_status',d=>({online:d?.online===true,good:d?.good===true,stat:Object.fromEntries(['packet_received','packet_sent','packet_lost','message_received','message_sent','disconnect_times','lost_times','last_message_time'].filter(k=>typeof d?.stat?.[k]==='number'&&Number.isFinite(d.stat[k])).map(k=>[k,d.stat[k]]))})),
  read('get_friend_list',d=>({count:Array.isArray(d)?d.length:null})),read('get_group_list',d=>({count:Array.isArray(d)?d.length:null})),
  read('get_version_info',d=>Object.fromEntries(['app_name','app_version','protocol_version'].filter(k=>typeof d?.[k]==='string'&&/^[\w .+-]{1,80}$/.test(d[k])).map(k=>[k,d[k]]))),
  read('nc_get_packet_status',()=>({available:true})),
  read('nc_get_user_status',d=>Object.fromEntries(['status','ext_status'].filter(k=>Number.isSafeInteger(d?.[k])).map(k=>[k,d[k]])),{user_id:self})
 ]);
 if(app.client!==client||app.selfId!==self||!app.connected)return {...out,result:'connection_changed',finishedAt:Date.now()};
 return {...out,result:'completed',login,status,friends,groups,version,packetBackend,selfPresence,finishedAt:Date.now()};
}
