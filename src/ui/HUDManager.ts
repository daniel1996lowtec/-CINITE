import * as THREE from 'three';
import {
  AmmoType,
  BuildPieceType,
  LootItemState,
  MatchState,
  PlayerState,
  WeaponCategory,
} from '../network/schemas';
import { RARITY_COLORS } from '../weapons/WeaponDefinitions';
import { ISLAND_POIS } from '../world/TerrainGenerator';
import { ISLAND_SETTLEMENTS } from '../world/WorldLayout';
import { getStormStatusLabel, isFinalStormPhase } from '../systems/StormConfig';

interface FloatingDamageNumber {
  el: HTMLDivElement;
  worldPos: THREE.Vector3;
  life: number;
  maxLife: number;
  offsetX: number;
  vx: number;
}

const WEAPON_ICONS: Record<WeaponCategory, string> = {
  harvester: '⛏️',
  pistol: '🔫',
  heavy_pistol: '🦏',
  assault_rifle: '🎯',
  burst_rifle: '⋮⋮⋮',
  dmr: '◎',
  shotgun: '💥',
  tactical_shotgun: '✦',
  smg: '⚡',
  sniper: '🔭',
  medkit: '🩹',
  shield_potion: '🧪',
};

export class HUDManager {
  private healthFill: HTMLElement;
  private healthText: HTMLElement;
  private shieldFill: HTMLElement;
  private shieldText: HTMLElement;
  private aliveCountEl: HTMLElement;
  private killCountEl: HTMLElement;
  private stormPhaseEl: HTMLElement;
  private stormTimerEl: HTMLElement;
  private stormVignette: HTMLElement;
  private activeWeaponName: HTMLElement;
  private activeAmmoClip: HTMLElement;
  private activeAmmoRes: HTMLElement;
  private woodCountEl: HTMLElement;
  private stoneCountEl: HTMLElement;
  private metalCountEl: HTMLElement;
  private matChipWood: HTMLElement;
  private matChipStone: HTMLElement;
  private matChipMetal: HTMLElement;
  private buildBtnWall: HTMLElement;
  private buildBtnRamp: HTMLElement;
  private buildBtnFloor: HTMLElement;
  private buildBtnRoof: HTMLElement;
  private pickupPrompt: HTMLElement;
  private reloadIndicator: HTMLElement;
  private reloadBarFill: HTMLElement | null;
  private hitmarkerEl: HTMLElement;
  private hitBadgeEl: HTMLElement | null;
  private lootToastEl: HTMLElement | null;
  private activeAmmoCardEl: HTMLElement | null;
  private crosshairEl: HTMLElement;
  private killfeedContainer: HTMLElement;
  private damageLayer: HTMLElement;
  private compassLabelEl: HTMLElement;
  private poiToastEl: HTMLElement;
  private elimBannerEl: HTMLElement | null;
  private netStatusPillEl: HTMLElement;
  private spectatorBannerEl: HTMLElement;
  private spectatorTargetEl: HTMLElement;
  private minimapCanvas: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D;

  private floatingDamages: FloatingDamageNumber[] = [];
  private hitmarkerTimer = 0;
  private lootToastTimer = 0;
  private reloadFlashTimer = 0;
  private elimBumpTimer = 0;
  private damageFlashTimer = 0;
  private poiToastTimer = 0;
  private elimBannerTimer = 0;
  private currentPoiName = '';
  private lastCamera: THREE.Camera | null = null;
  private readonly scratchProjVec = new THREE.Vector3();

