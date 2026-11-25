import type { EchoEntityState } from './echoSprings';

/**
 * Zero-GC real-time 32-bin perceptual Bark FFT mapper (85 Hz -> 7,800 Hz)
 * with asymmetric 8 ms attack / 65 ms release envelope, spectral centroid,
 * positive half-wave onset flux, viseme formant energy, and calibrated
 * silence / whisper / normal / energetic speech dynamics for:
 * - Live Microphone AnalyserNode ('mic', inward Listening wave ribbon)
 * - Live TTS Playback AnalyserNode ('tts', outward Speaking 3D caustic field)
 * - Device speechSynthesis.onboundary phoneme-class envelope fallback
 */

export type EchoAudioChannel = 'mic' | 'tts';
export type EchoPhonemeClass = 'open_vowel' | 'front_vowel' | 'sibilant' | 'plosive' | 'nasal' | 'silence';

export interface EchoAnalyserLike {
  readonly fftSize: number;
  readonly frequencyBinCount: number;
  readonly context?: { readonly state?: string; readonly sampleRate?: number };
  getByteFrequencyData(array: Uint8Array<ArrayBuffer>): void;
  getByteTimeDomainData?(array: Uint8Array<ArrayBuffer>): void;
}

export interface EchoAcousticFrame {
  readonly spectrum: Float32Array;
  voiceRms: number;
  voiceDbfs: number;
  bass: number;
  mid: number;
  treble: number;
  spectralCentroid: number;
  onsetFlux: number;
  visemeEnergy: number;
  /** Continuous [0 = silence, 0.20..0.42 = whisper, 0.45..0.78 = normal, 0.80..1.0 = energetic] */
  speechIntensityTier: number;
  /** -1 = Mic Listening (inward), +1 = TTS Speaking (outward), 0 = neutral */
  source: number;
  mode: 'mic' | 'tts' | 'boundary' | 'silent';
}

export const ECHO_BARK_BIN_COUNT = 32;
export const ECHO_BARK_MIN_HZ = 85;
export const ECHO_BARK_MAX_HZ = 7800;
export const ECHO_ATTACK_TAU_SEC = 0.008;
export const ECHO_RELEASE_TAU_SEC = 0.065;

/** Zwicker perceptual critical-band rate z(f) in Bark. */
export function hzToBark(hz: number): number {
  const f = Math.max(0, hz);
  const r = f / 7500;
  return 13 * Math.atan(0.00076 * f) + 3.5 * Math.atan(r * r);
}

