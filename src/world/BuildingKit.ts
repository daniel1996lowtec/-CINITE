import * as THREE from 'three';
import type { ArchitecturalMaterialLibrary } from './ArchitecturalMaterials';
import { mergeBufferGeometries } from './VisualAtmosphere';

/**
 * CI CRAFT 6.2 — modular building kit.
 *
 * The map's buildings were volumes assembled from unit boxes with thin decals
 * floating on the wall surface for windows and pilasters, and pyramid "cones"
 * standing in for roofs. This kit generates real, layered geometry instead:
 *
 *  - punched windows with a shadowed reveal, projecting frame, mullions,
 *    a drip-moulded stone sill and a bracketed head;
 *  - entrance portals with an architrave, panelled leaf, handle, transom,
 *    threshold steps, bracketed canopy and a wall lantern;
 *  - balconies with a fascia, corbels and a baluster railing;
 *  - a plinth, string courses, corner pilasters and a dentilled cornice;
 *  - pitched gable/shed roofs with an eaves overhang, soffit, fascia, gutter,
 *    ridge cap, chimney and pots, plus flat roofs with coping, skylights,
 *    louvred plant and pipework.
 *
 * Geometry is emitted per material slot and merged into a handful of meshes by
 * the caller, so a whole town of detailed buildings still costs only a few
 * draw calls. Vertex colours carry a baked ambient-occlusion term, which gives
 * the recesses real contact shading without a post-processing pass.
 */

export type KitSlot =
  | 'wall'
  | 'brick'
  | 'stone'
  | 'trim'
  | 'roof'
  | 'wood'
  | 'metal'
  | 'glass'
  | 'glow'
  | 'dark'
  | 'detailTrim'
  | 'detailMetal'
  | 'detailWood'
  | 'detailGlass'
  | 'detailStone'
  | 'detailRoof';

/**
 * Slots that carry *decorative* facade layers (frames, muntins, sills, dentils,
 * railings, gutters). They keep the full material quality on High/Ultra and are
 * dropped on Low/Medium, which is what keeps the detail tier affordable on
 * phones while the walls, glazing, roofs and doors stay present at every tier.
 */

export type WindowFacing = 'front' | 'back' | 'left' | 'right';

export interface KitAddOptions {
  /** Baked ambient occlusion multiplier (1 = fully lit, 0.35 = deep recess). */
  ao?: number;
  /** Albedo tint multiplied with the vertex AO term. */
  tint?: THREE.ColorRepresentation;
}

const WHITE = new THREE.Color(1, 1, 1);
const scratchColor = new THREE.Color();

function applyVertexColor(
  geometry: THREE.BufferGeometry,
  ao: number,
  tint: THREE.ColorRepresentation | undefined
): void {
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  scratchColor.set(tint ?? 0xffffff).multiplyScalar(ao);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = scratchColor.r;
    colors[i * 3 + 1] = scratchColor.g;
    colors[i * 3 + 2] = scratchColor.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Facing yaw so that local +Z points out of the wall. */
export function facingYaw(facing: WindowFacing): number {
  switch (facing) {
    case 'back':
      return Math.PI;
    case 'left':
      return -Math.PI / 2;
    case 'right':
      return Math.PI / 2;
    case 'front':
    default:
      return 0;
  }
}

/**
 * Accumulates transformed, ambient-occluded geometry per material slot.
 * Use `pushFrame` / `popFrame` for local coordinate systems (a building, then a
 * window unit, then a pane) and `add*` for the primitives.
 */
export class KitBuilder {
  private readonly parts = new Map<KitSlot, THREE.BufferGeometry[]>();
  private readonly stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  private readonly scratch = new THREE.Matrix4();

  public readonly materials: ArchitecturalMaterialLibrary;
  /**
   * Building wall colour applied to 'wall'/'brick' parts that do not specify
   * their own tint, so kit gables, parapets and reveals always match the
   * instanced shell they belong to.
   */
  public wallTint: THREE.Color | null = null;

  constructor(materials: ArchitecturalMaterialLibrary) {
    this.materials = materials;
  }

  public get current(): THREE.Matrix4 {
    return this.stack[this.stack.length - 1];
  }

  public pushFrame(matrix: THREE.Matrix4): void {
    this.stack.push(new THREE.Matrix4().multiplyMatrices(this.current, matrix));
  }

  public popFrame(): void {
    if (this.stack.length > 1) this.stack.pop();
  }

  /** Pushes a frame translated/rotated in the current local space. */
  public pushTransform(
    x: number,
    y: number,
    z: number,
    yaw = 0,
    pitch = 0,
    roll = 0
  ): void {
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(pitch, yaw, roll, 'YXZ')
    );
    matrix.compose(
      new THREE.Vector3(x, y, z),
      quaternion,
      new THREE.Vector3(1, 1, 1)
    );
    this.pushFrame(matrix);
  }

  public addGeometry(
    slot: KitSlot,
    geometry: THREE.BufferGeometry,
    options: KitAddOptions = {}
  ): void {
    const geo = geometry.index ? geometry.toNonIndexed() : geometry;
    geo.applyMatrix4(this.current);
    if (!geo.getAttribute('uv')) {
      const count = geo.getAttribute('position').count;
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    let tint = options.tint;
    if (tint === undefined && this.wallTint && (slot === 'wall' || slot === 'brick')) {
      tint = this.wallTint;
    }
    applyVertexColor(geo, options.ao ?? 1, tint);
    let list = this.parts.get(slot);
    if (!list) {
      list = [];
      this.parts.set(slot, list);
    }
    list.push(geo);
  }

  public addBox(
    slot: KitSlot,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    options: KitAddOptions & { yaw?: number; pitch?: number; roll?: number } = {}
  ): void {
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    if (options.pitch || options.yaw || options.roll) {
      const matrix = new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(options.pitch ?? 0, options.yaw ?? 0, options.roll ?? 0, 'YXZ')
      );
      matrix.setPosition(x, y, z);
      geo.applyMatrix4(matrix);
    } else {
      geo.translate(x, y, z);
    }
    this.addGeometry(slot, geo, options);
  }

  public addCylinder(
    slot: KitSlot,
    x: number,
    y: number,
    z: number,
    radiusTop: number,
    radiusBottom: number,
    height: number,
    segments: number,
    options: KitAddOptions & { yaw?: number; pitch?: number; roll?: number } = {}
  ): void {
    const geo = new THREE.CylinderGeometry(
      radiusTop,
      radiusBottom,
      height,
      segments,
      1,
      false
    );
    if (options.pitch || options.yaw || options.roll) {
      const matrix = new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(options.pitch ?? 0, options.yaw ?? 0, options.roll ?? 0, 'YXZ')
      );
      matrix.setPosition(x, y, z);
      geo.applyMatrix4(matrix);
    } else {
      geo.translate(x, y, z);
    }
    this.addGeometry(slot, geo, options);
  }

  /** Adds a single quad from four local-space corners (counter-clockwise). */
  public addQuad(
    slot: KitSlot,
    corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3],
    options: KitAddOptions = {}
  ): void {
    const positions = new Float32Array(18);
    const order = [0, 1, 2, 0, 2, 3];
    order.forEach((index, i) => {
      const corner = corners[index];
      positions[i * 3] = corner.x;
      positions[i * 3 + 1] = corner.y;
      positions[i * 3 + 2] = corner.z;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(12), 2));
    geo.computeVertexNormals();
    this.addGeometry(slot, geo, options);
  }

  /** Adds an arbitrary triangle strip of positions (3n floats). */
  public addTriangles(
    slot: KitSlot,
    positions: number[],
    options: KitAddOptions = {}
  ): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((positions.length / 3) * 2), 2));
    geo.computeVertexNormals();
    this.addGeometry(slot, geo, options);
  }

  public forEachPart(visitor: (slot: KitSlot, geometries: THREE.BufferGeometry[]) => void): void {
    for (const [slot, geometries] of this.parts.entries()) {
      if (geometries.length) visitor(slot, geometries);
    }
  }

  public get triangleCount(): number {
    let total = 0;
    for (const geometries of this.parts.values()) {
      for (const geo of geometries) {
        total += geo.getAttribute('position').count / 3;
      }
    }
    return total;
  }

  public clear(): void {
    for (const geometries of this.parts.values()) {
      for (const geo of geometries) geo.dispose();
    }
    this.resetParts();
  }

  /** Drops the queued part references without disposing (post-merge). */
  public resetParts(): void {
    this.parts.clear();
    this.stack.length = 1;
    this.stack[0].identity();
  }

  public static identityTint(): THREE.Color {
    return WHITE.clone();
  }
}