  constructor() {
    this.healthFill = document.getElementById('hud-health-fill')!;
    this.healthText = document.getElementById('hud-health-text')!;
    this.shieldFill = document.getElementById('hud-shield-fill')!;
    this.shieldText = document.getElementById('hud-shield-text')!;
    this.aliveCountEl =
      document.getElementById('hud-alive-val') ||
      document.getElementById('hud-alive-count')!;
    this.killCountEl =
      document.getElementById('hud-kills-val') ||
      document.getElementById('hud-kill-count')!;
    this.stormPhaseEl = document.getElementById('hud-storm-phase')!;
    this.stormTimerEl = document.getElementById('hud-storm-timer')!;
    this.stormVignette = document.getElementById('storm-vignette')!;
    this.activeWeaponName =
      document.getElementById('hud-weapon-title') ||
      document.getElementById('hud-active-weapon-name')!;
    this.activeAmmoClip =
      document.getElementById('hud-ammo-clip') ||
      document.getElementById('hud-active-ammo-clip')!;
    this.activeAmmoRes =
      document.getElementById('hud-ammo-res') ||
      document.getElementById('hud-active-ammo-res')!;
    this.woodCountEl =
      document.getElementById('mat-wood-val') ||
      document.getElementById('hud-mat-wood')!;
    this.stoneCountEl =
      document.getElementById('mat-stone-val') ||
      document.getElementById('hud-mat-stone')!;
    this.metalCountEl =
      document.getElementById('mat-metal-val') ||
      document.getElementById('hud-mat-metal')!;
    this.matChipWood = document.getElementById('mat-chip-wood')!;
    this.matChipStone = document.getElementById('mat-chip-stone')!;
    this.matChipMetal = document.getElementById('mat-chip-metal')!;
    this.buildBtnWall = document.getElementById('build-btn-wall')!;
    this.buildBtnRamp = document.getElementById('build-btn-ramp')!;
    this.buildBtnFloor = document.getElementById('build-btn-floor')!;
    this.buildBtnRoof = document.getElementById('build-btn-roof')!;
    this.pickupPrompt = document.getElementById('hud-pickup-prompt')!;
    this.reloadIndicator =
      document.getElementById('hud-reload-banner') ||
      document.getElementById('hud-reload-indicator')!;
    this.reloadBarFill =
      document.getElementById('hud-reload-fill') ||
      document.getElementById('hud-reload-bar-fill');
    this.hitmarkerEl = document.getElementById('hud-hitmarker')!;
    this.hitBadgeEl = document.getElementById('hud-hit-badge');
    this.lootToastEl = document.getElementById('hud-loot-toast');
    this.activeAmmoCardEl = document.querySelector('.active-ammo-card');
    this.crosshairEl = document.getElementById('hud-crosshair')!;
    this.killfeedContainer = document.getElementById('hud-killfeed')!;
    this.damageLayer = document.getElementById('damage-numbers-layer')!;
    this.compassLabelEl =
      document.getElementById('hud-compass-pill') ||
      document.getElementById('hud-compass-label')!;
    this.poiToastEl = document.getElementById('hud-poi-toast')!;
    this.elimBannerEl = document.getElementById('hud-elim-banner');
    this.netStatusPillEl = document.getElementById('hud-net-status')!;
    this.spectatorBannerEl = document.getElementById('hud-spectator-banner')!;
    this.spectatorTargetEl =
      document.getElementById('spectator-target-name') ||
      document.getElementById('hud-spectator-target')!;
    this.minimapCanvas = document.getElementById(
      'minimap-canvas'
    ) as HTMLCanvasElement;
    this.minimapCtx = this.minimapCanvas?.getContext('2d')!;
  }

  public resetHUD(): void {
    this.hitmarkerTimer = 0;
    this.lootToastTimer = 0;
    this.reloadFlashTimer = 0;
    this.elimBumpTimer = 0;
    this.damageFlashTimer = 0;
    this.poiToastTimer = 0;
    this.elimBannerTimer = 0;
    this.currentPoiName = '';
    this.hitmarkerEl?.classList.add('hidden');
    this.hitBadgeEl?.classList.add('hidden');
    this.lootToastEl?.classList.add('hidden');
    this.activeAmmoCardEl?.classList.remove('reload-complete');
    this.killCountEl?.classList.remove('elim-bump');
    this.stormVignette?.classList.remove('active', 'damage-flash');
    this.poiToastEl?.classList.add('hidden');
    this.elimBannerEl?.classList.add('hidden');
    if (this.killfeedContainer) this.killfeedContainer.innerHTML = '';
    if (this.damageLayer) this.damageLayer.innerHTML = '';
    this.floatingDamages = [];
  }

