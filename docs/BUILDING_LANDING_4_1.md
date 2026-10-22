# CI CRAFT 4.1 — Building and landing

Date: 2026-10-22. Base: merged 4.0 (`84a87dd2684d11e7d2dfb9c8d9333eb968061669`).
Branch: `arena/6497ac93-cinite`. Review branch only: no automatic merge or deployment.

## Reproduction and root causes

Investigation and executable reproduction of the owner-build and elevated-floor failures preceded gameplay changes. `scripts/reproduce41.mjs` uses transpiled real game modules; the landing fixture isolates a real player-built floor, not a replacement physics implementation.

| Check | Before | After |
| --- | --- | --- |
| Deliver the builder's accepted `build_placed` event to world insertion | 0 callbacks | 1 callback |
| Fall from y=22 at -60 m/s, dt=0.1, through a floor whose top is y=20.29 | y=15.755, not grounded | y=20.29, grounded, vertical velocity zero |
| Descend onto generated solid parapet `wall_0`, top y=9.1 | y=8.37, still gliding, server position validation fails | lands at y=9.1, glider closes, server position validation passes |
| Real bundled Soldier rig after glide → grounded → two seconds idle | Returns to ready; no persistent additive-pose accumulation reproduced | Still returns to ready; ankle-joint height differs from baseline by under 0.00001 m in the diagnostic |

The parapet case was reproduced separately before adding solid-top support. Gliding also bypassed lateral collision resolution; bounded horizontal steps now use the existing collision solver for both grounded movement and gliding.

### Building path

1. Mobile BUILD opens the existing panel. A piece button selects its preview; a second selection or FIRE confirms. Desktop Q/E/C/V follow the same selection path. The existing pointer controller suppresses compatibility-click duplication.
2. `GameEngine` consumes the queued build input; `PlayerController` checks placement/materials. Solo inserts locally. Online intentionally creates **no predicted mesh/collider** and sends the request to the current room server.
3. The server validates the active participant/socket, finite coordinates, piece/material, request ID, distance, island bounds, occupied cell, limit and available materials. It subtracts 10 once, stores the accepted build and broadcasts to **all** players.
4. The bug was in receipt: `NetworkManager` discarded events owned by its own server player ID. Removing that exclusion lets the builder use the same existing idempotent insertion path as everyone else. `GameEngine` still rejects duplicate insertion by build ID.
5. The server replays surviving structures on reconnect, then reconciles environment health/destruction. Integration tests now verify replayed IDs and that a destroyed wall is not resurrected.

Additional corrections:

- Shared conservative envelopes reject intersection with static world solids on both preview/Solo and server paths. Destroyed static props are excluded. Existing intentional connections between player-built pieces remain permitted; duplicate piece/type cells remain forbidden.
- Bottom-contact tolerance is 0.26 m because the existing half-metre grid may round a supported base downward by up to 0.25 m. Side/ceiling intersection tolerance is only 0.04 m. Ramp/roof envelopes are conservative, not exact boolean-volume intersection tests.
- Rotation is normalized before placement calculations and acceptance serialization; repeated camera turns cannot change accepted geometry through yaw clamping. Cardinal snapping is retained.
- Rejections now have explicit messages. Invalid/occupied positions, insufficient resources, glide-time attempts and disconnected online submission produce feedback and retain a usable preview. Solo does not report a spurious connection error.
- Holding a build hotkey cannot turn its key-repeat events into placement confirmations.
- Existing selected-material fallback, 10-material cost, wood/stone/metal health, 2 m horizontal grid, 0.5 m vertical grid, 3.5 m reach offset and 600-piece server limit remain intact.

The initially suspected client/server terrain-height discrepancy was **not confirmed**. The server manifest already quantizes terrain to the same half-metre grid. The original height policy is retained, not arbitrarily changed.

### Landing and presentation

