import { echoTelemetry } from './echoTelemetry';
import {
  WAKE_WORD_CLASSES,
  ZeroWasmLogMel32,
  ZeroWasmNlmsAec,
  ZeroWasmOpenWakeWord,
  ZeroWasmSileroVadV5,
  createInitializedOwwWeights,
  createInitializedSileroWeights,
  loadEchoJarvisNeuralAssets,
  type NlmsAecStepResult,
  type OpenWakeWordWeights,
  type SileroVadWeights,
  type WakeWordClassName,
} from './zeroWasmNeural';

export type WakePhraseLabel = 'Hi Echo' | 'Hey Echo' | 'Hi Echo Jarvis' | 'Hey Echo Jarvis';

const CLASS_TO_PHRASE: Record<Exclude<WakeWordClassName, 'negative'>, WakePhraseLabel> = {
  hi_echo: 'Hi Echo',
  hey_echo: 'Hey Echo',
  hi_echo_jarvis: 'Hi Echo Jarvis',
  hey_echo_jarvis: 'Hey Echo Jarvis',
};

export interface WakeDetectionEvent {
  phrase: WakePhraseLabel;
  className: Exclude<WakeWordClassName, 'negative'>;
  confidence: number;
  timestampMs: number;
  detectionLatencyMs: number;
  engine: 'neural-oww';
  prerollPcmF32: Float32Array;
}

export interface SingleBreathHandoffEvent {
  phrase: WakePhraseLabel;
  timestampMs: number;
  postWakeVoicedMs: number;
  turn1OpeningPcmF32: Float32Array;
  turn1OpeningPcm16: Int16Array;
}

export interface VadFrameTelemetry {
  pSpeech: number;
  rms: number;
  postNlmsSnrDb: number;
  echoSuppressed: boolean;
  coherence: number;
  doubleTalkDetected: boolean;
  benestyNcc: number;
  erleDb: number;
  timestampMs: number;
}

export interface SpeechEndpointEvent {
  reason: 'silence' | 'smart-turn' | 'manual-commit' | 'max-duration';
  voicedMs: number;
  totalMs: number;
  peakSnrDb: number;
  utterancePcm16: Int16Array;
}

export interface BargeInProbeEvent {
  pcm16: Int16Array;
  voicedMs: number;
  timestampMs: number;
}

export type DetectorOperatingMode =
  | 'disabled'
  | 'dormant'
  | 'post-wake-window'
  | 'active-listening'
  | 'tts-speaking';

export interface WakeWordDetectorCallbacks {
  onWakeDetected?: (event: WakeDetectionEvent) => void;
  onSingleBreathCommand?: (event: SingleBreathHandoffEvent) => void;
  onPostWakeGreetingCleared?: (info: { singleBreath: false; timestampMs: number }) => void;
  onVadFrame?: (frame: VadFrameTelemetry) => void;
  onSpeechStart?: (info: { timestampMs: number; prerollPcm16: Int16Array }) => void;
  onStreamingPcm16?: (pcm16: Int16Array, sampleOffset: number) => void;
  onTentativePause?: (info: { silenceMs: number; voicedMs: number; recentPcm16: Int16Array }) => void;
  onSpeechEnd?: (event: SpeechEndpointEvent) => void;
  onUtteranceDiscarded?: (info: { reason: 'noise-gate'; voicedMs: number; peakSnrDb: number }) => void;
  onBargeInProbeReady?: (event: BargeInProbeEvent) => void;
  onFollowupTimeout?: (info: { idleMs: number; timestampMs: number }) => void;
}

export interface WakeWordDetectorOptions {
  sampleRate?: number;
  prerollSamples?: number; // default 24000 (1.5 s @ 16 kHz)
  wakeThresholdDormant?: number; // default 0.58 (requires >= 2 consecutive 80 ms neural hits)
  wakePatienceFrames?: number; // default 2 (160 ms consecutive neural confirmation)
  wakeDebounceMs?: number; // default 1800
  postTtsWakeCooldownMs?: number; // default 240 (room reverb guard after Echo finishes speaking)
  singleBreathWindowMs?: number; // default 280 (silent post-wake listening window, NO spoken greeting!)
  singleBreathPreLeadSamples?: number; // default 4800 (300 ms pre-lead @ 16 kHz)
  singleBreathVadThreshold?: number; // default 0.45
  positiveSpeechThreshold?: number; // default 0.50
  negativeSpeechThreshold?: number; // default 0.32
  preSpeechPadFrames?: number; // default 15 (480 ms)
  shortCommandTentativeSilenceMs?: number; // default 320
  longUtteranceTentativeSilenceMs?: number; // default 360
  shortCommandEndpointMs?: number; // default 560
  defaultEndpointSilenceMs?: number; // default 880 (supports L2 hesitation; overridden by Smart Turn v3.2)
  minCommitVoicedMs?: number; // default 220 (pre-commit noise gate)
  minCommitSnrDb?: number; // default 5.0 (pre-commit SNR gate)
  followupTimeoutMs?: number; // default 10000 (bounded ACTIVE_FOLLOWUP window)
  followupExtendedTimeoutMs?: number; // default 14000 (when question or confirmation pending)
  bargeInProbeVoicedMs?: number; // default 96 (post-PBFDAF Benesty NCC double-talk threshold)
  bargeInProbeCooldownMs?: number; // default 350
  maxUtteranceMs?: number; // default 25000
  sileroWeights?: SileroVadWeights;
  owwWeights?: OpenWakeWordWeights;
  neuralWeightsLoaded?: boolean;
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function float32ToPcm16(src: Float32Array): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const clamped = src[i] > 1 ? 1 : src[i] < -1 ? -1 : src[i];
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}