  public updateConnectionBadge(statusText: string, connected: boolean): void {
    if (!this.netStatusPillEl) return;
    this.netStatusPillEl.textContent = statusText;
    this.netStatusPillEl.classList.toggle('online', connected);
  }

  public updateSpectatorBanner(target: PlayerState | null): void {
    if (!this.spectatorBannerEl) return;
    this.spectatorBannerEl.classList.toggle('hidden', !target);
    if (target && this.spectatorTargetEl) {
      this.spectatorTargetEl.textContent = `${target.name} (${Math.ceil(
        target.health
      )} HP)`;
    }
  }

  public updateCountdown(countdownTimer: number): void {
    const secs = Math.max(1, Math.ceil(countdownTimer));
    this.stormPhaseEl.textContent = 'DROPPING IN';
    this.stormTimerEl.textContent = `${secs}s`;
  }

  public updateCrosshairSpread(
    isMoving: boolean,
    isAiming: boolean,
    isFiring: boolean
  ): void {
    let gap = 6;
    if (isAiming) gap = 2;
    else if (isMoving) gap = 11;
    if (isFiring) gap += 6;
    this.crosshairEl.style.setProperty('--ch-gap', `${gap}px`);
  }

  public showHitmarker(
    isHeadshot: boolean,
    isShield: boolean = false,
    isElimination: boolean = false,
    isShieldBreak: boolean = false
  ): void {
    this.hitmarkerTimer = isElimination
      ? 0.32
      : isShieldBreak || isHeadshot
      ? 0.22
      : 0.16;
    this.hitmarkerEl.classList.remove(
      'hidden',
      'headshot',
      'shield',
      'shield-break',
      'elim'
    );
    if (isElimination) {
      this.hitmarkerEl.classList.add('elim');
    } else if (isHeadshot) {
      this.hitmarkerEl.classList.add('headshot');
    } else if (isShieldBreak) {
      this.hitmarkerEl.classList.add('shield-break');
    } else if (isShield) {
      this.hitmarkerEl.classList.add('shield');
    }

    if (this.hitBadgeEl) {
      if (isElimination) {
        this.hitBadgeEl.textContent = '💀 ELIMINATED!';
        this.hitBadgeEl.className = 'hit-badge elim';
      } else if (isHeadshot && isShieldBreak) {
        this.hitBadgeEl.textContent = '⚡ CRIT + SHIELD CRACKED!';
        this.hitBadgeEl.className = 'hit-badge';
      } else if (isHeadshot) {
        this.hitBadgeEl.textContent = '⚡ CRITICAL HEADSHOT';
        this.hitBadgeEl.className = 'hit-badge';
      } else if (isShieldBreak) {
        this.hitBadgeEl.textContent = '🛡️ SHIELD CRACKED!';
        this.hitBadgeEl.className = 'hit-badge shield-break';
      } else {
        this.hitBadgeEl.classList.add('hidden');
      }
    }
  }

  public showLootToast(
    message: string,
    rarityColorHex: string = '#38bdf8',
    isSwap: boolean = false
  ): void {
    if (!this.lootToastEl) return;
    this.lootToastEl.textContent = `${isSwap ? '🔄 ' : '✨ '}${message}`;
    this.lootToastEl.style.borderColor = rarityColorHex;
    this.lootToastEl.style.color = isSwap ? '#fef08a' : '#f8fafc';
    this.lootToastEl.classList.remove('hidden');
    this.lootToastTimer = 1.95;
  }

