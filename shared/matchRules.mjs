/**
 * CI CRAFT 5.0 — Shared Authoritative Match Rules
 *
 * Single source of truth for Battle Royale, Free for All (FFA), and
 * Team Deathmatch (TDM: RED vs BLUE) across server and client.
 */

export const GAME_MODES = Object.freeze([
  'battle_royale',
  'free_for_all',
  'team_deathmatch',
]);

export const DEFAULT_GAME_MODE = 'battle_royale';

export const MATCH_DURATION_SECONDS = 600;
export const FFA_MATCH_DURATION_SECONDS = 600;
export const TDM_MATCH_DURATION_SECONDS = 600;

export const KILL_TARGET = 50;
export const FFA_TARGET_KILLS = 50;
export const TDM_TARGET_KILLS = 50;

export const TDM_TEAMS = Object.freeze(['red', 'blue']);
export const TDM_TEAM_LABELS = Object.freeze({
  red: 'RED',
  blue: 'BLUE',
});
export const TDM_TEAM_COLORS = Object.freeze({
  red: 0xef4444,
  blue: 0x3b82f6,
});

// CI CRAFT 9.3: player health doubled from the original 100. The server is
// authoritative for both values: createInitialVitals(), applyAuthoritativeDamage()
// and applyRespawnVitals() all read from here, so spawn, damage clamping and
// respawn stay in lockstep. Shield values are deliberately unchanged.
export const PLAYER_MAX_HEALTH = 200;
export const PLAYER_MAX_SHIELD = 100;
export const PLAYER_SPAWN_HEALTH = 200;
export const PLAYER_SPAWN_SHIELD = 50;

export const MODE_RULES = Object.freeze({
  battle_royale: Object.freeze({
    id: 'battle_royale',
    label: 'Battle Royale',
    shortLabel: 'BR',
    badge: '🏆 BATTLE ROYALE',
    subtitle: 'Last Commander standing · Shrinking Safe Zone · 1 Life',
    objective:
      'Scavenge weapons & shields, harvest build materials, stay inside the Safe Zone, and be the last Commander standing!',
    durationSeconds: null,
    targetKills: null,
    scoreLimit: null,
    autoRespawn: false,
    stormEnabled: true,
    dropLootOnDeath: true,
    initialLives: 1,
    teams: null,
  }),
  free_for_all: Object.freeze({
    id: 'free_for_all',
    label: 'Free for All',
    shortLabel: 'FFA',
    badge: '⚔️ FREE FOR ALL',
    subtitle: '10-Minute Match · First to 50 Kills · Automatic Respawns',
    objective:
      'Every Commander for themselves! First player to 50 eliminations wins, or highest kill count when the 10:00 clock expires.',
    durationSeconds: FFA_MATCH_DURATION_SECONDS,
    targetKills: FFA_TARGET_KILLS,
    scoreLimit: FFA_TARGET_KILLS,
    autoRespawn: true,
    stormEnabled: false,
    dropLootOnDeath: false,
    initialLives: null,
    teams: null,
  }),
  team_deathmatch: Object.freeze({
    id: 'team_deathmatch',
    label: 'Team Deathmatch',
    shortLabel: 'TDM',
    badge: '🟥🟦 TEAM DEATHMATCH',
    subtitle: 'RED vs BLUE · 10-Minute Match · First Team to 50 Kills · Auto Respawns',
    objective:
      'RED vs BLUE! Fight with your squad — first team to 50 combined eliminations wins, or higher team score at 10:00 (a tie is a Draw).',
    durationSeconds: TDM_MATCH_DURATION_SECONDS,
    targetKills: TDM_TARGET_KILLS,
    scoreLimit: TDM_TARGET_KILLS,
    autoRespawn: true,
    stormEnabled: false,
    dropLootOnDeath: false,
    initialLives: null,
    teams: TDM_TEAMS,
  }),
});