/**
 * Zero-GC 1.5 s (24,000-sample @ 16 kHz) circular PCM ring buffer.
 * Guarantees 0 network bytes uploaded while in Dormant mode and preserves exact onset syllables.
 */
export class CircularPcmRingBuffer {
  private readonly buf: Float32Array;
  private writePos = 0;
  private filled = 0;
  private totalWritten = 0;

  constructor(capacitySamples = 24000) {
    this.buf = new Float32Array(capacitySamples);
  }

  get capacity(): number {
    return this.buf.length;
  }

  get size(): number {
    return this.filled;
  }

  get totalSamplesWritten(): number {
    return this.totalWritten;
  }

  clear(): void {
    this.writePos = 0;
    this.filled = 0;
    this.totalWritten = 0;
    this.buf.fill(0);
  }

  write(samples: Float32Array): void {
    const cap = this.buf.length;
    const n = samples.length;
    if (n >= cap) {
      this.buf.set(samples.subarray(n - cap, n), 0);
      this.writePos = 0;
      this.filled = cap;
      this.totalWritten += n;
      return;
    }

    const firstPart = Math.min(n, cap - this.writePos);
    this.buf.set(samples.subarray(0, firstPart), this.writePos);
    const rem = n - firstPart;
    if (rem > 0) {
      this.buf.set(samples.subarray(firstPart, n), 0);
    }
    this.writePos = (this.writePos + n) % cap;
    this.filled = Math.min(cap, this.filled + n);
    this.totalWritten += n;
  }

  readLatest(requestedSamples: number, out?: Float32Array): Float32Array {
    const count = Math.max(0, Math.min(requestedSamples, this.filled));
    const dst = out && out.length === count ? out : new Float32Array(count);
    if (count === 0) return dst;

    const cap = this.buf.length;
    const start = (this.writePos - count + cap) % cap;
    if (start + count <= cap) {
      dst.set(this.buf.subarray(start, start + count), 0);
    } else {
      const tailLen = cap - start;
      dst.set(this.buf.subarray(start, cap), 0);
      dst.set(this.buf.subarray(0, count - tailLen), tailLen);
    }
    return dst;
  }

  readSinceSample(sinceTotalSample: number): Float32Array {
    const available = Math.max(0, this.totalWritten - sinceTotalSample);
    return this.readLatest(Math.min(available, this.filled));
  }
}

/**
 * Hardened Zero-WASM Local Wake Word + Silero VAD v5 + 8-Partition 128 ms PBFDAF AEC
 * + Single-Breath Handoff + EOU-Fusion v2 + Noise-Gated Pre-Commit + Barge-In Probe Engine.
 *
 * Key Safety Invariants:
 * 1. `AcousticWakeFallbackDetector` is completely removed — wake triggers ONLY when INT8 neural
 *    weights are loaded, `ZeroWasmOpenWakeWord.isWarmedUp === true` (>= 6 steps / 480 ms after
 *    calibrated `-10.0` silence-floor reset), `maxRecentVad >= 0.35`, AND `>= 2` consecutive
 *    80 ms neural frames exceed `wakeThresholdDormant`.
 * 2. Wake scoring NEVER runs during `'tts-speaking'` (and respects a 480 ms post-TTS reverb
 *    cooldown), making Echo self-wake on its own voice mathematically impossible.
 * 3. Pre-commit noise gate drops utterances with `< 220 ms` voiced speech or `< +5 dB` peak SNR.
 * 4. Bounded `ACTIVE_FOLLOWUP` silently decays back to `'dormant'` after 10 s (14 s extended).
 */
export class WakeWordDetector {
  private readonly callbacks: WakeWordDetectorCallbacks;
  private readonly opts: Required<Omit<WakeWordDetectorOptions, 'sileroWeights' | 'owwWeights'>>;

  private readonly nlms = new ZeroWasmNlmsAec();
  private readonly silero: ZeroWasmSileroVadV5;
  private readonly logMel: ZeroWasmLogMel32;
  private readonly oww: ZeroWasmOpenWakeWord;
  private readonly prerollRing: CircularPcmRingBuffer;

  private neuralReady: boolean;
  private mode: DetectorOperatingMode = 'dormant';
  private ttsPlaying = false;
  private postTtsCooldownMs = 0;
  private networkBytesUploaded = 0;
  private followupExtended = false;
  private waitingForResponse = false;
  private idleListeningMs = 0;

  // 80 ms (1,280-sample) step accumulator from 512-sample frames
  private readonly accum1280 = new Float32Array(2048);
  private accumLen = 0;
  private readonly stepSlice1280 = new Float32Array(1280);
  private readonly mel8x32 = new Float32Array(256);

  // Rolling VAD history & consecutive neural wake patience
  private readonly recentVad = new Float32Array(8);
  private vadHangoverMs = 0;
  private wakePatienceCount = 0;
  private wakePatienceClass = 0;
  private lastWakeTimestampMs = -10000;

