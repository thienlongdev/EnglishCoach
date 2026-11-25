/**
 * Echo JARVIS Singleton Runtime (`Contract B`).
 *
 * Module-scoped lifecycle controller that owns the single persistent `EchoJarvisAudioSession`,
 * single `AudioContext`, WebSocket transport, procedural earcons, and the strict
 * **Single-Greeting Session Epoch** invariant.
 *
 * Design laws:
 * 1. NEVER owned by React component mount/unmount lifecycle — route changes, widget open/close,
 *    expand/collapse, presentation-mode switches, and tab focus/refocus NEVER restart the mic or
 *    replay a spoken greeting.
 * 2. Strict Single-Greeting Guarantee:
 *    - Explicit user toggle OFF -> ON (`setHandsFreeEnabled(true, { userInitiated: true })`)
 *      increments `handsFreeSessionEpoch` and may speak AT MOST ONE short welcome greeting for
 *      that epoch (`greetingSpokenEpoch < handsFreeSessionEpoch`).
 *    - `restoreHandsFreeSilently(userId)` on page reload restores passive wake listening with
 *      ZERO spoken greetings.
 *    - Every subsequent wake phrase and every manual `startActiveVoiceTurn()` tap plays ONLY
 *      a 65 ms procedural WebAudio earcon and transitions immediately into `awakening`/`listening`.
 * 3. `0 ms` synchronous teardown on logout (`registerUserScopedCleanup`, `onAuthWorkCancelled`,
 *    `subscribeAuthLifecycle`) and strict Sentinel lockdown (`subscribeStrictSentinel`).
 * 4. Strict `10 §AB` privacy boundary: passive WS events (`session.start`, `session.update`,
 *    `input.speech_started`) NEVER include `bookMeta` or `clientVisibleExcerpt`.
 */

import { registerUserScopedCleanup } from '@/lib/auth-cache-cleanup';
import { authEnding, onAuthWorkCancelled, subscribeAuthLifecycle } from '@/lib/auth-lifecycle';
import {
  getEchoWorkspaceContextSnapshot,
  utteranceReferencesBookOrPassage,
} from '@/lib/echo/contextBridge';
import { cleanSelection, recentSelection } from '@/lib/echo/pageContext';
import { hasActiveStrictSentinelAttempt, subscribeStrictSentinel } from '@/lib/sentinel/client';
import { echoIntelligenceApi } from '@/services/echoIntelligenceApi';
import { audioSessionArbiter } from '../audio/audioSessionArbiter';
import { type EchoEarconKind, EchoEarconSynth } from '../audio/earcons';
import { type EchoJarvisVoiceId } from '../audio/echoStreamingPlayback';
import {
  EchoVoiceTurnError,
  type ActionClientPlanEvent,
  type EchoVoiceErrorMeta,
} from '../audio/echoVoiceClient';
import { EchoJarvisAudioSession } from '../audio/index';
import {
  dispatchEchoIntent,
  getRegisteredEchoActionHost,
} from '../intents/actionDispatcher';
import { type EchoClientIntent, safeEchoJarvisHref } from '../intents/actionSchema';
import { type DagExecutionReport, executeIntentDag } from '../intents/dagExecutor';
import { compileEchoFastPath, detectUtteranceLanguage } from '../intents/fastPathCompiler';
import {
  clearActiveSalientResources,
  extractSalientResources,
  getSessionSalientResources,
  promoteActiveSalientResourcesToSession,
  setSessionSalientResources,
} from '../intents/salienceTracker';
import * as voiceStore from '../intents/voiceSessionStore';

export type { EchoVoiceErrorKind, EchoVoiceErrorState } from '../intents/voiceSessionStore';

export type EntityVisualState =
  | 'dormant'
  | 'awakening'
  | 'listening'
  | 'understanding'
  | 'thinking'
  | 'speaking'
  | 'executing'
  | 'interrupted'
  | 'sleeping'
  | 'disabled'
  | 'reconnecting'
  | 'error';

export type EchoPresentationMode = 'ambient' | 'chat' | 'immersive';

export interface EchoJarvisRuntimeConfig {
  userId: string;
  voiceId?: EchoJarvisVoiceId;
  locale?: 'en' | 'vi';
  sessionId?: number | null;
  exhausted?: boolean;
}

export interface EchoJarvisChatBridge {
  getHistory: () => { role: string; content: string }[];
  onAppendTurn: (
    userText: string,
    assistantText: string,
    cards?: unknown[],
    actions?: unknown[],
    opts?: { persistToServer?: boolean; sessionId?: number | null },
  ) => void;
  onTruncateTurn?: (
    userText: string,
    heardAssistantText: string,
    opts?: { sessionId?: number | null; turnSeq?: number },
  ) => void;
  onSyncSessionId?: (sessionId: number) => void;
  onInterruptChatTurn?: () => void;
}

export interface EchoActionToastPayload {
  id: string;
  kind: 'action' | 'resources' | 'stats' | 'confirm' | 'guard' | 'error';
  title: string;
  subtitle?: string;
  items?: Array<{ title: string; subtitle?: string; meta?: string; href?: string }>;
  confirmToken?: string;
  confirmSource?: 'client' | 'server';
  canUndo?: boolean;
  canRetry?: boolean;
  errorKind?: voiceStore.EchoVoiceErrorKind;
  expiresAt: number;
}

export interface EchoJarvisRuntimeApi {
  /** Configure active user, speaker, locale, and V46 sessionId WITHOUT restarting mic or re-greeting. */
  configure(opts: EchoJarvisRuntimeConfig): void;
  setEchoSessionId(sessionId: number | null): void;
  /** Reset active conversation session (`newChat()`), clearing active salience & pushing empty WS `session.update`. */
  resetConversationSession(): void;

  /** Bind callbacks for Chat history persistence and UI navigation host (ref-swapped, zero restart). */
  bindChatBridge(bridge: EchoJarvisChatBridge): () => void;

  /**
   * Explicit user toggle OFF -> ON increments handsFreeSessionEpoch and plays AT MOST ONE greeting
   * for this epoch. Page-reload restoration calls `restoreHandsFreeSilently()` -> ZERO spoken greeting.
   */
  setHandsFreeEnabled(enabled: boolean, opts?: { userInitiated?: boolean }): Promise<boolean>;
  restoreHandsFreeSilently(userId: string): Promise<boolean>;

  /** Manual voice activation (Orb tap / Mic button): enters LISTENING immediately with 65 ms earcon, ZERO spoken greeting. */
  startActiveVoiceTurn(): Promise<boolean>;

  /** Submit typed text via Plane A (<15 ms) -> WS/Plane B (reuses same brain and session). */
  submitTextTurn(text: string): Promise<void>;

  /** Retry the most recent failed voice/text turn (`service_busy` / `connection_interrupted`). */
  retryLastVoiceTurn(): Promise<boolean>;

  /** Clear any active typed error state/toast and restore normal listening/dormant standby. */
  dismissError(): void;

  /** Mute/unmute, interrupt active speech, sleep to DORMANT, or confirm/cancel pending confirmation token. */
  setMuted(muted: boolean): void;
  interruptCurrentTurn(): void;
  enterSleep(opts?: { silent?: boolean }): void;
  decideConfirmation(decision: 'confirm' | 'cancel'): Promise<void>;
  confirmPendingAction(): Promise<void>;
  cancelPendingAction(): Promise<void>;
  undoLastUiAction(): Promise<boolean>;
  isSpeechOutputActive(): boolean;

  /** Hard 0 ms teardown on logout or strict Sentinel lockdown. */
  hardTeardown(): void;
}

export interface GreetingEpochDiagnostics {
  userId: string;
  handsFreeEnabled: boolean;
  handsFreeSessionEpoch: number;
  greetingSpokenEpoch: number;
  spokenGreetingsCount: number;
  earconsPlayedCount: number;
  lastEarconKind: EchoEarconKind | null;
}

export interface EchoJarvisRuntimeInternalOptions {
  /** Optional custom audio session factory for deterministic headless tests. */
  sessionFactory?: () => EchoJarvisAudioSession;
  /** Optional custom greeting player for headless tests verifying exact greeting invocation count. */
  playGreetingImpl?: (voiceId: EchoJarvisVoiceId, locale: 'en' | 'vi') => Promise<boolean> | boolean;
  /** Optional undo handler override. */
  undoHandler?: () => Promise<boolean> | boolean;
  /** Optional workspace context provider (used to inject contextBridge snapshots without circular imports). */
  getWorkspaceContext?: (opts?: { includeOnDemandBook?: boolean }) => Record<string, unknown> | null;
}

const GREETING_EPOCH_STORAGE_PREFIX = 'ec_jarvis_greeting_epoch:u';

const WAKE_PHRASE_PREFIX_RE =
  /^(?:(?:hi|high|hey|hello|ok|okay|yo|chào|chao|này|nay|ơi|oi)\s*[,.!?\-–—]*\s*)?(?:echo(?:\s+jarvis)?|jarvis)(?:\s+(?:ơi|oi))?\s*[,.!?\-–—:]+\s*/iu;

const WAKE_PHRASE_LOOSE_PREFIX_RE =
  /^(?:(?:hi|high|hey|hello)\s+)?(?:echo\s+jarvis|echo)\s+(?=\S)/iu;

const BARE_WAKE_ONLY_RE =
  /^(?:(?:hi|high|hey|hello|ok|okay|chào|chao)\s*[,.!?\-–—]*\s*)?(?:echo(?:\s+jarvis)?|jarvis)(?:\s+(?:ơi|oi))?\s*[.!?]*$/iu;

const BOOK_EXCERPT_CUE_RE =
  /\b(this|page|passage|book|chapter|paragraph|sentence|excerpt|highlighted|highlight|trang này|bài này|bài đọc này|đoạn này|đoạn văn này|câu này|cuốn sách|chương này|sách này|chỗ đang đọc|đang đọc gì)\b/iu;

