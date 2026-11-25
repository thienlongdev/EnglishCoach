export * from './audioSessionArbiter';
export * from './earcons';
export * from './zeroWasmNeural';
export * from './wakeWordDetector';
export * from './bargeInClassifier';
export * from './echoStreamingPlayback';
export * from './echoVoiceClient';
export * from './echoTelemetry';

import {
  audioSessionArbiter,
  type AudioLeaseHandle,
} from './audioSessionArbiter';
import {
  BargeInClassifier,
  isPureStopCommand,
  type BargeInDecision,
} from './bargeInClassifier';
import { type EchoEarconKind } from './earcons';
import {
  EchoStreamingPlayback,
  type EchoJarvisVoiceId,
  type WordTimingSpan,
} from './echoStreamingPlayback';
import { echoTelemetry } from './echoTelemetry';
import {
  EchoVoiceClient,
  EchoVoiceTurnError,
  type EchoVoiceClientCallbacks,
  type EchoVoiceSessionFlags,
} from './echoVoiceClient';
import {
  WakeWordDetector,
  type BargeInProbeEvent,
  type DetectorOperatingMode,
  type SingleBreathHandoffEvent,
  type SpeechEndpointEvent,
  type VadFrameTelemetry,
  type WakeDetectionEvent,
} from './wakeWordDetector';

export interface EchoJarvisRuntimeCallbacks extends EchoVoiceClientCallbacks {
  onWake?: (event: WakeDetectionEvent) => void;
  onSingleBreathCommand?: (event: SingleBreathHandoffEvent) => void;
  onVadFrame?: (frame: VadFrameTelemetry) => void;
  onBargeInDecision?: (decision: BargeInDecision) => void;
  onFollowupTimeout?: (info: { idleMs: number; timestampMs: number }) => void;
  onAnalyserReady?: (kind: 'mic' | 'tts', node: AnalyserNode) => void;
  /** Optional Plane-A (< 15 ms, 0 LLM) fast-path check before dispatching to backend brain. */
  onTryFastPathIntent?: (transcript: string, lang: 'en' | 'vi') => Promise<boolean> | boolean;
  /** Strictly passive page context (10 §AB: NEVER contains bookMeta / clientVisibleExcerpt). */
  getPageContext?: () => unknown;
  /** On-demand page context for explicit user turn commits (may include bounded book excerpt). */
  getTurnPageContext?: (transcript?: string) => unknown;
  getConversationHistory?: () => { role: string; content: string }[];
  getSalientResources?: () => readonly unknown[];
  getSessionFlags?: () => EchoVoiceSessionFlags;
}

export type EchoJarvisAudioCallbacks = EchoJarvisRuntimeCallbacks;

export interface EchoJarvisAudioSessionConfig {
  voiceId?: EchoJarvisVoiceId;
  locale?: 'en' | 'vi';
  sessionId?: number | null;
  handsFreeWake?: boolean;
  useDedicatedDspWorker?: boolean;
  callbacks?: EchoJarvisRuntimeCallbacks;
}

interface WorkletJarvisFrameMessage {
  type: 'jarvis-frame';
  seq: number;
  sampleRate: number;
  mic: Float32Array;
  ref: Float32Array | null;
  hasRef: boolean;
}

/**
 * High-level unified Echo JARVIS Audio Coordinator:
 * Bridges `/echo-mic-worklet.js` (`mode: 'jarvis-f32'`), dedicated Zero-WASM DSP worker
 * (`/echo-jarvis/echo-voice-dsp.worker.js` via direct `MessageChannel` pipe), Mic + TTS `AnalyserNode`s
 * (`fftSize = 512`, canonical `{ channel, analyser }` events), `WakeWordDetector`, `BargeInClassifier`,
 * `EchoStreamingPlayback`, `EchoVoiceClient`, `audioSessionArbiter`, and `echoTelemetry`.
 */
export class EchoJarvisAudioSession {
  readonly playback: EchoStreamingPlayback;
  readonly detector: WakeWordDetector;
  readonly bargeIn: BargeInClassifier;
  readonly voiceClient: EchoVoiceClient;

  private callbacks: EchoJarvisRuntimeCallbacks;
  private voiceId: EchoJarvisVoiceId;
  private locale: 'en' | 'vi';
  private handsFreeWake: boolean;
  private readonly useDedicatedDspWorker: boolean;

