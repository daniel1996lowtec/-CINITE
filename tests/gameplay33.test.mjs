import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import catalogue from '../server/weaponCatalog.json' with {type:'json'};
import geometry from '../server/worldCollisionManifest.json' with {type:'json'};
import manifest from '../server/worldLootManifest.json' with {type:'json'};
import { resetInventory, inventoryAction, fireInventory, advanceInventory, collectInventory,
  cancelInventoryAction, inventorySnapshot, weaponStats } from '../server/inventory.mjs';
import { canReachLoot, hasLineOfSight, isPlayerPositionClear, safeSpawnPosition, buildTransform } from '../server/worldGeometry.mjs';
import { loadWorldModules } from '../scripts/headlessWorld.mjs';
import { generateWorldLoot } from '../scripts/generateWorldLoot.mjs';
const player = () => {const p={alive:true,isConnected:true,health:100,shield:50,starterLoadout:'balanced'};resetInventory(p);return p;};
const item = (category,rarity='common',amount=1) => ({id:'test_item',itemType:category==='medkit'||category==='shield_potion'?'consumable':'weapon',weaponCategory:category,rarity,amount,position:{x:0,y:80,z:0}});
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('3.3 generated ammo/reload/damage catalogue and collision/terrain data match actual client world',async()=>{
  const generated = await generateWorldLoot();
  assert.deepEqual(generated.catalogue,catalogue);
  assert.equal(hash(generated.geometry),hash(geometry));
  assert.equal(Object.keys(catalogue).length,60);
  for(const stats of Object.values(catalogue)) {
    assert.ok(stats.clipSize>0);
    if(!stats.isConsumable) assert.ok(stats.fireRate>0);
  }
});

test('3.3 magazines, ownership, rarity and exact cadence: empty/forged shots cannot fire',()=>{
  const p=player();const s=weaponStats('assault_rifle','uncommon');
  assert.equal(fireInventory(p,'sniper','legendary',0),false);
  assert.equal(fireInventory(p,'assault_rifle','legendary',0),false);
  assert.equal(fireInventory(p,'assault_rifle','uncommon',0),true);
  assert.equal(p.inventory[1].clipAmmo,29);
  assert.equal(fireInventory(p,'assault_rifle','uncommon',1000/s.fireRate-.001),false);
  for(let i=1;i<30;i++)assert.equal(fireInventory(p,'assault_rifle','uncommon',i*1000),true);
  assert.equal(p.inventory[1].clipAmmo,0);
  assert.equal(fireInventory(p,'assault_rifle','uncommon',40000),false);
  assert.equal(p.ammo.medium,90,'firing does not conjure reserve ammunition');
  assert.equal(inventoryAction(p,'switch',0,1,40000),true);
  assert.equal(fireInventory(p,'harvester','rare',40140),true);
  assert.equal(p.inventory[0].clipAmmo,999);
  p.alive=false;assert.equal(fireInventory(p,'harvester','rare',50000),false);
});

test('3.3 burst spacing and slot swaps cannot accelerate the existing fire cycle',()=>{
  const p=player();collectInventory(p,item('burst_rifle'),3,'swap_x',0);
  assert.equal(p.activeSlot,3);
  assert.equal(fireInventory(p,'burst_rifle','common',140),true);
  assert.equal(fireInventory(p,'burst_rifle','common',214),false);
  assert.equal(fireInventory(p,'burst_rifle','common',215),true);
  assert.equal(fireInventory(p,'burst_rifle','common',290),true);
  assert.equal(fireInventory(p,'burst_rifle','common',365),false);
  assert.equal(inventoryAction(p,'switch',1,1,365),true);
  assert.equal(fireInventory(p,'assault_rifle','uncommon',505),false);
  assert.equal(fireInventory(p,'assault_rifle','uncommon',747),true);
  assert.equal(p.inventory[3].clipAmmo,weaponStats('burst_rifle','common').clipSize-3);
});

