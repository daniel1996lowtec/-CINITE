/** Optional real-browser regression harness. No production dependencies.
 * npm install --prefix /tmp/hud-qa playwright-core @sparticuz/chromium
 * MOBILE_QA_MODULES=/tmp/hud-qa/node_modules node scripts/mobileHud.browser.mjs
 * Requires the dev server at MOBILE_QA_URL (default localhost:5173).
 * Exercises actual HTML/CSS/controllers; deliberately does not boot WebGL/game/server.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const require = createRequire(path.resolve(process.env.MOBILE_QA_MODULES || '/tmp/hud-qa/node_modules','../package.json'));
const {chromium} = require('playwright-core');
const slim = (await import(require.resolve('@sparticuz/chromium'))).default;
const browser = await chromium.launch({executablePath:await slim.executablePath(),args:slim.args,headless:true});
const sizes = [[568,320],[640,360],[800,360],[854,393],[915,412],[932,430],[1024,768],[844,390,44,21],[320,568],[360,800],[390,844]];
const results=[];
const overlap=(a,b)=>a.x<b.x+b.w-.5&&a.x+a.w>b.x+.5&&a.y<b.y+b.h-.5&&a.y+a.h>b.y+.5;
try {
  // One browser context avoids serverless Chromium's single-process context teardown limitation.
  const context=await browser.newContext({viewport:{width:568,height:320},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  const page=await context.newPage(); page.setDefaultTimeout(5000);
  await page.route('**/@vite/client*',r=>r.fulfill({body:''}));
  await page.route('**/src/main.ts*',r=>r.fulfill({body:''}));
  await page.goto(process.env.MOBILE_QA_URL || 'http://localhost:5173');
  await page.addStyleTag({url:'/src/styles/main.css'});
  await page.evaluate(async()=>{
    document.querySelectorAll('.overlay-screen').forEach(e=>e.classList.add('hidden'));
    document.querySelector('#hud-overlay').classList.remove('hidden');
    const {MobileHud}=await import('/src/ui/MobileHud.ts');
    const {MobileTouchControls}=await import('/src/input/MobileTouchControls.ts');
    for(const [id,text] of [['hud-pickup-prompt','Rare Burst Rifle · Tap LOOT'],['hud-loot-toast','Collected medium ammo'],['hud-poi-toast','Entering Aurora Heights'],['hud-elim-banner','Eliminated opponent']]) {const e=document.getElementById(id); e.textContent=text;e.classList.remove('hidden')}
    window.events=[];
    window.hud=new MobileHud(document,value=>window.sensitivity=value);
    window.controls=MobileTouchControls.fromDocument(document,{
      isGameplayActive:()=>true,onMove:(...v)=>events.push(['move',...v]),onLook:(...v)=>events.push(['look',...v]),
      setFireHeld:v=>events.push(['fire',v]),onAimToggle:()=>{events.push(['aim']);return true},setAimHeld:v=>events.push(['aimHeld',v]),
      onJump:()=>events.push(['jump']),onReload:()=>events.push(['reload']),onInteract:()=>events.push(['interact']),
      onCycleWeapon:()=>events.push(['swap']),onSelectSlot:v=>events.push(['slot',v]),onBuildPiece:v=>events.push(['build',v]),onCycleMaterial:()=>events.push(['material']),
    });
  });
  for(const [width,height,safe=0,bottomInset=0] of sizes) {
    console.log('layout',width,height);
    await page.setViewportSize({width,height});
    await page.evaluate(({safe,bottomInset})=>{
      for(const [key,value] of [['--mh-left',safe],['--mh-right',safe],['--mh-bottom',bottomInset]]) {
        if(value)document.documentElement.style.setProperty(key,`${value+8}px`);
        else document.documentElement.style.removeProperty(key);
      }
    },{safe,bottomInset});
    for(const scale of [1,.85,1.15]) for(const open of [false,true]) {
      await page.evaluate(({scale,open})=>{
        document.documentElement.style.setProperty('--mobile-button-scale',scale);
        document.documentElement.style.setProperty('--mobile-info-scale',scale===1?1:scale<1?.9:1.1);
        hud.setBuildOpen(open);
      },{scale,open});
      const layout=await page.evaluate(()=>{
        const selectors='.touch-btn,.hotbar-slot,.hud-icon-btn,.joystick-zone,.minimap-wrapper,.storm-banner,.hud-bottom-left,.active-ammo-card,.materials-card,.hud-compass-pill,.counter-pill,#hud-pickup-prompt,#hud-loot-toast,#hud-poi-toast,#hud-elim-banner';
        const rect=e=>{const r=e.getBoundingClientRect();return {id:e.id||e.className,x:r.x,y:r.y,w:r.width,h:r.height}};
        return {items:[...document.querySelectorAll(selectors)].map(rect).filter(r=>r.w&&r.h),cross:rect(document.querySelector('#hud-crosshair')),
          joystick:rect(document.querySelector('.joystick-zone')),actions:rect(document.querySelector('.touch-action-buttons'))};
      });
      const label=`${width}x${height} scale=${scale} build=${open}`;
      for(const r of layout.items) {
        assert.ok(r.x>=-.5&&r.y>=-.5&&r.x+r.w<=width+.5&&r.y+r.h<=height+.5,`${label}: outside viewport ${JSON.stringify(r)}`);
        assert.ok(!overlap(r,layout.cross),`${label}: crosshair blocked by ${r.id}`);
        if(r.id.startsWith('touch-')&&!r.id.includes('joystick')||r.id.startsWith('hotbar-slot')) assert.ok(r.w>=43.9&&r.h>=43.9,`${label}: target <44px ${r.id}`);
      }
      for(let i=0;i<layout.items.length;i++) for(let j=i+1;j<layout.items.length;j++) assert.ok(!overlap(layout.items[i],layout.items[j]),`${label}: overlap ${layout.items[i].id} / ${layout.items[j].id}`);
      assert.ok(Math.abs(layout.cross.x+layout.cross.w/2-width/2)<.1&&Math.abs(layout.cross.y+layout.cross.h/2-height/2)<.1,`${label}: reticle not centered`);
      if(scale===1&&!open&&width>height) {
        const clear=(layout.actions.x-layout.joystick.x-layout.joystick.w)/width;
        assert.ok(clear>=.6,`${label}: central horizontal lane below 60%`);
        results.push({viewport:`${width}x${height}${safe?' (safe insets)':''}`,clearLanePercent:Math.round(clear*1000)/10});
      }
    }
  }
  // Notch/browser-bar simulation using the same CSS custom-property inset entry points.
  await page.setViewportSize({width:844,height:390});
  await page.evaluate(()=>{document.documentElement.style.setProperty('--mh-left','52px');document.documentElement.style.setProperty('--mh-right','52px');document.documentElement.style.setProperty('--mh-bottom','29px');hud.setBuildOpen(false)});
  const inset=await page.locator('.touch-action-buttons').boundingBox();assert.ok(inset.x+inset.width<=792);
  await page.evaluate(()=>{for(const key of ['--mh-left','--mh-right','--mh-bottom'])document.documentElement.style.removeProperty(key)});
  console.log('layout cases passed; input checks');
  // Browser-dispatched pointer streams through the actual controller. Move+look+fire independent.
  const pointer=async(id,type,pointerId,dx=0,dy=0)=>page.evaluate(({id,type,pointerId,dx,dy})=>{
    const e=document.getElementById(id),r=e.getBoundingClientRect();
    e.dispatchEvent(new PointerEvent(type,{pointerType:'touch',pointerId,clientX:r.x+r.width/2+dx,clientY:r.y+r.height/2+dy,bubbles:true,cancelable:true}));
  },{id,type,pointerId,dx,dy});
  await pointer('touch-joystick-zone','pointerdown',1,0,-28);
  await pointer('touch-look-surface','pointerdown',2);
  await pointer('touch-look-surface','pointermove',2,20,-10);
  await pointer('touch-fire-btn','pointerdown',3);
  await pointer('touch-fire-btn','pointerup',3);
  for(const [index,id] of ['aim','jump','reload','loot','weapon'].entries()) {
    await pointer(`touch-${id}-btn`,'pointerdown',index+4);await pointer(`touch-${id}-btn`,'pointerup',index+4);
  }
  for(let i=0;i<5;i++){await pointer(`hotbar-slot-${i}`,'pointerdown',20+i);await pointer(`hotbar-slot-${i}`,'pointerup',20+i)}
  const looks=await page.evaluate(()=>events.filter(e=>e[0]==='look').length);
  await page.tap('#touch-build-toggle-btn');
  for(const [index,id] of ['wall','ramp','floor','roof','material'].entries()) {
    await pointer(`touch-${id}-btn`,'pointerdown',30+index);await pointer(`touch-${id}-btn`,'pointerup',30+index);
  }
  await page.tap('#touch-build-close-btn');
  assert.equal(await page.evaluate(()=>events.filter(e=>e[0]==='look').length),looks,'HUD taps rotated camera');
  await pointer('touch-joystick-zone','pointercancel',1);
  await pointer('touch-look-surface','pointercancel',2);
  const events=await page.evaluate(()=>window.events);
  for(const action of ['move','look','fire','aim','jump','reload','interact','swap','slot','build','material']) assert.ok(events.some(e=>e[0]===action),`missing ${action}`);
  assert.deepEqual(events.filter(e=>e[0]==='slot').map(e=>e[1]),[0,1,2,3,4]);
  assert.deepEqual(events.filter(e=>e[0]==='build').map(e=>e[1]),['wall','ramp','floor','roof']);
  assert.deepEqual(events.filter(e=>e[0]==='fire').slice(-2),[['fire',true],['fire',false]]);
  assert.deepEqual(events.filter(e=>e[0]==='move').at(-1),['move',0,0,false]);
  // Crosshair does not move when simultaneous status/pickup messages appear.
  await page.evaluate(()=>['hud-reload-banner','hud-pickup-prompt','hud-loot-toast'].forEach(id=>document.getElementById(id).classList.remove('hidden')));
  const cross=await page.locator('#hud-crosshair').boundingBox();assert.equal(cross.x+cross.width/2,422);assert.equal(cross.y+cross.height/2,195);
  await page.evaluate(()=>{controls.destroy();hud.destroy()});
  const before=await page.evaluate(()=>events.length);await pointer('touch-fire-btn','pointerdown',99);assert.equal(await page.evaluate(()=>events.length),before,'disposed input listener retained');
  const desktop=await browser.newContext({hasTouch:false,isMobile:false});
  const desk=await desktop.newPage();
  const baselineHtml=execFileSync('git',['show','4e4b9b3:index.html'],{encoding:'utf8'});
  const baselineCss=execFileSync('git',['show','4e4b9b3:src/styles/main.css'],{encoding:'utf8'});
  for(const [width,height] of [[1440,900],[800,600]]) {
    await desk.setViewportSize({width,height});const snapshots=[];
    for(const [html,css] of [[baselineHtml,baselineCss],[fs.readFileSync('index.html','utf8'),fs.readFileSync('src/styles/main.css','utf8')]]) {
      await desk.setContent(html.replace(/<script[\s\S]*?<\/script>/g,'').replace('</head>',`<style>${css}</style></head>`));
      snapshots.push(await desk.evaluate(()=>{
        document.querySelectorAll('.overlay-screen').forEach(e=>e.classList.add('hidden'));
        document.getElementById('hud-overlay').classList.remove('hidden');
        return [...document.querySelectorAll('.hud-top-left,.hud-top-right,.hud-bottom-left,.hud-bottom-right,.joystick-zone,.touch-btn,#hud-crosshair')]
          .map(e=>{const r=e.getBoundingClientRect();return [e.id||e.className,r.x,r.y,r.width,r.height]})
          .filter(r=>r[3]&&r[4]);
      }));
    }
    assert.deepEqual(snapshots[1],snapshots[0],`desktop geometry changed at ${width}x${height}`);
  }
  console.log('Desktop 1440x900 and narrow 800x600: identical to 3.3');
  console.log(JSON.stringify({layoutCases:sizes.length*6,results,input:'all actions, independent pointers, cancellation, panel isolation, cleanup PASS'},null,2));
} finally {await browser.close()}
