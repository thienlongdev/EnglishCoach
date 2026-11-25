/**
 * Route-persistent external session store for Echo JARVIS (`useSyncExternalStore` compatible).
 *
 * Holds active voice state, presentation mode (`ambient | chat | immersive`),
 * all 12 `EchoEntityState` values, hands-free session/greeting epochs (strictly <= 1 spoken
 * greeting per enabled Hands-Free session), opt-in closed captions (default `false`),
 * over-BookReader z-index elevation state, WebSocket connectivity, ephemeral action toasts,
 * live streaming captions, single-use pending confirmations (10-minute TTL), reversible Undo
 * stack, route history stack, recent action audit log, per-user opt-in hands-free wake
 * preference (`ec_jarvis_handsfree:u<id>`), module-mic yield flag (`ec:module-mic`),
 * and reactive strict Sentinel lockdown mirror.
 *
 * Automatically wipes all user-scoped state on logout via `registerUserScopedCleanup`
 * and `subscribeAuthLifecycle` (0 ms teardown).
 */

import { registerUserScopedCleanup } from '@/lib/auth-cache-cleanup';
import { authEnding, subscribeAuthLifecycle } from '@/lib/auth-lifecycle';
import { hasActiveStrictSentinelAttempt, subscribeStrictSentinel } from '@/lib/sentinel/client';
import {
  ECHO_ENTITY_STATES,
  type EchoClientIntent,
  type EchoEntityState,
  type EchoPresentationMode,
} from './actionSchema';

export type { EchoPresentationMode };
export type EchoVoiceUiMode = EchoPresentationMode;

export interface EchoLiveCaption {
  readonly userPartial: string;
  readonly echoSpoken: string;
  readonly updatedAt: number;
}

export interface EchoActionToastItem {
  readonly title: string;
  readonly subtitle?: string;
  readonly meta?: string;
  readonly href?: string;
}

export interface EchoActionToast {
  readonly id: string;
  readonly kind: 'action' | 'resources' | 'stats' | 'confirm' | 'guard' | 'error';
  readonly title: string;
  readonly subtitle?: string;
  readonly items?: readonly EchoActionToastItem[];
  readonly confirmToken?: string;
  readonly confirmSource?: 'client' | 'server';
  readonly canUndo?: boolean;
  readonly canRetry?: boolean;
  readonly errorKind?: EchoVoiceErrorKind;
  readonly expiresAt: number;
}

export type EchoVoiceErrorKind =
  | 'mic_unavailable'
  | 'speech_unrecognized'
  | 'connection_interrupted'
  | 'service_busy'
  | 'quota_limit';

export interface EchoVoiceErrorInputMeta {
  readonly turnSeq?: number;
  readonly status?: number;
  readonly limitKind?: string;
  readonly resetsAt?: string;
}

export interface EchoVoiceErrorState {
  readonly id: string;
  readonly kind: EchoVoiceErrorKind;
  readonly title: string;
  readonly subtitle?: string;
  readonly canRetry: boolean;
  readonly occurredAt: number;
}

export type PendingVoiceConfirmation =
  | {
      kind: 'server';
      token: string;
      summaryEn: string;
      summaryVi: string;
      createdAt: number;
      expiresAt: number;
    }
  | {
      kind: 'client';
      clientToken: string;
      intent: EchoClientIntent;
      summaryEn: string;
      summaryVi: string;
      createdAt: number;
      expiresAt: number;
    };

export interface EchoExecutedActionRecord {
  readonly id: string;
  readonly kind: EchoClientIntent['kind'];
  readonly status: 'done' | 'confirm_required' | 'denied' | 'unsupported' | 'failed';
  readonly detail: string;
  readonly timestamp: number;
}

export type ExecutedVoiceAction = EchoExecutedActionRecord;