  public triggerReloadCompleteFlash(): void {
    if (!this.activeAmmoCardEl) return;
    this.activeAmmoCardEl.classList.add('reload-complete');
    this.reloadFlashTimer = 0.28;
  }

  public showEliminationBanner(
    victimName: string,
    weaponName: string,
    isHeadshot: boolean = false,
    totalKills: number = 1
  ): void {
    if (this.killCountEl) {
      this.killCountEl.classList.add('elim-bump');
      this.elimBumpTimer = 0.35;
    }
    if (!this.elimBannerEl) return;
    const streakTag =
      totalKills >= 5
        ? ' • 🔥 UNSTOPPABLE!'
        : totalKills === 4
        ? ' • 💥 QUAD ELIM!'
        : totalKills === 3
        ? ' • ⚡ TRIPLE ELIM!'
        : totalKills === 2
        ? ' • ✨ DOUBLE ELIM!'
        : '';
    this.elimBannerEl.innerHTML = `<span class="elim-icon">${
      isHeadshot ? '🎯' : '⚡'
    }</span> ELIMINATED <strong>${victimName}</strong> <span class="elim-weap">[${weaponName}${streakTag}]</span>`;
    this.elimBannerEl.classList.remove('hidden');
    this.elimBannerTimer = 2.8;
  }

  public triggerVictoryPresentation(isVictory: boolean): void {
    const crownEl = document.getElementById('end-crown-badge');
    if (crownEl) {
      crownEl.textContent = isVictory
        ? '🏆 #1 ISLAND CHAMPION'
        : '⚔️ COMBAT REPORT';
      crownEl.classList.toggle('defeated', !isVictory);
    }

    const confettiLayer = document.getElementById('victory-confetti-layer');
    if (!confettiLayer) return;
    confettiLayer.innerHTML = '';
    if (!isVictory) return;

    const palette = ['#facc15', '#38bdf8', '#4ade80', '#f43f5e', '#a855f7'];
    for (let i = 0; i < 36; i++) {
      const spark = document.createElement('div');
      spark.className = 'victory-spark';
      spark.style.left = `${Math.random() * 100}%`;
      spark.style.backgroundColor = palette[i % palette.length];
      spark.style.animationDelay = `${(Math.random() * 2.2).toFixed(2)}s`;
      spark.style.animationDuration = `${(2.1 + Math.random() * 1.4).toFixed(2)}s`;
      confettiLayer.appendChild(spark);
    }
  }

  public triggerDamageTakenFlash(): void {
    this.damageFlashTimer = 0.22;
    this.stormVignette.classList.add('damage-flash');
  }

  public spawnDamageNumber(
    worldPos: THREE.Vector3,
    amount: number,
    isHeadshot: boolean,
    isShield: boolean,
    isShieldBreak: boolean = false
  ): void {
    if (!this.damageLayer) return;
    const el = document.createElement('div');
    el.className = `floating-dmg ${isHeadshot ? 'crit' : ''} ${
      isShield ? 'shield' : ''
    } ${isShieldBreak ? 'shield-break' : ''}`;
    const prefix = isShieldBreak ? '💥 ' : isHeadshot ? '⚡' : isShield ? '🛡️' : '';
    el.textContent = `${prefix}${amount}${isHeadshot ? '!' : ''}`;
    this.damageLayer.appendChild(el);

    const item: FloatingDamageNumber = {
      el,
      worldPos: worldPos
        .clone()
        .add(
          new THREE.Vector3(
            (Math.random() - 0.5) * 0.7,
            0.35 + Math.random() * 0.35,
            (Math.random() - 0.5) * 0.7
          )
        ),
      life: isShieldBreak || isHeadshot ? 1.05 : 0.85,
      maxLife: isShieldBreak || isHeadshot ? 1.05 : 0.85,
      offsetX: (Math.random() - 0.5) * 26,
      vx: (Math.random() - 0.5) * 42,
    };
    this.floatingDamages.push(item);
    if (this.lastCamera) {
      this.projectDamageItem(item, this.lastCamera);
    }
  }

