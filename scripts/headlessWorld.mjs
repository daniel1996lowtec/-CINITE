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
    emit('src/world/WorldBrandingLayout.ts', 'WorldBrandingLayout.mjs', [
      ["from './WorldLayout'", "from './WorldLayout.mjs'"],
    ]);
    emit('src/world/WorldBranding.ts', 'WorldBranding.mjs', [
      ["from './WorldBrandingLayout'", "from './WorldBrandingLayout.mjs'"],
    ]);
    emit('src/world/VisualAtmosphere.ts', 'VisualAtmosphere.mjs');
    emit('src/world/SkySystem.ts', 'SkySystem.mjs');
    emit('src/world/ArchitecturalMaterials.ts', 'ArchitecturalMaterials.mjs');
    emit('src/world/VegetationGeometry.ts', 'VegetationGeometry.mjs');
    emit('src/world/BuildingKit.ts', 'BuildingKit.mjs', [
      ["from './ArchitecturalMaterials'", "from './ArchitecturalMaterials.mjs'"],
      ["from './VisualAtmosphere'", "from './VisualAtmosphere.mjs'"],
    ]);
    emit('src/world/RoadNetwork.ts', 'RoadNetwork.mjs', [
      ["from './WorldLayout'", "from './WorldLayout.mjs'"],
    ]);
    const roadNetworkModule = await import(pathToFileURL(path.join(tmpDir, 'RoadNetwork.mjs')).href);
    emit('src/world/TerrainGenerator.ts', 'TerrainGenerator.mjs', [
      [/import\s+\{\s*TimeOfDayPreset\s*\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
      ["from './VisualAtmosphere'", "from './VisualAtmosphere.mjs'"],
      ["from './SkySystem'", "from './SkySystem.mjs'"],
      ["from './WorldLayout'", "from './WorldLayout.mjs'"],
      ["from './RoadNetwork'", "from './RoadNetwork.mjs'"],
    ]);
    emit('src/world/MapExpansionBuilder.ts', 'MapExpansionBuilder.mjs', [
      ["from './WorldBrandingLayout'", "from './WorldBrandingLayout.mjs'"],
      ["from './TerrainGenerator'", "from './TerrainGenerator.mjs'"],
      ["from './VisualAtmosphere'", "from './VisualAtmosphere.mjs'"],
      ["from './BuildingKit'", "from './BuildingKit.mjs'"],
      ["from './VegetationGeometry'", "from './VegetationGeometry.mjs'"],
      ["from './WorldLayout'", "from './WorldLayout.mjs'"],
      ["from './RoadNetwork'", "from './RoadNetwork.mjs'"],
    ]);
    emit('src/world/IslandWorld.ts', 'IslandWorld.mjs', [
      ["from '../../shared/buildPlacement.mjs'", `from '${pathToFileURL(path.join(ROOT_DIR,'shared/buildPlacement.mjs')).href}'`],
      ["from './WorldBranding'", "from './WorldBranding.mjs'"],
      ["from './TerrainGenerator'", "from './TerrainGenerator.mjs'"],
      ["from './MapExpansionBuilder'", "from './MapExpansionBuilder.mjs'"],
      ["from './VisualAtmosphere'", "from './VisualAtmosphere.mjs'"],
      ["from './ArchitecturalMaterials'", "from './ArchitecturalMaterials.mjs'"],
      ["from './BuildingKit'", "from './BuildingKit.mjs'"],
      ["from './VegetationGeometry'", "from './VegetationGeometry.mjs'"],
      ["from './WorldLayout'", "from './WorldLayout.mjs'"],
      [/import\s+\{\s*BuildablePieceState,[\s\S]*?\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
    ]);

    const THREE = await import('three');
    const layout = await import(pathToFileURL(path.join(tmpDir, 'WorldLayout.mjs')).href);
    const terrainModule = await import(
      pathToFileURL(path.join(tmpDir, 'TerrainGenerator.mjs')).href
    );
    const worldModule = await import(pathToFileURL(path.join(tmpDir, 'IslandWorld.mjs')).href);
    const brandingLayout = await import(pathToFileURL(path.join(tmpDir, 'WorldBrandingLayout.mjs')).href);
    const brandingModule = await import(pathToFileURL(path.join(tmpDir, 'WorldBranding.mjs')).href);
    const archMaterials = await import(
      pathToFileURL(path.join(tmpDir, 'ArchitecturalMaterials.mjs')).href
    );
    const atmosphere = await import(pathToFileURL(path.join(tmpDir, 'VisualAtmosphere.mjs')).href);
    const skySystem = await import(pathToFileURL(path.join(tmpDir, 'SkySystem.mjs')).href);
    const buildingKit = await import(pathToFileURL(path.join(tmpDir, 'BuildingKit.mjs')).href);
    return {
      THREE,
      layout,
      terrainModule,
      brandingLayout,
      brandingModule,
      archMaterials,
      atmosphere,
      skySystem,
      buildingKit,
      IslandWorld: worldModule.IslandWorld,
      buildRoadNetwork: roadNetworkModule.buildRoadNetwork,
      roadHalfWidth: roadNetworkModule.roadHalfWidth,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

