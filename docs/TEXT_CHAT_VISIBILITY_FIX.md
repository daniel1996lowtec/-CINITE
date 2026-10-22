# Fix: missing in-game text chat

Date: 2026-10-22

Feature branch: `arena/f832adc9-cinite`, based on merged PR #7 (`c1507ee`).

## Confirmed cause and complete UI trace

The component was mounted in the real application, but **visibility was incorrectly coupled to successful lobby membership**:

1. `index.html` contains the chat section beside the actual game HUD. It starts with `hidden`.
2. `src/main.ts` constructs the real `GameEngine`, then constructs `TextChat` with `engine.network.textChat` and `engine.network.sendChat`. There is no separate playable chat scene.
3. `RoomTextChat.subscribe()` immediately emits its initial state with `roomCode: null`.
4. Previously `TextChat.receive(state)` assigned `root.hidden = !event.roomCode`. Therefore the entire control—not just sending—disappeared without an acknowledged room.
5. Solo initializes `NetworkManager.isOnlineRoom = false` and disconnects multiplayer. It never receives `room_joined`, so chat stayed hidden even after `GameEngine` displayed `#hud-overlay`.
6. A connection close/reset similarly cleared the room and hid the control during reconnect. There was no subscription to the independent gameplay/HUD visibility transition.
7. In a joined multiplayer lobby, the real `room_joined` packet enables the existing channel. Sending uses `NetworkManager.sendChat()` → the existing room WebSocket → the server's `chat_send` handler → the joined room's recipients → `chat_message` → `RoomTextChat.receive()` → safe DOM name/message text nodes.
8. The previous DOM chat harness manually called `textChat.joined('QA-LOBBY')`. Its successful connected tests bypassed the missing-ACK visibility case. The previous compiled-game Solo smoke tested startup/HUD but never asserted chat visibility.

This is a confirmed source/lifecycle defect, now covered by regression checks in actual compiled Solo gameplay. **The reported live screenshot's room state and deployed asset revision were not supplied or inspected.** This finding does not prove that a live screenshot taken in a successfully acknowledged multiplayer room had no additional stale-deployment or connection problem.

## Fix

- Separate **control visibility** from **permission to send**. The toggle is visible whenever the real gameplay HUD is visible, including Solo and disconnected/reconnecting play. It also remains available in an acknowledged pre-match lobby. The disconnected main menu remains uncluttered.
- Input and Send are disabled until the existing server `room_joined` acknowledgment. Opening in Solo explains: “Join a multiplayer lobby to chat. Solo has no recipients.” An unavailable online connection is explained instead of silently removing the button. No fake recipients or locally fabricated messages.
- Keep the compact toggle below the actual minimap. Desktop places it below the minimap/storm header; mobile places it below the minimap and to the right of the storm/BUILD column. The existing BUILD button and other HUD elements are not moved.
- Give CHAT a high-contrast cyan border and an inline vector speech-bubble icon, avoiding missing emoji/font glyphs. Tapping opens/closes the panel; connected play shows names, messages, input and Send. T also opens it during gameplay without requiring membership merely to discover the control.
- Observe the real HUD's class/hidden transition and header size, plus viewport changes. No frame-loop polling. Both new observers are disconnected on disposal; destroyed chat cannot remount itself after a subsequent HUD transition.
- Derive placement from actual HUD bounds and existing safe-area/scaling layout. In a very short visual viewport the panel moves upward to keep editing controls reachable; this is a keyboard-space accommodation, not a change to normal gameplay placement.
- Retain existing input isolation, Enter/IME handling, unread indicator, 100-message cap, safe `textContent` rendering, server membership validation, 240-character bound, account rate limiting and old-socket cleanup. Room-specific messages/drafts still clear on reset, but the gameplay toggle stays visible and sending becomes disabled.

**Text only:** no voice, microphone, WebRTC, audio changes or new dependencies. No weapons, inventory, four-human gates, world geometry, account/database rules or production configuration changed.

## Actual compiled-game verification — not a mocked component

Added `npm run test:chat:game` (`scripts/textChat.game.browser.mjs`). It:

1. Loads the compiled `/assets/index-*.js` app from the actual local multiplayer/static server. No request interception, injected app globals, stopped RAF, mocked sends or manual `RoomTextChat.joined()` calls.
2. Uses the real browser UI to create a human-only four-seat lobby, ready the host and start its match.
3. Joins three additional authenticated protocol peers. All four receive a real server match-start packet with four participants and zero bots.
4. Runs the rendered host at **844×390** on Low and waits for the actual gameplay HUD/countdown transition.
5. Checks the visible CHAT button below the minimap; captures the closed panel.
6. Sends an incoming message through a real peer socket, verifies the unread indicator, taps CHAT and verifies the sender name/message and enabled controls.
7. Sends from the actual browser input/Send button; all three peers receive the correct authoritative host name and text, and the host receives its server echo.
8. Uses a fifth authenticated peer in a different lobby to verify isolation in both directions, including absence on the host's received WebSocket frames—not just absence from its DOM.
9. Verifies the actual browser WebSocket URLs use the built app's same host and `/ws` path, five inventory slots remain present, and BUILD/BACK still work.

