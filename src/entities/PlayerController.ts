import * as THREE from 'three';
import {
  AmmoType,
  BuildMaterialType,
  BuildPieceType,
  MatchState,
  PlayerInputPacket,
  PlayerState,
} from '../network/schemas';
import { IslandWorld } from '../world/IslandWorld';
import { createWeaponStats, WeaponStats } from '../weapons/WeaponDefinitions';
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

export class PlayerController {
  private fireCooldown: Map<string, number> = new Map();
  private prevFireHeld: Map<string, boolean> = new Map();
  private lastFireTimeMs: Map<string, number> = new Map();
  private footstepTimer: number = 0;

  public onLocalReloadCompleted?: () => void;

  public updateLocalPlayer(
    player: PlayerState,
    input: PlayerInputPacket,
    state: MatchState,
    world: IslandWorld,
    meshes: Map<string, CharacterMesh>,
    lootSystem: LootSystem,
    particles: ParticleSystem,
    sound: SoundManager,
    aimRay: { origin: THREE.Vector3; direction: THREE.Vector3 },
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
      const glideSpeed = input.sprint ? 22.0 : 15.0;
      const descendRate = input.sprint ? -17.0 : -7.8;
      player.velocity.x = normX * glideSpeed;
      player.velocity.z = normZ * glideSpeed;
      player.velocity.y = descendRate;

      player.position.x += player.velocity.x * dt;
      player.position.z += player.velocity.z * dt;
      player.position.y += player.velocity.y * dt;

      const groundY = world.getGroundHeightAt(
        player.position.x,
        player.position.y,
        player.position.z
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
        sound.playFootstep(player.isSprinting);
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

    // Apply horizontal displacement + collision resolution
    const nextX = player.position.x + player.velocity.x * dt;
    const nextZ = player.position.z + player.velocity.z * dt;
    const resolved = world.resolveHorizontalCollision(nextX, player.position.y, nextZ, 0.48);
    player.position.x = resolved.x;
    player.position.z = resolved.z;

    // Apply vertical displacement + floor/ramp snap
    player.position.y += player.velocity.y * dt;
    const groundY = world.getGroundHeightAt(
      player.position.x,
      player.position.y,
      player.position.z
    );

    if (player.position.y <= groundY) {
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
      aimRay,
      onPlayerHit,
      onCrosshairHitmarker,
      onRecoilKick
    );
  }

  public onLocalWeaponFired?: (
    category: string,
    muzzlePos: THREE.Vector3,
    hitPoint: THREE.Vector3
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
      return null;
    }

    const cost = 10;
    let matUsed: BuildMaterialType | null = null;

    const pref = player.selectedMaterial;
    if (pref === 'wood' && player.materials.wood >= cost) {
      player.materials.wood -= cost;
      matUsed = 'wood';
    } else if (pref === 'stone' && player.materials.stone >= cost) {
      player.materials.stone -= cost;
      matUsed = 'stone';
    } else if (pref === 'metal' && player.materials.metal >= cost) {
      player.materials.metal -= cost;
      matUsed = 'metal';
    } else if (player.materials.wood >= cost) {
      player.materials.wood -= cost;
      matUsed = 'wood';
    } else if (player.materials.stone >= cost) {
      player.materials.stone -= cost;
      matUsed = 'stone';
    } else if (player.materials.metal >= cost) {
      player.materials.metal -= cost;
      matUsed = 'metal';
    }

    if (!matUsed) return null;

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
    aimRay: { origin: THREE.Vector3; direction: THREE.Vector3 },
    onPlayerHit: ShotHitCallback,
    onCrosshairHitmarker?: (isHeadshot: boolean, isShield: boolean) => void,
    onRecoilKick?: (
      pitchKick: number,
      yawKick: number,
      category?: string,
      isAiming?: boolean
    ) => void
  ): void {
    const currentCd = Math.max(0, (this.fireCooldown.get(player.id) || 0) - dt);
    this.fireCooldown.set(player.id, currentCd);

    const slot = player.inventory[player.activeSlot];
    if (!slot) {
      this.prevFireHeld.set(player.id, wantsFire);
      return;
    }

    const stats = createWeaponStats(slot.category, slot.rarity);

    if (player.isReloading) {
      player.reloadTimer -= dt;
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
      player.isReloading = true;
      player.reloadDuration = stats.reloadTime;
      player.reloadTimer = stats.reloadTime;
      if (!player.isBot) sound.playReload(stats.category);
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
        if (!player.isBot) sound.playReload(stats.category);
      }
      return;
    }

