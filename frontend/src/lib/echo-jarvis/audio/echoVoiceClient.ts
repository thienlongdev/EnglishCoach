import { authFetch, ensureApiSession, refreshApiSession } from '@/lib/api-session';
import { authEnding, authEpoch, onAuthWorkCancelled, subscribeAuthLifecycle } from '@/lib/auth-lifecycle';
import { getBaseUrl } from '@/services/api-client';
import { type EchoEarconKind } from './earcons';
import { EchoStreamingPlayback, type EchoJarvisVoiceId, type WordTimingSpan } from './echoStreamingPlayback';
import { echoTelemetry } from './echoTelemetry';

// 7-Byte Binary WebSocket Header Specification (`/ws-card-blast/echo-voice`):
//   Byte 0    : msgType (0x01 = Client Mic 16 kHz PCM16LE, 0x02 = Server TTS 24 kHz PCM16LE, 0x03 = Ping/Sync)
//   Bytes 1..2: uint16be turnSeq (monotonic turn counter; client drops 0x02 frames with turnSeq < activeTurnSeq in O(1)!)
//   Bytes 3..6: uint32be sampleOffset (sample index from utterance start)
//   Bytes 7..N: raw PCM16LE samples (<= 1,920 B payload -> <= 1,927 B total, fitting 1 Nginx 4 KiB TLS record!)

export const ECHO_WS_MSG_MIC_PCM16 = 0x01;
export const ECHO_WS_MSG_TTS_PCM16 = 0x02;
export const ECHO_WS_MSG_PING = 0x03;
export const ECHO_WS_BINARY_HEADER_BYTES = 7;

export interface DecodedBinaryAudioFrame {
  msgType: number;
  turnSeq: number;
  sampleOffset: number;
  pcmBytes: Uint8Array;
}

export interface TurnCheckResult {
  complete: boolean;
  probability: number;
  recommendedWaitMs: number;
}

export interface TranscriptionResult {
  text: string;
  reviewNeeded: boolean;
  language: 'en' | 'vi';
  rejectedReason?: string | null;
}

export interface ActionClientPlanEvent {
  turnSeq: number;
  intents: unknown[];
  spokenAck: string;
  lang: 'en' | 'vi';
  playEarcon?: EchoEarconKind | 'none';
  escalateOnEmpty?: boolean;
  sessionId?: number | null;
}

export interface ActionGuardEvent {
  turnSeq: number;
  decision: 'DENIED' | 'UNSUPPORTED';
  reason: string;
  spokenMessage: string;
  lang: 'en' | 'vi';
}

export interface VadStateEvent {
  state: 'eou_committed' | 'thinking_pause';
  turnSeq: number;
  complete: boolean;
  probability: number;
  recommendedWaitMs: number;
}

export interface ToolConfirmedEvent {
  status: 'APPLIED' | 'CANCELLED';
  plan?: Record<string, unknown>;
  savedCards?: number;
}

export interface BargeInServerDecisionEvent {
  turnSeq: number;
  decision: 'backchannel' | 'interrupt' | 'none';
  text?: string;
}

export interface EchoVoiceErrorMeta {
  turnSeq?: number;
  status?: number;
  limitKind?: string;
  resetsAt?: string;
  messageVi?: string;
  messageEn?: string;
  recoverable?: boolean;
}

export class EchoVoiceTurnError extends Error {
  readonly code: string;
  readonly meta: EchoVoiceErrorMeta;

  constructor(code: string, detail?: string, meta: EchoVoiceErrorMeta = {}) {
    super(detail || code);
    this.name = 'EchoVoiceTurnError';
    this.code = code;
    this.meta = meta;
  }
}

export interface EchoVoiceSessionFlags {
  pathname?: string;
  hasPendingConfirmation?: boolean;
  hasActiveStrictSentinel?: boolean;
}

export interface EchoVoiceClientCallbacks {
  onConnectionChange?: (connected: boolean, transport: 'ws' | 'http-fallback') => void;
  onSessionReady?: (info: { sampleRateIn: number; sampleRateOut: number; maxFrameBytes: number; voiceId?: string; lang?: string }) => void;
  onVadState?: (info: VadStateEvent) => void;
  onAsrPartial?: (info: { text: string; stableText?: string; lang?: string; turnSeq: number; probeOnly?: boolean }) => void;
  onAsrFinal?: (info: { text: string; lang: 'en' | 'vi'; reviewNeeded?: boolean; turnSeq: number; rejectedReason?: string | null }) => void;
  onActionClientPlan?: (plan: ActionClientPlanEvent) => void;
  onActionGuard?: (guard: ActionGuardEvent) => void;
  onBargeInServerDecision?: (info: BargeInServerDecisionEvent) => void;
  onLlmDelta?: (delta: string, fullText: string, turnSeq: number) => void;
  onActionsAndCards?: (payload: { actions?: unknown[]; cards?: unknown[]; confirmations?: unknown[]; turnSeq: number }) => void;
  onEntityState?: (state: string, turnSeq: number, status?: string) => void;
  onTtsFallback?: (info: { turnSeq: number; text: string }) => void;
  onTurnComplete?: (fullText: string, turnSeq: number, route?: string, sessionId?: number | null) => void;
  onResponseCancelled?: (turnSeq: number, reason?: string) => void;
  onTurnTruncated?: (info: { turnSeq: number; spokenText: string; truncated: boolean; sessionId?: number | null }) => void;
  onToolConfirmed?: (info: ToolConfirmedEvent) => void;
  onWsTurnDroppedBeforeOutput?: (info: { turnSeq: number; asrText?: string; asrLang?: 'en' | 'vi' }) => void;
  getSessionFlags?: () => EchoVoiceSessionFlags;
  getPageContext?: () => unknown;
  getConversationHistory?: () => { role: string; content: string }[];
  getSalientResources?: () => readonly unknown[];
  onError?: (code: string, detail?: string, meta?: EchoVoiceErrorMeta) => void;
}

export interface EchoVoiceClientOptions {
  playback: EchoStreamingPlayback;
  callbacks?: EchoVoiceClientCallbacks;
  webSocketFactory?: (url: string) => WebSocket;
  fetchImpl?: typeof fetch;
}

const VI_DIACRITIC_RE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/iu;

/**
 * Frontend defense-in-depth ASR repetition-loop filter:
 * Catches pathological Whisper hallucination loops like "...ing, Writing, Writing, Writing, Writing..."
 * where a 1..3-word n-gram repeats >= 4 times covering >= 55% of tokens.
 */
export function isRepetitiveAsrHallucination(raw: string): boolean {
  const cleaned = (raw || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return false;
  const tokens = cleaned.split(' ').filter(Boolean);
  if (tokens.length < 5) return false;

  // Check consecutive or dominant 1-gram / 2-gram / 3-gram loops
  for (let n = 1; n <= 3; n++) {
    if (tokens.length < n * 4) continue;
    const counts = new Map<string, number>();
    let maxCount = 0;
    let maxRun = 1;
    let curRun = 1;
    let prevGram = '';

    for (let i = 0; i + n <= tokens.length; i += n) {
      const gram = tokens.slice(i, i + n).join(' ');
      const nextCount = (counts.get(gram) ?? 0) + 1;
      counts.set(gram, nextCount);
      if (nextCount > maxCount) maxCount = nextCount;
      if (gram === prevGram) {
        curRun += 1;
        if (curRun > maxRun) maxRun = curRun;
      } else {
        curRun = 1;
      }
      prevGram = gram;
    }

    if (maxRun >= 4 || (maxCount >= 4 && (maxCount * n) / tokens.length >= 0.55)) {
      return true;
    }
  }
  return false;
}

/**
 * Strip local book metadata and visible text excerpts from passive WS session messages (`10 §AB`).
 */
export function sanitizePassivePageContext(ctx: unknown): Record<string, unknown> | null {
  if (!ctx || typeof ctx !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx as Record<string, unknown>)) {
    if (k === 'bookMeta' || k === 'clientVisibleExcerpt' || k === 'recentHighlights') continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function int16ToBase64(pcm16: Int16Array): string {
  const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + chunk)));
  }
  return btoa(binary);
}

export function getEchoVoiceWsUrl(): string {
  if (typeof window === 'undefined') return 'wss://englishcoach.io.vn/ws-card-blast/echo-voice';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  if (host.includes(':3000')) {
    return `${protocol}//${window.location.hostname}:8080/ws-card-blast/echo-voice`;
  }
  return `${protocol}//${host}/ws-card-blast/echo-voice`;
}

/**
 * Encode a 7-byte header + PCM16LE binary frame for `/ws-card-blast/echo-voice`.
 */
