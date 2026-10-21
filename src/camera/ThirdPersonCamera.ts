import * as THREE from 'three';
import { PlayerState, WeaponCategory } from '../network/schemas';
import { createWeaponStats } from '../weapons/WeaponDefinitions';
import { IslandWorld } from '../world/IslandWorld';

export class ThirdPersonCamera {
  public camera: THREE.PerspectiveCamera;
  public yaw: number = 0;
  public pitch: number = 0.08;
  public sensitivity: number = 1.0;

  private currentPos = new THREE.Vector3(0, 12, 12);
  private currentLookAt = new THREE.Vector3(0, 2, 0);
  private lastTargetPos = new THREE.Vector3(0, 2, 0);

  private recoilPitchOffset = 0;
  private recoilYawOffset = 0;
  private recoilFovOffset = 0;
  private hitConfirmFovPulse = 0;
  private screenShakeIntensity = 0;
  private swayPhase = 0;
  private aimBlend = 0;
  private shotStreak = 0;
  private lastShotTime = 0;

  private readonly scratchForward = new THREE.Vector3();
  private readonly scratchRight = new THREE.Vector3();
  private readonly scratchPivot = new THREE.Vector3();
  private readonly scratchDesiredPos = new THREE.Vector3();
  private readonly scratchToCam = new THREE.Vector3();
  private readonly scratchDir = new THREE.Vector3();
  private readonly scratchTestPt = new THREE.Vector3();
  private readonly scratchAimTarget = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(68, aspect, 0.15, 520);
  }

  public resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  public handleMouseMove(movementX: number, movementY: number): void {
    const sens = 0.0022 * this.sensitivity;
    this.yaw -= movementX * sens;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - movementY * sens,
      -1.15,
      1.15
    );
  }

  /**
   * Applies per-weapon recoil patterns, vertical climb, horizontal drift,
   * and FOV punch while preserving WeaponDefinitions balance.
   */
  public applyRecoil(
    pitchKick: number,
    yawKick: number,
    category?: WeaponCategory,
    isAiming: boolean = false
  ): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastShotTime > 380) {
      this.shotStreak = 0;
    }
    this.shotStreak++;
    this.lastShotTime = now;

    const adsScale = isAiming ? 0.72 : 1.0;
    let patternYaw = (Math.random() - 0.5) * 2 * yawKick;

    if (category === 'assault_rifle') {
      const wave = Math.sin(this.shotStreak * 0.85) * yawKick * 0.9;
      patternYaw = wave + (Math.random() - 0.5) * yawKick * 0.45;
      this.recoilFovOffset = Math.min(2.2, this.recoilFovOffset + 0.45);
    } else if (category === 'smg') {
      const jitter = (this.shotStreak % 2 === 0 ? 1 : -1) * yawKick * 0.65;
      patternYaw = jitter + (Math.random() - 0.5) * yawKick * 0.85;
      this.recoilFovOffset = Math.min(1.6, this.recoilFovOffset + 0.28);
    } else if (category === 'shotgun') {
      this.recoilFovOffset = Math.min(4.5, this.recoilFovOffset + 2.4);
      this.addScreenShake(0.14);
    } else if (category === 'sniper') {
      this.recoilFovOffset = Math.min(5.0, this.recoilFovOffset + 3.0);
      this.addScreenShake(0.16);
    } else if (category === 'pistol') {
      this.recoilFovOffset = Math.min(1.5, this.recoilFovOffset + 0.5);
    }

    this.pitch = THREE.MathUtils.clamp(
      this.pitch + pitchKick * 0.65 * adsScale,
      -1.15,
      1.15
    );
    this.yaw += patternYaw * 0.65 * adsScale;

    this.recoilPitchOffset = Math.min(
      0.2,
      this.recoilPitchOffset + pitchKick * 0.45 * adsScale
    );
    this.recoilYawOffset = THREE.MathUtils.clamp(
      this.recoilYawOffset + patternYaw * 0.45 * adsScale,
      -0.14,
      0.14
    );
  }

  public addScreenShake(intensity: number): void {
    this.screenShakeIntensity = Math.min(0.35, this.screenShakeIntensity + intensity);
  }

  /**
   * Brief, tasteful micro-FOV confirmation pulse when a shot connects on a target.
   * Gives tactile combat feedback without roll or motion-sickness camera shake.
   */
  public applyHitConfirmationPulse(
    isHeadshot: boolean = false,
    isElimination: boolean = false
  ): void {
    const pulse = isElimination ? -1.15 : isHeadshot ? -0.75 : -0.42;
    this.hitConfirmFovPulse = Math.max(-1.4, Math.min(this.hitConfirmFovPulse, pulse));
  }

  public update(
    targetPlayer: PlayerState,
    dt: number,
    world: IslandWorld
  ): void {
    this.lastTargetPos.set(
      targetPlayer.position.x,
      targetPlayer.position.y,
      targetPlayer.position.z
    );

    // Smoothly decay recoil and FOV impulse
    this.recoilPitchOffset = THREE.MathUtils.lerp(
      this.recoilPitchOffset,
      0,
      Math.min(1, dt * 12)
    );
    this.recoilYawOffset = THREE.MathUtils.lerp(
      this.recoilYawOffset,
      0,
      Math.min(1, dt * 12)
    );
    this.recoilFovOffset = THREE.MathUtils.lerp(
      this.recoilFovOffset,
      0,
      Math.min(1, dt * 14)
    );
    this.hitConfirmFovPulse = THREE.MathUtils.lerp(
      this.hitConfirmFovPulse,
      0,
      Math.min(1, dt * 20)
    );
    this.screenShakeIntensity = THREE.MathUtils.lerp(
      this.screenShakeIntensity,
      0,
      Math.min(1, dt * 14)
    );

    const isAiming = targetPlayer.isAiming && !targetPlayer.isGliding;
    const isGliding = targetPlayer.isGliding;
    const isSprinting = targetPlayer.isSprinting;

    const slot = targetPlayer.inventory[targetPlayer.activeSlot];
    const stats = slot
      ? createWeaponStats(slot.category, slot.rarity)
      : createWeaponStats('harvester', 'rare');
    const adsFov = stats.adsFov || 50;

    // Smooth ADS blend for camera shoulder offset and breathing sway
    this.aimBlend = THREE.MathUtils.lerp(
      this.aimBlend,
      isAiming ? 1 : 0,
      Math.min(1, dt * 14)
    );
    this.swayPhase += dt * (isSprinting ? 7.5 : isAiming ? 1.6 : 2.4);

    // Target FOV transition (ADS zooms in; sprinting/gliding widens FOV; recoil/hit-confirm adds tactile punch)
    const baseTargetFov = isGliding
      ? 80
      : isAiming
      ? adsFov
      : isSprinting
      ? 74
      : 68;
    const targetFov = baseTargetFov + this.recoilFovOffset + this.hitConfirmFovPulse;
    if (Math.abs(this.camera.fov - targetFov) > 0.04) {
      this.camera.fov = THREE.MathUtils.lerp(
        this.camera.fov,
        targetFov,
        Math.min(1, dt * 16)
      );
      this.camera.updateProjectionMatrix();
    }

    const subtleBreathPitch =
      Math.sin(this.swayPhase) * 0.0011 * (1 - this.aimBlend * 0.68);
    const subtleBreathYaw =
      Math.cos(this.swayPhase * 0.5) * 0.0008 * (1 - this.aimBlend * 0.68);

    const effectiveYaw = this.yaw + this.recoilYawOffset + subtleBreathYaw;
    const effectivePitch = THREE.MathUtils.clamp(
      this.pitch + this.recoilPitchOffset + subtleBreathPitch,
      -1.15,
      1.15
    );

    // Smoothly interpolate shoulder offset between hip-fire and ADS
    const followDist = isGliding
      ? 7.2
      : THREE.MathUtils.lerp(4.4, 2.35, this.aimBlend);
    const rightShoulder = isGliding
      ? 0.0
      : THREE.MathUtils.lerp(1.05, 0.82, this.aimBlend);
    const heightOffset = isGliding
      ? 2.6
      : THREE.MathUtils.lerp(1.95, 1.76, this.aimBlend);

    const forward = this.scratchForward
      .set(
        -Math.sin(effectiveYaw) * Math.cos(effectivePitch),
        Math.sin(effectivePitch),
        -Math.cos(effectiveYaw) * Math.cos(effectivePitch)
      )
      .normalize();

    const right = this.scratchRight
      .set(Math.cos(effectiveYaw), 0, -Math.sin(effectiveYaw))
      .normalize();

    const pivot = this.scratchPivot.set(
      this.lastTargetPos.x,
      this.lastTargetPos.y + heightOffset,
      this.lastTargetPos.z
    );

    const desiredPos = this.scratchDesiredPos
      .copy(pivot)
      .addScaledVector(right, rightShoulder)
      .addScaledVector(forward, -followDist);

    // Clamp above terrain height so camera never goes underground
    const terrainY = world.terrain.getTerrainHeight(desiredPos.x, desiredPos.z);
    if (desiredPos.y < terrainY + 0.65) {
      desiredPos.y = terrainY + 0.65;
    }

    // Ray-step obstacle avoidance against box colliders
    const toCam = this.scratchToCam.copy(desiredPos).sub(pivot);
    const totalDist = toCam.length();
    if (totalDist > 0.1) {
      const dir = this.scratchDir.copy(toCam).multiplyScalar(1 / totalDist);
      for (let step = 0.25; step <= 1.0; step += 0.2) {
        const testPt = this.scratchTestPt
          .copy(pivot)
          .addScaledVector(dir, totalDist * step);
        for (const col of world.boxColliders) {
          if (
            testPt.x >= col.minX &&
            testPt.x <= col.maxX &&
            testPt.y >= col.minY &&
            testPt.y <= col.maxY &&
            testPt.z >= col.minZ &&
            testPt.z <= col.maxZ
          ) {
            desiredPos
              .copy(pivot)
              .addScaledVector(dir, Math.max(1.0, totalDist * (step - 0.18)));
            break;
          }
        }
      }
    }

    if (this.screenShakeIntensity > 0.005) {
      desiredPos.x += (Math.random() - 0.5) * this.screenShakeIntensity;
      desiredPos.y += (Math.random() - 0.5) * this.screenShakeIntensity;
    }

    this.currentPos.lerp(desiredPos, Math.min(1, dt * 20));
    this.camera.position.copy(this.currentPos);

    const aimTarget = this.scratchAimTarget
      .copy(pivot)
      .addScaledVector(forward, 32);
    this.currentLookAt.lerp(aimTarget, Math.min(1, dt * 26));
    this.camera.lookAt(this.currentLookAt);
  }

  public getAimRay(): { origin: THREE.Vector3; direction: THREE.Vector3 } {
    const effYaw = this.yaw + this.recoilYawOffset;
    const effPitch = THREE.MathUtils.clamp(
      this.pitch + this.recoilPitchOffset,
      -1.15,
      1.15
    );

    const direction = new THREE.Vector3(
      -Math.sin(effYaw) * Math.cos(effPitch),
      Math.sin(effPitch),
      -Math.cos(effYaw) * Math.cos(effPitch)
    ).normalize();

    const origin = new THREE.Vector3(
      this.lastTargetPos.x,
      this.lastTargetPos.y + 1.55,
      this.lastTargetPos.z
    ).addScaledVector(direction, 0.55);

    return { origin, direction };
  }
}
