# CI CRAFT 3.4 — Mobile HUD redesign and retained visual polish

## Scope and safety

Delivered on `arena/a41a3d63-cinite`, continuing PR #7 from the completed 3.3 head `4e4b9b3`. The latest request prioritizes the mobile HUD. The visual/animation/world work already in progress was preserved, not discarded or represented as a separate completed graphics overhaul.

No merge, deployment, force-push, production database access, account/schema/API changes, replacement PR, weapon balance changes, or storm timing/damage changes. The nine-firearm catalogue and server inventory/hit validation remain unchanged. The generated collision manifest changes only for two new world benches.

## Mobile layout

- Coarse-pointer-only layout overrides. The actual rendered desktop HUD geometry is unchanged at 1440×900 and 800×600 compared with 3.3.
- Compact bottom-left joystick above a combined health/shield card; minimap and storm phase remain top-left.
- Compact right-edge primary FIRE/ADS pair and secondary jump, loot, reload and weapon-cycle buttons.
- A labelled **BUILD** button opens four pieces, material cycling and **BACK** in the same right-edge rail. This replaces the secondary combat buttons temporarily, rather than overlaying another full-width panel. FIRE and ADS remain available. BACK restores jump/loot/reload/swap; all five inventory slots remain available in either mode.
- Existing build behavior is unchanged: selecting a piece previews it; FIRE places it; tapping the selected piece again places it and exits preview. Selected pieces receive active/pressed accessibility state, and FIRE reads PLACE while previewing a piece. Closing the panel does not silently cancel a selected build.
- Five compact bottom slots and a lower-right weapon/ammunition/material strip. Portrait stacks health above the slots and exposes material counts with the build panel.
- Small translucent surfaces, consistent spacing, safe-area inset variables and viewport-relative sizing. Action and slot targets stay at least 44 CSS pixels; the fire target is larger. On very short landscape screens, the maximum button preference is capped to keep the expanded panel on screen.
- The mobile reticle is anchored at the actual viewport centre independently of prompt visibility. Pickup/loot notices are moved off the sightline. POI/elimination notices truncate long labels instead of growing over the reticle. The duplicate centre reload banner is suppressed on mobile; the existing ammunition-card reload timer/progress remains.
- Existing separate joystick/look pointer ownership, cancellation, sensitivity math and server-facing input callbacks are reused. New panel buttons support touch-down, compatibility-click deduplication and keyboard activation without stealing a look gesture.
- Existing landscape/fullscreen prompts, scrolling/zoom/selection guards and independent mobile actions are retained. No new keyboard entry is needed during gameplay.

### Local customization

The existing Settings screen now includes button size (85–115%), information scale (90–110%), default-open advanced build controls and reset. The existing touch camera sensitivity slider remains and is restored with these preferences.

There was no general persisted game-settings service to extend. `MobileHud` uses the application's existing guarded-localStorage approach with a dedicated `ci_craft_mobile_hud_v1` preference key. Values are whitelisted, bounded and checked for finite numbers. Malformed JSON, denied storage and write failures do not block gameplay. No credentials or gameplay state are stored. Reset restores the layout and touch camera defaults. HUD-only slider changes do not repeatedly reapply engine graphics settings.

## Retained 3.4 visual work

These changes predate the latest mobile-only focus and are included transparently:

- Shared concrete/metal/paint architecture finishes, adjusted glass and subdued daylight ground bounce/reflections. Two deterministic 32×32 textures total **8,192 bytes of source texels** before GPU overhead; no texture downloads or postprocessing pipeline were added.
- Batched contact shading at existing rooftop/interior props, small service labels, and two collision-backed service benches. Tower, Aurora floors, stair/roof routes, skybridges and loot definitions remain intact. Architecture has an explicit shared-resource disposal helper.
- Smooth velocity-based locomotion weights, a normalized Walk/Run/Sprint gait phase, exponential presentation blending, category-specific support grips, 140 ms weapon-switch presentation and reduced distant updates. Non-interacting characters beyond 190 m use a 5 Hz animation budget; interacting characters retain the prior 10 Hz distant budget. The procedural fallback uses the same distance policy. These are presentation changes, not hitbox or movement authority changes.
- Polymer/gunmetal material separation and restrained rarity emissive accents; two shared-geometry firearm microdetails, hidden at distance. Existing gun silhouettes, firing cadence, recoil, ammunition and server damage remain unchanged.
- Cached per-firearm procedural noise buffers and ended-node disconnection for fire/reload sounds; distinct SMG/pistol reload tones. No claim of recorded audio or auditory/device QA.
- Storm wall vertex-color/alpha height gradient using standard Three.js materials, optional decorative lattice, and terrain-relative final beacon. Both boundary rings and the server-owned storm simulation remain.

