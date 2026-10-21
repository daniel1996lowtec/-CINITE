import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function loadWorldModules() {
  const tmpDir = fs.mkdtempSync(path.join(ROOT_DIR, '.world-expansion-test-'));
  const emit = (source, output, replacements = []) => {
    let code = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT_DIR, source), 'utf8'));
    for (const [pattern, replacement] of replacements) {
      code = code.replace(pattern, replacement);
    }
    fs.writeFileSync(path.join(tmpDir, output), code);
  };

  try {
    emit('src/world/WorldLayout.ts', 'WorldLayout.mjs');
    emit('src/world/VisualAtmosphere.ts', 'VisualAtmosphere.mjs');
    emit('src/world/TerrainGenerator.ts', 'TerrainGenerator.mjs', [
      [/import\s+\{\s*TimeOfDayPreset\s*\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
      ["from './VisualAtmosphere'", "from './VisualAtmosphere.mjs'"],
      ["from './WorldLayout'", "from './WorldLayout.mjs'"],
    ]);
    emit('src/world/MapExpansionBuilder.ts', 'MapExpansionBuilder.mjs', [
      ["from './TerrainGenerator'", "from './TerrainGenerator.mjs'"],
      ["from './VisualAtmosphere'", "from './VisualAtmosphere.mjs'"],
      ["from './WorldLayout'", "from './WorldLayout.mjs'"],
    ]);
    emit('src/world/IslandWorld.ts', 'IslandWorld.mjs', [
      ["from './TerrainGenerator'", "from './TerrainGenerator.mjs'"],
      ["from './MapExpansionBuilder'", "from './MapExpansionBuilder.mjs'"],
      ["from './VisualAtmosphere'", "from './VisualAtmosphere.mjs'"],
      ["from './WorldLayout'", "from './WorldLayout.mjs'"],
      [/import\s+\{\s*BuildablePieceState,[\s\S]*?\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
    ]);

    const THREE = await import('three');
    const layout = await import(pathToFileURL(path.join(tmpDir, 'WorldLayout.mjs')).href);
    const terrainModule = await import(
      pathToFileURL(path.join(tmpDir, 'TerrainGenerator.mjs')).href
    );
    const worldModule = await import(pathToFileURL(path.join(tmpDir, 'IslandWorld.mjs')).href);
    return { THREE, layout, terrainModule, IslandWorld: worldModule.IslandWorld };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

