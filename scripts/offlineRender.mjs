/**
 * CI CRAFT 6.2 — offline world preview renderer.
 *
 * This is NOT a browser/WebGL screenshot. The sandbox has no Chromium and no
 * root access to install its shared libraries, so the running game cannot be
 * captured here. Instead this script builds the *actual* generated Three.js
 * world headlessly (same modules the game loads, same geometry, materials,
 * textures and instance transforms) and rasterises it with a small software
 * renderer. It samples the real albedo DataTextures through the same
 * world-space UV projection the shader uses, applies the real per-vertex AO and
 * per-instance tints, and renders flat directional + hemisphere lighting.
 *
 * The result is faithful for what it is meant to prove — geometry silhouettes,
 * facade depth, roof construction, texture scale and material assignment — and
 * clearly not a substitute for an in-game screenshot (no soft shadows, no
 * PMREM reflections, no bloom, no post tone mapping).
 *
 * Usage:
 *   node scripts/offlineRender.mjs [--out dir] [--width 1280] [--height 720]
 *                                  [--scene all|plaza|docks|keep|farms|tower|street|roads]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { loadWorldModules } from './headlessWorld.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const OUT_DIR = path.resolve(ROOT, argValue('out', 'artifacts/offline-preview'));
const WIDTH = Number(argValue('width', '1280'));
const HEIGHT = Number(argValue('height', '720'));
const SCENE_FILTER = argValue('scene', 'all');

/* ------------------------------- PNG output ------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ texture access ---------------------------- */

function averageTexture(texture) {
  if (!texture) return null;
  const image = texture.image;
  if (!image || !image.data || !image.width) return null;
  const data = image.data;
  const total = image.width * image.height;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    r += data[o];
    g += data[o + 1];
    b += data[o + 2];
  }
  return {
    r: r / total / 255,
    g: g / total / 255,
    b: b / total / 255,
    width: image.width,
    height: image.height,
    data,
    srgb: texture.colorSpace === THREE.SRGBColorSpace,
  };
}

function sampleTexture(info, u, v) {
  if (!info) return null;
  const { width, height, data } = info;
  const x = ((Math.floor(u * width) % width) + width) % width;
  const y = ((Math.floor(v * height) % height) + height) % height;
  const o = (y * width + x) * 4;
  let r = data[o] / 255;
  let g = data[o + 1] / 255;
  let b = data[o + 2] / 255;
  if (info.srgb) {
    // Texture values are sRGB; convert to linear for lighting.
    r = r ** 2.2;
    g = g ** 2.2;
    b = b ** 2.2;
  }
  return [r, g, b];
}

/* ------------------------------ scene extraction -------------------------- */

const { IslandWorld } = await loadWorldModules();
const scene = new THREE.Scene();
const world = new IslandWorld(scene);
const buildStart = performance.now();
world.generate();
scene.updateMatrixWorld(true);
const buildMs = Math.round(performance.now() - buildStart);

const triangles = [];
const textureCache = new WeakMap();

function materialInfo(material) {
  if (Array.isArray(material)) material = material[0];
  if (!material) return { r: 0.5, g: 0.5, b: 0.5 };
  let cached = textureCache.get(material);
  if (cached) return cached;
  const mapInfo = averageTexture(material.map);
  const uvMeta = material.userData?.cicraftWorldUv;
  cached = {
    color: material.color ? [material.color.r, material.color.g, material.color.b] : [1, 1, 1],
    emissive: material.emissive
      ? [material.emissive.r, material.emissive.g, material.emissive.b]
      : [0, 0, 0],
    emissiveIntensity: material.emissiveIntensity ?? 1,
    mapInfo,
    uvScale: uvMeta ? 1 / uvMeta.metresPerTile : null,
    opacity: material.transparent ? material.opacity ?? 1 : 1,
    transparent: Boolean(material.transparent),
    metalness: material.metalness ?? 0,
    roughness: material.roughness ?? 1,
    isGlow: material.type === 'MeshBasicMaterial' && !material.map,
    groundDetail:
      typeof material.customProgramCacheKey === 'function' &&
      material.customProgramCacheKey() === 'cicraft-terrain-ground-detail',
    ocean:
      typeof material.customProgramCacheKey === 'function' &&
      String(material.customProgramCacheKey()).includes('cicraft-ocean'),
    doubleSided: material.side === THREE.DoubleSide,
    flat: Boolean(material.flatShading),
  };
  textureCache.set(material, cached);
  return cached;
}

// Per-vertex ocean depth (water surface minus terrain height), read once from
// the geometry attribute so the offline renderer can reproduce the water
// shader's depth grading and shoreline foam.
function readOceanDepth(geometry) {
  const attr = geometry.getAttribute('aOceanDepth');
  if (!attr) return null;
  return attr;
}

const v0 = new THREE.Vector3();
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const n0 = new THREE.Vector3();
const n1 = new THREE.Vector3();
const n2 = new THREE.Vector3();
const matrix = new THREE.Matrix4();
const normalMatrix = new THREE.Matrix3();
const colorScratch = new THREE.Color();

