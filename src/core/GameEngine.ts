import { combatFeedbackGain } from '../ui/combatFeedback';
import * as THREE from 'three';
import {
  BuildPieceType,
  CosmeticLoadout,
  GameModeChoice,
  GameSettings,
  LobbyConfig,
  PlayerInputPacket,
  PlayerState,
  RoomSnapshot,
  StarterLoadoutType,
  TimeOfDayPreset,
  WeaponCategory,
  effectiveBotCountForMode,
  getStarterLoadoutItems,
  isHumanOnlySessionMode,
} from '../network/schemas';
import {
  DEFAULT_GAME_MODE,
  areTeammates,
  computeTeamScores,
  evaluateMatchOutcome,
  gameModeLabel,
  getRemainingMatchSeconds,
  isMatchTimeExpired,
  isRespawnMode,
  isStormEnabledForMode,
  isTimedMode,
  normalizeGameMode,
} from '../../shared/matchRules.mjs';
import {
  NetworkConnectionState,
  NetworkManager,
  ServerHitEvent,
} from '../network/NetworkManager';
import { IslandWorld } from '../world/IslandWorld';
import {
  getCameraFarForQuality,
  getEnvironmentPreset,
  getSunOffset,
  resolveGraphicsQuality,
  setFoliageWindStrength,
  type DeviceCapabilitySignals,
  type ResolvedGraphicsQuality,
} from '../world/VisualAtmosphere';
import { CharacterMesh } from '../entities/CharacterMesh';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { clampNumber, combineMoveInput } from '../input/touchInputMath';
import { PlayerController } from '../entities/PlayerController';
import { BotAIController } from '../entities/BotAIController';
import { LootSystem } from '../systems/LootSystem';
import { StormSystem } from '../systems/StormSystem';
import { ParticleSystem } from '../systems/ParticleSystem';
import { SoundManager } from '../audio/SoundManager';
import { HUDManager } from '../ui/HUDManager';
import { AimDiagnostics } from '../debug/AimDiagnostics';
import { ProgressionSystem } from '../systems/ProgressionSystem';
import { PerfMonitor, PerfSnapshot } from '../systems/PerfMonitor';
import { createWeaponStats, RARITY_COLORS } from '../weapons/WeaponDefinitions';

export class GameEngine {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private tpCamera: ThirdPersonCamera;
  private readonly cameraForwardScratch = new THREE.Vector3();
  /** Dev-only overlay, enabled with `?aimdebug=1`; inert otherwise. */
  private aimDiagnostics = new AimDiagnostics();
  private dirLight!: THREE.DirectionalLight;
  private dirLightTarget!: THREE.Object3D;
  private fillLight!: THREE.DirectionalLight;
  private hemiLight!: THREE.HemisphereLight;
  private readonly sunOffset = new THREE.Vector3(115, 165, 95);
  private environmentCanvas: HTMLCanvasElement | null = null;
  private environmentTexture: THREE.CanvasTexture | null = null;
  private environmentRenderTarget: THREE.WebGLRenderTarget | null = null;
  private environmentPmrem: THREE.PMREMGenerator | null = null;
  private environmentPreset: TimeOfDayPreset | null = null;

  public network: NetworkManager;
  public world: IslandWorld;
  public playerController: PlayerController;
  public botController: BotAIController;
  public lootSystem: LootSystem;
  public stormSystem: StormSystem;
  public particles: ParticleSystem;
  public sound: SoundManager;
  public hud: HUDManager;
  public progression: ProgressionSystem;
  public perfMonitor: PerfMonitor;

  // 3D Main Menu / Locker Character Preview Stage
  private hasPreviewViewport = false;
  public readonly accountReady: Promise<boolean>;
  public lobbyPreviewGroup!: THREE.Group;
  public lobbyCharacterMesh!: CharacterMesh;
  public lobbyPreviewState!: PlayerState;
  public lobbyPreviewYaw = 0.35;
  private lobbyPreviewRingMat: THREE.MeshBasicMaterial | null = null;

  public onLobbyConnectionChange?: (
    statusText: string,
    connected: boolean,
    connState: NetworkConnectionState,
    humanCount: number
  ) => void;
  public onProgressionUpdated?: () => void;
  public onHumanLobbyUpdated?: (snapshot: RoomSnapshot | null) => void;
  public onHumanLobbyJoinRejected?: (code: string, reason: string) => void;
  public onHumanRoomActionRejected?: (reason: string) => void;
  public onHumanMatchStarted?: (snapshot: RoomSnapshot) => void;
  public onLobbyUpdated?: (snapshot: RoomSnapshot | null) => void;
  public onLobbyJoinRejected?: (code: string, reason: string) => void;
  public onLobbyActionRejected?: (reason: string) => void;
  public onLobbyMatchStarted?: (snapshot: RoomSnapshot) => void;
  public onLobbyClosed?: (snapshot: RoomSnapshot, reason: string) => void;
  /** Notified after held input is cleared so touch UI state can resync. */
  public onTransientInputCleared?: () => void;

  private characterMeshes: Map<string, CharacterMesh> = new Map();
  private lastTime = performance.now();
  private seqCounter = 0;
  private stormDamageTicker = 0;
  private processedServerHitIds: Set<string> = new Set();
  private lastServerHitSig = '';
  private lastServerHitAt = 0;
  private wasLocalInStorm = false;
  private lastAudibleStormPhase = 0;
  private lastCountdownBeepInt = 0;
  private matchResultRecorded = false;

  public isRunningMatch = false;
  public isPaused = false;
  public isPointerLocked = false;
  public activeBuildPreview: BuildPieceType | null = null;
  public countdownTimer = 0;
  public spectatedPlayerId: string | null = null;

  public currentConfig: LobbyConfig = {
    playerName: 'Commander_CI',
    mode: 'solo_bots',
    roomCode: 'CICRAFT-1',
    botCount: 14,
    difficulty: 'medium',
    skyDrop: true,
    starterLoadout: 'balanced',
  };

  private pendingLobbyConfig: LobbyConfig | null = null;
  private serverAuthorizedLobbyStart: boolean = false;
  private localEliminationPlacement: number | null = null;
  private localEliminatedByName: string = '';

  public settings: GameSettings = {
    mouseSensitivity: 1.0,
    touchSensitivity: 1.0,
    audioVolume: 0.8,
    sfxVolume: 0.9,
    graphicsQuality: 'auto',
    timeOfDay: 'day',
    showFps: false,
  };

  // Input State
  public keys: Set<string> = new Set();
  public mouseFireHeld = false;
  public mouseAimHeld = false;
  public pendingSlotSelect = -1;
  public pendingInteract = false;
  public pendingReload = false;
  public pendingCycleMaterial = false;
  public pendingBuild: BuildPieceType | null = null;
  public mobileMoveX = 0;
  public mobileMoveZ = 0;
  public mobileJump = false;
  public mobileSprint = false;
  public touchFireHeld = false;
  public touchAimHeld = false;

