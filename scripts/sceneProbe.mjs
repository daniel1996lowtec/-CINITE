/**
 * CI CRAFT 8.4 — scene probe.
 *
 * Answers "what is that thing on screen?" by raycasting a grid through a camera
 * and naming the first object each ray hits. It exists because the 8.3 work
 * learnt the hard way that a rendered artefact must be identified by raycast,
 * never by eye: the grey slab that looked exactly like an over-tall kerb turned
 * out to be the bridge parapet, and a "flat grey pyramid" on the skyline turned
 * out to be a backdrop cone whose snow cap was built inside it.
 *
 * The probe is deliberately raycast-only and geometry-only. It names meshes,
 * their world bounds, materials and distances. It does NOT prove anything about
 * shading, depth precision, shadow acne, tone mapping or WebGL output — those
 * need a real browser (see CI_CRAFT_8_4.md, "What this cannot tell you").
 *
 * Usage:
 *   node scripts/sceneProbe.mjs --eye -8,72,18 --look -56,46.5,46
 *   node scripts/sceneProbe.mjs --scene roads-3
 *   node scripts/sceneProbe.mjs --scene roads-3 --grid 24x14 --near 3
 *
 * Defaults to a 20x11 grid, a 3 m "in your face" radius and a 62 degree fov.
 */
import * as THREE from 'three';
import { loadWorldModules } from './headlessWorld.mjs';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const { IslandWorld } = await loadWorldModules();
const scene = new THREE.Scene();
const world = new IslandWorld(scene);
world.generate();
scene.updateMatrixWorld(true);

const ground = (x, z) => world.terrain.getTerrainHeight(x, z);
const at = (x, z, height = 1.75) => new THREE.Vector3(x, ground(x, z) + height, z);
const eyeAt = (x, z, height) => at(x, z, height);

// Mirrors scripts/offlineRender.mjs so a probe matches the frame it explains.
const VIEWPOINTS = {
  'roads-3': [eyeAt(-8, 72, 18), new THREE.Vector3(-56, ground(-56, 46) + 0.5, 46), 62],
  'roads-4': [eyeAt(120, -78, 6), new THREE.Vector3(150, ground(150, -100) + 1.0, -100), 64],
  plaza: [eyeAt(18, 30, 1.75), new THREE.Vector3(18, ground(18, 16) + 2.4, 16), 62],
  docks: [eyeAt(-112, 116, 1.75), new THREE.Vector3(-92, ground(-92, 100) + 3.0, 100), 62],
  keep: [eyeAt(110, -84, 2.0), new THREE.Vector3(84, ground(84, -80) + 4.0, -80), 64],
};

let eye;
let target;
let fov;
const sceneKey = argValue('scene', null);
if (sceneKey) {
  const vp = VIEWPOINTS[sceneKey];
  if (!vp) {
    console.error(`unknown scene "${sceneKey}" — pick one of: ${Object.keys(VIEWPOINTS).join(', ')}`);
    process.exit(2);
  }
  [eye, target, fov] = vp;
} else {
  const e = argValue('eye', null);
  const l = argValue('look', null);
  if (!e || !l) {
    console.error('give --scene <name> or both --eye x,z,height and --look x,y,z');
    process.exit(2);
  }
  const [ex, ez, eh] = e.split(',').map(Number);
  const [lx, ly, lz] = l.split(',').map(Number);
  eye = at(ex, ez, Number.isFinite(eh) ? eh : 1.75);
  target = new THREE.Vector3(lx, ly, lz);
  fov = Number(argValue('fov', '62'));
}

const [gw, gh] = argValue('grid', '20x11').split('x').map(Number);
const nearRadius = Number(argValue('near', '3'));
const aspect = 16 / 9;

const camera = new THREE.PerspectiveCamera(fov, aspect, 0.15, 520);
camera.position.copy(eye);
camera.lookAt(target);
camera.updateMatrixWorld(true);

const raycaster = new THREE.Raycaster();

const colourOf = (material) => {
  const m = Array.isArray(material) ? material[0] : material;
  if (!m) return '?';
  if (m.color) return `#${m.color.getHexString()}`;
  if (m.vertexColors) return 'vertexColours';
  return m.type;
};

