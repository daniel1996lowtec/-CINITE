import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  GAME_MODES,
  MATCH_DURATION_SECONDS,
  KILL_TARGET,
  FFA_TARGET_KILLS,
  TDM_TARGET_KILLS,
  normalizeGameMode,
  isValidGameMode,
  getMatchRules,
  isRespawnMode,
  isTimedMode,
  isStormEnabledForMode,
  getRemainingMatchSeconds,
  isMatchTimeExpired,
  formatMatchClock,
  createInitialVitals,
  applyAuthoritativeDamage,
  applyRespawnVitals,
  assignTeamsForMode,
  areTeammates,
  computeTeamScores,
  evaluateMatchOutcome,
} from '../shared/matchRules.mjs';
import {
  RESPAWN_ANCHORS,
  isPlayerPositionClear,
  safeRespawnPosition,
} from '../server/worldGeometry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

test('CI CRAFT 5.0 shared match rules: Battle Royale, Free for All (50 kills / 10m), and Team Deathmatch (RED vs BLUE / 50 kills / 10m)', () => {
  assert.deepEqual(GAME_MODES, [
    'battle_royale',
    'free_for_all',
    'team_deathmatch',
  ]);
  assert.equal(MATCH_DURATION_SECONDS, 600);
  assert.equal(KILL_TARGET, 50);
  assert.equal(FFA_TARGET_KILLS, 50);
  assert.equal(TDM_TARGET_KILLS, 50);

  // Mode normalization and validation
  assert.equal(isValidGameMode('battle_royale'), true);
  assert.equal(isValidGameMode('free_for_all'), true);
  assert.equal(isValidGameMode('team_deathmatch'), true);
  assert.equal(isValidGameMode('ffa'), true);
  assert.equal(isValidGameMode('tdm'), true);
  assert.equal(isValidGameMode('capture_the_flag'), false);
  assert.equal(normalizeGameMode('ffa'), 'free_for_all');
  assert.equal(normalizeGameMode('tdm'), 'team_deathmatch');
  assert.equal(normalizeGameMode('unknown'), 'battle_royale');

  // Per-mode rule definitions
  const brRules = getMatchRules('battle_royale');
  assert.equal(brRules.autoRespawn, false);
  assert.equal(brRules.durationSeconds, null);
  assert.equal(brRules.targetKills, null);
  assert.equal(brRules.stormEnabled, true);
  assert.equal(isRespawnMode('battle_royale'), false);
  assert.equal(isTimedMode('battle_royale'), false);
  assert.equal(isStormEnabledForMode('battle_royale'), true);

  const ffaRules = getMatchRules('free_for_all');
  assert.equal(ffaRules.autoRespawn, true);
  assert.equal(ffaRules.durationSeconds, 600);
  assert.equal(ffaRules.targetKills, 50);
  assert.equal(ffaRules.stormEnabled, false);
  assert.equal(isRespawnMode('free_for_all'), true);
  assert.equal(isTimedMode('free_for_all'), true);
  assert.equal(isStormEnabledForMode('free_for_all'), false);

  const tdmRules = getMatchRules('team_deathmatch');
  assert.equal(tdmRules.autoRespawn, true);
  assert.equal(tdmRules.durationSeconds, 600);
  assert.equal(tdmRules.targetKills, 50);
  assert.equal(tdmRules.stormEnabled, false);
  assert.deepEqual(tdmRules.teams, ['red', 'blue']);

  // Timer helpers
  assert.equal(getRemainingMatchSeconds('free_for_all', 0), 600);
  assert.equal(getRemainingMatchSeconds('free_for_all', 125), 475);
  assert.equal(getRemainingMatchSeconds('free_for_all', 650), 0);
  assert.equal(isMatchTimeExpired('free_for_all', 599.9), false);
  assert.equal(isMatchTimeExpired('free_for_all', 600), true);
  assert.equal(formatMatchClock(600), '10:00');
  assert.equal(formatMatchClock(65), '01:05');

  // Authoritative damage & respawn vitals
  const victim = {
    id: 'p1',
    ...createInitialVitals('free_for_all'),
    position: { x: 0, y: 6, z: 0 },
  };
  assert.equal(victim.health, 200);
  assert.equal(victim.shield, 50);
  assert.equal(victim.livesRemaining, null);

  const hit1 = applyAuthoritativeDamage(victim, 70);
  assert.equal(hit1.shieldAbsorbed, 50);
  assert.equal(hit1.healthLost, 20);
  assert.equal(hit1.isShieldBreak, true);
  assert.equal(hit1.lethal, false);
  assert.equal(victim.shield, 0);
  assert.equal(victim.health, 180);

  // 9.3: health is 200, so a second hit must exceed the remaining 180 to be lethal.
  const hit2 = applyAuthoritativeDamage(victim, 180);
  assert.equal(hit2.lethal, true);
  assert.equal(victim.health, 0);

  applyRespawnVitals(victim, { x: -58, y: 8.15, z: -24 });
  assert.equal(victim.alive, true);
  assert.equal(victim.health, 200);
  assert.equal(victim.shield, 50);
  assert.equal(victim.respawns, 1);
  assert.deepEqual(victim.position, { x: -58, y: 8.15, z: -24 });
});

