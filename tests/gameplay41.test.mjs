import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {loadGameplayModules,loadRig,makePlayerState} from './helpers/gameplayModules.mjs';
import {buildTransform,isBuildPlacementClear,isPlayerPositionClear} from '../server/worldGeometry.mjs';
const {NetworkManager,CharacterMesh,IslandWorld,PlayerController}=await loadGameplayModules();
const world=new IslandWorld(new THREE.Scene()),noop=()=>{};
world.generate();
const input={dt:.1,moveX:0,moveZ:0,yaw:0,pitch:0,selectSlot:-1};
function step(p,overrides={}) {
 const c=new PlayerController();c.updateCombatActions=noop;
 c.updateLocalPlayer(p,{...input,...overrides},{buildables:new Map()},world,new Map(),{checkAutoPickups:noop},{spawnImpactBurst:noop},{playLand:noop,playJump:noop,playFootstep:noop},null,noop,noop);
}
test('4.1 accepted owner builds reach the same world insertion path as other players',()=>{
 const n=new NetworkManager();n.serverPlayerId='self';const ids=new Set();
 n.onRemoteBuildPlaced=(id,owner,type,x,y,z,yaw,mat)=>{if(ids.has(id))return;ids.add(id);world.placeBuildPiece(owner,type,x,y,z,yaw,mat,id)};
 const packet={type:'build_placed',ownerId:'self',buildId:'build_owner',pieceType:'wall',x:40,y:80,z:40,yaw:0,material:'wood'};
 n.handleServerMessage(packet);n.handleServerMessage(packet);
 assert.equal(ids.size,1);assert.ok(world.destructibles.has(packet.buildId));
});
test('4.1 preview/Solo/server transforms, rotations, duplicate cells and static collision agree',()=>{
 for(const pieceType of ['wall','floor','ramp','roof'])for(const yaw of [0,Math.PI/2,Math.PI,-Math.PI/2,Math.PI*8+.6]) {
  const x=80+(['wall','floor','ramp','roof'].indexOf(pieceType)*10),y=80,z=40+yaw*2;
  const client=world.computeBuildTransform(x,y,z,yaw),server=buildTransform({x,y,z,yaw,pieceType});
  assert.equal(client.bx,server.x);assert.equal(client.by,server.y);assert.equal(client.bz,server.z);assert.equal(client.snappedYaw,server.yaw);
  assert.ok(world.validateBuildPlacement(pieceType,x,y,z,yaw));assert.ok(isBuildPlacementClear({}, {x,y,z,yaw,pieceType}));
  const placed=world.placeBuildPiece('test',pieceType,x,y,z,yaw);
  assert.ok(world.destructibles.has(placed.id));assert.equal(world.validateBuildPlacement(pieceType,x,y,z,yaw),false);
 }
 // Known central tower solid walls: find an occupied volume, not an arbitrary screenshot coordinate.
 const box=world.boxColliders.find(b=>!b.destructibleId?.startsWith('build_') && b.maxY-b.minY>2 && b.maxX-b.minX>1 && b.maxZ-b.minZ>.2 && (b.minY+b.maxY)/2>world.terrain.getTerrainHeight((b.minX+b.maxX)/2,(b.minZ+b.maxZ)/2)+1);
 const x=(box.minX+box.maxX)/2,z=(box.minZ+box.maxZ)/2+3.5,y=(box.minY+box.maxY)/2;
 assert.equal(world.validateBuildPlacement('floor',x,y,z,0),false);
 assert.equal(isBuildPlacementClear({}, {x,y,z,yaw:0,pieceType:'floor'}),false);
});
test('4.1 insufficient resources never create geometry and leave a useful rejection',()=>{
 const p=makePlayerState({position:{x:180,y:80,z:0},materials:{wood:0,stone:0,metal:0}}),c=new PlayerController();let reason='';c.onBuildRejected=r=>reason=r;
 assert.equal(c.tryPlaceBuild(p,'floor',{buildables:new Map()},world,{},{}),null);assert.match(reason,/10 required/);
});
test('4.1 swept descent lands on terrain, elevated floor, roof and wall without tunneling',()=>{
 for(const type of ['floor','roof','wall']) {
  const piece=world.placeBuildPiece('landing',type,0,80,20,0,'wood');
  const surf=world.walkableSurfaces.find(s=>s.id===piece.id),h=surf.getHeight(piece.position.x,piece.position.z);
  for(const dt of [1/60,.05,.1]) {
   const p=makePlayerState({position:{x:piece.position.x,y:h+.1,z:piece.position.z},velocity:{x:0,y:-60,z:0},isGrounded:false});
   step(p,{dt});assert.equal(p.isGrounded,true);assert.equal(p.position.y,h);assert.equal(p.velocity.y,0);
   step(p,{dt});assert.equal(p.position.y,h);assert.equal(p.isGrounded,true);
  }
 }
 const h=Math.max(-.85,world.terrain.getTerrainHeight(180,0));
 const p=makePlayerState({position:{x:180,y:h+.1,z:0},isGrounded:false,velocity:{x:0,y:-30,z:0}});
 step(p);assert.equal(p.position.y,h);assert.equal(p.velocity.y,0);
});
test('4.1 rising jump does not snap up to an overhead floor; ramps match rendered top planes',()=>{
 const piece=world.placeBuildPiece('ramp','ramp',-80,80,0,0);
 const surface=world.walkableSurfaces.find(s=>s.id===piece.id);
 const expected=80+1.4+.125/Math.cos(Math.atan2(2.8,3.6));
 assert.ok(Math.abs(surface.getHeight(piece.position.x,piece.position.z)-expected)<1e-8);
 assert.ok(Math.abs(surface.maxX-surface.minX-3.2)<1e-8);
 const p=makePlayerState({position:{x:piece.position.x,y:expected+.01,z:piece.position.z},velocity:{x:0,y:-20,z:0},isGrounded:false});step(p);assert.equal(p.position.y,expected);
 world.placeBuildPiece('ceiling','floor',120,81,0,0);
 const jumping=makePlayerState({position:{x:120,y:80,z:-4},velocity:{x:0,y:5,z:0},isGrounded:false});
 step(jumping,{dt:.016});assert.ok(jumping.position.y<80.1);assert.equal(jumping.isGrounded,false);
});
test('4.1 actual bundled rig: fall/glide → land → upright idle/run at 30/60Hz and remote LOD',async()=>{
 await loadRig(CharacterMesh);
 for(const fps of [30,60])for(const distance of [3,160]){
  const p=makePlayerState(),m=new CharacterMesh(p),camera=new THREE.Vector3(0,2,distance);
  for(let i=0;i<fps;i++)m.update(p,1/fps,camera);
  m.root.updateMatrixWorld(true);const baseline=m.gltfBones.leftFoot.getWorldPosition(new THREE.Vector3()).y;
  for(const glide of [true,false]) {
   p.isGrounded=false;p.isGliding=glide;p.velocity.y=-17;
   for(let i=0;i<fps;i++)m.update(p,1/fps,camera);
   p.isGrounded=true;p.isGliding=false;p.velocity.y=0;
   for(let i=0;i<fps*2;i++)m.update(p,1/fps,camera);
   assert.equal(m.presentationState,'ready');assert.ok(m.gltfActions.land.getEffectiveWeight()<.001);
   m.root.updateMatrixWorld(true);assert.ok(Math.abs(m.gltfBones.leftFoot.getWorldPosition(new THREE.Vector3()).y-baseline)<.025);
   assert.equal(m.root.position.y,p.position.y);assert.equal(m.bodyGroup.scale.y,1);
  }
  p.velocity.z=-6.7;for(let i=0;i<fps;i++)m.update(p,1/fps,camera);assert.equal(m.presentationState,'run');
  assert.ok(Object.values(m.gltfBones).every(b=>b.quaternion.toArray().every(Number.isFinite)));m.dispose();
 }
});
test('4.1 remote landing waits for interpolated contact and does not extrapolate into the floor',()=>{
 const n=new NetworkManager();n.isOnlineRoom=true;const p=makePlayerState({id:'remote',position:{x:0,y:2,z:0},velocity:{x:0,y:-17,z:0},isGrounded:false});n.state.players.set(p.id,p);
 n.remoteTargets.set(p.id,{targetX:0,targetY:0,targetZ:0,velX:0,velY:-17,velZ:0,grounded:true,targetYaw:0,targetFacingYaw:0,targetPitch:0,lastPacketPerfMs:performance.now()-60});
 n.updateRemotePlayers(1/60);assert.equal(p.isGrounded,false);assert.ok(p.position.y>0);
 for(let i=0;i<120;i++)n.updateRemotePlayers(1/60);
 assert.equal(p.isGrounded,true);assert.ok(p.position.y>=0&&p.position.y<.001);assert.equal(p.landingImpactTimer,.18);
});