  public spawnFloatingLabel(
    worldPos: THREE.Vector3,
    text: string,
    colorHex: string
  ): void {
    if (!this.damageLayer) return;
    const el = document.createElement('div');
    el.className = 'floating-dmg';
    el.style.color = colorHex;
    el.style.fontSize = '0.95rem';
    el.textContent = text;
    this.damageLayer.appendChild(el);

    const item: FloatingDamageNumber = {
      el,
      worldPos: worldPos.clone().add(new THREE.Vector3(0, 0.4, 0)),
      life: 0.75,
      maxLife: 0.75,
      offsetX: (Math.random() - 0.5) * 18,
      vx: (Math.random() - 0.5) * 24,
    };
    this.floatingDamages.push(item);
    if (this.lastCamera) {
      this.projectDamageItem(item, this.lastCamera);
    }
  }

  public pushKillFeed(
    killerName: string,
    victimName: string,
    weaponName: string,
    isHeadshot: boolean = false
  ): void {
    if (!this.killfeedContainer) return;
    const row = document.createElement('div');
    row.className = `killfeed-row ${isHeadshot ? 'kf-headshot' : ''}`;
    row.innerHTML = `<span class="kf-killer">${killerName}</span> <span class="kf-weapon">[${weaponName}${
      isHeadshot ? ' 🎯' : ''
    }]</span> <span class="kf-victim">${victimName}</span>`;
    this.killfeedContainer.prepend(row);

    while (this.killfeedContainer.children.length > 5) {
      this.killfeedContainer.lastElementChild?.remove();
    }

    setTimeout(() => {
      row.remove();
    }, 6000);
  }

  private projectDamageItem(
    d: FloatingDamageNumber,
    camera: THREE.Camera
  ): void {
    const proj = this.scratchProjVec.copy(d.worldPos).project(camera);
    if (proj.z < 1) {
      const w = window.innerWidth || 1280;
      const h = window.innerHeight || 720;
      const x = (proj.x * 0.5 + 0.5) * w + d.offsetX;
      const y = (-(proj.y * 0.5) + 0.5) * h;
      const age = d.maxLife - d.life;
      const popScale = age < 0.14 ? 1 + Math.sin((age / 0.14) * Math.PI) * 0.28 : 1;
      d.el.style.left = `${x}px`;
      d.el.style.top = `${y}px`;
      d.el.style.transform = `translate(-50%, -50%) scale(${popScale.toFixed(2)})`;
      d.el.style.opacity = `${Math.min(1, (d.life / d.maxLife) * 1.25)}`;
    } else {
      d.el.style.opacity = '0';
    }
  }

  public updateBuildModeIndicator(activeBuild: BuildPieceType | null): void {
    this.buildBtnWall?.classList.toggle('active-build', activeBuild === 'wall');
    this.buildBtnRamp?.classList.toggle('active-build', activeBuild === 'ramp');
    this.buildBtnFloor?.classList.toggle(
      'active-build',
      activeBuild === 'floor'
    );
    this.buildBtnRoof?.classList.toggle('active-build', activeBuild === 'roof');
  }

  private getReserveAmmo(player: PlayerState, type: AmmoType): number {
    if (type === 'light') return player.ammo.light;
    if (type === 'medium') return player.ammo.medium;
    if (type === 'shells') return player.ammo.shells;
    if (type === 'heavy') return player.ammo.heavy;
    return 0;
  }

  public updateHUD(
    dt: number,
    match: MatchState,
    player: PlayerState,
    nearbyLoot: LootItemState | null,
    isOutsideStorm: boolean,
    camera: THREE.Camera
  ): void {
    this.lastCamera = camera;

    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer -= dt;
      if (this.hitmarkerTimer <= 0) {
        this.hitmarkerEl.classList.add('hidden');
        this.hitBadgeEl?.classList.add('hidden');
      }
    }

