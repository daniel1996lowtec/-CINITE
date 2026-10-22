import { equipRegistered, delay, send as sendGameplay, action, claim, receive, resumeActions, resumeShots } from './gameplayHelpers.mjs';
/**
 * CI Craft — Human-only multiplayer integration tests.
 *
 * Boots the production authoritative server with a temporary SQLite account
 * database and verifies the server-owned human-only lobby contract:
 * authenticated real sessions only, zero bot injection, server-derived
 * connected/ready counts, a two-human ready gate, disconnect/reconnect
 * de-duplication, explicit leave, late-join rejection, token-free room
 * snapshots, public matchmaking, human-only victory, capacity, and mode
 * preservation across a process restart (via the reserved room-code prefix).
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

function waitForMessage(ws, predicate, timeoutMs = 6000, label = 'WebSocket message') {
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

function waitForRoomState(ws, predicate, timeoutMs = 6000) {
  return waitForMessage(
    ws,
    (msg) => msg.type === 'room_state' && predicate(msg),
    timeoutMs,
    'matching room_state'
  );
}

async function connectClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return ws;
}

function sendJson(ws, payload) {
  sendGameplay(ws,payload);
}

async function postJson(base, route, payload = {}) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  return { res, data };
}

async function createAccount(base, callsign) {
  const { res, data } = await postJson(base, '/api/account/init', { callsign });
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.accountId && data.accountToken && data.passkey);
  return data;
}

async function startServer({ port, sqlitePath }) {
  const child = spawn(process.execPath, ['server/multiplayerServer.mjs'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: '',
      SQLITE_DB_PATH: sqlitePath,
      ACCOUNT_TOKEN_SECRET: 'human-only-integration-secret-0123456789abcdef',
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
      // Server is still starting / migrating.
    }
    await new Promise((r) => setTimeout(r, 125));
  }
  assert.ok(health, `server did not become healthy. Log:\n${serverLog}`);
  assert.equal(health.status, 'ok');
  assert.match(serverLog, new RegExp(`listening on 127\\.0\\.0\\.1:${port}`));

  let stopped = false;
  const stop = async () => {
    if (stopped || child.exitCode !== null) {
      stopped = true;
      return;
    }
    stopped = true;
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
  };

  return { child, base, stop, getLog: () => serverLog };
}

function joinPayload({ roomCode, roomMode, sessionToken, account, playerName, position }) {
  return {
    type: 'join_room',
    roomCode,
    roomMode,
    mode: roomMode,
    purpose: 'lobby',
    sessionToken,
    accountId: account?.accountId,
    accountToken: account?.accountToken,
    playerName,
    position: position || { x: 0, y: 80, z: 0 },
  };
}

async function joinHumanRoom(ws, payload) {
  const joined = waitForMessage(
    ws,
    (msg) => msg.type === 'room_joined' && msg.roomCode === payload.roomCode,
    6000,
    `room_joined for ${payload.roomCode}`
  );
  sendJson(ws, payload);
  return joined;
}

function assertNoSecrets(serialized, secrets, label) {
  for (const secret of secrets) {
    if (secret) assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), label);
  }
  assert.doesNotMatch(serialized, /accountToken|sessionToken|passkey|token_hash/i, label);
}

test('human-only rooms: authenticated lobby, ready gate, reconnect dedupe, zero bots, and victory', async () => {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft-human-test-'));
  const server = await startServer({
    port,
    sqlitePath: path.join(tmpDir, 'cicraft.sqlite'),
  });
  const sockets = [];

  try {
    const accountA = await createAccount(server.base, 'Human_Alpha');
    const accountB = await createAccount(server.base, 'Human_Bravo');
    const accountC = await createAccount(server.base, 'Human_Charlie');
    const accountD = await createAccount(server.base, 'Human_Delta');

    // Mode validation is server-side at room creation.
    const invalidMode = await postJson(server.base, '/api/room/create', {
      roomMode: 'bots_disguised_as_humans',
    });
    assert.equal(invalidMode.res.status, 400);
    assert.equal(invalidMode.data.ok, false);

    const legacyRoom = await postJson(server.base, '/api/room/create', {
      roomMode: 'online_ai_fill',
    });
    assert.equal(legacyRoom.res.status, 200);
    assert.match(legacyRoom.data.roomCode, /^CI-[A-Z0-9]{4}$/);
    assert.equal(legacyRoom.data.mode, 'online_ai_fill');

    const privateRoom = await postJson(server.base, '/api/room/create', {
      roomMode: 'human_only_private',
    });
    assert.equal(privateRoom.res.status, 200);
    assert.match(privateRoom.data.roomCode, /^HUM-[A-Z0-9]{4}$/);
    assert.equal(privateRoom.data.mode, 'human_only_private');
    assert.equal(privateRoom.data.humanOnly, true);
    assert.equal(privateRoom.data.aiFillEnabled, false);
    assert.equal(privateRoom.data.botCount, 0);
    assert.equal(privateRoom.data.minPlayers, 2);
    assert.equal(privateRoom.data.maxPlayers, 20);
    assert.equal(privateRoom.data.phase, 'lobby');
    assert.doesNotMatch(JSON.stringify(privateRoom.data), /accountToken|sessionToken|passkey/i);

    const roomCode = privateRoom.data.roomCode;

    // Claiming to be human is not authentication. Forged/missing credentials
    // and attempts to use a human session against a legacy room are rejected.
    const unauthenticatedWs = await connectClient(port);
    sockets.push(unauthenticatedWs);
    let rejected = waitForMessage(
      unauthenticatedWs,
      (msg) => msg.type === 'join_rejected',
      6000,
      'unauthenticated join rejection'
    );
    sendJson(unauthenticatedWs, {
      type: 'join_room',
      roomCode,
      roomMode: 'human_only_private',
      sessionToken: 'sess_claimed_bot_human',
      playerName: 'Definitely_Human_Bot',
      participantType: 'human',
      isBot: false,
      isAuthenticated: true,
      connectedHumans: 20,
      readyHumans: 20,
      position: { x: 0, y: 80, z: 0 },
    });
    assert.equal((await rejected).code, 'authentication_required');

    rejected = waitForMessage(
      unauthenticatedWs,
      (msg) => msg.type === 'join_rejected',
      6000,
      'forged credential join rejection'
    );
    sendJson(unauthenticatedWs, {
      type: 'join_room',
      roomCode,
      roomMode: 'human_only_private',
      sessionToken: 'sess_forged_human',
      accountId: accountA.accountId,
      accountToken: `${accountA.accountId}.forgednonce.forgedsig`,
      playerName: 'Forged_Human',
      isAuthenticated: true,
      position: { x: 0, y: 80, z: 0 },
    });
    assert.equal((await rejected).code, 'authentication_required');

    rejected = waitForMessage(
      unauthenticatedWs,
      (msg) => msg.type === 'join_rejected',
      6000,
      'room mode mismatch rejection'
    );
    sendJson(
      unauthenticatedWs,
      joinPayload({
        roomCode: legacyRoom.data.roomCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_mode_mismatch',
        account: accountA,
        playerName: 'Human_Alpha',
      })
    );
    assert.equal((await rejected).code, 'room_mode_mismatch');
    unauthenticatedWs.close();

    // One authenticated human joins. Every client-supplied count/bot claim is
    // ignored: the server reports its own one-human, zero-bot roster.
    const wsA = await connectClient(port);
    sockets.push(wsA);
    const joinedA = await joinHumanRoom(wsA, {
      ...joinPayload({
        roomCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_human_alpha',
        account: accountA,
        playerName: 'Human_Alpha',
        position: { x: 0, y: 80, z: 0 },
      }),
      botCount: 19,
      aiFillEnabled: true,
      connectedHumans: 20,
      readyHumans: 20,
      playerCount: 20,
      participantType: 'bot',
      isBot: true,
    });
    assert.equal(joinedA.connectedHumans, 1);
    assert.equal(joinedA.readyHumans, 0);
    assert.equal(joinedA.botCount, 0);
    assert.equal(joinedA.humanOnly, true);
    assert.equal(joinedA.canStart, false);
    assert.match(joinedA.selfPlayerId, /^net_[a-f0-9]{12}$/);
    assert.doesNotMatch(joinedA.selfPlayerId, /sess_human_alpha/);

    const soloState = await waitForRoomState(
      wsA,
      (msg) => msg.connectedHumans === 1 && msg.players?.length === 1
    );
    assert.equal(soloState.players[0].name, 'Human_Alpha');
    assert.equal(soloState.players[0].participantType, 'human');
    assert.equal(soloState.players[0].isBot, false);
    assert.equal(soloState.players[0].isAuthenticated, true);
    assert.equal(soloState.players[0].isReady, false);
    assertNoSecrets(
      JSON.stringify(soloState),
      [
        accountA.accountToken,
        accountA.passkey,
        'sess_human_alpha',
        accountB.accountToken,
        accountB.passkey,
      ],
      'room_state must not expose account or session secrets'
    );

    // There is no bot-injection path, even if the fake bot claims to be human.
    const botRejected = waitForMessage(
      wsA,
      (msg) => msg.type === 'bot_rejected',
      6000,
      'bot injection rejection'
    );
    sendJson(wsA, {
      type: 'spawn_bot',
      playerName: 'Injected_Bot',
      participantType: 'human',
      isBot: false,
      isAuthenticated: true,
      connectedHumans: 20,
    });
    assert.match((await botRejected).reason, /Bots cannot be injected/);

    // One ready human cannot start, regardless of spoofed ready totals.
    sendJson(wsA, {
      type: 'set_ready',
      ready: true,
      connectedHumans: 20,
      readyHumans: 20,
      playerCount: 20,
    });
    const readySoloState = await waitForRoomState(
      wsA,
      (msg) =>
        msg.connectedHumans === 1 &&
        msg.readyHumans === 1 &&
        msg.canStart === false &&
        msg.phase === 'lobby'
    );
    assert.equal(readySoloState.players.length, 1);

    const startRejected = waitForMessage(
      wsA,
      (msg) => msg.type === 'match_start_rejected',
      6000,
      'one-human start rejection'
    );
    sendJson(wsA, {
      type: 'request_match_start',
      connectedHumans: 20,
      readyHumans: 20,
      botCount: 0,
    });
    assert.match((await startRejected).reason, /at least 2 connected authenticated humans/);

    let unexpectedStart = false;
    await waitForMessage(wsA, (msg) => msg.type === 'match_started', 450, 'unexpected match_started')
      .then(() => {
        unexpectedStart = true;
      })
      .catch(() => {});
    assert.equal(unexpectedStart, false);

    // The second authenticated human joins. HTTP status is server-derived and
    // contains no account/session secrets.
    let wsB = await connectClient(port);
    sockets.push(wsB);
    const joinedB = await joinHumanRoom(
      wsB,
      joinPayload({
        roomCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_human_bravo',
        account: accountB,
        playerName: 'Human_Bravo',
        position: { x: 5, y: 80, z: 5 },
      })
    );
    assert.equal(joinedB.connectedHumans, 2);

    const twoHumanState = await waitForRoomState(
      wsA,
      (msg) =>
        msg.connectedHumans === 2 &&
        msg.readyHumans === 1 &&
        msg.players?.length === 2 &&
        msg.players.every((player) => player.participantType === 'human' && !player.isBot)
    );
    assert.deepEqual(
      twoHumanState.players.map((player) => player.name).sort(),
      ['Human_Alpha', 'Human_Bravo']
    );

    const statusRes = await fetch(
      `${server.base}/api/room?code=${encodeURIComponent(roomCode)}`
    );
    const status = await statusRes.json();
    assert.equal(statusRes.status, 200);
    assert.equal(status.connectedHumans, 2);
    assert.equal(status.readyHumans, 1);
    assert.equal(status.botCount, 0);
    assert.equal(status.canStart, false);
    assertNoSecrets(
      JSON.stringify(status),
      [
        accountA.accountToken,
        accountA.passkey,
        'sess_human_alpha',
        accountB.accountToken,
        accountB.passkey,
        'sess_human_bravo',
      ],
      'HTTP room status must not expose account or session secrets'
    );

    // A pre-start socket disconnect removes Bravo from the lobby immediately.
    const bravoLeft = waitForMessage(
      wsA,
      (msg) => msg.type === 'player_left' && msg.playerName === 'Human_Bravo',
      6000,
      'pre-start disconnect player_left'
    );
    wsB.close();
    await bravoLeft;
    const afterDisconnect = await waitForRoomState(
      wsA,
      (msg) =>
        msg.connectedHumans === 1 &&
        msg.players?.length === 1 &&
        msg.players[0].name === 'Human_Alpha'
    );
    assert.equal(afterDisconnect.readyHumans, 1);

    // Reconnecting with the same account and a new session creates exactly one
    // unready Bravo seat, not a duplicate.
    wsB = await connectClient(port);
    sockets.push(wsB);
    const rejoinedB = await joinHumanRoom(
      wsB,
      joinPayload({
        roomCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_human_bravo_reconnected',
        account: accountB,
        playerName: 'Human_Bravo',
        position: { x: 5, y: 80, z: 5 },
      })
    );
    assert.equal(rejoinedB.connectedHumans, 2);
    const afterReconnect = await waitForRoomState(
      wsA,
      (msg) =>
        msg.connectedHumans === 2 &&
        msg.players?.filter((player) => player.name === 'Human_Bravo').length === 1 &&
        msg.players.find((player) => player.name === 'Human_Bravo')?.isReady === false
    );
    assert.equal(afterReconnect.players.length, 2);
    const reconnectedBravoId = afterReconnect.players.find(
      (player) => player.name === 'Human_Bravo'
    ).id;

    // A second live socket for the same verified account transfers the same
    // seat/public ID and closes the old socket instead of duplicating Bravo.
    const wsBReplacement = await connectClient(port);
    sockets.push(wsBReplacement);
    const transferredB = await joinHumanRoom(
      wsBReplacement,
      joinPayload({
        roomCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_human_bravo_replacement',
        account: accountB,
        playerName: 'Human_Bravo',
        position: { x: 5, y: 80, z: 5 },
      })
    );
    assert.equal(transferredB.selfPlayerId, reconnectedBravoId);
    const afterTransfer = await waitForRoomState(
      wsA,
      (msg) =>
        msg.connectedHumans === 2 &&
        msg.players?.filter((player) => player.name === 'Human_Bravo').length === 1
    );
    assert.equal(afterTransfer.players.length, 2);
    wsB = wsBReplacement;

    // Explicit leave releases a lobby seat immediately and decrements counts.
    const wsC = await connectClient(port);
    sockets.push(wsC);
    await joinHumanRoom(
      wsC,
      joinPayload({
        roomCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_human_charlie',
        account: accountC,
        playerName: 'Human_Charlie',
        position: { x: 10, y: 80, z: 10 },
      })
    );
    await waitForRoomState(
      wsA,
      (msg) => msg.connectedHumans === 3 && msg.players?.length === 3
    );
    const charlieLeft = waitForMessage(
      wsA,
      (msg) => msg.type === 'player_left' && msg.playerName === 'Human_Charlie',
      6000,
      'explicit leave player_left'
    );
    sendJson(wsC, { type: 'leave_room' });
    await charlieLeft;
    await waitForRoomState(
      wsA,
      (msg) =>
        msg.connectedHumans === 2 &&
        msg.players?.length === 2 &&
        !msg.players.some((player) => player.name === 'Human_Charlie')
    );
    wsC.close();

    // Two connected, authenticated, ready humans are sufficient. The server
    // transitions through countdown and starts with exactly those two humans.
    const countdownStatePromise = waitForRoomState(
      wsA,
      (msg) => msg.phase === 'countdown' && msg.readyHumans === 2 && msg.canStart === true
    );
    const matchStartedA = waitForMessage(
      wsA,
      (msg) => msg.type === 'match_started' && msg.roomCode === roomCode,
      6000,
      'private human match_started (Alpha)'
    );
    const matchStartedB = waitForMessage(
      wsB,
      (msg) => msg.type === 'match_started' && msg.roomCode === roomCode,
      6000,
      'private human match_started (Bravo)'
    );
    sendJson(wsB, { type: 'set_ready', ready: true });
    await countdownStatePromise;
    const [startedA, startedB] = await Promise.all([matchStartedA, matchStartedB]);
    for (const started of [startedA, startedB]) {
      assert.equal(started.mode, 'human_only_private');
      assert.equal(started.humanOnly, true);
      assert.equal(started.aiFillEnabled, false);
      assert.equal(started.botCount, 0);
      assert.equal(started.connectedHumans, 2);
      assert.equal(started.matchParticipantCount, 2);
      assert.equal(started.aliveHumans, 2);
      assert.equal(started.players.length, 2);
      assert.ok(
        started.players.every(
          (player) =>
            player.participantType === 'human' &&
            player.isBot === false &&
            player.isParticipant === true
        )
      );
    }
    assert.equal(startedA.selfPlayerId, joinedA.selfPlayerId);
    assert.equal(startedB.selfPlayerId, reconnectedBravoId);
    assert.equal(
      startedA.players.find((player) => player.id === startedA.selfPlayerId)?.name,
      'Human_Alpha'
    );
    assert.equal(
      startedB.players.find((player) => player.id === startedB.selfPlayerId)?.name,
      'Human_Bravo'
    );

    const activeState = await waitForRoomState(
      wsA,
      (msg) =>
        msg.phase === 'active' &&
        msg.players?.length === 2 &&
        msg.players.every(
          (player) =>
            player.participantType === 'human' &&
            player.isBot === false &&
            player.isAuthenticated === true &&
            player.isParticipant === true
        )
    );
    const alphaPublicId = activeState.players.find(
      (player) => player.name === 'Human_Alpha'
    ).id;
    const bravoPublicId = activeState.players.find(
      (player) => player.name === 'Human_Bravo'
    ).id;
    assert.equal(alphaPublicId, joinedA.selfPlayerId);
    assert.equal(bravoPublicId, reconnectedBravoId);

    // No late human (and therefore no AI substitute) can enter an active
    // human-only match.
    const wsLateC = await connectClient(port);
    sockets.push(wsLateC);
    const lateRejected = waitForMessage(
      wsLateC,
      (msg) => msg.type === 'join_rejected',
      6000,
      'active-match late join rejection'
    );
    sendJson(
      wsLateC,
      joinPayload({
        roomCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_human_charlie_late',
        account: accountC,
        playerName: 'Human_Charlie',
      })
    );
    assert.equal((await lateRejected).code, 'match_in_progress');
    wsLateC.close();

    // Human-only combat/victory considers only the two human participants.
    // A catalogued Legendary Rail Sniper headshot is 226 server-derived
    // damage, regardless of the client's forged damage/name fields.
    await equipRegistered(wsA,'sniper','legendary');
    const serverHitB = waitForMessage(
      wsB,
      (msg) => msg.type === 'server_hit' && msg.victimId === bravoPublicId,
      6000,
      'human-only elimination server_hit'
    );
    const matchEndedA = waitForMessage(
      wsA,
      (msg) => msg.type === 'match_ended' && msg.roomCode === roomCode,
      6000,
      'human-only match_ended'
    );
    sendJson(wsA, {
      type: 'fire_weapon',
      category: 'sniper',
      rarity: 'legendary',
      muzzlePos: { x: 0, y: 81, z: 0 },
      hitPoint: { x: 5, y: 81.7, z: 5 },
    });
    sendJson(wsA, {
      type: 'combat_hit',
      hitId: 'human_only_final_hit',
      targetId: bravoPublicId,
      damage: 1,
      isHeadshot: true,
      weaponName: 'Forged Weapon',
      weaponCategory: 'sniper',
      weaponRarity: 'legendary',
      hitPoint: { x: 5, y: 81.7, z: 5 },
      // Spoofed claims must not alter authoritative elimination/victory logic.
      victimIsBot: true,
      aliveHumans: 20,
      winnerId: bravoPublicId,
    });
    const hit = await serverHitB;
    assert.equal(hit.damage, 226);
    assert.equal(hit.weaponName, 'Legendary Rail Sniper');
    assert.equal(hit.eliminated, true);
    assert.equal(hit.victimHealth, 0);
    assert.equal(hit.victimShield, 0);

    const ended = await matchEndedA;
    assert.equal(ended.phase, 'ended');
    assert.equal(ended.winnerId, alphaPublicId);
    assert.equal(ended.winnerName, 'Human_Alpha');
    assert.equal(ended.aliveHumans, 1);
    assert.equal(ended.matchParticipantCount, 2);
    assert.equal(ended.botCount, 0);
    assert.equal(ended.placements[alphaPublicId], 1);
    assert.equal(ended.placements[bravoPublicId], 2);

    const alphaProfileRes = await fetch(
      `${server.base}/api/progression?accountId=${encodeURIComponent(accountA.accountId)}`
    );
    const alphaProfile = await alphaProfileRes.json();
    assert.equal(alphaProfileRes.status, 200);
    assert.ok(alphaProfile.matchesPlayed >= 1);
    assert.ok(alphaProfile.wins >= 1);
    assert.ok(alphaProfile.eliminations >= 1);

    const bravoProfileRes = await fetch(
      `${server.base}/api/progression?accountId=${encodeURIComponent(accountB.accountId)}`
    );
    const bravoProfile = await bravoProfileRes.json();
    assert.equal(bravoProfileRes.status, 200);
    assert.ok(bravoProfile.matchesPlayed >= 1);
    assert.equal(bravoProfile.wins, 0);
    assert.equal(bravoProfile.bestPlacement, 2);

    // Public human matchmaking returns the same open HPLAY lobby to both
    // players, starts only after both ready, and explicit active leave is a
    // human-participant forfeit.
    const firstMatchmake = await postJson(server.base, '/api/room/matchmake', {
      roomMode: 'human_only_public',
    });
    assert.equal(firstMatchmake.res.status, 200);
    assert.match(firstMatchmake.data.roomCode, /^HPLAY-[A-Z0-9]{4}$/);
    assert.equal(firstMatchmake.data.mode, 'human_only_public');
    assert.equal(firstMatchmake.data.botCount, 0);
    const publicRoomCode = firstMatchmake.data.roomCode;

    const wsPublicC = await connectClient(port);
    sockets.push(wsPublicC);
    await joinHumanRoom(
      wsPublicC,
      joinPayload({
        roomCode: publicRoomCode,
        roomMode: 'human_only_public',
        sessionToken: 'sess_human_charlie_public',
        account: accountC,
        playerName: 'Human_Charlie',
        position: { x: 0, y: 80, z: 0 },
      })
    );

    const secondMatchmake = await postJson(server.base, '/api/room/matchmake', {
      roomMode: 'human_only_public',
    });
    assert.equal(secondMatchmake.data.roomCode, publicRoomCode);
    assert.equal(secondMatchmake.data.connectedHumans, 1);

    const wsPublicD = await connectClient(port);
    sockets.push(wsPublicD);
    await joinHumanRoom(
      wsPublicD,
      joinPayload({
        roomCode: publicRoomCode,
        roomMode: 'human_only_public',
        sessionToken: 'sess_human_delta_public',
        account: accountD,
        playerName: 'Human_Delta',
        position: { x: 5, y: 80, z: 5 },
      })
    );

    const publicStarted = waitForMessage(
      wsPublicC,
      (msg) => msg.type === 'match_started' && msg.roomCode === publicRoomCode,
      6000,
      'public human match_started'
    );
    sendJson(wsPublicC, { type: 'set_ready', ready: true });
    sendJson(wsPublicD, { type: 'set_ready', ready: true });
    const publicStart = await publicStarted;
    assert.equal(publicStart.matchParticipantCount, 2);
    assert.equal(publicStart.botCount, 0);

    const publicEnded = waitForMessage(
      wsPublicC,
      (msg) => msg.type === 'match_ended' && msg.roomCode === publicRoomCode,
      6000,
      'public human forfeit match_ended'
    );
    sendJson(wsPublicD, { type: 'leave_room' });
    const publicEnd = await publicEnded;
    assert.equal(publicEnd.winnerName, 'Human_Charlie');
    assert.equal(publicEnd.aliveHumans, 1);
    assert.equal(Object.keys(publicEnd.placements).length, 2);

    // Storm eliminations are also server-authoritative in human-only rooms:
    // a participant moved outside the safe zone is damaged/eliminated by the
    // server, and victory is awarded to the remaining human participant.
    wsA.close();
    wsB.close();
    const stormRoom = await postJson(server.base, '/api/room/create', {
      roomMode: 'human_only_private',
    });
    const stormRoomCode = stormRoom.data.roomCode;
    const wsStormA = await connectClient(port);
    const wsStormB = await connectClient(port);
    sockets.push(wsStormA, wsStormB);
    await joinHumanRoom(
      wsStormA,
      joinPayload({
        roomCode: stormRoomCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_human_alpha_storm',
        account: accountA,
        playerName: 'Human_Alpha',
        position: { x: 0, y: 80, z: 0 },
      })
    );
    await joinHumanRoom(
      wsStormB,
      joinPayload({
        roomCode: stormRoomCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_human_bravo_storm',
        account: accountB,
        playerName: 'Human_Bravo',
        position: { x: 5, y: 80, z: 5 },
      })
    );
    const stormStarted = waitForMessage(
      wsStormA,
      (msg) => msg.type === 'match_started' && msg.roomCode === stormRoomCode,
      6000,
      'storm-test human match_started'
    );
    sendJson(wsStormA, { type: 'set_ready', ready: true });
    sendJson(wsStormB, { type: 'set_ready', ready: true });
    const stormStart = await stormStarted;
    const stormBravoId = stormStart.players.find(
      (player) => player.name === 'Human_Bravo'
    ).id;

    const sendCatalogHit = async (hitId, category, rarity) => {
      await equipRegistered(wsStormA,category,rarity);
      const hitEvent = waitForMessage(
        wsStormB,
        (msg) =>
          msg.type === 'server_hit' &&
          msg.victimId === stormBravoId &&
          msg.weaponCategory === category &&
          msg.weaponRarity === rarity,
        6000,
        `storm-test ${hitId}`
      );
      sendJson(wsStormA, {
        type: 'fire_weapon',
        category,
        rarity,
        muzzlePos: { x: 0, y: 81, z: 0 },
        hitPoint: { x: 5, y: 81, z: 5 },
      });
      sendJson(wsStormA, {
        type: 'combat_hit',
        hitId,
        targetId: stormBravoId,
        damage: 999,
        weaponName: 'Forged Weapon',
        weaponCategory: category,
        weaponRarity: rarity,
        hitPoint: { x: 5, y: 81, z: 5 },
      });
      return hitEvent;
    };

    // 97 + 28 + 24 catalog body damage leaves exactly 1 health for the
    // server's phase-1 storm tick to eliminate.
    const sniperSetup = await sendCatalogHit('storm_setup_sniper', 'sniper', 'rare');
    assert.equal(sniperSetup.damage, 97);
    const rifleSetup = await sendCatalogHit(
      'storm_setup_rare_rifle',
      'assault_rifle',
      'rare'
    );
    assert.equal(rifleSetup.damage, 28);
    const setupHit = await sendCatalogHit(
      'storm_setup_common_rifle',
      'assault_rifle',
      'common'
    );
    assert.equal(setupHit.damage, 24);
    assert.equal(setupHit.victimHealth, 1);
    assert.equal(setupHit.victimShield, 0);
    assert.equal(setupHit.eliminated, false);

    const stormHit = waitForMessage(
      wsStormB,
      (msg) =>
        msg.type === 'server_hit' &&
        msg.attackerId === 'storm' &&
        msg.victimId === stormBravoId &&
        msg.eliminated === true,
      6000,
      'server storm elimination hit'
    );
    const stormEnded = waitForMessage(
      wsStormA,
      (msg) => msg.type === 'match_ended' && msg.roomCode === stormRoomCode,
      6000,
      'storm elimination match_ended'
    );
    sendJson(wsStormB, {
      type: 'player_sync',
      position: { x: 400, y: 80, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      facingYaw: 0,
      pitch: 0,
      isGliding: false,
      isGrounded: true,
    });
    const stormElimination = await stormHit;
    assert.equal(stormElimination.victimHealth, 0);
    const stormEnd = await stormEnded;
    assert.equal(stormEnd.winnerName, 'Human_Alpha');
    assert.equal(stormEnd.aliveHumans, 1);
    assert.equal(stormEnd.placements[stormBravoId], 2);
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('human-only room capacity is enforced server-side at 20 authenticated humans', async () => {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft-human-capacity-'));
  const server = await startServer({
    port,
    sqlitePath: path.join(tmpDir, 'cicraft.sqlite'),
  });
  const sockets = [];

  try {
    const room = await postJson(server.base, '/api/room/create', {
      roomMode: 'human_only_private',
    });
    const roomCode = room.data.roomCode;

    for (let i = 1; i <= 20; i++) {
      const label = String(i).padStart(2, '0');
      const account = await createAccount(server.base, `Capacity_${label}`);
      const ws = await connectClient(port);
      sockets.push(ws);
      const joined = await joinHumanRoom(
        ws,
        joinPayload({
          roomCode,
          roomMode: 'human_only_private',
          sessionToken: `sess_capacity_${label}`,
          account,
          playerName: `Capacity_${label}`,
        })
      );
      assert.equal(joined.connectedHumans, i);
      assert.equal(joined.maxPlayers, 20);
      assert.equal(joined.botCount, 0);
    }

    const overflowAccount = await createAccount(server.base, 'Capacity_21');
    const overflowWs = await connectClient(port);
    sockets.push(overflowWs);
    const overflowRejected = waitForMessage(
      overflowWs,
      (msg) => msg.type === 'join_rejected',
      6000,
      'room_full rejection'
    );
    sendJson(
      overflowWs,
      joinPayload({
        roomCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_capacity_21',
        account: overflowAccount,
        playerName: 'Capacity_21',
      })
    );
    assert.equal((await overflowRejected).code, 'room_full');

    const statusRes = await fetch(
      `${server.base}/api/room?code=${encodeURIComponent(roomCode)}`
    );
    const status = await statusRes.json();
    assert.equal(status.connectedHumans, 20);
    assert.equal(status.totalHumans, 20);
    assert.equal(status.botCount, 0);
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reserved human room codes preserve human-only mode across a server restart', async () => {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft-human-restart-'));
  const sqlitePath = path.join(tmpDir, 'cicraft.sqlite');
  let firstServer;
  let secondServer;
  const sockets = [];

  try {
    firstServer = await startServer({ port, sqlitePath });
    const account = await createAccount(firstServer.base, 'Restart_Human');
    const room = await postJson(firstServer.base, '/api/room/create', {
      roomMode: 'human_only_private',
    });
    const roomCode = room.data.roomCode;
    await firstServer.stop();

    secondServer = await startServer({ port, sqlitePath });
    const statusRes = await fetch(
      `${secondServer.base}/api/room?code=${encodeURIComponent(roomCode)}`
    );
    const status = await statusRes.json();
    assert.equal(status.exists, false, 'in-memory rooms do not survive a restart');
    assert.equal(status.mode, 'human_only_private');
    assert.equal(status.humanOnly, true);
    assert.equal(status.aiFillEnabled, false);
    assert.equal(status.botCount, 0);
    assert.equal(status.minPlayers, 2);
    assert.equal(status.phase, 'lobby');

    // Even without an explicit roomMode field, the HUM- prefix cannot degrade
    // into a legacy AI-fill room after the restart.
    const unauthenticatedWs = await connectClient(port);
    sockets.push(unauthenticatedWs);
    const rejected = waitForMessage(
      unauthenticatedWs,
      (msg) => msg.type === 'join_rejected',
      6000,
      'post-restart unauthenticated rejection'
    );
    sendJson(unauthenticatedWs, {
      type: 'join_room',
      roomCode,
      sessionToken: 'sess_restart_unauthenticated',
      playerName: 'Restart_Bot_Claim',
      participantType: 'human',
      isBot: false,
      isAuthenticated: true,
      position: { x: 0, y: 80, z: 0 },
    });
    assert.equal((await rejected).code, 'authentication_required');
    unauthenticatedWs.close();

    const ws = await connectClient(port);
    sockets.push(ws);
    const joined = await joinHumanRoom(ws, {
      type: 'join_room',
      roomCode,
      sessionToken: 'sess_restart_authenticated',
      accountId: account.accountId,
      accountToken: account.accountToken,
      playerName: 'Restart_Human',
      position: { x: 0, y: 80, z: 0 },
    });
    assert.equal(joined.mode, 'human_only_private');
    assert.equal(joined.phase, 'lobby');
    assert.equal(joined.connectedHumans, 1);
    assert.equal(joined.botCount, 0);
    assert.equal(joined.canStart, false);
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    if (secondServer) await secondServer.stop();
    if (firstServer) await firstServer.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('3.3 four authenticated humans: contested loot, authoritative inventory/reload/use/swap, reconnect and final standings', async () => {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft-four-human-'));
  const server = await startServer({port, sqlitePath:path.join(tmpDir,'game.sqlite')});
  const sockets = [];
  try {
    const {data:room} = await postJson(server.base,'/api/room/create',{roomMode:'human_only_private'});
    const accounts = [], joins = [];
    for (let i=0;i<4;i++) {
      const account = await createAccount(server.base,`Four_${i}`); accounts.push(account);
      const ws = await connectClient(port); sockets.push(ws);
      joins.push(await joinHumanRoom(ws,joinPayload({roomCode:room.roomCode,roomMode:'human_only_private',
        sessionToken:`session_four_${i}`,account,playerName:`Four_${i}`,position:{x:i*2,y:80,z:0}})));
    }
    const starts = sockets.map(ws=>waitForMessage(ws,m=>m.type==='match_started'));
    const registries = sockets.map(ws=>waitForMessage(ws,m=>m.type==='room_loot_sync'));
    sockets.forEach(ws=>sendJson(ws,{type:'set_ready',ready:true}));
    for (const started of await Promise.all(starts)) {
      assert.equal(started.matchParticipantCount,4); assert.equal(started.botCount,0);
      assert.equal(started.players.filter(p=>p.isParticipant).length,4);
    }
    const syncs = await Promise.all(registries);
    assert.deepEqual(syncs[0].spawnedItems,syncs[3].spawnedItems);
    const chest = syncs[0].spawnedItems.find(item=>item.itemType==='chest');
    assert.ok(chest && syncs[0].spawnedItems.length>200);
    for (const ws of sockets.slice(0,2)) sendJson(ws,{type:'player_sync',position:chest.position,isGrounded:true});
    await new Promise(r=>setTimeout(r,100));
    const accepted = waitForMessage(sockets[2],m=>m.type==='loot_collected'&&m.lootId===chest.id);
    const rejectA = waitForMessage(sockets[0],m=>m.type==='loot_collect_rejected'&&m.lootId===chest.id,1500).catch(()=>null);
    const rejectB = waitForMessage(sockets[1],m=>m.type==='loot_collect_rejected'&&m.lootId===chest.id,1500).catch(()=>null);
    for (const ws of sockets.slice(0,2)) sendJson(ws,{type:'collect_loot',lootId:chest.id,itemType:'weapon',
      spawnedDrops:[{id:'evil_injected',weaponCategory:'sniper',rarity:'legendary',amount:999}]});
    const award=await accepted;
    assert.equal(award.itemType,'chest'); assert.equal(award.authoritative,true);
    assert.equal(award.spawnedDrops.length,3);
    assert.ok(award.spawnedDrops.every(item=>item.serverAuthoritative&&item.id!=='evil_injected'));
    const rejects = await Promise.all([rejectA,rejectB]); assert.equal(rejects.filter(Boolean).length,1);
    const collectorIndex=joins.findIndex(j=>j.selfPlayerId===award.collectorId);
    const receipt=waitForMessage(sockets[collectorIndex],m=>m.type==='loot_collected'&&m.lootId===chest.id);
    sendJson(sockets[collectorIndex],{type:'collect_loot',lootId:chest.id});
    assert.deepEqual((await receipt).spawnedDrops,award.spawnedDrops,'retries replay the original award, never new rewards');
    const forged=waitForMessage(sockets[0],m=>m.type==='loot_collect_rejected'&&m.lootId==='evil_injected');
    sendJson(sockets[0],{type:'collect_loot',lootId:'evil_injected',position:chest.position});
    assert.match((await forged).reason,/server-registered/);
    const farItem=syncs[0].spawnedItems.find(item=>item.itemType==='weapon'&&Math.hypot(
      item.position.x-chest.position.x,item.position.z-chest.position.z)>30);
    const range=waitForMessage(sockets[0],m=>m.type==='loot_collect_rejected'&&m.lootId===farItem.id);
    sendJson(sockets[0],{type:'collect_loot',lootId:farItem.id,position:chest.position});
    assert.match((await range).reason,/range/);

    // Real authenticated owner-state protocol; no test-only server hooks.
    const blocked = waitForMessage(sockets[0],m=>m.type==='loot_collect_rejected'&&m.lootId==='loot_init_4');
    sendJson(sockets[0],{type:'player_sync',position:{x:-12.25,y:4.9,z:12.5}});
    sendJson(sockets[0],{type:'collect_loot',lootId:'loot_init_4',position:{x:-16.25,y:4.9,z:16.5}});
    assert.match((await blocked).reason,/geometry/,'nearby loot behind a wall is not reachable');
    const correction=receive(sockets[0],m=>m.type==='position_corrected','embedded player correction');
    sendJson(sockets[0],{type:'player_sync',position:{x:-21.35,y:4.7,z:-21}});
    assert.deepEqual((await correction).position,{x:-12.25,y:4.9,z:12.5});

    const potion=syncs[0].spawnedItems.find(i=>i.weaponCategory==='shield_potion');
    const potionClaim=await claim(sockets[0],potion);
    const potionSlot=potionClaim.state.activeSlot;
    assert.equal(potionClaim.state.inventory[potionSlot].count,1);
    const forgedHeal=receive(sockets[0],m=>m.type==='inventory_state','forged healing');
    sendJson(sockets[0],{type:'heal_sync',health:999,shield:999});
    assert.equal((await forgedHeal).shield,50);
    const used=await action(sockets[0],'use');
    assert.equal(used.result.accepted,true);assert.equal(used.shield,50);assert.equal(used.isHealing,true);
    assert.equal((await action(sockets[0],'use')).result.accepted,false,'duplicate consume does not restart the timer');
    const healed=await receive(sockets[0],m=>m.type==='inventory_state'&&!m.isHealing&&m.shield===100,'consumable completion');
    assert.equal(healed.inventory[potionSlot],null);

    await action(sockets[0],'switch',1);await delay(160);
    const privateLeak=receive(sockets[1],m=>m.type==='inventory_state','private inventory leak',450).then(()=>true,()=>false);
    const fired=receive(sockets[0],m=>m.type==='inventory_state'&&m.processedShotSeq===1,'magazine debit');
    sendJson(sockets[0],{type:'fire_weapon',category:'assault_rifle',rarity:'uncommon',shotSeq:1});
    assert.equal((await fired).inventory[1].clipAmmo,29);
    await delay(190);
    const replayShot=receive(sockets[0],m=>m.type==='inventory_state','shot replay');
    sendJson(sockets[0],{type:'fire_weapon',category:'assault_rifle',rarity:'uncommon',shotSeq:1});
    assert.equal((await replayShot).inventory[1].clipAmmo,29,'same shot ID never consumes/grants a second shot');
    const forgedGun=receive(sockets[0],m=>m.type==='inventory_state'&&m.processedShotSeq===2,'unowned gun');
    sendJson(sockets[0],{type:'fire_weapon',category:'sniper',rarity:'legendary',shotSeq:2});
    assert.equal((await forgedGun).inventory[1].clipAmmo,29);
    const loading=await action(sockets[0],'reload');assert.equal(loading.isReloading,true);
    const forgedState=receive(sockets[0],m=>m.type==='inventory_state','forged reload/ammo metadata');
    sendJson(sockets[0],{type:'player_sync',isReloading:false,reloadTimer:0,equippedCategory:'sniper',equippedRarity:'legendary',
      ammo:{medium:99999},inventory:[{clipAmmo:99999}],health:999,shield:999});
    sendJson(sockets[0],{type:'heal_sync',health:999,shield:999});
    const unchanged=await forgedState;
    assert.equal(unchanged.isReloading,true);assert.equal(unchanged.inventory[1].clipAmmo,29);assert.equal(unchanged.ammo.medium,90);
    const blockedShot=receive(sockets[0],m=>m.type==='inventory_state'&&m.processedShotSeq===3,'shot during reload');
    sendJson(sockets[0],{type:'fire_weapon',category:'assault_rifle',rarity:'uncommon',shotSeq:3});
    assert.equal((await blockedShot).inventory[1].clipAmmo,29);
    const cancel=await action(sockets[0],'switch',2);assert.equal(cancel.isReloading,false);
    assert.equal(cancel.inventory[1].clipAmmo,29);assert.equal(cancel.ammo.medium,90);
    assert.equal(await privateLeak,false,'owner inventory is not broadcast to opponents');
    await action(sockets[0],'switch',1);
    const restart=await action(sockets[0],'reload');assert.equal(restart.result.accepted,true);
    const completed=await receive(sockets[0],m=>m.type==='inventory_state'&&!m.isReloading&&m.inventory[1]?.clipAmmo===30,'reload completion');
    assert.equal(completed.ammo.medium,89);
    const repeat=receive(sockets[0],m=>m.type==='inventory_state'&&m.result?.accepted===false,'repeated reload action');
    sendJson(sockets[0],{type:'inventory_action',action:'reload',seq:restart.lastActionSeq});
    assert.equal((await repeat).ammo.medium,89);

    // Disconnect in a reload: reconnect/resetPlayer cannot mint ammo or heal.
    const secondFire=receive(sockets[0],m=>m.type==='inventory_state'&&m.processedShotSeq===4,'second debit');
    sendJson(sockets[0],{type:'fire_weapon',category:'assault_rifle',rarity:'uncommon',shotSeq:4});
    assert.equal((await secondFire).inventory[1].clipAmmo,29);
    await action(sockets[0],'reload');
    const disconnected=waitForMessage(sockets[3],m=>m.type==='room_state'&&m.players.some(p=>p.id===joins[0].selfPlayerId&&!p.isConnected));
    sockets[0].close();await disconnected;
    sockets[0]=await connectClient(port);
    const restoredState=receive(sockets[0],m=>m.type==='inventory_state','restored owner state');
    const restoredJoin=await joinHumanRoom(sockets[0],{...joinPayload({roomCode:room.roomCode,roomMode:'human_only_private',
      sessionToken:'session_four_0_reconnect',account:accounts[0],playerName:'Four_0',position:{x:0,y:80,z:0}}),resetPlayer:true});
    assert.equal(restoredJoin.selfPlayerId,joins[0].selfPlayerId);
    const restored=await restoredState;
    resumeActions(sockets[0],restored.lastActionSeq);resumeShots(sockets[0],restored.processedShotSeq);
    assert.equal(restored.isReloading,false);assert.equal(restored.inventory[1].clipAmmo,29);
    assert.equal(restored.ammo.medium,89);assert.equal(restored.shield,100);

    // Building/harvesting also spend owned state: no forged placement, damage,
    // duplicate cell, or profitable self-built-material farming.
    sendJson(sockets[0],{type:'player_sync',position:{x:200,y:80,z:0}});
    const invalidBuild=receive(sockets[0],m=>m.type==='inventory_state','invalid build rejected');
    sendJson(sockets[0],{type:'place_build',buildId:'build_four_invalid',pieceType:'invented',material:'wood',x:200,y:80,z:0,yaw:0});
    assert.equal((await invalidBuild).materials.wood,100);
    const built=Promise.all(sockets.map(ws=>receive(ws,m=>m.type==='build_placed'&&m.buildId==='build_four_wall','validated build for every player including owner')));
    const spent=receive(sockets[0],m=>m.type==='inventory_state'&&m.materials.wood===90,'build material debit');
    sendJson(sockets[0],{type:'place_build',buildId:'build_four_wall',pieceType:'wall',material:'wood',x:200,y:80,z:0,yaw:0});
    await built;await spent;
    const repeatedBuild=receive(sockets[0],m=>m.type==='inventory_state','duplicate build cell');
    sendJson(sockets[0],{type:'place_build',buildId:'build_four_duplicate',pieceType:'wall',material:'wood',x:200,y:80,z:0,yaw:0});
    assert.equal((await repeatedBuild).materials.wood,90);
    const forgedEnvironment=receive(sockets[3],m=>m.type==='build_damaged','uncredited environment damage',250).then(()=>true,()=>false);
    sendJson(sockets[0],{type:'damage_build',destructibleId:'build_four_wall',damage:999});
    assert.equal(await forgedEnvironment,false);
    await action(sockets[0],'switch',0);await delay(160);
    for(let swing=0;swing<3;swing++) {
      const damaged=receive(sockets[3],m=>m.type==='build_damaged'&&m.destructibleId==='build_four_wall','catalogued harvester damage');
      sendJson(sockets[0],{type:'fire_weapon',category:'harvester',rarity:'rare'});
      sendJson(sockets[0],{type:'damage_build',destructibleId:'build_four_wall',damage:999});
      assert.equal((await damaged).damage,53);
      if(swing<2)await delay(550);
    }
    const afterHarvest=receive(sockets[0],m=>m.type==='inventory_state','no self-build material minting');
    sendJson(sockets[0],{type:'heal_sync',health:999,shield:999});
    assert.equal((await afterHarvest).materials.wood,90);

    // 4.1: every piece is accepted for all four players; replayed requests and
    // empty material pools receive explicit rejection without duplicate debit.
    let wood=90;
    for (const [index,pieceType] of ['floor','ramp','roof'].entries()) {
      const x=180-index*8,buildId=`build_four_${pieceType}`;
      sendJson(sockets[0],{type:'player_sync',position:{x,y:80,z:0}});
      const all=Promise.all(sockets.map(ws=>receive(ws,m=>m.type==='build_placed'&&m.buildId===buildId,'four-player piece receipt')));
      const debit=receive(sockets[0],m=>m.type==='inventory_state'&&m.materials.wood===wood-10,'single debit');
      const packet={type:'place_build',buildId,pieceType,material:'wood',x,y:80,z:0,yaw:Math.PI/2};
      sendJson(sockets[0],packet);const receipts=await all;await debit;wood-=10;
      assert.ok(receipts.every(r=>r.ownerId===joins[0].selfPlayerId&&r.pieceType===pieceType));
      const rejection=receive(sockets[0],m=>m.type==='build_rejected'&&m.buildId===buildId,'replayed request rejection');
      const unchanged=receive(sockets[0],m=>m.type==='inventory_state','replay did not spend');
      sendJson(sockets[0],packet);await rejection;assert.equal((await unchanged).materials.wood,wood);
    }
    for(let index=0;index<6;index++) {
      const x=120-index*8;sendJson(sockets[0],{type:'player_sync',position:{x,y:80,z:0}});
      const debit=receive(sockets[0],m=>m.type==='inventory_state'&&m.materials.wood===wood-10,'spend remaining wood');
      sendJson(sockets[0],{type:'place_build',buildId:`build_empty_${index}`,pieceType:'floor',material:'wood',x,y:80,z:0,yaw:0});
      await debit;wood-=10;
    }
    const insufficient=receive(sockets[0],m=>m.type==='build_rejected'&&m.buildId==='build_no_wood','empty resources');
    const noDebit=receive(sockets[0],m=>m.type==='inventory_state','empty inventory unchanged');
    sendJson(sockets[0],{type:'place_build',buildId:'build_no_wood',pieceType:'floor',material:'wood',x:80,y:80,z:0,yaw:0});
    assert.match((await insufficient).reason,/Not enough materials/);assert.equal((await noDebit).materials.wood,0);
    const observerLeft=receive(sockets[3],m=>m.type==='room_state'&&m.players.some(p=>p.id===joins[2].selfPlayerId&&!p.isConnected),'observer disconnect');
    sockets[2].close();await observerLeft;sockets[2]=await connectClient(port);
    const replayed=[];const collectReplay=e=>{const m=JSON.parse(String(e.data));if(m.type==='build_placed')replayed.push(m)};
    sockets[2].addEventListener('message',collectReplay);
    const environment=receive(sockets[2],m=>m.type==='environment_state','persisted build replay complete');
    const observerInventory=receive(sockets[2],m=>m.type==='inventory_state','observer restored inventory');
    await joinHumanRoom(sockets[2],joinPayload({roomCode:room.roomCode,roomMode:'human_only_private',sessionToken:'session_four_2_reconnected',account:accounts[2],playerName:'Four_2',position:{x:0,y:80,z:0}}));
    await environment;const restoredObserver=await observerInventory;
    resumeActions(sockets[2],restoredObserver.lastActionSeq);resumeShots(sockets[2],restoredObserver.processedShotSeq);
    assert.equal(replayed.length,9);assert.equal(new Set(replayed.map(b=>b.buildId)).size,9);
    assert.ok(['floor','ramp','roof'].every(type=>replayed.some(b=>b.pieceType===type)));
    assert.ok(!replayed.some(b=>b.buildId==='build_four_wall'),'destroyed walls are not resurrected');
    sockets[2].removeEventListener('message',collectReplay);



    // A full five-slot inventory drops its actual partial magazine, not the
    // client-proposed legendary weapon/999 rounds; receiving it grants no bonus.
    await claim(sockets[0],syncs[0].spawnedItems.find(i=>i.weaponCategory==='dmr'));
    await claim(sockets[0],syncs[0].spawnedItems.find(i=>i.weaponCategory==='heavy_pistol'));
    const replacement=syncs[0].spawnedItems.find(i=>i.weaponCategory==='smg');
    const swapped=await claim(sockets[0],replacement,1,{id:'swap_four_partial',weaponCategory:'sniper',rarity:'legendary',amount:999,clipAmmo:999});
    assert.equal(swapped.receipt.swappedDrop.weaponCategory,'assault_rifle');
    assert.equal(swapped.receipt.swappedDrop.clipAmmo,29);
    const transferred=await claim(sockets[1],swapped.receipt.swappedDrop);
    assert.equal(transferred.state.inventory[3].clipAmmo,29);assert.equal(transferred.state.ammo.medium,90);
    const receiptReplay=receive(sockets[0],m=>m.type==='loot_collected'&&m.lootId===replacement.id,'swap receipt replay');
    sendJson(sockets[0],{type:'collect_loot',lootId:replacement.id});
    assert.equal((await receiptReplay).swappedDrop.id,'swap_four_partial');
    const noClone=receive(sockets[2],m=>m.type==='loot_collect_rejected'&&m.lootId==='swap_four_partial','consumed swap stays consumed');
    sendJson(sockets[2],{type:'collect_loot',lootId:'swap_four_partial'});
    assert.match((await noClone).reason,/already collected/);

    await equipRegistered(sockets[0],'sniper','legendary');

    // End the real four-human match using the unchanged server weapon catalogue.
    sockets.forEach((ws,i)=>sendJson(ws,{type:'player_sync',position:{x:i*2,y:80,z:0},isGrounded:true}));
    await new Promise(r=>setTimeout(r,100));
    const endings = sockets.map(ws=>waitForMessage(ws,m=>m.type==='match_ended',7000));
    for(let i=1;i<4;i++) {
      const hitPromise=waitForMessage(sockets[0],m=>m.type==='server_hit'&&m.victimId===joins[i].selfPlayerId);
      const hitPoint={x:i*2,y:81.7,z:0};
      sendJson(sockets[0],{type:'fire_weapon',category:'sniper',rarity:'legendary',muzzlePos:{x:0,y:81,z:0},hitPoint});
      sendJson(sockets[0],{type:'combat_hit',hitId:`four_final_${i}`,targetId:joins[i].selfPlayerId,
        weaponCategory:'sniper',weaponRarity:'legendary',hitPoint,damage:999999});
      const hit=await hitPromise;
      assert.equal(hit.damage,226); assert.equal(hit.attackerEliminations,i);
      if(i<3) await new Promise(r=>setTimeout(r,1400));
    }
    const results=await Promise.all(endings);
    for(const result of results) {
      assert.equal(result.winnerId,joins[0].selfPlayerId); assert.equal(result.winnerName,'Four_0');
      assert.equal(result.players.find(p=>p.id===joins[0].selfPlayerId).eliminations,3);
      assert.equal(result.placements[joins[0].selfPlayerId],1);
      assert.equal(result.placements[joins[3].selfPlayerId],2);
      assert.equal(result.matchParticipantCount,4); assert.equal(result.aliveHumans,1);
      assertNoSecrets(JSON.stringify(result),accounts.map(a=>a.accountToken),'four-human final result');
    }
  } finally {
    sockets.forEach(ws=>ws.close()); await server.stop(); fs.rmSync(tmpDir,{recursive:true,force:true});
  }
});