export function encodeBinaryAudioFrame(
  msgType: number,
  turnSeq: number,
  sampleOffset: number,
  pcm16: Int16Array | Uint8Array,
): ArrayBuffer {
  const payloadBytes = pcm16 instanceof Uint8Array ? pcm16.byteLength : pcm16.length * 2;
  const out = new ArrayBuffer(ECHO_WS_BINARY_HEADER_BYTES + payloadBytes);
  const view = new DataView(out);
  view.setUint8(0, msgType & 0xff);
  view.setUint16(1, turnSeq & 0xffff, false); // big-endian uint16
  view.setUint32(3, sampleOffset >>> 0, false); // big-endian uint32

  if (pcm16 instanceof Uint8Array) {
    new Uint8Array(out, ECHO_WS_BINARY_HEADER_BYTES).set(pcm16);
  } else {
    for (let i = 0; i < pcm16.length; i++) {
      view.setInt16(ECHO_WS_BINARY_HEADER_BYTES + i * 2, pcm16[i], true); // little-endian PCM16LE
    }
  }
  return out;
}

/**
 * Decode a 7-byte header + PCM16LE binary frame from `/ws-card-blast/echo-voice`.
 */
export function decodeBinaryAudioFrame(raw: ArrayBuffer | Uint8Array): DecodedBinaryAudioFrame | null {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength < ECHO_WS_BINARY_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const msgType = view.getUint8(0);
  const turnSeq = view.getUint16(1, false);
  const sampleOffset = view.getUint32(3, false);
  const pcmBytes = bytes.subarray(ECHO_WS_BINARY_HEADER_BYTES);
  return { msgType, turnSeq, sampleOffset, pcmBytes };
}

/**
 * Reassemble arbitrary TCP/HTTP ReadableStream Uint8Array chunks into aligned even-byte PCM16LE slices,
 * carrying any odd trailing byte cleanly into the next chunk so samples never byte-swap!
 */
export class EvenBytePcmStreamAssembler {
  private carryByte: number | null = null;

  reset(): void {
    this.carryByte = null;
  }

  push(chunk: Uint8Array): Uint8Array | null {
    if (chunk.byteLength === 0) return null;
    let combined: Uint8Array;
    if (this.carryByte !== null) {
      combined = new Uint8Array(1 + chunk.byteLength);
      combined[0] = this.carryByte;
      combined.set(chunk, 1);
      this.carryByte = null;
    } else {
      combined = chunk;
    }

    if ((combined.byteLength & 1) === 1) {
      this.carryByte = combined[combined.byteLength - 1];
      combined = combined.subarray(0, combined.byteLength - 1);
    }

    return combined.byteLength > 0 ? combined : null;
  }
}

/**
 * Adaptive FirstClauseChunker for HTTP SSE fallback:
 * Releases Clause 0 at 30..95 chars (first punctuation after >= 4 words) or immediately on completion,
 * and Clauses 1+ at 65..170 chars for natural prosodic phrasing!
 */
export class FirstClauseChunker {
  private buffer = '';
  private clauseIndex = 0;

  reset(): void {
    this.buffer = '';
    this.clauseIndex = 0;
  }

