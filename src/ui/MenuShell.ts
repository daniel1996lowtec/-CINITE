import type { GameModeChoice } from '../network/schemas';
import {
  DEFAULT_GAME_MODE,
  gameModeLabel,
  normalizeGameMode,
} from '../../shared/matchRules.mjs';

/** Reorganizes the existing controls, never creates a parallel/demo lobby. */
export class MenuShell {
  private readonly root: HTMLElement;
  private readonly dispose: Array<() => void> = [];
  public selectedGameMode: GameModeChoice = DEFAULT_GAME_MODE;
  public onGameModeChange?: (mode: GameModeChoice) => void;

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

    // Wire the three primary game-mode choices (Battle Royale, Free for All, Team Deathmatch)
    for (const btn of doc.querySelectorAll<HTMLButtonElement>('[data-game-mode]')) {
      const onClick = () => {
        const mode = normalizeGameMode(btn.dataset.gameMode);
        this.setGameMode(mode);
      };
      btn.addEventListener('click', onClick);
      this.dispose.push(() => btn.removeEventListener('click', onClick));
    }

    const soloSelect = doc.getElementById('solo-game-mode-select') as HTMLSelectElement | null;
    if (soloSelect) {
      const onSoloChange = () => {
        this.setGameMode(normalizeGameMode(soloSelect.value));
      };
      soloSelect.addEventListener('change', onSoloChange);
      this.dispose.push(() => soloSelect.removeEventListener('change', onSoloChange));
    }

    const createSelect = doc.getElementById('create-lobby-game-mode') as HTMLSelectElement | null;
    if (createSelect) {
      const onCreateChange = () => {
        this.setGameMode(normalizeGameMode(createSelect.value), false);
      };
      createSelect.addEventListener('change', onCreateChange);
      this.dispose.push(() => createSelect.removeEventListener('change', onCreateChange));
    }

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
    this.setGameMode(DEFAULT_GAME_MODE, false);
    resize();
  }

  public setGameMode(mode: GameModeChoice, syncCreateLobby = true): void {
    const normalized = normalizeGameMode(mode);
    this.selectedGameMode = normalized;

    const hiddenInput = this.doc.getElementById('selected-game-mode') as HTMLInputElement | null;
    if (hiddenInput) hiddenInput.value = normalized;

    for (const btn of this.doc.querySelectorAll<HTMLButtonElement>('[data-game-mode]')) {
      const isSelected = normalizeGameMode(btn.dataset.gameMode) === normalized;
      btn.classList.toggle('active', isSelected);
      btn.setAttribute('aria-checked', String(isSelected));
    }

    const soloSelect = this.doc.getElementById('solo-game-mode-select') as HTMLSelectElement | null;
    if (soloSelect && soloSelect.value !== normalized) {
      soloSelect.value = normalized;
    }

    if (syncCreateLobby) {
      const createSelect = this.doc.getElementById('create-lobby-game-mode') as HTMLSelectElement | null;
      if (createSelect && createSelect.value !== normalized) {
        createSelect.value = normalized;
        createSelect.dispatchEvent(new Event('change'));
      }
    }

    const skydropRow = this.doc.getElementById('lobby-skydrop')?.closest('.deployment-preference') as HTMLElement | null;
    if (skydropRow) {
      skydropRow.style.display = normalized === 'battle_royale' ? '' : 'none';
    }

    const launchBtn = this.doc.getElementById('btn-launch-match');
    if (launchBtn) {
      launchBtn.textContent =
        normalized === 'free_for_all'
          ? '⚔️ LAUNCH FREE FOR ALL'
          : normalized === 'team_deathmatch'
            ? '🛡️ LAUNCH TEAM DEATHMATCH'
            : '🚀 DROP INTO ISLAND';
    }

    if (this.root.dataset.menuSection === 'solo') {
      const titleEl = this.doc.getElementById('menu-section-title');
      if (titleEl) {
        titleEl.textContent = `Single Mode · ${gameModeLabel(normalized)}`;
      }
    }

    this.onGameModeChange?.(normalized);
  }

  public show(section: 'home' | 'solo' | 'multiplayer' | 'account'): void {
    this.root.dataset.menuSection = section;
    this.doc.getElementById('menu-section-title')!.textContent = {
      home: 'Choose your game mode',
      solo: `Single Mode · ${gameModeLabel(this.selectedGameMode)}`,
      multiplayer: 'Multiplayer',
      account: 'Career & account',
    }[section];
    this.doc.getElementById('menu-back')!.hidden = section === 'home';
    this.doc.getElementById('menu-account')!.hidden = section !== 'account';
    this.doc.querySelector('#lobby-overlay > .lobby-card')!.scrollTop = 0;
  }
  public destroy(): void { for (const dispose of this.dispose.splice(0)) dispose(); }
}
