# CI CRAFT 7.0 — Next-Gen Graphics Master Upgrade

Base: `ca893d0` (CI CRAFT 6.2) · Branch: `arena/ce7751ae-cinite` · PR #15

---

## 0. Read this first: what was and was not verified

**No browser rendering was performed.** This sandbox has no browser binary, `apt-get`
is denied, and no accessible host serves a browser download
(`cdn.playwright.dev`, `storage.googleapis.com`, `playwright.azureedge.net` all
return `000`). **There are no in-game screenshots in this PR, and I am not claiming
that the graphics were verified in a running browser.**

What exists instead is `scripts/offlineRender.mjs`, a Node software rasteriser that
loads the **real** `IslandWorld` modules and walks the real scene graph. It is
faithful for silhouette, geometry, palette, texture scale and layout. It is **not**
the `WebGLRenderer`: it has no PBR specular, no shadow maps, no MSAA, no bloom. A
GLSL compile error would not show up in it — which is why `tests/graphics70.test.mjs`
validates the injected shaders against Three's real `ShaderChunk` library
(injection order, brace balance, declared-before-use) rather than trusting pictures.

Manual verification steps are in §7.

---

## 1. What was replaced (not re-tuned)

### 1.1 Vegetation — the single biggest visible defect

Measured baseline before editing: **32 triangles per broadleaf canopy** and **20 per
conifer tier**, drawn 4–6 m across. That is the literal "low-poly cone tree" the
brief calls out.

`src/world/VegetationGeometry.ts` (new) replaces them with authored procedural
geometry:

| Asset | Before (6.2) | 7.0 HIGH/ULTRA | 7.0 LOW/MEDIUM |
|---|---|---|---|
| Broadleaf canopy | 32 tris, 3 detached icosahedra | **180 tris, welded continuous shell**, 3 noise octaves + 3 azimuth lobes | 80 tris |
| Broadleaf trunk | 64 tris, no limbs | **116 tris**, buttressed taper, 3 branch limbs, root collar, bark noise | same |
| Conifer | 3 × 20-tri stacked cones | **~300 tris, ONE whorl-carved shell** (6 bough whorls, drooping tips) | 64 tris |
| Shrub | 20 tris | 100 tris, 5 noise-displaced lobes | same |

Two things matter more than the counts:

* **Silhouette.** The canopy is one welded shell, so its outline is as round as the
  surface subset that is kept. The previous approach — separate polyhedra — always
  shows its own polygon outline against the sky no matter how many are stacked.
* **Per-vertex canopy shading.** Every vegetation builder emits a `color`
  attribute: crown lift and outer exposure brighten the sun-facing leaf mass,
  interior and underside fall into leaf shadow. Without it a canopy renders as one
  flat green value and reads as plastic regardless of geometry.

Trees are yaw-randomised per instance (`variation * 2π`) so no two crowns share a
silhouette, and sized 2.0–2.9× with per-tree variation.

### 1.2 Water — depth-aware ocean

The old water was a flat, wobbling 1600 m plane: no notion of depth, so the
shoreline was a hard colour edge with no foam and no sun response.

`applyOceanShader()` in `VisualAtmosphere.ts` adds, with **zero extra draw calls and
zero extra geometry**:

* **Real depth.** A new `aOceanDepth` vertex attribute is baked at build time from
  the actual terrain heightfield (`water surface − terrain height`), so the sea
  knows exactly where the seabed meets the surface.
* Depth grading: turquoise lagoon → teal shelf → deep navy, blended with the
  authored per-vertex identity colour so CI CRAFT keeps its palette.
* Animated shoreline foam, thickest in the last 0.85 m of depth, driven by a
  travelling noise band — not a static ring.
* Three travelling wave trains displace the surface and perturb the normal
  analytically (same derivative, so geometry and lighting agree). Waves are damped
  to zero at the waterline so the shore never tears.
* Capped Fresnel sky lift plus a tight specular lobe for sun glitter. The Fresnel
  term is clamped to 0.55 specifically so water can never blow out into a white band
  that a player could mistake for cover or an enemy silhouette.
* The whole plane no longer bobs up and down (the old `position.y = sin(t)` made
  the entire ocean pump as one slab); the wave clock is driven per-vertex instead.

### 1.3 District architecture — faceting removed

The shared `cylinder` primitive was **10 radial segments** and the `cone` **8**. On a
3.4 m silo, a water tower or a 12 m landmark these flat panels *are* the silhouette.
Raised to 18 / 14 (≈1.5 k triangles across every instance), plus the 11 geometrically
large landmark cylinders (silos, water towers, lighthouse, hay bales) raised from
12–14 to 20–24 segments. This is the fix for the visibly faceted cylinder in the
before/after pair.

