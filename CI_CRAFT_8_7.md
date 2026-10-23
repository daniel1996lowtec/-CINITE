# CI CRAFT 8.7 — capturing the real WebGL error

**The exact error is still not captured, and the root cause is still not
confirmed. That is what this round builds the means to fix.** No speculative
geometry or shader change was made.

Two things did come out of it, both concrete:

1. **A defect in my own 8.6 diagnostics, found and removed.** Setting
   `renderer.debug.onShaderError` makes three.js call the hook *instead of* its
   own reporter — and its reporter is the only thing that prints
   `Material Name`, `Material Type` and the annotated shader source. 8.6 would
   have thrown away the most useful part of the error. It was **never merged, so
   the live site is unaffected** (verified below).
2. **You can read the real error today, without a deploy**, because the live
   build still has three.js's default reporter intact. Steps in §2.

---

## 1. Why the previous hook was wrong, in three.js's own code

`three.module.js` 0.183.2, `WebGLProgram.onFirstUse()`:

```js
if ( renderer.debug.checkShaderErrors ) {
  ...
  if ( gl.getProgramParameter( program, gl.LINK_STATUS ) === false ) {
    runnable = false;
    if ( typeof renderer.debug.onShaderError === 'function' ) {
      renderer.debug.onShaderError( gl, program, glVertexShader, glFragmentShader );
    } else {
      // default error reporting
      const vertexErrors = getShaderErrors( gl, glVertexShader, 'vertex' );
      const fragmentErrors = getShaderErrors( gl, glFragmentShader, 'fragment' );
      error(
        'THREE.WebGLProgram: Shader Error ' + gl.getError() + ' - ' +
        'VALIDATE_STATUS ' + gl.getProgramParameter( program, gl.VALIDATE_STATUS ) + '\n\n' +
        'Material Name: ' + self.name + '\n' +
        'Material Type: ' + self.type + '\n\n' +
        'Program Info Log: ' + programLog + '\n' +
        vertexErrors + '\n' + fragmentErrors
      );
    }
  }
```

The callback receives `(gl, program, glVertexShader, glFragmentShader)` — **no
material** — while the default branch has `self` and prints the material name,
the material type, and a per-line annotated copy of both shaders. Overriding the
hook is strictly a downgrade.

Also confirmed:
* `checkShaderErrors` defaults to `true` (`three.module.js:15975`).
* Nothing in this repo ever set it to `false`.
* A failed link leaves the mesh **not drawn at all** — nothing is rendered in its
  place. That is why "the terrain is missing" looks like "the world is covered in
  turquoise water with buildings floating".

## 2. Read the real error right now, with no deploy

`origin/main` is `89b921c` and contains **zero** occurrences of `onShaderError`,
so the deployed site runs three.js's full default reporter. You do not need my
new code to get the answer.

**On a desktop browser (fastest):**

1. Open the live site and press `F12` (or `Ctrl+Shift+J`) → **Console** tab.
2. Start or join a match and walk until the world looks broken.
3. In the Console filter box type `THREE.WebGLProgram`.
4. Right-click the red message → **Copy message**, and send it.

**On the phone (no extra software):**

1. Connect the phone to a computer by USB and enable **USB debugging** in
   Developer options.
2. On the computer open `chrome://inspect` in Chrome/Edge and pick the CI Craft
   tab → **inspect**. This opens DevTools pointing at the phone.
3. Same as above: Console → filter `THREE.WebGLProgram` → copy the red error.

What I need is the block beginning `THREE.WebGLProgram: Shader Error …`. The two
lines that matter most are:

* `Material Name:` / `Material Type:` — names the failing material outright.
* the first few `ERROR: 0:…` lines — gives the line in the *generated* shader,
  which tells us whether it is a varying/uniform limit, a syntax fault from the
  injected block, or something else.

If the Console is **empty** of `THREE.WebGLProgram` lines, that is equally
valuable: it rules out a shader failure entirely and points at depth, culling or
material state instead.

