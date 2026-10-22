import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorldModules } from '../scripts/headlessWorld.mjs';
import {
  loadCharacterModules,
  makePlayerState,
  preloadBundledRig,
} from './helpers/characterModules.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Expands every `#include <chunk>` against Three's real ShaderChunk library so
 * the injected code can be inspected in the context it will actually be
 * compiled in. This is the check that was missing when the world-space UV
 * block was injected at `#include <uv_vertex>` - the first statement of main(),
 * where neither `transformed` nor `objectNormal` exists yet, so the shader
 * failed to compile in the browser while every Node test stayed green.
 */
function resolveChunks(source, THREE, depth = 0) {
  if (depth > 8) return source;
  const out = source.replace(/#include <([\w\d_]+)>/g, (match, name) => {
    const chunk = THREE.ShaderChunk[name];
    return typeof chunk === 'string' ? chunk : match;
  });
  return out === source ? source : resolveChunks(out, THREE, depth + 1);
}

function compileVertex(material, THREE) {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  };
  material.onBeforeCompile(shader, {});
  return {
    raw: shader.vertexShader,
    source: resolveChunks(shader.vertexShader, THREE),
    uniforms: shader.uniforms,
  };
}

function compileFragment(material, THREE) {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  };
  material.onBeforeCompile(shader, {});
  return resolveChunks(shader.fragmentShader, THREE);
}

function assertInjectedAfter(compiled, needle, prerequisite, label) {
  const at = compiled.source.indexOf(needle);
  assert.ok(at >= 0, `${label}: injected block missing from the resolved shader`);
  const before = compiled.source.slice(0, at);
  assert.ok(
    before.includes(prerequisite),
    `${label}: "${prerequisite}" is not declared before the injected block`
  );
  assert.equal(
    compiled.source.split(needle).length - 1,
    1,
    `${label}: injected block appears more than once`
  );
}

/** Crude but effective brace balance check over the resolved source. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function braceDelta(rawSource) {
  let depth = 0;
  for (const char of stripComments(rawSource)) {
    if (char === '{') depth++;
    if (char === '}') depth--;
  }
  return depth;
}

/**
 * Three's own physical fragment shader carries one unbalanced `{` behind an
 * `#ifdef`, so absolute balance is not meaningful. What matters is that the
 * injected code adds or removes nothing: the delta must equal the stock
 * shader's delta.
 */
function assertBalancedAgainst(rawSource, baselineSource, label) {
  assert.equal(
    braceDelta(rawSource),
    braceDelta(baselineSource),
    `${label}: injected code changed brace balance`
  );
}

function trianglesOf(geometry) {
  if (!geometry) return 0;
  return geometry.index ? geometry.index.count / 3 : (geometry.attributes.position?.count ?? 0) / 3;
}

/* ------------------------------------------------------------------ */
/* 1. World-space UV projection now injects where its inputs exist      */
/* ------------------------------------------------------------------ */

test('6.2 shading: world-space UV projection injects after project_vertex, where transformed/objectNormal exist', async () => {
  const { THREE, archMaterials } = await loadWorldModules();
  const library = archMaterials.createArchitecturalMaterials();

  for (const surface of ['ashlar', 'plaster', 'roofTile', 'timber', 'trim', 'metal', 'brick', 'concrete']) {
    const material = library.merged[surface];
    assert.ok(material.userData.cicraftWorldUv, `${surface} must carry world-space UVs`);
    const compiled = compileVertex(material, THREE);
    assertInjectedAfter(compiled, 'vec4 cicraftUvPos = vec4(transformed, 1.0);', 'vec3 transformed', surface);
    assertInjectedAfter(compiled, 'vec3 cicraftUvNormal = objectNormal;', 'vec3 objectNormal', surface);
    assert.ok(compiled.uniforms.uCicraftUvScale, `${surface} must expose uCicraftUvScale`);
    assertBalancedAgainst(
      compiled.source,
      resolveChunks(THREE.ShaderLib.physical.vertexShader, THREE),
      `${surface} vertex`
    );
  }
});