export const ECHO_ACTION_LIFECYCLE_STATES = [
  'proposed',
  'validated',
  'authorized',
  'awaiting_confirmation',
  'dispatched',
  'executing',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type EchoActionLifecycleState = (typeof ECHO_ACTION_LIFECYCLE_STATES)[number];

export interface EchoActionLifecycleRecord {
  readonly state: EchoActionLifecycleState;
  readonly kind?: string;
  readonly detail?: string;
  readonly updatedAt: number;
}

export interface EchoUndoEntry {
  readonly id: string;
  readonly labelEn: string;
  readonly labelVi: string;
  readonly undo: () => void | Promise<void>;
  readonly createdAt: number;
}

export interface EchoVoiceSessionSnapshot {
  readonly userId: string;
  readonly activeConversationId: number | null;
  readonly uiMode: EchoPresentationMode;
  /**
   * The learner chose the voice conversation inside the Echo panel. Set ONLY by an explicit voice entry (voice button,
   * "Nói với Echo", the companion's microphone) and cleared ONLY by an explicit exit (back to typing, end, opening the
   * chat, turning voice off) or teardown. Turn states (listening, error, follow-up rest) never change it: a finished or
   * failed turn keeps the voice presentation (incident 2026-11-25).
   */
  readonly voiceStage: boolean;
  readonly entityState: EchoEntityState;
  readonly handsFreeEnabled: boolean;
  readonly handsFreeSessionEpoch: number;
  readonly greetingSpokenEpoch: number;
  readonly muted: boolean;
  readonly captionsEnabled: boolean;
  readonly strictSentinelLocked: boolean;
  readonly moduleMicActive: boolean;
  readonly moduleMicOwner: string | null;
  readonly overBookReader: boolean;
  readonly wsConnected: boolean;
  readonly liveCaption: EchoLiveCaption;
  readonly activeToast: EchoActionToast | null;
  readonly lastError: EchoVoiceErrorState | null;
  readonly pendingConfirmation: PendingVoiceConfirmation | null;
  readonly lastActionLifecycle: EchoActionLifecycleRecord | null;
  readonly canUndoLastAction: boolean;
  readonly routeStack: readonly string[];
  readonly recentActions: readonly EchoExecutedActionRecord[];
}

export const HANDS_FREE_STORAGE_PREFIX = 'ec_jarvis_handsfree:u';
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_TOAST_TTL_MS = 6_500;
const MAX_ROUTE_STACK = 24;
const MAX_RECENT_ACTIONS = 20;
const MAX_UNDO_STACK = 12;

const ENTITY_STATE_SET = new Set<string>(ECHO_ENTITY_STATES);

const RAW_MACHINE_ERROR_CODE_RE =
  /^(?:failed|error|ws[-_]?error|stream|service|service[-_]?busy|server[-_]?busy|provider[-_]?unreachable|unavailable|rate|rate[-_]?limited|stt[-_]?unavailable|speech[-_]?unrecognized|no[-_]?speech|unknown[-_]?event|invalid[-_]?json|connection|connection[-_]?interrupted|timeout|turn[-_]?timeout|oversized|bad[-_]?gateway|unauthorized|mic[-_]?unavailable|audio[-_]?capture|not[-_]?allowed|device[-_]?busy|daily|quota[-_]?limit|quota[-_]?exceeded|length)$/i;

export function classifyEchoVoiceError(
  code?: string | null,
  detail?: string | null,
  meta?: EchoVoiceErrorInputMeta | null,
): EchoVoiceErrorKind {
  const normCode = String(code ?? '').trim().toLowerCase();
  const normDetail = String(detail ?? '').trim().toLowerCase();
  const limitKind = String(meta?.limitKind ?? '').trim().toUpperCase();
  const status = typeof meta?.status === 'number' ? meta.status : 0;

  if (
    normCode === 'daily' ||
    normCode === 'quota_limit' ||
    normCode === 'quota-limit' ||
    normCode === 'quota_exceeded' ||
    normCode === 'quota-exceeded' ||
    normDetail === 'daily' ||
    limitKind === 'DAILY' ||
    limitKind.startsWith('COACH_')
  ) {
    return 'quota_limit';
  }

  if (
    normCode === 'mic_unavailable' ||
    normCode === 'mic-denied' ||
    normCode === 'mic_denied' ||
    normCode === 'not-allowed' ||
    normCode === 'notallowederror' ||
    normCode === 'notfounderror' ||
    normCode === 'notreadableerror' ||
    normCode === 'overconstrainederror' ||
    normCode === 'securityerror' ||
    normCode === 'audio-capture' ||
    normCode === 'device-busy' ||
    normDetail.includes('notallowederror') ||
    normDetail.includes('microphone')
  ) {
    return 'mic_unavailable';
  }

  if (
    normCode === 'no-speech' ||
    normCode === 'speech_unrecognized' ||
    normCode === 'empty_transcript' ||
    normCode === 'too_short' ||
    normCode === 'rms_silence_gate' ||
    normCode === 'rms_silence' ||
    normCode === 'repetition_loop' ||
    normCode === 'hallucination'
  ) {
    return 'speech_unrecognized';
  }

  if (
    normCode === 'network' ||
    normCode === 'connection' ||
    normCode === 'connection_interrupted' ||
    normCode === 'ws-closed' ||
    normCode === 'ws_closed' ||
    normCode === 'unauthorized' ||
    normCode === 'session_expired' ||
    status === 401 ||
    status === 403
  ) {
    return 'connection_interrupted';
  }

  return 'service_busy';
}

export function formatEchoVoiceError(
  kind: EchoVoiceErrorKind,
  locale: 'en' | 'vi' = 'vi',
  opts?: {
    code?: string | null;
    limitKind?: string | null;
    customMessageVi?: string | null;
    customMessageEn?: string | null;
  },
): { title: string; subtitle?: string; canRetry: boolean } {
  const vi = locale === 'vi';
  const custom = vi ? opts?.customMessageVi : opts?.customMessageEn;
  if (custom && custom.trim() && !RAW_MACHINE_ERROR_CODE_RE.test(custom.trim())) {
    return {
      title: custom.trim().slice(0, 140),
      canRetry: kind !== 'quota_limit',
    };
  }

  const normCode = String(opts?.code ?? '').trim().toLowerCase();
  if (normCode === 'length') {
    return {
      title: vi
        ? 'Câu trả lời khá dài, bạn thử hỏi từng ý nhỏ nhé'
        : 'That answer was too long, try asking one part at a time',
      canRetry: kind !== 'quota_limit',
    };
  }

  switch (kind) {
    case 'mic_unavailable':
      return {
        title: vi
          ? 'Chưa mở được micro. Hãy kiểm tra quyền micro của trình duyệt'
          : 'Microphone unavailable. Please check browser microphone access',
        canRetry: true,
      };
    case 'speech_unrecognized':
      return {
        title: vi
          ? 'Mình chưa nghe rõ, bạn nói lại giúp mình nhé'
          : 'I did not catch that clearly, please say it again',
        canRetry: true,
      };
    case 'quota_limit': {
      const limitKind = String(opts?.limitKind ?? '').toUpperCase();
      if (limitKind === 'COACH_PREMIUM_MONTHLY') {
        return {
          title: vi
            ? 'Bạn đã dùng hết hạn mức Echo Premium trong tháng này'
            : 'Monthly Echo Premium limit reached',
          canRetry: false,
        };
      }
      return {
        title: vi
          ? 'Bạn đã dùng hết lượt trò chuyện Echo hôm nay'
          : 'Daily Echo conversation limit reached',
        canRetry: false,
      };
    }
    case 'connection_interrupted':
      return {
        title: vi
          ? 'Kết nối giọng nói tạm gián đoạn, bạn thử lại nhé'
          : 'Voice connection interrupted, please try again',
        canRetry: true,
      };
    case 'service_busy':
    default:
      return {
        title: vi
          ? 'Echo đang bận đôi chút, bạn thử hỏi lại ngay nhé'
          : 'Echo is briefly busy, please try asking again',
        canRetry: true,
      };
  }
}

const EMPTY_CAPTION: EchoLiveCaption = Object.freeze({
  userPartial: '',
  echoSpoken: '',
  updatedAt: 0,
});

const SERVER_SNAPSHOT: EchoVoiceSessionSnapshot = Object.freeze({
  userId: '',
  activeConversationId: null,
  uiMode: 'ambient',
  voiceStage: false,
  entityState: 'disabled',
  handsFreeEnabled: false,
  handsFreeSessionEpoch: 0,
  greetingSpokenEpoch: 0,
  muted: false,
  captionsEnabled: false,
  strictSentinelLocked: false,
  moduleMicActive: false,
  moduleMicOwner: null,
  overBookReader: false,
  wsConnected: false,
  liveCaption: EMPTY_CAPTION,
  activeToast: null,
  lastError: null,
  pendingConfirmation: null,
  lastActionLifecycle: null,
  canUndoLastAction: false,
  routeStack: Object.freeze([]),
  recentActions: Object.freeze([]),
});

let snapshot: EchoVoiceSessionSnapshot = SERVER_SNAPSHOT;
const listeners = new Set<() => void>();
const undoStack: EchoUndoEntry[] = [];
let clientTokenSeq = 0;
let toastSeq = 0;
let undoSeq = 0;
let toastExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let windowListenersAttached = false;

function cleanUserId(raw: string | number | null | undefined): string {
  return String(raw ?? '').replace(/[^\w-]/g, '');
}

export function handsFreeStorageKey(userId: string | number | null | undefined): string {
  const id = cleanUserId(userId);
  return id ? `${HANDS_FREE_STORAGE_PREFIX}${id}` : '';
}

function readHandsFreePreference(userId: string): boolean {
  if (!userId || typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(handsFreeStorageKey(userId)) === '1';
  } catch {
    return false;
  }
}

function writeHandsFreePreference(userId: string, enabled: boolean): void {
  if (!userId || typeof window === 'undefined') return;
  const key = handsFreeStorageKey(userId);
  if (!key) return;
  try {
    if (enabled) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable: keep preference in session memory.
  }
}

function normalizePresentationMode(raw: string): EchoPresentationMode | null {
  if (raw === 'ambient' || raw === 'compact') return 'ambient';
  if (raw === 'chat' || raw === 'expanded') return 'chat';
  if (raw === 'immersive') return 'immersive';
  return null;
}

function clearToastTimer(): void {
  if (toastExpiryTimer !== null) {
    clearTimeout(toastExpiryTimer);
    toastExpiryTimer = null;
  }
}

function emit(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Isolate subscriber errors.
    }
  });
}