/* ------------------------------------------------------------------ */
/* Window units                                                        */
/* ------------------------------------------------------------------ */

export interface WindowSpec {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  facing: WindowFacing;
  style?: 'punched' | 'shopfront' | 'french' | 'narrow';
  shutters?: boolean;
  planter?: boolean;
  awning?: boolean;
  /** Warm interior light visible through the glass. */
  lit?: boolean;
}

/**
 * A complete punched window: shadowed reveal, project frame, glazing, muntins,
 * sill with drip and a bracketed head. `shopfront` scales the glazing up and
 * adds a metal shopfront frame; `french` produces a balcony door.
 */
export function addWindowUnit(builder: KitBuilder, spec: WindowSpec): void {
  const style = spec.style ?? 'punched';
  const w = spec.width;
  const h = spec.height;
  const isShop = style === 'shopfront';
  const isFrench = style === 'french';
  const frameDepth = isShop ? 0.16 : 0.11;
  const frameWidth = isShop ? 0.09 : 0.085;

  builder.pushTransform(spec.x, spec.y, spec.z, facingYaw(spec.facing));

  const innerW = w - frameWidth * 2;

  // 1. Recessed reveal / interior depth: a near-black back plane set behind the
  //    glass plus four jamb returns. This is what stops windows reading as
  //    stickers: the glass is visually behind the wall face and the returns
  //    catch a sliver of light.
  builder.addBox('dark', 0, 0, -0.035, w - 0.02, h - 0.02, 0.06, { ao: 0.55 });
  builder.addBox('dark', 0, h / 2 - 0.055, 0.02, w - 0.05, 0.11, 0.12, { ao: 0.62 });
  builder.addBox('dark', 0, -h / 2 + 0.055, 0.02, w - 0.05, 0.11, 0.12, { ao: 0.62 });
  builder.addBox('dark', -w / 2 + 0.045, 0, 0.02, 0.09, h - 0.1, 0.12, { ao: 0.52 });
  builder.addBox('dark', w / 2 - 0.045, 0, 0.02, 0.09, h - 0.1, 0.12, { ao: 0.52 });

  // 2. Glazing, slightly behind the outer frame plane.
  const litTint = spec.lit ? 0xffe9bd : 0xffffff;
  builder.addBox('glass', 0, 0, 0.045, innerW, h - frameWidth * 1.6, 0.028, {
    ao: spec.lit ? 1 : 0.9,
    tint: litTint,
  });
  if (spec.lit) {
    builder.addBox('glow', 0, 0, -0.02, innerW * 0.86, (h - frameWidth * 1.6) * 0.8, 0.02, {
      ao: 0.85,
      tint: 0xffedc8,
    });
  }

  // 3. Protruding frame with a moulded outer edge and a glazing bead.
  const frameZ = 0.085;
  builder.addBox('detailTrim', 0, h / 2 - frameWidth / 2, frameZ, w, frameWidth, frameDepth, { ao: 1 });
  builder.addBox('detailTrim', 0, -h / 2 + frameWidth / 2, frameZ, w, frameWidth, frameDepth, {
    ao: 0.96,
  });
  builder.addBox('detailTrim', -w / 2 + frameWidth / 2, 0, frameZ, frameWidth, h - frameWidth * 2, frameDepth, {
    ao: 0.98,
  });
  builder.addBox('detailTrim', w / 2 - frameWidth / 2, 0, frameZ, frameWidth, h - frameWidth * 2, frameDepth, {
    ao: 0.98,
  });
  // Glazing bead (a thin inner lip that reads as the sash edge).
  builder.addBox('detailTrim', 0, 0, 0.062, innerW + 0.02, 0.035, 0.03, { ao: 0.85 });
  builder.addBox('detailTrim', 0, 0, 0.062, 0.035, h - frameWidth * 1.6, 0.03, { ao: 0.85 });

  // 4. Muntins: one vertical + one horizontal bar (two-pane casement).
  const barZ = 0.075;
  builder.addBox('detailTrim', 0, 0, barZ, 0.045, h - frameWidth * 1.7, 0.035, { ao: 0.92 });
  if (!isFrench) {
    builder.addBox('detailTrim', 0, h * 0.12, barZ, innerW, 0.04, 0.035, { ao: 0.92 });
  }

  // 5. Stone sill with a weathered top and a drip groove under the nose.
  builder.addBox('detailStone', 0, -h / 2 - 0.055, 0.1, w + 0.4, 0.12, 0.36, {
    ao: 0.9,
    pitch: -0.045,
  });
  builder.addBox('detailTrim', 0, -h / 2 - 0.13, 0.2, w + 0.36, 0.045, 0.1, { ao: 0.5 });

  // 6. Head: a lintel with a keystone and a shadow gap.
  builder.addBox('detailStone', 0, h / 2 + 0.075, 0.07, w + 0.34, 0.16, 0.28, { ao: 0.98 });
  builder.addBox('detailTrim', 0, h / 2 + 0.175, 0.03, w + 0.24, 0.05, 0.16, { ao: 0.62 });
  builder.addBox('detailStone', 0, h / 2 + 0.11, 0.12, isShop ? 0.3 : 0.2, 0.24, 0.3, { ao: 1 });

  if (spec.shutters) {
    const shutterW = w * 0.48;
    for (const side of [-1, 1]) {
      builder.pushTransform(side * (w / 2 + shutterW / 2 + 0.03), 0, 0.12, side * 0.16);
      builder.addBox('detailWood', 0, 0, 0, shutterW, h * 0.98, 0.045, { ao: 0.88 });
      builder.addBox('detailWood', 0, h * 0.4, 0.03, shutterW * 0.86, 0.05, 0.03, { ao: 0.78 });
      builder.addBox('detailWood', 0, 0, 0.03, shutterW * 0.86, 0.05, 0.03, { ao: 0.78 });
      builder.addBox('detailWood', 0, -h * 0.4, 0.03, shutterW * 0.86, 0.05, 0.03, { ao: 0.78 });
      builder.popFrame();
    }
  }

  if (spec.planter) {
    builder.addBox('detailWood', 0, -h / 2 - 0.2, 0.28, w * 0.78, 0.24, 0.3, { ao: 0.8 });
    builder.addBox('detailWood', 0, -h / 2 - 0.3, 0.28, w * 0.72, 0.06, 0.24, { ao: 0.55 });
    for (let i = -2; i <= 2; i++) {
      builder.addBox(
        'detailWood',
        i * (w * 0.14),
        -h / 2 - 0.06,
        0.28,
        0.16,
        0.14,
        0.14,
        { ao: 0.9, tint: 0x3f7d3f }
      );
    }
  }

  if (spec.awning) {
    builder.addBox('wood', 0, h / 2 + 0.28, 0.36, w + 0.4, 0.08, 0.9, {
      ao: 0.9,
      pitch: 0.22,
    });
    builder.addBox('detailWood', 0, h / 2 + 0.18, 0.8, w + 0.36, 0.16, 0.06, { ao: 0.7 });
    for (const side of [-1, 1]) {
      builder.addBox('metal', side * (w / 2 + 0.12), h / 2 + 0.05, 0.48, 0.05, 0.55, 0.05, {
        ao: 0.8,
      });
    }
  }

  builder.popFrame();
}

