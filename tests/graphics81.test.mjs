/**
 * CI CRAFT 8.1 — world rendering regression repair.
 *
 * 8.0 injected a surface-normal perturbation into the terrain material at
 * `#include <map_fragment>`. `normal` is not declared until
 * `normal_fragment_begin`, which is several chunks *later*, so the terrain
 * fragment shader failed to compile in the browser. A failed program means the
 * terrain mesh is not drawn at all — and directly underneath the island sits a
 * 1600 x 1600 turquoise ocean plane at y = -0.28, so the playable world turned
 * into a turquoise sheet with roads, kerbs and building plinths floating on it.
 *
 * None of the existing tests caught it because they only validated *vertex*
 * injections ordering, and the offline preview rasteriser emulates shading in
 * JavaScript instead of compiling GLSL.
 *
 * These tests assemble the real Three.js shader for each affected material,
 * expand every `#include <chunk>` exactly as the renderer does, and assert that
 * injected code only touches identifiers that exist at its injection point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadVisualAtmosphere() {
  const dir = fs.mkdtempSync(path.join(ROOT_DIR, '.graphics81-va-'));
  try {
    const source = fs.readFileSync(path.join(ROOT_DIR, 'src/world/VisualAtmosphere.ts'), 'utf8');
    fs.writeFileSync(path.join(dir, 'VisualAtmosphere.mjs'), stripTypeScriptTypes(source));
    return await import(pathToFileURL(path.join(dir, 'VisualAtmosphere.mjs')).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Expands `#include <chunk>` against Three's real chunk library, recursively. */
function resolveChunks(source, depth = 0) {
  if (depth > 8) return source;
  const out = source.replace(/#include <([\w\d_]+)>/g, (match, name) => {
    const chunk = THREE.ShaderChunk[name];
    return typeof chunk === 'string' ? chunk : match;
  });
  return out === source ? source : resolveChunks(out, depth + 1);
}

function compile(material) {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  };
  material.onBeforeCompile(shader, {});
  return {
    rawVertex: shader.vertexShader,
    rawFragment: shader.fragmentShader,
    vertex: resolveChunks(shader.vertexShader),
    fragment: resolveChunks(shader.fragmentShader),
  };
}

/**
 * Every `#include <name>` must resolve to a real chunk. An unknown name is left
 * in the source verbatim, which the GLSL compiler then rejects — a silent
 * whole-material failure with no warning from Three.js.
 */
