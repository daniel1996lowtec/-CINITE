import * as THREE from 'three';
import type { ImpactSurfaceType } from '../audio/SoundManager';

interface ParticleItem {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: boolean;
  rotSpeed?: number;
  baseScale?: THREE.Vector3;
}

interface TracerBeam {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

interface ShockwaveRing {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  targetScale: number;
}

export class ParticleSystem {
  private disposed = false;
  private scene: THREE.Scene;
  private particles: ParticleItem[] = [];
  private tracers: TracerBeam[] = [];
  private rings: ShockwaveRing[] = [];
  private boxGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
  private chipGeo = new THREE.OctahedronGeometry(0.11, 0);
  private casingGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.08, 6);
  private unitTracerCoreGeo: THREE.CylinderGeometry;
  private unitTracerGlowGeo: THREE.CylinderGeometry;
  private sharedRingGeo = new THREE.RingGeometry(0.18, 0.32, 16);
  private maxParticles = 180;
  private effectScale = 1;

  // Object pools for zero-allocation combat particles, tracers, and shockwave rings
  private particleMeshPool: THREE.Mesh[] = [];
  private tracerCorePool: THREE.Mesh[] = [];
  private tracerGlowPool: THREE.Mesh[] = [];
  private ringMeshPool: THREE.Mesh[] = [];
  private readonly scratchMid = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.unitTracerCoreGeo = new THREE.CylinderGeometry(0.025, 0.025, 1.0, 6);
    this.unitTracerCoreGeo.rotateX(Math.PI / 2);
    this.unitTracerGlowGeo = new THREE.CylinderGeometry(0.065, 0.065, 1.0, 6);
    this.unitTracerGlowGeo.rotateX(Math.PI / 2);
  }

  /**
   * Scales non-essential combat spark counts and the hard particle cap by
   * graphics tier. Tracers and one-shot feedback rings remain intact because
   * they carry gameplay information on smaller mobile screens.
   */
  public setQualityScale(scale: number): void {
    this.effectScale = THREE.MathUtils.clamp(scale, 0.35, 1);
    this.maxParticles = Math.round(180 * this.effectScale);
    this.trimParticleBudget(0);
  }

  private scaledCount(count: number, minimum: number = 1): number {
    return Math.min(this.maxParticles,Math.max(minimum,Math.round((Number.isFinite(count) ? count : 0) * this.effectScale)));
  }

  private acquireParticleMesh(
    geo: THREE.BufferGeometry,
    colorHex: number,
    opacity: number = 1
  ): THREE.Mesh {
    const pooled = this.particleMeshPool.pop();
    if (pooled) {
      pooled.geometry = geo;
      pooled.scale.set(1, 1, 1);
      pooled.rotation.set(0, 0, 0);
      const mat = pooled.material as THREE.MeshBasicMaterial;
      mat.color.setHex(colorHex);
      mat.opacity = opacity;
      mat.depthWrite = false;
      return pooled;
    }
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    return new THREE.Mesh(geo, mat);
  }

  private releaseParticleMesh(mesh: THREE.Mesh): void {
    this.scene.remove(mesh);
    if (this.particleMeshPool.length < 180) {
      this.particleMeshPool.push(mesh);
    } else {
      (mesh.material as THREE.Material).dispose();
    }
  }

  private acquireTracerMesh(
    isCore: boolean,
    colorHex: number,
    opacity: number
  ): THREE.Mesh {
    const pool = isCore ? this.tracerCorePool : this.tracerGlowPool;
    const pooled = pool.pop();
    if (pooled) {
      const mat = pooled.material as THREE.MeshBasicMaterial;
      mat.color.setHex(colorHex);
      mat.opacity = opacity;
      mat.blending = THREE.AdditiveBlending;
      mat.depthWrite = false;
      mat.fog = false;
      return pooled;
    }
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    return new THREE.Mesh(
      isCore ? this.unitTracerCoreGeo : this.unitTracerGlowGeo,
      mat
    );
  }

  private releaseTracerMesh(mesh: THREE.Mesh): void {
    this.scene.remove(mesh);
    const isCore = mesh.geometry === this.unitTracerCoreGeo;
    const pool = isCore ? this.tracerCorePool : this.tracerGlowPool;
    if (pool.length < 48) {
      pool.push(mesh);
    } else {
      (mesh.material as THREE.Material).dispose();
    }
  }

  private acquireRingMesh(colorHex: number, opacity: number = 0.85): THREE.Mesh {
    const pooled = this.ringMeshPool.pop();
    if (pooled) {
      pooled.scale.set(1, 1, 1);
      const mat = pooled.material as THREE.MeshBasicMaterial;
      mat.color.setHex(colorHex);
      mat.opacity = opacity;
      mat.blending = THREE.AdditiveBlending;
      mat.depthWrite = false;
      mat.fog = false;
      return pooled;
    }
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex,
      side: THREE.DoubleSide,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    return new THREE.Mesh(this.sharedRingGeo, mat);
  }

  private releaseRingMesh(mesh: THREE.Mesh): void {
    this.scene.remove(mesh);
    if (this.ringMeshPool.length < 32) {
      this.ringMeshPool.push(mesh);
    } else {
      (mesh.material as THREE.Material).dispose();
    }
  }

  private trimParticleBudget(incomingCount: number): void {
    while (
      this.particles.length + incomingCount > this.maxParticles &&
      this.particles.length > 0
    ) {
      const oldest = this.particles.shift()!;
      this.releaseParticleMesh(oldest.mesh);
    }
  }

  public clear(): void {
    for (const p of this.particles) {
      this.releaseParticleMesh(p.mesh);
    }
    this.particles = [];

    for (const t of this.tracers) {
      this.releaseTracerMesh(t.mesh);
    }
    this.tracers = [];

    for (const r of this.rings) {
      this.releaseRingMesh(r.mesh);
    }
    this.rings = [];
  }

  /** Final teardown, unlike clear(), which deliberately retains bounded pools for the next match. */
  public dispose(): void {
    if (this.disposed) return;
    this.clear(); this.disposed = true;
    for (const pool of [this.particleMeshPool,this.tracerCorePool,this.tracerGlowPool,this.ringMeshPool]) {
      for (const mesh of pool) (mesh.material as THREE.Material).dispose();
      pool.length = 0;
    }
    for (const geometry of [this.boxGeo,this.chipGeo,this.casingGeo,this.unitTracerCoreGeo,this.unitTracerGlowGeo,this.sharedRingGeo]) geometry.dispose();
  }

  public spawnImpactBurst(
    pos: THREE.Vector3,
    colorHex: number = 0xfacc15,
    count: number = 8,
    speed: number = 4.5
  ): void {
    if (this.disposed) return;
    const scaledCount = this.scaledCount(count);
    this.trimParticleBudget(scaledCount);
    for (let i = 0; i < scaledCount; i++) {
      const mesh = this.acquireParticleMesh(this.boxGeo, colorHex, 1);
      mesh.position.copy(pos);
      this.scene.add(mesh);

      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * speed * 2,
        Math.random() * speed * 1.3 + 1.2,
        (Math.random() - 0.5) * speed * 2
      );

      this.particles.push({
        mesh,
        velocity: vel,
        life: 0.34 + Math.random() * 0.22,
        maxLife: 0.56,
        gravity: true,
        rotSpeed: (Math.random() - 0.5) * 14,
      });
    }
  }

  public spawnMuzzleSparks(
    muzzlePos: THREE.Vector3,
    direction: THREE.Vector3,
    category: string
  ): void {
    if (this.disposed) return;
    const count = this.scaledCount(
      category === 'shotgun' || category === 'tactical_shotgun'
        ? 5
        : category === 'sniper' || category === 'dmr' || category === 'heavy_pistol'
          ? 4
          : 3,
      2
    );
    const sparkColor =
      category === 'sniper' || category === 'dmr'
        ? 0x38bdf8
        : category === 'burst_rifle'
          ? 0xa5f3fc
          : category === 'heavy_pistol'
            ? 0xfda4af
            : category === 'shotgun' || category === 'tactical_shotgun'
              ? 0xf97316
              : 0xfef08a;
    this.trimParticleBudget(count);
    for (let i = 0; i < count; i++) {
      const mesh = this.acquireParticleMesh(this.chipGeo, sparkColor, 0.95);
      mesh.position.copy(muzzlePos);
      mesh.scale.setScalar(0.55);
      this.scene.add(mesh);

      const speed = 7.5 + Math.random() * 5.5;
      const vel = new THREE.Vector3(
        direction.x * speed + (Math.random() - 0.5) * 2.6,
        direction.y * speed + (Math.random() - 0.5) * 2.2 + 0.6,
        direction.z * speed + (Math.random() - 0.5) * 2.6
      );

      this.particles.push({
        mesh,
        velocity: vel,
        life: 0.12 + Math.random() * 0.08,
        maxLife: 0.2,
        gravity: false,
        rotSpeed: 20,
      });
    }
  }

  public spawnChestOpenCelebration(
    pos: THREE.Vector3,
    rarityColorHex: number = 0xfacc15
  ): void {
    if (this.disposed) return;
    const colors = [0xfacc15, 0xfef08a, rarityColorHex, 0x38bdf8];
    const count = this.scaledCount(24, 12);
    this.trimParticleBudget(count);
    for (let i = 0; i < count; i++) {
      const col = colors[i % colors.length];
      const mesh = this.acquireParticleMesh(this.chipGeo, col, 1);
      mesh.position.set(pos.x, pos.y + 0.62, pos.z);
      this.scene.add(mesh);

      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const horizSpeed = 2.2 + Math.random() * 3.8;
      const vel = new THREE.Vector3(
        Math.cos(angle) * horizSpeed,
        4.8 + Math.random() * 5.2,
        Math.sin(angle) * horizSpeed
      );

      this.particles.push({
        mesh,
        velocity: vel,
        life: 0.62 + Math.random() * 0.26,
        maxLife: 0.88,
        gravity: true,
        rotSpeed: (Math.random() - 0.5) * 18,
      });
    }

    this.spawnShockwaveRing(
      new THREE.Vector3(pos.x, pos.y + 0.16, pos.z),
      0xfacc15,
      2.8,
      0.34
    );
    this.spawnShockwaveRing(
      new THREE.Vector3(pos.x, pos.y + 0.55, pos.z),
      rarityColorHex,
      2.1,
      0.28
    );
  }

  public spawnLootPickupEffect(
    pos: THREE.Vector3,
    colorHex: number = 0x38bdf8
  ): void {
    if (this.disposed) return;
    this.spawnImpactBurst(
      new THREE.Vector3(pos.x, pos.y + 0.45, pos.z),
      colorHex,
      8,
      3.4
    );
    this.spawnShockwaveRing(
      new THREE.Vector3(pos.x, pos.y + 0.12, pos.z),
      colorHex,
      1.45,
      0.22
    );
  }

  public spawnImpactSparks(
    pos: THREE.Vector3,
    colorHex: number = 0xfacc15,
    count: number = 8
  ): void {
    if (this.disposed) return;
    this.spawnImpactBurst(pos, colorHex, count, 4.5);
    this.spawnShockwaveRing(pos, colorHex, 1.35, 0.22);
  }

  /**
   * Spawns surface-specific impact particles (wood splinters, stone chips, metal sparks,
   * terrain dirt clods, shield energy shards, or player combat hit flashes).
   */
  public spawnSurfaceImpact(
    pos: THREE.Vector3,
    surface: ImpactSurfaceType,
    isDestroyed: boolean = false,
    isHeadshot: boolean = false
  ): void {
    if (this.disposed) return;
    let primaryColor = 0xfacc15;
    let secondaryColor = 0xffffff;
    let count = isDestroyed ? 16 : isHeadshot ? 13 : 8;
    let speedScale = isDestroyed ? 1.35 : isHeadshot ? 1.25 : 1.0;

    if (surface === 'wood') {
      primaryColor = 0xd97706;
      secondaryColor = 0xfde68a;
    } else if (surface === 'stone') {
      primaryColor = 0x94a3b8;
      secondaryColor = 0xe2e8f0;
    } else if (surface === 'metal') {
      primaryColor = 0x38bdf8;
      secondaryColor = 0xfef08a;
      speedScale *= 1.2;
    } else if (surface === 'shield') {
      primaryColor = 0x38bdf8;
      secondaryColor = isHeadshot ? 0xfacc15 : 0x7dd3fc;
      count = isDestroyed ? 20 : isHeadshot ? 14 : 10;
    } else if (surface === 'flesh') {
      primaryColor = isHeadshot ? 0xfacc15 : 0xf87171;
      secondaryColor = isHeadshot ? 0xf97316 : 0xfacc15;
    } else {
      primaryColor = 0x854d0e;
      secondaryColor = 0x4ade80;
      count = 7;
    }

    count = this.scaledCount(count, isDestroyed ? 8 : 4);
    this.trimParticleBudget(count);
    for (let i = 0; i < count; i++) {
      const col = i % 3 === 0 ? secondaryColor : primaryColor;
      const geo =
        surface === 'stone' || surface === 'shield' || isHeadshot
          ? this.chipGeo
          : this.boxGeo;
      const mesh = this.acquireParticleMesh(geo, col, 1);
      mesh.position.copy(pos);
      if (surface === 'wood') {
        mesh.scale.set(1.6, 0.5, 0.6);
      }
      this.scene.add(mesh);

      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 9.5 * speedScale,
        (Math.random() * 5.8 + 1.4) * speedScale,
        (Math.random() - 0.5) * 9.5 * speedScale
      );

      this.particles.push({
        mesh,
        velocity: vel,
        life: 0.32 + Math.random() * 0.24,
        maxLife: 0.56,
        gravity: surface !== 'shield',
        rotSpeed: (Math.random() - 0.5) * 16,
      });
    }

    this.spawnShockwaveRing(
      pos,
      isHeadshot ? 0xfacc15 : primaryColor,
      isDestroyed ? 2.4 : isHeadshot ? 1.85 : surface === 'shield' ? 1.7 : 1.25,
      isDestroyed ? 0.34 : 0.22
    );
  }

  public spawnShellCasing(pos: THREE.Vector3, shooterYaw: number): void {
    if (this.disposed) return;
    this.trimParticleBudget(1);
    const mesh = this.acquireParticleMesh(this.casingGeo, 0xfacc15, 0.95);
    mesh.position.copy(pos);
    this.scene.add(mesh);

    const rightX = Math.cos(shooterYaw);
    const rightZ = -Math.sin(shooterYaw);
    const vel = new THREE.Vector3(
      rightX * (2.2 + Math.random() * 1.4),
      2.4 + Math.random() * 1.2,
      rightZ * (2.2 + Math.random() * 1.4)
    );

    this.particles.push({
      mesh,
      velocity: vel,
      life: 0.45,
      maxLife: 0.45,
      gravity: true,
      rotSpeed: 18,
    });
  }

  public spawnEliminationEffect(pos: THREE.Vector3): void {
    if (this.disposed) return;
    const colors = [0x38bdf8, 0xfacc15, 0xf43f5e, 0xa855f7, 0x4ade80];
    const count = this.scaledCount(32, 16);
    this.trimParticleBudget(count);
    for (let i = 0; i < count; i++) {
      const col = colors[i % colors.length];
      const mesh = this.acquireParticleMesh(this.chipGeo, col, 1);
      mesh.position.set(pos.x, pos.y + 1.0, pos.z);
      this.scene.add(mesh);

      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 14,
        Math.random() * 11 + 2,
        (Math.random() - 0.5) * 14
      );

      this.particles.push({
        mesh,
        velocity: vel,
        life: 0.9,
        maxLife: 0.9,
        gravity: true,
        rotSpeed: (Math.random() - 0.5) * 16,
      });
    }

    this.spawnShockwaveRing(
      new THREE.Vector3(pos.x, pos.y + 0.9, pos.z),
      0x38bdf8,
      3.8,
      0.48
    );
    this.spawnShockwaveRing(
      new THREE.Vector3(pos.x, pos.y + 1.1, pos.z),
      0xfacc15,
      2.6,
      0.38
    );
  }

  public spawnEliminationBurst(pos: THREE.Vector3): void {
    if (this.disposed) return;
    this.spawnEliminationEffect(pos);
  }

  public spawnBulletTracer(
    start: THREE.Vector3,
    end: THREE.Vector3,
    colorHex: number = 0xfef08a
  ): void {
    if (this.disposed) return;
    while (this.tracers.length > 46) this.releaseTracerMesh(this.tracers.shift()!.mesh);
    const dist = start.distanceTo(end);
    if (dist < 0.4) return;

    const mid = this.scratchMid.copy(start).add(end).multiplyScalar(0.5);

    const coreMesh = this.acquireTracerMesh(true, 0xffffff, 0.95);
    coreMesh.position.copy(mid);
    coreMesh.lookAt(end);
    coreMesh.scale.set(1, 1, dist);
    this.scene.add(coreMesh);
    this.tracers.push({ mesh: coreMesh, life: 0.085, maxLife: 0.085 });

    const glowMesh = this.acquireTracerMesh(false, colorHex, 0.45);
    glowMesh.position.copy(mid);
    glowMesh.lookAt(end);
    glowMesh.scale.set(1, 1, dist);
    this.scene.add(glowMesh);
    this.tracers.push({ mesh: glowMesh, life: 0.11, maxLife: 0.11 });
  }

  public spawnShockwaveRing(
    pos: THREE.Vector3,
    colorHex: number,
    targetScale: number = 2.0,
    duration: number = 0.28
  ): void {
    if (this.disposed) return;
    // Hard ceiling even during concurrent chest/shotgun bursts.
    while (this.rings.length >= Math.round(24 * this.effectScale)) {
      this.releaseRingMesh(this.rings.shift()!.mesh);
    }
    const mesh = this.acquireRingMesh(colorHex, 0.85);
    mesh.position.copy(pos);
    mesh.rotation.x = Math.PI / 2 + (Math.random() - 0.5) * 0.4;
    mesh.rotation.y = (Math.random() - 0.5) * 0.4;
    this.scene.add(mesh);

    this.rings.push({
      mesh,
      life: duration,
      maxLife: duration,
      targetScale,
    });
  }

  public update(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.releaseParticleMesh(p.mesh);
        this.particles.splice(i, 1);
        continue;
      }

      if (p.gravity) {
        p.velocity.y -= 18 * dt;
      }
      p.mesh.position.addScaledVector(p.velocity, dt);
      if (p.rotSpeed) {
        p.mesh.rotation.x += p.rotSpeed * dt;
        p.mesh.rotation.y += p.rotSpeed * dt;
      }

      const ratio = p.life / p.maxLife;
      p.baseScale ??= p.mesh.scale.clone();
      p.mesh.scale.copy(p.baseScale).multiplyScalar(Math.max(0.1, ratio));
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = ratio;
    }

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.releaseTracerMesh(t.mesh);
        this.tracers.splice(i, 1);
        continue;
      }
      (t.mesh.material as THREE.MeshBasicMaterial).opacity =
        (t.life / t.maxLife) * 0.85;
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      if (r.life <= 0) {
        this.releaseRingMesh(r.mesh);
        this.rings.splice(i, 1);
        continue;
      }
      const progress = 1 - r.life / r.maxLife;
      const scale = 1 + progress * r.targetScale;
      r.mesh.scale.setScalar(scale);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity =
        (1 - progress) * 0.85;
    }
  }
}
