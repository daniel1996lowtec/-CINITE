import * as THREE from 'three';
import { AmmoType, WeaponCategory, WeaponRarity } from '../network/schemas';

export type WeaponFireMode = 'melee' | 'semi' | 'auto' | 'burst' | 'consumable';

export interface WeaponStats {
  id: string;
  name: string;
  category: WeaponCategory;
  rarity: WeaponRarity;
  fireMode: WeaponFireMode;
  /** Number of individual shots in one burst trigger pull. */
  burstCount?: number;
  /** Delay between shots inside a burst; fireRate is bursts per second. */
  burstIntervalSeconds?: number;
  tracerColor: number;
  baseDamage: number;
  headshotMultiplier: number;
  fireRate: number;
  clipSize: number;
  reloadTime: number;
  ammoType: AmmoType;
  pellets: number;
  spreadRad: number;
  adsSpreadMultiplier: number;
  adsFov: number;
  recoilPitch: number;
  recoilYaw: number;
  range: number;
  isAutomatic: boolean;
  isConsumable: boolean;
  healAmount?: number;
  shieldAmount?: number;
  consumeTime?: number;
}

export const RARITY_COLORS: Record<
  WeaponRarity,
  { hex: string; int: number; label: string; damageMult: number }
> = {
  common: { hex: '#94a3b8', int: 0x94a3b8, label: 'Common', damageMult: 1.0 },
  uncommon: { hex: '#22c55e', int: 0x22c55e, label: 'Uncommon', damageMult: 1.08 },
  rare: { hex: '#38bdf8', int: 0x38bdf8, label: 'Rare', damageMult: 1.16 },
  epic: { hex: '#c084fc', int: 0xc084fc, label: 'Epic', damageMult: 1.25 },
  legendary: { hex: '#fbbf24', int: 0xfbbf24, label: 'Legendary', damageMult: 1.35 },
};

export interface WeaponVisualProfile {
  icon: string;
  role: string;
  silhouette: string;
  modelLength: number;
  magazineStyle: 'box' | 'curved' | 'drum' | 'tube' | 'cylinder' | 'none';
  reloadMotion: 'magazine' | 'cylinder' | 'pump' | 'bolt' | 'slide' | 'none';
}

export const WEAPON_VISUAL_PROFILES: Record<WeaponCategory, WeaponVisualProfile> = {
  harvester: {
    icon: '⛏️',
    role: 'Harvest & melee',
    silhouette: 'Energy pickaxe',
    modelLength: 0.98,
    magazineStyle: 'none',
    reloadMotion: 'none',
  },
  pistol: {
    icon: '⌐',
    role: 'Reliable sidearm',
    silhouette: 'Compact slide pistol',
    modelLength: 0.36,
    magazineStyle: 'box',
    reloadMotion: 'slide',
  },
  heavy_pistol: {
    icon: '◉',
    role: 'Hand-cannon backup',
    silhouette: 'Long-barrel revolver cannon',
    modelLength: 0.6,
    magazineStyle: 'cylinder',
    reloadMotion: 'cylinder',
  },
  assault_rifle: {
    icon: '▰',
    role: 'Versatile automatic rifle',
    silhouette: 'Holo-sighted pulse carbine',
    modelLength: 0.86,
    magazineStyle: 'curved',
    reloadMotion: 'magazine',
  },
  burst_rifle: {
    icon: '⋮',
    role: 'Three-round burst control',
    silhouette: 'Tri-rail burst rifle',
    modelLength: 0.92,
    magazineStyle: 'curved',
    reloadMotion: 'magazine',
  },
  dmr: {
    icon: '◎',
    role: 'Semi-auto precision',
    silhouette: 'Long-handguard marksman rifle',
    modelLength: 1.04,
    magazineStyle: 'box',
    reloadMotion: 'bolt',
  },
  shotgun: {
    icon: '✸',
    role: 'Pump-action breacher',
    silhouette: 'Tube-fed scatter pump',
    modelLength: 0.82,
    magazineStyle: 'tube',
    reloadMotion: 'pump',
  },
  tactical_shotgun: {
    icon: '✦',
    role: 'Rapid tactical shotgun',
    silhouette: 'Box-fed heat-shield shotgun',
    modelLength: 0.82,
    magazineStyle: 'box',
    reloadMotion: 'magazine',
  },
  smg: {
    icon: '⚡',
    role: 'Close-range bullet hose',
    silhouette: 'Drum-fed compact SMG',
    modelLength: 0.58,
    magazineStyle: 'drum',
    reloadMotion: 'magazine',
  },
  sniper: {
    icon: '⌖',
    role: 'Long-range rail precision',
    silhouette: 'Scoped rail sniper',
    modelLength: 1.18,
    magazineStyle: 'box',
    reloadMotion: 'bolt',
  },
  medkit: {
    icon: '✚',
    role: 'Restore 50 health',
    silhouette: 'Nano medkit',
    modelLength: 0.38,
    magazineStyle: 'none',
    reloadMotion: 'none',
  },
  shield_potion: {
    icon: '⬡',
    role: 'Restore 50 shield',
    silhouette: 'Shield flask',
    modelLength: 0.36,
    magazineStyle: 'none',
    reloadMotion: 'none',
  },
};

