/**
 * CI CRAFT 8.7 — renderer diagnostics safety.
 *
 * The diagnostics overlay captures console output and renders a full-screen
 * panel over the game. That is exactly what you want when debugging and exactly
 * what you never want a normal player to see, so the activation gate is a
 * safety property, not a convenience: it must be inert unless the URL explicitly
 * asks for it.
 *
 * These tests load the real module (type-stripped, same technique as
 * scripts/headlessWorld.mjs) so they cannot drift from the shipped code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let cached = null;
async function diagnosticsModule() {
  if (cached) return cached;
  const tmpDir = fs.mkdtempSync(path.join(ROOT, '.diag87-test-'));
  try {
    const source = fs.readFileSync(path.join(ROOT, 'src/debug/RendererDiagnostics.ts'), 'utf8');
    const target = path.join(tmpDir, 'RendererDiagnostics.mjs');
    fs.writeFileSync(target, stripTypeScriptTypes(source));
    cached = await import(pathToFileURL(target).href);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return cached;
}

test('8.7 diagnostics: inactive with no query string', async () => {
  const { diagnosticsRequested } = await diagnosticsModule();
  assert.equal(diagnosticsRequested(''), false);
});

test('8.7 diagnostics: inactive for unrelated query strings', async () => {
  const { diagnosticsRequested } = await diagnosticsModule();
  for (const search of ['?x=1', '?diag=0', '?diag=true', '?diag=1x', '?diag=', '?diag']) {
    assert.equal(diagnosticsRequested(search), false, `"${search}" must not activate diagnostics`);
  }
});

test('8.7 diagnostics: active only for an explicit diag=1', async () => {
  const { diagnosticsRequested } = await diagnosticsModule();
  assert.equal(diagnosticsRequested('?diag=1'), true);
  assert.equal(diagnosticsRequested('?a=b&diag=1'), true);
});

test('8.7 diagnostics: never overrides three.js shader error reporting', async () => {
  // Installing renderer.debug.onShaderError makes three.js call the hook
  // *instead of* its own reporter, and the reporter is the only thing that
  // prints Material Name / Material Type / the annotated shader source.
  // The module must capture console output and leave the reporter intact.
  const source = fs.readFileSync(path.join(ROOT, 'src/debug/RendererDiagnostics.ts'), 'utf8');
  assert.equal(
    /onShaderError\s*=/.test(source),
    false,
    'RendererDiagnostics must not assign renderer.debug.onShaderError'
  );
  assert.equal(
    /checkShaderErrors\s*=/.test(source),
    false,
    'RendererDiagnostics must not disable checkShaderErrors'
  );
});

test('8.7 diagnostics: the engine does not replace the shader error reporter', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/core/GameEngine.ts'), 'utf8');
  assert.equal(
    /debug\.onShaderError\s*=/.test(source),
    false,
    'GameEngine must not assign debug.onShaderError — it downgrades three.js diagnostics'
  );
});
