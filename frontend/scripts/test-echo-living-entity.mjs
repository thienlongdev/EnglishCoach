// Contract & unit verification for EchoLivingEntity + Spatial Ambient HUD (Reforge Contract C):
// 6-program ESSL 3.00 Obsidian Prism shaders (zero duplicate #version 300 es), LINK_STATUS guard,
// 12-state analytical springs, 32-bin Bark FFT + speechIntensityTier + canonical ec:echo-analyser,
// singleton WebGL2 stage (Dormant raf === 0, immersive priority 50, compile-failure fallback),
// zero-WebGL Obsidian Canvas2D renderer, SSR/node:vm compatibility, and 5-viewport zero-overlap HUD math.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as THREE from 'three';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const srcDir = path.join(root, 'src');

const readSrc = (rel) => fs.readFileSync(path.join(srcDir, rel), 'utf8');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

function compileModule(rel, dependencies = {}, globals = {}) {
  const source = readSrc(rel);
  const isTsx = rel.endsWith('.tsx');
  const { code } = babel.core().transformSync(source, {
    filename: rel,
    configFile: false,
    babelrc: false,
    presets: [babel.presetTypescript(), ...(isTsx ? [babel.presetReact()] : [])],
    plugins: [babel.pluginTransformModulesCommonjs()],
  });
  const exports = {};
  const moduleObj = { exports };
  const sandbox = {
    exports,
    module: moduleObj,
    require: (spec) => {
      if (spec in dependencies) return dependencies[spec];
      return require(spec);
    },
    React,
    console,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Float32Array,
    Uint8Array,
    Uint16Array,
    ArrayBuffer,
    URLSearchParams,
    Date,
    setTimeout,
    clearTimeout,
    ...globals,
  };
  runInNewContext(code, sandbox);
  return moduleObj.exports;
}

const OWNED_FILES = [
  'components/features/coach/EchoOrb.tsx',
  'components/features/coach/entity/EchoLivingEntity.tsx',
  'components/features/coach/entity/echoEntity.module.css',
  'components/features/coach/entity/echoGpuStage.ts',
  'components/features/coach/entity/echoShaders.ts',
  'components/features/coach/entity/echoSprings.ts',
  'components/features/coach/entity/echoAcousticBridge.ts',
  'components/features/coach/entity/echoCanvas2dFallback.ts',
];

const SPATIAL_HUD_FILES = [
  'components/features/coach/EchoCompanionAnchor.tsx',
  'components/features/coach/EchoJarvisAmbient.tsx',
  'components/features/coach/EchoImmersiveWorkspace.tsx',
  'components/features/coach/EchoCards.tsx',
  'components/features/coach/echo-companion.ts',
  'components/features/coach/useEchoCompanion.ts',
];

