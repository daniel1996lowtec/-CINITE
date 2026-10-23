import * as THREE from 'three';
import type { AimSolution } from '../weapons/AimSolver';

/**
 * Development-only aiming overlay.
 *
 * Draws, in screen space, exactly what the shot pipeline decided:
 *
 *   - the camera aim ray (what the crosshair represents)
 *   - the aim point under the crosshair
 *   - the weapon muzzle
 *   - the actual firing direction (muzzle -> aim point)
 *   - the hitbox the shot would touch, if any
 *
 * It is **off unless explicitly requested**: add `?aimdebug=1` to the URL. There
 * is no always-on HUD element, nothing is added to the DOM until the flag is
 * present, and disabling it costs one boolean check per frame.
 *
 * Everything drawn here is sampled from the same `AimSolution` the firing code
 * uses, so it cannot drift out of sync with the real shot.
 */
export class AimDiagnostics {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private enabled = false;
  private lastSolution: AimSolution | null = null;
  private lastServerResult = '';
  private serverResultUntil = 0;
  private vector = new THREE.Vector3();

  constructor() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('aimdebug') !== '1') return;

    this.enabled = true;
    const canvas = document.createElement('canvas');
    canvas.id = 'aim-diagnostics';
    canvas.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
    document.body.appendChild(canvas);
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  private resize(): void {
    if (!this.canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
    this.context?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Called once per shot with the resolved solution. */
  public setSolution(solution: AimSolution | null): void {
    if (!this.enabled) return;
    this.lastSolution = solution;
  }

  /**
   * Called when the server answers. Lets the overlay show whether the hit the
   * client predicted is the hit the server actually applied.
   */
  public reportServerResult(confirmed: boolean, detail: string): void {
    if (!this.enabled) return;
    this.lastServerResult = confirmed ? `SERVER: HIT ${detail}` : `SERVER: MISSED ${detail}`;
    this.serverResultUntil = performance.now() + 1200;
  }

  public render(camera: THREE.Camera): void {
    if (!this.enabled || !this.context || !this.canvas) return;

    const ctx = this.context;
    const width = window.innerWidth;
    const height = window.innerHeight;
    ctx.clearRect(0, 0, width, height);

    const solution = this.lastSolution;
    if (!solution) return;

    const project = (point: { x: number; y: number; z: number }) => {
      this.vector.set(point.x, point.y, point.z).project(camera);
      return {
        x: (this.vector.x * 0.5 + 0.5) * width,
        y: (-this.vector.y * 0.5 + 0.5) * height,
        visible: this.vector.z < 1,
      };
    };

    const label = (text: string, x: number, y: number, colour: string) => {
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      const w = ctx.measureText(text).width + 6;
      ctx.fillRect(x + 4, y - 11, w, 14);
      ctx.fillStyle = colour;
      ctx.fillText(text, x + 7, y);
    };

    // 1. Camera aim ray: a short segment from the camera towards the aim point.
    const cameraPoint = project(solution.cameraOrigin);
    const cameraAhead = project({
      x: solution.cameraOrigin.x + solution.cameraDirection.x * 3,
      y: solution.cameraOrigin.y + solution.cameraDirection.y * 3,
      z: solution.cameraOrigin.z + solution.cameraDirection.z * 3,
    });
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cameraPoint.x, cameraPoint.y);
    ctx.lineTo(cameraAhead.x, cameraAhead.y);
    ctx.stroke();

    // 2. Aim point under the crosshair.
    const aim = project(solution.aimPoint);
    ctx.strokeStyle = solution.cameraBlocked ? '#f87171' : '#a3e635';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(aim.x, aim.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    label(
      `aim ${solution.aimDistance.toFixed(1)}m${solution.cameraBlocked ? ' BLOCKED' : ''}`,
      aim.x,
      aim.y + 18,
      solution.cameraBlocked ? '#f87171' : '#a3e635'
    );

    // 3. Muzzle and the real firing direction.
    const muzzle = project(solution.fireOrigin);
    ctx.fillStyle = '#fbbf24';
    ctx.fillRect(muzzle.x - 3, muzzle.y - 3, 6, 6);
    label('muzzle', muzzle.x, muzzle.y - 8, '#fbbf24');

    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(muzzle.x, muzzle.y);
    ctx.lineTo(aim.x, aim.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 4. Predicted hitbox intersection.
    if (solution.predictedPoint) {
      const hit = project(solution.predictedPoint);
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hit.x - 6, hit.y - 6);
      ctx.lineTo(hit.x + 6, hit.y + 6);
      ctx.moveTo(hit.x + 6, hit.y - 6);
      ctx.lineTo(hit.x - 6, hit.y + 6);
      ctx.stroke();
      label(
        `hitbox: ${solution.predictedTargetId}${
          solution.muzzleObstructed ? ' (blocked)' : ''
        }`,
        hit.x,
        hit.y - 10,
        '#22d3ee'
      );
    } else if (solution.crosshairTargetId) {
      label('crosshair on target but muzzle blocked', aim.x, aim.y - 14, '#f87171');
    }

    // 5. Server verdict.
    if (performance.now() < this.serverResultUntil) {
      label(this.lastServerResult, 16, height - 20, '#fde047');
    }

    label(
      `tier: ${solution.cameraBlocked ? 'camera ray stopped by geometry' : 'clear'}`,
      16,
      20,
      '#94a3b8'
    );
  }
}