test('4.1 glider lands on solid parapet tops instead of entering a server-correction loop',()=>{
 const box=world.boxColliders.find(b=>b.id==='wall_0');assert.ok(box);
 const p=makePlayerState({position:{x:(box.minX+box.maxX)/2,y:box.maxY+.05,z:(box.minZ+box.maxZ)/2},isGrounded:false,isGliding:true});
 step(p);assert.equal(p.isGrounded,true);assert.equal(p.isGliding,false);assert.equal(p.position.y,box.maxY);assert.equal(p.velocity.y,0);
 assert.ok(isPlayerPositionClear({},p.position));
});

test('4.1 Solo fallback material debit and server-owned requests do not predict geometry',()=>{
 const c=new PlayerController(),p=makePlayerState({position:{x:180,y:80,z:30},materials:{wood:5,stone:10,metal:0}}),state={buildables:new Map()};
 const piece=c.tryPlaceBuild(p,'floor',state,world,{spawnImpactBurst:noop,spawnShockwaveRing:noop},{playBuild:noop});
 assert.equal(piece.material,'stone');assert.equal(p.materials.stone,0);assert.equal(p.materials.wood,5);assert.equal(state.buildables.size,1);
 p.position.z=50;p.materials.stone=10;c.usesServerInventory=()=>true;let requests=0;c.onLocalBuildPlaced=()=>requests++;
 const size=world.destructibles.size;assert.equal(c.tryPlaceBuild(p,'floor',state,world,{},{}),null);
 assert.equal(requests,1);assert.equal(p.materials.stone,10);assert.equal(world.destructibles.size,size);
});
test('4.1 ramp/roof support planes follow actual mesh top faces in all cardinal orientations',()=>{
 for(const yaw of [0,Math.PI/2,Math.PI,-Math.PI/2])for(const type of ['ramp','roof']){
  const b=world.placeBuildPiece('ray',type,-180,100,yaw*10,yaw),prop=world.destructibles.get(b.id),surface=world.walkableSurfaces.find(s=>s.id===b.id);
  prop.mesh.scale.setScalar(1);prop.mesh.updateMatrixWorld(true);
  for(const distance of [-1,0,1]){
   const x=b.position.x-Math.sin(yaw)*distance,z=b.position.z-Math.cos(yaw)*distance;
   const ray=new THREE.Raycaster(new THREE.Vector3(x,110,z),new THREE.Vector3(0,-1,0));
   const hit=ray.intersectObject(prop.mesh,true)[0];assert.ok(hit);
   assert.ok(Math.abs(hit.point.y-surface.getHeight(x,z))<.02);
  }
 }
});

test('4.1 remote snapshot at zero height stays at zero; disconnected online placement reports failure, Solo does not',()=>{
 const n=new NetworkManager();n.handleServerMessage({type:'room_state',players:[{id:'remote_zero',position:{x:0,y:0,z:0},isGrounded:true}],phase:'active'});
 assert.equal(n.state.players.get('remote_zero').position.y,0);
 let rejected=0;n.onBuildRejected=()=>rejected++;
 n.sendBuildPlaced('build_offline','floor',0,80,0,0,'wood');assert.equal(rejected,0);
 n.isOnlineRoom=true;n.sendBuildPlaced('build_offline','floor',0,80,0,0,'wood');assert.equal(rejected,1);
});

test('4.1 glider side collision cannot skip thin walls during a 100ms frame',()=>{
 const p=makePlayerState({position:{x:-21.35,y:6,z:-19.8},isGrounded:false,isGliding:true});
 assert.ok(isPlayerPositionClear({},p.position));step(p,{moveZ:-1});
 assert.ok(p.position.z>-20.5,'remains on the approaching side of the parapet');
 assert.ok(isPlayerPositionClear({},p.position));
});