function updateSnapshot(patch: Partial<EchoVoiceSessionSnapshot>): void {
  const next: EchoVoiceSessionSnapshot = Object.freeze({
    ...snapshot,
    ...patch,
  });
  snapshot = next;
  emit();
}

function isExpiredConfirmation(pending: PendingVoiceConfirmation | null): boolean {
  return Boolean(pending && Date.now() > pending.expiresAt);
}

function isExpiredToast(toast: EchoActionToast | null): boolean {
  return Boolean(toast && toast.expiresAt > 0 && Date.now() > toast.expiresAt);
}

function attachBrowserBridgeOnce(): void {
  if (windowListenersAttached || typeof window === 'undefined') return;
  windowListenersAttached = true;

  window.addEventListener('ec:module-mic', (event: Event) => {
    const detail = (event as CustomEvent<{ active?: boolean; owner?: string; source?: string }>).detail;
    const active = detail?.active === true;
    const owner = active ? String(detail?.owner || detail?.source || 'module') : null;
    setModuleMicState(active, owner);
  });

  window.addEventListener('storage', (event: StorageEvent) => {
    if (!snapshot.userId) return;
    const key = handsFreeStorageKey(snapshot.userId);
    if (event.key === key || event.key === null) {
      const nextHandsFree = readHandsFreePreference(snapshot.userId);
      if (nextHandsFree !== snapshot.handsFreeEnabled) {
        updateSnapshot({
          handsFreeEnabled: nextHandsFree,
          // Cross-tab sync never increments handsFreeSessionEpoch -> zero duplicate greeting across tabs.
          greetingSpokenEpoch: snapshot.handsFreeSessionEpoch,
          entityState:
            !nextHandsFree && snapshot.entityState === 'dormant'
              ? 'disabled'
              : nextHandsFree && snapshot.entityState === 'disabled' && !snapshot.strictSentinelLocked
                ? 'dormant'
                : snapshot.entityState,
        });
      }
    }
  });
}

