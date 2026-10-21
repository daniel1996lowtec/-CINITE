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
    world.boxColliders.length + world.cylinderColliders.length <= 1220,
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

test('legendary tower: exact centre, climbable floors/decks, solid walls, and safe fixed loot', async () => {
  const { THREE, layout, terrainModule, IslandWorld } = await loadWorldModules();
  const { scene, world } = generateWorld(THREE, IslandWorld);
  const {
    LEGENDARY_TOWER,
    LEGENDARY_TOWER_FLOOR_LOOT,
    LEGENDARY_TOWER_VAULT_LOOT,
    EXISTING_MAJOR_FOOTPRINTS,
    getLegendaryTowerFloorHeight,
  } = layout;

  assert.deepEqual([LEGENDARY_TOWER.x, LEGENDARY_TOWER.z], [0, 0]);
  const centrePoi = terrainModule.ISLAND_POIS.find((poi) => poi.id === 'pipeline_plaza');
  assert.equal(centrePoi.name, 'Legendary Tower');
  assert.deepEqual([centrePoi.x, centrePoi.z], [0, 0]);
  approx(world.legendaryTowerBaseY, 4.5, 0.001, 'tower terrain pad');
  approx(
    world.legendaryTowerRoofY,
    getLegendaryTowerFloorHeight(world.legendaryTowerBaseY, LEGENDARY_TOWER.roofLevel),
    0.001,
    'tower roof height'
  );
  assert.equal(
    EXISTING_MAJOR_FOOTPRINTS.filter((zone) => zone.id.startsWith('legendary_tower')).length,
    5,
    'tower should use a cross-shaped protected footprint around the original plaza houses'
  );

  const towerWalkables = world.walkableSurfaces.filter((surface) =>
    String(surface.id || '').startsWith('legendary_tower')
  );
  const towerColliders = world.boxColliders.filter((collider) =>
    collider.id.startsWith('legendary_tower')
  );
  assert.ok(towerWalkables.length >= 30, `expected tower floors/ramps/decks, got ${towerWalkables.length}`);
  assert.ok(towerColliders.length >= 25, `expected coarse tower wall colliders, got ${towerColliders.length}`);
  assert.ok(scene.getObjectByName('LegendaryTowerBeaconFx'), 'vault beacon group missing');
  assert.ok(scene.getObjectByName('LegendaryTowerVaultParticles'), 'vault particles missing');
  assert.ok(scene.getObjectByName('LegendaryTowerVaultLight'), 'vault light missing');

  // The golden beacon is a map-wide landmark, not a short-range effect: a
  // tall column, exempt from distance fog and frustum culling on all tiers.
  const beaconBeam = scene.getObjectByName('LegendaryTowerBeaconBeam');
  assert.ok(beaconBeam, 'golden beacon beam missing');
  assert.ok(
    beaconBeam.geometry.parameters.height >= 60,
    `beacon beam should rise at least 60m above the roof, got ${beaconBeam.geometry.parameters.height}`
  );
  assert.equal(beaconBeam.material.fog, false, 'beacon beam must ignore distance fog');
  assert.equal(beaconBeam.frustumCulled, false, 'beacon beam must not be frustum-culled');
  const energyBeam = scene.getObjectByName('LegendaryTowerEnergyBeam');
  assert.equal(energyBeam.material.fog, false, 'energy beam must ignore distance fog');
  assert.equal(energyBeam.frustumCulled, false, 'energy beam must not be frustum-culled');

  const floorY = (level) =>
    getLegendaryTowerFloorHeight(world.legendaryTowerBaseY, level);
  const floorSamples = [
    [-4, 4],
    [-4, 4],
    [4, 4],
    [4, -4],
    [-4, -4],
    [-4, 4],
    [4, 4],
    [8, 0],
  ];
  floorSamples.forEach(([x, z], level) => {
    approx(
      world.getGroundHeightAt(x, floorY(level) + 1.0, z),
      floorY(level),
      0.08,
      `tower floor ${level}`
    );
  });

  const walkPath = (points, startY) => {
    let x = points[0][0];
    let z = points[0][1];
    let y = startY;
    let maxDrop = 0;
    let maxDropAt = '';
    const checkpoints = [];
    for (let i = 1; i < points.length; i++) {
      const [targetX, targetZ] = points[i];
      const distance = Math.hypot(targetX - x, targetZ - z);
      const steps = Math.max(1, Math.ceil(distance / 0.22));
      const startX = x;
      const startZ = z;
      for (let step = 1; step <= steps; step++) {
        const resolved = world.resolveHorizontalCollision(
          startX + ((targetX - startX) * step) / steps,
          y,
          startZ + ((targetZ - startZ) * step) / steps,
          0.48
        );
        x = resolved.x;
        z = resolved.z;
        // Match PlayerController's ground query (current feet height), so
        // an overhead slab is not mistaken for the ramp under the player.
        const nextY = world.getGroundHeightAt(x, y, z);
        if (y - nextY > maxDrop) {
          maxDrop = y - nextY;
          maxDropAt = `segment ${i} step ${step}/${steps} at ${x.toFixed(2)},${z.toFixed(2)} ${y.toFixed(2)}->${nextY.toFixed(2)}`;
        }
        y = nextY;
      }
      checkpoints.push(
        `${i}:${x.toFixed(2)},${z.toFixed(2)}@${y.toFixed(2)}`
      );
    }
    return { x, y, z, maxDrop, maxDropAt, checkpoints };
  };

  // Four independent ground entrances.
  for (const [outside, inside] of [
    [[0, 17], [0, 7.5]],
    [[0, -17], [0, -7.5]],
    [[17, 0], [7.5, 0]],
    [[-17, 0], [-7.5, 0]],
  ]) {
    const result = walkPath([outside, inside], world.terrain.getTerrainHeight(outside[0], outside[1]));
    assert.ok(Math.hypot(result.x - inside[0], result.z - inside[1]) < 0.9, `entrance ${outside} blocked`);
    approx(result.y, floorY(0), 0.12, `entrance ${outside} floor`);
  }

  // Full interior square-spiral: east → north → west → south, twice, then
  // east/north/west to the roof and across the vault dais.
  const interior = walkPath(
    [
      [0, 17],
      [0, 8],
      [8.7, 8.6],
      [8.7, -8.6],
      [-8.6, -8.7],
      [-8.7, 8.6],
      [8.6, 8.7],
      [8.7, -8.6],
      [-8.6, -8.7],
      [-8.7, 8.6],
      [-5, 8.6],
      [0, 6.5],
      [0, 3.4],
    ],
    world.terrain.getTerrainHeight(0, 17)
  );
  assert.ok(Math.hypot(interior.x, interior.z - 3.4) < 0.9, 'interior climb did not reach vault');
  approx(interior.y, floorY(7) + 0.5, 0.12, 'interior climb roof dais');
  assert.ok(interior.maxDrop < 1.0, `interior climb contains a ${interior.maxDrop.toFixed(2)}m support drop (${interior.maxDropAt})`);

  // Exterior two-floor spiral and west roof landing.
  const exterior = walkPath(
    [
      [-8.6, 13.05],
      [8.6, 13.05],
      [12.85, 12.85],
      [13.05, 8.6],
      [13.05, -8.6],
      [12.85, -12.85],
      [8.6, -13.05],
      [-8.6, -13.05],
      [-12.85, -12.85],
      [-13.05, -8.6],
      [-13.05, 8.6],
      [-12.85, 7.3],
      [-12.85, 0],
      [-8, 0],
      [-5, 2],
      [0, 3.4],
    ],
    world.terrain.getTerrainHeight(-8.6, 13.05)
  );
  assert.ok(
    Math.hypot(exterior.x, exterior.z - 3.4) < 0.9,
    `exterior climb did not reach vault (${exterior.checkpoints.join(' | ')})`
  );
  assert.ok(
    Math.abs(exterior.y - (floorY(7) + 0.5)) <= 0.12,
    `exterior climb roof dais: got ${exterior.y.toFixed(2)} (${exterior.checkpoints.join(' | ')})`
  );
  assert.ok(exterior.maxDrop < 1.0, `exterior climb contains a ${exterior.maxDrop.toFixed(2)}m support drop (${exterior.maxDropAt})`);

  // Explicit skybridges join the level-1 south balcony to both original
  // southern plaza rooftops. The south-east route is bidirectional from
  // that house roof through the south balcony door; the south-west bridge
  // midpoint is continuously supported above the plaza.
  const southeastRoofY = world.terrain.getTerrainHeight(18, 16) + 4.92;
  const southwestRoofY = world.terrain.getTerrainHeight(-18, 16) + 4.72;
  approx(
    world.getGroundHeightAt(9.525, floorY(1) + 1, 13),
    (southeastRoofY + floorY(1)) / 2,
    0.08,
    'south-east skybridge midpoint'
  );
  approx(
    world.getGroundHeightAt(-9.775, floorY(1) + 1, 13),
    (southwestRoofY + floorY(1)) / 2,
    0.08,
    'south-west skybridge midpoint'
  );
  const skybridge = walkPath(
    [
      [18, 16],
      [12.3, 13],
      [6.7, 13],
      [0, 12.85],
      [0, 8],
    ],
    southeastRoofY
  );
  assert.ok(
    Math.hypot(skybridge.x, skybridge.z - 8) < 0.9,
    `south-east skybridge did not reach the tower balcony door (${skybridge.checkpoints.join(' | ')})`
  );
  approx(skybridge.y, floorY(1), 0.12, 'south-east skybridge tower floor');
  assert.ok(
    skybridge.maxDrop < 1.0,
    `south-east skybridge contains a ${skybridge.maxDrop.toFixed(2)}m support drop (${skybridge.maxDropAt})`
  );
  const southwestBridge = walkPath(
    [
      [-12.5, 13],
      [-6.7, 13],
      [0, 12.85],
    ],
    world.getGroundHeightAt(-12.5, floorY(1) + 1, 13)
  );
  approx(southwestBridge.y, floorY(1), 0.12, 'south-west skybridge tower deck');
  assert.ok(
    southwestBridge.maxDrop < 1.0,
    `south-west skybridge contains a ${southwestBridge.maxDrop.toFixed(2)}m support drop (${southwestBridge.maxDropAt})`
  );
  for (const supportX of [9.525, -9.775]) {
    const sampleX = supportX + 0.18;
    const resolved = world.resolveHorizontalCollision(
      sampleX,
      world.terrain.getTerrainHeight(supportX, 13),
      13,
      0.48
    );
    assert.ok(
      Math.hypot(resolved.x - sampleX, resolved.z - 13) > 0.3,
      `skybridge support at ${supportX},13 is not solid`
    );
  }

  // Balcony/deck and skydiver-canopy support samples.
  approx(world.getGroundHeightAt(0, floorY(1) + 1, 12.85), floorY(1), 0.08, 'south L1 deck');
  approx(world.getGroundHeightAt(12.85, floorY(2) + 1, 12.85), floorY(2), 0.08, 'south-east L2 deck corner');
  approx(world.getGroundHeightAt(12.85, floorY(4) + 1, -12.85), floorY(4), 0.08, 'east-north L4 deck corner');
  approx(world.getGroundHeightAt(-12.85, floorY(6) + 1, -12.85), floorY(6), 0.08, 'north-west L6 deck corner');
  approx(world.getGroundHeightAt(-12.85, floorY(7) + 1, 7.3), floorY(7), 0.08, 'west roof landing');
  approx(world.getGroundHeightAt(0, floorY(7) + 7, 0), floorY(7) + 5.93, 0.08, 'vault canopy top');

  // Closed wall/glass sections push a player capsule out, including a
  // non-door upper-floor centre band.
  for (const [x, z] of [[11, -6.675], [-11, -6.675], [-6.675, -11], [-6.675, 11]]) {
    const resolved = world.resolveHorizontalCollision(x, floorY(0), z, 0.48);
    assert.ok(Math.hypot(resolved.x - x, resolved.z - z) > 0.18, `ground wall at ${x},${z} is not solid`);
  }
  const upperGlass = world.resolveHorizontalCollision(11, floorY(1), 0, 0.48);
  assert.ok(Math.abs(upperGlass.x - 11) > 0.18, 'closed upper east glass band is not solid');
  const core = world.resolveHorizontalCollision(0.5, floorY(3), 0, 0.48);
  assert.ok(Math.hypot(core.x - 0.5, core.z) > 0.5, 'central tower core is not solid');
  const ceilingHit = world.raycastWorld(
    new THREE.Vector3(-4, floorY(0) + 1.5, 4),
    new THREE.Vector3(0, 1, 0),
    8
  );
  assert.ok(ceilingHit && ceilingHit.distance < 5, 'tower floor slab should block an upward weapon ray');
  const roofHit = world.raycastWorld(
    new THREE.Vector3(8, floorY(7) + 2, 0),
    new THREE.Vector3(0, -1, 0),
    5
  );
  assert.ok(roofHit && roofHit.distance < 2.2, 'tower roof slab should block a downward weapon ray');

  assert.equal(LEGENDARY_TOWER_FLOOR_LOOT.length, 21);
  assert.equal(LEGENDARY_TOWER_VAULT_LOOT.length, 13);
  assert.equal(world.legendaryTowerFloorLootItems.length, 21);
  assert.equal(world.legendaryTowerVaultLootItems.length, 13);
  assert.ok(LEGENDARY_TOWER_FLOOR_LOOT.every((item) => item.rarity !== 'legendary'));
  assert.ok(
    [...world.chestSpawnPoints, ...world.lootSpawnPoints].every(
      (point) => Math.abs(point.x) > 11.5 || Math.abs(point.z) > 11.5
    ),
    'generic chest/ground loot must not spawn inside the tower core'
  );
  assert.deepEqual(
    LEGENDARY_TOWER_VAULT_LOOT.filter((item) => item.rarity === 'legendary').map((item) => item.weaponCategory),
    ['assault_rifle', 'sniper', 'shotgun']
  );
  const allTowerItems = [
    ...world.legendaryTowerFloorLootItems,
    ...world.legendaryTowerVaultLootItems,
  ];
  assert.equal(new Set(allTowerItems.map((item) => item.id)).size, allTowerItems.length);
  for (const item of world.legendaryTowerVaultLootItems) {
    assert.equal(item.isLegendaryTowerLoot, true);
    assert.equal(item.serverAuthoritative, true);
    approx(item.position.y, floorY(7) + 1.18, 0.001, `${item.id} vault height`);
  }

  const lootViolations = [];
  for (const item of allTowerItems) {
    const { x, y, z } = item.position;
    const containingBox = world.boxColliders.find(
      (collider) =>
        x > collider.minX && x < collider.maxX &&
        z > collider.minZ && z < collider.maxZ &&
        y > collider.minY && y < collider.maxY
    );
    if (containingBox) lootViolations.push(`${item.id} inside ${containingBox.id}`);
    const containingCylinder = world.cylinderColliders.find((collider) =>
      Math.hypot(x - collider.x, z - collider.z) < collider.radius + 0.15 &&
      y > collider.minY && y < collider.maxY
    );
    if (containingCylinder) lootViolations.push(`${item.id} inside ${containingCylinder.id}`);
    const definition = [...LEGENDARY_TOWER_FLOOR_LOOT, ...LEGENDARY_TOWER_VAULT_LOOT].find(
      (candidate) => candidate.id === item.id
    );
    const support = world.getGroundHeightAt(x, y, z);
    const expectedSupport = floorY(definition.floor) + (definition.floor === 7 ? 0.5 : 0);
    if (Math.abs(support - expectedSupport) > 0.08) {
      lootViolations.push(`${item.id} support ${support.toFixed(2)} != ${expectedSupport.toFixed(2)}`);
    }
  }
  assert.deepEqual(lootViolations, []);

  // The Node server must own an identical ID registry for online play.
  const serverSource = fs.readFileSync(path.join(ROOT_DIR, 'server/multiplayerServer.mjs'), 'utf8');
  for (const item of LEGENDARY_TOWER_VAULT_LOOT) {
    assert.ok(serverSource.includes(`id: '${item.id}'`), `server registry missing ${item.id}`);
    assert.ok(serverSource.includes(`name: '${item.name}'`), `server registry name mismatch for ${item.id}`);
  }
});