### 1.4 Real quality tiers (LOD), not labels

Vegetation now has two geometry tiers sharing identical instance matrices and
materials:

* `treeLodHighGroup` — detailed canopies/conifers, shown on **HIGH/ULTRA**
* `treeLodLowGroup` — 80/64-face twins, shown on **LOW/MEDIUM**

Switching tiers is a visibility swap: no rebuild, no allocation, no change to
collision, harvesting or destructible state. `syncTreeLod()` re-syncs the coarse
twins when a tree is felled or respawns. `auditTreeLod()` (used by four test suites)
verifies every instance matrix matches between tiers.

Combined with the existing decorative tier, the measured result is:

| Tier | Triangles |
|---|---|
| LOW / MEDIUM (total) | **320,030** |
| HIGH / ULTRA always-on | **~327 k** |
| HIGH / ULTRA total | **576,900** |

For reference, 6.2's always-on tier was 305,226. LOW is **+4.8 %** on 6.2 while
gaining round cylinders, and every vegetation upgrade sits behind the high tier.

---

## 2. Rendering correctness bugs fixed

These were found by inspecting the actual render path, not by tuning sliders.

1. **Offline renderer replaced instance colour with vertex colour.** Three.js
   *multiplies* `instanceColor × vertexColor` into `vColor`; the rasteriser was
   substituting one for the other. As soon as a geometry carried a colour attribute
   every tree lost its leaf/trunk tint and rendered white. Fixed to multiply. This
   was an evidence-fidelity bug in the verification tool, not in the game.
2. **Trunk geometry violated its instancing contract.** Trunks are instanced at
   `y = trunkH / 2` with `scale.y = trunkH`, which assumes the geometry spans
   exactly `[-0.5, 0.5]`. The new limbs overshot that range, shifting every tree down
   by half its height so canopies appeared detached and floating. The builder now
   normalises into the unit envelope, and `tests/graphics70.test.mjs` asserts the
   invariant so it cannot silently regress.
3. **Canopy instance cursors desynced.** The colour pass still advanced two colours
   per broadleaf tree after the transform pass moved to one, so half of all canopies
   kept an identity matrix (invisible) and the rest were misaligned. Both passes now
   advance by exactly one.
4. **`graphics62.test.mjs` never ran.** It was never added to the `npm test` file
   list, so the entire 6.2 contract suite — including the shader-injection
   assertions — had never executed in CI. Added, along with the new 7.0 suite.
5. **Triangle audits counted hidden meshes.** With visibility-based LOD, counting
   invisible meshes reports draw calls the GPU never sees. `visualAudit.mjs` and the
   test helpers now respect effective visibility.

---

## 3. Performance measurements

Consistent conditions: same machine, `IslandWorld.generate()` + a full scene walk,
`scripts/visualAudit.mjs` and a direct measurement probe.

| Metric | 6.2 | 7.0 | Δ |
|---|---|---|---|
| Draw calls / meshes (HIGH) | 709 | **705** | −4 |
| Instanced batches | 183 | 183 | 0 |
| Triangles (HIGH/ULTRA) | 556,500 | **576,900** | +3.7 % |
| Triangles (LOW/MEDIUM) | 310,606 | **320,030** | +3.0 % |
| Unique textures | 40 | **39** | −1 |
| Texture memory | ~19 MB | **19.2 MB** | ≈0 |
| World generation | 1,755 ms | **2,591 ms** | +836 ms |
| Gameplay colliders | 1,414 | **1,414** | 0 |
| Production bundle (gzip) | 325.5 kB | **328.9 kB** | +3.4 kB |

Generation cost rose because vegetation and water depth are now built rather than
being trivial primitives. +0.8 s is paid **once per world load**, not per frame, and
is inside the existing `generationMs < 6000` budget.

No budget was raised arbitrarily to make a test pass: the LOW/MEDIUM and HIGH/ULTRA
ceilings were set from the measured values with the justification recorded in the
test files.

The three budget tests (`worldExpansion`, `worldBranding`, `polish35`,
`graphics61`) were rewritten to use `tests/helpers/sceneStats.mjs`, which measures
**per quality tier** and accounts for hidden LOD twins — the previous
single-number budget was measuring geometry that either tier does not draw.

---

## 4. Gameplay preservation

Diff touches **only** `src/world/*`, `src/core/GameEngine.ts` (8 lines of
quality-tier visibility) and test/script files. `server/`, `shared/`,
`src/network/`, `src/systems/` and `src/weapons/` are byte-identical.

