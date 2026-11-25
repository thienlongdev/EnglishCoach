/**
 * Validated Client Intent Dispatcher for Echo JARVIS (`Plane A`).
 *
 * Executes schema- and permission-checked `EchoClientIntent` actions directly against
 * English Coach's canonical stores, routers, IndexedDB (`BookStore`), and typed `CustomEvent`
 * channels (`0` DOM scraping, `0` unsafe dynamic code).
 *
 * Records reversible UI mutations (`theme_mode`, `ui_font_scale`, `reading_control`, `nav_layout`,
 * `nav_visibility`, `apply_bg_preset`) on `voiceSessionStore`'s session-scoped Undo stack.
 */

import { applyAppearanceTheme, readAppearanceTheme } from '@/lib/appearance/scope';
import { restoreDefaultAppearance } from '@/lib/appearance/state';
import { registerUserScopedCleanup } from '@/lib/auth-cache-cleanup';
import { cloneThemeConfig } from '@/lib/background-studio/colorScience';
import { DEFAULT_BACKGROUND_PRESET_ID, findBackgroundPreset } from '@/lib/background-studio/presets';
import {
  applyCustomBackground,
  applyPresetBackground,
  resolveActiveBgConfig,
} from '@/lib/background-studio/store';
import { BG_BOUNDS } from '@/lib/background-studio/types';
import { openGuidePanel } from '@/lib/guide/store';
import {
  navStorageKey,
  setNavigationLayout,
  setNavigationVisibility,
} from '@/lib/navigation/preferences';
import { isRootModuleHref } from '@/lib/navigation/routes';
import { setWorldDisplay } from '@/lib/ui/worldDisplay';
import { openWallpaperStudio } from '@/lib/wallpaper/storage';
import { echoIntelligenceApi } from '@/services/echoIntelligenceApi';
import { logout } from '@/services/logout';
import { BookStore } from '@/components/features/reading/books/store/bookStore';
import {
  type EchoClientIntent,
  type EchoVoiceControlCommand,
  isSameListeningLessonTransition,
  safeEchoJarvisHref,
} from './actionSchema';
import {
  type PermissionEvalContext,
  evaluateIntentPermission,
} from './permissionEngine';
import {
  consumePendingConfirmation,
  getVoiceSessionSnapshot,
  hasActivePendingConfirmation,
  popAndRunUndoAction,
  popVoiceRouteHistory,
  pushUndoAction,
  pushVoiceRouteHistory,
  recordExecutedVoiceAction,
  setActionLifecycle,
  setActiveToast,
  setCaptionsEnabled,
  setHandsFreeEnabled,
  setPendingClientConfirmation,
  setVoiceEntityState,
  setVoiceMuted,
  setVoiceUiMode,
} from './voiceSessionStore';

export type DispatchStatus =
  | 'done'
  | 'confirm_required'
  | 'denied'
  | 'unsupported'
  | 'failed';

export interface DispatchOutcome {
  status: DispatchStatus;
  detail: string;
  spokenMessage?: { en: string; vi: string };
  navigatedTo?: string;
  escalateReason?: string;
  canUndo?: boolean;
}

export interface MusicControllerLike {
  play: () => Promise<void> | void;
  pause: () => void;
  next: (direction?: number) => Promise<void> | void;
  volume: (value: number) => void;
  shuffle: () => void;
  snapshot: () => {
    volume: number;
    playing: boolean;
    current: { id: string } | null;
  };
}

export interface BookShelfStoreLike {
  listBooks: () => Promise<
    Array<{
      id: string;
      title: string;
      author?: string;
      lastOpenedAt: number | null;
      addedAt: number;
    }>
  >;
  getPosition?: (bookId: string) => Promise<{ progress?: number } | null | undefined>;
  close: () => void;
}

export interface EchoActionHost {
  getUserId?: () => string;
  getPathname?: () => string;
  getSearchParams?: () => URLSearchParams | { get(name: string): string | null } | null;
  routerPush?: (href: string) => void | Promise<void>;
  setLocale?: (locale: 'vi' | 'en') => void;
  getMusicEngine?: () => MusicControllerLike | null;
  openBookStore?: (userId: string) => Promise<BookShelfStoreLike>;
  decideServerConfirmation?: (
    token: string,
    decision: 'CONFIRM' | 'CANCEL',
  ) => Promise<{ status: string }>;
  signOut?: (callbackUrl?: string) => Promise<void> | void;
  onVoiceUiCommand?: (command: EchoVoiceControlCommand) => void;
}

export const UI_FONT_SCALE_STORAGE_PREFIX = 'ec_ui_font_scale:u';
export const UI_FONT_SCALE_MIN = 0.9;
export const UI_FONT_SCALE_MAX = 1.25;

let registeredHost: EchoActionHost = {};

export function registerEchoActionHost(host: EchoActionHost): () => void {
  registeredHost = host;
  return () => {
    if (registeredHost === host) {
      registeredHost = {};
    }
  };
}

export function getRegisteredEchoActionHost(): EchoActionHost {
  return registeredHost;
}

function clampFontScale(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  return Math.max(UI_FONT_SCALE_MIN, Math.min(UI_FONT_SCALE_MAX, Math.round(raw * 100) / 100));
}

