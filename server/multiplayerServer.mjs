/**
 * CI Craft 3D Battle Royale — Production Authoritative Multiplayer & Account Server (v2.8)
 *
 * Features:
 * 1. Persistent Account Identity & Career Progression (PostgreSQL via `DATABASE_URL` or durable on-disk SQLite)
 * 2. Cross-Device Account Passkey authentication & recovery (`/api/account/init`, `/api/account/restore`)
 * 3. Private & Public Room Codes (`/api/room`, `/api/room/create`) with duplicate-identity prevention
 * 4. Server-authoritative combat hit validation, shield/health deduction, loot deduplication & XP calculation
 * 5. WebSocket payload size limits, rate limiting, room garbage collection & graceful SIGTERM/SIGINT shutdown
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PersistenceManager,
  computeLevelFromXp,
  sanitizeCallsign,
  sanitizeCosmetics,
} from './database.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// Hosting platforms (Render/Railway/Fly) inject PORT at runtime — always honor
// it. 2567 is only the local-development fallback when PORT is unset/invalid.
const parsedPort = Number(process.env.PORT);
const PORT =
  Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    ? parsedPort
    : 2567;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_WS_PAYLOAD_BYTES = 16 * 1024;
const MAX_HTTP_BODY_BYTES = 32 * 1024;
const SERVER_STARTED_AT = Date.now();

// Authoritative room/matchmaking rules. These values are always computed by
// the server from live authenticated socket sessions; any counts or bot/AI
// fields supplied by a client are ignored.
const ROOM_MODES = new Set([
  'online_ai_fill',
  'human_only_public',
  'human_only_private',
]);
const ROOM_MAX_HUMANS = 20;
const HUMAN_ONLY_MIN_PLAYERS = 2;
const HUMAN_MATCH_COUNTDOWN_MS = Math.max(
  250,
  Math.min(10_000, Number(process.env.HUMAN_MATCH_COUNTDOWN_MS || 3000) || 3000)
);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const db = new PersistenceManager();
// Database connection + idempotent schema migrations run at server startup
// (never during the Docker/platform image build, where the production
// DATABASE_URL — e.g. Render's internal PostgreSQL hostname — is unreachable).
try {
  await db.init();
} catch (err) {
  console.error(
    '[CI Craft Multiplayer] Fatal: database initialization (connection/migrations) failed:',
    err
  );
  process.exit(1);
}

/** @type {Map<string, any>} */
const rooms = new Map();

/**
 * Fallback in-memory profile cache used only if DB experiences a transient outage
 * or for ephemeral anonymous session tokens.
 * @type {Map<string, any>}
 */
const memoryProfiles = new Map();

/**
 * IP-based rate limiter for sensitive HTTP endpoints (`/api/account/restore`, `/api/room/create`).
 * @type {Map<string, { count: number, resetAt: number }>}
 */
const httpRateLimits = new Map();

function checkHttpRateLimit(ip, key, maxRequests = 12, windowMs = 60000) {
  const now = Date.now();
  const bucketKey = `${ip}_${key}`;
  let entry = httpRateLimits.get(bucketKey);
  if (!entry || now > entry.resetAt) {
    entry = { count: 1, resetAt: now + windowMs };
    httpRateLimits.set(bucketKey, entry);
    return true;
  }
  entry.count += 1;
  return entry.count <= maxRequests;
}

export function sanitizeRoomCode(rawCode) {
  if (typeof rawCode !== 'string') return 'CICRAFT-1';
  const cleaned = rawCode
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 14);
  return cleaned.length >= 3 ? cleaned : 'CICRAFT-1';
}

function normalizeRoomMode(rawMode) {
  if (rawMode === undefined || rawMode === null || rawMode === '') return null;
  const mode = String(rawMode).trim().toLowerCase();
  if (mode === 'online' || mode === 'online_ai_fill') return 'online_ai_fill';
  if (mode === 'human_only_public' || mode === 'human_only_private') return mode;
  return 'invalid';
}

function isHumanOnlyMode(mode) {
  return mode === 'human_only_public' || mode === 'human_only_private';
}

function roomVisibilityForMode(mode) {
  if (mode === 'human_only_public') return 'public';
  if (mode === 'human_only_private') return 'private';
  return 'room_code';
}

function inferRoomModeForCode(code) {
  const normalized = sanitizeRoomCode(code);
  if (normalized.startsWith('HPLAY-')) return 'human_only_public';
  if (normalized.startsWith('HUM-')) return 'human_only_private';
  return null;
}

function resolveRequestedRoomMode(rawMode, code) {
  const inferredMode = code ? inferRoomModeForCode(code) : null;
  const normalized = normalizeRoomMode(rawMode);
  if (normalized === 'invalid') {
    return { mode: null, error: 'Invalid multiplayer room mode.' };
  }
  if (inferredMode && normalized && normalized !== inferredMode) {
    return {
      mode: null,
      error: `Room code ${sanitizeRoomCode(code)} is reserved for ${inferredMode}.`,
    };
  }
  return { mode: normalized || inferredMode || 'online_ai_fill', error: null };
}

function generateUniqueRoomCode(mode = 'online_ai_fill') {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const prefix =
    mode === 'human_only_public'
      ? 'HPLAY'
      : mode === 'human_only_private'
        ? 'HUM'
        : 'CI';
  for (let attempt = 0; attempt < 20; attempt++) {
    let suffix = '';
    const bytes = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) {
      suffix += chars[bytes[i] % chars.length];
    }
    const candidate = `${prefix}-${suffix}`;
    if (!rooms.has(candidate)) return candidate;
  }
  return `${prefix}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

function generatePublicPlayerId(room) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `net_${crypto.randomBytes(6).toString('hex')}`;
    let exists = false;
    for (const player of room.players.values()) {
      if (player.id === candidate) {
        exists = true;
        break;
      }
    }
    if (!exists) return candidate;
  }
  return `net_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function resolvePlayerProfile(accountId, sessionToken, callsign) {
  const key = accountId || `sess_${String(sessionToken || 'anon')}`;
  if (accountId && db.isConnected) {
    try {
      const row = await db.getAccountRow(accountId);
      if (row) {
        const prof = db.rowToProfile(row);
        memoryProfiles.set(key, prof);
        return prof;
      }
    } catch {
      // Fall back to memory profile if DB query fails transiently
    }
  }
  if (!memoryProfiles.has(key)) {
    memoryProfiles.set(key, {
      accountId: key,
      sessionToken: String(sessionToken || 'anon'),
      callsign: sanitizeCallsign(callsign),
      matchesPlayed: 0,
      wins: 0,
      eliminations: 0,
      damageDealt: 0,
      bestPlacement: 0,
      xp: 0,
      level: 1,
      cosmetics: sanitizeCosmetics(null),
      unlockedOutfits: ['vanguard_blue', 'emerald_ranger'],
      storageMode: 'server_verified',
      persistenceBackend: db.backend,
    });
  }
  return memoryProfiles.get(key);
}

async function applyAuthoritativeProgression(player, delta) {
  if (player.accountId && db.isConnected) {
    try {
      const updated = await db.recordAuthoritativeProgression(player.accountId, delta);
      if (updated) {
        memoryProfiles.set(player.accountId, updated);
        return updated;
      }
    } catch {
      // Fall back to in-memory update on transient DB error
    }
  }
  const prof = await resolvePlayerProfile(
    player.accountId,
    player.sessionToken,
    player.name
  );
  prof.matchesPlayed += Math.max(0, Number(delta.matchesDelta || 0));
  prof.wins += Math.max(0, Number(delta.winsDelta || 0));
  prof.eliminations += Math.max(0, Number(delta.eliminationsDelta || 0));
  prof.damageDealt += Math.max(0, Number(delta.damageDelta || 0));
  if (delta.placement > 0) {
    prof.bestPlacement =
      prof.bestPlacement === 0
        ? delta.placement
        : Math.min(prof.bestPlacement, delta.placement);
  }
  prof.xp += Math.max(0, Number(delta.xpDelta || 0));
  prof.level = computeLevelFromXp(prof.xp);
  return prof;
}

function createInitialStorm() {
  return {
    phase: 1,
    currentCenterX: 0,
    currentCenterZ: 0,
    currentRadius: 255,
    targetCenterX: 12,
    targetCenterZ: -10,
    targetRadius: 145,
    phaseTimer: 40,
    isShrinking: false,
    damagePerSecond: 2,
  };
}

