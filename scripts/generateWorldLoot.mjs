/** Compile the actual map + weapon catalogue into the server's immutable loot registry.
 * Run after world changes; --check is a CI drift guard. No Three.js world on server startup. */
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadWorldModules } from './headlessWorld.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function generateWorldLoot() {
  const { THREE, IslandWorld } = await loadWorldModules();
  const world = new IslandWorld(new THREE.Scene()); world.generate();
  const tmp = fs.mkdtempSync(path.join(root, '.loot-catalogue-'));
  let weapons, schemas;
  try {
    const code = stripTypeScriptTypes(fs.readFileSync(path.join(root, 'src/weapons/WeaponDefinitions.ts'), 'utf8'))
      .replace(/import\s+\{[\s\S]*?\}\s+from\s+['"]\.\.\/network\/schemas['"];?/, '');
    fs.writeFileSync(path.join(tmp, 'weapons.mjs'), code);
    fs.writeFileSync(path.join(tmp, 'schemas.mjs'), stripTypeScriptTypes(fs.readFileSync(path.join(root, 'src/network/schemas.ts'), 'utf8')));
    weapons = await import(pathToFileURL(path.join(tmp, 'weapons.mjs')));
    schemas = await import(pathToFileURL(path.join(tmp, 'schemas.mjs')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const position = p => ({ x: p.x, y: p.y, z: p.z });
  const weapon = (id, cat, rarity, p) => {
    const stats = weapons.createWeaponStats(cat, rarity);
    return { id, itemType: stats.isConsumable ? 'consumable' : 'weapon', weaponCategory: cat,
      rarity, name: stats.name, amount: 1, position: position(p), opened: false, serverAuthoritative: true };
  };
  const ammo = (id, type, p) => ({ id, itemType: 'ammo', ammoType: type, rarity: 'common',
    name: `${type.toUpperCase()} AMMO`, amount: { light:36, medium:30, shells:12, heavy:8 }[type],
    position: position(p), opened:false, serverAuthoritative:true });
  const items = [], chestDrops = {};
  const pool = [...weapons.FIREARM_CATEGORIES, 'shield_potion', 'medkit', 'shield_potion', 'medkit'];
  // No guaranteed legendary ground rolls: riskier chests supply rare/epic
  // upgrades all over the island; the vault keeps its unique provenance.
  world.lootSpawnPoints.forEach((p,i) => {
    const cat = pool[i % pool.length];
    const rarity = cat === 'shield_potion' ? 'rare' : cat === 'medkit' ? 'uncommon'
      : ['common','uncommon','common','rare','uncommon','epic'][i % 6];
    items.push(weapon(`loot_init_${i}`, cat, rarity, p));
    const type = weapons.createWeaponStats(cat, rarity).ammoType;
    // Stack matching ammo at the validated point, not a blind offset inside a wall.
    if (type !== 'none') items.push(ammo(`ammo_init_${i}`, type, p));
  });
  world.chestSpawnPoints.forEach((p,i) => {
    const id = `chest_${i}`;
    items.push({ id, itemType:'chest', name:'Supply Chest', rarity:'legendary', amount:1,
      position:position(p), opened:false, serverAuthoritative:true });
    const cat = weapons.FIREARM_CATEGORIES[(i * 5 + 2) % weapons.FIREARM_CATEGORIES.length];
    const rarity = i % 3 === 0 ? 'epic' : 'rare';
    chestDrops[id] = [weapon(`${id}_server_w`,cat,rarity,p),
      ammo(`${id}_server_a`,weapons.createWeaponStats(cat,rarity).ammoType,p),
      weapon(`${id}_server_h`,i % 2 ? 'medkit' : 'shield_potion',i % 2 ? 'uncommon':'rare',p)];
  });
  for (const item of world.legendaryTowerFloorLootItems) items.push({...item, serverAuthoritative:true});
  return { version:1, items, chestDrops, starterLoadouts: schemas.STARTER_LOADOUT_ITEMS };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = await generateWorldLoot();
  // One record per line keeps generated diffs reviewable without hiding data.
  const text = '{\n  "version": 1,\n  "items": [\n' +
    data.items.map(item => '    ' + JSON.stringify(item)).join(',\n') +
    '\n  ],\n  "chestDrops": {\n' + Object.entries(data.chestDrops)
      .map(([id, drops]) => '    ' + JSON.stringify(id) + ': ' + JSON.stringify(drops)).join(',\n') +
    '\n  },\n  "starterLoadouts": ' + JSON.stringify(data.starterLoadouts) + '\n}\n';
  const dest = path.join(root, 'server/worldLootManifest.json');
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(dest,'utf8') !== text) throw new Error('World loot registry drift: run npm run loot:generate');
    console.log('World loot registry matches generated map and weapon catalogue');
  } else { fs.writeFileSync(dest,text); console.log('Generated',dest); }
}
