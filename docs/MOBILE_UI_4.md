# CI CRAFT — Mobile UI overhaul 4.0

Date: 2026-10-22. Branch: `arena/11b914e8-cinite`.

Baseline: `8f8a5b9` (merged PR #8, including the previous chat visibility fix). PRs #7 and #8 are already merged; this work is delivered as a separate related PR. No merge, deployment, production-setting change, dependency addition or database migration is part of this change.

## Problems found in the actual application

- The narrow-screen split-menu rule removed the lobby card's maximum height, while stacking a large character/weapon dock below a long, centered menu. Content could extend past the usable viewport.
- Solo options, account/career details, tactical help and online navigation all shared the landing screen.
- The landscape recommendation appeared on portrait menus, blocking name entry and navigation. This was reproduced in the compiled app, not inferred from a screenshot.
- The name input started with a hardcoded callsign. The local progression loader discarded its saved `callsign`, and boot-time account retrieval did not synchronize the input. Offline reloads therefore lost the selected name even though the cache had stored it.
- Chat had fixed default positioning without a drag/reset mechanism. Its whole rectangular root could capture taps in empty space beside the collapsed button.
- The old scene kept drawing the full island behind menus. The new opaque landing menu does not need this hidden render work.

## Delivered UI

### Menus and viewport

The real existing DOM controls are reorganized by `MenuShell`; there is no replacement/demo lobby or second game route.

- Home: CI CRAFT title, compact editable profile, **SINGLE MODE** and **MULTIPLAYER**, with smaller Career & account / Locker / How to play / Settings actions.
- Single Mode: existing loadout, glider, AI count/difficulty and launch controls. No multiplayer lobby browser is presented as an offline feature.
- Multiplayer: existing live directory, Create Lobby, Join by Room ID, roster, player counts, status, ready/start/leave/close and all existing filters/configuration remain intact.
- Back navigation returns to the main menu. Returning from gameplay also restores the main menu. Going Back from a joined lobby does not silently abandon it; selecting Single Mode retains the existing explicit mode-switch leave behavior.
- Career, recovery/passkey management, cosmetics, help and advanced settings remain available in their own sections. Settings, Locker and help have a consistent top Back control as well as their existing bottom controls.
- Cards are bounded by the visual viewport/`100dvh`, with safe-area padding, responsive widths, internal vertical scrolling and no horizontal page overflow in the tested sizes. Visual viewport changes track keyboard/browser-bar space without making the gameplay page scrollable.
- Portrait menus do not show the rotation prompt. Gameplay retains the dismissible landscape recommendation; focused text entry is not blocked by it.
- Navy surfaces, restrained cyan accents, compact typography and touch-sized controls replace the crowded landing layout. The gameplay HUD's original geometry and saved scaling settings are retained.

### Compact, real 3D preview

The existing operator, weapon models, rotation buttons, cosmetics and weapon statistics move into Locker. The same Three.js scene and renderer draw a bounded preview window; there is no replacement character or additional rendering context. Mobile keeps the preview small and lets the dock's extra information scroll internally.

The renderer restores its full viewport for gameplay. The compiled Solo regression opens Locker first, observes the actual WebGL preview viewport, then starts the real game and checks that the WebGL viewport equals the full canvas again.

Full-island drawing is skipped behind the opaque non-game menu. Gameplay, including pause, and the live Locker preview still render normally. This is a reduction in unnecessary menu work, **not a measured physical-device FPS or battery claim**.

### Display names and identity

- New choices are trimmed and validated on client and server: **3–18 characters**, beginning with a letter or number, followed by ASCII letters/numbers/spaces/underscore/hyphen. The 18-character ceiling retains the project's previous name capacity. Unchanged legacy two-character account names remain supported.
- New browser profiles get a distinguishable editable `Pilot_…` suggestion, not a shared hardcoded identity. This random suggestion is cosmetic, never an authentication credential.
- Save name (or leaving the field) persists via the existing account endpoint. The input and default lobby title follow the verified profile. Joining/creating a lobby validates the chosen name again.
- The local progression cache now reloads callsigns. An offline pending edit is associated with its account and retried on account initialization; it is never applied to another recovered account. Storage failures fall back to the current session without crashing the name/cache code.
- Account initialization requests are serialized, avoiding overlapping initial provisioning and name saves. Existing account startup reads the server profile without overwriting it with a stale local name unless there is an explicit pending edit.
- The input is locked while joined, and reflects the server's own roster entry. Leave to rename. Linking a different account is also blocked while a lobby connection is active/pending.
- Existing unique account IDs, signed tokens, private sessions and opaque public player IDs remain the identity mechanism. Server lobby/roster names come from the verified profile, not an unverified display-name claim. Existing chat ignores forged sender names/IDs; the server associates messages with the authenticated socket's player.
- Duplicate display names are allowed, but the real roster displays a clear duplicate-name warning plus public-ID, YOU and HOST badges. Duplicate names do not merge accounts or occupy the same seat. We do not silently rename one player's persisted profile.
- Chat, roster, host labels and the existing kill-feed/results pathways continue to use the associated player name. Kill-feed/combat/results implementations and authority were not rewritten. Live multi-device kill-feed/scoreboard observation is still a manual acceptance check.

### Draggable text chat

- The existing visible CHAT toggle remains below the minimap, clear of BUILD by default, and opens/closes the existing named-message/input/Send UI.
- The header has a vector move handle and **Reset**. Drag using a mouse, touch or pen; keyboard users can focus the handle and use arrow keys. Enter activates Reset/toggle; sending still requires focused input or the Send button.
- Position is normalized to available viewport space and saved under `ci-craft-chat-position-v1`. Resize/orientation, visual viewport offsets and safe areas re-bound the panel. Content-size observation also keeps growing message content inside the viewport.
- Pointer capture is isolated to the handle, including cancel/lost capture/blur/disposal cleanup. Moving chat does not clear the independent joystick pointer. Empty space around the collapsed toggle does not intercept gameplay/menu taps.
- Storage writes occur when a drag ends or a keyboard move completes, not on every drag frame. Malformed or unavailable storage falls back safely.
- Reset clears the saved position and restores the HUD-derived default. Players choose their own placement while open and can collapse/reset it whenever they need a clear view.
- In an acknowledged pre-match lobby, chat defaults to the bottom-right. It does not follow the user into unrelated home/account/Locker screens. During Solo/disconnected gameplay the control remains discoverable, with sending disabled and an explanation.
- Existing same-lobby checks, safe text rendering, 240-character cap, rate limiting, unread count, bounded history, input isolation and reconnect/reset semantics remain. No second WebSocket or chat service is introduced.

**Text only. No voice, microphones, WebRTC, audio changes or voice dependencies.**

## Validation performed locally

Node **22.14.0**. Browser QA uses external, non-project Playwright Core **1.64.1** and Sparticuz Chromium **153.0.0**, with software WebGL. Local server uses isolated SQLite, not the production database.

| Command/check | Result |
|---|---|
| `npm run typecheck` | PASS; also repeated by production build |
| `npm run loot:check` | PASS; registry unchanged |
| `npm run build` | PASS; existing >500 kB bundle warning remains |
| `npm test` | **103/103 PASS**, zero failures/skips |
| `npm run test:ui4:browser` | **57 PASS**: seven viewport sizes × home/Solo/browse/create/account/settings/Locker/help, plus reduced-height keyboard-space emulation; actual compiled app, real name save/reload, blank-name match rejection and Back/navigation checks |
| `npm run test:chat:browser` | **96 mobile + 2 desktop cases PASS**; actual TextChat/main handlers, default layout/non-overlap, 44px targets, input/IME/Enter/Escape, saved-position reload/reset, bounded history and disposal |
| `npm run test:mobile-hud:browser` | **66 cases PASS**, including the new menu stylesheet, prior input/HUD checks and desktop comparisons |
| `npm run test:game:browser` | PASS: actual compiled Low Solo, Locker-to-game WebGL viewport restoration, five slots, chat visibility/open/close/disabled sending and BUILD/BACK |
| `npm run test:chat:game` | PASS: compiled app + real server, one rendered mobile host + three authenticated peers, four-human zero-bot start, duplicate-name warning, named browser send/receive, fifth peer's separate-lobby isolation, mouse drag/off-screen attempt clamping, portrait re-bounding, Reset and simultaneous native touch joystick + chat drag |
| Syntax / `git diff --check` | PASS |

Menu viewport sizes: **320×568, 360×640, 390×844, 568×320, 844×390, 932×430, 1280×800**. Keyboard-space emulation: **390×300**. Existing chat/HUD suites additionally cover saved scales, emulated safe insets and other landscape/desktop sizes.

Important distinctions:

- The menu, Solo and multiplayer game scripts use the **actual compiled application**, not intercepted source, fake room acknowledgments, mocked sends or a stopped animation loop.
- The broad chat/input harness does deliberately control the engine/chat state; it is not offered as proof of real server delivery. That is covered separately by the compiled multiplayer test and existing authenticated server integration tests.
- Multiplayer QA is **one rendered browser plus three real authenticated socket peers**, not four rendered devices.
- Pointer tests include native mouse events and CDP multi-touch delivery. They do not establish physical Android/iOS browser behavior.
- The initial software-renderer runs exposed menu rotation blocking and expensive hidden scene drawing. The former was fixed; the latter is now skipped for opaque menus. Browser waits also allow software-rendered screenshots/first-game frames and wait for resize observers to settle. A first multi-touch test ended the wrong CDP touch before checking the joystick; the corrected test checks both held pointers before releasing them. No gameplay input assertions were removed.
- The historical HUD reference commit was fetched into the shallow checkout; the reference checks themselves were retained. An overlong authentication-test fixture was shortened to a valid name; explicit invalid-length rejection coverage was added, not removed.

Final build: HTML **60.49 kB / 13.59 kB gzip**, CSS **82.26 / 17.31**, JS **1,105.38 / 294.33**. Assets: `index-Dv9Sjf3B.css`, `index-BYqCP6QB.js`.

### Evidence

Actual captures/logs are saved outside Git at `/home/user/ui4-evidence/`:

- `menu-390x844.png`, `menu-844x390.png`
- `locker-portrait.png`
- `solo-chat.png`
- `multiplayer-chat-closed.png`, `multiplayer-chat-open.png`
- `ui4-*-final.log`, `ui4-build.log`

These are browser/game captures, not generated mockups. The menu/Locker captures precede only the final chat-toolbar width adjustment; the final multiplayer captures include it.

## Exact files changed

| File | Purpose |
|---|---|
| `index.html` | Real home/profile/navigation markup, consistent Back buttons, compact preview window and chat toolbar |
| `package.json` | Add name tests to full suite and compiled menu browser command; no dependency changes |
| `shared/displayName.mjs` | Shared strict new-name validator |
| `shared/displayName.d.mts` | Strict TypeScript declaration for shared validator |
| `src/ui/MenuShell.ts` | Reparent existing controls, section visibility, visual viewport handling and cleanup |
| `src/styles/menu4.css` | Responsive navy/cyan menus, safe-area/internal-scroll layout, compact preview and chat toolbar |
| `src/main.ts` | Real navigation/name/account wiring, lobby name locking, Back paths and gameplay prompt refresh |
| `src/core/GameEngine.ts` | Expose initial account completion, bounded existing preview viewport and skip covered menu draws |
| `src/input/MobileLandscapeManager.ts` | Do not block portrait menus or focused text entry with rotation advice |
| `src/systems/ProgressionSystem.ts` | Load saved names, guarded local fallback/pending edit and serialized account initialization |
| `server/database.mjs` | Validate new/changed names after credential verification; retain unchanged legacy names |
| `server/multiplayerServer.mjs` | Source authenticated lobby/player names from the verified profile |
| `src/ui/LobbyBrowser.ts` | Duplicate-name warning and public-ID badges |
| `src/ui/TextChat.ts` | Pointer drag, normalized persistence, reset/re-bound, screen visibility and cleanup |
| `src/styles/main.css` | Separate chat sizing anchors from draggable position |
| `tests/displayName.test.mjs` | New-name policy, identity/token isolation, duplicates, recovery, legacy names and offline/cache failure tests |
| `tests/database.test.mjs` | Keep the other-database auth fixture within the new explicit name limit |
| `tests/lobbyBrowserUi.test.mjs` | Update the existing navigation contract to SINGLE MODE |
| `tests/mobileLandscape.test.mjs` | Add portrait-menu/focused-chat prompt regression |
| `scripts/menu4.browser.mjs` | Actual compiled menu/account/layout regression |
| `scripts/smokeGame.browser.mjs` | Navigate real Single Mode and verify preview viewport restoration before real Solo |
| `scripts/textChat.game.browser.mjs` | Actual duplicate roster, drag/bounds/orientation/reset and simultaneous touch checks |
| `scripts/textChat.browser.mjs` | Actual component saved-position reload/reset regression |
| `scripts/mobileHud.browser.mjs` | Include final menu stylesheet in existing HUD regression |
| `docs/MOBILE_UI_4.md` | This implementation, validation and mobile acceptance report |

Weapons, ammunition/inventory authority, building, storm schedule, map/loot geometry, human-only gates, account token/recovery design, database schema, environment/Render configuration and all prior game phases are retained. No dependency or asset was replaced.

## Remaining verification / limitations

- **No production deployment or live Render HTTPS/WSS handshake test.** Existing same-origin and build-time URL configuration is unchanged; runtime local `/ws` behavior and existing URL-resolution tests passed.
- No live production PostgreSQL test in this sandbox; existing database/configuration tests pass against isolated local SQLite and configuration fixtures.
- No physical Android, iOS/Safari, notch/navigation-bar or actual software-keyboard validation. Browser-size and inset simulations do not substitute for these.
- No four-rendered-phone session, WAN reconnect trial, network-impairment study, GPU/FPS benchmark or battery measurement.
- Display-name character policy is intentionally ASCII-compatible with the existing server. Unicode display names would require a separate compatibility/policy change.
- With browser storage disabled, local names/chat positions can survive only the current session unless the account is recovered. The UI must not be treated as an identity/authentication mechanism.
- Existing bundle-size warning remains; this task does not split the Three.js/game bundle.

## How to test on a real phone

1. Open this branch's **Arena HTTPS UI preview** on the phone. The preview uses relative URLs and the existing same-origin proxy to the isolated local server; do not enter `localhost` on a remote phone. No production deployment is required.
2. Alternatively, on a development machine with Node 22.14.0, run `npm ci --include=dev`, `npm run build`, then start the server on `0.0.0.0:2567` using an isolated local SQLite file (not production credentials/database). On the same Wi-Fi, open `http://<development-machine-LAN-IP>:2567`. Allow the local firewall port. HTTPS is preferable for fullscreen/orientation APIs; manual rotation must still work when those APIs are unavailable.
3. In portrait, choose/save a name. Try blank, too-short and invalid names. Reload, then open Single Mode and start. Check scrolling, keyboard dismissal, all five slots, joystick, look/ADS/fire, BUILD and inventory. Try the top Back controls in Settings, help and Locker; rotate the live preview, close it, and start a game to check camera restoration.
4. Rotate through landscape/portrait with browser address bars visible and hidden. Open the name field and chat keyboard. Confirm the field/Send and navigation stay reachable and no horizontal page scrolling appears.
5. Use **four separate accounts/browser profiles or phones** (do not share a passkey) to create/join a four-seat human-only lobby. Choose distinct names, then deliberately duplicate one before joining. Confirm roster names, YOU/HOST/public-ID badges and duplicate warning. Ready all four and start.
6. Send text both directions. Check chosen names in chat, lobby host/player cards, real kill-feed events and final scoreboard. Use another account in a separate lobby to confirm isolation. Try overlong text and more than five attempts in ten seconds; the server should reject/limit them.
7. Open CHAT, drag the move handle with a finger while holding the joystick with another finger; test ADS/fire independently. Drag toward each edge, rotate, close/reopen, reload/rejoin and use Reset. Check that Enter sends only from the focused chat field and does not trigger game actions. In Solo or after disconnect, sending must be disabled with an explanation.
8. Test background/foreground, connection loss/reconnect and leaving/rejoining. Record device, OS/browser, orientation, browser-bar/keyboard state and any failure. These device/WAN checks have **not** been claimed as completed here.
