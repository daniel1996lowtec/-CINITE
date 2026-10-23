/**
 * CI CRAFT 9.0 — road network regression tests.
 *
 * These exist because the 8.2/8.3 road builder passed every test it had while
 * being visually broken. Its tests only ever looked at the vertices it emitted,
 * never at the surface those vertices produce. A two-vertex-wide strip can have
 * perfect winding, valid indices and a 3.5 cm gap to the terrain at every vertex
 * and still let the ground burst through the middle of the carriageway, because
 * the defect lives *between* the samples.
 *
 * So the tests here measure the drawn surface: they cast rays at the mesh, walk
 * along centrelines asking whether a road is actually there, and check that the
 * ground never rises above the asphalt by more than a documented tolerance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadWorldModules } from '../scripts/headlessWorld.mjs';

const WATER_Y = -0.28;
/** Vertical lift the builder applies above the drawn terrain. */
const LIFT = 0.045;
/** Hard ceiling the world is built to. */
const WORLD_HALF = 270;

let cached = null;
async function world() {
  if (cached) return cached;
  const { IslandWorld, layout } = await loadWorldModules();
  const scene = new THREE.Scene();
  const instance = new IslandWorld(scene);
  instance.generate();
  scene.updateMatrixWorld(true);
  cached = { scene, instance, layout };
  return cached;
}

const roadOf = (instance) => {
  const road = instance.terrain.roadSurfaceMesh;
  assert.ok(road, 'no road surface mesh was generated');
  assert.ok(road.geometry.index, 'road surface is not indexed');
  return road;
};

test('9.0 roads: geometry is finite, indexed and inside the world', async () => {
  const { instance } = await world();
  const road = roadOf(instance);
  const pos = road.geometry.attributes.position;
  const index = road.geometry.index;

  assert.ok(pos.count > 1000, `only ${pos.count} road vertices`);
  assert.ok(index.count / 3 > 800, `only ${index.count / 3} road triangles`);

  for (let i = 0; i < pos.array.length; i++) {
    assert.ok(Number.isFinite(pos.array[i]), `non-finite road coordinate at ${i}`);
  }
  for (let i = 0; i < index.count; i++) {
    const v = index.getX(i);
    assert.ok(v >= 0 && v < pos.count, `index ${v} out of range (count ${pos.count})`);
  }
  const box = new THREE.Box3().setFromObject(road);
  assert.ok(
    Math.abs(box.min.x) < WORLD_HALF && Math.abs(box.max.x) < WORLD_HALF &&
      Math.abs(box.min.z) < WORLD_HALF && Math.abs(box.max.z) < WORLD_HALF,
    `road leaves the world: ${JSON.stringify([box.min.x, box.max.x, box.min.z, box.max.z])}`
  );
});

