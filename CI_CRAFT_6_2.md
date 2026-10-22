# CI CRAFT 6.2 — Real AAA World Asset Replacement

Base: `1339547700efa397e31330ba353e59a03db948d6` (CI CRAFT 6.1, PR #14)
Branch: `arena/ce7751ae-cinite`

6.1 was judged insufficient in one specific way: the *boxes* were still boxes. 6.2
replaces geometry and materials at the source instead of re-tuning colour, fog and
lighting, and it deliberately adds an authored-asset tier instead of repeating the
"bigger texture on the same cube" approach.

---

## 1. What was actually replaced

### Buildings

| Before (6.1) | 6.2 |
| --- | --- |
| Facade relief largely drawn as flat `decal` quads on scaled boxes | Modular `BuildingKit` that emits real volumetric parts: window reveals, moulded frames, glazing beads, splayed sills with corbel returns, lintels with keystones, entrance portals with jambs and kicking plates, plinths, string courses, dentilled cornices, gutters and downpipes |
| One box per building body | Per-building authored kit batched into shared instance slots (`ExpansionKit_*`), merged per material |
| Roofs as single boxes / rotated boxes | `addGableRoof` (explicit quad construction), `addShedRoof`, `addFlatRoofDetail` (stone coping with drip groove, skylights with aluminium frames, louvred HVAC, vent stacks, access hatch, perimeter pipe runs) |
| Exterior roof ramps as bare planks | Real stairs: deck + `treadCount = rampRun / 0.42` treads + handrails + posts |
| Highrise spandrels painted with the district roof colour | Cast-concrete spandrel bands; district hue reduced to a trace (see §3) |
| Island houses: facade detail mounted at `±hd`, i.e. buried half a wall inside the shell | All facade detail offset by `wallThick / 2` (`faceZ` / `faceBackZ` / `faceX`) — windows and doors are now correctly proud of the wall plane |

### Materials / UVs (root causes, not settings)

* **`ArchitecturalMaterials.ts` (new, ~700 lines).** Eight authored surface sets —
  plaster, brick, ashlar, clay roof tile, timber, painted trim, architectural metal,
  concrete — each with a deterministic tileable albedo (512 px, 256 px for hardware),
  a derived normal map and a roughness map. Pure integer PRNG + periodic value noise,
  so the world is reproducible headlessly.
* **`applyWorldSpaceUv()`** rewrites the map / normal / roughness / bump UVs from
  *world position* using a dominant-axis projection. Texture scale is now constant in
  metres regardless of how an instance is scaled, which removes the "one brick texture
  stretched across a 13 m wall" failure mode entirely.
* **Bug fixed (this pass):** the architecture surface shader *assigned*
  `material.onBeforeCompile` outright, silently destroying the world-space UV
  projection on the very same shared materials — so every instanced wall fell back to
  stretched box UVs. It now composes with the previous injector, is idempotent per
  `(material, kind)`, and chains `customProgramCacheKey`.
* **Bug fixed (this pass):** `applyWorldSpaceUv` injected at `#include <uv_vertex>`,
  which is the *first* statement of `main()` — `transformed` and `objectNormal` do not
  exist there, so the shader could not compile in a real browser even though every
  Node test passed. Injection moved to `#include <project_vertex>`.
* **Bug fixed (this pass):** the `dark` merged surface (~27 k triangles of shutters,
  hardware, treads, risers) was the only slot without world-space UVs.

### Terrain and environment

* `macroNoise()` 4-octave fractal value noise drives biome borders, shore lines,
  dry/damp meadow patches and rock strata — no rectangular colour patches.
* `applyTerrainGroundDetail()` shader on the terrain material: three octaves of
  world-space value noise → grain, speckle, dry patches, rock chips on slopes,
  wet-sand darkening, normal perturbation, roughness modulation.
* Roads are real asphalt (`0x6b6f76` crown, wheel tracks, aggregate shoulder, painted
  edge line, tar seams) instead of beach-sand tan.
* `buildRoadFurniture()`: stone kerbs and verge strips, reflective delineators, timber
  utility poles with crossarms and catenary wires — all in one shared `'roadside'`
  batch.
* Vegetation was already botanic in 6.1 (welded smooth crowns, scalloped pine tiers,
  arched palm fronds, sculpted boulders); 6.2 restores smooth shading in the preview
  pipeline so it actually *renders* as vegetation rather than facets (§3).

### Character and weapon

* **Back-accessory harness.** Every back accessory (`jump_pack`, `energy_wings`,
  `tactical_shield`) now has an authored mounting harness — a conforming backplate,
  two shoulder straps ending in bevelled clamp buckles, a sternum strap, a lumbar pad
  and a lumbar buckle — so the pack is physically joined to the torso instead of
  floating off the spine. Sized inside the accessory's existing silhouette envelope.
* Weapons already carry authored hardware (folding iron sights, handguard vents,
  magwell bevel, QD sling loop, rubber butt pad, thread collar, bead sight); the
  character contract test (`graphics51`) that forbids box placeholders and oversized
  accessories still passes unchanged in substance.
* Parachute: curved ram-air canopy (7 pillowed cells, spanwise arch, chordwise camber),
  stitched ribs, 14 non-intersecting suspension/brake lines, V-risers, steering
  toggles, fitted torso harness, smooth deploy blend.

---

## 2. Performance guard rails

Architecture is split into two tiers:

* **essential** — walls, roofs, glazing, doors, road surfaces, terrain.
  Hidden at no quality level.
* **detail** — window frames, sills, dentils, railings, gutters, fine foliage.
  `houseDetailGroup` / `expansionDetailGroup` / `detailFoliageGroup`, hidden on
  Low/Medium and during reduced-detail modes.

Measured with `node scripts/visualAudit.mjs`:

| Metric | 6.1 (merged) | 6.2 |
| --- | --- | --- |
| Triangles (full detail) | 321,030 | **518,860** |
| Triangles (always-on tier) | 321,030 | **305,226** |
| Draw calls / meshes | 775 | **709** |
| Instanced batches | — | 183 (11,908 instances) |
| Textures | 18 | **40** |
| Normal-mapped materials | 106 | **86** of 126 smooth |
| Gameplay colliders | 1,414 | **1,414** |

The always-on tier is *lower* than 6.1 while the full-detail tier carries ~200 k
triangles of new authored geometry. Budgets are asserted per tier in
`tests/worldExpansion.test.mjs`, `tests/worldBranding.test.mjs`,
`tests/polish35.test.mjs` and `tests/graphics61.test.mjs`
(essential ≤ 330,000, full detail ≤ 560,000).

---

## 3. Regressions found and fixed during the verification pass

1. **Neon spandrel bands on highrises.** The per-storey slab edge and the front/rear
   facade bands used `placement.roofColor` straight from the layout, so a violet or
   rust roof painted a saturated stripe around every floor. Replaced with cast
   concrete (`lerp(roofColor, 0xb9c2cc, 0.82)`); the district hue survives only as a
   thin keyline.
2. **Over-saturated glazing.** Window panels used `0x7dd3fc` / `0xfde68a` at full
   saturation, reading as emissive neon plates. Now `0x9fb4c4` (cool sky reflection)
   and `0xc9bda0` (warm interior light).
3. **Neon shopfront fascia and awnings.** A 12 m fascia painted in a hot-pink district
   accent read as neon. The sign panel is now muted 45 % toward charcoal, the awning
   62 % toward canvas, and the accent is kept as a 3 mm keyline.
4. **Faceted vegetation in previews.** The offline renderer shaded every triangle
   with the *face* normal regardless of material, so smooth-shaded foliage, trunks and
   boulders were rendered as facets and looked like the 6.0 primitives. It now
   interpolates vertex normals per pixel unless the material is flagged
   `flatShading`. This was an evidence-fidelity bug, not a world bug.

---

## 4. Visual verification status — read this carefully

**No real browser rendering was performed for this PR.** The sandbox has no browser
binary, `apt-get` is denied, and no software GL stack (`gl`, `@kmamal/gl`) can be
built because the Node headers host is unreachable. There are therefore **no
in-game screenshots** in this PR, and nothing here should be read as a claim that the
graphics were verified in a live browser.

What *was* produced is `scripts/offlineRender.mjs`: a Node software rasteriser that
loads the **real** `IslandWorld` modules (not mocks), walks the real Three.js scene
graph, and rasterises every triangle with:

* real world matrices and real instance matrices/tints,
* the real albedo `DataTexture`s sampled through the same world-space UV projection,
* the real per-vertex AO,
* the terrain ground-detail noise ported to JS with identical constants,
* `FogExp2` at 0.0018 and ACES + sRGB output.

It is faithful for **silhouette, facade depth, roof construction, texture scale,
palette and layout**. It is **not** the Three.js `WebGLRenderer`: it has no PBR
specular response, no shadow maps, no tone-mapped bloom, no MSAA. A shader that fails
to compile in the browser would not be caught by it — which is exactly why
`tests/graphics62.test.mjs` resolves the injected GLSL against Three's real
`ShaderChunk` library and asserts the injected block lands *after* `project_vertex`
and that brace balance is unchanged.

Output: `artifacts/offline-preview/*.png` (13 views, 1100×620).

Manual verification (please run locally):

```bash
npm ci
npm run dev          # open the printed URL
# Settings → Quality: ULTRA
```

Check, from these known-good positions (world X, Z):

* plaza `(18, 30)`, `(-18, 30)`, `(-30, 22)`, `(46, 12)`, `(7, -20)`
* overview `(30, 38)` at eye height +9 m
* docks `(-100, 100)` looking to `(-82, 96)`
* farms `(20, -96)` looking to `(2, -104)`
* street `(-66, 16)` looking to `(-118, 16)`
* grove `(-102, -68)` looking to `(-121, -80)`
* terrain `(152, 58)` at +14 m looking to `(96, 20)`

Specifically look for: white/blank terrain, inverted or flat roof slopes, faceted
trees, blown-out highlights, seams or stretched textures on walls, props intersecting
doorways, and any instance of the `THREE.WebGLProgram` shader-compile error in the
console (that is the failure mode a headless environment cannot catch).

---

## 5. Gameplay protection

* **Zero gameplay, networking, rules or balance files changed.** `git diff` touches
  only `src/world/*`, `src/entities/CharacterMesh.ts`, six lines of
  `src/core/GameEngine.ts` (quality visibility for `houseDetailGroup`),
  `scripts/headlessWorld.mjs` and tests.
* `server/multiplayerServer.mjs`, `shared/`, `src/network/` are untouched, so
  Battle Royale, FFA, TDM, late joining (FFA/TDM accept during active matches, active
  BR rejects), building, weapons, inventory, scoring, respawns and text chat keep
  their existing code paths.
* Collider count is **exactly 1,414**, unchanged. All new facade detail is
  visual-only and is not added to any collision set; `tests/graphics62.test.mjs`
  asserts this explicitly.
* Doors, ramps, rooftops, interiors, skybridges, loot points and combat routes are
  untouched by the visual pass.

---

## 6. Test / build results

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | clean, exit 0 |
| `npm test` | **131 / 131 pass, 0 fail** |
| `npm run build` | exit 0, `dist/assets/index-*.js` 1,203.39 kB (325.52 kB gzip) |
| `node scripts/visualAudit.mjs` | 709 draw calls, 518,860 tris, 1,414 colliders |

New suite: `tests/graphics62.test.mjs` (8 tests) covering shader-injection position
and composition, terrain-detail CPU/GPU constant parity, character harness attachment
and scale, parachute geometry/line connectivity/deployment, authored facade geometry,
and the collider-invariance contract.

---

## 7. Known remaining issues

* **No browser capture.** As above. Browser-level verification is outstanding.
* **District roof palette can still read as stylised.** A few layouts use very
  saturated `roofColor` values (`0xdb2777`, `0x6d28d9`) on roof slabs. That is the
  intended district identity, not a 6.2 regression, but on an overcast rig it is the
  loudest colour left in the scene.
* **Terrain noise tuning is shared between two implementations.** `offlineRender.mjs`
  ports the GLSL by hand; `tests/graphics62.test.mjs` asserts the constants match, but
  a future tuning pass must update both.
* The offline renderer is a verification aid only. It is not shipped and is not
  bundled into `dist/`.
