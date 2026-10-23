# CI CRAFT 7.2 — Precision Shooting, Hit Registration & Server-Authoritative Combat

Base `d35c6cb` (7.0) · Branch `arena/ce7751ae-cinite` · PR #15

---

## 1. The bug, measured

Before touching anything I reconstructed the exact geometry the 6.2/7.0 build used and
measured how far a shot lands from the crosshair when an enemy is perfectly centred.

The camera sits **1.05 m to the right** of the operator and **4.4 m behind**, then looks
at a point 32 m along the yaw/pitch axis. The rendered view direction is therefore
**1.65° off** the yaw/pitch axis — but `getAimRay()` fired the bullet along the raw axis,
from a different origin (the shoulder, not the muzzle).

| Target range | Hip fire — old miss | ADS — old miss |
|---|---|---|
| 5 m | **0.99 m** | 0.73 m |
| 10 m | **0.86 m** | 0.62 m |
| 20 m | **0.62 m** | 0.40 m |
| 40 m | **0.41 m** | 0.25 m |
| 80 m | **1.32 m** | 1.11 m |

Torso hitbox radius: **0.34 m**. So on a perfectly centred target the old system missed
by roughly **2× to 4× the width of the body**, at every range. That is the report.

Four independent causes, all fixed:

1. **Wrong ray origin.** The bullet left the shoulder; the crosshair is the camera.
2. **Wrong ray direction.** The bullet used yaw/pitch; the crosshair uses the shoulder-
   offset view direction. The two diverge by 1.65° and never converge.
3. **Lagging crosshair.** The look-at was low-pass filtered at `dt * 26` (~100 ms), so
   during a flick the reticle pointed where the camera *had* been while the shot used
   the *current* yaw.
4. **Breath sway asymmetry.** Sway was applied to the camera but not to the aim ray.

Two further defects found during the audit:

5. **Hitbox wider than the character.** One 0.54 m cylinder (1.08 m across) for a 0.64 m
   torso — this is the "impossible hits" direction of the same bug.
6. **No shot/target binding on the server.** `combat_hit` was validated only by "the
   reported point is within 2.4 m of the victim and there is line of sight from the
   attacker's chest". Third-person cameras see over cover the chest cannot, so honest
   shots from behind low cover were rejected while a forged hit on anyone in the open
   was accepted.

---

## 2. The fix: one aim solve, used by both the reticle and the bullet

New `src/weapons/AimSolver.ts` — pure math, no Three.js, no allocations, fully testable.

```
camera ray  = origin: camera.position, direction: camera.getWorldDirection()
              (read back from the rendered camera, so smoothing/shake/FOV are included)
     |
     v
aim point   = nearest of {enemy hitbox, world geometry, terrain} along that ray,
              never past a wall
     |
     v
fire ray    = origin: muzzle, direction: normalize(aimPoint - muzzle)
```

* The bullet **converges on the aim point** instead of running parallel to the view.
* `getCameraRay()` reads the camera transform rather than recomputing yaw/pitch. Any
  future smoothing, shake or FOV change is automatically part of the aim instead of
  silently diverging from it.
* The look-at now **snaps** to the aim target; only the camera *position* is smoothed.
  The reticle is exact at all times.
* `muzzleObstructed` and `predictedTargetId` are reported separately from
  `crosshairTargetId`, so the game can distinguish "you are on him" from "you can
  actually hit him".

Terrain is now part of the aim solve (`castTerrain`: a bounded march with linear
refinement against the heightfield). Previously `raycastWorld` ignored the ground
entirely, so aiming downhill returned "nothing" and the shot flew out along the view
axis.

**Spread** is now a real cone: `spreadDirection()` samples a uniform disc
(`sqrt(radius01)`) in an orthonormal basis around the fire direction. The old code added
independent random offsets to `x`, `y` and `z`, which is a **cube, not a cone**, and it
rotated its bias with the world axes — the same weapon was measurably tighter facing
north than facing east. Magnitudes are unchanged; only the shape and the centre are.

**Fire cadence**: the cooldown now carries its sub-frame overshoot
(`max(-interval, rawCd) + interval`) instead of resetting. At 30 fps a 13 rounds/s SMG
was actually firing ~10/s and the missing shots were invisible.

---

## 3. Hitboxes

New `shared/hitbox.mjs` — imported by **both** the client and the server, so the two can
never disagree about what a body is.

| Part | Y range | Radius | Headshot |
|---|---|---|---|
| legs | 0.00 – 0.88 | 0.26 | no |
| torso | 0.88 – 1.50 | 0.34 | no |
| head | 1.50 – 1.95 | 0.19 | yes |

Measured from the real `CharacterMesh`, not guessed: head group spans y 1.49–1.95 at a
0.17–0.20 radius, torso y 0.88–1.50 at x ±0.32, pelvis y 0.71–0.93.

