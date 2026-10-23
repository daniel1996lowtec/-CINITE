import test from 'node:test';
import { measureQualityTiers, auditTreeLod } from './helpers/sceneStats.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import * as THREE from 'three';
import {loadWorldModules} from '../scripts/headlessWorld.mjs';
const root=path.resolve(import.meta.dirname,'..');
async function loadModules(){
  const dir=fs.mkdtempSync(path.join(root,'.polish35-'));
  try {
    const files=['ui/combatFeedback','systems/StormConfig','systems/StormSystem','systems/ParticleSystem',
      'audio/SoundManager','weapons/WeaponDefinitions','input/touchInputMath','camera/ThirdPersonCamera'];
    for(const file of files){
      let source=stripTypeScriptTypes(fs.readFileSync(path.join(root,'src',file+'.ts'),'utf8'));
      source=source.replace(/import\s+(?:type\s+)?\{[^}]*\}\s+from\s+['"]\.\.\/(?:network\/schemas|world\/IslandWorld)['"];?/g,'');
      source=source.replace(/from ['"](?:\.\.\/|\.\/)([^'"]+)['"]/g,(_,dep)=>`from './${path.basename(dep)}.mjs'`);
      fs.writeFileSync(path.join(dir,path.basename(file)+'.mjs'),source);
    }
    const modules={};for(const file of files)Object.assign(modules,await import(pathToFileURL(path.join(dir,path.basename(file)+'.mjs'))));return modules;
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
}
const modules=await loadModules();
test('3.5 confirmed feedback taxonomy prioritizes breaks; spatial gain is finite, bounded and monotone',()=>{
  const engine=fs.readFileSync(path.join(root,'src/core/GameEngine.ts'),'utf8');
  const fireOnly=engine.slice(engine.indexOf('this.network.onRemoteWeaponFired'),engine.indexOf('this.network.onServerHitEvent'));
  assert.doesNotMatch(fireOnly,/showHitmarker|spawnImpactBurst|spawnSurfaceImpact/,'a fire endpoint is not a confirmed impact');
  const {confirmedHitKind:kind,combatFeedbackGain:gain}=modules;
  assert.equal(kind(false,false,false,false),'health');assert.equal(kind(false,true,false,false),'shield');
  assert.equal(kind(true,true,true,false),'shield-break');assert.equal(kind(true,false,false,false),'headshot');assert.equal(kind(true,true,true,true),'elim');
  assert.equal(gain(0),1);assert.equal(gain(96),0);assert.equal(gain(200),0);assert.equal(gain(NaN),0);assert.equal(gain(10,0),0);
  for(let d=1;d<=100;d++)assert.ok(gain(d)<=gain(d-1));
});
test('3.5 storm notices are edge-triggered, initially silent and resettable; guidance/countdown are truthful',()=>{
  const {StormNoticeTracker,safeZoneBearing,countdownLabel}=modules;const t=new StormNoticeTracker();
  assert.equal(t.update(6,false,false),null);assert.equal(t.update(6,false,false),null);
  assert.equal(t.update(6,true,false),'CLOSING');assert.equal(t.update(6,true,false),null);
  assert.equal(t.update(6,true,true),'OUTSIDE');assert.equal(t.update(6,true,false),'SAFE AGAIN');
  assert.equal(t.update(7,false,false),'NEW ZONE');assert.equal(t.update(9,false,false),'FINAL HOLD');
  t.reset();assert.equal(t.update(2,false,true),null);
  assert.equal(safeZoneBearing(0,0,0,-10),'N');assert.equal(safeZoneBearing(0,0,10,0),'E');
  assert.equal(safeZoneBearing(0,0,0,10),'S');assert.equal(safeZoneBearing(0,0,-10,0),'W');
  assert.equal(countdownLabel(2.6),'3');assert.equal(countdownLabel(.1),'1');assert.equal(countdownLabel(0),'DROP!');
});
test('3.5 reduced motion never changes aim recoil, touch sensitivity or hit rays',()=>{
  const a=new modules.ThirdPersonCamera(2),b=new modules.ThirdPersonCamera(2);b.reducedMotion=true;
  const random=Math.random;Math.random=()=>.5;
  try {for(const camera of [a,b]){camera.touchSensitivity=1.4;camera.handleTouchLook(15,-4);camera.applyRecoil(.02,.01,'assault_rifle',true);camera.applyHitConfirmationPulse(true,true)}}finally{Math.random=random}
  assert.equal(a.yaw,b.yaw);assert.equal(a.pitch,b.pitch);assert.deepEqual(a.getAimRay(),b.getAimRay());
  assert.equal(a.recoilPitchOffset,b.recoilPitchOffset);assert.ok(a.hitConfirmFovPulse<0);assert.equal(b.hitConfirmFovPulse,0);
});
test('3.5 particle budgets include oversized bursts; clear reuses resources; dispose releases each once',()=>{
  const scene=new THREE.Scene(),fx=new modules.ParticleSystem(scene),v=new THREE.Vector3();
  fx.setQualityScale(.35);fx.spawnImpactBurst(v,0xffffff,10000);assert.equal(fx.particles.length,63);
  fx.spawnBulletTracer(v,new THREE.Vector3(0,1,4),0xffffff);fx.spawnShockwaveRing(v,0xffffff);
  const geometries=[fx.boxGeo,fx.chipGeo,fx.casingGeo,fx.unitTracerCoreGeo,fx.unitTracerGlowGeo,fx.sharedRingGeo];
  const materials=new Set();scene.traverse(o=>{if(o.material)materials.add(o.material)});const disposals=new Map();
  for(const resource of [...geometries,...materials]){disposals.set(resource,0);resource.addEventListener('dispose',()=>disposals.set(resource,disposals.get(resource)+1))}
  fx.clear();assert.equal(scene.children.length,0);assert.ok([...disposals.values()].every(n=>n===0));
  for(let round=0;round<10;round++){fx.spawnImpactBurst(v,0xffffff,63);fx.update(1);fx.clear()}
  assert.ok(fx.particleMeshPool.length<=180);fx.dispose();fx.dispose();assert.ok([...disposals.values()].every(n=>n===1));
  fx.spawnImpactBurst(v);fx.spawnBulletTracer(v,v,0xffffff);fx.spawnShockwaveRing(v,0xffffff);assert.equal(scene.children.length,0);
});
test('3.5 storm reduced-motion/final-beacon presentation cannot advance snapshots; disposal is idempotent',()=>{
  const scene=new THREE.Scene(),storm=new modules.StormSystem(scene,()=>12);storm.reducedMotion=true;
  const state={phase:'ACTIVE',storm:{phase:8,phaseTimer:18,isShrinking:false,currentRadius:10,currentCenterX:0,currentCenterZ:0,targetRadius:4,targetCenterX:3,targetCenterZ:4}};
  const before=structuredClone(state);storm.syncVisuals(state,.2);storm.syncVisuals(state,.2);assert.deepEqual(state,before);assert.equal(storm.animTime,0);
  const beacon=scene.getObjectByName('FinalSafeZoneBeacon');assert.equal(beacon.position.y,57);assert.equal(beacon.visible,true);
  let disposed=0;for(const object of scene.children){object.geometry.addEventListener('dispose',()=>disposed++);object.material.addEventListener('dispose',()=>disposed++)}
  storm.dispose();storm.dispose();storm.update(5,state);assert.deepEqual(state,before);assert.equal(scene.children.length,0);assert.equal(disposed,10);
});
test('3.5 original audio has distinct shield/body tones, respects mute and disconnects completed nodes',()=>{
  const nodes=[];const param=()=>({value:0,setValueAtTime(v){this.value=v},exponentialRampToValueAtTime(){},linearRampToValueAtTime(){}});
  const node=()=>{const n={frequency:param(),gain:param(),connect(){},disconnect(){this.disconnected=true},start(){},stop(){}};nodes.push(n);return n};
  const ctx={state:'running',currentTime:10,createOscillator:node,createGain:node,destination:{}};
  const saved=globalThis.window;globalThis.window={};
  try {
    const sound=new modules.SoundManager();sound.ctx=ctx;sound.playDamageTaken(true);const shield=nodes[0].frequency.value;
    sound.lastPlayedAt.clear();const offset=nodes.length;sound.playDamageTaken(false);assert.notEqual(nodes[offset].frequency.value,shield);
    sound.playShieldBreak();sound.playSurfaceImpact('metal');sound.playFinalZoneCue();sound.playHitmarker(true,false,true);
    for(const n of nodes)if(n.onended)n.onended();assert.ok(nodes.every(n=>n.disconnected));
    const count=nodes.length;sound.muted=true;sound.lastPlayedAt.clear();sound.playFinalZoneCue();sound.playDamageTaken();assert.equal(nodes.length,count);
  }finally{globalThis.window=saved}
});
test('3.5 navigation paint follows existing supported surfaces; landmark light is distance/quality bounded',async()=>{
  const {IslandWorld}=await loadWorldModules();const scene=new THREE.Scene(),world=new IslandWorld(scene);world.generate();
  let decals=0,triangles=0;const matrix=new THREE.Matrix4(),position=new THREE.Vector3();
  scene.traverse(o=>{
    if(o.isMesh)triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);
    if(!o.name.includes('_decal_'))return;
    assert.equal(o.material.depthTest,true);assert.equal(o.castShadow,false);
    for(let i=0;i<o.count;i++){o.getMatrixAt(i,matrix);position.setFromMatrixPosition(matrix);
      const floor=world.getGroundHeightAt(position.x,position.y+.1,position.z);
      assert.ok(Math.abs(position.y-floor)<.15,`${o.name} paint unsupported at ${position.toArray()}: ${floor}`);decals++}
  });
  // CI CRAFT 6.1 detail budget: the extra static detail-tier architecture
  // (cornices, mullions, rooftop plant, street furniture) stays inside the
  // shared instanced batches and is dropped on the reduced-detail tier; the
  // draw-call/mesh count and the exact collider fingerprint are unchanged.
  assert.ok(decals>20);
// CI CRAFT 7.0 tiered budgets (shared helper): what LOW/MEDIUM and HIGH/ULTRA
// actually draw, factoring out hidden LOD twins and the decorative tier.
const tiers=measureQualityTiers(scene,world);
  // Measured 7.0 baseline (visualAudit, detailed vegetation on the high tier):
  //   LOW/MEDIUM 320,030 tris | HIGH/ULTRA 576,900 tris
  // 6.2's always-on tier was 305,226. The +4.8 % on LOW buys the round
  // shared cylinder (10 -> 18 segments), which is the single fix for the
  // visibly faceted silos, tanks and towers. Budgets sit just above the
  // measured value so ordinary tweaks do not churn, and any further growth
  // has to be justified explicitly.
  // Measured 8.0 tier totals (visualAudit / measureQualityTiers):
  //   LOW/MEDIUM 327,640 tris | HIGH/ULTRA 609,542 tris
  // The 8.0 delta over 7.2 (+2.6k LOW, +24.5k HIGH) is the clustered ground
  // cover: 6,400 grass tufts at 6 triangles plus 1,400 flowers, in four
  // instanced draw calls. LOW keeps one band and no flowers; HIGH/ULTRA show
  // all of it with a taller/tighter band layout. Nothing else was added, and
  // no existing geometry was made heavier to reach these numbers.
assert.ok(tiers.low.triangles<=330000,`LOW/MEDIUM triangle budget ${tiers.low.triangles}`);
assert.ok(tiers.high.triangles<=620000,`HIGH/ULTRA triangle budget ${tiers.high.triangles}`);
const lodAudit=auditTreeLod(world.treeLodHighGroup,world.treeLodLowGroup);
assert.deepEqual(lodAudit.problems,[],`vegetation LOD desync: ${lodAudit.problems.join('; ')}`);
  const light=scene.getObjectByName('LegendaryTowerVaultLight');world.update(.1,new THREE.Vector3(500,50,500));assert.equal(light.visible,false);
  world.setLandmarkDetail(false);world.update(.1,new THREE.Vector3(0,55,0));assert.equal(light.visible,false);
  world.setLandmarkDetail(true);world.update(.1,new THREE.Vector3(0,55,0));assert.equal(light.visible,true);assert.ok(light.intensity>=71&&light.intensity<=85);
});
