# CI CRAFT 9.0 — Road system rebuild

**Status:** complete, verified offline, **not merged**. Branch `arena/9b18918a-cinite`.

This report answers the seven questions asked for 9.0. Every number below was
measured in this workspace; nothing is estimated.

---

## 1. Root cause of the old road failures

Four separate defects, confirmed by measurement, not by eye.

**a) The road was a two-vertex-wide strip.** `buildRoadSurfaceGeometry()` in
`TerrainGenerator.ts` emitted exactly two vertices per cross-section — a left and
a right edge — with a straight chord across the full 7.2–8.1 m width. The terrain
lattice is 2.60 m, so the ground between the two edge vertices was never sampled.
Raycasting the drawn surface against the drawn terrain showed terrain standing
**above the asphalt in 14.6 % of 4,344 land samples, worst 0.947 m**; on
`aurora_west_link` it was 90 % of the length. That is the "detached slabs and
misplaced geometry": the asphalt was a flat chord floating over curved ground.

**b) A global water clamp.** Every vertex ran through
`Math.max(ground + 0.035, WATER_Y + 0.95)`. The floor was applied to the whole
map rather than only to water, so **any** road on ground below 0.635 m was
silently lifted. The raised deck then tripped the parapet heuristic and grew
bridge furniture **126 m long across a 46 m lake** (bbox z 21…147). No bridge
existed before 8.2 — `git show 1821507^` contains zero references to
`roadBridge`.

**c) Three disagreeing widths.** The mesh used 3.6 m, kerbs used 4.05 m
(primary) / 3.75 m (secondary), the terrain sub-base paint used 3.6 m. The kerbs
also sampled `getTerrainHeight` (analytic) while the roads sampled
`getRenderedTerrainHeight`; those two fields differ by mean 0.017 m and **max
2.29 m**.

**d) No road collision.** Players resolve their floor from
`getTerrainHeight` plus registered walkable surfaces, and no road was ever
registered. On the causeway the deck sat 0.67 m above a −1.65 m lakebed, so a
player walking the visible bridge was standing **2.3 m underneath it**.

---

## 2. Old components removed

- `TerrainGenerator.buildRoadSurfaceGeometry()` — **deleted, 271 lines.**
- The global `WATER_Y + 0.95` clamp — deleted. Water is now handled per segment.
- The "raised means bridge" parapet heuristic — deleted. Structures are built
  only over a span that is genuinely under water.
- The hardcoded road half-widths in `MapExpansionBuilder.ts` — replaced with the
  shared `roadHalfWidth()`.

No old road mesh is built any more, so nothing renders underneath. A regression
test asserts exactly one `RoadSurface` mesh exists in the scene.

---

## 3. How the new system works

`src/world/RoadNetwork.ts` (new, single file, one exported entry point).

- **Conforming surface.** Each of the 33 segments is sampled along its length and
  across its full width, and every vertex is placed at
  `renderedTerrain(x,z) + 0.045 m`. The surface follows the drawn terrain instead
  of chording over it. Nothing is flattened; the map is untouched.
- **Adaptive tessellation.** Width and length are refined only where they need to
  be. A sample is dropped only while the ground it described stays within 3.5 cm
  of the straight line replacing it, and the centre-line pair is always kept.
  This cut the first draft of the mesh from 47,762 to 23,148 triangles (51 %)
  with no measurable change in conformance.
- **Water handled per segment.** A segment's own profile — centreline *and* both
  edges — decides whether it crosses water. A wet stretch shorter than 2 m is a
  puddle and gets no bridge. A genuine crossing gets a deck floored at
  `waterY + 0.95 m`, and the deck ramp is an *upper bound* clamped down to the
  ground, so it can never float over dry land.
- **Junctions.** 25 nodes, each closed by a 24-segment, 4-ring paved disc with its
  own water floor, so a node standing on submerged ground cannot render as
  submerged asphalt.
- **One mesh, one draw call.** Asphalt, edge band, dashes and junction paint are
  written into a vertex-colour attribute, with deterministic `hash01` mottling
  (±4 %) so the surface reads as worn asphalt rather than a flat fill.
- **Collision.** Decks are registered as walkable support surfaces. A deck is
  skipped where the world already bridges the gap (measured coverage 2 % / 0 % /
  32 %; the river-south dock already floors a third of the ruins crossing), so no
  deck lifts an existing floor out from under loot or players.

---

## 4. Files changed

