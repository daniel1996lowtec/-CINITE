import {loadGameplayModules,loadRig,makePlayerState} from '../tests/helpers/gameplayModules.mjs';
import * as THREE from 'three';
import {buildTransform} from '../server/worldGeometry.mjs';
const {NetworkManager,CharacterMesh,IslandWorld,PlayerController}=await loadGameplayModules();
const network=new NetworkManager();network.serverPlayerId='builder';let delivered=0;network.onRemoteBuildPlaced=()=>delivered++;
network.handleServerMessage({type:'build_placed',ownerId:'builder',buildId:'build_repro',pieceType:'floor',x:0,y:80,z:0,yaw:0,material:'wood'});
console.log('Accepted owner build events delivered (expected 1):',delivered);
const world=new IslandWorld(new THREE.Scene());
// The isolated floor below deliberately avoids unrelated tower platforms.
const mapWorld=new IslandWorld(new THREE.Scene());mapWorld.generate();
let mismatch;
for(let x=30;x<150&&!mismatch;x+=2){const c=mapWorld.computeBuildTransform(x,0,12,0),s=buildTransform({pieceType:'floor',x,y:0,z:12,yaw:0});if(s&&Math.abs(c.by-s.y)>.001)mismatch={client:c.by,server:s.y,x};}
console.log('Placement grid mismatch:',mismatch);
const floor=world.placeBuildPiece('test','floor',0,20,0,0,'wood');
const state=makePlayerState({position:{x:floor.position.x,y:22,z:floor.position.z},velocity:{x:0,y:-60,z:0},isGrounded:false});
const ctrl=new PlayerController();ctrl.updateCombatActions=()=>{};
const noop=()=>{};
ctrl.updateLocalPlayer(state,{dt:.1,moveX:0,moveZ:0,yaw:0,pitch:0,selectSlot:-1}, {buildables:new Map()},world,new Map(),{checkAutoPickups:noop},{spawnImpactBurst:noop},{playLand:noop},null,noop,noop);
console.log('Fall through floor (expected grounded y=20.29):',state.position.y,state.isGrounded);
await loadRig(CharacterMesh);const p=makePlayerState(),m=new CharacterMesh(p),camera=new THREE.Vector3(0,2,3);
function stats(label){m.root.updateMatrixWorld(true);console.log(label,{pose:m.presentationState,feet:[m.gltfBones.leftFoot,m.gltfBones.rightFoot].map(b=>b.getWorldPosition(new THREE.Vector3()).toArray()),land:m.gltfActions.land.getEffectiveWeight()});}
for(let i=0;i<120;i++)m.update(p,1/60,camera);stats('idle baseline');
p.isGrounded=false;p.isGliding=true;p.velocity.y=-17;for(let i=0;i<90;i++)m.update(p,1/60,camera);
p.isGrounded=true;p.isGliding=false;p.velocity.y=0;for(let i=0;i<120;i++)m.update(p,1/60,camera);stats('after landing');
m.dispose();
