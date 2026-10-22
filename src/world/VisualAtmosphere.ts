import * as THREE from 'three';

export type AtmospherePreset = 'day' | 'sunset' | 'night';
export type GraphicsQualitySetting = 'auto' | 'low' | 'medium' | 'high' | 'ultra';
export type ResolvedGraphicsQuality = Exclude<GraphicsQualitySetting, 'auto'>;

export interface DeviceCapabilitySignals {
  coarsePointer: boolean;
  hardwareConcurrency?: number;
  deviceMemoryGb?: number;
  devicePixelRatio?: number;
  saveData?: boolean;
}

export interface SunVector {
  x: number;
  y: number;
  z: number;
}

export interface EnvironmentPreset {
  zenith: number;
  horizon: number;
  ground: number;
  sun: number;
  sunU: number;
  sunV: number;
  intensity: number;
  exposure: number;
}

/**
 * The sky is camera-centred, so these radii are view distances rather than
 * world-map distances. Every supported camera-far tier below remains safely
 * beyond the dome; the previous fixed 720 m dome was clipped by all tiers.
 */
export const SKY_DOME_RADIUS = 285;
export const STARFIELD_RADIUS = 272;
export const SUN_DISTANCE = 258;

const SUN_OFFSETS: Record<AtmospherePreset, SunVector> = {
  day: { x: 115, y: 165, z: 95 },
  sunset: { x: 150, y: 75, z: 110 },
  night: { x: -90, y: 150, z: -80 },
};

const ENVIRONMENT_PRESETS: Record<AtmospherePreset, EnvironmentPreset> = {
  day: {
    zenith: 0x4387a8,
    horizon: 0xcbdde5,
    ground: 0x626a4e,
    sun: 0xfff7cc,
    sunU: 0.68,
    sunV: 0.27,
    intensity: 0.42,
    exposure: 1.06,
  },
  sunset: {
    zenith: 0x312e81,
    horizon: 0xfb923c,
    ground: 0x451a03,
    sun: 0xffd9a0,
    sunU: 0.7,
    sunV: 0.42,
    intensity: 0.26,
    exposure: 1.04,
  },
  night: {
    zenith: 0x020617,
    horizon: 0x1e3a5f,
    ground: 0x020617,
    sun: 0xdbeafe,
    sunU: 0.3,
    sunV: 0.24,
    intensity: 0.13,
    exposure: 0.94,
  },
};

export function getSunOffset(preset: AtmospherePreset): SunVector {
  return { ...SUN_OFFSETS[preset] };
}

export function getSunDirection(preset: AtmospherePreset): SunVector {
  const offset = SUN_OFFSETS[preset];
  const length = Math.hypot(offset.x, offset.y, offset.z) || 1;
  return {
    x: offset.x / length,
    y: offset.y / length,
    z: offset.z / length,
  };
}

export function getEnvironmentPreset(preset: AtmospherePreset): EnvironmentPreset {
  const base = ENVIRONMENT_PRESETS[preset];
  const direction = getSunDirection(preset);
  // Match Three.js' equirectUv convention, converting texture V to the
  // top-origin canvas Y used by GameEngine's procedural environment map.
  // This keeps PMREM's bright source on the same side as the visible sun
  // and shadow-casting directional light for every preset.
  return {
    ...base,
    sunU: Math.atan2(direction.z, direction.x) / (Math.PI * 2) + 0.5,
    sunV:
      1 -
      (Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1)) / Math.PI + 0.5),
  };
}

export function getCameraFarForQuality(quality: ResolvedGraphicsQuality): number {
  switch (quality) {
    case 'low':
      return 360;
    case 'medium':
      return 480;
    case 'ultra':
      return 760;
    case 'high':
    default:
      return 620;
  }
}

/**
 * Conservative first-load quality selection. Explicit player choices always
 * win. Auto keeps desktops on High, targets Balanced on most phones, and
 * reserves Low for clearly constrained devices. Runtime frame-time scaling
 * in GameEngine remains the second line of defence.
 */
export function resolveGraphicsQuality(
  setting: GraphicsQualitySetting,
  signals: DeviceCapabilitySignals
): ResolvedGraphicsQuality {
  if (setting !== 'auto') return setting;

  const cores = signals.hardwareConcurrency;
  const memory = signals.deviceMemoryGb;

  if (
    signals.saveData ||
    (cores !== undefined && cores <= 3) ||
    (memory !== undefined && memory <= 2)
  ) {
    return 'low';
  }

  if (signals.coarsePointer) {
    if (
      (cores !== undefined && cores <= 4 && memory !== undefined && memory <= 3) ||
      (memory !== undefined && memory <= 3)
    ) {
      return 'low';
    }
    if (
      cores !== undefined &&
      cores >= 8 &&
      (memory === undefined || memory >= 6) &&
      (signals.devicePixelRatio === undefined || signals.devicePixelRatio <= 2.5)
    ) {
      return 'high';
    }
    return 'medium';
  }

  if ((cores !== undefined && cores <= 4) || (memory !== undefined && memory <= 3)) {
    return 'medium';
  }
  return 'high';
}

/**
 * Small deterministic multi-frequency variation used to break up large flat
 * terrain vertex-colour regions. It deliberately has no effect on terrain
 * height, collision, navigation, loot placement, or network state.
 */
