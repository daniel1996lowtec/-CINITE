/**
 * CI CRAFT — server-side shot validation.
 *
 * Kept separate from `multiplayerServer.mjs` so the hit-resolution rules can be
 * unit tested without booting a socket server. The server imports exactly these
 * functions; nothing here mutates physics or match state.
 */
import { raycastPlayer, SERVER_HIT_TOLERANCE } from '../shared/hitbox.mjs';

/**
 * Bounded lag compensation window.
 *
 * The client renders remote players slightly in the past (20 Hz sync plus
 * interpolation). When it fires, it is aiming at what it could see. Validating
 * that shot against the server's *current* position rejects honest hits on
 * anything that is moving — which is exactly the "my crosshair was on him"
 * report. So a hit is accepted if the ray intersects the body at any sample
 * inside this window. Deliberately small: it absorbs latency without letting a
 * shooter hit where an opponent was half a second ago.
 */
export const MAX_LAG_COMPENSATION_MS = 200;
export const POSITION_HISTORY_MAX_SAMPLES = 16;
export const POSITION_HISTORY_TTL_MS = 900;

/** How far the muzzle may sit from the operator's body centre. */
// Generous enough to cover client-side movement prediction under poor latency
// (a sprinting operator plus RTT can put the predicted body ~3 m ahead of the
// authoritative one), yet 100x smaller than the map, so a client still cannot
// invent a firing position across the island.
export const MAX_FIRE_ORIGIN_OFFSET = 4.0;

export function recordPositionHistory(player, now = Date.now()) {
  if (!player || !player.position) return;
  if (!Array.isArray(player.positionHistory)) player.positionHistory = [];
  const history = player.positionHistory;
  const last = history[history.length - 1];
  const stationary =
    last &&
    Math.abs(last.x - player.position.x) < 0.02 &&
    Math.abs(last.y - player.position.y) < 0.02 &&
    Math.abs(last.z - player.position.z) < 0.02;

  if (stationary) {
    // A player standing still does not need a sample per sync. Slide the
    // existing sample forward instead of filling the ring with duplicates.
    if (now - last.t < 25) return;
    last.t = now;
    while (history.length > 1 && now - history[0].t > POSITION_HISTORY_TTL_MS) {
      history.shift();
    }
    return;
  }

  history.push({
    t: now,
    x: player.position.x,
    y: player.position.y,
    z: player.position.z,
  });
  while (history.length > POSITION_HISTORY_MAX_SAMPLES) history.shift();
  while (history.length > 1 && now - history[0].t > POSITION_HISTORY_TTL_MS) history.shift();
}

/**
 * Raycasts a shot against a victim's body at the current position and at every
 * recent snapshot inside the compensation window. The nearest intersection wins,
 * so the result is always a real point on a real body.
 */
export function raycastVictimLagCompensated(
  victim,
  origin,
  direction,
  maxT,
  now,
  radiusBonus = SERVER_HIT_TOLERANCE
) {
  if (!victim || !victim.position) return null;
  const samples = [{ x: victim.position.x, y: victim.position.y, z: victim.position.z }];
  const history = Array.isArray(victim.positionHistory) ? victim.positionHistory : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const snapshot = history[i];
    if (now - snapshot.t > MAX_LAG_COMPENSATION_MS) break;
    samples.push({ x: snapshot.x, y: snapshot.y, z: snapshot.z });
  }

  let best = null;
  for (const sample of samples) {
    const hit = raycastPlayer(
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      sample.x,
      sample.y,
      sample.z,
      best ? Math.min(maxT, best.t) : maxT,
      SERVER_HIT_TOLERANCE
    );
    if (hit && (!best || hit.t < best.t)) {
      best = { ...hit, baseY: sample.y };
    }
  }
  return best;
}

/**
 * A weapon muzzle lives on the operator, so a legal report is always near the
 * reported body position. This is not a direction check — the player may legally
 * fire anywhere the crosshair points, including behind them while running — it
 * only stops a client inventing a ray from somewhere else on the map.
 */
export function sanitizeFireOrigin(origin, player) {
  if (!origin || typeof origin !== 'object') return null;
  const { x, y, z } = origin;
  if (![x, y, z].every(Number.isFinite)) return null;
  const body = player.position;
  if (!body) return null;
  if (Math.hypot(x - body.x, z - body.z) > MAX_FIRE_ORIGIN_OFFSET) return null;
  if (y < body.y + 0.3 || y > body.y + 3.4) return null;
  return { x, y, z };
}

export function sanitizeDirection(direction) {
  if (!direction || typeof direction !== 'object') return null;
  const { x, y, z } = direction;
  if (![x, y, z].every(Number.isFinite)) return null;
  const length = Math.hypot(x, y, z);
  if (length < 0.5 || length > 1.5) return null;
  return { x: x / length, y: y / length, z: z / length };
}

/**
 * The horizontal radius a shot is allowed to land within.
 *
 * Multi-pellet weapons intentionally scatter, so validating every pellet against
 * the single "centre of the cone" ray would reject honest shotgun hits. The
 * allowance is derived from the *server's* catalogue spread and the distance, so
 * a client cannot inflate it; at worst a cheat can pick the best angle inside
 * the cone the weapon already has.
 */
export function spreadAllowanceRadius(spreadRadians, distanceToVictim) {
  const spread = Number(spreadRadians);
  const distance = Number(distanceToVictim);
  if (!Number.isFinite(spread) || !Number.isFinite(distance) || spread <= 0) {
    return SERVER_HIT_TOLERANCE;
  }
  return SERVER_HIT_TOLERANCE + Math.tan(spread) * Math.max(0, distance);
}
