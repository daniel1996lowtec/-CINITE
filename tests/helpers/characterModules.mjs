/**
 * Shared headless character fixture.
 *
 * The character/parachute/attachment tests all need the same thing: a real
 * rigged CharacterMesh built from the packaged soldier.glb with its textures
 * stripped so GLTFLoader can parse it in Node. Extracted verbatim from
 * graphics51.test.mjs so both suites exercise an identical rig.
 */
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function loadCharacterModules(ROOT_DIR = DEFAULT_ROOT) {
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
    const weapons = await import(
      pathToFileURL(path.join(tmpDir, 'WeaponDefinitions.mjs')).href
    );
    const character = await import(
      pathToFileURL(path.join(tmpDir, 'CharacterMesh.mjs')).href
    );
    return { THREE, cosmetics, weapons, character };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function preloadBundledRig(CharacterMesh, ROOT_DIR = DEFAULT_ROOT) {
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

export function makePlayerState(overrides = {}) {
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
