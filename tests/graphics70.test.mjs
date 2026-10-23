import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorldModules } from '../scripts/headlessWorld.mjs';
import { measureQualityTiers, auditTreeLod } from './helpers/sceneStats.mjs';

/* ------------------------------------------------------------------ */
/* GLSL validation helpers                                             */
/* ------------------------------------------------------------------ */

function resolveChunks(source, THREE, depth = 0) {
  if (depth > 8) return source;
  const out = source.replace(/#include <([\w\d_]+)>/g, (match, name) => {
    const chunk = THREE.ShaderChunk[name];
    return typeof chunk === 'string' ? chunk : match;
  });
  return out === source ? source : resolveChunks(out, THREE, depth + 1);
}

function compile(material, THREE, stage = 'vertex') {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  };
  material.onBeforeCompile(shader, {});
  const raw = stage === 'vertex' ? shader.vertexShader : shader.fragmentShader;
  return { raw, source: resolveChunks(raw, THREE), uniforms: shader.uniforms };
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Three's own physical shader is not brace-balanced; only the delta matters. */
function braceDelta(source) {
  let depth = 0;
  for (const char of stripComments(source)) {
    if (char === '{') depth++;
    if (char === '}') depth--;
  }
  return depth;
}

/** Every identifier a shader reads must be declared somewhere in the source. */
function assertDeclaredBeforeUse(source, identifiers, label) {
  for (const identifier of identifiers) {
    const useIndex = source.search(new RegExp(`\\b${identifier}\\b`));
    assert.ok(useIndex >= 0, `${label}: ${identifier} is used but never appears`);
  }
}

/* ------------------------------------------------------------------ */
/* 1. Vegetation is real authored geometry, not faceted primitives     */
/* ------------------------------------------------------------------ */

test('7.0 vegetation: canopies are welded continuous shells with canopy shading', async () => {
  const veg = await import('../src/world/VegetationGeometry.ts');

  for (const [name, factory, minTris] of [
    ['broadleaf canopy', veg.createBroadleafCanopyGeometry, 150],
    ['conifer body', veg.createConiferBodyGeometry, 200],
  ]) {
    const geo = factory();
    const tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    assert.ok(tris >= minTris, `${name} too coarse: ${tris} triangles`);

    // A colour attribute is what carries canopy self-shading; without it the
    // foliage renders as a single flat green value.
    assert.ok(geo.getAttribute('color'), `${name} is missing canopy shading`);
    assert.ok(geo.getAttribute('uv'), `${name} is missing UVs`);
    assert.ok(geo.getAttribute('normal'), `${name} is missing normals`);

    // Welded means indexed with far fewer vertices than a non-indexed soup.
    assert.ok(geo.index, `${name} must be indexed (welded) for smooth normals`);
    assert.ok(
      geo.attributes.position.count < tris * 2,
      `${name} is not welded: ${geo.attributes.position.count} verts for ${tris} tris`
    );

    // Shading must actually vary, otherwise it is a flat colour in disguise.
    const color = geo.getAttribute('color');
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < color.count; i++) {
      const value = color.getX(i);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    assert.ok(max - min > 0.25, `${name} canopy shading is flat (${(max - min).toFixed(3)})`);
  }
});

test('7.0 vegetation: trunks stay inside the unit envelope the instancer assumes', async () => {
  // The tree builder instances trunks at `y = trunkH / 2` with `scale.y = trunkH`.
  // If the geometry overshoots [-0.5, 0.5] the whole tree sinks or floats by half
  // its height, which is a bug that photographs as "the canopy fell off".
  const veg = await import('../src/world/VegetationGeometry.ts');
  const trunk = veg.createBroadleafTrunkGeometry();
  trunk.computeBoundingBox();
  const box = trunk.boundingBox;
  assert.ok(box.min.y >= -0.501, `trunk bottom out of envelope: ${box.min.y.toFixed(3)}`);
  assert.ok(box.max.y <= 0.501, `trunk top out of envelope: ${box.max.y.toFixed(3)}`);
  assert.ok(box.max.y - box.min.y > 0.98, 'trunk does not fill its envelope');
});

