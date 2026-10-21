import {
  BackAccessoryType,
  BuildMaterialType,
  BuildPieceType,
  InventorySlot,
  LobbyConfig,
  LootItemState,
  MatchState,
  PlayerInputPacket,
  PlayerProgressionState,
  PlayerState,
  StarterLoadoutType,
  StormState,
  WeaponCategory,
  WeaponRarity,
} from './schemas';
import { createWeaponStats } from '../weapons/WeaponDefinitions';

export interface ServerHitEvent {
  eventId?: string;
  attackerId: string;
  attackerName: string;
  victimId: string;
  victimSessionToken: string;
  victimName: string;
  damage: number;
  victimHealth: number;
  victimShield: number;
  isHeadshot: boolean;
  isShieldHit: boolean;
  isShieldBreak?: boolean;
  weaponName: string;
  hitPoint: { x: number; y: number; z: number };
  eliminated: boolean;
}

export type NetworkConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export interface RemoteInterpolationTarget {
  targetX: number;
  targetY: number;
  targetZ: number;
  velX: number;
  velY: number;
  velZ: number;
  targetYaw: number;
  targetFacingYaw: number;
  targetPitch: number;
  lastPacketPerfMs: number;
}

export interface NetworkTelemetryMetrics {
  packetsReceived: number;
  bytesReceived: number;
  lastRoomStateBytes: number;
  avgBroadcastIntervalMs: number;
  remoteInterpolatedPlayers: number;
}