test('9.0 roads: every triangle faces up and none is degenerate or stretched', async () => {
  const { instance } = await world();
  const pos = roadOf(instance).geometry.attributes.position;
  const index = roadOf(instance).geometry.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  let downward = 0, degenerate = 0, longest = 0;

  for (let t = 0; t < index.count / 3; t++) {
    a.fromBufferAttribute(pos, index.getX(t * 3));
    b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
    c.fromBufferAttribute(pos, index.getX(t * 3 + 2));
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    const normal = new THREE.Vector3().crossVectors(ab, ac);
    if (normal.length() < 1e-9) degenerate++;
    else if (normal.y < 0) downward++;
    longest = Math.max(longest, a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
  }

  assert.equal(downward, 0, `${downward} road triangles are wound downward and would be culled`);
  assert.equal(degenerate, 0, `${degenerate} degenerate road triangles`);
  // Cross-sections are 2 m apart and 0.42 m laterally: nothing can legally
  // exceed a few metres. A stretched triangle means a broken index.
  assert.ok(longest < 8, `longest road triangle edge is ${longest.toFixed(2)} m — stretched geometry`);
});

test('9.0 roads: the surface conforms to the ground across its full width', async () => {
  const { instance } = await world();
  const terrain = instance.terrain;
  const road = roadOf(instance);
  const pos = road.geometry.attributes.position;

  // Measured per vertex, so a coarse cross-section cannot hide a chord.
  const clearances = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const onDeck =  (terrain.roadWalkables ?? []).some((deck) => {
      if (x < deck.minX || x > deck.maxX || z < deck.minZ || z > deck.maxZ) return false;
      const h = deck.getHeight(x, z);
      return h > -1e5 && Math.abs(h - y) < 3;
    });
    if (onDeck) continue;
    clearances.push(y - terrain.getRenderedTerrainHeight(x, z));
  }

  clearances.sort((p, q) => p - q);
  assert.ok(clearances.length > 1000, `only ${clearances.length} off-deck vertices`);
  const median = clearances[Math.floor(clearances.length * 0.5)];
  const p99 = clearances[Math.floor(clearances.length * 0.99)];

  assert.ok(
    median >= LIFT - 0.01 && median <= LIFT + 0.02,
    `median road clearance is ${median.toFixed(3)} m, expected ~${LIFT} m — the surface is not sitting on the ground`
  );
  assert.ok(
    p99 <= 0.10,
    `99th-percentile clearance is ${p99.toFixed(3)} m — the road is floating off the terrain`
  );
  const floating = clearances.filter((d) => d > 0.5).length;
  assert.ok(
    floating / clearances.length < 0.01,
    `${floating} of ${clearances.length} off-deck vertices float more than 0.5 m`
  );
});

test('9.0 roads: the ground does not burst through the asphalt', async () => {
  const { instance } = await world();
  const terrain = instance.terrain;
  const road = roadOf(instance);
  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const box = new THREE.Box3().setFromObject(road);

  let sampled = 0, poked = 0, worst = 0;
  for (let x = box.min.x; x < box.max.x; x += 2.6) {
    for (let z = box.min.z; z < box.max.z; z += 2.6) {
      raycaster.set(new THREE.Vector3(x, 120, z), down);
      const onRoad = raycaster.intersectObject(road, false)[0];
      if (!onRoad) continue;
      const onTerrain = raycaster.intersectObject(terrain.terrainMesh, false)[0];
      if (!onTerrain) continue;
      sampled++;
      const through = onTerrain.point.y - onRoad.point.y;
      if (through > 0.005) poked++;
      worst = Math.max(worst, through);
    }
  }

  assert.ok(sampled > 1000, `only ${sampled} ray samples hit both surfaces`);
  // Before 9.0 this was 14.6 % of cross-sections with a 0.947 m maximum,
  // because the road was a two-vertex strip. What survives is confined to
  // near-vertical cliff edges where no conforming surface can help.
  assert.ok(
    poked / sampled < 0.02,
    `${poked} of ${sampled} samples (${((poked / sampled) * 100).toFixed(1)} %) have terrain above the asphalt`
  );
  assert.ok(worst < 0.8, `worst poke-through is ${worst.toFixed(2)} m`);
});

test('9.0 roads: the network is continuous along every segment', async () => {
  const { instance, layout } = await world();
  const road = roadOf(instance);
  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const gaps = [];

  for (const segment of layout.ISLAND_ROAD_SEGMENTS) {
    const dx = segment.toX - segment.fromX;
    const dz = segment.toZ - segment.fromZ;
    const length = Math.hypot(dx, dz);
    if (length < 4) continue;
    const dirX = dx / length;
    const dirZ = dz / length;
    // Stay clear of the junction discs at each end: those are covered by the
    // junction test, and the ribbons are trimmed to meet them.
    const trim = Math.min(4.1, length * 0.4);
    for (let along = trim; along <= length - trim; along += 1.5) {
      const x = segment.fromX + dirX * along;
      const z = segment.fromZ + dirZ * along;
      raycaster.set(new THREE.Vector3(x, 120, z), down);
      const hit = raycaster.intersectObject(road, false)[0];
      if (!hit) {
        gaps.push(`${segment.id} @ ${along.toFixed(1)} m`);
      }
    }
  }

  assert.deepEqual(gaps.slice(0, 8), [], `${gaps.length} points along a road centreline have no road surface`);
});

