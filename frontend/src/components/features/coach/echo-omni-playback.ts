import { authFetch } from '@/lib/api-session';
import { getBaseUrl } from '@/services/api-client';

export const OMNI_VOICES = ['us_female', 'us_male', 'uk_female', 'uk_male'] as const;
export type EchoSpeaker = typeof OMNI_VOICES[number] | 'device';

type Sentence = {
  text: string;
  voiceId: EchoSpeaker;
  start: () => void;
  done: (failed: boolean) => void;
};

/**
 * Streams commercial-clean 24 kHz PCM16LE from `/ai/chat/speech/stream` through a persistent WebAudio
 * `AudioContext -> GainNode -> AnalyserNode -> destination` graph (0.0 ms inter-chunk gap + live 32-bin
 * Bark FFT for Echo's 3D Living Entity), falling back to `/ai/chat/speech` WAV if streaming is unavailable.
 */
export class EchoOmniPlayback {
  private pending: Sentence[] = [];
  private controller = new AbortController();
  private running = false;
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private playingElement: HTMLAudioElement | null = null;
  private nextStartTime = 0;
  private release?: () => void;

  private ensureGraph(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!this.ctx || this.ctx.state === 'closed') {
      const ctx = new Ctor();
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.58;
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      this.ctx = ctx;
      this.gain = gain;
      this.analyser = analyser;
      try {
        window.dispatchEvent(new CustomEvent('ec:echo-analyser', { detail: { kind: 'tts', node: analyser } }));
      } catch {
        // Ignore custom event errors in restricted environments
      }
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  enqueue(text: string, voiceId: EchoSpeaker, start: () => void, done: (failed: boolean) => void) {
    this.pending.push({ text, voiceId, start, done });
    if (!this.running) void this.run();
  }

  private async run() {
    this.running = true;
    const signal = this.controller.signal;
    try {
      while (this.pending.length && !signal.aborted) {
        const item = this.pending.shift()!;
        const streamedOk = await this.playStreamingPcm(item, signal);
        if (signal.aborted) return;
        if (!streamedOk) {
          const wavOk = await this.playFallbackWav(item, signal);
          if (signal.aborted) return;
          item.done(!wavOk);
          if (!wavOk) return;
        } else {
          item.done(false);
        }
      }
    } finally {
      if (!signal.aborted) this.running = false;
    }
  }

  private async playStreamingPcm(item: Sentence, signal: AbortSignal): Promise<boolean> {
    const ctx = this.ensureGraph();
    if (!ctx || !this.gain) return false;
    try {
      const response = await authFetch(getBaseUrl() + '/ai/chat/speech/stream', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: item.voiceId, text: item.text }),
      });
      if (!response.ok || !response.body) return false;
      const sampleRate = Number(response.headers.get('x-sample-rate') || '24000') || 24000;
      const reader = response.body.getReader();
      let started = false;
      let carryByte: number | null = null;
      let lastEndPromise: Promise<void> = Promise.resolve();

      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;

          let bytes = value;
          if (carryByte !== null) {
            const merged = new Uint8Array(value.byteLength + 1);
            merged[0] = carryByte;
            merged.set(value, 1);
            bytes = merged;
            carryByte = null;
          }
          if (bytes.byteLength % 2 === 1) {
            carryByte = bytes[bytes.byteLength - 1];
            bytes = bytes.subarray(0, bytes.byteLength - 1);
          }
          if (bytes.byteLength < 2) continue;

          const sampleCount = bytes.byteLength >> 1;
          const floats = new Float32Array(sampleCount);
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          for (let i = 0; i < sampleCount; i++) {
            floats[i] = view.getInt16(i * 2, true) / 32768;
          }

          const audioBuf = ctx.createBuffer(1, sampleCount, sampleRate);
          audioBuf.copyToChannel(floats, 0);
          const src = ctx.createBufferSource();
          src.buffer = audioBuf;
          src.connect(this.gain);
          this.activeSources.add(src);

          const now = ctx.currentTime;
          const startAt = Math.max(now + 0.012, this.nextStartTime);
          this.nextStartTime = startAt + audioBuf.duration;

          if (!started) {
            started = true;
            item.start();
          }

          lastEndPromise = new Promise<void>((resolve) => {
            src.onended = () => {
              this.activeSources.delete(src);
              resolve();
            };
          });
          src.start(startAt);
        }
      } finally {
        reader.releaseLock();
      }

      if (!started) return false;
      await Promise.race([
        lastEndPromise,
        new Promise<void>((resolve) => {
          this.release = resolve;
        }),
      ]);
      this.release = undefined;
      return true;
    } catch {
      return false;
    }
  }

  private async playFallbackWav(item: Sentence, signal: AbortSignal): Promise<boolean> {
    try {
      const response = await authFetch(getBaseUrl() + '/ai/chat/speech', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: item.voiceId, text: item.text }),
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('audio/')) return false;
      const blob = await response.blob();
      if (signal.aborted || !blob.size) return false;

      const ctx = this.ensureGraph();
      if (ctx && this.gain) {
        try {
          const ab = await blob.arrayBuffer();
          const decoded = await ctx.decodeAudioData(ab.slice(0));
          if (signal.aborted) return false;
          const src = ctx.createBufferSource();
          src.buffer = decoded;
          src.connect(this.gain);
          this.activeSources.add(src);
          const startAt = Math.max(ctx.currentTime + 0.01, this.nextStartTime);
          this.nextStartTime = startAt + decoded.duration;
          item.start();
          await new Promise<void>((resolve) => {
            this.release = resolve;
            src.onended = () => {
              this.activeSources.delete(src);
              resolve();
            };
            src.start(startAt);
          });
          this.release = undefined;
          return true;
        } catch {
          // Fall through to HTMLAudioElement if decodeAudioData rejects
        }
      }

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.playingElement = audio;
      const ok = await new Promise<boolean>((resolve) => {
        this.release = () => resolve(true);
        audio.onplaying = () => item.start();
        audio.onended = () => resolve(true);
        audio.onerror = () => resolve(false);
        void audio.play().catch(() => resolve(false));
      });
      audio.onended = audio.onerror = audio.onplaying = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      this.playingElement = null;
      this.release = undefined;
      return ok;
    } catch {
      return false;
    }
  }

  stop() {
    this.controller.abort();
    for (const src of this.activeSources) {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already-stopped source
      }
    }
    this.activeSources.clear();
    this.nextStartTime = 0;
    this.playingElement?.pause();
    this.playingElement = null;
    this.release?.();
    this.release = undefined;
    this.pending = [];
    this.running = false;
    this.controller = new AbortController();
  }
}
