import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import {validateChatText,createChatRateLimiter} from '../server/textChat.mjs';

// Transpile the actual network and its real dependencies, not a mock implementation.
const root=path.resolve(import.meta.dirname,'..');
const tmp=fs.mkdtempSync(path.join(root,'.chat-test-'));
const emitted=new Set();
function emit(source) {
  const output=path.join(tmp,path.relative(root,source).replace(/\.ts$/,'.mjs'));
  if(emitted.has(source))return output;
  emitted.add(source);
  let code=ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replaceAll('import.meta.env', 'globalThis.__chatTestEnv');
  code=code.replace(/from ['"](\.[^'"]+)['"]/g,(_,specifier)=>{
    const dependency=emit(path.resolve(path.dirname(source),specifier+'.ts'));
    return `from '${pathToFileURL(dependency).href}'`;
  });
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,code);return output;
}
let NetworkManager,RoomTextChat;
try {
  ({NetworkManager}=await import(pathToFileURL(emit(path.join(root,'src/network/NetworkManager.ts'))).href));
  ({RoomTextChat}=await import(pathToFileURL(emit(path.join(root,'src/network/RoomTextChat.ts'))).href));
}finally{fs.rmSync(tmp,{recursive:true,force:true})}

test('text chat: strict single-line bounded input, Unicode and literal markup',()=>{
  for(const value of [undefined,null,{},[],7,'','   ','x'.repeat(241),'a\nb','\0','a\u202eb','a\u2066b'])assert.equal(validateChatText(value),null);
  assert.equal(validateChatText(' x '),'x');assert.equal(validateChatText('x'.repeat(240)).length,240);
  assert.equal(validateChatText(' Grüße 👩‍🚀 '),'Grüße 👩‍🚀');
  assert.equal(validateChatText('<img src=x onerror=alert(1)> & "hi"'),'<img src=x onerror=alert(1)> & "hi"');
});

test('text chat: server sliding quota and bounded identities, refill cannot be accelerated',()=>{
  const allow=createChatRateLimiter({maxEntries:2});
  for(let i=0;i<5;i++)assert.equal(allow('account:a',i),true);
  assert.equal(allow('account:a',5),false);assert.equal(allow('account:a',9999),false);
  assert.equal(allow('account:b',9999),true);
  assert.equal(allow('account:c',9999),false,'full limiter fails closed');
  assert.equal(allow('account:a',10000),true,'only first sliding-window slot expired');
  assert.equal(allow('account:a',10000),false);
  assert.equal(allow('account:c',20000),true,'expired entries are reclaimed');
});

const packet=(id,roomCode='ROOM-A')=>({type:'chat_message',roomCode,id,senderId:'net_a',senderName:'Alpha',text:'hello',sentAt:1});
test('text chat: joined-room filtering, duplicate suppression, bounded state and unsubscribe',()=>{
  const channel=new RoomTextChat(),events=[];
  const off=channel.subscribe(e=>events.push(e));
  channel.receive(packet('before'));assert.equal(events.length,1);
  channel.joined('ROOM-A');channel.receive(packet('a','ROOM-B'));channel.receive(packet('a'));channel.receive(packet('a'));
  assert.equal(events.filter(e=>e.type==='message').length,1);
  for(let i=0;i<150;i++)channel.receive(packet(`id-${i}`));assert.equal(channel.seen.size,100);
  channel.receive({...packet('invalid'),text:42});
  channel.reset();assert.equal(channel.seen.size,0);channel.receive(packet('late'));
  channel.joined('ROOM-B');channel.receive(packet('old'));channel.receive(packet('new','ROOM-B'));
  assert.equal(events.at(-1).message.id,'new');off();off();assert.equal(channel.listeners.size,0);
  const count=events.length;channel.reset();channel.joined('ROOM-C');channel.receive(packet('after','ROOM-C'));assert.equal(events.length,count);
});

