import {
  AccountCredentialsState,
  BackAccessoryType,
  CosmeticLoadout,
  OutfitPresetId,
  PlayerProgressionState,
} from '../network/schemas';

export interface OutfitPresetDef {
  id: OutfitPresetId;
  name: string;
  tagline: string;
  skinColor: number;
  accentColor: number;
  defaultBackAccessory: BackAccessoryType;
}

export const OUTFIT_PRESETS: OutfitPresetDef[] = [
  {
    id: 'vanguard_blue',
    name: 'CI Vanguard',
    tagline: 'Cobalt alloy plating with sky-plasma visor',
    skinColor: 0x0284c7,
    accentColor: 0x38bdf8,
    defaultBackAccessory: 'jump_pack',
  },
  {
    id: 'solar_phoenix',
    name: 'Solar Phoenix',
    tagline: 'Blaze-forged armor with solar flare optics',
    skinColor: 0xea580c,
    accentColor: 0xfacc15,
    defaultBackAccessory: 'energy_wings',
  },
  {
    id: 'neon_phantom',
    name: 'Neon Phantom',
    tagline: 'Midnight stealth chassis with synth-violet core',
    skinColor: 0x1e1b4b,
    accentColor: 0xc084fc,
    defaultBackAccessory: 'energy_wings',
  },
  {
    id: 'emerald_ranger',
    name: 'Emerald Ranger',
    tagline: 'Canopy recon plate with bio-luminescent visor',
    skinColor: 0x15803d,
    accentColor: 0x4ade80,
    defaultBackAccessory: 'tactical_shield',
  },
  {
    id: 'arctic_sentinel',
    name: 'Arctic Sentinel',
    tagline: 'Zero-kelvin ceramic armor with cryo-cyan trim',
    skinColor: 0xcbd5e1,
    accentColor: 0x22d3ee,
    defaultBackAccessory: 'tactical_shield',
  },
  {
    id: 'crimson_striker',
    name: 'Crimson Striker',
    tagline: 'High-impact ruby exo-suit with rose-laser visor',
    skinColor: 0xbe123c,
    accentColor: 0xfb7185,
    defaultBackAccessory: 'jump_pack',
  },
];

export const ARMOR_COLOR_SWATCHES: Array<{ label: string; hex: number; css: string }> = [
  { label: 'Cobalt', hex: 0x0284c7, css: '#0284c7' },
  { label: 'Blaze', hex: 0xea580c, css: '#ea580c' },
  { label: 'Obsidian', hex: 0x1e1b4b, css: '#1e1b4b' },
  { label: 'Emerald', hex: 0x15803d, css: '#15803d' },
  { label: 'Glacier', hex: 0xcbd5e1, css: '#cbd5e1' },
  { label: 'Crimson', hex: 0xbe123c, css: '#be123c' },
  { label: 'Amethyst', hex: 0x6d28d9, css: '#6d28d9' },
  { label: 'Teal', hex: 0x0f766e, css: '#0f766e' },
];

export const ACCENT_COLOR_SWATCHES: Array<{ label: string; hex: number; css: string }> = [
  { label: 'Sky Cyan', hex: 0x38bdf8, css: '#38bdf8' },
  { label: 'Solar Gold', hex: 0xfacc15, css: '#facc15' },
  { label: 'Synth Violet', hex: 0xc084fc, css: '#c084fc' },
  { label: 'Bio Green', hex: 0x4ade80, css: '#4ade80' },
  { label: 'Cryo Ice', hex: 0x22d3ee, css: '#22d3ee' },
  { label: 'Rose Laser', hex: 0xfb7185, css: '#fb7185' },
  { label: 'Nova Orange', hex: 0xf97316, css: '#f97316' },
  { label: 'Pure White', hex: 0xffffff, css: '#ffffff' },
];

export interface MatchXpBreakdown {
  participationXp: number;
  eliminationXp: number;
  damageXp: number;
  placementXp: number;
  totalEarnedXp: number;
  newLevel: number;
  leveledUp: boolean;
}

const PROGRESSION_STORAGE_KEY = 'cicraft_progression_v2_5';
const COSMETICS_STORAGE_KEY = 'cicraft_cosmetics_v2_5';
const ACCOUNT_CREDENTIALS_KEY = 'cicraft_account_credentials_v2_8';
export const XP_PER_LEVEL = 1000;

