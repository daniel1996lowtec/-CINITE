import * as THREE from 'three';
import {
  AmmoType,
  BuildMaterialType,
  InventorySlot,
  LootItemState,
  MatchState,
  PlayerState,
  WeaponCategory,
  WeaponRarity,
} from '../network/schemas';
import {
  createWeaponMesh,
  createWeaponStats,
  FIREARM_CATEGORIES,
  RARITY_COLORS,
} from '../weapons/WeaponDefinitions';
import { IslandWorld } from '../world/IslandWorld';
import { ParticleSystem } from './ParticleSystem';
import { SoundManager } from '../audio/SoundManager';

interface ChestVisual {
  root: THREE.Group;
  lidPivot: THREE.Group;
  glowRing: THREE.Mesh;
  beacon: THREE.Mesh;
  coreGem: THREE.Mesh;
  openProgress: number;
  isOpened: boolean;
}

export class LootSystem {
  private scene: THREE.Scene;
  private lootMeshes: Map<string, THREE.Group> = new Map();
  private lootBeams = new Map<string, THREE.Mesh>();
  private floatingItems: Map<string, THREE.Object3D> = new Map();
  private chestVisuals: Map<string, ChestVisual> = new Map();
  private spawnPopTimers: Map<string, number> = new Map();
  public collectedIds: Set<string> = new Set();
  private time = 0;
  private frameCounter = 0;

  public onLocalLootFeedback?: (
    message: string,
    rarity: WeaponRarity,
    isSwap?: boolean,
    swappedOutName?: string
  ) => void;
  public onLocalChestOpened?: (
    chestId: string,
    spawnedDrops: LootItemState[]
  ) => void;
  public onLocalLootCollected?: (
    lootId: string,
    itemSnapshot: LootItemState,
    swappedDrop?: LootItemState
  ) => void;
  /**
   * Online registered pickups are not applied optimistically. GameEngine sends
   * this request to the server; inventory changes happen only when the
   * server's loot_collected confirmation returns.
   */
  public onServerAuthoritativeLootRequested?: (
    item: LootItemState,
    predictedSwappedDrop?: LootItemState,
    reservedSlot?: number
  ) => boolean;
  private pendingInventorySlots = new Map<string, { slot: number; swappedDrop?: LootItemState }>();
  private authoritativePendingIds: Map<string, number> = new Map();

  // Shared Geometries & Materials (eliminates ~400 redundant allocations per match)
  private readonly chestBoxGeo = new THREE.BoxGeometry(1.3, 0.56, 0.88);
  private readonly chestLockGeo = new THREE.BoxGeometry(0.22, 0.26, 0.94);
  private readonly chestLidGeo = new THREE.BoxGeometry(1.34, 0.34, 0.92);
  private readonly chestRingGeo = new THREE.RingGeometry(0.75, 1.08, 16);
  private readonly chestBeaconGeo = new THREE.CylinderGeometry(0.22, 0.55, 2.4, 10, 1, true);
  private readonly chestCoreGeo = new THREE.OctahedronGeometry(0.22, 0);
  private readonly lootRingGeo = new THREE.RingGeometry(0.42, 0.64, 16);
  private readonly ammoBoxGeo = new THREE.BoxGeometry(0.42, 0.28, 0.3);
  private readonly matBoxGeo = new THREE.BoxGeometry(0.48, 0.32, 0.48);

