import type { BuildPieceType } from '../network/schemas';
import { calculateJoystickVector, clampLookDelta } from './touchInputMath';

export interface MobileTouchControlsCallbacks {
  isGameplayActive: () => boolean;
  onMove: (moveX: number, moveZ: number, sprint: boolean) => void;
  onLook: (deltaX: number, deltaY: number) => void;
  setFireHeld: (held: boolean) => void;
  onAimToggle: () => boolean;
  setAimHeld: (held: boolean) => void;
  onJump: () => void;
  onReload: () => void;
  onInteract: () => void;
  onCycleWeapon: () => void;
  onSelectSlot: (slotIndex: number) => void;
  onBuildPiece: (piece: BuildPieceType) => void;
  onCycleMaterial: () => void;
}

export interface MobileTouchControlElements {
  joystickZone: HTMLElement;
  joystickKnob: HTMLElement;
  lookSurface: HTMLElement;
  fireButton: HTMLElement;
  aimButton: HTMLElement;
  jumpButton: HTMLElement;
  lootButton: HTMLElement;
  reloadButton: HTMLElement;
  weaponButton: HTMLElement;
  materialButton: HTMLElement;
  wallButton: HTMLElement;
  rampButton: HTMLElement;
  floorButton: HTMLElement;
  roofButton: HTMLElement;
  hotbarSlots: readonly HTMLElement[];
}

export interface MobileTouchControlsOptions {
  usePointerEvents?: boolean;
  windowTarget?: EventTarget | null;
  documentTarget?: (EventTarget & { hidden?: boolean }) | null;
}

type ButtonReset = () => void;

/**
 * MobileTouchControls translates browser touch/pointer events into the
 * existing GameEngine input fields through callbacks supplied by main.ts.
 * It intentionally does not implement movement, shooting, building, or camera
 * physics itself: PlayerController and ThirdPersonCamera remain the single
 * gameplay/camera authorities shared with desktop controls.
 */
export class MobileTouchControls {
  private readonly elements: MobileTouchControlElements;
  private readonly callbacks: MobileTouchControlsCallbacks;
  private readonly usePointerEvents: boolean;
  private readonly windowTarget: EventTarget | null;
  private readonly documentTarget: (EventTarget & { hidden?: boolean }) | null;
  private readonly disposers: Array<() => void> = [];
  private readonly buttonResets: ButtonReset[] = [];

  private destroyed = false;
  private joystickPointerId: number | null = null;
  private joystickCenterX = 0;
  private joystickCenterY = 0;
  private joystickRadius = 40;

  private lookPointerId: number | null = null;
  private lookLastX = 0;
  private lookLastY = 0;

  private aimPointerId: number | null = null;
  private aimActive = false;

  constructor(
    elements: MobileTouchControlElements,
    callbacks: MobileTouchControlsCallbacks,
    options: MobileTouchControlsOptions = {}
  ) {
    this.elements = elements;
    this.callbacks = callbacks;
    this.usePointerEvents =
      options.usePointerEvents ??
      (typeof window !== 'undefined' && 'PointerEvent' in window);
    this.windowTarget =
      options.windowTarget ?? (typeof window !== 'undefined' ? window : null);
    this.documentTarget =
      options.documentTarget ??
      (typeof document !== 'undefined' ? document : null);

    this.bindJoystick();
    this.bindLookSurface();
    this.bindButtons();
    this.bindGlobalResetListeners();
    this.resetKnobVisual();
  }

