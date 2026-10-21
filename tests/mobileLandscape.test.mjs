/**
 * CI Craft — professional mobile landscape tests.
 *
 * The manager is exercised with a small fake DOM for portrait prompts,
 * dismissal, fullscreen/orientation success and rejection, stale-text-field
 * blur, and gesture guarding. CSS layout is validated with the same clamp
 * formulas declared in main.css at the three requested Android landscape
 * sizes. This is deterministic contract/layout coverage, not a substitute
 * for physical Android/iOS browser QA.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');

async function loadLandscapeModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft-landscape-test-'));
  try {
    const source = read('src/input/MobileLandscapeManager.ts');
    const file = path.join(tmpDir, 'MobileLandscapeManager.mjs');
    fs.writeFileSync(file, stripTypeScriptTypes(source));
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

class FakeElement extends EventTarget {
  constructor() {
    super();
    this.classes = new Set();
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.textContent = '';
    this.disabled = false;
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !this.classes.has(name) : force;
        if (shouldAdd) this.classes.add(name);
        else this.classes.delete(name);
        return shouldAdd;
      },
      contains: (name) => this.classes.has(name),
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  click() {
    this.dispatchEvent(new Event('click'));
  }
}

class FakeRoot extends FakeElement {
  constructor(documentRef) {
    super();
    this.documentRef = documentRef;
    this.clientWidth = 390;
    this.clientHeight = 844;
    this.fullscreenRequests = [];
    this.failFullscreen = false;
  }

  async requestFullscreen(options) {
    this.fullscreenRequests.push(options);
    if (this.failFullscreen) throw new Error('fullscreen denied');
    this.documentRef.fullscreenElement = this;
  }
}

class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.activeElement = null;
    this.fullscreenElement = null;
    this.fullscreenEnabled = true;
    this.documentElement = new FakeRoot(this);
  }

  async exitFullscreen() {
    this.fullscreenElement = null;
  }
}

class FakeVisualViewport extends EventTarget {
  constructor(width, height) {
    super();
    this.width = width;
    this.height = height;
  }
}

class FakeOrientation extends EventTarget {
  constructor(win) {
    super();
    this.win = win;
    this.lockCalls = [];
    this.unlockCalls = 0;
    this.failLock = false;
  }

  async lock(orientation) {
    this.lockCalls.push(orientation);
    if (this.failLock) throw new Error('orientation denied');
    if (this.win.innerHeight > this.win.innerWidth) {
      const width = this.win.innerWidth;
      this.win.setViewport(this.win.innerHeight, width, false);
    }
  }

  unlock() {
    this.unlockCalls++;
  }
}

class FakeWindow extends EventTarget {
  constructor(width, height, coarse = true) {
    super();
    this.innerWidth = width;
    this.innerHeight = height;
    this.coarse = coarse;
    this.visualViewport = new FakeVisualViewport(width, height);
    this.screen = { orientation: new FakeOrientation(this) };
  }

  setViewport(width, height, dispatch = true) {
    this.innerWidth = width;
    this.innerHeight = height;
    this.visualViewport.width = width;
    this.visualViewport.height = height;
    if (dispatch) this.dispatchEvent(new Event('resize'));
  }

  matchMedia(query) {
    const media = new EventTarget();
    media.media = query;
    media.matches =
      query === '(pointer: coarse)'
        ? this.coarse
        : query === '(orientation: portrait)'
          ? this.innerHeight > this.innerWidth
          : false;
    return media;
  }
}

function makeFixture(MobileLandscapeManager, width = 390, height = 844) {
  const overlay = new FakeElement();
  overlay.classes.add('hidden');
  const primaryButton = new FakeElement();
  const dismissButton = new FakeElement();
  const statusElement = new FakeElement();
  const fullscreenButton = new FakeElement();
  const doc = new FakeDocument();
  const win = new FakeWindow(width, height, true);
  const promptChanges = [];
  let gameplayActive = true;
  let gestures = 0;

  const manager = new MobileLandscapeManager(
    {
      overlay,
      primaryButton,
      dismissButton,
      statusElement,
      fullscreenButtons: [fullscreenButton],
    },
    {
      isGameplayActive: () => gameplayActive,
      onPromptVisibilityChange: (visible) => promptChanges.push(visible),
      onUserGesture: () => gestures++,
    },
    {
      windowTarget: win,
      documentTarget: doc,
      rootElement: doc.documentElement,
    }
  );

  return {
    manager,
    overlay,
    primaryButton,
    dismissButton,
    statusElement,
    fullscreenButton,
    doc,
    win,
    promptChanges,
    get gameplayActive() {
      return gameplayActive;
    },
    set gameplayActive(value) {
      gameplayActive = value;
    },
    get gestures() {
      return gestures;
    },
  };
}

async function settleAsync() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

test('MobileLandscapeManager: portrait prompt, dismissal, rotation reset, and successful lock', async () => {
  const { MobileLandscapeManager, isMobilePortraitViewport, getLandscapeHudTier } =
    await loadLandscapeModule();

  assert.equal(isMobilePortraitViewport(390, 844, true), true);
  assert.equal(isMobilePortraitViewport(844, 390, true), false);
  assert.equal(isMobilePortraitViewport(390, 844, false), false);
  assert.equal(isMobilePortraitViewport(768, 1024, true), true);
  assert.equal(isMobilePortraitViewport(1024, 1366, true), false);
  assert.equal(getLandscapeHudTier(800, 360), 'compact');
  assert.equal(getLandscapeHudTier(915, 412), 'standard');

  const fixture = makeFixture(MobileLandscapeManager);
  assert.equal(fixture.manager.isPromptVisible(), true);
  assert.equal(fixture.overlay.classList.contains('hidden'), false);
  assert.equal(fixture.overlay.getAttribute('aria-hidden'), 'false');
  assert.equal(fixture.doc.documentElement.dataset.mobileOrientation, 'portrait');
  assert.deepEqual(fixture.promptChanges, [true]);

  fixture.dismissButton.click();
  assert.equal(fixture.manager.isPromptVisible(), false);
  assert.equal(fixture.overlay.classList.contains('hidden'), true);

  fixture.win.setViewport(844, 390);
  assert.equal(fixture.doc.documentElement.dataset.mobileOrientation, 'landscape');
  fixture.win.setViewport(390, 844);
  assert.equal(
    fixture.manager.isPromptVisible(),
    true,
    'returning to portrait should show the prompt again'
  );

  fixture.primaryButton.click();
  await settleAsync();
  assert.ok(fixture.doc.documentElement.fullscreenRequests.length >= 1);
  assert.deepEqual(fixture.win.screen.orientation.lockCalls, ['landscape']);
  assert.equal(fixture.doc.fullscreenElement, fixture.doc.documentElement);
  assert.equal(fixture.manager.isPromptVisible(), false);

  await fixture.manager.toggleFullscreen();
  assert.equal(fixture.doc.fullscreenElement, null);
  assert.equal(fixture.win.screen.orientation.unlockCalls, 1);
  fixture.manager.destroy();
});

test('MobileLandscapeManager: unsupported APIs remain usable and gameplay keyboard/gesture guards work', async () => {
  const { MobileLandscapeManager, isTextEntryElement, shouldBlurTextEntry } =
    await loadLandscapeModule();
  const fixture = makeFixture(MobileLandscapeManager);

  fixture.doc.documentElement.failFullscreen = true;
  fixture.win.screen.orientation.failLock = true;
  fixture.primaryButton.click();
  await settleAsync();
  assert.equal(fixture.manager.isPromptVisible(), true);
  assert.match(fixture.statusElement.textContent, /does not allow automatic rotation/);
  assert.match(fixture.statusElement.textContent, /turn your phone sideways/);

  const textInput = {
    tagName: 'INPUT',
    type: 'text',
    closest: () => null,
    blurCalls: 0,
    blur() {
      this.blurCalls++;
    },
  };
  const allowedChatInput = {
    tagName: 'INPUT',
    type: 'text',
    closest: () => ({}),
    blurCalls: 0,
    blur() {
      this.blurCalls++;
    },
  };
  const rangeInput = { tagName: 'INPUT', type: 'range', closest: () => null };

  assert.equal(isTextEntryElement(textInput), true);
  assert.equal(isTextEntryElement(rangeInput), false);
  assert.equal(shouldBlurTextEntry(textInput, true), true);
  assert.equal(shouldBlurTextEntry(allowedChatInput, true), false);
  assert.equal(shouldBlurTextEntry(textInput, false), false);

  fixture.doc.activeElement = textInput;
  fixture.manager.blurActiveTextEntry();
  assert.equal(textInput.blurCalls, 1);

  const gesture = new Event('gesturestart', { cancelable: true });
  fixture.doc.dispatchEvent(gesture);
  assert.equal(gesture.defaultPrevented, true);

  const touchMove = new Event('touchmove', { cancelable: true });
  fixture.doc.dispatchEvent(touchMove);
  assert.equal(touchMove.defaultPrevented, true);

  fixture.gameplayActive = false;
  const lobbyGesture = new Event('gesturestart', { cancelable: true });
  fixture.doc.dispatchEvent(lobbyGesture);
  assert.equal(lobbyGesture.defaultPrevented, false);

  fixture.manager.destroy();
  fixture.win.setViewport(844, 390);
  assert.deepEqual(fixture.promptChanges, [true]);
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function landscapeLayout(width, height) {
  const dvh = height / 100;
  const dvw = width / 100;
  const vmin = Math.min(width, height) / 100;
  const edge = clamp(1.7 * vmin, 8, 12);
  const topHudHeight = clamp(11 * dvh, 40, 46);
  const minimap = clamp(19 * dvh, 64, 80);
  const healthHeight = clamp(13 * dvh, 46, 54);
  const hotbarHeight = clamp(13 * dvh, 46, 54);
  const ammoHeight = clamp(9 * dvh, 32, 38);
  const bottomStack = hotbarHeight + ammoHeight + 5;
  const actionSize = clamp(13.5 * dvh, 47, 56);
  const buildHeight = clamp(11.5 * dvh, 40, 46);
  const fireWidth = clamp(11 * dvw, 76, 94);
  const gap = clamp(1.4 * dvh, 5, 8);
  const clusterHeight = buildHeight + actionSize * 2 + gap * 2;
  const clusterWidth = actionSize * 3 + fireWidth + gap * 3;
  const clusterBottomOffset = edge + bottomStack + 8;
  const joystickSize = clamp(30 * dvh, 104, 124);
  const joystickBottomOffset = edge + healthHeight + 8;
  const hotbarSlot = clamp(6.1 * dvw, 45, 54);

  return {
    edge,
    topLeftBottom: edge + minimap + 5 + 24,
    topRightBottom: edge + topHudHeight + 5 + 52,
    healthHeight,
    ammoHeight,
    hotbarHeight,
    bottomStack,
    actionSize,
    buildHeight,
    fireWidth,
    fireHeight: actionSize * 2 + gap,
    clusterHeight,
    clusterWidth,
    clusterLeft: width - edge - clusterWidth,
    clusterTop: height - clusterBottomOffset - clusterHeight,
    clusterBottomGapAboveStack: clusterBottomOffset - (edge + bottomStack),
    joystickSize,
    joystickRight: edge + joystickSize,
    joystickTop: height - joystickBottomOffset - joystickSize,
    hotbarSlot,
    hotbarWidth: hotbarSlot * 5 + 4 * 4,
  };
}

test('mobile landscape contract and geometry at 800x360, 854x393, and 915x412', () => {
  const html = read('index.html');
  const css = read('src/styles/main.css');
  const main = read('src/main.ts');
  const manager = read('src/input/MobileLandscapeManager.ts');
  const landscapeCss = css.slice(css.indexOf('Professional phone-landscape HUD'));

  assert.match(html, /viewport-fit=cover/);
  for (const id of [
    'mobile-rotate-overlay',
    'btn-mobile-landscape',
    'btn-mobile-portrait-continue',
    'mobile-rotate-status',
    'hud-fullscreen-btn',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok((html.match(/data-fullscreen-toggle/g) || []).length >= 3);
  assert.match(html, /id="touch-reload-btn"[\s\S]*↻ RELOAD/);
  assert.match(main, /MobileLandscapeManager\.fromDocument/);
  assert.match(main, /mobileLandscape\?\.blurActiveTextEntry/);
  assert.match(manager, /requestFullscreen/);
  assert.match(manager, /orientation\.lock\('landscape'\)/);
  assert.match(manager, /data-allow-game-keyboard/);
  assert.match(manager, /gesturestart/);

  assert.match(
    landscapeCss,
    /@media \(pointer: coarse\) and \(orientation: landscape\) and \(max-width: 1100px\) and \(max-height: 600px\)/
  );
  assert.match(landscapeCss, /--landscape-action-size: clamp\(47px, 13\.5dvh, 56px\)/);
  assert.match(landscapeCss, /--landscape-fire-width: clamp\(76px, 11dvw, 94px\)/);
  assert.match(landscapeCss, /--landscape-joystick-size: clamp\(104px, 30dvh, 124px\)/);
  assert.match(landscapeCss, /\.weapon-materials-strip\s*\{[^}]*display: flex !important/s);
  assert.match(landscapeCss, /'wall ramp floor roof'/);
  assert.match(landscapeCss, /'swap reload ads fire'/);
  assert.match(landscapeCss, /'loot mat jump fire'/);
  assert.match(landscapeCss, /env\(safe-area-inset-left/);
  assert.match(landscapeCss, /env\(safe-area-inset-right/);
  assert.match(css, /#game-canvas-container\s*\{[\s\S]*height: 100dvh/);
  assert.match(css, /#game-canvas-container canvas\s*\{[\s\S]*touch-action: none/);

  for (const [width, height] of [
    [800, 360],
    [854, 393],
    [915, 412],
  ]) {
    const layout = landscapeLayout(width, height);
    const label = `${width}x${height}`;

    assert.ok(layout.healthHeight >= 46, `${label} health/shield card is too short`);
    assert.ok(layout.ammoHeight >= 32, `${label} ammo strip must remain visible`);
    assert.ok(layout.hotbarSlot >= 45, `${label} hotbar slots are below tap size`);
    assert.ok(layout.hotbarWidth < width / 2, `${label} hotbar crosses screen centre`);
    assert.ok(layout.bottomStack + layout.edge < height * 0.3, `${label} bottom HUD is too tall`);

    assert.ok(layout.clusterLeft > width / 2, `${label} action cluster blocks centre`);
    assert.ok(layout.clusterTop > layout.topRightBottom, `${label} actions overlap top HUD`);
    assert.ok(
      layout.clusterBottomGapAboveStack >= 8,
      `${label} actions overlap ammo/hotbar stack`
    );
    assert.ok(layout.fireWidth >= 76, `${label} FIRE target is too narrow`);
    assert.ok(layout.fireHeight >= 100, `${label} FIRE target is too short`);
    assert.ok(layout.actionSize >= 47, `${label} compact actions are below tap size`);
    assert.ok(layout.buildHeight >= 40, `${label} build controls are too short`);

    assert.ok(layout.joystickRight < width / 2, `${label} joystick crosses centre`);
    assert.ok(layout.joystickTop > layout.topLeftBottom, `${label} joystick overlaps minimap`);
    assert.ok(
      layout.clusterLeft - layout.joystickRight > width * 0.42,
      `${label} does not leave a clear central play/character lane`
    );
  }
});
