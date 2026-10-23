/**
 * CI CRAFT 9.0 — road network.
 *
 * Replaces the 8.2/8.3 carriageway builder. That implementation was a single
 * flat quad strip: two vertices per cross-section (left edge, right edge) with a
 * straight line between them. A carriageway is 7.5–8.1 m wide and the terrain
 * lattice is 2.60 m, so the drawn surface bulges through the middle of the road
 * in ~15 % of cross-sections and by up to a metre. That is why roads read as
 * detached slabs and misplaced fragments: the asphalt was being torn by the
 * ground underneath it.
 *
 * This builder fixes that structurally rather than by tuning constants:
 *
 *   - The surface CONFORMS across its full width. Every cross-section samples
 *     the rendered terrain at ~10 lateral positions, so the asphalt follows the
 *     ground it lies on instead of cutting a chord across it.
 *   - Water is handled explicitly per segment. The old code applied
 *     `Math.max(ground + lift, WATER_Y + 0.95)` to EVERY vertex on the map, so
 *     any road on ground below 0.635 m was silently lifted, and the raised deck
 *     then tripped the parapet heuristic and grew bridge furniture for 126 m
 *     along a 46 m lake. Here a segment is only treated as a span where its own
 *     ground profile actually drops below the water surface.
 *   - Width comes from one source of truth, shared with the kerbs, so the kerb
 *     line cannot drift away from the asphalt edge.
 *   - Bridge decks register a `WalkableSurface`, so a player crossing Mirror
 *     Lake walks on the deck instead of on the lakebed two metres below it.
 *
 * Everything is deterministic: no Math.random, no Date, no iteration-order
 * dependence. The same world always produces byte-identical geometry.
 */
import * as THREE from 'three';
import type { RoadSegmentDefinition } from './WorldLayout';

/* --------------------------------- tuning -------------------------------- */

/**
 * Carriageway half-width by segment kind. This is the single source of truth:
 * TerrainGenerator paints the asphalt from the same value and MapExpansionBuilder
 * places kerbs from it, so mesh, paint and kerbs stay on the same line.
 */
export const ROAD_HALF_WIDTH: Record<RoadSegmentDefinition['kind'], number> = {
  primary: 4.05,
  secondary: 3.75,
};

/**
 * CI CRAFT recovery switch — is the road system supposed to build?
 *
 * `?roads=1` builds the 9.0 road system, `?roads=0` suppresses the whole thing:
 * no carriageway mesh, no bridge structures, no deck walkables, and no road
 * sub-base painted into the terrain. Everything reads one flag, so the world can
 * never end up half-roaded.
 *
 * The browser default is OFF while the world is recovered. The 9.0 road system
 * is the only thing in the scene that changed between 8.7 and 9.0 — every other
 * mesh, including terrain, buildings and props, is byte-identical — so turning
 * it off restores the 8.1 world (which contained no road geometry at all) and
 * proves in one page load whether the road surface is the problem.
 *
 * Headless runs (tests, audits, the offline renderer) keep roads ON, so the 9.0
 * regression tests keep exercising the new system and it stays maintained.
 */
const ROADS_DEFAULT_IN_BROWSER = false;

export function roadSurfaceRequested(search?: string): boolean {
  const query = search ?? (typeof window === 'undefined' ? null : window.location.search);
  // No page context at all: tests, audits and offline renders.
  if (query === null) return true;
  const flag = new URLSearchParams(query).get('roads');
  if (flag === '1') return true;
  if (flag === '0') return false;
  return ROADS_DEFAULT_IN_BROWSER;
}

export function roadHalfWidth(kind: RoadSegmentDefinition['kind']): number {
  return ROAD_HALF_WIDTH[kind] ?? ROAD_HALF_WIDTH.secondary;
}

/** Vertical offset above the drawn terrain. Small enough to read as flush. */
const ROAD_LIFT = 0.045;
/** Distance between cross-sections along a segment. Below the 2.60 m lattice. */
const SAMPLE_ALONG = 2.0;
/**
 * Lateral sample offsets as a fraction of half-width.
 *
 * Density is not cosmetic. The terrain is a 2.60 m lattice and the carriageway
 * is 7.5–8.1 m wide, so on a cross-slope a coarse set of lateral samples cuts
 * the corners off the terrain's own triangulation and the ground clips through
 * the asphalt between samples. At ~0.53 m spacing the residual is under 0.1 m
 * even on a 21 % cross-slope; at 1.1 m spacing it reached 0.54 m.
 *
 * Indices 8 and 9 are the centre-line pair (±0.10 m at a 4.05 m half-width);
 * they are the vertices the dashed marking paints.
 */