const OPAQUE_ONLY = args.includes('--opaque-only');
const DEBUG_PIXELS = (argValue('debug-pixels', '') || '')
  .split(',')
  .filter(Boolean)
  .map((pair) => pair.split('x').map(Number));
const debugHits = new Map();

function pushGeometry(geometry, worldMatrix, material, instanceColor, vertexColorAttr, name) {
  const info = materialInfo(material);
  const position = geometry.getAttribute('position');
  if (!position) return;
  const normal = geometry.getAttribute('normal');
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  normalMatrix.getNormalMatrix(worldMatrix);
  const triCount = Math.floor(count / 3);
  for (let t = 0; t < triCount; t++) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    v0.fromBufferAttribute(position, ia).applyMatrix4(worldMatrix);
    v1.fromBufferAttribute(position, ib).applyMatrix4(worldMatrix);
    v2.fromBufferAttribute(position, ic).applyMatrix4(worldMatrix);
    if (normal) {
      n0.fromBufferAttribute(normal, ia).applyMatrix3(normalMatrix).normalize();
      n1.fromBufferAttribute(normal, ib).applyMatrix3(normalMatrix).normalize();
      n2.fromBufferAttribute(normal, ic).applyMatrix3(normalMatrix).normalize();
    } else {
      n0.copy(v1).sub(v0).cross(new THREE.Vector3().subVectors(v2, v0)).normalize();
      n1.copy(n0);
      n2.copy(n0);
    }
    let tint = [1, 1, 1];
    if (instanceColor) {
      colorScratch.setRGB(instanceColor.r, instanceColor.g, instanceColor.b);
      tint = [instanceColor.r, instanceColor.g, instanceColor.b];
    }
    const vertexColors = vertexColorAttr
      ? [
          [vertexColorAttr.getX(ia), vertexColorAttr.getY(ia), vertexColorAttr.getZ(ia)],
          [vertexColorAttr.getX(ib), vertexColorAttr.getY(ib), vertexColorAttr.getZ(ib)],
          [vertexColorAttr.getX(ic), vertexColorAttr.getY(ic), vertexColorAttr.getZ(ic)],
        ]
      : null;
    let oceanDepth = null;
    if (info.ocean) {
      const depthAttr = readOceanDepth(geometry);
      if (depthAttr) oceanDepth = [depthAttr.getX(ia), depthAttr.getX(ib), depthAttr.getX(ic)];
    }
    triangles.push({
      p: [v0.clone(), v1.clone(), v2.clone()],
      n: [n0.clone(), n1.clone(), n2.clone()],
      hasVertexNormals: Boolean(normal),
      info,
      tint,
      vertexColors,
      oceanDepth,
      name,
    });
  }
}

/**
 * Approximates the CI CRAFT 8.0 sky shader for the offline preview.
 *
 * This is deliberately a faithful-in-composition, not pixel-exact, port: it
 * reproduces the three-stop gradient, the sun scatter and one procedural cloud
 * layer. It exists so previews do not show a black dome or a fake flat gradient
 * — it is NOT evidence of what the browser renders.
 */
