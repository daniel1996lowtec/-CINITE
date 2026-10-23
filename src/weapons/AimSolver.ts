/**
 * CI CRAFT — third-person aim solver.
 *
 * The problem this file exists to solve:
 *
 *   In a third-person shooter the camera is not the gun. The camera sits behind
 *   and to the right of the operator, the muzzle sits in front of the chest, and
 *   the crosshair is simply the centre of the screen. If you fire along the
 *   camera's forward axis from the muzzle, the bullet lands parallel to the
 *   crosshair ray but *offset* from it, so a target that is perfectly centred
 *   gets missed — badly at close range, and at an angle that grows with distance.
 *
 * The fix is the standard one: use the camera ray only to find *what the player
 * is pointing at*, then fire from the actual muzzle *towards that point*. The
 * crosshair and the trajectory converge on the same world position.
 *
 * Everything here is pure math on plain `{x,y,z}` objects: no Three.js, no
 * scene, no allocations hidden behind a vector library. That keeps it cheap and,
 * more importantly, makes it testable without a browser.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface WorldCastHit {
  distance: number;
  point: Vec3;
}

export interface TargetCastHit {
  targetId: string;
  distance: number;
  point: Vec3;
}

export interface AimInput {
  /** True camera position (the rendered one). */
  cameraOrigin: Vec3;
  /** True camera forward, i.e. the direction through the crosshair. */
  cameraDirection: Vec3;
  /** Actual weapon muzzle in world space. */
  muzzle: Vec3;
  /** Weapon maximum range in metres. */
  range: number;
  /** Nearest static-geometry hit along an arbitrary ray. */
  castWorld: (origin: Vec3, direction: Vec3, maxDistance: number) => WorldCastHit | null;
  /** Nearest character hitbox along an arbitrary ray, excluding the shooter. */
  castTargets: (origin: Vec3, direction: Vec3, maxDistance: number) => TargetCastHit | null;
}

export interface AimSolution {
  cameraOrigin: Vec3;
  cameraDirection: Vec3;
  /** World point the crosshair is looking at. */
  aimPoint: Vec3;
  /** Distance from the camera to `aimPoint`. */
  aimDistance: number;
  /** True when static geometry stopped the camera ray before max range. */
  cameraBlocked: boolean;
  /** Muzzle position, echoed for the firing code. */
  fireOrigin: Vec3;
  /** Normalised muzzle -> aimPoint direction. */
  fireDirection: Vec3;
  /** Enemy under the crosshair, if any. */
  crosshairTargetId: string | null;
  /** Enemy the muzzle actually reaches. Null when blocked or aiming at nothing. */
  predictedTargetId: string | null;
  predictedPoint: Vec3 | null;
  /**
   * True when the muzzle cannot see the aim point (a wall, a crate, the edge of
   * cover). The crosshair must not promise a hit in this state.
   */
  muzzleObstructed: boolean;
}

const EPSILON = 1e-6;

export function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z);
  if (length < EPSILON) return { x: 0, y: 0, z: -1 };
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function addScaled(a: Vec3, b: Vec3, scale: number): Vec3 {
  return { x: a.x + b.x * scale, y: a.y + b.y * scale, z: a.z + b.z * scale };
}

/**
 * Resolves one trigger pull into a camera ray (what the player sees) and a
 * muzzle ray (what the weapon actually does).
 */
