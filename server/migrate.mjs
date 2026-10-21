/**
 * CI Craft — Database Migration & Schema Verification CLI
 * Usage: `npm run db:migrate` (or `node server/migrate.mjs`)
 *        `node server/migrate.mjs --strict` to exit non-zero on any failure.
 *
 * Optional/manual tool: the production server already runs these idempotent
 * migrations during startup, before accepting traffic (see
 * `PersistenceManager.init()`), so hosting build commands do not need this
 * script — the production DATABASE_URL (e.g. Render's internal PostgreSQL
 * hostname) is only reachable at runtime, not during a build.
 *
 * Because some hosting dashboards may still carry an old build command that
 * invokes this script, a failed connection does NOT fail the build by
 * default: it logs a loud warning and defers to the startup migrations
 * (which remain fail-fast). Pass `--strict` (or set `MIGRATE_STRICT=1`) when
 * you want this CLI itself to verify connectivity and exit non-zero.
 */
import { PersistenceManager } from './database.mjs';

const strict =
  process.argv.includes('--strict') ||
  process.env.MIGRATE_STRICT === '1' ||
  process.env.MIGRATE_STRICT === 'true';

const db = new PersistenceManager();
try {
  await db.init();
  const status = db.getStatus();
  console.log('[CI Craft DB Migrate] Schema migrations completed successfully:', status);
  await db.close();
  process.exit(0);
} catch (err) {
  await db.close();
  if (strict) {
    console.error('[CI Craft DB Migrate] Migration failed (strict mode):', err);
    process.exit(1);
  }
  console.warn(
    '[CI Craft DB Migrate] WARNING: could not run migrations from this environment ' +
      `(${err instanceof Error ? err.message : String(err)}). ` +
      'This is expected during hosting builds where the runtime DATABASE_URL is unreachable. ' +
      'Migrations will run automatically at server startup. ' +
      'Re-run with --strict to make this a hard failure.'
  );
  process.exit(0);
}
