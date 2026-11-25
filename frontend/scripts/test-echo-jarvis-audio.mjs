// Echo JARVIS Reforge Contract A/B, DSP, PBFDAF AEC, Zero-WASM Neural, Dedicated Worker,
// Single-Greeting Epoch, Barge-In, Arbiter, Transport, and Latency Verification Suite.
// Run with: `node frontend/scripts/test-echo-jarvis-audio.mjs`

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(SCRIPT_DIR, '..');
const SRC_DIR = resolve(FRONTEND_DIR, 'src');
const PUBLIC_DIR = resolve(FRONTEND_DIR, 'public');

// Virtual stubs for transitive browser-only app-shell dependencies pulled in by `echoJarvisRuntime.ts` / `actionDispatcher.ts`
// so ALL Echo JARVIS audio, runtime, neural DSP, arbiter, and voiceSessionStore modules run real in native V8!
const VIRTUAL_STUBS = {
  'virtual:auth-cache-cleanup': `
    const cleanups = new Set();
    export function registerUserScopedCleanup(fn) { cleanups.add(fn); return () => cleanups.delete(fn); }
    export function clearUserScopedCaches() { for (const fn of cleanups) { try { fn(); } catch {} } }
  `,
  'virtual:echo-intelligence-api': `
    export const echoIntelligenceApi = {
      decide: async () => ({ status: 'APPLIED', plan: {} }),
    };
  `,
  'virtual:noop-module': `
    export const DEFAULT_BACKGROUND_PRESET_ID = 'pearlescent-abyss';
    export const BG_BOUNDS = { brightness: { min: 0.5, max: 1.5 } };
    export function findBackgroundPreset() { return null; }
    export function cloneThemeConfig(x) { return x; }
    export function applyCustomBackground() {}
    export function applyPresetBackground() {}
    export function resolveActiveBgConfig() { return { brightness: 1 }; }
    export function restoreDefaultAppearance() {}
    export function openGuidePanel() {}
    export function navStorageKey() { return 'ec_nav'; }
    export function setNavigationLayout() {}
    export function setNavigationVisibility() {}
    export function isRootModuleHref() { return true; }
    export function setWorldDisplay() {}
    export function openWallpaperStudio() {}
    export async function logout() {}
    export class BookStore { async listBooks() { return []; } close() {} }
  `,
};

const STUB_TARGETS = new Map([
  ['@/lib/auth-cache-cleanup', 'virtual:auth-cache-cleanup'],
  ['@/services/echoIntelligenceApi', 'virtual:echo-intelligence-api'],
  ['@/lib/appearance/state', 'virtual:noop-module'],
  ['@/lib/background-studio/colorScience', 'virtual:noop-module'],
  ['@/lib/background-studio/presets', 'virtual:noop-module'],
  ['@/lib/background-studio/store', 'virtual:noop-module'],
  ['@/lib/background-studio/types', 'virtual:noop-module'],
  ['@/lib/guide/store', 'virtual:noop-module'],
  ['@/lib/navigation/preferences', 'virtual:noop-module'],
  ['@/lib/navigation/routes', 'virtual:noop-module'],
  ['@/lib/ui/worldDisplay', 'virtual:noop-module'],
  ['@/lib/wallpaper/storage', 'virtual:noop-module'],
  ['@/services/logout', 'virtual:noop-module'],
  ['@/components/features/reading/books/store/bookStore', 'virtual:noop-module'],
]);

// Register `@/*` TypeScript ESM resolver in the native V8 isolate so Float32Array benchmarks run at full JIT speed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUB_TARGETS.has(specifier)) {
      return { url: STUB_TARGETS.get(specifier), shortCircuit: true };
    }
    const tryPaths = (base) => {
      for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.mjs`,
        `${base}.js`,
        resolve(base, 'index.ts'),
        resolve(base, 'index.js'),
      ]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      return null;
    };

    if (specifier.startsWith('@/')) {
      const hit = tryPaths(resolve(SRC_DIR, specifier.slice(2)));
      if (hit) return hit;
    } else if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      context.parentURL?.startsWith('file:')
    ) {
      const parentDir = dirname(fileURLToPath(context.parentURL));
      const hit = tryPaths(resolve(parentDir, specifier));
      if (hit) return hit;
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url in VIRTUAL_STUBS) {
      return { format: 'module', source: VIRTUAL_STUBS[url], shortCircuit: true };
    }
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      return {
        format: 'module-typescript',
        source: readFileSync(fileURLToPath(url), 'utf8'),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const audioMod = await import('../src/lib/echo-jarvis/audio/index.ts');
const runtimeMod = await import('../src/lib/echo-jarvis/runtime/echoJarvisRuntime.ts');
const authLifecycle = await import('../src/lib/auth-lifecycle.ts');

const {
  OWW_SILENCE_MEL_FLOOR,
  OWW_POST_RESET_WARMUP_STEPS,
  ZeroWasmSileroVadV5,
  ZeroWasmLogMel32,
  ZeroWasmOpenWakeWord,
  ZeroWasmNlmsAec,
  ZeroWasmPbfdafAec,
  createInitializedSileroWeights,
  createInitializedOwwWeights,
  dequantizeTensorSlice,
  parseSileroVadBinary,
  parseOpenWakeWordBinary,
  WakeWordDetector,
  CircularPcmRingBuffer,
  BargeInClassifier,
  BACKCHANNEL_SET,
  HARD_CANCEL_SET,
  AudioSessionArbiter,
  EchoStreamingPlayback,
  decodeWavToFloat32,
  EchoVoiceClient,
  ECHO_WS_MSG_MIC_PCM16,
  ECHO_WS_MSG_TTS_PCM16,
  encodeBinaryAudioFrame,
  decodeBinaryAudioFrame,
  EvenBytePcmStreamAssembler,
  FirstClauseChunker,
  EchoTelemetryTracker,
  isRepetitiveAsrHallucination,
  sanitizePassivePageContext,
  EchoEarconSynth,
} = audioMod;

const {
  EchoJarvisRuntime,
  stripWakePhrasePrefix,
} = runtimeMod;

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS [${passed}] ${name}`);
}

const OWNED_FILES = [
  resolve(PUBLIC_DIR, 'echo-mic-worklet.js'),
  resolve(PUBLIC_DIR, 'echo-jarvis/echo-voice-dsp.worker.js'),
  resolve(SRC_DIR, 'lib/echo-jarvis/audio/audioSessionArbiter.ts'),
  resolve(SRC_DIR, 'lib/echo-jarvis/audio/earcons.ts'),
  resolve(SRC_DIR, 'lib/echo-jarvis/audio/zeroWasmNeural.ts'),
  resolve(SRC_DIR, 'lib/echo-jarvis/audio/wakeWordDetector.ts'),
  resolve(SRC_DIR, 'lib/echo-jarvis/audio/bargeInClassifier.ts'),
  resolve(SRC_DIR, 'lib/echo-jarvis/audio/echoStreamingPlayback.ts'),
  resolve(SRC_DIR, 'lib/echo-jarvis/audio/echoVoiceClient.ts'),
  resolve(SRC_DIR, 'lib/echo-jarvis/audio/echoTelemetry.ts'),
  resolve(SRC_DIR, 'lib/echo-jarvis/audio/index.ts'),
  resolve(SRC_DIR, 'lib/echo-jarvis/runtime/echoJarvisRuntime.ts'),
  resolve(SRC_DIR, 'lib/echo-jarvis/runtime/index.ts'),
];

