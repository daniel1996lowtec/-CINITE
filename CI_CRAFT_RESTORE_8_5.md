# CI CRAFT — Emergency world restore: investigation report

**Nothing was reverted, re-merged or deployed.** No cause of the reported
corruption could be confirmed, so there was no "smallest confirmed set" to
revert. Reverting blindly would repeat exactly the failure mode you are
describing — fixes applied without evidence.

**Two hard blockers, stated up front:**

1. **No screenshots were attached to this request.** I checked the entire
   workspace: the only images present are my own `artifacts/offline-preview/*.png`
   renders. The brief refers to "the attached screenshots" and "the same
   locations shown in the attached screenshots" — those files are not here, so
   **I have never seen a single frame of the broken game.** Every claim below is
   therefore about code and geometry, not about what you are looking at.
2. **No browser/WebGL exists in this sandbox.** No GPU, no `/dev/dri`, no
   Mesa/EGL/OSMesa, no Chromium or Xvfb. I cannot open the game.

---

## 1. Last known-good revision

**Cannot be established.** Doing so requires comparing rendered frames across
revisions, and I have no rendered frame from any revision — not of the current
build, and not of any historical build.

What I *can* state factually:

| Revision | Commit | Meaning |
| --- | --- | --- |
| **7.2** | `44c3bcb` | Last commit **before** the graphics series. Structurally the obvious "pre-graphics" baseline. |
| 8.0 | `4f01930` | Layered terrain, sky shader, ground cover — first large world render change |
| 8.1 | `a58cd6d` | **"fix terrain shader compile error that removed the world"** |
| 8.2 | `1821507` | Largest world change set |
| 8.3 | `0f7eec6` | Small |
| 8.4 | `89b921c` | Backdrop only (+37 lines, one function) |

Note that 8.1's own commit exists because **8.0 blanked the world to a shader
failure** — i.e. this regression class has happened before, and the file that
caused it is known.

---

## 2. Regression candidates — exact files

Only these files touch world rendering. Everything else in these commits is
tests, docs and `package.json`.

| Commit | Files and line counts |
| --- | --- |
| `4f01930` 8.0 | `IslandWorld.ts` +287, `SkySystem.ts` **+384 (new)**, `TerrainGenerator.ts` 209, `VisualAtmosphere.ts` 107, `GameEngine.ts` 12, `VegetationGeometry.ts` 12 |
| `a58cd6d` 8.1 | `VisualAtmosphere.ts` **31 only** |
| `1821507` 8.2 | `TerrainGenerator.ts` **+400**, `MapExpansionBuilder.ts` 87, `VisualAtmosphere.ts` 37 |
| `0f7eec6` 8.3 | `TerrainGenerator.ts` 18, `MapExpansionBuilder.ts` 7 |
| `89b921c` 8.4 | `TerrainGenerator.ts` 37 (`buildDistantSceneryIslands` only) |

**Smallest suspicious set: `1821507` (8.2).** It is the largest change set, it
rewrote the terrain colour cascade, and — most importantly — it modified
`VisualAtmosphere.applyTerrainGroundDetail`, **the same function that blanked the
world in 8.0 and had to be repaired in 8.1**. A world-covering cyan symptom is
the signature of that function failing to compile: when it fails, three.js skips
the draw call and you see `scene.background = 0x38bdf8` — a cyan — with every
other mesh still floating over it. That matches "huge cyan surfaces + buildings,
roads and bridges that do not align".

8.4 cannot be the cause of cyan/black/grey world corruption: it changed only the
eight backdrop cones.

---

## 3. Recovery performed

**None.** Deliberately. Your instruction was to revert the smallest **confirmed**
set; nothing is confirmed, and `geometryAudit`, the full test suite and six
independent structural probes all pass at HEAD. Applying an unverified revert now
would be the same guess that produced this situation.

A ready, minimal, one-file experiment if you want to test the 8.2/`VisualAtmosphere`
hypothesis — **not applied**:

```bash
# Restore the pre-8.0 terrain shader, the version that predates the whole
# graphics series, without touching any other file, gameplay or the map:
git checkout 44c3bcb -- src/world/VisualAtmosphere.ts
npm run build
```

This removes the layered turf/soil/gravel detail from the ground (a deliberate
visual downgrade) but keeps all gameplay, the map layout, roads, water, buildings
and every other system. It is the correct way to falsify the hypothesis: if the
cyan disappears, the terrain shader is confirmed and I can re-apply the 8.2
feature correctly. If the cyan remains, the shader is exonerated and the cause is
elsewhere.

