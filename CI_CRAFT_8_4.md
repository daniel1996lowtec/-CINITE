# CI CRAFT 8.4 — live world visual regression investigation

**Status: one real defect found, fixed and regression-protected. The rendered
result in a real browser is NOT verified.** This sandbox has no GPU, no
`/dev/dri`, no Mesa/EGL/OSMesa libraries, and no Chromium or Xvfb, so no WebGL
frame can be produced here. Everything below is geometry and raycast evidence,
not a screenshot from the running game.

Of the four symptoms reported, exactly one was reproducible and traced to a
specific mesh. The other three could not be reproduced in the current code, and
I have not invented a cause for them.

---

## 1. What the reported symptoms were

> long black strips, huge grey polygons, displaced buildings, cyan surfaces

| Symptom | Outcome in this pass |
| --- | --- |
| Huge grey polygons | **Reproduced and root-caused.** Eight flat grey hexagonal pyramids on the skyline. Fixed. |
| Long black strips | **Not reproduced.** An automated scan of 19 rendered viewpoints found no unexplained dark band; the only large dark regions are a pitch-black building facade and window/door openings. |
| Displaced buildings | **Not reproduced.** No prop is off-island, ungrounded or outside world bounds (audit + 8.3/8.4 tests pass). |
| Cyan surfaces | **Not reproduced as a defect.** Cyan regions in the renders are the swimming pool prop and the intentional turquoise water band. |

I am not claiming these three are absent in your session — only that I could not
reproduce them from this code, so I will not guess at a cause. Section 7 lists
the two concrete things that *would* explain a mismatch between what I can see
and what you see.

---

## 2. Step 1 — the commit history was not what it looked like

`git log --oneline -8` returned **a single commit**. The checkout was a
**depth-1 shallow clone** (`.git/shallow` pinned to `642bde2`), so it looked as
though nothing had ever changed. After `git fetch --unshallow` the real history
is 55 commits:

```
642bde2 Merge PR #18                                     <- 8.3 merge
0f7eec6 CI CRAFT 8.3: geometry audit, bridge parapets, kerbs
1b19937 Merge PR #17
1821507 CI CRAFT 8.2: real road geometry, terrain alignment, kerbs
2e16832 Merge PR #16
a58cd6d CI CRAFT 8.1: fix terrain shader compile error
d587529 Merge PR #15
4f01930 CI CRAFT 8.0: layered terrain, real sky shader, ground cover
```

Largest recent world-geometry change set: **8.2** (`TerrainGenerator.ts` +400,
`MapExpansionBuilder.ts` +87, `VisualAtmosphere.ts` +37). 8.3 was small
(`TerrainGenerator.ts` 18 lines, `MapExpansionBuilder.ts` 7).

---

## 3. Step 2–5 — tracing the grey polygons to their mesh

The defect is visible in `artifacts/offline-preview/roads-4.png` and
`roads-3.png`: large flat grey triangles standing over the skyline.

Identified **two independent ways**, because 8.3 established that naming an
artefact by eye is how you end up fixing the wrong mesh:

1. **Projection.** Camera `roads-4` = eye `(120, 16.5, -78)` looking at
   `(150, 8.0, -100)`, fov 64. Projecting every backdrop object puts
   `DistantBackdropPeak` at `(334, -176)` on screen at **(762, 209)** — exactly
   where the pyramid is. Its geometry is `ConeGeometry(r, h, 6)`: a hexagonal
   pyramid, flat-shaded, single colour `#64748b`.
2. **Raycast** (`scripts/sceneProbe.mjs`, the durable form of the 8.3 ad-hoc
   `pick.mjs`).

> A first raycast appeared to show *nothing* at the pyramid. That was a bug in
> my own diagnostic — I had never called `updateMatrixWorld`, so the raycaster
> tested stale matrices. Worth recording so it is not repeated.

### Root cause

In `buildDistantSceneryIslands()`, the snow cap was sized

```ts
new THREE.ConeGeometry(r * 0.42, h * 0.42, 6)
cap.position.y = h * 0.78 - 4
```

against a rock cone of height `h` whose base sits at `y = -4` and apex at
`h - 4`. Measured over all eight peaks:

```
idx  height  r     peakApex  capApex  apexGap   capBaseRadius  peakRadiusAtCapBase  clearance
0      38   42      34.00     33.62     0.38        17.64             18.06            +0.42
1      56   58      52.00     51.44     0.56        24.36             24.94            +0.58
2      74   42      70.00     69.26     0.74        17.64             18.06            +0.42
...             (same pattern for all 8)
caps fully inside their peak: 8 / 8
```

