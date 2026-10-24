import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadWorldModules} from '../scripts/headlessWorld.mjs';

const {THREE, IslandWorld, layout, brandingLayout: branding, brandingModule} = await loadWorldModules();
const scene = new THREE.Scene(), world = new IslandWorld(scene);
world.generate(); scene.updateMatrixWorld(true);
const near = (a,b,epsilon=0.003) => assert.ok(Math.abs(a-b)<=epsilon, `${a} != ${b}`);
const gameplaySnapshot = () => ({
  boxes:world.boxColliders,cylinders:world.cylinderColliders,
  walkables:world.walkableSurfaces.map(s=>({...s,y:s.getHeight((s.minX+s.maxX)/2,(s.minZ+s.maxZ)/2)})),
  chests:world.chestSpawnPoints,loot:world.lootSpawnPoints,
  tower:world.legendaryTowerFloorLootItems,vault:world.legendaryTowerVaultLootItems,
  props:[...world.destructibles.values()].map(p=>[p.id,p.type,p.health,p.position]),
});

test('3.6 exact lettering, curated 20–30% coverage and existing street/district identities',()=>{
  const labels = new Set(Object.values(branding.BRANDING_DESIGNS).map(d=>d.text));
  assert.deepEqual(labels,new Set(['$CI','$CI STREET','$CI PLAZA','$CI TOWER','CI DISTRICT','CI MARKET']));
  const signs = branding.BUILDING_BRANDING;
  assert.equal(new Set(signs.map(s=>s.id)).size,signs.length);
  const selected = new Set(signs.map(s=>s.buildingId));
  const coverage = selected.size/(layout.EXPANSION_BUILDINGS.length+1);
  assert.ok(coverage>=.2&&coverage<=.3,`coverage ${coverage}`);
  assert.equal(selected.size,14);
  assert.ok(new Set(signs.map(s=>s.districtId)).size>=9);
  for(const sign of signs) {
    assert.ok(sign.buildingId===layout.LEGENDARY_TOWER.id||layout.EXPANSION_BUILDINGS.some(b=>b.id===sign.buildingId));
    assert.ok(Object.hasOwn(branding.BRANDING_DESIGNS,sign.design));
  }
  for(const marking of branding.ROAD_BRANDING) {
    const road=layout.ISLAND_ROAD_SEGMENTS.find(r=>r.id===marking.roadId);
    assert.ok(road);assert.equal(road.fromX,97);assert.equal(road.toX,97);
    assert.ok(marking.z>=Math.min(road.fromZ,road.toZ)&&marking.z<=Math.max(road.fromZ,road.toZ));
  }
  assert.equal(signs.filter(s=>s.design==='street'&&s.id.endsWith('_entry')).length,2);
  assert.equal(signs.filter(s=>s.design==='neon').length,2);
  assert.equal(signs.filter(s=>s.design==='roof').length,2);
  assert.equal(signs.filter(s=>s.design==='graffiti').length,2);
});