---

## 4. What I ruled out, with evidence

Six plausible causes of a world-covering cyan were tested and **excluded**. This
is real progress — each one is now falsifiable rather than a guess.

| Candidate | Measurement | Verdict |
| --- | --- | --- |
| Terrain shader fails to compile | Assembled the real shader via `onBeforeCompile`. `natural` (8.2) is declared at line 1474 with **0 uses before declaration**; no unresolved `#include`; `vCicraftPaved` present in both stages; `aPavedMask` declared. | **Excluded** |
| Sampler / attribute limit overflow | Assembled shaders declare 26 fragment samplers — but that is the stock `MeshPhysicalMaterial` template, and the GLSL linker drops unused uniform samplers. Unused declarations do not fail. | **Excluded** |
| Frustum culling blanks the terrain | Terrain `boundingSphere` centre `(0, 7.0, 0)`, radius 382.0, **equal to the true max vertex distance**; finite; 0 NaN vertices. Same for road, water, bridge, foam ring. | **Excluded** |
| A rogue cyan sheet covers the world | Enumerated all 165 cyan-capable meshes. Largest `true` areas are the intentional ocean (y = −0.28) and glass panes (`#bfe3f5`). The 463 × 463 m `#e0f2fe` object is `shorelineFoamRing`, a `RingGeometry` **7.5 m wide** — its bbox is the island diameter, not its area. | **Excluded** |
| Water sits above the land | `waterMesh` at y = −0.28 over 1600 × 1600 m; terrain spans y = −5.31 … 19.33 over 540 × 540 m. Water is below land; the audit's "≥ 85 % of the island above water" check passes. | **Excluded** |
| Water material bleeds onto terrain | Terrain colour cascade gates turquoise on `shoreJ = vy + jitter × 0.32`, so it cannot reach above `vy ≈ 0.32 m`. | **Excluded** |

---

## 5. Test results

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean, exit 0 |
| `npm test` | **188 / 188 pass** |
| `npm run build` | exit 0; `dist/index.html` 63,805 B |
| `npm run audit:geometry` | **PASS** — 712 meshes, 339,386 triangles |
| `scripts/visualAudit.mjs` | 706 meshes, 613,870 triangles, **colliders 1414** |
| Production serve path | `npm run start` → `/health` 200, `/` 200 serving `assets/index-BIENGZ_V.js` |

Gameplay is untouched by this round: **no source file was modified.** Battle
Royale, FFA, TDM, multiplayer, late joining, server-authoritative combat,
building, weapons, inventory, respawning, scoring, chat, mobile HUD and controls
are all byte-identical to the merged `89b921c`.

---

## 6. Live Render deployment

**Not verified — and I have never deployed anything.** `render.yaml` and
`Dockerfile` exist in the repo, but I have no Render access, no dashboard, and no
way to inspect the running service.

This matters, because it is a concrete explanation for why the world could look
broken no matter what merges:

* `render.yaml` specifies `buildCommand: npm ci --include=dev && npm run build`
  and `startCommand: npm run start`. Render only rebuilds when a commit lands on
  its tracked branch — by default `main`.
* Merging a PR **does** create a commit on `main`, so a correctly-configured
  service should rebuild. But if the service was created manually against a
  different branch, or is serving a cached build, or the build failed and Render
  kept the previous artefact, the site shows old code indefinitely.
* I confirmed locally that when `dist/` is **absent**, the server answers `/`
  with the plain-text string *"CI Craft 3D Authoritative Multiplayer Server is
  running."* rather than the game. A build failure on Render therefore does not
  degrade gracefully — it changes what `/` returns.
* The 8.4 snow line on the skyline is a **build fingerprint**: if your running
  site does not show snow-capped distant peaks, it is not serving `89b921c`.

---

## 7. What I need to proceed

One screenshot of the broken game, from the actual running site, with the URL
visible. That single image converts all of the above from inference into
diagnosis: I can match the cyan to a named mesh between the terrain, water,
sky or a mis-transformed object, which is exactly the Phase 3 step I cannot take
without it.

Failing that, the fastest self-check needs no code change: open the site,
hard-reload, and look at the distant skyline. Snow on the peaks → you are on the
current build, and the corruption is a rendering fault I can chase. No snow →
you are on an older deployment, and the fix is a redeploy, not a revert.

**I have not claimed the world is fixed, because I have not seen it.**