export function getSurfaceVariation(x: number, z: number): number {
  const value =
    Math.sin(x * 0.043 + z * 0.021) * 0.52 +
    Math.sin(x * 0.127 - z * 0.089 + 1.7) * 0.31 +
    Math.sin((x + z) * 0.317 + 0.4) * 0.17;
  return THREE.MathUtils.clamp(value, -1, 1);
}

export const foliageWindUniforms = {
  uWindTime: { value: 0 },
  uWindGlobalStrength: { value: 1 },
};

export function setFoliageWindTime(timeSeconds: number): void {
  foliageWindUniforms.uWindTime.value = timeSeconds;
}

export function setFoliageWindStrength(strength: number): void {
  foliageWindUniforms.uWindGlobalStrength.value = THREE.MathUtils.clamp(
    strength,
    0,
    1
  );
}

export interface FoliageWindOptions {
  strength?: number;
  baseY?: number;
  height?: number;
}

/**
 * Adds a tiny vertex-shader sway to an existing instanced foliage material.
 * No instance matrices are rewritten on the CPU and no draw calls are added;
 * each instance derives its phase from its existing translation. Shadow
 * depth remains static, which is imperceptible at these restrained offsets.
 */
export function applyFoliageWind(
  material: THREE.MeshStandardMaterial,
  options: FoliageWindOptions = {}
): THREE.MeshStandardMaterial {
  const strength = options.strength ?? 0.055;
  const baseY = options.baseY ?? 0;
  const height = Math.max(0.05, options.height ?? 1);
  const cacheKey = `cicraft-foliage-wind-${strength}-${baseY}-${height}`;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = foliageWindUniforms.uWindTime;
    shader.uniforms.uWindGlobalStrength =
      foliageWindUniforms.uWindGlobalStrength;
    shader.uniforms.uWindStrength = { value: strength };
    shader.uniforms.uWindBaseY = { value: baseY };
    shader.uniforms.uWindHeight = { value: height };

    shader.vertexShader = `
uniform float uWindTime;
uniform float uWindGlobalStrength;
uniform float uWindStrength;
uniform float uWindBaseY;
uniform float uWindHeight;
${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        float cicraftWindHeight = clamp(
          (position.y - uWindBaseY) / max(uWindHeight, 0.001),
          0.0,
          1.0
        );
        vec2 cicraftWindAnchor = vec2(0.0);
        #ifdef USE_INSTANCING
          cicraftWindAnchor = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
        #endif
        float cicraftWindPhase =
          cicraftWindAnchor.x * 0.31 + cicraftWindAnchor.y * 0.23;
        float cicraftWindWave =
          sin(uWindTime * 1.75 + cicraftWindPhase) +
          0.35 * sin(uWindTime * 3.1 + cicraftWindPhase * 1.7);
        float cicraftWindAmount =
          cicraftWindWave *
          uWindStrength *
          uWindGlobalStrength *
          cicraftWindHeight *
          cicraftWindHeight;
        transformed.x += cicraftWindAmount;
        transformed.z += cicraftWindAmount * 0.42;
      }`
    );
  };
  material.customProgramCacheKey = () => cacheKey;
  return material;
}

/** Small deterministic, world-owned textures: no downloads or frame-time painting. */
export function createArchitectureTextures(): { roughness: THREE.DataTexture; contact: THREE.DataTexture } {
  const size = 32;
  const grain = new Uint8Array(size * size * 4);
  const shadow = new Uint8Array(size * size * 4);
  let seed = 734;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    grain[i] = grain[i + 1] = grain[i + 2] = 205 + (seed % 51);
    grain[i + 3] = 255;
    const radius = Math.hypot((x + .5) / size * 2 - 1, (y + .5) / size * 2 - 1);
    shadow[i] = shadow[i + 1] = shadow[i + 2] = 255;
    shadow[i + 3] = Math.round(Math.max(0, 1 - radius) ** 1.5 * 255);
  }
  const roughness = new THREE.DataTexture(grain,size,size);
  roughness.wrapS = roughness.wrapT = THREE.RepeatWrapping;
  roughness.repeat.set(6,6);
  roughness.magFilter = roughness.minFilter = THREE.LinearFilter;
  roughness.needsUpdate = true;
  const contact = new THREE.DataTexture(shadow,size,size);
  contact.magFilter = contact.minFilter = THREE.LinearFilter;
  contact.needsUpdate = true;
  return {roughness,contact};
}

export interface PbrSurfaceTextureSet {
  facadeAlbedo: THREE.DataTexture;
  facadeNormal: THREE.DataTexture;
  windowAlbedo: THREE.DataTexture;
  windowNormal: THREE.DataTexture;
  barkAlbedo: THREE.DataTexture;
  barkNormal: THREE.DataTexture;
  foliageAlbedo: THREE.DataTexture;
  foliageNormal: THREE.DataTexture;
  rockAlbedo: THREE.DataTexture;
  rockNormal: THREE.DataTexture;
  crateAlbedo: THREE.DataTexture;
  crateNormal: THREE.DataTexture;
  metalNormal: THREE.DataTexture;
}

