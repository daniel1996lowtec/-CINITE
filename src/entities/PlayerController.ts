import * as THREE from 'three';
import { raycastPlayers } from '../../shared/hitbox.mjs';
import {
  resolveAim,
  spreadDirection,
  createSpreadRng,
  type AimSolution,
  type Vec3,
} from '../weapons/AimSolver';
import {
  AmmoType,
  BuildMaterialType,
  BuildPieceType,
  MatchState,
  PlayerInputPacket,
  PlayerState,
  WeaponCategory,
  WeaponRarity,
} from '../network/schemas';
import { IslandWorld } from '../world/IslandWorld';
import {
  calculateWeaponDamage,
  createWeaponStats,
  WeaponStats,
} from '../weapons/WeaponDefinitions';
import { CharacterMesh } from './CharacterMesh';
import { ParticleSystem } from '../systems/ParticleSystem';
import { SoundManager } from '../audio/SoundManager';
import { LootSystem } from '../systems/LootSystem';

export interface ShotHitCallback {
  (
    attacker: PlayerState,
    victim: PlayerState,
    damage: number,
    isHeadshot: boolean,
    isShieldHit: boolean,
    weaponName: string,
    hitPoint: THREE.Vector3
  ): void;
}

interface BurstQueueState {
  shotsRemaining: number;
  timer: number;
  slotIndex: number;
  category: WeaponCategory;
  rarity: WeaponRarity;
  expiresAtMs: number;
}

export class PlayerController {
  /**
   * Last resolved aim solution for the local player. Read by the development
   * overlay (`AimDiagnostics`) and by tests; never affects gameplay on its own.
   */
  public lastAimSolution: AimSolution | null = null;
  private aimBlocked = false;
  private aimBlockedUntil = 0;
  private spreadRng = createSpreadRng(0x5eed77);

  private fireCooldown: Map<string, number> = new Map();
  private burstQueues: Map<string, BurstQueueState> = new Map();
  private prevFireHeld: Map<string, boolean> = new Map();
  private lastFireTimeMs: Map<string, number> = new Map();
  private footstepTimer: number = 0;

  public onLocalReloadCompleted?: () => void;

  public resetPresentation(): void {
    this.fireCooldown.clear(); this.burstQueues.clear(); this.prevFireHeld.clear();
    this.lastFireTimeMs.clear(); this.footstepTimer = 0;
  }

