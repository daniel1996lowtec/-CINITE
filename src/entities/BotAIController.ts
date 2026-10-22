import * as THREE from 'three';
import {
  BotAIState,
  BotDifficulty,
  InventorySlot,
  LootItemState,
  MatchState,
  OutfitPresetId,
  PlayerState,
  WeaponCategory,
  WeaponRarity,
} from '../network/schemas';
import { IslandWorld } from '../world/IslandWorld';
import { ISLAND_ROUTE_POINTS } from '../world/TerrainGenerator';
import { createWeaponStats, RARITY_COLORS } from '../weapons/WeaponDefinitions';
import { CharacterMesh } from './CharacterMesh';
import { PlayerController, ShotHitCallback } from './PlayerController';
import { ParticleSystem } from '../systems/ParticleSystem';
import { SoundManager } from '../audio/SoundManager';
import { LootSystem } from '../systems/LootSystem';

const BOT_NAMES = [
  'Jenkins_Bot',
  'GitHubActions_AI',
  'DockerDaemon',
  'KubeScheduler',
  'TerraformRunner',
  'SonarScanner',
  'PrometheusNode',
  'GrafanaWatcher',
  'AnsiblePlaybook',
  'HelmChart_v3',
  'ArgoCD_Sync',
  'NginxProxy',
  'RedisCache_01',
  'KafkaBroker',
  'ViteBundler',
  'TypeScriptCheck',
  'ESLintGuard',
  'PrettierFormat',
];

const SKIN_PALETTE: Array<{
  outfitId: OutfitPresetId;
  skin: number;
  accent: number;
}> = [
  { outfitId: 'solar_phoenix', skin: 0xf97316, accent: 0xfef08a },
  { outfitId: 'neon_phantom', skin: 0xa855f7, accent: 0x38bdf8 },
  { outfitId: 'crimson_striker', skin: 0xec4899, accent: 0xfde047 },
  { outfitId: 'emerald_ranger', skin: 0x10b981, accent: 0xa7f3d0 },
  { outfitId: 'crimson_striker', skin: 0xef4444, accent: 0xfca5a5 },
  { outfitId: 'vanguard_blue', skin: 0x6366f1, accent: 0xc7d2fe },
  { outfitId: 'arctic_sentinel', skin: 0x14b8a6, accent: 0x99f6e4 },
];

interface BotMemory {
  aiState: BotAIState;
  waypoint: THREE.Vector3;
  waypointTimer: number;
  poiRouteIndex: number;
  investigateTimer: number;
  targetEnemyId: string | null;
  targetLootId: string | null;
  strafeDir: number;
  strafeTimer: number;
  buildCooldown: number;
  stuckTimer: number;
  lastPos: THREE.Vector3;
  lastKnownHealth: number;
  reactionTimer: number;
  avoidanceAngle: number;
  avoidanceTimer: number;
  perceptionTimer: number;
  pickupCheckTimer: number;
}

export class BotAIController {
  private memories: Map<string, BotMemory> = new Map();
  private scratchOrigin = new THREE.Vector3();
  private scratchDir = new THREE.Vector3();
  private scratchAimOrigin = new THREE.Vector3();
  private scratchAimDir = new THREE.Vector3();
  private scratchEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  /**
   * Alerts nearby patrolling bots to investigate gunfire or combat sounds
   */
  public notifySoundEvent(x: number, z: number, hearingRadius: number = 95): void {
    for (const mem of this.memories.values()) {
      if (mem.aiState !== 'PATROLLING') continue;
      const dist = Math.hypot(x - mem.lastPos.x, z - mem.lastPos.z);
      if (dist > 6 && dist <= hearingRadius) {
        mem.waypoint.set(
          x + (Math.random() - 0.5) * 10,
          0,
          z + (Math.random() - 0.5) * 10
        );
        mem.waypointTimer = 9.0;
        mem.investigateTimer = 6.0;
      }
    }
  }