test('6.2 shading: every merged surface - including the dark trim surface - is world-projected', async () => {
  // The `dark` slot carries ~27k triangles of shutters, hardware, treads and
  // risers. It used to be the single merged material that skipped the
  // world-space projection, so those parts alone still showed a stretched
  // 0..1 box mapping.
  const { archMaterials } = await loadWorldModules();
  const library = archMaterials.createArchitecturalMaterials();
  const dark = library.merged.dark;
  assert.ok(dark.userData.cicraftWorldUv, 'dark surface must carry world-space UVs');
  assert.equal(dark.map?.wrapS, 1000, 'dark albedo must repeat');
  assert.equal(dark.map?.wrapT, 1000, 'dark albedo must repeat');
  for (const [name, material] of Object.entries(library.merged)) {
    if (name === 'glass' || name === 'glow') continue;
    assert.ok(material.userData.cicraftWorldUv, `${name} lost its world-space UV projection`);
  }
});

test('6.2 shading: the architecture surface shader composes with the world-space UV shader instead of replacing it', async () => {
  const { THREE, archMaterials, atmosphere } = await loadWorldModules();
  const library = archMaterials.createArchitecturalMaterials();
  const material = library.merged.ashlar;
  const before = material.onBeforeCompile;
  atmosphere.applyArchitectureSurfaceShader(material, 'facade');
  assert.notEqual(material.onBeforeCompile, before, 'surface shader must attach');

  // Idempotent: wiring the same material twice must not stack a second
  // injection (shared materials are touched by several builders).
  const once = material.onBeforeCompile;
  atmosphere.applyArchitectureSurfaceShader(material, 'facade');
  assert.equal(material.onBeforeCompile, once, 'surface shader must be idempotent');

  const compiled = compileVertex(material, THREE);
  assert.ok(
    compiled.source.includes('vec4 cicraftUvPos = vec4(transformed, 1.0);'),
    'world-space UV projection was destroyed by the surface shader'
  );
  assert.ok(
    compiled.source.includes('vCicraftWorldPos = cicraftWPos.xyz;'),
    'surface shader world position was not injected'
  );
  const key = material.customProgramCacheKey();
  assert.ok(key.includes('cicraft-world-uv'), `cache key lost the UV injector: ${key}`);
  assert.ok(key.includes('cicraft-arch-surface'), `cache key lost the surface injector: ${key}`);
  assertBalancedAgainst(
    compiled.source,
    resolveChunks(THREE.ShaderLib.physical.vertexShader, THREE),
    'composed vertex'
  );
  // The facade fragment stage must still be balanced after injection.
  assertBalancedAgainst(
    compileFragment(material, THREE),
    resolveChunks(THREE.ShaderLib.physical.fragmentShader, THREE),
    'composed fragment'
  );
});

/* ------------------------------------------------------------------ */
/* 2. Terrain ground detail: CPU and GPU stay in sync                   */
/* ------------------------------------------------------------------ */

test('6.2 shading: terrain ground-detail shader and the offline renderer use identical noise constants', () => {
  const shaderSource = fs.readFileSync(
    path.join(ROOT_DIR, 'src/world/VisualAtmosphere.ts'),
    'utf8'
  );
  const rendererSource = fs.readFileSync(path.join(ROOT_DIR, 'scripts/offlineRender.mjs'), 'utf8');
  const constants = [3.1, 0.62, 17, 0.11, 41, 9.5, 0.085];
  const numbersIn = (source) =>
    new Set(
      (source.match(/(?<![\w.])-?\d+(?:\.\d+)?/g) ?? []).map((value) => Number(value))
    );
  const shaderNumbers = numbersIn(shaderSource);
  const rendererNumbers = numbersIn(rendererSource);
  for (const constant of constants) {
    assert.ok(shaderNumbers.has(constant), `VisualAtmosphere.ts lost ground-detail constant ${constant}`);
    assert.ok(
      rendererNumbers.has(constant),
      `offlineRender.mjs is out of sync on ground-detail constant ${constant}`
    );
  }
  assert.ok(
    shaderSource.includes('cicraft-terrain-ground-detail'),
    'terrain ground-detail cache key missing'
  );
  assert.ok(
    rendererSource.includes('cicraft-terrain-ground-detail'),
    'offline renderer no longer recognises the terrain ground-detail shader'
  );
});

