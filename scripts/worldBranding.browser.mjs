/** Optional 3.6 actual-GameEngine WebGL visual/compatibility checks.
 * Same external browser prerequisites as mobileHud.browser.mjs. No shipped QA
 * route or alternate/demo world: instantiate the real engine, pause only its
 * RAF callback in this test, and inspect its generated island at fixed cameras.
 * This is software Chromium, NOT real-device/FPS or multiplayer playthrough QA.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require=createRequire(path.resolve(process.env.MOBILE_QA_MODULES||'/tmp/hud-qa/node_modules','../package.json'));
const {chromium}=require('playwright-core');
const slim=(await import(require.resolve('@sparticuz/chromium'))).default;
const output=process.env.BRANDING_QA_OUTPUT||'/tmp/cinite-branding36';fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({executablePath:await slim.executablePath(),args:slim.args,headless:true});
try {
  const context=await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:1,reducedMotion:'reduce'});
  const page=await context.newPage();page.setDefaultTimeout(60000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&/THREE|WebGL|shader/i.test(m.text()))errors.push(m.text())});
  await page.route('**/@vite/client*',r=>r.fulfill({body:''}));
  await page.route('**/src/main.ts*',r=>r.fulfill({body:''}));
  await page.goto(process.env.MOBILE_QA_URL||'http://localhost:5173');
  await page.addStyleTag({content:'.overlay-screen,#hud-overlay,#mobile-landscape-prompt{display:none!important}'});
  const info=await page.evaluate(async()=>{
    const {GameEngine}=await import('/src/core/GameEngine.ts');
    const {BUILDING_BRANDING,ROAD_BRANDING}=await import('/src/world/WorldBrandingLayout.ts');
    window.engine=new GameEngine(document.getElementById('game-canvas-container'));
    engine.animate=()=>{}; // Prevent background QA frames; production RAF is unchanged.
    engine.applySettings({graphicsQuality:'low',reducedMotion:true});
    engine.lobbyPreviewGroup.visible=false;
    window.brandingSigns=BUILDING_BRANDING;window.brandingRoads=ROAD_BRANDING;
    const atlas=engine.world.branding.group.children[0].material.map;
    return {atlas:atlas.image.toDataURL(),maxTextureSize:engine.renderer.capabilities.maxTextureSize,
      atlasSize:[atlas.image.width,atlas.image.height],signs:BUILDING_BRANDING.length};
  });
  assert.ok(info.maxTextureSize>=1024);assert.deepEqual(info.atlasSize,[1024,1024]);assert.equal(info.signs,26);
  fs.writeFileSync(path.join(output,'atlas.png'),Buffer.from(info.atlas.split(',')[1],'base64'));
  const cases=[
    {name:'street-desktop-high',width:1280,height:720,quality:'high',id:'aurora_northeast_tower_street_entry',x:97,z:9},
    {name:'street-mobile-low',width:844,height:390,quality:'low',id:'aurora_northeast_tower_street_entry',x:97,z:7},
    {name:'market-mobile-low',width:844,height:390,quality:'low',id:'plaza_market_market',x:16,z:4},
    {name:'tower-desktop-high',width:1280,height:720,quality:'high',id:'legendary_tower_south_name',x:0,z:28},
    {name:'paint-desktop-high',width:1280,height:720,quality:'high',id:'crag_harbor_warehouse_paint',x:130,z:44},
    {name:'road-south-mobile-low',width:844,height:390,quality:'low',road:'ci_street_south',x:97,z:0},
    {name:'road-north-mobile-low',width:844,height:390,quality:'low',road:'ci_street_north',x:97,z:-66},
    {name:'street-north-mobile-low',width:844,height:390,quality:'low',id:'aurora_exchange_street_entry',x:103,z:-85},
  ];
  const results=[];
  for(const item of cases) {
    await page.setViewportSize({width:item.width,height:item.height});
    const result=await page.evaluate(item=>{
      const e=engine,camera=e.tpCamera.camera;
      const s=item.road?brandingRoads.find(s=>s.id===item.road):brandingSigns.find(s=>s.id===item.id);
      e.applySettings({graphicsQuality:item.quality});
      e.renderer.setSize(item.width,item.height);camera.aspect=item.width/item.height;camera.updateProjectionMatrix();
      const targetY=item.road?e.world.terrain.getTerrainHeight(s.x,s.z)+.018:e.world.terrain.getTerrainHeight(s.anchorX,s.anchorZ)+s.y;
      camera.position.set(item.x,e.world.terrain.getTerrainHeight(item.x,item.z)+2.1,item.z);
      camera.lookAt(s.x,targetY,s.z);
      camera.updateMatrixWorld(true);e.world.update(0,camera.position);
      e.world.terrain.update(0,camera.position);
      e.dirLight.position.copy(camera.position).add(e.sunOffset);e.dirLightTarget.position.copy(camera.position);
      const group=e.world.branding.group;
      const corners=[];
      if(item.road){
        const pos=group.getObjectByName(`CI_Branding_${item.road}`).geometry.getAttribute('position');
        for(let i=0;i<pos.count;i++)corners.push(camera.position.clone().fromBufferAttribute(pos,i).project(camera));
      }else{
        for(const u of [-.5,.5])for(const v of [-.5,.5])corners.push(camera.position.clone().set(
          s.x+u*s.width*Math.cos(s.yaw),targetY+v*s.height,s.z-u*s.width*Math.sin(s.yaw)).project(camera));
      }
      const xs=corners.map(p=>(p.x+1)*item.width/2),ys=corners.map(p=>(1-p.y)*item.height/2);
      const x=Math.max(0,Math.floor(Math.min(...xs))),y=Math.max(0,Math.floor(Math.min(...ys)));
      const w=Math.max(1,Math.ceil(Math.max(...xs))-x),h=Math.max(1,Math.ceil(Math.max(...ys))-y);
      const sample=document.createElement('canvas');sample.width=w;sample.height=h;
      const ctx=sample.getContext('2d',{willReadFrequently:true});
      const pixels=()=>{ctx.clearRect(0,0,w,h);ctx.drawImage(e.renderer.domElement,x,y,w,h,0,0,w,h);return ctx.getImageData(0,0,w,h).data};
      group.visible=false;e.renderer.render(e.scene,camera);
      const beforePixels=pixels();
      const without={...e.renderer.info.render};
      group.visible=true;e.renderer.render(e.scene,camera);
      const withBranding={...e.renderer.info.render};
      const afterPixels=pixels();let targetChangedPixels=0;
      for(let i=0;i<afterPixels.length;i+=4)if(Math.abs(afterPixels[i]-beforePixels[i])+Math.abs(afterPixels[i+1]-beforePixels[i+1])+Math.abs(afterPixels[i+2]-beforePixels[i+2])>9)targetChangedPixels++;
      const point=camera.position.clone().set(s.x,targetY,s.z).project(camera);
      return {name:item.name,quality:item.quality,viewport:[innerWidth,innerHeight],
        callsAdded:withBranding.calls-without.calls,trianglesAdded:withBranding.triangles-without.triangles,
        targetNDC:point.toArray(),targetChangedPixels,targetPixels:[w,h],glError:e.renderer.getContext().getError(),
        image:e.renderer.domElement.toDataURL('image/png')};
    },item);
    assert.ok(result.callsAdded>0&&result.callsAdded<=20,JSON.stringify(result));
    assert.ok(result.trianglesAdded>0&&result.trianglesAdded<=78,JSON.stringify(result));
    assert.equal(result.glError,0);assert.ok(Math.abs(result.targetNDC[0])<.01&&Math.abs(result.targetNDC[1])<.01);
    assert.ok(result.targetChangedPixels>5,`Target lettering was not rendered: ${item.name}`);
    // Read in the same JS task as render: preserveDrawingBuffer is deliberately
    // off in production; a later compositor screenshot may capture a cleared frame.
    fs.writeFileSync(path.join(output,`${item.name}.png`),Buffer.from(result.image.split(',')[1],'base64'));
    delete result.image;results.push(result);
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',mode:'real GameEngine, fixed QA cameras, software Chromium WebGL',
    atlasSize:info.atlasSize,maxTextureSize:info.maxTextureSize,results,errors,output},null,2));
}finally{await browser.close()}
