/**
 * CI CRAFT 7.2 — authoritative hit registration, end to end.
 *
 * Boots the real production server, joins two clients into a real room and
 * drives the real `fire_weapon` / `combat_hit` protocol. The point of this file
 * is to prove the server decides hits from geometry it computed itself, not
 * from the client's opinion.
 *
 * Scope note: these are two WebSocket clients driven by Node, NOT two human
 * players on two machines. Everything below the transport is the production
 * code path, but browser rendering and real network jitter are not exercised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { equipRegistered, delay } from './gameplayHelpers.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    function onMessage(event) {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        resolve(msg);
      }
    }
    ws.addEventListener('message', onMessage);
  });
}

/** Resolves true if NO matching message arrives inside the window. */
function expectSilence(ws, predicate, timeoutMs = 900) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      resolve(true);
    }, timeoutMs);
    function onMessage(event) {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        resolve(false);
      }
    }
    ws.addEventListener('message', onMessage);
  });
}

async function connectClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return ws;
}

const norm = (x, y, z) => {
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
};

test('7.2 two real clients: the server confirms a true shot and rejects a forged one', async () => {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft-aim72-'));
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, ['server/multiplayerServer.mjs'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: '',
      SQLITE_DB_PATH: path.join(tmpDir, 'cicraft.sqlite'),
      ACCOUNT_TOKEN_SECRET: 'integration-test-secret-0123456789abcdef',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));

  const sockets = [];
  try {
    let health = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) {
          health = await res.json();
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(health, `server did not become healthy. Log:\n${serverLog}`);

    const room = await (await fetch(`${base}/api/room/create`, { method: 'POST' })).json();
    assert.equal(room.ok, true);

    const wsA = await connectClient(port);
    const wsB = await connectClient(port);
    sockets.push(wsA, wsB);

    const progressionA = waitForMessage(wsA, (m) => m.type === 'server_progression');
    wsA.send(
      JSON.stringify({
        type: 'join_room',
        roomCode: room.roomCode,
        sessionToken: 'sess_shooter',
        playerName: 'Shooter',
        position: { x: 0, y: 80, z: 0 },
      })
    );
    await progressionA;

    const stateWithTwo = waitForMessage(
      wsA,
      (m) => m.type === 'room_state' && m.players?.length === 2
    );
    wsB.send(
      JSON.stringify({
        type: 'join_room',
        roomCode: room.roomCode,
        sessionToken: 'sess_target',
        playerName: 'Target',
        position: { x: 0, y: 80, z: -20 },
      })
    );
    const roomState = await stateWithTwo;
    const targetId = roomState.players.find((p) => p.name === 'Target')?.id;
    assert.ok(targetId, 'target should have a public id');

    // Give the shooter a real, server-owned weapon so the shot consumes ammo.
    await equipRegistered(wsA, 'assault_rifle', 'rare', { x: 0, y: 80, z: 0 });

    // Pin both bodies so the geometry under test is known exactly.
    wsB.send(JSON.stringify({ type: 'player_sync', position: { x: 0, y: 80, z: -20 } }));
    wsA.send(JSON.stringify({ type: 'player_sync', position: { x: 0, y: 80, z: 0 } }));
    await delay(300);

    const muzzle = { x: 0.18, y: 81.22, z: -0.75 };
    const chest = { x: 0, y: 81.1, z: -20 };
    const honest = norm(chest.x - muzzle.x, chest.y - muzzle.y, chest.z - muzzle.z);

    let shotSeq = 0;

    // ---- 1. An honest shot: ray from the muzzle through the target. ------
    const confirmed = waitForMessage(wsB, (m) => m.type === 'server_hit', 5000);
    wsA.send(
      JSON.stringify({
        type: 'fire_weapon',
        shotSeq: ++shotSeq,
        category: 'assault_rifle',
        rarity: 'rare',
        muzzlePos: muzzle,
        hitPoint: chest,
        aim: { origin: muzzle, direction: honest, aimPoint: chest },
      })
    );
    wsA.send(
      JSON.stringify({
        type: 'combat_hit',
        hitId: 'aim72_honest_1',
        targetId,
        damage: 1,
        isHeadshot: false,
        weaponName: 'Rifle',
        weaponCategory: 'assault_rifle',
        weaponRarity: 'rare',
        hitPoint: chest,
      })
    );
    const hit = await confirmed;
    assert.equal(hit.victimId, targetId);
    assert.ok(hit.damage > 1, 'server must apply its own catalogued damage, not the reported 1');

    await delay(350);

    // ---- 2. A forged shot: same claim, but the ray points 6 m away. ------
    const forgedMuzzle = { x: 0.18, y: 81.22, z: -0.75 };
    const forgedAim = { x: 6, y: 81.1, z: -20 };
    const forged = norm(
      forgedAim.x - forgedMuzzle.x,
      forgedAim.y - forgedMuzzle.y,
      forgedAim.z - forgedMuzzle.z
    );

    wsA.send(
      JSON.stringify({
        type: 'fire_weapon',
        shotSeq: ++shotSeq,
        category: 'assault_rifle',
        rarity: 'rare',
        muzzlePos: forgedMuzzle,
        hitPoint: chest,
        aim: { origin: forgedMuzzle, direction: forged, aimPoint: forgedAim },
      })
    );
    wsA.send(
      JSON.stringify({
        type: 'combat_hit',
        hitId: 'aim72_forged_1',
        targetId,
        damage: 40,
        isHeadshot: true,
        weaponName: 'Rifle',
        weaponCategory: 'assault_rifle',
        weaponRarity: 'rare',
        hitPoint: chest,
      })
    );

    const stayedSilent = await expectSilence(
      wsB,
      (m) => m.type === 'server_hit' && m.victimId === targetId,
      1200
    );
    assert.equal(
      stayedSilent,
      true,
      'a shot whose ray misses the body must not deal damage'
    );

    // ---- 2b. The same shooter, immediately after, lands an honest shot. --
    // This proves the rejection above came from the ray geometry and not from
    // exhausted hit credit, an empty magazine or a rate limit.
    const secondHonest = waitForMessage(wsB, (m) => m.type === 'server_hit', 5000);
    wsA.send(
      JSON.stringify({
        type: 'fire_weapon',
        shotSeq: ++shotSeq,
        category: 'assault_rifle',
        rarity: 'rare',
        muzzlePos: muzzle,
        hitPoint: chest,
        aim: { origin: muzzle, direction: honest, aimPoint: chest },
      })
    );
    wsA.send(
      JSON.stringify({
        type: 'combat_hit',
        hitId: 'aim72_honest_2',
        targetId,
        damage: 1,
        isHeadshot: false,
        weaponName: 'Rifle',
        weaponCategory: 'assault_rifle',
        weaponRarity: 'rare',
        hitPoint: chest,
      })
    );
    const secondHit = await secondHonest;
    assert.equal(secondHit.victimId, targetId);
    assert.ok(secondHit.damage > 1);

    await delay(350);

    // ---- 3. A duplicate of the already-processed honest hit is ignored. --
    wsA.send(
      JSON.stringify({
        type: 'combat_hit',
        hitId: 'aim72_honest_1',
        targetId,
        damage: 40,
        isHeadshot: true,
        weaponName: 'Rifle',
        weaponCategory: 'assault_rifle',
        weaponRarity: 'rare',
        hitPoint: chest,
      })
    );
    assert.equal(
      await expectSilence(wsB, (m) => m.type === 'server_hit' && m.victimId === targetId, 800),
      true,
      'the same hitId must only ever apply once'
    );

    // ---- 4. A hit claimed with no preceding shot is ignored. -------------
    wsA.send(
      JSON.stringify({
        type: 'combat_hit',
        hitId: 'aim72_no_shot',
        targetId,
        damage: 40,
        isHeadshot: true,
        weaponName: 'Rifle',
        weaponCategory: 'sniper',
        weaponRarity: 'legendary',
        hitPoint: chest,
      })
    );
    assert.equal(
      await expectSilence(wsB, (m) => m.type === 'server_hit' && m.victimId === targetId, 800),
      true,
      'damage without a matching shot must be rejected'
    );
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    child.kill('SIGTERM');
    await delay(300);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
