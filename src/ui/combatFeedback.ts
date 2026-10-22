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
