import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadCharacterModules() {
  const tmpDir = fs.mkdtempSync(path.join(ROOT_DIR, '.graphics51-test-'));
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
    const cosmetics = await import(
      pathToFileURL(path.join(tmpDir, 'CharacterCosmetics.mjs')).href
    );
    const character = await import(
      pathToFileURL(path.join(tmpDir, 'CharacterMesh.mjs')).href
    );
    return { THREE, cosmetics, character };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function preloadBundledRig(CharacterMesh) {
  const bytes = fs.readFileSync(path.join(ROOT_DIR, 'public/models/soldier.glb'));
  const length = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString());
  json.materials = json.materials.map(() => ({ pbrMetallicRoughness: {} }));
  delete json.images;
  delete json.textures;
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
  text.copy(padded);
  const binary = bytes.subarray(20 + length);
  const glb = Buffer.alloc(20 + padded.length + binary.length);
  bytes.copy(glb, 0, 0, 12);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(glb, 20);
  binary.copy(glb, 20 + padded.length);
  return CharacterMesh.preloadFromArrayBuffer(
    glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength)
  );
}

function makePlayerState(overrides = {}) {
  return {
    id: 'p_51',
    name: 'Operator_51',
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
      {
        weaponId: 'sniper_epic',
        name: 'Epic Rail Sniper',
        category: 'sniper',
        rarity: 'epic',
        clipAmmo: 5,
        maxClipAmmo: 5,
        ammoType: 'heavy',
        isConsumable: false,
        count: 1,
      },
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

test('CI CRAFT 5.1 character model fix: no protruding blue BoxGeometry placeholders on back or arms across outfits, postures, weapon switches, and respawns', async () => {
  const { THREE, cosmetics, character } = await loadCharacterModules();
  const { CharacterMesh } = character;
  await preloadBundledRig(CharacterMesh);

  const camera = new THREE.Vector3(0, 1.6, 3.2);
  for (const outfitId of cosmetics.OUTFIT_PRESET_IDS) {
    for (const backAccessory of ['jump_pack', 'energy_wings', 'tactical_shield', 'none']) {
      const state = makePlayerState({ outfitId, backAccessory });
      const mesh = new CharacterMesh(state);
      try {
        assert.equal(mesh.isUsingGLTF, true);

        // Verify zero BoxGeometry meshes in outfitAttachmentGroup or jumpPackGroup
        mesh.outfitAttachmentGroup.traverse((child) => {
          if (child.isMesh) {
            assert.notEqual(
              child.geometry.type,
              'BoxGeometry',
              `${child.name} must not use a boxy BoxGeometry placeholder`
            );
            assert.equal(
              child.material.flatShading,
              false,
              `${child.name} must use smooth shading`
            );
          }
        });
        mesh.jumpPackGroup.traverse((child) => {
          if (child.isMesh) {
            assert.notEqual(
              child.geometry.type,
              'BoxGeometry',
              `jumpPack child must not use BoxGeometry`
            );
          }
        });

        // Exercise Idle, Run, Sprint, Jump, Fall, Aim, Reload, Gliding, Weapon Switch, and Respawn
        const statesToTest = [
          {},
          { velocity: { x: 0, y: 0, z: -6.2 } },
          { isSprinting: true, velocity: { x: 0, y: 0, z: -9.5 } },
          { isGrounded: false, velocity: { x: 0, y: 6.5, z: 0 } },
          { isGrounded: false, velocity: { x: 0, y: -12, z: 0 } },
          { isAiming: true, pitch: 0.35 },
          { isReloading: true, reloadDuration: 2.2, reloadTimer: 1.1 },
          { isGrounded: false, isGliding: true, velocity: { x: 3, y: -7, z: -5 } },
          { activeSlot: 1 },
        ];

        for (const override of statesToTest) {
          const nextState = makePlayerState({ outfitId, backAccessory, ...override });
          for (let frame = 0; frame < 8; frame++) {
            mesh.update(nextState, 1 / 60, camera);
          }
          mesh.root.updateMatrixWorld(true);

          for (const child of mesh.outfitAttachmentGroup.children) {
            const box = new THREE.Box3().setFromObject(child);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            if (child.name.includes('pauldron')) {
              assert.ok(
                Math.abs(center.x) <= 0.25,
                `${child.name} protruded laterally (${center.x.toFixed(3)})`
              );
              assert.ok(
                center.y >= 1.25 && center.y <= 1.56,
                `${child.name} drifted vertically (${center.y.toFixed(3)})`
              );
              assert.ok(
                size.x <= 0.14 && size.y <= 0.14 && size.z <= 0.14,
                `${child.name} is oversized: ${size.toArray().map((n) => +n.toFixed(3))}`
              );
            }
          }

          if (backAccessory !== 'none') {
            const packBox = new THREE.Box3().setFromObject(mesh.jumpPackGroup);
            const packSize = packBox.getSize(new THREE.Vector3());
            assert.ok(
              packSize.x <= 0.32 && packSize.y <= 0.32 && packSize.z <= 0.22,
              `Back accessory ${backAccessory} is oversized: ${packSize.toArray()}`
            );
          }
        }

        // Verify death -> respawn cycle does not recreate artifacts
        const deadState = makePlayerState({ outfitId, backAccessory, alive: false });
        for (let i = 0; i < 25; i++) mesh.update(deadState, 1 / 60, camera);
        assert.equal(mesh.root.visible, false);

        const respawnState = makePlayerState({ outfitId, backAccessory, alive: true });
        for (let i = 0; i < 10; i++) mesh.update(respawnState, 1 / 60, camera);
        assert.equal(mesh.root.visible, true);
      } finally {
        mesh.dispose();
      }
    }
  }
});

test('CI CRAFT 5.1 parachute redesign: curved multi-cell canopy, connected suspension lines, risers, steering toggles, harness, banking, and clean landing stow', async () => {
  const { THREE, character } = await loadCharacterModules();
  const { CharacterMesh } = character;
  await preloadBundledRig(CharacterMesh);

  const camera = new THREE.Vector3(0, 1.8, 4.0);
  const state = makePlayerState({
    isGrounded: false,
    isGliding: true,
    velocity: { x: 2.5, y: -6.5, z: -5.5 },
  });
  const mesh = new CharacterMesh(state);
  try {
    for (let i = 0; i < 20; i++) {
      state.facingYaw += 0.02;
      mesh.update(state, 1 / 60, camera);
    }
    mesh.root.updateMatrixWorld(true);

    assert.equal(mesh.gliderGroup.visible, true);
    mesh.gliderGroup.traverse((child) => {
      if (child.isMesh) {
        assert.notEqual(
          child.geometry.type,
          'BoxGeometry',
          `Parachute mesh ${child.name} must not be a flat BoxGeometry`
        );
      }
    });

    const canopyMesh = mesh.gliderGroup.getObjectByName('parachute_canopy_mesh');
    assert.ok(canopyMesh, 'Missing curved parachute_canopy_mesh');
    const posAttr = canopyMesh.geometry.getAttribute('position');
    const colAttr = canopyMesh.geometry.getAttribute('color');
    assert.ok(posAttr.count > 600, `Expected rich curved canopy mesh, got ${posAttr.count} vertices`);
    assert.ok(colAttr, 'Expected multi-panel vertex colors on canopy');

    // Verify canopy is genuinely curved along span (center higher than wingtips)
    let centerMaxY = -Infinity;
    let wingtipMinY = Infinity;
    for (let i = 0; i < posAttr.count; i++) {
      const vx = posAttr.getX(i);
      const vy = posAttr.getY(i);
      if (Math.abs(vx) < 0.05) centerMaxY = Math.max(centerMaxY, vy);
      if (Math.abs(vx) > 1.2) wingtipMinY = Math.min(wingtipMinY, vy);
    }
    assert.ok(
      centerMaxY - wingtipMinY > 0.35,
      `Canopy must have significant spanwise arch curvature (delta=${centerMaxY - wingtipMinY})`
    );

    // Verify harness, risers, 12 suspension lines, and 2 steering toggles exist
    const harness = mesh.gliderGroup.getObjectByName('parachute_harness');
    assert.ok(harness, 'Missing fitted parachute_harness');
    assert.ok(mesh.gliderGroup.getObjectByName('riser_left_front'));
    assert.ok(mesh.gliderGroup.getObjectByName('riser_right_front'));
    assert.ok(mesh.gliderGroup.getObjectByName('steering_toggle_left'));
    assert.ok(mesh.gliderGroup.getObjectByName('steering_toggle_right'));
    assert.ok(mesh.gliderGroup.getObjectByName('brake_line_left'));
    assert.ok(mesh.gliderGroup.getObjectByName('brake_line_right'));
    for (let i = 0; i < 6; i++) {
      assert.ok(mesh.gliderGroup.getObjectByName(`suspension_line_front_${i}`));
      assert.ok(mesh.gliderGroup.getObjectByName(`suspension_line_rear_${i}`));
    }

    // Verify clean stowage upon landing
    state.isGliding = false;
    state.isGrounded = true;
    state.velocity = { x: 0, y: 0, z: 0 };
    mesh.update(state, 1 / 60, camera);
    assert.equal(mesh.gliderGroup.visible, false, 'Parachute must stow cleanly on landing');
  } finally {
    mesh.dispose();
  }
});