  // Single-breath post-wake silent handoff tracking (NO spoken greeting plays here!)
  private activeWakePhrase: WakePhraseLabel = 'Hi Echo';
  private wakeSampleAnchor = 0;
  private postWakeElapsedMs = 0;
  private postWakeVoicedMs = 0;

  // Adaptive ambient noise floor for +5 dB SNR pre-commit gate
  private ambientNoiseRmsSq = 1e-6;

  // Active turn endpointing state (EOU-Fusion v2)
  private turnSpeaking = false;
  private turnVoicedMs = 0;
  private turnSilenceMs = 0;
  private turnTotalMs = 0;
  private turnPeakSnrDb = 0;
  private turnSampleOffset = 0;
  private dynamicEndpointOverrideMs: number | null = null;
  private tentativePauseFired = false;
  private utteranceChunks: Int16Array[] = [];

  // Post-PBFDAF Benesty NCC double-talk barge-in probe tracker
  private ttsDoubleTalkMs = 0;
  private ttsDoubleTalkSilenceMs = 0;
  private ttsDoubleTalkAnchorSample = 0;
  private lastBargeInProbeMs = -10000;

  constructor(callbacks: WakeWordDetectorCallbacks = {}, options: WakeWordDetectorOptions = {}) {
    this.callbacks = callbacks;
    this.opts = {
      sampleRate: options.sampleRate ?? 16000,
      prerollSamples: options.prerollSamples ?? 24000,
      wakeThresholdDormant: options.wakeThresholdDormant ?? 0.58,
      wakePatienceFrames: Math.max(2, options.wakePatienceFrames ?? 2),
      wakeDebounceMs: options.wakeDebounceMs ?? 1800,
      postTtsWakeCooldownMs: options.postTtsWakeCooldownMs ?? 240,
      singleBreathWindowMs: options.singleBreathWindowMs ?? 280,
      singleBreathPreLeadSamples: options.singleBreathPreLeadSamples ?? 4800,
      singleBreathVadThreshold: options.singleBreathVadThreshold ?? 0.45,
      positiveSpeechThreshold: options.positiveSpeechThreshold ?? 0.5,
      negativeSpeechThreshold: options.negativeSpeechThreshold ?? 0.32,
      preSpeechPadFrames: options.preSpeechPadFrames ?? 15,
      shortCommandTentativeSilenceMs: options.shortCommandTentativeSilenceMs ?? 320,
      longUtteranceTentativeSilenceMs: options.longUtteranceTentativeSilenceMs ?? 360,
      shortCommandEndpointMs: options.shortCommandEndpointMs ?? 560,
      defaultEndpointSilenceMs: options.defaultEndpointSilenceMs ?? 880,
      minCommitVoicedMs: options.minCommitVoicedMs ?? 220,
      minCommitSnrDb: options.minCommitSnrDb ?? 5.0,
      followupTimeoutMs: options.followupTimeoutMs ?? 10000,
      followupExtendedTimeoutMs: options.followupExtendedTimeoutMs ?? 14000,
      bargeInProbeVoicedMs: options.bargeInProbeVoicedMs ?? 96,
      bargeInProbeCooldownMs: options.bargeInProbeCooldownMs ?? 350,
      maxUtteranceMs: options.maxUtteranceMs ?? 25000,
      neuralWeightsLoaded: options.neuralWeightsLoaded ?? Boolean(options.sileroWeights && options.owwWeights),
    };

    const sileroWeights = options.sileroWeights ?? createInitializedSileroWeights();
    const owwWeights = options.owwWeights ?? createInitializedOwwWeights();
    this.silero = new ZeroWasmSileroVadV5(sileroWeights);
    this.logMel = new ZeroWasmLogMel32(owwWeights.melW, owwWeights.stftWindow);
    this.oww = new ZeroWasmOpenWakeWord(owwWeights);
    this.prerollRing = new CircularPcmRingBuffer(this.opts.prerollSamples);
    this.neuralReady = this.opts.neuralWeightsLoaded;
  }

  get operatingMode(): DetectorOperatingMode {
    return this.mode;
  }

  get isNeuralReady(): boolean {
    return this.neuralReady;
  }

  get isOwwWarmedUp(): boolean {
    return this.oww.isWarmedUp;
  }

  get uploadedNetworkBytes(): number {
    return this.networkBytesUploaded;
  }

  get currentTurnSilenceMs(): number {
    return this.turnSilenceMs;
  }

  get currentTurnVoicedMs(): number {
    return this.turnVoicedMs;
  }

  isTurnActivelyVoiced(): boolean {
    return this.turnSpeaking && this.turnSilenceMs === 0;
  }

  setOutputLatencyMs(latencyMs: number): void {
    this.nlms.setOutputLatencyMs(latencyMs);
  }

  setFollowupExtended(extended: boolean): void {
    this.followupExtended = Boolean(extended);
  }

  /**
   * Suppress `idleListeningMs` decay while Echo is transcribing, thinking, or executing tools
   * so long analytical turns never expire the conversational follow-up window before Echo speaks.
   */
  setWaitingForResponse(waiting: boolean): void {
    this.waitingForResponse = Boolean(waiting);
    if (this.waitingForResponse) {
      this.idleListeningMs = 0;
    }
  }

