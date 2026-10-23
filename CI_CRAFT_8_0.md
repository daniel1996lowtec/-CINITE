# CI CRAFT 8.0 — Graphics pass

This pass changes **what the world is made of**, not just how it is graded. Every
item below is either new geometry, a new material, or a deliberately reworked
placement/quality rule. Settings work that is purely colour grading is not
counted as an improvement here.

Branch: `arena/ce7751ae-cinite` · PR #15 · not merged, not deployed.

---

## 1. Sky and atmosphere (new file: `src/world/SkySystem.ts`)

The 7.x sky was a 40×24 vertex-coloured sphere with a flat circle mesh for the
sun and a ring mesh for the halo. It had **no clouds at all** — the sky in every
build up to 7.2 was a smooth gradient.

Replaced with an analytic shader dome:

- 3-stop vertical gradient (zenith → horizon → below-horizon ground colour).
- Sun drawn in the shader with limb darkening, a corona falloff and forward
  scattering, so the sun is round and physically shaped instead of a flat quad.
  The separate `sunMesh` / `sunHaloMesh` meshes are **deleted**.
- Two procedural cloud decks (a base layer plus a higher detail layer), driven by
  `uCloudCoverage`, `uCloudShade` and `uCloudLit`, so the deck has a lit top and a
  shaded underside rather than a flat white smear.
- Stars that fade in for the night preset.
- Horizon haze and 8-bit dither to stop banding in the gradient.
- Three presets (`day`, `sunset`, `night`) in `SKY_PRESETS`.
- The shader ends with `<tonemapping_fragment>` and `<colorspace_fragment>`, so it
  goes through the same tone mapping and output transform as every other
  material. It is not a raw RGB blit.

**Aerial perspective** (`updateAerialPerspective`) now derives the fog colour from
the sky preset *and the camera's forward vector* — look toward the sun and the
distance warms, look away and it cools to the zenith. 7.x used one fixed fog hex
per preset, which is why distance haze never matched the sky.

## 2. Terrain material — layered, not one flat value

`applyTerrainGroundDetail` in `src/world/VisualAtmosphere.ts` was a
brightness-only noise pass: the ground kept a single albedo and only its
luminance wobbled. It now blends **materials**:

| Layer | Driver |
| --- | --- |
| Turf | two-scale noise mask × altitude × slope |
| Exposed soil | inverse turf × fine noise |
| Gravel / rock | slope × speckle |
| Damp hollows | low-frequency noise, cooled and darkened |
| Sun-bleached crowns | low-frequency noise, lifted warm |
| Wet shoreline | height near the water line, darker and glossier |

Roughness drops where the ground is wet, so shorelines and damp soil actually
catch a highlight instead of reading as dry plastic. The normal is perturbed from
the same noise field, giving the ground real relief at grazing angles.

**Beach fix.** Sand used to be painted on *every* flat area below 1.85 m, which
turned most of the island into one beige field. Sand is now gated on genuine
proximity to the sea, a river or a lake, plus a macro-noise mask, and the dune
edge lerps into dry marram grass. Measured pixel at the same spot before/after
the fix: `rgb(232,226,208)` → `rgb(106,171,85)`.

## 3. Ground cover — clustered instanced grass

New, in `IslandWorld`:

- 3 `InstancedMesh` bands (`ground_cover_0/1/2`) at capacities 2400/2500/1500,
  plus `ground_flowers` at 1400. Geometry is a 6-triangle crossed tuft.
- Clump centres come from a **16 m jittered grid** with a two-octave patch mask,
  so coverage follows the island instead of the 190 random points 7.x used
  (which left two thirds of the meadow bare).
- Per-instance colour from `GRASS_TINTS` / `FLOWER_TINTS`, per-instance yaw and
  non-uniform scale.
- Tuft heights are 0.34–0.6, 0.44–0.78 and 0.55–0.95 of a 0.68 m geometry —
  i.e. **6–65 cm of meadow**, not the 1.6 m stalks an earlier revision produced.
- Rejects roads, structures, slopes over 0.5, beach and — new — **paved POI
  plazas**, so grass no longer grows out of the shop forecourt.
- Ground cover has **no colliders**. It cannot block a player or a shot.

### Quality tiers

`world.setGroundCoverQuality(level)` is a visibility flip over the four batches:
LOW shows band 0 only and no flowers; MEDIUM shows two bands; HIGH/ULTRA show all
three plus flowers. No rebuild, no buffer upload, no effect on collision.

