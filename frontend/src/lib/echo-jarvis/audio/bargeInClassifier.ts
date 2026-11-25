import { echoTelemetry } from './echoTelemetry';

// Bilingual EN + VI Supportive Backchannels (normalized lowercase, stripped of punctuation).
// Echo MUST auto-resume smoothly (Gain -> 1.0 in 60 ms) and purge backchannel audio!
export const BACKCHANNEL_SET: ReadonlySet<string> = new Set([
  // English
  'uh-huh',
  'uh huh',
  'mm-hmm',
  'mm hmm',
  'mhm',
  'hmm',
  'uh',
  'um',
  'yeah',
  'yep',
  'yup',
  'okay',
  'ok',
  'right',
  'got it',
  'i see',
  'sure',
  'ah',
  'oh',
  // Vietnamese
  'ừ',
  'ừm',
  'ờ',
  'ờm',
  'à',
  'à há',
  'vâng',
  'dạ',
  'dạ vâng',
  'ô kê',
  'đúng',
  'đúng rồi',
  'hiểu rồi',
  'rồi',
]);

// Bilingual EN + VI Floor-Taking Imperatives & Hard-Cancel Triggers (< 50 ms stop!).
export const HARD_CANCEL_SET: ReadonlySet<string> = new Set([
  // English
  'stop',
  'wait',
  'hold on',
  'pause',
  'cancel',
  'no',
  'nope',
  'actually',
  'quiet',
  'enough',
  'hey echo',
  'hi echo',
  'echo stop',
  'open',
  'go to',
  'skip',
  'next',
  // Vietnamese
  'dừng',
  'dừng lại',
  'khoan',
  'khoan đã',
  'đợi chút',
  'đợi đã',
  'từ từ',
  'thôi',
  'hủy',
  'không',
  'mở',
  'chuyển',
  'qua phần',
  'tiếp theo',
]);

export type BargeInState = 'Speaking' | 'SoftDuck' | 'PausedHold' | 'HardCancelled';

export type BargeInDecision =
  | { action: 'none'; state: BargeInState }
  | {
      action: 'soft_duck';
      state: 'SoftDuck';
      gainTarget: number; // 0.251 (-12 dB)
      rampMs: number; // 35 ms
      voicedMs: number;
    }
  | {
      action: 'pause_hold';
      state: 'PausedHold';
      pausedAtPlayedMs: number;
      voicedMs: number;
    }
  | {
      action: 'resume';
      state: 'Speaking';
      reason: 'backchannel' | 'transient-noise' | 'echo-leak';
      gainTarget: 1.0;
      rampMs: 60;
      purgeAudio: boolean;
    }
  | {
      action: 'hard_cancel';
      state: 'HardCancelled';
      reason: 'hard-keyword' | 'multi-word' | 'sustained-voice';
      playedMs: number;
      spokenSoFar: string;
      voicedMs: number;
      transcript?: string;
    };

export interface BargeInFrameInput {
  pSpeech: number;
  postNlmsSnrDb: number;
  echoSuppressed: boolean;
  doubleTalkDetected?: boolean;
  benestyNcc?: number;
  frameDurationMs?: number; // default 32 ms
  currentPlayedMs: number;
  currentSpokenText: string;
  timestampMs?: number;
  usingDeviceSpeechSynthesis?: boolean;
}

export interface BargeInClassifierOptions {
  vadSpeechThreshold?: number; // default 0.62 (0.75 on device speechSynthesis)
  minPostNlmsSnrDb?: number; // default +6.0 dB
  softDuckVoicedMs?: number; // default 180 ms
  pauseHoldVoicedMs?: number; // default 350 ms
  hardCancelVoicedMs?: number; // default 720 ms
  softDuckDb?: number; // default -12 dB
  softDuckRampMs?: number; // default 35 ms
  falseInterruptTimeoutMs?: number; // default 950 ms
  echoLeakWindowMs?: number; // default 5000 ms
  echoLeakOverlapThreshold?: number; // default 0.75 (75%)
}

