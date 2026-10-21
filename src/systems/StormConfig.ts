import type { StormState } from '../network/schemas';

export interface StormPhaseConfig {
  phase: number;
  /** Preparation time before this phase starts moving. */
  waitSeconds: number;
  /** Time spent linearly moving from the current circle to the target circle. */
  shrinkSeconds: number;
  targetRadius: number;
  damagePerSecond: number;
}

export const STORM_INITIAL_RADIUS = 255;
export const STORM_INITIAL_TARGET_CENTER = { x: 12, z: -10 } as const;

/**
 * Strategic 11.5-minute maximum storm schedule.
 *
 * The first circle gives players 90 seconds to land/loot and another 70
 * seconds while it moves. Later phases retain a real repositioning window,
 * but the final 4 m circle and 15 dps still force a decisive endgame. The
 * Node server mirrors this table and interpolation algorithm for online
 * rooms; offline play uses this module directly.
 */
export const STORM_PHASES: readonly StormPhaseConfig[] = [
  { phase: 1, waitSeconds: 90, shrinkSeconds: 70, targetRadius: 150, damagePerSecond: 1 },
  { phase: 2, waitSeconds: 70, shrinkSeconds: 60, targetRadius: 105, damagePerSecond: 2 },
  { phase: 3, waitSeconds: 55, shrinkSeconds: 50, targetRadius: 72, damagePerSecond: 3 },
  { phase: 4, waitSeconds: 45, shrinkSeconds: 42, targetRadius: 48, damagePerSecond: 5 },
  { phase: 5, waitSeconds: 35, shrinkSeconds: 34, targetRadius: 30, damagePerSecond: 7 },
  { phase: 6, waitSeconds: 28, shrinkSeconds: 28, targetRadius: 18, damagePerSecond: 9 },
  { phase: 7, waitSeconds: 22, shrinkSeconds: 24, targetRadius: 10, damagePerSecond: 12 },
  { phase: 8, waitSeconds: 18, shrinkSeconds: 20, targetRadius: 4, damagePerSecond: 15 },
] as const;

export const STORM_TOTAL_SCHEDULE_SECONDS = STORM_PHASES.reduce(
  (total, phase) => total + phase.waitSeconds + phase.shrinkSeconds,
  0
);

export function getStormPhaseConfig(phase: number): StormPhaseConfig {
  const index = Math.max(
    0,
    Math.min(STORM_PHASES.length - 1, Math.floor(phase) - 1)
  );
  return STORM_PHASES[index];
}

export function isFinalStormPhase(storm: StormState): boolean {
  return storm.phase > STORM_PHASES.length;
}

export function createInitialStormState(): StormState {
  const first = getStormPhaseConfig(1);
  return {
    phase: 1,
    currentCenterX: 0,
    currentCenterZ: 0,
    currentRadius: STORM_INITIAL_RADIUS,
    targetCenterX: STORM_INITIAL_TARGET_CENTER.x,
    targetCenterZ: STORM_INITIAL_TARGET_CENTER.z,
    targetRadius: first.targetRadius,
    phaseTimer: first.waitSeconds,
    isShrinking: false,
    damagePerSecond: first.damagePerSecond,
    shrinkFromCenterX: 0,
    shrinkFromCenterZ: 0,
    shrinkFromRadius: STORM_INITIAL_RADIUS,
    shrinkElapsed: 0,
    shrinkDuration: 0,
  };
}

function chooseNextTargetCenter(
  storm: StormState,
  nextPhase: StormPhaseConfig
): { x: number; z: number } {
  const shrinkAmount = Math.max(0, storm.currentRadius - nextPhase.targetRadius);
  // Keep the next circle comfortably nested in the current one. A golden-
  // angle sequence varies the endgame location without Math.random(), so
  // the server mirror and offline simulation choose the same centres.
  const shift = shrinkAmount * 0.42;
  const angle = nextPhase.phase * 2.399963229728653 + 0.7;
  return {
    x: storm.currentCenterX + Math.cos(angle) * shift,
    z: storm.currentCenterZ + Math.sin(angle) * shift,
  };
}

function beginShrink(storm: StormState, config: StormPhaseConfig): void {
  storm.isShrinking = true;
  storm.shrinkFromCenterX = storm.currentCenterX;
  storm.shrinkFromCenterZ = storm.currentCenterZ;
  storm.shrinkFromRadius = storm.currentRadius;
  storm.shrinkElapsed = 0;
  storm.shrinkDuration = config.shrinkSeconds;
  storm.phaseTimer = config.shrinkSeconds;
}

