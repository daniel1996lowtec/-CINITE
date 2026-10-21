# CI Craft 3.2 — world, loot authority and endgame evolution

## Base / delivery

Audited PR #7 while OPEN at `2f4bdb87f470d824996e4ba4c5b7f688a5bdf2b0`
(CI Craft 3.1). The working tree matched that latest commit and was clean.
All Phase 1 / 2.0 / 3.0 / 3.1 changes remain in history. Arena fixes this session
to `arena/a41a3d63-cinite`; this increment updates that feature branch / PR #7.
No merge, close or production deployment.

## Implemented by phase

### World and exploration

- Aurora now has six enterable towers. Added the five-floor **Exchange** at
  `(110, -64)` and seven-floor **Observatory** at `(110, -43)` with distinct
  gold/indigo crowns, front/rear entrances, switchback ramps, balconies,
  roof access and collidable rooftop cover.
- A northern avenue extends the existing district road network. New towers
  reuse instanced architecture/material batches, rather than individual meshes
  for each wall/window/furniture piece.
- Added retail counters, office desks/screens and recessed maintenance caches
  on selected annex floors. The caches have tested entry and escape paths;
  these are small modular alcoves, not a new full interior asset library.
- Corrected high-rise facade detail positions to stay inside the intended
  building width/depth. Existing skybridge, Legendary Tower and island routes
  remain intact. Initial annex placements that overlapped older landmarks were
  rejected by tests and moved; no old landmark was deleted to make room.

### Loot authority

Previously, ordinary chest and ground claims could use client-created IDs,
positions and chest contents. 3.2 replaces that **online** path:

- `scripts/generateWorldLoot.mjs` loads the actual Three.js world and existing
  weapon definitions at development time. It generates the server's fixed
  registry: 341 entries (including 72 chests) plus the existing 13 vault entries.
  `npm run loot:check` and the full test suite detect registry/map drift.
- The server seeds every online room with that registry. Online clients wait
  for it instead of creating their own ordinary map loot.
- All claims resolve registered item contents, check three-dimensional range
  against the player's last synchronized position, and award an ID once.
  Claims cannot create items by supplying chest contents, rarity, amount or an
  invented ID. Chest rewards are fixed server-authored weapon/ammo/healing sets.
- Generic ground upgrades are common/uncommon/rare, with distributed epic
  rewards. Chests offer rare/epic upgrades throughout the island, not just at
  Aurora or the central vault. Weapon damage/rate/range values are unchanged.
- Matching ammo and chest contents use tested pickup coordinates rather than
  blind offsets into nearby walls; rendered items are visually separated.
  Offline ground ammo/chest scattering was corrected similarly. Offline/Solo
  keeps its existing local generation and rolls.
- An acquisition ledger allows only previously awarded/starter weapons to be
  broadcast as swap drops. The `swap_` namespace cannot overwrite future chest
  reward IDs. Existing unique-vault provenance remains separately enforced.
- Client inventory waits for the ACK; a reserved swap slot prevents changing
  the active slot while waiting from duplicating the dropped weapon. Same-seat
  retries replay the original receipt without another ownership transfer.
  Pending weapon claims can be reconciled on room resync.
- Consumable swap proposals are deliberately not broadcast: the existing heal
  protocol cannot prove that a proposed consumable is unused. Consumable pickup,
  stacking and use remain available. This is a conservative limitation, not a
  claim of full authoritative inventory/ammo/consumption simulation.

### Combat and match feedback

- Explicit brief shield-break / storm-damage text, reload countdown/progress in
  the ammo card and weapon-switch highlighting; existing hitmarker, weapon audio,
  tracer, recoil and elimination effects retained.
- Server hit events carry the attacker's elimination count. The client no
  longer double-increments a count already received through a room snapshot.
- A snapshot marking a victim dead no longer suppresses the subsequently
  arriving deduplicated elimination event's presentation.
- Lobby join/disconnect/leave/ready/countdown/live announcements derive from
  snapshot changes; no demo players or locally invented counts.
- Final standings/winner display uses server roster, placements and elimination
  totals. An early defeat screen no longer blocks the later authoritative final
  result. Existing spectator controls remain; the button is hidden once ended.
  Standings show the participants present in the final server roster, not a
  fabricated historical list of every departed player.

### Endgame