export function resolveAim(input: AimInput): AimSolution {
  const cameraDirection = normalize(input.cameraDirection);
  const range = Math.max(0.1, input.range);

  const worldHit = input.castWorld(input.cameraOrigin, cameraDirection, range);
  const cameraBlocked = worldHit !== null && worldHit.distance <= range;
  const cameraLimit = cameraBlocked ? worldHit.distance : range;

  // What the crosshair is on. Never past a wall.
  const crosshair = input.castTargets(input.cameraOrigin, cameraDirection, cameraLimit);

  let aimPoint: Vec3;
  let aimDistance: number;
  if (crosshair) {
    aimPoint = crosshair.point;
    aimDistance = crosshair.distance;
  } else if (worldHit) {
    aimPoint = worldHit.point;
    aimDistance = worldHit.distance;
  } else {
    aimPoint = addScaled(input.cameraOrigin, cameraDirection, range);
    aimDistance = range;
  }

  // Muzzle -> aim point. This is the direction the bullet really travels.
  const toAim = sub(aimPoint, input.muzzle);
  const muzzleDistance = Math.hypot(toAim.x, toAim.y, toAim.z);

  let fireDirection: Vec3;
  if (muzzleDistance < 0.05) {
    // Standing inside the target/geometry: fall back to the view axis.
    fireDirection = cameraDirection;
  } else {
    fireDirection = { x: toAim.x / muzzleDistance, y: toAim.y / muzzleDistance, z: toAim.z / muzzleDistance };
    // A target behind the muzzle is not shootable by pointing at it.
    if (dot(fireDirection, cameraDirection) < 0) fireDirection = cameraDirection;
  }

  // Can the muzzle actually see the aim point, or is cover in the way?
  const obstructionSample = Math.max(0.05, muzzleDistance - 0.02);
  const muzzleHit = input.castWorld(input.muzzle, fireDirection, obstructionSample);
  const muzzleObstructed = muzzleHit !== null;

  // What the muzzle will really hit. Slight extra length so a ray that lands
  // exactly on the target surface still registers the body behind it.
  let predictedTargetId: string | null = null;
  let predictedPoint: Vec3 | null = null;
  if (!muzzleObstructed) {
    const predicted = input.castTargets(
      input.muzzle,
      fireDirection,
      Math.min(range, muzzleDistance + 0.35)
    );
    if (predicted) {
      predictedTargetId = predicted.targetId;
      predictedPoint = predicted.point;
    }
  }

  return {
    cameraOrigin: input.cameraOrigin,
    cameraDirection,
    aimPoint,
    aimDistance,
    cameraBlocked,
    fireOrigin: input.muzzle,
    fireDirection,
    crosshairTargetId: crosshair ? crosshair.targetId : null,
    predictedTargetId,
    predictedPoint,
    muzzleObstructed,
  };
}

/**
 * Builds an orthonormal basis around `direction` without a branch on the axis
 * test that usually introduces a discontinuity near the poles.
 */
export function orthonormalBasis(direction: Vec3): { u: Vec3; v: Vec3 } {
  const d = normalize(direction);
  // Pick the world axis least aligned with `d` to avoid a degenerate cross.
  const absX = Math.abs(d.x);
  const absY = Math.abs(d.y);
  const absZ = Math.abs(d.z);
  const helper: Vec3 =
    absX <= absY && absX <= absZ
      ? { x: 1, y: 0, z: 0 }
      : absY <= absZ
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };

  const u = normalize({
    x: d.y * helper.z - d.z * helper.y,
    y: d.z * helper.x - d.x * helper.z,
    z: d.x * helper.y - d.y * helper.x,
  });
  const v = {
    x: d.y * u.z - d.z * u.y,
    y: d.z * u.x - d.x * u.z,
    z: d.x * u.y - d.y * u.x,
  };
  return { u, v };
}

/**
 * Applies a circular cone of `angle` radians around `direction`.
 *
 * The previous implementation added independent random offsets to the x, y and
 * z components of the direction vector. That is not a cone: the result is biased
 * towards the world axes and changes shape as the player turns, so the same
 * weapon felt tighter when facing north than when facing east.
 *
 * `radius01` and `theta01` are supplied by the caller so the distribution is
 * explicit and testable. Sampling `sqrt(radius01)` gives a uniform disc; sampling
 * linearly would cluster pellets in the centre.
 */
export function spreadDirection(
  direction: Vec3,
  angleRadians: number,
  radius01: number,
  theta01: number
): Vec3 {
  if (!(angleRadians > 0)) return normalize(direction);

  const { u, v } = orthonormalBasis(direction);
  const radius = Math.sqrt(Math.min(1, Math.max(0, radius01))) * Math.tan(angleRadians);
  const theta = theta01 * Math.PI * 2;
  const offsetX = Math.cos(theta) * radius;
  const offsetY = Math.sin(theta) * radius;

  return normalize({
    x: direction.x + u.x * offsetX + v.x * offsetY,
    y: direction.y + u.y * offsetX + v.y * offsetY,
    z: direction.z + u.z * offsetX + v.z * offsetY,
  });
}

/**
 * Small deterministic PRNG so spread can be replayed in tests without stubbing
 * `Math.random`. Not used for anything security-sensitive.
 */
export function createSpreadRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
