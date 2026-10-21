# CI Craft 3.1 — character presentation evolution

## Base and scope

Built on PR #7 head `081cf8ac71c508334730aa81c688458d3e8e2d17`.
The resumed working files were byte-for-byte compared with that head before
reconciling local Git history. No previously delivered changes were discarded
or recommitted. Arena fixes this session to `arena/a41a3d63-cinite`, so this
increment updates the existing PR rather than creating an unrelated branch.
No merge or deployment is included.

The patch changes presentation, UI, tests and documentation only. Weapon stats,
fire cadence, hitscan, server damage validation, movement, hitboxes, storm,
buildings, database, account/API contracts and input handlers are unchanged.

## Implemented

- Validate required rig/clip names before publishing a shared GLB. Keep the
  procedural fallback on failed/incompatible assets, suppress per-player retry
  storms, clear pending instances, and never upgrade a disposed character.
- Actually evaluate derived Sprint and authored Jump/Fall/Land/Ready/Aim/Shoot/
  Reload/Switch actions. Airborne rotations are additive; upper-body clips are
  blended. Reload and one-shot sampling follow synchronized countdowns/events.
- Restore unmodified bone poses before each mixer evaluation so procedural
  overlays cannot accumulate on trackless bones. Local landing detection no
  longer writes to the gameplay snapshot. Smaller presentation-only landing dip.
- Continuous magazine drop/insert boundary and smooth lower/raise switch curve.
  Cylinder and drum component motions differ from ordinary box magazines;
  existing tube/pump/bolt/slide components and all nine firearm stats remain.
- Support-hand two-bone IK near the camera, cached weapon component nodes, and
  muzzle anchor conversion that accounts for nested model transforms. Recoil,
  weapon orientation and right-hand position remain procedural, not a full
  calibrated two-hand animation set.
- Six existing named outfits retain their silhouettes and finishes. Helmet,
  torso, shoulder and waist rigid attachments now follow their associated
  bones, independent of back-accessory choice. No claim of skinned armor.
- Brief elimination shrink only after `alive=false`, with pose-scale reset if
  gameplay later reports alive. No ragdoll or new respawn gameplay.
- Time-budgeted distant animation (30/15/10 Hz rather than frame-count division),
  shorter detail/IK ranges and omitted optional bump mapping at low quality.
  GPU cleanup deduplicates owned buffers/materials, uncaches mixer bindings and
  disposes per-instance skeleton textures without touching shared weapon/GLB
  geometry or shared maps. No additional asset downloads.
- Lobby displays real asset-loading/fallback status, selected weapon rarity and
  cosmetic-only rarity styling. Outfit selection exposes `aria-pressed`.
  Existing server-derived squad status/rosters and controls are preserved.

## Validation and limitations

Automated tests now parse the actual bundled skeleton, geometry, inverse-bind
matrices and tracks with **only image/material texture references removed** for
Node. They evaluate clip weights and sampled times, standing bounds, cloned
skeleton independence, shared geometry, muzzle alignment, bone-following
attachments, state immutability, elimination/reset, failed requests, late-load
cancellation, and resource disposal. This is not WebGL or pixel-level validation.

Validation on 2026-10-22:
- `npm run typecheck`: passed; `npm run build`: passed.
- `npm test`: **52/52 passed**, including all existing integration suites.
- Local production-style server on port 4176 with temporary SQLite: HTTP 200
  for `/health`, `/api/lobbies`, `/`, `/models/soldier.glb` and hashed JS.
- JS bundle: 1,051.72 kB / 277.97 kB gzip; existing >500 kB warning remains.
- `git diff --check`: passed.
The configured Node version remains exactly 22.14.0; the sandbox's installed
Node is 22.22.3. No production or physical Android/iOS tests were performed.

This is an incremental rig/animation improvement, **not a finished AAA art pack**.
No new professional mocap, bespoke skinned outfits, texture LOD downloads,
compressed texture pipeline, ragdolls or production performance measurements.
Image decoding, shading, clipping, hand fit across all poses and device frame
rates still require browser/WebGL and physical-device QA before release.

See `public/models/ASSET_PROVENANCE.md`: the existing GLB exactly matches the
three.js Mixamo example, but its original licence/acquisition record is absent.
That remains a rights-review gate; no new licensed-asset claim is made.