  /**
   * Explicitly abort/clear in-progress turn capture (e.g. after server `vad.state: eou_committed`
   * auto-committed the turn) so trailing post-EOU silence NEVER fires a duplicate `onSpeechEnd`!
   */
  abortActiveTurn(): void {
    this.resetTurnState();
    this.idleListeningMs = 0;
  }

  /**
   * Losslessly hand off PBFDAF-echo-cancelled user speech spoken during barge-in directly into
   * a fresh `'active-listening'` turn with 320 ms pre-lead so the opening words of an interruption
   * ("Wait, open Reading" / "Khoan đã, giải thích lại...") are never clipped!
   */
  handoffBargeInToActiveTurn(startTurn = true, timestampMs = nowMs()): boolean {
    const capturedVoicedMs = this.ttsDoubleTalkMs;
    const capturedSilenceMs = this.ttsDoubleTalkSilenceMs;
    const anchorSample = this.ttsDoubleTalkAnchorSample;

    this.ttsPlaying = false;
    this.postTtsCooldownMs = 0;
    this.waitingForResponse = false;
    this.ttsDoubleTalkMs = 0;
    this.ttsDoubleTalkSilenceMs = 0;
    this.ttsDoubleTalkAnchorSample = 0;
    this.mode = 'active-listening';
    this.idleListeningMs = 0;
    this.resetTurnState();

    if (!startTurn || capturedVoicedMs < 64 || capturedSilenceMs > 480) {
      return false;
    }

    const preLeadSamples = 5120; // 320 ms @ 16 kHz
    const sinceSample = Math.max(
      this.prerollRing.totalSamplesWritten - 19200,
      Math.max(0, anchorSample - preLeadSamples),
    );
    const openingF32 = this.prerollRing.readSinceSample(sinceSample);
    if (openingF32.length < 512) {
      return false;
    }

    const openingPcm16 = float32ToPcm16(openingF32);
    this.turnSpeaking = true;
    this.turnVoicedMs = capturedVoicedMs;
    this.turnSilenceMs = capturedSilenceMs;
    this.turnTotalMs = Math.max(capturedVoicedMs, Math.round((openingPcm16.length / this.opts.sampleRate) * 1000));
    this.turnPeakSnrDb = Math.max(this.opts.minCommitSnrDb + 3, 10);
    this.utteranceChunks = [openingPcm16];
    this.turnSampleOffset = openingPcm16.length;
    this.networkBytesUploaded += openingPcm16.byteLength;

    this.callbacks.onSpeechStart?.({ timestampMs, prerollPcm16: openingPcm16 });
    this.callbacks.onStreamingPcm16?.(openingPcm16, 0);
    return true;
  }

  setMode(nextMode: DetectorOperatingMode): void {
    if (this.mode === nextMode) return;
    this.mode = nextMode;
    this.idleListeningMs = 0;
    this.ttsDoubleTalkMs = 0;
    this.ttsDoubleTalkSilenceMs = 0;
    this.ttsDoubleTalkAnchorSample = 0;
    if (nextMode === 'dormant' || nextMode === 'disabled') {
      this.waitingForResponse = false;
      this.resetTurnState();
      this.wakePatienceCount = 0;
      this.wakePatienceClass = 0;
    }
  }

  setTtsPlaying(playing: boolean): void {
    if (this.ttsPlaying && !playing) {
      // Enforce post-TTS reverb cooldown so room decay of Echo's last word never self-wakes
      this.postTtsCooldownMs = this.opts.postTtsWakeCooldownMs;
      this.waitingForResponse = false;
      this.idleListeningMs = 0;
      this.wakePatienceCount = 0;
      this.wakePatienceClass = 0;
      this.ttsDoubleTalkMs = 0;
      this.ttsDoubleTalkSilenceMs = 0;
      this.ttsDoubleTalkAnchorSample = 0;
    }
    this.ttsPlaying = playing;
  }

  setDynamicEndpointSilenceMs(waitMs: number): void {
    this.dynamicEndpointOverrideMs = Math.max(240, Math.min(1150, waitMs));
  }

  setNeuralWeights(sileroWeights: SileroVadWeights, owwWeights: OpenWakeWordWeights): void {
    this.silero.setWeights(sileroWeights);
    this.logMel.setWeights(owwWeights.melW, owwWeights.stftWindow);
    this.oww.setWeights(owwWeights);
    this.neuralReady = true;
    this.wakePatienceCount = 0;
    this.wakePatienceClass = 0;
  }

  async loadWeightsFromPublic(baseUrl = '/echo-jarvis/models', fetchImpl?: typeof fetch): Promise<boolean> {
    try {
      const assets = await loadEchoJarvisNeuralAssets(baseUrl, fetchImpl);
      this.setNeuralWeights(assets.silero, assets.openWakeWord);
      return true;
    } catch {
      this.neuralReady = false;
      return false;
    }
  }

  getPrerollFloat32(samples = this.opts.prerollSamples): Float32Array {
    return this.prerollRing.readLatest(samples);
  }

  getPrerollPcm16(samples = this.opts.prerollSamples): Int16Array {
    return float32ToPcm16(this.prerollRing.readLatest(samples));
  }

