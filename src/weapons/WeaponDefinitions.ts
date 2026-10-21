import * as THREE from 'three';
import { AmmoType, WeaponCategory, WeaponRarity } from '../network/schemas';

export interface WeaponStats {
  id: string;
  name: string;
  category: WeaponCategory;
  rarity: WeaponRarity;
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

    case 'shield_potion':
      return {
        id: 'shield_potion_rare',
        name: 'Shield Potion (+50)',
        category: 'shield_potion',
        rarity: 'rare',
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
  roughness: 0.45,
  metalness: 0.45,
  flatShading: true,
});
const SHARED_WEAPON_GUNMETAL_MAT = new THREE.MeshStandardMaterial({
  color: 0x475569,
  roughness: 0.35,
  metalness: 0.6,
  flatShading: true,
});

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
  const rarityColor = RARITY_COLORS[rarity].int;

  const darkMat = SHARED_WEAPON_DARK_MAT;
  const gunmetalMat = SHARED_WEAPON_GUNMETAL_MAT;
  const accentMat = new THREE.MeshStandardMaterial({
    color: rarityColor,
    emissive: rarityColor,
    emissiveIntensity: 0.3,
    roughness: 0.3,
    flatShading: true,
  });

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

  if (category === 'pistol') {
    // Compact Cyber Sidearm Pistol
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
    const muzzleAnchor = new THREE.Object3D();
    muzzleAnchor.name = 'muzzle_tip';
    muzzleAnchor.position.set(0, 0.08, -0.36);
    group.add(slide, stripe, grip, pistolMag, muzzleAnchor);
    weaponTemplateCache.set(cacheKey, group);
    return group.clone(true);
  }

  // Long Firearms (Assault Rifle, Shotgun, SMG, Sniper)
  const length =
    category === 'sniper'
      ? 1.18
      : category === 'assault_rifle'
      ? 0.86
      : category === 'shotgun'
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
  group.add(mag);

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
  } else if (category === 'smg') {
    const drumMag = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.09, 10), accentMat);
    drumMag.rotation.z = Math.PI / 2;
    drumMag.position.set(0, -0.06, -0.22);
    const foreGrip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.15, 6), darkMat);
    foreGrip.position.set(0, -0.05, -0.36);
    const holo = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.06, 0.1), gunmetalMat);
    holo.position.set(0, 0.16, -0.18);
    group.add(drumMag, foreGrip, holo);
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
    group.add(underTube, pump, shellRack);
  }

  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.name = 'muzzle_tip';
  muzzleAnchor.position.set(0, 0.065, -length * 0.96);
  group.add(muzzleAnchor);

  weaponTemplateCache.set(cacheKey, group);
  return group.clone(true);
}
