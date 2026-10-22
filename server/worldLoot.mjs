import manifest from './worldLootManifest.json' with { type: 'json' };
export function createWorldLootMap() {
  return new Map(manifest.items.map(item => [item.id, structuredClone(item)]));
}
export function getChestRewards(id) { return structuredClone(manifest.chestDrops[id] || []); }
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