test('3.3 reloads are timed, conserve ammo, reject repeats and cancel on switch/death/disconnect',()=>{
  const p=player();fireInventory(p,'assault_rifle','uncommon',0);
  const duration=weaponStats('assault_rifle','uncommon').reloadTime*1000;
  assert.equal(inventoryAction(p,'reload',undefined,1,10),true);
  assert.equal(inventoryAction(p,'reload',undefined,1,11),false);
  assert.equal(inventoryAction(p,'reload',undefined,2,12),false);
  assert.equal(fireInventory(p,'assault_rifle','uncommon',1000),false);
  assert.equal(advanceInventory(p,10+duration-1),false);assert.equal(p.inventory[1].clipAmmo,29);
  assert.equal(advanceInventory(p,10+duration),true);assert.equal(p.inventory[1].clipAmmo,30);assert.equal(p.ammo.medium,89);
  assert.equal(advanceInventory(p,10+duration+500),false);
  fireInventory(p,'assault_rifle','uncommon',5000);
  inventoryAction(p,'reload',undefined,3,5010);inventoryAction(p,'switch',2,4,5011);
  advanceInventory(p,10000);assert.equal(p.inventory[1].clipAmmo,29);assert.equal(p.ammo.medium,89);
  inventoryAction(p,'switch',1,5,10000);inventoryAction(p,'reload',undefined,6,10001);
  p.isConnected=false;advanceInventory(p,15000);assert.equal(p.inventory[1].clipAmmo,29);assert.equal(p.isReloading,false);
  p.isConnected=true;inventoryAction(p,'reload',undefined,7,15001);p.alive=false;advanceInventory(p,20000);
  assert.equal(p.inventory[1].clipAmmo,29);assert.equal(p.ammo.medium,89);
});

test('3.3 consumables use owned stacks only, heal after duration, and cancel without consuming',()=>{
  const p=player();assert.equal(inventoryAction(p,'use',undefined,1,0),false);
  collectInventory(p,item('shield_potion','rare'),3,'swap_x',0);
  collectInventory(p,item('shield_potion','rare'),3,'swap_x',0);
  assert.equal(p.inventory[3].count,2);
  assert.equal(inventoryAction(p,'use',undefined,2,200),true);
  assert.equal(inventoryAction(p,'use',undefined,3,201),false);
  const end=200+weaponStats('shield_potion','rare').consumeTime*1000;
  advanceInventory(p,end-1);assert.equal(p.shield,50);assert.equal(p.inventory[3].count,2);
  advanceInventory(p,end);assert.equal(p.shield,100);assert.equal(p.inventory[3].count,1);
  assert.equal(inventoryAction(p,'use',undefined,4,end+1),false,'cannot waste/heal past full shield');
  p.shield=0;inventoryAction(p,'use',undefined,5,end+2);cancelInventoryAction(p);advanceInventory(p,end+5000);
  assert.equal(p.shield,0);assert.equal(p.inventory[3].count,1);
  assert.equal(inventoryAction(p,'switch',5,6,end+6000),false);
  assert.equal(inventoryAction(p,'switch',-1,7,end+6000),false);
  assert.equal(inventoryAction(p,'switch',1,NaN,end+6000),false);
});