export function getWeaponVisualProfile(
  category: WeaponCategory
): WeaponVisualProfile {
  return WEAPON_VISUAL_PROFILES[category];
}

const SUPPORT_GRIPS: Partial<Record<WeaponCategory, readonly [number,number,number]>> = {
  assault_rifle:[0,.015,-.32], burst_rifle:[0,.015,-.34], dmr:[0,.015,-.4],
  shotgun:[0,.015,-.42], tactical_shotgun:[0,-.045,-.5], smg:[0,-.05,-.36], sniper:[0,.015,-.42],
};
const SIDEARM_GRIP: readonly [number,number,number] = [0,-.035,.015];
export function getSupportGrip(category: WeaponCategory): readonly [number,number,number] {
  return SUPPORT_GRIPS[category] || SIDEARM_GRIP;
}

export const FIREARM_CATEGORIES = [
  'pistol',
  'heavy_pistol',
  'assault_rifle',
  'burst_rifle',
  'dmr',
  'shotgun',
  'tactical_shotgun',
  'smg',
  'sniper',
] as const satisfies readonly WeaponCategory[];

/** Per-pellet damage used by both the local simulation and mirrored by the server catalog. */
export function calculateWeaponDamage(stats: WeaponStats, isHeadshot: boolean): number {
  return Math.round(stats.baseDamage * (isHeadshot ? stats.headshotMultiplier : 1));
}

