import type {
  GameModeChoice,
  LobbyMapId,
  LobbyStatus,
  LobbySummary,
  LobbyStartCondition,
  TeamMode,
} from './schemas';

function normalizeModeFilter(raw: unknown): GameModeChoice | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'battle_royale' || v === 'br') return 'battle_royale';
  if (v === 'free_for_all' || v === 'ffa') return 'free_for_all';
  if (v === 'team_deathmatch' || v === 'tdm') return 'team_deathmatch';
  return null;
}

export type LobbyBrowserSort =
  | 'most_players'
  | 'fewest_players'
  | 'lowest_ping'
  | 'newest';

export type LobbyAvailabilityFilter = 'all' | 'open' | 'four_plus' | 'eight_plus';

export interface LobbyBrowserFilters {
  search: string;
  visibility: 'all' | 'public' | 'private';
  matchType: 'all' | 'human_only' | 'ai_fill';
  humanOnly: boolean;
  matchMode?: 'all' | GameModeChoice;
  teamMode: 'all' | TeamMode;
  availability: LobbyAvailabilityFilter;
  status: 'all' | LobbyStatus;
  mapId: 'all' | LobbyMapId;
}

export const DEFAULT_LOBBY_FILTERS: LobbyBrowserFilters = {
  search: '',
  visibility: 'all',
  matchType: 'all',
  humanOnly: false,
  matchMode: 'all',
  teamMode: 'all',
  availability: 'all',
  status: 'all',
  mapId: 'all',
};

function includesSearch(lobby: LobbySummary, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${lobby.name} ${lobby.roomCode} ${lobby.hostName}`
    .toLowerCase()
    .includes(normalized);
}

function availabilityMatches(
  lobby: LobbySummary,
  availability: LobbyAvailabilityFilter
): boolean {
  if (availability === 'open') return lobby.availableSlots >= 1;
  if (availability === 'four_plus') return lobby.availableSlots >= 4;
  if (availability === 'eight_plus') return lobby.availableSlots >= 8;
  return true;
}

export function filterAndSortLobbies(
  lobbies: readonly LobbySummary[],
  filters: LobbyBrowserFilters,
  sort: LobbyBrowserSort,
  pingMs: number | null = null
): LobbySummary[] {
  const filtered = lobbies.filter((lobby) => {
    if (!includesSearch(lobby, filters.search)) return false;
    if (filters.visibility !== 'all' && lobby.visibility !== filters.visibility) {
      return false;
    }
    if (filters.humanOnly && !lobby.humanOnly) return false;
    if (filters.matchType === 'human_only' && !lobby.humanOnly) return false;
    if (filters.matchType === 'ai_fill' && lobby.humanOnly) return false;
    if (filters.matchMode && filters.matchMode !== 'all') {
      const targetMode = normalizeModeFilter(filters.matchMode);
      if (targetMode) {
        const lobbyMode =
          normalizeModeFilter(lobby.matchMode || lobby.gameMode) ||
          'battle_royale';
        if (lobbyMode !== targetMode) return false;
      }
    }
    if (filters.teamMode !== 'all' && lobby.teamMode !== filters.teamMode) return false;
    if (!availabilityMatches(lobby, filters.availability)) return false;
    if (filters.status !== 'all' && lobby.status !== filters.status) return false;
    if (filters.mapId !== 'all' && lobby.mapId !== filters.mapId) return false;
    return true;
  });

  const pingFor = (lobby: LobbySummary): number =>
    typeof lobby.pingMs === 'number'
      ? lobby.pingMs
      : typeof pingMs === 'number'
        ? pingMs
        : Number.POSITIVE_INFINITY;

  return filtered.sort((a, b) => {
    if (sort === 'most_players') {
      return b.currentPlayers - a.currentPlayers || b.createdAt - a.createdAt;
    }
    if (sort === 'fewest_players') {
      return a.currentPlayers - b.currentPlayers || b.createdAt - a.createdAt;
    }
    if (sort === 'lowest_ping') {
      return (
        pingFor(a) - pingFor(b) ||
        b.currentPlayers - a.currentPlayers ||
        b.createdAt - a.createdAt
      );
    }
    return b.createdAt - a.createdAt;
  });
}

export function getLobbyJoinBlock(lobby: LobbySummary): string {
  if (lobby.status === 'closed') return 'This lobby is closed.';
  if (lobby.status === 'ended') return 'This match has ended.';
  if (lobby.status === 'starting') return 'This match is starting.';
  if (lobby.status === 'in_game' && !lobby.allowLateJoin) {
    return 'This match has already started.';
  }
  if (lobby.availableSlots <= 0 || lobby.status === 'full') return 'This lobby is full.';
  if (!lobby.canJoin) return lobby.joinBlockReason || 'This lobby cannot be joined right now.';
  return '';
}

export function connectionQualityLabel(pingMs: number | null): string {
  if (pingMs === null || !Number.isFinite(pingMs)) return 'Measuring…';
  if (pingMs <= 60) return 'Excellent';
  if (pingMs <= 120) return 'Good';
  if (pingMs <= 220) return 'Fair';
  return 'Poor';
}

export function teamModeLabel(teamMode: TeamMode): string {
  if (teamMode === 'duo') return 'Duo';
  if (teamMode === 'squad') return 'Squad';
  return 'Solo';
}

export function matchModeLabel(
  mode: GameModeChoice | string | undefined,
  short = false
): string {
  const normalized = normalizeModeFilter(mode) || 'battle_royale';
  if (normalized === 'free_for_all') {
    return short ? 'FFA' : 'Free for All';
  }
  if (normalized === 'team_deathmatch') {
    return short ? 'TDM' : 'Team Deathmatch';
  }
  return short ? 'BR' : 'Battle Royale';
}

export function lobbyStatusLabel(status: LobbyStatus): string {
  if (status === 'starting') return 'STARTING';
  if (status === 'in_game') return 'IN GAME';
  if (status === 'full') return 'FULL';
  if (status === 'closed') return 'CLOSED';
  if (status === 'ended') return 'ENDED';
  return 'WAITING';
}

export function startConditionLabel(condition: LobbyStartCondition): string {
  if (condition === 'host_start') return 'Host starts when everyone is ready';
  if (condition === 'fill_lobby') return 'Starts when full and everyone is ready';
  return 'Starts automatically when everyone is ready';
}

export function createLobbyInviteUrl(baseUrl: string, roomCode: string): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('room', roomCode.trim().toUpperCase());
    url.hash = '';
    return url.toString();
  } catch {
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}room=${encodeURIComponent(roomCode.trim().toUpperCase())}`;
  }
}

export function parseLobbyInviteCode(search: string, hash = ''): string {
  try {
    const fromSearch = new URLSearchParams(search).get('room');
    if (fromSearch) return fromSearch.trim().toUpperCase();
  } catch {
    // Ignore malformed invite data.
  }
  const cleanHash = hash.replace(/^#/, '');
  if (cleanHash.toLowerCase().startsWith('room=')) {
    return decodeURIComponent(cleanHash.slice(5)).trim().toUpperCase();
  }
  return '';
}