test('CI CRAFT 5.0 outcome evaluation: FFA 50-kill target, FFA timeout leader/draw, TDM 50-kill combined team target, TDM timeout winner & tie draw', () => {
  // 1. Free for All: 49 kills before 600s does NOT end match; 50th kill wins immediately
  const ffaPlayers = [
    { id: 'p1', name: 'Alpha', isParticipant: true, alive: true, eliminations: 49, damageDealt: 4900, deaths: 10 },
    { id: 'p2', name: 'Bravo', isParticipant: true, alive: true, eliminations: 42, damageDealt: 4200, deaths: 15 },
  ];
  const ffaMid = evaluateMatchOutcome({
    mode: 'free_for_all',
    players: ffaPlayers,
    elapsedSeconds: 320,
  });
  assert.equal(ffaMid.ended, false);

  ffaPlayers[0].eliminations = 50;
  const ffaWin50 = evaluateMatchOutcome({
    mode: 'free_for_all',
    players: ffaPlayers,
    elapsedSeconds: 325,
  });
  assert.equal(ffaWin50.ended, true);
  assert.equal(ffaWin50.reason, 'score_limit');
  assert.equal(ffaWin50.isDraw, false);
  assert.equal(ffaWin50.winnerId, 'p1');
  assert.equal(ffaWin50.winnerName, 'Alpha');
  assert.equal(ffaWin50.placements.p1, 1);
  assert.equal(ffaWin50.placements.p2, 2);

  // 2. Free for All: time expires at 600s -> highest kill count wins
  ffaPlayers[0].eliminations = 31;
  ffaPlayers[1].eliminations = 38;
  const ffaTimeoutWin = evaluateMatchOutcome({
    mode: 'free_for_all',
    players: ffaPlayers,
    elapsedSeconds: 600,
  });
  assert.equal(ffaTimeoutWin.ended, true);
  assert.equal(ffaTimeoutWin.reason, 'time_expired');
  assert.equal(ffaTimeoutWin.isDraw, false);
  assert.equal(ffaTimeoutWin.winnerId, 'p2');
  assert.equal(ffaTimeoutWin.winnerName, 'Bravo');

  // 3. Free for All: tied top kills at 600s -> draw
  ffaPlayers[0].eliminations = 38;
  ffaPlayers[1].eliminations = 38;
  const ffaTimeoutDraw = evaluateMatchOutcome({
    mode: 'free_for_all',
    players: ffaPlayers,
    elapsedSeconds: 600,
  });
  assert.equal(ffaTimeoutDraw.ended, true);
  assert.equal(ffaTimeoutDraw.reason, 'time_expired_draw');
  assert.equal(ffaTimeoutDraw.isDraw, true);
  assert.equal(ffaTimeoutDraw.winnerId, null);

  // 4. Team Deathmatch: RED vs BLUE assignment, friendly-fire protection, and 50 combined team kills
  const tdmRoster = [
    { id: 'r1', name: 'RedOne', joinedAt: 1, isParticipant: true, alive: true, eliminations: 27 },
    { id: 'b1', name: 'BlueOne', joinedAt: 2, isParticipant: true, alive: true, eliminations: 20 },
    { id: 'r2', name: 'RedTwo', joinedAt: 3, isParticipant: true, alive: true, eliminations: 23 },
    { id: 'b2', name: 'BlueTwo', joinedAt: 4, isParticipant: true, alive: true, eliminations: 19 },
  ];
  assignTeamsForMode('team_deathmatch', tdmRoster);
  assert.equal(tdmRoster[0].teamId, 'red');
  assert.equal(tdmRoster[1].teamId, 'blue');
  assert.equal(tdmRoster[2].teamId, 'red');
  assert.equal(tdmRoster[3].teamId, 'blue');
  assert.equal(areTeammates('team_deathmatch', tdmRoster[0], tdmRoster[2]), true);
  assert.equal(areTeammates('team_deathmatch', tdmRoster[0], tdmRoster[1]), false);

  const scores = computeTeamScores(tdmRoster);
  assert.deepEqual(scores, { red: 50, blue: 39 });

  const tdmWin50 = evaluateMatchOutcome({
    mode: 'team_deathmatch',
    players: tdmRoster,
    elapsedSeconds: 410,
  });
  assert.equal(tdmWin50.ended, true);
  assert.equal(tdmWin50.reason, 'score_limit');
  assert.equal(tdmWin50.isDraw, false);
  assert.equal(tdmWin50.winnerTeamId, 'red');
  assert.equal(tdmWin50.winnerName, 'RED TEAM');
  assert.deepEqual(tdmWin50.winnerIds.sort(), ['r1', 'r2']);
  assert.equal(tdmWin50.placements.r1, 1);
  assert.equal(tdmWin50.placements.r2, 1);
  assert.equal(tdmWin50.placements.b1, 2);
  assert.equal(tdmWin50.placements.b2, 2);

  // 5. Team Deathmatch: time expires at 600s -> higher team score wins
  tdmRoster[0].eliminations = 18;
  tdmRoster[2].eliminations = 14; // RED = 32
  tdmRoster[1].eliminations = 22;
  tdmRoster[3].eliminations = 19; // BLUE = 41
  const tdmTimeoutBlue = evaluateMatchOutcome({
    mode: 'team_deathmatch',
    players: tdmRoster,
    elapsedSeconds: 600,
  });
  assert.equal(tdmTimeoutBlue.ended, true);
  assert.equal(tdmTimeoutBlue.reason, 'time_expired');
  assert.equal(tdmTimeoutBlue.isDraw, false);
  assert.equal(tdmTimeoutBlue.winnerTeamId, 'blue');
  assert.equal(tdmTimeoutBlue.winnerName, 'BLUE TEAM');

  // 6. Team Deathmatch: tied score at 600s -> draw
  tdmRoster[0].eliminations = 20;
  tdmRoster[2].eliminations = 21; // RED = 41
  const tdmTimeoutDraw = evaluateMatchOutcome({
    mode: 'team_deathmatch',
    players: tdmRoster,
    elapsedSeconds: 600,
  });
  assert.equal(tdmTimeoutDraw.ended, true);
  assert.equal(tdmTimeoutDraw.reason, 'time_expired_draw');
  assert.equal(tdmTimeoutDraw.isDraw, true);
  assert.equal(tdmTimeoutDraw.winnerId, null);
  assert.equal(tdmTimeoutDraw.winnerTeamId, 'draw');
  assert.equal(tdmTimeoutDraw.winnerName, 'DRAW');
});

