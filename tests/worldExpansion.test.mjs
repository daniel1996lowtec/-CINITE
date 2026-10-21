/**
 * CI Craft — map expansion layout/generation tests.
 *
 * These tests load the real TypeScript world modules in Node (with the same
 * strip-types approach as the bot-mode test), generate the island headlessly
 * in a Three.js Scene, and verify the handcrafted layout, collision/loot
 * safety, deterministic generation, and coarse performance budgets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadWorldModules() {
  const tmpDir = fs.mkdtempSync(path.join(ROOT_DIR, '.world-expansion-test-'));
  const emit = (source, output, replacements = []) => {
    let code = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT_DIR, source), 'utf8'));
    for (const [pattern, replacement] of replacements) {
      code = code.replace(pattern, replacement);
    }
    fs.writeFileSync(path.join(tmpDir, output), code);
  };

  try {
    emit('src/world/WorldLayout.ts', 'WorldLayout.mjs');
    emit('src/world/TerrainGenerator.ts', 'TerrainGenerator.mjs', [
      [/import\s+\{\s*TimeOfDayPreset\s*\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
      ["from './WorldLayout'", "from './WorldLayout.mjs'"],
    ]);
    emit('src/world/MapExpansionBuilder.ts', 'MapExpansionBuilder.mjs', [
      ["from './TerrainGenerator'", "from './TerrainGenerator.mjs'"],
      ["from './WorldLayout'", "from './WorldLayout.mjs'"],
    ]);
    emit('src/world/IslandWorld.ts', 'IslandWorld.mjs', [
      ["from './TerrainGenerator'", "from './TerrainGenerator.mjs'"],
      ["from './MapExpansionBuilder'", "from './MapExpansionBuilder.mjs'"],
      ["from './WorldLayout'", "from './WorldLayout.mjs'"],
      [/import\s+\{\s*BuildablePieceState,[\s\S]*?\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
    ]);

    const THREE = await import('three');
    const layout = await import(pathToFileURL(path.join(tmpDir, 'WorldLayout.mjs')).href);
    const terrainModule = await import(
      pathToFileURL(path.join(tmpDir, 'TerrainGenerator.mjs')).href
    );
    const worldModule = await import(pathToFileURL(path.join(tmpDir, 'IslandWorld.mjs')).href);
    return { THREE, layout, terrainModule, IslandWorld: worldModule.IslandWorld };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function approx(actual, expected, epsilon, message) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${message}: expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

function generateWorld(THREE, IslandWorld) {
  const scene = new THREE.Scene();
  const world = new IslandWorld(scene);
  const started = performance.now();
  world.generate();
  return { scene, world, generationMs: performance.now() - started };
}

function collectSceneStats(scene) {
  let objects = 0;
  let meshes = 0;
  let instancedMeshes = 0;
  let instances = 0;
  let triangles = 0;
  scene.traverse((object) => {
    objects++;
    if (!object.isMesh) return;
    meshes++;
    const geometry = object.geometry;
    const triCount = geometry?.index
      ? geometry.index.count / 3
      : (geometry?.attributes?.position?.count || 0) / 3;
    if (object.isInstancedMesh) {
      instancedMeshes++;
      instances += object.count;
      triangles += triCount * object.count;
    } else {
      triangles += triCount;
    }
  });
  return { objects, meshes, instancedMeshes, instances, triangles: Math.round(triangles) };
}

test('world layout: original POIs preserved, districts varied, and footprints do not overlap/block routes', async () => {
  const { layout, terrainModule } = await loadWorldModules();
  const {
    EXPANSION_BUILDINGS,
    EXPANSION_LANDMARKS,
    EXISTING_MAJOR_FOOTPRINTS,
    FOREST_CLUSTERS,
    ISLAND_SETTLEMENTS,
    footprintsOverlap,
    getBuildingFootprint,
    getLandmarkFootprint,
    getRoadDistanceToFootprint,
  } = layout;
  const { ISLAND_POIS, ISLAND_ROUTE_POINTS, TerrainGenerator } = terrainModule;

  assert.equal(ISLAND_POIS.length, 8);
  assert.deepEqual(
    ISLAND_POIS.map((poi) => poi.id),
    [
      'pipeline_plaza',
      'docker_docks',
      'kubernetes_keep',
      'git_grove',
      'server_silos',
      'mirror_lake',
      'frontend_farms',
      'legacy_ruins',
    ]
  );
  assert.equal(ISLAND_ROUTE_POINTS.length, ISLAND_POIS.length + ISLAND_SETTLEMENTS.length);
  for (const poi of ISLAND_POIS) {
    assert.equal(ISLAND_ROUTE_POINTS.filter((point) => point.id === poi.id).length, 1);
  }

  assert.ok(ISLAND_SETTLEMENTS.length >= 10, 'expected at least ten secondary settlements');
  assert.ok(EXPANSION_BUILDINGS.length >= 40, 'expected a substantial building expansion');
  assert.ok(EXPANSION_LANDMARKS.length >= 18, 'expected watchtowers/camps/ruins/docks/bridge landmarks');
  assert.ok(FOREST_CLUSTERS.length >= 8, 'expected multiple handcrafted forest clusters');

  const kinds = new Set(EXPANSION_BUILDINGS.map((building) => building.kind));
  assert.deepEqual(
    [...kinds].sort(),
    ['apartment', 'barn', 'cabin', 'garage', 'house', 'shop', 'warehouse']
  );
  assert.ok(EXPANSION_BUILDINGS.some((building) => building.floors === 2));
  assert.ok(EXPANSION_BUILDINGS.some((building) => building.roof === 'gable'));
  assert.ok(EXPANSION_BUILDINGS.some((building) => building.roof === 'shed'));

  for (const poi of ISLAND_POIS) {
    assert.ok(
      EXPANSION_BUILDINGS.filter((building) => building.districtId === poi.id).length >= 2,
      `${poi.name} should gain at least two modular buildings`
    );
  }
  for (const settlement of ISLAND_SETTLEMENTS) {
    assert.ok(
      EXPANSION_BUILDINGS.filter((building) => building.districtId === settlement.id).length >= 2,
      `${settlement.name} should contain at least two buildings`
    );
  }

  const buildingFootprints = EXPANSION_BUILDINGS.map((building) => ({
    building,
    footprint: getBuildingFootprint(building),
  }));
  const landmarkFootprints = EXPANSION_LANDMARKS.map((landmark) => ({
    landmark,
    footprint: getLandmarkFootprint(landmark),
  }));

  const overlaps = [];
  for (let i = 0; i < buildingFootprints.length; i++) {
    for (let j = i + 1; j < buildingFootprints.length; j++) {
      if (footprintsOverlap(buildingFootprints[i].footprint, buildingFootprints[j].footprint, 0.25)) {
        overlaps.push(`${buildingFootprints[i].building.id}/${buildingFootprints[j].building.id}`);
      }
    }
    for (const existing of EXISTING_MAJOR_FOOTPRINTS) {
      if (footprintsOverlap(buildingFootprints[i].footprint, existing, 0.25)) {
        overlaps.push(`${buildingFootprints[i].building.id}/existing:${existing.id}`);
      }
    }
    for (const { landmark, footprint } of landmarkFootprints) {
      if (footprintsOverlap(buildingFootprints[i].footprint, footprint, 0.25)) {
        overlaps.push(`${buildingFootprints[i].building.id}/landmark:${landmark.id}`);
      }
    }
  }
  for (const { landmark, footprint } of landmarkFootprints) {
    for (const existing of EXISTING_MAJOR_FOOTPRINTS) {
      if (footprintsOverlap(footprint, existing, 0.25)) {
        overlaps.push(`landmark:${landmark.id}/existing:${existing.id}`);
      }
    }
  }
  assert.deepEqual(overlaps, []);

  const terrain = new TerrainGenerator();
  const routeViolations = [];
  const terrainViolations = [];
  for (const { building, footprint } of buildingFootprints) {
    if (getRoadDistanceToFootprint(footprint) < 3.65) {
      routeViolations.push(`${building.id}: road`);
    }
    const corners = [
      [footprint.minX, footprint.minZ],
      [footprint.maxX, footprint.minZ],
      [footprint.maxX, footprint.maxZ],
      [footprint.minX, footprint.maxZ],
      [building.x, building.z],
    ];
    if (corners.some(([x, z]) => Math.hypot(x, z) > 226)) {
      terrainViolations.push(`${building.id}: outside island`);
    }
    if (corners.some(([x, z]) => terrain.getRiverDistance(x, z) < 6.4)) {
      terrainViolations.push(`${building.id}: river channel`);
    }
    if (Math.hypot(building.x + 46, building.z - 38) < 29) {
      terrainViolations.push(`${building.id}: Mirror Lake basin`);
    }
    const heights = corners.map(([x, z]) => terrain.getTerrainHeight(x, z));
    if (Math.max(...heights) - Math.min(...heights) > 1.65) {
      terrainViolations.push(`${building.id}: excessive footprint height range`);
    }
    if (Math.min(...heights) < 0.55) {
      terrainViolations.push(`${building.id}: footprint below safe ground`);
    }
  }
  assert.deepEqual(routeViolations, []);
  assert.deepEqual(terrainViolations, []);
});

test('generated world: deterministic expansion, safe loot/props, and performance budgets', async () => {
  const { THREE, layout, IslandWorld } = await loadWorldModules();
  const first = generateWorld(THREE, IslandWorld);
  const second = generateWorld(THREE, IslandWorld);
  const world = first.world;

  const serializePoint = (point) => [point.x, point.y, point.z].map((v) => v.toFixed(3)).join(',');
  assert.deepEqual(
    world.chestSpawnPoints.map(serializePoint),
    second.world.chestSpawnPoints.map(serializePoint)
  );
  assert.deepEqual(
    world.lootSpawnPoints.map(serializePoint),
    second.world.lootSpawnPoints.map(serializePoint)
  );
  assert.deepEqual(
    [...world.destructibles.values()].map((prop) => `${prop.id}:${prop.type}:${serializePoint(prop.position)}`),
    [...second.world.destructibles.values()].map(
      (prop) => `${prop.id}:${prop.type}:${serializePoint(prop.position)}`
    )
  );

  const stats = collectSceneStats(first.scene);
  const destructibleCounts = {};
  for (const prop of world.destructibles.values()) {
    destructibleCounts[prop.type] = (destructibleCounts[prop.type] || 0) + 1;
  }

  assert.ok(destructibleCounts.tree >= 230, `expected at least 230 harvestable trees, got ${destructibleCounts.tree}`);
  assert.ok(destructibleCounts.rock >= 60, `expected at least 60 harvestable rocks, got ${destructibleCounts.rock}`);
  assert.ok(world.chestSpawnPoints.length >= 40, `expected at least 40 chests, got ${world.chestSpawnPoints.length}`);
  assert.ok(world.lootSpawnPoints.length >= 85, `expected at least 85 ground-loot points, got ${world.lootSpawnPoints.length}`);
  assert.ok(stats.instancedMeshes >= 25, `expected instanced architecture/foliage, got ${stats.instancedMeshes}`);
  assert.ok(stats.meshes <= 900, `mesh budget exceeded: ${stats.meshes}`);
  assert.ok(stats.triangles <= 300000, `triangle budget exceeded: ${stats.triangles}`);
  assert.ok(first.generationMs < 6000, `world generation too slow: ${first.generationMs}ms`);
  assert.ok(
    world.boxColliders.length + world.cylinderColliders.length <= 1200,
    'collider budget exceeded'
  );

  const lootViolations = [];
  const allLoot = [
    ...world.chestSpawnPoints.map((point) => ({ type: 'chest', point })),
    ...world.lootSpawnPoints.map((point) => ({ type: 'loot', point })),
  ];
  for (const { type, point } of allLoot) {
    const box = world.boxColliders.find(
      (collider) =>
        point.x > collider.minX &&
        point.x < collider.maxX &&
        point.z > collider.minZ &&
        point.z < collider.maxZ &&
        point.y > collider.minY &&
        point.y < collider.maxY
    );
    if (box) lootViolations.push(`${type} inside box ${box.id} at ${serializePoint(point)}`);

    const cylinder = world.cylinderColliders.find((collider) => {
      const dist = Math.hypot(point.x - collider.x, point.z - collider.z);
      return dist < collider.radius + 0.15 && point.y > collider.minY && point.y < collider.maxY;
    });
    if (cylinder) {
      lootViolations.push(`${type} inside cylinder ${cylinder.id} at ${serializePoint(point)}`);
    }

    const ground = world.getGroundHeightAt(point.x, point.y + 0.05, point.z);
    if (ground > point.y + 0.18) {
      lootViolations.push(`${type} below walkable ground at ${serializePoint(point)} ground=${ground.toFixed(2)}`);
    }
    if (Math.hypot(point.x, point.z) > world.terrain.islandRadius + 2) {
      lootViolations.push(`${type} outside island at ${serializePoint(point)}`);
    }
  }
  assert.deepEqual(lootViolations, []);

  const expansionFootprints = layout.EXPANSION_BUILDINGS.map((building) => ({
    building,
    footprint: layout.getBuildingFootprint(building),
  }));
  const propViolations = [];
  for (const prop of world.destructibles.values()) {
    if (prop.type !== 'tree' && prop.type !== 'rock' && prop.type !== 'crate') continue;
    const containingBuilding = expansionFootprints.find(({ footprint }) =>
      layout.isPointInFootprint(prop.position.x, prop.position.z, footprint, 0.3)
    );
    if (containingBuilding) {
      propViolations.push(
        `${prop.id} inside expansion building ${containingBuilding.building.id} at ${serializePoint(prop.position)}`
      );
    }
    if (prop.type === 'tree' && world.terrain.getRoadDistance(prop.position.x, prop.position.z) < 3.8) {
      propViolations.push(`${prop.id} on road`);
    }
    if (prop.position.y < world.terrain.getTerrainHeight(prop.position.x, prop.position.z) - 0.25) {
      propViolations.push(`${prop.id} below terrain`);
    }
  }
  assert.deepEqual(propViolations, []);

  const benchmark = (iterations, fn) => {
    const started = performance.now();
    for (let i = 0; i < iterations; i++) fn(i);
    return performance.now() - started;
  };
  const resolveMs = benchmark(3000, (i) =>
    world.resolveHorizontalCollision(Math.sin(i) * 150, 5, Math.cos(i * 1.3) * 150, 0.48)
  );
  const groundMs = benchmark(3000, (i) =>
    world.getGroundHeightAt(Math.sin(i) * 150, 6, Math.cos(i * 1.3) * 150)
  );
  assert.ok(resolveMs < 1800, `3000 collision resolves too slow: ${resolveMs}ms`);
  assert.ok(groundMs < 1800, `3000 ground queries too slow: ${groundMs}ms`);
});

test('generated world: doors, floors, roofs, watchtower and bridge are navigable/collidable', async () => {
  const { THREE, layout, IslandWorld } = await loadWorldModules();
  const { world } = generateWorld(THREE, IslandWorld);

  const doorFailures = [];
  for (const building of layout.EXPANSION_BUILDINGS) {
    const outside = layout.buildingLocalToWorld(building, 0, building.depth / 2 + 4);
    const inside = layout.buildingLocalToWorld(building, 0, building.depth / 2 - 2.3);
    let x = outside.x;
    let z = outside.z;
    let y = world.terrain.getTerrainHeight(x, z);
    for (let step = 1; step <= 48; step++) {
      const targetX = outside.x + ((inside.x - outside.x) * step) / 48;
      const targetZ = outside.z + ((inside.z - outside.z) * step) / 48;
      const resolved = world.resolveHorizontalCollision(targetX, y, targetZ, 0.48);
      x = resolved.x;
      z = resolved.z;
      y = world.getGroundHeightAt(x, y + 1.25, z);
    }
    const error = Math.hypot(x - inside.x, z - inside.z);
    if (error > 0.95) doorFailures.push(`${building.id}: ${error.toFixed(2)}m short`);
  }
  assert.deepEqual(doorFailures, []);

  for (const building of layout.EXPANSION_BUILDINGS) {
    const baseY = world.terrain.getTerrainHeight(building.x, building.z);
    const interiorGround = world.getGroundHeightAt(building.x, baseY + 1.1, building.z);
    approx(interiorGround, baseY + 0.36, 0.08, `${building.id} interior floor`);

    const wallPoint = layout.buildingLocalToWorld(building, -building.width / 2 + 0.08, 0);
    const resolvedWall = world.resolveHorizontalCollision(wallPoint.x, baseY + 0.36, wallPoint.z, 0.48);
    assert.ok(
      Math.hypot(resolvedWall.x - wallPoint.x, resolvedWall.z - wallPoint.z) > 0.18,
      `${building.id} side wall should push the player out`
    );
  }

  const apartment = layout.EXPANSION_BUILDINGS.find((building) => building.id === 'plaza_apartments');
  assert.ok(apartment);
  const apartmentBase = world.terrain.getTerrainHeight(apartment.x, apartment.z);
  const upperPoint = layout.buildingLocalToWorld(apartment, 2.0, -2.0);
  approx(
    world.getGroundHeightAt(upperPoint.x, apartmentBase + 4.4, upperPoint.z),
    apartmentBase + 3.62,
    0.08,
    'apartment second floor'
  );
  const balconyPoint = layout.buildingLocalToWorld(apartment, 0, apartment.depth / 2 + 1.2);
  approx(
    world.getGroundHeightAt(balconyPoint.x, apartmentBase + 4.4, balconyPoint.z),
    apartmentBase + 3.62,
    0.08,
    'apartment balcony'
  );

  const roofBuilding = layout.EXPANSION_BUILDINGS.find((building) => building.id === 'plaza_market');
  assert.ok(roofBuilding);
  const roofBase = world.terrain.getTerrainHeight(roofBuilding.x, roofBuilding.z);
  const rampTop = layout.buildingLocalToWorld(
    roofBuilding,
    roofBuilding.width / 2 + 1.55,
    -roofBuilding.depth / 2 - 0.08
  );
  approx(
    world.getGroundHeightAt(rampTop.x, roofBase + roofBuilding.height + 1.0, rampTop.z),
    roofBase + roofBuilding.height + 0.34,
    0.12,
    'exterior roof ramp top'
  );

  const rayOriginPoint = layout.buildingLocalToWorld(roofBuilding, -roofBuilding.width / 2 - 4, 0);
  const rayOrigin = new THREE.Vector3(rayOriginPoint.x, roofBase + 1.7, rayOriginPoint.z);
  const rayDirection = new THREE.Vector3(
    roofBuilding.x - rayOrigin.x,
    0,
    roofBuilding.z - rayOrigin.z
  ).normalize();
  const wallHit = world.raycastWorld(rayOrigin, rayDirection, 8);
  assert.ok(wallHit && wallHit.distance < 4.4, 'building wall should block a weapon ray');

  const tower = layout.EXPANSION_LANDMARKS.find((landmark) => landmark.id === 'westlook_watchtower');
  assert.ok(tower);
  const towerBase = world.terrain.getTerrainHeight(tower.x, tower.z);
  approx(
    world.getGroundHeightAt(tower.x, towerBase + 7.2, tower.z),
    towerBase + 6.34,
    0.08,
    'watchtower platform'
  );

  const bridgeZ = 108;
  const t = (bridgeZ - 38) / (215 - 38);
  const bridgeX = -46 + t * 52 + Math.sin(t * Math.PI * 2.2) * 12;
  approx(world.getGroundHeightAt(bridgeX, 3.1, bridgeZ), 2.12, 0.08, 'middle river bridge deck');
});