function paintSkyBackground(pixels, camera) {
  const skyMesh = scene.getObjectByName('AtmosphericSkyDome');
  const material = skyMesh?.material;
  const u = material?.uniforms;
  const toLinear = (hex) => {
    const c = new THREE.Color(hex);
    c.convertSRGBToLinear?.();
    return [c.r, c.g, c.b];
  };
  const lin = (uniform) =>
    uniform ? [uniform.value.r, uniform.value.g, uniform.value.b] : [0, 0, 0];

  const zenith = u ? lin(u.uZenith) : toLinear(0x2f6f9e);
  const horizon = u ? lin(u.uHorizon) : toLinear(0xd6e6ec);
  const groundC = u ? lin(u.uGround) : toLinear(0x5d6650);
  const sunC = u ? lin(u.uSunColor) : toLinear(0xfff4d0);
  const cloudShade = u ? lin(u.uCloudShade) : toLinear(0x8fa6bd);
  const cloudLit = u ? lin(u.uCloudLit) : toLinear(0xffffff);
  const sunDir = u
    ? u.uSunDirection.value.clone().normalize()
    : new THREE.Vector3(0.5, 0.5, 0.5).normalize();
  const coverage = u ? u.uCloudCoverage.value : 0.46;
  const sunRadius = u ? u.uSunRadius.value : 0.016;
  const sunIntensity = u ? u.uSunIntensity.value : 2.4;
  const starAmount = u ? u.uStarAmount.value : 0;

  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  const trueUp = new THREE.Vector3().crossVectors(right, forward).normalize();
  const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
  const aspect = WIDTH / HEIGHT;

  const hash = (x, y) => {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return v - Math.floor(v);
  };
  const noise = (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  };
  const fbm = (x, y, octaves) => {
    let value = 0;
    let amplitude = 0.5;
    for (let i = 0; i < octaves; i++) {
      value += amplitude * noise(x, y);
      x = x * 2.03 + 11.3;
      y = y * 2.03 + 7.7;
      amplitude *= 0.5;
    }
    return value;
  };

  const dir = new THREE.Vector3();
  for (let y = 0; y < HEIGHT; y++) {
    const ndcY = 1 - (2 * (y + 0.5)) / HEIGHT;
    for (let x = 0; x < WIDTH; x++) {
      const ndcX = (2 * (x + 0.5)) / WIDTH - 1;
      dir
        .copy(forward)
        .addScaledVector(right, ndcX * tanHalf * aspect)
        .addScaledVector(trueUp, ndcY * tanHalf)
        .normalize();

      const elevation = dir.y;
      const skyMix = Math.pow(Math.max(0, Math.min(1, elevation)), 0.42);
      let r = horizon[0] + (zenith[0] - horizon[0]) * skyMix;
      let g = horizon[1] + (zenith[1] - horizon[1]) * skyMix;
      let b = horizon[2] + (zenith[2] - horizon[2]) * skyMix;
      const down = Math.max(0, Math.min(1, -elevation / 0.22));
      r += (groundC[0] - r) * down;
      g += (groundC[1] - g) * down;
      b += (groundC[2] - b) * down;

      const cosSun = dir.dot(sunDir);
      const sunDot = Math.max(0, cosSun);
      const scatterWidth = 6 + 20 * Math.max(0, Math.min(1, 1 - sunDir.y));
      const scatter = Math.pow(sunDot, scatterWidth);
      const corona = Math.pow(sunDot, 900);
      r += sunC[0] * (scatter * 0.55 + corona * 0.9);
      g += sunC[1] * (scatter * 0.55 + corona * 0.9);
      b += sunC[2] * (scatter * 0.55 + corona * 0.9);

      if (cosSun > Math.cos(sunRadius)) {
        const disc = Math.min(
          1,
          (cosSun - Math.cos(sunRadius)) / (Math.cos(sunRadius * 0.72) - Math.cos(sunRadius))
        );
        r += sunC[0] * disc * sunIntensity;
        g += sunC[1] * disc * sunIntensity;
        b += sunC[2] * disc * sunIntensity;
      }

      if (elevation > -0.02) {
        const projScale = 1.35 * Math.max(elevation, 0.02) + 0.18;
        const px = (dir.x / projScale) * 0.55;
        const pz = (dir.z / projScale) * 0.55;
        const base = fbm(px, pz, 3);
        const shape = fbm(px * 0.47 + 29.1, pz * 0.47 + 5.3, 2);
        const threshold = 0.72 + (0.34 - 0.72) * coverage;
        const raw = (base * 0.72 + shape * 0.42 - threshold) / 0.26;
        const density = Math.max(0, Math.min(1, raw));
        const alpha =
          density * Math.min(1, Math.max(0, elevation / 0.16)) * 0.92;
        if (alpha > 0.001) {
          const facing = Math.pow(sunDot, 3);
          const litR = cloudLit[0] * (1 + 0.25 * facing) + sunC[0] * 0.35 * facing;
          const litG = cloudLit[1] * (1 + 0.25 * facing) + sunC[1] * 0.35 * facing;
          const litB = cloudLit[2] * (1 + 0.25 * facing) + sunC[2] * 0.35 * facing;
          const mixAmt = Math.min(1, Math.max(0, base * 1.25));
          const cr = cloudShade[0] + (litR - cloudShade[0]) * mixAmt;
          const cg = cloudShade[1] + (litG - cloudShade[1]) * mixAmt;
          const cb = cloudShade[2] + (litB - cloudShade[2]) * mixAmt;
          r += (cr - r) * alpha;
          g += (cg - g) * alpha;
          b += (cb - b) * alpha;
        }
      }

      if (starAmount > 0.01 && elevation > 0.05) {
        const star = hash(Math.floor(x * 0.7), Math.floor(y * 0.7));
        if (star > 0.9993) {
          const s = starAmount * 0.9;
          r += s;
          g += s;
          b += s;
        }
      }

      const o = (y * WIDTH + x) * 3;
      pixels[o] = r;
      pixels[o + 1] = g;
      pixels[o + 2] = b;
    }
  }
}

scene.traverse((object) => {
  if (!object.isMesh || !object.visible) return;
  if (object.material?.visible === false) return;
  // The 8.0 sky is an analytic dome shader; the rasteriser reproduces it as a
  // background function instead of drawing its triangles.
  if (object.material?.name === 'CiCraftSkyMaterial') return;
  if (object.name === 'AtmosphericSun' || object.name === 'AtmosphericSunHalo') return;
  const geometry = object.geometry;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  if (object.isInstancedMesh) {
    const instanceMatrix = new THREE.Matrix4();
    const instanceColor = new THREE.Color();
    for (let i = 0; i < object.count; i++) {
      object.getMatrixAt(i, instanceMatrix);
      matrix.multiplyMatrices(object.matrixWorld, instanceMatrix);
      const hasColor = Boolean(object.instanceColor);
      if (hasColor) object.getColorAt(i, instanceColor);
      pushGeometry(
        geometry,
        matrix,
        materials[0],
        hasColor ? { r: instanceColor.r, g: instanceColor.g, b: instanceColor.b } : null,
        geometry.getAttribute('color'),
        `${object.name || object.type}[${i}]`
      );
    }
    return;
  }
  const tag =
    object === world.terrain.terrainMesh
      ? 'TERRAIN'
      : object === world.terrain.waterMesh
        ? 'WATER'
        : object.name || object.type;
  pushGeometry(
    geometry,
    object.matrixWorld,
    materials[0],
    null,
    geometry.getAttribute('color'),
    tag
  );
});

