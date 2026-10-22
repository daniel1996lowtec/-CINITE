import * as THREE from 'three';
import { MatchState } from '../network/schemas';
import { advanceStormState } from './StormConfig';

export class StormSystem {
  public reducedMotion = false;
  private disposed = false;
  private scene: THREE.Scene;
  private stormWallMesh: THREE.Mesh;
  private stormLatticeMesh: THREE.LineSegments;
  private safeZoneRingMesh: THREE.Mesh;
  private currentZoneRingMesh: THREE.Mesh;
  private finalZoneBeacon: THREE.Mesh;
  private animTime: number = 0;
  private terrainSampleTimer = 1;
  private readonly terrainHeight: (x: number, z: number) => number;

  constructor(scene: THREE.Scene, terrainHeight: (x: number, z: number) => number = () => 0) {
    this.scene = scene;
    this.terrainHeight = terrainHeight;

    const wallGeo = new THREE.CylinderGeometry(1, 1, 140, 48, 3, true);
    // RGBA vertex colours fade the upper wall without custom shaders, textures,
    // extra passes or a second wall. The collision/radius is still server-owned.
    const positions = wallGeo.getAttribute('position');
    const colors = new Float32Array(positions.count * 4);
    const base = new THREE.Color(0xe879f9), top = new THREE.Color(0x7c3aed);
    const tint = new THREE.Color();
    for (let i=0;i<positions.count;i++) {
      const height = THREE.MathUtils.clamp((positions.getY(i)+70)/140,0,1);
      tint.copy(base).lerp(top,height);
      colors.set([tint.r,tint.g,tint.b,.95-height*.8],i*4);
    }
    wallGeo.setAttribute('color',new THREE.BufferAttribute(colors,4));
    const wallMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
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
    const latticeSource = new THREE.CylinderGeometry(1, 1, 140, 24, 2, true);
    this.stormLatticeMesh = new THREE.LineSegments(
      new THREE.WireframeGeometry(latticeSource),
      latticeMat
    );
    latticeSource.dispose();
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
    // One unlit, depth-tested landmark column; no point lights or screenspace fog.
    this.finalZoneBeacon = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 90, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.18,
        depthWrite: false, side: THREE.DoubleSide, fog: false }));
    this.finalZoneBeacon.name = 'FinalSafeZoneBeacon';
    this.finalZoneBeacon.visible = false;
    scene.add(this.finalZoneBeacon);
  }

  public update(dt: number, state: MatchState): void {
    if (this.disposed) return;
    const storm = state.storm;

    advanceStormState(storm, dt);

    this.syncVisuals(state, dt);
  }

  public syncVisuals(state: MatchState, dt: number = 0): void {
    if (this.disposed) return;
    if (!this.reducedMotion) this.animTime += dt;
    const storm = state.storm;
    const r = Math.max(1, storm.currentRadius);
    const intensity = THREE.MathUtils.clamp((storm.phase - 5) / 3, 0, 1);
    this.finalZoneBeacon.visible = state.phase === 'ACTIVE' && storm.phase >= 6;
    this.finalZoneBeacon.position.set(storm.targetCenterX, this.finalZoneBeacon.position.y, storm.targetCenterZ);
    (this.finalZoneBeacon.material as THREE.MeshBasicMaterial).opacity =
      0.12 + intensity * 0.07 + Math.sin(this.animTime * 1.4) * 0.025;
    (this.safeZoneRingMesh.material as THREE.MeshBasicMaterial).color.setHex(
      storm.phase >= 6 ? 0x67e8f9 : 0xf0abfc);
    this.stormWallMesh.position.set(storm.currentCenterX, 65, storm.currentCenterZ);
    this.stormWallMesh.scale.set(r, 1, r);
    (this.stormWallMesh.material as THREE.MeshBasicMaterial).opacity =
      0.22 + intensity * 0.035 + Math.sin(this.animTime * 2.1) * 0.035;

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
    this.terrainSampleTimer += dt;
    if (this.terrainSampleTimer >= 0.2) {
      this.terrainSampleTimer = 0;
      this.finalZoneBeacon.position.y = this.terrainHeight(storm.targetCenterX,storm.targetCenterZ) + 45;
      for (const ring of [this.safeZoneRingMesh, this.currentZoneRingMesh]) {
        const points = ring.geometry.getAttribute('position');
        for (let i = 0; i < points.count; i++) {
          points.setY(i, this.terrainHeight(ring.position.x + points.getX(i) * ring.scale.x,
            ring.position.z + points.getZ(i) * ring.scale.z) + 0.16 - ring.position.y);
        }
        points.needsUpdate = true;
        ring.geometry.computeBoundingSphere();
      }
    }
    (this.currentZoneRingMesh.material as THREE.MeshBasicMaterial).opacity =
      0.8 + Math.sin(this.animTime * 3.1) * 0.12;
  }

  /** Lattice is decoration; the wall, both boundaries and final beacon stay visible. */
  public setDetailEnabled(enabled: boolean): void {
    this.stormLatticeMesh.visible = enabled;
  }

  public resetPresentation(): void {
    this.finalZoneBeacon.visible = false;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const object of [this.stormWallMesh, this.stormLatticeMesh, this.safeZoneRingMesh,
      this.currentZoneRingMesh, this.finalZoneBeacon]) {
      object.removeFromParent(); object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    }
  }

  public isPositionInStorm(state: MatchState, x: number, z: number): boolean {
    const d = Math.hypot(
      x - state.storm.currentCenterX,
      z - state.storm.currentCenterZ
    );
    return d > state.storm.currentRadius;
  }
}