function buildNormalTextureFromHeight(
  heightField: Float32Array,
  size: number,
  strength: number,
  repeatX = 4,
  repeatY = 4
): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const mask = size - 1;
  for (let y = 0; y < size; y++) {
    const yPrev = (y - 1) & mask;
    const yNext = (y + 1) & mask;
    for (let x = 0; x < size; x++) {
      const xPrev = (x - 1) & mask;
      const xNext = (x + 1) & mask;
      const dx = (heightField[y * size + xNext] - heightField[y * size + xPrev]) * strength;
      const dy = (heightField[yNext * size + x] - heightField[yPrev * size + x]) * strength;
      const invLen = 1 / Math.hypot(dx, dy, 1);
      const nx = -dx * invLen;
      const ny = -dy * invLen;
      const nz = invLen;
      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates deterministic, tileable PBR albedo + tangent-space normal maps
 * for architecture, glazing, tree bark, foliage canopies, boulders, and
 * wooden crates. Runs in <4 ms at startup in both browser and headless Node.
 */
export function createPbrSurfaceTextures(): PbrSurfaceTextureSet {
  const size = 64;
  let seed = 918273;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // 1. Facade Ashlar Travertine / Stucco Courses
  const facadeAlbedoData = new Uint8Array(size * size * 4);
  const facadeHeight = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / 8);
    const rowY = y % 8;
    const isHJoint = rowY === 0;
    const stagger = (row % 2) * 16;
    for (let x = 0; x < size; x++) {
      const colX = (x + stagger) % 32;
      const isVJoint = colX === 0;
      const blockHash = Math.sin(row * 19.3 + Math.floor((x + stagger) / 32) * 47.1) * 43758.5;
      const blockTone = (blockHash - Math.floor(blockHash) - 0.5) * 14;
      const micro = (rand() - 0.5) * 10;
      const mortarDip = isHJoint || isVJoint ? -0.45 : rowY === 1 || colX === 1 ? 0.12 : 0;
      const h = 0.5 + mortarDip + micro * 0.012;
      facadeHeight[y * size + x] = h;
      const lum = Math.max(
        175,
        Math.min(255, Math.round(238 + blockTone + micro + (isHJoint || isVJoint ? -28 : 4)))
      );
      const i = (y * size + x) * 4;
      facadeAlbedoData[i] = lum;
      facadeAlbedoData[i + 1] = Math.max(170, lum - 2);
      facadeAlbedoData[i + 2] = Math.max(165, lum - 5);
      facadeAlbedoData[i + 3] = 255;
    }
  }
  const facadeAlbedo = new THREE.DataTexture(facadeAlbedoData, size, size);
  facadeAlbedo.wrapS = facadeAlbedo.wrapT = THREE.RepeatWrapping;
  facadeAlbedo.repeat.set(4, 4);
  facadeAlbedo.colorSpace = THREE.SRGBColorSpace;
  facadeAlbedo.magFilter = facadeAlbedo.minFilter = THREE.LinearFilter;
  facadeAlbedo.needsUpdate = true;
  const facadeNormal = buildNormalTextureFromHeight(facadeHeight, size, 3.2, 4, 4);

  // 2. Architectural Multi-Pane Window Glazing & Mullions
  const windowAlbedoData = new Uint8Array(size * size * 4);
  const windowHeight = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const border = x < 4 || x >= size - 4 || y < 4 || y >= size - 4;
      const mullionV = Math.abs(x - size / 2) <= 1;
      const mullionH = Math.abs(y - Math.floor(size * 0.62)) <= 1;
      const frame = border || mullionV || mullionH;
      const diagSheen = Math.max(0, Math.sin(((x + y) / size) * Math.PI * 2.2)) * 28;
      const blindBand = y > size * 0.64 && y % 4 === 0 ? -14 : 0;
      windowHeight[y * size + x] = frame ? 0.9 : 0.2;
      const i = (y * size + x) * 4;
      if (frame) {
        windowAlbedoData[i] = 52;
        windowAlbedoData[i + 1] = 68;
        windowAlbedoData[i + 2] = 86;
      } else {
        windowAlbedoData[i] = Math.min(255, Math.round(168 + diagSheen + blindBand));
        windowAlbedoData[i + 1] = Math.min(255, Math.round(214 + diagSheen * 0.9 + blindBand));
        windowAlbedoData[i + 2] = Math.min(255, Math.round(244 + diagSheen * 0.6));
      }
      windowAlbedoData[i + 3] = 255;
    }
  }
  const windowAlbedo = new THREE.DataTexture(windowAlbedoData, size, size);
  windowAlbedo.wrapS = windowAlbedo.wrapT = THREE.RepeatWrapping;
  windowAlbedo.colorSpace = THREE.SRGBColorSpace;
  windowAlbedo.magFilter = windowAlbedo.minFilter = THREE.LinearFilter;
  windowAlbedo.needsUpdate = true;
  const windowNormal = buildNormalTextureFromHeight(windowHeight, size, 4.0, 1, 1);

  // 3. Tree Bark Ridges & Fissures
  const barkAlbedoData = new Uint8Array(size * size * 4);
  const barkHeight = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ridge =
        Math.sin((x / size) * Math.PI * 14 + Math.sin((y / size) * Math.PI * 4) * 1.4) * 0.5 +
        Math.cos((x / size) * Math.PI * 28 - (y / size) * Math.PI * 6) * 0.25 +
        (rand() - 0.5) * 0.2;
      barkHeight[y * size + x] = 0.5 + ridge * 0.45;
      const shade = Math.round(208 + ridge * 42);
      const i = (y * size + x) * 4;
      barkAlbedoData[i] = Math.max(135, Math.min(255, shade));
      barkAlbedoData[i + 1] = Math.max(125, Math.min(248, shade - 8));
      barkAlbedoData[i + 2] = Math.max(115, Math.min(240, shade - 16));
      barkAlbedoData[i + 3] = 255;
    }
  }
  const barkAlbedo = new THREE.DataTexture(barkAlbedoData, size, size);
  barkAlbedo.wrapS = barkAlbedo.wrapT = THREE.RepeatWrapping;
  barkAlbedo.repeat.set(2, 3);
  barkAlbedo.colorSpace = THREE.SRGBColorSpace;
  barkAlbedo.magFilter = barkAlbedo.minFilter = THREE.LinearFilter;
  barkAlbedo.needsUpdate = true;
  const barkNormal = buildNormalTextureFromHeight(barkHeight, size, 3.8, 2, 3);

  // 4. Botanical Leaf Cluster Albedo & Normal Relief
  const foliageAlbedoData = new Uint8Array(size * size * 4);
  const foliageHeight = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cellX = (x % 8) / 8 - 0.5;
      const cellY = (y % 8) / 8 - 0.5;
      const leafDome = Math.max(0, 1 - Math.hypot(cellX * 1.7, cellY * 1.35));
      const vein = Math.abs(cellX) < 0.08 ? 0.12 : 0;
      const noise = (rand() - 0.5) * 0.14;
      const h = leafDome * 0.75 + vein + noise;
      foliageHeight[y * size + x] = h;
      const lum = Math.max(165, Math.min(255, Math.round(196 + h * 58)));
      const i = (y * size + x) * 4;
      foliageAlbedoData[i] = Math.max(150, lum - 10);
      foliageAlbedoData[i + 1] = lum;
      foliageAlbedoData[i + 2] = Math.max(145, lum - 14);
      foliageAlbedoData[i + 3] = 255;
    }
  }
  const foliageAlbedo = new THREE.DataTexture(foliageAlbedoData, size, size);
  foliageAlbedo.wrapS = foliageAlbedo.wrapT = THREE.RepeatWrapping;
  foliageAlbedo.repeat.set(3, 3);
  foliageAlbedo.colorSpace = THREE.SRGBColorSpace;
  foliageAlbedo.magFilter = foliageAlbedo.minFilter = THREE.LinearFilter;
  foliageAlbedo.needsUpdate = true;
  const foliageNormal = buildNormalTextureFromHeight(foliageHeight, size, 3.4, 3, 3);

  // 5. Stratified Boulder / Cliff Rock Albedo & Normal Map
  const rockAlbedoData = new Uint8Array(size * size * 4);
  const rockHeight = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const strata =
        Math.sin((y / size) * Math.PI * 10 + Math.sin((x / size) * Math.PI * 6) * 0.9) * 0.38 +
        Math.cos(((x + y) / size) * Math.PI * 16) * 0.22 +
        (rand() - 0.5) * 0.24;
      rockHeight[y * size + x] = 0.5 + strata;
      const lum = Math.max(150, Math.min(255, Math.round(212 + strata * 46)));
      const i = (y * size + x) * 4;
      rockAlbedoData[i] = lum;
      rockAlbedoData[i + 1] = lum;
      rockAlbedoData[i + 2] = Math.min(255, lum + 4);
      rockAlbedoData[i + 3] = 255;
    }
  }
  const rockAlbedo = new THREE.DataTexture(rockAlbedoData, size, size);
  rockAlbedo.wrapS = rockAlbedo.wrapT = THREE.RepeatWrapping;
  rockAlbedo.repeat.set(3, 3);
  rockAlbedo.colorSpace = THREE.SRGBColorSpace;
  rockAlbedo.magFilter = rockAlbedo.minFilter = THREE.LinearFilter;
  rockAlbedo.needsUpdate = true;
  const rockNormal = buildNormalTextureFromHeight(rockHeight, size, 4.2, 3, 3);

  // 6. Framed Supply Crate Timber & Cross-Brace Map
  const crateAlbedoData = new Uint8Array(size * size * 4);
  const crateHeight = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const border = x < 7 || x >= size - 7 || y < 7 || y >= size - 7;
      const diag = Math.abs(x - y) < 5 || Math.abs(x - (size - 1 - y)) < 5;
      const plankSeam = y % 8 === 0;
      const bolt =
        (x === 3 || x === size - 4) && (y === 3 || y === size - 4);
      const frame = border || diag;
      const grain = (rand() - 0.5) * 14;
      crateHeight[y * size + x] = bolt ? 1.0 : frame ? 0.82 : plankSeam ? 0.15 : 0.45;
      const i = (y * size + x) * 4;
      if (bolt) {
        crateAlbedoData[i] = 90;
        crateAlbedoData[i + 1] = 100;
        crateAlbedoData[i + 2] = 115;
      } else if (frame) {
        crateAlbedoData[i] = Math.min(255, Math.round(182 + grain));
        crateAlbedoData[i + 1] = Math.min(255, Math.round(156 + grain));
        crateAlbedoData[i + 2] = Math.min(255, Math.round(126 + grain));
      } else {
        const drop = plankSeam ? -34 : 0;
        crateAlbedoData[i] = Math.min(255, Math.round(236 + grain + drop));
        crateAlbedoData[i + 1] = Math.min(255, Math.round(214 + grain + drop));
        crateAlbedoData[i + 2] = Math.min(255, Math.round(184 + grain + drop));
      }
      crateAlbedoData[i + 3] = 255;
    }
  }
  const crateAlbedo = new THREE.DataTexture(crateAlbedoData, size, size);
  crateAlbedo.wrapS = crateAlbedo.wrapT = THREE.RepeatWrapping;
  crateAlbedo.repeat.set(2, 2);
  crateAlbedo.colorSpace = THREE.SRGBColorSpace;
  crateAlbedo.magFilter = crateAlbedo.minFilter = THREE.LinearFilter;
  crateAlbedo.needsUpdate = true;
  const crateNormal = buildNormalTextureFromHeight(crateHeight, size, 4.0, 1, 1);

  // 7. Standing-Seam Ribbed Architectural Metal Normal Map
  const metalHeight = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rib = (x % 8 === 0 || x % 8 === 1) ? 0.85 : 0.3;
      const louver = (y % 6 === 0) ? -0.15 : 0;
      metalHeight[y * size + x] = rib + louver + (rand() - 0.5) * 0.05;
    }
  }
  const metalNormal = buildNormalTextureFromHeight(metalHeight, size, 3.6, 4, 4);

  return {
    facadeAlbedo,
    facadeNormal,
    windowAlbedo,
    windowNormal,
    barkAlbedo,
    barkNormal,
    foliageAlbedo,
    foliageNormal,
    rockAlbedo,
    rockNormal,
    crateAlbedo,
    crateNormal,
    metalNormal,
  };
}