/** Synchronizes store with Sentinel strict-focus attempts and auth logout lifecycle. */
subscribeStrictSentinel(() => {
  const locked = hasActiveStrictSentinelAttempt();
  if (locked === snapshot.strictSentinelLocked) return;
  if (locked) {
    clearToastTimer();
  }
  updateSnapshot({
    strictSentinelLocked: locked,
    ...(locked
      ? {
          voiceStage: false,
          entityState: 'disabled',
          pendingConfirmation: null,
          activeToast: null,
          lastError: null,
          liveCaption: EMPTY_CAPTION,
        }
      : {
          entityState: snapshot.handsFreeEnabled && snapshot.userId ? 'dormant' : 'disabled',
        }),
  });
});

export function resetVoiceSessionOnLogout(): void {
  clearToastTimer();
  undoStack.length = 0;
  if (snapshot === SERVER_SNAPSHOT) return;
  snapshot = Object.freeze({
    ...SERVER_SNAPSHOT,
    strictSentinelLocked: hasActiveStrictSentinelAttempt(),
  });
  emit();
}

registerUserScopedCleanup(resetVoiceSessionOnLogout);
subscribeAuthLifecycle(() => {
  if (authEnding()) {
    resetVoiceSessionOnLogout();
  }
});

// ---------------------------------------------------------------------------
// External Store Contract (`useSyncExternalStore`)
// ---------------------------------------------------------------------------

