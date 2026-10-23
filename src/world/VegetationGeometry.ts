import * as THREE from 'three';

/**
 * CI CRAFT 7.0 — high-detail procedural vegetation.
 *
 * Why this module exists
 * ----------------------
 * Up to 6.2 the island's trees were three 20-face icosahedron blobs welded
 * together (32 triangles per crown) on a single 64-triangle cylinder. At the
 * scale the crowns are drawn (~4 m across) that reads as a faceted balloon: no
 * branch structure, no silhouette variation, and no shading variation inside
 * the canopy, so every tree looked like the same green polygon.
 *
 * These builders produce authored silhouettes procedurally (no external asset
 * licence required, nothing to download) with:
 *   - irregular multi-lobe canopies on a golden-angle shell,
 *   - per-vertex canopy shading (occlusion toward the interior/underside,
 *     sun-facing lift on the outer crown),
 *   - buttressed, tapered trunks with real branch limbs reaching into the crown,
 *   - layered conifer boughs with drooping skirts and a leader spire,
 *   - spherical/wrapped UVs so the shared foliage normal map reads at the right
 *     density instead of smearing across the whole canopy.
 *
 * All builders emit a `color` attribute, so the instanced foliage materials are
 * created with `vertexColors: true`. Triangle cost is deliberately modest:
 * everything here is drawn through a handful of InstancedMeshes, and the
 * triangle delta is measured and budgeted in tests/graphics70.test.mjs.
 */

/* ------------------------------------------------------------------ */
/* Deterministic noise                                                 */
/* ------------------------------------------------------------------ */

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 15), 2654435761);
  h ^= seed * 2246822519;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Trilinear value noise in 3D; deterministic, no allocation. */
function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = smoothstep(x - xi);
  const yf = smoothstep(y - yi);
  const zf = smoothstep(z - zi);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c000 = hash3(xi, yi, zi, seed);
  const c100 = hash3(xi + 1, yi, zi, seed);
  const c010 = hash3(xi, yi + 1, zi, seed);
  const c110 = hash3(xi + 1, yi + 1, zi, seed);
  const c001 = hash3(xi, yi, zi + 1, seed);
  const c101 = hash3(xi + 1, yi, zi + 1, seed);
  const c011 = hash3(xi, yi + 1, zi + 1, seed);
  const c111 = hash3(xi + 1, yi + 1, zi + 1, seed);
  return lerp(
    lerp(lerp(c000, c100, xf), lerp(c010, c110, xf), yf),
    lerp(lerp(c001, c101, xf), lerp(c011, c111, xf), yf),
    zf
  );
}

/* ------------------------------------------------------------------ */
/* Small geometry helpers                                              */
/* ------------------------------------------------------------------ */