// ---------------------------------------------------------------------------
// 1. Static Banned-Token, Bundle-Isolation, Hook, HUD & CSS Contracts
// ---------------------------------------------------------------------------
await check('zero banned tokens, zero ampersand copy, zero legacy pill clutter, zero network/storage in entity, and zero main-bundle Three.js imports', () => {
  const bannedSubstrings = [
    'echo-presence',
    'echo-unread',
    'echo-orb',
    'Sparkles',
    '✨',
    'backdrop-filter',
    '!important',
    'font-family',
    'border-radius: 50%; background: radial-gradient(circle',
  ];

  for (const rel of OWNED_FILES) {
    const content = readSrc(rel);
    for (const token of bannedSubstrings) {
      assert.ok(!content.includes(token), `${rel} must never contain "${token}"`);
    }
    if (!rel.endsWith('.css')) {
      assert.doesNotMatch(
        content,
        /\bfetch\(|apiClient|axios|XMLHttpRequest|WebSocket|getUserMedia|localStorage|sessionStorage/,
        `${rel} must be a pure client visual/acoustic module without network, mic, or storage side effects`,
      );
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!line.includes('&') || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import ')) {
          continue;
        }
        for (const m of line.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
          assert.doesNotMatch(m[0], /[^\W\d_)] (?:&|&amp;) [^\W\d_(]/u, `${rel}: ampersand in string literal ${m[0]}`);
        }
      }
    }
  }

  // Verify Spatial HUD files contain zero banned tokens, zero legacy lavender pill, zero debug status badges,
  // and zero React-owned EchoJarvisAudioSession instantiation!
  const hudBanned = [
    'echo-jarvis-pill',
    'echo-jarvis-wake-chip',
    'Đã đánh thức · Đang nghe',
    'new EchoJarvisAudioSession',
    'Sparkles',
    '✨',
    'backdrop-filter',
    'echo-presence',
    'echo-unread',
    'echo-orb',
  ];
  for (const rel of SPATIAL_HUD_FILES) {
    const content = readSrc(rel);
    for (const token of hudBanned) {
      assert.ok(!content.includes(token), `${rel} must never contain "${token}"`);
    }
  }

  const coachCss = readSrc('components/features/coach/echo.css');
  assert.ok(!coachCss.includes('echo-jarvis-pill'), 'echo.css removes legacy .echo-jarvis-pill');
  assert.ok(!coachCss.includes('echo-jarvis-wake-chip'), 'echo.css removes legacy .echo-jarvis-wake-chip');
  assert.ok(!coachCss.includes('backdrop-filter'), 'echo.css maintains 0 backdrop-filter');
  assert.ok(coachCss.includes('[data-over-book-reader="true"]'), 'echo.css lifts z-index to 85 over BookReader');
  assert.ok(coachCss.includes('.echo-root .echo-confirm-buttons button:first-child'), 'echo.css restores high-contrast primary Confirm button on Light theme');
  assert.ok(coachCss.includes('.echo-panel.echo-expanded'), 'echo.css hides anchor while expanded chat is open');
  assert.ok(readSrc('components/features/coach/EchoJarvisAmbient.tsx').includes('createPortal'), 'EchoJarvisAmbient portals fixed CC/Toast outside transformed anchor host');
  assert.ok(readSrc('components/features/coach/EchoJarvisAmbient.tsx').includes('!showOrbit && !(isMobile && showToastCard)'), 'EchoJarvisAmbient suppresses CC while hover orbit or mobile toast is open');
  assert.ok(readSrc('components/features/coach/useEchoCompanion.ts').includes('[data-testid="guide-offer"]'), 'useEchoCompanion clears first-visit guide-offer popup');
  assert.ok(readSrc('components/features/coach/useEchoCompanion.ts').includes("attributeFilter: ['style']"), 'useEchoCompanion re-fits after async guide-offer style placement');

  // Main-bundle zero-Three.js contract
  const orbSrc = readSrc('components/features/coach/EchoOrb.tsx');
  const entitySrc = readSrc('components/features/coach/entity/EchoLivingEntity.tsx');
  assert.doesNotMatch(orbSrc, /from ['"]three['"]|echoGpuStage/, 'EchoOrb stays lightweight');
  assert.doesNotMatch(entitySrc, /from ['"]three['"]/, 'EchoLivingEntity never statically imports three');
  assert.match(entitySrc, /import\('\.\/echoGpuStage'\)/, 'EchoLivingEntity dynamically imports echoGpuStage');

  // Hook restriction under entity/ .tsx files for node:vm scheduler compatibility
  const allowedHooks = new Set(['useState', 'useRef', 'useEffect', 'useCallback', 'useSyncExternalStore', 'usePathname', 'useSearchParams']);
  for (const tsxRel of ['components/features/coach/EchoOrb.tsx', 'components/features/coach/entity/EchoLivingEntity.tsx']) {
    const src = readSrc(tsxRel);
    for (const m of src.matchAll(/\b(use[A-Z][A-Za-z0-9_]*)\b/g)) {
      assert.ok(allowedHooks.has(m[1]), `${tsxRel} uses unsupported hook ${m[1]}`);
    }
  }

  const cssSrc = readSrc('components/features/coach/entity/echoEntity.module.css');
  assert.match(cssSrc, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(cssSrc, /@media \(forced-colors: active\)/);
});

// ---------------------------------------------------------------------------
// 2. ESSL 3.00 Shader Rules & 6-Program Obsidian Prism Architecture (P0 Fix!)
// ---------------------------------------------------------------------------
const shaders = compileModule('components/features/coach/entity/echoShaders.ts');

await check('all 6 ESSL 3.00 shader pairs strip duplicate #version 300 es (THREE.GLSL3 injects it), enforce 0 ternaries, top-of-main fwidth, constant loops, SH l=0..4, and back-hemisphere culling', () => {
  assert.equal(shaders.ECHO_RING_CONFIGS.length, 7, '7 instanced gyroscopic lattice rings');
  assert.ok(shaders.ECHO_VIGNETTE_OUTER_RADIUS <= 1.80 && shaders.ECHO_VIGNETTE_OUTER_RADIUS < shaders.ECHO_FRUSTUM_HALF_EXTENT);

  const pairs = [
    ['halo.vert', shaders.ECHO_HALO_VERTEX_SHADER],
    ['halo.frag', shaders.ECHO_HALO_FRAGMENT_SHADER],
    ['core.vert', shaders.ECHO_CORE_VERTEX_SHADER],
    ['core.frag', shaders.ECHO_CORE_FRAGMENT_SHADER],
    ['wave.vert', shaders.ECHO_WAVE_VERTEX_SHADER],
    ['wave.frag', shaders.ECHO_WAVE_FRAGMENT_SHADER],
    ['rings.vert', shaders.ECHO_RINGS_VERTEX_SHADER],
    ['rings.frag', shaders.ECHO_RINGS_FRAGMENT_SHADER],
    ['trails.vert', shaders.ECHO_TRAILS_VERTEX_SHADER],
    ['trails.frag', shaders.ECHO_TRAILS_FRAGMENT_SHADER],
    ['aura.vert', shaders.ECHO_AURA_VERTEX_SHADER],
    ['aura.frag', shaders.ECHO_AURA_FRAGMENT_SHADER],
  ];

  for (const [label, glsl] of pairs) {
    // P0 CRITICAL FIX: Three.js RawShaderMaterial with glslVersion = THREE.GLSL3 prepends `#version 300 es`
    // automatically. Embedding `#version 300 es` in the shader source caused a fatal duplicate-directive error!
    assert.ok(!glsl.includes('#version 300 es'), `${label} must NOT embed #version 300 es (THREE.GLSL3 injects it once)`);
    const uncommented = glsl
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!uncommented.includes('?'), `${label} must contain 0 ternary ?: operators (ANGLE D3D11 struct/flow rule)`);

    // Every for-loop must use a compile-time integer literal bound
    for (const loopMatch of uncommented.matchAll(/for\s*\(([^)]*)\)/g)) {
      assert.match(loopMatch[1], /<\s*\d+\s*;/, `${label} for-loop must have constant integer upper bound: ${loopMatch[1]}`);
    }
  }

  // Verify echoGpuStage explicitly binds THREE.GLSL3 and verifies LINK_STATUS + gl.getError()
  const stageSrc = readSrc('components/features/coach/entity/echoGpuStage.ts');
  assert.ok(stageSrc.includes('material.glslVersion = THREE.GLSL3'), 'echoGpuStage sets THREE.GLSL3');
  assert.ok(stageSrc.includes('LINK_STATUS') && stageSrc.includes('getError'), 'echoGpuStage verifies LINK_STATUS and gl.getError() before live reveal');

  // Layer 2 fwidth() must appear before any if/for/discard in rings.frag main()
  const ringsMain = shaders.ECHO_RINGS_FRAGMENT_SHADER
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .split('void main()')[1];
  const firstFwidth = ringsMain.indexOf('fwidth(');
  const firstIf = ringsMain.search(/\b(if|for|discard)\b/);
  assert.ok(firstFwidth > 0 && (firstIf === -1 || firstFwidth < firstIf), 'fwidth() must be unconditional before flow control');

  // Verify render orders across all 6 programs
  assert.equal(shaders.ECHO_SHADER_PROGRAMS.halo.renderOrder, 5);
  assert.equal(shaders.ECHO_SHADER_PROGRAMS.core.renderOrder, 20);
  assert.equal(shaders.ECHO_SHADER_PROGRAMS.wave.renderOrder, 25);
  assert.equal(shaders.ECHO_SHADER_PROGRAMS.rings.renderOrder, 30);
  assert.equal(shaders.ECHO_SHADER_PROGRAMS.trails.renderOrder, 40);
  assert.deepEqual([...shaders.ECHO_SHADER_PROGRAMS.aura.renderOrders], [10, 50]);

  // Verify Layer 1 Radiant Pearlescent Abyss optical primitives + ACES filmic tone map + aurora light sheets
  assert.ok(shaders.ECHO_CORE_FRAGMENT_SHADER.includes('acesFilmic'), 'core.frag applies ACES filmic tone mapping');
  assert.ok(shaders.ECHO_CORE_FRAGMENT_SHADER.includes('evalLightSheet'), 'core.frag evaluates aurora spectral light sheets');
  assert.ok(shaders.ECHO_CORE_FRAGMENT_SHADER.includes('thinFilmNacre'), 'core.frag applies aragonite thin-film nacre interference');
  assert.ok(shaders.ECHO_CORE_FRAGMENT_SHADER.includes('sapphireDepthLight') && shaders.ECHO_CORE_FRAGMENT_SHADER.includes('sapphireDepthDark'), 'core.frag uses translucent sapphire depth substrate');
  assert.ok(shaders.ECHO_CORE_FRAGMENT_SHADER.includes('pearlHeartLight') && shaders.ECHO_CORE_FRAGMENT_SHADER.includes('colPearlWarm'), 'core.frag renders luminous pearl-white heart highlights');
  assert.ok(shaders.ECHO_CORE_FRAGMENT_SHADER.includes('colOpalCyan') && shaders.ECHO_CORE_FRAGMENT_SHADER.includes('colViolet') && shaders.ECHO_CORE_FRAGMENT_SHADER.includes('colRosePink'), 'core.frag combines opaline cyan, lavender-violet, and rose-pink nacre');

  // Guard strictly against dark navy-black (#060B1C / #040610 / #040817) opaque core regression across WebGL2, CSS, and Canvas2D!
  const forbiddenDarkObsidian = [
    '#060b1c',
    '#040610',
    '#02040b',
    '#020309',
    '#040814',
    '#050a1a',
    '0.016, 0.032, 0.090',
    '0.008, 0.016, 0.048',
  ];
  for (const rel of [
    'components/features/coach/entity/echoShaders.ts',
    'components/features/coach/entity/echoEntity.module.css',
    'components/features/coach/entity/echoCanvas2dFallback.ts',
  ]) {
    const lower = readSrc(rel).toLowerCase();
    for (const badColor of forbiddenDarkObsidian) {
      assert.ok(!lower.includes(badColor), `${rel} must never regress to dark obsidian navy-black "${badColor}"`);
    }
  }

  assert.ok(!shaders.ECHO_AURA_FRAGMENT_SHADER.includes('stippleDots'), 'aura.frag replaces Cartesian polka dots with silky curved plasma ribbons');
  assert.ok(shaders.ECHO_AURA_FRAGMENT_SHADER.includes('silkBands'), 'aura.frag renders silky 3D plasma ribbons during Speaking');

  // Verify Layer 3 1-pass gyroid synaptic constellation
  assert.ok(shaders.ECHO_TRAILS_VERTEX_SHADER.includes('gyroidCurl'), 'trails.vert uses 1-pass trigonometric gyroid curl');

  // Verify Layer 4 Spherical Harmonics l=0..4 terms + back-hemisphere culling + vignette
  for (const coeff of ['0.282095', '0.488603', '0.315392', '1.092548', '0.373176', '2.890611', '0.105786', '2.503343']) {
    assert.ok(shaders.ECHO_AURA_VERTEX_SHADER.includes(coeff), `Layer 4 SH basis includes orthonormal coefficient ${coeff}`);
  }
  assert.ok(shaders.ECHO_AURA_VERTEX_SHADER.includes('uniform float uSpectrum[32];'));
  assert.ok(shaders.ECHO_AURA_FRAGMENT_SHADER.includes('vViewZ'), 'aura.frag performs back-hemisphere view-Z culling');
  assert.ok(shaders.ECHO_AURA_FRAGMENT_SHADER.includes('smoothstep(1.80, 1.44, vRadiusLen)'));
});

// ---------------------------------------------------------------------------
// 3. All 12 States, Analytical Spring Math, Soft-Duck & MutationObserver Theme Bridge
// ---------------------------------------------------------------------------
const springsMod = compileModule('components/features/coach/entity/echoSprings.ts');

await check('all 12 required states, slot mapping, closed-form spring stability, soft-duck, impulses, and theme MutationObserver', () => {
  const expectedStates = [
    'disabled',
    'dormant',
    'awakening',
    'listening',
    'understanding',
    'thinking',
    'speaking',
    'executing',
    'interrupted',
    'reconnecting',
    'sleeping',
    'error',
  ];
  assert.deepEqual([...springsMod.ECHO_ENTITY_STATES], expectedStates);

  // Legacy 'idle' mapping: static launcher/ambient -> 'dormant', open welcome/rail/immersive -> calm 'awakening'
  assert.equal(springsMod.normalizeEchoEntityState('idle', 'launcher'), 'dormant');
  assert.equal(springsMod.normalizeEchoEntityState('idle', 'ambient'), 'dormant');
  assert.deepEqual({ ...springsMod.resolveEchoEntityState('idle', 'welcome') }, { state: 'awakening', calmIdle: true });
  assert.deepEqual({ ...springsMod.resolveEchoEntityState('idle', 'rail') }, { state: 'awakening', calmIdle: true });
  assert.deepEqual({ ...springsMod.resolveEchoEntityState('idle', 'immersive') }, { state: 'awakening', calmIdle: true });
  assert.equal(springsMod.normalizeEchoEntityState('streaming', 'welcome'), 'speaking');

  // Analytical spring unconditional stability across micro and giant tab-resume dt steps
  for (const dt of [0.0005, 1 / 120, 1 / 60, 0.08, 0.5, 10.0]) {
    const c1 = { x: -5.0, v: 25.0 };
    springsMod.stepCriticallyDamped(c1, 1.0, 11.0, dt);
    assert.ok(Number.isFinite(c1.x) && Number.isFinite(c1.v), `critically damped finite at dt=${dt}`);

    const c2 = { x: 0.2, v: 18.0 };
    springsMod.stepUnderDamped(c2, 1.0, 18.0, 0.64, dt);
    assert.ok(Number.isFinite(c2.x) && Number.isFinite(c2.v), `under-damped finite at dt=${dt}`);
  }
  const conv = { x: 0, v: 0 };
  for (let i = 0; i < 120; i++) springsMod.stepUnderDamped(conv, 1.0, 18.0, 0.64, 1 / 60);
  assert.ok(Math.abs(conv.x - 1.0) < 1e-3 && Math.abs(conv.v) < 1e-2, 'under-damped spring converges accurately');

  const bank = new springsMod.EchoSpringBank();

  // Dormant & Disabled strictly report shouldAnimate() === false
  bank.setState('dormant');
  assert.equal(bank.shouldAnimate(), false);
  bank.setState('disabled');
  assert.equal(bank.shouldAnimate(), false);

  // Awakening bloom from Dormant
  bank.setState('dormant');
  bank.setState('awakening');
  assert.equal(bank.shouldAnimate(), true);
  let peakScale = 0;
  for (let i = 0; i < 45; i++) {
    const s = bank.step(1 / 60, 0);
    if (s.uCoreScale > peakScale) peakScale = s.uCoreScale;
  }
  assert.ok(peakScale > 1.01, `awakening under-damped bloom overshoots 1.0 (peak=${peakScale.toFixed(4)})`);

  // Listening inward polarity + horizontal wave mix
  bank.setState('listening');
  let snap = bank.step(0.5, 0.6);
  assert.ok(snap.uRingAlign > 0.8 && snap.uAudioSource < -0.9 && snap.uAttention > 0.95 && snap.uListenWaveMix > 0.7);

  // Understanding 60-degree phase click
  const phaseBefore = snap.uRingPhaseClick;
  bank.setState('understanding');
  snap = bank.step(0.6, 0.2);
  assert.ok(Math.abs(snap.uRingPhaseClick - (phaseBefore + Math.PI / 3)) < 0.03, 'understanding advances ring phase by pi/3');

  // Thinking high-speed gyroscope, dash telemetry & synaptic constellation
  bank.setState('thinking');
  snap = bank.step(0.8, 0);
  assert.ok(snap.uPlasmaSpeed > 2.2 && snap.uRingSpeed > 2.4 && snap.uDashSpeed > 3.9 && snap.uConstellation > 0.7);

  // Speaking outward polarity, caustic wave field, and soft-duck attenuation
  bank.setState('speaking');
  const speakNormal = bank.step(0.6, 0.75, 0.62);
  assert.ok(speakNormal.uAudioSource > 0.9 && speakNormal.uHarmonicGain > 1.0 && speakNormal.uSpeakFieldMix > 0.7);
  bank.setSoftDuck(true);
  const speakDucked = bank.step(0.6, 0.75, 0.62);
  assert.ok(speakDucked.uHarmonicGain < speakNormal.uHarmonicGain, 'soft-duck gently attenuates speaking amplitude');
  bank.setSoftDuck(false);

  // Executing radial command wave uExecWave
  bank.setState('executing');
  let maxExecWave = 0;
  for (let i = 0; i < 40; i++) {
    maxExecWave = Math.max(maxExecWave, bank.step(1 / 60, 0).uExecWave);
  }
  assert.ok(maxExecWave > 0.75, `executing pulses uExecWave (max=${maxExecWave.toFixed(3)})`);

  // Interrupted recoil impulse uShockwave
  bank.setState('interrupted');
  let maxShock = 0;
  for (let i = 0; i < 20; i++) {
    maxShock = Math.max(maxShock, bank.step(1 / 60, 0).uShockwave);
  }
  assert.ok(maxShock > 0.35, `interrupted fires uShockwave recoil (max=${maxShock.toFixed(3)})`);
  for (let i = 0; i < 60; i++) snap = bank.step(1 / 60, 0);
  assert.ok(snap.uShockwave < 0.02, 'uShockwave settles cleanly back to 0');

  // Reconnecting 30 Hz power-save sweep
  bank.setState('reconnecting');
  snap = bank.step(0.5, 0);
  assert.equal(snap.fpsCap, 30);

  // Sleeping 650 ms fold -> settles to shouldAnimate() === false & canvasOpacity === 0
  bank.setState('sleeping');
  assert.equal(bank.shouldAnimate(), true);
  for (let i = 0; i < 45; i++) snap = bank.step(1 / 60, 0);
  assert.equal(bank.isSleepSettled(), true);
  assert.equal(bank.shouldAnimate(), false);
  assert.equal(snap.canvasOpacity, 0);

  // Error coral state -> settles to still after 4.0 s
  bank.setState('error');
  assert.equal(bank.shouldAnimate(), true);
  for (let i = 0; i < 90; i++) snap = bank.step(0.05, 0);
  assert.equal(bank.isErrorSettled(), true);
  assert.equal(bank.shouldAnimate(), false);

  // MutationObserver on <html> with 0 per-frame DOM reads
  let mutationCb = null;
  let computedStyleReads = 0;
  const htmlEl = {
    classList: { contains: (cls) => cls === 'dark' && htmlEl.dark },
    dark: false,
  };
  const themedSprings = compileModule('components/features/coach/entity/echoSprings.ts', {}, {
    document: { documentElement: htmlEl },
    window: {
      getComputedStyle: () => {
        computedStyleReads += 1;
        return { getPropertyValue: () => (htmlEl.dark ? '56 189 248' : '112 150 240') };
      },
    },
    MutationObserver: class {
      constructor(cb) { mutationCb = cb; }
      observe() {}
      disconnect() {}
    },
  });
  let observedTheme = null;
  const obs = new themedSprings.EchoThemeObserver((st) => { observedTheme = st; });
  assert.equal(obs.getSnapshot().isDark, false);
  const readsAfterInit = computedStyleReads;
  const liveBank = new themedSprings.EchoSpringBank();
  for (let i = 0; i < 120; i++) liveBank.step(1 / 60, 0);
  assert.equal(computedStyleReads, readsAfterInit, '0 getComputedStyle reads during 120 animation frames');
  htmlEl.dark = true;
  mutationCb();
  assert.equal(observedTheme.isDark, true);
  assert.ok(Math.abs(observedTheme.ambientRgb[0] - 56 / 255) < 1e-3);
  obs.dispose();
});

// ---------------------------------------------------------------------------
// 4. Zero-GC 32-Bin Perceptual Bark FFT, Canonical ec:echo-analyser & Speech Tiers
// ---------------------------------------------------------------------------
const acousticListeners = new Map();
const acousticWin = {
  addEventListener(type, fn) { acousticListeners.set(type, fn); },
  removeEventListener(type) { acousticListeners.delete(type); },
};
const acousticMod = compileModule('components/features/coach/entity/echoAcousticBridge.ts', {}, { window: acousticWin });

await check('32-bin Bark mapper, 8ms/65ms envelope, canonical ec:echo-analyser {channel,analyser} + legacy {kind,node}, and speechIntensityTier', () => {
  const edges = acousticMod.BARK_BAND_EDGES_HZ;
  assert.equal(edges.length, 33);
  assert.ok(Math.abs(edges[0] - 85) < 1e-3);
  assert.ok(Math.abs(edges[6] - 300) < 1e-3);
  assert.ok(Math.abs(edges[14] - 1000) < 1e-3);
  assert.ok(Math.abs(edges[24] - 3200) < 1e-3);
  assert.ok(Math.abs(edges[32] - 7800) < 1e-3);
  for (let i = 0; i < 32; i++) {
    assert.ok(edges[i + 1] > edges[i], `Bark edge ${i} strictly increasing`);
  }

  for (const [sampleRate, fftSize] of [[16000, 256], [48000, 512]]) {
    const bins = new Uint8Array(fftSize / 2);
    const out = new Float32Array(32);
    const exciteHz = (hz) => {
      bins.fill(0);
      const idx = Math.round((hz * fftSize) / sampleRate);
      bins[Math.max(0, Math.min(bins.length - 1, idx))] = 245;
      if (idx + 1 < bins.length) bins[idx + 1] = 180;
      acousticMod.mapFftToBark32(bins, sampleRate, fftSize, out);
    };

    exciteHz(180);
    assert.ok(out.slice(0, 6).reduce((a, b) => a + b, 0) > 0.4, `180 Hz F0 excites bins 0..5 at ${sampleRate} Hz`);
    exciteHz(650);
    assert.ok(out.slice(6, 14).reduce((a, b) => a + b, 0) > 0.4, `650 Hz F1 vowel excites bins 6..13 at ${sampleRate} Hz`);
    exciteHz(2100);
    assert.ok(out.slice(14, 24).reduce((a, b) => a + b, 0) > 0.4, `2100 Hz F2 vowel excites bins 14..23 at ${sampleRate} Hz`);
    exciteHz(5500);
    assert.ok(out.slice(24, 32).reduce((a, b) => a + b, 0) > 0.4, `5500 Hz sibilant excites bins 24..31 at ${sampleRate} Hz`);
  }

  // Distinct continuous speech intensity tiers (silence < whisper < normal < energetic)
  const tierSilence = acousticMod.classifySpeechIntensityTier(0.005, -52);
  const tierWhisper = acousticMod.classifySpeechIntensityTier(0.12, -36);
  const tierNormal = acousticMod.classifySpeechIntensityTier(0.42, -20);
  const tierEnergetic = acousticMod.classifySpeechIntensityTier(0.88, -8);
  assert.equal(tierSilence, 0);
  assert.ok(tierWhisper > 0.15 && tierWhisper < 0.42, `whisper tier in (0.15,0.42), got ${tierWhisper}`);
  assert.ok(tierNormal > 0.45 && tierNormal < 0.78, `normal tier in (0.45,0.78), got ${tierNormal}`);
  assert.ok(tierEnergetic > 0.80 && tierEnergetic <= 1.0, `energetic tier in (0.80,1.0], got ${tierEnergetic}`);
  assert.ok(tierSilence < tierWhisper && tierWhisper < tierNormal && tierNormal < tierEnergetic);

  // Asymmetric 8 ms attack vs 65 ms release
  const attacked = acousticMod.stepAsymmetricEnvelope(0, 1.0, 0.008);
  assert.ok(attacked > 0.62 && attacked < 0.65);
  const released = acousticMod.stepAsymmetricEnvelope(1.0, 0.0, 0.065);
  assert.ok(released > 0.35 && released < 0.38);

  // Canonical Contract B CustomEvent `{ channel, analyser }` AND legacy `{ kind, node }`
  acousticMod.resetEchoAcousticBridge();
  const mockMic = {
    fftSize: 256,
    frequencyBinCount: 128,
    context: { state: 'running', sampleRate: 16000 },
    getByteFrequencyData(arr) { arr.fill(0); arr[3] = 240; arr[10] = 210; },
    getByteTimeDomainData(arr) { for (let i = 0; i < arr.length; i++) arr[i] = i % 2 === 0 ? 168 : 88; },
  };
  const listener = acousticListeners.get('ec:echo-analyser');
  assert.ok(typeof listener === 'function', 'ec:echo-analyser event listener registered');
  listener({ detail: { channel: 'mic', analyser: mockMic } });
  const fMic = acousticMod.sampleEchoAcousticFrame('listening', 0.016, 100);
  assert.equal(fMic.mode, 'mic');
  assert.equal(fMic.source, -1);
  assert.ok(fMic.voiceRms > 0.35 && fMic.bass > 0.05 && Number.isFinite(fMic.spectralCentroid));

  // Legacy `{ kind, node }` event also binds cleanly
  const mockTts = {
    fftSize: 512,
    frequencyBinCount: 256,
    context: { state: 'running', sampleRate: 24000 },
    getByteFrequencyData(arr) { arr.fill(0); arr[18] = 230; arr[96] = 220; },
  };
  listener({ detail: { kind: 'tts', node: mockTts } });
  const fTts = acousticMod.sampleEchoAcousticFrame('speaking', 0.016, 120);
  assert.equal(fTts, fMic, 'reuses exact same pre-allocated EchoAcousticFrame (0 B/frame GC)');
  assert.equal(fTts.mode, 'tts');
  assert.equal(fTts.source, 1);
  assert.ok(fTts.visemeEnergy > 0.01);
  acousticMod.resetEchoAcousticBridge();

  // speechSynthesis.onboundary fallback
  const clsSib = acousticMod.triggerEchoSpeechBoundary('She sells seashells', 0, 160, 200);
  assert.equal(clsSib, 'sibilant');
  const fBound = acousticMod.sampleEchoAcousticFrame('speaking', 0.016, 260);
  assert.equal(fBound.mode, 'boundary');
  assert.equal(fBound.source, 1);
  assert.ok(fBound.treble > fBound.bass);
  acousticMod.resetEchoAcousticBridge();
});

// ---------------------------------------------------------------------------
// 5. Singleton EchoGpuStage: LINK_STATUS Guard, Dormant raf === 0, Priority & Eviction
// ---------------------------------------------------------------------------
await check('Singleton EchoGpuStage enforces <= 1 WebGLRenderer, LINK_STATUS compile guard, Dormant raf === 0, immersive priority 50, route eviction, and reduced motion', async () => {
  let rendererCount = 0;
  let loseContextCalls = 0;
  let nextRaf = 1;
  const activeRafs = new Map();
  let reducedMotion = false;
  let forceLinkFailure = false;
  let currentLoc = { pathname: '/grammar', search: '' };

  class FakeWebGL2RenderingContext {
    LINK_STATUS = 0x8B82;
    NO_ERROR = 0;
    createVertexArray() { return {}; }
    getProgramParameter(_program, pname) {
      if (pname === this.LINK_STATUS) return !forceLinkFailure;
      return true;
    }
    getError() { return this.NO_ERROR; }
    getExtension(name) {
      if (name === 'WEBGL_lose_context') {
        return { loseContext() { loseContextCalls += 1; } };
      }
      return null;
    }
    flush() {}
  }

  const fakeThree = {
    ...THREE,
    WebGLRenderer: class {
      constructor({ canvas }) {
        rendererCount += 1;
        this.domElement = canvas;
        this.gl = new FakeWebGL2RenderingContext();
        this.info = {
          programs: [
            { id: 1, program: {} },
            { id: 2, program: {} },
            { id: 3, program: {} },
            { id: 4, program: {} },
            { id: 5, program: {} },
            { id: 6, program: {} },
          ],
        };
        this.disposed = false;
      }
      getContext() { return this.gl; }
      setClearColor() {}
      setPixelRatio() {}
      setSize() {}
      setScissorTest() {}
      setScissor() {}
      async compileAsync() {}
      compile() {}
      render() {}
      dispose() { this.disposed = true; }
    },
  };

  const makeHost = (name) => ({
    name,
    clientWidth: 160,
    clientHeight: 160,
    children: [],
    appendChild(child) {
      if (child.parentElement && child.parentElement !== this) {
        const idx = child.parentElement.children.indexOf(child);
        if (idx >= 0) child.parentElement.children.splice(idx, 1);
      }
      if (!this.children.includes(child)) this.children.push(child);
      child.parentElement = this;
    },
  });

  const canvasListeners = new Map();
  const fakeDoc = {
    hidden: false,
    documentElement: {
      classList: { contains: () => false },
      hasAttribute: () => false,
    },
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return {
        dataset: {},
        style: {},
        width: 128,
        height: 128,
        parentElement: null,
        setAttribute() {},
        addEventListener(type, fn) { canvasListeners.set(type, fn); },
        removeEventListener(type) { canvasListeners.delete(type); },
        remove() {
          if (this.parentElement) {
            const idx = this.parentElement.children.indexOf(this);
            if (idx >= 0) this.parentElement.children.splice(idx, 1);
            this.parentElement = null;
          }
        },
      };
    },
  };

  const fakeWin = {
    devicePixelRatio: 1.5,
    location: currentLoc,
    WebGL2RenderingContext: FakeWebGL2RenderingContext,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '112 150 240' }),
    matchMedia: (q) => ({ matches: q.includes('reduced') ? reducedMotion : false, addEventListener() {} }),
    requestAnimationFrame(cb) {
      const id = nextRaf++;
      activeRafs.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      activeRafs.delete(id);
    },
    setTimeout: () => 1,
    clearTimeout() {},
  };

  const vfxQualityMod = compileModule('lib/vfx/quality.ts', {}, {
    window: fakeWin,
    navigator: { hardwareConcurrency: 8, deviceMemory: 8 },
    innerWidth: 1440,
    matchMedia: fakeWin.matchMedia,
  });

  const stageSprings = compileModule('components/features/coach/entity/echoSprings.ts', {}, {
    document: fakeDoc,
    window: fakeWin,
  });
  const stageAcoustic = compileModule('components/features/coach/entity/echoAcousticBridge.ts', {}, {
    document: fakeDoc,
    window: fakeWin,
    performance: { now: () => 100 },
  });

  const gpuStageMod = compileModule(
    'components/features/coach/entity/echoGpuStage.ts',
    {
      three: fakeThree,
      '@/lib/vfx/quality': vfxQualityMod,
      './echoShaders': shaders,
      './echoSprings': stageSprings,
      './echoAcousticBridge': stageAcoustic,
    },
    {
      window: fakeWin,
      document: fakeDoc,
      WebGL2RenderingContext: FakeWebGL2RenderingContext,
      performance: { now: () => 100 },
    },
  );

  // Route policy checks
  assert.equal(gpuStageMod.evaluateEchoEntityRoutePolicy('/speaking/arena', ''), 'evict');
  assert.equal(gpuStageMod.evaluateEchoEntityRoutePolicy('/study-space', ''), 'evict');
  assert.equal(gpuStageMod.evaluateEchoEntityRoutePolicy('/learning-path', ''), 'evict');
  assert.equal(gpuStageMod.evaluateEchoEntityRoutePolicy('/learning-path', '?view=list'), 'allow');
  assert.equal(gpuStageMod.evaluateEchoEntityRoutePolicy('/games/echo-garden', ''), 'evict');
  assert.equal(gpuStageMod.evaluateEchoEntityRoutePolicy('/exams/toeic/attempts/99', ''), 'evict');
  assert.equal(gpuStageMod.evaluateEchoEntityRoutePolicy('/knowledge-universe', ''), 'cosmos-defer');
  assert.equal(gpuStageMod.evaluateEchoEntityRoutePolicy('/leaderboard', ''), 'leaderboard-cap');
  assert.equal(gpuStageMod.evaluateEchoEntityRoutePolicy('/grammar', ''), 'allow');

  const stage = gpuStageMod.getEchoGpuStage();
  const launcherHost = makeHost('launcher');
  const ambientHost = makeHost('ambient');
  const welcomeHost = makeHost('welcome');
  const voiceHost = makeHost('voice');
  const immersiveHost = makeHost('immersive');
  const liveFlags = { launcher: false, ambient: false, welcome: false, voice: false, immersive: false };

  // 1) Dormant launcher -> strictly rafId === 0, 0 active loops!
  const unregLauncher = stage.registerSlot({
    id: 'slot-launcher',
    slot: 'launcher',
    hostEl: launcherHost,
    rawState: 'idle',
    sizePx: 64,
    pathname: '/grammar',
    search: '',
    visible: true,
    onLiveChange: (v) => { liveFlags.launcher = v; },
  });
  await gpuStageMod.prewarmEchoEntityGpuStage();
  let diag = gpuStageMod.getEchoEntityStageDiagnostics();
  assert.equal(diag.prewarmed, true);
  assert.equal(diag.compileFailed, false);
  assert.equal(diag.rafId, 0, 'Dormant prewarm parks immediately with raf === 0');
  assert.equal(activeRafs.size, 0);
  assert.equal(liveFlags.launcher, false);

  // 2) Ambient slot (priority 16) activates cleanly when listening
  const unregAmbient = stage.registerSlot({
    id: 'slot-ambient',
    slot: 'ambient',
    hostEl: ambientHost,
    rawState: 'listening',
    sizePx: 88,
    pathname: '/grammar',
    search: '',
    visible: true,
    onLiveChange: (v) => { liveFlags.ambient = v; },
  });
  assert.equal(rendererCount, 1);
  assert.equal(liveFlags.ambient, true);
  assert.equal(gpuStageMod.getEchoEntityStageDiagnostics().activeSlotKind, 'ambient');

  // 3) Welcome (20) < Voice (40) < Immersive (50) priority ordering with strictly 1 WebGLRenderer
  const unregWelcome = stage.registerSlot({
    id: 'slot-welcome',
    slot: 'welcome',
    hostEl: welcomeHost,
    rawState: 'thinking',
    sizePx: 150,
    pathname: '/grammar',
    search: '',
    visible: true,
    onLiveChange: (v) => { liveFlags.welcome = v; },
  });
  assert.equal(gpuStageMod.getEchoEntityStageDiagnostics().activeSlotKind, 'welcome');
  assert.equal(liveFlags.welcome, true);
  assert.equal(liveFlags.ambient, false);

  const unregVoice = stage.registerSlot({
    id: 'slot-voice',
    slot: 'voice',
    hostEl: voiceHost,
    rawState: 'listening',
    sizePx: 214,
    pathname: '/grammar',
    search: '',
    visible: true,
    onLiveChange: (v) => { liveFlags.voice = v; },
  });
  assert.equal(gpuStageMod.getEchoEntityStageDiagnostics().activeSlotKind, 'voice');
  assert.equal(liveFlags.voice, true);

  const unregImmersive = stage.registerSlot({
    id: 'slot-immersive',
    slot: 'immersive',
    hostEl: immersiveHost,
    rawState: 'speaking',
    sizePx: 236,
    pathname: '/grammar',
    search: '',
    visible: true,
    onLiveChange: (v) => { liveFlags.immersive = v; },
  });
  assert.equal(rendererCount, 1, 'still strictly 1 WebGLRenderer across all 5 mounted slots');
  diag = gpuStageMod.getEchoEntityStageDiagnostics();
  assert.equal(diag.activeSlotKind, 'immersive', 'immersive slot (50) wins priority over voice (40)');
  assert.equal(diag.programDelta, 0, 'programDelta === 0 across slot reparenting');
  assert.equal(liveFlags.immersive, true);
  assert.equal(liveFlags.voice, false);

  unregImmersive();
  assert.equal(gpuStageMod.getEchoEntityStageDiagnostics().activeSlotKind, 'voice');
  unregVoice();
  assert.equal(gpuStageMod.getEchoEntityStageDiagnostics().activeSlotKind, 'welcome');
  unregAmbient();

  // 4) prefers-reduced-motion: reduce -> renders 1 settled frame and halts (raf === 0)
  reducedMotion = true;
  stage.updateSlot('slot-welcome', { rawState: 'speaking' });
  assert.equal(gpuStageMod.getEchoEntityStageDiagnostics().rafId, 0);
  assert.equal(activeRafs.size, 0);
  reducedMotion = false;

  // 5) WebGL context loss -> cancels loop and reveals fallback immediately
  stage.updateSlot('slot-welcome', { rawState: 'thinking' });
  assert.ok(gpuStageMod.getEchoEntityStageDiagnostics().rafId > 0);
  canvasListeners.get('webglcontextlost')({ preventDefault() {} });
  diag = gpuStageMod.getEchoEntityStageDiagnostics();
  assert.equal(diag.contextLost, true);
  assert.equal(diag.rafId, 0);
  assert.equal(liveFlags.welcome, false);
  canvasListeners.get('webglcontextrestored')();
  assert.equal(gpuStageMod.getEchoEntityStageDiagnostics().contextLost, false);

  // 6) Eviction on /speaking/arena
  currentLoc.pathname = '/speaking/arena';
  stage.updateSlot('slot-welcome', { pathname: '/speaking/arena' });
  stage.updateSlot('slot-launcher', { pathname: '/speaking/arena' });
  assert.equal(gpuStageMod.getEchoEntityStageDiagnostics().hasContext, false);
  assert.ok(loseContextCalls >= 1);

  // 7) P0 REGRESSION GUARD: Simulated shader LINK_STATUS failure MUST NEVER flip liveFlags true!
  currentLoc.pathname = '/grammar';
  forceLinkFailure = true;
  liveFlags.welcome = false;
  stage.updateSlot('slot-launcher', { pathname: '/grammar' });
  stage.updateSlot('slot-welcome', { pathname: '/grammar', rawState: 'listening' });
  diag = gpuStageMod.getEchoEntityStageDiagnostics();
  assert.equal(diag.compileFailed, true, 'failed LINK_STATUS marks compileFailed=true');
  assert.equal(liveFlags.welcome, false, 'failed shader compile NEVER hides CSS/Canvas2D fallback');
  assert.equal(diag.rafId, 0, 'failed shader compile holds raf === 0');
  forceLinkFailure = false;

  unregWelcome();
  unregLauncher();
});