export function subscribeVoiceSession(listener: () => void): () => void {
  attachBrowserBridgeOnce();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getVoiceSessionSnapshot(): EchoVoiceSessionSnapshot {
  let mutated = false;
  let nextPending = snapshot.pendingConfirmation;
  let nextToast = snapshot.activeToast;
  if (nextPending && isExpiredConfirmation(nextPending)) {
    nextPending = null;
    mutated = true;
  }
  if (nextToast && isExpiredToast(nextToast)) {
    nextToast = null;
    mutated = true;
  }
  if (mutated) {
    snapshot = Object.freeze({
      ...snapshot,
      pendingConfirmation: nextPending,
      activeToast: nextToast,
    });
  }
  return snapshot;
}

export function getVoiceSessionServerSnapshot(): EchoVoiceSessionSnapshot {
  return SERVER_SNAPSHOT;
}

// ---------------------------------------------------------------------------
// Store Mutations
// ---------------------------------------------------------------------------

export function setVoiceSessionUser(rawUserId: string | number | null | undefined): void {
  attachBrowserBridgeOnce();
  const nextUser = cleanUserId(rawUserId);
  if (nextUser === snapshot.userId) return;
  if (!nextUser) {
    resetVoiceSessionOnLogout();
    return;
  }
  clearToastTimer();
  undoStack.length = 0;
  const handsFree = readHandsFreePreference(nextUser);
  const locked = hasActiveStrictSentinelAttempt();
  updateSnapshot({
    userId: nextUser,
    activeConversationId: null,
    uiMode: 'ambient',
    voiceStage: false,
    entityState: locked ? 'disabled' : handsFree ? 'dormant' : 'disabled',
    handsFreeEnabled: handsFree,
    // Reload / login restoration starts with matching epochs -> ZERO re-greeting on page reload!
    handsFreeSessionEpoch: 0,
    greetingSpokenEpoch: 0,
    muted: false,
    captionsEnabled: false,
    strictSentinelLocked: locked,
    overBookReader: false,
    wsConnected: false,
    liveCaption: EMPTY_CAPTION,
    activeToast: null,
    lastError: null,
    pendingConfirmation: null,
    lastActionLifecycle: null,
    canUndoLastAction: false,
    routeStack: Object.freeze([]),
    recentActions: Object.freeze([]),
  });
}

export function setHandsFreeEnabled(enabled: boolean, opts?: { userInitiated?: boolean }): void {
  attachBrowserBridgeOnce();
  const boolVal = Boolean(enabled);
  const wasEnabled = snapshot.handsFreeEnabled;
  if (snapshot.userId) {
    writeHandsFreePreference(snapshot.userId, boolVal);
  }
  const locked = hasActiveStrictSentinelAttempt();
  let nextState = snapshot.entityState;
  if (locked) {
    nextState = 'disabled';
  } else if (boolVal && (nextState === 'disabled' || nextState === 'sleeping')) {
    nextState = 'dormant';
  } else if (!boolVal && nextState === 'dormant') {
    nextState = 'disabled';
  }

  let nextSessionEpoch = snapshot.handsFreeSessionEpoch;
  let nextGreetingEpoch = snapshot.greetingSpokenEpoch;

  if (boolVal && !wasEnabled && opts?.userInitiated === true) {
    // Explicit OFF -> ON user toggle opens a fresh Hands-Free session eligible for ONE greeting.
    nextSessionEpoch = snapshot.handsFreeSessionEpoch + 1;
  } else if (!boolVal) {
    // Turning Hands-Free OFF closes the current session epoch cleanly.
    nextGreetingEpoch = nextSessionEpoch;
  } else if (boolVal && opts?.userInitiated === false) {
    // Silent reload restoration must NEVER trigger a greeting.
    nextGreetingEpoch = nextSessionEpoch;
  }

  updateSnapshot({
    handsFreeEnabled: boolVal,
    handsFreeSessionEpoch: nextSessionEpoch,
    greetingSpokenEpoch: nextGreetingEpoch,
    entityState: nextState,
  });
}

/**
 * Returns true strictly when an explicit OFF -> ON Hands-Free session has not yet spoken its
 * single onboarding greeting (never true after reload, navigation, UI toggle, or wake).
 */
export function shouldPlayHandsFreeGreeting(): boolean {
  return (
    snapshot.handsFreeEnabled &&
    !snapshot.strictSentinelLocked &&
    snapshot.handsFreeSessionEpoch > 0 &&
    snapshot.greetingSpokenEpoch < snapshot.handsFreeSessionEpoch
  );
}

export function markGreetingSpoken(epoch?: number): void {
  const target =
    typeof epoch === 'number' && Number.isFinite(epoch)
      ? Math.max(snapshot.greetingSpokenEpoch, Math.floor(epoch))
      : Math.max(snapshot.greetingSpokenEpoch, snapshot.handsFreeSessionEpoch);
  if (target === snapshot.greetingSpokenEpoch) return;
  updateSnapshot({ greetingSpokenEpoch: target });
}

export function setVoiceMuted(muted: boolean): void {
  const boolVal = Boolean(muted);
  if (snapshot.muted === boolVal) return;
  updateSnapshot({
    muted: boolVal,
    entityState:
      boolVal && (snapshot.entityState === 'listening' || snapshot.entityState === 'awakening')
        ? snapshot.handsFreeEnabled
          ? 'dormant'
          : 'disabled'
        : snapshot.entityState,
  });
}

export function setCaptionsEnabled(enabled: boolean): void {
  const boolVal = Boolean(enabled);
  if (snapshot.captionsEnabled === boolVal) return;
  updateSnapshot({ captionsEnabled: boolVal });
}

export function setOverBookReader(open: boolean): void {
  const boolVal = Boolean(open);
  if (snapshot.overBookReader === boolVal) return;
  updateSnapshot({ overBookReader: boolVal });
}

export function setWsConnected(connected: boolean): void {
  const boolVal = Boolean(connected);
  if (snapshot.wsConnected === boolVal) return;
  updateSnapshot({ wsConnected: boolVal });
}

export function setModuleMicState(active: boolean, owner?: string | null): void {
  const boolVal = Boolean(active);
  const nextOwner = boolVal ? String(owner || 'module') : null;
  if (snapshot.moduleMicActive === boolVal && snapshot.moduleMicOwner === nextOwner) return;
  const nextEntity: EchoEntityState =
    boolVal && snapshot.entityState !== 'disabled' && snapshot.entityState !== 'sleeping'
      ? snapshot.handsFreeEnabled
        ? 'dormant'
        : 'disabled'
      : snapshot.entityState;
  updateSnapshot({
    moduleMicActive: boolVal,
    moduleMicOwner: nextOwner,
    entityState: nextEntity,
    ...(boolVal ? { liveCaption: EMPTY_CAPTION } : {}),
  });
}

export function setVoiceUiMode(uiMode: EchoPresentationMode | 'compact' | 'expanded'): void {
  const normalized = normalizePresentationMode(uiMode);
  if (!normalized) return;
  if (snapshot.uiMode === normalized) return;
  updateSnapshot({ uiMode: normalized });
}

/** The one writer of the panel's voice presentation (see `EchoVoiceSessionSnapshot.voiceStage`). */
export function setVoiceStage(on: boolean): void {
  const next = Boolean(on) && !hasActiveStrictSentinelAttempt();
  if (snapshot.voiceStage === next) return;
  updateSnapshot({ voiceStage: next });
}

export function setVoiceEntityState(state: EchoEntityState): void {
  if (!ENTITY_STATE_SET.has(state)) return;
  if (hasActiveStrictSentinelAttempt() && state !== 'disabled') {
    if (snapshot.entityState !== 'disabled' || snapshot.voiceStage) {
      updateSnapshot({ voiceStage: false, entityState: 'disabled', strictSentinelLocked: true });
    }
    return;
  }
  if (snapshot.entityState === state) return;
  updateSnapshot({ entityState: state });
}

export function setVoiceLiveCaption(partial: { userPartial?: string; echoSpoken?: string }): void {
  const userPartial =
    partial.userPartial !== undefined ? String(partial.userPartial).slice(0, 600) : snapshot.liveCaption.userPartial;
  const echoSpoken =
    partial.echoSpoken !== undefined ? String(partial.echoSpoken).slice(0, 1200) : snapshot.liveCaption.echoSpoken;
  if (userPartial === snapshot.liveCaption.userPartial && echoSpoken === snapshot.liveCaption.echoSpoken) {
    return;
  }
  updateSnapshot({
    liveCaption: Object.freeze({
      userPartial,
      echoSpoken,
      updatedAt: Date.now(),
    }),
  });
}

export function clearVoiceLiveCaption(): void {
  if (!snapshot.liveCaption.userPartial && !snapshot.liveCaption.echoSpoken) return;
  updateSnapshot({ liveCaption: EMPTY_CAPTION });
}

export function setActiveToast(
  input:
    | (Omit<EchoActionToast, 'id' | 'expiresAt'> & {
        id?: string;
        ttlMs?: number;
        expiresAt?: number;
      })
    | null,
): EchoActionToast | null {
  clearToastTimer();
  if (!input) {
    if (snapshot.activeToast) updateSnapshot({ activeToast: null });
    return null;
  }
  const now = Date.now();
  const ttlMs =
    typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs) && input.ttlMs > 0
      ? Math.min(input.ttlMs, CONFIRMATION_TTL_MS)
      : input.kind === 'confirm'
        ? 30_000
        : input.kind === 'resources' || input.kind === 'stats'
          ? 12_000
          : DEFAULT_TOAST_TTL_MS;
  const expiresAt = typeof input.expiresAt === 'number' && input.expiresAt > now ? input.expiresAt : now + ttlMs;
  const rawTitle = String(input.title || '').trim();
  const docLocale: 'en' | 'vi' =
    typeof document !== 'undefined' && document.documentElement?.lang === 'en' ? 'en' : 'vi';
  const safeTitle =
    input.kind === 'error' && (!rawTitle || RAW_MACHINE_ERROR_CODE_RE.test(rawTitle))
      ? formatEchoVoiceError(classifyEchoVoiceError(rawTitle), docLocale, { code: rawTitle }).title
      : rawTitle;
  const toast: EchoActionToast = Object.freeze({
    id: input.id || `toast-${now.toString(36)}-${(++toastSeq).toString(36)}`,
    kind: input.kind,
    title: safeTitle.slice(0, 140),
    ...(input.subtitle ? { subtitle: String(input.subtitle).slice(0, 260) } : {}),
    ...(input.items && input.items.length > 0
      ? {
          items: Object.freeze(
            input.items.slice(0, 6).map((item) =>
              Object.freeze({
                title: String(item.title || '').slice(0, 120),
                ...(item.subtitle ? { subtitle: String(item.subtitle).slice(0, 160) } : {}),
                ...(item.meta ? { meta: String(item.meta).slice(0, 60) } : {}),
                ...(item.href ? { href: String(item.href).slice(0, 160) } : {}),
              }),
            ),
          ),
        }
      : {}),
    ...(input.confirmToken ? { confirmToken: input.confirmToken } : {}),
    ...(input.confirmSource ? { confirmSource: input.confirmSource } : {}),
    ...(input.canUndo === true ? { canUndo: true } : {}),
    ...(input.canRetry === true ? { canRetry: true } : {}),
    ...(input.errorKind ? { errorKind: input.errorKind } : {}),
    expiresAt,
  });
  updateSnapshot({ activeToast: toast });
  if (typeof setTimeout === 'function') {
    const delay = Math.max(200, expiresAt - Date.now());
    toastExpiryTimer = setTimeout(() => {
      if (snapshot.activeToast?.id === toast.id) {
        updateSnapshot({ activeToast: null });
      }
      toastExpiryTimer = null;
    }, delay);
  }
  return toast;
}

