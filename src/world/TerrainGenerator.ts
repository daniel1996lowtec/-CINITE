import * as THREE from 'three';
import { TimeOfDayPreset } from '../network/schemas';
import {
  SKY_DOME_RADIUS,
  STARFIELD_RADIUS,
  SUN_DISTANCE,
  getSunDirection,
  getSurfaceVariation,
} from './VisualAtmosphere';
import {
  EXPANSION_BUILDINGS,
  EXPANSION_LANDMARKS,
  ISLAND_ROAD_SEGMENTS,
  ISLAND_SETTLEMENTS,
  LEGENDARY_TOWER,
  distancePointToSegment,
  getBuildingFootprint,
  getLandmarkFootprint,
} from './WorldLayout';

export interface POIDefinition {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
  baseHeight: number;
  color: string;
}

interface StructureTerrainPad {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  blendWidth: number;
}

export const ISLAND_POIS: POIDefinition[] = [
  {
    id: 'pipeline_plaza',
    name: 'Legendary Tower',
    x: 0,
    z: 0,
    radius: 42,
    baseHeight: 4.5,
    color: '#facc15',
  },
  {
    id: 'docker_docks',
    name: 'Docker Docks',
    x: -105,
    z: 95,
    radius: 34,
    baseHeight: 2.2,
    color: '#fb923c',
  },
  {
    id: 'kubernetes_keep',
    name: 'Kubernetes Keep',
    x: 100,
    z: -95,
    radius: 36,
    baseHeight: 10.5,
    color: '#c084fc',
  },
  {
    id: 'git_grove',
    name: 'Git Grove',
    x: -95,
    z: -85,
    radius: 34,
    baseHeight: 6.2,
    color: '#4ade80',
  },
  {
    id: 'server_silos',
    name: 'Server Silos',
    x: 95,
    z: 90,
    radius: 34,
    baseHeight: 5.5,
    color: '#facc15',
  },
  {
    id: 'mirror_lake',
    name: 'Mirror Lake',
    x: -46,
    z: 38,
    radius: 26,
    baseHeight: 1.2,
    color: '#2dd4bf',
  },
  {
    id: 'frontend_farms',
    name: 'Frontend Farms',
    x: -25,
    z: -118,
    radius: 32,
    baseHeight: 5.0,
    color: '#f87171',
  },
  {
    id: 'legacy_ruins',
    name: 'Legacy Ruins',
    x: 32,
    z: 122,
    radius: 30,
    baseHeight: 4.8,
    color: '#94a3b8',
  },
];

const settlementRoutePoints: POIDefinition[] = ISLAND_SETTLEMENTS.map((settlement) => ({
  id: settlement.id,
  name: settlement.name,
  x: settlement.x,
  z: settlement.z,
  radius: settlement.radius,
  baseHeight: settlement.baseHeight,
  color: settlement.color,
}));

/**
 * Bot patrol/landing route points in a rough geographic loop. This extends,
 * rather than replaces, the eight named POIs: every original POI is still
 * present in ISLAND_POIS and appears exactly once here.
 */
export const ISLAND_ROUTE_POINTS: POIDefinition[] = [
  ISLAND_POIS[0],
  settlementRoutePoints[11],
  ISLAND_POIS[4],
  settlementRoutePoints[9],
  ISLAND_POIS[7],
  settlementRoutePoints[8],
  ISLAND_POIS[1],
  settlementRoutePoints[1],
  ISLAND_POIS[5],
  settlementRoutePoints[0],
  settlementRoutePoints[3],
  ISLAND_POIS[3],
  settlementRoutePoints[2],
  ISLAND_POIS[6],
  settlementRoutePoints[5],
  settlementRoutePoints[4],
  ISLAND_POIS[2],
  settlementRoutePoints[10],
  settlementRoutePoints[6],
  settlementRoutePoints[7],
];

export class TerrainGenerator {
  public readonly worldSize = 540;
  public readonly islandRadius = 230;
  public waterMesh!: THREE.Mesh;
  public shorelineFoamRing!: THREE.Mesh;
  public lakeFoamRing!: THREE.Mesh;
  public lakeInnerRippleRing!: THREE.Mesh;
  public terrainMesh!: THREE.Mesh;
  public cloudsGroup = new THREE.Group();
  public skyGroup = new THREE.Group();
  public distantIslandsGroup = new THREE.Group();
  public starfieldPoints!: THREE.Points;
  public atmosphereMotes!: THREE.Points;
  public skyDome!: THREE.Mesh;
  public sunMesh!: THREE.Mesh;
  public sunHaloMesh!: THREE.Mesh;
  public waterfallMesh!: THREE.Mesh;
  private waterTexture: THREE.CanvasTexture | null = null;
  private waterBumpTexture: THREE.CanvasTexture | null = null;
  private terrainDetailTexture: THREE.CanvasTexture | null = null;
  private time = 0;

