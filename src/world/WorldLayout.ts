/**
 * Deterministic layout data for the CI Craft island expansion.
 *
 * This module is intentionally free of Three.js and DOM dependencies. The
 * terrain generator uses it for settlement plateaus/roads, IslandWorld uses
 * it for instanced architecture and loot-safe placement, and the automated
 * tests use the same footprints to prove that districts do not overlap or
 * block roads/rivers. The eight original named POIs remain defined in
 * TerrainGenerator; everything here is additive.
 */

export type CardinalDirection = 'north' | 'east' | 'south' | 'west';
export type SettlementGround = 'paved' | 'dirt' | 'farm' | 'industrial' | 'sand' | 'alpine';
export type ExpansionBuildingKind =
  | 'house'
  | 'apartment'
  | 'shop'
  | 'warehouse'
  | 'garage'
  | 'barn'
  | 'cabin'
  | 'highrise';
export type ExpansionRoofStyle = 'flat' | 'gable' | 'shed';
export type LootTier = 'none' | 'low' | 'standard' | 'high';

export interface SettlementDefinition {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
  baseHeight: number;
  ground: SettlementGround;
  color: string;
  streetAxis: 'x' | 'z';
}

export interface RoadSegmentDefinition {
  id: string;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  kind: 'primary' | 'secondary';
}

export interface ExpansionBuildingPlacement {
  id: string;
  districtId: string;
  kind: ExpansionBuildingKind;
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  facing: CardinalDirection;
  wallColor: number;
  roofColor: number;
  accentColor: number;
  roof: ExpansionRoofStyle;
  /** Occupied levels, including the ground floor. High-rises use 4–6. */
  floors: number;
  lootTier: LootTier;
  rearDoor: boolean;
}

export interface LandmarkPlacement {
  id: string;
  kind: 'watchtower' | 'camp' | 'ruin' | 'dock' | 'bridge';
  districtId: string;
  x: number;
  z: number;
  facing: CardinalDirection;
  lootTier: LootTier;
}

export interface ForestClusterDefinition {
  id: string;
  x: number;
  z: number;
  radius: number;
  treeCount: number;
  rockCount: number;
  pineWeight: number;
  oakWeight: number;
  birchWeight: number;
  blossomWeight: number;
  palmWeight: number;
}

export interface AxisAlignedFootprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ProtectedWorldZone extends AxisAlignedFootprint {
  id: string;
}

export type LegendaryTowerSide = 'east' | 'north' | 'west' | 'south';
export type LegendaryTowerLootKind = 'weapon' | 'consumable' | 'ammo' | 'material';

export interface LegendaryTowerLootDefinition {
  id: string;
  itemType: LegendaryTowerLootKind;
  name: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  amount: number;
  floor: number;
  x: number;
  z: number;
  yOffset: number;
  weaponCategory?: 'pistol' | 'assault_rifle' | 'shotgun' | 'smg' | 'sniper' | 'medkit' | 'shield_potion';
  ammoType?: 'light' | 'medium' | 'shells' | 'heavy';
  materialType?: 'wood' | 'stone' | 'metal';
}

/**
 * The single central landmark. It deliberately sits at the island origin:
 * Pipeline Plaza's original four houses remain just outside its 22 m core,
 * while every spoke road already terminates at its plaza/entrances.
 */
export const LEGENDARY_TOWER = {
  id: 'legendary_tower',
  name: 'The Legendary Tower',
  districtId: 'pipeline_plaza',
  x: 0,
  z: 0,
  outerHalfExtent: 11,
  podiumHalfExtent: 12.3,
  floorCount: 8,
  roofLevel: 7,
  floorHeight: 6.5,
  baseFloorOffset: 0.55,
  stairInnerEdge: 7.05,
  stairOuterEdge: 10.35,
  stairRunHalf: 8.6,
  crownHeightAboveTerrain: 68,
} as const;

export const LEGENDARY_TOWER_ASCENT_SIDES: LegendaryTowerSide[] = [
  'east',
  'north',
  'west',
  'south',
];

export function getLegendaryTowerFloorHeight(baseY: number, level: number): number {
  return baseY + LEGENDARY_TOWER.baseFloorOffset + level * LEGENDARY_TOWER.floorHeight;
}

export const HIGHRISE_FLOOR_TOP = 0.36;
export const HIGHRISE_FLOOR_HEIGHT = 5;

export function getHighRiseFloorTop(level: number): number {
  return HIGHRISE_FLOOR_TOP + level * HIGHRISE_FLOOR_HEIGHT;
}

export function getHighRiseRoofTop(placement: ExpansionBuildingPlacement): number {
  return HIGHRISE_FLOOR_TOP + placement.floors * HIGHRISE_FLOOR_HEIGHT;
}

export const AURORA_HEIGHTS_SKYBRIDGE = {
  id: 'aurora_heights_skybridge',
  fromBuildingId: 'aurora_northwest_tower',
  toBuildingId: 'aurora_northeast_tower',
  localZ: 0,
  width: 3.2,
} as const;

export function getLegendaryTowerAscentSide(fromLevel: number): LegendaryTowerSide {
  return LEGENDARY_TOWER_ASCENT_SIDES[
    ((fromLevel % LEGENDARY_TOWER_ASCENT_SIDES.length) +
      LEGENDARY_TOWER_ASCENT_SIDES.length) %
      LEGENDARY_TOWER_ASCENT_SIDES.length
  ];
}

/**
 * Small, deliberately sub-legendary rewards on the climb. These use fixed
 * IDs in every mode so multiplayer collection can be deduplicated by the
 * server; the unique best-in-game weapons are only in the vault list below.
 */
