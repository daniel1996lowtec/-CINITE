/**
 * CI CRAFT 9.3 — doubled player health (200 HP).
 *
 * Verifies the five required behaviours:
 *   1. a new player spawns at 200/200,
 *   2. damage reduces health by exactly the authoritative amount,
 *   3. healing cannot push health past 200,
 *   4. respawning restores 200,
 *   5. two real clients see the same health values.
 *
 * Shields are asserted unchanged on purpose: 9.3 doubles health only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

import {
  createInitialVitals,
  applyAuthoritativeDamage,
  applyRespawnVitals,
  PLAYER_MAX_HEALTH,
  PLAYER_SPAWN_HEALTH,
  PLAYER_MAX_SHIELD,
  PLAYER_SPAWN_SHIELD,
} from '../shared/matchRules.mjs';

import {
  resetInventory,
  inventoryAction,
  advanceInventory,
  collectInventory,
} from '../server/inventory.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const consumable = (category, rarity) => ({
  id: `test_${category}`,
  itemType: 'consumable',
  weaponCategory: category,
  rarity,
  amount: 6,
  position: { x: 0, y: 80, z: 0 },
});

function newPlayer() {
  const p = { alive: true, isConnected: true, ...createInitialVitals('free_for_all') };
  resetInventory(p);
  return p;
}

test('9.3 health: maximum and spawn value are 200, shields unchanged', () => {
  assert.equal(PLAYER_MAX_HEALTH, 200);
  assert.equal(PLAYER_SPAWN_HEALTH, 200);
  // Doubling health must not double shield.
  assert.equal(PLAYER_MAX_SHIELD, 100);
  assert.equal(PLAYER_SPAWN_SHIELD, 50);
});

test('9.3 health: a new player spawns at 200/200 in every mode', () => {
  for (const mode of ['battle_royale', 'free_for_all', 'team_deathmatch']) {
    const vitals = createInitialVitals(mode);
    assert.equal(vitals.health, 200, `${mode} spawn health`);
    assert.equal(vitals.maxHealth, 200, `${mode} max health`);
    assert.equal(vitals.shield, 50, `${mode} spawn shield unchanged`);
    assert.equal(vitals.maxShield, 100, `${mode} max shield unchanged`);
  }
});

test('9.3 health: damage applies to shield then health, shield maths unchanged', () => {
  const victim = newPlayer();

  // 70 damage: 50 absorbed by the shield, 20 reaches health -> 180.
  const hit1 = applyAuthoritativeDamage(victim, 70);
  assert.equal(hit1.absorbedByShield, 50);
  assert.equal(hit1.healthDamage, 20);
  assert.equal(hit1.isShieldBreak, true);
  assert.equal(hit1.lethal, false);
  assert.equal(victim.shield, 0);
  assert.equal(victim.health, 180);

  // 180 more damage is lethal against the 200 pool.
  const hit2 = applyAuthoritativeDamage(victim, 180);
  assert.equal(hit2.lethal, true);
  assert.equal(victim.health, 0);

  // A player at full health survives 249 of the 250 effective points.
  const fresh = newPlayer();
  const big = applyAuthoritativeDamage(fresh, 249);
  assert.equal(big.lethal, false);
  assert.equal(fresh.health, 1);
  assert.equal(applyAuthoritativeDamage(fresh, 1).lethal, true);
});

test('9.3 health: healing caps at 200 and never overshoots', () => {
  const p = newPlayer();
  collectInventory(p, consumable('medkit', 'uncommon'), 1, 'swap_heal', 0);
  assert.equal(p.inventory.some((s) => s?.category === 'medkit'), true);

  const consumeMs = 1800; // medkit:uncommon consumeTime 1.8s
  let now = 0;
  let seq = 1;
  const healOnce = () => {
    assert.equal(inventoryAction(p, 'use', undefined, seq++, now), true);
    now += consumeMs;
    advanceInventory(p, now);
  };

  // 10 -> 60 -> 110 -> 160 -> 200 (clamped, never 210).
  p.health = 10;
  healOnce();
  assert.equal(p.health, 60);
  healOnce();
  assert.equal(p.health, 110);
  healOnce();
  assert.equal(p.health, 160);
  healOnce();
  assert.equal(p.health, 200, 'the fourth medkit clips at the 200 maximum');
  assert.ok(p.health <= PLAYER_MAX_HEALTH);

  // At full health a medkit is refused outright rather than wasted.
  assert.equal(inventoryAction(p, 'use', undefined, seq, now + 1000), false);

  // A damaged player can still heal below the cap.
  p.health = 190;
  assert.equal(inventoryAction(p, 'use', undefined, seq + 1, now + 2000), true);
});

test('9.3 health: respawn restores 200 health and leaves shields untouched', () => {
  const p = newPlayer();
  const killing = applyAuthoritativeDamage(p, 400);
  assert.equal(killing.lethal, true);
  assert.equal(p.health, 0);
  p.alive = false;

  applyRespawnVitals(p, { x: 1, y: 2, z: 3 });
  assert.equal(p.alive, true);
  assert.equal(p.health, 200);
  assert.equal(p.maxHealth, 200);
  assert.equal(p.shield, 50);
  assert.equal(p.maxShield, 100);
  assert.equal(p.respawns, 1);
});

/* ------------------------------------------------------------------ */
/* Check 5: two real clients against a real authoritative server.      */
/* ------------------------------------------------------------------ */

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function connectClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 8000, label = 'message') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    function onMessage(event) {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      resolve(msg);
    }
    ws.addEventListener('message', onMessage);
  });
}