/**
 * Deterministically strips leading wake phrases ("Hey Echo, open Reading" -> "open Reading")
 * so Single-Breath Wake + Command audio with 300 ms pre-lead cleanly enters Plane A / Plane B.
 */
export function stripWakePhrasePrefix(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  if (BARE_WAKE_ONLY_RE.test(trimmed)) return '';
  let cleaned = trimmed.replace(WAKE_PHRASE_PREFIX_RE, '').trim();
  if (cleaned === trimmed) {
    cleaned = trimmed.replace(WAKE_PHRASE_LOOSE_PREFIX_RE, '').trim();
  }
  return cleaned;
}

function cleanUserId(raw: string | number | null | undefined): string {
  return String(raw ?? '').replace(/[^\w-]/g, '');
}

function rawActionDedupeKey(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const act = raw as Record<string, unknown>;
  if (act.type === 'client_intent' && act.intent && typeof act.intent === 'object') {
    return `ci:${JSON.stringify(act.intent)}`;
  }
  if (typeof act.href === 'string' && act.href) {
    return `${String(act.type ?? 'navigate')}:${act.href}`;
  }
  return JSON.stringify(act);
}

function mergeRawActions(existing: unknown[], incoming?: unknown[]): unknown[] {
  if (!Array.isArray(incoming) || incoming.length === 0) return existing;
  const out = [...existing];
  const indexByKey = new Map<string, number>();
  out.forEach((item, idx) => {
    const k = rawActionDedupeKey(item);
    if (k) indexByKey.set(k, idx);
  });
  for (const item of incoming) {
    const k = rawActionDedupeKey(item);
    if (!k) continue;
    const prevIdx = indexByKey.get(k);
    if (prevIdx !== undefined) {
      const prevObj = out[prevIdx] as Record<string, unknown>;
      const nextObj = item as Record<string, unknown>;
      if (nextObj.auto === true && prevObj.auto !== true) {
        out[prevIdx] = { ...prevObj, auto: true };
      }
      continue;
    }
    indexByKey.set(k, out.length);
    out.push(item);
  }
  return out.slice(0, 8);
}

function rawCardDedupeKey(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const card = raw as Record<string, unknown>;
  const type = String(card.type ?? card.kind ?? '');
  if (type === 'confirm' && typeof card.token === 'string') {
    return `confirm:${card.token}`;
  }
  const items = Array.isArray(card.items)
    ? (card.items as Array<Record<string, unknown>>)
        .map((i) => `${String(i?.href ?? '')}:${String(i?.title ?? '')}`)
        .join('|')
    : '';
  return `${type}:${String(card.title ?? '')}:${items}`;
}

