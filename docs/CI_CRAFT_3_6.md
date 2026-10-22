# CI CRAFT 3.6 — $CI CITY WORLD-BRANDING

Date: 2026-10-22
Branch: `arena/a41a3d63-cinite`
Existing PR: [#7](https://github.com/daniel1996lowtec/-CINITE/pull/7)
Baseline: completed 3.5, `9515d83a1e094cd3a2dcfd31100df8d34c25a64a`

## Delivered

Branding is generated directly inside the existing `IslandWorld.generate()` path, after its original architecture is finalized. This is not a replacement map, alternate scene, UI overlay, or separate playable demo.

- **13 of 52 modular buildings (25%)** are selected, plus the existing Legendary Tower: **14 of 53 verified mountable buildings (26.4%)**. Selection is explicit and stable, distributed across ten existing districts. Bespoke original buildings remain untouched; this denominator is the shared modular-building registry plus the Tower, not every decorative structure on the island.
- **26 building-mounted signs/paintings and two road markings.** No new buildings, signposts, collision objects, light sources, or gameplay interactions.
- Exact text: **`$CI`, `$CI STREET`, `$CI PLAZA`, `$CI TOWER`, `CI DISTRICT`, `CI MARKET`**. No reversed `CI$`, digit substitution, or invented marketing copy.
- Dark navy, cyan, white and restrained metallic details for plaques. Dark petrol/cyan paint contrasts with the existing pale industrial walls. Only **two** commercial signs use restrained emissive material; no bloom, flicker, animation or lighting effects were added.

### Locations and styles

| Existing location | Treatment |
|---|---|
| `aurora_annex_avenue`, the existing x=97 north/south road | `$CI STREET` on west-facing walls at its north/south ends; additional approach-facing entrance plaques on Aurora Exchange's rear and the northeast tower's front; one north-pointing directional plaque at the Observatory; two smaller road stencils at z=-6 and z=-60, readable from opposite approaches |
| `aurora_northeast_tower` | `CI DISTRICT` above its existing entrance, alongside the south street-entry plaque |
| `aurora_exchange`, `aurora_observatory` | Two understated `$CI` neon-style entrance signs; two `$CI` rooftop signs mounted to **existing solid parapets**, not floating above the roofs |
| `plaza_market` | `CI MARKET` on the existing shop fascia and `$CI PLAZA` on the solid upper facade |
| `crossroads_shop` | `CI MARKET` on its existing fascia |
| `grove_south_shop`, `lake_east_shop`, `westlook_shop` | Smaller `$CI` entrance plaques on existing shop fascias |
| `plaza_depot`, `crag_harbor_warehouse` | Larger painted `$CI` on unobstructed upper facade fields |
| `docks_warehouse`, `silos_warehouse` | Industrial `$CI` stencil-style wall markings above rear glazing/doors |
| `westlook_shop`, `northeast_garage` | Two occasional rear-wall `$CI` graffiti marks, in closed centre bays with no rear doors |
| Legendary Tower | `$CI TOWER` on the four existing opaque entrance headers; no changes to Tower geometry, entrances, stairs, vault, loot or bridges |

Original POI identifiers, HUD location names and gameplay registries are retained. These are physical place-name/brand additions, not backend or map-ID renames.

## Implementation and safeguards

### Shared layout, actual support, correct orientation

`WorldBrandingLayout.ts` contains the exact strings, curated selection and fixed transforms, derived from the existing `WorldLayout` building dimensions, cardinal axes, floor heights and anchors. There is no client RNG, account preference, network fetch or time-dependent placement. Browser font rasterization can differ slightly by OS; text, transforms, selection and gameplay remain identical.

Each building label is a single outward-facing plane, 18 mm outside its opaque supporting surface. Its local right/up axes preserve normal reading order on north/east/south/west facades. Signs do not billboard or rotate toward the camera. Existing depth testing and fog apply, so text cannot reveal itself through buildings.

Five **existing** shop fascia boxes are reclassified from detail to essential; no boxes are added. This keeps their mounting surfaces present on Low/adaptive-reduced settings. The other mounts already use essential wall/parapet/header geometry. Keeping these five panels on Low retains up to 60 pre-existing instance triangles across the whole map; it does not increase the all-detail world triangle count or add a batch.

Road paint is clipped against the **actual indexed rendered terrain faces**, including cell seams, rather than placed on a guessed flat plane or the analytical collision-height function. Only the resulting tiny clipped patches are retained. A broad-phase rejection avoids allocating clipping vertices for distant terrain triangles. The south marking is beyond the existing intersection slab/curb, not underneath it.

### Rendering and resource lifetime

- One procedural **1024 × 1024** power-of-two CanvasTexture atlas; 13 designs, padded cells, standard system-font glyphs. No downloaded font, image, model or dependency.
- Estimated atlas GPU storage: **4 MiB base RGBA8, approximately 5.33 MiB with mipmaps**, excluding driver overhead; the CPU canvas also holds approximately 4 MiB of pixels. This is an estimate, not a GPU-memory profiler reading.
- Two shared standard Three.js materials: ordinary and restrained emissive. Alpha-tested rather than alpha-blended; front faces only; depth test on, depth write off, small polygon offset. No custom shader requirement or extra shadow caster.
- **18 district/design instanced batches plus two terrain-paint meshes**. Twelve shared unit-plane geometries and two clipped road geometries; no per-letter objects.
- Normal frustum culling and shared material/geometry reuse. No new frame-loop work, timers, event listeners, pooling demand or quality-dependent position changes.
- World-lifetime ownership: branding persists across rounds/settings changes. `dispose()` releases every owned geometry, instanced buffer, material and atlas once, removes its group and is idempotent. The generation hook disposes a previous branding owner before replacing it; this is not a claim that the entire legacy world generator supports arbitrary regeneration.
- Branding is not registered in bullet/pickup raycast lists, collision arrays, walkable surfaces, destructible registries or loot registries.

## Preservation evidence

A separately generated 3.5 baseline, loaded from the committed `9515d83` source, was compared with the new world. The serialized gameplay fingerprint is **identical**:

```text
d2b612956cdaca03533eb16628fce31fb28ceedbf4d3824e6a9655c99a194e4c
```

The fingerprint covers box/cylinder colliders, walkable bounds and sampled centre heights, chest/ground-loot spawn points, fixed Tower loot, vault items, and destructible IDs/types/health/positions. Existing exhaustive navigation/Tower/loot regression tests also pass; the hash alone is not a proof of every possible traversal.

No authentication, account, database, API, environment, Render configuration, lobby discovery, human-only room gate, Solo gate, authoritative combat/inventory/pickup, weapon balance, storm schedule, avatar or input/HUD implementation was changed. Existing Phase 1 through 3.5 work is retained. Explosives remain deferred; this task does not add a client-only explosive simulation. `soldier.glb` and its unresolved provenance documentation are untouched.

## Budgets and measurements

All original ceilings are unchanged.

| Generated world metric | 3.5 | 3.6 | Existing ceiling |
|---|---:|---:|---:|
| Mesh objects | 802 | **822** | 900 |
| Triangles, including instance counts | 299,430 | **299,506** | 300,000 |
| Box + cylinder colliders | 1,414 | **1,414** | 1,450 |

Net addition: **20 meshes, 76 triangles, zero colliders**. Of the 76 triangles, 52 are building planes and 24 are terrain-conforming paint. Remaining triangle headroom: **494**.

Actual `GameEngine` WebGL checks measured branding-group visible/hidden deltas at eight fixed views:

| View | Preset / viewport | Added draw calls | Added triangles | Changed pixels inside target bounds |
|---|---|---:|---:|---:|
| South street entry | High, 1280×720 | 8 | 46 | 2,098 |
| South street entry | Low, 844×390 | 8 | 46 | 716 |
| Plaza market | Low, 844×390 | 13 | 62 | 765 |
| Tower entrance | High, 1280×720 | 8 | 44 | 1,719 |
| Industrial painted facade | High, 1280×720 | 9 | 48 | 2,257 |
| South road paint | Low, 844×390 | 6 | 40 | 463 |
| North road paint | Low, 844×390 | 13 | 60 | 451 |
| North street entry | Low, 844×390 | 9 | 48 | 1,022 |

These are same-frame 3.6 branding-group on/off comparisons, **not** a 3.5/3.6 FPS benchmark. They exclude the Low fascia reclassification described above. Target-pixel comparisons prove that the intended markings actually render, not merely that their geometry is in the scene. Pixel counts are environment-dependent observations, not a typography/readability score. Ordinary scene objects can naturally occlude signs from some viewpoints; no sign is forced through foreground geometry.

One headless complete-world generation measured **541.21 ms**. A CPU-only branding-construction micro-measurement, using the actual terrain and 5 warmups + 20 measured constructions, returned median **3.74 ms**, p95 **4.49 ms**, range **2.39–5.01 ms**. Node has no Canvas2D/WebGL here: these timings exclude atlas rasterization, GPU upload and rendering, and are not mobile startup/FPS claims.

### Production build

| Output | 3.5 raw / gzip kB | 3.6 raw / gzip kB |
|---|---:|---:|
| HTML | 57.96 / 12.79 | 57.96 / 12.79 |
| CSS | 70.03 / 14.77 | 70.03 / 14.77 |
| JS | 1,080.37 / 286.45 | **1,088.09 / 289.50** |

JS delta: **+7.72 kB raw / +3.05 kB gzip**. Final assets: `index-DPYGO7T-.js`, `index-YGm874-g.css`. The existing >500 kB chunk-size warning remains; no limit was suppressed or changed.

## Validation — actual results

All commands used the required **Node 22.14.0**.

| Check | Result |
|---|---|
| `npm run typecheck` | PASS, strict TypeScript |
| `npm run loot:check` | PASS, generated registry unchanged |
| `npm run build` | PASS; existing bundle warning only |
| `npm test` | **87/87 PASS**, zero skipped, 62.284 s |
| Six new world-branding tests | PASS, also included in the full suite |
| Existing world/Tower/bridge/traversal/loot tests | PASS in the full suite |
| Existing authenticated four-human/contested inventory/pickup/reload/reconnect/elimination/results tests | PASS in the full suite |
| `npm run test:branding:browser` | PASS: eight actual-engine fixed-camera WebGL views, two viewport sizes, Low/High, actual target-pixel checks, no captured page/shader errors, `gl.getError() = 0` |
| `npm run test:mobile-hud:browser` | PASS: 66 layout cases, independent pointers/cancellation/actions/cleanup, existing real-HUD checks; desktop 1440×900 and 800×600 remain identical to the harness's 3.4 reference |
| `npm run test:game:browser` | PASS: actual built local Solo startup on Low, 844×390, phase HUD, health 100/100, five slots, BUILD/BACK and OS reduced-motion; no captured page/shader errors |
| Local built HTTP smoke | `/`, `/health`, `/api/lobbies`, `/models/soldier.glb`, final JS and CSS all **200** |
| `git diff --check`; syntax checks for new test/browser script and world loader | PASS |

### New regression coverage

1. Exact labels, unique IDs, existing building/street membership, 20–30% coverage, bounded special treatments and both street entrances.
2. Actual instanced matrices, non-mirrored orientation and **15 samples per sign on both High and Low**: 780 rays verify opaque supporting geometry and outward normals at the correct gap. Glazing, openings and missing Low-tier supports fail the test.
3. Road vertex/interior samples match rendered terrain and are not buried beneath existing architecture/curbs; normals, atlas UV bounds and original road bounds remain valid.
4. Frozen 3.5 gameplay fingerprint and unchanged original scene/collision ceilings.
5. Independent branding constructions produce identical instance matrices, road vertices and UVs under different RNG state.
6. Exact canvas text calls, one bounded atlas, two shared materials, no sign shadow casters, standard shaders, culling and once-only resource disposal.

The browser harness uses the **real `GameEngine`, world, renderer, lighting and quality settings**. Only its RAF callback is stopped inside the test to inspect fixed cameras. There is no shipped QA route or alternate scene. Captures are read immediately after rendering because production correctly uses `preserveDrawingBuffer: false`; delayed compositor captures initially produced blank/stale images and were not accepted as visual evidence.

Visual inspection also caught poor white-paint contrast on a pale warehouse and a south road marking beneath an existing curb. Paint was changed to dark petrol/cyan, the marking moved to the adjacent unobstructed original road surface, and the tests gained full-architecture support and target-pixel checks. Final captures were inspected after these corrections. No tests were weakened or existing thresholds increased.

## Files changed

- `src/world/WorldBrandingLayout.ts` — shared exact strings, curated mounts and existing road identities.
- `src/world/WorldBranding.ts` — procedural atlas, reusable instanced facade signs, clipped road paint and ownership/disposal.
- `src/world/IslandWorld.ts` — additive branding generation/lifetime hook.
- `src/world/MapExpansionBuilder.ts` — retains the five existing branded shop fascias on Low/adaptive detail.
- `scripts/headlessWorld.mjs` — loads the new real modules for every existing world/loot test and generator.
- `tests/worldBranding.test.mjs` — six focused regressions.
- `scripts/worldBranding.browser.mjs` — optional actual-engine WebGL/capture check; external QA browser packages only.
- `package.json` — includes branding tests in the full suite; adds focused/browser commands. No dependency or engine changes.
- `docs/CI_CRAFT_3_6.md` — this report.

## Reproduction and limitations

```sh
npm run typecheck
npm run loot:check
npm run build
npm test
npm run test:branding

# With Vite available on 5173 and the existing optional QA dependencies:
MOBILE_QA_MODULES=/path/to/qa/node_modules \
  npm run test:branding:browser
npm run test:mobile-hud:browser
# Actual built-game smoke also needs the isolated local server on 2567:
npm run test:game:browser
```

For this sandbox, the optional browser commands used `MOBILE_QA_MODULES=/home/user/browserqa/node_modules` and `LD_LIBRARY_PATH=/tmp/chromium-libs/lib`. The branding captures/atlas are in `/home/user/ci-craft-3-6-qa`; generated PNGs are not committed. `BRANDING_QA_OUTPUT` selects another capture directory. Local server testing used the pre-existing isolated `/tmp/cinite34-local.sqlite`, not production persistence.

- Browser evidence is **headless Chromium software WebGL**, not a physical Android/iPhone, Safari, real-GPU or sustained-FPS certification. The test context supported 8192-pixel textures; the atlas needs only 1024.
- Fixed-camera checks and a real Low startup do not constitute a complete rendered multiplayer playthrough. Physical-device readability/performance, touch playthroughs, WAN behavior and production deployment remain unverified.
- Distant or oblique small signs naturally lose readability; there is no zoom-independent/floating text or advantage-producing overlay. Some approach views include ordinary poles, canopies or stairs in front of signage. The QA checks do not promise unobstructed labels from every angle.
- Previous Auto/software-renderer startup limitations and unresolved soldier-asset redistribution provenance remain as documented in 3.5. Neither is claimed fixed here.
- No hosted PR checks are currently configured/reported (`statusCheckRollup: []` at verification); the results above are local checks.

**Delivery scope:** commit and normal push to the existing branch; update existing open PR #7. **No merge, deployment, force push, new PR, production setting or database change.**
