/** Reorganizes the existing controls, never creates a parallel/demo lobby. */
export class MenuShell {
  private readonly root: HTMLElement;
  private readonly dispose: Array<() => void> = [];
  constructor(private readonly doc: Document) {
    this.root = doc.getElementById('lobby-overlay')!;
    const move = (id: string, destination: string) => {
      const node = doc.getElementById(id);
      if (node) doc.getElementById(destination)?.append(node);
    };
    const nameGroup = doc.getElementById('lobby-player-name')!.closest('.form-group')!;
    doc.getElementById('menu-profile')!.prepend(nameGroup);
    for (const id of ['btn-open-locker', 'btn-open-howto', 'btn-open-settings-lobby']) move(id, 'menu-utilities');
    move('lobby-career-strip', 'menu-account');
    // The existing detailed showcase and its rotation controls live in Locker.
    move('lobby-preview-dock', 'locker-overlay');
    const guide = this.root.querySelector('.controls-guide');
    if (guide) doc.querySelector('#howto-overlay .end-card')?.append(guide);
    const resize = () => {
      const view = doc.defaultView!;
      const vv = view.visualViewport;
      doc.documentElement.style.setProperty('--menu-height', `${vv?.height ?? view.innerHeight}px`);
      doc.documentElement.style.setProperty('--menu-top', `${vv?.offsetTop ?? 0}px`);
    };
    const view = doc.defaultView!;
    for (const target of [view, view.visualViewport]) {
      if (!target) continue;
      target.addEventListener('resize', resize);
      target.addEventListener('scroll', resize);
      this.dispose.push(() => { target.removeEventListener('resize', resize); target.removeEventListener('scroll', resize); });
    }
    for (const button of doc.querySelectorAll<HTMLButtonElement>('[data-menu-close]')) {
      const close = () => doc.getElementById(button.dataset.menuClose!)?.click();
      button.addEventListener('click', close); this.dispose.push(() => button.removeEventListener('click', close));
    }
    resize();
  }
  public show(section: 'home' | 'solo' | 'multiplayer' | 'account'): void {
    this.root.dataset.menuSection = section;
    this.doc.getElementById('menu-section-title')!.textContent = {
      home: 'Choose your next drop', solo: 'Single Mode', multiplayer: 'Multiplayer', account: 'Career & account',
    }[section];
    this.doc.getElementById('menu-back')!.hidden = section === 'home';
    this.doc.getElementById('menu-account')!.hidden = section !== 'account';
    this.doc.querySelector('#lobby-overlay > .lobby-card')!.scrollTop = 0;
  }
  public destroy(): void { for (const dispose of this.dispose.splice(0)) dispose(); }
}
