/**
 * CI Craft 2.8 — Durable Server-Side Persistence & Account Identity Layer
 *
 * Supports:
 * 1. Production PostgreSQL (`DATABASE_URL`) via `pg.Pool` (Render, Railway, Fly.io, Supabase, Neon)
 * 2. Durable On-Disk SQLite (`node:sqlite` `DatabaseSync` with WAL mode at `data/cicraft.sqlite`)
 *    when `DATABASE_URL` is not configured, ensuring accounts & progression survive server restarts.
 * 3. Cryptographic Account Identity (`accountId` + HMAC-signed `accountToken` + Cross-Device Passkey)
 *    with SHA-256 hashed credentials and timing-safe verification.
 * 4. Idempotent schema migrations, input validation, and duplicate-reward protection (`verified_match_events`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// NOTE: `node:sqlite` is loaded lazily inside `PersistenceManager.init()`.
// A static import would crash the process before PostgreSQL mode can even
// start on any Node build where the (still experimental) built-in SQLite
// module is unavailable, even though SQLite is only used for local dev.

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

export const XP_PER_LEVEL = 1000;

export const VALID_OUTFIT_IDS = new Set([
  'vanguard_blue',
  'solar_phoenix',
  'neon_phantom',
  'emerald_ranger',
  'arctic_sentinel',
  'crimson_striker',
]);

export const VALID_BACK_ACCESSORIES = new Set([
  'jump_pack',
  'energy_wings',
  'tactical_shield',
  'none',
]);

export const DEFAULT_COSMETICS = {
  outfitId: 'vanguard_blue',
  skinColor: 0x0284c7,
  accentColor: 0x38bdf8,
  backAccessory: 'jump_pack',
};

export function computeLevelFromXp(xp) {
  return Math.max(1, Math.floor(Math.max(0, Number(xp) || 0) / XP_PER_LEVEL) + 1);
}

export function computeUnlockedOutfitsForLevel(level) {
  const unlocked = ['vanguard_blue', 'emerald_ranger'];
  if (level >= 2) unlocked.push('solar_phoenix');
  if (level >= 3) unlocked.push('arctic_sentinel');
  if (level >= 5) unlocked.push('neon_phantom');
  if (level >= 8) unlocked.push('crimson_striker');
  return unlocked;
}

export function sanitizeCallsign(raw) {
  if (typeof raw !== 'string') return 'Commander_CI';
  const cleaned = raw.replace(/[^A-Za-z0-9_ -]/g, '').trim().slice(0, 18);
  return cleaned.length >= 2 ? cleaned : 'Commander_CI';
}

export function sanitizeCosmetics(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_COSMETICS };
  const outfitId = VALID_OUTFIT_IDS.has(raw.outfitId)
    ? raw.outfitId
    : DEFAULT_COSMETICS.outfitId;
  const skinColor =
    typeof raw.skinColor === 'number' &&
    Number.isInteger(raw.skinColor) &&
    raw.skinColor >= 0 &&
    raw.skinColor <= 0xffffff
      ? raw.skinColor
      : DEFAULT_COSMETICS.skinColor;
  const accentColor =
    typeof raw.accentColor === 'number' &&
    Number.isInteger(raw.accentColor) &&
    raw.accentColor >= 0 &&
    raw.accentColor <= 0xffffff
      ? raw.accentColor
      : DEFAULT_COSMETICS.accentColor;
  const backAccessory = VALID_BACK_ACCESSORIES.has(raw.backAccessory)
    ? raw.backAccessory
    : DEFAULT_COSMETICS.backAccessory;
  return { outfitId, skinColor, accentColor, backAccessory };
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timingSafeHexEqual(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  if (hexA.length !== hexB.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hexA, 'hex'), Buffer.from(hexB, 'hex'));
  } catch {
    return false;
  }
}

function loadOrCreateServerSecret() {
  if (process.env.ACCOUNT_TOKEN_SECRET && process.env.ACCOUNT_TOKEN_SECRET.length >= 16) {
    return process.env.ACCOUNT_TOKEN_SECRET;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const secretFile = path.join(DATA_DIR, '.server_secret');
  try {
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
  } catch {
    // Fall through to generate
  }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  } catch {
    // Ignore write failure in read-only fs
  }
  return generated;
}

/**
 * Decide the `pg` SSL configuration for a `DATABASE_URL`.
 *
 * Rules (in priority order):
 * 1. An explicit `sslmode` in the URL (or `PGSSLMODE` in the environment) wins:
 *    `disable` -> no TLS; `require`/`prefer`/`verify-ca`/`verify-full` -> TLS with
 *    `rejectUnauthorized: false`. Render Postgres uses certificates that cannot be
 *    verified with `verify-ca`/`verify-full` on internal connections (self-signed),
 *    and node-postgres treats `sslmode=require` in the URL as `verify-full`, so the
 *    mode is translated to an explicit `ssl` object instead (see rule 3).
 * 2. With no explicit mode: loopback and private/internal hostnames (Render's
 *    `dpg-...` internal hostnames, `*.internal`, docker service names — i.e. hosts
 *    reachable only over the platform's private network) use plaintext, which is
 *    what Render/Railway internal database URLs expect. Public hostnames (external
 *    Render/Neon/Supabase URLs, ...) use TLS with `rejectUnauthorized: false`.
 * 3. SSL parameters are stripped from the returned connection string: if any of
 *    `sslmode`/`sslcert`/`sslkey`/`sslrootcert` are present in the URL,
 *    node-postgres ignores the explicit `ssl` config object entirely.
 *
 * @param {string} databaseUrl
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ connectionString: string, ssl: false | { rejectUnauthorized: false } }}
 */
