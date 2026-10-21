export interface MobileLandscapeElements {
  overlay: HTMLElement;
  primaryButton: HTMLElement;
  dismissButton: HTMLElement | null;
  statusElement: HTMLElement | null;
  fullscreenButtons: readonly HTMLElement[];
}

export interface MobileLandscapeCallbacks {
  isGameplayActive?: () => boolean;
  onPromptVisibilityChange?: (visible: boolean) => void;
  onUserGesture?: () => void;
}

export interface MobileLandscapeOptions {
  windowTarget?: Window | null;
  documentTarget?: Document | null;
  rootElement?: HTMLElement | null;
}

type OrientationLockRequest =
  | 'any'
  | 'landscape'
  | 'landscape-primary'
  | 'landscape-secondary'
  | 'natural'
  | 'portrait'
  | 'portrait-primary'
  | 'portrait-secondary';

type ScreenOrientationWithLock = ScreenOrientation & {
  lock?: (orientation: OrientationLockRequest) => Promise<void>;
};

interface StructuralElement {
  tagName?: unknown;
  type?: unknown;
  isContentEditable?: unknown;
  closest?: (selector: string) => unknown;
  blur?: () => void;
}

const TEXT_ENTRY_INPUT_TYPES = new Set([
  '',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
]);

/**
 * Coarse-pointer phones and small tablets get the rotate prompt. The 900px
 * bound mirrors the existing mobile-controls breakpoint while excluding
 * portrait desktop monitors.
 */
export function isMobilePortraitViewport(
  width: number,
  height: number,
  coarsePointer: boolean
): boolean {
  return coarsePointer && height > width && width <= 900;
}

export function getLandscapeHudTier(
  width: number,
  height: number
): 'compact' | 'standard' | 'roomy' {
  if (width <= height) return 'compact';
  if (height <= 380) return 'compact';
  if (height <= 440) return 'standard';
  return 'roomy';
}

export function isTextEntryElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as StructuralElement;
  const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  if (tagName === 'TEXTAREA') return true;
  if (tagName === 'INPUT') {
    const type = typeof element.type === 'string' ? element.type.toLowerCase() : '';
    return TEXT_ENTRY_INPUT_TYPES.has(type);
  }
  return element.isContentEditable === true;
}

export function shouldBlurTextEntry(
  target: EventTarget | null,
  gameplayActive: boolean
): boolean {
  if (!gameplayActive || !isTextEntryElement(target)) return false;
  const element = target as StructuralElement;
  try {
    // A future in-game chat can opt in explicitly. Ordinary lobby/account
    // fields are hidden during a match and must never leave the software
    // keyboard covering the HUD after the match starts.
    if (element.closest?.('[data-allow-game-keyboard="true"]')) return false;
  } catch {
    // A detached/non-DOM test target is still safe to blur.
  }
  return true;
}

/**
 * Owns only browser chrome concerns: the portrait prompt, best-effort
 * fullscreen/orientation requests, and preventing a stale lobby text field
 * from leaving the virtual keyboard open during gameplay. Gameplay input
 * remains in MobileTouchControls/GameEngine, and no network or movement
 * state is changed here.
 */
export class MobileLandscapeManager {
  private readonly elements: MobileLandscapeElements;
  private readonly callbacks: MobileLandscapeCallbacks;
  private readonly windowTarget: Window | null;
  private readonly documentTarget: Document | null;
  private readonly rootElement: HTMLElement | null;
  private readonly disposers: Array<() => void> = [];

  private destroyed = false;
  private dismissedForCurrentPortrait = false;
  private promptVisible = false;

  public constructor(
    elements: MobileLandscapeElements,
    callbacks: MobileLandscapeCallbacks = {},
    options: MobileLandscapeOptions = {}
  ) {
    this.elements = elements;
    this.callbacks = callbacks;
    this.windowTarget =
      options.windowTarget ?? (typeof window !== 'undefined' ? window : null);
    this.documentTarget =
      options.documentTarget ??
      (typeof document !== 'undefined' ? document : null);
    this.rootElement =
      options.rootElement ?? this.documentTarget?.documentElement ?? null;

    this.bindButtons();
    this.bindViewportListeners();
    this.bindKeyboardAndGestureGuards();
    this.syncFullscreenButtons();
    this.refresh();
  }