const chainName = (object) => {
  const names = [];
  let node = object;
  while (node && node !== scene) {
    if (node.name) names.push(node.name);
    node = node.parent;
  }
  return names.length ? names.reverse().join(' > ') : `(unnamed ${object.type})`;
};

const coverage = new Map();
const nearMisses = new Map();
let rays = 0;
let misses = 0;

for (let gy = 0; gy < gh; gy++) {
  for (let gx = 0; gx < gw; gx++) {
    // Sample cell centres so the outer row does not hug the frustum edge.
    const sxp = ((gx + 0.5) / gw) * 2 - 1;
    const syp = -(((gy + 0.5) / gh) * 2 - 1);
    raycaster.setFromCamera(new THREE.Vector2(sxp, syp), camera);
    // The sky dome encloses the camera; ignore it when asking what is visible.
    const hits = raycaster.intersectObjects(scene.children, true).filter((h) => {
      const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
      return !(m && m.depthTest === false);
    });
    rays++;
    if (!hits.length) {
      misses++;
      continue;
    }
    const first = hits[0];
    // Group by object identity, not by display name: many distinct props share
    // a name (or have none), and merging them reports one object's bounds for
    // another object's pixels.
    const entry = coverage.get(first.object.uuid) ?? { object: first.object, count: 0, nearest: Infinity };
    entry.count++;
    entry.nearest = Math.min(entry.nearest, first.distance);
    coverage.set(first.object.uuid, entry);
    if (first.distance <= nearRadius) {
      const prev = nearMisses.get(first.object.uuid);
      if (!prev || first.distance < prev.distance) {
        nearMisses.set(first.object.uuid, {
          distance: first.distance,
          colour: colourOf(first.object.material),
          object: first.object,
        });
      }
    }
  }
}

console.log('CI CRAFT scene probe');
console.log(`  camera at (${eye.x.toFixed(1)}, ${eye.y.toFixed(1)}, ${eye.z.toFixed(1)})`);
console.log(`  looking at (${target.x.toFixed(1)}, ${target.y.toFixed(1)}, ${target.z.toFixed(1)}), fov ${fov}`);
console.log(`  ${rays} rays, ${misses} hit nothing, ${((misses / rays) * 100).toFixed(1)} % open sky/fog`);
console.log('');
console.log('  screen coverage (first visible surface per ray):');
const boxOf = (object) => {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  return { box, size };
};
const ranked = [...coverage.values()].sort((a, b) => b.count - a.count);
for (const entry of ranked.slice(0, 12)) {
  const pct = (entry.count / rays) * 100;
  const { size } = boxOf(entry.object);
  console.log(
    `    ${pct.toFixed(1).padStart(5)}%  ${chainName(entry.object)}  ` +
      `[${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)} m, ` +
      `nearest ${entry.nearest.toFixed(1)} m, ${colourOf(entry.object.material)}]`
  );
}
if (nearMisses.size) {
  console.log('');
  console.log(`  within ${nearRadius} m of the camera (props filling the frame):`);
  for (const info of [...nearMisses.values()].sort((a, b) => a.distance - b.distance)) {
    const { box } = boxOf(info.object);
    console.log(
      `    ${info.distance.toFixed(2).padStart(6)} m  ${chainName(info.object)}  ${info.colour}  ` +
        `at (${((box.min.x + box.max.x) / 2).toFixed(0)}, ${((box.min.z + box.max.z) / 2).toFixed(0)})`
    );
  }
}

// Locate the biggest contributor so an artefact can be found in the world.
if (ranked[0]) {
  const top = ranked[0].object;
  const { box, size } = boxOf(top);
  console.log('');
  console.log(`  largest contributor: ${chainName(top)}`);
  console.log(`  bounds x ${box.min.x.toFixed(1)}..${box.max.x.toFixed(1)}  ` +
    `y ${box.min.y.toFixed(1)}..${box.max.y.toFixed(1)}  z ${box.min.z.toFixed(1)}..${box.max.z.toFixed(1)}`);
  console.log(`  size ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} m, ` +
    `${top.geometry.attributes.position.count} vertices, material ${colourOf(top.material)}`);
}