  private readonly chestBaseMat = new THREE.MeshStandardMaterial({
    color: 0xb45309,
    roughness: 0.5,
    flatShading: true,
  });
  private readonly chestGoldMat = new THREE.MeshStandardMaterial({
    color: 0xfacc15,
    emissive: 0xeab308,
    emissiveIntensity: 0.45,
    metalness: 0.65,
    roughness: 0.25,
    flatShading: true,
  });
  private readonly chestRingMat = new THREE.MeshBasicMaterial({
    color: 0xfacc15,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.58,
  });
  private readonly chestBeaconMat = new THREE.MeshBasicMaterial({
    color: 0xfde047,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private readonly ammoBoxMat = new THREE.MeshStandardMaterial({
    color: 0x22c55e,
    emissive: 0x15803d,
    emissiveIntensity: 0.25,
    flatShading: true,
  });
  private readonly ringMatCache: Map<WeaponRarity, THREE.MeshBasicMaterial> = new Map();
  private readonly beamGeoCache: Map<WeaponRarity, THREE.CylinderGeometry> = new Map();
  private readonly beamMatCache: Map<WeaponRarity, THREE.MeshBasicMaterial> = new Map();
  private towerBeamGeo: THREE.CylinderGeometry | null = null;
  private towerBeamMat: THREE.MeshBasicMaterial | null = null;
  private readonly matDropMatCache: Map<BuildMaterialType, THREE.MeshStandardMaterial> =
    new Map();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  public clearAll(): void {
    for (const mesh of this.lootMeshes.values()) {
      this.scene.remove(mesh);
    }
    this.lootMeshes.clear();
    this.floatingItems.clear();
    this.lootBeams.clear();
    this.chestVisuals.clear();
    this.spawnPopTimers.clear();
    this.collectedIds.clear();
    this.authoritativePendingIds.clear();
    this.pendingInventorySlots.clear();
  }

  public populateWorldLoot(
    state: MatchState,
    world: IslandWorld,
    options: { includeLegendaryTowerVaultLoot?: boolean } = {}
  ): void {
    this.clearAll();
    if (options.includeLegendaryTowerVaultLoot === false) {
      // Online ground loot, chests and tower rewards all arrive from the same
      // server registry. Never mint a local substitute while disconnected.
      state.lootItems.clear();
      return;
    }

    // 1. Spawn Golden Treasure Chests at POI Chest Points
    world.chestSpawnPoints.forEach((pt, idx) => {
      const id = `chest_${idx}`;
      const item: LootItemState = {
        id,
        itemType: 'chest',
        name: 'Supply Chest',
        rarity: 'legendary',
        amount: 1,
        position: { x: pt.x, y: pt.y, z: pt.z },
        opened: false,
      };
      state.lootItems.set(id, item);
      this.createLootMesh(item);
    });

    // 2. Spawn Ground Weapons, Consumables, Ammo & Materials at Loot Points (deterministic IDs for multiplayer sync)
    // Duplicate consumable entries preserve roughly the pre-Upgrade-2.0
    // healing frequency after expanding five firearm archetypes to nine.
    const weaponPool: WeaponCategory[] = [
      ...FIREARM_CATEGORIES,
      'shield_potion',
      'medkit',
      'shield_potion',
      'medkit',
    ];
    const rarities: WeaponRarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

    world.lootSpawnPoints.forEach((pt, idx) => {
      const cat = weaponPool[idx % weaponPool.length];
      const rar =
        cat === 'shield_potion'
          ? 'rare'
          : cat === 'medkit'
          ? 'uncommon'
          : rarities[(idx * 3) % rarities.length];

      this.spawnWeaponOrConsumableDrop(
        state,
        cat,
        rar,
        pt.x,
        pt.y,
        pt.z,
        `loot_init_${idx}`,
        false
      );

      if (cat !== 'shield_potion' && cat !== 'medkit') {
        const stats = createWeaponStats(cat, rar);
        if (stats.ammoType !== 'none') {
          this.spawnAmmoDrop(
            state,
            stats.ammoType,
            pt.x,
            pt.y,
            pt.z,
            `ammo_init_${idx}`,
            false
          );
        }
      }
    });

    // 3. Fixed tower climb rewards. Unlike generic ground points these
    // never roll a legendary weapon below the roof.
    for (const definition of world.legendaryTowerFloorLootItems) {
      this.spawnFromItemState(
        state,
        { ...definition, position: { ...definition.position } },
        false
      );
    }

    // 4. Offline vault. Online clients returned above and await the registry.
    {
      for (const definition of world.legendaryTowerVaultLootItems) {
        this.spawnFromItemState(
          state,
          {
            ...definition,
            position: { ...definition.position },
            serverAuthoritative: false,
          },
          false
        );
      }
    }
  }

  public spawnWeaponOrConsumableDrop(
    state: MatchState,
    category: WeaponCategory,
    rarity: WeaponRarity,
    x: number,
    y: number,
    z: number,
    forcedId?: string,
    spawnPop: boolean = true
  ): LootItemState {
    const id =
      forcedId || `loot_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const stats = createWeaponStats(category, rarity);
    const item: LootItemState = {
      id,
      itemType: stats.isConsumable ? 'consumable' : 'weapon',
      weaponCategory: category,
      rarity,
      name: stats.name,
      amount: 1,
      position: { x, y, z },
      opened: false,
    };
    state.lootItems.set(id, item);
    this.createLootMesh(item, spawnPop);
    return item;
  }

  public spawnAmmoDrop(
    state: MatchState,
    ammoType: AmmoType,
    x: number,
    y: number,
    z: number,
    forcedId?: string,
    spawnPop: boolean = true
  ): LootItemState {
    const id =
      forcedId || `ammo_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const amounts: Record<AmmoType, number> = {
      none: 0,
      light: 36,
      medium: 30,
      shells: 12,
      heavy: 8,
    };
    const names: Record<AmmoType, string> = {
      none: 'Ammo',
      light: 'Light Ammo',
      medium: 'Medium Ammo',
      shells: 'Shotgun Shells',
      heavy: 'Heavy Sniper Ammo',
    };

    const item: LootItemState = {
      id,
      itemType: 'ammo',
      ammoType,
      name: `${names[ammoType]} (${amounts[ammoType]})`,
      rarity: 'common',
      amount: amounts[ammoType],
      position: { x, y, z },
      opened: false,
    };
    state.lootItems.set(id, item);
    this.createLootMesh(item, spawnPop);
    return item;
  }

  public spawnMaterialDrop(
    state: MatchState,
    materialType: BuildMaterialType,
    amount: number,
    x: number,
    y: number,
    z: number,
    forcedId?: string,
    spawnPop: boolean = true
  ): LootItemState {
    const id =
      forcedId || `mat_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const item: LootItemState = {
      id,
      itemType: 'material',
      materialType,
      name: `${materialType.toUpperCase()} x${amount}`,
      rarity: 'uncommon',
      amount,
      position: { x, y, z },
      opened: false,
    };
    state.lootItems.set(id, item);
    this.createLootMesh(item, spawnPop);
    return item;
  }

  public spawnFromItemState(
    state: MatchState,
    item: LootItemState,
    spawnPop: boolean = true
  ): void {
    if (this.collectedIds.has(item.id) || state.lootItems.has(item.id)) return;
    state.lootItems.set(item.id, item);
    this.createLootMesh(item, spawnPop);
  }

  private createLootMesh(item: LootItemState, spawnPop: boolean = false): void {
    if (this.lootMeshes.has(item.id)) {
      const prev = this.lootMeshes.get(item.id)!;
      this.scene.remove(prev);
    }
    const group = new THREE.Group();
    group.position.set(item.position.x, item.position.y, item.position.z);

    const rarityInfo = RARITY_COLORS[item.rarity];

    if (item.itemType === 'chest') {
      const box = new THREE.Mesh(this.chestBoxGeo, this.chestBaseMat);
      box.position.y = 0.28;
      box.castShadow = true;

      const lock = new THREE.Mesh(this.chestLockGeo, this.chestGoldMat);
      lock.position.y = 0.52;

      const lidPivot = new THREE.Group();
      lidPivot.position.set(0, 0.56, -0.44);
      const lid = new THREE.Mesh(this.chestLidGeo, this.chestGoldMat);
      lid.position.set(0, 0.17, 0.44);
      lid.castShadow = true;
      lidPivot.add(lid);

      const coreGem = new THREE.Mesh(this.chestCoreGeo, this.chestGoldMat);
      coreGem.position.set(0, 0.52, 0);
      coreGem.name = 'chest_core_gem';

      const glowRing = new THREE.Mesh(this.chestRingGeo, this.chestRingMat);
      glowRing.rotation.x = -Math.PI / 2;
      glowRing.position.y = 0.05;
      glowRing.name = 'chest_glow_ring';

      const chestBeacon = new THREE.Mesh(this.chestBeaconGeo, this.chestBeaconMat);
      chestBeacon.position.y = 1.25;
      chestBeacon.name = 'chest_beacon';

      group.add(box, lock, lidPivot, coreGem, glowRing, chestBeacon);
      this.chestVisuals.set(item.id, {
        root: group,
        lidPivot,
        glowRing,
        beacon: chestBeacon,
        coreGem,
        openProgress: 0,
        isOpened: false,
      });
    } else {
      let ringMat = this.ringMatCache.get(item.rarity);
      if (!ringMat) {
        ringMat = new THREE.MeshBasicMaterial({
          color: rarityInfo.int,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.68,
        });
        this.ringMatCache.set(item.rarity, ringMat);
      }
      const ring = new THREE.Mesh(this.lootRingGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      ring.scale.setScalar(
        item.isLegendaryTowerLoot
          ? 1.65
          : item.rarity === 'legendary'
            ? 1.42
            : item.rarity === 'epic'
              ? 1.24
              : item.rarity === 'rare'
                ? 1.1
                : 1
      );
      group.add(ring);

      if (item.itemType === 'weapon' || item.itemType === 'consumable') {
        const beamH = item.isLegendaryTowerLoot
          ? 6.4
          : item.rarity === 'legendary'
            ? 3.4
            : item.rarity === 'epic'
              ? 2.6
              : item.rarity === 'rare'
                ? 2.0
                : 1.35;
        let beamGeo: THREE.CylinderGeometry | undefined;
        let beamMat: THREE.MeshBasicMaterial | undefined;
        if (item.isLegendaryTowerLoot) {
          if (!this.towerBeamGeo) {
            this.towerBeamGeo = new THREE.CylinderGeometry(0.24, 0.68, beamH, 12, 1, true);
          }
          if (!this.towerBeamMat) {
            this.towerBeamMat = new THREE.MeshBasicMaterial({
              color: 0xfacc15,
              transparent: true,
              opacity: 0.36,
              side: THREE.DoubleSide,
              depthWrite: false,
              blending: THREE.AdditiveBlending,
              fog: false,
            });
          }
          beamGeo = this.towerBeamGeo;
          beamMat = this.towerBeamMat;
        } else {
          beamGeo = this.beamGeoCache.get(item.rarity);
          if (!beamGeo) {
            beamGeo = new THREE.CylinderGeometry(0.16, 0.44, beamH, 10, 1, true);
            this.beamGeoCache.set(item.rarity, beamGeo);
          }
          beamMat = this.beamMatCache.get(item.rarity);
          if (!beamMat) {
            const beamOpacity =
              item.rarity === 'legendary'
                ? 0.4
                : item.rarity === 'epic'
                  ? 0.3
                  : item.rarity === 'rare'
                    ? 0.21
                    : 0.13;
            beamMat = new THREE.MeshBasicMaterial({
              color: rarityInfo.int,
              transparent: true,
              opacity: beamOpacity,
              side: THREE.DoubleSide,
              depthWrite: false,
              blending: THREE.AdditiveBlending,
              fog: false,
            });
            this.beamMatCache.set(item.rarity, beamMat);
          }
        }
        const beam = new THREE.Mesh(beamGeo, beamMat);
        beam.position.y = beamH / 2 + 0.05;
        beam.userData.longRange = item.rarity === 'epic' || item.rarity === 'legendary';
        this.lootBeams.set(item.id, beam);
        group.add(beam);
      }

      if (item.itemType === 'weapon' || item.itemType === 'consumable') {
        const wMesh = createWeaponMesh(item.weaponCategory || 'assault_rifle', item.rarity);
        wMesh.position.y = 0.48;
        wMesh.scale.setScalar(item.isLegendaryTowerLoot ? 1.58 : 1.3);
        wMesh.name = 'floating_item';
        group.add(wMesh);
        this.floatingItems.set(item.id, wMesh);
      } else if (item.itemType === 'ammo') {
        const ammoBox = new THREE.Mesh(this.ammoBoxGeo, this.ammoBoxMat);
        ammoBox.position.y = 0.36;
        ammoBox.name = 'floating_item';
        group.add(ammoBox);
        this.floatingItems.set(item.id, ammoBox);
      } else if (item.itemType === 'material') {
        const mType = item.materialType || 'wood';
        let matDropMat = this.matDropMatCache.get(mType);
        if (!matDropMat) {
          const matColor =
            mType === 'wood' ? 0xd97706 : mType === 'stone' ? 0x94a3b8 : 0x38bdf8;
          matDropMat = new THREE.MeshStandardMaterial({ color: matColor, flatShading: true });
          this.matDropMatCache.set(mType, matDropMat);
        }
        const matMesh = new THREE.Mesh(this.matBoxGeo, matDropMat);
        matMesh.position.y = 0.36;
        matMesh.name = 'floating_item';
        group.add(matMesh);
        this.floatingItems.set(item.id, matMesh);
      }
    }

    const floating = this.floatingItems.get(item.id);
    if (floating) {
      // Visual separation only: server pickup coordinates stay at the tested
      // point instead of scattering ammunition into surrounding collision.
      floating.position.x = item.itemType === 'ammo' ? 0.3 : item.itemType === 'consumable' ? -0.3 : 0;
      floating.userData.baseLift = (item.id.includes('_server_') || item.id.includes('_drop_')) ? 1.05 : item.itemType === 'ammo' ? 0.28 : 0.48;
    }
    if (spawnPop) {
      group.scale.setScalar(0.22);
      this.spawnPopTimers.set(item.id, 0.28);
    }

    this.scene.add(group);
    this.lootMeshes.set(item.id, group);
  }

  public removeLootItem(state: MatchState, id: string): void {
    this.collectedIds.add(id);
    state.lootItems.delete(id);
    const mesh = this.lootMeshes.get(id);
    if (mesh) {
      this.scene.remove(mesh);
      this.lootMeshes.delete(id);
    }
    this.floatingItems.delete(id);
    this.lootBeams.delete(id);
    this.chestVisuals.delete(id);
    this.spawnPopTimers.delete(id);
    this.authoritativePendingIds.delete(id);
    this.pendingInventorySlots.delete(id);
  }

  public clearAuthoritativeLootPending(lootId: string): void {
    this.authoritativePendingIds.delete(lootId);
    this.pendingInventorySlots.delete(lootId);
  }

  public findNearestInteractable(
    state: MatchState,
    px: number,
    py: number,
    pz: number,
    maxDist = 3.6
  ): LootItemState | null {
    let best: LootItemState | null = null;
    let bestDist = maxDist;

    for (const item of state.lootItems.values()) {
      if (
        item.opened ||
        this.collectedIds.has(item.id) ||
        this.authoritativePendingIds.has(item.id)
      ) {
        continue;
      }
      const d = Math.hypot(item.position.x - px, item.position.y - py, item.position.z - pz);
      if (d < bestDist) {
        bestDist = d;
        best = item;
      }
    }
    return best;
  }

  public checkAutoPickups(
    state: MatchState,
    player: PlayerState,
    sound: SoundManager,
    particles?: ParticleSystem
  ): void {
    if (!player.alive) return;
    let toRemove: LootItemState[] | null = null;

    for (const item of state.lootItems.values()) {
      if (item.opened || this.collectedIds.has(item.id)) continue;
      if (item.itemType !== 'ammo' && item.itemType !== 'material') continue;
      if (item.serverAuthoritative) {
        if (player.isBot || this.authoritativePendingIds.has(item.id)) continue;
        const dxAuth = item.position.x - player.position.x;
        const dzAuth = item.position.z - player.position.z;
        if (
          dxAuth * dxAuth + dzAuth * dzAuth < 4.84 &&
          Math.abs(item.position.y - player.position.y) < 2.2 &&
          this.onServerAuthoritativeLootRequested?.(item)
        ) {
          this.authoritativePendingIds.set(item.id, this.time);
        }
        continue;
      }
      const dx = item.position.x - player.position.x;
      const dz = item.position.z - player.position.z;
      if (dx * dx + dz * dz < 4.84 && Math.abs(item.position.y - player.position.y) < 2.2) {
        if (item.itemType === 'ammo' && item.ammoType && item.ammoType !== 'none') {
          player.ammo[item.ammoType] += item.amount;
        } else if (item.itemType === 'material' && item.materialType) {
          player.materials[item.materialType] = Math.min(
            999,
            player.materials[item.materialType] + item.amount
          );
        }
        if (!player.isBot) {
          sound.playPickup(false, false);
          this.onLocalLootFeedback?.(`+${item.name}`, item.rarity, false);
        }
        if (particles) {
          const col =
            item.itemType === 'ammo'
              ? 0x22c55e
              : item.materialType === 'metal'
              ? 0x38bdf8
              : item.materialType === 'stone'
              ? 0x94a3b8
              : 0xd97706;
          particles.spawnLootPickupEffect(
            new THREE.Vector3(item.position.x, item.position.y, item.position.z),
            col
          );
        }
        if (!toRemove) toRemove = [];
        toRemove.push(item);
      }
    }

    if (toRemove) {
      for (let i = 0; i < toRemove.length; i++) {
        const picked = toRemove[i];
        this.removeLootItem(state, picked.id);
        if (!player.isBot) {
          this.onLocalLootCollected?.(picked.id, picked);
        }
      }
    }
  }

  private buildWeaponOrConsumableItem(
    category: WeaponCategory,
    rarity: WeaponRarity,
    x: number,
    y: number,
    z: number,
    id: string
  ): LootItemState {
    const stats = createWeaponStats(category, rarity);
    return {
      id,
      itemType: stats.isConsumable ? 'consumable' : 'weapon',
      weaponCategory: category,
      rarity,
      name: stats.name,
      amount: 1,
      position: { x, y, z },
      opened: false,
    };
  }

  private predictSwappedDrop(
    player: PlayerState,
    item: LootItemState
  ): LootItemState | undefined {
    if (
      (item.itemType !== 'weapon' && item.itemType !== 'consumable') ||
      !item.weaponCategory
    ) {
      return undefined;
    }
    const stats = createWeaponStats(item.weaponCategory, item.rarity);
    if (stats.isConsumable) {
      for (let i = 1; i < 5; i++) {
        const slot = player.inventory[i];
        if (slot && slot.category === item.weaponCategory && slot.count < 3) {
          return undefined;
        }
      }
    }
    for (let i = 1; i < 5; i++) {
      if (!player.inventory[i]) return undefined;
    }
    const targetSlot = player.activeSlot === 0 ? 1 : player.activeSlot;
    const oldSlot = player.inventory[targetSlot];
    if (!oldSlot) return undefined;
    return this.buildWeaponOrConsumableItem(
      oldSlot.category,
      oldSlot.rarity,
      player.position.x + 0.8,
      player.position.y,
      player.position.z + 0.8,
      `swap_${player.id}_${Date.now().toString(36)}`
    );
  }

  /** Applies a registered pickup only after the room server confirms the claim. */
  public applyAuthoritativeLootCollected(
    state: MatchState,
    player: PlayerState,
    authoritativeItem: LootItemState,
    particles: ParticleSystem,
    sound: SoundManager,
    swappedDrop?: LootItemState,
    spawnedDrops?: LootItemState[]
  ): void {

    this.pendingInventorySlots.delete(authoritativeItem.id);
    this.authoritativePendingIds.delete(authoritativeItem.id);
    if (this.collectedIds.has(authoritativeItem.id)) return;
    if (authoritativeItem.itemType === 'chest') {
      this.applyRemoteLootCollected(state, authoritativeItem.id, 'chest', spawnedDrops,
        undefined, particles, sound, new THREE.Vector3(player.position.x, player.position.y, player.position.z));
      this.onLocalLootFeedback?.('SUPPLY CACHE OPENED', 'rare');
      return;
    }
    // Private inventory_state precedes this receipt. Receipts only reconcile
    // world presentation: replaying one cannot grant another magazine or stack.
    this.applyRemoteLootCollected(state, authoritativeItem.id, authoritativeItem.itemType,
      spawnedDrops, swappedDrop, particles, sound,
      new THREE.Vector3(player.position.x, player.position.y, player.position.z));
    sound.playPickup(false,['rare','epic','legendary'].includes(authoritativeItem.rarity));
    this.onLocalLootFeedback?.(authoritativeItem.name, authoritativeItem.rarity, Boolean(swappedDrop));
  }

  public interactWithLoot(
    state: MatchState,
    player: PlayerState,
    item: LootItemState,
    particles: ParticleSystem,
    sound: SoundManager,
    authoritativeOptions?: {
      confirmed?: boolean;
      reservedSlot?: number;
      swappedDropAlreadySpawned?: LootItemState;
    }
  ): void {
    if (this.collectedIds.has(item.id)) return;
    if (player.isBot && item.serverAuthoritative) return;
    if (item.serverAuthoritative && !authoritativeOptions?.confirmed) {
      if (this.authoritativePendingIds.has(item.id)) return;
      const inventoryItem = item.itemType === 'weapon' || item.itemType === 'consumable';
      // Only one inventory-changing request in flight. Remember the intended
      // slot so changing the equipped slot while waiting cannot duplicate a swap.
      if (inventoryItem && this.pendingInventorySlots.size > 0) return;
      const predictedSwappedDrop = this.predictSwappedDrop(player, item);
      if (
        this.onServerAuthoritativeLootRequested?.(item, predictedSwappedDrop,
          predictedSwappedDrop ? (player.activeSlot === 0 ? 1 : player.activeSlot) : undefined)
      ) {
        this.authoritativePendingIds.set(item.id, this.time);
        if (inventoryItem) this.pendingInventorySlots.set(item.id, {
          slot: predictedSwappedDrop ? (player.activeSlot === 0 ? 1 : player.activeSlot) : -1,
          swappedDrop: predictedSwappedDrop,
        });
      }
      return;
    }
    if (authoritativeOptions?.confirmed) {
      this.authoritativePendingIds.delete(item.id);
    }
    const notifyLocalCollection = !authoritativeOptions?.confirmed;

    if (item.itemType === 'chest') {
      if (item.opened) return;
      item.opened = true;
      this.collectedIds.add(item.id);
      if (!player.isBot) sound.playChestOpen();

      const rarities: WeaponRarity[] = ['uncommon', 'rare', 'epic', 'legendary'];
      const chosenRarity = rarities[Math.floor(Math.random() * rarities.length)];
      const weapons: readonly WeaponCategory[] = FIREARM_CATEGORIES;
      const chosenWeapon = weapons[Math.floor(Math.random() * weapons.length)];
      const stats = createWeaponStats(chosenWeapon, chosenRarity);
      const rarityInfo = RARITY_COLORS[chosenRarity];

      particles.spawnChestOpenCelebration(
        new THREE.Vector3(item.position.x, item.position.y, item.position.z),
        rarityInfo.int
      );

      const chestVis = this.chestVisuals.get(item.id);
      if (chestVis) {
        chestVis.isOpened = true;
        chestVis.beacon.visible = false;
        chestVis.glowRing.visible = false;
      }

      const spawnedDrops: LootItemState[] = [];
      const basePrefix = `${item.id}_drop_${Date.now().toString(36)}`;

      spawnedDrops.push(
        this.spawnWeaponOrConsumableDrop(
          state,
          chosenWeapon,
          chosenRarity,
          item.position.x,
          item.position.y,
          item.position.z,
          `${basePrefix}_w`,
          true
        )
      );
      if (stats.ammoType !== 'none') {
        spawnedDrops.push(
          this.spawnAmmoDrop(
            state,
            stats.ammoType,
            item.position.x,
            item.position.y,
            item.position.z,
            `${basePrefix}_a`,
            true
          )
        );
      }
      spawnedDrops.push(
        this.spawnWeaponOrConsumableDrop(
          state,
          Math.random() < 0.65 ? 'shield_potion' : 'medkit',
          'rare',
          item.position.x,
          item.position.y,
          item.position.z,
          `${basePrefix}_c`,
          true
        )
      );
      spawnedDrops.push(
        this.spawnMaterialDrop(
          state,
          'wood',
          30,
          item.position.x,
          item.position.y,
          item.position.z,
          `${basePrefix}_m`,
          true
        )
      );

      state.lootItems.delete(item.id);
      if (!player.isBot) {
        this.onLocalLootFeedback?.(
          `CHEST OPENED: ${stats.name}`,
          chosenRarity,
          false
        );
        this.onLocalChestOpened?.(item.id, spawnedDrops);
      }
      return;
    }

    const rarityInfo = RARITY_COLORS[item.rarity];
    const isHighRarity =
      item.rarity === 'rare' || item.rarity === 'epic' || item.rarity === 'legendary';

    if (item.itemType === 'ammo' && item.ammoType && item.ammoType !== 'none') {
      player.ammo[item.ammoType] += item.amount;
      if (!player.isBot) {
        sound.playPickup(false, false);
        this.onLocalLootFeedback?.(`+${item.name}`, item.rarity, false);
        if (notifyLocalCollection) this.onLocalLootCollected?.(item.id, item);
      }
      particles.spawnLootPickupEffect(
        new THREE.Vector3(item.position.x, item.position.y, item.position.z),
        0x22c55e
      );
      this.removeLootItem(state, item.id);
      return;
    }

    if (item.itemType === 'material' && item.materialType) {
      player.materials[item.materialType] = Math.min(
        999,
        player.materials[item.materialType] + item.amount
      );
      if (!player.isBot) {
        sound.playPickup(false, false);
        this.onLocalLootFeedback?.(`+${item.name}`, item.rarity, false);
        if (notifyLocalCollection) this.onLocalLootCollected?.(item.id, item);
      }
      particles.spawnLootPickupEffect(
        new THREE.Vector3(item.position.x, item.position.y, item.position.z),
        rarityInfo.int
      );
      this.removeLootItem(state, item.id);
      return;
    }

    if (
      (item.itemType === 'weapon' || item.itemType === 'consumable') &&
      item.weaponCategory
    ) {
      const stats = createWeaponStats(item.weaponCategory, item.rarity);

      if (stats.isConsumable) {
        for (let i = 1; i < 5; i++) {
          const slot = player.inventory[i];
          if (slot && slot.category === item.weaponCategory && slot.count < 3) {
            slot.count++;
            if (!player.isBot) {
              sound.playPickup(false, isHighRarity);
              this.onLocalLootFeedback?.(
                `PICKED UP ${stats.name} (x${slot.count})`,
                item.rarity,
                false
              );
              if (notifyLocalCollection) this.onLocalLootCollected?.(item.id, item);
            }
            particles.spawnLootPickupEffect(
              new THREE.Vector3(item.position.x, item.position.y, item.position.z),
              rarityInfo.int
            );
            this.removeLootItem(state, item.id);
            return;
          }
        }
      }

      const reservedSlot = authoritativeOptions?.reservedSlot ?? -1;
      let targetSlot = reservedSlot;
      for (let i = 1; targetSlot === -1 && i < 5; i++) {
        if (!player.inventory[i]) {
          targetSlot = i;
          break;
        }
      }

      let swappedDrop: LootItemState | undefined;
      let swappedOutName: string | undefined;

      if (targetSlot === -1 || reservedSlot >= 1) {
        targetSlot = reservedSlot >= 1 ? reservedSlot : player.activeSlot === 0 ? 1 : player.activeSlot;
        const oldSlot = player.inventory[targetSlot];
        if (oldSlot) {
          swappedOutName = oldSlot.name;
          // A confirmed server-authoritative pickup may only materialize
          // the swap drop the server actually accepted and broadcast. If
          // the server omitted it (for example because the client could not
          // prove ownership of a unique tower weapon), spawning a local
          // fallback here would create an invisible, unsynchronized item
          // that only this client could pick up again.
          swappedDrop = authoritativeOptions?.confirmed
            ? authoritativeOptions.swappedDropAlreadySpawned
            : this.spawnWeaponOrConsumableDrop(
                state,
                oldSlot.category,
                oldSlot.rarity,
                player.position.x + 0.8,
                player.position.y,
                player.position.z + 0.8,
                `swap_${player.id}_${Date.now().toString(36)}`,
                true
              );
        }
      }

      const newSlot: InventorySlot = {
        weaponId: stats.id,
        name: stats.name,
        category: stats.category,
        rarity: stats.rarity,
        clipAmmo: stats.clipSize,
        maxClipAmmo: stats.clipSize,
        ammoType: stats.ammoType,
        isConsumable: stats.isConsumable,
        count: 1,
      };

      player.inventory[targetSlot] = newSlot;
      if (!player.isBot) {
        player.activeSlot = targetSlot;
        sound.playPickup(false, isHighRarity);
        this.onLocalLootFeedback?.(
          swappedOutName
            ? `SWAPPED ${swappedOutName} -> ${stats.name}`
            : `EQUIPPED ${stats.name}`,
          item.rarity,
          Boolean(swappedOutName),
          swappedOutName
        );
        if (notifyLocalCollection) {
          this.onLocalLootCollected?.(item.id, item, swappedDrop);
        }
      }

      if (stats.ammoType !== 'none') {
        player.ammo[stats.ammoType] += stats.clipSize;
      }

      particles.spawnLootPickupEffect(
        new THREE.Vector3(item.position.x, item.position.y, item.position.z),
        rarityInfo.int
      );
      this.removeLootItem(state, item.id);
    }
  }

  public applyRemoteLootCollected(
    state: MatchState,
    lootId: string,
    itemType: string,
    spawnedDrops?: LootItemState[],
    swappedDrop?: LootItemState,
    particles?: ParticleSystem,
    sound?: SoundManager,
    localPlayerPos?: THREE.Vector3
  ): void {
    const existing = state.lootItems.get(lootId);
    this.collectedIds.add(lootId);

    if (itemType === 'chest') {
      if (existing) {
        existing.opened = true;
      }
      const chestVis = this.chestVisuals.get(lootId);
      if (chestVis) {
        chestVis.isOpened = true;
        chestVis.beacon.visible = false;
        chestVis.glowRing.visible = false;
        if (particles) {
          particles.spawnChestOpenCelebration(chestVis.root.position, 0xfacc15);
        }
        if (sound && localPlayerPos) {
          const dist = chestVis.root.position.distanceTo(localPlayerPos);
          if (dist < 42) {
            sound.playChestOpen();
          }
        }
      }
      state.lootItems.delete(lootId);
      if (spawnedDrops && Array.isArray(spawnedDrops)) {
        for (const drop of spawnedDrops) {
          this.spawnFromItemState(state, drop, true);
        }
      }
      return;
    }

    if (existing && particles) {
      const rarityInfo = RARITY_COLORS[existing.rarity || 'common'];
      particles.spawnLootPickupEffect(
        new THREE.Vector3(existing.position.x, existing.position.y, existing.position.z),
        rarityInfo.int
      );
    }
    this.removeLootItem(state, lootId);

    if (swappedDrop) {
      this.spawnFromItemState(state, swappedDrop, true);
    }
  }

  public syncRoomLootState(
    state: MatchState,
    collectedIds: string[],
    spawnedItems: LootItemState[]
  ): void {
    for (const id of collectedIds) {
      // A reconnect may arrive between server acceptance and our inventory ACK.
      // Request that collector's receipt before marking its reservation collected.
      if (this.pendingInventorySlots.has(id)) continue;
      this.collectedIds.add(id);
      const item = state.lootItems.get(id);
      if (item && item.itemType === 'chest') {
        item.opened = true;
        const chestVis = this.chestVisuals.get(id);
        if (chestVis) {
          chestVis.isOpened = true;
          chestVis.openProgress = 1;
          chestVis.lidPivot.rotation.x = -1.35;
          chestVis.beacon.visible = false;
          chestVis.glowRing.visible = false;
        }
        state.lootItems.delete(id);
      } else {
        this.removeLootItem(state, id);
      }
    }

    for (const drop of spawnedItems) {
      if (!this.collectedIds.has(drop.id) && !state.lootItems.has(drop.id)) {
        this.spawnFromItemState(state, drop, false);
      }
    }
    for (const [id, reservation] of this.pendingInventorySlots) {
      const pending = state.lootItems.get(id);
      if (pending) this.onServerAuthoritativeLootRequested?.(pending, reservation.swappedDrop, reservation.slot >= 1 ? reservation.slot : undefined);
    }
  }

  public dropEliminatedPlayerLoot(state: MatchState, victim: PlayerState): void {
    const px = victim.position.x;
    const py = victim.position.y;
    const pz = victim.position.z;

    for (let i = 1; i < 5; i++) {
      const slot = victim.inventory[i];
      if (slot) {
        const angle = (i / 4) * Math.PI * 2;
        this.spawnWeaponOrConsumableDrop(
          state,
          slot.category,
          slot.rarity,
          px + Math.cos(angle) * 1.4,
          py,
          pz + Math.sin(angle) * 1.4,
          `elim_${victim.id}_slot_${i}_${Date.now().toString(36)}`,
          true
        );
      }
    }

    if (victim.materials.wood >= 20) {
      this.spawnMaterialDrop(
        state,
        'wood',
        30,
        px - 1.1,
        py,
        pz,
        `elim_${victim.id}_wood_${Date.now().toString(36)}`,
        true
      );
    }
    if (victim.materials.stone >= 15) {
      this.spawnMaterialDrop(
        state,
        'stone',
        25,
        px + 1.1,
        py,
        pz,
        `elim_${victim.id}_stone_${Date.now().toString(36)}`,
        true
      );
    }
  }

  public update(dt: number, cameraPos?: THREE.Vector3): void {
    this.time += dt;
    this.frameCounter++;
    for (const [lootId, requestedAt] of this.authoritativePendingIds.entries()) {
      if (this.time - requestedAt > 4 && !this.pendingInventorySlots.has(lootId)) this.authoritativePendingIds.delete(lootId);
    }
    const isEvenFrame = (this.frameCounter & 1) === 0;

    for (const [id, rem] of this.spawnPopTimers.entries()) {
      const next = rem - dt;
      const group = this.lootMeshes.get(id);
      if (next <= 0) {
        this.spawnPopTimers.delete(id);
        if (group) group.scale.setScalar(1);
      } else if (group) {
        this.spawnPopTimers.set(id, next);
        const progress = 1 - next / 0.28;
        const overshoot = 1 + Math.sin(progress * Math.PI) * 0.16;
        group.scale.setScalar(Math.min(1.16, (0.22 + progress * 0.78) * overshoot));
      }
    }

    for (const [id, group] of this.lootMeshes.entries()) {
      if (cameraPos) {
        const dx = group.position.x - cameraPos.x;
        const dz = group.position.z - cameraPos.z;
        const distSq = dx * dx + dz * dz;
        const beam = this.lootBeams.get(id);
        if (beam) beam.visible = distSq <= (beam.userData.longRange ? 120*120 : 50*50);
        if (distSq > 135 * 135) {
          if (group.visible) group.visible = false;
          continue;
        }
        if (!group.visible) group.visible = true;
        if (distSq > 55 * 55 && !isEvenFrame) {
          continue;
        }
      }

      const floating = this.floatingItems.get(id);
      if (floating) {
        floating.rotation.y += dt * 1.65;
        floating.position.y = Number(floating.userData.baseLift ?? 0.45) + Math.sin(this.time * 3.0 + group.position.x) * 0.1;
      }
    }

    for (const chest of this.chestVisuals.values()) {
      if (!chest.root.visible) continue;
      if (!chest.isOpened) {
        const pulse = 1 + Math.sin(this.time * 3.8 + chest.root.position.x) * 0.08;
        chest.glowRing.scale.setScalar(pulse);
        chest.coreGem.rotation.y += dt * 2.2;
      } else if (chest.openProgress < 1) {
        chest.openProgress = Math.min(1, chest.openProgress + dt * 3.4);
        const easeOut = 1 - Math.pow(1 - chest.openProgress, 3);
        chest.lidPivot.rotation.x = -easeOut * 1.42;
        chest.coreGem.position.y = 0.52 + easeOut * 0.48;
        chest.coreGem.rotation.y += dt * 6.5;
        chest.coreGem.scale.setScalar(Math.max(0.01, 1 - easeOut * 0.95));
      }
    }
  }
}