| File | Change |
| --- | --- |
| `src/world/RoadNetwork.ts` | **new** — the entire replacement system |
| `src/world/TerrainGenerator.ts` | −271 lines; call site now `buildRoadNetwork()`; adds `WATER_SURFACE_Y`, `roadWalkables`, `roadStats` |
| `src/world/MapExpansionBuilder.ts` | kerbs use `roadHalfWidth()` instead of hardcoded widths |
| `src/world/IslandWorld.ts` | registers bridge decks as walkable surfaces at the end of `generate()` |
| `tests/roads90.test.mjs` | **new** — 12 road regression tests |
| `tests/graphics61`, `graphics70`, `polish35`, `worldBranding`, `worldExpansion` | triangle budget 338,000 → 360,000 / 622,000 → 640,000, with the measurement recorded in each file |
| `tests/worldBranding.test.mjs` | gameplay fingerprint re-baselined (see §5) |
| `scripts/headlessWorld.mjs` | emits `RoadNetwork.mjs`, exports `buildRoadNetwork` / `roadHalfWidth` |
| `package.json` | `roads90.test.mjs` added to `test` and `test:graphics61` |

---

## 5. Test, typecheck, build and audit results

```
npm test              205 tests, 205 pass, 0 fail
npx tsc --noEmit      clean
npm run build         536 ms
npm run audit:geometry  PASS — 712 meshes, 361,788 triangles
```

**Road measurements (final):**

| Metric | Old system | 9.0 |
| --- | --- | --- |
| Terrain above asphalt | 14.6 % of samples, worst 0.947 m | **1.024 %** of 6,248, worst 0.6352 m |
| Vertices below the water plane | 34 | **0** (min −0.2310) |
| Downward / degenerate triangles | — | **0 / 0** |
| Longest road triangle edge | 10.52 m | 5.57 m |
| Road triangles | 1,274 | 23,148 |
| Walkable decks | none | 2 |
| Off-deck vertices at the designed lift | — | p50 0.045 m, p99 0.049 m |

**The new tests are proven to catch the old code.** The 12 tests in
`tests/roads90.test.mjs` were run against the pre-9.0 builder: **5 fail**, with
these messages — `longest road triangle edge is 10.52 m`, `19.3 % of samples have
terrain above the asphalt`, `primary_docker_docks is under water for 40.0 m but
has no bridge deck`, `no bridge decks were registered`. They pass 12/12 on the
new system. The tests measure the drawn surface by raycast, so a coarse
cross-section cannot hide a chord.

**Two thresholds were changed, and here is exactly why.**

- *Triangle budget* (338,000 → 360,000 LOW, 622,000 → 640,000 HIGH). A conforming
  road costs 23,148 triangles where the broken 2-vertex strip cost 1,274. The
  first draft cost 47,762; adaptive decimation and cheaper disc tessellation
  removed 51 % before the budget was touched. Nothing else in the world grew.
  Both numbers and the reasoning are written into all five test files. **If you
  would rather keep the old budget, say so — the only alternative is coarser
  sampling, which measurably increases terrain poke-through.**
- *Gameplay fingerprint*. `walkableSurfaces` is part of the hashed snapshot, so
  adding bridge decks had to change the hash. This was verified rather than
  assumed: both worlds were built and diffed. Collision boxes (963), cylinder
  colliders (451), chest spawns (72), loot spawns (146), tower floor loot (21),
  vault loot (13) and destructible props (427) are **byte-identical**, and all
  480 pre-9.0 walkables are unchanged in bounds and height. The only delta is the
  two added decks.

No test was deleted or weakened.

---

## 6. Browser rendering: NOT verified

**There is no WebGL in this environment** — no GL libraries, headers, Xvfb, Mesa
or `/dev/dri`. Every image produced here comes from the offline CPU renderer in
`scripts/offlineRender.mjs`. That renderer exercises the real generated geometry
and materials, and it is the only visual evidence in this report, but **it is not
a browser**: it cannot prove shader compilation, real lighting, or performance.
Treat everything below as geometry evidence only.

What the offline renders do show, at the previously broken locations: continuous
asphalt with a dashed centre line, raised kerbs following both edges, junctions
closed by paved discs, and the lake crossed by a deck with parapet rather than
the old 126 m wall.

### Manual checklist for a real browser

At each spot, look from at least three angles including from the road surface:

1. **Mirror Lake causeway** — around `(-45, 45)`. Walk across. You must stay on
   the deck, not sink to the lakebed. The deck should be about 1 m above the
   water, with a parapet, and no bridge furniture anywhere the road is on dry
   land.
2. **Docker docks junction** — `(-20, 38)` and `(-70, 38)`. These nodes stand on
   ground that is under water; the junction should be paved asphalt, not
   submerged geometry.
3. **Aurora annex avenue** — `(99, -53)`. This is the worst residual spot (0.64 m
   of terrain through the asphalt on a ~190 % cliff face). Check whether the road
   visibly clips the cliff. It is expected to look imperfect here; it is the one
   place where a conforming surface cannot help.
4. **Any straight run** — no black strips, no floating slabs, no z-fighting
   shimmer, markings following the surface up and down.
5. **Console** — no new shader errors. Diagnostics are `?diag=1` only.

---

## 7. Pull request

Opened from `arena/9b18918a-cinite`. **Not merged** — merging needs an explicit
instruction.