await check('1. Static CSP, Security, No-Ampersand, Zero-WASM, Canonical Analyser, and Deleted Acoustic Fallback contracts', () => {
  const wasmIdentifier = 'Web' + 'Assembly';
  const ortIdentifier = 'onnxruntime' + '-web';
  const evalPattern = /[^.\w]eval\(|\bnew Function\(|dangerouslySetInnerHTML|\.(?:inner|outer)HTML\s*=/;
  const blobWorkletPattern = /addModule\(\s*URL\.createObjectURL|blob:/;
  const wordAmp = /[^\W\d_)] (?:&|&amp;) [^\W\d_(]/u;
  const literal = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

  for (const file of OWNED_FILES) {
    assert.equal(existsSync(file), true, `Missing required file: ${file}`);
    const src = readFileSync(file, 'utf8');
    assert.equal(src.includes(wasmIdentifier), false, `${file} must contain zero ${wasmIdentifier} references`);
    assert.equal(src.includes(ortIdentifier), false, `${file} must contain zero ${ortIdentifier} references`);
    assert.doesNotMatch(src, evalPattern, `${file} must contain zero dynamic eval or HTML sinks`);
    assert.doesNotMatch(src, blobWorkletPattern, `${file} must never use blob: AudioWorklet URLs`);

    for (const line of src.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import ')) continue;
      for (const m of line.matchAll(literal)) {
        assert.equal(wordAmp.test(m[0]), false, `${file}: string literal contains banned " & ": ${m[0]}`);
      }
    }
  }

  const arbiterSrc = readFileSync(resolve(SRC_DIR, 'lib/echo-jarvis/audio/audioSessionArbiter.ts'), 'utf8');
  assert.doesNotMatch(
    arbiterSrc,
    /localStorage|sessionStorage|indexedDB|document\.cookie|URLSearchParams/,
    'audioSessionArbiter must stay 100% in-memory without touching storage, cookies, or URLSearchParams',
  );

  // Verify AcousticWakeFallbackDetector is permanently deleted
  const wakeSrc = readFileSync(resolve(SRC_DIR, 'lib/echo-jarvis/audio/wakeWordDetector.ts'), 'utf8');
  assert.equal(wakeSrc.includes('class AcousticWakeFallbackDetector'), false, 'AcousticWakeFallbackDetector must be deleted');
  assert.equal(wakeSrc.includes('immediateHighConfidence'), false, '1-frame immediateHighConfidence bypass must be removed');

  // Verify canonical ec:echo-analyser `{ channel, analyser }` payload in both mic and tts emitters
  const playbackSrc = readFileSync(resolve(SRC_DIR, 'lib/echo-jarvis/audio/echoStreamingPlayback.ts'), 'utf8');
  const audioIdxSrc = readFileSync(resolve(SRC_DIR, 'lib/echo-jarvis/audio/index.ts'), 'utf8');
  assert.ok(playbackSrc.includes("channel: 'tts', analyser"), 'echoStreamingPlayback emits canonical { channel: tts, analyser }');
  assert.ok(audioIdxSrc.includes("channel: 'mic', analyser"), 'audio/index emits canonical { channel: mic, analyser }');
});

await check('2. AudioWorklet (/echo-mic-worklet.js): legacy-int16, jarvis-f32, 48/44.1 kHz resampling, and worker port piping', () => {
  const workletSrc = readFileSync(resolve(PUBLIC_DIR, 'echo-mic-worklet.js'), 'utf8');

  const instantiateWorklet = (inSampleRate, processorOptions = {}) => {
    let RegisteredCtor = null;
    const posted = [];
    class BaseAudioWorkletProcessor {
      constructor() {
        this.port = {
          onmessage: null,
          postMessage: (data, transfer) => {
            const snap =
              data && typeof data === 'object' && data.type === 'jarvis-frame'
                ? {
                    ...data,
                    mic: new Float32Array(data.mic),
                    ref: data.ref ? new Float32Array(data.ref) : null,
                  }
                : data;
            posted.push({ data: snap, rawRef: data?.mic, transfer });
          },
        };
      }
    }
    runInNewContext(workletSrc, {
      AudioWorkletProcessor: BaseAudioWorkletProcessor,
      sampleRate: inSampleRate,
      registerProcessor: (name, ctor) => {
        assert.equal(name, 'echo-microphone');
        RegisteredCtor = ctor;
      },
      Float32Array,
      Int16Array,
      Math,
    });
    assert.ok(RegisteredCtor, 'Processor registered');
    const proc = new RegisteredCtor({ processorOptions });
    return { proc, posted };
  };

  // 2a. Legacy mode: 16 kHz -> exact 1600-sample Int16Array frames
  const legacy = instantiateWorklet(16000);
  for (let q = 0; q < 25; q++) {
    const buf = new Float32Array(128).fill(0.5);
    assert.equal(legacy.proc.process([[buf]]), true);
  }
  assert.equal(legacy.posted.length, 2, '3200 samples -> exact 2 legacy 1600-sample frames');
  assert.ok(legacy.posted[0].data instanceof Int16Array && legacy.posted[0].data.length === 1600);
  assert.ok(Math.abs(legacy.posted[0].data[0] - 16384) <= 1);

  // 2b. Jarvis mode @ 48 kHz -> 16 kHz anti-aliased decimation + input[1] ref + zero-GC buffer reuse
  const jarvis48 = instantiateWorklet(48000, { mode: 'jarvis-f32' });
  let sampleIdx = 0;
  for (let q = 0; q < 24; q++) {
    const micQ = new Float32Array(128);
    const refQ = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      const t = sampleIdx / 48000;
      micQ[i] = 0.6 * Math.sin(2 * Math.PI * 1000 * t);
      refQ[i] = 0.4 * Math.cos(2 * Math.PI * 500 * t);
      sampleIdx += 1;
    }
    jarvis48.proc.process([[micQ], [refQ]]);
  }
  assert.equal(jarvis48.posted.length, 2, '24 quanta @ 48kHz produces exact 2 x 512 frames @ 16kHz');
  assert.equal(jarvis48.posted[0].data.hasRef, true);
  assert.equal(jarvis48.posted[0].rawRef, jarvis48.posted[1].rawRef, 'reuses exact pre-allocated Float32Array (zero GC!)');

  // 2c. Direct MessagePort worker piping (`attach-worker-port`)
  const workerFrames = [];
  const fakeWorkerPort = { postMessage: (msg) => workerFrames.push(msg.seq) };
  jarvis48.proc.port.onmessage({ data: { type: 'attach-worker-port', port: fakeWorkerPort } });
  for (let q = 0; q < 12; q++) {
    jarvis48.proc.process([[new Float32Array(128).fill(0.2)]]);
  }
  assert.equal(workerFrames.length, 1, 'Direct worker port receives 512-sample frame without waking main thread');
  assert.equal(jarvis48.posted.length, 2, 'Main thread port stayed quiet while worker port was attached');

  // 2d. 44,100 Hz -> 16,000 Hz 1-second clock accuracy
  const jarvis441 = instantiateWorklet(44100, { mode: 'jarvis-f32' });
  let fed = 0;
  while (fed < 44100) {
    const n = Math.min(128, 44100 - fed);
    jarvis441.proc.process([[new Float32Array(n).fill(0.25)]]);
    fed += n;
  }
  assert.equal(jarvis441.posted.length, Math.floor(16000 / 512));
});

await check('3. ZeroWasmSileroVadV5: INT8 dequantization, numerical validity, and < 1.0 ms P50 frame latency', () => {
  const rawInt8 = new Int8Array([100, -50, 25, -100, 40, -20]);
  const deq = dequantizeTensorSlice(rawInt8.buffer, {
    offset: 0,
    shape: [2, 3],
    dtype: 'int8',
    scales: [0.01, 0.02],
  });
  assert.ok(Math.abs(deq[0] - 1.0) < 1e-6);
  assert.ok(Math.abs(deq[1] - -0.5) < 1e-6);
  assert.ok(Math.abs(deq[3] - -2.0) < 1e-6);

  const vad = new ZeroWasmSileroVadV5(createInitializedSileroWeights(42));
  const frame = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    frame[i] = 0.35 * Math.sin((2 * Math.PI * 220 * i) / 16000) + 0.15 * Math.sin((2 * Math.PI * 660 * i) / 16000);
  }
  for (let i = 0; i < 120; i++) {
    const p = vad.processFrame512(frame);
    assert.ok(p >= 0 && p <= 1 && Number.isFinite(p));
  }
  const times = new Float64Array(400);
  for (let i = 0; i < 400; i++) {
    const t0 = performance.now();
    vad.processFrame512(frame);
    times[i] = performance.now() - t0;
  }
  times.sort();
  const p50 = times[200];
  console.log(`   -> Silero VAD v5 P50 = ${p50.toFixed(3)} ms / 32ms frame`);
  assert.ok(p50 < 1.0, `Silero VAD v5 P50 (${p50.toFixed(3)} ms) must be sub-millisecond`);
});

await check('4. ZeroWasmOpenWakeWord: Calibrated -10.0 silence-floor reset, 6-step warmup lockout, bit-exact parity, and 0 false wakes on real INT8 weights', () => {
  assert.equal(OWW_SILENCE_MEL_FLOOR, -10.0);
  assert.ok(OWW_POST_RESET_WARMUP_STEPS >= 6);

  const weights = createInitializedOwwWeights(2026, 16);
  const oww = new ZeroWasmOpenWakeWord(weights);
  const logMel = new ZeroWasmLogMel32(weights.melW);

  // Full-window history starts at OWW_SILENCE_MEL_FLOOR (-10.0) matching oww.reset()!
  const fullWindow76 = new Float32Array(76 * 32).fill(OWW_SILENCE_MEL_FLOOR);
  const pcm1280 = new Float32Array(1280);
  const mel8x32 = new Float32Array(256);

  let worstMaxDiff = 0;
  for (let step = 0; step < 8; step++) {
    for (let i = 0; i < 1280; i++) {
      const idx = step * 1280 + i;
      pcm1280[i] =
        0.4 * Math.sin((2 * Math.PI * (180 + step * 45) * idx) / 16000) +
        0.15 * Math.cos((2 * Math.PI * 1450 * idx) / 16000);
    }
    logMel.processChunk1280(pcm1280, mel8x32);
    fullWindow76.copyWithin(0, 8 * 32);
    fullWindow76.set(mel8x32, 68 * 32);

    const refEmb = oww.forwardFullWindow76x32(fullWindow76, false);
    const { embedding96, probs } = oww.stepCausal8x32(mel8x32);

    if (step + 1 < OWW_POST_RESET_WARMUP_STEPS) {
      assert.equal(oww.isWarmedUp, false, `Step ${step + 1} still inside post-reset lockout`);
      assert.equal(probs[0], 1, 'Lockout forces P(negative) = 1.0');
    } else {
      assert.equal(oww.isWarmedUp, true, `Step ${step + 1} warmed up`);
    }

    let stepDiff = 0;
    for (let d = 0; d < 96; d++) {
      const diff = Math.abs(refEmb[d] - embedding96[d]);
      if (diff > stepDiff) stepDiff = diff;
    }
    if (stepDiff > worstMaxDiff) worstMaxDiff = stepDiff;

    let probSum = 0;
    for (let k = 0; k < 5; k++) probSum += probs[k];
    assert.ok(Math.abs(probSum - 1.0) < 1e-5, `5-class softmax sums to 1.0 (got ${probSum})`);
  }
  console.log(`   -> Causal Ring-Buffer vs Full-Window 76x32 maxAbsDiff = ${worstMaxDiff.toExponential(3)}`);
  assert.ok(worstMaxDiff < 1e-5, `Causal parity broken: ${worstMaxDiff}`);

  // Verify LIVE exported INT8 binaries: 0 false wakes across pure silence and ambient white noise!
  const manifestPath = resolve(PUBLIC_DIR, 'echo-jarvis/models/manifest.json');
  const wakeManifestPath = resolve(PUBLIC_DIR, 'echo-jarvis/wake/manifest.json');
  assert.equal(existsSync(manifestPath), true, 'models/manifest.json must exist');

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const sileroSec = manifest.sileroVad ?? manifest.models?.sileroVad;
  const owwSec = manifest.openWakeWord ?? manifest.models?.openWakeWord;
  const sBin = readFileSync(resolve(PUBLIC_DIR, 'echo-jarvis/models', sileroSec.file));
  const oBin = readFileSync(resolve(PUBLIC_DIR, 'echo-jarvis/models', owwSec.file));
  const parsedSilero = parseSileroVadBinary(sBin, sileroSec);
  const parsedOww = parseOpenWakeWordBinary(oBin, owwSec);

  const liveVad = new ZeroWasmSileroVadV5(parsedSilero);
  const liveMel = new ZeroWasmLogMel32(parsedOww.melW, parsedOww.stftWindow);
  const liveOww = new ZeroWasmOpenWakeWord(parsedOww);

  // 4a. Pure silence (20 steps = 1.6 s) -> maxP(wake) < 0.05!
  let maxSilenceWake = 0;
  for (let s = 0; s < 20; s++) {
    liveMel.processChunk1280(new Float32Array(1280), mel8x32);
    const { probs } = liveOww.stepCausal8x32(mel8x32);
    const pWake = Math.max(probs[1], probs[2], probs[3], probs[4]);
    if (pWake > maxSilenceWake) maxSilenceWake = pWake;
  }
  assert.ok(maxSilenceWake < 0.05, `Live INT8 OWW silence maxP(wake) must be < 0.05 (got ${maxSilenceWake.toFixed(4)})`);

  // 4b. Ambient 0.02 white noise (20 steps = 1.6 s after reset) -> maxP(wake) < 0.05!
  liveOww.reset();
  liveMel.reset();
  let maxNoiseWake = 0;
  let rng = 1234567;
  for (let s = 0; s < 20; s++) {
    const noise = new Float32Array(1280);
    for (let i = 0; i < 1280; i++) {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      noise[i] = ((rng / 4294967296) * 2 - 1) * 0.02;
    }
    liveMel.processChunk1280(noise, mel8x32);
    const { probs } = liveOww.stepCausal8x32(mel8x32);
    const pWake = Math.max(probs[1], probs[2], probs[3], probs[4]);
    if (pWake > maxNoiseWake) maxNoiseWake = pWake;
  }
  assert.ok(maxNoiseWake < 0.05, `Live INT8 OWW white-noise maxP(wake) must be < 0.05 (got ${maxNoiseWake.toFixed(4)})`);

  // 4c. Live Silero VAD v5 silence vs real speech + 0 self-wakes across all 16 wake WAVs during tts-speaking!
  let silenceProb = 0;
  for (let i = 0; i < 8; i++) silenceProb = liveVad.processFrame512(new Float32Array(512));
  assert.ok(silenceProb < 0.12, `Live INT8 Silero VAD silence < 0.12 (got ${silenceProb.toFixed(4)})`);

  if (existsSync(wakeManifestPath)) {
    const wakeManifest = JSON.parse(readFileSync(wakeManifestPath, 'utf8'));
    assert.equal(wakeManifest.entries.length, 16);

    const wavFiles = readdirSync(resolve(PUBLIC_DIR, 'echo-jarvis/wake')).filter((f) => f.endsWith('.wav'));
    let selfWakesDuringTts = 0;
    const selfDetector = new WakeWordDetector(
      { onWakeDetected: () => { selfWakesDuringTts += 1; } },
      { sileroWeights: parsedSilero, owwWeights: parsedOww, neuralWeightsLoaded: true },
    );
    selfDetector.setTtsPlaying(true);
    selfDetector.setMode('tts-speaking');
    let clock = 5000;
    for (const f of wavFiles) {
      const dec = decodeWavToFloat32(readFileSync(resolve(PUBLIC_DIR, 'echo-jarvis/wake', f)));
      const s16 = audioMod.resampleTo16kHzMono(dec.samples, dec.sampleRate);
      for (let off = 0; off + 512 <= s16.length; off += 512) {
        selfDetector.processFrame512(s16.subarray(off, off + 512), s16.subarray(off, off + 512), clock);
        clock += 32;
      }
    }
    assert.equal(selfWakesDuringTts, 0, 'Echo MUST NEVER self-wake on any of its 16 own wake greeting WAVs!');
    console.log(
      `   -> Live INT8 OWW calibrated silence=${maxSilenceWake.toFixed(4)}, whiteNoise=${maxNoiseWake.toFixed(4)}, 16-WAV selfWakes=${selfWakesDuringTts}`,
    );
  }
});

await check('5. 8-Partition 128 ms PBFDAF AEC + GCC-PHAT + Benesty NCC: >15 dB ERLE across 10 ms, 95 ms, and 180 ms delays + double-talk preservation', () => {
  const aec0 = new ZeroWasmPbfdafAec();
  assert.equal(aec0.processFrame512(new Float32Array(512), null, false).active, false, '0 ms bypass when TTS silent');

  const runDelayScenario = (delaySamples, seedLatencyMs) => {
    const aec = new ZeroWasmNlmsAec();
    if (seedLatencyMs > 0) aec.setOutputLatencyMs(seedLatencyMs);
    const totalSamples = 512 * 44;
    const refAll = new Float32Array(totalSamples);
    let rng = 987654321;
    for (let i = 0; i < totalSamples; i++) {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      refAll[i] = 0.32 * Math.sin((2 * Math.PI * 310 * i) / 16000) + 0.28 * ((rng / 4294967296) * 2 - 1);
    }
    const echoAll = new Float32Array(totalSamples);
    for (let i = delaySamples + 4; i < totalSamples; i++) {
      echoAll[i] = 0.55 * refAll[i - delaySamples] + 0.22 * refAll[i - delaySamples - 1] - 0.1 * refAll[i - delaySamples - 3];
    }

    let rawP = 0;
    let resP = 0;
    let supp = 0;
    for (let f = 0; f < 44; f++) {
      const off = f * 512;
      const r = aec.processFrame512(echoAll.subarray(off, off + 512), refAll.subarray(off, off + 512), true, 32);
      if (f >= 28) {
        for (let i = 0; i < 512; i++) {
          rawP += echoAll[off + i] * echoAll[off + i];
          resP += r.cleanedMic[i] * r.cleanedMic[i];
        }
        if (r.echoSuppressed) supp += 1;
      }
    }
    const erleDb = 10 * Math.log10(rawP / (resP + 1e-9));

    // Verify Benesty NCC Double-Talk Detector preserves simultaneous near-end human speech!
    let dtDetected = 0;
    for (let f = 0; f < 5; f++) {
      const m = new Float32Array(512);
      const rf = refAll.subarray((30 + f) * 512, (31 + f) * 512);
      for (let i = 0; i < 512; i++) {
        const idx = (30 + f) * 512 + i;
        const echo = 0.55 * refAll[idx - delaySamples] + 0.22 * refAll[idx - delaySamples - 1] - 0.1 * refAll[idx - delaySamples - 3];
        const human = 0.35 * Math.sin((2 * Math.PI * 195 * idx) / 16000) + 0.2 * Math.sin((2 * Math.PI * 585 * idx) / 16000);
        m[i] = echo + human;
      }
      const r = aec.processFrame512(m, rf, true, 32);
      if (r.doubleTalkDetected && !r.echoSuppressed) dtDetected += 1;
    }

    return { erleDb, supp, dtDetected };
  };

  const s10 = runDelayScenario(160, 0);
  const s95 = runDelayScenario(1520, 0);
  const s180 = runDelayScenario(2880, 0);
  console.log(
    `   -> PBFDAF ERLE: 10ms=${s10.erleDb.toFixed(1)}dB, 95ms=${s95.erleDb.toFixed(1)}dB, 180ms(GCC-PHAT)=${s180.erleDb.toFixed(1)}dB`,
  );
  assert.ok(s10.erleDb > 15.0 && s10.supp >= 14 && s10.dtDetected >= 4, '10 ms echo cancellation & double-talk');
  assert.ok(s95.erleDb > 15.0 && s95.supp >= 14 && s95.dtDetected >= 4, '95 ms room-tail echo cancellation & double-talk');
  assert.ok(s180.erleDb > 15.0 && s180.supp >= 14 && s180.dtDetected >= 4, '180 ms GCC-PHAT auto-lock echo cancellation');
});

await check('6. Hardened WakeWordDetector: 2-frame neural patience, 300ms pre-lead Single-Breath, wake prefix strip, noise gate, bounded follow-up, and barge-in probe', () => {
  // 6a. Wake-phrase prefix stripping
  assert.equal(stripWakePhrasePrefix('Hey Echo, open Reading'), 'open Reading');
  assert.equal(stripWakePhrasePrefix('Hi, Echo Jarvis - increase the font size'), 'increase the font size');
  assert.equal(stripWakePhrasePrefix('Hi Echo mở bài đọc'), 'mở bài đọc');
  assert.equal(stripWakePhrasePrefix('Hey Echo!'), '');

  // 6b. CircularPcmRingBuffer wrap-around
  const ring = new CircularPcmRingBuffer(24000);
  for (let i = 0; i < 60; i++) ring.write(new Float32Array(512).fill(i));
  assert.equal(ring.size, 24000);
  assert.equal(ring.readLatest(512)[0], 59);

  const wakes = [];
  const singleBreaths = [];
  const discarded = [];
  const probes = [];
  let followups = 0;

  const detector = new WakeWordDetector(
    {
      onWakeDetected: (ev) => wakes.push(ev),
      onSingleBreathCommand: (ev) => singleBreaths.push(ev),
      onUtteranceDiscarded: (ev) => discarded.push(ev),
      onBargeInProbeReady: (ev) => probes.push(ev),
      onFollowupTimeout: () => { followups += 1; },
    },
    {
      neuralWeightsLoaded: true,
      wakeThresholdDormant: 0.58,
      wakePatienceFrames: 2,
      singleBreathWindowMs: 280,
      singleBreathPreLeadSamples: 4800,
    },
  );

  let clock = 1000;
  // Warm up 6+ steps (16 frames = 512 ms) in silent Dormant -> 0 wakes, 0 network bytes!
  for (let f = 0; f < 16; f++) {
    detector.processFrame512(new Float32Array(512).fill(0.0005), null, clock, 0.02);
    clock += 32;
  }
  assert.equal(detector.isOwwWarmedUp, true);
  assert.equal(wakes.length, 0);
  assert.equal(detector.uploadedNetworkBytes, 0);

  // Isolated 1-frame high spike (0.99) MUST BE REJECTED (no immediateHighConfidence bypass!)
  const wakeProbs = new Float32Array([0.01, 0.0, 0.99, 0.0, 0.0]);
  const negProbs = new Float32Array([0.99, 0.01, 0.0, 0.0, 0.0]);
  for (let f = 0; f < 3; f++) {
    detector.processFrame512(new Float32Array(512).fill(0.2), null, clock, 0.85, wakeProbs);
    clock += 32;
  }
  // Feed a negative step so patience resets
  for (let f = 0; f < 3; f++) {
    detector.processFrame512(new Float32Array(512).fill(0.2), null, clock, 0.85, negProbs);
    clock += 32;
  }
  assert.equal(wakes.length, 0, 'Single isolated 80ms neural spike must NOT wake without 2-frame patience!');

  // Now feed 2 consecutive 80ms neural steps (>= 5 frames = 160 ms) -> triggers wake!
  for (let f = 0; f < 6; f++) {
    detector.processFrame512(new Float32Array(512).fill(0.22), null, clock, 0.85, wakeProbs);
    clock += 32;
  }
  assert.equal(wakes.length, 1, '2 consecutive neural hits fire wake cleanly');
  assert.equal(wakes[0].engine, 'neural-oww');
  assert.equal(detector.operatingMode, 'post-wake-window');

  // Continue speaking inside silent 280 ms post-wake window -> Single-Breath handoff with >= 4800-sample (300ms) pre-lead!
  for (let f = 0; f < 5; f++) {
    detector.processFrame512(new Float32Array(512).fill(0.25), null, clock, 0.85);
    clock += 32;
  }
  assert.equal(singleBreaths.length, 1);
  assert.ok(singleBreaths[0].turn1OpeningPcm16.length >= 4800, '300 ms (4,800-sample) pre-lead preserved');

  // 6c. Pre-commit noise gate rejects brief < 220 ms bump
  detector.setMode('dormant');
  detector.setMode('active-listening');
  for (let f = 0; f < 3; f++) {
    detector.processFrame512(new Float32Array(512).fill(0.05), null, clock, 0.7);
    clock += 32;
  }
  for (let f = 0; f < 14; f++) {
    detector.processFrame512(new Float32Array(512).fill(0.0005), null, clock, 0.05);
    clock += 32;
  }
  assert.ok(discarded.length >= 1, 'Brief < 220 ms ambient burst discarded by pre-commit noise gate');

  // 6d. Bounded ACTIVE_FOLLOWUP decays silently after 10 s (313 frames * 32 ms = 10,016 ms)
  detector.setMode('dormant');
  detector.setMode('active-listening');
  for (let f = 0; f < 320; f++) {
    detector.processFrame512(new Float32Array(512).fill(0.0005), null, clock, 0.02);
    clock += 32;
  }
  assert.equal(followups, 1, 'Bounded 10 s ACTIVE_FOLLOWUP decayed silently to Dormant');
  assert.equal(detector.operatingMode, 'dormant');

  // 6e. Barge-In probe triggers after >= 96 ms post-PBFDAF double-talk during tts-speaking
  detector.setTtsPlaying(true);
  detector.setMode('tts-speaking');
  for (let f = 0; f < 5; f++) {
    // High near-end voice energy with zero ref -> postNlmsSnrDb >> 6 dB
    const voice = new Float32Array(512);
    for (let i = 0; i < 512; i++) voice[i] = 0.35 * Math.sin((2 * Math.PI * 240 * i) / 16000);
    detector.processFrame512(voice, new Float32Array(512), clock, 0.88);
    clock += 32;
  }
  assert.ok(probes.length >= 1 && probes[0].pcm16.length > 0, 'barge_in.probe fired after >= 96 ms double-talk');
});

await check('7. BargeInClassifier: LiveKit #8753 fix, SoftDuck, PausedHold, EN/VI Backchannel auto-resume, Hard-Cancel, and Echo-Leak Filter', () => {
  const clf = new BargeInClassifier();

  for (const w of ['uh-huh', 'mm-hmm', 'yeah', 'yep', 'okay', 'right', 'got it', 'i see', 'ừ', 'ừm', 'ờ', 'à', 'vâng', 'dạ', 'ok', 'đúng rồi', 'hiểu rồi']) {
    assert.equal(BACKCHANNEL_SET.has(w), true);
  }
  for (const w of ['stop', 'wait', 'hold on', 'pause', 'cancel', 'no', 'actually', 'dừng', 'dừng lại', 'khoan', 'đợi chút', 'thôi', 'hủy', 'mở', 'chuyển']) {
    assert.equal(HARD_CANCEL_SET.has(w), true);
  }

  for (let i = 0; i < 4; i++) {
    assert.equal(clf.onAudioFrame({ pSpeech: 0.9, postNlmsSnrDb: 12, echoSuppressed: false, currentPlayedMs: 500, currentSpokenText: 'Hello' }).state, 'Speaking');
  }
  for (let i = 0; i < 15; i++) {
    assert.equal(clf.onAudioFrame({ pSpeech: 0.1, postNlmsSnrDb: 1, echoSuppressed: false, currentPlayedMs: 600, currentSpokenText: 'Hello' }).state, 'Speaking');
  }
  assert.equal(clf.currentVoicedMs, 0);

  let ducked = null;
  let paused = null;
  for (let i = 1; i <= 11; i++) {
    const d = clf.onAudioFrame({
      pSpeech: 0.88,
      postNlmsSnrDb: 10.5,
      doubleTalkDetected: true,
      benestyNcc: 0.78,
      echoSuppressed: false,
      currentPlayedMs: 1000 + i * 32,
      currentSpokenText: 'Remember that agree is an action verb',
    });
    if (d.action === 'soft_duck') ducked = d;
    if (d.action === 'pause_hold') paused = d;
  }
  assert.ok(ducked && Math.abs(ducked.gainTarget - 0.251) < 0.01);
  assert.ok(paused && paused.pausedAtPlayedMs === 1352);

  const resumeDec = clf.onTranscript('Đúng rồi!', { isFinal: true });
  assert.equal(resumeDec.action, 'resume');
  assert.equal(resumeDec.reason, 'backchannel');
  assert.equal(resumeDec.purgeAudio, true);

  clf.recordEchoSpokenText('Present perfect describes unfinished time actions', 5000);
  const leakDec = clf.onTranscript('unfinished time actions', { isFinal: true, timestampMs: 6200 });
  assert.equal(leakDec.action, 'resume');
  assert.equal(leakDec.reason, 'echo-leak');

  const cancelDec = clf.onTranscript('Khoan đã', {
    isFinal: false,
    timestampMs: 6500,
    currentPlayedMs: 1840,
    currentSpokenText: 'Present perfect describes',
  });
  assert.equal(cancelDec.action, 'hard_cancel');
  assert.equal(cancelDec.playedMs, 1840);
});

await check('8. AudioSessionArbiter: priority preemption (sentinel > module-mic > active-voice > wake) and 0 ms logout teardown', () => {
  const arbiter = new AudioSessionArbiter({ bindBrowserEvents: false });
  const events = [];
  let trackStopped = false;
  const mockStream = { getTracks: () => [{ stop: () => { trackStopped = true; } }] };

  const wakeLease = arbiter.acquire('echo-hands-free-wake', 'jarvis-wake', {
    onSuspend: (r) => events.push(`wake:suspend:${r}`),
    onResume: () => events.push('wake:resume'),
    onForceTeardown: (r) => events.push(`wake:teardown:${r}`),
  });
  wakeLease.attachStream(mockStream);
  assert.equal(wakeLease.isGranted(), true);

  const speakingLease = arbiter.acquire('module-mic', 'speaking-shadowing', {});
  assert.equal(wakeLease.isGranted(), false);
  speakingLease.release();
  assert.equal(wakeLease.isGranted(), true);
  assert.deepEqual(events, ['wake:suspend:module-mic', 'wake:resume']);

  const t0 = performance.now();
  arbiter.setSentinelLock(true);
  assert.ok(performance.now() - t0 < 5);
  assert.equal(trackStopped, true);
  assert.equal(arbiter.canJarvisOperate('echo-active-voice'), false);

  arbiter.setSentinelLock(false);
  wakeLease.release();

  let logoutTornDown = false;
  const globalLease = audioMod.audioSessionArbiter.acquire('echo-active-voice', 'test-logout', {
    onForceTeardown: (r) => { if (r === 'logout') logoutTornDown = true; },
  });
  authLifecycle.beginLogout();
  assert.equal(logoutTornDown, true);
  authLifecycle.endLogout();
  globalLease.release();
  arbiter.dispose();
});

await check('9. EchoStreamingPlayback + EchoVoiceClient Contract A + Repaired HTTP/SSE Fallback + Repetition-Loop Guard + Earcons', async () => {
  // 9a. Frontend ASR repetition-loop guard catches "...ing, Writing, Writing, Writing..."
  assert.equal(
    isRepetitiveAsrHallucination('...ing, Writing, Writing, Writing, Writing, Writing, Writing'),
    true,
    'Repetition-loop hallucination caught on client defense-in-depth',
  );
  assert.equal(isRepetitiveAsrHallucination('Open my last book and continue where I stopped'), false);

  // 9b. 10 §AB passive pageContext sanitizer strips bookMeta & clientVisibleExcerpt
  const sanitized = sanitizePassivePageContext({
    kind: 'BOOK_EXCERPT',
    module: 'reading',
    bookMeta: { title: 'Secret Private Book' },
    clientVisibleExcerpt: 'Private passage content',
  });
  assert.equal(sanitized.bookMeta, undefined);
  assert.equal(sanitized.clientVisibleExcerpt, undefined);
  assert.equal(sanitized.module, 'reading');

  // 9c. Gapless WebAudio playback + outputLatency compensation + earcon synthesis + <50ms hardCancel
  const scheduledStarts = [];
  let oscillatorsStarted = 0;
  let mockCurrentTime = 10.0;
  const mockCtx = {
    state: 'running',
    sampleRate: 24000,
    outputLatency: 0.02, // 20 ms output latency
    baseLatency: 0.005, // 5 ms base latency -> total 25 ms
    get currentTime() { return mockCurrentTime; },
    destination: {},
    resume: async () => {},
    close: async () => {},
    createGain: () => ({
      gain: {
        value: 1.0,
        cancelScheduledValues: () => {},
        setValueAtTime: function (v) { this.value = v; },
        linearRampToValueAtTime: function (v) { this.value = v; },
        exponentialRampToValueAtTime: function (v) { this.value = v; },
      },
      connect: () => {},
      disconnect: () => {},
    }),
    createOscillator: () => ({
      type: 'sine',
      frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: () => {},
      disconnect: () => {},
      start: () => { oscillatorsStarted += 1; },
      stop: () => {},
      onended: null,
    }),
    createAnalyser: () => ({ fftSize: 512, smoothingTimeConstant: 0.5, connect: () => {} }),
    createBuffer: (_ch, length, sr) => {
      const ch0 = new Float32Array(length);
      return { length, sampleRate: sr, duration: length / sr, copyToChannel: (src) => ch0.set(src), getChannelData: () => ch0 };
    },
    createBufferSource: () => ({
      buffer: null,
      onended: null,
      connect: () => {},
      disconnect: () => {},
      start: (when) => scheduledStarts.push(when),
      stop: () => {},
    }),
  };

  let ttsAnalyserBound = false;
  const playback = new EchoStreamingPlayback({
    audioContextFactory: () => mockCtx,
    onAnalyserReady: (kind, node) => { if (kind === 'tts' && node.fftSize === 512) ttsAnalyserBound = true; },
  });

  // Play procedural wake earcon -> schedules oscillators cleanly without touching activeTurnSeq
  assert.equal(playback.playEarcon('wake'), true);
  assert.ok(oscillatorsStarted >= 1);
  assert.equal(playback.getOutputLatencyMs(), 25);

  const chunkA = new Int16Array(2400).fill(4000);
  const chunkB = new Int16Array(2400).fill(-4000);
  playback.enqueuePcm16(chunkA, {
    turnSeq: 5,
    sampleRate: 24000,
    text: 'Almost! Instead of I am agree,',
    wordTimings: [
      { word: 'Almost!', startMs: 0, endMs: 30 },
      { word: 'Instead', startMs: 30, endMs: 55 },
      { word: 'of', startMs: 55, endMs: 70 },
      { word: 'I', startMs: 70, endMs: 80 },
      { word: 'am', startMs: 80, endMs: 90 },
      { word: 'agree,', startMs: 90, endMs: 100 },
    ],
  });
  playback.enqueuePcm16(chunkB, { turnSeq: 5, sampleRate: 24000, text: 'say I agree.' });
  assert.equal(ttsAnalyserBound, true);
  assert.ok(Math.abs(scheduledStarts[1] - (scheduledStarts[0] + 0.1)) * 1000 < 1e-6, '0.000 ms gap');

  // 12 ms lead + 93 ms elapsed - 25 ms outputLatency = exact 68 ms ear-heard!
  mockCurrentTime = 10.105;
  assert.equal(playback.getPlayedMs(), 68, 'outputLatency-compensated getPlayedMs()');
  assert.equal(playback.getSpokenTextSoFar(), 'Almost! Instead of');
  assert.equal(playback.enqueuePcm16(chunkA, { turnSeq: 4 }), false);

  const cancelT0 = performance.now();
  const cancelled = playback.hardCancel();
  assert.ok(performance.now() - cancelT0 < 50);
  assert.equal(cancelled.playedMs, 68);

  // 9d. Contract A WS frames + pre-connect ring buffer + repaired HTTP/SSE fallback
  const sentWsFrames = [];
  let mockWsInstance = null;
  let clientPlanReceived = null;
  let guardReceived = null;
  let vadStateReceived = null;
  let toolConfirmedReceived = null;
  let bargeInDecisionReceived = [];
  let asrFinalRejected = null;
  let capturedHttpRequestBody = null;

  const client = new EchoVoiceClient({
    playback,
    callbacks: {
      onActionClientPlan: (p) => { clientPlanReceived = p; },
      onActionGuard: (g) => { guardReceived = g; },
      onBargeInServerDecision: (b) => { bargeInDecisionReceived.push(b); },
      onVadState: (v) => { vadStateReceived = v; },
      onToolConfirmed: (t) => { toolConfirmedReceived = t; },
      onAsrFinal: (f) => { asrFinalRejected = f; },
    },
    webSocketFactory: () => {
      const sock = {
        readyState: 0, // CONNECTING initially to test pre-connect ring buffer!
        binaryType: 'arraybuffer',
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send: (d) => sentWsFrames.push(d),
        close: () => { sock.readyState = 3; },
      };
      mockWsInstance = sock;
      setTimeout(() => {
        sock.readyState = 1;
        sock.onopen?.();
      }, 5);
      return sock;
    },
    fetchImpl: async (url, init) => {
      if (String(url).includes('/ai/chat/stream')) {
        capturedHttpRequestBody = JSON.parse(init.body);
        const enc = new TextEncoder();
        const sse = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(enc.encode('data: {"token":"Opening Reading workspace right now."}\n\n'));
            ctrl.enqueue(enc.encode('data: {"done":true}\n\n'));
            ctrl.close();
          },
        });
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ complete: false, probability: 0.21, recommendedWaitMs: 1850 }), { status: 200 });
    },
  });

  // Start connecting AND send speech_started + mic PCM while WS is still handshaking!
  const connectPromise = client.connect({
    mode: 'hands_free',
    locale: 'en',
    pageContext: { kind: 'BOOK_EXCERPT', module: 'reading', bookMeta: { title: 'Private' }, clientVisibleExcerpt: 'Secret' },
  });
  const tSeq = client.nextTurnSeq();
  await client.notifySpeechStarted(tSeq, { kind: 'BOOK_EXCERPT', bookMeta: { title: 'Private' } });
  client.sendMicPcm16(tSeq, 0, new Int16Array(512).fill(500));
  const connected = await connectPromise;
  assert.equal(connected, true);

  // Verify session.start stripped bookMeta/clientVisibleExcerpt AND pre-connect frames flushed in FIFO order!
  const startMsg = JSON.parse(sentWsFrames[0]);
  assert.equal(startMsg.type, 'session.start');
  assert.equal(startMsg.pageContext?.bookMeta, undefined, 'session.start NEVER sends bookMeta passively');
  assert.equal(startMsg.pageContext?.clientVisibleExcerpt, undefined, 'session.start NEVER sends excerpt passively');
  assert.equal(JSON.parse(sentWsFrames[1]).type, 'input.speech_started', 'Pre-connect speech_started flushed on open');
  assert.ok(sentWsFrames[2] instanceof ArrayBuffer, 'Pre-connect binary 0x01 PCM flushed on open');

  // Verify outbound turn_check, barge_in.probe (incl. <= 12,800-sample / 64 KiB clamp), turn.escalate, tool.confirm
  assert.equal(client.sendTurnCheck(tSeq, true), true);
  assert.equal(client.sendBargeInProbe(tSeq, new Int16Array(32000).fill(100), 'auto'), true);
  const probeFrameStr = sentWsFrames[sentWsFrames.length - 1];
  assert.ok(typeof probeFrameStr === 'string' && probeFrameStr.length < 36000, `barge_in.probe JSON clamped safely under 64 KiB (got ${probeFrameStr.length} B)`);
  assert.equal(JSON.parse(probeFrameStr).pcmBase64.length, Math.ceil((12800 * 2) / 3) * 4, 'barge_in.probe clamped to latest 12,800 samples (800 ms)');
  assert.equal(client.sendTurnEscalate({ turnSeq: tSeq, reason: 'mybooks_empty', text: 'Open my last book' }), true);
  assert.equal(client.sendToolConfirm('tok-123', 'CONFIRM'), true);

  // Verify inbound Contract A events + WS parity fallbacks (`language`, `promptVi`, `plan.created`, `barge_in.decision`)
  mockWsInstance.onmessage({ data: JSON.stringify({ type: 'action.client_plan', turnSeq: tSeq, intents: [{ kind: 'navigate', href: '/reading' }], spokenAck: 'Đang mở Reading.', language: 'vi', playEarcon: 'action_ok' }) });
  mockWsInstance.onmessage({ data: JSON.stringify({ type: 'action.guard', turnSeq: tSeq, decision: 'DENIED', reason: 'exam_assist', promptEn: 'Not allowed during exam.', promptVi: 'Không được phép khi đang thi.', language: 'vi' }) });
  mockWsInstance.onmessage({ data: JSON.stringify({ type: 'vad.state', state: 'thinking_pause', turnSeq: tSeq, complete: false, probability: 0.25, recommendedWaitMs: 1200 }) });
  mockWsInstance.onmessage({ data: JSON.stringify({ type: 'tool.confirmed', status: 'APPLIED', plan: { created: 4 } }) });
  mockWsInstance.onmessage({ data: JSON.stringify({ type: 'barge_in.decision', turnSeq: tSeq, decision: 'backchannel', text: 'ừ' }) });
  mockWsInstance.onmessage({ data: JSON.stringify({ type: 'barge_in.decision', turnSeq: tSeq, decision: 'interrupt', text: 'dừng lại' }) });
  mockWsInstance.onmessage({ data: JSON.stringify({ type: 'asr.final', turnSeq: tSeq, text: 'Writing, Writing, Writing, Writing, Writing', lang: 'en' }) });

  assert.equal(clientPlanReceived?.intents?.length, 1);
  assert.equal(clientPlanReceived?.lang, 'vi', 'action.client_plan falls back to msg.language');
  assert.equal(guardReceived?.decision, 'DENIED');
  assert.equal(guardReceived?.spokenMessage, 'Không được phép khi đang thi.', 'action.guard falls back to promptVi/promptEn');
  assert.equal(vadStateReceived?.recommendedWaitMs, 1200);
  assert.equal(toolConfirmedReceived?.savedCards, 4, 'tool.confirmed falls back to plan.total / plan.created');
  assert.deepEqual(bargeInDecisionReceived.map((b) => b.decision), ['backchannel', 'interrupt']);
  assert.equal(asrFinalRejected?.text, '', 'Repetitive Whisper loop dropped cleanly');
  assert.equal(asrFinalRejected?.rejectedReason, 'repetition_loop');

  // Verify repaired HTTP/SSE fallback request schema (`messages`, `channel: "voice"`, `locale`, `turnId`) & `parsed.token`!
  const httpReply = await client.executeHttpFallbackTurn({
    turnSeq: tSeq + 1,
    message: 'Help me practice IELTS reading',
    history: [{ role: 'assistant', content: 'Ready!' }],
    locale: 'en',
    voiceId: 'device',
  });
  assert.equal(httpReply, 'Opening Reading workspace right now.', 'HTTP/SSE parsed canonical parsed.token!');
  assert.equal(capturedHttpRequestBody.channel, 'voice');
  assert.equal(capturedHttpRequestBody.locale, 'en');
  assert.ok(typeof capturedHttpRequestBody.turnId === 'string' && capturedHttpRequestBody.turnId.length > 4);
  assert.equal(capturedHttpRequestBody.messages.length, 2);
  assert.equal(capturedHttpRequestBody.messages[1].content, 'Help me practice IELTS reading');

  // Verify 7B framing, EvenBytePcmStreamAssembler, FirstClauseChunker, and EchoTelemetryTracker
  const binFrame = encodeBinaryAudioFrame(ECHO_WS_MSG_MIC_PCM16, 0x02a5, 48000, new Int16Array([1234, -5678, 32767]));
  const parsedFrame = decodeBinaryAudioFrame(binFrame);
  assert.equal(parsedFrame.turnSeq, 0x02a5);
  assert.equal(parsedFrame.sampleOffset, 48000);

  const assembler = new EvenBytePcmStreamAssembler();
  assert.deepEqual(Array.from(assembler.push(new Uint8Array([0x34, 0x12, 0x78]))), [0x34, 0x12]);
  assert.deepEqual(Array.from(assembler.push(new Uint8Array([0x56, 0x01, 0x00]))), [0x78, 0x56, 0x01, 0x00]);

  const chunker = new FirstClauseChunker();
  assert.equal(chunker.push('Sure! Opening your IELTS Reading workspace right now, and filtering by level B2 so you can start.')[0], 'Sure! Opening your IELTS Reading workspace right now,');

  const tel = new EchoTelemetryTracker(128);
  for (let i = 1; i <= 100; i++) tel.record('eouToFirstAudioMs', i * 5);
  assert.ok(Math.abs(tel.snapshot().metrics.eouToFirstAudioMs.p50 - 252.5) < 0.1);

  const earconHistory = new EchoEarconSynth();
  earconHistory.play(mockCtx, 'action_ok', mockCtx.destination);
  assert.equal(earconHistory.getHistory().length, 1);

  client.dispose();
  playback.dispose();
});

