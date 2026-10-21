/**
 * Colyseus-Ready State Schemas for CI Craft 3D Battle Royale
 */

export type WeaponRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export type WeaponCategory =
  | 'harvester'
  | 'pistol'
  | 'assault_rifle'
  | 'shotgun'
  | 'smg'
  | 'sniper'
  | 'medkit'
  | 'shield_potion';

export type AmmoType = 'none' | 'light' | 'medium' | 'shells' | 'heavy';

export type BuildPieceType = 'wall' | 'ramp' | 'floor' | 'roof';

export type BuildMaterialType = 'wood' | 'stone' | 'metal';

export type BotDifficulty = 'easy' | 'medium' | 'hard';

export type TimeOfDayPreset = 'day' | 'sunset' | 'night';

export type StarterLoadoutType =
  | 'balanced'
  | 'close_quarters'
  | 'sharpshooter'
  | 'demolition';

export type BackAccessoryType =
  | 'jump_pack'
  | 'energy_wings'
  | 'tactical_shield'
  | 'none';

export type OutfitPresetId =
  | 'vanguard_blue'
  | 'solar_phoenix'
  | 'neon_phantom'
  | 'emerald_ranger'
  | 'arctic_sentinel'
  | 'crimson_striker';

export interface CosmeticLoadout {
  outfitId: OutfitPresetId;
  skinColor: number;
  accentColor: number;
  backAccessory: BackAccessoryType;
}

export interface AccountCredentialsState {
  accountId: string;
  accountToken: string;
  passkey: string;
}

export interface PlayerProgressionState {
  accountId?: string;
  callsign?: string;
  matchesPlayed: number;
  wins: number;
  eliminations: number;
  damageDealt: number;
  bestPlacement: number;
  xp: number;
  level: number;
  cosmetics?: CosmeticLoadout;
  unlockedOutfits?: OutfitPresetId[];
  persistenceBackend?: string;
  storageMode: 'local_only' | 'server_verified';
}

export type BotAIState =
  | 'SKYDIVING'
  | 'PATROLLING'
  | 'ROAMING'
  | 'LOOTING'
  | 'ENGAGING'
  | 'TAKING_COVER'
  | 'FLEEING_STORM';

export interface Vector3State {
  x: number;
  y: number;
  z: number;
}

export interface InventorySlot {
  weaponId: string;
  name: string;
  category: WeaponCategory;
  rarity: WeaponRarity;
  clipAmmo: number;
  maxClipAmmo: number;
  ammoType: AmmoType;
  isConsumable: boolean;
  count: number;
}

export type InventorySlotState = InventorySlot;

export interface AmmoReserveState {
  none: number;
  light: number;
  medium: number;
  shells: number;
  heavy: number;
}

export interface MaterialReserveState {
  wood: number;
  stone: number;
  metal: number;
}

export interface PlayerState {
  id: string;
  name: string;
  isBot: boolean;
  participantType?: 'human' | 'bot';
  isReady?: boolean;
  isParticipant?: boolean;
  isConnected?: boolean;
  isHost?: boolean;
  teamId?: string;
  teamIndex?: number;
  aiState?: BotAIState;
  skinColor: number;
  accentColor: number;
  backAccessory?: BackAccessoryType;
  position: Vector3State;
  velocity: Vector3State;
  yaw: number;
  facingYaw: number;
  pitch: number;
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  alive: boolean;
  isGliding: boolean;
  isGrounded: boolean;
  isSprinting: boolean;
  isAiming: boolean;
  isReloading: boolean;
  reloadTimer: number;
  reloadDuration: number;
  isHealing: boolean;
  landingImpactTimer: number;
  activeSlot: number;
  selectedMaterial: BuildMaterialType;
  inventory: (InventorySlot | null)[];
  ammo: AmmoReserveState;
  materials: MaterialReserveState;
  eliminations: number;
  damageDealt: number;
  shotsFired: number;
  shotsHit: number;
  structuresBuilt: number;
}

