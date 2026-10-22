# CI Craft 3.3 — authoritative inventory, world detail and combat feedback

## Delivery scope

- Date: 2026-10-22.
- Base: completed 3.2, `16632c9f8e10cedd06cbe931dded115704bc6082`.
- Branch: `arena/a41a3d63-cinite`; existing PR **#7**.
- Phase 1 / 2.0 / 3.0 / 3.1 / 3.2 remain in the branch history.
- No replacement PR, force-push, merge, deployment or production database access.
- The delivery commit is the commit containing this report; its SHA is also
  reported in the PR update and final delivery message.

## Audit and gameplay changes

The 3.2 registry prevented invented loot IDs, but its category-count ledger was
not an inventory. `heal_sync` could set health/shield, `player_sync` could choose
weapons/reload state, and firing did not debit a server magazine. Those paths
have been replaced, not merely hidden behind new UI.

### Server-owned inventory

- Five actual slots, including the permanent harvester, seeded from the existing
  starter-loadout definitions. The server owns equipped slot, magazine contents,
  reserve ammo, material balances, consumable stacks and pending actions.
- The full weapon catalogue is generated from `WeaponDefinitions.ts`: damage,
  rarity scaling, magazine sizes, reserves' ammo types, reload times, fire rates,
  burst spacing, pellets, ranges and consume times cannot drift into a second
  hand-maintained server table.
- A shot requires a live, eligible participant, an increasing shot sequence, the
  owned/equipped category and rarity, magazine ammo, no active reload/use task,
  and a valid server cadence. One accepted firearm shot spends one round.
  Harvester swings do not spend ammo. Pellet credits remain server-controlled.
- Burst shots retain their 75 ms spacing and existing complete burst cycle.
  Switching, picking up or cancelling cannot reset a pending cycle/cooldown.
- Reloads transfer only the missing rounds, bounded by owned reserves, after the
  catalogue duration. Repeated requests do not restart or complete a reload.
  Switching, disconnecting and death cancel pending actions without free ammo.
- Consumables require an owned stack and a healable target stat. Effects and
  stack decrement occur after the existing 1.5/1.8-second catalogue durations,
  not immediately. Health/shield remain bounded at 100. Stacks remain capped at
  three; reserve ammo/materials are bounded at 999.
- Ground/chest/vault claims remain atomic, registered, range-checked and
  collector-idempotent. They now also require unobstructed interaction geometry.
  A full-inventory replacement drops the **actual** old slot, including its
  partial magazine or consumable count. Client-supplied drop contents are ignored.
  Picking up a swapped gun does not grant another fresh reserve-ammo bonus.
  Server-only vault provenance travels with the actual inventory item.
- Private `inventory_state` packets reconcile the owner after mutations,
  rejections, join/reconnect and match start. Full inventories are not added to
  every public 20 Hz player snapshot. Reload animation metadata remains public
  and server-derived. The old count-only ownership functions were removed.
- `heal_sync` is now a read-only reconciliation response, never a health setter.
  Equipment/ammo/health/reload fields in `player_sync` have no gameplay authority.
  Replaced sockets cannot continue controlling the same seat. Active legacy
  players cannot refill themselves through `resetPlayer` reconnect requests.

### Geometry, combat and construction validation

- A generated server-only manifest contains the actual world box/cylinder
  colliders, destructible definitions and snapped build-cell terrain heights.
  The production server does not instantiate Three.js or load render assets.
- Pickup sight checks include static walls/props and player-built pieces.
  Destroyed props stop occluding. Combat claims also require clear sight,
  category range, plausible body-height/horizontal hit positions and shot credit.
  The previous firearm-sized range allowance no longer extends melee attacks.
- Initial spawn correction avoids static solids and starts above conservative
  terrain/water bounds. Movement endpoints embedded in static solids or clearly
  underground are rejected and corrected. This is **not** full movement authority
  or a speed/teleport anti-cheat system; see limitations below.