interface SpokenHistoryEntry {
  tokens: string[];
  timestampMs: number;
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Normalize transcript text preserving Vietnamese diacritics while stripping punctuation and collapsing whitespace.
 */
export function normalizeBargeInText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,!?;:'"“”‘’()[\]{}…—–_]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function tokenizeNormalized(normalized: string): string[] {
  if (!normalized) return [];
  // Also split hyphenated English backchannels cleanly when needed while keeping raw phrase check first
  return normalized
    .replace(/-/g, ' ')
    .split(/\s+/u)
    .filter(Boolean);
}

export function matchesHardCancelLexicon(normalized: string, tokens: readonly string[]): boolean {
  if (!normalized) return false;
  if (HARD_CANCEL_SET.has(normalized)) return true;
  for (const tok of tokens) {
    if (HARD_CANCEL_SET.has(tok)) return true;
  }
  // Check two-word prefixes/bigrams ("hold on", "dừng lại", "đợi chút", "khoan đã", "từ từ", "go to", "qua phần", "tiếp theo", "hey echo", "hi echo")
  for (let i = 0; i + 1 < tokens.length; i++) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    if (HARD_CANCEL_SET.has(bigram)) return true;
  }
  return false;
}

const PURE_STOP_PHRASES: ReadonlySet<string> = new Set([
  'stop',
  'pause',
  'cancel',
  'quiet',
  'enough',
  'hold on',
  'wait',
  'echo stop',
  'hey echo stop',
  'hi echo stop',
  'dừng',
  'dừng lại',
  'tạm dừng',
  'thôi',
  'hủy',
  'im lặng',
  'khoan',
  'khoan đã',
  'đợi chút',
  'đợi đã',
]);

/**
 * Returns true when an interrupting transcript is ONLY a short stop/pause imperative (e.g. "Stop", "Dừng lại")
 * with no follow-up question or navigation command attached, so Echo stops cleanly and listens quietly
 * without sending "Stop" to the LLM.
 */
export function isPureStopCommand(rawTranscript: string): boolean {
  const normalized = normalizeBargeInText(rawTranscript);
  if (!normalized) return false;
  if (PURE_STOP_PHRASES.has(normalized)) return true;
  const tokens = tokenizeNormalized(normalized);
  if (tokens.length === 0 || tokens.length > 3) return false;
  const joined = tokens.join(' ');
  return PURE_STOP_PHRASES.has(joined);
}

export function matchesBackchannelLexicon(normalized: string, tokens: readonly string[]): boolean {
  if (!normalized || tokens.length === 0 || tokens.length > 3) return false;
  if (BACKCHANNEL_SET.has(normalized)) return true;
  const dehyphenated = tokens.join(' ');
  if (BACKCHANNEL_SET.has(dehyphenated)) return true;
  // Allow repeated short backchannels such as "ừ ừ", "yeah yeah", "ok ok", "dạ vâng"
  if (tokens.length <= 2 && tokens.every((t) => BACKCHANNEL_SET.has(t))) {
    return true;
  }
  return false;
}

/**
 * 4-Layer Pause-First Soft-Duck vs. Bilingual Backchannel vs. Hard-Cancel Barge-In Classifier.
 *
 * Key Invariants:
 * 1. Counts RAW VOICED FRAMES ONLY (`voicedMs`) — trailing hangover silence NEVER inflates `voicedMs` (fixes LiveKit #8753).
 * 2. `voicedMs >= 180 ms` (post-NLMS SNR >= +6 dB) -> `SoftDuck` (-12 dB over 35 ms).
 * 3. `voicedMs >= 350 ms` -> `PausedHold` (freezes TTS readout at exact sample offset).
 * 4. Bilingual `BACKCHANNEL_SET` -> smooth auto-resume (`Gain -> 1.0` in 60 ms) + `purgeAudio: true`.
 * 5. Bilingual `HARD_CANCEL_SET` or `>= 4` words or `voicedMs >= 720 ms` -> `HardCancelled` (< 50 ms) with `playedMs` & `spokenSoFar`.
 * 6. Post-ASR Lexical Echo-Leak Filter: `>= 75%` overlap with Echo's last 5 s spoken words on `<= 4`-word non-stop transcripts -> ignore bleed!
 */
