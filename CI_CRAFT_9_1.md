# CI CRAFT 9.1 — visual polish, safe mode

**Branch** `arena/54690527-cinite` · **commits** `3b6262c` (polish) + `3245a18` (patch)
**Base** `be65a9c` (= `main`, the world you chose after the side-by-side comparison)
**Not merged. Not deployed.** A live preview is running for your visual check.

---

## 1. Files changed

| File | +/− | What changed |
| --- | --- | --- |
| `src/world/VisualAtmosphere.ts` | +64 / −2 | sun rig, shadow rig per tier, fog scale per tier |
| `src/core/GameEngine.ts` | +59 / −12 | ambient/key rebalance, `applyShadowQuality`, tier fog wiring |
| `src/world/RoadNetwork.ts` | +21 / −8 | two-scale asphalt wear, slightly less matte roughness |
| `patches/ci-craft-9.1-visual-polish.patch` | new | `git format-patch` of `3b6262c`, verified to apply cleanly on pristine `be65a9c` |

**Nothing geometric is touched.** A grep of every added line for
`collider|collision|geometry|BoxGeometry|hitbox|damage|velocity|network|health|
world.generate` returns only my own comments. Geometry audit output is
**identical to before: 712 meshes / 361,788 triangles**.

### What each change does

**Light rig.** Day sun elevation 47.9° → 34.9°, moved off-axis. Longer, readable
shadows and real directional form on buildings and trees. The *light* moves; no
world coordinate does.

**Ambient/key balance.** Hemisphere 0.96 → 0.66, sun 1.54 → 1.86. At 0.96 ambient,
shadowed faces were nearly as bright as lit ones, which is exactly why the world
read flat. Total delivered light is roughly unchanged, so nothing gets darker
overall. Day key warmed `0xfffbeb` → `0xfff0d2`.

**Shadows per tier.** Was a fixed 1536 px map for every device. Now
1024 / 1536 / 2048 / 2048 with matching PCF radius and normal bias — phones pay
less, desktops get crisper contact shadows. Tier changes at runtime dispose and
rebuild the shadow target explicitly instead of silently doing nothing.

**Fog per tier.** 0.001944 / 0.001800 / 0.001692 / 0.001620 for day
(low → ultra): mobile slightly denser, desktop clearer, so distant buildings stay
readable.

**Asphalt.** Single high-frequency jitter → two scales: a slow ~9 m
resurfaced-patch layer under the existing fine grain, plus roughness 0.93 → 0.90.
Vertex colours only — no extra draw call, no texture, no geometry change, and
deterministic so every client sees the same road.

---

## 2. Test results

| Check | Result |
| --- | --- |
| `tsc --noEmit` | ✅ clean |
| `npm test` | ✅ **205 / 205 pass** |
| `npm run build` | ✅ 593 ms |
| `npm run audit:geometry` | ✅ PASS — 712 meshes, 361,788 triangles |

Plus numeric verification of the new helpers, since I could not see them render:

```
shadow low    mapSize=1024 radius=1.2 normalBias=0.034
shadow medium mapSize=1536 radius=2.0 normalBias=0.028
shadow high   mapSize=2048 radius=2.4 normalBias=0.024
shadow ultra  mapSize=2048 radius=2.6 normalBias=0.022
fog day: low 0.001944 · medium 0.001800 · high 0.001692 · ultra 0.001620
day sun elevation = 34.9 deg (was 47.9)
```

I also confirmed the new call is safe at construction time:
`resolvedGraphicsQuality` is field-initialised to `'high'` and `this.settings` is
a field initialiser, so `applyShadowQuality(this.getResolvedGraphicsQuality())`
inside `setupLighting()` cannot fire before either exists.

---

## 3. Visual checks actually performed — and what they proved

**I rendered three viewpoints (street, aerial, lake) from the pristine `be65a9c`
worktree and from the 9.1 tree, same cameras, same renderer, and compared pixels:**

```
compare-1 (street): mean |luma diff| 0.00/255   max 10.7
compare-2 (aerial): mean |luma diff| 0.07/255   max  7.7
compare-3 (lake):   mean |luma diff| 0.15/255   max 11.3
```

That is essentially no change — and the reason matters:

> **The offline renderer cannot see any of this work.** It shades with a
> hardcoded term at `scripts/offlineRender.mjs:662`:
> `const light = 0.30 + skyUp * 0.34 + lambert * 0.85;`
> It never reads `hemiLight` or `dirLight`, and it has no shadow pass at all.

So the near-zero diff is a **limitation of my measuring tool**, not evidence that
the change is subtle or broken. The only part of 9.1 the offline renderer *can*
show is the asphalt vertex colour, and there it registers as a small, genuinely
subtle shift (max 11.3/255 on road pixels).

**Therefore: the lighting, shadow and fog work is NOT visually verified.** I will
not claim otherwise.

**What I did not test at all:** movement, jumping, shooting, building, weapon
switching. There is no browser here. The automated suite covers much of that
surface (weapons/reload/damage in 3.3, rig animation and remote LOD in 4.1,
match modes in 5.0, collision and routes in the 3.x fingerprints) and all 205
pass — but that is not the same as playing it.

---

## 4. Verify it yourself — live preview is running

Open the preview panel. **The dev server is already serving 9.1** (confirmed:
`VisualAtmosphere.ts` over the wire contains `getShadowRigForQuality` and
`getFogDensityForQuality`).

⚠️ **Two URLs matter, because roads default OFF in the browser** (left over from
the recovery PR — `ROADS_DEFAULT_IN_BROWSER = false`):

| URL | What you see |
| --- | --- |
| `/` | 9.1 lighting, shadows, fog — **no roads at all** |
| `/?roads=1` | the same, **plus** the 9.0 roads with the new asphalt wear |
| `/?roads=1&diag=1` | as above with the 8.7 renderer diagnostics |

If you look at `/` and wonder where the asphalt improvement is: it is behind
`?roads=1`. That is a real usability problem inherited from the recovery step and
worth revisiting after 9.1 — I have not changed it, because flipping the default
is a gameplay-visible decision that is yours, not a visual tweak.

### What to look at

1. **Shadows** — are they longer and clearly directional now? Any acne, peter-panning or flicker?
2. **No white-out** — terrain and sky should not bloom out, roofs should keep detail.
3. **Distant buildings** — still readable through the fog, not swallowed.
4. **Roads at `?roads=1`** — asphalt patch variation visible but not blotchy.
5. **Console** — no new shader errors.
6. **Movement/jump/shoot/build/weapon switch** — the five things I could not test.
7. Switch quality tier in settings if exposed — shadow sharpness should change and nothing should error.

---

## 5. Limitations, stated plainly

1. **No WebGL in this environment.** No in-browser verification was performed by
   me at all — not before the change, not after.
2. **The offline renderer is blind to the light rig** (§3). Lighting, shadow and
   fog changes are unverified and rest on the numeric checks plus review.
3. **The asphalt change is subtle** — max 11.3/255 on road pixels offline. If you
   want a clearly visible improvement I can push the patch layer harder, but that
   risks the "avoid excessive" line in the brief, so I left it restrained.
4. **Shadow quality and performance cannot be assessed offline.** The 1024→2048
   map sizes are a reasoned trade, not a measured one. Worth watching on an
   Android phone before keeping.
5. **Compared against `be65a9c`, not the 5.1 sandbox.** Correct for isolating the
   9.1 delta, but it means I have not compared 9.1 against the red/yellow 5.1
   world — they are different content, as the earlier renders showed.
6. **Workspace note:** my local `.git` was re-provisioned between turns and lost
   the local `ci-craft-last-known-good` branch and `ci-craft-sandbox-verified-5.1`
   tag. **Nothing was lost** — both were verified still intact on GitHub and I
   restored them locally (`201fee75`, tag `adec15ce`). This is the concrete
   argument for having pushed them.

---

## 6. If you want a regression reverted

Everything is one commit. To drop only the visual changes and keep everything else:

```bash
git revert 3b6262c        # reverts the polish, keeps the patch file commit
```

Or start clean and apply only if wanted:

```bash
git checkout -b feature/9-1 be65a9c
git apply patches/ci-craft-9.1-visual-polish.patch
```

`ci-craft-last-known-good` and its tag are untouched at `201fee75`.

---

## 7. Status

- Not merged. Not deployed. No Render settings or production data touched.
- `main` unchanged at `be65a9c`.
- Session branch `arena/54690527-cinite` pushed: `3b6262c`, `3245a18`.
- Stopped after testing and reporting, as instructed.
