'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  Captions,
  Check,
  ExternalLink,
  LayoutPanelLeft,
  MessageSquare,
  Mic,
  MicOff,
  MoreHorizontal,
  Power,
  RotateCcw,
  ShieldAlert,
  Square,
  Undo2,
  X,
} from 'lucide-react';
import {
  echoVoiceSessionStore,
  type EchoEntityState,
} from '@/lib/echo-jarvis/intents';
import { getEchoJarvisRuntime } from '@/lib/echo-jarvis/runtime/echoJarvisRuntime';
import {
  computeAmbientOverlayLayout,
  type EchoPoint,
  type EchoSide,
} from './echo-companion';
import {
  isRawTechnicalEchoText,
  resolveEchoVoiceRecoveryCopy,
  safeEchoHref,
} from './echo-window';
import { EchoOrb } from './EchoOrb';

export interface EchoJarvisAmbientProps {
  vi: boolean;
  userId?: string;
  panelOpen?: boolean;
  /** True when mounted inside `EchoCompanionAnchor`'s single fixed-coordinate frame. */
  embedded?: boolean;
  /** True while incoming Ambient Entity is warming its first frame before atomic handoff. */
  preparing?: boolean;
  /** True when Whale owns the anchor and only a passive portaled toast is fading out. */
  toastOnly?: boolean;
  /** Notifies `EchoCompanionAnchor` once the Living Entity visual surface has painted. */
  onVisualReady?: (ready: boolean) => void;
  /** Anchor coordinate snapshot for deterministic zero-overlap radial/CC/toast geometry. */
  anchorPoint?: EchoPoint | null;
  anchorSize?: number;
  companionSide?: EchoSide;
  /** Legacy alias kept for graceful backwards compatibility with callers. */
  companionPoint?: { x: number; y: number; size: number } | null;
  dragging?: boolean;
  pointer?: {
    onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove?: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp?: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel?: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerEnter?: (event: React.PointerEvent) => void;
    onPointerLeave?: (event: React.PointerEvent) => void;
  };
  consumeDragClick?: (event?: React.MouseEvent) => boolean;
  onOpenPanel: () => void;
  onOpenWorkspace: () => void;
  onCollapsePanel?: () => void;
  /** Optional legacy bridge props accepted safely during transition. */
  speaker?: unknown;
  activeSessionId?: number | null;
  exhausted?: boolean;
  getHistory?: () => { role: string; content: string }[];
  onAppendTurn?: (...args: unknown[]) => void;
  onDelegateChatTurn?: (...args: unknown[]) => void;
  onInterruptChatTurn?: () => void;
}

interface StoreLastErrorShape {
  readonly kind?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly canRetry?: boolean;
}

const ACTIVE_ENTITY_STATES = new Set<EchoEntityState>([
  'awakening',
  'listening',
  'understanding',
  'thinking',
  'speaking',
  'executing',
  'interrupted',
  'reconnecting',
  'error',
]);

function srLabelForState(state: EchoEntityState, vi: boolean): string {
  switch (state) {
    case 'awakening':
    case 'listening':
      return vi ? 'Echo đang lắng nghe' : 'Echo is listening';
    case 'understanding':
    case 'thinking':
      return vi ? 'Echo đang xử lý yêu cầu' : 'Echo is thinking';
    case 'speaking':
      return vi ? 'Echo đang phản hồi bằng giọng nói' : 'Echo is speaking';
    case 'executing':
      return vi ? 'Echo đang thực hiện thao tác' : 'Echo is executing your request';
    case 'interrupted':
      return vi ? 'Đã ngắt phản hồi, Echo đang nghe bạn' : 'Interrupted, Echo is listening';
    case 'reconnecting':
      return vi ? 'Đang kết nối lại giọng nói Echo' : 'Reconnecting Echo voice';
    case 'error':
      return vi ? 'Kết nối giọng nói tạm gián đoạn' : 'Voice connection interrupted';
    case 'dormant':
      return vi ? 'Echo rảnh tay sẵn sàng' : 'Echo hands-free ready';
    default:
      return 'Echo';
  }
}

const lastMousePointer = { x: -9999, y: -9999, active: false };
let mouseTrackerAttached = false;

function ensureGlobalMouseTracker(): void {
  if (mouseTrackerAttached || typeof window === 'undefined') return;
  mouseTrackerAttached = true;
  const recordMouse = (e: MouseEvent | PointerEvent) => {
    if ('pointerType' in e && e.pointerType && e.pointerType !== 'mouse') {
      lastMousePointer.active = false;
      return;
    }
    lastMousePointer.x = e.clientX;
    lastMousePointer.y = e.clientY;
    lastMousePointer.active = true;
  };
  window.addEventListener('pointermove', recordMouse, { passive: true });
  window.addEventListener('pointerdown', recordMouse, { passive: true });
  window.addEventListener('mousemove', recordMouse, { passive: true });
}