/** Inverse Bark-to-Hz via 28-step monotonic binary search on [0, 20000 Hz]. */
export function barkToHz(bark: number): number {
  let lo = 0;
  let hi = 20000;
  for (let i = 0; i < 28; i++) {
    const mid = 0.5 * (lo + hi);
    if (hzToBark(mid) < bark) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function buildBarkBandEdges(): Float32Array {
  const edges = new Float32Array(ECHO_BARK_BIN_COUNT + 1);
  // [0..6]: 85..300 Hz (F0), [6..14]: 300..1000 Hz (F1), [14..24]: 1000..3200 Hz (F2/F3), [24..32]: 3200..7800 Hz (Sibilants)
  const anchors: readonly [number, number, number, number][] = [
    [0, 6, 85, 300],
    [6, 14, 300, 1000],
    [14, 24, 1000, 3200],
    [24, 32, 3200, 7800],
  ];
  for (const [startBin, endBin, fLo, fHi] of anchors) {
    const zLo = hzToBark(fLo);
    const zHi = hzToBark(fHi);
    const count = endBin - startBin;
    for (let k = 0; k <= count; k++) {
      if (k === 0) edges[startBin] = fLo;
      else if (k === count) edges[endBin] = fHi;
      else edges[startBin + k] = barkToHz(zLo + ((zHi - zLo) * k) / count);
    }
  }
  return edges;
}

export const BARK_BAND_EDGES_HZ: Float32Array = buildBarkBandEdges();

export const BARK_BAND_CENTERS_HZ: Float32Array = (() => {
  const centers = new Float32Array(ECHO_BARK_BIN_COUNT);
  for (let i = 0; i < ECHO_BARK_BIN_COUNT; i++) {
    centers[i] = 0.5 * (BARK_BAND_EDGES_HZ[i] + BARK_BAND_EDGES_HZ[i + 1]);
  }
  return centers;
})();

/**
 * Asymmetric first-order envelope follower:
 * 8 ms crisp attack on plosive/syllable onset, 65 ms organic vowel decay.
 */
export function stepAsymmetricEnvelope(
  current: number,
  target: number,
  dtSec: number,
  attackTauSec = ECHO_ATTACK_TAU_SEC,
  releaseTauSec = ECHO_RELEASE_TAU_SEC,
): number {
  if (!(dtSec > 0) || !Number.isFinite(dtSec)) return current;
  const tau = target > current ? Math.max(1e-4, attackTauSec) : Math.max(1e-4, releaseTauSec);
  const alpha = 1 - Math.exp(-Math.min(dtSec, 1.0) / tau);
  return current + (target - current) * alpha;
}

/**
 * Maps linear Uint8Array FFT magnitudes into 32 Bark-spaced perceptual bins [0..1]
 * with fractional-bin interpolation for narrow low-frequency F0 bands and zero heap allocations.
 */
export function mapFftToBark32(
  fftBytes: Uint8Array,
  sampleRate: number,
  fftSize: number,
  out32: Float32Array,
): number {
  const nBins = fftBytes.length;
  if (nBins === 0 || !(sampleRate > 0) || !(fftSize > 0)) {
    out32.fill(0);
    return 0;
  }
  const hzPerBin = sampleRate / fftSize;
  const maxIdx = nBins - 1;
  let energySum = 0;

  for (let b = 0; b < ECHO_BARK_BIN_COUNT; b++) {
    const fLo = BARK_BAND_EDGES_HZ[b];
    const fHi = BARK_BAND_EDGES_HZ[b + 1];
    const kLo = Math.min(maxIdx, Math.max(0, fLo / hzPerBin));
    const kHi = Math.min(maxIdx, Math.max(kLo, fHi / hzPerBin));
    const span = kHi - kLo;

    let mag = 0;
    if (span < 1.0) {
      const kMid = 0.5 * (kLo + kHi);
      const i0 = Math.min(maxIdx, Math.floor(kMid));
      const i1 = Math.min(maxIdx, i0 + 1);
      const frac = kMid - i0;
      const v0 = fftBytes[i0] / 255;
      const v1 = fftBytes[i1] / 255;
      mag = v0 + (v1 - v0) * frac;
    } else {
      const iStart = Math.floor(kLo);
      const iEnd = Math.min(maxIdx, Math.floor(kHi));
      let weightedSq = 0;
      let weightTotal = 0;
      for (let i = iStart; i <= iEnd; i++) {
        const left = Math.max(kLo, i);
        const right = Math.min(kHi, i + 1);
        const w = Math.max(0, right - left);
        if (w > 0) {
          const v = fftBytes[i] / 255;
          weightedSq += v * v * w;
          weightTotal += w;
        }
      }
      mag = weightTotal > 0 ? Math.sqrt(weightedSq / weightTotal) : 0;
    }

    const gated = Math.max(0, (mag - 0.035) / 0.965);
    const emphasis = 1.0 + 0.34 * (b / 31);
    const val = Math.min(1, gated * emphasis);
    out32[b] = val;
    energySum += val * val;
  }

  return Math.min(1, Math.sqrt(energySum / ECHO_BARK_BIN_COUNT) * 1.35);
}

/** Classifies phoneme cluster at utterance boundary for speechSynthesis fallback. */
export function classifySpeechBoundaryPhoneme(text: string, charIndex: number): EchoPhonemeClass {
  if (!text || charIndex < 0 || charIndex >= text.length) return 'silence';
  const slice = text.slice(charIndex, charIndex + 6).trimStart().toLowerCase();
  if (!slice) return 'silence';

  if (/^(?:sh|ch|th|ph|kh|tr|gi|[sxzfvx])/.test(slice)) {
    return 'sibilant';
  }
  if (/^(?:ng|nh|[mnlr])/.test(slice)) {
    return 'nasal';
  }
  if (/^[pbtdđkgcq]/.test(slice)) {
    return 'plosive';
  }
  if (/^[iyeêíìỉĩịýỳỷỹỵéèẻẽẹếềểễệ]/.test(slice)) {
    return 'front_vowel';
  }
  if (/^[aăâoôơuưáàảãạắằẳẵặấầẩẫậóòỏõọốồổỗộớờởỡợúùủũụứừửữựw]/.test(slice)) {
    return 'open_vowel';
  }
  const nucleus = slice.slice(1, 4);
  if (/[iyeêíìỉĩịéèẻẽẹếềểễệ]/.test(nucleus)) return 'front_vowel';
  if (/[aăâoôơuưáàảãạóòỏõọúùủũụ]/.test(nucleus)) return 'open_vowel';
  return 'open_vowel';
}

function writePhonemeTargetSpectrum(
  phoneme: EchoPhonemeClass,
  envelope: number,
  out32: Float32Array,
): number {
  out32.fill(0);
  if (phoneme === 'silence' || envelope <= 0.001) return 0;

  if (phoneme === 'open_vowel') {
    for (let i = 0; i <= 5; i++) out32[i] = 0.72 * envelope;
    for (let i = 6; i <= 13; i++) out32[i] = 0.88 * envelope;
    for (let i = 14; i <= 19; i++) out32[i] = 0.56 * envelope;
    for (let i = 20; i <= 25; i++) out32[i] = 0.22 * envelope;
    return 0.78 * envelope;
  }
  if (phoneme === 'front_vowel') {
    for (let i = 0; i <= 5; i++) out32[i] = 0.68 * envelope;
    for (let i = 6; i <= 9; i++) out32[i] = 0.52 * envelope;
    for (let i = 17; i <= 24; i++) out32[i] = 0.84 * envelope;
    for (let i = 25; i <= 29; i++) out32[i] = 0.34 * envelope;
    return 0.72 * envelope;
  }
  if (phoneme === 'sibilant') {
    for (let i = 0; i <= 5; i++) out32[i] = 0.18 * envelope;
    for (let i = 16; i <= 23; i++) out32[i] = 0.42 * envelope;
    for (let i = 24; i <= 31; i++) out32[i] = 0.92 * envelope;
    return 0.58 * envelope;
  }
  if (phoneme === 'plosive') {
    for (let i = 0; i <= 7; i++) out32[i] = 0.66 * envelope;
    for (let i = 18; i <= 30; i++) out32[i] = 0.76 * envelope;
    return 0.74 * envelope;
  }
  for (let i = 0; i <= 6; i++) out32[i] = 0.76 * envelope;
  for (let i = 7; i <= 12; i++) out32[i] = 0.54 * envelope;
  for (let i = 13; i <= 18; i++) out32[i] = 0.26 * envelope;
  return 0.62 * envelope;
}

/**
 * Calibrates normalized RMS [0..1] into speech intensity tier:
 * silence (0) -> whisper (0.20..0.42) -> normal (0.45..0.78) -> energetic (0.80..1.0).
 */
export function classifySpeechIntensityTier(rms: number, dbfs: number): number {
  if (rms <= 0.015 || dbfs < -45.5) return 0;
  // Soft-knee logarithmic loudness curve mapping -44 dBFS -> 0.18, -22 dBFS -> 0.62, -6 dBFS -> 1.0
  const dbNorm = Math.min(1, Math.max(0, (dbfs + 46) / 40));
  const linearBoost = Math.min(1, Math.pow(rms, 0.72));
  return Math.min(1, Math.max(0, 0.52 * dbNorm + 0.48 * linearBoost));
}

// ---------------------------------------------------------------------------
// Singleton Zero-Allocation Acoustic Bridge State
// ---------------------------------------------------------------------------

let micAnalyser: EchoAnalyserLike | null = null;
let ttsAnalyser: EchoAnalyserLike | null = null;

let rawFftBuf: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(1024));
let rawTimeBuf: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(2048));
const targetSpectrum32 = new Float32Array(ECHO_BARK_BIN_COUNT);
const prevSpectrum32 = new Float32Array(ECHO_BARK_BIN_COUNT);
const smoothedSpectrum32 = new Float32Array(ECHO_BARK_BIN_COUNT);