function getOrCreateRoom(code, requestedMode = 'online_ai_fill') {
  const normalized = sanitizeRoomCode(code);
  if (!rooms.has(normalized)) {
    const mode = inferRoomModeForCode(normalized) || requestedMode;
    const humanOnly = isHumanOnlyMode(mode);
    rooms.set(normalized, {
      code: normalized,
      mode,
      visibility: roomVisibilityForMode(mode),
      // Legacy online rooms preserve the existing instant-drop behavior.
      // Human-only rooms start in a lobby and can only become active through
      // the server-side ready check below.
      phase: humanOnly ? 'lobby' : 'active',
      maxPlayers: ROOM_MAX_HUMANS,
      minPlayers: humanOnly ? HUMAN_ONLY_MIN_PLAYERS : 1,
      countdownEndsAt: 0,
      countdownTimer: null,
      matchStartedAt: 0,
      matchEndedAt: 0,
      matchParticipantIds: new Set(),
      placements: new Map(),
      winnerId: null,
      winnerName: '',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      matchTimer: 0,
      storm: createInitialStorm(),
      players: new Map(),
      buildables: new Map(),
      collectedLootIds: new Set(),
      spawnedLootItems: new Map(),
      processedHitIds: new Set(),
      hitEventSeq: 0,
      matchSeq: 1,
      lastStormDamageAt: 0,
      stormDamageInProgress: false,
    });
  }
  const room = rooms.get(normalized);
  room.lastActivityAt = Date.now();
  return room;
}

function getRoomHumanPlayers(room) {
  // Every server room entry is created only from a real WebSocket session.
  // The server has no bot-spawn path; local AI in legacy modes remains a
  // client-side simulation and is never represented as a room player here.
  return Array.from(room.players.values()).filter(
    (player) => player.participantType === 'human' && player.isBot === false
  );
}

function getConnectedAuthenticatedHumans(room) {
  return getRoomHumanPlayers(room).filter(
    (player) => player.isConnected && player.isAuthenticated && player.accountId
  );
}

function getRoomCounts(room) {
  const humans = getRoomHumanPlayers(room);
  const connectedHumansList = humans.filter((player) => player.isConnected);
  const authenticatedConnected = getConnectedAuthenticatedHumans(room);
  const readyHumansList = authenticatedConnected.filter((player) => player.isReady);
  const aliveHumans = humans.filter(
    (player) => player.alive && player.isParticipant
  ).length;

  return {
    totalHumans: humans.length,
    connectedHumans: connectedHumansList.length,
    authenticatedHumans: authenticatedConnected.length,
    readyHumans: readyHumansList.length,
    aliveHumans,
  };
}

function canStartHumanMatch(room) {
  if (!isHumanOnlyMode(room.mode)) return false;
  const connectedAuthenticated = getConnectedAuthenticatedHumans(room);
  return (
    connectedAuthenticated.length >= room.minPlayers &&
    connectedAuthenticated.every((player) => player.isReady)
  );
}

function buildRoomSummary(room) {
  const counts = getRoomCounts(room);
  const humanOnly = isHumanOnlyMode(room.mode);
  return {
    roomCode: room.code,
    mode: room.mode,
    roomMode: room.mode,
    visibility: room.visibility,
    phase: room.phase,
    matchStatus: room.phase,
    humanOnly,
    aiFillEnabled: room.mode === 'online_ai_fill',
    botCount: 0,
    connectedPlayers: counts.connectedHumans,
    connectedHumans: counts.connectedHumans,
    authenticatedHumans: counts.authenticatedHumans,
    readyPlayers: counts.readyHumans,
    readyHumans: counts.readyHumans,
    totalPlayers: counts.totalHumans,
    totalHumans: counts.totalHumans,
    aliveHumans: counts.aliveHumans,
    maxPlayers: room.maxPlayers,
    minPlayers: room.minPlayers,
    matchParticipantCount: room.matchParticipantIds.size,
    countdownEndsAt: room.countdownEndsAt || 0,
    canStart: canStartHumanMatch(room),
    winnerId: room.winnerId,
    winnerName: room.winnerName,
    stormPhase: room.storm.phase,
  };
}

function sendToPlayer(player, payload) {
  if (player?.socket && !player.socket.destroyed) {
    try {
      player.socket.write(encodeWsFrame(payload));
    } catch {
      // The close handler will reconcile disconnected state.
    }
  }
}

function cancelHumanCountdown(room) {
  if (room.countdownTimer) {
    clearTimeout(room.countdownTimer);
    room.countdownTimer = null;
  }
  room.countdownEndsAt = 0;
  if (room.phase === 'countdown') {
    room.phase = 'lobby';
  }
}

function evaluateHumanLobby(room) {
  if (!isHumanOnlyMode(room.mode)) return;

  if (room.phase === 'countdown' && !canStartHumanMatch(room)) {
    cancelHumanCountdown(room);
    broadcastRoomState(room);
    return;
  }

  if (room.phase !== 'lobby' || !canStartHumanMatch(room)) return;

  room.phase = 'countdown';
  room.countdownEndsAt = Date.now() + HUMAN_MATCH_COUNTDOWN_MS;
  room.countdownTimer = setTimeout(() => {
    room.countdownTimer = null;
    void startHumanMatch(room);
  }, HUMAN_MATCH_COUNTDOWN_MS);
  if (typeof room.countdownTimer.unref === 'function') {
    room.countdownTimer.unref();
  }
  broadcastRoomState(room);
}

async function startHumanMatch(room) {
  if (!isHumanOnlyMode(room.mode) || room.phase !== 'countdown') return;
  if (!canStartHumanMatch(room)) {
    cancelHumanCountdown(room);
    broadcastRoomState(room);
    return;
  }

  if (room.matchStartedAt > 0) {
    room.matchSeq += 1;
  }
  room.countdownEndsAt = 0;
  room.matchTimer = 0;
  room.storm = createInitialStorm();
  room.buildables.clear();
  room.collectedLootIds.clear();
  room.spawnedLootItems.clear();
  room.processedHitIds.clear();
  room.hitEventSeq = 0;
  room.lastStormDamageAt = Date.now();
  room.stormDamageInProgress = false;
  room.matchParticipantIds.clear();
  room.placements.clear();
  room.winnerId = null;
  room.winnerName = '';
  room.matchEndedAt = 0;

  const participants = getConnectedAuthenticatedHumans(room).filter(
    (player) => player.isReady
  );
  for (const player of getRoomHumanPlayers(room)) {
    const isParticipant = participants.includes(player);
    player.isParticipant = isParticipant;
    player.alive = isParticipant;
    player.health = 100;
    player.shield = 50;
    player.eliminations = 0;
    if (isParticipant) {
      room.matchParticipantIds.add(player.id);
    }
  }

  room.phase = 'active';
  room.matchStartedAt = Date.now();
  room.lastActivityAt = Date.now();

  // Participation is awarded at the authoritative match start, not when a
  // player merely enters/leaves a lobby.
  await Promise.all(
    participants.map(async (player) => {
      const profile = await applyAuthoritativeProgression(player, {
        eventId: `${room.code}_match_${room.matchSeq}_participation_${player.accountId}`,
        roomCode: room.code,
        eventType: 'match_participation',
        matchesDelta: 1,
        xpDelta: 50,
      });
      sendToPlayer(player, { type: 'server_progression', profile });
    })
  );

  // Personalize match_started with each recipient's opaque public ID and the
  // authoritative participant roster so clients can verify their own seat
  // before transitioning from lobby to gameplay.
  const summary = buildRoomSummary(room);
  const players = buildRoomPlayersSnapshot(room);
  for (const player of getRoomHumanPlayers(room)) {
    if (!player.isConnected) continue;
    sendToPlayer(player, {
      type: 'match_started',
      ...summary,
      selfPlayerId: player.id,
      players,
    });
  }
  broadcastRoomState(room);
}

function finishHumanMatch(room, winner) {
  if (!isHumanOnlyMode(room.mode) || room.phase === 'ended') return;
  cancelHumanCountdown(room);
  room.phase = 'ended';
  room.matchEndedAt = Date.now();
  room.winnerId = winner?.id || null;
  room.winnerName = winner?.name || '';
  if (winner) {
    room.placements.set(winner.id, 1);
  }
  for (const player of getRoomHumanPlayers(room)) {
    player.isReady = false;
  }

  const summary = buildRoomSummary(room);
  const players = buildRoomPlayersSnapshot(room);
  const placements = Object.fromEntries(room.placements.entries());
  for (const player of getRoomHumanPlayers(room)) {
    if (!player.isConnected) continue;
    sendToPlayer(player, {
      type: 'match_ended',
      ...summary,
      selfPlayerId: player.id,
      players,
      placements,
    });
  }
  broadcastRoomState(room);
}

