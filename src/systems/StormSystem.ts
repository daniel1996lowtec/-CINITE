import * as THREE from 'three';
import { MatchState } from '../network/schemas';
import { advanceStormState } from './StormConfig';

export class StormSystem {
  private scene: THREE.Scene;
  private stormWallMesh: THREE.Mesh;
  private stormLatticeMesh: THREE.LineSegments;
  private safeZoneRingMesh: THREE.Mesh;
  private currentZoneRingMesh: THREE.Mesh;
  private animTime: number = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    const wallGeo = new THREE.CylinderGeometry(1, 1, 140, 48, 3, true);
    const wallMat = new THREE.MeshBasicMaterial({
      color: 0xa855f7,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    });
    this.stormWallMesh = new THREE.Mesh(wallGeo, wallMat);
    this.stormWallMesh.position.y = 65;
    this.scene.add(this.stormWallMesh);

    const latticeMat = new THREE.LineBasicMaterial({
      color: 0xe879f9,
      transparent: true,
      opacity: 0.36,
      fog: false,
    });
    this.stormLatticeMesh = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.CylinderGeometry(1, 1, 140, 24, 2, true)),
      latticeMat
    );
    this.stormLatticeMesh.position.y = 65;
    this.scene.add(this.stormLatticeMesh);

    const ringGeo = new THREE.RingGeometry(0.985, 1.0, 64);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xf0abfc,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      fog: false,
    });
    this.safeZoneRingMesh = new THREE.Mesh(ringGeo, ringMat);
    this.safeZoneRingMesh.position.y = 0.6;
    this.scene.add(this.safeZoneRingMesh);

    // The future-zone ring above is pale magenta. This brighter current-
    // boundary ring remains readable at ground level while the translucent
    // wall communicates the same edge from rooftops and during sky-drop.
    const currentRingGeo = new THREE.RingGeometry(0.992, 1.0, 72);
    currentRingGeo.rotateX(-Math.PI / 2);
    const currentRingMat = new THREE.MeshBasicMaterial({
      color: 0xd946ef,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });
    this.currentZoneRingMesh = new THREE.Mesh(currentRingGeo, currentRingMat);
    this.currentZoneRingMesh.name = 'StormCurrentBoundaryRing';
    this.currentZoneRingMesh.position.y = 0.72;
    this.currentZoneRingMesh.renderOrder = 6;
    this.scene.add(this.currentZoneRingMesh);
  }

  public update(dt: number, state: MatchState): void {
    const storm = state.storm;

    advanceStormState(storm, dt);

    this.syncVisuals(state, dt);
  }

  public syncVisuals(state: MatchState, dt: number = 0): void {
    this.animTime += dt;
    const storm = state.storm;
    const r = Math.max(1, storm.currentRadius);
    this.stormWallMesh.position.set(storm.currentCenterX, 65, storm.currentCenterZ);
    this.stormWallMesh.scale.set(r, 1, r);
    (this.stormWallMesh.material as THREE.MeshBasicMaterial).opacity =
      0.22 + Math.sin(this.animTime * 2.1) * 0.035;

    this.stormLatticeMesh.position.set(storm.currentCenterX, 65, storm.currentCenterZ);
    this.stormLatticeMesh.scale.set(r, 1, r);
    this.stormLatticeMesh.rotation.y = this.animTime * 0.08;
    (this.stormLatticeMesh.material as THREE.LineBasicMaterial).opacity =
      0.32 + Math.sin(this.animTime * 2.7) * 0.07;

    this.safeZoneRingMesh.position.set(storm.targetCenterX, 0.65, storm.targetCenterZ);
    // RingGeometry was rotated into XZ, so world Z is scaled by the mesh's
    // third axis. The previous (r, r, 1) scale flattened the target ring.
    const targetRadius = Math.max(1, storm.targetRadius);
    this.safeZoneRingMesh.scale.set(targetRadius, 1, targetRadius);
    (this.safeZoneRingMesh.material as THREE.MeshBasicMaterial).opacity =
      0.68 + Math.sin(this.animTime * 2.4) * 0.1;

    this.currentZoneRingMesh.position.set(storm.currentCenterX, 0.72, storm.currentCenterZ);
    this.currentZoneRingMesh.scale.set(r, 1, r);
    (this.currentZoneRingMesh.material as THREE.MeshBasicMaterial).opacity =
      0.8 + Math.sin(this.animTime * 3.1) * 0.12;
  }

  public isPositionInStorm(state: MatchState, x: number, z: number): boolean {
    const d = Math.hypot(
      x - state.storm.currentCenterX,
      z - state.storm.currentCenterZ
    );
    return d > state.storm.currentRadius;
  }
}
