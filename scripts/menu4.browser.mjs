/** Actual compiled app/routes and live local account API. No app/source mocks. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
const require=createRequire(path.resolve(process.env.MOBILE_QA_MODULES||'/tmp/hud-qa/node_modules','../package.json'));
const {chromium}=require('playwright-core');
const slim=(await import(require.resolve('@sparticuz/chromium'))).default;
const browser=await chromium.launch({executablePath:await slim.executablePath(),args:slim.args,headless:true});
const output=process.env.UI4_QA_OUTPUT||'/tmp/ci-ui4';fs.mkdirSync(output,{recursive:true});
const base=process.env.GAME_QA_URL||'http://localhost:2567';
try {
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
 const page=await context.newPage();page.setDefaultTimeout(60000);
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForSelector('#menu-profile input');
 await page.selectOption('#setting-graphics','low',{force:true});
 assert.equal(await page.locator('#solo-session-controls').isVisible(),false);
 assert.equal(await page.locator('#multiplayer-browser').isVisible(),false);
 const initial=await page.inputValue('#lobby-player-name');assert.match(initial,/^Pilot_/);
 await page.fill('#lobby-player-name','   ');await page.click('#btn-save-name');
 await page.waitForSelector('#lobby-player-name[aria-invalid="true"]');
 await page.click('#btn-mode-solo');await page.click('#btn-launch-match');
 assert.equal(await page.locator('#hud-overlay').isVisible(),false,'blank name cannot enter a match');
 await page.click('#menu-back');
 await page.fill('#lobby-player-name','  Mobile_Alice  ');await page.click('#btn-save-name');
 await page.waitForFunction(()=>document.getElementById('name-status').textContent.includes('saved to your account'));
 assert.equal(await page.inputValue('#lobby-player-name'),'Mobile_Alice');
 await page.reload();await page.waitForFunction(()=>document.getElementById('lobby-player-name').value==='Mobile_Alice');
 const fits=async (label,selector='#lobby-overlay > .lobby-card')=>{
   const layout=await page.evaluate(selector=>{
    const root=document.querySelector(selector),r=root.getBoundingClientRect();
    const outside=[...root.querySelectorAll('*')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').map(e=>({id:e.id||e.className,r:e.getBoundingClientRect()})).filter(({r})=>r.width>0&&(r.left<-.6||r.right>innerWidth+.6)).map(({id,r})=>({id,left:r.left,right:r.right}));
    return {overflow:document.documentElement.scrollWidth>innerWidth,top:r.top,bottom:r.bottom,height:innerHeight,outside};
   },selector);
   assert.equal(layout.overflow,false,label+' page overflow');
   assert.ok(layout.top>=0&&layout.bottom<=layout.height+.5,label+' card clipped');
   assert.deepEqual(layout.outside,[],label+' horizontal clipping');
 };
 let cases=0;
 for(const [width,height] of [[320,568],[360,640],[390,844],[568,320],[844,390],[932,430],[1280,800]]) {
  console.log(`Menu viewport ${width}x${height}`);
  await page.setViewportSize({width,height});await fits(`${width} home`);cases++;
  await page.click('#btn-mode-solo');assert.equal(await page.locator('#solo-session-controls').isVisible(),true);assert.equal(await page.locator('#multiplayer-browser').isVisible(),false);
  await fits(`${width} solo`);cases++;await page.click('#menu-back');
  await page.click('#btn-mode-online');await page.waitForSelector('#multiplayer-browser');assert.equal(await page.locator('#solo-session-controls').isVisible(),false);
  await fits(`${width} browse`);cases++;
  await page.click('#btn-browser-create');await fits(`${width} create`);cases++;
  await page.click('#menu-back');await page.click('#btn-menu-account');await fits(`${width} account`);cases++;
  await page.click('#menu-back');
  await page.click('#btn-open-settings-lobby');await fits(`${width} settings`,'#settings-overlay .end-card');cases++;await page.click('[data-menu-close="btn-close-settings"]');
  await page.click('#btn-open-locker');await fits(`${width} locker`,'#locker-overlay .lobby-card');cases++;
  if(width===390)await page.screenshot({timeout:120000,path:path.join(output,'locker-portrait.png')});
  await page.click('#btn-close-locker');
  await page.click('#btn-open-howto');await fits(`${width} help`,'#howto-overlay .end-card');cases++;await page.click('[data-menu-close="btn-close-howto"]');
  if(width===390||width===844)await page.screenshot({timeout:120000,path:path.join(output,`menu-${width}x${height}.png`)});
 }
 // Keyboard space emulation: real browser keyboards still require device QA.
 await page.setViewportSize({width:390,height:300});await page.focus('#lobby-player-name');await fits('keyboard resize');cases++;
 await page.setViewportSize({width:390,height:844});
 await page.click('#btn-open-settings-lobby');assert.equal(await page.locator('#settings-overlay').isVisible(),true);
 await page.click('[data-menu-close="btn-close-settings"]');await page.click('#btn-open-locker');
 assert.equal(await page.locator('#locker-overlay').isVisible(),true);
 await page.click('#btn-close-locker');await page.click('#btn-open-howto');
 assert.equal(await page.locator('#howto-overlay').isVisible(),true);await page.click('[data-menu-close="btn-close-howto"]');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'PASS',cases,actualCompiledMenu:true,namePersistence:true,errors,output},null,2));
}finally{await browser.close()}
