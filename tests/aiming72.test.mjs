/**
 * CI CRAFT 7.2 — precision shooting, hit registration and server-authoritative
 * combat.
 *
 * These are not mock tests of a helper: the aim solver, the camera class, the
 * shared hitbox model and the server's hit validation are the real modules the
 * game runs. What is NOT covered here is anything that needs a GPU or a second
 * human player — see `CI_CRAFT_7_2.md` for the manual verification checklist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PLAYER_HITBOX_PARTS,
  PLAYER_HITBOX_HEIGHT,
  raycastPlayer,
  raycastPlayers,
  SERVER_HIT_TOLERANCE,
} from '../shared/hitbox.mjs';
import {
  MAX_LAG_COMPENSATION_MS,
  recordPositionHistory,
  raycastVictimLagCompensated,
  sanitizeFireOrigin,
  sanitizeDirection,
} from '../server/hitValidation.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadAimSolver() {
  const source = path.join(ROOT_DIR, 'src/weapons/AimSolver.ts');
  const code = stripTypeScriptTypes(fs.readFileSync(source, 'utf8'), { mode: 'strip' });
  const tmpDir = fs.mkdtempSync(path.join(ROOT_DIR, '.aiming72-'));
  const file = path.join(tmpDir, 'AimSolver.mjs');
  fs.writeFileSync(file, code);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Loads the real ThirdPersonCamera with its relative imports rewritten. */
