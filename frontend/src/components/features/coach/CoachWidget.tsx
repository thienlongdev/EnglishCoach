"use client";

import React, { useState, useRef, useEffect, useCallback, useSyncExternalStore } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Square, X, History, Plus, Trash2, Maximize2, Minimize2, RotateCcw, Grip, ArrowLeftRight, BellOff, Bell, BookOpen, Compass, Target, Mic, LayoutPanelLeft, MoreHorizontal, ArrowUp, Check } from 'lucide-react';
import { apiClient, getBaseUrl } from '@/services/api-client';
import { authEpoch, authEnding, authSignal } from '@/lib/auth-lifecycle';
import { authFetch } from '@/lib/api-session';
import { echoCoachApi, type EchoCoachSessionDto } from '@/services/echoCoachApi';
import { useLanguage } from '@/context/LanguageContext';
import { usePremiumEntitlement } from '@/hooks/usePremiumEntitlement';
import { dailyAllowance, ECHO_LIMITS } from '@/services/premiumApi';
import { sessionStorageKey, safeEchoHref, isWorkRoute, sanitizeEchoStatusCopy } from './echo-window';
import { sanitizeCards, sanitizeActions, mergeCards, mergeActions, type EchoCardData, type EchoActionData } from './EchoCards';
import { EchoVoice } from './EchoVoice';
import { EchoMemoryPanel, EchoSuggestions, readProactive, writeProactive } from './EchoAssist';
import { pageContextFor, recentSelection, clearRecentSelection, watchPageSelection } from '@/lib/echo/pageContext';
import { getEchoWorkspaceContextSnapshot, utteranceReferencesBookOrPassage } from '@/lib/echo/contextBridge';
import {
  type EchoClientIntent,
  clearActiveSalientResources,
  compileEchoFastPath,
  detectUtteranceLanguage,
  dispatchEchoIntent,
  echoVoiceSessionStore,
  executeIntentDag,
  extractSalientResources,
  getSessionSalientResources,
  promoteActiveSalientResourcesToSession,
  pushVoiceRouteHistory,
  registerEchoActionHost,
  safeEchoJarvisHref,
  setPendingServerConfirmation,
  setSessionSalientResources,
  setVoiceStage,
  setVoiceUiMode,
} from '@/lib/echo-jarvis/intents';
import { getEchoJarvisRuntime, getEchoJarvisRuntimeInstance } from '@/lib/echo-jarvis/runtime/echoJarvisRuntime';
import { useEchoWindow } from './useEchoWindow';
import { useEchoDiscovery } from './useEchoDiscovery';
import { useEchoCompanion } from './useEchoCompanion';
import { panelAnchor } from './echo-companion';
import { echoSrc } from '@/lib/brand/echoCharacters';
import { EchoMessage } from './EchoMessage';
import { EchoWorkspaceRail } from './EchoWorkspaceRail';
import { EchoOrb } from './EchoOrb';
import { EchoCompanionAnchor } from './EchoCompanionAnchor';
import { EchoImmersiveWorkspace } from './EchoImmersiveWorkspace';
import { guideBusy, guideSpeaking, subscribeGuide } from '@/lib/guide/store';
import './echo.css';

interface Message { role: 'user' | 'assistant'; content: string; cards?: EchoCardData[]; actions?: EchoActionData[] }
const newTurnId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
type EchoVoiceSpeakerId = 'us_female' | 'us_male' | 'uk_female' | 'uk_male';
const VALID_SPEAKERS = new Set<EchoVoiceSpeakerId>(['us_female', 'us_male', 'uk_female', 'uk_male']);

function readStoredVoiceId(): EchoVoiceSpeakerId {
  if (typeof window === 'undefined') return 'us_female';
  try {
    const raw = window.localStorage.getItem('echo_voice_speaker') as EchoVoiceSpeakerId | null;
    return raw && VALID_SPEAKERS.has(raw) ? raw : 'us_female';
  } catch {
    return 'us_female';
  }
}