- Building validates piece/material/identifier, finite nearby coordinates, world
  bounds, occupied cell, capacity and the owned ten-material cost. It appears on
  the client only after server acceptance. Destroyed build IDs cannot be reused
  to make invulnerable pieces.
- Environment damage requires a registered, reachable target and a valid shot
  credit. Damage is derived from the catalogue, not the submitted number.
  Prop health/destruction and build health reconcile on reconnect. Clients no
  longer destroy online props or grant materials before server acceptance.
- Demonstrated defects fixed without changing firearm balance: the old cadence
  token allowance could exceed catalogue rates; consumables healed instantly;
  unlimited client health/ammo/equipment were trusted; and awarding 12 materials
  per swing against a piece costing 10 would permit material farming. Online
  player-built pieces now award no harvest materials. Natural registered props
  retain their existing harvest rewards.

### Client reconciliation and feedback

- Shooting/muzzle/recoil presentation remains responsive. A bounded map of at
  most 64 unacknowledged shots reconciles predicted magazine display against
  server acknowledgements, keyed by slot and weapon. Lost-socket predictions
  are discarded on reconnect rather than subtracting ammo indefinitely.
- Switching and reload input issue sequenced requests. Online reload completion,
  consumable use and pickup grants never independently mutate reserves/health.
  Public pickup receipts update world visuals only; replay cannot grant another
  gun, ammo bundle or consumable. Retry requests retain their intended swap slot.
- Online hitmarkers no longer confirm predicted client ray hits. Existing hit,
  shield-break and damage effects are triggered by accepted server hit events.
- Added one reusable 0.85-second, camera-relative damage-direction arc, with
  shield/flesh colors. Storm damage does not invent an attacker direction.
- Consumables show server-derived use duration/progress in the existing ammo
  card. Reload-completion sound/flash follows actual owner-state completion.
- Footsteps sample existing walkable surfaces only when a step occurs. Ground,
  hard architecture, wood and metal use different short synthesized pitches;
  no new audio downloads or additional simultaneous voices are introduced.
  Footstep oscillator/gain nodes disconnect when finished. Accepted environment
  impacts use existing distance-attenuated surface audio.
- Local burst/cooldown/held-trigger presentation clears on menu/match reset.
  Existing particle pools, storm cleanup, rig/cosmetic systems and animation
  architecture are retained.

## World and mobile upgrade

### World

- Six Aurora towers gain counted entrance bands, warm/cool occupied-window
  variation, exterior service units, rooftop HVAC grille detail and antenna
  crossbars, using existing district instance/material buckets.
- Exchange gains collidable gold crown fins; Observatory gains a collidable
  rooftop sensor mast and lit sensor panel. Their different heights, existing
  interiors and ascent routes remain intact.
- Large new solids have colliders. Small facade/service trim stays above walking
  headroom or on existing HVAC footprints rather than narrowing entrances.
- No new major POI or extra tower was added in this increment: the limited
  remaining triangle budget was spent on recognition and detail, not a rewrite.
- Legendary Tower geometry/vault, 13 fixed vault rewards, skybridge, city
  entrances and existing traversal paths are preserved. New tests check that
  every ordinary registered item has a clear, non-embedded pickup approach.
- Existing detail tiers, district instancing, material sharing, culling and
  adaptive particle settings remain in use. No added lights, models or textures.

### Mobile / desktop

- Existing independent joystick/look/action pointers, five slots, fire/aim/jump/
  reload/build layout, sensitivity/graphics controls, landscape requests and
  explicit fullscreen controls are retained.
- Added gameplay-control text-selection/callout suppression, overscroll
  containment and touch-press feedback; menus/settings remain separately usable.
- Use/reload state stays readable in the existing responsive HUD; the directional
  arc is smaller on coarse pointers and never captures input.
- Existing keyboard-focus, pinch/scroll, viewport, safe-area and input-cancellation
  guards remain covered by their tests. Fullscreen/orientation still depend on
  browser support and user permission. No device-layout visual claim is made.

## Exact changed files

