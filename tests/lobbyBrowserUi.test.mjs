/**
 * CI Craft — Lobby Browser 3.0 UI/mobile contract tests.
 *
 * The sandbox has no browser/WebGL runtime, so these tests lock the static
 * contract that the responsive implementation relies on: primary Solo vs
 * Multiplayer navigation, the three lobby tabs, every DOM id used by the UI
 * component, touch-sized controls, card scrolling, and zero-demo-data wiring.
 * Real visual/device verification still belongs in browser QA.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');

test('main menu exposes Single Mode, Multiplayer, and the three lobby browser tabs', () => {
  const html = read('index.html');

  assert.match(html, /id="btn-mode-solo"[^>]*>[\s\S]*SINGLE MODE/);
  assert.match(html, /id="btn-mode-online"[^>]*>[\s\S]*MULTIPLAYER/);
  assert.match(html, />\s*BROWSE LOBBIES\s*</);
  assert.match(html, />\s*CREATE LOBBY\s*</);
  assert.match(html, />\s*MY LOBBY\s*</);
  assert.match(html, /HUMAN PLAYERS ONLY — NO BOTS/);
  assert.match(html, /Join by Room ID/);
  assert.match(html, /No lobbies available right now/);

  for (const removed of [
    'btn-mode-human-public',
    'btn-mode-human-private',
    'lobby-mode',
    'lobby-room-code',
    'human-lobby-panel',
    'btn-human-create-room',
    'btn-human-join-room',
  ]) {
    assert.ok(!html.includes(`id="${removed}"`), `legacy control ${removed} should be removed`);
  }

  const requiredIds = [
    'multiplayer-browser',
    'lobby-ping-label',
    'btn-refresh-lobbies',
    'btn-browser-create',
    'lobby-browser-message',
    'lobby-tab-browse',
    'lobby-tab-create',
    'lobby-tab-mine',
    'lobby-directory-status',
    'lobby-results-count',
    'lobby-search-input',
    'lobby-filter-human-only',
    'lobby-filter-visibility',
    'lobby-filter-match-type',
    'lobby-filter-format',
    'lobby-filter-slots',
    'lobby-filter-status',
    'lobby-filter-map',
    'lobby-sort-select',
    'lobby-join-code',
    'lobby-join-password',
    'btn-join-by-code',
    'lobby-card-list',
    'lobby-empty-state',
    'btn-empty-create-lobby',
    'create-lobby-name',
    'create-lobby-visibility',
    'create-lobby-fill',
    'create-lobby-max',
    'create-lobby-map',
    'create-lobby-format',
    'create-lobby-start',
    'create-lobby-human-note',
    'create-lobby-ai-note',
    'create-lobby-bot-row',
    'create-lobby-bot-count',
    'create-lobby-bot-difficulty',
    'create-lobby-password-row',
    'create-lobby-password',
    'btn-create-lobby-submit',
    'my-lobby-empty',
    'btn-my-empty-browse',
    'btn-my-empty-create',
    'my-lobby-content',
    'my-lobby-title',
    'my-lobby-status',
    'my-lobby-stats',
    'my-lobby-ready-label',
    'my-lobby-ready-fill',
    'my-lobby-code',
    'btn-copy-my-lobby-code',
    'my-lobby-invite',
    'btn-copy-my-lobby-invite',
    'my-lobby-roster',
    'btn-my-lobby-ready',
    'btn-my-lobby-start',
    'btn-my-lobby-close',
    'btn-my-lobby-leave',
    'solo-session-controls',
    'lobby-bot-count',
    'lobby-difficulty',
    'lobby-skydrop',
    'btn-launch-match',
    'preview-outfit-name',
    'preview-outfit-detail',
    'preview-showcase',
    'preview-weapon-icon',
    'preview-weapon-name',
    'preview-weapon-role',
    'preview-weapon-damage',
    'preview-weapon-rate',
    'preview-weapon-range',
    'preview-weapon-mag',
    'preview-secondary-weapon',
    'preview-squad-status',
  ];
  for (const id of requiredIds) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }

  for (const maxPlayers of ['2', '4', '8', '16', '20']) {
    assert.match(html, new RegExp(`<option value="${maxPlayers}"`));
  }
  assert.match(html, /<option value="ci_island"[^>]*>[^<]*CI Island/);
});

test('lobby UI renders only server summaries and includes every required card field', () => {
  const html = read('index.html');
  const ui = read('src/ui/LobbyBrowser.ts');
  const main = read('src/main.ts');
  const client = read('src/network/LobbyBrowserClient.ts');

  assert.match(main, /new LobbyBrowserClient\(/);
  assert.match(main, /new LobbyBrowserUI\(/);
  assert.match(main, /parseLobbyInviteCode\(/);
  assert.match(client, /lobby_list_subscribe/);
  assert.match(client, /lobby_list_updated/);
  assert.match(client, /\/api\/lobbies/);

  // No hard-coded/demo room arrays in the browser presentation layer.
  assert.doesNotMatch(ui, /demoLobbies|sampleLobbies|mockLobbies|hardcoded/i);
  assert.doesNotMatch(ui, /roomCode:\s*['"][A-Z]+-/);

  for (const fieldLabel of [
    'Room ID',
    'Host',
    'Map',
    'Format',
    'Ping',
    'PLAYERS',
    'HUMANS',
    'AI BOTS',
    'READY',
    'OPEN SLOTS',
    'JOIN LOBBY',
    'NO BOTS',
    'HOST',
    'START MATCH',
  ]) {
    assert.ok(ui.includes(fieldLabel), `LobbyBrowser should render ${fieldLabel}`);
  }
  assert.match(html, /btn-my-lobby-leave[\s\S]*LEAVE LOBBY/);
  assert.match(html, /WEAPON SHOWCASE/);
  assert.match(html, /SQUAD READINESS/);
  assert.match(ui, /my-lobby-player-avatar/);
  assert.match(ui, /syncPreviewSquadStatus/);
  assert.match(main, /syncOperatorShowcase/);
});

test('lobby browser CSS is touch-friendly, scrollable, and prevents fixed-width overflow', () => {
  const css = read('src/styles/main.css');

  assert.match(css, /\.lobby-browser-tab\s*\{[^}]*min-height:\s*48px/s);
  assert.match(css, /\.lobby-join-btn[^}]*min-height:\s*44px/s);
  assert.match(css, /\.lobby-card-list\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.lobby-card-list\s*\{[^}]*max-height:/s);
  assert.match(css, /\.lobby-room-card\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.lobby-room-meta\s*\{[^}]*minmax\(0,\s*1fr\)/s);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.lobby-browser-tab\s*\{[^}]*min-height:\s*50px/s);
  assert.match(css, /@media \(max-width: 390px\)[\s\S]*\.lobby-room-counts/s);
  assert.match(css, /\.multiplayer-browser\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.preview-showcase\s*\{[^}]*width:\s*min\(340px,\s*92vw\)/s);
  assert.match(css, /\.preview-stat-grid\s*\{[^}]*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.my-lobby-player-avatar\s*\{[^}]*width:\s*36px/s);

  const browserCss = css.slice(
    css.indexOf('MULTIPLAYER LOBBY BROWSER 3.0'),
    css.indexOf('/* Right-Side 3D Preview Stage Dock */')
  );
  assert.ok(!/^\s*width:\s*(?:[4-9]\d{2,}|\d{4,})px/m.test(browserCss),
    'browser CSS should not introduce a >399px fixed content width');
});
