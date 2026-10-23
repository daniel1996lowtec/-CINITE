/**
 * CI CRAFT 8.4 — distant-scenery structure.
 *
 * 8.3 allow-listed `/DistantBackdrop/` in the geometry audit because those
 * cones are legitimately 90 m across. That fixed the false positive but created
 * a blind spot: once a mesh is exempt from the size checks, nothing looked at it
 * again. The eight background mountains were cones lofted with six radial
 * segments and carried a "snow cap" that was built *inside* the rock cone, so
 * they rendered as bare flat slate-grey hexagonal pyramids — the flat grey
 * triangles visible over the skyline.
 *
 * These tests do not re-check what the audit already covers (size, finiteness).
 * They assert the two things that were actually wrong and that no amount of
 * size-checking would ever have caught:
 *
 *   1. The snow cap is strictly outside the rock surface at every height, so it
 *      can actually draw and cannot z-fight through the mountain.
 *   2. The silhouette is tessellated finely enough not to read as a prism.
 *
 * Both are measured from the geometry's own parameters and world transforms, so
 * they fail on the pre-8.4 code and pass on the fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadWorldModules } from '../scripts/headlessWorld.mjs';

let cached = null;
async function world() {
  if (cached) return cached;
  const { IslandWorld } = await loadWorldModules();
  const scene = new THREE.Scene();
  const instance = new IslandWorld(scene);
  instance.generate();
  scene.updateMatrixWorld(true);
  cached = { scene, instance };
  return cached;
}

function backdropPairs(scene) {
  const peaks = [];
  const caps = [];
  scene.traverse((o) => {
    if (o.name === 'DistantBackdropPeak') peaks.push(o);
    if (o.name === 'DistantBackdropSnowCap') caps.push(o);
  });
  return peaks.map((peak) => ({
    peak,
    cap: caps.find(
      (c) =>
        Math.abs(c.position.x - peak.position.x) < 1e-6 &&
        Math.abs(c.position.z - peak.position.z) < 1e-6
    ),
  }));
}

/** Vertical extent of a cone mesh in world space, from its own parameters. */
function coneProfile(mesh) {
  const h = mesh.geometry.parameters.height;
  const r = mesh.geometry.parameters.radius;
  return { base: mesh.position.y - h / 2, apex: mesh.position.y + h / 2, height: h, radius: r };
}

const radiusAt = (profile, y) => {
  if (y < profile.base || y > profile.apex) return 0;
  return profile.radius * ((profile.apex - y) / profile.height);
};

test('8.4 backdrop: every mountain has a snow cap', async () => {
  const { scene } = await world();
  const pairs = backdropPairs(scene);
  assert.ok(pairs.length > 0, 'no distant backdrop peaks were generated');
  for (const { peak, cap } of pairs) {
    assert.ok(cap, `${peak.name} at (${peak.position.x.toFixed(0)}, ${peak.position.z.toFixed(0)}) has no snow cap`);
  }
});

test('8.4 backdrop: the snow cap sits strictly outside the rock at every height', async () => {
  const { scene } = await world();
  const offenders = [];
  for (const { peak, cap } of backdropPairs(scene)) {
    const rock = coneProfile(peak);
    const snow = coneProfile(cap);
    // The cap must reach the summit and clear the rock along its whole length.
    if (snow.apex < rock.apex) {
      offenders.push(`cap apex ${snow.apex.toFixed(2)} is below peak apex ${rock.apex.toFixed(2)}`);
      continue;
    }
    let worst = Infinity;
    for (let k = 0; k <= 20; k++) {
      const y = snow.base + ((snow.apex - snow.base) * k) / 20;
      if (y > rock.apex) break; // above the rock: nothing to fight with
      const clearance = radiusAt(snow, y) - radiusAt(rock, y);
      worst = Math.min(worst, clearance);
    }
    if (!(worst > 0)) {
      offenders.push(
        `cap is ${Math.abs(worst).toFixed(2)} m inside the rock surface ` +
          `(peak h=${rock.height} r=${rock.radius})`
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'snow caps are buried inside the mountains and can never be drawn: ' + offenders.join('; ')
  );
});

test('8.4 backdrop: mountains are tessellated enough not to read as flat pyramids', async () => {
  const { scene } = await world();
  for (const { peak, cap } of backdropPairs(scene)) {
    const segs = peak.geometry.parameters.radialSegments;
    assert.ok(
      segs >= 12,
      `${peak.name} has only ${segs} radial segments — a ${segs}-sided prism silhouettes as a flat ` +
        'grey pyramid against the sky'
    );
    assert.ok(cap.geometry.parameters.radialSegments >= 12, 'snow cap tessellation must match the rock');
  }
});

test('8.4 backdrop: the base polygon is finely tessellated, not a prism', async () => {
  const { scene } = await world();
  for (const { peak, cap } of backdropPairs(scene)) {
    for (const mesh of [peak, cap]) {
      const geo = mesh.geometry;
      const pos = geo.attributes.position;
      const index = geo.index;
      const radius = geo.parameters.radius;
      // Measure the silhouette directly: the angular spacing of the vertices
      // around the base rim. The bottom disc's radial spokes are exactly one
      // radius long at any segment count, so edge length cannot distinguish a
      // 6-gon from an 18-gon — corner spacing can.
      const angles = [];
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        if (Math.abs(Math.hypot(x, z) - radius) < radius * 0.02) angles.push(Math.atan2(z, x));
      }
      assert.ok(angles.length >= 3, `${mesh.name} has no measurable base rim`);
      angles.sort((a, b) => a - b);
      let maxGap = 0;
      for (let i = 0; i < angles.length; i++) {
        const next = i === angles.length - 1 ? angles[0] + Math.PI * 2 : angles[i + 1];
        maxGap = Math.max(maxGap, next - angles[i]);
      }
      const maxGapDeg = (maxGap * 180) / Math.PI;
      assert.ok(
        maxGapDeg <= 31,
        `${mesh.name} has a ${maxGapDeg.toFixed(0)}° corner gap on its base rim — ` +
          'the silhouette is under-tessellated and reads as a flat-sided pyramid'
      );
    }
  }
});