/**
 * Welds duplicate vertices by position and computes smooth area-weighted vertex
 * normals so procedural polyhedra and compound organic meshes shade smoothly
 * instead of showing hard flat-polygon facets.
 */
export function weldAndSmoothGeometry(
  source: THREE.BufferGeometry,
  tolerance = 1e-3
): THREE.BufferGeometry {
  const posAttr = source.getAttribute('position');
  if (!posAttr) return source;
  const indexAttr = source.getIndex();
  const vertexCount = indexAttr ? indexAttr.count : posAttr.count;
  const invTol = 1 / tolerance;

  const uniquePositions: number[] = [];
  const uniqueColors: number[] = [];
  const uniqueUVs: number[] = [];
  const colorAttr = source.getAttribute('color');
  const uvAttr = source.getAttribute('uv');
  const remap = new Map<string, number>();
  const newIndices: number[] = [];

  for (let i = 0; i < vertexCount; i++) {
    const srcIdx = indexAttr ? indexAttr.getX(i) : i;
    const vx = posAttr.getX(srcIdx);
    const vy = posAttr.getY(srcIdx);
    const vz = posAttr.getZ(srcIdx);
    const key = `${Math.round(vx * invTol)}_${Math.round(vy * invTol)}_${Math.round(vz * invTol)}`;
    let dstIdx = remap.get(key);
    if (dstIdx === undefined) {
      dstIdx = uniquePositions.length / 3;
      remap.set(key, dstIdx);
      uniquePositions.push(vx, vy, vz);
      if (colorAttr) {
        uniqueColors.push(
          colorAttr.getX(srcIdx),
          colorAttr.getY(srcIdx),
          colorAttr.getZ(srcIdx)
        );
      }
      if (uvAttr) {
        uniqueUVs.push(uvAttr.getX(srcIdx), uvAttr.getY(srcIdx));
      }
    }
    newIndices.push(dstIdx);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(uniquePositions, 3));
  if (uniqueColors.length > 0) {
    out.setAttribute('color', new THREE.Float32BufferAttribute(uniqueColors, 3));
  }
  if (uniqueUVs.length > 0) {
    out.setAttribute('uv', new THREE.Float32BufferAttribute(uniqueUVs, 2));
  } else {
    // Generate spherical UVs so normal/albedo maps tile cleanly on organic rocks/foliage
    const genUVs = new Float32Array((uniquePositions.length / 3) * 2);
    for (let i = 0; i < uniquePositions.length / 3; i++) {
      const x = uniquePositions[i * 3];
      const y = uniquePositions[i * 3 + 1];
      const z = uniquePositions[i * 3 + 2];
      const len = Math.hypot(x, y, z) || 1;
      genUVs[i * 2] = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
      genUVs[i * 2 + 1] = Math.asin(THREE.MathUtils.clamp(y / len, -1, 1)) / Math.PI + 0.5;
    }
    out.setAttribute('uv', new THREE.BufferAttribute(genUVs, 2));
  }
  out.setIndex(newIndices);
  out.computeVertexNormals();
  return out;
}

