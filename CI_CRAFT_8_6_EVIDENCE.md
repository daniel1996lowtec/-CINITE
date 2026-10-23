# CI CRAFT 8.6 — first real gameplay screenshot: what it shows and what it proves

For the first time in this work there is actual evidence from the running game.
This report records exactly what the screenshot shows, what it rules out, and the
one hypothesis that survives — plus the single measurement still needed.

**No geometry was changed this round.** The world is confirmed broken; the cause
is not yet proven, and I will not revert or rewrite on an unproven cause.

---

## 0. The second attachment is not the game

Two files were attached:

| File | What it is |
| --- | --- |
| `photo_2026-10-23_06-40-13.jpg` | **Real gameplay.** Android Chrome, portrait, `…ttle-royale.onrender.com`, live match. This is the evidence. |
| `Screenshot_20261023_025824_Gallery.jpg` | **Not gameplay.** A phone gallery screenshot of a **20-second promo video** (playhead `00:14 / 00:20`): floating purple pyramids, a sci-fi operator, an AI-generated island village at sunset, plus a "CI CRAFT" video library strip. |

The promo video is concept/marketing material, not a render of the game. It
cannot be used as the "known-good baseline" and I have not used it as one. It is
worth noting because comparing the running game against that video would make
any working build look broken.

---

## 1. What the gameplay screenshot actually shows

Confirmed present, from the live site:

* **Flat turquoise water covering the ground the player is standing on.** The
  character's lower body is occluded by the surface. Sampled colour
  `rgb(109,184,184)`.
* **Solid grey boxes floating untethered in mid-air** in front of an intact
  house — long horizontal beams and slabs, several metres across, with black
  undersides, at inconsistent heights, overlapping each other and touching
  nothing.
* **A large smooth grey mass** in the mid-distance over the water, sampled
  `rgb(49,54,51)` to `rgb(80,100,81)`.
* **Black jagged geometry** with ragged, torn silhouettes on the left.
* **Scattered debris specks** strung along the far waterline.
* **A stray magenta diagonal line** across the sky.
* Washed lavender sky, `rgb(187,186,209)`.

Confirmed **working** in the same frame:

* HUD, minimap, phase timer, ammo, materials, health/shield.
* All mobile controls (joystick, ADS, FIRE, WALL/RAMP/FLOOR/ROOF, MAT).
* A live Battle Royale match: `ALIVE 14`, `PHASE 1 · NEXT IN 1:22`.
* **Intact hero geometry** — the red-brown roofed house with white trim, the
  large conifer, palm trees and shrubs all render correctly, with correct
  materials, textures and silhouettes.

That last point is the most important one in this entire report. **A corrupted
pipeline, a broken tone mapper or a failed global shader would not leave the
hero building and the tree perfectly rendered while the ground disappears.**
The damage is not uniform, so it is not a global rendering failure.

---

## 2. What is now ruled out, and how

| Hypothesis | Test | Result |
| --- | --- | --- |
| Stale deployment predating the graphics work | The live page's static DOM says `SHRINKS IN`; the screenshot's runtime HUD says `NEXT IN`. Repo has `SHRINKS IN` in `index.html:867` and the mapping to `NEXT IN` in `HUDManager.ts:739`. | **Consistent with current source** — but that mapping dates from 3.5, so it only proves the build is ≥ 3.5. It does **not** distinguish 8.1 from 8.4. Partially open. |
| Mobile renders a different world | `grep` for quality-tier references across `src/world/*.ts` | **Ruled out** — the quality tier never reaches world generation. Every device builds the same world. |
| Non-deterministic world generation | `grep Math.random()` across `src/world/` | **Ruled out** — only 3 uses, all on atmosphere particle positions (`TerrainGenerator.ts:1473-1476`) and one build ID. All world geometry is deterministic. |
| Degenerate instance transforms turning boxes into plates / domes | Scanned all 17,129 instance matrices in 3D-solid instanced meshes | **Ruled out** — every collapsed axis (2505) is an intentional thin roof/floor/glass panel (`scale.y` 0.09–0.14); every large axis (117) is a tower column. No instance is accidentally flattened or inflated. |
| Frustum culling quietly dropping the terrain | Recomputed bounding spheres against true vertex extents | **Ruled out** — terrain radius 382.0 equals the true max vertex distance, finite, 0 NaN vertices. |
| Water plane sitting above the land | Water `y = -0.28` over 1600 × 1600 m; terrain `y = -5.31 … 19.33` over 540 × 540 m | **Ruled out** — water is below land. |
| A stray cyan sheet over the world | Enumerated all 165 cyan-capable meshes with bounds | **Ruled out** — the only large ones are the ocean and glass panes; the 463 m `#e0f2fe` object is a 7.5 m-wide `RingGeometry` foam band. |
| Terrain shader declaration-order / compile error | Assembled the real shader via `onBeforeCompile` and resolved all chunks | **Ruled out** — `natural` declared at line 1474 with 0 uses before it; no unresolved includes. |

