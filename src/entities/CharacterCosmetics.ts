import type { OutfitPresetId } from '../network/schemas';

export type OutfitArmorStyle =
  | 'vanguard'
  | 'solar'
  | 'phantom'
  | 'ranger'
  | 'arctic'
  | 'crimson';

export interface OutfitVisualProfile {
  id: OutfitPresetId;
  armorStyle: OutfitArmorStyle;
  rarityStyle: 'rare' | 'epic' | 'legendary';
  finishLabel: string;
  silhouetteLabel: string;
  roughness: number;
  metalness: number;
  envMapIntensity: number;
  visorEmissiveIntensity: number;
}

export const OUTFIT_VISUAL_PROFILES: Record<OutfitPresetId, OutfitVisualProfile> = {
  vanguard_blue: {
    id: 'vanguard_blue',
    armorStyle: 'vanguard',
    rarityStyle: 'rare',
    finishLabel: 'Satin cobalt alloy',
    silhouetteLabel: 'Balanced pauldrons · chevron chest core',
    roughness: 0.32,
    metalness: 0.38,
    envMapIntensity: 0.85,
    visorEmissiveIntensity: 0.72,
  },
  solar_phoenix: {
    id: 'solar_phoenix',
    armorStyle: 'solar',
    rarityStyle: 'legendary',
    finishLabel: 'Polished blaze ceramic',
    silhouetteLabel: 'Solar crest · swept shoulder wings',
    roughness: 0.22,
    metalness: 0.5,
    envMapIntensity: 1.05,
    visorEmissiveIntensity: 0.86,
  },
  neon_phantom: {
    id: 'neon_phantom',
    armorStyle: 'phantom',
    rarityStyle: 'epic',
    finishLabel: 'Matte midnight composite',
    silhouetteLabel: 'Slim blades · diamond core · sensor antennae',
    roughness: 0.56,
    metalness: 0.16,
    envMapIntensity: 0.55,
    visorEmissiveIntensity: 0.96,
  },
  emerald_ranger: {
    id: 'emerald_ranger',
    armorStyle: 'ranger',
    rarityStyle: 'rare',
    finishLabel: 'Rugged canopy plate',
    silhouetteLabel: 'Recon pauldron · field strap and pouches',
    roughness: 0.62,
    metalness: 0.08,
    envMapIntensity: 0.5,
    visorEmissiveIntensity: 0.66,
  },
  arctic_sentinel: {
    id: 'arctic_sentinel',
    armorStyle: 'arctic',
    rarityStyle: 'epic',
    finishLabel: 'Glacier ceramic',
    silhouetteLabel: 'Broad collar · squared sentinel plates',
    roughness: 0.28,
    metalness: 0.14,
    envMapIntensity: 0.9,
    visorEmissiveIntensity: 0.68,
  },
  crimson_striker: {
    id: 'crimson_striker',
    armorStyle: 'crimson',
    rarityStyle: 'legendary',
    finishLabel: 'Gloss striker exo-plate',
    silhouetteLabel: 'Asymmetric pauldron · slash core · crest fin',
    roughness: 0.25,
    metalness: 0.42,
    envMapIntensity: 0.95,
    visorEmissiveIntensity: 0.8,
  },
};

export const OUTFIT_PRESET_IDS = Object.keys(
  OUTFIT_VISUAL_PROFILES
) as OutfitPresetId[];

export function normalizeOutfitPresetId(value: unknown): OutfitPresetId {
  return typeof value === 'string' && Object.hasOwn(OUTFIT_VISUAL_PROFILES, value)
    ? (value as OutfitPresetId)
    : 'vanguard_blue';
}

export function getOutfitVisualProfile(
  outfitId: OutfitPresetId | undefined
): OutfitVisualProfile {
  return OUTFIT_VISUAL_PROFILES[normalizeOutfitPresetId(outfitId)];
}
