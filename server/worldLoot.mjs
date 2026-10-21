import manifest from './worldLootManifest.json' with { type: 'json' };
export function createWorldLootMap() {
  return new Map(manifest.items.map(item => [item.id, structuredClone(item)]));
}
export function getChestRewards(id) { return structuredClone(manifest.chestDrops[id] || []); }
export function resetLootOwnership(player) {
  const loadout = Object.hasOwn(manifest.starterLoadouts, player.starterLoadout)
    ? manifest.starterLoadouts[player.starterLoadout] : manifest.starterLoadouts.balanced;
  player.lootOwnership = new Map();
  for (const [category,rarity] of [[loadout.primaryCat,loadout.primaryRarity],[loadout.secondaryCat,loadout.secondaryRarity]]) {
    player.lootOwnership.set(`${category}:${rarity}`, 1);
  }
}
export function ownsLootDrop(player, drop) {
  return Number(player.lootOwnership?.get(`${drop.weaponCategory}:${drop.rarity}`) || 0) > 0;
}
export function transferLootOwnership(player, item, dropped) {
  if (!(player.lootOwnership instanceof Map)) resetLootOwnership(player);
  if (dropped) {
    const key = `${dropped.weaponCategory}:${dropped.rarity}`;
    player.lootOwnership.set(key, Math.max(0, (player.lootOwnership.get(key) || 0) - 1));
  }
  // Consumables cannot be swapped into room drops: healing remains on the
  // existing protocol, which does not prove an unused consumable instance.
  if (item.itemType === 'weapon') {
    const key = `${item.weaponCategory}:${item.rarity}`;
    player.lootOwnership.set(key, (player.lootOwnership.get(key) || 0) + 1);
  }
}
export function validateLootClaim(room, player, id) {
  const item = room.spawnedLootItems.get(id);
  if (room.collectedLootIds.has(id)) return { reason: 'Item already collected by another player.' };
  if (!item) return { reason: 'Item is not server-registered.' };
  const p = player.position;
  if (!p || ![p.x,p.y,p.z].every(Number.isFinite) || Math.hypot(
    p.x-item.position.x,p.y-item.position.y,p.z-item.position.z) > 6) {
    return { reason: 'Out of interaction range.' };
  }
  return { item };
}
