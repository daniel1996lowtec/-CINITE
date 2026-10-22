import * as THREE from 'three';

export type AtmospherePreset = 'day' | 'sunset' | 'night';
export type GraphicsQualitySetting = 'auto' | 'low' | 'medium' | 'high';
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
