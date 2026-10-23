# CI CRAFT 8.1 — world rendering regression repair

**Severity:** production-blocking. The terrain did not render at all in the
browser.

**Root cause:** one line of GLSL assigned a variable before it was declared.
**Fix:** one 9-line block moved to the correct shader chunk.
**Gameplay impact:** none. Collision, routes, loot, weapons and match rules are
byte-identical; the collider count is unchanged at 1,414.

---

## 1. Root cause

8.0 added a surface-normal perturbation to the terrain material in
`src/world/VisualAtmosphere.ts`. It was injected at `#include <map_fragment>`:

```glsl
normal = normalize(mix(normal, normalize(normal + groundBump * 0.42), 0.6));
```

Three.js does not declare `normal` until `normal_fragment_begin`, several chunks
later. Measured chunk order in this version of `meshphysical`:

```
map_fragment            -> 31
normal_fragment_begin   -> 38    (declares `normal`)
normal_fragment_maps    -> 39    (first legal write)
```

Writing `normal` at position 31 is an undeclared-identifier error. The whole
terrain fragment program failed to compile, so **the terrain mesh was never
drawn**.

A false trail worth recording: the resolved shader *does* contain
`vec3 normal = geometryNormal;` earlier in the file, but it lives inside the
standalone `RE_Direct_Physical()` function — a different variable in a different
scope. Matching the first `vec3 normal` produces a false pass.

## 2. Why the world turned turquoise

Directly beneath the island is the ocean plane in `TerrainGenerator`:

```
geometry            PlaneGeometry(1600, 1600, 64, 64)   // covers the whole map
elevation           y = -0.28
vertex colours      0x2dd4bf → 0x06b6d4 → 0x0284c7       // turquoise
```

Every vertex inside `islandRadius * 0.96` — that is, the entire playable island —
is painted the shallow turquoise gradient. In normal play the terrain hides it
because the island sits above −0.28 m. With the terrain program failing, that
sheet was the ground.

The remaining symptoms follow from the same cause and were **not** separate bugs:

| Report | Explanation |
| --- | --- |
| Huge turquoise surfaces over the playable terrain | ocean plane visible through the missing terrain |
| Long black and grey strips floating above the ground | roads, kerbs and sidewalk meshes still drew, on correct coordinates, over turquoise |
| Buildings disconnected / mispositioned | building plinths and props were correct; the ground they meet was absent |

## 3. The fix

The perturbation was moved out of `map_fragment` and injected after
`#include <normal_fragment_maps>` — the first point where `normal` exists and is
still writable. It also re-derives its own noise sample instead of depending on a
variable scoped to the old block.

```glsl
#include <normal_fragment_maps>
{
  vec2 gp3 = vCicraftGroundPos.xz;
  float nBase = cicraftValueNoise(gp3 * 1.7);
  float e = 0.05;
  float nx = cicraftValueNoise((gp3 + vec2(e, 0.0)) * 1.7) - nBase;
  float nz = cicraftValueNoise((gp3 + vec2(0.0, e)) * 1.7) - nBase;
  vec3 groundBump = vec3(nx * 3.0, 1.0, nz * 3.0);
  normal = normalize(mix(normal, normalize(normal + groundBump * 0.42), 0.6));
}
```

Nothing was disabled, hidden, recoloured or deleted. The water plane, the ground
shader and every 8.0 improvement are untouched.

## 4. Why the existing tests missed it

- The shader-ordering helpers in `graphics62` (`resolveChunks`,
  `assertInjectedAfter`) were applied to **vertex** injections only. The same
  class of bug had already happened once before, in the vertex stage.
- `scripts/offlineRender.mjs` emulates shading in JavaScript; it never compiles
  GLSL, so it rendered a perfect world the entire time.
- No test asserted that a material's shader assembles into legal GLSL.

## 5. Regression tests added — `tests/graphics81.test.mjs`

Five tests, registered in both `npm test` and `test:graphics61`:

1. the terrain material assembles into legal GLSL (no unresolved `#include`,
   detail actually injected);
2. the surface normal is written only after it is declared — asserted both
   structurally (after the `normal_fragment_maps` anchor) and in the fully
   resolved shader (after `vec3 nonPerturbedNormal = normal;`);
3. nothing writes `normal` inside the `map_fragment` block, bounded by the next
   chunk anchor so a later legal write cannot mask it;
4. the roughness injection follows `roughnessFactor`'s declaration;
5. the terrain and water plane stay correctly ordered — the island centre is
   land, and over 85 % of the playable radius sits above the water surface.

**These tests were validated against the bug, not just against the fix.** The
defect was re-introduced temporarily and tests 2 and 3 failed as intended; the
fix was then restored and all five pass.

## 6. Additional audit performed

Because the browser compile is not reproducible here, every shader-injecting
material in the world was assembled the way the renderer does it and scanned
for unresolved chunks and writes-before-declaration:

| Material | Unresolved chunks | Writes before declaration |
| --- | --- | --- |
| terrain (`applyTerrainGroundDetail`) | 0 | none |
| water (`applyOceanShader`) | 0 | none |
| foliage (`applyFoliageWind`) | 0 | none |
| architecture (world-space UV) | 0 | none (already covered by `graphics62`) |
| sky dome (`SkySystem`) | 0 | reviewed by hand |

The sky dome's `depthTest: false` was reviewed specifically: it is safe because
the dome sets `renderOrder = -100` and `frustumCulled = false`, so it always
draws first and everything else paints over it. It was **not** changed.

The terrain mesh itself was checked directly: 43,681 vertices, **0 NaN
positions**, **100 % upward normals**, **0 downward-wound triangles** in 86,528,
`FrontSide` culling. Winding, normals, scale and transforms were not the fault.

## 7. Verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm test` | **167 / 167 pass** (162 before + 5 new) |
| `npm run build` | exit 0, 631 ms |
| colliders | 1,414 — unchanged |
| draw calls / triangles | 705 / 605,098 — unchanged |

No geometry, material, collision or gameplay value changed in this repair.

## 8. What remains unverified

**The fix was not confirmed in a real browser.** This environment has no browser,
no WebGL and no GPU — `chrome`, `chromium`, `firefox`, `xvfb-run`, `puppeteer`,
`playwright` and `headless-gl` are all absent, and there is no `/dev/dri`. A CPU
GLSL compiler was attempted (`@webgpu/glslang`) and hangs in this sandbox.

The evidence is therefore static, not empirical: chunk ordering resolved against
the real Three.js build, plus tests that demonstrably fail when the bug is
present. A CPU compiler would have caught this; a browser definitely can.

**Fastest confirmation, on a machine with a GPU:** load the game and check the
console. Before the fix, Three.js logs
`THREE.WebGLProgram: Shader Error ... 'normal' : undeclared identifier` for the
terrain material. After the fix that message must be gone and the ground must be
visible from the first frame.

The images in `artifacts/offline-preview/` were regenerated and are unchanged —
which is exactly the point: that renderer never reproduced the bug, so it cannot
serve as proof of the repair.
