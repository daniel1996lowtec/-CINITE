/**
 * CI CRAFT 8.7 — renderer diagnostics.
 *
 * Purpose: get the real WebGL error text off the device that is actually
 * failing, without a public endpoint, without extra software, and without
 * destroying the original message.
 *
 * Why it is built this way:
 *
 * three.js reports a failed program from `onFirstUse()` inside WebGLProgram.
 * Its DEFAULT reporter prints the useful part:
 *
 *     THREE.WebGLProgram: Shader Error <n> - VALIDATE_STATUS <b>
 *     Material Name: <material.name>
 *     Material Type: <material.type>
 *     Program Info Log: <log>
 *     <annotated vertex + fragment source>
 *
 * but ONLY when `renderer.debug.onShaderError` is not a function. Setting that
 * hook REPLACES the reporter and loses Material Name/Type entirely. An earlier
 * revision of this project set it and therefore made its own evidence worse.
 *
 * So this module never touches `onShaderError`. It leaves three.js's reporter
 * alone and simply *captures* what it writes to console.error/warn, preserving
 * the original arguments and stack.
 *
 * Activation is opt-in via `?diag=1`. Nothing is sent anywhere; there is no
 * server component and no secret ever reaches the DOM.
 */
import * as THREE from 'three';

export interface DiagnosticsTargets {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  world?: {
    terrain?: {
      terrainMesh?: THREE.Mesh | null;
      waterMesh?: THREE.Mesh | null;
      roadSurfaceMesh?: THREE.Mesh | null;
      roadBridgeMesh?: THREE.Mesh | null;
    };
  };
}

interface CapturedMessage {
  kind: 'error' | 'warn' | 'exception' | 'rejection';
  text: string;
  stack?: string;
  at: number;
}

const MAX_MESSAGES = 200;

/** Formats console arguments the way the console renders them, without losing text. */
function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

/**
 * Material probe.
 *
 * `renderer.compile(scene, camera)` forces three.js to build the program for
 * every material it touches. Running that on a one-triangle scene per material
 * makes the driver speak about exactly one material at a time, so whatever
 * lands in console.error during the probe can be attributed to it — with the
 * original three.js wording, material name and shader source intact.
 */
function probeMaterials(
  renderer: THREE.WebGLRenderer,
  materials: Array<{ label: string; material: THREE.Material }>,
  capture: (run: () => void) => CapturedMessage[]
): Array<{ label: string; ok: boolean; messages: CapturedMessage[] }> {
  const results: Array<{ label: string; ok: boolean; messages: CapturedMessage[] }> = [];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)
  );
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  // The terrain shader reads aPavedMask; give the probe a value so the probe
  // exercises the same code path the real terrain geometry does.
  geometry.setAttribute('aPavedMask', new THREE.Float32BufferAttribute([1, 1, 1], 1));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));

  const probeScene = new THREE.Scene();
  const probeCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 10);
  probeCamera.position.z = 2;
  const mesh = new THREE.Mesh(geometry, materials[0]?.material ?? new THREE.MeshBasicMaterial());
  probeScene.add(mesh);

  for (const entry of materials) {
    mesh.material = entry.material;
    entry.material.needsUpdate = true;
    let thrown: string | null = null;
    const messages = capture(() => {
      try {
        renderer.compile(probeScene, probeCamera);
      } catch (error) {
        thrown = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
    });
    if (thrown) {
      messages.push({ kind: 'exception', text: thrown, at: Date.now() });
    }
    results.push({ label: entry.label, ok: messages.length === 0, messages });
  }

  geometry.dispose();
  probeScene.clear();
  return results;
}

