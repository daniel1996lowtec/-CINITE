# CI CRAFT emergency recovery — investigation report

Branch `arena/dd4ca549-cinite`, HEAD `262eefc` (unchanged from `main`).
**Nothing merged, nothing force-pushed, no branches deleted, no work overwritten.**

---

## 0. The short version

I could not reproduce the reported breakage in any tool available here, so I
have not claimed a fix. What I did do is make the road system switchable in one
place and **default it off in the browser**, which restores the last world that
contained no road geometry at all, and leaves `?roads=1` to bring the 9.0 roads
back for a direct A/B in your browser.

**The screenshot referenced in the request did not arrive with the message.** I
have no image of the current breakage. Everything below is built from code and
measurements, and I say explicitly where that is not enough.

---

## 1. What was preserved

| Item | State |
| --- | --- |
| Branch | `arena/dd4ca549-cinite` (was `main`-based at `262eefc`) |
| HEAD at start | `262eefc` — unchanged; no commits rewritten |
| Uncommitted work | none; working tree was clean |
| Recovery branch | this branch; nothing force-pushed or deleted |
| 9.0 road system | fully intact in the tree; only its *activation* changed |

Temporary git worktrees at `/tmp/wt87` and `/tmp/wt90` were used for comparison
and removed afterwards. They never touched the repo's history.

---

## 2. Last known-good candidate

**`2e16832` — the merge of PR #16 (8.1).**

This is the most recent revision that contained **no road geometry whatsoever**
(`git show 2e16832:src/world/TerrainGenerator.ts` has zero references to
`roadSurfaceMesh`, `buildRoadSurfaceGeometry` or `roadBridgeMesh`). Every later
revision builds road geometry.

That makes 8.1 the last revision that cannot have had the reported road
symptoms. It is not a claim that 8.1 was perfect — 8.5–8.7 were unresolved
investigations into a *different* world defect — only that it is the newest
revision where the road system was not a possible cause.

`?roads=0` reproduces that world for the parts that matter, without a revert.

---

## 3. Commits that introduced road geometry

| Commit | Merge | What it did |
| --- | --- | --- |
| `1821507` | `1b19937` PR #17 | **8.2** first road geometry: 2-vertex strips, global water clamp, invented bridge |
| `0f7eec6` | `642bde2` PR #18 | **8.3** bridge parapets, kerb height |
| `3056a11` | `89b921c` PR #19 | **8.4** mountains |
| `6211dbc`, `c5e5cfc` | `c81bc42` PR #20 | **8.6/8.7** diagnostics only — no world geometry |
| `ab8cf81` | `262eefc` PR #21 | **9.0** road system rebuilt from scratch |

---

## 4. Root-cause isolation — what the measurements show

I built **8.7 (`c81bc42`) and 9.0 (`262eefc`) side by side** and diffed the
entire scene graph, mesh by mesh, on name, material, bounds and triangle count.

```
8.7 meshes 712, 9.0 meshes 712

present in 8.7 but not 9.0:   RoadSurface, RoadBridgeStructure
present in 9.0 but not 8.7:   RoadSurface, RoadBridgeStructure
meshes whose triangle count changed: 0
meshes whose bounds changed (other than those two): 0
```

**Every terrain, building, prop and vegetation mesh is byte-identical in bounds
between 8.7 and 9.0.** Whatever is wrong, it is not displaced world geometry, it
is not shared-geometry corruption, and it is not a scene-lifecycle or disposal
fault: the only two objects that differ at all are the road surface and the
bridge structures. That rules out, with evidence, most of the candidates the
request listed.

Further checks on the 9.0 road mesh itself:

| Check | Result |
| --- | --- |
| Vertex normals facing downward (render black) | **0** of 13,355 (min `normal.y` = 0.481) |
| Degenerate triangles | 0 |
| Longest triangle edge | 5.57 m |
| Vertices below the water plane | 0 |
| Terrain above asphalt | 1.02 % of 6,248 ray samples, worst 0.635 m (a 190 % cliff face) |
| Bridge structure clusters | 2 (39 m and 12 m) — **not** one 126 m strip |
| `RoadSurface` meshes in scene | 1 |
| Colliders | 1414, unchanged in both road modes |

One genuine, *localised* inconsistency remains and is worth recording: the kerbs
in `MapExpansionBuilder.ts` still sample the analytic `getTerrainHeight`, while
the road samples `getRenderedTerrainHeight`. Measured along the kerb line they
disagree by up to **1.70 m**, but only in **0.8 %** of 1,774 samples. Real, and a
plausible source of a localised step or spike, but not of world-wide corruption.