console.log(
  'terrain check:',
  triangles.filter((t) => t.name === 'TERRAIN').length,
  'water:',
  triangles.filter((t) => t.name === 'WATER').length,
  'mesh name:',
  world.terrain.terrainMesh.name || '(none)',
  'tri tris:',
  world.terrain.terrainMesh.geometry.index.count / 3
);
const byName = new Map();
for (const tri of triangles) byName.set(tri.name, (byName.get(tri.name) ?? 0) + 1);
console.log(`offline preview: ${triangles.length} triangles, world built in ${buildMs} ms`);
if (args.includes('--near')) {
  const near = triangles.filter((tri) =>
    Math.abs(tri.p[0].x - 18) < 8 && Math.abs(tri.p[0].z - 25) < 8
  );
  const names = {};
  for (const tri of near) names[tri.name] = (names[tri.name] ?? 0) + 1;
  console.log('near-origin triangles by object:', names);
  if (near[0]) {
    console.log('sample near tri', near[0].name, near[0].p.map((p) => p.toArray().map((v) => +v.toFixed(2))));
  }
}
if (args.includes('--stats')) {
  console.log(
    [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([name, count]) => `${name}: ${count}`)
      .join('\n')
  );
}

/* ------------------------------- rasteriser ------------------------------- */

const sun = new THREE.Vector3(0.52, 0.78, 0.36).normalize();
const camera = new THREE.PerspectiveCamera(58, WIDTH / HEIGHT, 0.35, 900);
const projection = new THREE.Matrix4();

