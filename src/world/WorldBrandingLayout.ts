import {
  EXPANSION_BUILDINGS, LEGENDARY_TOWER, buildingLocalToWorld,
  getCardinalAxes, getHighRiseRoofTop,
} from './WorldLayout';
import type { CardinalDirection, ExpansionBuildingPlacement } from './WorldLayout';

/** Exact text lives here, never in a client RNG, account setting or translated UI. */
export const BRANDING_DESIGNS = {
  street: { text: '$CI STREET', style: 'panel' },
  direction: { text: '$CI STREET', style: 'panel', arrow: true },
  plaza: { text: '$CI PLAZA', style: 'panel' },
  tower: { text: '$CI TOWER', style: 'panel' },
  district: { text: 'CI DISTRICT', style: 'panel' },
  market: { text: 'CI MARKET', style: 'panel' },
  paint: { text: '$CI', style: 'paint' },
  entrance: { text: '$CI', style: 'panel' },
  roof: { text: '$CI', style: 'panel' },
  stencil: { text: '$CI', style: 'stencil' },
  neon: { text: '$CI', style: 'neon' },
  graffiti: { text: '$CI', style: 'graffiti' },
  road: { text: '$CI STREET', style: 'road' },
} as const;
export type BrandingDesign = keyof typeof BRANDING_DESIGNS;
export const BRANDING_SURFACE_GAP = 0.018;

export interface BuildingBranding {
  readonly id: string;
  readonly buildingId: string;
  readonly districtId: string;
  readonly design: BrandingDesign;
  readonly support: 'wall' | 'shop-fascia' | 'highrise-parapet' | 'tower-header';
  readonly x: number;
  readonly z: number;
  /** Relative to the building's terrain anchor, not the terrain under the sign. */
  readonly y: number;
  readonly anchorX: number;
  readonly anchorZ: number;
  readonly yaw: number;
  readonly width: number;
  readonly height: number;
}

/** Curated existing surfaces: 13 modular buildings plus the existing Tower.
 * All 52 modular buildings have mountable opaque bays; legacy bespoke buildings
 * are left untouched rather than guessing their window/door geometry.
 */
export const BRANDED_MODULAR_BUILDING_IDS = [
  'plaza_market', 'plaza_depot', 'docks_warehouse', 'silos_warehouse',
  'grove_south_shop', 'lake_east_shop', 'westlook_shop', 'crossroads_shop',
  'crag_harbor_warehouse', 'northeast_garage',
  'aurora_exchange', 'aurora_observatory', 'aurora_northeast_tower',
] as const;

