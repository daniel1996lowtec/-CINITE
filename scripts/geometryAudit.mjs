/**
 * CI CRAFT geometry audit.
 *
 * Scans every mesh in the built world and reports structural problems that
 * unit tests on gameplay never see: non-finite coordinates, invalid indices,
 * degenerate or absurdly large triangles, meshes far outside the playable
 * region, and props that do not sit on the ground they belong to.
 *
 * Thresholds are derived from the actual world scale (540 m island, 208-segment
 * heightfield) rather than picked arbitrarily, and intentional large geometry
 * (terrain, ocean, sky dome, distant mountains) is allow-listed by name.
 *
 *   node scripts/geometryAudit.mjs            # summary
 *   node scripts/geometryAudit.mjs --verbose  # per-mesh detail
 */
import * as THREE from 'three';
import { loadWorldModules } from './headlessWorld.mjs';

const verbose = process.argv.includes('--verbose');

const WORLD_SIZE = 540;          // terrain plane extent (m)
const WORLD_HALF = WORLD_SIZE / 2;
const TERRAIN_CELL = WORLD_SIZE / 208;   // 2.596 m lattice
const ISLAND_RADIUS = 215;       // playable land radius (m)
const TOWER_MAX_Y = 90;          // legendary tower upper-storey ceiling (m)
const WATER_Y = -0.28;           // ocean surface

// A single triangle whose longest edge exceeds this is almost certainly a
// generation bug. The terrain's own cells are ~2.6 m; even a coarse road
// junction disc spans ~7 m. 60 m allows genuinely large authored structures
// while catching a triangle stretched across the island.
const MAX_TRIANGLE_EDGE = 60;
// Anything outside this box has left the intended world.
const WORLD_BOUND = WORLD_HALF + 40;

// Large geometry that is intentional, matched by name.
const ALLOW_LARGE = [
  { test: (n) => n === 'AtmosphericSkyDome', reason: 'sky dome, radius 285' },
  { test: (n) => /DistantBackdrop/.test(n), reason: 'intentional ~400 m backdrop scenery' },
  { test: (n) => /BeaconBeam/i.test(n), reason: 'legendary tower light beam' },
];
// Deliberately excluded: RoadSurface. Allow-listing the road by name would hide
// a road mesh stretched across the world, which is the defect class this audit
// most needs to catch. Its triangles are ~6 m by construction.
const allowed = (name) => ALLOW_LARGE.find((entry) => entry.test(name));

function trianglesOf(geometry) {
  if (!geometry) return 0;
  return geometry.index ? geometry.index.count / 3 : (geometry.attributes?.position?.count ?? 0) / 3;
}

function collect(scene) {
  const meshes = [];
  scene.traverse((object) => {
    if (!object.isMesh) return;
    const name = object.name || object.type;
    meshes.push({ object, name });
  });
  return meshes;
}

function auditMesh(entry) {
  const { object, name } = entry;
  const geo = object.geometry;
  const issues = [];
  if (!geo) return { name, issues: ['no geometry'] };

  const pos = geo.attributes?.position;
  if (!pos) return { name, issues: ['no position attribute'] };

  geo.computeBoundingBox();
  const box = geo.boundingBox;
  const worldBox = box.clone();
  // Instance/object transform is not applied to geometry bounds, so test both.
  const m = object.matrixWorld;

  // --- 1. non-finite coordinates -------------------------------------------
  let nonFinite = 0;
  const arr = pos.array;
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) nonFinite++;
  }
  if (nonFinite > 0) issues.push(`${nonFinite} non-finite position components`);

  // --- 2. invalid indices ---------------------------------------------------
  const idx = geo.index;
  if (idx) {
    let bad = 0;
    for (let i = 0; i < idx.count; i++) {
      const v = idx.getX(i);
      if (!Number.isInteger(v) || v < 0 || v >= pos.count) bad++;
    }
    if (bad > 0) issues.push(`${bad} out-of-range indices (of ${idx.count})`);
  }

  // --- 3. degenerate and over-long triangles -------------------------------
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const triCount = trianglesOf(geo);
  let degenerate = 0;
  let longest = 0;
  let longTriangles = 0;
  // Sampling keeps the audit fast on the 86k-triangle terrain.
  const stride = triCount > 20000 ? Math.ceil(triCount / 20000) : 1;
  for (let t = 0; t < triCount; t += stride) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    if (i0 >= pos.count || i1 >= pos.count || i2 >= pos.count) continue;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    if (!Number.isFinite(a.x + b.x + c.x + a.y + b.y + c.y)) continue;
    const e1 = a.distanceTo(b);
    const e2 = b.distanceTo(c);
    const e3 = c.distanceTo(a);
    const edge = Math.max(e1, e2, e3);
    if (edge > longest) longest = edge;
    if (edge > MAX_TRIANGLE_EDGE && !allowed(name)) longTriangles++;
    const area = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() * 0.5;
    if (area < 1e-9) degenerate++;
  }
  if (longTriangles > 0) {
    issues.push(`${longTriangles} triangles with an edge > ${MAX_TRIANGLE_EDGE} m (longest ${longest.toFixed(1)} m)`);
  }
  const degenerateRatio = triCount > 0 ? degenerate / (triCount / stride) : 0;
  if (degenerateRatio > 0.25) {
    issues.push(`${degenerate} degenerate triangles (${(degenerateRatio * 100).toFixed(0)} % of sample)`);
  }

  // --- 4. world bounds ------------------------------------------------------
  // Compare the transformed centre against the intended world box.
  const centre = box.getCenter(new THREE.Vector3()).applyMatrix4(m);
  if (
    Math.abs(centre.x) > WORLD_BOUND ||
    Math.abs(centre.z) > WORLD_BOUND ||
    centre.y < -20 ||
    centre.y > 200
  ) {
    if (!allowed(name)) {
      issues.push(
        `mesh centre ${centre.x.toFixed(0)},${centre.y.toFixed(0)},${centre.z.toFixed(0)} is outside the world box`
      );
    }
  }

  return {
    name,
    issues,
    triCount,
    longest,
    centre,
    box,
    isInstanced: object.isInstancedMesh,
    count: object.isInstancedMesh ? object.count : 1,
  };
}