| File | Change |
| --- | --- |
| `server/inventory.mjs` | New inventory/action/shot/pickup state machine and private snapshots. |
| `server/weaponCatalog.json` | Generated complete existing weapon catalogue. |
| `server/worldCollisionManifest.json` | Generated colliders, prop definitions and snapped terrain table. |
| `server/worldGeometry.mjs` | Segment/shape sight checks, build transforms and static spawn/endpoint safety. |
| `server/worldLoot.mjs` | Remove obsolete count-only ownership; retain registry/range rules. |
| `server/multiplayerServer.mjs` | Wire authority, validation, private ACKs, build/prop state and lifecycle cleanup. |
| `scripts/generateWorldLoot.mjs` | Generate/check catalogue and collision data alongside the existing loot registry. |
| `src/network/NetworkManager.ts` | Sequenced commands, bounded prediction reconciliation, reconnect and environment sync. |
| `src/network/schemas.ts` | Optional consumable presentation timers. |
| `src/entities/PlayerController.ts` | Request online actions instead of granting state; preserve offline behavior; reset presentation. |
| `src/core/GameEngine.ts` | Wire requests/ACKs, environment reconciliation and accepted-hit feedback. |
| `src/systems/LootSystem.ts` | Presentation-only online receipts and reserved-slot retries. |
| `src/world/MapExpansionBuilder.ts` | Instanced Aurora service detail, window colors and distinct roof crowns. |
| `src/world/IslandWorld.ts` | Footstep surface sampling from existing geometry. |
| `src/audio/SoundManager.ts` | Short surface-specific step tones and explicit node cleanup. |
| `src/ui/combatFeedback.ts` | Pure screen-relative threat-bearing calculation. |
| `src/ui/HUDManager.ts` | Directional damage arc, consumable progress and reset cleanup. |
| `src/styles/main.css` | Threat-arc presentation and scoped mobile control polish. |
| `index.html` | Reusable threat-direction HUD element. |
| `tests/gameplay33.test.mjs` | Ten focused authority, catalogue, geometry, audio and presentation tests. |
| `tests/gameplayHelpers.mjs` | Real protocol pickup/equip/sequence helpers; no server bypass hooks. |
| `tests/humanOnly.integration.test.mjs` | Extend four-authenticated-player coverage; acquire/equip actual weapons. |
| `tests/multiplayer.integration.test.mjs` | Real weapon acquisition, valid shot sequences/positions and build cost validation. |
| `tests/lobbyBrowser.integration.test.mjs` | Real inventory/cadence fixtures and race-safe final-result listener. |
| `tests/legendaryTower.integration.test.mjs` | Genuinely fill slots before swaps; avoid embedded fixture positions. |
| `tests/legendaryTowerLoot.test.mjs` | Model private owner state before receipts; receipt replay cannot grant ammo. |
| `tests/evolution32.test.mjs` | Keep registry/range tests; replace obsolete ownership-ledger assumptions. |
| `tests/upgrade2.test.mjs` | Assert category-specific server range allowance. |
| `package.json` | Include focused 3.3 tests in the complete test command. |
| `docs/CI_CRAFT_3_3.md` | This implementation, validation and release-gate report. |

`worldLootManifest.json`, weapon balance definitions, storm schedule, database
schemas, account APIs, deployment configuration, Node pin, model assets and
package lock were not changed.

## Validation performed

- `npm run typecheck`: PASS (strict TypeScript retained).
- `npm run loot:check`: PASS, including generated catalogue/collision drift guards.
- `npm run build`: PASS; existing >500 kB bundle warning remains.
- `npm test`: **67/67 PASS**, no skipped tests.
- `git diff --check`: PASS.
- Real local production-server smoke on port **4178**, bound to `0.0.0.0`, with
  a temporary SQLite database and `DATABASE_URL` explicitly empty:
  - HTTP 200: `/health`, `/api/lobbies`, `/`, Soldier GLB and emitted JS bundle.
  - Two authenticated humans visible in a real public lobby.
  - Both clients receive match start with zero bots.
  - Accepted shot changes server magazine from 30 to 29.
  - Explicit leave/forfeit produces the correct authoritative winner.
