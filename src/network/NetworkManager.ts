import {
  BackAccessoryType,
  BuildMaterialType,
  BuildPieceType,
  InventorySlot,
  BotDifficulty,
  CreateLobbyRequest,
  LobbyConfig,
  LobbyStartCondition,
  LobbySummary,
  LootItemState,
  MatchState,
  MultiplayerRoomMode,
  PlayerInputPacket,
  PlayerProgressionState,
  PlayerState,
  RoomPhase,
  RoomPlayerSummary,
  RoomSnapshot,
  SessionMode,
  StarterLoadoutType,
  StormState,
  TeamMode,
  WeaponCategory,
  WeaponRarity,
  isHumanOnlySessionMode,
  roomModeForSessionMode,
} from './schemas';
import { createWeaponStats } from '../weapons/WeaponDefinitions';

export interface ServerHitEvent {
  eventId?: string;
  attackerId: string;
  attackerName: string;
  victimId: string;
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

function normalizeRoomModeValue(
  raw: unknown,
  fallbackCode: string
): MultiplayerRoomMode {
  if (
    raw === 'online_ai_fill' ||
    raw === 'human_only_public' ||
    raw === 'human_only_private'
  ) {
    return raw;
  }
  if (raw === 'online') return 'online_ai_fill';
  if (fallbackCode.startsWith('HPLAY-')) return 'human_only_public';
  if (fallbackCode.startsWith('HUM-')) return 'human_only_private';
  return 'online_ai_fill';
}

function normalizeTeamMode(raw: unknown): TeamMode {
  return raw === 'duo' || raw === 'squad' ? raw : 'solo';
}

function normalizeStartCondition(raw: unknown): LobbyStartCondition {
  return raw === 'host_start' || raw === 'fill_lobby' ? raw : 'all_ready';
}

function normalizeBotDifficulty(raw: unknown): BotDifficulty {
  return raw === 'easy' || raw === 'hard' ? raw : 'medium';
}

export function normalizeLobbySummary(
  data: Record<string, unknown>
): LobbySummary {
  const snapshot = normalizeRoomSnapshot(data, String(data.roomCode || 'CICRAFT-1'));
  const currentPlayers = Number(data.currentPlayers ?? snapshot.connectedHumans);
  return {
    id: snapshot.roomCode,
    roomId: snapshot.roomCode,
    roomCode: snapshot.roomCode,
    name: snapshot.name,
    lobbyName: snapshot.lobbyName,
    hostName: snapshot.hostName,
    hostPlayerId: snapshot.hostPlayerId,
    mode: snapshot.mode,
    roomMode: snapshot.roomMode,
    visibility: snapshot.visibility,
    isPrivate: snapshot.isPrivate,
    hasPassword: snapshot.hasPassword,
    phase: snapshot.phase,
    status: snapshot.status,
    matchStatus: snapshot.matchStatus,
    humanOnly: snapshot.humanOnly,
    aiFillEnabled: snapshot.aiFillEnabled,
    botCount: snapshot.botCount,
    botDifficulty: snapshot.botDifficulty,
    currentPlayers,
    humanCount: currentPlayers,
    connectedHumans: snapshot.connectedHumans,
    readyHumans: snapshot.readyHumans,
    maxPlayers: snapshot.maxPlayers,
    availableSlots: snapshot.availableSlots,
    minPlayers: snapshot.minPlayers,
    mapId: snapshot.mapId,
    mapName: snapshot.mapName,
    teamMode: snapshot.teamMode,
    gameMode: snapshot.gameMode,
    startCondition: snapshot.startCondition,
    allowLateJoin: snapshot.allowLateJoin,
    canJoin: Boolean(data.canJoin ?? snapshot.phase === 'lobby'),
    joinBlockReason: String(data.joinBlockReason || ''),
    createdAt: snapshot.createdAt,
    matchStartedAt: Number(data.matchStartedAt || 0),
    pingMs: typeof data.pingMs === 'number' ? data.pingMs : null,
  };
}

function normalizeRoomSnapshot(
  data: Record<string, unknown>,
  fallbackCode: string,
  previousPlayers: RoomPlayerSummary[] = []
): RoomSnapshot {
  const roomCode = String(data.roomCode || fallbackCode || 'CICRAFT-1');
  const mode = normalizeRoomModeValue(data.roomMode ?? data.mode, roomCode);
  const isHumanOnly =
    mode === 'human_only_public' || mode === 'human_only_private';
  const rawPhase = String(data.phase || data.matchStatus || '');
  const phase: RoomPhase =
    rawPhase === 'lobby' ||
    rawPhase === 'countdown' ||
    rawPhase === 'active' ||
    rawPhase === 'ended'
      ? rawPhase
      : isHumanOnly
        ? 'lobby'
        : 'active';

  const players = Array.isArray(data.players)
    ? (data.players as Array<Record<string, unknown>>)
        .filter((player) => player.isBot !== true)
        .map(
          (player): RoomPlayerSummary => ({
            id: String(player.id || ''),
            name: String(player.name || 'Commander_CI'),
            participantType: 'human',
            isBot: false,
            isAuthenticated: Boolean(player.isAuthenticated),
            isReady: Boolean(player.isReady),
            isParticipant: Boolean(player.isParticipant),
            isConnected: Boolean(player.isConnected),
            isHost: Boolean(player.isHost),
            teamId: String(player.teamId || ''),
            teamIndex: Number(player.teamIndex ?? -1),
            alive: Boolean(player.alive ?? true),
          })
        )
    : previousPlayers;

  const connectedHumans = Number(
    data.connectedHumans ?? data.connectedPlayers ??
      players.filter((player) => player.isConnected).length
  );
  const readyHumans = Number(
    data.readyHumans ?? data.readyPlayers ??
      players.filter((player) => player.isConnected && player.isReady).length
  );

  const visibility: RoomSnapshot['visibility'] =
    data.visibility === 'public' || data.visibility === 'private'
      ? data.visibility
      : mode === 'human_only_public'
        ? 'public'
        : mode === 'human_only_private'
          ? 'private'
          : 'room_code';
  const maxPlayers = Math.max(1, Number(data.maxPlayers || 20));
  const selfPlayerId = data.selfPlayerId ? String(data.selfPlayerId) : undefined;
  const hostPlayerId = data.hostPlayerId ? String(data.hostPlayerId) : null;
  const rawStatus = String(data.status || '');
  const status: RoomSnapshot['status'] =
    rawStatus === 'waiting' ||
    rawStatus === 'starting' ||
    rawStatus === 'in_game' ||
    rawStatus === 'full' ||
    rawStatus === 'ended' ||
    rawStatus === 'closed'
      ? rawStatus
      : phase === 'countdown'
        ? 'starting'
        : phase === 'active'
          ? 'in_game'
          : phase === 'ended'
            ? 'ended'
            : connectedHumans >= maxPlayers
              ? 'full'
              : 'waiting';

  return {
    id: roomCode,
    roomId: roomCode,
    roomCode,
    name: String(data.name || data.lobbyName || `${roomCode} Lobby`),
    lobbyName: String(data.lobbyName || data.name || `${roomCode} Lobby`),
    hostName: String(data.hostName || 'Open Room'),
    hostPlayerId,
    isSelfHost: Boolean(selfPlayerId && hostPlayerId === selfPlayerId),
    mode,
    roomMode: mode,
    visibility,
    isPrivate: visibility === 'private',
    hasPassword: Boolean(data.hasPassword),
    isListed: Boolean(data.isListed),
    isLobbyManaged: Boolean(data.isLobbyManaged ?? isHumanOnly),
    phase,
    status,
    matchStatus: phase,
    humanOnly: Boolean(data.humanOnly ?? isHumanOnly),
    aiFillEnabled: Boolean(data.aiFillEnabled ?? mode === 'online_ai_fill'),
    botCount: isHumanOnly ? 0 : Math.max(0, Number(data.botCount || 0)),
    botDifficulty: normalizeBotDifficulty(data.botDifficulty),
    connectedPlayers: connectedHumans,
    connectedHumans,
    authenticatedHumans: Number(
      data.authenticatedHumans ??
        players.filter((player) => player.isConnected && player.isAuthenticated)
          .length
    ),
    readyPlayers: readyHumans,
    readyHumans,
    totalPlayers: Number(data.totalPlayers ?? players.length),
    totalHumans: Number(data.totalHumans ?? data.totalPlayers ?? players.length),
    aliveHumans: Number(
      data.aliveHumans ?? players.filter((player) => player.alive).length
    ),
    maxPlayers,
    availableSlots: Math.max(
      0,
      Number(data.availableSlots ?? maxPlayers - connectedHumans)
    ),
    minPlayers: Math.max(1, Number(data.minPlayers || (isHumanOnly ? 2 : 1))),
    mapId: 'ci_island',
    mapName: String(data.mapName || 'CI Island'),
    teamMode: normalizeTeamMode(data.teamMode ?? data.gameMode),
    gameMode: normalizeTeamMode(data.teamMode ?? data.gameMode),
    startCondition: normalizeStartCondition(data.startCondition),
    allowLateJoin: Boolean(data.allowLateJoin),
    createdAt: Number(data.createdAt || 0),
    matchParticipantCount: Number(data.matchParticipantCount || 0),
    countdownEndsAt: Number(data.countdownEndsAt || 0),
    canStart: Boolean(data.canStart),
    canHostStart: Boolean(data.canHostStart ?? data.canStart),
    winnerId: data.winnerId ? String(data.winnerId) : null,
    winnerIds: Array.isArray(data.winnerIds)
      ? data.winnerIds.map((winnerId) => String(winnerId))
      : data.winnerId
        ? [String(data.winnerId)]
        : [],
    winnerTeamId: String(data.winnerTeamId || ''),
    winnerName: String(data.winnerName || ''),
    stormPhase: Number(data.stormPhase || 1),
    selfPlayerId,
    players,
  };
}

export class NetworkManager {
  public localPlayerId: string = 'player_local_1';
  public state: MatchState;
  public isOnlineRoom: boolean = false;
  public roomConnected: boolean = false;
  public connectionState: NetworkConnectionState = 'idle';
  public roomCode: string = 'CICRAFT-1';
  public roomMode: MultiplayerRoomMode = 'online_ai_fill';
  public roomSnapshot: RoomSnapshot | null = null;
  public serverPlayerId: string = '';
  public lastJoinRejection: { code: string; reason: string } | null = null;
  public connectedHumanCount: number = 1;
  private ws: WebSocket | null = null;
  private activeRoomConfig: LobbyConfig | null = null;
  private activeLocalPlayer: PlayerState | null = null;
  private pendingCreateLobby: CreateLobbyRequest | null = null;
  private pendingConnectionPurpose: 'match' | 'lobby' = 'match';
  private pendingResetPlayer: boolean = false;
  private wantsRoomConnection: boolean = false;
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
  public onAuthoritativeLootCollected?: (
    item: LootItemState,
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
  public onRoomSnapshot?: (snapshot: RoomSnapshot | null) => void;
  public onMatchStarted?: (snapshot: RoomSnapshot) => void;
  public onMatchEnded?: (
    snapshot: RoomSnapshot,
    placements: Record<string, number>
  ) => void;
  public onJoinRejected?: (code: string, reason: string) => void;
  public onRoomActionRejected?: (reason: string) => void;
  public onLobbyCreated?: (snapshot: RoomSnapshot) => void;
  public onLobbyCreateRejected?: (code: string, reason: string) => void;
  public onRoomClosed?: (snapshot: RoomSnapshot, reason: string) => void;
  public onHostChanged?: (snapshot: RoomSnapshot) => void;

  public get isHumanOnlyRoom(): boolean {
    return (
      this.roomMode === 'human_only_public' ||
      this.roomMode === 'human_only_private'
    );
  }

  public get isLobbyManagedRoom(): boolean {
    return Boolean(
      this.roomSnapshot?.isLobbyManaged ||
        this.isHumanOnlyRoom ||
        this.activeRoomConfig?.createLobby
    );
  }

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

  public async fetchRoomStatus(
    code: string
  ): Promise<RoomSnapshot & { ok: boolean; exists: boolean }> {
    const cleanCode = (code || 'CICRAFT-1').trim().toUpperCase();
    const fallback = normalizeRoomSnapshot({}, cleanCode);
    if (typeof fetch !== 'function') {
      return { ...fallback, ok: false, exists: false };
    }
    try {
      const res = await fetch(
        `${this.resolveHttpBaseUrl()}/api/room?code=${encodeURIComponent(cleanCode)}`
      );
      if (!res.ok) throw new Error('Status check failed');
      const data = (await res.json()) as Record<string, unknown>;
      return {
        ...normalizeRoomSnapshot(data, cleanCode),
        ok: true,
        exists: Boolean(data.exists),
      };
    } catch {
      return { ...fallback, ok: false, exists: false };
    }
  }

  public async fetchLobbyList(): Promise<{
    ok: boolean;
    lobbies: LobbySummary[];
    serverTime: number;
  }> {
    if (typeof fetch !== 'function') return { ok: false, lobbies: [], serverTime: 0 };
    try {
      const res = await fetch(`${this.resolveHttpBaseUrl()}/api/lobbies`);
      if (!res.ok) throw new Error('Lobby list failed');
      const data = (await res.json()) as Record<string, unknown>;
      const rawLobbies = Array.isArray(data.lobbies) ? data.lobbies : [];
      return {
        ok: Boolean(data.ok),
        lobbies: rawLobbies.map((lobby) =>
          normalizeLobbySummary(lobby as Record<string, unknown>)
        ),
        serverTime: Number(data.serverTime || 0),
      };
    } catch {
      return { ok: false, lobbies: [], serverTime: 0 };
    }
  }

  public async createPrivateRoom(
    sessionMode: SessionMode = 'online'
  ): Promise<string> {
    const roomMode = roomModeForSessionMode(sessionMode);
    if (typeof fetch === 'function') {
      try {
        const res = await fetch(`${this.resolveHttpBaseUrl()}/api/room/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomMode }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.roomCode) return String(data.roomCode);
        }
      } catch {
        // Fall through to mode-prefixed client code generation. The server
        // still validates/infer the mode from the reserved prefix on join.
      }
    }
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let suffix = '';
    for (let i = 0; i < 4; i++) {
      suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    const prefix =
      roomMode === 'human_only_public'
        ? 'HPLAY'
        : roomMode === 'human_only_private'
          ? 'HUM'
          : 'CI';
    return `${prefix}-${suffix}`;
  }

  public async matchmakeHumanRoom(): Promise<
    RoomSnapshot & { ok: boolean; exists: boolean }
  > {
    const fallback = normalizeRoomSnapshot(
      { roomMode: 'human_only_public' },
      'HPLAY-AUTO'
    );
    if (typeof fetch !== 'function') {
      return { ...fallback, ok: false, exists: false };
    }
    try {
      const res = await fetch(`${this.resolveHttpBaseUrl()}/api/room/matchmake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomMode: 'human_only_public' }),
      });
      if (!res.ok) throw new Error('Matchmaking failed');
      const data = (await res.json()) as Record<string, unknown>;
      return {
        ...normalizeRoomSnapshot(data, 'HPLAY-AUTO'),
        ok: Boolean(data.ok),
        exists: Boolean(data.exists),
      };
    } catch {
      return { ...fallback, ok: false, exists: false };
    }
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

