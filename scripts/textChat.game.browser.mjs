/** Real compiled app + real local multiplayer server. No routes, injected app
 * globals, paused RAF, mocked sends, or manual RoomTextChat.joined calls.
 * One rendered mobile browser and three authenticated protocol peers start a
 * four-human match; a fifth peer checks a separate lobby. Not live/WAN/device QA.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(path.resolve(process.env.MOBILE_QA_MODULES||'/tmp/hud-qa/node_modules','../package.json'));
const {chromium}=require('playwright-core');
const slim=(await import(require.resolve('@sparticuz/chromium'))).default;
const base=process.env.GAME_QA_URL||'http://localhost:2567';
const output=process.env.CHAT_QA_OUTPUT||'/tmp/cinite-chat-fix';fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({executablePath:await slim.executablePath(),args:slim.args,headless:true});
const peers=[];
const wait=(ws,type)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.removeEventListener('message',handler);reject(Error(`Timeout: ${type}`))},15000);
  const handler=e=>{const msg=JSON.parse(e.data);if(msg.type===type){clearTimeout(timer);ws.removeEventListener('message',handler);resolve(msg)}};
  ws.addEventListener('message',handler);
});
const request=async(ws,payload,type)=>{const result=wait(ws,type);ws.send(JSON.stringify(payload));return result};
try {
  const context=await browser.newContext({viewport:{width:1280,height:800},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  const page=await context.newPage();page.setDefaultTimeout(30000);
  const errors=[],chatPackets=[],socketURLs=[],scripts=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&/THREE|WebGL|shader/i.test(m.text()))errors.push(m.text())});
  page.on('request',r=>{if(r.resourceType()==='script')scripts.push(r.url())});
  page.on('websocket',ws=>{
    socketURLs.push(ws.url());
    ws.on('framereceived',({payload})=>{try{const m=JSON.parse(String(payload));if(m.type==='chat_message')chatPackets.push(m)}catch{}});
  });
  await page.goto(base);
  await page.selectOption('#setting-graphics','low',{force:true});
  await page.fill('#lobby-player-name','ChatFixHost');
  await page.click('#btn-mode-online');
  await page.click('#btn-browser-create');
  await page.fill('#create-lobby-name',`Chat fix QA ${Date.now()}`);
  await page.selectOption('#create-lobby-max','4');
  await page.selectOption('#create-lobby-start','host_start');
  await page.click('#btn-create-lobby-submit');
  await page.waitForFunction(()=>document.getElementById('my-lobby-code').value.startsWith('HPLAY-'));
  const code=await page.inputValue('#my-lobby-code');
  await page.waitForSelector('#chat-toggle',{state:'visible'});

  for(let i=0;i<4;i++){
    const name=`ChatPeer${i}`;
    const res=await fetch(`${base}/api/account/init`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callsign:name})});
    assert.equal(res.status,200);const account=await res.json();
    const ws=new WebSocket(base.replace(/^http/,'ws')+'/ws'),messages=[];
    peers.push({ws,messages});ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.type==='chat_message')messages.push(m)});
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
    const credentials={accountId:account.accountId,accountToken:account.accountToken};
    let roomCode=code;
    if(i===3){const room=await request(ws,{type:'create_lobby',...credentials,playerName:name,config:{name:`Other chat QA ${Date.now()}`,humanOnly:true,visibility:'public',maxPlayers:4,mapId:'ci_island',teamMode:'solo',botCount:0,startCondition:'host_start'}},'lobby_created');roomCode=room.roomCode}
    await request(ws,{type:'join_room',...credentials,playerName:name,roomCode,roomMode:'human_only_public',purpose:'lobby',joinIntent:'join_existing',sessionToken:`sess_chatfix_${Date.now()}_${i}`},'room_joined');
  }
  await page.click('#btn-my-lobby-ready');
  for(const {ws} of peers.slice(0,3))await request(ws,{type:'set_ready',ready:true},'room_state');
  await page.waitForFunction(()=>!document.getElementById('btn-my-lobby-start').disabled);
  const starts=peers.slice(0,3).map(({ws})=>wait(ws,'match_started'));
  await page.click('#btn-my-lobby-start');
  for(const state of await Promise.all(starts)){assert.equal(state.matchParticipantCount,4);assert.equal(state.botCount,0)}
  await page.waitForSelector('#hud-overlay:not(.hidden)',{timeout:60000});
  await page.waitForFunction(()=>document.getElementById('countdown-overlay').classList.contains('hidden'),{},{timeout:60000});
  await page.setViewportSize({width:844,height:390});
  await page.waitForSelector('#chat-toggle',{state:'visible'});
  await page.waitForFunction(()=>{
    const c=document.getElementById('chat-toggle').getBoundingClientRect(),m=document.querySelector('.minimap-wrapper').getBoundingClientRect();return c.y>=m.bottom;
  });
  assert.equal(await page.evaluate(()=>typeof window.chatQAEngine),'undefined');
  assert.ok(scripts.some(url=>url.includes('/assets/index-')));assert.ok(!scripts.some(url=>url.includes('/src/main.ts')));
  assert.ok(socketURLs.length>0);for(const url of socketURLs){assert.equal(new URL(url).host,new URL(base).host);assert.equal(new URL(url).pathname,'/ws')}
  await page.screenshot({path:path.join(output,'multiplayer-chat-closed.png')});

  await request(peers[0].ws,{type:'chat_send',text:'Hello from the same lobby'},'chat_message');
  await page.waitForFunction(()=>document.getElementById('chat-unread').textContent==='1');
  await page.tap('#chat-toggle');
  assert.equal(await page.locator('#chat-panel').isVisible(),true);
  assert.equal(await page.locator('#chat-input').isEnabled(),true);
  assert.equal(await page.locator('#chat-send').isEnabled(),true);
  assert.match(await page.locator('#chat-log').textContent(),/ChatPeer0: Hello from the same lobby/);
  const delivered=peers.slice(0,3).map(({ws})=>wait(ws,'chat_message'));
  await page.fill('#chat-input','Built game says hello');await page.tap('#chat-send');
  for(const message of await Promise.all(delivered)){assert.equal(message.text,'Built game says hello');assert.equal(message.senderName,'ChatFixHost');assert.equal(message.roomCode,code)}
  await page.waitForFunction(()=>document.getElementById('chat-log').textContent.includes('ChatFixHost: Built game says hello'));
  await page.screenshot({path:path.join(output,'multiplayer-chat-open.png')});
  await request(peers[3].ws,{type:'chat_send',text:'Other lobby must stay private'},'chat_message');
  await delay(400);
  assert.ok(!chatPackets.some(m=>m.text==='Other lobby must stay private'));
  for(const peer of peers.slice(0,3))assert.ok(!peer.messages.some(m=>m.text==='Other lobby must stay private'));
  assert.ok(!peers[3].messages.some(m=>m.text==='Built game says hello'));
  await page.tap('#chat-toggle');assert.equal(await page.locator('#chat-panel').isVisible(),false);
  await page.tap('#touch-build-toggle-btn');assert.equal(await page.locator('#touch-build-toggle-btn').getAttribute('aria-expanded'),'true');
  await page.tap('#touch-build-close-btn');assert.equal(await page.locator('#touch-build-toggle-btn').getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('[data-touch-slot]').count(),5);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',mode:'compiled game, real server, mobile rendered host + 3 authenticated peers + separate lobby',sameOriginWebSocket:true,actualGameChat:true,lobbyIsolation:true,fourHumans:true,errors,output},null,2));
}finally{for(const {ws} of peers)ws.close();await browser.close()}