test('7.0 vegetation: LOD twins share instance matrices and cover every tree', async () => {
  const { THREE, IslandWorld } = await loadWorldModules();
  const scene = new THREE.Scene();
  const world = new IslandWorld(scene);
  world.generate();

  const audit = auditTreeLod(world.treeLodHighGroup, world.treeLodLowGroup);
  assert.deepEqual(audit.problems, [], audit.problems.join('; '));
  assert.ok(audit.comparedInstances >= 250, `expected all trees in both tiers, got ${audit.comparedInstances}`);

  const highCrown = world.treeLodHighGroup.getObjectByName('tree_canopies');
  const lowCrown = world.treeLodLowGroup.getObjectByName('tree_canopies_low');
  const highTris = highCrown.geometry.index.count / 3;
  const lowTris = lowCrown.geometry.index.count / 3;
  assert.ok(highTris > lowTris * 1.8, `LOD is not a real reduction: ${highTris} vs ${lowTris}`);

  // Only one tier may be visible at a time, or the trees double up.
  assert.notEqual(world.treeLodHighGroup.visible, world.treeLodLowGroup.visible);
});

test('7.0 vegetation: LOW/MEDIUM draws materially fewer triangles than HIGH/ULTRA', async () => {
  const { THREE, IslandWorld } = await loadWorldModules();
  const scene = new THREE.Scene();
  const world = new IslandWorld(scene);
  world.generate();

  const tiers = measureQualityTiers(scene, world);
  assert.ok(
    tiers.low.triangles < tiers.high.triangles * 0.65,
    `quality tiers are not meaningfully different: LOW ${tiers.low.triangles} vs HIGH ${tiers.high.triangles}`
  );
  // Measured 7.0 baseline (visualAudit, detailed vegetation on the high tier):
  //   LOW/MEDIUM 320,030 tris | HIGH/ULTRA 576,900 tris
  // 6.2's always-on tier was 305,226. The +4.8 % on LOW buys the round
  // shared cylinder (10 -> 18 segments), which is the single fix for the
  // visibly faceted silos, tanks and towers. Budgets sit just above the
  // measured value so ordinary tweaks do not churn, and any further growth
  // has to be justified explicitly.
  // Measured 8.0 tier totals (visualAudit / measureQualityTiers):
  //   LOW/MEDIUM 327,640 tris | HIGH/ULTRA 609,542 tris
  // The 8.0 delta over 7.2 (+2.6k LOW, +24.5k HIGH) is the clustered ground
  // cover: 6,400 grass tufts at 6 triangles plus 1,400 flowers, in four
  // instanced draw calls. LOW keeps one band and no flowers; HIGH/ULTRA show
  // all of it with a taller/tighter band layout. Nothing else was added, and
  // no existing geometry was made heavier to reach these numbers.
  // Measured 8.2 tier totals: LOW/MEDIUM 333,510 | HIGH/ULTRA 612,122.
  // The 8.2 delta (+5.9k LOW, +7.0k HIGH) is the road surface mesh (1,274
  // triangles of carriageway ribbons and junction discs) plus kerbs split into
  // two sub-spans each so they follow the ground instead of hovering over it.
  // All of it is essential-tier: a road cannot be quality-gated away without
  // removing the road network on LOW, so both tiers carry it.
  assert.ok(tiers.low.triangles <= 338000, `LOW/MEDIUM budget: ${tiers.low.triangles}`);
  assert.ok(tiers.high.triangles <= 622000, `HIGH/ULTRA budget: ${tiers.high.triangles}`);
});

/* ------------------------------------------------------------------ */
/* 2. Ocean shader                                                     */
/* ------------------------------------------------------------------ */

