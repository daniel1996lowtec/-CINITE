/**
 * CI Craft Phase 1 visual-atmosphere tests.
 *
 * These tests exercise the real VisualAtmosphere TypeScript module headlessly
 * and guard the renderer/world integration contracts that cannot be seen in
 * Node: the camera-centred sky must stay inside every camera-far tier, Auto
 * graphics must be conservative on constrained phones, foliage wind must be a
 * shared shader uniform rather than CPU matrix churn, and the time-of-day sun
 * must not snap back to the daytime vector when shadows recentre.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadVisualAtmosphere() {
  const tmpDir = fs.mkdtempSync(path.join(ROOT_DIR, '.visual-atmosphere-test-'));
  try {
    const source = fs.readFileSync(
      path.join(ROOT_DIR, 'src/world/VisualAtmosphere.ts'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'VisualAtmosphere.mjs'),
      stripTypeScriptTypes(source)
    );
    return await import(
      pathToFileURL(path.join(tmpDir, 'VisualAtmosphere.mjs')).href
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('VisualAtmosphere: sky distances, sun vectors, and surface variation are bounded', async () => {
  const visual = await loadVisualAtmosphere();

  for (const quality of ['low', 'medium', 'high']) {
    assert.ok(
      visual.getCameraFarForQuality(quality) > visual.SKY_DOME_RADIUS,
      `${quality} camera far must include the camera-centred sky dome`
    );
  }
  assert.ok(visual.SUN_DISTANCE < visual.STARFIELD_RADIUS);
  assert.ok(visual.STARFIELD_RADIUS < visual.SKY_DOME_RADIUS);

  for (const preset of ['day', 'sunset', 'night']) {
    const direction = visual.getSunDirection(preset);
    const length = Math.hypot(direction.x, direction.y, direction.z);
    assert.ok(Math.abs(length - 1) < 1e-9, `${preset} sun direction is normalized`);
    const environment = visual.getEnvironmentPreset(preset);
    assert.ok(environment.sunU >= 0 && environment.sunU <= 1);
    assert.ok(environment.sunV >= 0 && environment.sunV <= 1);
    assert.ok(environment.intensity > 0 && environment.intensity < 0.5);
  }

  const first = visual.getSurfaceVariation(37.25, -81.5);
  assert.equal(first, visual.getSurfaceVariation(37.25, -81.5));
  for (let x = -230; x <= 230; x += 23) {
    for (let z = -230; z <= 230; z += 23) {
      const value = visual.getSurfaceVariation(x, z);
      assert.ok(value >= -1 && value <= 1);
    }
  }
});

test('VisualAtmosphere: Auto graphics is conservative and explicit choices win', async () => {
  const { resolveGraphicsQuality } = await loadVisualAtmosphere();

  assert.equal(
    resolveGraphicsQuality('low', {
      coarsePointer: false,
      hardwareConcurrency: 16,
      deviceMemoryGb: 16,
      devicePixelRatio: 1,
    }),
    'low'
  );
  assert.equal(
    resolveGraphicsQuality('auto', {
      coarsePointer: false,
      hardwareConcurrency: 8,
      deviceMemoryGb: 8,
      devicePixelRatio: 1,
    }),
    'high'
  );
  assert.equal(
    resolveGraphicsQuality('auto', {
      coarsePointer: true,
      hardwareConcurrency: 8,
      deviceMemoryGb: 8,
      devicePixelRatio: 2,
    }),
    'high'
  );
  assert.equal(
    resolveGraphicsQuality('auto', {
      coarsePointer: true,
      hardwareConcurrency: 6,
      deviceMemoryGb: 4,
      devicePixelRatio: 2.5,
    }),
    'medium'
  );
  assert.equal(
    resolveGraphicsQuality('auto', {
      coarsePointer: true,
      hardwareConcurrency: 4,
      deviceMemoryGb: 3,
      devicePixelRatio: 2,
    }),
    'low'
  );
  assert.equal(
    resolveGraphicsQuality('auto', {
      coarsePointer: false,
      hardwareConcurrency: 12,
      deviceMemoryGb: 12,
      saveData: true,
    }),
    'low'
  );
});

test('VisualAtmosphere: foliage wind uses one shared GPU time uniform', async () => {
  const THREE = await import('three');
  const visual = await loadVisualAtmosphere();
  const material = new THREE.MeshStandardMaterial({ color: 0x22c55e });
  const returned = visual.applyFoliageWind(material, {
    strength: 0.04,
    baseY: -1,
    height: 2,
  });
  assert.equal(returned, material);
  assert.match(material.customProgramCacheKey(), /cicraft-foliage-wind/);

  const shader = {
    uniforms: {},
    vertexShader: 'void main() { #include <begin_vertex> }',
  };
  material.onBeforeCompile(shader);
  assert.equal(shader.uniforms.uWindTime, visual.foliageWindUniforms.uWindTime);
  assert.equal(
    shader.uniforms.uWindGlobalStrength,
    visual.foliageWindUniforms.uWindGlobalStrength
  );
  assert.equal(shader.uniforms.uWindStrength.value, 0.04);
  assert.match(shader.vertexShader, /instanceMatrix\[3\]\[0\]/);
  assert.match(shader.vertexShader, /transformed\.x \+= cicraftWindAmount/);

  visual.setFoliageWindTime(12.5);
  visual.setFoliageWindStrength(2);
  assert.equal(visual.foliageWindUniforms.uWindTime.value, 12.5);
  assert.equal(visual.foliageWindUniforms.uWindGlobalStrength.value, 1);
  visual.setFoliageWindStrength(-1);
  assert.equal(visual.foliageWindUniforms.uWindGlobalStrength.value, 0);
  visual.setFoliageWindStrength(1);
});

test('Phase 1 presentation integration stays wired without replacing gameplay systems', () => {
  const read = (relativePath) =>
    fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8');

  const engine = read('src/core/GameEngine.ts');
  assert.match(engine, /PMREMGenerator/);
  assert.match(engine, /fromEquirectangular/);
  assert.match(engine, /outputColorSpace = THREE\.SRGBColorSpace/);
  assert.match(engine, /shadow\.normalBias/);
  assert.match(engine, /dirLight\.position\.copy\(this\.dirLightTarget\.position\)\.add\(this\.sunOffset\)/);
  assert.match(engine, /setAdaptiveDetailReduced/);
  assert.match(engine, /getResolvedGraphicsQuality/);
  assert.doesNotMatch(engine, /dirLight\.position\.set\(tx \+ 115, 165, tz \+ 95\)/);

  const terrain = read('src/world/TerrainGenerator.ts');
  assert.match(terrain, /skyGroup\.position\.copy\(cameraPosition\)/);
  assert.match(terrain, /AtmosphericSkyDome/);
  assert.match(terrain, /fog: false/);
  assert.match(terrain, /waterBumpTexture/);
  assert.doesNotMatch(terrain, /SphereGeometry\(720/);

  const island = read('src/world/IslandWorld.ts');
  const expansion = read('src/world/MapExpansionBuilder.ts');
  assert.match(island, /applyFoliageWind/);
  assert.match(expansion, /applyFoliageWind/);
  assert.match(island, /this\.terrain\.update\(dt, cameraPos\)/);

  const storm = read('src/systems/StormSystem.ts');
  assert.match(storm, /safeZoneRingMesh\.scale\.set\(targetRadius, 1, targetRadius\)/);
  assert.match(storm, /syncVisuals\(state: MatchState, dt: number = 0\)/);

  const particles = read('src/systems/ParticleSystem.ts');
  assert.match(particles, /setQualityScale/);
  assert.match(particles, /p\.baseScale \?\?= p\.mesh\.scale\.clone\(\)/);
  assert.match(particles, /AdditiveBlending/);

  const html = read('index.html');
  const schema = read('src/network/schemas.ts');
  assert.match(html, /<option value="auto" selected>Auto \(Recommended\)<\/option>/);
  assert.match(schema, /graphicsQuality: 'auto' \| 'low' \| 'medium' \| 'high'/);

  const css = read('src/styles/main.css');
  assert.match(css, /@keyframes hud-banner-in/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