/* ------------------------------------------------------------------ */
/* Entrance portals                                                    */
/* ------------------------------------------------------------------ */

export interface DoorSpec {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  facing: WindowFacing;
  style?: 'residential' | 'shop' | 'industrial' | 'barn';
  steps?: number;
  canopy?: boolean;
  lantern?: boolean;
  tint?: THREE.ColorRepresentation;
}

export function addDoorPortal(builder: KitBuilder, spec: DoorSpec): void {
  const style = spec.style ?? 'residential';
  const w = spec.width;
  const h = spec.height;
  const isIndustrial = style === 'industrial' || style === 'barn';
  const isShop = style === 'shop';
  const leafW = isIndustrial ? w - 0.1 : w - 0.22;

  builder.pushTransform(spec.x, spec.y, spec.z, facingYaw(spec.facing));

  // Recessed reveal behind the leaf.
  builder.addBox('dark', 0, h / 2, -0.05, w, h, 0.08, { ao: 0.5 });
  builder.addBox('dark', 0, h - 0.03, 0.02, w, 0.1, 0.16, { ao: 0.6 });
  for (const side of [-1, 1]) {
    builder.addBox('dark', side * (w / 2 - 0.035), h / 2, 0.02, 0.08, h, 0.16, { ao: 0.52 });
  }

  // Architrave: jambs, head and a projecting hood mould.
  const arch = isIndustrial ? 0.12 : 0.16;
  builder.addBox('trim', -w / 2 - arch / 2, h / 2, 0.06, arch, h + arch, 0.16, { ao: 1 });
  builder.addBox('trim', w / 2 + arch / 2, h / 2, 0.06, arch, h + arch, 0.16, { ao: 1 });
  builder.addBox('trim', 0, h + arch / 2, 0.06, w + arch * 2, arch, 0.16, { ao: 1 });
  builder.addBox('stone', 0, h + arch + 0.06, 0.1, w + arch * 2 + 0.34, 0.14, 0.3, {
    ao: 0.95,
  });

  // Door leaf with recessed panels, stiles and a kick plate.
  if (isShop) {
    builder.addBox('glass', 0, h * 0.58, 0.03, leafW, h * 0.7, 0.03, { ao: 0.9 });
    builder.addBox('metal', 0, h * 0.58, 0.06, leafW, 0.06, 0.06, { ao: 0.9 });
    builder.addBox('metal', 0, h * 0.58, 0.06, 0.06, h * 0.7, 0.06, { ao: 0.9 });
    builder.addBox('metal', 0, h * 0.14, 0.03, leafW, h * 0.28, 0.05, {
      ao: 0.85,
      tint: spec.tint ?? 0xffffff,
    });
  } else if (isIndustrial) {
    builder.addBox('metal', 0, h / 2, 0.03, leafW, h - 0.06, 0.06, {
      ao: 0.9,
      tint: spec.tint ?? 0xffffff,
    });
    for (let i = 0; i < 4; i++) {
      builder.addBox('detailMetal', 0, h * (0.18 + i * 0.2), 0.07, leafW * 0.9, 0.05, 0.03, {
        ao: 0.8,
      });
    }
  } else {
    builder.addBox('wood', 0, h / 2, 0.03, leafW, h - 0.06, 0.06, {
      ao: 0.92,
      tint: spec.tint ?? 0xffffff,
    });
    // Raised field panels.
    builder.addBox('detailWood', 0, h * 0.72, 0.075, leafW * 0.7, h * 0.34, 0.035, { ao: 0.98 });
    builder.addBox('detailWood', 0, h * 0.3, 0.075, leafW * 0.7, h * 0.34, 0.035, { ao: 0.98 });
    builder.addBox('detailWood', 0, 0.14, 0.075, leafW * 0.86, 0.16, 0.03, { ao: 0.7 });
    builder.addBox('metal', 0, h * 0.52, 0.075, 0.04, 0.22, 0.04, { ao: 0.9 });
    builder.addBox('metal', 0, h * 0.52, 0.12, 0.16, 0.04, 0.04, { ao: 0.9 });
  }

  // Transom light over the leaf for shops and taller residential doors.
  if (h > 2.6 || isShop) {
    builder.addBox('glass', 0, h - 0.3, 0.05, w - 0.4, 0.38, 0.03, { ao: 0.95 });
    builder.addBox('detailTrim', 0, h - 0.52, 0.07, w - 0.34, 0.06, 0.06, { ao: 0.8 });
  }

  // Threshold and steps.
  const steps = spec.steps ?? (isIndustrial ? 1 : 2);
  for (let i = 0; i < steps; i++) {
    builder.addBox('stone', 0, 0.07 - i * 0.15, 0.35 + i * 0.34, w + 0.7 + i * 0.32, 0.15, 0.62, {
      ao: 0.7 + i * 0.08,
    });
  }
  builder.addBox('metal', 0, 0.02, 0.2, w + 0.05, 0.04, 0.12, { ao: 0.8 });

  if (spec.canopy !== false) {
    const canopyW = w + 1.5;
    builder.addBox('roof', 0, h + 0.62, 0.75, canopyW, 0.12, 1.6, { ao: 0.95, pitch: 0.1 });
    builder.addBox('detailWood', 0, h + 0.54, 1.5, canopyW, 0.14, 0.1, { ao: 0.8 });
    for (const side of [-1, 1]) {
      builder.addBox('metal', side * (canopyW / 2 - 0.28), h + 0.32, 0.7, 0.06, 0.5, 0.06, {
        ao: 0.8,
      });
      builder.addBox('metal', side * (canopyW / 2 - 0.28), h + 0.1, 1.0, 0.05, 0.5, 0.05, {
        ao: 0.75,
        pitch: -0.6,
      });
    }
  }

  if (spec.lantern !== false) {
    builder.addBox('metal', w / 2 + 0.42, h + 0.2, 0.14, 0.05, 0.05, 0.3, { ao: 0.9 });
    builder.addBox('metal', w / 2 + 0.42, h + 0.02, 0.3, 0.16, 0.26, 0.16, { ao: 0.85 });
    builder.addBox('glow', w / 2 + 0.42, h + 0.01, 0.3, 0.12, 0.2, 0.12, {
      ao: 1,
      tint: 0xffe6a8,
    });
  }

  builder.popFrame();
}

/* ------------------------------------------------------------------ */
/* Balconies                                                           */
/* ------------------------------------------------------------------ */

export interface BalconySpec {
  x: number;
  y: number;
  z: number;
  width: number;
  facing: WindowFacing;
  depth?: number;
  /** Slab already exists (owned by the caller); only add fascia + railing. */
  slabExists?: boolean;
}