test('9.0 roads: every junction node is closed by a paved disc', async () => {
  const { instance, layout } = await world();
  const road = roadOf(instance);
  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const open = [];

  const nodes = new Map();
  for (const segment of layout.ISLAND_ROAD_SEGMENTS) {
    nodes.set(`${segment.fromX},${segment.fromZ}`, [segment.fromX, segment.fromZ]);
    nodes.set(`${segment.toX},${segment.toZ}`, [segment.toX, segment.toZ]);
  }

  for (const [x, z] of nodes.values()) {
    // Sample the junction footprint, not just its centre: a disc that is too
    // small still passes a single centre-point test.
    for (const [ox, oz] of [[0, 0], [2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]]) {
      raycaster.set(new THREE.Vector3(x + ox, 120, z + oz), down);
      if (!raycaster.intersectObject(road, false)[0]) open.push(`(${x},${z}) offset ${ox},${oz}`);
    }
  }

  assert.deepEqual(open.slice(0, 8), [], `${open.length} junction samples have no road surface`);
});

test('9.0 roads: no road surface sits below the water plane', async () => {
  const { instance } = await world();
  const pos = roadOf(instance).geometry.attributes.position;
  let below = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < WATER_Y) below++;
  assert.equal(below, 0, `${below} road vertices are under the water surface`);
});

test('9.0 roads: water is only spanned where the road actually crosses it', async () => {
  const { instance, layout } = await world();
  const terrain = instance.terrain;

  // Measure the true wet length of each segment, not just "touches water".
  // A short notch (a stream crossing at a shallow angle) is handled by the
  // water floor on the surface itself and needs no bridge. A real crossing does.
  const MIN_SPAN_FOR_DECK = 2;
  const wet = new Map();
  for (const segment of layout.ISLAND_ROAD_SEGMENTS) {
    const length = Math.hypot(segment.toX - segment.fromX, segment.toZ - segment.fromZ);
    let wetLength = 0;
    for (let along = 0; along <= length; along += 0.25) {
      const f = along / length;
      const x = segment.fromX + (segment.toX - segment.fromX) * f;
      const z = segment.fromZ + (segment.toZ - segment.fromZ) * f;
      if (terrain.getRenderedTerrainHeight(x, z) < WATER_Y) wetLength += 0.25;
    }
    if (wetLength > 0) wet.set(segment.id, wetLength);
  }

  for (const [id, wetLength] of wet) {
    const hasDeck =  (terrain.roadWalkables ?? []).some((deck) => deck.id === `road_deck_${id}`);
    if (wetLength >= MIN_SPAN_FOR_DECK) {
      assert.ok(
        hasDeck,
        `${id} is under water for ${wetLength.toFixed(1)} m but has no bridge deck`
      );
    }
  }

  // The 8.2 regression was the opposite: bridge furniture along 126 m of flat
  // road because a deck-height floor was applied to every vertex on the map.
  // A deck may only exist where its own road is genuinely under water.
  for (const deck of terrain.roadWalkables ?? []) {
    const id = deck.id.replace('road_deck_', '');
    assert.ok(wet.has(id), `deck exists for ${id}, which never crosses water`);
  }

  assert.ok(
    [...wet.entries()].some(([, len]) => len >= 10),
    'no substantial water crossing found — expected the Mirror Lake causeway'
  );
});

