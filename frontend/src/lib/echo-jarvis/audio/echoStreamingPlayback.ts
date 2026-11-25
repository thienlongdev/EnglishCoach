import { audioSessionArbiter } from './audioSessionArbiter';
import { type EchoEarconKind, EchoEarconSynth } from './earcons';
import { echoTelemetry } from './echoTelemetry';

export type EchoJarvisVoiceId = 'us_female' | 'us_male' | 'uk_female' | 'uk_male' | 'device';

export interface WordTimingSpan {
  word: string;
  startMs: number;
  endMs: number;
}

export interface PlaybackClauseSegment {
  turnSeq: number;
  utteranceId: string;
  pcm24kOrNative: Float32Array;
  sampleRate: number;
  durationMs: number;
  startMsInTurn: number;
  text: string;
  wordTimings?: WordTimingSpan[];
}

export interface WakeGreetingEntry {
  voiceId?: string;
  lang?: 'en' | 'vi';
  url: string;
  text?: string;
  durationMs?: number;
}

export interface EchoWakeManifest {
  voices?: Record<string, { en?: (string | WakeGreetingEntry)[]; vi?: (string | WakeGreetingEntry)[] }>;
  entries?: WakeGreetingEntry[];
  clips?: WakeGreetingEntry[];
  [key: string]: unknown;
}

export interface EchoStreamingPlaybackOptions {
  sampleRate?: number; // default 24000 Hz matching Kokoro-82M & VieNeu-TTS
  analyserFftSize?: number; // default 512
  onAnalyserReady?: (kind: 'tts', analyser: AnalyserNode) => void;
  onPlaybackStart?: (turnSeq: number) => void;
  onPlaybackEnd?: (turnSeq: number) => void;
  onReferenceChunk16k?: (ref512: Float32Array) => void;
  audioContextFactory?: () => AudioContext;
}

const VI_FALLBACK_GREETINGS = ['Dạ, Echo nghe đây.', 'Chào bạn, mình sẵn sàng rồi.'];
const EN_FALLBACK_GREETINGS = ['Yes? I am listening.', 'Right here. How can I help?'];
const STALLED_STREAM_SAFETY_MS = 45_000;

/**
 * Parse a standard RIFF PCM16/Float32 WAV buffer synchronously into mono Float32Array + sampleRate
 * so cached wake greetings and fallback WAV responses start with 0 ms async decode stall!
 */
export function decodeWavToFloat32(wavBuffer: ArrayBuffer | Uint8Array): {
  samples: Float32Array;
  sampleRate: number;
} | null {
  const bytes = wavBuffer instanceof Uint8Array ? wavBuffer : new Uint8Array(wavBuffer);
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 'RIFF' & 'WAVE'
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    return null;
  }

  let pos = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 24000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataLength = 0;

  while (pos + 8 <= bytes.byteLength) {
    const chunkId = view.getUint32(pos, false);
    const chunkSize = view.getUint32(pos + 4, true);
    const bodyStart = pos + 8;
    if (chunkId === 0x666d7420 && bodyStart + 16 <= bytes.byteLength) {
      // 'fmt '
      audioFormat = view.getUint16(bodyStart, true);
      numChannels = Math.max(1, view.getUint16(bodyStart + 2, true));
      sampleRate = view.getUint32(bodyStart + 4, true);
      bitsPerSample = view.getUint16(bodyStart + 14, true);
    } else if (chunkId === 0x64617461) {
      // 'data'
      dataOffset = bodyStart;
      dataLength = Math.min(chunkSize, bytes.byteLength - bodyStart);
      break;
    }
    pos = bodyStart + chunkSize + (chunkSize & 1);
  }

  if (dataOffset < 0 || dataLength <= 0) return null;

  if (audioFormat === 1 && bitsPerSample === 16) {
    const frameBytes = numChannels * 2;
    const frameCount = Math.floor(dataLength / frameBytes);
    const out = new Float32Array(frameCount);
    const inv = 1 / 32768;
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      const base = dataOffset + i * frameBytes;
      for (let c = 0; c < numChannels; c++) {
        sum += view.getInt16(base + c * 2, true) * inv;
      }
      out[i] = sum / numChannels;
    }
    return { samples: out, sampleRate };
  }

  if (audioFormat === 3 && bitsPerSample === 32) {
    const frameBytes = numChannels * 4;
    const frameCount = Math.floor(dataLength / frameBytes);
    const out = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      const base = dataOffset + i * frameBytes;
      for (let c = 0; c < numChannels; c++) {
        sum += view.getFloat32(base + c * 4, true);
      }
      out[i] = sum / numChannels;
    }
    return { samples: out, sampleRate };
  }

  return null;
}