export function addBalcony(builder: KitBuilder, spec: BalconySpec): void {
  const depth = spec.depth ?? 2.0;
  const width = spec.width;
  const railH = 0.98;
  builder.pushTransform(spec.x, spec.y, spec.z, facingYaw(spec.facing));

  if (!spec.slabExists) {
    builder.addBox('stone', 0, -0.11, depth / 2, width, 0.22, depth, { ao: 0.85 });
  }
  // Fascia band under the slab and two corbels tying it into the wall.
  builder.addBox('trim', 0, -0.3, depth / 2 - 0.02, width + 0.06, 0.16, depth + 0.04, { ao: 0.68 });
  for (const side of [-1, 1]) {
    builder.addBox('stone', side * width * 0.32, -0.42, 0.28, 0.24, 0.34, 0.5, {
      ao: 0.58,
      pitch: 0.35,
    });
  }

  // Railing: posts, top handrail, bottom rail and a baluster rhythm.
  const postX = width / 2 - 0.06;
  for (const side of [-1, 1]) {
    builder.addBox('detailMetal', side * postX, railH / 2 - 0.02, depth - 0.06, 0.07, railH, 0.07, {
      ao: 0.92,
    });
    builder.addBox('detailMetal', side * postX, railH / 2 - 0.02, 0.06, 0.07, railH, 0.07, {
      ao: 0.92,
    });
  }
  builder.addBox('detailMetal', 0, railH, depth - 0.06, width, 0.06, 0.07, { ao: 1 });
  builder.addBox('detailMetal', 0, 0.1, depth - 0.06, width, 0.05, 0.05, { ao: 0.8 });
  for (const side of [-1, 1]) {
    builder.addBox('detailMetal', side * postX, railH, depth / 2, 0.06, 0.06, depth, { ao: 1 });
    builder.addBox('detailMetal', side * postX, 0.1, depth / 2, 0.05, 0.05, depth, { ao: 0.8 });
  }
  const balusterCount = Math.max(4, Math.floor(width / 0.24));
  for (let i = 0; i <= balusterCount; i++) {
    const bx = -width / 2 + 0.06 + (i / balusterCount) * (width - 0.12);
    builder.addBox('detailMetal', bx, railH / 2, depth - 0.06, 0.028, railH * 0.9, 0.028, {
      ao: 0.86,
    });
  }
  const sideBalusters = Math.max(2, Math.floor(depth / 0.26));
  for (const side of [-1, 1]) {
    for (let i = 1; i < sideBalusters; i++) {
      const bz = (i / sideBalusters) * depth;
      builder.addBox('detailMetal', side * postX, railH / 2, bz, 0.028, railH * 0.9, 0.028, {
        ao: 0.82,
      });
    }
  }

  builder.popFrame();
}

/* ------------------------------------------------------------------ */
/* Facade rhythm: plinth, string course, pilasters, cornice            */
/* ------------------------------------------------------------------ */

export interface BlockSpec {
  width: number;
  depth: number;
  height: number;
  floors: number;
  midFloorY?: number;
  /** Fraction of the wall face that the entrance occupies (0..0.5). */
  cornerStyle?: 'pilaster' | 'quoin';
}

