import * as THREE from 'three';

/**
 * CI CRAFT 6.2 — architectural material library.
 *
 * Why this module exists
 * ----------------------
 * Every instance of the map's architecture is a *unit* box/cylinder/cone whose
 * UVs run 0..1 across the whole primitive. When that primitive is scaled to a
 * 13 m x 7 m wall, a 64 px albedo is stretched across the entire facade: mortar
 * courses become 7 m tall, brick joints disappear, and the wall reads as a flat
 * painted cube. The previous pass compensated with a procedural world-space
 * "mortar" overlay, but the underlying texture was still stretched and 64 px.
 *
 * This module fixes the cause:
 *   1. Authored 512 px (256 px for hardware) tileable albedo + normal +
 *      roughness sets for plaster, brick, ashlar, clay roof tile, timber,
 *      painted trim, architectural metal and concrete.
 *   2. `applyWorldSpaceUv()` rewrites the map/normal/roughness UVs in the vertex
 *      shader from *world position* with a dominant-axis projection. Texture
 *      scale is therefore constant in metres no matter how the instance is
 *      scaled, and no wall can ever stretch a tile again.
 *   3. All maps stay deterministic (pure integer PRNG + periodic value noise)
 *      so the world is reproducible headlessly and pixel-identical per reload.
 */

const TAU = Math.PI * 2;

function hash01(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Periodic value noise: tiles seamlessly over `period` lattice cells. */
function periodicNoise(
  x: number,
  y: number,
  period: number,
  seed: number
): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const wrap = (v: number): number => ((v % period) + period) % period;
  const x0 = wrap(xi);
  const y0 = wrap(yi);
  const x1 = wrap(xi + 1);
  const y1 = wrap(yi + 1);
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const n00 = hash01(x0, y0, seed);
  const n10 = hash01(x1, y0, seed);
  const n01 = hash01(x0, y1, seed);
  const n11 = hash01(x1, y1, seed);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

/** Tileable fBm in [0,1]. `period` is the lattice size at the base octave. */
function fbm(
  u: number,
  v: number,
  period: number,
  octaves: number,
  seed: number,
  gain = 0.5
): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    sum += periodicNoise(u * p, v * p, p, seed + o * 131) * amplitude;
    total += amplitude;
    amplitude *= gain;
    p *= 2;
  }
  return sum / total;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

interface SurfaceSample {
  /** Linear-ish albedo in 0..1. */
  r: number;
  g: number;
  b: number;
  /** Height in 0..1 used to derive the tangent-space normal map. */
  h: number;
  /** 0 = mirror, 1 = fully diffuse. */
  rough: number;
}

type SurfaceSampler = (u: number, v: number) => SurfaceSample;

interface SurfaceDefinition {
  /** World metres covered by one texture tile. */
  metresPerTile: number;
  size: number;
  sampler: SurfaceSampler;
  /** Normal-map strength multiplier (1 = authored height range). */
  normalStrength?: number;
}

export interface SurfaceMapSet {
  albedo: THREE.DataTexture;
  normal: THREE.DataTexture;
  roughness: THREE.DataTexture;
  metresPerTile: number;
}

/* ------------------------------------------------------------------ */
/* Surface samplers                                                    */
/* ------------------------------------------------------------------ */

/** Fine lime plaster / stucco with trowel mottling and hairline cracks. */
const plasterSampler: SurfaceSampler = (u, v) => {
  const grain = fbm(u, v, 96, 3, 11);
  const mottle = fbm(u, v, 12, 4, 23);
  const patches = fbm(u, v, 4, 3, 37);
  const speck = hash01(Math.floor(u * 512), Math.floor(v * 512), 71);
  const base = 0.78 + (mottle - 0.5) * 0.1 + (patches - 0.5) * 0.06;
  const grit = (grain - 0.5) * 0.07 + (speck > 0.985 ? -0.12 : 0);
  const stain = smoothstep(0.72, 1.0, fbm(u, v, 7, 2, 97)) * 0.06;
  const lum = base + grit - stain;
  return {
    r: clamp01(lum * 1.005),
    g: clamp01(lum * 0.995),
    b: clamp01(lum * 0.975),
    h: clamp01(0.55 + (grain - 0.5) * 0.22 + (mottle - 0.5) * 0.16),
    rough: clamp01(0.86 + (mottle - 0.5) * 0.1 + (speck - 0.5) * 0.08),
  };
};