function viewportSnapshot(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 1440, height: 900 };
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

/**
 * Mode 1 — Pure Siri / JARVIS Minimal Ambient Living Entity HUD.
 *
 * Design laws:
 * - ZERO rectangular pill card, ZERO visible status badge strings, ZERO default transcript wall,
 *   and ZERO raw `"failed"` / technical error strings under any condition.
 * - NEVER owns `EchoJarvisAudioSession` — delegates 100% to `getEchoJarvisRuntime()` singleton.
 * - Floating circular Pearlescent Abyss Living 3D Entity (`64 px` dormant -> `88 px` active pulse),
 *   progressive-disclosure radial controls (`38 px` desktop / `36 px` compact hit targets) with
 *   instant floating micro-label tooltip, 1-click Mascot Restoration, opt-in single-line CC, and
 *   localized recovery micro-feedback with 1-click Retry / Dismiss.
 */
export function EchoJarvisAmbient({
  vi,
  userId,
  panelOpen = false,
  embedded = false,
  preparing = false,
  toastOnly = false,
  onVisualReady,
  anchorPoint = null,
  anchorSize,
  companionSide = 'right',
  companionPoint = null,
  dragging = false,
  pointer,
  consumeDragClick,
  onOpenPanel,
  onOpenWorkspace,
  exhausted = false,
}: EchoJarvisAmbientProps) {
  const router = useRouter();
  const snap = useSyncExternalStore(
    echoVoiceSessionStore.subscribe,
    echoVoiceSessionStore.getSnapshot,
    echoVoiceSessionStore.getServerSnapshot,
  );

  const [hovered, setHovered] = useState(false);
  const [orbitPinned, setOrbitPinned] = useState(false);
  const [hoveredActionLabel, setHoveredActionLabel] = useState<string | null>(null);
  const [toastHovered, setToastHovered] = useState(false);
  const [captionVisible, setCaptionVisible] = useState(false);
  const [viewport, setViewport] = useState(viewportSnapshot);
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captionFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyReported = useRef(false);

  // Portal fixed CC ribbon, micro-label hint, and Toast outside `.echo-anchor-host` (which uses `transform: translate3d`)
  // into `.echo-root` so `position: fixed` stays strictly viewport-relative while inheriting all `--echo-*` tokens!
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const rootEl = shellRef.current?.closest('.echo-root') ?? document.querySelector('.echo-root') ?? document.body;
    setPortalTarget(rootEl);
  }, []);

  useEffect(() => {
    const onResize = () => setViewport(viewportSnapshot());
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, []);

  // Deterministic visual-readiness signal for Atomic Visual Ownership Transfer:
  // Fires via `EchoOrb.onVisualReady` AND guarantees completion after 2 painted frames when CSS essence is active.
  const handleOrbVisualReady = useCallback(
    (ready: boolean) => {
      if (ready && !readyReported.current) {
        readyReported.current = true;
        onVisualReady?.(true);
      }
    },
    [onVisualReady],
  );

  useEffect(() => {
    if (toastOnly) {
      readyReported.current = false;
      return;
    }
    if (readyReported.current) {
      onVisualReady?.(true);
      return;
    }
    let raf1 = 0;
    let raf2 = 0;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      raf1 = window.requestAnimationFrame(() => {
        raf1 = 0;
        raf2 = window.requestAnimationFrame(() => {
          raf2 = 0;
          if (!readyReported.current) {
            readyReported.current = true;
            onVisualReady?.(true);
          }
        });
      });
    } else {
      readyReported.current = true;
      onVisualReady?.(true);
    }
    return () => {
      if (raf1) window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
    };
  }, [toastOnly, onVisualReady]);

  // Opt-in single-line CC fades out smoothly after speech stops (never renders raw "failed")
  const rawCaptionCandidate = (snap.liveCaption.echoSpoken || snap.liveCaption.userPartial || '').trim();
  const rawCaption = isRawTechnicalEchoText(rawCaptionCandidate) ? '' : rawCaptionCandidate;

  useEffect(() => {
    if (captionFadeTimer.current) {
      clearTimeout(captionFadeTimer.current);
      captionFadeTimer.current = null;
    }
    if (!snap.captionsEnabled || !rawCaption) {
      setCaptionVisible(false);
      return;
    }
    setCaptionVisible(true);
    const quiet =
      snap.entityState === 'dormant' ||
      snap.entityState === 'disabled' ||
      snap.entityState === 'sleeping';
    captionFadeTimer.current = setTimeout(() => {
      setCaptionVisible(false);
    }, quiet ? 2400 : 5200);
    return () => {
      if (captionFadeTimer.current) clearTimeout(captionFadeTimer.current);
    };
  }, [snap.captionsEnabled, rawCaption, snap.entityState, snap.liveCaption.updatedAt]);

  // Collapse pinned touch orbit while dragging or when opening Chat/Immersive
  useEffect(() => {
    if (dragging || panelOpen || snap.uiMode !== 'ambient') {
      setOrbitPinned(false);
      setHovered(false);
      setHoveredActionLabel(null);
    }
  }, [dragging, panelOpen, snap.uiMode]);

  // Stationary-cursor hover detection: when EchoJarvisAmbient mounts directly beneath an already-stationary
  // pointer (e.g. clicking .echo-whale-mic-trigger at left:-14px), Blink does not emit mouseenter or update
  // :hover until the next pointer move. Check both CSS :hover and last known mouse coordinates!
  useEffect(() => {
    ensureGlobalMouseTracker();
    if (toastOnly || preparing || panelOpen || dragging) return;
    const detectStationaryHover = () => {
      try {
        const shell = shellRef.current;
        if (!shell) return;
        const host = shell.closest?.('.echo-anchor-host') ?? null;
        let underPointer = Boolean(shell.matches?.(':hover') || host?.matches?.(':hover'));
        if (!underPointer && lastMousePointer.active && typeof shell.getBoundingClientRect === 'function') {
          const r = shell.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const hitRadius = Math.max(r.width, r.height) / 2 + 28;
            underPointer = Math.hypot(lastMousePointer.x - cx, lastMousePointer.y - cy) <= hitRadius;
          }
        }
        if (underPointer) {
          if (hoverCloseTimer.current) {
            clearTimeout(hoverCloseTimer.current);
            hoverCloseTimer.current = null;
          }
          setHovered(true);
        }
      } catch {
        // Ignore selector checks in non-DOM test environments
      }
    };
    detectStationaryHover();
    let raf1 = 0;
    let raf2 = 0;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      raf1 = window.requestAnimationFrame(() => {
        raf1 = 0;
        detectStationaryHover();
        raf2 = window.requestAnimationFrame(() => {
          raf2 = 0;
          detectStationaryHover();
        });
      });
    }
    return () => {
      if (raf1) window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
    };
  }, [toastOnly, preparing, panelOpen, dragging]);

  // Auto-recover sticky `'error'` state when user is not hovering recovery controls so a failed turn
  // never strands the session or blocks Mascot restoration when Hands-Free is OFF.
  const storeLastError = (snap as { lastError?: StoreLastErrorShape | null }).lastError ?? null;
  useEffect(() => {
    if (snap.entityState !== 'error' && !storeLastError) return;
    if (toastHovered || hovered) return;
    const recoveryTimer = setTimeout(() => {
      const rt = getEchoJarvisRuntime() as ReturnType<typeof getEchoJarvisRuntime> & {
        dismissError?: () => void;
      };
      rt.dismissError?.();
      (echoVoiceSessionStore as typeof echoVoiceSessionStore & { clearVoiceError?: () => void }).clearVoiceError?.();
      if (echoVoiceSessionStore.getSnapshot().activeToast?.kind === 'error') {
        echoVoiceSessionStore.clearActiveToast();
      }
      if (echoVoiceSessionStore.getSnapshot().entityState === 'error') {
        echoVoiceSessionStore.setEntityState(
          echoVoiceSessionStore.getSnapshot().handsFreeEnabled ? 'dormant' : 'disabled',
        );
      }
    }, 5200);
    return () => clearTimeout(recoveryTimer);
  }, [snap.entityState, storeLastError, toastHovered, hovered]);

  useEffect(() => {
    return () => {
      if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current);
      if (captionFadeTimer.current) clearTimeout(captionFadeTimer.current);
    };
  }, []);

  const openHover = useCallback(() => {
    if (hoverCloseTimer.current) {
      clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
    setHovered(true);
  }, []);

  const scheduleCloseHover = useCallback(() => {
    if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = setTimeout(() => {
      setHovered(false);
      setHoveredActionLabel(null);
    }, 420);
  }, []);

  const effectiveUserId = userId ?? snap.userId;
  if (snap.strictSentinelLocked || !effectiveUserId) return null;

  // Guarantee `<EchoOrb>` NEVER receives `'disabled'` while `<EchoJarvisAmbient>` is visibly mounted
  const displayEntityState: EchoEntityState =
    snap.entityState === 'disabled' || snap.entityState === 'sleeping'
      ? 'dormant'
      : snap.entityState;

  const isActive = ACTIVE_ENTITY_STATES.has(displayEntityState);
  const isBusyTurn =
    displayEntityState === 'speaking' ||
    displayEntityState === 'thinking' ||
    displayEntityState === 'understanding' ||
    displayEntityState === 'executing';
  const isListeningTurn =
    displayEntityState === 'listening' ||
    displayEntityState === 'awakening' ||
    displayEntityState === 'interrupted';

  const isMobile = viewport.width < 640;
  const baseSize = anchorSize ?? companionPoint?.size ?? (isMobile ? 58 : 64);
  const visualSize = !toastOnly && isActive ? (isMobile ? 76 : 88) : baseSize;

  const resolvedOrigin: EchoPoint = anchorPoint
    ? anchorPoint
    : companionPoint
      ? { x: companionPoint.x, y: companionPoint.y }
      : {
          x: companionSide === 'left' ? 24 : Math.max(12, viewport.width - baseSize - 24),
          y: Math.max(12, viewport.height - baseSize - 24),
        };

  const showOrbit = !toastOnly && !preparing && (hovered || orbitPinned) && !dragging && !panelOpen;
  const orbitActionsCount = 5;
  const layout = computeAmbientOverlayLayout(
    resolvedOrigin,
    baseSize,
    visualSize,
    viewport,
    orbitActionsCount,
    showOrbit,
  );

  const dismissRecoveryError = useCallback(() => {
    const rt = getEchoJarvisRuntime() as ReturnType<typeof getEchoJarvisRuntime> & {
      dismissError?: () => void;
    };
    rt.dismissError?.();
    (echoVoiceSessionStore as typeof echoVoiceSessionStore & { clearVoiceError?: () => void }).clearVoiceError?.();
    echoVoiceSessionStore.clearActiveToast();
    if (echoVoiceSessionStore.getSnapshot().entityState === 'error') {
      echoVoiceSessionStore.setEntityState(
        echoVoiceSessionStore.getSnapshot().handsFreeEnabled ? 'dormant' : 'disabled',
      );
    }
  }, []);

  const handleRetryError = useCallback(() => {
    const rt = getEchoJarvisRuntime() as ReturnType<typeof getEchoJarvisRuntime> & {
      retryLastVoiceTurn?: () => Promise<boolean>;
      dismissError?: () => void;
    };
    echoVoiceSessionStore.clearActiveToast();
    if (typeof rt.retryLastVoiceTurn === 'function') {
      void rt.retryLastVoiceTurn();
    } else {
      rt.dismissError?.();
      (echoVoiceSessionStore as typeof echoVoiceSessionStore & { clearVoiceError?: () => void }).clearVoiceError?.();
      void rt.startActiveVoiceTurn();
    }
  }, []);

  const handleEntityTap = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (consumeDragClick?.(event)) return;
    const rt = getEchoJarvisRuntime();
    if (isBusyTurn) {
      rt.interruptCurrentTurn();
      return;
    }
    if (isListeningTurn) {
      rt.enterSleep();
      return;
    }
    if (displayEntityState === 'error') {
      handleRetryError();
      return;
    }
    void rt.startActiveVoiceTurn();
  };

  const handlePrimaryVoiceControl = () => {
    const rt = getEchoJarvisRuntime();
    setHoveredActionLabel(null);
    if (isBusyTurn) {
      rt.interruptCurrentTurn();
    } else if (isListeningTurn && !snap.muted) {
      rt.enterSleep();
    } else {
      if (snap.muted) rt.setMuted(false);
      void rt.startActiveVoiceTurn();
    }
  };

  /**
   * 1-click Turn Off Hands-Free / Restore Mascot:
   * Unconditionally stops active voice, disables Hands-Free if active, clears transient overlays,
   * and returns visual ownership immediately to the original Echo Whale mascot.
   */
  const handleRestoreMascot = () => {
    const rt = getEchoJarvisRuntime() as ReturnType<typeof getEchoJarvisRuntime> & {
      dismissError?: () => void;
    };
    setOrbitPinned(false);
    setHovered(false);
    setHoveredActionLabel(null);
    echoVoiceSessionStore.setVoiceStage(false);
    rt.dismissError?.();
    (echoVoiceSessionStore as typeof echoVoiceSessionStore & { clearVoiceError?: () => void }).clearVoiceError?.();
    echoVoiceSessionStore.clearActiveToast();
    echoVoiceSessionStore.clearPendingConfirmation();
    echoVoiceSessionStore.clearLiveCaption();
    if (echoVoiceSessionStore.getSnapshot().uiMode === 'immersive') {
      echoVoiceSessionStore.setUiMode('ambient');
    }
    if (snap.handsFreeEnabled) {
      void rt.setHandsFreeEnabled(false, { userInitiated: true });
    } else {
      rt.enterSleep({ silent: false });
      echoVoiceSessionStore.setEntityState('disabled');
    }
  };

  const handleConfirm = (decision: 'confirm' | 'cancel') => {
    void getEchoJarvisRuntime().decideConfirmation(decision);
  };

  const handleUndo = () => {
    void getEchoJarvisRuntime().undoLastUiAction();
  };

  const handleNavigate = (href: string | undefined) => {
    const safe = safeEchoHref(href);
    if (!safe) return;
    echoVoiceSessionStore.clearActiveToast();
    router.push(safe);
  };

  const displayCaption = rawCaption.length > 96 ? `…${rawCaption.slice(-94)}` : rawCaption;
  const toast = !panelOpen ? snap.activeToast : null;
  const pendingConfirm = !panelOpen ? snap.pendingConfirmation : null;
  const isErrorSurface =
    !pendingConfirm &&
    (toast?.kind === 'error' || Boolean(storeLastError) || (!toast && displayEntityState === 'error'));

  const recoveryCopy = isErrorSurface
    ? resolveEchoVoiceRecoveryCopy(
        toast?.title ?? storeLastError?.title,
        toast?.subtitle ?? storeLastError?.subtitle,
        vi,
        exhausted,
      )
    : null;

  const showToastCard = !panelOpen && Boolean(toast || pendingConfirm || recoveryCopy);

  const safeToastTitle = recoveryCopy
    ? recoveryCopy.title
    : toast?.title && !isRawTechnicalEchoText(toast.title)
      ? toast.title
      : pendingConfirm
        ? vi
          ? pendingConfirm.summaryVi
          : pendingConfirm.summaryEn
        : vi
          ? 'Thao tác Echo'
          : 'Echo action';

  const safeToastSubtitle = recoveryCopy
    ? recoveryCopy.subtitle
    : toast?.subtitle && !isRawTechnicalEchoText(toast.subtitle)
      ? toast.subtitle
      : undefined;

  // Intuitive progressive-disclosure radial controls (>= 38px desktop / >= 36px mobile hit targets)
  const orbitButtons = [
    {
      key: 'mic-stop',
      kind: 'primary' as const,
      label: isBusyTurn
        ? vi ? 'Dừng phản hồi' : 'Stop response'
        : isListeningTurn && !snap.muted
          ? vi ? 'Tạm dừng nghe' : 'Pause listening'
          : snap.muted
            ? vi ? 'Bật micro và nói' : 'Unmute and speak'
            : vi ? 'Nói với Echo' : 'Speak to Echo',
      pressed: isActive && !snap.muted && displayEntityState !== 'error',
      icon: isBusyTurn ? <Square size={15} /> : isListeningTurn && !snap.muted ? <MicOff size={15} /> : <Mic size={16} />,
      onClick: handlePrimaryVoiceControl,
    },
    {
      key: 'chat',
      kind: 'default' as const,
      label: vi ? 'Mở khung trò chuyện' : 'Open chat window',
      pressed: false,
      icon: <MessageSquare size={15} />,
      onClick: () => {
        setOrbitPinned(false);
        setHovered(false);
        setHoveredActionLabel(null);
        onOpenPanel();
      },
    },
    {
      key: 'workspace',
      kind: 'default' as const,
      label: vi ? 'Mở không gian Echo' : 'Open Echo Workspace',
      pressed: false,
      icon: <LayoutPanelLeft size={15} />,
      onClick: () => {
        setOrbitPinned(false);
        setHovered(false);
        setHoveredActionLabel(null);
        onOpenWorkspace();
      },
    },
    {
      key: 'cc',
      kind: 'default' as const,
      label: snap.captionsEnabled
        ? vi ? 'Tắt phụ đề trực tiếp' : 'Hide live captions'
        : vi ? 'Bật phụ đề trực tiếp' : 'Show live captions',
      pressed: snap.captionsEnabled,
      icon: <Captions size={15} />,
      onClick: () => echoVoiceSessionStore.setCaptionsEnabled(!snap.captionsEnabled),
    },
    {
      key: 'restore-mascot',
      kind: 'power' as const,
      label: snap.handsFreeEnabled
        ? vi ? 'Tắt rảnh tay · Về cá voi Echo' : 'Turn off hands-free · Restore Echo'
        : vi ? 'Đóng giọng nói · Về cá voi Echo' : 'Close voice · Restore Echo',
      pressed: false,
      icon: <Power size={15} />,
      onClick: handleRestoreMascot,
    },
  ];

  // When rendered standalone (not inside EchoCompanionAnchor), position itself at resolvedOrigin
  const standaloneShellStyle: React.CSSProperties | undefined = embedded
    ? undefined
    : {
        position: 'fixed',
        left: 0,
        top: 0,
        width: baseSize,
        height: baseSize,
        transform: `translate3d(${resolvedOrigin.x}px, ${resolvedOrigin.y}px, 0)`,
      };

  const entityButtonStyle: React.CSSProperties = {
    width: visualSize,
    height: visualSize,
  };

  const btnHalfPx = Math.round(layout.buttonSize / 2);

  const hintStyle: React.CSSProperties = {
    ...(layout.hintBox.left !== undefined ? { left: layout.hintBox.left } : {}),
    ...(layout.hintBox.right !== undefined ? { right: layout.hintBox.right } : {}),
    top: layout.hintBox.top,
    maxWidth: layout.hintBox.maxWidth,
  };

  const captionStyle: React.CSSProperties = {
    ...(layout.captionBox.left !== undefined ? { left: layout.captionBox.left } : {}),
    ...(layout.captionBox.right !== undefined ? { right: layout.captionBox.right } : {}),
    ...(layout.captionBox.top !== undefined ? { top: layout.captionBox.top } : {}),
    ...(layout.captionBox.bottom !== undefined ? { bottom: layout.captionBox.bottom } : {}),
    maxWidth: layout.captionBox.maxWidth,
  };

  let resolvedToastBottom = layout.toastBox.bottom;
  let resolvedToastTop = layout.toastBox.top;
  let resolvedToastLeft = layout.toastBox.left;
  let resolvedToastMaxHeight = layout.toastBox.maxHeight;

  // Guarantee .echo-ambient-toast NEVER collides with first-visit GuideOffer (z-index 2147480500),
  // both in Ambient mode and in Whale toastOnly mode!
  if (showToastCard && typeof document !== 'undefined') {
    const guideEl = document.querySelector<HTMLElement>('[data-testid="guide-offer"]');
    if (guideEl && guideEl.style.visibility !== 'hidden') {
      const gr = guideEl.getBoundingClientRect();
      if (gr.width > 0 && gr.height > 0) {
        const horizOverlap =
          resolvedToastLeft < gr.right + 8 && resolvedToastLeft + layout.toastBox.width > gr.left - 8;
        if (horizOverlap && gr.top > 120) {
          const minClearBottom = Math.round(viewport.height - gr.top + 12);
          if (resolvedToastBottom !== undefined && resolvedToastBottom < minClearBottom) {
            const availAboveGuide = Math.round(gr.top - 24);
            if (availAboveGuide >= 110) {
              resolvedToastBottom = minClearBottom;
              resolvedToastMaxHeight = Math.min(resolvedToastMaxHeight, availAboveGuide);
            } else if (gr.left - layout.toastBox.width - 14 >= 12) {
              resolvedToastLeft = Math.round(gr.left - layout.toastBox.width - 14);
            }
          }
        }
      }
    }
  }

  const toastStyle: React.CSSProperties = {
    left: resolvedToastLeft,
    ...(resolvedToastTop !== undefined ? { top: resolvedToastTop } : {}),
    ...(resolvedToastBottom !== undefined ? { bottom: resolvedToastBottom } : {}),
    width: layout.toastBox.width,
    maxHeight: resolvedToastMaxHeight,
  };

  const floatingOverlays = (
    <>
      {/* Instant progressive-disclosure micro-label tooltip for hovered/focused radial action */}
      {showOrbit && hoveredActionLabel && (
        <div
          className="echo-radial-hint"
          data-align={layout.hintBox.align}
          style={hintStyle}
          aria-hidden="true"
        >
          <span>{hoveredActionLabel}</span>
        </div>
      )}

      {/* Opt-in single-line fade-out Closed Caption ribbon (OFF by default, never overlaps orb, open orbit, or mobile toast) */}
      {!panelOpen && !showOrbit && !(isMobile && showToastCard) && snap.captionsEnabled && captionVisible && displayCaption && (
        <div
          className="echo-ambient-cc"
          data-echo-caption=""
          data-align={layout.captionBox.align}
          style={captionStyle}
          role="status"
          aria-live="polite"
        >
          <span>{displayCaption}</span>
        </div>
      )}

      {/* Sleek offset Pearlescent Abyss Action / Resource / Stats / Confirmation / Localized Recovery toast */}
      {showToastCard && (
        <aside
          className="echo-ambient-toast"
          data-echo-toast=""
          data-kind={
            pendingConfirm
              ? 'confirm'
              : recoveryCopy
                ? 'error'
                : toast?.kind ?? 'action'
          }
          data-error-kind={recoveryCopy?.kind}
          style={toastStyle}
          role={pendingConfirm || toast?.kind === 'confirm' ? 'alertdialog' : 'status'}
          aria-label={safeToastTitle}
          onMouseEnter={() => setToastHovered(true)}
          onMouseLeave={() => setToastHovered(false)}
        >
          <div className="echo-ambient-toast-head">
            <div className="echo-ambient-toast-title-wrap">
              {toast?.kind === 'guard' && <ShieldAlert size={14} className="echo-toast-icon-guard" aria-hidden="true" />}
              <strong className="echo-ambient-toast-title">{safeToastTitle}</strong>
            </div>
            <button
              type="button"
              className="echo-ambient-toast-close"
              aria-label={vi ? 'Đóng thông báo' : 'Dismiss'}
              onClick={recoveryCopy ? dismissRecoveryError : () => echoVoiceSessionStore.clearActiveToast()}
            >
              <X size={13} />
            </button>
          </div>

          {safeToastSubtitle && <p className="echo-ambient-toast-sub">{safeToastSubtitle}</p>}

          {!recoveryCopy && toast?.items && toast.items.length > 0 && (
            <ul className="echo-ambient-toast-list" data-kind={toast.kind}>
              {toast.items.map((item, idx) => {
                const safeHref = safeEchoHref(item.href);
                if (safeHref && toast.kind !== 'stats') {
                  return (
                    <li key={`${item.title}-${idx}`}>
                      <button
                        type="button"
                        className="echo-ambient-toast-item"
                        onClick={() => handleNavigate(safeHref)}
                      >
                        <span className="echo-ambient-toast-item-main">
                          <span>{item.title}</span>
                          <ExternalLink size={12} aria-hidden="true" />
                        </span>
                        {(item.subtitle || item.meta) && (
                          <span className="echo-ambient-toast-item-meta">
                            {[item.subtitle, item.meta].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                }
                return (
                  <li key={`${item.title}-${idx}`} className="echo-ambient-toast-stat">
                    <span className="echo-ambient-toast-stat-label">{item.title}</span>
                    {item.subtitle && <strong className="echo-ambient-toast-stat-val">{item.subtitle}</strong>}
                    {item.meta && <span className="echo-ambient-toast-item-meta">{item.meta}</span>}
                  </li>
                );
              })}
            </ul>
          )}

          {(pendingConfirm || toast?.kind === 'confirm') && (
            <div className="echo-ambient-toast-actions" role="group" aria-label={vi ? 'Xác nhận' : 'Confirmation'}>
              <button
                type="button"
                className="echo-toast-btn-primary"
                onClick={() => handleConfirm('confirm')}
              >
                <Check size={13} aria-hidden="true" />
                <span>{vi ? 'Xác nhận' : 'Confirm'}</span>
              </button>
              <button
                type="button"
                className="echo-toast-btn-secondary"
                onClick={() => handleConfirm('cancel')}
              >
                {vi ? 'Hủy' : 'Cancel'}
              </button>
            </div>
          )}

          {recoveryCopy && !pendingConfirm && (
            <div className="echo-ambient-toast-actions" role="group" aria-label={vi ? 'Khôi phục giọng nói' : 'Voice recovery'}>
              {recoveryCopy.retryable && (storeLastError?.canRetry !== false) && (
                <button
                  type="button"
                  className="echo-toast-btn-retry"
                  onClick={handleRetryError}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  <span>{vi ? 'Thử lại' : 'Retry'}</span>
                </button>
              )}
              <button
                type="button"
                className="echo-toast-btn-secondary"
                onClick={dismissRecoveryError}
              >
                {vi ? 'Đóng' : 'Dismiss'}
              </button>
            </div>
          )}

          {!recoveryCopy && !pendingConfirm && toast?.kind !== 'confirm' && (toast?.canUndo || snap.canUndoLastAction) && (
            <div className="echo-ambient-toast-actions">
              <button type="button" className="echo-toast-btn-secondary" onClick={handleUndo}>
                <Undo2 size={13} aria-hidden="true" />
                <span>{vi ? 'Hoàn tác' : 'Undo'}</span>
              </button>
            </div>
          )}
        </aside>
      )}
    </>
  );

  if (toastOnly) {
    return (
      <div ref={shellRef} className="echo-ambient-toast-bridge" aria-hidden="true">
        {portalTarget ? createPortal(floatingOverlays, portalTarget) : null}
      </div>
    );
  }

  return (
    <>
      <div
        ref={shellRef}
        className="echo-ambient-shell"
        style={standaloneShellStyle}
        data-preparing={preparing ? '' : undefined}
        data-entity-state={displayEntityState}
        data-active={isActive ? '' : undefined}
        data-orbit-open={showOrbit ? '' : undefined}
        data-side={layout.side}
        onMouseEnter={openHover}
        onMouseMove={() => {
          if (!dragging && !panelOpen) openHover();
        }}
        onPointerMove={(e) => {
          if (e.pointerType === 'mouse' && !dragging && !panelOpen) openHover();
        }}
        onMouseLeave={scheduleCloseHover}
        onFocus={openHover}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setHovered(false);
            setHoveredActionLabel(null);
          }
        }}
      >
        {/* Pure floating circular Pearlescent Living 3D Entity — zero rectangular card, zero badge text */}
        <button
          type="button"
          className="echo-ambient-entity-btn"
          style={entityButtonStyle}
          tabIndex={preparing ? -1 : 0}
          data-testid="echo-ambient-entity"
          data-entity-state={displayEntityState}
          data-muted={snap.muted ? '' : undefined}
          aria-label={
            isBusyTurn
              ? vi ? 'Echo — nhấn để ngắt phản hồi' : 'Echo — click to interrupt'
              : isListeningTurn
                ? vi ? 'Echo đang nghe — nhấn để tạm nghỉ' : 'Echo listening — click to sleep'
                : displayEntityState === 'error'
                  ? vi ? 'Echo — nhấn để thử lại bằng giọng nói' : 'Echo — click to retry voice'
                  : vi ? 'Echo — nhấn để nói' : 'Echo — click to speak'
          }
          onPointerDown={pointer?.onPointerDown}
          onPointerMove={pointer?.onPointerMove}
          onPointerUp={pointer?.onPointerUp}
          onPointerCancel={pointer?.onPointerCancel}
          onClick={handleEntityTap}
        >
          <EchoOrb
            slot="ambient"
            size={visualSize}
            state={displayEntityState}
            active={!toastOnly}
            onVisualReady={handleOrbVisualReady}
          />
          {snap.muted && (
            <span className="echo-ambient-muted-dot" aria-hidden="true">
              <MicOff size={10} />
            </span>
          )}
        </button>

        {/* Coarse-touch unobtrusive orbit toggle handle (avoids pointer-drag / long-press conflict) */}
        {!panelOpen && !dragging && !preparing && (
          <button
            type="button"
            className="echo-radial-touch-handle"
            data-side={layout.side}
            aria-label={vi ? 'Mở điều khiển nhanh Echo' : 'Toggle Echo quick controls'}
            aria-expanded={orbitPinned}
            onClick={(e) => {
              e.stopPropagation();
              setOrbitPinned((v) => !v);
            }}
          >
            <MoreHorizontal size={14} />
          </button>
        )}

        {/* Progressive-disclosure inward-curving radial controls (>= 36-38px hit targets) */}
        {!panelOpen && (
          <div
            className="echo-radial-orbit"
            data-open={showOrbit ? '' : undefined}
            role="toolbar"
            aria-label={vi ? 'Điều khiển nhanh Echo' : 'Echo quick controls'}
          >
            {orbitButtons.map((btn, idx) => {
              const pt = layout.orbitOffsets[idx] ?? { x: 0, y: 0 };
              return (
                <button
                  key={btn.key}
                  type="button"
                  className="echo-radial-btn"
                  data-kind={btn.kind}
                  data-action={btn.key}
                  style={{
                    width: layout.buttonSize,
                    height: layout.buttonSize,
                    left: -btnHalfPx,
                    top: -btnHalfPx,
                    transform: showOrbit
                      ? `translate3d(${pt.x}px, ${pt.y}px, 0) scale(1)`
                      : 'translate3d(0px, 0px, 0) scale(0.55)',
                    transitionDelay: showOrbit ? `${idx * 22}ms` : '0ms',
                  }}
                  tabIndex={showOrbit ? 0 : -1}
                  aria-label={btn.label}
                  aria-pressed={btn.pressed || undefined}
                  title={btn.label}
                  onMouseEnter={() => setHoveredActionLabel(btn.label)}
                  onMouseLeave={() => setHoveredActionLabel((cur) => (cur === btn.label ? null : cur))}
                  onFocus={() => setHoveredActionLabel(btn.label)}
                  onBlur={() => setHoveredActionLabel((cur) => (cur === btn.label ? null : cur))}
                  onClick={(e) => {
                    e.stopPropagation();
                    btn.onClick();
                  }}
                >
                  {btn.icon}
                </button>
              );
            })}
          </div>
        )}

        {/* Screen-reader-only live status announcement (never painted visually!) */}
        <span className="echo-sr" role="status" aria-live="polite">
          {srLabelForState(displayEntityState, vi)}
        </span>
      </div>

      {portalTarget ? createPortal(floatingOverlays, portalTarget) : null}
    </>
  );
}
