import type {
  BotDifficulty,
  CreateLobbyRequest,
  LobbyStartCondition,
  LobbySummary,
  RoomSnapshot,
  TeamMode,
} from '../network/schemas';
import {
  DEFAULT_LOBBY_FILTERS,
  connectionQualityLabel,
  createLobbyInviteUrl,
  filterAndSortLobbies,
  getLobbyJoinBlock,
  lobbyStatusLabel,
  startConditionLabel,
  teamModeLabel,
  type LobbyBrowserFilters,
  type LobbyBrowserSort,
} from '../network/lobbyBrowserUtils';
import type { LobbyDirectoryConnectionState } from '../network/LobbyBrowserClient';
import { OUTFIT_PRESETS } from '../systems/ProgressionSystem';

export type LobbyBrowserTab = 'browse' | 'create' | 'mine';

export interface LobbyBrowserCallbacks {
  onTabChange: (tab: LobbyBrowserTab) => void;
  onRefresh: () => void;
  onJoinLobby: (lobby: LobbySummary, password: string) => void;
  onJoinByCode: (roomCode: string, password: string) => void;
  onCreateLobby: (request: CreateLobbyRequest) => void;
  onReadyToggle: (ready: boolean) => void;
  onStartMatch: () => void;
  onLeaveLobby: () => void;
  onCloseLobby: () => void;
}