function evaluateHumanVictory(room) {
  if (!isHumanOnlyMode(room.mode) || room.phase !== 'active') return null;
  const participants = getRoomHumanPlayers(room).filter(
    (player) => player.isParticipant
  );
  if (participants.length < room.minPlayers) return null;
  const aliveParticipants = participants.filter((player) => player.alive);
  return aliveParticipants.length === 1 ? aliveParticipants[0] : null;
}

async function awardHumanWinner(room, winner, eventSuffix) {
  if (!winner?.accountId) return;
  const profile = await applyAuthoritativeProgression(winner, {
    eventId: `${room.code}_match_${room.matchSeq}_win_${eventSuffix}_${winner.accountId}`,
    roomCode: room.code,
    eventType: 'human_only_victory',
    winsDelta: 1,
    placement: 1,
    xpDelta: 300,
  });
  sendToPlayer(winner, { type: 'server_progression', profile });
}

async function handleHumanForfeit(room, player, reason = 'left_room') {
  if (!isHumanOnlyMode(room.mode) || room.phase !== 'active') return;
  if (!player?.isParticipant || !player.alive) return;

  const aliveBefore = getRoomHumanPlayers(room).filter(
    (candidate) => candidate.isParticipant && candidate.alive
  ).length;
  player.alive = false;
  const placement = Math.max(2, aliveBefore);
  room.placements.set(player.id, placement);

  if (player.accountId) {
    const profile = await applyAuthoritativeProgression(player, {
      eventId: `${room.code}_match_${room.matchSeq}_forfeit_${reason}_${player.accountId}`,
      roomCode: room.code,
      eventType: 'forfeit',
      placement,
      xpDelta: placement <= 3 ? 150 : placement <= 5 ? 75 : 0,
    });
    sendToPlayer(player, { type: 'server_progression', profile });
  }

  const winner = evaluateHumanVictory(room);
  if (winner) {
    await awardHumanWinner(room, winner, 'forfeit');
    finishHumanMatch(room, winner);
  }
}

async function applyHumanStormDamage(room) {
  if (!isHumanOnlyMode(room.mode) || room.phase !== 'active') return;
  if (room.stormDamageInProgress) return;

  const now = Date.now();
  if (now - room.lastStormDamageAt < 950) return;
  room.lastStormDamageAt = now;
  room.stormDamageInProgress = true;

  try {
    const storm = room.storm;
    const damage = Math.max(
      1,
      Math.min(100, Math.round(Number(storm.damagePerSecond || 2)))
    );
    const candidates = getRoomHumanPlayers(room).filter((player) => {
      if (!player.isParticipant || !player.alive || player.isGliding) {
        return false;
      }
      const distance = Math.hypot(
        Number(player.position?.x || 0) - Number(storm.currentCenterX || 0),
        Number(player.position?.z || 0) - Number(storm.currentCenterZ || 0)
      );
      return distance > Number(storm.currentRadius || 0);
    });

    for (const victim of candidates) {
      if (room.phase !== 'active' || !victim.alive) continue;

      victim.health = Math.max(0, Number(victim.health || 0) - damage);
      const eliminated = victim.health <= 0;
      const eventId = `${room.code}_storm_${++room.hitEventSeq}`;

      if (eliminated) {
        const aliveBefore = getRoomHumanPlayers(room).filter(
          (player) => player.isParticipant && player.alive
        ).length;
        victim.alive = false;
        const placement = Math.max(2, aliveBefore);
        room.placements.set(victim.id, placement);

        if (victim.accountId) {
          const profile = await applyAuthoritativeProgression(victim, {
            eventId: `${eventId}_victim`,
            roomCode: room.code,
            eventType: 'storm_eliminated',
            placement,
            xpDelta: placement <= 3 ? 150 : placement <= 5 ? 75 : 0,
          });
          sendToPlayer(victim, { type: 'server_progression', profile });
        }
      }

      broadcastToRoom(room, {
        type: 'server_hit',
        eventId,
        attackerId: 'storm',
        attackerName: 'The Storm',
        victimId: victim.id,
        victimName: victim.name,
        damage,
        victimHealth: victim.health,
        victimShield: victim.shield,
        isHeadshot: false,
        isShieldHit: false,
        isShieldBreak: false,
        weaponName: 'The Storm',
        hitPoint: victim.position,
        eliminated,
      });

      if (eliminated) {
        const winner = evaluateHumanVictory(room);
        if (winner) {
          await awardHumanWinner(room, winner, 'storm');
          finishHumanMatch(room, winner);
          break;
        }
      }
    }

    if (candidates.length > 0 && room.phase === 'active') {
      broadcastRoomState(room);
    }
  } finally {
    room.stormDamageInProgress = false;
  }
}

