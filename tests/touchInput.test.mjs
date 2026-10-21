/**
 * CI Craft — mobile touch input tests.
 *
 * Covers the pure joystick/camera math and the MobileTouchControls pointer
 * bookkeeping with a tiny fake DOM. The crucial behaviours are circular
 * joystick clamping, radial deadzone/sprint, camera-look sign/pitch clamps,
 * simultaneous joystick + look pointers, wrong-pointer rejection, button
 * taps/holds, pointer cancellation, inactive/paused gating, and destroy()
 * listener cleanup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadTouchModules() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicraft-touch-test-'));
  try {
    const mathSource = fs.readFileSync(
      path.join(ROOT_DIR, 'src/input/touchInputMath.ts'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'touchInputMath.mjs'),
      stripTypeScriptTypes(mathSource)
    );

    const controllerSource = fs.readFileSync(
      path.join(ROOT_DIR, 'src/input/MobileTouchControls.ts'),
      'utf8'
    );
    const controllerJs = stripTypeScriptTypes(controllerSource).replace(
      /from\s+(['"])\.\/touchInputMath\1/g,
      "from './touchInputMath.mjs'"
    );
    fs.writeFileSync(path.join(tmpDir, 'MobileTouchControls.mjs'), controllerJs);

    const math = await import(
      pathToFileURL(path.join(tmpDir, 'touchInputMath.mjs')).href
    );
    const controller = await import(
      pathToFileURL(path.join(tmpDir, 'MobileTouchControls.mjs')).href
    );
    return { math, MobileTouchControls: controller.MobileTouchControls };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function approx(actual, expected, epsilon = 0.000001) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

class FakeElement extends EventTarget {
  constructor(width = 120, height = 120, left = 100, top = 200) {
    super();
    this.width = width;
    this.height = height;
    this.left = left;
    this.top = top;
    this.style = {};
    this.dataset = {};
    this.classes = new Set();
    this.capturedPointerIds = [];
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

  getBoundingClientRect() {
    return {
      left: this.left,
      top: this.top,
      width: this.width,
      height: this.height,
      right: this.left + this.width,
      bottom: this.top + this.height,
      x: this.left,
      y: this.top,
    };
  }

  setPointerCapture(pointerId) {
    this.capturedPointerIds.push(pointerId);
  }

  dispatchPointer(type, pointerId, clientX = 0, clientY = 0, pointerType = 'touch') {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, {
      pointerId,
      clientX,
      clientY,
      pointerType,
      isPrimary: false,
    });
    this.dispatchEvent(event);
    return event;
  }

  dispatchTouch(type, touches) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { changedTouches: touches });
    this.dispatchEvent(event);
    return event;
  }
}

test('touch math: circular joystick clamp, deadzone, diagonal movement, and sprint ring', async () => {
  const { math } = await loadTouchModules();

  const centered = math.calculateJoystickVector(0, 0, 40);
  assert.deepEqual(centered, {
    moveX: 0,
    moveZ: 0,
    knobX: 0,
    knobY: 0,
    magnitude: 0,
    sprint: false,
  });

  const insideDeadzone = math.calculateJoystickVector(2, 0, 40);
  assert.equal(insideDeadzone.moveX, 0);
  assert.equal(insideDeadzone.moveZ, 0);
  assert.equal(insideDeadzone.magnitude, 0);
  assert.equal(insideDeadzone.knobX, 2);

  const forward = math.calculateJoystickVector(0, -40, 40);
  approx(forward.moveX, 0);
  approx(forward.moveZ, -1);
  approx(forward.magnitude, 1);
  assert.equal(forward.sprint, true);

  const backwardLeft = math.calculateJoystickVector(-40, 40, 40);
  approx(Math.hypot(backwardLeft.moveX, backwardLeft.moveZ), 1);
  assert.ok(backwardLeft.moveX < 0);
  assert.ok(backwardLeft.moveZ > 0);
  approx(Math.hypot(backwardLeft.knobX, backwardLeft.knobY), 40);

  const beyondRadius = math.calculateJoystickVector(400, 300, 50);
  approx(Math.hypot(beyondRadius.moveX, beyondRadius.moveZ), 1);
  approx(Math.hypot(beyondRadius.knobX, beyondRadius.knobY), 50);
  approx(beyondRadius.moveX, 0.8);
  approx(beyondRadius.moveZ, 0.6);

  assert.deepEqual(math.combineMoveInput(1, -1, 0.5, -0.25), {
    moveX: 1,
    moveZ: -1,
  });
  assert.deepEqual(math.combineMoveInput(0, 0, -0.4, 0.3), {
    moveX: -0.4,
    moveZ: 0.3,
  });
});

test('touch math: look signs, sensitivity, angle wrapping, pitch and delta clamps', async () => {
  const { math } = await loadTouchModules();

  const rightAndUp = math.applyTouchLookDelta(0, 0, 100, -100, 1);
  approx(rightAndUp.yaw, -0.42);
  approx(rightAndUp.pitch, 0.42);

  const leftAndDown = math.applyTouchLookDelta(0, 0, -50, 50, 2);
  approx(leftAndDown.yaw, 0.42);
  approx(leftAndDown.pitch, -0.42);

  assert.equal(math.clampLookDelta(9999), math.TOUCH_LOOK_MAX_DELTA_PX);
  assert.equal(math.clampLookDelta(-9999), -math.TOUCH_LOOK_MAX_DELTA_PX);

  const pitchClampedUp = math.applyTouchLookDelta(0, 1.1, 0, -1000, 1);
  assert.equal(pitchClampedUp.pitch, math.TOUCH_CAMERA_MAX_PITCH);
  const pitchClampedDown = math.applyTouchLookDelta(0, -1.1, 0, 1000, 1);
  assert.equal(pitchClampedDown.pitch, math.TOUCH_CAMERA_MIN_PITCH);

  approx(math.normalizeAngle(Math.PI * 3), -Math.PI);
  approx(math.normalizeAngle(-Math.PI * 3), -Math.PI);
  approx(math.normalizeAngle(Math.PI / 2), Math.PI / 2);
});

test('MobileTouchControls: simultaneous pointers, cancellation, buttons, inactive gate, and cleanup', async () => {
  const { MobileTouchControls } = await loadTouchModules();

  const joystickZone = new FakeElement(120, 120, 100, 200);
  const joystickKnob = new FakeElement(44, 44, 138, 238);
  const lookSurface = new FakeElement(500, 500, 300, 0);
  const makeButton = () => new FakeElement(56, 56, 700, 500);
  const elements = {
    joystickZone,
    joystickKnob,
    lookSurface,
    fireButton: makeButton(),
    aimButton: makeButton(),
    jumpButton: makeButton(),
    lootButton: makeButton(),
    reloadButton: makeButton(),
    weaponButton: makeButton(),
    materialButton: makeButton(),
    wallButton: makeButton(),
    rampButton: makeButton(),
    floorButton: makeButton(),
    roofButton: makeButton(),
    hotbarSlots: [makeButton(), makeButton(), makeButton(), makeButton(), makeButton()],
  };
  elements.hotbarSlots.forEach((slot, index) => {
    slot.dataset.touchSlot = String(index);
  });

  let gameplayActive = true;
  const calls = {
    moves: [],
    looks: [],
    fire: [],
    aimSets: [],
    aimToggles: 0,
    jumps: 0,
    reloads: 0,
    interacts: 0,
    weaponCycles: 0,
    slots: [],
    builds: [],
    materials: 0,
  };
  let aimHeld = false;

  const controls = new MobileTouchControls(
    elements,
    {
      isGameplayActive: () => gameplayActive,
      onMove: (moveX, moveZ, sprint) => calls.moves.push({ moveX, moveZ, sprint }),
      onLook: (deltaX, deltaY) => calls.looks.push({ deltaX, deltaY }),
      setFireHeld: (held) => calls.fire.push(held),
      onAimToggle: () => {
        aimHeld = !aimHeld;
        calls.aimToggles++;
        return aimHeld;
      },
      setAimHeld: (held) => {
        aimHeld = held;
        calls.aimSets.push(held);
      },
      onJump: () => calls.jumps++,
      onReload: () => calls.reloads++,
      onInteract: () => calls.interacts++,
      onCycleWeapon: () => calls.weaponCycles++,
      onSelectSlot: (slot) => calls.slots.push(slot),
      onBuildPiece: (piece) => calls.builds.push(piece),
      onCycleMaterial: () => calls.materials++,
    },
    {
      usePointerEvents: true,
      windowTarget: new EventTarget(),
      documentTarget: Object.assign(new EventTarget(), { hidden: false }),
    }
  );

  // Joystick center is (160,260), usable radius is 38px.
  joystickZone.dispatchPointer('pointerdown', 11, 182, 238);
  assert.equal(calls.moves.length, 1);
  assert.ok(calls.moves[0].moveX > 0.5);
  assert.ok(calls.moves[0].moveZ < -0.5);
  assert.equal(calls.moves[0].sprint, false);
  assert.ok(joystickZone.capturedPointerIds.includes(11));

  // A second finger controls only the camera.
  lookSurface.dispatchPointer('pointerdown', 22, 500, 300);
  lookSurface.dispatchPointer('pointermove', 22, 530, 280);
  assert.deepEqual(calls.looks, [{ deltaX: 30, deltaY: -20 }]);

  // Crossed identifiers are ignored by both surfaces.
  joystickZone.dispatchPointer('pointermove', 22, 160, 260);
  lookSurface.dispatchPointer('pointermove', 11, 900, 900);
  assert.equal(calls.moves.length, 1);
  assert.equal(calls.looks.length, 1);

  // Simultaneous movement continues and the outer ring requests sprint.
  joystickZone.dispatchPointer('pointermove', 11, 198, 260);
  assert.equal(calls.moves.length, 2);
  approx(calls.moves[1].moveX, 1);
  approx(calls.moves[1].moveZ, 0);
  assert.equal(calls.moves[1].sprint, true);
  assert.equal(joystickZone.classList.contains('is-sprinting'), true);

  // Cancelling the joystick finger stops movement immediately but does not
  // cancel the independent camera finger.
  joystickZone.dispatchPointer('pointercancel', 11, 198, 260);
  assert.deepEqual(calls.moves.at(-1), { moveX: 0, moveZ: 0, sprint: false });
  lookSurface.dispatchPointer('pointermove', 22, 560, 250);
  assert.deepEqual(calls.looks.at(-1), { deltaX: 30, deltaY: -30 });
  lookSurface.dispatchPointer('pointerup', 22, 560, 250);
  lookSurface.dispatchPointer('pointermove', 22, 700, 250);
  assert.equal(calls.looks.length, 2);

  // Hold-to-fire honours its own pointer id and cancellation.
  elements.fireButton.dispatchPointer('pointerdown', 33, 700, 500);
  elements.fireButton.dispatchPointer('pointerdown', 34, 700, 500);
  elements.fireButton.dispatchPointer('pointerup', 34, 700, 500);
  assert.deepEqual(calls.fire, [true]);
  elements.fireButton.dispatchPointer('pointercancel', 33, 700, 500);
  assert.deepEqual(calls.fire, [true, false]);

  // Sliding the fire finger outside the button stops hold-to-fire at once;
  // sliding back in cannot resume it without a fresh deliberate press.
  elements.fireButton.dispatchPointer('pointerdown', 35, 728, 528);
  elements.fireButton.dispatchPointer('pointermove', 35, 750, 540);
  assert.deepEqual(calls.fire, [true, false, true]);
  elements.fireButton.dispatchPointer('pointermove', 35, 790, 528);
  assert.deepEqual(calls.fire, [true, false, true, false]);
  elements.fireButton.dispatchPointer('pointermove', 35, 728, 528);
  elements.fireButton.dispatchPointer('pointerup', 35, 728, 528);
  assert.deepEqual(calls.fire, [true, false, true, false]);

  // Toggle ADS stays active after finger release until toggled/reset.
  elements.aimButton.dispatchPointer('pointerdown', 44, 700, 500);
  elements.aimButton.dispatchPointer('pointerup', 44, 700, 500);
  assert.equal(aimHeld, true);
  assert.equal(elements.aimButton.classList.contains('is-active'), true);

  // Every tap action reaches its engine callback.
  const tap = (element, id) => {
    element.dispatchPointer('pointerdown', id, 700, 500);
    element.dispatchPointer('pointerup', id, 700, 500);
  };
  tap(elements.jumpButton, 50);
  tap(elements.lootButton, 51);
  tap(elements.reloadButton, 52);
  tap(elements.weaponButton, 53);
  tap(elements.materialButton, 54);
  tap(elements.wallButton, 55);
  tap(elements.rampButton, 56);
  tap(elements.floorButton, 57);
  tap(elements.roofButton, 58);
  tap(elements.hotbarSlots[3], 59);
  assert.equal(calls.jumps, 1);
  assert.equal(calls.interacts, 1);
  assert.equal(calls.reloads, 1);
  assert.equal(calls.weaponCycles, 1);
  assert.equal(calls.materials, 1);
  assert.deepEqual(calls.builds, ['wall', 'ramp', 'floor', 'roof']);
  assert.deepEqual(calls.slots, [3]);

  // Reset clears toggle ADS and movement.
  controls.resetAll();
  assert.equal(aimHeld, false);
  assert.deepEqual(calls.aimSets, [false]);
  assert.deepEqual(calls.moves.at(-1), { moveX: 0, moveZ: 0, sprint: false });

  // Paused/inactive gameplay cannot start touch input.
  gameplayActive = false;
  const moveCountBeforeInactive = calls.moves.length;
  const fireCountBeforeInactive = calls.fire.length;
  joystickZone.dispatchPointer('pointerdown', 60, 198, 260);
  elements.fireButton.dispatchPointer('pointerdown', 61, 700, 500);
  assert.equal(calls.moves.length, moveCountBeforeInactive);
  assert.equal(calls.fire.length, fireCountBeforeInactive);
  gameplayActive = true;

  // Desktop mouse pointer events are ignored by every touch surface, so
  // pointer-lock mouse camera/fire handling remains authoritative.
  const lookCountBeforeMouse = calls.looks.length;
  const moveCountBeforeMouse = calls.moves.length;
  const fireCountBeforeMouse = calls.fire.length;
  lookSurface.dispatchPointer('pointerdown', 900, 500, 300, 'mouse');
  lookSurface.dispatchPointer('pointermove', 900, 650, 200, 'mouse');
  joystickZone.dispatchPointer('pointerdown', 901, 198, 260, 'mouse');
  elements.fireButton.dispatchPointer('pointerdown', 902, 700, 500, 'mouse');
  assert.equal(calls.looks.length, lookCountBeforeMouse);
  assert.equal(calls.moves.length, moveCountBeforeMouse);
  assert.equal(calls.fire.length, fireCountBeforeMouse);

  // destroy() removes listeners: later dispatches are inert.
  controls.destroy();
  const finalMoveCount = calls.moves.length;
  const finalFireCount = calls.fire.length;
  joystickZone.dispatchPointer('pointerdown', 70, 198, 260);
  elements.fireButton.dispatchPointer('pointerdown', 71, 700, 500);
  lookSurface.dispatchPointer('pointerdown', 72, 500, 300);
  assert.equal(calls.moves.length, finalMoveCount);
  assert.equal(calls.fire.length, finalFireCount);
  assert.equal(calls.looks.length, 2);
});

test('MobileTouchControls: legacy Touch Events fallback tracks identifiers independently', async () => {
  const { MobileTouchControls } = await loadTouchModules();
  const joystickZone = new FakeElement(120, 120, 100, 200);
  const joystickKnob = new FakeElement(44, 44, 138, 238);
  const lookSurface = new FakeElement(500, 500, 300, 0);
  const fireButton = new FakeElement(56, 56, 100, 200);
  const moves = [];
  const looks = [];
  const fire = [];

  const controls = new MobileTouchControls(
    {
      joystickZone,
      joystickKnob,
      lookSurface,
      fireButton,
      aimButton: new FakeElement(56, 56),
      jumpButton: new FakeElement(56, 56),
      lootButton: new FakeElement(56, 56),
      reloadButton: new FakeElement(56, 56),
      weaponButton: new FakeElement(56, 56),
      materialButton: new FakeElement(56, 56),
      wallButton: new FakeElement(56, 56),
      rampButton: new FakeElement(56, 56),
      floorButton: new FakeElement(56, 56),
      roofButton: new FakeElement(56, 56),
      hotbarSlots: [],
    },
    {
      isGameplayActive: () => true,
      onMove: (moveX, moveZ, sprint) => moves.push({ moveX, moveZ, sprint }),
      onLook: (deltaX, deltaY) => looks.push({ deltaX, deltaY }),
      setFireHeld: (held) => fire.push(held),
      onAimToggle: () => false,
      setAimHeld: () => {},
      onJump: () => {},
      onReload: () => {},
      onInteract: () => {},
      onCycleWeapon: () => {},
      onSelectSlot: () => {},
      onBuildPiece: () => {},
      onCycleMaterial: () => {},
    },
    {
      usePointerEvents: false,
      windowTarget: new EventTarget(),
      documentTarget: Object.assign(new EventTarget(), { hidden: false }),
    }
  );

  const touch = (identifier, clientX, clientY) => ({ identifier, clientX, clientY });
  joystickZone.dispatchTouch('touchstart', [touch(101, 198, 260)]);
  assert.equal(moves.length, 1);
  approx(moves[0].moveX, 1);
  assert.equal(moves[0].sprint, true);

  lookSurface.dispatchTouch('touchstart', [touch(202, 500, 300)]);
  lookSurface.dispatchTouch('touchmove', [touch(202, 480, 330)]);
  assert.deepEqual(looks, [{ deltaX: -20, deltaY: 30 }]);

  joystickZone.dispatchTouch('touchmove', [touch(202, 160, 260)]);
  lookSurface.dispatchTouch('touchmove', [touch(101, 900, 900)]);
  assert.equal(moves.length, 1);
  assert.equal(looks.length, 1);

  joystickZone.dispatchTouch('touchcancel', [touch(101, 198, 260)]);
  assert.deepEqual(moves.at(-1), { moveX: 0, moveZ: 0, sprint: false });
  lookSurface.dispatchTouch('touchmove', [touch(202, 470, 350)]);
  assert.deepEqual(looks.at(-1), { deltaX: -10, deltaY: 20 });
  lookSurface.dispatchTouch('touchend', [touch(202, 470, 350)]);

  // The legacy fallback also stops FIRE as soon as that touch leaves the
  // button, rather than waiting for touchend/touchcancel.
  fireButton.dispatchTouch('touchstart', [touch(303, 128, 228)]);
  fireButton.dispatchTouch('touchmove', [touch(303, 180, 228)]);
  assert.deepEqual(fire, [true, false]);
  fireButton.dispatchTouch('touchend', [touch(303, 180, 228)]);
  assert.deepEqual(fire, [true, false]);
  controls.destroy();
});
