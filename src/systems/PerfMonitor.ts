import * as THREE from 'three';

export interface PerfSnapshot {
  fps: number;
  avgFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  cpuUpdateMs: number;
  worldUpdateMs: number;
  lootUpdateMs: number;
  particlesMs: number;
  renderMs: number;
  botAiMs: number;
  charAnimMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  activeObjects: number;
  heapMB: number | null;
  heapUsedMB: number | null;
  pixelRatio: number;
  qualityPreset: string;
}

export type PerfSubsystemKey =
  | 'world'
  | 'loot'
  | 'particles'
  | 'botAi'
  | 'charAnim'
  | 'render';

/**
 * Lightweight FPS, CPU Frame-Time, and WebGL Renderer Telemetry Monitor (CI Craft 2.6).
 * Zero per-frame heap allocations using a fixed Float64Array ring buffer.
 */
export class PerfMonitor {
  private readonly bufferSize = 120;
  private readonly frameHistory = new Float64Array(120);
  private readonly sortScratch = new Float64Array(120);
  private writeIdx = 0;
  private sampleCount = 0;

  private frameStartTime = 0;
  private subsystemStartTime = 0;
  private cpuUpdateAccumulator = 0;
  private worldUpdateAccumulator = 0;
  private lootUpdateAccumulator = 0;
  private particlesAccumulator = 0;
  private renderAccumulator = 0;
  private botAiAccumulator = 0;
  private charAnimAccumulator = 0;
  private framesSinceFlush = 0;
  private timeSinceFlush = 0;
  private cachedSceneObjects = 0;
  private sceneCountTick = 0;

  public latest: PerfSnapshot = {
    fps: 60,
    avgFrameMs: 16.6,
    p95FrameMs: 16.6,
    maxFrameMs: 16.6,
    cpuUpdateMs: 0,
    worldUpdateMs: 0,
    lootUpdateMs: 0,
    particlesMs: 0,
    renderMs: 0,
    botAiMs: 0,
    charAnimMs: 0,
    drawCalls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
    activeObjects: 0,
    heapMB: null,
    heapUsedMB: null,
    pixelRatio: 1,
    qualityPreset: 'high',
  };

  public get lastSnapshot(): PerfSnapshot {
    return this.latest;
  }

  public beginFrame(now: number = performance.now()): void {
    if (this.frameStartTime > 0) {
      const frameDeltaMs = now - this.frameStartTime;
      if (frameDeltaMs > 0 && frameDeltaMs < 2000) {
        this.frameHistory[this.writeIdx] = frameDeltaMs;
        this.writeIdx = (this.writeIdx + 1) % this.bufferSize;
        if (this.sampleCount < this.bufferSize) this.sampleCount++;
        this.timeSinceFlush += frameDeltaMs;
        this.framesSinceFlush++;
      }
    }
    this.frameStartTime = now;
  }

  public beginSubsystem(): void {
    this.subsystemStartTime = performance.now();
  }

  public endSubsystem(key: PerfSubsystemKey): void {
    const elapsed = Math.max(0, performance.now() - this.subsystemStartTime);
    switch (key) {
      case 'world':
        this.worldUpdateAccumulator += elapsed;
        this.cpuUpdateAccumulator += elapsed;
        break;
      case 'loot':
        this.lootUpdateAccumulator += elapsed;
        this.cpuUpdateAccumulator += elapsed;
        break;
      case 'particles':
        this.particlesAccumulator += elapsed;
        this.cpuUpdateAccumulator += elapsed;
        break;
      case 'botAi':
        this.botAiAccumulator += elapsed;
        this.cpuUpdateAccumulator += elapsed;
        break;
      case 'charAnim':
        this.charAnimAccumulator += elapsed;
        this.cpuUpdateAccumulator += elapsed;
        break;
      case 'render':
        this.renderAccumulator += elapsed;
        break;
    }
  }

  public recordSubsystems(
    cpuUpdateMs: number,
    botAiMs: number,
    charAnimMs: number,
    renderMs: number
  ): void {
    this.cpuUpdateAccumulator += cpuUpdateMs;
    this.botAiAccumulator += botAiMs;
    this.charAnimAccumulator += charAnimMs;
    this.renderAccumulator += renderMs;
  }

  private countVisibleSceneObjects(scene: THREE.Object3D): number {
    let count = 0;
    const stack: THREE.Object3D[] = [scene];
    while (stack.length > 0) {
      const obj = stack.pop()!;
      if (!obj.visible) continue;
      count++;
      const children = obj.children;
      for (let i = 0; i < children.length; i++) {
        stack.push(children[i]);
      }
    }
    return count;
  }