export function normalizeGameMode(value, fallback = DEFAULT_GAME_MODE) {
  if (typeof value === 'string') {
    const clean = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (clean === 'battle_royale' || clean === 'br' || clean === 'battleroyale') {
      return 'battle_royale';
    }
    if (clean === 'free_for_all' || clean === 'ffa' || clean === 'freeforall') {
      return 'free_for_all';
    }
    if (
      clean === 'team_deathmatch' ||
      clean === 'tdm' ||
      clean === 'teamdeathmatch'
    ) {
      return 'team_deathmatch';
    }
  }
  return fallback;
}

export function isValidGameMode(value) {
  return normalizeGameMode(value, null) !== null;
}

export function getMatchRules(mode) {
  return MODE_RULES[normalizeGameMode(mode)];
}

export function gameModeLabel(mode) {
  return getMatchRules(mode).label;
}

export function gameModeShortLabel(mode) {
  return getMatchRules(mode).shortLabel;
}

export function isRespawnMode(mode) {
  return Boolean(getMatchRules(mode).autoRespawn);
}

export function isTimedMode(mode) {
  return typeof getMatchRules(mode).durationSeconds === 'number';
}

export function isStormEnabledForMode(mode) {
  return Boolean(getMatchRules(mode).stormEnabled);
}

export function getRemainingMatchSeconds(
  mode,
  elapsedSeconds = 0,
  durationOverride = null
) {
  const rules = getMatchRules(mode);
  const duration =
    typeof durationOverride === 'number' && durationOverride > 0
      ? durationOverride
      : rules.durationSeconds;
  if (typeof duration !== 'number') return null;
  const elapsed = Math.max(0, Number(elapsedSeconds) || 0);
  return Math.max(0, duration - elapsed);
}

export function isMatchTimeExpired(
  mode,
  elapsedSeconds = 0,
  durationOverride = null
) {
  const rules = getMatchRules(mode);
  const duration =
    typeof durationOverride === 'number' && durationOverride > 0
      ? durationOverride
      : rules.durationSeconds;
  if (typeof duration !== 'number') return false;
  return (Number(elapsedSeconds) || 0) >= duration - 1e-6;
}

