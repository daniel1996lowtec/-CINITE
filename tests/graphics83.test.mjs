/**
 * CI CRAFT 8.3 — world geometry validation.
 *
 * These tests are the executable form of `scripts/geometryAudit.mjs`. They walk
 * every mesh in the generated world and assert structural invariants that
 * gameplay tests never look at: finite coordinates, valid indices, no
 * degenerate or stretched triangles, sane world bounds, and correct ground
 * contact for props.
 *
 * Thresholds come from the real world scale (540 m heightfield over 208
 * segments = 2.60 m cells), and intentional large geometry — the sky dome, the
 * ocean plane, the road network and the ~400 m distant backdrop — is
 * allow-listed explicitly rather than being silently tolerated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadWorldModules } from '../scripts/headlessWorld.mjs';

const WORLD_SIZE = 540;
const WORLD_BOUND = WORLD_SIZE / 2 + 40;
const ISLAND_RADIUS = 215;
const WATER_Y = -0.28;
const MAX_TRIANGLE_EDGE = 60;
const TOWER_MAX_Y = 90;

// Geometry that legitimately contains very large triangles: the dome, the
// distant backdrop cones and the tower's light beam.
//
// NOTE: the road surface is deliberately NOT here. Allow-listing it by name
// would blind the stretched-triangle check to exactly the defect class that
// matters most — a road mesh stretched across the world. Road triangles are
// small by construction (segments are ~6 m apart), so the generic threshold
// already accommodates them.
const ALLOW_STRETCHED = [/AtmosphericSkyDome/, /DistantBackdrop/, /BeaconBeam/i];

// Geometry whose *centre* may sit outside the world box but is still correct.
const ALLOW_BOUNDS = [/AtmosphericSkyDome/, /DistantBackdrop/, /water|ocean/i];

const allowStretched = (name) => ALLOW_STRETCHED.some((re) => re.test(name));
const allowBounds = (name) => ALLOW_BOUNDS.some((re) => re.test(name));

let cached = null;
async function world() {
  if (cached) return cached;
  const { IslandWorld } = await loadWorldModules();
  const scene = new THREE.Scene();
  const instance = new IslandWorld(scene);
  instance.generate();
  scene.updateMatrixWorld(true);
  cached = { scene, instance };
  return cached;
}

function meshesOf(scene) {
  const list = [];
  scene.traverse((object) => {
    if (object.isMesh) list.push(object);
  });
  return list;
}

test('8.3 geometry: every vertex coordinate is finite', async () => {
  const { scene } = await world();
  const offenders = [];
  for (const mesh of meshesOf(scene)) {
    const pos = mesh.geometry?.attributes?.position;
    if (!pos) continue;
    let bad = 0;
    for (let i = 0; i < pos.array.length; i++) {
      if (!Number.isFinite(pos.array[i])) bad++;
    }
    if (bad > 0) offenders.push(`${mesh.name || mesh.type}: ${bad}`);
  }
  assert.deepEqual(offenders, [], `non-finite coordinates in: ${offenders.join(', ')}`);
});

test('8.3 geometry: every triangle index is in range', async () => {
  const { scene } = await world();
  const offenders = [];
  for (const mesh of meshesOf(scene)) {
    const geo = mesh.geometry;
    if (!geo?.index || !geo.attributes?.position) continue;
    const count = geo.attributes.position.count;
    let bad = 0;
    for (let i = 0; i < geo.index.count; i++) {
      const v = geo.index.getX(i);
      if (!Number.isInteger(v) || v < 0 || v >= count) bad++;
    }
    if (bad > 0) offenders.push(`${mesh.name || mesh.type}: ${bad}`);
  }
  assert.deepEqual(offenders, [], `invalid indices in: ${offenders.join(', ')}`);
});

test('8.3 geometry: no unintended stretched triangles', async () => {
  const { scene } = await world();
  const offenders = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  for (const mesh of meshesOf(scene)) {
    const geo = mesh.geometry;
    const pos = geo?.attributes?.position;
    if (!pos) continue;
    const name = mesh.name || mesh.type;
    if (allowStretched(name)) continue;

    const triCount = geo.index ? geo.index.count / 3 : pos.count / 3;
    const stride = triCount > 20000 ? Math.ceil(triCount / 20000) : 1;
    let stretched = 0;
    let longest = 0;
    for (let t = 0; t < triCount; t += stride) {
      const i0 = geo.index ? geo.index.getX(t * 3) : t * 3;
      const i1 = geo.index ? geo.index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = geo.index ? geo.index.getX(t * 3 + 2) : t * 3 + 2;
      if (i0 >= pos.count || i1 >= pos.count || i2 >= pos.count) continue;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      const edge = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
      if (edge > longest) longest = edge;
      if (edge > MAX_TRIANGLE_EDGE) stretched++;
    }
    if (stretched > 0) {
      offenders.push(`${name}: ${stretched} tris, longest ${longest.toFixed(1)} m`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `triangles stretched beyond ${MAX_TRIANGLE_EDGE} m — this is what a mis-indexed or ` +
      `mis-transformed mesh looks like: ${offenders.join('; ')}`
  );
});

test('8.3 geometry: no mesh has left the world', async () => {
  const { scene } = await world();
  const offenders = [];
  for (const mesh of meshesOf(scene)) {
    const name = mesh.name || mesh.type;
    if (allowBounds(name)) continue;
    if (!mesh.geometry?.attributes?.position) continue;
    mesh.geometry.computeBoundingBox();
    const centre = mesh.geometry.boundingBox
      .getCenter(new THREE.Vector3())
      .applyMatrix4(mesh.matrixWorld);
    if (
      Math.abs(centre.x) > WORLD_BOUND ||
      Math.abs(centre.z) > WORLD_BOUND ||
      centre.y < -20 ||
      centre.y > 200
    ) {
      offenders.push(
        `${name} at ${centre.x.toFixed(0)},${centre.y.toFixed(0)},${centre.z.toFixed(0)}`
      );
    }
  }
  assert.deepEqual(offenders, [], `meshes outside the world box: ${offenders.join(', ')}`);
});

test('8.3 geometry: no instanced batch has flown off the island', async () => {
  const { scene } = await world();
  const offenders = [];
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();

  for (const mesh of meshesOf(scene)) {
    if (!mesh.isInstancedMesh) continue;
    const name = mesh.name || mesh.type;
    const maxY = /legendary_tower/i.test(name) ? TOWER_MAX_Y : 60;
    let runaway = 0;
    let nonFinite = 0;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      if (m.elements.some((v) => !Number.isFinite(v))) {
        nonFinite++;
        continue;
      }
      m.decompose(p, q, s);
      // Harvested props are parked with zero scale; they are not rendered.
      if (s.x < 1e-4 && s.y < 1e-4) continue;
      if (
        Math.abs(p.x) > ISLAND_RADIUS + 25 ||
        Math.abs(p.z) > ISLAND_RADIUS + 25 ||
        p.y < -3 ||
        p.y > maxY
      ) {
        runaway++;
      }
    }
    if (nonFinite > 0) offenders.push(`${name}: ${nonFinite} non-finite matrices`);
    if (runaway > 0) offenders.push(`${name}: ${runaway}/${mesh.count} off-island`);
  }
  assert.deepEqual(offenders, [], `bad instances: ${offenders.join('; ')}`);
});

test('8.3 world: terrain and water elevations are consistent', async () => {
  const { instance } = await world();
  const terrain = instance.terrain;

  const water = terrain.waterMesh;
  assert.ok(water, 'no water mesh');
  assert.ok(
    Math.abs(water.position.y - WATER_Y) < 1e-3,
    `water surface is at ${water.position.y}, expected ${WATER_Y}`
  );

  // The island must be land, not a lake: if terrain ever stops rendering or is
  // generated at the wrong elevation, this is what catches it before the ocean
  // plane shows through as a cyan sheet.
  let sampled = 0;
  let above = 0;
  for (let x = -200; x <= 200; x += 10) {
    for (let z = -200; z <= 200; z += 10) {
      if (Math.hypot(x, z) > 200) continue;
      sampled++;
      if (terrain.getTerrainHeight(x, z) > WATER_Y) above++;
    }
  }
  assert.ok(sampled > 1000, 'too few elevation samples');
  const ratio = above / sampled;
  assert.ok(
    ratio > 0.85,
    `only ${(ratio * 100).toFixed(1)} % of the island is above the water plane`
  );

  assert.ok(terrain.terrainMesh, 'terrain mesh missing');
  assert.equal(terrain.terrainMesh.visible, true, 'terrain mesh is hidden');
});

test('8.3 world: every building and destructible prop sits on its ground', async () => {
  const { instance } = await world();
  const terrain = instance.terrain;

  let props = 0;
  const offenders = [];
  for (const [, prop] of instance.destructibles ?? []) {
    const p = prop.position;
    if (!p) continue;
    props++;
    const ground = terrain.getTerrainHeight(p.x, p.z);
    const dy = p.y - ground;
    // Props are anchored to the surface; a tree centred 1.5 m up is normal, a
    // prop 6 m off the ground is detached.
    if (dy < -2 || dy > 6) {
      offenders.push(`${prop.type} at ${p.x.toFixed(0)},${p.z.toFixed(0)} (${dy.toFixed(1)} m)`);
    }
  }
  assert.ok(props > 300, `only ${props} destructible props found`);
  assert.deepEqual(offenders, [], `detached props: ${offenders.join(', ')}`);
});

test('8.3 roads: the network is a continuous, upward-facing surface', async () => {
  const { instance } = await world();
  const terrain = instance.terrain;
  const road = terrain.roadSurfaceMesh;
  assert.ok(road, 'no road surface mesh');
  assert.ok(road.geometry.index, 'road surface is not indexed');

  const pos = road.geometry.attributes.position;
  const idx = road.geometry.index;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  let downward = 0;
  let underwater = 0;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < WATER_Y) underwater++;
  }
  for (let t = 0; t < idx.count / 3; t++) {
    a.fromBufferAttribute(pos, idx.getX(t * 3));
    b.fromBufferAttribute(pos, idx.getX(t * 3 + 1));
    c.fromBufferAttribute(pos, idx.getX(t * 3 + 2));
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.length() > 1e-9 && n.y < 0) downward++;
  }
  assert.equal(downward, 0, `${downward} road triangles face downward and would be culled`);
  assert.equal(underwater, 0, `${underwater} road vertices are below the water plane`);
});

test('8.3 roads: kerbs are kerb height, not barrier walls', async () => {
  const { scene, instance } = await world();
  const terrain = instance.terrain;
  const kerb = scene.getObjectByName('Expansion_roadside_stone_essential');
  assert.ok(kerb, 'kerb batch missing');

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const proud = [];
  for (let i = 0; i < kerb.count; i++) {
    kerb.getMatrixAt(i, m);
    m.decompose(p, q, s);
    if (s.y < 0.3) continue; // posts and other thin roadside props
    const top = p.y + s.y / 2;
    proud.push(top - terrain.getRenderedTerrainHeight(p.x, p.z));
  }
  assert.ok(proud.length > 200, `only ${proud.length} kerb strips found`);
  proud.sort((a, b) => a - b);
  const median = proud[Math.floor(proud.length / 2)];
  const p90 = proud[Math.floor(proud.length * 0.9)];

  // A kerb is 0.17 m of exposed face. The 8.3 regression made every kerb stand
  // 0.34 m proud, which read from eye level as a continuous grey wall running
  // down both sides of every road.
  assert.ok(
    median > 0.08 && median < 0.24,
    `median kerb stands ${median.toFixed(2)} m proud of the ground (expected ~0.17 m)`
  );
  assert.ok(
    p90 < 0.32,
    `90th-percentile kerb stands ${p90.toFixed(2)} m proud — kerbs are behaving like barriers`
  );
});

test('8.3 roads: bridge structure only exists where the road actually spans a gap', async () => {
  const { instance } = await world();
  const terrain = instance.terrain;
  const bridge = terrain.roadBridgeMesh;
  if (!bridge) return; // legitimate: a map with no elevated spans

  const pos = bridge.geometry.attributes.position;
  let checked = 0;
  let overLand = 0;
  for (let i = 0; i < pos.count; i += 3) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    checked++;
    // Structure belongs over water/void. If a pier or parapet's *highest*
    // points are sitting on dry land with no headroom beneath the deck, the
    // span test is wrong.
    if (y > 1.2 && terrain.getRenderedTerrainHeight(x, z) > -0.28) overLand++;
  }
  assert.ok(checked > 0, 'bridge mesh has no vertices');
  assert.ok(
    overLand / checked < 0.25,
    `${overLand}/${checked} bridge vertices stand over dry land — parapets and piers are ` +
      'being generated along ordinary flat road instead of over the lake'
  );
});