export function clearActiveToast(): void {
  clearToastTimer();
  if (!snapshot.activeToast) return;
  updateSnapshot({ activeToast: null });
}

export function setVoiceError(input: {
  kind: EchoVoiceErrorKind;
  title: string;
  subtitle?: string;
  canRetry?: boolean;
}): EchoVoiceErrorState {
  const now = Date.now();
  const docLocale: 'en' | 'vi' =
    typeof document !== 'undefined' && document.documentElement?.lang === 'en' ? 'en' : 'vi';
  const rawTitle = String(input.title || '').trim();
  const safeTitle =
    !rawTitle || RAW_MACHINE_ERROR_CODE_RE.test(rawTitle)
      ? formatEchoVoiceError(input.kind, docLocale).title
      : rawTitle;
  const errState: EchoVoiceErrorState = Object.freeze({
    id: `verr-${now.toString(36)}-${(++toastSeq).toString(36)}`,
    kind: input.kind,
    title: safeTitle.slice(0, 140),
    ...(input.subtitle ? { subtitle: String(input.subtitle).slice(0, 220) } : {}),
    canRetry: input.canRetry !== false && input.kind !== 'quota_limit',
    occurredAt: now,
  });
  updateSnapshot({ lastError: errState });
  return errState;
}

export function clearVoiceError(): void {
  if (!snapshot.lastError) return;
  updateSnapshot({ lastError: null });
}