await check('10. EchoJarvisRuntime Single-Greeting Session Epoch Invariant: strictly <= 1 greeting per enabled Hands-Free session, 0 on reload/tap/reconfigure/sleep', async () => {
  let spokenGreetings = 0;
  let startCalls = 0;
  const mockSession = {
    playback: {
      isPlaying: false,
      isPausedHold: false,
      ensureAudioContext: () => null,
      getAnalyserNode: () => null,
      playEarcon: () => true,
      hardCancel: () => ({ playedMs: 0, spokenTextSoFar: '', turnSeq: 1 }),
      playWakeGreeting: async () => { spokenGreetings += 1; return true; },
      dispose: () => {},
    },
    detector: {
      setMode: () => {},
      setTtsPlaying: () => {},
    },
    voiceClient: {
      isWsConnected: false,
      nextTurnSeq: () => 2,
      cancelAndTruncateTurn: async () => {},
      sendToolConfirm: () => true,
      dispose: () => {},
    },
    setPreferences: () => {},
    setFollowupExtended: () => {},
    start: async () => { startCalls += 1; return true; },
    stop: () => {},
    dispose: () => {},
  };

  const rt = new EchoJarvisRuntime(
    {
      sessionFactory: () => mockSession,
      playGreetingImpl: async () => { spokenGreetings += 1; return true; },
    },
    false,
  );

  rt.configure({ userId: 'u42', voiceId: 'us_female', locale: 'en', sessionId: 101 });

  // 1. Explicit OFF -> ON toggle plays EXACTLY ONE greeting!
  assert.equal(await rt.setHandsFreeEnabled(true, { userInitiated: true }), true);
  assert.equal(spokenGreetings, 1, 'Exactly 1 greeting on explicit OFF -> ON');

  // 2. Redundant enable, configure route/voice changes, manual mic tap, sleep, mute/unmute -> ZERO additional greetings!
  await rt.setHandsFreeEnabled(true, { userInitiated: true });
  rt.configure({ userId: 'u42', voiceId: 'uk_male', locale: 'vi', sessionId: 202 });
  await rt.startActiveVoiceTurn();
  rt.enterSleep({ silent: true });
  rt.setMuted(true);
  rt.setMuted(false);
  assert.equal(spokenGreetings, 1, 'ZERO re-greetings across reconfigure, manual tap, sleep, and mute');

  // 3. Page-reload restoration (`restoreHandsFreeSilently`) -> ZERO greetings!
  const rtReload = new EchoJarvisRuntime(
    {
      sessionFactory: () => mockSession,
      playGreetingImpl: async () => { spokenGreetings += 1; return true; },
    },
    false,
  );
  await rtReload.restoreHandsFreeSilently('u42');
  assert.equal(spokenGreetings, 1, 'ZERO greeting on silent page-reload restore');

  // 4. Explicit OFF -> ON again starts a new epoch -> exactly 1 fresh greeting (total 2)
  await rt.setHandsFreeEnabled(false, { userInitiated: true });
  await rt.setHandsFreeEnabled(true, { userInitiated: true });
  assert.equal(spokenGreetings, 2, 'New OFF -> ON epoch speaks once');

  // 5. Security + Card Wire regression:
  //    - handleServerActionsAndCards requires act.auto === true AND rejects //evil.com open redirects!
  //    - Server EchoCard `{ type: 'confirm', title, items, token, note }` populates pendingConfirmation & confirm toast!
  const intentsMod = await import('../src/lib/echo-jarvis/intents/actionDispatcher.ts');
  const voiceStoreMod = await import('../src/lib/echo-jarvis/intents/voiceSessionStore.ts');
  const pushedRoutes = [];
  const unregisterHost = intentsMod.registerEchoActionHost({
    routerPush: (href) => { pushedRoutes.push(href); },
  });
  try {
    rt['handleServerActionsAndCards'](
      [
        { type: 'navigate', href: '/reading', auto: false }, // MUST ignore (auto !== true)
        { type: 'navigate', href: '/flashcards' }, // MUST ignore (auto missing)
        { type: 'navigate', href: '//evil.com/phish', auto: true }, // MUST reject open redirect!
        { type: 'navigate', href: '/\\evil.com/phish', auto: true }, // MUST reject backslash redirect!
        { type: 'navigate', href: '/reading?tab=mybooks', auto: true }, // ALLOWED!
      ],
      [
        {
          type: 'confirm',
          title: 'Save 3 flashcards',
          items: [{ label: 'resilient', detail: 'able to recover quickly' }],
          token: 'srv-tok-99',
          note: 'Confirm to add to your deck',
        },
      ],
    );
    assert.deepEqual(pushedRoutes, ['/reading?tab=mybooks'], 'Only auto:true non-protocol-relative internal routes execute');
    const storeSnap = voiceStoreMod.getVoiceSessionSnapshot();
    assert.equal(storeSnap.pendingConfirmation?.kind, 'server');
    assert.equal(storeSnap.pendingConfirmation?.token, 'srv-tok-99');
    assert.equal(storeSnap.activeToast?.kind, 'confirm');
    assert.equal(storeSnap.activeToast?.subtitle, 'Confirm to add to your deck');
    assert.equal(storeSnap.activeToast?.items?.[0]?.title, 'resilient');

    // Regression (#54): WS `tool.confirmed` clears pendingConfirmation before displaying success toast!
    const runtimeSrc = readFileSync(resolve(SRC_DIR, 'lib/echo-jarvis/runtime/echoJarvisRuntime.ts'), 'utf8');
    assert.match(runtimeSrc, /onToolConfirmed:\s*\(info\)\s*=>\s*\{\s*voiceStore\.clearPendingConfirmation\(\);/, 'onToolConfirmed clears pendingConfirmation');
    voiceStoreMod.clearPendingConfirmation();
    assert.equal(voiceStoreMod.getVoiceSessionSnapshot().pendingConfirmation, null);
  } finally {
    unregisterHost();
  }

  // 6. P0 regression (#50): Enabling Hands-Free from cold state sets handsFreeWake=true so after welcome greeting
  //    playback completes (`onPlaybackEnd`), detector stays in 'dormant' & entity stays 'dormant' (NEVER 'disabled')!
  const entityStates = [];
  const coldSession = new audioMod.EchoJarvisAudioSession({
    handsFreeWake: false,
    useDedicatedDspWorker: false,
    callbacks: {
      onEntityState: (s) => entityStates.push(s),
    },
  });
  coldSession.setPreferences({ handsFreeWake: true });
  coldSession.playback.enqueuePcm16(new Int16Array(480).fill(500), { turnSeq: 2, sampleRate: 24000, text: 'Ready.' });
  coldSession.playback.markTurnAudioStreamFinished(2);
  // Wait for headless playback timer (20 ms clip) to fire onPlaybackEnd
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(coldSession.detector.operatingMode, 'dormant', 'Detector returns to dormant wake-listening after greeting ends');
  assert.equal(entityStates[entityStates.length - 1], 'dormant', 'Entity returns to dormant (NEVER disabled) after greeting ends');
  coldSession.dispose();

  // 7. Logout hardTeardown resets everything cleanly in 0 ms
  rt.hardTeardown();
  assert.equal(rt.getGreetingDiagnostics().handsFreeSessionEpoch, 0);
  assert.equal(rt.getGreetingDiagnostics().greetingSpokenEpoch, 0);
  assert.ok(startCalls >= 3);
});

await check('11. Dedicated Zero-WASM DSP Web Worker (/echo-jarvis/echo-voice-dsp.worker.js): loads live INT8 models and fires 0 false wakes on silence & noise', async () => {
  const workerSrc = readFileSync(resolve(PUBLIC_DIR, 'echo-jarvis/echo-voice-dsp.worker.js'), 'utf8');
  const posted = [];
  const workerSelf = {
    onmessage: null,
    postMessage: (msg) => posted.push(msg),
  };

  const mockFetch = async (url) => {
    const fname = String(url).split('/').pop();
    const buf = readFileSync(resolve(PUBLIC_DIR, 'echo-jarvis/models', fname));
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(buf.toString('utf8')),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };

  runInNewContext(workerSrc, {
    self: workerSelf,
    fetch: mockFetch,
    performance,
    Float32Array,
    Int16Array,
    Int8Array,
    Uint8Array,
    Uint16Array,
    DataView,
    Map,
    Math,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Error,
    Promise,
    Date,
  });

  assert.equal(posted[0]?.type, 'ready', 'Worker emits ready');
  workerSelf.onmessage({ data: { type: 'load-weights', baseUrl: '/echo-jarvis/models' } });
  // Wait for async mockFetch microtasks
  await new Promise((r) => setTimeout(r, 30));

  const loadedMsg = posted.find((m) => m.type === 'weights-loaded');
  assert.ok(loadedMsg && loadedMsg.ok === true, 'Worker loaded live INT8 Silero + OWW weights cleanly');

  workerSelf.onmessage({ data: { type: 'set-output-latency-ms', latencyMs: 25 } });
  workerSelf.onmessage({ data: { type: 'set-mode', mode: 'dormant' } });

  // Pump 40 frames (1.28 s) of quiet ambient noise -> 0 false wakes, 0 main-thread spam!
  let rng = 424242;
  let ts = 1000;
  for (let f = 0; f < 40; f++) {
    const frame = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      frame[i] = ((rng / 4294967296) * 2 - 1) * 0.015;
    }
    workerSelf.onmessage({ data: { type: 'frame', mic: frame, ref: null, timestampMs: ts } });
    ts += 32;
  }

  const wakes = posted.filter((m) => m.type === 'wake');
  assert.equal(wakes.length, 0, 'Worker fired 0 false wakes across 40 ambient noise frames');

  // Verify worker `abort-turn` (RC-1B) and `set-waiting-response` (anti-decay during slow LLM thinking):
  workerSelf.onmessage({ data: { type: 'set-mode', mode: 'active-listening' } });
  // Feed voiced speech so worker enters turnSpeaking = true
  for (let f = 0; f < 10; f++) {
    const speech = new Float32Array(512);
    for (let i = 0; i < 512; i++) speech[i] = 0.35 * Math.sin((2 * Math.PI * 220 * i) / 16000);
    workerSelf.onmessage({ data: { type: 'frame', mic: speech, ref: null, timestampMs: ts } });
    ts += 32;
  }
  const speechStartsBefore = posted.filter((m) => m.type === 'speech-start').length;
  assert.ok(speechStartsBefore >= 1, 'Worker started active speech turn');
  // Simulate server `vad.state: eou_committed` arriving at 380 ms pause -> `abort-turn` + `set-waiting-response: true`
  workerSelf.onmessage({ data: { type: 'abort-turn' } });
  workerSelf.onmessage({ data: { type: 'set-waiting-response', waiting: true } });
  // Feed 400 frames (12.8 s > 10 s follow-up window) of silence -> 0 duplicate `speech-end` AND 0 premature `followup-timeout`!
  for (let f = 0; f < 400; f++) {
    workerSelf.onmessage({ data: { type: 'frame', mic: new Float32Array(512), ref: null, timestampMs: ts } });
    ts += 32;
  }
  assert.equal(posted.filter((m) => m.type === 'speech-end').length, 0, 'RC-1B: abort-turn prevents duplicate speech-end commit');
  assert.equal(posted.filter((m) => m.type === 'followup-timeout').length, 0, 'Waiting for LLM response prevents premature 10s decay');
  // Clear waiting -> 320 frames (10.24 s) of idle silence now decays cleanly to dormant!
  workerSelf.onmessage({ data: { type: 'set-waiting-response', waiting: false } });
  for (let f = 0; f < 320; f++) {
    workerSelf.onmessage({ data: { type: 'frame', mic: new Float32Array(512), ref: null, timestampMs: ts } });
    ts += 32;
  }
  assert.equal(posted.filter((m) => m.type === 'followup-timeout').length, 1, 'Decays to dormant after response finishes + 10s idle');
});