export function createWeaponStats(
  category: WeaponCategory,
  rarity: WeaponRarity = 'common'
): WeaponStats {
  const mult = RARITY_COLORS[rarity].damageMult;
  const rarityPrefix = RARITY_COLORS[rarity].label;

  switch (category) {
    case 'harvester':
      return {
        id: `harvester_${rarity}`,
        name: 'CI Harvester',
        category: 'harvester',
        rarity: 'rare',
        fireMode: 'melee',
        tracerColor: 0x38bdf8,
        baseDamage: 35,
        headshotMultiplier: 1.2,
        fireRate: 1.9,
        clipSize: 999,
        reloadTime: 0,
        ammoType: 'none',
        pellets: 1,
        spreadRad: 0,
        adsSpreadMultiplier: 1,
        adsFov: 62,
        recoilPitch: 0,
        recoilYaw: 0,
        range: 4.6,
        isAutomatic: true,
        isConsumable: false,
      };

    case 'pistol':
      return {
        id: `pistol_${rarity}`,
        name: `${rarityPrefix} Cyber Pistol`,
        category: 'pistol',
        rarity,
        fireMode: 'semi',
        tracerColor: 0xfef08a,
        baseDamage: Math.round(22 * mult),
        headshotMultiplier: 1.75,
        fireRate: 6.2,
        clipSize: 15,
        reloadTime: Math.max(0.95, 1.35 - (mult - 1) * 0.7),
        ammoType: 'light',
        pellets: 1,
        spreadRad: 0.016,
        adsSpreadMultiplier: 0.28,
        adsFov: 52,
        recoilPitch: 0.016,
        recoilYaw: 0.005,
        range: 125,
        isAutomatic: false,
        isConsumable: false,
      };

    case 'assault_rifle':
      return {
        id: `assault_rifle_${rarity}`,
        name: `${rarityPrefix} Pulse Rifle`,
        category: 'assault_rifle',
        rarity,
        fireMode: 'auto',
        tracerColor: 0xfef08a,
        baseDamage: Math.round(24 * mult),
        headshotMultiplier: 1.6,
        fireRate: 5.8,
        clipSize: 30,
        reloadTime: Math.max(1.4, 2.1 - (mult - 1) * 1.1),
        ammoType: 'medium',
        pellets: 1,
        spreadRad: 0.021,
        adsSpreadMultiplier: 0.32,
        adsFov: 44,
        recoilPitch: 0.014,
        recoilYaw: 0.006,
        range: 190,
        isAutomatic: true,
        isConsumable: false,
      };

    case 'shotgun':
      return {
        id: `shotgun_${rarity}`,
        name: `${rarityPrefix} Scatter Pump`,
        category: 'shotgun',
        rarity,
        fireMode: 'semi',
        tracerColor: 0xfb923c,
        baseDamage: Math.round(11 * mult),
        headshotMultiplier: 1.5,
        fireRate: 1.25,
        clipSize: 8,
        reloadTime: Math.max(1.8, 2.5 - (mult - 1) * 1.2),
        ammoType: 'shells',
        pellets: 8,
        spreadRad: 0.066,
        adsSpreadMultiplier: 0.62,
        adsFov: 52,
        recoilPitch: 0.042,
        recoilYaw: 0.015,
        range: 46,
        isAutomatic: false,
        isConsumable: false,
      };

    case 'smg':
      return {
        id: `smg_${rarity}`,
        name: `${rarityPrefix} Hyper SMG`,
        category: 'smg',
        rarity,
        fireMode: 'auto',
        tracerColor: 0xfde68a,
        baseDamage: Math.round(16 * mult),
        headshotMultiplier: 1.5,
        fireRate: 10.5,
        clipSize: 35,
        reloadTime: Math.max(1.2, 1.8 - (mult - 1) * 1.0),
        ammoType: 'light',
        pellets: 1,
        spreadRad: 0.035,
        adsSpreadMultiplier: 0.48,
        adsFov: 50,
        recoilPitch: 0.01,
        recoilYaw: 0.008,
        range: 95,
        isAutomatic: true,
        isConsumable: false,
      };

    case 'sniper':
      return {
        id: `sniper_${rarity}`,
        name: `${rarityPrefix} Rail Sniper`,
        category: 'sniper',
        rarity,
        fireMode: 'semi',
        tracerColor: 0x38bdf8,
        baseDamage: Math.round(84 * mult),
        headshotMultiplier: 2.0,
        fireRate: 0.75,
        clipSize: 5,
        reloadTime: Math.max(2.0, 2.7 - (mult - 1) * 1.0),
        ammoType: 'heavy',
        pellets: 1,
        spreadRad: 0.006,
        adsSpreadMultiplier: 0.05,
        adsFov: 25,
        recoilPitch: 0.058,
        recoilYaw: 0.01,
        range: 340,
        isAutomatic: false,
        isConsumable: false,
      };

    case 'heavy_pistol':
      return {
        id: `heavy_pistol_${rarity}`,
        name: `${rarityPrefix} Rhino Hand Cannon`,
        category: 'heavy_pistol',
        rarity,
        fireMode: 'semi',
        tracerColor: 0xfda4af,
        baseDamage: Math.round(40 * mult),
        headshotMultiplier: 2.0,
        fireRate: 2.2,
        clipSize: 7,
        reloadTime: Math.max(1.35, 1.85 - (mult - 1) * 1.0),
        ammoType: 'heavy',
        pellets: 1,
        spreadRad: 0.012,
        adsSpreadMultiplier: 0.22,
        adsFov: 48,
        recoilPitch: 0.034,
        recoilYaw: 0.01,
        range: 145,
        isAutomatic: false,
        isConsumable: false,
      };

    case 'burst_rifle':
      return {
        id: `burst_rifle_${rarity}`,
        name: `${rarityPrefix} Triad Burst Rifle`,
        category: 'burst_rifle',
        rarity,
        fireMode: 'burst',
        burstCount: 3,
        burstIntervalSeconds: 0.075,
        tracerColor: 0xa5f3fc,
        baseDamage: Math.round(24 * mult),
        headshotMultiplier: 1.65,
        // Bursts per second. PlayerController schedules the three shots
        // inside each burst at burstIntervalSeconds.
        fireRate: 1.65,
        clipSize: 36,
        reloadTime: Math.max(1.7, 2.25 - (mult - 1) * 1.1),
        ammoType: 'medium',
        pellets: 1,
        spreadRad: 0.017,
        adsSpreadMultiplier: 0.24,
        adsFov: 42,
        recoilPitch: 0.012,
        recoilYaw: 0.004,
        range: 205,
        isAutomatic: false,
        isConsumable: false,
      };

    case 'dmr':
      return {
        id: `dmr_${rarity}`,
        name: `${rarityPrefix} Longbow DMR`,
        category: 'dmr',
        rarity,
        fireMode: 'semi',
        tracerColor: 0x93c5fd,
        baseDamage: Math.round(42 * mult),
        headshotMultiplier: 1.85,
        fireRate: 2.4,
        clipSize: 12,
        reloadTime: Math.max(1.8, 2.35 - (mult - 1) * 1.0),
        ammoType: 'medium',
        pellets: 1,
        spreadRad: 0.009,
        adsSpreadMultiplier: 0.08,
        adsFov: 32,
        recoilPitch: 0.028,
        recoilYaw: 0.006,
        range: 275,
        isAutomatic: false,
        isConsumable: false,
      };

    case 'tactical_shotgun':
      return {
        id: `tactical_shotgun_${rarity}`,
        name: `${rarityPrefix} Vector Tactical Shotgun`,
        category: 'tactical_shotgun',
        rarity,
        fireMode: 'auto',
        tracerColor: 0xfdba74,
        baseDamage: Math.round(8 * mult),
        headshotMultiplier: 1.45,
        fireRate: 2.1,
        clipSize: 10,
        reloadTime: Math.max(2.0, 2.7 - (mult - 1) * 1.2),
        ammoType: 'shells',
        pellets: 8,
        spreadRad: 0.05,
        adsSpreadMultiplier: 0.52,
        adsFov: 50,
        recoilPitch: 0.03,
        recoilYaw: 0.01,
        range: 52,
        isAutomatic: true,
        isConsumable: false,
      };

    case 'shield_potion':
      return {
        id: 'shield_potion_rare',
        name: 'Shield Potion (+50)',
        category: 'shield_potion',
        rarity: 'rare',
        fireMode: 'consumable',
        tracerColor: 0x38bdf8,
        baseDamage: 0,
        headshotMultiplier: 1,
        fireRate: 1,
        clipSize: 1,
        reloadTime: 0,
        ammoType: 'none',
        pellets: 0,
        spreadRad: 0,
        adsSpreadMultiplier: 1,
        adsFov: 60,
        recoilPitch: 0,
        recoilYaw: 0,
        range: 0,
        isAutomatic: false,
        isConsumable: true,
        shieldAmount: 50,
        consumeTime: 1.5,
      };

    case 'medkit':
      return {
        id: 'medkit_uncommon',
        name: 'Nano Medkit (+50)',
        category: 'medkit',
        rarity: 'uncommon',
        fireMode: 'consumable',
        tracerColor: 0x4ade80,
        baseDamage: 0,
        headshotMultiplier: 1,
        fireRate: 1,
        clipSize: 1,
        reloadTime: 0,
        ammoType: 'none',
        pellets: 0,
        spreadRad: 0,
        adsSpreadMultiplier: 1,
        adsFov: 60,
        recoilPitch: 0,
        recoilYaw: 0,
        range: 0,
        isAutomatic: false,
        isConsumable: true,
        healAmount: 50,
        consumeTime: 1.8,
      };
  }
}

