/**
 * CI Craft — client mode bot-count gate tests.
 *
 * The browser's BotAIController is intentionally untouched. These tests
 * execute the shared TypeScript schema helpers used by GameEngine/main to
 * prove that Solo and legacy Online retain the requested AI count, while both
 * Human modes always resolve to exactly zero regardless of the UI selection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadSchemasModule() {
  const source = fs.readFileSync(
    path.join(ROOT_DIR, 'src/network/schemas.ts'),
    'utf8'
  );
  const javascript = stripTypeScriptTypes(source);
  return import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  );
}

test('bot-count gate: Solo/legacy Online keep AI bots, Human modes always force zero', async () => {
  const schemas = await loadSchemasModule();

  assert.equal(schemas.isHumanOnlySessionMode('solo_bots'), false);
  assert.equal(schemas.isHumanOnlySessionMode('online'), false);
  assert.equal(schemas.isHumanOnlySessionMode('human_only_public'), true);
  assert.equal(schemas.isHumanOnlySessionMode('human_only_private'), true);

  // Solo Battle Royale (+AI Bots) remains fully functional at the config
  // layer consumed by GameEngine's preserved bot-spawn path.
  assert.equal(schemas.effectiveBotCountForMode('solo_bots', 9), 9);
  assert.equal(schemas.effectiveBotCountForMode('solo_bots', 14), 14);
  assert.equal(schemas.effectiveBotCountForMode('solo_bots', 19), 19);

  // Legacy Online AI Fill is preserved as a separate non-human-only mode.
  assert.equal(schemas.effectiveBotCountForMode('online', 19), 19);
  assert.equal(schemas.roomModeForSessionMode('online'), 'online_ai_fill');

  // No requested AI setting can leak into either Human mode.
  for (const requested of [0, 9, 14, 19, 999]) {
    assert.equal(
      schemas.effectiveBotCountForMode('human_only_public', requested),
      0
    );
    assert.equal(
      schemas.effectiveBotCountForMode('human_only_private', requested),
      0
    );
  }
  assert.equal(
    schemas.roomModeForSessionMode('human_only_public'),
    'human_only_public'
  );
  assert.equal(
    schemas.roomModeForSessionMode('human_only_private'),
    'human_only_private'
  );
});