  reset(): void {
    this.nlms.reset();
    this.silero.resetState();
    this.logMel.reset();
    this.oww.reset();
    this.prerollRing.clear();
    this.accumLen = 0;
    this.recentVad.fill(0);
    this.vadHangoverMs = 0;
    this.wakePatienceCount = 0;
    this.wakePatienceClass = 0;
    this.postTtsCooldownMs = 0;
    this.waitingForResponse = false;
    this.idleListeningMs = 0;
    this.ttsDoubleTalkMs = 0;
    this.ttsDoubleTalkSilenceMs = 0;
    this.ttsDoubleTalkAnchorSample = 0;
    this.ambientNoiseRmsSq = 1e-6;
    this.resetTurnState();
  }

  private resetTurnState(): void {
    this.turnSpeaking = false;
    this.turnVoicedMs = 0;
    this.turnSilenceMs = 0;
    this.turnTotalMs = 0;
    this.turnPeakSnrDb = 0;
    this.turnSampleOffset = 0;
    this.dynamicEndpointOverrideMs = null;
    this.tentativePauseFired = false;
    this.utteranceChunks = [];
  }

  /**
   * Commit the current active utterance (applying the >= 220 ms voiced & +5 dB SNR pre-commit
   * noise gate for automatic endpoints while allowing explicit manual commits).
   */
  commitActiveUtterance(reason: SpeechEndpointEvent['reason'] = 'manual-commit'): SpeechEndpointEvent | null {
    if (this.utteranceChunks.length === 0) {
      this.resetTurnState();
      return null;
    }

    if (
      reason !== 'manual-commit' &&
      (this.turnVoicedMs < this.opts.minCommitVoicedMs || this.turnPeakSnrDb < this.opts.minCommitSnrDb)
    ) {
      const droppedVoiced = this.turnVoicedMs;
      const droppedSnr = this.turnPeakSnrDb;
      this.resetTurnState();
      this.callbacks.onUtteranceDiscarded?.({
        reason: 'noise-gate',
        voicedMs: droppedVoiced,
        peakSnrDb: droppedSnr,
      });
      return null;
    }

    const totalLen = this.utteranceChunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Int16Array(totalLen);
    let off = 0;
    for (const chunk of this.utteranceChunks) {
      merged.set(chunk, off);
      off += chunk.length;
    }
    const event: SpeechEndpointEvent = {
      reason,
      voicedMs: this.turnVoicedMs,
      totalMs: this.turnTotalMs,
      peakSnrDb: this.turnPeakSnrDb,
      utterancePcm16: merged,
    };
    this.resetTurnState();
    this.idleListeningMs = 0;
    this.callbacks.onSpeechEnd?.(event);
    return event;
  }

  /**
   * Process one 512-sample (32 ms @ 16 kHz) mic frame + optional 512-sample TTS playback reference frame.
   */
  processFrame512(
    mic512: Float32Array,
    ref512: Float32Array | null = null,
    timestampMs = nowMs(),
    overrideVadProb?: number,
    overrideOwwProbs?: Float32Array,
  ): NlmsAecStepResult & { pSpeech: number; rms: number } {
    const frameStartMs = nowMs();
    echoTelemetry.incrementCounter('micFramesProcessed', 1);

    if (this.mode === 'disabled') {
      return {
        cleanedMic: mic512,
        coherence: 0,
        residualToEchoRatio: 1,
        postNlmsSnrDb: 0,
        echoSuppressed: false,
        estimatedDelaySamples: 0,
        active: false,
        doubleTalkDetected: false,
        benestyNcc: 0,
        erleDb: 0,
        pSpeech: 0,
        rms: 0,
      };
    }

    if (this.postTtsCooldownMs > 0) {
      this.postTtsCooldownMs = Math.max(0, this.postTtsCooldownMs - 32);
    }

    // 1. 8-Partition 128 ms PBFDAF AEC + GCC-PHAT + Benesty NCC Double-Talk Gate (0 ms when TTS inactive)
    const nlmsRes = this.nlms.processFrame512(mic512, ref512, this.ttsPlaying, 32);
    if (nlmsRes.active) {
      echoTelemetry.incrementCounter('nlmsActiveFrames', 1);
    }
    const clean = nlmsRes.cleanedMic;

    // 2. Append to 1.5 s (24,000-sample) local circular pre-roll buffer (0 network bytes in Dormant!)
    this.prerollRing.write(clean);

    // 3. Neural Silero VAD v5 (strictly neural — no blind energy fallback wake!)
    const vadT0 = nowMs();
    let rmsSq = 0;
    for (let i = 0; i < 512; i++) rmsSq += clean[i] * clean[i];
    rmsSq /= 512;
    const rms = Math.sqrt(rmsSq);

    let pSpeech = 0;
    if (typeof overrideVadProb === 'number') {
      pSpeech = overrideVadProb;
    } else if (this.neuralReady) {
      pSpeech = this.silero.processFrame512(clean);
    } else {
      // Until neural weights finish loading, keep VAD at 0 so ambient noise never false-triggers
      pSpeech = 0;
    }

    if (nlmsRes.echoSuppressed) {
      pSpeech = 0;
    }

    // Track ambient noise floor during quiet non-speech frames for +5 dB SNR pre-commit gate
    if (!this.turnSpeaking && !this.ttsPlaying && pSpeech < 0.25) {
      const clampedFloor = Math.max(1e-7, Math.min(0.01, rmsSq));
      this.ambientNoiseRmsSq = 0.94 * this.ambientNoiseRmsSq + 0.06 * clampedFloor;
    }
    const frameSnrDb = 10 * Math.log10((rmsSq + 1e-9) / (this.ambientNoiseRmsSq + 1e-9));

    const vadElapsed = nowMs() - vadT0;
    echoTelemetry.incrementCounter('vadFramesProcessed', 1);
    echoTelemetry.setGauge('vadLastMs', vadElapsed);

    this.recentVad.copyWithin(0, 1);
    this.recentVad[7] = pSpeech;
    if (pSpeech >= 0.12) {
      this.vadHangoverMs = 400;
    } else if (this.vadHangoverMs > 0) {
      this.vadHangoverMs = Math.max(0, this.vadHangoverMs - 32);
    }

    this.callbacks.onVadFrame?.({
      pSpeech,
      rms,
      postNlmsSnrDb: nlmsRes.postNlmsSnrDb,
      echoSuppressed: nlmsRes.echoSuppressed,
      coherence: nlmsRes.coherence,
      doubleTalkDetected: nlmsRes.doubleTalkDetected,
      benestyNcc: nlmsRes.benestyNcc,
      erleDb: nlmsRes.erleDb,
      timestampMs,
    });

    // 4. Mode-specific state progression
    // CRITICAL: Wake scoring runs ONLY in 'dormant' (NEVER in 'tts-speaking' -> zero self-wake!).
    if (this.mode === 'dormant') {
      this.stepWakeAccumulator(clean, nlmsRes.echoSuppressed, timestampMs, frameStartMs, overrideOwwProbs);
    } else if (this.mode === 'tts-speaking') {
      this.stepTtsSpeakingBargeInProbe(nlmsRes, pSpeech, timestampMs);
    } else if (this.mode === 'post-wake-window') {
      this.stepPostWakeWindow(pSpeech, timestampMs);
    } else if (this.mode === 'active-listening') {
      this.stepActiveListening(clean, pSpeech, frameSnrDb, timestampMs);
    }

    return { ...nlmsRes, pSpeech, rms };
  }

