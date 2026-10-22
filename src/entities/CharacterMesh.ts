import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type {
  BackAccessoryType,
  OutfitPresetId,
  PlayerState,
  WeaponCategory,
  WeaponRarity,
} from '../network/schemas';
import { createWeaponMesh, getWeaponVisualProfile, getSupportGrip } from '../weapons/WeaponDefinitions';
import {
  getOutfitVisualProfile,
  normalizeOutfitPresetId,
} from './CharacterCosmetics';
import {
  selectPresentationState,
  advanceLocomotionPhase,
  getCharacterAnimationInterval,
  type PresentationState,
  getAirbornePose,
  getLocomotionBlend,
  getReloadAnimationPose,
  getTurnLean,
  getWeaponSwitchPose,
} from './CharacterAnimation';

function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

export type CharacterAnimState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'sprint'
  | 'jump'
  | 'fall'
  | 'land'
  | 'glide';

export interface GLTFBoneRefs {
  hips?: THREE.Object3D;
  spine?: THREE.Object3D;
  spine1?: THREE.Object3D;
  spine2?: THREE.Object3D;
  neck?: THREE.Object3D;
  head?: THREE.Object3D;
  rightShoulder?: THREE.Object3D;
  rightArm?: THREE.Object3D;
  rightForeArm?: THREE.Object3D;
  rightHand?: THREE.Object3D;
  leftShoulder?: THREE.Object3D;
  leftArm?: THREE.Object3D;
  leftForeArm?: THREE.Object3D;
  leftHand?: THREE.Object3D;
  rightUpLeg?: THREE.Object3D;
  rightLeg?: THREE.Object3D;
  rightFoot?: THREE.Object3D;
  leftUpLeg?: THREE.Object3D;
  leftLeg?: THREE.Object3D;
  leftFoot?: THREE.Object3D;
}

let sharedTacticalArmorTexture: THREE.CanvasTexture | null | undefined;
let sharedParachuteFabricTexture: THREE.CanvasTexture | null | undefined;

function createTacticalArmorTexture(): THREE.CanvasTexture | null {
  if (sharedTacticalArmorTexture !== undefined) {
    return sharedTacticalArmorTexture;
  }
  if (typeof document === 'undefined') {
    sharedTacticalArmorTexture = null;
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    sharedTacticalArmorTexture = null;
    return null;
  }

  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(0, 0, 128, 128);
  // Subtle diagonal ballistic carbon-weave & ripstop micro-grid
  ctx.fillStyle = 'rgba(15, 23, 42, 0.10)';
  for (let y = 0; y < 128; y += 4) {
    for (let x = 0; x < 128; x += 4) {
      if (((x >> 2) + (y >> 2)) % 2 === 0) {
        ctx.fillRect(x, y, 2, 2);
      }
    }
  }
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.14)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 128; i += 16) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 128);
    ctx.moveTo(0, i);
    ctx.lineTo(128, i);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, 124, 124);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  sharedTacticalArmorTexture = tex;
  return tex;
}

function createParachuteFabricTexture(): THREE.CanvasTexture | null {
  if (sharedParachuteFabricTexture !== undefined) {
    return sharedParachuteFabricTexture;
  }
  if (typeof document === 'undefined') {
    sharedParachuteFabricTexture = null;
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    sharedParachuteFabricTexture = null;
    return null;
  }
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 128; i += 8) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 128);
    ctx.moveTo(0, i);
    ctx.lineTo(128, i);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.26)';
  ctx.lineWidth = 2;
  for (let x = 0; x <= 128; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 128);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  sharedParachuteFabricTexture = tex;
  return tex;
}

/**
 * Evaluates the 3D curved surface of the ram-air parafoil canopy at normalized
 * span u in [-1, 1] and chord v in [0, 1] (0 = leading edge, 1 = trailing edge).
 */
function sampleParachuteCanopyPoint(
  u: number,
  v: number,
  isUpperSurface: boolean,
  target: THREE.Vector3
): THREE.Vector3 {
  const halfSpan = 1.28;
  const chord = 1.12;
  const x = u * halfSpan;
  // Slight swept-back planform toward wingtips
  const sweepZ = (u * u) * 0.08;
  const z = (v - 0.46) * chord + sweepZ;
  // Spanwise anhedral arch (curves downward smoothly toward wingtips)
  const archY = -0.34 * (u * u) - 0.06 * (u * u * u * u);
  // Chordwise airfoil camber + nose droop
  const camberY = 0.115 * Math.sin(v * Math.PI) - 0.025 * v;
  // Airfoil thickness envelope (thickest near 28% chord, tapers to trailing edge)
  const airfoilHalfThick = 0.068 * Math.sin(Math.pow(THREE.MathUtils.clamp(v, 0, 1), 0.58) * Math.PI);
  // 7 spanwise ram-air cells with pillowed fabric billow between stitched ribs
  const cellWave = Math.abs(Math.sin(u * 3.5 * Math.PI));
  const billow = (isUpperSurface ? 0.028 : 0.01) * cellWave * Math.sin(v * Math.PI);
  const y = archY + camberY + (isUpperSurface ? airfoilHalfThick + billow : -airfoilHalfThick * 0.45 + billow * 0.25);
  return target.set(x, y, z);
}

