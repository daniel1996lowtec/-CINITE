/**
 * Pure, deterministic pose helpers shared by the rigged GLTF character and
 * the procedural fallback. Keeping the curves separate from Three.js objects
 * makes reload/switch/turn timing testable and ensures both presentation
 * paths react to the same authoritative PlayerState fields.
 */

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

export interface ReloadAnimationPose {
  progress: number;
  magazineOffsetY: number;
  boltPull: number;
  stage: 'drop' | 'insert' | 'charge' | 'complete';
}

/**
 * Maps the authoritative reload countdown to a three-stage presentation:
 * magazine drop, magazine insertion, then slide/bolt charge. When a state
 * has no usable duration (older snapshots), elapsed presentation time is
 * used as a bounded fallback rather than snapping the magazine.
 */
export function getReloadAnimationPose(
  reloadTimer: number,
  reloadDuration: number,
  fallbackElapsed: number = 0
): ReloadAnimationPose {
  const duration = Math.max(0, Number(reloadDuration) || 0);
  const progress =
    duration > 0.05
      ? clamp01(1 - Math.max(0, Number(reloadTimer) || 0) / duration)
      : clamp01((Math.max(0, fallbackElapsed) % 1.4) / 1.4);

  if (progress < 0.38) {
    return {
      progress,
      magazineOffsetY: -0.14 * Math.sin((progress / 0.38) * Math.PI / 2),
      boltPull: 0,
      stage: 'drop',
    };
  }
  if (progress < 0.72) {
    const insert = (progress - 0.38) / 0.34;
    return {
      progress,
      magazineOffsetY: -(1 - insert) * 0.14,
      boltPull: 0,
      stage: 'insert',
    };
  }
  if (progress < 1) {
    return {
      progress,
      magazineOffsetY: 0,
      boltPull: Math.sin(((progress - 0.72) / 0.28) * Math.PI) * 0.16,
      stage: 'charge',
    };
  }
  return { progress: 1, magazineOffsetY: 0, boltPull: 0, stage: 'complete' };
}

export interface WeaponSwitchPose {
  progress: number;
  pitchOffset: number;
  dipY: number;
  roll: number;
}

/** Lower-and-raise curve used after an inventory slot change. */
export function getWeaponSwitchPose(
  timerRemaining: number,
  duration: number = 0.24
): WeaponSwitchPose {
  const safeDuration = Math.max(0.01, duration);
  const remaining = clamp01(Math.max(0, timerRemaining) / safeDuration);
  const progress = 1 - remaining;
  const arc = Math.sin(progress * Math.PI) ** 2;
  return {
    progress,
    pitchOffset: -0.95 * arc,
    dipY: -arc * 0.075,
    roll: arc * 0.1,
  };
}

/**
 * Smooth, clamped torso lean from turn rate. Aiming and stationary turns are
 * deliberately subdued so the visual mesh never leans outside the gameplay
 * capsule in a way that could misrepresent the server hit volume.
 */
export function getTurnLean(
  currentLean: number,
  yawDelta: number,
  dt: number,
  horizontalSpeed: number,
  isAiming: boolean
): number {
  const safeDt = Math.max(0.001, Math.min(0.1, Number(dt) || 0.016));
  const angularVelocity = clamp((Number(yawDelta) || 0) / safeDt, -7, 7);
  const speedFactor = clamp(horizontalSpeed / 7, 0.25, 1);
  const aimFactor = isAiming ? 0.45 : 1;
  const target = clamp(-angularVelocity * 0.022 * speedFactor * aimFactor, -0.16, 0.16);
  const blend = 1 - Math.exp(-safeDt * 11);
  return currentLean + (target - currentLean) * blend;
}

export interface LocomotionBlend {
  idle: number;
  walk: number;
  run: number;
  walkTimeScale: number;
  runTimeScale: number;
}

export function getLocomotionBlend(
  horizontalSpeed: number,
  isSprinting: boolean,
  isGrounded: boolean,
  isGliding: boolean
): LocomotionBlend {
  if (!isGrounded || isGliding || horizontalSpeed <= 0.45) {
    return { idle: 1, walk: 0, run: 0, walkTimeScale: 1, runTimeScale: 1 };
  }
  if (isSprinting || horizontalSpeed > 8.2) {
    return {
      idle: 0,
      walk: 0,
      run: 1,
      walkTimeScale: 1.2,
      runTimeScale: clamp((horizontalSpeed / 10) * 1.38, 1.18, 1.52),
    };
  }
  if (horizontalSpeed > 4.6) {
    const run = clamp((horizontalSpeed - 4.2) / 2.2, 0.25, 1);
    return {
      idle: 0,
      walk: 1 - run,
      run,
      walkTimeScale: 1.2,
      runTimeScale: clamp(horizontalSpeed / 6.7, 0.82, 1.18),
    };
  }
  return {
    idle: 0,
    walk: 1,
    run: 0,
    walkTimeScale: clamp(horizontalSpeed / 3.4, 0.72, 1.35),
    runTimeScale: 1,
  };
}

export interface AirbornePose {
  riseBlend: number;
  fallBlend: number;
  legBend: number;
  spinePitch: number;
}

export function getAirbornePose(verticalVelocity: number): AirbornePose {
  const vy = Number(verticalVelocity) || 0;
  const riseBlend = clamp01(vy / 9.7);
  const fallBlend = clamp01(-vy / 14);
  return {
    riseBlend,
    fallBlend,
    legBend: 0.42 + riseBlend * 0.38 + fallBlend * 0.14,
    spinePitch: 0.05 + riseBlend * 0.1 - fallBlend * 0.03,
  };
}

export type PresentationState = 'idle' | 'ready' | 'walk' | 'run' | 'sprint' |
  'jump' | 'fall' | 'land' | 'glide' | 'aim' | 'fire' | 'reload' | 'switch' | 'eliminated';

/** Presentation selection only: never modifies the gameplay snapshot. */
export function selectPresentationState(state: {
  alive: boolean; isGliding: boolean; isGrounded: boolean; isReloading: boolean;
  isAiming: boolean; isSprinting: boolean; velocity: { x: number; y: number; z: number };
}, fireRemaining = 0, switchRemaining = 0, landingRemaining = 0): PresentationState {
  if (!state.alive) return 'eliminated';
  if (state.isGliding) return 'glide';
  if (!state.isGrounded) return state.velocity.y > 1.2 ? 'jump' : 'fall';
  if (state.isReloading) return 'reload';
  if (switchRemaining > 0) return 'switch';
  if (fireRemaining > 0) return 'fire';
  if (landingRemaining > 0) return 'land';
  if (state.isAiming) return 'aim';
  const speed = Math.hypot(state.velocity.x, state.velocity.z);
  if (speed <= 0.45) return 'ready';
  if (state.isSprinting || speed > 8.2) return 'sprint';
  return speed > 4.6 ? 'run' : 'walk';
}