function finishShrink(storm: StormState): void {
  storm.currentCenterX = storm.targetCenterX;
  storm.currentCenterZ = storm.targetCenterZ;
  storm.currentRadius = storm.targetRadius;
  storm.isShrinking = false;
  storm.shrinkElapsed = 0;
  storm.shrinkDuration = 0;
  storm.phase += 1;

  if (storm.phase > STORM_PHASES.length) {
    const final = getStormPhaseConfig(STORM_PHASES.length);
    storm.damagePerSecond = final.damagePerSecond;
    storm.phaseTimer = 0;
    storm.targetCenterX = storm.currentCenterX;
    storm.targetCenterZ = storm.currentCenterZ;
    storm.targetRadius = storm.currentRadius;
    return;
  }

  const next = getStormPhaseConfig(storm.phase);
  storm.damagePerSecond = next.damagePerSecond;
  storm.phaseTimer = next.waitSeconds;
  const target = chooseNextTargetCenter(storm, next);
  storm.targetCenterX = target.x;
  storm.targetCenterZ = target.z;
  storm.targetRadius = next.targetRadius;
}

/**
 * Advances a storm state with linear circle interpolation.
 *
 * Unlike the previous exponential approach (which still had distance left
 * when its timer expired and then snapped), current centre/radius are an
 * exact function of shrink elapsed time. Large offline timesteps can cross
 * a phase boundary without losing or gaining scheduled seconds.
 */
export function advanceStormState(storm: StormState, dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0 || isFinalStormPhase(storm)) {
    if (isFinalStormPhase(storm)) storm.phaseTimer = 0;
    return;
  }

  let remaining = dt;
  for (let guard = 0; remaining > 1e-9 && guard < 24; guard++) {
    const config = getStormPhaseConfig(storm.phase);

    if (!storm.isShrinking) {
      storm.damagePerSecond = config.damagePerSecond;
      if (remaining < storm.phaseTimer) {
        storm.phaseTimer -= remaining;
        remaining = 0;
      } else {
        remaining -= Math.max(0, storm.phaseTimer);
        beginShrink(storm, config);
      }
      continue;
    }

    if (!storm.shrinkDuration || storm.shrinkDuration <= 0) {
      // A server snapshot carries current/target/remaining time but not the
      // server's interpolation origin. If offline simulation takes over,
      // move linearly from the snapshot circle over the remaining time.
      storm.shrinkFromCenterX = storm.currentCenterX;
      storm.shrinkFromCenterZ = storm.currentCenterZ;
      storm.shrinkFromRadius = storm.currentRadius;
      storm.shrinkElapsed = 0;
      storm.shrinkDuration = Math.max(0.001, storm.phaseTimer || config.shrinkSeconds);
    }
    const duration = Math.max(
      0.001,
      Number(storm.shrinkDuration ?? config.shrinkSeconds) || config.shrinkSeconds
    );
    const fromX = Number(storm.shrinkFromCenterX ?? storm.currentCenterX);
    const fromZ = Number(storm.shrinkFromCenterZ ?? storm.currentCenterZ);
    const fromRadius = Number(storm.shrinkFromRadius ?? storm.currentRadius);
    const elapsedBefore = Math.min(
      duration,
      Math.max(0, Number(storm.shrinkElapsed ?? 0) || 0)
    );
    const step = Math.min(remaining, duration - elapsedBefore);
    const elapsed = elapsedBefore + step;
    const t = Math.max(0, Math.min(1, elapsed / duration));

    storm.currentCenterX = fromX + (storm.targetCenterX - fromX) * t;
    storm.currentCenterZ = fromZ + (storm.targetCenterZ - fromZ) * t;
    storm.currentRadius = fromRadius + (storm.targetRadius - fromRadius) * t;
    storm.shrinkElapsed = elapsed;
    storm.shrinkDuration = duration;
    storm.phaseTimer = Math.max(0, duration - elapsed);
    remaining -= step;

    if (elapsed >= duration - 1e-9) {
      finishShrink(storm);
      if (isFinalStormPhase(storm)) return;
    }
  }
}

export function getStormStatusLabel(storm: StormState): string {
  if (isFinalStormPhase(storm)) return 'FINAL ZONE';
  return storm.isShrinking ? 'SHRINKING' : 'SHRINKS IN';
}