test('3.6 every actual instance faces outwards, rests on opaque geometry and clears glazing/doorways on High AND Low',()=>{
  const instanceById=new Map(),matrix=new THREE.Matrix4();
  for(const mesh of world.branding.group.children) if(mesh.isInstancedMesh) {
    mesh.userData.brandingIds.forEach((id,index)=>{mesh.getMatrixAt(index,matrix);instanceById.set(id,matrix.clone())});
  }
  for(const low of [false,true]) for(const sign of branding.BUILDING_BRANDING) {
    const transform=instanceById.get(sign.id);assert.ok(transform);
    const normal=new THREE.Vector3(0,0,1).transformDirection(transform);
    near(normal.x,Math.sin(sign.yaw));near(normal.z,Math.cos(sign.yaw));
    const right=new THREE.Vector3(1,0,0).transformDirection(transform);
    near(right.x,Math.cos(sign.yaw));near(right.z,-Math.sin(sign.yaw)); // Not mirrored.
    for(const u of [-.49,-.25,0,.25,.49]) for(const v of [-.49,0,.49]) {
      const point=new THREE.Vector3(u,v,0).applyMatrix4(transform);
      const ray=new THREE.Raycaster(point.clone().addScaledVector(normal,.1),normal.clone().negate(),0,.5);
      const hit=ray.intersectObjects([...world.expansionGroup.children,...(low?[]:world.expansionDetailGroup.children)],true)[0];
      assert.ok(hit,`${sign.id} unsupported (${u},${v}), low=${low}`);
      near(hit.distance,.1+branding.BRANDING_SURFACE_GAP);
      assert.ok(!hit.object.name.includes('_glass_'),`${sign.id} covers a window`);
      const supportTransform=hit.object.matrixWorld.clone();
      if(hit.object.isInstancedMesh){hit.object.getMatrixAt(hit.instanceId,matrix);supportTransform.multiply(matrix)}
      near(hit.face.normal.clone().transformDirection(supportTransform).dot(normal),1);
    }
    // All front/entry signs are above the existing doorway heights. Graffiti
    // is confined to the closed rear centre bays (no rear door on either).
    if(sign.design==='graffiti') {
      const b=layout.EXPANSION_BUILDINGS.find(b=>b.id===sign.buildingId);
      assert.equal(b.rearDoor,false);
    } else if(sign.support!=='highrise-parapet') {
      assert.ok(sign.y-sign.height/2>=3.1,sign.id);
    }
  }
});

test('3.6 road paint follows rendered terrain faces including seams; correct upward normals, UVs and road bounds',()=>{
  for(const marking of branding.ROAD_BRANDING) {
    const mesh=world.branding.group.getObjectByName(`CI_Branding_${marking.id}`);
    const p=mesh.geometry.getAttribute('position'),n=mesh.geometry.getAttribute('normal'),uv=mesh.geometry.getAttribute('uv');
    assert.ok(p.count>6); // This really crosses terrain cell boundaries, not a flat quad.
    for(let i=0;i<p.count;i++) {
      assert.ok(n.getY(i)>.9);assert.ok(uv.getX(i)>=0&&uv.getX(i)<=1&&uv.getY(i)>=0&&uv.getY(i)<=1);
      assert.ok(world.terrain.getRoadDistance(p.getX(i),p.getZ(i))<3.6);
    }
    // Vertex and face-interior rays prove support, not just metadata height.
    for(let i=0;i<p.count;i+=3) for(const weights of [[1,0,0],[0,1,0],[0,0,1],[.2,.3,.5]]) {
      const point=new THREE.Vector3();
      weights.forEach((w,k)=>point.addScaledVector(new THREE.Vector3().fromBufferAttribute(p,i+k),w));
      const ray=new THREE.Raycaster(point.clone().add(new THREE.Vector3(0,1,0)),new THREE.Vector3(0,-1,0),0,2);
      const hit=ray.intersectObjects([world.terrain.terrainMesh,world.expansionGroup,world.expansionDetailGroup],true)[0];assert.ok(hit);
      assert.equal(hit.object,world.terrain.terrainMesh,'Road paint must not be buried beneath existing pavement or curbs');
      near(hit.distance,1+branding.BRANDING_SURFACE_GAP,.0001);
    }
  }
});

test('3.6 gameplay fingerprint is byte-identical to 3.5: collision, routes, fixed loot/vaults, chests and destructibles',()=>{
  // Independently generated with git show 9515d83's loader + world modules.
  assert.equal(createHash('sha256').update(JSON.stringify(gameplaySnapshot())).digest('hex'),
    'd2b612956cdaca03533eb16628fce31fb28ceedbf4d3824e6a9655c99a194e4c');
  assert.equal(world.boxColliders.length+world.cylinderColliders.length,1414);
  const branded=new Set([world.branding.group,...world.branding.group.children]);
  assert.ok(world.raycastMeshes.every(mesh=>!branded.has(mesh)));
  let meshes=0,triangles=0;
  scene.traverse(mesh=>{if(mesh.isMesh){meshes++;triangles+=(mesh.geometry.index?.count??mesh.geometry.attributes.position.count)/3*(mesh.isInstancedMesh?mesh.count:1)}});
  assert.ok(meshes<=900);assert.ok(triangles<=300000);
  assert.ok(world.boxColliders.length+world.cylinderColliders.length<=1450);
  console.log(JSON.stringify({branding36:{meshes,triangles,colliders:1414,signs:branding.BUILDING_BRANDING.length,roadMarkings:branding.ROAD_BRANDING.length,batches:world.branding.group.children.length}}));
});