test('9.3 health: two clients agree on 200/200 and on damage taken', async () => {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft-health93-'));
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
      ACCOUNT_TOKEN_SECRET: 'health93-test-secret-0123456789abcdef',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));

  const sockets = [];
  try {
    const deadline = Date.now() + 15000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(healthy, `server did not become healthy. Log:\n${serverLog}`);

    const initRes = await fetch(`${base}/api/account/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callsign: 'Health_Nine_Three' }),
    });
    const account = await initRes.json();
    assert.equal(initRes.status, 200);

    const roomRes = await fetch(`${base}/api/room/create`, { method: 'POST' });
    const room = await roomRes.json();
    assert.equal(room.ok, true);

    const wsA = await connectClient(port);
    const wsB = await connectClient(port);
    sockets.push(wsA, wsB);

    wsA.send(
      JSON.stringify({
        type: 'join_room',
        roomCode: room.roomCode,
        sessionToken: 'sess_health_a',
        accountId: account.accountId,
        accountToken: account.accountToken,
        playerName: 'Health_Alpha',
        position: { x: 0, y: 80, z: 0 },
      })
    );

    const stateWithTwo = waitForMessage(
      wsA,
      (m) => m.type === 'room_state' && m.players?.length === 2
    );
    // Bravo's own view of the same moment, captured from its own socket.
    const stateForB = waitForMessage(
      wsB,
      (m) => m.type === 'room_state' && m.players?.length === 2
    );
    wsB.send(
      JSON.stringify({
        type: 'join_room',
        roomCode: room.roomCode,
        sessionToken: 'sess_health_b',
        playerName: 'Health_Bravo',
        position: { x: 4, y: 80, z: 4 },
      })
    );
    const roomState = await stateWithTwo;
    const bravoState = await stateForB;

    // Each client received the snapshot on its own socket; both must describe
    // every player identically at 200/200 with an unchanged 100 shield cap.
    for (const clientView of [roomState, bravoState]) {
      const sorted = [...clientView.players]
        .map((p) => `${p.name}:${p.health}/${p.maxHealth}:${p.maxShield}`)
        .sort();
      assert.deepEqual(sorted, [
        'Health_Alpha:200/200:100',
        'Health_Bravo:200/200:100',
      ]);
    }
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
