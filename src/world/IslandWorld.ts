import { overlapsBuildGeometry, normalizeBuildYaw } from '../../shared/buildPlacement.mjs';
import * as THREE from 'three';
import { TerrainGenerator, ISLAND_POIS } from './TerrainGenerator';
import { MapExpansionBuilder } from './MapExpansionBuilder';
import { WorldBranding } from './WorldBranding';
import { applyFoliageWind, setFoliageWindTime } from './VisualAtmosphere';
import {
  ISLAND_SETTLEMENTS,
  LEGENDARY_TOWER,
  LEGENDARY_TOWER_FLOOR_LOOT,
  LEGENDARY_TOWER_VAULT_LOOT,
  getLegendaryTowerFloorHeight,
} from './WorldLayout';
import {
  BuildablePieceState,
  BuildMaterialType,
  BuildPieceType,
  LootItemState,
} from '../network/schemas';

export interface BoxCollider {
  id: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  destructibleId?: string;
}

export interface CylinderCollider {
  id: string;
  x: number;
  z: number;
  radius: number;
  minY: number;
  maxY: number;
  destructibleId?: string;
}

export interface WalkableSurface {
  id?: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  getHeight: (x: number, z: number) => number;
}

export interface DestructibleProp {
  id: string;
  type: 'tree' | 'rock' | 'crate' | 'fence' | 'buildable';
  materialType: BuildMaterialType;
  health: number;
  maxHealth: number;
  mesh: THREE.Object3D;
  position: THREE.Vector3;
  hitShakeTimer: number;
  spawnScaleTimer?: number;
  gridKey?: string;
  updateInstanceTransform?: (scale: number, shakeAngleZ: number) => void;
}

export class IslandWorld {
  private landmarkDetail = true;
  private vaultLight: THREE.PointLight | null = null;
  public setLandmarkDetail(enabled: boolean): void { this.landmarkDetail = enabled; }
  public scene: THREE.Scene;
  public terrain: TerrainGenerator;
  public branding: WorldBranding | null = null;
  public boxColliders: BoxCollider[] = [];
  public cylinderColliders: CylinderCollider[] = [];
  public walkableSurfaces: WalkableSurface[] = [];
  public destructibles: Map<string, DestructibleProp> = new Map();
  private initialWorldProps: Array<{
    prop: DestructibleProp;
    boxCollider?: BoxCollider;
    cylCollider?: CylinderCollider;
    walkableSurface?: WalkableSurface;
  }> = [];
  public raycastMeshes: THREE.Object3D[] = [];
  public chestSpawnPoints: THREE.Vector3[] = [];
  public lootSpawnPoints: THREE.Vector3[] = [];
  /** Fixed, sub-legendary loot found while climbing the central tower. */
  public legendaryTowerFloorLootItems: LootItemState[] = [];
  /** The unique rooftop vault registry (server-owned in online matches). */
  public legendaryTowerVaultLootItems: LootItemState[] = [];
  public legendaryTowerBaseY = 4.5;
  public legendaryTowerRoofY = 50.55;
  public occupiedBuildCells: Set<string> = new Set();

  private raycaster = new THREE.Raycaster();
  private worldGroup = new THREE.Group();
  public foliageGroup = new THREE.Group();
  public propInstancesGroup = new THREE.Group();
  public readonly mapExpansion: MapExpansionBuilder;
  public readonly expansionGroup: THREE.Group;
  public readonly expansionDetailGroup: THREE.Group;
  public readonly detailFoliageGroup: THREE.Group;
  private activeAnimatedProps: Set<DestructibleProp> = new Set();
  private sharedMaterials: Map<string, THREE.MeshStandardMaterial> = new Map();

  private pendingTreeInstances: Array<{
    prop: DestructibleProp;
    x: number;
    y: number;
    z: number;
    style: 'pine' | 'oak' | 'blossom' | 'palm' | 'birch';
  }> = [];
  private pendingRockInstances: Array<{
    prop: DestructibleProp;
    x: number;
    y: number;
    z: number;
    radius: number;
  }> = [];
  private pendingCrateInstances: Array<{
    prop: DestructibleProp;
    x: number;
    y: number;
    z: number;
  }> = [];

  // Holographic 3D Build Placement Preview
  private buildPreviewGroup = new THREE.Group();
  private previewWallMesh: THREE.Group;
  private previewRampMesh: THREE.Group;
  private previewFloorMesh: THREE.Group;
  private previewRoofMesh: THREE.Group;
  private previewMatValid: THREE.MeshBasicMaterial;
  private previewMatInvalid: THREE.MeshBasicMaterial;
  private previewLineValid: THREE.LineBasicMaterial;
  private previewLineInvalid: THREE.LineBasicMaterial;

  private monumentCrystal: THREE.Mesh | null = null;
  private legendaryTowerCrystalBaseY = 0;
  private legendaryTowerBeaconGroup: THREE.Group | null = null;
  private legendaryTowerParticles: THREE.Points | null = null;
  private ruinObeliskCrystal: THREE.Mesh | null = null;
  private windmillBlades: THREE.Group | null = null;
  private lighthouseBeam: THREE.Group | null = null;
  private patternTextures: Map<string, THREE.CanvasTexture | null> = new Map();
  private animTime = 0;