const weaponTemplateCache = new Map<string, THREE.Group>();
const SHARED_WEAPON_DARK_MAT = new THREE.MeshStandardMaterial({
  color: 0x1e293b,
  roughness: 0.72,
  metalness: 0.12,
  flatShading: true,
});
const SHARED_WEAPON_GUNMETAL_MAT = new THREE.MeshStandardMaterial({
  color: 0x475569,
  roughness: 0.32,
  metalness: 0.82,
  envMapIntensity: 1.15,
  flatShading: true,
});

function makeRarityAccentMaterial(rarity: WeaponRarity): THREE.MeshStandardMaterial {
  const color = RARITY_COLORS[rarity].int;
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: rarity === 'legendary' ? 0.26 : rarity === 'epic' ? 0.2 : 0.12,
    roughness: rarity === 'legendary' ? 0.16 : 0.22,
    metalness: rarity === 'legendary' ? 0.46 : 0.28,
    envMapIntensity: rarity === 'legendary' ? 1.15 : 0.85,
    flatShading: true,
  });
}

const SHARED_RARITY_ACCENT_MATS: Record<WeaponRarity, THREE.MeshStandardMaterial> = {
  common: makeRarityAccentMaterial('common'),
  uncommon: makeRarityAccentMaterial('uncommon'),
  rare: makeRarityAccentMaterial('rare'),
  epic: makeRarityAccentMaterial('epic'),
  legendary: makeRarityAccentMaterial('legendary'),
};

const SHARED_UNIT_BOX_GEO = new THREE.BoxGeometry(1, 1, 1);
const SHARED_UNIT_CYLINDER_GEO = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
const SHARED_UNIT_CONE_GEO = new THREE.ConeGeometry(0.5, 1, 8);

