/**
 * Multi-Step Intent DAG Executor for Echo JARVIS.
 *
 * Orders compound `EchoClientIntent[]` plans deterministically across execution phases:
 * 1. Global shell, theme, font scale, appearance, audio, undo, and confirmation intents
 * 2. Route transitions (`navigate`, `history_back`, `history_forward`) — injecting prerequisite
 *    module navigation when a module-scoped intent (`reading_control` tab/filter, `speaking_control`,
 *    `flashcard_control`, `writing_control`) targets another route
 * 3. Post-navigation module intents (`reading_control`, `mybooks_open_last`, `mybooks_reader`,
 *    `listening_player`, `speaking_control`, `flashcard_control`, `writing_control`,
 *    `scroll`, `dictionary_lookup`, `open_appearance_studio`, `open_guide`)
 *    after verifying route transition + `ec:module-ready` handshake completion (`1,200 ms` fallback)
 * 4. Destructive / confirmation-gated intents (`request_logout`, `delete_resource`, `plan_or_dna_commit`)
 *
 * Supports `AbortSignal` cancellation on barge-in and halts downstream steps cleanly if any
 * prerequisite step is aborted, denied, unsupported, failed, or paused awaiting confirmation.
 */

import { type EchoClientIntent } from './actionSchema';
import {
  type DispatchOutcome,
  type EchoActionHost,
  dispatchEchoIntent,
  getRegisteredEchoActionHost,
} from './actionDispatcher';
import {
  getVoiceSessionSnapshot,
   recordExecutedVoiceAction,
  setActionLifecycle,
  setVoiceEntityState,
} from './voiceSessionStore';

export interface DagStepResult {
  index: number;
  intent: EchoClientIntent;
  outcome: DispatchOutcome;
  durationMs: number;
}

export interface DagExecutionReport {
  status: 'done' | 'confirm_required' | 'denied' | 'unsupported' | 'failed' | 'aborted';
  steps: DagStepResult[];
  skippedIntents: EchoClientIntent[];
  totalDurationMs: number;
  escalateReason?: string;
}

export interface DagExecuteOptions {
  host?: EchoActionHost;
  routeTimeoutMs?: number;
  pollIntervalMs?: number;
  hasActiveStrictSentinel?: boolean;
  signal?: AbortSignal;
}

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

function phaseOfIntent(intent: EchoClientIntent): number {
  switch (intent.kind) {
    case 'voice_confirm':
    case 'undo_last_action':
    case 'theme_mode':
    case 'ui_font_scale':
    case 'ui_locale':
    case 'nav_layout':
    case 'nav_visibility':
    case 'world_display':
    case 'apply_bg_preset':
    case 'adjust_bg_brightness':
    case 'reset_appearance':
    case 'music_control':
    case 'voice_control':
      return 0;

    case 'navigate':
    case 'history_back':
    case 'history_forward':
      return 1;

    case 'reading_control':
    case 'mybooks_open_last':
    case 'mybooks_reader':
    case 'listening_player':
    case 'speaking_control':
    case 'flashcard_control':
    case 'writing_control':
    case 'scroll':
    case 'dictionary_lookup':
    case 'open_appearance_studio':
    case 'open_guide':
      return 2;

    case 'request_logout':
    case 'delete_resource':
    case 'plan_or_dna_commit':
    case 'forbidden_attempt':
    case 'unsupported_external':
      return 3;
  }
}

function moduleNameForRoute(href: string): string | null {
  const path = (href || '').split('?')[0];
  if (path === '/reading') {
    if (href.includes('section=mybooks')) return 'mybooks';
    return 'reading';
  }
  if (path === '/speaking' || path.startsWith('/speaking/')) return 'speaking';
  if (path === '/listening' || path.startsWith('/listening/')) return 'listening';
  if (path === '/flashcards') return 'flashcards';
  if (path === '/writing') return 'writing';
  return null;
}

/**
 * Stable topological sort by execution phase while synthesizing prerequisite module
 * navigation if a module-scoped intent runs from outside its home route.
 */