export const LEGENDARY_TOWER_FLOOR_LOOT: LegendaryTowerLootDefinition[] = [
  { id: 'tower_floor_0_pistol', itemType: 'weapon', weaponCategory: 'pistol', name: 'Common Cyber Pistol', rarity: 'common', amount: 1, floor: 0, x: -4, z: 5, yOffset: 0.35 },
  { id: 'tower_floor_0_medkit', itemType: 'consumable', weaponCategory: 'medkit', name: 'Nano Medkit (+50)', rarity: 'uncommon', amount: 1, floor: 0, x: 4, z: 5, yOffset: 0.35 },
  { id: 'tower_floor_0_light_ammo', itemType: 'ammo', ammoType: 'light', name: 'Light Ammo (36)', rarity: 'common', amount: 36, floor: 0, x: 5, z: -4, yOffset: 0.35 },
  { id: 'tower_floor_1_smg', itemType: 'weapon', weaponCategory: 'smg', name: 'Uncommon Hyper SMG', rarity: 'uncommon', amount: 1, floor: 1, x: -5, z: -3, yOffset: 0.35 },
  { id: 'tower_floor_1_shield', itemType: 'consumable', weaponCategory: 'shield_potion', name: 'Shield Potion (+50)', rarity: 'rare', amount: 1, floor: 1, x: 4, z: 4, yOffset: 0.35 },
  { id: 'tower_floor_1_wood', itemType: 'material', materialType: 'wood', name: 'WOOD x50', rarity: 'uncommon', amount: 50, floor: 1, x: 5, z: 0, yOffset: 0.35 },
  { id: 'tower_floor_2_rifle', itemType: 'weapon', weaponCategory: 'assault_rifle', name: 'Rare Pulse Rifle', rarity: 'rare', amount: 1, floor: 2, x: -4, z: 4, yOffset: 0.35 },
  { id: 'tower_floor_2_medium_ammo', itemType: 'ammo', ammoType: 'medium', name: 'Medium Ammo (60)', rarity: 'common', amount: 60, floor: 2, x: 5, z: -3, yOffset: 0.35 },
  { id: 'tower_floor_2_stone', itemType: 'material', materialType: 'stone', name: 'STONE x60', rarity: 'uncommon', amount: 60, floor: 2, x: -5, z: 0, yOffset: 0.35 },
  { id: 'tower_floor_3_shotgun', itemType: 'weapon', weaponCategory: 'shotgun', name: 'Rare Scatter Pump', rarity: 'rare', amount: 1, floor: 3, x: 4, z: 5, yOffset: 0.35 },
  { id: 'tower_floor_3_medkit', itemType: 'consumable', weaponCategory: 'medkit', name: 'Nano Medkit (+50)', rarity: 'uncommon', amount: 1, floor: 3, x: -5, z: -4, yOffset: 0.35 },
  { id: 'tower_floor_3_shells', itemType: 'ammo', ammoType: 'shells', name: 'Shotgun Shells (24)', rarity: 'common', amount: 24, floor: 3, x: 0, z: 5, yOffset: 0.35 },
  { id: 'tower_floor_4_sniper', itemType: 'weapon', weaponCategory: 'sniper', name: 'Rare Rail Sniper', rarity: 'rare', amount: 1, floor: 4, x: -4, z: -5, yOffset: 0.35 },
  { id: 'tower_floor_4_shield', itemType: 'consumable', weaponCategory: 'shield_potion', name: 'Shield Potion (+50)', rarity: 'rare', amount: 1, floor: 4, x: 5, z: 4, yOffset: 0.35 },
  { id: 'tower_floor_4_heavy_ammo', itemType: 'ammo', ammoType: 'heavy', name: 'Heavy Sniper Ammo (16)', rarity: 'common', amount: 16, floor: 4, x: 3, z: -5, yOffset: 0.35 },
  { id: 'tower_floor_5_smg', itemType: 'weapon', weaponCategory: 'smg', name: 'Epic Hyper SMG', rarity: 'epic', amount: 1, floor: 5, x: 5, z: -4, yOffset: 0.35 },
  { id: 'tower_floor_5_shield', itemType: 'consumable', weaponCategory: 'shield_potion', name: 'Shield Potion (+50)', rarity: 'rare', amount: 1, floor: 5, x: -2.5, z: 3, yOffset: 0.35 },
  { id: 'tower_floor_5_light_ammo', itemType: 'ammo', ammoType: 'light', name: 'Light Ammo (72)', rarity: 'common', amount: 72, floor: 5, x: -3, z: 5, yOffset: 0.35 },
  { id: 'tower_floor_6_rifle', itemType: 'weapon', weaponCategory: 'assault_rifle', name: 'Epic Pulse Rifle', rarity: 'epic', amount: 1, floor: 6, x: -4, z: 4, yOffset: 0.35 },
  { id: 'tower_floor_6_medkit', itemType: 'consumable', weaponCategory: 'medkit', name: 'Nano Medkit (+50)', rarity: 'uncommon', amount: 1, floor: 6, x: 4, z: -4, yOffset: 0.35 },
  { id: 'tower_floor_6_metal', itemType: 'material', materialType: 'metal', name: 'METAL x100', rarity: 'uncommon', amount: 100, floor: 6, x: 0, z: 5, yOffset: 0.35 },
];

/**
 * The roof vault. IDs are part of the multiplayer contract: the Node server
 * keeps an identical authoritative registry, sends these items itself in
 * online matches, and rejects any client-forged duplicate/swap for them.
 */
export const LEGENDARY_TOWER_VAULT_LOOT: LegendaryTowerLootDefinition[] = [
  { id: 'legendary_tower_assault_rifle', itemType: 'weapon', weaponCategory: 'assault_rifle', name: 'Legendary Pulse Rifle', rarity: 'legendary', amount: 1, floor: 7, x: -3, z: 2.8, yOffset: 1.18 },
  { id: 'legendary_tower_sniper', itemType: 'weapon', weaponCategory: 'sniper', name: 'Legendary Rail Sniper', rarity: 'legendary', amount: 1, floor: 7, x: 0, z: 3.4, yOffset: 1.18 },
  { id: 'legendary_tower_shotgun', itemType: 'weapon', weaponCategory: 'shotgun', name: 'Legendary Scatter Pump', rarity: 'legendary', amount: 1, floor: 7, x: 3, z: 2.8, yOffset: 1.18 },
  { id: 'legendary_tower_shield_1', itemType: 'consumable', weaponCategory: 'shield_potion', name: 'Shield Potion (+50)', rarity: 'rare', amount: 1, floor: 7, x: -3.6, z: 0.6, yOffset: 1.18 },
  { id: 'legendary_tower_shield_2', itemType: 'consumable', weaponCategory: 'shield_potion', name: 'Shield Potion (+50)', rarity: 'rare', amount: 1, floor: 7, x: -1.9, z: 0.8, yOffset: 1.18 },
  { id: 'legendary_tower_medkit_1', itemType: 'consumable', weaponCategory: 'medkit', name: 'Nano Medkit (+50)', rarity: 'uncommon', amount: 1, floor: 7, x: 1.9, z: 0.8, yOffset: 1.18 },
  { id: 'legendary_tower_medkit_2', itemType: 'consumable', weaponCategory: 'medkit', name: 'Nano Medkit (+50)', rarity: 'uncommon', amount: 1, floor: 7, x: 3.6, z: 0.6, yOffset: 1.18 },
  { id: 'legendary_tower_medium_ammo', itemType: 'ammo', ammoType: 'medium', name: 'Medium Ammo (120)', rarity: 'common', amount: 120, floor: 7, x: -3.4, z: -3, yOffset: 1.18 },
  { id: 'legendary_tower_heavy_ammo', itemType: 'ammo', ammoType: 'heavy', name: 'Heavy Sniper Ammo (40)', rarity: 'common', amount: 40, floor: 7, x: 0, z: -3.6, yOffset: 1.18 },
  { id: 'legendary_tower_shells', itemType: 'ammo', ammoType: 'shells', name: 'Shotgun Shells (48)', rarity: 'common', amount: 48, floor: 7, x: 3.4, z: -3, yOffset: 1.18 },
  { id: 'legendary_tower_metal', itemType: 'material', materialType: 'metal', name: 'METAL x250', rarity: 'uncommon', amount: 250, floor: 7, x: -3.8, z: -0.8, yOffset: 1.18 },
  { id: 'legendary_tower_stone', itemType: 'material', materialType: 'stone', name: 'STONE x200', rarity: 'uncommon', amount: 200, floor: 7, x: 3.8, z: -0.8, yOffset: 1.18 },
  { id: 'legendary_tower_wood', itemType: 'material', materialType: 'wood', name: 'WOOD x200', rarity: 'uncommon', amount: 200, floor: 7, x: 0, z: -2.2, yOffset: 1.18 },
];