  private getPatternTexture(kind: 'wood' | 'stone' | 'metal'): THREE.CanvasTexture | null {
    if (this.patternTextures.has(kind)) {
      return this.patternTextures.get(kind) || null;
    }
    if (typeof document === 'undefined') {
      this.patternTextures.set(kind, null);
      return null;
    }
    // Phase C: readable material patterns instead of bare outlines. The base
    // stays near-white and only luminance varies, so the wall colour passed in
    // by each building still controls the hue.
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Deterministic per-pixel jitter: no Math.random, no per-frame work.
    let seed = kind === 'wood' ? 1013 : kind === 'stone' ? 2027 : 3041;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967295;
    };
    const shade = (base: number, spread: number) => {
      const v = Math.round(Math.min(255, Math.max(0, base + (rnd() - 0.5) * spread)));
      return `rgb(${v},${v},${v})`;
    };

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    if (kind === 'stone') {
      // Running-bond brick. 8 courses of 16px, 2px mortar, per-brick tone.
      const course = 16;
      const brick = 32;
      for (let row = 0; row < size / course; row++) {
        const y = row * course;
        const offset = row % 2 === 0 ? 0 : brick / 2;
        for (let x = -brick; x < size + brick; x += brick) {
          const bx = x + offset;
          ctx.fillStyle = shade(244, 22);
          ctx.fillRect(bx + 1, y + 1, brick - 2, course - 2);
        }
        // Mortar joints sit slightly darker than the brick faces.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
        ctx.fillRect(0, y, size, 1);
      }
      ctx.fillStyle = 'rgba(0, 0, 0, 0.10)';
      for (let row = 0; row < size / course; row++) {
        const offset = row % 2 === 0 ? 0 : brick / 2;
        for (let x = -brick; x < size + brick; x += brick) {
          ctx.fillRect(x + offset, row * course, 1, course);
        }
      }
    } else if (kind === 'wood') {
      // Horizontal cladding boards with grain streaks and dark seams.
      const board = 21;
      for (let y = 0; y < size; y += board) {
        ctx.fillStyle = shade(247, 16);
        ctx.fillRect(0, y, size, board - 1);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.10)';
        ctx.lineWidth = 1;
        for (let g = 0; g < 7; g++) {
          const gy = y + 3 + rnd() * (board - 6);
          const gx = rnd() * size;
          const gw = 18 + rnd() * 46;
          ctx.beginPath();
          ctx.moveTo(gx, gy);
          ctx.lineTo(gx + gw, gy + (rnd() - 0.5) * 1.5);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
        ctx.fillRect(0, y + board - 1, size, 1);
      }
    } else {
      // Brushed metal panel: seam frame, horizontal grain, corner rivets.
      ctx.fillStyle = shade(246, 10);
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.16)';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, size - 2, size - 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 1;
      for (let g = 0; g < 40; g++) {
        const gy = rnd() * size;
        const gx = rnd() * size * 0.5;
        ctx.beginPath();
        ctx.moveTo(gx, gy);
        ctx.lineTo(gx + 30 + rnd() * 70, gy);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(0, 0, 0, 0.20)';
      for (const c of [9, size - 9]) {
        for (const r of [9, size - 9]) {
          ctx.beginPath();
          ctx.arc(c, r, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 2);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.patternTextures.set(kind, tex);
    return tex;
  }

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.terrain = new TerrainGenerator();
    this.scene.add(this.worldGroup);
    this.scene.add(this.foliageGroup);
    this.mapExpansion = new MapExpansionBuilder(this, this.scene);
    this.expansionGroup = this.mapExpansion.expansionGroup;
    this.expansionDetailGroup = this.mapExpansion.expansionDetailGroup;
    this.detailFoliageGroup = this.mapExpansion.detailFoliageGroup;

    this.previewMatValid = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.previewMatInvalid = new THREE.MeshBasicMaterial({
      color: 0xef4444,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.previewLineValid = new THREE.LineBasicMaterial({
      color: 0xbae6fd,
      transparent: true,
      opacity: 0.9,
    });
    this.previewLineInvalid = new THREE.LineBasicMaterial({
      color: 0xfca5a5,
      transparent: true,
      opacity: 0.9,
    });

    this.previewWallMesh = this.createPreviewGroupWithEdges(
      new THREE.BoxGeometry(3.6, 3.2, 0.35),
      0,
      1.6,
      0
    );

    const rampSlopeLen = Math.hypot(3.6, 2.8);
    this.previewRampMesh = this.createPreviewGroupWithEdges(
      new THREE.BoxGeometry(3.2, 0.25, rampSlopeLen),
      0,
      1.4,
      0,
      Math.atan2(2.8, 3.6)
    );

    this.previewFloorMesh = this.createPreviewGroupWithEdges(
      new THREE.BoxGeometry(3.6, 0.28, 3.6),
      0,
      0.14,
      0
    );

    this.previewRoofMesh = this.createPreviewGroupWithEdges(
      new THREE.ConeGeometry(2.6, 1.9, 4),
      0,
      0.95,
      0,
      0,
      Math.PI / 4
    );

    this.buildPreviewGroup.add(
      this.previewWallMesh,
      this.previewRampMesh,
      this.previewFloorMesh,
      this.previewRoofMesh
    );
    this.buildPreviewGroup.visible = false;
    this.scene.add(this.buildPreviewGroup);
  }

  private createPreviewGroupWithEdges(
    geo: THREE.BufferGeometry,
    px: number,
    py: number,
    pz: number,
    rotX: number = 0,
    rotY: number = 0
  ): THREE.Group {
    const g = new THREE.Group();
    const fill = new THREE.Mesh(geo, this.previewMatValid);
    fill.name = 'preview_fill';
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      this.previewLineValid
    );
    edges.name = 'preview_edges';
    g.add(fill, edges);
    g.position.set(px, py, pz);
    g.rotation.set(rotX, rotY, 0);
    return g;
  }

  public generate(): void {
    this.terrain.buildTerrain(this.scene);
    this.scene.add(this.propInstancesGroup);

    this.buildPipelinePlaza();
    this.buildDockerDocks();
    this.buildKubernetesKeep();
    this.buildGitGrove();
    this.buildServerSilos();
    this.buildMirrorLakeAndBridge();
    this.buildFrontendFarms();
    this.buildLegacyRuins();
    // Additive districts register their colliders/loot before procedural
    // wilderness placement, allowing every later tree/rock/crate pass to
    // reject building footprints deterministically.
    this.buildLegendaryTowerLootDefinitions();
    this.mapExpansion.buildDistricts();
    this.buildLegendaryTowerFx();
    this.populateWilderness();
    this.mapExpansion.populateVegetation();
    this.buildInstancedWorldProps();
    this.buildInstancedFoliage();
    this.mapExpansion.buildDetailFoliage();
    this.mapExpansion.finalizeArchitecture();
    this.branding?.dispose();
    this.branding = new WorldBranding(this.scene, this.terrain.terrainMesh.geometry,
      (x, z) => this.terrain.getTerrainHeight(x, z));
  }

  private disposeObject3D(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => m.dispose());
        } else {
          mesh.material.dispose();
        }
      }
    });
  }

  public resetDynamicStructures(): void {
    this.occupiedBuildCells.clear();
    this.activeAnimatedProps.clear();
    const toRemove: string[] = [];
    for (const [id, prop] of this.destructibles.entries()) {
      if (prop.type === 'buildable') {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      const prop = this.destructibles.get(id);
      if (prop) {
        this.worldGroup.remove(prop.mesh);
        const rIdx = this.raycastMeshes.indexOf(prop.mesh);
        if (rIdx !== -1) this.raycastMeshes.splice(rIdx, 1);
        this.disposeObject3D(prop.mesh);
      }
      this.destructibles.delete(id);
      this.boxColliders = this.boxColliders.filter((c) => c.destructibleId !== id);
      this.cylinderColliders = this.cylinderColliders.filter((c) => c.destructibleId !== id);
      this.walkableSurfaces = this.walkableSurfaces.filter((s) => s.id !== id);
    }

    // Restore any harvested/destroyed world props (trees, rocks, crates, fences) to full health
    for (const entry of this.initialWorldProps) {
      const { prop, boxCollider, cylCollider, walkableSurface } = entry;
      const wasDestroyed = !this.destructibles.has(prop.id);
      prop.health = prop.maxHealth;
      prop.hitShakeTimer = 0;
      if (prop.updateInstanceTransform && (wasDestroyed || prop.mesh.rotation.z !== 0)) {
        prop.updateInstanceTransform(1, 0);
      }
      if (prop.type !== 'rock') {
        prop.mesh.rotation.z = 0;
      }
      if (wasDestroyed) {
        this.destructibles.set(prop.id, prop);
        if (boxCollider && !this.boxColliders.some((c) => c.id === boxCollider.id)) {
          this.boxColliders.push(boxCollider);
        }
        if (cylCollider && !this.cylinderColliders.some((c) => c.id === cylCollider.id)) {
          this.cylinderColliders.push(cylCollider);
        }
        if (
          walkableSurface &&
          !this.walkableSurfaces.some((s) => s.id === walkableSurface.id)
        ) {
          this.walkableSurfaces.push(walkableSurface);
        }
      }
    }
  }

  private buildLegendaryTowerLootDefinitions(): void {
    this.legendaryTowerBaseY = this.terrain.getTerrainHeight(
      LEGENDARY_TOWER.x,
      LEGENDARY_TOWER.z
    );
    this.legendaryTowerRoofY = getLegendaryTowerFloorHeight(
      this.legendaryTowerBaseY,
      LEGENDARY_TOWER.roofLevel
    );

    const toLootItem = (
      definition: (typeof LEGENDARY_TOWER_FLOOR_LOOT)[number],
      isVault: boolean
    ): LootItemState => ({
      id: definition.id,
      itemType: definition.itemType,
      weaponCategory: definition.weaponCategory,
      ammoType: definition.ammoType,
      materialType: definition.materialType,
      rarity: definition.rarity,
      name: definition.name,
      amount: definition.amount,
      position: {
        x: LEGENDARY_TOWER.x + definition.x,
        y:
          getLegendaryTowerFloorHeight(this.legendaryTowerBaseY, definition.floor) +
          definition.yOffset,
        z: LEGENDARY_TOWER.z + definition.z,
      },
      opened: false,
      isLegendaryTowerLoot: isVault || undefined,
      serverAuthoritative: isVault || undefined,
    });

    this.legendaryTowerFloorLootItems = LEGENDARY_TOWER_FLOOR_LOOT.map((definition) =>
      toLootItem(definition, false)
    );
    this.legendaryTowerVaultLootItems = LEGENDARY_TOWER_VAULT_LOOT.map((definition) =>
      toLootItem(definition, true)
    );
  }

  /**
   * A deliberately tiny animated layer (two additive beams, two rings, one
   * rotating crystal and one 56-point particle spiral) makes the vault
   * readable from the coast without adding a per-frame particle system or a
   * forest of dynamic lights. The tower's architecture itself is instanced
   * by MapExpansionBuilder.
   */
  private buildLegendaryTowerFx(): void {
    const roofY = this.legendaryTowerRoofY;
    const group = new THREE.Group();
    group.name = 'LegendaryTowerBeaconFx';
    group.position.set(LEGENDARY_TOWER.x, roofY, LEGENDARY_TOWER.z);

    // The beacon is intentionally exempt from scene fog and frustum
    // culling. Its two low-segment additive cylinders cost almost nothing,
    // while fog:false keeps the gold column readable from the island coast
    // (about 230 m away) on every graphics tier instead of letting distance
    // fog wash it into the sky colour.
    const goldBeamMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const goldBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.7, 3.4, 64, 12, 1, true),
      goldBeamMat
    );
    goldBeam.name = 'LegendaryTowerBeaconBeam';
    goldBeam.position.y = 32;
    goldBeam.renderOrder = 20;
    goldBeam.frustumCulled = false;
    group.add(goldBeam);

    const cyanBeamMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const cyanBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.38, 0.85, 48, 8, 1, true),
      cyanBeamMat
    );
    cyanBeam.name = 'LegendaryTowerEnergyBeam';
    cyanBeam.position.y = 24;
    cyanBeam.renderOrder = 21;
    cyanBeam.frustumCulled = false;
    group.add(cyanBeam);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xfde047,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    });
    for (const [radius, y, tilt] of [
      [4.6, 5.9, 0.18],
      [3.1, 8.2, -0.24],
      [6.2, 14.0, 0.1],
    ] as const) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.055, 6, 40), ringMat);
      ring.name = 'LegendaryTowerBeaconRing';
      ring.position.y = y;
      ring.rotation.x = Math.PI / 2 + tilt;
      ring.frustumCulled = false;
      group.add(ring);
    }

    const crystalMat = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      emissive: 0xa855f7,
      emissiveIntensity: 0.72,
      metalness: 0.35,
      roughness: 0.22,
      flatShading: true,
      fog: false,
    });
    this.monumentCrystal = new THREE.Mesh(new THREE.OctahedronGeometry(1.15, 0), crystalMat);
    this.monumentCrystal.name = 'LegendaryTowerVaultCrystal';
    this.monumentCrystal.frustumCulled = false;
    this.legendaryTowerCrystalBaseY = roofY + 7.6;
    this.monumentCrystal.position.set(
      LEGENDARY_TOWER.x,
      this.legendaryTowerCrystalBaseY,
      LEGENDARY_TOWER.z
    );
    this.worldGroup.add(this.monumentCrystal);

    const particleCount = 56;
    const positions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      const t = i / particleCount;
      const angle = t * Math.PI * 8;
      const radius = 2.3 + Math.sin(t * Math.PI * 3) * 1.15;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = 0.6 + t * 10.5;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.legendaryTowerParticles = new THREE.Points(
      particleGeo,
      new THREE.PointsMaterial({
        color: 0xfde68a,
        size: 0.24,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      })
    );
    this.legendaryTowerParticles.name = 'LegendaryTowerVaultParticles';
    this.legendaryTowerParticles.frustumCulled = false;
    group.add(this.legendaryTowerParticles);

    const vaultLight = new THREE.PointLight(0xfacc15, 85, 34, 2);
    vaultLight.name = 'LegendaryTowerVaultLight';
    this.vaultLight = vaultLight;
    vaultLight.position.y = 4.2;
    group.add(vaultLight);

    this.legendaryTowerBeaconGroup = group;
    this.worldGroup.add(group);
  }

  private createEnterableHouse(
    cx: number,
    cz: number,
    width: number,
    depth: number,
    height: number,
    wallColor: number,
    roofColor: number,
    hasSecondFloor: boolean = true
  ): void {
    const baseY = this.terrain.getTerrainHeight(cx, cz);
    const group = new THREE.Group();
    group.position.set(cx, baseY, cz);

    // Phase C: the brick pattern doubles as a shallow bump so courses read as
    // relief rather than paint. Same cached texture, no extra upload.
    const wallPattern = this.getPatternTexture('stone');
    const wallMat = new THREE.MeshStandardMaterial({
      color: wallColor,
      map: wallPattern,
      bumpMap: wallPattern,
      bumpScale: 0.3,
      flatShading: true,
      roughness: 0.86,
      metalness: 0.0,
      envMapIntensity: 0.55,
    });
    const roofMat = new THREE.MeshStandardMaterial({
      color: roofColor,
      flatShading: true,
      roughness: 0.55,
    });
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0xd6d3d1,
      flatShading: true,
      roughness: 0.82,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      flatShading: true,
      roughness: 0.55,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x7dd3fc,
      emissive: 0x0284c7,
      emissiveIntensity: 0.35,
      transparent: true,
      opacity: 0.55,
    });

    const wallThick = 0.45;
    const hw = width / 2;
    const hd = depth / 2;

    const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.3, depth), floorMat);
    floorMesh.position.set(0, 0.15, 0);
    floorMesh.receiveShadow = true;
    group.add(floorMesh);

    this.walkableSurfaces.push({
      minX: cx - hw,
      maxX: cx + hw,
      minZ: cz - hd,
      maxZ: cz + hd,
      getHeight: () => baseY + 0.3,
    });

    // Back Wall (-Z) with framed window & glowing glass pane
    const winW = 2.4;
    const backSideW = (width - winW) / 2;
    this.addWallSegment(group, cx, baseY, cz, -hw + backSideW / 2, height / 2, -hd, backSideW, height, wallThick, wallMat);
    this.addWallSegment(group, cx, baseY, cz, hw - backSideW / 2, height / 2, -hd, backSideW, height, wallThick, wallMat);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(winW, 1.1, wallThick), wallMat);
    sill.position.set(0, 0.55, -hd);
    const header = new THREE.Mesh(new THREE.BoxGeometry(winW, height - 2.6, wallThick), wallMat);
    header.position.set(0, height - (height - 2.6) / 2, -hd);
    const winGlass = new THREE.Mesh(new THREE.BoxGeometry(winW - 0.1, 1.5, 0.08), glassMat);
    winGlass.position.set(0, 1.85, -hd);
    const winFrame = new THREE.Mesh(new THREE.BoxGeometry(winW + 0.2, 0.12, wallThick + 0.12), trimMat);
    winFrame.position.set(0, 1.12, -hd);
    group.add(sill, header, winGlass, winFrame);

    // Left Wall (-X) + exterior trim
    this.addWallSegment(group, cx, baseY, cz, -hw, height / 2, 0, wallThick, height, depth, wallMat);

    // Right Wall (+X)
    this.addWallSegment(group, cx, baseY, cz, hw, height / 2, 0, wallThick, height, depth, wallMat);

    // Front Wall (+Z) with wide doorway + awning
    const doorWidth = 2.8;
    const sideWidth = (width - doorWidth) / 2;
    this.addWallSegment(
      group,
      cx,
      baseY,
      cz,
      -hw + sideWidth / 2,
      height / 2,
      hd,
      sideWidth,
      height,
      wallThick,
      wallMat
    );
    this.addWallSegment(
      group,
      cx,
      baseY,
      cz,
      hw - sideWidth / 2,
      height / 2,
      hd,
      sideWidth,
      height,
      wallThick,
      wallMat
    );
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorWidth, height - 3.0, wallThick), wallMat);
    lintel.position.set(0, height - (height - 3.0) / 2, hd);
    const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(doorWidth + 0.4, 0.22, wallThick + 0.2), trimMat);
    doorFrame.position.set(0, 3.05, hd);
    const awning = new THREE.Mesh(new THREE.BoxGeometry(doorWidth + 1.0, 0.16, 1.2), roofMat);
    awning.position.set(0, 3.25, hd + 0.55);
    awning.rotation.x = 0.2;
    const doorStep = new THREE.Mesh(new THREE.BoxGeometry(doorWidth + 0.8, 0.18, 0.85), trimMat);
    doorStep.position.set(0, 0.09, hd + 0.35);
    const extLantern = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xfef08a })
    );
    extLantern.position.set(doorWidth / 2 + 0.45, 2.55, hd + 0.28);
    group.add(lintel, doorFrame, awning, doorStep, extLantern);

    // Exterior Corner Stone Pilasters / Quoins for crisp architectural silhouette
    for (const [qx, qz] of [
      [-hw, -hd],
      [hw, -hd],
      [-hw, hd],
      [hw, hd],
    ]) {
      const quoin = new THREE.Mesh(
        new THREE.BoxGeometry(0.62, height + 0.1, 0.62),
        trimMat
      );
      quoin.position.set(qx, height / 2, qz);
      group.add(quoin);
    }

    // Rich Interior Details: Tech Desk + Dual Glowing Monitors + Chair + Server Rack + Bookshelf + Ceiling Lamp
    const woodDarkMat = new THREE.MeshStandardMaterial({ color: 0x78350f, flatShading: true });
    const rackMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, flatShading: true });
    const screenMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const tableTop = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.14, 1.05), woodDarkMat);
    tableTop.position.set(hw * 0.45, 0.95, -hd * 0.52);
    const tableLeg = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.85, 0.85), woodDarkMat);
    tableLeg.position.set(hw * 0.45, 0.48, -hd * 0.52);
    const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.48, 0.08), screenMat);
    monitor.position.set(hw * 0.32, 1.28, -hd * 0.65);
    const monitor2 = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.44, 0.08), screenMat);
    monitor2.position.set(hw * 0.62, 1.26, -hd * 0.62);
    monitor2.rotation.y = -0.25;
    const chairSeat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.52, 0.55), rackMat);
    chairSeat.position.set(hw * 0.45, 0.42, -hd * 0.18);
    const serverRack = new THREE.Mesh(new THREE.BoxGeometry(0.75, 2.35, 0.85), rackMat);
    serverRack.position.set(-hw + 0.65, 1.32, -hd * 0.52);
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.55, 2.2, 1.8), woodDarkMat);
    shelf.position.set(-hw + 0.55, 1.25, hd * 0.22);
    const ceilingLamp = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.45, 0.16, 8),
      new THREE.MeshBasicMaterial({ color: 0xfef08a })
    );
    ceilingLamp.position.set(0, height - 0.12, 0);
    group.add(
      tableTop,
      tableLeg,
      monitor,
      monitor2,
      chairSeat,
      serverRack,
      shelf,
      ceilingLamp
    );

    // Roof / Upper Floor Deck
    const roofDeck = new THREE.Mesh(new THREE.BoxGeometry(width + 0.7, 0.35, depth + 0.7), roofMat);
    roofDeck.position.set(0, height + 0.15, 0);
    roofDeck.castShadow = true;
    roofDeck.receiveShadow = true;
    group.add(roofDeck);
    this.raycastMeshes.push(roofDeck);

    this.walkableSurfaces.push({
      minX: cx - hw - 0.35,
      maxX: cx + hw + 0.35,
      minZ: cz - hd - 0.35,
      maxZ: cz + hd + 0.35,
      getHeight: () => baseY + height + 0.32,
    });

    if (hasSecondFloor) {
      const parapetL = new THREE.Mesh(new THREE.BoxGeometry(width * 0.42, 0.9, 0.32), trimMat);
      parapetL.position.set(-hw * 0.5, height + 0.75, hd);
      const parapetR = new THREE.Mesh(new THREE.BoxGeometry(width * 0.42, 0.9, 0.32), trimMat);
      parapetR.position.set(hw * 0.5, height + 0.75, -hd);
      const acUnit = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 1.15, 1.25),
        new THREE.MeshStandardMaterial({ color: 0x64748b, flatShading: true })
      );
      acUnit.position.set(-hw * 0.5, height + 0.85, -hd * 0.4);
      const antenna = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.08, 2.6, 6),
        new THREE.MeshStandardMaterial({ color: 0x94a3b8 })
      );
      antenna.position.set(-hw * 0.5, height + 2.1, -hd * 0.4);
      group.add(parapetL, parapetR, acUnit, antenna);

      const rampWidth = 2.4;
      const rampLen = depth * 0.95;
      const rampOriginX = cx + hw + rampWidth / 2 + 0.2;
      const rampMinZ = cz - rampLen / 2;
      const rampMaxZ = cz + rampLen / 2;

      const rampSlopeLen = Math.hypot(rampLen, height);
      const rampAngle = Math.atan2(height, rampLen);
      const rampMesh = new THREE.Mesh(
        new THREE.BoxGeometry(rampWidth, 0.25, rampSlopeLen),
        new THREE.MeshStandardMaterial({ color: 0xb45309, flatShading: true })
      );
      rampMesh.position.set(hw + rampWidth / 2 + 0.2, height / 2, 0);
      rampMesh.rotation.x = rampAngle;
      rampMesh.castShadow = true;
      rampMesh.receiveShadow = true;
      group.add(rampMesh);
      this.raycastMeshes.push(rampMesh);

      this.walkableSurfaces.push({
        minX: rampOriginX - rampWidth / 2,
        maxX: rampOriginX + rampWidth / 2,
        minZ: rampMinZ,
        maxZ: rampMaxZ,
        getHeight: (_px: number, pz: number) => {
          const t = Math.max(0, Math.min(1, (rampMaxZ - pz) / (rampMaxZ - rampMinZ)));
          return baseY + t * (height + 0.32);
        },
      });

      this.lootSpawnPoints.push(new THREE.Vector3(cx, baseY + height + 0.6, cz));
    } else {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(Math.max(width, depth) * 0.78, 2.8, 4),
        roofMat
      );
      cone.position.set(0, height + 1.55, 0);
      cone.rotation.y = Math.PI / 4;
      cone.castShadow = true;
      group.add(cone);
    }

    this.chestSpawnPoints.push(new THREE.Vector3(cx - hw * 0.45, baseY + 0.4, cz - hd * 0.45));
    this.lootSpawnPoints.push(new THREE.Vector3(cx + hw * 0.35, baseY + 0.4, cz + 0.5));

    this.worldGroup.add(group);
  }

  private addWallSegment(
    group: THREE.Group,
    originX: number,
    originY: number,
    originZ: number,
    lx: number,
    ly: number,
    lz: number,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material
  ): void {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(lx, ly, lz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    const wx = originX + lx;
    const wy = originY + ly;
    const wz = originZ + lz;
    this.boxColliders.push({
      id: `wall_${this.boxColliders.length}`,
      minX: wx - w / 2,
      maxX: wx + w / 2,
      minY: wy - h / 2,
      maxY: wy + h / 2,
      minZ: wz - d / 2,
      maxZ: wz + d / 2,
    });
  }

  private buildPipelinePlaza(): void {
    this.createEnterableHouse(-18, -16, 11, 10, 4.6, 0x38bdf8, 0x0284c7, true);
    this.createEnterableHouse(18, -16, 11, 10, 4.6, 0xf472b6, 0xdb2777, true);
    this.createEnterableHouse(-18, 16, 10, 9, 4.4, 0xfacc15, 0xd97706, false);
    this.createEnterableHouse(18, 16, 11, 10, 4.6, 0x4ade80, 0x16a34a, true);

    const baseY = this.terrain.getTerrainHeight(0, 0);
    // The small former monument has been replaced by The Legendary Tower.
    // MapExpansionBuilder constructs that 22 m core with instanced meshes
    // after the original houses, preserving these four Plaza buildings just
    // outside the tower footprint. The animated crystal is recreated as the
    // tower's rooftop vault crystal in buildLegendaryTowerFx().

    const lampPositions = [
      [-17, 0],
      [17, 0],
      [0, -17],
      [0, 17],
    ];
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x334155, flatShading: true });
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
    for (const [lx, lz] of lampPositions) {
      const ly = this.terrain.getTerrainHeight(lx, lz);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 4.4, 6), poleMat);
      pole.position.set(lx, ly + 2.2, lz);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8), bulbMat);
      bulb.position.set(lx, ly + 4.5, lz);
      const banner = new THREE.Mesh(
        new THREE.BoxGeometry(0.65, 1.35, 0.06),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
      );
      banner.position.set(lx + 0.38, ly + 3.3, lz);
      this.worldGroup.add(pole, bulb, banner);
    }

    // Plaza Stone Planters & Tactical Low Cover Barriers
    const planterMat = new THREE.MeshStandardMaterial({ color: 0x64748b, flatShading: true });
    const bushTopMat = new THREE.MeshStandardMaterial({ color: 0x22c55e, flatShading: true });
    for (const [px, pz] of [
      [-20, -5],
      [20, 5],
      [-5, -20],
      [5, 20],
    ]) {
      const py = this.terrain.getTerrainHeight(px, pz);
      const planter = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.95, 1.2), planterMat);
      planter.position.set(px, py + 0.48, pz);
      planter.castShadow = true;
      const shrub = new THREE.Mesh(new THREE.DodecahedronGeometry(0.68, 0), bushTopMat);
      shrub.position.set(px, py + 1.15, pz);
      this.worldGroup.add(planter, shrub);
      this.raycastMeshes.push(planter);
      this.boxColliders.push({
        id: `plaza_planter_${px}_${pz}`,
        minX: px - 1.2,
        maxX: px + 1.2,
        minY: py,
        maxY: py + 1.0,
        minZ: pz - 0.6,
        maxZ: pz + 0.6,
      });
    }

    this.chestSpawnPoints.push(new THREE.Vector3(-16, baseY + 0.4, 6));
    this.lootSpawnPoints.push(new THREE.Vector3(16, baseY + 0.4, -6));
    this.lootSpawnPoints.push(new THREE.Vector3(-6, baseY + 0.4, 16));

    this.spawnCrate(16, 6);
    this.spawnCrate(-16, -6);
    this.spawnCrate(6, -16);
  }

  private buildDockerDocks(): void {
    const poi = ISLAND_POIS[1];
    this.createEnterableHouse(poi.x, poi.z - 12, 14, 10, 5.0, 0xf97316, 0x9a3412, true);

    const pierX = poi.x - 22;
    const pierZ = poi.z + 22;
    const pierLength = 19;
    const pierNorthY = this.terrain.getTerrainHeight(pierX, pierZ - pierLength / 2);
    const pierSouthY = this.terrain.getTerrainHeight(pierX, pierZ + pierLength / 2);
    const pierY = (pierNorthY + pierSouthY) / 2 + 0.35;
    const pierDeckHeightAt = (z: number): number =>
      pierY + 0.2 + ((z - pierZ) / pierLength) * (pierSouthY - pierNorthY);
    const pierMat = new THREE.MeshStandardMaterial({ color: 0x92400e, flatShading: true });
    const pierDeck = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.4, pierLength), pierMat);
    pierDeck.position.set(pierX, pierY, pierZ);
    // Follow the harbour slope instead of burying the southern deck end.
    pierDeck.rotation.x = Math.atan2(pierNorthY - pierSouthY, pierLength);
    pierDeck.receiveShadow = true;
    this.worldGroup.add(pierDeck);
    this.raycastMeshes.push(pierDeck);

    // Harbor Mooring Bollards & Support Pilings along the Pier
    const bollardMat = new THREE.MeshStandardMaterial({ color: 0x334155, flatShading: true });
    for (const dz of [-7, 0, 7]) {
      const deckY = pierDeckHeightAt(pierZ + dz) - 0.2;
      const pilingL = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 3.2, 6), pierMat);
      pilingL.position.set(pierX - 3.0, deckY - 1.4, pierZ + dz);
      const pilingR = pilingL.clone();
      pilingR.position.x = pierX + 3.0;
      const bollard = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.55, 6), bollardMat);
      bollard.position.set(pierX - 2.8, deckY + 0.45, pierZ + dz);
      this.worldGroup.add(pilingL, pilingR, bollard);
    }

    this.walkableSurfaces.push({
      minX: pierX - 3.4,
      maxX: pierX + 3.4,
      minZ: pierZ - 9.5,
      maxZ: pierZ + 9.5,
      getHeight: (_x: number, z: number) => pierDeckHeightAt(z),
    });
    this.chestSpawnPoints.push(
      new THREE.Vector3(pierX, pierDeckHeightAt(pierZ + 6) + 0.15, pierZ + 6)
    );

    // Industrial Yellow Harbor Crane + Coastal Lighthouse
    const craneMat = new THREE.MeshStandardMaterial({ color: 0xeab308, flatShading: true });
    const craneX = poi.x - 16;
    const craneZ = poi.z + 4;
    const craneY = this.terrain.getTerrainHeight(craneX, craneZ);
    const craneMast = new THREE.Mesh(new THREE.BoxGeometry(1.4, 13.5, 1.4), craneMat);
    craneMast.position.set(craneX, craneY + 6.75, craneZ);
    craneMast.castShadow = true;
    const craneBoom = new THREE.Mesh(new THREE.BoxGeometry(11.5, 1.1, 1.2), craneMat);
    craneBoom.position.set(craneX + 4.2, craneY + 13.0, craneZ);
    this.worldGroup.add(craneMast, craneBoom);
    this.boxColliders.push({
      id: 'harbor_crane',
      minX: craneX - 0.7,
      maxX: craneX + 0.7,
      minY: craneY,
      maxY: craneY + 13.5,
      minZ: craneZ - 0.7,
      maxZ: craneZ + 0.7,
    });

    // Coastal Lighthouse Beacon at (-136, 122)
    const lhX = poi.x - 30;
    const lhZ = poi.z + 26;
    const lhY = Math.max(0.8, this.terrain.getTerrainHeight(lhX, lhZ));
    const lhBody = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 2.3, 12.5, 8),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, flatShading: true })
    );
    lhBody.position.set(lhX, lhY + 6.25, lhZ);
    const lhBand = new THREE.Mesh(
      new THREE.CylinderGeometry(1.85, 2.05, 3.2, 8),
      new THREE.MeshStandardMaterial({ color: 0xef4444, flatShading: true })
    );
    lhBand.position.set(lhX, lhY + 6.0, lhZ);
    const lhTop = new THREE.Mesh(
      new THREE.ConeGeometry(2.1, 2.4, 8),
      new THREE.MeshStandardMaterial({ color: 0xef4444, flatShading: true })
    );
    lhTop.position.set(lhX, lhY + 13.6, lhZ);
    this.lighthouseBeam = new THREE.Group();
    this.lighthouseBeam.position.set(lhX, lhY + 12.2, lhZ);
    const beamCone = new THREE.Mesh(
      new THREE.ConeGeometry(2.2, 18, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xfef08a,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    beamCone.rotation.z = Math.PI / 2;
    beamCone.position.x = 9;
    this.lighthouseBeam.add(beamCone);
    this.worldGroup.add(lhBody, lhBand, lhTop, this.lighthouseBeam);
    this.cylinderColliders.push({
      id: 'lighthouse',
      x: lhX,
      z: lhZ,
      radius: 2.2,
      minY: lhY,
      maxY: lhY + 12.5,
    });

    const containerColors = [0x0284c7, 0xef4444, 0x22c55e, 0xeab308];
    const offsets = [
      { dx: -12, dz: 6 },
      { dx: -5, dz: 10 },
      { dx: 10, dz: 6 },
      { dx: 14, dz: -4 },
    ];
    offsets.forEach((off, idx) => {
      const cx = poi.x + off.dx;
      const cz = poi.z + off.dz;
      const cy = this.terrain.getTerrainHeight(cx, cz);
      const mat = new THREE.MeshStandardMaterial({
        color: containerColors[idx % containerColors.length],
        flatShading: true,
        roughness: 0.6,
      });
      const container = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3.0, 6.8), mat);
      container.position.set(cx, cy + 1.5, cz);
      container.castShadow = true;
      container.receiveShadow = true;
      const doorTrim = new THREE.Mesh(new THREE.BoxGeometry(2.9, 2.7, 7.0), bollardMat);
      doorTrim.position.set(cx, cy + 1.5, cz);
      this.worldGroup.add(container, doorTrim);
      this.raycastMeshes.push(container);
      this.boxColliders.push({
        id: `container_${idx}`,
        minX: cx - 1.6,
        maxX: cx + 1.6,
        minY: cy,
        maxY: cy + 3.0,
        minZ: cz - 3.4,
        maxZ: cz + 3.4,
      });
      this.walkableSurfaces.push({
        minX: cx - 1.6,
        maxX: cx + 1.6,
        minZ: cz - 3.4,
        maxZ: cz + 3.4,
        getHeight: () => cy + 3.0,
      });
      this.lootSpawnPoints.push(new THREE.Vector3(cx + 2.8, cy + 0.4, cz));
    });

    this.chestSpawnPoints.push(new THREE.Vector3(poi.x - 10, poi.baseHeight + 0.4, poi.z + 14));
    this.spawnCrate(poi.x + 5, poi.z + 4);
    this.spawnCrate(poi.x - 4, poi.z + 2);
  }

  private buildKubernetesKeep(): void {
    const poi = ISLAND_POIS[2];
    this.createEnterableHouse(poi.x, poi.z, 13, 13, 5.4, 0xa855f7, 0x6b21a8, true);

    const corners = [
      [-16, -16],
      [16, -16],
      [-16, 16],
      [16, 16],
    ];
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x64748b, flatShading: true });
    const roofConeMat = new THREE.MeshStandardMaterial({ color: 0x7e22ce, flatShading: true });
    const bannerMat = new THREE.MeshBasicMaterial({ color: 0xc084fc });
    for (const [dx, dz] of corners) {
      const tx = poi.x + dx;
      const tz = poi.z + dz;
      const ty = this.terrain.getTerrainHeight(tx, tz);
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.0, 7.8, 7), towerMat);
      tower.position.set(tx, ty + 3.9, tz);
      tower.castShadow = true;
      tower.receiveShadow = true;

      const cap = new THREE.Mesh(new THREE.ConeGeometry(3.4, 2.8, 7), roofConeMat);
      cap.position.set(tx, ty + 9.2, tz);
      const banner = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.4, 0.08), bannerMat);
      banner.position.set(tx, ty + 5.2, tz + (dz > 0 ? 2.85 : -2.85));
      this.worldGroup.add(tower, cap, banner);
      this.raycastMeshes.push(tower);
      this.cylinderColliders.push({
        id: `keep_tower_${tx}_${tz}`,
        x: tx,
        z: tz,
        radius: 2.8,
        minY: ty,
        maxY: ty + 7.8,
      });
    }

    // Castle Perimeter Battlement Walls + Crenellated Merlons between guard towers
    const wallY = poi.baseHeight;
    const northWall = new THREE.Mesh(new THREE.BoxGeometry(26, 3.4, 1.1), towerMat);
    northWall.position.set(poi.x, wallY + 1.7, poi.z - 16);
    northWall.castShadow = true;
    this.worldGroup.add(northWall);
    this.raycastMeshes.push(northWall);
    for (let m = -10; m <= 10; m += 4) {
      const merlon = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.85, 1.25), towerMat);
      merlon.position.set(poi.x + m, wallY + 3.8, poi.z - 16);
      this.worldGroup.add(merlon);
    }
    this.boxColliders.push({
      id: 'keep_north_wall',
      minX: poi.x - 13,
      maxX: poi.x + 13,
      minY: wallY,
      maxY: wallY + 3.4,
      minZ: poi.z - 16.6,
      maxZ: poi.z - 15.4,
    });

    this.chestSpawnPoints.push(new THREE.Vector3(poi.x + 11, poi.baseHeight + 0.4, poi.z - 11));
    this.lootSpawnPoints.push(new THREE.Vector3(poi.x - 10, poi.baseHeight + 0.4, poi.z + 10));
  }

  private buildGitGrove(): void {
    const poi = ISLAND_POIS[3];
    this.createEnterableHouse(poi.x - 11, poi.z - 7, 9, 8, 4.2, 0xb45309, 0x15803d, false);
    this.createEnterableHouse(poi.x + 12, poi.z + 8, 9, 8, 4.2, 0xd97706, 0x166534, true);

    const wy = this.terrain.getTerrainHeight(poi.x, poi.z);
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x92400e, flatShading: true });
    const platform = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.4, 5.8), woodMat);
    platform.position.set(poi.x, wy + 3.8, poi.z);
    this.worldGroup.add(platform);
    this.raycastMeshes.push(platform);
    this.walkableSurfaces.push({
      minX: poi.x - 2.9,
      maxX: poi.x + 2.9,
      minZ: poi.z - 2.9,
      maxZ: poi.z + 2.9,
      getHeight: () => wy + 4.0,
    });

    // Treehouse Corner Posts & Glowing Bioluminescent Forest Lanterns
    const glowLanternMat = new THREE.MeshBasicMaterial({ color: 0x4ade80 });
    for (const [px, pz] of [
      [-2.6, -2.6],
      [2.6, -2.6],
      [-2.6, 2.6],
      [2.6, 2.6],
    ]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 4.8, 6), woodMat);
      post.position.set(poi.x + px, wy + 2.4, poi.z + pz);
      const lantern = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), glowLanternMat);
      lantern.position.set(poi.x + px, wy + 4.95, poi.z + pz);
      this.worldGroup.add(post, lantern);
    }

    const rampLen = 5.5;
    const rampH = 4.0;
    const slope = Math.hypot(rampLen, rampH);
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.25, slope), woodMat);
    ramp.position.set(poi.x, wy + rampH / 2, poi.z + 5.2);
    ramp.rotation.x = Math.atan2(rampH, rampLen);
    this.worldGroup.add(ramp);
    this.raycastMeshes.push(ramp);
    this.walkableSurfaces.push({
      minX: poi.x - 1.2,
      maxX: poi.x + 1.2,
      minZ: poi.z + 2.45,
      maxZ: poi.z + 7.95,
      getHeight: (_px: number, pz: number) => {
        const t = Math.max(0, Math.min(1, (poi.z + 7.95 - pz) / 5.5));
        return wy + t * rampH;
      },
    });

    this.chestSpawnPoints.push(new THREE.Vector3(poi.x, wy + 4.15, poi.z));
    this.lootSpawnPoints.push(new THREE.Vector3(poi.x - 3, wy + 0.4, poi.z + 3));

    for (let i = 0; i < 14; i++) {
      const angle = (i / 14) * Math.PI * 2;
      const r = 21 + (i % 3) * 5;
      const treeX = poi.x + Math.cos(angle) * r;
      const treeZ = poi.z + Math.sin(angle) * r;
      // The additive Grove cabins and secondary roads now occupy a few of
      // the original decorative ring positions; skip only those trees.
      if (this.mapExpansion.isInsideStructure(treeX, treeZ, 1.0) || this.terrain.isOnRoad(treeX, treeZ)) {
        continue;
      }
      this.spawnTree(treeX, treeZ, i % 2 === 0 ? 'blossom' : 'pine');
    }
  }

  private buildServerSilos(): void {
    const poi = ISLAND_POIS[4];
    this.createEnterableHouse(poi.x - 12, poi.z, 10, 10, 4.6, 0x334155, 0xeab308, true);

    const siloMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      metalness: 0.38,
      roughness: 0.42,
      flatShading: true,
    });
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.55,
    });

    for (let i = 0; i < 3; i++) {
      const sx = poi.x + 8;
      const sz = poi.z - 12 + i * 12;
      const sy = this.terrain.getTerrainHeight(sx, sz);

      const silo = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 9.2, 10), siloMat);
      silo.position.set(sx, sy + 4.6, sz);
      silo.castShadow = true;
      silo.receiveShadow = true;
      this.worldGroup.add(silo);
      this.raycastMeshes.push(silo);

      const ring = new THREE.Mesh(new THREE.CylinderGeometry(3.55, 3.55, 0.6, 10), ringMat);
      ring.position.set(sx, sy + 6.6, sz);
      const ring2 = new THREE.Mesh(new THREE.CylinderGeometry(3.55, 3.55, 0.4, 10), ringMat);
      ring2.position.set(sx, sy + 3.2, sz);
      const domeCap = new THREE.Mesh(
        new THREE.SphereGeometry(3.4, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
        siloMat
      );
      domeCap.position.set(sx, sy + 9.2, sz);
      this.worldGroup.add(ring, ring2, domeCap);

      this.cylinderColliders.push({
        id: `silo_${i}`,
        x: sx,
        z: sz,
        radius: 3.45,
        minY: sy,
        maxY: sy + 9.2,
      });
    }

    // Overhead Industrial Cooling Conduit Pipe linking the 3 Silos
    const pipeY = this.terrain.getTerrainHeight(poi.x + 8, poi.z) + 8.2;
    const overheadPipe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.55, 24, 8),
      siloMat
    );
    overheadPipe.rotation.x = Math.PI / 2;
    overheadPipe.position.set(poi.x + 8, pipeY, poi.z);
    this.worldGroup.add(overheadPipe);

    this.chestSpawnPoints.push(new THREE.Vector3(poi.x + 2, poi.baseHeight + 0.4, poi.z));
    this.lootSpawnPoints.push(new THREE.Vector3(poi.x + 2, poi.baseHeight + 0.4, poi.z + 10));
  }

  private buildMirrorLakeAndBridge(): void {
    const isleY = this.terrain.getTerrainHeight(-46, 38);
    this.chestSpawnPoints.push(new THREE.Vector3(-46, Math.max(0.6, isleY) + 0.3, 38));
    this.spawnTree(-48, 36, 'blossom');

    // Decorative Lily Pads & Stepping Stones around Mirror Lake
    const lilyMat = new THREE.MeshStandardMaterial({ color: 0x22c55e, flatShading: true });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = 9.5 + (i % 3) * 3.2;
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.08, 7), lilyMat);
      pad.position.set(-46 + Math.cos(a) * r, -0.22, 38 + Math.sin(a) * r);
      this.worldGroup.add(pad);
    }

    // Lakeside Wooden Fishing Dock + Moored Wooden Rowboat & Lantern Post
    const dockMat = new THREE.MeshStandardMaterial({ color: 0x92400e, flatShading: true });
    const dock = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.3, 9.5), dockMat);
    dock.position.set(-46, 0.4, 17);
    const dockPost = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 2.4, 6), dockMat);
    dockPost.position.set(-44.6, 1.4, 21.2);
    const dockLantern = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xfef08a })
    );
    dockLantern.position.set(-44.6, 2.65, 21.2);
    const boatHull = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.45, 3.6), dockMat);
    boatHull.position.set(-43.1, -0.1, 19.2);
    boatHull.rotation.y = 0.18;
    this.worldGroup.add(dock, dockPost, dockLantern, boatHull);
    this.walkableSurfaces.push({
      minX: -47.6,
      maxX: -44.4,
      minZ: 12.2,
      maxZ: 21.8,
      getHeight: () => 0.55,
    });

    const t = (78 - 38) / (215 - 38);
    const bridgeX = -46 + t * 52 + Math.sin(t * Math.PI * 2.2) * 12;
    const bridgeZ = 78;
    const bridgeY = 1.85;

    const bridgeDeck = new THREE.Mesh(new THREE.BoxGeometry(16, 0.35, 4.6), dockMat);
    bridgeDeck.position.set(bridgeX, bridgeY, bridgeZ);
    bridgeDeck.castShadow = true;
    bridgeDeck.receiveShadow = true;
    this.worldGroup.add(bridgeDeck);
    this.raycastMeshes.push(bridgeDeck);

    const rail1 = new THREE.Mesh(new THREE.BoxGeometry(16, 0.95, 0.25), dockMat);
    rail1.position.set(bridgeX, bridgeY + 0.55, bridgeZ - 2.15);
    const rail2 = new THREE.Mesh(new THREE.BoxGeometry(16, 0.95, 0.25), dockMat);
    rail2.position.set(bridgeX, bridgeY + 0.55, bridgeZ + 2.15);
    this.worldGroup.add(rail1, rail2);

    // Bridge 1 Support Pilings & Entry Lantern Posts
    for (const dx of [-5.5, 5.5]) {
      for (const dz of [-2.1, 2.1]) {
        const piling = new THREE.Mesh(
          new THREE.CylinderGeometry(0.26, 0.3, 3.8, 6),
          dockMat
        );
        piling.position.set(bridgeX + dx, bridgeY - 1.5, bridgeZ + dz);
        const lampOrb = new THREE.Mesh(
          new THREE.SphereGeometry(0.2, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xfef08a })
        );
        lampOrb.position.set(bridgeX + dx, bridgeY + 1.25, bridgeZ + dz);
        this.worldGroup.add(piling, lampOrb);
      }
    }

    this.walkableSurfaces.push({
      minX: bridgeX - 8.5,
      maxX: bridgeX + 8.5,
      minZ: bridgeZ - 2.3,
      maxZ: bridgeZ + 2.3,
      getHeight: () => bridgeY + 0.18,
    });

    this.lootSpawnPoints.push(new THREE.Vector3(bridgeX, bridgeY + 0.4, bridgeZ));

    // Second Southern River Crossing Bridge near Legacy Ruins (z = 136)
    const t2 = (136 - 38) / (215 - 38);
    const bridge2X = -46 + t2 * 52 + Math.sin(t2 * Math.PI * 2.2) * 12;
    const bridge2Z = 136;
    const bridge2Y = 1.95;
    const stoneBridgeMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      flatShading: true,
      roughness: 0.8,
    });
    const bridge2Deck = new THREE.Mesh(
      new THREE.BoxGeometry(16.5, 0.4, 4.8),
      stoneBridgeMat
    );
    bridge2Deck.position.set(bridge2X, bridge2Y, bridge2Z);
    bridge2Deck.castShadow = true;
    bridge2Deck.receiveShadow = true;
    this.worldGroup.add(bridge2Deck);
    this.raycastMeshes.push(bridge2Deck);

    const sRail1 = new THREE.Mesh(
      new THREE.BoxGeometry(16.5, 1.0, 0.3),
      stoneBridgeMat
    );
    sRail1.position.set(bridge2X, bridge2Y + 0.6, bridge2Z - 2.2);
    const sRail2 = sRail1.clone();
    sRail2.position.z = bridge2Z + 2.2;
    this.worldGroup.add(sRail1, sRail2);

    // Bridge 2 Stone Arch Support Piers & Glowing Braziers
    for (const dx of [-5.8, 5.8]) {
      const pier = new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 3.6, 4.8),
        stoneBridgeMat
      );
      pier.position.set(bridge2X + dx, bridge2Y - 1.6, bridge2Z);
      const brazier = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.26, 0),
        new THREE.MeshBasicMaterial({ color: 0xf97316 })
      );
      brazier.position.set(bridge2X + dx, bridge2Y + 1.35, bridge2Z - 2.2);
      this.worldGroup.add(pier, brazier);
    }

    this.walkableSurfaces.push({
      minX: bridge2X - 8.5,
      maxX: bridge2X + 8.5,
      minZ: bridge2Z - 2.4,
      maxZ: bridge2Z + 2.4,
      getHeight: () => bridge2Y + 0.2,
    });
    this.lootSpawnPoints.push(new THREE.Vector3(bridge2X, bridge2Y + 0.45, bridge2Z));
  }

  private buildFrontendFarms(): void {
    const poi = ISLAND_POIS[6];
    this.createEnterableHouse(poi.x - 8, poi.z, 13, 11, 5.2, 0xdc2626, 0x7f1d1d, true);

    // Red Cylindrical Farm Grain Silo with Silver Dome
    const siloX = poi.x - 18;
    const siloZ = poi.z - 6;
    const siloY = this.terrain.getTerrainHeight(siloX, siloZ);
    const farmSiloBody = new THREE.Mesh(
      new THREE.CylinderGeometry(2.1, 2.1, 8.4, 10),
      new THREE.MeshStandardMaterial({ color: 0xb91c1c, flatShading: true })
    );
    farmSiloBody.position.set(siloX, siloY + 4.2, siloZ);
    farmSiloBody.castShadow = true;
    const farmSiloCap = new THREE.Mesh(
      new THREE.SphereGeometry(2.1, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
      new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.4, roughness: 0.35 })
    );
    farmSiloCap.position.set(siloX, siloY + 8.4, siloZ);
    this.worldGroup.add(farmSiloBody, farmSiloCap);
    this.raycastMeshes.push(farmSiloBody);
    this.cylinderColliders.push({
      id: 'farm_grain_silo',
      x: siloX,
      z: siloZ,
      radius: 2.15,
      minY: siloY,
      maxY: siloY + 8.4,
    });

    const wx = poi.x + 12;
    const wz = poi.z - 8;
    const wy = this.terrain.getTerrainHeight(wx, wz);
    const towerMat = new THREE.MeshStandardMaterial({ color: 0xd6d3d1, flatShading: true });
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 2.2, 9.8, 8), towerMat);
    tower.position.set(wx, wy + 4.9, wz);
    tower.castShadow = true;
    this.worldGroup.add(tower);
    this.raycastMeshes.push(tower);
    this.cylinderColliders.push({
      id: 'farm_windmill',
      x: wx,
      z: wz,
      radius: 2.0,
      minY: wy,
      maxY: wy + 9.8,
    });

    this.windmillBlades = new THREE.Group();
    this.windmillBlades.position.set(wx, wy + 8.6, wz + 1.3);
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0xfef08a, flatShading: true });
    for (let b = 0; b < 4; b++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.68, 4.6, 0.12), bladeMat);
      blade.rotation.z = (b * Math.PI) / 2;
      this.windmillBlades.add(blade);
    }
    this.worldGroup.add(this.windmillBlades);

    const hayMat = new THREE.MeshStandardMaterial({ color: 0xeab308, flatShading: true });
    const hayOffsets = [
      [8, 6],
      [12, 9],
      [-2, 12],
      [4, -12],
    ];
    for (const [dx, dz] of hayOffsets) {
      const hx = poi.x + dx;
      const hz = poi.z + dz;
      const hy = this.terrain.getTerrainHeight(hx, hz);
      const bale = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 1.3, 8), hayMat);
      bale.rotation.z = Math.PI / 2;
      bale.position.set(hx, hy + 0.85, hz);
      bale.castShadow = true;
      this.worldGroup.add(bale);
      this.cylinderColliders.push({
        id: `hay_${hx}_${hz}`,
        x: hx,
        z: hz,
        radius: 0.9,
        minY: hy,
        maxY: hy + 1.6,
      });
    }

    this.spawnFenceLine(poi.x - 16, poi.z + 15, 6, true);
    this.spawnFenceLine(poi.x + 4, poi.z + 15, 5, true);

    this.chestSpawnPoints.push(new THREE.Vector3(wx - 2.5, wy + 0.4, wz + 2.5));
    this.lootSpawnPoints.push(new THREE.Vector3(poi.x + 6, poi.baseHeight + 0.4, poi.z + 4));
  }

  private buildLegacyRuins(): void {
    const poi = ISLAND_POIS[7];
    const ry = this.terrain.getTerrainHeight(poi.x, poi.z);
    const stoneMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      flatShading: true,
      roughness: 0.9,
    });
    const mossMat = new THREE.MeshStandardMaterial({
      color: 0x4ade80,
      flatShading: true,
      roughness: 0.85,
    });

    const dais = new THREE.Mesh(new THREE.BoxGeometry(16, 0.8, 16), stoneMat);
    dais.position.set(poi.x, ry + 0.4, poi.z);
    dais.receiveShadow = true;
    this.worldGroup.add(dais);
    this.raycastMeshes.push(dais);
    this.walkableSurfaces.push({
      minX: poi.x - 8,
      maxX: poi.x + 8,
      minZ: poi.z - 8,
      maxZ: poi.z + 8,
      getHeight: () => ry + 0.8,
    });

    // Ancient Floating Rune Crystal above the temple altar
    const runeMat = new THREE.MeshStandardMaterial({
      color: 0xa855f7,
      emissive: 0x9333ea,
      emissiveIntensity: 0.7,
      flatShading: true,
    });
    this.ruinObeliskCrystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(1.15, 0),
      runeMat
    );
    this.ruinObeliskCrystal.position.set(poi.x, ry + 4.2, poi.z);
    const runeFloorRing = new THREE.Mesh(
      new THREE.RingGeometry(2.2, 2.65, 24),
      new THREE.MeshBasicMaterial({
        color: 0xc084fc,
        side: THREE.DoubleSide,
      })
    );
    runeFloorRing.rotation.x = -Math.PI / 2;
    runeFloorRing.position.set(poi.x, ry + 0.84, poi.z);
    const northArchBeam = new THREE.Mesh(
      new THREE.BoxGeometry(14.5, 0.9, 1.4),
      stoneMat
    );
    northArchBeam.position.set(poi.x, ry + 6.3, poi.z - 6.5);
    this.worldGroup.add(this.ruinObeliskCrystal, runeFloorRing, northArchBeam);

    const colOffsets = [
      [-6.5, -6.5, 5.2],
      [6.5, -6.5, 5.2],
      [-6.5, 6.5, 3.0],
      [6.5, 6.5, 5.2],
      [-6.5, 0, 2.4],
      [6.5, 0, 5.2],
      [0, -6.5, 5.2],
      [0, 6.5, 2.1],
    ];
    colOffsets.forEach(([dx, dz, h], idx) => {
      const cx = poi.x + dx;
      const cz = poi.z + dz;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.85, h, 7), stoneMat);
      col.position.set(cx, ry + 0.8 + h / 2, cz);
      col.castShadow = true;
      col.receiveShadow = true;
      this.worldGroup.add(col);
      this.raycastMeshes.push(col);

      if (h > 4.5) {
        const mossCap = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.45, 1.9), mossMat);
        mossCap.position.set(cx, ry + 0.8 + h + 0.2, cz);
        this.worldGroup.add(mossCap);
      }

      this.cylinderColliders.push({
        id: `ruin_col_${idx}`,
        x: cx,
        z: cz,
        radius: 0.85,
        minY: ry + 0.8,
        maxY: ry + 0.8 + h,
      });
    });

    this.chestSpawnPoints.push(new THREE.Vector3(poi.x, ry + 0.85, poi.z));
    this.lootSpawnPoints.push(new THREE.Vector3(poi.x - 4, ry + 0.85, poi.z + 3));
    this.lootSpawnPoints.push(new THREE.Vector3(poi.x + 4, ry + 0.85, poi.z - 3));

    // Abandoned Geo-Dome Research Outpost adjacent to the ruins (poi.x + 15, poi.z - 5)
    const labX = poi.x + 15;
    const labZ = poi.z - 5;
    const labY = this.terrain.getTerrainHeight(labX, labZ);
    const labBaseMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      metalness: 0.45,
      roughness: 0.4,
      flatShading: true,
    });
    const labPad = new THREE.Mesh(
      new THREE.CylinderGeometry(6.8, 7.4, 0.5, 12),
      labBaseMat
    );
    labPad.position.set(labX, labY + 0.25, labZ);
    labPad.receiveShadow = true;
    this.worldGroup.add(labPad);
    this.raycastMeshes.push(labPad);
    this.walkableSurfaces.push({
      minX: labX - 6.8,
      maxX: labX + 6.8,
      minZ: labZ - 6.8,
      maxZ: labZ + 6.8,
      getHeight: () => labY + 0.5,
    });

    // Translucent Geodesic Bio-Dome Roof (open front entrance)
    const domeGeo = new THREE.SphereGeometry(
      6.4,
      10,
      8,
      0,
      Math.PI * 1.65,
      0,
      Math.PI * 0.5
    );
    const domeMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.25,
      transparent: true,
      opacity: 0.38,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    const domeMesh = new THREE.Mesh(domeGeo, domeMat);
    domeMesh.position.set(labX, labY + 0.5, labZ);
    domeMesh.rotation.y = 0.5;
    this.worldGroup.add(domeMesh);

    // Glowing Bio-Containment Cryo-Tubes inside the research dome
    const tubeMat = new THREE.MeshStandardMaterial({
      color: 0x4ade80,
      emissive: 0x22c55e,
      emissiveIntensity: 0.65,
      transparent: true,
      opacity: 0.8,
    });
    for (const dx of [-2.4, 2.4]) {
      const tube = new THREE.Mesh(
        new THREE.CylinderGeometry(0.65, 0.65, 2.8, 10),
        tubeMat
      );
      tube.position.set(labX + dx, labY + 1.9, labZ - 2.2);
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.75, 0.75, 0.3, 10),
        labBaseMat
      );
      cap.position.set(labX + dx, labY + 3.4, labZ - 2.2);
      this.worldGroup.add(tube, cap);
      this.cylinderColliders.push({
        id: `lab_tube_${dx}`,
        x: labX + dx,
        z: labZ - 2.2,
        radius: 0.75,
        minY: labY + 0.5,
        maxY: labY + 3.5,
      });
    }

    this.chestSpawnPoints.push(new THREE.Vector3(labX, labY + 0.55, labZ - 1.5));
    this.lootSpawnPoints.push(new THREE.Vector3(labX, labY + 0.55, labZ + 2.5));
  }

  public spawnFenceLine(
    startX: number,
    startZ: number,
    segments: number,
    alongX: boolean = true
  ): void {
    const fenceMat = new THREE.MeshStandardMaterial({ color: 0x92400e, flatShading: true });
    for (let i = 0; i < segments; i++) {
      const fx = startX + (alongX ? i * 3.0 : 0);
      const fz = startZ + (alongX ? 0 : i * 3.0);
      const fy = this.terrain.getTerrainHeight(fx, fz);
      const id = `fence_${this.destructibles.size}`;

      const group = new THREE.Group();
      group.position.set(fx, fy, fz);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.24, 1.2, 0.24), fenceMat);
      post.position.y = 0.6;
      const rail1 = new THREE.Mesh(
        new THREE.BoxGeometry(alongX ? 3.0 : 0.14, 0.16, alongX ? 0.14 : 3.0),
        fenceMat
      );
      rail1.position.set(alongX ? 1.5 : 0, 0.9, alongX ? 0 : 1.5);
      const rail2 = rail1.clone();
      rail2.position.y = 0.45;
      group.add(post, rail1, rail2);
      group.userData.destructibleId = id;
      this.worldGroup.add(group);

      const boxCol: BoxCollider = {
        id,
        minX: fx - 0.2,
        maxX: fx + (alongX ? 3.0 : 0.2),
        minY: fy,
        maxY: fy + 1.2,
        minZ: fz - 0.2,
        maxZ: fz + (alongX ? 0.2 : 3.0),
        destructibleId: id,
      };
      this.boxColliders.push(boxCol);

      const prop: DestructibleProp = {
        id,
        type: 'fence',
        materialType: 'wood',
        health: 50,
        maxHealth: 50,
        mesh: group,
        position: new THREE.Vector3(fx, fy + 0.6, fz),
        hitShakeTimer: 0,
      };
      this.destructibles.set(id, prop);
      this.initialWorldProps.push({ prop, boxCollider: boxCol });
    }
  }

  private buildInstancedFoliage(): void {
    let seed = 9001;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const grassGeo = new THREE.ConeGeometry(0.22, 0.68, 4);
    grassGeo.translate(0, 0.34, 0);
    const grassMat = applyFoliageWind(
      new THREE.MeshStandardMaterial({
        color: 0x16a34a,
        flatShading: true,
        roughness: 0.85,
      }),
      { strength: 0.06, baseY: 0, height: 0.68 }
    );
    const grassCount = 520;
    const grassInst = new THREE.InstancedMesh(grassGeo, grassMat, grassCount);
    const dummy = new THREE.Object3D();

    let placedG = 0;
    for (let i = 0; i < grassCount * 2 && placedG < grassCount; i++) {
      const a = rand() * Math.PI * 2;
      const r = 18 + Math.sqrt(rand()) * 182;
      const gx = Math.cos(a) * r;
      const gz = Math.sin(a) * r;
      const gy = this.terrain.getTerrainHeight(gx, gz);
      if (gy < 2.0 || gy > 11.0 || this.terrain.isOnRoad(gx, gz) || this.mapExpansion.isInsideStructure(gx, gz, 0.7)) continue;

      dummy.position.set(gx, gy, gz);
      dummy.rotation.set(0, rand() * Math.PI, 0);
      const s = 0.75 + rand() * 0.65;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      grassInst.setMatrixAt(placedG++, dummy.matrix);
    }
    grassInst.count = placedG;
    this.foliageGroup.add(grassInst);

    const flowerGeo = new THREE.DodecahedronGeometry(0.2, 0);
    flowerGeo.translate(0, 0.25, 0);
    const flowerMat = applyFoliageWind(
      new THREE.MeshStandardMaterial({
        color: 0xf472b6,
        emissive: 0xdb2777,
        emissiveIntensity: 0.15,
        flatShading: true,
      }),
      { strength: 0.032, baseY: 0.05, height: 0.4 }
    );
    const flowerCount = 180;
    const flowerInst = new THREE.InstancedMesh(flowerGeo, flowerMat, flowerCount);
    let placedF = 0;
    for (let i = 0; i < flowerCount * 2 && placedF < flowerCount; i++) {
      const a = rand() * Math.PI * 2;
      const r = 24 + Math.sqrt(rand()) * 170;
      const fx = Math.cos(a) * r;
      const fz = Math.sin(a) * r;
      const fy = this.terrain.getTerrainHeight(fx, fz);
      if (fy < 2.2 || fy > 10.5 || this.terrain.isOnRoad(fx, fz) || this.mapExpansion.isInsideStructure(fx, fz, 0.7)) continue;

      dummy.position.set(fx, fy, fz);
      dummy.scale.setScalar(0.8 + rand() * 0.5);
      dummy.updateMatrix();
      flowerInst.setMatrixAt(placedF++, dummy.matrix);
    }
    flowerInst.count = placedF;
    this.foliageGroup.add(flowerInst);

    // Instanced Coastal & Highland Pebbles (220 instances in 1 draw call)
    const pebbleGeo = new THREE.DodecahedronGeometry(0.28, 0);
    pebbleGeo.scale(1.2, 0.55, 1.0);
    const pebbleMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      flatShading: true,
      roughness: 0.9,
    });
    const pebbleCount = 220;
    const pebbleInst = new THREE.InstancedMesh(pebbleGeo, pebbleMat, pebbleCount);
    let placedP = 0;
    for (let i = 0; i < pebbleCount * 2 && placedP < pebbleCount; i++) {
      const a = rand() * Math.PI * 2;
      const r = 40 + Math.sqrt(rand()) * 188;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      const py = this.terrain.getTerrainHeight(px, pz);
      if (py < 0.25 || (py > 2.6 && py < 9.5) || this.mapExpansion.isInsideStructure(px, pz, 0.7)) continue;

      dummy.position.set(px, py + 0.08, pz);
      dummy.rotation.set(0, rand() * Math.PI, 0);
      const s = 0.65 + rand() * 0.85;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      pebbleInst.setMatrixAt(placedP++, dummy.matrix);
    }
    pebbleInst.count = placedP;
    this.foliageGroup.add(pebbleInst);

    // Instanced Stylized Bushes / Shrubs (160 instances in 1 draw call, non-blocking)
    const bushGeo = new THREE.DodecahedronGeometry(0.62, 1);
    bushGeo.scale(1.15, 0.78, 1.15);
    bushGeo.translate(0, 0.42, 0);
    const bushMat = applyFoliageWind(
      new THREE.MeshStandardMaterial({
        color: 0x15803d,
        flatShading: true,
        roughness: 0.82,
      }),
      { strength: 0.026, baseY: -0.06, height: 0.96 }
    );
    const bushCount = 160;
    const bushInst = new THREE.InstancedMesh(bushGeo, bushMat, bushCount);
    let placedB = 0;
    for (let i = 0; i < bushCount * 2 && placedB < bushCount; i++) {
      const a = rand() * Math.PI * 2;
      const r = 28 + Math.sqrt(rand()) * 172;
      const bx = Math.cos(a) * r;
      const bz = Math.sin(a) * r;
      if (this.isInsidePOIBuildingZone(bx, bz) || this.terrain.isOnRoad(bx, bz)) continue;
      const by = this.terrain.getTerrainHeight(bx, bz);
      if (by < 2.2 || by > 11.5) continue;

      dummy.position.set(bx, by, bz);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      const s = 0.72 + rand() * 0.65;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      bushInst.setMatrixAt(placedB++, dummy.matrix);
    }
    bushInst.count = placedB;
    this.foliageGroup.add(bushInst);

    // Instanced Golden Wildflowers (140 instances in 1 draw call)
    const goldFlowerMat = applyFoliageWind(
      new THREE.MeshStandardMaterial({
        color: 0xfacc15,
        emissive: 0xeab308,
        emissiveIntensity: 0.18,
        flatShading: true,
      }),
      { strength: 0.032, baseY: 0.05, height: 0.4 }
    );
    const goldFlowerCount = 140;
    const goldFlowerInst = new THREE.InstancedMesh(
      flowerGeo,
      goldFlowerMat,
      goldFlowerCount
    );
    let placedGF = 0;
    for (let i = 0; i < goldFlowerCount * 2 && placedGF < goldFlowerCount; i++) {
      const a = rand() * Math.PI * 2;
      const r = 22 + Math.sqrt(rand()) * 175;
      const fx = Math.cos(a) * r;
      const fz = Math.sin(a) * r;
      const fy = this.terrain.getTerrainHeight(fx, fz);
      if (fy < 2.1 || fy > 10.2 || this.terrain.isOnRoad(fx, fz) || this.mapExpansion.isInsideStructure(fx, fz, 0.7)) continue;

      dummy.position.set(fx, fy, fz);
      dummy.scale.setScalar(0.75 + rand() * 0.55);
      dummy.updateMatrix();
      goldFlowerInst.setMatrixAt(placedGF++, dummy.matrix);
    }
    goldFlowerInst.count = placedGF;
    this.foliageGroup.add(goldFlowerInst);

    // Instanced Shoreline & Riverbank Reeds / Cattails (120 instances in 1 draw call)
    const reedGeo = new THREE.CylinderGeometry(0.05, 0.08, 1.15, 5);
    reedGeo.translate(0, 0.55, 0);
    const reedMat = applyFoliageWind(
      new THREE.MeshStandardMaterial({
        color: 0x65a30d,
        flatShading: true,
        roughness: 0.85,
      }),
      { strength: 0.072, baseY: 0, height: 1.15 }
    );
    const reedCount = 120;
    const reedInst = new THREE.InstancedMesh(reedGeo, reedMat, reedCount);
    let placedR = 0;
    for (let i = 0; i < reedCount * 4 && placedR < reedCount; i++) {
      const a = rand() * Math.PI * 2;
      const r = 15 + Math.sqrt(rand()) * 195;
      const rx = Math.cos(a) * r;
      const rz = Math.sin(a) * r;
      const ry = this.terrain.getTerrainHeight(rx, rz);
      const riverDist = this.terrain.getRiverDistance(rx, rz);
      const lakeDist = Math.hypot(rx - -46, rz - 38);
      const nearWaterBank =
        (riverDist > 3.8 && riverDist < 7.2) ||
        (lakeDist > 20.0 && lakeDist < 25.5) ||
        (ry > 0.25 && ry < 1.35);
      if (!nearWaterBank || this.terrain.isOnRoad(rx, rz) || this.mapExpansion.isInsideStructure(rx, rz, 0.7)) continue;

      dummy.position.set(rx, ry, rz);
      dummy.rotation.set((rand() - 0.5) * 0.2, rand() * Math.PI, (rand() - 0.5) * 0.2);
      const s = 0.8 + rand() * 0.55;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      reedInst.setMatrixAt(placedR++, dummy.matrix);
    }
    reedInst.count = placedR;
    this.foliageGroup.add(reedInst);
  }

  private populateWilderness(): void {
    let seed = 1337;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    for (let i = 0; i < 165; i++) {
      const angle = rand() * Math.PI * 2;
      const dist = 34 + Math.sqrt(rand()) * 186;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;

      if (this.isInsidePOIBuildingZone(x, z) || this.terrain.isOnRoad(x, z)) continue;
      const h = this.terrain.getTerrainHeight(x, z);
      if (h < 0.6 || h > 15.0) continue;

      let style: 'pine' | 'oak' | 'blossom' | 'palm' | 'birch' = 'oak';
      if (h < 2.2) {
        style = 'palm';
      } else if (h > 8.5) {
        style = rand() < 0.7 ? 'pine' : 'birch';
      } else {
        const r = rand();
        style = r < 0.35 ? 'pine' : r < 0.68 ? 'oak' : r < 0.86 ? 'birch' : 'blossom';
      }
      this.spawnTree(x, z, style);
    }

    for (let i = 0; i < 60; i++) {
      const angle = rand() * Math.PI * 2;
      const dist = 28 + rand() * 180;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      if (this.isInsidePOIBuildingZone(x, z) || this.terrain.isOnRoad(x, z)) continue;
      const h = this.terrain.getTerrainHeight(x, z);
      if (h < 0.8) continue;

      this.spawnRock(x, z, 1.1 + rand() * 1.25);
    }

    for (let i = 0; i < 28; i++) {
      const angle = rand() * Math.PI * 2;
      const dist = 35 + rand() * 155;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      if (
        this.isInsidePOIBuildingZone(x, z) ||
        this.terrain.getRoadDistance(x, z) < 5.2 ||
        this.terrain.getRiverDistance(x, z) < 5.8 ||
        Math.hypot(x + 46, z - 38) < 24
      ) {
        continue;
      }
      const h = this.terrain.getTerrainHeight(x, z);
      if (h < 1.6 || this.terrain.getTerrainSlope(x, z) > 0.9) continue;

      this.spawnCrate(x, z);
      if (i % 2 === 0) {
        const lx = x + 1.8;
        const lh = this.terrain.getTerrainHeight(lx, z);
        if (
          lh >= 1.2 &&
          this.terrain.getTerrainSlope(lx, z) <= 0.9 &&
          !this.mapExpansion.isInsideStructure(lx, z, 0.8) &&
          !this.terrain.isOnRoad(lx, z)
        ) {
          this.lootSpawnPoints.push(new THREE.Vector3(lx, lh + 0.4, z));
        }
      } else if (i % 3 === 0) {
        const lx = x - 1.8;
        const lh = this.terrain.getTerrainHeight(lx, z);
        if (
          lh >= 1.2 &&
          this.terrain.getTerrainSlope(lx, z) <= 0.9 &&
          !this.mapExpansion.isInsideStructure(lx, z, 0.8) &&
          !this.terrain.isOnRoad(lx, z)
        ) {
          this.chestSpawnPoints.push(new THREE.Vector3(lx, lh + 0.4, z));
        }
      }
    }
  }

  private isInsidePOIBuildingZone(x: number, z: number): boolean {
    if (this.mapExpansion.isInsideStructure(x, z, 1.8)) return true;
    for (const poi of ISLAND_POIS) {
      if (Math.hypot(x - poi.x, z - poi.z) < poi.radius * 0.78) {
        return true;
      }
    }
    for (const settlement of ISLAND_SETTLEMENTS) {
      if (Math.hypot(x - settlement.x, z - settlement.z) < settlement.radius * 0.78) {
        return true;
      }
    }
    return false;
  }

  public spawnTree(
    x: number,
    z: number,
    style: 'pine' | 'oak' | 'blossom' | 'palm' | 'birch'
  ): void {
    const y = this.terrain.getTerrainHeight(x, z);
    const id = `tree_${this.destructibles.size}`;
    const proxy = new THREE.Object3D();
    proxy.position.set(x, y, z);

    const cylCol: CylinderCollider = {
      id,
      x,
      z,
      radius: 0.65,
      minY: y,
      maxY: y + 5.5,
      destructibleId: id,
    };
    this.cylinderColliders.push(cylCol);

    const prop: DestructibleProp = {
      id,
      type: 'tree',
      materialType: 'wood',
      health: 100,
      maxHealth: 100,
      mesh: proxy,
      position: new THREE.Vector3(x, y + 1.5, z),
      hitShakeTimer: 0,
    };
    this.destructibles.set(id, prop);
    this.initialWorldProps.push({ prop, cylCollider: cylCol });
    this.pendingTreeInstances.push({ prop, x, y, z, style });
  }

  public spawnRock(x: number, z: number, radius: number): void {
    const y = this.terrain.getTerrainHeight(x, z);
    const id = `rock_${this.destructibles.size}`;
    const proxy = new THREE.Object3D();
    proxy.position.set(x, y + radius * 0.65, z);

    const cylCol: CylinderCollider = {
      id,
      x,
      z,
      radius: radius * 0.85,
      minY: y,
      maxY: y + radius * 1.5,
      destructibleId: id,
    };
    this.cylinderColliders.push(cylCol);

    const prop: DestructibleProp = {
      id,
      type: 'rock',
      materialType: 'stone',
      health: 140,
      maxHealth: 140,
      mesh: proxy,
      position: new THREE.Vector3(x, y + radius * 0.7, z),
      hitShakeTimer: 0,
    };
    this.destructibles.set(id, prop);
    this.initialWorldProps.push({ prop, cylCollider: cylCol });
    this.pendingRockInstances.push({ prop, x, y, z, radius });
  }

  public spawnCrate(x: number, z: number): void {
    const y = this.terrain.getTerrainHeight(x, z);
    const id = `crate_${this.destructibles.size}`;
    const proxy = new THREE.Object3D();
    proxy.position.set(x, y + 0.65, z);

    const boxCol: BoxCollider = {
      id,
      minX: x - 0.65,
      maxX: x + 0.65,
      minY: y,
      maxY: y + 1.3,
      minZ: z - 0.65,
      maxZ: z + 0.65,
      destructibleId: id,
    };
    this.boxColliders.push(boxCol);

    const walkSurf: WalkableSurface = {
      id,
      minX: x - 0.65,
      maxX: x + 0.65,
      minZ: z - 0.65,
      maxZ: z + 0.65,
      getHeight: () => y + 1.3,
    };
    this.walkableSurfaces.push(walkSurf);

    const prop: DestructibleProp = {
      id,
      type: 'crate',
      materialType: 'wood',
      health: 70,
      maxHealth: 70,
      mesh: proxy,
      position: new THREE.Vector3(x, y + 0.65, z),
      hitShakeTimer: 0,
    };
    this.destructibles.set(id, prop);
    this.initialWorldProps.push({ prop, boxCollider: boxCol, walkableSurface: walkSurf });
    this.pendingCrateInstances.push({ prop, x, y, z });
  }

  /**
   * Builds GPU-Instanced batches for all Trees (trunks, pine cones, deciduous crowns, palm fronds),
   * Rocks, and Crates across the island, collapsing ~640 separate meshes into 6 InstancedMeshes
   * while supporting per-prop hit-shake and harvesting destruction.
   */
  private buildInstancedWorldProps(): void {
    const dummy = new THREE.Object3D();
    const childDummy = new THREE.Object3D();
    const color = new THREE.Color();

    // Count sub-instances needed for trees
    const totalTrunks = this.pendingTreeInstances.length;
    let totalPineCones = 0;
    let totalLeafCrowns = 0;
    let totalPalmFronds = 0;
    for (const t of this.pendingTreeInstances) {
      if (t.style === 'pine') totalPineCones += 3;
      else if (t.style === 'palm') totalPalmFronds += 5;
      else totalLeafCrowns += 2;
    }

    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.48, 1.0, 6);
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      flatShading: true,
      roughness: 0.8,
    });
    const trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, Math.max(1, totalTrunks));
    trunkInst.castShadow = true;
    trunkInst.receiveShadow = true;

    const coneGeo = new THREE.ConeGeometry(1.0, 1.0, 6);
    const leafMat = applyFoliageWind(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        flatShading: true,
        roughness: 0.75,
      }),
      { strength: 0.032, baseY: -1, height: 2 }
    );
    const pineConeInst = new THREE.InstancedMesh(
      coneGeo,
      leafMat,
      Math.max(1, totalPineCones)
    );
    pineConeInst.castShadow = true;
    pineConeInst.receiveShadow = true;

    const crownGeo = new THREE.DodecahedronGeometry(1.0, 0);
    const leafCrownInst = new THREE.InstancedMesh(
      crownGeo,
      leafMat,
      Math.max(1, totalLeafCrowns)
    );
    leafCrownInst.castShadow = true;
    leafCrownInst.receiveShadow = true;

    const frondGeo = new THREE.BoxGeometry(0.48, 0.12, 2.2);
    const palmFrondInst = new THREE.InstancedMesh(
      frondGeo,
      leafMat,
      Math.max(1, totalPalmFronds)
    );
    palmFrondInst.castShadow = true;

    let trunkCursor = 0;
    let coneCursor = 0;
    let crownCursor = 0;
    let frondCursor = 0;

    for (const t of this.pendingTreeInstances) {
      const { prop, x, y, z, style } = t;
      const tIdx = trunkCursor++;
      const trunkColor =
        style === 'birch' ? 0xe2e8f0 : style === 'palm' ? 0x92400e : 0x78350f;
      const leafColor =
        style === 'pine'
          ? 0x15803d
          : style === 'blossom'
          ? 0xf472b6
          : style === 'birch'
          ? 0x84cc16
          : style === 'palm'
          ? 0x16a34a
          : 0x22c55e;
      const trunkH = style === 'palm' ? 3.4 : 2.6;
      const variationSeed = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
      const variation = variationSeed - Math.floor(variationSeed);
      const baseTreeScale = 0.84 + variation * 0.44;
      const baseTreeYaw = variation * Math.PI * 2;

      trunkInst.setColorAt(tIdx, color.setHex(trunkColor));

      const coneBaseIdx = coneCursor;
      const crownBaseIdx = crownCursor;
      const frondBaseIdx = frondCursor;

      if (style === 'pine') {
        for (let k = 0; k < 3; k++) {
          pineConeInst.setColorAt(coneCursor++, color.setHex(leafColor));
        }
      } else if (style === 'palm') {
        for (let k = 0; k < 5; k++) {
          palmFrondInst.setColorAt(frondCursor++, color.setHex(leafColor));
        }
      } else {
        for (let k = 0; k < 2; k++) {
          leafCrownInst.setColorAt(crownCursor++, color.setHex(leafColor));
        }
      }

      const applyTreeTransform = (scale: number, shakeAngleZ: number) => {
        if (scale <= 0.001) {
          dummy.position.set(x, -100, z);
          dummy.scale.setScalar(0);
          dummy.updateMatrix();
          trunkInst.setMatrixAt(tIdx, dummy.matrix);
          trunkInst.instanceMatrix.needsUpdate = true;
          if (style === 'pine') {
            for (let k = 0; k < 3; k++) pineConeInst.setMatrixAt(coneBaseIdx + k, dummy.matrix);
            pineConeInst.instanceMatrix.needsUpdate = true;
          } else if (style === 'palm') {
            for (let k = 0; k < 5; k++) palmFrondInst.setMatrixAt(frondBaseIdx + k, dummy.matrix);
            palmFrondInst.instanceMatrix.needsUpdate = true;
          } else {
            for (let k = 0; k < 2; k++) leafCrownInst.setMatrixAt(crownBaseIdx + k, dummy.matrix);
            leafCrownInst.instanceMatrix.needsUpdate = true;
          }
          return;
        }

        dummy.position.set(x, y, z);
        dummy.rotation.set(0, baseTreeYaw, shakeAngleZ);
        dummy.scale.setScalar(scale * baseTreeScale);
        dummy.updateMatrix();

        // Trunk
        childDummy.position.set(0, trunkH / 2, 0);
        childDummy.rotation.set(0, 0, style === 'palm' ? 0.12 : 0);
        childDummy.scale.set(1, trunkH, 1);
        childDummy.updateMatrix();
        childDummy.matrix.premultiply(dummy.matrix);
        trunkInst.setMatrixAt(tIdx, childDummy.matrix);
        trunkInst.instanceMatrix.needsUpdate = true;

        if (style === 'pine') {
          const specs = [
            { r: 2.1, h: 2.8, py: 3.1 },
            { r: 1.65, h: 2.4, py: 4.5 },
            { r: 1.1, h: 1.8, py: 5.7 },
          ];
          for (let k = 0; k < 3; k++) {
            childDummy.position.set(0, specs[k].py, 0);
            childDummy.rotation.set(0, 0, 0);
            childDummy.scale.set(specs[k].r, specs[k].h, specs[k].r);
            childDummy.updateMatrix();
            childDummy.matrix.premultiply(dummy.matrix);
            pineConeInst.setMatrixAt(coneBaseIdx + k, childDummy.matrix);
          }
          pineConeInst.instanceMatrix.needsUpdate = true;
        } else if (style === 'palm') {
          for (let f = 0; f < 5; f++) {
            const angle = (f / 5) * Math.PI * 2;
            childDummy.position.set(
              -0.2 + Math.cos(angle) * 0.9,
              3.35,
              Math.sin(angle) * 0.9
            );
            childDummy.rotation.set(0.35, -angle + Math.PI / 2, 0);
            childDummy.scale.setScalar(1);
            childDummy.updateMatrix();
            childDummy.matrix.premultiply(dummy.matrix);
            palmFrondInst.setMatrixAt(frondBaseIdx + f, childDummy.matrix);
          }
          palmFrondInst.instanceMatrix.needsUpdate = true;
        } else {
          // Main crown + side puff
          childDummy.position.set(0, 3.8, 0);
          childDummy.rotation.set(0, 0, 0);
          childDummy.scale.setScalar(2.1);
          childDummy.updateMatrix();
          childDummy.matrix.premultiply(dummy.matrix);
          leafCrownInst.setMatrixAt(crownBaseIdx, childDummy.matrix);

          childDummy.position.set(0.9, 3.3, 0.5);
          childDummy.rotation.set(0, 0, 0);
          childDummy.scale.setScalar(1.4);
          childDummy.updateMatrix();
          childDummy.matrix.premultiply(dummy.matrix);
          leafCrownInst.setMatrixAt(crownBaseIdx + 1, childDummy.matrix);
          leafCrownInst.instanceMatrix.needsUpdate = true;
        }
      };

      prop.updateInstanceTransform = applyTreeTransform;
      applyTreeTransform(1, 0);
    }

    if (trunkInst.instanceColor) trunkInst.instanceColor.needsUpdate = true;
    if (pineConeInst.instanceColor) pineConeInst.instanceColor.needsUpdate = true;
    if (leafCrownInst.instanceColor) leafCrownInst.instanceColor.needsUpdate = true;
    if (palmFrondInst.instanceColor) palmFrondInst.instanceColor.needsUpdate = true;

    // Instanced Rocks
    const rockGeo = new THREE.DodecahedronGeometry(1.0, 0);
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      flatShading: true,
      roughness: 0.85,
    });
    const rockInst = new THREE.InstancedMesh(
      rockGeo,
      rockMat,
      Math.max(1, this.pendingRockInstances.length)
    );
    rockInst.castShadow = true;
    rockInst.receiveShadow = true;

    this.pendingRockInstances.forEach((r, idx) => {
      const { prop, x, y, z, radius } = r;
      const applyRockTransform = (scale: number, shakeAngleZ: number) => {
        if (scale <= 0.001) {
          dummy.position.set(x, -100, z);
          dummy.scale.setScalar(0);
        } else {
          dummy.position.set(x, y + radius * 0.65, z);
          dummy.rotation.set(x * 0.3, z * 0.3, shakeAngleZ);
          dummy.scale.setScalar(radius * scale);
        }
        dummy.updateMatrix();
        rockInst.setMatrixAt(idx, dummy.matrix);
        rockInst.instanceMatrix.needsUpdate = true;
      };
      prop.updateInstanceTransform = applyRockTransform;
      applyRockTransform(1, 0);
    });

    // Instanced Crates
    const crateGeo = new THREE.BoxGeometry(1.3, 1.3, 1.3);
    const crateMat = new THREE.MeshStandardMaterial({
      color: 0xd97706,
      flatShading: true,
      roughness: 0.75,
    });
    const crateInst = new THREE.InstancedMesh(
      crateGeo,
      crateMat,
      Math.max(1, this.pendingCrateInstances.length)
    );
    crateInst.castShadow = true;
    crateInst.receiveShadow = true;

    this.pendingCrateInstances.forEach((c, idx) => {
      const { prop, x, y, z } = c;
      const applyCrateTransform = (scale: number, shakeAngleZ: number) => {
        if (scale <= 0.001) {
          dummy.position.set(x, -100, z);
          dummy.scale.setScalar(0);
        } else {
          dummy.position.set(x, y + 0.65, z);
          dummy.rotation.set(0, 0, shakeAngleZ);
          dummy.scale.setScalar(scale);
        }
        dummy.updateMatrix();
        crateInst.setMatrixAt(idx, dummy.matrix);
        crateInst.instanceMatrix.needsUpdate = true;
      };
      prop.updateInstanceTransform = applyCrateTransform;
      applyCrateTransform(1, 0);
    });

    this.propInstancesGroup.add(
      trunkInst,
      pineConeInst,
      leafCrownInst,
      palmFrondInst,
      rockInst,
      crateInst
    );
  }

  public computeBuildTransform(
    px: number,
    py: number,
    pz: number,
    yaw: number
  ): { bx: number; by: number; bz: number; snappedYaw: number; gridKey: string } {
    yaw = normalizeBuildYaw(yaw);
    const dist = 3.5;
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);

    const bx = Math.round((px + forwardX * dist) / 2) * 2;
    const bz = Math.round((pz + forwardZ * dist) / 2) * 2;
    const by = Math.round(Math.max(this.terrain.getTerrainHeight(bx, bz), py) * 2) / 2;
    const snappedYaw = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
    const gridKey = `${bx}_${by}_${bz}`;

    return { bx, by, bz, snappedYaw, gridKey };
  }

  public validateBuildPlacement(
    pieceType: BuildPieceType,
    px: number,
    py: number,
    pz: number,
    yaw: number
  ): boolean {
    if (![px,py,pz,yaw].every(Number.isFinite)) return false;
    const { bx, by, bz, snappedYaw, gridKey } = this.computeBuildTransform(px, py, pz, yaw);
    if (Math.hypot(bx, bz) > this.terrain.islandRadius + 6) return false;
    if (by < -0.5) return false;
    const cellKey = `${pieceType}_${gridKey}`;
    if (this.occupiedBuildCells.has(cellKey)) return false;
    // Static geometry only: neighboring build pieces may intentionally connect.
    const boxes = this.boxColliders.filter(b => !b.destructibleId?.startsWith('build_'));
    const cylinders = this.cylinderColliders.filter(b => !b.destructibleId?.startsWith('build_'));
    return !overlapsBuildGeometry(pieceType, {x:bx,y:by,z:bz,yaw:snappedYaw}, boxes, cylinders);
  }

  public updateBuildPreview(
    pieceType: BuildPieceType | null,
    px: number,
    py: number,
    pz: number,
    yaw: number,
    canAfford: boolean
  ): void {
    if (!pieceType) {
      this.buildPreviewGroup.visible = false;
      return;
    }

    this.buildPreviewGroup.visible = true;
    const { bx, by, bz, snappedYaw } = this.computeBuildTransform(px, py, pz, yaw);
    const isValid = this.validateBuildPlacement(pieceType, px, py, pz, yaw) && canAfford;

    this.buildPreviewGroup.position.set(bx, by, bz);
    this.buildPreviewGroup.rotation.y = snappedYaw;

    this.previewWallMesh.visible = pieceType === 'wall';
    this.previewRampMesh.visible = pieceType === 'ramp';
    this.previewFloorMesh.visible = pieceType === 'floor';
    this.previewRoofMesh.visible = pieceType === 'roof';

    const pulse = 0.34 + Math.sin(this.animTime * 7) * 0.1;
    this.previewMatValid.opacity = pulse;
    this.previewMatInvalid.opacity = pulse;

    const fillMat = isValid ? this.previewMatValid : this.previewMatInvalid;
    const lineMat = isValid ? this.previewLineValid : this.previewLineInvalid;

    for (const grp of [
      this.previewWallMesh,
      this.previewRampMesh,
      this.previewFloorMesh,
      this.previewRoofMesh,
    ]) {
      const f = grp.getObjectByName('preview_fill') as THREE.Mesh | undefined;
      const e = grp.getObjectByName('preview_edges') as THREE.LineSegments | undefined;
      if (f) f.material = fillMat;
      if (e) e.material = lineMat;
    }
  }

  public placeBuildPiece(
    ownerId: string,
    pieceType: BuildPieceType,
    px: number,
    py: number,
    pz: number,
    yaw: number,
    material: BuildMaterialType = 'wood',
    forcedId?: string
  ): BuildablePieceState {
    const { bx, by, bz, snappedYaw, gridKey } = this.computeBuildTransform(px, py, pz, yaw);
    const cellKey = `${pieceType}_${gridKey}`;
    this.occupiedBuildCells.add(cellKey);

    const id =
      forcedId || `build_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const colorHex =
      material === 'wood' ? 0xd97706 : material === 'stone' ? 0x94a3b8 : 0x38bdf8;
    const trimHex =
      material === 'wood' ? 0x92400e : material === 'stone' ? 0x475569 : 0x0284c7;
    const maxHp = material === 'wood' ? 150 : material === 'stone' ? 220 : 300;

    const mat = new THREE.MeshStandardMaterial({
      color: colorHex,
      map: this.getPatternTexture(material),
      emissive: colorHex,
      emissiveIntensity: 0.12,
      flatShading: true,
      roughness: 0.55,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: trimHex,
      flatShading: true,
      roughness: 0.65,
    });

    const isEastWest = Math.abs(Math.sin(snappedYaw)) > 0.7;

    if (pieceType === 'wall') {
      const w = isEastWest ? 0.35 : 3.6;
      const d = isEastWest ? 3.6 : 0.35;
      const h = 3.2;
      const group = new THREE.Group();
      group.position.set(bx, by + h / 2, bz);

      const core = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      core.castShadow = true;
      core.receiveShadow = true;
      core.userData.destructibleId = id;
      group.add(core);

      // Framed structural posts & cross-beams
      const postL = new THREE.Mesh(
        new THREE.BoxGeometry(
          isEastWest ? 0.42 : 0.25,
          h + 0.06,
          isEastWest ? 0.25 : 0.42
        ),
        trimMat
      );
      postL.position.set(isEastWest ? 0 : -1.68, 0, isEastWest ? -1.68 : 0);
      const postR = postL.clone();
      postR.position.set(isEastWest ? 0 : 1.68, 0, isEastWest ? 1.68 : 0);
      const midBeam = new THREE.Mesh(
        new THREE.BoxGeometry(isEastWest ? 0.4 : w, 0.2, isEastWest ? d : 0.4),
        trimMat
      );
      group.add(postL, postR, midBeam);
      group.userData.destructibleId = id;
      group.scale.setScalar(0.2);

      this.worldGroup.add(group);
      this.raycastMeshes.push(group);

      this.boxColliders.push({
        id,
        minX: bx - w / 2,
        maxX: bx + w / 2,
        minY: by,
        maxY: by + h,
        minZ: bz - d / 2,
        maxZ: bz + d / 2,
        destructibleId: id,
      });

      this.destructibles.set(id, {
        id,
        type: 'buildable',
        materialType: material,
        health: maxHp,
        maxHealth: maxHp,
        mesh: group,
        position: new THREE.Vector3(bx, by + h / 2, bz),
        hitShakeTimer: 0,
        spawnScaleTimer: 0.16,
        gridKey: cellKey,
      });
      this.walkableSurfaces.push({id, minX:bx-w/2,maxX:bx+w/2,minZ:bz-d/2,maxZ:bz+d/2,getHeight:()=>by+h});
    } else if (pieceType === 'floor') {
      const fw = 3.6;
      const fd = 3.6;
      const fh = 0.28;
      const floorY = by + 0.15;
      const group = new THREE.Group();
      group.position.set(bx, floorY, bz);

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, fd), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.destructibleId = id;
      const border = new THREE.Mesh(
        new THREE.BoxGeometry(fw + 0.08, fh * 0.7, fd + 0.08),
        trimMat
      );
      group.add(mesh, border);
      group.userData.destructibleId = id;
      group.scale.setScalar(0.2);

      this.worldGroup.add(group);
      this.raycastMeshes.push(group);

      this.walkableSurfaces.push({
        id,
        minX: bx - fw / 2,
        maxX: bx + fw / 2,
        minZ: bz - fd / 2,
        maxZ: bz + fd / 2,
        getHeight: () => floorY + fh / 2,
      });

      this.destructibles.set(id, {
        id,
        type: 'buildable',
        materialType: material,
        health: maxHp,
        maxHealth: maxHp,
        mesh: group,
        position: new THREE.Vector3(bx, floorY, bz),
        hitShakeTimer: 0,
        spawnScaleTimer: 0.16,
        gridKey: cellKey,
      });
    } else if (pieceType === 'roof') {
      const roofH = 1.9;
      const roofRadius = 2.6 / Math.SQRT2;
      const group = new THREE.Group();
      group.position.set(bx, by + roofH / 2, bz);

      const mesh = new THREE.Mesh(new THREE.ConeGeometry(2.6, roofH, 4), mat);
      mesh.rotation.y = Math.PI / 4;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.destructibleId = id;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.25, 0.6), trimMat);
      cap.position.y = roofH * 0.45;
      group.add(mesh, cap);
      group.userData.destructibleId = id;
      group.scale.setScalar(0.2);

      this.worldGroup.add(group);
      this.raycastMeshes.push(group);

      this.walkableSurfaces.push({
        id,
        minX: bx - roofRadius,
        maxX: bx + roofRadius,
        minZ: bz - roofRadius,
        maxZ: bz + roofRadius,
        getHeight: (qx: number, qz: number) => {
          const d = Math.max(Math.abs(qx - bx), Math.abs(qz - bz));
          if (d <= .3) return by + roofH * .95 + .125; // visible ridge cap
          const t = Math.max(0, 1 - d / roofRadius);
          return by + t * roofH;
        },
      });

      this.destructibles.set(id, {
        id,
        type: 'buildable',
        materialType: material,
        health: maxHp,
        maxHealth: maxHp,
        mesh: group,
        position: new THREE.Vector3(bx, by + roofH / 2, bz),
        hitShakeTimer: 0,
        spawnScaleTimer: 0.16,
        gridKey: cellKey,
      });
    } else {
      const rampW = 3.2;
      const rampLen = 3.6;
      const rampH = 2.8;
      const slopeLen = Math.hypot(rampLen, rampH);
      const group = new THREE.Group();
      group.position.set(bx, by, bz);

      const rampMesh = new THREE.Mesh(new THREE.BoxGeometry(rampW, 0.25, slopeLen), mat);
      rampMesh.position.set(0, rampH / 2, 0);
      rampMesh.rotation.x = Math.atan2(rampH, rampLen);
      rampMesh.userData.destructibleId = id;

      const railL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.36, slopeLen), trimMat);
      railL.position.set(-rampW / 2 + 0.1, rampH / 2 + 0.1, 0);
      railL.rotation.x = Math.atan2(rampH, rampLen);
      const railR = railL.clone();
      railR.position.x = rampW / 2 - 0.1;

      group.add(rampMesh, railL, railR);
      group.rotation.y = snappedYaw;
      group.userData.destructibleId = id;
      group.scale.setScalar(0.2);

      this.worldGroup.add(group);
      this.raycastMeshes.push(group);

      const halfX = isEastWest ? rampLen/2 : rampW/2;
      const halfZ = isEastWest ? rampW/2 : rampLen/2;
      // The slab's upper face shifts downhill when its thickness is rotated.
      const dirX = -Math.sin(snappedYaw);
      const dirZ = -Math.cos(snappedYaw);
      const topShift = .125 * Math.sin(Math.atan2(rampH, rampLen));
      const surfaceX = bx - dirX * topShift;
      const surfaceZ = bz - dirZ * topShift;

      this.walkableSurfaces.push({
        id,
        minX: surfaceX - halfX,
        maxX: surfaceX + halfX,
        minZ: surfaceZ - halfZ,
        maxZ: surfaceZ + halfZ,
        getHeight: (qx: number, qz: number) => {
          const relX = qx - bx;
          const relZ = qz - bz;
          const proj = relX * dirX + relZ * dirZ;
          return by + rampH/2 + proj * rampH/rampLen + .125 / Math.cos(Math.atan2(rampH,rampLen));
        },
      });

      this.destructibles.set(id, {
        id,
        type: 'buildable',
        materialType: material,
        health: maxHp,
        maxHealth: maxHp,
        mesh: group,
        position: new THREE.Vector3(bx, by + 1.2, bz),
        hitShakeTimer: 0,
        spawnScaleTimer: 0.16,
        gridKey: cellKey,
      });
    }

    const createdProp = this.destructibles.get(id);
    if (createdProp) {
      this.activeAnimatedProps.add(createdProp);
    }

    return {
      id,
      ownerId,
      pieceType,
      material,
      position: { x: bx, y: by, z: bz },
      rotationY: snappedYaw,
      health: maxHp,
      maxHealth: maxHp,
    };
  }

  public damageDestructible(
    id: string,
    damage: number
  ): {
    destroyed: boolean;
    materialType: BuildMaterialType;
    position: THREE.Vector3;
    health: number;
    maxHealth: number;
  } | null {
    const prop = this.destructibles.get(id);
    if (!prop) return null;

    prop.health -= damage;
    prop.hitShakeTimer = 0.18;
    this.activeAnimatedProps.add(prop);

    // Update visible structure damage state (color darkening & critical warning glow)
    if (prop.health > 0 && prop.type === 'buildable') {
      const hpRatio = Math.max(0, prop.health / prop.maxHealth);
      prop.mesh.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
          if (mat && mat.emissive) {
            if (hpRatio < 0.35) {
              mat.emissive.setHex(0xef4444);
              mat.emissiveIntensity = 0.38;
            } else if (hpRatio < 0.7) {
              mat.emissive.setHex(0xf59e0b);
              mat.emissiveIntensity = 0.22;
            }
          }
        }
      });
    }

    if (prop.health <= 0) {
      this.activeAnimatedProps.delete(prop);
      if (prop.gridKey) {
        this.occupiedBuildCells.delete(prop.gridKey);
      }
      if (prop.updateInstanceTransform) {
        prop.updateInstanceTransform(0, 0);
      } else {
        this.worldGroup.remove(prop.mesh);
        const meshIdx = this.raycastMeshes.indexOf(prop.mesh);
        if (meshIdx !== -1) this.raycastMeshes.splice(meshIdx, 1);
        if (prop.type === 'buildable') {
          this.disposeObject3D(prop.mesh);
        }
      }

      this.boxColliders = this.boxColliders.filter((c) => c.destructibleId !== id);
      this.cylinderColliders = this.cylinderColliders.filter((c) => c.destructibleId !== id);
      this.walkableSurfaces = this.walkableSurfaces.filter((s) => s.id !== id);
      this.destructibles.delete(id);

      return {
        destroyed: true,
        materialType: prop.materialType,
        position: prop.position.clone(),
        health: 0,
        maxHealth: prop.maxHealth,
      };
    }

    return {
      destroyed: false,
      materialType: prop.materialType,
      position: prop.position.clone(),
      health: Math.max(0, Math.round(prop.health)),
      maxHealth: prop.maxHealth,
    };
  }

  /** Sample only on a footstep event, not every frame; reuse existing surfaces. */
  public getFootstepSurface(x: number, y: number, z: number): 'ground' | 'hard' | 'wood' | 'metal' {
    let highest = -Infinity;
    let material: 'ground' | 'hard' | 'wood' | 'metal' = 'ground';
    for (const surface of this.walkableSurfaces) {
      if (x < surface.minX || x > surface.maxX || z < surface.minZ || z > surface.maxZ) continue;
      const height = surface.getHeight(x,z);
      if (Math.abs(height-y) > .45 || height <= highest) continue;
      highest = height;
      const propMaterial = surface.id ? this.destructibles.get(surface.id)?.materialType : undefined;
      material = propMaterial === 'wood' || propMaterial === 'metal' ? propMaterial : 'hard';
    }
    return material;
  }

  public getGroundHeightAt(x: number, currentY: number, z: number, maxRise = 1.35, supportRadius = 0): number {
    let highest = Math.max(-0.85, this.terrain.getTerrainHeight(x, z));

    for (const surf of this.walkableSurfaces) {
      if (x >= surf.minX && x <= surf.maxX && z >= surf.minZ && z <= surf.maxZ) {
        const sh = surf.getHeight(x, z);
        if (sh <= currentY + maxRise + 1e-6 && sh > highest) {
          highest = sh;
        }
      }
    }

    // Solid collider tops are support planes too (parapets, crates, silos).
    // Otherwise a glider enters their volume and the server repeatedly rewinds
    // it before it can ever reach the lower named walkable surface.
    const ceiling = currentY + maxRise + 1e-6;
    for (const box of this.boxColliders) {
      if (box.maxY > highest && box.maxY <= ceiling &&
          x >= box.minX-supportRadius && x <= box.maxX+supportRadius && z >= box.minZ-supportRadius && z <= box.maxZ+supportRadius) highest = box.maxY;
    }
    for (const cylinder of this.cylinderColliders) {
      if (cylinder.maxY > highest && cylinder.maxY <= ceiling &&
          (x-cylinder.x)**2 + (z-cylinder.z)**2 <= (cylinder.radius+supportRadius)**2) highest = cylinder.maxY;
    }
    return highest;
  }

  public resolveHorizontalCollision(
    x: number,
    y: number,
    z: number,
    radius: number
  ): { x: number; z: number; collided: boolean } {
    let rx = x;
    let rz = z;
    let collided = false;
    const charBottom = y + 0.35;
    const charTop = y + 1.75;

    for (const cyl of this.cylinderColliders) {
      if (charTop < cyl.minY || charBottom > cyl.maxY) continue;
      const dx = rx - cyl.x;
      const dz = rz - cyl.z;
      const distSq = dx * dx + dz * dz;
      const minDist = radius + cyl.radius;
      if (distSq < minDist * minDist && distSq > 0.00001) {
        const dist = Math.sqrt(distSq);
        const overlap = minDist - dist;
        rx += (dx / dist) * overlap;
        rz += (dz / dist) * overlap;
        collided = true;
      }
    }

    for (const box of this.boxColliders) {
      if (charTop < box.minY || charBottom > box.maxY) continue;
      const closestX = Math.max(box.minX, Math.min(rx, box.maxX));
      const closestZ = Math.max(box.minZ, Math.min(rz, box.maxZ));
      const dx = rx - closestX;
      const dz = rz - closestZ;
      const distSq = dx * dx + dz * dz;

      if (distSq < radius * radius) {
        collided = true;
        if (distSq > 0.0001) {
          const dist = Math.sqrt(distSq);
          const overlap = radius - dist;
          rx += (dx / dist) * overlap;
          rz += (dz / dist) * overlap;
        } else {
          const penLeft = Math.abs(rx - box.minX);
          const penRight = Math.abs(box.maxX - rx);
          const penBack = Math.abs(rz - box.minZ);
          const penFront = Math.abs(rz - box.maxZ);
          const minPen = Math.min(penLeft, penRight, penBack, penFront);
          if (minPen === penLeft) rx = box.minX - radius;
          else if (minPen === penRight) rx = box.maxX + radius;
          else if (minPen === penBack) rz = box.minZ - radius;
          else rz = box.maxZ + radius;
        }
      }
    }

    const maxRadius = this.terrain.islandRadius + 10;
    const distCenter = Math.hypot(rx, rz);
    if (distCenter > maxRadius) {
      rx = (rx / distCenter) * maxRadius;
      rz = (rz / distCenter) * maxRadius;
      collided = true;
    }

    return { x: rx, z: rz, collided };
  }

  /**
   * Fast analytical path-obstruction check against boxColliders and cylinderColliders
   * for BotAIController whisker steering (zero allocations, zero triangle intersections).
   */
  public isPathBlockedFast(
    px: number,
    py: number,
    pz: number,
    dirX: number,
    dirZ: number,
    maxDist: number
  ): { blocked: boolean; distance: number } {
    let bestDist = maxDist + 1;
    const minY = py + 0.35;
    const maxY = py + 1.75;

    for (let i = 0; i < this.cylinderColliders.length; i++) {
      const cyl = this.cylinderColliders[i];
      if (maxY < cyl.minY || minY > cyl.maxY) continue;
      const toX = cyl.x - px;
      const toZ = cyl.z - pz;
      const proj = toX * dirX + toZ * dirZ;
      if (proj < 0 || proj > maxDist + cyl.radius) continue;
      const perpSq = toX * toX + toZ * toZ - proj * proj;
      const rPad = cyl.radius + 0.45;
      if (perpSq < rPad * rPad) {
        const hitDist = Math.max(0, proj - Math.sqrt(rPad * rPad - perpSq));
        if (hitDist < bestDist && hitDist <= maxDist) {
          bestDist = hitDist;
        }
      }
    }

    for (let i = 0; i < this.boxColliders.length; i++) {
      const box = this.boxColliders[i];
      if (maxY < box.minY || minY > box.maxY) continue;
      // Quick bounding range reject
      const midX = (box.minX + box.maxX) * 0.5;
      const midZ = (box.minZ + box.maxZ) * 0.5;
      if (Math.abs(midX - px) > maxDist + 6 || Math.abs(midZ - pz) > maxDist + 6) continue;

      const pad = 0.4;
      const bMinX = box.minX - pad;
      const bMaxX = box.maxX + pad;
      const bMinZ = box.minZ - pad;
      const bMaxZ = box.maxZ + pad;

      let tMin = 0;
      let tMax = maxDist;

      if (Math.abs(dirX) < 1e-6) {
        if (px < bMinX || px > bMaxX) continue;
      } else {
        const invX = 1 / dirX;
        let t1 = (bMinX - px) * invX;
        let t2 = (bMaxX - px) * invX;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
        }
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) continue;
      }

      if (Math.abs(dirZ) < 1e-6) {
        if (pz < bMinZ || pz > bMaxZ) continue;
      } else {
        const invZ = 1 / dirZ;
        let t1 = (bMinZ - pz) * invZ;
        let t2 = (bMaxZ - pz) * invZ;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
        }
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) continue;
      }

      if (tMin < bestDist && tMin <= maxDist) {
        bestDist = tMin;
      }
    }

    return {
      blocked: bestDist <= maxDist,
      distance: bestDist,
    };
  }

  public raycastWorld(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number
  ): { point: THREE.Vector3; distance: number; destructibleId?: string } | null {
    let bestDist = maxDistance + 1;
    let bestPoint: THREE.Vector3 | null = null;
    let bestDestructibleId: string | undefined;

    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const dx = direction.x;
    const dy = direction.y;
    const dz = direction.z;

    // 1. Analytical Ray-Cylinder intersection (Trees, Rocks, Silos)
    const horizLenSq = dx * dx + dz * dz;
    if (horizLenSq > 1e-6) {
      const invHorizLenSq = 1 / horizLenSq;
      for (let i = 0; i < this.cylinderColliders.length; i++) {
        const cyl = this.cylinderColliders[i];
        const relX = cyl.x - ox;
        const relZ = cyl.z - oz;
        const tProj = (relX * dx + relZ * dz) * invHorizLenSq;
        if (tProj < 0 || tProj > Math.min(maxDistance, bestDist) + cyl.radius) continue;

        const closestX = ox + dx * tProj - cyl.x;
        const closestZ = oz + dz * tProj - cyl.z;
        const distSq = closestX * closestX + closestZ * closestZ;
        const rSq = cyl.radius * cyl.radius;
        if (distSq > rSq) continue;

        const dtHalf = Math.sqrt((rSq - distSq) * invHorizLenSq);
        const tEnter = Math.max(0.1, tProj - dtHalf);
        if (tEnter >= bestDist || tEnter > maxDistance) continue;

        const hitY = oy + dy * tEnter;
        if (hitY >= cyl.minY && hitY <= cyl.maxY) {
          bestDist = tEnter;
          bestPoint = new THREE.Vector3(ox + dx * tEnter, hitY, oz + dz * tEnter);
          bestDestructibleId = cyl.destructibleId;
        }
      }
    }

    // 2. Analytical Slab Ray-AABB intersection (Crates, Walls, Buildings)
    for (let i = 0; i < this.boxColliders.length; i++) {
      const box = this.boxColliders[i];
      let tMin = 0.1;
      let tMax = Math.min(maxDistance, bestDist);

      if (Math.abs(dx) < 1e-6) {
        if (ox < box.minX || ox > box.maxX) continue;
      } else {
        const invX = 1 / dx;
        let t1 = (box.minX - ox) * invX;
        let t2 = (box.maxX - ox) * invX;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
        }
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) continue;
      }

      if (Math.abs(dy) < 1e-6) {
        if (oy < box.minY || oy > box.maxY) continue;
      } else {
        const invY = 1 / dy;
        let t1 = (box.minY - oy) * invY;
        let t2 = (box.maxY - oy) * invY;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
        }
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) continue;
      }

      if (Math.abs(dz) < 1e-6) {
        if (oz < box.minZ || oz > box.maxZ) continue;
      } else {
        const invZ = 1 / dz;
        let t1 = (box.minZ - oz) * invZ;
        let t2 = (box.maxZ - oz) * invZ;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
        }
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) continue;
      }

      if (tMin < bestDist && tMin <= maxDistance) {
        bestDist = tMin;
        bestPoint = new THREE.Vector3(ox + dx * tMin, oy + dy * tMin, oz + dz * tMin);
        bestDestructibleId = box.destructibleId;
      }
    }

    // 3. Three.js Raycaster against non-AABB structures (Ramps, Roofs, Architectural Meshes)
    if (this.raycastMeshes.length > 0) {
      this.raycaster.set(origin, direction);
      this.raycaster.near = 0.1;
      this.raycaster.far = Math.min(maxDistance, bestDist);

      const hits = this.raycaster.intersectObjects(this.raycastMeshes, true);
      if (hits.length > 0) {
        const hit = hits[0];
        if (hit.distance < bestDist) {
          bestDist = hit.distance;
          bestPoint = hit.point;
          let obj: THREE.Object3D | null = hit.object;
          bestDestructibleId = undefined;
          while (obj) {
            if (obj.userData && obj.userData.destructibleId) {
              bestDestructibleId = obj.userData.destructibleId;
              break;
            }
            obj = obj.parent;
          }
        }
      }
    }

    // 4. Analytical Terrain Heightfield Ray March (replaces 86,528-triangle terrainMesh raycast)
    const searchLimit = Math.min(maxDistance, bestDist);
    if (dy < 0.35 && searchLimit > 0.2) {
      const steps = Math.min(18, Math.max(6, Math.ceil(searchLimit / 6)));
      const stepLen = searchLimit / steps;
      let prevT = 0.1;
      for (let s = 1; s <= steps; s++) {
        const curT = s * stepLen;
        const rx = ox + dx * curT;
        const ry = oy + dy * curT;
        const rz = oz + dz * curT;
        const terrY = this.terrain.getTerrainHeight(rx, rz);
        if (ry <= terrY) {
          // Refine crossing with 4 binary search steps
          let lo = prevT;
          let hi = curT;
          for (let b = 0; b < 4; b++) {
            const mid = (lo + hi) * 0.5;
            const my = oy + dy * mid;
            const mty = this.terrain.getTerrainHeight(ox + dx * mid, oz + dz * mid);
            if (my <= mty) hi = mid;
            else lo = mid;
          }
          if (hi < bestDist) {
            bestDist = hi;
            bestPoint = new THREE.Vector3(ox + dx * hi, oy + dy * hi, oz + dz * hi);
            bestDestructibleId = undefined;
          }
          break;
        }
        prevT = curT;
      }
    }

    if (!bestPoint || bestDist > maxDistance) return null;

    return {
      point: bestPoint,
      distance: bestDist,
      destructibleId: bestDestructibleId,
    };
  }

  public update(dt: number, cameraPos?: THREE.Vector3): void {
    this.animTime += dt;
    setFoliageWindTime(this.animTime);
    this.terrain.update(dt, cameraPos);

    if (this.monumentCrystal) {
      this.monumentCrystal.rotation.y += dt * 1.1;
      this.monumentCrystal.position.y =
        this.legendaryTowerCrystalBaseY + Math.sin(this.animTime * 2.2) * 0.25;
    }
    if (this.legendaryTowerBeaconGroup) {
      this.legendaryTowerBeaconGroup.rotation.y += dt * 0.16;
      const pulse = 1 + Math.sin(this.animTime * 2.6) * 0.035;
      this.legendaryTowerBeaconGroup.scale.set(pulse, 1, pulse);
    }
    const towerDistanceSq = cameraPos
      ? (cameraPos.x-LEGENDARY_TOWER.x)**2+(cameraPos.y-this.legendaryTowerRoofY)**2+(cameraPos.z-LEGENDARY_TOWER.z)**2 : 0;
    if (this.vaultLight) {
      this.vaultLight.visible = this.landmarkDetail && towerDistanceSq < 10000;
      this.vaultLight.intensity = 78 + Math.sin(this.animTime * .9) * 7;
    }
    if (this.legendaryTowerParticles) {
      this.legendaryTowerParticles.visible = this.landmarkDetail && towerDistanceSq < 8100;
      this.legendaryTowerParticles.rotation.y -= dt * 0.55;
      this.legendaryTowerParticles.position.y = Math.sin(this.animTime * 1.4) * 0.18;
    }

    if (this.ruinObeliskCrystal) {
      this.ruinObeliskCrystal.rotation.y -= dt * 1.4;
      this.ruinObeliskCrystal.position.y =
        this.terrain.getTerrainHeight(32, 122) + 4.2 + Math.cos(this.animTime * 2.5) * 0.22;
    }

    if (this.windmillBlades) {
      this.windmillBlades.rotation.z += dt * 0.9;
    }

    if (this.lighthouseBeam) {
      this.lighthouseBeam.rotation.y += dt * 0.85;
    }

    // Only update props that currently have active spawn-scale or hit-shake animations
    if (this.activeAnimatedProps.size > 0) {
      for (const prop of this.activeAnimatedProps) {
        let stillActive = false;
        let curScale = 1.0;
        let curShakeZ = 0.0;

        if (prop.spawnScaleTimer && prop.spawnScaleTimer > 0) {
          prop.spawnScaleTimer = Math.max(0, prop.spawnScaleTimer - dt);
          curScale = 1 - (prop.spawnScaleTimer / 0.16) * 0.8;
          prop.mesh.scale.setScalar(curScale);
          if (prop.spawnScaleTimer > 0) stillActive = true;
        }

        if (prop.hitShakeTimer > 0) {
          prop.hitShakeTimer = Math.max(0, prop.hitShakeTimer - dt);
          if (prop.hitShakeTimer > 0) {
            curShakeZ = Math.sin(prop.hitShakeTimer * 65) * 0.08;
            stillActive = true;
          }
          if (prop.updateInstanceTransform) {
            prop.updateInstanceTransform(curScale, curShakeZ);
          } else if (prop.type !== 'rock') {
            prop.mesh.rotation.z = curShakeZ;
          }
        }

        if (!stillActive) {
          this.activeAnimatedProps.delete(prop);
        }
      }
    }
  }
}
