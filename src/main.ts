import './styles/main.css';
import { GameEngine } from './core/GameEngine';
import {
  BackAccessoryType,
  BotDifficulty,
  BuildPieceType,
  CreateLobbyRequest,
  LobbyConfig,
  LobbySummary,
  OutfitPresetId,
  RoomSnapshot,
  SessionMode,
  StarterLoadoutType,
  TimeOfDayPreset,
  effectiveBotCountForMode,
  getStarterLoadoutItems,
  isHumanOnlySessionMode,
} from './network/schemas';
import {
  ACCENT_COLOR_SWATCHES,
  ARMOR_COLOR_SWATCHES,
  OUTFIT_PRESETS,
} from './systems/ProgressionSystem';
import { MobileTouchControls } from './input/MobileTouchControls';
import { MobileLandscapeManager } from './input/MobileLandscapeManager';
import { LobbyBrowserClient } from './network/LobbyBrowserClient';
import { getLobbyJoinBlock, parseLobbyInviteCode } from './network/lobbyBrowserUtils';
import { LobbyBrowserUI } from './ui/LobbyBrowser';
import {
  createWeaponStats,
  getWeaponVisualProfile,
} from './weapons/WeaponDefinitions';
import { getOutfitVisualProfile } from './entities/CharacterCosmetics';