function encodeWsFrame(jsonPayload) {
  const payload = Buffer.from(JSON.stringify(jsonPayload), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer) {
  const messages = [];
  let ptr = 0;

  while (ptr + 2 <= buffer.length) {
    const opcode = buffer[ptr] & 0x0f;
    if (opcode === 0x08) {
      messages.push({ close: true });
      break;
    }
    if (opcode === 0x09) {
      messages.push({ ping: true });
    }
    const isMasked = (buffer[ptr + 1] & 0x80) !== 0;
    let payloadLen = buffer[ptr + 1] & 0x7f;
    let offset = ptr + 2;

    if (payloadLen === 126) {
      if (offset + 2 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (offset + 8 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    if (payloadLen > MAX_WS_PAYLOAD_BYTES) {
      messages.push({ oversized: true });
      break;
    }

    let maskKey = null;
    if (isMasked) {
      if (offset + 4 > buffer.length) break;
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (offset + payloadLen > buffer.length) break;
    const data = Buffer.from(buffer.subarray(offset, offset + payloadLen));
    if (isMasked && maskKey) {
      for (let i = 0; i < data.length; i++) {
        data[i] ^= maskKey[i % 4];
      }
    }
    if (opcode === 0x01) {
      messages.push({ text: data.toString('utf8') });
    }
    ptr = offset + payloadLen;
  }

  return messages;
}

function broadcastToRoom(room, payload, excludeSessionToken = null) {
  const frame = encodeWsFrame(payload);
  for (const p of room.players.values()) {
    if (excludeSessionToken && p.sessionToken === excludeSessionToken) continue;
    if (p.isConnected && p.socket && !p.socket.destroyed) {
      p.socket.write(frame);
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_HTTP_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || '/', `http://localhost:${PORT}`);
  const origin = req.headers.origin || '*';
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const clientIp = getClientIp(req);

  // 1. Health & Readiness Probe (`/health` and `/api/health`)
  if (reqUrl.pathname === '/health' || reqUrl.pathname === '/api/health') {
    let activePlayers = 0;
    for (const r of rooms.values()) {
      for (const p of r.players.values()) {
        if (p.isConnected) activePlayers++;
      }
    }
    sendJson(res, 200, {
      status: 'ok',
      version: '3.0.0',
      uptimeSec: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
      rooms: rooms.size,
      activePlayers,
      persistence: db.getStatus(),
    });
    return;
  }

  // 2. Account Initialization / Session Verification (`POST /api/account/init`)
  if (reqUrl.pathname === '/api/account/init' && req.method === 'POST') {
    if (!checkHttpRateLimit(clientIp, 'account_init', 30, 60000)) {
      sendJson(res, 429, { ok: false, error: 'Too many account requests. Please wait.' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const result = await db.createOrVerifyAccount({
        accountId: body.accountId,
        accountToken: body.accountToken,
        callsign: body.callsign,
        cosmetics: body.cosmetics,
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid request',
      });
    }
    return;
  }

  // 3. Cross-Device Passkey Account Recovery (`POST /api/account/restore`)
  if (reqUrl.pathname === '/api/account/restore' && req.method === 'POST') {
    if (!checkHttpRateLimit(clientIp, 'account_restore', 8, 60000)) {
      sendJson(res, 429, {
        ok: false,
        error: 'Too many recovery attempts. Try again in 60 seconds.',
      });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const result = await db.restoreAccountByPasskey(body.passkey);
      sendJson(res, result.ok ? 200 : 401, result);
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid request',
      });
    }
    return;
  }

  // 4. Persistent Cosmetic & Callsign Sync (`POST /api/account/cosmetics`)
  if (reqUrl.pathname === '/api/account/cosmetics' && req.method === 'POST') {
    if (!checkHttpRateLimit(clientIp, 'account_cosmetics', 30, 60000)) {
      sendJson(res, 429, { ok: false, error: 'Rate limit exceeded.' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const { accountId, accountToken, cosmetics, callsign } = body;
      const verified = await db.createOrVerifyAccount({
        accountId,
        accountToken,
        callsign,
      });
      if (verified.isNew || verified.accountId !== accountId) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized account token.' });
        return;
      }
      const profile = await db.updateAccountCosmetics(accountId, cosmetics, callsign);
      sendJson(res, 200, { ok: true, profile });
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid cosmetic payload.' });
    }
    return;
  }

  // 5. Reject Any Unverified Client-Submitted Progression (`POST /api/progression`)
  if (
    (reqUrl.pathname === '/api/progression' ||
      reqUrl.pathname === '/api/account/claim') &&
    req.method === 'POST'
  ) {
    sendJson(res, 403, {
      ok: false,
      error:
        'Server-authoritative progression only; client-submitted wins, XP, damage, and eliminations are rejected.',
    });
    return;
  }

  // 6. Read Persisted Career Progression (`GET /api/progression`)
  if (reqUrl.pathname === '/api/progression' && req.method === 'GET') {
    const accountId = reqUrl.searchParams.get('accountId') || '';
    const token = reqUrl.searchParams.get('sessionToken') || '';
    if (accountId) {
      const row = await db.getAccountRow(accountId);
      if (row) {
        sendJson(res, 200, db.rowToProfile(row));
        return;
      }
    }
    const profile = await resolvePlayerProfile(accountId || null, token, 'Commander_CI');
    sendJson(res, 200, profile);
    return;
  }

  // 7. Create a room with a server-validated mode (`POST /api/room/create`)
  if (reqUrl.pathname === '/api/room/create' && req.method === 'POST') {
    if (!checkHttpRateLimit(clientIp, 'room_create', 15, 60000)) {
      sendJson(res, 429, { ok: false, error: 'Too many room creation requests.' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid room creation payload.' });
      return;
    }
    const modeResolution = resolveRequestedRoomMode(
      body.roomMode ?? body.mode,
      null
    );
    if (!modeResolution.mode) {
      sendJson(res, 400, { ok: false, error: modeResolution.error });
      return;
    }
    const code = generateUniqueRoomCode(modeResolution.mode);
    const room = getOrCreateRoom(code, modeResolution.mode);
    sendJson(res, 200, {
      ok: true,
      exists: true,
      ...buildRoomSummary(room),
    });
    return;
  }

  // 8. Public human-only matchmaking (`POST /api/room/matchmake`)
  if (reqUrl.pathname === '/api/room/matchmake' && req.method === 'POST') {
    if (!checkHttpRateLimit(clientIp, 'room_matchmake', 30, 60000)) {
      sendJson(res, 429, { ok: false, error: 'Too many matchmaking requests.' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid matchmaking payload.' });
      return;
    }
    const requestedMode = normalizeRoomMode(body.roomMode ?? body.mode);
    if (requestedMode && requestedMode !== 'human_only_public') {
      sendJson(res, 400, {
        ok: false,
        error: 'Public matchmaking is available only for human_only_public rooms.',
      });
      return;
    }

    let room = Array.from(rooms.values())
      .filter(
        (candidate) =>
          candidate.mode === 'human_only_public' &&
          candidate.phase === 'lobby' &&
          candidate.players.size < candidate.maxPlayers
      )
      .sort((a, b) => {
        const countsA = getRoomCounts(a);
        const countsB = getRoomCounts(b);
        return (
          countsB.connectedHumans - countsA.connectedHumans ||
          a.createdAt - b.createdAt
        );
      })[0];

    if (!room) {
      room = getOrCreateRoom(
        generateUniqueRoomCode('human_only_public'),
        'human_only_public'
      );
    }

    sendJson(res, 200, {
      ok: true,
      exists: true,
      ...buildRoomSummary(room),
    });
    return;
  }

  // 9. Query room status (`GET /api/room`). This summary intentionally
  // contains public room metadata only: no account/session tokens.
  if (reqUrl.pathname === '/api/room' && req.method === 'GET') {
    const code = sanitizeRoomCode(reqUrl.searchParams.get('code') || 'CICRAFT-1');
    const room = rooms.get(code);
    if (room) {
      sendJson(res, 200, {
        ok: true,
        exists: true,
        ...buildRoomSummary(room),
      });
      return;
    }

    const inferredMode = inferRoomModeForCode(code) || 'online_ai_fill';
    sendJson(res, 200, {
      ok: true,
      exists: false,
      roomCode: code,
      mode: inferredMode,
      roomMode: inferredMode,
      visibility: roomVisibilityForMode(inferredMode),
      phase: isHumanOnlyMode(inferredMode) ? 'lobby' : 'active',
      matchStatus: isHumanOnlyMode(inferredMode) ? 'lobby' : 'active',
      humanOnly: isHumanOnlyMode(inferredMode),
      aiFillEnabled: inferredMode === 'online_ai_fill',
      botCount: 0,
      connectedPlayers: 0,
      connectedHumans: 0,
      authenticatedHumans: 0,
      readyPlayers: 0,
      readyHumans: 0,
      totalPlayers: 0,
      totalHumans: 0,
      aliveHumans: 0,
      maxPlayers: ROOM_MAX_HUMANS,
      minPlayers: isHumanOnlyMode(inferredMode) ? HUMAN_ONLY_MIN_PLAYERS : 1,
      matchParticipantCount: 0,
      countdownEndsAt: 0,
      canStart: false,
      winnerId: null,
      winnerName: '',
      stormPhase: 1,
    });
    return;
  }

  // Serve built static web app from dist/ (and public/)
  const safePath = path
    .normalize(decodeURIComponent(reqUrl.pathname))
    .replace(/^(\.\.(\/|\\|$))+/, '');
  const relPath =
    safePath === '/' || safePath === '\\' ? 'index.html' : safePath.replace(/^[/\\]+/, '');

  const candidatePaths = [
    path.join(DIST_DIR, relPath),
    path.join(PUBLIC_DIR, relPath),
    path.join(DIST_DIR, 'index.html'),
  ];

  for (const filePath of candidatePaths) {
    if (
      (filePath.startsWith(DIST_DIR) || filePath.startsWith(PUBLIC_DIR)) &&
      fs.existsSync(filePath) &&
      fs.statSync(filePath).isFile()
    ) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const cacheControl =
        ext === '.html' ? 'no-cache' : 'public, max-age=86400';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('CI Craft 3D Authoritative Multiplayer Server is running.');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  if (ALLOWED_ORIGINS.length > 0 && req.headers.origin) {
    if (!ALLOWED_ORIGINS.includes(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n',
    ].join('\r\n')
  );

  let currentRoom = null;
  let currentSessionToken = null;

  // Per-connection token bucket rate limiter
  let rateTokens = 90;
  let lastRateRefill = Date.now();
  let rateViolations = 0;

  socket.on('data', async (chunk) => {
    if (chunk.length > MAX_WS_PAYLOAD_BYTES * 2) {
      socket.destroy();
      return;
    }

    const nowMs = Date.now();
    const elapsedSec = Math.max(0, (nowMs - lastRateRefill) / 1000);
    lastRateRefill = nowMs;
    rateTokens = Math.min(90, rateTokens + elapsedSec * 70);

    const frames = decodeWsFrames(chunk);
    for (const decoded of frames) {
      if (decoded.close || decoded.oversized) {
        socket.end();
        return;
      }
      if (decoded.ping) {
        // Send WebSocket Pong frame (0x8A, length 0)
        if (!socket.destroyed) socket.write(Buffer.from([0x8a, 0x00]));
        continue;
      }
      if (!decoded.text) continue;

      if (rateTokens < 1) {
        rateViolations++;
        if (rateViolations > 150) {
          socket.destroy();
          return;
        }
        continue;
      }
      rateTokens -= 1;

      try {
        const msg = JSON.parse(decoded.text);
        if (!msg || typeof msg !== 'object') continue;

        if (msg.type === 'submit_progression' || msg.type === 'claim_xp') {
          // Never trust client-submitted wins, XP, damage, or eliminations
          socket.write(
            encodeWsFrame({
              type: 'progression_rejected',
              reason:
                'Server-authoritative progression only; client-submitted wins, XP, and eliminations are rejected.',
            })
          );
          continue;
        }

        if (msg.type === 'ping') {
          socket.write(encodeWsFrame({ type: 'pong', serverTime: Date.now() }));
          continue;
        }

        if (msg.type === 'join_room') {
          const roomCode = sanitizeRoomCode(msg.roomCode);
          const requestedSessionToken = String(
            msg.sessionToken || `sess_${crypto.randomBytes(6).toString('hex')}`
          ).slice(0, 48);
          const rejectJoin = (code, reason) => {
            socket.write(
              encodeWsFrame({
                type: 'join_rejected',
                ok: false,
                code,
                reason,
                roomCode,
              })
            );
          };

          const modeResolution = resolveRequestedRoomMode(
            msg.roomMode ?? msg.mode,
            roomCode
          );
          if (!modeResolution.mode) {
            rejectJoin('invalid_room_mode', modeResolution.error);
            continue;
          }

          let room = rooms.get(roomCode);
          if (room && room.mode !== modeResolution.mode) {
            rejectJoin(
              'room_mode_mismatch',
              `Room ${roomCode} is a ${room.mode} room and cannot accept ${modeResolution.mode} sessions.`
            );
            continue;
          }
          if (!room) {
            room = getOrCreateRoom(roomCode, modeResolution.mode);
          }

          const humanOnlyRoom = isHumanOnlyMode(room.mode);

          // Verify an existing persistent account without auto-provisioning a
          // replacement. Human-only rooms require this verification; legacy
          // online rooms retain their existing guest-session behavior.
          let verifiedProfile = null;
          let verifiedAccountId = null;
          if (msg.accountId && msg.accountToken) {
            try {
              verifiedProfile = await db.verifyAccountCredentials({
                accountId: String(msg.accountId),
                accountToken: String(msg.accountToken),
                callsign: msg.playerName,
              });
              verifiedAccountId = verifiedProfile?.accountId || null;
            } catch {
              verifiedProfile = null;
              verifiedAccountId = null;
            }
          }

          if (humanOnlyRoom && !verifiedAccountId) {
            rejectJoin(
              'authentication_required',
              'Human-only rooms require a verified CI Craft account session.'
            );
            continue;
          }

          let player = room.players.get(requestedSessionToken) || null;
          let existingByAccount = null;
          if (verifiedAccountId) {
            for (const candidate of room.players.values()) {
              if (candidate.accountId === verifiedAccountId) {
                existingByAccount = candidate;
                break;
              }
            }
          }

          if (
            player &&
            verifiedAccountId &&
            player.accountId &&
            player.accountId !== verifiedAccountId
          ) {
            rejectJoin(
              'session_in_use',
              'This session token is already bound to a different account in the room.'
            );
            continue;
          }

          // A reconnect with the same verified account but a new browser
          // session transfers the existing seat instead of deleting it or
          // creating a duplicate. Combat/identity state is preserved.
          if (existingByAccount && existingByAccount !== player) {
            if (player) {
              rejectJoin(
                'session_in_use',
                'This session token is already in use by another room session.'
              );
              continue;
            }
            if (
              existingByAccount.socket &&
              existingByAccount.socket !== socket &&
              !existingByAccount.socket.destroyed
            ) {
              try {
                existingByAccount.socket.end();
              } catch {
                // Ignore
              }
            }
            room.players.delete(existingByAccount.sessionToken);
            existingByAccount.sessionToken = requestedSessionToken;
            room.players.set(requestedSessionToken, existingByAccount);
            player = existingByAccount;
          }

          const isExistingPlayer = Boolean(player);
          const wasConnected = Boolean(player?.isConnected);
          if (!isExistingPlayer) {
            if (room.players.size >= room.maxPlayers) {
              rejectJoin('room_full', `Room ${roomCode} is full.`);
              continue;
            }
            if (humanOnlyRoom && room.phase !== 'lobby') {
              rejectJoin(
                'match_in_progress',
                'This human-only match has already started. Wait for the next lobby or find another room.'
              );
              continue;
            }
          }

          currentRoom = room;
          currentSessionToken = requestedSessionToken;

          const cleanCallsign = sanitizeCallsign(msg.playerName);
          let isFreshJoinOrReset = false;

          if (!player) {
            isFreshJoinOrReset = true;
            player = {
              // Public IDs are opaque and unrelated to the private session
              // token. Session/account tokens are never broadcast.
              id: generatePublicPlayerId(room),
              sessionToken: currentSessionToken,
              accountId: verifiedAccountId,
              isAuthenticated: Boolean(verifiedAccountId),
              participantType: 'human',
              isBot: false,
              isReady: !humanOnlyRoom,
              isParticipant: !humanOnlyRoom,
              name: cleanCallsign,
              position: sanitizePosition(msg.position, { x: 0, y: 10, z: 0 }),
              velocity: { x: 0, y: 0, z: 0 },
              yaw: 0,
              facingYaw: 0,
              pitch: 0,
              health: 100,
              shield: 50,
              eliminations: 0,
              alive: true,
              isConnected: true,
              disconnectedAt: 0,
              joinedAt: Date.now(),
              isAiming: false,
              isSprinting: false,
              isGrounded: !msg.isGliding,
              isGliding: Boolean(msg.isGliding),
              isReloading: false,
              equippedCategory: 'assault_rifle',
              equippedRarity: 'uncommon',
              skinColor: Number(msg.skinColor ?? 0x0284c7),
              accentColor: Number(msg.accentColor ?? 0x38bdf8),
              backAccessory: String(msg.backAccessory || 'jump_pack'),
              socket,
            };
            room.players.set(currentSessionToken, player);
          } else {
            if (player.socket && player.socket !== socket && !player.socket.destroyed) {
              try {
                player.socket.end();
              } catch {
                // Ignore
              }
            }
            player.isConnected = true;
            player.disconnectedAt = 0;
            player.accountId = verifiedAccountId || player.accountId;
            player.isAuthenticated = Boolean(player.accountId && verifiedAccountId);
            player.participantType = 'human';
            player.isBot = false;
            player.name = cleanCallsign;
            if (humanOnlyRoom && !wasConnected) {
              // A reconnect must explicitly ready-up again before a lobby or
              // countdown can start. The existing seat is not duplicated.
              player.isReady = false;
            }
            if (msg.skinColor !== undefined) player.skinColor = Number(msg.skinColor);
            if (msg.accentColor !== undefined) player.accentColor = Number(msg.accentColor);
            if (msg.backAccessory) player.backAccessory = String(msg.backAccessory);
            if (msg.resetPlayer && !humanOnlyRoom) {
              isFreshJoinOrReset = true;
              room.matchSeq += 1;
              player.health = 100;
              player.shield = 50;
              player.alive = true;
              player.eliminations = 0;
              player.position = sanitizePosition(msg.position, player.position);
            } else if (msg.resetPlayer && humanOnlyRoom && room.phase === 'lobby') {
              player.health = 100;
              player.shield = 50;
              player.alive = true;
              player.eliminations = 0;
              player.isParticipant = false;
              player.position = sanitizePosition(msg.position, player.position);
            }
            // In an active human-only match, resetPlayer is intentionally
            // ignored: a client cannot revive/reset itself by reconnecting.
            player.socket = socket;
          }

          let profile;
          if (humanOnlyRoom) {
            profile = verifiedProfile;
          } else if (isFreshJoinOrReset) {
            profile = await applyAuthoritativeProgression(player, {
              eventId: `${room.code}_join_${player.accountId || currentSessionToken}_${room.matchSeq}`,
              roomCode: room.code,
              eventType: 'match_participation',
              matchesDelta: 1,
              xpDelta: 50,
            });
          } else {
            profile = await resolvePlayerProfile(
              player.accountId,
              currentSessionToken,
              player.name
            );
          }

          socket.write(
            encodeWsFrame({
              type: 'room_joined',
              ok: true,
              selfPlayerId: player.id,
              ...buildRoomSummary(room),
            })
          );

          // Send authoritative progression snapshot to the client
          socket.write(
            encodeWsFrame({
              type: 'server_progression',
              profile,
            })
          );

          // Send existing room buildables to the joining/reconnecting client
          for (const b of room.buildables.values()) {
            socket.write(encodeWsFrame({ type: 'build_placed', ...b }));
          }

          // Send authoritative room loot state (opened chests, collected items, dynamically spawned drops)
          if (room.collectedLootIds.size > 0 || room.spawnedLootItems.size > 0) {
            socket.write(
              encodeWsFrame({
                type: 'room_loot_sync',
                collectedIds: Array.from(room.collectedLootIds),
                spawnedItems: Array.from(room.spawnedLootItems.values()),
              })
            );
          }

          evaluateHumanLobby(room);
          broadcastRoomState(room);
        } else if (msg.type === 'set_ready' && currentRoom && currentSessionToken) {
          const player = currentRoom.players.get(currentSessionToken);
          if (!player) continue;
          if (!isHumanOnlyMode(currentRoom.mode)) {
            socket.write(
              encodeWsFrame({
                type: 'ready_rejected',
                reason: 'Ready state is only used by human-only lobbies.',
              })
            );
            continue;
          }
          if (
            currentRoom.phase !== 'lobby' &&
            currentRoom.phase !== 'countdown'
          ) {
            socket.write(
              encodeWsFrame({
                type: 'ready_rejected',
                reason: 'Ready state cannot be changed after the match starts.',
              })
            );
            continue;
          }
          if (!player.isConnected || !player.isAuthenticated || !player.accountId) {
            socket.write(
              encodeWsFrame({
                type: 'ready_rejected',
                reason: 'Only authenticated connected humans can ready up.',
              })
            );
            continue;
          }

          // Only this socket's own boolean is accepted. Connected/ready
          // totals are always recomputed from server-owned room entries.
          player.isReady = Boolean(msg.ready);
          currentRoom.lastActivityAt = Date.now();
          evaluateHumanLobby(currentRoom);
          broadcastRoomState(currentRoom);
        } else if (
          msg.type === 'request_match_start' &&
          currentRoom &&
          currentSessionToken
        ) {
          if (!isHumanOnlyMode(currentRoom.mode)) {
            socket.write(
              encodeWsFrame({
                type: 'match_start_rejected',
                reason: 'This room does not use human-only matchmaking.',
              })
            );
            continue;
          }
          if (canStartHumanMatch(currentRoom)) {
            evaluateHumanLobby(currentRoom);
          } else {
            const counts = getRoomCounts(currentRoom);
            socket.write(
              encodeWsFrame({
                type: 'match_start_rejected',
                reason: `Waiting for at least ${currentRoom.minPlayers} connected authenticated humans, with every connected human ready. Currently ${counts.readyHumans}/${counts.authenticatedHumans} ready.`,
                ...buildRoomSummary(currentRoom),
              })
            );
          }
        } else if (
          msg.type === 'spawn_bot' ||
          msg.type === 'join_bot' ||
          msg.type === 'add_ai'
        ) {
          // There is deliberately no server endpoint or message that can add
          // a bot participant. Reject explicitly rather than silently
          // treating a claimed bot as a human.
          socket.write(
            encodeWsFrame({
              type: 'bot_rejected',
              reason: 'Bots cannot be injected into server rooms.',
              ...(currentRoom ? buildRoomSummary(currentRoom) : {}),
            })
          );
        } else if (msg.type === 'leave_room' && currentRoom && currentSessionToken) {
          const room = currentRoom;
          const player = room.players.get(currentSessionToken);
          if (player) {
            player.isReady = false;
            player.isConnected = false;
            player.disconnectedAt = Date.now();

            if (isHumanOnlyMode(room.mode) && room.phase === 'active') {
              await handleHumanForfeit(room, player, 'left_room');
            }

            // Explicit leave releases the seat entirely. A temporary socket
            // disconnect also releases a pre-start human-only lobby seat;
            // active participants retain theirs until reconnect timeout.
            room.players.delete(currentSessionToken);
            broadcastToRoom(room, {
              type: 'player_left',
              playerId: player.id,
              playerName: player.name,
              ...buildRoomSummary(room),
            });
            evaluateHumanLobby(room);
            broadcastRoomState(room);
          }
          currentRoom = null;
          currentSessionToken = null;
        } else if (msg.type === 'player_sync' && currentRoom && currentSessionToken) {
          currentRoom.lastActivityAt = Date.now();
          const p = currentRoom.players.get(currentSessionToken);
          if (
            p &&
            isHumanOnlyMode(currentRoom.mode) &&
            (currentRoom.phase !== 'active' || !p.isParticipant)
          ) {
            continue;
          }
          if (p) {
            p.position = sanitizePosition(msg.position, p.position);
            p.velocity = sanitizeVelocity(msg.velocity, p.velocity);
            p.yaw = clampFinite(msg.yaw, -Math.PI * 4, Math.PI * 4, p.yaw);
            p.facingYaw = clampFinite(
              msg.facingYaw,
              -Math.PI * 4,
              Math.PI * 4,
              p.facingYaw
            );
            p.pitch = clampFinite(msg.pitch, -1.6, 1.6, p.pitch);
            p.isAiming = Boolean(msg.isAiming);
            p.isSprinting = Boolean(msg.isSprinting);
            p.isGrounded = Boolean(msg.isGrounded ?? p.isGrounded);
            p.isGliding = Boolean(msg.isGliding);
            p.isReloading = Boolean(msg.isReloading);
            p.reloadTimer = clampFinite(msg.reloadTimer, 0, 10, 0);
            p.reloadDuration = clampFinite(msg.reloadDuration, 0, 10, 0);
            if (msg.equippedCategory) {
              p.equippedCategory = String(msg.equippedCategory).slice(0, 24);
            }
            if (msg.equippedRarity) {
              p.equippedRarity = String(msg.equippedRarity).slice(0, 16);
            }
          }
        } else if (msg.type === 'heal_sync' && currentRoom && currentSessionToken) {
          const p = currentRoom.players.get(currentSessionToken);
          if (
            p &&
            isHumanOnlyMode(currentRoom.mode) &&
            (currentRoom.phase !== 'active' || !p.isParticipant)
          ) {
            continue;
          }
          if (p && p.alive) {
            p.health = clampFinite(msg.health, 0, 100, p.health);
            p.shield = clampFinite(msg.shield, 0, 100, p.shield);
          }
        } else if (msg.type === 'fire_weapon' && currentRoom && currentSessionToken) {
          const shooter = currentRoom.players.get(currentSessionToken);
          if (!shooter || !shooter.alive) continue;
          if (
            isHumanOnlyMode(currentRoom.mode) &&
            (currentRoom.phase !== 'active' || !shooter.isParticipant)
          ) {
            continue;
          }
          currentRoom.lastActivityAt = Date.now();
          broadcastToRoom(
            currentRoom,
            {
              type: 'remote_weapon_fired',
              shooterId: shooter.id,
              category: String(msg.category || 'assault_rifle').slice(0, 24),
              muzzlePos: sanitizePosition(msg.muzzlePos, { x: 0, y: 1, z: 0 }),
              hitPoint: sanitizePosition(msg.hitPoint, { x: 0, y: 1, z: -10 }),
            },
            currentSessionToken
          );
        } else if (msg.type === 'combat_hit' && currentRoom && currentSessionToken) {
          currentRoom.lastActivityAt = Date.now();
          const attacker = currentRoom.players.get(currentSessionToken);
          if (!attacker || !attacker.alive) continue;
          if (
            isHumanOnlyMode(currentRoom.mode) &&
            (currentRoom.phase !== 'active' || !attacker.isParticipant)
          ) {
            continue;
          }

          // Authoritative hitId deduplication to prevent duplicate damage events
          if (msg.hitId) {
            const hitKey = `${currentSessionToken}_${String(msg.hitId).slice(0, 48)}`;
            if (currentRoom.processedHitIds.has(hitKey)) continue;
            currentRoom.processedHitIds.add(hitKey);
            if (currentRoom.processedHitIds.size > 512) {
              const firstKey = currentRoom.processedHitIds.values().next().value;
              if (firstKey) currentRoom.processedHitIds.delete(firstKey);
            }
          }

          // Find target player in room
          const targetId = String(msg.targetId || '');
          let victim = null;
          for (const candidate of currentRoom.players.values()) {
            if (candidate.id === targetId) {
              victim = candidate;
              break;
            }
          }
          if (!victim || !victim.alive) continue;
          if (isHumanOnlyMode(currentRoom.mode) && !victim.isParticipant) continue;

          // Server-authoritative distance sanity check (max sniper range = 360m)
          const dist = Math.hypot(
            (victim.position?.x || 0) - (attacker.position?.x || 0),
            (victim.position?.z || 0) - (attacker.position?.z || 0)
          );
          if (dist > 360) continue;

          const rawDamage = Math.max(1, Math.min(240, Math.round(Number(msg.damage || 20))));
          const isHeadshot = Boolean(msg.isHeadshot);
          const isShieldHit = victim.shield > 0;

          let rem = rawDamage;
          if (victim.shield > 0) {
            const absorbed = Math.min(victim.shield, rem);
            victim.shield -= absorbed;
            rem -= absorbed;
          }
          if (rem > 0) {
            victim.health = Math.max(0, victim.health - rem);
          }
          const isShieldBreak = isShieldHit && victim.shield <= 0;

          const eventId = `${currentRoom.code}_hit_${++currentRoom.hitEventSeq}`;

          let eliminated = false;
          let winsDelta = 0;
          let attackerPlacement = 0;
          let matchWinner = null;

          if (victim.health <= 0 && victim.alive) {
            victim.alive = false;
            eliminated = true;
            attacker.eliminations = (attacker.eliminations || 0) + 1;

            const alivePlayers = getRoomHumanPlayers(currentRoom).filter(
              (p) =>
                p.alive &&
                (!isHumanOnlyMode(currentRoom.mode) || p.isParticipant)
            );
            const victimPlacement = Math.max(2, alivePlayers.length + 1);
            currentRoom.placements.set(victim.id, victimPlacement);

            const victimProfile = await applyAuthoritativeProgression(victim, {
              eventId: `${eventId}_victim`,
              roomCode: currentRoom.code,
              eventType: 'eliminated',
              placement: victimPlacement,
              xpDelta: victimPlacement <= 3 ? 150 : victimPlacement <= 5 ? 75 : 0,
            });

            if (victim.socket && !victim.socket.destroyed) {
              victim.socket.write(
                encodeWsFrame({
                  type: 'server_progression',
                  profile: victimProfile,
                })
              );
            }

            if (isHumanOnlyMode(currentRoom.mode)) {
              // Human-only victory is evaluated only from authenticated
              // human match participants. No bot participant can exist in
              // this room, and local AI settings have no effect here.
              matchWinner = evaluateHumanVictory(currentRoom);
              if (matchWinner?.id === attacker.id) {
                winsDelta = 1;
                attackerPlacement = 1;
              }
            } else if (
              alivePlayers.length === 1 &&
              alivePlayers[0].id === attacker.id
            ) {
              winsDelta = 1;
              attackerPlacement = 1;
            }
          }

          const attackerXpDelta =
            Math.floor(rawDamage / 5) +
            (eliminated ? 100 : 0) +
            (winsDelta > 0 ? 300 : 0);

          const attackerProfile = await applyAuthoritativeProgression(attacker, {
            eventId: `${eventId}_attacker`,
            roomCode: currentRoom.code,
            eventType: eliminated ? 'elimination' : 'combat_damage',
            winsDelta,
            eliminationsDelta: eliminated ? 1 : 0,
            damageDelta: rawDamage,
            placement: attackerPlacement,
            xpDelta: attackerXpDelta,
          });

          if (attacker.socket && !attacker.socket.destroyed) {
            attacker.socket.write(
              encodeWsFrame({
                type: 'server_progression',
                profile: attackerProfile,
              })
            );
          }

          broadcastToRoom(currentRoom, {
            type: 'server_hit',
            eventId,
            attackerId: attacker.id,
            attackerName: attacker.name,
            victimId: victim.id,
            victimName: victim.name,
            damage: rawDamage,
            victimHealth: victim.health,
            victimShield: victim.shield,
            isHeadshot,
            isShieldHit,
            isShieldBreak,
            weaponName: String(msg.weaponName || 'Weapon').slice(0, 32),
            hitPoint: sanitizePosition(msg.hitPoint, victim.position),
            eliminated,
          });

          if (matchWinner) {
            finishHumanMatch(currentRoom, matchWinner);
          }
        } else if (msg.type === 'collect_loot' && currentRoom && currentSessionToken) {
          currentRoom.lastActivityAt = Date.now();
          const collector = currentRoom.players.get(currentSessionToken);
          if (!collector || !collector.alive) continue;
          if (
            isHumanOnlyMode(currentRoom.mode) &&
            (currentRoom.phase !== 'active' || !collector.isParticipant)
          ) {
            socket.write(
              encodeWsFrame({
                type: 'loot_collect_rejected',
                lootId: String(msg.lootId || '').slice(0, 64),
                reason: 'The human-only match has not started.',
              })
            );
            continue;
          }

          const lootId = String(msg.lootId || '').slice(0, 64);
          if (!lootId) continue;

          // Authoritative double-collection prevention
          if (currentRoom.collectedLootIds.has(lootId)) {
            socket.write(
              encodeWsFrame({
                type: 'loot_collect_rejected',
                lootId,
                reason: 'Item already collected by another player.',
              })
            );
            continue;
          }

          // Range sanity check against collector's authoritative position
          if (msg.position && collector.position) {
            const dx = Number(msg.position.x || 0) - Number(collector.position.x || 0);
            const dz = Number(msg.position.z || 0) - Number(collector.position.z || 0);
            if (Math.hypot(dx, dz) > 14.0) {
              socket.write(
                encodeWsFrame({
                  type: 'loot_collect_rejected',
                  lootId,
                  reason: 'Out of interaction range.',
                })
              );
              continue;
            }
          }

          currentRoom.collectedLootIds.add(lootId);
          currentRoom.spawnedLootItems.delete(lootId);

          const itemType = String(msg.itemType || 'weapon').slice(0, 24);
          const spawnedDrops = Array.isArray(msg.spawnedDrops)
            ? msg.spawnedDrops.slice(0, 6)
            : undefined;
          const swappedDrop =
            msg.swappedDrop && typeof msg.swappedDrop === 'object'
              ? msg.swappedDrop
              : undefined;

          if (spawnedDrops) {
            for (const drop of spawnedDrops) {
              if (drop && drop.id && !currentRoom.collectedLootIds.has(String(drop.id))) {
                currentRoom.spawnedLootItems.set(String(drop.id), drop);
              }
            }
          }
          if (
            swappedDrop &&
            swappedDrop.id &&
            !currentRoom.collectedLootIds.has(String(swappedDrop.id))
          ) {
            currentRoom.spawnedLootItems.set(String(swappedDrop.id), swappedDrop);
          }

          broadcastToRoom(currentRoom, {
            type: 'loot_collected',
            collectorId: collector.id,
            lootId,
            itemType,
            spawnedDrops,
            swappedDrop,
          });
        } else if (msg.type === 'place_build' && currentRoom && currentSessionToken) {
          const builder = currentRoom.players.get(currentSessionToken);
          if (!builder || !builder.alive) continue;
          if (
            isHumanOnlyMode(currentRoom.mode) &&
            (currentRoom.phase !== 'active' || !builder.isParticipant)
          ) {
            continue;
          }
          currentRoom.lastActivityAt = Date.now();
          const mat = String(msg.material || 'wood');
          const safeMat = mat === 'stone' || mat === 'metal' ? mat : 'wood';
          const maxHp = safeMat === 'wood' ? 150 : safeMat === 'stone' ? 220 : 300;
          const buildPacket = {
            type: 'build_placed',
            buildId: String(msg.buildId || `build_${Date.now()}`).slice(0, 64),
            ownerId: builder.id,
            pieceType: String(msg.pieceType || 'wall').slice(0, 16),
            x: clampFinite(msg.x, -450, 450, 0),
            y: clampFinite(msg.y, -20, 250, 0),
            z: clampFinite(msg.z, -450, 450, 0),
            yaw: clampFinite(msg.yaw, -Math.PI * 4, Math.PI * 4, 0),
            material: safeMat,
            health: maxHp,
          };
          if (currentRoom.buildables.size < 600) {
            currentRoom.buildables.set(buildPacket.buildId, buildPacket);
          }
          broadcastToRoom(currentRoom, buildPacket, currentSessionToken);
        } else if (msg.type === 'damage_build' && currentRoom && currentSessionToken) {
          const damager = currentRoom.players.get(currentSessionToken);
          if (!damager || !damager.alive) continue;
          if (
            isHumanOnlyMode(currentRoom.mode) &&
            (currentRoom.phase !== 'active' || !damager.isParticipant)
          ) {
            continue;
          }
          currentRoom.lastActivityAt = Date.now();
          const buildId = String(msg.destructibleId || '').slice(0, 64);
          const dmg = clampFinite(msg.damage, 1, 250, 25);
          const existingBuild = currentRoom.buildables.get(buildId);
          if (existingBuild) {
            existingBuild.health -= dmg;
            if (existingBuild.health <= 0) {
              currentRoom.buildables.delete(buildId);
            }
          }
          broadcastToRoom(
            currentRoom,
            {
              type: 'build_damaged',
              destructibleId: buildId,
              damage: dmg,
            },
            currentSessionToken
          );
        }
      } catch {
        // Ignore malformed JSON
      }
    }
  });

  socket.on('close', () => {
    if (currentRoom && currentSessionToken) {
      const p = currentRoom.players.get(currentSessionToken);
      let removedLobbyPlayer = null;
      if (p && p.socket === socket) {
        p.isConnected = false;
        p.disconnectedAt = Date.now();
        if (
          isHumanOnlyMode(currentRoom.mode) &&
          (currentRoom.phase === 'lobby' || currentRoom.phase === 'countdown')
        ) {
          // A pre-start disconnect removes the human from the lobby entirely.
          // If the same authenticated account reconnects, it receives one
          // fresh, unready seat rather than a duplicate roster entry.
          p.isReady = false;
          currentRoom.players.delete(currentSessionToken);
          removedLobbyPlayer = p;
        }
      }
      if (removedLobbyPlayer) {
        broadcastToRoom(currentRoom, {
          type: 'player_left',
          playerId: removedLobbyPlayer.id,
          playerName: removedLobbyPlayer.name,
          ...buildRoomSummary(currentRoom),
        });
      }
      evaluateHumanLobby(currentRoom);
      broadcastRoomState(currentRoom);
    }
  });

  socket.on('error', () => {});
});

function clampFinite(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizePosition(raw, fallback) {
  if (!raw || typeof raw !== 'object') return fallback;
  return {
    x: clampFinite(raw.x, -480, 480, fallback.x || 0),
    y: clampFinite(raw.y, -30, 320, fallback.y || 6),
    z: clampFinite(raw.z, -480, 480, fallback.z || 0),
  };
}

function sanitizeVelocity(raw, fallback) {
  if (!raw || typeof raw !== 'object') return fallback;
  return {
    x: clampFinite(raw.x, -60, 60, fallback.x || 0),
    y: clampFinite(raw.y, -60, 60, fallback.y || 0),
    z: clampFinite(raw.z, -60, 60, fallback.z || 0),
  };
}

function updateRoomStorm(room, dt) {
  room.matchTimer += dt;
  const storm = room.storm;
  storm.phaseTimer -= dt;

  if (storm.phaseTimer <= 0) {
    if (!storm.isShrinking) {
      storm.isShrinking = true;
      storm.phaseTimer = Math.max(18, 34 - storm.phase * 4);
    } else {
      storm.isShrinking = false;
      storm.currentCenterX = storm.targetCenterX;
      storm.currentCenterZ = storm.targetCenterZ;
      storm.currentRadius = storm.targetRadius;
      storm.phase++;
      storm.damagePerSecond = Math.min(12, storm.phase * 2);
      storm.phaseTimer = Math.max(16, 32 - storm.phase * 4);

      const nextRadius = Math.max(12, storm.currentRadius * 0.56);
      const shiftRange = (storm.currentRadius - nextRadius) * 0.5;
      const angle = (storm.phase * 2.1) % (Math.PI * 2);
      storm.targetCenterX = storm.currentCenterX + Math.cos(angle) * shiftRange;
      storm.targetCenterZ = storm.currentCenterZ + Math.sin(angle) * shiftRange;
      storm.targetRadius = nextRadius;
    }
  }

  if (storm.isShrinking) {
    const shrinkSpeed = dt * 0.045;
    storm.currentCenterX += (storm.targetCenterX - storm.currentCenterX) * shrinkSpeed;
    storm.currentCenterZ += (storm.targetCenterZ - storm.currentCenterZ) * shrinkSpeed;
    storm.currentRadius += (storm.targetRadius - storm.currentRadius) * shrinkSpeed;
  }
}

function q2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function q3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function buildRoomPlayersSnapshot(room) {
  return getRoomHumanPlayers(room).map((p) => {
    const pos = p.position || { x: 0, y: 6, z: 0 };
    const vel = p.velocity || { x: 0, y: 0, z: 0 };
    return {
      id: p.id,
      name: p.name,
      participantType: 'human',
      isBot: false,
      isAuthenticated: Boolean(p.isAuthenticated && p.accountId),
      isReady: Boolean(p.isReady),
      isParticipant: Boolean(p.isParticipant),
      position: { x: q2(pos.x), y: q2(pos.y), z: q2(pos.z) },
      velocity: { x: q2(vel.x), y: q2(vel.y), z: q2(vel.z) },
      yaw: q3(p.yaw),
      facingYaw: q3(p.facingYaw),
      pitch: q3(p.pitch),
      health: p.health,
      shield: p.shield,
      eliminations: p.eliminations,
      alive: p.alive,
      isConnected: p.isConnected,
      isAiming: p.isAiming,
      isSprinting: p.isSprinting,
      isGrounded: p.isGrounded,
      isGliding: p.isGliding,
      isReloading: p.isReloading,
      reloadTimer: q2(p.reloadTimer || 0),
      reloadDuration: q2(p.reloadDuration || 0),
      equippedCategory: p.equippedCategory,
      equippedRarity: p.equippedRarity,
      skinColor: p.skinColor ?? 0x0284c7,
      accentColor: p.accentColor ?? 0x38bdf8,
      backAccessory: p.backAccessory || 'jump_pack',
    };
  });
}

function broadcastRoomState(room) {
  const playersSnapshot = buildRoomPlayersSnapshot(room);

  const s = room.storm;
  const summary = buildRoomSummary(room);
  // Personalized only by the recipient's opaque public player ID. Neither
  // account tokens nor private session tokens are included in snapshots.
  for (const recipient of getRoomHumanPlayers(room)) {
    if (!recipient.isConnected) continue;
    sendToPlayer(recipient, {
      type: 'room_state',
      ...summary,
      selfPlayerId: recipient.id,
      matchTimer: q2(room.matchTimer),
      storm: {
        phase: s.phase,
        currentCenterX: q2(s.currentCenterX),
        currentCenterZ: q2(s.currentCenterZ),
        currentRadius: q2(s.currentRadius),
        targetCenterX: q2(s.targetCenterX),
        targetCenterZ: q2(s.targetCenterZ),
        targetRadius: q2(s.targetRadius),
        phaseTimer: q2(s.phaseTimer),
        isShrinking: s.isShrinking,
        damagePerSecond: s.damagePerSecond,
      },
      players: playersSnapshot,
    });
  }
}

// 20Hz authoritative room state tick. Human-only storm/match timers advance
// only after the server has started the match; lobby snapshots still flow so
// every client sees authoritative connected/ready counts.
const roomTickInterval = setInterval(() => {
  for (const room of rooms.values()) {
    let hasConnected = false;
    for (const p of room.players.values()) {
      if (p.isConnected) {
        hasConnected = true;
        break;
      }
    }
    if (hasConnected) {
      if (room.phase === 'active') {
        updateRoomStorm(room, 0.05);
        if (isHumanOnlyMode(room.mode)) {
          void applyHumanStormDamage(room).catch(() => {
            // Progression/database failures must not stop the room tick.
          });
        }
      }
      broadcastRoomState(room);
    }
  }
}, 50);

// Periodic cleanup of abandoned rooms, disconnected players, and expired HTTP rate limit buckets
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of httpRateLimits.entries()) {
    if (now > entry.resetAt) httpRateLimits.delete(key);
  }

  for (const [code, room] of rooms.entries()) {
    let connectedCount = 0;
    let removedPlayer = false;
    for (const [tok, p] of room.players.entries()) {
      if (p.isConnected) {
        connectedCount++;
      } else if (p.disconnectedAt > 0 && now - p.disconnectedAt > 120_000) {
        if (
          isHumanOnlyMode(room.mode) &&
          room.phase === 'active' &&
          p.isParticipant &&
          p.alive
        ) {
          void handleHumanForfeit(room, p, 'reconnect_timeout');
        }
        room.players.delete(tok);
        removedPlayer = true;
      }
    }
    if (removedPlayer) {
      evaluateHumanLobby(room);
      if (connectedCount > 0) broadcastRoomState(room);
    }
    if (connectedCount === 0 && now - room.lastActivityAt > 180_000) {
      cancelHumanCountdown(room);
      rooms.delete(code);
    }
  }
}, 30_000);

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[CI Craft Multiplayer] Received ${signal}, shutting down gracefully...`);
  clearInterval(roomTickInterval);
  clearInterval(cleanupInterval);

  for (const room of rooms.values()) {
    cancelHumanCountdown(room);
    broadcastToRoom(room, {
      type: 'server_restarting',
      retryMs: 2000,
    });
    for (const p of room.players.values()) {
      if (p.socket && !p.socket.destroyed) {
        try {
          p.socket.end();
        } catch {
          // Ignore
        }
      }
    }
  }

  server.close(async () => {
    await db.close();
    console.log('[CI Craft Multiplayer] Shutdown complete.');
    process.exit(0);
  });

  setTimeout(async () => {
    await db.close();
    process.exit(0);
  }, 4000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.on('error', (err) => {
  console.error(`[CI Craft Multiplayer] Fatal server error on ${HOST}:${PORT}:`, err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(
    `[CI Craft Multiplayer] Authoritative Room Server listening on ${HOST}:${PORT} (DB: ${db.backend})`
  );
});
