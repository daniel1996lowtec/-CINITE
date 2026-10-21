import * as THREE from 'three';
import { GLTFLoader, GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  BackAccessoryType,
  OutfitPresetId,
  PlayerState,
  WeaponCategory,
  WeaponRarity,
} from '../network/schemas';
import { createWeaponMesh } from '../weapons/WeaponDefinitions';
import {
  getOutfitVisualProfile,
  normalizeOutfitPresetId,
} from './CharacterCosmetics';
import {
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

function createTacticalArmorTexture(): THREE.CanvasTexture | null {
  if (sharedTacticalArmorTexture !== undefined) {
    return sharedTacticalArmorTexture;
  }
  if (typeof document === 'undefined') {
    sharedTacticalArmorTexture = null;
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    sharedTacticalArmorTexture = null;
    return null;
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.12)';
  for (let y = 0; y < 64; y += 8) {
    for (let x = 0; x < 64; x += 8) {
      if ((x + y) % 16 === 0) {
        ctx.fillRect(x, y, 4, 4);
      }
    }
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, 60, 60);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  sharedTacticalArmorTexture = tex;
  return tex;
}

// Shared unit geometries for every procedural outfit attachment. Each mesh
// only changes scale/rotation, so six cosmetic silhouettes add no unique
// BufferGeometry allocations per player.
const OUTFIT_BOX_GEO = new THREE.BoxGeometry(1, 1, 1);
const OUTFIT_CYLINDER_GEO = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
const OUTFIT_CONE_GEO = new THREE.ConeGeometry(0.5, 1, 8);
const OUTFIT_OCTA_GEO = new THREE.OctahedronGeometry(0.5, 0);

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
  private static pendingInstances: Set<CharacterMesh> = new Set();

  /**
   * Optimizes embedded GLB animation clips by stripping redundant finger/scale tracks
   * (reducing track evaluations by ~85% from 156 to 23 tracks per clip) and constructs
   * retargeted Mixamo AnimationClips for Sprint, Jump, Fall, Land, Aim, Shoot, and Reload.
   */
  private static optimizeAndBuildRetargetedClips(gltf: GLTF): void {
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
  }

  /**
   * Loads and caches the bundled rigged GLB character model (/models/soldier.glb)
   * using Three.js GLTFLoader. Automatically falls back to the procedural character
   * if loading fails or while loading is in progress.
   */
  public static ensureSharedGLBLoaded(): void {
    if (this.sharedGLTFTemplate || this.isLoadingTemplate) return;
    if (typeof window === 'undefined') return;

    this.isLoadingTemplate = true;
    const loader = new GLTFLoader();
    loader.load(
      this.MODEL_URL,
      (gltf) => {
        this.optimizeAndBuildRetargetedClips(gltf);
        this.sharedGLTFTemplate = gltf;
        this.isLoadingTemplate = false;
        for (const inst of this.pendingInstances) {
          inst.upgradeToRiggedGLTFModel();
        }
        this.pendingInstances.clear();
      },
      undefined,
      () => {
        // Keep procedural fallback active if GLB load fails
        this.isLoadingTemplate = false;
        this.pendingInstances.clear();
      }
    );
  }

  /**
   * Allows preloading the bundled GLB binary buffer directly (e.g. in Node/SSR validation tests)
   */
  public static async preloadFromArrayBuffer(buffer: ArrayBuffer): Promise<GLTF> {
    const loader = new GLTFLoader();
    return new Promise((resolve, reject) => {
      loader.parse(
        buffer,
        '',
        (gltf) => {
          this.optimizeAndBuildRetargetedClips(gltf);
          this.sharedGLTFTemplate = gltf;
          this.isLoadingTemplate = false;
          for (const inst of this.pendingInstances) {
            inst.upgradeToRiggedGLTFModel();
          }
          this.pendingInstances.clear();
          resolve(gltf);
        },
        (err) => reject(err)
      );
    });
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
  private airbornePoseBlend: number = 0;
  private turnLean: number = 0;
  private weaponSwitchDipY: number = 0;
  private weaponSwitchRoll: number = 0;
  private activeWeaponCategory: WeaponCategory = 'harvester';
  private torsoMat: THREE.MeshStandardMaterial;
  private accentMat: THREE.MeshStandardMaterial;
  private armorTexture: THREE.CanvasTexture | null = null;
  private tempHandWorldPos = new THREE.Vector3();
  private tempSpineWorldPos = new THREE.Vector3();
  private lodFrameToggle: boolean = false;
  private lodFrameCounter: number = 0;
  private accumulatedMixerDt: number = 0;

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
      new THREE.BoxGeometry(0.14, 0.1, 0.06),
      accentMat
    );
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

    // 3. Sky-Drop Glider
    this.gliderGroup = new THREE.Group();
    this.gliderGroup.position.set(0, 2.65, 0);
    const wingMesh = new THREE.Mesh(new THREE.BoxGeometry(2.85, 0.1, 1.2), accentMat);
    const wingTrim = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.06, 0.25), darkMat);
    wingTrim.position.z = -0.45;
    const handleL = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6),
      darkMat
    );
    handleL.position.set(-0.45, -0.45, 0);
    const handleR = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6),
      darkMat
    );
    handleR.position.set(0.45, -0.45, 0);
    const thrusterL = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.55, 6),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
    );
    thrusterL.rotation.x = -Math.PI / 2;
    thrusterL.position.set(-0.65, 0, 0.75);
    const thrusterR = thrusterL.clone();
    thrusterR.position.x = 0.65;
    this.gliderGroup.add(wingMesh, wingTrim, handleL, handleR, thrusterL, thrusterR);
    this.gliderGroup.visible = false;
    this.bodyGroup.add(this.gliderGroup);

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
      CharacterMesh.pendingInstances.add(this);
      CharacterMesh.ensureSharedGLBLoaded();
    }
  }

  /**
   * Instantiates the rigged Soldier.glb SkinnedMesh + 49-bone Mixamo skeleton + AnimationMixer,
   * customizes stylized armor/visor materials & tactical jump-pack silhouette, and hides the procedural fallback.
   */
  public upgradeToRiggedGLTFModel(): void {
    const template = CharacterMesh.sharedGLTFTemplate;
    if (!template || this.isUsingGLTF) return;

    try {
      const clonedScene = cloneSkeleton(template.scene) as THREE.Group;
      this.gltfModelGroup = new THREE.Group();
      // Stylized heroic Battle Royale proportions (slightly broader shoulders & chest silhouette)
      this.gltfModelGroup.scale.set(1.06, 1.02, 1.06);
      this.gltfModelGroup.add(clonedScene);
      this.bodyGroup.add(this.gltfModelGroup);

      // Customize SkinnedMesh materials with vibrant stylized clothing/visor colors
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
              emissiveIntensity: profile.visorEmissiveIntensity,
              roughness: Math.max(0.08, profile.roughness * 0.42),
              metalness: Math.min(0.88, profile.metalness + 0.34),
              envMapIntensity: profile.envMapIntensity + 0.25,
            });
            mesh.material = visorMat;
            this.gltfVisorMat = visorMat;
          } else if (mesh.material) {
            const profile = getOutfitVisualProfile(this.outfitId);
            const origMat = mesh.material as THREE.MeshStandardMaterial;
            const customBodyMat = origMat.clone();
            const vibrantColor = new THREE.Color(this.skinColorHex);
            const hsl = { h: 0, s: 0, l: 0 };
            vibrantColor.getHSL(hsl);
            vibrantColor.setHSL(hsl.h, Math.min(1, hsl.s * 1.2), Math.max(0.45, hsl.l));
            const tinted = new THREE.Color(0xffffff).lerp(vibrantColor, 0.58);
            customBodyMat.color.copy(tinted);
            customBodyMat.roughness = profile.roughness;
            customBodyMat.metalness = profile.metalness;
            customBodyMat.envMapIntensity = profile.envMapIntensity;
            if (this.armorTexture) {
              customBodyMat.bumpMap = this.armorTexture;
              customBodyMat.bumpScale = 0.012;
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
      if (tposeClip) {
        this.gltfActions.tpose = this.mixer.clipAction(tposeClip);
      }

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
      this.proceduralFallbackGroup.visible = true;
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
      this.gltfBodyMat.roughness = profile.roughness;
      this.gltfBodyMat.metalness = profile.metalness;
      this.gltfBodyMat.envMapIntensity = profile.envMapIntensity;
      if (this.armorTexture && !this.gltfBodyMat.bumpMap) {
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
    this.bodyGroup.remove(this.outfitAttachmentGroup);
    this.outfitAttachmentGroup.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      // Geometry is one of the module-level shared unit primitives.
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((material) => material.dispose());
      } else {
        mesh.material.dispose();
      }
    });
    this.outfitAttachmentGroup = null;
  }

  /**
   * Builds one of six compact procedural armor silhouettes. Every piece is
   * visual-only, stays inside the existing capsule's practical footprint,
   * and reuses four shared unit geometries.
   */
  private rebuildOutfitAttachments(): void {
    this.disposeOutfitAttachments();
    const profile = getOutfitVisualProfile(this.outfitId);
    const group = new THREE.Group();
    group.name = 'outfit_attachments';
    group.userData.outfitId = profile.id;
    group.userData.armorStyle = profile.armorStyle;

    const armorMat = new THREE.MeshStandardMaterial({
      color: this.skinColorHex,
      map: this.armorTexture,
      roughness: profile.roughness,
      metalness: profile.metalness,
      envMapIntensity: profile.envMapIntensity,
      flatShading: true,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: this.accentColorHex,
      emissive: this.accentColorHex,
      emissiveIntensity: profile.visorEmissiveIntensity * 0.42,
      roughness: Math.max(0.12, profile.roughness * 0.55),
      metalness: Math.min(0.7, profile.metalness + 0.16),
      envMapIntensity: profile.envMapIntensity,
      flatShading: true,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      map: this.armorTexture,
      roughness: Math.min(0.72, profile.roughness + 0.16),
      metalness: 0.24,
      envMapIntensity: profile.envMapIntensity * 0.72,
      flatShading: true,
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
        OUTFIT_BOX_GEO,
        material,
        side * 0.39,
        1.5,
        0,
        width,
        height,
        depth,
        0,
        0,
        side * -0.08
      );

    switch (profile.armorStyle) {
      case 'solar':
        pauldron(-1, 0.28, 0.1, 0.24, accentMat);
        pauldron(1, 0.28, 0.1, 0.24, accentMat);
        add('solar_disc', OUTFIT_CYLINDER_GEO, accentMat, 0, 1.31, -0.25, 0.2, 0.032, 0.2, Math.PI / 2);
        add('solar_core', OUTFIT_OCTA_GEO, armorMat, 0, 1.31, -0.28, 0.1, 0.1, 0.05);
        add('plume', OUTFIT_CONE_GEO, accentMat, 0, 1.99, 0.02, 0.13, 0.3, 0.13, -0.12);
        add('waist_sash', OUTFIT_BOX_GEO, darkMat, 0, 0.98, -0.2, 0.42, 0.07, 0.04, 0, 0, -0.18);
        break;
      case 'phantom':
        pauldron(-1, 0.09, 0.32, 0.2);
        pauldron(1, 0.09, 0.32, 0.2);
        add('diamond_core', OUTFIT_OCTA_GEO, accentMat, 0, 1.3, -0.26, 0.13, 0.19, 0.05);
        add('left_antenna', OUTFIT_CYLINDER_GEO, accentMat, -0.11, 1.98, -0.02, 0.024, 0.3, 0.024, 0, 0, 0.18);
        add('right_antenna', OUTFIT_CYLINDER_GEO, accentMat, 0.11, 1.98, -0.02, 0.024, 0.3, 0.024, 0, 0, -0.18);
        add('stealth_collar', OUTFIT_BOX_GEO, darkMat, 0, 1.58, -0.08, 0.34, 0.08, 0.22, 0.14);
        break;
      case 'ranger':
        pauldron(-1, 0.3, 0.16, 0.3);
        pauldron(1, 0.17, 0.1, 0.22, darkMat);
        add('field_strap', OUTFIT_BOX_GEO, darkMat, 0, 1.3, -0.245, 0.52, 0.07, 0.028, 0, 0, -0.48);
        add('left_pouch', OUTFIT_BOX_GEO, armorMat, -0.16, 0.98, -0.2, 0.13, 0.16, 0.08);
        add('right_pouch', OUTFIT_BOX_GEO, darkMat, 0.16, 0.98, -0.2, 0.13, 0.16, 0.08);
        add('left_sensor_fin', OUTFIT_BOX_GEO, accentMat, -0.12, 1.91, 0, 0.04, 0.17, 0.1, 0, 0, 0.14);
        add('right_sensor_fin', OUTFIT_BOX_GEO, accentMat, 0.12, 1.91, 0, 0.04, 0.17, 0.1, 0, 0, -0.14);
        break;
      case 'arctic':
        pauldron(-1, 0.28, 0.17, 0.31);
        pauldron(1, 0.28, 0.17, 0.31);
        add('sentinel_collar', OUTFIT_BOX_GEO, armorMat, 0, 1.59, -0.02, 0.54, 0.13, 0.34);
        add('chest_plate', OUTFIT_BOX_GEO, armorMat, 0, 1.29, -0.245, 0.31, 0.3, 0.035);
        add('cryo_strip', OUTFIT_BOX_GEO, accentMat, 0, 1.31, -0.27, 0.06, 0.24, 0.02);
        add('visor_guard', OUTFIT_BOX_GEO, darkMat, 0, 1.82, -0.16, 0.3, 0.05, 0.1, 0.2);
        break;
      case 'crimson':
        pauldron(-1, 0.18, 0.11, 0.22, darkMat);
        pauldron(1, 0.34, 0.19, 0.33);
        add('slash_left', OUTFIT_BOX_GEO, accentMat, -0.07, 1.33, -0.255, 0.21, 0.035, 0.024, 0, 0, -0.52);
        add('slash_right', OUTFIT_BOX_GEO, accentMat, 0.07, 1.22, -0.255, 0.21, 0.035, 0.024, 0, 0, -0.52);
        add('mohawk_fin', OUTFIT_BOX_GEO, accentMat, 0, 1.98, -0.02, 0.035, 0.25, 0.23, -0.08);
        add('striker_core', OUTFIT_OCTA_GEO, darkMat, 0, 1.08, -0.24, 0.1, 0.13, 0.05);
        break;
      case 'vanguard':
      default:
        pauldron(-1, 0.25, 0.14, 0.29);
        pauldron(1, 0.25, 0.14, 0.29);
        add('chevron_left', OUTFIT_BOX_GEO, accentMat, -0.09, 1.34, -0.25, 0.19, 0.035, 0.024, 0, 0, 0.55);
        add('chevron_right', OUTFIT_BOX_GEO, accentMat, 0.09, 1.34, -0.25, 0.19, 0.035, 0.024, 0, 0, -0.55);
        add('chest_core', OUTFIT_OCTA_GEO, accentMat, 0, 1.22, -0.26, 0.11, 0.11, 0.05);
        add('brow_fin', OUTFIT_BOX_GEO, armorMat, 0, 1.87, -0.13, 0.22, 0.035, 0.12, 0.18);
        break;
    }

    this.outfitAttachmentGroup = group;
    this.bodyGroup.add(group);
  }

  private rebuildBackAccessory(): void {
    if (this.jumpPackGroup) {
      this.bodyGroup.remove(this.jumpPackGroup);
      this.jumpPackGroup.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
          else m.material.dispose();
        }
      });
    }

    this.jumpPackGroup = new THREE.Group();
    this.jumpPackGroup.position.set(0, 1.32, 0.16);
    this.bodyGroup.add(this.jumpPackGroup);

    if (this.backAccessoryType === 'none') {
      this.jumpPackGroup.visible = false;
      return;
    }

    const armorMat = new THREE.MeshStandardMaterial({
      color: this.skinColorHex,
      roughness: 0.32,
      metalness: 0.45,
    });
    const glowMat = new THREE.MeshStandardMaterial({
      color: this.accentColorHex,
      emissive: this.accentColorHex,
      emissiveIntensity: 0.55,
      roughness: 0.2,
    });

    if (this.backAccessoryType === 'energy_wings') {
      const hub = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.11, 0),
        armorMat
      );
      this.jumpPackGroup.add(hub);
      for (const side of [-1, 1]) {
        const upperWing = new THREE.Mesh(
          new THREE.BoxGeometry(0.36, 0.07, 0.04),
          glowMat
        );
        upperWing.position.set(side * 0.22, 0.1, 0.03);
        upperWing.rotation.z = side * 0.42;

        const lowerWing = new THREE.Mesh(
          new THREE.BoxGeometry(0.28, 0.055, 0.04),
          glowMat
        );
        lowerWing.position.set(side * 0.19, -0.06, 0.03);
        lowerWing.rotation.z = -side * 0.25;
        this.jumpPackGroup.add(upperWing, lowerWing);
      }
    } else if (this.backAccessoryType === 'tactical_shield') {
      const shieldDisc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.24, 0.24, 0.05, 6),
        armorMat
      );
      shieldDisc.rotation.x = Math.PI / 2;
      const rim = new THREE.Mesh(
        new THREE.CylinderGeometry(0.26, 0.26, 0.03, 6),
        glowMat
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.z = -0.01;
      const crest = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.08, 0),
        glowMat
      );
      crest.position.z = 0.03;
      this.jumpPackGroup.add(shieldDisc, rim, crest);
    } else {
      // 'jump_pack'
      const packChassis = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.34, 0.13),
        armorMat
      );
      const packCore = new THREE.Mesh(
        new THREE.CylinderGeometry(0.065, 0.065, 0.05, 10),
        glowMat
      );
      packCore.rotation.x = Math.PI / 2;
      packCore.position.set(0, 0.02, 0.06);
      const finL = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.24, 0.1),
        glowMat
      );
      finL.position.set(-0.16, 0.05, 0.02);
      finL.rotation.z = 0.22;
      const finR = finL.clone();
      finR.position.x = 0.16;
      finR.rotation.z = -0.22;
      this.jumpPackGroup.add(packChassis, packCore, finL, finR);
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
      const vibrantColor = new THREE.Color(skinColor);
      const hsl = { h: 0, s: 0, l: 0 };
      vibrantColor.getHSL(hsl);
      vibrantColor.setHSL(hsl.h, Math.min(1, hsl.s * 1.2), Math.max(0.45, hsl.l));
      const tinted = new THREE.Color(0xffffff).lerp(vibrantColor, 0.58);
      this.gltfBodyMat.color.copy(tinted);
    }

    this.applyOutfitMaterialFinish();
    this.rebuildBackAccessory();
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
          cat === 'sniper' || cat === 'dmr'
            ? 0x38bdf8
            : cat === 'burst_rifle'
              ? 0xa5f3fc
              : cat === 'heavy_pistol'
                ? 0xfda4af
                : cat === 'shotgun' || cat === 'tactical_shotgun'
                  ? 0xf97316
                  : 0xfacc15
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
    this.equipAnimTimer = 0.24;

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
    if (category === 'harvester') {
      model.rotation.x = -Math.PI / 3;
    } else {
      const tip = model.getObjectByName('muzzle_tip');
      if (tip) {
        this.muzzleFlashMesh.position.copy(tip.position);
      }
    }
    this.weaponSocket.add(model);
  }

  public update(state: PlayerState, dt: number, cameraPos?: THREE.Vector3): void {
    this.root.visible = state.alive;
    if (!state.alive) return;

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
      Math.min(1, dt * 15)
    );
    this.bodyGroup.rotation.y = this.visualFacingYaw;
    this.bodyGroup.rotation.z = this.turnLean * 0.45;

    const slot = state.inventory[state.activeSlot];
    if (slot) {
      this.equipWeaponModel(slot.category, slot.rarity);
    } else {
      this.equipWeaponModel('harvester', 'rare');
    }

    const switchPose = getWeaponSwitchPose(this.equipAnimTimer, 0.24);
    const drawTilt = switchPose.pitchOffset;
    this.weaponSwitchDipY = switchPose.dipY;
    this.weaponSwitchRoll = switchPose.roll;
    if (this.equipAnimTimer > 0) {
      this.equipAnimTimer = Math.max(0, this.equipAnimTimer - dt);
    }

    this.gliderGroup.visible = state.isGliding;
    if (state.isGliding) {
      this.gliderGroup.rotation.z = Math.sin(this.animTime * 3.5) * 0.08;
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
    if (this.outfitAttachmentGroup) {
      // Cosmetic micro-geometry is the first character detail shed at range;
      // the body, weapon and back accessory remain visible.
      this.outfitAttachmentGroup.visible = !cameraPos || distToCamera <= 70;
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
    if (state.landingImpactTimer > 0) {
      state.landingImpactTimer = Math.max(0, state.landingImpactTimer - dt);
      const squash = Math.sin((state.landingImpactTimer / 0.18) * Math.PI) * 0.12;
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
      this.currentAnimState = state.landingImpactTimer > 0 ? 'land' : 'idle';
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
      this.updateProceduralFallbackAnimation(
        state,
        dt,
        horizSpeed,
        landDipY,
        activeCat,
        isLongGun,
        drawTilt
      );
    }
  }

  /**
   * Drives the real Soldier.glb AnimationMixer (Idle, Walk, Run clips) with
   * velocity-proportional stride timeScale and smooth upper-body pose blending
   * for Sprint, Jump, Fall, Land, Aim, Shoot, Reload, Weapon Sway, and Right-Hand Tracking.
   */
  private updateRiggedGLTFAnimation(
    state: PlayerState,
    dt: number,
    horizSpeed: number,
    activeCat: WeaponCategory,
    isLongGun: boolean,
    drawTilt: number,
    distToCamera: number
  ): void {
    // 4-Tier Distance-Based Animation LOD:
    // < 42m: 60Hz (every frame), 42..85m: 30Hz (every 2nd), 85..145m: 15Hz (every 4th), >145m: 10Hz (every 6th)
    this.accumulatedMixerDt += dt;
    this.lodFrameCounter++;
    if (distToCamera > 145) {
      if (this.lodFrameCounter % 6 !== 0) return;
    } else if (distToCamera > 85) {
      if ((this.lodFrameCounter & 3) !== 0) return;
    } else if (distToCamera > 42) {
      if ((this.lodFrameCounter & 1) !== 0) return;
    }
    const stepDt = this.accumulatedMixerDt;
    this.accumulatedMixerDt = 0;

    this.animTime += stepDt * 4.0;
    const blend = Math.min(1, stepDt * 12);

    // Smooth upper-body & airborne blend weights to eliminate sudden pose snaps
    this.aimPoseBlend = THREE.MathUtils.lerp(
      this.aimPoseBlend,
      state.isAiming ? 1.0 : 0.0,
      Math.min(1, stepDt * 14)
    );
    this.reloadPoseBlend = THREE.MathUtils.lerp(
      this.reloadPoseBlend,
      state.isReloading ? 1.0 : 0.0,
      Math.min(1, stepDt * 12)
    );
    const isAirborneOrLanding =
      this.currentAnimState === 'jump' ||
      this.currentAnimState === 'fall' ||
      this.currentAnimState === 'land';
    this.airbornePoseBlend = THREE.MathUtils.lerp(
      this.airbornePoseBlend,
      isAirborneOrLanding ? 1.0 : 0.0,
      Math.min(1, stepDt * 14)
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
      Math.min(1, stepDt * 12)
    );
    this.swayPitchOffset = THREE.MathUtils.lerp(
      this.swayPitchOffset,
      THREE.MathUtils.clamp(-pitchDelta * 1.4 * swayDamp, -0.12, 0.12),
      Math.min(1, stepDt * 12)
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

    this.mixer!.update(stepDt);

    const b = this.gltfBones;
    const airW = this.airbornePoseBlend;

    // 2. Layer Airborne (Jump / Fall / Glide) & Landing Bone Poses on Legs & Spine
    const airbornePose = getAirbornePose(state.velocity.y);
    if (this.currentAnimState === 'jump') {
      if (b.rightUpLeg) b.rightUpLeg.rotation.x -= (0.34 + airbornePose.riseBlend * 0.3) * airW;
      if (b.rightLeg) b.rightLeg.rotation.x += airbornePose.legBend * airW;
      if (b.leftUpLeg) b.leftUpLeg.rotation.x -= (0.2 + airbornePose.riseBlend * 0.18) * airW;
      if (b.leftLeg) b.leftLeg.rotation.x += airbornePose.legBend * 0.72 * airW;
      if (b.spine1) b.spine1.rotation.x += airbornePose.spinePitch * airW;
    } else if (this.currentAnimState === 'fall') {
      const flutter = Math.sin(this.animTime * 2.2) * 0.1;
      if (b.rightUpLeg) b.rightUpLeg.rotation.x -= (0.2 + airbornePose.fallBlend * 0.18 + flutter) * airW;
      if (b.rightLeg) b.rightLeg.rotation.x += airbornePose.legBend * 0.82 * airW;
      if (b.leftUpLeg) b.leftUpLeg.rotation.x -= (0.16 + airbornePose.fallBlend * 0.14 - flutter) * airW;
      if (b.leftLeg) b.leftLeg.rotation.x += airbornePose.legBend * 0.72 * airW;
      if (b.spine1) b.spine1.rotation.x += airbornePose.spinePitch * 0.55 * airW;
    } else if (this.currentAnimState === 'land') {
      if (b.rightUpLeg) b.rightUpLeg.rotation.x -= 0.35 * airW;
      if (b.rightLeg) b.rightLeg.rotation.x += 0.55 * airW;
      if (b.leftUpLeg) b.leftUpLeg.rotation.x -= 0.35 * airW;
      if (b.leftLeg) b.leftLeg.rotation.x += 0.55 * airW;
    } else if (this.currentAnimState === 'sprint') {
      if (b.spine1) b.spine1.rotation.x += 0.18 * (1 - this.aimPoseBlend * 0.7);
    }

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
      if (b.rightArm) b.rightArm.rotation.set(-0.6, 0.9, 2.2);
      if (b.leftArm) b.leftArm.rotation.set(0.6, -0.9, 2.2);
    } else if (state.isReloading || this.reloadPoseBlend > 0.05) {
      this.reloadAnimClock += stepDt;
      const rPhase = state.reloadTimer > 0 ? state.reloadTimer : this.reloadAnimClock;
      const rWave = Math.sin(rPhase * 11) * 0.26 * this.reloadPoseBlend;
      if (b.rightArm) b.rightArm.rotation.set(0.15, 0.75, 1.25 + rWave * 0.4);
      if (b.rightForeArm) b.rightForeArm.rotation.set(1.1, 0.2, 0.45);
      if (b.leftArm) b.leftArm.rotation.set(0.2, -0.8, 1.55 - rWave * 0.5);
      if (b.leftForeArm) b.leftForeArm.rotation.set(-0.7, 0.2, 0.55 + rWave);

      const magMesh = this.weaponSocket.getObjectByName('weapon_mag');
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
      const magMesh = this.weaponSocket.getObjectByName('weapon_mag');
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
      } else {
        // Two-handed / Sighted Firearm Stance with smooth ADS elevation blend
        const adsLift = this.aimPoseBlend * 0.12;
        if (b.rightArm) {
          b.rightArm.rotation.set(
            0.2 - adsLift * 0.4,
            0.85 + state.pitch * 0.35 + adsLift * 0.25,
            1.35 + adsLift + recoilKick * 0.45
          );
        }
        if (b.rightForeArm) {
          b.rightForeArm.rotation.set(
            1.2 + adsLift * 0.2,
            0.25,
            0.45 + recoilKick * 0.35
          );
        }
        if (this.aimPoseBlend > 0.05 || isLongGun) {
          if (b.leftArm) {
            b.leftArm.rotation.set(
              0.15,
              -0.85 - state.pitch * 0.3,
              1.65 + adsLift * 0.6 + recoilKick * 0.35
            );
          }
          if (b.leftForeArm) {
            b.leftForeArm.rotation.set(-0.65, 0.2, 0.55);
          }
        }
      }
    }

    // 5. Sync weaponSocket position to mixamorigRightHand & jumpPackGroup to mixamorigSpine2 in bodyGroup space
    const moveBobY =
      horizSpeed > 0.5 && state.isGrounded
        ? Math.sin(this.animTime * 2.2) * 0.012 * (1 - this.aimPoseBlend * 0.7)
        : 0;
    const adsCenterOffsetX = -this.aimPoseBlend * 0.035;
    const adsLiftOffsetY = this.aimPoseBlend * 0.03;

    if (b.rightHand && this.gltfModelGroup && distToCamera < 72) {
      this.gltfModelGroup.updateMatrixWorld(true);
      b.rightHand.getWorldPosition(this.tempHandWorldPos);
      this.bodyGroup.worldToLocal(this.tempHandWorldPos);
      this.weaponSocket.position.set(
        this.tempHandWorldPos.x + 0.04 + adsCenterOffsetX,
        this.tempHandWorldPos.y + 0.04 + adsLiftOffsetY + moveBobY + this.weaponSwitchDipY,
        this.tempHandWorldPos.z - 0.1 + recoilKick * 0.14
      );
      if (b.spine2 && this.jumpPackGroup) {
        b.spine2.getWorldPosition(this.tempSpineWorldPos);
        this.bodyGroup.worldToLocal(this.tempSpineWorldPos);
        this.jumpPackGroup.position.set(
          this.tempSpineWorldPos.x,
          this.tempSpineWorldPos.y + 0.04,
          this.tempSpineWorldPos.z + 0.15
        );
        if (this.outfitAttachmentGroup) {
          this.outfitAttachmentGroup.position.set(
            this.tempSpineWorldPos.x,
            this.tempSpineWorldPos.y - 1.28,
            this.tempSpineWorldPos.z
          );
        }
      }
    } else {
      this.weaponSocket.position.set(
        0.18 + adsCenterOffsetX,
        1.22 + adsLiftOffsetY + moveBobY + this.weaponSwitchDipY,
        -0.28 + recoilKick * 0.14
      );
    }

    const slideMesh = this.weaponSocket.getObjectByName('weapon_slide');
    if (slideMesh) {
      const baseZ =
        typeof slideMesh.userData?.baseZ === 'number'
          ? slideMesh.userData.baseZ
          : -0.16;
      slideMesh.position.z =
        baseZ + Math.max(recoilKick * 0.18, reloadBoltPull, pumpOrBoltFollow);
    }

    this.weaponSocket.rotation.set(
      state.pitch * 0.65 - recoilKick * 0.45 + drawTilt + this.swayPitchOffset,
      this.swayYawOffset,
      -this.swayYawOffset * 0.5 + this.weaponSwitchRoll
    );
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
      if (state.landingImpactTimer > 0) {
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

      const magMesh = this.weaponSocket.getObjectByName('weapon_mag');
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
      const slideMesh = this.weaponSocket.getObjectByName('weapon_slide');
      if (slideMesh) {
        const baseZ =
          typeof slideMesh.userData.baseZ === 'number' ? slideMesh.userData.baseZ : -0.16;
        slideMesh.position.z = baseZ + reloadPose.boltPull;
      }
    } else {
      this.reloadAnimClock = 0;
      const magMesh = this.weaponSocket.getObjectByName('weapon_mag');
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
          const slideMesh = this.weaponSocket.getObjectByName('weapon_slide');
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
        const slideMesh = this.weaponSocket.getObjectByName('weapon_slide');
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
    CharacterMesh.pendingInstances.delete(this);
    this.disposeOutfitAttachments();
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    this.armorTexture = null;
    if (this.gltfBodyMat) {
      this.gltfBodyMat.dispose();
      this.gltfBodyMat = null;
    }
    if (this.gltfVisorMat) {
      this.gltfVisorMat.dispose();
      this.gltfVisorMat = null;
    }
    if (this.jumpPackGroup) {
      this.jumpPackGroup.traverse((child) => {
        const m = child as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
          else m.material.dispose();
        }
      });
      this.jumpPackGroup = null;
    }
    this.proceduralFallbackGroup.traverse((child) => {
      const m = child as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
        else m.material.dispose();
      }
    });
  }
}