/** Running-bond clay brick with recessed mortar and per-brick firing variation. */
const brickSampler: SurfaceSampler = (u, v) => {
  // 26 courses and 8.8 bricks per 2 m tile -> 77 mm courses, 227 mm bricks.
  const courses = 26;
  const perRow = 8.8;
  const cy = v * courses;
  const row = Math.floor(cy);
  const fy = cy - row;
  const offset = (row % 2) * 0.5;
  const cx = u * perRow + offset;
  const col = Math.floor(cx);
  const fx = cx - col;

  const mortarY = smoothstep(0.0, 0.075, fy) * (1 - smoothstep(0.925, 1.0, fy));
  const mortarX = smoothstep(0.0, 0.035, fx) * (1 - smoothstep(0.965, 1.0, fx));
  const mortar = 1 - Math.min(mortarY, mortarX);

  const brickRand = hash01(col & 255, row & 255, 5);
  const brickRand2 = hash01(col & 255, row & 255, 19);
  const burn = fbm(u, v, 10, 3, 43);

  // Fired clay ranges from orange-red to dark brown; a few pale/grey bricks
  // break up the "wallpaper" read that a single repeated brick creates.
  let r = lerp(0.47, 0.58, brickRand);
  let g = lerp(0.26, 0.35, brickRand);
  let b = lerp(0.19, 0.24, brickRand);
  if (brickRand2 > 0.86) {
    r = 0.55;
    g = 0.5;
    b = 0.45;
  } else if (brickRand2 < 0.12) {
    r = 0.36;
    g = 0.19;
    b = 0.15;
  }
  const burnTint = 0.9 + burn * 0.2;
  r *= burnTint;
  g *= burnTint;
  b *= burnTint;

  const faceGrain = (fbm(u, v, 64, 2, 61) - 0.5) * 0.06;
  const mortarShade = 0.62 + (fbm(u, v, 40, 2, 83) - 0.5) * 0.12;
  const t = mortar;
  const outR = lerp(r + faceGrain, 0.66 * mortarShade, t);
  const outG = lerp(g + faceGrain, 0.63 * mortarShade, t);
  const outB = lerp(b + faceGrain, 0.6 * mortarShade, t);

  const chip = smoothstep(0.55, 0.92, fbm(u, v, 48, 2, 7)) * (1 - t) * 0.06;
  return {
    r: clamp01(outR + chip * 0.4),
    g: clamp01(outG + chip * 0.3),
    b: clamp01(outB + chip * 0.25),
    h: clamp01(0.72 - mortar * 0.42 + (fbm(u, v, 80, 2, 29) - 0.5) * 0.08),
    rough: clamp01(lerp(0.78 + (brickRand - 0.5) * 0.1, 0.95, t)),
  };
};