    if (this.lootToastTimer > 0) {
      this.lootToastTimer -= dt;
      if (this.lootToastTimer <= 0) {
        this.lootToastEl?.classList.add('hidden');
      }
    }

    if (this.reloadFlashTimer > 0) {
      this.reloadFlashTimer -= dt;
      if (this.reloadFlashTimer <= 0) {
        this.activeAmmoCardEl?.classList.remove('reload-complete');
      }
    }

    if (this.elimBumpTimer > 0) {
      this.elimBumpTimer -= dt;
      if (this.elimBumpTimer <= 0) {
        this.killCountEl?.classList.remove('elim-bump');
      }
    }

    if (this.damageFlashTimer > 0) {
      this.damageFlashTimer -= dt;
      if (this.damageFlashTimer <= 0) {
        this.stormVignette.classList.remove('damage-flash');
      }
    }

    if (this.poiToastTimer > 0) {
      this.poiToastTimer -= dt;
      if (this.poiToastTimer <= 0 && this.poiToastEl) {
        this.poiToastEl.classList.add('hidden');
      }
    }

    if (this.elimBannerTimer > 0) {
      this.elimBannerTimer -= dt;
      if (this.elimBannerTimer <= 0 && this.elimBannerEl) {
        this.elimBannerEl.classList.add('hidden');
      }
    }

    // Dynamic Crosshair Spread
    const isMoving = Math.hypot(player.velocity.x, player.velocity.z) > 0.6;
    this.updateCrosshairSpread(isMoving, player.isAiming, this.hitmarkerTimer > 0);

    // Check Named POI Discovery Toast
    for (const poi of ISLAND_POIS) {
      const dist = Math.hypot(
        player.position.x - poi.x,
        player.position.z - poi.z
      );
      if (dist < poi.radius && this.currentPoiName !== poi.name) {
        this.currentPoiName = poi.name;
        if (this.poiToastEl) {
          this.poiToastEl.textContent = `📍 ENTERING ${poi.name.toUpperCase()}`;
          this.poiToastEl.style.setProperty('--poi-accent', poi.color);
          this.poiToastEl.classList.remove('hidden');
          this.poiToastTimer = 2.8;
        }
        break;
      }
    }

    // Update Compass Heading
    if (this.compassLabelEl) {
      let deg = Math.round(((-player.yaw * 180) / Math.PI) % 360);
      if (deg < 0) deg += 360;
      const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
      const cardinal = dirs[Math.round(deg / 45) % 8];
      this.compassLabelEl.textContent = `${cardinal} • ${deg}°`;
    }

    // Update Floating Damage Numbers
    for (let i = this.floatingDamages.length - 1; i >= 0; i--) {
      const d = this.floatingDamages[i];
      d.life -= dt;
      if (d.life <= 0) {
        d.el.remove();
        this.floatingDamages.splice(i, 1);
        continue;
      }
      d.worldPos.y += dt * 1.85;
      d.offsetX += d.vx * dt;
      this.projectDamageItem(d, camera);
    }

    // Vitals
    const hpPct = Math.max(0, (player.health / player.maxHealth) * 100);
    const shPct = Math.max(0, (player.shield / player.maxShield) * 100);
    this.healthFill.style.width = `${hpPct}%`;
    this.healthText.textContent = `${Math.ceil(player.health)} / ${
      player.maxHealth
    }`;
    this.shieldFill.style.width = `${shPct}%`;
    this.shieldText.textContent = `${Math.ceil(player.shield)} / ${
      player.maxShield
    }`;

    // Match Counters
    this.aliveCountEl.textContent = `${match.aliveCount}`;
    this.killCountEl.textContent = `${player.eliminations}`;