function element<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class LobbyBrowserUI {
  private readonly callbacks: LobbyBrowserCallbacks;
  private readonly root: HTMLElement | null;
  private lobbies: LobbySummary[] = [];
  private filters: LobbyBrowserFilters = { ...DEFAULT_LOBBY_FILTERS };
  private sort: LobbyBrowserSort = 'most_players';
  private pingMs: number | null = null;
  private snapshot: RoomSnapshot | null = null;
  private activeTab: LobbyBrowserTab = 'browse';
  private busy = false;
  private createNameEdited = false;
  private countdownTimer: number | null = null;
  private readonly cardPasswords = new Map<string, string>();
  private lastMyLobbySignature = '';

  public constructor(callbacks: LobbyBrowserCallbacks) {
    this.callbacks = callbacks;
    this.root = element<HTMLElement>('multiplayer-browser');
    if (!this.root) return;
    this.bindEvents();
    this.syncCreateDynamicControls();
    this.renderAll();
    this.countdownTimer = window.setInterval(() => {
      if (this.snapshot?.phase === 'countdown') this.renderMyLobby();
    }, 500);
  }

  public destroy(): void {
    if (this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  public setVisible(visible: boolean): void {
    this.root?.classList.toggle('hidden', !visible);
    if (visible) this.renderAll();
  }

  public setTab(tab: LobbyBrowserTab): void {
    this.activeTab = tab;
    document
      .querySelectorAll<HTMLButtonElement>('.lobby-browser-tab')
      .forEach((button) => {
        const isActive = button.dataset.lobbyTab === tab;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
    element('lobby-tab-browse')?.classList.toggle('hidden', tab !== 'browse');
    element('lobby-tab-create')?.classList.toggle('hidden', tab !== 'create');
    element('lobby-tab-mine')?.classList.toggle('hidden', tab !== 'mine');
    this.callbacks.onTabChange(tab);
  }

  public getActiveTab(): LobbyBrowserTab {
    return this.activeTab;
  }

  public setLobbies(lobbies: LobbySummary[]): void {
    this.lobbies = lobbies;
    this.renderCards();
  }

  public setPing(pingMs: number | null): void {
    const hadPing = this.pingMs !== null;
    this.pingMs = pingMs;
    this.renderPing();
    if (this.sort === 'lowest_ping' || (!hadPing && pingMs !== null)) {
      this.renderCards();
    }
    if (this.snapshot) this.renderMyLobby();
  }

  public setDirectoryState(
    state: LobbyDirectoryConnectionState,
    message: string
  ): void {
    const el = element('lobby-directory-status');
    if (!el) return;
    const icon =
      state === 'live' ? '🟢' : state === 'polling' ? '🟡' : state === 'offline' ? '🔴' : '⏳';
    el.textContent = `${icon} ${message}`;
    el.className = `lobby-directory-status ${state}`;
  }

  public setCurrentSnapshot(snapshot: RoomSnapshot | null): void {
    const previousRoomCode = this.snapshot?.roomCode || '';
    const previous = this.snapshot;
    if (snapshot && previous?.roomCode === snapshot.roomCode) {
      const events: string[] = [];
      for (const player of snapshot.players) {
        const old = previous.players.find(p => p.id === player.id);
        if (player.isConnected && (!old || !old.isConnected)) events.push(`${player.name} joined`);
        else if (old?.isReady !== player.isReady && snapshot.phase === 'lobby')
          events.push(`${player.name} ${player.isReady ? 'is ready' : 'is not ready'}`);
        if (old?.isConnected && !player.isConnected) events.push(`${player.name} disconnected`);
      }
      for (const player of previous.players) {
        if (!snapshot.players.some(p => p.id === player.id)) events.push(`${player.name} left`);
      }
      if (previous.phase !== snapshot.phase) events.push(snapshot.phase === 'countdown'
        ? 'Squad locked — match starting' : snapshot.phase === 'active' ? 'Match live — good luck'
        : snapshot.phase === 'ended' ? `Match complete · ${snapshot.winnerName || 'No winner'}` : 'Waiting for ready players');
      if (events.length) {
        const status = element('my-lobby-event');
        if (status) status.textContent = events.slice(-2).join(' · ');
      }
    } else {
      const status = element('my-lobby-event');
      if (status) status.textContent = snapshot ? 'Connected to the live human roster' : '';
    }
    this.snapshot = snapshot;
    this.renderMyLobby();
    // Room state arrives at 20 Hz during a match. Cards only depend on
    // which room (if any) is current, so avoid rebuilding them every tick.
    if (previousRoomCode !== (snapshot?.roomCode || '')) this.renderCards();
    if (snapshot && previousRoomCode !== snapshot.roomCode) {
      const createPassword = element<HTMLInputElement>('create-lobby-password');
      if (createPassword) createPassword.value = '';
      const joinPassword = element<HTMLInputElement>('lobby-join-password');
      if (joinPassword) joinPassword.value = '';
      this.cardPasswords.delete(snapshot.roomCode);
    }
    const createButton = element<HTMLButtonElement>('btn-create-lobby-submit');
    if (createButton) createButton.disabled = this.busy || Boolean(snapshot);
    const myTab = document.querySelector<HTMLButtonElement>(
      '[data-lobby-tab="mine"]'
    );
    if (myTab) {
      myTab.textContent = snapshot ? `MY LOBBY • ${snapshot.roomCode}` : 'MY LOBBY';
    }
  }

  public setBusy(busy: boolean): void {
    this.busy = busy;
    this.renderAll();
  }

  public showMessage(message: string, isError = false): void {
    const el = element('lobby-browser-message');
    if (!el) return;
    el.textContent = message;
    el.className = `lobby-browser-message ${isError ? 'error' : 'success'}`;
    el.classList.toggle('hidden', message.trim().length === 0);
  }

  public setDefaultPlayerName(name: string): void {
    const input = element<HTMLInputElement>('create-lobby-name');
    if (!input || this.createNameEdited) return;
    input.placeholder = `${name.trim() || 'Commander_CI'}'s Lobby`;
  }

  public setJoinCode(roomCode: string): void {
    const input = element<HTMLInputElement>('lobby-join-code');
    if (input) input.value = roomCode.trim().toUpperCase();
  }

  public focusJoinPassword(): void {
    element<HTMLInputElement>('lobby-join-password')?.focus();
  }

  private bindEvents(): void {
    document
      .querySelectorAll<HTMLButtonElement>('.lobby-browser-tab')
      .forEach((button) => {
        button.addEventListener('click', () => {
          const tab = (button.dataset.lobbyTab || 'browse') as LobbyBrowserTab;
          this.setTab(tab);
        });
      });

    element<HTMLInputElement>('lobby-search-input')?.addEventListener('input', (event) => {
      this.filters.search = (event.target as HTMLInputElement).value;
      this.renderCards();
    });

    const bindSelect = (id: string, apply: (value: string) => void) => {
      element<HTMLSelectElement>(id)?.addEventListener('change', (event) => {
        apply((event.target as HTMLSelectElement).value);
        this.renderCards();
      });
    };

    bindSelect('lobby-filter-visibility', (value) => {
      this.filters.visibility =
        value === 'public' || value === 'private' ? value : 'all';
    });
    bindSelect('lobby-filter-match-type', (value) => {
      this.filters.matchType =
        value === 'human_only' || value === 'ai_fill' ? value : 'all';
      const checkbox = element<HTMLInputElement>('lobby-filter-human-only');
      if (checkbox) checkbox.checked = this.filters.matchType === 'human_only';
      this.filters.humanOnly = this.filters.matchType === 'human_only';
    });
    bindSelect('lobby-filter-format', (value) => {
      this.filters.teamMode =
        value === 'solo' || value === 'duo' || value === 'squad' ? value : 'all';
    });
    bindSelect('lobby-filter-slots', (value) => {
      this.filters.availability =
        value === 'open' || value === 'four_plus' || value === 'eight_plus'
          ? value
          : 'all';
    });
    bindSelect('lobby-filter-status', (value) => {
      this.filters.status =
        value === 'waiting' ||
        value === 'starting' ||
        value === 'in_game' ||
        value === 'full' ||
        value === 'ended' ||
        value === 'closed'
          ? value
          : 'all';
    });
    bindSelect('lobby-filter-map', (value) => {
      this.filters.mapId = value === 'ci_island' ? 'ci_island' : 'all';
    });
    bindSelect('lobby-sort-select', (value) => {
      this.sort =
        value === 'fewest_players' ||
        value === 'lowest_ping' ||
        value === 'newest' ||
        value === 'most_players'
          ? value
          : 'most_players';
    });

    element<HTMLInputElement>('lobby-filter-human-only')?.addEventListener('change', (event) => {
      const checked = (event.target as HTMLInputElement).checked;
      this.filters.humanOnly = checked;
      this.filters.matchType = checked ? 'human_only' : 'all';
      const select = element<HTMLSelectElement>('lobby-filter-match-type');
      if (select) select.value = checked ? 'human_only' : 'all';
      this.renderCards();
    });

    element('btn-refresh-lobbies')?.addEventListener('click', () => {
      this.callbacks.onRefresh();
    });
    element('btn-browser-create')?.addEventListener('click', () => this.setTab('create'));
    element('btn-empty-create-lobby')?.addEventListener('click', () => this.setTab('create'));

    element('btn-join-by-code')?.addEventListener('click', () => {
      const code = element<HTMLInputElement>('lobby-join-code')?.value.trim().toUpperCase() || '';
      const password = element<HTMLInputElement>('lobby-join-password')?.value || '';
      if (!code) {
        this.showMessage('Enter a room ID to join an existing lobby.', true);
        return;
      }
      this.callbacks.onJoinByCode(code, password);
    });
    element<HTMLInputElement>('lobby-join-code')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') element<HTMLButtonElement>('btn-join-by-code')?.click();
    });

    element<HTMLInputElement>('create-lobby-name')?.addEventListener('input', () => {
      this.createNameEdited = true;
    });
    element<HTMLSelectElement>('create-lobby-visibility')?.addEventListener('change', () => {
      this.syncCreateDynamicControls();
    });
    element<HTMLSelectElement>('create-lobby-fill')?.addEventListener('change', () => {
      this.syncCreateDynamicControls();
    });

    element('btn-create-lobby-submit')?.addEventListener('click', () => {
      const request = this.buildCreateRequest();
      if (request) this.callbacks.onCreateLobby(request);
    });

    element('btn-my-lobby-ready')?.addEventListener('click', () => {
      const self = this.getSelfPlayer();
      this.callbacks.onReadyToggle(!self?.isReady);
    });
    element('btn-my-lobby-start')?.addEventListener('click', () => {
      this.callbacks.onStartMatch();
    });
    element('btn-my-lobby-leave')?.addEventListener('click', () => {
      this.callbacks.onLeaveLobby();
    });
    element('btn-my-lobby-close')?.addEventListener('click', () => {
      this.callbacks.onCloseLobby();
    });
    element('btn-my-empty-browse')?.addEventListener('click', () => this.setTab('browse'));
    element('btn-my-empty-create')?.addEventListener('click', () => this.setTab('create'));
    element('btn-copy-my-lobby-code')?.addEventListener('click', () => {
      if (this.snapshot) void this.copyText(this.snapshot.roomCode, 'Room ID copied.');
    });
    element('btn-copy-my-lobby-invite')?.addEventListener('click', () => {
      if (this.snapshot) {
        void this.copyText(
          createLobbyInviteUrl(window.location.href, this.snapshot.roomCode),
          'Invite link copied.'
        );
      }
    });
  }

  private buildCreateRequest(): CreateLobbyRequest | null {
    const nameInput = element<HTMLInputElement>('create-lobby-name');
    const name = nameInput?.value.trim() || nameInput?.placeholder || 'CI Island Battle';
    if (name.length < 3) {
      this.showMessage('Lobby name must be at least 3 characters.', true);
      return null;
    }

    const visibility =
      element<HTMLSelectElement>('create-lobby-visibility')?.value === 'private'
        ? 'private'
        : 'public';
    const humanOnly = element<HTMLSelectElement>('create-lobby-fill')?.value !== 'ai';
    const maxRaw = Number(element<HTMLSelectElement>('create-lobby-max')?.value || 20);
    const maxPlayers = ([2, 4, 8, 16, 20] as const).includes(maxRaw as 2)
      ? (maxRaw as 2 | 4 | 8 | 16 | 20)
      : 20;
    const formatRaw = element<HTMLSelectElement>('create-lobby-format')?.value;
    const teamMode: TeamMode =
      formatRaw === 'duo' || formatRaw === 'squad' ? formatRaw : 'solo';
    if (!humanOnly && teamMode !== 'solo') {
      this.showMessage('Duo and Squad require Human Players Only. AI Fill uses Solo format.', true);
      return null;
    }

    const password =
      visibility === 'private'
        ? element<HTMLInputElement>('create-lobby-password')?.value || ''
        : '';
    if (password && (password.length < 4 || password.length > 32)) {
      this.showMessage('Private lobby passwords must be 4–32 characters.', true);
      return null;
    }

    const startRaw = element<HTMLSelectElement>('create-lobby-start')?.value;
    const startCondition: LobbyStartCondition =
      startRaw === 'host_start' || startRaw === 'fill_lobby' ? startRaw : 'all_ready';
    const difficultyRaw = element<HTMLSelectElement>('create-lobby-bot-difficulty')?.value;
    const botDifficulty: BotDifficulty =
      difficultyRaw === 'easy' || difficultyRaw === 'hard' ? difficultyRaw : 'medium';

    return {
      name,
      visibility,
      humanOnly,
      maxPlayers,
      mapId: 'ci_island',
      teamMode,
      botCount: humanOnly
        ? 0
        : Math.max(0, Math.min(19, Number(element<HTMLSelectElement>('create-lobby-bot-count')?.value || 14))),
      botDifficulty,
      startCondition,
      password: password || undefined,
      allowLateJoin: false,
    };
  }

  private syncCreateDynamicControls(): void {
    const visibility = element<HTMLSelectElement>('create-lobby-visibility')?.value;
    const humanOnly = element<HTMLSelectElement>('create-lobby-fill')?.value !== 'ai';
    element('create-lobby-password-row')?.classList.toggle('hidden', visibility !== 'private');
    element('create-lobby-bot-row')?.classList.toggle('hidden', humanOnly);
    element('create-lobby-human-note')?.classList.toggle('hidden', !humanOnly);
    element('create-lobby-ai-note')?.classList.toggle('hidden', humanOnly);

    const botCount = element<HTMLSelectElement>('create-lobby-bot-count');
    if (botCount) botCount.disabled = humanOnly;
    const password = element<HTMLInputElement>('create-lobby-password');
    if (password) password.disabled = visibility !== 'private';

    const format = element<HTMLSelectElement>('create-lobby-format');
    if (format) {
      Array.from(format.options).forEach((option) => {
        if (option.value === 'duo' || option.value === 'squad') {
          option.disabled = !humanOnly;
        }
      });
      if (!humanOnly && format.value !== 'solo') format.value = 'solo';
    }
  }

  private renderAll(): void {
    this.renderPing();
    this.renderCards();
    this.renderMyLobby();
    const createButton = element<HTMLButtonElement>('btn-create-lobby-submit');
    if (createButton) createButton.disabled = this.busy || Boolean(this.snapshot);
  }

  private renderPing(): void {
    const el = element('lobby-ping-label');
    if (!el) return;
    el.textContent =
      this.pingMs === null
        ? '📶 Ping: measuring…'
        : `📶 Ping: ${this.pingMs} ms • ${connectionQualityLabel(this.pingMs)}`;
  }

  private getSelfPlayer() {
    if (!this.snapshot?.selfPlayerId) return undefined;
    return this.snapshot.players.find((player) => player.id === this.snapshot?.selfPlayerId);
  }

  private renderCards(): void {
    const list = element<HTMLElement>('lobby-card-list');
    const empty = element<HTMLElement>('lobby-empty-state');
    const count = element<HTMLElement>('lobby-results-count');
    if (!list) return;

    const activePasswordRoom =
      document.activeElement instanceof HTMLInputElement &&
      document.activeElement.classList.contains('lobby-card-password')
        ? document.activeElement.dataset.roomCode || ''
        : '';
    list
      .querySelectorAll<HTMLInputElement>('.lobby-card-password')
      .forEach((input) => {
        if (input.dataset.roomCode) {
          this.cardPasswords.set(input.dataset.roomCode, input.value);
        }
      });

    const visible = filterAndSortLobbies(this.lobbies, this.filters, this.sort, this.pingMs);
    if (count) {
      count.textContent = `${visible.length} of ${this.lobbies.length} live lobbies`;
    }
    list.replaceChildren();
    empty?.classList.toggle('hidden', visible.length > 0);
    list.classList.toggle('hidden', visible.length === 0);

    for (const lobby of visible) {
      list.appendChild(this.renderLobbyCard(lobby));
    }

    if (activePasswordRoom) {
      const replacement = Array.from(
        list.querySelectorAll<HTMLInputElement>('.lobby-card-password')
      ).find((input) => input.dataset.roomCode === activePasswordRoom);
      if (replacement) {
        replacement.focus();
        const end = replacement.value.length;
        try {
          replacement.setSelectionRange(end, end);
        } catch {
          // Some mobile password fields do not expose selection ranges.
        }
      }
    }
  }

  private renderLobbyCard(lobby: LobbySummary): HTMLElement {
    const blockReason = getLobbyJoinBlock(lobby);
    const isCurrent = this.snapshot?.roomCode === lobby.roomCode;
    const card = makeElement('article', `lobby-room-card ${lobby.humanOnly ? 'human-only' : 'ai-fill'} status-${lobby.status}`);

    const header = makeElement('div', 'lobby-room-card-header');
    const titleWrap = makeElement('div', 'lobby-room-title-wrap');
    titleWrap.appendChild(makeElement('h3', 'lobby-room-title', lobby.name));
    titleWrap.appendChild(
      makeElement('div', 'lobby-room-subtitle', `${lobby.mapName} • ${teamModeLabel(lobby.teamMode)} Battle Royale`)
    );
    header.appendChild(titleWrap);
    header.appendChild(
      makeElement('span', `lobby-status-pill ${lobby.status}`, lobbyStatusLabel(lobby.status))
    );
    card.appendChild(header);

    const badges = makeElement('div', 'lobby-room-badges');
    if (lobby.humanOnly) {
      badges.appendChild(makeElement('span', 'lobby-badge no-bots', '🚫🤖 NO BOTS'));
      badges.appendChild(makeElement('span', 'lobby-badge humans', '👥 HUMAN PLAYERS ONLY'));
    } else {
      badges.appendChild(makeElement('span', 'lobby-badge ai', `🤖 AI FILL • ${lobby.botCount} BOTS`));
    }
    badges.appendChild(
      makeElement(
        'span',
        'lobby-badge visibility',
        lobby.visibility === 'private' ? '🔒 PRIVATE' : '🌐 PUBLIC'
      )
    );
    if (lobby.hasPassword) badges.appendChild(makeElement('span', 'lobby-badge password', '🔑 PASSWORD'));
    card.appendChild(badges);

    const meta = makeElement('div', 'lobby-room-meta');
    meta.appendChild(this.metaItem('Room ID', lobby.roomCode, true));
    meta.appendChild(this.metaItem('Host', lobby.hostName));
    meta.appendChild(this.metaItem('Map', lobby.mapName));
    meta.appendChild(this.metaItem('Format', teamModeLabel(lobby.teamMode)));
    meta.appendChild(this.metaItem('Start', startConditionLabel(lobby.startCondition)));
    meta.appendChild(
      this.metaItem('Ping', this.pingMs === null ? 'Measuring…' : `${this.pingMs} ms • ${connectionQualityLabel(this.pingMs)}`)
    );
    card.appendChild(meta);

    const counts = makeElement('div', 'lobby-room-counts');
    counts.appendChild(this.countItem('PLAYERS', `${lobby.currentPlayers}/${lobby.maxPlayers}`));
    counts.appendChild(this.countItem('HUMANS', `${lobby.humanCount}`));
    counts.appendChild(this.countItem('AI BOTS', lobby.humanOnly ? '0' : `${lobby.botCount}`));
    counts.appendChild(this.countItem('READY', `${lobby.readyHumans}/${Math.max(lobby.currentPlayers, lobby.readyHumans)}`));
    counts.appendChild(this.countItem('OPEN SLOTS', `${lobby.availableSlots}`));
    card.appendChild(counts);

    let passwordInput: HTMLInputElement | null = null;
    if (lobby.hasPassword) {
      const input = makeElement('input', 'lobby-card-password');
      input.type = 'password';
      input.placeholder = 'Enter lobby password';
      input.autocomplete = 'off';
      input.dataset.roomCode = lobby.roomCode;
      input.value = this.cardPasswords.get(lobby.roomCode) || '';
      input.addEventListener('input', () => {
        this.cardPasswords.set(lobby.roomCode, input.value);
      });
      input.setAttribute('aria-label', `Password for ${lobby.name}`);
      passwordInput = input;
      card.appendChild(input);
    }

    const actions = makeElement('div', 'lobby-room-actions');
    const copyButton = makeElement('button', 'lobby-secondary-btn compact', 'COPY ID');
    copyButton.type = 'button';
    copyButton.addEventListener('click', () => {
      void this.copyText(lobby.roomCode, 'Room ID copied.');
    });
    actions.appendChild(copyButton);

    const joinButton = makeElement('button', 'lobby-join-btn', isCurrent ? 'CURRENT LOBBY' : 'JOIN LOBBY');
    joinButton.type = 'button';
    joinButton.disabled = this.busy || isCurrent || Boolean(blockReason);
    joinButton.title = blockReason || `Join ${lobby.name}`;
    joinButton.addEventListener('click', () => {
      this.callbacks.onJoinLobby(lobby, passwordInput?.value || '');
    });
    actions.appendChild(joinButton);
    card.appendChild(actions);

    if (blockReason && !isCurrent) {
      card.appendChild(makeElement('div', 'lobby-join-blocked', blockReason));
    }
    if (this.snapshot && !isCurrent) {
      card.appendChild(
        makeElement('div', 'lobby-join-blocked', 'Leave your current lobby before joining another.')
      );
      joinButton.disabled = true;
    }
    return card;
  }

  private metaItem(label: string, value: string, mono = false): HTMLElement {
    const item = makeElement('div', 'lobby-meta-item');
    item.appendChild(makeElement('span', 'lobby-meta-label', label));
    item.appendChild(makeElement('strong', `lobby-meta-value ${mono ? 'mono' : ''}`, value));
    return item;
  }

  private countItem(label: string, value: string): HTMLElement {
    const item = makeElement('div', 'lobby-count-item');
    item.appendChild(makeElement('span', 'lobby-count-label', label));
    item.appendChild(makeElement('strong', 'lobby-count-value', value));
    return item;
  }

  private syncPreviewSquadStatus(): void {
    const statusEl = element('preview-squad-status');
    if (!statusEl) return;
    const snapshot = this.snapshot;
    if (!snapshot) {
      statusEl.textContent = 'SQUAD · Create or join a lobby';
      statusEl.className = 'preview-squad-status';
      return;
    }

    const format = teamModeLabel(snapshot.teamMode);
    if (snapshot.phase === 'active') {
      statusEl.textContent = `${format.toUpperCase()} · ${snapshot.aliveHumans} ALIVE · ${snapshot.roomCode}`;
      statusEl.className = 'preview-squad-status active';
    } else if (snapshot.phase === 'countdown') {
      statusEl.textContent = `${format.toUpperCase()} · LAUNCHING · ${snapshot.roomCode}`;
      statusEl.className = 'preview-squad-status ready';
    } else if (snapshot.phase === 'ended') {
      statusEl.textContent = `${format.toUpperCase()} · MATCH ENDED · ${snapshot.roomCode}`;
      statusEl.className = 'preview-squad-status';
    } else {
      statusEl.textContent =
        `${format.toUpperCase()} · ${snapshot.readyHumans}/${snapshot.authenticatedHumans} READY · ` +
        `${snapshot.connectedHumans}/${snapshot.maxPlayers} PLAYERS`;
      statusEl.className = `preview-squad-status ${snapshot.canHostStart ? 'ready' : ''}`;
    }
  }

  private renderMyLobby(): void {
    const empty = element('my-lobby-empty');
    const content = element('my-lobby-content');
    if (!empty || !content) return;

    const snapshot = this.snapshot;
    empty.classList.toggle('hidden', Boolean(snapshot));
    content.classList.toggle('hidden', !snapshot);
    if (!snapshot) {
      this.lastMyLobbySignature = '';
      this.syncPreviewSquadStatus();
      return;
    }
    this.syncPreviewSquadStatus();

    const signature = JSON.stringify({
      code: snapshot.roomCode,
      name: snapshot.name,
      phase: snapshot.phase,
      status: snapshot.status,
      host: snapshot.hostPlayerId,
      hostName: snapshot.hostName,
      connected: snapshot.connectedHumans,
      authenticated: snapshot.authenticatedHumans,
      ready: snapshot.readyHumans,
      slots: snapshot.availableSlots,
      canStart: snapshot.canHostStart,
      winner: snapshot.winnerName,
      busy: this.busy,
      ping: this.pingMs,
      players: snapshot.players.map((player) => [
        player.id,
        player.name,
        player.isReady,
        player.isHost,
        player.teamIndex,
        player.isConnected,
        player.alive,
        player.outfitId,
        player.skinColor,
        player.accentColor,
        player.backAccessory,
      ]),
    });
    if (snapshot.phase !== 'countdown' && signature === this.lastMyLobbySignature) {
      return;
    }
    this.lastMyLobbySignature = signature;

    const title = element('my-lobby-title');
    if (title) title.textContent = snapshot.name;
    const status = element('my-lobby-status');
    if (status) {
      const seconds = snapshot.countdownEndsAt
        ? Math.max(0, Math.ceil((snapshot.countdownEndsAt - Date.now()) / 1000))
        : 0;
      status.textContent =
        snapshot.phase === 'countdown'
          ? `🚀 STARTING IN ${seconds}s — get ready!`
          : snapshot.phase === 'active'
            ? '🎮 MATCH IN PROGRESS'
            : snapshot.phase === 'ended'
              ? `🏁 MATCH ENDED${snapshot.winnerName ? ` • Winner: ${snapshot.winnerName}` : ''}`
              : snapshot.canHostStart
                ? snapshot.startCondition === 'host_start'
                  ? '✅ Everyone is ready — the host can start the match.'
                  : '✅ Everyone is ready — match starting…'
                : `⏳ Waiting for players: ${snapshot.connectedHumans}/${snapshot.minPlayers} minimum • ${snapshot.readyHumans}/${snapshot.authenticatedHumans} ready${snapshot.startCondition === 'fill_lobby' ? ` • ${snapshot.connectedHumans}/${snapshot.maxPlayers} required to fill` : ''}.`;
      status.className = `my-lobby-status phase-${snapshot.phase}`;
    }

    const codeInput = element<HTMLInputElement>('my-lobby-code');
    if (codeInput) codeInput.value = snapshot.roomCode;
    const inviteInput = element<HTMLInputElement>('my-lobby-invite');
    if (inviteInput) {
      inviteInput.value = createLobbyInviteUrl(window.location.href, snapshot.roomCode);
    }

    const stats = element('my-lobby-stats');
    if (stats) {
      stats.replaceChildren(
        this.countItem('HOST', snapshot.hostName),
        this.countItem('PLAYERS', `${snapshot.connectedHumans}/${snapshot.maxPlayers}`),
        this.countItem('HUMANS', `${snapshot.connectedHumans}`),
        this.countItem('AI BOTS', snapshot.humanOnly ? '0 • NO BOTS' : `${snapshot.botCount}`),
        this.countItem('READY', `${snapshot.readyHumans}/${snapshot.authenticatedHumans}`),
        this.countItem('OPEN SLOTS', `${snapshot.availableSlots}`),
        this.countItem('MAP', snapshot.mapName),
        this.countItem('FORMAT', teamModeLabel(snapshot.teamMode)),
        this.countItem('TYPE', snapshot.humanOnly ? 'Human Only' : 'AI Fill'),
        this.countItem('VISIBILITY', snapshot.hasPassword ? 'Private • Password' : snapshot.visibility),
        this.countItem('START RULE', startConditionLabel(snapshot.startCondition)),
        this.countItem('PING', this.pingMs === null ? 'Measuring…' : `${this.pingMs} ms`)
      );
    }

    const readyFill = element('my-lobby-ready-fill');
    if (readyFill) {
      const readyRatio =
        snapshot.authenticatedHumans > 0
          ? Math.min(1, snapshot.readyHumans / snapshot.authenticatedHumans)
          : 0;
      readyFill.style.width = `${Math.round(readyRatio * 100)}%`;
    }
    const readyLabel = element('my-lobby-ready-label');
    if (readyLabel) {
      readyLabel.textContent = `${snapshot.readyHumans}/${snapshot.authenticatedHumans} READY`;
    }

    const roster = element('my-lobby-roster');
    if (roster) {
      roster.replaceChildren();
      const players = [...snapshot.players].sort((a, b) => {
        if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
        if (a.id === snapshot.selfPlayerId) return -1;
        if (b.id === snapshot.selfPlayerId) return 1;
        return a.name.localeCompare(b.name);
      });
      if (players.length === 0) {
        roster.appendChild(makeElement('div', 'my-lobby-roster-empty', 'Waiting for the server roster…'));
      }
      const duplicateNames = players.filter((p, i) => players.findIndex(other => other.name.toLowerCase() === p.name.toLowerCase()) !== i);
      if (duplicateNames.length) roster.appendChild(makeElement('p', 'duplicate-name-warning', 'Duplicate display names in this lobby. Names are not identity; use YOU, HOST and the player ID badges to distinguish players. Leave the lobby to rename.'));
      for (const player of players) {
        const row = makeElement(
          'div',
          `my-lobby-player ${player.isReady ? 'ready' : ''} ${player.isConnected ? '' : 'disconnected'}`
        );
        const initials =
          player.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'CI';
        const avatar = makeElement('span', 'my-lobby-player-avatar', initials);
        const cssColor = (value: number | undefined, fallback: string) =>
          Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffff
            ? `#${Number(value).toString(16).padStart(6, '0')}`
            : fallback;
        avatar.style.background = `linear-gradient(135deg, ${cssColor(player.skinColor, '#0284c7')}, ${cssColor(player.accentColor, '#38bdf8')})`;
        const outfitPreset = OUTFIT_PRESETS.find((preset) => preset.id === player.outfitId);
        avatar.title = outfitPreset ? outfitPreset.name : 'Operator';
        row.appendChild(avatar);

        const left = makeElement('div', 'my-lobby-player-main');
        left.appendChild(makeElement('strong', 'my-lobby-player-name', player.name));
        const badges = makeElement('span', 'my-lobby-player-badges');
        badges.appendChild(makeElement('span', 'mini-badge', `ID ${player.id.slice(-6)}`));
        if (player.isHost) badges.appendChild(makeElement('span', 'mini-badge host', 'HOST'));
        if (player.id === snapshot.selfPlayerId) badges.appendChild(makeElement('span', 'mini-badge you', 'YOU'));
        if (outfitPreset) {
          badges.appendChild(makeElement('span', 'mini-badge outfit', outfitPreset.name.toUpperCase()));
        }
        if (snapshot.teamMode !== 'solo' && player.teamIndex >= 0) {
          badges.appendChild(makeElement('span', 'mini-badge team', `TEAM ${player.teamIndex + 1}`));
        }
        left.appendChild(badges);
        row.appendChild(left);
        row.appendChild(
          makeElement(
            'span',
            'my-lobby-player-status',
            !player.isConnected
              ? 'DISCONNECTED'
              : snapshot.phase === 'active'
                ? player.alive
                  ? 'ALIVE'
                  : 'ELIMINATED'
                : player.isReady
                  ? 'READY ✓'
                  : 'NOT READY'
          )
        );
        roster.appendChild(row);
      }
    }

    const self = this.getSelfPlayer();
    const isHost = Boolean(snapshot.isSelfHost || self?.isHost);
    const readyButton = element<HTMLButtonElement>('btn-my-lobby-ready');
    if (readyButton) {
      readyButton.textContent = self?.isReady ? '✓ READY — TAP TO UNREADY' : 'READY UP';
      readyButton.disabled =
        this.busy || snapshot.phase === 'active' || snapshot.phase === 'ended';
      readyButton.classList.toggle('ready', Boolean(self?.isReady));
    }

    const startButton = element<HTMLButtonElement>('btn-my-lobby-start');
    if (startButton) {
      startButton.classList.toggle('hidden', !isHost);
      startButton.textContent = snapshot.phase === 'countdown' ? 'STARTING…' : '▶ START MATCH';
      startButton.disabled = this.busy || !isHost || !snapshot.canHostStart || snapshot.phase !== 'lobby';
    }
    const closeButton = element<HTMLButtonElement>('btn-my-lobby-close');
    if (closeButton) {
      closeButton.classList.toggle('hidden', !isHost);
      closeButton.disabled = this.busy || snapshot.phase === 'active';
    }
    const leaveButton = element<HTMLButtonElement>('btn-my-lobby-leave');
    if (leaveButton) leaveButton.disabled = this.busy;
  }

  private async copyText(text: string, successMessage: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.showMessage(successMessage);
    } catch {
      this.showMessage(`Copy failed. Value: ${text}`, true);
    }
  }
}