  public endFrame(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    pixelRatio: number,
    qualityPreset: string
  ): PerfSnapshot | null {
    this.sceneCountTick++;
    if (this.cachedSceneObjects === 0 || this.sceneCountTick >= 30) {
      this.sceneCountTick = 0;
      this.cachedSceneObjects = this.countVisibleSceneObjects(scene);
    }
    this.latest.pixelRatio = pixelRatio;
    const refreshed = this.flushIfReady(renderer, this.cachedSceneObjects, qualityPreset);
    return refreshed ? this.latest : null;
  }

  /**
   * Updates the telemetry snapshot every ~400ms and returns true when refreshed.
   */
  public flushIfReady(
    renderer: THREE.WebGLRenderer,
    activeObjects: number,
    qualityPreset: string
  ): boolean {
    if (this.timeSinceFlush < 400 || this.framesSinceFlush === 0) {
      return false;
    }

    const n = this.sampleCount;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < n; i++) {
      const v = this.frameHistory[i];
      sum += v;
      if (v > max) max = v;
      this.sortScratch[i] = v;
    }

    const sub = this.sortScratch.subarray(0, n);
    sub.sort();
    const p95 = sub[Math.min(n - 1, Math.floor(n * 0.95))] || 16.6;
    const avg = n > 0 ? sum / n : 16.6;
    const fps = this.timeSinceFlush > 0 ? (this.framesSinceFlush * 1000) / this.timeSinceFlush : 60;
    const invFrames = 1 / this.framesSinceFlush;

    let heapMB: number | null = null;
    const perfAny = performance as unknown as {
      memory?: { usedJSHeapSize: number };
    };
    if (perfAny && perfAny.memory && typeof perfAny.memory.usedJSHeapSize === 'number') {
      heapMB = Math.round((perfAny.memory.usedJSHeapSize / 1048576) * 10) / 10;
    }

    this.latest.fps = Math.round(fps);
    this.latest.avgFrameMs = Number(avg.toFixed(1));
    this.latest.p95FrameMs = Number(p95.toFixed(1));
    this.latest.maxFrameMs = Number(max.toFixed(1));
    this.latest.cpuUpdateMs = Number((this.cpuUpdateAccumulator * invFrames).toFixed(2));
    this.latest.worldUpdateMs = Number((this.worldUpdateAccumulator * invFrames).toFixed(2));
    this.latest.lootUpdateMs = Number((this.lootUpdateAccumulator * invFrames).toFixed(2));
    this.latest.particlesMs = Number((this.particlesAccumulator * invFrames).toFixed(2));
    this.latest.botAiMs = Number((this.botAiAccumulator * invFrames).toFixed(2));
    this.latest.charAnimMs = Number((this.charAnimAccumulator * invFrames).toFixed(2));
    this.latest.renderMs = Number((this.renderAccumulator * invFrames).toFixed(2));
    this.latest.drawCalls = renderer.info.render.calls;
    this.latest.triangles = renderer.info.render.triangles;
    this.latest.geometries = renderer.info.memory.geometries;
    this.latest.textures = renderer.info.memory.textures;
    this.latest.activeObjects = activeObjects;
    this.latest.heapMB = heapMB;
    this.latest.heapUsedMB = heapMB;
    this.latest.pixelRatio = Number(renderer.getPixelRatio().toFixed(2));
    this.latest.qualityPreset = qualityPreset.toUpperCase();

    this.cpuUpdateAccumulator = 0;
    this.worldUpdateAccumulator = 0;
    this.lootUpdateAccumulator = 0;
    this.particlesAccumulator = 0;
    this.botAiAccumulator = 0;
    this.charAnimAccumulator = 0;
    this.renderAccumulator = 0;
    this.framesSinceFlush = 0;
    this.timeSinceFlush = 0;

    return true;
  }

  public formatCompactHUD(): string {
    const s = this.latest;
    const memPart = s.heapMB !== null ? ` • MEM ${s.heapMB}MB` : '';
    return `${s.fps} FPS (${s.avgFrameMs}ms | P95 ${s.p95FrameMs}ms) • CPU ${s.cpuUpdateMs}ms • DC ${s.drawCalls} • TRI ${(s.triangles / 1000).toFixed(1)}k • OBJ ${s.activeObjects}${memPart} [${s.qualityPreset} ${s.pixelRatio}x]`;
  }
}
