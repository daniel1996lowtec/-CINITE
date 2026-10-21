/**
 * CI Craft 2.8 — Database Migration & Schema Verification CLI
 * Usage: `npm run db:migrate` (or `node server/migrate.mjs`)
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