  push(delta: string, isComplete = false): string[] {
    this.buffer += delta;
    const ready: string[] = [];

    while (this.buffer.length > 0) {
      const cleaned = this.stripSpeakableMarkdown(this.buffer);
      if (!cleaned) {
        if (isComplete) this.buffer = '';
        break;
      }

      if (isComplete && this.buffer.length <= 240) {
        const finalClean = this.stripSpeakableMarkdown(this.buffer).trim();
        this.buffer = '';
        if (finalClean) {
          ready.push(finalClean);
          this.clauseIndex += 1;
        }
        break;
      }

      const isFirst = this.clauseIndex === 0;
      const minLen = isFirst ? 30 : 65;
      const maxLen = isFirst ? 95 : 180;

      const boundaryRe = isFirst
        ? /^([\s\S]{24,110}?[.!?;:,—…]["”’)]?\s+)/u
        : /^([\s\S]{55,200}?[.!?;:—…]["”’)]?\s+)/u;

      const match = this.buffer.match(boundaryRe);
      if (match && match[1].length >= minLen) {
        const rawSlice = match[1];
        this.buffer = this.buffer.slice(rawSlice.length);
        const speakable = this.stripSpeakableMarkdown(rawSlice).trim();
        if (speakable) {
          ready.push(speakable);
          this.clauseIndex += 1;
        }
        continue;
      }

      if (this.buffer.length >= maxLen) {
        const windowStr = this.buffer.slice(0, maxLen);
        const lastSpace = windowStr.lastIndexOf(' ');
        const cut = lastSpace > minLen ? lastSpace + 1 : maxLen;
        const rawSlice = this.buffer.slice(0, cut);
        this.buffer = this.buffer.slice(cut);
        const speakable = this.stripSpeakableMarkdown(rawSlice).trim();
        if (speakable) {
          ready.push(speakable);
          this.clauseIndex += 1;
        }
        continue;
      }

      break;
    }

    return ready;
  }

  private stripSpeakableMarkdown(text: string): string {
    return text
      .replace(/\[ECHO_META\][\s\S]*$/u, '')
      .replace(/\*\*|__|`/gu, '')
      .replace(/^#{1,6}\s+|^[ \t]*[-•]\s+/gmu, '')
      .replace(/\[[^\]\n]+->[^\]\n]+\]/gu, '')
      .replace(/\s+/gu, ' ');
  }
}

function sanitizeHistoryMessages(raw?: { role: string; content: string }[]): { role: string; content: string }[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const filtered: { role: string; content: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item.content !== 'string') continue;
    const role = String(item.role || '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;
    const content = item.content.trim().slice(0, 3800);
    if (!content) continue;
    filtered.push({ role, content });
  }
  const bounded = filtered.slice(-12);
  let totalChars = bounded.reduce((sum, m) => sum + m.content.length, 0);
  while (bounded.length > 1 && totalChars > 18000) {
    const shifted = bounded.shift();
    totalChars -= shifted ? shifted.content.length : 0;
  }
  return bounded;
}

type PendingPreConnectItem =
  | { kind: 'json'; turnSeq: number; payload: Record<string, unknown> }
  | { kind: 'pcm16'; turnSeq: number; sampleOffset: number; pcm16: Int16Array };

interface InFlightWsTurnState {
  turnSeq: number;
  hasOutput: boolean;
  asrText?: string;
  asrLang?: 'en' | 'vi';
  watchdog: ReturnType<typeof setTimeout> | null;
}

const WS_KEEPALIVE_INTERVAL_MS = 25_000;
const WS_PONG_TIMEOUT_MS = 12_000;
const WS_TURN_WATCHDOG_MS = 52_000;

/**
 * Full-Duplex Binary+JSON Voice Transport (`/ws-card-blast/echo-voice`, Contract A) with
 * Pre-Connect Ring Buffering, 25s Keepalive Ping, Auto-Reconnect, Turn Watchdog,
 * Mid-Turn WS->HTTP Failover, and Hardened HTTP/SSE Fallback.
 */
export class EchoVoiceClient {
  private readonly playback: EchoStreamingPlayback;
  private callbacks: EchoVoiceClientCallbacks;
  private readonly wsFactory?: (url: string) => WebSocket;
  private readonly fetchFn: typeof fetch;

  private ws: WebSocket | null = null;
  private connecting = false;
  private connectPromise: Promise<boolean> | null = null;
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private pongWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInboundAtMs = 0;

  private activeTurnSeq = 1;
  private sessionId: number | null = null;
  private voiceId: EchoJarvisVoiceId = 'us_female';
  private locale: 'en' | 'vi' = 'en';
  private pendingSegmentMeta = new Map<
    number,
    { utteranceId?: string; sampleRate?: number; text?: string; wordTimings?: WordTimingSpan[]; firstFrameConsumed?: boolean }
  >();
  private streamedTextByTurn = new Map<number, string>();
  private preConnectQueue: PendingPreConnectItem[] = [];
  private inFlightWsTurn: InFlightWsTurnState | null = null;
  private httpTurnAbort: AbortController | null = null;
  private activeHttpTurnId: string | null = null;
  private unsubAuth: (() => void) | null = null;

  constructor(options: EchoVoiceClientOptions) {
    this.playback = options.playback;
    this.callbacks = options.callbacks ?? {};
    this.wsFactory = options.webSocketFactory;
    this.fetchFn = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (null as unknown as typeof fetch));

    if (typeof window !== 'undefined') {
      onAuthWorkCancelled(() => {
        if (authEnding()) this.disconnectImmediate();
      });
      this.unsubAuth = subscribeAuthLifecycle(() => {
        if (authEnding()) this.disconnectImmediate();
      });
    }
  }

  setCallbacks(callbacks: EchoVoiceClientCallbacks): void {
    this.callbacks = callbacks;
  }

  setSessionConfig(config: { sessionId?: number | null; voiceId?: EchoJarvisVoiceId; locale?: 'en' | 'vi' }): void {
    if (config.sessionId !== undefined) this.sessionId = config.sessionId;
    if (config.voiceId !== undefined) this.voiceId = config.voiceId;
    if (config.locale !== undefined) this.locale = config.locale;
  }

  get isWsConnected(): boolean {
    return Boolean(this.ws && this.ws.readyState === 1); // WebSocket.OPEN === 1
  }

  get isConnecting(): boolean {
    return this.connecting;
  }

  get currentTurnSeq(): number {
    return this.activeTurnSeq;
  }

  nextTurnSeq(): number {
    const base = Math.max(this.activeTurnSeq, this.playback.currentTurnSeq);
    let next = (base + 1) & 0xffff;
    if (next === 0) {
      next = 1;
      this.playback.resetTurnSequence(0);
    }
    this.activeTurnSeq = next;
    return this.activeTurnSeq;
  }

  private resolveSessionFlags(): EchoVoiceSessionFlags {
    const cbFlags = this.callbacks.getSessionFlags?.() ?? {};
    const fallbackPathname =
      typeof window !== 'undefined' && window.location?.pathname ? window.location.pathname : '/dashboard';
    return {
      pathname: cbFlags.pathname || fallbackPathname,
      hasPendingConfirmation: cbFlags.hasPendingConfirmation === true,
      hasActiveStrictSentinel: cbFlags.hasActiveStrictSentinel === true,
    };
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.lastInboundAtMs = Date.now();
    // Skip background keepalive timers when running custom unit-test WebSocket factories so Node exits immediately
    if (this.wsFactory) return;
    this.keepaliveTimer = setInterval(() => {
      if (!this.isWsConnected || !this.ws || authEnding()) {
        this.stopKeepalive();
        return;
      }
      const pingSentAt = Date.now();
      const sent = this.sendJson({ type: 'ping', ts: pingSentAt });
      if (!sent) return;
      if (this.pongWatchdogTimer) clearTimeout(this.pongWatchdogTimer);
      this.pongWatchdogTimer = setTimeout(() => {
        this.pongWatchdogTimer = null;
        if (!this.isWsConnected || !this.ws || this.intentionalClose) return;
        if (this.lastInboundAtMs < pingSentAt) {
          try {
            this.ws.close(4000, 'ping-timeout');
          } catch {
            // Ignore
          }
        }
      }, WS_PONG_TIMEOUT_MS);
    }, WS_KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.pongWatchdogTimer !== null) {
      clearTimeout(this.pongWatchdogTimer);
      this.pongWatchdogTimer = null;
    }
  }

  private createTurnWatchdogTimer(turnSeq: number): ReturnType<typeof setTimeout> | null {
    if (this.wsFactory) return null;
    const timer = setTimeout(() => {
      if (!this.inFlightWsTurn || this.inFlightWsTurn.turnSeq !== turnSeq) return;
      const stuck = this.inFlightWsTurn;
      this.inFlightWsTurn = null;
      if (!stuck.hasOutput) {
        this.sendJson({ type: 'response.cancel', turnSeq, sessionId: this.sessionId });
        this.callbacks.onError?.('turn_timeout', undefined, { turnSeq, status: 504, recoverable: true });
      }
    }, WS_TURN_WATCHDOG_MS);
    (timer as unknown as { unref?: () => void })?.unref?.();
    return timer;
  }

  private armInFlightWsTurn(turnSeq: number): void {
    this.clearInFlightWsTurn();
    this.inFlightWsTurn = {
      turnSeq,
      hasOutput: false,
      watchdog: this.createTurnWatchdogTimer(turnSeq),
    };
  }

  private refreshInFlightTurnWatchdog(turnSeq: number): void {
    if (!this.inFlightWsTurn || this.inFlightWsTurn.turnSeq !== turnSeq || this.inFlightWsTurn.hasOutput) {
      return;
    }
    if (this.inFlightWsTurn.watchdog) {
      clearTimeout(this.inFlightWsTurn.watchdog);
    }
    this.inFlightWsTurn.watchdog = this.createTurnWatchdogTimer(turnSeq);
  }

  private isStaleTurnSeq(rawSeq: unknown): boolean {
    if (typeof rawSeq !== 'number' || !Number.isFinite(rawSeq) || rawSeq <= 0) {
      return false;
    }
    if (this.activeTurnSeq <= 2 && rawSeq >= 0xfff0) {
      return true;
    }
    return rawSeq < this.activeTurnSeq;
  }

  private markInFlightTurnOutput(turnSeq: number): void {
    if (this.inFlightWsTurn && this.inFlightWsTurn.turnSeq === turnSeq) {
      this.inFlightWsTurn.hasOutput = true;
      if (this.inFlightWsTurn.watchdog) {
        clearTimeout(this.inFlightWsTurn.watchdog);
        this.inFlightWsTurn.watchdog = null;
      }
    }
  }

  private clearInFlightWsTurn(turnSeq?: number): void {
    if (!this.inFlightWsTurn) return;
    if (turnSeq !== undefined && this.inFlightWsTurn.turnSeq !== turnSeq) return;
    if (this.inFlightWsTurn.watchdog) {
      clearTimeout(this.inFlightWsTurn.watchdog);
    }
    this.inFlightWsTurn = null;
  }

  /**
   * Connect to `wss://<host>/ws-card-blast/echo-voice` after validating HttpOnly session cookie freshness.
   * Deduplicates concurrent connect calls and flushes any pre-connect audio/control frames on open!
   */
  async connect(initPayload?: {
    pageContext?: unknown;
    mode?: 'hands_free' | 'ptt';
    locale?: 'en' | 'vi';
    lang?: 'auto' | 'en' | 'vi';
    messages?: { role: string; content: string }[];
    salientResources?: readonly unknown[];
  }): Promise<boolean> {
    if (authEnding()) return false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.isWsConnected) return true;
    if (this.connectPromise) return this.connectPromise;

    const startedEpoch = authEpoch();
    this.intentionalClose = false;
    this.connecting = true;
    if (initPayload?.locale) this.locale = initPayload.locale;

    const runConnect = async (): Promise<boolean> => {
      try {
        if (typeof window !== 'undefined' && !this.wsFactory) {
          const ok = await ensureApiSession();
          if (!ok || authEnding() || startedEpoch !== authEpoch()) {
            this.connecting = false;
            return false;
          }
        }

        const url = getEchoVoiceWsUrl();
        const socket = this.wsFactory ? this.wsFactory(url) : new WebSocket(url);
        socket.binaryType = 'arraybuffer';
        this.ws = socket;

        return await new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            this.connecting = false;
            resolve(ok);
          };

          socket.onopen = () => {
            if (this.ws !== socket || authEnding()) {
              try {
                socket.close();
              } catch {
                // Ignore
              }
              finish(false);
              return;
            }
            this.reconnectAttempt = 0;
            this.lastInboundAtMs = Date.now();
            echoTelemetry.incrementCounter('wsConnects', 1);
            const flags = this.resolveSessionFlags();
            const freshHistory = this.callbacks.getConversationHistory?.();
            const safeMessages = sanitizeHistoryMessages(
              freshHistory && freshHistory.length > 0 ? freshHistory : initPayload?.messages,
            );
            const freshSalient = this.callbacks.getSalientResources?.();
            const salient =
              Array.isArray(freshSalient) && freshSalient.length > 0
                ? freshSalient
                : (initPayload?.salientResources ?? freshSalient);
            const rawPageContext = this.callbacks.getPageContext?.() ?? initPayload?.pageContext;
            this.sendJson({
              type: 'session.start',
              sessionId: this.sessionId,
              voiceId: this.voiceId,
              lang: initPayload?.lang ?? 'auto',
              mode: initPayload?.mode ?? 'hands_free',
              locale: initPayload?.locale ?? this.locale,
              pathname: flags.pathname,
              hasPendingConfirmation: flags.hasPendingConfirmation,
              hasActiveStrictSentinel: flags.hasActiveStrictSentinel,
              // 10 §AB: NEVER transmit bookMeta or clientVisibleExcerpt passively on session.start!
              pageContext: sanitizePassivePageContext(rawPageContext),
              ...(safeMessages.length > 0 ? { messages: safeMessages } : {}),
              ...(Array.isArray(salient) && salient.length > 0 ? { salientResources: salient } : {}),
            });
            this.startKeepalive();
            this.flushPreConnectQueue();
            this.callbacks.onConnectionChange?.(true, 'ws');
            finish(true);
          };

          socket.onmessage = (event: MessageEvent) => {
            if (this.ws !== socket || authEnding()) return;
            this.lastInboundAtMs = Date.now();
            if (event.data instanceof ArrayBuffer || event.data instanceof Uint8Array) {
              this.handleBinaryFrame(event.data);
            } else if (typeof event.data === 'string') {
              this.handleJsonFrame(event.data);
            }
          };

          socket.onerror = () => {
            finish(false);
          };

          socket.onclose = (ev: CloseEvent) => {
            if (this.ws === socket) {
              this.ws = null;
            }
            this.stopKeepalive();
            finish(false);
            this.callbacks.onConnectionChange?.(false, 'http-fallback');

            const activeInFlight =
              !this.intentionalClose && !authEnding() && this.inFlightWsTurn
                ? { ...this.inFlightWsTurn }
                : null;
            this.clearInFlightWsTurn();
            if (this.playback.currentTurnSeq > 0) {
              this.playback.markTurnAudioStreamFinished(this.playback.currentTurnSeq);
            }

            if (activeInFlight && !activeInFlight.hasOutput) {
              this.callbacks.onWsTurnDroppedBeforeOutput?.({
                turnSeq: activeInFlight.turnSeq,
                asrText: activeInFlight.asrText,
                asrLang: activeInFlight.asrLang,
              });
            } else if (activeInFlight && activeInFlight.hasOutput) {
              this.callbacks.onError?.('connection_interrupted', undefined, {
                turnSeq: activeInFlight.turnSeq,
                recoverable: true,
              });
            }

            if (!this.intentionalClose && !authEnding()) {
              const reconnectPayload = {
                mode: initPayload?.mode,
                locale: initPayload?.locale ?? this.locale,
                lang: initPayload?.lang,
              };
              if (ev?.code === 1008) {
                void refreshApiSession().then((renewed) => {
                  if (renewed && !this.intentionalClose && !authEnding()) {
                    this.scheduleReconnect(reconnectPayload);
                  }
                });
              } else {
                this.scheduleReconnect(reconnectPayload);
              }
            }
          };
        });
      } catch {
        this.connecting = false;
        this.callbacks.onConnectionChange?.(false, 'http-fallback');
        return false;
      } finally {
        this.connectPromise = null;
      }
    };

    this.connectPromise = runConnect();
    return this.connectPromise;
  }

  /**
   * Cleanly close an idle WebSocket when returning to local `'dormant'` wake-word standby
   * so dormant mode guarantees 0 network bytes and never leaves half-open NAT sockets!
   */
  disconnectIdle(): void {
    if (this.inFlightWsTurn) return;
    this.intentionalClose = true;
    this.preConnectQueue = [];
    this.stopKeepalive();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const sock = this.ws;
      this.ws = null;
      sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
      try {
        sock.close(1000, 'idle-dormant');
      } catch {
        // Ignore
      }
      this.callbacks.onConnectionChange?.(false, 'http-fallback');
    }
  }

  /**
   * Send `session.update` when preferences or passive route context change (NEVER leaks book excerpt!).
   */
  updateSession(opts: {
    voiceId?: EchoJarvisVoiceId;
    lang?: 'auto' | 'en' | 'vi';
    locale?: 'en' | 'vi';
    sessionId?: number | null;
    resetSession?: boolean;
    pageContext?: unknown;
    messages?: { role: string; content: string }[];
    salientResources?: readonly unknown[];
  }): boolean {
    const explicitSessionId = 'sessionId' in opts && opts.sessionId !== undefined;
    const explicitNullSessionId = 'sessionId' in opts && opts.sessionId === null;
    const explicitMessages = opts.messages !== undefined;
    const explicitSalient = opts.salientResources !== undefined;
    if (opts.voiceId) this.voiceId = opts.voiceId;
    if (opts.locale) this.locale = opts.locale;
    if (explicitSessionId || explicitNullSessionId) {
      this.sessionId = opts.sessionId ?? null;
    }
    if (!this.isWsConnected) return false;
    const flags = this.resolveSessionFlags();
    const rawMessages = explicitMessages ? opts.messages : this.callbacks.getConversationHistory?.();
    const safeMessages = rawMessages !== undefined ? sanitizeHistoryMessages(rawMessages) : null;
    const salient = explicitSalient ? opts.salientResources : this.callbacks.getSalientResources?.();
    return this.sendJson({
      type: 'session.update',
      voiceId: this.voiceId,
      lang: opts.lang ?? 'auto',
      locale: this.locale,
      sessionId: this.sessionId,
      ...(opts.resetSession ? { resetSession: true } : {}),
      pathname: flags.pathname,
      hasPendingConfirmation: flags.hasPendingConfirmation,
      hasActiveStrictSentinel: flags.hasActiveStrictSentinel,
      pageContext: sanitizePassivePageContext(opts.pageContext),
      ...(safeMessages !== null && (opts.resetSession || safeMessages.length > 0)
        ? { messages: safeMessages }
        : {}),
      ...(Array.isArray(salient) && (opts.resetSession || salient.length > 0)
        ? { salientResources: salient }
        : {}),
    });
  }

  private enqueuePreConnect(item: PendingPreConnectItem): void {
    // Discard stale turns in queue and bound total items to 64 (~4 s of audio)
    this.preConnectQueue = this.preConnectQueue.filter((q) => q.turnSeq === item.turnSeq);
    if (this.preConnectQueue.length >= 64) {
      this.preConnectQueue.shift();
    }
    this.preConnectQueue.push(item);
  }

  private flushPreConnectQueue(): void {
    if (!this.isWsConnected || this.preConnectQueue.length === 0) return;
    const items = this.preConnectQueue;
    this.preConnectQueue = [];
    for (const item of items) {
      if (item.turnSeq < this.activeTurnSeq) continue;
      if (item.kind === 'json') {
        this.sendJson(item.payload);
      } else {
        this.sendMicPcm16(item.turnSeq, item.sampleOffset, item.pcm16);
      }
    }
  }

  private scheduleReconnect(initPayload?: {
    pageContext?: unknown;
    mode?: 'hands_free' | 'ptt';
    locale?: 'en' | 'vi';
    lang?: 'auto' | 'en' | 'vi';
  }): void {
    if (this.reconnectTimer !== null || this.intentionalClose || authEnding()) return;
    const attempt = this.reconnectAttempt++;
    const base = Math.min(15000, 500 * Math.pow(2, attempt));
    const jitter = Math.round(Math.random() * 400);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose || authEnding()) return;
      echoTelemetry.incrementCounter('wsReconnects', 1);
      void this.connect(initPayload);
    }, base + jitter);
  }

  sendJson(payload: Record<string, unknown>): boolean {
    if (!this.isWsConnected || !this.ws) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stream a 16 kHz PCM16LE uplink chunk (`0x01` + `turnSeq` + `sampleOffset`).
   * Slices into <= 960-sample (1,927-byte) frames so every frame fits one 4 KiB TLS record.
   * Buffers in `preConnectQueue` while WS handshake is in progress so Turn 1 opening audio is never lost!
   */
  sendMicPcm16(turnSeq: number, sampleOffset: number, pcm16: Int16Array): boolean {
    if (!this.isWsConnected || !this.ws) {
      if (this.connecting && turnSeq >= this.activeTurnSeq) {
        this.enqueuePreConnect({ kind: 'pcm16', turnSeq, sampleOffset, pcm16: new Int16Array(pcm16) });
        return true;
      }
      return false;
    }
    const maxSamplesPerFrame = 960;
    let cursor = 0;
    try {
      while (cursor < pcm16.length) {
        const end = Math.min(pcm16.length, cursor + maxSamplesPerFrame);
        const slice = pcm16.subarray(cursor, end);
        const frame = encodeBinaryAudioFrame(ECHO_WS_MSG_MIC_PCM16, turnSeq, sampleOffset + cursor, slice);
        this.ws.send(frame);
        cursor = end;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pre-warm EchoLearnerBrain at speech onset (`0` LLM tokens, `0` V137 quota deduction!).
   * Strictly strips local book metadata/excerpts (`10 §AB`).
   */
  async notifySpeechStarted(turnSeq: number, pageContext?: unknown): Promise<void> {
    const safeCtx = sanitizePassivePageContext(pageContext);
    const flags = this.resolveSessionFlags();
    const payload = {
      type: 'input.speech_started',
      turnSeq,
      sessionId: this.sessionId,
      pathname: flags.pathname,
      hasPendingConfirmation: flags.hasPendingConfirmation,
      hasActiveStrictSentinel: flags.hasActiveStrictSentinel,
      pageContext: safeCtx,
    };
    if (this.isWsConnected) {
      this.sendJson(payload);
      return;
    }
    if (this.connecting) {
      this.enqueuePreConnect({ kind: 'json', turnSeq, payload });
      return;
    }
    try {
      await authFetch(`${getBaseUrl()}/ai/chat/warm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId }),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      // Best-effort pre-warm
    }
  }

  /**
   * Send WS `input.turn_check` (`autoCommit: true` commits server-side without an extra WAN RTT!).
   * Carries 1-to-1 session/route/confirmation/sentinel metadata with `commitInput` so Smart-Turn
   * `eou_committed` never executes against stale session, salience, or confirmation state.
   */
  sendTurnCheck(
    turnSeq: number,
    autoCommit = true,
    opts?: {
      sessionId?: number | null;
      lang?: 'auto' | 'en' | 'vi';
      locale?: 'en' | 'vi';
      voiceId?: EchoJarvisVoiceId;
      pathname?: string;
      hasPendingConfirmation?: boolean;
      hasActiveStrictSentinel?: boolean;
      pageContext?: unknown;
      messages?: { role: string; content: string }[];
      salientResources?: readonly unknown[];
    },
  ): boolean {
    const flags = this.resolveSessionFlags();
    const resolvedSessionId =
      opts && 'sessionId' in opts && opts.sessionId !== undefined
        ? opts.sessionId
        : opts && 'sessionId' in opts && opts.sessionId === null
          ? null
          : this.sessionId;
    const safeMessages = autoCommit
      ? sanitizeHistoryMessages(opts?.messages ?? this.callbacks.getConversationHistory?.())
      : [];
    const salient = autoCommit
      ? (opts?.salientResources ?? this.callbacks.getSalientResources?.())
      : undefined;
    return this.sendJson({
      type: 'input.turn_check',
      turnSeq,
      autoCommit,
      sessionId: resolvedSessionId,
      lang: opts?.lang ?? 'auto',
      locale: opts?.locale ?? this.locale,
      voiceId: opts?.voiceId ?? this.voiceId,
      pathname: opts?.pathname ?? flags.pathname,
      hasPendingConfirmation: opts?.hasPendingConfirmation ?? flags.hasPendingConfirmation,
      hasActiveStrictSentinel: opts?.hasActiveStrictSentinel ?? flags.hasActiveStrictSentinel,
      ...(autoCommit && opts?.pageContext !== undefined ? { pageContext: opts.pageContext } : {}),
      ...(safeMessages.length > 0 ? { messages: safeMessages } : {}),
      ...(Array.isArray(salient) && salient.length > 0 ? { salientResources: salient } : {}),
    });
  }

  /**
   * Commit current utterance over WS (supports backwards-compatible `sampleCount` OR full Contract A object).
   * Explicit user turn MAY include on-demand `pageContext.bookMeta` / `clientVisibleExcerpt`,
   * fresh `messages` history, and active `salientResources`.
   */
  commitInput(
    turnSeq: number,
    sampleCountOrOpts?:
      | number
      | {
          sampleCount?: number;
          text?: string;
          lang?: 'auto' | 'en' | 'vi';
          locale?: 'en' | 'vi';
          voiceId?: EchoJarvisVoiceId;
          pageContext?: unknown;
          messages?: { role: string; content: string }[];
          salientResources?: readonly unknown[];
        },
  ): boolean {
    const opts = typeof sampleCountOrOpts === 'number' ? { sampleCount: sampleCountOrOpts } : (sampleCountOrOpts ?? {});
    const flags = this.resolveSessionFlags();
    const safeMessages = sanitizeHistoryMessages(
      opts.messages ?? this.callbacks.getConversationHistory?.(),
    );
    const salient = opts.salientResources ?? this.callbacks.getSalientResources?.();
    const payload: Record<string, unknown> = {
      type: 'input.commit',
      turnSeq,
      sessionId: this.sessionId,
      lang: opts.lang ?? 'auto',
      locale: opts.locale ?? this.locale,
      voiceId: opts.voiceId ?? this.voiceId,
      pathname: flags.pathname,
      hasPendingConfirmation: flags.hasPendingConfirmation,
      hasActiveStrictSentinel: flags.hasActiveStrictSentinel,
      ...(typeof opts.sampleCount === 'number' ? { sampleCount: opts.sampleCount } : {}),
      ...(typeof opts.text === 'string' && opts.text.trim() ? { text: opts.text.trim() } : {}),
      ...(opts.pageContext !== undefined ? { pageContext: opts.pageContext } : {}),
      ...(safeMessages.length > 0 ? { messages: safeMessages } : {}),
      ...(Array.isArray(salient) && salient.length > 0 ? { salientResources: salient } : {}),
    };

    if (!this.isWsConnected && this.connecting) {
      this.armInFlightWsTurn(turnSeq);
      this.enqueuePreConnect({ kind: 'json', turnSeq, payload });
      return true;
    }
    const ok = this.sendJson(payload);
    if (ok) {
      this.armInFlightWsTurn(turnSeq);
    }
    return ok;
  }

  /**
   * Report verified client-side `action.client_plan` execution outcome (`done`, `awaiting_confirmation`,
   * `failed`, `denied`, `unsupported`) and truthful `spokenMessage` back to the WS voice handler.
   */
  sendActionAck(turnSeq: number, status: string, spokenMessage: string): boolean {
    return this.sendJson({
      type: 'action.ack',
      turnSeq,
      sessionId: this.sessionId,
      status,
      spokenMessage,
    });
  }

  /**
   * Send `barge_in.probe` (`probeOnly: true`) gated on >= 96 ms post-PBFDAF Benesty NCC double-talk!
   * Defensively clamps to the latest <= 12,800 samples (800 ms = 25.6 KB PCM -> ~34.2 KiB base64)
   * so JSON text frames ALWAYS stay safely beneath the 64 KiB WebSocket ceiling.
   */
  sendBargeInProbe(turnSeq: number, pcm16: Int16Array, lang: 'auto' | 'en' | 'vi' = 'auto'): boolean {
    if (!this.isWsConnected || pcm16.length === 0) return false;
    const maxSamples = 12800; // 800 ms @ 16 kHz
    const bounded = pcm16.length > maxSamples ? pcm16.subarray(pcm16.length - maxSamples) : pcm16;
    return this.sendJson({
      type: 'barge_in.probe',
      turnSeq,
      pcmBase64: int16ToBase64(bounded),
      lang,
    });
  }

  /**
   * Escalate a Plane-A `action.client_plan` that could not resolve locally (e.g. empty MyBooks shelf)
   * into Plane-B LLM orchestration over the live WS!
   */
  sendTurnEscalate(params: { turnSeq: number; reason: string; text: string; pageContext?: unknown }): boolean {
    const flags = this.resolveSessionFlags();
    const ok = this.sendJson({
      type: 'turn.escalate',
      turnSeq: params.turnSeq,
      reason: params.reason,
      text: params.text,
      pathname: flags.pathname,
      hasPendingConfirmation: flags.hasPendingConfirmation,
      hasActiveStrictSentinel: flags.hasActiveStrictSentinel,
      pageContext: params.pageContext ?? null,
    });
    if (ok) {
      this.armInFlightWsTurn(params.turnSeq);
    }
    return ok;
  }

  /**
   * Decide a single-use server confirmation token (`EchoConfirmations`) directly over WS.
   */
  sendToolConfirm(token: string, decision: 'CONFIRM' | 'CANCEL'): boolean {
    return this.sendJson({ type: 'tool.confirm', token, decision });
  }

  clearBackchannelBuffer(turnSeq: number): void {
    this.sendJson({ type: 'input.clear_backchannel', turnSeq });
  }

  notifyPauseHold(turnSeq: number, playedMs: number): void {
    this.sendJson({ type: 'response.pause', turnSeq, playedMs });
  }

  notifyResumeHold(turnSeq: number): void {
    this.sendJson({ type: 'response.resume', turnSeq });
  }

  /**
   * Cancel in-flight assistant response and truncate stored assistant message to exact ear-heard words!
   */
  async cancelAndTruncateTurn(params: {
    turnSeq: number;
    playedMs: number;
    spokenText: string;
  }): Promise<void> {
    const cancelledHttpTurnId = this.activeHttpTurnId;
    this.activeHttpTurnId = null;
    this.httpTurnAbort?.abort();
    this.httpTurnAbort = null;
    this.preConnectQueue = [];
    this.clearInFlightWsTurn(params.turnSeq);

    if (cancelledHttpTurnId && typeof window !== 'undefined' && !this.wsFactory && !authEnding()) {
      void authFetch(`${getBaseUrl()}/ai/chat/stream/${encodeURIComponent(cancelledHttpTurnId)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(4000),
      }).catch(() => {});
    }

    if (this.isWsConnected) {
      this.sendJson({ type: 'response.cancel', turnSeq: params.turnSeq, sessionId: this.sessionId });
      if (params.spokenText.trim() || params.playedMs > 0) {
        this.sendJson({
          type: 'conversation.item.truncate',
          sessionId: this.sessionId,
          turnSeq: params.turnSeq,
          spokenText: params.spokenText,
          playedMs: params.playedMs,
        });
      }
      return;
    }

    if (this.sessionId && params.spokenText.trim()) {
      try {
        await authFetch(`${getBaseUrl()}/ai/chat/truncate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: this.sessionId,
            spokenText: params.spokenText,
            playedMs: params.playedMs,
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Best-effort history truncation
      }
    }
  }

  /**
   * Query Smart Turn v3.2 semantic prosody EOU via HTTP fallback (`<= 256 KB` 16 kHz PCM16LE).
   * Returns safe fallback `{ complete: true, probability: 0.7, recommendedWaitMs: 350 }` if unreachable.
   */
  async checkSmartTurn(recentPcm16: Int16Array): Promise<TurnCheckResult> {
    if (recentPcm16.byteLength < 640) {
      return { complete: false, probability: 0.2, recommendedWaitMs: 400 };
    }
    const maxSamples = 128000; // 256,000 bytes = 8.0 s @ 16 kHz
    const slice = recentPcm16.length > maxSamples ? recentPcm16.subarray(recentPcm16.length - maxSamples) : recentPcm16;
    const body = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer;

    try {
      const doFetch = typeof window !== 'undefined' && !this.wsFactory ? authFetch : this.fetchFn;
      const res = await doFetch(`${getBaseUrl()}/ai/chat/turn-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
        signal: AbortSignal.timeout(1200),
      });
      if (!res.ok) {
        return { complete: true, probability: 0.7, recommendedWaitMs: 350 };
      }
      const data = (await res.json()) as Partial<TurnCheckResult>;
      return {
        complete: typeof data.complete === 'boolean' ? data.complete : true,
        probability: typeof data.probability === 'number' ? data.probability : 0.7,
        recommendedWaitMs: typeof data.recommendedWaitMs === 'number' ? data.recommendedWaitMs : 350,
      };
    } catch {
      return { complete: true, probability: 0.7, recommendedWaitMs: 350 };
    }
  }

  /**
   * HTTP Fallback Step 1: Transcribe `16 kHz` `PCM16LE` via `/api/v1/ai/chat/transcribe?lang=auto|en|vi`.
   */
  async transcribeHttp(
    pcm16: Int16Array,
    lang: 'auto' | 'en' | 'vi' = 'auto',
    signal?: AbortSignal,
  ): Promise<TranscriptionResult> {
    if (pcm16.byteLength < 3200) {
      return {
        text: '',
        reviewNeeded: false,
        language: 'en',
        rejectedReason: 'too_short',
      };
    }
    const maxSamples = 320000; // 640,000 bytes = 20.0 s @ 16 kHz (matches EchoTranscriptionController.MAX_BYTES)
    const bounded = pcm16.length > maxSamples ? pcm16.subarray(pcm16.length - maxSamples) : pcm16;
    const body = bounded.buffer.slice(bounded.byteOffset, bounded.byteOffset + bounded.byteLength) as ArrayBuffer;
    const doFetch = typeof window !== 'undefined' && !this.wsFactory ? authFetch : this.fetchFn;
    const res = await doFetch(`${getBaseUrl()}/ai/chat/transcribe?lang=${encodeURIComponent(lang)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      signal,
    });
    if (!res.ok) {
      const code =
        res.status === 401 || res.status === 403
          ? 'unauthorized'
          : res.status === 429
            ? 'rate_limited'
            : 'stt_unavailable';
      throw new EchoVoiceTurnError(code, undefined, { status: res.status });
    }
    const json = (await res.json()) as {
      text?: string;
      reviewNeeded?: boolean;
      language?: string;
      rejectedReason?: string | null;
    };
    const rawText = (json.text ?? '').trim().slice(0, 4000);
    const rejectedReason =
      json.rejectedReason ?? (isRepetitiveAsrHallucination(rawText) ? 'repetition_loop' : null);
    const text = rejectedReason ? '' : rawText;
    const detected: 'en' | 'vi' =
      json.language === 'vi' || (json.language !== 'en' && VI_DIACRITIC_RE.test(text)) ? 'vi' : 'en';
    echoTelemetry.markSttFinal();
    return {
      text,
      reviewNeeded: json.reviewNeeded === true,
      language: detected,
      rejectedReason,
    };
  }

  /**
   * Repaired HTTP/SSE Fallback (Contract A):
   * - Sends exact `AiChatRequest`: `{ messages: [...history, { role: "user", content: message }], pageContext, channel: "voice", locale, turnId }`.
   * - Parses `parsed.token ?? parsed.delta ?? parsed.content ?? ""`, plus `actions`, `cards`, `status`, `error`, `done`.
   * - Streams `24 kHz` `PCM16LE` clauses from `/api/v1/ai/chat/speech/stream` -> `/api/v1/ai/chat/speech` -> device fallback.
   */
  async executeHttpFallbackTurn(params: {
    turnSeq: number;
    message: string;
    history?: { role: string; content: string }[];
    pageContext?: unknown;
    salientResources?: readonly unknown[];
    locale?: 'en' | 'vi';
    voiceId?: EchoJarvisVoiceId;
  }): Promise<string> {
    echoTelemetry.incrementCounter('httpFallbackTurns', 1);
    this.httpTurnAbort?.abort();
    const controller = new AbortController();
    this.httpTurnAbort = controller;
    const { signal } = controller;

    const turnSeq = params.turnSeq;
    const speaker = params.voiceId ?? this.voiceId;
    const locale = params.locale ?? this.locale;
    this.playback.beginTurn(turnSeq);

    const userMessage = String(params.message || '').trim().slice(0, 4000);
    if (!userMessage) return '';

    const prior = sanitizeHistoryMessages(params.history);
    const messages = [...prior, { role: 'user', content: userMessage }];
    const turnId = `voice-${turnSeq}-${Date.now().toString(36)}`;
    this.activeHttpTurnId = turnId;

    const salient = params.salientResources ?? this.callbacks.getSalientResources?.();
    const doFetch = typeof window !== 'undefined' && !this.wsFactory ? authFetch : this.fetchFn;
    const res = await doFetch(`${getBaseUrl()}/ai/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        messages,
        pageContext: params.pageContext ?? null,
        ...(Array.isArray(salient) && salient.length > 0 ? { salientResources: salient } : {}),
        channel: 'voice',
        locale,
        turnId,
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      this.activeHttpTurnId = null;
      const limitHeader = res.headers?.get?.('x-echo-limit') ?? undefined;
      if (res.status === 429 && limitHeader && limitHeader.startsWith('COACH_')) {
        throw new EchoVoiceTurnError('daily', undefined, {
          turnSeq,
          status: 429,
          limitKind: limitHeader,
        });
      }
      const code =
        res.status === 401 || res.status === 403
          ? 'unauthorized'
          : res.status === 429
            ? 'rate_limited'
            : res.status === 422
              ? 'length'
              : res.status === 503
                ? 'unavailable'
                : 'service_busy';
      throw new EchoVoiceTurnError(code, undefined, { turnSeq, status: res.status });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const chunker = new FirstClauseChunker();
    let sseRemainder = '';
    let fullText = '';
    let clauseCounter = 0;
    let ttsChain: Promise<void> = Promise.resolve();

    const enqueueClauseTts = (clause: string) => {
      if (!clause) return;
      const clauseId = `http-${turnSeq}-${clauseCounter++}`;
      if (speaker === 'device') {
        this.callbacks.onTtsFallback?.({ turnSeq, text: clause });
        return;
      }
      ttsChain = ttsChain.then(() =>
        this.streamSentenceTtsHttp(clause, speaker, locale, turnSeq, clauseId, signal),
      );
    };

    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        sseRemainder += decoder.decode(value, { stream: true });
        const lines = sseRemainder.split(/\r?\n/);
        sseRemainder = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payloadStr = trimmed.slice(5).trim();
          if (!payloadStr || payloadStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payloadStr) as {
              token?: string;
              content?: string;
              delta?: string;
              actions?: unknown[];
              cards?: unknown[];
              status?: string | number;
              error?: string;
              code?: string;
              message?: string;
              messageVi?: string;
              messageEn?: string;
              limitKind?: string;
              done?: boolean;
            };
            if (parsed.error) {
              const errCode = String(parsed.code || parsed.error || 'service_busy');
              const errStatus = typeof parsed.status === 'number' ? parsed.status : undefined;
              if (!fullText.trim()) {
                throw new EchoVoiceTurnError(errCode, parsed.message, {
                  turnSeq,
                  status: errStatus,
                  limitKind: parsed.limitKind,
                  messageVi: parsed.messageVi,
                  messageEn: parsed.messageEn,
                });
              }
              break;
            }
            if (typeof parsed.status === 'string' && parsed.status) {
              this.callbacks.onEntityState?.('thinking', turnSeq, parsed.status);
            }
            if ((parsed.actions && parsed.actions.length > 0) || (parsed.cards && parsed.cards.length > 0)) {
              this.callbacks.onActionsAndCards?.({
                actions: parsed.actions,
                cards: parsed.cards,
                turnSeq,
              });
            }
            // Contract A canonical field order: `token ?? delta ?? content ?? ""`
            const token = parsed.token ?? parsed.delta ?? parsed.content ?? '';
            if (token) {
              echoTelemetry.markFirstToken();
              fullText += token;
              this.callbacks.onLlmDelta?.(token, fullText, turnSeq);
              for (const clause of chunker.push(token, false)) {
                enqueueClauseTts(clause);
              }
            }
          } catch (innerErr) {
            if (innerErr instanceof EchoVoiceTurnError) {
              throw innerErr;
            }
            // Plain-text SSE fallback
            echoTelemetry.markFirstToken();
            fullText += payloadStr;
            this.callbacks.onLlmDelta?.(payloadStr, fullText, turnSeq);
            for (const clause of chunker.push(payloadStr, false)) {
              enqueueClauseTts(clause);
            }
          }
        }
      }

      if (!signal.aborted) {
        for (const tailClause of chunker.push('', true)) {
          enqueueClauseTts(tailClause);
        }
        await ttsChain;
        this.playback.markTurnAudioStreamFinished(turnSeq);
        this.callbacks.onTurnComplete?.(fullText, turnSeq, 'HTTP_FALLBACK');
      }
      return fullText;
    } finally {
      if (this.activeHttpTurnId === turnId) {
        this.activeHttpTurnId = null;
      }
      try {
        reader.releaseLock();
      } catch {
        // Ignore
      }
    }
  }

  private async streamSentenceTtsHttp(
    text: string,
    voiceId: Exclude<EchoJarvisVoiceId, 'device'>,
    lang: 'en' | 'vi',
    turnSeq: number,
    utteranceId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted || turnSeq < this.playback.currentTurnSeq) return;
    const doFetch = typeof window !== 'undefined' && !this.wsFactory ? authFetch : this.fetchFn;

    try {
      const res = await doFetch(`${getBaseUrl()}/ai/chat/speech/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId, lang, text }),
        signal,
      });

      if (res.ok && res.body) {
        const sampleRateHeader = Number(res.headers.get('x-sample-rate') || '24000') || 24000;
        const reader = res.body.getReader();
        const assembler = new EvenBytePcmStreamAssembler();
        let firstChunk = true;
        let enqueuedAny = false;
        try {
          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            const aligned = assembler.push(value);
            if (aligned) {
              this.playback.enqueuePcm16(aligned, {
                turnSeq,
                utteranceId,
                sampleRate: sampleRateHeader,
                text: firstChunk ? text : '',
              });
              firstChunk = false;
              enqueuedAny = true;
            }
          }
          if (enqueuedAny) return;
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      if (signal.aborted) return;
    }

    if (signal.aborted) return;
    try {
      const wavRes = await doFetch(`${getBaseUrl()}/ai/chat/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId, lang, text }),
        signal,
      });
      if (wavRes.ok) {
        const wavBuf = await wavRes.arrayBuffer();
        if (!signal.aborted) {
          const ok = await this.playback.enqueueWav(wavBuf, { turnSeq, utteranceId, text });
          if (ok) return;
        }
      }
    } catch {
      if (signal.aborted) return;
    }

    if (!signal.aborted) {
      this.callbacks.onTtsFallback?.({ turnSeq, text });
    }
  }

  private handleBinaryFrame(raw: ArrayBuffer | Uint8Array): void {
    const decoded = decodeBinaryAudioFrame(raw);
    if (!decoded) return;

    if (decoded.msgType === ECHO_WS_MSG_PING) {
      if (this.isWsConnected && this.ws) {
        try {
          const pongBuf =
            raw instanceof Uint8Array
              ? (raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
              : raw;
          this.ws.send(pongBuf);
        } catch {
          // Ignore
        }
      }
      return;
    }

    if (decoded.msgType !== ECHO_WS_MSG_TTS_PCM16) return;

    if (this.isStaleTurnSeq(decoded.turnSeq)) {
      echoTelemetry.incrementCounter('staleAudioFramesDropped', 1);
      return;
    }

    this.markInFlightTurnOutput(decoded.turnSeq);

    const segMeta = this.pendingSegmentMeta.get(decoded.turnSeq);
    const isFirstChunkOfClause = Boolean(segMeta && !segMeta.firstFrameConsumed);
    if (segMeta && !segMeta.firstFrameConsumed) {
      segMeta.firstFrameConsumed = true;
    }

    this.playback.enqueuePcm16(decoded.pcmBytes, {
      turnSeq: decoded.turnSeq,
      utteranceId: segMeta?.utteranceId ?? `u-${decoded.turnSeq}`,
      sampleRate: segMeta?.sampleRate ?? 24000,
      text: isFirstChunkOfClause ? (segMeta?.text ?? '') : '',
      wordTimings: isFirstChunkOfClause ? segMeta?.wordTimings : undefined,
    });
  }

  private handleJsonFrame(rawJson: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(rawJson) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(msg.type ?? '');
    const turnSeq = typeof msg.turnSeq === 'number' ? msg.turnSeq : this.activeTurnSeq;

    switch (type) {
      case 'pong':
        break;
      case 'session.ready': {
        this.callbacks.onSessionReady?.({
          sampleRateIn: typeof msg.sampleRateIn === 'number' ? msg.sampleRateIn : 16000,
          sampleRateOut: typeof msg.sampleRateOut === 'number' ? msg.sampleRateOut : 24000,
          maxFrameBytes: typeof msg.maxFrameBytes === 'number' ? msg.maxFrameBytes : 32768,
          voiceId: typeof msg.voiceId === 'string' ? msg.voiceId : undefined,
          lang: typeof msg.lang === 'string' ? msg.lang : undefined,
        });
        break;
      }
      case 'vad.state': {
        if (this.isStaleTurnSeq(msg.turnSeq)) break;
        const complete = msg.complete === true;
        if (complete && msg.state === 'eou_committed') {
          this.armInFlightWsTurn(turnSeq);
        }
        this.callbacks.onVadState?.({
          state: msg.state === 'eou_committed' ? 'eou_committed' : 'thinking_pause',
          turnSeq,
          complete,
          probability: typeof msg.probability === 'number' ? msg.probability : 0.5,
          recommendedWaitMs: typeof msg.recommendedWaitMs === 'number' ? msg.recommendedWaitMs : 450,
        });
        break;
      }
      case 'asr.partial': {
        const probeOnly = msg.probeOnly === true;
        if (!probeOnly && this.isStaleTurnSeq(msg.turnSeq)) break;
        const text = String(msg.text ?? msg.stableText ?? '').trim();
        const stableText = typeof msg.stableText === 'string' ? msg.stableText.trim() : undefined;
        if (text && isRepetitiveAsrHallucination(text)) {
          // Drop pathological Whisper repetition loops on sight
          break;
        }
        this.callbacks.onAsrPartial?.({
          text,
          stableText,
          lang: typeof msg.lang === 'string' ? msg.lang : undefined,
          turnSeq,
          probeOnly,
        });
        break;
      }
      case 'asr.final': {
        if (this.isStaleTurnSeq(msg.turnSeq)) {
          this.clearInFlightWsTurn(turnSeq);
          break;
        }
        echoTelemetry.markSttFinal();
        const rawText = String(msg.text ?? '').trim();
        const serverRejected = typeof msg.rejectedReason === 'string' && msg.rejectedReason ? msg.rejectedReason : null;
        const rejectedReason = serverRejected ?? (isRepetitiveAsrHallucination(rawText) ? 'repetition_loop' : null);
        const text = rejectedReason ? '' : rawText;
        const rawLang = String(msg.lang ?? msg.language ?? '');
        const lang: 'en' | 'vi' = rawLang === 'vi' || VI_DIACRITIC_RE.test(text) ? 'vi' : 'en';
        if (!text || rejectedReason) {
          this.clearInFlightWsTurn(turnSeq);
        } else {
          if (this.inFlightWsTurn && this.inFlightWsTurn.turnSeq === turnSeq) {
            this.inFlightWsTurn.asrText = text;
            this.inFlightWsTurn.asrLang = lang;
          }
          this.refreshInFlightTurnWatchdog(turnSeq);
        }
        this.callbacks.onAsrFinal?.({
          text,
          lang,
          reviewNeeded: msg.reviewNeeded === true,
          turnSeq,
          rejectedReason,
        });
        break;
      }
      case 'action.client_plan': {
        if (this.isStaleTurnSeq(msg.turnSeq)) break;
        this.markInFlightTurnOutput(turnSeq);
        const srvSessionId =
          typeof msg.sessionId === 'number' && Number.isSafeInteger(msg.sessionId) && msg.sessionId > 0
            ? msg.sessionId
            : undefined;
        if (srvSessionId !== undefined) {
          this.sessionId = srvSessionId;
        }
        const intents = Array.isArray(msg.intents) ? msg.intents : [];
        const spokenAck = String(msg.spokenAck ?? '').trim();
        const rawLang = msg.lang ?? msg.language;
        const lang: 'en' | 'vi' = rawLang === 'vi' ? 'vi' : 'en';
        const playEarcon =
          msg.playEarcon === 'action_ok' || msg.playEarcon === 'confirm' || msg.playEarcon === 'none'
            ? msg.playEarcon
            : 'action_ok';
        this.callbacks.onActionClientPlan?.({
          turnSeq,
          intents,
          spokenAck,
          lang,
          playEarcon,
          escalateOnEmpty: msg.escalateOnEmpty === true,
          ...(srvSessionId !== undefined ? { sessionId: srvSessionId } : {}),
        });
        break;
      }
      case 'action.guard': {
        if (this.isStaleTurnSeq(msg.turnSeq)) break;
        this.markInFlightTurnOutput(turnSeq);
        const decision = msg.decision === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'DENIED';
        const reason = String(msg.reason ?? 'policy_denied');
        const rawLang = msg.lang ?? msg.language;
        const lang: 'en' | 'vi' = rawLang === 'vi' ? 'vi' : 'en';
        const spokenMessage = String(
          msg.spokenMessage ??
            (lang === 'vi' ? msg.promptVi : msg.promptEn) ??
            msg.promptEn ??
            msg.promptVi ??
            '',
        ).trim();
        this.callbacks.onActionGuard?.({
          turnSeq,
          decision,
          reason,
          spokenMessage,
          lang,
        });
        break;
      }
      case 'barge_in.decision': {
        const rawDec = String(msg.decision ?? '').toLowerCase();
        const decision: 'backchannel' | 'interrupt' | 'none' =
          rawDec === 'backchannel'
            ? 'backchannel'
            : rawDec === 'interrupt' || rawDec === 'hard_cancel'
              ? 'interrupt'
              : 'none';
        if (decision === 'interrupt') {
          this.clearInFlightWsTurn(turnSeq);
        }
        if (this.isStaleTurnSeq(msg.turnSeq)) break;
        this.callbacks.onBargeInServerDecision?.({
          turnSeq,
          decision,
          text: typeof msg.text === 'string' ? msg.text.trim() : undefined,
        });
        break;
      }
      case 'llm.delta': {
        if (this.isStaleTurnSeq(msg.turnSeq)) break;
        this.markInFlightTurnOutput(turnSeq);
        echoTelemetry.markFirstToken();
        const delta = String(msg.delta ?? msg.token ?? msg.content ?? '');
        const prev = this.streamedTextByTurn.get(turnSeq) ?? '';
        const nextFull = prev + delta;
        this.streamedTextByTurn.set(turnSeq, nextFull);
        if (this.streamedTextByTurn.size > 8) {
          const oldest = this.streamedTextByTurn.keys().next().value;
          if (oldest !== undefined) this.streamedTextByTurn.delete(oldest);
        }
        this.callbacks.onLlmDelta?.(delta, nextFull, turnSeq);
        break;
      }
      case 'tts.segment_start': {
        if (this.isStaleTurnSeq(msg.turnSeq)) break;
        this.markInFlightTurnOutput(turnSeq);
        if (turnSeq >= this.activeTurnSeq) {
          this.activeTurnSeq = turnSeq;
          this.playback.beginTurn(turnSeq);
          this.pendingSegmentMeta.set(turnSeq, {
            utteranceId: typeof msg.utteranceId === 'string' ? msg.utteranceId : `${turnSeq}-0`,
            sampleRate: typeof msg.sampleRate === 'number' ? msg.sampleRate : 24000,
            text: typeof msg.text === 'string' ? msg.text : undefined,
            wordTimings: Array.isArray(msg.wordTimings) ? (msg.wordTimings as WordTimingSpan[]) : undefined,
            firstFrameConsumed: false,
          });
        }
        break;
      }
      case 'tts.fallback': {
        if (this.isStaleTurnSeq(msg.turnSeq)) break;
        this.markInFlightTurnOutput(turnSeq);
        const text = String(msg.text ?? '').trim();
        this.callbacks.onTtsFallback?.({ turnSeq, text });
        break;
      }
      case 'action.dispatch': {
        if (this.isStaleTurnSeq(msg.turnSeq)) break;
        this.markInFlightTurnOutput(turnSeq);
        this.callbacks.onActionsAndCards?.({
          actions: Array.isArray(msg.actions) ? msg.actions : undefined,
          cards: Array.isArray(msg.cards) ? msg.cards : undefined,
          confirmations: Array.isArray(msg.confirmations) ? msg.confirmations : undefined,
          turnSeq,
        });
        break;
      }
      case 'entity.state': {
        if (this.isStaleTurnSeq(msg.turnSeq)) break;
        if (typeof msg.state === 'string') {
          if (msg.state === 'thinking' || msg.state === 'executing') {
            this.refreshInFlightTurnWatchdog(turnSeq);
          }
          this.callbacks.onEntityState?.(msg.state, turnSeq, typeof msg.status === 'string' ? msg.status : undefined);
        }
        break;
      }
      case 'tts.done': {
        this.pendingSegmentMeta.delete(turnSeq);
        if (this.isStaleTurnSeq(msg.turnSeq)) break;
        this.playback.markTurnAudioStreamFinished(turnSeq);
        break;
      }
      case 'response.done': {
        this.clearInFlightWsTurn(turnSeq);
        this.pendingSegmentMeta.delete(turnSeq);
        if (this.isStaleTurnSeq(msg.turnSeq)) break;
        this.playback.markTurnAudioStreamFinished(turnSeq);
        const srvSessionId =
          typeof msg.sessionId === 'number' && Number.isSafeInteger(msg.sessionId) && msg.sessionId > 0
            ? msg.sessionId
            : undefined;
        if (srvSessionId !== undefined) {
          this.sessionId = srvSessionId;
        }
        const full = String(msg.reply ?? this.streamedTextByTurn.get(turnSeq) ?? msg.text ?? '');
        const route = typeof msg.route === 'string' ? msg.route : undefined;
        this.callbacks.onTurnComplete?.(full, turnSeq, route, srvSessionId);
        break;
      }
      case 'response.cancelled': {
        const reason = typeof msg.reason === 'string' && msg.reason ? msg.reason : undefined;
        this.clearInFlightWsTurn(turnSeq);
        this.pendingSegmentMeta.delete(turnSeq);
        if (turnSeq === this.playback.currentTurnSeq) {
          this.playback.markTurnAudioStreamFinished(turnSeq);
        }
        if (this.isStaleTurnSeq(msg.turnSeq) && reason !== 'merged') break;
        this.callbacks.onResponseCancelled?.(turnSeq, reason);
        break;
      }
      case 'conversation.item.truncated': {
        const truncSid =
          typeof msg.sessionId === 'number' && Number.isSafeInteger(msg.sessionId) && msg.sessionId > 0
            ? msg.sessionId
            : null;
        if (truncSid) this.sessionId = truncSid;
        this.callbacks.onTurnTruncated?.({
          turnSeq,
          spokenText: String(msg.spokenText ?? ''),
          truncated: msg.truncated === true,
          sessionId: truncSid,
        });
        break;
      }
      case 'tool.confirmed': {
        const plan = msg.plan && typeof msg.plan === 'object' ? (msg.plan as Record<string, unknown>) : undefined;
        const rawSaved = msg.savedCards ?? plan?.total ?? plan?.created;
        const savedCards = typeof rawSaved === 'number' && Number.isFinite(rawSaved) ? rawSaved : undefined;
        this.callbacks.onToolConfirmed?.({
          status: msg.status === 'APPLIED' ? 'APPLIED' : 'CANCELLED',
          plan,
          savedCards,
        });
        break;
      }
      case 'error': {
        const errTurnSeq = typeof msg.turnSeq === 'number' ? msg.turnSeq : undefined;
        this.clearInFlightWsTurn(errTurnSeq);
        if (errTurnSeq !== undefined) {
          this.pendingSegmentMeta.delete(errTurnSeq);
          if (errTurnSeq === this.playback.currentTurnSeq) {
            this.playback.markTurnAudioStreamFinished(errTurnSeq);
          }
          if (this.isStaleTurnSeq(errTurnSeq)) break;
        }
        this.callbacks.onError?.(
          String(msg.code ?? 'service_busy'),
          typeof msg.message === 'string' ? msg.message : undefined,
          {
            turnSeq: errTurnSeq,
            status: typeof msg.status === 'number' ? msg.status : undefined,
            limitKind: typeof msg.limitKind === 'string' ? msg.limitKind : undefined,
            resetsAt: typeof msg.resetsAt === 'string' ? msg.resetsAt : undefined,
            messageVi: typeof msg.messageVi === 'string' ? msg.messageVi : undefined,
            messageEn: typeof msg.messageEn === 'string' ? msg.messageEn : undefined,
            recoverable: typeof msg.recoverable === 'boolean' ? msg.recoverable : true,
          },
        );
        break;
      }
      default:
        break;
    }
  }

  disconnectImmediate(): void {
    this.intentionalClose = true;
    this.preConnectQueue = [];
    this.stopKeepalive();
    this.clearInFlightWsTurn();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const cancelledHttpTurnId = this.activeHttpTurnId;
    this.activeHttpTurnId = null;
    this.httpTurnAbort?.abort();
    this.httpTurnAbort = null;
    if (cancelledHttpTurnId && typeof window !== 'undefined' && !this.wsFactory && !authEnding()) {
      void authFetch(`${getBaseUrl()}/ai/chat/stream/${encodeURIComponent(cancelledHttpTurnId)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(4000),
      }).catch(() => {});
    }
    this.pendingSegmentMeta.clear();
    this.streamedTextByTurn.clear();

    if (this.ws) {
      const sock = this.ws;
      this.ws = null;
      sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
      try {
        sock.close(1000, 'client-disconnect');
      } catch {
        // Ignore
      }
    }
  }

  dispose(): void {
    this.unsubAuth?.();
    this.unsubAuth = null;
    this.disconnectImmediate();
  }
}
