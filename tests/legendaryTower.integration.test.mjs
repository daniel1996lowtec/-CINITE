/**
 * CI Craft — Legendary Tower authoritative-loot integration tests.
 *
 * Boots the real production server and verifies that the rooftop vault is
 * seeded/synchronized only by the server, collected once, range checked
 * against the fixed server templates, protected from forged tower spawns and
 * swaps, restored for reconnecting/new players, and reset/sent at managed
 * lobby match start.
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
const VAULT_Y = 51.73;
const EXPECTED_VAULT = [
  ['legendary_tower_assault_rifle', 'Legendary Pulse Rifle', 'assault_rifle', -3, 2.8, 1],
  ['legendary_tower_sniper', 'Legendary Rail Sniper', 'sniper', 0, 3.4, 1],
  ['legendary_tower_shotgun', 'Legendary Scatter Pump', 'shotgun', 3, 2.8, 1],
  ['legendary_tower_shield_1', 'Shield Potion (+50)', 'shield_potion', -3.6, 0.6, 1],
  ['legendary_tower_shield_2', 'Shield Potion (+50)', 'shield_potion', -1.9, 0.8, 1],
  ['legendary_tower_medkit_1', 'Nano Medkit (+50)', 'medkit', 1.9, 0.8, 1],
  ['legendary_tower_medkit_2', 'Nano Medkit (+50)', 'medkit', 3.6, 0.6, 1],
  ['legendary_tower_medium_ammo', 'Medium Ammo (120)', null, -3.4, -3, 120],
  ['legendary_tower_heavy_ammo', 'Heavy Sniper Ammo (40)', null, 0, -3.6, 40],
  ['legendary_tower_shells', 'Shotgun Shells (48)', null, 3.4, -3, 48],
  ['legendary_tower_metal', 'METAL x250', null, -3.8, -0.8, 250],
  ['legendary_tower_stone', 'STONE x200', null, 3.8, -0.8, 200],
  ['legendary_tower_wood', 'WOOD x200', null, 0, -2.2, 200],
];

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

function waitForMessage(ws, predicate, timeoutMs = 7000, label = 'WebSocket message') {
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
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        resolve(msg);
      }
    }
    ws.addEventListener('message', onMessage);
  });
}

async function connectClient(port, sockets) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return ws;
}

function sendJson(ws, payload) {
  ws.send(JSON.stringify(payload));
}

async function postJson(base, route, payload = {}) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { res, data: await res.json() };
}

async function createAccount(base, callsign) {
  const { res, data } = await postJson(base, '/api/account/init', { callsign });
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  return data;
}

async function startServer(port, sqlitePath) {
  const child = spawn(process.execPath, ['server/multiplayerServer.mjs'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: '',
      SQLITE_DB_PATH: sqlitePath,
      ACCOUNT_TOKEN_SECRET: 'legendary-tower-integration-secret-0123456789abcdef',
      HUMAN_MATCH_COUNTDOWN_MS: '250',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));

  const base = `http://127.0.0.1:${port}`;
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
      // Still starting.
    }
    await new Promise((r) => setTimeout(r, 125));
  }
  assert.ok(health, `server did not become healthy. Log:\n${serverLog}`);

  let stopped = false;
  const stop = async () => {
    if (stopped || child.exitCode !== null) return;
    stopped = true;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const exitCode = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000)),
    ]);
    if (exitCode === 'timeout') {
      child.kill('SIGKILL');
      assert.fail(`server did not exit on SIGTERM. Log:\n${serverLog}`);
    }
    assert.equal(exitCode, 0);
  };
  return { base, stop, getLog: () => serverLog };
}

function assertVaultSync(sync, expectedCollected = []) {
  assert.equal(sync.type, 'room_loot_sync');
  assert.deepEqual(
    sync.collectedIds.filter((id) => String(id).startsWith('legendary_tower_')).sort(),
    [...expectedCollected].sort()
  );
  const towerItems = sync.spawnedItems.filter((item) =>
    String(item.id).startsWith('legendary_tower_')
  );
  const expectedRemaining = EXPECTED_VAULT.filter(([id]) => !expectedCollected.includes(id));
  assert.equal(towerItems.length, expectedRemaining.length);
  for (const [id, name, category, x, z, amount] of expectedRemaining) {
    const item = towerItems.find((candidate) => candidate.id === id);
    assert.ok(item, `missing ${id} in room_loot_sync`);
    assert.equal(item.name, name);
    assert.equal(item.amount, amount);
    assert.equal(item.isLegendaryTowerLoot, true);
    assert.equal(item.serverAuthoritative, true);
    assert.deepEqual(item.position, { x, y: VAULT_Y, z });
    if (category) assert.equal(item.weaponCategory, category);
  }
  return towerItems;
}

async function joinLegacyRoom(ws, roomCode, sessionToken, playerName, position) {
  const joined = waitForMessage(
    ws,
    (msg) =>
      (msg.type === 'room_joined' || msg.type === 'join_rejected') &&
      msg.roomCode === roomCode,
    7000,
    `legacy join ${roomCode}`
  );
  const sync = waitForMessage(
    ws,
    (msg) => msg.type === 'room_loot_sync',
    7000,
    `legacy loot sync ${roomCode}`
  );
  sendJson(ws, {
    type: 'join_room',
    roomCode,
    roomMode: 'online_ai_fill',
    sessionToken,
    playerName,
    position,
  });
  const [joinResult, syncResult] = await Promise.all([joined, sync]);
  assert.equal(joinResult.type, 'room_joined');
  return { joined: joinResult, sync: syncResult };
}

async function syncPosition(ws, position) {
  sendJson(ws, {
    type: 'player_sync',
    position,
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    facingYaw: 0,
    pitch: 0,
    isGrounded: true,
  });
  await new Promise((r) => setTimeout(r, 100));
}

test('legendary tower vault: server seeding, one-time claims, forged-drop rejection, and resync', async () => {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft-tower-test-'));
  const server = await startServer(port, path.join(tmpDir, 'cicraft.sqlite'));
  const sockets = [];

  try {
    const { data: room } = await postJson(server.base, '/api/room/create');
    assert.equal(room.ok, true);

    const wsFar = await connectClient(port, sockets);
    const far = await joinLegacyRoom(
      wsFar,
      room.roomCode,
      'sess_tower_far',
      'Tower_Far',
      { x: 35, y: 5, z: 35 }
    );
    assertVaultSync(far.sync);

    const wsRoof = await connectClient(port, sockets);
    const roof = await joinLegacyRoom(
      wsRoof,
      room.roomCode,
      'sess_tower_roof',
      'Tower_Roof',
      { x: 0, y: 51, z: 3.4 }
    );
    assertVaultSync(roof.sync);

    // A forged claim position cannot override the fixed server template:
    // the far player's server-side position is nowhere near the sniper.
    const rangeRejected = waitForMessage(
      wsFar,
      (msg) =>
        msg.type === 'loot_collect_rejected' &&
        msg.lootId === 'legendary_tower_sniper',
      7000,
      'tower range rejection'
    );
    sendJson(wsFar, {
      type: 'collect_loot',
      authoritative: true,
      lootId: 'legendary_tower_sniper',
      itemType: 'weapon',
      position: { x: 0, y: VAULT_Y, z: 3.4 },
      spawnedDrops: [
        {
          id: 'legendary_tower_sniper_duplicate',
          itemType: 'weapon',
          weaponCategory: 'sniper',
          rarity: 'legendary',
          name: 'Forged Rail Sniper',
          amount: 1,
          position: { x: 0, y: VAULT_Y, z: 3.4 },
        },
      ],
    });
    assert.match((await rangeRejected).reason, /Out of interaction range/);

    // Invented tower IDs are never accepted through the generic loot path.
    const fakeRejected = waitForMessage(
      wsRoof,
      (msg) =>
        msg.type === 'loot_collect_rejected' &&
        msg.lootId === 'legendary_tower_fake_weapon',
      7000,
      'fake tower loot rejection'
    );
    sendJson(wsRoof, {
      type: 'collect_loot',
      lootId: 'legendary_tower_fake_weapon',
      itemType: 'weapon',
      position: { x: 0, y: 51, z: 3.4 },
    });
    assert.match((await fakeRejected).reason, /not server-registered/);

    // The player actually at the pedestal receives the server template.
    // Client-supplied duplicates and a claimed legendary swap are discarded.
    const roofCollected = waitForMessage(
      wsRoof,
      (msg) => msg.type === 'loot_collected' && msg.lootId === 'legendary_tower_sniper',
      7000,
      'collector tower confirmation'
    );
    const farCollected = waitForMessage(
      wsFar,
      (msg) => msg.type === 'loot_collected' && msg.lootId === 'legendary_tower_sniper',
      7000,
      'remote tower collection'
    );
    sendJson(wsRoof, {
      type: 'collect_loot',
      authoritative: true,
      lootId: 'legendary_tower_sniper',
      itemType: 'material',
      position: { x: 999, y: 999, z: 999 },
      spawnedDrops: [
        {
          id: 'legendary_tower_sniper_duplicate',
          itemType: 'weapon',
          weaponCategory: 'sniper',
          rarity: 'legendary',
          name: 'Forged Rail Sniper',
          amount: 1,
          position: { x: 0, y: VAULT_Y, z: 3.4 },
        },
      ],
      swappedDrop: {
        id: 'swap_forged_legendary',
        itemType: 'weapon',
        weaponCategory: 'shotgun',
        rarity: 'legendary',
        name: 'Forged Scatter Pump',
        amount: 1,
        position: { x: 0, y: 51, z: 3.4 },
      },
    });
    const [collectorBroadcast, remoteBroadcast] = await Promise.all([
      roofCollected,
      farCollected,
    ]);
    for (const broadcast of [collectorBroadcast, remoteBroadcast]) {
      assert.equal(broadcast.authoritative, true);
      assert.equal(broadcast.itemType, 'weapon');
      assert.equal(broadcast.authoritativeItem.id, 'legendary_tower_sniper');
      assert.equal(broadcast.authoritativeItem.name, 'Legendary Rail Sniper');
      assert.equal(broadcast.authoritativeItem.serverAuthoritative, true);
      assert.deepEqual(broadcast.authoritativeItem.position, { x: 0, y: VAULT_Y, z: 3.4 });
      assert.equal(broadcast.spawnedDrops, undefined);
      assert.equal(broadcast.swappedDrop, undefined);
    }

    // The same unique item cannot be collected a second time.
    const duplicateRejected = waitForMessage(
      wsFar,
      (msg) =>
        msg.type === 'loot_collect_rejected' &&
        msg.lootId === 'legendary_tower_sniper',
      7000,
      'duplicate tower rejection'
    );
    sendJson(wsFar, {
      type: 'collect_loot',
      authoritative: true,
      lootId: 'legendary_tower_sniper',
      itemType: 'weapon',
      position: { x: 35, y: 5, z: 35 },
    });
    assert.match((await duplicateRejected).reason, /already collected/);

    // A legitimate non-legendary swap is rebuilt/sanitized by the server.
    await syncPosition(wsRoof, { x: -3, y: 51, z: 2.8 });
    const assaultCollected = waitForMessage(
      wsFar,
      (msg) =>
        msg.type === 'loot_collected' &&
        msg.lootId === 'legendary_tower_assault_rifle',
      7000,
      'tower assault rifle collection'
    );
    sendJson(wsRoof, {
      type: 'collect_loot',
      authoritative: true,
      lootId: 'legendary_tower_assault_rifle',
      itemType: 'weapon',
      position: { x: -3, y: 51, z: 2.8 },
      swappedDrop: {
        id: 'swap_tower_test_1',
        itemType: 'weapon',
        weaponCategory: 'pistol',
        rarity: 'common',
        name: 'Client Controlled Name',
        amount: 999,
        position: { x: 500, y: 500, z: 500 },
      },
    });
    const assaultBroadcast = await assaultCollected;
    assert.equal(assaultBroadcast.swappedDrop.id, 'swap_tower_test_1');
    assert.equal(assaultBroadcast.swappedDrop.name, 'Common Cyber Pistol');
    assert.equal(assaultBroadcast.swappedDrop.amount, 1);
    assert.ok(
      Math.hypot(
        assaultBroadcast.swappedDrop.position.x + 3,
        assaultBroadcast.swappedDrop.position.y - 51,
        assaultBroadcast.swappedDrop.position.z - 2.8
      ) <= 7
    );

    // Tower IDs also cannot be injected as drops from a generic chest.
    const forgeBroadcastPromise = waitForMessage(
      wsRoof,
      (msg) => msg.type === 'loot_collected' && msg.lootId === 'chest_forge_test',
      7000,
      'generic chest forge broadcast'
    );
    sendJson(wsFar, {
      type: 'collect_loot',
      lootId: 'chest_forge_test',
      itemType: 'chest',
      position: { x: 35, y: 5, z: 35 },
      spawnedDrops: [
        {
          id: 'legendary_tower_injected',
          itemType: 'weapon',
          weaponCategory: 'assault_rifle',
          rarity: 'legendary',
          name: 'Injected Pulse Rifle',
          amount: 1,
          position: { x: 35, y: 5, z: 35 },
        },
        {
          id: 'ordinary_chest_ammo',
          itemType: 'ammo',
          ammoType: 'light',
          rarity: 'common',
          name: 'Light Ammo (24)',
          amount: 24,
          position: { x: 35, y: 5, z: 35 },
        },
      ],
    });
    const forgeBroadcast = await forgeBroadcastPromise;
    assert.deepEqual(
      forgeBroadcast.spawnedDrops.map((drop) => drop.id),
      ['ordinary_chest_ammo']
    );

    // A late/reconnecting client gets the two collected vault IDs, the 11
    // remaining server items, and the sanitized swap—but no forged tower ID.
    const wsLate = await connectClient(port, sockets);
    const late = await joinLegacyRoom(
      wsLate,
      room.roomCode,
      'sess_tower_late',
      'Tower_Late',
      { x: 20, y: 5, z: 20 }
    );
    assertVaultSync(late.sync, [
      'legendary_tower_assault_rifle',
      'legendary_tower_sniper',
    ]);
    assert.ok(late.sync.spawnedItems.some((item) => item.id === 'swap_tower_test_1'));
    assert.ok(!late.sync.spawnedItems.some((item) => item.id === 'legendary_tower_injected'));

    // The roof player legitimately received the server's Legendary Rail
    // Sniper above. Its server-side ownership entry therefore authorizes
    // exactly one broadcast swap when that same player claims the shotgun
    // with a full inventory; client-controlled name/amount are rebuilt.
    await syncPosition(wsRoof, { x: 3, y: 51, z: 2.8 });
    const shotgunCollected = waitForMessage(
      wsLate,
      (msg) =>
        msg.type === 'loot_collected' &&
        msg.lootId === 'legendary_tower_shotgun',
      7000,
      'owned tower-weapon swap broadcast'
    );
    sendJson(wsRoof, {
      type: 'collect_loot',
      authoritative: true,
      lootId: 'legendary_tower_shotgun',
      itemType: 'weapon',
      position: { x: 3, y: 51, z: 2.8 },
      swappedDrop: {
        id: 'swap_tower_sniper_owned',
        itemType: 'weapon',
        weaponCategory: 'sniper',
        rarity: 'legendary',
        name: 'Client Controlled Sniper',
        amount: 999,
        position: { x: 3, y: 51, z: 2.8 },
      },
    });
    const shotgunBroadcast = await shotgunCollected;
    assert.equal(shotgunBroadcast.swappedDrop.id, 'swap_tower_sniper_owned');
    assert.equal(shotgunBroadcast.swappedDrop.name, 'Legendary Rail Sniper');
    assert.equal(shotgunBroadcast.swappedDrop.amount, 1);
    assert.equal(shotgunBroadcast.swappedDrop.rarity, 'legendary');

    // Picking up that registered swap transfers the one-time ownership
    // entry to the second player. They may broadcast it once as a later
    // swap, but the consumed entry cannot authorize a second copy.
    await syncPosition(wsFar, { x: 3, y: 51, z: 2.8 });

    // A lookalike generic chest drop is not tower provenance: even after
    // collecting the registered generic item, this player may not use it
    // to authorize a unique tower-weapon swap.
    const genericChestBroadcastPromise = waitForMessage(
      wsRoof,
      (msg) =>
        msg.type === 'loot_collected' &&
        msg.lootId === 'generic_provenance_chest',
      7000,
      'generic provenance chest broadcast'
    );
    sendJson(wsFar, {
      type: 'collect_loot',
      lootId: 'generic_provenance_chest',
      itemType: 'chest',
      position: { x: 3, y: 51, z: 2.8 },
      spawnedDrops: [
        {
          id: 'generic_forged_sniper',
          itemType: 'weapon',
          weaponCategory: 'sniper',
          rarity: 'legendary',
          name: 'Legendary Rail Sniper',
          amount: 1,
          position: { x: 3, y: 51, z: 2.8 },
        },
      ],
    });
    await genericChestBroadcastPromise;
    const genericSniperBroadcastPromise = waitForMessage(
      wsRoof,
      (msg) =>
        msg.type === 'loot_collected' &&
        msg.lootId === 'generic_forged_sniper',
      7000,
      'generic forged sniper pickup'
    );
    sendJson(wsFar, {
      type: 'collect_loot',
      lootId: 'generic_forged_sniper',
      itemType: 'weapon',
      position: { x: 3, y: 51, z: 2.8 },
      swappedDrop: {
        id: 'swap_generic_forged_sniper',
        itemType: 'weapon',
        weaponCategory: 'sniper',
        rarity: 'legendary',
        name: 'Legendary Rail Sniper',
        amount: 1,
        position: { x: 3, y: 51, z: 2.8 },
      },
    });
    assert.equal((await genericSniperBroadcastPromise).swappedDrop, undefined);

    const registeredSwapCollected = waitForMessage(
      wsLate,
      (msg) =>
        msg.type === 'loot_collected' &&
        msg.lootId === 'swap_tower_sniper_owned',
      7000,
      'registered tower-weapon swap pickup'
    );
    sendJson(wsFar, {
      type: 'collect_loot',
      lootId: 'swap_tower_sniper_owned',
      itemType: 'weapon',
      position: { x: 3, y: 51, z: 2.8 },
    });
    await registeredSwapCollected;

    const transferredSwapBroadcastPromise = waitForMessage(
      wsRoof,
      (msg) =>
        msg.type === 'loot_collected' &&
        msg.lootId === 'generic_transfer_test',
      7000,
      'transferred tower-weapon swap'
    );
    sendJson(wsFar, {
      type: 'collect_loot',
      lootId: 'generic_transfer_test',
      itemType: 'material',
      position: { x: 3, y: 51, z: 2.8 },
      swappedDrop: {
        id: 'swap_tower_sniper_transferred',
        itemType: 'weapon',
        weaponCategory: 'sniper',
        rarity: 'legendary',
        name: 'Client Controlled Sniper',
        amount: 999,
        position: { x: 3, y: 51, z: 2.8 },
      },
    });
    const transferredSwapBroadcast = await transferredSwapBroadcastPromise;
    assert.equal(
      transferredSwapBroadcast.swappedDrop.id,
      'swap_tower_sniper_transferred'
    );
    assert.equal(
      transferredSwapBroadcast.swappedDrop.name,
      'Legendary Rail Sniper'
    );

    const consumedSwapBroadcastPromise = waitForMessage(
      wsRoof,
      (msg) =>
        msg.type === 'loot_collected' &&
        msg.lootId === 'generic_transfer_test_2',
      7000,
      'consumed tower-weapon ownership rejection'
    );
    sendJson(wsFar, {
      type: 'collect_loot',
      lootId: 'generic_transfer_test_2',
      itemType: 'material',
      position: { x: 3, y: 51, z: 2.8 },
      swappedDrop: {
        id: 'swap_tower_sniper_consumed',
        itemType: 'weapon',
        weaponCategory: 'sniper',
        rarity: 'legendary',
        name: 'Second Forged Sniper',
        amount: 1,
        position: { x: 3, y: 51, z: 2.8 },
      },
    });
    assert.equal((await consumedSwapBroadcastPromise).swappedDrop, undefined);

    // A fresh room/match gets a fresh complete vault registry.
    const { data: freshRoom } = await postJson(server.base, '/api/room/create');
    const wsFresh = await connectClient(port, sockets);
    const fresh = await joinLegacyRoom(
      wsFresh,
      freshRoom.roomCode,
      'sess_tower_fresh',
      'Tower_Fresh',
      { x: 0, y: 10, z: 0 }
    );
    assertVaultSync(fresh.sync);
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('legendary tower vault: managed lobby blocks pre-start claims and sends reset registry at match start', async () => {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft-tower-lobby-test-'));
  const server = await startServer(port, path.join(tmpDir, 'cicraft.sqlite'));
  const sockets = [];

  try {
    const accountHost = await createAccount(server.base, 'Tower_Host');
    const accountGuest = await createAccount(server.base, 'Tower_Guest');
    const wsHost = await connectClient(port, sockets);
    const wsGuest = await connectClient(port, sockets);

    const createdPromise = waitForMessage(
      wsHost,
      (msg) => msg.type === 'lobby_created' || msg.type === 'lobby_create_rejected',
      7000,
      'tower lobby creation'
    );
    sendJson(wsHost, {
      type: 'create_lobby',
      accountId: accountHost.accountId,
      accountToken: accountHost.accountToken,
      playerName: 'Tower_Host',
      config: {
        name: 'Legendary Tower Test',
        visibility: 'public',
        humanOnly: true,
        maxPlayers: 2,
        mapId: 'ci_island',
        teamMode: 'solo',
        botCount: 0,
        startCondition: 'host_start',
      },
    });
    const created = await createdPromise;
    assert.equal(created.type, 'lobby_created');

    const joinManaged = async (ws, account, sessionToken, playerName) => {
      const joined = waitForMessage(
        ws,
        (msg) =>
          (msg.type === 'room_joined' || msg.type === 'join_rejected') &&
          msg.roomCode === created.roomCode,
        7000,
        `managed join ${playerName}`
      );
      sendJson(ws, {
        type: 'join_room',
        roomCode: created.roomCode,
        roomMode: 'human_only_public',
        purpose: 'lobby',
        joinIntent: 'join_existing',
        sessionToken,
        accountId: account.accountId,
        accountToken: account.accountToken,
        playerName,
        position: { x: 0, y: 51, z: 2.8 },
      });
      const result = await joined;
      assert.equal(result.type, 'room_joined');
      return result;
    };

    await joinManaged(wsHost, accountHost, 'sess_tower_host', 'Tower_Host');
    await joinManaged(wsGuest, accountGuest, 'sess_tower_guest', 'Tower_Guest');

    const preStartRejected = waitForMessage(
      wsHost,
      (msg) =>
        msg.type === 'loot_collect_rejected' &&
        msg.lootId === 'legendary_tower_shotgun',
      7000,
      'pre-start tower rejection'
    );
    sendJson(wsHost, {
      type: 'collect_loot',
      authoritative: true,
      lootId: 'legendary_tower_shotgun',
      itemType: 'weapon',
      position: { x: 0, y: 51, z: 2.8 },
    });
    assert.match((await preStartRejected).reason, /has not started/);

    sendJson(wsHost, { type: 'set_ready', ready: true });
    sendJson(wsGuest, { type: 'set_ready', ready: true });
    await new Promise((r) => setTimeout(r, 250));
    const startedHost = waitForMessage(
      wsHost,
      (msg) => msg.type === 'match_started',
      7000,
      'tower lobby host match_started'
    );
    const syncHost = waitForMessage(
      wsHost,
      (msg) =>
        msg.type === 'room_loot_sync' &&
        msg.roomCode === created.roomCode &&
        Array.isArray(msg.spawnedItems) &&
        msg.spawnedItems.some((item) => item.id === 'legendary_tower_shotgun'),
      7000,
      'tower lobby host match-start loot sync'
    );
    const syncGuest = waitForMessage(
      wsGuest,
      (msg) =>
        msg.type === 'room_loot_sync' &&
        msg.roomCode === created.roomCode &&
        Array.isArray(msg.spawnedItems) &&
        msg.spawnedItems.some((item) => item.id === 'legendary_tower_shotgun'),
      7000,
      'tower lobby guest match-start loot sync'
    );
    sendJson(wsHost, { type: 'request_match_start' });
    const [started, hostSync, guestSync] = await Promise.all([
      startedHost,
      syncHost,
      syncGuest,
    ]);
    assert.equal(started.botCount, 0);
    assertVaultSync(hostSync);
    assertVaultSync(guestSync);

    await syncPosition(wsHost, { x: 3, y: 51, z: 2.8 });
    const shotgunCollected = waitForMessage(
      wsGuest,
      (msg) =>
        msg.type === 'loot_collected' &&
        msg.lootId === 'legendary_tower_shotgun',
      7000,
      'managed tower shotgun collection'
    );
    sendJson(wsHost, {
      type: 'collect_loot',
      authoritative: true,
      lootId: 'legendary_tower_shotgun',
      itemType: 'weapon',
      position: { x: 3, y: 51, z: 2.8 },
    });
    const shotgun = await shotgunCollected;
    assert.equal(shotgun.authoritativeItem.name, 'Legendary Scatter Pump');
    assert.equal(shotgun.authoritativeItem.weaponCategory, 'shotgun');
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
