# CI CRAFT 6.1 — Major Visual Transformation

This pass replaces primitive placeholder geometry and flat shading with authored
meshes, generated PBR surface maps and real architectural depth. Gameplay
(collision, loot, routes, match rules, networking) is **byte-identical**: the
world fingerprint hash and the exact 1,414-collider count are still asserted by
`tests/worldBranding.test.mjs` and `tests/worldExpansion.test.mjs`.

## Why 6.0 looked like "a small lighting tweak"

6.0 changed colours, vertex tints, `flatShading` flags and a few quality
settings. The *geometry* the player actually looks at was still built from:

| Placeholder | Where |
| --- | --- |
| `ConeGeometry(r, h, 4/6)` grass, pine tiers | `IslandWorld.buildInstancedFoliage`, `populateWilderness` |
| `DodecahedronGeometry` tree crowns, bushes, clouds, rocks | same + `TerrainGenerator` |
| `BoxGeometry` palm fronds, supply crates | same |
| Flat-shaded boxes for every facade with a 64 px canvas pattern | `MapExpansionBuilder.createBuilding`, `IslandWorld.createEnterableHouse` |
| No normal / roughness / albedo textures anywhere (2 canvas textures total) | whole project |
| Facades with no sills, mullions, cornices, downpipes, canopies or roof plant | whole project |

6.1 replaces those meshes and materials at the source.

## What actually changed

**Generated PBR pipeline (`src/world/VisualAtmosphere.ts`)**
- `createPbrSurfaceTextures()`: deterministic, tileable 64² albedo **and**
  tangent-space normal maps for ashlar facades, multi-pane glazing, bark,
  foliage, stratified rock, framed crate timber and ribbed metal.
- `createTerrainSurfaceMaps()`: 256² tileable fractal-noise normal + roughness +
  grain maps repeated at human scale (~7 m per tile) so ground surfaces have
  real relief instead of one stretched overlay.
- `applyArchitectureSurfaceShader()`: per-material-kind shader injection adds
  world-space masonry courses and mortar joints, foundation plinths, cornice
  shading, plus true window frames, mullions and interior depth on glazing.
- Authored geometry builders: `createBotanicalTreeTrunkGeometry` (buttressed
  roots, curved taper), `createBotanicalCrownGeometry` (multi-lobe billowing
  canopy), `createScallopedPineTierGeometry`, `createArchedPalmFrondGeometry`,
  `createSculptedBoulderGeometry`, `createFramedSupplyCrateGeometry`,
  `createCrossedGrassTuftGeometry`, `createBotanicalShrubGeometry`,
  `weldAndSmoothGeometry` (shared smooth normals), `mergeBufferGeometries`.

**World**
- `TerrainGenerator`: terrain material gains normal/roughness maps; plaza
  paving, roads, settlement grounds and keeps lose every checkerboard/parity
  pattern in favour of slab, aggregate, furrow and mortar-joint variation;
  cumulus clouds are smooth billowed shells instead of faceted dodecahedrons.
- `IslandWorld`: plaza houses rebuilt with merged stone trim, quoins, cornices,
  architraves, marble sills, mullioned glazing and a pitched tile roof; docks,
  keep, grove, silos, lake crossings, farms and ruins all move to the shared PBR
  materials with higher-segment cylinders and smooth shading. Trees, boulders,
  crates, grass, reeds, shrubs and pebbles use the new authored geometry with
  per-instance colour variation. Player-built walls/floors/roofs/ramps use
  wood/masonry/metal surface sets instead of glowing flat slabs.
- `MapExpansionBuilder`: every modular building gains a projecting cornice,
  window mullions and sills, corner rainwater downpipes with brackets, entrance
  canopies and lamps, recessed door reveals, and rooftop plant (water tank with
  cap, vent stacks, stair bulkhead, chimneys). Each settlement gains street
  furniture (benches with backs and legs, litter bins, planters with clipped
  shrubs, bollards, café awnings and a stall counter) and zebra crossings.

**Characters & weapons**
- Armour, fabric and visor materials now carry woven/composite normal maps; the
  GLB body material gets fabric micro-relief.
- New authored armour layers on every outfit: thigh plates and knee guards bound
  to `leftUpLeg`/`rightUpLeg`/`leftLeg`/`rightLeg`, glove cuffs bound to the hand
  bones, and a chest harness with a buckle — so they follow sprint, freefall,
  gliding and reload animation instead of floating on the hips.
- Firearms gain a `weapon_hardware` group: folding iron sights (base, post, rear
  aperture), six handguard vents, magwell bevel, trigger-housing pin, QD sling
  loop, rubber butt pad, threaded muzzle collar, plus bead sights on shotguns
  and a side rail on automatic weapons. Steel and polymer normal maps are shared
  across all weapon materials.

**Rendering**
- Anisotropic filtering (clamped to 4) is applied to every tiling detail map on
  medium/high/ultra tiers so roads, cliffs and facades stay sharp at grazing
  angles; LOW keeps 1× to save bandwidth.
- Quality tiers keep their real differences: LOW disables shadows, clouds,
  distant islands and the detail batches; MEDIUM 1024 px PCF; HIGH 1536 px soft
  shadows + full detail; ULTRA 2048 px soft shadows, 2× DPR ceiling, full foliage
  wind/particles and 760 m far plane.

## Measured effect (headless, same machine)

`node scripts/visualAudit.mjs` on `aa26e8d` (6.0) versus this branch:

| Metric | 6.0 | 6.1 |
| --- | --- | --- |
| Mesh objects (draw calls) | 822 | **775** |
| Instanced batches / instances | 190 / 9,719 | **203 / 12,264** |
| Triangles | 299,506 | 321,030 |
| Vertices | 543,809 | **359,794** |
| Unique textures | 2 | **18** |
| Smooth-shaded materials | 71 | **153** |
| Normal-mapped materials | 0 | **106** |
| `DodecahedronGeometry` placeholders | 93 | **0** |
| `BoxGeometry` primitives | 463 | **381** |
| Colliders (gameplay) | 1,414 | **1,414 (identical)** |

## Verifying visually

No browser/WebGL runtime is available inside the CI sandbox used for this
change (the sandbox ships no Chromium and the bundled headless build cannot load
`libnss3`), so **no screenshots are claimed here**. To check the result locally:

```bash
npm ci
npm run dev            # http://localhost:5173
# Settings → Graphics → ULTRA, Time of day → Day, then:
#   1. Watch the skydrop: plaza houses, tower, canopy and shoreline detail.
#   2. Land at Aurora Heights (x≈97, z≈-2): facades, glazing, cornices,
#      downpipes, rooftop tanks, benches, planters, awning and crossings.
#   3. Walk into Git Grove and Frontend Farms for the botanical trees,
#      boulders, crates and tilled fields.
#   4. Hold ADS with a rifle: iron sights, vents, magwell, sling loop.
#   5. Glide in: canopy panels, 12 suspension lines, two-hand toggle IK.
npm run test:graphics61   # structural regression contracts
node scripts/visualAudit.mjs  # numbers above, on your machine
```