test('3.6 independent clients produce identical instance matrices/road UVs regardless of RNG',()=>{
  const originalRandom=Math.random;let other;
  try {
    Math.random=()=>.123456;
    other=new brandingModule.WorldBranding(new THREE.Scene(),world.terrain.terrainMesh.geometry,(x,z)=>world.terrain.getTerrainHeight(x,z));
  } finally {Math.random=originalRandom}
  const snapshot=group=>group.children.map(mesh=>({name:mesh.name,ids:mesh.userData.brandingIds,
    matrices:mesh.instanceMatrix?Array.from(mesh.instanceMatrix.array):null,
    positions:Array.from(mesh.geometry.getAttribute('position').array),uvs:Array.from(mesh.geometry.getAttribute('uv').array)}));
  assert.deepEqual(snapshot(world.branding.group),snapshot(other.group));other.dispose();
});

test('3.6 single POT canvas atlas, two shared materials, no shadows/lights or custom shader; idempotent GPU disposal',()=>{
  const texts=[],noop=()=>{},ctx={save:noop,restore:noop,translate:noop,scale:noop,fillRect:noop,strokeRect:noop,
    beginPath:noop,arc:noop,fill:noop,stroke:noop,moveTo:noop,lineTo:noop,strokeText:noop,
    measureText:text=>({width:text.length*45}),fillText:text=>texts.push(text)};
  const oldDocument=globalThis.document;let owner;
  try {
    globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>ctx})};
    owner=new brandingModule.WorldBranding(new THREE.Scene(),world.terrain.terrainMesh.geometry,(x,z)=>world.terrain.getTerrainHeight(x,z));
  } finally {if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument}
  assert.deepEqual(texts,Object.values(branding.BRANDING_DESIGNS).map(d=>d.text));
  const resources=new Set(),materials=new Set(),textures=new Set();
  for(const mesh of owner.group.children) {
    assert.equal(mesh.castShadow,false);assert.equal(mesh.frustumCulled,true);
    assert.equal(mesh.material.isMeshStandardMaterial,true);
    assert.equal(mesh.material.depthTest,true);assert.equal(mesh.material.depthWrite,false);
    assert.equal(mesh.material.transparent,false);assert.equal(mesh.material.alphaTest,.5);
    assert.equal(mesh.material.side,THREE.FrontSide);
    assert.equal(mesh.material.emissiveIntensity,mesh.name.endsWith('_neon')?.32:1);
    if(!mesh.name.endsWith('_neon'))assert.equal(mesh.material.emissive.getHex(),0);
    materials.add(mesh.material);textures.add(mesh.material.map);resources.add(mesh.geometry);
    if(mesh.isInstancedMesh)resources.add(mesh);
  }
  assert.equal(materials.size,2);assert.equal(textures.size,1);
  const atlas=[...textures][0];assert.equal(atlas.image.width,1024);assert.equal(atlas.image.height,1024);
  assert.equal(atlas.colorSpace,THREE.SRGBColorSpace);assert.ok(atlas.anisotropy<=2);
  for(const resource of [...materials,...textures])resources.add(resource);
  const disposed=new Map([...resources].map(resource=>[resource,0]));
  for(const resource of resources)resource.addEventListener('dispose',()=>disposed.set(resource,disposed.get(resource)+1));
  const before=JSON.stringify(gameplaySnapshot());owner.dispose();owner.dispose();
  assert.ok([...disposed.values()].every(count=>count===1));
  assert.equal(owner.group.parent,null);assert.equal(owner.group.children.length,0);
  assert.equal(JSON.stringify(gameplaySnapshot()),before);
});