/** Merges geometries that all carry position/normal/uv/color. */
function mergeColored(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  for (const part of parts) {
    vertexCount += part.getAttribute('position').count;
    indexCount += part.index ? part.index.count : part.getAttribute('position').count;
  }
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const color = new Float32Array(vertexCount * 3);
  const index = new Uint32Array(indexCount);

  let vOff = 0;
  let iOff = 0;
  for (const part of parts) {
    const p = part.getAttribute('position');
    const n = part.getAttribute('normal');
    const u = part.getAttribute('uv');
    const c = part.getAttribute('color');
    position.set(p.array as Float32Array, vOff * 3);
    if (n) normal.set(n.array as Float32Array, vOff * 3);
    if (u) uv.set(u.array as Float32Array, vOff * 2);
    if (c) color.set(c.array as Float32Array, vOff * 3);
    else color.fill(1, vOff * 3, (vOff + p.count) * 3);

    if (part.index) {
      const src = part.index.array;
      for (let i = 0; i < src.length; i++) index[iOff + i] = (src[i] as number) + vOff;
      iOff += src.length;
    } else {
      for (let i = 0; i < p.count; i++) index[iOff + i] = vOff + i;
      iOff += p.count;
    }
    vOff += p.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  return merged;
}

/** Welds duplicated vertices and recomputes smooth normals. */
function weldAndSmooth(geometry: THREE.BufferGeometry, tolerance = 1e-3): THREE.BufferGeometry {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const posAttr = source.getAttribute('position');
  const invTol = 1 / tolerance;
  const remap = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const sourceUv = source.getAttribute('uv');

  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const key = `${Math.round(x * invTol)}_${Math.round(y * invTol)}_${Math.round(z * invTol)}`;
    let dst = remap.get(key);
    if (dst === undefined) {
      dst = positions.length / 3;
      remap.set(key, dst);
      positions.push(x, y, z);
      // Preserve the first UV seen at this position; foliage maps are tiling
      // noise, so per-face seams are invisible.
      uvs.push(sourceUv ? sourceUv.getX(i) : 0.5, sourceUv ? sourceUv.getY(i) : 0.5);
    }
    indices.push(dst);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  out.setIndex(indices);
  out.computeVertexNormals();
  return out;
}

/** Wraps a geometry with spherical UVs scaled by `tiles` (map density control). */
function applySphericalUv(geo: THREE.BufferGeometry, tiles: number, offsetU = 0): void {
  const pos = geo.getAttribute('position');
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    uvs[i * 2] = (Math.atan2(z, x) / (Math.PI * 2) + 0.5) * tiles + offsetU;
    uvs[i * 2 + 1] = (Math.asin(THREE.MathUtils.clamp(y / len, -1, 1)) / Math.PI + 0.5) * tiles;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

function paintAll(geo: THREE.BufferGeometry, r: number, g: number, b: number): void {
  const count = geo.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Tapered tube from `a` to `b`; used for limbs and roots. */
function limbGeometry(
  a: THREE.Vector3,
  b: THREE.Vector3,
  radiusA: number,
  radiusB: number,
  radial: number
): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const length = dir.length() || 0.001;
  const geo = new THREE.CylinderGeometry(radiusB, radiusA, length, radial, 1, true);
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.normalize()
  );
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  geo.applyQuaternion(quat);
  geo.translate(mid.x, mid.y, mid.z);
  return geo;
}

/* ------------------------------------------------------------------ */
/* Broadleaf canopy                                                    */
/* ------------------------------------------------------------------ */

/**
 * Irregular broadleaf canopy. Twelve lobes are distributed on a golden-angle
 * spherical shell with per-lobe radius/scale jitter; every lobe vertex is then
 * pushed along its radial direction by fractal noise so no two canopies share a
 * silhouette.
 *
 * ~250 triangles, plus a `color` attribute carrying canopy self-shading.
 */
export function createBroadleafCanopyGeometry(seed = 17): THREE.BufferGeometry {
  // One continuous subdivided shell rather than a pile of separate 20-face
  // polyhedra. A detached lobe always shows its own polygonal silhouette
  // against the sky, which is exactly the faceted "low-poly cone tree" look we
  // are replacing. A welded shell with shared normals reads as a single leafy
  // mass and its silhouette is as round as the subset of the surface we keep.
  // detail 2 = 180 faces. At the ~4.7 m crown size these are drawn at, that
  // is a ~0.45 m silhouette segment — smooth to the eye at gameplay range and
  // 44 % cheaper than detail 3, which matters because every tree in the island
  // is one of these.
  const shell = weldAndSmooth(new THREE.IcosahedronGeometry(1, 2));
  const pos = shell.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const dir = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    dir.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();

    // Three noise octaves: broad lobes, mid-size clumps, fine leaf mass.
    const lobe = valueNoise3(dir.x * 1.25 + seed * 0.7, dir.y * 1.25, dir.z * 1.25, seed + 11) - 0.5;
    const clump = valueNoise3(dir.x * 2.9, dir.y * 2.9 + seed * 0.3, dir.z * 2.9, seed + 43) - 0.5;
    const leaf = valueNoise3(dir.x * 6.4, dir.y * 6.4, dir.z * 6.4 + seed, seed + 91) - 0.5;

    // A cosine-3 azimuth term gives three dominant crown lobes instead of a
    // uniform sphere, so silhouettes differ between trees with different seeds.
    const azimuthLobes = Math.cos(Math.atan2(dir.z, dir.x) * 3 + seed * 0.9) * 0.1;

    const radius = 1 + lobe * 0.34 + clump * 0.15 + leaf * 0.055 + azimuthLobes;

    // Canopies are wider than tall and the underside is flattened: real crowns
    // sag toward the trunk rather than closing into a ball.
    const verticalSquash = dir.y > 0 ? 0.74 : 0.62;
    const undersideTuck = dir.y < -0.35 ? 1 - (Math.abs(dir.y) - 0.35) * 0.55 : 1;

    pos.setXYZ(
      i,
      dir.x * radius,
      dir.y * radius * verticalSquash * undersideTuck,
      dir.z * radius
    );

    // Per-vertex canopy self-shading: outer crown and top catch light, the
    // interior and the underside fall into leaf shadow. This is what stops the
    // canopy reading as a single flat green value.
    const crownLift = THREE.MathUtils.clamp(dir.y * 0.5 + 0.5, 0, 1);
    const shade = THREE.MathUtils.clamp(0.58 + crownLift * 0.5 + lobe * 0.22, 0.42, 1.2);
    colors[i * 3] = shade * 0.97;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade * 0.92;
  }

  shell.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  applySphericalUv(shell, 2.6);
  shell.computeVertexNormals();
  return shell;
}

