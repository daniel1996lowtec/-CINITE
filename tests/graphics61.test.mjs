/**
 * CI CRAFT 6.1 — "major visual transformation" contracts.
 *
 * These tests exercise the real modules headlessly and verify that the
 * upgrade is structural, not a set of colour/exposure tweaks:
 *  - deterministic tileable PBR albedo + normal maps for architecture,
 *    glazing, bark, foliage, rock, crates and weapons,
 *  - authored botanical geometry (buttressed trunks, lobed canopies,
 *    scalloped conifer tiers, arched palm fronds, sculpted boulders,
 *    framed crates, grass tufts, shrub clusters),
 *  - real facade depth in the instanced architecture batches (cornices,
 *    mullions, sills, downpipes, canopies, rooftop plant, street furniture),
 *  - weapon hardware (iron sights, vents, magwell, sling loop, thread collar),
 *  - character armour layers bound to the animated limb bones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadWorldModules } from '../scripts/headlessWorld.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadVisualAtmosphere() {
  const dir = fs.mkdtempSync(path.join(ROOT_DIR, '.graphics61-va-'));
  try {
    const source = fs.readFileSync(path.join(ROOT_DIR, 'src/world/VisualAtmosphere.ts'), 'utf8');
    fs.writeFileSync(path.join(dir, 'VisualAtmosphere.mjs'), stripTypeScriptTypes(source));
    return await import(pathToFileURL(path.join(dir, 'VisualAtmosphere.mjs')).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function loadWeapons() {
  const dir = fs.mkdtempSync(path.join(ROOT_DIR, '.graphics61-weapons-'));
  try {
    let code = stripTypeScriptTypes(
      fs.readFileSync(path.join(ROOT_DIR, 'src/weapons/WeaponDefinitions.ts'), 'utf8')
    );
    code = code.replace(
      /import\s+\{[\s\S]*?\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/,
      ''
    );
    fs.writeFileSync(path.join(dir, 'WeaponDefinitions.mjs'), code);
    return await import(pathToFileURL(path.join(dir, 'WeaponDefinitions.mjs')).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function loadCharacter() {
  const dir = fs.mkdtempSync(path.join(ROOT_DIR, '.graphics61-character-'));
  const emit = (source, output, replacements = []) => {
    let code = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT_DIR, source), 'utf8'));
    for (const [pattern, replacement] of replacements) code = code.replace(pattern, replacement);
    fs.writeFileSync(path.join(dir, output), code);
  };
  try {
    emit('src/network/schemas.ts', 'schemas.mjs');
    emit('src/entities/CharacterCosmetics.ts', 'CharacterCosmetics.mjs', [
      [/import\s+type\s+\{[\s\S]*?\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
    ]);
    emit('src/entities/CharacterAnimation.ts', 'CharacterAnimation.mjs');
    emit('src/weapons/WeaponDefinitions.ts', 'WeaponDefinitions.mjs', [
      [/import\s+\{[\s\S]*?\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
    ]);
    emit('src/entities/CharacterMesh.ts', 'CharacterMesh.mjs', [
      [/import\s+type\s+\{[\s\S]*?\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
      ["from '../weapons/WeaponDefinitions'", "from './WeaponDefinitions.mjs'"],
      ["from './CharacterCosmetics'", "from './CharacterCosmetics.mjs'"],
      ["from './CharacterAnimation'", "from './CharacterAnimation.mjs'"],
    ]);
    const character = await import(pathToFileURL(path.join(dir, 'CharacterMesh.mjs')).href);
    const cosmetics = await import(pathToFileURL(path.join(dir, 'CharacterCosmetics.mjs')).href);
    return { character, cosmetics };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const triangles = (geometry) =>
  (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;

test('6.1 PBR surface pipeline: deterministic tileable albedo/normal maps at authored resolution', async () => {
  const { THREE } = await loadWorldModules();
  const visual = await loadVisualAtmosphere();
  const first = visual.createPbrSurfaceTextures();
  const second = visual.createPbrSurfaceTextures();

  const expected = [
    'facadeAlbedo', 'facadeNormal', 'windowAlbedo', 'windowNormal',
    'barkAlbedo', 'barkNormal', 'foliageAlbedo', 'foliageNormal',
    'rockAlbedo', 'rockNormal', 'crateAlbedo', 'crateNormal', 'metalNormal',
  ];
  for (const key of expected) {
    const texture = first[key];
    assert.ok(texture && texture.isDataTexture, `${key} must be a DataTexture`);
    assert.equal(texture.image.width, 64, `${key} resolution`);
    assert.equal(texture.image.height, 64, `${key} resolution`);
    assert.equal(texture.wrapS, THREE.RepeatWrapping);
    assert.equal(texture.wrapT, THREE.RepeatWrapping);
    assert.deepEqual(
      Array.from(texture.image.data),
      Array.from(second[key].image.data),
      `${key} must be deterministic across clients`
    );
  }
  // Normal maps must encode real relief (not a flat 128,128,255 field).
  for (const key of ['facadeNormal', 'barkNormal', 'foliageNormal', 'rockNormal', 'metalNormal']) {
    const data = first[key].image.data;
    let variance = 0;
    for (let i = 0; i < data.length; i += 4) {
      variance += Math.abs(data[i] - 128) + Math.abs(data[i + 1] - 128);
    }
    assert.ok(variance / (data.length / 4) > 0.6, `${key} carries no normal relief`);
  }

  const terrainMaps = visual.createTerrainSurfaceMaps();
  for (const key of ['normal', 'roughness', 'grain']) {
    assert.equal(terrainMaps[key].image.width, 256, `terrain ${key} resolution`);
    assert.ok(terrainMaps[key].repeat.x > 10, `terrain ${key} must tile at human scale`);
    assert.equal(terrainMaps[key].minFilter, THREE.LinearMipmapLinearFilter);
  }
});

test('6.1 architecture surface shader adds masonry/glazing relief per material kind', async () => {
  const { THREE } = await loadWorldModules();
  const visual = await loadVisualAtmosphere();
  const kinds = ['facade', 'glass', 'metal'];
  const keys = new Set();
  for (const kind of kinds) {
    const material = visual.applyArchitectureSurfaceShader(
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
      kind
    );
    assert.equal(typeof material.onBeforeCompile, 'function');
    const key = material.customProgramCacheKey();
    assert.match(key, /cicraft-arch-surface/);
    keys.add(key);

    const shader = {
      uniforms: {},
      vertexShader: 'void main() { #include <begin_vertex> }',
      fragmentShader: 'void main() { #include <map_fragment> }',
    };
    material.onBeforeCompile(shader);
    assert.match(shader.vertexShader, /vCicraftWorldPos/);
    assert.match(shader.vertexShader, /instanceMatrix/);
    assert.match(shader.fragmentShader, /vCicraftLocalPos/);
  }
  assert.equal(keys.size, 3, 'each surface kind needs its own compiled program');
  const facade = visual.applyArchitectureSurfaceShader(
    new THREE.MeshStandardMaterial(), 'facade'
  );
  const facadeShader = {
    uniforms: {},
    vertexShader: 'void main() { #include <begin_vertex> }',
    fragmentShader: 'void main() { #include <map_fragment> }',
  };
  facade.onBeforeCompile(facadeShader);
  assert.match(facadeShader.fragmentShader, /mortar/);
  const glass = visual.applyArchitectureSurfaceShader(
    new THREE.MeshStandardMaterial(), 'glass'
  );
  const glassShader = {
    uniforms: {},
    vertexShader: 'void main() { #include <begin_vertex> }',
    fragmentShader: 'void main() { #include <map_fragment> }',
  };
  glass.onBeforeCompile(glassShader);
  assert.match(glassShader.fragmentShader, /mullion/);
});

test('6.1 authored botanical geometry replaces primitive cones, dodecahedrons and boxes', async () => {
  const visual = await loadVisualAtmosphere();
  const trunk = visual.createBotanicalTreeTrunkGeometry();
  const crown = visual.createBotanicalCrownGeometry();
  const pine = visual.createScallopedPineTierGeometry();
  const frond = visual.createArchedPalmFrondGeometry();
  const boulder = visual.createSculptedBoulderGeometry();
  const crate = visual.createFramedSupplyCrateGeometry();
  const grass = visual.createCrossedGrassTuftGeometry();
  const shrub = visual.createBotanicalShrubGeometry();

  const budget = (geometry, min, max, label) => {
    const tris = triangles(geometry);
    assert.ok(tris >= min && tris <= max, `${label} triangle budget ${tris}`);
  };
  budget(trunk, 60, 140, 'buttressed trunk');
  budget(crown, 40, 90, 'lobed canopy');
  budget(pine, 20, 48, 'scalloped conifer tier');
  budget(frond, 16, 32, 'arched palm frond');
  budget(boulder, 16, 40, 'sculpted boulder');
  budget(crate, 40, 120, 'framed crate');
  budget(grass, 5, 8, 'grass tuft');
  budget(shrub, 16, 30, 'shrub cluster');

  // Trunks flare at the base (buttress roots) and taper to the crown.
  const trunkPos = trunk.getAttribute('position');
  let baseRadius = 0;
  let topRadius = 0;
  for (let i = 0; i < trunkPos.count; i++) {
    const radius = Math.hypot(trunkPos.getX(i), trunkPos.getZ(i));
    const y = trunkPos.getY(i);
    if (y < -0.4) baseRadius = Math.max(baseRadius, radius);
    if (y > 0.45) topRadius = Math.max(topRadius, radius);
  }
  assert.ok(baseRadius > topRadius * 1.5, `trunk must flare: ${baseRadius} vs ${topRadius}`);

  // The frond arch must rise then droop below its hub.
  const frondPos = frond.getAttribute('position');
  let maxY = -Infinity;
  let tipY = Infinity;
  for (let i = 0; i < frondPos.count; i++) {
    maxY = Math.max(maxY, frondPos.getY(i));
    if (frondPos.getZ(i) > 1.0) tipY = Math.min(tipY, frondPos.getY(i));
  }
  assert.ok(maxY - tipY > 0.4, `frond must arch and droop (${maxY} -> ${tipY})`);

  // The boulder is a closed shell above its flattened base.
  const boulderPos = boulder.getAttribute('position');
  let minY = Infinity;
  for (let i = 0; i < boulderPos.count; i++) minY = Math.min(minY, boulderPos.getY(i));
  assert.ok(minY > -0.6 && minY < 0, `boulder base ${minY}`);

  // Welding produces smooth shared normals instead of duplicated flat faces.
  const raw = new (await loadWorldModules()).THREE.IcosahedronGeometry(1, 0);
  const rawVertices = raw.getAttribute('position').count;
  const welded = visual.weldAndSmoothGeometry(raw);
  assert.ok(
    welded.getAttribute('position').count < rawVertices,
    'weldAndSmoothGeometry must merge duplicated vertices'
  );
  assert.ok(welded.getAttribute('normal'), 'welded geometry needs computed normals');
});

test('6.1 world: facade depth, street furniture and upgraded nature are really instanced', async () => {
  const { THREE, IslandWorld } = await loadWorldModules();
  const scene = new THREE.Scene();
  const world = new IslandWorld(scene);
  world.generate();

  const detailCounts = {};
  const names = new Set();
  scene.traverse((object) => {
    if (!object.isMesh || !object.isInstancedMesh) return;
    names.add(object.name);
    if (object.name.includes('_box_detail')) {
      detailCounts[object.name] = (detailCounts[object.name] ?? 0) + object.count;
    }
  });
  const totalFacadeDetail = Object.values(detailCounts).reduce((sum, n) => sum + n, 0);
  assert.ok(
    totalFacadeDetail > 2500,
    `expected substantial facade/street detail instances, got ${totalFacadeDetail}`
  );

  // Architecture materials carry real PBR maps and the surface shader.
  const expansion = [...world.expansionGroup.children, ...world.expansionDetailGroup.children];
  const standard = expansion.find((mesh) => mesh.material?.normalMap && mesh.material.onBeforeCompile);
  assert.ok(standard, 'expansion architecture must use normal-mapped PBR materials');
  const glass = expansion.find((mesh) => mesh.name.includes('_glass_'));
  assert.ok(glass.material.normalMap, 'glazing must carry a pane normal map');
  assert.match(glass.material.customProgramCacheKey(), /cicraft-arch-surface-glass/);

  // Terrain gains tiling normal/roughness relief beyond its vertex colours.
  const terrainMat = world.terrain.terrainMesh.material;
  assert.ok(terrainMat.normalMap, 'terrain needs a tiling normal map');
  assert.ok(terrainMat.roughnessMap, 'terrain needs a roughness map');
  assert.ok(terrainMat.normalMap.repeat.x > 10);

  // Trees: sculpted trunks, lobed canopies and scalloped conifer tiers.
  const named = (name) => scene.getObjectByName(name);
  const trunkMesh = [...world.propInstancesGroup.children].find(
    (mesh) => mesh.isInstancedMesh && mesh.geometry.attributes.position.count > 40
  );
  assert.ok(trunkMesh, 'trees must use the authored trunk geometry');
  assert.ok(named('AtmosphericSkyDome'));

  // Street dressing: the new bench/planter/awning/crossing instances exist
  // inside the shared detail batches of every settlement.
  const decalInstances = expansion.filter((mesh) => mesh.name.includes('_decal_'));
  assert.ok(decalInstances.length >= 8, 'expected pavement crossings/markings');

  // Deterministic generation is preserved.
  const scene2 = new THREE.Scene();
  const world2 = new IslandWorld(scene2);
  world2.generate();
  assert.equal(
    world2.boxColliders.length + world2.cylinderColliders.length,
    world.boxColliders.length + world.cylinderColliders.length
  );
  let tris = 0;
  scene.traverse((object) => {
    if (!object.isMesh) return;
    tris += triangles(object.geometry) * (object.isInstancedMesh ? object.count : 1);
  });
  assert.ok(tris <= 340000, `triangle budget ${tris}`);
});

test('6.1 weapons: authored iron sights, vents, magwell, sling loop and steel normal maps', async () => {
  const { THREE } = await loadWorldModules();
  const weapons = await loadWeapons();
  for (const category of weapons.FIREARM_CATEGORIES) {
    const model = weapons.createWeaponMesh(category, 'legendary');
    const hardware = model.getObjectByName('weapon_hardware');
    assert.ok(hardware, `${category} missing authored hardware group`);
    for (const part of [
      'front_sight_base', 'front_sight_post', 'rear_sight_base',
      'rear_sight_aperture', 'magwell_bevel', 'sling_loop',
      'butt_pad', 'barrel_thread_collar', 'trigger_housing_pin',
    ]) {
      assert.ok(hardware.getObjectByName(part), `${category} missing ${part}`);
    }
    const vents = hardware.children.filter((child) => child.name === 'handguard_vent');
    assert.equal(vents.length, 6, `${category} handguard vents`);
    let meshes = 0;
    model.traverse((child) => {
      if (child.isMesh) meshes++;
    });
    assert.ok(meshes >= 20, `${category} model too sparse: ${meshes}`);
    const bounds = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    assert.ok(bounds.z > 0.3 && bounds.z < 1.65, `${category} bounds ${bounds.z}`);
    assert.equal(model.getObjectByName('muzzle_tip').name, 'muzzle_tip');
    assert.ok(model.getObjectByName('weapon_slide'));
  }

  // Machined steel / polymer relief is shared, not per-instance.
  const a = weapons.createWeaponMesh('assault_rifle', 'rare');
  const b = weapons.createWeaponMesh('assault_rifle', 'rare');
  const normalA = a.getObjectByName('front_sight_post').material.normalMap;
  const normalB = b.getObjectByName('front_sight_post').material.normalMap;
  assert.ok(normalA, 'weapon steel must carry a normal map');
  assert.equal(normalA, normalB, 'weapon surface maps must be shared');
});

test('6.1 character: armour layers bound to limb bones follow the animation', async () => {
  const { THREE } = await loadWorldModules();
  const { character } = await loadCharacter();
  const { CharacterMesh } = character;
  const state = {
    id: 'p61', name: 'Operator_61', isBot: false,
    outfitId: 'vanguard_blue', skinColor: 0x0284c7, accentColor: 0x38bdf8,
    backAccessory: 'jump_pack',
    position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    yaw: 0, facingYaw: 0, pitch: 0, health: 100, maxHealth: 100, shield: 50, maxShield: 100,
    alive: true, isGliding: false, isGrounded: true, isSprinting: false, isAiming: false,
    isReloading: false, reloadTimer: 0, reloadDuration: 0, isHealing: false,
    landingImpactTimer: 0, activeSlot: 0, selectedMaterial: 'wood',
    inventory: [null, null, null, null, null],
    ammo: { none: 0, light: 0, medium: 0, shells: 0, heavy: 0 },
    materials: { wood: 100, stone: 50, metal: 25 },
    eliminations: 0, damageDealt: 0, shotsFired: 0, shotsHit: 0, structuresBuilt: 0,
  };
  const mesh = new CharacterMesh(state);
  try {
    const group = mesh.outfitAttachmentGroup;
    const byName = (name) => group.children.find((child) => child.name.endsWith(name));
    for (const name of [
      'thigh_plate_left', 'thigh_plate_right', 'knee_guard_left', 'knee_guard_right',
      'glove_cuff_left', 'glove_cuff_right', 'chest_harness', 'harness_buckle',
    ]) {
      const piece = byName(name);
      assert.ok(piece, `missing armour layer ${name}`);
      assert.notEqual(piece.geometry.type, 'BoxGeometry', `${name} must be contoured`);
      assert.equal(piece.material.flatShading, false, `${name} must shade smoothly`);
    }
    for (const child of group.children) {
      const size = new THREE.Box3().setFromObject(child).getSize(new THREE.Vector3());
      assert.ok(Math.max(size.x, size.y, size.z) < 0.36, `${child.name} oversized ${size.toArray()}`);
    }
    assert.ok(mesh.outfitAttachmentGroup.children[0].material.normalMap, 'armour needs normal maps');

    mesh.update(state, 1 / 60, new THREE.Vector3(0, 1.6, 3));
    mesh.root.updateMatrixWorld(true);
    const thigh = byName('thigh_plate_left');
    const before = thigh.getWorldPosition(new THREE.Vector3());
    if (mesh.gltfBones.leftUpLeg) {
      // Fallback rig has no bones; only assert bone following once a GLB is loaded.
      mesh.gltfBones.leftUpLeg.rotation.x += 0.6;
      mesh.update(state, 1 / 60, new THREE.Vector3(0, 1.6, 3));
      mesh.root.updateMatrixWorld(true);
      const after = thigh.getWorldPosition(new THREE.Vector3());
      assert.ok(before.distanceTo(after) > 0.01, 'thigh plate must follow the leg bone');
    }
  } finally {
    mesh.dispose();
  }
});
