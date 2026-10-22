/** Real Vite game + local production server, with read-only engine exposure.
 * Run both servers, install optional browser QA dependencies outside this repo,
 * then set MOBILE_QA_MODULES (and optionally GAME_QA_URL/GAMEPLAY41_OUTPUT).
 * One rendered touch browser + three authenticated protocol peers; not device QA.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(path.resolve(process.env.MOBILE_QA_MODULES||'/tmp/hud-qa/node_modules','../package.json'));
const {chromium}=require('playwright-core');
const slim=(await import(require.resolve('@sparticuz/chromium'))).default;
const base=process.env.GAME_QA_URL||'http://localhost:5173';
const output=process.env.GAMEPLAY41_OUTPUT||'/home/user/gameplay41-evidence';fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({executablePath:await slim.executablePath(),args:slim.args,headless:true});
const peers=[];
const wait=(ws,type)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.removeEventListener('message',handler);reject(Error(`Timeout: ${type}`))},type==='match_started'?60000:15000);
  const handler=e=>{const msg=JSON.parse(e.data);if(msg.type===type){clearTimeout(timer);ws.removeEventListener('message',handler);resolve(msg)}};
  ws.addEventListener('message',handler);
});
const request=async(ws,payload,type)=>{const result=wait(ws,type);ws.send(JSON.stringify(payload));return result};
try {
  const context=await browser.newContext({viewport:{width:844,height:390},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  const page=await context.newPage();page.setDefaultTimeout(30000);
  const errors=[],chatPackets=[],socketURLs=[],scripts=[],sent=[],received=[];
  // Read-only test access to the real running engine. No paused RAF, forged
  // inventory, position writes, mocked WebSocket, or synthetic game callbacks.
  await page.route('**/src/main.ts*',async route=>{
    const response=await route.fetch();let body=await response.text();
    assert.ok(body.includes('const engine = new GameEngine(container);'));
    body=body.replace('const engine = new GameEngine(container);','const engine = new GameEngine(container); window.__gameplay41 = engine;');
    await route.fulfill({response,body});
  });
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&/THREE|WebGL|shader/i.test(m.text()))errors.push(m.text())});
  page.on('request',r=>{if(r.resourceType()==='script')scripts.push(r.url())});
  page.on('websocket',ws=>{
    socketURLs.push(ws.url());
    ws.on('framesent',({payload})=>{try{sent.push(JSON.parse(String(payload)))}catch{}});
    ws.on('framereceived',({payload})=>{try{received.push(JSON.parse(String(payload)))}catch{}});
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

  for(let i=0;i<3;i++){
    const name=i===2?'ChatPeer0':`ChatPeer${i}`;
    const res=await fetch(`${base}/api/account/init`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callsign:name})});
    assert.equal(res.status,200);const account=await res.json();
    const ws=new WebSocket(base.replace(/^http/,'ws')+'/ws'),messages=[];
    peers.push({ws,messages});ws.addEventListener('message',e=>{const m=JSON.parse(e.data);messages.push(m)});
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
    const credentials={accountId:account.accountId,accountToken:account.accountToken};
    let roomCode=code;
    await request(ws,{type:'join_room',...credentials,playerName:name,roomCode,roomMode:'human_only_public',purpose:'lobby',joinIntent:'join_existing',sessionToken:`sess_chatfix_${Date.now()}_${i}`},'room_joined');
  }
  await page.waitForSelector('.duplicate-name-warning');
  assert.match(await page.locator('.duplicate-name-warning').textContent(),/Names are not identity/);
  assert.equal(await page.locator('.my-lobby-player-name').filter({hasText:'ChatPeer0'}).count(),2);
  await page.click('#btn-my-lobby-ready');
  for(const {ws} of peers.slice(0,3))await request(ws,{type:'set_ready',ready:true},'room_state');
  await page.waitForFunction(()=>!document.getElementById('btn-my-lobby-start').disabled);
  const starts=peers.slice(0,3).map(({ws})=>wait(ws,'match_started'));
  console.log('Four authenticated peers ready; starting through real UI');
  await page.click('#btn-my-lobby-start');
  for(const state of await Promise.all(starts)){assert.equal(state.matchParticipantCount,4);assert.equal(state.botCount,0)}
  await page.waitForSelector('#hud-overlay:not(.hidden)',{timeout:60000});
  await page.waitForFunction(()=>document.getElementById('countdown-overlay').classList.contains('hidden'),{},{timeout:120000});

  await page.waitForFunction(()=>window.__gameplay41?.isRunningMatch);
  // Steer out of the tower's random deployment footprint through actual input.
  await page.keyboard.down('d');
  await page.waitForFunction(()=>{const e=window.__gameplay41;return e.network.state.players.get(e.network.localPlayerId).position.x>60},null,{timeout:120000});
  await page.keyboard.up('d');
  await page.waitForFunction(()=>{const e=window.__gameplay41,p=e.network.state.players.get(e.network.localPlayerId);return p?.isGrounded&&!p.isGliding},null,{timeout:180000});
  console.log('Natural landing',await page.evaluate(()=>{const e=window.__gameplay41,p=e.network.state.players.get(e.network.localPlayerId);return {position:p.position,materials:p.materials}}));
  // A real random spawn can face a tower wall. Turn/move through real input if
  // needed, never relocate the player or bypass placement validation.
  for(let attempt=0;attempt<24;attempt++){
    if(await page.evaluate(()=>{const e=window.__gameplay41,p=e.network.state.players.get(e.network.localPlayerId);return p.isGrounded&&['wall','floor','ramp','roof'].every(t=>e.world.validateBuildPlacement(t,p.position.x,p.position.y,p.position.z,p.yaw))}))break;
    await page.keyboard.down('d');await delay(800);await page.keyboard.up('d');
  }
  const before=await page.evaluate(()=>{const e=window.__gameplay41;return e.network.state.players.get(e.network.localPlayerId).materials.wood});
  await page.locator('#touch-build-toggle-btn').tap();
  for(const piece of ['wall','floor','ramp','roof']) {
    const requests=sent.filter(m=>m.type==='place_build').length;
    await page.locator(`#touch-${piece}-btn`).tap();
    await page.waitForFunction(t=>window.__gameplay41.activeBuildPreview===t,piece);
    await delay(250);assert.equal(sent.filter(m=>m.type==='place_build').length,requests,'selection alone must not place');
    await page.locator(`#touch-${piece}-btn`).tap();
    await page.waitForFunction(t=>{const e=window.__gameplay41;return [...e.network.state.buildables.values()].some(b=>b.pieceType===t)},piece).catch(async error=>{
      console.log('Placement diagnostic',piece,sent.filter(m=>m.type==='place_build'),received.filter(m=>m.type.startsWith('build_')),await page.evaluate(()=>{const e=window.__gameplay41,p=e.network.state.players.get(e.network.localPlayerId);return {position:p.position,preview:e.activeBuildPreview,pending:e.pendingBuild,phase:e.network.state.phase,alive:p.alive,materials:p.materials,grounded:p.isGrounded,online:e.network.isOnlineRoom,connected:e.network.roomConnected,buildables:[...e.network.state.buildables.values()],toast:document.querySelector('.loot-toast')?.textContent}}));
      await page.screenshot({path:path.join(output,'failure.png')});throw error;
    });
    const event=received.find(m=>m.type==='build_placed'&&m.pieceType===piece);assert.ok(event);
    assert.equal(sent.filter(m=>m.type==='place_build').length,requests+1,'one confirmation produces one request');
    assert.ok(peers.every(({messages})=>messages.some(m=>m.type==='build_placed'&&m.buildId===event.buildId)));
    assert.ok(await page.evaluate(id=>{const e=window.__gameplay41,p=e.world.destructibles.get(id);return p?.mesh.parent&&e.network.state.buildables.has(id)&&(e.world.boxColliders.some(c=>c.destructibleId===id)||e.world.walkableSurfaces.some(s=>s.id===id))},event.buildId));
  }
  await page.waitForFunction(amount=>{const e=window.__gameplay41;return e.network.state.players.get(e.network.localPlayerId).materials.wood===amount},before-40);
  await page.setViewportSize({width:390,height:844});
  await page.locator('#btn-mobile-portrait-continue').tap();
  await page.locator('#touch-floor-btn').tap();await page.locator('#touch-floor-btn').tap();
  await page.waitForFunction(()=>window.__gameplay41.activeBuildPreview==='floor'&&window.__gameplay41.pendingBuild===null);
  assert.equal(sent.filter(m=>m.type==='place_build').length,4,'occupied cell creates no duplicate');
  assert.equal(await page.evaluate(()=>window.__gameplay41.activeBuildPreview),'floor','rejection retains preview');
  await page.keyboard.down('q');await page.keyboard.down('q');await page.keyboard.up('q');
  assert.equal(await page.evaluate(()=>window.__gameplay41.activeBuildPreview),'wall');
  assert.equal(sent.filter(m=>m.type==='place_build').length,4,'key repeat does not confirm');
  await page.locator('#touch-build-close-btn').tap();
  await page.locator('#chat-toggle').tap();
  await page.locator('#chat-input').fill('qqccvv');
  await page.locator('#chat-input').press('q');
  assert.equal(await page.evaluate(()=>window.__gameplay41.activeBuildPreview),'wall','chat typing does not select builds');
  await page.screenshot({path:path.join(output,'builds-portrait.png')});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'gameplay41-browser.json'),JSON.stringify({scope:'Real dev game with read-only engine exposure; one rendered touch browser plus three authenticated protocol peers',pieces:4,requests:sent.filter(m=>m.type==='place_build'),accepted:received.filter(m=>m.type==='build_placed'),errors},null,2));
  console.log('PASS: natural landing, all four owner meshes/collisions, four-human acceptance, single debit, touch selection/confirmation, portrait rejection, keyboard repeat, chat isolation');
} finally {for(const {ws} of peers)ws.close();await browser.close()}