export function formatMatchClock(seconds) {
  const safe = Math.max(0, Math.ceil(Number(seconds) || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function createInitialVitals(mode = DEFAULT_GAME_MODE) {
  const respawn = isRespawnMode(mode);
  return {
    health: PLAYER_SPAWN_HEALTH,
    maxHealth: PLAYER_MAX_HEALTH,
    shield: PLAYER_SPAWN_SHIELD,
    maxShield: PLAYER_MAX_SHIELD,
    alive: true,
    livesRemaining: respawn ? null : 1,
    deaths: 0,
    respawns: 0,
  };
}

export function applyAuthoritativeDamage(target, rawDamage) {
  const dmg = Math.max(0, Math.round(Number(rawDamage) || 0));
  const prevHealth = clampStat(target?.health, PLAYER_SPAWN_HEALTH, PLAYER_MAX_HEALTH);
  const prevShield = clampStat(target?.shield, 0, PLAYER_MAX_SHIELD);
  const isShieldHit = prevShield > 0 && dmg > 0;
  const absorbedByShield = Math.min(prevShield, dmg);
  const nextShield = Math.max(0, prevShield - absorbedByShield);
  const healthDamage = Math.max(0, dmg - absorbedByShield);
  const nextHealth = Math.max(0, prevHealth - healthDamage);
  const isShieldBreak = isShieldHit && nextShield <= 0;
  const lethal = nextHealth <= 0;

  if (target && typeof target === 'object') {
    target.shield = nextShield;
    target.health = nextHealth;
  }

  return {
    damage: dmg,
    health: nextHealth,
    shield: nextShield,
    absorbedByShield,
    shieldAbsorbed: absorbedByShield,
    healthDamage,
    healthLost: healthDamage,
    isShieldHit,
    isShieldBreak,
    lethal,
  };
}

export function applyRespawnVitals(player, spawnPosition = null) {
  if (!player || typeof player !== 'object') return null;
  player.health = PLAYER_SPAWN_HEALTH;
  player.maxHealth = PLAYER_MAX_HEALTH;
  player.shield = PLAYER_SPAWN_SHIELD;
  player.maxShield = PLAYER_MAX_SHIELD;
  player.alive = true;
  player.livesRemaining = null;
  player.respawns = Math.max(0, Math.floor(Number(player.respawns) || 0)) + 1;
  player.isGliding = false;
  player.isGrounded = true;
  player.isReloading = false;
  player.reloadTimer = 0;
  player.reloadDuration = 0;
  player.isHealing = false;
  player.consumeRemaining = 0;
  player.consumeDuration = 0;
  player.velocity = { x: 0, y: 0, z: 0 };
  if (
    spawnPosition &&
    typeof spawnPosition === 'object' &&
    [spawnPosition.x, spawnPosition.y, spawnPosition.z].every(Number.isFinite)
  ) {
    player.position = {
      x: Number(spawnPosition.x),
      y: Number(spawnPosition.y),
      z: Number(spawnPosition.z),
    };
  }
  return player;
}

export function normalizeTdmTeam(teamId) {
  if (teamId === 0 || teamId === '0') return 'red';
  if (teamId === 1 || teamId === '1') return 'blue';
  if (typeof teamId === 'string') {
    const clean = teamId.trim().toLowerCase();
    if (clean === 'red' || clean === 'team_red' || clean === 'team_1') return 'red';
    if (clean === 'blue' || clean === 'team_blue' || clean === 'team_2') return 'blue';
  }
  return null;
}

export function tdmTeamLabel(teamId) {
  const norm = normalizeTdmTeam(teamId);
  return norm ? TDM_TEAM_LABELS[norm] : '';
}

export function assignTeamsForMode(mode, players, teamMode = 'solo') {
  const normalizedMode = normalizeGameMode(mode);
  const list = Array.isArray(players) ? [...players] : [];
  const ordered = list.sort(
    (a, b) =>
      (Number(a?.joinedAt) || 0) - (Number(b?.joinedAt) || 0) ||
      String(a?.id || '').localeCompare(String(b?.id || ''))
  );

  if (normalizedMode === 'team_deathmatch') {
    ordered.forEach((player, index) => {
      const isBlue = index % 2 === 1;
      player.teamId = isBlue ? 'blue' : 'red';
      player.teamIndex = isBlue ? 1 : 0;
    });
    return ordered;
  }

  if (normalizedMode === 'free_for_all' || teamMode === 'solo') {
    ordered.forEach((player, index) => {
      player.teamId = `solo_${player.id}`;
      player.teamIndex = index;
    });
    return ordered;
  }

  const teamSize = teamMode === 'squad' ? 4 : teamMode === 'duo' ? 2 : 1;
  const teamCount = Math.max(
    ordered.length >= 2 ? 2 : 1,
    Math.ceil(ordered.length / Math.max(1, teamSize))
  );
  ordered.forEach((player, index) => {
    const teamIndex = index % teamCount;
    player.teamId = `team_${teamIndex + 1}`;
    player.teamIndex = teamIndex;
  });
  return ordered;
}

export function areTeammates(mode, playerA, playerB, teamMode = 'solo') {
  if (!playerA || !playerB || playerA.id === playerB.id) return false;
  const normalizedMode = normalizeGameMode(mode);
  if (normalizedMode === 'free_for_all') return false;
  if (normalizedMode === 'team_deathmatch') {
    const teamA = normalizeTdmTeam(playerA.teamId ?? playerA.teamIndex);
    const teamB = normalizeTdmTeam(playerB.teamId ?? playerB.teamIndex);
    return Boolean(teamA && teamB && teamA === teamB);
  }
  return Boolean(
    teamMode !== 'solo' &&
      playerA.teamId &&
      playerB.teamId &&
      playerA.teamId === playerB.teamId
  );
}

export function createInitialTeamScores() {
  return { red: 0, blue: 0 };
}

export function computeTeamScores(players = [], existingScores = null) {
  let redFromPlayers = 0;
  let blueFromPlayers = 0;
  for (const player of players) {
    if (!player) continue;
    const kills = Math.max(0, Math.floor(Number(player.eliminations) || 0));
    const team = normalizeTdmTeam(player.teamId ?? player.teamIndex);
    if (team === 'red') redFromPlayers += kills;
    else if (team === 'blue') blueFromPlayers += kills;
  }
  const prevRed = Math.max(0, Math.floor(Number(existingScores?.red) || 0));
  const prevBlue = Math.max(0, Math.floor(Number(existingScores?.blue) || 0));
  return {
    red: Math.max(prevRed, redFromPlayers),
    blue: Math.max(prevBlue, blueFromPlayers),
  };
}

export function rankFfaPlayers(players = []) {
  return [...players]
    .filter(Boolean)
    .sort(
      (a, b) =>
        (Math.floor(Number(b.eliminations) || 0) -
          Math.floor(Number(a.eliminations) || 0)) ||
        (Math.floor(Number(a.deaths) || 0) - Math.floor(Number(b.deaths) || 0)) ||
        (Math.floor(Number(b.damageDealt) || 0) -
          Math.floor(Number(a.damageDealt) || 0)) ||
        (Number(a.joinedAt) || 0) - (Number(b.joinedAt) || 0) ||
        String(a.id || '').localeCompare(String(b.id || ''))
    );
}

export function evaluateMatchOutcome({
  mode = DEFAULT_GAME_MODE,
  players = [],
  teamScores = null,
  elapsedSeconds = 0,
  minPlayers = 1,
  teamMode = 'solo',
  durationSeconds = null,
} = {}) {
  const normalizedMode = normalizeGameMode(mode);
  const rules = getMatchRules(normalizedMode);
  const participants = Array.isArray(players)
    ? players.filter((p) => p && p.isParticipant !== false)
    : [];
  const timeRemaining = getRemainingMatchSeconds(
    normalizedMode,
    elapsedSeconds,
    durationSeconds
  );
  const scores = computeTeamScores(participants, teamScores);

  if (normalizedMode === 'free_for_all') {
    const ranked = rankFfaPlayers(participants);
    const placements = {};
    ranked.forEach((player, index) => {
      placements[player.id] = index + 1;
    });
    const leader = ranked[0] || null;
    const topKills = Math.max(0, Math.floor(Number(leader?.eliminations) || 0));
    const reachedTarget = Boolean(
      leader && rules.targetKills && topKills >= rules.targetKills
    );
    const timeExpired = isMatchTimeExpired(
      normalizedMode,
      elapsedSeconds,
      durationSeconds
    );

    if (reachedTarget || (timeExpired && leader)) {
      const tiedLeaders = !reachedTarget
        ? ranked.filter(
            (p) => Math.max(0, Math.floor(Number(p?.eliminations) || 0)) === topKills
          )
        : [leader];
      if (!reachedTarget && tiedLeaders.length > 1) {
        for (const p of tiedLeaders) {
          placements[p.id] = 1;
        }
        return {
          ended: true,
          mode: normalizedMode,
          reason: 'time_expired_draw',
          isDraw: true,
          winnerId: null,
          winnerIds: [],
          winnerTeamId: 'draw',
          winnerName: 'DRAW',
          teamScores: scores,
          placements,
          timeRemaining: 0,
        };
      }
      return {
        ended: true,
        mode: normalizedMode,
        reason: reachedTarget ? 'score_limit' : 'time_expired',
        isDraw: false,
        winnerId: leader.id,
        winnerIds: [leader.id],
        winnerTeamId: leader.teamId || `solo_${leader.id}`,
        winnerName: leader.name,
        teamScores: scores,
        placements,
        timeRemaining: timeExpired ? 0 : timeRemaining,
      };
    }

    return {
      ended: false,
      mode: normalizedMode,
      reason: '',
      isDraw: false,
      winnerId: null,
      winnerIds: [],
      winnerTeamId: '',
      winnerName: '',
      teamScores: scores,
      placements,
      timeRemaining,
    };
  }

  if (normalizedMode === 'team_deathmatch') {
    const redReached = Boolean(rules.targetKills && scores.red >= rules.targetKills);
    const blueReached = Boolean(rules.targetKills && scores.blue >= rules.targetKills);
    const timeExpired = isMatchTimeExpired(
      normalizedMode,
      elapsedSeconds,
      durationSeconds
    );

    const buildTeamPlacements = (winningTeam) => {
      const placements = {};
      for (const player of participants) {
        const team = normalizeTdmTeam(player.teamId ?? player.teamIndex);
        if (!winningTeam || winningTeam === 'draw') {
          placements[player.id] = 1;
        } else {
          placements[player.id] = team === winningTeam ? 1 : 2;
        }
      }
      return placements;
    };

    if (redReached || blueReached) {
      const winningTeam =
        redReached && (!blueReached || scores.red >= scores.blue) ? 'red' : 'blue';
      const winners = participants.filter(
        (p) => normalizeTdmTeam(p.teamId ?? p.teamIndex) === winningTeam
      );
      return {
        ended: true,
        mode: normalizedMode,
        reason: 'score_limit',
        isDraw: false,
        winnerId: winners[0]?.id || null,
        winnerIds: winners.map((p) => p.id),
        winnerTeamId: winningTeam,
        winnerName: winningTeam === 'red' ? 'RED TEAM' : 'BLUE TEAM',
        teamScores: scores,
        placements: buildTeamPlacements(winningTeam),
        timeRemaining,
      };
    }

    if (timeExpired) {
      if (scores.red === scores.blue) {
        return {
          ended: true,
          mode: normalizedMode,
          reason: 'time_expired_draw',
          isDraw: true,
          winnerId: null,
          winnerIds: [],
          winnerTeamId: 'draw',
          winnerName: 'DRAW',
          teamScores: scores,
          placements: buildTeamPlacements('draw'),
          timeRemaining: 0,
        };
      }
      const winningTeam = scores.red > scores.blue ? 'red' : 'blue';
      const winners = participants.filter(
        (p) => normalizeTdmTeam(p.teamId ?? p.teamIndex) === winningTeam
      );
      return {
        ended: true,
        mode: normalizedMode,
        reason: 'time_expired',
        isDraw: false,
        winnerId: winners[0]?.id || null,
        winnerIds: winners.map((p) => p.id),
        winnerTeamId: winningTeam,
        winnerName: winningTeam === 'red' ? 'RED TEAM' : 'BLUE TEAM',
        teamScores: scores,
        placements: buildTeamPlacements(winningTeam),
        timeRemaining: 0,
      };
    }

    return {
      ended: false,
      mode: normalizedMode,
      reason: '',
      isDraw: false,
      winnerId: null,
      winnerIds: [],
      winnerTeamId: '',
      winnerName: '',
      teamScores: scores,
      placements: buildTeamPlacements(null),
      timeRemaining,
    };
  }

  // Battle Royale
  const placements = {};
  if (participants.length >= minPlayers) {
    const alive = participants.filter((p) => p.alive);
    const aliveTeamIds = new Set(
      alive.map((p) => p.teamId || `solo_${p.id}`)
    );
    if (alive.length > 0 && aliveTeamIds.size === 1) {
      const [winTeamId] = Array.from(aliveTeamIds);
      const winners = participants.filter(
        (p) => (p.teamId || `solo_${p.id}`) === winTeamId
      );
      const rep = alive[0] || winners[0];
      for (const w of winners) placements[w.id] = 1;
      const winnerName =
        teamMode !== 'solo' && winners.length > 1
          ? `Team ${(rep?.teamIndex ?? 0) + 1}: ${winners.map((p) => p.name).join(' & ')}`
          : rep?.name || '';
      return {
        ended: true,
        mode: normalizedMode,
        reason: 'last_standing',
        isDraw: false,
        winnerId: rep?.id || null,
        winnerIds: winners.map((p) => p.id),
        winnerTeamId: winTeamId,
        winnerName,
        teamScores: scores,
        placements,
        timeRemaining: null,
      };
    }
  }

  return {
    ended: false,
    mode: normalizedMode,
    reason: '',
    isDraw: false,
    winnerId: null,
    winnerIds: [],
    winnerTeamId: '',
    winnerName: '',
    teamScores: scores,
    placements,
    timeRemaining: null,
  };
}

function clampStat(val, fallback, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, n));
}