function assertNoUnresolvedChunks(compiled, label) {
  for (const [stage, source] of [
    ['vertex', compiled.vertex],
    ['fragment', compiled.fragment],
  ]) {
    const leftover = source.match(/#include <([\w\d_]+)>/g) ?? [];
    assert.deepEqual(leftover, [], `${label}: unresolved ${stage} shader chunks`);
  }
}

/**
 * The fragment shader declares the surface normal inside `main` at this exact
 * statement. Anything that writes `normal` must appear after it.
 *
 * Note the trap this guards against: `vec3 normal = geometryNormal;` also exists
 * in the file, but inside the standalone `RE_Direct_Physical` function, where it
 * is a different variable in a different scope. Searching for the first
 * `vec3 normal` therefore produces a false pass.
 */
const NORMAL_DECL_MARKER = 'vec3 nonPerturbedNormal = normal;';

test('8.1 terrain: the material assembles into legal GLSL', async () => {
  const atmosphere = await loadVisualAtmosphere();
  const material = atmosphere.applyTerrainGroundDetail(new THREE.MeshStandardMaterial());
  const compiled = compile(material);
  assertNoUnresolvedChunks(compiled, 'terrain');
  assert.ok(
    compiled.fragment.includes('cicraft-terrain-ground-detail') === false,
    'cache key must not leak into the shader source'
  );
  assert.ok(compiled.fragment.includes('cicraftValueNoise'), 'terrain detail was not injected');
});

test('8.1 terrain: surface normal is written only after it is declared', async () => {
  const atmosphere = await loadVisualAtmosphere();
  const material = atmosphere.applyTerrainGroundDetail(new THREE.MeshStandardMaterial());
  const { rawFragment, fragment } = compile(material);

  // Structural: the perturbation must be anchored to normal_fragment_maps.
  const mappedAnchor = rawFragment.indexOf('#include <normal_fragment_maps>');
  assert.ok(mappedAnchor >= 0, 'normal_fragment_maps anchor is missing from the shader');
  const perturbation = rawFragment.indexOf('normal = normalize(mix(normal');
  assert.ok(perturbation >= 0, 'the surface-normal perturbation is missing entirely');
  assert.ok(
    perturbation > mappedAnchor,
    'surface-normal perturbation must be injected after #include <normal_fragment_maps>'
  );

  // And in the fully resolved shader it must follow the real in-main declaration.
  const declaredAt = fragment.indexOf(NORMAL_DECL_MARKER);
  assert.ok(declaredAt >= 0, 'could not locate the in-main declaration of `normal`');
  const writtenAt = fragment.indexOf('normal = normalize(mix(normal');
  assert.ok(writtenAt >= 0, 'perturbation missing from the resolved shader');
  assert.ok(
    writtenAt > declaredAt,
    'the terrain shader writes `normal` before it is declared — this is a GLSL compile error ' +
      'and it takes the entire terrain material out in the browser'
  );
});

test('8.1 terrain: nothing writes the surface normal inside map_fragment', async () => {
  const atmosphere = await loadVisualAtmosphere();
  const material = atmosphere.applyTerrainGroundDetail(new THREE.MeshStandardMaterial());
  const { rawFragment } = compile(material);

  // Isolate the code injected at map_fragment — bounded by the *next* chunk
  // anchor, so a later, legal perturbation elsewhere in the shader cannot make
  // this test pass or fail by accident.
  const anchor = rawFragment.indexOf('#include <map_fragment>');
  assert.ok(anchor >= 0, 'map_fragment anchor missing');
  const nextAnchor = rawFragment.indexOf('#include <', anchor + 1);
  assert.ok(nextAnchor > anchor, 'no chunk follows map_fragment; cannot bound the block');
  const injected = rawFragment.slice(anchor, nextAnchor);
  assert.ok(
    !/\bnormal\s*=/.test(injected),
    'map_fragment runs before `normal` exists; do not assign the normal there'
  );
});

test('8.1 terrain: roughness injection follows roughnessFactor', async () => {
  const atmosphere = await loadVisualAtmosphere();
  const material = atmosphere.applyTerrainGroundDetail(new THREE.MeshStandardMaterial());
  const { rawFragment, fragment } = compile(material);

  const anchor = rawFragment.indexOf('#include <roughnessmap_fragment>');
  assert.ok(anchor >= 0, 'roughnessmap_fragment anchor missing');
  const roughnessUse = rawFragment.indexOf('roughnessFactor *=', anchor);
  assert.ok(roughnessUse > anchor, 'roughness injection must follow its anchor');

  const declaredAt = fragment.indexOf('float roughnessFactor = roughness;');
  const usedAt = fragment.indexOf('roughnessFactor *= 1.0 - wetMask');
  assert.ok(declaredAt >= 0 && usedAt >= 0, 'roughness block missing');
  assert.ok(usedAt > declaredAt, 'roughnessFactor used before declaration');
});

test('8.1 regression: terrain detaches from the water plane on the island', async () => {
  // The turquoise ocean sheet only became visible because the terrain stopped
  // drawing. Assert the two are ordered correctly in the scene, so if the
  // terrain material is ever removed again this fails loudly rather than
  // silently exposing water.
  const { loadWorldModules } = await import('../scripts/headlessWorld.mjs');
  const { THREE: T, IslandWorld } = await loadWorldModules();
  const scene = new T.Scene();
  const world = new IslandWorld(scene);
  world.generate();

  const terrain = world.terrain.terrainMesh;
  const water = world.terrain.waterMesh;
  assert.ok(terrain, 'terrain mesh missing');
  assert.ok(water, 'water mesh missing');

  // Terrain must exist and be visible, and its material must be compiled from
  // the ground-detail shader, not a placeholder.
  assert.equal(terrain.visible, true, 'terrain mesh is hidden');
  assert.ok(terrain.material.onBeforeCompile, 'terrain has no ground-detail shader');

  // The water sheet is enormous; it must stay below the walkable island.
  if (!terrain.geometry.boundingBox) terrain.geometry.computeBoundingBox();
  const box = terrain.geometry.boundingBox;
  assert.ok(box, 'terrain has no bounding box');
  assert.ok(
    water.position.y < box.max.y,
    'water surface is above the terrain — it would flood the island'
  );

  // The island centre is land, not a lake.
  assert.ok(
    world.terrain.getTerrainHeight(0, 0) > water.position.y + 1,
    'the island centre is at or below the water plane'
  );

  // Mirror Lake and the river are *meant* to be under water, so the meaningful
  // assertion is that land dominates the playable radius. If terrain ever stops
  // rendering again, this is also what proves how much turquoise would show.
  let sampled = 0;
  let above = 0;
  for (let x = -200; x <= 200; x += 16) {
    for (let z = -200; z <= 200; z += 16) {
      if (Math.hypot(x, z) > 200) continue;
      sampled++;
      if (world.terrain.getTerrainHeight(x, z) > water.position.y) above++;
    }
  }
  assert.ok(sampled > 300, 'grid sampling produced too few points');
  assert.ok(
    above / sampled > 0.85,
    `only ${((above / sampled) * 100).toFixed(1)} % of the island is above the water plane; ` +
      'the turquoise sheet would be visible across the playable area'
  );
});