  public static fromDocument(
    doc: Document,
    callbacks: MobileTouchControlsCallbacks,
    options: MobileTouchControlsOptions = {}
  ): MobileTouchControls | null {
    const byId = (id: string): HTMLElement | null => doc.getElementById(id);
    const elements: MobileTouchControlElements = {
      joystickZone: byId('touch-joystick-zone') as HTMLElement,
      joystickKnob: byId('touch-joystick-knob') as HTMLElement,
      lookSurface: byId('touch-look-surface') as HTMLElement,
      fireButton: byId('touch-fire-btn') as HTMLElement,
      aimButton: byId('touch-aim-btn') as HTMLElement,
      jumpButton: byId('touch-jump-btn') as HTMLElement,
      lootButton: byId('touch-loot-btn') as HTMLElement,
      reloadButton: byId('touch-reload-btn') as HTMLElement,
      weaponButton: byId('touch-weapon-btn') as HTMLElement,
      materialButton: byId('touch-material-btn') as HTMLElement,
      wallButton: byId('touch-wall-btn') as HTMLElement,
      rampButton: byId('touch-ramp-btn') as HTMLElement,
      floorButton: byId('touch-floor-btn') as HTMLElement,
      roofButton: byId('touch-roof-btn') as HTMLElement,
      hotbarSlots: Array.from(
        doc.querySelectorAll<HTMLElement>('[data-touch-slot]')
      ).sort(
        (a, b) =>
          Number(a.dataset.touchSlot || 0) - Number(b.dataset.touchSlot || 0)
      ),
    };

    const required: Array<HTMLElement | null> = [
      elements.joystickZone,
      elements.joystickKnob,
      elements.lookSurface,
      elements.fireButton,
      elements.aimButton,
      elements.jumpButton,
      elements.lootButton,
      elements.reloadButton,
      elements.weaponButton,
      elements.materialButton,
      elements.wallButton,
      elements.rampButton,
      elements.floorButton,
      elements.roofButton,
    ];
    if (required.some((element) => !element)) return null;

    return new MobileTouchControls(elements, callbacks, options);
  }

  /** Releases every held pointer/button without removing event listeners. */
  public resetAll(): void {
    this.resetJoystick();
    this.lookPointerId = null;
    this.elements.lookSurface.classList.remove('is-held');
    this.resetAim();
    for (const reset of this.buttonResets) reset();
    this.callbacks.setFireHeld(false);
  }

  /** Removes every listener registered by this controller. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resetAll();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.buttonResets.length = 0;
  }

  private listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions | boolean
  ): void {
    target.addEventListener(type, listener, options);
    this.disposers.push(() => target.removeEventListener(type, listener, options));
  }

  private canControl(): boolean {
    return !this.destroyed && this.callbacks.isGameplayActive();
  }

  /**
   * Pointer Events also describe the desktop mouse. Touch surfaces accept
   * touch/pen only so pointer-lock mouse look and mouse fire can never be
   * captured by the mobile layer on hybrid devices.
   */
  private isTouchLikePointer(event: PointerEvent): boolean {
    return event.pointerType !== 'mouse';
  }

  private capturePointer(element: HTMLElement, pointerId: number): void {
    try {
      element.setPointerCapture?.(pointerId);
    } catch {
      // Capture can fail if the browser already cancelled the pointer.
    }
  }

  private preventContextMenu(element: HTMLElement): void {
    this.listen(element, 'contextmenu', (event) => event.preventDefault());
  }

  private resetKnobVisual(): void {
    this.elements.joystickKnob.style.transform =
      'translate(calc(-50% + 0px), calc(-50% + 0px))';
    this.elements.joystickZone.classList.remove('is-sprinting');
  }

  private resetJoystick(): void {
    const wasActive = this.joystickPointerId !== null;
    this.joystickPointerId = null;
    this.resetKnobVisual();
    this.callbacks.onMove(0, 0, false);
    if (wasActive) this.elements.joystickZone.classList.remove('is-held');
  }

