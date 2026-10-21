import './styles/main.css';
import { GameEngine } from './core/GameEngine';
import {
  BackAccessoryType,
  BotDifficulty,
  BuildPieceType,
  LobbyConfig,
  OutfitPresetId,
  RoomSnapshot,
  SessionMode,
  StarterLoadoutType,
  TimeOfDayPreset,
  effectiveBotCountForMode,
  isHumanOnlySessionMode,
} from './network/schemas';
import {
  ACCENT_COLOR_SWATCHES,
  ARMOR_COLOR_SWATCHES,
  OUTFIT_PRESETS,
} from './systems/ProgressionSystem';

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
  const syncLockerUI = () => {
    const c = engine.progression.cosmetics;
    const presetObj =
      OUTFIT_PRESETS.find((o) => o.id === c.outfitId) || OUTFIT_PRESETS[0];
    const previewNameEl = document.getElementById('preview-outfit-name');
    if (previewNameEl) previewNameEl.textContent = presetObj.name;

    document.querySelectorAll<HTMLButtonElement>('.outfit-btn').forEach((btn) => {
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

  const modeSelectEl = document.getElementById('lobby-mode') as HTMLSelectElement;
  const soloBtn = document.getElementById('btn-mode-solo');
  const onlineBtn = document.getElementById('btn-mode-online');
  const humanPublicBtn = document.getElementById('btn-mode-human-public');
  const humanPrivateBtn = document.getElementById('btn-mode-human-private');
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

  const roomCodeInput = document.getElementById('lobby-room-code') as HTMLInputElement;
  const genRoomBtn = document.getElementById('btn-generate-room-code');

  const humanLobbyPanel = document.getElementById('human-lobby-panel');
  const humanLobbyRoomTypeEl = document.getElementById('human-lobby-room-type');
  const humanLobbyMessageEl = document.getElementById('human-lobby-status-message');
  const humanConnectedCountEl = document.getElementById('human-connected-count');
  const humanReadyCountEl = document.getElementById('human-ready-count');
  const humanMatchStatusEl = document.getElementById('human-match-status');
  const humanBotCountEl = document.getElementById('human-bot-count');
  const humanRosterEl = document.getElementById('human-lobby-roster');
  const humanCreateBtn = document.getElementById(
    'btn-human-create-room'
  ) as HTMLButtonElement | null;
  const humanJoinBtn = document.getElementById(
    'btn-human-join-room'
  ) as HTMLButtonElement | null;
  const humanReadyBtn = document.getElementById(
    'btn-human-ready'
  ) as HTMLButtonElement | null;
  const humanStartBtn = document.getElementById(
    'btn-human-start-match'
  ) as HTMLButtonElement | null;
  const humanLeaveBtn = document.getElementById(
    'btn-human-leave-room'
  ) as HTMLButtonElement | null;

  let activeHumanSnapshot: RoomSnapshot | null = null;
  let humanLobbyBusy = false;
  let humanLobbyNotice = '';
  let humanLobbyNoticeIsError = false;

  const getSelectedSessionMode = (): SessionMode => {
    const value = modeSelectEl?.value;
    if (
      value === 'online' ||
      value === 'human_only_public' ||
      value === 'human_only_private' ||
      value === 'solo_bots'
    ) {
      return value;
    }
    return 'solo_bots';
  };

  const sessionModeForSnapshot = (snapshot: RoomSnapshot): SessionMode =>
    snapshot.mode === 'human_only_private'
      ? 'human_only_private'
      : snapshot.mode === 'human_only_public'
        ? 'human_only_public'
        : 'online';

  const humanPhaseLabel = (snapshot: RoomSnapshot | null): string => {
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

  const isHumanLobbyConnectionPending = (): boolean =>
    Boolean(activeHumanSnapshot) ||
    (engine.network.isOnlineRoom &&
      isHumanOnlySessionMode(getSelectedSessionMode()) &&
      (engine.network.roomConnected ||
        engine.network.connectionState === 'connecting' ||
        engine.network.connectionState === 'reconnecting'));

  const renderHumanLobbyPanel = () => {
    const selectedMode = getSelectedSessionMode();
    const isHumanMode = isHumanOnlySessionMode(selectedMode);
    humanLobbyPanel?.classList.toggle('hidden', !isHumanMode);

    if (botCountSelectEl) botCountSelectEl.disabled = isHumanMode;
    if (difficultySelectEl) difficultySelectEl.disabled = isHumanMode;

    if (!isHumanMode) {
      if (roomCodeInput) roomCodeInput.disabled = false;
      if (launchBtn) {
        launchBtn.disabled = false;
        launchBtn.textContent = '🚀 DROP INTO ISLAND';
      }
      return;
    }

    const snapshot = activeHumanSnapshot;
    const isPrivate = selectedMode === 'human_only_private';
    const connectedHumans = snapshot?.connectedHumans ?? 0;
    const readyHumans = snapshot?.readyHumans ?? 0;
    const maxPlayers = snapshot?.maxPlayers ?? 20;
    const minPlayers = snapshot?.minPlayers ?? 2;
    const selfPlayerId = snapshot?.selfPlayerId || engine.network.serverPlayerId;
    const selfPlayer = snapshot?.players.find((player) => player.id === selfPlayerId);
    const inRoom = isHumanLobbyConnectionPending();
    const inLobbyPhase =
      snapshot?.phase === 'lobby' || snapshot?.phase === 'countdown';

    if (humanLobbyRoomTypeEl) {
      humanLobbyRoomTypeEl.textContent = isPrivate
        ? 'PRIVATE HUMAN ROOM'
        : 'PUBLIC HUMAN LOBBY';
    }
    if (humanConnectedCountEl) {
      humanConnectedCountEl.textContent = `${connectedHumans} / ${maxPlayers}`;
    }
    if (humanReadyCountEl) {
      humanReadyCountEl.textContent = `${readyHumans} / ${Math.max(connectedHumans, minPlayers)}`;
    }
    if (humanMatchStatusEl) {
      humanMatchStatusEl.textContent = humanLobbyBusy
        ? 'CONNECTING'
        : humanPhaseLabel(snapshot);
    }
    if (humanBotCountEl) humanBotCountEl.textContent = '0';

    let message = humanLobbyNotice;
    if (!message) {
      if (!snapshot) {
        message = isPrivate
          ? `Waiting for players... Create a private human room, share its HUM code, and ready up. At least ${minPlayers} connected humans are required; AI bots will never be added.`
          : `Waiting for players... Find or join a public human lobby and ready up. At least ${minPlayers} connected humans are required; AI bots will never be added.`;
      } else if (snapshot.phase === 'lobby' && connectedHumans < minPlayers) {
        message = `Waiting for players... ${connectedHumans}/${minPlayers} humans connected. Share room code ${snapshot.roomCode} with another real player.`;
      } else if (snapshot.phase === 'lobby' && readyHumans < connectedHumans) {
        message = `Waiting for readiness... ${readyHumans}/${connectedHumans} connected humans are ready. Every connected human must ready up before the server starts.`;
      } else if (snapshot.phase === 'lobby') {
        message = 'Everyone is ready. The server is validating the human-only roster and will start the countdown.';
      } else if (snapshot.phase === 'countdown') {
        message = `All ${connectedHumans} humans are ready. Match starting with 0 bots...`;
      } else if (snapshot.phase === 'active') {
        message = `Match live with ${snapshot.matchParticipantCount} human participants and 0 bots.`;
      } else {
        message = snapshot.winnerName
          ? `Match ended. Winner: ${snapshot.winnerName}.`
          : 'Match ended.';
      }
    }
    if (humanLobbyMessageEl) {
      humanLobbyMessageEl.textContent = message;
      humanLobbyMessageEl.classList.toggle(
        'err',
        Boolean(humanLobbyNotice && humanLobbyNoticeIsError)
      );
    }

    if (connStatusEl) {
      connStatusEl.className = humanLobbyNoticeIsError && humanLobbyNotice
        ? 'room-status-tag err'
        : snapshot
          ? 'room-status-tag'
          : 'room-status-tag warn';
      connStatusEl.textContent = snapshot
        ? `👥 ROOM ${snapshot.roomCode} • HUMAN PLAYERS ONLY — NO BOTS • ${humanPhaseLabel(snapshot)}`
        : '👥 HUMAN PLAYERS ONLY — NO BOTS';
    }
    if (playerCountEl) {
      playerCountEl.textContent = `👥 ${connectedHumans}/${maxPlayers} Humans • ${readyHumans} Ready • 0 Bots`;
    }

    if (roomCodeInput) {
      roomCodeInput.disabled = inRoom;
      roomCodeInput.placeholder = isPrivate
        ? 'HUM-XXXX'
        : 'HPLAY-XXXX (or use Find Room)';
      if (snapshot) roomCodeInput.value = snapshot.roomCode;
    }

    if (humanCreateBtn) {
      humanCreateBtn.disabled = humanLobbyBusy || inRoom || engine.isRunningMatch;
      humanCreateBtn.textContent = isPrivate
        ? '🏠 CREATE ROOM'
        : '🔎 FIND / CREATE ROOM';
    }
    if (humanJoinBtn) {
      humanJoinBtn.disabled = humanLobbyBusy || inRoom || engine.isRunningMatch;
      humanJoinBtn.textContent = isPrivate ? '➡️ JOIN ROOM' : '➡️ JOIN ROOM CODE';
    }
    if (humanReadyBtn) {
      humanReadyBtn.disabled = !snapshot || !inLobbyPhase || !selfPlayer;
      humanReadyBtn.textContent = selfPlayer?.isReady ? '↩️ UNREADY' : '✅ READY';
    }
    if (humanStartBtn) {
      humanStartBtn.disabled =
        !snapshot ||
        snapshot.phase !== 'lobby' ||
        connectedHumans < minPlayers ||
        !selfPlayer;
      humanStartBtn.textContent = snapshot?.canStart
        ? '🚀 START MATCH'
        : selfPlayer?.isReady
          ? '🚀 REQUEST START'
          : '✅ READY + REQUEST START';
    }
    if (humanLeaveBtn) humanLeaveBtn.disabled = !inRoom && !humanLobbyBusy;

    if (launchBtn) {
      if (!snapshot) {
        launchBtn.disabled = humanLobbyBusy || inRoom;
        launchBtn.textContent = isPrivate
          ? '🏠 CREATE / JOIN HUMAN ROOM'
          : '🔎 FIND HUMAN ROOM';
      } else if (snapshot.phase === 'lobby') {
        launchBtn.disabled = connectedHumans < minPlayers;
        launchBtn.textContent =
          connectedHumans < minPlayers
            ? `⏳ WAITING FOR ${minPlayers - connectedHumans} MORE HUMAN${minPlayers - connectedHumans === 1 ? '' : 'S'}`
            : '✅ READY / START WHEN ALL READY';
      } else if (snapshot.phase === 'countdown') {
        launchBtn.disabled = true;
        launchBtn.textContent = '⏳ MATCH STARTING...';
      } else {
        launchBtn.disabled = true;
        launchBtn.textContent = snapshot.phase === 'active' ? '👥 MATCH LIVE' : '🏁 MATCH ENDED';
      }
    }

    if (humanRosterEl) {
      humanRosterEl.replaceChildren();
      const humanPlayers = (snapshot?.players || []).filter(
        (player) => player.participantType === 'human' && !player.isBot
      );
      if (humanPlayers.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'human-roster-empty';
        empty.textContent = 'No connected humans yet. Waiting for players...';
        humanRosterEl.appendChild(empty);
      } else {
        for (const player of humanPlayers) {
          const row = document.createElement('div');
          row.className = `human-roster-player${player.isReady ? ' ready' : ''}${
            player.isConnected ? '' : ' disconnected'
          }`;

          const name = document.createElement('span');
          name.className = 'roster-name';
          name.textContent = `${player.isConnected ? '🟢' : '⚪'} ${player.name}${
            player.id === selfPlayerId ? ' (YOU)' : ''
          }`;

          const status = document.createElement('span');
          status.className = 'roster-status';
          status.textContent = !player.isConnected
            ? 'RECONNECTING'
            : snapshot?.phase === 'active'
              ? player.alive
                ? 'IN MATCH'
                : 'ELIMINATED'
              : player.isReady
                ? 'READY'
                : 'NOT READY';

          row.append(name, status);
          humanRosterEl.appendChild(row);
        }
      }
    }
  };

  const buildHumanLobbyConfig = (
    mode: SessionMode,
    roomCode: string
  ): LobbyConfig => {
    const nameInput = document.getElementById(
      'lobby-player-name'
    ) as HTMLInputElement | null;
    const skyDropCheck = document.getElementById(
      'lobby-skydrop'
    ) as HTMLInputElement | null;
    return {
      playerName: nameInput?.value || 'Commander_CI',
      mode,
      roomCode,
      botCount: 0,
      difficulty: (difficultySelectEl?.value as BotDifficulty) || 'medium',
      skyDrop: skyDropCheck?.checked ?? true,
      starterLoadout:
        (loadoutSelectEl?.value as StarterLoadoutType) || 'balanced',
      cosmetics: engine.progression.cosmetics,
    };
  };

  const ensureVerifiedHumanAccount = async (callsign: string): Promise<boolean> => {
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

  const setHumanLobbyNotice = (message: string, isError = false) => {
    humanLobbyNotice = message;
    humanLobbyNoticeIsError = isError;
    renderHumanLobbyPanel();
  };

  const resolveHumanRoomCode = async (
    action: 'create' | 'join'
  ): Promise<string | null> => {
    const mode = getSelectedSessionMode();
    if (!isHumanOnlySessionMode(mode)) return null;
    const enteredCode = (roomCodeInput?.value || '').trim().toUpperCase();

    if (mode === 'human_only_private') {
      if (action === 'create') {
        return engine.network.createPrivateRoom(mode);
      }
      if (!enteredCode.startsWith('HUM-')) {
        setHumanLobbyNotice(
          'Enter a valid private human room code beginning with HUM-, or create a new private room.',
          true
        );
        return null;
      }
      const status = await engine.network.fetchRoomStatus(enteredCode);
      if (
        status.ok &&
        status.exists &&
        (status.mode !== 'human_only_private' || !status.humanOnly || status.botCount !== 0)
      ) {
        setHumanLobbyNotice(
          'That room is not a verified private human-only room, so it cannot be joined from this mode.',
          true
        );
        return null;
      }
      return enteredCode;
    }

    if (action === 'join' && enteredCode.startsWith('HPLAY-')) {
      const status = await engine.network.fetchRoomStatus(enteredCode);
      if (
        status.ok &&
        status.exists &&
        (status.mode !== 'human_only_public' || !status.humanOnly || status.botCount !== 0)
      ) {
        setHumanLobbyNotice(
          'That room is not a verified public human-only room, so it cannot be joined from this mode.',
          true
        );
        return null;
      }
      return enteredCode;
    }

    const match = await engine.network.matchmakeHumanRoom();
    if (match.ok && match.roomCode) return match.roomCode;
    return engine.network.createPrivateRoom(mode);
  };

  const enterHumanLobby = async (action: 'create' | 'join') => {
    const mode = getSelectedSessionMode();
    if (!isHumanOnlySessionMode(mode) || humanLobbyBusy || engine.isRunningMatch) {
      return;
    }
    if (isHumanLobbyConnectionPending()) {
      setHumanLobbyNotice('Leave the current human room before joining another one.');
      return;
    }

    humanLobbyBusy = true;
    humanLobbyNotice = '';
    humanLobbyNoticeIsError = false;
    renderHumanLobbyPanel();

    try {
      const roomCode = await resolveHumanRoomCode(action);
      if (!roomCode) return;
      if (roomCodeInput) roomCodeInput.value = roomCode;

      const config = buildHumanLobbyConfig(mode, roomCode);
      const verified = await ensureVerifiedHumanAccount(config.playerName);
      if (!verified) {
        setHumanLobbyNotice(
          'Could not verify a persistent server account. Check your connection or link your account passkey, then try again. Human-only rooms require authenticated real accounts.',
          true
        );
        return;
      }

      humanLobbyNotice = `Connecting to ${roomCode}... Waiting for players...`;
      humanLobbyNoticeIsError = false;
      engine.joinHumanLobby(config);
      renderHumanLobbyPanel();
    } finally {
      humanLobbyBusy = false;
      renderHumanLobbyPanel();
    }
  };

  const leaveCurrentHumanLobby = (showNotice = true) => {
    if (!activeHumanSnapshot && !isHumanLobbyConnectionPending()) return;
    activeHumanSnapshot = null;
    humanLobbyNotice = showNotice
      ? 'You left the human-only room. Your seat, ready state, and lobby counts were released on the server.'
      : '';
    humanLobbyNoticeIsError = false;
    engine.leaveHumanLobby();
    renderHumanLobbyPanel();
  };

  const refreshOnlineRoomOccupancy = async () => {
    const isOnline = getSelectedSessionMode() === 'online';
    if (!isOnline || engine.isRunningMatch) return;
    const code = (roomCodeInput?.value || 'CICRAFT-1').trim().toUpperCase();
    const status = await engine.network.fetchRoomStatus(code);
    const botCount = parseInt(botCountSelectEl?.value || '14', 10) || 14;
    if (status.ok) {
      if (connStatusEl) {
        connStatusEl.className = 'room-status-tag';
        connStatusEl.textContent =
          status.connectedPlayers > 0
            ? `🟢 ROOM ${status.roomCode} • ${status.connectedPlayers} ONLINE NOW`
            : `🟢 ROOM ${status.roomCode} • READY TO JOIN / HOST`;
      }
      if (playerCountEl) {
        playerCountEl.textContent =
          status.connectedPlayers > 0
            ? `👥 ${status.connectedPlayers} Human in Room + up to ${botCount} AI Fill`
            : `👥 Private/Public Room + up to ${botCount} AI Fill`;
      }
    }
  };

  const updateLobbyModeSummary = () => {
    const mode = getSelectedSessionMode();
    soloBtn?.classList.toggle('active-pill', mode === 'solo_bots');
    onlineBtn?.classList.toggle('active-pill', mode === 'online');
    humanPublicBtn?.classList.toggle('active-pill', mode === 'human_only_public');
    humanPrivateBtn?.classList.toggle('active-pill', mode === 'human_only_private');

    if (roomCodeInput && !isHumanOnlySessionMode(mode)) {
      roomCodeInput.placeholder = 'CICRAFT-1';
    }

    if (isHumanOnlySessionMode(mode)) {
      renderHumanLobbyPanel();
      return;
    }

    humanLobbyPanel?.classList.add('hidden');
    if (botCountSelectEl) botCountSelectEl.disabled = false;
    if (difficultySelectEl) difficultySelectEl.disabled = false;
    if (roomCodeInput) roomCodeInput.disabled = false;
    if (launchBtn) {
      launchBtn.disabled = false;
      launchBtn.textContent = '🚀 DROP INTO ISLAND';
    }

    const isOnline = mode === 'online';
    const botCount = parseInt(botCountSelectEl?.value || '14', 10) || 14;
    if (connStatusEl) {
      connStatusEl.className = 'room-status-tag';
      connStatusEl.textContent = isOnline
        ? '🌐 CHECKING ROOM SERVER...'
        : '🟢 READY • SOLO + AI BOTS';
    }
    if (playerCountEl) {
      playerCountEl.textContent = isOnline
        ? `👥 Room Lobby + up to ${botCount} AI Fill`
        : `👥 1 Human + ${botCount} AI Combatants`;
    }
    if (isOnline) {
      void refreshOnlineRoomOccupancy();
    }
  };

  const setSelectedSessionMode = (mode: SessionMode) => {
    const currentHumanMode = activeHumanSnapshot
      ? sessionModeForSnapshot(activeHumanSnapshot)
      : getSelectedSessionMode();
    if (
      activeHumanSnapshot &&
      isHumanOnlySessionMode(currentHumanMode) &&
      currentHumanMode !== mode
    ) {
      leaveCurrentHumanLobby(false);
    }
    if (modeSelectEl) modeSelectEl.value = mode;
    humanLobbyNotice = '';
    humanLobbyNoticeIsError = false;
    updateLobbyModeSummary();
  };

  genRoomBtn?.addEventListener('click', async () => {
    engine.sound.playUIClick();
    const mode = getSelectedSessionMode();
    if (isHumanLobbyConnectionPending()) {
      setHumanLobbyNotice('Leave the current human room before generating another room code.');
      return;
    }
    const targetMode = mode === 'solo_bots' ? 'online' : mode;
    const newCode = await engine.network.createPrivateRoom(targetMode);
    if (roomCodeInput) roomCodeInput.value = newCode;
    if (mode === 'solo_bots' && modeSelectEl) {
      modeSelectEl.value = 'online';
    }
    updateLobbyModeSummary();
  });

  roomCodeInput?.addEventListener('change', () => {
    if (isHumanOnlySessionMode(getSelectedSessionMode())) {
      humanLobbyNotice = '';
      humanLobbyNoticeIsError = false;
      renderHumanLobbyPanel();
      return;
    }
    void refreshOnlineRoomOccupancy();
  });

  soloBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    setSelectedSessionMode('solo_bots');
  });

  onlineBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    setSelectedSessionMode('online');
  });

  humanPublicBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    setSelectedSessionMode('human_only_public');
  });

  humanPrivateBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    setSelectedSessionMode('human_only_private');
  });

  humanCreateBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    void enterHumanLobby('create');
  });

  humanJoinBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    void enterHumanLobby('join');
  });

  humanReadyBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    const selfPlayerId =
      activeHumanSnapshot?.selfPlayerId || engine.network.serverPlayerId;
    const selfPlayer = activeHumanSnapshot?.players.find(
      (player) => player.id === selfPlayerId
    );
    humanLobbyNotice = '';
    humanLobbyNoticeIsError = false;
    engine.setHumanLobbyReady(!selfPlayer?.isReady);
    renderHumanLobbyPanel();
  });

  humanStartBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    humanLobbyNotice = '';
    humanLobbyNoticeIsError = false;
    engine.requestHumanMatchStart();
    renderHumanLobbyPanel();
  });

  humanLeaveBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    leaveCurrentHumanLobby(true);
  });

  modeSelectEl?.addEventListener('change', () => {
    setSelectedSessionMode(getSelectedSessionMode());
  });
  botCountSelectEl?.addEventListener('change', updateLobbyModeSummary);
  loadoutSelectEl?.addEventListener('change', () => {
    engine.updateLobbyCharacterPreview(
      undefined,
      (loadoutSelectEl.value as StarterLoadoutType) || 'balanced'
    );
  });

  engine.onHumanLobbyUpdated = (snapshot) => {
    if (snapshot && !snapshot.humanOnly) return;
    const previousPhase = activeHumanSnapshot?.phase;
    activeHumanSnapshot = snapshot;
    if (snapshot) {
      if (previousPhase !== snapshot.phase) {
        humanLobbyNotice = '';
        humanLobbyNoticeIsError = false;
      }
      const snapshotMode = sessionModeForSnapshot(snapshot);
      if (modeSelectEl && isHumanOnlySessionMode(snapshotMode)) {
        modeSelectEl.value = snapshotMode;
      }
      if (roomCodeInput) roomCodeInput.value = snapshot.roomCode;
      soloBtn?.classList.toggle('active-pill', snapshotMode === 'solo_bots');
      onlineBtn?.classList.toggle('active-pill', snapshotMode === 'online');
      humanPublicBtn?.classList.toggle(
        'active-pill',
        snapshotMode === 'human_only_public'
      );
      humanPrivateBtn?.classList.toggle(
        'active-pill',
        snapshotMode === 'human_only_private'
      );
    }
    renderHumanLobbyPanel();
  };

  engine.onHumanLobbyJoinRejected = (_code, reason) => {
    activeHumanSnapshot = null;
    setHumanLobbyNotice(reason, true);
  };

  engine.onHumanRoomActionRejected = (reason) => {
    setHumanLobbyNotice(reason, true);
  };

  engine.onHumanMatchStarted = (snapshot) => {
    activeHumanSnapshot = snapshot;
    humanLobbyNotice = '';
    humanLobbyNoticeIsError = false;
    renderHumanLobbyPanel();
  };

  engine.onLobbyConnectionChange = (statusText, connected, connState, humanCount) => {
    const mode = engine.isRunningMatch
      ? engine.currentConfig.mode
      : getSelectedSessionMode();
    if (isHumanOnlySessionMode(mode)) {
      if (connStatusEl && !activeHumanSnapshot) {
        connStatusEl.textContent = statusText;
        connStatusEl.className =
          connState === 'error'
            ? 'room-status-tag err'
            : connState === 'reconnecting' || connState === 'connecting'
              ? 'room-status-tag warn'
              : 'room-status-tag';
      }
      if (playerCountEl && !activeHumanSnapshot) {
        playerCountEl.textContent = connected
          ? `👥 ${humanCount} Humans Connected • 0 Bots`
          : '👥 0 Humans Connected • 0 Bots';
      }
      renderHumanLobbyPanel();
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
      const botCount = parseInt(botCountSelectEl?.value || '14', 10) || 14;
      playerCountEl.textContent = connected
        ? `👥 ${humanCount} Human Connected + ${botCount} AI`
        : `👥 1 Human + ${botCount} AI Combatants`;
    }
  };

  // Copy Room Code Action
  const copyBtn = document.getElementById('btn-copy-room-code');
  copyBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    const code = (roomCodeInput?.value || 'CICRAFT-1').trim().toUpperCase();
    navigator.clipboard?.writeText(code).catch(() => {});
    if (copyBtn) {
      copyBtn.textContent = '✅ COPIED!';
      setTimeout(() => {
        copyBtn.textContent = '📋 COPY';
      }, 1500);
    }
  });

  const readLobbyConfig = (): LobbyConfig => {
    const nameInput = document.getElementById('lobby-player-name') as HTMLInputElement;
    const loadoutSelect = document.getElementById('lobby-starter-loadout') as HTMLSelectElement;
    const modeSelect = document.getElementById('lobby-mode') as HTMLSelectElement;
    const roomInput = document.getElementById('lobby-room-code') as HTMLInputElement;
    const botCountSelect = document.getElementById('lobby-bot-count') as HTMLSelectElement;
    const diffSelect = document.getElementById('lobby-difficulty') as HTMLSelectElement;
    const skyDropCheck = document.getElementById('lobby-skydrop') as HTMLInputElement;

    const requestedMode = modeSelect.value as SessionMode;
    const mode: SessionMode =
      requestedMode === 'online' ||
      requestedMode === 'human_only_public' ||
      requestedMode === 'human_only_private' ||
      requestedMode === 'solo_bots'
        ? requestedMode
        : 'solo_bots';
    const requestedBotCount = parseInt(botCountSelect.value, 10) || 14;

    return {
      playerName: nameInput.value || 'Commander_CI',
      mode,
      roomCode: (roomInput?.value || 'CICRAFT-1').trim().toUpperCase(),
      botCount: effectiveBotCountForMode(mode, requestedBotCount),
      difficulty: (diffSelect.value as BotDifficulty) || 'medium',
      skyDrop: skyDropCheck.checked,
      starterLoadout: (loadoutSelect?.value as StarterLoadoutType) || 'balanced',
      cosmetics: engine.progression.cosmetics,
    };
  };

  document.getElementById('btn-launch-match')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    const config = readLobbyConfig();
    if (isHumanOnlySessionMode(config.mode)) {
      if (
        activeHumanSnapshot &&
        (activeHumanSnapshot.phase === 'lobby' ||
          activeHumanSnapshot.phase === 'countdown')
      ) {
        humanLobbyNotice = '';
        humanLobbyNoticeIsError = false;
        engine.requestHumanMatchStart();
        renderHumanLobbyPanel();
      } else if (!activeHumanSnapshot) {
        const action =
          config.mode === 'human_only_private' &&
          (config.roomCode || '').startsWith('HUM-')
            ? 'join'
            : 'create';
        void enterHumanLobby(action);
      }
      return;
    }
    engine.startMatch(config);
  });

  document.getElementById('btn-play-again')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    const config = readLobbyConfig();
    if (isHumanOnlySessionMode(config.mode)) {
      // Ended human rooms cannot be restarted into a partially reused roster.
      // Return to the lobby and enter a fresh server-owned human room.
      engine.returnToMainMenu();
      activeHumanSnapshot = null;
      void enterHumanLobby('create');
      return;
    }
    engine.startMatch(config);
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

  // Fullscreen Toggle
  const toggleFullscreen = () => {
    engine.sound.playUIClick();
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };
  document
    .getElementById('btn-toggle-fullscreen')
    ?.addEventListener('click', toggleFullscreen);
  document
    .getElementById('btn-lobby-fullscreen')
    ?.addEventListener('click', toggleFullscreen);

  // Settings Inputs Live Binding
  const sensInput = document.getElementById('setting-sensitivity') as HTMLInputElement;
  const sensVal = document.getElementById('val-sensitivity')!;
  sensInput?.addEventListener('input', () => {
    const v = parseFloat(sensInput.value);
    sensVal.textContent = `${v.toFixed(1)}x`;
    engine.applySettings({ mouseSensitivity: v });
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
      graphicsQuality: gfxSelect.value as 'low' | 'medium' | 'high',
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
  const joyZone = document.getElementById('touch-joystick-zone');
  const joyKnob = document.getElementById('touch-joystick-knob');
  if (joyZone && joyKnob) {
    let joyOriginX = 0;
    let joyOriginY = 0;

    joyZone.addEventListener('touchstart', (e) => {
      const rect = joyZone.getBoundingClientRect();
      joyOriginX = rect.left + rect.width / 2;
      joyOriginY = rect.top + rect.height / 2;
      e.preventDefault();
    });

    joyZone.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      const dx = Math.max(-40, Math.min(40, t.clientX - joyOriginX));
      const dy = Math.max(-40, Math.min(40, t.clientY - joyOriginY));
      joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      engine.mobileMoveX = dx / 40;
      engine.mobileMoveZ = dy / 40;
      e.preventDefault();
    });

    joyZone.addEventListener('touchend', () => {
      joyKnob.style.transform = `translate(0px, 0px)`;
      engine.mobileMoveX = 0;
      engine.mobileMoveZ = 0;
    });
  }

  document.getElementById('touch-fire-btn')?.addEventListener('touchstart', (e) => {
    engine.mouseFireHeld = true;
    e.preventDefault();
  });
  document.getElementById('touch-fire-btn')?.addEventListener('touchend', () => {
    engine.mouseFireHeld = false;
  });
  document.getElementById('touch-aim-btn')?.addEventListener('touchstart', (e) => {
    engine.mouseAimHeld = !engine.mouseAimHeld;
    e.preventDefault();
  });
  document.getElementById('touch-jump-btn')?.addEventListener('touchstart', (e) => {
    engine.mobileJump = true;
    e.preventDefault();
  });
  document.getElementById('touch-loot-btn')?.addEventListener('touchstart', (e) => {
    engine.pendingInteract = true;
    e.preventDefault();
  });
  document.getElementById('touch-wall-btn')?.addEventListener('touchstart', (e) => {
    engine.pendingBuild = 'wall';
    e.preventDefault();
  });
  document.getElementById('touch-ramp-btn')?.addEventListener('touchstart', (e) => {
    engine.pendingBuild = 'ramp';
    e.preventDefault();
  });
  document.getElementById('touch-floor-btn')?.addEventListener('touchstart', (e) => {
    engine.pendingBuild = 'floor';
    e.preventDefault();
  });
  document.getElementById('touch-roof-btn')?.addEventListener('touchstart', (e) => {
    engine.pendingBuild = 'roof';
    e.preventDefault();
  });
});