export const ISLAND_SETTLEMENTS: SettlementDefinition[] = [
  { id: 'westlook_village', name: 'Westlook Village', x: -150, z: -45, radius: 25, baseHeight: 3.6, ground: 'paved', color: '#38bdf8', streetAxis: 'x' },
  { id: 'southwest_hamlet', name: 'Southwest Hamlet', x: -145, z: 45, radius: 25, baseHeight: 4.2, ground: 'sand', color: '#fb7185', streetAxis: 'x' },
  { id: 'northwest_cabins', name: 'Northwest Cabins', x: -80, z: -155, radius: 23, baseHeight: 3.1, ground: 'farm', color: '#f59e0b', streetAxis: 'z' },
  { id: 'crossroads_market', name: 'Crossroads Market', x: -60, z: -25, radius: 21, baseHeight: 3.1, ground: 'dirt', color: '#facc15', streetAxis: 'x' },
  { id: 'alpine_outpost', name: 'Alpine Outpost', x: 55, z: -35, radius: 22, baseHeight: 11.9, ground: 'alpine', color: '#7dd3fc', streetAxis: 'x' },
  { id: 'north_fields', name: 'North Fields', x: 10, z: -70, radius: 22, baseHeight: 6.0, ground: 'farm', color: '#84cc16', streetAxis: 'z' },
  { id: 'east_crag_town', name: 'East Crag Town', x: 145, z: -55, radius: 25, baseHeight: 5.9, ground: 'paved', color: '#fb923c', streetAxis: 'x' },
  { id: 'crag_harbor', name: 'Crag Harbor', x: 145, z: 35, radius: 23, baseHeight: 2.9, ground: 'industrial', color: '#2dd4bf', streetAxis: 'z' },
  { id: 'south_river_town', name: 'South River Town', x: -55, z: 150, radius: 24, baseHeight: 6.4, ground: 'dirt', color: '#4ade80', streetAxis: 'x' },
  { id: 'southeast_coast', name: 'Southeast Coast', x: 155, z: 95, radius: 23, baseHeight: 3.8, ground: 'sand', color: '#22d3ee', streetAxis: 'z' },
  { id: 'northeast_coast', name: 'Northeast Coast', x: 155, z: -105, radius: 23, baseHeight: 7.0, ground: 'paved', color: '#f87171', streetAxis: 'z' },
  { id: 'inner_east_suburb', name: 'Inner East Suburb', x: 55, z: 35, radius: 21, baseHeight: 7.0, ground: 'paved', color: '#a78bfa', streetAxis: 'x' },
  { id: 'aurora_heights', name: 'Aurora Heights', x: 97, z: 2, radius: 30, baseHeight: 6.6, ground: 'paved', color: '#22d3ee', streetAxis: 'x' },
];

/**
 * The first seven segments reproduce the original centre-to-POI road spokes.
 * Secondary segments form a rough ring/connector network through the new
 * settlements. Mirror Lake deliberately receives shore endpoints instead of a
 * road through the water.
 */
export const ISLAND_ROAD_SEGMENTS: RoadSegmentDefinition[] = [
  { id: 'primary_docker_docks', fromX: 0, fromZ: 0, toX: -105, toZ: 95, kind: 'primary' },
  { id: 'primary_kubernetes_keep', fromX: 0, fromZ: 0, toX: 100, toZ: -95, kind: 'primary' },
  { id: 'primary_git_grove', fromX: 0, fromZ: 0, toX: -95, toZ: -85, kind: 'primary' },
  { id: 'primary_server_silos', fromX: 0, fromZ: 0, toX: 95, toZ: 90, kind: 'primary' },
  { id: 'primary_frontend_farms', fromX: 0, fromZ: 0, toX: -25, toZ: -118, kind: 'primary' },
  { id: 'primary_legacy_ruins', fromX: 0, fromZ: 0, toX: 32, toZ: 122, kind: 'primary' },

  { id: 'lake_east_shore', fromX: 0, fromZ: 0, toX: -20, toZ: 38, kind: 'secondary' },
  { id: 'lake_west_to_southwest', fromX: -70, fromZ: 38, toX: -145, toZ: 45, kind: 'secondary' },
  { id: 'lake_west_to_westlook', fromX: -70, fromZ: 38, toX: -150, toZ: -45, kind: 'secondary' },
  { id: 'southwest_to_docks', fromX: -145, fromZ: 45, toX: -105, toZ: 95, kind: 'secondary' },
  { id: 'westlook_to_grove', fromX: -150, fromZ: -45, toX: -95, toZ: -85, kind: 'secondary' },
  { id: 'grove_to_northwest', fromX: -95, fromZ: -85, toX: -80, toZ: -155, kind: 'secondary' },
  { id: 'northwest_to_farms', fromX: -80, fromZ: -155, toX: -25, toZ: -118, kind: 'secondary' },
  { id: 'centre_to_crossroads', fromX: 0, fromZ: 0, toX: -60, toZ: -25, kind: 'secondary' },
  { id: 'crossroads_to_grove', fromX: -60, fromZ: -25, toX: -95, toZ: -85, kind: 'secondary' },
  { id: 'farms_to_north_fields', fromX: -25, fromZ: -118, toX: 10, toZ: -70, kind: 'secondary' },
  { id: 'north_fields_to_alpine', fromX: 10, fromZ: -70, toX: 55, toZ: -35, kind: 'secondary' },
  { id: 'centre_to_alpine', fromX: 0, fromZ: 0, toX: 55, toZ: -35, kind: 'secondary' },
  { id: 'alpine_to_keep', fromX: 55, fromZ: -35, toX: 100, toZ: -95, kind: 'secondary' },
  { id: 'keep_to_northeast', fromX: 100, fromZ: -95, toX: 155, toZ: -105, kind: 'secondary' },
  { id: 'northeast_to_east_crag', fromX: 155, fromZ: -105, toX: 145, toZ: -55, kind: 'secondary' },
  { id: 'east_crag_to_harbor', fromX: 145, fromZ: -55, toX: 145, toZ: 35, kind: 'secondary' },
  { id: 'harbor_to_silos', fromX: 145, fromZ: 35, toX: 95, toZ: 90, kind: 'secondary' },
  { id: 'centre_to_inner_east', fromX: 0, fromZ: 0, toX: 55, toZ: 35, kind: 'secondary' },
  { id: 'centre_to_aurora_west', fromX: 0, fromZ: 0, toX: 45, toZ: -17, kind: 'secondary' },
  { id: 'aurora_west_link', fromX: 45, fromZ: -17, toX: 68, toZ: 2, kind: 'secondary' },
  { id: 'aurora_east_link', fromX: 68, fromZ: 2, toX: 97, toZ: 3.5, kind: 'secondary' },
  { id: 'inner_east_to_silos', fromX: 55, fromZ: 35, toX: 95, toZ: 90, kind: 'secondary' },
  { id: 'silos_to_southeast', fromX: 95, fromZ: 90, toX: 155, toZ: 95, kind: 'secondary' },
  { id: 'southeast_to_ruins', fromX: 155, fromZ: 95, toX: 32, toZ: 122, kind: 'secondary' },
  { id: 'ruins_to_south_river', fromX: 32, fromZ: 122, toX: -55, toZ: 150, kind: 'secondary' },
  { id: 'south_river_to_docks', fromX: -55, fromZ: 150, toX: -105, toZ: 95, kind: 'secondary' },
];