let boundaryPhoneme: EchoPhonemeClass = 'silence';
let boundaryStartMs = -Infinity;
let boundaryDurationMs = 0;
let windowListenersBound = false;

const currentFrame: EchoAcousticFrame = {
  spectrum: smoothedSpectrum32,
  voiceRms: 0,
  voiceDbfs: -60,
  bass: 0,
  mid: 0,
  treble: 0,
  spectralCentroid: 0.45,
  onsetFlux: 0,
  visemeEnergy: 0,
  speechIntensityTier: 0,
  source: 0,
  mode: 'silent',
};

function nowClock(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function ensureWindowBridgeListeners(): void {
  if (windowListenersBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return;
  }
  windowListenersBound = true;
  window.addEventListener('ec:echo-analyser', ((event: Event) => {
    const detail = (event as CustomEvent<{
      channel?: EchoAudioChannel;
      analyser?: EchoAnalyserLike | null;
      /** Legacy alias accepted defensively */
      kind?: EchoAudioChannel;
      node?: EchoAnalyserLike | null;
    }>).detail;
    if (!detail) return;
    const ch = detail.channel ?? detail.kind;
    const node = detail.analyser !== undefined ? detail.analyser : (detail.node ?? null);
    if (ch === 'mic' || ch === 'tts') {
      bindEchoVoiceAnalyser(ch, node);
    }
  }) as EventListener);

  window.addEventListener('ec:echo-speech-boundary', ((event: Event) => {
    const detail = (event as CustomEvent<{ text?: string; charIndex?: number; durationMs?: number }>).detail;
    if (detail && typeof detail.text === 'string') {
      triggerEchoSpeechBoundary(detail.text, detail.charIndex ?? 0, detail.durationMs ?? 155);
    }
  }) as EventListener);
}

// Eagerly bind on client module load so early `ec:echo-analyser` dispatches are never missed
ensureWindowBridgeListeners();

/**
 * Registers a live WebAudio AnalyserNode for 'mic' (Listening) or 'tts' (Speaking).
 * Returns an idempotent unbind function. Never creates or owns AudioContext nodes.
 */
export function bindEchoVoiceAnalyser(
  channel: EchoAudioChannel,
  node: EchoAnalyserLike | null,
): () => void {
  ensureWindowBridgeListeners();
  if (channel === 'mic') {
    micAnalyser = node;
    return () => {
      if (micAnalyser === node) micAnalyser = null;
    };
  }
  ttsAnalyser = node;
  return () => {
    if (ttsAnalyser === node) ttsAnalyser = null;
  };
}

export function getBoundEchoVoiceAnalyser(channel: EchoAudioChannel): EchoAnalyserLike | null {
  return channel === 'mic' ? micAnalyser : ttsAnalyser;
}

/**
 * Triggers a syllable/word phoneme impulse from SpeechSynthesisUtterance.onboundary
 * when device speechSynthesis fallback is used without a WebAudio AnalyserNode.
 */
export function triggerEchoSpeechBoundary(
  text: string,
  charIndex: number,
  durationMs = 155,
  nowMs = nowClock(),
): EchoPhonemeClass {
  ensureWindowBridgeListeners();
  boundaryPhoneme = classifySpeechBoundaryPhoneme(text, charIndex);
  boundaryStartMs = nowMs;
  boundaryDurationMs = Math.max(45, Math.min(480, durationMs));
  return boundaryPhoneme;
}

export function clearEchoSpeechBoundary(): void {
  boundaryPhoneme = 'silence';
  boundaryDurationMs = 0;
}

export function resetEchoAcousticBridge(): void {
  micAnalyser = null;
  ttsAnalyser = null;
  clearEchoSpeechBoundary();
  targetSpectrum32.fill(0);
  prevSpectrum32.fill(0);
  smoothedSpectrum32.fill(0);
  currentFrame.voiceRms = 0;
  currentFrame.voiceDbfs = -60;
  currentFrame.bass = 0;
  currentFrame.mid = 0;
  currentFrame.treble = 0;
  currentFrame.spectralCentroid = 0.45;
  currentFrame.onsetFlux = 0;
  currentFrame.visemeEnergy = 0;
  currentFrame.speechIntensityTier = 0;
  currentFrame.source = 0;
  currentFrame.mode = 'silent';
}

function isAnalyserRunning(node: EchoAnalyserLike | null): node is EchoAnalyserLike {
  if (!node) return false;
  const ctxState = node.context?.state;
  if (ctxState && ctxState !== 'running') return false;
  return node.frequencyBinCount > 0 && node.fftSize > 0;
}

function sampleAnalyserIntoTarget(node: EchoAnalyserLike): { rms: number; dbfs: number } {
  const freqCount = node.frequencyBinCount;
  if (rawFftBuf.length < freqCount) {
    rawFftBuf = new Uint8Array(new ArrayBuffer(freqCount));
  }
  const freqView = rawFftBuf.length === freqCount ? rawFftBuf : rawFftBuf.subarray(0, freqCount);
  node.getByteFrequencyData(freqView);

  const sampleRate = node.context?.sampleRate ?? 48000;
  const spectralRms = mapFftToBark32(freqView, sampleRate, node.fftSize, targetSpectrum32);

  if (typeof node.getByteTimeDomainData === 'function') {
    const timeCount = node.fftSize;
    if (rawTimeBuf.length < timeCount) {
      rawTimeBuf = new Uint8Array(new ArrayBuffer(timeCount));
    }
    const timeView = rawTimeBuf.length === timeCount ? rawTimeBuf : rawTimeBuf.subarray(0, timeCount);
    node.getByteTimeDomainData(timeView);
    let sq = 0;
    for (let i = 0; i < timeCount; i++) {
      const centered = (timeView[i] - 128) / 128;
      sq += centered * centered;
    }
    const rawTimeRms = Math.sqrt(sq / timeCount);
    const timeRms = Math.min(1, rawTimeRms * 3.1);
    const rms = Math.max(timeRms, spectralRms * 0.85);
    const dbfs = rawTimeRms > 1e-4 ? Math.max(-60, Math.min(0, 20 * Math.log10(rawTimeRms))) : (spectralRms > 0.01 ? Math.max(-52, 20 * Math.log10(spectralRms)) : -60);
    return { rms, dbfs };
  }

  const dbfs = spectralRms > 1e-4 ? Math.max(-60, Math.min(0, 20 * Math.log10(spectralRms))) : -60;
  return { rms: spectralRms, dbfs };
}

/**
 * Samples live acoustic energy for the current animation frame with 0 heap allocations.
 */
export function sampleEchoAcousticFrame(
  preferredState: EchoEntityState,
  dtSec: number,
  nowMs = nowClock(),
): EchoAcousticFrame {
  ensureWindowBridgeListeners();
  const hidden = typeof document !== 'undefined' && document.hidden === true;

  let rawRms = 0;
  let rawDbfs = -60;
  let activeMode: EchoAcousticFrame['mode'] = 'silent';
  let activeSource = 0;

  if (!hidden && preferredState !== 'disabled' && preferredState !== 'dormant') {
    const mic = micAnalyser;
    const tts = ttsAnalyser;
    const micReady = isAnalyserRunning(mic);
    const ttsReady = isAnalyserRunning(tts);
    const boundaryElapsed = nowMs - boundaryStartMs;
    const boundaryActive = boundaryPhoneme !== 'silence' && boundaryElapsed >= 0 && boundaryElapsed <= boundaryDurationMs;

    if (preferredState === 'listening' && micReady) {
      const sampled = sampleAnalyserIntoTarget(mic);
      rawRms = sampled.rms;
      rawDbfs = sampled.dbfs;
      activeMode = 'mic';
      activeSource = -1;
    } else if (preferredState === 'speaking' && ttsReady) {
      const sampled = sampleAnalyserIntoTarget(tts);
      rawRms = sampled.rms;
      rawDbfs = sampled.dbfs;
      activeMode = 'tts';
      activeSource = 1;
    } else if (preferredState === 'speaking' && boundaryActive) {
      const phase = boundaryElapsed / boundaryDurationMs;
      const env = Math.sin(Math.PI * Math.min(1, Math.max(0, phase)));
      rawRms = writePhonemeTargetSpectrum(boundaryPhoneme, env, targetSpectrum32);
      rawDbfs = rawRms > 1e-4 ? Math.max(-54, 20 * Math.log10(rawRms)) : -60;
      activeMode = 'boundary';
      activeSource = 1;
    } else if (ttsReady && preferredState !== 'listening') {
      const sampled = sampleAnalyserIntoTarget(tts);
      if (sampled.rms > 0.015) {
        rawRms = sampled.rms;
        rawDbfs = sampled.dbfs;
        activeMode = 'tts';
        activeSource = 1;
      }
    } else if (micReady) {
      const sampled = sampleAnalyserIntoTarget(mic);
      if (sampled.rms > 0.015) {
        rawRms = sampled.rms;
        rawDbfs = sampled.dbfs;
        activeMode = 'mic';
        activeSource = -1;
      }
    } else if (boundaryActive) {
      const phase = boundaryElapsed / boundaryDurationMs;
      const env = Math.sin(Math.PI * Math.min(1, Math.max(0, phase)));
      rawRms = writePhonemeTargetSpectrum(boundaryPhoneme, env, targetSpectrum32);
      rawDbfs = rawRms > 1e-4 ? Math.max(-54, 20 * Math.log10(rawRms)) : -60;
      activeMode = 'boundary';
      activeSource = 1;
    }
  }

  if (activeMode === 'silent') {
    targetSpectrum32.fill(0);
    rawRms = 0;
    rawDbfs = -60;
  }

  const safeDt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 1 / 60;
  currentFrame.voiceRms = stepAsymmetricEnvelope(currentFrame.voiceRms, rawRms, safeDt);
  currentFrame.voiceDbfs = stepAsymmetricEnvelope(currentFrame.voiceDbfs, rawDbfs, safeDt, 0.015, 0.12);

  let bassSum = 0;
  let midSum = 0;
  let trebleSum = 0;
  let f1Sum = 0;
  let f2Sum = 0;
  let weightedBinSum = 0;
  let totalMagSum = 0;
  let posFluxSum = 0;

  for (let b = 0; b < ECHO_BARK_BIN_COUNT; b++) {
    const targetVal = targetSpectrum32[b];
    const diff = targetVal - prevSpectrum32[b];
    if (diff > 0) posFluxSum += diff;
    prevSpectrum32[b] = targetVal;

    const nextVal = stepAsymmetricEnvelope(smoothedSpectrum32[b], targetVal, safeDt);
    smoothedSpectrum32[b] = nextVal;

    if (b <= 5) bassSum += nextVal;
    else if (b <= 23) midSum += nextVal;
    else trebleSum += nextVal;

    if (b >= 6 && b <= 13) f1Sum += nextVal;
    if (b >= 14 && b <= 23) f2Sum += nextVal;

    weightedBinSum += b * nextVal;
    totalMagSum += nextVal;
  }

  currentFrame.bass = bassSum / 6;
  currentFrame.mid = midSum / 18;
  currentFrame.treble = trebleSum / 8;

  const targetCentroid = totalMagSum > 0.04 ? weightedBinSum / (totalMagSum * 31) : 0.45;
  currentFrame.spectralCentroid = stepAsymmetricEnvelope(currentFrame.spectralCentroid, targetCentroid, safeDt, 0.03, 0.14);

  const rawFlux = Math.min(1, posFluxSum / 4.2);
  currentFrame.onsetFlux = stepAsymmetricEnvelope(currentFrame.onsetFlux, rawFlux, safeDt, 0.008, 0.09);

  const rawViseme = Math.min(1, 0.6 * (f1Sum / 8) + 0.4 * (f2Sum / 10));
  currentFrame.visemeEnergy = stepAsymmetricEnvelope(currentFrame.visemeEnergy, rawViseme, safeDt, 0.012, 0.08);

  const targetTier = classifySpeechIntensityTier(currentFrame.voiceRms, currentFrame.voiceDbfs);
  currentFrame.speechIntensityTier = stepAsymmetricEnvelope(currentFrame.speechIntensityTier, targetTier, safeDt, 0.04, 0.16);

  currentFrame.source = activeSource;
  currentFrame.mode = activeMode;
  return currentFrame;
}
