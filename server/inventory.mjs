import catalogue from './weaponCatalog.json' with { type: 'json' };
import manifest from './worldLootManifest.json' with { type: 'json' };

// Only this module writes online inventory. No client weapon/ammo/healing values
// participate in these transactions. Clocks are injectable for boundary tests.
export const weaponStats = (category, rarity) => catalogue[`${category}:${rarity}`] ?? null;
const touch = p => { p.inventoryRevision = (p.inventoryRevision || 0) + 1; };
const active = p => p.inventory?.[p.activeSlot];
function equip(p) {
  const slot = active(p);
  p.equippedCategory = slot?.category || 'harvester';
  p.equippedRarity = slot?.rarity || 'rare';
}
function slotFromItem(item) {
  const s = weaponStats(item.weaponCategory, item.rarity);
  if (!s) return null;
  return { weaponId:s.id, name:s.name, category:s.category, rarity:s.rarity,
    clipAmmo: item.inventoryDrop ? item.clipAmmo : s.clipSize, maxClipAmmo:s.clipSize,
    ammoType:s.ammoType, isConsumable:s.isConsumable, count:s.isConsumable ? item.amount : 1,
    towerProvenance:Boolean(item.towerProvenance) };
}
export function resetInventory(p) {
  const loadout = Object.hasOwn(manifest.starterLoadouts,p.starterLoadout) ? manifest.starterLoadouts[p.starterLoadout] : manifest.starterLoadouts.balanced;
  p.inventory = [['harvester','rare'],[loadout.primaryCat,loadout.primaryRarity],
    [loadout.secondaryCat,loadout.secondaryRarity]].map(([weaponCategory,rarity]) => slotFromItem({weaponCategory,rarity,amount:1}));
  p.inventory.push(null,null);
  p.ammo = { none:0, light:72, medium:90, shells:24, heavy:15 };
  p.materials = {...loadout.materials};
  p.activeSlot = 1;
  p.nextInventoryShotAt = 0;
  p.burstRemaining = 0;
  p.burstCycleEnd = 0;
  // Keep action sequence across match resets/reconnects to reject stale commands.
  p.lastInventoryActionSeq ??= 0;
  cancelInventoryAction(p);
  equip(p); touch(p);
}
export function cancelInventoryAction(p) {
  p.inventoryTask = null;
  p.isReloading = false; p.reloadTimer = 0; p.reloadDuration = 0; p.isHealing = false;
  p.burstRemaining = 0; p.serverShotCredit = null;
  touch(p);
}
export function advanceInventory(p, now = Date.now()) {
  const task = p.inventoryTask;
  if (!task) return false;
  if (!p.alive || !p.isConnected) { cancelInventoryAction(p); return true; }
  p.reloadTimer = task.kind === 'reload' ? Math.max(0,(task.endsAt-now)/1000) : 0;
  if (now < task.endsAt) return false;
  const slot = active(p);
  if (slot && task.slot === p.activeSlot && task.weaponId === slot.weaponId) {
    if (task.kind === 'reload') {
      const n = Math.min(slot.maxClipAmmo-slot.clipAmmo,p.ammo[slot.ammoType]);
      slot.clipAmmo += n; p.ammo[slot.ammoType] -= n;
    } else {
      const s = weaponStats(slot.category,slot.rarity);
      p.health = Math.min(100,p.health+(s.healAmount || 0));
      p.shield = Math.min(100,p.shield+(s.shieldAmount || 0));
      if (--slot.count === 0) { p.inventory[p.activeSlot] = null; p.activeSlot = 0; }
    }
  }
  cancelInventoryAction(p); equip(p); return true;
}
export function inventoryAction(p, action, slot, seq, now = Date.now()) {
  if (!p.inventory || !p.alive || !p.isConnected || !Number.isSafeInteger(seq) || seq <= p.lastInventoryActionSeq) return false;
  p.lastInventoryActionSeq = seq;
  advanceInventory(p,now);
  if (action === 'switch') {
    if (!Number.isInteger(slot) || slot < 0 || slot > 4) return false;
    if (slot === p.activeSlot) return true;
    cancelInventoryAction(p); p.activeSlot = slot; equip(p);
    // Switching cannot reset a weapon's cadence or accelerate a burst cycle.
    p.nextInventoryShotAt = Math.max(p.nextInventoryShotAt,p.burstCycleEnd,now+140);
    touch(p); return true;
  }
  const item = active(p);
  if (!item || p.inventoryTask) return false;
  const s = weaponStats(item.category,item.rarity);
  let duration;
  if (action === 'reload') {
    if (s.isConsumable || s.ammoType === 'none' || item.clipAmmo >= item.maxClipAmmo || p.ammo[s.ammoType] <= 0) return false;
    duration = s.reloadTime; p.isReloading = true;
    p.reloadTimer = duration; p.reloadDuration = duration;
  } else if (action === 'use') {
    if (!s.isConsumable || item.count <= 0 || !((s.healAmount && p.health < 100) || (s.shieldAmount && p.shield < 100))) return false;
    duration = s.consumeTime; p.isHealing = true;
  } else return false;
  p.burstRemaining = 0;
  p.nextInventoryShotAt = Math.max(p.nextInventoryShotAt,p.burstCycleEnd);
  p.inventoryTask = {kind:action, slot:p.activeSlot, weaponId:item.weaponId, endsAt:now+duration*1000};
  touch(p); return true;
}
export function fireInventory(p, category, rarity, now = Date.now()) {
  advanceInventory(p,now);
  const item = active(p), s = weaponStats(category,rarity);
  if (!p.alive || !p.isConnected || !item || !s || s.isConsumable || p.inventoryTask ||
      item.category !== category || item.rarity !== rarity || now < p.nextInventoryShotAt ||
      (s.ammoType !== 'none' && item.clipAmmo <= 0)) return false;
  if (s.ammoType !== 'none') item.clipAmmo--;
  if (s.fireMode === 'burst') {
    if (!p.burstRemaining || now >= p.burstCycleEnd) {
      p.burstRemaining = (s.burstCount || 3)-1;
      p.burstCycleEnd = now+1000/s.fireRate;
    } else p.burstRemaining--;
    p.nextInventoryShotAt = p.burstRemaining ? now+(s.burstIntervalSeconds || .075)*1000 : Math.max(now,p.burstCycleEnd);
  } else { p.burstRemaining = 0; p.nextInventoryShotAt = now+1000/s.fireRate; }
  touch(p); return true;
}
export function collectInventory(p, item, requestedSlot, dropId, now = Date.now()) {
  if (!p.inventory || !p.alive) return {reason:'Inventory unavailable.'};
  if (item.itemType === 'chest') return {};
  if (item.itemType === 'material') {
    if (!Object.hasOwn(p.materials,item.materialType) || p.materials[item.materialType] >= 999) return {reason:'Material reserve full or invalid.'};
    p.materials[item.materialType] = Math.min(999,p.materials[item.materialType]+item.amount); touch(p); return {};
  }
  if (item.itemType === 'ammo') {
    if (!Object.hasOwn(p.ammo,item.ammoType) || item.ammoType === 'none') return {reason:'Invalid ammo.'};
    if (p.ammo[item.ammoType] >= 999) return {reason:'Ammo reserve full.'};
    p.ammo[item.ammoType] = Math.min(999,p.ammo[item.ammoType]+item.amount); touch(p); return {};
  }
  const incoming = slotFromItem(item);
  if (!incoming) return {reason:'Invalid inventory item.'};
  if (incoming.isConsumable) {
    const stack = p.inventory.find(s => s?.category === incoming.category && s.count+incoming.count <= 3);
    if (stack) { stack.count += incoming.count; touch(p); return {}; }
  }
  let index = p.inventory.findIndex((s,i) => i > 0 && !s);
  if (index < 0) index = Number.isInteger(requestedSlot) ? requestedSlot : p.activeSlot;
  if (index < 1 || index > 4) return {reason:'Select a replaceable inventory slot.'};
  const old = p.inventory[index];
  const dropped = old ? {id:dropId, itemType:old.isConsumable?'consumable':'weapon', weaponCategory:old.category,
    rarity:old.rarity, name:old.name, amount:old.count, clipAmmo:old.clipAmmo, inventoryDrop:true,
    towerProvenance:old.towerProvenance, position:{...item.position}, opened:false, serverAuthoritative:true} : undefined;
  cancelInventoryAction(p);
  p.nextInventoryShotAt = Math.max(p.nextInventoryShotAt,p.burstCycleEnd,now+140);
  p.inventory[index] = incoming;
  p.activeSlot = index; // preserve pickup-to-equip behavior, now decided on server
  if (!item.inventoryDrop && incoming.ammoType !== 'none') {
    p.ammo[incoming.ammoType] = Math.min(999,p.ammo[incoming.ammoType]+incoming.maxClipAmmo);
  }
  equip(p); touch(p); return {dropped};
}
export function inventorySnapshot(p, now = Date.now()) {
  return {revision:p.inventoryRevision, lastActionSeq:p.lastInventoryActionSeq, processedShotSeq:p.lastInventoryShotSeq || 0,
    inventory:p.inventory, ammo:p.ammo, materials:p.materials, activeSlot:p.activeSlot,
    isReloading:p.isReloading, reloadTimer:p.reloadTimer, reloadDuration:p.reloadDuration,
    isHealing:p.isHealing, consumeDuration:p.isHealing?weaponStats(active(p).category,active(p).rarity).consumeTime:0, consumeRemaining:p.isHealing?Math.max(0,(p.inventoryTask.endsAt-now)/1000):0,
    health:p.health, shield:p.shield};
}
