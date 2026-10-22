import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';
import manifest from '../server/worldLootManifest.json' with {type:'json'};
import { generateWorldLoot } from '../scripts/generateWorldLoot.mjs';
import { loadWorldModules } from '../scripts/headlessWorld.mjs';
import { createWorldLootMap, getChestRewards, validateLootClaim } from '../server/worldLoot.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('3.2 registry exactly matches actual map/catalogue; every registered reward is on safe geometry', async () => {
  const {catalogue,geometry,...loot} = await generateWorldLoot();
  assert.deepEqual(JSON.parse(JSON.stringify(loot)),manifest,'regenerate the registry when world/catalogue changes');
  const {IslandWorld}=await loadWorldModules(); const scene=new THREE.Scene();
  const world=new IslandWorld(scene); world.generate();
  const items=[...manifest.items,...Object.values(manifest.chestDrops).flat()];
  assert.equal(new Set(items.map(i=>i.id)).size,items.length);
  const firearms = new Set();
  for(const item of items) {
    assert.equal(item.serverAuthoritative,true);
    assert.ok(Number.isFinite(item.amount)&&item.amount>0);
    const p=item.position;
    assert.ok(!world.boxColliders.some(b=>p.x>b.minX&&p.x<b.maxX&&p.y>b.minY&&p.y<b.maxY&&p.z>b.minZ&&p.z<b.maxZ),`${item.id} buried in wall/prop`);
    assert.ok(world.getGroundHeightAt(p.x,p.y+0.05,p.z)<=p.y+0.18,`${item.id} below floor`);
    if(item.itemType==='weapon') firearms.add(item.weaponCategory);
  }
  assert.equal(firearms.size,9);
  const outsideAurora = manifest.items.filter(i=>i.itemType==='weapon'&&i.rarity==='epic'&&
    Math.hypot(i.position.x-97,i.position.z-2)>70&&Math.hypot(i.position.x,i.position.z)>40);
  assert.ok(outsideAurora.length>=8,'contested centre must not monopolize upgrades');
  let meshes=0,triangles=0;
  scene.traverse(o=>{if(o.isMesh){meshes++;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);}});
  console.log(`3.2 world: ${meshes} mesh objects, ${triangles} triangles, ${world.boxColliders.length+world.cylinderColliders.length} colliders; ${manifest.items.length} registry entries`);
});

test('3.2 registry identities/range: no unknown IDs, no forged coordinates, no duplicate claims',()=>{
  const room={spawnedLootItems:createWorldLootMap(),collectedLootIds:new Set()};
  const item=manifest.items.find(i=>i.itemType==='weapon');
  const player={starterLoadout:'balanced',position:{...item.position}};
  assert.equal(validateLootClaim(room,player,item.id).item.id,item.id);
  player.position.y+=7;assert.match(validateLootClaim(room,player,item.id).reason,/range/);
  assert.match(validateLootClaim(room,player,'invented').reason,/registered/);
  player.position={...item.position};room.collectedLootIds.add(item.id);
  assert.match(validateLootClaim(room,player,item.id).reason,/already collected/);
  const first=getChestRewards('chest_0');first[0].amount=999;
  assert.equal(getChestRewards('chest_0')[0].amount,1,'rewards are per-room copies');
});

async function loadPresentation() {
  const dir=fs.mkdtempSync(path.join(root,'.evolution32-'));
  try {
    const emit=(source,name,replacements=[])=>{
      let code=stripTypeScriptTypes(fs.readFileSync(path.join(root,source),'utf8'));
      for(const [a,b] of replacements) code=code.replace(a,b);
      fs.writeFileSync(path.join(dir,name),code);
    };
    emit('src/systems/StormConfig.ts','StormConfig.mjs',[[/import[^;]*from ['"]\.\.\/network\/schemas['"];?/,'']]);
    emit('src/systems/StormSystem.ts','StormSystem.mjs',[
      [/import[^;]*from ['"]\.\.\/network\/schemas['"];?/, ''],["from './StormConfig'","from './StormConfig.mjs'"]]);
    emit('src/systems/ParticleSystem.ts','ParticleSystem.mjs',[[/import[^;]*from ['"]\.\.\/audio\/SoundManager['"];?/,'']]);
    return { ...(await import(pathToFileURL(path.join(dir,'StormSystem.mjs')))),
      ...(await import(pathToFileURL(path.join(dir,'ParticleSystem.mjs')))) };
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}

test('3.2 final-zone visuals do not advance authoritative time; rings follow terrain; effects are bounded',async()=>{
  const {StormSystem,ParticleSystem}=await loadPresentation();const scene=new THREE.Scene();
  const storm=new StormSystem(scene,()=>8);
  const state={phase:'ACTIVE',storm:{phase:7,phaseTimer:22,currentRadius:10,currentCenterX:5,currentCenterZ:7,
    targetRadius:4,targetCenterX:2,targetCenterZ:3,damagePerSecond:12}};
  const before=structuredClone(state);
  storm.syncVisuals(state,1);
  assert.deepEqual(state,before);
  assert.equal(scene.getObjectByName('FinalSafeZoneBeacon').visible,true);
  const ring=scene.getObjectByName('StormCurrentBoundaryRing');
  assert.ok(Math.abs(ring.geometry.attributes.position.getY(0)+ring.position.y-8.16)<0.001);
  assert.equal(scene.children.filter(o=>o.isLight).length,0);
  state.storm.phase=2;storm.syncVisuals(state,0.2);
  assert.equal(scene.getObjectByName('FinalSafeZoneBeacon').visible,false);
  storm.dispose(); assert.equal(scene.children.length,0);
  const fx=new ParticleSystem(scene);fx.setQualityScale(0.35);
  for(let i=0;i<200;i++){fx.spawnShockwaveRing(new THREE.Vector3(),0x67e8f9);fx.spawnBulletTracer(new THREE.Vector3(),new THREE.Vector3(0,1,2),0xffffff);}
  assert.ok(fx.rings.length<=8);assert.ok(fx.tracers.length<=48);
  fx.update(2);assert.equal(fx.rings.length,0);assert.equal(fx.tracers.length,0);
  fx.clear();assert.equal(scene.children.length,0);
});