function createCurvedParachuteCanopyGeometry(
  primaryColorHex: number,
  accentColorHex: number
): THREE.BufferGeometry {
  const spanSegs = 28; // 7 cells * 4 subdivisions per cell
  const chordSegs = 12;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const primaryCol = new THREE.Color(primaryColorHex);
  const accentCol = new THREE.Color(accentColorHex);
  const centerCol = new THREE.Color(0xe2e8f0).lerp(primaryCol, 0.28);
  const slateCol = new THREE.Color(0x1e293b).lerp(primaryCol, 0.22);
  const midCol = new THREE.Color(0x334155).lerp(primaryCol, 0.38);
  const wingtipCol = new THREE.Color(0x0f172a).lerp(accentCol, 0.72);
  const seamCol = new THREE.Color(0x0f172a);
  const undersideCol = new THREE.Color(0x1e293b).lerp(primaryCol, 0.18);
  const tmpPt = new THREE.Vector3();
  const vCol = new THREE.Color();

  const pushSurfaceGrid = (isUpper: boolean): number => {
    const baseVertex = positions.length / 3;
    for (let iu = 0; iu <= spanSegs; iu++) {
      const u = (iu / spanSegs) * 2 - 1;
      const absU = Math.abs(u);
      const isRibSeam = iu % 4 === 0;
      for (let iv = 0; iv <= chordSegs; iv++) {
        const v = iv / chordSegs;
        sampleParachuteCanopyPoint(u, v, isUpper, tmpPt);
        positions.push(tmpPt.x, tmpPt.y, tmpPt.z);
        uvs.push((u + 1) * 0.5, v);

        if (!isUpper) {
          vCol.copy(undersideCol);
          if (isRibSeam) vCol.lerp(seamCol, 0.55);
        } else if (isRibSeam || iv === 0 || iv === chordSegs) {
          vCol.copy(seamCol);
        } else if (absU < 1 / 7) {
          vCol.copy(v < 0.22 ? accentCol : centerCol);
        } else if (absU < 3 / 7) {
          vCol.copy(slateCol);
        } else if (absU < 5 / 7) {
          vCol.copy(midCol);
        } else {
          vCol.copy(wingtipCol);
        }
        colors.push(vCol.r, vCol.g, vCol.b);
      }
    }

    const stride = chordSegs + 1;
    for (let iu = 0; iu < spanSegs; iu++) {
      for (let iv = 0; iv < chordSegs; iv++) {
        const a = baseVertex + iu * stride + iv;
        const b = a + stride;
        const c = b + 1;
        const d = a + 1;
        if (isUpper) {
          indices.push(a, d, b, b, d, c);
        } else {
          indices.push(a, b, d, b, c, d);
        }
      }
    }
    return baseVertex;
  };

  const upperBase = pushSurfaceGrid(true);
  const lowerBase = pushSurfaceGrid(false);
  const stride = chordSegs + 1;

  // Stitch trailing edge & 8 internal/wingtip load-bearing cell ribs
  for (let iu = 0; iu < spanSegs; iu++) {
    const u0 = upperBase + iu * stride + chordSegs;
    const u1 = upperBase + (iu + 1) * stride + chordSegs;
    const l0 = lowerBase + iu * stride + chordSegs;
    const l1 = lowerBase + (iu + 1) * stride + chordSegs;
    indices.push(u0, l0, u1, u1, l0, l1);
  }
  for (let iu = 0; iu <= spanSegs; iu += 4) {
    for (let iv = 0; iv < chordSegs; iv++) {
      const u0 = upperBase + iu * stride + iv;
      const u1 = u0 + 1;
      const l0 = lowerBase + iu * stride + iv;
      const l1 = l0 + 1;
      indices.push(u0, u1, l0, u1, l1, l0);
      indices.push(u0, l0, u1, u1, l0, l1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createSuspensionLineMesh(
  name: string,
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.Material
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = Math.max(0.01, dir.length());
  const geo = new THREE.CylinderGeometry(radius, radius, len, 6, 1);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.position.copy(from).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.normalize()
  );
  return mesh;
}

// Shared unit geometries for procedural outfit attachments. Smooth contoured
// primitives replace raw cubes so no boxy placeholders ever appear on the character.
const OUTFIT_PAULDRON_GEO = (() => {
  const geo = new THREE.SphereGeometry(0.5, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.58);
  geo.translate(0, -0.12, 0);
  geo.computeVertexNormals();
  return geo;
})();
const OUTFIT_BOX_GEO = (() => {
  const geo = new THREE.CapsuleGeometry(0.34, 0.32, 4, 10);
  geo.rotateZ(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
})();
const OUTFIT_CYLINDER_GEO = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const OUTFIT_CONE_GEO = new THREE.ConeGeometry(0.5, 1, 10);
const OUTFIT_OCTA_GEO = new THREE.OctahedronGeometry(0.5, 1);

function quatKeyframes(
  boneName: string,
  times: number[],
  eulers: Array<[number, number, number]>
): THREE.QuaternionKeyframeTrack {
  const values: number[] = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (const [rx, ry, rz] of eulers) {
    e.set(rx, ry, rz, 'XYZ');
    q.setFromEuler(e);
    values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values);
}

export class CharacterMesh {
  public static readonly MODEL_URL = '/models/soldier.glb';
  private static sharedGLTFTemplate: GLTF | null = null;
  private static isLoadingTemplate: boolean = false;
  public static assetStatus: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private static pendingInstances: Set<CharacterMesh> = new Set();

  /**
   * Optimizes embedded GLB animation clips by stripping redundant finger/scale tracks
   * (reducing track evaluations by ~85% from 156 to 23 tracks per clip) and constructs
   * retargeted Mixamo AnimationClips for Sprint, Jump, Fall, Land, Aim, Shoot, and Reload.
   */
  private static optimizeAndBuildRetargetedClips(gltf: GLTF): void {
    // Reject incompatible assets before publishing them to waiting instances.
    for (const name of ['mixamorigHips', 'mixamorigSpine2', 'mixamorigHead',
      'mixamorigRightHand', 'mixamorigLeftHand']) {
      if (!gltf.scene.getObjectByName(name)) throw new Error(`Character rig missing ${name}`);
    }
    for (const name of ['Idle', 'Walk', 'Run']) {
      if (!gltf.animations.some(clip => clip.name === name)) throw new Error(`Missing ${name} clip`);
    }
    // 1. Prune redundant finger & constant scale/translation tracks for browser performance
    for (const clip of gltf.animations) {
      clip.tracks = clip.tracks.filter((t) => {
        if (t.name.endsWith('.scale')) return false;
        if (
          t.name.includes('HandThumb') ||
          t.name.includes('HandIndex') ||
          t.name.includes('HandMiddle') ||
          t.name.includes('HandRing') ||
          t.name.includes('HandPinky')
        ) {
          return false;
        }
        if (t.name.endsWith('.position') && !t.name.startsWith('mixamorigHips.')) {
          return false;
        }
        return true;
      });
    }

    // Optimize shared texture mipmaps/filtering on template meshes
    gltf.scene.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (m.isMesh && m.material) {
        const mat = m.material as THREE.MeshStandardMaterial;
        for (const tex of [mat.map, mat.normalMap, mat.roughnessMap, mat.metalnessMap]) {
          if (tex) {
            tex.anisotropy = 2;
            tex.generateMipmaps = true;
          }
        }
      }
    });

    const hasClip = (name: string) => gltf.animations.some((a) => a.name === name);
    const runClip = gltf.animations.find((a) => a.name === 'Run');

    // 2. Retargeted Sprint Clip (derived from Run clip + forward athletic torso drive)
    if (runClip && !hasClip('Sprint')) {
      const sprintClip = runClip.clone();
      sprintClip.name = 'Sprint';
      gltf.animations.push(sprintClip);
    }

    // 3. Retargeted Jump Clip on Mixamo skeleton
    if (!hasClip('Jump')) {
      const jumpClip = new THREE.AnimationClip('Jump', 0.6, [
        quatKeyframes(
          'mixamorigRightUpLeg',
          [0, 0.3, 0.6],
          [
            [-0.45, 0, 0],
            [-0.78, 0, 0],
            [-0.62, 0, 0],
          ]
        ),
        quatKeyframes(
          'mixamorigRightLeg',
          [0, 0.3, 0.6],
          [
            [0.65, 0, 0],
            [1.05, 0, 0],
            [0.85, 0, 0],
          ]
        ),
        quatKeyframes(
          'mixamorigLeftUpLeg',
          [0, 0.3, 0.6],
          [
            [-0.25, 0, 0],
            [-0.48, 0, 0],
            [-0.35, 0, 0],
          ]
        ),
        quatKeyframes(
          'mixamorigLeftLeg',
          [0, 0.3, 0.6],
          [
            [0.4, 0, 0],
            [0.72, 0, 0],
            [0.55, 0, 0],
          ]
        ),
        quatKeyframes(
          'mixamorigSpine1',
          [0, 0.3, 0.6],
          [
            [0.08, 0, 0],
            [0.18, 0, 0],
            [0.14, 0, 0],
          ]
        ),
      ]);
      gltf.animations.push(jumpClip);
    }

    // 4. Retargeted Fall Clip on Mixamo skeleton
    if (!hasClip('Fall')) {
      const fallClip = new THREE.AnimationClip('Fall', 0.8, [
        quatKeyframes(
          'mixamorigRightUpLeg',
          [0, 0.4, 0.8],
          [
            [-0.28, 0, 0.05],
            [-0.42, 0, 0.08],
            [-0.28, 0, 0.05],
          ]
        ),
        quatKeyframes(
          'mixamorigRightLeg',
          [0, 0.4, 0.8],
          [
            [0.45, 0, 0],
            [0.62, 0, 0],
            [0.45, 0, 0],
          ]
        ),
        quatKeyframes(
          'mixamorigLeftUpLeg',
          [0, 0.4, 0.8],
          [
            [-0.35, 0, -0.05],
            [-0.22, 0, -0.08],
            [-0.35, 0, -0.05],
          ]
        ),
        quatKeyframes(
          'mixamorigLeftLeg',
          [0, 0.4, 0.8],
          [
            [0.52, 0, 0],
            [0.38, 0, 0],
            [0.52, 0, 0],
          ]
        ),
      ]);
      gltf.animations.push(fallClip);
    }

    // 5. Retargeted Land Clip on Mixamo skeleton
    if (!hasClip('Land')) {
      const landClip = new THREE.AnimationClip('Land', 0.25, [
        quatKeyframes(
          'mixamorigRightUpLeg',
          [0, 0.12, 0.25],
          [
            [-0.2, 0, 0],
            [-0.52, 0, 0],
            [-0.15, 0, 0],
          ]
        ),
        quatKeyframes(
          'mixamorigRightLeg',
          [0, 0.12, 0.25],
          [
            [0.3, 0, 0],
            [0.75, 0, 0],
            [0.2, 0, 0],
          ]
        ),
        quatKeyframes(
          'mixamorigLeftUpLeg',
          [0, 0.12, 0.25],
          [
            [-0.2, 0, 0],
            [-0.52, 0, 0],
            [-0.15, 0, 0],
          ]
        ),
        quatKeyframes(
          'mixamorigLeftLeg',
          [0, 0.12, 0.25],
          [
            [0.3, 0, 0],
            [0.75, 0, 0],
            [0.2, 0, 0],
          ]
        ),
      ]);
      gltf.animations.push(landClip);
    }

    // 6. Retargeted Aim, Shoot & Reload Upper-Body Clips on Mixamo skeleton
    if (!hasClip('Aim')) {
      const aimClip = new THREE.AnimationClip('Aim', 0.4, [
        quatKeyframes(
          'mixamorigRightArm',
          [0, 0.4],
          [
            [0.2, 0.85, 1.35],
            [0.2, 0.85, 1.35],
          ]
        ),
        quatKeyframes(
          'mixamorigRightForeArm',
          [0, 0.4],
          [
            [1.2, 0.25, 0.45],
            [1.2, 0.25, 0.45],
          ]
        ),
        quatKeyframes(
          'mixamorigLeftArm',
          [0, 0.4],
          [
            [0.15, -0.85, 1.65],
            [0.15, -0.85, 1.65],
          ]
        ),
        quatKeyframes(
          'mixamorigLeftForeArm',
          [0, 0.4],
          [
            [-0.65, 0.2, 0.55],
            [-0.65, 0.2, 0.55],
          ]
        ),
      ]);
      gltf.animations.push(aimClip);
    }

    if (!hasClip('Shoot')) {
      const shootClip = new THREE.AnimationClip('Shoot', 0.22, [
        quatKeyframes(
          'mixamorigRightArm',
          [0, 0.08, 0.22],
          [
            [0.2, 0.85, 1.35],
            [0.25, 0.92, 1.48],
            [0.2, 0.85, 1.35],
          ]
        ),
        quatKeyframes(
          'mixamorigRightForeArm',
          [0, 0.08, 0.22],
          [
            [1.2, 0.25, 0.45],
            [1.32, 0.28, 0.58],
            [1.2, 0.25, 0.45],
          ]
        ),
      ]);
      gltf.animations.push(shootClip);
    }

    if (!hasClip('Reload')) {
      const reloadClip = new THREE.AnimationClip('Reload', 1.2, [
        quatKeyframes(
          'mixamorigRightArm',
          [0, 0.4, 0.8, 1.2],
          [
            [0.2, 0.85, 1.35],
            [0.15, 0.72, 1.15],
            [0.18, 0.78, 1.4],
            [0.2, 0.85, 1.35],
          ]
        ),
        quatKeyframes(
          'mixamorigLeftArm',
          [0, 0.4, 0.8, 1.2],
          [
            [0.15, -0.85, 1.65],
            [0.28, -0.65, 1.35],
            [0.22, -0.92, 1.72],
            [0.15, -0.85, 1.65],
          ]
        ),
      ]);
      gltf.animations.push(reloadClip);
    }
    const ready = gltf.animations.find(clip => clip.name === 'Aim')!.clone();
    ready.name = 'Ready';
    gltf.animations.push(ready);
    gltf.animations.push(new THREE.AnimationClip('Switch', 0.24, [
      quatKeyframes('mixamorigRightForeArm', [0, 0.12, 0.24],
        [[1.2, 0.25, 0.45], [0.9, 0.2, 0.32], [1.2, 0.25, 0.45]]),
      quatKeyframes('mixamorigLeftForeArm', [0, 0.12, 0.24],
        [[-0.65, 0.2, 0.55], [-0.4, 0.2, 0.35], [-0.65, 0.2, 0.55]]),
    ]));
  }

  private static disposeRejectedAsset(gltf: GLTF): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    const skeletons = new Set<THREE.Skeleton>();
    gltf.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
    });
    skeletons.forEach(skeleton => skeleton.dispose());
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    textures.forEach(texture => texture.dispose());
  }

  /**
   * Loads and caches the bundled rigged GLB character model (/models/soldier.glb)
   * using Three.js GLTFLoader. Automatically falls back to the procedural character
   * if loading fails or while loading is in progress.
   */
  public static ensureSharedGLBLoaded(): void {
    if (this.sharedGLTFTemplate || this.isLoadingTemplate || this.assetStatus === 'failed') return;
    if (typeof window === 'undefined') return;

    this.isLoadingTemplate = true;
    this.assetStatus = 'loading';
    const loader = new GLTFLoader();
    loader.load(
      this.MODEL_URL,
      (gltf) => {
        try { this.optimizeAndBuildRetargetedClips(gltf); }
        catch {
          this.disposeRejectedAsset(gltf);
          this.assetStatus = 'failed';
          this.isLoadingTemplate = false;
          this.pendingInstances.clear();
          return;
        }
        this.assetStatus = 'ready';
        this.sharedGLTFTemplate = gltf;
        this.isLoadingTemplate = false;
        for (const inst of this.pendingInstances) {
          inst.upgradeToRiggedGLTFModel();
        }
        this.pendingInstances.clear();
      },
      undefined,
      () => {
        // Failed assets are not retried for every newly spawned player.
        this.assetStatus = 'failed';
        this.isLoadingTemplate = false;
        this.pendingInstances.clear();
      }
    );
  }

  /**
   * Allows preloading the bundled GLB binary buffer directly (e.g. in Node/SSR validation tests)
   */
  public static async preloadFromArrayBuffer(buffer: ArrayBuffer): Promise<GLTF> {
    try {
      const gltf = await new GLTFLoader().parseAsync(buffer, '');
      try { this.optimizeAndBuildRetargetedClips(gltf); }
      catch (error) { this.disposeRejectedAsset(gltf); throw error; }
      this.sharedGLTFTemplate = gltf;
      this.assetStatus = 'ready';
      this.isLoadingTemplate = false;
      for (const instance of this.pendingInstances) instance.upgradeToRiggedGLTFModel();
      this.pendingInstances.clear();
      return gltf;
    } catch (error) {
      this.assetStatus = this.sharedGLTFTemplate ? 'ready' : 'failed';
      this.isLoadingTemplate = false;
      this.pendingInstances.clear();
      throw error;
    }
  }

  public static getLoadedAnimationClipNames(): string[] {
    if (!this.sharedGLTFTemplate) return [];
    return this.sharedGLTFTemplate.animations.map((a) => a.name);
  }

  public playerId: string;
  public root: THREE.Group;
  public bodyGroup: THREE.Group;
  public proceduralFallbackGroup: THREE.Group;
  public gltfModelGroup: THREE.Group | null = null;
  public jumpPackGroup: THREE.Group | null = null;
  public outfitAttachmentGroup: THREE.Group | null = null;
  public isUsingGLTF: boolean = false;

  // Procedural Fallback Rig Pivots (kept for instant fallback & API compatibility)
  public pelvisGroup: THREE.Group;
  public spinePivot: THREE.Group;
  public headGroup: THREE.Group;
  public headMesh: THREE.Mesh;
  public torsoMesh: THREE.Mesh;
  public leftArmPivot: THREE.Group;
  public leftElbowPivot: THREE.Group;
  public rightArmPivot: THREE.Group;
  public rightElbowPivot: THREE.Group;
  public leftLegPivot: THREE.Group;
  public leftKneePivot: THREE.Group;
  public rightLegPivot: THREE.Group;
  public rightKneePivot: THREE.Group;

  // Shared Weapon Socket, Muzzle Flash, Glider & Shield
  public weaponSocket: THREE.Group;
  public muzzleFlashMesh: THREE.Group;
  public gliderGroup: THREE.Group;
  public shieldAura: THREE.Mesh;
  public currentAnimState: CharacterAnimState = 'idle';
  public presentationState: PresentationState = 'ready';
  private reducedDetail = false;
  private locomotionPhase = 0;
  private accumulatedFallbackDt = 0;
  private weaponMicroDetails: THREE.Object3D | undefined;
  public setReducedDetail(reduced: boolean): void {
    if (this.reducedDetail === reduced) return;
    this.reducedDetail = reduced;
    for (const material of [this.torsoMat, this.gltfBodyMat]) {
      if (!material) continue;
      material.bumpMap = reduced ? null : this.armorTexture;
      material.needsUpdate = true;
    }
  }
  private wasGrounded = true;
  private landingTimer = 0;
  private wasAlive = true;
  private eliminationTimer = 0;
  private disposed = false;

  // GLTF Skeleton & AnimationMixer State
  public mixer: THREE.AnimationMixer | null = null;
  public gltfActions: {
    idle?: THREE.AnimationAction;
    walk?: THREE.AnimationAction;
    run?: THREE.AnimationAction;
    sprint?: THREE.AnimationAction;
    jump?: THREE.AnimationAction;
    fall?: THREE.AnimationAction;
    land?: THREE.AnimationAction;
    aim?: THREE.AnimationAction;
    shoot?: THREE.AnimationAction;
    reload?: THREE.AnimationAction;
    tpose?: THREE.AnimationAction;
    ready?: THREE.AnimationAction;
    switch?: THREE.AnimationAction;
  } = {};
  public gltfBones: GLTFBoneRefs = {};
  private gltfBodyMat: THREE.MeshStandardMaterial | null = null;
  private gltfVisorMat: THREE.MeshStandardMaterial | null = null;

  private overheadBarGroup: THREE.Group;
  private overheadHealthFill: THREE.Mesh;
  private overheadShieldFill: THREE.Mesh;

  private outfitId: OutfitPresetId;
  private skinColorHex: number;
  private accentColorHex: number;
  private backAccessoryType: BackAccessoryType;
  private currentWeaponKey: string = '';
  private animTime: number = 0;
  private reloadAnimClock: number = 0;
  private attackSwingTimer: number = 0;
  private muzzleFlashTimer: number = 0;
  private muzzleFlashDuration: number = 0.06;
  private readonly muzzleFlashBaseScale = new THREE.Vector3(1, 1, 1);
  private hitFlashTimer: number = 0;
  private hitReactionTimer: number = 0;
  private isHeadshotFlinch: boolean = false;
  private isShieldHitFlash: boolean = false;
  private hitFlinchDir: number = 1;
  private equipAnimTimer: number = 0;
  private visualFacingYaw: number = 0;
  private prevAimYaw: number = 0;
  private prevAimPitch: number = 0;
  private swayYawOffset: number = 0;
  private swayPitchOffset: number = 0;
  private aimPoseBlend: number = 0;
  private reloadPoseBlend: number = 0;
  private turnLean: number = 0;
  private weaponSwitchDipY: number = 0;
  private weaponSwitchRoll: number = 0;
  private activeWeaponCategory: WeaponCategory = 'harvester';
  private torsoMat: THREE.MeshStandardMaterial;
  private accentMat: THREE.MeshStandardMaterial;
  private armorTexture: THREE.CanvasTexture | null = null;
  private tempHandWorldPos = new THREE.Vector3();
  private accumulatedMixerDt: number = 0;
  private attachmentRest = new Map<THREE.Object3D, THREE.Matrix4>();
  private attachmentBindings: Array<{ object: THREE.Object3D; bone: THREE.Object3D; inverseBind: THREE.Matrix4 }> = [];
  private attachmentBodyInverse = new THREE.Matrix4();
  private attachmentMatrix = new THREE.Matrix4();
  private ikPoints = Array.from({ length: 8 }, () => new THREE.Vector3());
  private ikRotations = Array.from({ length: 4 }, () => new THREE.Quaternion());
  private weaponMagazine: THREE.Object3D | undefined;
  private weaponSlide: THREE.Object3D | undefined;
  private weaponMagazineRotation = new THREE.Euler();
  private packOffset = new THREE.Matrix4().makeTranslation(0, 1.3, 0.205);
  private baseBonePoses = new Map<THREE.Object3D, THREE.Quaternion>();
  private parachuteCanopyPivot: THREE.Group | null = null;
  private parachuteHarnessGroup: THREE.Group | null = null;
  private parachuteDeployBlend: number = 0;

  constructor(playerState: PlayerState) {
    this.playerId = playerState.id;
    this.outfitId = normalizeOutfitPresetId(playerState.outfitId);
    this.skinColorHex = playerState.skinColor;
    this.accentColorHex = playerState.accentColor;
    this.backAccessoryType = playerState.backAccessory || 'jump_pack';
    this.visualFacingYaw = playerState.facingYaw ?? playerState.yaw;
    this.root = new THREE.Group();
    this.root.userData.playerId = playerState.id;

    this.bodyGroup = new THREE.Group();
    this.root.add(this.bodyGroup);

    this.proceduralFallbackGroup = new THREE.Group();
    this.bodyGroup.add(this.proceduralFallbackGroup);

    this.armorTexture = createTacticalArmorTexture();

    this.torsoMat = new THREE.MeshStandardMaterial({
      color: playerState.skinColor,
      map: this.armorTexture,
      roughness: 0.38,
      metalness: 0.25,
    });
    this.accentMat = new THREE.MeshStandardMaterial({
      color: playerState.accentColor,
      emissive: playerState.accentColor,
      emissiveIntensity: 0.36,
      roughness: 0.25,
      metalness: 0.35,
    });
    const accentMat = this.accentMat;
    const skinMat = new THREE.MeshStandardMaterial({
      color: 0xfde68a,
      roughness: 0.55,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      map: this.armorTexture,
      roughness: 0.52,
      metalness: 0.3,
    });

    // 1. Procedural Fallback Rig (Pelvis + Legs + Spine + Head + Arms)
    this.pelvisGroup = new THREE.Group();
    this.pelvisGroup.position.set(0, 0.82, 0);
    const pelvisMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.21, 0.22, 12),
      darkMat
    );
    pelvisMesh.scale.set(1.15, 1, 0.78);
    pelvisMesh.castShadow = true;

    const beltBand = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.26, 0.09, 12),
      darkMat
    );
    beltBand.scale.set(1.16, 1, 0.8);
    beltBand.position.y = 0.06;
    const beltBuckle = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.034, 0.06, 6, 10),
      accentMat
    );
    beltBuckle.rotation.z = Math.PI / 2;
    beltBuckle.position.set(0, 0.06, -0.21);
    this.pelvisGroup.add(pelvisMesh, beltBand, beltBuckle);
    this.proceduralFallbackGroup.add(this.pelvisGroup);

    this.leftLegPivot = new THREE.Group();
    this.leftLegPivot.position.set(-0.17, 0.78, 0);
    const leftThigh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.115, 0.22, 6, 10),
      darkMat
    );
    leftThigh.position.y = -0.18;
    leftThigh.castShadow = true;
    this.leftKneePivot = new THREE.Group();
    this.leftKneePivot.position.set(0, -0.36, 0);
    const leftShin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.105, 0.085, 0.32, 10),
      darkMat
    );
    leftShin.position.y = -0.16;
    leftShin.castShadow = true;
    const leftBootFoot = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.095, 0.14, 6, 10),
      accentMat
    );
    leftBootFoot.rotation.x = Math.PI / 2;
    leftBootFoot.scale.set(1.08, 1.0, 0.75);
    leftBootFoot.position.set(0, -0.35, -0.05);
    this.leftKneePivot.add(leftShin, leftBootFoot);
    this.leftLegPivot.add(leftThigh, this.leftKneePivot);

    this.rightLegPivot = new THREE.Group();
    this.rightLegPivot.position.set(0.17, 0.78, 0);
    const rightThigh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.115, 0.22, 6, 10),
      darkMat
    );
    rightThigh.position.y = -0.18;
    rightThigh.castShadow = true;
    this.rightKneePivot = new THREE.Group();
    this.rightKneePivot.position.set(0, -0.36, 0);
    const rightShin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.105, 0.085, 0.32, 10),
      darkMat
    );
    rightShin.position.y = -0.16;
    rightShin.castShadow = true;
    const rightBootFoot = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.095, 0.14, 6, 10),
      accentMat
    );
    rightBootFoot.rotation.x = Math.PI / 2;
    rightBootFoot.scale.set(1.08, 1.0, 0.75);
    rightBootFoot.position.set(0, -0.35, -0.05);
    this.rightKneePivot.add(rightShin, rightBootFoot);
    this.rightLegPivot.add(rightThigh, this.rightKneePivot);

    this.proceduralFallbackGroup.add(this.leftLegPivot, this.rightLegPivot);

    this.spinePivot = new THREE.Group();
    this.spinePivot.position.set(0, 0.88, 0);
    this.proceduralFallbackGroup.add(this.spinePivot);

    this.torsoMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.29, 0.23, 0.62, 12),
      this.torsoMat
    );
    this.torsoMesh.scale.set(1.12, 1.0, 0.72);
    this.torsoMesh.position.set(0, 0.31, 0);
    this.torsoMesh.castShadow = true;
    this.spinePivot.add(this.torsoMesh);

    const collarRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.16, 0.038, 8, 16),
      accentMat
    );
    collarRing.rotation.x = Math.PI / 2;
    collarRing.position.set(0, 0.62, 0);
    this.spinePivot.add(collarRing);

    this.headGroup = new THREE.Group();
    this.headGroup.position.set(0, 0.84, 0);
    this.spinePivot.add(this.headGroup);

    this.headMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.175, 0.11, 8, 14),
      skinMat
    );
    this.headMesh.castShadow = true;
    const helmetDome = new THREE.Mesh(
      new THREE.SphereGeometry(0.205, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.62),
      this.torsoMat
    );
    helmetDome.position.y = 0.03;
    const visorArc = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.195,
        0.195,
        0.12,
        14,
        1,
        true,
        Math.PI * 0.68,
        Math.PI * 0.64
      ),
      accentMat
    );
    visorArc.position.set(0, 0.02, 0);
    this.headGroup.add(this.headMesh, helmetDome, visorArc);

    this.leftArmPivot = new THREE.Group();
    this.leftArmPivot.position.set(-0.39, 0.56, 0);
    const leftUpperArm = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.082, 0.18, 6, 10),
      this.torsoMat
    );
    leftUpperArm.position.y = -0.14;
    this.leftElbowPivot = new THREE.Group();
    this.leftElbowPivot.position.set(0, -0.28, 0);
    const leftForearm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.082, 0.068, 0.24, 10),
      darkMat
    );
    leftForearm.position.y = -0.12;
    this.leftElbowPivot.add(leftForearm);
    this.leftArmPivot.add(leftUpperArm, this.leftElbowPivot);
    this.spinePivot.add(this.leftArmPivot);

    this.rightArmPivot = new THREE.Group();
    this.rightArmPivot.position.set(0.39, 0.56, 0);
    const rightUpperArm = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.082, 0.18, 6, 10),
      this.torsoMat
    );
    rightUpperArm.position.y = -0.14;
    this.rightElbowPivot = new THREE.Group();
    this.rightElbowPivot.position.set(0, -0.28, 0);
    const rightForearm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.082, 0.068, 0.24, 10),
      darkMat
    );
    rightForearm.position.y = -0.12;
    this.rightElbowPivot.add(rightForearm);
    this.rightArmPivot.add(rightUpperArm, this.rightElbowPivot);
    this.spinePivot.add(this.rightArmPivot);

    // 2. Weapon Socket & Multi-Ray Starburst Muzzle Flash
    this.weaponSocket = new THREE.Group();
    this.weaponSocket.position.set(0, -0.25, -0.14);
    this.rightElbowPivot.add(this.weaponSocket);

    this.muzzleFlashMesh = new THREE.Group();
    const coreFlash = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.22, 0),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.96,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    const outerFlash = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.36, 0),
      new THREE.MeshBasicMaterial({
        color: 0xfacc15,
        transparent: true,
        opacity: 0.78,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    outerFlash.scale.set(1.25, 1.25, 1.9);
    const flashSpikeH = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.06, 0.06),
      new THREE.MeshBasicMaterial({
        color: 0xfef08a,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    const flashSpikeV = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.62, 0.06),
      new THREE.MeshBasicMaterial({
        color: 0xfef08a,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    coreFlash.userData.baseOpacity = 0.96;
    outerFlash.userData.baseOpacity = 0.78;
    flashSpikeH.userData.baseOpacity = 0.85;
    flashSpikeV.userData.baseOpacity = 0.85;
    this.muzzleFlashMesh.add(coreFlash, outerFlash, flashSpikeH, flashSpikeV);
    this.muzzleFlashMesh.position.set(0, 0.06, -0.82);
    this.muzzleFlashMesh.visible = false;
    this.weaponSocket.add(this.muzzleFlashMesh);

    // 3. Tactical Ram-Air Parachute System (Curved Multi-Cell Canopy, Risers, Suspension Lines & Harness)
    this.gliderGroup = new THREE.Group();
    this.gliderGroup.name = 'parachute_system';
    this.gliderGroup.position.set(0, 0, 0);
    this.gliderGroup.visible = false;
    this.bodyGroup.add(this.gliderGroup);
    this.rebuildParachuteRig();

    // 4. Shield Aura Cylinder
    const shieldGeo = new THREE.CylinderGeometry(0.56, 0.56, 1.88, 14, 1, true);
    const shieldMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.shieldAura = new THREE.Mesh(shieldGeo, shieldMat);
    this.shieldAura.position.y = 0.95;
    this.bodyGroup.add(this.shieldAura);

    // 5. Overhead Health & Shield Bar
    this.overheadBarGroup = new THREE.Group();
    this.overheadBarGroup.position.set(0, 2.34, 0);
    const bgBar = new THREE.Mesh(
      new THREE.PlaneGeometry(0.95, 0.16),
      new THREE.MeshBasicMaterial({ color: 0x0f172a, side: THREE.DoubleSide })
    );
    this.overheadShieldFill = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.055),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide })
    );
    this.overheadShieldFill.position.set(0, 0.035, 0.01);
    this.overheadHealthFill = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.055),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, side: THREE.DoubleSide })
    );
    this.overheadHealthFill.position.set(0, -0.035, 0.01);
    this.overheadBarGroup.add(bgBar, this.overheadShieldFill, this.overheadHealthFill);
    this.overheadBarGroup.visible = false;
    this.root.add(this.overheadBarGroup);

    this.applyOutfitMaterialFinish();
    this.rebuildBackAccessory();
    this.rebuildOutfitAttachments();

    // 6. Upgrade to Real Rigged GLTF Character if cached, or queue for async load
    if (CharacterMesh.sharedGLTFTemplate) {
      this.upgradeToRiggedGLTFModel();
    } else {
      if (CharacterMesh.assetStatus !== 'failed') CharacterMesh.pendingInstances.add(this);
      CharacterMesh.ensureSharedGLBLoaded();
    }
  }

  /**
   * Instantiates the rigged Soldier.glb SkinnedMesh + 49-bone Mixamo skeleton + AnimationMixer,
   * customizes stylized armor/visor materials & tactical jump-pack silhouette, and hides the procedural fallback.
   */
  public upgradeToRiggedGLTFModel(): void {
    const template = CharacterMesh.sharedGLTFTemplate;
    if (!template || this.isUsingGLTF || this.disposed) return;

    try {
      const clonedScene = cloneSkeleton(template.scene) as THREE.Group;
      this.gltfModelGroup = new THREE.Group();
      // Balanced athletic proportions matching human anatomy and tactical gear
      this.gltfModelGroup.scale.set(1.03, 1.02, 1.03);
      this.gltfModelGroup.add(clonedScene);
      this.bodyGroup.add(this.gltfModelGroup);

      // Customize SkinnedMesh materials with realistic PBR cloth/armor shading & polarized visor
      clonedScene.traverse((obj) => {
        const mesh = obj as THREE.SkinnedMesh;
        if (mesh.isMesh) {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.frustumCulled = false;

          if (mesh.name === 'vanguard_visor') {
            const profile = getOutfitVisualProfile(this.outfitId);
            const visorMat = new THREE.MeshStandardMaterial({
              color: this.accentColorHex,
              emissive: this.accentColorHex,
              emissiveIntensity: profile.visorEmissiveIntensity * 0.62,
              roughness: Math.max(0.06, profile.roughness * 0.35),
              metalness: Math.min(0.92, profile.metalness + 0.42),
              envMapIntensity: profile.envMapIntensity + 0.35,
            });
            mesh.material = visorMat;
            this.gltfVisorMat = visorMat;
          } else if (mesh.material) {
            const profile = getOutfitVisualProfile(this.outfitId);
            const origMat = mesh.material as THREE.MeshStandardMaterial;
            const customBodyMat = origMat.clone();
            const baseTint = new THREE.Color(this.skinColorHex);
            const hsl = { h: 0, s: 0, l: 0 };
            baseTint.getHSL(hsl);
            baseTint.setHSL(
              hsl.h,
              Math.min(0.85, hsl.s * 0.95),
              THREE.MathUtils.clamp(hsl.l, 0.32, 0.58)
            );
            const tinted = new THREE.Color(0xe2e8f0).lerp(baseTint, 0.52);
            customBodyMat.color.copy(tinted);
            customBodyMat.roughness = Math.max(0.52, profile.roughness);
            customBodyMat.metalness = Math.min(0.45, profile.metalness * 0.62);
            customBodyMat.envMapIntensity = profile.envMapIntensity;
            if (this.armorTexture && !this.reducedDetail) {
              customBodyMat.bumpMap = this.armorTexture;
              customBodyMat.bumpScale = 0.015;
            }
            mesh.material = customBodyMat;
            this.gltfBodyMat = customBodyMat;
          }
        }
      });

      // Add Stylized Battle Royale Back Accessory (Jump-Pack, Energy Wings, Tactical Shield, or None)
      this.rebuildBackAccessory();
      this.applyOutfitMaterialFinish();

      // Cache Mixamo skeleton bone references for upper-body aiming/shooting/reloading & airborne layering
      this.gltfBones = {
        hips: clonedScene.getObjectByName('mixamorigHips'),
        spine: clonedScene.getObjectByName('mixamorigSpine'),
        spine1: clonedScene.getObjectByName('mixamorigSpine1'),
        spine2: clonedScene.getObjectByName('mixamorigSpine2'),
        neck: clonedScene.getObjectByName('mixamorigNeck'),
        head: clonedScene.getObjectByName('mixamorigHead'),
        rightShoulder: clonedScene.getObjectByName('mixamorigRightShoulder'),
        rightArm: clonedScene.getObjectByName('mixamorigRightArm'),
        rightForeArm: clonedScene.getObjectByName('mixamorigRightForeArm'),
        rightHand: clonedScene.getObjectByName('mixamorigRightHand'),
        leftShoulder: clonedScene.getObjectByName('mixamorigLeftShoulder'),
        leftArm: clonedScene.getObjectByName('mixamorigLeftArm'),
        leftForeArm: clonedScene.getObjectByName('mixamorigLeftForeArm'),
        leftHand: clonedScene.getObjectByName('mixamorigLeftHand'),
        rightUpLeg: clonedScene.getObjectByName('mixamorigRightUpLeg'),
        rightLeg: clonedScene.getObjectByName('mixamorigRightLeg'),
        rightFoot: clonedScene.getObjectByName('mixamorigRightFoot'),
        leftUpLeg: clonedScene.getObjectByName('mixamorigLeftUpLeg'),
        leftLeg: clonedScene.getObjectByName('mixamorigLeftLeg'),
        leftFoot: clonedScene.getObjectByName('mixamorigLeftFoot'),
      };

      for (const bone of Object.values(this.gltfBones)) {
        if (bone) this.baseBonePoses.set(bone, bone.quaternion.clone());
      }
      // Set up Three.js AnimationMixer with embedded & retargeted GLB clips
      this.mixer = new THREE.AnimationMixer(clonedScene);
      const findClip = (name: string) => template.animations.find((a) => a.name === name);

      const idleClip = findClip('Idle');
      const walkClip = findClip('Walk');
      const runClip = findClip('Run');
      const sprintClip = findClip('Sprint');
      const jumpClip = findClip('Jump');
      const fallClip = findClip('Fall');
      const landClip = findClip('Land');
      const aimClip = findClip('Aim');
      const shootClip = findClip('Shoot');
      const reloadClip = findClip('Reload');
      const tposeClip = findClip('TPose');

      if (idleClip) {
        this.gltfActions.idle = this.mixer.clipAction(idleClip);
        this.gltfActions.idle.setEffectiveWeight(1.0);
        this.gltfActions.idle.play();
      }
      if (walkClip) {
        this.gltfActions.walk = this.mixer.clipAction(walkClip);
        this.gltfActions.walk.setEffectiveWeight(0.0);
        this.gltfActions.walk.play();
      }
      if (runClip) {
        this.gltfActions.run = this.mixer.clipAction(runClip);
        this.gltfActions.run.setEffectiveWeight(0.0);
        this.gltfActions.run.play();
      }
      if (sprintClip) {
        this.gltfActions.sprint = this.mixer.clipAction(sprintClip);
      }
      if (jumpClip) {
        this.gltfActions.jump = this.mixer.clipAction(jumpClip);
      }
      if (fallClip) {
        this.gltfActions.fall = this.mixer.clipAction(fallClip);
      }
      if (landClip) {
        this.gltfActions.land = this.mixer.clipAction(landClip);
      }
      if (aimClip) {
        this.gltfActions.aim = this.mixer.clipAction(aimClip);
      }
      if (shootClip) {
        this.gltfActions.shoot = this.mixer.clipAction(shootClip);
      }
      if (reloadClip) {
        this.gltfActions.reload = this.mixer.clipAction(reloadClip);
      }
      this.gltfActions.ready = this.mixer.clipAction(findClip('Ready')!);
      this.gltfActions.switch = this.mixer.clipAction(findClip('Switch')!);
      for (const key of ['sprint', 'jump', 'fall', 'land', 'aim', 'shoot', 'reload', 'ready', 'switch'] as const) {
        const action = this.gltfActions[key];
        if (!action) continue;
        if (key === 'jump' || key === 'fall' || key === 'land') {
          // These are authored local rotation offsets, not replacement motion capture.
          action.blendMode = THREE.AdditiveAnimationBlendMode;
        }
        action.setEffectiveWeight(0).play();
      }
      if (tposeClip) {
        this.gltfActions.tpose = this.mixer.clipAction(tposeClip);
      }

      // Sample the embedded idle pose before recording socket reference frames.
      this.mixer.update(0);
      this.root.updateMatrixWorld(true);
      this.attachmentBodyInverse.copy(this.bodyGroup.matrixWorld).invert();
      for (const bone of Object.values(this.gltfBones)) {
        if (bone) this.attachmentRest.set(bone,
          new THREE.Matrix4().multiplyMatrices(this.attachmentBodyInverse, bone.matrixWorld));
      }
      this.bindOutfitAttachments();
      // Move weaponSocket into bodyGroup so it tracks mixamorigRightHand at 1:1 world scale
      this.bodyGroup.add(this.weaponSocket);
      this.weaponSocket.position.set(0.18, 1.22, -0.28);

      // Detach interim procedural fallback from live scene graph now that the real GLTF model is active
      this.proceduralFallbackGroup.visible = false;
      this.bodyGroup.remove(this.proceduralFallbackGroup);
      this.isUsingGLTF = true;
    } catch {
      // If cloning or binding fails, keep procedural fallback active
      this.isUsingGLTF = false;
      this.mixer?.stopAllAction();
      if (this.mixer) this.mixer.uncacheRoot(this.mixer.getRoot());
      this.mixer = null;
      this.gltfModelGroup?.removeFromParent();
      this.gltfModelGroup?.traverse(object => {
        if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
      });
      this.gltfBodyMat?.dispose(); this.gltfVisorMat?.dispose();
      this.gltfBodyMat = null; this.gltfVisorMat = null;
      this.gltfModelGroup = null;
      this.gltfActions = {}; this.baseBonePoses.clear(); this.attachmentRest.clear();
      this.rightElbowPivot.add(this.weaponSocket);
      this.bodyGroup.add(this.proceduralFallbackGroup);
      this.proceduralFallbackGroup.visible = true;
      this.rebuildOutfitAttachments();
    }
  }

  private applyOutfitMaterialFinish(): void {
    const profile = getOutfitVisualProfile(this.outfitId);
    this.torsoMat.roughness = profile.roughness;
    this.torsoMat.metalness = profile.metalness;
    this.torsoMat.envMapIntensity = profile.envMapIntensity;
    this.accentMat.roughness = Math.max(0.12, profile.roughness * 0.62);
    this.accentMat.metalness = Math.min(0.72, profile.metalness + 0.18);
    this.accentMat.envMapIntensity = profile.envMapIntensity;
    this.accentMat.emissiveIntensity = profile.visorEmissiveIntensity * 0.5;

    if (this.gltfBodyMat) {
      this.gltfBodyMat.roughness = Math.max(.48, profile.roughness);
      this.gltfBodyMat.metalness = profile.metalness * .65;
      this.gltfBodyMat.envMapIntensity = profile.envMapIntensity;
      if (this.armorTexture && !this.reducedDetail && !this.gltfBodyMat.bumpMap) {
        this.gltfBodyMat.bumpMap = this.armorTexture;
        this.gltfBodyMat.bumpScale = 0.012;
        this.gltfBodyMat.needsUpdate = true;
      }
    }
    if (this.gltfVisorMat) {
      this.gltfVisorMat.roughness = Math.max(0.08, profile.roughness * 0.42);
      this.gltfVisorMat.metalness = Math.min(0.88, profile.metalness + 0.34);
      this.gltfVisorMat.envMapIntensity = profile.envMapIntensity + 0.25;
      this.gltfVisorMat.emissiveIntensity = profile.visorEmissiveIntensity;
    }
  }

  private disposeOutfitAttachments(): void {
    if (!this.outfitAttachmentGroup) return;
    this.attachmentBindings = [];
    this.bodyGroup.remove(this.outfitAttachmentGroup);
    const materials = new Set<THREE.Material>();
    this.outfitAttachmentGroup.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return;
      for (const mat of Array.isArray(child.material) ? child.material : [child.material]) materials.add(mat);
    });
    materials.forEach(material => material.dispose());
    this.outfitAttachmentGroup = null;
  }

  /**
   * Builds one of six compact procedural armor silhouettes using contoured
   * non-box primitives and matte tactical materials fitted flush to the rig.
   */
  private rebuildOutfitAttachments(): void {
    this.disposeOutfitAttachments();
    const profile = getOutfitVisualProfile(this.outfitId);
    const group = new THREE.Group();
    group.name = 'outfit_attachments';
    group.userData.outfitId = profile.id;
    group.userData.armorStyle = profile.armorStyle;

    const tacticalPlateColor = new THREE.Color(0x1e293b).lerp(
      new THREE.Color(this.skinColorHex),
      0.42
    );
    const tacticalTrimColor = new THREE.Color(0x334155).lerp(
      new THREE.Color(this.accentColorHex),
      0.58
    );

    const armorMat = new THREE.MeshStandardMaterial({
      color: tacticalPlateColor,
      map: this.armorTexture,
      roughness: Math.max(0.42, profile.roughness),
      metalness: Math.min(0.55, profile.metalness + 0.12),
      envMapIntensity: profile.envMapIntensity,
      flatShading: false,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: tacticalTrimColor,
      emissive: this.accentColorHex,
      emissiveIntensity: profile.visorEmissiveIntensity * 0.22,
      roughness: Math.max(0.22, profile.roughness * 0.58),
      metalness: Math.min(0.68, profile.metalness + 0.18),
      envMapIntensity: profile.envMapIntensity,
      flatShading: false,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      map: this.armorTexture,
      roughness: Math.min(0.74, profile.roughness + 0.18),
      metalness: 0.28,
      envMapIntensity: profile.envMapIntensity * 0.75,
      flatShading: false,
    });

    const add = (
      name: string,
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      x: number,
      y: number,
      z: number,
      sx: number,
      sy: number,
      sz: number,
      rx: number = 0,
      ry: number = 0,
      rz: number = 0
    ) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `outfit_${profile.armorStyle}_${name}`;
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      mesh.rotation.set(rx, ry, rz);
      mesh.castShadow = true;
      group.add(mesh);
      return mesh;
    };
    const pauldron = (
      side: -1 | 1,
      width: number,
      height: number,
      depth: number,
      material: THREE.Material = armorMat
    ) =>
      add(
        side < 0 ? 'left_pauldron' : 'right_pauldron',
        OUTFIT_PAULDRON_GEO,
        material,
        side * 0.34,
        1.45,
        0,
        width * 0.42,
        height * 0.48,
        depth * 0.42,
        0,
        0,
        side * -0.18
      );

    switch (profile.armorStyle) {
      case 'solar':
        pauldron(-1, 0.22, 0.1, 0.2, accentMat);
        pauldron(1, 0.22, 0.1, 0.2, accentMat);
        add('solar_disc', OUTFIT_CYLINDER_GEO, accentMat, 0, 1.31, -0.22, 0.12, 0.018, 0.12, Math.PI / 2);
        add('solar_core', OUTFIT_OCTA_GEO, armorMat, 0, 1.31, -0.23, 0.065, 0.065, 0.025);
        add('plume', OUTFIT_CONE_GEO, accentMat, 0, 1.92, -0.02, 0.055, 0.11, 0.08, -0.18);
        add('waist_sash', OUTFIT_BOX_GEO, darkMat, 0, 0.98, -0.175, 0.22, 0.038, 0.024, 0, 0, -0.12);
        break;
      case 'phantom':
        pauldron(-1, 0.14, 0.14, 0.16);
        pauldron(1, 0.14, 0.14, 0.16);
        add('diamond_core', OUTFIT_OCTA_GEO, accentMat, 0, 1.3, -0.22, 0.075, 0.1, 0.025);
        add('left_antenna', OUTFIT_CYLINDER_GEO, accentMat, -0.085, 1.91, -0.04, 0.014, 0.11, 0.014, 0, 0, 0.14);
        add('right_antenna', OUTFIT_CYLINDER_GEO, accentMat, 0.085, 1.91, -0.04, 0.014, 0.11, 0.014, 0, 0, -0.14);
        add('stealth_collar', OUTFIT_BOX_GEO, darkMat, 0, 1.52, -0.06, 0.18, 0.042, 0.12, 0.12);
        break;
      case 'ranger':
        pauldron(-1, 0.22, 0.12, 0.22);
        pauldron(1, 0.16, 0.09, 0.18, darkMat);
        add('field_strap', OUTFIT_BOX_GEO, darkMat, 0, 1.3, -0.215, 0.24, 0.036, 0.018, 0, 0, -0.48);
        add('left_pouch', OUTFIT_BOX_GEO, armorMat, -0.125, 0.98, -0.165, 0.068, 0.082, 0.042);
        add('right_pouch', OUTFIT_BOX_GEO, darkMat, 0.125, 0.98, -0.165, 0.068, 0.082, 0.042);
        add('left_sensor_fin', OUTFIT_BOX_GEO, accentMat, -0.09, 1.88, -0.04, 0.022, 0.075, 0.055, 0, 0, 0.12);
        add('right_sensor_fin', OUTFIT_BOX_GEO, accentMat, 0.09, 1.88, -0.04, 0.022, 0.075, 0.055, 0, 0, -0.12);
        break;
      case 'arctic':
        pauldron(-1, 0.21, 0.12, 0.22);
        pauldron(1, 0.21, 0.12, 0.22);
        add('sentinel_collar', OUTFIT_BOX_GEO, armorMat, 0, 1.52, -0.04, 0.2, 0.05, 0.14);
        add('chest_plate', OUTFIT_BOX_GEO, armorMat, 0, 1.29, -0.215, 0.17, 0.14, 0.02);
        add('cryo_strip', OUTFIT_BOX_GEO, accentMat, 0, 1.31, -0.225, 0.032, 0.11, 0.014);
        add('visor_guard', OUTFIT_BOX_GEO, darkMat, 0, 1.82, -0.14, 0.14, 0.026, 0.05, 0.16);
        break;
      case 'crimson':
        pauldron(-1, 0.16, 0.1, 0.18, darkMat);
        pauldron(1, 0.23, 0.13, 0.22);
        add('slash_left', OUTFIT_BOX_GEO, accentMat, -0.055, 1.32, -0.22, 0.11, 0.022, 0.016, 0, 0, -0.52);
        add('slash_right', OUTFIT_BOX_GEO, accentMat, 0.055, 1.24, -0.22, 0.11, 0.022, 0.016, 0, 0, -0.52);
        add('mohawk_fin', OUTFIT_BOX_GEO, accentMat, 0, 1.91, -0.04, 0.02, 0.09, 0.11, -0.08);
        add('striker_core', OUTFIT_OCTA_GEO, darkMat, 0, 1.12, -0.21, 0.06, 0.075, 0.025);
        break;
      case 'vanguard':
      default:
        pauldron(-1, 0.2, 0.11, 0.2);
        pauldron(1, 0.2, 0.11, 0.2);
        add('chevron_left', OUTFIT_BOX_GEO, accentMat, -0.065, 1.32, -0.215, 0.105, 0.022, 0.016, 0, 0, 0.55);
        add('chevron_right', OUTFIT_BOX_GEO, accentMat, 0.065, 1.32, -0.215, 0.105, 0.022, 0.016, 0, 0, -0.55);
        add('chest_core', OUTFIT_OCTA_GEO, accentMat, 0, 1.24, -0.22, 0.065, 0.065, 0.024);
        add('brow_fin', OUTFIT_BOX_GEO, armorMat, 0, 1.86, -0.12, 0.11, 0.022, 0.055, 0.16);
        break;
    }

    this.outfitAttachmentGroup = group;
    this.bodyGroup.add(group);
    this.bindOutfitAttachments();
  }

  /**
   * Fits cosmetic attachments directly onto the rigged GLTF skeleton's actual
   * anatomical surfaces (clavicle/deltoid, sternum, waist belt, and helmet crown)
   * so no pieces float or swing out on lever arms during arm IK or locomotion.
   */
  private bindOutfitAttachments(): void {
    this.attachmentBindings = [];
    if (!this.outfitAttachmentGroup || !this.attachmentRest.size) return;
    this.outfitAttachmentGroup.position.set(0, 0, 0);
    this.outfitAttachmentGroup.rotation.set(0, 0, 0);
    for (const object of this.outfitAttachmentGroup.children) {
      const y = object.position.y;
      const isLeftPauldron = object.name.includes('left_pauldron');
      const isRightPauldron = object.name.includes('right_pauldron');
      const bone =
        y > 1.72
          ? this.gltfBones.head
          : isLeftPauldron
            ? (this.gltfBones.leftShoulder ?? this.gltfBones.spine2)
            : isRightPauldron
              ? (this.gltfBones.rightShoulder ?? this.gltfBones.spine2)
              : y < 1.1
                ? this.gltfBones.hips
                : this.gltfBones.spine2;
      const rest = bone && this.attachmentRest.get(bone);
      if (!bone || !rest) continue;

      // Map fallback coordinates onto the exact surface of soldier.glb
      const gltfPos = object.position.clone();
      const gltfScale = object.scale.clone();
      if (isLeftPauldron) {
        gltfPos.set(-0.182, 1.405, -0.042);
        gltfScale.multiplyScalar(0.76);
      } else if (isRightPauldron) {
        gltfPos.set(0.174, 1.405, 0.012);
        gltfScale.multiplyScalar(0.76);
      } else if (y > 1.72) {
        // Align helmet ornaments flush to the soldier.glb helmet crown/brow
        gltfPos.x *= 0.68;
        gltfPos.y = rest.elements[13] + (y - 1.78) * 0.55 + 0.105;
        gltfPos.z = Math.max(-0.165, object.position.z * 0.85 - 0.035);
        gltfScale.multiplyScalar(0.74);
      } else if (y >= 1.46) {
        // Collar pieces around neck base
        gltfPos.y = 1.43;
        gltfPos.z = -0.045;
        gltfScale.multiplyScalar(0.72);
      } else if (y < 1.1) {
        // Belt & waist pouches flush against lower torso
        gltfPos.x *= 0.82;
        gltfPos.y = 0.99;
        gltfPos.z = -0.158;
        gltfScale.multiplyScalar(0.78);
      } else {
        // Sternum / chest emblems flush against front armor plate
        gltfPos.x *= 0.76;
        gltfPos.y = 1.24 + (y - 1.24) * 0.75;
        gltfPos.z = -0.152;
        gltfScale.multiplyScalar(0.76);
      }

      const authored = new THREE.Matrix4().compose(
        gltfPos,
        object.quaternion,
        gltfScale
      );
      const inverseBind = rest.clone().invert().multiply(authored);
      object.matrixAutoUpdate = false;
      this.attachmentBindings.push({ object, bone, inverseBind });
    }
    this.updateOutfitAttachments();
  }

  private updateOutfitAttachments(): void {
    if (!this.attachmentRest.size) return;
    this.root.updateMatrixWorld(true);
    this.attachmentBodyInverse.copy(this.bodyGroup.matrixWorld).invert();
    if (this.outfitAttachmentGroup?.visible) {
      for (const { object, bone, inverseBind } of this.attachmentBindings) {
        object.matrix
          .multiplyMatrices(this.attachmentBodyInverse, bone.matrixWorld)
          .multiply(inverseBind);
        object.matrixWorldNeedsUpdate = true;
      }
    }
    if (this.jumpPackGroup && this.gltfBones.spine2) {
      const rest = this.attachmentRest.get(this.gltfBones.spine2);
      if (rest) {
        this.attachmentMatrix.copy(rest).invert();
        this.jumpPackGroup.matrixAutoUpdate = false;
        this.jumpPackGroup.matrix
          .multiplyMatrices(this.attachmentBodyInverse, this.gltfBones.spine2.matrixWorld)
          .multiply(this.attachmentMatrix)
          .multiply(this.packOffset);
        this.jumpPackGroup.matrixWorldNeedsUpdate = true;
      }
    }
  }

  private rebuildBackAccessory(): void {
    if (this.jumpPackGroup) {
      this.bodyGroup.remove(this.jumpPackGroup);
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      this.jumpPackGroup.traverse(obj => {
        if (!(obj instanceof THREE.Mesh)) return;
        geometries.add(obj.geometry);
        for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) materials.add(mat);
      });
      geometries.forEach(geometry => geometry.dispose());
      materials.forEach(material => material.dispose());
    }

    this.jumpPackGroup = new THREE.Group();
    this.jumpPackGroup.name = 'back_accessory';
    this.jumpPackGroup.position.set(0, 1.3, 0.205);
    this.bodyGroup.add(this.jumpPackGroup);

    if (this.backAccessoryType === 'none') {
      this.jumpPackGroup.visible = false;
      return;
    }

    const housingColor = new THREE.Color(0x1e293b).lerp(
      new THREE.Color(this.skinColorHex),
      0.28
    );
    const alloyMat = new THREE.MeshStandardMaterial({
      color: housingColor,
      roughness: 0.42,
      metalness: 0.62,
    });
    const darkCarbonMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.56,
      metalness: 0.38,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: this.accentColorHex,
      emissive: this.accentColorHex,
      emissiveIntensity: 0.28,
      roughness: 0.25,
      metalness: 0.55,
    });

    if (this.backAccessoryType === 'energy_wings') {
      const hub = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.042, 0.08, 6, 10),
        darkCarbonMat
      );
      const coreNode = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.036, 1),
        trimMat
      );
      coreNode.position.z = 0.032;
      this.jumpPackGroup.add(hub, coreNode);
      for (const side of [-1, 1]) {
        const upperVane = new THREE.Mesh(
          new THREE.ConeGeometry(0.018, 0.14, 10),
          alloyMat
        );
        upperVane.position.set(side * 0.082, 0.042, 0.012);
        upperVane.rotation.z = side * -0.92;

        const lowerVane = new THREE.Mesh(
          new THREE.ConeGeometry(0.014, 0.11, 10),
          trimMat
        );
        lowerVane.position.set(side * 0.072, -0.036, 0.015);
        lowerVane.rotation.z = side * -1.18;
        this.jumpPackGroup.add(upperVane, lowerVane);
      }
    } else if (this.backAccessoryType === 'tactical_shield') {
      const shieldDisc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.128, 0.136, 0.026, 16),
        darkCarbonMat
      );
      shieldDisc.rotation.x = Math.PI / 2;
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.128, 0.012, 8, 20),
        alloyMat
      );
      rim.position.z = 0.012;
      const crest = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.038, 1),
        trimMat
      );
      crest.scale.set(0.85, 1.15, 0.45);
      crest.position.z = 0.022;
      this.jumpPackGroup.add(shieldDisc, rim, crest);
    } else {
      // 'jump_pack': Compact contoured twin-pod micro-thruster pack flush to back
      const centerSpine = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.048, 0.12, 6, 12),
        darkCarbonMat
      );
      const coreVent = new THREE.Mesh(
        new THREE.CylinderGeometry(0.034, 0.034, 0.024, 12),
        trimMat
      );
      coreVent.rotation.x = Math.PI / 2;
      coreVent.position.set(0, 0.01, 0.04);
      this.jumpPackGroup.add(centerSpine, coreVent);

      for (const side of [-1, 1]) {
        const pod = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.036, 0.13, 6, 12),
          alloyMat
        );
        pod.position.set(side * 0.068, 0.008, 0.008);
        pod.rotation.z = side * 0.08;

        const nozzle = new THREE.Mesh(
          new THREE.CylinderGeometry(0.02, 0.028, 0.045, 10),
          darkCarbonMat
        );
        nozzle.position.set(side * 0.075, -0.095, 0.012);
        nozzle.rotation.z = side * 0.12;
        this.jumpPackGroup.add(pod, nozzle);
      }
    }
    this.updateOutfitAttachments();
  }

  /**
   * Builds the believable multi-cell curved parafoil canopy, stitched rib seams,
   * non-intersecting Kevlar suspension lines, V-risers, steering toggles, and
   * fitted torso harness.
   */
  private rebuildParachuteRig(): void {
    if (!this.gliderGroup) return;
    const oldGeometries = new Set<THREE.BufferGeometry>();
    const oldMaterials = new Set<THREE.Material>();
    this.gliderGroup.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      oldGeometries.add(obj.geometry);
      for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        oldMaterials.add(mat);
      }
    });
    this.gliderGroup.clear();
    oldGeometries.forEach((g) => g.dispose());
    oldMaterials.forEach((m) => m.dispose());

    const fabricTex = createParachuteFabricTexture();
    const canopyMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: fabricTex,
      bumpMap: fabricTex,
      bumpScale: 0.008,
      roughness: 0.68,
      metalness: 0.06,
      side: THREE.DoubleSide,
    });
    const webbingMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.72,
      metalness: 0.18,
    });
    const cordMat = new THREE.MeshStandardMaterial({
      color: 0x475569,
      roughness: 0.55,
      metalness: 0.25,
    });
    const buckleMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      roughness: 0.32,
      metalness: 0.78,
    });
    const toggleMat = new THREE.MeshStandardMaterial({
      color: this.accentColorHex,
      emissive: this.accentColorHex,
      emissiveIntensity: 0.2,
      roughness: 0.35,
      metalness: 0.3,
    });

    // 1. Fitted Parachute Torso Harness & Deployment Container
    const harnessGroup = new THREE.Group();
    harnessGroup.name = 'parachute_harness';

    const backContainer = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.085, 0.16, 6, 12),
      webbingMat
    );
    backContainer.name = 'parachute_pack_container';
    backContainer.scale.set(1.15, 1.0, 0.55);
    backContainer.position.set(0, 1.28, 0.195);

    const chestStrap = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.016, 0.24, 4, 8),
      webbingMat
    );
    chestStrap.name = 'parachute_chest_strap';
    chestStrap.rotation.z = Math.PI / 2;
    chestStrap.position.set(0, 1.31, -0.155);

    const chestBuckle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.022, 0.014, 8),
      buckleMat
    );
    chestBuckle.rotation.x = Math.PI / 2;
    chestBuckle.position.set(0, 1.31, -0.162);
    harnessGroup.add(backContainer, chestStrap, chestBuckle);

    for (const side of [-1, 1]) {
      const shoulderStrap = new THREE.Mesh(
        new THREE.TorusGeometry(0.145, 0.016, 6, 14, Math.PI * 0.95),
        webbingMat
      );
      shoulderStrap.name = side < 0 ? 'parachute_strap_left' : 'parachute_strap_right';
      shoulderStrap.rotation.y = Math.PI / 2;
      shoulderStrap.rotation.x = -0.22;
      shoulderStrap.position.set(side * 0.115, 1.34, 0.015);

      const legStrap = new THREE.Mesh(
        new THREE.TorusGeometry(0.082, 0.014, 6, 12),
        webbingMat
      );
      legStrap.rotation.x = Math.PI / 2 + side * 0.08;
      legStrap.position.set(side * 0.095, 0.96, -0.01);

      const dRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.022, 0.005, 6, 10),
        buckleMat
      );
      dRing.position.set(side * 0.15, 1.43, 0.035);
      harnessGroup.add(shoulderStrap, legStrap, dRing);
    }
    this.parachuteHarnessGroup = harnessGroup;
    this.gliderGroup.add(harnessGroup);

    // 2. Overhead Pivot for Curved Canopy + Risers + Suspension Lines
    const canopyPivot = new THREE.Group();
    canopyPivot.name = 'parachute_canopy_pivot';
    canopyPivot.position.set(0, 1.43, 0.035);
    this.parachuteCanopyPivot = canopyPivot;
    this.gliderGroup.add(canopyPivot);

    const canopyOffsetY = 1.48; // Places canopy apex at y = 2.91m in bodyGroup space
    const canopyGeo = createCurvedParachuteCanopyGeometry(
      this.skinColorHex,
      this.accentColorHex
    );
    const canopyMesh = new THREE.Mesh(canopyGeo, canopyMat);
    canopyMesh.name = 'parachute_canopy_mesh';
    canopyMesh.position.set(0, canopyOffsetY, 0);
    canopyMesh.castShadow = true;
    canopyMesh.receiveShadow = true;
    canopyPivot.add(canopyMesh);

    // Vertical end-cell stabilizer fins at left/right wingtips
    const tipPtFront = new THREE.Vector3();
    const tipPtRear = new THREE.Vector3();
    for (const side of [-1, 1]) {
      sampleParachuteCanopyPoint(side, 0.18, false, tipPtFront);
      sampleParachuteCanopyPoint(side, 0.86, false, tipPtRear);
      const stabilizer = createSuspensionLineMesh(
        side < 0 ? 'canopy_stabilizer_left' : 'canopy_stabilizer_right',
        new THREE.Vector3(tipPtFront.x, canopyOffsetY + tipPtFront.y - 0.11, tipPtFront.z),
        new THREE.Vector3(tipPtRear.x, canopyOffsetY + tipPtRear.y - 0.08, tipPtRear.z),
        0.018,
        webbingMat
      );
      stabilizer.scale.x = 0.35;
      canopyPivot.add(stabilizer);
    }

    // 3. V-Risers, 12 Non-Intersecting Suspension Lines & 2 Brake Control Toggles
    const attachPt = new THREE.Vector3();
    const spanStations = [-0.92, -0.58, -0.24, 0.24, 0.58, 0.92];
    for (const side of [-1, 1]) {
      const shoulderAnchor = new THREE.Vector3(side * 0.15, 0, 0);
      const frontRiserLink = new THREE.Vector3(side * 0.27, 0.42, -0.11);
      const rearRiserLink = new THREE.Vector3(side * 0.27, 0.42, 0.11);

      canopyPivot.add(
        createSuspensionLineMesh(
          side < 0 ? 'riser_left_front' : 'riser_right_front',
          shoulderAnchor,
          frontRiserLink,
          0.011,
          webbingMat
        ),
        createSuspensionLineMesh(
          side < 0 ? 'riser_left_rear' : 'riser_right_rear',
          shoulderAnchor,
          rearRiserLink,
          0.011,
          webbingMat
        )
      );

      // Steering toggle handle held by raised hand + brake control line to trailing wingtip
      const handGripLocal = new THREE.Vector3(side * 0.29, 0.22, -0.14);
      const toggleBar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 0.095, 8),
        toggleMat
      );
      toggleBar.name = side < 0 ? 'steering_toggle_left' : 'steering_toggle_right';
      toggleBar.rotation.z = Math.PI / 2;
      toggleBar.position.copy(handGripLocal);
      canopyPivot.add(toggleBar);

      sampleParachuteCanopyPoint(side * 0.88, 0.92, false, attachPt);
      attachPt.y += canopyOffsetY;
      canopyPivot.add(
        createSuspensionLineMesh(
          side < 0 ? 'brake_line_left' : 'brake_line_right',
          handGripLocal,
          attachPt,
          0.005,
          cordMat
        )
      );
    }

    let lineIdx = 0;
    for (const u of spanStations) {
      const side = u < 0 ? -1 : 1;
      const frontRiserLink = new THREE.Vector3(side * 0.27, 0.42, -0.11);
      const rearRiserLink = new THREE.Vector3(side * 0.27, 0.42, 0.11);

      sampleParachuteCanopyPoint(u, 0.22, false, attachPt);
      attachPt.y += canopyOffsetY;
      canopyPivot.add(
        createSuspensionLineMesh(
          `suspension_line_front_${lineIdx}`,
          frontRiserLink,
          attachPt,
          0.0055,
          cordMat
        )
      );

      sampleParachuteCanopyPoint(u, 0.76, false, attachPt);
      attachPt.y += canopyOffsetY;
      canopyPivot.add(
        createSuspensionLineMesh(
          `suspension_line_rear_${lineIdx}`,
          rearRiserLink,
          attachPt,
          0.0055,
          cordMat
        )
      );
      lineIdx++;
    }
  }

  private updateParachuteRig(
    state: PlayerState,
    dt: number,
    horizSpeed: number,
    facingDelta: number
  ): void {
    if (!state.isGliding || !state.alive) {
      this.parachuteDeployBlend = 0;
      this.gliderGroup.visible = false;
      return;
    }

    this.gliderGroup.visible = true;
    this.parachuteDeployBlend = THREE.MathUtils.lerp(
      this.parachuteDeployBlend,
      1.0,
      1 - Math.exp(-dt * 10)
    );
    const deploy = Math.max(0.25, this.parachuteDeployBlend);

    if (this.parachuteCanopyPivot) {
      const targetBankRoll =
        THREE.MathUtils.clamp(-facingDelta * 2.1, -0.26, 0.26) +
        Math.sin(this.animTime * 2.4) * 0.032;
      const targetForwardPitch =
        THREE.MathUtils.clamp(horizSpeed * 0.012, 0.02, 0.14) +
        Math.cos(this.animTime * 1.9) * 0.018;

      this.parachuteCanopyPivot.rotation.z = THREE.MathUtils.lerp(
        this.parachuteCanopyPivot.rotation.z,
        targetBankRoll,
        1 - Math.exp(-dt * 10)
      );
      this.parachuteCanopyPivot.rotation.x = THREE.MathUtils.lerp(
        this.parachuteCanopyPivot.rotation.x,
        targetForwardPitch,
        1 - Math.exp(-dt * 10)
      );
      const cellBreathX = 1 + Math.sin(this.animTime * 3.6) * 0.016;
      const cellBreathY = 1 + Math.cos(this.animTime * 4.2) * 0.024;
      this.parachuteCanopyPivot.scale.set(
        deploy * cellBreathX,
        deploy * cellBreathY,
        deploy
      );
    }
  }

  /**
   * Visual-only cosmetic update: changes outfit armor tint, visor glow, and back accessory
   * without affecting hitboxes, collision capsules, movement speed, or damage.
   */
  public setCosmetics(
    skinColor: number,
    accentColor: number,
    backAccessory: BackAccessoryType = 'jump_pack',
    outfitId: OutfitPresetId = this.outfitId
  ): void {
    const nextOutfitId = normalizeOutfitPresetId(outfitId);
    const changed =
      this.skinColorHex !== skinColor ||
      this.accentColorHex !== accentColor ||
      this.backAccessoryType !== backAccessory ||
      this.outfitId !== nextOutfitId;
    if (!changed) return;

    this.outfitId = nextOutfitId;
    this.skinColorHex = skinColor;
    this.accentColorHex = accentColor;
    this.backAccessoryType = backAccessory;

    this.torsoMat.color.setHex(skinColor);
    this.accentMat.color.setHex(accentColor);
    this.accentMat.emissive.setHex(accentColor);
    if (this.gltfVisorMat) {
      this.gltfVisorMat.color.setHex(accentColor);
      this.gltfVisorMat.emissive.setHex(accentColor);
    }
    if (this.gltfBodyMat) {
      const baseTint = new THREE.Color(skinColor);
      const hsl = { h: 0, s: 0, l: 0 };
      baseTint.getHSL(hsl);
      baseTint.setHSL(
        hsl.h,
        Math.min(0.85, hsl.s * 0.95),
        THREE.MathUtils.clamp(hsl.l, 0.32, 0.58)
      );
      const tinted = new THREE.Color(0xe2e8f0).lerp(baseTint, 0.52);
      this.gltfBodyMat.color.copy(tinted);
    }

    this.applyOutfitMaterialFinish();
    this.rebuildBackAccessory();
    this.rebuildParachuteRig();
    this.rebuildOutfitAttachments();
  }

  public triggerAttackAnimation(isFirearm: boolean = true): void {
    this.attackSwingTimer = 0.22;
    if (isFirearm) {
      const cat = this.activeWeaponCategory;
      this.muzzleFlashDuration =
        cat === 'shotgun' ||
        cat === 'tactical_shotgun' ||
        cat === 'sniper' ||
        cat === 'dmr' ||
        cat === 'heavy_pistol'
          ? 0.085
          : 0.06;
      this.muzzleFlashTimer = this.muzzleFlashDuration;
      this.muzzleFlashMesh.visible = true;
      this.muzzleFlashMesh.rotation.z = Math.random() * Math.PI;
      const baseScale =
        cat === 'shotgun'
          ? 1.35
          : cat === 'tactical_shotgun'
            ? 1.18
            : cat === 'sniper'
              ? 1.25
              : cat === 'dmr'
                ? 1.08
                : cat === 'heavy_pistol'
                  ? 1.02
                  : cat === 'smg'
                    ? 0.78
                    : cat === 'pistol'
                      ? 0.72
                      : 0.95;
      const scale = baseScale + Math.random() * 0.45;
      const zStretch =
        cat === 'sniper'
          ? 2.2
          : cat === 'dmr'
            ? 1.9
            : cat === 'shotgun' || cat === 'tactical_shotgun'
              ? 1.35
              : 1.55;
      this.muzzleFlashBaseScale.set(scale, scale, scale * zStretch);
      this.muzzleFlashMesh.scale.copy(this.muzzleFlashBaseScale);

      const outer = this.muzzleFlashMesh.children[1] as THREE.Mesh | undefined;
      if (outer && outer.material) {
        const mat = outer.material as THREE.MeshBasicMaterial;
        mat.color.setHex(
          cat === 'sniper' || cat === 'dmr' ? 0x38bdf8
            : cat === 'burst_rifle' ? 0xa5f3fc
            : cat === 'heavy_pistol' ? 0xfda4af
            : cat === 'shotgun' || cat === 'tactical_shotgun' ? 0xf97316 : 0xfacc15
        );
      }
    }
  }

  public triggerHitFlash(
    isHeadshot: boolean = false,
    isShieldHit: boolean = false
  ): void {
    this.hitFlashTimer = 0.16;
    this.hitReactionTimer = 0.18;
    this.isHeadshotFlinch = isHeadshot;
    this.isShieldHitFlash = isShieldHit;
    this.hitFlinchDir = this.hitFlinchDir > 0 ? -1 : 1;
  }

  public equipWeaponModel(category: WeaponCategory, rarity: WeaponRarity): void {
    this.activeWeaponCategory = category;
    const key = `${category}_${rarity}`;
    if (this.currentWeaponKey === key) return;
    this.currentWeaponKey = key;
    this.equipAnimTimer = 0.14;

    for (let i = this.weaponSocket.children.length - 1; i >= 0; i--) {
      const child = this.weaponSocket.children[i];
      if (child !== this.muzzleFlashMesh) {
        this.weaponSocket.remove(child);
      }
    }

    const model = createWeaponMesh(category, rarity);
    model.traverse((child) => {
      if (child.name !== 'weapon_mag' && child.name !== 'weapon_slide') return;
      if (typeof child.userData.baseX !== 'number') child.userData.baseX = child.position.x;
      if (typeof child.userData.baseY !== 'number') child.userData.baseY = child.position.y;
      if (typeof child.userData.baseZ !== 'number') child.userData.baseZ = child.position.z;
    });
    this.weaponSocket.add(model);
    if (category === 'harvester') {
      model.rotation.x = -Math.PI / 3;
    } else {
      const tip = model.getObjectByName('muzzle_tip');
      if (tip) {
        this.root.updateMatrixWorld(true);
        tip.getWorldPosition(this.tempHandWorldPos);
        this.muzzleFlashMesh.position.copy(this.weaponSocket.worldToLocal(this.tempHandWorldPos));
      }
    }
    this.weaponMicroDetails = model.getObjectByName('weapon_micro_details');
    this.weaponMagazine = model.getObjectByName('weapon_mag');
    this.weaponSlide = model.getObjectByName('weapon_slide');
    if (this.weaponMagazine) this.weaponMagazineRotation.copy(this.weaponMagazine.rotation);
  }

  public update(state: PlayerState, dt: number, cameraPos?: THREE.Vector3): void {
    if (this.disposed) return;
    if (this.wasAlive && !state.alive) this.eliminationTimer = 0.3;
    if (!this.wasAlive && state.alive) {
      this.root.scale.setScalar(1);
      this.locomotionPhase = 0; this.accumulatedFallbackDt = 0;
      this.equipAnimTimer = 0.14;
      this.landingTimer = 0;
      this.wasGrounded = state.isGrounded;
    }
    this.wasAlive = state.alive;
    if (!state.alive) {
      this.presentationState = 'eliminated';
      this.eliminationTimer = Math.max(0, this.eliminationTimer - dt);
      this.root.visible = this.eliminationTimer > 0;
      this.root.scale.setScalar(this.eliminationTimer / 0.3);
      this.muzzleFlashMesh.visible = false;
      return;
    }
    this.root.visible = true;
    if (!this.wasGrounded && state.isGrounded && !state.isGliding) this.landingTimer = 0.18;
    this.wasGrounded = state.isGrounded;
    this.landingTimer = Math.max(0, this.landingTimer - dt);
    this.presentationState = selectPresentationState(state, this.attackSwingTimer,
      this.equipAnimTimer, this.landingTimer);

    this.setCosmetics(
      state.skinColor,
      state.accentColor,
      state.backAccessory || 'jump_pack',
      state.outfitId || this.outfitId
    );

    this.root.position.set(state.position.x, state.position.y, state.position.z);

    const targetFacing = state.facingYaw ?? state.yaw;
    let facingDelta = ((targetFacing - this.visualFacingYaw + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (facingDelta < -Math.PI) facingDelta += Math.PI * 2;
    const horizontalSpeedForLean = Math.hypot(state.velocity.x, state.velocity.z);
    this.turnLean = getTurnLean(
      this.turnLean,
      facingDelta,
      dt,
      horizontalSpeedForLean,
      state.isAiming
    );
    this.visualFacingYaw = lerpAngle(
      this.visualFacingYaw,
      targetFacing,
      1 - Math.exp(-dt * 15)
    );
    this.bodyGroup.rotation.y = this.visualFacingYaw;
    this.bodyGroup.rotation.z = this.turnLean * 0.45;

    const slot = state.inventory[state.activeSlot];
    if (slot) {
      this.equipWeaponModel(slot.category, slot.rarity);
    } else {
      this.equipWeaponModel('harvester', 'rare');
    }

    const switchPose = getWeaponSwitchPose(this.equipAnimTimer, 0.14);
    const drawTilt = switchPose.pitchOffset;
    this.weaponSwitchDipY = switchPose.dipY;
    this.weaponSwitchRoll = switchPose.roll;
    if (this.equipAnimTimer > 0) {
      this.equipAnimTimer = Math.max(0, this.equipAnimTimer - dt);
    }

    this.updateParachuteRig(state, dt, horizontalSpeedForLean, facingDelta);
    this.weaponSocket.visible = !state.isGliding;
    if (state.isGliding) {
      this.muzzleFlashMesh.visible = false;
    }

    if (this.muzzleFlashTimer > 0) {
      this.muzzleFlashTimer = Math.max(0, this.muzzleFlashTimer - dt);
      const flashRatio = THREE.MathUtils.clamp(
        this.muzzleFlashTimer / Math.max(0.001, this.muzzleFlashDuration),
        0,
        1
      );
      this.muzzleFlashMesh.scale
        .copy(this.muzzleFlashBaseScale)
        .multiplyScalar(0.72 + flashRatio * 0.28);
      for (const child of this.muzzleFlashMesh.children) {
        const mesh = child as THREE.Mesh;
        const mat = mesh.material as THREE.MeshBasicMaterial | undefined;
        if (!mat) continue;
        const baseOpacity =
          typeof mesh.userData.baseOpacity === 'number'
            ? mesh.userData.baseOpacity
            : 0.85;
        mat.opacity = baseOpacity * flashRatio;
      }
      if (this.muzzleFlashTimer <= 0) {
        this.muzzleFlashMesh.visible = false;
      }
    }

    if (this.hitFlashTimer > 0) {
      this.hitFlashTimer = Math.max(0, this.hitFlashTimer - dt);
      const flashColor = this.isHeadshotFlinch
        ? 0xfef08a
        : this.isShieldHitFlash
        ? 0x38bdf8
        : 0xffffff;
      this.torsoMat.emissive.setHex(flashColor);
      this.torsoMat.emissiveIntensity = 0.68;
      if (this.gltfBodyMat) {
        this.gltfBodyMat.emissive.setHex(flashColor);
        this.gltfBodyMat.emissiveIntensity = 0.58;
      }
    } else {
      this.torsoMat.emissive.setHex(0x000000);
      this.torsoMat.emissiveIntensity = 0;
      if (this.gltfBodyMat) {
        this.gltfBodyMat.emissive.setHex(0x000000);
        this.gltfBodyMat.emissiveIntensity = 0;
      }
    }
    if (this.hitReactionTimer > 0) {
      this.hitReactionTimer = Math.max(0, this.hitReactionTimer - dt);
    }

    const shieldMat = this.shieldAura.material as THREE.MeshBasicMaterial;
    shieldMat.opacity = state.shield > 0 && this.hitFlashTimer > 0 ? 0.35 : 0.0;

    let distToCamera = 0;
    if (cameraPos) {
      distToCamera = cameraPos.distanceTo(this.root.position);
    }
    if (this.weaponMicroDetails) this.weaponMicroDetails.visible = distToCamera < (this.reducedDetail ? 22 : 55);
    if (this.outfitAttachmentGroup) {
      // Cosmetic micro-geometry is the first character detail shed at range;
      // the body, weapon and back accessory remain visible.
      this.outfitAttachmentGroup.visible = !cameraPos || distToCamera <= (this.reducedDetail ? 35 : 70);
    }

    if (state.isBot && cameraPos && (state.health < 100 || state.shield < 50)) {
      if (distToCamera < 48) {
        this.overheadBarGroup.visible = true;
        this.overheadBarGroup.lookAt(cameraPos);
        const hRatio = Math.max(0.01, state.health / state.maxHealth);
        const sRatio = Math.max(0.001, state.shield / state.maxShield);
        this.overheadHealthFill.scale.x = hRatio;
        this.overheadShieldFill.scale.x = sRatio;
        this.overheadShieldFill.visible = state.shield > 0;
      } else {
        this.overheadBarGroup.visible = false;
      }
    } else {
      this.overheadBarGroup.visible = false;
    }

    // Landing Impact Squash & Knee Compression
    let landDipY = 0;
    if (this.landingTimer > 0) {
      const squash = Math.sin((this.landingTimer / 0.18) * Math.PI) * 0.035;
      this.bodyGroup.scale.set(1 + squash * 0.4, 1 - squash, 1 + squash * 0.4);
      landDipY = -squash * 0.35;
    } else {
      this.bodyGroup.scale.set(1, 1, 1);
    }

    // Determine Locomotion Animation State
    const horizSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    if (state.isGliding) {
      this.currentAnimState = 'glide';
    } else if (!state.isGrounded) {
      this.currentAnimState = state.velocity.y > 1.2 ? 'jump' : 'fall';
    } else if (horizSpeed > 0.45) {
      if (state.isSprinting || horizSpeed > 8.2) {
        this.currentAnimState = 'sprint';
      } else if (horizSpeed > 4.6) {
        this.currentAnimState = 'run';
      } else {
        this.currentAnimState = 'walk';
      }
    } else {
      this.currentAnimState = this.landingTimer > 0 ? 'land' : 'idle';
    }

    const activeCat = slot ? slot.category : 'harvester';
    const isLongGun =
      activeCat === 'assault_rifle' ||
      activeCat === 'burst_rifle' ||
      activeCat === 'dmr' ||
      activeCat === 'shotgun' ||
      activeCat === 'tactical_shotgun' ||
      activeCat === 'smg' ||
      activeCat === 'sniper';

    if (this.isUsingGLTF && this.mixer) {
      this.updateRiggedGLTFAnimation(
        state,
        dt,
        horizSpeed,
        activeCat,
        isLongGun,
        drawTilt,
        distToCamera
      );
    } else {
      this.accumulatedFallbackDt += dt;
      const interval = getCharacterAnimationInterval(distToCamera,this.reducedDetail,
        state.isReloading || state.isAiming || this.attackSwingTimer > 0);
      if (this.accumulatedFallbackDt + .00001 < interval) return;
      const stepDt = Math.min(.2,this.accumulatedFallbackDt);
      this.accumulatedFallbackDt = 0;
      this.updateProceduralFallbackAnimation(
        state,
        stepDt,
        horizSpeed,
        landDipY,
        activeCat,
        isLongGun,
        drawTilt
      );
    }
    // Component mechanics are shared by both character paths. A cylinder swings
    // out sideways, a drum lowers as a unit; neither pretends to be a box mag.
    if (this.weaponMagazine) {
      const mag = this.weaponMagazine;
      mag.position.x = mag.userData.baseX;
      mag.rotation.copy(this.weaponMagazineRotation);
      const pose = getReloadAnimationPose(state.reloadTimer, state.reloadDuration, this.reloadAnimClock);
      const style = getWeaponVisualProfile(activeCat).magazineStyle;
      if (state.isReloading && style === 'cylinder') {
        const swing = Math.sin(pose.progress * Math.PI);
        mag.position.y = mag.userData.baseY;
        mag.position.x -= swing * 0.09;
        mag.rotation.z += swing * 0.45;
      } else if (state.isReloading && style === 'drum') {
        mag.rotation.x += Math.sin(pose.progress * Math.PI) * 0.18;
      }
    }
  }

  /**
   * Drives the real Soldier.glb AnimationMixer (Idle, Walk, Run clips) with
   * velocity-proportional stride timeScale and smooth upper-body pose blending
   * for Sprint, Jump, Fall, Land, Aim, Shoot, Reload, Weapon Sway, and Right-Hand Tracking.
   */
  private updateClipLayers(state: PlayerState, dt: number): void {
    const upper = state.isGliding || this.activeWeaponCategory === 'harvester' ? null
      : state.isReloading ? 'reload' : this.equipAnimTimer > 0 ? 'switch'
      : this.attackSwingTimer > 0 ? 'shoot' : state.isAiming ? 'aim' : 'ready';
    const blend = 1 - Math.exp(-dt * 18);
    for (const key of ['jump', 'fall', 'land', 'aim', 'shoot', 'reload', 'ready', 'switch', 'sprint'] as const) {
      const action = this.gltfActions[key];
      if (!action) continue;
      const selected = key === upper || key === this.currentAnimState;
      action.setEffectiveWeight(THREE.MathUtils.lerp(action.getEffectiveWeight(), selected ? 1 : 0, blend));
      if (key === 'reload' || key === 'switch' || key === 'shoot' || key === 'land') {
        const progress = key === 'reload'
          ? getReloadAnimationPose(state.reloadTimer, state.reloadDuration, this.reloadAnimClock).progress
          : key === 'switch' ? 1 - this.equipAnimTimer / 0.14
          : key === 'shoot' ? 1 - this.attackSwingTimer / 0.22 : 1 - this.landingTimer / 0.18;
        action.paused = true;
        action.time = THREE.MathUtils.clamp(progress, 0, 1) * action.getClip().duration;
      }
    }
    // Sprint uses its own derived Run clip rather than doubling the run action.
    if (this.gltfActions.run) this.gltfActions.run.setEffectiveWeight(
      this.gltfActions.run.getEffectiveWeight() * (1 - (this.gltfActions.sprint?.getEffectiveWeight() ?? 0)));
    this.gltfActions.sprint?.setEffectiveTimeScale(Math.max(1, Math.min(1.5,
      Math.hypot(state.velocity.x, state.velocity.z) / 7.2)));
  }

  private updateRiggedGLTFAnimation(
    state: PlayerState,
    dt: number,
    horizSpeed: number,
    activeCat: WeaponCategory,
    isLongGun: boolean,
    drawTilt: number,
    distToCamera: number
  ): void {
    // Time-based budgets behave consistently on both 30Hz phones and 144Hz desktops.
    this.accumulatedMixerDt += dt;
    const interval = getCharacterAnimationInterval(distToCamera, this.reducedDetail,
      state.isAiming || state.isReloading || this.attackSwingTimer > 0 || this.landingTimer > 0);
    if (this.accumulatedMixerDt + 0.00001 < interval) return;
    const stepDt = Math.min(0.2, this.accumulatedMixerDt);
    this.accumulatedMixerDt = 0;

    this.animTime += stepDt * 4.0;
    const blend = 1 - Math.exp(-stepDt * 12);

    // Smooth upper-body & airborne blend weights to eliminate sudden pose snaps
    this.aimPoseBlend = THREE.MathUtils.lerp(
      this.aimPoseBlend,
      state.isAiming ? 1.0 : 0.0,
      1 - Math.exp(-stepDt * 14)
    );
    this.reloadPoseBlend = THREE.MathUtils.lerp(
      this.reloadPoseBlend,
      state.isReloading ? 1.0 : 0.0,
      1 - Math.exp(-stepDt * 12)
    );
    // Procedural weapon sway from turn angular velocity + movement bob
    let yawDelta = state.yaw - this.prevAimYaw;
    if (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    if (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    const pitchDelta = state.pitch - this.prevAimPitch;
    this.prevAimYaw = state.yaw;
    this.prevAimPitch = state.pitch;

    const swayDamp = 1.0 - this.aimPoseBlend * 0.68;
    this.swayYawOffset = THREE.MathUtils.lerp(
      this.swayYawOffset,
      THREE.MathUtils.clamp(-yawDelta * 1.6 * swayDamp, -0.14, 0.14),
      1 - Math.exp(-stepDt * 12)
    );
    this.swayPitchOffset = THREE.MathUtils.lerp(
      this.swayPitchOffset,
      THREE.MathUtils.clamp(-pitchDelta * 1.4 * swayDamp, -0.12, 0.12),
      1 - Math.exp(-stepDt * 12)
    );

    // 1. Blend Real GLB AnimationAction Weights (Idle, Walk, Run/Sprint) with Stride Matching
    const locomotion = getLocomotionBlend(
      horizSpeed,
      state.isSprinting,
      state.isGrounded,
      state.isGliding
    );
    const targetIdleW = locomotion.idle;
    const targetWalkW = locomotion.walk;
    const targetRunW = locomotion.run;
    const walkTimeScale = locomotion.walkTimeScale;
    const runTimeScale = locomotion.runTimeScale;

    if (this.gltfActions.idle) {
      const w = THREE.MathUtils.lerp(
        this.gltfActions.idle.getEffectiveWeight(),
        targetIdleW,
        blend
      );
      this.gltfActions.idle.setEffectiveWeight(w);
    }
    if (this.gltfActions.walk) {
      const w = THREE.MathUtils.lerp(
        this.gltfActions.walk.getEffectiveWeight(),
        targetWalkW,
        blend
      );
      this.gltfActions.walk.setEffectiveWeight(w);
      this.gltfActions.walk.setEffectiveTimeScale(walkTimeScale);
    }
    if (this.gltfActions.run) {
      const w = THREE.MathUtils.lerp(
        this.gltfActions.run.getEffectiveWeight(),
        targetRunW,
        blend
      );
      this.gltfActions.run.setEffectiveWeight(w);
      this.gltfActions.run.setEffectiveTimeScale(runTimeScale);
    }

    this.updateClipLayers(state, stepDt);
    // Undo previous procedural overlays before the mixer samples the next frame.
    // Some bones have no tracks after pruning, so relying on mixer overwrite is unsafe.
    for (const [bone, quaternion] of this.baseBonePoses) bone.quaternion.copy(quaternion);
    // Locomotion clips have different durations; sampling a shared normalized
    // phase prevents opposing footfalls when Walk, Run and Sprint crossfade.
    const walkCycle = (this.gltfActions.walk?.getClip().duration ?? 1) / walkTimeScale;
    const runCycle = (this.gltfActions.run?.getClip().duration ?? 1) / runTimeScale;
    const cycle = 1 / THREE.MathUtils.lerp(1 / walkCycle,1 / runCycle,locomotion.run);
    if (horizSpeed > .1 && state.isGrounded && !state.isGliding) {
      this.locomotionPhase = advanceLocomotionPhase(this.locomotionPhase,stepDt,cycle);
    }
    this.sampleGaitAction(this.gltfActions.walk);
    this.sampleGaitAction(this.gltfActions.run);
    this.sampleGaitAction(this.gltfActions.sprint);
    this.mixer!.update(stepDt);
    for (const [bone, quaternion] of this.baseBonePoses) quaternion.copy(bone.quaternion);

    const b = this.gltfBones;

    // Airborne offsets are now mixer actions; do not apply the same pose twice.
    if (this.currentAnimState === 'sprint' && b.spine1) b.spine1.rotation.x += 0.1;

    // 3. Layer Head & Spine Aiming Tracking + Non-Interrupting Hit Reaction Flinch
    let relHeadYaw =
      ((state.yaw - this.visualFacingYaw + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (relHeadYaw < -Math.PI) relHeadYaw += Math.PI * 2;
    const flinchWave =
      this.hitReactionTimer > 0
        ? Math.sin((this.hitReactionTimer / 0.18) * Math.PI)
        : 0;
    if (b.head) {
      b.head.rotation.y += Math.max(-0.55, Math.min(0.55, relHeadYaw * 0.65));
      b.head.rotation.x +=
        state.pitch * 0.35 -
        flinchWave * (this.isHeadshotFlinch ? 0.28 : 0.12);
      if (flinchWave > 0) {
        b.head.rotation.z += flinchWave * 0.08 * this.hitFlinchDir;
      }
    }
    if (b.spine2) {
      b.spine2.rotation.x +=
        -state.pitch * (0.26 + this.aimPoseBlend * 0.1) - flinchWave * 0.15;
      b.spine2.rotation.z += this.turnLean * 0.55;
      if (flinchWave > 0) {
        b.spine2.rotation.z += flinchWave * 0.07 * this.hitFlinchDir;
      }
    }

    // 4. Layer Upper-Body Weapon Hold, Aiming, Weapon-Specific Recoil & Multi-Stage Reloading on Mixamo Arm Bones
    let recoilKick = 0;
    let pumpOrBoltFollow = 0;
    if (this.attackSwingTimer > 0) {
      this.attackSwingTimer = Math.max(0, this.attackSwingTimer - stepDt);
      const progress = 1 - this.attackSwingTimer / 0.22;
      const kickAmp =
        activeCat === 'shotgun'
          ? 0.38
          : activeCat === 'tactical_shotgun'
            ? 0.3
            : activeCat === 'sniper'
              ? 0.36
              : activeCat === 'heavy_pistol'
                ? 0.34
                : activeCat === 'dmr'
                  ? 0.3
                  : activeCat === 'pistol'
                    ? 0.26
                    : activeCat === 'smg'
                      ? 0.18
                      : 0.25;
      recoilKick = Math.sin((this.attackSwingTimer / 0.22) * Math.PI) * kickAmp;
      if (
        (activeCat === 'shotgun' || activeCat === 'sniper' || activeCat === 'dmr') &&
        progress > 0.45
      ) {
        pumpOrBoltFollow =
          Math.sin(((progress - 0.45) / 0.55) * Math.PI) * 0.12;
      }
    }

    let reloadBoltPull = 0;

    if (state.isGliding) {
      if (b.rightUpLeg) b.rightUpLeg.rotation.x -= 0.22;
      if (b.leftUpLeg) b.leftUpLeg.rotation.x -= 0.18;
      if (b.rightLeg) b.rightLeg.rotation.x += 0.36;
      if (b.leftLeg) b.leftLeg.rotation.x += 0.32;
      this.alignGliderHands();
    } else if (state.isReloading || this.reloadPoseBlend > 0.05) {
      this.reloadAnimClock += stepDt;
      const magMesh = this.weaponMagazine;
      const reloadPose = getReloadAnimationPose(
        state.reloadTimer,
        state.reloadDuration,
        this.reloadAnimClock
      );
      reloadBoltPull = reloadPose.boltPull;
      if (magMesh) {
        const baseMagY =
          typeof magMesh.userData.baseY === 'number' ? magMesh.userData.baseY : -0.09;
        magMesh.position.y = baseMagY + reloadPose.magazineOffsetY;
      }
    } else {
      this.reloadAnimClock = 0;
      const magMesh = this.weaponMagazine;
      if (magMesh) {
        magMesh.position.y =
          typeof magMesh.userData.baseY === 'number' ? magMesh.userData.baseY : -0.09;
      }

      if (activeCat === 'harvester') {
        const swing =
          this.attackSwingTimer > 0
            ? Math.sin((this.attackSwingTimer / 0.22) * Math.PI) * 1.15
            : 0;
        if (b.rightArm) b.rightArm.rotation.set(0.1, 0.65 + swing * 0.5, 1.15 + swing);
        if (b.rightForeArm) b.rightForeArm.rotation.set(0.95, 0.2, 0.35);
      }
    }


    // 5. Sync weaponSocket position to mixamorigRightHand & jumpPackGroup to mixamorigSpine2 in bodyGroup space
    const moveBobY =
      horizSpeed > 0.5 && state.isGrounded
        ? Math.sin(this.animTime * 2.2) * 0.012 * (1 - this.aimPoseBlend * 0.7)
        : 0;
    const adsCenterOffsetX = -this.aimPoseBlend * 0.035;
    const adsLiftOffsetY = this.aimPoseBlend * 0.03;
    const harvesterSwingPitch =
      activeCat === 'harvester' && this.attackSwingTimer > 0
        ? -Math.sin((this.attackSwingTimer / 0.22) * Math.PI) * 0.85
        : 0;

    if (!state.isGliding && b.rightHand && this.gltfModelGroup && distToCamera < 72) {
      this.root.updateMatrixWorld(true);
      b.rightHand.getWorldPosition(this.tempHandWorldPos);
      this.bodyGroup.worldToLocal(this.tempHandWorldPos);
      this.weaponSocket.position.set(
        this.tempHandWorldPos.x + 0.04 + adsCenterOffsetX,
        this.tempHandWorldPos.y + 0.04 + adsLiftOffsetY + moveBobY + this.weaponSwitchDipY,
        this.tempHandWorldPos.z - 0.1 + recoilKick * 0.14
      );
      this.weaponSocket.rotation.set(
        state.pitch * 0.65 - recoilKick * 0.45 + drawTilt + this.swayPitchOffset + harvesterSwingPitch,
        this.swayYawOffset,
        -this.swayYawOffset * 0.5 + this.weaponSwitchRoll
      );
    } else if (!state.isGliding) {
      this.weaponSocket.position.set(
        0.18 + adsCenterOffsetX,
        1.22 + adsLiftOffsetY + moveBobY + this.weaponSwitchDipY,
        -0.28 + recoilKick * 0.14
      );
      this.weaponSocket.rotation.set(
        state.pitch * 0.65 - recoilKick * 0.45 + drawTilt + this.swayPitchOffset + harvesterSwingPitch,
        this.swayYawOffset,
        -this.swayYawOffset * 0.5 + this.weaponSwitchRoll
      );
    }

    const slideMesh = this.weaponSlide;
    if (slideMesh) {
      const baseZ =
        typeof slideMesh.userData?.baseZ === 'number'
          ? slideMesh.userData.baseZ
          : -0.16;
      slideMesh.position.z =
        baseZ + Math.max(recoilKick * 0.18, reloadBoltPull, pumpOrBoltFollow);
    }

    if (distToCamera < (this.reducedDetail ? 22 : 45) && !state.isReloading &&
        this.reloadPoseBlend < 0.05 && !state.isGliding && activeCat !== 'harvester') {
      this.alignSupportHand(activeCat);
    }
    this.updateOutfitAttachments();
  }

  private sampleGaitAction(action: THREE.AnimationAction | undefined): void {
    if (!action) return;
    action.paused = true;
    action.time = this.locomotionPhase * action.getClip().duration;
  }

  private alignArmIK(
    upper: THREE.Object3D | undefined,
    lower: THREE.Object3D | undefined,
    hand: THREE.Object3D | undefined,
    targetWorld: THREE.Vector3,
    preferredPoleWorld?: THREE.Vector3
  ): void {
    if (!upper || !lower || !hand) return;
    const [a, b, c, target, axis, pole, elbow, direction] = this.ikPoints;
    this.root.updateMatrixWorld(true);
    upper.getWorldPosition(a);
    lower.getWorldPosition(b);
    hand.getWorldPosition(c);
    target.copy(targetWorld);
    const l1 = a.distanceTo(b);
    const l2 = b.distanceTo(c);
    if (l1 < 0.001 || l2 < 0.001) return;
    axis.subVectors(target, a);
    const distance = THREE.MathUtils.clamp(
      axis.length(),
      Math.abs(l1 - l2) + 0.001,
      l1 + l2 - 0.001
    );
    axis.normalize();
    target.copy(a).addScaledVector(axis, distance);
    if (preferredPoleWorld) {
      pole
        .copy(preferredPoleWorld)
        .addScaledVector(axis, -preferredPoleWorld.dot(axis));
    } else {
      pole
        .subVectors(b, a)
        .addScaledVector(axis, -direction.subVectors(b, a).dot(axis));
    }
    if (pole.lengthSq() < 0.00001) pole.set(0, -1, 0).addScaledVector(axis, axis.y);
    pole.normalize();
    const along = (l1 * l1 - l2 * l2 + distance * distance) / (2 * distance);
    elbow
      .copy(a)
      .addScaledVector(axis, along)
      .addScaledVector(pole, Math.sqrt(Math.max(0, l1 * l1 - along * along)));
    const [rotation, world, parent, delta] = this.ikRotations;
    const rotateTo = (
      bone: THREE.Object3D,
      from: THREE.Vector3,
      to: THREE.Vector3,
      origin: THREE.Vector3
    ) => {
      axis.subVectors(from, origin).normalize();
      direction.subVectors(to, origin).normalize();
      delta.setFromUnitVectors(axis, direction);
      bone.getWorldQuaternion(world);
      bone.parent!.getWorldQuaternion(parent).invert();
      rotation.copy(parent).multiply(delta).multiply(world);
      bone.quaternion.copy(rotation);
      bone.updateWorldMatrix(false, true);
    };
    rotateTo(upper, b, elbow, a);
    lower.getWorldPosition(b);
    hand.getWorldPosition(c);
    rotateTo(lower, c, target, b);
  }

  /** Aligns both hands symmetrically to the overhead parachute steering toggles. */
  private alignGliderHands(): void {
    const b = this.gltfBones;
    this.root.updateMatrixWorld(true);
    const leftToggle = this.parachuteCanopyPivot?.getObjectByName('steering_toggle_left');
    const rightToggle = this.parachuteCanopyPivot?.getObjectByName('steering_toggle_right');

    const leftTarget = new THREE.Vector3(-0.27, 1.76, -0.09);
    const rightTarget = new THREE.Vector3(0.27, 1.76, -0.09);
    if (leftToggle) {
      leftToggle.getWorldPosition(leftTarget);
    } else {
      this.bodyGroup.localToWorld(leftTarget);
    }
    if (rightToggle) {
      rightToggle.getWorldPosition(rightTarget);
    } else {
      this.bodyGroup.localToWorld(rightTarget);
    }

    const leftPole = new THREE.Vector3(-0.65, -0.35, -0.45)
      .applyQuaternion(this.root.quaternion)
      .normalize();
    const rightPole = new THREE.Vector3(0.65, -0.35, -0.45)
      .applyQuaternion(this.root.quaternion)
      .normalize();

    this.alignArmIK(b.leftArm, b.leftForeArm, b.leftHand, leftTarget, leftPole);
    this.alignArmIK(b.rightArm, b.rightForeArm, b.rightHand, rightTarget, rightPole);
  }

  /** Two-bone support-hand IK. Cosmetic only; the gameplay ray never reads it. */
  private alignSupportHand(category: WeaponCategory): void {
    const upper = this.gltfBones.leftArm,
      lower = this.gltfBones.leftForeArm,
      hand = this.gltfBones.leftHand;
    if (!upper || !lower || !hand) return;
    this.root.updateMatrixWorld(true);
    const grip = getSupportGrip(category);
    const target = new THREE.Vector3(grip[0], grip[1], grip[2]);
    this.weaponSocket.localToWorld(target);
    this.alignArmIK(upper, lower, hand, target);
  }

  /**
   * Drives the procedural articulated character fallback if the GLTF asset has not loaded yet.
   */
  private updateProceduralFallbackAnimation(
    state: PlayerState,
    dt: number,
    horizSpeed: number,
    landDipY: number,
    activeCat: WeaponCategory,
    isLongGun: boolean,
    drawTilt: number
  ): void {
    const blend = Math.min(1, dt * 14);
    let targetLeftLegX = 0;
    let targetRightLegX = 0;
    let targetLeftKneeX = 0;
    let targetRightKneeX = 0;
    let targetLeftArmX = 0;
    let targetLeftElbowX = 0;
    let targetSpineX = 0;
    let targetSpineY = 0;
    let targetPelvisBobY = 0;

    if (state.isGliding) {
      this.animTime += dt * 3.0;
      targetLeftLegX = 0.22;
      targetRightLegX = 0.28;
      targetLeftKneeX = -0.55;
      targetRightKneeX = -0.62;
      targetLeftArmX = -2.45;
      targetLeftElbowX = 0.3;
      targetSpineX = 0.18;
    } else if (!state.isGrounded) {
      this.animTime += dt * 4.0;
      if (state.velocity.y > 1.2) {
        targetLeftLegX = 0.58;
        targetRightLegX = -0.22;
        targetLeftKneeX = -0.82;
        targetRightKneeX = -0.45;
        targetLeftArmX = -0.85;
        targetLeftElbowX = 0.55;
        targetSpineX = 0.12;
      } else {
        const flutter = Math.sin(this.animTime * 2.5) * 0.1;
        targetLeftLegX = 0.26 + flutter;
        targetRightLegX = -0.34 - flutter;
        targetLeftKneeX = -0.42;
        targetRightKneeX = -0.52;
        targetLeftArmX = -1.05 + flutter;
        targetLeftElbowX = 0.35;
        targetSpineX = 0.06;
      }
    } else if (horizSpeed > 0.45) {
      if (state.isSprinting || horizSpeed > 8.2) {
        this.animTime += dt * 14.2;
        const swing = Math.sin(this.animTime) * 0.85;
        targetLeftLegX = swing;
        targetRightLegX = -swing;
        targetLeftKneeX = Math.max(0, -Math.sin(this.animTime)) * -1.05;
        targetRightKneeX = Math.max(0, Math.sin(this.animTime)) * -1.05;
        targetLeftArmX = state.isReloading ? 0.7 : -swing * 0.75;
        targetLeftElbowX = 0.68;
        targetSpineX = 0.18;
        targetSpineY = Math.sin(this.animTime) * 0.08;
        targetPelvisBobY = Math.abs(Math.cos(this.animTime)) * 0.055;
      } else if (horizSpeed > 4.6) {
        this.animTime += dt * 10.2;
        const swing = Math.sin(this.animTime) * 0.6;
        targetLeftLegX = swing;
        targetRightLegX = -swing;
        targetLeftKneeX = Math.max(0, -Math.sin(this.animTime)) * -0.72;
        targetRightKneeX = Math.max(0, Math.sin(this.animTime)) * -0.72;
        targetLeftArmX = state.isReloading ? 0.7 : -swing * 0.55;
        targetLeftElbowX = 0.38;
        targetSpineX = 0.08;
        targetSpineY = Math.sin(this.animTime) * 0.05;
        targetPelvisBobY = Math.abs(Math.cos(this.animTime)) * 0.035;
      } else {
        this.animTime += dt * 6.8;
        const swing = Math.sin(this.animTime) * 0.36;
        targetLeftLegX = swing;
        targetRightLegX = -swing;
        targetLeftKneeX = Math.max(0, -Math.sin(this.animTime)) * -0.42;
        targetRightKneeX = Math.max(0, Math.sin(this.animTime)) * -0.42;
        targetLeftArmX = state.isReloading ? 0.7 : -swing * 0.35;
        targetLeftElbowX = 0.22;
        targetSpineX = 0.03;
        targetPelvisBobY = Math.abs(Math.cos(this.animTime)) * 0.018;
      }
    } else {
      this.animTime += dt * 2.2;
      const breathe = Math.sin(this.animTime) * 0.028;
      targetLeftArmX = state.isReloading ? 0.8 : breathe;
      targetLeftElbowX = 0.14;
      targetSpineX = breathe * 0.55;
      targetPelvisBobY = breathe * 0.25;
      if (this.landingTimer > 0) {
        targetLeftKneeX = -0.35;
        targetRightKneeX = -0.35;
      }
    }

    this.pelvisGroup.position.y = 0.82 + targetPelvisBobY + landDipY;
    this.spinePivot.position.y = 0.88 + targetPelvisBobY + landDipY;
    if (this.outfitAttachmentGroup) {
      this.outfitAttachmentGroup.position.y = targetPelvisBobY + landDipY;
      this.outfitAttachmentGroup.rotation.x = targetSpineX * 0.35;
      this.outfitAttachmentGroup.rotation.z = this.turnLean * 0.45;
    }

    this.leftLegPivot.rotation.x = THREE.MathUtils.lerp(
      this.leftLegPivot.rotation.x,
      targetLeftLegX,
      blend
    );
    this.rightLegPivot.rotation.x = THREE.MathUtils.lerp(
      this.rightLegPivot.rotation.x,
      targetRightLegX,
      blend
    );
    this.leftKneePivot.rotation.x = THREE.MathUtils.lerp(
      this.leftKneePivot.rotation.x,
      targetLeftKneeX,
      blend
    );
    this.rightKneePivot.rotation.x = THREE.MathUtils.lerp(
      this.rightKneePivot.rotation.x,
      targetRightKneeX,
      blend
    );
    this.leftArmPivot.rotation.x = THREE.MathUtils.lerp(
      this.leftArmPivot.rotation.x,
      targetLeftArmX,
      blend
    );
    this.leftElbowPivot.rotation.x = THREE.MathUtils.lerp(
      this.leftElbowPivot.rotation.x,
      targetLeftElbowX,
      blend
    );
    this.spinePivot.rotation.x = THREE.MathUtils.lerp(
      this.spinePivot.rotation.x,
      targetSpineX,
      blend
    );
    this.spinePivot.rotation.y = THREE.MathUtils.lerp(
      this.spinePivot.rotation.y,
      targetSpineY,
      blend
    );
    this.spinePivot.rotation.z = THREE.MathUtils.lerp(
      this.spinePivot.rotation.z,
      this.turnLean * 0.65,
      blend
    );

    let relHeadYaw =
      ((state.yaw - this.visualFacingYaw + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (relHeadYaw < -Math.PI) relHeadYaw += Math.PI * 2;
    this.headGroup.rotation.y = Math.max(-0.68, Math.min(0.68, relHeadYaw * 0.72));
    this.headGroup.rotation.x = state.pitch * 0.5;
    this.headGroup.rotation.z = state.isAiming ? -0.06 : 0;

    this.weaponSocket.rotation.x = drawTilt;
    this.weaponSocket.rotation.z = this.weaponSwitchRoll;
    this.weaponSocket.position.y = -0.25 + this.weaponSwitchDipY;

    if (state.isReloading) {
      this.reloadAnimClock += dt;
      const rPhase = state.reloadTimer > 0 ? state.reloadTimer : this.reloadAnimClock;
      const rWave = Math.sin(rPhase * 12) * 0.28;
      this.rightArmPivot.rotation.x = Math.PI * 0.35 + rWave;
      this.rightArmPivot.rotation.z = -0.25;
      this.rightElbowPivot.rotation.x = 0.45;
      this.leftArmPivot.rotation.x = Math.PI * 0.38 - rWave;
      this.leftArmPivot.rotation.z = 0.34;
      this.leftElbowPivot.rotation.x = 0.52;
      this.weaponSocket.position.z = -0.14;

      const magMesh = this.weaponMagazine;
      const reloadPose = getReloadAnimationPose(
        state.reloadTimer,
        state.reloadDuration,
        this.reloadAnimClock
      );
      if (magMesh) {
        const baseY =
          typeof magMesh.userData.baseY === 'number' ? magMesh.userData.baseY : -0.09;
        magMesh.position.y = baseY + reloadPose.magazineOffsetY;
      }
      const slideMesh = this.weaponSlide;
      if (slideMesh) {
        const baseZ =
          typeof slideMesh.userData.baseZ === 'number' ? slideMesh.userData.baseZ : -0.16;
        slideMesh.position.z = baseZ + reloadPose.boltPull;
      }
    } else {
      this.reloadAnimClock = 0;
      const magMesh = this.weaponMagazine;
      if (magMesh) {
        magMesh.position.y =
          typeof magMesh.userData.baseY === 'number' ? magMesh.userData.baseY : -0.09;
      }
      this.rightArmPivot.rotation.z = state.isAiming ? -0.08 : 0;
      this.leftArmPivot.rotation.z = 0;
      this.rightElbowPivot.rotation.x = state.isAiming ? 0.22 : 0.1;

      if (this.attackSwingTimer > 0) {
        this.attackSwingTimer = Math.max(0, this.attackSwingTimer - dt);
        if (activeCat === 'harvester') {
          this.rightArmPivot.rotation.x =
            Math.PI * 0.45 - Math.sin(this.attackSwingTimer * 18) * 1.35;
          this.weaponSocket.position.z = -0.14;
        } else {
          const kick = Math.sin((this.attackSwingTimer / 0.22) * Math.PI) * 0.25;
          this.rightArmPivot.rotation.x = Math.PI * 0.48 + state.pitch * 0.6 + kick;
          this.spinePivot.rotation.x -= kick * 0.18;
          this.weaponSocket.position.z = -0.14 + kick * 0.14;
          const slideMesh = this.weaponSlide;
          if (slideMesh) {
            const baseZ =
              typeof slideMesh.userData.baseZ === 'number'
                ? slideMesh.userData.baseZ
                : -0.16;
            slideMesh.position.z = baseZ + kick * 0.18;
          }
          if (isLongGun) {
            this.leftArmPivot.rotation.x =
              Math.PI * 0.44 + state.pitch * 0.55 + kick * 0.75;
            this.leftArmPivot.rotation.z = 0.3;
            this.leftElbowPivot.rotation.x = 0.32;
          }
        }
      } else if (state.isGliding) {
        this.rightArmPivot.rotation.x = -2.45;
        this.rightElbowPivot.rotation.x = 0.3;
        this.weaponSocket.position.z = -0.14;
      } else if (activeCat === 'harvester') {
        this.rightArmPivot.rotation.x = 0.35;
        this.weaponSocket.position.z = -0.14;
      } else {
        this.rightArmPivot.rotation.x = Math.PI * 0.46 + state.pitch * 0.65;
        this.weaponSocket.position.z = -0.14;
        const slideMesh = this.weaponSlide;
        if (slideMesh) {
          slideMesh.position.z =
            typeof slideMesh.userData.baseZ === 'number'
              ? slideMesh.userData.baseZ
              : -0.16;
        }
        if (state.isAiming || isLongGun) {
          this.leftArmPivot.rotation.x = Math.PI * 0.44 + state.pitch * 0.55;
          this.leftArmPivot.rotation.z = 0.3;
          this.leftElbowPivot.rotation.x = 0.32;
        }
      }
    }
  }

  public getMuzzleWorldPosition(target: THREE.Vector3): THREE.Vector3 {
    this.muzzleFlashMesh.getWorldPosition(target);
    return target;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    CharacterMesh.pendingInstances.delete(this);
    this.disposeOutfitAttachments();
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.mixer.getRoot());
      this.mixer = null;
    }
    const skeletons = new Set<THREE.Skeleton>();
    this.gltfModelGroup?.traverse(child => {
      if (child instanceof THREE.SkinnedMesh) skeletons.add(child.skeleton);
    });
    skeletons.forEach(skeleton => skeleton.dispose());
    this.gltfModelGroup?.removeFromParent(); // shared geometry & textures live with template
    this.gltfBodyMat?.dispose();
    this.gltfVisorMat?.dispose();
    this.gltfBodyMat = null;
    this.gltfVisorMat = null;
    // Weapon meshes clone the shared weapon library; never dispose their buffers here.
    this.weaponSocket.removeFromParent();
    this.root.add(this.muzzleFlashMesh, this.proceduralFallbackGroup);
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.root.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return;
      geometries.add(child.geometry);
      for (const mat of Array.isArray(child.material) ? child.material : [child.material]) materials.add(mat);
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    this.baseBonePoses.clear();
    this.attachmentRest.clear();
    this.gltfActions = {};
    this.weaponSocket.clear();
    this.root.clear();
    this.root.removeFromParent();
    this.armorTexture = null;
    this.jumpPackGroup = null;
  }
}