export function buildOrderedIntentPlan(
  intents: readonly EchoClientIntent[],
  currentPathname: string,
): EchoClientIntent[] {
  if (intents.length === 0) return [];

  const expanded: EchoClientIntent[] = [...intents];
  const hasExplicitNav = expanded.some(
    (i) => i.kind === 'navigate' || i.kind === 'history_back' || i.kind === 'history_forward',
  );

  if (!hasExplicitNav) {
    if (currentPathname !== '/reading') {
      const readingNavNeeded = expanded.find(
        (i): i is Extract<EchoClientIntent, { kind: 'reading_control' }> =>
          i.kind === 'reading_control' &&
          (i.tab !== undefined ||
            i.filterLevel !== undefined ||
            i.filterTopic !== undefined ||
            i.searchQuery !== undefined),
      );
      if (readingNavNeeded) {
        const targetHref =
          readingNavNeeded.tab && readingNavNeeded.tab !== 'library'
            ? `/reading?section=${readingNavNeeded.tab}`
            : '/reading';
        expanded.unshift({
          kind: 'navigate',
          href: targetHref,
          label: 'Reading',
        });
      }
    }

    if (currentPathname !== '/speaking' && !currentPathname.startsWith('/speaking/')) {
      const speakingNavNeeded = expanded.find(
        (i): i is Extract<EchoClientIntent, { kind: 'speaking_control' }> =>
          i.kind === 'speaking_control' && i.scenarioId === undefined,
      );
      if (speakingNavNeeded) {
        const targetHref =
          speakingNavNeeded.view === 'profile'
            ? speakingNavNeeded.sub && speakingNavNeeded.sub !== 'overview'
              ? `/speaking?view=profile&sub=${speakingNavNeeded.sub}`
              : '/speaking?view=profile'
            : speakingNavNeeded.mode
              ? `/speaking?mode=${speakingNavNeeded.mode}`
              : '/speaking';
        expanded.unshift({
          kind: 'navigate',
          href: targetHref,
          label: speakingNavNeeded.view === 'profile' ? 'Speaking Profile' : 'Speaking',
        });
      }
    }

    if (currentPathname !== '/flashcards') {
      const flashcardNavNeeded = expanded.find(
        (i): i is Extract<EchoClientIntent, { kind: 'flashcard_control' }> =>
          i.kind === 'flashcard_control',
      );
      if (flashcardNavNeeded) {
        const targetHref =
          flashcardNavNeeded.mode === 'due' || flashcardNavNeeded.mode === 'learned'
            ? `/flashcards?review=${flashcardNavNeeded.mode}`
            : flashcardNavNeeded.deckId
              ? `/flashcards?deck=${flashcardNavNeeded.deckId}`
              : '/flashcards';
        expanded.unshift({
          kind: 'navigate',
          href: targetHref,
          label: 'Flashcards',
        });
      }
    }

    if (currentPathname !== '/writing') {
      const writingNavNeeded = expanded.find(
        (i): i is Extract<EchoClientIntent, { kind: 'writing_control' }> =>
          i.kind === 'writing_control',
      );
      if (writingNavNeeded) {
        const baseRoom = writingNavNeeded.room ?? (writingNavNeeded.mode ? 'translation' : undefined);
        let targetHref = baseRoom ? `/writing?w=${baseRoom}` : '/writing';
        if (baseRoom === 'translation' && writingNavNeeded.mode?.toUpperCase() === 'PARAGRAPH') {
          targetHref = '/writing?w=translation&mode=PARAGRAPH';
        } else if (
          baseRoom === 'sentence-lab' &&
          (writingNavNeeded.mode === 'mistakes' || writingNavNeeded.mode === 'check')
        ) {
          targetHref = `/writing?w=sentence-lab&lab=${writingNavNeeded.mode}`;
        }
        expanded.unshift({
          kind: 'navigate',
          href: targetHref,
          label: 'Writing',
        });
      }
    }
  }

  return expanded
    .map((intent, originalIdx) => ({ intent, phase: phaseOfIntent(intent), originalIdx }))
    .sort((a, b) => (a.phase !== b.phase ? a.phase - b.phase : a.originalIdx - b.originalIdx))
    .map((item) => item.intent);
}

