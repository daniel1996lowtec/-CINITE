# CI CRAFT 8.2 — road geometry and terrain alignment

Targeted repair of the road network. No redesign, no new graphics features, no
change to collision, movement, weapons, match rules or any other gameplay system.
Collider count is unchanged at **1,414**.

---

## About the reference image

The attached screenshot is the same promotional video still supplied for 8.0: a
third-person character on a rock ledge, a sunset over a resort village, giant
purple pyramids and lightning. It is a still from a different game's promo video,
not a capture of CI CRAFT, and it does not contain the road defects described.

It could therefore not be used to trace a defect. The road problems were located
by inspecting the actual road-generation code and the rendered world instead. The
symptoms in the brief — black strips crossing road surfaces, disconnected road
edges, objects detached from roads — were all reproduced and traced.

---

## Root causes — four separate defects

### 1. Roads had no geometry at all

Roads existed **only** as per-vertex colours on the terrain mesh. The terrain is
`PlaneGeometry(540, 540, 208, 208)`, so its lattice spacing is `540 / 208 =
2.60 m`. A carriageway is 7.2 m wide — that is **2.8 vertices across**.

The road edge was therefore a 2.6 m interpolated colour gradient, and the
asphalt/shoulder classification snapped to whole vertices, producing bands along
triangle edges. This is the "disconnected road edges" and much of the streaking.

**Fix:** roads are now real geometry. `buildRoadSurfaceGeometry()` merges a quad
strip per segment, subdivided every ~6 m, plus a paved junction disc at every one
of the 25 nodes. Ribbons are trimmed by the junction radius at each end and the
disc fills the middle, so segments join without gaps and without coplanar
overlap. Verified: 1,274 deck triangles, **all facing up, 0 degenerate**.

### 2. The terrain colour cascade painted water and sand over roads

The cascade tested **water depth first and roads last**:

```
shoreJ < -0.35   → seabed 0x075985
shoreJ < 0.08    → lagoon 0x0e7490
shoreJ < 0.52    → wet sand
...roads...      → unreachable on low ground
```

Every road vertex on low ground was painted seabed navy or lagoon turquoise before
the road branch was reached. Measured on the lattice, the single darkest
"asphalt" vertex was `rgb(0.0018, 0.0826, 0.1939)` — that is `0x075985` in linear
space, i.e. **pure seabed navy**. These are the long dark strips crossing the
carriageway.

**Fix:** the carriageway branch is evaluated first, gated on `roadDist < 3.6 &&
vy > -0.2` so genuinely submerged terrain keeps its seabed colour. The ±0.22 m
jitter on the asphalt band was also removed — it made the painted road edge wander
away from the geometry. Measured on carriageway interiors, before → after:
median luminance **0.283 → 0.197**, p90 **0.308 → 0.233**, max **0.654 → 0.267**.

### 3. The 8.0 ground shader painted turf over asphalt

The 8.0 layered ground shader blended turf (45 %), soil (up to 40 %), gravel and
damp overlays into `diffuseColor` with no notion of roads, and perturbed the
normal with 1.7 m noise. On a 7 m carriageway that is a full-width organic
pattern. Measured: asphalt `#77787a` → `#696d5c`, green-tinted and muddy.

**Fix:** the terrain now carries an `aPavedMask` vertex attribute and the shader
multiplies every organic overlay weight by `1 - paved`, so paved surfaces keep
their authored colour and stay flat. The mask is exact on 95 %+ of road vertices
and blends over 1.15 m at the verge.

### 4. Kerbs were rigid boxes hovering over the ground

Each kerb was **one** 6.12 m box placed at a single mid-point height. On
undulating ground its ends lifted clear: measured at **98 % of 838 spans floating,
worst 5.78 m**. These are the "objects incorrectly positioned relative to the
roads".

**Fix:** each kerb is split into two sub-spans, each positioned from the terrain
beneath itself, with the underside buried 0.35 m so dips never expose it, and any
span whose ground varies more than 0.12 m across its length is skipped (a kerb
does not belong on a bank that steep). Verified on the live instances: **0 of
1,107 kerb strips floating, worst 0.11 m**.

### 5. Bonus: the road drove through Mirror Lake

The primary `(0,0) → (-105,95)` crosses Mirror Lake, where the bed is **−1.65 m**
— below the −0.28 m water plane. 2.5 % of the road was underwater, which is why
navy lakebed paint showed across the route.

