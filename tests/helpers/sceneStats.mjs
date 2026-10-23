/**
 * Shared scene measurement helpers.
 *
 * CI CRAFT 7.0 introduced two things that make a single "triangle count"
 * meaningless as a quality/performance gate:
 *
 *   1. a decorative architecture tier that is hidden on LOW/MEDIUM, and
 *   2. a vegetation LOD tier that swaps detailed canopies for coarse twins.
 *
 * Both are implemented as visibility swaps over pre-built instances, so the
 * correct thing to measure is what each quality tier actually renders. These
 * helpers report that, and every budget test uses them instead of counting
 * hidden meshes that cost nothing on the GPU.
 */

/** True only when this object and every ancestor is visible. */
export function isEffectivelyVisible(object) {
  let node = object;
  while (node) {
    if (node.visible === false) return false;
    node = node.parent;
  }
  return true;
}

export function trianglesOf(geometry) {
  if (!geometry) return 0;
  return geometry.index
    ? geometry.index.count / 3
    : (geometry.attributes?.position?.count ?? 0) / 3;
}

/** Triangles (and draw calls) currently contributing to the frame. */
export function visibleSceneStats(scene) {
  let meshes = 0;
  let instancedMeshes = 0;
  let instances = 0;
  let triangles = 0;
  scene.traverse((object) => {
    if (!object.isMesh) return;
    if (!isEffectivelyVisible(object)) return;
    meshes++;
    const weighted = trianglesOf(object.geometry) * (object.isInstancedMesh ? object.count : 1);
    triangles += weighted;
    if (object.isInstancedMesh) {
      instancedMeshes++;
      instances += object.count;
    }
  });
  return { meshes, instancedMeshes, instances, triangles: Math.round(triangles) };
}

function isInsideAny(object, groups) {
  let node = object;
  while (node) {
    if (groups.has(node)) return true;
    node = node.parent;
  }
  return false;
}

/**
 * Measures the LOW/MEDIUM tier without mutating the world permanently: the
 * detail groups and the high-detail vegetation are hidden, the coarse twins are
 * shown, the scene is measured, and every flag is restored.
 */
export function measureQualityTiers(scene, world) {
  const detailGroups = new Set(
    [world.expansionDetailGroup, world.houseDetailGroup, world.detailFoliageGroup].filter(Boolean)
  );

  const highTier = visibleSceneStats(scene);
  let detailTriangles = 0;
  scene.traverse((object) => {
    if (!object.isMesh) return;
    if (!isEffectivelyVisible(object)) return;
    if (!isInsideAny(object, detailGroups)) return;
    detailTriangles +=
      trianglesOf(object.geometry) * (object.isInstancedMesh ? object.count : 1);
  });

  // --- Measure LOW/MEDIUM ------------------------------------------------
  const saved = [];
  const remember = (object) => {
    if (!object) return;
    saved.push([object, object.visible]);
  };
  remember(world.expansionDetailGroup);
  remember(world.houseDetailGroup);
  remember(world.detailFoliageGroup);
  remember(world.treeLodHighGroup);
  remember(world.treeLodLowGroup);
  // 8.0 ground cover: LOW keeps the first band only and hides the flowers.
  const groundBands = world.groundCoverBands ?? [];
  for (const band of groundBands) remember(band);
  remember(world.groundFlowers);

  if (world.expansionDetailGroup) world.expansionDetailGroup.visible = false;
  if (world.houseDetailGroup) world.houseDetailGroup.visible = false;
  if (world.detailFoliageGroup) world.detailFoliageGroup.visible = false;
  if (world.treeLodHighGroup) world.treeLodHighGroup.visible = false;
  if (world.treeLodLowGroup) world.treeLodLowGroup.visible = true;
  groundBands.forEach((band, index) => {
    band.visible = index === 0;
  });
  if (world.groundFlowers) world.groundFlowers.visible = false;

  const lowTier = visibleSceneStats(scene);

  for (const [object, value] of saved) object.visible = value;

  return {
    high: highTier,
    low: lowTier,
    detail: Math.round(detailTriangles),
    alwaysOn: highTier.triangles - Math.round(detailTriangles),
  };
}

/**
 * Cross-checks that the low-detail vegetation twins really are in step with the
 * high-detail instances. A desync here shows up in game as trees that vanish or
 * jump when the player changes quality mid-match.
 */
export function auditTreeLod(highGroup, lowGroup) {
  const byName = new Map();
  highGroup.traverse((object) => {
    if (object.isInstancedMesh) byName.set(object.name, object);
  });
  const lowByName = new Map();
  lowGroup.traverse((object) => {
    if (object.isInstancedMesh) lowByName.set(object.name, object);
  });

  const pairs = [
    ['tree_canopies', 'tree_canopies_low'],
    ['tree_conifer_boughs', 'tree_conifers_low'],
  ];
  const problems = [];
  let comparedInstances = 0;

  for (const [highName, lowName] of pairs) {
    const high = byName.get(highName);
    const low = lowByName.get(lowName);
    if (!high || !low) {
      problems.push(`missing LOD mesh: ${!high ? highName : lowName}`);
      continue;
    }
    if (high.count !== low.count) {
      problems.push(`${highName} has ${high.count} instances but ${lowName} has ${low.count}`);
    }
    const shared = Math.min(high.count, low.count);
    comparedInstances += shared;

    const a = high.instanceMatrix.array;
    const b = low.instanceMatrix.array;
    for (let i = 0; i < shared * 16; i++) {
      if (Math.abs(a[i] - b[i]) > 1e-4) {
        problems.push(`${highName} instance ${Math.floor(i / 16)} matrix differs from its LOD twin`);
        break;
      }
    }
  }

  return { problems, comparedInstances };
}