await check('12. Wave A Production Recovery: Zero raw "failed", RC-1B eou_committed guard, RC-1C greeting turnSeq sync, utteranceId coalescing, barge-in handoff, and WS->HTTP mid-turn failover', async () => {
  const voiceStoreMod = await import('../src/lib/echo-jarvis/intents/voiceSessionStore.ts');

  // 12a. Pure stop vs speech interruption classification
  assert.equal(audioMod.isPureStopCommand('Stop!'), true);
  assert.equal(audioMod.isPureStopCommand('Dừng lại'), true);
  assert.equal(audioMod.isPureStopCommand('Thôi'), true);
  assert.equal(audioMod.isPureStopCommand('Stop, explain that in Vietnamese'), false);
  assert.equal(audioMod.isPureStopCommand('Khoan đã, cho mình hỏi câu khác'), false);

  // 12b. RC-1C: Greeting + idle hardCancel NEVER push playback.currentTurnSeq ahead of voiceClient.nextTurnSeq(),
  //      AND multi-packet utteranceId coalescing aligns syllable-paced spokenTextSoFar across the full clause!
  let mockClock = 20.0;
  const mockCtx12 = {
    state: 'running',
    sampleRate: 24000,
    outputLatency: 0,
    baseLatency: 0,
    get currentTime() { return mockClock; },
    destination: {},
    resume: async () => {},
    close: async () => {},
    createGain: () => ({
      gain: {
        value: 1.0,
        cancelScheduledValues: () => {},
        setValueAtTime: function (v) { this.value = v; },
        linearRampToValueAtTime: function (v) { this.value = v; },
        exponentialRampToValueAtTime: function (v) { this.value = v; },
      },
      connect: () => {},
      disconnect: () => {},
    }),
    createAnalyser: () => ({ fftSize: 512, smoothingTimeConstant: 0.5, connect: () => {} }),
    createBuffer: (_ch, length, sr) => {
      const ch0 = new Float32Array(length);
      return { length, sampleRate: sr, duration: length / sr, copyToChannel: (s) => ch0.set(s), getChannelData: () => ch0 };
    },
    createBufferSource: () => ({
      buffer: null,
      onended: null,
      connect: () => {},
      disconnect: () => {},
      start: () => {},
      stop: () => {},
    }),
  };

  const pb12 = new EchoStreamingPlayback({ audioContextFactory: () => mockCtx12 });
  // Simulate idle hardCancel before any turn
  pb12.hardCancel();
  assert.equal(pb12.currentTurnSeq, 0, 'Idle hardCancel must NOT increment activeTurnSeq');

  const vc12 = new EchoVoiceClient({ playback: pb12 });
  const turn1 = vc12.nextTurnSeq();
  assert.equal(turn1, 2);
  // Enqueue 3 packets of 2400 samples (100 ms each = 300 ms total) sharing the same utteranceId (`u-clause-0`)
  const clauseText = 'One two three four five six';
  assert.equal(pb12.enqueuePcm16(new Int16Array(2400).fill(800), { turnSeq: turn1, utteranceId: 'u-clause-0', sampleRate: 24000, text: clauseText }), true);
  assert.equal(pb12.enqueuePcm16(new Int16Array(2400).fill(800), { turnSeq: turn1, utteranceId: 'u-clause-0', sampleRate: 24000, text: '' }), true);
  assert.equal(pb12.enqueuePcm16(new Int16Array(2400).fill(800), { turnSeq: turn1, utteranceId: 'u-clause-0', sampleRate: 24000, text: '' }), true);

  // At 120 ms elapsed (~108 ms after 12ms lead), < 50% of the 300ms clause has played -> must NOT claim all 6 words were heard!
  mockClock = 20.132; // 120 ms played
  const partialHeard = pb12.getSpokenTextSoFar();
  assert.ok(partialHeard.split(' ').length <= 3, `Multi-packet coalescing preserves mid-clause heard boundary (got "${partialHeard}")`);

  // Cancelling active Turn 1 advances playback.currentTurnSeq to 2, and vc12.nextTurnSeq() synchronizes to 3 (>= currentTurnSeq)!
  pb12.hardCancel();
  const turn2 = vc12.nextTurnSeq();
  assert.ok(turn2 >= pb12.currentTurnSeq, `nextTurnSeq (${turn2}) stays >= playback.currentTurnSeq (${pb12.currentTurnSeq})`);
  assert.equal(pb12.enqueuePcm16(new Int16Array(2400).fill(600), { turnSeq: turn2, sampleRate: 24000, text: 'Follow-up answer.' }), true);
  vc12.dispose();
  pb12.dispose();

  // 12c. RC-1B + Continuous Follow-Up + Mid-Turn WS Drop -> HTTP Failover in EchoJarvisAudioSession
  let wsSock = null;
  const wsSent = [];
  let httpFallbackCalls = 0;
  let completedReply = '';
  const sessionErrors = [];

  const session = new audioMod.EchoJarvisAudioSession({
    handsFreeWake: true,
    locale: 'vi',
    useDedicatedDspWorker: false,
    callbacks: {
      onTurnComplete: (txt) => { completedReply = txt; },
      onError: (code, detail, meta) => { sessionErrors.push({ code, detail, meta }); },
    },
  });

  // Inject deterministic WS + HTTP mocks on session.voiceClient
  session.voiceClient['wsFactory'] = () => {
    const s = {
      readyState: 1,
      binaryType: 'arraybuffer',
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: (d) => wsSent.push(d),
      close: () => { s.readyState = 3; },
    };
    wsSock = s;
    queueMicrotask(() => s.onopen?.());
    return s;
  };
  session.voiceClient['fetchFn'] = async (url) => {
    const u = String(url);
    if (u.includes('/ai/chat/stream')) {
      httpFallbackCalls += 1;
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('data: {"token":"Đây là câu trả lời dự phòng mượt mà."}\n\n'));
            c.enqueue(enc.encode('data: {"done":true}\n\n'));
            c.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    return new Response(null, { status: 503 });
  };

  session['running'] = true;
  session['activeConversationMode'] = true;
  await session.voiceClient.connect({ mode: 'hands_free', locale: 'vi' });
  await new Promise((r) => setTimeout(r, 5));

  // Start speech turn -> server commits early via `vad.state: eou_committed`
  session.detector.setMode('active-listening');
  let detClock = 5000;
  for (let f = 0; f < 10; f++) {
    session.detector.processFrame512(new Float32Array(512).fill(0.25), null, detClock, 0.9);
    detClock += 32;
  }
  const activeSeq = session['activeTurnSeq'];
  wsSock.onmessage({
    data: JSON.stringify({
      type: 'vad.state',
      state: 'eou_committed',
      turnSeq: activeSeq,
      complete: true,
      probability: 0.94,
      recommendedWaitMs: 0,
    }),
  });
  // Feed 40 frames (1.28 s) of trailing silence -> MUST NOT send any `input.commit`!
  const commitsBeforeSilence = wsSent.filter((x) => typeof x === 'string' && x.includes('"input.commit"')).length;
  for (let f = 0; f < 40; f++) {
    session.detector.processFrame512(new Float32Array(512), null, detClock, 0.01);
    detClock += 32;
  }
  const commitsAfterSilence = wsSent.filter((x) => typeof x === 'string' && x.includes('"input.commit"')).length;
  assert.equal(commitsAfterSilence, commitsBeforeSilence, 'RC-1B: Zero duplicate input.commit after eou_committed!');

  // Now simulate ASR final arriving, then WS abruptly dropping BEFORE any LLM output -> seamless HTTP failover!
  wsSock.onmessage({
    data: JSON.stringify({
      type: 'asr.final',
      turnSeq: activeSeq,
      text: 'Hôm nay mình nên học gì?',
      lang: 'vi',
    }),
  });
  wsSock.readyState = 3;
  wsSock.onclose?.();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(httpFallbackCalls, 1, 'Mid-turn WS drop before output automatically failed over to HTTP SSE stream');
  assert.equal(completedReply, 'Đây là câu trả lời dự phòng mượt mà.');
  assert.equal(sessionErrors.length, 0, 'Seamless failover emitted 0 user-facing errors');
  session.dispose();

  // 12d. RC-1A: Raw `"failed"` from WS (`status: 502, code: "failed"`) and SSE (`{"error":"failed"}`)
  //      NEVER leaks `"failed"` to toast/store and auto-recovers out of `'error'`!
  const rtErr = new EchoJarvisRuntime({}, false);
  rtErr.configure({ userId: 'u99', voiceId: 'device', locale: 'vi', sessionId: 505 });
  const internalSession = rtErr['ensureAudioSession']();
  internalSession['running'] = true;
  internalSession['activeConversationMode'] = true;

  // Trigger raw backend `"failed"` error
  rtErr['lastUserTranscript'] = 'Giải thích thì hiện tại hoàn thành';
  rtErr['handleTypedVoiceError']('failed', undefined, { status: 502 });

  const errSnap = voiceStoreMod.getVoiceSessionSnapshot();
  assert.equal(errSnap.lastError?.kind, 'service_busy');
  assert.equal(errSnap.lastError?.canRetry, true);
  assert.notEqual(errSnap.activeToast?.title?.toLowerCase(), 'failed', 'NEVER render raw "failed"');
  assert.ok(!String(errSnap.activeToast?.title || '').toLowerCase().includes('failed'), 'Vietnamese error toast contains zero raw "failed"');
  assert.equal(errSnap.entityState, 'error');

  // Dismiss error -> immediately restores active listening without page reload!
  rtErr.dismissError();
  assert.equal(voiceStoreMod.getVoiceSessionSnapshot().lastError, null);
  assert.equal(voiceStoreMod.getVoiceSessionSnapshot().entityState, 'listening');

  // Turning Hands-Free OFF clears all lingering toasts/errors/confirmations (RC-2B)
  rtErr['handleTypedVoiceError']('provider_unreachable', undefined, { status: 503 });
  await rtErr.setHandsFreeEnabled(false, { userInitiated: true });
  const offSnap = voiceStoreMod.getVoiceSessionSnapshot();
  assert.equal(offSnap.activeToast, null, 'RC-2B: Turning Hands-Free OFF clears activeToast');
  assert.equal(offSnap.lastError, null, 'RC-2B: Turning Hands-Free OFF clears lastError');
  assert.equal(offSnap.entityState, 'disabled');
  rtErr.hardTeardown();

  // 12e. Wave C `ec:module-mic` arbitration (Shadowing recording preemption):
  //      Suspends active conversation + returns cleanly to `dormant` wake standby (Hands-Free ON)
  //      or `disabled` (Hands-Free OFF) without re-entering `'active-listening'`!
  const micArbStates = [];
  const arbSession = new audioMod.EchoJarvisAudioSession({
    handsFreeWake: true,
    useDedicatedDspWorker: false,
    callbacks: { onEntityState: (s) => micArbStates.push(s) },
  });
  arbSession['rebindMicrophone'] = async () => true;
  assert.equal(await arbSession.start('active-conversation'), true);
  assert.equal(arbSession.isActiveConversation, true);
  assert.equal(arbSession.detector.operatingMode, 'active-listening');

  const shadowLease = audioMod.audioSessionArbiter.acquire('module-mic', 'speaking-shadowing');
  assert.equal(arbSession.isActiveConversation, false, 'module-mic clears activeConversationMode');
  assert.equal(arbSession.detector.operatingMode, 'disabled', 'detector suspended during Shadowing mic capture');
  assert.equal(micArbStates.at(-1), 'dormant', 'Hands-Free ON yields entity to dormant standby');

  shadowLease.release();
  assert.equal(arbSession.isActiveConversation, false, 'module-mic release never re-enters live active-listening');
  assert.equal(arbSession.detector.operatingMode, 'dormant', 'Hands-Free ON resumes wake-word standby only');
  assert.equal(micArbStates.at(-1), 'dormant');

  // Manual-only voice (`handsFreeWake: false`) stops and returns to `disabled` after module-mic
  arbSession.setPreferences({ handsFreeWake: false });
  assert.equal(await arbSession.start('active-conversation'), true);
  const shadowLease2 = audioMod.audioSessionArbiter.acquire('module-mic', 'speaking-shadowing');
  assert.equal(micArbStates.at(-1), 'disabled', 'Manual voice yields entity to disabled');
  shadowLease2.release();
  assert.equal(arbSession.isRunning, false, 'Manual voice stays stopped when Shadowing finishes');
  assert.equal(arbSession.detector.operatingMode, 'disabled');
  arbSession.dispose();
});

console.log(`\nEcho JARVIS Reforge Audio, PBFDAF AEC, Dedicated DSP Worker, Single-Greeting Epoch, and Contract A/B: ${passed}/12 test suites PASSED.`);