test('9.0 roads: bridge decks are walkable, and only on the deck', async () => {
  const { instance } = await world();
  const terrain = instance.terrain;
  assert.ok( (terrain.roadWalkables ?? []).length > 0, 'no bridge decks were registered');

  for (const deck of terrain.roadWalkables ?? []) {
    // Sample where the deck is actually needed: a point over ground below it.
    // The AABB centre can sit on the bank, above the deck, which proves nothing.
    let spanPoint = null;
    for (let x = deck.minX; x <= deck.maxX && !spanPoint; x += 2) {
      for (let z = deck.minZ; z <= deck.maxZ; z += 2) {
        const h = deck.getHeight(x, z);
        if (h < -1e5) continue;
        if (terrain.getTerrainHeight(x, z) < h - 0.5) { spanPoint = { x, z, h }; break; }
      }
    }
    assert.ok(spanPoint, `${deck.id} spans no ground clearance — it is not a real deck`);

    const ground = terrain.getTerrainHeight(spanPoint.x, spanPoint.z);
    const walkY = instance.getGroundHeightAt(spanPoint.x, spanPoint.h + 1.0, spanPoint.z, 3, 0.3);

    // Before 9.0 nothing registered the deck, so the solver returned the lake
    // bed and the player walked ~2.3 m underneath the visible bridge.
    assert.ok(
      walkY >= spanPoint.h - 0.05,
      `${deck.id}: walk height ${walkY.toFixed(2)} is below the deck surface ${spanPoint.h.toFixed(2)}`
    );
    assert.ok(
      walkY > ground + 0.5,
      `${deck.id}: walk height ${walkY.toFixed(2)} is not above the ground ${ground.toFixed(2)} it spans`
    );

    // Outside the deck ribbon the surface must not lift anything: the AABB
    // corners are over open water and must not become invisible platforms.
    assert.ok(
      deck.getHeight(deck.minX + 0.01, deck.minZ + 0.01) < WATER_Y,
      `${deck.id} reports a walkable height off its own ribbon`
    );
  }
});

test('9.0 roads: exactly one road mesh exists, so nothing renders underneath', async () => {
  const { scene } = await world();
  const names = [];
  scene.traverse((object) => {
    if (object.isMesh && /^(RoadSurface|RoadBridgeStructure|CiCraftRoadSurface)$/.test(object.name)) {
      names.push(object.name);
    }
  });
  assert.equal(
    names.filter((n) => n === 'RoadSurface').length,
    1,
    `expected one RoadSurface, found ${names.filter((n) => n === 'RoadSurface').length}`
  );
  assert.ok(
    names.filter((n) => n === 'RoadBridgeStructure').length <= 1,
    'more than one bridge structure mesh'
  );
});

test('9.0 roads: building twice produces identical geometry, no shared state', async () => {
  const { buildRoadNetwork } = await loadWorldModules();
  const { layout, instance } = await world();
  const terrain = instance.terrain;

  const a = buildRoadNetwork(layout.ISLAND_ROAD_SEGMENTS, terrain, WATER_Y);
  const b = buildRoadNetwork(layout.ISLAND_ROAD_SEGMENTS, terrain, WATER_Y);

  const pa = a.surface.geometry.attributes.position.array;
  const pb = b.surface.geometry.attributes.position.array;
  assert.equal(pa.length, pb.length, 'rebuilding changed the vertex count');
  for (let i = 0; i < pa.length; i += 97) {
    assert.equal(pa[i], pb[i], `rebuilding produced different geometry at ${i}`);
  }
  assert.equal(a.stats.triangles, b.stats.triangles);
  assert.notEqual(a.surface.uuid, b.surface.uuid, 'two builds share one mesh');
  assert.notEqual(a.surface.geometry, b.surface.geometry, 'two builds share one geometry');

  a.surface.geometry.dispose();
  a.surface.material.dispose();
  b.surface.geometry.dispose();
  b.surface.material.dispose();
});

test('9.0 roads: the rest of the world is untouched', async () => {
  const { instance, scene } = await world();
  let meshes = 0;
  scene.traverse((object) => { if (object.isMesh) meshes++; });
  assert.ok(meshes > 500, `only ${meshes} meshes — the world did not build`);

  // Colliders are gameplay surface area. The road system adds none.
  const colliders = instance.boxColliders.length + instance.cylinderColliders.length;
  assert.equal(colliders, 1414, `collider count changed to ${colliders}`);
});