export class BargeInClassifier {
  private readonly opts: Required<BargeInClassifierOptions>;
  private state: BargeInState = 'Speaking';
  private voicedMs = 0;
  private trailingSilenceMs = 0;
  private pausedAtPlayedMs = 0;
  private pausedSpokenSoFar = '';
  private latestPlayedMs = 0;
  private latestSpokenSoFar = '';
  private echoHistory: SpokenHistoryEntry[] = [];

  constructor(options: BargeInClassifierOptions = {}) {
    this.opts = {
      vadSpeechThreshold: options.vadSpeechThreshold ?? 0.62,
      minPostNlmsSnrDb: options.minPostNlmsSnrDb ?? 6.0,
      softDuckVoicedMs: options.softDuckVoicedMs ?? 180,
      pauseHoldVoicedMs: options.pauseHoldVoicedMs ?? 350,
      hardCancelVoicedMs: options.hardCancelVoicedMs ?? 720,
      softDuckDb: options.softDuckDb ?? -12,
      softDuckRampMs: options.softDuckRampMs ?? 35,
      falseInterruptTimeoutMs: options.falseInterruptTimeoutMs ?? 950,
      echoLeakWindowMs: options.echoLeakWindowMs ?? 5000,
      echoLeakOverlapThreshold: options.echoLeakOverlapThreshold ?? 0.75,
    };
  }

  get currentState(): BargeInState {
    return this.state;
  }

  get currentVoicedMs(): number {
    return this.voicedMs;
  }

  get pausedPlayedMs(): number {
    return this.pausedAtPlayedMs;
  }

  resetForNewSpeech(): void {
    this.state = 'Speaking';
    this.voicedMs = 0;
    this.trailingSilenceMs = 0;
    this.pausedAtPlayedMs = 0;
    this.pausedSpokenSoFar = '';
  }

  clearAll(): void {
    this.resetForNewSpeech();
    this.latestPlayedMs = 0;
    this.latestSpokenSoFar = '';
    this.echoHistory = [];
  }

  /**
   * Record text Echo is actively speaking so the post-ASR Lexical Echo-Leak Filter can reject speaker bleed.
   */
  recordEchoSpokenText(text: string, timestampMs = nowMs()): void {
    this.pruneEchoHistory(timestampMs);
    const normalized = normalizeBargeInText(text);
    const tokens = tokenizeNormalized(normalized);
    if (tokens.length === 0) return;
    this.echoHistory.push({ tokens, timestampMs });
    if (this.echoHistory.length > 48) {
      this.echoHistory.shift();
    }
  }

  private pruneEchoHistory(nowTimestampMs: number): void {
    const cutoff = nowTimestampMs - this.opts.echoLeakWindowMs;
    while (this.echoHistory.length > 0 && this.echoHistory[0].timestampMs < cutoff) {
      this.echoHistory.shift();
    }
  }

  /**
   * Check whether a short (`<= 4` words) transcript without stop words has `>= 75%` lexical overlap
   * with Echo's spoken words over the last 5 seconds.
   */
  isLexicalEchoLeak(rawTranscript: string, timestampMs = nowMs()): boolean {
    this.pruneEchoHistory(timestampMs);
    if (this.echoHistory.length === 0) return false;

    const normalized = normalizeBargeInText(rawTranscript);
    const tokens = tokenizeNormalized(normalized);
    if (tokens.length === 0 || tokens.length > 4) return false;
    if (matchesHardCancelLexicon(normalized, tokens)) return false;

    const echoWordSet = new Set<string>();
    for (const entry of this.echoHistory) {
      for (const tok of entry.tokens) {
        echoWordSet.add(tok);
      }
    }
    if (echoWordSet.size === 0) return false;

    let overlapCount = 0;
    for (const tok of tokens) {
      if (echoWordSet.has(tok)) overlapCount += 1;
    }
    const overlapRatio = overlapCount / tokens.length;
    return overlapRatio >= this.opts.echoLeakOverlapThreshold;
  }