  private createLocalPlayerState(
    config: LobbyConfig,
    spawnX: number,
    spawnY: number,
    spawnZ: number
  ): PlayerState {
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

    return {
      id: this.localPlayerId,
      name: config.playerName.trim() || 'Commander_CI',
      isBot: false,
      participantType: 'human',
      isReady: false,
      isParticipant: false,
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
  }

  public initializeMatch(
    config: LobbyConfig,
    spawnX: number,
    spawnY: number,
    spawnZ: number
  ): PlayerState {
    this.state = this.createFreshMatchState();
    this.state.phase = 'ACTIVE';
    this.isOnlineRoom = config.mode !== 'solo_bots';
    this.roomMode = roomModeForSessionMode(config.mode);
    this.roomCode = (config.roomCode || 'CICRAFT-1').trim().toUpperCase();
    this.activeRoomConfig = config;

    const localPlayer = this.createLocalPlayerState(config, spawnX, spawnY, spawnZ);
    localPlayer.isParticipant = true;
    localPlayer.isReady = true;
    this.activeLocalPlayer = localPlayer;
    this.state.players.set(this.localPlayerId, localPlayer);

    if (this.isOnlineRoom) {
      this.connectToMultiplayerRoom(config, localPlayer, true);
    } else {
      this.disconnectMultiplayerRoom();
      this.connectionState = 'idle';
      this.connectedHumanCount = 1;
      this.roomSnapshot = null;
      this.serverPlayerId = '';
      this.onConnectionStatusChange?.(
        'LOCAL AUTHORITATIVE ENGINE',
        true,
        'idle',
        1
      );
    }

    return localPlayer;
  }

  /**
   * Create or join a lobby-managed room without starting the 3D match. The
   * server alone emits match_started once its authenticated ready/host check
   * passes; GameEngine then calls initializeStartedMatch().
   */
  public connectToLobbyRoom(config: LobbyConfig): PlayerState {
    const requestedCode = (
      config.createLobby ? 'NEW-LOBBY' : config.roomCode || 'CICRAFT-1'
    )
      .trim()
      .toUpperCase();
    const requestedMode = roomModeForSessionMode(config.mode);
    if (
      !config.createLobby &&
      this.wantsRoomConnection &&
      this.ws &&
      this.roomCode === requestedCode &&
      this.roomMode === requestedMode &&
      this.activeRoomConfig?.roomPassword === config.roomPassword &&
      this.activeLocalPlayer
    ) {
      this.activeRoomConfig = config;
      return this.activeLocalPlayer;
    }

    this.state = this.createFreshMatchState();
    this.state.phase = 'LOBBY';
    this.isOnlineRoom = true;
    this.roomMode = requestedMode;
    this.roomCode = requestedCode;
    this.roomSnapshot = null;
    this.serverPlayerId = '';
    this.lastJoinRejection = null;
    this.activeRoomConfig = config;
    this.pendingCreateLobby = config.createLobby || null;

    const localPlayer = this.createLocalPlayerState(config, 0, 10, 0);
    localPlayer.isReady = false;
    localPlayer.isParticipant = false;
    this.activeLocalPlayer = localPlayer;
    this.state.players.set(this.localPlayerId, localPlayer);
    this.connectToMultiplayerRoom(config, localPlayer, false, 'lobby');
    return localPlayer;
  }

  /**
   * Transition the already-connected human lobby socket into an active match
   * after the authoritative server announces match_started. This preserves
   * the same socket/session/player seat—no reconnect or duplicate join.
   */
  public initializeStartedMatch(
    config: LobbyConfig,
    spawnX: number,
    spawnY: number,
    spawnZ: number
  ): PlayerState {
    const previousSnapshot = this.roomSnapshot;
    const previousServerPlayerId = this.serverPlayerId;

    this.state = this.createFreshMatchState();
    this.state.phase = 'ACTIVE';
    this.isOnlineRoom = true;
    this.roomMode = roomModeForSessionMode(config.mode);
    this.roomCode = (config.roomCode || this.roomCode || 'CICRAFT-1')
      .trim()
      .toUpperCase();
    this.roomSnapshot = previousSnapshot;
    this.serverPlayerId = previousServerPlayerId;
    this.activeRoomConfig = config;

    const localPlayer = this.createLocalPlayerState(config, spawnX, spawnY, spawnZ);
    localPlayer.isReady = true;
    localPlayer.isParticipant = true;
    const selfSummary = previousSnapshot?.players.find(
      (player) => player.id === previousServerPlayerId
    );
    localPlayer.isHost = Boolean(selfSummary?.isHost || previousSnapshot?.isSelfHost);
    localPlayer.teamId = selfSummary?.teamId || '';
    localPlayer.teamIndex = selfSummary?.teamIndex ?? -1;
    this.activeLocalPlayer = localPlayer;
    this.state.players.set(this.localPlayerId, localPlayer);

    if (previousSnapshot) {
      const humanParticipants =
        previousSnapshot.matchParticipantCount || previousSnapshot.connectedHumans || 1;
      this.state.totalParticipants = previousSnapshot.humanOnly
        ? humanParticipants
        : humanParticipants + Math.max(0, previousSnapshot.botCount || 0);
      this.state.aliveCount =
        previousSnapshot.aliveHumans || this.state.totalParticipants;
    }

    this.sendInput(
      {
        seq: 0,
        dt: 0,
        moveX: 0,
        moveZ: 0,
        yaw: 0,
        pitch: 0,
        jump: false,
        sprint: false,
        fire: false,
        aim: false,
        reload: false,
        interact: false,
        selectSlot: -1,
        buildType: null,
        cycleMaterial: false,
      },
      true
    );

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

  private sendJoinRoomPacket(): void {
    const config = this.activeRoomConfig;
    const localPlayer = this.activeLocalPlayer;
    if (!config || !localPlayer) return;
    this.sendPacket({
      type: 'join_room',
      roomCode: this.roomCode,
      roomMode: this.roomMode,
      purpose: this.pendingConnectionPurpose,
      joinIntent:
        this.pendingConnectionPurpose === 'lobby' ? 'join_existing' : 'join_or_create',
      password: config.roomPassword || config.createLobby?.password || undefined,
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
      resetPlayer: this.pendingResetPlayer,
    });
  }

  private sendCreateLobbyPacket(): void {
    const config = this.activeRoomConfig;
    const createLobby = this.pendingCreateLobby;
    const localPlayer = this.activeLocalPlayer;
    if (!config || !createLobby || !localPlayer) return;
    this.sendPacket({
      type: 'create_lobby',
      requestId: `create_${Date.now()}`,
      accountId: this.accountId || undefined,
      accountToken: this.accountToken || undefined,
      playerName: localPlayer.name,
      config: createLobby,
    });
  }

  public connectToMultiplayerRoom(
    config: LobbyConfig,
    localPlayer: PlayerState,
    resetPlayer: boolean = false,
    purpose: 'match' | 'lobby' = 'match'
  ): void {
    this.closeSocketOnly();
    this.wantsRoomConnection = true;
    this.activeRoomConfig = config;
    this.activeLocalPlayer = localPlayer;
    this.roomMode = roomModeForSessionMode(config.mode);
    this.pendingConnectionPurpose = purpose;
    this.pendingResetPlayer = resetPlayer;
    if (purpose === 'match') this.pendingCreateLobby = null;
    else if (config.createLobby && this.roomCode === 'NEW-LOBBY') {
      this.pendingCreateLobby = config.createLobby;
    } else if (purpose === 'lobby') {
      this.pendingCreateLobby = null;
    }

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
        if (this.pendingCreateLobby) this.sendCreateLobbyPacket();
        else this.sendJoinRoomPacket();
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
        const shouldReconnect =
          this.wantsRoomConnection &&
          this.isOnlineRoom &&
          (this.state.phase === 'ACTIVE' ||
            this.roomSnapshot?.phase === 'lobby' ||
            this.roomSnapshot?.phase === 'countdown');
        if (shouldReconnect) {
          this.connectionState = 'reconnecting';
          this.onConnectionStatusChange?.(
            `🔄 ROOM ${this.roomCode} • RECONNECTING...`,
            false,
            'reconnecting',
            this.connectedHumanCount
          );
          this.reconnectTimer = window.setTimeout(() => {
            const p =
              this.state.players.get(this.localPlayerId) || this.activeLocalPlayer;
            if (p && this.isOnlineRoom && this.wantsRoomConnection) {
              const reconnectPurpose =
                this.state.phase === 'ACTIVE' ? 'match' : 'lobby';
              this.connectToMultiplayerRoom(config, p, false, reconnectPurpose);
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

  private closeSocketOnly(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.roomConnected = false;
  }

  public disconnectMultiplayerRoom(): void {
    this.wantsRoomConnection = false;
    this.closeSocketOnly();
    this.connectionState = 'idle';
  }

  /** Explicitly release the current room seat, unlike a temporary disconnect. */
  public leaveRoom(): void {
    const socketToClose = this.ws;
    if (socketToClose && socketToClose.readyState === WebSocket.OPEN) {
      try {
        socketToClose.send(JSON.stringify({ type: 'leave_room' }));
      } catch {
        // Closing below still releases the connection.
      }
    }

    this.wantsRoomConnection = false;
    this.ws = null;
    this.roomConnected = false;
    this.connectionState = 'idle';
    this.roomSnapshot = null;
    this.serverPlayerId = '';
    this.activeLocalPlayer = null;
    this.pendingCreateLobby = null;
    this.onRoomSnapshot?.(null);
    this.onConnectionStatusChange?.('🚪 LEFT ROOM', false, 'idle', 0);

    if (socketToClose) {
      socketToClose.onclose = null;
      socketToClose.onerror = null;
      socketToClose.onmessage = null;
      window.setTimeout(() => {
        try {
          socketToClose.close();
        } catch {
          // Ignore
        }
      }, 75);
    }
  }

  public setReady(ready: boolean): void {
    if (!this.isOnlineRoom || !this.roomConnected) return;
    const localPlayer = this.state.players.get(this.localPlayerId);
    if (localPlayer) localPlayer.isReady = ready;
    this.sendPacket({ type: 'set_ready', ready });
  }

  public requestMatchStart(): void {
    if (!this.isOnlineRoom || !this.roomConnected) return;
    this.sendPacket({ type: 'request_match_start' });
  }

  public closeRoom(): void {
    if (!this.isOnlineRoom || !this.roomConnected) return;
    this.sendPacket({ type: 'close_room' });
  }

  private handleServerMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'lobby_created': {
        const snapshot = normalizeRoomSnapshot(msg, this.roomCode, []);
        const createdPassword = this.pendingCreateLobby?.password;
        this.roomSnapshot = snapshot;
        this.roomMode = snapshot.mode;
        this.roomCode = snapshot.roomCode;
        if (this.activeRoomConfig) {
          const { createLobby: _createdLobby, ...joinedConfig } = this.activeRoomConfig;
          this.activeRoomConfig = {
            ...joinedConfig,
            roomCode: snapshot.roomCode,
            roomPassword: createdPassword,
            botCount: snapshot.humanOnly ? 0 : snapshot.botCount,
            difficulty: snapshot.botDifficulty,
            lobbyName: snapshot.name,
            maxPlayers: snapshot.maxPlayers,
            mapId: snapshot.mapId,
            teamMode: snapshot.teamMode,
            startCondition: snapshot.startCondition,
            visibility:
              snapshot.visibility === 'private' ? 'private' : 'public',
          };
        }
        this.pendingCreateLobby = null;
        this.onLobbyCreated?.(snapshot);
        this.onRoomSnapshot?.(snapshot);
        this.sendJoinRoomPacket();
        break;
      }

      case 'lobby_create_rejected': {
        const code = String(msg.code || 'lobby_create_rejected');
        const reason = String(msg.reason || 'The server rejected this lobby.');
        this.lastJoinRejection = { code, reason };
        this.pendingCreateLobby = null;
        this.wantsRoomConnection = false;
        this.roomConnected = false;
        this.connectionState = 'error';
        this.onLobbyCreateRejected?.(code, reason);
        this.onJoinRejected?.(code, reason);
        this.onConnectionStatusChange?.(`🚫 ${reason}`, false, 'error', 0);
        this.closeSocketOnly();
        break;
      }

      case 'host_changed': {
        const snapshot = normalizeRoomSnapshot(
          msg,
          this.roomCode,
          this.roomSnapshot?.players || []
        );
        if (this.serverPlayerId) snapshot.selfPlayerId = this.serverPlayerId;
        snapshot.isSelfHost = snapshot.hostPlayerId === this.serverPlayerId;
        this.roomSnapshot = snapshot;
        this.onHostChanged?.(snapshot);
        this.onRoomSnapshot?.(snapshot);
        break;
      }

      case 'room_closed': {
        const snapshot = normalizeRoomSnapshot(
          msg,
          this.roomCode,
          this.roomSnapshot?.players || []
        );
        const reason = String(msg.reason || 'This lobby has been closed.');
        this.roomSnapshot = snapshot;
        this.onRoomClosed?.(snapshot, reason);
        this.leaveRoom();
        this.onConnectionStatusChange?.(`🚪 ${reason}`, false, 'idle', 0);
        break;
      }
      case 'room_state': {
        const snapshot = normalizeRoomSnapshot(
          msg,
          this.roomCode,
          this.roomSnapshot?.players || []
        );
        this.roomSnapshot = snapshot;
        this.roomMode = snapshot.mode;
        this.roomCode = snapshot.roomCode;
        if (snapshot.selfPlayerId) {
          this.serverPlayerId = snapshot.selfPlayerId;
        }
        this.state.phase =
          snapshot.phase === 'active'
            ? 'ACTIVE'
            : snapshot.phase === 'ended'
              ? 'ENDED'
              : 'LOBBY';

        if (
          this.activeRoomConfig &&
          isHumanOnlySessionMode(this.activeRoomConfig.mode) &&
          (!snapshot.humanOnly || snapshot.aiFillEnabled || snapshot.botCount !== 0)
        ) {
          this.lastJoinRejection = {
            code: 'room_mode_mismatch',
            reason: 'The server room is not a verified human-only room.',
          };
          this.onJoinRejected?.(
            this.lastJoinRejection.code,
            this.lastJoinRejection.reason
          );
          this.leaveRoom();
          break;
        }

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
        this.connectedHumanCount = snapshot.connectedHumans;
        this.connectionState = 'connected';
        this.onConnectionStatusChange?.(
          `🟢 ROOM ${this.roomCode} • ${this.connectedHumanCount} ONLINE`,
          true,
          'connected',
          this.connectedHumanCount
        );

        const snapshotPlayerIds = new Set(players.map((player) => String(player.id)));
        for (const existingId of Array.from(this.state.players.keys())) {
          if (
            existingId.startsWith('net_') &&
            existingId !== this.serverPlayerId &&
            !snapshotPlayerIds.has(existingId)
          ) {
            this.state.players.delete(existingId);
            this.remoteTargets.delete(existingId);
          }
        }

        for (const rp of players) {
          if (rp.isBot === true) continue;
          const id = String(rp.id);
          if (id === this.localPlayerId || id === this.serverPlayerId) {
            const localPlayer = this.state.players.get(this.localPlayerId);
            if (localPlayer) {
              localPlayer.isReady = Boolean(rp.isReady);
              localPlayer.isParticipant = Boolean(rp.isParticipant);
              localPlayer.isConnected = Boolean(rp.isConnected ?? true);
              localPlayer.isHost = Boolean(rp.isHost);
              localPlayer.teamId = String(rp.teamId || '');
              localPlayer.teamIndex = Number(rp.teamIndex ?? -1);
            }
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
              participantType: 'human',
              isReady: Boolean(rp.isReady),
              isParticipant: Boolean(rp.isParticipant),
              isConnected: Boolean(rp.isConnected ?? true),
              isHost: Boolean(rp.isHost),
              teamId: String(rp.teamId || ''),
              teamIndex: Number(rp.teamIndex ?? -1),
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
            existing.isReady = Boolean(rp.isReady);
            existing.isParticipant = Boolean(rp.isParticipant);
            existing.isConnected = Boolean(rp.isConnected ?? true);
            existing.isHost = Boolean(rp.isHost);
            existing.teamId = String(rp.teamId || '');
            existing.teamIndex = Number(rp.teamIndex ?? -1);
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

        if (snapshot.humanOnly) {
          if (snapshot.matchParticipantCount > 0) {
            this.state.totalParticipants = snapshot.matchParticipantCount;
          }
          this.state.aliveCount = snapshot.aliveHumans;
        }
        this.onRoomSnapshot?.(snapshot);
        break;
      }

      case 'room_joined': {
        const snapshot = normalizeRoomSnapshot(
          msg,
          this.roomCode,
          this.roomSnapshot?.players || []
        );
        this.roomSnapshot = snapshot;
        this.roomMode = snapshot.mode;
        this.roomCode = snapshot.roomCode;
        if (snapshot.selfPlayerId) this.serverPlayerId = snapshot.selfPlayerId;
        this.lastJoinRejection = null;
        this.onRoomSnapshot?.(snapshot);
        break;
      }

      case 'join_rejected': {
        const code = String(msg.code || 'join_rejected');
        const reason = String(msg.reason || 'The server rejected this room join.');
        this.lastJoinRejection = { code, reason };
        this.wantsRoomConnection = false;
        this.roomConnected = false;
        this.connectionState = 'error';
        this.onJoinRejected?.(code, reason);
        this.onConnectionStatusChange?.(`🚫 ${reason}`, false, 'error', 0);
        this.closeSocketOnly();
        break;
      }

      case 'ready_rejected':
      case 'match_start_rejected':
      case 'room_close_rejected':
      case 'bot_rejected': {
        const reason = String(msg.reason || 'Room action rejected by the server.');
        if (msg.roomCode) {
          this.roomSnapshot = normalizeRoomSnapshot(
            msg,
            this.roomCode,
            this.roomSnapshot?.players || []
          );
          this.onRoomSnapshot?.(this.roomSnapshot);
        }
        this.onRoomActionRejected?.(reason);
        this.onConnectionStatusChange?.(
          `⚠️ ${reason}`,
          this.roomConnected,
          'error',
          this.connectedHumanCount
        );
        break;
      }

      case 'match_started': {
        const snapshot = normalizeRoomSnapshot(
          msg,
          this.roomCode,
          this.roomSnapshot?.players || []
        );
        if (snapshot.selfPlayerId) {
          this.serverPlayerId = snapshot.selfPlayerId;
        } else if (this.serverPlayerId) {
          snapshot.selfPlayerId = this.serverPlayerId;
        }
        this.roomSnapshot = snapshot;
        this.roomMode = snapshot.mode;
        this.state.phase = 'ACTIVE';
        if (snapshot.matchParticipantCount > 0) {
          this.state.totalParticipants = snapshot.humanOnly
            ? snapshot.matchParticipantCount
            : snapshot.matchParticipantCount + snapshot.botCount;
          this.state.aliveCount = snapshot.humanOnly
            ? snapshot.aliveHumans
            : this.state.totalParticipants;
        }
        this.onRoomSnapshot?.(snapshot);
        this.onMatchStarted?.(snapshot);
        break;
      }

      case 'match_ended': {
        const snapshot = normalizeRoomSnapshot(
          msg,
          this.roomCode,
          this.roomSnapshot?.players || []
        );
        if (snapshot.selfPlayerId) {
          this.serverPlayerId = snapshot.selfPlayerId;
        } else if (this.serverPlayerId) {
          snapshot.selfPlayerId = this.serverPlayerId;
        }
        this.roomSnapshot = snapshot;
        this.roomMode = snapshot.mode;
        this.state.phase = 'ENDED';
        this.state.winnerName = snapshot.winnerName;
        this.state.aliveCount = snapshot.aliveHumans;
        this.onRoomSnapshot?.(snapshot);
        const rawPlacements =
          msg.placements && typeof msg.placements === 'object'
            ? (msg.placements as Record<string, unknown>)
            : {};
        const placements: Record<string, number> = {};
        for (const [playerId, placement] of Object.entries(rawPlacements)) {
          placements[playerId] = Number(placement || 0);
        }
        this.onMatchEnded?.(snapshot, placements);
        break;
      }

      case 'player_left': {
        const leftId = String(msg.playerId || '');
        if (leftId) {
          this.state.players.delete(leftId);
          this.remoteTargets.delete(leftId);
        }
        if (msg.roomCode) {
          this.roomSnapshot = normalizeRoomSnapshot(
            msg,
            this.roomCode,
            (this.roomSnapshot?.players || []).filter(
              (player) => player.id !== leftId
            )
          );
          this.onRoomSnapshot?.(this.roomSnapshot);
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
        if (String(msg.ownerId || '') === this.serverPlayerId) break;
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
        if (String(msg.collectorId || '') === this.serverPlayerId) {
          if (msg.authoritativeItem && typeof msg.authoritativeItem === 'object') {
            this.onAuthoritativeLootCollected?.(
              msg.authoritativeItem as LootItemState,
              msg.swappedDrop ? (msg.swappedDrop as LootItemState) : undefined
            );
          }
          break;
        }
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

  public sendInput(input: PlayerInputPacket, force: boolean = false): void {
    if (!this.isOnlineRoom || !this.roomConnected || !this.ws) return;
    const now = performance.now();
    const elapsed = now - this.lastSyncSentTime;
    if (!force && elapsed < 45) return;

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
      !force &&
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

  /**
   * Requests (rather than optimistically performs) a Legendary Tower vault
   * pickup. Returns false when no live room socket can carry the request.
   */
  public sendAuthoritativeLootCollectRequest(
    item: LootItemState,
    predictedSwappedDrop?: LootItemState
  ): boolean {
    if (
      !this.isOnlineRoom ||
      !this.roomConnected ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    this.sendPacket({
      type: 'collect_loot',
      authoritative: true,
      sessionToken: this.sessionToken,
      lootId: item.id,
      itemType: item.itemType,
      position: this.activeLocalPlayer?.position,
      swappedDrop: predictedSwappedDrop,
    });
    return true;
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