export function addPlinthAndCornice(builder: KitBuilder, spec: BlockSpec): void {
  const hw = spec.width / 2;
  const hd = spec.depth / 2;
  const h = spec.height;

  // Plinth: a projecting stone base course on all four faces.
  const plinthH = 0.46;
  builder.addBox('stone', 0, plinthH / 2, 0, spec.width + 0.22, plinthH, spec.depth + 0.22, {
    ao: 0.72,
  });
  builder.addBox('detailTrim', 0, plinthH + 0.04, 0, spec.width + 0.3, 0.09, spec.depth + 0.3, {
    ao: 0.9,
  });

  // Corner pilasters: vertical bands that soften the razor-sharp box corners
  // and give the silhouette a vertical rhythm.
  const pilW = 0.5;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      builder.addBox('trim', sx * (hw - 0.02), h / 2 + plinthH / 2, sz * (hd - 0.02), pilW, h - plinthH, pilW, {
        ao: 0.94,
        yaw: Math.PI / 4,
      });
    }
  }

  // String course between floors.
  if (spec.floors > 1 && spec.midFloorY) {
    const courseH = 0.16;
    builder.addBox('stone', 0, spec.midFloorY - 0.28, 0, spec.width + 0.28, courseH, spec.depth + 0.28, {
      ao: 0.9,
    });
    builder.addBox('detailTrim', 0, spec.midFloorY - 0.38, 0, spec.width + 0.34, 0.05, spec.depth + 0.34, {
      ao: 0.55,
    });
  }

  // Dentilled cornice under the roof line: three stepped bands plus dentils.
  const corniceY = h - 0.02;
  builder.addBox('stone', 0, corniceY, 0, spec.width + 0.5, 0.2, spec.depth + 0.5, { ao: 1 });
  builder.addBox('trim', 0, corniceY - 0.16, 0, spec.width + 0.36, 0.16, spec.depth + 0.36, {
    ao: 0.88,
  });
  builder.addBox('detailTrim', 0, corniceY - 0.3, 0, spec.width + 0.2, 0.1, spec.depth + 0.2, {
    ao: 0.5,
  });
  // Dentil rhythm is confined to the public (front) elevation: a full ring of
  // dentils on all four faces cost ~90 extra boxes per building for detail the
  // player never sees from the street.
  const dentilSpacing = 0.62;
  const nx = Math.max(4, Math.floor(spec.width / dentilSpacing));
  for (let i = 0; i < nx; i++) {
    const x = -hw + (i + 0.5) * (spec.width / nx);
    builder.addBox('detailTrim', x, corniceY - 0.27, hd + 0.1, 0.16, 0.12, 0.12, {
      ao: 0.68,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Rainwater goods                                                     */
/* ------------------------------------------------------------------ */

export function addRainwaterGoods(
  builder: KitBuilder,
  spec: { width: number; depth: number; height: number; gutterY: number; downpipes?: number }
): void {
  const hw = spec.width / 2;
  const hd = spec.depth / 2;
  const gutterY = spec.gutterY;

  // Half-round eaves gutter running around the four eaves.
  for (const sz of [-1, 1]) {
    builder.addBox('metal', 0, gutterY, sz * (hd + 0.42), spec.width + 0.9, 0.14, 0.24, {
      ao: 0.9,
    });
  }
  for (const sx of [-1, 1]) {
    builder.addBox('metal', sx * (hw + 0.42), gutterY, 0, 0.24, 0.14, spec.depth + 0.9, {
      ao: 0.9,
    });
  }

  const count = spec.downpipes ?? 2;
  const xs = count === 2 ? [-hw + 0.32, hw - 0.32] : [-hw + 0.32, 0, hw - 0.32];
  for (const x of xs) {
    for (const sz of [-1, 1]) {
      builder.addCylinder('metal', x, (gutterY - 0.1) / 2, sz * (hd + 0.2), 0.07, 0.07, gutterY - 0.1, 8, {
        ao: 0.85,
      });
      builder.addBox('detailMetal', x, gutterY - 0.22, sz * (hd + 0.2), 0.24, 0.1, 0.16, { ao: 0.9 });
      builder.addBox('detailMetal', x, 1.1, sz * (hd + 0.2), 0.22, 0.09, 0.14, { ao: 0.7 });
      builder.addBox('metal', x, 0.16, sz * (hd + 0.32), 0.16, 0.32, 0.3, { ao: 0.75 });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Roofs                                                               */
/* ------------------------------------------------------------------ */

export interface RoofSpec {
  width: number;
  depth: number;
  /** Wall height above the building base. */
  height: number;
  overhang?: number;
  pitch?: number;
  kind?: 'gable' | 'hip' | 'shed';
  tint?: THREE.ColorRepresentation;
}

/** Pitched gable roof with eaves, soffit, fascia, ridge cap and bargeboards. */
export function addGableRoof(builder: KitBuilder, spec: RoofSpec): void {
  const hw = spec.width / 2;
  const hd = spec.depth / 2;
  const overhang = spec.overhang ?? 0.6;
  const pitch = spec.pitch ?? 0.62; // rise / run
  const rise = hd * pitch;
  const eaveY = spec.height;
  const ridgeY = eaveY + rise;
  const thickness = 0.16;
  const tint = spec.tint;

  const x0 = -hw - overhang;
  const x1 = hw + overhang;
  const z0 = -(hd + overhang);
  const z1 = hd + overhang;

  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // Two sloped planes built from explicit quads, so the tiled surface is the
  // real slope (a rotated box would leave its end caps sticking out of the
  // gable and read as a white wing from ground level).
  for (const sz of [1, -1] as const) {
    const eaveZ = sz * (hd + overhang);
    // Top surface (outward-facing).
    const top: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] =
      sz === 1
        ? [v(x0, ridgeY, 0), v(x0, eaveY, eaveZ), v(x1, eaveY, eaveZ), v(x1, ridgeY, 0)]
        : [v(x1, ridgeY, 0), v(x1, eaveY, eaveZ), v(x0, eaveY, eaveZ), v(x0, ridgeY, 0)];
    builder.addQuad('roof', top, { ao: 1, tint });

    // Underside, offset by the tile thickness (reversed winding).
    const under: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
      v(top[3].x, top[3].y - thickness, top[3].z),
      v(top[2].x, top[2].y - thickness, top[2].z),
      v(top[1].x, top[1].y - thickness, top[1].z),
      v(top[0].x, top[0].y - thickness, top[0].z),
    ];
    builder.addQuad('detailWood', under, { ao: 0.42 });

    // Ridge-to-eave edge boards hide the tile thickness.
    for (const sx of [x0, x1]) {
      builder.addQuad(
        'trim',
        sz === 1
          ? [v(sx, ridgeY - thickness, 0), v(sx, eaveY - thickness, eaveZ), v(sx, eaveY, eaveZ), v(sx, ridgeY, 0)]
          : [v(sx, ridgeY, 0), v(sx, eaveY, eaveZ), v(sx, eaveY - thickness, eaveZ), v(sx, ridgeY - thickness, 0)],
        { ao: 0.82 }
      );
    }

    // Fascia along the eaves.
    builder.addBox('trim', 0, eaveY - thickness / 2 - 0.04, eaveZ, spec.width + overhang * 2, 0.26, 0.1, {
      ao: 0.86,
    });
    // Soffit only spans the overhang, between the wall face and the eave.
    builder.addBox(
      'detailTrim',
      0,
      eaveY - thickness - 0.02,
      sz * (hd + overhang * 0.5),
      spec.width + overhang * 2 - 0.06,
      0.04,
      overhang,
      { ao: 0.5 }
    );
    // Rafter tails visible from below, a strong "real roof" cue at eye level.
    for (let i = -2; i <= 2; i++) {
      builder.addBox(
        'detailWood',
        i * (spec.width / 4.4),
        eaveY - thickness - 0.09,
        sz * (hd + overhang * 0.55),
        0.1,
        0.14,
        overhang * 0.95,
        { ao: 0.62 }
      );
    }
    // Gutter runs the full length of the eaves.
    builder.addCylinder(
      'metal',
      0,
      eaveY - 0.22,
      sz * (hd + overhang + 0.04),
      0.1,
      0.1,
      spec.width + overhang * 2,
      8,
      { ao: 0.92, roll: Math.PI / 2, yaw: Math.PI / 2 }
    );
  }

  // Ridge cap: a raised, slightly wider strip that reads as clay ridge tiles.
  builder.addBox('roof', 0, ridgeY + 0.09, 0, spec.width + overhang * 2 + 0.04, 0.17, 0.44, {
    ao: 1,
    tint,
  });
  builder.addBox('roof', 0, ridgeY + 0.19, 0, spec.width + overhang * 2 + 0.04, 0.09, 0.24, {
    ao: 0.95,
    tint,
  });
  // Ridge finials at both ends.
  for (const sx of [-1, 1]) {
    builder.addBox('detailTrim', sx * (hw + overhang), ridgeY + 0.16, 0, 0.12, 0.3, 0.3, {
      ao: 0.9,
    });
  }

  // Gable-end walls fill the triangle between the wall head and the slopes.
  // They inherit the building's wall colour via KitBuilder.wallTint.
  for (const sx of [-1, 1] as const) {
    for (let layer = 0; layer < 2; layer++) {
      builder.addTriangles(
        'wall',
        [sx * hw, eaveY, -hd, sx * hw, eaveY, hd, sx * hw, ridgeY, 0],
        { ao: 0.94 - layer * 0.02 }
      );
    }
    // Bargeboard following the rake, plus a vent slot at the apex.
    builder.addBox('trim', sx * hw, eaveY + rise * 0.5, -hd * 0.5, 0.12, 0.3, 0.34, { ao: 0.8 });
    builder.addBox('detailMetal', sx * hw, ridgeY - 0.32, 0, 0.1, 0.2, 0.34, { ao: 0.7 });
  }

  // Chimney with a corbelled cap and two pots.
  const chimneyX = hw * 0.52;
  const chimneyZ = -hd * 0.34;
  const chimneyH = rise + 1.5;
  builder.addBox('brick', chimneyX, eaveY + chimneyH / 2, chimneyZ, 0.9, chimneyH, 0.9, {
    ao: 0.95,
  });
  builder.addBox('stone', chimneyX, eaveY + chimneyH + 0.08, chimneyZ, 1.14, 0.16, 1.14, {
    ao: 1,
  });
  for (const dx of [-0.24, 0.24]) {
    builder.addCylinder(
      'roof',
      chimneyX + dx,
      eaveY + chimneyH + 0.34,
      chimneyZ,
      0.14,
      0.16,
      0.4,
      8,
      { ao: 0.9, tint: 0xb45309 }
    );
  }

  // A dormer window on the street-facing slope for larger houses.
  if (spec.width >= 9.5) {
    const dormerZ = hd * 0.36;
    const dormerY = eaveY + rise * 0.52;
    builder.addBox('trim', 0, dormerY, dormerZ, 2.1, 1.5, 1.4, { ao: 0.95 });
    builder.addBox('glass', 0, dormerY + 0.12, dormerZ + 0.72, 1.3, 0.92, 0.04, { ao: 0.9 });
    builder.addBox('trim', 0, dormerY + 0.64, dormerZ + 0.76, 1.5, 0.1, 0.14, { ao: 1 });
    builder.addBox('roof', 0, dormerY + 0.86, dormerZ + 0.05, 2.4, 0.12, 1.7, {
      ao: 1,
      pitch: 0.34,
      tint,
    });
    for (const sx of [-1, 1]) {
      builder.addBox('detailTrim', sx * 1.03, dormerY, dormerZ + 0.1, 0.08, 1.4, 1.2, {
        ao: 0.7,
      });
    }
  }
}

/** Shallow shed roof for garages/outbuildings. */
export function addShedRoof(builder: KitBuilder, spec: RoofSpec): void {
  const hw = spec.width / 2;
  const hd = spec.depth / 2;
  const overhang = spec.overhang ?? 0.5;
  const pitch = spec.pitch ?? 0.22;
  const rise = spec.depth * pitch;
  const angle = Math.atan2(rise, spec.depth + overhang * 2);
  const eaveY = spec.height;
  const slopeLen = Math.hypot(spec.depth + overhang * 2, rise);

  builder.addBox('roof', 0, eaveY + rise / 2, 0, spec.width + overhang * 2, 0.18, slopeLen, {
    ao: 1,
    tint: spec.tint,
    pitch: -angle,
  });
  builder.addBox('trim', 0, eaveY - 0.02, hd + overhang, spec.width + overhang * 2, 0.28, 0.12, {
    ao: 0.9,
  });
  builder.addBox('metal', 0, eaveY - 0.02, hd + overhang + 0.1, spec.width + overhang * 2, 0.14, 0.2, {
    ao: 0.95,
  });
  builder.addBox('detailTrim', 0, eaveY - 0.12, 0, spec.width + overhang * 1.6, 0.06, spec.depth + overhang * 2, {
    ao: 0.42,
  });
  // Exposed purlins under the eaves read as real structure.
  for (let i = -2; i <= 2; i++) {
    builder.addBox('detailWood', i * (hw * 0.42), eaveY - 0.16, 0, 0.12, 0.16, spec.depth + overhang * 2, {
      ao: 0.62,
    });
  }
}

/** Flat roof with parapet coping, scuppers, skylights and louvred plant. */
export function addFlatRoofDetail(
  builder: KitBuilder,
  spec: {
    width: number;
    depth: number;
    /** Walkable roof deck height (above the building base). */
    deckY: number;
    /** Top of the parapet wall. */
    parapetTopY: number;
    tint?: THREE.ColorRepresentation;
    variant: number;
    /** Skip the parapet coping if the caller already draws the parapet. */
    coping?: boolean;
    /** Draw the parapet walls themselves (visual-only buildings). */
    parapet?: boolean;
    /** Half-width of the walkable opening in the parapet, if any. */
    gapHalfWidth?: number;
    /** Sides that contain a roof-ramp opening. */
    parapetGapSides?: Array<'front' | 'back' | 'left' | 'right'>;
  }
): void {
  const hw = spec.width / 2;
  const hd = spec.depth / 2;
  const y = spec.parapetTopY;
  const deck = spec.deckY;
  const coping = spec.coping !== false;
  const gap = spec.gapHalfWidth ?? 2.5;
  const drawParapet = spec.parapet === true;
  const ragged = spec.parapetGapSides ?? [];

  // Each parapet side is emitted as one or two runs so a roof ramp can arrive
  // through a genuine opening instead of clipping a wall.
  const runs: Array<{
    side: 'front' | 'back' | 'left' | 'right';
    cx: number;
    cz: number;
    sx: number;
    sz: number;
  }> = [];
  const addRun = (
    side: 'front' | 'back' | 'left' | 'right',
    cx: number,
    cz: number,
    sx: number,
    sz: number
  ) => runs.push({ side, cx, cz, sx, sz });

  const splitRun = (
    side: 'front' | 'back' | 'left' | 'right',
    alongX: boolean,
    length: number,
    centre: number,
    cross: number
  ) => {
    if (!ragged.includes(side)) {
      if (alongX) addRun(side, centre, cross, length, 0.5);
      else addRun(side, cross, centre, 0.5, length);
      return;
    }
    const half = Math.max(0.35, length / 2 - gap);
    for (const sign of [-1, 1]) {
      const offset = sign * (gap + half / 2);
      if (alongX) addRun(side, centre + offset, cross, half, 0.5);
      else addRun(side, cross, centre + offset, 0.5, half);
    }
  };

  splitRun('back', true, spec.width + 0.5, 0, -hd - 0.18);
  splitRun('front', true, spec.width + 0.5, 0, hd + 0.18);
  splitRun('left', false, spec.depth + 0.5, 0, -hw - 0.18);
  splitRun('right', false, spec.depth + 0.5, 0, hw + 0.18);

  for (const run of runs) {
    const offsetX = run.side === 'left' ? -0.12 : run.side === 'right' ? 0.12 : 0;
    if (drawParapet) {
      const wallH = Math.max(0.4, y - deck);
      builder.addBox(
        'wall',
        run.cx + offsetX,
        deck + wallH / 2,
        run.cz,
        run.sx + (run.side === 'left' || run.side === 'right' ? 0.24 : 0),
        wallH,
        run.sz + (run.side === 'left' || run.side === 'right' ? 0 : 0.24),
        { ao: 0.92 }
      );
      builder.addBox(
        'detailTrim',
        run.cx + offsetX,
        deck + 0.08,
        run.cz,
        run.sx + 0.1,
        0.1,
        run.sz + 0.1,
        { ao: 0.6 }
      );
    }
    if (coping) {
      builder.addBox(
        'stone',
        run.cx + offsetX,
        y + 0.06,
        run.cz,
        run.sx + (run.side === 'left' || run.side === 'right' ? 0.3 : 0.14),
        0.12,
        run.sz + (run.side === 'left' || run.side === 'right' ? 0.14 : 0.3),
        { ao: 1 }
      );
    }
  }

  // Parapet outer drip moulding.
  const dripY = y - 0.46;
  builder.addBox('detailTrim', 0, dripY, hd + 0.16, spec.width + 0.56, 0.08, 0.1, { ao: 0.5 });
  builder.addBox('detailTrim', 0, dripY, -hd - 0.16, spec.width + 0.56, 0.08, 0.1, { ao: 0.5 });

  // Skylights with aluminium frames, sitting on the deck.
  const skylightCount = 1 + (spec.variant % 2);
  for (let i = 0; i < skylightCount; i++) {
    const sx = (i === 0 ? -1 : 1) * hw * 0.34;
    const sz = hd * 0.3;
    builder.addBox('metal', sx, deck + 0.24, sz, 1.4, 0.42, 1.1, { ao: 0.95 });
    builder.addBox('glass', sx, deck + 0.47, sz, 1.16, 0.08, 0.88, { ao: 0.85 });
  }

  // Louvred HVAC plant.
  const hvacX = -hw * 0.45;
  const hvacZ = -hd * 0.34;
  builder.addBox('metal', hvacX, deck + 0.55, hvacZ, 1.9, 1.05, 1.4, { ao: 0.92 });
  builder.addBox('detailMetal', hvacX, deck + 0.02, hvacZ, 2.0, 0.06, 1.5, { ao: 0.55 });
  for (let i = 0; i < 5; i++) {
    builder.addBox('detailMetal', hvacX, deck + 0.24 + i * 0.19, hvacZ + 0.72, 1.6, 0.08, 0.06, {
      ao: 0.86,
    });
  }
  builder.addBox('detailMetal', hvacX, deck + 1.12, hvacZ, 2.0, 0.08, 1.5, { ao: 1 });

  // Vent stacks, a roof-access hatch and a perimeter pipe run.
  builder.addCylinder('metal', hw * 0.6, deck + 0.5, -hd * 0.55, 0.16, 0.16, 0.82, 8, { ao: 0.9 });
  builder.addBox('detailMetal', hw * 0.6, deck + 0.94, -hd * 0.55, 0.42, 0.06, 0.42, { ao: 1 });
  builder.addBox('trim', hw * 0.42, deck + 0.4, -hd * 0.16, 1.1, 0.8, 1.0, { ao: 0.95 });
  builder.addBox('metal', hw * 0.42, deck + 0.82, -hd * 0.16, 1.2, 0.08, 1.1, { ao: 1 });
  builder.addCylinder('detailMetal', 0, deck + 0.16, -hd + 0.45, 0.055, 0.055, spec.width * 0.7, 6, {
    ao: 0.8,
    roll: Math.PI / 2,
    yaw: Math.PI / 2,
  });
  builder.addBox('detailTrim', 0, deck + 0.02, hd * 0.7, spec.width * 0.5, 0.05, 0.9, {
    ao: 0.7,
    tint: spec.tint ?? 0x9ca3af,
  });
}

/* ------------------------------------------------------------------ */
/* Shopfronts, signs and street-level dressing                        */
/* ------------------------------------------------------------------ */

export interface ShopfrontSpec {
  x: number;
  y: number;
  z: number;
  width: number;
  doorWidth: number;
  facing: WindowFacing;
  accent?: THREE.ColorRepresentation;
  awning?: boolean;
}

export function addShopfront(builder: KitBuilder, spec: ShopfrontSpec): void {
  builder.pushTransform(spec.x, spec.y, spec.z, facingYaw(spec.facing));
  const glassW = (spec.width - spec.doorWidth) / 2 - 0.35;
  for (const side of [-1, 1]) {
    const cx = side * (spec.doorWidth / 2 + 0.25 + glassW / 2);
    // Display glazing with a deep metal shopfront frame.
    builder.addBox('dark', cx, 1.9, 0.02, glassW, 2.1, 0.08, { ao: 0.45 });
    builder.addBox('glass', cx, 1.9, 0.05, glassW - 0.06, 2.0, 0.03, { ao: 0.95 });
    builder.addBox('metal', cx, 0.85, 0.09, glassW, 0.12, 0.12, { ao: 1 });
    builder.addBox('metal', cx, 2.96, 0.09, glassW, 0.12, 0.12, { ao: 1 });
    builder.addBox('metal', cx - glassW / 2 + 0.06, 1.9, 0.09, 0.12, 2.2, 0.12, { ao: 1 });
    builder.addBox('metal', cx + glassW / 2 - 0.06, 1.9, 0.09, 0.12, 2.2, 0.12, { ao: 1 });
    // Warm interior glow behind the display glass.
    builder.addBox('glow', cx, 1.8, -0.02, glassW * 0.8, 1.5, 0.02, {
      ao: 0.55,
      tint: 0xffd9a0,
    });
    // Window display plinth and a mannequin-ish silhouette.
    builder.addBox('trim', cx, 1.02, 0.14, glassW * 0.8, 0.2, 0.34, { ao: 0.9 });
    builder.addBox('detailWood', cx, 1.5, 0.16, 0.34, 0.72, 0.2, { ao: 0.85 });
  }

  // Fascia board and signage band above the shopfront. The district accent is
  // a *paint* colour, not a light source: applied at full saturation across a
  // 12 m fascia it read as a neon stripe (pipeline_plaza's accent is hot pink).
  // It is therefore muted toward charcoal for the sign panel and toward canvas
  // for the awning, leaving only the glazed-display glow as a highlight.
  const accent = new THREE.Color(spec.accent ?? 0x1f2937);
  const signTint = accent.clone().lerp(new THREE.Color(0x1f2937), 0.45);
  const canvasTint = accent.clone().lerp(new THREE.Color(0xe8e2d4), 0.62);
  builder.addBox('trim', 0, 3.34, 0.12, spec.width - 0.4, 0.62, 0.14, { ao: 1 });
  builder.addBox('metal', 0, 3.34, 0.2, spec.width - 0.6, 0.46, 0.05, {
    ao: 1,
    tint: signTint.getHex(),
  });
  // Thin accent keyline along the sign panel edge keeps district identity.
  builder.addBox('detailMetal', 0, 3.13, 0.22, spec.width - 0.6, 0.03, 0.02, {
    ao: 1,
    tint: accent.getHex(),
  });

  if (spec.awning !== false) {
    builder.addBox('wood', 0, 3.06, 0.62, spec.width - 0.5, 0.08, 1.0, {
      ao: 0.92,
      pitch: 0.2,
      tint: canvasTint.getHex(),
    });
    builder.addBox('detailWood', 0, 2.96, 1.08, spec.width - 0.5, 0.2, 0.06, {
      ao: 0.8,
      tint: canvasTint.clone().multiplyScalar(0.88).getHex(),
    });
  }
  builder.popFrame();
}

/** Street furniture with authored proportions (bench, bollard, planter, bin). */
export function addBench(
  builder: KitBuilder,
  x: number,
  y: number,
  z: number,
  yaw: number
): void {
  builder.pushTransform(x, y, z, yaw);
  for (let i = -1; i <= 1; i++) {
    builder.addBox('detailWood', 0, 0.46, i * 0.16, 1.9, 0.06, 0.13, { ao: 0.9 });
  }
  builder.addBox('detailWood', 0, 0.72, -0.24, 1.9, 0.34, 0.06, { ao: 0.92, pitch: -0.12 });
  for (const side of [-1, 1]) {
    builder.addBox('metal', side * 0.78, 0.46, 0, 0.07, 0.92, 0.5, { ao: 0.85 });
    builder.addBox('metal', side * 0.78, 0.02, 0, 0.22, 0.06, 0.62, { ao: 0.7 });
  }
  builder.popFrame();
}

export function addBollard(
  builder: KitBuilder,
  x: number,
  y: number,
  z: number
): void {
  builder.addCylinder('metal', x, y + 0.46, z, 0.09, 0.11, 0.92, 10, { ao: 0.9 });
  builder.addCylinder('detailMetal', x, y + 0.94, z, 0.11, 0.11, 0.07, 10, { ao: 1 });
  builder.addBox('trim', x, y + 0.78, z, 0.18, 0.05, 0.18, { ao: 0.8, yaw: Math.PI / 4 });
}

export function addPlanter(
  builder: KitBuilder,
  x: number,
  y: number,
  z: number,
  size = 1.2
): void {
  builder.addBox('stone', x, y + 0.4, z, size, 0.8, size, { ao: 0.82 });
  builder.addBox('detailTrim', x, y + 0.83, z, size + 0.08, 0.08, size + 0.08, { ao: 0.95 });
  builder.addBox('wall', x, y + 0.84, z, size - 0.16, 0.1, size - 0.16, {
    ao: 0.55,
    tint: 0x3a2a1c,
  });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    builder.addBox('detailWood', x + Math.cos(a) * size * 0.28, y + 1.02, z + Math.sin(a) * size * 0.28, 0.3, 0.34, 0.3, {
      ao: 0.9,
      tint: i % 2 === 0 ? 0x3f7d3f : 0x2f6b34,
      yaw: a,
    });
  }
}

export function addStreetLamp(
  builder: KitBuilder,
  x: number,
  y: number,
  z: number,
  height = 4.4
): void {
  builder.addCylinder('metal', x, y + height / 2, z, 0.07, 0.11, height, 10, { ao: 0.9 });
  builder.addBox('metal', x, y + 0.14, z, 0.34, 0.28, 0.34, { ao: 0.8 });
  builder.addBox('metal', x, y + height + 0.06, z, 0.5, 0.08, 0.5, { ao: 1 });
  builder.addCylinder('glow', x, y + height - 0.14, z, 0.16, 0.2, 0.3, 8, {
    ao: 1,
    tint: 0xffe9b8,
  });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    builder.addBox('detailMetal', x + Math.cos(a) * 0.24, y + height + 0.02, z + Math.sin(a) * 0.24, 0.03, 0.2, 0.03, {
      ao: 0.9,
    });
  }
}

/** Wooden fence panel with posts, rails and pickets (replaces bare boxes). */
export function addFencePanel(
  builder: KitBuilder,
  x: number,
  y: number,
  z: number,
  length: number,
  yaw: number
): void {
  builder.pushTransform(x, y, z, yaw);
  const posts = Math.max(2, Math.round(length / 1.8));
  for (let i = 0; i <= posts; i++) {
    const px = -length / 2 + (i / posts) * length;
    builder.addBox('wood', px, 0.62, 0, 0.13, 1.28, 0.13, { ao: 0.9 });
    builder.addBox('detailWood', px, 1.28, 0, 0.18, 0.06, 0.18, { ao: 1 });
  }
  for (const cy of [0.42, 0.92]) {
    builder.addBox('detailWood', 0, cy, 0, length, 0.1, 0.06, { ao: 0.85 });
  }
  const pickets = Math.floor(length / 0.18);
  for (let i = 0; i < pickets; i++) {
    const px = -length / 2 + 0.09 + (i / pickets) * (length - 0.18);
    builder.addBox('detailWood', px, 0.62, 0, 0.09, 1.15, 0.035, { ao: 0.8 });
  }
  builder.popFrame();
}

/** Utility pole with crossarm, insulators and a catenary wire to the next pole. */
export function addUtilityPole(
  builder: KitBuilder,
  x: number,
  y: number,
  z: number,
  height: number
): void {
  builder.addCylinder('wood', x, y + height / 2, z, 0.13, 0.19, height, 8, { ao: 0.9 });
  builder.addBox('detailWood', x, y + height - 0.55, z, 2.2, 0.12, 0.14, { ao: 0.88 });
  for (const side of [-1, 1]) {
    builder.addCylinder('detailGlass', x + side * 0.85, y + height - 0.36, z, 0.07, 0.08, 0.14, 6, {
      ao: 0.95,
    });
  }
  builder.addBox('metal', x, y + height - 1.4, z, 0.34, 0.5, 0.16, { ao: 0.85 });
}

export function addSaggingWire(
  builder: KitBuilder,
  from: THREE.Vector3,
  to: THREE.Vector3,
  sag = 0.6,
  segments = 8
): void {
  let previous = from.clone();
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const point = new THREE.Vector3().lerpVectors(from, to, t);
    point.y -= Math.sin(t * Math.PI) * sag;
    const mid = new THREE.Vector3().addVectors(previous, point).multiplyScalar(0.5);
    const length = previous.distanceTo(point);
    const direction = new THREE.Vector3().subVectors(point, previous).normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction
    );
    const matrix = new THREE.Matrix4().compose(mid, quaternion, new THREE.Vector3(1, 1, 1));
    builder.pushFrame(matrix);
    builder.addBox('detailMetal', 0, 0, 0, 0.035, length, 0.035, { ao: 0.8 });
    builder.popFrame();
    previous = point;
  }
}

