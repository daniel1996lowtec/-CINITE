/**
 * CI Craft 3.0 character, weapon-model and animation contracts.
 *
 * 3.1 also loads the bundled GLB skeleton/geometry with image references
 * removed for Node. No browser/WebGL is exercised. Tests verify the pure
 * animation curves and authored weapon nodes, and assert the network/lobby
 * wiring that carries cosmetic identity without changing gameplay state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadCharacterModules() {
  const tmpDir = fs.mkdtempSync(path.join(ROOT_DIR, '.character-upgrade3-test-'));
  const emit = (source, output, replacements = []) => {
    let code = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT_DIR, source), 'utf8'));
    for (const [pattern, replacement] of replacements) code = code.replace(pattern, replacement);
    fs.writeFileSync(path.join(tmpDir, output), code);
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

    const THREE = await import('three');
    const schemas = await import(pathToFileURL(path.join(tmpDir, 'schemas.mjs')).href);
    const cosmetics = await import(
      pathToFileURL(path.join(tmpDir, 'CharacterCosmetics.mjs')).href
    );
    const animation = await import(
      pathToFileURL(path.join(tmpDir, 'CharacterAnimation.mjs')).href
    );
    const weapons = await import(
      pathToFileURL(path.join(tmpDir, 'WeaponDefinitions.mjs')).href
    );
    const character = await import(
      pathToFileURL(path.join(tmpDir, 'CharacterMesh.mjs')).href
    );
    return { THREE, schemas, cosmetics, animation, weapons, character };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function makePlayerState(overrides = {}) {
  return {
    id: 'preview_test',
    name: 'Preview_Test',
    isBot: false,
    outfitId: 'vanguard_blue',
    skinColor: 0x0284c7,
    accentColor: 0x38bdf8,
    backAccessory: 'jump_pack',
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    facingYaw: 0,
    pitch: 0,
    health: 100,
    maxHealth: 100,
    shield: 50,
    maxShield: 100,
    alive: true,
    isGliding: false,
    isGrounded: true,
    isSprinting: false,
    isAiming: false,
    isReloading: false,
    reloadTimer: 0,
    reloadDuration: 0,
    isHealing: false,
    landingImpactTimer: 0,
    activeSlot: 0,
    selectedMaterial: 'wood',
    inventory: [
      {
        weaponId: 'assault_rifle_rare',
        name: 'Rare Pulse Rifle',
        category: 'assault_rifle',
        rarity: 'rare',
        clipAmmo: 30,
        maxClipAmmo: 30,
        ammoType: 'medium',
        isConsumable: false,
        count: 1,
      },
      null,
      null,
      null,
      null,
    ],
    ammo: { none: 0, light: 60, medium: 90, shells: 24, heavy: 15 },
    materials: { wood: 100, stone: 50, metal: 25 },
    eliminations: 0,
    damageDealt: 0,
    shotsFired: 0,
    shotsHit: 0,
    structuresBuilt: 0,
    ...overrides,
  };
}

test('CI Craft 3.0 cosmetics: six synchronized outfits have distinct finishes and attachments', async () => {
  const { THREE, cosmetics, character } = await loadCharacterModules();
  const { OUTFIT_PRESET_IDS, OUTFIT_VISUAL_PROFILES, normalizeOutfitPresetId } = cosmetics;
  const { CharacterMesh } = character;

  assert.equal(OUTFIT_PRESET_IDS.length, 6);
  assert.equal(normalizeOutfitPresetId('not_a_real_outfit'), 'vanguard_blue');
  assert.equal(normalizeOutfitPresetId(undefined), 'vanguard_blue');
  assert.equal(
    new Set(OUTFIT_PRESET_IDS.map((id) => OUTFIT_VISUAL_PROFILES[id].armorStyle)).size,
    6
  );
  assert.equal(
    new Set(OUTFIT_PRESET_IDS.map((id) => OUTFIT_VISUAL_PROFILES[id].finishLabel)).size,
    6
  );

  const signatures = new Set();
  for (const outfitId of OUTFIT_PRESET_IDS) {
    const state = makePlayerState({ outfitId });
    const mesh = new CharacterMesh(state);
    try {
      assert.equal(mesh.isUsingGLTF, false, 'Node test should exercise the fallback rig');
      assert.ok(mesh.outfitAttachmentGroup, `${outfitId} needs outfit attachments`);
      assert.equal(mesh.outfitAttachmentGroup.userData.outfitId, outfitId);
      const names = [];
      mesh.outfitAttachmentGroup.traverse((child) => {
        if (child.isMesh) names.push(child.name);
      });
      assert.ok(names.length >= 5, `${outfitId} attachment count too low: ${names.length}`);
      assert.ok(names.every((name) => name.startsWith('outfit_')));
      signatures.add(names.sort().join('|'));

      mesh.update(state, 0.016, new THREE.Vector3(0, 1.5, 3));
      assert.equal(mesh.outfitAttachmentGroup.visible, true);
    } finally {
      mesh.dispose();
    }
  }
  assert.equal(signatures.size, 6, 'each outfit needs a distinct attachment signature');

  const changingState = makePlayerState();
  const changingMesh = new CharacterMesh(changingState);
  try {
    changingMesh.setCosmetics(0xbe123c, 0xfb7185, 'jump_pack', 'crimson_striker');
    assert.equal(changingMesh.outfitAttachmentGroup.userData.outfitId, 'crimson_striker');
    assert.equal(changingMesh.outfitAttachmentGroup.userData.armorStyle, 'crimson');
  } finally {
    changingMesh.dispose();
  }
});

test('CI Craft 3.0 animation curves: reload, switch, turn and locomotion stay bounded', async () => {
  const { animation } = await loadCharacterModules();

  const drop = animation.getReloadAnimationPose(1.8, 2.0, 0);
  const insert = animation.getReloadAnimationPose(1.0, 2.0, 0);
  const charge = animation.getReloadAnimationPose(0.25, 2.0, 0);
  const complete = animation.getReloadAnimationPose(0, 2.0, 0);
  assert.equal(drop.stage, 'drop');
  assert.ok(drop.magazineOffsetY < 0);
  assert.equal(insert.stage, 'insert');
  assert.ok(insert.magazineOffsetY < 0 && insert.magazineOffsetY > -0.14);
  assert.equal(charge.stage, 'charge');
  assert.ok(charge.boltPull > 0);
  assert.deepEqual(
    [complete.progress, complete.magazineOffsetY, complete.boltPull, complete.stage],
    [1, 0, 0, 'complete']
  );

  for (let remaining = 0.24; remaining >= 0; remaining -= 0.03) {
    const pose = animation.getWeaponSwitchPose(remaining, 0.24);
    assert.ok(pose.progress >= 0 && pose.progress <= 1);
    assert.ok(pose.dipY <= 0 && pose.dipY >= -0.075);
    assert.ok(pose.pitchOffset <= 1e-9 && pose.pitchOffset >= -0.95);
  }

  assert.ok(Math.abs(animation.getWeaponSwitchPose(0.24).pitchOffset) < 1e-9);
  assert.ok(Math.abs(animation.getWeaponSwitchPose(0).pitchOffset) < 1e-9);
  assert.ok(animation.getWeaponSwitchPose(0.12).pitchOffset < -0.9);

  let lean = 0;
  for (let i = 0; i < 30; i++) {
    lean = animation.getTurnLean(lean, 0.2, 0.016, 7, false);
    assert.ok(Math.abs(lean) <= 0.16);
  }
  assert.ok(lean < 0, 'positive yaw turn should lean opposite the turn direction');

  for (const speed of [0, 2, 5.5, 9]) {
    const blend = animation.getLocomotionBlend(speed, speed > 8.2, true, false);
    assert.ok(Math.abs(blend.idle + blend.walk + blend.run - 1) < 1e-9);
    assert.ok(blend.walkTimeScale > 0 && blend.runTimeScale > 0);
  }

  const rise = animation.getAirbornePose(9.7);
  const fall = animation.getAirbornePose(-14);
  assert.equal(rise.riseBlend, 1);
  assert.equal(fall.fallBlend, 1);
  assert.ok(rise.legBend > fall.legBend);
});

test('CI Craft 3.0 weapon models: profiles, muzzle anchors and authored reload nodes', async () => {
  const { THREE, weapons } = await loadCharacterModules();
  const {
    FIREARM_CATEGORIES,
    WEAPON_VISUAL_PROFILES,
    createWeaponMesh,
    getWeaponVisualProfile,
  } = weapons;

  assert.equal(Object.keys(WEAPON_VISUAL_PROFILES).length, 12);
  const lengths = new Map();
  for (const category of FIREARM_CATEGORIES) {
    const profile = getWeaponVisualProfile(category);
    assert.ok(profile.icon && profile.role && profile.silhouette);
    const model = createWeaponMesh(category, 'legendary');
    const named = { muzzle: [], mags: [], slides: [] };
    let meshCount = 0;
    model.traverse((child) => {
      if (child.isMesh) meshCount++;
      if (child.name === 'muzzle_tip') named.muzzle.push(child);
      if (child.name === 'weapon_mag') named.mags.push(child);
      if (child.name === 'weapon_slide') named.slides.push(child);
    });
    assert.equal(named.muzzle.length, 1, category);
    assert.equal(named.slides.length, 1, category);
    assert.equal(named.mags.length, category === 'shotgun' ? 0 : 1, category);
    for (const mag of named.mags) {
      assert.equal(typeof mag.userData.baseY, 'number', `${category} mag baseY`);
      assert.equal(typeof mag.userData.baseZ, 'number', `${category} mag baseZ`);
    }
    for (const slide of named.slides) {
      assert.equal(typeof slide.userData.baseZ, 'number', `${category} slide baseZ`);
    }
    assert.ok(meshCount >= 10, `${category} model is too sparse: ${meshCount}`);

    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    lengths.set(category, size.z);
    assert.ok(size.z > 0.3 && size.z < 1.65, `${category} bounds ${size.z}`);
  }
  assert.ok(lengths.get('sniper') > lengths.get('dmr'));
  assert.ok(lengths.get('dmr') > lengths.get('burst_rifle'));
  assert.ok(lengths.get('burst_rifle') > lengths.get('smg'));
  assert.ok(lengths.get('heavy_pistol') > lengths.get('pistol'));
});

test('CI Craft 3.0 shared interfaces: starter loadouts and cosmetic sync stay aligned', async () => {
  const { schemas } = await loadCharacterModules();
  const balanced = schemas.getStarterLoadoutItems('balanced');
  assert.deepEqual(
    [balanced.primaryCat, balanced.primaryRarity, balanced.secondaryCat, balanced.secondaryRarity],
    ['assault_rifle', 'uncommon', 'pistol', 'common']
  );
  balanced.materials.wood = 999;
  assert.equal(schemas.getStarterLoadoutItems('balanced').materials.wood, 100);

  const read = (relativePath) => fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8');
  const schemaSource = read('src/network/schemas.ts');
  assert.match(schemaSource, /outfitId\?: OutfitPresetId/);
  assert.match(schemaSource, /STARTER_LOADOUT_ITEMS/);

  const server = read('server/multiplayerServer.mjs');
  assert.match(server, /const roomCosmetics = sanitizeCosmetics/);
  assert.match(server, /outfitId: roomCosmetics\.outfitId/);
  assert.match(server, /outfitId: sanitizeCosmetics\(p\)\.outfitId/);
  assert.match(server, /msg\.type === 'cosmetics_update'/);

  const network = read('src/network/NetworkManager.ts');
  assert.match(network, /normalizeOutfitPresetId\(rp\.outfitId\)/);
  assert.match(network, /resolveStarterLoadoutItems\(loadout\)/);

  const characterSource = read('src/entities/CharacterMesh.ts');
  assert.match(characterSource, /rebuildOutfitAttachments/);
  assert.match(characterSource, /getReloadAnimationPose/);
  assert.match(characterSource, /getWeaponSwitchPose/);
  assert.match(characterSource, /getTurnLean/);

  const html = read('index.html');
  for (const id of [
    'preview-showcase',
    'preview-weapon-name',
    'preview-weapon-damage',
    'preview-squad-status',
    'my-lobby-ready-fill',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing lobby showcase element ${id}`);
  }
  const lobby = read('src/ui/LobbyBrowser.ts');
  assert.match(lobby, /my-lobby-player-avatar/);
  assert.match(lobby, /syncPreviewSquadStatus/);
  const main = read('src/main.ts');
  assert.match(main, /syncOperatorShowcase/);
  assert.match(main, /getStarterLoadoutItems/);
});


test('3.1 actual bundled GLB: skeleton cloning and clip evaluation (textures excluded, no WebGL)', async () => {
  const { THREE, character } = await loadCharacterModules();
  const bytes = fs.readFileSync(path.join(ROOT_DIR, 'public/models/soldier.glb'));
  const length = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString());
  assert.equal(json.skins[0].joints.length, 49);
  assert.deepEqual(json.animations.map(a => a.name).sort(), ['Idle', 'Run', 'TPose', 'Walk']);
  // Keep the actual binary geometry, inverse bind matrices and animation
  // tracks. Only image/material references are removed for Node decoding.
  json.materials = json.materials.map(() => ({ pbrMetallicRoughness: {} }));
  delete json.images; delete json.textures;
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32); text.copy(padded);
  const binary = bytes.subarray(20 + length);
  const glb = Buffer.alloc(20 + padded.length + binary.length);
  bytes.copy(glb, 0, 0, 12); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(glb, 20); binary.copy(glb, 20 + padded.length);
  const waiting = new character.CharacterMesh(makePlayerState());
  const departed = new character.CharacterMesh(makePlayerState());
  departed.dispose();
  const template = await character.CharacterMesh.preloadFromArrayBuffer(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  assert.equal(waiting.isUsingGLTF, true);
  assert.equal(departed.isUsingGLTF, false, 'late completion cannot resurrect disposed player');
  assert.equal(character.CharacterMesh.pendingInstances.size, 0);
  waiting.dispose();
  const state = makePlayerState();
  const mesh = new character.CharacterMesh(state);
  const other = new character.CharacterMesh(makePlayerState({ id: 'other' }));
  assert.equal(mesh.isUsingGLTF, true);
  assert.notEqual(mesh.gltfBones.head, other.gltfBones.head);
  const skin = mesh.gltfModelGroup.getObjectByName('vanguard_Mesh');
  const otherSkin = other.gltfModelGroup.getObjectByName('vanguard_Mesh');
  assert.equal(skin.geometry, otherSkin.geometry);
  assert.notEqual(skin.skeleton, otherSkin.skeleton);
  assert.notEqual(skin.material, otherSkin.material);
  for (const name of ['Ready', 'Sprint', 'Jump', 'Fall', 'Land', 'Aim', 'Shoot', 'Reload', 'Switch']) {
    assert.ok(template.animations.some(clip => clip.name === name));
  }
  for (let i = 0; i < 60; i++) mesh.update(state, 1/60, new THREE.Vector3(0, 1, 3));
  mesh.root.updateMatrixWorld(true);
  mesh.gltfModelGroup.traverse(o => { if (o.isSkinnedMesh) { o.skeleton.update(); o.computeBoundingBox(); } });
  const size = new THREE.Box3().setFromObject(mesh.gltfModelGroup).getSize(new THREE.Vector3());
  assert.ok(size.y > 1.65 && size.y < 2.05, `metre-scale standing rig: ${size.y}`);
  assert.ok(mesh.gltfActions.ready.getEffectiveWeight() > 0.9);
  const snapshot = JSON.stringify(state);
  mesh.update(Object.freeze(state), 1/60);
  assert.equal(JSON.stringify(state), snapshot, 'visuals do not write gameplay state');
  const camera = new THREE.Vector3(0, 1, 3);
  for (const [action, overrides] of [
    ['sprint', { isSprinting: true, velocity: { x: 0, y: 0, z: -10 } }],
    ['jump', { isGrounded: false, velocity: { x: 0, y: 7, z: 0 } }],
    ['fall', { isGrounded: false, velocity: { x: 0, y: -7, z: 0 } }],
    ['aim', { isAiming: true }],
    ['reload', { isReloading: true, reloadDuration: 4, reloadTimer: 2 }],
  ]) {
    const next = makePlayerState(overrides);
    for (let i = 0; i < 30; i++) mesh.update(next, 1/60, camera);
    assert.ok(mesh.gltfActions[action].getEffectiveWeight() > 0.9, `${action} must actually play`);
    assert.ok(Object.values(mesh.gltfBones).every(b => b.quaternion.toArray().every(Number.isFinite)));
  }
  assert.equal(mesh.gltfActions.reload.time, mesh.gltfActions.reload.getClip().duration / 2);
  mesh.triggerAttackAnimation();
  mesh.update(state, 0.04, camera);
  assert.ok(mesh.gltfActions.shoot.getEffectiveWeight() > 0);
  assert.equal(mesh.presentationState, 'fire');
  for (let i = 0; i < 30; i++) mesh.update(state, 1/60, camera);
  const muzzle = mesh.weaponSocket.getObjectByName('muzzle_tip').getWorldPosition(new THREE.Vector3());
  assert.ok(muzzle.distanceTo(mesh.getMuzzleWorldPosition(new THREE.Vector3())) < 1e-6);
  const headAttachment = mesh.outfitAttachmentGroup.children.find(o => o.name.includes('brow_fin'));
  const initialMatrix = headAttachment.matrix.clone();
  for (let i = 0; i < 20; i++) mesh.update(makePlayerState({ pitch: 0.5 }), 1/60, camera);
  assert.notDeepEqual(headAttachment.matrix.elements, initialMatrix.elements, 'head ornaments follow head rotation');
  for (let i = 0; i < 30; i++) mesh.update(makePlayerState({ alive: false }), 1/60);
  assert.equal(mesh.root.visible, false);
  mesh.update(state, 1/60, camera);
  assert.equal(mesh.root.visible, true);
  assert.equal(mesh.root.scale.x, 1);
  const mixer = mesh.mixer;
  let geometryDisposals = 0, materialDisposals = 0, textureDisposals = 0;
  skin.geometry.addEventListener('dispose', () => geometryDisposals++);
  skin.material.addEventListener('dispose', () => materialDisposals++);
  skin.skeleton.computeBoneTexture();
  skin.skeleton.boneTexture.addEventListener('dispose', () => textureDisposals++);
  mesh.dispose(); mesh.dispose();
  assert.equal(geometryDisposals, 0, 'shared GLB geometry remains available to other players');
  assert.equal(materialDisposals, 1);
  assert.equal(textureDisposals, 1);
  assert.equal(mixer.stats.actions.inUse, 0);
  assert.equal(mixer.stats.bindings.total, 0);
  other.update(state, 1/60, camera);
  other.dispose();

});


test('3.1 selection precedence, continuous reload stages and safe outfit IDs', async () => {
  const { animation, cosmetics } = await loadCharacterModules();
  const state = makePlayerState();
  assert.equal(animation.selectPresentationState(state), 'ready');
  assert.equal(animation.selectPresentationState({ ...state, alive: false }, 1, 1), 'eliminated');
  assert.equal(animation.selectPresentationState({ ...state, isReloading: true }, 1, 1), 'reload');
  assert.equal(animation.selectPresentationState(state, 1, 1), 'switch');
  assert.equal(animation.selectPresentationState(state, 1), 'fire');
  assert.equal(animation.selectPresentationState(state, 0, 0, 0.1), 'land');
  for (const boundary of [0.38, 0.72, 1]) {
    const left = animation.getReloadAnimationPose(4 * (1 - boundary + 1e-6), 4);
    const right = animation.getReloadAnimationPose(4 * (1 - boundary), 4);
    assert.ok(Math.abs(left.magazineOffsetY - right.magazineOffsetY) < 1e-5);
    assert.ok(Math.abs(left.boltPull - right.boltPull) < 1e-5);
  }
  for (const id of ['__proto__', 'constructor', 'toString', null]) {
    assert.equal(cosmetics.normalizeOutfitPresetId(id), 'vanguard_blue');
  }
});

test('3.1 failed GLB stays on fallback without repeated requests or retained instances', async () => {
  const { character } = await loadCharacterModules();
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const original = GLTFLoader.prototype.load;
  let requests = 0;
  const instances = [];
  globalThis.window = {};
  GLTFLoader.prototype.load = function (_url, _load, _progress, fail) { requests++; fail(new Error('offline')); };
  try {
    for (let i = 0; i < 4; i++) instances.push(new character.CharacterMesh(makePlayerState()));
    assert.equal(requests, 1);
    assert.equal(character.CharacterMesh.assetStatus, 'failed');
    assert.equal(character.CharacterMesh.pendingInstances.size, 0);
    assert.ok(instances.every(mesh => !mesh.isUsingGLTF));
    for (const mesh of instances) mesh.update(makePlayerState(), 1/60);
  } finally {
    for (const mesh of instances) mesh.dispose();
    GLTFLoader.prototype.load = original;
    delete globalThis.window;
  }
  await assert.rejects(character.CharacterMesh.preloadFromArrayBuffer(new ArrayBuffer(0)));
  assert.equal(character.CharacterMesh.pendingInstances.size, 0);
});

test('3.1 fallback disposal is idempotent and keeps shared weapons intact', async () => {
  const { THREE, character } = await loadCharacterModules();
  const mesh = new character.CharacterMesh(makePlayerState());
  let weaponDisposals = 0;
  mesh.weaponSocket.traverse(o => {
    if (o instanceof THREE.Mesh && !mesh.muzzleFlashMesh.getObjectById(o.id)) {
      o.geometry.addEventListener('dispose', () => weaponDisposals++);
    }
  });
  const fallback = mesh.proceduralFallbackGroup;
  const counts = new Map();
  fallback.traverse(o => {
    if (o instanceof THREE.Mesh && !mesh.weaponSocket.getObjectById(o.id) && !counts.has(o.geometry)) {
      counts.set(o.geometry, 0);
      o.geometry.addEventListener('dispose', () => counts.set(o.geometry, counts.get(o.geometry) + 1));
    }
  });
  mesh.dispose(); mesh.dispose();
  assert.ok([...counts.values()].every(count => count === 1));
  assert.equal(weaponDisposals, 0);
  mesh.upgradeToRiggedGLTFModel();
  assert.equal(mesh.root.children.length, 0);
});

test('3.4 polish: continuous gait weights, phase clock, distance budgets and cached firearm detail',async()=>{
  const {animation,weapons}=await loadCharacterModules();
  let previous=animation.getLocomotionBlend(0,false,true,false);
  for(let speed=.01;speed<12;speed+=.01){
    const blend=animation.getLocomotionBlend(speed,speed>8.2,true,false);
    assert.ok(Math.abs(blend.idle+blend.walk+blend.run-1)<1e-9);
    for(const key of ['idle','walk','run'])assert.ok(Math.abs(blend[key]-previous[key])<.02,`discontinuous ${key} at ${speed}`);
    previous=blend;
  }
  let fine=0,coarse=0;
  for(let i=0;i<60;i++)fine=animation.advanceLocomotionPhase(fine,1/60,.7);
  for(let i=0;i<5;i++)coarse=animation.advanceLocomotionPhase(coarse,.2,.7);
  assert.ok(Math.abs(fine-coarse)<1e-8);
  assert.equal(animation.getCharacterAnimationInterval(200,false,false),.2);
  assert.equal(animation.getCharacterAnimationInterval(200,false,true),.1);
  assert.equal(animation.getCharacterAnimationInterval(10,true,false),0);
  for(const category of weapons.FIREARM_CATEGORIES){
    const a=weapons.createWeaponMesh(category,'rare'),b=weapons.createWeaponMesh(category,'rare');
    const detail=a.getObjectByName('weapon_micro_details');assert.equal(detail.children.length,2);
    assert.equal(a.getObjectByName('muzzle_bore').geometry,b.getObjectByName('muzzle_bore').geometry);
    assert.equal(a.getObjectByName('receiver_pin').material,b.getObjectByName('receiver_pin').material);
    assert.ok(weapons.getSupportGrip(category).every(Number.isFinite));
    assert.ok(Math.abs(weapons.getSupportGrip(category)[2])<weapons.getWeaponVisualProfile(category).modelLength);
  }
});