test('CI CRAFT 5.0 safeRespawnPosition: all anchors clear static and buildable geometry and separate opposing teams', () => {
  const room = {
    players: new Map([
      [
        'enemy_1',
        {
          id: 'enemy_1',
          alive: true,
          teamId: 'blue',
          position: { x: 58, y: 8, z: 24 },
        },
      ],
    ]),
    buildables: new Map(),
    destroyedProps: new Set(),
  };

  for (let i = 0; i < RESPAWN_ANCHORS.length; i++) {
    const pos = safeRespawnPosition(room, { id: 'self', teamId: 'red' });
    assert.equal(isPlayerPositionClear(room, pos), true);
    assert.ok(pos.y < 35, `Expected ground spawn, got y=${pos.y}`);
  }
});

test('CI CRAFT 5.0 main menu markup exposes Battle Royale, Free for All, and Team Deathmatch choices', async () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
  assert.match(html, /id="game-mode-choices"/);
  assert.match(html, /id="btn-game-mode-br"[\s\S]*?Battle Royale/);
  assert.match(html, /id="btn-game-mode-ffa"[\s\S]*?Free for All/);
  assert.match(html, /id="btn-game-mode-tdm"[\s\S]*?Team Deathmatch/);
  assert.match(html, /id="solo-game-mode-select"/);
  assert.match(html, /id="create-lobby-game-mode"/);
  assert.match(html, /id="lobby-filter-game-mode"/);

  // Verify lobbyBrowserUtils mode filtering and labels
  const ts = (await import('typescript')).default;
  const utilCode = ts.transpileModule(
    fs.readFileSync(path.join(ROOT_DIR, 'src/network/lobbyBrowserUtils.ts'), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    }
  ).outputText;
  const utilMod = await import(
    `data:text/javascript;base64,${Buffer.from(utilCode).toString('base64')}`
  );
  const sampleLobbies = [
    {
      roomCode: 'BR01',
      name: 'Island BR',
      hostName: 'HostA',
      visibility: 'public',
      humanOnly: true,
      matchMode: 'battle_royale',
      teamMode: 'solo',
      availableSlots: 4,
      currentPlayers: 4,
      maxPlayers: 8,
      status: 'waiting',
      mapId: 'ci_island',
      createdAt: 100,
      canJoin: true,
    },
    {
      roomCode: 'FFA1',
      name: 'Island FFA',
      hostName: 'HostB',
      visibility: 'public',
      humanOnly: true,
      matchMode: 'free_for_all',
      teamMode: 'solo',
      availableSlots: 4,
      currentPlayers: 4,
      maxPlayers: 8,
      status: 'waiting',
      mapId: 'ci_island',
      createdAt: 200,
      canJoin: true,
    },
    {
      roomCode: 'TDM1',
      name: 'Red vs Blue TDM',
      hostName: 'HostC',
      visibility: 'public',
      humanOnly: true,
      matchMode: 'team_deathmatch',
      teamMode: 'solo',
      availableSlots: 4,
      currentPlayers: 4,
      maxPlayers: 8,
      status: 'waiting',
      mapId: 'ci_island',
      createdAt: 300,
      canJoin: true,
    },
  ];
  const ffaFiltered = utilMod.filterAndSortLobbies(
    sampleLobbies,
    { ...utilMod.DEFAULT_LOBBY_FILTERS, matchMode: 'free_for_all' },
    'newest'
  );
  assert.equal(ffaFiltered.length, 1);
  assert.equal(ffaFiltered[0].roomCode, 'FFA1');

  const tdmFiltered = utilMod.filterAndSortLobbies(
    sampleLobbies,
    { ...utilMod.DEFAULT_LOBBY_FILTERS, matchMode: 'team_deathmatch' },
    'newest'
  );
  assert.equal(tdmFiltered.length, 1);
  assert.equal(tdmFiltered[0].roomCode, 'TDM1');

  assert.equal(utilMod.matchModeLabel('battle_royale'), 'Battle Royale');
  assert.equal(utilMod.matchModeLabel('free_for_all'), 'Free for All');
  assert.equal(utilMod.matchModeLabel('team_deathmatch'), 'Team Deathmatch');
  assert.equal(utilMod.matchModeLabel('team_deathmatch', true), 'TDM');
});