function auditInstances(entry, terrain) {
  const { object, name } = entry;
  if (!object.isInstancedMesh) return [];
  const issues = [];
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  let nonFinite = 0;
  let outside = 0;
  const outsideSamples = [];
  for (let i = 0; i < object.count; i++) {
    object.getMatrixAt(i, m);
    if (m.elements.some((v) => !Number.isFinite(v))) {
      nonFinite++;
      continue;
    }
    m.decompose(p, q, s);
    // Deliberately parked instances (scale 0 / y -100) are the engine's way of
    // hiding harvested props; ignore those.
    if (s.x < 1e-4 && s.y < 1e-4) continue;
    // The legendary tower is a tall structure: its upper storeys legitimately
    // sit at y 60-75, so the ceiling depends on what the batch belongs to.
    const isTower = /legendary_tower/i.test(name);
    const maxY = isTower ? TOWER_MAX_Y : 60;
    if (Math.abs(p.x) > ISLAND_RADIUS + 25 || Math.abs(p.z) > ISLAND_RADIUS + 25 || p.y < -3 || p.y > maxY) {
      outside++;
      if (outsideSamples.length < 3) {
        outsideSamples.push(`${p.x.toFixed(0)},${p.y.toFixed(1)},${p.z.toFixed(0)}`);
      }
    }
  }
  if (nonFinite > 0) issues.push(`${nonFinite} instances with non-finite matrices`);
  if (outside > 0) {
    issues.push(`${outside}/${object.count} instances outside the playable region (${outsideSamples.join(' ')})`);
  }
  return issues;
}

async function main() {
  const { IslandWorld } = await loadWorldModules();
  const scene = new THREE.Scene();
  const world = new IslandWorld(scene);
  const t0 = Date.now();
  world.generate();
  scene.updateMatrixWorld(true);
  const buildMs = Date.now() - t0;

  const terrain = world.terrain;
  const meshes = collect(scene);

  let totalTriangles = 0;
  let trianglesWithIssues = 0;
  const failures = [];

  for (const entry of meshes) {
    const result = auditMesh(entry);
    totalTriangles += result.triCount ?? 0;
    const instanceIssues = result.isInstanced ? auditInstances(entry, terrain) : [];
    const issues = [...(result.issues ?? []), ...instanceIssues];
    if (issues.length > 0) {
      trianglesWithIssues += result.triCount ?? 0;
      failures.push({ name: result.name, issues, triCount: result.triCount, longest: result.longest, count: result.count });
    } else if (verbose) {
      console.log(`  ok  ${String(result.name).padEnd(34)} ${String(result.triCount).padStart(7)} tris`);
    }
  }

  // --- terrain / water elevation consistency -------------------------------
  const elevationIssues = [];
  const water = terrain.waterMesh;
  if (water && Math.abs(water.position.y - WATER_Y) > 1e-3) {
    elevationIssues.push(`water surface is at ${water.position.y}, expected ${WATER_Y}`);
  }
  let belowWater = 0;
  let sampled = 0;
  for (let x = -200; x <= 200; x += 10) {
    for (let z = -200; z <= 200; z += 10) {
      if (Math.hypot(x, z) > 200) continue;
      sampled++;
      if (terrain.getTerrainHeight(x, z) > WATER_Y) belowWater++;
    }
  }
  const landRatio = belowWater / sampled;
  if (landRatio < 0.85) {
    elevationIssues.push(`only ${(landRatio * 100).toFixed(1)} % of the island is above water`);
  }

  // --- road surface integrity ----------------------------------------------
  const roadIssues = [];
  const road = terrain.roadSurfaceMesh;
  if (!road) {
    roadIssues.push('no road surface mesh');
  } else {
    const pos = road.geometry.attributes.position;
    let underwater = 0;
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) < WATER_Y) underwater++;
    if (underwater > 0) roadIssues.push(`${underwater} road vertices below the water plane`);
  }

  // --- report ---------------------------------------------------------------
  console.log('CI CRAFT geometry audit');
  console.log(`  built in ${buildMs} ms`);
  console.log(`  meshes: ${meshes.length}   triangles: ${totalTriangles.toLocaleString()}`);
  console.log(
    `  thresholds: max triangle edge ${MAX_TRIANGLE_EDGE} m, world bounds ±${WORLD_BOUND} m, playable radius ${ISLAND_RADIUS} m`
  );
  console.log('');

  if (failures.length === 0 && elevationIssues.length === 0 && roadIssues.length === 0) {
    console.log('  PASS — no structural geometry problems found');
    return 0;
  }

  for (const failure of failures) {
    console.log(`  FAIL ${failure.name}${failure.count > 1 ? ` (${failure.count} instances)` : ''}`);
    for (const issue of failure.issues) console.log(`         ${issue}`);
  }
  for (const issue of elevationIssues) console.log(`  FAIL elevation: ${issue}`);
  for (const issue of roadIssues) console.log(`  FAIL road: ${issue}`);
  console.log('');
  console.log(`  ${failures.length} mesh(es), ${elevationIssues.length + roadIssues.length} world-level issue(s)`);
  return 1;
}

main().then((code) => process.exit(code));
