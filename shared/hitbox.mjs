/**
 * CI CRAFT — canonical player hitbox model.
 *
 * This module is the single source of truth for "what counts as a body" in
 * combat. The client uses it to decide what the crosshair is pointing at; the
 * authoritative server uses it to re-decide the same question. Sharing the file
 * is the whole point: if the two sides used different shapes, a player would see
 * a confirmed-looking hit that the server silently drops.
 *
 * Design rules (deliberate, do not "improve" without measuring):
 *
 *  - Volumes are stacked cylinders, not a triangle mesh. Cheap, stable, and
 *    immune to animation-driven wobble.
 *  - Each part's maxY equals the next part's minY. There are no gaps by
 *    construction, so a ray travelling up the body always has a home.
 *  - Radii are measured from the visible character meshes, not guessed:
 *      head   y 1.49-1.95, xy radius 0.17-0.20  -> 0.19
 *      torso  y 0.88-1.50, x +/-0.32            -> 0.34
 *      pelvis y 0.71-0.93, x +/-0.30            -> merged into legs
 *    The radii hug the art. A previous build used one 0.54 m cylinder for the
 *    whole body, which is 1.08 m wide on a 0.64 m torso: that registers hits on
 *    players the crosshair is clearly missing.
 *  - Y values are relative to the player's feet (`position.y`), which is also
 *    where the character mesh root sits.
 */

/** Ordered bottom-to-top so the union is contiguous. */
export const PLAYER_HITBOX_PARTS = Object.freeze([
  Object.freeze({
    part: 'legs',
    minY: 0.0,
    maxY: 0.88,
    radius: 0.26,
    headshot: false,
    damageScale: 1,
  }),
  Object.freeze({
    part: 'torso',
    minY: 0.88,
    maxY: 1.5,
    radius: 0.34,
    headshot: false,
    damageScale: 1,
  }),
  Object.freeze({
    part: 'head',
    minY: 1.5,
    maxY: 1.95,
    radius: 0.19,
    headshot: true,
    damageScale: 1,
  }),
]);

/** Top of the head volume. Anything above this is a clean miss. */
export const PLAYER_HITBOX_HEIGHT = 1.95;

/**
 * Extra radius the server grants a reported hit. Network position error and the
 * 20 Hz sync can put the authoritative body a few centimetres from where the
 * shooter saw it; without this, honest shots get rejected at long range. 10 cm
 * is roughly one animation frame of limb movement, so it absorbs timing jitter
 * without registering hits on empty air.
 */
export const SERVER_HIT_TOLERANCE = 0.1;

/**
 * Ray (unit or non-unit direction) against one vertical cylinder.
 * Returns distance along the ray, or -1.
 */
export function rayCylinderDistance(
  ox,
  oy,
  oz,
  dx,
  dy,
  dz,
  cx,
  cz,
  minY,
  maxY,
  radius,
  maxT
) {
  // Horizontal quadratic: |(o.xz + t*d.xz) - c|^2 = r^2
  const oxr = ox - cx;
  const ozr = oz - cz;
  const a = dx * dx + dz * dz;
  const EPS = 1e-9;

  let tEnter;
  let tExit;

  if (a < EPS) {
    // Ray is vertical: it is either inside the radius or it never is.
    if (oxr * oxr + ozr * ozr > radius * radius) return -1;
    tEnter = -Infinity;
    tExit = Infinity;
  } else {
    const b = 2 * (oxr * dx + ozr * dz);
    const c = oxr * oxr + ozr * ozr - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const root = Math.sqrt(disc);
    tEnter = (-b - root) / (2 * a);
    tExit = (-b + root) / (2 * a);
  }

  // Vertical slab.
  if (Math.abs(dy) < EPS) {
    if (oy < minY || oy > maxY) return -1;
  } else {
    let t1 = (minY - oy) / dy;
    let t2 = (maxY - oy) / dy;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tEnter) tEnter = t1;
    if (t2 < tExit) tExit = t2;
  }

  if (tEnter > tExit) return -1;
  if (tExit < 0) return -1;

  const t = tEnter > 0 ? tEnter : 0;
  if (t > maxT) return -1;
  return t;
}

/**
 * Nearest hitbox intersection for one player.
 *
 * @returns {{t:number, part:string, headshot:boolean, point:{x:number,y:number,z:number}}|null}
 */
export function raycastPlayer(
  ox,
  oy,
  oz,
  dx,
  dy,
  dz,
  px,
  py,
  pz,
  maxT,
  radiusBonus = 0
) {
  let best = -1;
  let bestPart = null;

  for (const box of PLAYER_HITBOX_PARTS) {
    const t = rayCylinderDistance(
      ox,
      oy,
      oz,
      dx,
      dy,
      dz,
      px,
      pz,
      py + box.minY,
      py + box.maxY,
      box.radius + radiusBonus,
      maxT
    );
    if (t >= 0 && (best < 0 || t < best)) {
      best = t;
      bestPart = box;
    }
  }

  if (!bestPart) return null;

  return {
    t: best,
    part: bestPart.part,
    headshot: bestPart.headshot,
    point: { x: ox + dx * best, y: oy + dy * best, z: oz + dz * best },
  };
}

/**
 * Nearest player hit along a ray, against a list of candidate positions.
 * `candidates` is any iterable of `{ id, position }`.
 *
 * @returns {{id:string, t:number, part:string, headshot:boolean, point:{x:number,y:number,z:number}}|null}
 */
export function raycastPlayers(
  ox,
  oy,
  oz,
  dx,
  dy,
  dz,
  candidates,
  maxT,
  radiusBonus = 0,
  excludeId = null
) {
  let best = null;
  for (const candidate of candidates) {
    if (!candidate || candidate.id === excludeId) continue;
    const position = candidate.position;
    if (!position) continue;
    if (![position.x, position.y, position.z].every(Number.isFinite)) continue;

    const hit = raycastPlayer(
      ox,
      oy,
      oz,
      dx,
      dy,
      dz,
      position.x,
      position.y,
      position.z,
      best ? Math.min(maxT, best.t) : maxT,
      radiusBonus
    );
    if (hit && (!best || hit.t < best.t)) {
      best = {
        id: candidate.id,
        t: hit.t,
        part: hit.part,
        headshot: hit.headshot,
        point: hit.point,
      };
    }
  }
  return best;
}

/**
 * True when a player's vertical extent can possibly intersect a ray at the given
 * horizontal position. Used as a cheap broad phase before the per-part test.
 */
export function playerCouldBeHit(ox, oy, oz, dx, dy, dz, px, py, pz, maxT) {
  // Slab test against the body's vertical AABB.
  const R = 0.4;
  let tMin = 0;
  let tMax = maxT;

  const slabs = [
    [px - R, px + R, ox, dx],
    [py + 0.0, py + PLAYER_HITBOX_HEIGHT, oy, dy],
    [pz - R, pz + R, oz, dz],
  ];

  for (const [lo, hi, o, d] of slabs) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return false;
    }
  }
  return tMax >= 0;
}