### Honest conclusion on root cause

**Not established.** The evidence narrows the suspect to the road surface and
the bridge structures and excludes everything else in the scene, but I have not
reproduced a single frame of the reported breakage, so I will not name a cause I
cannot demonstrate.

---

## 5. What I changed (the recovery action)

One switch, one source of truth, `src/world/RoadNetwork.ts`:

```ts
const ROADS_DEFAULT_IN_BROWSER = false;

export function roadSurfaceRequested(search?: string): boolean { … }
```

- `TerrainGenerator.roadsEnabled` reads it once. It gates the carriageway mesh,
  the bridge structures, the deck walkables **and** the road sub-base painted
  into the terrain, so the world can never be half-roaded.
- **Browser default: roads OFF.** Opening the game now shows the 8.1 world.
- `?roads=1` builds the 9.0 roads; `?roads=0` is explicit and identical to the
  default. `?diag=1` still works alongside either.
- **Headless runs keep roads ON**, so the 12 tests in `tests/roads90.test.mjs`
  and the audits still exercise the new system and it does not rot.

Verified mode behaviour:

```
roads ON : meshes 712  tris 654380  road true  bridge true  decks 2  colliders 1414  walkables 482
roads OFF: meshes 710  tris 630404  road false bridge false decks 0  colliders 1414  walkables 480
```

Collider count is identical in both modes: **gameplay, collision, routes, loot,
multiplayer, chat and all three game modes are untouched by the switch.**

---

## 6. Verification status

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run build` | 596 ms |
| `npm test` | **205 / 205 pass** |
| `npm run audit:geometry` | PASS — 712 meshes, 361,788 triangles |

**There is no WebGL in this environment** (no GL libraries, Mesa, Xvfb or
`/dev/dri`). Every image I can produce comes from the offline CPU renderer. It
renders the real generated geometry, and with `?roads=0` equivalent it shows a
coherent world — grass, buildings, kerbs and streets intact, with no asphalt.
**That is not proof the production game looks correct in a browser.**

### The one test only you can run

Load the game and compare, on the same machine, same session:

1. **No flag** → should be the coherent 8.1-style world. If this still shows
   black strips, distorted surfaces or displaced geometry, **the road system is
   not the cause** and I will need the screenshot to go further.
2. **`?roads=1`** → the 9.0 roads return. Compare against (1) at the same
   locations and camera angles.
3. **`?diag=1`** → the 8.7 renderer diagnostics, to capture real WebGL errors
   without replacing them.

That A/B is decisive in a way no offline render can be: it isolates the road
system with a URL parameter and changes nothing else.

---

## 7. Remaining uncertainty

1. **I have not seen the screenshot.** Without it I cannot map the symptom to a
   mesh. The mesh diff says the road system is the only thing that changed, but
   "changed" is not "is the visible fault".
2. **The 8.5–8.7 world defect was never solved.** If what you are seeing is that
   older defect resurfacing, disabling roads will not clear it. This is the main
   reason the A/B above matters.
3. **Kerb height mismatch** (§4) is a real localised bug — kerbs at analytic
   height against roads at rendered height, up to 1.70 m apart in 0.8 % of
   samples. I have not fixed it, because fixing it during a recovery would be
   exactly the speculative repair you told me to stop making.
4. **With roads off, the Mirror Lake causeway has no walkable deck**, so crossing
   the lake on foot puts a player on the lakebed. That is the historical 8.1
   behaviour, not a new regression, but it is a gameplay consequence of this
   default and you should know about it.

---

## 8. Recommended next step

Do the three-load A/B in §6. The outcome decides everything:

- **Roads off fixes it** → the fault is in `RoadNetwork.ts`; I have the mesh, the
  measurements and the test harness ready, and the next step is to bisect 9.0
  itself (conforming surface vs adaptive decimation vs deck clamping vs the
  vertex-colour material) rather than redesign anything.
- **Roads off does not fix it** → the fault is older than 8.2 and the road system
  stays out of it. That points back at the unresolved 8.5–8.7 defect, and the
  next step is to bisect terrain/material changes between 8.1 and 8.7 with the
  same side-by-side mesh diff I used here.

Nothing is merged. This branch is the recovery branch; the 9.0 work is preserved
in it in full and can be switched on with a single query parameter.