interface BuildingOptions {
  accentColor?: number;
  roof?: ExpansionRoofStyle;
  floors?: number;
  lootTier?: LootTier;
  rearDoor?: boolean;
}

function building(
  id: string,
  districtId: string,
  kind: ExpansionBuildingKind,
  x: number,
  z: number,
  width: number,
  depth: number,
  height: number,
  facing: CardinalDirection,
  wallColor: number,
  roofColor: number,
  options: BuildingOptions = {}
): ExpansionBuildingPlacement {
  return {
    id,
    districtId,
    kind,
    x,
    z,
    width,
    depth,
    height,
    facing,
    wallColor,
    roofColor,
    accentColor: options.accentColor ?? roofColor,
    roof: options.roof ?? (kind === 'cabin' || kind === 'barn' ? 'gable' : 'flat'),
    floors: options.floors ?? (kind === 'apartment' ? 2 : 1),
    lootTier: options.lootTier ?? 'standard',
    rearDoor: options.rearDoor ?? false,
  };
}

/** 50 handcrafted, cardinal-facing modular buildings: 18 in/around the original POIs and 32 in secondary settlements. */
export const EXPANSION_BUILDINGS: ExpansionBuildingPlacement[] = [
  // Pipeline Plaza — denser civic/commercial centre around the original four houses.
  building('plaza_apartments', 'pipeline_plaza', 'apartment', -34, -1, 12, 10, 7.2, 'east', 0xe0f2fe, 0x0369a1, { accentColor: 0x38bdf8, lootTier: 'high', rearDoor: true }),
  building('plaza_market', 'pipeline_plaza', 'shop', 34, 4, 13, 9, 5.0, 'west', 0xfef3c7, 0xdb2777, { accentColor: 0xf472b6 }),
  building('plaza_depot', 'pipeline_plaza', 'warehouse', 7, -34, 16, 10, 5.8, 'south', 0xcbd5e1, 0x0f766e, { accentColor: 0x2dd4bf, lootTier: 'high', rearDoor: true }),
  building('plaza_garage', 'pipeline_plaza', 'garage', -3, 34, 10, 8, 4.0, 'north', 0xfde68a, 0x92400e, { roof: 'shed', lootTier: 'low' }),

  // Docker Docks — working harbour housing and storage east/west of the original house.
  building('docks_warehouse', 'docker_docks', 'warehouse', -82, 96, 15, 10, 6.0, 'west', 0xffedd5, 0x9a3412, { accentColor: 0xfb923c, lootTier: 'high', rearDoor: true }),
  building('docks_crew_apartments', 'docker_docks', 'apartment', -111, 69, 11, 9, 7.0, 'east', 0xe0f2fe, 0x2563eb, { accentColor: 0x38bdf8, lootTier: 'high' }),

  // Kubernetes Keep — barracks outside the south-west tower and a storehouse beyond the north wall.
  building('keep_barracks', 'kubernetes_keep', 'apartment', 74, -88, 12, 10, 7.0, 'east', 0xe9d5ff, 0x6d28d9, { accentColor: 0xc084fc, lootTier: 'high' }),
  building('keep_storehouse', 'kubernetes_keep', 'warehouse', 100, -129, 16, 10, 5.8, 'south', 0xd8b4fe, 0x581c87, { accentColor: 0xa855f7, lootTier: 'high', rearDoor: true }),

  // Git Grove — forest cabins/shops clear of the treehouse and original cottages.
  building('grove_west_cabin', 'git_grove', 'cabin', -121, -80, 9, 8, 4.4, 'east', 0xd6a35c, 0x166534, { accentColor: 0x4ade80 }),
  building('grove_south_shop', 'git_grove', 'shop', -95, -57, 11, 8, 4.8, 'north', 0xfef9c3, 0x15803d, { accentColor: 0x22c55e }),

  // Server Silos — industrial storage and crew apartments.
  building('silos_warehouse', 'server_silos', 'warehouse', 98, 60, 15, 10, 6.0, 'south', 0xe2e8f0, 0xeab308, { accentColor: 0xfacc15, lootTier: 'high', rearDoor: true }),
  building('silos_apartments', 'server_silos', 'apartment', 83, 54, 11, 9, 7.0, 'east', 0xfef9c3, 0xca8a04, { accentColor: 0xfde047, lootTier: 'high' }),

  // Mirror Lake — inhabited shores without building in the lake/river channel.
  building('lake_west_cabin', 'mirror_lake', 'cabin', -93, 30, 9, 8, 4.4, 'east', 0xd6a35c, 0x0f766e, { accentColor: 0x2dd4bf }),
  building('lake_east_shop', 'mirror_lake', 'shop', -12, 52, 11, 8, 4.8, 'west', 0xecfeff, 0x0891b2, { accentColor: 0x22d3ee }),

  // Frontend Farms — a working east farmyard clear of fences, windmill and hay bales.
  building('farms_east_barn', 'frontend_farms', 'barn', 2, -104, 13, 10, 5.8, 'west', 0xfca5a5, 0x7f1d1d, { accentColor: 0xef4444, lootTier: 'high', rearDoor: true }),
  building('farms_east_house', 'frontend_farms', 'house', -2, -132, 10, 9, 4.6, 'west', 0xfff7ed, 0xb91c1c, { accentColor: 0xf87171, roof: 'gable' }),

  // Legacy Ruins — expedition buildings outside the temple dais and research dome.
  building('ruins_expedition_lodge', 'legacy_ruins', 'shop', 8, 104, 11, 9, 5.0, 'east', 0xe2e8f0, 0x7e22ce, { accentColor: 0xc084fc }),
  building('ruins_archive_warehouse', 'legacy_ruins', 'warehouse', 58, 138, 14, 10, 5.8, 'west', 0xd6d3d1, 0x57534e, { accentColor: 0xa855f7, lootTier: 'high', rearDoor: true }),

  // Secondary settlements.
  building('westlook_house', 'westlook_village', 'house', -161, -57, 10, 9, 4.8, 'south', 0xe0f2fe, 0x075985, { roof: 'gable' }),
  building('westlook_shop', 'westlook_village', 'shop', -148, -63, 12, 9, 5.0, 'south', 0xfef3c7, 0x0284c7),
  building('westlook_garage', 'westlook_village', 'garage', -154, -32, 9, 8, 4.0, 'north', 0xcbd5e1, 0x334155, { roof: 'shed', lootTier: 'low' }),

  building('southwest_house', 'southwest_hamlet', 'house', -157, 33, 10, 9, 4.8, 'south', 0xffe4e6, 0xbe123c, { roof: 'gable' }),
  building('southwest_shop', 'southwest_hamlet', 'shop', -134, 33, 11, 8, 4.8, 'south', 0xecfeff, 0x0f766e),
  building('southwest_warehouse', 'southwest_hamlet', 'warehouse', -149, 61, 14, 9, 5.6, 'north', 0xfed7aa, 0x9a3412, { lootTier: 'high' }),

  building('northwest_barn', 'northwest_cabins', 'barn', -94, -146, 13, 10, 5.8, 'south', 0xfca5a5, 0x991b1b, { lootTier: 'high', rearDoor: true }),
  building('northwest_cabin', 'northwest_cabins', 'cabin', -68, -164, 9, 8, 4.4, 'north', 0xd6a35c, 0x92400e),

  building('crossroads_shop', 'crossroads_market', 'shop', -73, -19, 12, 9, 5.0, 'south', 0xfef3c7, 0xd97706, { lootTier: 'high' }),
  building('crossroads_garage', 'crossroads_market', 'garage', -52, -11, 9, 8, 4.0, 'north', 0xe2e8f0, 0x475569, { roof: 'shed', lootTier: 'low' }),

  building('alpine_apartments', 'alpine_outpost', 'apartment', 71, -37, 11, 9, 7.0, 'west', 0xf0f9ff, 0x0369a1, { lootTier: 'high' }),
  building('alpine_research_shop', 'alpine_outpost', 'shop', 65, -26, 11, 8, 4.8, 'north', 0xe0f2fe, 0x2563eb),

  building('north_fields_barn', 'north_fields', 'barn', 14, -86, 13, 10, 5.8, 'south', 0xfde68a, 0x92400e, { lootTier: 'high', rearDoor: true }),
  building('north_fields_house', 'north_fields', 'house', 11, -55, 10, 9, 4.8, 'north', 0xecfccb, 0x4d7c0f, { roof: 'gable' }),

  building('east_crag_apartments', 'east_crag_town', 'apartment', 134, -66, 12, 10, 7.2, 'south', 0xffedd5, 0x9a3412, { lootTier: 'high', rearDoor: true }),
  building('east_crag_shop', 'east_crag_town', 'shop', 158, -63, 12, 9, 5.0, 'south', 0xfef3c7, 0xc2410c),
  building('east_crag_warehouse', 'east_crag_town', 'warehouse', 133, -46, 15, 10, 6.0, 'north', 0xe7e5e4, 0x57534e, { lootTier: 'high' }),

  building('crag_harbor_warehouse', 'crag_harbor', 'warehouse', 130, 26, 15, 10, 6.0, 'south', 0xccfbf1, 0x115e59, { lootTier: 'high', rearDoor: true }),
  building('crag_harbor_shop', 'crag_harbor', 'shop', 156, 47, 11, 8, 4.8, 'north', 0xf0fdfa, 0x0f766e),

  building('south_river_house', 'south_river_town', 'house', -72, 148, 10, 9, 4.8, 'east', 0xecfccb, 0x3f6212, { roof: 'gable' }),
  building('south_river_shop', 'south_river_town', 'shop', -47, 136, 11, 8, 4.8, 'south', 0xfef9c3, 0x65a30d),
  building('south_river_barn', 'south_river_town', 'barn', -55, 162, 13, 10, 5.8, 'north', 0xfca5a5, 0x7f1d1d, { lootTier: 'high' }),

  building('southeast_house', 'southeast_coast', 'house', 145, 84, 10, 9, 4.8, 'south', 0xecfeff, 0x0e7490, { roof: 'gable' }),
  building('southeast_warehouse', 'southeast_coast', 'warehouse', 164, 107, 14, 9, 5.6, 'north', 0xe0f2fe, 0x155e75, { lootTier: 'high' }),

  building('northeast_apartments', 'northeast_coast', 'apartment', 144, -116, 11, 9, 7.0, 'south', 0xfee2e2, 0x991b1b, { lootTier: 'high' }),
  building('northeast_garage', 'northeast_coast', 'garage', 166, -94, 9, 8, 4.0, 'north', 0xe2e8f0, 0x7f1d1d, { roof: 'shed', lootTier: 'low' }),

  building('inner_east_house', 'inner_east_suburb', 'house', 52, 20, 10, 9, 4.8, 'south', 0xede9fe, 0x6d28d9, { roof: 'gable' }),
  building('inner_east_shop', 'inner_east_suburb', 'shop', 72, 35, 11, 8, 4.8, 'west', 0xfef3c7, 0x7c3aed),

  // Aurora Heights — four enterable towers with switchback floors, front
  // balconies, rooftop cover and a same-height northern skybridge.
  building('aurora_northwest_tower', 'aurora_heights', 'highrise', 84, -13, 18, 16, 30, 'south', 0xdbeafe, 0x0369a1, { accentColor: 0x22d3ee, floors: 6, lootTier: 'high', rearDoor: true }),
  building('aurora_northeast_tower', 'aurora_heights', 'highrise', 110, -13, 18, 16, 30, 'south', 0xfee2e2, 0x9a3412, { accentColor: 0xfb923c, floors: 6, lootTier: 'high', rearDoor: true }),
  building('aurora_southwest_tower', 'aurora_heights', 'highrise', 84, 18, 16, 15, 20, 'north', 0xccfbf1, 0x0f766e, { accentColor: 0x2dd4bf, floors: 4, lootTier: 'high', rearDoor: true }),
  building('aurora_southeast_tower', 'aurora_heights', 'highrise', 110, 18, 17, 15, 25, 'north', 0xede9fe, 0x6d28d9, { accentColor: 0xa78bfa, floors: 5, lootTier: 'high', rearDoor: true }),
];