export interface LootItemState {
  id: string;
  itemType: 'weapon' | 'consumable' | 'ammo' | 'material' | 'chest';
  weaponCategory?: WeaponCategory;
  ammoType?: AmmoType;
  materialType?: BuildMaterialType;
  rarity: WeaponRarity;
  name: string;
  amount: number;
  position: Vector3State;
  opened: boolean;
  /** True only for the fixed Legendary Tower vault registry. */
  isLegendaryTowerLoot?: boolean;
  /** In online play these items are spawned/claimed only by the server. */
  serverAuthoritative?: boolean;
}

export interface BuildablePieceState {
  id: string;
  ownerId: string;
  pieceType: BuildPieceType;
  material: BuildMaterialType;
  position: Vector3State;
  rotationY: number;
  health: number;
  maxHealth: number;
}

export interface StormState {
  phase: number;
  currentCenterX: number;
  currentCenterZ: number;
  currentRadius: number;
  targetCenterX: number;
  targetCenterZ: number;
  targetRadius: number;
  phaseTimer: number;
  isShrinking: boolean;
  damagePerSecond: number;
}

export interface MatchState {
  phase: 'LOBBY' | 'ACTIVE' | 'ENDED';
  matchTimer: number;
  aliveCount: number;
  totalParticipants: number;
  winnerName: string;
  players: Map<string, PlayerState>;
  lootItems: Map<string, LootItemState>;
  buildables: Map<string, BuildablePieceState>;
  storm: StormState;
}

export interface PlayerInputPacket {
  seq: number;
  dt: number;
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  sprint: boolean;
  fire: boolean;
  aim: boolean;
  reload: boolean;
  interact: boolean;
  selectSlot: number;
  buildType: BuildPieceType | null;
  cycleMaterial: boolean;
}

export type MultiplayerRoomMode =
  | 'online_ai_fill'
  | 'human_only_public'
  | 'human_only_private';

export type HumanOnlySessionMode = 'human_only_public' | 'human_only_private';

export type SessionMode = 'solo_bots' | 'online' | HumanOnlySessionMode;

export type RoomPhase = 'lobby' | 'countdown' | 'active' | 'ended';

export type LobbyVisibility = 'public' | 'private';

export type RoomVisibility = LobbyVisibility | 'room_code';

export type TeamMode = 'solo' | 'duo' | 'squad';

export type LobbyStartCondition = 'all_ready' | 'host_start' | 'fill_lobby';

export type LobbyMapId = 'ci_island';

export type LobbyStatus =
  | 'waiting'
  | 'starting'
  | 'in_game'
  | 'full'
  | 'ended'
  | 'closed';

export interface CreateLobbyRequest {
  name?: string;
  visibility: LobbyVisibility;
  humanOnly: boolean;
  maxPlayers: 2 | 4 | 8 | 16 | 20;
  mapId: LobbyMapId;
  teamMode: TeamMode;
  botCount: number;
  botDifficulty?: BotDifficulty;
  startCondition: LobbyStartCondition;
  password?: string;
  allowLateJoin?: boolean;
}

export interface LobbySummary {
  id: string;
  roomId: string;
  roomCode: string;
  name: string;
  lobbyName: string;
  hostName: string;
  hostPlayerId: string | null;
  mode: MultiplayerRoomMode;
  roomMode: MultiplayerRoomMode;
  visibility: RoomVisibility;
  isPrivate: boolean;
  hasPassword: boolean;
  phase: RoomPhase;
  status: LobbyStatus;
  matchStatus: RoomPhase;
  humanOnly: boolean;
  aiFillEnabled: boolean;
  botCount: number;
  botDifficulty: BotDifficulty;
  currentPlayers: number;
  humanCount: number;
  connectedHumans: number;
  readyHumans: number;
  maxPlayers: number;
  availableSlots: number;
  minPlayers: number;
  mapId: LobbyMapId;
  mapName: string;
  teamMode: TeamMode;
  gameMode: TeamMode;
  startCondition: LobbyStartCondition;
  allowLateJoin: boolean;
  canJoin: boolean;
  joinBlockReason: string;
  createdAt: number;
  matchStartedAt: number;
  pingMs: number | null;
}

