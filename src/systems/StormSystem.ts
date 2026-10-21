import * as THREE from 'three';
import { MatchState } from '../network/schemas';

export class StormSystem {
  private scene: THREE.Scene;
  private stormWallMesh: THREE.Mesh;
  private stormLatticeMesh: THREE.LineSegments;
  private safeZoneRingMesh: THREE.Mesh;
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
  }

  public update(dt: number, state: MatchState): void {
    const storm = state.storm;

    storm.phaseTimer -= dt;
    if (storm.phaseTimer <= 0) {
      if (!storm.isShrinking) {
        storm.isShrinking = true;
        storm.phaseTimer = Math.max(18, 34 - storm.phase * 4);
      } else {
        storm.isShrinking = false;
        storm.currentCenterX = storm.targetCenterX;
        storm.currentCenterZ = storm.targetCenterZ;
        storm.currentRadius = storm.targetRadius;
        storm.phase++;
        storm.damagePerSecond = Math.min(12, storm.phase * 2);
        storm.phaseTimer = Math.max(16, 32 - storm.phase * 4);

        const nextRadius = Math.max(12, storm.currentRadius * 0.56);
        const shiftRange = (storm.currentRadius - nextRadius) * 0.5;
        const angle = Math.random() * Math.PI * 2;
        storm.targetCenterX = storm.currentCenterX + Math.cos(angle) * shiftRange;
        storm.targetCenterZ = storm.currentCenterZ + Math.sin(angle) * shiftRange;
        storm.targetRadius = nextRadius;
      }
    }

    if (storm.isShrinking) {
      const shrinkSpeed = dt * 0.045;
      storm.currentCenterX += (storm.targetCenterX - storm.currentCenterX) * shrinkSpeed;
      storm.currentCenterZ += (storm.targetCenterZ - storm.currentCenterZ) * shrinkSpeed;
      storm.currentRadius += (storm.targetRadius - storm.currentRadius) * shrinkSpeed;
    }

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
  }

  public isPositionInStorm(state: MatchState, x: number, z: number): boolean {
    const d = Math.hypot(
      x - state.storm.currentCenterX,
      z - state.storm.currentCenterZ
    );
    return d > state.storm.currentRadius;
  }
}
