import { equipRegistered, delay, send as sendGameplay, action, claim, receive, resumeActions, resumeShots } from './gameplayHelpers.mjs';
/**
 * CI Craft — Multiplayer Lobby Browser 3.0 integration tests.
 *
 * Boots the production server and verifies authoritative lobby creation,
 * public discovery, room-ID joins, capacity/password/start rejection,
 * human-only zero-bot enforcement, host transfer, closure, and AI Fill
 * counts with independent WebSocket sessions.
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

async function expectNoMessage(ws, predicate, timeoutMs = 350) {
  await assert.rejects(
    waitForMessage(ws, predicate, timeoutMs, 'unexpected message'),
    /Timed out waiting/
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
  return { res, data: await res.json() };
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
      ACCOUNT_TOKEN_SECRET: 'lobby-browser-integration-secret-0123456789abcdef',
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

  return { child, base, stop, getLog: () => serverLog };
}

function accountFields(account) {
  return {
    accountId: account?.accountId,
    accountToken: account?.accountToken,
  };
}

function joinPayload({ roomCode, roomMode, sessionToken, account, playerName, password }) {
  return {
    type: 'join_room',
    roomCode,
    roomMode,
    purpose: 'lobby',
    joinIntent: 'join_existing',
    password,
    sessionToken,
    ...accountFields(account),
    playerName,
    position: { x: 0, y: 80, z: 0 },
  };
}

async function joinRoom(ws, payload) {
  const result = waitForMessage(
    ws,
    (msg) =>
      (msg.type === 'room_joined' || msg.type === 'join_rejected') &&
      msg.roomCode === payload.roomCode,
    7000,
    `join result for ${payload.roomCode}`
  );
  sendJson(ws, payload);
  return result;
}

async function createLobby(ws, account, playerName, config) {
  const result = waitForMessage(
    ws,
    (msg) => msg.type === 'lobby_created' || msg.type === 'lobby_create_rejected',
    7000,
    'lobby creation result'
  );
  sendJson(ws, {
    type: 'create_lobby',
    ...accountFields(account),
    playerName,
    config,
  });
  return result;
}

async function requestLobbyList(ws) {
  const result = waitForMessage(
    ws,
    (msg) => msg.type === 'lobby_list',
    7000,
    'lobby_list'
  );
  sendJson(ws, { type: 'lobby_list_request', requestId: `test-${Date.now()}` });
  return result;
}

function assertNoSecrets(value, secrets, label) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    if (secret) assert.ok(!serialized.includes(secret), `${label}: leaked a secret`);
  }
  assert.doesNotMatch(
    serialized,
    /accountToken|sessionToken|passkey|passwordHash|token_hash/i,
    label
  );
}

test('lobby browser: authoritative create/discover/join/start, passwords, host transfer, closure, and AI counts', async () => {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft-lobby-test-'));
  const server = await startServer({ port, sqlitePath: path.join(tmpDir, 'cicraft.sqlite') });
  const sockets = [];
  const connect = async () => {
    const ws = await connectClient(port);
    sockets.push(ws);
    return ws;
  };

  try {
    const accountA = await createAccount(server.base, 'Lobby_Alpha');
    const accountB = await createAccount(server.base, 'Lobby_Bravo');
    const accountC = await createAccount(server.base, 'Lobby_Charlie');
    const accountD = await createAccount(server.base, 'Lobby_Delta');
    const secrets = [accountA, accountB, accountC, accountD].flatMap((a) => [
      a.accountToken,
      a.passkey,
    ]);

    const directory = await connect();
    const initialListPromise = waitForMessage(
      directory,
      (msg) => msg.type === 'lobby_list',
      7000,
      'initial lobby_list'
    );
    sendJson(directory, { type: 'lobby_list_subscribe' });
    const initialList = await initialListPromise;
    assert.equal(initialList.lobbies.length, 0);

    const pongPromise = waitForMessage(
      directory,
      (msg) => msg.type === 'pong',
      7000,
      'pong'
    );
    sendJson(directory, { type: 'ping', clientTime: 12345.5 });
    const pong = await pongPromise;
    assert.equal(pong.clientTime, 12345.5);

    let wsA = await connect();
    const unauthenticatedCreate = await createLobby(wsA, null, 'Lobby_Alpha', {
      name: 'No Auth Lobby',
      visibility: 'public',
      humanOnly: true,
      maxPlayers: 4,
      mapId: 'ci_island',
      teamMode: 'solo',
      botCount: 0,
      startCondition: 'all_ready',
    });
    assert.equal(unauthenticatedCreate.type, 'lobby_create_rejected');
    assert.equal(unauthenticatedCreate.code, 'authentication_required');

    const botCreate = await createLobby(wsA, accountA, 'Lobby_Alpha', {
      name: 'Invalid Bot Lobby',
      visibility: 'public',
      humanOnly: true,
      maxPlayers: 4,
      mapId: 'ci_island',
      teamMode: 'solo',
      botCount: 5,
      startCondition: 'all_ready',
    });
    assert.equal(botCreate.type, 'lobby_create_rejected');
    assert.equal(botCreate.code, 'bots_forbidden');

    const invalidCreate = await createLobby(wsA, accountA, 'Lobby_Alpha', {
      name: 'Bad Map Lobby',
      visibility: 'public',
      humanOnly: false,
      maxPlayers: 3,
      mapId: 'not_a_real_map',
      teamMode: 'duo',
      botCount: 9,
      startCondition: 'all_ready',
    });
    assert.equal(invalidCreate.type, 'lobby_create_rejected');
    assert.ok(['invalid_max_players', 'invalid_map', 'team_mode_requires_human_only'].includes(invalidCreate.code));

    const created = await createLobby(wsA, accountA, 'Lobby_Alpha', {
      name: 'Alpha Duo Arena',
      visibility: 'public',
      humanOnly: true,
      maxPlayers: 2,
      mapId: 'ci_island',
      teamMode: 'duo',
      botCount: 0,
      startCondition: 'host_start',
    });
    assert.equal(created.type, 'lobby_created');
    assert.match(created.roomCode, /^HPLAY-/);
    assert.equal(created.name, 'Alpha Duo Arena');
    assert.equal(created.hostName, 'Lobby_Alpha');
    assert.equal(created.humanOnly, true);
    assert.equal(created.botCount, 0);
    assert.equal(created.maxPlayers, 2);
    assert.equal(created.mapId, 'ci_island');
    assert.equal(created.teamMode, 'duo');
    assertNoSecrets(created, secrets, 'lobby_created');

    const firstCode = created.roomCode;
    let list = await requestLobbyList(directory);
    let summary = list.lobbies.find((lobby) => lobby.roomCode === firstCode);
    assert.equal(
      summary,
      undefined,
      'an empty reserved lobby should not pollute public discovery before its host connects'
    );
    assertNoSecrets(list, secrets, 'lobby_list before host join');

    const liveDirectoryUpdatePromise = waitForMessage(
      directory,
      (msg) =>
        msg.type === 'lobby_list_updated' &&
        msg.lobbies?.some(
          (lobby) => lobby.roomCode === firstCode && lobby.currentPlayers === 1
        ),
      7000,
      'live lobby_list_updated after host join'
    );
    const hostJoined = await joinRoom(
      wsA,
      joinPayload({
        roomCode: firstCode,
        roomMode: 'human_only_public',
        sessionToken: 'sess_lobby_a_1',
        account: accountA,
        playerName: 'Lobby_Alpha',
      })
    );
    assert.equal(hostJoined.type, 'room_joined');
    assert.equal(hostJoined.hostPlayerId, hostJoined.selfPlayerId);
    const liveDirectoryUpdate = await liveDirectoryUpdatePromise;
    const liveSummary = liveDirectoryUpdate.lobbies.find(
      (lobby) => lobby.roomCode === firstCode
    );
    assert.equal(liveSummary.currentPlayers, 1);
    assert.equal(liveSummary.humanCount, 1);
    assertNoSecrets(liveDirectoryUpdate, secrets, 'live lobby_list_updated');

    const wsB = await connect();
    const missing = await joinRoom(
      wsB,
      joinPayload({
        roomCode: 'HPLAY-NOPE',
        roomMode: 'human_only_public',
        sessionToken: 'sess_lobby_b_missing',
        account: accountB,
        playerName: 'Lobby_Bravo',
      })
    );
    assert.equal(missing.type, 'join_rejected');
    assert.equal(missing.code, 'room_not_found');

    const guestJoined = await joinRoom(
      wsB,
      joinPayload({
        roomCode: firstCode,
        roomMode: 'human_only_public',
        sessionToken: 'sess_lobby_b_1',
        account: accountB,
        playerName: 'Lobby_Bravo',
      })
    );
    assert.equal(guestJoined.type, 'room_joined');
    assert.notEqual(guestJoined.hostPlayerId, guestJoined.selfPlayerId);

    list = await requestLobbyList(directory);
    summary = list.lobbies.find((lobby) => lobby.roomCode === firstCode);
    assert.equal(summary.currentPlayers, 2);
    assert.equal(summary.humanCount, 2);
    assert.equal(summary.availableSlots, 0);
    assert.equal(summary.status, 'full');

    const searchRes = await fetch(
      `${server.base}/api/lobbies?search=${encodeURIComponent('Lobby_Alpha')}&humanOnly=true&teamMode=duo`
    );
    const searchData = await searchRes.json();
    assert.equal(searchRes.status, 200);
    assert.ok(searchData.lobbies.some((lobby) => lobby.roomCode === firstCode));
    assertNoSecrets(searchData, secrets, 'HTTP lobby search');

    const wsC = await connect();
    const fullJoin = await joinRoom(
      wsC,
      joinPayload({
        roomCode: firstCode,
        roomMode: 'human_only_public',
        sessionToken: 'sess_lobby_c_full',
        account: accountC,
        playerName: 'Lobby_Charlie',
      })
    );
    assert.equal(fullJoin.type, 'join_rejected');
    assert.equal(fullJoin.code, 'room_full');

    sendJson(wsA, { type: 'set_ready', ready: true });
    sendJson(wsB, { type: 'set_ready', ready: true });
    await expectNoMessage(wsA, (msg) => msg.type === 'match_started', 350);

    const nonHostStartPromise = waitForMessage(
      wsB,
      (msg) => msg.type === 'match_start_rejected',
      7000,
      'non-host start rejection'
    );
    sendJson(wsB, { type: 'request_match_start' });
    const nonHostStart = await nonHostStartPromise;
    assert.equal(nonHostStart.code, 'host_only');

    const botRejectedPromise = waitForMessage(
      wsB,
      (msg) => msg.type === 'bot_rejected',
      7000,
      'bot injection rejection'
    );
    sendJson(wsB, { type: 'spawn_bot', botCount: 1, participantType: 'bot' });
    const botRejected = await botRejectedPromise;
    assert.equal(botRejected.botCount, 0);

    const startedA = waitForMessage(wsA, (msg) => msg.type === 'match_started', 7000, 'host match_started');
    const startedB = waitForMessage(wsB, (msg) => msg.type === 'match_started', 7000, 'guest match_started');
    sendJson(wsA, { type: 'request_match_start' });
    const [matchA, matchB] = await Promise.all([startedA, startedB]);
    assert.equal(matchA.botCount, 0);
    assert.equal(matchA.humanOnly, true);
    assert.equal(matchA.matchParticipantCount, 2);
    assert.equal(matchA.teamMode, 'duo');
    assert.equal(new Set(matchA.players.map((p) => p.teamId)).size, 2);
    assert.ok(matchB.players.every((p) => p.participantType === 'human' && p.isBot === false));

    const endedA = waitForMessage(wsA, (msg) => msg.type === 'match_ended', 7000, 'first match_ended');
    sendJson(wsB, { type: 'leave_room' });
    const ended = await endedA;
    assert.ok(ended.winnerIds.includes(hostJoined.selfPlayerId));
    wsA.close();

    // Password-protected private lobby + host transfer on disconnect.
    wsA = await connect();
    const privateCreated = await createLobby(wsA, accountA, 'Lobby_Alpha', {
      name: 'Alpha Private Vault',
      visibility: 'private',
      humanOnly: true,
      maxPlayers: 4,
      mapId: 'ci_island',
      teamMode: 'solo',
      botCount: 0,
      startCondition: 'all_ready',
      password: 'secret123',
    });
    assert.equal(privateCreated.type, 'lobby_created');
    assert.match(privateCreated.roomCode, /^HUM-/);
    assert.equal(privateCreated.hasPassword, true);
    assert.ok(!JSON.stringify(privateCreated).includes('secret123'));
    const privateCode = privateCreated.roomCode;

    const privateHostJoined = await joinRoom(
      wsA,
      joinPayload({
        roomCode: privateCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_private_a_1',
        account: accountA,
        playerName: 'Lobby_Alpha',
        password: 'secret123',
      })
    );
    assert.equal(privateHostJoined.type, 'room_joined');

    list = await requestLobbyList(directory);
    summary = list.lobbies.find((lobby) => lobby.roomCode === privateCode);
    assert.ok(summary, 'password-protected private lobby should be listed as locked');
    assert.equal(summary.visibility, 'private');
    assert.equal(summary.hasPassword, true);
    assert.ok(!JSON.stringify(list).includes('secret123'));
    assertNoSecrets(list, secrets, 'private lobby_list');

    const wrongPassword = await joinRoom(
      wsB,
      joinPayload({
        roomCode: privateCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_private_b_wrong',
        account: accountB,
        playerName: 'Lobby_Bravo',
        password: 'wrong-pass',
      })
    );
    assert.equal(wrongPassword.type, 'join_rejected');
    assert.equal(wrongPassword.code, 'invalid_password');

    const privateGuestJoined = await joinRoom(
      wsB,
      joinPayload({
        roomCode: privateCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_private_b_1',
        account: accountB,
        playerName: 'Lobby_Bravo',
        password: 'secret123',
      })
    );
    assert.equal(privateGuestJoined.type, 'room_joined');

    const hostChangedPromise = waitForMessage(
      wsB,
      (msg) => msg.type === 'host_changed' && msg.hostPlayerId === privateGuestJoined.selfPlayerId,
      7000,
      'host transfer to Bravo'
    );
    wsA.close();
    const hostChanged = await hostChangedPromise;
    assert.equal(hostChanged.hostName, 'Lobby_Bravo');

    wsA = await connect();
    const reconnectedA = await joinRoom(
      wsA,
      joinPayload({
        roomCode: privateCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_private_a_reconnect',
        account: accountA,
        playerName: 'Lobby_Alpha',
        password: 'secret123',
      })
    );
    assert.equal(reconnectedA.type, 'room_joined');
    assert.equal(reconnectedA.hostPlayerId, privateGuestJoined.selfPlayerId);

    const privateStartedA = waitForMessage(wsA, (msg) => msg.type === 'match_started', 7000, 'private A started');
    const privateStartedB = waitForMessage(wsB, (msg) => msg.type === 'match_started', 7000, 'private B started');
    sendJson(wsA, { type: 'set_ready', ready: true });
    sendJson(wsB, { type: 'set_ready', ready: true });
    await Promise.all([privateStartedA, privateStartedB]);

    const lateJoin = await joinRoom(
      wsC,
      joinPayload({
        roomCode: privateCode,
        roomMode: 'human_only_private',
        sessionToken: 'sess_private_c_late',
        account: accountC,
        playerName: 'Lobby_Charlie',
        password: 'secret123',
      })
    );
    assert.equal(lateJoin.type, 'join_rejected');
    assert.equal(lateJoin.code, 'match_in_progress');

    const privateEnded = waitForMessage(wsA, (msg) => msg.type === 'match_ended', 7000, 'private match ended');
    sendJson(wsB, { type: 'leave_room' });
    await privateEnded;
    wsA.close();

    // Host-only closure leaves a short-lived closed-room error and removes discovery.
    wsA = await connect();
    const closeCreated = await createLobby(wsA, accountA, 'Lobby_Alpha', {
      name: 'Alpha Closing Room',
      visibility: 'public',
      humanOnly: true,
      maxPlayers: 2,
      mapId: 'ci_island',
      teamMode: 'solo',
      botCount: 0,
      startCondition: 'host_start',
    });
    assert.equal(closeCreated.type, 'lobby_created');
    const closeCode = closeCreated.roomCode;
    assert.equal(
      (
        await joinRoom(
          wsA,
          joinPayload({
            roomCode: closeCode,
            roomMode: 'human_only_public',
            sessionToken: 'sess_close_a',
            account: accountA,
            playerName: 'Lobby_Alpha',
          })
        )
      ).type,
      'room_joined'
    );
    assert.equal(
      (
        await joinRoom(
          wsB,
          joinPayload({
            roomCode: closeCode,
            roomMode: 'human_only_public',
            sessionToken: 'sess_close_b',
            account: accountB,
            playerName: 'Lobby_Bravo',
          })
        )
      ).type,
      'room_joined'
    );

    const closeRejectedPromise = waitForMessage(
      wsB,
      (msg) => msg.type === 'room_close_rejected',
      7000,
      'non-host close rejection'
    );
    sendJson(wsB, { type: 'close_room' });
    assert.equal((await closeRejectedPromise).code, 'host_only');

    const closedA = waitForMessage(wsA, (msg) => msg.type === 'room_closed', 7000, 'room closed A');
    const closedB = waitForMessage(wsB, (msg) => msg.type === 'room_closed', 7000, 'room closed B');
    sendJson(wsA, { type: 'close_room' });
    await Promise.all([closedA, closedB]);

    list = await requestLobbyList(directory);
    assert.ok(!list.lobbies.some((lobby) => lobby.roomCode === closeCode));
    const closedJoin = await joinRoom(
      wsC,
      joinPayload({
        roomCode: closeCode,
        roomMode: 'human_only_public',
        sessionToken: 'sess_close_c',
        account: accountC,
        playerName: 'Lobby_Charlie',
      })
    );
    assert.equal(closedJoin.type, 'join_rejected');
    assert.equal(closedJoin.code, 'room_closed');

    // Configured HTTP creation requires verified account credentials.
    const unauthenticatedHttp = await postJson(server.base, '/api/room/create', {
      name: 'HTTP No Auth',
      visibility: 'public',
      humanOnly: true,
      maxPlayers: 4,
      mapId: 'ci_island',
      teamMode: 'solo',
      botCount: 0,
      startCondition: 'all_ready',
    });
    assert.equal(unauthenticatedHttp.res.status, 401);
    assert.equal(unauthenticatedHttp.data.code, 'authentication_required');

    // AI Fill browser lobby: humans and configured AI bots stay separate.
    const wsD = await connect();
    const aiCreated = await createLobby(wsC, accountC, 'Lobby_Charlie', {
      name: 'Charlie AI Island',
      visibility: 'public',
      humanOnly: false,
      maxPlayers: 4,
      mapId: 'ci_island',
      teamMode: 'solo',
      botCount: 9,
      botDifficulty: 'hard',
      startCondition: 'all_ready',
    });
    assert.equal(aiCreated.type, 'lobby_created');
    assert.equal(aiCreated.humanOnly, false);
    assert.equal(aiCreated.aiFillEnabled, true);
    assert.equal(aiCreated.botCount, 9);
    const aiCode = aiCreated.roomCode;

    const duplicateHttp = await postJson(server.base, '/api/room/create', {
      name: 'Charlie Duplicate',
      visibility: 'public',
      humanOnly: false,
      maxPlayers: 4,
      mapId: 'ci_island',
      teamMode: 'solo',
      botCount: 5,
      startCondition: 'all_ready',
      playerName: 'Lobby_Charlie',
      ...accountFields(accountC),
    });
    assert.equal(duplicateHttp.res.status, 409);
    assert.equal(duplicateHttp.data.code, 'duplicate_lobby');

    const aiHostJoined = await joinRoom(
      wsC,
      joinPayload({
        roomCode: aiCode,
        roomMode: 'online_ai_fill',
        sessionToken: 'sess_ai_c',
        account: accountC,
        playerName: 'Lobby_Charlie',
      })
    );
    assert.equal(aiHostJoined.type, 'room_joined');
    assert.equal(aiHostJoined.botCount, 9);

    const guestAuthJoin = await joinRoom(
      wsD,
      joinPayload({
        roomCode: aiCode,
        roomMode: 'online_ai_fill',
        sessionToken: 'sess_ai_d_guest',
        account: null,
        playerName: 'Lobby_Delta',
      })
    );
    assert.equal(guestAuthJoin.type, 'join_rejected');
    assert.equal(guestAuthJoin.code, 'authentication_required');

    const aiGuestJoined = await joinRoom(
      wsD,
      joinPayload({
        roomCode: aiCode,
        roomMode: 'online_ai_fill',
        sessionToken: 'sess_ai_d',
        account: accountD,
        playerName: 'Lobby_Delta',
      })
    );
    assert.equal(aiGuestJoined.type, 'room_joined');

    list = await requestLobbyList(directory);
    summary = list.lobbies.find((lobby) => lobby.roomCode === aiCode);
    assert.equal(summary.currentPlayers, 2);
    assert.equal(summary.humanCount, 2);
    assert.equal(summary.botCount, 9);
    assert.equal(summary.humanOnly, false);

    const aiStartedC = waitForMessage(wsC, (msg) => msg.type === 'match_started', 7000, 'AI host started');
    const aiStartedD = waitForMessage(wsD, (msg) => msg.type === 'match_started', 7000, 'AI guest started');
    sendJson(wsC, { type: 'set_ready', ready: true });
    sendJson(wsD, { type: 'set_ready', ready: true });
    const [aiStartC, aiStartD] = await Promise.all([aiStartedC, aiStartedD]);
    assert.equal(aiStartC.matchParticipantCount, 2);
    assert.equal(aiStartC.botCount, 9);
    assert.equal(aiStartD.botCount, 9);
    assert.ok(aiStartC.players.every((p) => p.participantType === 'human' && p.isBot === false));

    // Four-player Duo: server assigns two balanced teams, blocks friendly
    // fire, and declares victory only when every opposing team is eliminated.
    sendJson(wsC, { type: 'leave_room' });
    sendJson(wsD, { type: 'leave_room' });
    await new Promise((resolve) => setTimeout(resolve, 120));

    const duoCreated = await createLobby(wsA, accountA, 'Lobby_Alpha', {
      name: 'Alpha Duo Team Test',
      visibility: 'public',
      humanOnly: true,
      maxPlayers: 4,
      mapId: 'ci_island',
      teamMode: 'duo',
      botCount: 0,
      startCondition: 'all_ready',
    });
    assert.equal(duoCreated.type, 'lobby_created');
    const duoCode = duoCreated.roomCode;
    const duoSockets = [
      { ws: wsA, account: accountA, name: 'Lobby_Alpha', session: 'sess_duo_a' },
      { ws: wsB, account: accountB, name: 'Lobby_Bravo', session: 'sess_duo_b' },
      { ws: wsC, account: accountC, name: 'Lobby_Charlie', session: 'sess_duo_c' },
      { ws: wsD, account: accountD, name: 'Lobby_Delta', session: 'sess_duo_d' },
    ];
    const duoJoined = new Map();
    for (const entry of duoSockets) {
      const joinedDuo = await joinRoom(
        entry.ws,
        joinPayload({
          roomCode: duoCode,
          roomMode: 'human_only_public',
          sessionToken: entry.session,
          account: entry.account,
          playerName: entry.name,
        })
      );
      assert.equal(joinedDuo.type, 'room_joined');
      duoJoined.set(joinedDuo.selfPlayerId, entry);
    }
    assert.equal(duoJoined.size, 4);

    const duoStarts = duoSockets.map((entry) =>
      waitForMessage(entry.ws, (msg) => msg.type === 'match_started', 7000, 'duo match_started')
    );
    for (const entry of duoSockets) sendJson(entry.ws, { type: 'set_ready', ready: true });
    const duoStartedMessages = await Promise.all(duoStarts);
    const duoStarted = duoStartedMessages[0];
    assert.equal(duoStarted.matchParticipantCount, 4);
    const teamGroups = new Map();
    for (const player of duoStarted.players) {
      const members = teamGroups.get(player.teamId) || [];
      members.push(player);
      teamGroups.set(player.teamId, members);
    }
    assert.equal(teamGroups.size, 2);
    assert.deepEqual(
      Array.from(teamGroups.values()).map((members) => members.length).sort(),
      [2, 2]
    );

    const alphaSummary = duoStarted.players.find(
      (player) => player.id === duoStarted.selfPlayerId
    );
    assert.ok(alphaSummary);
    const teammate = duoStarted.players.find(
      (player) => player.id !== alphaSummary.id && player.teamId === alphaSummary.teamId
    );
    const opponents = duoStarted.players.filter(
      (player) => player.teamId !== alphaSummary.teamId
    );
    assert.ok(teammate);
    assert.equal(opponents.length, 2);
    await equipRegistered(wsA,'sniper','legendary');

    sendJson(wsA, {
      type: 'fire_weapon',
      category: 'sniper',
      rarity: 'legendary',
      muzzlePos: { x: 0, y: 81, z: 0 },
      hitPoint: { x: 0, y: 81.7, z: 0 },
    });
    sendJson(wsA, {
      type: 'combat_hit',
      hitId: 'duo-friendly-fire',
      targetId: teammate.id,
      damage: 240,
      isHeadshot: true,
      weaponName: 'Legendary Rail Sniper',
      weaponCategory: 'sniper',
      weaponRarity: 'legendary',
      hitPoint: { x: 0, y: 81.7, z: 0 },
    });
    await expectNoMessage(wsA, (msg) => msg.type === 'server_hit', 300);

    const duoEndedPromise = waitForMessage(
      wsA,
      (msg) => msg.type === 'match_ended',
      7000,
      'duo team match_ended'
    );
    for (const [index, opponent] of opponents.entries()) {
      await delay(1400);
      const hitPromise = waitForMessage(
        wsA,
        (msg) => msg.type === 'server_hit' && msg.victimId === opponent.id && msg.eliminated,
        7000,
        'duo opponent elimination'
      );
      sendJson(wsA, {
        type: 'fire_weapon',
        category: 'sniper',
        rarity: 'legendary',
        muzzlePos: { x: 0, y: 81, z: 0 },
        hitPoint: { x: 0, y: 81.7, z: 0 },
      });
      sendJson(wsA, {
        type: 'combat_hit',
        hitId: `duo-kill-${index}`,
        targetId: opponent.id,
        damage: 240,
        isHeadshot: true,
        weaponName: 'Legendary Rail Sniper',
        weaponCategory: 'sniper',
        weaponRarity: 'legendary',
        hitPoint: { x: 0, y: 81.7, z: 0 },
      });
      await hitPromise;
    }

    const duoEnded = await duoEndedPromise;
    assert.equal(duoEnded.winnerTeamId, alphaSummary.teamId);
    assert.ok(duoEnded.winnerIds.includes(alphaSummary.id));
    assert.ok(duoEnded.winnerIds.includes(teammate.id));
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