  /**
   * Step the acoustic barge-in state machine on each 32 ms mic frame during TTS playback.
   */
  onAudioFrame(input: BargeInFrameInput): BargeInDecision {
    if (this.state === 'HardCancelled') {
      return { action: 'none', state: 'HardCancelled' };
    }

    const dt = input.frameDurationMs ?? 32;
    const ts = input.timestampMs ?? nowMs();
    this.latestPlayedMs = input.currentPlayedMs;
    this.latestSpokenSoFar = input.currentSpokenText;

    const vadThresh = input.usingDeviceSpeechSynthesis
      ? Math.max(0.75, this.opts.vadSpeechThreshold)
      : this.opts.vadSpeechThreshold;

    const snrOrDoubleTalkCleared =
      input.postNlmsSnrDb >= this.opts.minPostNlmsSnrDb ||
      (input.doubleTalkDetected === true && (input.benestyNcc ?? 0) >= 0.58);

    const isRawVoiced =
      !input.echoSuppressed &&
      input.pSpeech >= vadThresh &&
      snrOrDoubleTalkCleared;

    if (isRawVoiced) {
      if (this.voicedMs === 0) {
        echoTelemetry.markBargeInStart(ts);
      }
      // ONLY raw voiced frames increment voicedMs — trailing hangover silence never counts!
      this.voicedMs += dt;
      this.trailingSilenceMs = 0;

      if (this.voicedMs >= this.opts.hardCancelVoicedMs) {
        return this.commitHardCancel('sustained-voice');
      }

      if (this.state === 'Speaking' && this.voicedMs >= this.opts.softDuckVoicedMs) {
        this.state = 'SoftDuck';
        echoTelemetry.incrementCounter('softDucks', 1);
        const linearGain = Math.pow(10, this.opts.softDuckDb / 20); // -12 dB -> ~0.2512
        return {
          action: 'soft_duck',
          state: 'SoftDuck',
          gainTarget: Math.round(linearGain * 1000) / 1000,
          rampMs: this.opts.softDuckRampMs,
          voicedMs: this.voicedMs,
        };
      }

      if (this.state === 'SoftDuck' && this.voicedMs >= this.opts.pauseHoldVoicedMs) {
        this.state = 'PausedHold';
        this.pausedAtPlayedMs = input.currentPlayedMs;
        this.pausedSpokenSoFar = input.currentSpokenText;
        return {
          action: 'pause_hold',
          state: 'PausedHold',
          pausedAtPlayedMs: this.pausedAtPlayedMs,
          voicedMs: this.voicedMs,
        };
      }

      return { action: 'none', state: this.state };
    }

    // Frame is NOT raw voiced (silence, hangover tail, or echo-suppressed bleed)
    this.trailingSilenceMs += dt;

    if (this.state === 'Speaking') {
      // Sub-180ms transient noise (click, cough, desk tap) followed by silence resets cleanly
      if (this.voicedMs > 0 && this.trailingSilenceMs >= 160) {
        this.voicedMs = 0;
      }
      return { action: 'none', state: 'Speaking' };
    }

    // In SoftDuck or PausedHold: if speech ended without committing a valid floor-taking transcript
    const timeoutMs = this.state === 'SoftDuck' ? 380 : this.opts.falseInterruptTimeoutMs;
    if (this.trailingSilenceMs >= timeoutMs) {
      return this.resumePlayback('transient-noise', true);
    }

    return { action: 'none', state: this.state };
  }