export const EXPANSION_LANDMARKS: LandmarkPlacement[] = [
  { id: 'westlook_watchtower', kind: 'watchtower', districtId: 'westlook_village', x: -170, z: -18, facing: 'east', lootTier: 'high' },
  { id: 'docks_watchtower', kind: 'watchtower', districtId: 'docker_docks', x: -136, z: 88, facing: 'east', lootTier: 'standard' },
  { id: 'alpine_watchtower', kind: 'watchtower', districtId: 'alpine_outpost', x: 72, z: -52, facing: 'west', lootTier: 'high' },
  { id: 'crag_harbor_watchtower', kind: 'watchtower', districtId: 'crag_harbor', x: 166, z: 12, facing: 'west', lootTier: 'standard' },
  { id: 'lake_watchtower', kind: 'watchtower', districtId: 'mirror_lake', x: -70, z: 58, facing: 'east', lootTier: 'standard' },
  { id: 'southeast_watchtower', kind: 'watchtower', districtId: 'southeast_coast', x: 176, z: 72, facing: 'west', lootTier: 'standard' },
  { id: 'northeast_watchtower', kind: 'watchtower', districtId: 'northeast_coast', x: 176, z: -82, facing: 'west', lootTier: 'standard' },

  { id: 'west_forest_camp', kind: 'camp', districtId: 'westlook_village', x: -122, z: -20, facing: 'east', lootTier: 'standard' },
  { id: 'north_fields_camp', kind: 'camp', districtId: 'north_fields', x: 24, z: -104, facing: 'south', lootTier: 'low' },
  { id: 'east_woods_camp', kind: 'camp', districtId: 'crag_harbor', x: 126, z: -22, facing: 'west', lootTier: 'standard' },
  { id: 'southern_camp', kind: 'camp', districtId: 'southeast_coast', x: 94, z: 132, facing: 'north', lootTier: 'low' },
  { id: 'southwest_camp', kind: 'camp', districtId: 'southwest_hamlet', x: -96, z: 124, facing: 'north', lootTier: 'standard' },
  { id: 'riverside_camp', kind: 'camp', districtId: 'mirror_lake', x: -10, z: 84, facing: 'west', lootTier: 'low' },

  { id: 'northwest_ruins', kind: 'ruin', districtId: 'northwest_cabins', x: -118, z: -122, facing: 'east', lootTier: 'high' },
  { id: 'north_ruins', kind: 'ruin', districtId: 'frontend_farms', x: -18, z: -140, facing: 'south', lootTier: 'standard' },
  { id: 'southeast_ruins', kind: 'ruin', districtId: 'southeast_coast', x: 122, z: 118, facing: 'west', lootTier: 'high' },
  { id: 'east_coast_ruins', kind: 'ruin', districtId: 'crag_harbor', x: 166, z: 58, facing: 'west', lootTier: 'standard' },

  { id: 'lake_west_dock', kind: 'dock', districtId: 'mirror_lake', x: -62, z: 38, facing: 'east', lootTier: 'low' },
  { id: 'lake_east_dock', kind: 'dock', districtId: 'mirror_lake', x: -30, z: 38, facing: 'west', lootTier: 'low' },
  { id: 'river_south_dock', kind: 'dock', districtId: 'legacy_ruins', x: -12, z: 136, facing: 'west', lootTier: 'low' },
  { id: 'middle_river_bridge', kind: 'bridge', districtId: 'mirror_lake', x: -20, z: 108, facing: 'east', lootTier: 'low' },
];