/**
 * Injects world-space architectural surface detail (ashlar masonry courses,
 * foundation plinth grounding, cornice shadow bands, or multi-pane window
 * frames and interior depth) onto instanced unit-box building materials so
 * non-uniformly scaled walls and glazing never look stretched or flat.
 */
export function applyArchitectureSurfaceShader(
  material: THREE.MeshStandardMaterial,
  kind: 'facade' | 'glass' | 'metal'
): THREE.MeshStandardMaterial {
  const cacheKey = `cicraft-arch-surface-${kind}`;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `
varying vec3 vCicraftWorldPos;
varying vec3 vCicraftLocalPos;
varying vec3 vCicraftWorldNormal;
${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vCicraftLocalPos = position;
      vec4 cicraftWPos = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        cicraftWPos = instanceMatrix * cicraftWPos;
      #endif
      cicraftWPos = modelMatrix * cicraftWPos;
      vCicraftWorldPos = cicraftWPos.xyz;
      mat3 cicraftNMat = mat3(modelMatrix);
      #ifdef USE_INSTANCING
        cicraftNMat = cicraftNMat * mat3(instanceMatrix);
      #endif
      vCicraftWorldNormal = normalize(cicraftNMat * objectNormal);`
    );

    if (kind === 'facade') {
      shader.fragmentShader = `
varying vec3 vCicraftWorldPos;
varying vec3 vCicraftLocalPos;
varying vec3 vCicraftWorldNormal;
${shader.fragmentShader}`.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          float courseY = fract(vCicraftWorldPos.y * 1.45);
          float mortarH = smoothstep(0.0, 0.06, courseY) * (1.0 - smoothstep(0.94, 1.0, courseY));
          float rowId = floor(vCicraftWorldPos.y * 1.45);
          float horizCoord = abs(vCicraftWorldNormal.x) > 0.5 ? vCicraftWorldPos.z : vCicraftWorldPos.x;
          float jointX = fract(horizCoord * 0.65 + mod(rowId, 2.0) * 0.5);
          float mortarV = smoothstep(0.0, 0.045, jointX) * (1.0 - smoothstep(0.955, 1.0, jointX));
          float wallFactor = 1.0 - smoothstep(0.55, 0.85, abs(vCicraftWorldNormal.y));
          float mortarMask = mix(1.0, 0.89 + 0.11 * (mortarH * mortarV), wallFactor);
          float edgeTrim = smoothstep(0.44, 0.5, max(abs(vCicraftLocalPos.x), abs(vCicraftLocalPos.z)));
          float topCornice = smoothstep(0.36, 0.5, vCicraftLocalPos.y) * wallFactor;
          float basePlinth = (1.0 - smoothstep(-0.5, -0.22, vCicraftLocalPos.y)) * wallFactor;
          diffuseColor.rgb *= mortarMask;
          diffuseColor.rgb *= (1.0 - basePlinth * 0.14 - topCornice * 0.08 + edgeTrim * 0.04);
        }`
      );
    } else if (kind === 'glass') {
      shader.fragmentShader = `