test('text chat: actual NetworkManager gates sending on ACK and detaches old sockets through reconnect/leave',()=>{
  const savedWindow=globalThis.window,savedWS=globalThis.WebSocket;
  class Socket {
    static OPEN=1;readyState=1;sent=[];onopen=null;onmessage=null;onclose=null;onerror=null;
    send(s){this.sent.push(JSON.parse(s))}close(){this.readyState=3}
    receive(data){this.onmessage?.({data:JSON.stringify(data)})}
  }
  globalThis.window={location:{protocol:'http:',host:'test'},setTimeout,clearTimeout};globalThis.WebSocket=Socket;
  const network=new NetworkManager();network.isOnlineRoom=true;network.roomCode='ROOM-A';
  const messages=[];const off=network.textChat.subscribe(e=>{if(e.type==='message')messages.push(e.message)});
  const config={mode:'online',starterLoadout:'balanced'},player={name:'Alpha',position:{x:0,y:80,z:0}};
  try {
    network.connectToMultiplayerRoom(config,player,false,'lobby');const first=network.ws;
    first.onopen();assert.equal(network.sendChat('before ACK'),false);
    first.receive({type:'room_joined',roomCode:'ROOM-A',selfPlayerId:'net_a'});
    assert.equal(network.sendChat('sent once'),true);assert.equal(first.sent.filter(m=>m.type==='chat_send').length,1);
    first.receive(packet('a'));const stale=first.onmessage;
    network.connectToMultiplayerRoom(config,player,false,'lobby');const second=network.ws;
    assert.equal(first.onmessage,null);assert.equal(first.onopen,null);assert.equal(first.onclose,null);assert.equal(first.onerror,null);
    assert.equal(network.textChat.roomCode,null);assert.equal(network.sendChat('offline'),false);
    second.onopen();second.receive({type:'room_joined',roomCode:'ROOM-A',selfPlayerId:'net_a'});
    stale({data:JSON.stringify(packet('stale'))});second.receive(packet('b'));second.receive(packet('b'));
    assert.deepEqual(messages.map(m=>m.id),['a','b']);
    assert.equal(second.sent.some(m=>m.type==='chat_send'),false,'no old message replay');
    network.state.phase='LOBBY';network.roomSnapshot.phase='lobby';
    second.onclose();assert.equal(network.textChat.roomCode,null);assert.equal(second.onmessage,null);
    assert.ok(network.reconnectTimer);network.disconnectMultiplayerRoom();assert.equal(network.reconnectTimer,null);
    network.connectToMultiplayerRoom(config,player,false,'lobby');network.ws.onopen();
    network.ws.receive({type:'room_joined',roomCode:'ROOM-A',selfPlayerId:'net_a'});
    const last=network.ws;network.leaveRoom();assert.equal(last.onmessage,null);assert.equal(network.sendChat('left'),false);
    assert.equal(network.textChat.listeners.size,1);off();assert.equal(network.textChat.listeners.size,0);
  }finally{network.disconnectMultiplayerRoom();globalThis.window=savedWindow;globalThis.WebSocket=savedWS}
});


test('text chat uses the existing multiplayer URL: secure same-origin production and explicit build overrides',()=>{
  const previousWindow=globalThis.window,previousEnv=globalThis.__chatTestEnv;
  try {
    globalThis.window={location:{protocol:'https:',host:'cicraft-battle-royale.onrender.com'}};
    const network=new NetworkManager();
    globalThis.__chatTestEnv={};
    assert.equal(network.resolveWebSocketUrl(),'wss://cicraft-battle-royale.onrender.com/ws');
    globalThis.window.location={protocol:'http:',host:'localhost:2567'};
    assert.equal(network.resolveWebSocketUrl(),'ws://localhost:2567/ws');
    globalThis.__chatTestEnv={VITE_MULTIPLAYER_SERVER_URL:' https://multiplayer.example.test/ '};
    assert.equal(network.resolveWebSocketUrl(),'wss://multiplayer.example.test/ws');
    globalThis.__chatTestEnv={VITE_MULTIPLAYER_SERVER_URL:'http://localhost:2567/'};
    assert.equal(network.resolveWebSocketUrl(),'ws://localhost:2567/ws');
    globalThis.__chatTestEnv={VITE_MULTIPLAYER_SERVER_URL:'https://ignored.example.test',VITE_MULTIPLAYER_WS_URL:' wss://socket.example.test/ws '};
    assert.equal(network.resolveWebSocketUrl(),'wss://socket.example.test/ws');
  } finally {
    globalThis.window=previousWindow;
    if(previousEnv===undefined)delete globalThis.__chatTestEnv;else globalThis.__chatTestEnv=previousEnv;
  }
});