export function resolvePgConnectionConfig(databaseUrl, env = process.env) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    // Unparseable URL: hand it to `pg` unchanged with the historically safe default.
    return { connectionString: databaseUrl, ssl: { rejectUnauthorized: false } };
  }

  const sslMode = (
    env.PGSSLMODE ||
    parsed.searchParams.get('sslmode') ||
    ''
  ).toLowerCase();

  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const isInternalHost =
    !host.includes('.') || host.endsWith('.internal') || host.endsWith('.local');

  let ssl;
  if (sslMode === 'disable') {
    ssl = false;
  } else if (
    sslMode === 'require' ||
    sslMode === 'prefer' ||
    sslMode === 'verify-ca' ||
    sslMode === 'verify-full'
  ) {
    ssl = { rejectUnauthorized: false };
  } else if (isLoopback || isInternalHost) {
    ssl = false;
  } else {
    ssl = { rejectUnauthorized: false };
  }

  for (const param of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) {
    parsed.searchParams.delete(param);
  }

  return { connectionString: parsed.toString(), ssl };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PersistenceManager {
  constructor(options = {}) {
    this.databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? '';
    this.sqlitePath =
      options.sqlitePath ??
      process.env.SQLITE_DB_PATH ??
      path.join(DATA_DIR, 'cicraft.sqlite');
    // PostgreSQL startup retries: managed databases (Render/Railway) can take a
    // few seconds to accept connections when the web service boots.
    this.connectRetries = Math.max(
      1,
      Math.floor(
        Number(options.connectRetries ?? process.env.DATABASE_CONNECT_RETRIES ?? 5) || 5
      )
    );
    this.retryBaseDelayMs = Math.max(
      0,
      Number(options.retryBaseDelayMs ?? process.env.DATABASE_RETRY_DELAY_MS ?? 1000) || 0
    );
    // When DATABASE_URL is configured, silently falling back to on-disk SQLite
    // would lose account persistence on ephemeral hosts (Render/Railway), so it
    // is opt-in only via `DATABASE_FALLBACK_SQLITE=1`.
    this.allowSqliteFallback =
      options.allowSqliteFallback ??
      (process.env.DATABASE_FALLBACK_SQLITE === '1' ||
        process.env.DATABASE_FALLBACK_SQLITE === 'true');
    this.secret = loadOrCreateServerSecret();
    this.backend = 'uninitialized';
    /** @type {import('pg').Pool | null} */
    this.pgPool = null;
    /** @type {import('node:sqlite').DatabaseSync | null} */
    this.sqliteDb = null;
    this.isConnected = false;
    this.lastError = null;
  }

  async init() {
    if (this.databaseUrl) {
      let lastErr = null;
      for (let attempt = 1; attempt <= this.connectRetries; attempt++) {
        try {
          const { connectionString, ssl } = resolvePgConnectionConfig(this.databaseUrl);
          this.pgPool = new Pool({
            connectionString,
            max: Number(process.env.PG_POOL_MAX || 10),
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 8000,
            ssl,
          });
          // An idle-client error without a listener would crash the process;
          // log it instead (the pool discards the broken client).
          this.pgPool.on('error', (err) => {
            this.lastError = err instanceof Error ? err.message : String(err);
            console.error(`[CI Craft DB] PostgreSQL pool error: ${this.lastError}`);
          });
          await this.pgPool.query('SELECT 1');
          this.backend = 'postgresql';
          // Migrations run here, at server startup — never during the Docker/
          // platform image build, where the private DATABASE_URL host is
          // unreachable (e.g. Render's internal connection string).
          await this.runMigrations();
          this.isConnected = true;
          this.lastError = null;
          console.log('[CI Craft DB] Connected to PostgreSQL database and verified schema.');
          return;
        } catch (err) {
          lastErr = err;
          this.lastError = err instanceof Error ? err.message : String(err);
          if (this.pgPool) {
            await this.pgPool.end().catch(() => {});
            this.pgPool = null;
          }
          this.backend = 'uninitialized';
          if (attempt < this.connectRetries) {
            const delayMs = Math.min(this.retryBaseDelayMs * 2 ** (attempt - 1), 8000);
            console.warn(
              `[CI Craft DB] PostgreSQL connection attempt ${attempt}/${this.connectRetries} failed (${this.lastError}); retrying in ${delayMs}ms...`
            );
            await sleep(delayMs);
          }
        }
      }

      if (!this.allowSqliteFallback) {
        throw new Error(
          `Failed to connect to PostgreSQL via DATABASE_URL after ${this.connectRetries} attempt(s): ${this.lastError}. ` +
            'Refusing to silently fall back to ephemeral SQLite (set DATABASE_FALLBACK_SQLITE=1 to allow it).',
          { cause: lastErr }
        );
      }
      console.warn(
        `[CI Craft DB] PostgreSQL unavailable (${this.lastError}); DATABASE_FALLBACK_SQLITE is set, falling back to on-disk SQLite.`
      );
    }

    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import('node:sqlite'));
    } catch (err) {
      throw new Error(
        'The built-in node:sqlite module is unavailable in this Node.js runtime. ' +
          'Use Node.js 22.14.0 (see .node-version) for local SQLite development, or set DATABASE_URL to use PostgreSQL.',
        { cause: err }
      );
    }

    fs.mkdirSync(path.dirname(this.sqlitePath), { recursive: true });
    this.sqliteDb = new DatabaseSync(this.sqlitePath);
    this.sqliteDb.exec('PRAGMA journal_mode = WAL;');
    this.sqliteDb.exec('PRAGMA synchronous = NORMAL;');
    this.sqliteDb.exec('PRAGMA busy_timeout = 5000;');
    this.backend = 'sqlite';
    await this.runMigrations();
    this.isConnected = true;
    console.log(`[CI Craft DB] Durable SQLite database ready at ${this.sqlitePath}`);
  }

  async runMigrations() {
    const createMigrationsSql = `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at BIGINT NOT NULL
      );
    `;
    const createAccountsSql = `
      CREATE TABLE IF NOT EXISTS player_accounts (
        account_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        recovery_code_hash TEXT NOT NULL,
        callsign TEXT NOT NULL DEFAULT 'Commander_CI',
        xp INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 1,
        matches_played INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        eliminations INTEGER NOT NULL DEFAULT 0,
        damage_dealt INTEGER NOT NULL DEFAULT 0,
        best_placement INTEGER NOT NULL DEFAULT 0,
        cosmetics_json TEXT NOT NULL,
        unlocked_outfits_json TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `;
    const createEventsSql = `
      CREATE TABLE IF NOT EXISTS verified_match_events (
        event_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        room_code TEXT NOT NULL,
        event_type TEXT NOT NULL,
        xp_delta INTEGER NOT NULL,
        created_at BIGINT NOT NULL
      );
    `;

    if (this.backend === 'postgresql' && this.pgPool) {
      // Serialize concurrent startup migrations across instances/restarts:
      // `CREATE TABLE IF NOT EXISTS` alone can still race in PostgreSQL.
      const client = await this.pgPool.connect();
      try {
        await client.query('SELECT pg_advisory_lock($1)', [727_001]);
        await client.query(createMigrationsSql);
        await client.query(createAccountsSql);
        await client.query(createEventsSql);
        await client.query(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES (1, 'v2_8_initial_accounts_and_events', $1)
           ON CONFLICT (version) DO NOTHING`,
          [Date.now()]
        );
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [727_001]).catch(() => {});
        client.release();
      }
    } else if (this.sqliteDb) {
      this.sqliteDb.exec(createMigrationsSql);
      this.sqliteDb.exec(createAccountsSql);
      this.sqliteDb.exec(createEventsSql);
      const stmt = this.sqliteDb.prepare(
        `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`
      );
      stmt.run(1, 'v2_8_initial_accounts_and_events', Date.now());
    }
  }

  signAccountToken(accountId, nonce) {
    const payload = `${accountId}.${nonce}`;
    const sig = crypto
      .createHmac('sha256', this.secret)
      .update(payload)
      .digest('base64url');
    return `${payload}.${sig}`;
  }

  verifySignedTokenFormat(accountId, accountToken) {
    if (typeof accountId !== 'string' || typeof accountToken !== 'string') return false;
    const parts = accountToken.split('.');
    if (parts.length !== 3) return false;
    const [tokenAccId, nonce, providedSig] = parts;
    if (tokenAccId !== accountId || !nonce || !providedSig) return false;
    const expectedSig = crypto
      .createHmac('sha256', this.secret)
      .update(`${tokenAccId}.${nonce}`)
      .digest('base64url');
    if (providedSig.length !== expectedSig.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(providedSig, 'utf8'),
      Buffer.from(expectedSig, 'utf8')
    );
  }

  generateRecoverySecret() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const bytes = crypto.randomBytes(12);
    let out = '';
    for (let i = 0; i < 12; i++) {
      if (i > 0 && i % 4 === 0) out += '-';
      out += chars[bytes[i] % chars.length];
    }
    return out;
  }

  rowToProfile(row) {
    if (!row) return null;
    let cosmetics = { ...DEFAULT_COSMETICS };
    try {
      cosmetics = sanitizeCosmetics(JSON.parse(row.cosmetics_json || '{}'));
    } catch {
      cosmetics = { ...DEFAULT_COSMETICS };
    }
    const xp = Math.max(0, Number(row.xp || 0));
    const level = computeLevelFromXp(xp);
    let unlockedOutfits = computeUnlockedOutfitsForLevel(level);
    try {
      const parsedUnlocks = JSON.parse(row.unlocked_outfits_json || '[]');
      if (Array.isArray(parsedUnlocks)) {
        for (const id of parsedUnlocks) {
          if (VALID_OUTFIT_IDS.has(id) && !unlockedOutfits.includes(id)) {
            unlockedOutfits.push(id);
          }
        }
      }
    } catch {
      // Ignore parse error
    }

    return {
      accountId: String(row.account_id),
      callsign: sanitizeCallsign(row.callsign),
      matchesPlayed: Math.max(0, Number(row.matches_played || 0)),
      wins: Math.max(0, Number(row.wins || 0)),
      eliminations: Math.max(0, Number(row.eliminations || 0)),
      damageDealt: Math.max(0, Number(row.damage_dealt || 0)),
      bestPlacement: Math.max(0, Number(row.best_placement || 0)),
      xp,
      level,
      cosmetics,
      unlockedOutfits,
      storageMode: 'server_verified',
      persistenceBackend: this.backend,
    };
  }

  async getAccountRow(accountId) {
    if (!accountId || typeof accountId !== 'string') return null;
    if (this.backend === 'postgresql' && this.pgPool) {
      const res = await this.pgPool.query(
        'SELECT * FROM player_accounts WHERE account_id = $1 LIMIT 1',
        [accountId]
      );
      return res.rows[0] || null;
    }
    if (this.sqliteDb) {
      const stmt = this.sqliteDb.prepare(
        'SELECT * FROM player_accounts WHERE account_id = ? LIMIT 1'
      );
      return stmt.get(accountId) || null;
    }
    return null;
  }

  /**
   * Verify an existing account credential pair without creating or replacing
   * an account. Human-only multiplayer uses this stricter path so that a
   * missing/forged token can never be converted into an authenticated seat.
   * Returns the persisted profile, or null when credentials are invalid.
   */
  async verifyAccountCredentials({ accountId, accountToken, callsign }) {
    if (!accountId || !accountToken) return null;
    if (!this.verifySignedTokenFormat(accountId, accountToken)) return null;

    const existing = await this.getAccountRow(accountId);
    if (!existing) return null;
    if (!timingSafeHexEqual(existing.token_hash, sha256Hex(accountToken))) {
      return null;
    }

    if (callsign) {
      const cleanCallsign = sanitizeCallsign(callsign);
      if (cleanCallsign !== existing.callsign) {
        return this.updateAccountCosmetics(accountId, undefined, cleanCallsign);
      }
    }

    return this.rowToProfile(existing);
  }

  async createOrVerifyAccount({ accountId, accountToken, callsign, cosmetics }) {
    const cleanCallsign = sanitizeCallsign(callsign);

    if (accountId && accountToken && this.verifySignedTokenFormat(accountId, accountToken)) {
      const existing = await this.getAccountRow(accountId);
      if (existing && timingSafeHexEqual(existing.token_hash, sha256Hex(accountToken))) {
        if (callsign && cleanCallsign !== existing.callsign) {
          await this.updateAccountCosmetics(accountId, undefined, cleanCallsign);
          existing.callsign = cleanCallsign;
        }
        return {
          isNew: false,
          accountId: existing.account_id,
          accountToken,
          passkey: null,
          profile: this.rowToProfile(existing),
        };
      }
    }

    const newAccountId = `acc_${crypto.randomBytes(6).toString('hex')}`;
    const nonce = crypto.randomBytes(12).toString('base64url');
    const newAccountToken = this.signAccountToken(newAccountId, nonce);
    const recoverySecret = this.generateRecoverySecret();
    const passkey = `${newAccountId}:${recoverySecret}`;

    const tokenHash = sha256Hex(newAccountToken);
    const recoveryHash = sha256Hex(recoverySecret);
    const cleanCosmetics = sanitizeCosmetics(cosmetics);
    const unlockedOutfits = computeUnlockedOutfitsForLevel(1);
    const now = Date.now();

    if (this.backend === 'postgresql' && this.pgPool) {
      await this.pgPool.query(
        `INSERT INTO player_accounts (
          account_id, token_hash, recovery_code_hash, callsign,
          xp, level, matches_played, wins, eliminations, damage_dealt, best_placement,
          cosmetics_json, unlocked_outfits_json, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,0,1,0,0,0,0,0,$5,$6,$7,$8)`,
        [
          newAccountId,
          tokenHash,
          recoveryHash,
          cleanCallsign,
          JSON.stringify(cleanCosmetics),
          JSON.stringify(unlockedOutfits),
          now,
          now,
        ]
      );
    } else if (this.sqliteDb) {
      const stmt = this.sqliteDb.prepare(
        `INSERT INTO player_accounts (
          account_id, token_hash, recovery_code_hash, callsign,
          xp, level, matches_played, wins, eliminations, damage_dealt, best_placement,
          cosmetics_json, unlocked_outfits_json, created_at, updated_at
        ) VALUES (?,?,?,?,0,1,0,0,0,0,0,?,?,?,?)`
      );
      stmt.run(
        newAccountId,
        tokenHash,
        recoveryHash,
        cleanCallsign,
        JSON.stringify(cleanCosmetics),
        JSON.stringify(unlockedOutfits),
        now,
        now
      );
    }

    const createdRow = await this.getAccountRow(newAccountId);
    return {
      isNew: true,
      accountId: newAccountId,
      accountToken: newAccountToken,
      passkey,
      profile: this.rowToProfile(createdRow),
    };
  }

  async restoreAccountByPasskey(rawPasskey) {
    if (typeof rawPasskey !== 'string') {
      return { ok: false, error: 'Passkey is required.' };
    }
    const trimmed = rawPasskey.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) {
      return {
        ok: false,
        error: 'Invalid Passkey format. Expected acc_xxxxxx:XXXX-XXXX-XXXX',
      };
    }
    const accountId = trimmed.slice(0, colonIdx).trim();
    const secretPart = trimmed.slice(colonIdx + 1).trim().toUpperCase();
    if (!/^acc_[a-f0-9]{8,24}$/.test(accountId) || secretPart.length < 10) {
      return { ok: false, error: 'Invalid Passkey credentials.' };
    }

    const row = await this.getAccountRow(accountId);
    if (!row) {
      return { ok: false, error: 'Account not found on server.' };
    }
    const providedHash = sha256Hex(secretPart);
    if (!timingSafeHexEqual(row.recovery_code_hash, providedHash)) {
      return { ok: false, error: 'Invalid Passkey secret.' };
    }

    // Issue a fresh signed session token so the newly linked device is authorized
    const nonce = crypto.randomBytes(12).toString('base64url');
    const newAccountToken = this.signAccountToken(accountId, nonce);
    const newTokenHash = sha256Hex(newAccountToken);
    const now = Date.now();

    if (this.backend === 'postgresql' && this.pgPool) {
      await this.pgPool.query(
        'UPDATE player_accounts SET token_hash = $1, updated_at = $2 WHERE account_id = $3',
        [newTokenHash, now, accountId]
      );
    } else if (this.sqliteDb) {
      const stmt = this.sqliteDb.prepare(
        'UPDATE player_accounts SET token_hash = ?, updated_at = ? WHERE account_id = ?'
      );
      stmt.run(newTokenHash, now, accountId);
    }

    return {
      ok: true,
      accountId,
      accountToken: newAccountToken,
      passkey: `${accountId}:${secretPart}`,
      profile: this.rowToProfile(row),
    };
  }

  async updateAccountCosmetics(accountId, cosmeticsUpdate, callsignUpdate) {
    const row = await this.getAccountRow(accountId);
    if (!row) return null;

    let currentCosmetics = DEFAULT_COSMETICS;
    try {
      currentCosmetics = sanitizeCosmetics(JSON.parse(row.cosmetics_json || '{}'));
    } catch {
      currentCosmetics = { ...DEFAULT_COSMETICS };
    }

    const nextCosmetics = cosmeticsUpdate
      ? sanitizeCosmetics({ ...currentCosmetics, ...cosmeticsUpdate })
      : currentCosmetics;
    const nextCallsign = callsignUpdate
      ? sanitizeCallsign(callsignUpdate)
      : sanitizeCallsign(row.callsign);
    const now = Date.now();

    if (this.backend === 'postgresql' && this.pgPool) {
      await this.pgPool.query(
        `UPDATE player_accounts
         SET cosmetics_json = $1, callsign = $2, updated_at = $3
         WHERE account_id = $4`,
        [JSON.stringify(nextCosmetics), nextCallsign, now, accountId]
      );
    } else if (this.sqliteDb) {
      const stmt = this.sqliteDb.prepare(
        `UPDATE player_accounts
         SET cosmetics_json = ?, callsign = ?, updated_at = ?
         WHERE account_id = ?`
      );
      stmt.run(JSON.stringify(nextCosmetics), nextCallsign, now, accountId);
    }

    const updated = await this.getAccountRow(accountId);
    return this.rowToProfile(updated);
  }

  async recordAuthoritativeProgression(
    accountId,
    {
      eventId,
      roomCode = 'LOCAL',
      eventType = 'combat',
      matchesDelta = 0,
      winsDelta = 0,
      eliminationsDelta = 0,
      damageDelta = 0,
      placement = 0,
      xpDelta = 0,
    }
  ) {
    if (!accountId) return null;
    const row = await this.getAccountRow(accountId);
    if (!row) return null;

    const cleanEventId = eventId
      ? String(eventId).slice(0, 96)
      : `ev_${accountId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // Deduplicate reward events so no event can ever grant XP or stats twice
    if (this.backend === 'postgresql' && this.pgPool) {
      const insertEv = await this.pgPool.query(
        `INSERT INTO verified_match_events (event_id, account_id, room_code, event_type, xp_delta, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [
          cleanEventId,
          accountId,
          String(roomCode).slice(0, 20),
          String(eventType).slice(0, 32),
          Math.max(0, Math.round(Number(xpDelta) || 0)),
          Date.now(),
        ]
      );
      if (insertEv.rowCount === 0) {
        return this.rowToProfile(row);
      }
    } else if (this.sqliteDb) {
      const checkStmt = this.sqliteDb.prepare(
        'SELECT event_id FROM verified_match_events WHERE event_id = ? LIMIT 1'
      );
      if (checkStmt.get(cleanEventId)) {
        return this.rowToProfile(row);
      }
      const insStmt = this.sqliteDb.prepare(
        `INSERT INTO verified_match_events (event_id, account_id, room_code, event_type, xp_delta, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      insStmt.run(
        cleanEventId,
        accountId,
        String(roomCode).slice(0, 20),
        String(eventType).slice(0, 32),
        Math.max(0, Math.round(Number(xpDelta) || 0)),
        Date.now()
      );
    }

    const safeMatchesDelta = Math.max(0, Math.min(1, Math.round(Number(matchesDelta) || 0)));
    const safeWinsDelta = Math.max(0, Math.min(1, Math.round(Number(winsDelta) || 0)));
    const safeElimsDelta = Math.max(0, Math.min(30, Math.round(Number(eliminationsDelta) || 0)));
    const safeDmgDelta = Math.max(0, Math.min(5000, Math.round(Number(damageDelta) || 0)));
    const safeXpDelta = Math.max(0, Math.min(5000, Math.round(Number(xpDelta) || 0)));
    const safePlacement = Math.max(0, Math.min(100, Math.round(Number(placement) || 0)));

    const nextMatches = Number(row.matches_played || 0) + safeMatchesDelta;
    const nextWins = Number(row.wins || 0) + safeWinsDelta;
    const nextElims = Number(row.eliminations || 0) + safeElimsDelta;
    const nextDmg = Number(row.damage_dealt || 0) + safeDmgDelta;
    const prevBest = Number(row.best_placement || 0);
    const nextBest =
      safePlacement > 0
        ? prevBest === 0
          ? safePlacement
          : Math.min(prevBest, safePlacement)
        : prevBest;
    const nextXp = Number(row.xp || 0) + safeXpDelta;
    const nextLevel = computeLevelFromXp(nextXp);
    const unlockedOutfits = computeUnlockedOutfitsForLevel(nextLevel);
    const now = Date.now();

    if (this.backend === 'postgresql' && this.pgPool) {
      await this.pgPool.query(
        `UPDATE player_accounts
         SET matches_played = $1,
             wins = $2,
             eliminations = $3,
             damage_dealt = $4,
             best_placement = $5,
             xp = $6,
             level = $7,
             unlocked_outfits_json = $8,
             updated_at = $9
         WHERE account_id = $10`,
        [
          nextMatches,
          nextWins,
          nextElims,
          nextDmg,
          nextBest,
          nextXp,
          nextLevel,
          JSON.stringify(unlockedOutfits),
          now,
          accountId,
        ]
      );
    } else if (this.sqliteDb) {
      const updStmt = this.sqliteDb.prepare(
        `UPDATE player_accounts
         SET matches_played = ?,
             wins = ?,
             eliminations = ?,
             damage_dealt = ?,
             best_placement = ?,
             xp = ?,
             level = ?,
             unlocked_outfits_json = ?,
             updated_at = ?
         WHERE account_id = ?`
      );
      updStmt.run(
        nextMatches,
        nextWins,
        nextElims,
        nextDmg,
        nextBest,
        nextXp,
        nextLevel,
        JSON.stringify(unlockedOutfits),
        now,
        accountId
      );
    }

    const updated = await this.getAccountRow(accountId);
    return this.rowToProfile(updated);
  }

  getStatus() {
    return {
      backend: this.backend,
      connected: this.isConnected,
      persistentAcrossRestarts:
        this.backend === 'postgresql' || this.backend === 'sqlite',
      sqlitePath: this.backend === 'sqlite' ? this.sqlitePath : undefined,
      lastError: this.lastError,
    };
  }

  async close() {
    this.isConnected = false;
    if (this.pgPool) {
      await this.pgPool.end().catch(() => {});
      this.pgPool = null;
    }
    if (this.sqliteDb) {
      try {
        this.sqliteDb.close();
      } catch {
        // Ignore close error
      }
      this.sqliteDb = null;
    }
  }
}