function sharedBoxMesh(
  material: THREE.Material,
  sx: number,
  sy: number,
  sz: number,
  name?: string
): THREE.Mesh {
  const mesh = new THREE.Mesh(SHARED_UNIT_BOX_GEO, material);
  mesh.scale.set(sx, sy, sz);
  if (name) mesh.name = name;
  return mesh;
}

function sharedCylinderMesh(
  material: THREE.Material,
  radius: number,
  length: number,
  name?: string
): THREE.Mesh {
  const mesh = new THREE.Mesh(SHARED_UNIT_CYLINDER_GEO, material);
  mesh.scale.set(radius * 2, length, radius * 2);
  if (name) mesh.name = name;
  return mesh;
}

function addFirearmFinish(group: THREE.Group, category: WeaponCategory): void {
  const muzzle = group.getObjectByName('muzzle_tip');
  if (!muzzle) return;
  const details = new THREE.Group(); details.name = 'weapon_micro_details';
  // An inset bore and receiver pin sharpen the silhouette without more lights,
  // transparent layers or per-weapon unique geometry. Hide these at distance.
  const bore = sharedCylinderMesh(SHARED_WEAPON_DARK_MAT,
    category === 'shotgun' || category === 'tactical_shotgun' ? .033 : .019, .016, 'muzzle_bore');
  bore.rotation.x = Math.PI/2;
  bore.position.copy(muzzle.position); bore.position.z -= .005;
  const pin = sharedCylinderMesh(SHARED_WEAPON_GUNMETAL_MAT,.014,.018,'receiver_pin');
  pin.rotation.z = Math.PI/2; pin.position.set(.065,.06,-.17);
  details.add(bore,pin); group.add(details);
}

