# CI CRAFT 3.5 — Battle Royale polish

## Scope / preservation

Incremental work on `arena/a41a3d63-cinite`, continuing open PR #7 from 3.4 commit `e7dfd9211fcdf5228236b5cf1763f1259aa85647`. This is a bounded polish pass, not a replacement engine or a claim of AAA production readiness.

The audit followed the existing client/server combat event path, inventory/loot authority, storm simulation/presentation split, camera recoil/aim rays, HUD/input lifecycle, architecture batching, Tower effects, audio/particle ownership and tests. Authentication, databases, APIs, lobby discovery, authoritative inventory/ammo/pickups/building/damage/results, weapon statistics and eight-phase storm schedule are unchanged. No server source, generated catalogue/collision/loot manifests, external model, texture or production configuration changed.

No merge, deployment, force-push or replacement PR.

## Actually implemented

### Confirmed combat and readable feedback

- Remote `weapon_fired` endpoints no longer fabricate impact bursts. They still drive shot sound, tracer, casing and weapon animation; accepted hit/build events own impacts.
- Accepted/deduplicated hit events retain the existing authority path. Third-party hit effects and sound use bounded spatial gain over 96 m; distant unrelated shield breaks no longer play at full volume. Local victim/attacker confirmation is retained. Storm damage does not emit flesh/shield bullet impacts.
- Compact warm-white health-hit marker; shield-break presentation takes precedence over the headshot marker while the badge can still report both. Existing cyan shield and elimination feedback remain.
- Health, shield and storm damage use distinct edge-vignette colours. Shield/body damage-taken tones are now distinct original procedural sounds; existing per-weapon firing/reload and surface-impact profiles are retained.
- Added ended-node disconnection for damage, shield-break, surface-impact, hit-confirmation and storm-warning voices. No downloaded or unverified audio.
- Damage labels are capped at 24, or 12 with reduced motion. Killfeed rows and their expiry timers are bounded to five; reset cancels outstanding timers.
- Elimination/killfeed names are rendered with text nodes, not interpolated HTML. Match-total kills now read “N ELIMS,” rather than falsely describing totals as timed double/triple/quad-kill streaks.

No damage, cadence, recoil pattern, spread, hit validation, ammunition, firing/reload duration or weapon switching authority was changed. Existing 3.4 weapon kick, blended animation, grip, muzzle and reload/switch presentation is preserved rather than replaced.

### Accessibility without an aim advantage

- A saved **Reduced motion (all devices)** checkbox in the existing Settings screen. It initially follows `prefers-reduced-motion`; an explicit choice persists using the existing guarded local HUD preference key. Reset returns to the OS preference.
- Suppresses camera hit/FOV impulses, cosmetic breath sway and camera-position shake, freezes storm decoration animation, suppresses victory confetti/CSS animations and damage-number drift/pop. Readable hit/damage feedback remains.
- Actual aim recoil, aim rays, sensitivity, movement, weapon kick and combat authority are not scaled. Tests compare normal/reduced-motion camera yaw, pitch, recoil offsets and aim rays under identical shot randomness.
- No new permanent gameplay button. Existing five slots, compact joystick/right-edge controls, collapsible BUILD panel, safe areas, scale/sensitivity preferences and pointer isolation remain.

### Atmosphere, landmarks and navigation

- The visible sky now uses the same authored day/sunset/night zenith, horizon and ground palette as the environment lighting. Preset changes repaint existing sky vertex colours once; no new shader, texture download, postprocessing or per-frame sky buffer upload.
- **34 shared, instanced paint markings** identify existing Tower stair treads/landings and Aurora entrances. They are depth-tested, non-shadow-casting surface paint, not physical obstacles or through-wall loot indicators. Optional end-tread markings buried beneath later landing decks are rejected against the completed walkable geometry.
- Existing Tower vault light receives a restrained 71–85 intensity pulse and is omitted beyond 100 m or when low/adaptive detail disables it. Existing vault particles are limited to 90 m/detail-enabled views. The existing distant gold/cyan beacon and silhouette remain visible. No new light or shadow caster.
- No walls, floors, doors, roofs, stairs, skybridges, collider footprints or loot placements moved. No additional loot visibility or ownership mechanism was introduced.