  private fpsFrames = 0;
  private fpsTimer = 0;
  public basePixelRatio = 1.5;
  public adaptiveResolutionScale = 1.0;
  private adaptiveScaleTimer = 0;
  private adaptiveSlowChecks = 0;
  private adaptiveDetailReduced = false;
  private resolvedGraphicsQuality: ResolvedGraphicsQuality = 'high';
  private shadowCenterTick = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.basePixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    const initialViewport = this.getViewportSize();

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(initialViewport.width, initialViewport.height);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x38bdf8);
    this.scene.fog = new THREE.FogExp2(0x7dd3fc, 0.0022);

    this.setupLighting();
    this.setupEnvironmentLighting();

    this.tpCamera = new ThirdPersonCamera(
      initialViewport.width / initialViewport.height
    );
    this.network = new NetworkManager();
    this.world = new IslandWorld(this.scene);
    this.world.generate();

    this.playerController = new PlayerController();
    this.botController = new BotAIController();
    this.lootSystem = new LootSystem(this.scene);
    this.stormSystem = new StormSystem(this.scene, (x,z) => this.world.terrain.getTerrainHeight(x,z));
    this.particles = new ParticleSystem(this.scene);
    this.sound = new SoundManager();
    this.hud = new HUDManager();
    this.progression = new ProgressionSystem();
    this.perfMonitor = new PerfMonitor();

    // Resolve the new Auto default before the first frame. Explicit Low /
    // Medium / High selections in Settings continue to be honoured exactly.
    this.applySettings({});

    this.setupLobbyPreviewStage();
    this.setupMultiplayerCallbacks();

    this.network.setAccountCredentials(
      this.progression.credentials.accountId,
      this.progression.credentials.accountToken
    );
    this.accountReady = this.progression.initializeServerAccount().then((ok) => {
      if (ok) {
        this.network.setAccountCredentials(
          this.progression.credentials.accountId,
          this.progression.credentials.accountToken
        );
        this.updateLobbyCharacterPreview(this.progression.cosmetics);
        this.onProgressionUpdated?.();
      }
      return ok;
    });

    window.addEventListener('resize', () => this.onWindowResize());
    window.visualViewport?.addEventListener('resize', () => this.onWindowResize());
    // Some mobile browsers report orientation/fullscreen transitions before
    // the final visual viewport is available. A frame-delayed resize keeps
    // the WebGL canvas and camera aspect matched to the settled landscape
    // size without changing the existing render loop.
    const resizeAfterViewportSettles = (): void => {
      requestAnimationFrame(() => this.onWindowResize());
    };
    window.addEventListener('orientationchange', resizeAfterViewportSettles);
    window.screen?.orientation?.addEventListener?.('change', resizeAfterViewportSettles);
    document.addEventListener('fullscreenchange', resizeAfterViewportSettles);
    requestAnimationFrame((t) => this.animate(t));
  }

  private setupLobbyPreviewStage(): void {
    this.lobbyPreviewGroup = new THREE.Group();
    const stageX = 16;
    const stageZ = 22;
    const stageY = this.world.terrain.getTerrainHeight(stageX, stageZ);
    this.lobbyPreviewGroup.position.set(stageX, stageY, stageZ);

    // Glowing Cyber Pedestal for 3D Lobby Character Preview
    const baseDisc = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.32, 0.18, 24),
      new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        roughness: 0.3,
        metalness: 0.7,
      })
    );
    baseDisc.position.y = 0.09;
    baseDisc.receiveShadow = true;

    this.lobbyPreviewRingMat = new THREE.MeshBasicMaterial({
      color: this.progression.cosmetics.accentColor,
    });
    const glowRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.12, 0.045, 10, 32),
      this.lobbyPreviewRingMat
    );
    glowRing.rotation.x = Math.PI / 2;
    glowRing.position.y = 0.19;

    this.lobbyPreviewGroup.add(baseDisc, glowRing);
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, 1.85, 8),
        this.lobbyPreviewRingMat
      );
      pillar.position.set(side * 1.28, 1.05, -0.28);
      this.lobbyPreviewGroup.add(pillar);
    }
    this.scene.add(this.lobbyPreviewGroup);

    const initialLoadout = getStarterLoadoutItems('balanced');
    const wStats = createWeaponStats(
      initialLoadout.primaryCat,
      initialLoadout.primaryRarity
    );
    this.lobbyPreviewState = {
      id: 'lobby_preview_char',
      name: 'Preview',
      isBot: false,
      alive: true,
      outfitId: this.progression.cosmetics.outfitId,
      skinColor: this.progression.cosmetics.skinColor,
      accentColor: this.progression.cosmetics.accentColor,
      backAccessory: this.progression.cosmetics.backAccessory,
      position: { x: stageX, y: stageY + 0.18, z: stageZ },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: this.lobbyPreviewYaw,
      facingYaw: this.lobbyPreviewYaw,
      pitch: 0.04,
      health: 100,
      maxHealth: 100,
      shield: 100,
      maxShield: 100,
      eliminations: 0,
      damageDealt: 0,
      shotsFired: 0,
      shotsHit: 0,
      structuresBuilt: 0,
      activeSlot: 0,
      selectedMaterial: 'wood',
      inventory: [
        {
          weaponId: wStats.id,
          name: wStats.name,
          category: initialLoadout.primaryCat,
          rarity: initialLoadout.primaryRarity,
          clipAmmo: wStats.clipSize,
          maxClipAmmo: wStats.clipSize,
          ammoType: wStats.ammoType,
          isConsumable: false,
          count: 1,
        },
        null,
        null,
        null,
        null,
      ],
      materials: { wood: 100, stone: 50, metal: 25 },
      ammo: { none: 0, light: 60, medium: 90, shells: 24, heavy: 15 },
      isAiming: false,
      isSprinting: false,
      isGrounded: true,
      isGliding: false,
      isReloading: false,
      reloadTimer: 0,
      reloadDuration: 0,
      isHealing: false,
      landingImpactTimer: 0,
    };

    this.lobbyCharacterMesh = new CharacterMesh(this.lobbyPreviewState);
    this.scene.add(this.lobbyCharacterMesh.root);
  }

  public updateLobbyCharacterPreview(
    cosmetics?: Partial<CosmeticLoadout>,
    starterLoadout?: StarterLoadoutType
  ): void {
    if (cosmetics) {
      const updated = this.progression.saveCosmetics(cosmetics);
      this.lobbyPreviewState.outfitId = updated.outfitId;
      this.lobbyPreviewState.skinColor = updated.skinColor;
      this.lobbyPreviewState.accentColor = updated.accentColor;
      this.lobbyPreviewState.backAccessory = updated.backAccessory;
      this.lobbyCharacterMesh.setCosmetics(
        updated.skinColor,
        updated.accentColor,
        updated.backAccessory,
        updated.outfitId
      );
      this.lobbyPreviewRingMat?.color.setHex(updated.accentColor);
      this.network.sendCosmeticsUpdate(updated);
    }
    if (starterLoadout) {
      const loadout = getStarterLoadoutItems(starterLoadout);
      const cat: WeaponCategory = loadout.primaryCat;
      const wStats = createWeaponStats(cat, loadout.primaryRarity);
      this.lobbyPreviewState.inventory[0] = {
        weaponId: wStats.id,
        name: wStats.name,
        category: cat,
        rarity: loadout.primaryRarity,
        clipAmmo: wStats.clipSize,
        maxClipAmmo: wStats.clipSize,
        ammoType: wStats.ammoType,
        isConsumable: false,
        count: 1,
      };
    }
  }

  public rotateLobbyPreview(deltaYaw: number): void {
    this.lobbyPreviewYaw += deltaYaw;
    this.lobbyPreviewState.yaw = this.lobbyPreviewYaw;
    this.lobbyPreviewState.facingYaw = this.lobbyPreviewYaw;
  }

  private setupMultiplayerCallbacks(): void {
    this.network.onConnectionStatusChange = (
      statusText,
      connected,
      connState = 'idle',
      humanCount = 1
    ) => {
      this.hud.updateConnectionBadge(statusText, connected);
      this.onLobbyConnectionChange?.(statusText, connected, connState, humanCount);
    };

    this.network.onServerProgressionUpdate = (profile) => {
      this.progression.applyServerVerifiedProgression(profile);
      this.onProgressionUpdated?.();
    };

    this.network.onRoomSnapshot = (snapshot) => {
      if (!snapshot || snapshot.isLobbyManaged || snapshot.humanOnly) {
        this.onLobbyUpdated?.(snapshot);
        this.onHumanLobbyUpdated?.(snapshot);
      }
    };

    this.network.onJoinRejected = (code, reason) => {
      this.pendingLobbyConfig = null;
      this.serverAuthorizedLobbyStart = false;
      this.onLobbyJoinRejected?.(code, reason);
      this.onHumanLobbyJoinRejected?.(code, reason);
    };

    this.network.onRoomActionRejected = (reason) => {
      this.onLobbyActionRejected?.(reason);
      this.onHumanRoomActionRejected?.(reason);
    };

    this.network.onRoomClosed = (snapshot, reason) => {
      this.pendingLobbyConfig = null;
      this.serverAuthorizedLobbyStart = false;
      this.onLobbyClosed?.(snapshot, reason);
    };

    this.network.onMatchStarted = (snapshot) => {
      this.beginServerAuthorizedLobbyMatch(snapshot);
    };

    this.network.onMatchEnded = (snapshot, placements) => {
      this.handleServerMatchEnded(snapshot, placements);
    };

    // Outgoing local player actions -> Room Server & Bot Sound Investigation
    this.playerController.onLocalWeaponFired = (
      category,
      muzzlePos,
      hitPoint,
      rarity,
      aim
    ) => {
      if (category !== 'harvester') {
        this.botController.notifySoundEvent(muzzlePos.x, muzzlePos.z, 95);
      }
      this.network.sendWeaponFired(
        category,
        { x: muzzlePos.x, y: muzzlePos.y, z: muzzlePos.z },
        { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z },
        rarity,
        aim
      );
    };

    this.playerController.onLocalBuildPlaced = (
      buildId,
      pieceType,
      x,
      y,
      z,
      yaw,
      material
    ) => {
      this.network.sendBuildPlaced(buildId, pieceType, x, y, z, yaw, material);
    };

    this.playerController.onLocalDestructibleDamaged = (destructibleId, damage) => {
      this.network.sendBuildDamaged(destructibleId, damage);
    };

    this.playerController.onLocalStructureFeedback = (hitPoint, label, colorHex) => {
      this.hud.spawnFloatingLabel(hitPoint, label, colorHex);
    };

    this.playerController.onBuildRejected = (reason, piece) => {
      this.hud.showLootToast(reason, '#f87171', false);
      this.activeBuildPreview = this.activeBuildPreview || piece;
      this.hud.updateBuildModeIndicator(this.activeBuildPreview);
    };
    this.network.onBuildRejected = (reason, piece) => {
      if (piece) this.playerController.onBuildRejected?.(reason, piece);
      else this.hud.showLootToast(reason, '#f87171', false);
    };
    this.playerController.usesServerInventory = () => this.network.isOnlineRoom;
    this.playerController.onInventoryAction = (action, slot) => this.network.sendInventoryAction(action, slot);
    this.network.onInventoryCompletion = kind => {
      if (kind === 'reload') { this.sound.playReloadComplete(); this.hud.triggerReloadCompleteFlash(); }
      else this.sound.playHeal();
    };

    this.playerController.onLocalReloadCompleted = () => {
      this.hud.triggerReloadCompleteFlash();
    };

    this.lootSystem.onLocalLootFeedback = (message, rarity, isSwap) => {
      const hex = RARITY_COLORS[rarity]?.hex || '#38bdf8';
      this.hud.showLootToast(message, hex, Boolean(isSwap));
    };

    this.lootSystem.onLocalChestOpened = (chestId, spawnedDrops) => {
      const lp = this.network.state.players.get(this.network.localPlayerId);
      this.network.sendLootCollected(chestId, 'chest', lp?.position, spawnedDrops);
    };

    this.lootSystem.onLocalLootCollected = (lootId, itemSnapshot, swappedDrop) => {
      const lp = this.network.state.players.get(this.network.localPlayerId);
      this.network.sendLootCollected(
        lootId,
        itemSnapshot.itemType,
        lp?.position,
        undefined,
        swappedDrop
      );
    };

    this.lootSystem.onServerAuthoritativeLootRequested = (
      item,
      predictedSwappedDrop,
      reservedSlot
    ) => this.network.sendAuthoritativeLootCollectRequest(item, predictedSwappedDrop, reservedSlot);

    this.network.onAuthoritativeLootCollected = (item, swappedDrop, spawnedDrops) => {
      const lp = this.network.state.players.get(this.network.localPlayerId);
      if (!lp) return;
      this.lootSystem.applyAuthoritativeLootCollected(
        this.network.state,
        lp,
        item,
        this.particles,
        this.sound,
        swappedDrop,
        spawnedDrops
      );
    };

    this.network.onRemoteLootCollected = (
      _collectorId,
      lootId,
      itemType,
      spawnedDrops,
      swappedDrop
    ) => {
      const lp = this.network.state.players.get(this.network.localPlayerId);
      const lpPos = lp
        ? new THREE.Vector3(lp.position.x, lp.position.y, lp.position.z)
        : undefined;
      this.lootSystem.applyRemoteLootCollected(
        this.network.state,
        lootId,
        itemType,
        spawnedDrops,
        swappedDrop,
        this.particles,
        this.sound,
        lpPos
      );
    };

    this.network.onRoomLootSync = (collectedIds, spawnedItems) => {
      this.lootSystem.syncRoomLootState(
        this.network.state,
        collectedIds,
        spawnedItems
      );
    };

    this.network.onLootCollectRejected = (lootId, reason) => {
      const item = this.network.state.lootItems.get(lootId);
      if (item?.serverAuthoritative && !/already collected/i.test(reason)) {
        this.lootSystem.clearAuthoritativeLootPending(lootId);
        this.hud.showLootToast(reason, '#f87171', false);
        return;
      }
      this.lootSystem.removeLootItem(this.network.state, lootId);
    };

    // Incoming Room Server events -> Local World & Visuals
    this.network.onRemoteBuildPlaced = (
      buildId,
      ownerId,
      pieceType,
      x,
      y,
      z,
      yaw,
      material
    ) => {
      if (this.world.destructibles.has(buildId)) return;
      const piece = this.world.placeBuildPiece(
        ownerId,
        pieceType,
        x,
        y,
        z,
        yaw,
        material,
        buildId
      );
      this.network.state.buildables.set(piece.id, piece);
      if (ownerId === this.network.serverPlayerId) this.sound.playBuild();
    };

    this.network.onEnvironmentState = (health, destroyed) => {
      for (const [id, remaining] of health) {
        const prop = this.world.destructibles.get(id);
        if (prop && prop.health > remaining) this.world.damageDestructible(id,prop.health-Math.max(0,remaining));
      }
      for (const id of destroyed) {
        const prop = this.world.destructibles.get(id);
        if (prop) this.world.damageDestructible(id,prop.maxHealth);
        this.network.state.buildables.delete(id);
      }
    };

    this.network.onRemoteBuildDamaged = (destructibleId, damage) => {
      const res = this.world.damageDestructible(destructibleId, damage);
      if (res) {
        if (res.destroyed) this.network.state.buildables.delete(destructibleId);
        const local = this.network.state.players.get(this.network.localPlayerId);
        if (local) {
          const distance = Math.hypot(res.position.x-local.position.x,res.position.z-local.position.z);
          if (distance < 100) this.sound.playSurfaceImpact(res.materialType,Math.max(0,1-distance/100));
        }
        this.particles.spawnImpactBurst(
          res.position,
          res.materialType === 'wood' ? 0xb45309 : 0x94a3b8,
          res.destroyed ? 14 : 6,
          4.5
        );
      }
    };

    this.network.onRemoteWeaponFired = (shooterId, category, muzzlePos, hitPoint) => {
      const shooterMesh = this.characterMeshes.get(shooterId);
      shooterMesh?.triggerAttackAnimation(category !== 'harvester');

      const localPlayer = this.network.state.players.get(this.network.localPlayerId);
      if (localPlayer) {
        const d = Math.hypot(
          muzzlePos.x - localPlayer.position.x,
          muzzlePos.z - localPlayer.position.z
        );
        if (d > 185) return;

        const startVec = new THREE.Vector3(muzzlePos.x, muzzlePos.y, muzzlePos.z);
        const endVec = new THREE.Vector3(hitPoint.x, hitPoint.y, hitPoint.z);
        if (category !== 'harvester') {
          this.particles.spawnBulletTracer(
            startVec,
            endVec,
            createWeaponStats(category, 'common').tracerColor
          );
          const remoteShooter = this.network.state.players.get(shooterId);
          this.particles.spawnShellCasing(startVec, remoteShooter?.yaw || 0);
        }
        // A fire endpoint is not a confirmed impact. Hit/build events own impact FX.

        const distFactor = Math.max(0, 1 - d / 160);
        if (distFactor > 0.02) {
          this.sound.playWeaponFire(category, distFactor);
        }
      }
    };

    this.network.onServerHitEvent = (ev: ServerHitEvent) => {
      if (ev.eventId) {
        if (this.processedServerHitIds.has(ev.eventId)) return;
        this.processedServerHitIds.add(ev.eventId);
        if (this.processedServerHitIds.size > 512) {
          const first = this.processedServerHitIds.values().next().value;
          if (first) this.processedServerHitIds.delete(first);
        }
      } else {
        const nowMs = performance.now();
        const sig = `${ev.attackerId}_${ev.victimId}_${ev.victimHealth}_${ev.victimShield}_${ev.damage}`;
        if (sig === this.lastServerHitSig && nowMs - this.lastServerHitAt < 25) {
          return;
        }
        this.lastServerHitSig = sig;
        this.lastServerHitAt = nowMs;
      }

      const state = this.network.state;
      const localPlayer = state.players.get(this.network.localPlayerId);
      const isLocalVictim =
        ev.victimId === this.network.localPlayerId ||
        ev.victimId === this.network.serverPlayerId;
      const isLocalAttacker =
        ev.attackerId === this.network.localPlayerId ||
        ev.attackerId === this.network.serverPlayerId;
      const victim = isLocalVictim
        ? localPlayer
        : state.players.get(ev.victimId);

      if (!victim) return;

      if (isLocalAttacker && !isLocalVictim) {
        this.aimDiagnostics.reportServerResult(
          true,
          `${ev.damage} dmg${ev.isHeadshot ? ' head' : ''}`
        );
      }

      const hadShield = victim.shield > 0;
      victim.health = ev.victimHealth;
      victim.shield = ev.victimShield;
      const isShieldBreak = Boolean(
        ev.isShieldBreak ?? (hadShield && ev.victimShield <= 0)
      );

      const hitVec = new THREE.Vector3(
        ev.hitPoint?.x ?? victim.position.x,
        ev.hitPoint?.y ?? victim.position.y + 1.2,
        ev.hitPoint?.z ?? victim.position.z
      );

      const combatHit = ev.attackerId !== 'storm';
      const gain = isLocalAttacker || isLocalVictim ? 1 : localPlayer
        ? combatFeedbackGain(Math.hypot(hitVec.x-localPlayer.position.x,hitVec.y-localPlayer.position.y,hitVec.z-localPlayer.position.z)) : 0;
      if (combatHit && gain > 0) {
        this.characterMeshes.get(victim.id)?.triggerHitFlash(ev.isHeadshot, ev.isShieldHit);
        this.particles.spawnSurfaceImpact(hitVec,ev.isShieldHit ? 'shield' : 'flesh',isShieldBreak,ev.isHeadshot);
        if (isShieldBreak) this.sound.playShieldBreak(gain);
        else this.sound.playSurfaceImpact(ev.isShieldHit ? 'shield' : 'flesh',gain * .65);
      }

      if (isLocalVictim) {
        const source = state.players.get(ev.attackerId);
        if (source && localPlayer) this.hud.showDamageDirection(localPlayer,source.position,ev.isShieldHit);
        if (ev.attackerId === 'storm') this.hud.showCombatCue(`STORM DAMAGE −${Math.round(ev.damage)} HP`, '#c084fc');
        else if (isShieldBreak) this.hud.showCombatCue('SHIELD BROKEN — FIND COVER', '#67e8f9');
        this.sound.playDamageTaken(ev.isShieldHit);
        this.hud.triggerDamageTakenFlash(ev.isShieldHit, ev.attackerId === 'storm');
        this.hud.spawnDamageNumber(
          hitVec,
          ev.damage,
          ev.isHeadshot,
          ev.isShieldHit,
          isShieldBreak
        );
      } else if (isLocalAttacker) {
        this.tpCamera.applyHitConfirmationPulse(ev.isHeadshot, ev.eliminated);
        if (!ev.eliminated) {
          this.sound.playHitmarker(ev.isHeadshot, ev.isShieldHit, false);
          this.hud.showHitmarker(
            ev.isHeadshot,
            ev.isShieldHit,
            false,
            isShieldBreak
          );
        }
        this.hud.spawnDamageNumber(
          hitVec,
          ev.damage,
          ev.isHeadshot,
          ev.isShieldHit,
          isShieldBreak
        );
      }

      // The 20Hz snapshot can mark a victim dead before the delayed combat
      // event arrives. eventId was deduplicated above; do not suppress its FX.
      if (ev.eliminated) {
        const respawnMode =
          isRespawnMode(state.matchMode) || Boolean(ev.respawned);
        victim.deaths = ev.victimDeaths ?? (victim.deaths || 0) + 1;
        if (isLocalAttacker && localPlayer) {
          localPlayer.eliminations = ev.attackerEliminations ?? (localPlayer.eliminations + 1);
          this.sound.playHitmarker(ev.isHeadshot, false, true);
          this.sound.playElimination();
          this.hud.showHitmarker(ev.isHeadshot, false, true, isShieldBreak);
          this.hud.showEliminationBanner(
            ev.victimName,
            ev.weaponName,
            ev.isHeadshot,
            localPlayer.eliminations
          );
        }
        this.hud.pushKillFeed(
          ev.attackerName,
          ev.victimName,
          ev.weaponName,
          ev.isHeadshot
        );
        if (gain > 0) this.particles.spawnEliminationEffect(
          new THREE.Vector3(victim.position.x, victim.position.y, victim.position.z)
        );

        if (respawnMode && state.phase !== 'ENDED') {
          victim.alive = true;
          victim.health = 100;
          victim.shield = 50;
          victim.isGliding = false;
          victim.isGrounded = true;
          if (ev.respawnPosition) {
            victim.position.x = ev.respawnPosition.x;
            victim.position.y = ev.respawnPosition.y;
            victim.position.z = ev.respawnPosition.z;
            victim.velocity = { x: 0, y: 0, z: 0 };
          }
          if (isLocalVictim && localPlayer) {
            this.localEliminatedByName = ev.attackerName;
            this.hud.showCombatCue('RESPAWNED — BACK IN ACTION', '#38bdf8');
          }
          this.recountAliveCombatants();
          return;
        }

        victim.alive = false;
        this.recountAliveCombatants();

        if (isLocalVictim && localPlayer) {
          this.localEliminatedByName = ev.attackerName;
          const teamMode = this.currentConfig.teamMode || 'solo';
          if (teamMode !== 'solo' && localPlayer.teamId) {
            const aliveTeammate = Array.from(state.players.values()).find(
              (player) =>
                player.id !== localPlayer.id &&
                player.alive &&
                player.teamId === localPlayer.teamId
            );
            if (aliveTeammate) {
              // The local player's result is not final while a teammate is
              // alive. Spectate that teammate and let the authoritative
              // team placement arrive with match_ended.
              this.localEliminationPlacement = null;
              this.clearTransientInput();
              if (document.pointerLockElement) document.exitPointerLock();
              this.spectatedPlayerId = aliveTeammate.id;
              this.hud.updateSpectatorBanner(aliveTeammate);
            } else {
              const aliveTeamCount = new Set(
                Array.from(state.players.values())
                  .filter((player) => player.alive)
                  .map((player) => player.teamId || player.id)
              ).size;
              const placement = Math.max(2, aliveTeamCount + 1);
              this.localEliminationPlacement = placement;
              this.showEndScreen(false, placement, localPlayer, ev.attackerName);
            }
          } else {
            const placement = Math.max(2, state.aliveCount + 1);
            this.localEliminationPlacement = placement;
            this.showEndScreen(false, placement, localPlayer, ev.attackerName);
          }
        } else if (
          !isHumanOnlySessionMode(this.currentConfig.mode) &&
          state.aliveCount <= 1 &&
          localPlayer &&
          localPlayer.alive
        ) {
          state.phase = 'ENDED';
          state.winnerName = localPlayer.name;
          this.sound.playVictory();
          this.showEndScreen(true, 1, localPlayer, '');
        }
      }
    };

    this.network.onPlayerRespawned = (ev) => {
      const isSelf =
        ev.playerId === this.network.localPlayerId ||
        ev.playerId === this.network.serverPlayerId;
      if (isSelf) {
        this.hud.showCombatCue('RESPAWNED — FULL VITALITY', '#38bdf8');
      }
      if (ev.position) {
        this.particles.spawnShockwaveRing(
          new THREE.Vector3(ev.position.x, ev.position.y + 0.2, ev.position.z),
          0x38bdf8,
          2.2
        );
      }
    };
  }

  private setupLighting(): void {
    this.hemiLight = new THREE.HemisphereLight(0xe0f2fe, 0x16a34a, 0.96);
    this.scene.add(this.hemiLight);

    this.dirLight = new THREE.DirectionalLight(0xfffbeb, 1.54);
    const initialSun = getSunOffset('day');
    this.sunOffset.set(initialSun.x, initialSun.y, initialSun.z);
    this.dirLight.position.copy(this.sunOffset);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.width = 1536;
    this.dirLight.shadow.mapSize.height = 1536;
    this.dirLight.shadow.camera.near = 15;
    this.dirLight.shadow.camera.far = 360;
    const d = 98;
    this.dirLight.shadow.camera.left = -d;
    this.dirLight.shadow.camera.right = d;
    this.dirLight.shadow.camera.top = d;
    this.dirLight.shadow.camera.bottom = -d;
    this.dirLight.shadow.bias = -0.00028;
    this.dirLight.shadow.normalBias = 0.028;
    this.dirLight.shadow.radius = 2.0;
    this.dirLightTarget = new THREE.Object3D();
    this.scene.add(this.dirLightTarget);
    this.dirLight.target = this.dirLightTarget;
    this.scene.add(this.dirLight);

    // Secondary Atmospheric Rim / Fill Light (no shadow map cost, improves silhouette & foliage readability)
    this.fillLight = new THREE.DirectionalLight(0x7dd3fc, 0.42);
    this.fillLight.position.set(-120, 95, -110);
    this.scene.add(this.fillLight);
  }

  private setupEnvironmentLighting(): void {
    if (typeof document === 'undefined') return;
    this.environmentCanvas = document.createElement('canvas');
    this.environmentCanvas.width = 512;
    this.environmentCanvas.height = 256;
    this.environmentTexture = new THREE.CanvasTexture(this.environmentCanvas);
    this.environmentTexture.mapping = THREE.EquirectangularReflectionMapping;
    this.environmentTexture.colorSpace = THREE.SRGBColorSpace;
    this.environmentPmrem = new THREE.PMREMGenerator(this.renderer);
    this.environmentPmrem.compileEquirectangularShader();
    this.updateEnvironmentLighting(this.settings.timeOfDay);
  }

  private updateEnvironmentLighting(preset: TimeOfDayPreset): void {
    const environment = getEnvironmentPreset(preset);
    this.renderer.toneMappingExposure = environment.exposure;
    this.scene.environmentIntensity = environment.intensity;

    if (
      this.environmentPreset === preset ||
      !this.environmentCanvas ||
      !this.environmentTexture ||
      !this.environmentPmrem
    ) {
      this.environmentPreset = preset;
      return;
    }
    this.environmentPreset = preset;

    const ctx = this.environmentCanvas.getContext('2d');
    if (!ctx) return;
    const width = this.environmentCanvas.width;
    const height = this.environmentCanvas.height;
    const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

    const vertical = ctx.createLinearGradient(0, 0, 0, height);
    vertical.addColorStop(0, css(environment.zenith));
    vertical.addColorStop(0.47, css(environment.horizon));
    vertical.addColorStop(0.54, css(environment.ground));
    vertical.addColorStop(1, css(environment.ground));
    ctx.fillStyle = vertical;
    ctx.fillRect(0, 0, width, height);

    // Draw the bright directional source three times so its PMREM highlight
    // wraps cleanly at the equirect seam.
    const sunX = environment.sunU * width;
    const sunY = environment.sunV * height;
    for (const offsetX of [-width, 0, width]) {
      const glow = ctx.createRadialGradient(
        sunX + offsetX,
        sunY,
        0,
        sunX + offsetX,
        sunY,
        92
      );
      glow.addColorStop(0, css(environment.sun));
      glow.addColorStop(0.16, css(environment.sun));
      glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(sunX + offsetX - 92, sunY - 92, 184, 184);
    }

    this.environmentTexture.needsUpdate = true;
    const nextRenderTarget = this.environmentPmrem.fromEquirectangular(
      this.environmentTexture
    );
    const previousRenderTarget = this.environmentRenderTarget;
    this.environmentRenderTarget = nextRenderTarget;
    this.scene.environment = nextRenderTarget.texture;
    previousRenderTarget?.dispose();
  }

  private getDeviceCapabilitySignals(): DeviceCapabilitySignals {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return { coarsePointer: false };
    }
    const nav = navigator as Navigator & {
      deviceMemory?: number;
      connection?: { saveData?: boolean };
    };
    let coarsePointer = false;
    try {
      coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    } catch {
      coarsePointer = false;
    }
    return {
      coarsePointer,
      hardwareConcurrency: nav.hardwareConcurrency,
      deviceMemoryGb: nav.deviceMemory,
      devicePixelRatio: window.devicePixelRatio || 1,
      saveData: nav.connection?.saveData === true,
    };
  }

  private getResolvedGraphicsQuality(): ResolvedGraphicsQuality {
    this.resolvedGraphicsQuality = resolveGraphicsQuality(
      this.settings.graphicsQuality,
      this.getDeviceCapabilitySignals()
    );
    return this.resolvedGraphicsQuality;
  }

  private setAdaptiveDetailReduced(reduced: boolean): void {
    if (this.adaptiveDetailReduced === reduced) return;
    this.adaptiveDetailReduced = reduced;
    const quality = this.getResolvedGraphicsQuality();
    this.stormSystem.setDetailEnabled(quality !== 'low' && !reduced);
    this.world.setLandmarkDetail(quality !== 'low' && !reduced);

    // CI CRAFT 7.0 — vegetation quality tiers. HIGH/ULTRA use the detailed
    // canopies, LOW/MEDIUM swap to the coarse twins over the same instances.
    const detailedTrees = quality === 'ultra' || quality === 'high';
    // 8.0: LOW/MEDIUM evaluate one cloud layer instead of two. The sky is the
    // largest single fill-rate surface in an outdoor frame, so this is the first
    // thing to trim rather than the geometry the player is looking at.
    this.world.terrain.setSkyQuality(detailedTrees && !reduced);
    // Ground cover: LOW keeps one band, MEDIUM two, HIGH/ULTRA all three.
    this.world.setGroundCoverQuality(
      reduced ? 'low' : (quality as 'low' | 'medium' | 'high' | 'ultra')
    );
    if (this.world.treeLodHighGroup) {
      this.world.treeLodHighGroup.visible = detailedTrees;
      this.world.treeLodLowGroup.visible = !detailedTrees;
    }

    if (quality === 'ultra') {
      this.world.detailFoliageGroup.visible = !reduced;
      this.world.expansionDetailGroup.visible = !reduced;
      this.world.houseDetailGroup.visible = !reduced;
      if (this.world.terrain.atmosphereMotes) {
        this.world.terrain.atmosphereMotes.visible = !reduced;
      }
      this.setShadowMapSize(reduced ? 1536 : 2048);
    } else if (quality === 'high') {
      this.world.detailFoliageGroup.visible = !reduced;
      this.world.expansionDetailGroup.visible = !reduced;
      this.world.houseDetailGroup.visible = !reduced;
      if (this.world.terrain.atmosphereMotes) {
        this.world.terrain.atmosphereMotes.visible = !reduced;
      }
      this.setShadowMapSize(reduced ? 1024 : 1536);
    } else if (quality === 'medium') {
      // Medium already omits detail foliage. Under sustained pressure, shed
      // the soft shadow pass before reducing combat readability or HUD work.
      this.dirLight.castShadow = !reduced;
      this.renderer.shadowMap.needsUpdate = true;
    }
  }

  public getEffectivePixelRatio(): number {
    return Math.max(0.65, Math.round(this.basePixelRatio * this.adaptiveResolutionScale * 100) / 100);
  }

  private setShadowMapSize(size: number): void {
    if (
      this.dirLight.shadow.mapSize.width !== size ||
      this.dirLight.shadow.mapSize.height !== size
    ) {
      this.dirLight.shadow.mapSize.set(size, size);
      if (this.dirLight.shadow.map) {
        this.dirLight.shadow.map.dispose();
        this.dirLight.shadow.map = null;
      }
    }
  }

  public togglePerfMonitor(): boolean {
    const nextState = !this.settings.showFps;
    this.applySettings({ showFps: nextState });
    const checkbox = document.getElementById('setting-show-fps') as HTMLInputElement | null;
    if (checkbox) checkbox.checked = nextState;
    return nextState;
  }

  public applySettings(newSettings: Partial<GameSettings>): void {
    Object.assign(this.settings, newSettings);
    this.settings.mouseSensitivity = clampNumber(
      this.settings.mouseSensitivity,
      0.3,
      2.5
    );
    this.settings.touchSensitivity = clampNumber(
      this.settings.touchSensitivity ?? 1,
      0.3,
      2.5
    );
    this.tpCamera.sensitivity = this.settings.mouseSensitivity;
    this.tpCamera.touchSensitivity = this.settings.touchSensitivity;
    this.tpCamera.reducedMotion = Boolean(this.settings.reducedMotion);
    this.hud.reducedMotion = Boolean(this.settings.reducedMotion);
    this.stormSystem.reducedMotion = Boolean(this.settings.reducedMotion);
    document.documentElement.classList.toggle('reduced-motion',Boolean(this.settings.reducedMotion));
    this.sound.setVolume(this.settings.audioVolume);
    if (this.settings.sfxVolume !== undefined) {
      this.sound.setSfxVolume(this.settings.sfxVolume);
    }

    const deviceDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.adaptiveResolutionScale = 1.0;
    this.adaptiveSlowChecks = 0;
    this.adaptiveDetailReduced = false;
    const quality = this.getResolvedGraphicsQuality();
    setFoliageWindStrength(
      quality === 'ultra' || quality === 'high' ? 1 : quality === 'medium' ? 0.65 : 0
    );
    this.particles?.setQualityScale(
      quality === 'ultra' || quality === 'high' ? 1 : quality === 'medium' ? 0.8 : 0.55
    );

    if (quality === 'low') {
      this.basePixelRatio = 1.0;
      this.renderer.setPixelRatio(this.getEffectivePixelRatio());
      this.renderer.shadowMap.enabled = false;
      this.dirLight.castShadow = false;
      this.world.terrain.cloudsGroup.visible = false;
      if (this.world.terrain.atmosphereMotes) {
        this.world.terrain.atmosphereMotes.visible = false;
      }
      this.world.foliageGroup.visible = false;
      this.world.detailFoliageGroup.visible = false;
      this.world.expansionDetailGroup.visible = false;
      this.world.houseDetailGroup.visible = false;
      this.world.terrain.distantIslandsGroup.visible = false;
      this.tpCamera.camera.far = getCameraFarForQuality(quality);
      this.tpCamera.camera.updateProjectionMatrix();
    } else if (quality === 'medium') {
      this.basePixelRatio = Math.min(deviceDpr, 1.25);
      this.renderer.setPixelRatio(this.getEffectivePixelRatio());
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
      this.dirLight.castShadow = true;
      this.setShadowMapSize(1024);
      this.world.terrain.cloudsGroup.visible = true;
      if (this.world.terrain.atmosphereMotes) {
        this.world.terrain.atmosphereMotes.visible = false;
      }
      this.world.foliageGroup.visible = true;
      this.world.detailFoliageGroup.visible = false;
      this.world.expansionDetailGroup.visible = false;
      this.world.houseDetailGroup.visible = false;
      this.world.terrain.distantIslandsGroup.visible = true;
      this.tpCamera.camera.far = getCameraFarForQuality(quality);
      this.tpCamera.camera.updateProjectionMatrix();
    } else if (quality === 'ultra') {
      this.basePixelRatio = Math.min(deviceDpr, 2.0);
      this.renderer.setPixelRatio(this.getEffectivePixelRatio());
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.dirLight.castShadow = true;
      this.setShadowMapSize(2048);
      this.world.terrain.cloudsGroup.visible = true;
      if (this.world.terrain.atmosphereMotes) {
        this.world.terrain.atmosphereMotes.visible = true;
      }
      this.world.foliageGroup.visible = true;
      this.world.detailFoliageGroup.visible = true;
      this.world.expansionDetailGroup.visible = true;
      this.world.houseDetailGroup.visible = true;
      this.world.terrain.distantIslandsGroup.visible = true;
      this.tpCamera.camera.far = getCameraFarForQuality(quality);
      this.tpCamera.camera.updateProjectionMatrix();
    } else {
      this.basePixelRatio = Math.min(deviceDpr, 1.5);
      this.renderer.setPixelRatio(this.getEffectivePixelRatio());
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.dirLight.castShadow = true;
      this.setShadowMapSize(1536);
      this.world.terrain.cloudsGroup.visible = true;
      if (this.world.terrain.atmosphereMotes) {
        this.world.terrain.atmosphereMotes.visible = true;
      }
      this.world.foliageGroup.visible = true;
      this.world.detailFoliageGroup.visible = true;
      this.world.expansionDetailGroup.visible = true;
      this.world.houseDetailGroup.visible = true;
      this.world.terrain.distantIslandsGroup.visible = true;
      this.tpCamera.camera.far = getCameraFarForQuality(quality);
      this.tpCamera.camera.updateProjectionMatrix();
    }
    this.renderer.shadowMap.needsUpdate = true;

    // Sharpen the new tiling detail maps at grazing angles (roads, cliffs,
    // facades) on every tier that can afford the extra texture samples.
    const maxAnisotropy = this.renderer.capabilities?.getMaxAnisotropy?.() ?? 1;
    this.world.setTextureAnisotropy(quality === 'low' ? 1 : maxAnisotropy);
    this.stormSystem.setDetailEnabled(quality !== 'low' && !this.adaptiveDetailReduced);
    this.world.setLandmarkDetail(quality !== 'low' && !this.adaptiveDetailReduced);
    this.applyTimeOfDay(this.settings.timeOfDay);

    const fpsEl = document.getElementById('hud-fps-counter');
    if (fpsEl) {
      fpsEl.classList.toggle('hidden', !this.settings.showFps);
    }
    const devPerfEl = document.getElementById('dev-perf-monitor');
    if (devPerfEl) {
      devPerfEl.classList.toggle('hidden', !this.settings.showFps);
    }
  }

  public applyTimeOfDay(preset: TimeOfDayPreset): void {
    this.settings.timeOfDay = preset;
    const sun = getSunOffset(preset);
    this.sunOffset.set(sun.x, sun.y, sun.z);
    this.updateEnvironmentLighting(preset);
    this.world.terrain.applyTimeOfDaySky(preset);

    const fog = this.scene.fog as THREE.FogExp2;
    if (preset === 'sunset') {
      this.scene.background = new THREE.Color(0xf97316);
      fog.color.setHex(0xfb923c);
      fog.density = 0.0019;
      this.hemiLight.color.setHex(0xfed7aa);
      this.hemiLight.groundColor.setHex(0x451a03);
      this.hemiLight.intensity = 0.82;
      this.dirLight.color.setHex(0xfdba74);
      this.dirLight.intensity = 1.42;
      this.dirLight.position.copy(this.dirLightTarget.position).add(this.sunOffset);
      if (this.fillLight) {
        this.fillLight.color.setHex(0xc084fc);
        this.fillLight.intensity = 0.36;
      }
    } else if (preset === 'night') {
      this.scene.background = new THREE.Color(0x0f172a);
      fog.color.setHex(0x1e293b);
      fog.density = 0.0021;
      this.hemiLight.color.setHex(0x38bdf8);
      this.hemiLight.groundColor.setHex(0x020617);
      this.hemiLight.intensity = 0.56;
      this.dirLight.color.setHex(0x93c5fd);
      this.dirLight.intensity = 0.92;
      this.dirLight.position.copy(this.dirLightTarget.position).add(this.sunOffset);
      if (this.fillLight) {
        this.fillLight.color.setHex(0x38bdf8);
        this.fillLight.intensity = 0.28;
      }
    } else {
      this.scene.background = new THREE.Color(0x38bdf8);
      fog.color.setHex(0xcbdde5);
      fog.density = 0.0018;
      this.hemiLight.color.setHex(0xe0f2fe);
      this.hemiLight.groundColor.setHex(0x6b7256);
      this.hemiLight.intensity = 0.96;
      this.dirLight.color.setHex(0xfffbeb);
      this.dirLight.intensity = 1.54;
      this.dirLight.position.copy(this.dirLightTarget.position).add(this.sunOffset);
      if (this.fillLight) {
        this.fillLight.color.setHex(0x7dd3fc);
        this.fillLight.intensity = 0.34;
      }
    }
  }

  /** Connect to a server-owned lobby without starting gameplay. */
  public joinMultiplayerLobby(config: LobbyConfig): void {
    if (config.mode === 'solo_bots') return;

    const isHumanOnly = isHumanOnlySessionMode(config.mode);
    const lobbyConfig: LobbyConfig = {
      ...config,
      botCount: effectiveBotCountForMode(config.mode, config.botCount),
      cosmetics: config.cosmetics || this.progression.cosmetics,
    };
    if (lobbyConfig.createLobby) {
      lobbyConfig.createLobby = {
        ...lobbyConfig.createLobby,
        humanOnly: isHumanOnly,
        botCount: isHumanOnly ? 0 : lobbyConfig.botCount,
        botDifficulty: lobbyConfig.difficulty,
      };
    }
    this.pendingLobbyConfig = lobbyConfig;
    this.currentConfig = lobbyConfig;
    this.serverAuthorizedLobbyStart = false;
    this.localEliminationPlacement = null;
    this.localEliminatedByName = '';
    this.matchResultRecorded = false;
    this.isRunningMatch = false;

    this.network.setAccountCredentials(
      this.progression.credentials.accountId,
      this.progression.credentials.accountToken
    );

    this.network.connectToLobbyRoom(lobbyConfig);
  }

  /** Backward-compatible wrapper for the original human-only entry point. */
  public joinHumanLobby(config: LobbyConfig): void {
    if (!isHumanOnlySessionMode(config.mode)) return;
    this.joinMultiplayerLobby({ ...config, botCount: 0 });
  }

  public setLobbyReady(ready: boolean): void {
    this.network.setReady(ready);
  }

  public setHumanLobbyReady(ready: boolean): void {
    this.setLobbyReady(ready);
  }

  public requestLobbyMatchStart(): void {
    this.network.setReady(true);
    this.network.requestMatchStart();
  }

  public requestHumanMatchStart(): void {
    this.requestLobbyMatchStart();
  }

  public closeLobby(): void {
    this.network.closeRoom();
  }

  public leaveMultiplayerLobby(): void {
    this.pendingLobbyConfig = null;
    this.serverAuthorizedLobbyStart = false;
    this.network.leaveRoom();
    this.onLobbyUpdated?.(null);
    this.onHumanLobbyUpdated?.(null);
  }

  public leaveHumanLobby(): void {
    this.leaveMultiplayerLobby();
  }

  private beginServerAuthorizedLobbyMatch(snapshot: RoomSnapshot): void {
    const pendingConfig = this.pendingLobbyConfig;
    if (!pendingConfig || pendingConfig.mode === 'solo_bots') return;

    const expectsHumanOnly = isHumanOnlySessionMode(pendingConfig.mode);
    if (
      !snapshot.isLobbyManaged ||
      snapshot.matchParticipantCount < snapshot.minPlayers ||
      (expectsHumanOnly &&
        (!snapshot.humanOnly || snapshot.aiFillEnabled || snapshot.botCount !== 0)) ||
      (!expectsHumanOnly && snapshot.humanOnly)
    ) {
      this.onLobbyActionRejected?.(
        expectsHumanOnly
          ? 'The server did not provide a valid human-only match start.'
          : 'The server did not provide a valid lobby match start.'
      );
      this.onHumanRoomActionRejected?.(
        'The server did not provide a valid human-only match start.'
      );
      return;
    }

    const localServerPlayerId = snapshot.selfPlayerId || this.network.serverPlayerId;
    const localIsParticipant = snapshot.players.some(
      (player) => player.id === localServerPlayerId && player.isParticipant
    );
    if (!localIsParticipant) return;

    this.serverAuthorizedLobbyStart = true;
    this.startMatch({
      ...pendingConfig,
      matchMode: snapshot.matchMode || pendingConfig.matchMode || DEFAULT_GAME_MODE,
      roomCode: snapshot.roomCode,
      // The server snapshot is authoritative for these room settings. In a
      // human-only room it is always zero; in AI Fill it is the host's
      // configured client-spawned AI count, kept separate from humans.
      botCount: expectsHumanOnly ? 0 : snapshot.botCount,
      difficulty: snapshot.botDifficulty,
      lobbyName: snapshot.name,
      maxPlayers: snapshot.maxPlayers,
      mapId: snapshot.mapId,
      teamMode: snapshot.teamMode,
      startCondition: snapshot.startCondition,
      visibility: snapshot.visibility === 'private' ? 'private' : 'public',
    });
    this.serverAuthorizedLobbyStart = false;
    this.pendingLobbyConfig = null;
    this.onLobbyMatchStarted?.(snapshot);
    this.onHumanMatchStarted?.(snapshot);
  }

  private beginServerAuthorizedHumanMatch(snapshot: RoomSnapshot): void {
    this.beginServerAuthorizedLobbyMatch(snapshot);
  }

  private handleServerMatchEnded(
    snapshot: RoomSnapshot,
    placements: Record<string, number>
  ): void {
    if (!this.isRunningMatch) return;

    const localPlayer = this.network.state.players.get(this.network.localPlayerId);
    if (!localPlayer) return;

    this.network.state.phase = 'ENDED';
    this.network.state.matchMode = snapshot.matchMode || this.network.state.matchMode;
    this.network.state.winnerName = snapshot.winnerName || 'No winner recorded';
    this.network.state.winnerTeamId = snapshot.winnerTeamId || '';
    this.network.state.teamScores = { ...snapshot.teamScores };
    this.network.state.isDraw = Boolean(snapshot.isDraw);
    this.network.state.endReason = snapshot.endReason || '';
    const finalSelf = snapshot.players.find(p => p.id === this.network.serverPlayerId);
    if (finalSelf) localPlayer.eliminations = finalSelf.eliminations ?? localPlayer.eliminations;
    const isDraw = Boolean(snapshot.isDraw);
    const isVictory =
      !isDraw &&
      (snapshot.winnerId === this.network.serverPlayerId ||
        snapshot.winnerIds.includes(this.network.serverPlayerId));
    const serverPlacement = placements[this.network.serverPlayerId];
    const placement = isVictory
      ? 1
      : Number(serverPlacement || this.localEliminationPlacement || 0) ||
        Math.max(2, this.network.state.aliveCount + 1);

    this.hud.showFinalStandings(snapshot, placements);
    if (isVictory && !this.matchResultRecorded) this.sound.playVictory();
    this.showEndScreen(
      isVictory,
      placement,
      localPlayer,
      this.localEliminatedByName,
      isDraw
    );
  }

  public startMatch(config: LobbyConfig): void {
    const isHumanOnly = isHumanOnlySessionMode(config.mode);
    const isServerLobbyStart = this.serverAuthorizedLobbyStart;
    const requiresServerLobbyStart =
      isHumanOnly ||
      Boolean(config.createLobby) ||
      Boolean(this.pendingLobbyConfig && config.mode !== 'solo_bots');
    if (requiresServerLobbyStart && !isServerLobbyStart) {
      // Lobby-managed gameplay may only begin from the server's
      // match_started event. This is especially strict for human-only rooms.
      return;
    }

    const resolvedMatchMode: GameModeChoice = normalizeGameMode(
      config.matchMode ||
        config.createLobby?.matchMode ||
        this.network.roomSnapshot?.matchMode ||
        DEFAULT_GAME_MODE
    );
    const respawnMode = isRespawnMode(resolvedMatchMode);
    this.currentConfig = {
      ...config,
      matchMode: resolvedMatchMode,
      skyDrop: respawnMode ? false : config.skyDrop,
      botCount: effectiveBotCountForMode(config.mode, config.botCount),
      cosmetics: config.cosmetics || this.progression.cosmetics,
    };
    this.sound.resume();
    this.hud.clearFinalStandings();
    this.isPaused = false;
    this.clearTransientInput();
    this.activeBuildPreview = null;
    this.spectatedPlayerId = null;
    this.wasLocalInStorm = false; this.lastAudibleStormPhase = 0;
    this.countdownTimer = 2.6;
    this.lastCountdownBeepInt = 4;
    this.matchResultRecorded = false;
    this.localEliminationPlacement = null;
    this.localEliminatedByName = '';
    this.hud.updateBuildModeIndicator(null);
    this.hud.updateSpectatorBanner(null);
    this.hud.resetHUD();

    if (this.lobbyPreviewGroup) this.lobbyPreviewGroup.visible = false;
    if (this.lobbyCharacterMesh) this.lobbyCharacterMesh.root.visible = false;

    for (const cm of this.characterMeshes.values()) {
      this.scene.remove(cm.root);
      cm.dispose();
    }
    this.characterMeshes.clear();
    this.particles.clear();
    this.playerController.resetPresentation();
    this.stormSystem.resetPresentation();
    this.world.resetDynamicStructures();

    let spawnX = (Math.random() - 0.5) * 40;
    let spawnZ = (Math.random() - 0.5) * 40;
    if (
      !this.currentConfig.skyDrop &&
      Math.abs(spawnX) < 17 &&
      Math.abs(spawnZ) < 17
    ) {
      // Ground spawns use a clear Plaza approach instead of appearing
      // inside the central tower's walls/core. Skydiving remains free-form.
      if (Math.abs(spawnX) >= Math.abs(spawnZ)) {
        spawnX = spawnX < 0 ? -19 : 19;
        spawnZ = 4;
      } else {
        spawnX = 4;
        spawnZ = spawnZ < 0 ? -19 : 19;
      }
    }
    const groundY = this.world.terrain.getTerrainHeight(spawnX, spawnZ);
    const spawnY = this.currentConfig.skyDrop ? 92 : groundY + 0.3;

    this.network.setAccountCredentials(
      this.progression.credentials.accountId,
      this.progression.credentials.accountToken
    );

    const localPlayer =
      isHumanOnly || isServerLobbyStart
        ? this.network.initializeStartedMatch(this.currentConfig, spawnX, spawnY, spawnZ)
        : this.network.initializeMatch(this.currentConfig, spawnX, spawnY, spawnZ);
    this.createCharacterMeshForPlayer(localPlayer);

    this.lootSystem.populateWorldLoot(this.network.state, this.world, {
      // Online clients never mint map loot themselves; the room server
      // sends ground items, chests and vault rewards in room_loot_sync.
      includeLegendaryTowerVaultLoot: !this.network.isOnlineRoom,
    });

    if (!isHumanOnly) {
      const bots = this.botController.spawnBots(
        this.currentConfig.botCount,
        this.network.state,
        this.world,
        this.currentConfig.skyDrop,
        this.currentConfig.matchMode
      );
      for (const bot of bots) {
        this.createCharacterMeshForPlayer(bot);
      }
    }

    if (isHumanOnly || isServerLobbyStart) {
      const snapshot = this.network.roomSnapshot;
      const humanParticipants =
        snapshot?.matchParticipantCount || snapshot?.connectedHumans || 1;
      this.network.state.totalParticipants = Math.max(
        0,
        isHumanOnly
          ? humanParticipants
          : humanParticipants + (snapshot?.botCount ?? this.currentConfig.botCount)
      );
      this.network.state.aliveCount = Math.max(
        0,
        isHumanOnly
          ? snapshot?.aliveHumans || this.network.state.totalParticipants
          : this.network.state.totalParticipants
      );
    } else {
      this.network.state.totalParticipants = this.network.state.players.size;
      this.network.state.aliveCount = this.network.state.players.size;
    }
    this.isRunningMatch = true;

    document.getElementById('lobby-overlay')?.classList.add('hidden');
    document.getElementById('locker-overlay')?.classList.add('hidden');
    document.getElementById('howto-overlay')?.classList.add('hidden');
    document.getElementById('end-overlay')?.classList.add('hidden');
    document.getElementById('pause-overlay')?.classList.add('hidden');
    document.getElementById('hud-overlay')?.classList.remove('hidden');

    const cdOverlay = document.getElementById('countdown-overlay');
    const cdModePill = document.getElementById('countdown-mode-pill');
    if (cdOverlay) cdOverlay.classList.remove('hidden');
    if (cdModePill) {
      const modeTitle = gameModeLabel(this.currentConfig.matchMode).toUpperCase();
      cdModePill.textContent = isHumanOnly
        ? `👥 ${modeTitle} — HUMAN PLAYERS ONLY • ROOM: ${this.network.roomCode} • ${this.network.state.totalParticipants} HUMANS`
        : isServerLobbyStart
          ? `🌐 ${modeTitle} LOBBY: ${this.network.roomCode} • ${this.network.roomSnapshot?.matchParticipantCount ?? 1} HUMANS + ${this.currentConfig.botCount} AI`
          : this.currentConfig.mode === 'online'
            ? `🌐 ${modeTitle} ONLINE ROOM: ${this.network.roomCode}`
            : `🤖 SOLO ${modeTitle} (${this.network.state.totalParticipants} CONTENDERS)`;
    }

    this.requestPointerLock();
  }

  /** Clears held/one-shot controls so pause/end transitions cannot leak input. */
  public clearTransientInput(): void {
    this.mouseFireHeld = false;
    this.mouseAimHeld = false;
    this.touchFireHeld = false;
    this.touchAimHeld = false;
    this.mobileMoveX = 0;
    this.mobileMoveZ = 0;
    this.mobileJump = false;
    this.mobileSprint = false;
    this.pendingSlotSelect = -1;
    this.pendingInteract = false;
    this.pendingReload = false;
    this.pendingCycleMaterial = false;
    this.pendingBuild = null;
    this.onTransientInputCleared?.();
  }

  public togglePauseMenu(forceState?: boolean): void {
    if (!this.isRunningMatch) return;
    this.isPaused = forceState !== undefined ? forceState : !this.isPaused;
    const pauseEl = document.getElementById('pause-overlay');
    if (this.isPaused) {
      this.clearTransientInput();
      pauseEl?.classList.remove('hidden');
      if (document.pointerLockElement) {
        document.exitPointerLock();
      }
    } else {
      pauseEl?.classList.add('hidden');
      document.getElementById('settings-overlay')?.classList.add('hidden');
      document.getElementById('howto-overlay')?.classList.add('hidden');
      this.requestPointerLock();
    }
  }

  public returnToMainMenu(): void {
    this.isRunningMatch = false;
    this.isPaused = false;
    this.clearTransientInput();
    this.activeBuildPreview = null;
    this.spectatedPlayerId = null;
    if (
      isHumanOnlySessionMode(this.currentConfig.mode) ||
      this.pendingLobbyConfig ||
      this.network.isLobbyManagedRoom
    ) {
      this.leaveMultiplayerLobby();
    } else {
      this.network.disconnectMultiplayerRoom();
    }
    this.world.updateBuildPreview(null, 0, 0, 0, 0, false);
    this.hud.updateSpectatorBanner(null);

    for (const cm of this.characterMeshes.values()) {
      this.scene.remove(cm.root);
      cm.dispose();
    }
    this.characterMeshes.clear();
    this.particles.clear();
    this.playerController.resetPresentation();
    this.stormSystem.resetPresentation();
    this.world.resetDynamicStructures();

    if (this.lobbyPreviewGroup) this.lobbyPreviewGroup.visible = true;
    if (this.lobbyCharacterMesh) this.lobbyCharacterMesh.root.visible = true;

    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
    document.getElementById('countdown-overlay')?.classList.add('hidden');
    document.getElementById('hud-overlay')?.classList.add('hidden');
    document.getElementById('pause-overlay')?.classList.add('hidden');
    document.getElementById('end-overlay')?.classList.add('hidden');
    document.getElementById('settings-overlay')?.classList.add('hidden');
    document.getElementById('locker-overlay')?.classList.add('hidden');
    document.getElementById('howto-overlay')?.classList.add('hidden');
    document.getElementById('lobby-overlay')?.classList.remove('hidden');
    this.onProgressionUpdated?.();
  }

  public enterSpectatorMode(): void {
    document.getElementById('end-overlay')?.classList.add('hidden');
    this.cycleSpectatorTarget();
    this.requestPointerLock();
  }

  public cycleSpectatorTarget(): void {
    const state = this.network.state;
    const aliveOthers: PlayerState[] = [];
    for (const p of state.players.values()) {
      if (p.alive && p.id !== this.network.localPlayerId) {
        aliveOthers.push(p);
      }
    }
    if (aliveOthers.length === 0) {
      this.spectatedPlayerId = null;
      this.hud.updateSpectatorBanner(null);
      return;
    }
    const curIdx = aliveOthers.findIndex((p) => p.id === this.spectatedPlayerId);
    const next = aliveOthers[(curIdx + 1) % aliveOthers.length];
    this.spectatedPlayerId = next.id;
    this.hud.updateSpectatorBanner(next);
  }

  private createCharacterMeshForPlayer(player: PlayerState): CharacterMesh {
    const cm = new CharacterMesh(player);
    this.scene.add(cm.root);
    this.characterMeshes.set(player.id, cm);
    return cm;
  }

  public requestPointerLock(): void {
    // Touch-only phones/tablets do not use pointer lock, but hybrid laptops
    // with both a touchscreen and a fine mouse pointer should retain the
    // existing desktop pointer-lock experience.
    const touchOnly =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: none) and (pointer: coarse)').matches &&
      !window.matchMedia('(pointer: fine)').matches;
    if (!touchOnly && this.renderer.domElement.requestPointerLock) {
      this.renderer.domElement.requestPointerLock();
    }
  }

  private updatePerfMonitorDOM(snap: PerfSnapshot): void {
    const fpsEl = document.getElementById('hud-fps-counter');
    if (fpsEl) {
      fpsEl.textContent = `${snap.fps} FPS (${snap.avgFrameMs}ms)`;
    }
    const perfFpsVal = document.getElementById('perf-fps-val');
    if (perfFpsVal) {
      perfFpsVal.textContent = `${snap.fps} FPS`;
      perfFpsVal.className =
        snap.fps >= 52
          ? 'perf-fps-good'
          : snap.fps >= 35
            ? 'perf-fps-warn'
            : 'perf-fps-bad';
    }
    const presetBadge = document.getElementById('perf-preset-badge');
    if (presetBadge) {
      presetBadge.textContent = `${snap.qualityPreset.toUpperCase()} • DPR ${snap.pixelRatio}`;
    }
    const ftRow = document.getElementById('perf-frametime-row');
    if (ftRow) {
      ftRow.textContent = `CPU: ${snap.avgFrameMs}ms avg | ${snap.p95FrameMs}ms p95 | ${snap.maxFrameMs}ms max`;
    }
    const subRow = document.getElementById('perf-subsystems-row');
    if (subRow) {
      subRow.textContent = `AI: ${snap.botAiMs}ms | Anim: ${snap.charAnimMs}ms | World: ${snap.worldUpdateMs}ms | Render: ${snap.renderMs}ms`;
    }
    const renRow = document.getElementById('perf-renderer-row');
    if (renRow) {
      const trisK = (snap.triangles / 1000).toFixed(1);
      const heapStr = snap.heapUsedMB !== null ? `${snap.heapUsedMB}MB` : 'n/a';
      renRow.textContent = `Draws: ${snap.drawCalls} | Tris: ${trisK}k | Objs: ${snap.activeObjects} | Geo: ${snap.geometries} | Heap: ${heapStr}`;
    }
  }

  private animate(now: number): void {
    requestAnimationFrame((t) => this.animate(t));

    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    this.perfMonitor.beginFrame();

    this.perfMonitor.beginSubsystem();
    this.tpCamera.camera.getWorldDirection(this.cameraForwardScratch);
    this.world.update(dt, this.tpCamera.camera.position, this.cameraForwardScratch);
    this.perfMonitor.endSubsystem('world');

    this.perfMonitor.beginSubsystem();
    this.lootSystem.update(dt, this.tpCamera.camera.position);
    this.perfMonitor.endSubsystem('loot');

    this.perfMonitor.beginSubsystem();
    this.particles.update(dt);
    this.perfMonitor.endSubsystem('particles');

    if (this.isRunningMatch && !this.isPaused) {
      this.updateMatchLoop(dt);
    } else if (!this.isRunningMatch) {
      // Frame the live 3D Lobby Character Preview on the right side of the viewport
      const sx = this.lobbyPreviewState.position.x;
      const sy = this.lobbyPreviewState.position.y;
      const sz = this.lobbyPreviewState.position.z;
      const gentleBob = Math.sin(now * 0.0012) * 0.06;
      this.tpCamera.camera.fov = 50;
      this.tpCamera.camera.updateProjectionMatrix();
      this.tpCamera.camera.position.set(sx - 1.35, sy + 1.48 + gentleBob, sz + 3.45);
      this.tpCamera.camera.lookAt(sx, sy + 1.12, sz);
      this.lobbyPreviewState.yaw = this.lobbyPreviewYaw + Math.sin(now * 0.0007) * 0.14;
      this.lobbyPreviewState.facingYaw = this.lobbyPreviewState.yaw;

      this.perfMonitor.beginSubsystem();
      this.lobbyCharacterMesh.setReducedDetail(this.getResolvedGraphicsQuality() === 'low');
      const assetStatus = document.getElementById('preview-asset-status');
      const statusText = CharacterMesh.assetStatus === 'ready' ? 'Rigged operator · live preview'
        : CharacterMesh.assetStatus === 'failed' ? 'Lightweight operator · asset unavailable'
        : 'Lightweight operator · loading rig';
      if (assetStatus && assetStatus.textContent !== statusText) assetStatus.textContent = statusText;
      this.lobbyCharacterMesh.update(
        this.lobbyPreviewState,
        dt,
        this.tpCamera.camera.position
      );
      this.perfMonitor.endSubsystem('charAnim');
    }

    this.perfMonitor.beginSubsystem();
    // Reuse the same scene/operator in a small Locker window, not another renderer.
    // Always restore the full viewport before drawing actual gameplay.
    const previewWindow = !this.isRunningMatch && !document.getElementById('locker-overlay')?.classList.contains('hidden')
      ? document.getElementById('operator-preview-window') : null;
    if (previewWindow) {
      const r = previewWindow.getBoundingClientRect();
      const { height } = this.getViewportSize();
      if (r.width > 0 && r.height > 0) {
        this.renderer.setViewport(r.left, height - r.bottom, r.width, r.height);
        this.tpCamera.resize(r.width / r.height);
        this.hasPreviewViewport = true;
      }
    } else if (this.hasPreviewViewport) {
      const { width, height } = this.getViewportSize();
      this.renderer.setViewport(0, 0, width, height);
      this.tpCamera.resize(width / height);
      this.hasPreviewViewport = false;
    }
    // The new opaque menu does not need a hidden full-island draw every frame.
    // Keep rendering for gameplay (including pause) and the live Locker preview.
    if (this.isRunningMatch || previewWindow) this.renderer.render(this.scene, this.tpCamera.camera);
    this.aimDiagnostics.render(this.tpCamera.camera);
    this.perfMonitor.endSubsystem('render');

    const snap = this.perfMonitor.endFrame(
      this.renderer,
      this.scene,
      this.getEffectivePixelRatio(),
      this.resolvedGraphicsQuality
    );

    if (snap && this.settings.showFps) {
      this.updatePerfMonitorDOM(snap);
    }

    // Adaptive Render Resolution Scaling when frame times exceed budget
    if (this.isRunningMatch && !this.isPaused) {
      this.adaptiveScaleTimer += dt;
      if (this.adaptiveScaleTimer >= 1.0) {
        this.adaptiveScaleTimer = 0;
        const avgMs = this.perfMonitor.lastSnapshot.avgFrameMs;
        if (avgMs > 20.0 && this.adaptiveResolutionScale > 0.65) {
          this.adaptiveResolutionScale = Math.max(
            0.65,
            Math.round((this.adaptiveResolutionScale - 0.1) * 100) / 100
          );
          this.renderer.setPixelRatio(this.getEffectivePixelRatio());
        } else if (avgMs < 13.5 && this.adaptiveResolutionScale < 1.0) {
          this.adaptiveResolutionScale = Math.min(
            1.0,
            Math.round((this.adaptiveResolutionScale + 0.05) * 100) / 100
          );
          this.renderer.setPixelRatio(this.getEffectivePixelRatio());
        }

        // If resolution is already near its floor and the frame is still
        // over budget for two consecutive checks, shed cinematic detail.
        // Restoration uses a lower threshold to avoid visible oscillation.
        if (avgMs > 21 && this.adaptiveResolutionScale <= 0.7) {
          this.adaptiveSlowChecks++;
          if (this.adaptiveSlowChecks >= 2) {
            this.setAdaptiveDetailReduced(true);
          }
        } else if (avgMs < 14) {
          this.adaptiveSlowChecks = 0;
          this.setAdaptiveDetailReduced(false);
        } else {
          this.adaptiveSlowChecks = 0;
        }
      }
    }
  }

  private updateMatchLoop(dt: number): void {
    const state = this.network.state;
    const localPlayer = state.players.get(this.network.localPlayerId);
    if (!localPlayer) return;

    for (const p of state.players.values()) {
      if (!this.characterMeshes.has(p.id)) {
        this.createCharacterMeshForPlayer(p);
      }
    }

    // Authoritative snapshots prune departed remote humans from state; remove
    // their 3D meshes too so an explicit leave/forfeit cannot leave a frozen
    // character in the world.
    for (const [playerId, mesh] of Array.from(this.characterMeshes.entries())) {
      if (playerId.startsWith('net_') && !state.players.has(playerId)) {
        this.scene.remove(mesh.root);
        mesh.dispose();
        this.characterMeshes.delete(playerId);
      }
    }

    if (this.countdownTimer > 0) {
      this.countdownTimer = Math.max(0, this.countdownTimer - dt);
      const secInt = Math.ceil(this.countdownTimer);
      if (secInt < this.lastCountdownBeepInt && secInt >= 1) {
        this.lastCountdownBeepInt = secInt;
        this.sound.playCountdownBeep(secInt === 1);
      }
      const cdNumEl = document.getElementById('countdown-number');
      if (cdNumEl) {
        cdNumEl.textContent = secInt > 0 ? `${secInt}` : 'DROP!';
      }
      if (this.countdownTimer <= 0) {
        document.getElementById('countdown-overlay')?.classList.add('hidden');
      }
      this.hud.updateCountdown(this.countdownTimer);
      this.tpCamera.update(localPlayer, dt, this.world);
      for (const [id, cm] of this.characterMeshes.entries()) {
        const pState = state.players.get(id);
        if (pState) cm.update(pState, dt, this.tpCamera.camera.position);
      }
      return;
    }

    if (state.phase === 'ACTIVE' && !this.network.roomConnected) {
      state.matchTimer += dt;
      state.timeRemaining = getRemainingMatchSeconds(
        state.matchMode,
        state.matchTimer,
        state.durationSeconds
      );
      if (
        isTimedMode(state.matchMode) &&
        isMatchTimeExpired(state.matchMode, state.matchTimer, state.durationSeconds)
      ) {
        const outcome = evaluateMatchOutcome({
          mode: state.matchMode,
          players: Array.from(state.players.values()),
          teamScores: state.teamScores,
          elapsedSeconds: state.matchTimer,
          minPlayers: 1,
          durationSeconds: state.durationSeconds,
        });
        if (outcome.ended) {
          state.phase = 'ENDED';
          state.winnerName = outcome.winnerName;
          state.winnerTeamId = outcome.winnerTeamId;
          state.teamScores = outcome.teamScores;
          state.isDraw = outcome.isDraw;
          state.endReason = outcome.reason;
          const isVictory =
            !outcome.isDraw && outcome.winnerIds.includes(localPlayer.id);
          const placement =
            outcome.placements[localPlayer.id] || (isVictory ? 1 : 2);
          if (isVictory) this.sound.playVictory();
          this.showEndScreen(
            isVictory,
            placement,
            localPlayer,
            '',
            outcome.isDraw
          );
          return;
        }
      }
    }

    const keyboardMoveX =
      (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    const keyboardMoveZ =
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0) -
      (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0);
    const { moveX, moveZ } = combineMoveInput(
      keyboardMoveX,
      keyboardMoveZ,
      this.mobileMoveX,
      this.mobileMoveZ
    );

    let fireHeld = this.mouseFireHeld || this.touchFireHeld;
    let buildTypeToPlace: BuildPieceType | null = this.pendingBuild;
    if (this.activeBuildPreview && fireHeld) {
      buildTypeToPlace = this.activeBuildPreview;
      this.activeBuildPreview = null;
      this.hud.updateBuildModeIndicator(null);
      this.mouseFireHeld = false;
      this.touchFireHeld = false;
      fireHeld = false;
    }

    const inputPacket: PlayerInputPacket = {
      seq: ++this.seqCounter,
      dt,
      moveX,
      moveZ,
      jump: this.keys.has('Space') || this.mobileJump,
      sprint:
        this.keys.has('ShiftLeft') ||
        this.keys.has('ShiftRight') ||
        this.mobileSprint,
      aim: this.mouseAimHeld || this.touchAimHeld,
      fire: fireHeld && !this.activeBuildPreview,
      reload: this.pendingReload,
      interact: this.pendingInteract,
      buildType: buildTypeToPlace,
      cycleMaterial: this.pendingCycleMaterial,
      selectSlot: this.pendingSlotSelect,
      yaw: this.tpCamera.yaw,
      pitch: this.tpCamera.pitch,
    };

    if (this.pendingSlotSelect >= 0) {
      this.activeBuildPreview = null;
      this.hud.updateBuildModeIndicator(null);
    }

    this.pendingSlotSelect = -1;
    this.pendingInteract = false;
    this.pendingReload = false;
    this.pendingCycleMaterial = false;
    this.pendingBuild = null;
    this.mobileJump = false;

    // The crosshair is the centre of the screen, so the ray that decides what
    // the player is aiming at has to come out of the rendered camera.
    const aimRay = this.tpCamera.getCameraRay();

    if (localPlayer.alive) {
      this.playerController.updateLocalPlayer(
        localPlayer,
        inputPacket,
        state,
        this.world,
        this.characterMeshes,
        this.lootSystem,
        this.particles,
        this.sound,
        aimRay,
        (attacker, victim, dmg, isHead, isShield, weaponName, hitPoint) =>
          this.handlePlayerHit(attacker, victim, dmg, isHead, isShield, weaponName, hitPoint),
        (_isHead, _isShield) => {
          // Hitmarker, sound, and camera confirmation pulse are triggered authoritatively in handlePlayerHit / onServerHitEvent
        },
        (pitchKick, yawKick, category, isAiming) => {
          this.tpCamera.applyRecoil(
            pitchKick,
            yawKick,
            category as WeaponCategory | undefined,
            isAiming
          );
        }
      );

      this.aimDiagnostics.setSolution(this.playerController.lastAimSolution);
      this.hud.setAimObstructed(this.playerController.isAimBlocked());

      this.network.sendInput(inputPacket);

      this.world.updateBuildPreview(
        this.activeBuildPreview,
        localPlayer.position.x,
        localPlayer.position.y,
        localPlayer.position.z,
        this.tpCamera.yaw,
        this.playerController.canAffordBuild(localPlayer)
      );
    } else {
      this.world.updateBuildPreview(null, 0, 0, 0, 0, false);
    }

    let cameraTarget = localPlayer;
    if (!localPlayer.alive && this.spectatedPlayerId) {
      const spec = state.players.get(this.spectatedPlayerId);
      if (spec && spec.alive) {
        cameraTarget = spec;
        this.hud.updateSpectatorBanner(spec);
      } else {
        this.cycleSpectatorTarget();
      }
    }
    this.tpCamera.update(cameraTarget, dt, this.world);

    // Center directional shadow frustum near cameraTarget every 20 frames for crisp local shadows
    this.shadowCenterTick++;
    if (this.dirLight.castShadow && this.shadowCenterTick >= 20) {
      this.shadowCenterTick = 0;
      const tx = Math.round(cameraTarget.position.x / 8) * 8;
      const tz = Math.round(cameraTarget.position.z / 8) * 8;
      this.dirLightTarget.position.set(tx, 0, tz);
      this.dirLightTarget.updateMatrixWorld();
      this.dirLight.position.copy(this.dirLightTarget.position).add(this.sunOffset);
    }

    // Smoothly interpolate remote human players at 60Hz+ render rate
    this.network.updateRemotePlayers(dt);

    if (!isHumanOnlySessionMode(this.currentConfig.mode)) {
      this.perfMonitor.beginSubsystem();
      this.botController.updateBots(
        dt,
        state,
        this.world,
        this.characterMeshes,
        this.playerController,
        this.lootSystem,
        this.particles,
        this.sound,
        this.currentConfig.difficulty,
        (attacker, victim, dmg, isHead, isShield, weaponName, hitPoint) =>
          this.handlePlayerHit(attacker, victim, dmg, isHead, isShield, weaponName, hitPoint)
      );
      this.perfMonitor.endSubsystem('botAi');
    }

    // Storm update: only active in Battle Royale mode
    if (isStormEnabledForMode(state.matchMode)) {
      if (this.network.isOnlineRoom && this.network.roomConnected) {
        this.stormSystem.syncVisuals(state, dt);
      } else {
        this.stormSystem.update(dt, state);
      }

      if (!isHumanOnlySessionMode(this.currentConfig.mode)) {
        this.stormDamageTicker += dt;
        if (this.stormDamageTicker >= 1.0) {
          this.stormDamageTicker = 0;
          for (const p of state.players.values()) {
            if (!p.alive || p.isGliding) continue;
            if (!p.isBot && p.id !== this.network.localPlayerId) continue;
            if (this.stormSystem.isPositionInStorm(state, p.position.x, p.position.z)) {
              this.applyDirectHealthDamage(p, state.storm.damagePerSecond, null, 'The Storm');
            }
          }
        }
      } else {
        // Human-only storm damage/eliminations are server-authoritative and
        // arrive as server_hit events; local prediction would double-apply it.
        this.stormDamageTicker = 0;
      }
    } else {
      this.stormDamageTicker = 0;
    }

    this.perfMonitor.beginSubsystem();
    for (const [id, cm] of this.characterMeshes.entries()) {
      const pState = state.players.get(id);
      if (pState) {
        cm.setReducedDetail(this.adaptiveDetailReduced || this.getResolvedGraphicsQuality() === 'low');
        cm.update(pState, dt, this.tpCamera.camera.position);
      }
    }
    this.perfMonitor.endSubsystem('charAnim');

    const hudSubject =
      !localPlayer.alive && this.spectatedPlayerId
        ? state.players.get(this.spectatedPlayerId) || localPlayer
        : localPlayer;

    const nearestLoot = this.lootSystem.findNearestInteractable(
      state,
      hudSubject.position.x,
      hudSubject.position.y,
      hudSubject.position.z
    );
    const localInStorm =
      isStormEnabledForMode(state.matchMode) &&
      hudSubject.alive &&
      !hudSubject.isGliding &&
      this.stormSystem.isPositionInStorm(
        state,
        hudSubject.position.x,
        hudSubject.position.z
      );

    if (this.lastAudibleStormPhase !== 0 && state.storm.phase !== this.lastAudibleStormPhase && state.storm.phase >= 6) {
      this.sound.playFinalZoneCue();
    }
    this.lastAudibleStormPhase = state.storm.phase;
    if (localInStorm && !this.wasLocalInStorm) {
      this.sound.playStormWarning();
    }
    this.wasLocalInStorm = localInStorm;

    this.hud.updateHUD(
      dt,
      state,
      hudSubject,
      nearestLoot,
      localInStorm,
      this.tpCamera.camera
    );
  }

  private recountAliveCombatants(): void {
    const state = this.network.state;

    if (isHumanOnlySessionMode(this.currentConfig.mode)) {
      const snapshot = this.network.roomSnapshot;
      if (snapshot?.matchParticipantCount) {
        state.totalParticipants = snapshot.matchParticipantCount;
      }

      if (snapshot && state.players.size < snapshot.matchParticipantCount) {
        state.aliveCount = snapshot.aliveHumans;
        return;
      }

      let aliveHumans = 0;
      for (const player of state.players.values()) {
        const isHumanPlayer =
          !player.isBot &&
          (player.id === this.network.localPlayerId || player.id.startsWith('net_')) &&
          player.isParticipant !== false;
        if (isHumanPlayer && player.alive) aliveHumans++;
      }
      state.aliveCount = state.totalParticipants
        ? Math.min(state.totalParticipants, aliveHumans)
        : aliveHumans;
      return;
    }

    let alive = 0;
    for (const p of state.players.values()) {
      if (p.alive) alive++;
    }
    state.aliveCount = alive;
  }

  private handlePlayerHit(
    attacker: PlayerState,
    victim: PlayerState,
    damage: number,
    isHeadshot: boolean,
    isShieldHit: boolean,
    weaponName: string,
    hitPoint: THREE.Vector3
  ): void {
    if (!victim.alive) return;
    if (
      areTeammates(
        this.network.state.matchMode,
        attacker,
        victim,
        this.currentConfig.teamMode || 'solo'
      )
    ) {
      return;
    }

    attacker.damageDealt += damage;

    // If local player hits a remote human player in an Online Room, send to server for authoritative resolution
    // without applying duplicate local damage or duplicate damage numbers before onServerHitEvent arrives.
    if (
      this.network.isOnlineRoom &&
      this.network.roomConnected &&
      attacker.id === this.network.localPlayerId &&
      !victim.isBot
    ) {
      const activeSlot = attacker.inventory[attacker.activeSlot];
      this.network.sendCombatHit(
        victim.id,
        damage,
        isHeadshot,
        weaponName,
        {
          x: hitPoint.x,
          y: hitPoint.y,
          z: hitPoint.z,
        },
        activeSlot?.category,
        activeSlot?.rarity
      );
      return;
    }

    const hadShield = victim.shield > 0;
    let rem = damage;
    if (victim.shield > 0) {
      const absorbed = Math.min(victim.shield, rem);
      victim.shield -= absorbed;
      rem -= absorbed;
    }
    if (rem > 0) {
      victim.health = Math.max(0, victim.health - rem);
    }
    const isShieldBreak = hadShield && victim.shield <= 0;

    if (victim.id === this.network.localPlayerId) {
      this.sound.playDamageTaken(isShieldHit);
      this.hud.triggerDamageTakenFlash(isShieldHit);
    }

    const victimMesh = this.characterMeshes.get(victim.id);
    victimMesh?.triggerHitFlash(isHeadshot, isShieldHit);

    this.particles.spawnSurfaceImpact(
      hitPoint,
      isShieldHit ? 'shield' : 'flesh',
      isShieldBreak,
      isHeadshot
    );

    const willEliminate = victim.health <= 0;

    if (attacker.id === this.network.localPlayerId) {
      this.tpCamera.applyHitConfirmationPulse(isHeadshot, willEliminate);
      this.sound.playHitmarker(isHeadshot, isShieldHit, willEliminate);
      this.hud.showHitmarker(
        isHeadshot,
        isShieldHit,
        willEliminate,
        isShieldBreak
      );
    }

    if (
      attacker.id === this.network.localPlayerId ||
      victim.id === this.network.localPlayerId
    ) {
      if (isShieldBreak) {
        this.sound.playShieldBreak(1.0);
      } else {
        this.sound.playSurfaceImpact(isShieldHit ? 'shield' : 'flesh', 0.85);
      }
      this.hud.spawnDamageNumber(
        hitPoint,
        damage,
        isHeadshot,
        isShieldHit,
        isShieldBreak
      );
    }

    if (willEliminate) {
      this.eliminatePlayer(victim, attacker, weaponName, isHeadshot);
    }
  }

  private applyDirectHealthDamage(
    victim: PlayerState,
    damage: number,
    attacker: PlayerState | null,
    sourceName: string
  ): void {
    if (!victim.alive) return;
    victim.health = Math.max(0, victim.health - damage);
    if (victim.id === this.network.localPlayerId) {
      this.sound.playDamageTaken();
      this.hud.triggerDamageTakenFlash(false, sourceName === 'The Storm');
    }
    if (victim.health <= 0) {
      this.eliminatePlayer(victim, attacker, sourceName, false);
    }
  }

  private respawnLocalPlayer(localPlayer: PlayerState): void {
    const angle = ((localPlayer.respawns || 0) * 1.9 + 0.6) % (Math.PI * 2);
    const radius = 38 + ((localPlayer.respawns || 0) % 3) * 18;
    const rawX = Math.cos(angle) * radius;
    const rawZ = Math.sin(angle) * radius;
    const groundY = this.world.terrain.getTerrainHeight(rawX, rawZ);
    localPlayer.alive = true;
    localPlayer.health = 100;
    localPlayer.maxHealth = 100;
    localPlayer.shield = 50;
    localPlayer.maxShield = 100;
    localPlayer.livesRemaining = null;
    localPlayer.respawns = (localPlayer.respawns || 0) + 1;
    localPlayer.isGliding = false;
    localPlayer.isGrounded = true;
    localPlayer.isReloading = false;
    localPlayer.isHealing = false;
    localPlayer.position.x = rawX;
    localPlayer.position.y = Math.max(1.0, groundY + 0.25);
    localPlayer.position.z = rawZ;
    localPlayer.velocity = { x: 0, y: 0, z: 0 };
    for (const slot of localPlayer.inventory) {
      if (slot && !slot.isConsumable && slot.maxClipAmmo > 0) {
        slot.clipAmmo = slot.maxClipAmmo;
      }
    }
    localPlayer.ammo = { none: 0, light: 72, medium: 90, shells: 24, heavy: 15 };
  }

  private eliminatePlayer(
    victim: PlayerState,
    killer: PlayerState | null,
    weaponName: string,
    isHeadshot: boolean = false
  ): void {
    if (!victim.alive) return;
    victim.alive = false;
    victim.deaths = (victim.deaths || 0) + 1;

    const state = this.network.state;
    const eliminatedPlacement = state.aliveCount;

    if (killer && killer.id !== victim.id) {
      killer.eliminations++;
      this.hud.pushKillFeed(killer.name, victim.name, weaponName, isHeadshot);
      if (killer.id === this.network.localPlayerId) {
        this.sound.playElimination();
        this.hud.showHitmarker(isHeadshot, false, true);
        this.hud.showEliminationBanner(
          victim.name,
          weaponName,
          isHeadshot,
          killer.eliminations
        );
      }
    } else {
      this.hud.pushKillFeed('The Storm', victim.name, weaponName, false);
    }

    this.particles.spawnEliminationEffect(
      new THREE.Vector3(victim.position.x, victim.position.y, victim.position.z)
    );

    const localPlayer = state.players.get(this.network.localPlayerId)!;

    if (isRespawnMode(state.matchMode)) {
      state.teamScores = computeTeamScores(Array.from(state.players.values()));
      const outcome = evaluateMatchOutcome({
        mode: state.matchMode,
        players: Array.from(state.players.values()),
        teamScores: state.teamScores,
        elapsedSeconds: state.matchTimer,
        minPlayers: 1,
        durationSeconds: state.durationSeconds,
      });

      if (outcome.ended) {
        state.phase = 'ENDED';
        state.winnerName = outcome.winnerName;
        state.winnerTeamId = outcome.winnerTeamId;
        state.isDraw = outcome.isDraw;
        state.endReason = outcome.reason;
        const isVictory =
          !outcome.isDraw && outcome.winnerIds.includes(localPlayer.id);
        const placement =
          outcome.placements[localPlayer.id] || (isVictory ? 1 : 2);
        if (isVictory) this.sound.playVictory();
        this.showEndScreen(
          isVictory,
          placement,
          localPlayer,
          killer?.name || '',
          outcome.isDraw
        );
        return;
      }

      if (victim.isBot) {
        this.botController.respawnBot(victim, state, this.world);
      } else if (victim.id === localPlayer.id) {
        this.respawnLocalPlayer(localPlayer);
        this.hud.showCombatCue('RESPAWNED — BACK IN ACTION', '#38bdf8');
      }
      this.recountAliveCombatants();
      return;
    }

    this.lootSystem.dropEliminatedPlayerLoot(state, victim);

    let alive = 0;
    let lastAlivePlayer: PlayerState | null = null;
    for (const p of state.players.values()) {
      if (p.alive) {
        alive++;
        lastAlivePlayer = p;
      }
    }
    state.aliveCount = alive;

    if (victim.id === localPlayer.id) {
      this.showEndScreen(false, eliminatedPlacement, localPlayer, killer?.name || 'The Storm');
    } else if (alive <= 1 && localPlayer.alive) {
      state.phase = 'ENDED';
      state.winnerName = lastAlivePlayer ? lastAlivePlayer.name : localPlayer.name;
      this.sound.playVictory();
      this.showEndScreen(true, 1, localPlayer, '');
    }
  }

  private showEndScreen(
    isVictory: boolean,
    placement: number,
    localPlayer: PlayerState,
    eliminatedBy: string,
    isDraw: boolean = false
  ): void {
    this.clearTransientInput();
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }

    if (isVictory) {
      const pPos = new THREE.Vector3(
        localPlayer.position.x,
        localPlayer.position.y + 1.8,
        localPlayer.position.z
      );
      this.particles.spawnImpactBurst(pPos, 0xfacc15, 32, 9.5);
      this.particles.spawnImpactBurst(pPos, 0x38bdf8, 22, 8.0);
      this.particles.spawnShockwaveRing(pPos, 0xfacc15, 5.5);
    }

    this.hud.triggerVictoryPresentation(isVictory);

    const endOverlay = document.getElementById('end-overlay')!;
    const banner = document.getElementById('end-banner-title')!;
    const subtitle = document.getElementById('end-banner-subtitle')!;
    const spectateBtn = document.getElementById('btn-spectate-match');

    const matchMode = this.network.state.matchMode || 'battle_royale';
    if (isDraw) {
      banner.textContent = '🤝 MATCH DRAW';
      banner.className = 'end-title defeated';
      subtitle.textContent =
        matchMode === 'team_deathmatch'
          ? `Time expired with RED ${this.network.state.teamScores.red} — ${this.network.state.teamScores.blue} BLUE tied!`
          : `Time expired in a tied Free for All (${localPlayer.eliminations} Eliminations)!`;
    } else if (matchMode === 'team_deathmatch') {
      banner.textContent = isVictory
        ? '🏆 TEAM DEATHMATCH VICTORY!'
        : '💀 TEAM DEFEATED';
      banner.className = isVictory ? 'end-title victory' : 'end-title defeated';
      const winningLabel =
        this.network.state.winnerName ||
        (this.network.state.winnerTeamId === 'blue' ? 'BLUE TEAM' : 'RED TEAM');
      subtitle.textContent = `${winningLabel} won Team Deathmatch (${this.network.state.teamScores.red} RED — ${this.network.state.teamScores.blue} BLUE)`;
    } else if (matchMode === 'free_for_all') {
      banner.textContent = isVictory
        ? '🏆 FREE FOR ALL VICTORY!'
        : '💀 MATCH COMPLETE';
      banner.className = isVictory ? 'end-title victory' : 'end-title defeated';
      subtitle.textContent = isVictory
        ? `${localPlayer.name} won Free for All with ${localPlayer.eliminations} Eliminations!`
        : `${this.network.state.winnerName || 'Opponent'} won Free for All — Placed #${placement} (${localPlayer.eliminations} Eliminations)`;
    } else {
      banner.textContent = isVictory ? '👑 VICTORY ROYALE!' : '💀 ELIMINATED';
      banner.className = isVictory ? 'end-title victory' : 'end-title defeated';
      const teamMode = this.currentConfig.teamMode || 'solo';
      const isTeamMatch = teamMode === 'duo' || teamMode === 'squad';
      const placementTotal = isTeamMatch
        ? new Set(
            Array.from(this.network.state.players.values()).map(
              (player) => player.teamId || player.id
            )
          ).size
        : this.network.state.totalParticipants;
      subtitle.textContent = isVictory
        ? isTeamMatch
          ? `Your ${teamMode === 'duo' ? 'Duo' : 'Squad'} team conquered the CI Craft Island!`
          : `${localPlayer.name} conquered the CI Craft Island!`
        : `Eliminated by ${eliminatedBy} — Placed #${placement} of ${placementTotal}${isTeamMatch ? ' teams' : ''}`;
    }

    if (spectateBtn) {
      spectateBtn.classList.toggle(
        'hidden',
        isVictory || this.network.state.phase === 'ENDED' || this.network.state.aliveCount < 2
      );
    }

    document.getElementById('stat-rank')!.textContent = `#${placement}`;
    document.getElementById('stat-kills')!.textContent = `${localPlayer.eliminations}`;
    document.getElementById('stat-dmg')!.textContent = `${localPlayer.damageDealt}`;

    const acc =
      localPlayer.shotsFired > 0
        ? Math.round((localPlayer.shotsHit / localPlayer.shotsFired) * 100)
        : 0;
    const accEl = document.getElementById('stat-accuracy');
    if (accEl) accEl.textContent = `${acc}%`;

    const buildsEl = document.getElementById('stat-builds');
    if (buildsEl) buildsEl.textContent = `${localPlayer.structuresBuilt}`;

    const totalSecs = Math.floor(this.network.state.matchTimer);
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    document.getElementById('stat-time')!.textContent = `${m}m ${s}s`;

    if (!this.matchResultRecorded) {
      this.matchResultRecorded = true;
      const isServerVer =
        this.network.isOnlineRoom && this.network.roomConnected;
      const xpBreakdown = this.progression.recordVerifiedMatchResult(
        placement,
        localPlayer.eliminations,
        localPlayer.damageDealt,
        isVictory,
        isServerVer
      );
      const xpSummaryEl = document.getElementById('end-xp-summary');
      if (xpSummaryEl) {
        xpSummaryEl.innerHTML = `⭐ <strong>+${xpBreakdown.totalEarnedXp} XP EARNED</strong> (Match +${xpBreakdown.participationXp} • Elims +${xpBreakdown.eliminationXp} • Damage +${xpBreakdown.damageXp} • Placement +${xpBreakdown.placementXp}) — <strong>LEVEL ${xpBreakdown.newLevel}</strong>${
          xpBreakdown.leveledUp ? ' 🎉 LEVEL UP!' : ''
        }`;
      }
      this.onProgressionUpdated?.();
    }

    endOverlay.classList.remove('hidden');
  }

  private getViewportSize(): { width: number; height: number } {
    const visualViewport = window.visualViewport;
    return {
      width: Math.max(1, Math.round(visualViewport?.width ?? window.innerWidth)),
      height: Math.max(1, Math.round(visualViewport?.height ?? window.innerHeight)),
    };
  }

  private onWindowResize(): void {
    const { width, height } = this.getViewportSize();
    this.renderer.setSize(width, height);
    this.tpCamera.resize(width / height);
  }

  public handleMouseMove(movementX: number, movementY: number): void {
    this.tpCamera.handleMouseMove(movementX, movementY);
  }

  public handleTouchLook(deltaX: number, deltaY: number): void {
    const localPlayer = this.network.state.players.get(this.network.localPlayerId);
    const precisionScale = localPlayer?.isAiming ? 0.62 : 1;
    this.tpCamera.handleTouchLook(deltaX, deltaY, precisionScale);
  }
}