---

## 3. The hypothesis that survives

Everything above says the **world data is correct and deterministic**, and that
my headless build of the same source renders it coherently (audit PASS,
706 meshes, 1414 colliders, raycast probes clean). Yet the live game shows
ground missing with props floating over water.

The one explanation consistent with all of it:

> **The terrain mesh is not being drawn on that device, because its shader
> failed to compile or link there.**

Why this fits every observation:

* Three.js **skips a failed program entirely** — the mesh vanishes and nothing
  is drawn in its place. The ocean plane then shows through wherever the terrain
  was, which is the turquoise covering the playable world.
* Every *other* mesh still draws, so roads, buildings, props and piers appear to
  float, and "buildings, roads and bridges do not align".
* The hero house and tree render perfectly, because they use stock materials.
* The terrain material is the **only** material in the project carrying custom
  injected GLSL and a custom vertex attribute (`aPavedMask`).
* It gets worse across the graphics series because that shader grew in every
  release: 8.0 added `vCicraftGroundPos` + `vCicraftGroundNormal` (6 varying
  components), 8.2 added `vCicraftPaved` (1 more).
* It cannot be reproduced in this sandbox, because **no GLSL is ever compiled
  here** — the offline rasteriser evaluates none of it.

**What I could NOT do is prove it.** I tried to measure varying pressure and the
measurement is not trustworthy: my analyser scores stock `MeshStandardMaterial`
at 18 vec4 vectors, which cannot be right, because it counts every `#ifdef`
branch including disabled texture-map varyings. The true live count needs a real
GLSL compiler. So the varying-overflow explanation is a **hypothesis, not a
finding**, and I have not changed the shader on the strength of it.

---

## 4. What was changed this round

One file, one addition, **zero change to any visual output**:

`src/core/GameEngine.ts` — after renderer construction:

```ts
this.renderer.debug.onShaderError = (gl, program, glVertexShader, glFragmentShader) => { … };
```

It records, per failure: the program/shader info logs, the driver's `RENDERER`
string, and `MAX_VARYING_VECTORS` / `MAX_VERTEX_UNIFORM_VECTORS` /
`MAX_FRAGMENT_UNIFORM_VECTORS`. Failures accumulate on
`window.__cicraftShaderErrors` and are logged with `console.error`.

That is the missing measurement. It costs nothing when the shader compiles, and
if the hypothesis is right it will name the failing material **and** the exact
driver limit that was exceeded, on the device that actually shows the bug.

---

## 5. Validation

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean, exit 0 |
| `npm test` | **188 / 188 pass** |
| `npm run build` | exit 0, 650 ms |
| `npm run audit:geometry` | **PASS** — 712 meshes, 339,386 triangles |

No gameplay code touched: BR, FFA, TDM, multiplayer, late joining,
server-authoritative combat, building, weapons, inventory, respawning, scoring,
chat, mobile HUD and controls are unchanged.

---

## 6. Answers to the required report

1. **Last known-good revision** — still **not established**. The only gameplay
   frame I now have is of the *broken* build. The promo video is not the game.
2. **Regression-causing commits** — **not confirmed.** 8.2 (`1821507`) remains
   the prime suspect for a *shader* regression, because it last modified
   `VisualAtmosphere.applyTerrainGroundDetail`, the function that blanked the
   world in 8.0 and was repaired in 8.1. Nothing is proven.
3. **Recovery performed** — **none.** No revert, no reset, no geometry change.
4. **Test results** — 188/188, build 650 ms, audit PASS.
5. **Before/after screenshots** — one "before" (the broken gameplay frame). No
   "after", because there is nothing verified to show.
6. **Live Render deployment verified?** — **No.** It is reachable and serving a
   build ≥ 3.5, but I cannot deploy, cannot read its console, and have no way to
   confirm which commit it runs.

## 7. The one thing needed next

`console.error` output from a session on that phone, or `__cicraftShaderErrors`
pasted from the browser console. If it names the terrain material and a
`MAX_VARYING_VECTORS` value, the cause is proven and the fix is a focused shader
change (pack or drop the three custom varyings). If it is empty, the terrain
shader is exonerated and the fault is in depth or shadow state instead — a
different fix entirely.

**I have not claimed the world is fixed. I have seen it broken, and I have
narrowed it to the point where one measurement decides the fix.**