function matchesTargetHref(expectedHref: string, host: EchoActionHost): boolean {
  const [expectedPathRaw, expectedQuery = ''] = (expectedHref || '').split('?');
  const expectedPath = expectedPathRaw || '/';
  const expectedParams = new URLSearchParams(expectedQuery);

  const hasBrowserLocation = typeof window !== 'undefined' && Boolean(window.location);
  if (!hasBrowserLocation && !host.getPathname) {
    return true;
  }

  const actualPath = hasBrowserLocation
    ? window.location.pathname || ''
    : host.getPathname?.() || '';
  if (actualPath !== expectedPath) {
    return false;
  }

  let actualParams: { get(name: string): string | null } | null = null;
  if (hasBrowserLocation) {
    actualParams = new URLSearchParams(window.location.search || '');
  } else if (host.getSearchParams) {
    actualParams = host.getSearchParams();
  }

  for (const [key, expectedVal] of expectedParams.entries()) {
    if (!actualParams) return false;
    const actualVal = actualParams.get(key);
    if (actualVal === expectedVal) continue;
    // `/reading` accepts `section` and `tab` interchangeably
    if (expectedPath === '/reading' && (key === 'section' || key === 'tab')) {
      const altVal = actualParams.get(key === 'section' ? 'tab' : 'section');
      if (altVal === expectedVal) continue;
    }
    return false;
  }

  return true;
}

/**
 * Verifies that BOTH `window.location.pathname` AND every query key/value in `expectedHref`
 * match `window.location.search` within `timeoutMs` (default `500 ms` — comfortably inside
 * backend `650 ms` `ACTION_ACK_TIMEOUT_MS` while giving client-pushed routes `>3x` headroom).
 * Returns `false` on timeout instead of silently claiming success!
 */
export async function waitForTargetUrl(
  expectedHref: string,
  host: EchoActionHost = {},
  timeoutMs = 500,
  pollIntervalMs = 20,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;

  const hasBrowserLocation = typeof window !== 'undefined' && Boolean(window.location);
  if (!hasBrowserLocation && !host.getPathname) {
    return true;
  }

  const expectedModule = moduleNameForRoute(expectedHref);
  let moduleReadyReceived = false;
  let onModuleReady: ((ev: Event) => void) | null = null;
  if (
    expectedModule &&
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function'
  ) {
    onModuleReady = (ev: Event) => {
      const mod = (ev as CustomEvent<{ module?: string }>).detail?.module;
      if (mod === expectedModule || (expectedModule === 'mybooks' && mod === 'reading')) {
        moduleReadyReceived = true;
      }
    };
    window.addEventListener('ec:module-ready', onModuleReady);
  }

  try {
    const deadline = nowMs() + Math.max(20, timeoutMs);
    while (nowMs() <= deadline) {
      if (signal?.aborted) return false;
      if (matchesTargetHref(expectedHref, host)) {
        if (expectedModule && !moduleReadyReceived) {
          // Allow one frame settle tick so target React listeners attach after pushState/router.push.
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(16, pollIntervalMs)));
        }
        return !signal?.aborted;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return !signal?.aborted && matchesTargetHref(expectedHref, host);
  } finally {
    if (onModuleReady && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('ec:module-ready', onModuleReady);
    }
  }
}

/**
 * Executes a single or multi-step `EchoClientIntent[]` DAG with phase ordering,
 * `AbortSignal` cancellation, route + query post-condition verification on every navigation,
 * and explicit action lifecycle state transitions.
 */