// ---------------------------------------------------------------------------
// 6. SSR & node:vm Rendering Compatibility + Zero-WebGL Canvas2D Renderer
// ---------------------------------------------------------------------------
await check('EchoOrb, EchoLivingEntity SSR/node:vm fallback and zero-WebGL Canvas2D Obsidian renderer', () => {
  const StubSwimmer = ({ className }) => React.createElement('div', { className, 'data-stub-swimmer': '' });
  const canvas2dMod = compileModule('components/features/coach/entity/echoCanvas2dFallback.ts');

  const entityMod = compileModule('components/features/coach/entity/EchoLivingEntity.tsx', {
    react: React,
    'next/navigation': { usePathname: () => '/dashboard', useSearchParams: () => new URLSearchParams('') },
    '@/components/brand/EchoSwimmer': { EchoSwimmer: StubSwimmer },
    './echoSprings': springsMod,
    './echoAcousticBridge': acousticMod,
    './echoCanvas2dFallback': canvas2dMod,
    './echoEntity.module.css': {},
  });
  const orbMod = compileModule('components/features/coach/EchoOrb.tsx', {
    react: React,
    './entity/EchoLivingEntity': entityMod,
    './entity/echoSprings': springsMod,
    './entity/echoAcousticBridge': acousticMod,
  });

  const htmlWelcome = renderToStaticMarkup(React.createElement(orbMod.EchoOrb, { size: 'md', state: 'idle' }));
  assert.ok(htmlWelcome.includes('echo-pearl') && htmlWelcome.includes('data-stub-swimmer=""') && htmlWelcome.includes('<svg'));

  const htmlAmbient = renderToStaticMarkup(
    React.createElement(orbMod.EchoOrb, { slot: 'ambient', size: 88, state: 'listening' }),
  );
  assert.ok(htmlAmbient.includes('data-slot="ambient"') && htmlAmbient.includes('data-entity-state="listening"'));
  assert.ok(!htmlAmbient.includes('data-stub-swimmer'), 'ambient slot renders pure obsidian sphere without swimmer overlay');

  const htmlImmersive = renderToStaticMarkup(
    React.createElement(orbMod.EchoOrb, { slot: 'immersive', size: 236, state: 'speaking' }),
  );
  assert.ok(htmlImmersive.includes('data-slot="immersive"') && htmlImmersive.includes('data-entity-state="speaking"'));
  assert.ok(htmlImmersive.includes('data-visual-mode="essence"'), 'SSR renders deterministic essence visual mode before client WebGL mount');

  const htmlDeactivated = renderToStaticMarkup(
    React.createElement(orbMod.EchoOrb, { slot: 'ambient', size: 64, state: 'dormant', active: false }),
  );
  assert.ok(
    htmlDeactivated.includes('data-entity-state="disabled"') &&
      htmlDeactivated.includes('data-visual-mode="disabled"') &&
      !htmlDeactivated.includes('data-visual-ready'),
    'active={false} forces clean disabled visual mode with zero readiness flag',
  );
  assert.equal(typeof orbMod.deactivateEchoEntityStage, 'function', 'EchoOrb exports deactivateEchoEntityStage teardown helper');

  // Zero-WebGL Obsidian Canvas2D smoke render across active states
  let drawOps = 0;
  const grad = { addColorStop() {} };
  const fakeCtx = {
    clearRect() { drawOps++; },
    fillRect() { drawOps++; },
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    beginPath() {},
    closePath() {},
    arc() { drawOps++; },
    ellipse() { drawOps++; },
    moveTo() {},
    lineTo() {},
    clip() {},
    fill() { drawOps++; },
    stroke() { drawOps++; },
    setLineDash() {},
    createRadialGradient() { return grad; },
    createLinearGradient() { return grad; },
  };
  const bank = new springsMod.EchoSpringBank();
  for (const st of ['listening', 'thinking', 'speaking']) {
    bank.setState(st);
    const snap = bank.snapToTarget(0.5);
    const acoustic = acousticMod.sampleEchoAcousticFrame(st, 0.016, 200);
    canvas2dMod.renderEchoObsidianCanvas2d({ ctx: fakeCtx, width: 192, height: 192, timeSec: 1.2, snap, acoustic });
  }
  assert.ok(drawOps > 40, `Obsidian Canvas2D executes crisp multi-layer draws across states (ops=${drawOps})`);
});

