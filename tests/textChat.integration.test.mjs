import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port}
function wait(ws,predicate,timeout=6000){return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(Error('Chat packet timeout'));},timeout);
  const handler=e=>{const m=JSON.parse(e.data);if(predicate(m)){cleanup();resolve(m)}};
  const cleanup=()=>{clearTimeout(timer);ws.removeEventListener('message',handler)};
  ws.addEventListener('message',handler);
})}
async function request(ws,message,type){const ack=wait(ws,m=>typeof type==='function'?type(m):m.type===type);ws.send(JSON.stringify(message));return ack}

test('text chat: production server, authenticated four-player delivery, isolation and reconnect',{timeout:45000},async t=>{
  const port=await freePort(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ci-chat-'));
  const child=spawn(process.execPath,['server/multiplayerServer.mjs'],{
    cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATABASE_URL:'',
      SQLITE_DB_PATH:path.join(tmp,'test.sqlite'),HUMAN_MATCH_COUNTDOWN_MS:'250',ACCOUNT_TOKEN_SECRET:'text-chat-test-only-secret-0123456789abcdef'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  const base=`http://127.0.0.1:${port}`,sockets=[],received=new Map();
  const connect=async()=>{const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);sockets.push(ws);received.set(ws,[]);
    ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.type==='chat_message')received.get(ws).push(m)});
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});return ws};
  const close=async ws=>{if(ws.readyState===WebSocket.CLOSED)return;const done=new Promise(r=>ws.addEventListener('close',r,{once:true}));ws.close();await done};
  try {
    let healthy=false;for(let i=0;i<100;i++){try{healthy=(await fetch(base+'/health')).ok;if(healthy)break}catch{}await delay(100)}
    assert.ok(healthy,logs);
    const accounts=[];
    for(const callsign of ['ChatAlpha','ChatBravo','ChatCharlie','ChatDelta','OtherLobby']){
      const r=await fetch(base+'/api/account/init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callsign})});
      assert.equal(r.status,200);accounts.push(await r.json());
    }
    const credentials=i=>({accountId:accounts[i].accountId,accountToken:accounts[i].accountToken});
    const clients=[];for(let i=0;i<6;i++)clients.push(await connect());
    const create=async(i,name)=>request(clients[i],{type:'create_lobby',...credentials(i),playerName:name,config:{name,visibility:'public',humanOnly:true,maxPlayers:4,mapId:'ci_island',teamMode:'solo',botCount:0,startCondition:'host_start'}},'lobby_created');
    const room=await create(0,'ChatAlpha'),other=await create(4,'OtherLobby');
    const join=async(ws,i,code,token)=>{
      const response=await request(ws,{type:'join_room',...credentials(i),playerName:['ChatAlpha','ChatBravo','ChatCharlie','ChatDelta','OtherLobby'][i],roomCode:code,roomMode:'human_only_public',purpose:'lobby',joinIntent:'join_existing',sessionToken:token},m=>m.type==='room_joined'||m.type==='join_rejected');
      assert.equal(response.type,'room_joined',response.reason);return response;
    };
    const joined=[];for(let i=0;i<4;i++)joined.push(await join(clients[i],i,room.roomCode,`sess_chat_${i}`));
    await join(clients[4],4,other.roomCode,'sess_chat_other');

    await t.test('four recipients get one identical server-authored sender/message; no directory or other-lobby delivery',async()=>{
      const text='<img src=x onerror=alert(1)> & Grüß dich 👋';
      const pending=clients.slice(0,4).map(ws=>wait(ws,m=>m.type==='chat_message'&&m.text===text));
      clients[0].send(JSON.stringify({type:'chat_send',text,roomCode:room.roomCode,senderName:'FORGED',senderId:'forged',sentAt:0,id:'forged'}));
      const messages=await Promise.all(pending);for(const m of messages)assert.deepEqual(m,messages[0]);
      assert.equal(messages[0].senderId,joined[0].selfPlayerId);assert.equal(messages[0].senderName,'ChatAlpha');assert.notEqual(messages[0].id,'forged');assert.ok(messages[0].sentAt>0);
      for(const m of messages)for(const account of accounts)assert.ok(!JSON.stringify(m).includes(account.accountToken));
      await delay(150);assert.equal(received.get(clients[4]).length,0);assert.equal(received.get(clients[5]).length,0);
      for(const ws of clients.slice(0,4))assert.equal(received.get(ws).filter(m=>m.id===messages[0].id).length,1);
    });
    await t.test('unjoined sockets and forged target lobby cannot send; rooms are bidirectionally isolated',async()=>{
      const unjoined=await request(clients[5],{type:'chat_send',roomCode:room.roomCode,text:'not joined'},'chat_rejected');assert.equal(unjoined.code,'not_in_lobby');
      const forged=await request(clients[0],{type:'chat_send',roomCode:other.roomCode,text:'cross room'},'chat_rejected');assert.equal(forged.code,'not_in_lobby');
      await request(clients[4],{type:'chat_send',text:'other lobby only'},'chat_message');await delay(150);
      assert.equal(received.get(clients[4]).length,1);for(const ws of clients.slice(0,4))assert.equal(received.get(ws).length,1);
    });
    await t.test('invalid types, empty/control text and overlong messages are rejected, not broadcast',async()=>{
      for(const text of [null,{},'   ','a\nb','x'.repeat(241)]){
        const m=await request(clients[1],{type:'chat_send',text},'chat_rejected');assert.equal(m.code,'invalid_text');
      }
      const m=await request(clients[1],{type:'chat_send',text:'invalid attempts count'},'chat_rejected');assert.equal(m.code,'rate_limited');
      assert.equal(received.get(clients[0]).length,1);
    });
    await t.test('server limit stops a sixth message and survives a removed seat/reconnect',async()=>{
      for(let i=0;i<4;i++)await request(clients[0],{type:'chat_send',text:`allowed ${i}`},'chat_message');
      const limited=await request(clients[0],{type:'chat_send',text:'sixth'},'chat_rejected');assert.equal(limited.code,'rate_limited');
      const old=clients[0];await close(old);const oldCount=received.get(old).length;
      clients[0]=await connect();await join(clients[0],0,room.roomCode,'sess_reconnected_chat_alpha');
      const after=await request(clients[0],{type:'chat_send',text:'reconnect cannot reset quota'},'chat_rejected');assert.equal(after.code,'rate_limited');
      assert.equal(received.get(clients[0]).length,0,'no historical chat replay');
      const next=wait(clients[0],m=>m.type==='chat_message'&&m.text==='after reconnect');
      await request(clients[2],{type:'chat_send',text:'after reconnect'},'chat_message');await next;await delay(100);
      assert.equal(received.get(old).length,oldCount);assert.equal(received.get(clients[0]).length,1);
    });
    await t.test('socket replacement and explicit leave cannot deliver stale chat or authorize an old seat',async()=>{
      const old=clients[3],replacement=await connect();
      const closed=new Promise(r=>old.addEventListener('close',r,{once:true}));
      await join(replacement,3,room.roomCode,'sess_replaced_delta');await closed;
      const oldCount=received.get(old).length;
      const next=wait(replacement,m=>m.type==='chat_message'&&m.text==='new socket only');
      await request(clients[2],{type:'chat_send',text:'new socket only'},'chat_message');await next;
      replacement.send(JSON.stringify({type:'leave_room'}));
      // A following ping is processed after leave, avoiding a timing-only assertion.
      await request(replacement,{type:'ping'},'pong');
      const rejection=await request(replacement,{type:'chat_send',text:'left'},'chat_rejected');assert.equal(rejection.code,'not_in_lobby');
      const count=received.get(replacement).length;
      await request(clients[2],{type:'chat_send',text:'after leave'},'chat_message');await delay(150);
      assert.equal(received.get(replacement).length,count);assert.equal(received.get(old).length,oldCount);
      assert.equal(received.get(clients[5]).length,0);
    });
    await t.test('chat continues during a real server-started four-human match with no bots',async()=>{
      clients[3]=await connect();await join(clients[3],3,room.roomCode,'sess_delta_final');
      let ready;
      for(let i=0;i<4;i++)ready=await request(clients[i],{type:'set_ready',ready:true},m=>m.type==='room_state'&&m.readyHumans>=i+1);
      assert.equal(ready.connectedHumans,4);assert.equal(ready.botCount,0);
      assert.equal(ready.hostPlayerId,joined[1].selfPlayerId,'host transferred when Alpha disconnected');
      const started=clients.slice(0,4).map(ws=>wait(ws,m=>m.type==='match_started'));
      clients[1].send(JSON.stringify({type:'request_match_start'}));
      for(const state of await Promise.all(started)){assert.equal(state.matchParticipantCount,4);assert.equal(state.botCount,0)}
      const delivered=clients.slice(0,4).map(ws=>wait(ws,m=>m.type==='chat_message'&&m.text==='match is live'));
      clients[3].send(JSON.stringify({type:'chat_send',text:'match is live'}));
      const messages=await Promise.all(delivered);for(const message of messages)assert.deepEqual(message,messages[0]);
      await delay(100);assert.equal(received.get(clients[4]).length,1);assert.equal(received.get(clients[5]).length,0);
    });
  }finally{
    await Promise.all(sockets.map(close));
    const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    const code=await exited;clearTimeout(timer);fs.rmSync(tmp,{recursive:true,force:true});assert.equal(code,0,logs);
  }
});
