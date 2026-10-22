/** Screen-relative bearing for a server-confirmed hit, never a hit decision. */
export function relativeThreatAngle(
  player: {x: number; z: number},
  source: {x: number; z: number},
  yaw: number
): number {
  const bearing = Math.atan2(player.x-source.x, player.z-source.z);
  const angle = yaw-bearing;
  return Math.atan2(Math.sin(angle),Math.cos(angle));
}

export type ConfirmedHitKind = 'health' | 'shield' | 'shield-break' | 'headshot' | 'elim';
/** Called only after a resolved local hit or an accepted/deduplicated server event. */
export function confirmedHitKind(headshot: boolean, shield: boolean, broken: boolean, eliminated: boolean): ConfirmedHitKind {
  return eliminated ? 'elim' : broken ? 'shield-break' : headshot ? 'headshot' : shield ? 'shield' : 'health';
}

/** Bounded spatial presentation gain, not audibility/visibility used by gameplay. */
export function combatFeedbackGain(distance: number, radius = 96): number {
  if (!Number.isFinite(distance) || !Number.isFinite(radius) || radius <= 0) return 0;
  const t = Math.max(0, 1 - Math.max(0, distance) / radius);
  return t * t;
}

/** Event-edge detector. The first snapshot after construction/reset establishes a silent baseline. */
export class StormNoticeTracker {
  private phase = 0;
  private shrinking = false;
  private outside = false;
  public reset(): void { this.phase = 0; }
  public update(phase: number, shrinking: boolean, outside: boolean): string | null {
    let notice: string | null = null;
    if (this.phase !== 0) {
      if (outside !== this.outside) notice = outside ? 'OUTSIDE' : 'SAFE AGAIN';
      else if (phase !== this.phase) notice = phase > 8 ? 'FINAL HOLD' : 'NEW ZONE';
      else if (shrinking && !this.shrinking) notice = 'CLOSING';
    }
    this.phase = phase; this.shrinking = shrinking; this.outside = outside;
    return notice;
  }
}

export function safeZoneBearing(x: number, z: number, targetX: number, targetZ: number): string {
  // World north is -Z, matching the minimap/compass, not the player's facing.
  const direction = Math.atan2(targetX - x, z - targetZ);
  return CARDINALS[(Math.round(direction / (Math.PI / 4)) + 8) % 8];
}
const CARDINALS = ['N','NE','E','SE','S','SW','W','NW'] as const;
export function countdownLabel(seconds: number): string {
  return seconds > 0 ? String(Math.ceil(seconds)) : 'DROP!';
}