export const FOREST_CLUSTERS: ForestClusterDefinition[] = [
  { id: 'git_grove_deepwoods', x: -108, z: -63, radius: 38, treeCount: 26, rockCount: 4, pineWeight: 0.34, oakWeight: 0.36, birchWeight: 0.18, blossomWeight: 0.12, palmWeight: 0 },
  { id: 'westlook_pines', x: -158, z: -12, radius: 32, treeCount: 22, rockCount: 4, pineWeight: 0.62, oakWeight: 0.2, birchWeight: 0.18, blossomWeight: 0, palmWeight: 0 },
  { id: 'northwest_timber', x: -98, z: -142, radius: 34, treeCount: 22, rockCount: 4, pineWeight: 0.58, oakWeight: 0.22, birchWeight: 0.2, blossomWeight: 0, palmWeight: 0 },
  { id: 'alpine_pines', x: 48, z: -78, radius: 36, treeCount: 22, rockCount: 5, pineWeight: 0.74, oakWeight: 0.08, birchWeight: 0.18, blossomWeight: 0, palmWeight: 0 },
  { id: 'east_crag_woods', x: 138, z: -8, radius: 34, treeCount: 20, rockCount: 4, pineWeight: 0.42, oakWeight: 0.36, birchWeight: 0.16, blossomWeight: 0.06, palmWeight: 0 },
  { id: 'lake_west_woods', x: -88, z: 16, radius: 28, treeCount: 18, rockCount: 3, pineWeight: 0.24, oakWeight: 0.42, birchWeight: 0.18, blossomWeight: 0.16, palmWeight: 0 },
  { id: 'southern_river_woods', x: -18, z: 146, radius: 32, treeCount: 18, rockCount: 3, pineWeight: 0.28, oakWeight: 0.42, birchWeight: 0.18, blossomWeight: 0.12, palmWeight: 0 },
  { id: 'southeast_palms', x: 142, z: 122, radius: 30, treeCount: 16, rockCount: 3, pineWeight: 0.05, oakWeight: 0.28, birchWeight: 0.05, blossomWeight: 0.12, palmWeight: 0.5 },
  { id: 'inner_east_groves', x: 82, z: 28, radius: 26, treeCount: 14, rockCount: 3, pineWeight: 0.3, oakWeight: 0.42, birchWeight: 0.18, blossomWeight: 0.1, palmWeight: 0 },
  { id: 'north_mountain_pines', x: 8, z: -142, radius: 34, treeCount: 18, rockCount: 5, pineWeight: 0.78, oakWeight: 0.05, birchWeight: 0.17, blossomWeight: 0, palmWeight: 0 },
];