  private beginJoystick(pointerId: number, clientX: number, clientY: number): void {
    if (this.joystickPointerId !== null || !this.canControl()) return;

    const zoneRect = this.elements.joystickZone.getBoundingClientRect();
    const knobRect = this.elements.joystickKnob.getBoundingClientRect();
    this.joystickPointerId = pointerId;
    this.joystickCenterX = zoneRect.left + zoneRect.width / 2;
    this.joystickCenterY = zoneRect.top + zoneRect.height / 2;
    this.joystickRadius = Math.max(
      24,
      Math.min(zoneRect.width, zoneRect.height) / 2 - knobRect.width / 2
    );
    this.elements.joystickZone.classList.add('is-held');
    this.updateJoystick(clientX, clientY);
  }

  private updateJoystick(clientX: number, clientY: number): void {
    if (this.joystickPointerId === null) return;
    if (!this.canControl()) {
      this.resetJoystick();
      return;
    }

    const vector = calculateJoystickVector(
      clientX - this.joystickCenterX,
      clientY - this.joystickCenterY,
      this.joystickRadius
    );
    this.elements.joystickKnob.style.transform =
      `translate(calc(-50% + ${vector.knobX.toFixed(1)}px), ` +
      `calc(-50% + ${vector.knobY.toFixed(1)}px))`;
    this.elements.joystickZone.classList.toggle('is-sprinting', vector.sprint);
    this.callbacks.onMove(vector.moveX, vector.moveZ, vector.sprint);
  }

  private endJoystick(pointerId: number): void {
    if (this.joystickPointerId === pointerId) this.resetJoystick();
  }

  private bindJoystick(): void {
    const zone = this.elements.joystickZone;
    this.preventContextMenu(zone);

    if (this.usePointerEvents) {
      this.listen(zone, 'pointerdown', (event) => {
        const pointerEvent = event as PointerEvent;
        if (!this.isTouchLikePointer(pointerEvent)) return;
        if (this.joystickPointerId !== null || !this.canControl()) return;
        pointerEvent.preventDefault();
        this.capturePointer(zone, pointerEvent.pointerId);
        this.beginJoystick(
          pointerEvent.pointerId,
          pointerEvent.clientX,
          pointerEvent.clientY
        );
      });
      this.listen(zone, 'pointermove', (event) => {
        const pointerEvent = event as PointerEvent;
        if (pointerEvent.pointerId !== this.joystickPointerId) return;
        pointerEvent.preventDefault();
        this.updateJoystick(pointerEvent.clientX, pointerEvent.clientY);
      });
      const end = (event: Event): void => {
        const pointerEvent = event as PointerEvent;
        this.endJoystick(pointerEvent.pointerId);
      };
      this.listen(zone, 'pointerup', end);
      this.listen(zone, 'pointercancel', end);
      this.listen(zone, 'lostpointercapture', end);
      return;
    }

    this.listen(
      zone,
      'touchstart',
      (event) => {
        const touchEvent = event as TouchEvent;
        if (this.joystickPointerId !== null || !this.canControl()) return;
        const touch = touchEvent.changedTouches[0];
        if (!touch) return;
        touchEvent.preventDefault();
        this.beginJoystick(touch.identifier, touch.clientX, touch.clientY);
      },
      { passive: false }
    );
    this.listen(
      zone,
      'touchmove',
      (event) => {
        const touchEvent = event as TouchEvent;
        for (let i = 0; i < touchEvent.changedTouches.length; i++) {
          const touch = touchEvent.changedTouches[i];
          if (touch.identifier === this.joystickPointerId) {
            touchEvent.preventDefault();
            this.updateJoystick(touch.clientX, touch.clientY);
          }
        }
      },
      { passive: false }
    );
    const endTouch = (event: Event): void => {
      const touchEvent = event as TouchEvent;
      for (let i = 0; i < touchEvent.changedTouches.length; i++) {
        this.endJoystick(touchEvent.changedTouches[i].identifier);
      }
    };
    this.listen(zone, 'touchend', endTouch);
    this.listen(zone, 'touchcancel', endTouch);
  }

  private beginLook(pointerId: number, clientX: number, clientY: number): void {
    if (this.lookPointerId !== null || !this.canControl()) return;
    this.lookPointerId = pointerId;
    this.lookLastX = clientX;
    this.lookLastY = clientY;
    this.elements.lookSurface.classList.add('is-held');
  }