async function getFreePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

async function startServer(extraEnv = {}) {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft50-test-'));
  const sqlitePath = path.join(tmpDir, 'test.sqlite');
  const child = spawn(process.execPath, ['server/multiplayerServer.mjs'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SQLITE_DB_PATH: sqlitePath,
      HUMAN_MATCH_COUNTDOWN_MS: '250',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) break;
    } catch {
      // Wait for server startup
    }
    await new Promise((r) => setTimeout(r, 60));
  }

  return {
    port,
    baseUrl,
    wsUrl,
    async stop() {
      if (!child.killed) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function createVerifiedAccount(baseUrl, callsign) {
  const res = await fetch(`${baseUrl}/api/account/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  return {
    accountId: data.accountId,
    accountToken: data.accountToken,
    callsign: data.profile.callsign,
    sessionToken: `sess_${crypto.randomBytes(6).toString('hex')}`,
  };
}

function connectWsClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const messages = [];
    const waiters = [];

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(msg)) {
          const w = waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      }
    });

    ws.addEventListener('open', () => {
      resolve({
        ws,
        messages,
        send(payload) {
          ws.send(JSON.stringify(payload));
        },
        waitFor(predicate, timeoutMs = 6000) {
          const existing = messages.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error('Timed out waiting for WS message')),
              timeoutMs
            );
            waiters.push({ predicate, resolve: res, timer });
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            // Ignore
          }
        },
      });
    });
    ws.addEventListener('error', reject);
  });
}

test('CI CRAFT 5.0 authoritative server: FFA auto-respawn on lethal combat_hit, TDM RED/BLUE friendly-fire protection & team scoring, and timer expiry', async () => {
  const srv = await startServer({ RESPAWN_MATCH_DURATION_SECONDS: '3' });
  try {
    const hostAcc = await createVerifiedAccount(srv.baseUrl, 'AlphaHost');
    const guestAcc = await createVerifiedAccount(srv.baseUrl, 'BravoGuest');

    const c1 = await connectWsClient(srv.wsUrl);
    const c2 = await connectWsClient(srv.wsUrl);

    // 1. Create a Team Deathmatch lobby
    c1.send({
      type: 'create_lobby',
      requestId: 'req_tdm_1',
      accountId: hostAcc.accountId,
      accountToken: hostAcc.accountToken,
      playerName: hostAcc.callsign,
      config: {
        name: 'TDM Red vs Blue Arena',
        visibility: 'public',
        humanOnly: true,
        maxPlayers: 8,
        mapId: 'ci_island',
        matchMode: 'team_deathmatch',
        teamMode: 'solo',
        startCondition: 'all_ready',
      },
    });

    const created = await c1.waitFor((m) => m.type === 'lobby_created');
    assert.equal(created.matchMode, 'team_deathmatch');
    assert.equal(created.targetKills, 50);
    assert.equal(created.autoRespawn, true);
    const roomCode = created.roomCode;

    // Join both players into the TDM lobby
    c1.send({
      type: 'join_room',
      roomCode,
      roomMode: 'human_only_public',
      matchMode: 'team_deathmatch',
      sessionToken: hostAcc.sessionToken,
      accountId: hostAcc.accountId,
      accountToken: hostAcc.accountToken,
      playerName: hostAcc.callsign,
      starterLoadout: 'sharpshooter',
    });
    c2.send({
      type: 'join_room',
      roomCode,
      roomMode: 'human_only_public',
      matchMode: 'team_deathmatch',
      sessionToken: guestAcc.sessionToken,
      accountId: guestAcc.accountId,
      accountToken: guestAcc.accountToken,
      playerName: guestAcc.callsign,
      starterLoadout: 'sharpshooter',
    });

    const j1 = await c1.waitFor((m) => m.type === 'room_joined');
    const j2 = await c2.waitFor((m) => m.type === 'room_joined');
    const p1Id = j1.selfPlayerId;
    const p2Id = j2.selfPlayerId;

    // Ready up both players to start the TDM match
    c1.messages.length = 0;
    c2.messages.length = 0;
    c1.send({ type: 'set_ready', ready: true });
    c2.send({ type: 'set_ready', ready: true });

    const started = await c1.waitFor((m) => m.type === 'match_started');
    assert.equal(started.matchMode, 'team_deathmatch');
    const p1Snap = started.players.find((p) => p.id === p1Id);
    const p2Snap = started.players.find((p) => p.id === p2Id);
    assert.ok(p1Snap && p2Snap);
    assert.notEqual(p1Snap.teamId, p2Snap.teamId);
    assert.deepEqual([p1Snap.teamId, p2Snap.teamId].sort(), ['blue', 'red']);

    // Position both players on clear flat ground near each other so line of sight is unobstructed
    const posA = { x: -34, y: 8.15, z: 28 };
    const posB = { x: -34, y: 8.15, z: 32 };
    c1.send({
      type: 'player_sync',
      sessionToken: hostAcc.sessionToken,
      seq: 1,
      position: posA,
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      facingYaw: 0,
      pitch: 0,
      isGrounded: true,
      isGliding: false,
    });
    c2.send({
      type: 'player_sync',
      sessionToken: guestAcc.sessionToken,
      seq: 1,
      position: posB,
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      facingYaw: 0,
      pitch: 0,
      isGrounded: true,
      isGliding: false,
    });
    await new Promise((r) => setTimeout(r, 80));

    // Fire 3 headshots with rare DMR (84 headshot damage -> 3 shots = 252 > 250 HP+Shield)
    for (let shot = 1; shot <= 3; shot++) {
      c1.send({
        type: 'fire_weapon',
        shotSeq: shot,
        category: 'dmr',
        rarity: 'rare',
        muzzlePos: { x: posA.x, y: posA.y + 1.2, z: posA.z },
        hitPoint: { x: posB.x, y: posB.y + 1.5, z: posB.z },
      });
      c1.send({
        type: 'combat_hit',
        hitId: `tdm_hit_${shot}`,
        targetId: p2Id,
        weaponCategory: 'dmr',
        weaponRarity: 'rare',
        hitPoint: { x: posB.x, y: posB.y + 1.5, z: posB.z },
      });
      if (shot < 3) await new Promise((r) => setTimeout(r, 420));
    }

    const lethalHit = await c1.waitFor(
      (m) => m.type === 'server_hit' && m.eliminated === true
    );
    assert.equal(lethalHit.respawned, true);
    assert.ok(lethalHit.respawnPosition);
    assert.equal(lethalHit.teamScores[p1Snap.teamId], 1);

    const respawnEv = await c2.waitFor(
      (m) => m.type === 'player_respawned' && m.playerId === p2Id
    );
    assert.equal(respawnEv.health, 200);
    assert.equal(respawnEv.shield, 50);
    assert.equal(respawnEv.deaths, 1);
    assert.equal(respawnEv.respawns, 1);

    // Wait for the 3-second test timer to expire and verify the leading team wins on timeout
    const ended = await c1.waitFor((m) => m.type === 'match_ended', 6000);
    assert.equal(ended.matchMode, 'team_deathmatch');
    assert.equal(ended.isDraw, false);
    assert.equal(ended.winnerTeamId, p1Snap.teamId);
    assert.equal(ended.endReason, 'time_expired');

    c1.close();
    c2.close();
  } finally {
    await srv.stop();
  }
});

test('CI CRAFT 5.0 authoritative server: Battle Royale preserves 1-life immediate elimination win while Free for All respawns and scores', async () => {
  const srv = await startServer({ RESPAWN_MATCH_DURATION_SECONDS: '3' });
  try {
    const hostAcc = await createVerifiedAccount(srv.baseUrl, 'BrVictor');
    const guestAcc = await createVerifiedAccount(srv.baseUrl, 'BrFallen');

    const c1 = await connectWsClient(srv.wsUrl);
    const c2 = await connectWsClient(srv.wsUrl);

    // 1. Create a Battle Royale lobby and verify 1 kill immediately ends the match without respawn
    c1.send({
      type: 'create_lobby',
      requestId: 'req_br_1',
      accountId: hostAcc.accountId,
      accountToken: hostAcc.accountToken,
      playerName: hostAcc.callsign,
      config: {
        name: 'BR Classic Island',
        visibility: 'public',
        humanOnly: true,
        maxPlayers: 8,
        mapId: 'ci_island',
        matchMode: 'battle_royale',
        teamMode: 'solo',
        startCondition: 'all_ready',
      },
    });
    const createdBr = await c1.waitFor((m) => m.type === 'lobby_created');
    assert.equal(createdBr.matchMode, 'battle_royale');
    assert.equal(createdBr.autoRespawn, false);

    c1.send({
      type: 'join_room',
      roomCode: createdBr.roomCode,
      roomMode: 'human_only_public',
      matchMode: 'battle_royale',
      sessionToken: hostAcc.sessionToken,
      accountId: hostAcc.accountId,
      accountToken: hostAcc.accountToken,
      playerName: hostAcc.callsign,
      starterLoadout: 'sharpshooter',
    });
    c2.send({
      type: 'join_room',
      roomCode: createdBr.roomCode,
      roomMode: 'human_only_public',
      matchMode: 'battle_royale',
      sessionToken: guestAcc.sessionToken,
      accountId: guestAcc.accountId,
      accountToken: guestAcc.accountToken,
      playerName: guestAcc.callsign,
      starterLoadout: 'sharpshooter',
    });

    const j1 = await c1.waitFor((m) => m.type === 'room_joined');
    const j2 = await c2.waitFor((m) => m.type === 'room_joined');
    const p1Id = j1.selfPlayerId;
    const p2Id = j2.selfPlayerId;

    c1.messages.length = 0;
    c2.messages.length = 0;
    c1.send({ type: 'set_ready', ready: true });
    c2.send({ type: 'set_ready', ready: true });

    const startedBr = await c1.waitFor((m) => m.type === 'match_started');
    assert.equal(startedBr.matchMode, 'battle_royale');

    const posA = { x: -34, y: 8.15, z: 28 };
    const posB = { x: -34, y: 8.15, z: 32 };
    c1.send({
      type: 'player_sync',
      sessionToken: hostAcc.sessionToken,
      seq: 1,
      position: posA,
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      facingYaw: 0,
      pitch: 0,
      isGrounded: true,
      isGliding: false,
    });
    c2.send({
      type: 'player_sync',
      sessionToken: guestAcc.sessionToken,
      seq: 1,
      position: posB,
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      facingYaw: 0,
      pitch: 0,
      isGrounded: true,
      isGliding: false,
    });
    await new Promise((r) => setTimeout(r, 80));

    for (let shot = 1; shot <= 3; shot++) {
      c1.send({
        type: 'fire_weapon',
        shotSeq: shot,
        category: 'dmr',
        rarity: 'rare',
        muzzlePos: { x: posA.x, y: posA.y + 1.2, z: posA.z },
        hitPoint: { x: posB.x, y: posB.y + 1.5, z: posB.z },
      });
      c1.send({
        type: 'combat_hit',
        hitId: `br_hit_${shot}`,
        targetId: p2Id,
        weaponCategory: 'dmr',
        weaponRarity: 'rare',
        hitPoint: { x: posB.x, y: posB.y + 1.5, z: posB.z },
      });
      if (shot < 3) await new Promise((r) => setTimeout(r, 420));
    }

    const brLethal = await c1.waitFor(
      (m) => m.type === 'server_hit' && m.eliminated === true
    );
    assert.equal(brLethal.respawned, false);

    const brEnded = await c1.waitFor((m) => m.type === 'match_ended', 4000);
    assert.equal(brEnded.matchMode, 'battle_royale');
    assert.equal(brEnded.winnerId, p1Id);
    assert.equal(brEnded.winnerName, hostAcc.callsign);

    c1.close();
    c2.close();
  } finally {
    await srv.stop();
  }
});

test('CI CRAFT 5.0 authoritative server: Free for All respawn + timeout winner, and TDM friendly-fire block + 0-0 draw on timeout', async () => {
  const srv = await startServer({ RESPAWN_MATCH_DURATION_SECONDS: '3' });
  try {
    const acc1 = await createVerifiedAccount(srv.baseUrl, 'FfaAce');
    const acc2 = await createVerifiedAccount(srv.baseUrl, 'FfaRival');
    const acc3 = await createVerifiedAccount(srv.baseUrl, 'TdmMate');

    const c1 = await connectWsClient(srv.wsUrl);
    const c2 = await connectWsClient(srv.wsUrl);

    // Part A: Free for All live match -> kill respawns victim, match continues until timer expires
    c1.send({
      type: 'create_lobby',
      requestId: 'req_ffa_1',
      accountId: acc1.accountId,
      accountToken: acc1.accountToken,
      playerName: acc1.callsign,
      config: {
        name: 'FFA 50 Kills Arena',
        visibility: 'public',
        humanOnly: true,
        maxPlayers: 8,
        mapId: 'ci_island',
        matchMode: 'free_for_all',
        teamMode: 'solo',
        startCondition: 'all_ready',
      },
    });
    const createdFfa = await c1.waitFor((m) => m.type === 'lobby_created');
    assert.equal(createdFfa.matchMode, 'free_for_all');
    assert.equal(createdFfa.targetKills, 50);
    assert.equal(createdFfa.autoRespawn, true);

    c1.send({
      type: 'join_room',
      roomCode: createdFfa.roomCode,
      roomMode: 'human_only_public',
      matchMode: 'free_for_all',
      sessionToken: acc1.sessionToken,
      accountId: acc1.accountId,
      accountToken: acc1.accountToken,
      playerName: acc1.callsign,
      starterLoadout: 'sharpshooter',
    });
    c2.send({
      type: 'join_room',
      roomCode: createdFfa.roomCode,
      roomMode: 'human_only_public',
      matchMode: 'free_for_all',
      sessionToken: acc2.sessionToken,
      accountId: acc2.accountId,
      accountToken: acc2.accountToken,
      playerName: acc2.callsign,
      starterLoadout: 'sharpshooter',
    });

    const ffaJ1 = await c1.waitFor((m) => m.type === 'room_joined');
    const ffaJ2 = await c2.waitFor((m) => m.type === 'room_joined');
    const ffaP1 = ffaJ1.selfPlayerId;
    const ffaP2 = ffaJ2.selfPlayerId;

    c1.messages.length = 0;
    c2.messages.length = 0;
    c1.send({ type: 'set_ready', ready: true });
    c2.send({ type: 'set_ready', ready: true });

    await c1.waitFor((m) => m.type === 'match_started');

    const posA = { x: -34, y: 8.15, z: 28 };
    const posB = { x: -34, y: 8.15, z: 32 };
    c1.send({
      type: 'player_sync',
      sessionToken: acc1.sessionToken,
      seq: 1,
      position: posA,
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      facingYaw: 0,
      pitch: 0,
      isGrounded: true,
      isGliding: false,
    });
    c2.send({
      type: 'player_sync',
      sessionToken: acc2.sessionToken,
      seq: 1,
      position: posB,
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      facingYaw: 0,
      pitch: 0,
      isGrounded: true,
      isGliding: false,
    });
    await new Promise((r) => setTimeout(r, 80));

    for (let shot = 1; shot <= 3; shot++) {
      c1.send({
        type: 'fire_weapon',
        shotSeq: shot,
        category: 'dmr',
        rarity: 'rare',
        muzzlePos: { x: posA.x, y: posA.y + 1.2, z: posA.z },
        hitPoint: { x: posB.x, y: posB.y + 1.5, z: posB.z },
      });
      c1.send({
        type: 'combat_hit',
        hitId: `ffa_hit_${shot}`,
        targetId: ffaP2,
        weaponCategory: 'dmr',
        weaponRarity: 'rare',
        hitPoint: { x: posB.x, y: posB.y + 1.5, z: posB.z },
      });
      if (shot < 3) await new Promise((r) => setTimeout(r, 420));
    }

    const ffaRespawn = await c2.waitFor(
      (m) => m.type === 'player_respawned' && m.playerId === ffaP2
    );
    assert.equal(ffaRespawn.health, 200);
    assert.equal(ffaRespawn.shield, 50);

    const ffaEnded = await c1.waitFor((m) => m.type === 'match_ended', 6000);
    assert.equal(ffaEnded.matchMode, 'free_for_all');
    assert.equal(ffaEnded.isDraw, false);
    assert.equal(ffaEnded.winnerId, ffaP1);
    assert.equal(ffaEnded.endReason, 'time_expired');

    c1.close();
    c2.close();

    // Part B: Team Deathmatch friendly-fire rejection and 0-0 draw on timer expiration
    const t1 = await connectWsClient(srv.wsUrl);
    const t2 = await connectWsClient(srv.wsUrl);
    const t3 = await connectWsClient(srv.wsUrl);

    t1.send({
      type: 'create_lobby',
      requestId: 'req_tdm_draw',
      accountId: acc1.accountId,
      accountToken: acc1.accountToken,
      playerName: acc1.callsign,
      config: {
        name: 'TDM Friendly Fire & Draw Test',
        visibility: 'public',
        humanOnly: true,
        maxPlayers: 8,
        mapId: 'ci_island',
        matchMode: 'team_deathmatch',
        teamMode: 'solo',
        startCondition: 'all_ready',
      },
    });
    const tdmCreated = await t1.waitFor((m) => m.type === 'lobby_created');

    for (const [client, acc] of [
      [t1, acc1],
      [t2, acc2],
      [t3, acc3],
    ]) {
      client.send({
        type: 'join_room',
        roomCode: tdmCreated.roomCode,
        roomMode: 'human_only_public',
        matchMode: 'team_deathmatch',
        sessionToken: acc.sessionToken,
        accountId: acc.accountId,
        accountToken: acc.accountToken,
        playerName: acc.callsign,
        starterLoadout: 'sharpshooter',
      });
    }

    await t1.waitFor((m) => m.type === 'room_joined');
    await t2.waitFor((m) => m.type === 'room_joined');
    await t3.waitFor((m) => m.type === 'room_joined');

    t1.messages.length = 0;
    t2.messages.length = 0;
    t3.messages.length = 0;

    t1.send({ type: 'set_ready', ready: true });
    t2.send({ type: 'set_ready', ready: true });
    t3.send({ type: 'set_ready', ready: true });

    const tdmStarted = await t1.waitFor((m) => m.type === 'match_started');
    const redPlayers = tdmStarted.players.filter((p) => p.teamId === 'red');
    assert.equal(redPlayers.length, 2, 'Expected 2 RED players in 3-player TDM');

    // Sync the 2 RED teammates side-by-side and verify friendly fire produces NO server_hit
    const clientById = new Map([
      [tdmStarted.players[0].id, { client: t1, acc: acc1 }],
    ]);
    // Map each joined client by selfPlayerId
    for (const [c, a] of [
      [t1, acc1],
      [t2, acc2],
      [t3, acc3],
    ]) {
      const p = tdmStarted.players.find((pl) => pl.name === a.callsign);
      if (p) clientById.set(p.id, { client: c, acc: a });
    }

    const redA = clientById.get(redPlayers[0].id);
    const redB = clientById.get(redPlayers[1].id);
    assert.ok(redA && redB);

    redA.client.send({
      type: 'player_sync',
      sessionToken: redA.acc.sessionToken,
      seq: 1,
      position: posA,
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      facingYaw: 0,
      pitch: 0,
      isGrounded: true,
      isGliding: false,
    });
    redB.client.send({
      type: 'player_sync',
      sessionToken: redB.acc.sessionToken,
      seq: 1,
      position: posB,
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      facingYaw: 0,
      pitch: 0,
      isGrounded: true,
      isGliding: false,
    });
    await new Promise((r) => setTimeout(r, 80));

    // Attempt friendly fire from redA onto teammate redB
    redA.client.send({
      type: 'fire_weapon',
      shotSeq: 1,
      category: 'dmr',
      rarity: 'rare',
      muzzlePos: { x: posA.x, y: posA.y + 1.2, z: posA.z },
      hitPoint: { x: posB.x, y: posB.y + 1.5, z: posB.z },
    });
    redA.client.send({
      type: 'combat_hit',
      hitId: 'friendly_fire_attempt',
      targetId: redPlayers[1].id,
      weaponCategory: 'dmr',
      weaponRarity: 'rare',
      hitPoint: { x: posB.x, y: posB.y + 1.5, z: posB.z },
    });

    const tdmDrawEnded = await t1.waitFor((m) => m.type === 'match_ended', 6000);
    const friendlyHits = t1.messages.filter((m) => m.type === 'server_hit');
    assert.equal(friendlyHits.length, 0, 'Friendly fire must be rejected by server');
    assert.equal(tdmDrawEnded.matchMode, 'team_deathmatch');
    assert.equal(tdmDrawEnded.isDraw, true);
    assert.equal(tdmDrawEnded.winnerId, null);
    assert.equal(tdmDrawEnded.winnerTeamId, 'draw');
    assert.equal(tdmDrawEnded.winnerName, 'DRAW');
    assert.deepEqual(tdmDrawEnded.teamScores, { red: 0, blue: 0 });

    t1.close();
    t2.close();
    t3.close();
  } finally {
    await srv.stop();
  }
});