async function loadCamera() {
  const tmpDir = fs.mkdtempSync(path.join(ROOT_DIR, '.aiming72-cam-'));
  const emit = (source, output, replacements = []) => {
    let code = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT_DIR, source), 'utf8'));
    for (const [pattern, replacement] of replacements) code = code.replace(pattern, replacement);
    fs.writeFileSync(path.join(tmpDir, output), code);
  };
  try {
    emit('src/network/schemas.ts', 'schemas.mjs');
    emit('src/weapons/WeaponDefinitions.ts', 'WeaponDefinitions.mjs', [
      [/import\s+\{[\s\S]*?\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
    ]);
    emit('src/input/touchInputMath.ts', 'touchInputMath.mjs');
    // ThirdPersonCamera only uses IslandWorld as a type, but the value import
    // survives type stripping, so point it at a stub rather than drag the whole
    // world generator (and its asset graph) into this test.
    fs.writeFileSync(path.join(tmpDir, 'IslandWorldStub.mjs'), 'export class IslandWorld {}\n');
    emit('src/camera/ThirdPersonCamera.ts', 'ThirdPersonCamera.mjs', [
      // PlayerState / WeaponCategory are types; type stripping removes their
      // annotations but not the import statement, so drop it.
      [
        /import\s*\{[^}]*\}\s*from\s*['"]\.\.\/network\/schemas['"];?\n?/,
        '',
      ],
      ["from '../weapons/WeaponDefinitions'", "from './WeaponDefinitions.mjs'"],
      ["from '../input/touchInputMath'", "from './touchInputMath.mjs'"],
      ["from '../world/IslandWorld'", "from './IslandWorldStub.mjs'"],
    ]);
    const THREE = await import('three');
    const camera = await import(pathToFileURL(path.join(tmpDir, 'ThirdPersonCamera.mjs')).href);
    return { THREE, camera };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const V = (x, y, z) => ({ x, y, z });
const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.hypot(a.x, a.y, a.z);
const normalize = (a) => {
  const l = len(a) || 1;
  return V(a.x / l, a.y / l, a.z / l);
};
const addScaled = (a, b, s) => V(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);

/** Distance from a point to a ray. Zero means the ray goes exactly through it. */
function pointRayDistance(origin, direction, point) {
  const w = sub(point, origin);
  const t = dot(w, direction);
  if (t < 0) return len(w);
  return len(sub(addScaled(origin, direction, t), point));
}

/**
 * Reproduces the real hip-fire rig from ThirdPersonCamera.update():
 * the camera sits `shoulder` metres to the right of the pivot and `followDist`
 * behind it, then looks at a point 32 m along the yaw/pitch axis.
 */
function cameraRig(yaw, pitch, playerPosition) {
  const forward = V(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch)
  );
  const right = V(Math.cos(yaw), 0, -Math.sin(yaw));
  const pivot = V(playerPosition.x, playerPosition.y + 1.95, playerPosition.z);
  const cameraOrigin = addScaled(addScaled(pivot, right, 1.05), forward, -4.4);
  const lookAt = addScaled(pivot, forward, 32);
  return { forward, cameraOrigin, cameraDirection: normalize(sub(lookAt, cameraOrigin)) };
}

/** Muzzle roughly where CharacterMesh's weapon socket puts it. */
function muzzleFor(yaw, playerPosition) {
  const forward = V(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = V(Math.cos(yaw), 0, -Math.sin(yaw));
  return addScaled(
    addScaled(V(playerPosition.x, playerPosition.y + 1.22, playerPosition.z), forward, 0.75),
    right,
    0.18
  );
}

/** Empty world: nothing blocks. */
const openWorld = () => null;

/* ------------------------------------------------------------------ */
/* 1. The reported bug: crosshair on target, shot misses               */
/* ------------------------------------------------------------------ */

test('7.2 the camera ray is the ray through the centre of the screen', async () => {
  const { camera, THREE } = await loadCamera();
  const tp = new camera.ThirdPersonCamera(16 / 9);

  const player = {
    id: 'player_local_1',
    position: { x: 12, y: 3, z: -7 },
    inventory: [
      { category: 'assault_rifle', rarity: 'common', clipAmmo: 30, maxClipAmmo: 30 },
    ],
    activeSlot: 0,
    isAiming: false,
    isSprinting: false,
    isGliding: false,
  };

  const stubWorld = {
    terrain: { getTerrainHeight: () => -100 },
    boxColliders: [],
  };

  for (const [yaw, pitch] of [
    [0, 0],
    [0.7, 0.12],
    [-2.1, -0.18],
    [Math.PI, 0.3],
  ]) {
    tp.yaw = yaw;
    tp.pitch = pitch;
    // Several frames so the smoothed camera position has settled, as it would
    // be during normal play.
    for (let i = 0; i < 120; i++) tp.update(player, 1 / 60, stubWorld);

    const ray = tp.getCameraRay();
    const expected = new THREE.Vector3();
    tp.camera.getWorldDirection(expected);

    assert.ok(
      ray.origin.distanceTo(tp.camera.position) < 1e-6,
      'camera ray must start at the camera'
    );
    assert.ok(
      ray.direction.distanceTo(expected) < 1e-6,
      'camera ray must match the rendered view direction'
    );

    // The rendered direction is *not* the raw yaw/pitch axis, because the camera
    // is offset on the shoulder. If these ever become equal, the shoulder offset
    // silently disappeared.
    const axis = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch)
    ).normalize();
    assert.ok(
      ray.direction.angleTo(axis) > 0.005,
      'camera ray should differ from the yaw/pitch axis on a shoulder-offset rig'
    );
  }
});

test('7.2 a centred target is hit at every range (the 6.2 rig missed by up to 1.3 m)', async () => {
  const { resolveAim } = await loadAimSolver();

  for (const yaw of [0, 1.1, -2.4]) {
    const playerPosition = V(0, 0, 0);
    const { cameraOrigin, cameraDirection, forward } = cameraRig(yaw, 0, playerPosition);
    const muzzle = muzzleFor(yaw, playerPosition);

    // The legacy rig: a ray from the shoulder along the raw yaw/pitch axis.
    const legacyOrigin = addScaled(V(0, 1.55, 0), forward, 0.55);

    for (const distance of [7, 12, 25, 50, 90]) {
      const target = addScaled(cameraOrigin, cameraDirection, distance);

      const legacyMiss = pointRayDistance(legacyOrigin, forward, target);
      assert.ok(
        legacyMiss > 0.34,
        `regression baseline broken: legacy ray should miss a ${distance} m target (miss ${legacyMiss.toFixed(2)} m)`
      );

      const solution = resolveAim({
        cameraOrigin,
        cameraDirection,
        muzzle,
        range: 150,
        castWorld: openWorld,
        castTargets: (origin, direction, maxDist) =>
          raycastPlayer(
            origin.x,
            origin.y,
            origin.z,
            direction.x,
            direction.y,
            direction.z,
            target.x,
            target.y - 1.0, // put the target's chest under the crosshair
            target.z,
            maxDist
          )
            ? { targetId: 'enemy', distance: distance, point: target }
            : null,
      });

      assert.equal(solution.crosshairTargetId, 'enemy');

      // The muzzle ray must actually pass through the point the player aimed at.
      const miss = pointRayDistance(
        solution.fireOrigin,
        solution.fireDirection,
        target
      );
      assert.ok(
        miss < 0.02,
        `muzzle ray misses the aim point by ${miss.toFixed(3)} m at ${distance} m`
      );

      // And it must intersect the body hitbox, not merely pass nearby.
      const hit = raycastPlayer(
        solution.fireOrigin.x,
        solution.fireOrigin.y,
        solution.fireOrigin.z,
        solution.fireDirection.x,
        solution.fireDirection.y,
        solution.fireDirection.z,
        target.x,
        target.y - 1.0,
        target.z,
        150
      );
      assert.ok(hit, `no hitbox intersection at ${distance} m`);
      assert.equal(hit.part, 'torso');
    }
  }
});

test('7.2 aim converges with distance instead of firing parallel to the view', async () => {
  const { resolveAim } = await loadAimSolver();
  const rig = cameraRig(0, 0, V(0, 0, 0));
  const muzzle = muzzleFor(0, V(0, 0, 0));

  const directions = [];
  for (const distance of [6, 60]) {
    const target = addScaled(rig.cameraOrigin, rig.cameraDirection, distance);
    const solution = resolveAim({
      cameraOrigin: rig.cameraOrigin,
      cameraDirection: rig.cameraDirection,
      muzzle,
      range: 150,
      castWorld: openWorld,
      castTargets: () => ({ targetId: 'enemy', distance, point: target }),
    });
    directions.push({ distance, target, solution });
  }

  // Aiming at something 6 m away and something 60 m away must produce different
  // muzzle directions. A parallel-fire implementation produces the same one.
  const angle = Math.acos(
    Math.min(
      1,
      dot(directions[0].solution.fireDirection, directions[1].solution.fireDirection)
    )
  );
  assert.ok(
    angle > 0.01,
    'muzzle direction did not change between near and far targets'
  );
});

/* ------------------------------------------------------------------ */
/* 2. Hitboxes                                                         */
/* ------------------------------------------------------------------ */

test('7.2 hitboxes are contiguous, aligned to the art, and cannot hit empty air', () => {
  // Measured from the real CharacterMesh (see CI_CRAFT_7_2.md): head y 1.49-1.95
  // with a 0.17-0.20 radius, torso y 0.88-1.50 at x +/-0.32.
  assert.equal(PLAYER_HITBOX_HEIGHT, 1.95);

  const sorted = [...PLAYER_HITBOX_PARTS].sort((a, b) => a.minY - b.minY);
  assert.equal(sorted[0].minY, 0, 'hitbox must start at the feet');
  assert.equal(sorted[sorted.length - 1].maxY, PLAYER_HITBOX_HEIGHT);

  for (let i = 1; i < sorted.length; i++) {
    assert.equal(
      sorted[i].minY,
      sorted[i - 1].maxY,
      `gap between ${sorted[i - 1].part} and ${sorted[i].part}`
    );
  }

  const torso = PLAYER_HITBOX_PARTS.find((p) => p.part === 'torso');
  const head = PLAYER_HITBOX_PARTS.find((p) => p.part === 'head');
  assert.ok(torso.radius >= 0.3 && torso.radius <= 0.36, 'torso radius must hug the mesh');
  assert.ok(head.radius >= 0.16 && head.radius <= 0.22, 'head radius must hug the mesh');
  assert.equal(head.headshot, true);
  assert.equal(torso.headshot, false);

  // The old single cylinder was 0.54 m. Anything near that is "impossible hits".
  for (const part of PLAYER_HITBOX_PARTS) {
    assert.ok(part.radius < 0.4, `${part.part} radius ${part.radius} is too generous`);
  }
});

test('7.2 a shot through the body always finds a part, and the head is a real headshot', () => {
  const feet = V(0, 0, 0);
  for (const height of [0.05, 0.4, 0.87, 0.89, 1.2, 1.49, 1.51, 1.8, 1.94]) {
    const hit = raycastPlayer(
      -10,
      height,
      0,
      1,
      0,
      0,
      feet.x,
      feet.y,
      feet.z,
      100
    );
    assert.ok(hit, `nothing hit at height ${height}`);
    assert.ok(Math.abs(hit.point.y - height) < 1e-6);
  }

  const headHit = raycastPlayer(-10, 1.7, 0, 1, 0, 0, 0, 0, 0, 100);
  assert.equal(headHit.part, 'head');
  assert.equal(headHit.headshot, true);

  const torsoHit = raycastPlayer(-10, 1.1, 0, 1, 0, 0, 0, 0, 0, 100);
  assert.equal(torsoHit.part, 'torso');
  assert.equal(torsoHit.headshot, false);

  // Just above the head: a genuine miss.
  assert.equal(raycastPlayer(-10, 2.05, 0, 1, 0, 0, 0, 0, 0, 100), null);
  // Just outside the torso: also a miss. This is the "impossible hit" fix.
  assert.equal(raycastPlayer(-10, 1.1, 0.45, 1, 0, 0, 0, 0, 0, 100), null);
});

test('7.2 a shooter can never hit themselves, and the nearest body wins', () => {
  const players = [
    { id: 'shooter', position: V(0, 0, 0) },
    { id: 'near', position: V(0, 0, -5) },
    { id: 'far', position: V(0, 0, -20) },
  ];

  const hit = raycastPlayers(0, 1.1, 0, 0, 0, -1, players, 100, 0, 'shooter');
  assert.ok(hit);
  assert.equal(hit.id, 'near');

  const onlyShooter = [{ id: 'shooter', position: V(0, 0, 0) }];
  assert.equal(raycastPlayers(0, 1.1, 0, 0, 0, -1, onlyShooter, 100, 0, 'shooter'), null);
});

/* ------------------------------------------------------------------ */
/* 3. Obstruction                                                      */
/* ------------------------------------------------------------------ */

test('7.2 cover stops the shot and the crosshair stops promising a hit', async () => {
  const { resolveAim } = await loadAimSolver();
  const playerPosition = V(0, 0, 0);
  const { cameraOrigin, cameraDirection } = cameraRig(0, 0, playerPosition);
  const muzzle = muzzleFor(0, playerPosition);

  /**
   * A vertical wall in front of the operator, optionally with a limited height
   * so that the elevated camera can see over it while the muzzle cannot.
   */
  const wallWorld = (distanceInFront, topY = Infinity) => (origin, direction, maxDist) => {
    const wallZ = playerPosition.z - distanceInFront;
    if (Math.abs(direction.z) < 1e-6) return null;
    const t = (wallZ - origin.z) / direction.z;
    if (t <= 0 || t > maxDist) return null;
    const y = origin.y + direction.y * t;
    if (y > topY) return null;
    return { distance: t, point: { x: origin.x + direction.x * t, y, z: wallZ } };
  };

  // --- Case A: a full-height wall. Nothing behind it is targetable. --------
  const tallSolution = resolveAim({
    cameraOrigin,
    cameraDirection,
    muzzle,
    range: 150,
    castWorld: wallWorld(12),
    castTargets: (origin, direction, maxDist) =>
      maxDist >= 30
        ? { targetId: 'enemy', distance: 30, point: addScaled(cameraOrigin, cameraDirection, 30) }
        : null,
  });

  assert.equal(tallSolution.cameraBlocked, true);
  assert.equal(tallSolution.crosshairTargetId, null, 'crosshair must not target through a wall');
  assert.ok(
    Math.abs(tallSolution.aimPoint.z - (playerPosition.z - 12)) < 1e-6,
    'aim point must be the wall, not the enemy behind it'
  );
  assert.equal(tallSolution.predictedTargetId, null, 'no hit may be predicted through cover');
});

test('7.2 low cover: the crosshair sees the enemy but the muzzle is blocked', async () => {
  const { resolveAim } = await loadAimSolver();
  const playerPosition = V(0, 0, 0);
  const { cameraOrigin, cameraDirection } = cameraRig(0, 0, playerPosition);
  const muzzle = muzzleFor(0, playerPosition);

  // Waist-high wall 5 m ahead. The camera is 1.95 m up and 4.4 m back, so its
  // sightline clears it; the muzzle at 1.22 m does not.
  const wallZ = playerPosition.z - 5;
  const wallTopY = 1.55;
  const castWorld = (origin, direction, maxDist) => {
    if (Math.abs(direction.z) < 1e-6) return null;
    const t = (wallZ - origin.z) / direction.z;
    if (t <= 0 || t > maxDist) return null;
    const y = origin.y + direction.y * t;
    if (y > wallTopY) return null;
    return { distance: t, point: { x: origin.x + direction.x * t, y, z: wallZ } };
  };

  const enemyFeet = addScaled(playerPosition, V(0, 0, -1), 25);
  const enemyCentre = V(enemyFeet.x, enemyFeet.y + 1.2, enemyFeet.z);

  const solution = resolveAim({
    cameraOrigin,
    cameraDirection,
    muzzle,
    range: 150,
    castWorld,
    castTargets: (origin, direction, maxDist) =>
      maxDist >= 20
        ? { targetId: 'enemy', distance: 20, point: enemyCentre }
        : null,
  });

  // The crosshair is legitimately on the enemy...
  assert.equal(solution.crosshairTargetId, 'enemy');
  // ...but the bullet cannot get there. This is the state the HUD must not
  // present as a guaranteed hit.
  assert.equal(solution.muzzleObstructed, true, 'muzzle ray must report the waist-high wall');
  assert.equal(solution.predictedTargetId, null, 'no hit may be predicted through the wall');
});

test('7.2 an unobstructed shot reports the predicted target', async () => {
  const { resolveAim } = await loadAimSolver();
  const playerPosition = V(0, 0, 0);
  const { cameraOrigin, cameraDirection } = cameraRig(0, 0, playerPosition);
  const muzzle = muzzleFor(0, playerPosition);
  const target = addScaled(cameraOrigin, cameraDirection, 25);

  const solution = resolveAim({
    cameraOrigin,
    cameraDirection,
    muzzle,
    range: 150,
    castWorld: openWorld,
    castTargets: (origin, direction, maxDist) => {
      const hit = raycastPlayer(
        origin.x,
        origin.y,
        origin.z,
        direction.x,
        direction.y,
        direction.z,
        target.x,
        target.y - 1.0,
        target.z,
        maxDist
      );
      return hit ? { targetId: 'enemy', distance: hit.t, point: hit.point } : null;
    },
  });

  assert.equal(solution.crosshairTargetId, 'enemy');
  assert.equal(solution.predictedTargetId, 'enemy');
  assert.equal(solution.muzzleObstructed, false);
  assert.ok(solution.predictedPoint);
});

/* ------------------------------------------------------------------ */
/* 4. Spread                                                           */
/* ------------------------------------------------------------------ */

test('7.2 spread is a real cone: bounded, centred, and uniform on the disc', async () => {
  const { spreadDirection, createSpreadRng, orthonormalBasis } = await loadAimSolver();
  const aim = normalize(V(0.3, 0.1, -1));
  const angle = 0.066; // shotgun
  const rng = createSpreadRng(1234);

  let maxAngle = 0;
  let sumU = 0;
  let sumV = 0;
  const { u, v } = orthonormalBasis(aim);
  const samples = 4000;

  for (let i = 0; i < samples; i++) {
    const dir = spreadDirection(aim, angle, rng(), rng());
    const deviation = Math.acos(Math.min(1, Math.max(-1, dot(dir, aim))));
    maxAngle = Math.max(maxAngle, deviation);
    sumU += dot(dir, u);
    sumV += dot(dir, v);
  }

  assert.ok(maxAngle <= angle + 1e-6, `spread exceeded the cone: ${maxAngle} > ${angle}`);
  assert.ok(maxAngle > angle * 0.9, 'spread is too tight to be the configured cone');

  // Symmetric around the aim direction: no systematic drift to one side.
  assert.ok(Math.abs(sumU / samples) < 0.004, `spread biased along u: ${sumU / samples}`);
  assert.ok(Math.abs(sumV / samples) < 0.004, `spread biased along v: ${sumV / samples}`);

  // Zero spread is exact.
  const exact = spreadDirection(aim, 0, 0.9, 0.4);
  assert.ok(Math.abs(dot(exact, aim) - 1) < 1e-9, 'zero spread must not perturb the direction');
});

/* ------------------------------------------------------------------ */
/* 5. Server-side authoritative validation                             */
/* ------------------------------------------------------------------ */

test('7.2 the server rejects a reported hit whose ray misses the body', () => {
  const victim = { id: 'victim', position: V(0, 0, -20), positionHistory: [] };
  const now = Date.now();

  // An honest ray from a muzzle at the shooter's chest, through the victim.
  const origin = V(0, 1.35, 0);
  const honest = normalize(sub(V(0, 1.1, -20), origin));
  const hit = raycastVictimLagCompensated(victim, origin, honest, 200, now);
  assert.ok(hit, 'the honest ray must connect');
  assert.equal(hit.headshot, false);

  // The same shooter claiming a hit while the ray points 3 m to the side.
  const forged = normalize(sub(V(3, 1.1, -20), origin));
  assert.equal(
    raycastVictimLagCompensated(victim, origin, forged, 200, now),
    null,
    'a ray that misses the body must not register a hit'
  );

  // A head-level ray must be flagged as a headshot by the server, not the client.
  const headRay = normalize(sub(V(0, 1.7, -20), origin));
  const headHit = raycastVictimLagCompensated(victim, origin, headRay, 200, now);
  assert.ok(headHit);
  assert.equal(headHit.headshot, true);
});

test('7.2 lag compensation finds a moving target the current position already left', () => {
  const now = Date.now();
  const victim = { id: 'victim', position: V(0, 0, 0), positionHistory: [] };

  // The victim was at x = 0 a moment ago and has since sprinted to x = 6.
  victim.positionHistory.push({ t: now - 120, x: 0, y: 0, z: 0 });
  victim.positionHistory.push({ t: now - 60, x: 3, y: 0, z: 0 });
  victim.position = V(6, 0, 0);

  const origin = V(0, 1.35, 0);
  const atOldSpot = normalize(sub(V(0, 1.1, 0), origin));

  // With compensation: the shooter saw the body where it was, and gets the hit.
  assert.ok(
    raycastVictimLagCompensated(victim, origin, atOldSpot, 200, now),
    'a shot at the visible (delayed) position must register'
  );

  // Without a history (or outside the window) the same shot is a miss. That is
  // the behaviour that produced the "crosshair was on him" reports.
  const stale = { id: 'victim', position: V(6, 0, 0), positionHistory: [] };
  assert.equal(raycastVictimLagCompensated(stale, origin, atOldSpot, 200, now), null);

  // Compensating to a position older than the window must not happen.
  const ancient = {
    id: 'victim',
    position: V(20, 0, 0),
    positionHistory: [{ t: now - MAX_LAG_COMPENSATION_MS - 400, x: 0, y: 0, z: 0 }],
  };
  assert.equal(
    raycastVictimLagCompensated(ancient, origin, normalize(sub(V(0, 1.1, 0), origin)), 200, now),
    null,
    'the compensation window must be bounded'
  );
});

test('7.2 position history is bounded and coalesces stationary samples', () => {
  const now = Date.now();
  const start = now - 600;
  const player = { id: 'p', position: V(0, 0, 0) };

  // Standing still: repeated syncs must not fill the buffer.
  for (let i = 0; i < 50; i++) recordPositionHistory(player, start + i * 40);
  assert.equal(player.positionHistory.length, 1, 'stationary samples must coalesce');

  // Running: one sample per meaningful movement, capped.
  for (let i = 0; i < 60; i++) {
    player.position = V(i * 0.4, 0, 0);
    recordPositionHistory(player, start + i * 40);
  }
  assert.ok(player.positionHistory.length <= 16, 'history must stay bounded');
  assert.ok(player.positionHistory.length >= 5, 'history must actually retain recent samples');

  // Entries older than the TTL are dropped.
  player.positionHistory.unshift({ t: now - 10_000, x: 0, y: 0, z: 0 });
  player.position = V(99, 0, 0);
  recordPositionHistory(player, now);
  assert.ok(
    player.positionHistory.every((sample) => now - sample.t <= 1000),
    'stale samples must be evicted'
  );
});

test('7.2 a client cannot invent a firing origin somewhere else on the map', () => {
  const player = { position: V(10, 2, 10) };

  assert.ok(sanitizeFireOrigin(V(10.4, 3.4, 9.6), player), 'a real muzzle position is accepted');
  assert.equal(sanitizeFireOrigin(V(60, 3.4, 10), player), null, 'far origin rejected');
  assert.equal(sanitizeFireOrigin(V(10, 40, 10), player), null, 'sky-high origin rejected');
  assert.equal(sanitizeFireOrigin(V(NaN, 3, 10), player), null, 'non-finite rejected');

  // Clients quantise unit vectors, so a length slightly off 1 is normal.
  const dir = sanitizeDirection({ x: 0, y: 0, z: -0.999 });
  assert.ok(dir && Math.abs(len(dir) - 1) < 1e-9, 'direction is normalised');
  assert.equal(sanitizeDirection({ x: 0, y: 0, z: 0 }), null);
  assert.equal(sanitizeDirection({ x: Infinity, y: 0, z: 1 }), null);
});

test('7.2 the server tolerance absorbs sync error without accepting wild shots', () => {
  const victim = { id: 'victim', position: V(0, 0, -30), positionHistory: [] };
  const origin = V(0, 1.35, 0);
  const now = Date.now();

  // Aim ~8 cm off the torso edge: sync jitter territory, must still connect.
  const near = normalize(sub(V(0.34 + 0.08, 1.1, -30), origin));
  assert.ok(raycastVictimLagCompensated(victim, origin, near, 200, now));

  // 40 cm off: clearly a different place on screen, must not connect.
  const wide = normalize(sub(V(0.34 + 0.4, 1.1, -30), origin));
  assert.equal(raycastVictimLagCompensated(victim, origin, wide, 200, now), null);
  assert.ok(SERVER_HIT_TOLERANCE <= 0.12, 'server tolerance must stay small');
});