  /**
   * Picks a patrol point in the open streets/squares around a route centre.
   * Expansion districts place buildings only 10–15m from those centres, so a
   * purely random ±12m waypoint can otherwise land inside a house and make a
   * bot hug its wall until the waypoint timer expires. This is called only
   * when a waypoint changes, not per frame.
   */
  private findOpenWaypoint(
    world: IslandWorld,
    centerX: number,
    centerZ: number,
    spread: number
  ): { x: number; z: number } {
    let fallbackX = centerX;
    let fallbackZ = centerZ;

    for (let attempt = 0; attempt < 8; attempt++) {
      const x = centerX + (Math.random() - 0.5) * spread;
      const z = centerZ + (Math.random() - 0.5) * spread;
      if (attempt === 0) {
        fallbackX = x;
        fallbackZ = z;
      }
      if (Math.hypot(x, z) > 224) continue;
      if (world.terrain.getTerrainHeight(x, z) < 0.75) continue;
      if (world.terrain.getRiverDistance(x, z) < 5) continue;
      if (world.mapExpansion.isInsideStructure(x, z, 1.1)) continue;
      return { x, z };
    }

    if (!world.mapExpansion.isInsideStructure(centerX, centerZ, 1.1)) {
      return { x: centerX, z: centerZ };
    }
    return { x: fallbackX, z: fallbackZ };
  }

  public spawnBots(
    count: number,
    state: MatchState,
    world: IslandWorld,
    skyDrop: boolean
  ): PlayerState[] {
    this.memories.clear();
    const spawned: PlayerState[] = [];

    for (let i = 0; i < count; i++) {
      const id = `bot_${i + 1}`;
      const name = BOT_NAMES[i % BOT_NAMES.length];
      const palette = SKIN_PALETTE[i % SKIN_PALETTE.length];

      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
      const dist = 35 + Math.random() * 145;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      const groundY = world.terrain.getTerrainHeight(x, z);
      const startY = skyDrop ? 78 + Math.random() * 35 : Math.max(1.0, groundY + 0.2);

      const harvesterStats = createWeaponStats('harvester', 'rare');
      const starterWeapons: WeaponCategory[] = [
        'pistol',
        'heavy_pistol',
        'assault_rifle',
        'burst_rifle',
        'dmr',
        'smg',
        'shotgun',
        'tactical_shotgun',
      ];
      const starterCat = starterWeapons[i % starterWeapons.length];
      const starterStats = createWeaponStats(starterCat, 'common');

      const inv: (InventorySlot | null)[] = [
        {
          weaponId: harvesterStats.id,
          name: harvesterStats.name,
          category: 'harvester',
          rarity: 'rare',
          clipAmmo: 999,
          maxClipAmmo: 999,
          ammoType: 'none',
          isConsumable: false,
          count: 1,
        },
        {
          weaponId: starterStats.id,
          name: starterStats.name,
          category: starterCat,
          rarity: 'common',
          clipAmmo: starterStats.clipSize,
          maxClipAmmo: starterStats.clipSize,
          ammoType: starterStats.ammoType,
          isConsumable: false,
          count: 1,
        },
        null,
        null,
        null,
      ];

      const initialYaw = Math.random() * Math.PI * 2;
      const bot: PlayerState = {
        id,
        name,
        isBot: true,
        isConnected: true,
        alive: true,
        position: { x, y: startY, z },
        velocity: { x: 0, y: 0, z: 0 },
        yaw: initialYaw,
        facingYaw: initialYaw,
        pitch: 0,
        health: 100,
        maxHealth: 100,
        shield: 25,
        maxShield: 100,
        eliminations: 0,
        damageDealt: 0,
        shotsFired: 0,
        shotsHit: 0,
        structuresBuilt: 0,
        activeSlot: 1,
        selectedMaterial: 'wood',
        inventory: inv,
        materials: { wood: 50, stone: 30, metal: 10 },
        ammo: { none: 0, light: 90, medium: 75, shells: 24, heavy: 12 },
        isAiming: false,
        isSprinting: false,
        isGrounded: !skyDrop,
        isGliding: skyDrop,
        isReloading: false,
        reloadTimer: 0,
        reloadDuration: 0,
        isHealing: false,
        landingImpactTimer: 0,
        outfitId: palette.outfitId,
        skinColor: palette.skin,
        accentColor: palette.accent,
        aiState: 'PATROLLING',
      };

      state.players.set(id, bot);
      spawned.push(bot);

      const poiIdx = i % ISLAND_ROUTE_POINTS.length;
      const poi = ISLAND_ROUTE_POINTS[poiIdx];
      const initialWaypoint = this.findOpenWaypoint(world, poi.x, poi.z, 24);
      this.memories.set(id, {
        aiState: 'PATROLLING',
        waypoint: new THREE.Vector3(initialWaypoint.x, poi.baseHeight, initialWaypoint.z),
        waypointTimer: 8 + Math.random() * 6,
        poiRouteIndex: poiIdx,
        investigateTimer: 0,
        targetEnemyId: null,
        targetLootId: null,
        strafeDir: Math.random() < 0.5 ? 1 : -1,
        strafeTimer: 1.5,
        buildCooldown: 0,
        stuckTimer: 0,
        lastPos: new THREE.Vector3(x, startY, z),
        lastKnownHealth: 125,
        reactionTimer: 0,
        avoidanceAngle: 0,
        avoidanceTimer: 0,
        perceptionTimer: (i * 0.015) % 0.16,
        pickupCheckTimer: (i * 0.02) % 0.15,
      });
    }

    return spawned;
  }