export function uiFontScaleStorageKey(userId: string | number | null | undefined): string {
  const clean = String(userId ?? '').replace(/[^\w-]/g, '');
  return clean ? `${UI_FONT_SCALE_STORAGE_PREFIX}${clean}` : '';
}

export function readUiFontScale(userId: string): number {
  if (typeof window !== 'undefined') {
    const key = uiFontScaleStorageKey(userId);
    if (key) {
      try {
        const stored = Number(window.localStorage.getItem(key));
        if (Number.isFinite(stored) && stored >= UI_FONT_SCALE_MIN && stored <= UI_FONT_SCALE_MAX) {
          return clampFontScale(stored);
        }
      } catch {
        // Storage unavailable; read DOM fallback below.
      }
    }
  }
  if (typeof document !== 'undefined') {
    const cssVal = Number(document.documentElement.style.getPropertyValue('--ec-ui-font-scale'));
    if (Number.isFinite(cssVal) && cssVal >= UI_FONT_SCALE_MIN && cssVal <= UI_FONT_SCALE_MAX) {
      return clampFontScale(cssVal);
    }
  }
  return 1;
}

export function applyUiFontScale(userId: string, targetScale: number): number {
  const next = clampFontScale(targetScale);
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--ec-ui-font-scale', String(next));
    if (next === 1) {
      document.documentElement.removeAttribute('data-ui-font-scale');
    } else {
      document.documentElement.setAttribute('data-ui-font-scale', String(next));
    }
  }
  if (typeof window !== 'undefined') {
    const key = uiFontScaleStorageKey(userId);
    if (key) {
      try {
        if (next === 1) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, String(next));
      } catch {
        // Storage blocked; CSS variable remains live for this session.
      }
    }
    dispatchWindowEvent('ec:ui:font-scale', { scale: next });
  }
  return next;
}

export function restoreUiFontScaleForUser(userId: string): number {
  const scale = userId ? readUiFontScale(userId) : 1;
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--ec-ui-font-scale', String(scale));
    if (scale === 1) document.documentElement.removeAttribute('data-ui-font-scale');
    else document.documentElement.setAttribute('data-ui-font-scale', String(scale));
  }
  return scale;
}

registerUserScopedCleanup(() => {
  restoreUiFontScaleForUser('');
});

function resolveCurrentPathname(host: EchoActionHost): string {
  if (host.getPathname) return host.getPathname() || '/';
  if (typeof window !== 'undefined') return window.location.pathname || '/';
  return '/dashboard';
}

function resolveCurrentSearchParams(
  host: EchoActionHost,
): URLSearchParams | { get(name: string): string | null } | null {
  if (host.getSearchParams) return host.getSearchParams();
  if (typeof window !== 'undefined') return new URLSearchParams(window.location.search);
  return null;
}

