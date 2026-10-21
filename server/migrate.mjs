/**
 * CI Craft — Database Migration & Schema Verification CLI
 * Usage: `npm run db:migrate` (or `node server/migrate.mjs`)
 *
 * Optional/manual tool: the production server already runs these idempotent
 * migrations during startup (see `PersistenceManager.init()`), so hosting
 * build commands must NOT invoke this script — the production DATABASE_URL
 * (e.g. Render's internal PostgreSQL hostname) is only reachable at runtime.
 */
import { PersistenceManager } from './database.mjs';

const db = new PersistenceManager();
try {
  await db.init();
  const status = db.getStatus();
  console.log('[CI Craft DB Migrate] Schema migrations completed successfully:', status);
  await db.close();
  process.exit(0);
} catch (err) {
  console.error('[CI Craft DB Migrate] Migration failed:', err);
  await db.close();
  process.exit(1);
}