  public updateBots(
    dt: number,
    state: MatchState,
    world: IslandWorld,
    meshes: Map<string, CharacterMesh>,
    playerController: PlayerController,
    lootSystem: LootSystem,
    particles: ParticleSystem,
    sound: SoundManager,
    difficulty: BotDifficulty,
    onPlayerHit: ShotHitCallback
  ): void {
    const stormCenterX = state.storm.currentCenterX;
    const stormCenterZ = state.storm.currentCenterZ;
    const stormRadius = state.storm.currentRadius;

    const sightRange = difficulty === 'hard' ? 88 : difficulty === 'medium' ? 68 : 48;
    const aimJitter = difficulty === 'hard' ? 0.028 : difficulty === 'medium' ? 0.068 : 0.135;
    const fireProb = difficulty === 'hard' ? 0.86 : difficulty === 'medium' ? 0.58 : 0.34;
    const baseReactionDelay = difficulty === 'hard' ? 0.16 : difficulty === 'medium' ? 0.36 : 0.65;

    for (const bot of state.players.values()) {
      if (!bot.isBot || !bot.alive) continue;

      const mem = this.memories.get(bot.id);
      if (!mem) continue;

      mem.buildCooldown = Math.max(0, mem.buildCooldown - dt);
      mem.avoidanceTimer = Math.max(0, mem.avoidanceTimer - dt);
      mem.perceptionTimer -= dt;
      mem.pickupCheckTimer -= dt;

      // 1. Sky-Drop Gliding Logic
      if (bot.isGliding) {
        const dx = mem.waypoint.x - bot.position.x;
        const dz = mem.waypoint.z - bot.position.z;
        const d = Math.hypot(dx, dz);
        const dirX = d > 0.1 ? dx / d : 0;
        const dirZ = d > 0.1 ? dz / d : 0;
        bot.yaw = Math.atan2(-dirX, -dirZ);
        bot.facingYaw = bot.yaw;

        bot.position.x += dirX * 15.0 * dt;
        bot.position.z += dirZ * 15.0 * dt;
        bot.position.y -= 13.5 * dt;

        const gY = world.getGroundHeightAt(bot.position.x, bot.position.y, bot.position.z);
        if (bot.position.y <= gY + 0.15) {
          bot.position.y = gY;
          bot.isGliding = false;
          bot.isGrounded = true;
          bot.landingImpactTimer = 0.18;
        }
        continue;
      }

      // 2. Check if bot took sudden damage -> build defensive cover!
      const currentTotalHp = bot.health + bot.shield;
      const tookRecentDamage = currentTotalHp < mem.lastKnownHealth;
      mem.lastKnownHealth = currentTotalHp;

      if (tookRecentDamage && mem.buildCooldown <= 0 && bot.materials.wood >= 10) {
        const piece: 'wall' | 'ramp' | 'roof' =
          Math.random() < 0.65 ? 'wall' : Math.random() < 0.85 ? 'ramp' : 'roof';
        playerController.tryPlaceBuild(bot, piece, state, world, particles, sound);
        mem.buildCooldown = difficulty === 'hard' ? 2.8 : 5.2;
        mem.aiState = 'TAKING_COVER';
      }

      // 3. Evaluate Storm Safety
      const distFromStormCenter = Math.hypot(
        bot.position.x - stormCenterX,
        bot.position.z - stormCenterZ
      );
      const isOutsideStorm = distFromStormCenter > stormRadius * 0.88;

      // 4. Staggered Perception Scan (~6.25 Hz per bot) + Continuous Target Tracking (60 Hz)
      let nearestEnemy: PlayerState | null = null;
      let nearestEnemyDist = sightRange;
      let nearbyLoot: LootItemState | null = null;

      if (mem.perceptionTimer <= 0 || tookRecentDamage) {
        mem.perceptionTimer = 0.16 + Math.random() * 0.04;

        for (const other of state.players.values()) {
          if (!other.alive || other.id === bot.id) continue;
          const d = Math.hypot(
            other.position.x - bot.position.x,
            other.position.z - bot.position.z
          );
          if (d < nearestEnemyDist) {
            this.scratchOrigin.set(bot.position.x, bot.position.y + 1.5, bot.position.z);
            this.scratchDir
              .set(
                other.position.x - this.scratchOrigin.x,
                other.position.y + 1.2 - this.scratchOrigin.y,
                other.position.z - this.scratchOrigin.z
              )
              .normalize();
            const wallHit = world.raycastWorld(
              this.scratchOrigin,
              this.scratchDir,
              d - 0.6
            );
            if (!wallHit) {
              nearestEnemyDist = d;
              nearestEnemy = other;
            }
          }
        }

        if (nearestEnemy) {
          if (mem.targetEnemyId !== nearestEnemy.id) {
            mem.targetEnemyId = nearestEnemy.id;
            mem.reactionTimer = baseReactionDelay * (0.75 + Math.random() * 0.5);
          }
        } else {
          mem.targetEnemyId = null;
        }

        if (!isOutsideStorm && (!nearestEnemy || nearestEnemyDist > 26)) {
          nearbyLoot = this.findDesirableLoot(state, bot, 22);
          mem.targetLootId = nearbyLoot ? nearbyLoot.id : null;
        } else {
          mem.targetLootId = null;
        }
      } else {
        // Use cached perception target at 60Hz and update live distance
        if (mem.targetEnemyId) {
          const cachedEnemy = state.players.get(mem.targetEnemyId);
          if (cachedEnemy && cachedEnemy.alive) {
            const d = Math.hypot(
              cachedEnemy.position.x - bot.position.x,
              cachedEnemy.position.z - bot.position.z
            );
            if (d <= sightRange * 1.1) {
              nearestEnemy = cachedEnemy;
              nearestEnemyDist = Math.max(0.1, d);
            } else {
              mem.targetEnemyId = null;
            }
          } else {
            mem.targetEnemyId = null;
          }
        }
        if (mem.targetLootId) {
          const cachedLoot = state.lootItems.get(mem.targetLootId);
          if (cachedLoot && !cachedLoot.opened) {
            nearbyLoot = cachedLoot;
          } else {
            mem.targetLootId = null;
          }
        }
      }

      if (nearestEnemy) {
        mem.reactionTimer = Math.max(0, mem.reactionTimer - dt);
      }

      // 6. Determine AI State Machine Transition
      if (isOutsideStorm) {
        mem.aiState = 'FLEEING_STORM';
        mem.waypoint.set(
          stormCenterX + (Math.random() - 0.5) * stormRadius * 0.35,
          0,
          stormCenterZ + (Math.random() - 0.5) * stormRadius * 0.35
        );
      } else if (bot.health < 55 && this.hasConsumableInInventory(bot)) {
        mem.aiState = 'TAKING_COVER';
      } else if (nearestEnemy) {
        mem.aiState = 'ENGAGING';
      } else if (nearbyLoot) {
        mem.aiState = 'LOOTING';
        mem.waypoint.set(nearbyLoot.position.x, nearbyLoot.position.y, nearbyLoot.position.z);
      } else {
        mem.aiState = 'PATROLLING';
        mem.waypointTimer -= dt;
        mem.investigateTimer = Math.max(0, mem.investigateTimer - dt);
        const distToWp = Math.hypot(
          mem.waypoint.x - bot.position.x,
          mem.waypoint.z - bot.position.z
        );
        if (mem.waypointTimer <= 0 || distToWp < 4.5) {
          mem.poiRouteIndex = (mem.poiRouteIndex + 1) % ISLAND_ROUTE_POINTS.length;
          const nextPoi = ISLAND_ROUTE_POINTS[mem.poiRouteIndex];
          const poiDistToStorm = Math.hypot(
            nextPoi.x - stormCenterX,
            nextPoi.z - stormCenterZ
          );
          if (poiDistToStorm < stormRadius * 0.8) {
            const openWaypoint = this.findOpenWaypoint(world, nextPoi.x, nextPoi.z, 20);
            mem.waypoint.set(openWaypoint.x, 0, openWaypoint.z);
          } else {
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * Math.min(stormRadius * 0.72, 145);
            mem.waypoint.set(
              stormCenterX + Math.cos(angle) * r,
              0,
              stormCenterZ + Math.sin(angle) * r
            );
          }
          mem.waypointTimer = 9 + Math.random() * 7;
        }
      }

      bot.aiState = mem.aiState;

      // 7. Execute Behavior for Current AI State
      let moveDirX = 0;
      let moveDirZ = 0;
      let wantsFire = false;
      let wantsJump = false;

      if (mem.aiState === 'TAKING_COVER' && this.hasConsumableInInventory(bot)) {
        const healSlot = this.findConsumableSlot(bot);
        if (healSlot !== -1) {
          bot.activeSlot = healSlot;
          wantsFire = true;
        }
      } else if (mem.aiState === 'ENGAGING' && nearestEnemy) {
        this.selectBestWeaponSlotForDistance(bot, nearestEnemyDist);

        const dx = nearestEnemy.position.x - bot.position.x;
        const dy = nearestEnemy.position.y + 1.15 - (bot.position.y + 1.4);
        const dz = nearestEnemy.position.z - bot.position.z;

        const targetYaw = Math.atan2(-dx, -dz);
        bot.yaw = targetYaw + (Math.random() - 0.5) * aimJitter;
        bot.facingYaw = bot.yaw;
        bot.pitch = Math.atan2(dy, nearestEnemyDist) + (Math.random() - 0.5) * aimJitter;
        bot.isAiming = nearestEnemyDist > 22;

        mem.strafeTimer -= dt;
        if (mem.strafeTimer <= 0) {
          mem.strafeDir = -mem.strafeDir;
          mem.strafeTimer = 1.0 + Math.random() * 1.4;
        }

        const forwardX = dx / nearestEnemyDist;
        const forwardZ = dz / nearestEnemyDist;
        const rightX = -forwardZ * mem.strafeDir;
        const rightZ = forwardX * mem.strafeDir;

        if (nearestEnemyDist > 24) {
          moveDirX = forwardX * 0.75 + rightX * 0.55;
          moveDirZ = forwardZ * 0.75 + rightZ * 0.55;
        } else if (nearestEnemyDist < 8) {
          moveDirX = -forwardX * 0.55 + rightX * 0.85;
          moveDirZ = -forwardZ * 0.55 + rightZ * 0.85;
        } else {
          moveDirX = rightX;
          moveDirZ = rightZ;
        }

        // Only fire once reaction timer has elapsed
        wantsFire = mem.reactionTimer <= 0 && Math.random() < fireProb;
      } else {
        // PATROLLING, LOOTING, or FLEEING_STORM with Whisker Raycast Obstacle Avoidance
        bot.isAiming = false;
        const dx = mem.waypoint.x - bot.position.x;
        const dz = mem.waypoint.z - bot.position.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.5) {
          let desiredX = dx / d;
          let desiredZ = dz / d;

          // Whisker Raycast Obstacle Pathfinding around buildings/walls
          const steered = this.steerAroundObstacles(
            world,
            bot.position.x,
            bot.position.y,
            bot.position.z,
            desiredX,
            desiredZ,
            mem
          );
          moveDirX = steered.x;
          moveDirZ = steered.z;

          bot.yaw = Math.atan2(-moveDirX, -moveDirZ);
          bot.facingYaw = bot.yaw;
        }

        if (mem.aiState === 'LOOTING' && nearbyLoot && d < 3.0) {
          lootSystem.interactWithLoot(state, bot, nearbyLoot, particles, sound);
        }
      }

      // 8. Apply Physics & Obstacle Jump Check
      const speed =
        mem.aiState === 'FLEEING_STORM'
          ? 8.8
          : mem.aiState === 'ENGAGING'
          ? 5.6
          : 6.5;
      bot.isSprinting = mem.aiState === 'FLEEING_STORM';

      const nextX = bot.position.x + moveDirX * speed * dt;
      const nextZ = bot.position.z + moveDirZ * speed * dt;
      const col = world.resolveHorizontalCollision(nextX, bot.position.y, nextZ, 0.48);

      const movedDist = Math.hypot(
        col.x - mem.lastPos.x,
        col.z - mem.lastPos.z
      );
      if (movedDist < 0.04 && (Math.abs(moveDirX) > 0.1 || Math.abs(moveDirZ) > 0.1)) {
        mem.stuckTimer += dt;
        if (mem.stuckTimer > 0.45) {
          wantsJump = true;
          mem.avoidanceAngle = (Math.random() < 0.5 ? 1 : -1) * (Math.PI * 0.55);
          mem.avoidanceTimer = 1.2;
          mem.stuckTimer = 0;
        }
      } else {
        mem.stuckTimer = 0;
      }
      mem.lastPos.set(col.x, bot.position.y, col.z);

      bot.position.x = col.x;
      bot.position.z = col.z;
      bot.velocity.x = moveDirX * speed;
      bot.velocity.z = moveDirZ * speed;

      if ((col.collided || wantsJump) && bot.isGrounded) {
        bot.velocity.y = 9.4;
        bot.isGrounded = false;
      }

      bot.velocity.y -= 24.5 * dt;
      bot.position.y += bot.velocity.y * dt;

      const groundY = world.getGroundHeightAt(bot.position.x, bot.position.y, bot.position.z);
      if (bot.position.y <= groundY) {
        bot.position.y = groundY;
        bot.velocity.y = 0;
        bot.isGrounded = true;
      }

      if (mem.pickupCheckTimer <= 0) {
        mem.pickupCheckTimer = 0.15;
        lootSystem.checkAutoPickups(state, bot, sound);
      }

      // 9. Execute Bot Combat / Weapon Firing (zero-allocation scratch vectors)
      this.scratchAimOrigin.set(bot.position.x, bot.position.y + 1.45, bot.position.z);
      this.scratchEuler.set(bot.pitch, bot.yaw, 0, 'YXZ');
      this.scratchAimDir.set(0, 0, -1).applyEuler(this.scratchEuler);

      playerController.updateCombatActions(
        bot,
        dt,
        wantsFire,
        false,
        state,
        world,
        meshes,
        particles,
        sound,
        { origin: this.scratchAimOrigin, direction: this.scratchAimDir },
        onPlayerHit
      );
    }
  }

  /**
   * Fast analytical whisker obstacle avoidance so bots smoothly navigate around buildings, walls, and silos
   * without running expensive triangle raycasts every frame.
   */
  private steerAroundObstacles(
    world: IslandWorld,
    px: number,
    py: number,
    pz: number,
    dirX: number,
    dirZ: number,
    mem: BotMemory
  ): { x: number; z: number } {
    if (mem.avoidanceTimer > 0) {
      const cos = Math.cos(mem.avoidanceAngle);
      const sin = Math.sin(mem.avoidanceAngle);
      return {
        x: dirX * cos - dirZ * sin,
        z: dirX * sin + dirZ * cos,
      };
    }

    const hitCenter = world.isPathBlockedFast(px, py, pz, dirX, dirZ, 3.6);
    if (!hitCenter.blocked) {
      mem.avoidanceAngle = 0;
      mem.avoidanceTimer = 0.14;
      return { x: dirX, z: dirZ };
    }

    // Center ray blocked! Probe left (+50 deg) and right (-50 deg) whiskers analytically
    const leftAngle = 0.88;
    const rightAngle = -0.88;
    const cosL = Math.cos(leftAngle);
    const sinL = Math.sin(leftAngle);
    const leftDirX = dirX * cosL - dirZ * sinL;
    const leftDirZ = dirX * sinL + dirZ * cosL;

    const cosR = Math.cos(rightAngle);
    const sinR = Math.sin(rightAngle);
    const rightDirX = dirX * cosR - dirZ * sinR;
    const rightDirZ = dirX * sinR + dirZ * cosR;

    const hitLeft = world.isPathBlockedFast(px, py, pz, leftDirX, leftDirZ, 4.2);
    const hitRight = world.isPathBlockedFast(px, py, pz, rightDirX, rightDirZ, 4.2);

    if (!hitLeft.blocked && hitRight.blocked) {
      mem.avoidanceAngle = leftAngle;
    } else if (!hitRight.blocked && hitLeft.blocked) {
      mem.avoidanceAngle = rightAngle;
    } else {
      mem.avoidanceAngle = hitLeft.distance >= hitRight.distance ? leftAngle : rightAngle;
    }
    mem.avoidanceTimer = 0.65;

    const cos = Math.cos(mem.avoidanceAngle);
    const sin = Math.sin(mem.avoidanceAngle);
    return {
      x: dirX * cos - dirZ * sin,
      z: dirX * sin + dirZ * cos,
    };
  }

  private findDesirableLoot(
    state: MatchState,
    bot: PlayerState,
    radius: number
  ): LootItemState | null {
    let best: LootItemState | null = null;
    let bestDist = radius;

    for (const item of state.lootItems.values()) {
      if (item.opened || item.serverAuthoritative) continue;
      if (item.itemType !== 'chest' && item.itemType !== 'weapon' && item.itemType !== 'consumable') {
        continue;
      }
      // Do not path toward second-floor/rooftop loot from ground level (or
      // vice versa): the whisker steering has no stair/ramp route planner.
      if (Math.abs(item.position.y - bot.position.y) > 2.4) continue;
      const d = Math.hypot(
        item.position.x - bot.position.x,
        item.position.z - bot.position.z
      );
      if (d < bestDist) {
        bestDist = d;
        best = item;
      }
    }
    return best;
  }

  private hasConsumableInInventory(bot: PlayerState): boolean {
    return this.findConsumableSlot(bot) !== -1;
  }

  private findConsumableSlot(bot: PlayerState): number {
    for (let i = 1; i < 5; i++) {
      const s = bot.inventory[i];
      if (s && s.isConsumable && s.count > 0) return i;
    }
    return -1;
  }

  private selectBestWeaponSlotForDistance(bot: PlayerState, dist: number): void {
    let bestSlot = 1;
    let bestScore = -1;

    for (let i = 1; i < 5; i++) {
      const slot = bot.inventory[i];
      if (!slot || slot.isConsumable) continue;
      let score = RARITY_COLORS[slot.rarity as WeaponRarity].damageMult * 10;
      if (
        dist < 13 &&
        (slot.category === 'shotgun' || slot.category === 'tactical_shotgun')
      ) {
        score += 18;
      } else if (
        dist < 25 &&
        (slot.category === 'smg' ||
          slot.category === 'pistol' ||
          slot.category === 'heavy_pistol')
      ) {
        score += 12;
      } else if (
        dist >= 22 &&
        dist <= 65 &&
        (slot.category === 'assault_rifle' || slot.category === 'burst_rifle')
      ) {
        score += 15;
      } else if (dist > 42 && slot.category === 'dmr') {
        score += 18;
      } else if (dist > 55 && slot.category === 'sniper') {
        score += 20;
      }

      if (score > bestScore) {
        bestScore = score;
        bestSlot = i;
      }
    }

    bot.activeSlot = bestSlot;
  }
}