export function pcm16LeToFloat32(pcmBytes: ArrayBuffer | Uint8Array | Int16Array): Float32Array {
  if (pcmBytes instanceof Int16Array) {
    const out = new Float32Array(pcmBytes.length);
    const inv = 1 / 32768;
    for (let i = 0; i < pcmBytes.length; i++) out[i] = pcmBytes[i] * inv;
    return out;
  }
  const bytes = pcmBytes instanceof Uint8Array ? pcmBytes : new Uint8Array(pcmBytes);
  const sampleCount = bytes.byteLength >> 1;
  const out = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  const inv = 1 / 32768;
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, true) * inv;
  }
  return out;
}

/**
 * Downsample arbitrary sampleRate (e.g. 24 kHz) mono Float32 buffer to 16 kHz for deterministic NLMS AEC reference tap.
 */
export function resampleTo16kHzMono(samples: Float32Array, inSampleRate: number): Float32Array {
  if (inSampleRate === 16000 || samples.length === 0) return samples;
  const ratio = inSampleRate / 16000;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const center = i * ratio;
    const i0 = Math.min(samples.length - 1, Math.floor(center));
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = center - i0;
    out[i] = samples[i0] + (samples[i1] - samples[i0]) * frac;
  }
  return out;
}

function estimateWordSyllables(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-zà-ỹ]/gu, '');
  if (!clean) return 1;
  const vowelGroups = clean.match(/[aeiouyàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹ]+/gu);
  return Math.max(1, vowelGroups ? vowelGroups.length : 1);
}

/**
 * Gapless WebAudio Streaming Playback + Soft-Duck / PauseHold / <50 ms Hard-Cancel + 512-pt FFT AnalyserNode
 * + 16 kHz AEC Reference Tap + Cached Instant Wake Greetings + Heard-Only Word Alignment.
 */
export class EchoStreamingPlayback {
  private readonly opts: EchoStreamingPlaybackOptions;
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private earconGainNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private connectedWorkletRef: AudioNode | null = null;
  private readonly earconSynth = new EchoEarconSynth();

  private activeTurnSeq = 0;
  private greetingActive = false;
  private nextScheduleCtxTime = 0;
  private turnStartCtxTime = 0;
  private totalScheduledMs = 0;
  private playing = false;
  private pausedHold = false;
  private pausedAtPlayedMs = 0;
  private accumulatedPauseSec = 0;
  private pauseStartedCtxTime = 0;
  private turnAudioStreamFinished = true;
  private clauseGapGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubGestureUnlock: (() => void) | null = null;

  private activeSources = new Set<AudioBufferSourceNode>();
  private segments: PlaybackClauseSegment[] = [];
  private refRemainder16k = new Float32Array(0);
  private greetingRotation = 0;
  private readonly greetingCache = new Map<string, { samples: Float32Array; sampleRate: number }>();
  private wakeManifestLoaded = false;
  private wakeManifest: EchoWakeManifest | null = null;
  private unsubLogout: (() => void) | null = null;