### Asset/explosion audit and deferrals

The unchanged `soldier.glb` is 2,160,468 bytes, with skins containing 49 and 2 joints, clips **Idle, Run, TPose, Walk**, and two textured materials. Additional action poses remain code-derived; no new mocap claim or asset replacement. The original acquisition/licence record remains an unresolved release gate documented in `public/models/ASSET_PROVENANCE.md`.

No authoritative projectile/explosion pipeline was found. Explosives are **deferred**: no client-only explosive weapon, blast damage or fake authoritative effect was added. Comprehensive new terrain/water art, destructive debris, full lobby art direction, GPU profiling and physical-device visual tuning also remain outside this mobile-focused delivery. Existing quality tiers, frame-time-driven adaptation, particle pools and world systems are reused.

## Validation

All final Node commands below ran with **Node 22.14.0**, matching the project pin.

| Check | Result |
|---|---|
| `npm run typecheck` | PASS, strict TypeScript |
| `npm run loot:check` | PASS: generated world/loot/catalogue consistency |
| `npm run build` | PASS, Vite 8.3.4; existing >500 kB chunk warning remains |
| `npm test` | **73/73 PASS**, 0 skipped; 59.414 s |
| `npm run test:mobile-hud` | **11/11 PASS** |
| Character + atmosphere focused tests | **14/14 PASS** |
| `npm run test:mobile-hud:browser` | **66 layout cases PASS**, touch/controller checks and two desktop comparisons PASS |
| `git diff --check` | PASS |
| Local built HTTP service | Root, `/health`, `/api/lobbies`, Soldier GLB, hashed JS and CSS all HTTP 200 |

The complete suite includes the existing authenticated four-human contested-loot/inventory/reload/consumable/swap/reconnect/final-standings test, human-only zero-bot gates, room capacity, lobby discovery/start/host transfer/closure, Tower provenance, collision/navigation/loot-clearance and world-budget regressions. No existing tests were removed or weakened. The historical mobile landscape formula tests remain; the new browser checks measure the current CSS rather than relying on those old formulas.

New unit coverage verifies preference normalization, malformed/denied storage, persistence, reset, pointer/click/keyboard panel handling, repeated mount/disposal, gait continuity, frame-rate-independent gait phase, distant animation budgets, shared weapon resources and deterministic/disposable architecture textures.

### Browser methodology

` scripts/mobileHud.browser.mjs ` uses Playwright Core and Chromium **153** installed outside the project. No production/development dependency or lockfile change was required. It loads the actual HTML, stylesheet, `MobileHud` and `MobileTouchControls`, intercepting the main game module and Vite HMR to isolate layout/input from WebGL. Native touchscreen taps exercise BUILD/BACK; browser-dispatched pointer streams exercise independent joystick/look/fire plus every action, five slots, four pieces, material cycling and cancellation. HUD taps must not add look events. Destroyed controllers must stop receiving input.

Actual bounding rectangles are checked for viewport containment, pairwise control/information/notice overlap, ≥44 px targets and an unobstructed, centred crosshair. Cases cover three size extremes and both collapsed/expanded build modes at:

- 568×320, 640×360, 800×360, 854×393, 915×412, 932×430, 1024×768;
- 844×390 with simulated 44 px left/right and 21 px bottom safe-area insets;
- portrait 320×568, 360×800 and 390×844.

The following is the **horizontal lane between joystick and action rail**, divided by viewport width, at default settings—not a claim that this fraction of every screen pixel is empty:

| Viewport | Clear horizontal lane |
|---|---:|
| 568×320 | 62.7% |
| 640×360 | 65.9% |
| 800×360 | 72.8% |
| 854×393 | 73.8% |
| 915×412 | 75.5% |
| 932×430 | 76.0% |
| 1024×768 | 78.1% |
| 844×390, simulated safe insets | 63.0% |

The desktop comparison renders both baseline 3.3 and current HTML/CSS at fine-pointer 1440×900 and 800×600, asserting identical HUD/control bounding rectangles.

