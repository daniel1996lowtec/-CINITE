import * as THREE from 'three';
import { BRANDING_DESIGNS, BRANDING_SURFACE_GAP, BUILDING_BRANDING, ROAD_BRANDING } from './WorldBrandingLayout';
import type { BrandingDesign, BuildingBranding } from './WorldBrandingLayout';

// One power-of-two atlas, no font downloads, DOM overlays, per-letter meshes,
// custom shaders, lights or animation. Cell padding prevents mip-edge bleed.
export const BRANDING_ATLAS_SIZE = 1024;
const CELL_WIDTH = 512, CELL_HEIGHT = 128;
const DESIGN_KEYS = Object.keys(BRANDING_DESIGNS) as BrandingDesign[];

export function createBrandingAtlas(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null; // CPU world/loot tooling
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = BRANDING_ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  DESIGN_KEYS.forEach((key, index) => {
    const design = BRANDING_DESIGNS[key];
    ctx.save();
    ctx.translate((index % 2) * CELL_WIDTH, Math.floor(index / 2) * CELL_HEIGHT);
    const panel = design.style === 'panel' || design.style === 'neon';
    if (panel) {
      ctx.fillStyle = '#101c27'; ctx.fillRect(8, 8, 496, 112);
      ctx.strokeStyle = '#61909b'; ctx.lineWidth = 2; ctx.strokeRect(13, 13, 486, 102);
      ctx.fillStyle = '#48dce8'; ctx.fillRect(23, 23, 4, 82);
      ctx.fillStyle = '#adbac4';
      for (const x of [19, 493]) for (const y of [19, 109]) {
        ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `${design.style === 'graffiti' ? 'italic ' : ''}900 ${design.text === '$CI' ? 96 : 68}px ${design.style === 'stencil' ? 'monospace' : 'sans-serif'}`;
    const arrow = 'arrow' in design;
    ctx.save(); ctx.translate(arrow ? 279 : 256, 67);
    ctx.scale(Math.min(2.4, (arrow ? 370 : 440) / ctx.measureText(design.text).width), 1);
    ctx.lineWidth = design.style === 'graffiti' ? 5 : 2;
    ctx.strokeStyle = design.style === 'paint' || design.style === 'stencil' ? '#b8dbe2' : '#182830';
    ctx.strokeText(design.text, 0, 0);
    ctx.fillStyle = design.style === 'paint' || design.style === 'stencil' ? '#164b57'
      : design.style === 'neon' || design.style === 'graffiti' ? '#7aeaf0' : '#e7f5f6';
    ctx.fillText(design.text, 0, 0);
    ctx.restore();
    if (arrow) { // Left along the west facade = north, toward the avenue's north end.
      ctx.strokeStyle = '#7aeaf0'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(85, 66); ctx.lineTo(40, 66);
      ctx.moveTo(56, 50); ctx.lineTo(40, 66); ctx.lineTo(56, 82); ctx.stroke();
    }
    if (design.style === 'graffiti') {
      ctx.strokeStyle = '#7aeaf0'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(72, 114); ctx.lineTo(428, 103); ctx.stroke();
      // Fixed sparse overspray, never random per client or over the glyphs.
      for (let i = 0; i < 18; i++) ctx.fillRect(65 + i * 21, 116 + (i % 3), 2, 2);
    }
    if (design.style === 'stencil') {
      ctx.fillStyle = '#a4bac1'; ctx.fillRect(38, 25, 23, 3); ctx.fillRect(451, 103, 23, 3);
    }
    ctx.restore();
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'CI_CityBrandingAtlas';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;
  return texture;
}

function atlasUV(design: BrandingDesign, u: number, v: number): [number, number] {
  const index = DESIGN_KEYS.indexOf(design);
  return [((index % 2) * CELL_WIDTH + u * CELL_WIDTH) / BRANDING_ATLAS_SIZE,
    1 - (Math.floor(index / 2) * CELL_HEIGHT + (1 - v) * CELL_HEIGHT) / BRANDING_ATLAS_SIZE];
}

/** Clip a marking against the REAL terrain triangles. Each resulting face is
 * exactly coplanar with its support (plus 18 mm), including terrain cell seams.
 * No extra collision, walkable plane, or analytical height approximation.
 */
export function createRoadBrandingGeometry(terrain: THREE.BufferGeometry,
  marking: typeof ROAD_BRANDING[number]): THREE.BufferGeometry {
  interface Vertex { x: number; y: number; z: number; u: number; v: number }
  const positions: number[] = [], uvs: number[] = [];
  const source = terrain.getAttribute('position'), indices = terrain.getIndex();
  if (!indices) throw new Error('Branding requires indexed world terrain');
  const cos = Math.cos(marking.yaw), sin = Math.sin(marking.yaw);
  const vertex = (index: number): Vertex => {
    const x = source.getX(index), y = source.getY(index), z = source.getZ(index);
    const dx = x - marking.x, dz = z - marking.z;
    return { x, y, z, u: (cos * dx - sin * dz) / marking.width + 0.5,
      v: -(sin * dx + cos * dz) / marking.depth + 0.5 };
  };
  const clip = (polygon: Vertex[], axis: 'u' | 'v', limit: number, lower: boolean): Vertex[] => {
    const out: Vertex[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const insideA = lower ? a[axis] >= limit : a[axis] <= limit;
      const insideB = lower ? b[axis] >= limit : b[axis] <= limit;
      if (insideA) out.push(a);
      if (insideA !== insideB) {
        const t = (limit - a[axis]) / (b[axis] - a[axis]);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t, u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t });
      }
    }
    return out;
  };
  const halfX = Math.abs(cos) * marking.width / 2 + Math.abs(sin) * marking.depth / 2;
  const halfZ = Math.abs(sin) * marking.width / 2 + Math.abs(cos) * marking.depth / 2;
  for (let i = 0; i < indices.count; i += 3) {
    const a = indices.getX(i), b = indices.getX(i + 1), c = indices.getX(i + 2);
    // Reject the overwhelmingly distant terrain faces before allocating any
    // clipping vertices (one-time generation, never a frame-loop operation).
    if (Math.max(source.getX(a), source.getX(b), source.getX(c)) < marking.x - halfX ||
      Math.min(source.getX(a), source.getX(b), source.getX(c)) > marking.x + halfX ||
      Math.max(source.getZ(a), source.getZ(b), source.getZ(c)) < marking.z - halfZ ||
      Math.min(source.getZ(a), source.getZ(b), source.getZ(c)) > marking.z + halfZ) continue;
    const points = [vertex(a), vertex(b), vertex(c)];
    if (points.every(p => p.u < 0) || points.every(p => p.u > 1) ||
      points.every(p => p.v < 0) || points.every(p => p.v > 1)) continue;
    let polygon = points;
    for (const axis of ['u', 'v'] as const) {
      polygon = clip(polygon, axis, 0, true); polygon = clip(polygon, axis, 1, false);
    }
    for (let j = 1; j < polygon.length - 1; j++) {
      for (const p of [polygon[0], polygon[j], polygon[j + 1]]) {
        positions.push(p.x, p.y + BRANDING_SURFACE_GAP, p.z);
        uvs.push(...atlasUV('road', p.u, p.v));
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  return geometry;
}

export class WorldBranding {
  public readonly group = new THREE.Group();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly atlas = createBrandingAtlas();
  private readonly material = new THREE.MeshStandardMaterial({
    map: this.atlas, color: 0xffffff, roughness: 0.84, metalness: 0.08,
    alphaTest: 0.5, transparent: false, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  private readonly neonMaterial = this.material.clone();
  private disposed = false;

  constructor(scene: THREE.Scene, terrain: THREE.BufferGeometry, heightAt: (x: number, z: number) => number) {
    this.group.name = 'CI_CityWorldBranding';
    this.neonMaterial.emissive.set(0x7aeaf0);
    this.neonMaterial.emissiveMap = this.atlas;
    this.neonMaterial.emissiveIntensity = 0.32; // Two fixed signs, no lights/bloom/flicker.
    const geometries = new Map<BrandingDesign, THREE.PlaneGeometry>();
    const batches = new Map<string, BuildingBranding[]>();
    for (const sign of BUILDING_BRANDING) {
      const key = `${sign.districtId}_${sign.design}`;
      const batch = batches.get(key) ?? [];
      batch.push(sign); batches.set(key, batch);
    }
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0), scale = new THREE.Vector3();
    for (const [key, signs] of batches) {
      const design = signs[0].design;
      let geometry = geometries.get(design);
      if (!geometry) {
        geometry = new THREE.PlaneGeometry(1, 1);
        const uv = geometry.getAttribute('uv');
        for (let i = 0; i < uv.count; i++) uv.setXY(i, ...atlasUV(design, uv.getX(i), uv.getY(i)));
        geometries.set(design, geometry); this.geometries.add(geometry);
      }
      const mesh = new THREE.InstancedMesh(geometry, design === 'neon' ? this.neonMaterial : this.material, signs.length);
      mesh.name = `CI_Branding_${key}`;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.userData.brandingIds = signs.map(sign => sign.id);
      signs.forEach((sign, index) => {
        position.set(sign.x, heightAt(sign.anchorX, sign.anchorZ) + sign.y, sign.z);
        rotation.setFromAxisAngle(up, sign.yaw); scale.set(sign.width, sign.height, 1);
        mesh.setMatrixAt(index, matrix.compose(position, rotation, scale));
      });
      mesh.computeBoundingSphere(); mesh.computeBoundingBox();
      mesh.receiveShadow = true; // Never cast a sign-shaped shadow/cover cue.
      this.group.add(mesh);
    }
    for (const marking of ROAD_BRANDING) {
      const geometry = createRoadBrandingGeometry(terrain, marking);
      this.geometries.add(geometry);
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.name = `CI_Branding_${marking.id}`;
      mesh.receiveShadow = true; this.group.add(mesh);
    }
    scene.add(this.group);
  }

  /** World-lifetime resources, not reallocated on rounds/quality changes. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.group.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const child of this.group.children) if (child instanceof THREE.InstancedMesh) child.dispose();
    this.geometries.clear(); this.group.clear();
    this.material.dispose(); this.neonMaterial.dispose(); this.atlas?.dispose();
  }
}