- Expanded four-authenticated-client integration additionally verifies contested
  chest claims, forged rewards/IDs/range, through-wall pickup rejection, embedded
  movement correction, timed healing, shot replay, unowned weapons, forged
  ammo/reload fields, private snapshots, reload cancel/completion, reconnect
  without refills, partial-magazine transfer, receipt replay, build validation,
  no uncredited environment damage/material farming and all-client final results.
- The first ad-hoc smoke script incorrectly expected an unlisted private room in
  the directory and used the wrong count field. Corrected the smoke fixture to
  a public room and `currentPlayers`; the application required no directory fix.

## Performance results

| Headless generated-world metric | 3.2 | 3.3 | Existing ceiling |
| --- | ---: | ---: | ---: |
| Mesh objects | 797 | **797** | 900 |
| Triangles (including instance counts) | 298,102 | **299,206** | 300,000 |
| Box + cylinder colliders | 1,407 | **1,412** | 1,450 |

- No ceiling was raised. No added point lights, texture/model/audio downloads or
  per-frame world-detail generation. Added details reuse existing batches.
- Production bundle: JS **1,066.38 kB / 281.97 kB gzip**; CSS **60.39 / 12.72 kB**;
  HTML **56.08 / 12.28 kB**. Server-only generated data adds 25,771 bytes of weapon
  definitions and 448,345 bytes of collision/terrain/prop data, not client assets.
- A balanced starter private inventory packet measured **986 JSON bytes**
  before WebSocket framing. Owner state is mutation/reconciliation-triggered,
  not broadcast to every opponent at 20 Hz.
- Synthetic server-only microbenchmark: after 500 warmups, 2,000 open-air sight
  plus position-clearance query pairs measured **0.0686 ms mean / 0.0974 ms p95 /
  0.2302 ms max** in this sandbox. No builds were present in that microbenchmark.
  This is not multiplayer-load profiling, a browser frame time, or a device FPS
  measurement; it does not justify increasing any render budget.

## Limitations and remaining release gates

1. **No browser/WebGL or physical Android/iOS/desktop playtesting performed.**
   Headless collision/navigation/count tests and HTTP/protocol smoke do not prove
   visual quality, touch overlap on every device, audio quality, GPU frame rate,
   pointer-lock/fullscreen behavior or real-player feel.
2. **Movement remains client-simulated/reported.** Static-solid/underground
   endpoint rejection and safe initial spawn correction are not a server movement
   integrator, speed check or teleport detector. Pickup range/sight uses the last
   accepted reported position. Dynamic construction/terrain checks use the shared
   collision representation, not a full server rendering-mesh raycaster.
3. **No lag-compensated rewind or WAN/load testing.** Shot admission uses server
   arrival cadence. Compressed packets/jitter can reject otherwise honest shots;
   client prediction reconciles them but real latency testing is still required.
   These changes close the identified inventory/state exploits, not every possible
   movement/aim cheat.
4. Inventory, receipts, prop health and matches are in-memory/match-scoped. They
   reconcile across a connection loss while the process survives, not a server
   restart. Existing persistent account/progression storage is unchanged.
5. Updated server/client must ship together in a future authorized release;
   pre-3.3 clients do not send the required shot sequence/action protocol. No such
   release has been performed here.
6. New online building/harvesting effects wait for acceptance; responsiveness
   under high RTT needs human QA. Offline/Solo keeps its existing local rules;
   no new bot authority or AI system was introduced into human-only rooms.
7. Sandbox runtime was **Node 22.22.3**; repository pin remains **22.14.0**. Re-run
   release CI on the exact pinned runtime. SQLite/type-stripping experimental
   notices and the existing large-bundle warning remain.
8. Soldier GLB provenance/licence gate from 3.1 remains unresolved. No character
   asset was replaced and no new licence/visual/rig claims are made.

PR #7 remains open for review. Production is untouched.