export function CoachWidget() {
  const pathname = typeof usePathname === 'function' ? (usePathname() || '') : '';
  const searchParams = useSearchParams();
  const isGarden = pathname === '/games/echo-garden' || pathname.startsWith('/games/echo-garden/') || pathname === '/games/echo-quiz-rush' || pathname.startsWith('/games/echo-quiz-rush/') || pathname === '/games/echo-spelling' || pathname.startsWith('/games/echo-spelling/') || pathname === '/speaking/arena' || pathname.startsWith('/speaking/arena/') || pathname.startsWith('/study-space') || (pathname.startsWith('/exams/') && pathname.includes('/attempts/')) || pathname.startsWith('/ielts-cbt-preview') || pathname.startsWith('/toeic-iig-preview') || ((pathname === '/learning-path' || pathname.startsWith('/learning-path/')) && searchParams?.get('view') === 'odyssey');
  const { data: session, status } = useSession();
  const { locale, setLocale } = useLanguage();
  const router = useRouter();
  const tab = searchParams?.get('tab') ?? null;
  const vi = locale === 'vi';
  const greeting = useCallback((): Message => ({ role: 'assistant', content: vi
    ? 'Chào bạn, mình là Echo. Hôm nay mình cùng học tiếng Anh nhé!'
    : 'Hi, I’m Echo. Let’s learn some English together!' }), [vi]);
  const scope = status === 'authenticated' ? String((session?.user as { id?: string })?.id ?? '') : '';
  const isAuth = Boolean(scope) && !authEnding();
  const voiceSnap = useSyncExternalStore(
    echoVoiceSessionStore.subscribe,
    echoVoiceSessionStore.getSnapshot,
    echoVoiceSessionStore.getServerSnapshot,
  );
  const windowState = useEchoWindow();
  const { mode, setMode, geometry, mobile, interacting } = windowState;
  const isOpen = mode !== 'collapsed';
  const discovery = useEchoDiscovery(scope, isAuth, isOpen, vi);
  // While Echo Guide runs, the guide's Echo is this Echo: the companion rests and says nothing, and keeps its place (10 §BL).
  const guiding = useSyncExternalStore(subscribeGuide, guideBusy, () => false);
  const guideTalks = useSyncExternalStore(subscribeGuide, guideSpeaking, () => false);
  const isSuspended = isGarden || voiceSnap.strictSentinelLocked;
  const companion = useEchoCompanion(pathname, tab, vi, isOpen || guiding);
  const [closing, setClosing] = useState<'compact' | 'expanded' | null>(null);
  const closingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [speechLater, setSpeechLater] = useState(false);
  const shownMode = isOpen ? mode : closing;
  const [messages, setMessages] = useState<Message[]>([greeting()]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unread, setUnread] = useState(false);
  const [responding, setResponding] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<EchoCoachSessionDto[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  // Echo Intelligence 7.0: live status while tools run, learner-owned memory view, opt-in proactive suggestions
  const [statusText, setStatusText] = useState('');
  const [draft, setDraft] = useState('');
  const [spokenReply, setSpokenReply] = useState<{key: string; text: string; complete: boolean} | null>(null);
  const pinned = useRef(true);
  const activeStream = useRef<{ id: string; owner: string } | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [proactive, setProactive] = useState(false);
  const [selectionShown, setSelectionShown] = useState('');
  const bookExcerpt = useRef<{text:string; href:string} | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // free accounts: the server's daily Echo Coach allowance (Premium is not limited by it)
  const { entitlement, isPremium, mutateEntitlement } = usePremiumEntitlement({ includePlans: false });
  // the server's Echo allowance: free 10 a day; Premium its own daily allowance (plus a monthly one, told on refusal)
  const allowance = isAuth ? dailyAllowance(entitlement, 'COACH') : undefined;
  const [dailyRefused, setDailyRefused] = useState(false);
  const [limitKind, setLimitKind] = useState<string>('COACH_DAILY');
  const exhausted = Boolean(allowance && allowance.remaining <= 0) || dailyRefused;
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const generation = useRef(0);
  const currentRoute = useRef('');
  currentRoute.current = pathname + '?' + (searchParams?.toString() ?? '');
  const pathnameRef = useRef(pathname); pathnameRef.current = pathname;
  const searchParamsRef = useRef(searchParams); searchParamsRef.current = searchParams;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const openRef = useRef(isOpen); openRef.current = isOpen;
  const messagesRef = useRef(messages); messagesRef.current = messages;
  const activeIdRef = useRef<number | null>(activeId); activeIdRef.current = activeId;
  const confirmBannerIdRef = useRef(`echo-panel-confirm-${Math.random().toString(36).slice(2, 8)}`);
  const operation = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const lastMode = useRef<'compact' | 'expanded'>('compact');

  const capture = () => {
    const account = scope, epoch = authEpoch(), version = generation.current;
    return () => scopeRef.current === account && generation.current === version && epoch === authEpoch() && !authEnding();
  };
  const cancel = () => {
    generation.current++;
    const stream = activeStream.current;
    activeStream.current = null;
    operation.current?.abort();
    if (stream && stream.owner === scopeRef.current && !authEnding()) {
      void authFetch(`${getBaseUrl()}/ai/chat/stream/${stream.id}`, { method: 'DELETE' }).catch(() => {});
    }
    busy.current = false;
    setDraft(''); setSpokenReply(null);
  };
  const exitVoicePresentationSilently = useCallback(() => {
    const snap = echoVoiceSessionStore.getSnapshot();
    const hasActiveVoice = !['disabled', 'dormant', 'sleeping'].includes(snap.entityState);
    const hasVoiceError = Boolean(snap.lastError) || snap.entityState === 'error' || snap.activeToast?.kind === 'error';
    if (!snap.voiceStage && !hasActiveVoice && !hasVoiceError) return;
    const rt = getEchoJarvisRuntime() as (ReturnType<typeof getEchoJarvisRuntime> & { dismissError?: () => void }) | null;
    if (hasVoiceError) {
      rt?.dismissError?.();
      (echoVoiceSessionStore as typeof echoVoiceSessionStore & { clearVoiceError?: () => void }).clearVoiceError?.();
    }
    if (snap.voiceStage) {
      setVoiceStage(false);
    }
    if (snap.voiceStage || hasActiveVoice) {
      rt?.enterSleep?.({ silent: true });
    }
  }, []);
  const collapse = useCallback((restoreFocus = false) => {
    setImmersive(false);
    setVoiceUiMode('ambient');
    const snap = echoVoiceSessionStore.getSnapshot();
    if (!snap.handsFreeEnabled && (snap.lastError || snap.entityState === 'error' || snap.activeToast?.kind === 'error')) {
      const rt = getEchoJarvisRuntime() as (ReturnType<typeof getEchoJarvisRuntime> & { dismissError?: () => void }) | null;
      rt?.dismissError?.();
      (echoVoiceSessionStore as typeof echoVoiceSessionStore & { clearVoiceError?: () => void }).clearVoiceError?.();
    }
    if (mode !== 'collapsed') { lastMode.current = mode; setClosing(mode); }
    setMode('collapsed');
    if (closingTimer.current) clearTimeout(closingTimer.current);
    closingTimer.current = setTimeout(() => setClosing(null), 170);
    companion.syncPosition?.();
    if (restoreFocus) companion.refs.root.current?.focus?.({ preventScroll: true });
  }, [mode, setMode, companion]);
  const reopen = useCallback(() => {
    if (closingTimer.current) clearTimeout(closingTimer.current);
    setClosing(null);
    setMode(lastMode.current);
    setVoiceUiMode('chat');
    // Opening the CHAT is an explicit choice of the typed conversation: end the voice presentation and its listening
    // (never leave a hidden open microphone behind the chat log, even if voice started from Ambient/Workspace).
    exitVoicePresentationSilently();
  }, [setMode, exitVoicePresentationSilently]);
  // Explicit voice entry (the companion's microphone, "Nói với Echo"): the panel opens ALREADY in the voice stage, in the
  // same render as the panel itself, so no chat frame is ever painted first (incident 2026-11-25).
  const openVoice = useCallback(() => {
    setHistoryOpen(false);
    setToolsOpen(false);
    setVoiceStage(true);
    if (!openRef.current) {
      if (closingTimer.current) clearTimeout(closingTimer.current);
      setClosing(null);
      setMode(lastMode.current);
      setVoiceUiMode('chat');
    }
    void getEchoJarvisRuntime()?.startActiveVoiceTurn?.();
  }, [setMode]);
  const openImmersiveWorkspace = useCallback(() => {
    setHistoryOpen(false);
    setToolsOpen(false);
    setImmersive(false);
    setVoiceUiMode('immersive');
  }, []);
  const interruptTurn = useCallback(() => {
    cancel(); setLoading(false); setStatusText(''); void mutateEntitlement();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutateEntitlement]);

  // Track route stack for Plane-A "Go back" / "Quay lại"
  useEffect(() => {
    const q = searchParams?.toString() ?? '';
    pushVoiceRouteHistory(pathname + (q ? `?${q}` : ''));
  }, [pathname, searchParams]);

  // Single module-scoped EchoJarvisRuntime configuration & host bindings (NEVER restarted on UI toggle/route!)
  useEffect(() => {
    const persistBridgeTurn = async (
      userText: string,
      assistantText: string,
      explicitSessionId?: number | null,
    ) => {
      const ownerScope = scopeRef.current;
      if (!ownerScope || authEnding() || !userText || !assistantText) return;
      try {
        let sid = explicitSessionId ?? activeIdRef.current;
        if (!sid) {
          const created = await echoCoachApi.createSession(userText.slice(0, 80));
          if (scopeRef.current !== ownerScope || authEnding()) return;
          sid = created.id;
          activeIdRef.current = sid;
          setActiveId(sid);
          promoteActiveSalientResourcesToSession?.(sid, ownerScope);
          getEchoJarvisRuntime()?.setEchoSessionId?.(sid);
          try { localStorage.setItem(sessionStorageKey(ownerScope), String(sid)); } catch {}
        }
        await echoCoachApi.saveMessagePair(sid, userText, assistantText);
      } catch {
        // Non-fatal persistence failure: in-memory conversation remains intact.
      }
    };

    const unregHost = registerEchoActionHost({
      getUserId: () => scopeRef.current,
      getPathname: () =>
        typeof window !== 'undefined' && window.location?.pathname
          ? window.location.pathname
          : pathnameRef.current || '/',
      getSearchParams: () =>
        typeof window !== 'undefined' && typeof window.location?.search === 'string'
          ? new URLSearchParams(window.location.search)
          : searchParamsRef.current,
      routerPush: (href) => { router.push(href); },
      setLocale: setLocale ? (nextLocale) => setLocale(nextLocale) : undefined,
      onVoiceUiCommand: (command) => {
        if (command === 'compact' || command === 'ambient') collapse();
        else if (command === 'expand') {
          if (closingTimer.current) clearTimeout(closingTimer.current);
          setClosing(null);
          lastMode.current = 'expanded';
          setMode('expanded');
          setVoiceUiMode('chat');
        }
        else if (command === 'workspace') openImmersiveWorkspace();
      },
    });
    const rtInstance = getEchoJarvisRuntimeInstance?.();
    const unbindCtx = rtInstance?.bindWorkspaceContextProvider?.((opts) =>
      getEchoWorkspaceContextSnapshot({
        pathname:
          typeof window !== 'undefined' && window.location?.pathname
            ? window.location.pathname
            : pathnameRef.current || '/',
        search:
          typeof window !== 'undefined' && typeof window.location?.search === 'string'
            ? new URLSearchParams(window.location.search)
            : searchParamsRef.current,
        includeOnDemandBook: opts?.includeOnDemandBook === true,
      }) as Record<string, unknown> | null,
    );
    type RuntimeChatBridgeArg = Parameters<NonNullable<ReturnType<typeof getEchoJarvisRuntime>>['bindChatBridge']>[0] & {
      onTruncateTurn?: (
        userText: string,
        heardAssistantText: string,
        opts?: { sessionId?: number | null; turnSeq?: number },
      ) => void;
    };
    const chatBridge: RuntimeChatBridgeArg = {
      getHistory: () => {
        const current = messagesRef.current;
        if (!current.some(m => m.role === 'user')) return [];
        const startIdx = current.length > 0 && current[0]?.role === 'assistant' ? 1 : 0;
        return current.slice(startIdx).slice(-12).map(m => ({ role: m.role, content: m.content }));
      },
      onSyncSessionId: (srvSessionId) => {
        if (!scopeRef.current || authEnding()) return;
        activeIdRef.current = srvSessionId;
        setActiveId(srvSessionId);
        promoteActiveSalientResourcesToSession?.(srvSessionId, scopeRef.current);
        try { localStorage.setItem(sessionStorageKey(scopeRef.current), String(srvSessionId)); } catch {}
      },
      onAppendTurn: (userText, assistantText, cards, actions, opts) => {
        const cleanCards = sanitizeCards(cards);
        const cleanActions = sanitizeActions(actions);
        const extracted = extractSalientResources?.(cleanCards, cleanActions);
        if (extracted && extracted.length > 0) {
          setSessionSalientResources?.(extracted, opts?.sessionId ?? activeIdRef.current, scopeRef.current);
        }
        const appendedPair = [
          { role: 'user' as const, content: userText },
          {
            role: 'assistant' as const,
            content: assistantText,
            cards: cleanCards,
            actions: cleanActions,
          },
        ];
        const nextMsgs = [...messagesRef.current, ...appendedPair];
        messagesRef.current = nextMsgs;
        setMessages(nextMsgs);
        if (!openRef.current) setUnread(true);
        if (opts?.persistToServer) {
          void persistBridgeTurn(userText, assistantText, opts.sessionId);
        }
      },
      onTruncateTurn: (userText, heardAssistantText, opts) => {
        if (!scopeRef.current || authEnding()) return;
        if (typeof opts?.sessionId === 'number' && Number.isSafeInteger(opts.sessionId) && opts.sessionId > 0) {
          activeIdRef.current = opts.sessionId;
          setActiveId(opts.sessionId);
          promoteActiveSalientResourcesToSession?.(opts.sessionId, scopeRef.current);
          try { localStorage.setItem(sessionStorageKey(scopeRef.current), String(opts.sessionId)); } catch {}
        }
        const cleanUser = (userText || '').trim();
        const heard = (heardAssistantText || '').trim();
        const current = messagesRef.current;
        const minUserIdx = Math.max(0, current.length - 4);
        let matchUserIdx = -1;
        for (let i = current.length - 2; i >= minUserIdx; i--) {
          if (
            current[i]?.role === 'user' &&
            current[i + 1]?.role === 'assistant' &&
            (!cleanUser || current[i].content.trim() === cleanUser)
          ) {
            matchUserIdx = i;
            break;
          }
        }
        if (matchUserIdx >= 0) {
          const nextMsgs = [...current];
          if (heard) {
            nextMsgs[matchUserIdx + 1] = {
              ...nextMsgs[matchUserIdx + 1],
              content: heard,
            };
          } else {
            nextMsgs.splice(matchUserIdx, 2);
          }
          const safeMsgs = nextMsgs.length > 0 ? nextMsgs : [greeting()];
          messagesRef.current = safeMsgs;
          setMessages(safeMsgs);
          return;
        }
        if (cleanUser && heard) {
          const nextMsgs = [
            ...current,
            { role: 'user' as const, content: cleanUser },
            { role: 'assistant' as const, content: heard },
          ];
          messagesRef.current = nextMsgs;
          setMessages(nextMsgs);
          if (!openRef.current) setUnread(true);
        }
      },
      onInterruptChatTurn: interruptTurn,
    };
    const unbindBridge = getEchoJarvisRuntime()?.bindChatBridge?.(chatBridge);
    return () => {
      unregHost?.();
      unbindCtx?.();
      unbindBridge?.();
    };
  }, [router, setLocale, collapse, reopen, openImmersiveWorkspace, interruptTurn, greeting, setMode]);

  useEffect(() => {
    if (!isAuth || !scope) return;
    getEchoJarvisRuntime()?.configure?.({
      userId: scope,
      voiceId: readStoredVoiceId(),
      locale: vi ? 'vi' : 'en',
      sessionId: activeId,
      exhausted,
    });
  }, [isAuth, scope, vi, activeId, exhausted]);

  // Silent reload restoration of opt-in Hands-Free wake (strictly ZERO spoken greeting on page reload!)
  const restoredHandsFreeScope = useRef('');
  useEffect(() => {
    if (!isAuth || !scope || restoredHandsFreeScope.current === scope) return;
    restoredHandsFreeScope.current = scope;
    try {
      if (window.localStorage.getItem(`ec_jarvis_handsfree:u${scope}`) === '1') {
        void getEchoJarvisRuntime()?.restoreHandsFreeSilently?.(scope);
      }
    } catch {
      // Storage unavailable
    }
  }, [isAuth, scope]);

  // Handle explicit user Hands-Free toggle event (increments session epoch -> <= 1 greeting)
  useEffect(() => {
    if (!isAuth || typeof window === 'undefined') return;
    const onToggle = (ev: Event) => {
      const detail = (ev as CustomEvent<{ enabled?: boolean } | undefined>).detail;
      const current = echoVoiceSessionStore.getSnapshot().handsFreeEnabled;
      const next = typeof detail?.enabled === 'boolean' ? detail.enabled : !current;
      if (next && openRef.current) {
        setHistoryOpen(false);
        setToolsOpen(false);
      }
      if (!next) {
        echoVoiceSessionStore.clearActiveToast();
        echoVoiceSessionStore.clearPendingConfirmation();
        echoVoiceSessionStore.clearLiveCaption();
        (echoVoiceSessionStore as typeof echoVoiceSessionStore & { clearVoiceError?: () => void }).clearVoiceError?.();
        if (echoVoiceSessionStore.getSnapshot().uiMode === 'immersive' && !openRef.current) {
          setVoiceUiMode('ambient');
        }
      }
      void getEchoJarvisRuntime()?.setHandsFreeEnabled?.(next, { userInitiated: true });
    };
    window.addEventListener('ec:jarvis:toggle-handsfree', onToggle);
    return () => window.removeEventListener('ec:jarvis:toggle-handsfree', onToggle);
  }, [isAuth]);

  // Reset lingering immersive overlay / voice stage when entering standalone/Sentinel-suspended routes
  // and immediately re-anchor position when returning to an active workspace route or query view
  const searchKey = searchParams?.toString() ?? '';
  useEffect(() => {
    if (isGarden) {
      exitVoicePresentationSilently();
    }
    if (isSuspended) {
      if (voiceSnap.uiMode === 'immersive') {
        setVoiceUiMode('ambient');
      }
      return;
    }
    companion.syncPosition?.();
  }, [isGarden, isSuspended, searchKey, voiceSnap.uiMode, companion, exitVoicePresentationSilently]);

  // When CoachWidget unmounts (e.g. entering `/speaking/arena` LiveKit or StudySpace desk), never leave a hidden open Echo mic.
  useEffect(() => () => {
    exitVoicePresentationSilently();
  }, [exitVoicePresentationSilently]);

  useEffect(() => {
    cancel(); setDailyRefused(false); setMessages([greeting()]); setSessions([]); setActiveId(null); setInput(''); setLoading(false); setError(''); setUnread(false); setHistoryOpen(false); setToolsOpen(false);
    setVoiceStage(false);
    try { localStorage.removeItem('echo_coach_active_session_id'); } catch {}
    return cancel;
    // Reset immediately on account changes; language changes don't discard a conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  useEffect(() => { setProactive(scope ? readProactive(scope) : false); setMemoryOpen(false); clearRecentSelection(); setSelectionShown(''); }, [scope]);
  // remembers what the learner selects on the page (passive: no request, no AI) so "explain this" can quote it
  useEffect(() => (isAuth ? watchPageSelection(() => rootRef.current, text => {
    bookExcerpt.current = null;
    setSelectionShown(text);
  }) : undefined), [isAuth]);
  useEffect(() => { if (isOpen) setSelectionShown(bookExcerpt.current?.text ?? recentSelection() ?? ''); }, [isOpen, messages]);
  useEffect(() => {
    bookExcerpt.current = null; clearRecentSelection(); setSelectionShown('');
    if (!isAuth || !(pathname === '/reading' || (pathname === '/' && tab === 'reading'))) return;
    const share = (event: Event) => {
      const text = (event as CustomEvent<unknown>).detail;
      if (typeof text !== 'string' || !text.trim()) return;
      exitVoicePresentationSilently();
      setHistoryOpen(false);
      bookExcerpt.current = {text: text.trim().slice(0,600), href: window.location.href};
      setSelectionShown(bookExcerpt.current.text); setMode('compact');
    };
    window.addEventListener('echo:book-excerpt',share);
    return () => window.removeEventListener('echo:book-excerpt',share);
  }, [scope, pathname, tab, isAuth, exitVoicePresentationSilently]);
  useEffect(() => {
    if (!isAuth) return;
    const ask = (event: Event) => {
      const text = (event as CustomEvent<{ text?: unknown }>).detail?.text;
      if (typeof text !== 'string' || !text.trim()) return;
      exitVoicePresentationSilently();
      setInput(text.trim().slice(0, 4000)); setHistoryOpen(false);
      if (!openRef.current) { if (closingTimer.current) clearTimeout(closingTimer.current); setClosing(null); setMode(lastMode.current); }
    };
    window.addEventListener('echo:ask', ask);
    return () => window.removeEventListener('echo:ask', ask);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuth]);
  const fetchSessions = useCallback(async () => {
    if (!isAuth) return [];
    const valid = capture(); setHistoryLoading(true);
    try {
      const data = await echoCoachApi.getRecentSessions();
      if (!valid()) return [];
      setSessions(data); return data;
    } catch { return []; } finally { if (valid()) setHistoryLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuth, scope]);
  const loadSessionMessages = async (id: number, opts?: { preserveNewerInMemory?: boolean }) => {
    if (!opts?.preserveNewerInMemory) cancel();
    const valid = capture();
    if (!opts?.preserveNewerInMemory) setLoading(true);
    setError('');
    try {
      const data = await echoCoachApi.getSessionMessages(id);
      if (!valid()) return;
      const serverMsgs: Message[] = data
        .filter(m => m.role === 'assistant' || m.role === 'user')
        .map(m => ({ role: m.role, content: m.content }));
      setMessages(prev => {
        if (opts?.preserveNewerInMemory && prev.length > 1) {
          const inMemTurns = prev.slice(1);
          const merged: Message[] = serverMsgs.length > 0 ? [...serverMsgs] : [prev[0]];
          for (const turn of inMemTurns) {
            const dup = merged.some(
              (existing, idx) =>
                idx >= Math.max(0, merged.length - 6) &&
                existing.role === turn.role &&
                existing.content === turn.content,
            );
            if (!dup) merged.push(turn);
          }
          return merged.length > 0 ? merged : [greeting()];
        }
        return serverMsgs.length ? serverMsgs : [greeting()];
      });
      activeIdRef.current = id;
      setActiveId(id); setHistoryOpen(false);
      getEchoJarvisRuntime()?.setEchoSessionId?.(id);
      try { localStorage.setItem(sessionStorageKey(scope), String(id)); } catch {}
    } catch { if (valid()) setError(vi ? 'Mình chưa tải được hội thoại. Bạn thử lại nhé.' : 'Could not load this conversation. Please try again.'); }
    finally { if (valid() && !opts?.preserveNewerInMemory) setLoading(false); }
  };
  const restored = useRef('');
  const [readyScope, setReadyScope] = useState('');
  const restoring = status === 'loading' || (isAuth && readyScope !== scope);
  useEffect(() => {
    if (!isAuth || restored.current === scope) return;
    restored.current = scope;
    const valid = capture();
    let storedId = 0;
    try { storedId = Number(localStorage.getItem(sessionStorageKey(scope))); } catch {}
    if (Number.isSafeInteger(storedId) && storedId > 0 && activeIdRef.current === null) {
      activeIdRef.current = storedId;
      setActiveId(storedId);
      getEchoJarvisRuntime()?.setEchoSessionId?.(storedId);
    }
    void (async () => {
      try {
        const recent = await fetchSessions(); if (!valid()) return;
        let id = storedId;
        if (!recent.some(s => s.id === id)) {
          id = activeIdRef.current && recent.some(s => s.id === activeIdRef.current) ? activeIdRef.current : 0;
        }
        if (id > 0) {
          await loadSessionMessages(id, { preserveNewerInMemory: true });
        }
      } finally {
        if (scopeRef.current === scope && !authEnding()) setReadyScope(scope);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuth, scope, fetchSessions]);
  useEffect(() => {
    if (!isOpen) return;
    setUnread(false);
    const pane = messagesContainerRef.current;
    // an empty conversation opens on Echo's welcome (its top); a conversation opens on its latest message
    if (pane && pinned.current) {
      if (messages.length === 1 && !draft && !loading) pane.scrollTo({ top: 0, behavior: 'auto' });
      else pane.scrollTo({ top: pane.scrollHeight, behavior: 'auto' });
    }
  }, [messages, draft, isOpen, loading]);
  const voiceStageActive = isAuth && voiceSnap.voiceStage;
  useEffect(() => {
    if (!isOpen || restoring || voiceStageActive || historyOpen) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [isOpen, historyOpen, restoring, voiceStageActive]);
  useEffect(() => {
    const textarea = textareaRef.current; if (!textarea) return;
    const size = () => {
      const cap = mode === 'expanded' ? 160 : 100;
      textarea.style.overflowY = 'hidden';
      textarea.style.height = 'auto';
      // scrollHeight rounds to an integer; leave room for fractional line boxes at browser zoom.
      const needed = textarea.scrollHeight + 1;
      textarea.style.height = Math.min(cap, needed) + 'px';
      textarea.style.overflowY = needed > cap ? 'auto' : 'hidden';
    };
    size();
    const form = textarea.closest('form');
    if (!form || typeof ResizeObserver === 'undefined') return;
    let width = form.clientWidth;
    const observer = new ResizeObserver(() => {
      if (form.clientWidth !== width) { width = form.clientWidth; size(); }
    });
    observer.observe(form);
    return () => observer.disconnect();
  }, [input, mode, isOpen, historyOpen]);
  useEffect(() => {
    if (messages.length < 2 || messages[messages.length - 1].role !== 'assistant') return;
    setResponding(true);
    const timer = setTimeout(() => setResponding(false), 650);
    return () => clearTimeout(timer);
  }, [messages]);
  const newChat = () => {
    const resetMessages = [greeting()];
    cancel(); messagesRef.current = resetMessages; setMessages(resetMessages); activeIdRef.current = null; setActiveId(null); setInput(''); setLoading(false); setError(''); setHistoryOpen(false);
    clearActiveSalientResources?.(scope);
    const rt = getEchoJarvisRuntime() as (ReturnType<typeof getEchoJarvisRuntime> & { resetConversationSession?: () => void }) | null;
    if (typeof rt?.resetConversationSession === 'function') rt.resetConversationSession();
    else rt?.setEchoSessionId?.(null);
    try { localStorage.removeItem(sessionStorageKey(scope)); } catch {}
  };
  const removeSession = async (id: number) => {
    const valid = capture();
    try { await echoCoachApi.deleteSession(id); if (!valid()) return; setSessions(s => s.filter(item => item.id !== id)); if (activeId === id) newChat(); }
    catch { if (valid()) setError(vi ? 'Chưa xóa được hội thoại.' : 'Could not delete the conversation.'); }
  };
  const sendMessage = async (spoken?: string, voiceLanguage?: 'vi' | 'en', explicitTextOverride?: string) => {
    const voice = typeof spoken === 'string';
    const rawSource = voice ? spoken : (typeof explicitTextOverride === 'string' ? explicitTextOverride : input);
    const text = rawSource.trim(); if (!text || restoring || busy.current || loading || exhausted) return;
    if (!isAuth) { setError(vi ? 'Bạn cần đăng nhập để trò chuyện với Echo.' : 'Please sign in to chat with Echo.'); return; }
    if (text.length > 4000) { setError(vi ? 'Bạn gửi tối đa 4.000 ký tự mỗi lần nhé.' : 'Please send at most 4,000 characters at a time.'); return; }

    // Plane-A (< 5 ms, 0 LLM tokens, 0 quota burned) Unified Fast-Path & Confirmation Resolution
    const salientForTurn = getSessionSalientResources?.(activeIdRef.current, scope) ?? [];
    const hasPendingConfirm = Boolean(voiceSnap.pendingConfirmation);
    const fastOutcome = compileEchoFastPath?.(text, {
      pathname,
      searchParams,
      hasPendingConfirmation: hasPendingConfirm,
      salientResources: salientForTurn,
      sessionId: activeIdRef.current,
    });

    if (fastOutcome?.guard || (fastOutcome?.fastPath && typeof executeIntentDag === 'function')) {
      busy.current = true;
      const valid = capture();
      const lang: 'en' | 'vi' =
        voiceLanguage ??
        fastOutcome.fastPath?.language ??
        (typeof detectUtteranceLanguage === 'function' ? detectUtteranceLanguage(text) : (vi ? 'vi' : 'en'));
      setDraft('');
      setSpokenReply(null);
      setInput('');
      setError('');
      setStatusText('');
      const withUser = [...messages, { role: 'user' as const, content: text }];
      setMessages(withUser);
      try {
        let replyText = '';
        if (fastOutcome.guard) {
          replyText =
            (lang === 'vi' ? fastOutcome.guard.spokenMessageVi : fastOutcome.guard.spokenMessageEn) ||
            (lang === 'vi' ? fastOutcome.guard.prompt?.vi : fastOutcome.guard.prompt?.en) ||
            (lang === 'vi' ? 'Thao tác này không được phép thực hiện.' : 'That action is not permitted.');
        } else if (fastOutcome.fastPath) {
          const report = await executeIntentDag(fastOutcome.fastPath.intents);
          if (report.status === 'confirm_required') {
            const pending = echoVoiceSessionStore.getSnapshot().pendingConfirmation;
            replyText = pending
              ? (lang === 'vi' ? pending.summaryVi : pending.summaryEn)
              : fastOutcome.fastPath.spokenAck;
          } else if (report.status !== 'done') {
            const failedStep = report.steps.find(s => s.outcome.status !== 'done');
            replyText =
              (lang === 'vi' ? failedStep?.outcome.spokenMessage?.vi : failedStep?.outcome.spokenMessage?.en) ||
              (lang === 'vi' ? 'Mình chưa mở được trang đó lúc này.' : 'Could not complete that action right now.');
          } else {
            const lastSpoken = [...report.steps]
              .reverse()
              .find(s => Boolean(s.outcome.spokenMessage))?.outcome.spokenMessage;
            replyText =
              (lang === 'vi' ? lastSpoken?.vi : lastSpoken?.en) ||
              fastOutcome.fastPath.spokenAck;
          }
        }
        if (!valid() || !replyText) return;
        const turnKey = newTurnId();
        if (voice) setSpokenReply({ key: turnKey, text: replyText, complete: true });
        setMessages(prev => [...prev, { role: 'assistant', content: replyText }]);
        setUnread(!openRef.current);
        let sid = activeIdRef.current;
        try {
          if (!sid) {
            const created = await echoCoachApi.createSession(text.slice(0, 80));
            if (!valid()) return;
            sid = created.id;
            activeIdRef.current = sid;
            setActiveId(sid);
            promoteActiveSalientResourcesToSession?.(sid, scope);
            getEchoJarvisRuntime()?.setEchoSessionId?.(sid);
            try { localStorage.setItem(sessionStorageKey(scope), String(sid)); } catch {}
          }
          if (sid && valid()) {
            await echoCoachApi.saveMessagePair(sid, text, replyText);
            if (valid()) void fetchSessions();
          }
        } catch {
          // Local action already executed; non-fatal session persistence error.
        }
      } finally {
        if (valid()) { busy.current = false; setLoading(false); setStatusText(''); }
      }
      return;
    }

    busy.current = true; const valid = capture(); const controller = new AbortController(); operation.current = controller;
    const authCancellation = authSignal(); const abort = () => controller.abort(); authCancellation.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 80000);
    const next = [...messages, { role: 'user' as const, content: text }];
    // Typed page context from contextBridge + URL contract + recent selection (on-demand local book strictly when asked)
    const book = bookExcerpt.current; bookExcerpt.current = null;
    const activeSel = selectionShown === recentSelection() ? selectionShown : undefined;
    const bridgedContext = getEchoWorkspaceContextSnapshot?.({
      pathname,
      search: searchParams,
      selection: activeSel,
      includeOnDemandBook: utteranceReferencesBookOrPassage(text) || Boolean(activeSel),
    });
    const pageContext = book && book.href === window.location.href
      ? { kind: 'BOOK_EXCERPT', selection: book.text }
      : (bridgedContext ?? pageContextFor(pathname, searchParams, activeSel));
    clearRecentSelection(); setSelectionShown('');
    const turn = {
      pageContext: pageContext ?? undefined,
      ...(salientForTurn.length > 0 ? { salientResources: salientForTurn } : {}),
      channel: voice ? 'voice' : 'text',
      locale: voiceLanguage ?? (vi ? 'vi' : 'en'),
      turnId: newTurnId(),
    };
    setDraft(''); setSpokenReply(null);
    setMessages(next); setInput(''); setLoading(true); setError(''); setStatusText('');
    let id = activeIdRef.current ?? activeId;
    try {
      if (!id) {
        const created = await echoCoachApi.createSession(text.slice(0, 80)); if (!valid()) return;
        id = created.id; activeIdRef.current = id; setActiveId(id);
        promoteActiveSalientResourcesToSession?.(id, scope);
        getEchoJarvisRuntime()?.setEchoSessionId?.(id);
        try { localStorage.setItem(sessionStorageKey(scope), String(id)); } catch {}
      }
      // Whole messages only; drop older turns to respect the server's aggregate budget.
      const context = next.filter(m => m.content && m.content.length <= 4000).slice(-15).map(m => ({ role: m.role, content: m.content }));
      while (context.length > 1 && context.reduce((n, m) => n + m.content.length, 0) > 24000) context.shift();
      if (!valid()) return;
      // The session cookie authenticates the stream (authFetch adds the CSRF header and renews a lapsed session).
      activeStream.current = { id: turn.turnId, owner: scope };
      const response = await authFetch(`${getBaseUrl()}/ai/chat/stream`, { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ messages: context, ...turn }) });
      if (!valid()) return;
      let reply = '';
      let cards: EchoCardData[] = [], actions: EchoActionData[] = [], streamFinished = false, autoNavigated = false;
      const dispatchedActionKeys = new Set<string>();
      const announcedConfirmTokens = new Set<string>();
      const executeServerActions = (rawList: unknown) => {
        if (!Array.isArray(rawList) || !valid()) return;
        const dagIntents: EchoClientIntent[] = [];
        for (const item of rawList) {
          if (!item || typeof item !== 'object') continue;
          const act = item as { type?: unknown; auto?: unknown; intent?: unknown; href?: unknown; label?: unknown };
          if (act.type === 'client_intent' && act.auto !== false && act.intent && typeof act.intent === 'object') {
            const key = `ci:${JSON.stringify(act.intent)}`;
            if (!dispatchedActionKeys.has(key)) {
              dispatchedActionKeys.add(key);
              if (typeof executeIntentDag === 'function') {
                dagIntents.push(act.intent as EchoClientIntent);
              } else {
                void dispatchEchoIntent(act.intent);
              }
            }
          } else if (act.type === 'navigate' && act.auto === true && !autoNavigated) {
            const safeHref = (typeof safeEchoJarvisHref === 'function' ? safeEchoJarvisHref(act.href) : null) ?? safeEchoHref(act.href);
            if (safeHref) {
              const key = `nav:${safeHref}`;
              if (!dispatchedActionKeys.has(key)) {
                dispatchedActionKeys.add(key);
                autoNavigated = true;
                if (typeof executeIntentDag === 'function') {
                  const label = typeof act.label === 'string' && act.label.trim() ? act.label.trim() : undefined;
                  dagIntents.push({ kind: 'navigate', href: safeHref, ...(label ? { label } : {}) });
                } else if (!isWorkRoute(pathname, searchParams)) {
                  router.push(safeHref);
                }
              }
            }
          }
        }
        if (dagIntents.length > 0 && typeof executeIntentDag === 'function') {
          void executeIntentDag(dagIntents, { signal: controller.signal });
        }
      };
      if (response.status === 401) {
        const recovered = await apiClient.post<{ reply: string; cards?: unknown; actions?: unknown }>('/ai/chat', { messages: context, ...turn },
          { signal: controller.signal, skipAuthRedirect: true } as any);
        if (!valid()) return;
        reply = recovered.data.reply;
        cards = sanitizeCards(recovered.data.cards); actions = sanitizeActions(recovered.data.actions);
        executeServerActions(recovered.data.actions);
        if (typeof reply !== 'string' || reply.length > 12000) throw new Error('connection');
      } else {
      const echoLimit = response.status === 429 ? response.headers?.get?.('x-echo-limit') : null;
      if (echoLimit === 'COACH_DAILY' || echoLimit === 'COACH_PREMIUM_DAILY' || echoLimit === 'COACH_PREMIUM_MONTHLY') { setLimitKind(echoLimit); throw new Error('daily'); }
      if (!response.ok || !response.body) throw new Error(response.status === 429 ? 'rate' : response.status === 503 ? 'unavailable' : 'connection');
      const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read(); if (!valid()) { await reader.cancel(); return; }
          buffer += decoder.decode(value, { stream: !done });
          if (buffer.length > 65536) throw new Error('oversized');
          const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data: unknown = JSON.parse(line.slice(5).trim());
            if (!data || typeof data !== 'object' || streamFinished) throw new Error('connection');
            if ('error' in data) {
              const errCode = String((data as { error?: unknown; code?: unknown }).error ?? (data as { code?: unknown }).code ?? '');
              throw new Error(errCode === 'length' ? 'length' : errCode === 'rate_limited' ? 'rate' : errCode === 'unavailable' || errCode === 'service_busy' ? 'unavailable' : 'connection');
            }
            if ('token' in data) {
              if (typeof data.token !== 'string' || reply.length + data.token.length > 12000) throw new Error('oversized');
              reply += data.token;
              setDraft(reply);
              if (voice) setSpokenReply({ key: turn.turnId, text: reply, complete: false });
            }
            if ('status' in data && typeof data.status === 'string' && valid()) setStatusText(sanitizeEchoStatusCopy(data.status, vi));
            if ('cards' in data) {
              const nextCards = sanitizeCards(data.cards);
              cards = typeof mergeCards === 'function' ? mergeCards(cards, nextCards) : [...cards, ...nextCards].slice(0, 6);
              for (const c of nextCards) {
                if (c.type === 'confirm' && c.token && !announcedConfirmTokens.has(c.token)) {
                  announcedConfirmTokens.add(c.token);
                  setPendingServerConfirmation?.({
                    token: c.token,
                    summaryEn: c.title || 'Confirm action',
                    summaryVi: c.title || 'Xác nhận thao tác',
                  });
                  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                    try { window.dispatchEvent(new CustomEvent('ec:jarvis:server-confirm', { detail: c })); } catch {}
                  }
                }
              }
            }
            if ('actions' in data) {
              const nextActions = sanitizeActions(data.actions);
              actions = typeof mergeActions === 'function' ? mergeActions(actions, nextActions) : [...actions, ...nextActions].slice(0, 6);
              executeServerActions(data.actions);
            }
            if ('done' in data) streamFinished = data.done === true;
          }
          if (reply.length > 12000) throw new Error('oversized');
          if (done || streamFinished) break;
        }
      } finally { reader.releaseLock(); }
      if (!streamFinished) throw new Error('connection');
      }
      if (!reply || !valid()) return;
      activeStream.current = null;
      setDraft('');
      if (voice) setSpokenReply({ key: turn.turnId, text: reply, complete: true });
      const extractedSalience = extractSalientResources?.(cards, actions);
      if (extractedSalience && extractedSalience.length > 0) {
        setSessionSalientResources?.(extractedSalience, id, scope);
      }
      setMessages(prev => [...prev, { role: 'assistant', content: reply, cards, actions }]); setUnread(!openRef.current);
      // Execute any remaining validated server actions not yet run mid-stream
      executeServerActions(actions);
      if (id && valid()) { await echoCoachApi.saveMessagePair(id, text, reply); if (valid()) void fetchSessions(); }
      if (valid()) void mutateEntitlement();
    } catch (cause) {
      const wasAborted = controller.signal.aborted;
      controller.abort();
      if (valid()) { setDraft(''); setSpokenReply(null); }
      if (cause instanceof Error && cause.message === 'daily') { if (valid()) { setDailyRefused(true); void mutateEntitlement(); } }
      else if (valid() && cause instanceof Error && cause.message === 'length') setError(vi
        ? 'Câu trả lời đã chạm giới hạn độ dài. Bạn có thể hỏi từng phần để Echo giải thích trọn vẹn.'
        : 'The answer reached its length limit. Ask about one part at a time for a complete explanation.');
      else if (valid() && cause instanceof Error && cause.message === 'unavailable') setError(vi
        ? 'Dịch vụ trả lời của Echo hiện chưa sẵn sàng. Tin nhắn này chưa được trả lời.'
        : 'Echo’s answer service is unavailable. This message has not been answered.');
      else if (valid() && !wasAborted) setError(cause instanceof Error && cause.message === 'rate'
        ? (vi ? 'Mình cần nghỉ một chút. Bạn thử lại sau nhé.' : 'Please wait a moment before trying again.')
        : (vi ? 'Mình gặp chút trục trặc. Bạn thử lại giúp mình nhé.' : 'Something went wrong. Please try again.'));
      else if (valid()) setError(vi ? 'Câu trả lời mất lâu hơn dự kiến. Bạn thử lại nhé.' : 'The answer took too long. Please try again.');
    } finally {
      clearTimeout(timer); authCancellation.removeEventListener('abort', abort);
      if (valid()) { operation.current = null; activeStream.current = null; busy.current = false; setLoading(false); setStatusText(''); }
    }
  };

  const toggleProactive = () => { const next = !proactive; setProactive(next); if (scope) writeProactive(scope, next); };
  const runtimeVoiceState = voiceSnap.entityState;
  const runtimeVoiceListening = runtimeVoiceState === 'awakening' || runtimeVoiceState === 'listening' || runtimeVoiceState === 'understanding';
  const runtimeVoiceThinking = runtimeVoiceState === 'thinking' || runtimeVoiceState === 'executing';
  const runtimeVoiceSpeaking = runtimeVoiceState === 'speaking';
  const state = error ? 'error' : (loading || runtimeVoiceThinking) ? 'thinking' : unread ? 'unread' : (responding || runtimeVoiceSpeaking) ? 'responding' : 'idle';
  const presence = error ? 'error' : (draft || runtimeVoiceSpeaking) ? 'streaming' : (loading || runtimeVoiceThinking) ? 'thinking' : runtimeVoiceListening ? 'listening' : unread ? 'unread' : 'idle';
  const presenceLine = presence === 'thinking' ? (statusText || (vi ? 'Đang suy nghĩ…' : 'Thinking…'))
    : presence === 'streaming' ? (runtimeVoiceSpeaking && !draft ? (vi ? 'Đang nói…' : 'Speaking…') : (vi ? 'Đang trả lời…' : 'Answering…'))
    : presence === 'listening' ? (vi ? 'Đang lắng nghe…' : 'Listening…')
    : presence === 'error' ? (vi ? 'Lượt vừa rồi chưa thành công' : 'The last turn did not finish')
    : (vi ? 'Người bạn đồng hành AI của bạn' : 'Your AI companion and learning coach');
  const welcome = messages.length === 1 && !historyOpen;
  const sessionName = String(session?.user?.name ?? '').trim();
  const givenName = sessionName && !sessionName.includes('@') ? sessionName.split(/\s+/).pop()!.slice(0, 24) : '';
  const prefill = (text: string) => { setInput(text); textareaRef.current?.focus({ preventScroll: true }); };
  const startVoice = openVoice;
  const anchor = shownMode === 'compact' && !mobile && companion.settled
    ? panelAnchor(companion.settled.point, companion.settled.size, { width: Math.min(410, window.innerWidth - 24), height: Math.min(580, (windowState.visibleHeight ?? window.innerHeight) - 24) }, { width: window.innerWidth, height: windowState.visibleHeight ?? window.innerHeight })
    : null;
  const expandedStyle: React.CSSProperties | undefined = immersive && isOpen ? undefined
    : shownMode === 'expanded' && !mobile ? { left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height }
    : anchor ? { left: anchor.left, top: anchor.top, transformOrigin: `${anchor.originX}px ${anchor.originY}px` }
    : mobile && windowState.visibleHeight ? { maxHeight: Math.max(120, windowState.visibleHeight - (mode === 'expanded' ? 16 : 24)) } : undefined;
  const bubbleStyle: React.CSSProperties | undefined = companion.settled ? {
    ...(companion.settled.side === 'left' ? { left: companion.settled.point.x } : { right: window.innerWidth - companion.settled.point.x - companion.settled.size }),
    ...(companion.settled.point.y > 150 ? { bottom: window.innerHeight - companion.settled.point.y + 10 } : { top: companion.settled.point.y + companion.settled.size + 10 }),
  } : undefined;
  const speech = isOpen || companion.dragging || guideTalks || voiceSnap.handsFreeEnabled ? null : discovery.phase !== 'hidden' && companion.prefs.messages && !speechLater ? discovery.text : companion.nudge;

  // Strict Sentinel Lockdown & 3D worlds: hide ENTIRE `.echo-root` (both Whale and Living Entity Orb!)
  if (isGarden || voiceSnap.strictSentinelLocked) return null;

  return <div ref={rootRef} className="echo-root" data-state={state} data-presence={presence}
    data-over-book-reader={voiceSnap.overBookReader ? 'true' : undefined}
    data-spatial-owner="" data-spatial-exclude=""
    style={{ ['--echo-face' as string]: `url("${echoSrc('social', 28)}")` }}>
    {immersive && isOpen && <div className="echo-scrim" aria-hidden="true" onClick={() => setImmersive(false)} />}
    {shownMode && <section className={`echo-panel echo-${shownMode}${immersive && isOpen ? ' echo-immersive' : ''}${interacting ? ' echo-interacting' : ''}${isOpen ? '' : ' echo-closing'}`} style={expandedStyle}
      data-voice-stage={voiceStageActive ? 'true' : undefined}
      role="dialog" aria-label="Echo Coach" aria-hidden={isOpen ? undefined : true} onKeyDown={event => { if (event.key === 'Escape') { if (immersive) setImmersive(false); else collapse(true); } }}>
      <header className="echo-header" {...windowState.drag}>
        <div className="echo-avatar echo-lens" aria-hidden="true">
          <span className="echo-lens-halo" /><span className="echo-lens-ring" />
          {draft && <span key={Math.floor(draft.length / 48)} className="echo-lens-ripple" />}
          <img src={echoSrc('social', 43)} alt="" draggable={false} />
        </div>
        <div className="echo-heading"><h2>Echo Coach</h2><span className="echo-state-line" role="status">{presenceLine}</span></div>
        <div className="echo-controls">
          <button type="button" aria-label={vi ? 'Tùy chọn Echo' : 'Echo options'} aria-expanded={toolsOpen} onClick={() => setToolsOpen(v => !v)}><MoreHorizontal size={18} /></button>
          <button type="button" className="echo-workspace-toggle" aria-pressed={voiceSnap.uiMode === 'immersive'} aria-label={voiceSnap.uiMode === 'immersive' ? (vi ? 'Thu về khung trò chuyện' : 'Back to the chat window') : (vi ? 'Mở không gian Echo' : 'Open the Echo workspace')}
            title={voiceSnap.uiMode === 'immersive' ? (vi ? 'Thu về khung trò chuyện' : 'Back to the chat window') : (vi ? 'Không gian Echo: trò chuyện cùng hồ sơ học tập của bạn' : 'Echo workspace: chat beside your learning profile')}
            onClick={() => {
              if (voiceSnap.uiMode === 'immersive') setVoiceUiMode('chat');
              else openImmersiveWorkspace();
            }}><LayoutPanelLeft size={17} /></button>
          <button type="button" aria-label={mode === 'expanded' ? (vi ? 'Thu gọn' : 'Compact view') : (vi ? 'Mở rộng' : 'Expand')}
            onClick={() => setMode(mode === 'expanded' ? 'compact' : 'expanded')}>{mode === 'expanded' ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
          <button type="button" aria-label={vi ? 'Ẩn Echo' : 'Collapse Echo'} onClick={e => collapse(e?.detail === 0)}><X size={17} /></button>
        </div>
      </header>
      {mode === 'expanded' && !mobile && !immersive && <div className="echo-window-tools"><span>{vi ? 'Kéo tiêu đề để di chuyển' : 'Drag the header to move'}</span>
        <button type="button" onClick={windowState.reset}><RotateCcw size={12} />{vi ? 'Đặt lại vị trí' : 'Reset position'}</button></div>}
      {toolsOpen && <div className="echo-companion-tools" role="group" aria-label={vi ? 'Tùy chọn Echo' : 'Echo options'}>
        <button type="button" onClick={() => { newChat(); setToolsOpen(false); }}><Plus size={13} />{vi ? 'Hội thoại mới' : 'New conversation'}</button>
        <button type="button" aria-expanded={historyOpen} onClick={() => {
          const nextHistory = !historyOpen;
          if (nextHistory) exitVoicePresentationSilently();
          setHistoryOpen(nextHistory);
          setToolsOpen(false);
          void fetchSessions();
        }}><History size={13} />{vi ? 'Lịch sử trò chuyện' : 'Conversation history'}</button>
        <button type="button" aria-pressed={companion.prefs.messages} onClick={() => companion.setMessages(!companion.prefs.messages)}>{companion.prefs.messages ? <Bell size={13} /> : <BellOff size={13} />}{vi ? (companion.prefs.messages ? 'Lời nhắn của Echo: Bật' : 'Lời nhắn của Echo: Tắt') : (companion.prefs.messages ? 'Echo’s little notes: on' : 'Echo’s little notes: off')}</button>
        <button type="button" onClick={companion.switchSide}><ArrowLeftRight size={13} />{vi ? 'Đổi bên' : 'Other side'}</button>
        <button type="button" onClick={companion.resetPlace}><RotateCcw size={13} />{vi ? 'Đặt lại vị trí Echo' : 'Reset Echo’s place'}</button>
        <button type="button" aria-pressed={proactive} onClick={toggleProactive}>{proactive ? <Bell size={13} /> : <BellOff size={13} />}{vi ? (proactive ? 'Gợi ý chủ động: Bật' : 'Gợi ý chủ động: Tắt') : (proactive ? 'Proactive tips: on' : 'Proactive tips: off')}</button>
        {isAuth && <button type="button" aria-pressed={voiceSnap.handsFreeEnabled} onClick={() => {
          const next = !voiceSnap.handsFreeEnabled;
          // Turning JARVIS hands-free on from the open panel enters the voice presentation directly.
          if (next) {
            setHistoryOpen(false);
            setVoiceStage(true);
          }
          if (!next) {
            echoVoiceSessionStore.clearActiveToast();
            echoVoiceSessionStore.clearPendingConfirmation();
            echoVoiceSessionStore.clearLiveCaption();
            (echoVoiceSessionStore as typeof echoVoiceSessionStore & { clearVoiceError?: () => void }).clearVoiceError?.();
          }
          void getEchoJarvisRuntime()?.setHandsFreeEnabled?.(next, { userInitiated: true });
          setToolsOpen(false);
        }}><Mic size={13} />{vi
          ? (voiceSnap.handsFreeEnabled ? 'Gọi rảnh tay "Hi, Echo": Bật' : 'Gọi rảnh tay "Hi, Echo": Tắt')
          : (voiceSnap.handsFreeEnabled ? 'Hands-free "Hi, Echo": On' : 'Hands-free "Hi, Echo": Off')}</button>}
        <button type="button" aria-expanded={memoryOpen} onClick={() => setMemoryOpen(v => !v)}><History size={13} />{vi ? 'Echo ghi nhớ' : 'Echo remembers'}</button>
      </div>}
      {toolsOpen && memoryOpen && isAuth && <EchoMemoryPanel vi={vi} />}
      {voiceSnap.pendingConfirmation && (
        <div
          className="echo-panel-confirm-banner"
          role="region"
          aria-labelledby={confirmBannerIdRef.current}
        >
          <span id={confirmBannerIdRef.current} className="echo-panel-confirm-text">
            {vi ? voiceSnap.pendingConfirmation.summaryVi : voiceSnap.pendingConfirmation.summaryEn}
          </span>
          <div className="echo-panel-confirm-actions">
            <button
              type="button"
              className="echo-toast-btn-primary"
              onClick={() => {
                const rt = getEchoJarvisRuntime() as ReturnType<typeof getEchoJarvisRuntime> & {
                  confirmPendingAction?: () => Promise<void>;
                };
                if (typeof rt?.confirmPendingAction === 'function') void rt.confirmPendingAction();
                else void rt?.decideConfirmation?.('confirm');
              }}
            >
              <Check size={13} aria-hidden="true" />
              <span>{vi ? 'Xác nhận' : 'Confirm'}</span>
            </button>
            <button
              type="button"
              className="echo-toast-btn-secondary"
              onClick={() => {
                const rt = getEchoJarvisRuntime() as ReturnType<typeof getEchoJarvisRuntime> & {
                  cancelPendingAction?: () => Promise<void>;
                };
                if (typeof rt?.cancelPendingAction === 'function') void rt.cancelPendingAction();
                else void rt?.decideConfirmation?.('cancel');
              }}
            >
              <span>{vi ? 'Hủy' : 'Cancel'}</span>
            </button>
          </div>
        </div>
      )}
      {historyOpen ? <div className="echo-history">
        <h3>{vi ? 'Hội thoại của bạn' : 'Your conversations'}</h3>
        {historyLoading ? <p role="status">{vi ? 'Đang tải…' : 'Loading…'}</p> : sessions.length === 0 ? <p>{vi ? 'Chưa có hội thoại được lưu.' : 'No saved conversations yet.'}</p> : sessions.map(item =>
          <div key={item.id}><button type="button" disabled={loading} onClick={() => void loadSessionMessages(item.id)}>{item.title}</button>
            <button type="button" aria-label={vi ? 'Xóa hội thoại' : 'Delete conversation'} onClick={() => void removeSession(item.id)}><Trash2 size={16} /></button></div>)}
      </div> : <>
        <div ref={messagesContainerRef} onScroll={e => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
        }} className="echo-conversation" hidden={voiceStageActive || undefined} aria-hidden={voiceStageActive || undefined} role="log" aria-live="polite" aria-label={vi ? 'Hội thoại' : 'Conversation'}>
          {welcome && !voiceStageActive && <div className="echo-welcome">
            <h3>{givenName ? (vi ? `Chào ${givenName},` : `Hi ${givenName},`) : (vi ? 'Chào bạn,' : 'Hi there,')}</h3>
            <p>{vi ? 'Hỏi Echo bất cứ điều gì về tiếng Anh, mình luôn lắng nghe.' : 'Ask Echo anything about English, I’m always listening.'}</p>
            <EchoOrb slot="welcome" size={immersive ? 'lg' : 'md'} state={presence} />
            <div className="echo-skills">
              <button type="button" onClick={() => prefill(vi ? 'Giải thích giúp mình cấu trúc ' : 'Please explain the structure ')}><BookOpen size={18} /><b>{vi ? 'Giải nghĩa từ' : 'Explain a word'}</b></button>
              <button type="button" onClick={() => prefill(vi ? 'Hôm nay mình nên học gì?' : 'What should I study today?')}><Compass size={18} /><b>{vi ? 'Hôm nay học gì?' : 'Today’s study'}</b></button>
              <button type="button" onClick={() => prefill(vi ? 'Mình đang yếu phần nào?' : 'Where am I weakest?')}><Target size={18} /><b>{vi ? 'Điểm cần luyện' : 'What to improve'}</b></button>
              {isAuth && !exhausted && <button type="button" onClick={startVoice}><Mic size={18} /><b>{vi ? 'Nói với Echo' : 'Talk to Echo'}</b></button>}
            </div>
          </div>}
          {messages.map((message, index) => welcome && index === 0 ? null : <EchoMessage key={index} {...message} />)}
          {draft && <div className="echo-message echo-message-assistant echo-message-live" aria-live="off"><div className="echo-text">{draft}</div></div>}
          {loading && !draft && <div className="echo-thinking" role="status"><span className="echo-thinking-swirl" aria-hidden="true"><img src={echoSrc('social', 28)} alt="" /><i /><i /></span><span>{statusText || (vi ? 'Echo đang suy nghĩ' : 'Echo is thinking')}<span className="echo-dots"> ···</span></span></div>}
        </div>
        {proactive && isAuth && !voiceStageActive && messages.length === 1 && <EchoSuggestions vi={vi} scope={scope} />}

        <footer className="echo-footer">
          {!voiceStageActive && error && <div role="alert" className="echo-error">{error}{!isAuth && <button type="button" onClick={() => router.push('/login')}>{vi ? 'Đăng nhập' : 'Sign in'}</button>}</div>}
          {!voiceStageActive && exhausted && <div role="status" className="echo-error">{limitKind === 'COACH_PREMIUM_MONTHLY'
            ? (vi ? `Bạn đã dùng hết ${ECHO_LIMITS.premium.perMonth} tin nhắn Echo Premium của tháng này. Hạn mức mới có vào ngày 1 tháng sau.`
              : `You have used this month's ${ECHO_LIMITS.premium.perMonth} Premium Echo messages. They renew on the 1st.`)
            : isPremium
            ? (vi ? `Bạn đã dùng hết ${allowance?.limit ?? ECHO_LIMITS.premium.perDay} tin nhắn Echo Premium hôm nay. Lượt mới có vào 0:00.`
              : `You have used today's ${allowance?.limit ?? ECHO_LIMITS.premium.perDay} Premium Echo messages. New ones arrive at midnight.`)
            : (vi ? `Bạn đã dùng hết ${allowance?.limit ?? 10} tin nhắn miễn phí hôm nay. Lượt mới có vào 0:00.`
              : `You have used today's ${allowance?.limit ?? 10} free messages. New ones arrive at midnight.`)}
            {!isPremium && <button type="button" onClick={() => router.push('/premium')}>{vi ? 'Xem Premium' : 'See Premium'}</button>}</div>}
          {!voiceStageActive && selectionShown && !exhausted && <div className="echo-selection" role="status">
            <span>{vi ? 'Echo sẽ xem đoạn bạn chọn: ' : 'Echo will look at your selection: '}<q>{selectionShown.length > 70 ? selectionShown.slice(0, 69) + '…' : selectionShown}</q></span>
            <button type="button" aria-label={vi ? 'Bỏ đoạn đã chọn' : 'Drop the selection'} onClick={() => { bookExcerpt.current = null; clearRecentSelection(); setSelectionShown(''); }}><X size={13} /></button></div>}
          <div className="echo-composer">
          <form hidden={voiceStageActive || undefined} aria-hidden={voiceStageActive || undefined} onSubmit={e => { e.preventDefault(); void sendMessage(); }}>
            <textarea ref={textareaRef} value={input} rows={1} maxLength={4000} disabled={restoring} aria-label={vi ? 'Tin nhắn cho Echo' : 'Message Echo'}
              placeholder={restoring ? (vi ? 'Đang tải hội thoại…' : 'Loading conversation…') : (vi ? 'Hỏi Echo về tiếng Anh…' : 'Ask Echo about English…')} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendMessage(); } }} />
            {loading && busy.current ? <button type="button" onClick={interruptTurn} aria-label={vi ? 'Dừng trả lời' : 'Stop generation'}><Square size={18} /></button> :
            <button type="submit" disabled={!input.trim() || loading || exhausted} aria-label={vi ? 'Gửi tin nhắn' : 'Send message'}><ArrowUp size={18} /></button>}
          </form>
          {isAuth && (!exhausted || voiceSnap.voiceStage) && <EchoVoice vi={vi} busy={loading || restoring} failedTurn={Boolean(error)} reply={spokenReply}
            onUtterance={(text, language) => void sendMessage(text, language)} onInterruptTurn={interruptTurn}
            userId={scope} panelOpen={isOpen} activeSessionId={activeId} exhausted={exhausted} />}
          </div>
          {(() => {
            const hint = allowance
              ? (vi ? `Echo ${isPremium ? 'Premium' : 'Coach'} · ${Math.min(allowance.used, allowance.limit)}/${allowance.limit} tin nhắn hôm nay` : `Echo ${isPremium ? 'Premium' : 'Coach'} · ${Math.min(allowance.used, allowance.limit)}/${allowance.limit} messages today`)
              : (vi ? 'Shift + Enter để xuống dòng' : 'Shift + Enter for a new line');
            return <div className="echo-composer-hint" title={hint} hidden={voiceStageActive || undefined} aria-hidden={voiceStageActive || undefined}>
              <span className="echo-hint-text">{hint}</span>
              {input.length > 3000 && <span>{input.length.toLocaleString()} / 4.000</span>}
            </div>;
          })()}
        </footer>
      </>}
      {mode === 'expanded' && !mobile && !immersive && <button type="button" className="echo-resize" {...windowState.resize}
        aria-label={vi ? 'Đổi kích thước: dùng các phím mũi tên' : 'Resize: use arrow keys'}
        onKeyDown={e => { const sizes: Record<string, [number, number]> = { ArrowRight: [24, 0], ArrowLeft: [-24, 0], ArrowDown: [0, 24], ArrowUp: [0, -24] };
          if (sizes[e.key]) { e.preventDefault(); windowState.keyboardResize(...sizes[e.key]); } }}><Grip size={15} /></button>}
      {immersive && isOpen && <EchoWorkspaceRail vi={vi} presence={presence} isPremium={isPremium}
        allowance={allowance ? { used: allowance.used, limit: allowance.limit } : null}
        onPrompt={prefill} onNavigate={href => { const safe = safeEchoHref(href); if (safe) { setImmersive(false); router.push(safe); } }} />}
    </section>}
    {/* Mode 3 — Deliberately triggered Holographic JARVIS Immersive Workspace */}
    {isAuth && <EchoImmersiveWorkspace
      vi={vi}
      open={voiceSnap.uiMode === 'immersive'}
      onClose={() => setVoiceUiMode(isOpen ? 'chat' : 'ambient')}
      onOpenChat={() => { reopen(); }}
      presence={presence}
      isPremium={isPremium}
      allowance={allowance ? { used: allowance.used, limit: allowance.limit } : null}
      messages={messages}
      draft={draft}
      loading={loading}
      exhausted={exhausted}
      statusText={statusText}
      input={input}
      onInputChange={setInput}
      onSubmitText={(text) => void sendMessage(undefined, undefined, text)}
      onInterrupt={interruptTurn}
      onNewChat={newChat}
      onNavigate={(href) => {
        const safe = safeEchoHref(href);
        if (safe) {
          setVoiceUiMode('ambient');
          router.push(safe);
        }
      }}
    />}
    {/* The floating companion. The bubble is words only (hidden when Hands-Free ambient orb or chat is active). */}
    {speech && <div className="echo-discovery" data-phase={discovery.phase !== 'hidden' ? discovery.phase : 'visible'} data-side={companion.settled?.side} style={bubbleStyle} role="status" aria-live="polite">{speech}
      <span className="echo-discovery-tools">
        <button type="button" onClick={() => { setSpeechLater(true); companion.dismissNudge(); }}>{vi ? 'Để sau' : 'Later'}</button>
        <button type="button" onClick={() => companion.setMessages(false)}>{vi ? 'Tắt lời nhắn' : 'Turn off'}</button>
      </span></div>}
    {/* Single-Anchor Mutual Exclusion: renders EITHER the resting Whale launcher OR the Ambient Living Entity — NEVER both! */}
    <EchoCompanionAnchor
      vi={vi}
      userId={scope}
      isAuth={isAuth}
      isOpen={isOpen}
      guiding={guiding}
      exhausted={exhausted}
      unread={unread}
      discoveryPhase={discovery.phase}
      companion={companion}
      onTogglePanel={() => { if (isOpen) collapse(); else reopen(); }}
      onOpenPanel={reopen}
      onOpenWorkspace={openImmersiveWorkspace}
      onStartVoice={startVoice}
    />
  </div>;
}