  private lease: AudioLeaseHandle | null = null;
  private currentLeaseScope: 'echo-hands-free-wake' | 'echo-active-voice' | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private dspWorker: Worker | null = null;
  private dspWorkerActive = false;
  private activeTurnSeq = 1;
  private committedTurnSeq = 0;
  private sentPrerollTurnSeq = 0;
  private lastUtterancePcm16: Int16Array | null = null;
  private greetingVoiceAbortMs = 0;
  private trackRebindTimer: ReturnType<typeof setTimeout> | null = null;
  private latestRef512: Float32Array | null = null;
  private running = false;
  private activeConversationMode = false;
  private waitingForResponse = false;
  private lastHardCancelledTurnSeq = -1;
  private lastTentativePauseTurnSeq = 0;
  private resumedSpeechAfterPause = false;
  private deviceFallbackSpeaking = false;
  private deviceFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private pcmCoalesce: {
    turnSeq: number;
    utteranceId: string;
    sampleRate: number;
    text: string;
    wordTimings?: WordTimingSpan[];
    chunks: Int16Array[];
    totalSamples: number;
    firstBufferedAtMs: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  constructor(config: EchoJarvisAudioSessionConfig = {}) {
    this.callbacks = config.callbacks ?? {};
    this.voiceId = config.voiceId ?? 'us_female';
    this.locale = config.locale ?? 'en';
    this.handsFreeWake = config.handsFreeWake ?? true;
    this.useDedicatedDspWorker = config.useDedicatedDspWorker ?? true;

    this.playback = new EchoStreamingPlayback({
      analyserFftSize: 512,
      onAnalyserReady: (_kind, node) => {
        this.callbacks.onAnalyserReady?.('tts', node);
      },
      onPlaybackStart: (turnSeq) => {
        this.greetingVoiceAbortMs = 0;
        if (!this.playback.isGreetingPlaying) {
          if (turnSeq > this.activeTurnSeq) {
            this.activeTurnSeq = turnSeq;
          }
          this.setDetectorWaitingForResponse(false);
        }
        this.setDetectorTtsPlaying(true);
        this.setDetectorMode('tts-speaking');
        this.bargeIn.resetForNewSpeech();
        this.callbacks.onEntityState?.('speaking', turnSeq);
      },
      onPlaybackEnd: (turnSeq) => {
        this.greetingVoiceAbortMs = 0;
        this.setDetectorTtsPlaying(false);
        this.setDetectorWaitingForResponse(false);
        const nextMode: DetectorOperatingMode = this.activeConversationMode
          ? 'active-listening'
          : this.handsFreeWake
            ? 'dormant'
            : 'disabled';
        this.setDetectorMode(nextMode);
        this.callbacks.onEntityState?.(
          nextMode === 'active-listening' ? 'listening' : nextMode === 'dormant' ? 'dormant' : 'disabled',
          turnSeq,
        );
      },
      onReferenceChunk16k: (ref512) => {
        this.latestRef512 = new Float32Array(ref512);
      },
    });
    this.installWebAudioPcmCoalescer();

    this.bargeIn = new BargeInClassifier();

    this.detector = new WakeWordDetector({
      onWakeDetected: (ev) => this.handleWakeDetected(ev),
      onSingleBreathCommand: (ev) => this.handleSingleBreathCommand(ev),
      onPostWakeGreetingCleared: () => {
        this.callbacks.onEntityState?.('listening', this.activeTurnSeq);
      },
      onVadFrame: (frame) => this.handleVadFrame(frame),
      onSpeechStart: ({ prerollPcm16 }) => this.handleSpeechStart(prerollPcm16),
      onStreamingPcm16: (pcm16, sampleOffset) => this.handleStreamingPcm16(pcm16, sampleOffset),
      onTentativePause: (info) => this.handleTentativePause(info),
      onSpeechEnd: (ev) => {
        void this.handleSpeechEnd(ev);
      },
      onBargeInProbeReady: (ev) => this.handleBargeInProbe(ev),
      onFollowupTimeout: (info) => this.handleFollowupTimeout(info),
    });

    this.voiceClient = new EchoVoiceClient({
      playback: this.playback,
      callbacks: {
        getSessionFlags: () =>
          this.callbacks.getSessionFlags?.() ?? {
            pathname: typeof window !== 'undefined' ? window.location.pathname : '/dashboard',
            hasPendingConfirmation: false,
            hasActiveStrictSentinel: false,
          },
        getConversationHistory: () => this.callbacks.getConversationHistory?.() ?? [],
        getSalientResources: () => this.callbacks.getSalientResources?.() ?? [],
        getPageContext: () => this.callbacks.getPageContext?.(),
        onConnectionChange: (c, t) => this.callbacks.onConnectionChange?.(c, t),
        onSessionReady: (info) => this.callbacks.onSessionReady?.(info),
        onVadState: (ev) => {
          this.callbacks.onVadState?.(ev);
          if (ev.turnSeq !== this.activeTurnSeq) return;
          if (ev.complete) {
            echoTelemetry.markEou();
            if (ev.state === 'eou_committed') {
              const resumedAfterTentativePause =
                this.lastTentativePauseTurnSeq === ev.turnSeq &&
                (this.resumedSpeechAfterPause || (!this.dspWorkerActive && this.detector.isTurnActivelyVoiced()));
              this.lastTentativePauseTurnSeq = 0;
              this.resumedSpeechAfterPause = false;
              if (resumedAfterTentativePause) {
                // User resumed speaking during Smart-Turn RTT after tentative pause: advance turnSeq and notify
                // server so Turn N merges cleanly into Turn N+1 without chopping the active utterance!
                this.activeTurnSeq = this.voiceClient.nextTurnSeq();
                this.committedTurnSeq = 0;
                this.setDetectorWaitingForResponse(false);
                void this.voiceClient.notifySpeechStarted(this.activeTurnSeq, this.callbacks.getPageContext?.());
                return;
              }
              // Server already committed via `autoCommit: true` -> abort local utterance buffer cleanly
              // so trailing endpoint silence NEVER sends a duplicate `input.commit` that cancels the turn!
              this.committedTurnSeq = ev.turnSeq;
              this.abortDetectorTurn();
              this.setDetectorWaitingForResponse(true);
              this.setDetectorMode('active-listening');
            } else {
              this.commitDetectorUtterance('smart-turn');
            }
          } else {
            this.setDetectorDynamicEndpointMs(ev.recommendedWaitMs);
          }
        },
        onAsrPartial: (info) => {
          this.callbacks.onAsrPartial?.(info);
          if (this.playback.isPlaying || this.playback.isPausedHold) {
            const dec = this.bargeIn.onTranscript(info.text, {
              isFinal: false,
              currentPlayedMs: this.playback.getPlayedMs(),
              currentSpokenText: this.playback.getSpokenTextSoFar(),
            });
            this.applyBargeInDecision(dec);
          }
        },
        onAsrFinal: (info) => {
          if (info.rejectedReason || !info.text) {
            // Silently drop Whisper hallucinations / empty frames and return to listening
            this.setDetectorWaitingForResponse(false);
            this.callbacks.onAsrFinal?.(info);
            return;
          }
          if (this.playback.isPlaying || this.playback.isPausedHold) {
            const dec = this.bargeIn.onTranscript(info.text, {
              isFinal: true,
              currentPlayedMs: this.playback.getPlayedMs(),
              currentSpokenText: this.playback.getSpokenTextSoFar(),
            });
            this.applyBargeInDecision(dec);
            if (dec.action === 'resume') return;
          }
          this.setDetectorWaitingForResponse(true);
          this.callbacks.onAsrFinal?.(info);
        },
        onActionClientPlan: (plan) => this.callbacks.onActionClientPlan?.(plan),
        onActionGuard: (guard) => {
          this.setDetectorWaitingForResponse(false);
          this.callbacks.onActionGuard?.(guard);
        },
        onBargeInServerDecision: (info) => {
          if (info.turnSeq < this.activeTurnSeq || info.turnSeq === this.lastHardCancelledTurnSeq) {
            return;
          }
          this.callbacks.onBargeInServerDecision?.(info);
          if (info.decision === 'backchannel') {
            if (!this.playback.isPlaying && !this.playback.isPausedHold) {
              return;
            }
            this.playback.resumeFromHold(60);
            this.voiceClient.notifyResumeHold(info.turnSeq);
            this.voiceClient.clearBackchannelBuffer(info.turnSeq);
            this.bargeIn.resetForNewSpeech();
          } else if (info.decision === 'interrupt') {
            this.lastHardCancelledTurnSeq = info.turnSeq;
            this.cancelDeviceFallbackSpeech();
            const pureStop = isPureStopCommand(info.text || '');
            const cancelled = this.playback.hardCancel();
            if (!cancelled.wasGreeting) {
              void this.voiceClient.cancelAndTruncateTurn({
                turnSeq: cancelled.turnSeq,
                playedMs: cancelled.playedMs,
                spokenText: cancelled.spokenTextSoFar,
              });
            }
            if (pureStop) {
              this.voiceClient.clearBackchannelBuffer(info.turnSeq);
            }
            this.activeConversationMode = true;
            this.setDetectorWaitingForResponse(false);
            this.setDetectorTtsPlaying(false);
            this.handoffBargeInToActiveTurn(!pureStop);
            this.callbacks.onEntityState?.('interrupted', cancelled.turnSeq);
            this.callbacks.onEntityState?.('listening', this.activeTurnSeq);
          }
        },
        onLlmDelta: (delta, full, turnSeq) => {
          this.bargeIn.recordEchoSpokenText(delta);
          this.callbacks.onLlmDelta?.(delta, full, turnSeq);
        },
        onActionsAndCards: (p) => this.callbacks.onActionsAndCards?.(p),
        onEntityState: (s, t, status) => {
          // Client-authoritative playback drain gate: keep entity state at 'speaking' until
          // browser speaker queue truly finishes draining and fires onPlaybackEnd!
          if (
            this.isSpeechOutputActive &&
            (s === 'listening' || s === 'thinking' || s === 'executing' || s === 'understanding')
          ) {
            return;
          }
          this.callbacks.onEntityState?.(s, t, status);
        },
        onTtsFallback: (info) => {
          this.callbacks.onTtsFallback?.(info);
          this.speakDeviceFallback(info.text, info.turnSeq);
        },
        onTurnComplete: (f, t, route, sessionId) => {
          if (!this.isSpeechOutputActive) {
            this.setDetectorWaitingForResponse(false);
            const nextMode: DetectorOperatingMode = this.activeConversationMode
              ? 'active-listening'
              : this.handsFreeWake
                ? 'dormant'
                : 'disabled';
            this.setDetectorMode(nextMode);
            this.callbacks.onTurnComplete?.(f, t, route, sessionId);
            this.callbacks.onEntityState?.(
              nextMode === 'active-listening' ? 'listening' : nextMode === 'dormant' ? 'dormant' : 'disabled',
              t,
            );
            return;
          }
          this.callbacks.onTurnComplete?.(f, t, route, sessionId);
        },
        onResponseCancelled: (t, reason) => {
          if (t >= this.activeTurnSeq && reason !== 'merged') {
            this.setDetectorWaitingForResponse(false);
          }
          this.callbacks.onResponseCancelled?.(t, reason);
        },
        onTurnTruncated: (info) => this.callbacks.onTurnTruncated?.(info),
        onToolConfirmed: (info) => this.callbacks.onToolConfirmed?.(info),
        onWsTurnDroppedBeforeOutput: ({ turnSeq, asrText, asrLang }) => {
          void this.recoverDroppedWsTurnViaHttp(turnSeq, asrText ?? '', asrLang ?? this.locale);
        },
        onError: (c, d, meta) => {
          this.setDetectorWaitingForResponse(false);
          this.callbacks.onError?.(c, d, meta);
        },
      },
    });

    this.voiceClient.setSessionConfig({
      sessionId: config.sessionId ?? null,
      voiceId: this.voiceId,
      locale: this.locale,
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isUsingDedicatedWorker(): boolean {
    return this.dspWorkerActive;
  }

  get isActiveConversation(): boolean {
    return this.activeConversationMode;
  }

  get isSpeechOutputActive(): boolean {
    return (
      this.playback.isPlaying ||
      this.playback.isPausedHold ||
      this.deviceFallbackSpeaking ||
      (this.pcmCoalesce !== null && this.pcmCoalesce.totalSamples > 0)
    );
  }

  /**
   * Coalesces 40 ms (`960`-sample) WS binary TTS packets into >= 200 ms (`>= 4,800`-sample)
   * gapless WebAudio buffers (while flushing the opening >= 200 ms buffer with 0 ms extra TTFA
   * and keeping >= 200 ms tail reserve) so every scheduled `AudioBufferSourceNode` is >= 200 ms
   * (distinct from < 150 ms earcons) and `onPlaybackEnd` fires at exact speaker drain.
   */
  private installWebAudioPcmCoalescer(): void {
    const rawEnqueuePcm16 = this.playback.enqueuePcm16.bind(this.playback);
    const rawMarkFinished = this.playback.markTurnAudioStreamFinished.bind(this.playback);
    const rawPauseHold = this.playback.pauseHold.bind(this.playback);
    const rawHardCancel = this.playback.hardCancel.bind(this.playback);
    const rawBeginTurn = this.playback.beginTurn.bind(this.playback);
    const rawDispose = this.playback.dispose.bind(this.playback);

    const toInt16 = (pcmBytes: ArrayBuffer | Uint8Array | Int16Array): Int16Array => {
      if (pcmBytes instanceof Int16Array) return pcmBytes;
      if (pcmBytes instanceof Uint8Array) {
        const evenLen = pcmBytes.byteLength & ~1;
        if (evenLen <= 0) return new Int16Array(0);
        if ((pcmBytes.byteOffset & 1) === 0) {
          return new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, evenLen >> 1);
        }
        const aligned = new Uint8Array(evenLen);
        aligned.set(pcmBytes.subarray(0, evenLen));
        return new Int16Array(aligned.buffer);
      }
      const evenLen = pcmBytes.byteLength & ~1;
      return evenLen > 0 ? new Int16Array(pcmBytes, 0, evenLen >> 1) : new Int16Array(0);
    };

    const popSamples = (state: NonNullable<EchoJarvisAudioSession['pcmCoalesce']>, count: number): void => {
      const take = Math.min(count, state.totalSamples);
      if (take <= 0) return;
      const out = new Int16Array(take);
      let written = 0;
      while (written < take && state.chunks.length > 0) {
        const head = state.chunks[0];
        const need = take - written;
        if (head.length <= need) {
          out.set(head, written);
          written += head.length;
          state.chunks.shift();
        } else {
          out.set(head.subarray(0, need), written);
          state.chunks[0] = head.subarray(need);
          written += need;
        }
      }
      state.totalSamples = Math.max(0, state.totalSamples - written);
      const text = state.text;
      const wordTimings = state.wordTimings;
      state.text = '';
      state.wordTimings = undefined;
      rawEnqueuePcm16(out, {
        turnSeq: state.turnSeq,
        utteranceId: state.utteranceId,
        sampleRate: state.sampleRate,
        text,
        wordTimings,
      });
    };

    const clearCoalesced = (): void => {
      if (!this.pcmCoalesce) return;
      if (this.pcmCoalesce.timer !== null) {
        clearTimeout(this.pcmCoalesce.timer);
      }
      this.pcmCoalesce = null;
    };

    const flushAllCoalesced = (): void => {
      if (!this.pcmCoalesce) return;
      if (this.pcmCoalesce.timer !== null) {
        clearTimeout(this.pcmCoalesce.timer);
        this.pcmCoalesce.timer = null;
      }
      const state = this.pcmCoalesce;
      this.pcmCoalesce = null;
      if (state.totalSamples > 0) {
        popSamples(state, state.totalSamples);
      }
    };

    this.playback.enqueuePcm16 = (pcmBytes, meta) => {
      if (meta.turnSeq < this.playback.currentTurnSeq) {
        return rawEnqueuePcm16(pcmBytes, meta);
      }
      if (this.playback.ensureAudioContext() === null) {
        return rawEnqueuePcm16(pcmBytes, meta);
      }
      const samples = toInt16(pcmBytes);
      if (samples.length === 0) return true;

      const sr = meta.sampleRate ?? 24000;
      const uttId = meta.utteranceId ?? `u-${meta.turnSeq}`;
      const minNodeSamples = Math.ceil(sr * 0.2); // 200 ms (>= 150 ms speech threshold)
      const batchSamples = Math.ceil(sr * 0.24); // 240 ms steady-state buffer

      if (this.pcmCoalesce) {
        if (meta.turnSeq > this.pcmCoalesce.turnSeq) {
          clearCoalesced();
        } else if (this.pcmCoalesce.utteranceId !== uttId || this.pcmCoalesce.sampleRate !== sr) {
          flushAllCoalesced();
        }
      }

      if (meta.turnSeq > this.playback.currentTurnSeq) {
        rawBeginTurn(meta.turnSeq);
      }

      let state = this.pcmCoalesce;
      if (!state) {
        state = {
          turnSeq: meta.turnSeq,
          utteranceId: uttId,
          sampleRate: sr,
          text: meta.text ?? '',
          wordTimings: meta.wordTimings,
          chunks: [new Int16Array(samples)],
          totalSamples: samples.length,
          firstBufferedAtMs: performance.now(),
          timer: null,
        };
        this.pcmCoalesce = state;
      } else {
        state.chunks.push(new Int16Array(samples));
        state.totalSamples += samples.length;
        if (meta.text) {
          state.text = state.text ? `${state.text} ${meta.text}` : meta.text;
        }
        if (meta.wordTimings && !state.wordTimings) {
          state.wordTimings = meta.wordTimings;
        }
      }

      if (!this.playback.isPlaying && !this.playback.isPausedHold && state.totalSamples >= minNodeSamples) {
        const firstTake = state.totalSamples < minNodeSamples * 2 ? state.totalSamples : minNodeSamples;
        popSamples(state, firstTake);
      }

      while (state.totalSamples >= batchSamples + minNodeSamples) {
        popSamples(state, batchSamples);
      }

      if (state.totalSamples === 0) {
        clearCoalesced();
        return true;
      }

      if (state.timer !== null) {
        clearTimeout(state.timer);
      }
      const armFlushTimer = (delayMs: number) => {
        const t = setTimeout(() => {
          if (this.pcmCoalesce !== state) return;
          state.timer = null;
          if (state.totalSamples >= minNodeSamples || performance.now() - state.firstBufferedAtMs >= 75) {
            flushAllCoalesced();
          } else {
            armFlushTimer(25);
          }
        }, delayMs);
        (t as unknown as { unref?: () => void })?.unref?.();
        state.timer = t;
      };
      armFlushTimer(18);
      return true;
    };

    this.playback.markTurnAudioStreamFinished = (turnSeq: number) => {
      if (this.pcmCoalesce && this.pcmCoalesce.turnSeq === turnSeq) {
        flushAllCoalesced();
      }
      rawMarkFinished(turnSeq);
    };

    this.playback.pauseHold = () => {
      if (this.pcmCoalesce) {
        flushAllCoalesced();
      }
      return rawPauseHold();
    };

    this.playback.hardCancel = () => {
      clearCoalesced();
      return rawHardCancel();
    };

    this.playback.beginTurn = (turnSeq: number) => {
      if (this.pcmCoalesce && turnSeq > this.pcmCoalesce.turnSeq) {
        clearCoalesced();
      }
      rawBeginTurn(turnSeq);
    };

    this.playback.dispose = () => {
      clearCoalesced();
      rawDispose();
    };
  }

  enterDormantStandby(): void {
    this.cancelDeviceFallbackSpeech();
    this.activeConversationMode = false;
    this.setDetectorWaitingForResponse(false);
    this.abortDetectorTurn();
    this.setDetectorTtsPlaying(false);
    this.setDetectorMode(this.handsFreeWake ? 'dormant' : 'disabled');
  }

  resumeActiveListening(): void {
    this.cancelDeviceFallbackSpeech();
    this.activeConversationMode = true;
    this.setDetectorWaitingForResponse(false);
    this.setDetectorTtsPlaying(false);
    this.setDetectorMode('active-listening');
  }

  /**
   * Mark a newly dispatched turn (e.g. typed text turn while voice session is live) as waiting for
   * server response so the 10 s follow-up idle timer pauses until Echo finishes responding.
   */
  markTurnWaitingForResponse(turnSeq?: number): void {
    if (typeof turnSeq === 'number' && Number.isFinite(turnSeq) && turnSeq > 0) {
      if (turnSeq > this.activeTurnSeq) {
        this.activeTurnSeq = turnSeq;
      }
      this.committedTurnSeq = turnSeq;
    }
    this.lastTentativePauseTurnSeq = 0;
    this.resumedSpeechAfterPause = false;
    this.abortDetectorTurn();
    this.setDetectorWaitingForResponse(true);
  }

  setPreferences(prefs: {
    voiceId?: EchoJarvisVoiceId;
    locale?: 'en' | 'vi';
    sessionId?: number | null;
    handsFreeWake?: boolean;
  }): void {
    if (prefs.voiceId) this.voiceId = prefs.voiceId;
    if (prefs.locale) this.locale = prefs.locale;
    if (typeof prefs.handsFreeWake === 'boolean') this.handsFreeWake = prefs.handsFreeWake;
    this.voiceClient.setSessionConfig({
      sessionId: prefs.sessionId,
      voiceId: prefs.voiceId,
      locale: prefs.locale,
    });
    if (this.voiceClient.isWsConnected) {
      const history = this.callbacks.getConversationHistory?.();
      this.voiceClient.updateSession({
        voiceId: this.voiceId,
        locale: this.locale,
        sessionId: prefs.sessionId,
        pageContext: this.callbacks.getPageContext?.(),
        messages: history && history.length > 0 ? history : undefined,
        salientResources: this.callbacks.getSalientResources?.(),
      });
    }
  }

  setFollowupExtended(extended: boolean): void {
    this.detector.setFollowupExtended(extended);
    this.dspWorker?.postMessage({ type: 'set-followup-extended', extended: Boolean(extended) });
  }

  playEarcon(kind: EchoEarconKind): boolean {
    return this.playback.playEarcon(kind);
  }

  /**
   * Start or transition the unified audio session without tearing down an already-live mic stream!
   */
  async start(mode: 'hands-free-dormant' | 'active-conversation' = 'hands-free-dormant'): Promise<boolean> {
    const scope = mode === 'active-conversation' ? 'echo-active-voice' : 'echo-hands-free-wake';
    if (!audioSessionArbiter.canJarvisOperate(scope)) {
      return false;
    }

    const wantActive = mode === 'active-conversation';
    this.activeConversationMode = wantActive;
    if (!wantActive) {
      // Starting in 'hands-free-dormant' explicitly arms wake-word monitoring so onPlaybackEnd
      // after the one-time welcome greeting returns to 'dormant' (NEVER 'disabled')!
      this.handsFreeWake = true;
    }

    // Acquire or upgrade arbiter lease only when scope changes or no lease exists
    if (!this.lease || !this.lease.isGranted() || this.currentLeaseScope !== scope) {
      this.lease?.release();
      this.currentLeaseScope = scope;
      this.lease = audioSessionArbiter.acquire(scope, 'echo-jarvis', {
        onSuspend: () => {
          const hadActiveTurn =
            this.playback.isPlaying ||
            this.playback.isPausedHold ||
            this.deviceFallbackSpeaking ||
            this.waitingForResponse;
          this.cancelDeviceFallbackSpeech();
          const cancelled = this.playback.hardCancel();
          if (!cancelled.wasGreeting && (hadActiveTurn || cancelled.playedMs > 0)) {
            void this.voiceClient.cancelAndTruncateTurn({
              turnSeq: cancelled.turnSeq || this.activeTurnSeq,
              playedMs: cancelled.playedMs,
              spokenText: cancelled.spokenTextSoFar,
            });
          }
          this.activeConversationMode = false;
          this.setDetectorWaitingForResponse(false);
          this.abortDetectorTurn();
          this.setDetectorTtsPlaying(false);
          this.setDetectorMode('disabled');
          this.callbacks.onEntityState?.(
            this.handsFreeWake ? 'dormant' : 'disabled',
            this.activeTurnSeq,
          );
        },
        onResume: () => {
          if (!this.running) return;
          this.activeConversationMode = false;
          this.setDetectorWaitingForResponse(false);
          this.abortDetectorTurn();
          this.setDetectorTtsPlaying(false);
          if (this.handsFreeWake) {
            this.setDetectorMode('dormant');
            this.callbacks.onEntityState?.('dormant', this.activeTurnSeq);
          } else {
            this.stop();
            this.callbacks.onEntityState?.('disabled', this.activeTurnSeq);
          }
        },
        onForceTeardown: () => {
          this.stop();
        },
        onDeviceChange: () => {
          if (this.running) {
            void this.rebindMicrophone();
          }
        },
      });

      if (!this.lease.isGranted()) {
        this.lease.release();
        this.lease = null;
        this.currentLeaseScope = null;
        return false;
      }
      if (this.micStream) {
        this.lease.attachStream(this.micStream);
      }
    }

    // Reuse already-active mic stream + worklet + worker with ZERO getUserMedia churn!
    const micAlive = Boolean(
      this.running &&
        this.micStream &&
        this.micStream.active &&
        this.workletNode &&
        this.micStream.getAudioTracks().some((t) => t.readyState === 'live'),
    );

    if (!micAlive) {
      if (!this.dspWorkerActive) {
        void this.detector.loadWeightsFromPublic('/echo-jarvis/models');
      }
      const micOk = await this.rebindMicrophone();
      if (!micOk) {
        this.lease.release();
        this.lease = null;
        this.currentLeaseScope = null;
        return false;
      }
    }

    this.running = true;
    this.setDetectorMode(wantActive ? 'active-listening' : 'dormant');

    if (wantActive && !this.voiceClient.isWsConnected && !this.voiceClient.isConnecting) {
      void this.voiceClient.connect({
        pageContext: this.callbacks.getPageContext?.(),
        mode: 'hands_free',
        locale: this.locale,
        lang: 'auto',
        messages: this.callbacks.getConversationHistory?.(),
        salientResources: this.callbacks.getSalientResources?.(),
      });
    }

    return true;
  }

  private setDetectorMode(nextMode: DetectorOperatingMode): void {
    this.detector.setMode(nextMode);
    if (this.dspWorkerActive && this.dspWorker) {
      this.dspWorker.postMessage({ type: 'set-mode', mode: nextMode });
    }
  }

  private setDetectorTtsPlaying(playing: boolean): void {
    this.detector.setTtsPlaying(playing);
    if (this.dspWorkerActive && this.dspWorker) {
      this.dspWorker.postMessage({ type: 'set-tts-playing', playing });
    }
  }

  private setDetectorDynamicEndpointMs(waitMs: number): void {
    this.detector.setDynamicEndpointSilenceMs(waitMs);
    if (this.dspWorkerActive && this.dspWorker) {
      this.dspWorker.postMessage({ type: 'set-dynamic-endpoint-ms', waitMs });
    }
  }

  private setDetectorOutputLatencyMs(latencyMs: number): void {
    this.detector.setOutputLatencyMs(latencyMs);
    if (this.dspWorkerActive && this.dspWorker) {
      this.dspWorker.postMessage({ type: 'set-output-latency-ms', latencyMs });
    }
  }

  private commitDetectorUtterance(reason: SpeechEndpointEvent['reason']): void {
    if (this.dspWorkerActive && this.dspWorker) {
      this.dspWorker.postMessage({ type: 'commit', reason });
      return;
    }
    this.detector.commitActiveUtterance(reason);
  }

  private abortDetectorTurn(): void {
    this.detector.abortActiveTurn();
    if (this.dspWorkerActive && this.dspWorker) {
      this.dspWorker.postMessage({ type: 'abort-turn' });
    }
  }

  private setDetectorWaitingForResponse(waiting: boolean): void {
    this.waitingForResponse = waiting;
    this.detector.setWaitingForResponse(waiting);
    if (this.dspWorkerActive && this.dspWorker) {
      this.dspWorker.postMessage({ type: 'set-waiting-response', waiting });
    }
  }

  private handoffBargeInToActiveTurn(startTurn: boolean): void {
    if (this.dspWorkerActive && this.dspWorker) {
      this.detector.setTtsPlaying(false);
      this.detector.setMode('active-listening');
      this.dspWorker.postMessage({ type: 'barge-in-handoff', startTurn });
      return;
    }
    this.detector.handoffBargeInToActiveTurn(startTurn);
  }

  private initDedicatedDspWorker(worklet: AudioWorkletNode, outputLatencyMs: number): boolean {
    if (
      !this.useDedicatedDspWorker ||
      typeof Worker === 'undefined' ||
      typeof MessageChannel === 'undefined'
    ) {
      return false;
    }

    this.teardownDspWorker();

    try {
      const worker = new Worker('/echo-jarvis/echo-voice-dsp.worker.js');
      const channel = new MessageChannel();

      worker.onmessage = (ev: MessageEvent) => {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'vad-frame':
            this.handleVadFrame(msg as VadFrameTelemetry);
            break;
          case 'wake':
            this.handleWakeDetected(msg as WakeDetectionEvent);
            break;
          case 'single-breath':
            this.handleSingleBreathCommand({
              phrase: msg.phrase,
              timestampMs: msg.timestampMs,
              postWakeVoicedMs: msg.postWakeVoicedMs,
              turn1OpeningPcmF32: new Float32Array(0),
              turn1OpeningPcm16: msg.turn1OpeningPcm16,
            });
            break;
          case 'post-wake-cleared':
            this.callbacks.onEntityState?.('listening', this.activeTurnSeq);
            break;
          case 'speech-start':
            this.handleSpeechStart(msg.prerollPcm16);
            break;
          case 'streaming-pcm16':
            this.handleStreamingPcm16(msg.pcm16, msg.sampleOffset);
            break;
          case 'tentative-pause':
            this.handleTentativePause({
              silenceMs: msg.silenceMs,
              voicedMs: msg.voicedMs,
              recentPcm16: msg.recentPcm16,
            });
            break;
          case 'speech-end':
            void this.handleSpeechEnd({
              reason: msg.reason,
              voicedMs: msg.voicedMs,
              totalMs: msg.totalMs,
              peakSnrDb: msg.peakSnrDb,
              utterancePcm16: msg.utterancePcm16,
            });
            break;
          case 'barge-in-probe':
            this.handleBargeInProbe({
              pcm16: msg.pcm16,
              voicedMs: msg.voicedMs,
              timestampMs: msg.timestampMs,
            });
            break;
          case 'followup-timeout':
            this.handleFollowupTimeout({ idleMs: msg.idleMs, timestampMs: msg.timestampMs });
            break;
          default:
            break;
        }
      };

      worker.onerror = () => {
        // Fallback cleanly to main-thread detector without dropping the mic stream
        this.dspWorkerActive = false;
        this.teardownDspWorker();
        try {
          worklet.port.postMessage({ type: 'detach-worker-port' });
        } catch {
          // Ignore
        }
        void this.detector.loadWeightsFromPublic('/echo-jarvis/models');
      };

      // Wire direct AudioWorklet -> Dedicated Worker zero-hop pipe!
      worker.postMessage({ type: 'attach-worklet-port', port: channel.port2 }, [channel.port2]);
      worklet.port.postMessage({ type: 'attach-worker-port', port: channel.port1 }, [channel.port1]);
      worker.postMessage({ type: 'set-output-latency-ms', latencyMs: outputLatencyMs });
      worker.postMessage({ type: 'load-weights', baseUrl: '/echo-jarvis/models' });

      this.dspWorker = worker;
      this.dspWorkerActive = true;
      return true;
    } catch {
      this.dspWorkerActive = false;
      this.teardownDspWorker();
      return false;
    }
  }

  private teardownDspWorker(): void {
    if (this.dspWorker) {
      this.dspWorker.onmessage = null;
      this.dspWorker.onerror = null;
      try {
        this.dspWorker.terminate();
      } catch {
        // Ignore
      }
      this.dspWorker = null;
    }
    this.dspWorkerActive = false;
  }

  private async rebindMicrophone(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return false;
    }

    this.teardownMicNodesOnly();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!this.lease || !this.lease.isGranted()) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }

      this.micStream = stream;
      this.lease.attachStream(stream);
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          if (!this.running || !this.lease || !this.lease.isGranted()) return;
          if (this.trackRebindTimer) clearTimeout(this.trackRebindTimer);
          this.trackRebindTimer = setTimeout(() => {
            this.trackRebindTimer = null;
            if (this.running && this.lease && this.lease.isGranted()) {
              void this.rebindMicrophone();
            }
          }, 300);
        };
      }

      const ctx = this.playback.ensureAudioContext();
      if (!ctx) return false;
      await ctx.audioWorklet.addModule('/echo-mic-worklet.js');
      if (ctx.state === 'suspended') {
        await Promise.race([
          ctx.resume().catch(() => {}),
          new Promise<void>((r) => {
            const t = setTimeout(r, 150);
            (t as unknown as { unref?: () => void })?.unref?.();
          }),
        ]);
      }

      const outputLatencyMs = this.playback.getOutputLatencyMs();
      this.detector.setOutputLatencyMs(outputLatencyMs);

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;

      const worklet = new AudioWorkletNode(ctx, 'echo-microphone', {
        numberOfInputs: 2,
        numberOfOutputs: 0,
        processorOptions: {
          mode: 'jarvis-f32',
          inputSampleRate: ctx.sampleRate,
        },
      });

      source.connect(analyser);
      source.connect(worklet, 0, 0);
      this.playback.connectReferenceToWorklet(worklet);

      // Keep main-thread handler attached as fallback if worker detaches or is unavailable
      worklet.port.onmessage = (ev: MessageEvent<WorkletJarvisFrameMessage>) => {
        const data = ev.data;
        if (!data || data.type !== 'jarvis-frame') return;
        const ref = data.hasRef && data.ref ? data.ref : this.latestRef512;
        this.latestRef512 = null;
        this.detector.processFrame512(data.mic, ref);
      };

      const workerStarted = this.initDedicatedDspWorker(worklet, outputLatencyMs);
      if (!workerStarted) {
        void this.detector.loadWeightsFromPublic('/echo-jarvis/models');
      }

      this.micSource = source;
      this.micAnalyser = analyser;
      this.workletNode = worklet;
      this.callbacks.onAnalyserReady?.('mic', analyser);
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try {
          // Canonical Contract B payload: `{ channel: 'mic', analyser }`
          window.dispatchEvent(new CustomEvent('ec:echo-analyser', { detail: { channel: 'mic', analyser } }));
        } catch {
          // Ignore custom event errors
        }
      }
      return true;
    } catch (err) {
      this.teardownMicNodesOnly();
      const errCode = err instanceof Error && err.name ? err.name : 'mic_unavailable';
      this.callbacks.onError?.(errCode, err instanceof Error ? err.message : undefined);
      return false;
    }
  }

  private handleVadFrame(frame: VadFrameTelemetry): void {
    this.callbacks.onVadFrame?.(frame);
    if (this.lastTentativePauseTurnSeq === this.activeTurnSeq && !frame.echoSuppressed && frame.pSpeech >= 0.35) {
      this.resumedSpeechAfterPause = true;
    }
    if (this.playback.isGreetingPlaying) {
      const speakingOverGreeting =
        !frame.echoSuppressed &&
        frame.pSpeech >= 0.52 &&
        (Boolean(frame.doubleTalkDetected) || frame.postNlmsSnrDb >= 5.5);
      if (speakingOverGreeting) {
        this.greetingVoiceAbortMs += 32;
        if (this.greetingVoiceAbortMs >= 96) {
          this.greetingVoiceAbortMs = 0;
          this.activeConversationMode = true;
          this.playback.hardCancel();
          this.setDetectorTtsPlaying(false);
          this.handoffBargeInToActiveTurn(true);
        }
      } else {
        this.greetingVoiceAbortMs = 0;
      }
      return;
    }
    if (this.playback.isPlaying || this.playback.isPausedHold) {
      const dec = this.bargeIn.onAudioFrame({
        pSpeech: frame.pSpeech,
        postNlmsSnrDb: frame.postNlmsSnrDb,
        echoSuppressed: frame.echoSuppressed,
        doubleTalkDetected: frame.doubleTalkDetected,
        benestyNcc: frame.benestyNcc,
        currentPlayedMs: this.playback.getPlayedMs(),
        currentSpokenText: this.playback.getSpokenTextSoFar(),
        timestampMs: frame.timestampMs,
        usingDeviceSpeechSynthesis: this.voiceId === 'device',
      });
      this.applyBargeInDecision(dec);
    }
  }

  private handleSpeechStart(prerollPcm16: Int16Array): void {
    this.cancelDeviceFallbackSpeech();
    this.activeConversationMode = true;
    this.committedTurnSeq = 0;
    this.lastTentativePauseTurnSeq = 0;
    this.resumedSpeechAfterPause = false;
    this.setDetectorWaitingForResponse(false);
    this.activeTurnSeq = this.voiceClient.nextTurnSeq();
    void this.voiceClient.notifySpeechStarted(this.activeTurnSeq, this.callbacks.getPageContext?.());
    if (prerollPcm16.length > 0) {
      this.sentPrerollTurnSeq = this.activeTurnSeq;
      this.voiceClient.sendMicPcm16(this.activeTurnSeq, 0, prerollPcm16);
    } else {
      this.sentPrerollTurnSeq = 0;
    }
    this.callbacks.onEntityState?.('listening', this.activeTurnSeq);
  }

  private handleStreamingPcm16(pcm16: Int16Array, sampleOffset: number): void {
    if (this.committedTurnSeq === this.activeTurnSeq) return;
    if (sampleOffset === 0 && this.sentPrerollTurnSeq === this.activeTurnSeq) return;
    if (this.voiceClient.isWsConnected || this.voiceClient.isConnecting) {
      this.voiceClient.sendMicPcm16(this.activeTurnSeq, sampleOffset, pcm16);
    }
  }

  private handleTentativePause(info: { silenceMs: number; voicedMs: number; recentPcm16: Int16Array }): void {
    const reqTurnSeq = this.activeTurnSeq;
    if (this.committedTurnSeq === reqTurnSeq) return;
    this.lastTentativePauseTurnSeq = reqTurnSeq;
    this.resumedSpeechAfterPause = false;
    if (this.voiceClient.isWsConnected) {
      const flags = this.callbacks.getSessionFlags?.();
      // Zero extra PCM upload & zero extra WAN RTT: server auto-commits on complete with 1-to-1 commitInput metadata!
      this.voiceClient.sendTurnCheck(reqTurnSeq, true, {
        locale: this.locale,
        voiceId: this.voiceId,
        pathname: flags?.pathname,
        hasPendingConfirmation: flags?.hasPendingConfirmation,
        hasActiveStrictSentinel: flags?.hasActiveStrictSentinel,
        pageContext: this.callbacks.getTurnPageContext?.() ?? this.callbacks.getPageContext?.(),
        messages: this.callbacks.getConversationHistory?.(),
        salientResources: this.callbacks.getSalientResources?.(),
      });
      return;
    }
    void this.voiceClient.checkSmartTurn(info.recentPcm16).then((res) => {
      if (reqTurnSeq !== this.activeTurnSeq || this.committedTurnSeq === reqTurnSeq) return;
      if (res.complete) {
        echoTelemetry.markEou();
        this.commitDetectorUtterance('smart-turn');
      } else {
        this.setDetectorDynamicEndpointMs(res.recommendedWaitMs);
      }
    });
  }

  private handleBargeInProbe(ev: BargeInProbeEvent): void {
    if (!this.playback.isPlaying && !this.playback.isPausedHold) return;
    if (this.playback.isGreetingPlaying) return;
    this.voiceClient.sendBargeInProbe(this.activeTurnSeq, ev.pcm16, 'auto');
  }

  private handleFollowupTimeout(info: { idleMs: number; timestampMs: number }): void {
    this.activeConversationMode = false;
    this.setDetectorWaitingForResponse(false);
    if (this.handsFreeWake) {
      this.setDetectorMode('dormant');
      this.callbacks.onFollowupTimeout?.(info);
      this.callbacks.onEntityState?.('dormant', this.activeTurnSeq);
      if (!this.callbacks.getSessionFlags?.()?.hasPendingConfirmation) {
        this.voiceClient.disconnectIdle();
      }
    } else {
      this.stop();
      this.callbacks.onFollowupTimeout?.(info);
      this.callbacks.onEntityState?.('disabled', this.activeTurnSeq);
    }
  }

  /**
   * Wake Detected:
   * - NEVER plays a spoken greeting! (Single-Greeting invariant lives strictly in `EchoJarvisRuntime`!)
   * - Plays ONLY the crisp 65 ms procedural `'wake'` earcon.
   * - Preserves `'post-wake-window'` untouched so Single-Breath Wake + Command streams seamlessly!
   */
  private handleWakeDetected(ev: WakeDetectionEvent): void {
    echoTelemetry.markWakeUiReady();
    this.activeConversationMode = true;
    this.setDetectorWaitingForResponse(false);
    this.playback.playEarcon('wake');
    this.callbacks.onWake?.(ev);

    // Pre-open WS in parallel so Turn 1 streams immediately with zero handshake stall
    if (!this.voiceClient.isWsConnected && !this.voiceClient.isConnecting) {
      void this.voiceClient.connect({
        pageContext: this.callbacks.getPageContext?.(),
        mode: 'hands_free',
        locale: this.locale,
        lang: 'auto',
        messages: this.callbacks.getConversationHistory?.(),
        salientResources: this.callbacks.getSalientResources?.(),
      });
    }
  }

  private handleSingleBreathCommand(ev: SingleBreathHandoffEvent): void {
    this.cancelDeviceFallbackSpeech();
    this.activeConversationMode = true;
    this.committedTurnSeq = 0;
    this.lastTentativePauseTurnSeq = 0;
    this.resumedSpeechAfterPause = false;
    this.setDetectorWaitingForResponse(false);
    this.activeTurnSeq = this.voiceClient.nextTurnSeq();
    void this.voiceClient.notifySpeechStarted(this.activeTurnSeq, this.callbacks.getPageContext?.());
    if (ev.turn1OpeningPcm16.length > 0) {
      this.sentPrerollTurnSeq = this.activeTurnSeq;
      this.voiceClient.sendMicPcm16(this.activeTurnSeq, 0, ev.turn1OpeningPcm16);
    } else {
      this.sentPrerollTurnSeq = 0;
    }
    this.callbacks.onSingleBreathCommand?.(ev);
  }

  private applyBargeInDecision(dec: BargeInDecision): void {
    if (dec.action === 'none') return;
    this.callbacks.onBargeInDecision?.(dec);

    if (dec.action === 'soft_duck') {
      this.playback.softDuck(-12, dec.rampMs);
    } else if (dec.action === 'pause_hold') {
      const playedMs = this.playback.pauseHold();
      this.voiceClient.notifyPauseHold(this.activeTurnSeq, playedMs);
    } else if (dec.action === 'resume') {
      this.playback.resumeFromHold(dec.rampMs);
      this.voiceClient.notifyResumeHold(this.activeTurnSeq);
      if (dec.purgeAudio) {
        this.voiceClient.clearBackchannelBuffer(this.activeTurnSeq);
      }
    } else if (dec.action === 'hard_cancel') {
      const pureStop = isPureStopCommand(dec.transcript || '');
      this.cancelDeviceFallbackSpeech();
      const cancelled = this.playback.hardCancel();
      this.lastHardCancelledTurnSeq = cancelled.turnSeq;
      if (!cancelled.wasGreeting) {
        void this.voiceClient.cancelAndTruncateTurn({
          turnSeq: cancelled.turnSeq,
          playedMs: dec.playedMs || cancelled.playedMs,
          spokenText: dec.spokenSoFar || cancelled.spokenTextSoFar,
        });
      }
      if (pureStop) {
        this.voiceClient.clearBackchannelBuffer(this.activeTurnSeq);
      }
      this.activeConversationMode = true;
      this.setDetectorWaitingForResponse(false);
      this.setDetectorTtsPlaying(false);
      this.handoffBargeInToActiveTurn(!pureStop);
      this.callbacks.onEntityState?.('interrupted', cancelled.turnSeq);
      this.callbacks.onEntityState?.('listening', this.activeTurnSeq);
    }
  }

  private async handleSpeechEnd(ev: SpeechEndpointEvent): Promise<void> {
    this.lastUtterancePcm16 = ev.utterancePcm16;
    if (this.committedTurnSeq === this.activeTurnSeq) {
      return;
    }
    this.committedTurnSeq = this.activeTurnSeq;
    this.setDetectorWaitingForResponse(true);

    if (this.voiceClient.isWsConnected || this.voiceClient.isConnecting) {
      const sent = this.voiceClient.commitInput(this.activeTurnSeq, {
        sampleCount: ev.utterancePcm16.length,
        lang: 'auto',
        locale: this.locale,
        voiceId: this.voiceId,
        pageContext: this.callbacks.getTurnPageContext?.() ?? this.callbacks.getPageContext?.(),
        messages: this.callbacks.getConversationHistory?.(),
        salientResources: this.callbacks.getSalientResources?.(),
      });
      if (sent) {
        return;
      }
    }

    await this.executeHttpVoiceTurnFromPcm(this.activeTurnSeq, ev.utterancePcm16);
  }

  private async executeHttpVoiceTurnFromPcm(turnSeq: number, pcm16: Int16Array): Promise<void> {
    try {
      const stt = await this.voiceClient.transcribeHttp(pcm16, 'auto');
      if (!stt.text || stt.rejectedReason) {
        this.setDetectorWaitingForResponse(false);
        if (this.activeConversationMode) {
          this.setDetectorMode('active-listening');
        }
        this.callbacks.onEntityState?.('listening', turnSeq);
        return;
      }
      this.callbacks.onAsrFinal?.({
        text: stt.text,
        lang: stt.language,
        reviewNeeded: stt.reviewNeeded,
        turnSeq,
        rejectedReason: stt.rejectedReason,
      });

      const handledLocally = await this.callbacks.onTryFastPathIntent?.(stt.text, stt.language);
      if (handledLocally) {
        this.setDetectorWaitingForResponse(false);
        return;
      }

      await this.voiceClient.executeHttpFallbackTurn({
        turnSeq,
        message: stt.text,
        history: this.callbacks.getConversationHistory?.(),
        pageContext: this.callbacks.getTurnPageContext?.(stt.text) ?? this.callbacks.getPageContext?.(),
        salientResources: this.callbacks.getSalientResources?.(),
        locale: stt.language,
        voiceId: this.voiceId,
      });
      if (!this.isSpeechOutputActive) {
        this.setDetectorWaitingForResponse(false);
        if (this.activeConversationMode) {
          this.setDetectorMode('active-listening');
          this.callbacks.onEntityState?.('listening', turnSeq);
        }
      }
    } catch (err) {
      this.setDetectorWaitingForResponse(false);
      if (err instanceof EchoVoiceTurnError) {
        this.callbacks.onError?.(err.code, err.message, err.meta);
      } else {
        const code = err instanceof Error ? err.message : 'service_busy';
        this.callbacks.onError?.(code);
      }
    }
  }

  private async recoverDroppedWsTurnViaHttp(
    turnSeq: number,
    asrText: string,
    asrLang: 'en' | 'vi',
  ): Promise<void> {
    if (!this.running) return;
    if (asrText) {
      try {
        const handledLocally = await this.callbacks.onTryFastPathIntent?.(asrText, asrLang);
        if (handledLocally) {
          this.setDetectorWaitingForResponse(false);
          return;
        }
        await this.voiceClient.executeHttpFallbackTurn({
          turnSeq,
          message: asrText,
          history: this.callbacks.getConversationHistory?.(),
          pageContext: this.callbacks.getTurnPageContext?.(asrText) ?? this.callbacks.getPageContext?.(),
          salientResources: this.callbacks.getSalientResources?.(),
          locale: asrLang,
          voiceId: this.voiceId,
        });
        if (!this.isSpeechOutputActive) {
          this.setDetectorWaitingForResponse(false);
          if (this.activeConversationMode) {
            this.setDetectorMode('active-listening');
            this.callbacks.onEntityState?.('listening', turnSeq);
          }
        }
      } catch (err) {
        this.setDetectorWaitingForResponse(false);
        if (err instanceof EchoVoiceTurnError) {
          this.callbacks.onError?.(err.code, err.message, err.meta);
        } else {
          this.callbacks.onError?.(err instanceof Error ? err.message : 'connection_interrupted');
        }
      }
      return;
    }

    if (this.lastUtterancePcm16 && this.lastUtterancePcm16.byteLength >= 3200) {
      await this.executeHttpVoiceTurnFromPcm(turnSeq, this.lastUtterancePcm16);
      return;
    }

    this.setDetectorWaitingForResponse(false);
    this.callbacks.onError?.('connection_interrupted', undefined, { recoverable: true });
  }

  private cancelDeviceFallbackSpeech(): void {
    if (this.deviceFallbackTimer !== null) {
      clearTimeout(this.deviceFallbackTimer);
      this.deviceFallbackTimer = null;
    }
    if (this.deviceFallbackSpeaking) {
      this.deviceFallbackSpeaking = false;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // Ignore device SpeechSynthesis errors
        }
      }
    }
  }

  private speakDeviceFallback(text: string, turnSeq = this.activeTurnSeq): void {
    if (!text || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    this.cancelDeviceFallbackSpeech();
    try {
      window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = this.locale === 'vi' ? 'vi-VN' : 'en-US';
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.deviceFallbackTimer !== null) {
          clearTimeout(this.deviceFallbackTimer);
          this.deviceFallbackTimer = null;
        }
        if (!this.deviceFallbackSpeaking) return;
        this.deviceFallbackSpeaking = false;
        this.setDetectorTtsPlaying(false);
        this.setDetectorWaitingForResponse(false);
        const nextMode: DetectorOperatingMode = this.activeConversationMode
          ? 'active-listening'
          : this.handsFreeWake
            ? 'dormant'
            : 'disabled';
        this.setDetectorMode(nextMode);
        this.callbacks.onEntityState?.(
          nextMode === 'active-listening' ? 'listening' : nextMode === 'dormant' ? 'dormant' : 'disabled',
          turnSeq,
        );
      };
      utt.onend = finish;
      utt.onerror = finish;
      this.deviceFallbackSpeaking = true;
      this.setDetectorWaitingForResponse(false);
      this.setDetectorTtsPlaying(true);
      this.setDetectorMode('tts-speaking');
      this.callbacks.onEntityState?.('speaking', turnSeq);
      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
      const watchdogMs = Math.min(45_000, Math.max(2_500, wordCount * 480 + 1_500));
      this.deviceFallbackTimer = setTimeout(finish, watchdogMs);
      (this.deviceFallbackTimer as unknown as { unref?: () => void })?.unref?.();
      window.speechSynthesis.speak(utt);
    } catch {
      this.deviceFallbackSpeaking = false;
    }
  }

  private teardownMicNodesOnly(): void {
    if (this.trackRebindTimer) {
      clearTimeout(this.trackRebindTimer);
      this.trackRebindTimer = null;
    }
    this.teardownDspWorker();
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      try {
        this.workletNode.disconnect();
      } catch {
        // Ignore
      }
      this.workletNode = null;
    }
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        // Ignore
      }
      this.micSource = null;
    }
    this.micAnalyser = null;
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      this.micStream = null;
    }
  }

  stop(): void {
    this.running = false;
    this.activeConversationMode = false;
    this.committedTurnSeq = 0;
    this.sentPrerollTurnSeq = 0;
    this.lastHardCancelledTurnSeq = -1;
    this.lastTentativePauseTurnSeq = 0;
    this.resumedSpeechAfterPause = false;
    this.lastUtterancePcm16 = null;
    this.greetingVoiceAbortMs = 0;
    this.cancelDeviceFallbackSpeech();
    this.setDetectorWaitingForResponse(false);
    this.setDetectorMode('disabled');
    this.teardownMicNodesOnly();
    this.playback.hardCancel();
    this.voiceClient.disconnectImmediate();
    this.lease?.release();
    this.lease = null;
    this.currentLeaseScope = null;
  }

  dispose(): void {
    this.stop();
    this.playback.dispose();
    this.voiceClient.dispose();
  }
}