function resolveCurrentUserId(host: EchoActionHost): string {
  if (host.getUserId) return host.getUserId() || '';
  return getVoiceSessionSnapshot().userId || '';
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function dispatchWindowEvent(name: string, detail?: unknown): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  if (detail === undefined) {
    window.dispatchEvent(new Event(name));
  } else {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

export function speakingIntentDetailFromHref(href: string): Record<string, string> | null {
  const [pathPart, queryPart = ''] = (href || '').split('?');
  if (pathPart !== '/speaking') return null;
  const q = new URLSearchParams(queryPart);
  if (q.get('view') === 'profile') {
    const sub = q.get('sub');
    return {
      view: 'profile',
      ...(sub === 'overview' || sub === 'pronunciation' || sub === 'history' ? { sub } : {}),
    };
  }
  const mode = q.get('mode');
  return {
    view: 'practice',
    ...(mode === 'shadowing' || mode === 'roleplay' || mode === 'assessment' || mode === 'topic' ? { mode } : {}),
  };
}

async function performNavigation(
  targetHref: string,
  currentPathname: string,
  currentSearch: URLSearchParams | { get(name: string): string | null } | null,
  host: EchoActionHost,
): Promise<string> {
  const safe = safeEchoJarvisHref(targetHref);
  if (!safe) throw new Error('href_not_in_allowlist');

  const queryStr = currentSearch && 'toString' in currentSearch ? currentSearch.toString() : '';
  const currentFull = currentPathname + (queryStr ? `?${queryStr}` : '');
  if (currentFull !== safe) {
    pushVoiceRouteHistory(currentFull);
  }

  // Zero-RSC instant switch across Speaking Hub primary tabs (`Luyện tập` <-> `Hồ sơ luyện nói`)
  // and practice modes (`Shadowing`, `Role-play`, `Quick Check`, `Topic`) when already on `/speaking`.
  const samePageSpeakingDetail =
    currentPathname === '/speaking' ? speakingIntentDetailFromHref(safe) : null;
  if (
    samePageSpeakingDetail &&
    typeof window !== 'undefined' &&
    typeof window.dispatchEvent === 'function' &&
    typeof CustomEvent === 'function'
  ) {
    const ev = new CustomEvent('ec:speaking:intent', {
      detail: samePageSpeakingDetail,
    }) as CustomEvent & { __ecHandledBySpeakingHub?: boolean };
    window.dispatchEvent(ev);
    if (ev.__ecHandledBySpeakingHub === true) {
      return safe;
    }
  }

  // Zero-RSC instant history switch between mounted ROOT_MODULES (`(workspace)` layout)
  // and zero-remount Overview <-> Dictation switch inside `<LessonWorkspace />` (`10 §BN`).
  const canPushStateDirectly =
    typeof window !== 'undefined' &&
    window.history &&
    typeof window.history.pushState === 'function' &&
    ((isRootModuleHref(currentPathname) && isRootModuleHref(safe)) ||
      isSameListeningLessonTransition(currentPathname, safe));

  if (canPushStateDirectly && !host.routerPush) {
    window.history.pushState(null, '', safe);
    return safe;
  }

  if (canPushStateDirectly && isSameListeningLessonTransition(currentPathname, safe)) {
    window.history.pushState(null, '', safe);
    return safe;
  }

  if (host.routerPush) {
    if (
      typeof window !== 'undefined' &&
      window.history &&
      typeof window.history.pushState === 'function' &&
      isRootModuleHref(currentPathname) &&
      isRootModuleHref(safe)
    ) {
      window.history.pushState(null, '', safe);
    } else {
      await host.routerPush(safe);
    }
    return safe;
  }

  if (typeof window !== 'undefined' && window.history?.pushState) {
    window.history.pushState(null, '', safe);
  }
  return safe;
}

export interface DispatchOptions {
  host?: EchoActionHost;
  confirmedClientAction?: boolean;
  /** Alias accepted by `EchoJarvisRuntime` when confirming a pending client action. */
  confirmed?: boolean;
  hasActiveStrictSentinel?: boolean;
}

/**
 * Validates permissions and executes a single `EchoClientIntent`, recording the outcome
 * in `voiceSessionStore.recentActions`.
 */
export async function dispatchEchoIntent(
  rawIntent: unknown,
  options: DispatchOptions = {},
): Promise<DispatchOutcome> {
  const host: EchoActionHost = { ...registeredHost, ...(options.host ?? {}) };
  const pathname = resolveCurrentPathname(host);
  const searchParams = resolveCurrentSearchParams(host);
  const userId = resolveCurrentUserId(host);

  const permCtx: PermissionEvalContext = {
    pathname,
    searchParams,
    hasActiveStrictSentinel: options.hasActiveStrictSentinel,
    hasPendingConfirmation: hasActivePendingConfirmation(),
    confirmedClientAction: options.confirmedClientAction === true || options.confirmed === true,
  };

  const rawKind =
    rawIntent && typeof rawIntent === 'object' && typeof (rawIntent as { kind?: unknown }).kind === 'string'
      ? (rawIntent as { kind: string }).kind
      : 'unknown';
  setActionLifecycle('proposed', { kind: rawKind });

  const perm = evaluateIntentPermission(rawIntent, permCtx);
  const intentKind =
    perm.intent?.kind ??
    (rawKind !== 'unknown' ? (rawKind as EchoClientIntent['kind']) : 'forbidden_attempt');

  if (perm.decision === 'DENIED') {
    setActionLifecycle('failed', { kind: intentKind, detail: perm.reason });
    recordExecutedVoiceAction({ kind: intentKind, status: 'denied', detail: perm.reason });
    return {
      status: 'denied',
      detail: perm.reason,
      spokenMessage: perm.prompt,
    };
  }

  if (perm.decision === 'UNSUPPORTED') {
    setActionLifecycle('failed', { kind: intentKind, detail: perm.reason });
    recordExecutedVoiceAction({ kind: intentKind, status: 'unsupported', detail: perm.reason });
    return {
      status: 'unsupported',
      detail: perm.reason,
      spokenMessage: perm.prompt,
    };
  }

  const intent = perm.intent!;
  setActionLifecycle('validated', { kind: intent.kind });

  if (perm.decision === 'CONFIRM_REQUIRED') {
    const summaryEn = perm.prompt?.en ?? 'Please confirm this action.';
    const summaryVi = perm.prompt?.vi ?? 'Vui lòng xác nhận thao tác này.';
    setActionLifecycle('awaiting_confirmation', { kind: intent.kind, detail: perm.reason });
    if (intent.kind === 'plan_or_dna_commit') {
      recordExecutedVoiceAction({ kind: intent.kind, status: 'confirm_required', detail: perm.reason });
      return {
        status: 'confirm_required',
        detail: perm.reason,
        spokenMessage: { en: summaryEn, vi: summaryVi },
      };
    }
    const pending = setPendingClientConfirmation({
      intent,
      summaryEn,
      summaryVi,
    });
    setActiveToast({
      kind: 'confirm',
      title: summaryEn,
      confirmToken: pending.kind === 'client' ? pending.clientToken : undefined,
      confirmSource: 'client',
    });
    recordExecutedVoiceAction({ kind: intent.kind, status: 'confirm_required', detail: perm.reason });
    return {
      status: 'confirm_required',
      detail: perm.reason,
      spokenMessage: { en: summaryEn, vi: summaryVi },
    };
  }

  setActionLifecycle('authorized', { kind: intent.kind });
  setActionLifecycle('dispatched', { kind: intent.kind });
  setActionLifecycle('executing', { kind: intent.kind });

  try {
    const outcome = await executeValidatedIntent(intent, {
      host,
      pathname,
      searchParams,
      userId,
    });
    if (intent.kind === 'voice_confirm' && intent.decision === 'cancel' && outcome.status === 'done') {
      setActionLifecycle('cancelled', { kind: intent.kind, detail: outcome.detail });
    } else if (outcome.status === 'done') {
      setActionLifecycle('succeeded', { kind: intent.kind, detail: outcome.detail });
    } else if (outcome.status === 'confirm_required') {
      setActionLifecycle('awaiting_confirmation', { kind: intent.kind, detail: outcome.detail });
    } else {
      setActionLifecycle('failed', { kind: intent.kind, detail: outcome.detail });
    }
    recordExecutedVoiceAction({
      kind: intent.kind,
      status: outcome.status,
      detail: outcome.detail,
    });
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'execution_failed';
    setActionLifecycle('failed', { kind: intent.kind, detail: message });
    recordExecutedVoiceAction({
      kind: intent.kind,
      status: 'failed',
      detail: message,
    });
    return {
      status: 'failed',
      detail: message,
      spokenMessage: {
        en: 'Could not complete that action right now.',
        vi: 'Chưa thể thực hiện thao tác này lúc này.',
      },
    };
  }
}

async function executeValidatedIntent(
  intent: EchoClientIntent,
  env: {
    host: EchoActionHost;
    pathname: string;
    searchParams: URLSearchParams | { get(name: string): string | null } | null;
    userId: string;
  },
): Promise<DispatchOutcome> {
  const { host, pathname, searchParams, userId } = env;

  switch (intent.kind) {
    case 'navigate': {
      const navigatedTo = await performNavigation(intent.href, pathname, searchParams, host);
      return {
        status: 'done',
        detail: `navigated:${navigatedTo}`,
        navigatedTo,
      };
    }

    case 'history_back': {
      const previous = popVoiceRouteHistory();
      if (previous && safeEchoJarvisHref(previous)) {
        if (host.routerPush) await host.routerPush(previous);
        else if (typeof window !== 'undefined') window.history.back();
        return { status: 'done', detail: `history_back:${previous}`, navigatedTo: previous };
      }
      if (typeof window !== 'undefined' && window.history) {
        window.history.back();
      }
      return { status: 'done', detail: 'history_back:browser' };
    }

    case 'history_forward': {
      if (typeof window !== 'undefined' && window.history) {
        window.history.forward();
      }
      return { status: 'done', detail: 'history_forward:browser' };
    }

    case 'scroll': {
      if (typeof document !== 'undefined') {
        const scroller =
          document.querySelector<HTMLElement>('[data-app-scroll]') ??
          (document.scrollingElement as HTMLElement | null);
        if (scroller) {
          const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
          const step = intent.amountPx ?? Math.round((scroller.clientHeight || 640) * 0.72);
          if (intent.target === 'top') {
            scroller.scrollTo({ top: 0, behavior });
          } else if (intent.target === 'bottom') {
            scroller.scrollTo({ top: scroller.scrollHeight, behavior });
          } else if (intent.target === 'down') {
            scroller.scrollBy({ top: step, behavior });
          } else {
            scroller.scrollBy({ top: -step, behavior });
          }
        }
      }
      return { status: 'done', detail: `scroll:${intent.target}` };
    }

    case 'theme_mode': {
      const prevTheme = readAppearanceTheme();
      const wasOverBook = getVoiceSessionSnapshot().overBookReader;
      applyAppearanceTheme(intent.mode);
      if (wasOverBook && (intent.mode === 'dark' || intent.mode === 'light')) {
        dispatchWindowEvent('ec:mybooks:prefs', {
          theme: intent.mode === 'dark' ? 'dark' : 'paper',
        });
      }
      if (prevTheme !== intent.mode) {
        pushUndoAction({
          labelEn: `theme (${intent.mode})`,
          labelVi: `giao diện (${intent.mode === 'dark' ? 'tối' : intent.mode === 'light' ? 'sáng' : 'hệ thống'})`,
          undo: () => {
            applyAppearanceTheme(prevTheme);
            if (wasOverBook && (prevTheme === 'dark' || prevTheme === 'light')) {
              dispatchWindowEvent('ec:mybooks:prefs', {
                theme: prevTheme === 'dark' ? 'dark' : 'paper',
              });
            }
          },
        });
      }
      return { status: 'done', detail: `theme_mode:${intent.mode}`, canUndo: prevTheme !== intent.mode };
    }

    case 'ui_font_scale': {
      const prevScale = readUiFontScale(userId);
      const targetScale =
        intent.scale !== undefined
          ? intent.scale
          : prevScale + (intent.delta ?? 0);
      const nextScale = applyUiFontScale(userId, targetScale);
      if (nextScale !== prevScale) {
        pushUndoAction({
          labelEn: `font scale (${Math.round(nextScale * 100)}%)`,
          labelVi: `cỡ chữ (${Math.round(nextScale * 100)}%)`,
          undo: () => {
            applyUiFontScale(userId, prevScale);
          },
        });
      }
      return {
        status: 'done',
        detail: `ui_font_scale:${nextScale.toFixed(2)}`,
        canUndo: nextScale !== prevScale,
      };
    }

    case 'ui_locale': {
      if (host.setLocale) {
        host.setLocale(intent.locale);
      } else if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem('preferred_locale', intent.locale);
        } catch {
          // Storage blocked.
        }
        if (typeof document !== 'undefined') {
          document.documentElement.lang = intent.locale;
        }
      }
      dispatchWindowEvent('ec:jarvis:locale', { locale: intent.locale });
      return { status: 'done', detail: `ui_locale:${intent.locale}` };
    }

    case 'nav_layout': {
      const prevLayout = intent.layout === 'dock' ? 'sidebar' : 'dock';
      setNavigationLayout(navStorageKey(userId), intent.layout);
      pushUndoAction({
        labelEn: `navigation (${intent.layout})`,
        labelVi: `thanh điều hướng (${intent.layout === 'dock' ? 'Dock' : 'thanh bên'})`,
        undo: () => setNavigationLayout(navStorageKey(userId), prevLayout),
      });
      return { status: 'done', detail: `nav_layout:${intent.layout}`, canUndo: true };
    }

    case 'nav_visibility': {
      const prevVisibility = intent.visibility === 'autohide' ? 'pinned' : 'autohide';
      setNavigationVisibility(navStorageKey(userId), intent.visibility);
      pushUndoAction({
        labelEn: `navigation visibility (${intent.visibility})`,
        labelVi: `hiển thị thanh điều hướng`,
        undo: () => setNavigationVisibility(navStorageKey(userId), prevVisibility),
      });
      return { status: 'done', detail: `nav_visibility:${intent.visibility}`, canUndo: true };
    }

    case 'world_display': {
      setWorldDisplay(intent.world, intent.display);
      return { status: 'done', detail: `world_display:${intent.world}:${intent.display}` };
    }

    case 'open_guide': {
      openGuidePanel();
      return { status: 'done', detail: 'open_guide' };
    }

    case 'open_appearance_studio': {
      openWallpaperStudio(intent.room);
      return { status: 'done', detail: `open_appearance_studio:${intent.room ?? 'default'}` };
    }

    case 'apply_bg_preset': {
      const prevBg = resolveActiveBgConfig(userId);
      const ok = applyPresetBackground(userId, intent.presetId);
      if (!ok) {
        return { status: 'failed', detail: `unknown_preset:${intent.presetId}` };
      }
      pushUndoAction({
        labelEn: `background (${intent.presetId})`,
        labelVi: `hình nền (${intent.presetId})`,
        undo: () => {
          if (!prevBg) {
            restoreDefaultAppearance(userId);
          } else if (prevBg.source === 'custom') {
            applyCustomBackground(userId, prevBg.themeId, cloneThemeConfig(prevBg.config));
          } else {
            applyPresetBackground(userId, prevBg.themeId, cloneThemeConfig(prevBg.config));
          }
        },
      });
      return { status: 'done', detail: `apply_bg_preset:${intent.presetId}`, canUndo: true };
    }

    case 'adjust_bg_brightness': {
      const current = resolveActiveBgConfig(userId);
      const basePreset = findBackgroundPreset(DEFAULT_BACKGROUND_PRESET_ID);
      if (!current && !basePreset) {
        return { status: 'failed', detail: 'no_bg_config_available' };
      }
      const sourceConfig = current ? cloneThemeConfig(current.config) : cloneThemeConfig(basePreset!.config);
      const nextBrightness = Math.max(
        BG_BOUNDS.brightness.min,
        Math.min(BG_BOUNDS.brightness.max, Math.round(sourceConfig.color.brightness + intent.delta)),
      );
      sourceConfig.color.brightness = nextBrightness;
      if (intent.calmMotion) {
        sourceConfig.motion.effects = ['static'];
        sourceConfig.motion.performanceMode = 'eco';
      }
      if (current?.source === 'custom') {
        applyCustomBackground(userId, current.themeId, sourceConfig);
      } else {
        const targetPresetId = current?.themeId || DEFAULT_BACKGROUND_PRESET_ID;
        applyPresetBackground(userId, targetPresetId, sourceConfig);
      }
      return { status: 'done', detail: `adjust_bg_brightness:${nextBrightness}` };
    }

    case 'reset_appearance': {
      restoreDefaultAppearance(userId);
      return { status: 'done', detail: 'reset_appearance:echo_ocean' };
    }

    case 'dictionary_lookup': {
      dispatchWindowEvent('ec:dictionary:lookup', { word: intent.word });
      return { status: 'done', detail: `dictionary_lookup:${intent.word || 'open'}` };
    }

    case 'music_control': {
      const engine = host.getMusicEngine?.() ?? null;
      let handledByHost = false;
      if (intent.command === 'pause') {
        if (engine) {
          engine.pause();
          handledByHost = true;
        }
        dispatchWindowEvent('ec:music-pause');
      } else if (engine) {
        handledByHost = true;
        if (intent.command === 'play') {
          await engine.play();
        } else if (intent.command === 'toggle') {
          if (engine.snapshot().playing) engine.pause();
          else await engine.play();
        } else if (intent.command === 'next') {
          await engine.next(1);
        } else if (intent.command === 'prev') {
          await engine.next(-1);
        } else if (intent.command === 'volume_up') {
          const nextVol = Math.min(1, Math.round((engine.snapshot().volume + 0.15) * 100) / 100);
          engine.volume(nextVol);
        } else if (intent.command === 'volume_down') {
          const nextVol = Math.max(0, Math.round((engine.snapshot().volume - 0.15) * 100) / 100);
          engine.volume(nextVol);
        } else if (intent.command === 'mute') {
          engine.volume(0);
        } else if (intent.command === 'unmute') {
          const curVol = engine.snapshot().volume;
          engine.volume(curVol > 0.02 ? curVol : 0.7);
        } else if (intent.command === 'shuffle') {
          engine.shuffle();
        }
      }
      dispatchWindowEvent('ec:jarvis:music', { command: intent.command, handledByHost });
      return { status: 'done', detail: `music_control:${intent.command}` };
    }

    case 'reading_control': {
      let navigatedTo: string | undefined;
      if (
        pathname !== '/reading' &&
        (intent.tab !== undefined ||
          intent.filterLevel !== undefined ||
          intent.filterTopic !== undefined ||
          intent.searchQuery !== undefined)
      ) {
        const targetHref =
          intent.tab && intent.tab !== 'library' ? `/reading?section=${intent.tab}` : '/reading';
        navigatedTo = await performNavigation(targetHref, pathname, searchParams, host);
      }
      let prevFontSize: number | null = null;
      let prevWidth: string | null = null;
      if (intent.fontDelta !== undefined || intent.fontSize !== undefined || intent.width !== undefined) {
        try {
          if (typeof window !== 'undefined') {
            const raw = JSON.parse(window.localStorage.getItem('reading.appearance.v1') || '{}') || {};
            const curSize = Number.isFinite(raw.fontSize) ? Number(raw.fontSize) : 18;
            prevFontSize = curSize;
            prevWidth = typeof raw.readingWidth === 'string' ? raw.readingWidth : 'comfortable';
            const nextSize =
              intent.fontSize !== undefined
                ? Math.max(15, Math.min(28, intent.fontSize))
                : intent.fontDelta !== undefined
                  ? Math.max(15, Math.min(28, curSize + intent.fontDelta))
                  : curSize;
            const nextAppearance = {
              fontFamily: 'Georgia',
              lineHeight: 1.75,
              letterSpacing: 0,
              readingWidth: 'comfortable',
              ...raw,
              fontSize: nextSize,
              ...(intent.width ? { readingWidth: intent.width } : {}),
            };
            window.localStorage.setItem('reading.appearance.v1', JSON.stringify(nextAppearance));
          }
        } catch {
          // Storage blocked: live event still updates mounted InteractiveReader.
        }
      }
      if (intent.tab && typeof window !== 'undefined') {
        try {
          window.localStorage.setItem('readingActiveTab', intent.tab);
        } catch {
          // Ignore storage error.
        }
      }
      dispatchWindowEvent('ec:reading:intent', {
        tab: intent.tab,
        filterLevel: intent.filterLevel,
        filterTopic: intent.filterTopic,
        searchQuery: intent.searchQuery,
        fontDelta: intent.fontDelta,
        fontSize: intent.fontSize,
        width: intent.width,
      });
      if (intent.fontDelta !== undefined || intent.fontSize !== undefined) {
        dispatchWindowEvent('ec:mybooks:prefs', {
          fontDelta: intent.fontDelta,
          fontSize: intent.fontSize,
        });
      }
      if (prevFontSize !== null && (intent.fontDelta !== undefined || intent.fontSize !== undefined || intent.width !== undefined)) {
        const restoreSize = prevFontSize;
        const restoreWidth = prevWidth;
        pushUndoAction({
          labelEn: 'reading typography',
          labelVi: 'cỡ chữ và khổ đọc',
          undo: () => {
            try {
              if (typeof window !== 'undefined') {
                const raw = JSON.parse(window.localStorage.getItem('reading.appearance.v1') || '{}') || {};
                window.localStorage.setItem(
                  'reading.appearance.v1',
                  JSON.stringify({ ...raw, fontSize: restoreSize, ...(restoreWidth ? { readingWidth: restoreWidth } : {}) }),
                );
              }
            } catch {
              // Ignore storage error.
            }
            dispatchWindowEvent('ec:reading:intent', {
              fontSize: restoreSize,
              ...(restoreWidth ? { width: restoreWidth } : {}),
            });
            dispatchWindowEvent('ec:mybooks:prefs', { fontSize: restoreSize });
          },
        });
      }
      return {
        status: 'done',
        detail: `reading_control:${intent.tab ?? intent.filterLevel ?? intent.width ?? 'typography'}`,
        ...(navigatedTo ? { navigatedTo } : {}),
      };
    }

    case 'mybooks_open_last': {
      if (!userId) {
        return {
          status: 'failed',
          detail: 'unauthenticated_mybooks',
          spokenMessage: {
            en: 'Please sign in to open books from your personal shelf.',
            vi: 'Vui lòng đăng nhập để mở sách trong Tủ sách của bạn.',
          },
        };
      }
      const openShelf = host.openBookStore ?? ((uid: string) => BookStore.open(uid));
      const store = await openShelf(userId);
      let chosen: { id: string; title: string; progressPct?: number } | null = null;
      try {
        const books = await store.listBooks();
        const q = intent.query?.trim().toLowerCase() ?? '';
        const matching = q
          ? books.filter(
              (b) =>
                b.title.toLowerCase().includes(q) ||
                (b.author ? b.author.toLowerCase().includes(q) : false),
            )
          : books;
        const sorted = [...matching].sort(
          (a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt),
        );
        if (sorted[0]) {
          let progressPct: number | undefined;
          try {
            const pos = await store.getPosition?.(sorted[0].id);
            if (pos && typeof pos.progress === 'number' && Number.isFinite(pos.progress) && pos.progress > 0) {
              progressPct = Math.max(1, Math.min(100, Math.round(pos.progress <= 1 ? pos.progress * 100 : pos.progress)));
            }
          } catch {
            // Optional position lookup failure is non-fatal.
          }
          chosen = { id: sorted[0].id, title: sorted[0].title, progressPct };
        }
      } finally {
        store.close();
      }

      let navigatedTo: string | undefined;
      if (pathname !== '/reading') {
        navigatedTo = await performNavigation('/reading?section=mybooks', pathname, searchParams, host);
      }
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('readingActiveTab', 'mybooks');
        }
      } catch {
        // Ignore storage error.
      }
      dispatchWindowEvent('ec:reading:intent', { tab: 'mybooks' });

      if (!chosen) {
        return {
          status: 'done',
          detail: 'mybooks_shelf_empty',
          navigatedTo,
          escalateReason: 'mybooks_empty',
          spokenMessage: {
            en: 'Opened My Books. Your local bookshelf does not have any saved books yet.',
            vi: 'Đã mở Tủ sách của bạn. Hiện chưa có cuốn sách nào được lưu trên thiết bị này.',
          },
        };
      }

      if (typeof window !== 'undefined') {
        (window as unknown as { __ecPendingMyBookOpenId?: string }).__ecPendingMyBookOpenId = chosen.id;
      }
      dispatchWindowEvent('ec:mybooks:open', { bookId: chosen.id, title: chosen.title });
      const progressEn = chosen.progressPct ? `, continuing at ${chosen.progressPct}%` : '';
      const progressVi = chosen.progressPct ? `, tiếp tục từ ${chosen.progressPct}%` : '';
      return {
        status: 'done',
        detail: `mybooks_open:${chosen.id}`,
        navigatedTo,
        spokenMessage: {
          en: `Opening "${chosen.title}"${progressEn}.`,
          vi: `Đang mở sách "${chosen.title}"${progressVi}.`,
        },
      };
    }

    case 'mybooks_reader': {
      dispatchWindowEvent('ec:mybooks:prefs', {
        theme: intent.theme,
        fontDelta: intent.fontDelta,
        fontSize: intent.fontSize,
        page: intent.page,
      });
      return {
        status: 'done',
        detail: `mybooks_reader:${intent.theme ?? intent.page ?? 'font'}`,
      };
    }

    case 'listening_player': {
      if (intent.command === 'switch_dictation' || intent.command === 'switch_overview') {
        const match = /^\/listening\/(\d{1,12})(?:\/practice)?$/.exec(pathname);
        if (match && typeof window !== 'undefined' && window.history?.pushState) {
          const nextUrl =
            intent.command === 'switch_dictation'
              ? `/listening/${match[1]}/practice`
              : `/listening/${match[1]}`;
          window.history.pushState(null, '', nextUrl);
        }
      }
      dispatchWindowEvent('ec:listening:command', {
        command: intent.command,
        speed: intent.speed,
      });
      return {
        status: 'done',
        detail: `listening_player:${intent.command}${intent.speed ? `:${intent.speed}` : ''}`,
      };
    }

    case 'speaking_control': {
      let navigatedTo: string | undefined;
      if (intent.scenarioId !== undefined) {
        const sub = intent.mode === 'shadowing' ? 'shadowing' : 'roleplay';
        navigatedTo = await performNavigation(`/speaking/${sub}/${intent.scenarioId}`, pathname, searchParams, host);
      } else if (pathname !== '/speaking' && !pathname.startsWith('/speaking/')) {
        const targetHref =
          intent.view === 'profile'
            ? intent.sub && intent.sub !== 'overview'
              ? `/speaking?view=profile&sub=${intent.sub}`
              : '/speaking?view=profile'
            : intent.mode
              ? `/speaking?mode=${intent.mode}`
              : '/speaking';
        navigatedTo = await performNavigation(targetHref, pathname, searchParams, host);
      }
      dispatchWindowEvent('ec:speaking:intent', {
        view: intent.view,
        sub: intent.sub,
        mode: intent.mode,
        cefr: intent.cefr,
        category: intent.category,
        query: intent.query,
        scenarioId: intent.scenarioId,
      });
      return {
        status: 'done',
        detail: `speaking_control:${intent.scenarioId ?? intent.sub ?? intent.view ?? intent.mode ?? intent.cefr ?? 'filter'}`,
        ...(navigatedTo ? { navigatedTo } : {}),
      };
    }

    case 'flashcard_control': {
      let navigatedTo: string | undefined;
      if (pathname !== '/flashcards') {
        const targetHref =
          intent.mode === 'due' || intent.mode === 'learned'
            ? `/flashcards?review=${intent.mode}`
            : intent.deckId
              ? `/flashcards?deck=${intent.deckId}`
              : '/flashcards';
        navigatedTo = await performNavigation(targetHref, pathname, searchParams, host);
      }
      const detail = {
        mode: intent.mode,
        deckId: intent.deckId,
        searchQuery: intent.searchQuery,
      };
      dispatchWindowEvent('ec:flashcard:intent', detail);
      dispatchWindowEvent('ec:flashcards:intent', detail);
      return {
        status: 'done',
        detail: `flashcard_control:${intent.mode ?? intent.deckId ?? 'search'}`,
        ...(navigatedTo ? { navigatedTo } : {}),
      };
    }

    case 'writing_control': {
      let navigatedTo: string | undefined;
      const baseRoom = intent.room ?? (intent.mode ? 'translation' : undefined);
      let targetHref = baseRoom ? `/writing?w=${baseRoom}` : '/writing';
      if (baseRoom === 'translation' && intent.mode?.toUpperCase() === 'PARAGRAPH') {
        targetHref = '/writing?w=translation&mode=PARAGRAPH';
      } else if (
        baseRoom === 'sentence-lab' &&
        (intent.mode === 'mistakes' || intent.mode === 'check')
      ) {
        targetHref = `/writing?w=sentence-lab&lab=${intent.mode}`;
      }
      if (pathname !== '/writing') {
        navigatedTo = await performNavigation(targetHref, pathname, searchParams, host);
      }
      dispatchWindowEvent('ec:writing:intent', {
        room: intent.room,
        mode: intent.mode,
      });
      return {
        status: 'done',
        detail: `writing_control:${intent.room ?? intent.mode ?? 'room'}`,
        ...(navigatedTo ? { navigatedTo } : {}),
      };
    }

    case 'undo_last_action': {
      const undone = await popAndRunUndoAction();
      if (!undone.ok) {
        return {
          status: 'failed',
          detail: 'undo_stack_empty',
          spokenMessage: {
            en: 'Nothing to undo yet.',
            vi: 'Chưa có thao tác nào để hoàn tác.',
          },
        };
      }
      return {
        status: 'done',
        detail: `undo:${undone.labelEn ?? 'last'}`,
        spokenMessage: {
          en: `Undid ${undone.labelEn || 'the last change'}.`,
          vi: `Đã hoàn tác ${undone.labelVi || 'thao tác vừa rồi'}.`,
        },
      };
    }

    case 'voice_confirm': {
      const pending = consumePendingConfirmation();
      if (!pending) {
        return { status: 'denied', detail: 'no_pending_confirmation' };
      }
      if (intent.decision === 'cancel') {
        if (pending.kind === 'server') {
          const decide =
            host.decideServerConfirmation ??
            ((token: string, d: 'CONFIRM' | 'CANCEL') => echoIntelligenceApi.decide(token, d));
          await decide(pending.token, 'CANCEL').catch(() => undefined);
        }
        return {
          status: 'done',
          detail: 'confirmation_cancelled',
          spokenMessage: {
            en: 'Cancelled that action.',
            vi: 'Đã hủy thao tác đang chờ.',
          },
        };
      }

      if (pending.kind === 'server') {
        const decide =
          host.decideServerConfirmation ??
          ((token: string, d: 'CONFIRM' | 'CANCEL') => echoIntelligenceApi.decide(token, d));
        const res = await decide(pending.token, 'CONFIRM');
        return {
          status: 'done',
          detail: `server_confirmed:${res.status}`,
          spokenMessage: {
            en: 'Confirmed and applied.',
            vi: 'Đã xác nhận và áp dụng thay đổi.',
          },
        };
      }

      return dispatchEchoIntent(pending.intent, {
        host,
        confirmedClientAction: true,
      });
    }

    case 'voice_control': {
      if (intent.command === 'sleep') {
        setVoiceEntityState(getVoiceSessionSnapshot().handsFreeEnabled ? 'dormant' : 'sleeping');
      } else if (intent.command === 'mute') {
        setVoiceMuted(true);
      } else if (intent.command === 'unmute') {
        setVoiceMuted(false);
      } else if (intent.command === 'compact' || intent.command === 'ambient') {
        setVoiceUiMode('ambient');
      } else if (intent.command === 'expand') {
        setVoiceUiMode('chat');
      } else if (intent.command === 'workspace') {
        setVoiceUiMode('immersive');
      } else if (intent.command === 'captions_on') {
        setCaptionsEnabled(true);
      } else if (intent.command === 'captions_off') {
        setCaptionsEnabled(false);
      } else if (intent.command === 'captions_toggle') {
        setCaptionsEnabled(!getVoiceSessionSnapshot().captionsEnabled);
      }
      host.onVoiceUiCommand?.(intent.command);
      dispatchWindowEvent('ec:jarvis:voice-control', { command: intent.command });
      return { status: 'done', detail: `voice_control:${intent.command}` };
    }

    case 'request_logout': {
      setHandsFreeEnabled(false);
      const signOutFn = host.signOut ?? ((cb?: string) => logout(cb ?? '/'));
      await signOutFn('/');
      return {
        status: 'done',
        detail: 'signed_out',
        spokenMessage: {
          en: 'Signing you out now.',
          vi: 'Đang đăng xuất tài khoản.',
        },
      };
    }

    case 'delete_resource': {
      dispatchWindowEvent('ec:jarvis:delete-confirmed', {
        resourceType: intent.resourceType,
        resourceId: intent.resourceId,
      });
      return {
        status: 'done',
        detail: `delete_resource:${intent.resourceType}`,
      };
    }

    case 'plan_or_dna_commit': {
      const decide =
        host.decideServerConfirmation ??
        ((token: string, d: 'CONFIRM' | 'CANCEL') => echoIntelligenceApi.decide(token, d));
      const res = await decide(intent.token, 'CONFIRM');
      return {
        status: 'done',
        detail: `plan_or_dna_commit:${res.status}`,
      };
    }

    case 'forbidden_attempt':
      return { status: 'denied', detail: intent.reason };

    case 'unsupported_external':
      return { status: 'unsupported', detail: intent.detail };
  }
}