test('3.3 inventory swaps preserve partially used magazines, consumable counts, reserves and vault provenance',()=>{
  const p=player();fireInventory(p,'assault_rifle','uncommon',0);
  collectInventory(p,{...item('sniper','legendary'),towerProvenance:true},3,'swap_unused',10);
  collectInventory(p,item('shield_potion','rare',3),4,'swap_unused',20);
  const reserve=p.ammo.medium;
  const result=collectInventory(p,item('shotgun','rare'),1,'swap_rifle',30);
  assert.equal(result.dropped.clipAmmo,29);assert.equal(result.dropped.weaponCategory,'assault_rifle');
  collectInventory(p,result.dropped,1,'swap_shotgun',40);
  assert.equal(p.inventory[1].clipAmmo,29);assert.equal(p.ammo.medium,reserve);
  const potion=collectInventory(p,item('pistol'),4,'swap_potions',50).dropped;
  assert.equal(potion.amount,3);assert.equal(potion.itemType,'consumable');
  const sniper=collectInventory(p,item('dmr'),3,'swap_sniper',60).dropped;
  assert.equal(sniper.towerProvenance,true);assert.equal(sniper.clipAmmo,5);
  const receiver=player();collectInventory(receiver,sniper,3,'unused',70);
  assert.equal(receiver.inventory[3].towerProvenance,true);
  assert.equal(receiver.ammo.heavy,15,'a swapped weapon never grants another reserve bonus');
  p.ammo.light=998;collectInventory(p,{itemType:'ammo',ammoType:'light',amount:120});assert.equal(p.ammo.light,999);
  assert.match(collectInventory(p,{itemType:'ammo',ammoType:'light',amount:120}).reason,/full/);
  collectInventory(p,{itemType:'material',materialType:'wood',amount:200});assert.equal(p.materials.wood,300);
  const snapshot=inventorySnapshot(p);assert.equal(snapshot.inventory.length,5);assert.equal(snapshot.inventory[0].category,'harvester');
});

test('3.3 solid-wall/floor and player-built occlusion, clear interaction routes, safe spawn correction',()=>{
  const wall=geometry.boxes[0],x=(wall.minX+wall.maxX)/2;
  const p={position:{x,y:wall.minY+.2,z:wall.minZ-1.2}};
  const loot={position:{x,y:wall.minY+.3,z:wall.maxZ+1.2}};
  assert.equal(canReachLoot({},p,loot),false);
  const build={buildId:'build_test',pieceType:'wall',x:0,y:80,z:0,yaw:0};
  const room={buildables:new Map([[build.buildId,build]])};
  assert.equal(hasLineOfSight(room,{x:0,y:81,z:-6},{x:0,y:81,z:-2}),false);
  assert.equal(hasLineOfSight(room,{x:3,y:81,z:-6},{x:3,y:81,z:-2}),true);
  assert.deepEqual(buildTransform(build),{x:0,y:80,z:-4,yaw:0,cell:'wall_0_80_-4'});
  const embedded={x,y:wall.minY+.2,z:(wall.minZ+wall.maxZ)/2};
  assert.equal(isPlayerPositionClear({},{x:200,y:-30,z:0}),false,'underground movement is rejected');
  assert.ok(safeSpawnPosition({},{x:200,y:-30,z:0}).y>=-.85,'initial spawns stay above terrain/water floor');
  assert.equal(isPlayerPositionClear({},embedded),false);
  assert.equal(isPlayerPositionClear({},safeSpawnPosition({},embedded)),true);
  assert.equal(isPlayerPositionClear({},safeSpawnPosition({},{x:0,y:60,z:0})),true,'tower crown spawn is corrected');
  for(const item of manifest.items) {
    const reachable=[[0,0],[1.2,0],[-1.2,0],[0,1.2],[0,-1.2],[2,2],[-2,-2]].some(([dx,dz])=>{
      const position={x:item.position.x+dx,y:item.position.y,z:item.position.z+dz};
      return isPlayerPositionClear({},position)&&canReachLoot({},{position},item);
    });
    assert.ok(reachable,`${item.id} must have a non-embedded, unobstructed pickup approach`);
  }
});