function render(name, eye, target, fov = 58) {
  camera.fov = fov;
  camera.position.copy(eye);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

  if (args.includes('--near')) {
    const near = triangles
      .filter((tri) => tri.name === 'TERRAIN')
      .map((tri) => ({ tri, d: tri.p[0].clone().add(tri.p[1]).add(tri.p[2]).multiplyScalar(1 / 3).distanceToSquared(new THREE.Vector3(18, 4.5, 25.67)) }))
      .sort((a, b) => a.d - b.d)[0];
    if (near) {
      const pts = near.tri.p.map((v) => {
        const q = new THREE.Vector4(v.x, v.y, v.z, 1).applyMatrix4(projection);
        return `${((q.x / q.w) * 0.5 + 0.5) * WIDTH | 0},${((0.5 - (q.y / q.w) * 0.5) * HEIGHT) | 0}(w${q.w.toFixed(1)})`;
      });
      console.log('  nearest terrain tri screen:', pts.join(' '));
    }
  }
  const depth = new Float32Array(WIDTH * HEIGHT).fill(Infinity);
  const pixels = new Float32Array(WIDTH * HEIGHT * 3);
  paintSkyBackground(pixels, camera);

  const sa = new THREE.Vector4();
  const sb = new THREE.Vector4();
  const sc = new THREE.Vector4();
  const tempColor = [0, 0, 0];

  const drawList = [
    ...triangles.filter((tri) => !tri.info.transparent && !(OPAQUE_ONLY && tri.info.isGlow)),
    ...(OPAQUE_ONLY ? [] : triangles
      .filter((tri) => tri.info.transparent)
      .sort((a, b) => {
        const da = a.p[0].distanceToSquared(camera.position);
        const db = b.p[0].distanceToSquared(camera.position);
        return db - da;
      })),
  ];

  // Near-plane clipping: triangles that cross the eye plane are clipped in
  // homogeneous clip space, otherwise a wedge of ground disappears right in
  // front of the camera (the classic "no clipping" artefact).
  const NEAR_W = 0.08;
  const clipVertex = (v, other, t) => ({
    x: v.x + (other.x - v.x) * t,
    y: v.y + (other.y - v.y) * t,
    z: v.z + (other.z - v.z) * t,
    w: v.w + (other.w - v.w) * t,
  });

  for (const tri of drawList) {
    const clipVerts = [
      sa.set(tri.p[0].x, tri.p[0].y, tri.p[0].z, 1).applyMatrix4(projection).clone(),
      sb.set(tri.p[1].x, tri.p[1].y, tri.p[1].z, 1).applyMatrix4(projection).clone(),
      sc.set(tri.p[2].x, tri.p[2].y, tri.p[2].z, 1).applyMatrix4(projection).clone(),
    ];
    let polygon = clipVerts;
    const anyBehind = clipVerts.some((v) => v.w <= NEAR_W);
    if (anyBehind) {
      polygon = [];
      for (let i = 0; i < clipVerts.length; i++) {
        const current = clipVerts[i];
        const next = clipVerts[(i + 1) % clipVerts.length];
        const currentInside = current.w > NEAR_W;
        const nextInside = next.w > NEAR_W;
        if (currentInside) polygon.push(current);
        if (currentInside !== nextInside) {
          const t = (NEAR_W - current.w) / (next.w - current.w);
          polygon.push(clipVertex(current, next, t));
        }
      }
      if (polygon.length < 3) continue;
    }
    // Fan-triangulate the (possibly clipped) polygon.
    const screen = polygon.map((v) => ({
      x: (v.x / v.w * 0.5 + 0.5) * WIDTH,
      y: (0.5 - v.y / v.w * 0.5) * HEIGHT,
      z: v.w,
    }));
    for (let f = 1; f + 1 < screen.length; f++) {
      const A = screen[0];
      const B = screen[f];
      const C = screen[f + 1];
      const ax = A.x;
      const ay = A.y;
      const bx = B.x;
      const by = B.y;
      const cx = C.x;
      const cy = C.y;
      // Screen Y is flipped relative to NDC, so a front-facing (CCW) triangle
      // has a NEGATIVE signed area here. Positive areas are back faces.
      //
      // Double-sided materials must draw both. Crossed grass/foliage billboards
      // are three triangles at 60 degrees: from half of all view azimuths every
      // one of them is back-facing, so ignoring `side` culled entire ground
      // cover layers and made authored vegetation look missing.
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (!tri.info.doubleSided && area >= 0) continue;
      if (Math.abs(area) < 1e-9) continue;
      // Double-sided faces seen from behind must still shade with a normal
      // pointing at the camera, as Three does by flipping it.
      const facingCamera = area < 0;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const maxX = Math.min(WIDTH - 1, Math.ceil(Math.max(ax, bx, cx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const maxY = Math.min(HEIGHT - 1, Math.ceil(Math.max(ay, by, cy)));
      if (minX > maxX || minY > maxY) continue;
      const invW0 = 1 / A.z;
      const invW1 = 1 / B.z;
      const invW2 = 1 / C.z;
      const info = tri.info;
      const faceNormal = tri.n[0];
      // Flagged flat-shaded materials (foliage cards, rock facets) keep the
      // face normal; everything else interpolates the three vertex normals so
      // smooth-shaded meshes are not rendered as faceted in the preview.
      const useVertexNormals = !info.flat && tri.hasVertexNormals;
      const baseBary = [invW0, invW1, invW2];

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
          const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const b0 = w0 * baseBary[0];
          const b1 = w1 * baseBary[1];
          const b2 = w2 * baseBary[2];
          const total = b0 + b1 + b2;
          const invTotal = 1 / total;
          const z = 1 / total;
          const index = y * WIDTH + x;
          if (z >= depth[index]) continue;
          // World-space position, perspective correct.
          const wx = (tri.p[0].x * b0 + tri.p[1].x * b1 + tri.p[2].x * b2) * invTotal;
          const wy = (tri.p[0].y * b0 + tri.p[1].y * b1 + tri.p[2].y * b2) * invTotal;
          const wz = (tri.p[0].z * b0 + tri.p[1].z * b1 + tri.p[2].z * b2) * invTotal;
          let nx = faceNormal.x;
          let ny = faceNormal.y;
          let nz = faceNormal.z;
          if (useVertexNormals) {
            nx = (tri.n[0].x * b0 + tri.n[1].x * b1 + tri.n[2].x * b2) * invTotal;
            ny = (tri.n[0].y * b0 + tri.n[1].y * b1 + tri.n[2].y * b2) * invTotal;
            nz = (tri.n[0].z * b0 + tri.n[1].z * b1 + tri.n[2].z * b2) * invTotal;
            const len = Math.hypot(nx, ny, nz) || 1;
            nx /= len;
            ny /= len;
            nz /= len;
          }
          // A double-sided surface seen from behind must flip its normal, the
          // same way Three's DoubleSide does, or foliage goes black.
          if (tri.info.doubleSided && !facingCamera) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
          }
          const lambert = Math.max(0, nx * sun.x + ny * sun.y + nz * sun.z);
          const skyUp = ny * 0.5 + 0.5;
          const light = 0.30 + skyUp * 0.34 + lambert * 0.85;
          const an = [Math.abs(nx), Math.abs(ny), Math.abs(nz)];
          let albedo = info.color;
          if (info.mapInfo) {
            let u;
            let v;
            if (info.uvScale) {
              if (an[1] >= an[0] && an[1] >= an[2]) {
                u = wx * info.uvScale;
                v = wz * info.uvScale;
              } else if (an[0] >= an[2]) {
                u = wz * info.uvScale;
                v = wy * info.uvScale;
              } else {
                u = wx * info.uvScale;
                v = wy * info.uvScale;
              }
            } else {
              u = wx * 0.12;
              v = wz * 0.12;
            }
            const sampled = sampleTexture(info.mapInfo, u, v);
            albedo = [
              info.color[0] * sampled[0],
              info.color[1] * sampled[1],
              info.color[2] * sampled[2],
            ];
          }
          // Three.js multiplies BOTH the instance colour and the geometry
          // vertex colour into vColor (see the color_vertex chunk); it does not
          // substitute one for the other. The renderer used to replace the tint,
          // which silently dropped the per-tree leaf/trunk colour as soon as a
          // geometry carried a colour attribute.
          let tint = tri.tint;
          if (tri.vertexColors) {
            tint = [
              tint[0] * (tri.vertexColors[0][0] * b0 + tri.vertexColors[1][0] * b1 + tri.vertexColors[2][0] * b2) * invTotal,
              tint[1] * (tri.vertexColors[0][1] * b0 + tri.vertexColors[1][1] * b1 + tri.vertexColors[2][1] * b2) * invTotal,
              tint[2] * (tri.vertexColors[0][2] * b0 + tri.vertexColors[1][2] * b1 + tri.vertexColors[2][2] * b2) * invTotal,
            ];
          }
          let r;
          let g;
          let b;
          let oceanLit = false;
          let wr_ocean = 0;
          let wg_ocean = 0;
          let wb_ocean = 0;
          if (info.ocean && tri.oceanDepth) {
            // Reproduce applyOceanShader(): depth grading, animated shoreline
            // foam and the capped Fresnel sky lift. Wave displacement is not
            // emulated (it does not change the silhouette at these ranges).
            const depth = Math.max(
              0,
              (tri.oceanDepth[0] * b0 + tri.oceanDepth[1] * b1 + tri.oceanDepth[2] * b2) * invTotal
            );
            const smoothstep = (e0, e1, x) => {
              const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
              return t * t * (3 - 2 * t);
            };
            const mix = (a, c, t) => a + (c - a) * t;
            const shallow = [0.24, 0.8, 0.74];
            const mid = [0.06, 0.52, 0.68];
            const deep = [0.02, 0.17, 0.33];
            const toMid = smoothstep(0, 3.2, depth);
            const toDeep = smoothstep(2.6, 12.0, depth);
            let wr = mix(shallow[0], mid[0], toMid);
            let wg = mix(shallow[1], mid[1], toMid);
            let wb = mix(shallow[2], mid[2], toMid);
            wr = mix(wr, deep[0], toDeep);
            wg = mix(wg, deep[1], toDeep);
            wb = mix(wb, deep[2], toDeep);
            wr = mix(wr, albedo[0], 0.42);
            wg = mix(wg, albedo[1], 0.42);
            wb = mix(wb, albedo[2], 0.42);
            const foamBand = 1 - smoothstep(0, 0.85, depth);
            const ripple =
              Math.sin(wx * 3.1 + 0.4) * Math.sin(wz * 2.7 - 0.3);
            const foamMask = smoothstep(0.35, 1.0, foamBand * (0.72 + ripple * 0.38));
            wr = mix(wr, 0.94, foamMask * 0.85);
            wg = mix(wg, 0.98, foamMask * 0.85);
            wb = mix(wb, 1.0, foamMask * 0.85);
            const nrm = tri.n[0];
            const toEye = new THREE.Vector3(
              camera.position.x - wx,
              camera.position.y - wy,
              camera.position.z - wz
            ).normalize();
            const facing = Math.max(0, nrm.dot(toEye));
            const fres = Math.min(0.55, Math.pow(1 - facing, 4)) * 0.6;
            wr_ocean = mix(wr, 0.46, fres) * (1.02 - tint[0] * 0.02);
            wg_ocean = mix(wg, 0.66, fres) * (1.02 - tint[1] * 0.02);
            wb_ocean = mix(wb, 0.82, fres) * (1.02 - tint[2] * 0.02);
            oceanLit = true;
          }
          if (info.groundDetail) {
            // Emulate the terrain ground-detail shader: the same three octaves
            // of value noise, dry patches, rock chips, wet sand and speckle.
            const hash2 = (px2, py2) => {
              const v = Math.sin(px2 * 127.1 + py2 * 311.7) * 43758.5453;
              return v - Math.floor(v);
            };
            const smooth2 = (t) => t * t * (3 - 2 * t);
            const noise2 = (px2, py2) => {
              const ix = Math.floor(px2);
              const iy = Math.floor(py2);
              const fx = px2 - ix;
              const fy = py2 - iy;
              const ux = smooth2(fx);
              const uy = smooth2(fy);
              const a = hash2(ix, iy);
              const b = hash2(ix + 1, iy);
              const c = hash2(ix, iy + 1);
              const d = hash2(ix + 1, iy + 1);
              return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
            };
            // Mirrors applyTerrainGroundDetail in VisualAtmosphere.ts:
            // layered turf/soil/gravel blend, damp hollows, dry crowns,
            // speckle and wet shore darkening.
            const fbm2 = (px2, py2) => {
              let v = 0;
              let amp = 0.5;
              let x2 = px2;
              let y2 = py2;
              for (let i = 0; i < 4; i++) {
                v += amp * noise2(x2, y2);
                x2 = x2 * 2.03 + 13.1;
                y2 = y2 * 2.03 + 5.7;
                amp *= 0.5;
              }
              return v;
            };
            const nFine = noise2(wx * 1.7, wz * 1.7);
            const nMid = fbm2(wx * 0.09 + 17, wz * 0.09 + 17);
            const nCoarse = noise2(wx * 0.012 + 41, wz * 0.012 + 41);
            const nSpeck = noise2(wx * 6.3 + 5, wz * 6.3 + 5);
            const upness = Math.max(0, Math.min(1, faceNormal.y));
            const slope = 1 - upness;
            const smooth = (e0, e1, v) => {
              const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0)));
              return t * t * (3 - 2 * t);
            };

            let dr = albedo[0] * tint[0];
            let dg = albedo[1] * tint[1];
            let db = albedo[2] * tint[2];

            const turfAltitude = smooth(1.7, 3.2, wy);
            const turfMask = nMid * 0.72 + noise2(wx * 0.31 + 7, wz * 0.31 + 7) * 0.28;
            const turf =
              smooth(0.38, 0.72, turfMask) * (1 - smooth(0.12, 0.45, slope)) * turfAltitude;
            const soil = (1 - turf) * smooth(0.42, 0.68, nFine) * 0.4 * turfAltitude;
            const turfR = 0.2 + (0.31 - 0.2) * nFine;
            const turfG = 0.34 + (0.44 - 0.34) * nFine;
            const turfB = 0.13 + (0.19 - 0.13) * nFine;
            const soilR = 0.31 + (0.42 - 0.31) * nFine;
            const soilG = 0.23 + (0.32 - 0.23) * nFine;
            const soilB = 0.14 + (0.2 - 0.14) * nFine;
            const mix = (a, b2, t) => a + (b2 - a) * t;
            dr = mix(dr, turfR, turf * 0.45);
            dg = mix(dg, turfG, turf * 0.45);
            db = mix(db, turfB, turf * 0.45);
            dr = mix(dr, soilR, soil);
            dg = mix(dg, soilG, soil);
            db = mix(db, soilB, soil);

            const gravel = smooth(0.22, 0.5, slope) * smooth(0.4, 0.75, nSpeck + slope * 0.3);
            dr = mix(dr, 0.34, gravel * 0.5);
            dg = mix(dg, 0.33, gravel * 0.5);
            db = mix(db, 0.31, gravel * 0.5);

            const dampHollow = smooth(0.62, 0.9, nCoarse) * (1 - smooth(0.2, 0.5, slope));
            dr *= 1 - dampHollow * 0.18;
            dg *= 1 - dampHollow * 0.18;
            db *= 1 - dampHollow * 0.18;

            const dryW = smooth(0.6, 0.92, nCoarse) * smooth(0.4, 0.9, nMid);
            dr = mix(dr, dr * 1.16, dryW * 0.7);
            dg = mix(dg, dg * 1.1, dryW * 0.7);
            db = mix(db, db * 0.88, dryW * 0.7);

            const speck = smooth(0.82, 0.99, nSpeck);
            dr = mix(dr, dr * 0.84 + 0.03, speck * 0.4);
            dg = mix(dg, dg * 0.84 + 0.03, speck * 0.4);
            db = mix(db, db * 0.84 + 0.03, speck * 0.4);

            const wet = smooth(0.25, 1.4, 1.4 - (wy - 0.25)) * 0;
            const shoreWet = Math.max(0, Math.min(1, (1.4 - wy) / 1.15));
            dr *= 1 - shoreWet * 0.2;
            dg *= 1 - shoreWet * 0.2;
            db *= 1 - shoreWet * 0.2;

            dr *= light;
            dg *= light;
            db *= light;
            albedo = [dr, dg, db];
            tint = [1, 1, 1];
            r = albedo[0];
            g = albedo[1];
            b = albedo[2];
          } else if (oceanLit) {
            // Water is dominated by reflection and depth scattering, not by
            // the diffuse lambert term; use the shader-emulated colour directly.
            r = wr_ocean;
            g = wg_ocean;
            b = wb_ocean;
          } else if (info.isGlow) {
            r = albedo[0] * tint[0] * 1.9;
            g = albedo[1] * tint[1] * 1.9;
            b = albedo[2] * tint[2] * 1.9;
          } else {
            r = albedo[0] * tint[0] * light;
            g = albedo[1] * tint[1] * light;
            b = albedo[2] * tint[2] * light;
          }
          r += info.emissive[0] * info.emissiveIntensity * 0.8;
          g += info.emissive[1] * info.emissiveIntensity * 0.8;
          b += info.emissive[2] * info.emissiveIntensity * 0.8;
          // Aerial perspective matching the game's FogExp2 (0.0018, day).
          const distance = z;
          const fogFactor = 1 - Math.exp(-Math.pow(distance * 0.0018, 2));
          const fogR = 0.803;
          const fogG = 0.866;
          const fogB = 0.898;
          r = r * (1 - fogFactor) + fogR * fogFactor;
          g = g * (1 - fogFactor) + fogG * fogFactor;
          b = b * (1 - fogFactor) + fogB * fogFactor;
          const alpha = info.opacity;
          const o = index * 3;
          if (info.transparent && alpha < 0.99) {
            pixels[o] = pixels[o] * (1 - alpha) + r * alpha;
            pixels[o + 1] = pixels[o + 1] * (1 - alpha) + g * alpha;
            pixels[o + 2] = pixels[o + 2] * (1 - alpha) + b * alpha;
            continue;
          }
          depth[index] = z;
          if (DEBUG_PIXELS.length) debugHits.set(index, { name: tri.name, z, wx, wy, wz });
          pixels[o] = r;
          pixels[o + 1] = g;
          pixels[o + 2] = b;
        }
      }
    }
  }

  // Distance fog + tone map + sRGB encode.
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    const o = i * 3;
    let r = pixels[o];
    let g = pixels[o + 1];
    let b = pixels[o + 2];
    const aces = (value) => {
      const v = Math.max(0, value) * 1.05;
      // Narkowicz ACES filmic approximation, matching ACESFilmicToneMapping.
      const toned = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
      return Math.min(1, Math.max(0, toned));
    };
    const mapped = [r, g, b].map((value) =>
      Math.round(aces(value) ** (1 / 2.2) * 255)
    );
    rgb[o] = mapped[0];
    rgb[o + 1] = mapped[1];
    rgb[o + 2] = mapped[2];
  }
  // --debug-pixels reports which object actually owns the sampled pixels.
  for (const [px, py] of DEBUG_PIXELS) {
    const hit = debugHits.get(py * WIDTH + px);
    console.log(
      `  pixel ${px}x${py}:`,
      hit
        ? `${hit.name} z=${hit.z.toFixed(2)} at (${hit.wx.toFixed(1)}, ${hit.wy.toFixed(1)}, ${hit.wz.toFixed(1)})`
        : 'background'
    );
  }
  debugHits.clear();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, encodePng(WIDTH, HEIGHT, rgb));
  console.log(`  wrote ${path.relative(ROOT, file)}`);
}