function mergeRawCards(existing: unknown[], incoming?: unknown[]): unknown[] {
  if (!Array.isArray(incoming) || incoming.length === 0) return existing;
  const out = [...existing];
  const seen = new Set<string>(out.map(rawCardDedupeKey).filter(Boolean));
  for (const item of incoming) {
    const k = rawCardDedupeKey(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out.slice(0, 6);
}

function sanitizePassiveContext(ctx: unknown): Record<string, unknown> | null {
  if (!ctx || typeof ctx !== 'object') return null;
  const src = ctx as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    // 10 §AB privacy law: NEVER send local book metadata or visible text excerpts passively!
    if (k === 'bookMeta' || k === 'clientVisibleExcerpt' || k === 'recentHighlights') {
      continue;
    }
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Synchronize greeting epoch state directly with `voiceSessionStore`.
 */
function syncStoreWsConnected(connected: boolean): void {
  voiceStore.setWsConnected(connected);
}

function syncStoreActionToast(
  toast: (Omit<EchoActionToastPayload, 'id' | 'expiresAt'> & { ttlMs?: number }) | null,
): void {
  if (!toast) {
    voiceStore.clearActiveToast();
    return;
  }
  voiceStore.setActiveToast(toast);
}

function readStoredGreetingEpoch(userId: string): { sessionEpoch: number; spokenEpoch: number } | null {
  if (!userId || typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(`${GREETING_EPOCH_STORAGE_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { s?: number; g?: number };
    const sessionEpoch = typeof parsed.s === 'number' && parsed.s >= 0 ? Math.floor(parsed.s) : 0;
    const spokenEpoch = typeof parsed.g === 'number' && parsed.g >= 0 ? Math.floor(parsed.g) : 0;
    return { sessionEpoch, spokenEpoch };
  } catch {
    return null;
  }
}

function writeStoredGreetingEpoch(userId: string, sessionEpoch: number, spokenEpoch: number): void {
  if (!userId || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      `${GREETING_EPOCH_STORAGE_PREFIX}${userId}`,
      JSON.stringify({ s: sessionEpoch, g: spokenEpoch }),
    );
  } catch {
    // SessionStorage unavailable: in-memory epoch still enforces the invariant
  }
}

function clearStoredGreetingEpoch(userId: string): void {
  if (!userId || typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(`${GREETING_EPOCH_STORAGE_PREFIX}${userId}`);
  } catch {
    // Ignore
  }
}

export class EchoJarvisRuntime implements EchoJarvisRuntimeApi {
  private readonly internalOpts: EchoJarvisRuntimeInternalOptions;
  private readonly earcons = new EchoEarconSynth();

  private audioSession: EchoJarvisAudioSession | null = null;
  private chatBridge: EchoJarvisChatBridge | null = null;
  private workspaceContextProvider:
    | ((opts?: { includeOnDemandBook?: boolean }) => Record<string, unknown> | null)
    | null = null;

  private userId = '';
  private voiceId: EchoJarvisVoiceId = 'us_female';
  private locale: 'en' | 'vi' = 'en';
  private sessionId: number | null = null;
  private exhausted = false;
  private handsFreeEnabled = false;
  private muted = false;

  // Strict Single-Greeting Session Epoch counters
  private handsFreeSessionEpoch = 0;
  private greetingSpokenEpoch = 0;
  private spokenGreetingsCount = 0;
  private lastUserTranscript = '';
  private pendingTurnUserText = '';
  private readonly userTranscriptByTurn = new Map<number, string>();
  private lastFailedUserText = '';
  private lastErrorKind: voiceStore.EchoVoiceErrorKind | null = null;
  private lastAppendedTurnSeq = -1;
  private activeSalienceTurnSeq = -1;
  private turnRecordedCardSalience = false;
  private pendingTurnCards: unknown[] = [];
  private pendingTurnActions: unknown[] = [];
  private lastSyncedSessionPrefs: {
    session: EchoJarvisAudioSession;
    voiceId: EchoJarvisVoiceId;
    locale: 'en' | 'vi';
    sessionId: number | null;
    handsFreeWake: boolean;
  } | null = null;
  private sleepResetTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

  // Reversible session undo stack for local fallback when dagExecutor undo is not registered
  private undoStack: Array<() => Promise<boolean> | boolean> = [];

  private lifecycleBound = false;

  constructor(options: EchoJarvisRuntimeInternalOptions = {}, bindGlobalLifecycle = true) {
    this.internalOpts = options;
    if (options.getWorkspaceContext) {
      this.workspaceContextProvider = options.getWorkspaceContext;
    }
    if (bindGlobalLifecycle) {
      this.bindGlobalLifecycleOnce();
    }
  }

  private bindGlobalLifecycleOnce(): void {
    if (this.lifecycleBound) return;
    this.lifecycleBound = true;

    registerUserScopedCleanup(() => {
      this.hardTeardown();
    });

    onAuthWorkCancelled(() => {
      if (authEnding()) {
        this.hardTeardown();
      }
    });

    subscribeAuthLifecycle(() => {
      if (authEnding()) {
        this.hardTeardown();
      }
    });

    subscribeStrictSentinel(() => {
      if (hasActiveStrictSentinelAttempt()) {
        this.hardTeardown();
      }
    });

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('ec:jarvis:voice-control', (event: Event) => {
        const detail = (event as CustomEvent<{ command?: string }>).detail;
        const cmd = detail?.command;
        if (cmd === 'sleep') {
          this.enterSleep({ silent: true });
        } else if (cmd === 'mute') {
          this.setMuted(true);
        } else if (cmd === 'unmute') {
          this.setMuted(false);
        }
      });
    }
  }

  /**
   * Bind an optional workspace context provider (e.g. `getEchoWorkspaceContextSnapshot` from `contextBridge.ts`).
   */
  bindWorkspaceContextProvider(
    provider: (opts?: { includeOnDemandBook?: boolean }) => Record<string, unknown> | null,
  ): () => void {
    this.workspaceContextProvider = provider;
    return () => {
      if (this.workspaceContextProvider === provider) {
        this.workspaceContextProvider = null;
      }
    };
  }

  getAudioSession(): EchoJarvisAudioSession | null {
    return this.audioSession;
  }

  isSpeechOutputActive(): boolean {
    const s = this.audioSession;
    if (!s) return false;
    const maybeActive = (s as EchoJarvisAudioSession & { isSpeechOutputActive?: boolean }).isSpeechOutputActive;
    if (typeof maybeActive === 'boolean') {
      return maybeActive;
    }
    return Boolean(s.playback.isPlaying || s.playback.isPausedHold);
  }

  getGreetingDiagnostics(): GreetingEpochDiagnostics {
    const history = this.earcons.getHistory();
    return {
      userId: this.userId,
      handsFreeEnabled: this.handsFreeEnabled,
      handsFreeSessionEpoch: this.handsFreeSessionEpoch,
      greetingSpokenEpoch: this.greetingSpokenEpoch,
      spokenGreetingsCount: this.spokenGreetingsCount,
      earconsPlayedCount: history.length,
      lastEarconKind: history.length > 0 ? history[history.length - 1].kind : null,
    };
  }

  playEarcon(kind: EchoEarconKind): boolean {
    if (this.muted || hasActiveStrictSentinelAttempt() || authEnding()) {
      return false;
    }
    const playback = this.audioSession?.playback;
    const ctx = playback?.ensureAudioContext() ?? null;
    const sink = playback?.getAnalyserNode() ? ctx?.destination ?? null : ctx?.destination ?? null;
    // If playback exposes playEarcon (upgraded EchoStreamingPlayback), delegate so it taps the TTS AnalyserNode too!
    const upgraded = playback as unknown as { playEarcon?: (k: EchoEarconKind) => boolean } | undefined;
    if (upgraded && typeof upgraded.playEarcon === 'function') {
      const played = upgraded.playEarcon(kind);
      // Still track in earcon history for diagnostics
      this.earcons.play(null, kind);
      return played;
    }
    return this.earcons.play(ctx, kind, sink);
  }

  /**
   * Configure active user, speaker, locale, and V46 sessionId WITHOUT restarting mic or re-greeting!
   */
  configure(opts: EchoJarvisRuntimeConfig): void {
    const nextUser = cleanUserId(opts.userId);
    const userChanged = Boolean(nextUser && this.userId && nextUser !== this.userId);

    if (userChanged) {
      this.hardTeardown();
    }

    if (nextUser && nextUser !== this.userId) {
      this.userId = nextUser;
      voiceStore.setVoiceSessionUser(nextUser);
      const restored = readStoredGreetingEpoch(nextUser);
      if (restored) {
        this.handsFreeSessionEpoch = restored.sessionEpoch;
        this.greetingSpokenEpoch = restored.spokenEpoch;
      } else {
        this.handsFreeSessionEpoch = 0;
        this.greetingSpokenEpoch = 0;
      }
    }

    if (opts.voiceId) this.voiceId = opts.voiceId;
    if (opts.locale) this.locale = opts.locale;
    if (opts.sessionId !== undefined) {
      this.applyEchoSessionIdState(opts.sessionId);
    }
    if (typeof opts.exhausted === 'boolean') {
      this.exhausted = opts.exhausted;
    }

    this.syncSessionPreferences();
  }

  setEchoSessionId(sessionId: number | null): void {
    this.applyEchoSessionIdState(sessionId);
    this.syncSessionPreferences();
  }

  private applyEchoSessionIdState(sessionId: number | null): number | null {
    const normalized =
      typeof sessionId === 'number' && Number.isSafeInteger(sessionId) && sessionId > 0
        ? sessionId
        : null;
    this.sessionId = normalized;
    voiceStore.setActiveVoiceConversationId(normalized);
    if (normalized !== null) {
      promoteActiveSalientResourcesToSession(normalized, this.userId);
    }
    return normalized;
  }

  private syncSessionPreferences(
    overrides?: Partial<{
      voiceId: EchoJarvisVoiceId;
      locale: 'en' | 'vi';
      sessionId: number | null;
      handsFreeWake: boolean;
    }>,
  ): void {
    const session = this.audioSession;
    if (!session) {
      this.lastSyncedSessionPrefs = null;
      return;
    }
    const next = {
      voiceId: overrides?.voiceId ?? this.voiceId,
      locale: overrides?.locale ?? this.locale,
      sessionId: overrides?.sessionId !== undefined ? overrides.sessionId : this.sessionId,
      handsFreeWake: overrides?.handsFreeWake ?? this.handsFreeEnabled,
    };
    const prev = this.lastSyncedSessionPrefs;
    if (
      prev &&
      prev.session === session &&
      prev.voiceId === next.voiceId &&
      prev.locale === next.locale &&
      prev.sessionId === next.sessionId &&
      prev.handsFreeWake === next.handsFreeWake
    ) {
      return;
    }
    this.lastSyncedSessionPrefs = { session, ...next };
    session.setPreferences(next);
  }

  private recordTurnTranscript(turnSeq: number, text: string): void {
    if (typeof turnSeq !== 'number' || turnSeq <= 0 || !text) return;
    this.userTranscriptByTurn.set(turnSeq, text);
    if (this.userTranscriptByTurn.size > 24) {
      const oldest = this.userTranscriptByTurn.keys().next().value;
      if (oldest !== undefined) {
        this.userTranscriptByTurn.delete(oldest);
      }
    }
  }

  resetConversationSession(): void {
    this.sessionId = null;
    this.lastUserTranscript = '';
    this.pendingTurnUserText = '';
    this.userTranscriptByTurn.clear();
    this.lastFailedUserText = '';
    this.pendingTurnCards = [];
    this.pendingTurnActions = [];
    this.turnRecordedCardSalience = false;
    clearActiveSalientResources(this.userId);
    voiceStore.setActiveVoiceConversationId(null);
    voiceStore.clearPendingConfirmation();
    voiceStore.clearVoiceLiveCaption();
    if (this.audioSession) {
      this.lastSyncedSessionPrefs = {
        session: this.audioSession,
        voiceId: this.voiceId,
        locale: this.locale,
        sessionId: null,
        handsFreeWake: this.handsFreeEnabled,
      };
      this.audioSession.voiceClient.setSessionConfig?.({
        sessionId: null,
        voiceId: this.voiceId,
        locale: this.locale,
      });
      if (this.audioSession.voiceClient.isWsConnected) {
        this.audioSession.voiceClient.updateSession({
          voiceId: this.voiceId,
          locale: this.locale,
          sessionId: null,
          resetSession: true,
          messages: [],
          salientResources: [],
          pageContext: this.resolvePassivePageContext(),
        });
      }
    } else {
      this.lastSyncedSessionPrefs = null;
    }
  }

  private adoptServerSessionId(sessionId?: number | null): void {
    if (typeof sessionId !== 'number' || !Number.isSafeInteger(sessionId) || sessionId <= 0) {
      return;
    }
    const changed = this.sessionId !== sessionId;
    this.setEchoSessionId(sessionId);
    if (changed) {
      this.chatBridge?.onSyncSessionId?.(sessionId);
    }
  }

  /**
   * Bind chat history and append callbacks via ref-swap with zero mic restart or re-greeting.
   */
  bindChatBridge(bridge: EchoJarvisChatBridge): () => void {
    this.chatBridge = bridge;
    return () => {
      if (this.chatBridge === bridge) {
        this.chatBridge = null;
      }
    };
  }

  /**
   * Explicit toggle OFF -> ON (`userInitiated: true`) increments `handsFreeSessionEpoch` and plays
   * AT MOST ONE welcome greeting for this epoch. Repeat calls when already enabled do NOT re-greet!
   */
  async setHandsFreeEnabled(enabled: boolean, opts?: { userInitiated?: boolean }): Promise<boolean> {
    if (authEnding() || hasActiveStrictSentinelAttempt()) {
      this.hardTeardown();
      return false;
    }

    const userInitiated = opts?.userInitiated === true;
    const wasEnabled = this.handsFreeEnabled;

    if (!enabled) {
      this.handsFreeEnabled = false;
      voiceStore.setHandsFreeEnabled(false, { userInitiated });
      if (userInitiated) {
        // Turning JARVIS off is an explicit exit from the voice presentation.
        voiceStore.setVoiceStage(false);
      }
      this.clearTimers();
      if (userInitiated && wasEnabled) {
        this.playEarcon('sleep');
      }
      this.lastErrorKind = null;
      this.pendingTurnUserText = '';
      this.syncSessionPreferences({ handsFreeWake: false });
      this.audioSession?.stop();
      voiceStore.clearActiveToast();
      voiceStore.clearVoiceError();
      voiceStore.clearPendingConfirmation();
      voiceStore.setVoiceEntityState('disabled');
      voiceStore.clearVoiceLiveCaption();
      return true;
    }

    // Enabling hands-free
    if (!audioSessionArbiter.canJarvisOperate('echo-hands-free-wake')) {
      voiceStore.setHandsFreeEnabled(true, { userInitiated: false });
      this.handsFreeEnabled = true;
      this.syncSessionPreferences({ handsFreeWake: true });
      voiceStore.setVoiceEntityState('dormant');
      return false;
    }

    this.clearErrorRecoveryTimer();
    this.lastErrorKind = null;
    voiceStore.clearVoiceError();

    const session = this.ensureAudioSession();
    // Set handsFreeWake=true BEFORE starting & before welcome greeting plays so onPlaybackEnd returns to 'dormant' (NEVER 'disabled')!
    this.syncSessionPreferences({
      handsFreeWake: true,
      voiceId: this.voiceId,
      locale: this.locale,
      sessionId: this.sessionId,
    });
    const ok = await session.start('hands-free-dormant');
    if (!ok) {
      this.handsFreeEnabled = false;
      this.syncSessionPreferences({ handsFreeWake: false });
      voiceStore.setHandsFreeEnabled(false, { userInitiated: false });
      if (!voiceStore.getVoiceSessionSnapshot().lastError) {
        this.handleTypedVoiceError('mic_unavailable');
      }
      return false;
    }

    this.handsFreeEnabled = true;
    voiceStore.setHandsFreeEnabled(true, { userInitiated });
    voiceStore.setVoiceEntityState('dormant');

    // STRICT SINGLE-GREETING SESSION EPOCH GUARD:
    // Only on an explicit user OFF -> ON transition may Echo speak ONE welcome greeting!
    if (userInitiated && !wasEnabled) {
      this.handsFreeSessionEpoch += 1;
      writeStoredGreetingEpoch(this.userId, this.handsFreeSessionEpoch, this.greetingSpokenEpoch);

      if (
        this.greetingSpokenEpoch < this.handsFreeSessionEpoch &&
        voiceStore.shouldPlayHandsFreeGreeting() &&
        !this.muted &&
        !this.exhausted
      ) {
        // Atomically claim the epoch BEFORE async playback so concurrent calls can NEVER double-greet!
        this.greetingSpokenEpoch = this.handsFreeSessionEpoch;
        this.spokenGreetingsCount += 1;
        voiceStore.markGreetingSpoken();
        writeStoredGreetingEpoch(this.userId, this.handsFreeSessionEpoch, this.greetingSpokenEpoch);

        try {
          if (this.internalOpts.playGreetingImpl) {
            await this.internalOpts.playGreetingImpl(this.voiceId, this.locale);
          } else {
            await session.playback.playWakeGreeting(this.voiceId, this.locale);
          }
        } catch {
          // Never block hands-free activation on optional welcome audio
        }
      }
    }

    return true;
  }

  /**
   * Silent page-reload restoration when persisted `ec_jarvis_handsfree:u<id>` is `'1'`.
   * GUARANTEES ZERO spoken greetings!
   */
  async restoreHandsFreeSilently(rawUserId: string): Promise<boolean> {
    const uid = cleanUserId(rawUserId);
    if (!uid || authEnding() || hasActiveStrictSentinelAttempt()) {
      return false;
    }

    this.configure({ userId: uid });

    // Lock greetingSpokenEpoch >= handsFreeSessionEpoch so reload can NEVER speak a greeting
    if (this.handsFreeSessionEpoch === 0) {
      this.handsFreeSessionEpoch = 1;
    }
    this.greetingSpokenEpoch = Math.max(this.greetingSpokenEpoch, this.handsFreeSessionEpoch);
    voiceStore.markGreetingSpoken();
    writeStoredGreetingEpoch(uid, this.handsFreeSessionEpoch, this.greetingSpokenEpoch);

    return this.setHandsFreeEnabled(true, { userInitiated: false });
  }

  /**
   * Manual voice activation (Orb tap / Mic button):
   * - ZERO spoken greetings!
   * - Plays crisp 65 ms procedural `'wake'` earcon.
   * - Immediately enters `'listening'` and opens/reuses the single persistent AudioContext & WS.
   */
  async startActiveVoiceTurn(): Promise<boolean> {
    if (authEnding() || hasActiveStrictSentinelAttempt()) {
      this.hardTeardown();
      return false;
    }
    if (this.exhausted) {
      this.handleTypedVoiceError('quota_exceeded', undefined, { status: 429, limitKind: 'daily', recoverable: false });
      return false;
    }
    if (!audioSessionArbiter.canJarvisOperate('echo-active-voice')) {
      return false;
    }

    this.clearTimers();
    this.lastErrorKind = null;
    voiceStore.clearVoiceError();
    this.muted = false;
    voiceStore.setVoiceMuted(false);

    const session = this.ensureAudioSession();
    // If Echo was mid-speech, interrupt cleanly first
    if (session.playback.isPlaying || session.playback.isPausedHold) {
      const cancelled = session.playback.hardCancel();
      if (!cancelled.wasGreeting) {
        void session.voiceClient.cancelAndTruncateTurn({
          turnSeq: cancelled.turnSeq,
          playedMs: cancelled.playedMs,
          spokenText: cancelled.spokenTextSoFar,
        });
      }
      this.chatBridge?.onInterruptChatTurn?.();
    }

    voiceStore.setVoiceEntityState('awakening');
    const started = await session.start('active-conversation');
    if (!started) {
      if (!voiceStore.getVoiceSessionSnapshot().lastError) {
        this.handleTypedVoiceError('mic_unavailable');
      }
      return false;
    }

    // Play 65 ms crystalline earcon (NEVER a spoken greeting!)
    this.playEarcon('wake');
    voiceStore.setVoiceEntityState('listening');
    return true;
  }

  /**
   * Submit typed or resolved user text via Plane A (< 15 ms) -> WS / Plane B fallback.
   */
  async submitTextTurn(rawText: string): Promise<void> {
    const cleaned = stripWakePhrasePrefix(rawText) || rawText.trim();
    if (!cleaned || authEnding() || hasActiveStrictSentinelAttempt()) return;

    this.clearErrorRecoveryTimer();
    this.lastErrorKind = null;
    voiceStore.clearVoiceError();
    this.lastUserTranscript = cleaned;
    this.pendingTurnCards = [];
    this.pendingTurnActions = [];
    this.turnRecordedCardSalience = false;
    voiceStore.setVoiceLiveCaption({ userPartial: cleaned });

    const lang = detectUtteranceLanguage(cleaned);
    const handledLocally = await this.tryExecuteLocalFastPath(cleaned, lang, true);
    if (handledLocally) {
      this.pendingTurnUserText = '';
      this.lastFailedUserText = '';
      voiceStore.setVoiceLiveCaption({ userPartial: '' });
      return;
    }

    this.pendingTurnUserText = cleaned;

    if (this.exhausted) {
      this.handleTypedVoiceError('quota_exceeded', undefined, { status: 429, limitKind: 'daily', recoverable: false });
      return;
    }

    voiceStore.setVoiceEntityState('thinking');
    const session = this.ensureAudioSession();
    const turnSeq = session.voiceClient.nextTurnSeq();
    this.recordTurnTranscript(turnSeq, cleaned);
    (session as EchoJarvisAudioSession & { markTurnWaitingForResponse?: (seq?: number) => void }).markTurnWaitingForResponse?.(
      turnSeq,
    );
    const pathname = typeof window !== 'undefined' ? window.location.pathname : '/dashboard';
    const turnPageContext = this.resolveCurrentPageContext(pathname, false, cleaned);
    const history = this.chatBridge?.getHistory?.() ?? [];
    const salientResources = getSessionSalientResources(this.sessionId, this.userId);

    if (session.voiceClient.isWsConnected) {
      const sent = session.voiceClient.commitInput?.(turnSeq, {
        text: cleaned,
        lang: 'auto',
        locale: this.locale,
        voiceId: this.voiceId,
        pageContext: turnPageContext,
        messages: history,
        salientResources,
      });
      if (sent !== false) {
        if (typeof session.voiceClient.commitInput !== 'function') {
          session.voiceClient.sendJson({
            type: 'input.commit',
            turnSeq,
            sessionId: this.sessionId,
            text: cleaned,
            lang: 'auto',
            locale: this.locale,
            voiceId: this.voiceId,
            pageContext: turnPageContext,
            ...(history.length > 0 ? { messages: history } : {}),
            ...(salientResources.length > 0 ? { salientResources } : {}),
          });
        }
        return;
      }
    }

    // Seamless HTTP/SSE fallback sharing the exact same brain & playback
    try {
      const reply = await session.voiceClient.executeHttpFallbackTurn({
        turnSeq,
        message: cleaned,
        history,
        pageContext: turnPageContext,
        salientResources,
        locale: lang,
        voiceId: this.voiceId,
      });
      this.pendingTurnUserText = '';
      this.lastFailedUserText = '';
      voiceStore.setVoiceLiveCaption({ userPartial: '' });
      if (reply) {
        this.appendTurnOnce(turnSeq, cleaned, reply, { persistToServer: true });
      }
      if (!this.isSpeechOutputActive()) {
        voiceStore.setVoiceEntityState(
          session.isActiveConversation ? 'listening' : this.handsFreeEnabled ? 'dormant' : 'disabled',
        );
      }
    } catch (err) {
      if (err instanceof EchoVoiceTurnError) {
        this.handleTypedVoiceError(err.code, err.message, err.meta);
      } else {
        this.handleTypedVoiceError(err instanceof Error ? err.message : 'service_busy');
      }
    }
  }

  async retryLastVoiceTurn(): Promise<boolean> {
    if (authEnding() || hasActiveStrictSentinelAttempt()) return false;
    const errKind = voiceStore.getVoiceSessionSnapshot().lastError?.kind ?? this.lastErrorKind;
    const retryText = this.lastFailedUserText.trim();
    this.lastFailedUserText = '';
    this.dismissError();
    if (
      retryText &&
      (errKind === 'service_busy' || errKind === 'connection_interrupted')
    ) {
      await this.submitTextTurn(retryText);
      return true;
    }
    return this.startActiveVoiceTurn();
  }

  dismissError(): void {
    this.clearErrorRecoveryTimer();
    this.lastErrorKind = null;
    voiceStore.clearVoiceError();
    const snap = voiceStore.getVoiceSessionSnapshot();
    if (snap.activeToast?.kind === 'error') {
      voiceStore.clearActiveToast();
    }
    if (snap.entityState === 'error') {
      this.restorePostErrorStandby();
    }
  }

  setMuted(muted: boolean): void {
    const next = Boolean(muted);
    this.muted = next;
    voiceStore.setVoiceMuted(next);
    if (next) {
      if (this.audioSession) {
        this.audioSession.playback.hardCancel();
        if (typeof this.audioSession.enterDormantStandby === 'function') {
          this.audioSession.enterDormantStandby();
        }
        this.audioSession.detector.setMode('disabled');
      }
      voiceStore.setVoiceEntityState(this.handsFreeEnabled ? 'dormant' : 'disabled');
    } else if (this.handsFreeEnabled && this.audioSession) {
      this.audioSession.detector.setMode('dormant');
      voiceStore.setVoiceEntityState('dormant');
    }
  }

  interruptCurrentTurn(): void {
    if (!this.audioSession) return;
    const cancelled = this.audioSession.playback.hardCancel();
    if (!cancelled.wasGreeting) {
      void this.audioSession.voiceClient.cancelAndTruncateTurn({
        turnSeq: cancelled.turnSeq,
        playedMs: cancelled.playedMs,
        spokenText: cancelled.spokenTextSoFar,
      });
    }
    this.chatBridge?.onInterruptChatTurn?.();
    voiceStore.setVoiceEntityState('interrupted');

    if (!this.muted && !authEnding() && !hasActiveStrictSentinelAttempt()) {
      if (typeof this.audioSession.resumeActiveListening === 'function') {
        this.audioSession.resumeActiveListening();
      } else {
        this.audioSession.detector.setTtsPlaying(false);
        this.audioSession.detector.setMode('active-listening');
      }
      voiceStore.setVoiceEntityState('listening');
    } else {
      this.audioSession.detector.setTtsPlaying(false);
      voiceStore.setVoiceEntityState(this.handsFreeEnabled ? 'dormant' : 'disabled');
    }
  }

  enterSleep(opts?: { silent?: boolean }): void {
    this.clearTimers();
    this.lastErrorKind = null;
    this.pendingTurnUserText = '';
    voiceStore.clearVoiceError();
    if (!opts?.silent) {
      this.playEarcon('sleep');
    }
    if (this.audioSession) {
      const cancelled = this.audioSession.playback.hardCancel();
      if (!cancelled.wasGreeting && cancelled.playedMs > 0) {
        void this.audioSession.voiceClient.cancelAndTruncateTurn({
          turnSeq: cancelled.turnSeq,
          playedMs: cancelled.playedMs,
          spokenText: cancelled.spokenTextSoFar,
        });
      }
      if (this.handsFreeEnabled && !this.muted) {
        if (typeof this.audioSession.enterDormantStandby === 'function') {
          this.audioSession.enterDormantStandby();
        } else {
          this.audioSession.detector.setTtsPlaying(false);
          this.audioSession.detector.setMode('dormant');
        }
        if (!voiceStore.hasActivePendingConfirmation()) {
          this.audioSession.voiceClient.disconnectIdle?.();
        }
      } else {
        this.audioSession.stop();
      }
    }
    voiceStore.clearVoiceLiveCaption();
    voiceStore.setVoiceEntityState('sleeping');

    this.sleepResetTimer = setTimeout(() => {
      this.sleepResetTimer = null;
      if (authEnding() || hasActiveStrictSentinelAttempt()) return;
      voiceStore.setVoiceEntityState(this.handsFreeEnabled ? 'dormant' : 'disabled');
    }, 320);
  }

  async decideConfirmation(decision: 'confirm' | 'cancel'): Promise<void> {
    const pending = voiceStore.consumePendingConfirmation();
    if (!pending) return;

    const serverDecision: 'CONFIRM' | 'CANCEL' = decision === 'confirm' ? 'CONFIRM' : 'CANCEL';
    voiceStore.setVoiceEntityState('executing');

    if (pending.kind === 'server') {
      const session = this.audioSession;
      if (session?.voiceClient.isWsConnected) {
        session.voiceClient.sendToolConfirm(pending.token, serverDecision);
        this.playEarcon(decision === 'confirm' ? 'action_ok' : 'sleep');
        return;
      }

      try {
        await echoIntelligenceApi.decide(pending.token, serverDecision);
        this.playEarcon(decision === 'confirm' ? 'action_ok' : 'sleep');
        this.showToast({
          kind: 'action',
          title:
            decision === 'confirm'
              ? this.locale === 'vi'
                ? 'Đã xác nhận và áp dụng'
                : 'Confirmed and applied'
              : this.locale === 'vi'
                ? 'Đã hủy thao tác'
                : 'Action cancelled',
          ttlMs: 3600,
        });
      } catch {
        this.playEarcon('error');
        this.showToast({
          kind: 'error',
          title: this.locale === 'vi' ? 'Không thể xác nhận lúc này' : 'Could not apply confirmation',
          ttlMs: 4200,
        });
      } finally {
        voiceStore.setVoiceEntityState(this.handsFreeEnabled ? 'dormant' : 'disabled');
      }
      return;
    }

    // Client-side pending confirmation
    if (decision === 'cancel') {
      this.playEarcon('sleep');
      this.showToast({
        kind: 'action',
        title: this.locale === 'vi' ? 'Đã hủy thao tác' : 'Action cancelled',
        ttlMs: 3200,
      });
      voiceStore.setVoiceEntityState(this.handsFreeEnabled ? 'dormant' : 'disabled');
      return;
    }

    const host = getRegisteredEchoActionHost();
    const outcome = await dispatchEchoIntent(pending.intent, {
      host,
      confirmed: true,
    });
    this.playEarcon(outcome.status === 'done' ? 'action_ok' : 'error');
    this.showToast({
      kind: outcome.status === 'done' ? 'action' : 'error',
      title:
        (this.locale === 'vi' ? outcome.spokenMessage?.vi : outcome.spokenMessage?.en) ||
        outcome.detail,
      ttlMs: 3800,
    });
    voiceStore.setVoiceEntityState(this.handsFreeEnabled ? 'dormant' : 'disabled');
  }

  confirmPendingAction(): Promise<void> {
    return this.decideConfirmation('confirm');
  }

  cancelPendingAction(): Promise<void> {
    return this.decideConfirmation('cancel');
  }

  async undoLastUiAction(): Promise<boolean> {
    if (this.internalOpts.undoHandler) {
      const ok = await this.internalOpts.undoHandler();
      if (ok) this.playEarcon('action_ok');
      return ok;
    }

    // Delegate first to voiceSessionStore's reversible Undo stack
    const storeResult = await voiceStore.popAndRunUndoAction();
    if (storeResult.ok) {
      this.playEarcon('action_ok');
      const label = this.locale === 'vi' ? storeResult.labelVi : storeResult.labelEn;
      this.showToast({
        kind: 'action',
        title: label
          ? this.locale === 'vi'
            ? `Đã hoàn tác: ${label}`
            : `Undid: ${label}`
          : this.locale === 'vi'
            ? 'Đã hoàn tác thao tác vừa rồi'
            : 'Undid last action',
        ttlMs: 3200,
      });
      return true;
    }

    const localUndo = this.undoStack.pop();
    if (localUndo) {
      const ok = await localUndo();
      if (ok) {
        this.playEarcon('action_ok');
        this.showToast({
          kind: 'action',
          title: this.locale === 'vi' ? 'Đã hoàn tác thao tác vừa rồi' : 'Undid last action',
          ttlMs: 3200,
        });
      }
      return ok;
    }

    return false;
  }

  /**
   * 0 ms Synchronous Hard Teardown on Logout or Strict Sentinel Lockdown.
   */
  hardTeardown(): void {
    this.clearTimers();
    const prevUserId = this.userId;

    this.handsFreeEnabled = false;
    this.muted = false;
    this.exhausted = false;
    this.sessionId = null;
    this.lastUserTranscript = '';
    this.pendingTurnUserText = '';
    this.userTranscriptByTurn.clear();
    this.lastFailedUserText = '';
    this.lastErrorKind = null;
    this.lastAppendedTurnSeq = -1;
    this.activeSalienceTurnSeq = -1;
    this.turnRecordedCardSalience = false;
    this.pendingTurnCards = [];
    this.pendingTurnActions = [];
    this.lastSyncedSessionPrefs = null;
    this.handsFreeSessionEpoch = 0;
    this.greetingSpokenEpoch = 0;
    this.undoStack = [];

    if (prevUserId) {
      clearStoredGreetingEpoch(prevUserId);
    }
    this.userId = '';

    if (this.audioSession) {
      this.audioSession.stop();
      this.audioSession.dispose();
      this.audioSession = null;
    }

    syncStoreWsConnected(false);
    syncStoreActionToast(null);
    voiceStore.setVoiceStage(false);
    voiceStore.clearVoiceError();
    voiceStore.clearUndoStack();
    voiceStore.clearVoiceLiveCaption();
    voiceStore.clearPendingConfirmation();
    voiceStore.setVoiceEntityState('disabled');
  }

  // ---------------------------------------------------------------------------
  // Internal Audio Session Wiring & Plane-A Fast-Path Bridge
  // ---------------------------------------------------------------------------

  private ensureAudioSession(): EchoJarvisAudioSession {
    if (this.audioSession) return this.audioSession;

    if (this.internalOpts.sessionFactory) {
      this.audioSession = this.internalOpts.sessionFactory();
      return this.audioSession;
    }

    this.audioSession = new EchoJarvisAudioSession({
      voiceId: this.voiceId,
      locale: this.locale,
      sessionId: this.sessionId,
      handsFreeWake: this.handsFreeEnabled,
      callbacks: {
        onWake: () => {
          // Audio session already played 65 ms procedural earcon (ZERO spoken greeting on wake!)
          this.clearErrorRecoveryTimer();
          if (voiceStore.getVoiceSessionSnapshot().lastError === null) {
            this.lastErrorKind = null;
          }
          voiceStore.setVoiceEntityState('awakening');
        },
        onSingleBreathCommand: () => {
          this.clearErrorRecoveryTimer();
          if (voiceStore.getVoiceSessionSnapshot().lastError === null) {
            this.lastErrorKind = null;
          }
          voiceStore.setVoiceEntityState('listening');
        },
        onConnectionChange: (connected) => {
          syncStoreWsConnected(connected);
          if (authEnding() || hasActiveStrictSentinelAttempt()) return;
          const snap = voiceStore.getVoiceSessionSnapshot();
          if (!connected) {
            if (
              this.audioSession?.isRunning &&
              this.audioSession.isActiveConversation &&
              !this.muted &&
              !this.isSpeechOutputActive() &&
              (snap.entityState === 'listening' || snap.entityState === 'awakening')
            ) {
              voiceStore.setVoiceEntityState('reconnecting');
            }
          } else if (snap.entityState === 'reconnecting') {
            if (this.audioSession?.isRunning && this.audioSession.isActiveConversation && !this.muted) {
              voiceStore.setVoiceEntityState('listening');
            } else {
              voiceStore.setVoiceEntityState(this.handsFreeEnabled && !this.muted ? 'dormant' : 'disabled');
            }
          }
        },
        onAsrPartial: ({ text, probeOnly }) => {
          if (probeOnly) return;
          const clean = stripWakePhrasePrefix(text) || text;
          if (clean) {
            this.clearErrorRecoveryTimer();
            if (voiceStore.getVoiceSessionSnapshot().lastError === null) {
              voiceStore.clearVoiceError();
            }
            voiceStore.setVoiceLiveCaption({ userPartial: clean });
            if (!this.isSpeechOutputActive()) {
              voiceStore.setVoiceEntityState('understanding');
            }
          }
        },
        onAsrFinal: ({ text, turnSeq, rejectedReason }) => {
          if (rejectedReason || !text) {
            if (!this.isSpeechOutputActive()) {
              voiceStore.setVoiceEntityState('listening');
            }
            return;
          }
          const clean = stripWakePhrasePrefix(text);
          if (!clean) {
            // Bare wake phrase ("Hi Echo") with no command: stay quietly in listening!
            if (!this.isSpeechOutputActive()) {
              voiceStore.setVoiceEntityState('listening');
            }
            return;
          }
          this.clearErrorRecoveryTimer();
          this.lastErrorKind = null;
          voiceStore.clearVoiceError();
          this.lastUserTranscript = clean;
          this.pendingTurnUserText = clean;
          if (typeof turnSeq === 'number' && turnSeq > 0) {
            this.recordTurnTranscript(turnSeq, clean);
          }
          this.lastFailedUserText = '';
          this.pendingTurnCards = [];
          this.pendingTurnActions = [];
          this.turnRecordedCardSalience = false;
          voiceStore.setVoiceLiveCaption({ userPartial: clean });
          voiceStore.setVoiceEntityState('thinking');
        },
        onActionClientPlan: (plan) => {
          void this.handleServerClientPlan(plan);
        },
        onActionGuard: (guard) => {
          this.playEarcon('error');
          voiceStore.setVoiceLiveCaption({ echoSpoken: guard.spokenMessage });
          this.showToast({
            kind: 'guard',
            title: guard.spokenMessage,
            ttlMs: 4500,
          });
        },
        onToolConfirmed: (info) => {
          voiceStore.clearPendingConfirmation();
          this.playEarcon(info.status === 'APPLIED' ? 'action_ok' : 'sleep');
          this.audioSession?.setFollowupExtended(false);
          this.showToast({
            kind: 'action',
            title:
              info.status === 'APPLIED'
                ? this.locale === 'vi'
                  ? info.savedCards
                    ? `Đã lưu ${info.savedCards} thẻ từ mới`
                    : 'Đã xác nhận và áp dụng'
                  : info.savedCards
                    ? `Saved ${info.savedCards} new flashcards`
                    : 'Confirmed and applied'
                : this.locale === 'vi'
                  ? 'Đã hủy thao tác'
                  : 'Action cancelled',
            ttlMs: 4000,
          });
        },
        onFollowupTimeout: () => {
          voiceStore.clearVoiceLiveCaption();
          voiceStore.setVoiceEntityState(this.handsFreeEnabled ? 'dormant' : 'disabled');
        },
        onLlmDelta: (_delta, fullText) => {
          if (fullText) {
            voiceStore.setVoiceLiveCaption({ echoSpoken: fullText });
          }
        },
        onActionsAndCards: ({ actions, cards, turnSeq }) => {
          if (typeof turnSeq === 'number' && turnSeq !== this.activeSalienceTurnSeq) {
            this.activeSalienceTurnSeq = turnSeq;
            this.turnRecordedCardSalience = false;
          }
          if (Array.isArray(actions) && actions.length > 0) {
            this.pendingTurnActions = mergeRawActions(this.pendingTurnActions, actions);
          }
          if (Array.isArray(cards) && cards.length > 0) {
            this.pendingTurnCards = mergeRawCards(this.pendingTurnCards, cards);
          }
          this.handleServerActionsAndCards(actions, cards);
        },
        onEntityState: (state) => {
          if (state !== 'error') {
            this.clearErrorRecoveryTimer();
          }
          const resolved: EntityVisualState =
            state === 'disabled' && this.handsFreeEnabled && !hasActiveStrictSentinelAttempt() && !authEnding()
              ? 'dormant'
              : (state as EntityVisualState);
          voiceStore.setVoiceEntityState(resolved);
        },
        onTurnComplete: (fullText, turnSeq, route, srvSessionId) => {
          const userTurnText = this.userTranscriptByTurn.get(turnSeq) ?? this.lastUserTranscript;
          this.pendingTurnUserText = '';
          this.lastFailedUserText = '';
          voiceStore.setVoiceLiveCaption({
            userPartial: '',
            ...(fullText ? { echoSpoken: fullText } : {}),
          });
          if (this.isSpeechOutputActive() && voiceStore.getVoiceSessionSnapshot().entityState !== 'speaking') {
            voiceStore.setVoiceEntityState('speaking');
          }
          if (userTurnText && fullText) {
            this.appendTurnOnce(turnSeq, userTurnText, fullText, {
              persistToServer: route === 'HTTP_FALLBACK',
              sessionId: srvSessionId ?? this.sessionId,
            });
          }
          if (srvSessionId) {
            this.adoptServerSessionId(srvSessionId);
          }
          const endsWithQuestion = /\?\s*$/.test(fullText || '');
          this.audioSession?.setFollowupExtended(endsWithQuestion || voiceStore.hasActivePendingConfirmation());
        },
        onResponseCancelled: (turnSeq: number, reason?: string) => {
          if (reason === 'merged') {
            this.userTranscriptByTurn.delete(turnSeq);
            const activeTurnSeq = this.audioSession?.voiceClient?.currentTurnSeq ?? 0;
            if (activeTurnSeq > turnSeq) {
              voiceStore.setVoiceEntityState('listening');
            }
          }
        },
        onTurnTruncated: ({ turnSeq, spokenText, sessionId }) => {
          if (sessionId) {
            this.adoptServerSessionId(sessionId);
          }
          this.pendingTurnUserText = '';
          const resolvedSessionId = sessionId ?? this.sessionId;
          const userTurnText = this.userTranscriptByTurn.get(turnSeq) ?? this.lastUserTranscript;
          const heard = (spokenText || '').trim();
          if (this.chatBridge?.onTruncateTurn) {
            if (userTurnText) {
              this.chatBridge.onTruncateTurn(userTurnText, heard, {
                sessionId: resolvedSessionId,
                turnSeq,
              });
            }
            if (turnSeq > 0) {
              this.lastAppendedTurnSeq = Math.max(this.lastAppendedTurnSeq, turnSeq);
            }
            this.pendingTurnCards = [];
            this.pendingTurnActions = [];
            return;
          }
          if (userTurnText && heard) {
            this.appendTurnOnce(turnSeq, userTurnText, heard, {
              persistToServer: false,
              sessionId: resolvedSessionId,
            });
          }
        },
        onError: (code, detail, meta) => {
          this.handleTypedVoiceError(code, detail, meta);
        },
        onTryFastPathIntent: (transcript, lang) => {
          const clean = stripWakePhrasePrefix(transcript);
          if (!clean) return true;
          return this.tryExecuteLocalFastPath(clean, lang, false);
        },
        getPageContext: () => this.resolvePassivePageContext(),
        getTurnPageContext: (transcript) => {
          const curPath = typeof window !== 'undefined' ? window.location.pathname : '/dashboard';
          // On WS audio commit before ASR runs (`transcript === undefined`), include fresh on-demand
          // viewport context (backend filters via `EchoRouter.pageReferenced` and never persists it).
          // When `transcript` IS known (HTTP fallback or text turn), NEVER fall back to stale
          // `lastUserTranscript` — strictly check the current utterance or active selection (`10 §AB`)!
          if (transcript === undefined) {
            return this.resolveCurrentPageContext(curPath, true, '');
          }
          return this.resolveCurrentPageContext(curPath, false, transcript);
        },
        getConversationHistory: () => this.chatBridge?.getHistory?.() ?? [],
        getSalientResources: () => getSessionSalientResources(this.sessionId, this.userId),
        getSessionFlags: () => ({
          pathname: typeof window !== 'undefined' ? window.location.pathname : '/dashboard',
          hasPendingConfirmation: voiceStore.hasActivePendingConfirmation(),
          hasActiveStrictSentinel: hasActiveStrictSentinelAttempt(),
        }),
      },
    });

    this.lastSyncedSessionPrefs = {
      session: this.audioSession,
      voiceId: this.voiceId,
      locale: this.locale,
      sessionId: this.sessionId,
      handsFreeWake: this.handsFreeEnabled,
    };

    return this.audioSession;
  }

  private appendTurnOnce(
    turnSeq: number,
    userText: string,
    assistantText: string,
    opts?: { persistToServer?: boolean; sessionId?: number | null },
  ): void {
    if (!userText || !assistantText) return;
    if (turnSeq > 0 && this.lastAppendedTurnSeq >= turnSeq) return;
    if (turnSeq > 0) {
      this.lastAppendedTurnSeq = Math.max(this.lastAppendedTurnSeq, turnSeq);
    }
    const cards = this.pendingTurnCards.length > 0 ? [...this.pendingTurnCards] : undefined;
    const actions = this.pendingTurnActions.length > 0 ? [...this.pendingTurnActions] : undefined;
    this.pendingTurnCards = [];
    this.pendingTurnActions = [];
    this.chatBridge?.onAppendTurn?.(userText, assistantText, cards, actions, opts);
  }

  private handleTypedVoiceError(code?: string, detail?: string, meta?: EchoVoiceErrorMeta): void {
    if (authEnding() || hasActiveStrictSentinelAttempt()) return;

    const kind = voiceStore.classifyEchoVoiceError(code, detail, {
      status: meta?.status,
      limitKind: meta?.limitKind,
    });
    const formatted = voiceStore.formatEchoVoiceError(kind, this.locale, {
      code,
      limitKind: meta?.limitKind,
      customMessageVi: meta?.messageVi ?? (this.locale === 'vi' ? detail : undefined),
      customMessageEn: meta?.messageEn ?? (this.locale === 'en' ? detail : undefined),
    });

    this.lastErrorKind = kind;
    if (kind === 'quota_limit' && meta?.limitKind !== 'rate') {
      this.exhausted = true;
    }
    const turnScopedText =
      typeof meta?.turnSeq === 'number' && meta.turnSeq > 0
        ? this.userTranscriptByTurn.get(meta.turnSeq)
        : undefined;
    const failedCandidate = turnScopedText ?? this.pendingTurnUserText;
    if (kind === 'service_busy' || kind === 'connection_interrupted') {
      if (failedCandidate) {
        this.lastFailedUserText = failedCandidate;
      }
    } else {
      this.lastFailedUserText = '';
    }

    this.playEarcon('error');
    voiceStore.setVoiceError({
      kind,
      title: formatted.title,
      subtitle: formatted.subtitle,
      canRetry: formatted.canRetry,
    });
    this.showToast({
      kind: 'error',
      title: formatted.title,
      subtitle: formatted.subtitle,
      canRetry: formatted.canRetry,
      errorKind: kind,
      ttlMs: 4600,
    });
    voiceStore.setVoiceEntityState('error');

    // Non-destructive recovery: never leave the session permanently poisoned in `'error'`!
    this.clearErrorRecoveryTimer();
    this.errorRecoveryTimer = setTimeout(() => {
      this.errorRecoveryTimer = null;
      if (authEnding() || hasActiveStrictSentinelAttempt()) return;
      if (voiceStore.getVoiceSessionSnapshot().entityState === 'error') {
        this.restorePostErrorStandby(kind);
      }
    }, 1500);
  }

  private restorePostErrorStandby(kind?: voiceStore.EchoVoiceErrorKind): void {
    const canResumeActive =
      Boolean(this.audioSession?.isRunning) &&
      Boolean(this.audioSession?.isActiveConversation) &&
      !this.muted &&
      kind !== 'mic_unavailable' &&
      kind !== 'quota_limit';

    if (canResumeActive && this.audioSession) {
      if (typeof this.audioSession.resumeActiveListening === 'function') {
        this.audioSession.resumeActiveListening();
      } else {
        this.audioSession.detector.setTtsPlaying(false);
        this.audioSession.detector.setMode('active-listening');
      }
      voiceStore.setVoiceEntityState('listening');
      return;
    }

    if (this.handsFreeEnabled && kind !== 'mic_unavailable') {
      if (this.audioSession && !this.muted) {
        if (typeof this.audioSession.enterDormantStandby === 'function') {
          this.audioSession.enterDormantStandby();
        } else {
          this.audioSession.detector.setMode('dormant');
        }
      }
      voiceStore.setVoiceEntityState('dormant');
      return;
    }

    voiceStore.setVoiceEntityState('disabled');
  }

  private resolvePassivePageContext(): Record<string, unknown> | null {
    if (this.workspaceContextProvider) {
      return sanitizePassiveContext(this.workspaceContextProvider({ includeOnDemandBook: false }));
    }
    return sanitizePassiveContext(getEchoWorkspaceContextSnapshot({ includeOnDemandBook: false }));
  }

  private resolveCurrentPageContext(
    pathname?: string,
    forceOnDemand = false,
    utterance = '',
  ): Record<string, unknown> | null {
    const activeSelection = typeof window !== 'undefined' ? cleanSelection(recentSelection()) : undefined;
    const wantsBook =
      forceOnDemand ||
      Boolean(activeSelection) ||
      BOOK_EXCERPT_CUE_RE.test(utterance) ||
      utteranceReferencesBookOrPassage(utterance);
    if (this.workspaceContextProvider) {
      const snap = this.workspaceContextProvider({ includeOnDemandBook: wantsBook });
      if (!wantsBook) return sanitizePassiveContext(snap);
      if (snap && activeSelection && !snap.selection) {
        return { ...snap, selection: activeSelection };
      }
      return snap;
    }
    const snap = getEchoWorkspaceContextSnapshot({
      ...(pathname ? { pathname } : {}),
      ...(activeSelection ? { selection: activeSelection } : {}),
      includeOnDemandBook: wantsBook,
    }) as Record<string, unknown> | null;
    return wantsBook ? snap : sanitizePassiveContext(snap);
  }

  private resolveTruthfulDagMessage(
    report: DagExecutionReport,
    lang: 'en' | 'vi',
    defaultDoneAck: string,
  ): string {
    if (report.status === 'confirm_required') {
      const pending = voiceStore.getVoiceSessionSnapshot().pendingConfirmation;
      if (pending) {
        return lang === 'vi' ? pending.summaryVi : pending.summaryEn;
      }
      return lang === 'vi'
        ? 'Bạn đang làm dở bài. Bạn có chắc muốn rời trang này không?'
        : 'You have active work in progress. Confirm before leaving this page?';
    }
    if (report.status !== 'done') {
      const failedStep = report.steps.find((s) => s.outcome.status !== 'done');
      const stepMsg =
        lang === 'vi' ? failedStep?.outcome.spokenMessage?.vi : failedStep?.outcome.spokenMessage?.en;
      if (stepMsg) return stepMsg;
      return lang === 'vi'
        ? 'Mình chưa mở được trang đó lúc này.'
        : 'Could not complete that action right now.';
    }
    const lastSpoken = [...report.steps]
      .reverse()
      .find((s) => Boolean(s.outcome.spokenMessage))?.outcome.spokenMessage;
    const stepAck = lang === 'vi' ? lastSpoken?.vi : lastSpoken?.en;
    return stepAck || defaultDoneAck || (lang === 'vi' ? 'Đã thực hiện xong.' : 'Done.');
  }

  private async tryExecuteLocalFastPath(
    transcript: string,
    lang: 'en' | 'vi',
    isTypedInput: boolean,
  ): Promise<boolean> {
    const pathname = typeof window !== 'undefined' ? window.location.pathname : '/';
    const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const salientResources = getSessionSalientResources(this.sessionId, this.userId);
    const outcome = compileEchoFastPath(transcript, {
      pathname,
      searchParams,
      hasActiveStrictSentinel: hasActiveStrictSentinelAttempt(),
      hasPendingConfirmation: voiceStore.hasActivePendingConfirmation(),
      salientResources,
      sessionId: this.sessionId,
    });

    if (outcome.guard) {
      this.playEarcon('error');
      const msg =
        (lang === 'vi' ? outcome.guard.spokenMessageVi : outcome.guard.spokenMessageEn) ||
        (lang === 'vi' ? outcome.guard.prompt?.vi : outcome.guard.prompt?.en) ||
        outcome.guard.reason ||
        (lang === 'vi' ? 'Thao tác này không được phép.' : 'This action is not permitted.');
      voiceStore.setVoiceLiveCaption({ echoSpoken: msg });
      this.showToast({
        kind: 'guard',
        title: msg,
        ttlMs: 4500,
      });
      this.chatBridge?.onAppendTurn?.(transcript, msg, undefined, undefined, { persistToServer: true });
      voiceStore.setVoiceEntityState(this.handsFreeEnabled ? 'dormant' : 'disabled');
      return true;
    }

    if (!outcome.fastPath) {
      return false;
    }

    const host = getRegisteredEchoActionHost();
    const report = await executeIntentDag(outcome.fastPath.intents, {
      host,
      hasActiveStrictSentinel: hasActiveStrictSentinelAttempt(),
    });

    const truthfulMsg = this.resolveTruthfulDagMessage(report, lang, outcome.fastPath.spokenAck);

    if (report.status === 'confirm_required') {
      const pending = voiceStore.getVoiceSessionSnapshot().pendingConfirmation;
      this.playEarcon('confirm');
      voiceStore.setVoiceLiveCaption({ echoSpoken: truthfulMsg });
      this.showToast({
        kind: 'confirm',
        title: truthfulMsg,
        confirmToken: pending?.kind === 'server' ? pending.token : pending?.clientToken,
        confirmSource: pending?.kind,
        ttlMs: 12000,
      });
      this.chatBridge?.onAppendTurn?.(transcript, truthfulMsg, undefined, undefined, {
        persistToServer: true,
      });
      return true;
    }

    const ok = report.status === 'done';
    this.playEarcon(ok ? 'action_ok' : 'error');
    voiceStore.setVoiceLiveCaption({ echoSpoken: truthfulMsg });
    this.showToast({
      kind: ok ? 'action' : 'error',
      title: truthfulMsg,
      canUndo: voiceStore.getVoiceSessionSnapshot().canUndoLastAction || this.undoStack.length > 0,
      ttlMs: 4000,
    });
    this.chatBridge?.onAppendTurn?.(transcript, truthfulMsg, undefined, undefined, {
      persistToServer: true,
    });
    if (isTypedInput) {
      if (!this.isSpeechOutputActive()) {
        voiceStore.setVoiceEntityState(this.handsFreeEnabled ? 'dormant' : 'disabled');
      }
    } else if (this.audioSession?.isRunning && this.audioSession.isActiveConversation && !this.muted) {
      if (!this.isSpeechOutputActive()) {
        this.audioSession.resumeActiveListening?.();
        voiceStore.setVoiceEntityState('listening');
      }
    } else if (!this.isSpeechOutputActive()) {
      voiceStore.setVoiceEntityState(this.handsFreeEnabled ? 'dormant' : 'disabled');
    }
    return true;
  }

  private async handleServerClientPlan(plan: ActionClientPlanEvent): Promise<void> {
    if (plan.sessionId) {
      this.adoptServerSessionId(plan.sessionId);
    }
    if (!Array.isArray(plan.intents) || plan.intents.length === 0) return;

    voiceStore.setVoiceEntityState('executing');
    const host = getRegisteredEchoActionHost();
    const report = await executeIntentDag(plan.intents as EchoClientIntent[], {
      host,
      hasActiveStrictSentinel: hasActiveStrictSentinelAttempt(),
    });

    if (
      plan.escalateOnEmpty &&
      (report.status === 'failed' ||
        report.steps.some((s) => s.outcome.status === 'failed' || /empty|no book/i.test(s.outcome.detail)))
    ) {
      // Escalate cleanly to Plane-B LLM (e.g. local MyBooks shelf is empty -> search reading lessons)
      const curPath = typeof window !== 'undefined' ? window.location.pathname : '/dashboard';
      this.audioSession?.voiceClient.sendTurnEscalate({
        turnSeq: plan.turnSeq,
        reason: 'mybooks_empty',
        text: this.lastUserTranscript || plan.spokenAck,
        pageContext: this.resolveCurrentPageContext(curPath, true, this.lastUserTranscript || ''),
      });
      voiceStore.setVoiceEntityState('thinking');
      return;
    }

    const truthfulMsg = this.resolveTruthfulDagMessage(report, plan.lang, plan.spokenAck);
    const ackStatus =
      report.status === 'confirm_required' ? 'awaiting_confirmation' : report.status;

    // Immediately report verified execution status + truthful spokenMessage over WS (`action.ack`)!
    this.audioSession?.voiceClient.sendActionAck?.(plan.turnSeq, ackStatus, truthfulMsg);

    if (report.status === 'confirm_required') {
      const pending = voiceStore.getVoiceSessionSnapshot().pendingConfirmation;
      this.playEarcon('confirm');
      this.audioSession?.setFollowupExtended(true);
      voiceStore.setVoiceLiveCaption({ echoSpoken: truthfulMsg });
      this.showToast({
        kind: 'confirm',
        title: truthfulMsg,
        confirmToken: pending?.kind === 'server' ? pending.token : pending?.clientToken,
        confirmSource: pending?.kind,
        ttlMs: 14000,
      });
      if (this.lastUserTranscript) {
        this.appendTurnOnce(plan.turnSeq, this.lastUserTranscript, truthfulMsg, {
          persistToServer: false,
          sessionId: plan.sessionId ?? this.sessionId,
        });
      }
      return;
    }

    const ok = report.status === 'done';
    if (plan.playEarcon && plan.playEarcon !== 'none') {
      this.playEarcon(ok ? plan.playEarcon : 'error');
    } else if (!ok) {
      this.playEarcon('error');
    }

    if (truthfulMsg) {
      voiceStore.setVoiceLiveCaption({ echoSpoken: truthfulMsg });
    }
    this.showToast({
      kind: ok ? 'action' : 'error',
      title: truthfulMsg || (plan.lang === 'vi' ? 'Đã thực hiện xong' : 'Done'),
      canUndo: voiceStore.getVoiceSessionSnapshot().canUndoLastAction || this.undoStack.length > 0,
      ttlMs: 4200,
    });
    if (this.lastUserTranscript && truthfulMsg) {
      this.appendTurnOnce(plan.turnSeq, this.lastUserTranscript, truthfulMsg, {
        persistToServer: false,
        sessionId: plan.sessionId ?? this.sessionId,
      });
    }
  }

  private handleServerActionsAndCards(actions?: unknown[], cards?: unknown[]): void {
    const host = getRegisteredEchoActionHost();

    const extractedFromCards = extractSalientResources(
      Array.isArray(cards) ? (cards as never[]) : null,
      null,
    );
    if (extractedFromCards.length > 0) {
      this.turnRecordedCardSalience = true;
      setSessionSalientResources(extractedFromCards, this.sessionId, this.userId);
    } else if (
      !this.turnRecordedCardSalience &&
      (cards === undefined || (Array.isArray(cards) && cards.length === 0)) &&
      Array.isArray(actions) &&
      actions.length > 0
    ) {
      // Only fall back to action salience when no resource-card salience was recorded in this turn!
      const extractedFromActions = extractSalientResources(null, actions as never[]);
      if (extractedFromActions.length > 0) {
        setSessionSalientResources(extractedFromActions, this.sessionId, this.userId);
      }
    }

    if (Array.isArray(actions)) {
      const intentsToExecute: EchoClientIntent[] = [];
      for (const raw of actions) {
        if (!raw || typeof raw !== 'object') continue;
        const act = raw as Record<string, unknown>;
        if (act.type === 'navigate') {
          // CaMeL + Open-Redirect defense: navigate ONLY when `auto === true` AND `safeEchoJarvisHref` passes!
          if (act.auto !== true || typeof act.href !== 'string') continue;
          if (!act.href.startsWith('/') || act.href.startsWith('//') || act.href.startsWith('/\\')) {
            continue;
          }
          const safeHref = safeEchoJarvisHref(act.href);
          if (!safeHref) continue;
          const label = typeof act.label === 'string' && act.label.trim() ? act.label.trim() : undefined;
          intentsToExecute.push({ kind: 'navigate', href: safeHref, ...(label ? { label } : {}) });
        } else if (
          act.type === 'client_intent' &&
          act.auto !== false &&
          act.intent &&
          typeof act.intent === 'object'
        ) {
          intentsToExecute.push(act.intent as EchoClientIntent);
        }
      }
      if (intentsToExecute.length > 0) {
        void executeIntentDag(intentsToExecute, { host });
      }
    }

    if (Array.isArray(cards) && cards.length > 0) {
      for (const raw of cards) {
        if (!raw || typeof raw !== 'object') continue;
        const card = raw as Record<string, unknown>;
        const cardType = String(card.type ?? card.kind ?? '');
        if (cardType === 'confirm' && typeof card.token === 'string') {
          const title = String(card.title ?? 'Confirm action');
          const subtitle =
            typeof card.note === 'string'
              ? card.note
              : typeof card.footer === 'string'
                ? card.footer
                : undefined;
          const confirmRawItems = Array.isArray(card.items)
            ? card.items
            : Array.isArray(card.rows)
              ? card.rows
              : null;
          const confirmItems = confirmRawItems
            ? (confirmRawItems as Array<Record<string, unknown>>).slice(0, 6).map((r) => ({
                title: String(r.label ?? r.title ?? ''),
                subtitle: typeof r.detail === 'string' ? r.detail : typeof r.subtitle === 'string' ? r.subtitle : undefined,
                meta: typeof r.meta === 'string' ? r.meta : undefined,
              }))
            : undefined;
          voiceStore.setPendingServerConfirmation({
            token: card.token,
            summaryEn: title,
            summaryVi: title,
          });
          this.playEarcon('confirm');
          this.audioSession?.setFollowupExtended(true);
          this.showToast({
            kind: 'confirm',
            title,
            subtitle,
            items: confirmItems,
            confirmToken: card.token,
            confirmSource: 'server',
            ttlMs: 14000,
          });
          return;
        }
      }

      const first = cards[0] as Record<string, unknown>;
      const firstType = String(first.type ?? first.kind ?? '');
      const rawItems = Array.isArray(first.items)
        ? first.items
        : Array.isArray(first.rows)
          ? first.rows
          : null;
      const rows = rawItems
        ? (rawItems as Array<Record<string, unknown>>).slice(0, 4).map((r) => {
            const safeHref =
              typeof r.href === 'string' &&
              r.href.startsWith('/') &&
              !r.href.startsWith('//') &&
              !r.href.startsWith('/\\')
                ? r.href
                : undefined;
            return {
              title: String(r.label ?? r.title ?? ''),
              subtitle: typeof r.detail === 'string' ? r.detail : typeof r.subtitle === 'string' ? r.subtitle : undefined,
              meta: typeof r.meta === 'string' ? r.meta : undefined,
              href: safeHref,
            };
          })
        : undefined;
      this.showToast({
        kind: firstType === 'stats' ? 'stats' : 'resources',
        title: String(first.title ?? 'Echo'),
        subtitle:
          typeof first.note === 'string'
            ? first.note
            : typeof first.footer === 'string'
              ? first.footer
              : undefined,
        items: rows,
        ttlMs: 9000,
      });
    }
  }

  private showToast(input: Omit<EchoActionToastPayload, 'id' | 'expiresAt'> & { ttlMs?: number }): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    syncStoreActionToast(input);
  }

  private clearErrorRecoveryTimer(): void {
    if (this.errorRecoveryTimer) {
      clearTimeout(this.errorRecoveryTimer);
      this.errorRecoveryTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearErrorRecoveryTimer();
    if (this.sleepResetTimer) {
      clearTimeout(this.sleepResetTimer);
      this.sleepResetTimer = null;
    }
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
  }
}

let singletonRuntime: EchoJarvisRuntime | null = null;

/**
 * Returns the module-scoped singleton `EchoJarvisRuntimeApi`.
 * Never tied to React component mounts; persists seamlessly across routes and UI mode switches.
 */
export function getEchoJarvisRuntime(): EchoJarvisRuntimeApi {
  if (!singletonRuntime) {
    singletonRuntime = new EchoJarvisRuntime({}, true);
  }
  return singletonRuntime;
}

/**
 * Internal accessor for runtime diagnostics and audio session inspection (used by audio/runtime tests).
 */
export function getEchoJarvisRuntimeInstance(): EchoJarvisRuntime {
  if (!singletonRuntime) {
    singletonRuntime = new EchoJarvisRuntime({}, true);
  }
  return singletonRuntime;
}