export async function executeIntentDag(
  rawIntents: readonly EchoClientIntent[],
  options: DagExecuteOptions = {},
): Promise<DagExecutionReport> {
  const totalStart = nowMs();
  const host: EchoActionHost = { ...getRegisteredEchoActionHost(), ...(options.host ?? {}) };
  const routeTimeoutMs = options.routeTimeoutMs ?? 500;
  const pollIntervalMs = options.pollIntervalMs ?? 20;
  const signal = options.signal;

  if (!rawIntents || rawIntents.length === 0) {
    return {
      status: 'done',
      steps: [],
      skippedIntents: [],
      totalDurationMs: 0,
    };
  }

  const initialPath =
    host.getPathname?.() ?? (typeof window !== 'undefined' ? window.location.pathname : '/dashboard');
  const plan = buildOrderedIntentPlan(rawIntents, initialPath);
  setActionLifecycle('proposed', { kind: plan[0]?.kind, detail: `steps:${plan.length}` });

  if (signal?.aborted) {
    setActionLifecycle('cancelled', { kind: plan[0]?.kind, detail: 'aborted_before_start' });
    return {
      status: 'aborted',
      steps: [],
      skippedIntents: plan,
      totalDurationMs: Math.max(0, nowMs() - totalStart),
    };
  }

  const prevEntityState = getVoiceSessionSnapshot().entityState;
  const shouldPulseExecuting =
    prevEntityState !== 'disabled' && prevEntityState !== 'speaking' && prevEntityState !== 'dormant';
  if (shouldPulseExecuting) {
    setVoiceEntityState('executing');
  }

  const steps: DagStepResult[] = [];
  let escalateReason: string | undefined;

  try {
    for (let idx = 0; idx < plan.length; idx++) {
      if (signal?.aborted) {
        setActionLifecycle('cancelled', { kind: plan[idx]?.kind, detail: 'aborted_mid_dag' });
        return {
          status: 'aborted',
          steps,
          skippedIntents: plan.slice(idx),
          totalDurationMs: Math.max(0, nowMs() - totalStart),
        };
      }

      const intent = plan[idx];
      const stepStart = nowMs();
      let outcome = await dispatchEchoIntent(intent, {
        host,
        hasActiveStrictSentinel: options.hasActiveStrictSentinel,
      });

      // Verify actual route + query post-condition on EVERY navigation step (including 1-step navigation!)
      if (outcome.status === 'done' && outcome.navigatedTo && intent.kind === 'navigate') {
        const urlVerified = await waitForTargetUrl(
          outcome.navigatedTo,
          host,
          routeTimeoutMs,
          pollIntervalMs,
          signal,
        );
        if (!urlVerified) {
          if (signal?.aborted) {
            setActionLifecycle('cancelled', { kind: intent.kind, detail: 'aborted_during_nav' });
            return {
              status: 'aborted',
              steps,
              skippedIntents: plan.slice(idx),
              totalDurationMs: Math.max(0, nowMs() - totalStart),
            };
          }
          outcome = {
            status: 'failed',
            detail: `navigation_postcondition_failed:${outcome.navigatedTo}`,
            spokenMessage: {
              en: 'Could not open that page right now.',
              vi: 'Mình chưa mở được trang đó lúc này.',
            },
          };
          recordExecutedVoiceAction({
            kind: intent.kind,
            status: 'failed',
            detail: outcome.detail,
          });
          setActionLifecycle('failed', { kind: intent.kind, detail: outcome.detail });
        }
      }

      const durationMs = Math.max(0, nowMs() - stepStart);

      steps.push({
        index: idx,
        intent,
        outcome,
        durationMs,
      });

      if (outcome.escalateReason) {
        escalateReason = outcome.escalateReason;
      }

      if (outcome.status !== 'done') {
        return {
          status: outcome.status,
          steps,
          skippedIntents: plan.slice(idx + 1),
          totalDurationMs: Math.max(0, nowMs() - totalStart),
          ...(escalateReason ? { escalateReason } : {}),
        };
      }
    }

    setActionLifecycle('succeeded', {
      kind: plan[plan.length - 1]?.kind,
      detail: `completed:${steps.length}`,
    });
    return {
      status: 'done',
      steps,
      skippedIntents: [],
      totalDurationMs: Math.max(0, nowMs() - totalStart),
      ...(escalateReason ? { escalateReason } : {}),
    };
  } finally {
    if (shouldPulseExecuting && getVoiceSessionSnapshot().entityState === 'executing') {
      setVoiceEntityState(prevEntityState);
    }
  }
}
