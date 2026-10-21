import './styles/main.css';
import { GameEngine } from './core/GameEngine';
import {
  BackAccessoryType,
  BotDifficulty,
  BuildPieceType,
  LobbyConfig,
  OutfitPresetId,
  StarterLoadoutType,
  TimeOfDayPreset,
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
  const connStatusEl = document.getElementById('lobby-conn-status');
  const playerCountEl = document.getElementById('lobby-player-count');
  const botCountSelectEl = document.getElementById('lobby-bot-count') as HTMLSelectElement;
  const loadoutSelectEl = document.getElementById(
    'lobby-starter-loadout'
  ) as HTMLSelectElement;

  const roomCodeInput = document.getElementById('lobby-room-code') as HTMLInputElement;
  const genRoomBtn = document.getElementById('btn-generate-room-code');

  const refreshOnlineRoomOccupancy = async () => {
    const isOnline = modeSelectEl?.value === 'online';
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
    const isOnline = modeSelectEl?.value === 'online';
    soloBtn?.classList.toggle('active-pill', !isOnline);
    onlineBtn?.classList.toggle('active-pill', isOnline);
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

  genRoomBtn?.addEventListener('click', async () => {
    engine.sound.playUIClick();
    const newCode = await engine.network.createPrivateRoom();
    if (roomCodeInput) {
      roomCodeInput.value = newCode;
    }
    if (modeSelectEl) {
      modeSelectEl.value = 'online';
    }
    updateLobbyModeSummary();
  });

  roomCodeInput?.addEventListener('change', () => {
    void refreshOnlineRoomOccupancy();
  });

  soloBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    if (modeSelectEl) modeSelectEl.value = 'solo_bots';
    updateLobbyModeSummary();
  });

  onlineBtn?.addEventListener('click', () => {
    engine.sound.playUIClick();
    if (modeSelectEl) modeSelectEl.value = 'online';
    updateLobbyModeSummary();
  });

  modeSelectEl?.addEventListener('change', updateLobbyModeSummary);
  botCountSelectEl?.addEventListener('change', updateLobbyModeSummary);
  loadoutSelectEl?.addEventListener('change', () => {
    engine.updateLobbyCharacterPreview(
      undefined,
      (loadoutSelectEl.value as StarterLoadoutType) || 'balanced'
    );
  });

  engine.onLobbyConnectionChange = (statusText, connected, connState, humanCount) => {
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

    return {
      playerName: nameInput.value || 'Commander_CI',
      mode: modeSelect.value === 'online' ? 'online' : 'solo_bots',
      roomCode: roomInput?.value || 'CICRAFT-1',
      botCount: parseInt(botCountSelect.value, 10) || 14,
      difficulty: (diffSelect.value as BotDifficulty) || 'medium',
      skyDrop: skyDropCheck.checked,
      starterLoadout: (loadoutSelect?.value as StarterLoadoutType) || 'balanced',
      cosmetics: engine.progression.cosmetics,
    };
  };

  document.getElementById('btn-launch-match')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    engine.startMatch(readLobbyConfig());
  });

  document.getElementById('btn-play-again')?.addEventListener('click', () => {
    engine.sound.playUIClick();
    engine.startMatch(readLobbyConfig());
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