  private updateLook(clientX: number, clientY: number): void {
    if (this.lookPointerId === null) return;
    if (!this.canControl()) {
      this.endLook(this.lookPointerId);
      return;
    }

    const deltaX = clampLookDelta(clientX - this.lookLastX);
    const deltaY = clampLookDelta(clientY - this.lookLastY);
    this.lookLastX = clientX;
    this.lookLastY = clientY;
    if (deltaX !== 0 || deltaY !== 0) this.callbacks.onLook(deltaX, deltaY);
  }

  private endLook(pointerId: number): void {
    if (this.lookPointerId !== pointerId) return;
    this.lookPointerId = null;
    this.elements.lookSurface.classList.remove('is-held');
  }

  private bindLookSurface(): void {
    const surface = this.elements.lookSurface;
    this.preventContextMenu(surface);

    if (this.usePointerEvents) {
      this.listen(surface, 'pointerdown', (event) => {
        const pointerEvent = event as PointerEvent;
        if (!this.isTouchLikePointer(pointerEvent)) return;
        if (this.lookPointerId !== null || !this.canControl()) return;
        // The joystick has its own element/capture. This guard is a second
        // line of defence if a browser retargets a multi-touch sequence.
        if (pointerEvent.pointerId === this.joystickPointerId) return;
        pointerEvent.preventDefault();
        this.capturePointer(surface, pointerEvent.pointerId);
        this.beginLook(
          pointerEvent.pointerId,
          pointerEvent.clientX,
          pointerEvent.clientY
        );
      });
      this.listen(surface, 'pointermove', (event) => {
        const pointerEvent = event as PointerEvent;
        if (pointerEvent.pointerId !== this.lookPointerId) return;
        pointerEvent.preventDefault();
        this.updateLook(pointerEvent.clientX, pointerEvent.clientY);
      });
      const end = (event: Event): void => {
        this.endLook((event as PointerEvent).pointerId);
      };
      this.listen(surface, 'pointerup', end);
      this.listen(surface, 'pointercancel', end);
      this.listen(surface, 'lostpointercapture', end);
      return;
    }

    this.listen(
      surface,
      'touchstart',
      (event) => {
        const touchEvent = event as TouchEvent;
        if (this.lookPointerId !== null || !this.canControl()) return;
        for (let i = 0; i < touchEvent.changedTouches.length; i++) {
          const touch = touchEvent.changedTouches[i];
          if (touch.identifier === this.joystickPointerId) continue;
          touchEvent.preventDefault();
          this.beginLook(touch.identifier, touch.clientX, touch.clientY);
          break;
        }
      },
      { passive: false }
    );
    this.listen(
      surface,
      'touchmove',
      (event) => {
        const touchEvent = event as TouchEvent;
        for (let i = 0; i < touchEvent.changedTouches.length; i++) {
          const touch = touchEvent.changedTouches[i];
          if (touch.identifier === this.lookPointerId) {
            touchEvent.preventDefault();
            this.updateLook(touch.clientX, touch.clientY);
          }
        }
      },
      { passive: false }
    );
    const endTouch = (event: Event): void => {
      const touchEvent = event as TouchEvent;
      for (let i = 0; i < touchEvent.changedTouches.length; i++) {
        this.endLook(touchEvent.changedTouches[i].identifier);
      }
    };
    this.listen(surface, 'touchend', endTouch);
    this.listen(surface, 'touchcancel', endTouch);
  }