export function setActiveVoiceConversationId(conversationId: number | null): void {
  const normalized =
    typeof conversationId === 'number' && Number.isSafeInteger(conversationId) && conversationId > 0
      ? conversationId
      : null;
  if (snapshot.activeConversationId === normalized) return;
  updateSnapshot({ activeConversationId: normalized });
}

export function pushVoiceRouteHistory(href: string): void {
  const clean = typeof href === 'string' ? href.trim() : '';
  if (!clean || !clean.startsWith('/')) return;
  const prevStack = snapshot.routeStack;
  if (prevStack[prevStack.length - 1] === clean) return;
  const nextStack = Object.freeze([...prevStack.slice(-(MAX_ROUTE_STACK - 1)), clean]);
  updateSnapshot({ routeStack: nextStack });
}

export function popVoiceRouteHistory(): string | null {
  const prevStack = snapshot.routeStack;
  if (prevStack.length === 0) return null;
  const target = prevStack[prevStack.length - 1] ?? null;
  const nextStack = Object.freeze(prevStack.slice(0, -1));
  updateSnapshot({ routeStack: nextStack });
  return target;
}

export function setPendingServerConfirmation(input: {
  token: string;
  summaryEn: string;
  summaryVi: string;
  ttlMs?: number;
}): PendingVoiceConfirmation {
  const now = Date.now();
  const ttl = typeof input.ttlMs === 'number' && input.ttlMs > 0 ? Math.min(input.ttlMs, CONFIRMATION_TTL_MS) : CONFIRMATION_TTL_MS;
  const pending: PendingVoiceConfirmation = Object.freeze({
    kind: 'server',
    token: input.token,
    summaryEn: input.summaryEn,
    summaryVi: input.summaryVi,
    createdAt: now,
    expiresAt: now + ttl,
  });
  updateSnapshot({ pendingConfirmation: pending });
  return pending;
}

export function setPendingClientConfirmation(input: {
  intent: EchoClientIntent;
  summaryEn: string;
  summaryVi: string;
  ttlMs?: number;
}): PendingVoiceConfirmation {
  const now = Date.now();
  const ttl = typeof input.ttlMs === 'number' && input.ttlMs > 0 ? Math.min(input.ttlMs, CONFIRMATION_TTL_MS) : CONFIRMATION_TTL_MS;
  const clientToken = `ec-confirm-${now.toString(36)}-${(++clientTokenSeq).toString(36)}`;
  const pending: PendingVoiceConfirmation = Object.freeze({
    kind: 'client',
    clientToken,
    intent: input.intent,
    summaryEn: input.summaryEn,
    summaryVi: input.summaryVi,
    createdAt: now,
    expiresAt: now + ttl,
  });
  updateSnapshot({ pendingConfirmation: pending });
  return pending;
}

export function hasActivePendingConfirmation(): boolean {
  const current = getVoiceSessionSnapshot().pendingConfirmation;
  return Boolean(current && !isExpiredConfirmation(current));
}

/**
 * Atomically consumes and clears the active pending confirmation (single-use ledger semantics).
 */
export function consumePendingConfirmation(): PendingVoiceConfirmation | null {
  const current = snapshot.pendingConfirmation;
  if (!current) return null;
  updateSnapshot({ pendingConfirmation: null });
  if (isExpiredConfirmation(current)) return null;
  return current;
}