- A single unlit cyan final-zone column appears from phase 6; target rings
  change to cyan and storm opacity increases slightly without opaque fog.
- Boundary rings follow terrain height at 5 Hz rather than being buried at
  constant sea-level height. They still use the synchronized zone coordinates.
- HUD emphasizes final phases, countdowns and distance to the target safe zone
  when outside. The terminal zone reports its radius instead of an ambiguous
  closed countdown. The new landmark is cleared on return to the menu.
- **Eight-phase timing, shrink/radius/DPS schedule and server storm authority
  are unchanged.** Presentation sync is tested not to advance authoritative time.

## Performance and validation

- Generated world: **797 mesh objects, 298,102 triangles, 1,407 colliders**.
  Existing ceilings of 900 mesh objects / 300,000 triangles remain. Collider
  ceiling increases from 1,360 to 1,450 to accommodate tested new interior
  obstacles. Mesh/triangle counts are geometry metrics, not device FPS results.
- Low-poly instanced lamp/glow geometry offsets added architecture triangles.
  Existing district distance/detail culling remains. No new textures/models or
  dynamic lights are downloaded/added for this iteration.
- Ordinary loot beams are culled at 50 m; high-rarity beams retain
  their longer range. Hidden chests skip animation work. Particle rings/tracers
  now have explicit simultaneous caps in addition to existing particle budgets
  and reusable pools.
- Initial registered item JSON is about 73 KB including the vault, sent on
  join/start/resync, **not in every 20 Hz room snapshot**. No Three.js world is
  generated by the production server at startup.
- `npm run typecheck`: passed.
- `npm run build`: passed; JS **1,059.51 kB / 280.18 kB gzip**. Existing >500 kB
  chunk warning remains.
- `npm test`: **57/57 passed**. Existing suites retained; updated old fabricated
  loot fixtures to use registered items or expect rejection.
- New coverage: full registry drift/placement/catalogue checks; six-tower
  entrance-to-roof and cache escape navigation; actual four-human ready/start,
  contested chest, forged/out-of-range claims, receipt retry, identical final
  winner/counts; reserved swap slots; server-only chest rewards; unchanged storm
  state during presentation; terrain-following rings; effect caps/cleanup.
- Local production-style server on port 4177 with temporary SQLite: HTTP 200
  health, lobby discovery, main page, bundled GLB and current hashed JS; required
  feedback/standings markup present.
- Node pin remains exactly **22.14.0**. Sandbox runtime is 22.22.3; no configuration
  or Render environment/migration/database changes.

## Files

- World: `src/world/WorldLayout.ts`, `src/world/MapExpansionBuilder.ts`.
- Authority: `server/multiplayerServer.mjs`, `server/worldLoot.mjs`,
  generated `server/worldLootManifest.json`, `scripts/headlessWorld.mjs`,
  `scripts/generateWorldLoot.mjs`.
- Client: `src/systems/LootSystem.ts`, `StormSystem.ts`, `ParticleSystem.ts`,
  `src/core/GameEngine.ts`, `src/network/NetworkManager.ts`, `schemas.ts`,
  `src/ui/HUDManager.ts`, `LobbyBrowser.ts`, `src/styles/main.css`, `index.html`.
- Validation: `package.json`, `tests/evolution32.test.mjs`, extended world,
  human-only, multiplayer, tower-loot and tower-integration tests.

## Release gates / limitations

- No real browser/WebGL, shader/pixel appearance, physical Android/iOS, frame
  pacing or production tests were performed. Review minimap/HUD readability,
  rooftop sightlines, terrain rings, co-located loot visuals and touch play on
  actual devices before release. Geometry/path automation is not visual QA.
- The new server registry and confirmation protocol must ship with this client;
  legacy clients expecting optimistic generic chest loot should reload.
- This is server-approved world-loot acquisition, **not a complete server-run
  inventory/movement/hitscan simulation**. Ordinary clip/reserve ammo and movement
  reports retain their existing architecture. Range checks use synchronized
  positions; loot receipts are in-memory per-match, not durable match recovery.
- No new general elimination-drop inventory replication, audio sample pack,
  destructible skyscrapers, elevators or new storm/gameplay balance was added.
- The 3.1 bundled character licence provenance/physical-device QA gates remain
  documented in `public/models/ASSET_PROVENANCE.md`; this work introduces no asset
  replacement or new third-party licensing claim.