    // Storm Status: phaseTimer is preparation time while waiting and
    // remaining movement time while shrinking; label that distinction so
    // players can plan rotations through tall districts.
    const displayPhase = Math.min(8, Math.max(1, match.storm.phase));
    this.stormPhaseEl.textContent = `PHASE ${displayPhase} · ${getStormStatusLabel(match.storm)}`;
    const sec = Math.max(0, Math.ceil(match.storm.phaseTimer));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    this.stormTimerEl.textContent = isFinalStormPhase(match.storm)
      ? 'CLOSED'
      : `${m}:${s < 10 ? '0' : ''}${s}`;
    this.stormVignette.classList.toggle('active', isOutsideStorm);

    // Materials & Selected Material Highlight
    this.woodCountEl.textContent = `${player.materials.wood}`;
    this.stoneCountEl.textContent = `${player.materials.stone}`;
    this.metalCountEl.textContent = `${player.materials.metal}`;
    this.matChipWood?.classList.toggle(
      'selected-mat',
      player.selectedMaterial === 'wood'
    );
    this.matChipStone?.classList.toggle(
      'selected-mat',
      player.selectedMaterial === 'stone'
    );
    this.matChipMetal?.classList.toggle(
      'selected-mat',
      player.selectedMaterial === 'metal'
    );

    // Active Weapon & Hotbar Slots
    const activeItem = player.inventory[player.activeSlot];
    if (activeItem) {
      this.activeWeaponName.textContent = activeItem.name;
      this.activeWeaponName.style.color = RARITY_COLORS[activeItem.rarity].hex;
      if (activeItem.category === 'harvester') {
        this.activeAmmoClip.textContent = '∞';
        this.activeAmmoRes.textContent = '';
      } else if (activeItem.isConsumable) {
        this.activeAmmoClip.textContent = `x${activeItem.count}`;
        this.activeAmmoRes.textContent = 'USE';
      } else {
        const res = this.getReserveAmmo(player, activeItem.ammoType);
        this.activeAmmoClip.textContent = `${activeItem.clipAmmo}`;
        this.activeAmmoRes.textContent = `/ ${res}`;
      }
    }

    for (let i = 0; i < 5; i++) {
      const slotEl = document.getElementById(`hotbar-slot-${i}`);
      if (!slotEl) continue;
      slotEl.classList.toggle('active', i === player.activeSlot);

      const item = player.inventory[i];
      const iconEl = slotEl.querySelector('.slot-icon') as HTMLElement;
      const nameEl = slotEl.querySelector('.slot-name') as HTMLElement;
      const ammoEl = slotEl.querySelector('.slot-ammo') as HTMLElement;
      const barEl = slotEl.querySelector('.slot-rarity-bar') as HTMLElement;

      if (item) {
        iconEl.textContent = WEAPON_ICONS[item.category] || '🔫';
        nameEl.textContent = item.name.replace(
          /^(Common|Uncommon|Rare|Epic|Legendary)\s+/i,
          ''
        );
        if (item.category === 'harvester') {
          ammoEl.textContent = 'MELEE';
        } else if (item.isConsumable) {
          ammoEl.textContent = `x${item.count}`;
        } else {
          const res = this.getReserveAmmo(player, item.ammoType);
          ammoEl.textContent = `${item.clipAmmo}/${res}`;
        }
        barEl.style.background = RARITY_COLORS[item.rarity].hex;
      } else {
        iconEl.textContent = '·';
        nameEl.textContent = 'Empty';
        ammoEl.textContent = '';
        barEl.style.background = 'rgba(255,255,255,0.1)';
      }
    }

    // Reload Indicator + Progress Bar
    this.reloadIndicator.classList.toggle('hidden', !player.isReloading);
    if (player.isReloading && this.reloadBarFill) {
      const total = Math.max(0.1, player.reloadDuration || 2.0);
      const progress = Math.max(
        0,
        Math.min(100, ((total - player.reloadTimer) / total) * 100)
      );
      this.reloadBarFill.style.width = `${progress}%`;
    }

