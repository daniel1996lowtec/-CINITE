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
import { createWorldLootMap, getChestRewards, validateLootClaim } from './worldLoot.mjs';
import { resetInventory, inventoryAction, advanceInventory, fireInventory, collectInventory, inventorySnapshot, cancelInventoryAction, weaponStats as catalogueStats } from './inventory.mjs';
import { canReachLoot, hasLineOfSight, worldProps, buildTransform, isPlayerPositionClear, safeSpawnPosition } from './worldGeometry.mjs';
import { validateChatText, createChatRateLimiter } from './textChat.mjs';
const allowChatAttempt = createChatRateLimiter();
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
const LOBBY_MAX_PLAYER_OPTIONS = new Set([2, 4, 8, 16, 20]);
const LOBBY_MAPS = new Map([['ci_island', 'CI Island']]);
const TEAM_MODES = new Set(['solo', 'duo', 'squad']);
const TEAM_MODE_SIZES = { solo: 1, duo: 2, squad: 4 };
const LOBBY_START_CONDITIONS = new Set(['all_ready', 'host_start', 'fill_lobby']);
const BOT_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const HUMAN_MATCH_COUNTDOWN_MS = Math.max(
  250,
  Math.min(
    10_000,
    Number(
      process.env.LOBBY_MATCH_COUNTDOWN_MS ||
        process.env.HUMAN_MATCH_COUNTDOWN_MS ||
        3000
    ) || 3000
  )
);
const LOBBY_IDLE_TTL_MS = Math.max(
  60_000,
  Math.min(60 * 60_000, Number(process.env.LOBBY_IDLE_TTL_MS || 10 * 60_000) || 10 * 60_000)
);
const CLOSED_ROOM_TTL_MS = Math.max(
  30_000,
  Math.min(30 * 60_000, Number(process.env.CLOSED_ROOM_TTL_MS || 5 * 60_000) || 5 * 60_000)
);

// The Legendary Tower vault is a fixed, server-owned registry. It mirrors
// LEGENDARY_TOWER_VAULT_LOOT in src/world/WorldLayout.ts (centre terrain
// 4.5 + 0.55 podium + 7 floors × 6.5 + 1.18 pedestal offset = y 51.73).
// Online clients render only copies sent by this server; collection is
// range-checked against these coordinates and each ID can be claimed once
// per room match. Lobby matches reset the registry at match start.
const LEGENDARY_TOWER_LOOT_TEMPLATES = [
  { id: 'legendary_tower_assault_rifle', itemType: 'weapon', weaponCategory: 'assault_rifle', rarity: 'legendary', name: 'Legendary Pulse Rifle', amount: 1, position: { x: -3, y: 51.73, z: 2.8 } },
  { id: 'legendary_tower_sniper', itemType: 'weapon', weaponCategory: 'sniper', rarity: 'legendary', name: 'Legendary Rail Sniper', amount: 1, position: { x: 0, y: 51.73, z: 3.4 } },
  { id: 'legendary_tower_shotgun', itemType: 'weapon', weaponCategory: 'shotgun', rarity: 'legendary', name: 'Legendary Scatter Pump', amount: 1, position: { x: 3, y: 51.73, z: 2.8 } },
  { id: 'legendary_tower_shield_1', itemType: 'consumable', weaponCategory: 'shield_potion', rarity: 'rare', name: 'Shield Potion (+50)', amount: 1, position: { x: -3.6, y: 51.73, z: 0.6 } },
  { id: 'legendary_tower_shield_2', itemType: 'consumable', weaponCategory: 'shield_potion', rarity: 'rare', name: 'Shield Potion (+50)', amount: 1, position: { x: -1.9, y: 51.73, z: 0.8 } },
  { id: 'legendary_tower_medkit_1', itemType: 'consumable', weaponCategory: 'medkit', rarity: 'uncommon', name: 'Nano Medkit (+50)', amount: 1, position: { x: 1.9, y: 51.73, z: 0.8 } },
  { id: 'legendary_tower_medkit_2', itemType: 'consumable', weaponCategory: 'medkit', rarity: 'uncommon', name: 'Nano Medkit (+50)', amount: 1, position: { x: 3.6, y: 51.73, z: 0.6 } },
  { id: 'legendary_tower_medium_ammo', itemType: 'ammo', ammoType: 'medium', rarity: 'common', name: 'Medium Ammo (120)', amount: 120, position: { x: -3.4, y: 51.73, z: -3 } },
  { id: 'legendary_tower_heavy_ammo', itemType: 'ammo', ammoType: 'heavy', rarity: 'common', name: 'Heavy Sniper Ammo (40)', amount: 40, position: { x: 0, y: 51.73, z: -3.6 } },
  { id: 'legendary_tower_shells', itemType: 'ammo', ammoType: 'shells', rarity: 'common', name: 'Shotgun Shells (48)', amount: 48, position: { x: 3.4, y: 51.73, z: -3 } },
  { id: 'legendary_tower_metal', itemType: 'material', materialType: 'metal', rarity: 'uncommon', name: 'METAL x250', amount: 250, position: { x: -3.8, y: 51.73, z: -0.8 } },
  { id: 'legendary_tower_stone', itemType: 'material', materialType: 'stone', rarity: 'uncommon', name: 'STONE x200', amount: 200, position: { x: 3.8, y: 51.73, z: -0.8 } },
  { id: 'legendary_tower_wood', itemType: 'material', materialType: 'wood', rarity: 'uncommon', name: 'WOOD x200', amount: 200, position: { x: 0, y: 51.73, z: -2.2 } },
].map((item) => ({
  ...item,
  opened: false,
  isLegendaryTowerLoot: true,
  serverAuthoritative: true,
}));
const LEGENDARY_TOWER_LOOT_BY_ID = new Map(
  LEGENDARY_TOWER_LOOT_TEMPLATES.map((item) => [item.id, item])
);
const LEGENDARY_TOWER_VAULT_WEAPON_CATEGORIES = new Set([
  'assault_rifle',
  'sniper',
  'shotgun',
]);
const LOOT_WEAPON_CATEGORIES = new Set([
  'pistol',
  'heavy_pistol',
  'assault_rifle',
  'burst_rifle',
  'dmr',
  'shotgun',
  'tactical_shotgun',
  'smg',
  'sniper',
  'medkit',
  'shield_potion',
]);
const LOOT_RARITIES = new Set(['common', 'uncommon', 'rare', 'epic', 'legendary']);

// SERVER_WEAPON_CATALOG is generated from the exact client definitions by loot:generate.
// No independent damage/ammo/reload balance table can silently diverge.
function getServerWeaponStats(category, rarity) {
  const stats = catalogueStats(category,rarity);
  return stats && stats.rarity === rarity && !stats.isConsumable ? stats : null;
}

function getServerWeaponDamage(stats, isHeadshot) {
  if (!stats) return 0;
  return Math.round(
    stats.baseDamage * (isHeadshot ? stats.headshotMultiplier : 1)
  );
}

function resetServerCombatState(player) {
  if (!player || typeof player !== 'object') return;
  player.lastServerShotAt = 0;
  player.serverShotTokens = 3;
  player.serverShotTokenUpdatedAt = Date.now();
  player.serverShotCredit = null;
  player.serverBurstShotsRemaining = 0;
  player.serverBurstCategory = '';
  player.serverBurstRarity = '';
  player.serverNextShotAt = 0;
}

function consumeServerShot(player, stats, now = Date.now()) {
  if (!fireInventory(player, stats?.category, stats?.rarity, now)) return false;

  const previous = player.serverShotCredit;
  const previousPellets =
    previous &&
    previous.category === stats.category &&
    previous.rarity === stats.rarity &&
    Number(previous.expiresAt || 0) > now
      ? Number(previous.pelletsRemaining || 0)
      : 0;
  player.serverShotCredit = {
    category: stats.category,
    rarity: stats.rarity,
    pelletsRemaining: Math.min(
      stats.pellets * 3,
      previousPellets + stats.pellets
    ),
    expiresAt: now + 900,
  };
  player.lastServerShotAt = now;
  return true;
}

function consumeServerHitCredit(player, stats, now = Date.now()) {
  const credit = player?.serverShotCredit;
  if (!credit || !stats) return false;
  if (
    credit.category !== stats.category ||
    credit.rarity !== stats.rarity ||
    Number(credit.expiresAt || 0) <= now ||
    Number(credit.pelletsRemaining || 0) <= 0
  ) {
    return false;
  }
  credit.pelletsRemaining -= 1;
  return true;
}

function cloneLegendaryTowerLootItem(item) {
  return { ...item, position: { ...item.position } };
}

function createRoomLootMap() {
  return new Map(
    [...createWorldLootMap().values(), ...LEGENDARY_TOWER_LOOT_TEMPLATES].map((item) => [
      item.id,
      cloneLegendaryTowerLootItem(item),
    ])
  );
}

function resetRoomLootRegistry(room) {
  for (const [id, item] of createRoomLootMap()) {
    room.spawnedLootItems.set(id, item);
  }
}

/**
 * The server does not model full client inventories, but it can remember
 * which unique vault weapon categories it has personally awarded to a
 * player. That narrow ownership ledger lets an honest full-inventory swap
 * broadcast the tower weapon being dropped exactly once, while a client
 * that never claimed (or never picked up a registered swap of) that weapon
 * still cannot mint it for the room. The ledger is per room player object,
 * is never serialized to clients, and is cleared at match (re)start.
 */
function getLegendaryTowerWeaponOwnership(player) {
  if (!player || typeof player !== 'object') return new Set();
  if (!(player.legendaryTowerWeaponCategories instanceof Set)) {
    player.legendaryTowerWeaponCategories = new Set();
  }
  return player.legendaryTowerWeaponCategories;
}

function isLegendaryTowerWeaponItem(item) {
  return Boolean(
    item &&
      item.rarity === 'legendary' &&
      LEGENDARY_TOWER_VAULT_WEAPON_CATEGORIES.has(item.weaponCategory)
  );
}

function clearLegendaryTowerWeaponOwnership(player) {
  getLegendaryTowerWeaponOwnership(player).clear();
}

/**
 * Server-only provenance for broadcast swap drops. A generic client chest
 * drop can look like a legendary rifle/sniper/shotgun in the legacy loot
 * protocol, so its item fields alone must not create tower ownership. Only
 * IDs inserted here when the server sanitizes an ownership-proven swap can
 * transfer that ownership to the next collector.
 */
function getLegendaryTowerSwapDrops(room) {
  if (!room || typeof room !== 'object') return new Map();
  if (!(room.legendaryTowerSwapDrops instanceof Map)) {
    room.legendaryTowerSwapDrops = new Map();
  }
  return room.legendaryTowerSwapDrops;
}

function isLegendaryTowerLootId(lootId) {
  return (
    typeof lootId === 'string' &&
    (LEGENDARY_TOWER_LOOT_BY_ID.has(lootId) || lootId.startsWith('legendary_tower_'))
  );
}

function serverWeaponDisplayName(category, rarity) {
  if (category === 'harvester') return 'CI Harvester';
  if (category === 'shield_potion') return 'Shield Potion (+50)';
  if (category === 'medkit') return 'Nano Medkit (+50)';
  const label = rarity.charAt(0).toUpperCase() + rarity.slice(1);
  const base = {
    harvester: 'CI Harvester',
    pistol: 'Cyber Pistol',
    heavy_pistol: 'Rhino Hand Cannon',
    assault_rifle: 'Pulse Rifle',
    burst_rifle: 'Triad Burst Rifle',
    dmr: 'Longbow DMR',
    shotgun: 'Scatter Pump',
    tactical_shotgun: 'Vector Tactical Shotgun',
    smg: 'Hyper SMG',
    sniper: 'Rail Sniper',
  }[category] || 'Pulse Rifle';
  return `${label} ${base}`;
}