varying vec3 vCicraftWorldPos;
varying vec3 vCicraftLocalPos;
varying vec3 vCicraftWorldNormal;
${shader.fragmentShader}`.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec2 paneUv = vCicraftLocalPos.xy + 0.5;
          if (abs(vCicraftWorldNormal.x) > 0.5) {
            paneUv = vCicraftLocalPos.zy + 0.5;
          }
          float border = min(min(paneUv.x, 1.0 - paneUv.x), min(paneUv.y, 1.0 - paneUv.y));
          float outerFrame = 1.0 - smoothstep(0.045, 0.075, border);
          float mullionV = 1.0 - smoothstep(0.016, 0.032, abs(paneUv.x - 0.5));
          float mullionH = 1.0 - smoothstep(0.018, 0.035, abs(paneUv.y - 0.62));
          float sashMask = clamp(outerFrame + (mullionV + mullionH) * 0.85, 0.0, 1.0);
          float skyGrad = smoothstep(0.0, 1.0, paneUv.y);
          float diagReflect = pow(max(0.0, sin((paneUv.x + paneUv.y * 1.15) * 6.2831)), 3.0) * 0.22;
          vec3 glassTint = diffuseColor.rgb * (0.78 + 0.34 * skyGrad) + vec3(diagReflect);
          vec3 frameColor = vec3(0.16, 0.21, 0.28);
          diffuseColor.rgb = mix(glassTint, frameColor, sashMask);
        }`
      );
    } else {
      shader.fragmentShader = `
varying vec3 vCicraftWorldPos;
varying vec3 vCicraftLocalPos;
varying vec3 vCicraftWorldNormal;
${shader.fragmentShader}`.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          float seam = sin((vCicraftWorldPos.x + vCicraftWorldPos.z) * 14.0) * 0.06;
          diffuseColor.rgb *= (0.96 + seam);
        }`
      );
    }
  };
  material.customProgramCacheKey = () => cacheKey;
  return material;
}

export function mergeBufferGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  for (const geo of geometries) {
    const pos = geo.getAttribute('position');
    if (!pos) continue;
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const norm = geo.getAttribute('normal');
    const uv = geo.getAttribute('uv');
    const idx = geo.getIndex();

    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (norm) {
        normals.push(norm.getX(i), norm.getY(i), norm.getZ(i));
      } else {
        normals.push(0, 1, 0);
      }
      if (uv) {
        uvs.push(uv.getX(i), uv.getY(i));
      } else {
        uvs.push(0.5, 0.5);
      }
    }

    if (idx) {
      for (let i = 0; i < idx.count; i++) {
        indices.push(vertexOffset + idx.getX(i));
      }
    } else {
      for (let i = 0; i < pos.count; i++) {
        indices.push(vertexOffset + i);
      }
    }
    vertexOffset += pos.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  merged.setIndex(indices);
  return merged;
}

/**
 * Sculpted tree trunk with flared buttress roots, organic S-curve taper,
 * and 3 forked upper branches reaching into the canopy (~72 triangles).
 */
export function createBotanicalTreeTrunkGeometry(): THREE.BufferGeometry {
  const radial = 8;
  const heightSegs = 3;
  const trunk = new THREE.CylinderGeometry(0.24, 0.54, 1.0, radial, heightSegs, false);
  const pos = trunk.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const h01 = y + 0.5;
    const angle = Math.atan2(z, x);
    const rootFlare =
      h01 < 0.28 ? (1 - h01 / 0.28) ** 2 * (0.22 + 0.14 * Math.cos(angle * 4)) : 0;
    const bendX = Math.sin(h01 * Math.PI) * 0.045;
    const bendZ = Math.cos(h01 * Math.PI * 0.8) * 0.03;
    const scaleR = 1 + rootFlare;
    pos.setXYZ(i, x * scaleR + bendX, y, z * scaleR + bendZ);
  }
  return weldAndSmoothGeometry(trunk, 1e-3);
}

/**
 * Multi-cluster billowing broadleaf canopy with welded smooth vertex normals
 * (~60 triangles per crown cluster) replacing flat-faceted DodecahedronGeometry.
 */
export function createBotanicalCrownGeometry(): THREE.BufferGeometry {
  const lobes: Array<[number, number, number, number, number, number]> = [
    [0, 0.16, 0, 0.96, 0.82, 0.96],
    [-0.46, -0.08, 0.34, 0.7, 0.6, 0.7],
    [0.46, -0.06, -0.26, 0.68, 0.58, 0.68],
  ];
  const parts: THREE.BufferGeometry[] = [];
  for (const [lx, ly, lz, sx, sy, sz] of lobes) {
    const raw = new THREE.IcosahedronGeometry(1.0, 0);
    const welded = weldAndSmoothGeometry(raw);
    const pos = welded.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      const puff = 1 + 0.08 * Math.sin(vx * 4.1 + vz * 3.7) + (vy > 0 ? 0.06 : -0.05);
      pos.setXYZ(i, vx * sx * puff + lx, vy * sy * puff + ly, vz * sz * puff + lz);
    }
    welded.computeVertexNormals();
    parts.push(welded);
  }
  return mergeBufferGeometries(parts);
}

/**
 * Scalloped 10-sided conifer bough skirt with drooped branch tips and smooth
 * vertex normals (~30 triangles per tier) replacing plain 6-sided cones.
 */
export function createScallopedPineTierGeometry(): THREE.BufferGeometry {
  const radial = 8;
  const cone = new THREE.ConeGeometry(1.0, 1.0, radial, 2, false);
  const pos = cone.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r > 0.05) {
      const angle = Math.atan2(z, x);
      const boughWave = Math.cos(angle * 5) * 0.14;
      const skirtFactor = Math.max(0, (0.35 - y) / 0.85);
      const flare = 1 + skirtFactor * (0.14 + boughWave);
      const droopY = -skirtFactor * (0.08 + Math.max(0, boughWave) * 0.45);
      pos.setXYZ(i, x * flare, y + droopY, z * flare);
    }
  }
  return weldAndSmoothGeometry(cone, 1e-3);
}

/**
 * Curved parabolic feather-leaf palm frond with V-angled leaflet planes
 * (~24 triangles per frond) replacing flat BoxGeometry(0.48, 0.12, 2.2).
 */
export function createArchedPalmFrondGeometry(): THREE.BufferGeometry {
  const segments = 5;
  const length = 2.45;
  const maxHalfWidth = 0.46;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    const z = (t - 0.38) * length;
    const archY = Math.sin(t * Math.PI * 0.88) * 0.34 - t * t * 0.58;
    const widthProfile = Math.sin(Math.pow(t, 0.65) * Math.PI) * maxHalfWidth + 0.04 * (1 - t);
    const serration = s % 2 === 1 ? 1.08 : 0.92;
    const w = widthProfile * serration;
    const leafletDroop = w * 0.28;

    positions.push(-w, archY - leafletDroop, z);
    uvs.push(0, t);

    positions.push(0, archY + 0.045, z);
    uvs.push(0.5, t);

    positions.push(w, archY - leafletDroop, z);
    uvs.push(1, t);
  }

  for (let s = 0; s < segments; s++) {
    const row = s * 3;
    const next = (s + 1) * 3;
    indices.push(row, row + 1, next + 1);
    indices.push(row, next + 1, next);
    indices.push(row + 1, row + 2, next + 2);
    indices.push(row + 1, next + 2, next + 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Sculpted coastal/highland boulder with welded smooth normals and stratified
 * geological ledges (~80 triangles) replacing flat DodecahedronGeometry(1, 0).
 */
export function createSculptedBoulderGeometry(): THREE.BufferGeometry {
  // A single 20-face icosahedron welded to smooth normals plus the layered
  // strata deformation reads as a weathered boulder; the fine surface relief
  // comes from the shared rock normal map instead of extra vertices.
  const base = weldAndSmoothGeometry(new THREE.IcosahedronGeometry(1.0, 0), 1e-3);
  const pos = base.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const strata =
      1 +
      0.14 * Math.sin(vy * 4.6 + vx * 2.3) +
      0.1 * Math.cos(vx * 3.4 - vz * 2.9) -
      0.08 * Math.sin(vz * 5.1);
    const scaledY = vy * 0.86 * strata;
    // Boulders sit in the ground: clamp the underside to a flat base so no
    // stone floats above the terrain or sinks a full metre into it.
    const flatBaseY = Math.max(-0.42, scaledY);
    pos.setXYZ(i, vx * 1.08 * strata, flatBaseY, vz * 0.98 * strata);
  }
  base.computeVertexNormals();
  return base;
}

/**
 * Compound wooden supply crate with recessed plank core and raised perimeter
 * timber framing (~60 triangles) replacing a flat BoxGeometry cube.
 */
export function createFramedSupplyCrateGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const core = new THREE.BoxGeometry(1.18, 1.18, 1.18);
  parts.push(core);

  for (const sx of [-0.58, 0.58]) {
    for (const sz of [-0.58, 0.58]) {
      const post = new THREE.BoxGeometry(0.14, 1.3, 0.14);
      post.translate(sx, 0, sz);
      parts.push(post);
    }
  }
  for (const sy of [-0.58, 0.58]) {
    const topCap = new THREE.BoxGeometry(1.3, 0.14, 1.3);
    topCap.translate(0, sy, 0);
    parts.push(topCap);
  }
  return mergeBufferGeometries(parts);
}

/**
 * Multi-blade fanned botanical grass tuft (~6 triangles) replacing the
 * 4-sided pyramid ConeGeometry(0.24, 0.78, 4).
 */
export function createCrossedGrassTuftGeometry(width = 0.34, height = 0.78): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let b = 0; b < 3; b++) {
    const angle = (b / 3) * Math.PI + 0.25;
    const tilt = (b - 1) * 0.14;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const hw = width * 0.5;
    const tipOffsetX = -sin * tilt * height;
    const tipOffsetZ = cos * tilt * height;
    const nx = -sin;
    const nz = cos;

    const base = b * 3;
    positions.push(-cos * hw, 0, -sin * hw);
    positions.push(cos * hw, 0, sin * hw);
    positions.push(tipOffsetX, height, tipOffsetZ);

    normals.push(nx * 0.4, 0.9, nz * 0.4);
    normals.push(nx * 0.4, 0.9, nz * 0.4);
    normals.push(0, 1, 0);

    uvs.push(0, 0, 1, 0, 0.5, 1);
    indices.push(base, base + 1, base + 2);
    indices.push(base + 1, base, base + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/**
 * Smooth welded botanical shrub cluster (~40 triangles) replacing flat-shaded
 * DodecahedronGeometry bushes.
 */
export function createBotanicalShrubGeometry(radius = 0.64): THREE.BufferGeometry {
  const raw = new THREE.IcosahedronGeometry(radius, 0);
  const shrub = weldAndSmoothGeometry(raw, 1e-3);
  shrub.scale(1.2, 0.8, 1.16);
  shrub.translate(0, radius * 0.66, 0);
  return shrub;
}




/**
 * Tall, tileable ground detail maps for the island terrain: a fractal-noise
 * tangent-space normal map plus a roughness/albedo grain. Repeated at a
 * human scale (about 7 m per tile) they give grass, sand, dirt and asphalt
 * real micro-relief and specular break-up at the player's feet instead of a
 * single stretched 256 px colour overlay across the whole 540 m island.
 */
export function createTerrainSurfaceMaps(): {
  normal: THREE.DataTexture;
  roughness: THREE.DataTexture;
  grain: THREE.DataTexture;
} {
  const size = 256;
  const mask = size - 1;
  const height = new Float32Array(size * size);

  // Tileable value noise: hash lattice, then bilinear-smooth interpolation.
  const hash = (x: number, y: number): number => {
    let h = Math.imul(x & mask, 374761393) ^ Math.imul(y & mask, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  const valueNoise = (x: number, y: number, cell: number): number => {
    const fx = x / cell;
    const fy = y / cell;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const wrap = (v: number) => ((v % (size / cell)) + size / cell) % (size / cell);
    const cx0 = wrap(x0) * cell;
    const cy0 = wrap(y0) * cell;
    const cx1 = wrap(x0 + 1) * cell;
    const cy1 = wrap(y0 + 1) * cell;
    const a = hash(cx0, cy0);
    const b = hash(cx1, cy0);
    const c = hash(cx0, cy1);
    const d = hash(cx1, cy1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n =
        valueNoise(x, y, 64) * 0.5 +
        valueNoise(x, y, 24) * 0.28 +
        valueNoise(x, y, 8) * 0.16 +
        valueNoise(x, y, 3) * 0.06;
      height[y * size + x] = n;
    }
  }

  const normalData = new Uint8Array(size * size * 4);
  const roughnessData = new Uint8Array(size * size * 4);
  const grainData = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xPrev = (x - 1) & mask;
      const xNext = (x + 1) & mask;
      const yPrev = (y - 1) & mask;
      const yNext = (y + 1) & mask;
      const dx = (height[y * size + xNext] - height[y * size + xPrev]) * 6.5;
      const dy = (height[yNext * size + x] - height[yPrev * size + x]) * 6.5;
      const invLen = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      normalData[i] = Math.round((-dx * invLen * 0.5 + 0.5) * 255);
      normalData[i + 1] = Math.round((-dy * invLen * 0.5 + 0.5) * 255);
      normalData[i + 2] = Math.round(invLen * 0.5 * 255 + 127);
      normalData[i + 3] = 255;

      const grain = Math.round(150 + height[y * size + x] * 105);
      roughnessData[i] = roughnessData[i + 1] = roughnessData[i + 2] = grain;
      roughnessData[i + 3] = 255;

      const tone = Math.round(214 + (height[y * size + x] - 0.5) * 54);
      grainData[i] = tone;
      grainData[i + 1] = tone;
      grainData[i + 2] = tone;
      grainData[i + 3] = 255;
    }
  }

  const make = (data: Uint8Array, repeat: number, srgb = false): THREE.DataTexture => {
    const tex = new THREE.DataTexture(data, size, size);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  };

  return {
    normal: make(normalData, 76),
    roughness: make(roughnessData, 42),
    grain: make(grainData, 26, true),
  };
}