function webglLimits(renderer: THREE.WebGLRenderer): Record<string, string> {
  const gl = renderer.getContext() as WebGLRenderingContext;
  const read = (name: string, key: number): [string, string] => {
    try {
      const value = gl.getParameter(key);
      return [name, String(value)];
    } catch {
      return [name, 'unavailable'];
    }
  };
  const entries = [
    read('gl.RENDERER', gl.RENDERER),
    read('gl.VENDOR', gl.VENDOR),
    read('gl.VERSION', gl.VERSION),
    read('gl.SHADING_LANGUAGE_VERSION', gl.SHADING_LANGUAGE_VERSION),
    read('MAX_VARYING_VECTORS', gl.MAX_VARYING_VECTORS),
    read('MAX_VERTEX_UNIFORM_VECTORS', gl.MAX_VERTEX_UNIFORM_VECTORS),
    read('MAX_FRAGMENT_UNIFORM_VECTORS', gl.MAX_FRAGMENT_UNIFORM_VECTORS),
    read('MAX_VERTEX_ATTRIBS', gl.MAX_VERTEX_ATTRIBS),
    read('MAX_TEXTURE_IMAGE_UNITS', gl.MAX_TEXTURE_IMAGE_UNITS),
    read('MAX_COMBINED_TEXTURE_IMAGE_UNITS', gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
  ];
  const out: Record<string, string> = {};
  for (const [key, value] of entries) out[key] = value;
  out['WebGL2'] = String(renderer.capabilities.isWebGL2);
  out['shadowMap.enabled'] = String(renderer.shadowMap.enabled);
  return out;
}

/** Link status of every program three.js has built so far. */
function programSweep(renderer: THREE.WebGLRenderer): Array<Record<string, string>> {
  const gl = renderer.getContext() as WebGLRenderingContext;
  const programs = (renderer.info.programs ?? []) as unknown as Array<{
    program: WebGLProgram;
    cacheKey: string;
    usedTimes: number;
  }>;
  const rows: Array<Record<string, string>> = [];
  for (const entry of programs) {
    if (!entry?.program) continue;
    let linked = 'unavailable';
    try {
      linked = String(gl.getProgramParameter(entry.program, gl.LINK_STATUS));
    } catch {
      /* context lost or invalid program */
    }
    rows.push({
      linked,
      usedTimes: String(entry.usedTimes),
      cacheKey: (entry.cacheKey ?? '').slice(0, 120),
    });
  }
  return rows;
}

/** Material inventory for the world meshes that matter, by actual scene state. */
function worldMaterials(targets: DiagnosticsTargets): Array<{
  label: string;
  material: THREE.Material;
}> {
  const out: Array<{ label: string; material: THREE.Material }> = [];
  const terrain = targets.world?.terrain;
  const add = (label: string, mesh: THREE.Mesh | null | undefined) => {
    if (!mesh || !mesh.material) return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (material) out.push({ label: `${label} (visible=${mesh.visible})`, material });
  };
  add('terrain', terrain?.terrainMesh);
  add('water', terrain?.waterMesh);
  add('road', terrain?.roadSurfaceMesh);
  add('roadBridge', terrain?.roadBridgeMesh);
  return out;
}

export function installRendererDiagnostics(targets: DiagnosticsTargets): void {
  const { renderer, scene } = targets;
  const messages: CapturedMessage[] = [];
  const startedAt = Date.now();

  // Declared before any console wrapper is installed: `record()` calls
  // `render()`, and if a message arrives before the overlay exists, referencing
  // a const in its temporal dead zone would throw and mask the real error.
  let body: HTMLDivElement | null = null;
  let render: () => void = () => {};

  const record = (message: CapturedMessage) => {
    messages.push(message);
    if (messages.length > MAX_MESSAGES) messages.shift();
    render();
  };

  // --- capture, without swallowing ----------------------------------------
  // The original arguments are passed through to the real console first, so
  // DevTools shows exactly what three.js wrote. Only afterwards do we record.
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  /**
   * Runs `run` while collecting everything written to console.error/warn.
   * Used by the material probe to attribute a message to one material.
   */
  const capture = (run: () => void): CapturedMessage[] => {
    const collected: CapturedMessage[] = [];
    console.error = (...args: unknown[]) => {
      originalError(...args);
      collected.push({ kind: 'error', text: formatArgs(args), at: Date.now() });
    };
    console.warn = (...args: unknown[]) => {
      originalWarn(...args);
      collected.push({ kind: 'warn', text: formatArgs(args), at: Date.now() });
    };
    try {
      run();
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }
    return collected;
  };

  console.error = (...args: unknown[]) => {
    originalError(...args);
    record({ kind: 'error', text: formatArgs(args), at: Date.now() });
  };
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    record({ kind: 'warn', text: formatArgs(args), at: Date.now() });
  };

  window.addEventListener('error', (event) => {
    record({
      kind: 'exception',
      text: `${event.message}`,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      at: Date.now(),
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    record({ kind: 'rejection', text: formatArgs([event.reason]), at: Date.now() });
  });

  // --- overlay -------------------------------------------------------------
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'background:rgba(2,6,23,0.94)', 'color:#e2e8f0',
    'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
    'padding:10px', 'overflow:auto', 'white-space:pre-wrap',
    'word-break:break-word', '-webkit-user-select:text', 'user-select:text',
  ].join(';');

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px';
  const makeButton = (label: string, onClick: () => void) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.style.cssText =
      'font:inherit;padding:6px 10px;border-radius:6px;border:1px solid #334155;' +
      'background:#1e293b;color:#e2e8f0;cursor:pointer';
    button.addEventListener('click', onClick);
    return button;
  };

  body = document.createElement('div');

  render = () => {
    const limits = webglLimits(renderer);
    const sweep = programSweep(renderer);
    const failing = sweep.filter((row) => row.linked === 'false');
    const lines: string[] = [];
    lines.push('CI CRAFT renderer diagnostics   (?diag=1)');
    lines.push(`captured ${messages.length} message(s) since ${new Date(startedAt).toISOString()}`);
    lines.push('');
    lines.push('WEBGL LIMITS');
    for (const [key, value] of Object.entries(limits)) lines.push(`  ${key} = ${value}`);
    lines.push('');
    lines.push(`PROGRAMS  total=${sweep.length}  failing=${failing.length}`);
    for (const row of failing) lines.push(`  FAILED linked=${row.linked} ${row.cacheKey}`);
    lines.push('');
    lines.push('WORLD MESHES');
    for (const entry of worldMaterials(targets)) {
      const m = entry.material as THREE.MeshStandardMaterial;
      lines.push(
        `  ${entry.label}: name="${m.name || '(unnamed)'}" type=${m.type}` +
          ` vertexColors=${String(m.vertexColors)} map=${String(Boolean(m.map))}`
      );
    }
    lines.push('');
    lines.push(`SCENE  objects=${scene.children.length}`);
    lines.push('');
    lines.push('CAPTURED MESSAGES (verbatim)');
    if (messages.length === 0) lines.push('  (none)');
    for (const message of messages.slice(-40)) {
      lines.push(`  [${message.kind}] ${message.text}`);
      if (message.stack) lines.push(`      ${message.stack.split('\n').slice(1, 4).join('\n      ')}`);
    }
    if (body) body.textContent = lines.join('\n');
  };

  const probeButton = makeButton('PROBE MATERIALS', () => {
    const results = probeMaterials(renderer, worldMaterials(targets), capture);
    const lines = ['MATERIAL PROBE RESULTS'];
    for (const result of results) {
      lines.push('');
      lines.push(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}`);
      for (const message of result.messages) lines.push(`   ${message.text}`);
    }
    if (body) body.textContent = lines.join('\n');
    for (const result of results) {
      if (result.ok) continue;
      for (const message of result.messages) record({ ...message, text: `[probe ${result.label}] ${message.text}` });
    }
  });

  const copyButton = makeButton('COPY', () => {
    const text = body?.textContent ?? '';
    void navigator.clipboard?.writeText(text).catch(() => {
      // Clipboard can be blocked without a user gesture on some browsers.
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
      } finally {
        area.remove();
      }
    });
  });

  const closeButton = makeButton('CLOSE', () => {
    panel.remove();
    console.error = originalError;
    console.warn = originalWarn;
  });

  bar.append(probeButton, makeButton('REFRESH', render), copyButton, closeButton);
  if (body) panel.append(bar, body);
  document.body.appendChild(panel);
  render();

  originalWarn(
    '[CI Craft] renderer diagnostics active. Press PROBE MATERIALS, then COPY, and send the text back.'
  );
}

/** Returns true when diagnostics were requested via `?diag=1`. */
export function diagnosticsRequested(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get('diag') === '1';
}