/* ------------------------------------------------------------------ */
/* Site / landscape props                                              */
/* ------------------------------------------------------------------ */

/** Retaining wall with coping, drainage and staggered stone courses. */
export function addRetainingWall(
  builder: KitBuilder,
  x: number,
  y: number,
  z: number,
  length: number,
  height: number,
  yaw: number
): void {
  builder.pushTransform(x, y, z, yaw);
  builder.addBox('stone', 0, height / 2, 0, length, height, 0.55, { ao: 0.84 });
  builder.addBox('detailTrim', 0, height + 0.06, 0, length + 0.08, 0.12, 0.66, { ao: 0.95 });
  builder.addBox('dark', 0, 0.22, 0.28, length * 0.9, 0.24, 0.04, { ao: 0.32 });
  const blocks = Math.max(2, Math.floor(length / 1.1));
  for (let i = 0; i < blocks; i++) {
    builder.addBox('detailTrim', -length / 2 + (i + 0.5) * (length / blocks), height * 0.55, 0.27, 0.04, height * 0.8, 0.02, { ao: 0.6 });
  }
  builder.popFrame();
}

/** Simple stone stair with a tread per step and cheek walls. */
export function addStoneStair(
  builder: KitBuilder,
  x: number,
  y: number,
  z: number,
  width: number,
  steps: number,
  rise: number,
  run: number,
  yaw: number
): void {
  builder.pushTransform(x, y, z, yaw);
  for (let i = 0; i < steps; i++) {
    builder.addBox('stone', 0, rise * (i + 0.5), run * (i + 0.5), width, rise, run, {
      ao: 0.78 + (i / steps) * 0.2,
    });
  }
  for (const side of [-1, 1]) {
    builder.addBox('stone', side * (width / 2 + 0.12), (steps * rise) / 2, (steps * run) / 2, 0.24, steps * rise, steps * run, {
      ao: 0.88,
    });
  }
  builder.popFrame();
}