  // Fallback synthetic wall-clock tracking when running in headless Node tests without WebAudio AudioContext
  private headlessStartWallMs = 0;
  private headlessTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: EchoStreamingPlaybackOptions = {}) {
    this.opts = options;
    this.unsubLogout = audioSessionArbiter.registerInstantLogoutTeardown(() => {
      this.hardCancel();
    });
  }

  get isPlaying(): boolean {
    return this.playing && !this.pausedHold;
  }

  get isGreetingPlaying(): boolean {
    return this.playing && this.greetingActive;
  }

  get isPausedHold(): boolean {
    return this.pausedHold;
  }

  get currentTurnSeq(): number {
    return this.activeTurnSeq;
  }

  resetTurnSequence(seq = 0): void {
    this.activeTurnSeq = Math.max(0, seq);
  }

  getAnalyserNode(): AnalyserNode | null {
    return this.analyserNode;
  }

  /**
   * Returns total browser AudioContext output pipeline latency (`outputLatency + baseLatency`) in ms.
   * Used both to seed PBFDAF GCC-PHAT acoustic delay and to keep `getPlayedMs()` ear-accurate.
   */
  getOutputLatencyMs(): number {
    if (!this.ctx) return 0;
    const raw = this.ctx as AudioContext & { outputLatency?: number; baseLatency?: number };
    const outSec = typeof raw.outputLatency === 'number' && Number.isFinite(raw.outputLatency) ? Math.max(0, raw.outputLatency) : 0;
    const baseSec = typeof raw.baseLatency === 'number' && Number.isFinite(raw.baseLatency) ? Math.max(0, raw.baseLatency) : 0;
    return Math.round((outSec + baseSec) * 1000);
  }

  /**
   * Play a crisp procedural WebAudio earcon on the shared AudioContext (feeding the TTS AnalyserNode
   * so the Living Entity ripples cleanly, WITHOUT disturbing TTS turn sequence or speech playback state).
   */
  playEarcon(kind: EchoEarconKind): boolean {
    const ctx = this.ensureAudioContext();
    return this.earconSynth.play(ctx, kind, this.earconGainNode ?? ctx?.destination ?? null);
  }

  /**
   * Signal that the server has finished streaming all TTS audio chunks for `turnSeq` (`tts.done` / `response.done`).
   */
  markTurnAudioStreamFinished(turnSeq: number): void {
    if (turnSeq < this.activeTurnSeq) return;
    this.turnAudioStreamFinished = true;
    if (this.clauseGapGraceTimer) {
      clearTimeout(this.clauseGapGraceTimer);
      this.clauseGapGraceTimer = null;
    }
    if (this.activeSources.size === 0 && !this.pausedHold && this.playing && this.activeTurnSeq === turnSeq) {
      this.clearPlaybackDrainTimer();
      this.playing = false;
      this.greetingActive = false;
      this.opts.onPlaybackEnd?.(turnSeq);
      return;
    }
    if (this.playing && !this.pausedHold && this.activeTurnSeq === turnSeq) {
      this.schedulePlaybackDrainWatchdog(turnSeq);
    }
  }

  private clearPlaybackDrainTimer(): void {
    if (this.playbackDrainTimer) {
      clearTimeout(this.playbackDrainTimer);
      this.playbackDrainTimer = null;
    }
  }

  /**
   * Safety watchdog preventing a suspended browser AudioContext from deadlocking `isPlaying === true`
   * if `AudioBufferSourceNode.onended` is delayed or blocked by autoplay/tab-suspension policies.
   */
  private schedulePlaybackDrainWatchdog(turnSeq: number): void {
    this.clearPlaybackDrainTimer();
    let expectedRemainingMs = Math.max(0, this.totalScheduledMs - this.getPlayedMs());
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {});
        expectedRemainingMs = Math.min(expectedRemainingMs, 650);
      } else {
        expectedRemainingMs = Math.max(0, (this.nextScheduleCtxTime - this.ctx.currentTime) * 1000);
      }
    }
    const timeoutMs = Math.max(350, Math.min(35000, Math.round(expectedRemainingMs + 750)));
    this.playbackDrainTimer = setTimeout(() => {
      this.playbackDrainTimer = null;
      if (this.activeTurnSeq !== turnSeq || this.pausedHold || !this.playing || !this.turnAudioStreamFinished) {
        return;
      }
      if (this.ctx && this.ctx.state !== 'suspended' && this.nextScheduleCtxTime - this.ctx.currentTime > 0.08) {
        this.schedulePlaybackDrainWatchdog(turnSeq);
        return;
      }
      this.stopScheduledSourcesImmediate();
      this.playing = false;
      this.greetingActive = false;
      this.opts.onPlaybackEnd?.(turnSeq);
    }, timeoutMs);
    (this.playbackDrainTimer as unknown as { unref?: () => void })?.unref?.();
  }

  private bindGestureUnlockOnce(ctx: AudioContext): void {
    if (this.unsubGestureUnlock || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }
    const unlock = () => {
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
      if (ctx.state === 'running' || ctx.state === 'closed') {
        cleanup();
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      this.unsubGestureUnlock = null;
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    this.unsubGestureUnlock = cleanup;
  }

  ensureAudioContext(): AudioContext | null {
    if (this.ctx && this.ctx.state !== 'closed') {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {});
        this.bindGestureUnlockOnce(this.ctx);
      }
      return this.ctx;
    }
    const Ctor =
      this.opts.audioContextFactory
        ? null
        : typeof window !== 'undefined'
          ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : null;

    if (!this.opts.audioContextFactory && !Ctor) {
      return null;
    }

    const ctx = this.opts.audioContextFactory
      ? this.opts.audioContextFactory()
      : new Ctor!({ latencyHint: 'interactive' });
    this.ctx = ctx;

    if (typeof (ctx as AudioContext & { onstatechange?: unknown }).onstatechange !== 'undefined') {
      ctx.onstatechange = () => {
        if (this.ctx === ctx && ctx.state === 'suspended' && this.playing) {
          void ctx.resume().catch(() => {});
          this.bindGestureUnlockOnce(ctx);
        }
      };
    }
    if (ctx.state === 'suspended') {
      this.bindGestureUnlockOnce(ctx);
    }

    const gain = ctx.createGain();
    gain.gain.value = 1.0;

    const earconGain = ctx.createGain();
    earconGain.gain.value = 1.0;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.opts.analyserFftSize ?? 512;
    analyser.smoothingTimeConstant = 0.55;

    gain.connect(ctx.destination);
    gain.connect(analyser);

    earconGain.connect(ctx.destination);
    earconGain.connect(analyser);

    if (this.connectedWorkletRef) {
      try {
        gain.connect(this.connectedWorkletRef, 0, 1);
      } catch {
        // Worklet may belong to a different context; callback reference path still works
      }
    }

    this.gainNode = gain;
    this.earconGainNode = earconGain;
    this.analyserNode = analyser;
    this.opts.onAnalyserReady?.('tts', analyser);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        // Canonical Contract B payload: `{ channel: 'tts', analyser }`
        window.dispatchEvent(new CustomEvent('ec:echo-analyser', { detail: { channel: 'tts', analyser } }));
      } catch {
        // Ignore custom event errors
      }
    }
    return ctx;
  }

  /**
   * Connect TTS GainNode directly into `echo-microphone` AudioWorkletNode input[1] when sharing the same AudioContext.
   */
  connectReferenceToWorklet(workletNode: AudioNode | null): void {
    this.connectedWorkletRef = workletNode;
    if (workletNode && this.gainNode && workletNode.context === this.ctx) {
      try {
        this.gainNode.connect(workletNode, 0, 1);
      } catch {
        // Safe fallback to onReferenceChunk16k
      }
    }
  }

  beginTurn(turnSeq: number): void {
    if (turnSeq < this.activeTurnSeq) return;
    if (turnSeq > this.activeTurnSeq || this.greetingActive || (!this.playing && !this.pausedHold && this.turnAudioStreamFinished)) {
      if (this.clauseGapGraceTimer) {
        clearTimeout(this.clauseGapGraceTimer);
        this.clauseGapGraceTimer = null;
      }
      this.clearPlaybackDrainTimer();
      this.stopScheduledSourcesImmediate();
      this.segments = [];
      this.totalScheduledMs = 0;
      this.nextScheduleCtxTime = 0;
      this.playing = false;
      this.greetingActive = false;
      this.pausedHold = false;
      this.pausedAtPlayedMs = 0;
      this.accumulatedPauseSec = 0;
      this.turnAudioStreamFinished = false;
      this.activeTurnSeq = turnSeq;
      if (this.gainNode && this.ctx) {
        const now = this.ctx.currentTime;
        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setValueAtTime(1.0, now);
      }
    }
  }

  /**
   * Enqueue a raw `PCM16LE` chunk (default 24 kHz) onto the gapless scheduled WebAudio queue (0 ms inter-chunk gap!).
   */
  enqueuePcm16(
    pcmBytes: ArrayBuffer | Uint8Array | Int16Array,
    meta: {
      turnSeq: number;
      utteranceId?: string;
      sampleRate?: number;
      text?: string;
      wordTimings?: WordTimingSpan[];
    },
  ): boolean {
    if (meta.turnSeq < this.activeTurnSeq) {
      echoTelemetry.incrementCounter('staleAudioFramesDropped', 1);
      return false;
    }
    if (meta.turnSeq > this.activeTurnSeq) {
      this.beginTurn(meta.turnSeq);
    }

    const f32 = pcm16LeToFloat32(pcmBytes);
    if (f32.length === 0) return true;
    const sr = meta.sampleRate ?? this.opts.sampleRate ?? 24000;
    this.scheduleFloat32Segment(f32, sr, meta.turnSeq, meta.utteranceId ?? `u-${meta.turnSeq}`, meta.text ?? '', meta.wordTimings);
    return true;
  }

  /**
   * Enqueue a WAV buffer synchronously (or via WebAudio decodeAudioData fallback for compressed containers).
   */
  async enqueueWav(
    wavBuffer: ArrayBuffer | Uint8Array,
    meta: {
      turnSeq: number;
      utteranceId?: string;
      text?: string;
      wordTimings?: WordTimingSpan[];
    },
  ): Promise<boolean> {
    if (meta.turnSeq < this.activeTurnSeq) {
      echoTelemetry.incrementCounter('staleAudioFramesDropped', 1);
      return false;
    }
    if (meta.turnSeq > this.activeTurnSeq) {
      this.beginTurn(meta.turnSeq);
    }

    const fastDecoded = decodeWavToFloat32(wavBuffer);
    if (fastDecoded) {
      this.scheduleFloat32Segment(
        fastDecoded.samples,
        fastDecoded.sampleRate,
        meta.turnSeq,
        meta.utteranceId ?? `wav-${meta.turnSeq}`,
        meta.text ?? '',
        meta.wordTimings,
      );
      return true;
    }

    const ctx = this.ensureAudioContext();
    if (!ctx) return false;
    const rawCopy =
      wavBuffer instanceof Uint8Array
        ? wavBuffer.buffer.slice(wavBuffer.byteOffset, wavBuffer.byteOffset + wavBuffer.byteLength)
        : wavBuffer.slice(0);
    const audioBuf = await ctx.decodeAudioData(rawCopy as ArrayBuffer);
    if (meta.turnSeq < this.activeTurnSeq) return false;
    const ch0 = new Float32Array(audioBuf.getChannelData(0));
    this.scheduleFloat32Segment(
      ch0,
      audioBuf.sampleRate,
      meta.turnSeq,
      meta.utteranceId ?? `dec-${meta.turnSeq}`,
      meta.text ?? '',
      meta.wordTimings,
    );
    return true;
  }

  private scheduleFloat32Segment(
    samples: Float32Array,
    sampleRate: number,
    turnSeq: number,
    utteranceId: string,
    text: string,
    wordTimings?: WordTimingSpan[],
  ): void {
    const durationMs = (samples.length / sampleRate) * 1000;
    const startMsInTurn = this.totalScheduledMs;
    const segment: PlaybackClauseSegment = {
      turnSeq,
      utteranceId,
      pcm24kOrNative: samples,
      sampleRate,
      durationMs,
      startMsInTurn,
      text,
      wordTimings,
    };
    this.segments.push(segment);
    this.totalScheduledMs += durationMs;

    // Emit 512-sample 16 kHz reference chunks ONLY when hardware-synced AudioWorklet input[1] is not connected
    if (this.opts.onReferenceChunk16k && !this.connectedWorkletRef) {
      const ref16k = resampleTo16kHzMono(samples, sampleRate);
      const merged = new Float32Array(this.refRemainder16k.length + ref16k.length);
      merged.set(this.refRemainder16k, 0);
      merged.set(ref16k, this.refRemainder16k.length);
      let off = 0;
      while (off + 512 <= merged.length) {
        this.opts.onReferenceChunk16k(merged.subarray(off, off + 512));
        off += 512;
      }
      this.refRemainder16k = merged.slice(off);
    }

    if (this.clauseGapGraceTimer) {
      clearTimeout(this.clauseGapGraceTimer);
      this.clauseGapGraceTimer = null;
    }

    echoTelemetry.markFirstAudio();

    if (this.pausedHold) {
      // Buffered silently behind PausedHold; will play sample-accurately if resumeFromHold() fires!
      return;
    }

    const ctx = this.ensureAudioContext();
    if (!ctx || !this.gainNode) {
      // Headless Node test environment fallback
      if (!this.playing) {
        this.playing = true;
        this.headlessStartWallMs = performance.now();
        this.opts.onPlaybackStart?.(turnSeq);
      }
      if (this.headlessTimer) clearTimeout(this.headlessTimer);
      const remaining = Math.max(0, this.totalScheduledMs - this.getPlayedMs());
      this.headlessTimer = setTimeout(() => {
        if (this.activeTurnSeq === turnSeq && !this.pausedHold) {
          this.playing = false;
          this.opts.onPlaybackEnd?.(turnSeq);
        }
      }, remaining);
      return;
    }

    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    if (!this.playing || this.nextScheduleCtxTime < now) {
      const firstLeadSec = 0.012; // 12 ms micro-buffer for zero-click start; 0.000 ms gap thereafter!
      const startAt = now + firstLeadSec;
      if (!this.playing) {
        this.turnStartCtxTime = startAt - this.pausedAtPlayedMs / 1000;
        this.accumulatedPauseSec = 0;
        this.playing = true;
        this.opts.onPlaybackStart?.(turnSeq);
      } else if (this.nextScheduleCtxTime > 0) {
        // Compensate inter-clause synthesis underrun gap so getPlayedMs() and getSpokenTextSoFar() stay exact
        this.accumulatedPauseSec += Math.max(0, startAt - this.nextScheduleCtxTime);
      }
      this.nextScheduleCtxTime = startAt;
    }

    this.scheduleAudioBufferNode(ctx, samples, sampleRate, this.nextScheduleCtxTime, turnSeq);
    this.nextScheduleCtxTime += samples.length / sampleRate;
  }

  private scheduleAudioBufferNode(
    ctx: AudioContext,
    samples: Float32Array,
    sampleRate: number,
    startAtCtxSec: number,
    turnSeq: number,
  ): void {
    if (!this.gainNode) return;
    const audioBuf = ctx.createBuffer(1, samples.length, sampleRate);
    audioBuf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(this.gainNode);
    this.activeSources.add(src);

    src.onended = () => {
      this.activeSources.delete(src);
      if (this.activeSources.size === 0 && !this.pausedHold && this.activeTurnSeq === turnSeq && this.playing) {
        if (this.turnAudioStreamFinished) {
          this.clearPlaybackDrainTimer();
          this.playing = false;
          this.greetingActive = false;
          this.opts.onPlaybackEnd?.(turnSeq);
        } else {
          // Keep playback state active across inter-clause synthesis gaps until markTurnAudioStreamFinished()
          // arrives, bounded only by STALLED_STREAM_SAFETY_MS (45 s) so a stalled stream cannot wedge forever.
          if (this.clauseGapGraceTimer) clearTimeout(this.clauseGapGraceTimer);
          this.clauseGapGraceTimer = setTimeout(() => {
            this.clauseGapGraceTimer = null;
            if (
              this.activeSources.size === 0 &&
              !this.pausedHold &&
              !this.turnAudioStreamFinished &&
              this.activeTurnSeq === turnSeq &&
              this.playing
            ) {
              this.clearPlaybackDrainTimer();
              this.playing = false;
              this.greetingActive = false;
              this.opts.onPlaybackEnd?.(turnSeq);
            }
          }, STALLED_STREAM_SAFETY_MS);
          (this.clauseGapGraceTimer as unknown as { unref?: () => void })?.unref?.();
        }
      }
    };

    src.start(startAtCtxSec);
  }

  /**
   * Soft-Duck TTS GainNode (default -12 dB over 35 ms) on tentative human speech onset.
   */
  softDuck(db = -12, rampMs = 35): void {
    if (!this.ctx || !this.gainNode) return;
    const now = this.ctx.currentTime;
    const targetGain = Math.pow(10, db / 20);
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
    this.gainNode.gain.linearRampToValueAtTime(targetGain, now + rampMs / 1000);
  }

  /**
   * Freeze TTS playout at the exact sample offset while keeping the Mic AudioWorklet running live!
   */
  pauseHold(): number {
    if (this.pausedHold || !this.playing) {
      return this.getPlayedMs();
    }
    this.pausedAtPlayedMs = this.getPlayedMs();
    this.pausedHold = true;
    if (this.ctx) {
      this.pauseStartedCtxTime = this.ctx.currentTime;
    }
    if (this.headlessTimer) {
      clearTimeout(this.headlessTimer);
      this.headlessTimer = null;
    }
    this.stopScheduledSourcesImmediate();
    return this.pausedAtPlayedMs;
  }

  /**
   * Seamlessly resume TTS from exact `pausedAtPlayedMs` sample offset and ramp Gain -> 1.0 in 60 ms!
   */
  resumeFromHold(rampMs = 60): void {
    if (!this.pausedHold && this.ctx && this.gainNode) {
      // Was only SoftDucked (not PausedHold): restore gain smoothly
      const now = this.ctx.currentTime;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.linearRampToValueAtTime(1.0, now + rampMs / 1000);
      return;
    }

    if (!this.pausedHold) return;
    this.pausedHold = false;
    const resumeOffsetMs = this.pausedAtPlayedMs;

    const ctx = this.ctx;
    if (!ctx || !this.gainNode) {
      this.headlessStartWallMs = performance.now() - resumeOffsetMs;
      return;
    }

    const now = ctx.currentTime;
    if (this.pauseStartedCtxTime > 0) {
      this.accumulatedPauseSec += Math.max(0, now - this.pauseStartedCtxTime);
      this.pauseStartedCtxTime = 0;
    }

    // Re-schedule unplayed tail of every segment starting at `resumeOffsetMs`!
    let cursorSec = now + 0.01;
    this.turnStartCtxTime = cursorSec - resumeOffsetMs / 1000;
    this.accumulatedPauseSec = 0;

    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(0.2, now);
    this.gainNode.gain.linearRampToValueAtTime(1.0, now + rampMs / 1000);

    for (const seg of this.segments) {
      const segEndMs = seg.startMsInTurn + seg.durationMs;
      if (segEndMs <= resumeOffsetMs + 2) continue;
      if (seg.startMsInTurn >= resumeOffsetMs) {
        this.scheduleAudioBufferNode(ctx, seg.pcm24kOrNative, seg.sampleRate, cursorSec, seg.turnSeq);
        cursorSec += seg.pcm24kOrNative.length / seg.sampleRate;
      } else {
        const skipMs = resumeOffsetMs - seg.startMsInTurn;
        const skipSamples = Math.min(
          seg.pcm24kOrNative.length - 1,
          Math.max(0, Math.floor((skipMs / 1000) * seg.sampleRate)),
        );
        const remainingSlice = seg.pcm24kOrNative.subarray(skipSamples);
        if (remainingSlice.length > 0) {
          this.scheduleAudioBufferNode(ctx, remainingSlice, seg.sampleRate, cursorSec, seg.turnSeq);
          cursorSec += remainingSlice.length / seg.sampleRate;
        }
      }
    }
    this.nextScheduleCtxTime = cursorSec;
    if (this.turnAudioStreamFinished) {
      if (this.activeSources.size === 0) {
        this.clearPlaybackDrainTimer();
        this.playing = false;
        this.greetingActive = false;
        this.opts.onPlaybackEnd?.(this.activeTurnSeq);
      } else {
        this.schedulePlaybackDrainWatchdog(this.activeTurnSeq);
      }
    }
  }

  /**
   * Hard-Cancel TTS in < 50 ms (actual < 12 ms), returning exact `playedMs` and heard-only `spokenTextSoFar`.
   */
  hardCancel(): { playedMs: number; spokenTextSoFar: string; turnSeq: number; wasGreeting: boolean } {
    const wasGreeting = this.greetingActive;
    const playedMs = wasGreeting ? 0 : this.getPlayedMs();
    const spokenTextSoFar = wasGreeting ? '' : this.getSpokenTextSoFar(playedMs);
    const cancelledTurnSeq = this.activeTurnSeq;
    const hadServerTurnAudio =
      !wasGreeting &&
      (this.playing || this.pausedHold || this.segments.length > 0 || !this.turnAudioStreamFinished);

    // Advance activeTurnSeq ONLY when cancelling an active/pending server turn so idle/greeting cancels
    // never push playback.activeTurnSeq ahead of voiceClient.activeTurnSeq!
    if (hadServerTurnAudio) {
      this.activeTurnSeq += 1;
    }
    this.playing = false;
    this.greetingActive = false;
    this.pausedHold = false;
    this.pausedAtPlayedMs = 0;
    this.totalScheduledMs = 0;
    this.nextScheduleCtxTime = 0;
    this.turnAudioStreamFinished = true;
    this.segments = [];
    this.refRemainder16k = new Float32Array(0);

    if (this.clauseGapGraceTimer) {
      clearTimeout(this.clauseGapGraceTimer);
      this.clauseGapGraceTimer = null;
    }
    this.clearPlaybackDrainTimer();
    if (this.headlessTimer) {
      clearTimeout(this.headlessTimer);
      this.headlessTimer = null;
    }

    if (this.ctx && this.gainNode) {
      const now = this.ctx.currentTime;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(0.0, now);
    }
    this.stopScheduledSourcesImmediate();

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore
      }
    }

    if (!wasGreeting) {
      echoTelemetry.markBargeInStopped();
    }

    // Restore GainNode to 1.0 ready for the next turn after sources are disconnected
    if (this.ctx && this.gainNode) {
      this.gainNode.gain.setValueAtTime(1.0, this.ctx.currentTime + 0.005);
    }

    return { playedMs, spokenTextSoFar, turnSeq: cancelledTurnSeq, wasGreeting };
  }

  private stopScheduledSourcesImmediate(): void {
    for (const src of this.activeSources) {
      src.onended = null;
      try {
        src.stop(0);
        src.disconnect();
      } catch {
        // Ignore already-stopped source
      }
    }
    this.activeSources.clear();
  }

  /**
   * Exact milliseconds of assistant audio actually heard by the user in the current turn,
   * compensated by `AudioContext.outputLatency + baseLatency`.
   */
  getPlayedMs(): number {
    if (this.pausedHold) {
      return Math.min(this.totalScheduledMs, Math.max(0, Math.round(this.pausedAtPlayedMs)));
    }
    if (!this.playing) {
      return 0;
    }
    if (this.ctx) {
      const elapsedSec = this.ctx.currentTime - this.turnStartCtxTime - this.accumulatedPauseSec;
      const ms = elapsedSec * 1000 - this.getOutputLatencyMs();
      return Math.min(this.totalScheduledMs, Math.max(0, Math.round(ms)));
    }
    const wallElapsed = performance.now() - this.headlessStartWallMs;
    return Math.min(this.totalScheduledMs, Math.max(0, Math.round(wallElapsed)));
  }

  /**
   * Reconstruct the exact prefix of assistant text heard up to `atPlayedMs` using wordTimings or syllable-paced alignment.
   * Coalesces multi-chunk streaming PCM frames belonging to the same `utteranceId` into full-clause spans so
   * syllable pacing distributes over the true audio duration of the clause rather than its first 40 ms packet!
   */
  getSpokenTextSoFar(atPlayedMs = this.getPlayedMs()): string {
    if (this.segments.length === 0 || atPlayedMs <= 0) return '';

    const clauses: Array<{
      utteranceId: string;
      startMsInTurn: number;
      durationMs: number;
      text: string;
      wordTimings?: WordTimingSpan[];
    }> = [];

    for (const seg of this.segments) {
      const prev = clauses[clauses.length - 1];
      if (prev && prev.utteranceId === seg.utteranceId) {
        prev.durationMs += seg.durationMs;
        if (!prev.text && seg.text) prev.text = seg.text;
        if (!prev.wordTimings && seg.wordTimings) prev.wordTimings = seg.wordTimings;
      } else {
        clauses.push({
          utteranceId: seg.utteranceId,
          startMsInTurn: seg.startMsInTurn,
          durationMs: seg.durationMs,
          text: seg.text,
          wordTimings: seg.wordTimings,
        });
      }
    }

    const parts: string[] = [];

    for (const seg of clauses) {
      if (!seg.text) continue;
      if (atPlayedMs <= seg.startMsInTurn) break;

      const segEndMs = seg.startMsInTurn + seg.durationMs;
      if (atPlayedMs >= segEndMs - 15 || seg.durationMs <= 0) {
        parts.push(seg.text.trim());
        continue;
      }

      const localMs = atPlayedMs - seg.startMsInTurn;
      if (seg.wordTimings && seg.wordTimings.length > 0) {
        const heardWords: string[] = [];
        for (const wt of seg.wordTimings) {
          if (localMs >= wt.startMs + (wt.endMs - wt.startMs) * 0.35) {
            heardWords.push(wt.word);
          } else {
            break;
          }
        }
        if (heardWords.length > 0) {
          parts.push(heardWords.join(' '));
        }
        break;
      }

      // Proportional syllable-weighted alignment over `seg.durationMs`
      const words = seg.text.trim().split(/\s+/u).filter(Boolean);
      if (words.length === 0) break;
      const syllables = words.map(estimateWordSyllables);
      const totalSyll = syllables.reduce((a, b) => a + b, 0);
      const progressRatio = Math.max(0, Math.min(1, localMs / seg.durationMs));
      const targetSyll = progressRatio * totalSyll;

      let cumSyll = 0;
      const heardWords: string[] = [];
      for (let i = 0; i < words.length; i++) {
        if (cumSyll + syllables[i] * 0.4 <= targetSyll) {
          heardWords.push(words[i]);
          cumSyll += syllables[i];
        } else {
          break;
        }
      }
      if (heardWords.length > 0) {
        parts.push(heardWords.join(' '));
      }
      break;
    }

    return parts.join(' ').trim();
  }

  /**
   * Preload `/echo-jarvis/wake/manifest.json` and optionally warm the user's selected voice greeting WAVs.
   */
  async preloadWakeGreetings(
    voiceId: EchoJarvisVoiceId = 'us_female',
    lang: 'en' | 'vi' = 'en',
    fetchImpl: typeof fetch = fetch,
  ): Promise<void> {
    if (voiceId === 'device') return;
    if (!this.wakeManifestLoaded) {
      this.wakeManifestLoaded = true;
      try {
        const res = await fetchImpl('/echo-jarvis/wake/manifest.json', { credentials: 'same-origin' });
        if (res.ok) {
          this.wakeManifest = (await res.json()) as EchoWakeManifest;
        }
      } catch {
        this.wakeManifest = null;
      }
    }

    const urls = this.resolveGreetingUrls(voiceId, lang);
    await Promise.all(
      urls.map(async (url) => {
        if (this.greetingCache.has(url)) return;
        try {
          const res = await fetchImpl(url, { credentials: 'same-origin' });
          if (!res.ok) return;
          const buf = await res.arrayBuffer();
          const decoded = decodeWavToFloat32(buf);
          if (decoded) {
            this.greetingCache.set(url, decoded);
          }
        } catch {
          // Safe WebSpeech fallback if offline or missing
        }
      }),
    );
  }

  private resolveGreetingUrls(voiceId: Exclude<EchoJarvisVoiceId, 'device'>, lang: 'en' | 'vi'): string[] {
    const fromVoices = this.wakeManifest?.voices?.[voiceId]?.[lang];
    if (Array.isArray(fromVoices) && fromVoices.length > 0) {
      const urls = fromVoices.map((entry) => (typeof entry === 'string' ? entry : entry.url)).filter(Boolean);
      if (urls.length > 0) return urls;
    }
    const flatList = this.wakeManifest?.entries ?? this.wakeManifest?.clips;
    const fromFlat = flatList
      ?.filter((c) => c.voiceId === voiceId && c.lang === lang)
      .map((c) => c.url)
      .filter(Boolean);
    if (fromFlat && fromFlat.length > 0) {
      return fromFlat;
    }
    return [`/echo-jarvis/wake/${voiceId}_${lang}_0.wav`, `/echo-jarvis/wake/${voiceId}_${lang}_1.wav`];
  }

  /**
   * Play an instant (< 200 ms cold / < 20 ms cached, 0 LLM tokens!) wake greeting.
   * Can be cancelled in < 15 ms via `hardCancel()` if Single-Breath Wake + Command fires!
   */
  async playWakeGreeting(
    voiceId: EchoJarvisVoiceId = 'us_female',
    lang: 'en' | 'vi' = 'en',
    fetchImpl: typeof fetch = fetch,
  ): Promise<boolean> {
    const idx = this.greetingRotation++ & 1;
    const fallbackText = lang === 'vi' ? VI_FALLBACK_GREETINGS[idx] : EN_FALLBACK_GREETINGS[idx];

    if (voiceId !== 'device') {
      const urls = this.resolveGreetingUrls(voiceId, lang);
      const chosenUrl = urls[idx % urls.length];
      let cached = this.greetingCache.get(chosenUrl);

      if (!cached) {
        try {
          const res = await fetchImpl(chosenUrl, { credentials: 'same-origin' });
          if (res.ok) {
            const decoded = decodeWavToFloat32(await res.arrayBuffer());
            if (decoded) {
              this.greetingCache.set(chosenUrl, decoded);
              cached = decoded;
            }
          }
        } catch {
          cached = undefined;
        }
      }

      if (cached) {
        const turnSeq = this.activeTurnSeq;
        this.beginTurn(turnSeq);
        this.greetingActive = true;
        echoTelemetry.markWakeGreetingStart();
        this.scheduleFloat32Segment(cached.samples, cached.sampleRate, turnSeq, `wake-${turnSeq}`, fallbackText);
        this.markTurnAudioStreamFinished(turnSeq);
        return true;
      }
    }

    // Device SpeechSynthesis fallback
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(fallbackText);
        utt.lang = lang === 'vi' ? 'vi-VN' : 'en-US';
        utt.rate = lang === 'vi' ? 1.02 : 1.0;
        echoTelemetry.markWakeGreetingStart();
        window.speechSynthesis.speak(utt);
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  dispose(): void {
    this.unsubLogout?.();
    this.unsubLogout = null;
    this.unsubGestureUnlock?.();
    this.unsubGestureUnlock = null;
    this.hardCancel();
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.gainNode = null;
    this.earconGainNode = null;
    this.analyserNode = null;
  }
}