export function computeLevelFromXp(xp: number): number {
  return Math.max(1, Math.floor(Math.max(0, xp) / XP_PER_LEVEL) + 1);
}

export function getRankTitleForLevel(level: number): string {
  if (level >= 20) return 'Apex Commander';
  if (level >= 15) return 'Island Champion';
  if (level >= 10) return 'Cyber Vanguard';
  if (level >= 6) return 'Strike Specialist';
  if (level >= 3) return 'Tactical Scout';
  return 'Drop Recruit';
}

export function calculateMatchXp(
  placement: number,
  eliminations: number,
  damageDealt: number,
  isVictory: boolean
): Omit<MatchXpBreakdown, 'newLevel' | 'leveledUp'> {
  const participationXp = 50;
  const eliminationXp = Math.max(0, eliminations) * 100;
  const damageXp = Math.floor(Math.max(0, damageDealt) / 5);
  let placementXp = 0;
  if (isVictory || placement === 1) {
    placementXp = 300;
  } else if (placement <= 3) {
    placementXp = 150;
  } else if (placement <= 5) {
    placementXp = 75;
  }
  const totalEarnedXp =
    participationXp + eliminationXp + damageXp + placementXp;
  return {
    participationXp,
    eliminationXp,
    damageXp,
    placementXp,
    totalEarnedXp,
  };
}

export class ProgressionSystem {
  public state: PlayerProgressionState;
  public cosmetics: CosmeticLoadout;
  public credentials: AccountCredentialsState;

  constructor() {
    this.credentials = this.loadCredentials();
    this.state = this.loadProgression();
    this.cosmetics = this.loadCosmetics();
  }

  public getApiBaseUrl(): string {
    const raw =
      (import.meta as unknown as { env?: Record<string, string> }).env
        ?.VITE_MULTIPLAYER_SERVER_URL || '';
    return raw.trim().replace(/\/+$/, '');
  }