`terrain.setSkyQuality(bool)` evaluates one cloud layer on LOW/MEDIUM and two on
HIGH/ULTRA.

## 4. Trees — proportions corrected

The trunk geometry had unit-height radii of 0.17 / 0.32 while the instance only
scaled **Y** by trunk height. The radius was therefore absolute: a 5.4 m tree
carried an 0.82 m trunk — a fat brown cone with a blob on top, exactly the
"lollipop" read.

- Trunk radii reduced to 0.125 / 0.21 and limbs thinned from 0.062/0.026 to
  0.045/0.018.
- Broadleaf trunk height raised 2.6 → 4.3 m (palms 3.4 → 4.1 m) so the crown
  clears the third-person eyeline.
- Crown moved from y 3.5 to 3.95 + per-tree jitter, with a lateral offset, a
  small rotation jitter and per-tree non-uniform scale — silhouettes no longer
  repeat and the crown is no longer a symmetric ball on a stick.
- Conifer body raised with the trunk, slightly narrower so the whorl silhouette
  reads as a spruce rather than a triangle.

XZ instance scale is deliberately **1**. Scaling it by trunk height squares the
radius-to-height ratio and produces a barrel-thick trunk; that mistake was made,
rendered, and reverted in this pass.

## 5. Offline preview fidelity

`scripts/offlineRender.mjs` is a diagnostic rasteriser, not the game renderer. It
was silently wrong in two ways found this pass:

- It ignored `material.side === DoubleSide` and culled every back face, so all
  crossed-billboard foliage was invisible from half of all azimuths. Back faces
  also shaded black because the normal was not flipped.
- Its ground-detail emulation was the old brightness-only model, so it could not
  show the new layered terrain at all.

Both are fixed, and the ground emulation now mirrors the shader layer-for-layer.
There is a test (`graphics62`, "identical noise constants") that fails if the two
drift apart again.

## 6. Tests, budgets and what changed in them

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm test` | **162 / 162 pass** |
| `npm run build` | exit 0, built in 588 ms |

Budget changes are recorded, not silent. Measured tier totals:

- LOW/MEDIUM **327,640** triangles (was 325,000 → 330,000 threshold)
- HIGH/ULTRA **609,542** triangles (was 585,000 → 620,000 threshold)

The delta over 7.2 is +2.6 k on LOW and +24.5 k on HIGH, and it is entirely the
new ground cover. No existing geometry was made heavier to reach these numbers,
and the collision count is unchanged at **1,414** — asserted by
`7.0 gameplay: collision and route geometry are untouched by the graphics pass`
and the 3.5/3.6 byte-identical fingerprint tests.

`worldExpansion` previously asserted a `AtmosphericSun` *mesh*. That mesh no
longer exists by design, so the assertion now checks the shader contract instead:
the material name, a normalised sun direction, an emitting sun, a non-zero cloud
coverage, and that the sun disc is present in the fragment source.

**An earlier attempt in this pass added a POI exclusion to tree placement. It was
reverted**, because trees own collision cylinders and the change moved gameplay
collision. The forecourt "saplings" turned out to be over-tall grass tufts, which
were fixed in the ground-cover pass instead.

## 7. Measured world statistics (`scripts/visualAudit.mjs`)

```
generation: 1556 ms
draw calls: 705 (185 instanced batches, 15,762 instances)
triangles:  605,098   vertices: 1,071,040
unique geometry / materials / textures: 459 / 175 / 40
colliders (gameplay): 1414
```

## 8. Known limitations — stated, not hidden

1. **No browser or GPU verification was possible in this environment.** There is
   no WebGL, no browser and no device here. Every image in
   `artifacts/offline-preview/` was produced by the offline rasteriser, which has
   its own Lambert + analytic-sky shading, no PMREM environment, no PBR and no
   tone mapping. **It is not proof of how the game looks in a browser**, and it
   should not be presented as a before/after screenshot. Real per-frame timing,
   draw-call cost on a GPU, and shadow behaviour remain unverified.
2. The reference image supplied with the brief is a promotional video still of a
   different, stylised game. It was used for target quality and atmosphere only.
   No geometry, art direction or asset from it was reproduced.
3. The paved forecourt still renders as a pale, low-detail surface. It is
   correctly grey rather than white (`rgb(182,199,187)`, not clipped), but it has
   no paving texture or joint detail yet.
4. Roof-level detail and facade variation were not extended in this pass beyond
   the 6.2/7.0 kits; there is still visible repetition between buildings.