/* ------------------------------- viewpoints ------------------------------- */

const groundAt = (x, z) => world.terrain.getTerrainHeight(x, z);
const eyeAt = (x, z, height = 1.75) => new THREE.Vector3(x, groundAt(x, z) + height, z);
const look = (x, y, z) => new THREE.Vector3(x, y, z);

const viewpoints = {
  // Eye-level player views. The look-at point sits ~2 m above the target
  // ground, so the framing matches the game's third-person camera pitch.
  plaza: [
    [eyeAt(18, 30, 1.75), look(18, groundAt(18, 16) + 2.4, 16), 62],
    [eyeAt(-18, 30, 1.75), look(-18, groundAt(-18, 16) + 2.4, 16), 62],
    [eyeAt(-30, 22, 1.75), look(-34, groundAt(-34, -1) + 3.2, -1), 62],
    [eyeAt(46, 12, 1.75), look(34, groundAt(34, 4) + 2.8, 4), 60],
    [eyeAt(7, -20, 1.75), look(7, groundAt(7, -34) + 2.8, -34), 62],
    [eyeAt(30, 38, 9.0), look(-6, groundAt(0, 0) + 2.0, 0), 72],
  ],
  docks: [[eyeAt(-112, 116, 1.75), look(-92, groundAt(-92, 100) + 3.0, 100), 62]],
  keep: [[eyeAt(110, -84, 2.0), look(84, groundAt(84, -80) + 4.0, -80), 64]],
  farms: [[eyeAt(20, -96, 1.75), look(2, groundAt(2, -104) + 3.0, -104), 62]],
  tower: [[eyeAt(-30, -46, 1.75), look(0, groundAt(0, 0) + 8, 0), 68]],
  street: [[eyeAt(-66, 16, 1.75), look(-118, groundAt(-118, 16) + 2.2, 16), 64]],
  grove: [[eyeAt(-102, -68, 1.75), look(-121, groundAt(-121, -80) + 2.6, -80), 62]],
  terrain: [[eyeAt(152, 58, 14.0), look(96, groundAt(96, 20) + 2.0, 20), 68]],
  // CI CRAFT 8.4 — `docks` and `keep` used to stand 3.4 m behind a shipping
  // container stack and hard against a tower respectively, so both frames were
  // a single flat-coloured prop filling the screen and proved nothing about the
  // world. Both cameras were moved to clear ground lines of sight.
  //
  // CI CRAFT 8.2 — kept so road geometry can be inspected reproducibly:
  // surface continuity, kerb contact, junction closure and the Mirror Lake
  // causeway. --scene roads
  roads: [
    [eyeAt(-8, -38, 1.7), look(-23, groundAt(-23, -95) + 1.2, -95), 68],
    [eyeAt(-22, 46, 2.0), look(-58, groundAt(-58, 52) + 1.6, 52), 68],
    [eyeAt(-8, 72, 18), look(-56, groundAt(-56, 46) + 0.5, 46), 62],
    [eyeAt(120, -78, 6), look(150, groundAt(150, -100) + 1.0, -100), 64],
    [eyeAt(-58, 46, 14), look(-30, groundAt(-30, 6) + 1.0, 6), 62],
    [eyeAt(-78, 122, 1.7), look(-101, groundAt(-101, 98) + 1.4, 98), 68],
  ],
};

const chosen = SCENE_FILTER === 'all' ? Object.keys(viewpoints) : [SCENE_FILTER];
for (const name of chosen) {
  const list = viewpoints[name];
  if (!list) continue;
  list.forEach(([eye, target, fov], index) => {
    render(list.length > 1 ? `${name}-${index + 1}` : name, eye, target, fov);
  });
}
console.log(`offline preview complete → ${path.relative(ROOT, OUT_DIR)}`);