/* ------------------------------------------------------------------ */
/* 3. Character: real harness hardware, no placeholder geometry         */
/* ------------------------------------------------------------------ */

test('6.2 character: every back accessory is physically attached by an authored harness', async () => {
  const { THREE, character } = await loadCharacterModules(ROOT_DIR);
  await preloadBundledRig(character.CharacterMesh, ROOT_DIR);

  for (const backAccessory of ['jump_pack', 'energy_wings', 'tactical_shield']) {
    const mesh = new character.CharacterMesh(makePlayerState({ backAccessory }));
    try {
      const names = new Set();
      mesh.jumpPackGroup.traverse((child) => {
        if (!child.isMesh) return;
        names.add(child.name);
        assert.notEqual(child.geometry.type, 'BoxGeometry', `${child.name} is still a box placeholder`);
      });
      for (const required of [
        'pack_backplate',
        'pack_strap_left',
        'pack_strap_right',
        'pack_buckle_left',
        'pack_buckle_right',
        'pack_sternum_strap',
        'pack_lumbar_pad',
        'pack_lumbar_buckle',
      ]) {
        assert.ok(names.has(required), `${backAccessory} is missing ${required}`);
      }

      // The harness must be modelled at human scale, not draped over the rig.
      const bbox = new THREE.Box3().setFromObject(mesh.jumpPackGroup);
      const size = bbox.getSize(new THREE.Vector3());
      assert.ok(size.x <= 0.32 && size.y <= 0.32 && size.z <= 0.22, `harness out of scale: ${size.toArray()}`);
      assert.ok(size.y > 0.2, `harness too small to read: ${size.toArray()}`);
    } finally {
      mesh.dispose?.();
    }
  }
});

/* ------------------------------------------------------------------ */
/* 4. Parachute: curved canopy, connected lines, real deployment        */
/* ------------------------------------------------------------------ */

test('6.2 parachute: canopy is a curved ram-air wing with connected suspension lines', async () => {
  const { THREE, character } = await loadCharacterModules(ROOT_DIR);
  await preloadBundledRig(character.CharacterMesh, ROOT_DIR);

  const mesh = new character.CharacterMesh(makePlayerState({ isGliding: true, isGrounded: false }));
  const camera = new THREE.Vector3(0, 1.8, 4.0);
  for (let i = 0; i < 90; i++) {
    mesh.update(
      makePlayerState({ isGliding: true, isGrounded: false, velocity: { x: 0, y: -4, z: -5 } }),
      1 / 60,
      camera
    );
  }

  const canopy = mesh.gliderGroup.getObjectByName('parachute_canopy_mesh');
  assert.ok(canopy, 'canopy mesh missing');
  const position = canopy.geometry.getAttribute('position');
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < position.count; i++) {
    minX = Math.min(minX, position.getX(i));
    maxX = Math.max(maxX, position.getX(i));
    minY = Math.min(minY, position.getY(i));
    maxY = Math.max(maxY, position.getY(i));
  }
  assert.ok(maxX - minX > 2.2, `canopy span too small: ${(maxX - minX).toFixed(2)} m`);
  // A ram-air canopy is arched: the wingtips sit measurably below the apex.
  assert.ok(
    maxY - minY > 0.3,
    `canopy is not curved (vertical relief ${(maxY - minY).toFixed(2)} m)`
  );

  // Every suspension line must physically start at the canopy and end at the
  // harness - no floating cords.
  const lines = [];
  mesh.gliderGroup.traverse((child) => {
    if (child.isMesh && /suspension_line|brake_line/.test(child.name)) lines.push(child);
  });
  assert.ok(lines.length >= 8, `expected a full line set, got ${lines.length}`);
  const canopyBox = new THREE.Box3().setFromObject(canopy);
  mesh.gliderGroup.updateMatrixWorld(true);
  for (const line of lines) {
    const box = new THREE.Box3().setFromObject(line);
    assert.ok(
      box.max.y >= canopyBox.min.y - 0.15,
      `${line.name} does not reach the canopy (${box.max.y.toFixed(2)} vs ${canopyBox.min.y.toFixed(2)})`
    );
    assert.ok(
      box.min.y <= canopyBox.min.y - 0.4,
      `${line.name} never reaches the harness (${box.min.y.toFixed(2)})`
    );
    // Lines must terminate at the torso, not dangle past it.
    assert.ok(box.min.y > 1.2, `${line.name} hangs below the harness (${box.min.y.toFixed(2)})`);
  }

  // Deployment is a real transition, not a pop.
  const pivot = mesh.gliderGroup.getObjectByName('parachute_canopy_pivot');
  assert.ok(pivot, 'canopy pivot missing');
  assert.ok(pivot.scale.x > 0.9 && pivot.scale.x < 1.1, 'canopy never reaches full deployment');

  // Landing hides the rig again.
  for (let i = 0; i < 5; i++) {
    mesh.update(makePlayerState({ isGliding: false, isGrounded: true }), 1 / 60, camera);
  }
  assert.equal(mesh.gliderGroup.visible, false, 'parachute must stow on landing');
  mesh.dispose?.();
});

