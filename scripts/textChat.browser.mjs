/** Optional actual-main DOM/input chat QA. Uses external browser packages like
 * mobileHud.browser.mjs. The real engine is constructed; only RAF and chat send
 * are controlled in this harness. Server delivery is tested separately over real WS.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(path.resolve(process.env.MOBILE_QA_MODULES||'/tmp/hud-qa/node_modules','../package.json'));
const {chromium}=require('playwright-core');
const slim=(await import(require.resolve('@sparticuz/chromium'))).default;
const browser=await chromium.launch({executablePath:await slim.executablePath(),args:slim.args,headless:true});
const overlap=(a,b)=>a.x<b.x+b.w-.5&&a.x+a.w>b.x+.5&&a.y<b.y+b.h-.5&&a.y+a.h>b.y+.5;
try {
  const context=await browser.newContext({viewport:{width:844,height:390},hasTouch:true,isMobile:true});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const instrument = async page => {
  await page.route('**/src/main.ts*',async route=>{
    const response=await route.fetch();let body=await response.text();
    assert.ok(body.includes('const engine = new GameEngine(container);'));
    body=body.replace('const engine = new GameEngine(container);','const engine = new GameEngine(container); window.chatQAEngine=engine; engine.animate=()=>{};');
    body=body.replace(/window\.addEventListener\((["'])pagehide\1/,'window.chatQA=textChat; window.addEventListener("pagehide"');
    await route.fulfill({response,body});
  });
  };
  await instrument(page);
  await page.goto(process.env.MOBILE_QA_URL||'http://localhost:5173');
  await page.waitForFunction(()=>!!window.chatQA).catch(error=>{throw new Error(`${error.message}; page errors: ${JSON.stringify(errors)}`)});
  assert.equal(await page.locator('#text-chat').isVisible(),false,'offline main menu stays uncluttered');
  await page.evaluate(()=>document.getElementById('hud-overlay').classList.remove('hidden'));
  await page.waitForSelector('#chat-toggle',{state:'visible'});
  await page.click('#chat-toggle');
  assert.equal(await page.locator('#chat-panel').isVisible(),true);
  assert.equal(await page.locator('#chat-send').isDisabled(),true);
  assert.equal(await page.locator('#chat-input').isDisabled(),true);
  assert.match(await page.locator('#chat-status').textContent(),/Solo/);
  await page.click('#chat-toggle');
  await page.evaluate(()=>{
    document.querySelectorAll('.overlay-screen').forEach(e=>e.classList.add('hidden'));
    document.getElementById('hud-overlay').classList.remove('hidden');
    chatQAEngine.isRunningMatch=true;chatQAEngine.isPaused=false;
    window.sent=[];chatQAEngine.network.sendChat=text=>{sent.push(text);return true};
    chatQAEngine.network.textChat.joined('QA-LOBBY');
    window.deliver=(id,text='hello')=>chatQAEngine.network.textChat.receive({type:'chat_message',roomCode:'QA-LOBBY',id,senderId:'other',senderName:'<svg onload=alert(1)>',text,sentAt:1});
    deliver('one','<img src=x onerror=alert(1)> & hello');
  });
  assert.equal(await page.locator('#chat-unread').textContent(),'1');
  await page.click('#chat-toggle');assert.equal(await page.locator('#chat-toggle').getAttribute('aria-expanded'),'true');
  assert.equal(await page.locator('#chat-unread').isVisible(),false);
  assert.equal(await page.locator('#chat-log img,#chat-log svg,#chat-log script').count(),0);
  assert.match(await page.locator('#chat-log').textContent(),/<img src=x onerror=alert\(1\)>/);
  await page.evaluate(()=>{chatQAEngine.keys.add('KeyW');chatQAEngine.mouseFireHeld=true});
  await page.focus('#chat-input');await page.keyboard.type('w1qerm');
  const inputState=await page.evaluate(()=>({focus:document.activeElement.id,keys:[...chatQAEngine.keys],fire:chatQAEngine.mouseFireHeld,slot:chatQAEngine.pendingSlotSelect,build:chatQAEngine.pendingBuild,reload:chatQAEngine.pendingReload}));
  assert.deepEqual(inputState,{focus:'chat-input',keys:[],fire:false,slot:-1,build:null,reload:false});
  await page.keyboard.press('Enter');assert.deepEqual(await page.evaluate(()=>sent),['w1qerm']);
  await page.fill('#chat-input','IME');await page.evaluate(()=>document.getElementById('chat-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true,cancelable:true})));
  assert.equal(await page.evaluate(()=>sent.length),1);
  await page.click('#chat-send');assert.deepEqual(await page.evaluate(()=>sent),['w1qerm','IME']);
  await page.fill('#chat-input','not from elsewhere');await page.focus('#chat-send');await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>sent.length),2);
  await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>sent.length),2);
  await page.keyboard.press('KeyT');assert.equal(await page.evaluate(()=>document.activeElement.id),'chat-input');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#chat-toggle').getAttribute('aria-expanded'),'false');assert.equal(await page.evaluate(()=>chatQAEngine.isPaused),false);
  // Closing chat must return keyboard movement without an extra canvas click.
  await page.keyboard.down('KeyW');assert.equal(await page.evaluate(()=>chatQAEngine.keys.has('KeyW')),true);
  await page.keyboard.up('KeyW');assert.equal(await page.evaluate(()=>chatQAEngine.keys.has('KeyW')),false);
  await page.evaluate(()=>{chatQAEngine.pendingSlotSelect=-1;document.getElementById('chat-log').dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true}))});
  assert.equal(await page.evaluate(()=>chatQAEngine.pendingSlotSelect),-1);
  await page.evaluate(()=>{chatQA.open();for(let i=0;i<125;i++)deliver(`bounded-${i}`)});assert.equal(await page.locator('#chat-log li').count(),100);
  const cases=[[568,320],[640,360],[800,360],[854,393],[915,412],[932,430],[1024,768],[844,390,44,21]];
  let layoutCases=0;
  for(const [width,height,safe=0,bottom=0] of cases) {
    await page.setViewportSize({width,height});
    for(const scale of [.85,1,1.15])for(const opened of [false,true])for(const build of [false,true]){
      await page.evaluate(({scale,opened,build,safe,bottom})=>{
        const root=document.documentElement;
        for(const [key,val] of [['--mh-left',safe],['--mh-right',safe],['--mh-bottom',bottom]])root.style.setProperty(key,`${val+8}px`);
        root.style.setProperty('--mobile-button-scale',String(scale));root.style.setProperty('--mobile-info-scale',String(scale));
        const toggle=document.getElementById('touch-build-toggle-btn');
        if((toggle.getAttribute('aria-expanded')==='true')!==build)toggle.click();
        opened?chatQA.open():chatQA.close();
        document.getElementById('chat-status').textContent='Slow down: 5 messages per 10 seconds.';
      },{scale,opened,build,safe,bottom});
      await page.evaluate(()=>new Promise(requestAnimationFrame));
      const bounds=await page.evaluate(()=>{
        const rect=e=>{const r=e.getBoundingClientRect();return {id:e.id||e.className,x:r.x,y:r.y,w:r.width,h:r.height}};
        const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
        return {minimap:rect(document.querySelector('.minimap-wrapper')),chat:rect(document.getElementById('text-chat')),controls:[...document.querySelectorAll('.minimap-wrapper,.storm-banner,.hud-compass-pill,.hud-bottom-left,.hud-top-right,.touch-btn,.joystick-zone,.hotbar-slot,#hud-crosshair,.materials-card,.active-ammo-card')].filter(visible).map(rect),
          targets:[...document.querySelectorAll('#chat-toggle,#chat-input,#chat-send')].filter(visible).map(rect)};
      });
      const label=`${width}x${height} scale=${scale} open=${opened} build=${build}`,r=bounds.chat;
      assert.ok(r.x>=0&&r.y>=0&&r.x+r.w<=width+.5&&r.y+r.h<=height+.5,`${label}: bounds ${JSON.stringify(r)}`);
      assert.ok(r.y>=bounds.minimap.y+bounds.minimap.h,`${label}: CHAT must be below minimap`);
      for(const c of bounds.controls)assert.ok(!overlap(r,c),`${label}: overlaps ${JSON.stringify(c)}`);
      for(const target of bounds.targets)assert.ok(target.w>=44&&target.h>=44,`${label}: small ${target.id}`);
      layoutCases++;
    }
  }
  // Narrow visual viewport while composing: send/input stay reachable; this is
  // resize emulation, not a claim of testing a physical OS software keyboard.
  await page.setViewportSize({width:844,height:190});await page.evaluate(()=>chatQA.open());
  const fits=await page.locator('#chat-send').evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight);assert.equal(fits,true);
  await page.evaluate(()=>{chatQAEngine.network.isOnlineRoom=true;chatQAEngine.network.textChat.reset()});
  assert.equal(await page.locator('#chat-toggle').isVisible(),true,'reconnect must not erase the control');
  assert.equal(await page.locator('#chat-input').isDisabled(),true);
  assert.equal(await page.locator('#chat-send').isDisabled(),true);
  assert.match(await page.locator('#chat-status').textContent(),/reconnect/);
  await page.evaluate(()=>chatQAEngine.network.textChat.joined('QA-LOBBY'));
  assert.equal(await page.locator('#chat-input').isEnabled(),true);
  const cleanup=await page.evaluate(()=>{
    const channel=chatQAEngine.network.textChat;
    for(let i=0;i<5;i++){channel.reset();channel.joined('QA-LOBBY')}
    deliver('fresh');const rows=document.querySelectorAll('#chat-log li').length;
    const subscribers=channel.listeners.size;channel.reset();const hidden=document.getElementById('text-chat').hidden;
    const cleared=document.querySelectorAll('#chat-log li').length===0;chatQA.destroy();chatQA.destroy();
    channel.joined('QA-LOBBY');deliver('after-destroy');
    return {rows,subscribers,hidden,cleared,after:channel.listeners.size,rowsAfter:document.querySelectorAll('#chat-log li').length};
  });
  assert.deepEqual(cleanup,{rows:1,subscribers:1,hidden:false,cleared:true,after:0,rowsAfter:0});
  await page.evaluate(()=>{document.getElementById('hud-overlay').classList.add('hidden');window.dispatchEvent(new Event('resize'))});
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  await page.evaluate(()=>document.getElementById('hud-overlay').classList.remove('hidden'));
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  assert.equal(await page.locator('#text-chat').isVisible(),false,'destroyed observers must not remount chat');
  const desktop=await browser.newContext({viewport:{width:1440,height:900}});
  const desktopPage=await desktop.newPage();desktopPage.on('pageerror',e=>errors.push(e.message));
  await instrument(desktopPage);await desktopPage.goto(process.env.MOBILE_QA_URL||'http://localhost:5173');
  await desktopPage.waitForFunction(()=>!!window.chatQA);
  await desktopPage.evaluate(()=>{
    document.querySelectorAll('.overlay-screen').forEach(e=>e.classList.add('hidden'));
    document.getElementById('hud-overlay').classList.remove('hidden');
    chatQAEngine.network.textChat.joined('DESKTOP-QA');chatQA.open();
  });
  for(const [width,height] of [[1440,900],[800,600]]){
    await desktopPage.setViewportSize({width,height});
    await desktopPage.evaluate(()=>new Promise(requestAnimationFrame));
    const items=await desktopPage.evaluate(()=>{
      const rect=e=>{const r=e.getBoundingClientRect();return {id:e.id||e.className,x:r.x,y:r.y,w:r.width,h:r.height}};
      return {chat:rect(document.getElementById('text-chat')),controls:[...document.querySelectorAll('.minimap-wrapper,.storm-banner,.hud-compass-pill,.hud-bottom-left,.hud-top-right,.hotbar-slot,#hud-crosshair')].map(rect)};
    });
    for(const c of items.controls)assert.ok(!overlap(items.chat,c),`desktop ${width}: overlap ${JSON.stringify({chat:items.chat,control:c})}`);
    assert.ok(items.chat.x+items.chat.w<=width&&items.chat.y+items.chat.h<=height);
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',layoutCases,desktopCases:2,input:'actual main handlers: typing isolation, T, focused Enter, IME, Escape, button, unread, safe DOM, bounded history and cleanup',errors},null,2));
}finally{await browser.close()}