const LANE_OFFSETS_FRACTION = [
  -1, -0.87, -0.74, -0.61, -0.48, -0.35, -0.22, -0.09,
  -0.0247, 0.0247,
  0.09, 0.22, 0.35, 0.48, 0.61, 0.74, 0.87, 1,
];
const MARKING_INDEX_A = 8;
const MARKING_INDEX_B = 9;
/** Deck height above the water surface for a genuine water crossing. */
/** Widest a dropped width sample may deviate from the line that replaces it, in metres. */
const SIDE_TOLERANCE = 0.035;
/** Same, along the road. */
const ALONG_TOLERANCE = 0.035;
const DECK_CLEARANCE = 0.95;
/** Shortest genuinely wet stretch that justifies a bridge deck, in metres. */
const MIN_DECK_SPAN = 2;
/** Junction disc polygon resolution. */
const DISC_SEGMENTS = 24;
const DISC_RINGS = 4;
/** Dashed centre line: 4 m painted, 4 m gap. */
const DASH_PERIOD = 8;
const DASH_PAINTED = 4;

/* --------------------------------- colours -------------------------------- */

const ASPHALT: readonly [number, number, number] = [0.152, 0.164, 0.183];
const ASPHALT_EDGE: readonly [number, number, number] = [0.232, 0.223, 0.196];
const MARKING: readonly [number, number, number] = [0.80, 0.78, 0.71];

