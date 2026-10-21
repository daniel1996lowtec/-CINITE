/**
 * CI Craft — Database migration & persistence tests.
 *
 * Covers: SQLite migration idempotency (fresh + repeated startup runs),
 * account creation/verification, cross-device passkey restore, authoritative
 * progression deduplication, persistence across restarts, PostgreSQL SSL /
 * connection-string resolution for Render-style URLs, and the "no silent
 * ephemeral fallback" guarantee when DATABASE_URL is configured.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ACCOUNT_TOKEN_SECRET =
  process.env.ACCOUNT_TOKEN_SECRET || 'test-account-token-secret-0123456789abcdef';

const { PersistenceManager, resolvePgConnectionConfig } = await import(
  '../server/database.mjs'
);

function tempSqlitePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft-db-test-'));
  return { dir, sqlitePath: path.join(dir, 'cicraft.sqlite') };
}

test('SQLite migrations are idempotent across repeated startup runs', async () => {
  const { dir, sqlitePath } = tempSqlitePath();
  try {
    const first = new PersistenceManager({ databaseUrl: '', sqlitePath });
    await first.init();
    assert.equal(first.backend, 'sqlite');
    assert.equal(first.isConnected, true);
    await first.close();

    // Second startup over the same file must re-run migrations safely.
    const second = new PersistenceManager({ databaseUrl: '', sqlitePath });
    await second.init();
    assert.equal(second.backend, 'sqlite');
    await second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('account lifecycle: create, verify, passkey restore, progression dedup, restart persistence', async () => {
  const { dir, sqlitePath } = tempSqlitePath();
  try {
    const db = new PersistenceManager({ databaseUrl: '', sqlitePath });
    await db.init();

    const created = await db.createOrVerifyAccount({ callsign: 'Commander_CI' });
    assert.equal(created.isNew, true);
    assert.match(created.accountId, /^acc_[a-f0-9]{12}$/);
    assert.match(created.passkey, /^acc_[a-f0-9]{12}:[A-Z0-9-]{14}$/);
    assert.equal(created.profile.xp, 0);
    assert.equal(created.profile.level, 1);

    // Same signed token verifies against the existing account (no duplicate).
    const verified = await db.createOrVerifyAccount({
      accountId: created.accountId,
      accountToken: created.accountToken,
      callsign: 'Commander_CI',
    });
    assert.equal(verified.isNew, false);
    assert.equal(verified.accountId, created.accountId);

    // A forged token must not verify as the existing account.
    const forged = await db.createOrVerifyAccount({
      accountId: created.accountId,
      accountToken: `${created.accountId}.forgednonce.forgedsig`,
      callsign: 'Impostor',
    });
    assert.notEqual(forged.accountId, created.accountId);

    // Cross-device passkey restore issues a fresh valid token.
    const restored = await db.restoreAccountByPasskey(created.passkey);
    assert.equal(restored.ok, true);
    assert.equal(restored.accountId, created.accountId);
    const reVerified = await db.createOrVerifyAccount({
      accountId: restored.accountId,
      accountToken: restored.accountToken,
    });
    assert.equal(reVerified.isNew, false);

    const badRestore = await db.restoreAccountByPasskey(
      `${created.accountId}:XXXX-XXXX-XXXX`
    );
    assert.equal(badRestore.ok, false);

    // Authoritative progression applies once per eventId (dedup).
    const delta = {
      eventId: 'test_event_1',
      roomCode: 'CI-TEST',
      eventType: 'match_participation',
      matchesDelta: 1,
      eliminationsDelta: 2,
      damageDelta: 140,
      xpDelta: 150,
    };
    const afterFirst = await db.recordAuthoritativeProgression(created.accountId, delta);
    assert.equal(afterFirst.matchesPlayed, 1);
    assert.equal(afterFirst.eliminations, 2);
    assert.equal(afterFirst.damageDealt, 140);
    assert.equal(afterFirst.xp, 150);

    const afterDup = await db.recordAuthoritativeProgression(created.accountId, delta);
    assert.equal(afterDup.matchesPlayed, 1);
    assert.equal(afterDup.xp, 150);

    await db.close();

    // "Restart": a fresh manager over the same file sees the same account.
    const restarted = new PersistenceManager({ databaseUrl: '', sqlitePath });
    await restarted.init();
    const row = await restarted.getAccountRow(created.accountId);
    assert.ok(row);
    const profile = restarted.rowToProfile(row);
    assert.equal(profile.xp, 150);
    assert.equal(profile.eliminations, 2);
    await restarted.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePgConnectionConfig: Render internal URL uses plaintext on the private network', () => {
  const { connectionString, ssl } = resolvePgConnectionConfig(
    'postgresql://cicraft_user:secret@dpg-dbc993gae00c7391btg0-a:5432/cicraft',
    {}
  );
  assert.equal(ssl, false);
  assert.match(connectionString, /dpg-dbc993gae00c7391btg0-a/);
});

test('resolvePgConnectionConfig: external URL uses TLS without strict verification', () => {
  const { ssl } = resolvePgConnectionConfig(
    'postgresql://cicraft_user:secret@dpg-xxxx-a.oregon-postgres.render.com:5432/cicraft',
    {}
  );
  assert.deepEqual(ssl, { rejectUnauthorized: false });
});

test('resolvePgConnectionConfig: sslmode=require is honored and stripped from the URL', () => {
  const { connectionString, ssl } = resolvePgConnectionConfig(
    'postgresql://user:pass@dpg-internal-host/cicraft?sslmode=require',
    {}
  );
  // Explicit ssl object must survive: pg would otherwise treat sslmode=require
  // in the URL as verify-full and reject Render's self-signed internal cert.
  assert.deepEqual(ssl, { rejectUnauthorized: false });
  assert.doesNotMatch(connectionString, /sslmode/);
});

test('resolvePgConnectionConfig: sslmode=disable and loopback stay plaintext', () => {
  assert.equal(
    resolvePgConnectionConfig('postgresql://u:p@db.example.com/x?sslmode=disable', {}).ssl,
    false
  );
  assert.equal(
    resolvePgConnectionConfig('postgresql://u:p@localhost:5432/x', {}).ssl,
    false
  );
  assert.equal(
    resolvePgConnectionConfig('postgresql://u:p@127.0.0.1:5432/x', {}).ssl,
    false
  );
  assert.equal(
    resolvePgConnectionConfig('postgresql://u:p@db.example.com/x', { PGSSLMODE: 'disable' })
      .ssl,
    false
  );
});

test('DATABASE_URL set but unreachable: init fails fast instead of silent SQLite fallback', async () => {
  const { dir, sqlitePath } = tempSqlitePath();
  try {
    const db = new PersistenceManager({
      databaseUrl: 'postgresql://user:pass@127.0.0.1:1/cicraft',
      sqlitePath,
      connectRetries: 1,
      retryBaseDelayMs: 1,
      allowSqliteFallback: false,
    });
    await assert.rejects(() => db.init(), /DATABASE_URL/);
    assert.equal(db.isConnected, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('db:migrate CLI defers to startup migrations instead of failing hosting builds (--strict stays fatal)', async () => {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runMigrate = (extraArgs) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['server/migrate.mjs', ...extraArgs],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            DATABASE_URL: 'postgresql://user:pass@127.0.0.1:1/cicraft',
            DATABASE_CONNECT_RETRIES: '1',
            DATABASE_RETRY_DELAY_MS: '1',
            DATABASE_FALLBACK_SQLITE: '',
            ACCOUNT_TOKEN_SECRET: 'test-account-token-secret-0123456789abcdef',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, out }));
    });

  const lenient = await runMigrate([]);
  assert.equal(lenient.code, 0);
  assert.match(lenient.out, /Migrations will run automatically at server startup/);

  const strict = await runMigrate(['--strict']);
  assert.equal(strict.code, 1);
  assert.match(strict.out, /strict mode/);
});

test('DATABASE_FALLBACK_SQLITE opt-in still falls back to SQLite', async () => {
  const { dir, sqlitePath } = tempSqlitePath();
  try {
    const db = new PersistenceManager({
      databaseUrl: 'postgresql://user:pass@127.0.0.1:1/cicraft',
      sqlitePath,
      connectRetries: 1,
      retryBaseDelayMs: 1,
      allowSqliteFallback: true,
    });
    await db.init();
    assert.equal(db.backend, 'sqlite');
    assert.equal(db.isConnected, true);
    await db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