### Storm and match presentation

- Edge-triggered NEW ZONE, CLOSING, OUTSIDE, SAFE AGAIN and final-hold messages reuse the storm readout. The first sample after reset is silent; repeated frames do not retrigger notices.
- Phase/countdown readout updates at 5 Hz with text writes only when changed. Concise NEXT IN/CLOSING labels fit the compact mobile panel. Countdown zero reads DROP!, not an invented extra second.
- Final-zone/outside-storm guidance shows distance to the target safe circle and a world-compass direction, derived from the current authoritative state. The existing cyan beacon remains terrain-relative and depth-tested.
- Brief original two-tone endgame ambience on actual phase transitions into phases 6–9. It has a bounded 0.62-second voice lifetime, rate limiting, mute/volume handling and ended-node cleanup; it is not a persistent music loop.
- Final standings highlight the supplied local participant and supplied first-place row. Participant filtering, placement order, winner name and elimination totals still come from the existing server result path. No synthetic winners, counts or standings.

### Resource stability

- Particle burst requests now clamp the *incoming* count to the active quality budget. Previously one oversized request could exceed the nominal cap even after trimming existing particles.
- Added explicit, idempotent particle final teardown: clear active effects, dispose pooled materials and shared geometry once, and prevent spawning after disposal. Normal match resets still use `clear()` to reuse bounded pools.
- Storm teardown is idempotent; disposed systems cannot advance state or revive visuals.
- No extra render loop or recurring audio loop. World lifetime resources remain shared; this is not a new global engine teardown implementation.

## Validation — final results

Final validation used **Node 22.14.0**, matching the pin; production build uses Vite 8.3.4.

| Command / check | Result |
|---|---|
| `npm run typecheck` | PASS, strict TypeScript |
| `npm run loot:check` | PASS; all generated manifests/catalogue unchanged |
| `npm run build` | PASS; existing >500 kB chunk warning remains |
| `npm test` | **81/81 PASS**, 0 skipped; final run 64.241 s |
| `node --test tests/polish35.test.mjs tests/mobileHud.test.mjs` | **12/12 PASS** |
| Focused world/atmosphere/evolution tests | **13/13 PASS** |
| `npm run test:mobile-hud:browser` | **66 layout cases PASS**, two desktop comparisons and real-HUD presentation assertions PASS |
| `npm run test:game:browser` | Built Low-preset local Solo startup PASS in software WebGL |
| Local HTTP smoke | Root, health, lobby list, Soldier GLB, final hashed JS/CSS all HTTP 200 |
| `git diff --check` | PASS |

The full suite includes authenticated four-human contested loot, private inventory, reload/use/swap, reconnect and final standings; authoritative damage/elimination/victory regressions; human-only zero-bot gates; lobby discovery/start/host transfer/closure; Tower provenance; navigation/loot clearance and geometry budgets. No existing test was deleted or weakened. The previous preference-normalization expectation was extended for the new persisted boolean.

New Node coverage includes confirmed feedback classification, spatial gain bounds, no fire-only impact/marker calls, storm notice edges, cardinal guidance/countdown, recoil invariance, oversized burst limits, repeated clear/dispose, non-mutating storm presentation, mocked WebAudio voice cleanup/mute, supported navigation markings, landmark quality/range bounds and OS/saved accessibility preference handling.

### Browser coverage and boundaries

The layout harness uses actual HTML/CSS, `MobileHud` and `MobileTouchControls`, not a newly mocked HUD. It deliberately intercepts the main game module for isolated layout/input tests. It exercises native BUILD/BACK taps and browser-dispatched independent movement/look/fire/action pointer streams, every inventory slot and build piece, cancellation and listener disposal.

The **66 cases** are 11 viewport/inset configurations × three size settings × collapsed/expanded BUILD:

- Landscape: 568×320, 640×360, 800×360, 854×393, 915×412, 932×430, 1024×768.
- 844×390 with simulated 44 px left/right and 21 px bottom safe insets.
- Portrait: 320×568, 360×800, 390×844.

Checks include actual rectangle containment, pairwise control/info/notice overlap, ≥44 px touch targets and a centred, unobstructed crosshair. Default horizontal lane remains **62.7% at 568×320** and **72.8% at 800×360**. This is the gap between joystick/action rails, not a percentage of all screen pixels. Fine-pointer HUD geometry is identical to 3.4 at **1440×900 and 800×600**.

The extended harness instantiates the real `HUDManager` to check marker priority, safe hostile-looking names, truthful total-elimination text, damage/feed caps, reset cleanup, no reduced-motion confetti, supplied standings, zero countdown, phase transitions, guidance, unclipped readout and non-mutating storm state. Fixture standings are test-only and never shipped as game results.

A separate **built-game** smoke uses the real entry point, software WebGL and local HTTP backend at 844×390, selects Low graphics, starts Solo, waits for the actual countdown/phase-one HUD, opens/closes BUILD, confirms five slots and OS reduced-motion application, and asserts no captured page/Three.js/WebGL/shader errors. Final output: `PHASE 1 · NEXT IN`, health `100 / 100`, five slots. This is a startup smoke, not a visual-quality review or full multiplayer browser playthrough.

Two exploratory Auto-preset software-WebGL runs did not finish countdown within a 20-second wait (one remained at “1,” with no captured page/shader error). The successful Low smoke uses a bounded 45-second countdown wait because software rendering and simulation dt clamping make wall-clock startup slow. This **does not establish acceptable startup or FPS on real hardware**; Auto/Medium/High and mid-range phones still need profiling.

Optional browser dependencies remain outside the repository; no dependency or lockfile change:

```sh
npm install --prefix /tmp/hud-qa playwright-core @sparticuz/chromium
# Run npm run dev separately for the layout harness.
MOBILE_QA_MODULES=/tmp/hud-qa/node_modules npm run test:mobile-hud:browser
# Run a local built server with isolated SQLite for the startup harness.
MOBILE_QA_MODULES=/tmp/hud-qa/node_modules npm run test:game:browser
```

`MOBILE_QA_URL` and `GAME_QA_URL` override the defaults (5173 and 2567). This sandbox used Chromium 153 and the package's bundled AL2023 NSS/NSPR libraries through `LD_LIBRARY_PATH`, as documented in the 3.4 report. No production endpoint was contacted. The existing isolated temporary SQLite local preview was reused.

## Measurements

### World / artifact budgets

Scene mesh/triangle traversal multiplies geometry by instance count; it is not a rendered draw-call or FPS measurement.

| Measurement | 3.4 | 3.5 | Existing ceiling |
|---|---:|---:|---:|
| Mesh objects | 800 | **802** | 900 |
| Instanced triangles | 299,362 | **299,430** | 300,000 |
| Static colliders | 1,414 | **1,414** | 1,450 |
| New surface-paint instances | — | **34** | — |
| High-tier particle cap | 180 | **180** | 180 |

No budget increases; **570 triangles remain** under the world ceiling. New paint uses existing shared plane geometry and paint material. The catalogue, collider manifest, loot registry and original asset hashes are unchanged.

| Built artifact | 3.4 kB / gzip kB | 3.5 kB / gzip kB |
|---|---:|---:|
| HTML | 57.67 / 12.68 | **57.96 / 12.79** |
| CSS | 69.28 / 14.60 | **70.03 / 14.77** |
| JS | 1074.44 / 284.77 | **1080.37 / 286.45** |

### Synthetic presentation CPU reference

`npm run benchmark:presentation` compares committed 3.4 with working 3.5 in the same Node process, using identical seeded four-shot-per-step particle/tracer input: 1,000 warmup and 2,000 measured 1/60-second simulation steps. Includes effect spawning and updating, excludes rendering/audio/network/gameplay. Both finish with 180 particles, 44 tracer meshes and 224 scene objects.