  public static fromDocument(
    doc: Document,
    callbacks: MobileLandscapeCallbacks = {},
    options: MobileLandscapeOptions = {}
  ): MobileLandscapeManager | null {
    const overlay = doc.getElementById('mobile-rotate-overlay');
    const primaryButton = doc.getElementById('btn-mobile-landscape');
    if (!overlay || !primaryButton) return null;

    return new MobileLandscapeManager(
      {
        overlay,
        primaryButton,
        dismissButton: doc.getElementById('btn-mobile-portrait-continue'),
        statusElement: doc.getElementById('mobile-rotate-status'),
        fullscreenButtons: Array.from(
          doc.querySelectorAll<HTMLElement>('[data-fullscreen-toggle]')
        ),
      },
      callbacks,
      {
        documentTarget: doc,
        rootElement: doc.documentElement,
        windowTarget: doc.defaultView,
        ...options,
      }
    );
  }

  public refresh(): void {
    if (this.destroyed) return;
    const { width, height } = this.getViewportSize();
    const portrait = height > width;
    if (!portrait) this.dismissedForCurrentPortrait = false;

    const visible =
      isMobilePortraitViewport(width, height, this.isCoarsePointer()) &&
      !this.dismissedForCurrentPortrait;

    this.elements.overlay.classList.toggle('hidden', !visible);
    this.elements.overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');

    if (this.rootElement) {
      this.rootElement.dataset.mobileOrientation = portrait ? 'portrait' : 'landscape';
      this.rootElement.dataset.mobileHudTier = getLandscapeHudTier(width, height);
      this.rootElement.classList.toggle('mobile-rotate-prompt-visible', visible);
    }

    if (visible !== this.promptVisible) {
      this.promptVisible = visible;
      this.callbacks.onPromptVisibilityChange?.(visible);
    }
  }

  public isPromptVisible(): boolean {
    return this.promptVisible;
  }

  public isFullscreenSupported(): boolean {
    const doc = this.documentTarget as (Document & { fullscreenEnabled?: boolean }) | null;
    return Boolean(
      this.rootElement &&
        typeof this.rootElement.requestFullscreen === 'function' &&
        doc?.fullscreenEnabled !== false
    );
  }

  /**
   * Fullscreen must normally precede orientation locking and both require a
   * user gesture. Every failure is non-fatal: iOS Safari and some Android
   * browsers require a manual rotation, so the prompt remains visible with
   * instructions instead of trapping the player.
   */
  public async requestLandscape(): Promise<boolean> {
    this.callbacks.onUserGesture?.();

    if (!this.documentTarget?.fullscreenElement && this.rootElement) {
      try {
        await this.rootElement.requestFullscreen({ navigationUI: 'hide' });
      } catch {
        try {
          await this.rootElement.requestFullscreen();
        } catch {
          // Continue to orientation lock/manual instructions below.
        }
      }
    }

    let locked = false;
    const orientation = this.windowTarget?.screen?.orientation as
      | ScreenOrientationWithLock
      | undefined;
    if (orientation && typeof orientation.lock === 'function') {
      try {
        await orientation.lock('landscape');
        locked = true;
      } catch {
        locked = false;
      }
    }

    this.refresh();
    const { width, height } = this.getViewportSize();
    const landscape = width >= height;
    if (!landscape && this.elements.statusElement) {
      this.elements.statusElement.textContent = locked
        ? 'Landscape was requested. If the screen does not rotate, turn your phone sideways.'
        : 'This browser does not allow automatic rotation here. Please turn your phone sideways.';
    }
    return landscape || locked;
  }

  public async toggleFullscreen(): Promise<void> {
    if (!this.documentTarget?.fullscreenElement) {
      await this.requestLandscape();
      return;
    }

    this.callbacks.onUserGesture?.();
    const orientation = this.windowTarget?.screen?.orientation as
      | ScreenOrientationWithLock
      | undefined;
    try {
      orientation?.unlock?.();
    } catch {
      // Unlock is best-effort and unsupported in some browsers.
    }
    try {
      await this.documentTarget.exitFullscreen();
    } catch {
      // Fullscreen state will be resynchronized on fullscreenchange.
    }
    this.refresh();
  }