    // Nearby Loot Prompt
    if (nearbyLoot) {
      this.pickupPrompt.classList.remove('hidden');
      const labelEl = document.getElementById('hud-pickup-name');
      const actionLabel =
        nearbyLoot.itemType === 'chest'
          ? 'Open Supply Chest'
          : `Pick Up ${nearbyLoot.name}`;
      if (labelEl) {
        labelEl.textContent = actionLabel;
      } else {
        this.pickupPrompt.innerHTML = `Press <kbd>F</kbd> to ${actionLabel}`;
      }
    } else {
      this.pickupPrompt.classList.add('hidden');
    }

    this.renderMinimap(player, match);
  }

  private renderMinimap(player: PlayerState, match: MatchState): void {
    const ctx = this.minimapCtx;
    const w = this.minimapCanvas.width;
    const h = this.minimapCanvas.height;
    const islandRadius = 260;
    const scale = w / (islandRadius * 2.15);
    const cx = w / 2;
    const cy = h / 2;

    ctx.clearRect(0, 0, w, h);

    // Ocean background
    ctx.fillStyle = '#0284c7';
    ctx.fillRect(0, 0, w, h);

    // Island circle
    ctx.beginPath();
    ctx.arc(cx, cy, islandRadius * scale, 0, Math.PI * 2);
    ctx.fillStyle = '#15803d';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#fde047';
    ctx.stroke();

    // Named POI Dots & Labels
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = 'bold 8px sans-serif';
    ctx.textAlign = 'center';
    for (const poi of ISLAND_POIS) {
      const px = cx + poi.x * scale;
      const py = cy + poi.z * scale;
      ctx.fillRect(px - 2, py - 2, 4, 4);
      ctx.fillText(poi.name.split(' ')[0], px, py - 4);
    }

    // Secondary settlements: small markers keep the expanded island
    // navigable without overwhelming the eight named-POI labels.
    for (const settlement of ISLAND_SETTLEMENTS) {
      const px = cx + settlement.x * scale;
      const py = cy + settlement.z * scale;
      ctx.fillStyle = settlement.color;
      ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.75)';

    // Storm Safe Target Circle
    ctx.beginPath();
    ctx.arc(
      cx + match.storm.targetCenterX * scale,
      cy + match.storm.targetCenterZ * scale,
      match.storm.targetRadius * scale,
      0,
      Math.PI * 2
    );
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Current Storm Wall Circle
    ctx.beginPath();
    ctx.arc(
      cx + match.storm.currentCenterX * scale,
      cy + match.storm.currentCenterZ * scale,
      match.storm.currentRadius * scale,
      0,
      Math.PI * 2
    );
    ctx.strokeStyle = '#c084fc';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Unopened Chests (Gold Dots)
    for (const item of match.lootItems.values()) {
      if (!item.opened && item.itemType === 'chest') {
        ctx.fillStyle = '#facc15';
        ctx.fillRect(
          cx + item.position.x * scale - 2,
          cy + item.position.z * scale - 2,
          4,
          4
        );
      }
    }

    // Nearby Combatants
    for (const other of match.players.values()) {
      if (!other.alive || other.id === player.id) continue;
      const dist = Math.hypot(
        other.position.x - player.position.x,
        other.position.z - player.position.z
      );
      if (dist < 85) {
        ctx.beginPath();
        ctx.arc(
          cx + other.position.x * scale,
          cy + other.position.z * scale,
          3,
          0,
          Math.PI * 2
        );
        ctx.fillStyle = '#ef4444';
        ctx.fill();
      }
    }

    // Local Player Arrow
    const px = cx + player.position.x * scale;
    const py = cy + player.position.z * scale;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-player.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fillStyle = '#38bdf8';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }
}
