import * as THREE from 'three';
import type {
  BoxCollider,
  CylinderCollider,
  IslandWorld,
  WalkableSurface,
} from './IslandWorld';
import { ISLAND_POIS } from './TerrainGenerator';
import type {
  AxisAlignedFootprint,
  CardinalDirection,
  ExpansionBuildingPlacement,
  LandmarkPlacement,
} from './WorldLayout';
import {
  EXISTING_MAJOR_FOOTPRINTS,
  EXPANSION_BUILDINGS,
  EXPANSION_LANDMARKS,
  FOREST_CLUSTERS,
  ISLAND_ROAD_SEGMENTS,
  ISLAND_SETTLEMENTS,
  buildingLocalToWorld,
  buildingWorldToLocal,
  expandFootprint,
  footprintFromLocalRect,
  getBuildingBodyFootprint,
  getBuildingFootprint,
  getCardinalAxes,
  getLandmarkFootprint,
  hasExteriorRoofAccess,
  isPointInFootprint,
} from './WorldLayout';

type ArchitectureShape = 'box' | 'glass' | 'cone' | 'cylinder' | 'glow';
type ArchitectureTier = 'essential' | 'detail';

interface InstanceSpec {
  matrix: THREE.Matrix4;
  color: THREE.Color;
}

interface LocalFrame {
  x: number;
  z: number;
  facing: CardinalDirection;
}

interface ShapeOptions {
  shape?: ArchitectureShape;
  tier?: ArchitectureTier;
  rotationX?: number;
  rotationY?: number;
  rotationZ?: number;
}

const ARCHITECTURE_SHAPES: ArchitectureShape[] = ['box', 'glass', 'cone', 'cylinder', 'glow'];

/**
 * Builds the additive island districts around the original IslandWorld.
 *
 * Architecture is collected as shared unit-geometry instances partitioned by
 * district. That gives the map dozens of enterable buildings for a few dozen
 * instanced draw calls instead of thousands of individual meshes, while the
 * existing IslandWorld AABB/cylinder/walkable systems remain authoritative
 * for collision, bullets, harvesting props, building and bot navigation.
 */
export class MapExpansionBuilder {
  public readonly expansionGroup = new THREE.Group();
  public readonly expansionDetailGroup = new THREE.Group();
  public readonly detailFoliageGroup = new THREE.Group();

  private readonly world: IslandWorld;
  private readonly instances = new Map<string, InstanceSpec[]>();
  private readonly dummy = new THREE.Object3D();
  private readonly childDummy = new THREE.Object3D();
  private architectureFinalized = false;

  private readonly buildingFootprints = EXPANSION_BUILDINGS.map((building) =>
    getBuildingFootprint(building)
  );
  private readonly buildingBodyFootprints = EXPANSION_BUILDINGS.map((building) =>
    getBuildingBodyFootprint(building)
  );
  private readonly landmarkFootprints = EXPANSION_LANDMARKS.map((landmark) =>
    getLandmarkFootprint(landmark)
  );

  constructor(world: IslandWorld, scene: THREE.Scene) {
    this.world = world;
    this.expansionGroup.name = 'MapExpansionArchitecture';
    this.expansionDetailGroup.name = 'MapExpansionDetail';
    this.detailFoliageGroup.name = 'MapExpansionDetailFoliage';
    scene.add(this.expansionGroup, this.expansionDetailGroup, this.detailFoliageGroup);
  }

  public buildDistricts(): void {
    for (const placement of EXPANSION_BUILDINGS) {
      this.createBuilding(placement);
    }
    this.buildSettlementInfrastructure();
    for (const landmark of EXPANSION_LANDMARKS) {
      this.createLandmark(landmark);
    }
    this.buildFarmFields();
  }

  /** True when a point is inside any new/existing major structure footprint. */
  public isInsideStructure(x: number, z: number, margin: number = 0): boolean {
    for (const footprint of this.buildingFootprints) {
      if (isPointInFootprint(x, z, footprint, margin)) return true;
    }
    for (const footprint of this.landmarkFootprints) {
      if (isPointInFootprint(x, z, footprint, margin)) return true;
    }
    for (const footprint of EXISTING_MAJOR_FOOTPRINTS) {
      if (isPointInFootprint(x, z, footprint, margin)) return true;
    }
    return false;
  }

