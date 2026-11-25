// Echo Background Studio contract test suite — deterministic pure TS execution (via Next's bundled Babel)
// + static DOM/CSS/UI/Backend verification covering all acceptance criteria.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const repoRoot = path.resolve(frontendRoot, '..');
const srcRoot = path.join(frontendRoot, 'src');
const backendRoot = path.join(repoRoot, 'backend');

const readSrc = (...segments) => fs.readFileSync(path.join(srcRoot, ...segments), 'utf8');
const readRepo = (...segments) => fs.readFileSync(path.join(repoRoot, ...segments), 'utf8');

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');

let passed = 0;
const test = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`PASS ${label}`);
};

// ─── Controlled browser + timer + API harness for real TS module execution ─────────────────────────────
const storageMap = new Map();
const windowListeners = new Map();
const registeredCleanups = [];
const apiCalls = [];
let mockServerGetImpl = async () => ({
  schemaVersion: 1,
  revision: 0,
  state: {
    schemaVersion: 1,
    activeSource: 'none',
    activeThemeId: null,
    activeConfig: null,
    favoritePresetIds: [],
    customThemes: [],
  },
  updatedAt: null,
});
let mockServerSaveImpl = async (state) => ({
  schemaVersion: 1,
  revision: 1,
  state,
  updatedAt: new Date().toISOString(),
});
let mockServerResetImpl = async () => undefined;

const mockLocalStorage = {
  get length() {
    return storageMap.size;
  },
  key(index) {
    return [...storageMap.keys()][index] ?? null;
  },
  getItem(key) {
    return storageMap.has(String(key)) ? storageMap.get(String(key)) : null;
  },
  setItem(key, value) {
    storageMap.set(String(key), String(value));
  },
  removeItem(key) {
    storageMap.delete(String(key));
  },
  clear() {
    storageMap.clear();
  },
};

const mockWindow = {
  innerWidth: 1440,
  innerHeight: 900,
  devicePixelRatio: 1,
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) {
    windowListeners.get(type)?.delete(fn);
  },
  dispatchEvent(event) {
    const fns = windowListeners.get(event?.type);
    if (!fns) return true;
    for (const fn of [...fns]) fn(event);
    return true;
  },
  matchMedia() {
    return {
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    };
  },
};

let fakeNow = 0;
let nextTimerId = 1;
const pendingTimers = new Map();

function fakeSetTimeout(fn, delay = 0) {
  const id = nextTimerId++;
  pendingTimers.set(id, { id, fn, runAt: fakeNow + Math.max(0, Number(delay) || 0) });
  return id;
}

function fakeClearTimeout(id) {
  pendingTimers.delete(id);
}

async function advanceTimersBy(ms) {
  const target = fakeNow + ms;
  while (true) {
    let next = null;
    for (const entry of pendingTimers.values()) {
      if (entry.runAt <= target && (!next || entry.runAt < next.runAt)) {
        next = entry;
      }
    }
    if (!next) break;
    pendingTimers.delete(next.id);
    fakeNow = next.runAt;
    next.fn();
    await Promise.resolve();
    await Promise.resolve();
  }
  fakeNow = target;
  await Promise.resolve();
  await Promise.resolve();
}

const backgroundThemeApiStub = {
  get: (options) => {
    apiCalls.push({ method: 'get', options });
    return mockServerGetImpl(options);
  },
  save: (state, options) => {
    apiCalls.push({ method: 'save', state: JSON.parse(JSON.stringify(state)), options });
    return mockServerSaveImpl(state, options);
  },
  reset: (options) => {
    apiCalls.push({ method: 'reset', options });
    return mockServerResetImpl(options);
  },
};

const moduleCache = new Map();

function resolveTsRelative(fromRel, request) {
  if (request.startsWith('@/')) {
    const base = request.slice(2);
    if (fs.existsSync(path.join(srcRoot, `${base}.ts`))) return `${base}.ts`;
    if (fs.existsSync(path.join(srcRoot, `${base}.tsx`))) return `${base}.tsx`;
    if (fs.existsSync(path.join(srcRoot, base, 'index.ts'))) return `${base}/index.ts`;
  }
  if (request.startsWith('./') || request.startsWith('../')) {
    const dir = path.posix.dirname(fromRel);
    const joined = path.posix.normalize(path.posix.join(dir, request));
    if (fs.existsSync(path.join(srcRoot, `${joined}.ts`))) return `${joined}.ts`;
    if (fs.existsSync(path.join(srcRoot, `${joined}.tsx`))) return `${joined}.tsx`;
    if (fs.existsSync(path.join(srcRoot, joined, 'index.ts'))) return `${joined}/index.ts`;
  }
  return null;
}

function loadTs(rel) {
  if (moduleCache.has(rel)) return moduleCache.get(rel);
  const source = readSrc(...rel.split('/'));
  const transformed = babel.core().transformSync(source, {
    filename: path.basename(rel),
    babelrc: false,
    configFile: false,
    presets: [babel.presetTypescript()],
    plugins: [babel.pluginTransformModulesCommonjs()],
  }).code;

  const mod = { exports: {} };
  moduleCache.set(rel, mod.exports);

  const localRequire = (request) => {
    if (request === '@/services/backgroundThemeApi') {
      return { backgroundThemeApi: backgroundThemeApiStub };
    }
    if (request === '@/lib/auth-cache-cleanup') {
      return {
        registerUserScopedCleanup(fn) {
          registeredCleanups.push(fn);
          return () => {
            const idx = registeredCleanups.indexOf(fn);
            if (idx >= 0) registeredCleanups.splice(idx, 1);
          };
        },
      };
    }
    const resolved = resolveTsRelative(rel, request);
    if (resolved) return loadTs(resolved);
    throw new Error(`Unexpected module import "${request}" from ${rel}`);
  };

  const fn = new Function(
    'module',
    'exports',
    'require',
    'window',
    'localStorage',
    'setTimeout',
    'clearTimeout',
    transformed,
  );
  fn(mod, mod.exports, localRequire, mockWindow, mockLocalStorage, fakeSetTimeout, fakeClearTimeout);
  moduleCache.set(rel, mod.exports);
  return mod.exports;
}

const bgTypes = loadTs('lib/background-studio/types.ts');
const colorScience = loadTs('lib/background-studio/colorScience.ts');
const presetsMod = loadTs('lib/background-studio/presets.ts');
const cssRenderer = loadTs('lib/background-studio/cssRenderer.ts');
const appearanceState = loadTs('lib/appearance/state.ts');
const appearanceScope = loadTs('lib/appearance/scope.ts');
const wallpaperStorage = loadTs('lib/wallpaper/storage.ts');
const spatialPref = loadTs('lib/spatial/preference.ts');
const bgStore = loadTs('lib/background-studio/store.ts');

// ─── Helper: parse every @keyframes block and extract CSS property names declared inside ──────────────
function extractKeyframeProperties(cssText) {
  const cleaned = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const results = [];
  const regex = /@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g;
  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    const name = match[1];
    let depth = 1;
    let i = match.index + match[0].length;
    const bodyStart = i;
    while (i < cleaned.length && depth > 0) {
      if (cleaned[i] === '{') depth += 1;
      else if (cleaned[i] === '}') depth -= 1;
      i += 1;
    }
    const body = cleaned.slice(bodyStart, i - 1);
    const props = [];
    const blockRegex = /[^{}]+\{([^{}]*)\}/g;
    let frameMatch;
    while ((frameMatch = blockRegex.exec(body)) !== null) {
      const decls = frameMatch[1].split(';');
      for (const decl of decls) {
        const trimmed = decl.trim();
        if (!trimmed) continue;
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx > 0) {
          props.push(trimmed.slice(0, colonIdx).trim().toLowerCase());
        }
      }
    }
    results.push({ name, props });
  }
  return results;
}

// =====================================================================================================
// SECTION 1: Color Science & OKLCH
// =====================================================================================================