/* ------------------------------------------------------------------ */
/* Merging                                                             */
/* ------------------------------------------------------------------ */

const DETAIL_SLOTS: ReadonlySet<KitSlot> = new Set([
  'detailTrim',
  'detailMetal',
  'detailWood',
  'detailGlass',
  'detailStone',
  'detailRoof',
]);

export function isDetailSlot(slot: KitSlot): boolean {
  return DETAIL_SLOTS.has(slot);
}

export function kitMaterialFor(
  materials: ArchitecturalMaterialLibrary,
  slot: KitSlot
): THREE.Material {
  switch (slot) {
    case 'brick':
      return materials.merged.brick;
    case 'stone':
    case 'detailStone':
      return materials.merged.ashlar;
    case 'trim':
    case 'detailTrim':
      return materials.merged.trim;
    case 'roof':
    case 'detailRoof':
      return materials.merged.roofTile;
    case 'wood':
    case 'detailWood':
      return materials.merged.timber;
    case 'metal':
    case 'detailMetal':
      return materials.merged.metal;
    case 'glass':
    case 'detailGlass':
      return materials.merged.glass;
    case 'glow':
      return materials.merged.glow;
    case 'dark':
      return materials.merged.dark;
    case 'wall':
    default:
      return materials.merged.plaster;
  }
}

export interface MergedKitMesh {
  slot: KitSlot;
  mesh: THREE.Mesh;
  detail: boolean;
}

/**
 * Merges every queued part into one mesh per material slot. A fully dressed
 * town therefore adds ~10 draw calls instead of one per window, sill or
 * baluster. Detail slots are flagged so the quality system can drop them.
 */
export function mergeKitParts(
  builder: KitBuilder,
  materials: ArchitecturalMaterialLibrary,
  namePrefix: string
): MergedKitMesh[] {
  const result: MergedKitMesh[] = [];
  builder.forEachPart((slot, geometries) => {
    if (!geometries.length) return;
    const merged = mergeBufferGeometries(geometries);
    for (const geometry of geometries) geometry.dispose();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, kitMaterialFor(materials, slot));
    mesh.name = `${namePrefix}_${slot}`;
    mesh.castShadow = slot !== 'glass' && slot !== 'glow';
    mesh.receiveShadow = slot !== 'glow';
    mesh.frustumCulled = true;
    result.push({ slot, mesh, detail: isDetailSlot(slot) });
  });
  return result;
}