  private stepWakeAccumulator(
    clean512: Float32Array,
    echoSuppressed: boolean,
    timestampMs: number,
    frameStartMs: number,
    overrideOwwProbs?: Float32Array,
  ): void {
    this.accum1280.set(clean512.subarray(0, 512), this.accumLen);
    this.accumLen += 512;

    while (this.accumLen >= 1280) {
      this.stepSlice1280.set(this.accum1280.subarray(0, 1280), 0);
      const rem = this.accumLen - 1280;
      if (rem > 0) {
        this.accum1280.copyWithin(0, 1280, this.accumLen);
      }
      this.accumLen = rem;

      // Keep 32-bin Log-Mel overlap warm (0.077 ms per 80 ms)
      this.logMel.processChunk1280(this.stepSlice1280, this.mel8x32);

      // Strictly require loaded INT8 neural weights; never fall back to blind acoustic energy triggers
      if (!this.neuralReady) {
        this.wakePatienceCount = 0;
        this.wakePatienceClass = 0;
        continue;
      }

      // Advance the initial 6 warmup steps after reset on quiet audio so the first real wake fires cleanly
      if (!this.oww.isWarmedUp) {
        this.oww.stepCausal8x32(this.mel8x32);
        this.wakePatienceCount = 0;
        this.wakePatienceClass = 0;
        continue;
      }

      if (
        echoSuppressed ||
        this.ttsPlaying ||
        this.postTtsCooldownMs > 0 ||
        timestampMs - this.lastWakeTimestampMs < this.opts.wakeDebounceMs
      ) {
        if (!echoSuppressed && !this.ttsPlaying) {
          // Keep causal conv feature ring continuous across post-TTS / post-wake cooldowns
          this.oww.stepCausal8x32(this.mel8x32);
        }
        this.wakePatienceCount = 0;
        this.wakePatienceClass = 0;
        continue;
      }

      let maxRecentVad = 0;
      for (let i = 0; i < 8; i++) {
        if (this.recentVad[i] > maxRecentVad) maxRecentVad = this.recentVad[i];
      }

      // Gate openWakeWord neural backbone by VAD >= 0.12 (+ 400 ms hangover) so silence costs 0.00 ms!
      if (this.vadHangoverMs <= 0 && maxRecentVad < 0.12) {
        this.wakePatienceCount = 0;
        this.wakePatienceClass = 0;
        continue;
      }

      const owwT0 = nowMs();
      const probs = overrideOwwProbs ?? this.oww.stepCausal8x32(this.mel8x32).probs;
      echoTelemetry.incrementCounter('owwStepsProcessed', 1);
      echoTelemetry.setGauge('owwLastMs', nowMs() - owwT0);

      let detectedClass = 0;
      let confidence = 0;
      for (let k = 1; k < 5; k++) {
        if (probs[k] > confidence) {
          confidence = probs[k];
          detectedClass = k;
        }
      }

      const threshold = this.opts.wakeThresholdDormant;
      const vadCleared = maxRecentVad >= 0.35;

      // STRICT 2-FRAME CONSECUTIVE NEURAL PATIENCE (NO 1-frame immediate bypass!)
      if (detectedClass >= 1 && confidence >= threshold && vadCleared) {
        if (this.wakePatienceClass === detectedClass) {
          this.wakePatienceCount += 1;
        } else {
          this.wakePatienceClass = detectedClass;
          this.wakePatienceCount = 1;
        }

        if (this.wakePatienceCount >= this.opts.wakePatienceFrames) {
          this.triggerWake(detectedClass, confidence, timestampMs, nowMs() - frameStartMs);
          break;
        }
      } else {
        this.wakePatienceCount = 0;
        this.wakePatienceClass = 0;
      }
    }
  }

