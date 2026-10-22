import type { ChatEvent, RoomTextChat } from '../network/RoomTextChat';

/** Compact, text-only lobby UI. Owns exactly one subscription and bounded DOM. */
export class TextChat {
  private readonly root: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly unreadBadge: HTMLElement;
  private readonly disposers: Array<() => void> = [];
  private unread = 0;
  private openState = false;
  private destroyed = false;
  private connected = false;
  private position: { x: number; y: number } | null = null;
  private drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
  private readonly positionKey = 'ci-craft-chat-position-v1';

  constructor(private readonly doc: Document, channel: RoomTextChat,
    private readonly send: (text: string) => boolean,
    private readonly releaseGameplayInput: () => void,
    private readonly isOnline: () => boolean = () => false) {
    this.root = doc.getElementById('text-chat')!;
    this.toggle = doc.getElementById('chat-toggle') as HTMLButtonElement;
    this.panel = doc.getElementById('chat-panel')!;
    this.log = doc.getElementById('chat-log')!;
    this.input = doc.getElementById('chat-input') as HTMLInputElement;
    this.status = doc.getElementById('chat-status')!;
    this.unreadBadge = doc.getElementById('chat-unread')!;
    try {
      const saved = JSON.parse(doc.defaultView?.localStorage.getItem(this.positionKey) || 'null');
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && saved.x >= 0 && saved.x <= 1 && saved.y >= 0 && saved.y <= 1) this.position = saved;
    } catch { /* Private browsing/storage failures use a session-only position. */ }
    this.bindDrag();
    this.listen(this.toggle, 'click', () => this.openState ? this.close() : this.open());
    this.listen(this.input, 'focus', () => this.releaseGameplayInput());
    this.listen(this.root, 'keydown', event => {
      const e = event as KeyboardEvent;
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      if (e.key === 'Enter') {
        e.preventDefault(); // No implicit form submission from another focused control.
        if (this.doc.activeElement === this.input && !e.repeat) this.submit();
        else if (!e.repeat && (this.doc.activeElement === this.toggle || this.doc.activeElement?.id === 'chat-reset')) (this.doc.activeElement as HTMLButtonElement).click();
      }
    });
    this.listen(this.root, 'wheel', e => e.stopPropagation());
    this.listen(this.root, 'pointerdown', e => e.stopPropagation());
    this.listen(doc.getElementById('chat-form')!, 'submit', e => e.preventDefault());
    this.listen(doc.getElementById('chat-send')!, 'click', () => this.submit());
    const updateViewport = () => this.syncGameView();
    if (doc.defaultView) {
      this.listen(doc.defaultView, 'resize', updateViewport);
      this.listen(doc.defaultView, 'blur', () => this.endDrag());
    }
    if (doc.defaultView?.visualViewport) { this.listen(doc.defaultView.visualViewport, 'resize', updateViewport); this.listen(doc.defaultView.visualViewport, 'scroll', updateViewport); }
    // HUD visibility changes when the REAL game starts/ends, independently of
    // room_joined (Solo never receives that packet). No render-loop polling.
    const hud = doc.getElementById('hud-overlay');
    if (hud) {
      const observer = new MutationObserver(updateViewport);
      observer.observe(hud, {attributes: true, attributeFilter: ['class', 'hidden']});
      this.disposers.push(() => observer.disconnect());
    }
    const menu = doc.getElementById('lobby-overlay');
    if (menu) {
      const observer = new MutationObserver(updateViewport);
      observer.observe(menu, { attributes: true, attributeFilter: ['class', 'data-menu-section'] });
      this.disposers.push(() => observer.disconnect());
    }
    const header = doc.querySelector('.hud-top-left');
    if (header) {
      const observer = new ResizeObserver(updateViewport);
      observer.observe(header);
      this.disposers.push(() => observer.disconnect());
    }
    const panelObserver = new ResizeObserver(() => this.place());
    panelObserver.observe(this.root);
    this.disposers.push(() => panelObserver.disconnect());
    updateViewport();
    this.disposers.push(channel.subscribe(event => this.receive(event)));
  }

  private syncGameView(): void {
    if (this.destroyed) return;
    const hud = this.doc.getElementById('hud-overlay');
    const inGame = !!hud && !hud.hidden && !hud.classList.contains('hidden');
    // Availability gates sending, NOT discovery of the in-game chat control.
    const menu = this.doc.getElementById('lobby-overlay');
    const inLobby = !!menu && !menu.classList.contains('hidden') && menu.dataset.menuSection === 'multiplayer';
    this.root.hidden = !inGame && !(this.connected && inLobby);
    this.root.dataset.chatState = this.connected ? 'connected' : 'offline';
    this.input.disabled = !this.connected;
    (this.doc.getElementById('chat-send') as HTMLButtonElement).disabled = !this.connected;
    if (!this.connected) this.status.textContent = this.isOnline()
      ? 'Lobby connection unavailable. Waiting to reconnect.'
      : 'Join a multiplayer lobby to chat. Solo has no recipients.';
    const view = this.doc.defaultView;
    const height = view?.visualViewport?.height ?? view?.innerHeight ?? 600;
    this.root.style.setProperty('--chat-viewport-height', `${height}px`);
    this.root.style.setProperty('--chat-anchor-top', `${height < 260 ? 8 : 80}px`);
    this.root.style.setProperty('--chat-bottom-clearance', height < 260 ? '8px' : '76px');
    const header = this.doc.querySelector('.hud-top-left')?.getBoundingClientRect();
    const minimap = this.doc.querySelector('.minimap-wrapper')?.getBoundingClientRect();
    if (inGame && header && minimap) {
      const coarse = view?.matchMedia('(pointer: coarse)').matches;
      // On short phones BUILD sits beneath the storm banner: put CHAT just
      // to its right, but below the minimap. Desktop has room below the header.
      this.root.style.setProperty('--chat-anchor-left', `${coarse ? header.right + 8 : header.left}px`);
      this.root.style.setProperty('--chat-left', `${coarse ? header.right + 8 : header.left}px`);
      this.root.style.setProperty('--chat-top', `${height < 260 ? 8 : (coarse ? minimap.bottom : header.bottom) + 8}px`);
    } else {
      this.root.style.removeProperty('--chat-anchor-left');
      this.root.style.removeProperty('--chat-left');
      this.root.style.removeProperty('--chat-top');
      if (inLobby && !this.root.hidden) {
        this.root.style.setProperty('--chat-left', `${(view?.visualViewport?.width ?? view?.innerWidth ?? 800) - this.root.offsetWidth - 8}px`);
        this.root.style.setProperty('--chat-top', `${height - this.root.offsetHeight - 8}px`);
      }
    }
    this.place();
  }

  private bounds(): { left: number; top: number; dx: number; dy: number } {
    const view = this.doc.defaultView!; const vv = view.visualViewport;
    const style = view.getComputedStyle(this.root);
    const inset = (value: string) => Number.parseFloat(value) || 8;
    const left = (vv?.offsetLeft || 0) + inset(style.scrollPaddingLeft);
    const top = (vv?.offsetTop || 0) + inset(style.scrollPaddingTop);
    const rect = this.root.getBoundingClientRect();
    return { left, top,
      dx: Math.max(0, (vv?.width ?? view.innerWidth) - inset(style.scrollPaddingLeft) - inset(style.scrollPaddingRight) - rect.width),
      dy: Math.max(0, (vv?.height ?? view.innerHeight) - inset(style.scrollPaddingTop) - inset(style.scrollPaddingBottom) - rect.height) };
  }
  private place(left?: number, top?: number, remember = false): void {
    if (this.root.hidden || this.destroyed) return;
    const b = this.bounds(); const rect = this.root.getBoundingClientRect();
    const x = Math.max(b.left, Math.min(b.left + b.dx, left ?? (this.position ? b.left + this.position.x * b.dx : rect.left)));
    const y = Math.max(b.top, Math.min(b.top + b.dy, top ?? (this.position ? b.top + this.position.y * b.dy : rect.top)));
    this.root.style.setProperty('--chat-left', `${x}px`);
    this.root.style.setProperty('--chat-top', `${y}px`);
    if (remember) {
      this.position = { x: b.dx ? (x - b.left) / b.dx : 0, y: b.dy ? (y - b.top) / b.dy : 0 };
    }
  }
  private savePosition(): void {
    try { this.doc.defaultView?.localStorage.setItem(this.positionKey, JSON.stringify(this.position)); } catch { /* Session fallback. */ }
  }
  private endDrag(): void {
    if (!this.drag) return;
    const id = this.drag.id; this.drag = null; this.savePosition();
    const handle = this.doc.getElementById('chat-drag')!;
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
  }
  private bindDrag(): void {
    const handle = this.doc.getElementById('chat-drag')!;
    this.listen(handle, 'pointerdown', event => {
      const e = event as PointerEvent;
      if (this.drag || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const rect = this.root.getBoundingClientRect();
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      handle.setPointerCapture(e.pointerId);
    });
    this.listen(handle, 'pointermove', event => {
      const e = event as PointerEvent;
      if (!this.drag || e.pointerId !== this.drag.id) return;
      e.preventDefault(); e.stopPropagation();
      this.place(this.drag.left + e.clientX - this.drag.x, this.drag.top + e.clientY - this.drag.y, true);
    });
    const finish = (event: Event) => {
      const e = event as PointerEvent;
      if (this.drag?.id !== e.pointerId) return;
      this.endDrag();
    };
    for (const type of ['pointerup','pointercancel','lostpointercapture']) this.listen(handle, type, finish);
    this.listen(handle, 'keydown', event => {
      const e = event as KeyboardEvent;
      const delta: Record<string, [number, number]> = { ArrowLeft: [-12,0], ArrowRight: [12,0], ArrowUp: [0,-12], ArrowDown: [0,12] };
      if (!delta[e.key]) return;
      e.preventDefault(); e.stopPropagation();
      const r = this.root.getBoundingClientRect(); this.place(r.left + delta[e.key][0], r.top + delta[e.key][1], true); this.savePosition();
    });
    this.listen(this.doc.getElementById('chat-reset')!, 'click', () => {
      this.endDrag(); this.position = null;
      try { this.doc.defaultView?.localStorage.removeItem(this.positionKey); } catch { /* Session fallback. */ }
      this.syncGameView();
    });
  }

  private listen(target: EventTarget, type: string, listener: (event: Event) => void): void {
    target.addEventListener(type, listener);
    this.disposers.push(() => target.removeEventListener(type, listener));
  }
  public ownsTarget(target: EventTarget | null): boolean {
    return target instanceof Node && this.root.contains(target);
  }
  public isTyping(): boolean { return this.doc.activeElement === this.input; }
  public open(focusInput = false): void {
    if (this.destroyed || this.root.hidden) return;
    this.openState = true; this.panel.hidden = false; this.root.dataset.open = 'true';
    this.syncGameView();
    this.toggle.setAttribute('aria-expanded', 'true');
    this.unread = 0; this.updateUnread();
    this.log.scrollTop = this.log.scrollHeight;
    if (focusInput) this.input.focus();
  }
  public close(): void {
    this.endDrag();
    this.openState = false; this.panel.hidden = true; this.root.dataset.open = 'false';
    this.syncGameView();
    this.toggle.setAttribute('aria-expanded', 'false');
    const active = this.doc.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
  }
  private updateUnread(): void {
    this.unreadBadge.textContent = this.unread > 99 ? '99+' : String(this.unread);
    this.unreadBadge.hidden = this.unread === 0;
    this.toggle.setAttribute('aria-label', `Lobby text chat${this.unread ? `, ${this.unread} unread` : ''}`);
  }
  private submit(): void {
    if (this.destroyed || this.root.hidden || !this.openState || !this.connected) return;
    const text = this.input.value.trim();
    if (!text || text.length > 240 || /[\u0000-\u001f\u007f-\u009f\u200b\u2028-\u202e\u2066-\u2069\ufeff]/u.test(text)) {
      this.status.textContent = 'Use 1–240 characters on one line.'; return;
    }
    if (!this.send(text)) { this.status.textContent = 'Not connected to a lobby.'; return; }
    this.input.value = ''; this.status.textContent = '';
    // No optimistic echo: only the authoritative broadcast adds a message.
  }
  private receive(event: ChatEvent): void {
    if (event.type === 'state') {
      this.connected = !!event.roomCode;
      this.log.replaceChildren(); this.input.value = ''; this.status.textContent = '';
      this.unread = 0; this.updateUnread();
      this.syncGameView();
      if (this.root.hidden) this.close();
    } else if (event.type === 'error') {
      this.status.textContent = event.reason;
    } else {
      const row = this.doc.createElement('li');
      const name = this.doc.createElement('strong');
      // Context-safe escaping: never interpolate either string into HTML.
      name.textContent = `${event.message.senderName}: `;
      const text = this.doc.createElement('span'); text.textContent = event.message.text;
      row.append(name, text); this.log.append(row);
      while (this.log.children.length > 100) this.log.firstElementChild?.remove();
      if (this.openState) this.log.scrollTop = this.log.scrollHeight;
      else { this.unread = Math.min(100, this.unread + 1); this.updateUnread(); }
    }
  }
  public destroy(): void {
    if (this.destroyed) return;
    const handle = this.doc.getElementById('chat-drag');
    if (this.drag && handle?.hasPointerCapture(this.drag.id)) handle.releasePointerCapture(this.drag.id);
    this.drag = null;
    this.close(); this.root.hidden = true; this.log.replaceChildren(); this.input.value = '';
    for (const dispose of this.disposers.splice(0)) dispose();
    this.destroyed = true;
  }
}
