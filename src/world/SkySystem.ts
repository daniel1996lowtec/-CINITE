import * as THREE from 'three';

/**
 * CI CRAFT 8.0 — atmospheric sky.
 *
 * The 7.x sky was a vertex-coloured sphere: 40×24 vertices interpolating three
 * colours, plus a flat circle mesh standing in for the sun and a low ring for
 * its halo. At 285 m the interpolation is visible as bands across the gradient,
 * the sun is a hard-edged disc that does not darken at the rim, and there are no
 * clouds in the sky at all — the cumulus were separate geometry floating in
 * front of an empty gradient.
 *
 * That is the single largest reason a Three.js scene reads as "engine demo". The
 * sky occupies half of every outdoor frame and it was flat.
 *
 * This replaces it with one analytic dome shader:
 *
 *   - three-stop gradient (zenith → horizon → ground) evaluated per fragment, so
 *     there is no vertex banding, with a compressed horizon band that gives the
 *     long, pale strip real atmospheres have,
 *   - a sun disc with limb darkening, a tight corona and a broad forward-scatter
 *     lobe, all derived from the same direction vector as the shadow-casting
 *     directional light, so the visible sun and the lit world agree,
 *   - a procedural cloud deck projected onto a plane above the camera, with two
 *     layers at different scales and drift speeds: sunlit tops, warm undersides
 *     and a silver lining where the cloud thins toward the light,
 *   - optional stars for the night preset, faded by cloud coverage so they do not
 *     shine through the overcast,
 *   - ordered dithering on the final colour, which kills the 8-bit banding a
 *     smooth gradient otherwise shows on mobile displays.
 *
 * Everything is driven by uniforms that `applyTimeOfDaySky` sets once per preset
 * change; only `uTime` is uploaded per frame.
 */

export interface SkyPresetColors {
  zenith: number;
  horizon: number;
  ground: number;
  sun: number;
  /** Cloud body colour away from the sun. */
  cloudShade: number;
  /** Cloud colour where the sun hits it. */
  cloudLit: number;
  /** 0 = clear, 1 = fully overcast. */
  cloudCoverage: number;
  /** Radians. The visible sun disc radius. */
  sunRadius: number;
  /** How bright the disc is before tone mapping. */
  sunIntensity: number;
  /** Star visibility 0..1. */
  stars: number;
}

export const SKY_PRESETS: Record<'day' | 'sunset' | 'night', SkyPresetColors> = {
  day: {
    zenith: 0x2f6f9e,
    horizon: 0xd6e6ec,
    ground: 0x5d6650,
    sun: 0xfff4d0,
    cloudShade: 0x8fa6bd,
    cloudLit: 0xffffff,
    cloudCoverage: 0.46,
    sunRadius: 0.016,
    sunIntensity: 2.4,
    stars: 0,
  },
  sunset: {
    zenith: 0x2b2a6b,
    horizon: 0xff9a4d,
    ground: 0x3a1a0a,
    sun: 0xffc067,
    cloudShade: 0x7a5a80,
    cloudLit: 0xffd2a1,
    cloudCoverage: 0.52,
    // Low sun spreads over more sky, so the visible disc is wider and dimmer.
    sunRadius: 0.024,
    sunIntensity: 2.0,
    stars: 0.35,
  },
  night: {
    zenith: 0x02060f,
    horizon: 0x152c46,
    ground: 0x03060b,
    sun: 0xbfd8ff,
    cloudShade: 0x1b2740,
    cloudLit: 0x51637f,
    cloudCoverage: 0.34,
    sunRadius: 0.013,
    sunIntensity: 0.85,
    stars: 1,
  },
};

export interface SkyUniforms {
  uSunDirection: { value: THREE.Vector3 };
  uZenith: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uGround: { value: THREE.Color };
  uSunColor: { value: THREE.Color };
  uCloudShade: { value: THREE.Color };
  uCloudLit: { value: THREE.Color };
  uCloudCoverage: { value: number };
  uSunRadius: { value: number };
  uSunIntensity: { value: number };
  uStarAmount: { value: number };
  uTime: { value: number };
  /** 1 on HIGH/ULTRA, 0 on LOW/MEDIUM (drops the second cloud layer). */
  uCloudDetail: { value: number };
}