await test('1.1 Color Science: exact HEX / RGB / HSL / OKLCH round-trips & Björn Ottosson reference vectors', () => {
  // Exact Björn Ottosson OKLab reference vectors
  const labWhite = colorScience.rgbToOklab({ r: 255, g: 255, b: 255 });
  assert.ok(Math.abs(labWhite.L - 1) < 1e-4 && Math.abs(labWhite.a) < 1e-4 && Math.abs(labWhite.b) < 1e-4);

  const labBlack = colorScience.rgbToOklab({ r: 0, g: 0, b: 0 });
  assert.equal(labBlack.L, 0);
  assert.equal(labBlack.a, 0);
  assert.equal(labBlack.b, 0);

  const labRed = colorScience.rgbToOklab({ r: 255, g: 0, b: 0 });
  assert.ok(Math.abs(labRed.L - 0.627955) < 1e-4, `red L=${labRed.L}`);
  assert.ok(Math.abs(labRed.a - 0.224863) < 1e-4, `red a=${labRed.a}`);
  assert.ok(Math.abs(labRed.b - 0.125846) < 1e-4, `red b=${labRed.b}`);

  const labGreen = colorScience.rgbToOklab({ r: 0, g: 255, b: 0 });
  assert.ok(Math.abs(labGreen.L - 0.86644) < 1e-4, `green L=${labGreen.L}`);
  assert.ok(Math.abs(labGreen.a - -0.233887) < 1e-4, `green a=${labGreen.a}`);
  assert.ok(Math.abs(labGreen.b - 0.179498) < 1e-4, `green b=${labGreen.b}`);

  const labBlue = colorScience.rgbToOklab({ r: 0, g: 0, b: 255 });
  assert.ok(Math.abs(labBlue.L - 0.452014) < 1e-4, `blue L=${labBlue.L}`);
  assert.ok(Math.abs(labBlue.a - -0.032457) < 1e-4, `blue a=${labBlue.a}`);
  assert.ok(Math.abs(labBlue.b - -0.311528) < 1e-4, `blue b=${labBlue.b}`);

  // 125-point RGB cube + Echo Ocean palette exact round-trips
  const samples = [];
  for (const r of [0, 64, 128, 192, 255]) {
    for (const g of [0, 64, 128, 192, 255]) {
      for (const b of [0, 64, 128, 192, 255]) {
        samples.push({ r, g, b });
      }
    }
  }
  for (const hex of ['#050a1c', '#0d1d42', '#2098b8', '#2795b5', '#b8d4ea', '#38bdf8', '#d89aa8', '#156555']) {
    samples.push(colorScience.hexToRgb(hex));
  }

  let maxHslErr = 0;
  let maxOklchErr = 0;
  for (const rgb of samples) {
    const hex = colorScience.rgbToHex(rgb);
    assert.deepEqual(colorScience.hexToRgb(hex), rgb, `HEX round-trip for ${hex}`);

    const hslRt = colorScience.hslToRgb(colorScience.rgbToHsl(rgb));
    maxHslErr = Math.max(
      maxHslErr,
      Math.abs(hslRt.r - rgb.r),
      Math.abs(hslRt.g - rgb.g),
      Math.abs(hslRt.b - rgb.b),
    );

    const oklchRt = colorScience.oklchToRgb(colorScience.rgbToOklch(rgb));
    maxOklchErr = Math.max(
      maxOklchErr,
      Math.abs(oklchRt.r - rgb.r),
      Math.abs(oklchRt.g - rgb.g),
      Math.abs(oklchRt.b - rgb.b),
    );
  }
  assert.equal(maxHslErr, 0, `HSL round-trip max error should be 0, got ${maxHslErr}`);
  assert.equal(maxOklchErr, 0, `OKLCH round-trip max error should be 0, got ${maxOklchErr}`);

  // Parser & formatter matrix across HEX, RGB, HSL, OKLCH (including CSS Color 4 syntax & units)
  assert.equal(colorScience.parseColorInput('#0f8')?.hex, '#00ff88');
  assert.equal(colorScience.parseColorInput('  2795B5 ')?.hex, '#2795b5');
  assert.equal(colorScience.parseColorInput('#2795b580')?.hex, '#2795b5');
  assert.ok(Math.abs((colorScience.parseColorInput('#2795b580')?.alpha ?? 0) - 128 / 255) < 0.01);
  assert.equal(colorScience.parseColorInput('rgb(39, 149, 181)')?.hex, '#2795b5');
  assert.equal(colorScience.parseColorInput('rgba(39 149 181 / 50%)')?.alpha, 0.5);
  assert.equal(colorScience.parseColorInput('hsl(194deg 65% 43% / 0.8)')?.alpha, 0.8);
  assert.equal(colorScience.parseColorInput('hsl(0.5turn 100% 50%)')?.hex, '#00ffff');

  const parsedOklch = colorScience.parseColorInput('oklch(62% 0.12 218deg / 0.75)');
  assert.ok(parsedOklch && /^#[0-9a-f]{6}$/.test(parsedOklch.hex));
  assert.equal(parsedOklch.alpha, 0.75);

  assert.equal(colorScience.formatHex('#ABC'), '#aabbcc');
  assert.equal(colorScience.formatCssColor('#2795b5', 0.5, false), 'rgb(39 149 181 / 0.5)');
  assert.match(colorScience.formatCssColor('#2795b5', 0.5, true), /^oklch\([\d.]+ [\d.]+ [\d.]+ \/ 0\.5\)$/);
});

await test('1.2 Color Science: out-of-gamut OKLCH clipping preserves exact L and H', () => {
  let tested = 0;
  let maxLDrift = 0;
  let maxHDrift = 0;

  for (const l of [0.15, 0.3, 0.5, 0.7, 0.88]) {
    for (let h = 0; h < 360; h += 15) {
      const clipped = colorScience.clipOklchToSrgbGamut({ l, c: 0.37, h });
      assert.equal(clipped.l, l, `L invariant violated at L=${l}, H=${h}`);
      assert.equal(clipped.h, h, `H invariant violated at L=${l}, H=${h}`);
      assert.ok(clipped.c >= 0 && clipped.c <= 0.37, `clipped chroma out of bounds: ${clipped.c}`);

      const lin = colorScience.oklabToLinearSrgb(colorScience.oklchToOklab(clipped));
      assert.ok(
        lin.r >= -1e-5 && lin.r <= 1 + 1e-5 &&
        lin.g >= -1e-5 && lin.g <= 1 + 1e-5 &&
        lin.b >= -1e-5 && lin.b <= 1 + 1e-5,
        `clipped linear sRGB out of gamut at L=${l}, H=${h}: ${JSON.stringify(lin)}`,
      );

      // Verify round-trip back through OKLab from clipped linear sRGB preserves L and H
      const rgb = colorScience.oklchToRgb(clipped);
      const back = colorScience.rgbToOklch(rgb);
      maxLDrift = Math.max(maxLDrift, Math.abs(back.l - l));
      if (clipped.c > 0.01) {
        const hueDelta = Math.abs(((back.h - h + 540) % 360) - 180);
        maxHDrift = Math.max(maxHDrift, hueDelta);
      }
      tested += 1;
    }
  }
  assert.equal(tested, 120);
  // 8-bit sRGB quantization introduces < 0.015 L and < 2.0 deg hue rounding at extreme dark/bright cusps
  assert.ok(maxLDrift < 0.015, `8-bit quantized L drift too high: ${maxLDrift}`);
  assert.ok(maxHDrift < 2.0, `8-bit quantized H drift too high: ${maxHDrift}`);
});

await test('1.3 Color Science: WCAG 2.1 luminance, contrast calculation & ambient accent extraction', () => {
  assert.equal(colorScience.relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  assert.equal(colorScience.relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
  assert.equal(colorScience.wcagContrastRatio(0, 1), 21);
  assert.equal(colorScience.wcagContrastRatio(1, 0), 21);
  assert.equal(colorScience.wcagContrastRatio(0.4, 0.4), 1);

  const deepCfg = colorScience.cloneThemeConfig(presetsMod.DEFAULT_STUDIO_CONFIG);
  deepCfg.color.stops = [
    { id: 'd1', color: '#050a18', position: 0, opacity: 1 },
    { id: 'd2', color: '#0c1836', position: 100, opacity: 1 },
  ];
  const deepReport = colorScience.estimateBackgroundLuminance(deepCfg);
  assert.equal(deepReport.readability, 'excellent');
  assert.equal(deepReport.recommendedSurface, 'dark');
  assert.ok(deepReport.contrastLightText >= 7);

  const brightCfg = colorScience.cloneThemeConfig(presetsMod.DEFAULT_STUDIO_CONFIG);
  brightCfg.color.stops = [
    { id: 'b1', color: '#f3f7fc', position: 0, opacity: 1 },
    { id: 'b2', color: '#e6eef8', position: 100, opacity: 1 },
  ];
  const brightReport = colorScience.estimateBackgroundLuminance(brightCfg);
  assert.equal(brightReport.readability, 'excellent');
  assert.equal(brightReport.recommendedSurface, 'light');
  assert.ok(brightReport.contrastDarkText >= 7);

  const midGrayCfg = colorScience.cloneThemeConfig(presetsMod.DEFAULT_STUDIO_CONFIG);
  midGrayCfg.color.stops = [
    { id: 'm1', color: '#777777', position: 0, opacity: 1 },
    { id: 'm2', color: '#7a7a7a', position: 100, opacity: 1 },
  ];
  midGrayCfg.color.glow = 0;
  midGrayCfg.color.blendIntensity = 0;
  const midReport = colorScience.estimateBackgroundLuminance(midGrayCfg);
  assert.equal(midReport.readability, 'caution', `mid-gray should warn caution, got ${JSON.stringify(midReport)}`);

  const ambient = colorScience.extractAmbientRgb(presetsMod.DEFAULT_STUDIO_CONFIG);
  assert.match(ambient, /^\d{1,3} \d{1,3} \d{1,3}$/);
  const parts = ambient.split(' ').map(Number);
  assert.ok(parts.every((n) => n >= 0 && n <= 255) && parts[0] + parts[1] + parts[2] > 120);
});

await test('1.4 Color Science: harmonious Randomize across 20 deterministic seeds (all valid & non-caution)', () => {
  const signatures = new Set();
  for (let seed = 1; seed <= 20; seed += 1) {
    const cfg = colorScience.generateHarmoniousTheme(seed);
    const sameSeedCfg = colorScience.generateHarmoniousTheme(seed);
    assert.deepEqual(cfg, sameSeedCfg, `seed ${seed} must be deterministic`);

    // Must round-trip through sanitizeThemeConfig with zero drift
    const sanitized = colorScience.sanitizeThemeConfig(cfg, presetsMod.DEFAULT_STUDIO_CONFIG);
    assert.deepEqual(sanitized, cfg, `seed ${seed} must satisfy strict schema bounds`);

    assert.ok(cfg.color.stops.length >= 3 && cfg.color.stops.length <= 6, `seed ${seed} stop count`);
    assert.equal(cfg.color.stops[0].position, 0);
    assert.equal(cfg.color.stops[cfg.color.stops.length - 1].position, 100);
    for (let i = 0; i < cfg.color.stops.length; i += 1) {
      assert.match(cfg.color.stops[i].color, bgTypes.HEX_COLOR_PATTERN);
      if (i > 0) {
        assert.ok(cfg.color.stops[i].position > cfg.color.stops[i - 1].position, `seed ${seed} monotonic stops`);
      }
    }

    const report = colorScience.estimateBackgroundLuminance(cfg);
    assert.notEqual(
      report.readability,
      'caution',
      `seed ${seed} must not generate caution readability: ${JSON.stringify(report)}`,
    );

    const ambient = colorScience.extractAmbientRgb(cfg);
    assert.match(ambient, /^\d{1,3} \d{1,3} \d{1,3}$/);
    signatures.add(cfg.color.stops.map((s) => s.color).join(','));
  }
  assert.ok(signatures.size >= 18, `20 seeds should produce diverse palettes (got ${signatures.size})`);
});

await test('1.5 Color Science: hostile input sanitization & fallback without mutation', () => {
  for (const hostile of [
    '',
    '   ',
    'javascript:alert(1)',
    'expression(alert(1))',
    'url(https://evil.example/x.png)',
    '#12345',
    '#zzzzzz',
    'rgb(1, 2)',
    'oklch(NaN 0.1 100)',
    null,
    undefined,
    12345,
  ]) {
    assert.equal(colorScience.parseColorInput(hostile), null, `hostile color rejected: ${String(hostile)}`);
  }

  const fallback = colorScience.cloneThemeConfig(presetsMod.DEFAULT_STUDIO_CONFIG);
  const fallbackBefore = JSON.stringify(fallback);

  const hostilePayload = {
    evilRootKey: 'drop table',
    color: {
      gradientType: 'webgl-3d-evil',
      stops: [
        { id: 'BAD ID!!', color: 'javascript:alert(1)', position: -999, opacity: 5, x: -50, y: 500, extra: 1 },
        { id: 'stop-1', color: '#ABCDEF', position: Number.NaN, opacity: Number.NEGATIVE_INFINITY, x: 50, y: 50 },
        { id: 'stop-1', color: '#123', position: 250, opacity: -2 },
        { id: 's4', color: '#112233', position: 40, opacity: 0.5 },
        { id: 's5', color: '#223344', position: 50, opacity: 0.5 },
        { id: 's6', color: '#334455', position: 60, opacity: 0.5 },
        { id: 's7', color: '#445566', position: 70, opacity: 0.5 },
        { id: 's8', color: '#556677', position: 80, opacity: 0.5 },
        { id: 's9-overflow', color: '#667788', position: 90, opacity: 0.5 },
      ],
      gradientAngle: 9999,
      centerX: -10,
      centerY: Number.POSITIVE_INFINITY,
      gradientSpread: 2,
      blendMode: 'xss-mode',
      blendIntensity: 500,
      baseLayerOpacity: -5,
      depthLayerOpacity: 200,
      brightness: 999,
      saturation: -100,
      contrast: 10,
      opacity: 0,
      blur: 999,
      glow: 999,
      colorIntensity: -50,
      injected: '<script>alert(1)</script>',
    },
    motion: {
      effects: ['static', 'aurora', 'evil-fx', 'aurora', 'color-flow', 'liquid-flow', 'pearl-shimmer', 'ambient-glow', 'light-drift', 'color-breathing'],
      animationSpeed: 99,
      motionIntensity: -10,
      lightIntensity: 999,
      movementDirection: 1000,
      movementScale: 5,
      glowRadius: 0,
      shimmerIntensity: 999,
      animationSmoothness: -5,
      performanceMode: 'overclocked',
      injectedMotion: true,
    },
    grainOpacity: 999,
  };

  const clean = colorScience.sanitizeThemeConfig(hostilePayload, fallback);
  assert.equal(JSON.stringify(fallback), fallbackBefore, 'fallback must never be mutated');
  assert.equal('evilRootKey' in clean, false);
  assert.equal('injected' in clean.color, false);
  assert.equal('injectedMotion' in clean.motion, false);
  assert.equal(clean.color.gradientType, fallback.color.gradientType);
  assert.equal(clean.color.blendMode, fallback.color.blendMode);
  assert.equal(clean.motion.performanceMode, fallback.motion.performanceMode);
  assert.equal(clean.color.stops.length, bgTypes.MAX_STOPS, 'overflow stops trimmed to MAX_STOPS=8');
  assert.equal(new Set(clean.color.stops.map((s) => s.id)).size, bgTypes.MAX_STOPS, 'stop IDs deduplicated');
  for (const s of clean.color.stops) {
    assert.match(s.id, bgTypes.THEME_ID_PATTERN);
    assert.match(s.color, bgTypes.HEX_COLOR_PATTERN);
    assert.ok(s.position >= 0 && s.position <= 100);
    assert.ok(s.opacity >= 0 && s.opacity <= 1);
  }
  assert.equal(clean.color.gradientAngle, 360);
  assert.equal(clean.color.centerX, 0);
  assert.equal(clean.color.gradientSpread, 10);
  assert.equal(clean.color.opacity, 15);
  assert.equal(clean.color.blur, 40);
  assert.equal(clean.motion.animationSpeed, 2.5);
  assert.equal(clean.motion.movementScale, 20);
  assert.equal(clean.motion.glowRadius, 10);
  assert.equal(clean.grainOpacity, 100);
  assert.equal(clean.motion.effects.includes('static'), false, 'static stripped when animated effects coexist');
  assert.equal(clean.motion.effects.length, bgTypes.MAX_EFFECTS, 'effects capped at MAX_EFFECTS=6');

  // Completely non-object / <2 stops fallback
  const fromNull = colorScience.sanitizeThemeConfig(null, fallback);
  assert.deepEqual(fromNull, fallback);
  const oneStop = colorScience.sanitizeThemeConfig({ color: { stops: [{ id: 'a', color: '#112233', position: 0, opacity: 1 }] } }, fallback);
  assert.ok(oneStop.color.stops.length >= bgTypes.MIN_STOPS);
});

// =====================================================================================================
// SECTION 2: 10 Handcrafted Presets
// =====================================================================================================

await test('2.1 Presets: all 10 required handcrafted presets exist with distinct palettes, types, angles & effects', () => {
  const REQUIRED_NAMES = [
    'Pearlescent Abyss',
    'Aurora Flow',
    'Oceanic Glow',
    'Liquid Mesh',
    'Nebula Atmosphere',
    'Midnight Sapphire',
    'Violet Dream',
    'Rose Quartz',
    'Emerald Depth',
    'Arctic Crystal',
  ];

  const presets = presetsMod.BACKGROUND_PRESETS;
  assert.equal(presets.length, 10, 'exactly 10 built-in presets');
  assert.equal(presetsMod.DEFAULT_BACKGROUND_PRESET_ID, 'pearlescent-abyss');

  const actualNames = presets.map((p) => p.name);
  for (const required of REQUIRED_NAMES) {
    assert.ok(actualNames.includes(required), `missing required preset: ${required}`);
  }

  assert.equal(new Set(presets.map((p) => p.id)).size, 10, 'unique preset IDs');
  assert.equal(new Set(presets.map((p) => p.name)).size, 10, 'unique English names');
  assert.equal(new Set(presets.map((p) => p.nameVi)).size, 10, 'unique Vietnamese names');
  assert.equal(new Set(presets.map((p) => p.taglineEn)).size, 10, 'unique English taglines');
  assert.equal(new Set(presets.map((p) => p.taglineVi)).size, 10, 'unique Vietnamese taglines');

  const palettes = new Set();
  const gradientTypes = new Set();
  const angles = new Set();
  const directions = new Set();
  const effectCombos = new Set();

  for (const p of presets) {
    assert.ok(presetsMod.isBackgroundPresetId(p.id));
    assert.equal(presetsMod.findBackgroundPreset(p.id)?.id, p.id);
    assert.match(p.id, bgTypes.THEME_ID_PATTERN);
    assert.match(p.accentHex, bgTypes.HEX_COLOR_PATTERN);
    const rgb = colorScience.hexToRgb(p.accentHex);
    assert.equal(p.accentRgb, `${rgb.r} ${rgb.g} ${rgb.b}`, `${p.id}: accentRgb matches accentHex`);
    assert.ok(bgTypes.isBackgroundPresetCategory(p.category), `${p.id}: valid category`);

    // Copy rules: zero &, <Sparkles>, ✨
    for (const copy of [p.name, p.nameVi, p.taglineEn, p.taglineVi]) {
      assert.equal(copy.includes('&'), false, `${p.id} copy contains forbidden &: ${copy}`);
      assert.equal(copy.includes('✨'), false, `${p.id} copy contains forbidden ✨`);
      assert.equal(/Sparkles/i.test(copy), false, `${p.id} copy mentions Sparkles`);
    }

    // Valid stops (2..8) & strict sanitizer round-trip
    const stops = p.config.color.stops;
    assert.ok(stops.length >= bgTypes.MIN_STOPS && stops.length <= bgTypes.MAX_STOPS, `${p.id}: valid stop count`);
    for (const stop of stops) {
      assert.match(stop.color, bgTypes.HEX_COLOR_PATTERN);
      assert.ok(stop.position >= 0 && stop.position <= 100);
      assert.ok(stop.opacity >= 0 && stop.opacity <= 1);
      assert.ok(typeof stop.x === 'number' && stop.x >= 0 && stop.x <= 100);
      assert.ok(typeof stop.y === 'number' && stop.y >= 0 && stop.y <= 100);
    }
    assert.deepEqual(colorScience.sanitizeThemeConfig(p.config, p.config), p.config, `${p.id}: zero-delta sanitize`);

    const lum = colorScience.estimateBackgroundLuminance(p.config);
    assert.notEqual(lum.readability, 'caution', `${p.id}: must not have caution readability`);

    palettes.add(stops.map((s) => s.color.toLowerCase()).sort().join('|'));
    gradientTypes.add(p.config.color.gradientType);
    angles.add(p.config.color.gradientAngle);
    directions.add(p.config.motion.movementDirection);
    effectCombos.add([...p.config.motion.effects].sort().join('+'));
  }

  assert.equal(palettes.size, 10, 'all 10 presets have distinct color palettes');
  assert.equal(gradientTypes.size, 4, 'presets cover all 4 gradient types (linear, radial, conic, mesh)');
  assert.equal(angles.size, 10, 'all 10 presets have distinct gradientAngle values');
  assert.equal(directions.size, 10, 'all 10 presets have distinct movementDirection values');
  assert.ok(effectCombos.size >= 8, `presets span diverse motion effect combinations (got ${effectCombos.size})`);
  assert.equal(presetsMod.findBackgroundPreset('nonexistent-preset'), undefined);
  assert.equal(presetsMod.isBackgroundPresetId('nonexistent-preset'), false);
});

// =====================================================================================================
// SECTION 3: CSS Renderer & Compositor Engine
// =====================================================================================================

await test('3.1 CSS Renderer: compiles all 4 gradient types (linear, radial, conic, mesh) cleanly', () => {
  const base = colorScience.cloneThemeConfig(presetsMod.DEFAULT_STUDIO_CONFIG);

  for (const type of ['linear', 'radial', 'conic', 'mesh']) {
    const cfg = colorScience.cloneThemeConfig(base);
    cfg.color.gradientType = type;
    const plan = cssRenderer.buildBackgroundStyleVars(cfg);
    const swatch = cssRenderer.previewSwatchCss(cfg);

    if (type === 'linear') {
      assert.ok(plan.baseGradient.startsWith('linear-gradient(var(--ec-bg-angle),'), 'linear base gradient');
      assert.ok(swatch.startsWith('linear-gradient('), 'linear swatch');
    } else if (type === 'radial') {
      assert.ok(plan.baseGradient.includes('radial-gradient(ellipse'), 'radial base gradient');
      assert.ok(swatch.startsWith('radial-gradient(ellipse'), 'radial swatch');
    } else if (type === 'conic') {
      assert.ok(plan.baseGradient.includes('conic-gradient(from var(--ec-bg-angle) at'), 'conic base gradient');
      assert.ok(plan.baseGradient.includes('100%'), 'conic seamless 100% wrap');
      assert.ok(swatch.includes('radial-gradient(circle'), 'conic swatch keeps anti-seam core diffuser');
      assert.ok(swatch.includes('conic-gradient(from'), 'conic swatch');
    } else if (type === 'mesh') {
      const radialCount = (plan.baseGradient.match(/radial-gradient\(/g) || []).length;
      assert.ok(radialCount >= cfg.color.stops.length, `mesh must emit >= ${cfg.color.stops.length} lobes`);
      assert.ok(plan.baseGradient.includes('linear-gradient(180deg,'), 'mesh canvas base image');
      assert.ok(swatch.includes('radial-gradient(ellipse'), 'mesh swatch');
    }

    // Zero bare `transparent` keyword fringes (same-RGB zero-alpha feathering)
    assert.equal(/\btransparent\b/.test(plan.baseGradient), false, `${type}: no dark transparent fringes`);
    assert.ok(plan.styleVars['--ec-bg-base'] === plan.baseGradient);
    assert.ok(plan.styleVars['--ec-bg-depth'] && plan.styleVars['--ec-bg-depth'] !== 'none');
    assert.match(plan.ambientRgb, /^\d{1,3} \d{1,3} \d{1,3}$/);
  }
});

await test('3.2 CSS Renderer: all 9 motion/light effects, multi-effect composition & eco/reducedMotion gating', () => {
  const EXPECTED_EFFECTS = [
    'static',
    'color-flow',
    'aurora',
    'liquid-flow',
    'pearl-shimmer',
    'ambient-glow',
    'light-drift',
    'color-breathing',
    'gradient-morph',
  ];
  assert.deepEqual([...bgTypes.BACKGROUND_EFFECT_IDS], EXPECTED_EFFECTS);

  // Static mode suppresses motion cleanly
  const staticCfg = colorScience.cloneThemeConfig(presetsMod.DEFAULT_STUDIO_CONFIG);
  staticCfg.motion.effects = ['static'];
  const staticPlan = cssRenderer.buildBackgroundStyleVars(staticCfg);
  assert.equal(staticPlan.isStatic, true);
  assert.deepEqual(staticPlan.activeEffects, []);
  assert.equal(staticPlan.styleVars['--ec-bg-motion'], '0');

  // Every animated effect compiles individually with non-empty gradients
  const layerSrc = readSrc('components', 'background-studio', 'BackgroundThemeLayer.tsx');
  for (const fx of EXPECTED_EFFECTS.filter((id) => id !== 'static')) {
    const cfg = colorScience.cloneThemeConfig(presetsMod.DEFAULT_STUDIO_CONFIG);
    cfg.motion.effects = [fx];
    const plan = cssRenderer.buildBackgroundStyleVars(cfg);
    assert.equal(plan.isStatic, false, `${fx} is animated`);
    assert.deepEqual(plan.activeEffects, [fx], `${fx} active`);
    assert.ok(Number(plan.styleVars['--ec-bg-motion']) > 0, `${fx} motion scalar > 0`);
    assert.ok(layerSrc.includes(`hasEffect('${fx}')`), `BackgroundThemeLayer mounts ${fx}`);
  }

  // Multi-effect composition & compatibility rules
  assert.equal(bgTypes.areEffectsCompatible('static', 'aurora'), false);
  assert.equal(bgTypes.areEffectsCompatible('aurora', 'pearl-shimmer'), true);
  assert.deepEqual(bgTypes.toggleEffectSelection(['aurora', 'light-drift'], 'static'), ['static']);
  assert.deepEqual(bgTypes.toggleEffectSelection(['static'], 'aurora'), ['aurora']);
  assert.deepEqual(bgTypes.toggleEffectSelection(['aurora'], 'aurora'), ['static']);

  const comboCfg = colorScience.cloneThemeConfig(presetsMod.DEFAULT_STUDIO_CONFIG);
  comboCfg.motion.effects = ['aurora', 'liquid-flow', 'pearl-shimmer', 'ambient-glow', 'gradient-morph'];
  comboCfg.color.blur = 14;
  comboCfg.grainOpacity = 24;
  const comboPlan = cssRenderer.buildBackgroundStyleVars(comboCfg);
  assert.equal(comboPlan.activeEffects.length, 5);
  assert.equal(comboPlan.hasGrain, true);
  assert.ok(comboPlan.cssFilterString.includes('blur(14px)'));
  assert.ok(comboPlan.styleVars['--ec-bg-grain'].startsWith('url("data:image/svg+xml,'));
  assert.equal(comboPlan.styleVars['--ec-bg-grain'].includes('&'), false);

  // Eco / lowPower gating: <= 1 animated effect (preferring ecoSafe), blur disabled, grain disabled, damped motion
  const ecoPlan = cssRenderer.buildBackgroundStyleVars(comboCfg, { lowPower: true });
  assert.equal(ecoPlan.isEco, true);
  assert.equal(ecoPlan.activeEffects.length, 1, 'eco caps animated layers to <= 1');
  assert.equal(bgTypes.EFFECT_COMPATIBILITY[ecoPlan.activeEffects[0]].ecoSafe, true, 'eco picks ecoSafe effect');
  assert.equal(ecoPlan.hasGrain, false);
  assert.equal(ecoPlan.styleVars['--ec-bg-grain'], 'none');
  assert.equal(ecoPlan.cssFilterString.includes('blur('), false, 'eco disables blur');
  assert.equal(ecoPlan.styleVars['--ec-bg-blur-overscan'], '0px');
  assert.ok(Number(ecoPlan.styleVars['--ec-bg-motion']) < Number(comboPlan.styleVars['--ec-bg-motion']));

  const ecoModeCfg = colorScience.cloneThemeConfig(comboCfg);
  ecoModeCfg.motion.performanceMode = 'eco';
  const ecoModePlan = cssRenderer.buildBackgroundStyleVars(ecoModeCfg);
  assert.equal(ecoModePlan.isEco, true);
  assert.equal(ecoModePlan.activeEffects.length, 1);

  // reducedMotion gating
  const rmPlan = cssRenderer.buildBackgroundStyleVars(comboCfg, { reducedMotion: true });
  assert.equal(rmPlan.isStatic, true);
  assert.deepEqual(rmPlan.activeEffects, []);
  assert.equal(rmPlan.styleVars['--ec-bg-motion'], '0');

  // activeOnly DOM pruning omits unmounted effect CSS vars while preserving active ones
  const singleFxCfg = colorScience.cloneThemeConfig(presetsMod.DEFAULT_STUDIO_CONFIG);
  singleFxCfg.motion.effects = ['pearl-shimmer'];
  const fullPlan = cssRenderer.buildBackgroundStyleVars(singleFxCfg);
  const prunedPlan = cssRenderer.buildBackgroundStyleVars(singleFxCfg, { activeOnly: true });
  assert.equal(prunedPlan.styleVars['--ec-bg-pearl'], fullPlan.styleVars['--ec-bg-pearl']);
  assert.equal(prunedPlan.styleVars['--ec-bg-base'], fullPlan.styleVars['--ec-bg-base']);
  assert.ok(Object.keys(prunedPlan.styleVars).length < Object.keys(fullPlan.styleVars).length, 'activeOnly prunes unmounted effect vars');
  assert.ok(layerSrc.includes('useSaveData') && layerSrc.includes('useDocumentVisible') && layerSrc.includes('activeOnly: true'), 'BackgroundThemeLayer wires Save-Data eco, hidden-tab pause, and activeOnly pruning');
});

await test('3.3 Compositor & Pure DOM/CSS/SVG Discipline: 0 canvas/WebGL/rAF, transform/opacity-only @keyframes, 0 !important, 0 backdrop-filter', () => {
  const bgComponentDir = path.join(srcRoot, 'components', 'background-studio');
  const bgLibDir = path.join(srcRoot, 'lib', 'background-studio');
  const componentFiles = fs.readdirSync(bgComponentDir).map((f) => path.join(bgComponentDir, f));
  const libFiles = fs.readdirSync(bgLibDir).map((f) => path.join(bgLibDir, f));

  for (const fullPath of [...componentFiles, ...libFiles]) {
    const content = fs.readFileSync(fullPath, 'utf8');
    const rel = path.relative(frontendRoot, fullPath);
    assert.equal(/<canvas\b/i.test(content), false, `${rel}: zero <canvas>`);
    assert.equal(/\b(getContext|WebGLRenderingContext|WebGL2RenderingContext|@react-three|from\s+['"]three['"])\b/.test(content), false, `${rel}: zero WebGL/Three`);
    assert.equal(/\brequestAnimationFrame\b/.test(content), false, `${rel}: zero requestAnimationFrame`);
    assert.equal(/!important/i.test(content), false, `${rel}: zero !important`);
    assert.equal(/backdrop-filter/i.test(content), false, `${rel}: zero backdrop-filter`);
  }

  // CSS compositor & containment checks
  const layerCss = readSrc('components', 'background-studio', 'BackgroundThemeLayer.module.css');
  const studioCss = readSrc('components', 'background-studio', 'BackgroundStudio.module.css');
  const propsCss = readSrc('components', 'background-studio', 'background-studio-properties.css');

  assert.ok(layerCss.includes('pointer-events: none;'), 'BackgroundThemeLayer has pointer-events: none');
  assert.ok(layerCss.includes('contain: strict;'), 'BackgroundThemeLayer has contain: strict');
  assert.ok(layerCss.includes('isolation: isolate;'), 'BackgroundThemeLayer has isolation: isolate');
  assert.ok(layerCss.includes("data-paused='true'") && layerCss.includes('animation-play-state: paused;'), 'pauses when data-paused=true');
  assert.ok(layerCss.includes('@media (prefers-reduced-motion: reduce)'), 'honors prefers-reduced-motion');
  assert.ok(layerCss.includes('@media (forced-colors: active)'), 'honors forced-colors');
  assert.equal(/font-family\s*:/i.test(layerCss + studioCss + propsCss), false, 'zero font-family overrides');

  // Verify EVERY @keyframes block in both CSS modules animates ONLY transform and opacity
  const layerFrames = extractKeyframeProperties(layerCss);
  const studioFrames = extractKeyframeProperties(studioCss);
  assert.ok(layerFrames.length >= 12, `expected >= 12 motion keyframes, found ${layerFrames.length}`);
  for (const frame of [...layerFrames, ...studioFrames]) {
    assert.ok(frame.props.length > 0, `@keyframes ${frame.name} must declare properties`);
    for (const prop of frame.props) {
      assert.ok(
        prop === 'transform' || prop === 'opacity',
        `@keyframes ${frame.name} animates non-compositor property "${prop}"`,
      );
    }
  }
});

// =====================================================================================================
// SECTION 4: Store, Persistence & Isolation
// =====================================================================================================

await test('4.1 Store: schemaVersion=1, per-account localStorage isolation (User A vs User B vs guest)', async () => {
  assert.equal(bgStore.EMPTY_BG_STATE.schemaVersion, 1);
  assert.equal(bgStore.bgStorageKey('101'), 'ec_bg_studio:v1:u101');
  assert.equal(bgStore.bgStorageKey('202'), 'ec_bg_studio:v1:u202');
  assert.equal(bgStore.bgStorageKey(''), 'ec_bg_studio:v1:guest');
  assert.equal(bgStore.bgStorageKey('a/b<c>'), 'ec_bg_studio:v1:uabc');

  // Apply preset for User A (101)
  apiCalls.length = 0;
  assert.equal(bgStore.applyPresetBackground('101', 'pearlescent-abyss'), true);
  assert.equal(bgStore.applyPresetBackground('101', 'unknown-preset-id'), false);

  const rawStoredA = mockLocalStorage.getItem('ec_bg_studio:v1:u101');
  assert.ok(rawStoredA, 'User A persisted to own storage key');
  const parsedA = JSON.parse(rawStoredA);
  assert.equal(parsedA.schemaVersion, 1);
  assert.equal(parsedA.activeSource, 'preset');
  assert.equal(parsedA.activeThemeId, 'pearlescent-abyss');

  // User B and guest see zero bleed from User A
  assert.equal(bgStore.currentBgState('202').activeSource, 'none');
  assert.equal(bgStore.resolveActiveBgConfig('202'), null);
  assert.equal(bgStore.currentBgState('').activeSource, 'none');
  assert.equal(bgStore.resolveActiveBgConfig(''), null);
  assert.equal(mockLocalStorage.getItem('ec_bg_studio:v1:u202'), null);
  assert.equal(mockLocalStorage.getItem('ec_bg_studio:v1:guest'), null);

  // Guest makes ZERO API calls on hydration and mutations
  await advanceTimersBy(500);
  const callsAfterA = apiCalls.length;
  await bgStore.hydrateBgPreferences('');
  bgStore.applyPresetBackground('', 'aurora-flow');
  await advanceTimersBy(500);
  assert.equal(apiCalls.length, callsAfterA, 'guest must trigger 0 backend API calls');
  bgStore.deactivateBackgroundStudio('');
});

await test('4.2 Store: mutual exclusion across default / wallpaper / world / spatial / background', () => {
  const acct = '303';
  appearanceState.restoreDefaultAppearance(acct);
  assert.equal(appearanceState.currentAppearance(acct).mode, 'default');

  // Save a custom theme first to verify it is preserved across mode switches
  const saved = bgStore.saveCustomTheme(acct, {
    name: 'Abyss Custom',
    config: presetsMod.DEFAULT_STUDIO_CONFIG,
    basedOnPresetId: 'pearlescent-abyss',
    activate: true,
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(appearanceState.currentAppearance(acct), {
    mode: 'background',
    selectionId: saved.theme.id,
  });

  // Switch to Spatial -> background deactivates cleanly while preserving customThemes
  appearanceState.applySpatialAppearance(acct, { ...spatialPref.DEFAULT_SPATIAL, presetId: 'echo-immersive-signature' });
  assert.equal(appearanceState.currentAppearance(acct).mode, 'spatial');
  assert.equal(bgStore.currentBgState(acct).activeSource, 'none');
  assert.equal(bgStore.currentBgState(acct).customThemes.length, 1, 'saved customThemes preserved');

  // Switch back to Background -> spatial disables cleanly
  bgStore.applyPresetBackground(acct, 'oceanic-glow');
  assert.deepEqual(appearanceState.currentAppearance(acct), { mode: 'background', selectionId: 'oceanic-glow' });
  assert.equal(spatialPref.storedSpatial(spatialPref.spatialKey(acct)).enabled, false);

  // Switch to Wallpaper -> background deactivates cleanly
  wallpaperStorage.writePreference(wallpaperStorage.accountKey(acct), {
    ...wallpaperStorage.DEFAULT_PREFERENCE,
    source: 'preset',
    presetId: 'coral-reef',
  });
  appearanceState.commitMediaAppearance(acct);
  assert.equal(appearanceState.currentAppearance(acct).mode, 'wallpaper');
  assert.equal(bgStore.currentBgState(acct).activeSource, 'none');

  // Switch to World -> still exclusive
  wallpaperStorage.writePreference(wallpaperStorage.accountKey(acct), {
    ...wallpaperStorage.DEFAULT_PREFERENCE,
    source: 'world',
    worldId: 'echo-abyss',
  });
  appearanceState.commitMediaAppearance(acct);
  assert.equal(appearanceState.currentAppearance(acct).mode, 'world');

  // Switch back to Background -> wallpaper/world goes dormant
  bgStore.applyPresetBackground(acct, 'rose-quartz');
  assert.equal(appearanceState.currentAppearance(acct).mode, 'background');
  assert.equal(wallpaperStorage.currentPreference(wallpaperStorage.accountKey(acct)).source, 'none');

  // Restore Default -> everything off
  appearanceState.restoreDefaultAppearance(acct);
  assert.equal(appearanceState.currentAppearance(acct).mode, 'default');
  assert.equal(bgStore.resolveActiveBgConfig(acct), null);
});

await test('4.3 Store: Live Workspace Preview override + Cancel exact restore (zero storage/API mutation)', async () => {
  const acct = '404';
  appearanceState.restoreDefaultAppearance(acct);
  bgStore.applyPresetBackground(acct, 'aurora-flow');
  await advanceTimersBy(500);

  const storageBefore = mockLocalStorage.getItem(bgStore.bgStorageKey(acct));
  const apiCountBefore = apiCalls.length;
  const resolvedBefore = bgStore.resolveActiveBgConfig(acct);
  assert.equal(resolvedBefore?.themeId, 'aurora-flow');
  assert.equal(resolvedBefore?.isPreview, false);

  // Enter minimized Live Workspace Preview with unsaved Rose Quartz draft
  const rose = presetsMod.findBackgroundPreset('rose-quartz');
  bgStore.setLiveWorkspacePreview({
    account: acct,
    config: rose.config,
    themeName: 'Unsaved Rose Draft',
    source: 'preset',
    themeId: 'rose-quartz',
    hasUnsavedChanges: true,
    minimizedToWorkspace: true,
  });

  const during = bgStore.resolveActiveBgConfig(acct);
  assert.equal(during?.isPreview, true);
  assert.equal(during?.themeId, 'rose-quartz');
  assert.deepEqual(appearanceState.currentAppearance(acct), {
    mode: 'background',
    selectionId: 'rose-quartz',
    preview: true,
  });
  // Must NOT touch localStorage or trigger any API save
  assert.equal(mockLocalStorage.getItem(bgStore.bgStorageKey(acct)), storageBefore);
  await advanceTimersBy(500);
  assert.equal(apiCalls.length, apiCountBefore, 'Live Workspace Preview triggers 0 API calls');

  // Cancel preview -> exact pre-edit state restored
  bgStore.setLiveWorkspacePreview(null);
  const afterCancel = bgStore.resolveActiveBgConfig(acct);
  assert.equal(afterCancel?.themeId, 'aurora-flow');
  assert.equal(afterCancel?.isPreview, false);
  assert.deepEqual(appearanceState.currentAppearance(acct), {
    mode: 'background',
    selectionId: 'aurora-flow',
  });
  assert.equal(mockLocalStorage.getItem(bgStore.bgStorageKey(acct)), storageBefore);

  // Study Space per-space appearance scope yields cleanly when active
  const endScope = appearanceScope.beginAppearanceScope(
    'study-room-test',
    { [wallpaperStorage.accountKey(acct)]: wallpaperStorage.DEFAULT_PREFERENCE },
    () => {},
  );
  assert.equal(bgStore.resolveActiveBgConfig(acct), null, 'yields to Study Space scoped override');
  endScope();
  assert.equal(bgStore.resolveActiveBgConfig(acct)?.themeId, 'aurora-flow');
});

await test('4.4 Store: My Themes CRUD (save, rename, duplicate, favorite, delete, 40-theme cap)', () => {
  const acct = '505';
  appearanceState.restoreDefaultAppearance(acct);

  // Reject hostile / invalid names
  assert.equal(bgStore.saveCustomTheme(acct, { name: '   ', config: presetsMod.DEFAULT_STUDIO_CONFIG }).ok, false);
  assert.equal(bgStore.saveCustomTheme(acct, { name: '<script>x</script>', config: presetsMod.DEFAULT_STUDIO_CONFIG }).ok, false);
  assert.equal(bgStore.saveCustomTheme(acct, { name: 'a'.repeat(61), config: presetsMod.DEFAULT_STUDIO_CONFIG }).ok, false);

  // Save
  const created = bgStore.saveCustomTheme(acct, {
    name: 'Midnight Study',
    config: presetsMod.DEFAULT_STUDIO_CONFIG,
    basedOnPresetId: 'pearlescent-abyss',
    activate: true,
  });
  assert.equal(created.ok, true);
  assert.match(created.theme.id, bgTypes.THEME_ID_PATTERN);
  assert.equal(bgStore.currentBgState(acct).customThemes.length, 1);

  // Rename
  const renamed = bgStore.renameCustomTheme(acct, created.theme.id, 'Midnight Study V2');
  assert.equal(renamed.ok, true);
  assert.equal(renamed.theme.name, 'Midnight Study V2');
  assert.equal(bgStore.renameCustomTheme(acct, 'missing-id', 'Test').error, 'NOT_FOUND');

  // Favorite custom theme & preset
  assert.equal(bgStore.toggleFavoriteCustomTheme(acct, created.theme.id), true);
  assert.equal(bgStore.currentBgState(acct).customThemes[0].favorite, true);
  assert.equal(bgStore.toggleFavoriteCustomTheme(acct, created.theme.id), false);
  assert.equal(bgStore.toggleFavoritePreset(acct, 'aurora-flow'), true);
  assert.deepEqual(bgStore.currentBgState(acct).favoritePresetIds, ['aurora-flow']);
  assert.equal(bgStore.toggleFavoritePreset(acct, 'aurora-flow'), false);
  assert.equal(bgStore.toggleFavoritePreset(acct, 'fake-preset'), false);

  // Duplicate (deep clone, favorite reset to false)
  const dup = bgStore.duplicateCustomTheme(acct, created.theme.id);
  assert.equal(dup.ok, true);
  assert.notEqual(dup.theme.id, created.theme.id);
  assert.equal(dup.theme.name, 'Midnight Study V2 (Copy)');
  assert.equal(dup.theme.favorite, false);
  assert.equal(bgStore.currentBgState(acct).customThemes.length, 2);

  // Delete active theme -> deactivates cleanly
  assert.equal(bgStore.deleteCustomTheme(acct, created.theme.id), true);
  assert.equal(bgStore.currentBgState(acct).activeSource, 'none');
  assert.equal(bgStore.currentBgState(acct).customThemes.length, 1);
  assert.equal(bgStore.deleteCustomTheme(acct, 'missing-id'), false);

  // Enforce 40-theme cap
  while (bgStore.currentBgState(acct).customThemes.length < bgTypes.MAX_CUSTOM_THEMES) {
    const n = bgStore.currentBgState(acct).customThemes.length + 1;
    const res = bgStore.saveCustomTheme(acct, {
      name: `Theme ${n}`,
      config: presetsMod.DEFAULT_STUDIO_CONFIG,
    });
    assert.equal(res.ok, true, `theme #${n} should save`);
  }
  assert.equal(bgStore.currentBgState(acct).customThemes.length, 40);

  const overCap = bgStore.saveCustomTheme(acct, {
    name: 'Theme 41',
    config: presetsMod.DEFAULT_STUDIO_CONFIG,
  });
  assert.equal(overCap.ok, false);
  assert.equal(overCap.error, 'THEME_LIMIT');

  const dupOverCap = bgStore.duplicateCustomTheme(acct, dup.theme.id);
  assert.equal(dupOverCap.ok, false);
  assert.equal(dupOverCap.error, 'THEME_LIMIT');

  // Updating an existing theme at cap still succeeds
  const updateAtCap = bgStore.saveCustomTheme(acct, {
    id: dup.theme.id,
    name: 'Updated At Cap',
    config: presetsMod.DEFAULT_STUDIO_CONFIG,
  });
  assert.equal(updateAtCap.ok, true);
  assert.equal(bgStore.currentBgState(acct).customThemes.length, 40);
});

await test('4.5 Store: debounced sync coalescing + registerUserScopedCleanup logout wipe', async () => {
  await advanceTimersBy(1000);
  const acct = '606';
  apiCalls.length = 0;

  // Burst of 10 consecutive commits -> ZERO immediate API calls, coalesced into ONE PUT after 350 ms
  for (let i = 0; i < 10; i += 1) {
    const preset = presetsMod.BACKGROUND_PRESETS[i % presetsMod.BACKGROUND_PRESETS.length];
    bgStore.applyPresetBackground(acct, preset.id);
  }
  const immediateSaves = apiCalls.filter((c) => c.method === 'save');
  assert.equal(immediateSaves.length, 0, 'no synchronous API call during burst');
  assert.equal(bgStore.getBgSyncStatus().state, 'saving');

  await advanceTimersBy(349);
  assert.equal(apiCalls.filter((c) => c.method === 'save').length, 0, 'still debouncing before 350ms');

  await advanceTimersBy(2);
  const flushedSaves = apiCalls.filter((c) => c.method === 'save');
  assert.equal(flushedSaves.length, 1, '10 rapid mutations coalesce into exactly 1 debounced PUT');
  assert.equal(flushedSaves[0].state.activeThemeId, presetsMod.BACKGROUND_PRESETS[9].id);
  assert.equal(bgStore.getBgSyncStatus().state, 'saved');

  // Logout cleanup via registerUserScopedCleanup wipes memory, live preview, occlusion, and cancels pending timer
  assert.ok(registeredCleanups.length >= 1, 'store.ts registered with registerUserScopedCleanup');
  const authCleanupSrc = readSrc('lib', 'auth-cache-cleanup.ts');
  assert.ok(authCleanupSrc.includes('for (const cleanup of userScopedCleanups) safely(cleanup);'));
  assert.ok(authCleanupSrc.includes('localStorage.clear()'));
  assert.equal(authCleanupSrc.includes('ec_bg_studio'), false, 'auth-cache-cleanup must never whitelist ec_bg_studio keys');

  apiCalls.length = 0;
  bgStore.applyPresetBackground(acct, 'emerald-depth'); // queues a 350ms timer
  bgStore.setLiveWorkspacePreview({
    account: acct,
    config: presetsMod.DEFAULT_STUDIO_CONFIG,
    themeName: 'Temp',
    source: 'preset',
    themeId: 'pearlescent-abyss',
    hasUnsavedChanges: true,
    minimizedToWorkspace: true,
  });
  bgStore.setStudyStageOccluded(true);

  // Simulate logout
  for (const fn of registeredCleanups) fn();
  mockLocalStorage.clear();
  await advanceTimersBy(1000);

  assert.equal(apiCalls.filter((c) => c.method === 'save').length, 0, 'pending debounced PUT cancelled on logout');
  assert.equal(bgStore.getLiveWorkspacePreview(), null, 'live preview wiped on logout');
  assert.equal(bgStore.isStudyStageOccluded(), false, 'occlusion wiped on logout');
  assert.equal(bgStore.getBgSyncStatus().state, 'idle', 'sync status reset on logout');
  assert.equal(bgStore.currentBgState(acct).activeSource, 'none', 'in-memory state wiped on logout');

  // Late hydration response after logout must be discarded
  let resolveSlowGet;
  mockServerGetImpl = () =>
    new Promise((resolve) => {
      resolveSlowGet = resolve;
    });
  const hydrationPromise = bgStore.hydrateBgPreferences('707');
  for (const fn of registeredCleanups) fn();
  resolveSlowGet({
    schemaVersion: 1,
    revision: 5,
    state: {
      schemaVersion: 1,
      activeSource: 'preset',
      activeThemeId: 'arctic-crystal',
      activeConfig: null,
      favoritePresetIds: ['arctic-crystal'],
      customThemes: [],
    },
    updatedAt: new Date().toISOString(),
  });
  await hydrationPromise;
  assert.equal(bgStore.currentBgState('707').activeSource, 'none', 'late hydration after logout discarded');
});

// =====================================================================================================
// SECTION 5: UI Coverage & Copy Integrity
// =====================================================================================================

await test('5.1 UI Coverage: StudioBar tab, lazy-loaded BackgroundStudio, 4 panels, all 10 Color + 8 Motion sliders & core actions', () => {
  const studioBarSrc = readSrc('components', 'wallpaper', 'StudioBar.tsx');
  assert.ok(studioBarSrc.includes("'background'"), 'StudioBar supports background room');
  assert.ok(studioBarSrc.includes("['background', 'Background']"), 'StudioBar exposes Background tab');
  assert.ok(studioBarSrc.includes('studio-room-${id}'), 'StudioBar emits studio-room-background testid');

  const wallpaperStudioSrc = readSrc('components', 'wallpaper', 'WallpaperStudio.tsx');
  assert.ok(
    /const\s+BackgroundStudio\s*=\s*dynamic\(\s*\(\)\s*=>\s*import\(['"]@\/components\/background-studio\/BackgroundStudio['"]\)/.test(
      wallpaperStudioSrc,
    ),
    'WallpaperStudio lazy-loads BackgroundStudio via next/dynamic',
  );
  assert.ok(wallpaperStudioSrc.includes("if (room === 'background')"), 'WallpaperStudio mounts BackgroundStudio on background room');

  const wallpaperStageSrc = readSrc('components', 'wallpaper', 'WallpaperStage.tsx');
  assert.ok(wallpaperStageSrc.includes('<BackgroundThemeLayer'), 'WallpaperStage mounts BackgroundThemeLayer');
  assert.ok(wallpaperStageSrc.includes('isStudyStageOccluded'), 'WallpaperStage honors Study Space occlusion');
  assert.ok(wallpaperStageSrc.includes("'--wp-accent'") && wallpaperStageSrc.includes("'--wp-thumb'"), 'WallpaperStage syncs ambient accent and sidebar swatch');

  // P0-1 regression guard: WallpaperStudioHost useSyncExternalStore server snapshots must be cached (never inline object literals)
  const wallpaperHostSrc = readSrc('components', 'wallpaper', 'WallpaperStudioHost.tsx');
  assert.equal(/useSyncExternalStore\([\s\S]*?=>\s*\(\s*\{/.test(wallpaperHostSrc), false, 'WallpaperStudioHost must cache useSyncExternalStore server snapshots');

  // Verify all 4 studio panels exist and are mounted in BackgroundStudio.tsx
  const bgStudioSrc = readSrc('components', 'background-studio', 'BackgroundStudio.tsx');
  for (const panelFile of [
    'PresetGalleryPanel.tsx',
    'ColorStudioPanel.tsx',
    'MotionLightPanel.tsx',
    'MyThemesPanel.tsx',
  ]) {
    assert.ok(
      fs.existsSync(path.join(srcRoot, 'components', 'background-studio', panelFile)),
      `panel exists: ${panelFile}`,
    );
  }
  assert.ok(bgStudioSrc.includes('<PresetGalleryPanel'), 'BackgroundStudio mounts PresetGalleryPanel');
  assert.ok(bgStudioSrc.includes('<ColorStudioPanel'), 'BackgroundStudio mounts ColorStudioPanel');
  assert.ok(bgStudioSrc.includes('<MotionLightPanel'), 'BackgroundStudio mounts MotionLightPanel');
  assert.ok(bgStudioSrc.includes('<MyThemesPanel'), 'BackgroundStudio mounts MyThemesPanel');

  // Verify slider drags stay in local draftConfig (no API call per slider tick)
  assert.ok(bgStudioSrc.includes('const handleChangeColor') && bgStudioSrc.includes('setDraftConfig'));
  assert.ok(bgStudioSrc.includes('const handleChangeMotion') && bgStudioSrc.includes('setDraftConfig'));

  // All 10 Color sliders wired in ColorStudioPanel.tsx
  const colorPanelSrc = readSrc('components', 'background-studio', 'ColorStudioPanel.tsx');
  const REQUIRED_COLOR_SLIDERS = [
    ['slider-brightness', 'brightness'],
    ['slider-saturation', 'saturation'],
    ['slider-contrast', 'contrast'],
    ['slider-opacity', 'opacity'],
    ['slider-blur', 'blur'],
    ['slider-glow', 'glow'],
    ['slider-color-intensity', 'colorIntensity'],
    ['slider-gradient-spread', 'gradientSpread'],
    ['slider-gradient-angle', 'gradientAngle'],
    ['slider-blend-intensity', 'blendIntensity'],
  ];
  for (const [testId, field] of REQUIRED_COLOR_SLIDERS) {
    assert.ok(colorPanelSrc.includes(`testId="${testId}"`), `ColorStudioPanel missing slider ${testId}`);
    assert.ok(colorPanelSrc.includes(`updateColorField('${field}'`), `ColorStudioPanel slider ${testId} not wired to ${field}`);
  }
  assert.ok(colorPanelSrc.includes('gradient-stop-bar'), 'Multi-stop gradient bar present');
  assert.ok(colorPanelSrc.includes('gradient-focal-pad'), '2D focal pad present');
  assert.ok(colorPanelSrc.includes('color-hex-input') && colorPanelSrc.includes('color-oklch-l'), 'HEX/RGB/HSL/OKLCH inputs present');

  // All 8 Motion & Light sliders wired in MotionLightPanel.tsx
  const motionPanelSrc = readSrc('components', 'background-studio', 'MotionLightPanel.tsx');
  const REQUIRED_MOTION_SLIDERS = [
    ['slider-animation-speed', 'animationSpeed'],
    ['slider-motion-intensity', 'motionIntensity'],
    ['slider-light-intensity', 'lightIntensity'],
    ['slider-movement-direction', 'movementDirection'],
    ['slider-movement-scale', 'movementScale'],
    ['slider-glow-radius', 'glowRadius'],
    ['slider-shimmer-intensity', 'shimmerIntensity'],
    ['slider-animation-smoothness', 'animationSmoothness'],
  ];
  for (const [testId, field] of REQUIRED_MOTION_SLIDERS) {
    assert.ok(motionPanelSrc.includes(`testId="${testId}"`), `MotionLightPanel missing slider ${testId}`);
    assert.ok(motionPanelSrc.includes(`updateMotion('${field}'`), `MotionLightPanel slider ${testId} not wired to ${field}`);
  }
  assert.ok(motionPanelSrc.includes('BACKGROUND_EFFECT_IDS.map'), 'MotionLightPanel renders all 9 effects');
  assert.ok(motionPanelSrc.includes('PERFORMANCE_MODES.map'), 'MotionLightPanel renders Auto/High/Eco');

  // Core studio controls: Apply / Save / Cancel / Reset / Randomize / Live Workspace Preview
  const previewSrc = readSrc('components', 'background-studio', 'BackgroundLivePreview.tsx');
  const liveBarSrc = readSrc('components', 'background-studio', 'BackgroundLivePreviewBar.tsx');
  const myThemesSrc = readSrc('components', 'background-studio', 'MyThemesPanel.tsx');

  assert.ok(bgStudioSrc.includes('role="dialog"') && bgStudioSrc.includes('aria-modal="true"'), 'BackgroundStudio accessible modal dialog');
  assert.ok(bgStudioSrc.includes('data-testid="bg-studio-apply-btn"'), 'Apply button present');
  assert.ok(bgStudioSrc.includes('data-testid="bg-studio-save-btn"'), 'Save button present');
  assert.ok(bgStudioSrc.includes('data-testid="bg-studio-cancel-btn"'), 'Cancel button present');
  assert.ok(bgStudioSrc.includes('data-testid="bg-studio-reset-btn"'), 'Reset button present');
  assert.ok(myThemesSrc.includes('data-testid="my-themes-randomize-btn"'), 'Randomize button present');
  assert.ok(previewSrc.includes('data-testid="preview-enter-live-workspace"'), 'Live Workspace Preview button present');
  assert.ok(previewSrc.includes('data-testid="preview-reduced-motion-badge"'), 'Live Preview reduced-motion status badge present');
  assert.ok(liveBarSrc.includes('data-testid="background-live-preview-bar"') && liveBarSrc.includes('role="region"'), 'Live Workspace Preview dock present');
  assert.ok(
    liveBarSrc.includes('live-bar-apply') && liveBarSrc.includes('live-bar-cancel') && liveBarSrc.includes('live-bar-return'),
    'Live Workspace Preview dock exposes Apply, Cancel & Return to Studio',
  );
  const studioCss = readSrc('components', 'background-studio', 'BackgroundStudio.module.css');
  assert.match(studioCss, /\.liveDock\s*\{[^}]*z-index:\s*115;/, 'Live Preview Dock z-index is 115 (above shell, below Studio 120)');
  assert.ok(
    studioCss.includes('.filterChipActive:hover') &&
      studioCss.includes('.segmentBtnActive:hover') &&
      studioCss.includes('.pillOptionActive:hover'),
    'Active pill hover rules preserve high-contrast dark ink (P0-3 guard)',
  );
  assert.match(studioCss, /\.focalCoords\s*\{[^}]*z-index:\s*5;/, '2D focal pad coordinates stay above mesh stop dots (P1-4 guard)');
});

await test('5.2 UI Hygiene: zero &, zero <Sparkles>/✨/Wand, zero window.confirm/window.alert across all Background Studio UI files', () => {
  const bgComponentDir = path.join(srcRoot, 'components', 'background-studio');
  const tsxFiles = fs.readdirSync(bgComponentDir).filter((f) => f.endsWith('.tsx'));
  assert.ok(tsxFiles.length >= 7);

  for (const file of tsxFiles) {
    const content = fs.readFileSync(path.join(bgComponentDir, file), 'utf8');
    assert.equal(/\bSparkles\b/.test(content), false, `${file}: forbidden Sparkles icon`);
    assert.equal(content.includes('✨'), false, `${file}: forbidden ✨ emoji`);
    assert.equal(/\bWand2?\b/.test(content), false, `${file}: forbidden Wand icon`);
    assert.equal(/\bwindow\.(confirm|alert|prompt)\b/.test(content), false, `${file}: forbidden browser dialog`);
    assert.equal(/(^|[^\w.])(confirm|alert)\s*\(/.test(content), false, `${file}: forbidden global confirm/alert`);

    // Check all single/double/template strings and JSX text nodes for forbidden "&"
    const copyRegex = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|(?<![=>-])>[^<>{}\n]*(?=[<{])/g;
    for (const match of content.matchAll(copyRegex)) {
      const literal = match[0];
      if ((literal.includes('&') && !literal.includes('&&')) || /&amp;/i.test(literal)) {
        assert.fail(`${file}: forbidden "&" in UI display copy: ${literal}`);
      }
    }
  }
});

// =====================================================================================================
// SECTION 6: Backend Contract
// =====================================================================================================

await test('6.1 Backend Migration: V139__user_background_preferences.sql additive, ON DELETE RESTRICT, JSONB object + size CHECK', () => {
  const migrationRel = path.join('backend', 'src', 'main', 'resources', 'db', 'migration', 'exams', 'V139__user_background_preferences.sql');
  const sql = readRepo(migrationRel);

  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.user_background_preferences/i, 'additive CREATE TABLE IF NOT EXISTS');
  assert.equal(/\b(DROP\s+TABLE|ALTER\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i.test(sql), false, 'strictly additive migration');
  assert.match(sql, /REFERENCES\s+public\.users\s*\(\s*id\s*\)\s+ON\s+DELETE\s+RESTRICT/i, 'ON DELETE RESTRICT FK');
  assert.equal(/ON\s+DELETE\s+CASCADE/i.test(sql), false, 'never ON DELETE CASCADE');
  assert.match(sql, /jsonb_typeof\s*\(\s*state\s*\)\s*=\s*'object'/i, 'JSONB object CHECK');
  assert.match(sql, /octet_length\s*\(\s*state::text\s*\)\s*<=\s*262144/i, 'JSONB 256 KB size CHECK');
});

await test('6.2 Backend Java & Frontend API Contract: principal-only /api/v1/users/me/background-preferences, no-store, clean wallpaper package', () => {
  const bgJavaDir = path.join(backendRoot, 'src', 'main', 'java', 'com', 'englishcoach', 'background');
  const wpJavaDir = path.join(backendRoot, 'src', 'main', 'java', 'com', 'englishcoach', 'wallpaper');

  const controller = fs.readFileSync(path.join(bgJavaDir, 'BackgroundPreferenceController.java'), 'utf8');
  const dtos = fs.readFileSync(path.join(bgJavaDir, 'BackgroundPreferenceDtos.java'), 'utf8');
  const validator = fs.readFileSync(path.join(bgJavaDir, 'BackgroundPreferenceValidator.java'), 'utf8');
  const service = fs.readFileSync(path.join(bgJavaDir, 'BackgroundPreferenceService.java'), 'utf8');
  const repository = fs.readFileSync(path.join(bgJavaDir, 'BackgroundPreferenceRepository.java'), 'utf8');

  // Strip comments so Javadoc/JSDoc security notes mentioning "no userId" do not false-positive
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const controllerCode = stripComments(controller);
  const dtosCode = stripComments(dtos);

  // Principal-only route, zero userId query/path param, Cache-Control: no-store
  assert.ok(controllerCode.includes('@RequestMapping("/api/v1/users/me/background-preferences")'));
  assert.ok(controllerCode.includes('@GetMapping') && controllerCode.includes('@PutMapping') && controllerCode.includes('@DeleteMapping'));
  assert.equal((controllerCode.match(/@AuthenticationPrincipal\s+UserDetailsImpl\s+principal/g) || []).length, 3);
  assert.equal(/@(PathVariable|RequestParam)/.test(controllerCode), false, 'controller accepts zero userId path/query params');
  assert.equal(/\buserId\b|\buser_id\b/.test(controllerCode), false, 'controller code never exposes userId parameter');
  assert.equal(/\buserId\b|\buser_id\b/.test(dtosCode), false, 'DTOs carry zero userId field');
  assert.ok(controllerCode.includes('CacheControl.noStore()'), 'responses enforce Cache-Control: no-store');

  // Validator matches frontend bounds & allowlists
  assert.ok(validator.includes('MAX_CUSTOM_THEMES = 40'));
  assert.ok(validator.includes('MIN_STOPS = 2') && validator.includes('MAX_STOPS = 8'));
  assert.ok(validator.includes('MIN_EFFECTS = 1') && validator.includes('MAX_EFFECTS = 6'));
  assert.ok(validator.includes('JsonNodeFactory.instance.objectNode()'), 're-serializes strictly into fresh ObjectNode');
  for (const fx of bgTypes.BACKGROUND_EFFECT_IDS) {
    assert.ok(validator.includes(`"${fx}"`), `Backend validator allows effect "${fx}"`);
  }
  for (const gt of bgTypes.GRADIENT_TYPES) {
    assert.ok(validator.includes(`"${gt}"`), `Backend validator allows gradientType "${gt}"`);
  }
  for (const bm of bgTypes.BACKGROUND_BLEND_MODES) {
    assert.ok(validator.includes(`"${bm}"`), `Backend validator allows blendMode "${bm}"`);
  }

  // Zero AI / external network calls in backend background package and frontend API client
  const combinedBe = stripComments(controller + dtos + validator + service + repository);
  assert.equal(/openrouter|openai|\/ai\/|RestTemplate|WebClient|HttpClient/i.test(combinedBe), false, 'zero AI/external calls in backend');

  const feApi = readSrc('services', 'backgroundThemeApi.ts');
  const feApiCode = stripComments(feApi);
  assert.ok(feApiCode.includes("'/users/me/background-preferences'"), 'FE API targets /users/me/background-preferences');
  assert.equal(/\buserId\b|\buser_id\b|openrouter|\/ai\//i.test(feApiCode), false, 'FE API carries no userId param and no AI calls');

  // Package isolation: zero Background* files or background-preference references in com.englishcoach.wallpaper
  const wallpaperJavaFiles = fs.readdirSync(wpJavaDir);
  for (const file of wallpaperJavaFiles) {
    assert.equal(/background/i.test(file), false, `com.englishcoach.wallpaper must contain zero Background* files (found ${file})`);
    const body = fs.readFileSync(path.join(wpJavaDir, file), 'utf8');
    assert.equal(body.includes('user_background_preferences') || body.includes('com.englishcoach.background'), false, `${file} must not couple to background studio`);
  }
});

console.log(`\nALL ${passed} ECHO BACKGROUND STUDIO CONTRACT CHECKS PASSED.`);