  public blurActiveTextEntry(): void {
    const active = this.documentTarget?.activeElement ?? null;
    if (!shouldBlurTextEntry(active, this.isGameplayActive())) return;
    (active as StructuralElement).blur?.();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  private isGameplayActive(): boolean {
    return this.callbacks.isGameplayActive?.() ?? false;
  }

  private getViewportSize(): { width: number; height: number } {
    const visualViewport = this.windowTarget?.visualViewport;
    const width = Math.round(
      visualViewport?.width ??
        this.windowTarget?.innerWidth ??
        this.rootElement?.clientWidth ??
        0
    );
    const height = Math.round(
      visualViewport?.height ??
        this.windowTarget?.innerHeight ??
        this.rootElement?.clientHeight ??
        0
    );
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }

  private isCoarsePointer(): boolean {
    try {
      return Boolean(this.windowTarget?.matchMedia?.('(pointer: coarse)').matches);
    } catch {
      return false;
    }
  }

  private syncFullscreenButtons(): void {
    const supported = this.isFullscreenSupported();
    for (const button of this.elements.fullscreenButtons) {
      button.classList.toggle('fullscreen-unsupported', !supported);
      button.setAttribute('aria-hidden', supported ? 'false' : 'true');
      if ('disabled' in button) {
        (button as HTMLButtonElement).disabled = !supported;
      }
    }
  }

  private listen(
    target: EventTarget | null | undefined,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions | boolean
  ): void {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, listener, options);
    this.disposers.push(() => target.removeEventListener(type, listener, options));
  }

  private bindButtons(): void {
    this.listen(this.elements.primaryButton, 'click', () => {
      void this.requestLandscape();
    });
    this.listen(this.elements.dismissButton, 'click', () => {
      this.callbacks.onUserGesture?.();
      this.dismissedForCurrentPortrait = true;
      this.refresh();
    });
    for (const button of this.elements.fullscreenButtons) {
      this.listen(button, 'click', () => {
        void this.toggleFullscreen();
      });
    }
  }

  private bindViewportListeners(): void {
    const refresh = (): void => {
      this.refresh();
      this.syncFullscreenButtons();
    };
    this.listen(this.windowTarget, 'resize', refresh);
    this.listen(this.windowTarget, 'orientationchange', refresh);
    this.listen(this.windowTarget?.visualViewport, 'resize', refresh);
    this.listen(this.documentTarget, 'fullscreenchange', refresh);

    const orientation = this.windowTarget?.screen?.orientation as
      | ScreenOrientationWithLock
      | undefined;
    this.listen(orientation, 'change', refresh);

    try {
      const portraitQuery = this.windowTarget?.matchMedia?.('(orientation: portrait)');
      if (portraitQuery && typeof portraitQuery.addEventListener === 'function') {
        this.listen(portraitQuery, 'change', refresh);
      }
    } catch {
      // Resize/orientationchange remain as fallbacks.
    }
  }

  private bindKeyboardAndGestureGuards(): void {
    this.listen(this.documentTarget, 'focusin', (event) => {
      const target = event.target;
      if (shouldBlurTextEntry(target, this.isGameplayActive())) {
        (target as StructuralElement | null)?.blur?.();
      }
    });

    const preventGesture = (event: Event): void => {
      if (this.isGameplayActive()) event.preventDefault();
    };
    // Safari's proprietary pinch gestures are not controlled by Pointer
    // Events. Scope this to active gameplay so lobby/settings zoom remains
    // available to the browser/user where supported.
    this.listen(this.documentTarget, 'gesturestart', preventGesture, {
      passive: false,
    });
    this.listen(this.documentTarget, 'gesturechange', preventGesture, {
      passive: false,
    });

    this.listen(
      this.documentTarget,
      'touchmove',
      (event) => {
        if (!this.isGameplayActive()) return;
        const target = event.target as StructuralElement | null;
        try {
          if (target?.closest?.('[data-allow-game-keyboard="true"]')) return;
        } catch {
          // Continue with the gameplay scroll guard.
        }
        event.preventDefault();
      },
      { passive: false }
    );
  }
}