* The cap's apex sits **0.38–0.74 m below** the rock's apex.
* The cap's base radius is **0.42–0.58 m smaller** than the rock's radius at
  that same height.

So **the snow cap was entirely enclosed by the rock cone and could never be
drawn**. All eight mountains rendered as bare, flat, single-colour slate
hexagonal pyramids — a "huge grey polygon" exactly as reported. Because the two
surfaces are nearly coincident near the summit on a 380 m object, they are also
a plausible source of depth fighting on a real GPU.

**This is why the geometry audit passed.** In 8.3 I allow-listed
`/DistantBackdrop/` so its legitimately ~90 m triangles would stop tripping the
size check. Allow-listing by name exempted those meshes from *every* check, so
the defect sat underneath a green audit. The same blind spot previously hid a
5,005 m stretched road triangle. Allow-listing removes scrutiny; it must
therefore be paired with a narrower structural check, not treated as “known
good”.

---

## 4. The fix

`src/world/TerrainGenerator.ts` — `buildDistantSceneryIslands()`. Two geometric
changes, no colour or transparency trickery:

1. **18 radial segments instead of 6** (and matching on the cap), so the
   silhouette is a mountain rather than a six-sided prism. A slight elliptical
   squash (`scale.z` 0.88 / 0.95 / 1.02) stops the eight reading as a stamped
   set.
2. **The snow cap is derived from the peak's own profile** and inflated 4.5 %
   outside it, with its apex just above the rock:

```ts
const CAP_BASE_FRAC = 0.62;   // snow starts at 62 % of the peak's height
const CAP_PROUD = 1.045;      // 4.5 % outside the rock surface
const capBaseY = PEAK_BASE_Y + h * CAP_BASE_FRAC;
const capApexY = PEAK_BASE_Y + h + h * 0.012;
const capRadius = r * (1 - CAP_BASE_FRAC) * CAP_PROUD;
```

For a sample height `u` up the shared axis, the clearance is

```
r(1-f)(1-u) * 0.045  +  r * u * delta/h     > 0   for all u in [0, 1]
```

so the cap is strictly outside the rock everywhere — it draws, it cannot
z-fight, and the summit reads as snow.

Nothing else was touched: the peaks keep their positions, count, intent and
visibility toggling in `GameEngine`.

### Result

Re-rendered `roads-4.png`: the flat grey pyramid now has a white snow line and a
rounded, 18-sided silhouette. The scene probe independently confirms it:

```
pre-8.4 :  0.9%  DistantBackdropPeak    [100.5x56.0x116.0 m, nearest 204.6 m]
           -- no DistantBackdropSnowCap line: zero camera rays hit it at all --

8.4     :  1.4%  DistantBackdropPeak    [114.2x56.0x110.2 m, nearest 200.2 m]
           0.5%  DistantBackdropSnowCap [ 45.4x22.0x 43.8 m, nearest 229.2 m]
```

The snow cap went from being hit by **no camera ray whatsoever** to covering
0.5 % of the frame — the difference between buried and visible, measured rather
than assumed.

---

## 5. Two faults in my own evidence pipeline (found and fixed)

These matter because they are why earlier rounds could report "the world looks
fine" while you saw otherwise.

1. **Two of the five 8.2 offline viewpoints were standing inside props.**
   `docks.png` showed a solid green rectangle filling ~70 % of the frame. A
   raycast put it at **3.4 m**, a `BoxGeometry` 3.2 × 3.0 × 6.8 m — a shipping
   container. `keep.png` was likewise hard against a tower. Both frames were a
   single flat-coloured prop and proved nothing about the world.
   Both cameras are moved in `scripts/offlineRender.mjs`; both now show usable
   scenes.

2. **The offline rasteriser does not emulate the terrain shader.** It reads raw
   vertex colours and albedo textures, but not `applyTerrainGroundDetail`
   (turf / soil / gravel / damp / dry / speckle). So pale patches in those
   images overstate how flat the terrain looks in a browser and must not be read
   as browser-visible corruption. Some of what looks wrong in my frames would be
   covered by vegetation and soil in the real shader.

---

## 6. Regression protection

`tests/graphics84.test.mjs` — 4 new tests, registered in `npm test` and
`test:graphics61`:

| Test | Asserts |
| --- | --- |
| every mountain has a snow cap | no peak is missing its cap object |
| cap sits strictly outside the rock at every height | samples 21 heights; fails if the cap is inside the cone anywhere |
| mountains are tessellated enough | `radialSegments >= 12` |
| base polygon is finely tessellated | max corner gap on the rim ≤ 31° (a 6-gon is 60°) |

**Validated against the defect, not just green.** Reverting
`TerrainGenerator.ts` to the pre-8.4 code makes **3 of 4 fail**; restoring the fix
makes all 4 pass. `scripts/geometryAudit.mjs` gained a matching backdrop
structural section (exempt from the size thresholds, still subject to the
structure checks) which reports all 8 buried caps on the old code:

```
FAIL backdrop: backdrop peak at (325, 100): cap apex 33.62 m is below the rock apex 34.00 m
... (8 of 8)
```

### Full verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean, exit 0 |
| `npm test` | **188 / 188 pass** (184 before + 4 new) |
| `npm run build` | exit 0, built in 532 ms |
| `npm run audit:geometry` | **PASS**, 712 meshes / 339,386 triangles |
| `scripts/visualAudit.mjs` | 706 meshes, 613,870 triangles, **colliders 1414 — unchanged** |

Cost of the fix: **+384 triangles (+0.06 %)**, no change in mesh count or
colliders. No gameplay, networking, match-rule, weapon or collision code was
touched. All modes, multiplayer, shooting, building and mobile controls are
untouched by this change set.

---

## 7. Honest limits — and what to check if you still see corruption

**The visual fix is UNVERIFIED in a browser.** I could not open WebGL here. What
I verified is that the geometry that produced the grey pyramids is now
structurally correct and that the snow caps are hit by camera rays; I did **not**
verify a single rendered WebGL frame. Do not treat the offline images as proof.

Things I could not establish, and will not guess at:

* Whether the remaining three symptoms reproduce in your session.
* Whether any depth fighting, shadow acne, culling or tone-mapping artefact
  contributes — `geometryAudit.mjs` proves geometry invariants only and cannot
  see any of these.

Two concrete explanations for a real mismatch between my frames and yours, both
worth checking before any further code change:

1. **Stale build.** If what you see still matches the *pre-8.2* descriptions
   (seabed-navy road strips, beige every-valley beach, a world that vanished to
   cyan sky), those specific defects were fixed in 8.2/8.3 and are covered by
   passing tests here. A cached bundle or an old preview tab would show exactly
   the old symptoms. Hard-reload, or rebuild and confirm the new
   `DistantBackdropSnowCap` snow line is visible on the skyline — that is a
   8.4-only marker and a quick way to tell which build you are looking at.
2. **GPU-only artefact.** Depth precision, PCF shadow acne and driver-specific
   culling cannot be reproduced offline. If you can supply a screenshot from the
   running game, the next step is to identify the offending mesh by raycast with
   `scripts/sceneProbe.mjs` rather than by eye.

### Reproducing everything in this report

```bash
npm ci
node scripts/geometryAudit.mjs                 # structure; now covers the backdrop
node --test tests/graphics84.test.mjs          # the 4 backdrop tests
node scripts/offlineRender.mjs --scene roads   # renders roads-1..6

# Name whatever is on screen from a given viewpoint:
node scripts/sceneProbe.mjs --scene roads-4
node scripts/sceneProbe.mjs --eye -8,72,18 --look -56,46.5,46 --fov 62
```

`scripts/sceneProbe.mjs` is new and durable: it raycasts a grid through a camera
and reports screen coverage, nearest distance, world bounds and material colour
per object, so an artefact can be named instead of guessed.

---

## 8. Files changed

| File | Change |
| --- | --- |
| `src/world/TerrainGenerator.ts` | `buildDistantSceneryIslands()`: 18 segments, cap derived from peak profile and inflated 4.5 % outside it, slight elliptical squash |
| `tests/graphics84.test.mjs` | **new** — 4 backdrop structural tests |
| `scripts/geometryAudit.mjs` | new backdrop structural section; no longer exempt by allow-list alone |
| `scripts/sceneProbe.mjs` | **new** — reproducible raycast scene probe |
| `scripts/offlineRender.mjs` | `docks` and `keep` cameras moved out of the props they were standing inside |
| `package.json` | `graphics84` registered in `test` and `test:graphics61` |
| `CI_CRAFT_8_4.md` | this report |

Not merged, not deployed.