* Colliders **exactly 1,414** (asserted by `graphics62` and `graphics70`).
* 290+ harvestable trees/rocks unchanged; LOD never touches destructible state.
* BR storm/loot/elimination/victory, FFA (10 min, first to 50, highest on expiry,
  respawns, late join), TDM (RED vs BLUE, 10 min, first to 50 combined, draw on tie,
  late join with server team balancing), text-only draggable chat, building and
  resource validation — all code paths untouched.
* Mobile controls, HUD and touch handling untouched.

---

## 5. Test / build results

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **clean, exit 0** |
| `npm test` | **146 / 146 pass, 0 fail** |
| `npm run build` | **exit 0**, `index-*.js` 1,215.27 kB / 328.86 kB gzip |
| `node scripts/visualAudit.mjs` | 705 draw calls, 576,900 tris, 1,414 colliders |

Test count went 131 → 146, entirely from the two new suites now actually running
(`graphics62`, 8 tests) and the new `graphics70` (7 tests).

`tests/graphics70.test.mjs` asserts:
* canopies are welded/indexed shells with real shading variance (not flat colour);
* trunk geometry stays inside its instancing envelope;
* LOD twins share every instance matrix and cover all 250+ trees;
* LOW draws <65 % of HIGH;
* ocean shader compiles, keeps brace balance, declares before use, caps Fresnel, and
  exposes a drivable clock;
* the water mesh's depth attribute varies from below-zero to >3 m with a real
  shoreline band;
* colliders and harvestables are unchanged.

---

## 6. Environment

No external assets were added. Everything is authored procedurally in-repo (integer
PRNG + value noise), so there is nothing to licence, nothing to download, and no
fragile CDN URL. `public/models/soldier.glb` remains the only packaged model and is
already recorded in `ASSET_PROVENANCE.md`.

---

## 7. Manual verification (please run)

```bash
git checkout arena/ce7751ae-cinite
npm ci
npm run dev          # open the printed URL
# Settings → Quality: ULTRA, then again on LOW to compare tiers
```

Known-good positions (world X, Z, camera at eye height unless noted):

* street `(-66, 16)` → look toward `(-118, 16)` — **vegetation** (densest trees)
* grove `(-102, -68)` → `(-121, -80)`
* terrain overview `(152, 58)` at +14 m → `(96, 20)`
* keep `(-30, -46)` → `(0, 0)` — **silo/cylinder faceting**
* plaza `(18, 30)`, `(-18, 30)`, `(46, 12)`
* docks `(-100, 100)` → `(-82, 96)` — **water + shoreline foam**

Things to check that this environment cannot:

1. **Shader compilation.** Open the console; there must be no
   `THREE.WebGLProgram: shader error`. This is the main risk for the ocean shader.
2. **Ocean.** Shoreline foam should hug the sand and fade with depth; the horizon
   should not be a white band. Verify on LOW too (the shader is tier-independent).
3. **Vegetation tiers.** Switch ULTRA → LOW; canopies should coarsen but **not**
   shift, vanish or duplicate.
4. **Shadows.** Detailed canopies cast tree shadows on HIGH/ULTRA only in this pass;
   confirm no shadow acne on the new conifer shells.
5. **Frame time.** The triangle increase is +3.7 %; confirm on a mid-range phone that
   LOW holds its existing frame rate (draw calls are unchanged at 705).

---

## 8. Remaining limitations

* **No browser verification** (§0). This is the single largest outstanding gap.
* **Buildings were not rebuilt again in 7.0.** The 6.2 modular facade kit (real
  window reveals, sills, lintels, portals, plinth, cornice, gutters, gabled/flat
  roofs with coping) is genuinely authored geometry and was not the weakest visible
  element at gameplay range; the weakest were vegetation and the faceted district
  cylinders, so effort went there.
* **Character/weapon geometry is unchanged in 7.0.** The 6.2 harness pass and the
  existing weapon hardware were kept. A GLB-based operator replacement was
  considered, but no suitable asset could be sourced in this environment (no
  outbound access to asset hosts), and fabricating one would violate the brief. The
  procedural character remains, with its known ceiling.
* **Animation, camera and post-processing were not modified.** They are working
  systems and the brief prioritises visible asset improvement; changing them without
  in-browser verification would risk regressions I could not see.
* **Terrain remains one 208×208 mesh.** Fine surface detail is shader-based
  (ground-detail noise + normal/roughness maps); true layered splat mapping across
  sand/grass/soil/stone would need a multi-texture shader and is the next logical
  step.
* **Generation time rose 836 ms** (one-off, per world load).
