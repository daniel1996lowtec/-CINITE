/**
 * CI CRAFT visual audit.
 *
 * Generates the real island headlessly and reports the metrics that actually
 * drive how the game looks: draw calls, instanced batches, triangles, unique
 * materials/textures, how many materials are smooth-shaded or normal-mapped,
 * and the primitive-geometry histogram (so placeholder boxes/icosahedrons are
 * visible in numbers). Colliders are reported too, because visuals must never
 * change gameplay.
 *
 * Usage:  node scripts/visualAudit.mjs [--json]
 * Compare two revisions with:
 *   git worktree add /tmp/old <rev> && ln -s "$PWD/node_modules" /tmp/old/node_modules
 *   (cd /tmp/old && node scripts/visualAudit.mjs --json) > /tmp/old.json
 */
import * as THREE from 'three';
import { loadWorldModules } from './headlessWorld.mjs';

const { IslandWorld } = await loadWorldModules();
const scene = new THREE.Scene();
const world = new IslandWorld(scene);
const started = performance.now();
world.generate();
const generationMs = performance.now() - started;

let meshes = 0;
let instancedMeshes = 0;
let instances = 0;
let triangles = 0;
let vertices = 0;
const geometries = new Set();
const materials = new Set();
const textures = new Set();
const primitives = {};

scene.traverse((object) => {
  if (!object.isMesh) return;
  meshes++;
  const geometry = object.geometry;
  const indexCount = geometry.index ? geometry.index.count : geometry.attributes.position.count;
  const copies = object.isInstancedMesh ? object.count : 1;
  triangles += (indexCount / 3) * copies;
  vertices += geometry.attributes.position.count * copies;
  if (object.isInstancedMesh) {
    instancedMeshes++;
    instances += object.count;
  }
  geometries.add(geometry);
  primitives[geometry.type] = (primitives[geometry.type] ?? 0) + 1;
  for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
    materials.add(material);
    for (const key of ['map', 'normalMap', 'roughnessMap', 'bumpMap', 'envMap']) {
      if (material[key]) textures.add(material[key]);
    }
  }
});

const report = {
  generationMs: Math.round(generationMs),
  meshes,
  instancedMeshes,
  instances,
  triangles: Math.round(triangles),
  vertices,
  uniqueGeometries: geometries.size,
  uniqueMaterials: materials.size,
  uniqueTextures: textures.size,
  smoothShadedMaterials: [...materials].filter((m) => m.flatShading === false).length,
  normalMappedMaterials: [...materials].filter((m) => m.normalMap).length,
  colliders: world.boxColliders.length + world.cylinderColliders.length,
  primitiveHistogram: Object.fromEntries(
    Object.entries(primitives).sort((a, b) => b[1] - a[1])
  ),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('CI CRAFT visual audit');
  console.log(`  generation: ${report.generationMs} ms`);
  console.log(`  meshes / draw calls: ${report.meshes} (${report.instancedMeshes} instanced batches, ${report.instances} instances)`);
  console.log(`  triangles: ${report.triangles.toLocaleString()}   vertices: ${report.vertices.toLocaleString()}`);
  console.log(`  unique geometry / materials / textures: ${report.uniqueGeometries} / ${report.uniqueMaterials} / ${report.uniqueTextures}`);
  console.log(`  smooth-shaded materials: ${report.smoothShadedMaterials}   normal-mapped: ${report.normalMappedMaterials}`);
  console.log(`  colliders (gameplay): ${report.colliders}`);
  console.log('  primitive histogram:', report.primitiveHistogram);
}