/** Coursed ashlar sandstone blocks with chiselled faces and recessed joints. */
const ashlarSampler: SurfaceSampler = (u, v) => {
  const courses = 7;
  const cy = v * courses;
  const row = Math.floor(cy);
  const fy = cy - row;
  const perRow = 4 + (row % 2);
  const offset = (row % 2) * 0.4;
  const cx = u * perRow + offset;
  const col = Math.floor(cx);
  const fx = cx - col;

  const jointY = smoothstep(0.0, 0.045, fy) * (1 - smoothstep(0.955, 1.0, fy));
  const jointX = smoothstep(0.0, 0.028, fx) * (1 - smoothstep(0.972, 1.0, fx));
  const joint = 1 - Math.min(jointY, jointX);

  const tint = hash01(col & 127, row & 127, 3);
  const stone = fbm(u, v, 26, 4, 47);
  const chisel = fbm(u, v, 110, 2, 53);

  const baseR = lerp(0.56, 0.68, tint);
  const baseG = lerp(0.54, 0.65, tint);
  const baseB = lerp(0.49, 0.59, tint);
  const shade = 0.86 + stone * 0.22 + (chisel - 0.5) * 0.08;
  const jointColor = 0.36 + (stone - 0.5) * 0.1;
  const t = joint;
  return {
    r: clamp01(lerp(baseR * shade, jointColor, t)),
    g: clamp01(lerp(baseG * shade, jointColor * 0.98, t)),
    b: clamp01(lerp(baseB * shade, jointColor * 0.94, t)),
    h: clamp01(0.75 - t * 0.5 + (chisel - 0.5) * 0.1),
    rough: clamp01(lerp(0.74 + (tint - 0.5) * 0.1, 0.95, t)),
  };
};

/** Barrel clay roof tiles: half-round ribs, stepped courses, moss in the joints. */
const roofTileSampler: SurfaceSampler = (u, v) => {
  const rows = 6;
  const tilesPerRow = 9;
  const cy = v * rows;
  const row = Math.floor(cy);
  const fy = cy - row;
  // Overlapping course: the bottom 12% of each course is a shadowed overlap.
  const overlap = 1 - smoothstep(0.0, 0.12, fy);
  const tileX = u * tilesPerRow + (row % 2) * 0.5;
  const col = Math.floor(tileX);
  const fx = tileX - col;

  const rib = Math.sin(fx * Math.PI) ** 0.65;
  const tint = hash01(col & 127, row & 127, 13);
  const weather = fbm(u, v, 14, 3, 67);

  const baseR = lerp(0.42, 0.56, tint);
  const baseG = lerp(0.21, 0.3, tint);
  const baseB = lerp(0.16, 0.21, tint);
  const shade = (0.72 + rib * 0.4) * (1 - overlap * 0.38) * (0.88 + weather * 0.24);
  const moss = smoothstep(0.7, 1.0, fbm(u, v, 9, 2, 31)) * 0.16;
  return {
    r: clamp01(baseR * shade + moss * 0.06),
    g: clamp01(baseG * shade + moss * 0.13),
    b: clamp01(baseB * shade + moss * 0.05),
    h: clamp01(0.45 + rib * 0.34 - overlap * 0.25 + (weather - 0.5) * 0.06),
    rough: clamp01(0.8 + (1 - rib) * 0.12),
  };
};

/** Vertically boarded timber (grain, plank gaps, knots, weathered end grain). */
const timberSampler: SurfaceSampler = (u, v) => {
  const planks = 6;
  const px = u * planks;
  const plank = Math.floor(px);
  const fx = px - plank;
  const gap = 1 - smoothstep(0.0, 0.012, fx) + smoothstep(0.988, 1.0, fx);
  const grain = fbm(u * 0.35, v * 5.5, 12, 4, 89);
  const rings = Math.sin((v * 26 + fbm(u, v, 6, 3, 5) * 7) * Math.PI) * 0.5 + 0.5;
  const tint = hash01(plank & 63, 0, 17);
  const knot = smoothstep(0.86, 0.99, fbm(u, v, 18, 2, 23)) * smoothstep(0.3, 0.7, rings);

  const base = lerp(0.42, 0.55, tint);
  const lum = base * (0.82 + grain * 0.3 + rings * 0.08) * (1 - gap * 0.5) * (1 - knot * 0.35);
  return {
    r: clamp01(lum * 1.16),
    g: clamp01(lum * 0.78),
    b: clamp01(lum * 0.5),
    h: clamp01(0.62 + rings * 0.1 - gap * 0.35 + (grain - 0.5) * 0.08),
    rough: clamp01(0.82 + (grain - 0.5) * 0.1),
  };
};