/* ------------------------------------------------------------------ */
/* Broadleaf trunk + limbs                                             */
/* ------------------------------------------------------------------ */

/**
 * Buttressed, tapered trunk with three limbs reaching into the canopy and a
 * flared root collar. ~150 triangles. Unit height is 1, so the builder can keep
 * scaling it by trunk height like before.
 */
export function createBroadleafTrunkGeometry(seed = 5): THREE.BufferGeometry {
  const radial = 10;
  const heightSegs = 4;
  const trunk = new THREE.CylinderGeometry(0.17, 0.32, 1, radial, heightSegs, true);
  const pos = trunk.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const h01 = y + 0.5;
    const angle = Math.atan2(z, x);

    // Root collar: three buttress ridges that die out by 20 % of the trunk.
    const rootBand = Math.max(0, 1 - h01 / 0.2);
    const buttress = rootBand * rootBand * (0.5 + 0.42 * Math.cos(angle * 3));
    // Gentle lean + a slight oval section, never a perfect cylinder.
    const lean = Math.sin(h01 * Math.PI * 0.9) * 0.035;
    const oval = 1 + Math.sin(angle * 2 + seed) * 0.05;
    const bark = 1 + (valueNoise3(angle * 2.2, h01 * 6.1, seed, seed + 3) - 0.5) * 0.11;
    const s = (1 + buttress) * oval * bark;
    pos.setXYZ(i, x * s + lean, y, z * s);
  }

  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // Ambient occlusion at the ground contact, brighter where light reaches.
    const h01 = pos.getY(i) + 0.5;
    const shade = 0.52 + THREE.MathUtils.clamp(h01 * 1.7, 0, 1) * 0.5;
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade * 0.99;
    colors[i * 3 + 2] = shade * 0.96;
  }
  trunk.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  applySphericalUv(trunk, 1.6);
  trunk.computeVertexNormals();

  const parts: THREE.BufferGeometry[] = [trunk];

  // Branch limbs: short tapered tubes fanning out where the crown begins. They
  // break the "lollipop" read at mid distance without costing much.
  //
  // IMPORTANT: the trunk is instanced with `position.y = trunkH / 2` and
  // `scale.y = trunkH`, which assumes the geometry spans exactly y ∈ [-0.5,
  // 0.5]. Limbs that overshoot that range shift the apparent base of the trunk
  // downward (the whole tree appears to float / sink by half its height), so
  // every limb is clamped inside the unit envelope.
  const limbCount = 3;
  for (let b = 0; b < limbCount; b++) {
    const angle = (b / limbCount) * Math.PI * 2 + seed * 0.37;
    const startY = 0.28 + hash3(b, 2, 9, seed) * 0.08;
    const rise = 0.06 + hash3(b, 5, 1, seed) * 0.06;
    const reach = 0.26 + hash3(b, 8, 4, seed) * 0.12;
    const a = new THREE.Vector3(Math.cos(angle) * 0.07, startY, Math.sin(angle) * 0.07);
    const tip = new THREE.Vector3(Math.cos(angle) * reach, startY + rise, Math.sin(angle) * reach);
    const limb = limbGeometry(a, tip, 0.062, 0.026, 6);
    paintAll(limb, 0.78, 0.76, 0.72);
    applySphericalUv(limb, 1.4);
    limb.computeVertexNormals();
    parts.push(limb);
  }

  const merged = mergeColored(parts);
  merged.computeVertexNormals();

  // Belt and braces: whatever the deformations above produced, rescale into
  // exactly y ∈ [-0.5, 0.5] so the instancing contract always holds.
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  if (box.min.y < -0.5 || box.max.y > 0.5) {
    const span = Math.max(1e-4, box.max.y - box.min.y);
    const scale = 1 / span;
    const centre = (box.min.y + box.max.y) / 2;
    merged.translate(0, -centre, 0);
    merged.scale(1, scale, 1);
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Conifer                                                             */
/* ------------------------------------------------------------------ */

/**
 * Full conifer body: one welded, whorl-carved shell in place of stacked cones.
 * ~300 triangles, drawn once per tree instead of four separate tiers.
 */
export function createConiferBodyGeometry(seed = 3): THREE.BufferGeometry {
  // A spruce is ONE continuous form: a tall, narrow shell with branch whorls
  // ridging the surface. Stacking four separate cones (the old approach) always
  // produces read-able cone silhouettes against the sky no matter how the rims
  // are scalloped, because each tier has its own outline. Welding a single
  // tall shell and carving whorls into it removes the tiered read entirely and
  // costs less geometry than four cones.
  const shell = weldAndSmooth(new THREE.ConeGeometry(1, 1, 14, 8, false));
  const pos = shell.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const h01 = y + 0.5; // 0 at the base, 1 at the leader tip
    const r = Math.hypot(x, z);
    let px = x;
    let pz = z;
    let py = y;

    if (r > 1e-4) {
      const angle = Math.atan2(z, x);

      // Branch whorls: 7 rings of drooping boughs up the trunk. Each whorl
      // flares outward at its own ring and tucks back in between rings, which
      // is what a spruce silhouette actually looks like.
      const whorlRings = 6;
      const ringPhase = h01 * whorlRings;
      const ringIndex = Math.floor(ringPhase);
      const ringFrac = ringPhase - ringIndex;
      const ringBulge = Math.sin(ringFrac * Math.PI);

      // Angular variation so boughs are not a perfect cone of revolution.
      const angular = Math.cos(angle * 7 + ringIndex * 1.7 + seed) * 0.5 + 0.5;

      // Radius profile: wide skirt at the base tapering to the leader.
      const profile = Math.pow(1 - h01, 0.78) * 0.96 + 0.04;
      const boughFlare = 1 + ringBulge * (0.26 + angular * 0.22) * (1 - h01 * 0.45);
      const baseR = Math.hypot(x, z);
      const noise = (valueNoise3(angle * 4.2, h01 * 9.0, seed, seed + 19) - 0.5) * 0.16;

      const newR = (baseR * 0.35 + profile * 0.65) * boughFlare * (1 + noise);
      px = Math.cos(angle) * newR;
      pz = Math.sin(angle) * newR;

      // Bough tips droop down; between whorls the surface pulls up.
      py = y - ringBulge * (1 - h01) * 0.16 + (1 - profile) * 0.02;
    }

    pos.setXYZ(i, px, py, pz);

    // Needle shading: bough undersides and the trunk interior are dark, sunlit
    // outer tips are bright. This is what makes conifers read as volume.
    const radius = Math.hypot(px, pz);
    const whorlPhase = (py + 0.5) * 7;
    const whorlSin = Math.sin((whorlPhase - Math.floor(whorlPhase)) * Math.PI);
    const shade = THREE.MathUtils.clamp(
      0.46 + whorlSin * 0.34 + radius * 0.3 + (py + 0.5) * 0.14,
      0.34,
      1.18
    );
    colors[i * 3] = shade * 0.92;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade * 0.84;
  }

  shell.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  applySphericalUv(shell, 3.0);
  shell.computeVertexNormals();
  return shell;
}