## 3. What was built anyway (for when DevTools is impractical)

`src/debug/RendererDiagnostics.ts`, activated **only** by `?diag=1`:

* Leaves `renderer.debug.onShaderError` and `checkShaderErrors` untouched.
* Wraps `console.error` / `console.warn`, **calls through to the real console
  first** (so DevTools shows the original text), then records the verbatim
  arguments and stack.
* Captures `window.onerror` and `unhandledrejection`.
* Reads WebGL limits from the live context: `RENDERER`, `VENDOR`, `VERSION`,
  `SHADING_LANGUAGE_VERSION`, **`MAX_VARYING_VECTORS`**,
  `MAX_VERTEX_UNIFORM_VECTORS`, `MAX_FRAGMENT_UNIFORM_VECTORS`,
  `MAX_VERTEX_ATTRIBS`, `MAX_TEXTURE_IMAGE_UNITS`, plus `isWebGL2`.
* **PROBE MATERIALS** — the part that names the culprit. `renderer.compile()`
  forces a program build; running it on a one-triangle scene per material makes
  the driver report on exactly one material at a time. Because three.js's default
  reporter is still doing the talking, each result carries the real
  `Material Name` / `Material Type` / shader source. Probes terrain, water, road
  and road-bridge materials as actually attached to the live scene.
* Link-status sweep of every program three.js has built
  (`renderer.info.programs` + `getProgramParameter(LINK_STATUS)`).
* Full-screen overlay with **PROBE MATERIALS / REFRESH / COPY / CLOSE**.

It is entirely client-side: no network calls, no server endpoint, no secrets in
the DOM. Removal simply closes the panel and restores the console functions.

**Caveat:** reaching you through `?diag=1` requires merging to `main` so Render
rebuilds. I have not merged. §2 needs no deploy.

## 4. Files changed

| File | Change |
| --- | --- |
| `src/core/GameEngine.ts` | **removed** the 8.6 `onShaderError` override (it destroyed material identity); added `getDiagnosticsTargets()` returning the live renderer + scene read-only |
| `src/debug/RendererDiagnostics.ts` | **new** — opt-in capture, WebGL limits, per-material probe, link sweep, copyable overlay |
| `src/main.ts` | installs diagnostics only when `diagnosticsRequested()` |
| `tests/graphics87.test.mjs` | **new** — 5 tests, including guards that neither module ever assigns `onShaderError` / `checkShaderErrors` |
| `package.json` | `graphics87` registered in `test` and `test:graphics61` |

No geometry, shader, material, or gameplay file was modified.

## 5. Validation

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm test` | **193 / 193 pass** (188 + 5 new) |
| `npm run build` | exit 0, 597 ms |
| `npm run audit:geometry` | **PASS** — 712 meshes, 339,386 triangles |
| `visualAudit` | 706 meshes, **colliders 1414 — unchanged** |

The new tests are discriminating: `git show HEAD:src/core/GameEngine.ts` still
contains the old override, and the guard test fails against it.

Gameplay untouched: BR, FFA, TDM, multiplayer, late joining,
server-authoritative combat, building, weapons, inventory, respawning, scoring,
chat, mobile HUD and controls are unchanged.

## 6. Final report answers

1. **Exact error** — **not yet captured.** That is the deliverable of this round,
   and §2 is the fastest route to it.
2. **Root cause** — **not confirmed.** The terrain-shader hypothesis from 8.6
   remains a hypothesis; nothing here confirms it.
3. **Files changed** — see §4.
4. **Tests** — 193/193, tsc clean, build 597 ms, audit PASS, colliders 1414.
5. **Actual browser verification** — **not performed.** There is no GPU, no
   WebGL, no Chromium and no `/dev/dri` in this sandbox, so I cannot compile GLSL
   or render a frame. **What I need from your browser is the
   `THREE.WebGLProgram` console text from §2** — or an explicit "the console
   shows nothing", which is just as diagnostic.

I have not claimed the world is fixed, and I have not changed any rendering code
that would affect it.