/** Painted joinery: a soft satin finish with faint brush texture and wear. */
const paintedTrimSampler: SurfaceSampler = (u, v) => {
  const brush = fbm(u, v, 70, 3, 41);
  const wear = smoothstep(0.78, 1.0, fbm(u, v, 16, 3, 59));
  const lum = 0.86 + (brush - 0.5) * 0.045 - wear * 0.05;
  return {
    r: clamp01(lum),
    g: clamp01(lum * 0.995),
    b: clamp01(lum * 0.985),
    h: clamp01(0.55 + (brush - 0.5) * 0.14),
    rough: clamp01(0.42 + (brush - 0.5) * 0.14 + wear * 0.16),
  };
};

/** Galvanised architectural metal: brushed streaks, mill scale, edge grime. */
const metalSampler: SurfaceSampler = (u, v) => {
  const streak = fbm(u * 5.0, v * 0.7, 30, 3, 73);
  const scratch = smoothstep(0.75, 0.97, fbm(u * 9.0, v * 0.25, 40, 2, 79));
  const grime = fbm(u, v, 8, 3, 91);
  const lum = 0.55 + (streak - 0.5) * 0.18 + (grime - 0.5) * 0.1;
  return {
    r: clamp01(lum * 0.98),
    g: clamp01(lum),
    b: clamp01(lum * 1.02),
    h: clamp01(0.5 + (streak - 0.5) * 0.18 + scratch * 0.06),
    rough: clamp01(0.32 + (streak - 0.5) * 0.16 - scratch * 0.1),
  };
};

/** Board-formed concrete: panel seams, tie holes, damp streaks, aggregate. */
const concreteSampler: SurfaceSampler = (u, v) => {
  const boardLines = Math.abs(((v * 8) % 1) - 0.5);
  const seam = 1 - smoothstep(0.44, 0.5, boardLines);
  const tieX = Math.abs(((u * 4) % 1) - 0.5);
  const tieY = Math.abs(((v * 4) % 1) - 0.5);
  const tie = 1 - smoothstep(0.02, 0.05, Math.hypot(tieX, tieY));
  const aggregate = fbm(u, v, 60, 3, 101);
  const stain = fbm(u, v, 6, 3, 113);
  const lum = 0.56 + (aggregate - 0.5) * 0.12 - seam * 0.05 - tie * 0.16 - stain * 0.07;
  return {
    r: clamp01(lum * 1.0),
    g: clamp01(lum * 0.995),
    b: clamp01(lum * 0.97),
    h: clamp01(0.6 - seam * 0.12 - tie * 0.2 + (aggregate - 0.5) * 0.18),
    rough: clamp01(0.78 + (aggregate - 0.5) * 0.12),
  };
};

/* ------------------------------------------------------------------ */
/* Texture construction                                                */
/* ------------------------------------------------------------------ */

function dataTexture(
  data: Uint8Array,
  size: number,
  colorSpace: THREE.ColorSpace
): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = colorSpace;
  tex.needsUpdate = true;
  return tex;
}