function q2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function q3(n: number): number {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function lerpShortestAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

export class NetworkManager {
  public localPlayerId: string = 'player_local_1';
  public state: MatchState;
  public isOnlineRoom: boolean = false;
  public roomConnected: boolean = false;
  public connectionState: NetworkConnectionState = 'idle';
  public roomCode: string = 'CICRAFT-1';
  public connectedHumanCount: number = 1;
  private ws: WebSocket | null = null;
  public sessionToken: string = '';
  public accountId: string = '';
  public accountToken: string = '';
  private reconnectTimer: number | null = null;
  private lastSyncSentTime: number = 0;
  private lastSentPosX: number = NaN;
  private lastSentPosY: number = NaN;
  private lastSentPosZ: number = NaN;
  private lastSentYaw: number = NaN;
  private lastSentPitch: number = NaN;
  private lastSentStateSignature: string = '';
  private hitCounter: number = 0;

  private remoteTargets: Map<string, RemoteInterpolationTarget> = new Map();
  private hasRenderLoopDrivenInterpolation: boolean = false;
  private packetsReceived: number = 0;
  private bytesReceived: number = 0;
  private lastRoomStateBytes: number = 0;
  private lastRoomStatePerfMs: number = 0;
  private avgBroadcastIntervalMs: number = 50;

  public onRemoteBuildPlaced?: (
    buildId: string,
    ownerId: string,
    pieceType: BuildPieceType,
    x: number,
    y: number,
    z: number,
    yaw: number,
    material: BuildMaterialType
  ) => void;
  public onRemoteBuildDamaged?: (destructibleId: string, damage: number) => void;
  public onRemoteWeaponFired?: (
    shooterId: string,
    category: WeaponCategory,
    muzzlePos: { x: number; y: number; z: number },
    hitPoint: { x: number; y: number; z: number }
  ) => void;
  public onServerHitEvent?: (ev: ServerHitEvent) => void;
  public onRemoteLootCollected?: (
    collectorId: string,
    lootId: string,
    itemType: string,
    spawnedDrops?: LootItemState[],
    swappedDrop?: LootItemState
  ) => void;
  public onRoomLootSync?: (
    collectedIds: string[],
    spawnedItems: LootItemState[]
  ) => void;
  public onLootCollectRejected?: (lootId: string, reason: string) => void;
  public onServerProgressionUpdate?: (
    profile: Partial<PlayerProgressionState>
  ) => void;
  public onConnectionStatusChange?: (
    statusText: string,
    connected: boolean,
    connState?: NetworkConnectionState,
    humanCount?: number
  ) => void;

  constructor() {
    this.sessionToken = this.loadOrCreateSessionToken();
    this.state = this.createFreshMatchState();
  }

  private loadOrCreateSessionToken(): string {
    const key = 'cicraft_session_token_v2_8';
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        const existing = window.sessionStorage.getItem(key);
        if (existing && existing.startsWith('sess_')) return existing;
      } catch {
        // Ignore storage error
      }
    }
    const generated = `sess_${Math.random().toString(36).substring(2, 10)}`;
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        window.sessionStorage.setItem(key, generated);
      } catch {
        // Ignore storage error
      }
    }
    return generated;
  }

  public setAccountCredentials(accountId: string, accountToken: string): void {
    this.accountId = accountId;
    this.accountToken = accountToken;
  }

  public resolveHttpBaseUrl(): string {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    const raw = env?.VITE_MULTIPLAYER_SERVER_URL || '';
    return raw.trim().replace(/\/+$/, '');
  }

  public resolveWebSocketUrl(): string {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    if (env?.VITE_MULTIPLAYER_WS_URL) {
      return env.VITE_MULTIPLAYER_WS_URL.trim();
    }
    if (env?.VITE_MULTIPLAYER_SERVER_URL) {
      const httpBase = env.VITE_MULTIPLAYER_SERVER_URL.trim().replace(/\/+$/, '');
      if (httpBase.startsWith('https://')) {
        return `${httpBase.replace(/^https:\/\//, 'wss://')}/ws`;
      }
      if (httpBase.startsWith('http://')) {
        return `${httpBase.replace(/^http:\/\//, 'ws://')}/ws`;
      }
    }
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${window.location.host}/ws`;
  }

  public async fetchRoomStatus(code: string): Promise<{
    ok: boolean;
    roomCode: string;
    exists: boolean;
    connectedPlayers: number;
    totalPlayers: number;
  }> {
    const cleanCode = (code || 'CICRAFT-1').trim().toUpperCase();
    if (typeof fetch !== 'function') {
      return {
        ok: false,
        roomCode: cleanCode,
        exists: false,
        connectedPlayers: 0,
        totalPlayers: 0,
      };
    }
    try {
      const res = await fetch(
        `${this.resolveHttpBaseUrl()}/api/room?code=${encodeURIComponent(cleanCode)}`
      );
      if (!res.ok) throw new Error('Status check failed');
      const data = await res.json();
      return {
        ok: true,
        roomCode: String(data.roomCode || cleanCode),
        exists: Boolean(data.exists),
        connectedPlayers: Number(data.connectedPlayers || 0),
        totalPlayers: Number(data.totalPlayers || 0),
      };
    } catch {
      return {
        ok: false,
        roomCode: cleanCode,
        exists: false,
        connectedPlayers: 0,
        totalPlayers: 0,
      };
    }
  }

  public async createPrivateRoom(): Promise<string> {
    if (typeof fetch === 'function') {
      try {
        const res = await fetch(`${this.resolveHttpBaseUrl()}/api/room/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.roomCode) return String(data.roomCode);
        }
      } catch {
        // Fall through to client code generation
      }
    }
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let suffix = '';
    for (let i = 0; i < 4; i++) {
      suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    return `CI-${suffix}`;
  }

  public createFreshMatchState(): MatchState {
    this.remoteTargets.clear();
    return {
      phase: 'LOBBY',
      matchTimer: 0,
      aliveCount: 0,
      totalParticipants: 0,
      winnerName: '',
      players: new Map(),
      lootItems: new Map(),
      buildables: new Map(),
      storm: {
        phase: 1,
        currentCenterX: 0,
        currentCenterZ: 0,
        currentRadius: 255,
        targetCenterX: 0,
        targetCenterZ: 0,
        targetRadius: 145,
        phaseTimer: 40,
        isShrinking: false,
        damagePerSecond: 2,
      },
    };
  }

  public initializeMatch(
    config: LobbyConfig,
    spawnX: number,
    spawnY: number,
    spawnZ: number
  ): PlayerState {
    this.state = this.createFreshMatchState();
    this.state.phase = 'ACTIVE';
    this.isOnlineRoom = config.mode === 'online';
    this.roomCode = (config.roomCode || 'CICRAFT-1').trim().toUpperCase();

    const harvesterStats = createWeaponStats('harvester', 'rare');
    const loadoutInfo = this.getStarterLoadoutItems(config.starterLoadout);
    const primaryStats = createWeaponStats(loadoutInfo.primaryCat, loadoutInfo.primaryRarity);
    const secondaryStats = createWeaponStats(
      loadoutInfo.secondaryCat,
      loadoutInfo.secondaryRarity
    );

    const inventory: (InventorySlot | null)[] = [
      {
        weaponId: harvesterStats.id,
        name: harvesterStats.name,
        category: 'harvester',
        rarity: 'rare',
        clipAmmo: 999,
        maxClipAmmo: 999,
        ammoType: 'none',
        isConsumable: false,
        count: 1,
      },
      {
        weaponId: primaryStats.id,
        name: primaryStats.name,
        category: loadoutInfo.primaryCat,
        rarity: loadoutInfo.primaryRarity,
        clipAmmo: primaryStats.clipSize,
        maxClipAmmo: primaryStats.clipSize,
        ammoType: primaryStats.ammoType,
        isConsumable: false,
        count: 1,
      },
      {
        weaponId: secondaryStats.id,
        name: secondaryStats.name,
        category: loadoutInfo.secondaryCat,
        rarity: loadoutInfo.secondaryRarity,
        clipAmmo: secondaryStats.clipSize,
        maxClipAmmo: secondaryStats.clipSize,
        ammoType: secondaryStats.ammoType,
        isConsumable: false,
        count: 1,
      },
      null,
      null,
    ];

    const localPlayer: PlayerState = {
      id: this.localPlayerId,
      name: config.playerName.trim() || 'Commander_CI',
      isBot: false,
      isConnected: true,
      alive: true,
      position: { x: spawnX, y: spawnY, z: spawnZ },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      facingYaw: 0,
      pitch: 0,
      health: 100,
      maxHealth: 100,
      shield: 50,
      maxShield: 100,
      eliminations: 0,
      damageDealt: 0,
      shotsFired: 0,
      shotsHit: 0,
      structuresBuilt: 0,
      activeSlot: 1,
      selectedMaterial: 'wood',
      inventory,
      materials: loadoutInfo.materials,
      ammo: { none: 0, light: 72, medium: 90, shells: 24, heavy: 15 },
      isAiming: false,
      isSprinting: false,
      isGrounded: !config.skyDrop,
      isGliding: config.skyDrop,
      isReloading: false,
      reloadTimer: 0,
      reloadDuration: 0,
      isHealing: false,
      landingImpactTimer: 0,
      skinColor: config.cosmetics?.skinColor ?? 0x0284c7,
      accentColor: config.cosmetics?.accentColor ?? 0x38bdf8,
      backAccessory: config.cosmetics?.backAccessory ?? 'jump_pack',
    };

    this.state.players.set(this.localPlayerId, localPlayer);

    if (this.isOnlineRoom) {
      this.connectToMultiplayerRoom(config, localPlayer, true);
    } else {
      this.disconnectMultiplayerRoom();
      this.connectionState = 'idle';
      this.connectedHumanCount = 1;
      this.onConnectionStatusChange?.(
        'LOCAL AUTHORITATIVE ENGINE',
        true,
        'idle',
        1
      );
    }

    return localPlayer;
  }

  private getStarterLoadoutItems(loadout: StarterLoadoutType): {
    primaryCat: WeaponCategory;
    primaryRarity: 'common' | 'uncommon' | 'rare';
    secondaryCat: WeaponCategory;
    secondaryRarity: 'common' | 'uncommon' | 'rare';
    materials: { wood: number; stone: number; metal: number };
  } {
    switch (loadout) {
      case 'close_quarters':
        return {
          primaryCat: 'shotgun',
          primaryRarity: 'uncommon',
          secondaryCat: 'smg',
          secondaryRarity: 'common',
          materials: { wood: 120, stone: 60, metal: 30 },
        };
      case 'sharpshooter':
        return {
          primaryCat: 'sniper',
          primaryRarity: 'rare',
          secondaryCat: 'pistol',
          secondaryRarity: 'uncommon',
          materials: { wood: 80, stone: 60, metal: 30 },
        };
      case 'demolition':
        return {
          primaryCat: 'smg',
          primaryRarity: 'uncommon',
          secondaryCat: 'pistol',
          secondaryRarity: 'rare',
          materials: { wood: 200, stone: 150, metal: 100 },
        };
      case 'balanced':
      default:
        return {
          primaryCat: 'assault_rifle',
          primaryRarity: 'uncommon',
          secondaryCat: 'pistol',
          secondaryRarity: 'common',
          materials: { wood: 100, stone: 50, metal: 25 },
        };
    }
  }

  public connectToMultiplayerRoom(
    config: LobbyConfig,
    localPlayer: PlayerState,
    resetPlayer: boolean = false
  ): void {
    this.disconnectMultiplayerRoom();

    const wsUrl = this.resolveWebSocketUrl();

    this.connectionState = 'connecting';
    this.onConnectionStatusChange?.(
      `⏳ CONNECTING TO ROOM ${this.roomCode}...`,
      false,
      'connecting',
      this.connectedHumanCount
    );

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.roomConnected = true;
        this.connectionState = 'connected';
        this.onConnectionStatusChange?.(
          `🟢 ROOM ${this.roomCode} • LIVE`,
          true,
          'connected',
          this.connectedHumanCount
        );
        this.sendPacket({
          type: 'join_room',
          roomCode: this.roomCode,
          sessionToken: this.sessionToken,
          accountId: this.accountId || undefined,
          accountToken: this.accountToken || undefined,
          playerName: localPlayer.name,
          starterLoadout: config.starterLoadout,
          position: localPlayer.position,
          isGliding: localPlayer.isGliding,
          outfitId: config.cosmetics?.outfitId,
          skinColor: localPlayer.skinColor,
          accentColor: localPlayer.accentColor,
          backAccessory: localPlayer.backAccessory || 'jump_pack',
          resetPlayer,
        });
      };

      this.ws.onmessage = (event) => {
        try {
          const rawStr = typeof event.data === 'string' ? event.data : '';
          this.packetsReceived++;
          this.bytesReceived += rawStr.length;
          const msg = JSON.parse(rawStr);
          if (msg.type === 'room_state') {
            this.lastRoomStateBytes = rawStr.length;
            const nowMs = performance.now();
            if (this.lastRoomStatePerfMs > 0) {
              const dtMs = nowMs - this.lastRoomStatePerfMs;
              this.avgBroadcastIntervalMs =
                this.avgBroadcastIntervalMs * 0.85 + dtMs * 0.15;
            }
            this.lastRoomStatePerfMs = nowMs;
          }
          this.handleServerMessage(msg);
        } catch {
          // Ignore malformed packet
        }
      };

      this.ws.onclose = () => {
        this.roomConnected = false;
        if (this.isOnlineRoom && this.state.phase === 'ACTIVE') {
          this.connectionState = 'reconnecting';
          this.onConnectionStatusChange?.(
            `🔄 ROOM ${this.roomCode} • RECONNECTING...`,
            false,
            'reconnecting',
            this.connectedHumanCount
          );
          this.reconnectTimer = window.setTimeout(() => {
            const p = this.state.players.get(this.localPlayerId);
            if (p && this.isOnlineRoom) {
              this.connectToMultiplayerRoom(config, p, false);
            }
          }, 3500);
        }
      };

      this.ws.onerror = () => {
        this.roomConnected = false;
        this.connectionState = 'error';
        this.onConnectionStatusChange?.(
          `⚠️ ROOM ${this.roomCode} • CONNECTION ERROR`,
          false,
          'error',
          0
        );
      };
    } catch {
      this.roomConnected = false;
      this.connectionState = 'error';
      this.onConnectionStatusChange?.(
        `⚠️ ROOM ${this.roomCode} • LOCAL FALLBACK`,
        false,
        'error',
        1
      );
    }
  }

  public disconnectMultiplayerRoom(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.roomConnected = false;
  }

  private handleServerMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'room_state': {
        // 1. Synchronize Authoritative Storm & Match Timer from Room Server
        if (msg.storm && typeof msg.storm === 'object') {
          const s = msg.storm as StormState;
          this.state.storm.phase = Number(s.phase ?? this.state.storm.phase);
          this.state.storm.currentCenterX = Number(s.currentCenterX ?? 0);
          this.state.storm.currentCenterZ = Number(s.currentCenterZ ?? 0);
          this.state.storm.currentRadius = Number(s.currentRadius ?? 255);
          this.state.storm.targetCenterX = Number(s.targetCenterX ?? 0);
          this.state.storm.targetCenterZ = Number(s.targetCenterZ ?? 0);
          this.state.storm.targetRadius = Number(s.targetRadius ?? 145);
          this.state.storm.phaseTimer = Number(s.phaseTimer ?? 40);
          this.state.storm.isShrinking = Boolean(s.isShrinking);
          this.state.storm.damagePerSecond = Number(s.damagePerSecond ?? 2);
        }
        if (typeof msg.matchTimer === 'number') {
          this.state.matchTimer = msg.matchTimer;
        }

        const players = msg.players as Array<Record<string, unknown>>;
        if (!Array.isArray(players)) break;
        this.connectedHumanCount = players.filter((p) => p.isConnected).length;
        this.connectionState = 'connected';
        this.onConnectionStatusChange?.(
          `🟢 ROOM ${this.roomCode} • ${this.connectedHumanCount} ONLINE`,
          true,
          'connected',
          this.connectedHumanCount
        );

        for (const rp of players) {
          const id = String(rp.id);
          if (id === this.localPlayerId || rp.sessionToken === this.sessionToken) {
            continue;
          }

          const eqCat = (rp.equippedCategory as WeaponCategory) || 'assault_rifle';
          const eqRar = (rp.equippedRarity as WeaponRarity) || 'uncommon';

          let existing = this.state.players.get(id);
          if (!existing) {
            const harvesterStats = createWeaponStats('harvester', 'rare');
            const eqStats = createWeaponStats(eqCat, eqRar);
            const incomingPos = (rp.position as { x: number; y: number; z: number }) || {
              x: 0,
              y: 6,
              z: 0,
            };
            const incomingVel = (rp.velocity as { x: number; y: number; z: number }) || {
              x: 0,
              y: 0,
              z: 0,
            };
            existing = {
              id,
              name: String(rp.name || 'Remote_Player'),
              isBot: false,
              isConnected: Boolean(rp.isConnected ?? true),
              alive: Boolean(rp.alive ?? true),
              position: {
                x: Number(incomingPos.x) || 0,
                y: Number(incomingPos.y) || 6,
                z: Number(incomingPos.z) || 0,
              },
              velocity: {
                x: Number(incomingVel.x) || 0,
                y: Number(incomingVel.y) || 0,
                z: Number(incomingVel.z) || 0,
              },
              yaw: Number(rp.yaw || 0),
              facingYaw: Number(rp.facingYaw || 0),
              pitch: Number(rp.pitch || 0),
              health: Number(rp.health ?? 100),
              maxHealth: 100,
              shield: Number(rp.shield ?? 50),
              maxShield: 100,
              eliminations: Number(rp.eliminations ?? 0),
              damageDealt: 0,
              shotsFired: 0,
              shotsHit: 0,
              structuresBuilt: 0,
              activeSlot: 1,
              selectedMaterial: 'wood',
              inventory: [
                {
                  weaponId: harvesterStats.id,
                  name: harvesterStats.name,
                  category: 'harvester',
                  rarity: 'rare',
                  clipAmmo: 999,
                  maxClipAmmo: 999,
                  ammoType: 'none',
                  isConsumable: false,
                  count: 1,
                },
                {
                  weaponId: eqStats.id,
                  name: eqStats.name,
                  category: eqCat,
                  rarity: eqRar,
                  clipAmmo: eqStats.clipSize,
                  maxClipAmmo: eqStats.clipSize,
                  ammoType: eqStats.ammoType,
                  isConsumable: eqStats.isConsumable,
                  count: 1,
                },
                null,
                null,
                null,
              ],
              materials: { wood: 100, stone: 50, metal: 25 },
              ammo: { none: 0, light: 60, medium: 90, shells: 20, heavy: 10 },
              isAiming: Boolean(rp.isAiming),
              isSprinting: Boolean(rp.isSprinting),
              isGrounded: Boolean(rp.isGrounded ?? true),
              isGliding: Boolean(rp.isGliding),
              isReloading: Boolean(rp.isReloading),
              reloadTimer: 0,
              reloadDuration: 0,
              isHealing: false,
              landingImpactTimer: 0,
              skinColor: Number(rp.skinColor ?? 0x22c55e),
              accentColor: Number(rp.accentColor ?? 0xfef08a),
              backAccessory:
                (rp.backAccessory as BackAccessoryType) || 'jump_pack',
            };
            this.state.players.set(id, existing);
            this.remoteTargets.set(id, {
              targetX: existing.position.x,
              targetY: existing.position.y,
              targetZ: existing.position.z,
              velX: existing.velocity.x,
              velY: existing.velocity.y,
              velZ: existing.velocity.z,
              targetYaw: existing.yaw,
              targetFacingYaw: existing.facingYaw,
              targetPitch: existing.pitch,
              lastPacketPerfMs: performance.now(),
            });
          } else {
            if (rp.skinColor !== undefined) {
              existing.skinColor = Number(rp.skinColor);
            }
            if (rp.accentColor !== undefined) {
              existing.accentColor = Number(rp.accentColor);
            }
            if (rp.backAccessory) {
              existing.backAccessory = rp.backAccessory as BackAccessoryType;
            }
            const incomingPos =
              (rp.position as { x: number; y: number; z: number }) || existing.position;
            const incomingVel =
              (rp.velocity as { x: number; y: number; z: number }) || existing.velocity;
            const nextX = Number(incomingPos.x ?? existing.position.x);
            const nextY = Number(incomingPos.y ?? existing.position.y);
            const nextZ = Number(incomingPos.z ?? existing.position.z);
            const nextVelX = Number(incomingVel.x ?? existing.velocity.x);
            const nextVelY = Number(incomingVel.y ?? existing.velocity.y);
            const nextVelZ = Number(incomingVel.z ?? existing.velocity.z);
            const nextYaw = Number(rp.yaw ?? existing.yaw);
            const nextFacingYaw = Number(rp.facingYaw ?? existing.facingYaw);
            const nextPitch = Number(rp.pitch ?? existing.pitch);

            existing.velocity.x = nextVelX;
            existing.velocity.y = nextVelY;
            existing.velocity.z = nextVelZ;

            let target = this.remoteTargets.get(id);
            if (!target) {
              target = {
                targetX: nextX,
                targetY: nextY,
                targetZ: nextZ,
                velX: nextVelX,
                velY: nextVelY,
                velZ: nextVelZ,
                targetYaw: nextYaw,
                targetFacingYaw: nextFacingYaw,
                targetPitch: nextPitch,
                lastPacketPerfMs: performance.now(),
              };
              this.remoteTargets.set(id, target);
            } else {
              target.targetX = nextX;
              target.targetY = nextY;
              target.targetZ = nextZ;
              target.velX = nextVelX;
              target.velY = nextVelY;
              target.velZ = nextVelZ;
              target.targetYaw = nextYaw;
              target.targetFacingYaw = nextFacingYaw;
              target.targetPitch = nextPitch;
              target.lastPacketPerfMs = performance.now();
            }

            const dx = nextX - existing.position.x;
            const dy = nextY - existing.position.y;
            const dz = nextZ - existing.position.z;
            const distSq = dx * dx + dy * dy + dz * dz;

            // Snap immediately on teleport/respawn (>12m) or when render-loop interpolation is not active
            if (!this.hasRenderLoopDrivenInterpolation || distSq > 144) {
              existing.position.x = nextX;
              existing.position.y = nextY;
              existing.position.z = nextZ;
              existing.yaw = nextYaw;
              existing.facingYaw = nextFacingYaw;
              existing.pitch = nextPitch;
            }

            existing.health = Number(rp.health ?? existing.health);
            existing.shield = Number(rp.shield ?? existing.shield);
            existing.eliminations = Number(rp.eliminations ?? existing.eliminations);
            existing.alive = Boolean(rp.alive ?? existing.alive);
            existing.isConnected = Boolean(rp.isConnected ?? true);
            existing.isAiming = Boolean(rp.isAiming);
            existing.isSprinting = Boolean(rp.isSprinting);
            const wasGrounded = existing.isGrounded;
            existing.isGrounded = Boolean(rp.isGrounded ?? true);
            if (!wasGrounded && existing.isGrounded) {
              existing.landingImpactTimer = 0.18;
            }
            existing.isGliding = Boolean(rp.isGliding);
            existing.isReloading = Boolean(rp.isReloading);
            existing.reloadTimer = Number(rp.reloadTimer ?? existing.reloadTimer);
            existing.reloadDuration = Number(
              rp.reloadDuration ?? existing.reloadDuration
            );

            // Sync remote player's visibly equipped weapon
            const slot1 = existing.inventory[1];
            if (!slot1 || slot1.category !== eqCat || slot1.rarity !== eqRar) {
              const eqStats = createWeaponStats(eqCat, eqRar);
              existing.inventory[1] = {
                weaponId: eqStats.id,
                name: eqStats.name,
                category: eqCat,
                rarity: eqRar,
                clipAmmo: eqStats.clipSize,
                maxClipAmmo: eqStats.clipSize,
                ammoType: eqStats.ammoType,
                isConsumable: eqStats.isConsumable,
                count: 1,
              };
            }
          }
        }
        break;
      }

      case 'remote_weapon_fired': {
        this.onRemoteWeaponFired?.(
          String(msg.shooterId),
          (msg.category as WeaponCategory) || 'assault_rifle',
          (msg.muzzlePos as { x: number; y: number; z: number }) || { x: 0, y: 1, z: 0 },
          (msg.hitPoint as { x: number; y: number; z: number }) || { x: 0, y: 1, z: -10 }
        );
        break;
      }

      case 'build_placed': {
        if (msg.sessionToken === this.sessionToken) break;
        this.onRemoteBuildPlaced?.(
          String(msg.buildId || `build_${Date.now()}`),
          String(msg.ownerId),
          msg.pieceType as BuildPieceType,
          Number(msg.x),
          Number(msg.y),
          Number(msg.z),
          Number(msg.yaw),
          msg.material as BuildMaterialType
        );
        break;
      }

      case 'build_damaged': {
        this.onRemoteBuildDamaged?.(
          String(msg.destructibleId),
          Number(msg.damage || 25)
        );
        break;
      }

      case 'server_hit': {
        this.onServerHitEvent?.(msg as unknown as ServerHitEvent);
        break;
      }

      case 'loot_collected': {
        if (msg.sessionToken === this.sessionToken) break;
        this.onRemoteLootCollected?.(
          String(msg.collectorId || ''),
          String(msg.lootId || ''),
          String(msg.itemType || 'weapon'),
          Array.isArray(msg.spawnedDrops)
            ? (msg.spawnedDrops as LootItemState[])
            : undefined,
          msg.swappedDrop ? (msg.swappedDrop as LootItemState) : undefined
        );
        break;
      }

      case 'room_loot_sync': {
        this.onRoomLootSync?.(
          Array.isArray(msg.collectedIds) ? (msg.collectedIds as string[]) : [],
          Array.isArray(msg.spawnedItems)
            ? (msg.spawnedItems as LootItemState[])
            : []
        );
        break;
      }

      case 'loot_collect_rejected': {
        this.onLootCollectRejected?.(
          String(msg.lootId || ''),
          String(msg.reason || 'Already collected')
        );
        break;
      }

      case 'server_progression': {
        if (msg.profile && typeof msg.profile === 'object') {
          this.onServerProgressionUpdate?.(
            msg.profile as Partial<PlayerProgressionState>
          );
        }
        break;
      }

      case 'server_restarting': {
        this.roomConnected = false;
        this.connectionState = 'reconnecting';
        this.onConnectionStatusChange?.(
          `🔄 SERVER RESTARTING • RECONNECTING TO ${this.roomCode}...`,
          false,
          'reconnecting',
          this.connectedHumanCount
        );
        break;
      }
    }
  }

  /**
   * Smooths remote player movement at 60Hz+ render rates using bounded velocity dead-reckoning
   * (capped to 60ms lookahead) and exponential smoothing, eliminating 20Hz packet stepping
   * without adding input lag to the local player.
   */
  public updateRemotePlayers(dt: number): void {
    this.hasRenderLoopDrivenInterpolation = true;
    if (!this.isOnlineRoom || this.remoteTargets.size === 0) return;

    const nowMs = performance.now();
    const posBlend = Math.min(1, 1 - Math.exp(-18 * dt));
    const rotBlend = Math.min(1, 1 - Math.exp(-22 * dt));

    for (const [id, target] of this.remoteTargets) {
      const player = this.state.players.get(id);
      if (!player || !player.alive) continue;

      // Bounded velocity extrapolation (up to 60ms after last authoritative snapshot)
      const ageSec = Math.min(0.06, Math.max(0, (nowMs - target.lastPacketPerfMs) * 0.001));
      const goalX = target.targetX + target.velX * ageSec;
      const goalY = target.targetY + target.velY * ageSec;
      const goalZ = target.targetZ + target.velZ * ageSec;

      const dx = goalX - player.position.x;
      const dy = goalY - player.position.y;
      const dz = goalZ - player.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq > 144) {
        player.position.x = goalX;
        player.position.y = goalY;
        player.position.z = goalZ;
      } else {
        player.position.x += dx * posBlend;
        player.position.y += dy * posBlend;
        player.position.z += dz * posBlend;
      }

      player.yaw = lerpShortestAngle(player.yaw, target.targetYaw, rotBlend);
      player.facingYaw = lerpShortestAngle(
        player.facingYaw,
        target.targetFacingYaw,
        rotBlend
      );
      player.pitch += (target.targetPitch - player.pitch) * rotBlend;
    }
  }

  public getNetworkMetrics(): NetworkTelemetryMetrics {
    return {
      packetsReceived: this.packetsReceived,
      bytesReceived: this.bytesReceived,
      lastRoomStateBytes: this.lastRoomStateBytes,
      avgBroadcastIntervalMs: Math.round(this.avgBroadcastIntervalMs * 100) / 100,
      remoteInterpolatedPlayers: this.remoteTargets.size,
    };
  }

  public sendInput(input: PlayerInputPacket): void {
    if (!this.isOnlineRoom || !this.roomConnected || !this.ws) return;
    const now = performance.now();
    const elapsed = now - this.lastSyncSentTime;
    if (elapsed < 45) return;

    const p = this.state.players.get(this.localPlayerId);
    if (!p) return;

    const activeSlotItem = p.inventory[p.activeSlot];
    const eqCat = activeSlotItem ? activeSlotItem.category : 'harvester';
    const eqRar = activeSlotItem ? activeSlotItem.rarity : 'rare';

    const px = q2(p.position.x);
    const py = q2(p.position.y);
    const pz = q2(p.position.z);
    const vx = q2(p.velocity.x);
    const vy = q2(p.velocity.y);
    const vz = q2(p.velocity.z);
    const yaw = q3(p.yaw);
    const facingYaw = q3(p.facingYaw);
    const pitch = q3(p.pitch);
    const stateSig = `${p.isAiming ? 1 : 0}|${p.isSprinting ? 1 : 0}|${p.isGrounded ? 1 : 0}|${p.isGliding ? 1 : 0}|${p.isReloading ? 1 : 0}|${eqCat}|${eqRar}`;

    const posDelta =
      Math.abs(px - this.lastSentPosX) +
      Math.abs(py - this.lastSentPosY) +
      Math.abs(pz - this.lastSentPosZ);
    const rotDelta =
      Math.abs(yaw - this.lastSentYaw) + Math.abs(pitch - this.lastSentPitch);

    // Delta-throttle completely stationary idle ticks to 150ms heartbeat while keeping 20Hz during movement/rotation
    if (
      elapsed < 150 &&
      posDelta < 0.005 &&
      rotDelta < 0.003 &&
      stateSig === this.lastSentStateSignature &&
      Math.abs(vx) + Math.abs(vy) + Math.abs(vz) < 0.01
    ) {
      return;
    }

    this.lastSyncSentTime = now;
    this.lastSentPosX = px;
    this.lastSentPosY = py;
    this.lastSentPosZ = pz;
    this.lastSentYaw = yaw;
    this.lastSentPitch = pitch;
    this.lastSentStateSignature = stateSig;

    this.sendPacket({
      type: 'player_sync',
      sessionToken: this.sessionToken,
      seq: input.seq,
      position: { x: px, y: py, z: pz },
      velocity: { x: vx, y: vy, z: vz },
      yaw,
      facingYaw,
      pitch,
      isAiming: p.isAiming,
      isSprinting: p.isSprinting,
      isGrounded: p.isGrounded,
      isGliding: p.isGliding,
      isReloading: p.isReloading,
      reloadTimer: q2(p.reloadTimer),
      reloadDuration: q2(p.reloadDuration),
      equippedCategory: eqCat,
      equippedRarity: eqRar,
    });
  }

  public sendWeaponFired(
    category: string,
    muzzlePos: { x: number; y: number; z: number },
    hitPoint: { x: number; y: number; z: number }
  ): void {
    if (!this.isOnlineRoom || !this.roomConnected) return;
    this.sendPacket({
      type: 'fire_weapon',
      sessionToken: this.sessionToken,
      category,
      muzzlePos,
      hitPoint,
    });
  }

  public sendCombatHit(
    targetId: string,
    damage: number,
    isHeadshot: boolean,
    weaponName: string,
    hitPoint: { x: number; y: number; z: number }
  ): void {
    if (!this.isOnlineRoom || !this.roomConnected) return;
    this.sendPacket({
      type: 'combat_hit',
      hitId: `hit_${++this.hitCounter}`,
      sessionToken: this.sessionToken,
      targetId,
      damage,
      isHeadshot,
      weaponName,
      hitPoint,
    });
  }

  public sendBuildPlaced(
    buildId: string,
    pieceType: BuildPieceType,
    x: number,
    y: number,
    z: number,
    yaw: number,
    material: BuildMaterialType
  ): void {
    if (!this.isOnlineRoom || !this.roomConnected) return;
    this.sendPacket({
      type: 'place_build',
      sessionToken: this.sessionToken,
      buildId,
      pieceType,
      x,
      y,
      z,
      yaw,
      material,
    });
  }

  public sendBuildDamaged(destructibleId: string, damage: number): void {
    if (!this.isOnlineRoom || !this.roomConnected) return;
    this.sendPacket({
      type: 'damage_build',
      sessionToken: this.sessionToken,
      destructibleId,
      damage,
    });
  }

  public sendHealSync(health: number, shield: number): void {
    if (!this.isOnlineRoom || !this.roomConnected) return;
    this.sendPacket({
      type: 'heal_sync',
      sessionToken: this.sessionToken,
      health,
      shield,
    });
  }

  public sendLootCollected(
    lootId: string,
    itemType: string,
    position?: { x: number; y: number; z: number },
    spawnedDrops?: LootItemState[],
    swappedDrop?: LootItemState
  ): void {
    if (!this.isOnlineRoom || !this.roomConnected) return;
    this.sendPacket({
      type: 'collect_loot',
      sessionToken: this.sessionToken,
      lootId,
      itemType,
      position,
      spawnedDrops,
      swappedDrop,
    });
  }

  private sendPacket(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}