  public loadCredentials(): AccountCredentialsState {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { accountId: '', accountToken: '', passkey: '' };
    }
    try {
      const raw = window.localStorage.getItem(ACCOUNT_CREDENTIALS_KEY);
      if (!raw) return { accountId: '', accountToken: '', passkey: '' };
      const parsed = JSON.parse(raw) as Partial<AccountCredentialsState>;
      return {
        accountId: String(parsed.accountId || ''),
        accountToken: String(parsed.accountToken || ''),
        passkey: String(parsed.passkey || ''),
      };
    } catch {
      return { accountId: '', accountToken: '', passkey: '' };
    }
  }

  public saveCredentials(creds: Partial<AccountCredentialsState>): void {
    Object.assign(this.credentials, creds);
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(
        ACCOUNT_CREDENTIALS_KEY,
        JSON.stringify(this.credentials)
      );
    } catch {
      // Ignore quota errors
    }
  }

  public async initializeServerAccount(callsign?: string): Promise<boolean> {
    if (typeof fetch !== 'function') return false;
    try {
      const res = await fetch(`${this.getApiBaseUrl()}/api/account/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: this.credentials.accountId || undefined,
          accountToken: this.credentials.accountToken || undefined,
          callsign: callsign || this.state.callsign || 'Commander_CI',
          cosmetics: this.cosmetics,
        }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data || !data.ok) return false;

      this.saveCredentials({
        accountId: String(data.accountId || this.credentials.accountId),
        accountToken: String(data.accountToken || this.credentials.accountToken),
        passkey: data.passkey
          ? String(data.passkey)
          : this.credentials.passkey,
      });

      if (data.profile) {
        this.applyServerVerifiedProgression(data.profile, !data.isNew);
      }
      return true;
    } catch {
      return false;
    }
  }

  public async restoreAccountWithPasskey(
    passkeyInput: string
  ): Promise<{ ok: boolean; error?: string; profile?: PlayerProgressionState }> {
    if (typeof fetch !== 'function') {
      return { ok: false, error: 'Network unavailable.' };
    }
    try {
      const res = await fetch(`${this.getApiBaseUrl()}/api/account/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passkey: passkeyInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data || !data.ok) {
        return {
          ok: false,
          error: data?.error || 'Could not verify Passkey.',
        };
      }

      this.saveCredentials({
        accountId: String(data.accountId),
        accountToken: String(data.accountToken),
        passkey: String(data.passkey || passkeyInput.trim()),
      });

      if (data.profile) {
        // Authoritatively overwrite local progression & cosmetics with the restored account
        this.state = this.getDefaultProgression();
        this.applyServerVerifiedProgression(data.profile, true);
      }
      return { ok: true, profile: this.state };
    } catch {
      return { ok: false, error: 'Failed to reach account server.' };
    }
  }

  public async syncCosmeticsToServer(callsign?: string): Promise<void> {
    if (
      typeof fetch !== 'function' ||
      !this.credentials.accountId ||
      !this.credentials.accountToken
    ) {
      return;
    }
    try {
      await fetch(`${this.getApiBaseUrl()}/api/account/cosmetics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: this.credentials.accountId,
          accountToken: this.credentials.accountToken,
          cosmetics: this.cosmetics,
          callsign,
        }),
      });
    } catch {
      // Ignore transient network errors
    }
  }

  private getDefaultProgression(): PlayerProgressionState {
    return {
      matchesPlayed: 0,
      wins: 0,
      eliminations: 0,
      damageDealt: 0,
      bestPlacement: 0,
      xp: 0,
      level: 1,
      storageMode: 'local_only',
    };
  }

  private getDefaultCosmetics(): CosmeticLoadout {
    const def = OUTFIT_PRESETS[0];
    return {
      outfitId: def.id,
      skinColor: def.skinColor,
      accentColor: def.accentColor,
      backAccessory: def.defaultBackAccessory,
    };
  }

  public loadProgression(): PlayerProgressionState {
    if (typeof window === 'undefined' || !window.localStorage) {
      return this.getDefaultProgression();
    }
    try {
      const raw = window.localStorage.getItem(PROGRESSION_STORAGE_KEY);
      if (!raw) return this.getDefaultProgression();
      const parsed = JSON.parse(raw) as Partial<PlayerProgressionState>;
      const xp = Math.max(0, Number(parsed.xp || 0));
      return {
        matchesPlayed: Math.max(0, Number(parsed.matchesPlayed || 0)),
        wins: Math.max(0, Number(parsed.wins || 0)),
        eliminations: Math.max(0, Number(parsed.eliminations || 0)),
        damageDealt: Math.max(0, Number(parsed.damageDealt || 0)),
        bestPlacement: Math.max(0, Number(parsed.bestPlacement || 0)),
        xp,
        level: computeLevelFromXp(xp),
        storageMode:
          parsed.storageMode === 'server_verified'
            ? 'server_verified'
            : 'local_only',
      };
    } catch {
      return this.getDefaultProgression();
    }
  }

  public saveProgression(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(
        PROGRESSION_STORAGE_KEY,
        JSON.stringify(this.state)
      );
    } catch {
      // Ignore quota errors
    }
  }

  public loadCosmetics(): CosmeticLoadout {
    if (typeof window === 'undefined' || !window.localStorage) {
      return this.getDefaultCosmetics();
    }
    try {
      const raw = window.localStorage.getItem(COSMETICS_STORAGE_KEY);
      if (!raw) return this.getDefaultCosmetics();
      const parsed = JSON.parse(raw) as Partial<CosmeticLoadout>;
      const validOutfit =
        OUTFIT_PRESETS.find((o) => o.id === parsed.outfitId) || OUTFIT_PRESETS[0];
      const validBack: BackAccessoryType =
        parsed.backAccessory === 'jump_pack' ||
        parsed.backAccessory === 'energy_wings' ||
        parsed.backAccessory === 'tactical_shield' ||
        parsed.backAccessory === 'none'
          ? parsed.backAccessory
          : validOutfit.defaultBackAccessory;

      return {
        outfitId: validOutfit.id,
        skinColor:
          typeof parsed.skinColor === 'number'
            ? parsed.skinColor
            : validOutfit.skinColor,
        accentColor:
          typeof parsed.accentColor === 'number'
            ? parsed.accentColor
            : validOutfit.accentColor,
        backAccessory: validBack,
      };
    } catch {
      return this.getDefaultCosmetics();
    }
  }

  public saveCosmetics(update: Partial<CosmeticLoadout>): CosmeticLoadout {
    Object.assign(this.cosmetics, update);
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(
          COSMETICS_STORAGE_KEY,
          JSON.stringify(this.cosmetics)
        );
      } catch {
        // Ignore quota errors
      }
    }
    void this.syncCosmeticsToServer();
    return this.cosmetics;
  }

  public selectOutfitPreset(outfitId: OutfitPresetId): CosmeticLoadout {
    const preset =
      OUTFIT_PRESETS.find((o) => o.id === outfitId) || OUTFIT_PRESETS[0];
    return this.saveCosmetics({
      outfitId: preset.id,
      skinColor: preset.skinColor,
      accentColor: preset.accentColor,
      backAccessory: preset.defaultBackAccessory,
    });
  }

  public applyOutfitPreset(outfitId: OutfitPresetId): CosmeticLoadout {
    return this.selectOutfitPreset(outfitId);
  }

  public getRankTitle(): string {
    return getRankTitleForLevel(this.state.level);
  }

  public getCurrentLevelProgressRatio(): number {
    return (this.state.xp % XP_PER_LEVEL) / XP_PER_LEVEL;
  }

  /**
   * Records a verified Solo/Local engine match result and computes XP.
   * For online multiplayer matches, server-verified progression is authoritative.
   */
  public recordVerifiedMatchResult(
    placement: number,
    eliminations: number,
    damageDealt: number,
    isVictory: boolean,
    isServerVerified: boolean = false
  ): MatchXpBreakdown {
    const prevLevel = this.state.level;
    const xpCalc = calculateMatchXp(
      placement,
      eliminations,
      damageDealt,
      isVictory
    );

    this.state.matchesPlayed += 1;
    if (isVictory || placement === 1) {
      this.state.wins += 1;
    }
    this.state.eliminations += Math.max(0, eliminations);
    this.state.damageDealt += Math.max(0, Math.round(damageDealt));
    if (
      placement > 0 &&
      (this.state.bestPlacement === 0 || placement < this.state.bestPlacement)
    ) {
      this.state.bestPlacement = placement;
    }
    this.state.xp += xpCalc.totalEarnedXp;
    this.state.level = computeLevelFromXp(this.state.xp);
    if (isServerVerified) {
      this.state.storageMode = 'server_verified';
    }

    this.saveProgression();

    return {
      ...xpCalc,
      newLevel: this.state.level,
      leveledUp: this.state.level > prevLevel,
    };
  }

  /**
   * Synchronizes authoritative progression computed by the multiplayer room server.
   */
  public applyServerVerifiedProgression(
    serverProfile: Partial<PlayerProgressionState>,
    applyServerCosmetics: boolean = false
  ): void {
    if (typeof serverProfile.accountId === 'string' && serverProfile.accountId) {
      this.state.accountId = serverProfile.accountId;
    }
    if (typeof serverProfile.callsign === 'string' && serverProfile.callsign) {
      this.state.callsign = serverProfile.callsign;
    }
    if (typeof serverProfile.persistenceBackend === 'string') {
      this.state.persistenceBackend = serverProfile.persistenceBackend;
    }
    if (typeof serverProfile.matchesPlayed === 'number') {
      this.state.matchesPlayed = Math.max(
        this.state.matchesPlayed,
        serverProfile.matchesPlayed
      );
    }
    if (typeof serverProfile.wins === 'number') {
      this.state.wins = Math.max(this.state.wins, serverProfile.wins);
    }
    if (typeof serverProfile.eliminations === 'number') {
      this.state.eliminations = Math.max(
        this.state.eliminations,
        serverProfile.eliminations
      );
    }
    if (typeof serverProfile.damageDealt === 'number') {
      this.state.damageDealt = Math.max(
        this.state.damageDealt,
        serverProfile.damageDealt
      );
    }
    if (
      typeof serverProfile.bestPlacement === 'number' &&
      serverProfile.bestPlacement > 0
    ) {
      this.state.bestPlacement =
        this.state.bestPlacement === 0
          ? serverProfile.bestPlacement
          : Math.min(this.state.bestPlacement, serverProfile.bestPlacement);
    }
    if (typeof serverProfile.xp === 'number') {
      this.state.xp = Math.max(this.state.xp, serverProfile.xp);
      this.state.level = computeLevelFromXp(this.state.xp);
    }
    if (Array.isArray(serverProfile.unlockedOutfits)) {
      this.state.unlockedOutfits = serverProfile.unlockedOutfits;
    }
    if (applyServerCosmetics && serverProfile.cosmetics) {
      Object.assign(this.cosmetics, serverProfile.cosmetics);
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          window.localStorage.setItem(
            COSMETICS_STORAGE_KEY,
            JSON.stringify(this.cosmetics)
          );
        } catch {
          // Ignore quota errors
        }
      }
    }
    this.state.storageMode = 'server_verified';
    this.saveProgression();
  }
}