  public updateLocalPlayer(
    player: PlayerState,
    input: PlayerInputPacket,
    state: MatchState,
    world: IslandWorld,
    meshes: Map<string, CharacterMesh>,
    lootSystem: LootSystem,
    particles: ParticleSystem,
    sound: SoundManager,
    cameraRay: { origin: THREE.Vector3; direction: THREE.Vector3 },
    onPlayerHit: ShotHitCallback,
    onCrosshairHitmarker: (isHeadshot: boolean, isShield: boolean) => void,
    onRecoilKick?: (
      pitchKick: number,
      yawKick: number,
      category?: string,
      isAiming?: boolean
    ) => void
  ): void {
    if (!player.alive) return;
    const dt = input.dt;

    // 1. Handle Inventory Slot Switching & Material Cycling
    if (input.selectSlot >= 0 && input.selectSlot < 5) {
      if (player.activeSlot !== input.selectSlot) {
        player.activeSlot = input.selectSlot;
        if (this.serverOwned(player)) this.onInventoryAction?.('switch', player.activeSlot);
        this.burstQueues.delete(player.id);
        player.isReloading = false;
        player.reloadTimer = 0;
        player.isHealing = false;
        this.fireCooldown.set(
          player.id,
          Math.max(this.fireCooldown.get(player.id) || 0, 0.14)
        );
        sound.playWeaponSwitch();
      }
    } else if (input.selectSlot === -2 || input.selectSlot === -3) {
      const step = input.selectSlot === -2 ? 1 : -1;
      player.activeSlot = (player.activeSlot + step + 5) % 5;
      if (this.serverOwned(player)) this.onInventoryAction?.('switch', player.activeSlot);
      this.burstQueues.delete(player.id);
      player.isReloading = false;
      player.reloadTimer = 0;
      player.isHealing = false;
      this.fireCooldown.set(
        player.id,
        Math.max(this.fireCooldown.get(player.id) || 0, 0.14)
      );
      sound.playWeaponSwitch();
    }

    if (input.cycleMaterial) {
      const order: BuildMaterialType[] = ['wood', 'stone', 'metal'];
      const nextIdx = (order.indexOf(player.selectedMaterial) + 1) % order.length;
      player.selectedMaterial = order[nextIdx];
    }

    // 2. Movement & Glider / Ground Physics
    player.yaw = input.yaw;
    player.pitch = input.pitch;
    player.isAiming = input.aim && !player.isGliding;

    const forwardX = -Math.sin(player.yaw);
    const forwardZ = -Math.cos(player.yaw);
    const rightX = Math.cos(player.yaw);
    const rightZ = -Math.sin(player.yaw);

    const wishX = rightX * input.moveX - forwardX * input.moveZ;
    const wishZ = rightZ * input.moveX - forwardZ * input.moveZ;
    const wishLen = Math.hypot(wishX, wishZ);
    const normX = wishLen > 0.001 ? wishX / wishLen : 0;
    const normZ = wishLen > 0.001 ? wishZ / wishLen : 0;

    player.isSprinting = input.sprint && !player.isAiming && wishLen > 0.1;

    // Character rotation based on movement vs aiming/shooting direction
    if (player.isAiming || input.fire || input.buildType) {
      player.facingYaw = player.yaw;
    } else if (wishLen > 0.12) {
      player.facingYaw = Math.atan2(-normX, -normZ);
    }

    if (player.isGliding) {
      if (input.buildType) this.onBuildRejected?.('Land before building.', input.buildType);
      const previousY = player.position.y;
      const glideSpeed = input.sprint ? 22.0 : 15.0;
      const descendRate = input.sprint ? -17.0 : -7.8;
      player.velocity.x = normX * glideSpeed;
      player.velocity.z = normZ * glideSpeed;
      player.velocity.y = descendRate;

      this.moveHorizontally(player, world, player.velocity.x * dt, player.velocity.z * dt);
      player.position.y += player.velocity.y * dt;

      const groundY = world.getGroundHeightAt(
        player.position.x,
        previousY,
        player.position.z,
        0,
        .38
      );
      if (player.position.y <= groundY + 0.1) {
        player.position.y = groundY;
        player.velocity.y = 0;
        player.isGliding = false;
        player.isGrounded = true;
        player.landingImpactTimer = 0.18;
        sound.playLand();
        particles.spawnImpactBurst(
          new THREE.Vector3(player.position.x, player.position.y + 0.15, player.position.z),
          0xd6d3d1,
          8,
          3.2
        );
      }
      return;
    }

    // Standard Ground / Air Movement
    const moveSpeed = player.isAiming
      ? 4.3
      : player.isSprinting
      ? 10.0
      : 6.7;

    player.velocity.x = normX * moveSpeed * Math.min(1, wishLen);
    player.velocity.z = normZ * moveSpeed * Math.min(1, wishLen);

    // Rhythmic Footsteps & Sprint Dust Puffs when moving on ground
    if (player.isGrounded && wishLen > 0.18) {
      this.footstepTimer -= dt;
      if (this.footstepTimer <= 0) {
        this.footstepTimer = player.isSprinting ? 0.27 : 0.4;
        sound.playFootstep(player.isSprinting, 1, world.getFootstepSurface(player.position.x,player.position.y,player.position.z));
        if (player.isSprinting) {
          particles.spawnImpactBurst(
            new THREE.Vector3(player.position.x, player.position.y + 0.08, player.position.z),
            0xd6d3d1,
            2,
            1.4
          );
        }
      }
    } else {
      this.footstepTimer = 0.1;
    }

    // Jump
    if (input.jump && player.isGrounded) {
      player.velocity.y = 9.7;
      player.isGrounded = false;
      sound.playJump();
    }

    const wasGrounded = player.isGrounded;
    const prevVelY = player.velocity.y;

    // Gravity
    player.velocity.y -= 24.5 * dt;

    // Bounded steps prevent fast glide/sprint movement skipping thin walls.
    this.moveHorizontally(player, world, player.velocity.x * dt, player.velocity.z * dt);

    // Apply vertical displacement + floor/ramp snap
    const previousY = player.position.y;
    player.position.y += player.velocity.y * dt;
    const groundY = world.getGroundHeightAt(
      player.position.x,
      previousY,
      player.position.z,
      wasGrounded ? .6 : 0,
      .38
    );

    if (player.velocity.y <= 0 && player.position.y <= groundY) {
      player.position.y = groundY;
      player.velocity.y = 0;
      player.isGrounded = true;
      if (!wasGrounded && prevVelY < -4.5) {
        player.landingImpactTimer = 0.18;
        sound.playLand();
        particles.spawnImpactBurst(
          new THREE.Vector3(player.position.x, player.position.y + 0.1, player.position.z),
          0xd6d3d1,
          5,
          2.5
        );
      }
    } else if (
      player.isGrounded &&
      player.velocity.y <= 0 &&
      player.position.y - groundY < 0.6
    ) {
      player.position.y = groundY;
      player.velocity.y = 0;
    } else {
      player.isGrounded = false;
    }

    // 3. Auto-pickup nearby ammo/materials & Handle manual F / Loot interaction
    lootSystem.checkAutoPickups(state, player, sound, particles);
    if (input.interact) {
      const nearest = lootSystem.findNearestInteractable(
        state,
        player.position.x,
        player.position.y,
        player.position.z
      );
      if (nearest) {
        lootSystem.interactWithLoot(state, player, nearest, particles, sound);
      }
    }

    // 4. Quick-Build (Wall / Ramp / Floor / Roof)
    if (input.buildType) {
      const placed = this.tryPlaceBuild(
        player,
        input.buildType,
        state,
        world,
        particles,
        sound
      );
      if (placed && !player.isBot) {
        this.onLocalBuildPlaced?.(
          placed.id,
          input.buildType,
          player.position.x,
          player.position.y,
          player.position.z,
          player.yaw,
          placed.material
        );
      }
    }

    // 5. Weapon Reloading / Healing / Firing
    this.updateCombatActions(
      player,
      dt,
      input.fire,
      input.reload,
      state,
      world,
      meshes,
      particles,
      sound,
      cameraRay,
      onPlayerHit,
      onCrosshairHitmarker,
      onRecoilKick
    );
  }