Extended `npm run test:game:browser` to exercise visible/open/closed chat in **actual compiled Solo gameplay**, without inventing a lobby ACK. Send/input must be disabled, the Solo explanation visible, and the toggle clear of BUILD.

Final captured gameplay evidence, inspected in this workspace (not generated illustrations or isolated mock scenes):

- `/home/user/chat-fix-evidence/solo-chat-open.png`
- `/home/user/chat-fix-evidence/multiplayer-chat-closed.png`
- `/home/user/chat-fix-evidence/multiplayer-chat-open.png`

The multiplayer browser test is **one rendered browser plus three real authenticated socket peers**, not four fully rendered browser clients. Screenshot files are not committed as source assets.

## Production connection audit

No separate chat URL or connection is introduced. `sendChat()` uses the existing `NetworkManager.ws`, gated by the current room ACK and socket readiness.

Existing `resolveWebSocketUrl()` supports:

- HTTPS same-origin app → `wss://<current-host>/ws`.
- Local HTTP app → `ws://<current-host>/ws`.
- `VITE_MULTIPLAYER_SERVER_URL=https://…/` → the corresponding secure `/ws` endpoint.
- Explicit `VITE_MULTIPLAYER_WS_URL`, which takes precedence.

Added a regression against the actual transpiled NetworkManager for secure same-origin, local HTTP and both build-time overrides. The local built-game test verifies the real runtime connection, rather than just this URL function.

The existing `render.yaml` serves the built frontend and HTTP/WebSocket server together, pins Node 22.14.0 and leaves `PORT` to Render. No changes were needed. `VITE_*` values are frontend **build-time** configuration, not a runtime chat setting. With a separate frontend/server origin, the existing server `ALLOWED_ORIGINS` must permit the actual frontend origin. No production settings, origins, credentials or databases were modified.

**Still requires live testing:** the deployed asset revision/cache, actual Render HTTPS/WSS upgrade, configured origins/build-time overrides, production PostgreSQL/account connection, WAN reconnect behavior, and physical Android/iOS/Safari keyboard/touch behavior. The sandbox test used isolated local SQLite and HTTP; it is not a live Render TLS verification. No deployment was performed.

## Results

Final commands used **Node 22.14.0**.

| Check | Actual result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run loot:check` | PASS, registry unchanged |
| `npm run build` | PASS; existing >500 kB bundle warning remains |
| `npm test` | **99/99 PASS**, zero skipped, **63.691 s** |
| Focused chat unit/server tests | **12/12 PASS**, including authenticated four-human delivery, isolation, validation, rate limiting, replacement/disconnect handling and production URL resolution |
| `npm run test:chat:browser` | **96 mobile cases + 2 desktop layouts PASS**; below-minimap position, non-overlap/44px targets, no-ACK visibility, reconnect disabled state, input handling and observer/subscriber disposal |
| `npm run test:mobile-hud:browser` | **66 cases PASS**, existing input/HUD checks and desktop reference comparisons |
| `npm run test:game:browser` | PASS: actual compiled Low Solo startup and new chat visibility/open/close/disabled checks; zero captured page/shader errors |
| `npm run test:chat:game` | PASS: real compiled mobile gameplay, actual lobby ACK, four-human start, two-way browser/socket messages and cross-lobby isolation; zero captured page/shader errors |

The pre-existing mobile reference check initially lacked historical commit `e7dfd92` in this shallow checkout. Fetching history restored the reference and the unchanged check then passed. The initial real-game command outlived its 180-second tool wait and subsequently passed; it was not duplicated while running. Final real-game checks completed with a longer bounded command wait. These software-renderer timings are not FPS/startup-performance claims.

Final build: HTML **59.12 kB / 13.22 kB gzip**, CSS **72.48 / 15.40**, JS **1,095.31 / 291.63**. Assets: `index-BZ6blmGm.css`, `index-DvqY5aQu.js`. Existing world budgets and gameplay tests remain unchanged.

## Files and delivery

Changed: `index.html`, `src/main.ts`, `src/ui/TextChat.ts`, `src/styles/main.css`, `tests/textChat.test.mjs`, `scripts/textChat.browser.mjs`, `scripts/smokeGame.browser.mjs`, `package.json`. Added the real-game script `scripts/textChat.game.browser.mjs` and this report; the earlier report links to this correction.

PR **#7 is already merged**. A merged PR cannot accept this follow-up as another code update. The fix is committed/pushed on **`arena/f832adc9-cinite`**, and a follow-up comment on #7 links to the fix and validation. No replacement PR, merge, deployment, force push or production change is performed.