export function clearPendingConfirmation(): void {
  if (!snapshot.pendingConfirmation) return;
  updateSnapshot({ pendingConfirmation: null });
}

export function pushUndoAction(input: {
  labelEn: string;
  labelVi: string;
  undo: () => void | Promise<void>;
}): string {
  const entry: EchoUndoEntry = Object.freeze({
    id: `undo-${Date.now().toString(36)}-${(++undoSeq).toString(36)}`,
    labelEn: String(input.labelEn || 'Last action').slice(0, 120),
    labelVi: String(input.labelVi || 'Thao tác vừa rồi').slice(0, 120),
    undo: input.undo,
    createdAt: Date.now(),
  });
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO_STACK) {
    undoStack.splice(0, undoStack.length - MAX_UNDO_STACK);
  }
  if (!snapshot.canUndoLastAction) {
    updateSnapshot({ canUndoLastAction: true });
  }
  return entry.id;
}

export function peekUndoActionLabel(): { labelEn: string; labelVi: string } | null {
  const top = undoStack[undoStack.length - 1];
  return top ? { labelEn: top.labelEn, labelVi: top.labelVi } : null;
}

export async function popAndRunUndoAction(): Promise<{
  ok: boolean;
  labelEn?: string;
  labelVi?: string;
}> {
  const entry = undoStack.pop();
  const hasMore = undoStack.length > 0;
  if (snapshot.canUndoLastAction !== hasMore) {
    updateSnapshot({ canUndoLastAction: hasMore });
  }
  if (!entry) return { ok: false };
  try {
    await entry.undo();
    return { ok: true, labelEn: entry.labelEn, labelVi: entry.labelVi };
  } catch {
    return { ok: false, labelEn: entry.labelEn, labelVi: entry.labelVi };
  }
}

export function clearUndoStack(): void {
  undoStack.length = 0;
  if (snapshot.canUndoLastAction) {
    updateSnapshot({ canUndoLastAction: false });
  }
}

const ACTION_LIFECYCLE_SET = new Set<string>(ECHO_ACTION_LIFECYCLE_STATES);

export function setActionLifecycle(
  state: EchoActionLifecycleState,
  meta?: { kind?: string; detail?: string },
): EchoActionLifecycleRecord {
  const validState: EchoActionLifecycleState = ACTION_LIFECYCLE_SET.has(state) ? state : 'failed';
  const rec: EchoActionLifecycleRecord = Object.freeze({
    state: validState,
    ...(meta?.kind ? { kind: String(meta.kind).slice(0, 60) } : {}),
    ...(meta?.detail ? { detail: String(meta.detail).slice(0, 160) } : {}),
    updatedAt: Date.now(),
  });
  updateSnapshot({ lastActionLifecycle: rec });
  return rec;
}

export function recordExecutedVoiceAction(entry: {
  kind: EchoClientIntent['kind'];
  status: EchoExecutedActionRecord['status'];
  detail: string;
}): void {
  const record: EchoExecutedActionRecord = Object.freeze({
    id: `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind: entry.kind,
    status: entry.status,
    detail: entry.detail.slice(0, 160),
    timestamp: Date.now(),
  });
  const nextActions = Object.freeze([record, ...snapshot.recentActions].slice(0, MAX_RECENT_ACTIONS));
  updateSnapshot({ recentActions: nextActions });
}

export const echoVoiceSessionStore = {
  subscribe: subscribeVoiceSession,
  getSnapshot: getVoiceSessionSnapshot,
  getServerSnapshot: getVoiceSessionServerSnapshot,
  setUser: setVoiceSessionUser,
  setHandsFreeEnabled,
  shouldPlayHandsFreeGreeting,
  markGreetingSpoken,
  setMuted: setVoiceMuted,
  setCaptionsEnabled,
  setOverBookReader,
  setWsConnected,
  setModuleMicState,
  setUiMode: setVoiceUiMode,
  setVoiceStage,
  setEntityState: setVoiceEntityState,
  setLiveCaption: setVoiceLiveCaption,
  clearLiveCaption: clearVoiceLiveCaption,
  setActiveToast,
  clearActiveToast,
  setVoiceError,
  clearVoiceError,
  classifyError: classifyEchoVoiceError,
  formatError: formatEchoVoiceError,
  setActiveConversationId: setActiveVoiceConversationId,
  pushRoute: pushVoiceRouteHistory,
  popRoute: popVoiceRouteHistory,
  setPendingServerConfirmation,
  setPendingClientConfirmation,
  hasActivePendingConfirmation,
  consumePendingConfirmation,
  clearPendingConfirmation,
  pushUndoAction,
  peekUndoActionLabel,
  popAndRunUndoAction,
  clearUndoStack,
  setActionLifecycle,
  recordAction: recordExecutedVoiceAction,
  resetOnLogout: resetVoiceSessionOnLogout,
} as const;