function buildSurfaceMaps(definition: SurfaceDefinition): SurfaceMapSet {
  const { size, sampler } = definition;
  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const roughness = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      // Three's DataTexture origin is bottom-left; flip V so authored detail
      // (brick courses, roof rows) reads the right way up on world geometry.
      const v = 1 - (y + 0.5) / size;
      const s = sampler(u, v);
      const i = (y * size + x) * 4;
      albedo[i] = Math.round(clamp01(s.r) * 255);
      albedo[i + 1] = Math.round(clamp01(s.g) * 255);
      albedo[i + 2] = Math.round(clamp01(s.b) * 255);
      albedo[i + 3] = 255;
      roughness[i] = Math.round(clamp01(s.rough) * 255);
      roughness[i + 1] = Math.round(clamp01(s.rough) * 255);
      roughness[i + 2] = Math.round(clamp01(s.rough) * 255);
      roughness[i + 3] = 255;
      heights[y * size + x] = clamp01(s.h);
    }
  }

  const strength = definition.normalStrength ?? 1;
  const height = (x: number, y: number): number =>
    heights[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (height(x + 1, y) - height(x - 1, y)) * 2.4 * strength;
      const dy = (height(x, y + 1) - height(x, y - 1)) * 2.4 * strength;
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      const i = (y * size + x) * 4;
      normal[i] = Math.round(clamp01(nx / len * 0.5 + 0.5) * 255);
      normal[i + 1] = Math.round(clamp01(ny / len * 0.5 + 0.5) * 255);
      normal[i + 2] = Math.round(clamp01(nz / len * 0.5 + 0.5) * 255);
      normal[i + 3] = 255;
    }
  }

  return {
    albedo: dataTexture(albedo, size, THREE.SRGBColorSpace),
    normal: dataTexture(normal, size, THREE.NoColorSpace),
    roughness: dataTexture(roughness, size, THREE.NoColorSpace),
    metresPerTile: definition.metresPerTile,
  };
}

/* ------------------------------------------------------------------ */
/* World-space UV projection                                           */
/* ------------------------------------------------------------------ */

interface UvOptions {
  metresPerTile: number;
  /** Rotate the projection on vertical faces (radians). */
  rotation?: number;
  /** Extra per-axis offset used to decorrelate neighbouring buildings. */
  offset?: THREE.Vector2;
}

/**
 * Replaces the UV varyings used by map/normalMap/roughnessMap with a
 * dominant-axis planar projection of the *world* position. The texture tile is
 * therefore `metresPerTile` metres wide on every wall, roof and prop,
 * independent of the unit primitive's instance scale.
 *
 * The injection is deliberately additive: it only rewrites the
 * `#include <project_vertex>` chunk and leaves every other lighting chunk intact,
 * so it composes with the existing surface shader (which injects at
 * `map_fragment`) and with Three's instancing/color pipelines.
 */