- Vertical contact queries use the pre-integration foot height, so a descending step cannot skip a crossed support plane merely because the new position is more than 1.35 m below it.
- Rising jumps no longer snap upward onto an overhead floor. Grounded step assistance is bounded separately from airborne contact.
- Existing solid box/cylinder tops can provide support, including parapets and props that previously had side collision but no named walkable surface. Support uses the character footprint at edges. No meshes or map layout were changed.
- Horizontal motion is split into at most 0.25 m steps through the existing solver, retaining the grounded collision radius, to avoid skipping thin walls during fast glide/sprint frames.
- Ramp support matches the rotated slab thickness, orientation, upper-face offset and real footprint. Roof support matches the square cone slope and visible ridge cap. Raycasts against the real meshes verify those surfaces at cardinal orientations.
- Remote ground contact follows interpolated foot arrival rather than immediately switching to landed while the displayed character is still above its authoritative ground position. Grounded targets do not extrapolate stale vertical velocity into the floor. Initial remote y=0 no longer incorrectly becomes y=6.
- Landing clears vertical velocity and uses the existing finite landing transition. The actual GLB is tested at 30/60 Hz and near/far animation LOD through glide/fall → land → idle/run. Bone quaternions remain finite; the existing additive layers settle and body scale returns to normal.
- **No hard-coded mesh/root snap, rig replacement, asset change, invented animation, or cosmetic-only physics workaround.** `CharacterMesh.ts` and `CharacterAnimation.ts` were deliberately left unchanged because their existing reset/blend safeguards passed the real-asset recovery measurements.

## Validation

Pinned Node **22.14.0**. Final full suite: **115/115 passed**, 68.961 seconds; 12 new focused tests are included in `npm test`.

| Command / scope | Result |
| --- | --- |
| `npm test` | 115 passed, 0 failed/skipped/cancelled |
| `npm run test:gameplay41` | 12 focused regressions passed |
| `npm run typecheck` | PASS, no broad `any` or suppression added |
| `npm run loot:check` | PASS; generated world/loot catalogue unchanged |
| `npm run build` | PASS; existing >500 kB bundle warning remains |
| Syntax checks for changed server/shared/browser/diagnostic modules | PASS |
| `git diff --check` | PASS |
| Existing `mobileHud.browser.mjs` | 66 responsive cases; independent pointers, cancellation, panel isolation and cleanup; desktop geometry comparisons PASS |
| Existing `menu4.browser.mjs` | 57 actual compiled-app menu/name/layout checks PASS |
| Existing `textChat.browser.mjs` | 96 responsive + 2 desktop cases PASS |
| Existing `textChat.game.browser.mjs` | Compiled app + real server, rendered mobile host + 3 authenticated peers + separate lobby; chat/isolation/four-human checks PASS, no captured errors |
| New `gameplay41.browser.mjs` | Real Vite game + real server; natural glide landing; all four accepted owner meshes and collision/support geometry; receipts at all peers; exactly 4 placement requests and 40 wood spent; portrait occupied-cell rejection/preview retention, held-key protection and chat isolation PASS, no captured errors |

The four-human server integration additionally covers every piece, duplicate request IDs/cells, explicit insufficient-material rejection, no duplicate debit, authoritative harvesting/damage, reconnect replay, and existing inventory/reload/loot/identity behavior.

Browser harness details: the new gameplay harness exposes the real running engine **for inspection only** through a test-time route transformation. It does not pause RAF, set player positions/materials, fabricate acknowledgments, mock sends, or bypass validation. It steers away from random tower deployment footprints using actual keyboard input, and uses real touch taps for selection/confirmation. The separate compiled-game/chat harness has no source transformation. Neither constitutes four simultaneously rendered devices.

Optional browser tooling is installed outside the repository; no runtime or package-lock dependencies changed. The existing HUD comparison requires historical commit `e7dfd9211fcdf5228236b5cf1763f1259aa85647`; the shallow checkout needed that commit fetched for the unchanged test to run.

Workspace evidence: `/home/user/gameplay41-evidence/` contains the final test/build/browser logs, `reproduction-after.txt`, `gameplay41-browser.json`, and `builds-portrait.png`. Generated bundles, test databases and screenshots are not committed. Earlier failed browser attempts were useful diagnostics (blocked random spawn, undisposed portrait prompt, and asynchronous frame timing); final runs above are the passing results.

## Exact changed files (17)

Production:

1. `src/main.ts` — suppress repeated build-hotkey confirmations.
2. `src/core/GameEngine.ts` — wire rejection feedback/preview recovery; reuse existing accepted-build feedback.
3. `src/entities/PlayerController.ts` — swept vertical support, bounded horizontal collision, local failure feedback.
4. `src/network/NetworkManager.ts` — owner ACK delivery, rejection messages, connection checks, contact-aligned remote state and zero-height initialization.
5. `src/world/IslandWorld.ts` — shared static placement checks, yaw normalization, solid-top support, accurate ramp/roof support and wall tops.
6. `server/multiplayerServer.mjs` — explicit authoritative rejection, socket ownership/static collision validation, normalized accepted yaw.
7. `server/worldGeometry.mjs` — normalized transform and shared placement validation against live static solids.
8. `shared/buildPlacement.mjs` — shared yaw/envelope/intersection helpers.
9. `shared/buildPlacement.d.mts` — strict TypeScript declaration for the shared helper.

Tests/tooling/documentation:

10. `tests/gameplay41.test.mjs` — 12 controller/world/network/real-rig regressions.
11. `tests/helpers/gameplayModules.mjs` — reusable real-module loader, player fixture and bundled-GLB loader.
12. `tests/humanOnly.integration.test.mjs` — extend existing four-human authority test with all-piece receipts, spending/rejection and replay checks.
13. `scripts/gameplay41.browser.mjs` — real touch-game/server regression harness.
14. `scripts/reproduce41.mjs` — inspectable owner-ACK/floor-contact/rig diagnostic.
15. `scripts/headlessWorld.mjs` — resolve the new shared import in existing world tooling.
16. `package.json` — include focused tests and optional browser command; dependencies unchanged.
17. `docs/BUILDING_LANDING_4_1.md` — this report.

## Preservation and remaining checks

No changes to 4.0 menu markup/CSS, account/database schema, display-name persistence, chat implementation, weapons, storm phases, loot definitions, world layout/branding, deployment settings or environment configuration. Existing tests for these systems remain enabled. No voice, microphone/WebRTC feature, new audio asset, dependency or unrelated gameplay system was added.

Not claimed: physical iPhone/Android/Safari success, hardware-keyboard/OS-keyboard behavior, real network latency/loss, four rendered-device performance, mobile FPS, or live Render/WAN deployment verification. Software Chromium is functional automation, not a hardware performance benchmark. Conservative collision envelopes can reject tight fits near static scenery; that should be checked on representative phones/maps before release.

### Real-phone release checklist

Use at least iOS Safari and Android Chrome, with four authenticated humans in the same match:

- [ ] Portrait and landscape: open BUILD/BACK, select each piece, inspect preview, confirm once with the piece button and once with FIRE. One confirmation must produce one build and one 10-material debit.
- [ ] Verify all four players see each accepted structure at the same location/orientation. Walk against walls and onto floors/ramps/roofs; reconnect an observer and verify persistence and damage state.
- [ ] Rotate the camera through several full turns and test cardinal placement. Check near terrain slopes, buildings, parapets and the island edge. Invalid/red placement must not spend materials.
- [ ] Exhaust materials, use the existing selected-material fallback, retry an occupied cell and disconnect/reconnect while building. Verify useful feedback and no phantom structure/debit.
- [ ] Hold joystick while selecting/confirming; hold FIRE while another pointer operates controls; cancel fingers or rotate mid-gesture. Verify no stuck movement, unexpected shots or duplicate builds.
- [ ] Open/drag/collapse chat and type build hotkeys. Open pause/settings/other overlays. Verify no gameplay leakage; retain names and four-human lobby readiness.
- [ ] Normal jump, running jump, long fall and glide onto terrain, tower roofs, parapets, elevated platforms, all player-built surfaces and edges. Feet should settle on support with no repeated server correction, hover, sinking, persistent crouch/twist or frozen landing pose.
- [ ] Repeat land → idle and land → run; have another player watch those transitions under real latency. Destroy supporting builds and confirm falling/recovery rather than stale support.
- [ ] Check saved HUD scale/sensitivity/accessibility, safe areas, OS keyboard, pointer cancellation and sustained device performance.

Do not merge/deploy automatically. Review and complete physical-device checks according to the release process.