export function isHumanOnlySessionMode(
  mode: SessionMode
): mode is HumanOnlySessionMode {
  return mode === 'human_only_public' || mode === 'human_only_private';
}

export function roomModeForSessionMode(mode: SessionMode): MultiplayerRoomMode {
  if (mode === 'human_only_public' || mode === 'human_only_private') return mode;
  return 'online_ai_fill';
}

/**
 * The authoritative client-side bot gate: human-only modes always resolve to
 * zero bot spawns regardless of the (disabled) AI-combatant selector.
 */
export function effectiveBotCountForMode(
  mode: SessionMode,
  requestedBotCount: number
): number {
  if (isHumanOnlySessionMode(mode)) return 0;
  return Math.max(0, Math.floor(Number(requestedBotCount) || 0));
}

export interface RoomPlayerSummary {
  id: string;
  name: string;
  participantType: 'human';
  isBot: false;
  isAuthenticated: boolean;
  isReady: boolean;
  isParticipant: boolean;
  isConnected: boolean;
  isHost: boolean;
  teamId: string;
  teamIndex: number;
  alive: boolean;
}

export interface RoomSnapshot {
  id: string;
  roomId: string;
  roomCode: string;
  name: string;
  lobbyName: string;
  hostName: string;
  hostPlayerId: string | null;
  isSelfHost: boolean;
  mode: MultiplayerRoomMode;
  roomMode: MultiplayerRoomMode;
  visibility: RoomVisibility;
  isPrivate: boolean;
  hasPassword: boolean;
  isListed: boolean;
  isLobbyManaged: boolean;
  phase: RoomPhase;
  status: LobbyStatus;
  matchStatus: RoomPhase;
  humanOnly: boolean;
  aiFillEnabled: boolean;
  botCount: number;
  botDifficulty: BotDifficulty;
  connectedPlayers: number;
  connectedHumans: number;
  authenticatedHumans: number;
  readyPlayers: number;
  readyHumans: number;
  totalPlayers: number;
  totalHumans: number;
  aliveHumans: number;
  maxPlayers: number;
  availableSlots: number;
  minPlayers: number;
  mapId: LobbyMapId;
  mapName: string;
  teamMode: TeamMode;
  gameMode: TeamMode;
  startCondition: LobbyStartCondition;
  allowLateJoin: boolean;
  createdAt: number;
  matchParticipantCount: number;
  countdownEndsAt: number;
  canStart: boolean;
  canHostStart: boolean;
  winnerId: string | null;
  winnerIds: string[];
  winnerTeamId: string;
  winnerName: string;
  stormPhase: number;
  selfPlayerId?: string;
  players: RoomPlayerSummary[];
}

export interface LobbyConfig {
  playerName: string;
  mode: SessionMode;
  roomCode?: string;
  roomPassword?: string;
  createLobby?: CreateLobbyRequest;
  lobbyName?: string;
  maxPlayers?: number;
  mapId?: LobbyMapId;
  teamMode?: TeamMode;
  startCondition?: LobbyStartCondition;
  visibility?: LobbyVisibility;
  botCount: number;
  difficulty: BotDifficulty;
  skyDrop: boolean;
  starterLoadout: StarterLoadoutType;
  cosmetics?: CosmeticLoadout;
}

export interface GameSettings {
  mouseSensitivity: number;
  touchSensitivity?: number;
  audioVolume: number;
  sfxVolume?: number;
  graphicsQuality: 'low' | 'medium' | 'high';
  timeOfDay: TimeOfDayPreset;
  showFps: boolean;
}
