/** Optional built-game startup smoke, NOT FPS or real-device QA.
 * Needs a local built HTTP server (default port 2567), and the same external
 * browser packages/system libraries as mobileHud.browser.mjs.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(path.resolve(process.env.MOBILE_QA_MODULES || '/tmp/hud-qa/node_modules','../package.json'));
const {chromium}=require('playwright-core');
const slim=(await import(require.resolve('@sparticuz/chromium'))).default;
const browser=await chromium.launch({executablePath:await slim.executablePath(),args:slim.args,headless:true});
try {
  const context=await browser.newContext({viewport:{width:844,height:390},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  const page=await context.newPage();page.setDefaultTimeout(20000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('console',message=>{if(message.type()==='error'&&/THREE|WebGL|shader/i.test(message.text()))errors.push(message.text())});
  await page.goto(process.env.GAME_QA_URL || 'http://localhost:2567');
  await page.waitForSelector('#btn-launch-match');
  await page.selectOption('#setting-graphics','low',{force:true});
  await page.tap('#btn-launch-match');
  await page.waitForSelector('#hud-overlay:not(.hidden)');
  // Software WebGL is slow; the simulation intentionally caps dt. This is
  // a bounded functional wait, not a wall-clock timing/performance assertion.
  await page.waitForFunction(()=>document.getElementById('countdown-overlay').classList.contains('hidden'),{},{timeout:45000});
  await page.waitForFunction(()=>document.getElementById('hud-storm-phase').textContent.includes('PHASE'),{},{timeout:45000});
  // Real compiled main/GameEngine/Solo lifecycle: no room ACK or UI injection.
  await page.waitForSelector('#chat-toggle',{state:'visible'});
  const chatBounds=await page.evaluate(()=>{
    const rect=id=>{const r=document.querySelector(id).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}};
    return {chat:rect('#chat-toggle'),map:rect('.minimap-wrapper'),build:rect('#touch-build-toggle-btn')};
  });
  assert.ok(chatBounds.chat.y>=chatBounds.map.bottom);
  assert.ok(chatBounds.chat.x>=chatBounds.build.right || chatBounds.chat.y>=chatBounds.build.bottom || chatBounds.chat.bottom<=chatBounds.build.y);
  await page.tap('#chat-toggle');assert.equal(await page.locator('#chat-panel').isVisible(),true);
  assert.equal(await page.locator('#chat-send').isDisabled(),true);
  assert.match(await page.locator('#chat-status').textContent(),/Solo/);
  if(process.env.CHAT_QA_SCREENSHOT)await page.screenshot({path:process.env.CHAT_QA_SCREENSHOT});
  await page.tap('#chat-toggle');assert.equal(await page.locator('#chat-panel').isVisible(),false);
  await page.tap('#touch-build-toggle-btn');
  assert.equal(await page.locator('#touch-build-toggle-btn').getAttribute('aria-expanded'),'true');
  await page.tap('#touch-build-close-btn');
  assert.equal(await page.locator('#touch-build-toggle-btn').getAttribute('aria-expanded'),'false');
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('reduced-motion')),true);
  const info=await page.evaluate(()=>({canvas:!!document.querySelector('#game-canvas-container canvas'),
    phase:document.getElementById('hud-storm-phase').textContent,health:document.getElementById('hud-health-text').textContent,
    slots:document.querySelectorAll('[data-touch-slot]').length}));
  assert.equal(info.slots,5);assert.equal(info.canvas,true);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',mode:'built local Solo, Low preset, headless Chromium software WebGL',info,errors}));
}finally{await browser.close()}
