/**
 * CI CRAFT 8.2 — road geometry and terrain alignment.
 *
 * Four separate defects were found in the road network. Each one gets a test
 * that fails against the old behaviour, not just a test that passes now:
 *
 *   1. Roads were painted ONLY as terrain vertex colours. The terrain lattice is
 *      2.60 m, so a 7.2 m carriageway spanned under three vertices and its edge
 *      was a 2.6 m interpolated gradient — the "disconnected road edges".
 *   2. The terrain colour cascade tested water depth BEFORE roads, so any road
 *      vertex on low ground was painted seabed navy (0x075985) or lagoon
 *      turquoise. That is the "long black strips crossing road surfaces".
 *   3. Kerbs were one rigid 6.12 m box per step placed at a single mid height:
 *      98 % floated clear of the ground, worst 5.78 m.
 *   4. The primary road (0,0)-(-105,95) crosses Mirror Lake, where the bed is
 *      -1.65 m — below the -0.28 m water plane — so the road ran underwater.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadWorldModules } from '../scripts/headlessWorld.mjs';

const WATER_Y = -0.28;

async function buildWorld() {
  const { IslandWorld, layout } = await loadWorldModules();
  const scene = new THREE.Scene();
  const world = new IslandWorld(scene);
  world.generate();
  scene.updateMatrixWorld(true);
  return { scene, world, segments: layout.ISLAND_ROAD_SEGMENTS };
}

test('8.2 roads: real carriageway geometry exists and faces upward', async () => {
  const { world } = await buildWorld();
  const mesh = world.terrain.roadSurfaceMesh;
  assert.ok(mesh, 'no road surface mesh was generated');
  assert.ok(mesh.geometry.index, 'road surface is not indexed');

  const triangles = mesh.geometry.index.count / 3;
  assert.ok(triangles > 500, `only ${triangles} road triangles — geometry is missing`);

  const pos = mesh.geometry.attributes.position;
  const idx = mesh.geometry.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let downward = 0, degenerate = 0;
  for (let t = 0; t < triangles; t++) {
    a.fromBufferAttribute(pos, idx.getX(t * 3));
    b.fromBufferAttribute(pos, idx.getX(t * 3 + 1));
    c.fromBufferAttribute(pos, idx.getX(t * 3 + 2));
    const n = new THREE.Vector3()
      .subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a));
    if (n.length() < 1e-9) degenerate++;
    else if (n.y < 0) downward++;
  }
  assert.equal(downward, 0, `${downward} road triangles are wound downward and would be culled`);
  assert.equal(degenerate, 0, `${degenerate} degenerate road triangles`);
});

test('8.2 roads: carriageway never runs below the water plane', async () => {
  const { world } = await buildWorld();
  const pos = world.terrain.roadSurfaceMesh.geometry.attributes.position;
  let below = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < WATER_Y) below++;
  assert.equal(
    below,
    0,
    `${below} road vertices sit below the water surface — the road runs into the lake bed`
  );
});

test('8.2 roads: the surface tracks the rendered terrain, not the analytic field', async () => {
  const { world } = await buildWorld();
  const terrain = world.terrain.terrainMesh;
  const road = world.terrain.roadSurfaceMesh;
  const pos = road.geometry.attributes.position;

  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  let checked = 0;
  let poking = 0;
  for (let i = 0; i < pos.count; i += 5) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    ray.set(new THREE.Vector3(x, pos.getY(i) + 3, z), down);
    const hit = ray.intersectObject(terrain, false)[0];
    if (!hit) continue;
    checked++;
    // The road sits at most a few centimetres above the drawn ground.
    if (hit.point.y - pos.getY(i) > 0.06) poking++;
  }
  assert.ok(checked > 50, 'too few road samples landed on the terrain');
  assert.equal(
    poking,
    0,
    `${poking} of ${checked} road vertices have terrain poking through the asphalt`
  );
});

test('8.2 terrain: the carriageway interior is paved, not water or sand', async () => {
  const { world } = await buildWorld();
  const terrain = world.terrain;
  const geo = terrain.terrainMesh.geometry;
  const pos = geo.attributes.position;
  const col = geo.attributes.color;

  // Interior of the carriageway only: the painted edge line and aggregate
  // shoulder live past ~3 m and are meant to be light, so they are excluded.
  const lums = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    if (terrain.getRoadDistance(x, z) >= 2.4) continue;
    if (terrain.getTerrainHeight(x, z) <= WATER_Y) continue; // lake bed, not a road
    if (Math.hypot(x, z) < 30) continue; // the hub's paved head, painted separately
    const r = col.getX(i), g = col.getY(i), b = col.getZ(i);
    lums.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  assert.ok(lums.length > 500, `only ${lums.length} carriageway interior vertices`);
  lums.sort((a, b) => a - b);
  const p90 = lums[Math.floor(lums.length * 0.9)];
  const max = lums[lums.length - 1];

  // The cascade used to evaluate water and dunes before roads, so low-lying
  // carriageway picked up sand (0xdcc59a) and lagoon paint. Measured on the old
  // order: median 0.283, p90 0.308, max 0.654. With roads taking priority:
  // median 0.197, p90 0.233, max 0.267.
  assert.ok(
    p90 < 0.26,
    `carriageway p90 luminance is ${p90.toFixed(3)} — bright ground paint is bleeding onto the road`
  );
  assert.ok(
    max < 0.35,
    `brightest carriageway vertex is ${max.toFixed(3)} — a patch of sand or water paint reached the road`
  );
});

test('8.2 terrain: paved surfaces are masked from the organic ground shader', async () => {
  const { world } = await buildWorld();
  const geo = world.terrain.terrainMesh.geometry;
  const mask = geo.attributes.aPavedMask;
  assert.ok(mask, 'terrain has no aPavedMask attribute — the 8.0 ground shader will paint turf over asphalt');

  const terrain = world.terrain;
  const pos = geo.attributes.position;
  let pavedOnRoad = 0;
  let roadSamples = 0;
  for (let i = 0; i < pos.count; i++) {
    if (terrain.getRoadDistance(pos.getX(i), pos.getZ(i)) >= 3.2) continue;
    roadSamples++;
    if (mask.getX(i) > 0.9) pavedOnRoad++;
  }
  assert.ok(roadSamples > 200, 'not enough road vertices sampled');
  assert.ok(
    pavedOnRoad / roadSamples > 0.95,
    `only ${((pavedOnRoad / roadSamples) * 100).toFixed(1)} % of road vertices are flagged paved`
  );

  const material = terrain.terrainMesh.material;
  assert.ok(
    material.defines && 'CICRAFT_PAVED_MASK' in material.defines,
    'the ground-detail shader does not enable the paved mask'
  );
});

test('8.2 kerbs: every kerb strip sits on the ground it belongs to', async () => {
  const { scene, world } = await buildWorld();
  const kerb = scene.getObjectByName('Expansion_roadside_stone_essential');
  assert.ok(kerb, 'kerb batch missing');
  assert.ok(kerb.isInstancedMesh, 'kerbs are not instanced');

  const terrain = world.terrain;
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  let strips = 0;
  let floating = 0;
  let worst = 0;
  for (let i = 0; i < kerb.count; i++) {
    kerb.getMatrixAt(i, m);
    m.decompose(pos, q, scale);
    if (scale.y < 0.3) continue; // delineator posts and other thin props
    const yaw = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
    const halfLength = scale.z * 0.5 * 0.95;
    const dx = Math.sin(yaw) * halfLength;
    const dz = Math.cos(yaw) * halfLength;
    const underside = pos.y - scale.y / 2;
    const h1 = terrain.getTerrainHeight(pos.x + dx, pos.z + dz);
    const h2 = terrain.getTerrainHeight(pos.x - dx, pos.z - dz);
    const gap = Math.max(underside - h1, underside - h2);
    strips++;
    if (gap > 0.12) floating++;
    worst = Math.max(worst, gap);
  }
  assert.ok(strips > 200, `only ${strips} kerb strips found`);
  assert.equal(
    floating,
    0,
    `${floating} of ${strips} kerb strips float above the ground (worst ${worst.toFixed(2)} m)`
  );
});

test('8.2 roads: junction discs close every node where segments meet', async () => {
  const { world } = await buildWorld();
  const pos = world.terrain.roadSurfaceMesh.geometry.attributes.position;

  // Every segment endpoint must have road surface within ~1 m of it. Sample
  // every vertex: the junction disc centre is a single vertex, so stepping the
  // loop would skip it and report false gaps.
  const points = [];
  for (let i = 0; i < pos.count; i++) {
    points.push([pos.getX(i), pos.getZ(i)]);
  }
  const { layout } = await loadWorldModules();
  let uncovered = 0;
  for (const segment of layout.ISLAND_ROAD_SEGMENTS) {
    for (const [nx, nz] of [
      [segment.fromX, segment.fromZ],
      [segment.toX, segment.toZ],
    ]) {
      let min = Infinity;
      for (const [px, pz] of points) {
        const d = Math.hypot(px - nx, pz - nz);
        if (d < min) min = d;
      }
      if (min > 1.2) uncovered++;
    }
  }
  assert.equal(uncovered, 0, `${uncovered} road nodes have no junction surface within 1.2 m`);
});