* **No gaps by construction** — each part's `maxY` is the next part's `minY`. A test
  sweeps a horizontal ray up the body every 2 cm and asserts that something is hit.
* **No oversized volumes** — every radius is asserted below 0.4 m, and a ray 0.45 m off
  the torso axis is asserted to be a miss.
* **No self-hits** — the shooter is excluded by id in the shared cast.
* **Walls block** — world geometry is evaluated first and clamps the character test
  range, so a body behind a wall cannot be hit.
* Hitboxes are evaluated against the client's *interpolated render position*, which is
  exactly where the visible mesh is drawn.

There is no crouch system, so the three-part standing volume covers every pose.
Jumping/falling/gliding translate `position.y`, which is the feet — the hitbox follows.

---

## 4. Server authority

The server still owns damage and elimination. What changed is that it now **re-decides
the hit from geometry**, using the ray the client actually fired.

### 4.1 Shot ↔ hit binding

`fire_weapon` now carries `aim: { origin, direction, aimPoint }`. The server:

* sanitises the origin (must be a plausible muzzle: within 4 m horizontally of the body,
  0.3–3.4 m above the feet — wide enough for movement prediction under latency, 100×
  smaller than the map),
* normalises and validates the direction,
* stores it as `lastValidatedShot`, bound to the weapon category/rarity, with a 900 ms
  expiry.

On `combat_hit` the server **re-shoots that ray against the victim's hitbox**. If the ray
does not intersect the body, the hit is discarded — no matter what the client claims.

### 4.2 Bounded lag compensation

`server/hitValidation.mjs` keeps a 16-sample position ring per player (900 ms TTL,
stationary samples coalesced). A hit is accepted if the ray intersects the body at the
current position **or at any sample inside a 200 ms window**.

Without this, a shot at what the client could see is validated against where the server
thinks the victim is *now* — which is the other half of "my crosshair was on him". The
window is deliberately small and bounded.

### 4.3 What else is validated (unchanged rules, now correctly ordered)

* Hit credit must be backed by a shot that actually consumed ammo.
* Range from the catalogued weapon stats (+4 m allowance for origin/positions).
* Line of sight is evaluated **from the real muzzle**, not from the chest — this fixes
  the false rejections behind low cover.
* Self-hits, teammates (TDM/duo), inactive matches, non-participants: rejected as before.
* `hitId` dedup and a monotonic `shotSeq` reject duplicate/replayed shots.
* Headshots are derived from the **server's** hitbox part, not the client's flag.
* Damage always comes from the server catalogue.

### 4.4 Spread allowance

Multi-pellet weapons scatter, so validating every pellet against the single centre ray
would reject honest shotgun hits. The tolerance is
`SERVER_HIT_TOLERANCE (0.10 m) + tan(spreadRad) × distance`, using the **server's** own
spread value — a client cannot inflate it, and at worst a cheater can pick the best angle
inside the cone the weapon already has. 0.10 m is roughly one animation frame of limb
movement: enough for sync jitter, not enough to register on empty air.

---

## 5. Feedback

* The **hitmarker and damage numbers remain server-confirmed only** (`onServerHitEvent`);
  the local prediction path still returns early in online rooms.
* New: when the muzzle ray is blocked while the crosshair is on an enemy, the reticle
  turns **red** for 400 ms. Firing into cover no longer looks like a guaranteed hit. It
  costs one DOM class toggle, and only when the state changes.
* `?aimdebug=1` enables a **development overlay** (`src/debug/AimDiagnostics.ts`) that
  draws the camera aim ray, aim point, muzzle, real firing direction, predicted hitbox
  intersection and the server's verdict. It is never created unless the flag is present;
  there is no always-on debug chrome in the HUD.

---

## 6. Mobile and desktop

Both feed the same `tpCamera.yaw/pitch`; the shot ray is read back from the rendered
camera, so **no screen-space or device-pixel-ratio math is involved anywhere in the aim
path**. Resizing the window, changing DPR or a HUD layout change cannot move the aim.

* **Desktop**: pointer-lock mouse-look → yaw/pitch → camera → crosshair ray. Exact by
  construction.
* **Mobile**: the look surface captures its own pointer id and excludes the joystick
  pointer; the FIRE button is a separate element with its own pointer capture, so holding
  fire cannot be interpreted as a look drag.
* Landscape layout, HUD scaling and safe-area handling are untouched.

---

## 7. Test results

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **clean (exit 0)** |
| `npm test` | **162 / 162 pass, 0 fail** (was 146) |
| `npm run build` | **exit 0** — 1,223.60 kB / 332.01 kB gzip |