  /**
   * Small deterministic pads under expansion structures. POI/settlement
   * plateaus handle district-scale flattening; these footprint pads remove
   * the last local slope so foundations, doors and interior loot never sit
   * above/below the terrain at one corner. Docks and the bridge are excluded
   * because they intentionally stand over water.
   */
  private readonly structureTerrainPads: StructureTerrainPad[] = [
    {
      minX: LEGENDARY_TOWER.x - 19,
      maxX: LEGENDARY_TOWER.x + 19,
      minZ: LEGENDARY_TOWER.z - 19,
      maxZ: LEGENDARY_TOWER.z + 19,
      height: this.getUnpaddedTerrainHeight(LEGENDARY_TOWER.x, LEGENDARY_TOWER.z),
      blendWidth: 5.5,
    },
    ...EXPANSION_BUILDINGS.map((building) => {
      const footprint = getBuildingFootprint(building);
      return {
        minX: footprint.minX - 1.0,
        maxX: footprint.maxX + 1.0,
        minZ: footprint.minZ - 1.0,
        maxZ: footprint.maxZ + 1.0,
        height: this.getUnpaddedTerrainHeight(building.x, building.z),
        blendWidth: 4.2,
      };
    }),
    ...EXPANSION_LANDMARKS.filter(
      (landmark) =>
        landmark.kind === 'watchtower' || landmark.kind === 'camp' || landmark.kind === 'ruin'
    ).map((landmark) => {
      const footprint = getLandmarkFootprint(landmark);
      return {
        minX: footprint.minX - 0.6,
        maxX: footprint.maxX + 0.6,
        minZ: footprint.minZ - 0.6,
        maxZ: footprint.maxZ + 0.6,
        height: this.getUnpaddedTerrainHeight(landmark.x, landmark.z),
        blendWidth: 3.6,
      };
    }),
  ];

