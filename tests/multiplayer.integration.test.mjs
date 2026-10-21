/**
 * CI Craft — Multiplayer server integration tests.
 *
 * Boots the real production server (`server/multiplayerServer.mjs`) as a child
 * process on a platform-style injected PORT with a temporary SQLite database,
 * then exercises: /health, account init + passkey restore, room creation,
 * two-client WebSocket join/room_state sync (incl. storm), authoritative
 * combat hits, loot double-collection rejection, building sync, server-side
 * progression, and graceful SIGTERM shutdown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function waitForMessage(ws, predicate, timeoutMs = 5000) {
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

async function connectClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return ws;
}

test('production server: HTTP APIs + authoritative two-client multiplayer over injected PORT', async () => {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft-mp-test-'));
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
    // Wait for startup (SQLite migrations run during boot, before listen).
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
    assert.equal(health.status, 'ok');
    assert.equal(health.persistence.backend, 'sqlite');
    assert.equal(health.persistence.connected, true);
    assert.match(serverLog, new RegExp(`listening on 127\\.0\\.0\\.1:${port}`));

    // Account provisioning + cross-device passkey restore (HTTP).
    const initRes = await fetch(`${base}/api/account/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callsign: 'Alpha_One' }),
    });
    const account = await initRes.json();
    assert.equal(initRes.status, 200);
    assert.equal(account.ok, true);
    assert.ok(account.accountId && account.accountToken && account.passkey);

    const restoreRes = await fetch(`${base}/api/account/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey: account.passkey }),
    });
    const restored = await restoreRes.json();
    assert.equal(restoreRes.status, 200);
    assert.equal(restored.ok, true);
    assert.equal(restored.accountId, account.accountId);

    // Client-submitted progression must be rejected (authoritative server).
    const cheatRes = await fetch(`${base}/api/progression`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xpDelta: 99999 }),
    });
    assert.equal(cheatRes.status, 403);

    // Room creation / discovery.
    const roomRes = await fetch(`${base}/api/room/create`, { method: 'POST' });
    const room = await roomRes.json();
    assert.equal(room.ok, true);
    assert.match(room.roomCode, /^CI-[A-Z0-9]{4}$/);

    // Two WebSocket clients join the room.
    const wsA = await connectClient(port);
    const wsB = await connectClient(port);
    sockets.push(wsA, wsB);

    const progressionA = waitForMessage(wsA, (m) => m.type === 'server_progression');
    wsA.send(
      JSON.stringify({
        type: 'join_room',
        roomCode: room.roomCode,
        sessionToken: 'sess_alpha',
        accountId: restored.accountId,
        accountToken: restored.accountToken,
        playerName: 'Alpha_One',
        position: { x: 0, y: 10, z: 0 },
      })
    );
    const progA = await progressionA;
    assert.equal(progA.profile.accountId, account.accountId);

    const stateWithTwo = waitForMessage(
      wsA,
      (m) => m.type === 'room_state' && m.players?.length === 2
    );
    wsB.send(
      JSON.stringify({
        type: 'join_room',
        roomCode: room.roomCode,
        sessionToken: 'sess_bravo',
        playerName: 'Bravo_Two',
        position: { x: 5, y: 10, z: 5 },
      })
    );
    const roomState = await stateWithTwo;
    assert.equal(roomState.roomCode, room.roomCode);
    // Storm mechanics are part of every authoritative room snapshot.
    assert.equal(typeof roomState.storm.phase, 'number');
    assert.equal(typeof roomState.storm.currentRadius, 'number');
    assert.equal(typeof roomState.storm.damagePerSecond, 'number');
    const names = roomState.players.map((p) => p.name).sort();
    assert.deepEqual(names, ['Alpha_One', 'Bravo_Two']);

    // Authoritative combat: A hits B for 30 -> shield 50 absorbs, health stays 100.
    const hitEvent = waitForMessage(wsB, (m) => m.type === 'server_hit');
    wsA.send(
      JSON.stringify({
        type: 'combat_hit',
        hitId: 'hit_test_1',
        targetId: 'net_sess_bravo',
        damage: 30,
        weaponName: 'Pulse Rifle',
        hitPoint: { x: 5, y: 11, z: 5 },
      })
    );
    const hit = await hitEvent;
    assert.equal(hit.victimShield, 20);
    assert.equal(hit.victimHealth, 100);
    assert.equal(hit.eliminated, false);

    // Duplicate hitId must be ignored by the server (no second server_hit).
    let duplicateSeen = false;
    const dupWatcher = waitForMessage(wsB, (m) => m.type === 'server_hit', 700)
      .then(() => {
        duplicateSeen = true;
      })
      .catch(() => {});
    wsA.send(
      JSON.stringify({
        type: 'combat_hit',
        hitId: 'hit_test_1',
        targetId: 'net_sess_bravo',
        damage: 30,
        weaponName: 'Pulse Rifle',
        hitPoint: { x: 5, y: 11, z: 5 },
      })
    );
    await dupWatcher;
    assert.equal(duplicateSeen, false);

    // Loot: first collector wins, second is rejected server-side.
    const lootBroadcast = waitForMessage(wsB, (m) => m.type === 'loot_collected');
    wsA.send(
      JSON.stringify({
        type: 'collect_loot',
        lootId: 'chest_test_1',
        itemType: 'weapon',
        position: { x: 1, y: 10, z: 1 },
      })
    );
    const loot = await lootBroadcast;
    assert.equal(loot.lootId, 'chest_test_1');

    const lootRejected = waitForMessage(
      wsB,
      (m) => m.type === 'loot_collect_rejected' && m.lootId === 'chest_test_1'
    );
    wsB.send(
      JSON.stringify({
        type: 'collect_loot',
        lootId: 'chest_test_1',
        itemType: 'weapon',
        position: { x: 5, y: 10, z: 5 },
      })
    );
    await lootRejected;

    // Building: A's placement is broadcast to B.
    const buildBroadcast = waitForMessage(
      wsB,
      (m) => m.type === 'build_placed' && m.buildId === 'build_test_1'
    );
    wsA.send(
      JSON.stringify({
        type: 'place_build',
        buildId: 'build_test_1',
        pieceType: 'wall',
        material: 'stone',
        x: 2,
        y: 10,
        z: 2,
        yaw: 0,
      })
    );
    const build = await buildBroadcast;
    assert.equal(build.material, 'stone');
    assert.equal(build.health, 220);

    // Server-authoritative progression persisted A's participation + combat XP.
    const progRes = await fetch(
      `${base}/api/progression?accountId=${encodeURIComponent(account.accountId)}`
    );
    const profile = await progRes.json();
    assert.equal(progRes.status, 200);
    assert.ok(profile.matchesPlayed >= 1, `matchesPlayed=${profile.matchesPlayed}`);
    assert.ok(profile.xp >= 50, `xp=${profile.xp}`);
    assert.ok(profile.damageDealt >= 30, `damageDealt=${profile.damageDealt}`);
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    // Graceful SIGTERM shutdown (what Render sends on redeploy).
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    let exitTimer;
    const exitCode = await Promise.race([
      exited,
      new Promise((resolve) => {
        exitTimer = setTimeout(() => resolve('timeout'), 8000);
      }),
    ]);
    clearTimeout(exitTimer);
    if (exitCode === 'timeout') {
      child.kill('SIGKILL');
      assert.fail(`server did not exit on SIGTERM. Log:\n${serverLog}`);
    }
    assert.equal(exitCode, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