The 16 new tests live in `tests/aiming72.test.mjs` (15) and
`tests/aiming72.integration.test.mjs` (1) and are registered in `npm test`.

### Automated — real modules, no mocks

| Scenario | Covered by |
|---|---|
| Crosshair centred on a stationary enemy, 7–90 m | `a centred target is hit at every range` |
| The legacy rig is *proven* to miss (regression baseline) | same test, asserts >0.34 m |
| Aim converges with distance (not parallel fire) | `aim converges with distance` |
| Camera ray == rendered view direction | `camera ray is the ray through the centre of the screen` (real `ThirdPersonCamera`) |
| Shooter moving / different yaw | camera test runs 4 yaw/pitch combinations |
| Wall blocks the shot | `cover stops the shot…` |
| Crosshair on target but muzzle blocked | `low cover: the crosshair sees the enemy but the muzzle is blocked` |
| Hitbox continuity, alignment, no impossible hits | `hitboxes are contiguous…`, `a shot through the body always finds a part` |
| Self-hit prevention, nearest body wins | `a shooter can never hit themselves…` |
| Different weapon types (spread cone) | `spread is a real cone…` (shotgun 0.066 rad) |
| Server rejects a ray that misses the body | `the server rejects a reported hit whose ray misses the body` |
| Lag compensation on a moving target | `lag compensation finds a moving target…` |
| Bounded window, bounded history | same + `position history is bounded…` |
| Forged firing origin rejected | `a client cannot invent a firing origin…` |
| Server tolerance absorbs jitter, not bad aim | `the server tolerance absorbs sync error…` |

### Automated — real server, two WebSocket clients

`tests/aiming72.integration.test.mjs` boots the **production server**, creates a room,
joins two clients, equips a real weapon, and runs the real protocol:

1. honest `fire_weapon` + `combat_hit` → **confirmed**, server applies its own damage;
2. forged ray pointing 6 m off the target → **no `server_hit`**, despite a valid claim;
3. an immediate second honest shot → **confirmed**, proving (2) was rejected by geometry
   and not by exhausted credit or an empty magazine;
4. replayed `hitId` → **ignored**;
5. `combat_hit` with no preceding shot → **ignored**.

### NOT tested — read this before signing off

* **No browser and no GPU in this environment.** Nothing here proves the game *renders*
  correctly; it proves the maths and the server logic are right.
* **No two human players on two machines.** The integration test is two Node WebSocket
  clients against the real server — the same code path, but no real latency, packet loss,
  jitter or interpolation.
* **Mobile touch aiming was not exercised on a device.** Verified by code inspection
  only (separate pointer captures for look/fire, no screen-space math in the aim path).

### Manual verification checklist

```bash
npm ci && npm run dev        # open the printed URL
# add ?aimdebug=1 to the URL to see the aim overlay
```

1. Stand 5 m from a wall with an enemy 20 m beyond it. Crosshair on the enemy's chest →
   the reticle must be **red** and the shot must hit the wall.
2. Repeat from behind waist-high cover: reticle red, no damage — but stepping left so the
   muzzle clears the wall must connect.
3. Fire at an enemy at 5 / 20 / 80 m. The tracer must end where the crosshair was.
4. Hold fire on a sprinting target: the server must confirm hits while it moves, without
   having to lead it.
5. On a phone (landscape): rotate the camera with the look surface while holding FIRE.
   The aim must not drift and the FIRE press must not rotate the view.
6. With `?aimdebug=1`, check that the yellow muzzle line ends exactly on the green aim
   circle, and that the cyan hitbox X appears only when the shot should connect.

---

## 8. Remaining limitations

* **`combat_hit` still exists as a protocol message.** The server now decides the hit from
  its own raycast, but the *existence* of the message is client-driven: a client cannot
  deal damage it cannot geometrically justify, but it can stay silent. Moving damage
  application entirely into `fire_weapon` would remove the last client influence; I did
  not do it because it would change the room's message flow and the existing integration
  contracts, which is a larger change than this pass should carry unverified.
* **Legacy clients that omit `aim`** fall back to the previous proximity validation. The
  shipping web client always sends it; this path exists only for protocol compatibility.
* **No RTT estimate.** Lag compensation uses a fixed 200 ms window rather than a measured
  per-player latency, because the client does not currently run a ping loop (the server
  already answers `ping`). A measured window would be tighter and is the obvious next step.
* **Respawned players keep up to 900 ms of history.** The 200 ms compensation window
  bounds the effect, but a player who respawns close to where they died could in principle
  be hit at the old spot for up to 200 ms.
* **No head/limb damage multipliers.** Parts are distinguished for headshots only, matching
  the existing balance; no damage values were changed.
* **Camera behaviour changed**: the look-at no longer lags. This is an aiming improvement
  but it is a *feel* change and should be sanity-checked by a human.
