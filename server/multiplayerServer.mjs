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

function generateUniqueRoomCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let attempt = 0; attempt < 20; attempt++) {
    let suffix = '';
    const bytes = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) {
      suffix += chars[bytes[i] % chars.length];
    }
    const candidate = `CI-${suffix}`;
    if (!rooms.has(candidate)) return candidate;
  }
  return `CI-${Date.now().toString(36).slice(-4).toUpperCase()}`;
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

function getOrCreateRoom(code) {
  const normalized = sanitizeRoomCode(code);
  if (!rooms.has(normalized)) {
    rooms.set(normalized, {
      code: normalized,
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
    });
  }
  const room = rooms.get(normalized);
  room.lastActivityAt = Date.now();
  return room;
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

  // 7. Create Private Room with Unique Room Code (`POST /api/room/create`)
  if (reqUrl.pathname === '/api/room/create' && req.method === 'POST') {
    if (!checkHttpRateLimit(clientIp, 'room_create', 15, 60000)) {
      sendJson(res, 429, { ok: false, error: 'Too many room creation requests.' });
      return;
    }
    const code = generateUniqueRoomCode();
    const room = getOrCreateRoom(code);
    sendJson(res, 200, {
      ok: true,
      roomCode: room.code,
      connectedPlayers: 0,
      totalPlayers: 0,
    });
    return;
  }

  // 8. Query Room Status (`GET /api/room`)
  if (reqUrl.pathname === '/api/room' && req.method === 'GET') {
    const code = sanitizeRoomCode(reqUrl.searchParams.get('code') || 'CICRAFT-1');
    const room = rooms.get(code);
    const connectedCount = room
      ? Array.from(room.players.values()).filter((p) => p.isConnected).length
      : 0;
    sendJson(res, 200, {
      ok: true,
      roomCode: code,
      exists: Boolean(room),
      connectedPlayers: connectedCount,
      totalPlayers: room ? room.players.size : 0,
      stormPhase: room ? room.storm.phase : 1,
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
          const room = getOrCreateRoom(roomCode);
          currentRoom = room;
          currentSessionToken = String(msg.sessionToken || `sess_${crypto.randomBytes(6).toString('hex')}`).slice(0, 48);

          // Authenticate or auto-provision persistent player account
          let verifiedAccountId = null;
          if (msg.accountId && msg.accountToken) {
            const authRes = await db.createOrVerifyAccount({
              accountId: String(msg.accountId),
              accountToken: String(msg.accountToken),
              callsign: msg.playerName,
              cosmetics: {
                outfitId: msg.outfitId,
                skinColor: msg.skinColor,
                accentColor: msg.accentColor,
                backAccessory: msg.backAccessory,
              },
            });
            if (!authRes.isNew && authRes.accountId === msg.accountId) {
              verifiedAccountId = authRes.accountId;
            }
          }

          // Prevent duplicate player identities in the same room:
          // If the same verified accountId is already in the room under a previous sessionToken,
          // supersede the old entry cleanly.
          if (verifiedAccountId) {
            for (const [oldTok, existingP] of room.players.entries()) {
              if (
                existingP.accountId === verifiedAccountId &&
                oldTok !== currentSessionToken
              ) {
                if (
                  existingP.socket &&
                  existingP.socket !== socket &&
                  !existingP.socket.destroyed
                ) {
                  try {
                    existingP.socket.end();
                  } catch {
                    // Ignore
                  }
                }
                room.players.delete(oldTok);
              }
            }
          }

          const cleanCallsign = sanitizeCallsign(msg.playerName);
          let player = room.players.get(currentSessionToken);
          let isFreshJoinOrReset = false;

          if (!player) {
            isFreshJoinOrReset = true;
            player = {
              id: `net_${currentSessionToken}`,
              sessionToken: currentSessionToken,
              accountId: verifiedAccountId,
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
            player.name = cleanCallsign;
            if (msg.skinColor !== undefined) player.skinColor = Number(msg.skinColor);
            if (msg.accentColor !== undefined) player.accentColor = Number(msg.accentColor);
            if (msg.backAccessory) player.backAccessory = String(msg.backAccessory);
            if (msg.resetPlayer) {
              isFreshJoinOrReset = true;
              room.matchSeq += 1;
              player.health = 100;
              player.shield = 50;
              player.alive = true;
              player.eliminations = 0;
              player.position = sanitizePosition(msg.position, player.position);
            }
            player.socket = socket;
          }

          let profile;
          if (isFreshJoinOrReset) {
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

          broadcastRoomState(room);
        } else if (msg.type === 'player_sync' && currentRoom && currentSessionToken) {
          currentRoom.lastActivityAt = Date.now();
          const p = currentRoom.players.get(currentSessionToken);
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
          if (p && p.alive) {
            p.health = clampFinite(msg.health, 0, 100, p.health);
            p.shield = clampFinite(msg.shield, 0, 100, p.shield);
          }
        } else if (msg.type === 'fire_weapon' && currentRoom && currentSessionToken) {
          currentRoom.lastActivityAt = Date.now();
          broadcastToRoom(
            currentRoom,
            {
              type: 'remote_weapon_fired',
              shooterId: `net_${currentSessionToken}`,
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

          if (victim.health <= 0 && victim.alive) {
            victim.alive = false;
            eliminated = true;
            attacker.eliminations = (attacker.eliminations || 0) + 1;

            // Check if attacker is the last surviving human player in the room
            const alivePlayers = Array.from(currentRoom.players.values()).filter(
              (p) => p.alive
            );
            const victimPlacement = Math.max(2, alivePlayers.length + 1);

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

            if (alivePlayers.length === 1 && alivePlayers[0].id === attacker.id) {
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
            victimSessionToken: victim.sessionToken,
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
        } else if (msg.type === 'collect_loot' && currentRoom && currentSessionToken) {
          currentRoom.lastActivityAt = Date.now();
          const collector = currentRoom.players.get(currentSessionToken);
          if (!collector || !collector.alive) continue;

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
            sessionToken: currentSessionToken,
            collectorId: collector.id,
            lootId,
            itemType,
            spawnedDrops,
            swappedDrop,
          });
        } else if (msg.type === 'place_build' && currentRoom && currentSessionToken) {
          currentRoom.lastActivityAt = Date.now();
          const mat = String(msg.material || 'wood');
          const safeMat = mat === 'stone' || mat === 'metal' ? mat : 'wood';
          const maxHp = safeMat === 'wood' ? 150 : safeMat === 'stone' ? 220 : 300;
          const buildPacket = {
            type: 'build_placed',
            sessionToken: currentSessionToken,
            buildId: String(msg.buildId || `build_${Date.now()}`).slice(0, 64),
            ownerId: `net_${currentSessionToken}`,
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
        } else if (msg.type === 'damage_build' && currentRoom) {
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
      if (p && p.socket === socket) {
        p.isConnected = false;
        p.disconnectedAt = Date.now();
      }
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

function broadcastRoomState(room) {
  const playersSnapshot = [];
  for (const p of room.players.values()) {
    const pos = p.position || { x: 0, y: 6, z: 0 };
    const vel = p.velocity || { x: 0, y: 0, z: 0 };
    playersSnapshot.push({
      id: p.id,
      sessionToken: p.sessionToken,
      name: p.name,
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
    });
  }

  const s = room.storm;
  broadcastToRoom(room, {
    type: 'room_state',
    roomCode: room.code,
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

// 20Hz authoritative room state tick for active rooms
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
      updateRoomStorm(room, 0.05);
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
    for (const [tok, p] of room.players.entries()) {
      if (p.isConnected) {
        connectedCount++;
      } else if (p.disconnectedAt > 0 && now - p.disconnectedAt > 120_000) {
        room.players.delete(tok);
      }
    }
    if (connectedCount === 0 && now - room.lastActivityAt > 180_000) {
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