To reproduce the optional browser harness with a running dev server:

```sh
npm install --prefix /tmp/hud-qa playwright-core @sparticuz/chromium
MOBILE_QA_MODULES=/tmp/hud-qa/node_modules npm run test:mobile-hud:browser
```

`MOBILE_QA_URL` can override `http://localhost:5173`. This sandbox needed the Chromium package's bundled AL2023 NSS/NSPR libraries extracted outside the repo and supplied through `LD_LIBRARY_PATH`; hosts with normal Chromium system libraries do not necessarily need that step. The optional browser dependencies and binary are not committed.

## Measurements

Headless full-world scene traversal counts geometry multiplied by instance count, not rendered draw calls or FPS:

| Measurement | 3.3 | 3.4 | Existing ceiling |
|---|---:|---:|---:|
| Mesh objects | 797 | **800** | 900 |
| Instanced triangles | 299,206 | **299,362** | 300,000 |
| Static colliders | 1,412 | **1,414** | 1,450 |

No budget increases. Particle capacity remains 180 at the high tier. No new dynamic lights or default postprocessing passes.

| Production artifact | 3.3 kB / gzip kB | 3.4 kB / gzip kB |
|---|---:|---:|
| HTML | 56.08 / 12.28 | **57.67 / 12.68** |
| CSS | 60.39 / 12.72 | **69.28 / 14.60** |
| JS | 1066.38 / 281.97 | **1074.44 / 284.77** |

Built HTTP smoke used isolated `/tmp/cinite34-local.sqlite` and a local process on port 2567. It did not touch Render or production data.

## Exact changed files

Mobile redesign:
- `index.html` — grouped existing controls, panel buttons and settings.
- `src/styles/main.css` — coarse-pointer layout, safe areas, states, notices and portrait rules.
- `src/ui/MobileHud.ts` — panel lifecycle and safe local preferences.
- `src/main.ts` — wire preferences and reset panel with existing transient-input lifecycle.
- `src/ui/HUDManager.ts` — selected build accessibility state and FIRE/PLACE label.
- `tests/mobileHud.test.mjs` — preference/panel/lifecycle unit tests.
- `scripts/mobileHud.browser.mjs` — optional actual-browser geometry/input/desktop regression harness.
- `package.json` — test scripts only; no dependency changes.

Preserved visual/world polish:
- `src/world/VisualAtmosphere.ts` — shared texture helper and daylight environment.
- `src/world/MapExpansionBuilder.ts` — finish batches, contact details, benches and disposal helper.
- `server/worldCollisionManifest.json` — regenerated bench collision geometry.
- `src/core/GameEngine.ts` — daylight/fill tuning and storm detail-quality hook.
- `src/entities/CharacterAnimation.ts` — continuous gait blend, phase and distance helpers.
- `src/entities/CharacterMesh.ts` — gait sampling, presentation timing, grip/material/detail throttling.
- `src/weapons/WeaponDefinitions.ts` — shared finish details/materials and support-grip coordinates; stats unchanged.
- `src/audio/SoundManager.ts` — firearm noise cache, fire/reload node cleanup and reload tones.
- `src/systems/StormSystem.ts` — standard-material wall gradient, lattice tier and beacon placement.
- `tests/characterUpgrade3.test.mjs` — gait/resource regressions.
- `tests/visualAtmosphere.test.mjs` — texture determinism/size/disposal regression.
- `docs/CI_CRAFT_3_4.md` — this report.

## Limitations / remaining release QA

- **No physical Android/iOS device, Safari/WebKit, real browser-bar transition, orientation-lock or device-notch test was performed.** Safe areas above are simulated CSS inputs.
- Browser assertions cover real DOM/CSS/controller behavior, not a four-browser rendered multiplayer battle. Authenticated multiplayer is covered by the Node integration suite. No WAN/jitter/load or touch-to-server latency measurements.
- No validated GPU/FPS gains, WebGL image-quality review, subjective camera-feel/audio assessment or full visual traversal/playthrough. The broader graphics work needs visual/device review before release.
- Button sizing respects minimum touch targets and short-screen caps; changing the slider can saturate those limits. Portrait remains a supported fallback, not the preferred combat layout. Unusually smaller viewports and accessibility zoom beyond the tested range need further QA.
- The earlier 3.3 movement-authority/lag-compensation limitations and Soldier licence gate still apply. No production deployment was performed.
