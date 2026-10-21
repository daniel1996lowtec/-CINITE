/**
 * CI Craft — Lobby Browser data utility tests.
 *
 * These run the shared browser filter/sort code against server-shaped
 * LobbySummary records. They are deliberately separate from the WebSocket
 * integration test so search, filtering and sorting regressions fail fast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadUtils() {
  const source = fs.readFileSync(
    path.join(ROOT_DIR, 'src/network/lobbyBrowserUtils.ts'),
    'utf8'
  );
  const javascript = stripTypeScriptTypes(source);
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
}

function lobby(overrides = {}) {
  return {
    id: 'HPLAY-AAA1',
    roomId: 'HPLAY-AAA1',
    roomCode: 'HPLAY-AAA1',
    name: 'Alpha Arena',
    lobbyName: 'Alpha Arena',
    hostName: 'AlphaHost',
    hostPlayerId: 'net_alpha',
    mode: 'human_only_public',
    roomMode: 'human_only_public',
    visibility: 'public',
    isPrivate: false,
    hasPassword: false,
    phase: 'lobby',
    status: 'waiting',
    matchStatus: 'lobby',
    humanOnly: true,
    aiFillEnabled: false,
    botCount: 0,
    botDifficulty: 'medium',
    currentPlayers: 3,
    humanCount: 3,
    connectedHumans: 3,
    readyHumans: 2,
    maxPlayers: 8,
    availableSlots: 5,
    minPlayers: 2,
    mapId: 'ci_island',
    mapName: 'CI Island',
    teamMode: 'duo',
    gameMode: 'duo',
    startCondition: 'all_ready',
    allowLateJoin: false,
    canJoin: true,
    joinBlockReason: '',
    createdAt: 100,
    matchStartedAt: 0,
    pingMs: null,
    ...overrides,
  };
}

test('lobby browser utilities search/filter/sort real summary fields', async () => {
  const utils = await loadUtils();
  const lobbies = [
    lobby(),
    lobby({
      id: 'CI-BBB2',
      roomId: 'CI-BBB2',
      roomCode: 'CI-BBB2',
      name: 'Bravo Bots',
      lobbyName: 'Bravo Bots',
      hostName: 'BravoHost',
      mode: 'online_ai_fill',
      roomMode: 'online_ai_fill',
      humanOnly: false,
      aiFillEnabled: true,
      botCount: 14,
      currentPlayers: 5,
      humanCount: 5,
      connectedHumans: 5,
      readyHumans: 5,
      maxPlayers: 20,
      availableSlots: 15,
      teamMode: 'solo',
      gameMode: 'solo',
      createdAt: 300,
    }),
    lobby({
      id: 'HUM-CCC3',
      roomId: 'HUM-CCC3',
      roomCode: 'HUM-CCC3',
      name: 'Charlie Squad Vault',
      lobbyName: 'Charlie Squad Vault',
      hostName: 'CharlieHost',
      mode: 'human_only_private',
      roomMode: 'human_only_private',
      visibility: 'private',
      isPrivate: true,
      hasPassword: true,
      currentPlayers: 1,
      humanCount: 1,
      connectedHumans: 1,
      readyHumans: 0,
      maxPlayers: 4,
      availableSlots: 3,
      teamMode: 'squad',
      gameMode: 'squad',
      createdAt: 200,
    }),
    lobby({
      id: 'HPLAY-DDD4',
      roomId: 'HPLAY-DDD4',
      roomCode: 'HPLAY-DDD4',
      name: 'Delta Live Match',
      lobbyName: 'Delta Live Match',
      hostName: 'DeltaHost',
      phase: 'active',
      status: 'in_game',
      matchStatus: 'active',
      currentPlayers: 4,
      humanCount: 4,
      connectedHumans: 4,
      availableSlots: 4,
      canJoin: false,
      joinBlockReason: 'This match has already started.',
      teamMode: 'solo',
      gameMode: 'solo',
      createdAt: 400,
    }),
  ];

  const codes = (items) => items.map((item) => item.roomCode);
  const filters = (overrides = {}) => ({ ...utils.DEFAULT_LOBBY_FILTERS, ...overrides });

  assert.deepEqual(
    codes(utils.filterAndSortLobbies(lobbies, filters({ search: 'bravo bots' }), 'newest')),
    ['CI-BBB2']
  );
  assert.deepEqual(
    codes(utils.filterAndSortLobbies(lobbies, filters({ search: 'hum-ccc3' }), 'newest')),
    ['HUM-CCC3']
  );
  assert.deepEqual(
    codes(utils.filterAndSortLobbies(lobbies, filters({ search: 'deltahost' }), 'newest')),
    ['HPLAY-DDD4']
  );
  assert.deepEqual(
    codes(utils.filterAndSortLobbies(lobbies, filters({ humanOnly: true }), 'newest')),
    ['HPLAY-DDD4', 'HUM-CCC3', 'HPLAY-AAA1']
  );
  assert.deepEqual(
    codes(utils.filterAndSortLobbies(lobbies, filters({ visibility: 'private' }), 'newest')),
    ['HUM-CCC3']
  );
  assert.deepEqual(
    codes(utils.filterAndSortLobbies(lobbies, filters({ teamMode: 'squad' }), 'newest')),
    ['HUM-CCC3']
  );
  assert.deepEqual(
    codes(utils.filterAndSortLobbies(lobbies, filters({ availability: 'four_plus' }), 'newest')),
    ['HPLAY-DDD4', 'CI-BBB2', 'HPLAY-AAA1']
  );
  assert.deepEqual(
    codes(utils.filterAndSortLobbies(lobbies, filters({ status: 'waiting' }), 'newest')),
    ['CI-BBB2', 'HUM-CCC3', 'HPLAY-AAA1']
  );
  assert.deepEqual(
    codes(utils.filterAndSortLobbies(lobbies, filters({ mapId: 'ci_island' }), 'newest')),
    ['HPLAY-DDD4', 'CI-BBB2', 'HUM-CCC3', 'HPLAY-AAA1']
  );
  assert.deepEqual(
    codes(utils.filterAndSortLobbies(lobbies, filters(), 'most_players')),
    ['CI-BBB2', 'HPLAY-DDD4', 'HPLAY-AAA1', 'HUM-CCC3']
  );
  assert.deepEqual(
    codes(utils.filterAndSortLobbies(lobbies, filters(), 'fewest_players')),
    ['HUM-CCC3', 'HPLAY-AAA1', 'HPLAY-DDD4', 'CI-BBB2']
  );
  assert.deepEqual(
    codes(utils.filterAndSortLobbies(lobbies, filters(), 'lowest_ping', 25)),
    ['CI-BBB2', 'HPLAY-DDD4', 'HPLAY-AAA1', 'HUM-CCC3'],
    'same-server ping ties fall back deterministically to fuller/newer rooms'
  );

  assert.equal(utils.getLobbyJoinBlock(lobbies[3]), 'This match has already started.');
  assert.equal(
    utils.getLobbyJoinBlock(lobby({ status: 'full', availableSlots: 0, canJoin: false })),
    'This lobby is full.'
  );
  assert.equal(utils.getLobbyJoinBlock(lobbies[0]), '');
  assert.equal(utils.connectionQualityLabel(42), 'Excellent');
  assert.equal(utils.connectionQualityLabel(null), 'Measuring…');
});

test('invite links encode and parse only the public room code', async () => {
  const utils = await loadUtils();
  const url = utils.createLobbyInviteUrl(
    'https://cicraft.example/play?mode=multiplayer#old',
    'hplay-ab12'
  );
  assert.equal(url, 'https://cicraft.example/play?mode=multiplayer&room=HPLAY-AB12');
  assert.equal(utils.parseLobbyInviteCode('?room=hplay-ab12'), 'HPLAY-AB12');
  assert.equal(utils.parseLobbyInviteCode('', '#room=HUM-CD34'), 'HUM-CD34');
  assert.ok(!url.includes('accountToken'));
  assert.ok(!url.includes('sessionToken'));
});