  /**
   * Evaluate streaming partial or final ASR transcript arriving while Echo is `Speaking`, `SoftDuck`, or `PausedHold`.
   */
  onTranscript(
    rawTranscript: string,
    options: { isFinal?: boolean; timestampMs?: number; currentPlayedMs?: number; currentSpokenText?: string } = {},
  ): BargeInDecision {
    if (this.state === 'HardCancelled') {
      return { action: 'none', state: 'HardCancelled' };
    }

    const ts = options.timestampMs ?? nowMs();
    if (typeof options.currentPlayedMs === 'number') this.latestPlayedMs = options.currentPlayedMs;
    if (typeof options.currentSpokenText === 'string') this.latestSpokenSoFar = options.currentSpokenText;

    const normalized = normalizeBargeInText(rawTranscript);
    const tokens = tokenizeNormalized(normalized);

    if (tokens.length === 0) {
      if (options.isFinal && (this.state === 'SoftDuck' || this.state === 'PausedHold')) {
        return this.resumePlayback('transient-noise', true);
      }
      return { action: 'none', state: this.state };
    }

    // 1. Instant Hard-Cancel Keyword Set ("stop", "wait", "khoan", "dừng lại", "mở ...", etc.) -> < 50 ms stop!
    if (matchesHardCancelLexicon(normalized, tokens)) {
      return this.commitHardCancel('hard-keyword', rawTranscript.trim());
    }

    // 2. Post-ASR Lexical Echo-Leak Filter (>= 75% overlap with Echo's last 5 s spoken words on <= 4 words)
    if (this.isLexicalEchoLeak(rawTranscript, ts)) {
      echoTelemetry.incrementCounter('echoLeaksFiltered', 1);
      if (this.state === 'SoftDuck' || this.state === 'PausedHold') {
        return this.resumePlayback('echo-leak', true);
      }
      this.voicedMs = 0;
      return {
        action: 'resume',
        state: 'Speaking',
        reason: 'echo-leak',
        gainTarget: 1.0,
        rampMs: 60,
        purgeAudio: true,
      };
    }

    // 3. Multi-word genuine utterance (>= 4 words) -> Hard-Cancel immediately!
    if (tokens.length >= 4) {
      return this.commitHardCancel('multi-word', rawTranscript.trim());
    }

    // 4. Bilingual Supportive Backchannels ("uh-huh", "yeah", "okay", "ừ", "ừm", "vâng", "dạ", "đúng rồi", "hiểu rồi")
    if (this.voicedMs < this.opts.hardCancelVoicedMs && matchesBackchannelLexicon(normalized, tokens)) {
      // Confirm backchannel immediately on final or stable short utterance
      if (options.isFinal || this.trailingSilenceMs >= 96 || this.state === 'SoftDuck' || this.state === 'PausedHold') {
        return this.resumePlayback('backchannel', true);
      }
      return { action: 'none', state: this.state };
    }

    // 5. Non-backchannel 2..3 word final phrase (e.g. "why is that?", "sao vậy?", "explain again") during overlap
    if (options.isFinal && tokens.length >= 2) {
      return this.commitHardCancel('multi-word', rawTranscript.trim());
    }

    return { action: 'none', state: this.state };
  }

  private resumePlayback(reason: 'backchannel' | 'transient-noise' | 'echo-leak', purgeAudio: boolean): BargeInDecision {
    this.state = 'Speaking';
    this.voicedMs = 0;
    this.trailingSilenceMs = 0;
    this.pausedAtPlayedMs = 0;
    this.pausedSpokenSoFar = '';
    echoTelemetry.incrementCounter('falseInterruptResumes', 1);
    return {
      action: 'resume',
      state: 'Speaking',
      reason,
      gainTarget: 1.0,
      rampMs: 60,
      purgeAudio,
    };
  }

  private commitHardCancel(
    reason: 'hard-keyword' | 'multi-word' | 'sustained-voice',
    transcript?: string,
  ): BargeInDecision {
    const playedMs = this.state === 'PausedHold' && this.pausedAtPlayedMs > 0 ? this.pausedAtPlayedMs : this.latestPlayedMs;
    const spokenSoFar =
      this.state === 'PausedHold' && this.pausedSpokenSoFar ? this.pausedSpokenSoFar : this.latestSpokenSoFar;
    const capturedVoicedMs = this.voicedMs;

    this.state = 'HardCancelled';
    return {
      action: 'hard_cancel',
      state: 'HardCancelled',
      reason,
      playedMs,
      spokenSoFar,
      voicedMs: capturedVoicedMs,
      transcript,
    };
  }
}