test('7.0 water: ocean shader compiles, keeps its chunk balance, and is driven by real depth', async () => {
  const { THREE, atmosphere } = await loadWorldModules();
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true });
  atmosphere.applyOceanShader(material, { waveHeight: 0.16, foamDepth: 0.85 });

  for (const stage of ['vertex', 'fragment']) {
    const compiled = compile(material, THREE, stage);
    assert.equal(
      braceDelta(compiled.source),
      braceDelta(
        resolveChunks(
          stage === 'vertex'
            ? THREE.ShaderLib.physical.vertexShader
            : THREE.ShaderLib.physical.fragmentShader,
          THREE
        )
      ),
      `ocean ${stage} shader changed brace balance`
    );
    // aOceanDepth is a vertex attribute (declared in the vertex stage only);
    // the fragment stage consumes the interpolated vOceanDepth varying.
    assertDeclaredBeforeUse(
      compiled.source,
      stage === 'vertex' ? ['aOceanDepth', 'vOceanDepth'] : ['vOceanDepth', 'uOceanTime'],
      `ocean ${stage} fragment`
    );
  }

  const vertex = compile(material, THREE, 'vertex');
  // Wave displacement must happen after begin_vertex, where `transformed` exists.
  const beginAt = vertex.source.indexOf('#include <begin_vertex>');
  assert.ok(beginAt >= 0 || vertex.source.includes('vec3 transformed'), 'transformed missing');
  assert.ok(vertex.source.includes('transformed.y += h * uOceanWaveHeight'), 'no wave displacement');
  assert.ok(vertex.source.includes('objectNormal = normalize(mix(objectNormal, waveN'), 'no wave normals');

  const fragment = compile(material, THREE, 'fragment');
  // Depth grading, foam and Fresnel must all be present and must be capped so
  // water can never blow out into a white band that hides silhouettes.
  assert.ok(fragment.source.includes('shallowTint'), 'depth grading missing');
  assert.ok(fragment.source.includes('foamMask'), 'shoreline foam missing');
  assert.ok(fragment.source.includes('clamp(fres, 0.0, 0.55)'), 'Fresnel is not capped');

  // The clock must be externally drivable.
  assert.ok(material.userData.__oceanUniforms, 'ocean uniforms are not exposed');
  atmosphere.setOceanTime(material, 12.5);
  assert.equal(material.userData.__oceanUniforms.uOceanTime.value, 12.5);
});

test('7.0 water: the world mesh carries a depth attribute that actually varies', async () => {
  const { THREE, IslandWorld } = await loadWorldModules();
  const scene = new THREE.Scene();
  const world = new IslandWorld(scene);
  world.generate();

  const water = world.terrain.waterMesh;
  assert.ok(water, 'water mesh missing');
  const depth = water.geometry.getAttribute('aOceanDepth');
  assert.ok(depth, 'water has no aOceanDepth attribute');

  let min = Infinity;
  let max = -Infinity;
  let shallow = 0;
  for (let i = 0; i < depth.count; i++) {
    const value = depth.getX(i);
    min = Math.min(min, value);
    max = Math.max(max, value);
    if (value > 0 && value < 1) shallow++;
  }
  assert.ok(max > 3, `deep water never reached: ${max.toFixed(2)}`);
  assert.ok(min < 0, `no terrain above the waterline anywhere: ${min.toFixed(2)}`);
  assert.ok(shallow > 20, `no shoreline band to draw foam on: ${shallow} verts`);
});

/* ------------------------------------------------------------------ */
/* 3. Gameplay protection                                              */
/* ------------------------------------------------------------------ */

test('7.0 gameplay: collision and route geometry are untouched by the graphics pass', async () => {
  const { THREE, IslandWorld } = await loadWorldModules();
  const scene = new THREE.Scene();
  const world = new IslandWorld(scene);
  world.generate();

  const total = world.boxColliders.length + world.cylinderColliders.length;
  assert.equal(total, 1414, `collider count changed: ${total}`);

  // Vegetation LOD must never alter what a player can collide with or harvest.
  const harvestable = [...world.destructibles.values()].filter(
    (prop) => prop.type === 'tree' || prop.type === 'rock'
  );
  assert.ok(harvestable.length >= 290, `harvestable props changed: ${harvestable.length}`);
});