/** Slim leader spire for the conifer tip. ~24 triangles. */
export function createConiferSpireGeometry(): THREE.BufferGeometry {
  const spire = new THREE.ConeGeometry(0.22, 1, 6, 1, true);
  paintAll(spire, 1.02, 1.06, 0.98);
  applySphericalUv(spire, 2.0);
  spire.computeVertexNormals();
  return spire;
}

/* ------------------------------------------------------------------ */
/* Shrub                                                               */
/* ------------------------------------------------------------------ */

/** Low scrub mound: five noise-displaced lobes. ~100 triangles. */
export function createShrubMoundGeometry(seed = 29): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const lobes = 5;
  for (let l = 0; l < lobes; l++) {
    const angle = (l / lobes) * Math.PI * 2 + seed * 0.21;
    const rad = l === 0 ? 0 : 0.42 + hash3(l, 4, 2, seed) * 0.18;
    const lobe = new THREE.IcosahedronGeometry(1, 0);
    const pos = lobe.getAttribute('position');
    const scale = 0.42 + hash3(l, 7, 6, seed) * 0.2;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      const n = valueNoise3(vx * 3.4 + l, vy * 3.4, vz * 3.4, seed + 5) - 0.5;
      const s = scale * (1 + n * 0.4);
      pos.setXYZ(
        i,
        Math.cos(angle) * rad + vx * s,
        Math.max(-0.15, vy * s * 0.72),
        Math.sin(angle) * rad + vz * s
      );
    }
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const shade = 0.58 + THREE.MathUtils.clamp(pos.getY(i) * 1.5 + 0.55, 0, 1) * 0.46;
      colors[i * 3] = shade * 0.96;
      colors[i * 3 + 1] = shade;
      colors[i * 3 + 2] = shade * 0.9;
    }
    lobe.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    applySphericalUv(lobe, 2.0);
    lobe.computeVertexNormals();
    parts.push(lobe);
  }
  const merged = mergeColored(parts);
  merged.computeVertexNormals();
  return merged;
}