export function createWeaponMesh(
  category: WeaponCategory,
  rarity: WeaponRarity = 'common'
): THREE.Group {
  const cacheKey = `${category}_${rarity}`;
  const cached = weaponTemplateCache.get(cacheKey);
  if (cached) {
    return cached.clone(true);
  }

  const group = new THREE.Group();

  const darkMat = SHARED_WEAPON_DARK_MAT;
  const gunmetalMat = SHARED_WEAPON_GUNMETAL_MAT;
  const accentMat = SHARED_RARITY_ACCENT_MATS[rarity];

  if (category === 'harvester') {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.042, 0.98, 6), darkMat);
    shaft.position.set(0, 0.36, 0);
    group.add(shaft);

    const headMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.5,
      roughness: 0.2,
      flatShading: true,
    });
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.13, 0.08), headMat);
    blade.position.set(0, 0.84, 0.05);
    blade.rotation.y = Math.PI / 2;

    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.26, 4), headMat);
    spike.rotation.x = Math.PI / 2;
    spike.position.set(0, 0.84, 0.38);

    group.add(blade, spike);
    weaponTemplateCache.set(cacheKey, group);
    return group.clone(true);
  }

  if (category === 'shield_potion') {
    const flaskMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0ea5e9,
      emissiveIntensity: 0.45,
      roughness: 0.2,
      flatShading: true,
    });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.36, 8), flaskMat);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.14, 8), darkMat);
    neck.position.y = 0.22;
    group.add(body, neck);
    weaponTemplateCache.set(cacheKey, group);
    return group.clone(true);
  }

  if (category === 'medkit') {
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0xef4444,
      roughness: 0.4,
      flatShading: true,
    });
    const crossMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.25,
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.26, 0.22), boxMat);
    const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.06, 0.24), crossMat);
    const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.24), crossMat);
    group.add(box, crossH, crossV);
    weaponTemplateCache.set(cacheKey, group);
    return group.clone(true);
  }

  if (category === 'pistol' || category === 'heavy_pistol') {
    // Compact Cyber Sidearm / Rhino Hand Cannon
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.36), gunmetalMat);
    slide.position.set(0, 0.08, -0.16);
    slide.userData.baseZ = -0.16;
    slide.name = 'weapon_slide';
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.03, 0.32), accentMat);
    stripe.position.set(0, 0.14, -0.16);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.1), darkMat);
    grip.position.set(0, -0.04, -0.03);
    grip.rotation.x = -0.22;
    const pistolMag = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.18, 0.08), accentMat);
    pistolMag.position.set(0, -0.06, -0.03);
    pistolMag.rotation.x = -0.22;
    pistolMag.name = 'weapon_mag';
    pistolMag.userData.baseY = -0.06;
    pistolMag.userData.baseZ = -0.03;
    const frameRail = sharedBoxMesh(darkMat, 0.055, 0.035, 0.2);
    frameRail.position.set(0, 0.005, -0.24);
    const rearSight = sharedBoxMesh(accentMat, 0.055, 0.045, 0.045);
    rearSight.position.set(0, 0.16, -0.015);
    const pistolBarrel = sharedCylinderMesh(gunmetalMat, 0.026, 0.18);
    pistolBarrel.rotation.x = Math.PI / 2;
    pistolBarrel.position.set(0, 0.08, -0.34);
    const triggerGuard = sharedBoxMesh(darkMat, 0.024, 0.07, 0.13);
    triggerGuard.position.set(0, -0.015, -0.14);
    const hammer = sharedBoxMesh(gunmetalMat, 0.045, 0.06, 0.04);
    hammer.position.set(0, 0.1, 0.035);
    hammer.rotation.x = 0.35;
    const gripPanel = sharedBoxMesh(accentMat, 0.086, 0.11, 0.055);
    gripPanel.position.set(0, -0.045, -0.028);
    gripPanel.rotation.x = -0.22;
    group.add(frameRail, rearSight, pistolBarrel, triggerGuard, hammer, gripPanel);
    const muzzleAnchor = new THREE.Object3D();
    muzzleAnchor.name = 'muzzle_tip';
    muzzleAnchor.position.set(0, 0.08, -0.36);
    if (category === 'heavy_pistol') {
      slide.scale.set(1.28, 1.32, 1.42);
      stripe.scale.set(1.18, 1.2, 1.42);
      grip.scale.set(1.18, 1.12, 1.18);
      pistolMag.visible = false;
      pistolMag.name = 'weapon_mag_inactive';
      const heavyBarrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.043, 0.043, 0.34, 10),
        gunmetalMat
      );
      heavyBarrel.rotation.x = Math.PI / 2;
      heavyBarrel.position.set(0, 0.085, -0.42);
      const cylinder = new THREE.Mesh(
        new THREE.CylinderGeometry(0.082, 0.082, 0.15, 12),
        accentMat
      );
      cylinder.rotation.x = Math.PI / 2;
      cylinder.position.set(0, 0.045, -0.16);
      cylinder.name = 'weapon_mag';
      cylinder.userData.baseY = 0.045;
      cylinder.userData.baseZ = -0.16;
      const topRib = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.48), accentMat);
      topRib.position.set(0, 0.17, -0.29);
      muzzleAnchor.position.set(0, 0.085, -0.6);
      group.add(heavyBarrel, cylinder, topRib);
    }
    group.add(slide, stripe, grip, pistolMag, muzzleAnchor);
    addFirearmFinish(group,category);
    weaponTemplateCache.set(cacheKey, group);
    return group.clone(true);
  }

  // Long firearms share receiver/barrel construction, then diverge below.
  const length =
    category === 'sniper'
      ? 1.18
      : category === 'dmr'
        ? 1.04
        : category === 'burst_rifle'
          ? 0.92
          : category === 'assault_rifle'
            ? 0.86
            : category === 'shotgun' || category === 'tactical_shotgun'
              ? 0.82
              : 0.58;

  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.15, length * 0.65), darkMat);
  receiver.position.set(0, 0.05, -length * 0.28);
  group.add(receiver);

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.032, length * 0.48, 8),
    gunmetalMat
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.065, -length * 0.72);
  group.add(barrel);

  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.24), darkMat);
  stock.position.set(0, 0.02, 0.06);
  group.add(stock);

  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.04, length * 0.6), accentMat);
  stripe.position.set(0, 0.13, -length * 0.28);
  group.add(stripe);

  if (category !== 'shotgun') {
    const boltCarrier = new THREE.Mesh(
      new THREE.BoxGeometry(0.125, 0.045, 0.16),
      gunmetalMat
    );
    boltCarrier.position.set(0, 0.09, -length * 0.24);
    boltCarrier.userData.baseZ = -length * 0.24;
    boltCarrier.name = 'weapon_slide';
    group.add(boltCarrier);
  }

  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.23, 0.11), accentMat);
  mag.position.set(0, -0.09, -length * 0.32);
  mag.rotation.x = 0.22;
  mag.name = 'weapon_mag';
  mag.userData.baseY = -0.09;
  mag.userData.baseZ = -length * 0.32;
  group.add(mag);

  const topRail = sharedBoxMesh(gunmetalMat, 0.075, 0.035, length * 0.46);
  topRail.position.set(0, 0.155, -length * 0.34);
  const ejectionPort = sharedBoxMesh(accentMat, 0.018, 0.055, 0.13);
  ejectionPort.position.set(0.058, 0.075, -length * 0.26);
  const chargingHandle = sharedBoxMesh(darkMat, 0.09, 0.045, 0.07);
  chargingHandle.position.set(0, 0.105, -0.015);
  const triggerGuard = sharedBoxMesh(darkMat, 0.026, 0.075, 0.18);
  triggerGuard.position.set(0, -0.035, -length * 0.2);
  group.add(topRail, ejectionPort, chargingHandle, triggerGuard);
  if (category !== 'assault_rifle') {
    const pistolGrip = sharedBoxMesh(darkMat, 0.07, 0.16, 0.08);
    pistolGrip.position.set(0, -0.06, -0.08);
    pistolGrip.rotation.x = -0.25;
    group.add(pistolGrip);
  }
  if (category === 'shotgun' || category === 'smg') {
    // Their archetype branches below provide the visible tube/drum feed.
    mag.visible = false;
    mag.name = 'weapon_mag_inactive';
  }

  if (category === 'sniper') {
    const scopeMountF = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.05), darkMat);
    scopeMountF.position.set(0, 0.15, -0.44);
    const scopeMountR = scopeMountF.clone();
    scopeMountR.position.z = -0.2;
    const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.046, 0.44, 10), gunmetalMat);
    scope.rotation.x = Math.PI / 2;
    scope.position.set(0, 0.21, -0.32);
    const scopeLens = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.044, 0.02, 10), accentMat);
    scopeLens.rotation.x = Math.PI / 2;
    scopeLens.position.set(0, 0.21, -0.54);
    const muzzleBrake = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.14), accentMat);
    muzzleBrake.position.set(0, 0.065, -length * 0.94);
    const bipodL = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.26, 6), darkMat);
    bipodL.rotation.x = Math.PI / 2.2;
    bipodL.position.set(-0.05, -0.02, -0.68);
    const bipodR = bipodL.clone();
    bipodR.position.x = 0.05;
    group.add(scopeMountF, scopeMountR, scope, scopeLens, muzzleBrake, bipodL, bipodR);
    const boltHandle = sharedCylinderMesh(accentMat, 0.02, 0.12);
    boltHandle.rotation.z = Math.PI / 2;
    boltHandle.position.set(0.085, 0.075, -0.18);
    const barrelFluteA = sharedCylinderMesh(darkMat, 0.04, 0.035);
    barrelFluteA.rotation.x = Math.PI / 2;
    barrelFluteA.position.set(0, 0.065, -0.82);
    const barrelFluteB = barrelFluteA.clone();
    barrelFluteB.position.z = -0.94;
    group.add(boltHandle, barrelFluteA, barrelFluteB);
  } else if (category === 'assault_rifle') {
    const holoFrame = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.075, 0.13), gunmetalMat);
    holoFrame.position.set(0, 0.17, -0.22);
    const holoLens = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.045, 0.02), accentMat);
    holoLens.position.set(0, 0.17, -0.22);
    const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.11, 0.34), gunmetalMat);
    handguard.position.set(0, 0.06, -0.52);
    const pistolGrip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.08), darkMat);
    pistolGrip.position.set(0, -0.06, -0.1);
    pistolGrip.rotation.x = -0.25;
    group.add(holoFrame, holoLens, handguard, pistolGrip);
    const compensator = sharedCylinderMesh(gunmetalMat, 0.043, 0.11);
    compensator.rotation.x = Math.PI / 2;
    compensator.position.set(0, 0.065, -length * 0.93);
    group.add(compensator);
  } else if (category === 'burst_rifle') {
    const triRail = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.055, 0.42), gunmetalMat);
    triRail.position.set(0, 0.145, -0.46);
    const burstSight = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.09), accentMat);
    burstSight.position.set(0, 0.2, -0.28);
    const triMuzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.16, 6), accentMat);
    triMuzzle.rotation.x = Math.PI / 2;
    triMuzzle.position.set(0, 0.065, -length * 0.93);
    for (const side of [-1, 1]) {
      const vent = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.045, 0.3), accentMat);
      vent.position.set(side * 0.066, 0.07, -0.48);
      group.add(vent);
    }
    group.add(triRail, burstSight, triMuzzle);
  } else if (category === 'dmr') {
    const dmrScope = new THREE.Mesh(
      new THREE.CylinderGeometry(0.042, 0.038, 0.34, 10),
      gunmetalMat
    );
    dmrScope.rotation.x = Math.PI / 2;
    dmrScope.position.set(0, 0.19, -0.34);
    const dmrLens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.034, 0.034, 0.018, 10),
      accentMat
    );
    dmrLens.rotation.x = Math.PI / 2;
    dmrLens.position.set(0, 0.19, -0.52);
    const longHandguard = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.48), darkMat);
    longHandguard.position.set(0, 0.055, -0.62);
    const cheekRiser = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.22), accentMat);
    cheekRiser.position.set(0, 0.12, 0.05);
    const dmrBrake = sharedBoxMesh(gunmetalMat, 0.075, 0.075, 0.13);
    dmrBrake.position.set(0, 0.065, -length * 0.93);
    const foldedBipod = sharedBoxMesh(darkMat, 0.055, 0.035, 0.3);
    foldedBipod.position.set(0, -0.015, -0.72);
    group.add(dmrScope, dmrLens, longHandguard, cheekRiser, dmrBrake, foldedBipod);
  } else if (category === 'tactical_shotgun') {
    const heatShield = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, 0.44, 8),
      gunmetalMat
    );
    heatShield.rotation.x = Math.PI / 2;
    heatShield.position.set(0, 0.065, -length * 0.68);
    mag.scale.set(1.2, 0.95, 1.65);
    mag.position.set(0, -0.1, -0.3);
    mag.userData.baseY = -0.1;
    mag.userData.baseZ = -0.3;
    const tacSight = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.065, 0.1), accentMat);
    tacSight.position.set(0, 0.17, -0.24);
    const sideSaddle = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.09, 0.3), accentMat);
    sideSaddle.position.set(-0.068, 0.06, -0.26);
    const angledForegrip = sharedBoxMesh(darkMat, 0.055, 0.14, 0.07);
    angledForegrip.position.set(0, -0.045, -0.5);
    angledForegrip.rotation.x = 0.42;
    const breacherMuzzle = sharedCylinderMesh(gunmetalMat, 0.052, 0.11);
    breacherMuzzle.rotation.x = Math.PI / 2;
    breacherMuzzle.position.set(0, 0.065, -length * 0.93);
    group.add(heatShield, tacSight, sideSaddle, angledForegrip, breacherMuzzle);
  } else if (category === 'smg') {
    const drumMag = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.09, 10), accentMat);
    drumMag.rotation.z = Math.PI / 2;
    drumMag.position.set(0, -0.08, -0.22);
    drumMag.name = 'weapon_mag';
    drumMag.userData.baseY = -0.08;
    drumMag.userData.baseZ = -0.22;
    const foreGrip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.15, 6), darkMat);
    foreGrip.position.set(0, -0.05, -0.36);
    const holo = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.06, 0.1), gunmetalMat);
    holo.position.set(0, 0.16, -0.18);
    const suppressor = sharedCylinderMesh(darkMat, 0.042, 0.16);
    suppressor.rotation.x = Math.PI / 2;
    suppressor.position.set(0, 0.065, -length * 0.82);
    group.add(drumMag, foreGrip, holo, suppressor);
  } else if (category === 'shotgun') {
    const underTube = new THREE.Mesh(
      new THREE.CylinderGeometry(0.026, 0.026, length * 0.44, 8),
      darkMat
    );
    underTube.rotation.x = Math.PI / 2;
    underTube.position.set(0, 0.015, -length * 0.66);
    const pump = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.34, 8), accentMat);
    pump.rotation.x = Math.PI / 2;
    pump.position.set(0, 0.015, -length * 0.58);
    pump.userData.baseZ = -length * 0.58;
    pump.name = 'weapon_slide';
    const shellRack = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.22), accentMat);
    shellRack.position.set(0.065, 0.06, -0.24);
    const beadSight = sharedBoxMesh(accentMat, 0.025, 0.05, 0.025);
    beadSight.position.set(0, 0.115, -length * 0.9);
    const stockPad = sharedBoxMesh(darkMat, 0.1, 0.15, 0.06);
    stockPad.position.set(0, 0.02, 0.19);
    group.add(underTube, pump, shellRack, beadSight, stockPad);
  }

  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.name = 'muzzle_tip';
  muzzleAnchor.position.set(0, 0.065, -length * 0.96);
  group.add(muzzleAnchor);
  addFirearmFinish(group,category);

  weaponTemplateCache.set(cacheKey, group);
  return group.clone(true);
}
