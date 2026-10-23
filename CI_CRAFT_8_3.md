# CI CRAFT 8.3 — world geometry recovery

Diagnostic pass across the whole generated world, plus two real defects found and
fixed. **No gameplay systems changed:** colliders are unchanged at **1,414**, and
no match-mode, weapon, hit-registration, inventory or UI code was touched.

---

## About the two reference screenshots

**Only one image arrived, and it is not a CI CRAFT screenshot.** It is the same
promotional video still supplied for 8.0 and 8.2: a third-person character on a
rock ledge, a sunset over a resort village, giant purple pyramids and lightning,
with a video scrubber and a "CI CRAFT" thumbnail row along the bottom.

It contains **none** of the reported symptoms — no black strips across roads, no
stretched grey geometry, no cyan surfaces surrounding the player, no displaced
buildings.

The second screenshot referenced in the brief did not come through at all.

So the defects could not be traced from the images. Instead I built a
whole-world geometry validator, ran it over all 712 meshes, and inspected the
world from 19 rendered viewpoints. Two genuine defects were found and fixed. I
cannot claim to have repaired the specific defects in the screenshots, because I
have not seen them.

---

## Defects found and fixed

### 1. Bridge parapets were being generated along ordinary flat road

**This is the closest match to "large stretched or triangular grey geometry",
"long black strips crossing the world" and "broken road connections".**

`buildRoadSurfaceGeometry()` decides whether a stretch of road is a bridge span
by comparing the deck height to the ground beneath it. It sampled the deck height
at the **left edge** of the cross-section but the terrain under the
**centreline**. Any camber or cross-slope on a normal road therefore produced a
"clearance" of several centimetres to metres, and with a 0.15 m threshold nearly
every segment qualified.

The result: a continuous grey parapet wall and pier row ran down **both sides of
every road on the island**, with a total of 2,040 triangles spread across the
whole map. From eye level these read as long grey slabs walling in the road.

Fix: clearance is now measured against the ground under the **same point** the
deck height came from, and the threshold is 0.9 m — a span a player could not
walk under. The structure mesh dropped from **2,040 triangles spread everywhere
to 300 confined to the Mirror Lake crossing** (bbox x −64..−21, z 21..147), and
the lake bridge is unchanged and still correct.

### 2. Every kerb stood twice as tall as designed

`buildRoadFurniture()` computed the kerb underside as
`centreHeight + averageKerbHeight - KERB_BURY` — adding the kerb height back
*before* subtracting the burial. Kerbs stood **0.34 m** proud instead of 0.17 m,
which reads from eye level as a low continuous barrier along every road edge.

Fix: `underside = centreHeight - KERB_BURY`. Median exposed kerb is now
**0.17 m** (was 0.34 m).

Both of these were introduced by my own 8.2 road work, not by earlier graphics
passes.

---

## The rest of the world: verified clean

`scripts/geometryAudit.mjs` (`npm run audit:geometry`) scans every mesh and
instance:

| Check | Result |
| --- | --- |
| Non-finite vertex coordinates | none |
| Out-of-range triangle indices | none |
| Triangles with an edge > 60 m (excluding allow-listed backdrop) | none |
| Meshes centred outside the world box | none |
| Instanced props outside the playable region | none |
| Detached destructible props (427 checked) | none |
| Water surface at −0.28 m; land ratio above water | correct, > 85 % |
| Road vertices below the water plane | none |
| Road triangles facing downward | none |

Allow-list, deliberately narrow: the sky dome (radius 285), the ~400 m distant
backdrop cones (now named `DistantBackdropPeak` / `DistantBackdropSnowCap` so they
are classifiable), and the legendary tower's light beam. **The road surface is
explicitly not allow-listed** — doing so would blind the stretched-triangle check
to the exact defect class that matters most.

Checked and found *not* to be at fault, rather than assumed:

- **Terrain mesh:** 43,681 vertices, 0 NaN, 100 % upward normals, 0 reversed
  winding in 86,528 triangles, `FrontSide` culling.
- **Water:** at the intended −0.28 m, below the island everywhere it should be.
  The cyan you see in the renders at Mirror Lake is intended water.
- **Cyan at the Docks:** that is the harbour pool, an intentional feature.
- **Buildings:** none submerged, none floating.
- **Distant mountains:** intentional backdrop 325–400 m out, not stretched
  geometry. Now named so audits can tell them apart.

One issue was found and **reverted rather than shipped**: 5 terrain vertices on
the road shoulder band at the lake shore still take lagoon turquoise instead of
gravel. Fixing it required moving the shoulder branch above the water branches,
which risks recolouring every coastal road; at 5 vertices of 931 the trade was
not worth the regression risk. It is recorded as a known remaining defect.

---

## Files changed

| File | Change |
| --- | --- |
| `src/world/TerrainGenerator.ts` | bridge clearance measured at the correct sample; 0.9 m threshold; backdrop meshes named |
| `src/world/MapExpansionBuilder.ts` | kerb underside corrected (was double-counted) |
| `scripts/geometryAudit.mjs` | **new** — whole-world geometry audit |
| `tests/graphics83.test.mjs` | **new** — 10 regression tests |
| `package.json` | registers `graphics83`, adds `audit:geometry` |

## Tests

`tests/graphics83.test.mjs`, 10 tests: finite coordinates, valid indices, no
stretched triangles, no mesh leaving the world, no off-island instances, terrain
and water elevation consistency, prop ground contact, road continuity and winding,
kerb height, bridge-structure placement.

**The validator was proven against real defects, not just a green run.** Each
failure class was injected and caught:

| Injected defect | Caught by |
| --- | --- |
| NaN vertex before buffer build | finite coordinates |
| Out-of-range index | index range |
| Vertex flung to x = 5000 | stretched triangles + mesh bounds |
| Instanced trees shifted 900 m | off-island instances |
| Kerb double-count reverted | kerb height |
| Bridge centre/edge sampling reverted | bridge placement |

The stretched-triangle injection initially **passed** — which exposed that the
road surface had been allow-listed by name. That hole is now closed.

## Results

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm test` | **184 / 184 pass** (174 + 10 new) |
| `npm run build` | exit 0, 758 ms |
| `npm run audit:geometry` | **PASS** |
| colliders (gameplay) | **1,414 — unchanged** |
| meshes / triangles | 706 / 613,486 |

## Locations inspected

19 viewpoints via `scripts/offlineRender.mjs`: plaza (6), docks, keep, farms,
tower, street, grove, terrain, plus the 6-viewpoint `roads` set — street level on
a primary, the Mirror Lake crossing at eye level and elevated, the east loop
connector, an above-hub junction view and the shoreline connector. Rendered at
1000×600.

## Remaining defects and limitations

1. **Not verified in a real browser.** No browser, WebGL or GPU in this
   environment. Every image is from the offline rasteriser, which emulates
   shading in JavaScript and does not reproduce browser PBR, tone mapping or the
   depth pipeline. The two defects fixed here were found by raycasting the
   generated scene and measuring geometry, not by looking at a browser.
2. **The reported symptoms could not be reproduced from the supplied reference**,
   because the reference is not a capture of this game. If the black strips and
   displaced buildings persist, a real screenshot of CI CRAFT would let me trace
   them directly.
3. 5 shoulder-band vertices at the Mirror Lake shore take water colour instead of
   gravel (documented above).
4. Paving texture and facade repetition remain as noted in 8.0.