  private bindHoldButton(
    element: HTMLElement,
    onHeldChange: (held: boolean) => void
  ): void {
    this.preventContextMenu(element);
    let activePointerId: number | null = null;

    const release = (): void => {
      if (activePointerId === null) return;
      activePointerId = null;
      element.classList.remove('is-held');
      onHeldChange(false);
    };
    this.buttonResets.push(release);

    if (this.usePointerEvents) {
      this.listen(element, 'pointerdown', (event) => {
        const pointerEvent = event as PointerEvent;
        if (!this.isTouchLikePointer(pointerEvent)) return;
        if (activePointerId !== null || !this.canControl()) return;
        pointerEvent.preventDefault();
        activePointerId = pointerEvent.pointerId;
        this.capturePointer(element, activePointerId);
        element.classList.add('is-held');
        onHeldChange(true);
      });
      const end = (event: Event): void => {
        if ((event as PointerEvent).pointerId === activePointerId) release();
      };
      this.listen(element, 'pointerup', end);
      this.listen(element, 'pointercancel', end);
      this.listen(element, 'lostpointercapture', end);
      return;
    }

    this.listen(
      element,
      'touchstart',
      (event) => {
        const touchEvent = event as TouchEvent;
        if (activePointerId !== null || !this.canControl()) return;
        const touch = touchEvent.changedTouches[0];
        if (!touch) return;
        touchEvent.preventDefault();
        activePointerId = touch.identifier;
        element.classList.add('is-held');
        onHeldChange(true);
      },
      { passive: false }
    );
    const endTouch = (event: Event): void => {
      const touchEvent = event as TouchEvent;
      for (let i = 0; i < touchEvent.changedTouches.length; i++) {
        if (touchEvent.changedTouches[i].identifier === activePointerId) release();
      }
    };
    this.listen(element, 'touchend', endTouch);
    this.listen(element, 'touchcancel', endTouch);
  }

  private bindTapButton(element: HTMLElement, onTap: () => void): void {
    this.preventContextMenu(element);
    let activePointerId: number | null = null;

    const release = (): void => {
      activePointerId = null;
      element.classList.remove('is-held');
    };
    this.buttonResets.push(release);

    if (this.usePointerEvents) {
      this.listen(element, 'pointerdown', (event) => {
        const pointerEvent = event as PointerEvent;
        if (!this.isTouchLikePointer(pointerEvent)) return;
        if (activePointerId !== null || !this.canControl()) return;
        pointerEvent.preventDefault();
        activePointerId = pointerEvent.pointerId;
        this.capturePointer(element, activePointerId);
        element.classList.add('is-held');
        onTap();
      });
      const end = (event: Event): void => {
        if ((event as PointerEvent).pointerId === activePointerId) release();
      };
      this.listen(element, 'pointerup', end);
      this.listen(element, 'pointercancel', end);
      this.listen(element, 'lostpointercapture', end);
      return;
    }

    this.listen(
      element,
      'touchstart',
      (event) => {
        const touchEvent = event as TouchEvent;
        if (activePointerId !== null || !this.canControl()) return;
        const touch = touchEvent.changedTouches[0];
        if (!touch) return;
        touchEvent.preventDefault();
        activePointerId = touch.identifier;
        element.classList.add('is-held');
        onTap();
      },
      { passive: false }
    );
    const endTouch = (event: Event): void => {
      const touchEvent = event as TouchEvent;
      for (let i = 0; i < touchEvent.changedTouches.length; i++) {
        if (touchEvent.changedTouches[i].identifier === activePointerId) release();
      }
    };
    this.listen(element, 'touchend', endTouch);
    this.listen(element, 'touchcancel', endTouch);
  }

  private resetAim(): void {
    this.aimPointerId = null;
    this.elements.aimButton.classList.remove('is-held');
    if (!this.aimActive) return;
    this.aimActive = false;
    this.elements.aimButton.classList.remove('is-active');
    this.callbacks.setAimHeld(false);
  }