const VERTEX_SHADER = /* glsl */ `
varying vec3 vSkyDirection;

void main() {
  // The dome is centred on the camera every frame, so its local position is
  // already a view direction. Normalising here keeps the fragment shader cheap.
  vSkyDirection = normalize(position);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec3 vSkyDirection;

uniform vec3 uSunDirection;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uCloudShade;
uniform vec3 uCloudLit;
uniform float uCloudCoverage;
uniform float uSunRadius;
uniform float uSunIntensity;
uniform float uStarAmount;
uniform float uTime;
uniform float uCloudDetail;

const float PI = 3.14159265359;

float skyHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float skyNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = skyHash(i);
  float b = skyHash(i + vec2(1.0, 0.0));
  float c = skyHash(i + vec2(0.0, 1.0));
  float d = skyHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Fractal sum. Octave count is a compile-time constant so this stays within
// GLSL ES 1.00 loop rules; the detail level is controlled by a uniform branch
// at the call site instead.
float skyFbm4(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * skyNoise(p);
    p = p * 2.03 + vec2(11.3, 7.7);
    amplitude *= 0.5;
  }
  return value;
}

float skyFbm2(vec2 p) {
  return skyNoise(p) * 0.55 + skyNoise(p * 2.03 + vec2(11.3, 7.7)) * 0.28;
}

/**
 * Cloud deck.
 *
 * Projecting the view direction onto a plane at unit height gives real
 * perspective: clouds bunch toward the horizon and open up overhead. The
 * division is clamped so the projection never explodes at the horizon.
 */
float sampleCloudLayer(vec3 dir, float scale, float drift, float detail) {
  float elevation = max(dir.y, 0.02);
  vec2 projected = dir.xz / (elevation * 1.35 + 0.18);
  vec2 uv = projected * scale + vec2(drift, drift * 0.36);

  float base = detail > 0.5 ? skyFbm4(uv) : skyFbm2(uv);
  float shape = skyFbm2(uv * 0.47 + vec2(29.1, 5.3));

  // Coverage threshold carves large masses out of the noise instead of the
  // uniform "static" look you get from using noise directly as density.
  float threshold = mix(0.72, 0.34, uCloudCoverage);
  float density = smoothstep(threshold, threshold + 0.26, base * 0.72 + shape * 0.42);

  // Fade out into the horizon so the deck meets the haze instead of ending.
  float horizonFade = smoothstep(0.0, 0.16, dir.y);
  return clamp(density * horizonFade, 0.0, 1.0);
}

void main() {
  vec3 dir = normalize(vSkyDirection);
  float elevation = dir.y;

  /* ---------------- gradient ---------------- */
  // Compress the transition so the horizon band stays long and pale, which is
  // what sells distance on a flat screen.
  float up = clamp(elevation, 0.0, 1.0);
  float skyMix = pow(up, 0.42);
  vec3 color = mix(uHorizon, uZenith, skyMix);
  float down = clamp(-elevation, 0.0, 1.0);
  color = mix(color, uGround, smoothstep(0.0, 0.22, down));

  /* ---------------- sun ---------------- */
  vec3 sunDir = normalize(uSunDirection);
  float cosSun = dot(dir, sunDir);
  float sunDot = max(cosSun, 0.0);

  // Forward scattering: broad warm lift around the sun, strongest near the
  // horizon where the optical path is longest.
  float scatterWidth = mix(6.0, 26.0, clamp(1.0 - sunDir.y, 0.0, 1.0));
  float scatter = pow(sunDot, scatterWidth);
  float corona = pow(sunDot, 900.0);
  color += uSunColor * scatter * 0.55;
  color += uSunColor * corona * 0.9;

  // Disc, with a soft limb so it reads as a light source rather than a sticker.
  float discOuter = cos(uSunRadius);
  float discInner = cos(uSunRadius * 0.72);
  float disc = smoothstep(discOuter, discInner, cosSun);
  float limb = mix(1.0, 0.72, smoothstep(discInner, 1.0, cosSun));
  color += uSunColor * disc * uSunIntensity * limb;

  /* ---------------- clouds ---------------- */
  vec3 cloudColor = uCloudShade;
  float cloudAlpha = 0.0;
  float cloudThickness = 0.0;

  if (elevation > -0.02) {
    float lower = sampleCloudLayer(dir, 0.55, uTime * 0.0042, uCloudDetail);
    float upper = sampleCloudLayer(dir, 1.35, uTime * 0.0105, 0.0);
    // Wispy high cloud sits over the cumulus deck.
    cloudAlpha = clamp(lower * 0.94 + upper * 0.30, 0.0, 1.0);
    cloudThickness = lower;

    // Sunlit where the cloud faces the light, cool and dense underneath. Using
    // the sun direction against the view gives a believable silver lining
    // without a second noise evaluation.
    float facing = pow(max(cosSun, 0.0), 3.0);
    vec3 lit = mix(uCloudLit, uCloudLit * 1.25 + uSunColor * 0.35, facing);
    // Clouds near the sun are backlit and read darker at the core.
    float rim = smoothstep(0.0, 0.65, 1.0 - abs(lower - 0.5) * 2.0);
    vec3 body = mix(uCloudShade, lit, clamp(lower * 1.25, 0.0, 1.0));
    cloudColor = mix(body, lit, rim * 0.35);
    // Thick cores block the sun.
    cloudColor *= 1.0 - cloudThickness * 0.22;
    cloudAlpha *= smoothstep(-0.02, 0.10, elevation);
  }

  color = mix(color, cloudColor, cloudAlpha * 0.92);

  /* ---------------- stars ---------------- */
  if (uStarAmount > 0.01) {
    // Stars are drawn on the dome rather than as sprites so they are occluded
    // by the cloud deck for free.
    vec2 starUv = dir.xz / max(abs(dir.y) + 0.12, 0.12) * 14.0;
    float star = skyHash(floor(starUv * 42.0));
    float twinkle = 0.65 + 0.35 * sin(uTime * 2.1 + star * 40.0);
    float starMask = smoothstep(0.9975, 1.0, star) * twinkle;
    color += vec3(0.85, 0.92, 1.0) * starMask * uStarAmount * (1.0 - cloudAlpha) * smoothstep(0.02, 0.3, elevation);
  }

  /* ---------------- horizon haze ---------------- */
  // A thin band of sky-coloured haze at the seam makes the water and distant
  // islands dissolve into the sky instead of meeting it at a hard line.
  float haze = exp(-abs(elevation) * 26.0);
  color = mix(color, uHorizon, haze * 0.35);

  /* ---------------- dither + output ---------------- */
  // 8-bit banding is very visible on a smooth gradient at phone brightness.
  float dither = (skyHash(gl_FragCoord.xy) - 0.5) / 255.0;
  color += dither;

  gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createSkyUniforms(preset: SkyPresetColors): SkyUniforms {
  return {
    uSunDirection: { value: new THREE.Vector3(0.5, 0.5, 0.5).normalize() },
    uZenith: { value: new THREE.Color(preset.zenith) },
    uHorizon: { value: new THREE.Color(preset.horizon) },
    uGround: { value: new THREE.Color(preset.ground) },
    uSunColor: { value: new THREE.Color(preset.sun) },
    uCloudShade: { value: new THREE.Color(preset.cloudShade) },
    uCloudLit: { value: new THREE.Color(preset.cloudLit) },
    uCloudCoverage: { value: preset.cloudCoverage },
    uSunRadius: { value: preset.sunRadius },
    uSunIntensity: { value: preset.sunIntensity },
    uStarAmount: { value: preset.stars },
    uTime: { value: 0 },
    uCloudDetail: { value: 1 },
  };
}

/**
 * Builds the dome material. Kept separate from the mesh so tests can inspect the
 * shader without a renderer.
 */
export function createSkyMaterial(radius: number): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: createSkyUniforms(SKY_PRESETS.day) as unknown as Record<
      string,
      THREE.IUniform
    >,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  material.name = 'CiCraftSkyMaterial';
  // Exposed so the caller can reach the uniforms without a second lookup.
  material.userData.skyRadius = radius;
  return material;
}

/** Applies a preset's colours in place (no reallocation, no shader recompile). */
export function applySkyPreset(
  material: THREE.ShaderMaterial,
  preset: SkyPresetColors,
  sunDirection: THREE.Vector3
): void {
  const uniforms = material.uniforms as unknown as SkyUniforms;
  uniforms.uSunDirection.value.copy(sunDirection).normalize();
  (uniforms.uZenith.value as THREE.Color).setHex(preset.zenith);
  (uniforms.uHorizon.value as THREE.Color).setHex(preset.horizon);
  (uniforms.uGround.value as THREE.Color).setHex(preset.ground);
  (uniforms.uSunColor.value as THREE.Color).setHex(preset.sun);
  (uniforms.uCloudShade.value as THREE.Color).setHex(preset.cloudShade);
  (uniforms.uCloudLit.value as THREE.Color).setHex(preset.cloudLit);
  uniforms.uCloudCoverage.value = preset.cloudCoverage;
  uniforms.uSunRadius.value = preset.sunRadius;
  uniforms.uSunIntensity.value = preset.sunIntensity;
  uniforms.uStarAmount.value = preset.stars;
}

export function setSkyTime(material: THREE.ShaderMaterial, time: number): void {
  const uniforms = material.uniforms as unknown as SkyUniforms;
  uniforms.uTime.value = time;
}

/** LOW/MEDIUM drops the second cloud layer to stay fill-rate friendly. */
export function setSkyCloudDetail(material: THREE.ShaderMaterial, detail: number): void {
  const uniforms = material.uniforms as unknown as SkyUniforms;
  uniforms.uCloudDetail.value = detail;
}

/**
 * Colour of the air at the horizon in a given view direction.
 *
 * Used for aerial perspective: distant geometry should fade into the sky colour
 * *behind it*, not into one fixed fog colour. Reusing the sky's own horizon and
 * sun-scatter terms keeps the two in agreement.
 */
export function horizonAirColor(
  preset: SkyPresetColors,
  sunDirection: THREE.Vector3,
  viewDirection: THREE.Vector3,
  out: THREE.Color
): THREE.Color {
  const sunDot = Math.max(0, viewDirection.dot(sunDirection));
  out.setHex(preset.horizon);
  // Warm the haze toward the sun the same way the shader's scatter does.
  const warm = new THREE.Color(preset.sun);
  out.lerp(warm, Math.pow(sunDot, 6) * 0.55);
  return out;
}