/* ------------------------------------------------------------------ */
/* Quality tiers (LOD)                                                 */
/* ------------------------------------------------------------------ */

/**
 * Low-detail canopy used on the LOW and MEDIUM quality tiers. 80 faces against
 * the 180-face high tier — still a welded continuous shell with canopy shading
 * (so it never returns to the 6.2 faceted blob), just a coarser silhouette.
 */
export function createBroadleafCanopyLowGeometry(seed = 17): THREE.BufferGeometry {
  const shell = weldAndSmooth(new THREE.IcosahedronGeometry(1, 1));
  const pos = shell.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const dir = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    dir.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const lobe =
      valueNoise3(dir.x * 1.25 + seed * 0.7, dir.y * 1.25, dir.z * 1.25, seed + 11) - 0.5;
    const radius = 1 + lobe * 0.34;
    const verticalSquash = dir.y > 0 ? 0.74 : 0.62;
    pos.setXYZ(i, dir.x * radius, dir.y * radius * verticalSquash, dir.z * radius);
    const crownLift = THREE.MathUtils.clamp(dir.y * 0.5 + 0.5, 0, 1);
    const shade = THREE.MathUtils.clamp(0.58 + crownLift * 0.5 + lobe * 0.22, 0.42, 1.2);
    colors[i * 3] = shade * 0.97;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade * 0.92;
  }
  shell.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  applySphericalUv(shell, 2.6);
  shell.computeVertexNormals();
  return shell;
}

/** Low-detail conifer for LOW/MEDIUM: 8 x 4 whorl-carved shell. */
export function createConiferBodyLowGeometry(seed = 3): THREE.BufferGeometry {
  const shell = weldAndSmooth(new THREE.ConeGeometry(1, 1, 8, 4, false));
  const pos = shell.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const h01 = y + 0.5;
    const r = Math.hypot(x, z);
    let px = x;
    let py = y;
    let pz = z;
    if (r > 1e-4) {
      const angle = Math.atan2(z, x);
      const ringPhase = h01 * 6;
      const ringFrac = ringPhase - Math.floor(ringPhase);
      const ringBulge = Math.sin(ringFrac * Math.PI);
      const angular = Math.cos(angle * 7 + seed) * 0.5 + 0.5;
      const profile = Math.pow(1 - h01, 0.78) * 0.96 + 0.04;
      const flare = 1 + ringBulge * (0.26 + angular * 0.22) * (1 - h01 * 0.45);
      const newR = (r * 0.35 + profile * 0.65) * flare;
      px = Math.cos(angle) * newR;
      pz = Math.sin(angle) * newR;
      py = y - ringBulge * (1 - h01) * 0.16;
    }
    pos.setXYZ(i, px, py, pz);
    const shade = THREE.MathUtils.clamp(
      0.46 + ((py + 0.5) % (1 / 6)) * 2 + Math.hypot(px, pz) * 0.3 + (py + 0.5) * 0.14,
      0.34,
      1.18
    );
    colors[i * 3] = shade * 0.92;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade * 0.84;
  }
  shell.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  applySphericalUv(shell, 3.0);
  shell.computeVertexNormals();
  return shell;
}