| Version | Mean ms/step | p95 ms | p99 ms |
|---|---:|---:|---:|
| 3.4 | 0.025718 | 0.030169 | 0.049845 |
| 3.5 | 0.025534 | 0.029680 | 0.050597 |

This is **essentially unchanged within microbenchmark noise**, not evidence of an FPS improvement. No GPU timing, battery/thermal or real-device frame-time claim is made.

## Exact changed files

- `index.html` — accessibility setting and storm live-region semantics.
- `package.json` — added regression, benchmark and optional browser smoke scripts; dependencies unchanged.
- `src/ui/combatFeedback.ts` — confirmed-hit classification, spatial gain, storm edge tracker, bearing/countdown helpers.
- `src/ui/HUDManager.ts` — marker priority, bounded DOM/timers, safe names, truthful totals, reduced-motion feedback, storm readout and standings highlights.
- `src/ui/MobileHud.ts` — OS-aware saved reduced-motion preference and callback.
- `src/main.ts` — connect the new presentation preference to existing settings.
- `src/network/schemas.ts` — optional client `GameSettings.reducedMotion`; no network authority/protocol change.
- `src/camera/ThirdPersonCamera.ts` — reduced-motion cosmetic camera controls, recoil untouched.
- `src/core/GameEngine.ts` — confirmed/spatial FX, accessibility/detail wiring, real-phase endgame cue/reset.
- `src/audio/SoundManager.ts` — shield/body tones, finite original endgame cue and ended-node cleanup.
- `src/systems/ParticleSystem.ts` — incoming cap, explicit idempotent final disposal and post-disposal guards.
- `src/systems/StormSystem.ts` — reduced-motion decoration and idempotent disposal.
- `src/world/TerrainGenerator.ts` — visible sky/environment palette coherence.
- `src/world/IslandWorld.ts` — existing Tower light pulse and landmark detail/range limits.
- `src/world/MapExpansionBuilder.ts` — shared supported surface paint at existing routes.
- `src/styles/main.css` — feedback/accessibility/result states and compact storm readout.
- `tests/mobileHud.test.mjs` — persisted/OS accessibility preference coverage.
- `tests/polish35.test.mjs` — seven focused combat/presentation/resource/world tests.
- `scripts/mobileHud.browser.mjs` — retained 66-case matrix, 3.4 desktop baseline, real-HUD presentation assertions.
- `scripts/smokeGame.browser.mjs` — optional actual built-game Low startup smoke.
- `scripts/benchmarkPresentation.mjs` — reproducible bounded synthetic CPU reference.
- `docs/CI_CRAFT_3_5.md` — this delivery report.

## Limitations / remaining QA

- No physical Android/iOS, Safari/WebKit, real notch/browser-bar/fullscreen/orientation-lock, battery or thermal tests. Simulated insets are not hardware safe-area validation.
- No four-browser rendered multiplayer battle, WAN/jitter/load or touch-to-server latency assessment. Socket integration tests and browser controller/layout tests cover different layers.
- No subjective gunfeel/audio assessment or complete visual traversal/playthrough. Low software-WebGL startup passed; Auto's short exploratory wait did not. Real-device startup/FPS profiling remains required.
- Existing 3.4 detailed materials, firearms, muzzle/reload/switch animations, storm beacon, lobby and city systems were reused. No new destructive debris, explosive weapon/projectile system, continuous musical soundtrack, broad environment rebuild or postprocessing was added.
- Soldier provenance is **still unresolved**. The unchanged file remains 2,160,468 bytes, SHA-256 `dfb230fc1f942f259dd00281a1186953ad602fc5d69067ce63e24b2aa439736b`; see `public/models/ASSET_PROVENANCE.md`. Source identification does not establish redistribution rights. No unknown third-party assets were downloaded.
- Earlier movement-authority/lag-compensation and deployment-release gates remain. This work does not claim to solve them.
- Validation above is local, not a claim of GitHub-hosted CI or production verification. Nothing was merged or deployed.