/** Deterministic 0..1 hash. Used for subtle surface variation, never for layout. */
function hash01(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/* ---------------------------------- types --------------------------------- */

export interface RoadTerrainSampler {
  getRenderedTerrainHeight(x: number, z: number): number;
}

export interface RoadWalkable {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  getHeight: (x: number, z: number) => number;
}

export interface RoadNetworkStats {
  segments: number;
  nodes: number;
  triangles: number;
  vertices: number;
  /** Segments whose own ground profile dips below the water surface. */
  waterCrossings: number;
  /** Total length of genuine span, in metres. */
  spanLength: number;
  longestEdge: number;
}

export interface RoadNetwork {
  surface: THREE.Mesh;
  structures: THREE.Mesh | null;
  walkables: RoadWalkable[];
  stats: RoadNetworkStats;
}

interface DeckSpan {
  /** Along-segment index range the deck curve covers. */
  startIdx: number;
  endIdx: number;
  /** True wet indices, used only to place parapets and piers. */
  wetLo: number;
  wetHi: number;
  startAlong: number;
  endAlong: number;
  /** Deck height at each end, equal to the bank height there. */
  startY: number;
  endY: number;
  /** Minimum deck height: water surface plus clearance. */
  floorY: number;
}

/* -------------------------------- builder --------------------------------- */

/**
 * Builds the whole road network as two merged meshes:
 *   - `surface`: asphalt, junction discs and lane markings, one draw call
 *   - `structures`: parapets and piers for genuine spans, one draw call
 *
 * Kept as a standalone function so tests can build the network against a
 * synthetic sampler without instantiating the game.
 */
export function buildRoadNetwork(
  segments: readonly RoadSegmentDefinition[],
  terrain: RoadTerrainSampler,
  waterY: number
): RoadNetwork {
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const sPositions: number[] = [];
  const sColors: number[] = [];
  const sIndices: number[] = [];

  const walkables: RoadWalkable[] = [];
  let waterCrossings = 0;
  let spanLength = 0;

  const deckY = waterY + DECK_CLEARANCE;
  const alongSample = (x: number, z: number) =>
    Math.max(terrain.getRenderedTerrainHeight(x, z) + ROAD_LIFT, Number.NEGATIVE_INFINITY);

  /* ---- nodes: every unique segment endpoint ----------------------------- */

  const nodes = new Map<string, { x: number; z: number; radius: number }>();
  const noteNode = (x: number, z: number, radius: number): void => {
    const key = `${x.toFixed(3)}|${z.toFixed(3)}`;
    const existing = nodes.get(key);
    if (existing) existing.radius = Math.max(existing.radius, radius);
    else nodes.set(key, { x, z, radius });
  };
  for (const segment of segments) {
    noteNode(segment.fromX, segment.fromZ, roadHalfWidth(segment.kind));
    noteNode(segment.toX, segment.toZ, roadHalfWidth(segment.kind));
  }
  const nodeAt = (x: number, z: number): { x: number; z: number; radius: number } | undefined =>
    nodes.get(`${x.toFixed(3)}|${z.toFixed(3)}`);

  /* ---- per-segment ribbons ---------------------------------------------- */

  for (const segment of segments) {
    const dx = segment.toX - segment.fromX;
    const dz = segment.toZ - segment.fromZ;
    const length = Math.hypot(dx, dz);
    if (length < 2) continue;

    const dirX = dx / length;
    const dirZ = dz / length;
    const perpX = -dirZ;
    const perpZ = dirX;
    const halfWidth = roadHalfWidth(segment.kind);

    // Each end stops at its node's radius so the junction disc owns the middle.
    const trimStart = Math.min(nodeAt(segment.fromX, segment.fromZ)?.radius ?? halfWidth, length * 0.4);
    const trimEnd = Math.min(nodeAt(segment.toX, segment.toZ)?.radius ?? halfWidth, length * 0.4);
    const usable = length - trimStart - trimEnd;
    if (usable <= 1) continue;

    const steps = Math.max(2, Math.ceil(usable / SAMPLE_ALONG));
    const step = usable / steps;

    const fullLateral: number[] = LANE_OFFSETS_FRACTION.map((f) => f * halfWidth);

    // Ground profile on the centreline AND across the full width. A segment can
    // run along a shore with only one edge over water, so the centreline alone
    // is not enough to decide whether a span is needed.
    const centreGround: number[] = [];
    const minLateral: number[] = [];
    const widthProfile: number[][] = [];
    for (let i = 0; i <= steps; i++) {
      const along = trimStart + step * i;
      const cx = segment.fromX + dirX * along;
      const cz = segment.fromZ + dirZ * along;
      centreGround.push(terrain.getRenderedTerrainHeight(cx, cz));
      const row: number[] = [];
      for (const offset of fullLateral) {
        row.push(terrain.getRenderedTerrainHeight(cx + perpX * offset, cz + perpZ * offset));
      }
      widthProfile.push(row);
      minLateral.push(Math.min(...row));
    }

    // Adaptive width. Eighteen samples across are only needed where the ground
    // is genuinely cross-sloped; on a flat carriageway most of them describe the
    // same plane and cost triangles for nothing. Drop a sample only while the
    // ground it would have described is still within SIDE_TOLERANCE of the
    // straight line that replaces it, so this refines rather than coarsens.
    const isMarkingOffset = (k: number): boolean =>
      k === MARKING_INDEX_A || k === MARKING_INDEX_B;
    const keep: boolean[] = fullLateral.map(() => true);
    for (;;) {
      let bestK = -1;
      let bestErr = Infinity;
      for (let k = 1; k < fullLateral.length - 1; k++) {
        if (!keep[k] || isMarkingOffset(k)) continue;
        let prev = k - 1;
        while (prev >= 0 && !keep[prev]) prev--;
        let next = k + 1;
        while (next < fullLateral.length && !keep[next]) next++;
        if (prev < 0 || next >= fullLateral.length) continue;
        const f = (fullLateral[k] - fullLateral[prev]) / (fullLateral[next] - fullLateral[prev]);
        let err = 0;
        for (let i = 0; i < widthProfile.length; i++) {
          const row = widthProfile[i];
          const lerped = row[prev] + (row[next] - row[prev]) * f;
          err = Math.max(err, Math.abs(row[k] - lerped));
          if (err > bestErr) break;
        }
        if (err < bestErr) { bestErr = err; bestK = k; }
      }
      if (bestK < 0 || bestErr > SIDE_TOLERANCE) break;
      keep[bestK] = false;
    }

    const lateral: number[] = [];
    const lateralIsMarking: boolean[] = [];
    for (let k = 0; k < fullLateral.length; k++) {
      if (!keep[k]) continue;
      lateral.push(fullLateral[k]);
      lateralIsMarking.push(isMarkingOffset(k));
    }
    const across = lateral.length;

    // A span exists only where part of THIS road is under water.
    let wetLo = -1;
    let wetHi = -1;
    for (let i = 0; i <= steps; i++) {
      if (minLateral[i] < waterY) {
        if (wetLo < 0) wetLo = i;
        wetHi = i;
      }
    }

    let deck: DeckSpan | null = null;
    // A dip of a metre or two is a puddle, not a crossing. Raising a deck over
    // it would add parapets and piers to a road that never leaves the ground.
    const wetLength = wetLo < 0 ? 0 : (wetHi - wetLo + 1) * step;
    if (wetLo >= 0) waterCrossings++;
    if (wetLo >= 0 && wetLength >= MIN_DECK_SPAN) {
      const floorY = waterY + DECK_CLEARANCE;
      // Walk out to genuinely solid ground: the first index whose ENTIRE width
      // is at or above deck height. Ending the curve on ground that is merely
      // "not wet" but still below the deck leaves a step for the surface to
      // chord across, and the bank clips up through the asphalt at the
      // abutment. Two junction nodes on the Mirror Lake shore are exactly that
      // case.
      let startIdx = wetLo;
      while (startIdx > 0 && minLateral[startIdx] < floorY) startIdx--;
      let endIdx = wetHi;
      while (endIdx < steps && minLateral[endIdx] < floorY) endIdx++;
      // Vertical curve from bank to bank. The deck meets each bank at that
      // bank's own height and is floored at the clearance height, so there is no
      // step at the abutment for the surface to chord across. A hard step there
      // is what let the bank clip up through the asphalt.
      deck = {
        startIdx,
        endIdx,
        wetLo,
        wetHi,
        startAlong: trimStart + step * startIdx,
        endAlong: trimStart + step * endIdx,
        startY: Math.max(centreGround[startIdx] + ROAD_LIFT, floorY),
        endY: Math.max(centreGround[endIdx] + ROAD_LIFT, floorY),
        floorY,
      };
      spanLength += wetLength;
    }

    const deckAt = (i: number): number => {
      if (!deck || i < deck.startIdx || i > deck.endIdx) return Number.NEGATIVE_INFINITY;
      const span = deck.endIdx - deck.startIdx;
      const t = span === 0 ? 0.5 : (i - deck.startIdx) / span;
      const ramp = Math.max(deck.floorY, deck.startY + (deck.endY - deck.startY) * t);
      // The ramp is an upper bound, not a height in its own right. A straight
      // line between two banks cuts over every rise in between: on the Mirror
      // Lake causeway it floated up to 11 m of road more than half a metre
      // above dry shore. Clamping to the ground means the deck only lifts the
      // surface where the ground is genuinely below it, i.e. over water.
      const groundY = Math.max(centreGround[i] + ROAD_LIFT, waterY + ROAD_LIFT);
      return Math.min(ramp, Math.max(groundY, deck.floorY));
    };

    // Adaptive length, the same idea as the width: a straight stretch of road
    // over a planar slope needs two rows, not forty. A row is kept if any part
    // of it strays more than ALONG_TOLERANCE from the line joining the rows
    // that survive on either side of it.
    const rowHeight = (i: number): number[] => {
      const along = trimStart + step * i;
      const cx = segment.fromX + dirX * along;
      const cz = segment.fromZ + dirZ * along;
      const floorY = deckAt(i);
      return lateral.map((offset) =>
        Math.max(
          terrain.getRenderedTerrainHeight(cx + perpX * offset, cz + perpZ * offset) + ROAD_LIFT,
          floorY,
          waterY + ROAD_LIFT
        )
      );
    };
    const heights: number[][] = [];
    for (let i = 0; i <= steps; i++) heights.push(rowHeight(i));

    const rowMustKeep = (i: number): boolean => {
      if (i === 0 || i === steps) return true;
      const onDeck = Number.isFinite(deckAt(i));
      const before = Number.isFinite(deckAt(i - 1));
      const after = Number.isFinite(deckAt(i + 1));
      if (onDeck !== before || onDeck !== after) return true;
      const mark = (trimStart + step * i) % DASH_PERIOD < DASH_PAINTED;
      const markBefore = (trimStart + step * (i - 1)) % DASH_PERIOD < DASH_PAINTED;
      const markAfter = (trimStart + step * (i + 1)) % DASH_PERIOD < DASH_PAINTED;
      return mark !== markBefore || mark !== markAfter;
    };

    const rowError = (from: number, to: number): number => {
      let err = 0;
      for (let i = from + 1; i < to; i++) {
        const t = (i - from) / (to - from);
        for (let j = 0; j < lateral.length; j++) {
          const lerped = heights[from][j] + (heights[to][j] - heights[from][j]) * t;
          err = Math.max(err, Math.abs(heights[i][j] - lerped));
          if (err > ALONG_TOLERANCE) return err;
        }
      }
      return err;
    };

    const kept: number[] = [0];
    let last = 0;
    while (last < steps) {
      let next = steps;
      while (next > last + 1 && rowError(last, next) > ALONG_TOLERANCE) next--;
      if (next <= last) next = last + 1;
      kept.push(next);
      last = next;
    }
    for (let i = 1; i < steps; i++) {
      if (!kept.includes(i) && rowMustKeep(i)) kept.push(i);
    }
    kept.sort((a, b) => a - b);

    const base = positions.length / 3;
    for (const i of kept) {
      const along = trimStart + step * i;
      const cx = segment.fromX + dirX * along;
      const cz = segment.fromZ + dirZ * along;
      const floorY = deckAt(i);
      const onDeck = Number.isFinite(floorY);
      const centreMark = !onDeck && along % DASH_PERIOD < DASH_PAINTED;

      for (let j = 0; j < across; j++) {
        const offset = lateral[j];
        const px = cx + perpX * offset;
        const pz = cz + perpZ * offset;
        // Max of: the conforming ground, the deck curve, and the water surface.
        // The water floor is the 4.5 cm lift, not the old 95 cm deck height, so
        // a road on low ground still follows that ground.
        // Same expression the decimation measured, so what is drawn is exactly
        // what was checked against the ground.
        const y = heights[i][j];

        positions.push(px, y, pz);
        uvs.push(0.5 + offset / (2 * halfWidth), along / 4);

        const isMarking = centreMark && lateralIsMarking[j];
        const edgeDistance = (halfWidth - Math.abs(offset)) / halfWidth;
        let colour: readonly [number, number, number];
        if (isMarking) {
          colour = MARKING;
        } else if (edgeDistance < 0.08) {
          colour = ASPHALT_EDGE;
        } else {
          // CI CRAFT 9.1 — two-scale wear instead of one.
          //
          // A single high-frequency jitter reads as noise rather than asphalt.
          // Adding a slow ~9 m patch layer on top of it gives resurfaced
          // patches and older, darker stretches, which is what actually sells a
          // road at eye level. Pure vertex-colour variation: no extra draw
          // call, no texture, no geometry change, and deterministic so the road
          // looks identical on every client and in every screenshot.
          const fine = (hash01(px * 0.7, pz * 0.7) - 0.5) * 0.075;
          const patch =
            (hash01(Math.floor(px / 9) * 3.1, Math.floor(pz / 9) * 3.1) - 0.5) * 0.05;
          const n = fine + patch;
          colour = [ASPHALT[0] + n, ASPHALT[1] + n, ASPHALT[2] + n];
        }
        colors.push(colour[0], colour[1], colour[2]);
      }
    }

    // Winding: (a, a+1, b) and (a+1, b+1, b) give a +Y geometric normal for a
    // lattice whose rows advance along the segment and whose columns advance
    // across the perpendicular. Verified by the 9.0 winding test.
    for (let r = 0; r < kept.length - 1; r++) {
      for (let j = 0; j < across - 1; j++) {
        const a = base + r * across + j;
        const b = a + across;
        indices.push(a, a + 1, b);
        indices.push(a + 1, b + 1, b);
      }
    }

    /* ---- bridge structures: only over the true wet span ------------------ */

    if (deck) {
      const yaw = Math.atan2(dirX, dirZ);
      let lastPierAlong = -Infinity;
      for (let i = deck.wetLo; i <= deck.wetHi; i++) {
        const along = trimStart + step * i;
        const cx = segment.fromX + dirX * along;
        const cz = segment.fromZ + dirZ * along;
        const surfaceY = deckAt(i);

        for (const side of [-1, 1] as const) {
          pushBox(
            cx + perpX * (halfWidth + 0.14) * side,
            surfaceY + 0.45,
            cz + perpZ * (halfWidth + 0.14) * side,
            0.24,
            0.9,
            step * 1.06,
            yaw,
            0.62
          );
        }
        // Piers every ~8 m, from the bed to the deck.
        if (along - lastPierAlong >= 8) {
          const bed = terrain.getRenderedTerrainHeight(cx, cz);
          const height = Math.max(0.6, surfaceY - bed);
          pushBox(cx, surfaceY - height / 2 - 0.1, cz, 1.8, height, 1.3, yaw, 0.5);
          lastPierAlong = along;
        }
      }

      /* ---- deck is walkable, so players cross on it, not under it ------- */

      const span = deck.endAlong - deck.startAlong;
      const deckStartY = deck.startY;
      const deckEndY = deck.endY;
      const deckFloorY = deck.floorY;
      const sx = segment.fromX + dirX * deck.startAlong;
      const sz = segment.fromZ + dirZ * deck.startAlong;
      const ex = segment.fromX + dirX * deck.endAlong;
      const ez = segment.fromZ + dirZ * deck.endAlong;
      const pad = halfWidth + 0.6;
      const widthX = Math.abs(perpX) * pad;
      const widthZ = Math.abs(perpZ) * pad;
      const ax = segment.fromX;
      const az = segment.fromZ;
      const hx = halfWidth + 0.35;
      const yawCos = dirX;
      const yawSin = dirZ;
      const startAlong = deck.startAlong;
      const endAlong = deck.endAlong;

      walkables.push({
        id: `road_deck_${segment.id}`,
        minX: Math.min(sx, ex) - widthX,
        maxX: Math.max(sx, ex) + widthX,
        minZ: Math.min(sz, ez) - widthZ,
        maxZ: Math.max(sz, ez) + widthZ,
        // Only the deck itself is a support plane. Off-ribbon points get a value
        // far below any walkable height, so the AABB corners cannot lift a
        // swimmer near the bridge onto the deck.
        getHeight: (x: number, z: number) => {
          const vx = x - ax;
          const vz = z - az;
          const along = vx * yawCos + vz * yawSin;
          const perp = Math.abs(vx * -yawSin + vz * yawCos);
          if (along < startAlong - 0.5 || along > endAlong + 0.5 || perp > hx) return -1e6;
          const t = span <= 0 ? 0.5 : Math.max(0, Math.min(1, (along - startAlong) / span));
          const ramp = Math.max(deckFloorY, deckStartY + (deckEndY - deckStartY) * t);
          const groundHere = terrain.getRenderedTerrainHeight(x, z) + ROAD_LIFT;
          const surfaceY = Math.min(ramp, Math.max(groundHere, deckFloorY));
          // Only a support where the road genuinely spans a void. Where the
          // ground is already at road level the terrain is the floor and the
          // deck must stay out of the way; otherwise a raised deck lifts
          // everything beneath it, including the ground under the abutments and
          // the loot chest legitimately sitting there.
          if (terrain.getRenderedTerrainHeight(x, z) + 0.3 >= surfaceY) return -1e6;
          return surfaceY;
        },
      });
    }
  }

  /* ---- junction discs --------------------------------------------------- */

  for (const node of nodes.values()) {
    const radius = node.radius + 0.05;
    const centre = pushDiscVertex(node.x, node.z, 1);
    const rings: number[][] = [];
    for (let r = 1; r <= DISC_RINGS; r++) {
      const ringRadius = (radius * r) / DISC_RINGS;
      const ring: number[] = [];
      for (let i = 0; i < DISC_SEGMENTS; i++) {
        const angle = (i / DISC_SEGMENTS) * Math.PI * 2;
        const px = node.x + Math.cos(angle) * ringRadius;
        const pz = node.z + Math.sin(angle) * ringRadius;
        ring.push(pushDiscVertex(px, pz, 1));
      }
      rings.push(ring);
    }
    // Innermost fan.
    for (let i = 0; i < DISC_SEGMENTS; i++) {
      indices.push(centre, rings[0][(i + 1) % DISC_SEGMENTS], rings[0][i]);
    }
    // Annulus between successive rings.
    for (let r = 1; r < DISC_RINGS; r++) {
      const inner = rings[r - 1];
      const outer = rings[r];
      for (let i = 0; i < DISC_SEGMENTS; i++) {
        const j = (i + 1) % DISC_SEGMENTS;
        indices.push(inner[i], inner[j], outer[i]);
        indices.push(inner[j], outer[j], outer[i]);
      }
    }
  }

  function pushDiscVertex(x: number, z: number, shade: number): number {
    // Discs sit a hair above the ribbons so the overlap cannot z-fight.
    //
    // The water floor matters here: two junction nodes (the Mirror Lake east
    // and west shores) stand on ground that is genuinely under the water
    // surface. Without the floor their discs sank below the lake and showed up
    // as submerged asphalt.
    const y = Math.max(
      terrain.getRenderedTerrainHeight(x, z) + ROAD_LIFT + 0.004,
      waterY + ROAD_LIFT + 0.004
    );
    positions.push(x, y, z);
    uvs.push(0.5, 0.5);
    const n = (hash01(x * 0.7, z * 0.7) - 0.5) * 0.08;
    colors.push(ASPHALT[0] * shade + n, ASPHALT[1] * shade + n, ASPHALT[2] * shade + n);
    return positions.length / 3 - 1;
  }

  function pushBox(
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    yaw: number,
    shade: number
  ): void {
    const box = new THREE.BoxGeometry(sx, sy, sz);
    box.rotateY(yaw);
    box.translate(cx, cy, cz);
    const bp = box.getAttribute('position');
    const bn = box.getAttribute('normal');
    const start = sPositions.length / 3;
    for (let i = 0; i < bp.count; i++) {
      sPositions.push(bp.getX(i), bp.getY(i), bp.getZ(i));
      const ny = bn.getY(i);
      const value = shade * (0.9 + Math.max(0, ny) * 0.14);
      sColors.push(value, value * 0.99, value * 0.97);
    }
    const bi = box.getIndex();
    if (bi) for (let i = 0; i < bi.count; i++) sIndices.push(start + bi.getX(i));
    else for (let i = 0; i < bp.count; i++) sIndices.push(start + i);
    box.dispose();
  }

  /* ---- assemble --------------------------------------------------------- */

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    // Colour lives in the vertex attribute so markings can be brighter than the
    // asphalt without a second mesh or a second draw call.
    color: 0xffffff,
    vertexColors: true,
    // 9.1: a touch of sheen so the crown catches the sun; still firmly matte.
    roughness: 0.90,
    metalness: 0.03,
    envMapIntensity: 0.42,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  material.name = 'CiCraftRoadSurface';

  const surface = new THREE.Mesh(geometry, material);
  surface.name = 'RoadSurface';
  surface.receiveShadow = true;
  surface.castShadow = false;

  let structures: THREE.Mesh | null = null;
  if (sPositions.length > 0) {
    const sGeometry = new THREE.BufferGeometry();
    sGeometry.setAttribute('position', new THREE.Float32BufferAttribute(sPositions, 3));
    sGeometry.setAttribute('color', new THREE.Float32BufferAttribute(sColors, 3));
    sGeometry.setIndex(sIndices);
    sGeometry.computeVertexNormals();
    const sMaterial = new THREE.MeshStandardMaterial({
      color: 0x8d8a83,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.02,
      envMapIntensity: 0.4,
    });
    sMaterial.name = 'CiCraftBridgeStructure';
    structures = new THREE.Mesh(sGeometry, sMaterial);
    structures.name = 'RoadBridgeStructure';
    structures.receiveShadow = true;
    structures.castShadow = true;
  }

  // Longest triangle edge, used by the regression tests to prove nothing is
  // stretched across the map.
  let longestEdge = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < indices.length / 3; t++) {
    a.fromArray(positions, indices[t * 3] * 3);
    b.fromArray(positions, indices[t * 3 + 1] * 3);
    c.fromArray(positions, indices[t * 3 + 2] * 3);
    longestEdge = Math.max(longestEdge, a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
  }

  return {
    surface,
    structures,
    walkables,
    stats: {
      segments: segments.length,
      nodes: nodes.size,
      triangles: indices.length / 3,
      vertices: positions.length / 3,
      waterCrossings,
      spanLength,
      longestEdge,
    },
  };
}