  private bindAimToggle(): void {
    const element = this.elements.aimButton;
    this.preventContextMenu(element);
    this.buttonResets.push(() => {
      this.aimPointerId = null;
      element.classList.remove('is-held');
    });

    const toggle = (): void => {
      this.aimActive = this.callbacks.onAimToggle();
      element.classList.toggle('is-active', this.aimActive);
    };

    if (this.usePointerEvents) {
      this.listen(element, 'pointerdown', (event) => {
        const pointerEvent = event as PointerEvent;
        if (!this.isTouchLikePointer(pointerEvent)) return;
        if (this.aimPointerId !== null || !this.canControl()) return;
        pointerEvent.preventDefault();
        this.aimPointerId = pointerEvent.pointerId;
        this.capturePointer(element, this.aimPointerId);
        element.classList.add('is-held');
        toggle();
      });
      const end = (event: Event): void => {
        if ((event as PointerEvent).pointerId !== this.aimPointerId) return;
        this.aimPointerId = null;
        element.classList.remove('is-held');
      };
      this.listen(element, 'pointerup', end);
      this.listen(element, 'pointercancel', end);
      this.listen(element, 'lostpointercapture', end);
      return;
    }

    this.listen(
      element,
      'touchstart',
      (event) => {
        const touchEvent = event as TouchEvent;
        if (this.aimPointerId !== null || !this.canControl()) return;
        const touch = touchEvent.changedTouches[0];
        if (!touch) return;
        touchEvent.preventDefault();
        this.aimPointerId = touch.identifier;
        element.classList.add('is-held');
        toggle();
      },
      { passive: false }
    );
    const endTouch = (event: Event): void => {
      const touchEvent = event as TouchEvent;
      for (let i = 0; i < touchEvent.changedTouches.length; i++) {
        if (touchEvent.changedTouches[i].identifier === this.aimPointerId) {
          this.aimPointerId = null;
          element.classList.remove('is-held');
        }
      }
    };
    this.listen(element, 'touchend', endTouch);
    this.listen(element, 'touchcancel', endTouch);
  }

  private bindButtons(): void {
    const elements = this.elements;
    this.bindHoldButton(elements.fireButton, (held) =>
      this.callbacks.setFireHeld(held)
    );
    this.bindAimToggle();
    this.bindTapButton(elements.jumpButton, () => this.callbacks.onJump());
    this.bindTapButton(elements.lootButton, () => this.callbacks.onInteract());
    this.bindTapButton(elements.reloadButton, () => this.callbacks.onReload());
    this.bindTapButton(elements.weaponButton, () =>
      this.callbacks.onCycleWeapon()
    );
    this.bindTapButton(elements.materialButton, () =>
      this.callbacks.onCycleMaterial()
    );
    this.bindTapButton(elements.wallButton, () =>
      this.callbacks.onBuildPiece('wall')
    );
    this.bindTapButton(elements.rampButton, () =>
      this.callbacks.onBuildPiece('ramp')
    );
    this.bindTapButton(elements.floorButton, () =>
      this.callbacks.onBuildPiece('floor')
    );
    this.bindTapButton(elements.roofButton, () =>
      this.callbacks.onBuildPiece('roof')
    );

    elements.hotbarSlots.forEach((slot, fallbackIndex) => {
      const slotIndex = Number(slot.dataset.touchSlot ?? fallbackIndex);
      this.bindTapButton(slot, () => this.callbacks.onSelectSlot(slotIndex));
    });
  }

  private bindGlobalResetListeners(): void {
    const reset = (): void => this.resetAll();

    if (this.windowTarget) {
      this.listen(this.windowTarget, 'blur', reset);
      this.listen(this.windowTarget, 'resize', reset);
      this.listen(this.windowTarget, 'orientationchange', reset);

      const visualViewport = (
        this.windowTarget as Window & { visualViewport?: VisualViewport | null }
      ).visualViewport;
      if (visualViewport) this.listen(visualViewport, 'resize', reset);
    }

    if (this.documentTarget) {
      this.listen(this.documentTarget, 'visibilitychange', () => {
        if (this.documentTarget?.hidden) reset();
      });
    }
  }
}