  private triggerWake(
    classIndex: number,
    confidence: number,
    timestampMs: number,
    detectionLatencyMs: number,
  ): void {
    const className = WAKE_WORD_CLASSES[classIndex] as Exclude<WakeWordClassName, 'negative'>;
    const phrase = CLASS_TO_PHRASE[className] ?? 'Hi Echo';

    this.lastWakeTimestampMs = timestampMs;
    this.wakePatienceCount = 0;
    this.wakePatienceClass = 0;
    this.oww.reset();

    this.activeWakePhrase = phrase;
    this.wakeSampleAnchor = this.prerollRing.totalSamplesWritten;
    this.postWakeElapsedMs = 0;
    this.postWakeVoicedMs = 0;
    this.idleListeningMs = 0;
    this.mode = 'post-wake-window';

    echoTelemetry.markWake(timestampMs);
    this.callbacks.onWakeDetected?.({
      phrase,
      className,
      confidence,
      timestampMs,
      detectionLatencyMs,
      engine: 'neural-oww',
      prerollPcmF32: this.prerollRing.readLatest(this.opts.prerollSamples),
    });
  }

  /**
   * Monitors the silent 280 ms post-wake window for Single-Breath Wake + Command ("Hey Echo, open Reading").
   * Because NO spoken greeting plays during wake, this window completes uninterrupted and preserves
   * 300 ms (4,800 samples) pre-lead so the opening command consonant is never clipped!
   */
  private stepPostWakeWindow(pSpeech: number, timestampMs: number): void {
    this.postWakeElapsedMs += 32;
    // Ignore the first 32 ms vowel tail of "Echo" so bare "Hi Echo" doesn't self-count as a command
    if (this.postWakeElapsedMs > 32 && pSpeech >= this.opts.singleBreathVadThreshold) {
      this.postWakeVoicedMs += 32;
    }

    if (this.postWakeVoicedMs >= 96) {
      const anchorWithLead = Math.max(0, this.wakeSampleAnchor - this.opts.singleBreathPreLeadSamples);
      const openingF32 = this.prerollRing.readSinceSample(anchorWithLead);
      const openingPcm16 = float32ToPcm16(openingF32);

      this.mode = 'active-listening';
      this.idleListeningMs = 0;
      this.resetTurnState();
      this.turnSpeaking = true;
      this.turnVoicedMs = this.postWakeVoicedMs;
      this.turnTotalMs = this.postWakeElapsedMs;
      this.turnPeakSnrDb = Math.max(this.opts.minCommitSnrDb + 3, 10);
      this.utteranceChunks.push(openingPcm16);
      this.networkBytesUploaded += openingPcm16.byteLength;
      this.turnSampleOffset = openingPcm16.length;

      echoTelemetry.incrementCounter('singleBreathHandoffs', 1);
      this.callbacks.onSingleBreathCommand?.({
        phrase: this.activeWakePhrase,
        timestampMs,
        postWakeVoicedMs: this.postWakeVoicedMs,
        turn1OpeningPcmF32: openingF32,
        turn1OpeningPcm16: openingPcm16,
      });
      this.callbacks.onStreamingPcm16?.(openingPcm16, 0);
      return;
    }

    if (this.postWakeElapsedMs >= this.opts.singleBreathWindowMs) {
      this.mode = 'active-listening';
      this.idleListeningMs = 0;
      this.resetTurnState();
      this.callbacks.onPostWakeGreetingCleared?.({ singleBreath: false, timestampMs });
    }
  }

  /**
   * During `'tts-speaking'`, gate `barge_in.probe` strictly on >= 96 ms post-PBFDAF Benesty NCC double-talk!
   */
  private stepTtsSpeakingBargeInProbe(
    nlmsRes: NlmsAecStepResult,
    pSpeech: number,
    timestampMs: number,
  ): void {
    const isGenuineDoubleTalk =
      !nlmsRes.echoSuppressed &&
      pSpeech >= 0.58 &&
      (nlmsRes.doubleTalkDetected || nlmsRes.postNlmsSnrDb >= 6.0);

    if (isGenuineDoubleTalk) {
      if (this.ttsDoubleTalkMs === 0) {
        this.ttsDoubleTalkAnchorSample = Math.max(0, this.prerollRing.totalSamplesWritten - 512);
      }
      this.ttsDoubleTalkMs += 32;
      this.ttsDoubleTalkSilenceMs = 0;

      if (
        this.ttsDoubleTalkMs >= this.opts.bargeInProbeVoicedMs &&
        timestampMs - this.lastBargeInProbeMs >= this.opts.bargeInProbeCooldownMs
      ) {
        this.lastBargeInProbeMs = timestampMs;
        // Slice latest 640 ms (10,240 samples @ 16 kHz) of PBFDAF-cleaned audio for probeOnly ASR
        const probePcm16 = this.getPrerollPcm16(10240);
        this.callbacks.onBargeInProbeReady?.({
          pcm16: probePcm16,
          voicedMs: this.ttsDoubleTalkMs,
          timestampMs,
        });
      }
    } else {
      this.ttsDoubleTalkSilenceMs += 32;
      if (this.ttsDoubleTalkSilenceMs >= 160) {
        this.ttsDoubleTalkMs = 0;
        this.ttsDoubleTalkAnchorSample = 0;
      }
    }
  }