test('3.3 directional cue bearings and mobile/control contracts stay bounded and presentation-only',async()=>{
  const code=stripTypeScriptTypes(fs.readFileSync(new URL('../src/ui/combatFeedback.ts',import.meta.url),'utf8'));
  const {relativeThreatAngle}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  assert.equal(relativeThreatAngle({x:0,z:0},{x:0,z:-1},0),0);
  assert.ok(Math.abs(relativeThreatAngle({x:0,z:0},{x:1,z:0},0)-Math.PI/2)<1e-8);
  assert.ok(Math.abs(relativeThreatAngle({x:0,z:0},{x:1,z:0},-Math.PI/2))<1e-8);
  const hud=fs.readFileSync(new URL('../src/ui/HUDManager.ts',import.meta.url),'utf8');
  assert.match(hud,/this.threatTimer = .85/);assert.match(hud,/this.threatTimer = 0; this.threatIndicator/);
  const network=fs.readFileSync(new URL('../src/network/NetworkManager.ts',import.meta.url),'utf8');
  assert.match(network,/pendingInventoryShots.size < 64/);assert.doesNotMatch(network,/public sendHealSync/);
});


test('3.3 every firearm/rarity obeys owned-magazine exhaustion and partial reserve reloads',()=>{
  for(const stats of Object.values(catalogue).filter(s=>!s.isConsumable&&s.category!=='harvester')) {
    const p=player();collectInventory(p,item(stats.category,stats.rarity),3,'unused',0);
    for(let shot=0;shot<stats.clipSize;shot++) {
      assert.equal(fireInventory(p,stats.category,stats.rarity,1000+shot*2000),true,stats.id);
    }
    const now=1000+stats.clipSize*2000;
    assert.equal(fireInventory(p,stats.category,stats.rarity,now),false,stats.id);
    p.ammo[stats.ammoType]=0;
    assert.equal(inventoryAction(p,'reload',undefined,1,now),false,stats.id);
    p.ammo[stats.ammoType]=2;
    assert.equal(inventoryAction(p,'reload',undefined,2,now),true,stats.id);
    advanceInventory(p,now+stats.reloadTime*1000+1);
    assert.equal(p.inventory[3].clipAmmo,2,stats.id);
    assert.equal(p.ammo[stats.ammoType],0,stats.id);
  }
});

test('3.3 footsteps sample existing surfaces, use one short voice and disconnect audio nodes',async()=>{
  const {IslandWorld}=await loadWorldModules();
  const world={walkableSurfaces:[{id:'floor',minX:-2,maxX:2,minZ:-2,maxZ:2,getHeight:()=>5}],destructibles:new Map()};
  const sample=(x,y,z)=>IslandWorld.prototype.getFootstepSurface.call(world,x,y,z);
  assert.equal(sample(20,5,20),'ground');assert.equal(sample(0,5,0),'hard');
  world.destructibles.set('floor',{materialType:'wood'});assert.equal(sample(0,5,0),'wood');
  world.destructibles.set('floor',{materialType:'metal'});assert.equal(sample(0,5,0),'metal');
  assert.equal(sample(0,8,0),'ground','do not sample floors below an airborne player');
  const code=stripTypeScriptTypes(fs.readFileSync(new URL('../src/audio/SoundManager.ts',import.meta.url),'utf8'))
    .replace(/import[^;]*from ['"]\.\.\/network\/schemas['"];?/,'');
  const {SoundManager}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  let disconnected=0,stopped=0,voiceDuration=0;
  const pitches=[];
  const oscillator={frequency:{setValueAtTime:f=>pitches.push(f),exponentialRampToValueAtTime(){}},
    connect(){},disconnect(){disconnected++;},start(){},stop:t=>{stopped=t;}};
  const gain={gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){disconnected++;}};
  const manager=new SoundManager();
  manager.ensureContext=()=>({currentTime:10,destination:{},createOscillator:()=>oscillator,createGain:()=>gain});
  manager.canPlay=()=>true;manager.trackVoice=duration=>{voiceDuration=duration;};
  manager.playFootstep(false,1,'ground');const groundPitch=pitches.at(-1);
  manager.playFootstep(false,1,'metal');assert.ok(pitches.at(-1)>groundPitch);
  assert.ok(stopped<=10.07);assert.ok(voiceDuration<=.07);
  oscillator.onended();assert.equal(disconnected,2);
  const count=pitches.length;manager.playFootstep(false,0,'metal');assert.equal(pitches.length,count);
});