/**
 * Conservative footprints for major pre-expansion structures. These are not
 * gameplay colliders; they keep new buildings/vegetation/loot from spawning
 * inside structures that existed before the expansion.
 */
export const EXISTING_MAJOR_FOOTPRINTS: ProtectedWorldZone[] = [
  { id: 'plaza_house_nw', minX: -24, maxX: -9, minZ: -21, maxZ: -11 },
  { id: 'plaza_house_ne', minX: 12, maxX: 27, minZ: -21, maxZ: -11 },
  { id: 'plaza_house_sw', minX: -23, maxX: -13, minZ: 11, maxZ: 21 },
  { id: 'plaza_house_se', minX: 12, maxX: 27, minZ: 11, maxZ: 21 },
  { id: 'legendary_tower_core', minX: -11.8, maxX: 11.8, minZ: -11.8, maxZ: 11.8 },
  { id: 'legendary_tower_south_works', minX: -11, maxX: 11, minZ: 11.2, maxZ: 16.2 },
  { id: 'legendary_tower_north_works', minX: -11, maxX: 11, minZ: -16.2, maxZ: -11.2 },
  { id: 'legendary_tower_east_works', minX: 11.2, maxX: 16.2, minZ: -11, maxZ: 11 },
  { id: 'legendary_tower_west_works', minX: -16.2, maxX: -11.2, minZ: -11, maxZ: 11 },
  { id: 'docks_original_house', minX: -112, maxX: -95, minZ: 78, maxZ: 88 },
  { id: 'docks_pier_lighthouse', minX: -138, maxX: -123, minZ: 107, maxZ: 127 },
  { id: 'docks_crane_containers', minX: -123, maxX: -89, minZ: 87, maxZ: 109 },
  { id: 'keep_original_house', minX: 93, maxX: 110, minZ: -102, maxZ: -88 },
  { id: 'keep_towers_wall', minX: 81, maxX: 119, minZ: -114, maxZ: -76 },
  { id: 'grove_original_houses_platform', minX: -111, maxX: -80, minZ: -96, maxZ: -73 },
  { id: 'silos_original_house', minX: 78, maxX: 91, minZ: 85, maxZ: 95 },
  { id: 'server_silos_row', minX: 99, maxX: 107, minZ: 74, maxZ: 106 },
  { id: 'mirror_lake_dock', minX: -48, maxX: -42, minZ: 12, maxZ: 22 },
  { id: 'river_bridge_one', minX: -38, maxX: -20, minZ: 75, maxZ: 81 },
  { id: 'river_bridge_two', minX: -34, maxX: -16, minZ: 133, maxZ: 139 },
  { id: 'farms_original_house', minX: -40, maxX: -23, minZ: -124, maxZ: -112 },
  { id: 'farms_silo_windmill', minX: -46, maxX: -10, minZ: -128, maxZ: -121 },
  { id: 'farms_fences_hay', minX: -42, maxX: -5, minZ: -112, maxZ: -101 },
  { id: 'ruins_temple', minX: 23, maxX: 41, minZ: 113, maxZ: 131 },
  { id: 'ruins_research_dome', minX: 39, maxX: 55, minZ: 109, maxZ: 125 },
];

export function getSettlementById(id: string): SettlementDefinition | undefined {
  return ISLAND_SETTLEMENTS.find((settlement) => settlement.id === id);
}

export interface CardinalAxes {
  frontX: number;
  frontZ: number;
  rightX: number;
  rightZ: number;
  yaw: number;
}

export function getCardinalAxes(facing: CardinalDirection): CardinalAxes {
  switch (facing) {
    case 'north':
      return { frontX: 0, frontZ: -1, rightX: -1, rightZ: 0, yaw: Math.PI };
    case 'east':
      return { frontX: 1, frontZ: 0, rightX: 0, rightZ: -1, yaw: Math.PI / 2 };
    case 'west':
      return { frontX: -1, frontZ: 0, rightX: 0, rightZ: 1, yaw: -Math.PI / 2 };
    case 'south':
    default:
      return { frontX: 0, frontZ: 1, rightX: 1, rightZ: 0, yaw: 0 };
  }
}

export function buildingLocalToWorld(
  placement: ExpansionBuildingPlacement,
  localX: number,
  localZ: number
): { x: number; z: number } {
  const axes = getCardinalAxes(placement.facing);
  return {
    x: placement.x + axes.rightX * localX + axes.frontX * localZ,
    z: placement.z + axes.rightZ * localX + axes.frontZ * localZ,
  };
}

export function buildingWorldToLocal(
  placement: ExpansionBuildingPlacement,
  worldX: number,
  worldZ: number
): { x: number; z: number } {
  const axes = getCardinalAxes(placement.facing);
  const dx = worldX - placement.x;
  const dz = worldZ - placement.z;
  return {
    x: dx * axes.rightX + dz * axes.rightZ,
    z: dx * axes.frontX + dz * axes.frontZ,
  };
}

export function hasExteriorRoofAccess(placement: ExpansionBuildingPlacement): boolean {
  return (
    placement.roof !== 'gable' &&
    placement.kind !== 'apartment' &&
    placement.kind !== 'barn' &&
    placement.kind !== 'cabin' &&
    placement.kind !== 'highrise'
  );
}

export function footprintFromLocalRect(
  placement: ExpansionBuildingPlacement,
  minLocalX: number,
  maxLocalX: number,
  minLocalZ: number,
  maxLocalZ: number
): AxisAlignedFootprint {
  const corners = [
    buildingLocalToWorld(placement, minLocalX, minLocalZ),
    buildingLocalToWorld(placement, minLocalX, maxLocalZ),
    buildingLocalToWorld(placement, maxLocalX, minLocalZ),
    buildingLocalToWorld(placement, maxLocalX, maxLocalZ),
  ];
  return {
    minX: Math.min(...corners.map((c) => c.x)),
    maxX: Math.max(...corners.map((c) => c.x)),
    minZ: Math.min(...corners.map((c) => c.z)),
    maxZ: Math.max(...corners.map((c) => c.z)),
  };
}