// ---------------------------------------------------------------------------
// 7. Five-Viewport Spatial Zero-Overlap Geometry Assertions
// ---------------------------------------------------------------------------
await check('5-viewport Ambient overlay layout and safe bounds guarantee 0 px^2 orb overlap and zero off-screen clipping', () => {
  const geom = compileModule('components/features/coach/echo-companion.ts');
  const viewports = [
    { width: 2560, height: 1440 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ];

  for (const vp of viewports) {
    const anchorSize = vp.width < 640 ? 58 : 64;
    const visualSize = vp.width < 640 ? 76 : 88;
    const bounds = geom.computeSafeBounds(vp, anchorSize, 'right', {
      topBarBottom: 56,
      dock: { left: vp.width / 2 - 260, right: vp.width / 2 + 260, top: vp.height - 78, bottom: vp.height - 10 },
      clearRects: [{ left: vp.width - 280, right: vp.width - 12, top: vp.height - 96, bottom: vp.height - 20 }],
    });
    assert.ok(bounds.top >= 56 && bounds.bottom <= vp.height - 96, `safe bounds clear topBar and bottom obstacle at ${vp.width}x${vp.height}`);

    for (const side of ['left', 'right']) {
      for (const yShare of [0, 0.5, 1]) {
        const pt = geom.pointOf({ side, y: yShare }, anchorSize, bounds);
        const layout = geom.computeAmbientOverlayLayout(pt, anchorSize, visualSize, vp, 5);
        const cx = pt.x + anchorSize / 2;
        const cy = pt.y + anchorSize / 2;
        const orbBox = { left: cx - visualSize / 2, right: cx + visualSize / 2, top: cy - visualSize / 2, bottom: cy + visualSize / 2 };

        // Radial orbit buttons (32x32) strictly inside viewport, 0 px^2 self-overlap, 0 px^2 orb overlap!
        assert.equal(layout.orbitOffsets.length, 5);
        const radialBoxes = layout.orbitOffsets.map((off) => {
          const bx = cx + off.x;
          const by = cy + off.y;
          assert.ok(bx - 16 >= 10 && bx + 16 <= vp.width - 10 && by - 16 >= 10 && by + 16 <= vp.height - 10, `radial button on-screen at ${vp.width}x${vp.height}`);
          const box = { left: bx - 16, right: bx + 16, top: by - 16, bottom: by + 16 };
          const hitsOrb = box.left < orbBox.right && box.right > orbBox.left && box.top < orbBox.bottom && box.bottom > orbBox.top;
          assert.ok(!hitsOrb, `radial button has 0 px^2 AABB overlap with orb at ${vp.width}x${vp.height} side=${side} y=${yShare}`);
          return box;
        });
        for (let i = 0; i < radialBoxes.length; i++) {
          for (let j = i + 1; j < radialBoxes.length; j++) {
            const a = radialBoxes[i], b = radialBoxes[j];
            const selfOverlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
            assert.ok(!selfOverlap, `radial buttons ${i} & ${j} have 0 px^2 AABB self-overlap at ${vp.width}x${vp.height} side=${side} y=${yShare}`);
          }
        }

        // Ephemeral toast box stays strictly on-screen and never intersects orb even for a tall 280px confirm card!
        const t = layout.toastBox;
        const simToastH = Math.min(280, t.maxHeight);
        const tTop = t.bottom !== undefined ? vp.height - t.bottom - simToastH : t.top;
        const tBottom = tTop + simToastH;
        assert.ok(t.left >= 12 && t.left + t.width <= vp.width - 12, `toast horizontally on-screen at ${vp.width}x${vp.height}`);
        assert.ok(tTop >= 12 && tBottom <= vp.height - 12, `toast vertically on-screen at ${vp.width}x${vp.height}`);
        const overlapsOrb = t.left < orbBox.right && t.left + t.width > orbBox.left && tTop < orbBox.bottom && tBottom > orbBox.top;
        assert.ok(!overlapsOrb, `280px confirm toast never overlaps orb at ${vp.width}x${vp.height} side=${side} y=${yShare}`);

        // Opt-in CC ribbon stays on-screen and right-anchored when on desktop right side
        const c = layout.captionBox;
        if (vp.width >= 640 && side === 'right') {
          assert.ok(typeof c.right === 'number' && c.right >= 12, `desktop right-side CC is right-anchored at ${vp.width}x${vp.height}`);
        }

        // Simultaneous open toast + open radial micro-orbit: 0 px^2 AABB overlap between toast and ALL 5 radial buttons!
        const layoutOpen = geom.computeAmbientOverlayLayout(pt, anchorSize, visualSize, vp, 5, true);
        const to = layoutOpen.toastBox;
        const simOpenH = Math.min(268, to.maxHeight);
        const toTop = to.bottom !== undefined ? vp.height - to.bottom - simOpenH : to.top;
        const toBottom = toTop + simOpenH;
        for (let i = 0; i < layoutOpen.orbitOffsets.length; i++) {
          const off = layoutOpen.orbitOffsets[i];
          const b = { left: cx + off.x - 16, right: cx + off.x + 16, top: cy + off.y - 16, bottom: cy + off.y + 16 };
          const toastHitsRadial = to.left < b.right && to.left + to.width > b.left && toTop < b.bottom && toBottom > b.top;
          assert.ok(!toastHitsRadial, `open toast has 0 px^2 overlap with radial button ${i} at ${vp.width}x${vp.height} side=${side} y=${yShare}`);
        }
      }
    }
  }
});

console.log(`\nEchoLivingEntity & Spatial UX PASS: ${passed} contract and mathematical groups verified.`);