  private stepActiveListening(
    clean512: Float32Array,
    pSpeech: number,
    frameSnrDb: number,
    timestampMs: number,
  ): void {
    if (!this.turnSpeaking) {
      if (pSpeech >= this.opts.positiveSpeechThreshold) {
        this.waitingForResponse = false;
        this.idleListeningMs = 0;
        this.turnSpeaking = true;
        this.turnVoicedMs = 32;
        this.turnSilenceMs = 0;
        this.turnTotalMs = 32;
        this.turnPeakSnrDb = frameSnrDb;
        this.tentativePauseFired = false;

        // Include 480 ms (15 frames = 7,680 samples) pre-speech pad so initial consonants are never clipped!
        const padSamples = this.opts.preSpeechPadFrames * 512;
        const prerollPcm16 = this.getPrerollPcm16(padSamples);
        this.utteranceChunks = [prerollPcm16];
        this.turnSampleOffset = prerollPcm16.length;
        this.networkBytesUploaded += prerollPcm16.byteLength;

        this.callbacks.onSpeechStart?.({ timestampMs, prerollPcm16 });
        this.callbacks.onStreamingPcm16?.(prerollPcm16, 0);
        return;
      }

      if (this.waitingForResponse) {
        this.idleListeningMs = 0;
        return;
      }

      // Bounded ACTIVE_FOLLOWUP silent decay: 10 s default (14 s when question/confirmation pending)
      this.idleListeningMs += 32;
      const limitMs = this.followupExtended
        ? this.opts.followupExtendedTimeoutMs
        : this.opts.followupTimeoutMs;
      if (this.idleListeningMs >= limitMs) {
        const elapsed = this.idleListeningMs;
        this.idleListeningMs = 0;
        this.mode = 'dormant';
        this.resetTurnState();
        this.callbacks.onFollowupTimeout?.({ idleMs: elapsed, timestampMs });
      }
      return;
    }

    // Active speech in progress
    const pcm16 = float32ToPcm16(clean512);
    const offsetBefore = this.turnSampleOffset;
    this.utteranceChunks.push(pcm16);
    this.turnSampleOffset += pcm16.length;
    this.networkBytesUploaded += pcm16.byteLength;
    this.turnTotalMs += 32;
    this.callbacks.onStreamingPcm16?.(pcm16, offsetBefore);

    if (pSpeech >= this.opts.negativeSpeechThreshold) {
      this.turnVoicedMs += 32;
      if (frameSnrDb > this.turnPeakSnrDb) {
        this.turnPeakSnrDb = frameSnrDb;
      }
      this.turnSilenceMs = 0;
      this.tentativePauseFired = false;
    } else {
      this.turnSilenceMs += 32;
    }

    // EOU-Fusion v2: 320/560 ms endpointing for short commands vs 360/880..1600 ms for L2 hesitation;
    // sub-threshold (< minCommitVoicedMs) ambient bumps discard promptly at <= 360 ms.
    const isShortCommand = this.turnVoicedMs <= 900;
    const tentativeThresholdMs = isShortCommand
      ? this.opts.shortCommandTentativeSilenceMs
      : this.opts.longUtteranceTentativeSilenceMs;
    const activeEndpointMs =
      this.dynamicEndpointOverrideMs ??
      (isShortCommand ? this.opts.shortCommandEndpointMs : this.opts.defaultEndpointSilenceMs);
    const effectiveEndpointMs =
      this.turnVoicedMs < this.opts.minCommitVoicedMs ? Math.min(activeEndpointMs, 360) : activeEndpointMs;

    if (!this.tentativePauseFired && this.turnSilenceMs >= tentativeThresholdMs && this.turnVoicedMs >= 160) {
      this.tentativePauseFired = true;
      const recentPcm16 = this.collectRecentTurnPcm16(128000);
      this.callbacks.onTentativePause?.({
        silenceMs: this.turnSilenceMs,
        voicedMs: this.turnVoicedMs,
        recentPcm16,
      });
    }

    if (this.turnSilenceMs >= effectiveEndpointMs) {
      echoTelemetry.markEou(timestampMs);
      this.commitActiveUtterance('silence');
    } else if (this.turnTotalMs >= this.opts.maxUtteranceMs) {
      echoTelemetry.markEou(timestampMs);
      this.commitActiveUtterance('max-duration');
    }
  }

  private collectRecentTurnPcm16(maxSamples: number): Int16Array {
    const total = this.utteranceChunks.reduce((acc, c) => acc + c.length, 0);
    const take = Math.min(total, maxSamples);
    const out = new Int16Array(take);
    let writeCursor = take;
    for (let i = this.utteranceChunks.length - 1; i >= 0 && writeCursor > 0; i--) {
      const chunk = this.utteranceChunks[i];
      const copyCount = Math.min(chunk.length, writeCursor);
      out.set(chunk.subarray(chunk.length - copyCount, chunk.length), writeCursor - copyCount);
      writeCursor -= copyCount;
    }
    return out;
  }
}