window.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('game-canvas-container')!;
  const engine = new GameEngine(container);

  // =========================================================================
  // 1. CAREER PROGRESSION & STORAGE BADGE RENDERING
  // =========================================================================
  const renderCareerProgressionStrip = () => {
    const p = engine.progression.state;
    const rankTitle = engine.progression.getRankTitle();
    const progRatio = engine.progression.getCurrentLevelProgressRatio();

    const lvlBadge = document.getElementById('career-level-badge');
    const xpText = document.getElementById('career-xp-text');
    const xpFill = document.getElementById('career-xp-fill');
    const matchesEl = document.getElementById('career-matches');
    const winsEl = document.getElementById('career-wins');
    const elimsEl = document.getElementById('career-elims');
    const dmgEl = document.getElementById('career-damage');
    const bestRankEl = document.getElementById('career-best-rank');
    const storageBadge = document.getElementById('career-storage-badge');

    if (lvlBadge) lvlBadge.textContent = `⭐ LVL ${p.level} • ${rankTitle}`;
    if (xpText) xpText.textContent = `${p.xp % 1000} / 1000 XP (Total: ${p.xp} XP)`;
    if (xpFill) xpFill.style.width = `${Math.round(progRatio * 100)}%`;
    if (matchesEl) matchesEl.textContent = `${p.matchesPlayed}`;
    if (winsEl) winsEl.textContent = `${p.wins}`;
    if (elimsEl) elimsEl.textContent = `${p.eliminations}`;
    if (dmgEl) dmgEl.textContent = `${p.damageDealt}`;
    if (bestRankEl) {
      bestRankEl.textContent = p.bestPlacement > 0 ? `#${p.bestPlacement}` : '—';
    }
    if (storageBadge) {
      const backendLabel = p.persistenceBackend
        ? p.persistenceBackend.toUpperCase()
        : 'SERVER DB';
      storageBadge.textContent =
        p.storageMode === 'server_verified'
          ? `🛡️ PERSISTENT ${backendLabel} ACCOUNT (${
              p.accountId || 'Verified'
            }) + 💾 LOCAL CACHE`
          : '💾 LOCAL BROWSER PROFILE (Offline / Solo Fallback — Connects to DB on Launch)';
    }

    const accIdBadge = document.getElementById('account-id-badge');
    if (accIdBadge) {
      const creds = engine.progression.credentials;
      accIdBadge.textContent = creds.accountId
        ? `ID: ${creds.accountId} • ${
            creds.passkey ? 'Passkey Saved' : 'Session Verified'
          }`
        : 'ACCOUNT: Local Mode (Click Link or Launch Online)';
    }
  };

  engine.onProgressionUpdated = () => {
    renderCareerProgressionStrip();
    syncLockerUI();
  };
  renderCareerProgressionStrip();

  // Persistent Account Passkey & Cross-Device Linking Controls
  const accountPanel = document.getElementById('account-passkey-panel');
  const toggleAccountBtn = document.getElementById('btn-toggle-account-panel');
  const copyPasskeyBtn = document.getElementById('btn-copy-passkey');
  const restoreInput = document.getElementById(
    'input-restore-passkey'
  ) as HTMLInputElement | null;
  const restoreBtn = document.getElementById('btn-restore-passkey');
  const restoreMsg = document.getElementById('account-restore-msg');

  toggleAccountBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    accountPanel?.classList.toggle('hidden');
    renderCareerProgressionStrip();
  });

  copyPasskeyBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    const passkey = engine.progression.credentials.passkey;
    if (!passkey) {
      if (restoreMsg) {
        restoreMsg.textContent =
          '⚠️ Passkey is issued when your account is first created on this browser.';
        restoreMsg.className = 'account-restore-msg err';
      }
      return;
    }
    navigator.clipboard?.writeText(passkey).catch(() => {});
    if (copyPasskeyBtn) {
      copyPasskeyBtn.textContent = '✅ PASSKEY COPIED!';
      setTimeout(() => {
        copyPasskeyBtn.textContent = '🔑 COPY PASSKEY';
      }, 1800);
    }
    if (restoreMsg) {
      restoreMsg.textContent = `🔑 Passkey copied (${passkey}). Save it to link your career on any device!`;
      restoreMsg.className = 'account-restore-msg ok';
    }
  });

  restoreBtn?.addEventListener('click', async () => {
    engine.sound.playUIClick();
    const val = (restoreInput?.value || '').trim();
    if (!val) {
      if (restoreMsg) {
        restoreMsg.textContent =
          '⚠️ Enter your Passkey (e.g. acc_xxxxxx:XXXX-XXXX-XXXX).';
        restoreMsg.className = 'account-restore-msg err';
      }
      return;
    }
    const res = await engine.progression.restoreAccountWithPasskey(val);
    if (!res.ok) {
      if (restoreMsg) {
        restoreMsg.textContent = `❌ ${res.error || 'Account link failed.'}`;
        restoreMsg.className = 'account-restore-msg err';
      }
      return;
    }
    engine.network.setAccountCredentials(
      engine.progression.credentials.accountId,
      engine.progression.credentials.accountToken
    );
    engine.updateLobbyCharacterPreview(engine.progression.cosmetics);
    const nameInput = document.getElementById(
      'lobby-player-name'
    ) as HTMLInputElement | null;
    if (nameInput && res.profile?.callsign) {
      nameInput.value = res.profile.callsign;
    }
    renderCareerProgressionStrip();
    syncLockerUI();
    if (restoreInput) restoreInput.value = '';
    if (restoreMsg) {
      restoreMsg.textContent = `✅ Linked Account ${engine.progression.credentials.accountId} (LVL ${engine.progression.state.level} • ${engine.progression.state.xp} XP)!`;
      restoreMsg.className = 'account-restore-msg ok';
    }
  });

  // =========================================================================
  // 2. COSMETIC LOCKER & 3D OPERATOR PREVIEW CONTROLS
  // =========================================================================
  const syncOperatorShowcase = () => {
    const cosmetics = engine.progression.cosmetics;
    const outfitPreset =
      OUTFIT_PRESETS.find((o) => o.id === cosmetics.outfitId) || OUTFIT_PRESETS[0];
    const visual = getOutfitVisualProfile(cosmetics.outfitId);
    const loadoutSelect = document.getElementById(
      'lobby-starter-loadout'
    ) as HTMLSelectElement | null;
    const loadout = getStarterLoadoutItems(
      (loadoutSelect?.value as StarterLoadoutType) || 'balanced'
    );
    const primary = createWeaponStats(loadout.primaryCat, loadout.primaryRarity);
    const secondary = createWeaponStats(loadout.secondaryCat, loadout.secondaryRarity);
    const primaryProfile = getWeaponVisualProfile(primary.category);
    const setText = (id: string, value: string) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    };

    setText('preview-outfit-detail', `${visual.finishLabel} · ${visual.silhouetteLabel}`);
    setText('preview-outfit-finish', visual.finishLabel.toUpperCase());
    setText('preview-weapon-icon', primaryProfile.icon);
    setText('preview-weapon-name', primary.name);
    setText('preview-weapon-role', `${primaryProfile.role} · ${primaryProfile.silhouette}`);
    setText(
      'preview-weapon-damage',
      primary.pellets > 1 ? `${primary.baseDamage}×${primary.pellets}` : `${primary.baseDamage}`
    );
    setText(
      'preview-weapon-rate',
      primary.fireMode === 'burst'
        ? `${primary.burstCount}× burst`
        : `${primary.fireRate.toFixed(1)}/s`
    );
    setText('preview-weapon-range', `${primary.range}m`);
    setText('preview-weapon-mag', `${primary.clipSize}`);
    setText('preview-secondary-weapon', `Sidearm · ${secondary.name} · ${outfitPreset.tagline}`);
  };

  const syncLockerUI = () => {
    const c = engine.progression.cosmetics;
    const presetObj =
      OUTFIT_PRESETS.find((o) => o.id === c.outfitId) || OUTFIT_PRESETS[0];
    const previewNameEl = document.getElementById('preview-outfit-name');
    if (previewNameEl) previewNameEl.textContent = presetObj.name;

    document.querySelectorAll<HTMLButtonElement>('.outfit-btn').forEach((btn) => {
      const preset = OUTFIT_PRESETS.find((o) => o.id === btn.dataset.outfit);
      const profile = preset ? getOutfitVisualProfile(preset.id) : null;
      if (preset && profile) {
        btn.title = `${preset.tagline} · ${profile.finishLabel} · ${profile.silhouetteLabel}`;
      }
      btn.classList.toggle('active', btn.dataset.outfit === c.outfitId);
    });
    document.querySelectorAll<HTMLButtonElement>('.back-acc-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.back === c.backAccessory);
    });
    document
      .querySelectorAll<HTMLButtonElement>('#locker-armor-swatches .color-swatch-btn')
      .forEach((btn) => {
        btn.classList.toggle(
          'active',
          Number(btn.dataset.color) === c.skinColor
        );
      });
    document
      .querySelectorAll<HTMLButtonElement>('#locker-accent-swatches .color-swatch-btn')
      .forEach((btn) => {
        btn.classList.toggle(
          'active',
          Number(btn.dataset.color) === c.accentColor
        );
      });
    syncOperatorShowcase();
  };

  const armorSwatchContainer = document.getElementById('locker-armor-swatches');
  if (armorSwatchContainer) {
    armorSwatchContainer.innerHTML = '';
    for (const sw of ARMOR_COLOR_SWATCHES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch-btn';
      btn.title = sw.label;
      btn.dataset.color = `${sw.hex}`;
      btn.style.background = `#${sw.hex.toString(16).padStart(6, '0')}`;
      btn.addEventListener('click', () => {
        engine.sound.playUIClick();
        engine.updateLobbyCharacterPreview({ skinColor: sw.hex });
        syncLockerUI();
      });
      armorSwatchContainer.appendChild(btn);
    }
  }

  const accentSwatchContainer = document.getElementById('locker-accent-swatches');
  if (accentSwatchContainer) {
    accentSwatchContainer.innerHTML = '';
    for (const sw of ACCENT_COLOR_SWATCHES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch-btn';
      btn.title = sw.label;
      btn.dataset.color = `${sw.hex}`;
      btn.style.background = `#${sw.hex.toString(16).padStart(6, '0')}`;
      btn.addEventListener('click', () => {
        engine.sound.playUIClick();
        engine.updateLobbyCharacterPreview({ accentColor: sw.hex });
        syncLockerUI();
      });
      accentSwatchContainer.appendChild(btn);
    }
  }

  document.querySelectorAll<HTMLButtonElement>('.outfit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      engine.sound.playUIClick();
      const outfitId = (btn.dataset.outfit as OutfitPresetId) || 'vanguard_blue';
      const preset = engine.progression.applyOutfitPreset(outfitId);
      engine.updateLobbyCharacterPreview(preset);
      syncLockerUI();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.back-acc-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      engine.sound.playUIClick();
      const backAccessory = (btn.dataset.back as BackAccessoryType) || 'jump_pack';
      engine.updateLobbyCharacterPreview({ backAccessory });
      syncLockerUI();
    });
  });

  syncLockerUI();

  const openLocker = () => {
    engine.sound.playUIClick();
    syncLockerUI();
    document.getElementById('lobby-overlay')?.classList.add('hidden');
    document.getElementById('locker-overlay')?.classList.remove('hidden');
  };

  document.getElementById('btn-open-locker')?.addEventListener('click', openLocker);
  document.getElementById('btn-dock-locker')?.addEventListener('click', openLocker);

  document.getElementById('btn-close-locker')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    document.getElementById('locker-overlay')?.classList.add('hidden');
    document.getElementById('lobby-overlay')?.classList.remove('hidden');
  });

  document.getElementById('btn-rot-left')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    engine.rotateLobbyPreview(-0.55);
  });
  document.getElementById('btn-rot-right')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    engine.rotateLobbyPreview(0.55);
  });
  document.getElementById('btn-locker-rot-left')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    engine.rotateLobbyPreview(-0.55);
  });
  document.getElementById('btn-locker-rot-right')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    engine.rotateLobbyPreview(0.55);
  });

  // =========================================================================
  // 3. HOW TO PLAY & LOBBY MODE / ROOM STATUS CONTROLS
  // =========================================================================
  const openHowTo = () => {
    engine.sound.playUIClick();
    document.getElementById('howto-overlay')?.classList.remove('hidden');
  };
  document.getElementById('btn-open-howto')?.addEventListener('click', openHowTo);
  document.getElementById('btn-open-howto-pause')?.addEventListener('click', openHowTo);
  document.getElementById('btn-close-howto')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    document.getElementById('howto-overlay')?.classList.add('hidden');
  });

  const soloBtn = document.getElementById('btn-mode-solo');
  const onlineBtn = document.getElementById('btn-mode-online');
  const connStatusEl = document.getElementById('lobby-conn-status');
  const playerCountEl = document.getElementById('lobby-player-count');
  const botCountSelectEl = document.getElementById('lobby-bot-count') as HTMLSelectElement;
  const difficultySelectEl = document.getElementById(
    'lobby-difficulty'
  ) as HTMLSelectElement;
  const loadoutSelectEl = document.getElementById(
    'lobby-starter-loadout'
  ) as HTMLSelectElement;
  const launchBtn = document.getElementById(
    'btn-launch-match'
  ) as HTMLButtonElement | null;
  const soloControlsEl = document.getElementById('solo-session-controls');
  const playerNameInput = document.getElementById(
    'lobby-player-name'
  ) as HTMLInputElement | null;

  let mainMenuMode: 'solo' | 'multiplayer' = 'solo';
  let activeLobbySnapshot: RoomSnapshot | null = null;
  let lobbyBusy = false;
  let pendingLobbyJoin = false;
  let lobbyDirectoryClient: LobbyBrowserClient | null = null;
  const pendingInviteCode = parseLobbyInviteCode(
    window.location.search,
    window.location.hash
  );

  const sessionModeForSnapshot = (snapshot: RoomSnapshot): SessionMode =>
    snapshot.mode === 'human_only_private'
      ? 'human_only_private'
      : snapshot.mode === 'human_only_public'
        ? 'human_only_public'
        : 'online';

  const getSelectedSessionMode = (): SessionMode => {
    if (activeLobbySnapshot) return sessionModeForSnapshot(activeLobbySnapshot);
    return mainMenuMode === 'multiplayer' ? 'online' : 'solo_bots';
  };

  const isLobbyConnectionPending = (): boolean =>
    Boolean(activeLobbySnapshot) ||
    pendingLobbyJoin ||
    (engine.network.isOnlineRoom &&
      engine.network.isLobbyManagedRoom &&
      (engine.network.roomConnected ||
        engine.network.connectionState === 'connecting' ||
        engine.network.connectionState === 'reconnecting'));

  const lobbyPhaseLabel = (snapshot: RoomSnapshot | null): string => {
    if (!snapshot) return 'NOT CONNECTED';
    switch (snapshot.phase) {
      case 'lobby':
        return 'WAITING IN LOBBY';
      case 'countdown':
        return 'STARTING MATCH';
      case 'active':
        return 'MATCH LIVE';
      case 'ended':
        return 'MATCH ENDED';
      default:
        return String(snapshot.phase).toUpperCase();
    }
  };

  const renderRoomStatusBar = (snapshot: RoomSnapshot | null) => {
    if (!connStatusEl || !playerCountEl) return;
    if (mainMenuMode === 'solo' && !snapshot) {
      const botCount = parseInt(botCountSelectEl?.value || '14', 10) || 14;
      connStatusEl.className = 'room-status-tag';
      connStatusEl.textContent = '🟢 READY • SOLO + AI BOTS';
      playerCountEl.textContent = `👥 1 Human + ${botCount} AI Combatants`;
      return;
    }
    if (!snapshot) {
      connStatusEl.className = 'room-status-tag warn';
      connStatusEl.textContent = '🌐 MULTIPLAYER LOBBY BROWSER';
      playerCountEl.textContent = '👥 Browse or create a live lobby';
      return;
    }
    connStatusEl.className = snapshot.phase === 'ended' ? 'room-status-tag warn' : 'room-status-tag';
    connStatusEl.textContent = snapshot.humanOnly
      ? `👥 ${snapshot.roomCode} • HUMAN PLAYERS ONLY — NO BOTS • ${lobbyPhaseLabel(snapshot)}`
      : `🌐 ${snapshot.roomCode} • AI FILL • ${lobbyPhaseLabel(snapshot)}`;
    playerCountEl.textContent = `👥 ${snapshot.connectedHumans} Humans • ${snapshot.readyHumans} Ready • 🤖 ${snapshot.botCount} AI`;
  };

  const setLobbyBusy = (busy: boolean) => {
    lobbyBusy = busy;
    lobbyBrowser.setBusy(busy);
  };

  const ensureVerifiedMultiplayerAccount = async (
    callsign: string
  ): Promise<boolean> => {
    const initialized = await engine.progression.initializeServerAccount(callsign);
    const credentials = engine.progression.credentials;
    if (!initialized || !credentials.accountId || !credentials.accountToken) {
      return false;
    }
    engine.network.setAccountCredentials(
      credentials.accountId,
      credentials.accountToken
    );
    renderCareerProgressionStrip();
    return true;
  };

  const buildBaseLobbyConfig = (
    mode: SessionMode,
    roomCode = '',
    overrides: Partial<LobbyConfig> = {}
  ): LobbyConfig => {
    const skyDropCheck = document.getElementById(
      'lobby-skydrop'
    ) as HTMLInputElement | null;
    const requestedBotCount =
      overrides.botCount ?? (parseInt(botCountSelectEl?.value || '14', 10) || 14);
    return {
      playerName: playerNameInput?.value || 'Commander_CI',
      mode,
      roomCode: roomCode || undefined,
      skyDrop: skyDropCheck?.checked ?? true,
      starterLoadout:
        (loadoutSelectEl?.value as StarterLoadoutType) || 'balanced',
      cosmetics: engine.progression.cosmetics,
      ...overrides,
      botCount: effectiveBotCountForMode(mode, requestedBotCount),
      difficulty:
        overrides.difficulty ||
        ((difficultySelectEl?.value as BotDifficulty) || 'medium'),
    };
  };

  const enterLobbyWithConfig = async (
    config: LobbyConfig,
    connectingMessage: string
  ): Promise<void> => {
    if (lobbyBusy || engine.isRunningMatch) return;
    if (isLobbyConnectionPending()) {
      lobbyBrowser.setTab('mine');
      lobbyBrowser.showMessage(
        'Leave your current lobby before joining or creating another one.',
        true
      );
      return;
    }

    setLobbyBusy(true);
    lobbyBrowser.showMessage(connectingMessage);
    let joinInitiated = false;
    try {
      const verified = await ensureVerifiedMultiplayerAccount(config.playerName);
      if (!verified) {
        lobbyBrowser.showMessage(
          'Could not verify your persistent server account. Check your connection or link an account passkey, then try again. Multiplayer lobbies require authenticated real accounts.',
          true
        );
        return;
      }
      pendingLobbyJoin = true;
      joinInitiated = true;
      lobbyBrowser.setTab('mine');
      engine.joinMultiplayerLobby(config);
    } finally {
      // Once a join/create packet is in flight, the snapshot/rejection
      // callbacks own clearing busy state. Clearing here would briefly show
      // an empty My Lobby as if the join had finished.
      if (!joinInitiated) setLobbyBusy(false);
    }
  };

  const joinLobbySummary = (lobby: LobbySummary, password: string) => {
    const block = getLobbyJoinBlock(lobby);
    if (block) {
      lobbyBrowser.showMessage(block, true);
      return;
    }
    if (lobby.hasPassword && !password) {
      lobbyBrowser.showMessage(
        'This private lobby is password protected. Enter its password on the lobby card.',
        true
      );
      return;
    }
    const mode: SessionMode =
      lobby.roomMode === 'human_only_private'
        ? 'human_only_private'
        : lobby.roomMode === 'human_only_public'
          ? 'human_only_public'
          : 'online';
    const config = buildBaseLobbyConfig(mode, lobby.roomCode, {
      roomPassword: password || undefined,
      botCount: lobby.botCount,
      difficulty: lobby.botDifficulty,
      lobbyName: lobby.name,
      maxPlayers: lobby.maxPlayers,
      mapId: lobby.mapId,
      teamMode: lobby.teamMode,
      startCondition: lobby.startCondition,
      visibility: lobby.visibility === 'private' ? 'private' : 'public',
    });
    void enterLobbyWithConfig(config, `Joining ${lobby.name} (${lobby.roomCode})…`);
  };

  const joinLobbyByCode = async (code: string, password: string) => {
    if (lobbyBusy || engine.isRunningMatch) return;
    if (isLobbyConnectionPending()) {
      lobbyBrowser.setTab('mine');
      lobbyBrowser.showMessage('Leave your current lobby before joining another room.', true);
      return;
    }

    const cleanCode = code.trim().toUpperCase();
    setLobbyBusy(true);
    lobbyBrowser.showMessage(`Looking up room ${cleanCode}…`);
    let joinStarted = false;
    try {
      const status = await engine.network.fetchRoomStatus(cleanCode);
      if (!status.ok) {
        lobbyBrowser.showMessage(
          'Connection lost while looking up that room. Check your connection and try again.',
          true
        );
        return;
      }
      if (!status.exists) {
        lobbyBrowser.showMessage(
          `Room not found: ${cleanCode}. Check the Room ID or ask the host for a new invite.`,
          true
        );
        return;
      }
      if (status.status === 'closed') {
        lobbyBrowser.showMessage(`Room ${cleanCode} is closed.`, true);
        return;
      }
      if (!status.isLobbyManaged) {
        lobbyBrowser.showMessage(
          `Room ${cleanCode} exists, but it is not a Lobby Browser room and cannot be joined from here.`,
          true
        );
        return;
      }
      if (status.connectedHumans >= status.maxPlayers || status.status === 'full') {
        lobbyBrowser.showMessage(`Room ${cleanCode} is full.`, true);
        return;
      }
      if (status.phase !== 'lobby' && !status.allowLateJoin) {
        lobbyBrowser.showMessage(
          `Room ${cleanCode} has already started and does not allow late joining.`,
          true
        );
        return;
      }
      if (status.hasPassword && !password) {
        lobbyBrowser.showMessage('This room requires a password. Enter it beside the Room ID.', true);
        lobbyBrowser.focusJoinPassword();
        return;
      }

      const mode = sessionModeForSnapshot(status);
      const config = buildBaseLobbyConfig(mode, status.roomCode, {
        roomPassword: password || undefined,
        botCount: status.botCount,
        difficulty: status.botDifficulty,
        lobbyName: status.name,
        maxPlayers: status.maxPlayers,
        mapId: status.mapId,
        teamMode: status.teamMode,
        startCondition: status.startCondition,
        visibility: status.visibility === 'private' ? 'private' : 'public',
      });
      setLobbyBusy(false);
      joinStarted = true;
      await enterLobbyWithConfig(config, `Joining ${status.name} (${status.roomCode})…`);
    } finally {
      if (!joinStarted) setLobbyBusy(false);
    }
  };

  const createNewLobby = (request: CreateLobbyRequest) => {
    const mode: SessionMode = request.humanOnly
      ? request.visibility === 'private'
        ? 'human_only_private'
        : 'human_only_public'
      : 'online';
    const config = buildBaseLobbyConfig(mode, '', {
      createLobby: request,
      roomPassword: request.password,
      botCount: request.botCount,
      difficulty: request.botDifficulty || 'medium',
      lobbyName: request.name,
      maxPlayers: request.maxPlayers,
      mapId: request.mapId,
      teamMode: request.teamMode,
      startCondition: request.startCondition,
      visibility: request.visibility,
    });
    void enterLobbyWithConfig(config, `Creating “${request.name || 'your lobby'}”…`);
  };

  const leaveCurrentLobby = (showNotice = true) => {
    if (!activeLobbySnapshot && !isLobbyConnectionPending()) return;
    activeLobbySnapshot = null;
    pendingLobbyJoin = false;
    setLobbyBusy(false);
    engine.leaveMultiplayerLobby();
    lobbyBrowser.setCurrentSnapshot(null);
    if (showNotice) {
      lobbyBrowser.showMessage(
        'You left the lobby. Your seat, ready state, and host role were released on the server.'
      );
      lobbyBrowser.setTab('browse');
    }
    renderRoomStatusBar(null);
    startLobbyDirectory();
  };

  const ensureLobbyDirectoryClient = (): LobbyBrowserClient => {
    if (lobbyDirectoryClient) return lobbyDirectoryClient;
    lobbyDirectoryClient = new LobbyBrowserClient(
      engine.network.resolveWebSocketUrl(),
      engine.network.resolveHttpBaseUrl()
    );
    lobbyDirectoryClient.onLobbies = (lobbies) => {
      lobbyBrowser.setLobbies(lobbies);
    };
    lobbyDirectoryClient.onConnectionState = (state, message) => {
      lobbyBrowser.setDirectoryState(state, message);
    };
    lobbyDirectoryClient.onPing = (pingMs) => {
      lobbyBrowser.setPing(pingMs);
    };
    return lobbyDirectoryClient;
  };

  const startLobbyDirectory = () => {
    if (mainMenuMode !== 'multiplayer' || document.hidden) return;
    ensureLobbyDirectoryClient().start();
  };

  const stopLobbyDirectory = () => {
    lobbyDirectoryClient?.stop();
  };

  const lobbyBrowser = new LobbyBrowserUI({
    onTabChange: (tab) => {
      if (tab === 'browse') {
        startLobbyDirectory();
        lobbyDirectoryClient?.requestList();
      }
    },
    onRefresh: () => {
      engine.sound.playUIClick();
      startLobbyDirectory();
      lobbyDirectoryClient?.requestList();
      lobbyBrowser.showMessage('Refreshing live lobbies from the server…');
    },
    onJoinLobby: (lobby, password) => {
      engine.sound.playUIClick();
      joinLobbySummary(lobby, password);
    },
    onJoinByCode: (code, password) => {
      engine.sound.playUIClick();
      void joinLobbyByCode(code, password);
    },
    onCreateLobby: (request) => {
      engine.sound.playUIClick();
      createNewLobby(request);
    },
    onReadyToggle: (ready) => {
      engine.sound.playUIClick();
      engine.setLobbyReady(ready);
    },
    onStartMatch: () => {
      engine.sound.playUIClick();
      engine.requestLobbyMatchStart();
    },
    onLeaveLobby: () => {
      engine.sound.playUIClick();
      leaveCurrentLobby(true);
    },
    onCloseLobby: () => {
      engine.sound.playUIClick();
      lobbyBrowser.showMessage('Closing this lobby for everyone…');
      engine.closeLobby();
    },
  });

  lobbyBrowser.setDefaultPlayerName(playerNameInput?.value || 'Commander_CI');
  playerNameInput?.addEventListener('input', () => {
    lobbyBrowser.setDefaultPlayerName(playerNameInput.value);
  });

  const updateMainMenuMode = () => {
    const multiplayer = mainMenuMode === 'multiplayer';
    soloBtn?.classList.toggle('active-pill', !multiplayer);
    onlineBtn?.classList.toggle('active-pill', multiplayer);
    soloControlsEl?.classList.toggle('hidden', multiplayer);
    lobbyBrowser.setVisible(multiplayer);
    if (launchBtn) {
      launchBtn.disabled = false;
      launchBtn.textContent = '🚀 DROP INTO ISLAND';
    }
    renderRoomStatusBar(activeLobbySnapshot);
    if (multiplayer) startLobbyDirectory();
    else stopLobbyDirectory();
  };

  const setMainMenuMode = (mode: 'solo' | 'multiplayer') => {
    if (mode === 'solo' && isLobbyConnectionPending()) {
      leaveCurrentLobby(false);
    }
    mainMenuMode = mode;
    updateMainMenuMode();
    if (mode === 'multiplayer') {
      window.requestAnimationFrame(() => {
        document
          .getElementById('multiplayer-browser')
          ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    }
  };

  soloBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    setMainMenuMode('solo');
  });

  onlineBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    setMainMenuMode('multiplayer');
  });

  botCountSelectEl?.addEventListener('change', () => {
    renderRoomStatusBar(activeLobbySnapshot);
  });
  loadoutSelectEl?.addEventListener('change', () => {
    engine.updateLobbyCharacterPreview(
      undefined,
      (loadoutSelectEl.value as StarterLoadoutType) || 'balanced'
    );
    syncOperatorShowcase();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLobbyDirectory();
    else startLobbyDirectory();
  });

  engine.onLobbyUpdated = (snapshot) => {
    if (snapshot && !snapshot.isLobbyManaged) return;
    const hadSnapshot = Boolean(activeLobbySnapshot);
    const previousRoomCode = activeLobbySnapshot?.roomCode || '';
    const previousHostPlayerId = activeLobbySnapshot?.hostPlayerId || '';
    activeLobbySnapshot = snapshot;
    pendingLobbyJoin = false;
    if (lobbyBusy) setLobbyBusy(false);
    if (snapshot) {
      mainMenuMode = 'multiplayer';
      soloBtn?.classList.remove('active-pill');
      onlineBtn?.classList.add('active-pill');
      soloControlsEl?.classList.add('hidden');
      lobbyBrowser.setVisible(true);
      lobbyBrowser.setCurrentSnapshot(snapshot);
      if (
        previousRoomCode === snapshot.roomCode &&
        previousHostPlayerId &&
        snapshot.hostPlayerId &&
        previousHostPlayerId !== snapshot.hostPlayerId
      ) {
        lobbyBrowser.showMessage(`Host transferred to ${snapshot.hostName}.`);
      }
      if (!hadSnapshot && snapshot.phase !== 'active') lobbyBrowser.setTab('mine');
      if (snapshot.phase === 'lobby' && previousRoomCode !== snapshot.roomCode) {
        lobbyBrowser.showMessage(
          snapshot.humanOnly
            ? `Connected to ${snapshot.name}. HUMAN PLAYERS ONLY — NO BOTS. Ready up when your squad is set.`
            : `Connected to ${snapshot.name}. ${snapshot.connectedHumans} humans + ${snapshot.botCount} AI bots configured.`
        );
      }
      renderRoomStatusBar(snapshot);
    } else {
      lobbyBrowser.setCurrentSnapshot(null);
      if (hadSnapshot && !engine.isRunningMatch && mainMenuMode === 'multiplayer') {
        lobbyBrowser.showMessage('You left the lobby. Browse or create a new one.');
      }
      renderRoomStatusBar(null);
      if (!engine.isRunningMatch) startLobbyDirectory();
    }
  };

  engine.onLobbyJoinRejected = (code, reason) => {
    activeLobbySnapshot = null;
    pendingLobbyJoin = false;
    setLobbyBusy(false);
    lobbyBrowser.setCurrentSnapshot(null);
    const friendlyReason =
      code === 'room_not_found'
        ? `Room not found. ${reason}`
        : code === 'room_full'
          ? `This lobby is full. ${reason}`
          : code === 'invalid_password'
            ? 'Invalid password. Check the lobby password and try again.'
            : code === 'match_in_progress'
              ? `This match has already started. ${reason}`
              : code === 'room_closed'
                ? `This lobby is closed. ${reason}`
                : reason;
    lobbyBrowser.showMessage(friendlyReason, true);
    if (
      code.startsWith('invalid_') ||
      code === 'duplicate_lobby' ||
      code === 'team_mode_requires_human_only' ||
      code === 'bots_forbidden'
    ) {
      lobbyBrowser.setTab('create');
    } else {
      lobbyBrowser.setTab('browse');
    }
    renderRoomStatusBar(null);
    startLobbyDirectory();
  };

  engine.onLobbyActionRejected = (reason) => {
    lobbyBrowser.showMessage(reason, true);
  };

  engine.onLobbyClosed = (_snapshot, reason) => {
    activeLobbySnapshot = null;
    pendingLobbyJoin = false;
    setLobbyBusy(false);
    lobbyBrowser.setCurrentSnapshot(null);
    lobbyBrowser.showMessage(reason || 'This lobby has been closed.', true);
    lobbyBrowser.setTab('browse');
    renderRoomStatusBar(null);
    startLobbyDirectory();
  };

  engine.onLobbyMatchStarted = (snapshot) => {
    activeLobbySnapshot = snapshot;
    pendingLobbyJoin = false;
    setLobbyBusy(false);
    lobbyBrowser.setCurrentSnapshot(snapshot);
    stopLobbyDirectory();
    renderRoomStatusBar(snapshot);
  };

  engine.onLobbyConnectionChange = (statusText, connected, connState, humanCount) => {
    if (activeLobbySnapshot) {
      renderRoomStatusBar(activeLobbySnapshot);
      return;
    }

    if (connStatusEl) {
      connStatusEl.textContent = statusText;
      connStatusEl.className =
        connState === 'error'
          ? 'room-status-tag err'
          : connState === 'reconnecting' || connState === 'connecting'
            ? 'room-status-tag warn'
            : 'room-status-tag';
    }
    if (playerCountEl) {
      if (mainMenuMode === 'multiplayer' || pendingLobbyJoin) {
        playerCountEl.textContent = connected
          ? `👥 ${humanCount} Humans Connected`
          : '👥 Multiplayer lobby connection pending';
      } else {
        const botCount = parseInt(botCountSelectEl?.value || '14', 10) || 14;
        playerCountEl.textContent = `👥 1 Human + ${botCount} AI Combatants`;
      }
    }

    if (connState === 'error' && pendingLobbyJoin && !activeLobbySnapshot) {
      pendingLobbyJoin = false;
      setLobbyBusy(false);
      lobbyBrowser.showMessage(
        'Connection lost while joining the lobby. Check your connection and try again.',
        true
      );
      lobbyBrowser.setTab('browse');
      startLobbyDirectory();
    }
  };

  updateMainMenuMode();

  if (pendingInviteCode) {
    setMainMenuMode('multiplayer');
    lobbyBrowser.setJoinCode(pendingInviteCode);
    lobbyBrowser.setTab('browse');
    lobbyBrowser.showMessage(`Invite received for room ${pendingInviteCode}. Joining…`);
    const inviteUrl = new URL(window.location.href);
    inviteUrl.searchParams.delete('room');
    inviteUrl.hash = '';
    window.history.replaceState({}, document.title, inviteUrl.toString());
    window.setTimeout(() => {
      void joinLobbyByCode(pendingInviteCode, '');
    }, 350);
  }

  const readLobbyConfig = (): LobbyConfig => {
    if (activeLobbySnapshot) {
      return buildBaseLobbyConfig(
        sessionModeForSnapshot(activeLobbySnapshot),
        activeLobbySnapshot.roomCode,
        {
          botCount: activeLobbySnapshot.botCount,
          difficulty: activeLobbySnapshot.botDifficulty,
          lobbyName: activeLobbySnapshot.name,
          maxPlayers: activeLobbySnapshot.maxPlayers,
          mapId: activeLobbySnapshot.mapId,
          teamMode: activeLobbySnapshot.teamMode,
          startCondition: activeLobbySnapshot.startCondition,
          visibility:
            activeLobbySnapshot.visibility === 'private' ? 'private' : 'public',
        }
      );
    }
    return buildBaseLobbyConfig(
      mainMenuMode === 'multiplayer' ? 'online' : 'solo_bots',
      'CICRAFT-1'
    );
  };

  document.getElementById('btn-launch-match')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    if (mainMenuMode === 'multiplayer') {
      lobbyBrowser.setTab(activeLobbySnapshot ? 'mine' : 'browse');
      lobbyBrowser.showMessage(
        activeLobbySnapshot
          ? 'Ready up in My Lobby — the server starts multiplayer matches.'
          : 'Join or create a live lobby to start a multiplayer match.'
      );
      return;
    }
    engine.startMatch(buildBaseLobbyConfig('solo_bots', 'CICRAFT-1'));
  });

  document.getElementById('btn-play-again')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    const wasMultiplayer =
      engine.currentConfig.mode !== 'solo_bots' ||
      Boolean(activeLobbySnapshot) ||
      engine.network.isLobbyManagedRoom;
    if (wasMultiplayer) {
      // Ended lobby rooms are not restarted into a partially reused roster.
      // Return to the live browser so players can join a fresh server lobby.
      engine.returnToMainMenu();
      activeLobbySnapshot = null;
      pendingLobbyJoin = false;
      setMainMenuMode('multiplayer');
      lobbyBrowser.setCurrentSnapshot(null);
      lobbyBrowser.setTab('browse');
      lobbyBrowser.showMessage('Find a fresh lobby or create a new one for the next match.');
      return;
    }
    engine.startMatch(buildBaseLobbyConfig('solo_bots', 'CICRAFT-1'));
  });

  document.getElementById('btn-spectate-match')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    engine.enterSpectatorMode();
  });

  document.getElementById('btn-spectator-next')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    engine.cycleSpectatorTarget();
  });

  document.getElementById('btn-spectator-menu')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    engine.returnToMainMenu();
  });

  document.getElementById('btn-end-main-menu')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    engine.returnToMainMenu();
  });

  // Pause & Settings Controls
  document.getElementById('hud-pause-btn')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    engine.togglePauseMenu(true);
  });

  document.getElementById('btn-resume-match')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    engine.togglePauseMenu(false);
  });

  document.getElementById('btn-restart-match')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    if (engine.currentConfig.mode !== 'solo_bots') {
      engine.returnToMainMenu();
      activeLobbySnapshot = null;
      pendingLobbyJoin = false;
      setMainMenuMode('multiplayer');
      lobbyBrowser.setTab('browse');
      lobbyBrowser.showMessage('Multiplayer matches restart from a fresh server lobby.');
      return;
    }
    engine.startMatch(engine.currentConfig);
  });

  document.getElementById('btn-return-menu')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    engine.returnToMainMenu();
  });

  const openSettings = () => {
    engine.sound.playUIClick();
    document.getElementById('settings-overlay')?.classList.remove('hidden');
  };

  document
    .getElementById('btn-open-settings-lobby')
    ?.addEventListener('click', openSettings);
  document
    .getElementById('btn-open-settings-pause')
    ?.addEventListener('click', openSettings);

  document.getElementById('btn-close-settings')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    document.getElementById('settings-overlay')?.classList.add('hidden');
  });

  // Fullscreen buttons are bound by MobileLandscapeManager below. It keeps
  // the existing lobby/settings/HUD buttons, hides them when fullscreen is
  // unsupported, and makes a best-effort landscape orientation request after
  // entering fullscreen. Browsers that reject either API keep working.

  // Settings Inputs Live Binding
  const sensInput = document.getElementById('setting-sensitivity') as HTMLInputElement;
  const sensVal = document.getElementById('val-sensitivity')!;
  sensInput?.addEventListener('input', () => {
    const v = parseFloat(sensInput.value);
    sensVal.textContent = `${v.toFixed(1)}x`;
    engine.applySettings({ mouseSensitivity: v });
  });

  const touchSensInput = document.getElementById(
    'setting-touch-sensitivity'
  ) as HTMLInputElement | null;
  const touchSensVal = document.getElementById('val-touch-sensitivity');
  touchSensInput?.addEventListener('input', () => {
    const v = parseFloat(touchSensInput.value);
    if (touchSensVal) touchSensVal.textContent = `${v.toFixed(1)}x`;
    engine.applySettings({ touchSensitivity: v });
  });

  const volInput = document.getElementById('setting-volume') as HTMLInputElement;
  const volVal = document.getElementById('val-volume')!;
  volInput?.addEventListener('input', () => {
    const pct = parseInt(volInput.value, 10);
    volVal.textContent = `${pct}%`;
    engine.applySettings({ audioVolume: pct / 100 });
  });

  const sfxVolInput = document.getElementById(
    'setting-sfx-volume'
  ) as HTMLInputElement;
  const sfxVolVal = document.getElementById('val-sfx-volume');
  sfxVolInput?.addEventListener('input', () => {
    const pct = parseInt(sfxVolInput.value, 10);
    if (sfxVolVal) sfxVolVal.textContent = `${pct}%`;
    engine.applySettings({ sfxVolume: pct / 100 });
  });

  const gfxSelect = document.getElementById('setting-graphics') as HTMLSelectElement;
  gfxSelect?.addEventListener('change', () => {
    engine.applySettings({
      graphicsQuality: gfxSelect.value as 'auto' | 'low' | 'medium' | 'high',
    });
  });

  const todSelect = document.getElementById('setting-timeofday') as HTMLSelectElement;
  todSelect?.addEventListener('change', () => {
    engine.applySettings({
      timeOfDay: todSelect.value as TimeOfDayPreset,
    });
  });

  const fpsCheck = document.getElementById('setting-show-fps') as HTMLInputElement;
  fpsCheck?.addEventListener('change', () => {
    engine.applySettings({ showFps: fpsCheck.checked });
  });

  const muteCheck = document.getElementById('setting-mute') as HTMLInputElement;
  const hudMuteBtn = document.getElementById('hud-mute-btn');
  const syncMuteUI = (muted: boolean) => {
    if (muteCheck) muteCheck.checked = muted;
    if (hudMuteBtn) hudMuteBtn.textContent = muted ? '🔇' : '🔊';
  };
  muteCheck?.addEventListener('change', () => {
    engine.sound.setMuted(muteCheck.checked);
    syncMuteUI(engine.sound.muted);
  });
  hudMuteBtn?.addEventListener('click', () => {
    const muted = engine.sound.toggleMute();
    syncMuteUI(muted);
    if (!muted) engine.sound.playUIClick();
  });

  // Pointer Lock & Mouse Look
  document.addEventListener('pointerlockchange', () => {
    engine.isPointerLocked = document.pointerLockElement !== null;
  });

  container.addEventListener('mousedown', (e) => {
    if (!engine.isRunningMatch || engine.isPaused) return;
    if (!engine.isPointerLocked) {
      engine.requestPointerLock();
    }
    if (e.button === 0) {
      engine.mouseFireHeld = true;
    } else if (e.button === 2) {
      engine.mouseAimHeld = true;
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      engine.mouseFireHeld = false;
    } else if (e.button === 2) {
      engine.mouseAimHeld = false;
    }
  });

  window.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('mousemove', (e) => {
    if (engine.isRunningMatch && engine.isPointerLocked && !engine.isPaused) {
      engine.handleMouseMove(e.movementX, e.movementY);
    }
  });

  // Mouse Wheel Slot Cycling
  window.addEventListener('wheel', (e) => {
    if (!engine.isRunningMatch || engine.isPaused) return;
    engine.pendingSlotSelect = e.deltaY > 0 ? -2 : -3;
  });

  const toggleBuildPiece = (type: BuildPieceType) => {
    if (engine.activeBuildPreview === type) {
      engine.pendingBuild = type;
      engine.activeBuildPreview = null;
      engine.hud.updateBuildModeIndicator(null);
    } else {
      engine.activeBuildPreview = type;
      engine.hud.updateBuildModeIndicator(type);
    }
  };

  // Keyboard Controls
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      e.preventDefault();
      engine.togglePerfMonitor();
      return;
    }

    if (e.code === 'Escape' && engine.isRunningMatch) {
      engine.togglePauseMenu();
      return;
    }

    if (!engine.isRunningMatch || engine.isPaused) return;
    engine.keys.add(e.code);

    if (e.code === 'Digit1') engine.pendingSlotSelect = 0;
    else if (e.code === 'Digit2') engine.pendingSlotSelect = 1;
    else if (e.code === 'Digit3') engine.pendingSlotSelect = 2;
    else if (e.code === 'Digit4') engine.pendingSlotSelect = 3;
    else if (e.code === 'Digit5') engine.pendingSlotSelect = 4;
    else if (e.code === 'KeyF') engine.pendingInteract = true;
    else if (e.code === 'KeyR') engine.pendingReload = true;
    else if (e.code === 'KeyG') engine.pendingCycleMaterial = true;
    else if (e.code === 'KeyM') {
      const muted = engine.sound.toggleMute();
      syncMuteUI(muted);
    }
    else if (e.code === 'KeyN') engine.cycleSpectatorTarget();
    else if (e.code === 'KeyQ') toggleBuildPiece('wall');
    else if (e.code === 'KeyE') toggleBuildPiece('ramp');
    else if (e.code === 'KeyC') toggleBuildPiece('floor');
    else if (e.code === 'KeyV') toggleBuildPiece('roof');
  });

  window.addEventListener('keyup', (e) => {
    engine.keys.delete(e.code);
  });

  // Mobile Touch Controls
  //
  // MobileTouchControls owns only browser pointer/touch bookkeeping. Every
  // callback below writes the same GameEngine fields consumed by the shared
  // PlayerInputPacket -> PlayerController -> ThirdPersonCamera pipeline used
  // by WASD/mouse, so solo, legacy online, and human-only multiplayer all
  // receive identical movement/combat/build behaviour.
  const mobileTouchControls = MobileTouchControls.fromDocument(document, {
    isGameplayActive: () => engine.isRunningMatch && !engine.isPaused,
    onMove: (moveX, moveZ, sprint) => {
      engine.mobileMoveX = moveX;
      engine.mobileMoveZ = moveZ;
      engine.mobileSprint = sprint;
    },
    onLook: (deltaX, deltaY) => {
      // Desktop pointer lock remains authoritative when it is engaged.
      if (!engine.isPointerLocked) {
        engine.handleTouchLook(deltaX, deltaY);
      }
    },
    setFireHeld: (held) => {
      engine.touchFireHeld = held;
    },
    onAimToggle: () => {
      engine.touchAimHeld = !engine.touchAimHeld;
      return engine.touchAimHeld;
    },
    setAimHeld: (held) => {
      engine.touchAimHeld = held;
    },
    onJump: () => {
      engine.mobileJump = true;
    },
    onReload: () => {
      engine.pendingReload = true;
    },
    onInteract: () => {
      engine.pendingInteract = true;
    },
    onCycleWeapon: () => {
      // Existing PlayerController convention: -2 cycles to the next slot.
      engine.pendingSlotSelect = -2;
    },
    onSelectSlot: (slotIndex) => {
      engine.pendingSlotSelect = slotIndex;
    },
    onBuildPiece: (piece) => {
      toggleBuildPiece(piece);
    },
    onCycleMaterial: () => {
      engine.pendingCycleMaterial = true;
    },
  });

  // Landscape/fullscreen chrome is deliberately separate from gameplay
  // input. The manager only shows the portrait prompt, attempts supported
  // fullscreen/orientation APIs, and blurs stale lobby text fields so the
  // software keyboard cannot cover the HUD after a match starts. Showing
  // the prompt resets held touch state; it never changes server movement,
  // weapons, building, bot counts, or match balance.
  let mobileLandscape: MobileLandscapeManager | null = null;
  mobileLandscape = MobileLandscapeManager.fromDocument(document, {
    isGameplayActive: () => engine.isRunningMatch && !engine.isPaused,
    onPromptVisibilityChange: (visible) => {
      if (visible) mobileTouchControls?.resetAll();
      mobileLandscape?.blurActiveTextEntry();
    },
    onUserGesture: () => {
      engine.sound.playUIClick();
    },
  });

  // Keep the touch UI's pointer/ADS-toggle state in sync whenever the
  // engine clears held input (pause, match start/end, return to menu).
  // Match start is also the point where any focused lobby/account field is
  // blurred, guaranteeing no virtual keyboard during normal gameplay.
  engine.onTransientInputCleared = () => {
    mobileTouchControls?.resetAll();
    mobileLandscape?.blurActiveTextEntry();
    mobileLandscape?.refresh();
    // startMatch clears transient input just before isRunningMatch flips
    // true. Re-check next frame for server-started lobby matches where the
    // player may not have tapped a button to move focus away from a field.
    window.requestAnimationFrame(() => {
      mobileLandscape?.blurActiveTextEntry();
    });
  };

  // Suppress compatibility mouse events for touch/pen taps that land on
  // bare canvas outside the dedicated touch surfaces, so a stray tap can
  // never synthesize a desktop mouse-fire. Real mouse input is untouched.
  container.addEventListener(
    'pointerdown',
    (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  // Release held touch state if the page is hidden/unloaded. The controller
  // also exposes destroy() for complete listener removal if this UI is ever
  // mounted/unmounted dynamically.
  window.addEventListener('pagehide', () => {
    mobileTouchControls?.resetAll();
  });
});
