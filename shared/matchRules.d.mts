export type GameMode = 'battle_royale' | 'free_for_all' | 'team_deathmatch';
export type TdmTeamId = 'red' | 'blue';

export interface ModeRuleSpec {
  readonly id: GameMode;
  readonly label: string;
  readonly shortLabel: 'BR' | 'FFA' | 'TDM';
  readonly badge: string;
  readonly subtitle: string;
  readonly objective: string;
  readonly durationSeconds: number | null;
  readonly targetKills: number | null;
  readonly scoreLimit: number | null;
  readonly autoRespawn: boolean;
  readonly stormEnabled: boolean;
  readonly dropLootOnDeath: boolean;
  readonly initialLives: number | null;
  readonly teams: readonly TdmTeamId[] | null;
}

export interface TeamScoreState {
  red: number;
  blue: number;
}

export interface InitialVitalsState {
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  alive: boolean;
  livesRemaining: number | null;
  deaths: number;
  respawns: number;
}

export interface DamageResolution {
  damage: number;
  health: number;
  shield: number;
  absorbedByShield: number;
  healthDamage: number;
  isShieldHit: boolean;
  isShieldBreak: boolean;
  lethal: boolean;
}

export interface MatchParticipantLike {
  id: string;
  name: string;
  alive?: boolean;
  isParticipant?: boolean;
  eliminations?: number;
  deaths?: number;
  respawns?: number;
  damageDealt?: number;
  joinedAt?: number;
  teamId?: string;
  teamIndex?: number;
}

export interface MatchOutcomeEvaluation {
  ended: boolean;
  mode: GameMode;
  reason: '' | 'score_limit' | 'time_expired' | 'last_standing';
  isDraw: boolean;
  winnerId: string | null;
  winnerIds: string[];
  winnerTeamId: string;
  winnerName: string;
  teamScores: TeamScoreState;
  placements: Record<string, number>;
  timeRemaining: number | null;
}

export const GAME_MODES: readonly GameMode[];
export const DEFAULT_GAME_MODE: GameMode;
export const MATCH_DURATION_SECONDS: number;
export const FFA_MATCH_DURATION_SECONDS: number;
export const TDM_MATCH_DURATION_SECONDS: number;
export const KILL_TARGET: number;
export const FFA_TARGET_KILLS: number;
export const TDM_TARGET_KILLS: number;
export const TDM_TEAMS: readonly TdmTeamId[];
export const TDM_TEAM_LABELS: Readonly<Record<TdmTeamId, string>>;
export const TDM_TEAM_COLORS: Readonly<Record<TdmTeamId, number>>;
export const PLAYER_MAX_HEALTH: number;
export const PLAYER_MAX_SHIELD: number;
export const PLAYER_SPAWN_HEALTH: number;
export const PLAYER_SPAWN_SHIELD: number;
export const MODE_RULES: Readonly<Record<GameMode, ModeRuleSpec>>;

export function normalizeGameMode(
  value: unknown,
  fallback?: GameMode | null
): GameMode;
export function isValidGameMode(value: unknown): value is GameMode;
export function getMatchRules(mode: unknown): ModeRuleSpec;
export function gameModeLabel(mode: unknown): string;
export function gameModeShortLabel(mode: unknown): 'BR' | 'FFA' | 'TDM';
export function isRespawnMode(mode: unknown): boolean;
export function isTimedMode(mode: unknown): boolean;
export function isStormEnabledForMode(mode: unknown): boolean;
export function getRemainingMatchSeconds(
  mode: unknown,
  elapsedSeconds?: number,
  durationOverride?: number | null
): number | null;
export function isMatchTimeExpired(
  mode: unknown,
  elapsedSeconds?: number,
  durationOverride?: number | null
): boolean;
export function formatMatchClock(seconds: number): string;
export function createInitialVitals(mode?: unknown): InitialVitalsState;
export function applyAuthoritativeDamage(
  target: { health?: number; shield?: number; alive?: boolean } | null | undefined,
  rawDamage: number
): DamageResolution;
export function applyRespawnVitals<T extends Record<string, any>>(
  player: T,
  spawnPosition?: { x: number; y: number; z: number } | null
): T;
export function normalizeTdmTeam(teamId: unknown): TdmTeamId | null;
export function tdmTeamLabel(teamId: unknown): string;
export function assignTeamsForMode<T extends MatchParticipantLike>(
  mode: unknown,
  players: readonly T[],
  teamMode?: 'solo' | 'duo' | 'squad'
): T[];
export function areTeammates(
  mode: unknown,
  playerA: { id?: string; teamId?: string; teamIndex?: number } | null | undefined,
  playerB: { id?: string; teamId?: string; teamIndex?: number } | null | undefined,
  teamMode?: 'solo' | 'duo' | 'squad'
): boolean;
export function createInitialTeamScores(): TeamScoreState;
export function computeTeamScores(
  players?: readonly MatchParticipantLike[],
  existingScores?: Partial<TeamScoreState> | null
): TeamScoreState;
export function rankFfaPlayers<T extends MatchParticipantLike>(
  players?: readonly T[]
): T[];
export function evaluateMatchOutcome(options?: {
  mode?: unknown;
  players?: readonly MatchParticipantLike[];
  teamScores?: Partial<TeamScoreState> | null;
  elapsedSeconds?: number;
  minPlayers?: number;
  teamMode?: 'solo' | 'duo' | 'squad';
  durationSeconds?: number | null;
}): MatchOutcomeEvaluation;