/**
 * A pickup swap is the only client-proposed drop accepted beside a registered
 * claim. Reserve the swap_ namespace so it cannot shadow future chest rewards. Rebuild it from validated fields and never let it mint one of the
 * three unique vault weapons unless the server's ownership ledger proves
 * this collector previously received that category from the vault (or from
 * a registered, server-broadcast swap drop).
 */
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
 * Sockets subscribed to the public lobby directory. Directory payloads are
 * generated from server-owned room state and contain no account/session
 * secrets or room passwords.
 * @type {Set<any>}
 */
const lobbyDirectorySubscribers = new Set();
let lobbyDirectoryBroadcastTimer = null;

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

function sanitizeLobbyName(rawName, fallback = 'CI Island Battle') {
  if (typeof rawName !== 'string') return fallback;
  const cleaned = rawName
    .replace(/[<>\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
  return cleaned.length >= 3 ? cleaned : fallback;
}

function hashRoomPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .scryptSync(String(password), salt, 32, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    })
    .toString('hex');
  return `${salt}:${hash}`;
}

function verifyRoomPassword(room, password) {
  if (!room?.passwordHash) return true;
  if (typeof password !== 'string' || password.length === 0) return false;
  const [salt, expected] = String(room.passwordHash).split(':');
  if (!salt || !expected) return false;
  let actual;
  try {
    actual = crypto
      .scryptSync(password, salt, 32, {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      })
      .toString('hex');
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function normalizeLobbyVisibility(rawVisibility, fallback = 'public') {
  if (rawVisibility === undefined || rawVisibility === null || rawVisibility === '') {
    return fallback;
  }
  const visibility = String(rawVisibility).trim().toLowerCase();
  return visibility === 'public' || visibility === 'private' ? visibility : null;
}

function modeForLobbySelection(humanOnly, visibility) {
  if (!humanOnly) return 'online_ai_fill';
  return visibility === 'private' ? 'human_only_private' : 'human_only_public';
}

function resolveLobbyConfig(rawConfig, { fallbackMode = 'online_ai_fill' } = {}) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const hasExplicitHumanOnly =
    raw.humanOnly !== undefined || raw.humanPlayersOnly !== undefined;
  const legacyMode = normalizeRoomMode(raw.roomMode ?? raw.mode);
  if (legacyMode === 'invalid') {
    return { config: null, error: 'Invalid multiplayer room mode.', code: 'invalid_room_mode' };
  }

  let visibility = normalizeLobbyVisibility(
    raw.visibility ??
      (legacyMode === 'human_only_private'
        ? 'private'
        : legacyMode === 'human_only_public'
          ? 'public'
          : 'public')
  );
  if (!visibility) {
    return { config: null, error: 'Lobby visibility must be public or private.', code: 'invalid_visibility' };
  }

  let humanOnly;
  if (hasExplicitHumanOnly) {
    humanOnly = Boolean(raw.humanOnly ?? raw.humanPlayersOnly);
  } else if (legacyMode) {
    humanOnly = isHumanOnlyMode(legacyMode);
  } else {
    humanOnly = isHumanOnlyMode(fallbackMode);
    if (humanOnly) {
      visibility = fallbackMode === 'human_only_private' ? 'private' : 'public';
    }
  }

  const mode = modeForLobbySelection(humanOnly, visibility);
  if (legacyMode && legacyMode !== mode) {
    return {
      config: null,
      error: 'Lobby mode, human-only setting and visibility do not agree.',
      code: 'invalid_room_mode',
    };
  }

  const maxPlayers =
    raw.maxPlayers === undefined ? ROOM_MAX_HUMANS : Math.floor(Number(raw.maxPlayers));
  if (!LOBBY_MAX_PLAYER_OPTIONS.has(maxPlayers)) {
    return {
      config: null,
      error: 'Maximum players must be one of 2, 4, 8, 16 or 20.',
      code: 'invalid_max_players',
    };
  }

  const mapId = String(raw.mapId || 'ci_island').trim().toLowerCase();
  if (!LOBBY_MAPS.has(mapId)) {
    return { config: null, error: 'Only the CI Island map is available.', code: 'invalid_map' };
  }

  const teamMode = String(raw.teamMode || raw.gameMode || 'solo').trim().toLowerCase();
  if (!TEAM_MODES.has(teamMode)) {
    return { config: null, error: 'Game format must be Solo, Duo or Squad.', code: 'invalid_team_mode' };
  }
  if (!humanOnly && teamMode !== 'solo') {
    return {
      config: null,
      error: 'Duo and Squad are server-authoritative human-only formats. AI Fill lobbies use Solo format.',
      code: 'team_mode_requires_human_only',
    };
  }

  const startCondition = String(raw.startCondition || 'all_ready').trim().toLowerCase();
  if (!LOBBY_START_CONDITIONS.has(startCondition)) {
    return {
      config: null,
      error: 'Invalid match start condition.',
      code: 'invalid_start_condition',
    };
  }

  const botDifficulty = String(raw.botDifficulty || raw.difficulty || 'medium')
    .trim()
    .toLowerCase();
  if (!BOT_DIFFICULTIES.has(botDifficulty)) {
    return { config: null, error: 'Invalid AI bot difficulty.', code: 'invalid_bot_difficulty' };
  }

  const rawBotCount =
    raw.botCount === undefined ? (humanOnly ? 0 : 14) : Math.floor(Number(raw.botCount));
  if (!Number.isFinite(rawBotCount) || rawBotCount < 0 || rawBotCount > 19) {
    return {
      config: null,
      error: 'AI bot count must be between 0 and 19.',
      code: 'invalid_bot_count',
    };
  }
  if (humanOnly && rawBotCount !== 0) {
    return {
      config: null,
      error: 'Human Players Only lobbies cannot enable AI bots.',
      code: 'bots_forbidden',
    };
  }

  const password = typeof raw.password === 'string' ? raw.password : '';
  if (password && visibility !== 'private') {
    return {
      config: null,
      error: 'Only private lobbies can use a password.',
      code: 'invalid_password',
    };
  }
  if (password && (password.length < 4 || password.length > 32)) {
    return {
      config: null,
      error: 'Private lobby passwords must be 4–32 characters.',
      code: 'invalid_password',
    };
  }

  const rawLobbyName = raw.name ?? raw.lobbyName;
  if (
    rawLobbyName !== undefined &&
    (typeof rawLobbyName !== 'string' ||
      rawLobbyName.trim().length < 3 ||
      rawLobbyName.trim().length > 32)
  ) {
    return {
      config: null,
      error: 'Lobby name must be 3–32 characters.',
      code: 'invalid_lobby_name',
    };
  }

  const hostName = sanitizeCallsign(raw.hostName || raw.playerName || 'Commander_CI');
  const name = sanitizeLobbyName(rawLobbyName, `${hostName}'s Lobby`);

  return {
    config: {
      name,
      visibility,
      mode,
      humanOnly,
      aiFillEnabled: !humanOnly,
      maxPlayers,
      minPlayers: humanOnly ? HUMAN_ONLY_MIN_PLAYERS : 1,
      mapId,
      mapName: LOBBY_MAPS.get(mapId),
      teamMode,
      botCount: humanOnly ? 0 : rawBotCount,
      botDifficulty,
      startCondition,
      passwordHash: password ? hashRoomPassword(password) : '',
      hasPassword: Boolean(password),
      // Passwordless private rooms are invite-by-code/link and stay out of
      // the public directory. Password-protected private rooms can safely be
      // listed as locked cards because the password is never disclosed.
      isListed: visibility === 'public' || Boolean(password),
      allowLateJoin: Boolean(raw.allowLateJoin),
      hostName,
      isLobbyManaged: true,
    },
    error: null,
    code: null,
  };
}

function defaultLobbyConfigForMode(mode, code = 'CICRAFT-1') {
  const humanOnly = isHumanOnlyMode(mode);
  const visibility = roomVisibilityForMode(mode);
  return {
    name: `${code} Lobby`,
    visibility,
    mode,
    humanOnly,
    aiFillEnabled: mode === 'online_ai_fill',
    maxPlayers: ROOM_MAX_HUMANS,
    minPlayers: humanOnly ? HUMAN_ONLY_MIN_PLAYERS : 1,
    mapId: 'ci_island',
    mapName: LOBBY_MAPS.get('ci_island'),
    teamMode: 'solo',
    botCount: 0,
    botDifficulty: 'medium',
    startCondition: 'all_ready',
    passwordHash: '',
    hasPassword: false,
    isListed: mode === 'human_only_public',
    allowLateJoin: !humanOnly,
    hostName: 'Open Room',
    // Human-only rooms were already lobby-managed. Ad-hoc legacy online
    // codes keep their instant-drop behaviour for backward compatibility;
    // rooms created through Lobby Browser 3.0 are explicitly lobby-managed.
    isLobbyManaged: humanOnly,
  };
}

function isLobbyManagedRoom(room) {
  return Boolean(room?.isLobbyManaged || isHumanOnlyMode(room?.mode));
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

// Mirrors src/systems/StormConfig.ts. Keep phase timings/radii identical so
// offline and authoritative online matches have the same strategic pacing.
const STORM_PHASE_CONFIGS = [
  { phase: 1, waitSeconds: 90, shrinkSeconds: 70, targetRadius: 150, damagePerSecond: 1 },
  { phase: 2, waitSeconds: 70, shrinkSeconds: 60, targetRadius: 105, damagePerSecond: 2 },
  { phase: 3, waitSeconds: 55, shrinkSeconds: 50, targetRadius: 72, damagePerSecond: 3 },
  { phase: 4, waitSeconds: 45, shrinkSeconds: 42, targetRadius: 48, damagePerSecond: 5 },
  { phase: 5, waitSeconds: 35, shrinkSeconds: 34, targetRadius: 30, damagePerSecond: 7 },
  { phase: 6, waitSeconds: 28, shrinkSeconds: 28, targetRadius: 18, damagePerSecond: 9 },
  { phase: 7, waitSeconds: 22, shrinkSeconds: 24, targetRadius: 10, damagePerSecond: 12 },
  { phase: 8, waitSeconds: 18, shrinkSeconds: 20, targetRadius: 4, damagePerSecond: 15 },
];

function getStormPhaseConfig(phase) {
  const index = Math.max(
    0,
    Math.min(STORM_PHASE_CONFIGS.length - 1, Math.floor(Number(phase) || 1) - 1)
  );
  return STORM_PHASE_CONFIGS[index];
}

function createInitialStorm() {
  const first = getStormPhaseConfig(1);
  return {
    phase: 1,
    currentCenterX: 0,
    currentCenterZ: 0,
    currentRadius: 255,
    targetCenterX: 12,
    targetCenterZ: -10,
    targetRadius: first.targetRadius,
    phaseTimer: first.waitSeconds,
    isShrinking: false,
    damagePerSecond: first.damagePerSecond,
    shrinkFromCenterX: 0,
    shrinkFromCenterZ: 0,
    shrinkFromRadius: 255,
    shrinkElapsed: 0,
    shrinkDuration: 0,
  };
}

function chooseServerStormTargetCenter(storm, nextPhase) {
  const shrinkAmount = Math.max(0, storm.currentRadius - nextPhase.targetRadius);
  const shift = shrinkAmount * 0.42;
  const angle = nextPhase.phase * 2.399963229728653 + 0.7;
  return {
    x: storm.currentCenterX + Math.cos(angle) * shift,
    z: storm.currentCenterZ + Math.sin(angle) * shift,
  };
}

function beginServerStormShrink(storm, config) {
  storm.isShrinking = true;
  storm.shrinkFromCenterX = storm.currentCenterX;
  storm.shrinkFromCenterZ = storm.currentCenterZ;
  storm.shrinkFromRadius = storm.currentRadius;
  storm.shrinkElapsed = 0;
  storm.shrinkDuration = config.shrinkSeconds;
  storm.phaseTimer = config.shrinkSeconds;
}

function finishServerStormShrink(storm) {
  storm.currentCenterX = storm.targetCenterX;
  storm.currentCenterZ = storm.targetCenterZ;
  storm.currentRadius = storm.targetRadius;
  storm.isShrinking = false;
  storm.shrinkElapsed = 0;
  storm.shrinkDuration = 0;
  storm.phase += 1;

  if (storm.phase > STORM_PHASE_CONFIGS.length) {
    const final = getStormPhaseConfig(STORM_PHASE_CONFIGS.length);
    storm.damagePerSecond = final.damagePerSecond;
    storm.phaseTimer = 0;
    storm.targetCenterX = storm.currentCenterX;
    storm.targetCenterZ = storm.currentCenterZ;
    storm.targetRadius = storm.currentRadius;
    return;
  }

  const next = getStormPhaseConfig(storm.phase);
  storm.damagePerSecond = next.damagePerSecond;
  storm.phaseTimer = next.waitSeconds;
  const target = chooseServerStormTargetCenter(storm, next);
  storm.targetCenterX = target.x;
  storm.targetCenterZ = target.z;
  storm.targetRadius = next.targetRadius;
}

function advanceServerStorm(storm, dt) {
  if (!storm || !Number.isFinite(dt) || dt <= 0) return;
  if (storm.phase > STORM_PHASE_CONFIGS.length) {
    storm.phaseTimer = 0;
    return;
  }

  let remaining = dt;
  for (let guard = 0; remaining > 1e-9 && guard < 24; guard++) {
    const config = getStormPhaseConfig(storm.phase);
    if (!storm.isShrinking) {
      storm.damagePerSecond = config.damagePerSecond;
      if (remaining < storm.phaseTimer) {
        storm.phaseTimer -= remaining;
        remaining = 0;
      } else {
        remaining -= Math.max(0, storm.phaseTimer);
        beginServerStormShrink(storm, config);
      }
      continue;
    }

    const duration = Math.max(
      0.001,
      Number(storm.shrinkDuration || config.shrinkSeconds) || config.shrinkSeconds
    );
    const fromX = Number(storm.shrinkFromCenterX ?? storm.currentCenterX);
    const fromZ = Number(storm.shrinkFromCenterZ ?? storm.currentCenterZ);
    const fromRadius = Number(storm.shrinkFromRadius ?? storm.currentRadius);
    const elapsedBefore = Math.min(
      duration,
      Math.max(0, Number(storm.shrinkElapsed || 0))
    );
    const step = Math.min(remaining, duration - elapsedBefore);
    const elapsed = elapsedBefore + step;
    const t = Math.max(0, Math.min(1, elapsed / duration));
    storm.currentCenterX = fromX + (storm.targetCenterX - fromX) * t;
    storm.currentCenterZ = fromZ + (storm.targetCenterZ - fromZ) * t;
    storm.currentRadius = fromRadius + (storm.targetRadius - fromRadius) * t;
    storm.shrinkElapsed = elapsed;
    storm.shrinkDuration = duration;
    storm.phaseTimer = Math.max(0, duration - elapsed);
    remaining -= step;

    if (elapsed >= duration - 1e-9) {
      finishServerStormShrink(storm);
      if (storm.phase > STORM_PHASE_CONFIGS.length) return;
    }
  }
}

function getOrCreateRoom(
  code,
  requestedMode = 'online_ai_fill',
  lobbyConfig = null,
  hostReservation = null
) {
  const normalized = sanitizeRoomCode(code);
  if (!rooms.has(normalized)) {
    const mode = lobbyConfig?.mode || inferRoomModeForCode(normalized) || requestedMode;
    const config = lobbyConfig || defaultLobbyConfigForMode(mode, normalized);
    const lobbyManaged = isLobbyManagedRoom({ mode, isLobbyManaged: config.isLobbyManaged });
    rooms.set(normalized, {
      code: normalized,
      mode,
      name: config.name,
      visibility: config.visibility,
      // Legacy online rooms preserve the existing instant-drop behavior.
      // Lobby Browser rooms (and all human-only rooms) start in a lobby and
      // can only become active through the server-side ready/host check.
      phase: lobbyManaged ? 'lobby' : 'active',
      maxPlayers: config.maxPlayers,
      minPlayers: config.minPlayers,
      mapId: config.mapId,
      mapName: config.mapName,
      teamMode: config.teamMode,
      configuredBotCount: config.botCount,
      botDifficulty: config.botDifficulty,
      startCondition: config.startCondition,
      passwordHash: config.passwordHash || '',
      isListed: Boolean(config.isListed),
      allowLateJoin: Boolean(config.allowLateJoin),
      isLobbyManaged: lobbyManaged,
      closed: false,
      closedAt: 0,
      closeReason: '',
      hostPlayerId: null,
      hostAccountId: hostReservation?.accountId || null,
      hostName: hostReservation?.name || config.hostName || 'Open Room',
      hasHostJoined: false,
      countdownEndsAt: 0,
      countdownTimer: null,
      matchStartedAt: 0,
      matchEndedAt: 0,
      matchParticipantIds: new Set(),
      placements: new Map(),
      winnerId: null,
      winnerIds: [],
      winnerTeamId: '',
      winnerName: '',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      matchTimer: 0,
      storm: createInitialStorm(),
      players: new Map(),
      buildables: new Map(),
    collectedLootIds: new Set(),
    lootReceipts: new Map(),
    spawnedLootItems: createRoomLootMap(),
    legendaryTowerSwapDrops: new Map(),
      processedHitIds: new Set(),
      hitEventSeq: 0,
      matchSeq: 1,
      lastStormDamageAt: 0,
      stormDamageInProgress: false,
    });
    queueLobbyDirectoryBroadcast('room_created');
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

function getLobbyEligibleHumans(room) {
  const connected = getRoomHumanPlayers(room).filter((player) => player.isConnected);
  // Browser-managed lobbies require verified accounts (enforced at join).
  // Returning only authenticated players here keeps ready/start decisions
  // server-derived even if a client spoofs counts or ready claims.
  return connected.filter((player) => player.isAuthenticated && player.accountId);
}

function getLobbyStatus(room) {
  if (room.closed) return 'closed';
  if (room.phase === 'countdown') return 'starting';
  if (room.phase === 'active') return 'in_game';
  if (room.phase === 'ended') return 'ended';
  const counts = getRoomCounts(room);
  return counts.connectedHumans >= room.maxPlayers ? 'full' : 'waiting';
}

function getLobbyJoinBlock(room) {
  if (!room) return { canJoin: false, code: 'room_not_found', reason: 'Room not found.' };
  if (room.closed) return { canJoin: false, code: 'room_closed', reason: 'This lobby is closed.' };
  const counts = getRoomCounts(room);
  if (counts.connectedHumans >= room.maxPlayers) {
    return { canJoin: false, code: 'room_full', reason: 'This lobby is full.' };
  }
  if (isLobbyManagedRoom(room) && room.phase !== 'lobby' && !room.allowLateJoin) {
    if (room.phase === 'ended') {
      return { canJoin: false, code: 'match_ended', reason: 'This match has ended.' };
    }
    return {
      canJoin: false,
      code: 'match_in_progress',
      reason: 'This match has already started.',
    };
  }
  return { canJoin: true, code: '', reason: '' };
}

function assignLobbyTeams(room, participants) {
  const ordered = [...participants].sort(
    (a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || String(a.id).localeCompare(String(b.id))
  );
  if (room.teamMode === 'solo' || !TEAM_MODES.has(room.teamMode)) {
    ordered.forEach((player, index) => {
      player.teamId = `solo_${player.id}`;
      player.teamIndex = index;
    });
    return ordered;
  }

  const teamSize = TEAM_MODE_SIZES[room.teamMode] || 1;
  const teamCount = Math.max(
    ordered.length >= 2 ? 2 : 1,
    Math.ceil(ordered.length / Math.max(1, teamSize))
  );
  ordered.forEach((player, index) => {
    const teamIndex = index % teamCount;
    player.teamId = `team_${teamIndex + 1}`;
    player.teamIndex = teamIndex;
  });
  return ordered;
}

function refreshProvisionalLobbyTeams(room) {
  if (!isLobbyManagedRoom(room) || room.phase === 'active' || room.phase === 'ended') return;
  assignLobbyTeams(room, getLobbyEligibleHumans(room));
}

function ensureRoomHost(room, { broadcast = true } = {}) {
  if (!room) return null;
  const players = getRoomHumanPlayers(room);
  const connected = players
    .filter((player) => player.isConnected)
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));

  let host = null;
  if (room.hostAccountId) {
    host = connected.find((player) => player.accountId === room.hostAccountId) || null;
  }
  if (!host && room.hostPlayerId) {
    host = connected.find((player) => player.id === room.hostPlayerId) || null;
  }
  if (!host && room.hostAccountId && !room.hasHostJoined) {
    // A lobby created over HTTP, or in the brief create-then-join WebSocket
    // sequence, has a reserved account-bound host. Another player who opens
    // the invite first must not steal host authority before that host joins.
    room.hostPlayerId = null;
    for (const player of players) player.isHost = false;
    return null;
  }
  if (!host) host = connected[0] || null;

  const previousHostId = room.hostPlayerId;
  if (host) {
    room.hostPlayerId = host.id;
    if (host.accountId) room.hostAccountId = host.accountId;
    room.hostName = host.name;
    room.hasHostJoined = true;
  } else if (connected.length === 0) {
    room.hostPlayerId = null;
  }

  for (const player of players) {
    player.isHost = Boolean(host && player.id === host.id);
  }

  if (broadcast && host && previousHostId && previousHostId !== host.id) {
    broadcastToRoom(room, {
      type: 'host_changed',
      hostPlayerId: host.id,
      hostName: host.name,
      ...buildRoomSummary(room),
    });
    queueLobbyDirectoryBroadcast('host_changed');
  }
  return host;
}

function buildLobbySummary(room) {
  const counts = getRoomCounts(room);
  const status = getLobbyStatus(room);
  const joinBlock = getLobbyJoinBlock(room);
  const currentPlayers = counts.connectedHumans;
  return {
    id: room.code,
    roomId: room.code,
    roomCode: room.code,
    name: room.name || `${room.code} Lobby`,
    lobbyName: room.name || `${room.code} Lobby`,
    hostName: room.hostName || 'Open Room',
    hostPlayerId: room.hostPlayerId || null,
    mode: room.mode,
    roomMode: room.mode,
    visibility: room.visibility,
    isPrivate: room.visibility === 'private',
    hasPassword: Boolean(room.passwordHash),
    phase: room.phase,
    status,
    matchStatus: room.phase,
    humanOnly: isHumanOnlyMode(room.mode),
    aiFillEnabled: room.mode === 'online_ai_fill',
    botCount: isHumanOnlyMode(room.mode) ? 0 : Math.max(0, Number(room.configuredBotCount || 0)),
    botDifficulty: room.botDifficulty || 'medium',
    currentPlayers,
    humanCount: currentPlayers,
    connectedHumans: currentPlayers,
    readyHumans: counts.readyHumans,
    maxPlayers: room.maxPlayers,
    availableSlots: Math.max(0, room.maxPlayers - currentPlayers),
    minPlayers: room.minPlayers,
    mapId: room.mapId || 'ci_island',
    mapName: room.mapName || LOBBY_MAPS.get(room.mapId || 'ci_island'),
    teamMode: room.teamMode || 'solo',
    gameMode: room.teamMode || 'solo',
    startCondition: room.startCondition || 'all_ready',
    allowLateJoin: Boolean(room.allowLateJoin),
    canJoin: joinBlock.canJoin,
    joinBlockReason: joinBlock.reason,
    createdAt: room.createdAt || 0,
    matchStartedAt: room.matchStartedAt || 0,
    pingMs: null,
  };
}

function isLobbyDiscoverable(room) {
  if (!room || room.closed || room.phase === 'ended') return false;
  if (getRoomCounts(room).connectedHumans === 0) return false;
  if (!isLobbyManagedRoom(room) && !room.isListed) return false;
  if (room.visibility === 'public') return true;
  if (room.visibility === 'private' && room.passwordHash) return true;
  return Boolean(room.isListed && room.visibility === 'public');
}

function listDiscoverableLobbies() {
  return Array.from(rooms.values())
    .filter(isLobbyDiscoverable)
    .map(buildLobbySummary)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100);
}

function applyLobbyListFilters(lobbies, rawFilters = {}) {
  const filters = rawFilters && typeof rawFilters === 'object' ? rawFilters : {};
  const search = String(filters.search || filters.query || '').trim().toLowerCase();
  const visibility = String(filters.visibility || 'all').trim().toLowerCase();
  const teamMode = String(filters.teamMode || filters.gameMode || 'all').trim().toLowerCase();
  const mapId = String(filters.mapId || filters.map || 'all').trim().toLowerCase();
  const status = String(filters.status || 'all').trim().toLowerCase();
  const matchType = String(filters.matchType || filters.roomMode || 'all').trim().toLowerCase();
  const minSlots = Math.max(0, Math.floor(Number(filters.minAvailableSlots || 0) || 0));

  let out = lobbies.filter((lobby) => {
    if (
      search &&
      !`${lobby.name} ${lobby.roomCode} ${lobby.hostName}`.toLowerCase().includes(search)
    ) {
      return false;
    }
    if ((visibility === 'public' || visibility === 'private') && lobby.visibility !== visibility) {
      return false;
    }
    if (Boolean(filters.humanOnly) && !lobby.humanOnly) return false;
    if (matchType === 'human_only' && !lobby.humanOnly) return false;
    if ((matchType === 'ai_fill' || matchType === 'online_ai_fill') && lobby.humanOnly) return false;
    if (TEAM_MODES.has(teamMode) && lobby.teamMode !== teamMode) return false;
    if (mapId !== 'all' && lobby.mapId !== mapId) return false;
    if (status !== 'all' && lobby.status !== status) return false;
    if (lobby.availableSlots < minSlots) return false;
    return true;
  });

  const sort = String(filters.sort || 'newest').trim().toLowerCase();
  if (sort === 'most_players') {
    out.sort((a, b) => b.currentPlayers - a.currentPlayers || b.createdAt - a.createdAt);
  } else if (sort === 'fewest_players') {
    out.sort((a, b) => a.currentPlayers - b.currentPlayers || b.createdAt - a.createdAt);
  } else if (sort === 'lowest_ping') {
    // All rooms share this server, so missing/equal ping values use the
    // most useful deterministic fallback: fuller, newer lobbies first.
    out.sort(
      (a, b) =>
        Number(a.pingMs ?? Number.POSITIVE_INFINITY) -
          Number(b.pingMs ?? Number.POSITIVE_INFINITY) ||
        b.currentPlayers - a.currentPlayers ||
        b.createdAt - a.createdAt
    );
  } else {
    out.sort((a, b) => b.createdAt - a.createdAt);
  }
  return out;
}

function sendLobbyListToSocket(socket, { requestId = '', filters = {}, updated = false, reason = '' } = {}) {
  if (!socket || socket.destroyed) return;
  const lobbies = applyLobbyListFilters(listDiscoverableLobbies(), filters);
  try {
    socket.write(
      encodeWsFrame({
        type: updated ? 'lobby_list_updated' : 'lobby_list',
        requestId: requestId ? String(requestId) : undefined,
        reason,
        serverTime: Date.now(),
        total: lobbies.length,
        lobbies,
      })
    );
  } catch {
    lobbyDirectorySubscribers.delete(socket);
  }
}

function broadcastLobbyDirectory(reason = 'updated') {
  for (const socket of Array.from(lobbyDirectorySubscribers)) {
    if (socket.destroyed) {
      lobbyDirectorySubscribers.delete(socket);
      continue;
    }
    sendLobbyListToSocket(socket, { updated: true, reason });
  }
}

function queueLobbyDirectoryBroadcast(reason = 'updated') {
  if (lobbyDirectoryBroadcastTimer) return;
  lobbyDirectoryBroadcastTimer = setTimeout(() => {
    lobbyDirectoryBroadcastTimer = null;
    broadcastLobbyDirectory(reason);
  }, 25);
  if (typeof lobbyDirectoryBroadcastTimer.unref === 'function') {
    lobbyDirectoryBroadcastTimer.unref();
  }
}

function canStartLobbyMatch(room) {
  if (!room || room.closed || !isLobbyManagedRoom(room)) return false;
  if (room.hostAccountId && !room.hasHostJoined) return false;
  const eligible = getLobbyEligibleHumans(room);
  if (eligible.length < room.minPlayers) return false;
  if (!eligible.every((player) => player.isReady)) return false;
  if (room.startCondition === 'fill_lobby' && eligible.length < room.maxPlayers) return false;
  return true;
}

function canStartHumanMatch(room) {
  if (!isHumanOnlyMode(room.mode)) return false;
  return canStartLobbyMatch(room);
}

function buildRoomSummary(room) {
  const counts = getRoomCounts(room);
  const humanOnly = isHumanOnlyMode(room.mode);
  const lobby = buildLobbySummary(room);
  return {
    id: room.code,
    roomId: room.code,
    roomCode: room.code,
    name: lobby.name,
    lobbyName: lobby.lobbyName,
    hostName: lobby.hostName,
    hostPlayerId: lobby.hostPlayerId,
    mode: room.mode,
    roomMode: room.mode,
    visibility: room.visibility,
    isPrivate: lobby.isPrivate,
    hasPassword: lobby.hasPassword,
    isListed: Boolean(room.isListed),
    isLobbyManaged: isLobbyManagedRoom(room),
    phase: room.phase,
    status: lobby.status,
    matchStatus: room.phase,
    humanOnly,
    aiFillEnabled: room.mode === 'online_ai_fill',
    // Human-only is always zero. AI Fill reports the server-configured
    // client-spawned AI count separately from verified humans; server room
    // player entries themselves are still humans only.
    botCount: lobby.botCount,
    botDifficulty: lobby.botDifficulty,
    connectedPlayers: counts.connectedHumans,
    connectedHumans: counts.connectedHumans,
    authenticatedHumans: counts.authenticatedHumans,
    readyPlayers: counts.readyHumans,
    readyHumans: counts.readyHumans,
    totalPlayers: counts.totalHumans,
    totalHumans: counts.totalHumans,
    aliveHumans: counts.aliveHumans,
    maxPlayers: room.maxPlayers,
    availableSlots: lobby.availableSlots,
    minPlayers: room.minPlayers,
    mapId: lobby.mapId,
    mapName: lobby.mapName,
    teamMode: lobby.teamMode,
    gameMode: lobby.gameMode,
    startCondition: lobby.startCondition,
    allowLateJoin: lobby.allowLateJoin,
    createdAt: room.createdAt || 0,
    matchParticipantCount: room.matchParticipantIds.size,
    countdownEndsAt: room.countdownEndsAt || 0,
    canStart: canStartLobbyMatch(room),
    canHostStart: canStartLobbyMatch(room),
    winnerId: room.winnerId,
    winnerIds: Array.isArray(room.winnerIds) ? [...room.winnerIds] : [],
    winnerTeamId: room.winnerTeamId || '',
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

function beginLobbyCountdown(room) {
  if (!room || room.phase !== 'lobby' || !canStartLobbyMatch(room)) return false;
  room.phase = 'countdown';
  room.countdownEndsAt = Date.now() + HUMAN_MATCH_COUNTDOWN_MS;
  room.countdownTimer = setTimeout(() => {
    room.countdownTimer = null;
    void startLobbyMatch(room);
  }, HUMAN_MATCH_COUNTDOWN_MS);
  if (typeof room.countdownTimer.unref === 'function') {
    room.countdownTimer.unref();
  }
  broadcastRoomState(room);
  queueLobbyDirectoryBroadcast('match_starting');
  return true;
}

function evaluateLobby(room) {
  if (!isLobbyManagedRoom(room) || room.closed) return;
  ensureRoomHost(room, { broadcast: true });
  refreshProvisionalLobbyTeams(room);

  if (room.phase === 'countdown' && !canStartLobbyMatch(room)) {
    cancelHumanCountdown(room);
    broadcastRoomState(room);
    queueLobbyDirectoryBroadcast('countdown_cancelled');
    return;
  }

  if (room.phase !== 'lobby') return;
  if (room.startCondition === 'host_start') return;
  if (canStartLobbyMatch(room)) beginLobbyCountdown(room);
}

function evaluateHumanLobby(room) {
  evaluateLobby(room);
}

async function startLobbyMatch(room) {
  if (!isLobbyManagedRoom(room) || room.phase !== 'countdown') return;
  if (!canStartLobbyMatch(room)) {
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
  room.propHealth = new Map();
  room.destroyedProps = new Set();
  room.collectedLootIds.clear();
  room.lootReceipts.clear();
  room.spawnedLootItems.clear();
  getLegendaryTowerSwapDrops(room).clear();
  resetRoomLootRegistry(room);
  room.processedHitIds.clear();
  room.hitEventSeq = 0;
  room.lastStormDamageAt = Date.now();
  room.stormDamageInProgress = false;
  room.matchParticipantIds.clear();
  room.placements.clear();
  room.winnerId = null;
  room.winnerIds = [];
  room.winnerTeamId = '';
  room.winnerName = '';
  room.matchEndedAt = 0;

  const participants = getLobbyEligibleHumans(room).filter((player) => player.isReady);
  assignLobbyTeams(room, participants);
  for (const player of getRoomHumanPlayers(room)) {
    const isParticipant = participants.includes(player);
    player.isParticipant = isParticipant;
    player.alive = isParticipant;
    player.health = 100;
    player.shield = 50;
    player.eliminations = 0;
    clearLegendaryTowerWeaponOwnership(player);
    resetServerCombatState(player);
    resetInventory(player);
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
    sendInventoryState(player);
  }
  broadcastToRoom(room, {
    type: 'room_loot_sync',
    roomCode: room.code,
    collectedIds: [],
    spawnedItems: Array.from(room.spawnedLootItems.values()).map((item) =>
      isLegendaryTowerLootId(item.id) ? cloneLegendaryTowerLootItem(item) : item
    ),
  });
  broadcastRoomState(room);
  queueLobbyDirectoryBroadcast('match_started');
}

async function startHumanMatch(room) {
  return startLobbyMatch(room);
}

function closeLobbyRoom(room, reason = 'closed_by_host') {
  if (!room || room.closed) return;
  cancelHumanCountdown(room);
  room.closed = true;
  room.closedAt = Date.now();
  room.closeReason = String(reason || 'closed').slice(0, 64);
  room.phase = 'ended';
  room.countdownEndsAt = 0;
  room.lastActivityAt = Date.now();
  const payload = {
    type: 'room_closed',
    code: 'room_closed',
    reason: 'This lobby has been closed.',
    closeReason: room.closeReason,
    ...buildRoomSummary(room),
  };
  for (const player of getRoomHumanPlayers(room)) {
    if (player.isConnected) sendToPlayer(player, payload);
    player.isConnected = false;
    cancelInventoryAction(player);
    player.isReady = false;
  }
  room.players.clear();
  room.matchParticipantIds.clear();
  room.hostPlayerId = null;
  queueLobbyDirectoryBroadcast('room_closed');
}

function getWinningHumanTeam(room) {
  if (!isHumanOnlyMode(room.mode) || room.phase !== 'active') return null;
  const participants = getRoomHumanPlayers(room).filter((player) => player.isParticipant);
  if (participants.length < room.minPlayers) return null;
  const aliveParticipants = participants.filter((player) => player.alive);
  if (aliveParticipants.length === 0) return null;
  const aliveTeamIds = new Set(
    aliveParticipants.map((player) => player.teamId || `solo_${player.id}`)
  );
  if (aliveTeamIds.size !== 1) return null;
  const [teamId] = Array.from(aliveTeamIds);
  return {
    teamId,
    representative: aliveParticipants[0],
    alivePlayers: aliveParticipants,
    players: participants.filter(
      (player) => (player.teamId || `solo_${player.id}`) === teamId
    ),
  };
}

async function recordTeamPlacementIfEliminated(room, victim, eventType, eventPrefix) {
  if (!victim) return 0;
  const teamId = victim.teamId || `solo_${victim.id}`;
  const participants = getRoomHumanPlayers(room).filter((player) => player.isParticipant);
  const teamMembers = participants.filter(
    (player) => (player.teamId || `solo_${player.id}`) === teamId
  );
  if (teamMembers.length === 0 || teamMembers.some((player) => player.alive)) return 0;

  const aliveTeamIds = new Set(
    participants
      .filter((player) => player.alive)
      .map((player) => player.teamId || `solo_${player.id}`)
  );
  const placement = Math.max(2, aliveTeamIds.size + 1);
  for (const member of teamMembers) {
    room.placements.set(member.id, placement);
    if (member.accountId && member._placementAwardedForMatchSeq !== room.matchSeq) {
      member._placementAwardedForMatchSeq = room.matchSeq;
      const profile = await applyAuthoritativeProgression(member, {
        eventId: `${eventPrefix}_placement_${member.accountId}`,
        roomCode: room.code,
        eventType,
        placement,
        xpDelta: placement <= 3 ? 150 : placement <= 5 ? 75 : 0,
      });
      sendToPlayer(member, { type: 'server_progression', profile });
    }
  }
  return placement;
}

function finishHumanMatch(room, winner) {
  if (!isHumanOnlyMode(room.mode) || room.phase === 'ended') return;
  cancelHumanCountdown(room);
  room.phase = 'ended';
  room.matchEndedAt = Date.now();

  const winningTeam =
    winner && Array.isArray(winner.players)
      ? winner
      : winner
        ? {
            teamId: winner.teamId || `solo_${winner.id}`,
            representative: winner,
            players: getRoomHumanPlayers(room).filter(
              (player) =>
                player.isParticipant &&
                (player.teamId || `solo_${player.id}`) ===
                  (winner.teamId || `solo_${winner.id}`)
            ),
          }
        : null;
  const representative = winningTeam?.representative || winningTeam?.players?.[0] || null;
  room.winnerId = representative?.id || null;
  room.winnerIds = winningTeam ? winningTeam.players.map((player) => player.id) : [];
  room.winnerTeamId = winningTeam?.teamId || '';
  room.winnerName =
    winningTeam && room.teamMode !== 'solo'
      ? `Team ${(representative?.teamIndex ?? 0) + 1}: ${winningTeam.players
          .map((player) => player.name)
          .join(' & ')}`
      : representative?.name || '';
  if (winningTeam) {
    for (const player of winningTeam.players) room.placements.set(player.id, 1);
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
  queueLobbyDirectoryBroadcast('match_ended');
}

function evaluateHumanVictory(room) {
  return getWinningHumanTeam(room)?.representative || null;
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

async function awardHumanWinningTeam(room, winningTeam, eventSuffix) {
  if (!winningTeam) return;
  for (const winner of winningTeam.players) {
    await awardHumanWinner(room, winner, eventSuffix);
  }
}

async function handleHumanForfeit(room, player, reason = 'left_room') {
  if (!isHumanOnlyMode(room.mode) || room.phase !== 'active') return;
  if (!player?.isParticipant || !player.alive) return;

  player.alive = false;
  await recordTeamPlacementIfEliminated(
    room,
    player,
    'forfeit',
    `${room.code}_match_${room.matchSeq}_forfeit_${reason}`
  );

  const winningTeam = getWinningHumanTeam(room);
  if (winningTeam) {
    await awardHumanWinningTeam(room, winningTeam, 'forfeit');
    finishHumanMatch(room, winningTeam);
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
        victim.alive = false;
        await recordTeamPlacementIfEliminated(
          room,
          victim,
          'storm_eliminated',
          eventId
        );
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
        const winningTeam = getWinningHumanTeam(room);
        if (winningTeam) {
          await awardHumanWinningTeam(room, winningTeam, 'storm');
          finishHumanMatch(room, winningTeam);
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
    const hasLobbyConfig = [
      'name',
      'lobbyName',
      'visibility',
      'humanOnly',
      'humanPlayersOnly',
      'maxPlayers',
      'mapId',
      'teamMode',
      'gameMode',
      'botCount',
      'botDifficulty',
      'startCondition',
      'password',
      'allowLateJoin',
    ].some((key) => Object.prototype.hasOwnProperty.call(body, key));

    if (hasLobbyConfig) {
      const resolved = resolveLobbyConfig(body, {
        fallbackMode: 'human_only_public',
      });
      if (!resolved.config) {
        sendJson(res, 400, {
          ok: false,
          code: resolved.code || 'invalid_lobby_config',
          error: resolved.error,
        });
        return;
      }

      let verifiedProfile = null;
      if (body.accountId && body.accountToken) {
        try {
          verifiedProfile = await db.verifyAccountCredentials({
            accountId: String(body.accountId),
            accountToken: String(body.accountToken),
            callsign: body.playerName,
          });
        } catch {
          verifiedProfile = null;
        }
      }
      if (!verifiedProfile?.accountId) {
        sendJson(res, 401, {
          ok: false,
          code: 'authentication_required',
          error: 'Creating a configured lobby requires a verified CI Craft account session.',
        });
        return;
      }

      const duplicateLobby = Array.from(rooms.values()).find(
        (candidate) =>
          !candidate.closed &&
          candidate.phase !== 'ended' &&
          candidate.hostAccountId === verifiedProfile.accountId &&
          (candidate.hasHostJoined || Date.now() - candidate.createdAt < 60_000)
      );
      if (duplicateLobby) {
        sendJson(res, 409, {
          ok: false,
          code: 'duplicate_lobby',
          error: `You already host lobby ${duplicateLobby.code}. Leave or close it before creating another.`,
        });
        return;
      }

      const code = generateUniqueRoomCode(resolved.config.mode);
      const room = getOrCreateRoom(code, resolved.config.mode, resolved.config, {
        accountId: verifiedProfile.accountId,
        name: verifiedProfile.callsign,
      });
      sendJson(res, 200, {
        ok: true,
        exists: true,
        ...buildRoomSummary(room),
        lobby: buildLobbySummary(room),
      });
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
      lobby: buildLobbySummary(room),
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
          !candidate.closed &&
          !candidate.passwordHash &&
          candidate.teamMode === 'solo' &&
          candidate.startCondition === 'all_ready' &&
          candidate.phase === 'lobby' &&
          getRoomCounts(candidate).connectedHumans < candidate.maxPlayers
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

  // 9. Lobby Browser directory (`GET /api/lobbies`). The WebSocket
  // lobby_list messages are the primary live path; this endpoint provides
  // the same server-derived data for fallback polling and diagnostics.
  if (reqUrl.pathname === '/api/lobbies' && req.method === 'GET') {
    if (!checkHttpRateLimit(clientIp, 'lobby_list', 120, 60000)) {
      sendJson(res, 429, { ok: false, error: 'Too many lobby list requests.' });
      return;
    }
    const filters = Object.fromEntries(reqUrl.searchParams.entries());
    if (filters.humanOnly !== undefined) {
      filters.humanOnly = filters.humanOnly === 'true' || filters.humanOnly === '1';
    }
    const lobbies = applyLobbyListFilters(listDiscoverableLobbies(), filters);
    sendJson(res, 200, {
      ok: true,
      serverTime: Date.now(),
      total: lobbies.length,
      maps: Array.from(LOBBY_MAPS.entries()).map(([id, name]) => ({ id, name })),
      lobbies,
    });
    return;
  }

  // 10. Query room status (`GET /api/room`). This summary intentionally
  // contains public room metadata only: no account/session tokens.
  if (reqUrl.pathname === '/api/room' && req.method === 'GET') {
    const code = sanitizeRoomCode(reqUrl.searchParams.get('code') || 'CICRAFT-1');
    const room = rooms.get(code);
    if (room) {
      sendJson(res, 200, {
        ok: true,
        exists: true,
        ...buildRoomSummary(room),
        lobby: buildLobbySummary(room),
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
      availableSlots: ROOM_MAX_HUMANS,
      minPlayers: isHumanOnlyMode(inferredMode) ? HUMAN_ONLY_MIN_PLAYERS : 1,
      mapId: 'ci_island',
      mapName: LOBBY_MAPS.get('ci_island'),
      teamMode: 'solo',
      gameMode: 'solo',
      startCondition: 'all_ready',
      allowLateJoin: inferredMode === 'online_ai_fill',
      createdAt: 0,
      matchParticipantCount: 0,
      countdownEndsAt: 0,
      canStart: false,
      canHostStart: false,
      winnerId: null,
      winnerIds: [],
      winnerTeamId: '',
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
  let failedPasswordAttempts = [];

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
        // A replaced/reconnected seat is controlled only by its current socket.
        if (currentRoom && currentSessionToken && msg.type !== 'join_room' &&
            currentRoom.players.get(currentSessionToken)?.socket !== socket) continue;

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

        if (msg.type === 'chat_send') {
          const player = currentRoom?.players.get(currentSessionToken);
          if (!currentRoom || currentRoom.closed || !player || !player.isConnected ||
              player.isBot || player.socket !== socket ||
              (msg.roomCode !== undefined && msg.roomCode !== currentRoom.code)) {
            socket.write(encodeWsFrame({type:'chat_rejected',code:'not_in_lobby'}));
            continue;
          }
          // Account quota survives a removed pre-match seat or socket replacement.
          const identity = player.accountId ? `account:${player.accountId}` : `session:${player.sessionToken}`;
          if (!allowChatAttempt(identity)) {
            socket.write(encodeWsFrame({type:'chat_rejected',roomCode:currentRoom.code,code:'rate_limited'}));
            continue;
          }
          const text = validateChatText(msg.text);
          if (text === null) {
            socket.write(encodeWsFrame({type:'chat_rejected',roomCode:currentRoom.code,code:'invalid_text'}));
            continue;
          }
          // Plain-text JSON only. Clients render both name and text via textContent,
          // never HTML. No client-selected recipient, sender identity, ID or timestamp.
          broadcastToRoom(currentRoom, {type:'chat_message',roomCode:currentRoom.code,
            id:crypto.randomUUID(),senderId:player.id,senderName:player.name,
            text,sentAt:Date.now()});
          continue;
        }

        if (msg.type === 'ping') {
          socket.write(
            encodeWsFrame({
              type: 'pong',
              serverTime: Date.now(),
              clientTime: Number.isFinite(Number(msg.clientTime))
                ? Number(msg.clientTime)
                : undefined,
            })
          );
          continue;
        }

        if (msg.type === 'lobby_list_subscribe') {
          lobbyDirectorySubscribers.add(socket);
          sendLobbyListToSocket(socket, {
            requestId: msg.requestId,
            filters: msg.filters,
          });
          continue;
        }

        if (msg.type === 'lobby_list_request') {
          sendLobbyListToSocket(socket, {
            requestId: msg.requestId,
            filters: msg.filters,
          });
          continue;
        }

        if (msg.type === 'lobby_list_unsubscribe') {
          lobbyDirectorySubscribers.delete(socket);
          continue;
        }

        if (msg.type === 'create_lobby') {
          const rejectCreate = (code, reason) => {
            socket.write(
              encodeWsFrame({
                type: 'lobby_create_rejected',
                ok: false,
                code,
                reason,
                requestId: msg.requestId ? String(msg.requestId) : undefined,
              })
            );
          };

          if (currentRoom && currentSessionToken) {
            rejectCreate('already_in_room', 'Leave your current lobby before creating another one.');
            continue;
          }

          let verifiedProfile = null;
          if (msg.accountId && msg.accountToken) {
            try {
              verifiedProfile = await db.verifyAccountCredentials({
                accountId: String(msg.accountId),
                accountToken: String(msg.accountToken),
                callsign: msg.playerName,
              });
            } catch {
              verifiedProfile = null;
            }
          }
          const verifiedAccountId = verifiedProfile?.accountId || null;
          if (!verifiedAccountId) {
            rejectCreate(
              'authentication_required',
              'Creating a lobby requires a verified CI Craft account session.'
            );
            continue;
          }

          const duplicateLobby = Array.from(rooms.values()).find(
            (candidate) =>
              !candidate.closed &&
              candidate.phase !== 'ended' &&
              candidate.hostAccountId === verifiedAccountId &&
              (candidate.hasHostJoined || Date.now() - candidate.createdAt < 60_000)
          );
          if (duplicateLobby) {
            rejectCreate(
              'duplicate_lobby',
              `You already host lobby ${duplicateLobby.code}. Leave or close it before creating another.`
            );
            continue;
          }

          const rawConfig =
            msg.config && typeof msg.config === 'object' ? msg.config : msg;
          const resolved = resolveLobbyConfig(
            { ...rawConfig, playerName: msg.playerName },
            { fallbackMode: 'human_only_public' }
          );
          if (!resolved.config) {
            rejectCreate(resolved.code || 'invalid_lobby_config', resolved.error);
            continue;
          }

          const code = generateUniqueRoomCode(resolved.config.mode);
          const room = getOrCreateRoom(code, resolved.config.mode, resolved.config, {
            accountId: verifiedAccountId,
            name: verifiedProfile.callsign,
          });
          socket.write(
            encodeWsFrame({
              type: 'lobby_created',
              ok: true,
              requestId: msg.requestId ? String(msg.requestId) : undefined,
              ...buildRoomSummary(room),
              lobby: buildLobbySummary(room),
            })
          );
          queueLobbyDirectoryBroadcast('lobby_created');
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
          if (room && room.closed) {
            rejectJoin('room_closed', `Room ${roomCode} is closed.`);
            continue;
          }
          if (room && room.mode !== modeResolution.mode) {
            rejectJoin(
              'room_mode_mismatch',
              `Room ${roomCode} is a ${room.mode} room and cannot accept ${modeResolution.mode} sessions.`
            );
            continue;
          }
          if (!room) {
            if (msg.joinIntent === 'join_existing') {
              rejectJoin('room_not_found', `Room ${roomCode} was not found.`);
              continue;
            }
            room = getOrCreateRoom(roomCode, modeResolution.mode);
          }

          const humanOnlyRoom = isHumanOnlyMode(room.mode);
          const lobbyManagedRoom = isLobbyManagedRoom(room);

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

          if (lobbyManagedRoom && !verifiedAccountId) {
            rejectJoin(
              'authentication_required',
              humanOnlyRoom
                ? 'Human-only rooms require a verified CI Craft account session.'
                : 'Lobby Browser rooms require a verified CI Craft account session.'
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
            if (room.passwordHash) {
              const attemptNow = Date.now();
              failedPasswordAttempts = failedPasswordAttempts.filter(
                (attemptAt) => attemptNow - attemptAt < 60_000
              );
              if (failedPasswordAttempts.length >= 5) {
                rejectJoin(
                  'password_rate_limited',
                  'Too many incorrect password attempts. Wait before trying again.'
                );
                continue;
              }
            }
            if (
              verifiedAccountId !== room.hostAccountId &&
              !verifyRoomPassword(room, msg.password ?? msg.roomPassword)
            ) {
              failedPasswordAttempts.push(Date.now());
              rejectJoin(
                'invalid_password',
                'Invalid lobby password. Check the password and try again.'
              );
              continue;
            }
            if (lobbyManagedRoom) {
              const block = getLobbyJoinBlock(room);
              if (!block.canJoin) {
                rejectJoin(block.code, block.reason);
                continue;
              }
            } else if (room.players.size >= room.maxPlayers) {
              rejectJoin('room_full', `Room ${roomCode} is full.`);
              continue;
            }
          }

          currentRoom = room;
          currentSessionToken = requestedSessionToken;

          const cleanCallsign = verifiedProfile?.callsign || sanitizeCallsign(msg.playerName);
          const roomCosmetics = sanitizeCosmetics({
            outfitId: msg.outfitId ?? player?.outfitId,
            skinColor: msg.skinColor ?? player?.skinColor,
            accentColor: msg.accentColor ?? player?.accentColor,
            backAccessory: msg.backAccessory ?? player?.backAccessory,
          });
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
              isReady: !lobbyManagedRoom,
              isParticipant: !lobbyManagedRoom,
              isHost: false,
              teamId: '',
              teamIndex: -1,
              name: cleanCallsign,
              starterLoadout: ['balanced','close_quarters','sharpshooter','demolition'].includes(msg.starterLoadout) ? msg.starterLoadout : 'balanced',
              position: safeSpawnPosition(room,sanitizePosition(msg.position, { x: 0, y: 80, z: 0 })),
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
              lastServerShotAt: 0,
              serverShotTokens: 3,
              serverShotTokenUpdatedAt: Date.now(),
              serverShotCredit: null,
              serverBurstShotsRemaining: 0,
              serverBurstCategory: '',
              serverBurstRarity: '',
              serverNextShotAt: 0,
              legendaryTowerWeaponCategories: new Set(),
              outfitId: roomCosmetics.outfitId,
              skinColor: roomCosmetics.skinColor,
              accentColor: roomCosmetics.accentColor,
              backAccessory: roomCosmetics.backAccessory,
              socket,
            };
            resetInventory(player);
            room.players.set(currentSessionToken, player);
          } else {
            if (player.socket && player.socket !== socket && !player.socket.destroyed) {
              cancelInventoryAction(player);
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
            if (lobbyManagedRoom && !wasConnected && room.phase !== 'active') {
              // A reconnect must explicitly ready-up again before a lobby or
              // countdown can start. The existing seat is not duplicated.
              player.isReady = false;
            }
            player.outfitId = roomCosmetics.outfitId;
            player.skinColor = roomCosmetics.skinColor;
            player.accentColor = roomCosmetics.accentColor;
            player.backAccessory = roomCosmetics.backAccessory;
            if (msg.resetPlayer && !lobbyManagedRoom && !player.alive) {
              isFreshJoinOrReset = true;
              room.matchSeq += 1;
              player.health = 100;
              player.shield = 50;
              player.alive = true;
              player.eliminations = 0;
              clearLegendaryTowerWeaponOwnership(player);
              resetServerCombatState(player);
              resetInventory(player);
              player.position = safeSpawnPosition(room,sanitizePosition(msg.position, player.position));
            } else if (msg.resetPlayer && lobbyManagedRoom && room.phase === 'lobby') {
              player.health = 100;
              player.shield = 50;
              player.alive = true;
              player.eliminations = 0;
              clearLegendaryTowerWeaponOwnership(player);
              resetServerCombatState(player);
              resetInventory(player);
              player.isParticipant = false;
              player.position = safeSpawnPosition(room,sanitizePosition(msg.position, player.position));
            }
            // In an active human-only match, resetPlayer is intentionally
            // ignored: a client cannot revive/reset itself by reconnecting.
            player.socket = socket;
            player.sentInventoryRevision = -1;
          }

          ensureRoomHost(room, { broadcast: true });
          refreshProvisionalLobbyTeams(room);
          lobbyDirectorySubscribers.delete(socket);

          let profile;
          if (lobbyManagedRoom) {
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

          sendInventoryState(player);
          sendToPlayer(player,{type:'position_corrected',position:player.position});


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

          sendToPlayer(player,{type:'environment_state',
            health:[...(room.propHealth || new Map()), ...[...room.buildables.values()].map(b=>[b.buildId,b.health])],
            destroyed:[...(room.destroyedProps || new Set())]});

          // Send authoritative room loot state (opened chests, collected items, dynamically spawned drops)
          if (room.collectedLootIds.size > 0 || room.spawnedLootItems.size > 0) {
            socket.write(
              encodeWsFrame({
                type: 'room_loot_sync',
                collectedIds: Array.from(room.collectedLootIds),
                spawnedItems: Array.from(room.spawnedLootItems.values()).map((item) =>
                  isLegendaryTowerLootId(item.id)
                    ? cloneLegendaryTowerLootItem(item)
                    : item
                ),
              })
            );
          }

          evaluateLobby(room);
          broadcastRoomState(room);
          queueLobbyDirectoryBroadcast('player_joined');
        } else if (msg.type === 'cosmetics_update' && currentRoom && currentSessionToken) {
          const player = currentRoom.players.get(currentSessionToken);
          if (!player || currentRoom.phase === 'ended') continue;
          const now = Date.now();
          if (now - Number(player.lastCosmeticsUpdateAt || 0) < 100) continue;
          player.lastCosmeticsUpdateAt = now;
          const cosmetics = sanitizeCosmetics({
            outfitId: msg.outfitId ?? player.outfitId,
            skinColor: msg.skinColor ?? player.skinColor,
            accentColor: msg.accentColor ?? player.accentColor,
            backAccessory: msg.backAccessory ?? player.backAccessory,
          });
          player.outfitId = cosmetics.outfitId;
          player.skinColor = cosmetics.skinColor;
          player.accentColor = cosmetics.accentColor;
          player.backAccessory = cosmetics.backAccessory;
          currentRoom.lastActivityAt = now;
          broadcastRoomState(currentRoom);
        } else if (msg.type === 'set_ready' && currentRoom && currentSessionToken) {
          const player = currentRoom.players.get(currentSessionToken);
          if (!player) continue;
          if (!isLobbyManagedRoom(currentRoom)) {
            socket.write(
              encodeWsFrame({
                type: 'ready_rejected',
                code: 'lobby_not_managed',
                reason: 'Ready state is only used by Lobby Browser lobbies.',
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
          evaluateLobby(currentRoom);
          broadcastRoomState(currentRoom);
          queueLobbyDirectoryBroadcast('ready_changed');
        } else if (
          msg.type === 'request_match_start' &&
          currentRoom &&
          currentSessionToken
        ) {
          if (!isLobbyManagedRoom(currentRoom)) {
            socket.write(
              encodeWsFrame({
                type: 'match_start_rejected',
                code: 'lobby_not_managed',
                reason: 'This room does not use Lobby Browser match starting.',
              })
            );
            continue;
          }
          const requester = currentRoom.players.get(currentSessionToken);
          ensureRoomHost(currentRoom, { broadcast: true });
          if (!requester || currentRoom.hostPlayerId !== requester.id) {
            socket.write(
              encodeWsFrame({
                type: 'match_start_rejected',
                code: 'host_only',
                reason: 'Only the lobby host can start the match.',
                ...buildRoomSummary(currentRoom),
              })
            );
            continue;
          }
          if (canStartLobbyMatch(currentRoom)) {
            if (currentRoom.phase === 'lobby') beginLobbyCountdown(currentRoom);
          } else {
            const counts = getRoomCounts(currentRoom);
            const fillRequirement =
              currentRoom.startCondition === 'fill_lobby'
                ? ` This lobby must also be full (${counts.connectedHumans}/${currentRoom.maxPlayers}).`
                : '';
            socket.write(
              encodeWsFrame({
                type: 'match_start_rejected',
                code: 'players_not_ready',
                reason: `Waiting for at least ${currentRoom.minPlayers} connected authenticated humans, with every connected human ready. Currently ${counts.readyHumans}/${counts.authenticatedHumans} ready.${fillRequirement}`,
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
        } else if (msg.type === 'close_room' && currentRoom && currentSessionToken) {
          const room = currentRoom;
          const player = room.players.get(currentSessionToken);
          ensureRoomHost(room, { broadcast: true });
          if (!player || room.hostPlayerId !== player.id) {
            socket.write(
              encodeWsFrame({
                type: 'room_close_rejected',
                code: 'host_only',
                reason: 'Only the lobby host can close this lobby.',
                ...buildRoomSummary(room),
              })
            );
            continue;
          }
          if (room.phase === 'active') {
            socket.write(
              encodeWsFrame({
                type: 'room_close_rejected',
                code: 'match_in_progress',
                reason: 'An active match cannot be closed from the lobby.',
                ...buildRoomSummary(room),
              })
            );
            continue;
          }
          closeLobbyRoom(room, 'closed_by_host');
          currentRoom = null;
          currentSessionToken = null;
        } else if (msg.type === 'leave_room' && currentRoom && currentSessionToken) {
          const room = currentRoom;
          const player = room.players.get(currentSessionToken);
          if (player) {
            player.isReady = false;
            player.isConnected = false;
            cancelInventoryAction(player);
            player.disconnectedAt = Date.now();

            if (isHumanOnlyMode(room.mode) && room.phase === 'active') {
              await handleHumanForfeit(room, player, 'left_room');
            }

            // Explicit leave releases the seat entirely. A temporary socket
            // disconnect also releases a pre-start human-only lobby seat;
            // active participants retain theirs until reconnect timeout.
            room.players.delete(currentSessionToken);
            ensureRoomHost(room, { broadcast: true });
            const connectedAfterLeave = getRoomCounts(room).connectedHumans;
            if (
              isLobbyManagedRoom(room) &&
              room.hasHostJoined &&
              connectedAfterLeave === 0 &&
              (room.phase === 'lobby' || room.phase === 'countdown')
            ) {
              closeLobbyRoom(room, 'lobby_empty');
            } else {
              broadcastToRoom(room, {
                type: 'player_left',
                playerId: player.id,
                playerName: player.name,
                ...buildRoomSummary(room),
              });
              evaluateLobby(room);
              broadcastRoomState(room);
            }
            queueLobbyDirectoryBroadcast('player_left');
          }
          currentRoom = null;
          currentSessionToken = null;
        } else if (msg.type === 'player_sync' && currentRoom && currentSessionToken) {
          currentRoom.lastActivityAt = Date.now();
          const p = currentRoom.players.get(currentSessionToken);
          if (
            p &&
            isLobbyManagedRoom(currentRoom) &&
            (currentRoom.phase !== 'active' || !p.isParticipant)
          ) {
            continue;
          }
          if (p) {
            const proposedPosition = sanitizePosition(msg.position, p.position);
            if (isPlayerPositionClear(currentRoom,proposedPosition)) p.position = proposedPosition;
            else sendToPlayer(p,{type:'position_corrected',position:p.position});
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
            // Equipment, reload, ammo and healing are owner-state, never movement metadata.
          }
        } else if (msg.type === 'heal_sync' && currentRoom && currentSessionToken) {
          // Legacy clients cannot author health/shield. Reconcile, never heal.
          const p = currentRoom.players.get(currentSessionToken);
          if (p) sendInventoryState(p);
        } else if (msg.type === 'inventory_action' && currentRoom && currentSessionToken) {
          const p = currentRoom.players.get(currentSessionToken);
          if (!p || !p.alive || (isLobbyManagedRoom(currentRoom) &&
              (currentRoom.phase !== 'active' || !p.isParticipant))) continue;
          const accepted = inventoryAction(p,msg.action,msg.slot,msg.seq);
          sendInventoryState(p, {action:msg.action, accepted});
        } else if (msg.type === 'fire_weapon' && currentRoom && currentSessionToken) {
          const shooter = currentRoom.players.get(currentSessionToken);
          if (!shooter || !shooter.alive) continue;
          if (
            isLobbyManagedRoom(currentRoom) &&
            (currentRoom.phase !== 'active' || !shooter.isParticipant)
          ) {
            continue;
          }
          const category = String(
            msg.category || shooter.equippedCategory || 'assault_rifle'
          ).slice(0, 24);
          const rarity = String(
            msg.rarity || shooter.equippedRarity || 'common'
          ).slice(0, 16);
          const weaponStats = getServerWeaponStats(category, rarity);
          if (!Number.isSafeInteger(msg.shotSeq) || msg.shotSeq <= (shooter.lastInventoryShotSeq || 0)) {
            sendInventoryState(shooter); continue;
          }
          shooter.lastInventoryShotSeq = msg.shotSeq;
          if (!weaponStats) { sendInventoryState(shooter); continue; }
          if (!consumeServerShot(shooter, weaponStats)) { sendInventoryState(shooter); continue; }
          sendInventoryState(shooter);
          const origin = {...shooter.position,y:shooter.position.y+1.2};
          let muzzle = sanitizePosition(msg.muzzlePos,origin);
          if (Math.hypot(muzzle.x-origin.x,muzzle.y-origin.y,muzzle.z-origin.z)>3) muzzle=origin;
          const endpoint = sanitizePosition(msg.hitPoint,{x:origin.x,y:origin.y,z:origin.z-weaponStats.range});
          const rayLength = Math.hypot(endpoint.x-muzzle.x,endpoint.y-muzzle.y,endpoint.z-muzzle.z);
          if (rayLength > weaponStats.range) {
            const fraction=weaponStats.range/rayLength;
            endpoint.x=muzzle.x+(endpoint.x-muzzle.x)*fraction;
            endpoint.y=muzzle.y+(endpoint.y-muzzle.y)*fraction;
            endpoint.z=muzzle.z+(endpoint.z-muzzle.z)*fraction;
          }

          currentRoom.lastActivityAt = Date.now();
          broadcastToRoom(
            currentRoom,
            {
              type: 'remote_weapon_fired',
              shooterId: shooter.id,
              category,
              rarity,
              muzzlePos: muzzle,
              hitPoint: endpoint,
            },
            currentSessionToken
          );
        } else if (msg.type === 'combat_hit' && currentRoom && currentSessionToken) {
          currentRoom.lastActivityAt = Date.now();
          const attacker = currentRoom.players.get(currentSessionToken);
          if (!attacker || !attacker.alive) continue;
          if (
            isLobbyManagedRoom(currentRoom) &&
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
          if (
            currentRoom.teamMode !== 'solo' &&
            attacker.id !== victim.id &&
            attacker.teamId &&
            attacker.teamId === victim.teamId
          ) {
            // Server-enforced friendly-fire protection for Duo/Squad.
            continue;
          }

          if (attacker.id === victim.id) continue;

          const requestedCategory = String(
            msg.weaponCategory || attacker.equippedCategory || ''
          ).slice(0, 24);
          const requestedRarity = String(
            msg.weaponRarity || attacker.equippedRarity || ''
          ).slice(0, 16);
          const weaponStats = getServerWeaponStats(
            requestedCategory,
            requestedRarity
          );
          if (!weaponStats) continue;
          if (!consumeServerHitCredit(attacker, weaponStats)) continue;

          // Category-specific 3D range validation, with a small allowance
          // for the shooter's camera/muzzle origin and 20 Hz position sync.
          const dist = Math.hypot(
            (victim.position?.x || 0) - (attacker.position?.x || 0),
            (victim.position?.y || 0) - (attacker.position?.y || 0),
            (victim.position?.z || 0) - (attacker.position?.z || 0)
          );
          const rangeAllowance = weaponStats.category === 'harvester' ? 1 : 12;
          if (dist > weaponStats.range + rangeAllowance) continue;

          if (!msg.hitPoint || ![msg.hitPoint.x,msg.hitPoint.y,msg.hitPoint.z].every(Number.isFinite)) continue;
          const validatedHitPoint = sanitizePosition(msg.hitPoint, victim.position);
          if (msg.hitPoint && typeof msg.hitPoint === 'object') {
            const hitPointDistance = Math.hypot(
              validatedHitPoint.x - Number(victim.position?.x || 0),
              validatedHitPoint.y - Number(victim.position?.y || 0),
              validatedHitPoint.z - Number(victim.position?.z || 0)
            );
            const height = validatedHitPoint.y-Number(victim.position?.y || 0);
            const horizontal = Math.hypot(validatedHitPoint.x-victim.position.x,validatedHitPoint.z-victim.position.z);
            if (hitPointDistance > 2.4 || horizontal > 1.1 || height < -.15 || height > 2.1) continue;
          }

          if (!hasLineOfSight(currentRoom,{...attacker.position,y:attacker.position.y+1.2},validatedHitPoint)) continue;

          // Derive the headshot from the validated hit height rather than
          // trusting a client flag. The client raycast uses 1.48 m; 1.38 m
          // leaves a small allowance for 20 Hz vertical position sync.
          const isHeadshot =
            validatedHitPoint.y - Number(victim.position?.y || 0) >= 1.38;
          const rawDamage = getServerWeaponDamage(weaponStats, isHeadshot);
          if (rawDamage <= 0) continue;
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

            if (isHumanOnlyMode(currentRoom.mode)) {
              await recordTeamPlacementIfEliminated(
                currentRoom,
                victim,
                'eliminated',
                eventId
              );
              // Human-only victory is evaluated only from authenticated
              // human match participants. No bot participant can exist in
              // this room, and local AI settings have no effect here.
              matchWinner = getWinningHumanTeam(currentRoom);
              if (matchWinner?.players.some((player) => player.id === attacker.id)) {
                winsDelta = 1;
                attackerPlacement = 1;
              }
            } else {
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

              if (
                alivePlayers.length === 1 &&
                alivePlayers[0].id === attacker.id
              ) {
                winsDelta = 1;
                attackerPlacement = 1;
              }
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
            attackerEliminations: attacker.eliminations,
            victimId: victim.id,
            victimName: victim.name,
            damage: rawDamage,
            victimHealth: victim.health,
            victimShield: victim.shield,
            isHeadshot,
            isShieldHit,
            isShieldBreak,
            weaponName: serverWeaponDisplayName(
              weaponStats.category,
              weaponStats.rarity
            ),
            weaponCategory: weaponStats.category,
            weaponRarity: weaponStats.rarity,
            hitPoint: validatedHitPoint,
            eliminated,
          });

          if (matchWinner) {
            for (const winner of matchWinner.players) {
              if (winner.id !== attacker.id) {
                await awardHumanWinner(currentRoom, winner, 'combat');
              }
            }
            finishHumanMatch(currentRoom, matchWinner);
          }
        } else if (msg.type === 'collect_loot' && currentRoom && currentSessionToken) {
          currentRoom.lastActivityAt = Date.now();
          const collector = currentRoom.players.get(currentSessionToken);
          if (!collector || !collector.alive) continue;
          if (
            isLobbyManagedRoom(currentRoom) &&
            (currentRoom.phase !== 'active' || !collector.isParticipant)
          ) {
            socket.write(
              encodeWsFrame({
                type: 'loot_collect_rejected',
                lootId: String(msg.lootId || '').slice(0, 64),
                reason: 'The lobby match has not started.',
              })
            );
            continue;
          }

          const lootId = String(msg.lootId || '').slice(0, 64);
          if (!lootId) continue;

          const previousReceipt = currentRoom.lootReceipts.get(lootId);
          if (previousReceipt?.collectorId === collector.id) {
            // Replay only to its original authenticated seat: no second transfer
            // and no duplicate room broadcast after a transient lost connection.
            sendInventoryState(collector);
            socket.write(encodeWsFrame(previousReceipt));
            continue;
          }
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

          if (
            isLegendaryTowerLootId(lootId) &&
            !LEGENDARY_TOWER_LOOT_BY_ID.has(lootId)
          ) {
            socket.write(
              encodeWsFrame({
                type: 'loot_collect_rejected',
                lootId,
                reason: 'Legendary Tower loot is not server-registered.',
              })
            );
            continue;
          }

          const towerTemplate = LEGENDARY_TOWER_LOOT_BY_ID.get(lootId);
          // Capture any server-registered dynamic drop before it is removed
          // below. Tower ownership transfers only when the separate
          // server-only provenance map also identifies this ID as a swap
          // the server itself broadcast for a proven vault owner.
          const registeredLootItem = currentRoom.spawnedLootItems.get(lootId);
          const collectedTowerSwapCategory =
            !towerTemplate &&
            isLegendaryTowerWeaponItem(registeredLootItem) &&
            getLegendaryTowerSwapDrops(currentRoom).get(lootId) ===
              registeredLootItem.weaponCategory
              ? registeredLootItem.weaponCategory
              : undefined;
          const claim = validateLootClaim(currentRoom, collector, lootId);
          if (!claim.item) {
            socket.write(encodeWsFrame({ type: 'loot_collect_rejected', lootId, reason: claim.reason }));
            continue;
          }
          const authoritativeItem = { ...claim.item, position: { ...claim.item.position }, serverAuthoritative: true };
          const itemType = authoritativeItem.itemType;
          const spawnedDrops = itemType === 'chest' ? getChestRewards(lootId) : undefined;
          if (!canReachLoot(currentRoom,collector,authoritativeItem)) {
            socket.write(encodeWsFrame({type:'loot_collect_rejected',lootId,reason:'Interaction blocked by geometry.'}));
            continue;
          }
          authoritativeItem.towerProvenance = Boolean(towerTemplate || collectedTowerSwapCategory || claim.item.towerProvenance);
          const proposedId = String(msg.swappedDrop?.id || '');
          const dropId = /^swap_[A-Za-z0-9_-]{1,58}$/.test(proposedId) &&
            !currentRoom.spawnedLootItems.has(proposedId) && !currentRoom.collectedLootIds.has(proposedId)
              ? proposedId : `swap_${crypto.randomBytes(12).toString('hex')}`;
          const transfer = collectInventory(collector,authoritativeItem,msg.slot,dropId);
          if (transfer.reason) {
            socket.write(encodeWsFrame({type:'loot_collect_rejected',lootId,reason:transfer.reason}));
            sendInventoryState(collector); continue;
          }
          const swappedDrop = transfer.dropped;
          // All mutation is synchronous before broadcasting: simultaneous claims
          // can award this registered object to exactly one human.
          currentRoom.collectedLootIds.add(lootId);
          currentRoom.spawnedLootItems.delete(lootId);
          getLegendaryTowerSwapDrops(currentRoom).delete(lootId);
          sendInventoryState(collector);

          // Transfer the unique-weapon ledger exactly once for this
          // accepted collection: dropping a proven tower weapon consumes
          // the old entry, while claiming a vault item or registered swap
          // drop grants the new one. Rejected/forged claims never reach
          // this point, and a consumed entry cannot authorize a second
          // broadcast of the same category.
          const towerWeaponOwnership = getLegendaryTowerWeaponOwnership(collector);
          if (swappedDrop?.towerProvenance && isLegendaryTowerWeaponItem(swappedDrop)) {
            towerWeaponOwnership.delete(swappedDrop.weaponCategory);
          }
          if (isLegendaryTowerWeaponItem(towerTemplate)) {
            towerWeaponOwnership.add(towerTemplate.weaponCategory);
          } else if (collectedTowerSwapCategory) {
            towerWeaponOwnership.add(collectedTowerSwapCategory);
          }

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
            if (swappedDrop?.towerProvenance && isLegendaryTowerWeaponItem(swappedDrop)) {
              getLegendaryTowerSwapDrops(currentRoom).set(
                String(swappedDrop.id),
                swappedDrop.weaponCategory
              );
            }
          }

          const receipt = {
            type: 'loot_collected',
            collectorId: collector.id,
            lootId,
            itemType,
            spawnedDrops,
            swappedDrop,
            authoritative: Boolean(authoritativeItem),
            authoritativeItem,
          };
          currentRoom.lootReceipts.set(lootId, receipt);
          broadcastToRoom(currentRoom, receipt);
        } else if (msg.type === 'place_build' && currentRoom && currentSessionToken) {
          const builder = currentRoom.players.get(currentSessionToken);
          if (!builder || !builder.alive) continue;
          if (
            isLobbyManagedRoom(currentRoom) &&
            (currentRoom.phase !== 'active' || !builder.isParticipant)
          ) {
            continue;
          }
          currentRoom.lastActivityAt = Date.now();
          const buildId = String(msg.buildId || '');
          const pieceType = String(msg.pieceType || '');
          const material = String(msg.material || '');
          if (!/^build_[A-Za-z0-9_-]{1,58}$/.test(buildId) || currentRoom.buildables.has(buildId) || currentRoom.destroyedProps?.has(buildId) ||
              currentRoom.buildables.size >= 600 || !['wall','ramp','floor','roof'].includes(pieceType) ||
              !['wood','stone','metal'].includes(material) || builder.materials[material] < 10 ||
              ![msg.x,msg.y,msg.z,msg.yaw].every(Number.isFinite) ||
              Math.hypot(msg.x-builder.position.x,msg.y-builder.position.y,msg.z-builder.position.z)>6) {
            sendInventoryState(builder); continue;
          }
          const transform = buildTransform(msg);
          if (!transform || transform.y < -.5 || [...currentRoom.buildables.values()].some(b=>buildTransform(b)?.cell===transform.cell)) {
            sendInventoryState(builder); continue;
          }
          builder.materials[material] -= 10;
          builder.inventoryRevision++; sendInventoryState(builder);
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
          broadcastToRoom(currentRoom, buildPacket);
        } else if (msg.type === 'damage_build' && currentRoom && currentSessionToken) {
          const damager = currentRoom.players.get(currentSessionToken);
          if (!damager || !damager.alive) continue;
          if (
            isLobbyManagedRoom(currentRoom) &&
            (currentRoom.phase !== 'active' || !damager.isParticipant)
          ) {
            continue;
          }
          currentRoom.lastActivityAt = Date.now();
          const buildId = String(msg.destructibleId || '').slice(0, 64);
          const stats = getServerWeaponStats(damager.equippedCategory,damager.equippedRarity);
          const existingBuild = currentRoom.buildables.get(buildId);
          const prop = worldProps.get(buildId);
          const placed = existingBuild ? buildTransform(existingBuild) : null;
          const target = placed ? {x:placed.x,y:placed.y+1,z:placed.z} : prop?.position;
          if (!stats || !target || currentRoom.destroyedProps?.has(buildId) ||
              Math.hypot(target.x-damager.position.x,target.y-damager.position.y,target.z-damager.position.z)>stats.range+3 ||
              !hasLineOfSight(currentRoom,{...damager.position,y:damager.position.y+1.2},target,buildId) ||
              !consumeServerHitCredit(damager,stats)) continue;
          const dmg = Math.round(stats.baseDamage*(stats.category === 'harvester'?1.5:.7));
          currentRoom.propHealth ??= new Map(); currentRoom.destroyedProps ??= new Set();
          const remaining = (existingBuild?.health ?? currentRoom.propHealth.get(buildId) ?? prop.health)-dmg;
          if (existingBuild) existingBuild.health = remaining;
          else currentRoom.propHealth.set(buildId,remaining);
          if (remaining <= 0) { currentRoom.buildables.delete(buildId); currentRoom.destroyedProps.add(buildId); }
          // Player-built pieces cost 10: awarding 12 per swing would mint materials.
          const gain = existingBuild ? 0 : stats.category === 'harvester'?12:remaining<=0?8:0;
          const material = existingBuild?.material || prop.material;
          damager.materials[material] = Math.min(999,damager.materials[material]+gain);
          damager.inventoryRevision++; sendInventoryState(damager);
          broadcastToRoom(
            currentRoom,
            {
              type: 'build_damaged',
              destructibleId: buildId,
              damage: dmg,
            }
          );
        }
      } catch {
        // Ignore malformed JSON
      }
    }
  });

  socket.on('close', () => {
    lobbyDirectorySubscribers.delete(socket);
    if (currentRoom && currentSessionToken) {
      const room = currentRoom;
      const p = room.players.get(currentSessionToken);
      let removedLobbyPlayer = null;
      if (p && p.socket === socket) {
        p.isConnected = false;
        cancelInventoryAction(p);
        p.disconnectedAt = Date.now();
        if (
          isLobbyManagedRoom(room) &&
          (room.phase === 'lobby' || room.phase === 'countdown')
        ) {
          // A pre-start disconnect removes the human from the lobby entirely.
          // If the same authenticated account reconnects, it receives one
          // fresh, unready seat rather than a duplicate roster entry.
          p.isReady = false;
          room.players.delete(currentSessionToken);
          removedLobbyPlayer = p;
        }
      }

      ensureRoomHost(room, { broadcast: true });
      const connectedAfterDisconnect = getRoomCounts(room).connectedHumans;
      if (
        isLobbyManagedRoom(room) &&
        room.hasHostJoined &&
        connectedAfterDisconnect === 0 &&
        (room.phase === 'lobby' || room.phase === 'countdown')
      ) {
        closeLobbyRoom(room, 'lobby_empty');
        return;
      }

      if (removedLobbyPlayer) {
        broadcastToRoom(room, {
          type: 'player_left',
          playerId: removedLobbyPlayer.id,
          playerName: removedLobbyPlayer.name,
          ...buildRoomSummary(room),
        });
      }
      evaluateLobby(room);
      broadcastRoomState(room);
      queueLobbyDirectoryBroadcast('player_disconnected');
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
  advanceServerStorm(room.storm, dt);
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
      isHost: Boolean(room.hostPlayerId && room.hostPlayerId === p.id),
      teamId: p.teamId || '',
      teamIndex: Number.isFinite(Number(p.teamIndex)) ? Number(p.teamIndex) : -1,
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
      outfitId: sanitizeCosmetics(p).outfitId,
      skinColor: p.skinColor ?? 0x0284c7,
      accentColor: p.accentColor ?? 0x38bdf8,
      backAccessory: p.backAccessory || 'jump_pack',
    };
  });
}

function sendInventoryState(player, result) {
  if (!player.inventory) return;
  sendToPlayer(player, {type:'inventory_state', ...inventorySnapshot(player), result});
  player.sentInventoryRevision = player.inventoryRevision;
}

function broadcastRoomState(room) {
  for (const p of room.players.values()) {
    if (!p.inventory) resetInventory(p);
    if (p.inventoryTask && room.phase !== 'active' && isLobbyManagedRoom(room)) cancelInventoryAction(p);
    else advanceInventory(p);
    if (p.isConnected && p.sentInventoryRevision !== p.inventoryRevision) sendInventoryState(p);
  }
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

  let directoryChanged = false;
  for (const [code, room] of rooms.entries()) {
    if (room.closed) {
      if (now - Math.max(room.closedAt || 0, room.lastActivityAt || 0) > CLOSED_ROOM_TTL_MS) {
        rooms.delete(code);
        directoryChanged = true;
      }
      continue;
    }

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
      ensureRoomHost(room, { broadcast: true });
      evaluateLobby(room);
      if (connectedCount > 0) broadcastRoomState(room);
      directoryChanged = true;
    }

    if (
      isLobbyManagedRoom(room) &&
      (room.phase === 'lobby' || room.phase === 'countdown') &&
      now - room.lastActivityAt > LOBBY_IDLE_TTL_MS
    ) {
      closeLobbyRoom(room, 'lobby_idle');
      directoryChanged = true;
      continue;
    }

    if (
      room.phase === 'ended' &&
      room.matchEndedAt > 0 &&
      now - room.matchEndedAt > LOBBY_IDLE_TTL_MS
    ) {
      closeLobbyRoom(room, 'match_ended_expired');
      directoryChanged = true;
      continue;
    }

    if (connectedCount === 0 && now - room.lastActivityAt > 180_000) {
      // An empty lobby that was only reserved over HTTP expires here. A
      // populated lobby whose last human disconnects is closed immediately
      // by the leave/disconnect paths, so it does not linger as joinable.
      if (isLobbyManagedRoom(room) && room.hasHostJoined) {
        closeLobbyRoom(room, 'lobby_empty');
      } else {
        cancelHumanCountdown(room);
        rooms.delete(code);
      }
      directoryChanged = true;
    }
  }
  if (directoryChanged) queueLobbyDirectoryBroadcast('cleanup');
}, 30_000);

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[CI Craft Multiplayer] Received ${signal}, shutting down gracefully...`);
  clearInterval(roomTickInterval);
  clearInterval(cleanupInterval);
  if (lobbyDirectoryBroadcastTimer) {
    clearTimeout(lobbyDirectoryBroadcastTimer);
    lobbyDirectoryBroadcastTimer = null;
  }
  for (const socket of lobbyDirectorySubscribers) {
    if (!socket.destroyed) {
      try {
        socket.write(encodeWsFrame({ type: 'server_restarting', retryMs: 2000 }));
        socket.end();
      } catch {
        // Ignore
      }
    }
  }
  lobbyDirectorySubscribers.clear();

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