export function getBuildingBodyFootprint(
  placement: ExpansionBuildingPlacement
): AxisAlignedFootprint {
  return footprintFromLocalRect(
    placement,
    -placement.width / 2,
    placement.width / 2,
    -placement.depth / 2,
    placement.depth / 2
  );
}

/** Includes the exterior roof-ramp lane on the building's local right side. */
export function getBuildingFootprint(
  placement: ExpansionBuildingPlacement
): AxisAlignedFootprint {
  if (placement.kind === 'highrise') {
    // Front balconies project 2.15 m; side skybridge decks are elevated and
    // do not reserve ground space beyond the tower body.
    return footprintFromLocalRect(
      placement,
      -placement.width / 2 - 0.35,
      placement.width / 2 + 0.35,
      -placement.depth / 2 - 0.35,
      placement.depth / 2 + 2.55
    );
  }
  const maxLocalX = placement.width / 2 + (hasExteriorRoofAccess(placement) ? 3.1 : 0.35);
  return footprintFromLocalRect(
    placement,
    -placement.width / 2 - 0.35,
    maxLocalX,
    -placement.depth / 2 - 0.35,
    placement.depth / 2 + 0.35
  );
}

export function getLandmarkFootprint(landmark: LandmarkPlacement): AxisAlignedFootprint {
  const halfWidth = landmark.kind === 'dock' || landmark.kind === 'bridge' ? 8.5 : 5.2;
  const halfDepth = landmark.kind === 'dock' || landmark.kind === 'bridge' ? 3.2 : 5.2;
  const swap = landmark.facing === 'east' || landmark.facing === 'west';
  return {
    minX: landmark.x - (swap ? halfDepth : halfWidth),
    maxX: landmark.x + (swap ? halfDepth : halfWidth),
    minZ: landmark.z - (swap ? halfWidth : halfDepth),
    maxZ: landmark.z + (swap ? halfWidth : halfDepth),
  };
}

export function expandFootprint(
  footprint: AxisAlignedFootprint,
  margin: number
): AxisAlignedFootprint {
  return {
    minX: footprint.minX - margin,
    maxX: footprint.maxX + margin,
    minZ: footprint.minZ - margin,
    maxZ: footprint.maxZ + margin,
  };
}

export function footprintsOverlap(
  a: AxisAlignedFootprint,
  b: AxisAlignedFootprint,
  margin: number = 0
): boolean {
  return (
    a.minX - margin < b.maxX &&
    a.maxX + margin > b.minX &&
    a.minZ - margin < b.maxZ &&
    a.maxZ + margin > b.minZ
  );
}

export function isPointInFootprint(
  x: number,
  z: number,
  footprint: AxisAlignedFootprint,
  margin: number = 0
): boolean {
  return (
    x >= footprint.minX - margin &&
    x <= footprint.maxX + margin &&
    z >= footprint.minZ - margin &&
    z <= footprint.maxZ + margin
  );
}

export function distancePointToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= 0.000001) return Math.hypot(px - ax, pz - az);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

export function getRoadDistance(x: number, z: number): number {
  let minDist = Number.POSITIVE_INFINITY;
  for (const segment of ISLAND_ROAD_SEGMENTS) {
    const minSegX = Math.min(segment.fromX, segment.toX) - minDist;
    const maxSegX = Math.max(segment.fromX, segment.toX) + minDist;
    const minSegZ = Math.min(segment.fromZ, segment.toZ) - minDist;
    const maxSegZ = Math.max(segment.fromZ, segment.toZ) + minDist;
    if (x < minSegX || x > maxSegX || z < minSegZ || z > maxSegZ) continue;
    const dist = distancePointToSegment(x, z, segment.fromX, segment.fromZ, segment.toX, segment.toZ);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

function orientation(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

function isPointOnSegment(
  ax: number,
  az: number,
  px: number,
  pz: number,
  bx: number,
  bz: number
): boolean {
  return (
    px >= Math.min(ax, bx) - 0.000001 &&
    px <= Math.max(ax, bx) + 0.000001 &&
    pz >= Math.min(az, bz) - 0.000001 &&
    pz <= Math.max(az, bz) + 0.000001
  );
}

function segmentsIntersect(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number
): boolean {
  const o1 = orientation(ax, az, bx, bz, cx, cz);
  const o2 = orientation(ax, az, bx, bz, dx, dz);
  const o3 = orientation(cx, cz, dx, dz, ax, az);
  const o4 = orientation(cx, cz, dx, dz, bx, bz);
  if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)) return true;
  if (o1 === 0 && isPointOnSegment(ax, az, cx, cz, bx, bz)) return true;
  if (o2 === 0 && isPointOnSegment(ax, az, dx, dz, bx, bz)) return true;
  if (o3 === 0 && isPointOnSegment(cx, cz, ax, az, dx, dz)) return true;
  if (o4 === 0 && isPointOnSegment(cx, cz, bx, bz, dx, dz)) return true;
  return false;
}

function distanceSegmentToSegment(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number
): number {
  if (segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
  return Math.min(
    distancePointToSegment(ax, az, cx, cz, dx, dz),
    distancePointToSegment(bx, bz, cx, cz, dx, dz),
    distancePointToSegment(cx, cz, ax, az, bx, bz),
    distancePointToSegment(dx, dz, ax, az, bx, bz)
  );
}

/** Minimum distance from any road centreline to a rectangular footprint. */
export function getRoadDistanceToFootprint(footprint: AxisAlignedFootprint): number {
  const corners = [
    [footprint.minX, footprint.minZ],
    [footprint.maxX, footprint.minZ],
    [footprint.maxX, footprint.maxZ],
    [footprint.minX, footprint.maxZ],
  ] as const;
  let minDist = Number.POSITIVE_INFINITY;

  for (const road of ISLAND_ROAD_SEGMENTS) {
    if (
      isPointInFootprint(road.fromX, road.fromZ, footprint) ||
      isPointInFootprint(road.toX, road.toZ, footprint)
    ) {
      return 0;
    }
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      const dist = distanceSegmentToSegment(
        a[0],
        a[1],
        b[0],
        b[1],
        road.fromX,
        road.fromZ,
        road.toX,
        road.toZ
      );
      if (dist < minDist) minDist = dist;
    }
  }
  return minDist;
}
