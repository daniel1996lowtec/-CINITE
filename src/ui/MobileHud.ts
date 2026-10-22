/** Presentation preferences only. No account, protocol or gameplay state is stored. */
export interface MobileHudPreferences {
  buttonSize: number;
  hudScale: number;
  sensitivity: number;
  advancedBuild: boolean;
  reducedMotion: boolean;
}
export const MOBILE_HUD_KEY = 'ci_craft_mobile_hud_v1';
export const DEFAULT_MOBILE_HUD: Readonly<MobileHudPreferences> = {
  buttonSize: 1, hudScale: 1, sensitivity: 1, advancedBuild: false, reducedMotion: false,
};
export function normalizeMobileHud(value: unknown): MobileHudPreferences {
  const v = value && typeof value === 'object' ? value as Partial<MobileHudPreferences> : {};
  const number = (n: unknown, min: number, max: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(min,Math.min(max,n)) : 1;
  return { buttonSize:number(v.buttonSize,.85,1.15), hudScale:number(v.hudScale,.9,1.1),
    sensitivity:number(v.sensitivity,.3,2.5), advancedBuild:v.advancedBuild === true, reducedMotion:v.reducedMotion === true };
}

export class MobileHud {
  private preferences: MobileHudPreferences = {...DEFAULT_MOBILE_HUD};
  private readonly disposers: Array<() => void> = [];
  private readonly panel: HTMLElement | null;
  private readonly secondary: HTMLElement | null;
  private readonly toggle: HTMLElement | null;
  private readonly doc: Document;
  private readonly onSensitivity: (value: number) => void;
  private lastSensitivity = Number.NaN;
  private readonly onReducedMotion: (value: boolean) => void;
  private lastReducedMotion: boolean | undefined;
  constructor(doc: Document, onSensitivity: (value: number) => void, onReducedMotion: (value: boolean) => void = () => {}) {
    this.doc = doc;
    this.onReducedMotion = onReducedMotion;
    this.onSensitivity = onSensitivity;
    this.panel = doc.getElementById('touch-build-panel');
    this.secondary = doc.getElementById('touch-secondary-actions');
    this.toggle = doc.getElementById('touch-build-toggle-btn');
    this.preferences.reducedMotion = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    try {
      const saved: unknown = JSON.parse(doc.defaultView?.localStorage.getItem(MOBILE_HUD_KEY) || '{}');
      const normalized = normalizeMobileHud(saved);
      if (!saved || typeof saved !== 'object' || !('reducedMotion' in saved)) normalized.reducedMotion = this.preferences.reducedMotion;
      this.preferences = normalized;
    } catch { /* Denied storage / malformed JSON must never stop gameplay. */ }
    const bind = (id: string, event: string, action: () => void) => {
      const element = doc.getElementById(id);
      if (!element) return;
      const listener = (e: Event) => { e.stopPropagation(); action(); };
      element.addEventListener(event,listener);
      this.disposers.push(() => element.removeEventListener(event,listener));
    };
    // Like the gameplay controller, act on touch-down rather than waiting
    // for a compatibility click (which a simultaneous look/fire gesture can suppress).
    const panelButton = (id: string, action: () => void) => {
      const element = doc.getElementById(id);
      if (!element) return;
      let suppressClick = false;
      const down = (e: Event) => {
        const pointer = e as PointerEvent;
        suppressClick = pointer.pointerType !== 'mouse';
        if (suppressClick) { e.preventDefault(); e.stopPropagation(); action(); }
      };
      const click = (e: Event) => {
        e.stopPropagation();
        if ((e as MouseEvent).detail === 0 || !suppressClick) action();
        suppressClick = false;
      };
      const eventName = doc.defaultView && 'PointerEvent' in doc.defaultView ? 'pointerdown' : 'touchstart';
      element.addEventListener(eventName,down,{passive:false});
      element.addEventListener('click',click);
      this.disposers.push(() => { element.removeEventListener(eventName,down); element.removeEventListener('click',click); });
    };
    panelButton('touch-build-toggle-btn',() => this.setBuildOpen(this.panel?.hidden ?? true));
    panelButton('touch-build-close-btn',() => this.setBuildOpen(false));
    for (const [id,key] of [
      ['setting-mobile-button-size','buttonSize'], ['setting-mobile-hud-scale','hudScale'],
      ['setting-touch-sensitivity','sensitivity'],
    ] as const) bind(id,'input',() => {
      const input = doc.getElementById(id) as HTMLInputElement;
      this.preferences = normalizeMobileHud({...this.preferences,[key]:Number(input.value)});
      this.apply(); this.save();
    });
    bind('setting-mobile-advanced-build','change',() => {
      this.preferences.advancedBuild = (doc.getElementById('setting-mobile-advanced-build') as HTMLInputElement).checked;
      this.resetPanel(); this.save();
    });
    bind('setting-reduced-motion','change',() => {
      this.preferences.reducedMotion = (doc.getElementById('setting-reduced-motion') as HTMLInputElement).checked;
      this.apply(); this.save();
    });
    bind('btn-reset-mobile-hud','click',() => {
      this.preferences = {...DEFAULT_MOBILE_HUD, reducedMotion:doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false}; this.apply(); this.resetPanel(); this.save();
    });
    this.apply(); this.resetPanel();
  }
  private apply(): void {
    this.doc.documentElement.style.setProperty('--mobile-button-scale',String(this.preferences.buttonSize));
    this.doc.documentElement.style.setProperty('--mobile-info-scale',String(this.preferences.hudScale));
    for (const [id,key,label] of [
      ['setting-mobile-button-size','buttonSize','val-mobile-button-size'],
      ['setting-mobile-hud-scale','hudScale','val-mobile-hud-scale'],
      ['setting-touch-sensitivity','sensitivity','val-touch-sensitivity'],
    ] as const) {
      const input = this.doc.getElementById(id) as HTMLInputElement | null;
      if (input) input.value = String(this.preferences[key]);
      const output = this.doc.getElementById(label);
      if (output) output.textContent = key === 'sensitivity'
        ? `${this.preferences[key].toFixed(1)}x` : `${Math.round(this.preferences[key]*100)}%`;
    }
    const advanced = this.doc.getElementById('setting-mobile-advanced-build') as HTMLInputElement | null;
    if (advanced) advanced.checked = this.preferences.advancedBuild;
    const reduced = this.doc.getElementById('setting-reduced-motion') as HTMLInputElement | null;
    if (reduced) reduced.checked = this.preferences.reducedMotion;
    if (this.lastReducedMotion !== this.preferences.reducedMotion) {
      this.lastReducedMotion = this.preferences.reducedMotion;
      this.onReducedMotion(this.preferences.reducedMotion);
    }
    if (this.lastSensitivity !== this.preferences.sensitivity) {
      this.lastSensitivity = this.preferences.sensitivity;
      this.onSensitivity(this.preferences.sensitivity);
    }
  }
  private save(): void {
    try { this.doc.defaultView?.localStorage.setItem(MOBILE_HUD_KEY,JSON.stringify(this.preferences)); }
    catch { /* Quota/private-mode failure leaves working in-memory settings. */ }
  }
  public setBuildOpen(open: boolean): void {
    if (this.panel) this.panel.hidden = !open;
    if (this.secondary) this.secondary.hidden = open;
    this.toggle?.setAttribute('aria-expanded',String(open));
    this.toggle?.classList.toggle('is-active',open);
    if (this.toggle) this.toggle.textContent = open ? 'BUILD ▾' : 'BUILD ▸';
  }
  public resetPanel(): void { this.setBuildOpen(this.preferences.advancedBuild); }
  public destroy(): void { for (const dispose of this.disposers.splice(0)) dispose(); }
}