  private moveHorizontally(player: PlayerState, world: IslandWorld, dx: number, dz: number): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / .25));
    for (let i = 0; i < steps; i++) {
      const resolved = world.resolveHorizontalCollision(
        player.position.x + dx / steps, player.position.y, player.position.z + dz / steps, .48);
      player.position.x = resolved.x;
      player.position.z = resolved.z;
    }
  }

  public onBuildRejected?: (reason: string, piece: BuildPieceType) => void;
  public usesServerInventory?: () => boolean;
  public onInventoryAction?: (action: 'switch' | 'reload' | 'use', slot?: number) => void;
  private serverOwned(player: PlayerState): boolean {
    return !player.isBot && Boolean(this.usesServerInventory?.());
  }

  public onLocalWeaponFired?: (
    category: string,
    muzzlePos: THREE.Vector3,
    hitPoint: THREE.Vector3,
    rarity?: WeaponRarity,
    aim?: {
      origin: { x: number; y: number; z: number };
      direction: { x: number; y: number; z: number };
      aimPoint: { x: number; y: number; z: number };
    }
  ) => void;
  public onLocalDestructibleDamaged?: (destructibleId: string, damage: number) => void;
  public onLocalStructureFeedback?: (
    hitPoint: THREE.Vector3,
    label: string,
    colorHex: string
  ) => void;
  public onLocalPlayerHealed?: (health: number, shield: number) => void;
  public onLocalBuildPlaced?: (
    buildId: string,
    pieceType: BuildPieceType,
    x: number,
    y: number,
    z: number,
    yaw: number,
    material: BuildMaterialType
  ) => void;

  public canAffordBuild(player: PlayerState): boolean {
    return (
      player.materials.wood >= 10 ||
      player.materials.stone >= 10 ||
      player.materials.metal >= 10
    );
  }

  public tryPlaceBuild(
    player: PlayerState,
    buildType: BuildPieceType,
    state: MatchState,
    world: IslandWorld,
    particles: ParticleSystem,
    sound: SoundManager
  ) {
    // Check placement validity first
    if (
      !world.validateBuildPlacement(
        buildType,
        player.position.x,
        player.position.y,
        player.position.z,
        player.yaw
      )
    ) {
      this.onBuildRejected?.('Invalid placement: blocked, occupied or outside the island.', buildType);
      return null;
    }

    const cost = 10;
    let matUsed: BuildMaterialType | null = null;

    const pref = player.selectedMaterial;
    if (pref === 'wood' && player.materials.wood >= cost) {
      if (!this.serverOwned(player)) player.materials.wood -= cost;
      matUsed = 'wood';
    } else if (pref === 'stone' && player.materials.stone >= cost) {
      if (!this.serverOwned(player)) player.materials.stone -= cost;
      matUsed = 'stone';
    } else if (pref === 'metal' && player.materials.metal >= cost) {
      if (!this.serverOwned(player)) player.materials.metal -= cost;
      matUsed = 'metal';
    } else if (player.materials.wood >= cost) {
      if (!this.serverOwned(player)) player.materials.wood -= cost;
      matUsed = 'wood';
    } else if (player.materials.stone >= cost) {
      if (!this.serverOwned(player)) player.materials.stone -= cost;
      matUsed = 'stone';
    } else if (player.materials.metal >= cost) {
      if (!this.serverOwned(player)) player.materials.metal -= cost;
      matUsed = 'metal';
    }

    if (!matUsed) { this.onBuildRejected?.('Not enough materials (10 required).', buildType); return null; }
    if (this.serverOwned(player)) {
      this.onLocalBuildPlaced?.(`build_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        buildType, player.position.x, player.position.y, player.position.z, player.yaw, matUsed);
      return null; // Real collision/geometry appears only on server acceptance.
    }

    const piece = world.placeBuildPiece(
      player.id,
      buildType,
      player.position.x,
      player.position.y,
      player.position.z,
      player.yaw,
      matUsed
    );
    state.buildables.set(piece.id, piece);
    player.structuresBuilt++;

    if (!player.isBot) {
      sound.playBuild();
    }
    const pieceColor =
      matUsed === 'wood' ? 0xd97706 : matUsed === 'stone' ? 0x94a3b8 : 0x38bdf8;
    particles.spawnImpactBurst(
      new THREE.Vector3(piece.position.x, piece.position.y + 1.2, piece.position.z),
      pieceColor,
      10,
      4.5
    );
    particles.spawnShockwaveRing(
      new THREE.Vector3(piece.position.x, piece.position.y + 0.1, piece.position.z),
      pieceColor,
      2.2
    );
    return piece;
  }

  public updateCombatActions(
    player: PlayerState,
    dt: number,
    wantsFire: boolean,
    wantsReload: boolean,
    state: MatchState,
    world: IslandWorld,
    meshes: Map<string, CharacterMesh>,
    particles: ParticleSystem,
    sound: SoundManager,
    cameraRay: { origin: THREE.Vector3; direction: THREE.Vector3 },
    onPlayerHit: ShotHitCallback,
    onCrosshairHitmarker?: (isHeadshot: boolean, isShield: boolean) => void,
    onRecoilKick?: (
      pitchKick: number,
      yawKick: number,
      category?: string,
      isAiming?: boolean
    ) => void
  ): void {
    // Keep the overshoot instead of clamping it to zero. Clamping quantised the
    // fire interval to whole frames, so a 13 rounds/s SMG actually fired ~10/s
    // on a 30 Hz phone and the missing shots were invisible to the player.
    const rawCd = (this.fireCooldown.get(player.id) || 0) - dt;
    const currentCd = Math.max(0, rawCd);
    this.fireCooldown.set(player.id, currentCd);

    if (!player.alive) {
      this.burstQueues.delete(player.id);
      this.prevFireHeld.set(player.id, wantsFire);
      return;
    }

    const slot = player.inventory[player.activeSlot];
    if (!slot) {
      this.burstQueues.delete(player.id);
      this.prevFireHeld.set(player.id, wantsFire);
      return;
    }

    const stats = createWeaponStats(slot.category, slot.rarity);

    if (player.isReloading) {
      this.burstQueues.delete(player.id);
      player.reloadTimer = Math.max(0, player.reloadTimer - dt);
      if (this.serverOwned(player)) { this.prevFireHeld.set(player.id, wantsFire); return; }
      if (player.reloadTimer <= 0) {
        player.isReloading = false;
        player.reloadTimer = 0;
        this.finishReload(player, stats);
        if (!player.isBot) {
          sound.playReloadComplete();
          this.onLocalReloadCompleted?.();
        }
      }
      this.prevFireHeld.set(player.id, wantsFire);
      return;
    }

    if (
      wantsReload &&
      !stats.isConsumable &&
      stats.ammoType !== 'none' &&
      slot.clipAmmo < slot.maxClipAmmo &&
      this.getReserveAmmo(player, stats.ammoType) > 0
    ) {
      this.burstQueues.delete(player.id);
      player.isReloading = true;
      player.reloadDuration = stats.reloadTime;
      player.reloadTimer = stats.reloadTime;
      if (this.serverOwned(player)) this.onInventoryAction?.('reload');
      if (!player.isBot) sound.playReload(stats.category);
      this.prevFireHeld.set(player.id, wantsFire);
      return;
    }

    if (stats.isConsumable && this.serverOwned(player)) {
      if (wantsFire && currentCd <= 0 && !player.isHealing) {
        this.onInventoryAction?.('use');
        this.fireCooldown.set(player.id, .3);
      }
      this.prevFireHeld.set(player.id, wantsFire);
      return;
    }
    if (stats.isConsumable) {
      if (wantsFire && currentCd <= 0) {
        const canHeal =
          (stats.healAmount && player.health < player.maxHealth) ||
          (stats.shieldAmount && player.shield < player.maxShield);

        if (canHeal) {
          if (stats.healAmount) {
            player.health = Math.min(player.maxHealth, player.health + stats.healAmount);
          }
          if (stats.shieldAmount) {
            player.shield = Math.min(player.maxShield, player.shield + stats.shieldAmount);
          }
          if (!player.isBot) {
            sound.playHeal();
            this.onLocalPlayerHealed?.(player.health, player.shield);
          }
          particles.spawnImpactBurst(
            new THREE.Vector3(player.position.x, player.position.y + 1.2, player.position.z),
            stats.shieldAmount ? 0x38bdf8 : 0x4ade80,
            14,
            4.5
          );

          slot.count--;
          if (slot.count <= 0) {
            player.inventory[player.activeSlot] = null;
            player.activeSlot = 0;
          }
          this.fireCooldown.set(player.id, 1.0);
        }
      }
      this.prevFireHeld.set(player.id, wantsFire);
      return;
    }

    const burstQueue = this.burstQueues.get(player.id);
    if (burstQueue) {
      const queueStillValid =
        performance.now() <= burstQueue.expiresAtMs &&
        stats.fireMode === 'burst' &&
        burstQueue.slotIndex === player.activeSlot &&
        burstQueue.category === slot.category &&
        burstQueue.rarity === slot.rarity;
      if (!queueStillValid) {
        this.burstQueues.delete(player.id);
      } else {
        burstQueue.timer -= dt;
        this.prevFireHeld.set(player.id, wantsFire);
        if (burstQueue.timer > 0) return;

        if (slot.clipAmmo <= 0) {
          this.burstQueues.delete(player.id);
          this.startReloadIfClipEmpty(player, stats, sound);
          return;
        }

        slot.clipAmmo = Math.max(0, slot.clipAmmo - 1);
        this.lastFireTimeMs.set(player.id, performance.now());
        this.executeWeaponShot(
          player,
          stats,
          state,
          world,
          meshes,
          particles,
          sound,
          cameraRay,
          onPlayerHit,
          onCrosshairHitmarker,
          onRecoilKick
        );
        burstQueue.shotsRemaining -= 1;
        if (burstQueue.shotsRemaining <= 0 || slot.clipAmmo <= 0) {
          this.burstQueues.delete(player.id);
        } else {
          burstQueue.timer = stats.burstIntervalSeconds ?? 0.075;
        }
        this.startReloadIfClipEmpty(player, stats, sound);
        return;
      }
    }

    const wasHeld = this.prevFireHeld.get(player.id) || false;
    this.prevFireHeld.set(player.id, wantsFire);
    const triggerAllowed = stats.isAutomatic ? wantsFire : wantsFire && !wasHeld;

    if (!triggerAllowed || currentCd > 0) return;

    // Guard against duplicate shot events within the same frame/tick
    const nowMs = performance.now();
    const lastMs = this.lastFireTimeMs.get(player.id) || 0;
    if (nowMs - lastMs < 20) return;

    if (stats.ammoType !== 'none' && slot.clipAmmo <= 0) {
      if (this.getReserveAmmo(player, stats.ammoType) > 0) {
        player.isReloading = true;
        player.reloadDuration = stats.reloadTime;
        player.reloadTimer = stats.reloadTime;
        if (this.serverOwned(player)) this.onInventoryAction?.('reload');
        if (!player.isBot) sound.playReload(stats.category);
      }
      return;
    }

    if (stats.ammoType !== 'none') {
      slot.clipAmmo = Math.max(0, slot.clipAmmo - 1);
    }

    this.lastFireTimeMs.set(player.id, nowMs);
    const shotInterval = 1 / stats.fireRate;
    // `rawCd` is <= 0 here; carrying it forward preserves the configured rate
    // exactly. The floor stops a long stall from banking up a burst of shots.
    this.fireCooldown.set(
      player.id,
      Math.max(-shotInterval, rawCd) + shotInterval
    );
    this.executeWeaponShot(
      player,
      stats,
      state,
      world,
      meshes,
      particles,
      sound,
      cameraRay,
      onPlayerHit,
      onCrosshairHitmarker,
      onRecoilKick
    );

    if (
      stats.fireMode === 'burst' &&
      (stats.burstCount ?? 1) > 1 &&
      slot.clipAmmo > 0
    ) {
      this.burstQueues.set(player.id, {
        shotsRemaining: (stats.burstCount ?? 1) - 1,
        timer: stats.burstIntervalSeconds ?? 0.075,
        slotIndex: player.activeSlot,
        category: slot.category,
        rarity: slot.rarity,
        expiresAtMs: nowMs + 1000,
      });
    }
    this.startReloadIfClipEmpty(player, stats, sound);
  }

  private executeWeaponShot(
    player: PlayerState,
    stats: WeaponStats,
    state: MatchState,
    world: IslandWorld,
    meshes: Map<string, CharacterMesh>,
    particles: ParticleSystem,
    sound: SoundManager,
    cameraRay: { origin: THREE.Vector3; direction: THREE.Vector3 },
    onPlayerHit: ShotHitCallback,
    onCrosshairHitmarker?: (isHeadshot: boolean, isShield: boolean) => void,
    onRecoilKick?: (
      pitchKick: number,
      yawKick: number,
      category?: string,
      isAiming?: boolean
    ) => void
  ): void {
    const shooterMesh = meshes.get(player.id);
    shooterMesh?.triggerAttackAnimation(stats.category !== 'harvester');

    if (!player.isBot && onRecoilKick && stats.recoilPitch > 0) {
      onRecoilKick(
        stats.recoilPitch,
        stats.recoilYaw,
        stats.category,
        player.isAiming
      );
    }

    const localPlayer = state.players.get('player_local_1');
    let distFactor = 1.0;
    if (localPlayer && player.id !== localPlayer.id) {
      const d = Math.hypot(
        player.position.x - localPlayer.position.x,
        player.position.z - localPlayer.position.z
      );
      distFactor = Math.max(0, 1 - d / 160);
    }
    if (distFactor > 0.02) {
      sound.playWeaponFire(stats.category, distFactor);
    }

    const muzzlePos = new THREE.Vector3(
      player.position.x,
      player.position.y + 1.38,
      player.position.z
    );
    if (shooterMesh) {
      shooterMesh.getMuzzleWorldPosition(muzzlePos);
    }

    // Resolve what the player is actually pointing at before firing a single
    // pellet: camera ray -> aim point -> muzzle direction. See AimSolver.
    const solution = this.resolveLocalAim(
      player,
      cameraRay,
      muzzlePos,
      stats.range,
      state,
      world
    );
    this.lastAimSolution = solution;
    // The reticle goes "blocked" only for the case that actually matters: the
    // crosshair was on an enemy but the muzzle could not reach them. Firing into
    // a wall you are deliberately shooting at is not an error state.
    this.aimBlocked = solution.muzzleObstructed && solution.crosshairTargetId !== null;
    this.aimBlockedUntil = performance.now() + 400;

    if (stats.category !== 'harvester') {
      particles.spawnShellCasing(muzzlePos, player.yaw);
      if (distFactor > 0.15) {
        particles.spawnMuzzleSparks(
          muzzlePos,
          new THREE.Vector3(solution.fireDirection.x, solution.fireDirection.y, solution.fireDirection.z),
          stats.category
        );
      }
    }

    const effectiveSpread =
      stats.spreadRad * (player.isAiming ? stats.adsSpreadMultiplier : 1.0);

    let registeredAnyHit = false;
    let registeredHeadshot = false;
    let registeredShield = false;

    player.shotsFired++;

    for (let p = 0; p < stats.pellets; p++) {
      // Uniform disc inside a real cone around the resolved muzzle direction.
      // The old version offset x/y/z independently, which is a cube rather than
      // a cone, and it rotated its bias with the world axes instead of with the
      // weapon, so the same gun felt tighter facing north than facing east.
      const spread = spreadDirection(
        solution.fireDirection,
        effectiveSpread,
        this.spreadRng(),
        this.spreadRng()
      );
      const dir = new THREE.Vector3(spread.x, spread.y, spread.z);

      const fireOrigin = new THREE.Vector3(
        solution.fireOrigin.x,
        solution.fireOrigin.y,
        solution.fireOrigin.z
      );

      const hitResult = this.performShotRaycast(
        player,
        fireOrigin,
        dir,
        stats.range,
        state,
        world
      );

      if (stats.category !== 'harvester') {
        particles.spawnBulletTracer(muzzlePos, hitResult.point, stats.tracerColor);
      }
      if (!player.isBot && p === 0) {
        // Includes harvester swings: online server cadence/pellet credits
        // are keyed to this event, while remote clients use it for the
        // swing animation and distance-attenuated sound.
        this.onLocalWeaponFired?.(
          stats.category,
          muzzlePos,
          hitResult.point,
          stats.rarity,
          {
            origin: solution.fireOrigin,
            direction: solution.fireDirection,
            aimPoint: solution.aimPoint,
          }
        );
      }

      if (hitResult.hitPlayer) {
        registeredAnyHit = true;
        const isHead = hitResult.isHeadshot;
        const dmg = calculateWeaponDamage(stats, isHead);
        const hadShield = hitResult.hitPlayer.shield > 0;
        if (isHead) registeredHeadshot = true;
        if (hadShield) registeredShield = true;

        onPlayerHit(
          player,
          hitResult.hitPlayer,
          dmg,
          isHead,
          hadShield,
          stats.name,
          hitResult.point
        );
      } else if (hitResult.destructibleId) {
        const harvestMult = stats.category === 'harvester' ? 1.5 : 0.7;
        const propDmg = Math.round(stats.baseDamage * harvestMult);
        if (this.serverOwned(player)) {
          this.onLocalDestructibleDamaged?.(hitResult.destructibleId, propDmg);
          continue;
        }
        const res = world.damageDestructible(hitResult.destructibleId, propDmg);
        if (res) {
          if (!player.isBot) {
            this.onLocalDestructibleDamaged?.(hitResult.destructibleId, propDmg);
          }
          const matGain = stats.category === 'harvester' ? 12 : res.destroyed ? 8 : 0;
          if (matGain > 0) {
            if (res.materialType === 'wood') {
              player.materials.wood = Math.min(999, player.materials.wood + matGain);
            } else if (res.materialType === 'stone') {
              player.materials.stone = Math.min(999, player.materials.stone + matGain);
            } else {
              player.materials.metal = Math.min(999, player.materials.metal + matGain);
            }
          }
          if (!player.isBot && this.onLocalStructureFeedback) {
            if (matGain > 0 && stats.category === 'harvester') {
              const colorHex =
                res.materialType === 'wood'
                  ? '#f59e0b'
                  : res.materialType === 'stone'
                  ? '#cbd5e1'
                  : '#38bdf8';
              this.onLocalStructureFeedback(
                hitResult.point,
                `+${matGain} ${res.materialType.toUpperCase()}`,
                colorHex
              );
            } else if (!res.destroyed) {
              this.onLocalStructureFeedback(
                hitResult.point,
                `${res.health}/${res.maxHealth} HP`,
                '#fb923c'
              );
            }
          }
          particles.spawnSurfaceImpact(
            hitResult.point,
            res.materialType,
            res.destroyed
          );
          sound.playSurfaceImpact(res.materialType, distFactor);
        }
      } else if (hitResult.hitWorld) {
        particles.spawnSurfaceImpact(hitResult.point, 'terrain', false);
        sound.playSurfaceImpact('terrain', distFactor);
      }
    }

    if (registeredAnyHit) {
      player.shotsHit++;
      if (!player.isBot && !this.serverOwned(player) && onCrosshairHitmarker) {
        onCrosshairHitmarker(registeredHeadshot, registeredShield);
      }
    }
  }

  /**
   * Casts the camera ray against world geometry and every living character to
   * find the point under the crosshair, then converts that into a muzzle ray.
   */
  private resolveLocalAim(
    player: PlayerState,
    cameraRay: { origin: THREE.Vector3; direction: THREE.Vector3 },
    muzzle: THREE.Vector3,
    range: number,
    state: MatchState,
    world: IslandWorld
  ): AimSolution {
    const cameraOrigin: Vec3 = {
      x: cameraRay.origin.x,
      y: cameraRay.origin.y,
      z: cameraRay.origin.z,
    };
    const cameraDirection: Vec3 = {
      x: cameraRay.direction.x,
      y: cameraRay.direction.y,
      z: cameraRay.direction.z,
    };

    return resolveAim({
      cameraOrigin,
      cameraDirection,
      muzzle: { x: muzzle.x, y: muzzle.y, z: muzzle.z },
      range,
      castWorld: (origin, direction, maxDistance) => {
        const scratchOrigin = new THREE.Vector3(origin.x, origin.y, origin.z);
        const scratchDirection = new THREE.Vector3(direction.x, direction.y, direction.z);
        const hit = world.raycastWorld(scratchOrigin, scratchDirection, maxDistance);
        const terrainHit = this.castTerrain(
          world,
          origin,
          direction,
          hit ? Math.min(maxDistance, hit.distance) : maxDistance
        );
        if (hit || terrainHit) {
          const useTerrain = !hit || (terrainHit && terrainHit.distance < hit.distance);
          if (useTerrain && terrainHit) return terrainHit;
          if (hit) {
            return {
              distance: hit.distance,
              point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
            };
          }
        }
        return null;
      },
      castTargets: (origin, direction, maxDistance) =>
        this.castPlayerHitboxes(
          state,
          player.id,
          origin,
          direction,
          maxDistance
        ),
    });
  }

  /**
   * Terrain is not part of `IslandWorld.raycastWorld`, so aiming at the ground
   * used to return "nothing" and the shot flew off into the sky along the view
   * axis. A short march against the heightfield fixes the aim point for ground
   * shots without adding terrain to the raycaster.
   */
  private castTerrain(
    world: IslandWorld,
    origin: Vec3,
    direction: Vec3,
    maxDistance: number
  ): { distance: number; point: Vec3 } | null {
    const limit = Math.min(maxDistance, 160);
    if (limit <= 0.2) return null;
    const step = Math.max(0.4, Math.min(1.2, limit / 64));
    let previous = 0;
    for (let travelled = step; travelled <= limit; travelled += step) {
      const x = origin.x + direction.x * travelled;
      const y = origin.y + direction.y * travelled;
      const z = origin.z + direction.z * travelled;
      const ground = world.terrain.getTerrainHeight(x, z);
      if (y <= ground) {
        // Refine linearly between the last clear sample and this one.
        const lo = previous;
        const hi = travelled;
        let best = hi;
        for (let i = 0; i < 6; i++) {
          const mid = (lo + best) * 0.5;
          const mx = origin.x + direction.x * mid;
          const my = origin.y + direction.y * mid;
          const mz = origin.z + direction.z * mid;
          if (my <= world.terrain.getTerrainHeight(mx, mz)) best = mid;
          else break;
        }
        const px = origin.x + direction.x * best;
        const pz = origin.z + direction.z * best;
        return {
          distance: best,
          point: {
            x: px,
            y: world.terrain.getTerrainHeight(px, pz),
            z: pz,
          },
        };
      }
      previous = travelled;
    }
    return null;
  }

  private castPlayerHitboxes(
    state: MatchState,
    shooterId: string,
    origin: Vec3,
    direction: Vec3,
    maxDistance: number
  ): { targetId: string; distance: number; point: Vec3 } | null {
    const candidates: { id: string; position: Vec3 }[] = [];
    for (const candidate of state.players.values()) {
      if (!candidate.alive || candidate.id === shooterId) continue;
      candidates.push({
        id: candidate.id,
        position: {
          x: candidate.position.x,
          y: candidate.position.y,
          z: candidate.position.z,
        },
      });
    }
    if (candidates.length === 0) return null;

    const hit = raycastPlayers(
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      candidates,
      maxDistance,
      0,
      shooterId
    );
    if (!hit) return null;
    return { targetId: hit.id, distance: hit.t, point: hit.point };
  }

  /** True briefly after a shot whose muzzle ray was stopped by cover. */
  public isAimBlocked(): boolean {
    return this.aimBlocked && performance.now() < this.aimBlockedUntil;
  }

  private performShotRaycast(
    shooter: PlayerState,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxRange: number,
    state: MatchState,
    world: IslandWorld
  ): {
    point: THREE.Vector3;
    hitWorld: boolean;
    destructibleId?: string;
    hitPlayer?: PlayerState;
    isHeadshot: boolean;
  } {
    const worldHit = world.raycastWorld(origin, direction, maxRange);
    const terrainHit = this.castTerrain(
      world,
      { x: origin.x, y: origin.y, z: origin.z },
      { x: direction.x, y: direction.y, z: direction.z },
      worldHit ? Math.min(maxRange, worldHit.distance) : maxRange
    );

    let closestDist = maxRange;
    let closestPoint = origin.clone().addScaledVector(direction, maxRange);
    let destructibleId: string | undefined;
    let hitWorld = false;

    if (worldHit && worldHit.distance <= closestDist) {
      closestDist = worldHit.distance;
      closestPoint = worldHit.point.clone();
      destructibleId = worldHit.destructibleId;
      hitWorld = true;
    }
    if (terrainHit && terrainHit.distance < closestDist) {
      closestDist = terrainHit.distance;
      closestPoint = new THREE.Vector3(
        terrainHit.point.x,
        terrainHit.point.y,
        terrainHit.point.z
      );
      destructibleId = undefined;
      hitWorld = true;
    }

    // Character hitboxes come from shared/hitbox.mjs so the client and the
    // authoritative server agree on what "hitting a player" means.
    const candidates: { id: string; position: Vec3 }[] = [];
    for (const candidate of state.players.values()) {
      if (!candidate.alive || candidate.id === shooter.id) continue;
      candidates.push({
        id: candidate.id,
        position: {
          x: candidate.position.x,
          y: candidate.position.y,
          z: candidate.position.z,
        },
      });
    }

    const playerHit = raycastPlayers(
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      candidates,
      closestDist,
      0,
      shooter.id
    );

    if (playerHit) {
      const victim = state.players.get(playerHit.id);
      if (victim) {
        return {
          point: new THREE.Vector3(
            playerHit.point.x,
            playerHit.point.y,
            playerHit.point.z
          ),
          hitWorld: false,
          destructibleId: undefined,
          hitPlayer: victim,
          isHeadshot: playerHit.headshot,
        };
      }
    }

    return {
      point: closestPoint,
      hitWorld,
      destructibleId,
      hitPlayer: undefined,
      isHeadshot: false,
    };
  }

  private startReloadIfClipEmpty(
    player: PlayerState,
    stats: WeaponStats,
    sound: SoundManager
  ): void {
    const slot = player.inventory[player.activeSlot];
    if (
      !slot ||
      stats.ammoType === 'none' ||
      slot.clipAmmo > 0 ||
      this.getReserveAmmo(player, stats.ammoType) <= 0
    ) {
      return;
    }
    this.burstQueues.delete(player.id);
    player.isReloading = true;
    player.reloadDuration = stats.reloadTime;
    player.reloadTimer = stats.reloadTime;
    if (this.serverOwned(player)) this.onInventoryAction?.('reload');
    if (!player.isBot) sound.playReload(stats.category);
  }

  private getReserveAmmo(player: PlayerState, type: AmmoType): number {
    if (type === 'light') return player.ammo.light;
    if (type === 'medium') return player.ammo.medium;
    if (type === 'shells') return player.ammo.shells;
    if (type === 'heavy') return player.ammo.heavy;
    return 0;
  }

  private finishReload(player: PlayerState, stats: WeaponStats): void {
    const slot = player.inventory[player.activeSlot];
    if (!slot || stats.ammoType === 'none') return;

    const needed = slot.maxClipAmmo - slot.clipAmmo;
    if (needed <= 0) return;

    const available = (this.getReserveAmmo(player, stats.ammoType) as number) || 0;
    const loaded = Math.min(needed, available);
    slot.clipAmmo += loaded;

    if (stats.ammoType === 'light') player.ammo.light -= loaded;
    else if (stats.ammoType === 'medium') player.ammo.medium -= loaded;
    else if (stats.ammoType === 'shells') player.ammo.shells -= loaded;
    else if (stats.ammoType === 'heavy') player.ammo.heavy -= loaded;
  }
}
