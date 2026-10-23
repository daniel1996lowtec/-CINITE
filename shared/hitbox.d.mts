export interface HitboxPart {
  readonly part: string;
  readonly minY: number;
  readonly maxY: number;
  readonly radius: number;
  readonly headshot: boolean;
  readonly damageScale: number;
}

export interface HitboxPoint {
  x: number;
  y: number;
  z: number;
}

export interface RaycastPlayerHit {
  t: number;
  part: string;
  headshot: boolean;
  point: HitboxPoint;
}

export interface RaycastPlayersHit extends RaycastPlayerHit {
  id: string;
}

export interface HitboxPosition {
  x: number;
  y: number;
  z: number;
}

export interface HitboxCandidate {
  id: string;
  position?: HitboxPosition | null;
}

export const PLAYER_HITBOX_PARTS: readonly HitboxPart[];
export const PLAYER_HITBOX_HEIGHT: number;
export const SERVER_HIT_TOLERANCE: number;

export function rayCylinderDistance(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cz: number,
  minY: number,
  maxY: number,
  radius: number,
  maxT: number
): number;

export function raycastPlayer(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  px: number,
  py: number,
  pz: number,
  maxT: number,
  radiusBonus?: number
): RaycastPlayerHit | null;

export function raycastPlayers(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  candidates: Iterable<HitboxCandidate>,
  maxT: number,
  radiusBonus?: number,
  excludeId?: string | null
): RaycastPlayersHit | null;

export function playerCouldBeHit(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  px: number,
  py: number,
  pz: number,
  maxT: number
): boolean;