function makeBuildingBranding(): readonly BuildingBranding[] {
  const result: BuildingBranding[] = [];
  const mount = (b: ExpansionBuildingPlacement, design: BrandingDesign,
    support: BuildingBranding['support'], lx: number, y: number, lz: number,
    localYaw: number, width: number, height: number, suffix = '') => {
    const point = buildingLocalToWorld(b, lx, lz);
    result.push(Object.freeze({ id: `${b.id}_${design}${suffix}`, buildingId: b.id,
      districtId: b.districtId, design, support, ...point, y,
      anchorX: b.x, anchorZ: b.z, yaw: getCardinalAxes(b.facing).yaw + localYaw,
      width, height }));
  };
  for (const id of BRANDED_MODULAR_BUILDING_IDS) {
    const b = EXPANSION_BUILDINGS.find(candidate => candidate.id === id);
    if (!b) throw new Error(`Branding mount missing: ${id}`);
    const hd = b.depth / 2, gap = BRANDING_SURFACE_GAP;
    if (b.kind === 'shop') {
      mount(b, id === 'plaza_market' || id === 'crossroads_shop' ? 'market' : 'entrance',
        'shop-fascia', 0, 3.52, hd + 0.28 + gap, 0, 4.8, 0.52);
      // Sits in the wall band between the shopfront fascia and the 6.2 cornice.
      if (id === 'plaza_market') mount(b, 'plaza', 'wall', 0, 4.2, hd + gap, 0, 5.2, 0.55);
      if (id === 'westlook_shop') mount(b, 'graffiti', 'wall', 0, 1.55, -hd - gap, Math.PI, 2.1, 0.9);
    } else if (b.kind === 'warehouse') {
      const rear = id === 'docks_warehouse' || id === 'silos_warehouse';
      mount(b, rear ? 'stencil' : 'paint', 'wall', 0, b.height - 1.15,
        (rear ? -1 : 1) * (hd + gap), rear ? Math.PI : 0, 4.4, 1.35);
    } else if (b.kind === 'garage') {
      mount(b, 'graffiti', 'wall', 0, 1.55, -hd - gap, Math.PI, 2.1, 0.9);
    } else if (b.kind === 'highrise') {
      // Blank west-side band above ground-floor glazing, between vertical fins.
      // This is the existing north/south Aurora annex avenue, NOT a new road.
      mount(b, id === 'aurora_observatory' ? 'direction' : 'street', 'wall',
        -b.width / 2 - gap, 4.65, 0, -Math.PI / 2, 3.8, 0.95);
      if (id === 'aurora_northeast_tower') {
        // Approach-facing plaque at the south junction, clear of the facade fin.
        mount(b, 'street', 'wall', -3.35, 4.65, hd + gap, 0, 3.3, 0.95, '_entry');
        mount(b, 'district', 'wall', 0, 4.5, hd + gap, 0, 3.0, 0.65);
      } else {
        if (id === 'aurora_exchange') mount(b, 'street', 'wall', 0, 4.65, -hd - gap, Math.PI, 3.8, 0.95, '_entry');
        mount(b, 'neon', 'wall', 0, 4.5, hd + gap, 0, 2.8, 0.65);
        // Attached to the existing solid front parapet, never above it or in a bridge gap.
        mount(b, 'roof', 'highrise-parapet', 0, getHighRiseRoofTop(b) + 0.48,
          hd + 0.24 + gap, 0, 4.5, 0.65);
      }
    }
  }
  for (const facing of ['north', 'east', 'south', 'west'] as const satisfies readonly CardinalDirection[]) {
    const axes = getCardinalAxes(facing);
    const distance = LEGENDARY_TOWER.outerHalfExtent + 0.65 / 2 + BRANDING_SURFACE_GAP;
    result.push(Object.freeze({ id: `legendary_tower_${facing}_name`,
      buildingId: LEGENDARY_TOWER.id, districtId: LEGENDARY_TOWER.districtId,
      design: 'tower', support: 'tower-header',
      x: LEGENDARY_TOWER.x + axes.frontX * distance,
      z: LEGENDARY_TOWER.z + axes.frontZ * distance,
      y: LEGENDARY_TOWER.baseFloorOffset + 5.05,
      anchorX: LEGENDARY_TOWER.x, anchorZ: LEGENDARY_TOWER.z,
      yaw: axes.yaw, width: 4.1, height: 0.85 }));
  }
  return Object.freeze(result);
}
export const BUILDING_BRANDING = makeBuildingBranding();

/** Painted at the two ends of the EXISTING aurora_annex_avenue (x=97).
 * South paint sits just beyond the existing intersection pavement/curb.
 * Opposite reading directions welcome approaches from either end. Geometry is
 * clipped to the actual rendered terrain triangles, not an approximate plane.
 */
export const ROAD_BRANDING = Object.freeze([
  Object.freeze({ id: 'ci_street_south', roadId: 'aurora_annex_avenue', x: 97, z: -6, yaw: 0, width: 3.8, depth: 1.0 }),
  Object.freeze({ id: 'ci_street_north', roadId: 'aurora_annex_avenue', x: 97, z: -60, yaw: Math.PI, width: 3.8, depth: 1.0 }),
]);