  private createTerrainMicroTexture(): THREE.CanvasTexture | null {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#f8f8f3';
    ctx.fillRect(0, 0, 256, 256);

    // Deterministic organic micro-detail. This is a colour multiplier over
    // the existing vertex-colour terrain, so it breaks up beaches, roads,
    // grass, and rock without adding geometry, draw calls, or collision.
    let seed = 48151623;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    for (let i = 0; i < 72; i++) {
      const x = rand() * 256;
      const y = rand() * 256;
      const radius = 10 + rand() * 30;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      const tint =
        i % 3 === 0
          ? 'rgba(15, 23, 42, 0.032)'
          : i % 3 === 1
            ? 'rgba(255, 255, 255, 0.04)'
            : 'rgba(101, 67, 33, 0.028)';
      gradient.addColorStop(0, tint);
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < 2300; i++) {
      const x = rand() * 256;
      const y = rand() * 256;
      const length = 2 + rand() * 5;
      ctx.strokeStyle =
        i % 4 === 0
          ? 'rgba(255, 255, 255, 0.055)'
          : i % 4 === 1
            ? 'rgba(15, 23, 42, 0.05)'
            : i % 4 === 2
              ? 'rgba(22, 101, 52, 0.042)'
              : 'rgba(120, 72, 32, 0.04)';
      ctx.lineWidth = 0.7 + rand() * 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rand() - 0.5) * 2.5, y - length);
      ctx.stroke();
    }

    for (let i = 0; i < 240; i++) {
      ctx.fillStyle =
        i % 2 === 0 ? 'rgba(71, 85, 105, 0.075)' : 'rgba(255, 255, 255, 0.06)';
      ctx.beginPath();
      ctx.arc(rand() * 256, rand() * 256, 0.6 + rand() * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(64, 64);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private createWaterRippleTexture(): THREE.CanvasTexture | null {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const grad = ctx.createLinearGradient(0, 0, 256, 256);
    grad.addColorStop(0, '#bae6fd');
    grad.addColorStop(0.5, '#e0f2fe');
    grad.addColorStop(1, '#bae6fd');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.lineWidth = 2.2;
    for (let y = 12; y < 256; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.quadraticCurveTo(64, y - 8, 128, y);
      ctx.quadraticCurveTo(192, y + 8, 256, y);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
    ctx.lineWidth = 1.5;
    for (let y = 24; y < 256; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.quadraticCurveTo(64, y + 6, 128, y);
      ctx.quadraticCurveTo(192, y - 6, 256, y);
      ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(42, 42);
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private rawNoise(x: number, z: number): number {
    const n1 = Math.sin(x * 0.024) * Math.cos(z * 0.024) * 4.4;
    const n2 = Math.sin(x * 0.058 + 1.4) * Math.sin(z * 0.052 + 0.8) * 2.2;
    const n3 = Math.cos((x + z) * 0.014) * 3.4;
    const n4 = Math.sin(x * 0.11 - z * 0.09) * 0.65;
    const n5 = Math.cos(x * 0.21 + z * 0.19) * 0.25;
    return n1 + n2 + n3 + n4 + n5;
  }

  public getRiverDistance(x: number, z: number): number {
    if (z < 30 || z > 225) return 999;
    const t = (z - 38) / (215 - 38);
    if (t < 0 || t > 1.05) return 999;
    const curveCenterX = -46 + t * 52 + Math.sin(t * Math.PI * 2.2) * 12;
    return Math.abs(x - curveCenterX);
  }

  public getTerrainSlope(x: number, z: number): number {
    const eps = 1.25;
    const hL = this.getTerrainHeight(x - eps, z);
    const hR = this.getTerrainHeight(x + eps, z);
    const hD = this.getTerrainHeight(x, z - eps);
    const hU = this.getTerrainHeight(x, z + eps);
    const dx = (hR - hL) / (2 * eps);
    const dz = (hU - hD) / (2 * eps);
    return Math.hypot(dx, dz);
  }

  private getUnpaddedTerrainHeight(x: number, z: number): number {
    const distFromCenter = Math.hypot(x, z);

    if (distFromCenter > this.islandRadius + 24) {
      return -4.8;
    }

    const normalizedDist = distFromCenter / this.islandRadius;
    let coastMask = 1.0;
    if (normalizedDist > 0.78) {
      const t = Math.min(1, (normalizedDist - 0.78) / 0.28);
      coastMask = 1 - t * t * (3 - 2 * t);
    }

    let baseH = 3.8 + this.rawNoise(x, z);

    // 1. Northern Alpine Mountain Range
    const northMountainDist = Math.hypot((x - 28) * 0.7, z + 158);
    if (northMountainDist < 56) {
      const mt = 1 - northMountainDist / 56;
      baseH +=
        mt * mt * 18.5 +
        Math.abs(Math.sin(x * 0.12) * Math.cos(z * 0.12)) * mt * 3.8;
    }

    // 2. Eastern Rocky Crag Peak
    const eastPeakDist = Math.hypot(x - 160, (z - 5) * 0.75);
    if (eastPeakDist < 46) {
      const et = 1 - eastPeakDist / 46;
      baseH += et * et * 15.5;
    }

    // 3. Western Lookout Hill
    const westHillDist = Math.hypot(x + 155, z + 10);
    if (westHillDist < 40) {
      const wt = 1 - westHillDist / 40;
      baseH += wt * wt * 12.0;
    }

    let height = baseH * coastMask - (1 - coastMask) * 3.4;

    // 4. Blend smooth flat plateaus at named POIs
    for (const poi of ISLAND_POIS) {
      if (poi.id === 'mirror_lake') continue;
      const d = Math.hypot(x - poi.x, z - poi.z);
      if (d < poi.radius * 1.4) {
        const blend =
          d <= poi.radius * 0.75
            ? 1.0
            : 1.0 - (d - poi.radius * 0.75) / (poi.radius * 0.65);
        const smooth = blend * blend * (3 - 2 * blend);
        height = height * (1 - smooth) + poi.baseHeight * smooth;
      }
    }

    // 4b. Secondary settlement plateaus. These use the same smoothstep
    // blend as the named POIs so modular buildings sit on believable,
    // walkable ground without changing the island's macro silhouette.
    for (const settlement of ISLAND_SETTLEMENTS) {
      const dx = x - settlement.x;
      const dz = z - settlement.z;
      const influenceRadius = settlement.radius * 1.35;
      if (Math.abs(dx) > influenceRadius || Math.abs(dz) > influenceRadius) continue;
      const d = Math.hypot(dx, dz);
      if (d < influenceRadius) {
        const innerRadius = settlement.radius * 0.78;
        const blend =
          d <= innerRadius
            ? 1.0
            : 1.0 - (d - innerRadius) / (influenceRadius - innerRadius);
        const smooth = blend * blend * (3 - 2 * blend);
        height = height * (1 - smooth) + settlement.baseHeight * smooth;
      }
    }

    // 5. Mirror Lake Basin at (-46, 38) with central treasure islet
    const lakeDist = Math.hypot(x - -46, z - 38);
    if (lakeDist < 30) {
      if (lakeDist < 5.8) {
        const it = 1 - lakeDist / 5.8;
        height = -0.5 + it * 1.75;
      } else if (lakeDist < 22) {
        height = -1.65;
      } else {
        const st = (lakeDist - 22) / 8;
        const smooth = st * st * (3 - 2 * st);
        height = -1.65 * (1 - smooth) + height * smooth;
      }
    }

    // 6. Winding River Channel
    const riverDist = this.getRiverDistance(x, z);
    if (riverDist < 9.5 && lakeDist >= 18) {
      if (riverDist < 4.2) {
        height = Math.min(height, -1.25);
      } else {
        const rt = (riverDist - 4.2) / 5.3;
        const smooth = rt * rt * (3 - 2 * rt);
        height = Math.min(height, -1.25 * (1 - smooth) + height * smooth);
      }
    }

    return height;
  }

  public getTerrainHeight(x: number, z: number): number {
    const height = this.getUnpaddedTerrainHeight(x, z);

    // Never let a structure pad fill the lake or river channel.
    if (Math.hypot(x + 46, z - 38) < 27 || this.getRiverDistance(x, z) < 7) {
      return height;
    }

    let bestBlend = 0;
    let bestHeight = height;
    for (const pad of this.structureTerrainPads) {
      if (
        x < pad.minX - pad.blendWidth ||
        x > pad.maxX + pad.blendWidth ||
        z < pad.minZ - pad.blendWidth ||
        z > pad.maxZ + pad.blendWidth
      ) {
        continue;
      }
      const outsideX = Math.max(pad.minX - x, 0, x - pad.maxX);
      const outsideZ = Math.max(pad.minZ - z, 0, z - pad.maxZ);
      const outside = Math.max(outsideX, outsideZ);
      const blend = outside <= 0 ? 1 : Math.max(0, 1 - outside / pad.blendWidth);
      const smooth = blend * blend * (3 - 2 * blend);
      if (smooth > bestBlend) {
        bestBlend = smooth;
        bestHeight = pad.height;
      }
    }

    return height * (1 - bestBlend) + bestHeight * bestBlend;
  }

  public getRoadDistance(x: number, z: number): number {
    let minDist = 999;
    for (const segment of ISLAND_ROAD_SEGMENTS) {
      // Cheap axis-aligned rejection keeps terrain generation fast while
      // preserving exact point-to-segment distance for nearby roads.
      if (
        x < Math.min(segment.fromX, segment.toX) - minDist ||
        x > Math.max(segment.fromX, segment.toX) + minDist ||
        z < Math.min(segment.fromZ, segment.toZ) - minDist ||
        z > Math.max(segment.fromZ, segment.toZ) + minDist
      ) {
        continue;
      }
      const dist = distancePointToSegment(
        x,
        z,
        segment.fromX,
        segment.fromZ,
        segment.toX,
        segment.toZ
      );
      if (dist < minDist) minDist = dist;
    }
    return minDist;
  }

  public isOnRoad(x: number, z: number): boolean {
    return this.getRoadDistance(x, z) < 3.9;
  }

  public buildTerrain(scene: THREE.Scene): void {
    const segments = 208;
    const geo = new THREE.PlaneGeometry(this.worldSize, this.worldSize, segments, segments);
    geo.rotateX(-Math.PI / 2);

    const posAttr = geo.attributes.position;
    const colors: number[] = [];
    const color = new THREE.Color();
    const cliffRockColor = new THREE.Color(0x64748b);
    const dirtShoulderColor = new THREE.Color(0xb48a5a);

    for (let i = 0; i < posAttr.count; i++) {
      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);
      const vy = this.getTerrainHeight(vx, vz);
      posAttr.setY(i, vy);

      const distCenter = Math.hypot(vx, vz);
      const distGitGrove = Math.hypot(vx - -95, vz - -85);
      const distFarm = Math.hypot(vx - -25, vz - -118);
      const distRuins = Math.hypot(vx - 32, vz - 122);
      const distKeep = Math.hypot(vx - 100, vz - -95);
      const distSilos = Math.hypot(vx - 95, vz - 90);
      const distDocks = Math.hypot(vx - -105, vz - 95);
      const roadDist = this.getRoadDistance(vx, vz);
      const riverDist = this.getRiverDistance(vx, vz);
      const lakeDist = Math.hypot(vx - -46, vz - 38);
      const slope = this.getTerrainSlope(vx, vz);
      let expansionSettlement: (typeof ISLAND_SETTLEMENTS)[number] | null = null;
      for (const settlement of ISLAND_SETTLEMENTS) {
        const sdx = vx - settlement.x;
        const sdz = vz - settlement.z;
        const coreRadius = settlement.radius * 0.78;
        if (sdx * sdx + sdz * sdz < coreRadius * coreRadius) {
          expansionSettlement = settlement;
          break;
        }
      }

      if (vy < -0.35) {
        // Deep seabed & riverbed
        color.setHex(0x0369a1);
      } else if (vy < 0.42) {
        // Wet shoreline sand
        color.setHex(0xd97706);
      } else if (
        vy < 1.85 ||
        distCenter > this.islandRadius * 0.88 ||
        (riverDist < 6.4 && vy < 2.5) ||
        (lakeDist > 20 && lakeDist < 26.5 && vy < 2.6)
      ) {
        // Warm golden beach sand & riverbank pebble-sand
        const sandCheck = (Math.floor(vx * 0.25) + Math.floor(vz * 0.25)) % 2 === 0;
        color.setHex(sandCheck ? 0xfde047 : 0xfacc15);
      } else if (Math.hypot(vx, vz) < 30) {
        // Pipeline Plaza paved town square tiles with cyan/slate accents
        const tile = (Math.floor(vx * 0.35) + Math.floor(vz * 0.35)) % 2 === 0;
        color.setHex(tile ? 0x94a3b8 : 0xcbd5e1);
      } else if (roadDist < 3.6) {
        // Navigable cobblestone & compacted dirt road
        const cobble = (Math.floor(vx * 0.55) + Math.floor(vz * 0.55)) % 2 === 0;
        color.setHex(cobble ? 0xc29b61 : 0xd6b07a);
      } else if (roadDist < 4.9) {
        // Soft dirt road shoulder transition
        color.copy(dirtShoulderColor);
      } else if (expansionSettlement) {
        // Handcrafted ground treatments make secondary settlements readable
        // from the drop ship without adding extra terrain meshes.
        const checker = (Math.floor(vx * 0.32) + Math.floor(vz * 0.32)) % 2 === 0;
        switch (expansionSettlement.ground) {
          case 'paved':
            color.setHex(checker ? 0x94a3b8 : 0xb6c2d2);
            break;
          case 'industrial':
            color.setHex(checker ? 0x78716c : 0x8b8580);
            break;
          case 'farm':
            color.setHex(Math.sin(vz * 1.25) > 0 ? 0xa16207 : 0x65a30d);
            break;
          case 'sand':
            color.setHex(checker ? 0xfacc15 : 0xfde047);
            break;
          case 'alpine':
            color.setHex(checker ? 0xcbd5e1 : 0xe2e8f0);
            break;
          case 'dirt':
          default:
            color.setHex(checker ? 0xb48a5a : 0xc29b61);
            break;
        }
      } else if (distKeep < 25) {
        const keepTile = (Math.floor(vx * 0.3) + Math.floor(vz * 0.3)) % 2 === 0;
        color.setHex(keepTile ? 0x64748b : 0x475569);
      } else if (distSilos < 22) {
        color.setHex(0x64748b);
      } else if (distDocks < 22) {
        color.setHex(0xa8a29e);
      } else if (distRuins < 23) {
        color.setHex(0x84a98c);
      } else if (distFarm < 25 && Math.sin(vx * 1.4) > 0) {
        color.setHex(0xeab308);
      } else if (vy > 16.0) {
        // Alpine snow cap
        color.setHex(0xf8fafc);
      } else if (vy > 10.6) {
        // High mountain rock
        color.setHex(0x64748b);
      } else if (distGitGrove < 38) {
        // Lush emerald forest floor
        const checker = (Math.floor(vx * 0.09) + Math.floor(vz * 0.09)) % 2 === 0;
        color.setHex(checker ? 0x16a34a : 0x15803d);
      } else if (vy > 7.2) {
        // Highland meadow grass
        color.setHex(0x22c55e);
      } else {
        // Vibrant stylized lowland meadow grass
        const checker = (Math.floor(vx * 0.08) + Math.floor(vz * 0.08)) % 2 === 0;
        color.setHex(checker ? 0x4ade80 : 0x34d399);
      }

      // Slope-based cliff & escarpment rock blending on steep terrain
      if (vy > 1.8 && vy < 15.8 && slope > 0.46) {
        const rockWeight = Math.min(1, (slope - 0.46) / 0.42);
        color.lerp(cliffRockColor, rockWeight * 0.85);
      }

      // Smooth, deterministic tonal variation softens the intentionally
      // readable biome/checker colours at landscape scale. Heights and all
      // gameplay placement remain untouched.
      color.offsetHSL(0, 0, getSurfaceVariation(vx, vz) * 0.024);

      colors.push(color.r, color.g, color.b);
    }

    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    this.terrainDetailTexture = this.createTerrainMicroTexture();
    const terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: this.terrainDetailTexture,
      flatShading: true,
      roughness: 0.84,
      metalness: 0.0,
    });

    this.terrainMesh = new THREE.Mesh(geo, terrainMat);
    this.terrainMesh.receiveShadow = true;
    scene.add(this.terrainMesh);

    // Stylized Ocean, Mirror Lake & Winding River Water Plane with Specular Shimmer
    const waterGeo = new THREE.PlaneGeometry(1600, 1600, 64, 64);
    waterGeo.rotateX(-Math.PI / 2);
    this.waterTexture = this.createWaterRippleTexture();
    this.waterBumpTexture = this.waterTexture?.clone() ?? null;
    if (this.waterBumpTexture) {
      this.waterBumpTexture.colorSpace = THREE.NoColorSpace;
      this.waterBumpTexture.needsUpdate = true;
    }
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x0799d8,
      map: this.waterTexture,
      bumpMap: this.waterBumpTexture,
      bumpScale: 0.18,
      emissive: 0x0369a1,
      emissiveIntensity: 0.16,
      roughness: 0.08,
      metalness: 0.02,
      transparent: true,
      opacity: 0.9,
      flatShading: true,
    });
    this.waterMesh = new THREE.Mesh(waterGeo, waterMat);
    this.waterMesh.position.y = -0.28;
    this.waterMesh.receiveShadow = true;
    scene.add(this.waterMesh);

    // Animated Shoreline Foam Rings (Coastline, Mirror Lake Perimeter & Central Islet)
    const foamMat = new THREE.MeshBasicMaterial({
      color: 0xe0f2fe,
      transparent: true,
      opacity: 0.46,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.shorelineFoamRing = new THREE.Mesh(
      new THREE.RingGeometry(this.islandRadius - 6, this.islandRadius + 1.5, 96),
      foamMat
    );
    this.shorelineFoamRing.rotation.x = -Math.PI / 2;
    this.shorelineFoamRing.position.y = -0.18;
    scene.add(this.shorelineFoamRing);

    this.lakeFoamRing = new THREE.Mesh(new THREE.RingGeometry(20.5, 22.8, 48), foamMat);
    this.lakeFoamRing.rotation.x = -Math.PI / 2;
    this.lakeFoamRing.position.set(-46, -0.16, 38);
    scene.add(this.lakeFoamRing);

    this.lakeInnerRippleRing = new THREE.Mesh(
      new THREE.RingGeometry(5.6, 6.8, 32),
      foamMat
    );
    this.lakeInnerRippleRing.rotation.x = -Math.PI / 2;
    this.lakeInnerRippleRing.position.set(-46, -0.15, 38);
    scene.add(this.lakeInnerRippleRing);

    // Alpine Waterfall cascading down the Northern Mountain Peak (28, -142)
    const wfMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.48,
      transparent: true,
      opacity: 0.86,
      flatShading: true,
    });
    this.waterfallMesh = new THREE.Mesh(new THREE.BoxGeometry(5.2, 16.5, 1.4), wfMat);
    this.waterfallMesh.position.set(28, 11.2, -138);
    this.waterfallMesh.rotation.x = 0.28;
    scene.add(this.waterfallMesh);

    const wfPool = new THREE.Mesh(
      new THREE.CylinderGeometry(5.5, 6.2, 0.4, 16),
      foamMat
    );
    wfPool.position.set(28, 4.2, -133);
    scene.add(wfPool);

    this.buildAtmosphericSky(scene);
    this.buildDistantSceneryIslands(scene);
    this.buildAtmosphereMotes(scene);
  }

  private buildAtmosphericSky(scene: THREE.Scene): void {
    this.skyGroup.name = 'CameraCentredSky';
    scene.add(this.skyGroup);

    const skyGeo = new THREE.SphereGeometry(SKY_DOME_RADIUS, 40, 24);
    const pos = skyGeo.attributes.position;
    const skyColors: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      skyColors.push(0.2, 0.7, 0.98);
    }
    skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(skyColors, 3));

    const skyMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.skyDome = new THREE.Mesh(skyGeo, skyMat);
    this.skyDome.name = 'AtmosphericSkyDome';
    this.skyDome.frustumCulled = false;
    this.skyDome.renderOrder = -100;
    this.skyGroup.add(this.skyDome);

    // Starfield Dome (visible at Sunset & Night). A fixed seed keeps world
    // generation deterministic and the camera-centred radius keeps stars in
    // front of the far plane on Low as well as High.
    const starCount = 450;
    const starPositions = new Float32Array(starCount * 3);
    let starSeed = 24681357;
    const starRand = (): number => {
      starSeed = (starSeed * 1664525 + 1013904223) >>> 0;
      return starSeed / 4294967296;
    };
    for (let i = 0; i < starCount; i++) {
      const theta = starRand() * Math.PI * 2;
      const phi = Math.acos(1 - starRand() * 0.92);
      starPositions[i * 3] = STARFIELD_RADIUS * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = STARFIELD_RADIUS * Math.cos(phi);
      starPositions[i * 3 + 2] = STARFIELD_RADIUS * Math.sin(phi) * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xf8fafc,
      size: 1.15,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      fog: false,
    });
    this.starfieldPoints = new THREE.Points(starGeo, starMat);
    this.starfieldPoints.name = 'AtmosphericStarfield';
    this.starfieldPoints.frustumCulled = false;
    this.starfieldPoints.renderOrder = -99;
    this.skyGroup.add(this.starfieldPoints);

    // Sun Disc + Glowing Corona Halo, positioned by applyTimeOfDaySky on
    // the same directional-light vector used for scene shadows.
    const sunGeo = new THREE.CircleGeometry(13, 28);
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xfef08a,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.sunMesh = new THREE.Mesh(sunGeo, sunMat);
    this.sunMesh.name = 'AtmosphericSun';
    this.sunMesh.frustumCulled = false;
    this.sunMesh.renderOrder = -98;
    this.skyGroup.add(this.sunMesh);

    const haloGeo = new THREE.RingGeometry(13.4, 26, 28);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xfde047,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      fog: false,
    });
    this.sunHaloMesh = new THREE.Mesh(haloGeo, haloMat);
    this.sunHaloMesh.name = 'AtmosphericSunHalo';
    this.sunHaloMesh.frustumCulled = false;
    this.sunHaloMesh.renderOrder = -98;
    this.skyGroup.add(this.sunHaloMesh);

    this.applyTimeOfDaySky('day');

    const cloudMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xe0f2fe,
      emissiveIntensity: 0.25,
      flatShading: true,
      roughness: 0.9,
    });

    for (let i = 0; i < 20; i++) {
      const cluster = new THREE.Group();
      const puffs = 3 + (i % 3);
      for (let p = 0; p < puffs; p++) {
        const puff = new THREE.Mesh(
          new THREE.DodecahedronGeometry(6 + (p % 2) * 3.5, 0),
          cloudMat
        );
        puff.position.set((p - 1.2) * 6.5, (p % 2) * 1.8, (p % 3 - 1) * 2.5);
        puff.scale.set(1.35, 0.65, 1.0);
        cluster.add(puff);
      }

      const angle = (i / 20) * Math.PI * 2;
      const dist = 75 + (i % 4) * 55;
      cluster.position.set(
        Math.cos(angle) * dist,
        82 + (i % 3) * 14,
        Math.sin(angle) * dist
      );
      cluster.userData.baseY = cluster.position.y;
      cluster.rotation.y = angle;
      this.cloudsGroup.add(cluster);
    }

    scene.add(this.cloudsGroup);
  }

  /**
   * Builds floating atmospheric pollen / light motes across the island for depth & ambiance
   */
  private buildAtmosphereMotes(scene: THREE.Scene): void {
    const moteCount = 260;
    const positions = new Float32Array(moteCount * 3);
    for (let i = 0; i < moteCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 195;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = 2 + Math.random() * 24;
      positions[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xfef9c3,
      size: 0.45,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.atmosphereMotes = new THREE.Points(geo, mat);
    scene.add(this.atmosphereMotes);
  }

  private buildDistantSceneryIslands(scene: THREE.Scene): void {
    const distantMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      flatShading: true,
      roughness: 0.92,
    });
    const snowCapMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      flatShading: true,
      roughness: 0.8,
    });

    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + 0.3;
      const dist = 340 + (i % 3) * 38;
      const ix = Math.cos(angle) * dist;
      const iz = Math.sin(angle) * dist;
      const h = 38 + (i % 3) * 18;
      const r = 42 + (i % 2) * 16;

      const peak = new THREE.Mesh(new THREE.ConeGeometry(r, h, 6), distantMat);
      peak.position.set(ix, h / 2 - 4, iz);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.42, h * 0.42, 6), snowCapMat);
      cap.position.set(ix, h * 0.78 - 4, iz);
      this.distantIslandsGroup.add(peak, cap);
    }
    scene.add(this.distantIslandsGroup);
  }

  public applyTimeOfDaySky(preset: TimeOfDayPreset): void {
    if (!this.skyDome) return;
    const pos = this.skyDome.geometry.attributes.position;
    const colAttr = this.skyDome.geometry.attributes.color as THREE.BufferAttribute;

    const cZenith = new THREE.Color(
      preset === 'day' ? 0x0284c7 : preset === 'sunset' ? 0x311042 : 0x020617
    );
    const cMid = new THREE.Color(
      preset === 'day' ? 0x38bdf8 : preset === 'sunset' ? 0xc026d3 : 0x0f172a
    );
    const cHorizon = new THREE.Color(
      preset === 'day' ? 0xbae6fd : preset === 'sunset' ? 0xf97316 : 0x1e293b
    );
    const cGround = new THREE.Color(
      preset === 'day' ? 0x365314 : preset === 'sunset' ? 0x451a03 : 0x020617
    );
    const cSunGlow = new THREE.Color(
      preset === 'day' ? 0xfef3c7 : preset === 'sunset' ? 0xffd9a0 : 0xbfdbfe
    );
    const sunDirection = getSunDirection(preset);
    const sunHorizontalLength = Math.hypot(sunDirection.x, sunDirection.z) || 1;
    const sunAzimuthX = sunDirection.x / sunHorizontalLength;
    const sunAzimuthZ = sunDirection.z / sunHorizontalLength;
    const sunGlowStrength =
      preset === 'sunset' ? 0.42 : preset === 'day' ? 0.18 : 0.06;
    const tmp = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const elevation = THREE.MathUtils.clamp(y / SKY_DOME_RADIUS, -1, 1);
      if (elevation >= 0.28) {
        tmp.lerpColors(cMid, cZenith, (elevation - 0.28) / 0.72);
      } else if (elevation >= 0) {
        tmp.lerpColors(cHorizon, cMid, elevation / 0.28);
      } else {
        tmp.lerpColors(cHorizon, cGround, Math.min(1, -elevation / 0.42));
      }

      // A broad sun-side atmospheric glow ties the visible sun, directional
      // light, and horizon together without a post-processing pass.
      const horizontalLength = Math.hypot(x, z) || 1;
      const azimuthDot = Math.max(
        0,
        (x / horizontalLength) * sunAzimuthX +
          (z / horizontalLength) * sunAzimuthZ
      );
      const horizonBand = Math.max(0, 1 - Math.abs(elevation + 0.03) / 0.48);
      tmp.lerp(
        cSunGlow,
        Math.pow(azimuthDot, 3) * horizonBand * sunGlowStrength
      );
      colAttr.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    colAttr.needsUpdate = true;

    if (this.starfieldPoints) {
      const starMat = this.starfieldPoints.material as THREE.PointsMaterial;
      starMat.opacity = preset === 'night' ? 0.92 : preset === 'sunset' ? 0.42 : 0.0;
    }

    if (this.sunMesh) {
      const sunMat = this.sunMesh.material as THREE.MeshBasicMaterial;
      sunMat.color.setHex(
        preset === 'day' ? 0xfef08a : preset === 'sunset' ? 0xfb923c : 0xe2e8f0
      );
      const sunPosition = new THREE.Vector3(
        sunDirection.x,
        sunDirection.y,
        sunDirection.z
      ).multiplyScalar(SUN_DISTANCE);
      const facing = sunPosition.clone().multiplyScalar(-1).normalize();
      const orientation = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        facing
      );
      this.sunMesh.position.copy(sunPosition);
      this.sunMesh.quaternion.copy(orientation);
      if (this.sunHaloMesh) {
        const haloMat = this.sunHaloMesh.material as THREE.MeshBasicMaterial;
        haloMat.color.setHex(
          preset === 'day' ? 0xfde047 : preset === 'sunset' ? 0xfb923c : 0x93c5fd
        );
        haloMat.opacity = preset === 'sunset' ? 0.32 : 0.22;
        this.sunHaloMesh.position.copy(sunPosition);
        this.sunHaloMesh.quaternion.copy(orientation);
      }
    }
  }

  public update(dt: number, cameraPosition?: THREE.Vector3): void {
    this.time += dt;
    if (cameraPosition) {
      // Sky, sun, and stars are directional backdrop elements. Following the
      // camera prevents parallax/clipping as the player crosses the island.
      this.skyGroup.position.copy(cameraPosition);
    }
    if (this.waterMesh) {
      this.waterMesh.position.y = -0.28 + Math.sin(this.time * 1.8) * 0.12;
      if (this.waterTexture) {
        this.waterTexture.offset.x = (this.time * 0.032) % 1;
        this.waterTexture.offset.y = (this.time * 0.02) % 1;
      }
      if (this.waterBumpTexture) {
        this.waterBumpTexture.offset.x = (this.time * 0.032) % 1;
        this.waterBumpTexture.offset.y = (this.time * 0.02) % 1;
      }
    }
    if (this.shorelineFoamRing) {
      const s = 1 + Math.sin(this.time * 2.1) * 0.008;
      this.shorelineFoamRing.scale.set(s, s, 1);
    }
    if (this.lakeFoamRing) {
      const ls = 1 + Math.cos(this.time * 2.4) * 0.015;
      this.lakeFoamRing.scale.set(ls, ls, 1);
    }
    if (this.lakeInnerRippleRing) {
      const irs = 1 + Math.sin(this.time * 2.8) * 0.03;
      this.lakeInnerRippleRing.scale.set(irs, irs, 1);
    }
    if (this.cloudsGroup && this.cloudsGroup.visible) {
      this.cloudsGroup.rotation.y += dt * 0.006;
      for (let i = 0; i < this.cloudsGroup.children.length; i++) {
        const cluster = this.cloudsGroup.children[i];
        const baseY = typeof cluster.userData.baseY === 'number'
          ? cluster.userData.baseY
          : cluster.position.y;
        cluster.position.y = baseY + Math.sin(this.time * 0.16 + i * 0.73) * 1.15;
      }
    }
    if (this.atmosphereMotes) {
      this.atmosphereMotes.rotation.y += dt * 0.015;
      this.atmosphereMotes.position.y = Math.sin(this.time * 0.9) * 0.45;
    }
    if (this.waterfallMesh) {
      const wfMat = this.waterfallMesh.material as THREE.MeshStandardMaterial;
      wfMat.emissiveIntensity = 0.42 + Math.sin(this.time * 9.0) * 0.14;
    }
  }
}
