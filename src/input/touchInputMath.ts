/**
 * Pure touch-input math shared by the mobile controls, camera, and tests.
 *
 * Keeping these helpers free of DOM/Three.js dependencies makes the joystick
 * and camera behaviour deterministic and unit-testable, while MobileTouchControls
 * remains responsible only for browser event/pointer bookkeeping.
 */

export const TOUCH_CAMERA_MIN_PITCH = -1.15;
export const TOUCH_CAMERA_MAX_PITCH = 1.15;
export const TOUCH_LOOK_RADIANS_PER_PIXEL = 0.0042;
export const TOUCH_LOOK_MAX_DELTA_PX = 160;
export const TOUCH_JOYSTICK_DEADZONE = 0.08;
export const TOUCH_JOYSTICK_SPRINT_THRESHOLD = 0.92;

export interface JoystickVector {
  /** Normalized strafe input: left -1, right +1. */
  moveX: number;
  /** Normalized forward/back input used by PlayerInputPacket: up/forward -1, down/back +1. */
  moveZ: number;
  /** Knob displacement in CSS pixels after circular clamping. */
  knobX: number;
  knobY: number;
  /** Post-deadzone magnitude in the range 0..1. */
  magnitude: number;
  /** True when the stick is pushed to the outer sprint ring. */
  sprint: boolean;
}

export interface LookAngles {
  yaw: number;
  pitch: number;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, finiteOrZero(value)));
}

/**
 * Converts a pointer offset from the joystick centre into a circularly
 * clamped, radially dead-zoned input vector.
 *
 * Unlike independently clamping X/Y (which creates a square and lets diagonal
 * input exceed magnitude 1), this preserves direction and caps magnitude at 1.
 * The returned moveZ intentionally uses screen-space Y: pushing up is
 * negative, which PlayerController already interprets as camera-forward.
 */
export function calculateJoystickVector(
  offsetX: number,
  offsetY: number,
  radiusPx: number,
  deadzone: number = TOUCH_JOYSTICK_DEADZONE
): JoystickVector {
  const radius = Math.max(1, finiteOrZero(radiusPx));
  const safeDeadzone = clampNumber(deadzone, 0, 0.95);
  const rawX = finiteOrZero(offsetX) / radius;
  const rawY = finiteOrZero(offsetY) / radius;
  const rawMagnitude = Math.hypot(rawX, rawY);

  if (rawMagnitude <= 0.0001) {
    return {
      moveX: 0,
      moveZ: 0,
      knobX: 0,
      knobY: 0,
      magnitude: 0,
      sprint: false,
    };
  }

  const clampedMagnitude = Math.min(1, rawMagnitude);
  const directionX = rawX / rawMagnitude;
  const directionY = rawY / rawMagnitude;
  const knobX = directionX * clampedMagnitude * radius;
  const knobY = directionY * clampedMagnitude * radius;

  if (clampedMagnitude <= safeDeadzone) {
    return {
      moveX: 0,
      moveZ: 0,
      knobX,
      knobY,
      magnitude: 0,
      sprint: false,
    };
  }

  const magnitude =
    (clampedMagnitude - safeDeadzone) / (1 - safeDeadzone);

  return {
    moveX: directionX * magnitude,
    moveZ: directionY * magnitude,
    knobX,
    knobY,
    magnitude,
    sprint: magnitude >= TOUCH_JOYSTICK_SPRINT_THRESHOLD,
  };
}

/** Combines keyboard and touch axes without letting either source exceed ±1. */
export function combineMoveInput(
  keyboardX: number,
  keyboardZ: number,
  touchX: number,
  touchZ: number
): { moveX: number; moveZ: number } {
  return {
    moveX: clampNumber(finiteOrZero(keyboardX) + finiteOrZero(touchX), -1, 1),
    moveZ: clampNumber(finiteOrZero(keyboardZ) + finiteOrZero(touchZ), -1, 1),
  };
}

export function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  const wrapped = ((finiteOrZero(angle) + Math.PI) % twoPi + twoPi) % twoPi;
  return wrapped - Math.PI;
}

export function clampTouchPitch(pitch: number): number {
  return clampNumber(pitch, TOUCH_CAMERA_MIN_PITCH, TOUCH_CAMERA_MAX_PITCH);
}

/**
 * Clamps one pointer-move delta. This protects against a browser coalescing
 * or re-anchoring a touch after rotation/zoom and producing a camera jump.
 */
export function clampLookDelta(deltaPx: number): number {
  return clampNumber(deltaPx, -TOUCH_LOOK_MAX_DELTA_PX, TOUCH_LOOK_MAX_DELTA_PX);
}

/**
 * Applies a touch drag to camera angles using the same sign convention as the
 * existing pointer-lock mouse look:
 * - drag right  -> look right
 * - drag up     -> look up
 * - drag down   -> look down
 */
export function applyTouchLookDelta(
  currentYaw: number,
  currentPitch: number,
  deltaX: number,
  deltaY: number,
  sensitivityScale: number = 1
): LookAngles {
  const sensitivity =
    TOUCH_LOOK_RADIANS_PER_PIXEL *
    clampNumber(sensitivityScale, 0.05, 5);

  return {
    yaw: normalizeAngle(
      finiteOrZero(currentYaw) - clampLookDelta(deltaX) * sensitivity
    ),
    pitch: clampTouchPitch(
      finiteOrZero(currentPitch) - clampLookDelta(deltaY) * sensitivity
    ),
  };
}