/* ------------------------------------------------------------------ */
/* 5. Buildings: facades are modelled, not painted                      */
/* ------------------------------------------------------------------ */

test('6.2 buildings: facade relief, glazing and roofs are real authored geometry', async () => {
  const { THREE, IslandWorld } = await loadWorldModules();
  const scene = new THREE.Scene();
  const world = new IslandWorld(scene);
  world.generate();

  const kitMeshes = [
    ...world.expansionGroup.children,
    ...world.expansionDetailGroup.children,
  ].filter((child) => child.name.startsWith('ExpansionKit_'));
  assert.ok(kitMeshes.length >= 8, `expected authored kit meshes, got ${kitMeshes.length}`);

  const bySlot = new Map();
  let hardSurfaceTriangles = 0;
  for (const mesh of kitMeshes) {
    bySlot.set(mesh.name, (bySlot.get(mesh.name) ?? 0) + trianglesOf(mesh.geometry) * (mesh.isInstancedMesh ? mesh.count : 1));
    hardSurfaceTriangles += trianglesOf(mesh.geometry) * (mesh.isInstancedMesh ? mesh.count : 1);
  }
  assert.ok(hardSurfaceTriangles > 150000, `authored facade geometry too thin: ${Math.round(hardSurfaceTriangles)}`);

  // Deep relief: window reveals/frames and roof geometry must both exist as
  // separate authored parts, not as a decal on one cube.
  const names = [...bySlot.keys()].join(' ');
  assert.match(names, /glass/i, 'no glazing geometry in the kit');
  assert.match(names, /roof/i, 'no roof geometry in the kit');
  assert.match(names, /trim/i, 'no trim/frame geometry in the kit');

  // The kit batches into one merged mesh per material slot; the district
  // shells - the parts that repeat hundreds of times - must be instanced.
  // District shells are batched as `Expansion_<district>_<shape>_<tier>`.
  const instancedShells = [];
  world.expansionGroup.traverse((child) => {
    if (child.isInstancedMesh && /^Expansion_[a-z_]+_(box|cylinder|glass|decal|contact|stone)/.test(child.name)) {
      instancedShells.push(child);
    }
  });
  assert.ok(instancedShells.length >= 8, `district shells are not instanced (${instancedShells.length})`);
  const shellInstances = instancedShells.reduce((sum, mesh) => sum + mesh.count, 0);
  assert.ok(shellInstances > 2000, `too few instanced shells: ${shellInstances}`);
});

test('6.2 buildings: no architecture collider was added or removed by the visual pass', async () => {
  const { THREE, IslandWorld } = await loadWorldModules();
  const scene = new THREE.Scene();
  const world = new IslandWorld(scene);
  world.generate();
  const total = world.boxColliders.length + world.cylinderColliders.length;
  assert.equal(total, 1414, `collider count changed: ${total}`);
  // Visual geometry must never leak into the collision set.
  const kitCollider = [...world.boxColliders, ...world.cylinderColliders].some((collider) =>
    /kit|facade|window|sill|dentil|gutter|downpipe/i.test(String(collider.id ?? collider.name ?? ''))
  );
  assert.equal(kitCollider, false, 'decorative geometry is colliding');
});
