/**
 * CI Craft — client-side Legendary Tower loot behavior tests.
 *
 * Loads the real LootSystem headlessly and proves that server-authoritative
 * vault items are never applied optimistically: a request is emitted once,
 * bots cannot claim them, and inventory changes occur only when the server
 * confirmation is applied.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadLootModules() {
  const tmpDir = fs.mkdtempSync(path.join(ROOT_DIR, '.legendary-tower-loot-test-'));
  const emit = (source, output, replacements = []) => {
    let code = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT_DIR, source), 'utf8'));
    for (const [pattern, replacement] of replacements) code = code.replace(pattern, replacement);
    fs.writeFileSync(path.join(tmpDir, output), code);
  };

  try {
    emit('src/weapons/WeaponDefinitions.ts', 'WeaponDefinitions.mjs', [
      [/import\s+\{[^}]*\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
    ]);
    emit('src/systems/LootSystem.ts', 'LootSystem.mjs', [
      [/import\s+\{[\s\S]*?\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
      ["from '../weapons/WeaponDefinitions'", "from './WeaponDefinitions.mjs'"],
      [/import\s+\{\s*IslandWorld\s*\}\s+from\s+['"]\.\.\/world\/IslandWorld['"];?\n?/, ''],
      [/import\s+\{\s*ParticleSystem\s*\}\s+from\s+['"]\.\/ParticleSystem['"];?\n?/, ''],
      [/import\s+\{\s*SoundManager\s*\}\s+from\s+['"]\.\.\/audio\/SoundManager['"];?\n?/, ''],
    ]);

    const THREE = await import('three');
    const lootModule = await import(pathToFileURL(path.join(tmpDir, 'LootSystem.mjs')).href);
    return { THREE, LootSystem: lootModule.LootSystem };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function inventorySlot(category, rarity = 'common', name = category) {
  return {
    weaponId: `${category}_${rarity}`,
    name,
    category,
    rarity,
    clipAmmo: 1,
    maxClipAmmo: 1,
    ammoType: category === 'sniper' ? 'heavy' : category === 'shotgun' ? 'shells' : 'medium',
    isConsumable: false,
    count: 1,
  };
}

function makePlayer(id, isBot = false) {
  return {
    id,
    isBot,
    alive: true,
    position: { x: 0, y: 51.05, z: 3.4 },
    activeSlot: 0,
    inventory: [inventorySlot('harvester', 'rare', 'CI Harvester'), null, null, null, null],
    ammo: { light: 0, medium: 0, shells: 0, heavy: 0, none: 0 },
    materials: { wood: 0, stone: 0, metal: 0 },
  };
}

const particles = { spawnLootPickupEffect() {} };
const sound = { playPickup() {} };

function towerItem(overrides = {}) {
  return {
    id: 'legendary_tower_sniper',
    itemType: 'weapon',
    weaponCategory: 'sniper',
    rarity: 'legendary',
    name: 'Legendary Rail Sniper',
    amount: 1,
    position: { x: 0, y: 51.73, z: 3.4 },
    opened: false,
    isLegendaryTowerLoot: true,
    serverAuthoritative: true,
    ...overrides,
  };
}

test('legendary tower client loot: pickup waits for server confirmation and swaps once', async () => {
  const { THREE, LootSystem } = await loadLootModules();
  const scene = new THREE.Scene();
  const loot = new LootSystem(scene);
  const state = { lootItems: new Map() };
  const player = makePlayer('local_player');

  const requests = [];
  let localCollections = 0;
  loot.onServerAuthoritativeLootRequested = (item, predictedSwappedDrop) => {
    requests.push({ item, predictedSwappedDrop });
    return true;
  };
  loot.onLocalLootCollected = () => {
    localCollections++;
  };

  const sniper = towerItem();
  loot.spawnFromItemState(state, sniper, false);
  loot.interactWithLoot(state, player, sniper, particles, sound);
  loot.interactWithLoot(state, player, sniper, particles, sound);

  assert.equal(requests.length, 1, 'pending vault request should not be sent twice');
  assert.equal(player.inventory[1], null, 'vault weapon must not be granted optimistically');
  assert.ok(state.lootItems.has(sniper.id), 'vault item should remain until confirmation');
  assert.equal(localCollections, 0);

  // Emulate the private owner snapshot that precedes the public receipt.
  player.inventory[1] = inventorySlot('sniper','legendary'); player.activeSlot = 1;
  loot.applyAuthoritativeLootCollected(state, player, sniper, particles, sound);
  assert.equal(player.inventory[1].category, 'sniper');
  assert.equal(player.inventory[1].rarity, 'legendary');
  assert.equal(player.activeSlot, 1);
  assert.ok(!state.lootItems.has(sniper.id));
  assert.equal(localCollections, 0, 'confirmed pickup must not emit a second collect request');

  // Fill the inventory and verify the predicted swap is sent to the server
  // but not spawned locally until the confirmation returns.
  player.inventory[1] = inventorySlot('pistol', 'common', 'Common Cyber Pistol');
  player.inventory[2] = inventorySlot('smg');
  player.inventory[3] = inventorySlot('shotgun');
  player.inventory[4] = inventorySlot('assault_rifle');
  player.activeSlot = 1;
  const shotgun = towerItem({
    id: 'legendary_tower_shotgun',
    weaponCategory: 'shotgun',
    name: 'Legendary Scatter Pump',
    position: { x: 3, y: 51.73, z: 2.8 },
  });
  loot.spawnFromItemState(state, shotgun, false);
  loot.interactWithLoot(state, player, shotgun, particles, sound);
  assert.equal(requests.length, 2);
  const predictedSwap = requests[1].predictedSwappedDrop;
  assert.equal(predictedSwap.weaponCategory, 'pistol');
  assert.equal(player.inventory[1].category, 'pistol');
  assert.ok(!state.lootItems.has(predictedSwap.id));

  const untouchedSlot = player.inventory[2];
  player.activeSlot = 2;
  player.inventory[1] = inventorySlot('shotgun','legendary');
  loot.applyAuthoritativeLootCollected(state, player, shotgun, particles, sound, predictedSwap);
  assert.equal(player.inventory[2], untouchedSlot, 'ACK must use reserved swap slot');
  assert.equal(player.inventory[1].category, 'shotgun');
  assert.equal(player.inventory[1].rarity, 'legendary');
  assert.equal(state.lootItems.get(predictedSwap.id).weaponCategory, 'pistol');
  assert.equal(localCollections, 0);

  // If the server accepts a vault claim but does not accept/broadcast a
  // swapped drop, the collector must not invent an invisible local copy of
  // the replaced weapon. Only the earlier server-broadcast pistol remains.
  const assaultRifle = towerItem({
    id: 'legendary_tower_assault_rifle',
    weaponCategory: 'assault_rifle',
    name: 'Legendary Pulse Rifle',
    position: { x: -3, y: 51.73, z: 2.8 },
  });
  loot.spawnFromItemState(state, assaultRifle, false);
  assert.equal(state.lootItems.size, 2);
  player.inventory[1] = inventorySlot('assault_rifle','legendary');
  loot.applyAuthoritativeLootCollected(state, player, assaultRifle, particles, sound);
  assert.equal(player.inventory[1].category, 'assault_rifle');
  assert.equal(state.lootItems.size, 1, 'server-omitted swap must not spawn locally');
  assert.equal(state.lootItems.get(predictedSwap.id).weaponCategory, 'pistol');
  assert.ok(
    ![...state.lootItems.values()].some(
      (item) => item.weaponCategory === 'shotgun' && item.rarity === 'legendary'
    ),
    'replaced legendary shotgun must not reappear as an unsynchronized local drop'
  );
  assert.equal(localCollections, 0);
});

test('legendary tower client loot: authoritative ammo auto-pickup, pending timeout, and bot exclusion', async () => {
  const { THREE, LootSystem } = await loadLootModules();
  const scene = new THREE.Scene();
  const loot = new LootSystem(scene);
  const state = { lootItems: new Map() };
  const player = makePlayer('local_player');
  player.position = { x: -3.4, y: 51.05, z: -3 };

  const requests = [];
  loot.onServerAuthoritativeLootRequested = (item) => {
    requests.push(item.id);
    return true;
  };

  const ammo = towerItem({
    id: 'legendary_tower_medium_ammo',
    itemType: 'ammo',
    weaponCategory: undefined,
    ammoType: 'medium',
    rarity: 'common',
    name: 'Medium Ammo (120)',
    amount: 120,
    position: { x: -3.4, y: 51.73, z: -3 },
  });
  loot.spawnFromItemState(state, ammo, false);
  loot.checkAutoPickups(state, player, sound, particles);
  loot.checkAutoPickups(state, player, sound, particles);
  assert.deepEqual(requests, ['legendary_tower_medium_ammo']);
  assert.equal(player.ammo.medium, 0, 'authoritative ammo must wait for server confirmation');

  player.ammo.medium = 120; // private owner snapshot
  loot.applyAuthoritativeLootCollected(state, player, ammo, particles, sound);
  assert.equal(player.ammo.medium, 120);
  loot.applyAuthoritativeLootCollected(state, player, ammo, particles, sound);
  assert.equal(player.ammo.medium, 120, "receipt replay never adds ammo");
  assert.ok(!state.lootItems.has(ammo.id));

  // If a response is lost, the pending marker expires so the player can
  // retry the still-present server item instead of being locked out forever.
  const metal = towerItem({
    id: 'legendary_tower_metal',
    itemType: 'material',
    weaponCategory: undefined,
    materialType: 'metal',
    rarity: 'uncommon',
    name: 'METAL x250',
    amount: 250,
    position: { x: -3.8, y: 51.73, z: -0.8 },
  });
  player.position = { x: -3.8, y: 51.05, z: -0.8 };
  loot.spawnFromItemState(state, metal, false);
  loot.checkAutoPickups(state, player, sound, particles);
  assert.equal(requests.length, 2);
  loot.update(4.01);
  loot.checkAutoPickups(state, player, sound, particles);
  assert.equal(requests.length, 3, 'expired pending claim should be retryable');
  assert.equal(player.materials.metal, 0);

  // Legacy client-local AI can never consume a server-owned vault item.
  const bot = makePlayer('bot_1', true);
  bot.position = { ...player.position };
  const requestCountBeforeBot = requests.length;
  loot.checkAutoPickups(state, bot, sound, particles);
  loot.interactWithLoot(state, bot, metal, particles, sound);
  assert.equal(requests.length, requestCountBeforeBot);
  assert.equal(bot.materials.metal, 0);
  assert.ok(state.lootItems.has(metal.id));
});

test('3.2 ordinary chests wait for server rewards; duplicate ACKs never mint local rolls', async()=>{
  const {THREE,LootSystem}=await loadLootModules();const loot=new LootSystem(new THREE.Scene());
  const state={lootItems:new Map()};const player=makePlayer('human');let requests=0;
  loot.onServerAuthoritativeLootRequested=()=>{requests++;return true;};
  const chest={id:'chest_0',itemType:'chest',name:'Supply Chest',rarity:'legendary',amount:1,
    position:{x:0,y:0,z:0},opened:false,serverAuthoritative:true};
  const fx={...particles,spawnChestOpenCelebration(){}};const audio={...sound,playChestOpen(){}};
  loot.spawnFromItemState(state,chest,false);
  loot.interactWithLoot(state,player,chest,fx,audio);
  assert.equal(requests,1);assert.equal(chest.opened,false);assert.equal(state.lootItems.size,1);
  const reward={...towerItem(),id:'chest_0_server_w',rarity:'rare',isLegendaryTowerLoot:false};
  loot.applyAuthoritativeLootCollected(state,player,chest,fx,audio,undefined,[reward]);
  assert.equal(state.lootItems.size,1);assert.ok(state.lootItems.has(reward.id));
  assert.equal(chest.opened,true);
  loot.applyAuthoritativeLootCollected(state,player,chest,fx,audio,undefined,[{...reward,id:'injected_second_roll'}]);
  assert.equal(state.lootItems.size,1);
});
