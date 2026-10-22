# CI CRAFT — Lobby text chat

Date: 2026-10-22

> Historical report for the original implementation, merged in PR #7. The subsequent [in-game visibility fix](TEXT_CHAT_VISIBILITY_FIX.md) supersedes the Solo/disconnected visibility and positioning behavior described below. The control now remains visible during actual gameplay; only sending requires acknowledged multiplayer membership. See that report for the latest compiled-game verification and remaining live-server checks.

Branch: `arena/a41a3d63-cinite` · Existing PR: [#7](https://github.com/daniel1996lowtec/-CINITE/pull/7)

Baseline: completed CI Craft 3.6, `2df3eb05ea1173a2aaa6dd76871b6920fa8d6c80`.

## Scope and use

**Text only.** No voice chat, WebRTC, microphone access, audio notifications, audio changes, or voice-related dependencies. No new runtime or development package dependency was added to the repository.

A compact **CHAT** toggle appears in the upper-left information area after the server acknowledges membership in a multiplayer lobby. It works in the lobby and during its match, and is hidden in Solo or while disconnected.

- Click/tap **CHAT** to expand or collapse it; a closed panel shows an unread count, capped visually at `99+`.
- Each entry displays the server-owned player name and message.
- Focus the message field and press **Enter**, or click/tap **Send**. Enter outside that field does not send. IME composition and held/repeating Enter do not send accidentally.
- During gameplay, **T** opens and focuses chat. This is an unused gameplay key, not a replacement for any existing action. **Escape** in chat closes it without also opening the pause menu. Closing returns keyboard movement without requiring an extra canvas click. Clicking the game canvas resumes the existing desktop pointer-lock behavior.
- Opening the panel by touch does not automatically raise the software keyboard; explicitly tapping the input does. The input opts into the existing `data-allow-game-keyboard` exemption.
- Typing clears held movement/fire/aim/one-shot input, exits pointer lock, and prevents typing or scrolling chat from moving, building, switching weapons, or firing. Existing gameplay controls continue to work outside text entry.
- The log scrolls and retains at most **100 messages per connection**. Messages and drafts are cleared on disconnect, leave, room change or reconnect. There is **no persistent history**, offline queue or automatic resend.

## Server and protocol

Chat uses the **existing lobby WebSocket**, not a separate connection, service or room system.

Client request:

```json
{"type":"chat_send","roomCode":"CURRENT-LOBBY","text":"Meet at the tower"}
```

The server verifies the current socket's joined room, live player membership, socket ownership and non-bot identity. Closed rooms, unjoined connections and mismatched room codes cannot send. Clients cannot choose another recipient lobby or forge the sender, message ID or timestamp.

Accepted messages are broadcast only through that room's existing connected-player list, including the sender. The authoritative packet contains `type: chat_message`, `roomCode`, a server-generated UUID, `senderId`, `senderName`, normalized `text`, and `sentAt`. No account/session credentials are broadcast.

### Validation and escaping

- String only, **1–240 UTF-16 code units**, matching HTML `maxlength` and JavaScript length checks.
- Trimmed and NFC-normalized. Empty/whitespace-only input, oversized input, non-string types, line/control characters and specified bidi-spoofing characters are rejected. Normal Unicode and emoji/ZWJ remain supported.
- Messages remain **plain-text JSON on the wire**. Both message and sender name are inserted using DOM **`textContent`**, never `innerHTML`, HTML templates or linkification. This is context-safe HTML escaping at the rendering boundary: literal `<img ...>` displays as text and cannot execute. Wire text is not entity-encoded and then double-escaped.
- Rejections use bounded fixed reason codes: `not_in_lobby`, `invalid_text`, `rate_limited`.

### Rate limiting

A server-side sliding window allows **five chat attempts per ten seconds per verified account**, across lobbies and reconnects. Invalid text attempts also consume quota. Legacy guest rooms use their existing session identity; this is not stronger authentication than those rooms already provide.

The limiter is independent of the existing general socket limit and is capped at **4,096 identities**. Expired entries are reclaimed on demand; a full live limiter fails closed instead of evicting active quotas. It keeps only identity/timestamp metadata, not chat text or sockets. There are no added interval timers. Keeping the short-lived quota across disconnects prevents bypass by reconnecting or replacing a seat.

## Client lifetime and layout

`RoomTextChat` is a small typed channel on `NetworkManager`:

- It becomes available only after `room_joined`, not merely after WebSocket open.
- It rejects messages for other rooms and malformed packets and uses a bounded 100-ID duplicate filter.
- Old socket callbacks are detached on close/replacement/leave, and callbacks also check socket identity to ignore stale events. Automatic reconnect behavior otherwise remains unchanged.
- The mounted UI has one channel subscription, not an additional subscription on every reconnect. Reset clears room-specific state; `destroy()` unsubscribes and removes DOM/window/visual-viewport listeners once. A persisted browser page is not destroyed merely because it enters the back/forward cache.
- No optimistic local message is shown; only the server echo becomes a log entry.

The panel is positioned around the existing minimap, storm status, compass, counters, reticle and controls. Its desktop height is bounded; narrow mobile layouts place it below the compact compass row. It uses the existing safe-area variables and accommodates the measured visual-viewport height. Message input and buttons have at least 44-pixel targets. Long text wraps inside the bounded scrolling log.

Layout tests initially caught compact-compass, reticle and narrow-desktop counter overlaps. These were fixed by changing **only the new chat panel's** placement/width/height, not moving the existing HUD or weakening checks. Small layouts intentionally show fewer log lines; users scroll to read older messages.

## Preservation

Phase 1 through 3.6, including the four-human multiplayer flow, authoritative inventory/combat/loot, lobby discovery, account/database APIs, bot gates, Tower/bridges, world branding, mobile controls and existing audio remain intact.

No authentication rules, database schema, production environment, Render settings, map geometry, weapon balance, storm timing, avatar assets or production data were changed. The existing world regression remains **822 meshes / 299,506 instance-inclusive triangles / 1,414 colliders**. Original budgets are unchanged.

## Actual validation

Final checks used **Node 22.14.0**. Browser tests used the isolated local server and `/tmp/cinite-chat-local.sqlite`, not production.

| Check | Result |
|---|---|
| Strict `npm run typecheck` | PASS |
| `npm run loot:check` | PASS, existing registry unchanged |
| `npm run build` | PASS; existing >500 kB bundle warning remains |
| Full `npm test` | **98/98 PASS**, zero skips, **65.471 seconds** |
| Focused `npm run test:chat` | **11/11 PASS**, including nested integration cases |
| New `npm run test:chat:browser` | **96 mobile layout cases + 2 desktop layouts PASS**, actual main-handler input checks, zero captured page errors |
| Existing `npm run test:mobile-hud:browser` | **66 layout cases PASS**, input/cancellation/cleanup and real-HUD checks; desktop remains identical to the harness's 3.4 reference |
| Existing `npm run test:game:browser` | PASS: actual built local Solo startup on Low, 844×390, phase HUD, health 100/100, five slots, BUILD/BACK, reduced motion, zero captured page/shader errors |
| Local HTTP smoke | Root, health, lobby directory, final JS and CSS all **200** |
| Whitespace and changed-script syntax checks | PASS |

### New test coverage

`tests/textChat.test.mjs` tests validation/Unicode/limits, sliding-window refill and bounded limiter behavior, room filtering/deduplication/unsubscription, and the **actual transpiled NetworkManager** with controlled sockets. It verifies join-ACK gating, removed handlers, stale callback rejection, no message replay, reconnect-timer cancellation and explicit leave.

`tests/textChat.integration.test.mjs` boots the **production server** with temporary SQLite and real authenticated WebSocket clients. Six subcases cover:

1. Identical, once-only delivery to four players with server-derived identity and literal markup/Unicode; no delivery to unjoined or other-lobby sockets.
2. Unjoined-send rejection, forged destination rejection and bidirectional lobby isolation.
3. Invalid types, empty text, control characters, excessive length and invalid-attempt quota consumption.
4. Sixth-message rejection and quota survival after removal/reconnection of a pre-match seat; no history replay or delivery to the old socket.
5. Account socket replacement and explicit leave; old/disconnected seats cannot receive subsequent chat or send as a member.
6. A **real server-started four-human match**, zero bots, with chat delivered to all four during active play and still isolated from other connections.

`scripts/textChat.browser.mjs` loads the actual application/main handlers and UI. Only animation scheduling and chat sending are controlled in this harness; real server delivery is covered by the integration test above. Checks include:

- Focused Enter, outside Enter, Send click, IME composition, T, Escape and movement resumption.
- No leaked movement/fire/build/reload/weapon-wheel actions while typing/scrolling.
- Safe sender/message text nodes, unread clearing, 100-row cap, reconnect resets and once-only disposal.
- Eight mobile sizes/safe-area configurations × three existing scale settings × chat open/closed × BUILD open/closed: **96 cases**. The panel does not intersect the minimap, storm/compass/counters, reticle, health, joystick, action buttons or hotbar. Input/button targets stay at least 44 pixels.
- Fine-pointer desktop **1440×900 and 800×600**, plus a short visual-viewport emulation with reachable input/Send.

### Build output

- HTML: **58.90 kB**, 13.10 kB gzip.
- CSS: **72.81 kB**, 15.40 kB gzip (`index-BUeXer8E.css`).
- JS: **1,093.85 kB**, 291.19 kB gzip (`index-BpQtOfYl.js`).

These are build-size measurements, not an FPS or mobile-performance claim.

## Files

- `server/textChat.mjs` — validation and bounded server quota.
- `server/multiplayerServer.mjs` — authorized room-local chat dispatch.
- `src/network/RoomTextChat.ts` — typed ephemeral channel and bounded duplicate filter.
- `src/network/NetworkManager.ts` — current-socket integration, ACK gating, send and cleanup.
- `src/ui/TextChat.ts` — safe bounded DOM, input handling, unread state, viewport/listener lifetime.
- `src/main.ts` — UI wiring and gameplay/text-entry separation.
- `index.html`, `src/styles/main.css` — accessible compact panel and responsive layout.
- `tests/textChat.test.mjs`, `tests/textChat.integration.test.mjs` — unit/network/server coverage.
- `scripts/textChat.browser.mjs` — optional browser checks.
- `package.json` — test commands only; no dependency changes.
- `docs/TEXT_CHAT.md` — this report.

## Reproduce / limits

```sh
npm run typecheck
npm run loot:check
npm run build
npm test
npm run test:chat

# Optional external browser QA setup, as used by existing HUD checks:
# Vite on 5173 and isolated local multiplayer server on 2567.
MOBILE_QA_MODULES=/path/to/qa/node_modules npm run test:chat:browser
```

The sandbox used `/home/user/browserqa/node_modules` and `LD_LIBRARY_PATH=/tmp/chromium-libs/lib` for browser-only tooling. These packages/libraries are not game dependencies or committed assets.

Browser evidence is headless Chromium/software WebGL and emulated viewports. **No physical phone, Safari, actual OS keyboard, WAN latency, production deployment, or rendered four-player browser playthrough is claimed.** The four-human chat test uses real server sockets; the UI and actual Low startup are separate browser checks. There is no durable chat history, moderation dashboard, blocking/reporting system, or voice capability in this increment.

Delivery remains on the existing feature branch and PR #7. **No merge, force push, replacement PR or automatic deployment.**