**Fix:** the deck never drops below `water + 0.95 m`; where the ground falls away
the ribbon spans the gap. Because it is a `Math.max` on the ground height, the
deck meets the shore exactly where the ground rises through it — no step. The
elevated span is 2.9 % of the network (max 2.32 m clearance) and gets **parapets
and piers** in a separate mesh so it reads as a bridge, not a floating slab. Road
furniture (kerbs, poles, delineators) is skipped where the ground is at or below
the water plane.

### Also fixed: road height was sampled from the wrong surface

Ribbons were initially built from `getTerrainHeight`, the *analytic* field
collision uses. But the terrain mesh samples that field on the 2.60 m lattice and
interpolates **linearly** between vertices, so the drawn surface can sit up to
0.55 m above the analytic value. Roads sank into convex ground and terrain poked
through the asphalt in patches.

`getRenderedTerrainHeight()` now reproduces Three's `PlaneGeometry` triangulation
exactly (split along the `(ix, iy+1)–(ix+1, iy)` diagonal, piecewise planar, not
bilinear). Validated by raycast against the real mesh at 4,000 random points:
**mean error 0.0000 m, max error 0.0000 m**. Road vertices with terrain poking
through: **5.13 % → 0.00 %**.

Gameplay collision was **not** changed — this only affects where decorative road
geometry is drawn.

---

## Files changed

| File | Change |
| --- | --- |
| `src/world/TerrainGenerator.ts` | road surface geometry (ribbons, junction discs, bridge deck/parapets/piers); `aPavedMask` attribute; carriageway colour branch hoisted above water/sand; rendered-height sampling |
| `src/world/VisualAtmosphere.ts` | ground shader honours the paved mask on every overlay weight and on the normal perturbation |
| `src/world/MapExpansionBuilder.ts` | kerbs follow the terrain in two sub-spans; furniture skipped over water |
| `scripts/offlineRender.mjs` | new permanent `roads` inspection scene (6 viewpoints) |
| `tests/graphics82.test.mjs` | **new** — 7 regression tests |
| `tests/*.test.mjs` | tier budgets raised with a recorded ledger |
| `package.json` | registers `graphics82` in `npm test` and `test:graphics61` |

## Tests

`tests/graphics82.test.mjs`, 7 tests:

1. road geometry exists, is indexed, faces up, no degenerate triangles
2. no road vertex below the water plane
3. road surface tracks the rendered terrain (raycast, no poke-through)
4. carriageway interior is paved, not water or sand (luminance p90/max)
5. paved surfaces are masked from the organic ground shader
6. every kerb strip sits on its ground (0 floating of 1,107)
7. junction discs close every node

**Validated against the defects, not just the fix.** Each fix was temporarily
reverted and the suite re-run:

| Reverted | Tests that failed |
| --- | --- |
| bridge deck + rendered height + road priority | 2, 3, 4 |
| kerb sub-spans / bury / steep-span skip | 6 |

## Results

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm test` | **174 / 174 pass** (167 before + 7 new) |
| `npm run build` | exit 0, 564 ms |
| colliders (gameplay) | **1,414 — unchanged** |
| draw calls | 705 → **706** (one extra: bridge structure) |
| LOW/MEDIUM triangles | 333,510 (budget 338,000) |
| HIGH/ULTRA triangles | 614,162 (budget 622,000) |

Budget ledger: the 8.2 delta is +5.9 k LOW and +7.0 k HIGH, from the road surface
mesh plus the split kerbs. All of it is essential-tier — a road cannot be
quality-gated away without deleting the road network on LOW — so both tiers carry
it.

## What remains unverified

**The fix was not confirmed in a real browser.** This environment has no browser,
no WebGL and no GPU. Every image in `artifacts/offline-preview/` comes from the
offline rasteriser, which emulates shading in JavaScript and does not reproduce
the browser's PBR, tone mapping or depth pipeline. It is a diagnostic, not proof.

What the offline renders *do* show, and what a browser check should confirm:

- `--scene roads` (6 viewpoints) is now a permanent, reproducible inspection set.
- Road surfaces are continuous with clean edges and no strips crossing them.
- Kerbs follow both edges of the carriageway.
- Junctions close through discs with no visible seams.
- The Mirror Lake crossing reads as a bridge with parapets and piers.

Specifically still to confirm on a GPU: depth-offset behaviour at grazing angles
(the deck uses `polygonOffset`), shadow reception on the new road and bridge
meshes, and that no z-fighting appears where the road meets the terrain at
distance.