    if (stats.ammoType !== 'none') {
      slot.clipAmmo = Math.max(0, slot.clipAmmo - 1);
    }

    this.lastFireTimeMs.set(player.id, nowMs);
    this.fireCooldown.set(player.id, 1 / stats.fireRate);

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

    if (stats.category !== 'harvester') {
      particles.spawnShellCasing(muzzlePos, player.yaw);
      if (distFactor > 0.15) {
        particles.spawnMuzzleSparks(muzzlePos, aimRay.direction, stats.category);
      }
    }

    const effectiveSpread =
      stats.spreadRad * (player.isAiming ? stats.adsSpreadMultiplier : 1.0);

    let registeredAnyHit = false;
    let registeredHeadshot = false;
    let registeredShield = false;

    player.shotsFired++;

    for (let p = 0; p < stats.pellets; p++) {
      const dir = aimRay.direction.clone();
      if (effectiveSpread > 0) {
        dir.x += (Math.random() - 0.5) * effectiveSpread * 2;
        dir.y += (Math.random() - 0.5) * effectiveSpread * 2;
        dir.z += (Math.random() - 0.5) * effectiveSpread * 2;
        dir.normalize();
      }

      const hitResult = this.performShotRaycast(
        player,
        aimRay.origin,
        dir,
        stats.range,
        state,
        world
      );

      if (stats.category !== 'harvester') {
        particles.spawnBulletTracer(
          muzzlePos,
          hitResult.point,
          stats.category === 'sniper' ? 0x38bdf8 : 0xfef08a
        );
        if (!player.isBot && p === 0) {
          this.onLocalWeaponFired?.(stats.category, muzzlePos, hitResult.point);
        }
      }

      if (hitResult.hitPlayer) {
        registeredAnyHit = true;
        const isHead = hitResult.isHeadshot;
        const dmg = Math.round(
          stats.baseDamage * (isHead ? stats.headshotMultiplier : 1.0)
        );
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
      if (!player.isBot && onCrosshairHitmarker) {
        onCrosshairHitmarker(registeredHeadshot, registeredShield);
      }
    }

    if (
      stats.ammoType !== 'none' &&
      slot.clipAmmo <= 0 &&
      this.getReserveAmmo(player, stats.ammoType) > 0
    ) {
      player.isReloading = true;
      player.reloadDuration = stats.reloadTime;
      player.reloadTimer = stats.reloadTime;
      if (!player.isBot) sound.playReload(stats.category);
    }
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
    let closestDist = worldHit ? worldHit.distance : maxRange;
    let closestPoint = worldHit
      ? worldHit.point.clone()
      : origin.clone().addScaledVector(direction, maxRange);
    let destructibleId = worldHit?.destructibleId;

    const shooterDistFromOrigin = origin.distanceTo(
      new THREE.Vector3(shooter.position.x, shooter.position.y + 1.4, shooter.position.z)
    );
    const minValidDist = Math.max(0.2, shooterDistFromOrigin - 0.5);

    if (worldHit && worldHit.distance < minValidDist) {
      closestDist = maxRange;
      closestPoint = origin.clone().addScaledVector(direction, maxRange);
      destructibleId = undefined;
    }

    let hitPlayer: PlayerState | undefined;
    let isHeadshot = false;

    for (const candidate of state.players.values()) {
      if (!candidate.alive || candidate.id === shooter.id) continue;

      const targetCenter = new THREE.Vector3(
        candidate.position.x,
        candidate.position.y + 1.0,
        candidate.position.z
      );
      const toTarget = targetCenter.clone().sub(origin);
      const t = toTarget.dot(direction);
      if (t < minValidDist || t > closestDist) continue;

      const closestOnRay = origin.clone().addScaledVector(direction, t);
      const horizDist = Math.hypot(
        closestOnRay.x - candidate.position.x,
        closestOnRay.z - candidate.position.z
      );
      const relY = closestOnRay.y - candidate.position.y;

      if (horizDist <= 0.54 && relY >= -0.05 && relY <= 2.08) {
        closestDist = t;
        closestPoint = closestOnRay;
        hitPlayer = candidate;
        isHeadshot = relY >= 1.48;
      }
    }

    return {
      point: closestPoint,
      hitWorld: !!worldHit && !hitPlayer,
      destructibleId: hitPlayer ? undefined : destructibleId,
      hitPlayer,
      isHeadshot,
    };
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