export function applyWorldSpaceUv<T extends THREE.MeshStandardMaterial>(
  material: T,
  options: UvOptions
): T {
  const metres = Math.max(0.05, options.metresPerTile);
  const appliedUv = material.userData.cicraftWorldUv as UvOptions | undefined;
  if (appliedUv && Math.max(0.05, appliedUv.metresPerTile) === metres) {
    return material;
  }
  material.userData.cicraftWorldUv = options;
  const maps = [material.map, material.normalMap, material.roughnessMap, material.bumpMap];
  for (const texture of maps) {
    if (!texture) continue;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1, 1);
    texture.offset.set(0, 0);
  }

  const flags = {
    map: Boolean(material.map),
    normal: Boolean(material.normalMap),
    roughness: Boolean(material.roughnessMap),
    bump: Boolean(material.bumpMap),
  };

  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  const cacheKey = `cicraft-world-uv-${metres}-${options.rotation ?? 0}-${Number(
    options.offset?.x ?? 0
  )}-${Number(options.offset?.y ?? 0)}-${flags.map ? 1 : 0}${flags.normal ? 1 : 0}${
    flags.roughness ? 1 : 0
  }${flags.bump ? 1 : 0}`;

  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);

    const assignments: string[] = [];
    if (flags.map) assignments.push('vMapUv = cicraftUv;');
    if (flags.normal) assignments.push('vNormalMapUv = cicraftUv;');
    if (flags.roughness) assignments.push('vRoughnessMapUv = cicraftUv;');
    if (flags.bump) assignments.push('vBumpMapUv = cicraftUv;');

    shader.uniforms.uCicraftUvScale = { value: 1 / metres };
    shader.uniforms.uCicraftUvRotation = { value: options.rotation ?? 0 };
    shader.uniforms.uCicraftUvOffset = {
      value: options.offset ?? new THREE.Vector2(0, 0),
    };

    shader.vertexShader = `uniform float uCicraftUvScale;
uniform float uCicraftUvRotation;
uniform vec2 uCicraftUvOffset;
${shader.vertexShader}`;

    // Injection point matters: `#include <uv_vertex>` is the FIRST statement of
    // main() in the standard vertex shader, so `transformed` and `objectNormal`
    // do not exist yet and the block below would fail to compile. It must run
    // after <project_vertex>, by which point `begin_vertex`, `beginnormal_vertex`
    // and `defaultnormal_vertex` have all populated the symbols we read.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      {
        vec4 cicraftUvPos = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cicraftUvPos = instanceMatrix * cicraftUvPos;
        #endif
        cicraftUvPos = modelMatrix * cicraftUvPos;

        vec3 cicraftUvNormal = objectNormal;
        #ifdef USE_INSTANCING
          cicraftUvNormal = mat3(instanceMatrix) * cicraftUvNormal;
        #endif
        cicraftUvNormal = mat3(modelMatrix) * cicraftUvNormal;
        cicraftUvNormal = normalize(cicraftUvNormal);
        vec3 cicraftAbsNormal = abs(cicraftUvNormal);
        vec2 cicraftUv = cicraftUvPos.xz;
        if (cicraftAbsNormal.x > cicraftAbsNormal.z && cicraftAbsNormal.x >= cicraftAbsNormal.y) {
          cicraftUv = cicraftUvPos.zy;
        } else if (cicraftAbsNormal.z >= cicraftAbsNormal.x && cicraftAbsNormal.z >= cicraftAbsNormal.y) {
          cicraftUv = cicraftUvPos.xy;
        }
        float cicraftCos = cos(uCicraftUvRotation);
        float cicraftSin = sin(uCicraftUvRotation);
        cicraftUv = vec2(
          cicraftUv.x * cicraftCos - cicraftUv.y * cicraftSin,
          cicraftUv.x * cicraftSin + cicraftUv.y * cicraftCos
        );
        cicraftUv = cicraftUv * uCicraftUvScale + uCicraftUvOffset;
        ${assignments.join('\n        ')}
      }`
    );
  };

  // Chained cache keys must never throw: some materials arrive here before a
  // previous injector has attached onBeforeCompile (Three's default key reads
  // this.onBeforeCompile, which is undefined on a pristine material).
  material.customProgramCacheKey = () => {
    let base = 'standard';
    if (typeof previousKey === 'function') {
      try {
        base = previousKey.call(material) ?? 'standard';
      } catch {
        base = 'standard';
      }
    }
    return `${base}|${cacheKey}`;
  };
  return material;
}

/* ------------------------------------------------------------------ */
/* Public material library                                             */
/* ------------------------------------------------------------------ */

export type ArchitecturalSurface =
  | 'plaster'
  | 'brick'
  | 'ashlar'
  | 'roofTile'
  | 'timber'
  | 'trim'
  | 'metal'
  | 'concrete';

export interface ArchitecturalMaterialLibrary {
  surfaces: Record<ArchitecturalSurface, SurfaceMapSet>;
  /** Vertex-coloured materials for merged geometry (kit parts). */
  merged: Record<ArchitecturalSurface | 'glass' | 'glow' | 'dark', THREE.MeshStandardMaterial>;
  /** Instance-coloured materials for the instanced unit-box architecture. */
  instanced: {
    wall: THREE.MeshStandardMaterial;
    metal: THREE.MeshStandardMaterial;
    paint: THREE.MeshStandardMaterial;
    glass: THREE.MeshStandardMaterial;
  };
  /** Shared detail materials that do not need surface maps. */
  glassGlass: THREE.MeshStandardMaterial;
  emissive: THREE.MeshBasicMaterial;
  dispose(): void;
}

const SURFACE_DEFINITIONS: Record<ArchitecturalSurface, SurfaceDefinition> = {
  plaster: { metresPerTile: 2.2, size: 512, sampler: plasterSampler, normalStrength: 0.75 },
  brick: { metresPerTile: 2.0, size: 512, sampler: brickSampler, normalStrength: 1.15 },
  ashlar: { metresPerTile: 2.6, size: 512, sampler: ashlarSampler, normalStrength: 1.25 },
  roofTile: { metresPerTile: 1.8, size: 512, sampler: roofTileSampler, normalStrength: 1.35 },
  timber: { metresPerTile: 1.9, size: 512, sampler: timberSampler, normalStrength: 0.9 },
  trim: { metresPerTile: 1.4, size: 256, sampler: paintedTrimSampler, normalStrength: 0.5 },
  metal: { metresPerTile: 1.6, size: 256, sampler: metalSampler, normalStrength: 0.6 },
  concrete: { metresPerTile: 3.0, size: 512, sampler: concreteSampler, normalStrength: 0.85 },
};

function createMergedSurfaceMaterial(
  set: SurfaceMapSet,
  options: {
    color?: number;
    roughness?: number;
    metalness?: number;
    normalScale?: number;
    envMapIntensity?: number;
  } = {}
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: options.color ?? 0xffffff,
    map: set.albedo,
    normalMap: set.normal,
    normalScale: new THREE.Vector2(options.normalScale ?? 1, options.normalScale ?? 1),
    roughnessMap: set.roughness,
    roughness: options.roughness ?? 1,
    metalness: options.metalness ?? 0.03,
    envMapIntensity: options.envMapIntensity ?? 0.85,
    vertexColors: true,
    flatShading: false,
  });
  return applyWorldSpaceUv(material, { metresPerTile: set.metresPerTile });
}

/**
 * Builds (once) the shared material library used by the modular building kit
 * and by the instanced district architecture. Texture generation is ~17 MB of
 * pixels at 512 px, so callers must create this exactly once per world.
 */
export function createArchitecturalMaterials(): ArchitecturalMaterialLibrary {
  const surfaces = {} as Record<ArchitecturalSurface, SurfaceMapSet>;
  for (const key of Object.keys(SURFACE_DEFINITIONS) as ArchitecturalSurface[]) {
    surfaces[key] = buildSurfaceMaps(SURFACE_DEFINITIONS[key]);
  }

  const merged = {
    plaster: createMergedSurfaceMaterial(surfaces.plaster, { normalScale: 0.8 }),
    brick: createMergedSurfaceMaterial(surfaces.brick, { normalScale: 1.0, roughness: 1.0 }),
    ashlar: createMergedSurfaceMaterial(surfaces.ashlar, {
      normalScale: 1.0,
      roughness: 1.0,
    }),
    roofTile: createMergedSurfaceMaterial(surfaces.roofTile, {
      normalScale: 1.15,
      roughness: 1.0,
      envMapIntensity: 0.9,
    }),
    timber: createMergedSurfaceMaterial(surfaces.timber, {
      normalScale: 0.85,
      roughness: 1.0,
      metalness: 0.0,
    }),
    trim: createMergedSurfaceMaterial(surfaces.trim, {
      normalScale: 0.5,
      roughness: 1.0,
      metalness: 0.05,
    }),
    metal: createMergedSurfaceMaterial(surfaces.metal, {
      normalScale: 0.55,
      roughness: 1.0,
      metalness: 0.78,
      envMapIntensity: 1.35,
    }),
    concrete: createMergedSurfaceMaterial(surfaces.concrete, {
      normalScale: 0.7,
      roughness: 1.0,
      metalness: 0.02,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: 0xbfe3f5,
      emissive: 0x0b2a3a,
      emissiveIntensity: 0.35,
      metalness: 0.62,
      roughness: 0.06,
      envMapIntensity: 1.9,
      transparent: true,
      opacity: 0.62,
      side: THREE.DoubleSide,
      vertexColors: true,
      depthWrite: false,
    }),
    glow: new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }),
    dark: applyWorldSpaceUv(
      new THREE.MeshStandardMaterial({
        color: 0x14181e,
        map: surfaces.concrete.albedo,
        normalMap: surfaces.concrete.normal,
        normalScale: new THREE.Vector2(0.4, 0.4),
        roughness: 0.92,
        metalness: 0.02,
        vertexColors: true,
        envMapIntensity: 0.4,
      }),
      { metresPerTile: surfaces.concrete.metresPerTile }
    ),
  } satisfies Record<string, THREE.Material>;

  // Vertex colours are multiplied with the map; lift the base so a white
  // vertex colour renders the authored texture at its true value.
  for (const [key, material] of Object.entries(merged)) {
    if (key === 'glass' || key === 'glow' || key === 'dark') continue;
    (material as THREE.MeshStandardMaterial).color.setHex(0xffffff);
  }

  const instanced = {
    wall: applyWorldSpaceUv(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: surfaces.plaster.albedo,
        normalMap: surfaces.plaster.normal,
        normalScale: new THREE.Vector2(0.75, 0.75),
        roughnessMap: surfaces.plaster.roughness,
        roughness: 1,
        metalness: 0.03,
        envMapIntensity: 0.9,
        flatShading: false,
      }),
      { metresPerTile: surfaces.plaster.metresPerTile }
    ),
    metal: applyWorldSpaceUv(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: surfaces.metal.albedo,
        normalMap: surfaces.metal.normal,
        normalScale: new THREE.Vector2(0.5, 0.5),
        roughnessMap: surfaces.metal.roughness,
        roughness: 1,
        metalness: 0.82,
        envMapIntensity: 1.3,
        flatShading: false,
      }),
      { metresPerTile: surfaces.metal.metresPerTile }
    ),
    paint: applyWorldSpaceUv(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: surfaces.trim.albedo,
        normalMap: surfaces.trim.normal,
        normalScale: new THREE.Vector2(0.35, 0.35),
        roughnessMap: surfaces.trim.roughness,
        roughness: 1,
        metalness: 0.05,
        flatShading: false,
      }),
      { metresPerTile: surfaces.trim.metresPerTile }
    ),
    glass: new THREE.MeshStandardMaterial({
      color: 0xdff2ff,
      emissive: 0x0a2230,
      emissiveIntensity: 0.3,
      metalness: 0.6,
      roughness: 0.07,
      envMapIntensity: 1.85,
      transparent: true,
      opacity: 0.66,
      flatShading: false,
    }),
  };

  const glassGlass = merged.glass;
  const emissive = merged.glow;
  const surfaceList = Object.values(surfaces);
  const materialList = [...Object.values(merged), ...Object.values(instanced)];

  return {
    surfaces,
    merged: merged as unknown as ArchitecturalMaterialLibrary['merged'],
    instanced,
    glassGlass,
    emissive,
    dispose() {
      for (const set of surfaceList) {
        set.albedo.dispose();
        set.normal.dispose();
        set.roughness.dispose();
      }
      for (const material of materialList) material.dispose();
    },
  };
}

/** Attach crystal-sharp filtering on every library texture (called on quality change). */
export function setArchitecturalAnisotropy(
  library: ArchitecturalMaterialLibrary,
  anisotropy: number
): void {
  const clamped = Math.max(1, Math.min(16, Math.floor(anisotropy)));
  for (const set of Object.values(library.surfaces)) {
    set.albedo.anisotropy = clamped;
    set.normal.anisotropy = clamped;
    set.roughness.anisotropy = clamped;
    set.albedo.needsUpdate = true;
    set.normal.needsUpdate = true;
    set.roughness.needsUpdate = true;
  }
}

export { smoothstep as _smoothstep, lerp as _lerp };