  private stableHash01(text: string): number {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    }
    return (hash >>> 0) / 4294967295;
  }

  private addInstance(
    shape: ArchitectureShape,
    districtId: string,
    matrix: THREE.Matrix4,
    colorHex: number,
    tier: ArchitectureTier
  ): void {
    const key = `${districtId}|${shape}|${tier}`;
    let list = this.instances.get(key);
    if (!list) {
      list = [];
      this.instances.set(key, list);
    }
    list.push({ matrix: matrix.clone(), color: new THREE.Color(colorHex) });
  }

  private addShapeWorld(
    districtId: string,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    colorHex: number,
    options: ShapeOptions & { yaw?: number } = {}
  ): void {
    this.dummy.position.set(x, y, z);
    this.dummy.rotation.set(
      options.rotationX ?? 0,
      (options.yaw ?? 0) + (options.rotationY ?? 0),
      options.rotationZ ?? 0
    );
    this.dummy.scale.set(sx, sy, sz);
    this.dummy.updateMatrix();
    this.addInstance(
      options.shape ?? 'box',
      districtId,
      this.dummy.matrix,
      colorHex,
      options.tier ?? 'essential'
    );
  }

  private addBuildingShape(
    placement: ExpansionBuildingPlacement,
    baseY: number,
    lx: number,
    ly: number,
    lz: number,
    sx: number,
    sy: number,
    sz: number,
    colorHex: number,
    options: ShapeOptions = {}
  ): void {
    const axes = getCardinalAxes(placement.facing);
    this.dummy.position.set(placement.x, baseY, placement.z);
    this.dummy.rotation.set(0, axes.yaw, 0);
    this.dummy.scale.setScalar(1);
    this.dummy.updateMatrix();

    this.childDummy.position.set(lx, ly, lz);
    this.childDummy.rotation.set(
      options.rotationX ?? 0,
      options.rotationY ?? 0,
      options.rotationZ ?? 0
    );
    this.childDummy.scale.set(sx, sy, sz);
    this.childDummy.updateMatrix();
    this.childDummy.matrix.premultiply(this.dummy.matrix);

    this.addInstance(
      options.shape ?? 'box',
      placement.districtId,
      this.childDummy.matrix,
      colorHex,
      options.tier ?? 'essential'
    );
  }

  private addBuildingCollider(
    placement: ExpansionBuildingPlacement,
    baseY: number,
    suffix: string,
    lx: number,
    ly: number,
    lz: number,
    sx: number,
    sy: number,
    sz: number
  ): void {
    const centre = buildingLocalToWorld(placement, lx, lz);
    const swap = placement.facing === 'east' || placement.facing === 'west';
    const worldSx = swap ? sz : sx;
    const worldSz = swap ? sx : sz;
    const collider: BoxCollider = {
      id: `expansion_${placement.id}_${suffix}`,
      minX: centre.x - worldSx / 2,
      maxX: centre.x + worldSx / 2,
      minY: baseY + ly - sy / 2,
      maxY: baseY + ly + sy / 2,
      minZ: centre.z - worldSz / 2,
      maxZ: centre.z + worldSz / 2,
    };
    this.world.boxColliders.push(collider);
  }

  private addBuildingWalkable(
    placement: ExpansionBuildingPlacement,
    baseY: number,
    suffix: string,
    minLocalX: number,
    maxLocalX: number,
    minLocalZ: number,
    maxLocalZ: number,
    heightAtLocal: (localX: number, localZ: number) => number
  ): void {
    const footprint = footprintFromLocalRect(
      placement,
      minLocalX,
      maxLocalX,
      minLocalZ,
      maxLocalZ
    );
    const surface: WalkableSurface = {
      id: `expansion_${placement.id}_${suffix}`,
      ...footprint,
      getHeight: (worldX: number, worldZ: number) => {
        const local = buildingWorldToLocal(placement, worldX, worldZ);
        return baseY + heightAtLocal(local.x, local.z);
      },
    };
    this.world.walkableSurfaces.push(surface);
  }

  private addWorldBoxCollider(
    id: string,
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number
  ): void {
    this.world.boxColliders.push({
      id,
      minX: cx - sx / 2,
      maxX: cx + sx / 2,
      minY: cy - sy / 2,
      maxY: cy + sy / 2,
      minZ: cz - sz / 2,
      maxZ: cz + sz / 2,
    });
  }

  private addWorldCylinderCollider(
    id: string,
    x: number,
    z: number,
    radius: number,
    minY: number,
    maxY: number
  ): void {
    const collider: CylinderCollider = { id, x, z, radius, minY, maxY };
    this.world.cylinderColliders.push(collider);
  }

  private addWorldWalkable(
    id: string,
    footprint: AxisAlignedFootprint,
    height: number
  ): void {
    this.world.walkableSurfaces.push({
      id,
      ...footprint,
      getHeight: () => height,
    });
  }

  private frameLocalToWorld(
    frame: LocalFrame,
    localX: number,
    localZ: number
  ): { x: number; z: number } {
    const axes = getCardinalAxes(frame.facing);
    return {
      x: frame.x + axes.rightX * localX + axes.frontX * localZ,
      z: frame.z + axes.rightZ * localX + axes.frontZ * localZ,
    };
  }

  private addFrameShape(
    districtId: string,
    frame: LocalFrame,
    baseY: number,
    lx: number,
    ly: number,
    lz: number,
    sx: number,
    sy: number,
    sz: number,
    colorHex: number,
    options: ShapeOptions = {}
  ): void {
    const axes = getCardinalAxes(frame.facing);
    this.dummy.position.set(frame.x, baseY, frame.z);
    this.dummy.rotation.set(0, axes.yaw, 0);
    this.dummy.scale.setScalar(1);
    this.dummy.updateMatrix();

    this.childDummy.position.set(lx, ly, lz);
    this.childDummy.rotation.set(
      options.rotationX ?? 0,
      options.rotationY ?? 0,
      options.rotationZ ?? 0
    );
    this.childDummy.scale.set(sx, sy, sz);
    this.childDummy.updateMatrix();
    this.childDummy.matrix.premultiply(this.dummy.matrix);
    this.addInstance(
      options.shape ?? 'box',
      districtId,
      this.childDummy.matrix,
      colorHex,
      options.tier ?? 'essential'
    );
  }

  private addFrameWalkable(
    id: string,
    frame: LocalFrame,
    baseY: number,
    minLocalX: number,
    maxLocalX: number,
    minLocalZ: number,
    maxLocalZ: number,
    heightAtLocal: (localX: number, localZ: number) => number
  ): void {
    const corners = [
      this.frameLocalToWorld(frame, minLocalX, minLocalZ),
      this.frameLocalToWorld(frame, minLocalX, maxLocalZ),
      this.frameLocalToWorld(frame, maxLocalX, minLocalZ),
      this.frameLocalToWorld(frame, maxLocalX, maxLocalZ),
    ];
    const axes = getCardinalAxes(frame.facing);
    this.world.walkableSurfaces.push({
      id,
      minX: Math.min(...corners.map((c) => c.x)),
      maxX: Math.max(...corners.map((c) => c.x)),
      minZ: Math.min(...corners.map((c) => c.z)),
      maxZ: Math.max(...corners.map((c) => c.z)),
      getHeight: (worldX: number, worldZ: number) => {
        const dx = worldX - frame.x;
        const dz = worldZ - frame.z;
        const localX = dx * axes.rightX + dz * axes.rightZ;
        const localZ = dx * axes.frontX + dz * axes.frontZ;
        return baseY + heightAtLocal(localX, localZ);
      },
    });
  }

  private createBuilding(placement: ExpansionBuildingPlacement): void {
    const baseY = this.world.terrain.getTerrainHeight(placement.x, placement.z);
    const hw = placement.width / 2;
    const hd = placement.depth / 2;
    const wallT = 0.42;
    const floorTop = 0.36;
    const concrete = 0x94a3b8;
    const darkTrim = 0x334155;
    const wood = 0x92400e;
    const kind = placement.kind;

    const box = (
      lx: number,
      ly: number,
      lz: number,
      sx: number,
      sy: number,
      sz: number,
      color: number,
      options: ShapeOptions = {}
    ) =>
      this.addBuildingShape(placement, baseY, lx, ly, lz, sx, sy, sz, color, options);

    const collider = (
      suffix: string,
      lx: number,
      ly: number,
      lz: number,
      sx: number,
      sy: number,
      sz: number
    ) =>
      this.addBuildingCollider(placement, baseY, suffix, lx, ly, lz, sx, sy, sz);

    const wall = (
      suffix: string,
      lx: number,
      ly: number,
      lz: number,
      sx: number,
      sy: number,
      sz: number,
      color: number = placement.wallColor
    ) => {
      box(lx, ly, lz, sx, sy, sz, color);
      collider(suffix, lx, ly, lz, sx, sy, sz);
    };

    // Deep foundation prevents floating corners on plateau shoulders; the
    // raised interior slab is the authoritative walkable floor.
    box(0, -0.18, 0, placement.width + 0.75, 1.12, placement.depth + 0.75, concrete);
    box(
      0,
      floorTop - 0.06,
      0,
      placement.width - 0.15,
      0.14,
      placement.depth - 0.15,
      kind === 'warehouse' || kind === 'garage' ? 0xb6c2d2 : 0xd6a35c
    );
    this.addBuildingWalkable(placement, baseY, 'floor', -hw, hw, -hd, hd, () => floorTop);

    const doorWidth =
      kind === 'warehouse' || kind === 'barn' ? 5.0 : kind === 'garage' ? 4.4 : kind === 'shop' ? 3.4 : 2.8;
    const frontSideWidth = Math.max(0.8, (placement.width - doorWidth) / 2);

    // Full-height side walls.
    wall('wall_left', -hw + wallT / 2, placement.height / 2, 0, wallT, placement.height, placement.depth);
    wall('wall_right', hw - wallT / 2, placement.height / 2, 0, wallT, placement.height, placement.depth);

    // Rear wall: either a second entrance or one movement/bullet collider
    // behind the visual window wall.
    if (placement.rearDoor) {
      const rearSideWidth = Math.max(0.8, (placement.width - 2.7) / 2);
      wall('wall_rear_left', -hw + rearSideWidth / 2, placement.height / 2, -hd + wallT / 2, rearSideWidth, placement.height, wallT);
      wall('wall_rear_right', hw - rearSideWidth / 2, placement.height / 2, -hd + wallT / 2, rearSideWidth, placement.height, wallT);
      box(0, (3 + placement.height) / 2, -hd + wallT / 2, 2.7, placement.height - 3, wallT, placement.wallColor);
    } else {
      box(0, placement.height / 2, -hd + wallT / 2, placement.width, placement.height, wallT, placement.wallColor);
      collider('wall_rear', 0, placement.height / 2, -hd + wallT / 2, placement.width, placement.height, wallT);
    }

    // Front wall and open doorway. Two-storey buildings also receive an
    // upper doorway onto their balcony.
    wall('wall_front_left', -hw + frontSideWidth / 2, placement.height / 2, hd - wallT / 2, frontSideWidth, placement.height, wallT);
    wall('wall_front_right', hw - frontSideWidth / 2, placement.height / 2, hd - wallT / 2, frontSideWidth, placement.height, wallT);
    const midFloorY = kind === 'barn' ? 3.05 : 3.48;
    if (placement.floors === 2) {
      box(0, (3 + midFloorY) / 2, hd - wallT / 2, doorWidth, midFloorY - 3, wallT, placement.wallColor);
      const headerBottom = midFloorY + 2.25;
      box(0, (headerBottom + placement.height) / 2, hd - wallT / 2, doorWidth, placement.height - headerBottom, wallT, placement.wallColor);
      collider('front_header', 0, (headerBottom + placement.height) / 2, hd - wallT / 2, doorWidth, placement.height - headerBottom, wallT);
    } else {
      box(0, (3 + placement.height) / 2, hd - wallT / 2, doorWidth, placement.height - 3, wallT, placement.wallColor);
    }

    // Architectural trim, open door panel, threshold, awnings/signs.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        box(sx * (hw - 0.18), placement.height / 2, sz * (hd - 0.18), 0.52, placement.height + 0.08, 0.52, 0xf8fafc, { tier: 'detail' });
      }
    }
    box(doorWidth / 2 + 0.18, 1.75, hd - 0.72, 0.14, 2.9, 1.25, placement.accentColor, { tier: 'detail' });
    box(0, 0.1, hd + 0.52, doorWidth + 1.1, 0.18, 1.0, concrete);
    const parkingPadWidth = kind === 'shop' || kind === 'warehouse' ? placement.width * 0.82 : doorWidth + 2.2;
    box(0, 0.045, hd + 2.0, parkingPadWidth, 0.09, 3.4, 0x64748b);
    if (kind === 'shop') {
      box(0, 3.52, hd + 0.18, placement.width * 0.72, 0.68, 0.2, placement.accentColor, { tier: 'detail' });
      box(0, 3.08, hd + 0.58, placement.width * 0.7, 0.14, 1.15, placement.roofColor, { rotationX: 0.18 });
    } else if (kind === 'house' || kind === 'cabin') {
      box(0, 3.08, hd + 0.5, doorWidth + 1.4, 0.14, 1.0, placement.roofColor, { rotationX: 0.16, tier: 'detail' });
    }

    // Windows on every occupied level.
    const floorHeight = placement.floors === 2 ? midFloorY : placement.height;
    for (let level = 0; level < placement.floors; level++) {
      const windowY = floorTop + level * floorHeight + 1.78;
      if (windowY > placement.height - 0.55) continue;
      for (const wx of [-placement.width * 0.25, placement.width * 0.25]) {
        box(wx, windowY, -hd - 0.035, 1.45, 1.18, 0.09, 0x7dd3fc, { shape: 'glass', tier: 'detail' });
        box(wx, windowY - 0.68, -hd - 0.02, 1.65, 0.12, 0.14, 0xf8fafc, { tier: 'detail' });
      }
      for (const side of [-1, 1]) {
        for (const wz of [-placement.depth * 0.2, placement.depth * 0.22]) {
          box(side * (hw + 0.035), windowY, wz, 0.09, 1.14, 1.35, 0x7dd3fc, { shape: 'glass', tier: 'detail' });
        }
      }
      if (kind === 'shop' && level === 0) {
        for (const side of [-1, 1]) {
          box(side * (doorWidth / 2 + 1.35), 1.85, hd + 0.035, 2.0, 1.45, 0.09, 0x7dd3fc, { shape: 'glass', tier: 'detail' });
        }
      }
    }

    // Interiors: one partial partition and kind-specific, mostly
    // non-blocking furniture. Counters/shelves that provide cover collide.
    if ((kind === 'house' || kind === 'apartment' || kind === 'cabin') && placement.width >= 10) {
      wall('interior_partition', -1.0, placement.height / 2, -hd * 0.42, 0.28, placement.height, placement.depth * 0.52, 0xe2e8f0);
    }
    if (kind === 'shop') {
      box(1.1, 0.92, 0.9, placement.width * 0.42, 1.05, 0.85, wood);
      collider('shop_counter', 1.1, 0.92, 0.9, placement.width * 0.42, 1.05, 0.85);
      box(-hw + 0.75, 1.25, -hd * 0.25, 0.7, 1.8, 2.4, darkTrim, { tier: 'detail' });
    } else if (kind === 'warehouse') {
      for (const sz of [-hd * 0.45, 0, hd * 0.42]) {
        box(hw - 0.95, 1.35, sz, 1.05, 2.0, 2.0, darkTrim, { tier: 'detail' });
      }
      collider('warehouse_shelves', hw - 0.95, 1.35, 0, 1.05, 2.0, placement.depth * 0.82);
      box(-hw + 1.15, 0.75, hd * 0.3, 1.35, 0.82, 1.35, 0xd97706, { tier: 'detail' });
    } else if (kind === 'barn') {
      for (const side of [-1, 1]) {
        box(side * (hw - 0.75), 0.82, -hd * 0.1, 0.75, 0.95, placement.depth * 0.58, wood, { tier: 'detail' });
      }
      box(hw * 0.42, 0.72, -hd * 0.48, 1.55, 0.8, 1.1, 0xeab308, { shape: 'cylinder', rotationZ: Math.PI / 2, tier: 'detail' });
    } else if (kind !== 'garage') {
      box(hw * 0.45, 0.95, -hd * 0.5, 2.1, 0.14, 1.05, wood, { tier: 'detail' });
      box(hw * 0.45, 0.52, -hd * 0.5, 0.28, 0.72, 0.85, wood, { tier: 'detail' });
      box(hw * 0.36, 1.3, -hd * 0.66, 0.72, 0.46, 0.08, 0x38bdf8, { shape: 'glow', tier: 'detail' });
      box(-hw + 0.7, 1.3, hd * 0.26, 0.7, 1.95, 1.5, darkTrim, { tier: 'detail' });
      box(0, placement.height - 0.16, 0, 0.55, 0.16, 0.55, 0xfef08a, { shape: 'glow', tier: 'detail' });
    }

    // Interior second floor / barn loft with an always-usable side ramp.
    if (placement.floors === 2 || kind === 'barn') {
      const slabMinX = -hw + 2.18;
      const slabMaxX = hw - 0.28;
      const slabMinZ = -hd + 0.3;
      const slabMaxZ = hd - 2.55;
      box(
        (slabMinX + slabMaxX) / 2,
        midFloorY,
        (slabMinZ + slabMaxZ) / 2,
        slabMaxX - slabMinX,
        0.24,
        slabMaxZ - slabMinZ,
        kind === 'barn' ? wood : concrete
      );
      this.addBuildingWalkable(
        placement,
        baseY,
        'upper_floor',
        slabMinX,
        slabMaxX,
        slabMinZ,
        slabMaxZ,
        () => midFloorY + 0.14
      );
      const rampRun = placement.depth - 1.5;
      const rampAngle = Math.atan2(midFloorY - floorTop, rampRun);
      box(-hw + 1.08, (floorTop + midFloorY) / 2, 0, 1.8, 0.22, Math.hypot(rampRun, midFloorY - floorTop), wood, { rotationX: rampAngle });
      this.addBuildingWalkable(
        placement,
        baseY,
        'interior_ramp',
        -hw + 0.18,
        -hw + 1.98,
        -rampRun / 2,
        rampRun / 2,
        (_lx, lz) => {
          const t = THREE.MathUtils.clamp((rampRun / 2 - lz) / rampRun, 0, 1);
          return floorTop + t * (midFloorY + 0.14 - floorTop);
        }
      );
      box((slabMinX + slabMaxX) / 2, midFloorY + 0.52, slabMaxZ, slabMaxX - slabMinX - 1.2, 0.75, 0.16, darkTrim, { tier: 'detail' });

      if (kind === 'apartment') {
        const balconyMinZ = hd - 0.1;
        const balconyMaxZ = hd + 2.15;
        box(0, midFloorY, (balconyMinZ + balconyMaxZ) / 2, placement.width * 0.68, 0.24, balconyMaxZ - balconyMinZ, concrete);
        this.addBuildingWalkable(
          placement,
          baseY,
          'balcony',
          -placement.width * 0.34,
          placement.width * 0.34,
          balconyMinZ,
          balconyMaxZ,
          () => midFloorY + 0.14
        );
        for (const side of [-1, 1]) {
          box(side * placement.width * 0.3, midFloorY / 2, balconyMaxZ - 0.2, 0.28, midFloorY, 0.28, darkTrim);
          box(side * placement.width * 0.34, midFloorY + 0.58, (balconyMinZ + balconyMaxZ) / 2, 0.14, 0.72, balconyMaxZ - balconyMinZ, darkTrim, { tier: 'detail' });
        }
        box(0, midFloorY + 0.58, balconyMaxZ, placement.width * 0.68, 0.72, 0.14, darkTrim, { tier: 'detail' });
      }
    }

    // Roof deck is always solid/walkable; gables sit above the deck, flat and
    // shed roofs are tactical positions when an exterior ramp is present.
    box(0, placement.height + 0.16, 0, placement.width + 0.68, 0.34, placement.depth + 0.68, placement.roofColor);
    collider('roof_slab', 0, placement.height + 0.16, 0, placement.width + 0.68, 0.34, placement.depth + 0.68);
    this.addBuildingWalkable(
      placement,
      baseY,
      'roof',
      -hw - 0.34,
      hw + 0.34,
      -hd - 0.34,
      hd + 0.34,
      () => placement.height + 0.34
    );

    if (placement.roof === 'gable') {
      box(0, placement.height + 1.62, 0, placement.width + 1.0, 2.9, placement.depth + 1.0, placement.roofColor, {
        shape: 'cone',
        rotationY: Math.PI / 4,
      });
      box(0, placement.height + 3.08, 0, 0.5, 0.28, placement.depth * 0.55, placement.accentColor, { tier: 'detail' });
    } else {
      if (placement.roof === 'shed') {
        box(0, placement.height + 0.58, 0, placement.width + 0.9, 0.2, placement.depth + 0.9, placement.accentColor, { rotationX: 0.12 });
      }
      const parapetY = placement.height + 0.72;
      const parapetSegments: Array<[string, number, number, number, number]> = [
        ['front', 0, hd + 0.18, placement.width + 0.5, 0.28],
        ['back', 0, -hd - 0.18, placement.width + 0.5, 0.28],
        ['left', -hw - 0.18, 0, 0.28, placement.depth + 0.5],
      ];
      if (hasExteriorRoofAccess(placement)) {
        parapetSegments.push(['right_partial', hw + 0.18, hd * 0.34, 0.28, placement.depth * 0.58]);
      } else {
        parapetSegments.push(['right', hw + 0.18, 0, 0.28, placement.depth + 0.5]);
      }
      for (const [suffix, lx, lz, sx, sz] of parapetSegments) {
        box(lx, parapetY, lz, sx, 0.78, sz, 0xf8fafc);
        collider(`parapet_${suffix}`, lx, parapetY, lz, sx, 0.78, sz);
      }
      box(-hw * 0.45, placement.height + 0.82, -hd * 0.38, 1.45, 0.95, 1.2, 0x64748b, { tier: 'detail' });
      box(hw * 0.42, placement.height + 0.5, hd * 0.22, placement.width * 0.28, 0.14, 0.65, placement.accentColor, { tier: 'detail' });
    }

    if (hasExteriorRoofAccess(placement)) {
      const rampRun = placement.depth + 0.3;
      const rampRise = placement.height + 0.34 - floorTop;
      const rampAngle = Math.atan2(rampRise, rampRun);
      box(hw + 1.58, (floorTop + placement.height + 0.34) / 2, 0, 2.45, 0.24, Math.hypot(rampRun, rampRise), wood, { rotationX: rampAngle });
      box(hw + 1.58, placement.height / 2, -hd + 0.35, 0.32, placement.height, 0.32, darkTrim, { shape: 'cylinder' });
      box(hw + 1.58, placement.height / 4, hd * 0.35, 0.3, placement.height / 2, 0.3, darkTrim, { shape: 'cylinder', tier: 'detail' });
      this.addBuildingWalkable(
        placement,
        baseY,
        'roof_ramp',
        hw + 0.34,
        hw + 2.82,
        -rampRun / 2,
        rampRun / 2,
        (_lx, lz) => {
          const t = THREE.MathUtils.clamp((rampRun / 2 - lz) / rampRun, 0, 1);
          return floorTop + t * rampRise;
        }
      );
    }

    // Gardens, barrels and harvestable exterior crates. These are placed
    // outside door paths and reuse the existing instanced destructibles.
    if (kind === 'house' || kind === 'cabin' || kind === 'shop' || kind === 'apartment') {
      for (const side of [-1, 1]) {
        box(side * (hw - 1.0), 0.55, hd + 0.82, 1.7, 0.68, 0.52, 0x15803d, { tier: 'detail' });
        box(side * (hw - 1.0), 0.34, hd + 1.18, 1.55, 0.18, 0.28, placement.accentColor, { tier: 'detail' });
      }
    }
    if (kind === 'warehouse' || kind === 'garage' || kind === 'barn') {
      const crateA = buildingLocalToWorld(placement, -hw - 1.7, hd + 1.1);
      this.world.spawnCrate(crateA.x, crateA.z);
      if (placement.lootTier === 'high') {
        const crateB = buildingLocalToWorld(placement, -hw - 1.7, -hd - 1.1);
        this.world.spawnCrate(crateB.x, crateB.z);
      }
      const barrel = buildingLocalToWorld(placement, hw - 0.75, hd + 1.0);
      const barrelY = this.world.terrain.getTerrainHeight(barrel.x, barrel.z);
      this.addShapeWorld(placement.districtId, barrel.x, barrelY + 0.72, barrel.z, 0.85, 1.45, 0.85, placement.accentColor, { shape: 'cylinder' });
      this.addWorldCylinderCollider(`expansion_${placement.id}_barrel`, barrel.x, barrel.z, 0.46, barrelY, barrelY + 1.45);
    }
    if (kind === 'barn') {
      for (const segment of [
        { suffix: 'fence_left', lx: -(doorWidth / 2 + (hw - doorWidth / 2) / 2 + 0.4), sx: hw - doorWidth / 2 - 0.4 },
        { suffix: 'fence_right', lx: doorWidth / 2 + (hw - doorWidth / 2) / 2 + 0.4, sx: hw - doorWidth / 2 - 0.4 },
      ]) {
        if (segment.sx <= 0.5) continue;
        box(segment.lx, 0.68, hd + 3.4, segment.sx, 0.16, 0.18, wood);
        box(segment.lx, 0.34, hd + 3.4, segment.sx, 0.14, 0.18, wood);
        collider(segment.suffix, segment.lx, 0.55, hd + 3.4, segment.sx, 1.05, 0.28);
      }
    }

    this.addBuildingLoot(placement, baseY, midFloorY);
  }

  private addBuildingLoot(
    placement: ExpansionBuildingPlacement,
    baseY: number,
    midFloorY: number
  ): void {
    if (placement.lootTier === 'none') return;
    const body = getBuildingBodyFootprint(placement);
    const bodyWidth = body.maxX - body.minX;
    const bodyDepth = body.maxZ - body.minZ;

    // LootSystem drops paired ammo at +1.1x/+0.6z, so initial ground loot
    // is deliberately anchored toward the world north-west interior. Shops
    // use a local anchor instead: their counter occupies that world-space
    // corner for several cardinal facings, while this side aisle remains
    // clear after the paired-ammo offset in every facing.
    if (placement.kind === 'shop') {
      const aisle = buildingLocalToWorld(placement, -placement.width / 2 + 2.1, 1.0);
      this.world.lootSpawnPoints.push(new THREE.Vector3(aisle.x, baseY + 0.5, aisle.z));
    } else {
      this.world.lootSpawnPoints.push(
        new THREE.Vector3(
          placement.x - bodyWidth * 0.2,
          baseY + 0.5,
          placement.z - bodyDepth * 0.16
        )
      );
    }

    const wantsChest =
      placement.lootTier === 'high' ||
      (placement.lootTier === 'standard' && this.stableHash01(placement.id) < 0.58);
    if (wantsChest) {
      const chest = buildingLocalToWorld(
        placement,
        -placement.width * 0.43,
        -placement.depth * 0.4
      );
      this.world.chestSpawnPoints.push(new THREE.Vector3(chest.x, baseY + 0.5, chest.z));
    }

    if (placement.lootTier === 'high') {
      if (placement.floors === 2 || placement.kind === 'barn') {
        const upper = buildingLocalToWorld(
          placement,
          placement.width * 0.3,
          -placement.depth * 0.42
        );
        this.world.lootSpawnPoints.push(
          new THREE.Vector3(upper.x, baseY + midFloorY + 0.48, upper.z)
        );
      } else if (hasExteriorRoofAccess(placement)) {
        const roof = buildingLocalToWorld(
          placement,
          -placement.width * 0.22,
          -placement.depth * 0.22
        );
        this.world.lootSpawnPoints.push(
          new THREE.Vector3(roof.x, baseY + placement.height + 0.72, roof.z)
        );
      } else {
        this.world.lootSpawnPoints.push(
          new THREE.Vector3(
            Math.min(placement.x + bodyWidth * 0.12, body.maxX - 1.8),
            baseY + 0.5,
            Math.min(placement.z + bodyDepth * 0.16, body.maxZ - 1.35)
          )
        );
      }
    }
  }

  private buildSettlementInfrastructure(): void {
    const lampPoleColor = 0x334155;
    for (const settlement of ISLAND_SETTLEMENTS) {
      const baseY = settlement.baseHeight;
      const length = settlement.radius * 1.62;
      if (settlement.streetAxis === 'x') {
        this.addShapeWorld(settlement.id, settlement.x, baseY + 0.045, settlement.z, length, 0.09, 5.4, 0x475569);
        this.addShapeWorld(settlement.id, settlement.x, baseY + 0.065, settlement.z - 3.55, length, 0.11, 1.0, 0xcbd5e1, { tier: 'detail' });
        this.addShapeWorld(settlement.id, settlement.x, baseY + 0.065, settlement.z + 3.55, length, 0.11, 1.0, 0xcbd5e1, { tier: 'detail' });
        this.addShapeWorld(settlement.id, settlement.x, baseY + 0.04, settlement.z, 5.2, 0.08, 13, 0x475569);
      } else {
        this.addShapeWorld(settlement.id, settlement.x, baseY + 0.045, settlement.z, 5.4, 0.09, length, 0x475569);
        this.addShapeWorld(settlement.id, settlement.x - 3.55, baseY + 0.065, settlement.z, 1.0, 0.11, length, 0xcbd5e1, { tier: 'detail' });
        this.addShapeWorld(settlement.id, settlement.x + 3.55, baseY + 0.065, settlement.z, 1.0, 0.11, length, 0xcbd5e1, { tier: 'detail' });
        this.addShapeWorld(settlement.id, settlement.x, baseY + 0.04, settlement.z, 13, 0.08, 5.2, 0x475569);
      }

      for (const offset of [-settlement.radius * 0.58, 0, settlement.radius * 0.58]) {
        const side = offset === 0 ? -3.35 : 3.35;
        const lx = settlement.streetAxis === 'x' ? settlement.x + offset : settlement.x + side;
        const lz = settlement.streetAxis === 'x' ? settlement.z + side : settlement.z + offset;
        const ly = this.world.terrain.getTerrainHeight(lx, lz);
        this.addShapeWorld(settlement.id, lx, ly + 2.0, lz, 0.24, 4.0, 0.24, lampPoleColor, { shape: 'cylinder', tier: 'detail' });
        this.addShapeWorld(settlement.id, lx, ly + 4.15, lz, 0.58, 0.58, 0.58, 0xfef08a, { shape: 'glow', tier: 'detail' });
      }

      for (const side of [-1, 1]) {
        const bx = settlement.streetAxis === 'x' ? settlement.x + side * 7.5 : settlement.x + side * 6.4;
        const bz = settlement.streetAxis === 'x' ? settlement.z - side * 6.4 : settlement.z + side * 7.5;
        const by = this.world.terrain.getTerrainHeight(bx, bz);
        const sx = settlement.streetAxis === 'x' ? 2.6 : 0.75;
        const sz = settlement.streetAxis === 'x' ? 0.75 : 2.6;
        this.addShapeWorld(settlement.id, bx, by + 0.55, bz, sx, 1.1, sz, 0x94a3b8);
        this.addWorldBoxCollider(`expansion_${settlement.id}_barrier_${side}`, bx, by + 0.55, bz, sx, 1.1, sz);
      }

      // A coloured district pylon is visible during the sky-drop and helps
      // each settlement read as a distinct destination.
      const signCandidates: Array<[number, number]> = [
        [0.5, -0.5],
        [-0.5, -0.5],
        [0.5, 0.5],
        [-0.5, 0.5],
      ];
      let signX = settlement.x + settlement.radius * 0.5;
      let signZ = settlement.z - settlement.radius * 0.5;
      for (const [ox, oz] of signCandidates) {
        const cx = settlement.x + settlement.radius * ox;
        const cz = settlement.z + settlement.radius * oz;
        if (!this.isInsideStructure(cx, cz, 2.5)) {
          signX = cx;
          signZ = cz;
          break;
        }
      }
      const signY = this.world.terrain.getTerrainHeight(signX, signZ);
      const signColor = Number.parseInt(settlement.color.slice(1), 16);
      this.addShapeWorld(settlement.id, signX, signY + 3.0, signZ, 0.42, 6.0, 0.42, lampPoleColor, { shape: 'cylinder' });
      this.addShapeWorld(settlement.id, signX, signY + 5.15, signZ, 3.4, 1.25, 0.28, signColor);
      this.addShapeWorld(settlement.id, signX, signY + 6.25, signZ, 0.72, 0.72, 0.72, signColor, { shape: 'glow', tier: 'detail' });
      this.addWorldCylinderCollider(`expansion_${settlement.id}_sign`, signX, signZ, 0.35, signY, signY + 6.0);
    }
  }

  private buildFarmFields(): void {
    const fields = [
      { districtId: 'frontend_farms', x: 13, z: -116 },
      { districtId: 'northwest_cabins', x: -63, z: -139 },
      { districtId: 'north_fields', x: 25, z: -83 },
    ];
    for (const field of fields) {
      for (let row = 0; row < 6; row++) {
        const z = field.z - 5 + row * 2;
        const y = this.world.terrain.getTerrainHeight(field.x, z);
        this.addShapeWorld(
          field.districtId,
          field.x,
          y + 0.22,
          z,
          13,
          0.3,
          0.72,
          row % 2 === 0 ? 0x65a30d : 0xeab308,
          { tier: 'detail' }
        );
      }
      this.addShapeWorld(field.districtId, field.x - 7.5, this.world.terrain.getTerrainHeight(field.x - 7.5, field.z) + 0.65, field.z, 0.35, 1.3, 11, 0x92400e, { tier: 'detail' });
      this.addShapeWorld(field.districtId, field.x + 7.5, this.world.terrain.getTerrainHeight(field.x + 7.5, field.z) + 0.65, field.z, 0.35, 1.3, 11, 0x92400e, { tier: 'detail' });
    }
  }

  private createLandmark(landmark: LandmarkPlacement): void {
    switch (landmark.kind) {
      case 'watchtower':
        this.createWatchtower(landmark);
        break;
      case 'camp':
        this.createCamp(landmark);
        break;
      case 'ruin':
        this.createRuin(landmark);
        break;
      case 'dock':
        this.createDock(landmark);
        break;
      case 'bridge':
        this.createBridge(landmark);
        break;
    }
  }

  private createWatchtower(landmark: LandmarkPlacement): void {
    const frame: LocalFrame = landmark;
    const baseY = this.world.terrain.getTerrainHeight(landmark.x, landmark.z);
    const wood = 0x92400e;
    const stone = 0x64748b;

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const lx = sx * 2.35;
        const lz = sz * 2.35;
        this.addFrameShape(landmark.districtId, frame, baseY, lx, 3.0, lz, 0.48, 6.2, 0.48, wood, { shape: 'cylinder' });
        const world = this.frameLocalToWorld(frame, lx, lz);
        this.addWorldCylinderCollider(`expansion_${landmark.id}_leg_${sx}_${sz}`, world.x, world.z, 0.42, baseY, baseY + 6.1);
      }
    }
    this.addFrameShape(landmark.districtId, frame, baseY, 0, 3.1, -2.35, 5.0, 0.18, 0.22, wood, { rotationZ: 0.62, tier: 'detail' });
    this.addFrameShape(landmark.districtId, frame, baseY, 0, 3.1, 2.35, 5.0, 0.18, 0.22, wood, { rotationZ: -0.62, tier: 'detail' });

    this.addFrameShape(landmark.districtId, frame, baseY, 0, 6.15, 0, 6.6, 0.36, 6.6, stone);
    this.addFrameWalkable(`expansion_${landmark.id}_platform`, frame, baseY, -3.3, 3.3, -3.3, 3.3, () => 6.34);
    for (const [lx, lz, sx, sz] of [
      [0, -3.15, 6.4, 0.28],
      [-3.15, 0, 0.28, 6.4],
      [0, 3.15, 6.4, 0.28],
    ] as const) {
      this.addFrameShape(landmark.districtId, frame, baseY, lx, 6.95, lz, sx, 1.15, sz, wood);
    }
    this.addFrameShape(landmark.districtId, frame, baseY, 0, 9.05, 0, 8.0, 2.6, 8.0, 0x7f1d1d, {
      shape: 'cone',
      rotationY: Math.PI / 4,
    });

    const rampRun = 10.6;
    const rampRise = 6.34 - 0.35;
    const rampAngle = Math.atan2(rampRise, rampRun);
    this.addFrameShape(landmark.districtId, frame, baseY, 4.15, (0.35 + 6.34) / 2, 2.65, 2.25, 0.24, Math.hypot(rampRun, rampRise), wood, { rotationX: rampAngle });
    this.addFrameWalkable(
      `expansion_${landmark.id}_ramp`,
      frame,
      baseY,
      3.0,
      5.3,
      -2.65,
      7.95,
      (_lx, lz) => {
        const t = THREE.MathUtils.clamp((7.95 - lz) / rampRun, 0, 1);
        return 0.35 + t * rampRise;
      }
    );

    if (landmark.lootTier === 'high') {
      this.world.chestSpawnPoints.push(new THREE.Vector3(landmark.x - 1.2, baseY + 6.55, landmark.z - 1.1));
    }
    this.world.lootSpawnPoints.push(new THREE.Vector3(landmark.x - 1.0, baseY + 6.55, landmark.z + 0.8));
    this.world.spawnCrate(landmark.x - 4.6, landmark.z + 4.2);
  }

  private createCamp(landmark: LandmarkPlacement): void {
    const frame: LocalFrame = landmark;
    const baseY = this.world.terrain.getTerrainHeight(landmark.x, landmark.z);
    for (const [lx, lz, color] of [
      [-2.7, -1.0, 0x0f766e],
      [2.7, 1.1, 0xb45309],
    ] as const) {
      this.addFrameShape(landmark.districtId, frame, baseY, lx - 0.72, 1.05, lz, 0.16, 2.25, 3.0, color, { rotationZ: 0.58 });
      this.addFrameShape(landmark.districtId, frame, baseY, lx + 0.72, 1.05, lz, 0.16, 2.25, 3.0, color, { rotationZ: -0.58 });
      this.addFrameShape(landmark.districtId, frame, baseY, lx, 0.12, lz, 2.7, 0.22, 3.2, 0x78716c);
      const world = this.frameLocalToWorld(frame, lx, lz);
      const swap = landmark.facing === 'east' || landmark.facing === 'west';
      this.addWorldBoxCollider(
        `expansion_${landmark.id}_tent_${lx}`,
        world.x,
        baseY + 1.0,
        world.z,
        swap ? 3.1 : 2.7,
        2.0,
        swap ? 2.7 : 3.1
      );
    }

    this.addFrameShape(landmark.districtId, frame, baseY, 0, 0.28, 0, 1.35, 0.5, 1.35, 0x57534e, { shape: 'cylinder' });
    this.addFrameShape(landmark.districtId, frame, baseY, 0, 0.72, 0, 0.62, 0.82, 0.62, 0xf97316, { shape: 'glow', tier: 'detail' });
    for (const angle of [0.2, 1.75, 3.4]) {
      this.addFrameShape(landmark.districtId, frame, baseY, Math.cos(angle) * 1.6, 0.32, Math.sin(angle) * 1.6, 0.32, 1.9, 0.32, 0x92400e, {
        shape: 'cylinder',
        rotationZ: Math.PI / 2,
        rotationY: -angle,
        tier: 'detail',
      });
    }

    const crateA = this.frameLocalToWorld(frame, 3.4, -2.8);
    const crateB = this.frameLocalToWorld(frame, -3.5, 2.8);
    this.world.spawnCrate(crateA.x, crateA.z);
    this.world.spawnCrate(crateB.x, crateB.z);
    this.world.spawnRock(landmark.x + 4.7, landmark.z - 3.9, 1.15);

    if (landmark.lootTier === 'standard' || landmark.lootTier === 'high') {
      this.world.chestSpawnPoints.push(new THREE.Vector3(landmark.x - 1.4, baseY + 0.45, landmark.z + 1.3));
    }
    this.world.lootSpawnPoints.push(new THREE.Vector3(landmark.x - 1.2, baseY + 0.45, landmark.z - 1.2));
  }

  private createRuin(landmark: LandmarkPlacement): void {
    const frame: LocalFrame = landmark;
    const baseY = this.world.terrain.getTerrainHeight(landmark.x, landmark.z);
    const stone = 0x94a3b8;
    this.addFrameShape(landmark.districtId, frame, baseY, 0, 0.22, 0, 9.5, 0.48, 9.5, stone);
    this.addFrameWalkable(`expansion_${landmark.id}_dais`, frame, baseY, -4.75, 4.75, -4.75, 4.75, () => 0.47);

    const pillars: Array<[number, number, number]> = [
      [-3.6, -3.6, 4.8],
      [3.6, -3.6, 3.2],
      [-3.6, 3.6, 2.3],
      [3.6, 3.6, 5.1],
    ];
    pillars.forEach(([lx, lz, height], index) => {
      this.addFrameShape(landmark.districtId, frame, baseY, lx, 0.47 + height / 2, lz, 1.25, height, 1.25, stone, { shape: 'cylinder' });
      const world = this.frameLocalToWorld(frame, lx, lz);
      this.addWorldCylinderCollider(`expansion_${landmark.id}_pillar_${index}`, world.x, world.z, 0.68, baseY + 0.47, baseY + 0.47 + height);
      if (height > 4.5) {
        this.addFrameShape(landmark.districtId, frame, baseY, lx, 0.72 + height, lz, 1.75, 0.42, 1.75, 0x4ade80, { tier: 'detail' });
      }
    });

    this.addFrameShape(landmark.districtId, frame, baseY, 0, 5.65, -3.6, 8.4, 0.75, 1.25, stone);
    this.addFrameShape(landmark.districtId, frame, baseY, -1.2, 0.95, 0.4, 0.85, 4.6, 0.85, stone, {
      shape: 'cylinder',
      rotationZ: Math.PI / 2,
      tier: 'detail',
    });
    const fallen = this.frameLocalToWorld(frame, -1.2, 0.4);
    const swap = landmark.facing === 'east' || landmark.facing === 'west';
    this.addWorldBoxCollider(`expansion_${landmark.id}_fallen_column`, fallen.x, baseY + 0.95, fallen.z, swap ? 0.9 : 4.6, 0.9, swap ? 4.6 : 0.9);

    if (landmark.lootTier === 'high') {
      this.world.chestSpawnPoints.push(new THREE.Vector3(landmark.x - 1.3, baseY + 0.68, landmark.z - 1.2));
    }
    this.world.lootSpawnPoints.push(new THREE.Vector3(landmark.x - 1.1, baseY + 0.68, landmark.z + 1.2));
    this.world.spawnRock(landmark.x - 5.8, landmark.z + 4.9, 1.35);
  }

  private createDock(landmark: LandmarkPlacement): void {
    const frame: LocalFrame = landmark;
    const shore = this.frameLocalToWorld(frame, 0, -6);
    const deckY = Math.max(0.62, this.world.terrain.getTerrainHeight(shore.x, shore.z) + 0.25);
    const baseY = deckY - 0.22;
    this.addFrameShape(landmark.districtId, frame, baseY, 0, 0.22, 0, 4.8, 0.34, 13.5, 0x92400e);
    this.addFrameWalkable(`expansion_${landmark.id}_deck`, frame, baseY, -2.4, 2.4, -6.75, 6.75, () => 0.4);
    for (const sx of [-1, 1]) {
      for (const lz of [-5.5, 0, 5.5]) {
        this.addFrameShape(landmark.districtId, frame, baseY, sx * 2.05, -1.15, lz, 0.34, 3.0, 0.34, 0x78350f, { shape: 'cylinder', tier: 'detail' });
      }
    }
    this.addFrameShape(landmark.districtId, frame, baseY, 2.0, 1.55, 5.6, 0.24, 2.7, 0.24, 0x334155, { shape: 'cylinder', tier: 'detail' });
    this.addFrameShape(landmark.districtId, frame, baseY, 2.0, 3.0, 5.6, 0.55, 0.55, 0.55, 0xfef08a, { shape: 'glow', tier: 'detail' });

    const crate = this.frameLocalToWorld(frame, -3.5, -6.8);
    this.world.spawnCrate(crate.x, crate.z);
    const loot = this.frameLocalToWorld(frame, -1.0, 3.8);
    this.world.lootSpawnPoints.push(new THREE.Vector3(loot.x, deckY + 0.35, loot.z));
  }

  private createBridge(landmark: LandmarkPlacement): void {
    const bridgeZ = landmark.z;
    const t = (bridgeZ - 38) / (215 - 38);
    const bridgeX = -46 + t * 52 + Math.sin(t * Math.PI * 2.2) * 12;
    const bridgeY = 1.92;
    this.addShapeWorld(landmark.districtId, bridgeX, bridgeY, bridgeZ, 17.5, 0.36, 4.9, 0x92400e);
    this.addWorldWalkable(
      `expansion_${landmark.id}_deck`,
      { minX: bridgeX - 8.75, maxX: bridgeX + 8.75, minZ: bridgeZ - 2.45, maxZ: bridgeZ + 2.45 },
      bridgeY + 0.2
    );
    for (const side of [-1, 1]) {
      const railZ = bridgeZ + side * 2.25;
      this.addShapeWorld(landmark.districtId, bridgeX, bridgeY + 0.62, railZ, 17.5, 0.9, 0.26, 0x78350f);
      this.addWorldBoxCollider(`expansion_${landmark.id}_rail_${side}`, bridgeX, bridgeY + 0.62, railZ, 17.5, 0.9, 0.26);
    }
    for (const dx of [-6, 6]) {
      for (const dz of [-2.1, 2.1]) {
        this.addShapeWorld(landmark.districtId, bridgeX + dx, bridgeY - 1.45, bridgeZ + dz, 0.38, 3.4, 0.38, 0x78350f, { shape: 'cylinder', tier: 'detail' });
      }
      this.addShapeWorld(landmark.districtId, bridgeX + dx, bridgeY + 1.35, bridgeZ - 2.25, 0.5, 0.5, 0.5, 0xfef08a, { shape: 'glow', tier: 'detail' });
    }
    this.world.lootSpawnPoints.push(new THREE.Vector3(bridgeX - 1.2, bridgeY + 0.42, bridgeZ - 0.7));
    this.world.spawnCrate(bridgeX - 10.5, bridgeZ + 4.2);
    this.world.spawnCrate(bridgeX + 10.5, bridgeZ - 4.2);
  }

  public populateVegetation(): void {
    let seed = 424242;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const accepted: Array<{ x: number; z: number }> = [];
    for (const prop of this.world.destructibles.values()) {
      if (prop.type === 'tree' || prop.type === 'rock') {
        accepted.push({ x: prop.position.x, z: prop.position.z });
      }
    }

    const hasSpacing = (x: number, z: number, minDist: number): boolean => {
      const minSq = minDist * minDist;
      for (const point of accepted) {
        const dx = x - point.x;
        const dz = z - point.z;
        if (dx * dx + dz * dz < minSq) return false;
      }
      return true;
    };

    const isVegetationClear = (x: number, z: number, spacing: number): boolean => {
      if (!hasSpacing(x, z, spacing)) return false;
      if (this.isInsideStructure(x, z, 2.2)) return false;
      if (Math.hypot(x, z) > this.world.terrain.islandRadius - 7) return false;
      if (this.world.terrain.getRoadDistance(x, z) < 5.4) return false;
      if (this.world.terrain.getRiverDistance(x, z) < 6.2) return false;
      if (Math.hypot(x + 46, z - 38) < 24.5) return false;
      for (const settlement of ISLAND_SETTLEMENTS) {
        if (Math.hypot(x - settlement.x, z - settlement.z) < settlement.radius * 0.72) return false;
      }
      for (const poi of ISLAND_POIS) {
        if (Math.hypot(x - poi.x, z - poi.z) < poi.radius * 0.72) return false;
      }
      return true;
    };

    const chooseTreeStyle = (
      cluster: (typeof FOREST_CLUSTERS)[number],
      height: number
    ): 'pine' | 'oak' | 'blossom' | 'palm' | 'birch' => {
      if (height < 2.1 && cluster.palmWeight > 0) return 'palm';
      const roll = rand();
      if (roll < cluster.pineWeight) return 'pine';
      if (roll < cluster.pineWeight + cluster.oakWeight) return 'oak';
      if (roll < cluster.pineWeight + cluster.oakWeight + cluster.birchWeight) return 'birch';
      if (
        roll <
        cluster.pineWeight + cluster.oakWeight + cluster.birchWeight + cluster.blossomWeight
      ) {
        return 'blossom';
      }
      return cluster.palmWeight > 0 ? 'palm' : 'oak';
    };

    for (const cluster of FOREST_CLUSTERS) {
      let placedTrees = 0;
      for (let attempt = 0; attempt < cluster.treeCount * 4 && placedTrees < cluster.treeCount; attempt++) {
        const angle = rand() * Math.PI * 2;
        const radius = Math.sqrt(rand()) * cluster.radius;
        const x = cluster.x + Math.cos(angle) * radius;
        const z = cluster.z + Math.sin(angle) * radius;
        const height = this.world.terrain.getTerrainHeight(x, z);
        if (height < 0.75 || height > 15.6) continue;
        if (this.world.terrain.getTerrainSlope(x, z) > 0.9) continue;
        if (!isVegetationClear(x, z, 5.6)) continue;
        this.world.spawnTree(x, z, chooseTreeStyle(cluster, height));
        accepted.push({ x, z });
        placedTrees++;
      }

      let placedRocks = 0;
      for (let attempt = 0; attempt < cluster.rockCount * 4 && placedRocks < cluster.rockCount; attempt++) {
        const angle = rand() * Math.PI * 2;
        const radius = Math.sqrt(rand()) * cluster.radius;
        const x = cluster.x + Math.cos(angle) * radius;
        const z = cluster.z + Math.sin(angle) * radius;
        const height = this.world.terrain.getTerrainHeight(x, z);
        if (height < 0.85 || !isVegetationClear(x, z, 4.2)) continue;
        this.world.spawnRock(x, z, 1.0 + rand() * 1.35);
        accepted.push({ x, z });
        placedRocks++;
      }
    }

    // Roadside trees make the new connector network legible without
    // obstructing the road surface itself.
    for (const segment of ISLAND_ROAD_SEGMENTS) {
      if (segment.kind !== 'secondary') continue;
      const dx = segment.toX - segment.fromX;
      const dz = segment.toZ - segment.fromZ;
      const length = Math.hypot(dx, dz);
      const steps = Math.max(1, Math.floor(length / 18));
      const perpX = length > 0 ? -dz / length : 0;
      const perpZ = length > 0 ? dx / length : 0;
      for (let step = 1; step < steps; step++) {
        if (rand() < 0.38) continue;
        const t = step / steps;
        const side = step % 2 === 0 ? 1 : -1;
        const offset = side * (7.5 + rand() * 4.5);
        const x = segment.fromX + dx * t + perpX * offset;
        const z = segment.fromZ + dz * t + perpZ * offset;
        const height = this.world.terrain.getTerrainHeight(x, z);
        if (height < 0.8 || height > 15.2 || this.world.terrain.getTerrainSlope(x, z) > 0.85) continue;
        if (!isVegetationClear(x, z, 6.2)) continue;
        const style = height < 2.2 ? 'palm' : height > 8.5 ? 'pine' : rand() < 0.45 ? 'oak' : rand() < 0.62 ? 'birch' : 'pine';
        this.world.spawnTree(x, z, style);
        accepted.push({ x, z });
      }
    }

    // Garden trees at alternating building corners.
    EXPANSION_BUILDINGS.forEach((placement, index) => {
      if (index % 2 !== 0) return;
      const localX = index % 4 === 0 ? -placement.width / 2 - 3.2 : placement.width / 2 + 4.4;
      const candidate = buildingLocalToWorld(
        placement,
        localX,
        placement.depth / 2 + 2.6
      );
      const height = this.world.terrain.getTerrainHeight(candidate.x, candidate.z);
      if (height < 0.8 || !hasSpacing(candidate.x, candidate.z, 5.5)) return;
      if (this.isInsideStructure(candidate.x, candidate.z, 1.6)) return;
      if (this.world.terrain.getRoadDistance(candidate.x, candidate.z) < 5.2) return;
      this.world.spawnTree(
        candidate.x,
        candidate.z,
        placement.kind === 'cabin' ? 'pine' : height < 2.2 ? 'palm' : 'oak'
      );
      accepted.push(candidate);
    });
  }

  private isDetailFoliageClear(x: number, z: number, roadMargin: number): boolean {
    if (this.isInsideStructure(x, z, 0.85)) return false;
    if (this.world.terrain.getRoadDistance(x, z) < roadMargin) return false;
    if (this.world.terrain.getRiverDistance(x, z) < 5.4) return false;
    if (Math.hypot(x + 46, z - 38) < 23.5) return false;
    for (const settlement of ISLAND_SETTLEMENTS) {
      if (Math.hypot(x - settlement.x, z - settlement.z) < settlement.radius * 0.66) return false;
    }
    for (const poi of ISLAND_POIS) {
      if (Math.hypot(x - poi.x, z - poi.z) < poi.radius * 0.68) return false;
    }
    return true;
  }

  public buildDetailFoliage(): void {
    let seed = 271828;
    const rand = () => {
      seed = (seed * 48271) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    const samplePoint = (clusterBias: number): { x: number; z: number } => {
      if (rand() < clusterBias) {
        const cluster = FOREST_CLUSTERS[Math.floor(rand() * FOREST_CLUSTERS.length)];
        const angle = rand() * Math.PI * 2;
        const radius = Math.sqrt(rand()) * cluster.radius * 1.18;
        return {
          x: cluster.x + Math.cos(angle) * radius,
          z: cluster.z + Math.sin(angle) * radius,
        };
      }
      const angle = rand() * Math.PI * 2;
      const radius = 18 + Math.sqrt(rand()) * 196;
      return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
    };

    const createInstances = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      count: number,
      attempts: number,
      placer: (x: number, z: number, y: number) => boolean,
      applyTransform: (x: number, y: number, z: number) => void,
      colors?: number[]
    ) => {
      const inst = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      inst.castShadow = false;
      inst.receiveShadow = true;
      let placed = 0;
      for (let attempt = 0; attempt < attempts && placed < count; attempt++) {
        const point = samplePoint(0.62);
        const y = this.world.terrain.getTerrainHeight(point.x, point.z);
        if (!placer(point.x, point.z, y)) continue;
        dummy.position.set(point.x, y, point.z);
        dummy.rotation.set(0, rand() * Math.PI * 2, 0);
        dummy.scale.setScalar(1);
        applyTransform(point.x, y, point.z);
        dummy.updateMatrix();
        inst.setMatrixAt(placed, dummy.matrix);
        if (colors && colors.length > 0) {
          inst.setColorAt(placed, color.setHex(colors[Math.floor(rand() * colors.length)]));
        }
        placed++;
      }
      inst.count = placed;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.computeBoundingSphere();
      this.detailFoliageGroup.add(inst);
      return inst;
    };

    const grassGeo = new THREE.ConeGeometry(0.24, 0.78, 4);
    grassGeo.translate(0, 0.38, 0);
    createInstances(
      grassGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.88 }),
      1050,
      4200,
      (x, z, y) => y > 1.7 && y < 12.5 && this.isDetailFoliageClear(x, z, 4.3),
      () => dummy.scale.setScalar(0.8 + rand() * 0.85),
      [0x15803d, 0x16a34a, 0x22c55e, 0x65a30d]
    );

    const undergrowthGeo = new THREE.DodecahedronGeometry(0.42, 0);
    undergrowthGeo.scale(1.25, 0.62, 1.25);
    undergrowthGeo.translate(0, 0.28, 0);
    createInstances(
      undergrowthGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.9 }),
      430,
      1900,
      (x, z, y) => y > 1.8 && y < 13.5 && this.isDetailFoliageClear(x, z, 4.8),
      () => dummy.scale.setScalar(0.75 + rand() * 0.9),
      [0x14532d, 0x166534, 0x15803d]
    );

    const bushGeo = new THREE.DodecahedronGeometry(0.66, 0);
    bushGeo.scale(1.15, 0.8, 1.15);
    bushGeo.translate(0, 0.44, 0);
    createInstances(
      bushGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.86 }),
      280,
      1300,
      (x, z, y) => y > 1.8 && y < 13.0 && this.isDetailFoliageClear(x, z, 5.0),
      () => dummy.scale.setScalar(0.8 + rand() * 0.85),
      [0x15803d, 0x16a34a, 0x4d7c0f]
    );

    const flowerGeo = new THREE.DodecahedronGeometry(0.2, 0);
    flowerGeo.translate(0, 0.25, 0);
    createInstances(
      flowerGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.75 }),
      340,
      1500,
      (x, z, y) => y > 1.9 && y < 11.5 && this.isDetailFoliageClear(x, z, 4.4),
      () => dummy.scale.setScalar(0.75 + rand() * 0.65),
      [0xf472b6, 0xfacc15, 0xc084fc, 0xfb7185, 0xffffff]
    );

    const pebbleGeo = new THREE.DodecahedronGeometry(0.3, 0);
    pebbleGeo.scale(1.25, 0.52, 1.0);
    createInstances(
      pebbleGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.94 }),
      260,
      1400,
      (x, z, y) => y > 0.25 && (y < 2.7 || y > 8.5) && this.isDetailFoliageClear(x, z, 4.1),
      (_x, y) => {
        dummy.position.y = y + 0.08;
        dummy.scale.setScalar(0.65 + rand() * 0.9);
      },
      [0x94a3b8, 0xa8a29e, 0x78716c]
    );

    const reedGeo = new THREE.CylinderGeometry(0.045, 0.075, 1.25, 5);
    reedGeo.translate(0, 0.6, 0);
    createInstances(
      reedGeo,
      new THREE.MeshStandardMaterial({ color: 0x65a30d, flatShading: true, roughness: 0.88 }),
      150,
      2400,
      (x, z, y) => {
        const river = this.world.terrain.getRiverDistance(x, z);
        const lake = Math.hypot(x + 46, z - 38);
        return (
          ((river > 4.0 && river < 7.5) || (lake > 21 && lake < 26) || (y > 0.25 && y < 1.35)) &&
          !this.isInsideStructure(x, z, 0.85) &&
          this.world.terrain.getRoadDistance(x, z) >= 4.1
        );
      },
      () => {
        dummy.rotation.x = (rand() - 0.5) * 0.18;
        dummy.rotation.z = (rand() - 0.5) * 0.18;
        dummy.scale.setScalar(0.8 + rand() * 0.6);
      }
    );

    const logGeo = new THREE.CylinderGeometry(0.24, 0.3, 2.8, 6);
    logGeo.rotateZ(Math.PI / 2);
    logGeo.translate(0, 0.27, 0);
    createInstances(
      logGeo,
      new THREE.MeshStandardMaterial({ color: 0x92400e, flatShading: true, roughness: 0.92 }),
      90,
      700,
      (x, z, y) => y > 1.8 && y < 13.5 && this.isDetailFoliageClear(x, z, 5.2),
      () => dummy.scale.setScalar(0.8 + rand() * 0.55)
    );
  }

  public finalizeArchitecture(): void {
    if (this.architectureFinalized) return;
    this.architectureFinalized = true;

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const coneGeo = new THREE.ConeGeometry(0.5, 1, 8);
    const cylinderGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
    const glowGeo = new THREE.SphereGeometry(0.5, 8, 6);

    const standardMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      flatShading: true,
      roughness: 0.74,
      metalness: 0.03,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x7dd3fc,
      emissive: 0x0284c7,
      emissiveIntensity: 0.32,
      flatShading: true,
      roughness: 0.32,
      transparent: true,
      opacity: 0.68,
    });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    const geometryFor = (shape: ArchitectureShape): THREE.BufferGeometry => {
      switch (shape) {
        case 'cone':
          return coneGeo;
        case 'cylinder':
          return cylinderGeo;
        case 'glow':
          return glowGeo;
        case 'glass':
        case 'box':
        default:
          return boxGeo;
      }
    };
    const materialFor = (shape: ArchitectureShape): THREE.Material => {
      if (shape === 'glass') return glassMat;
      if (shape === 'glow') return glowMat;
      return standardMat;
    };

    for (const [key, specs] of this.instances.entries()) {
      const [, shapeName, tierName] = key.split('|') as [string, ArchitectureShape, ArchitectureTier];
      if (!ARCHITECTURE_SHAPES.includes(shapeName) || specs.length === 0) continue;
      const inst = new THREE.InstancedMesh(geometryFor(shapeName), materialFor(shapeName), specs.length);
      inst.name = `Expansion_${key.replaceAll('|', '_')}`;
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      inst.castShadow = shapeName !== 'glass' && shapeName !== 'glow';
      inst.receiveShadow = shapeName !== 'glow';
      specs.forEach((spec, index) => {
        inst.setMatrixAt(index, spec.matrix);
        inst.setColorAt(index, spec.color);
      });
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.computeBoundingSphere();
      if (tierName === 'detail') this.expansionDetailGroup.add(inst);
      else this.expansionGroup.add(inst);
    }

    this.instances.clear();
  }
}
