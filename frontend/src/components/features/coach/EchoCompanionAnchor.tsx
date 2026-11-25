'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Mic } from 'lucide-react';
import { ECHO_ART, ECHO_COMPANION_SPRITE } from '@/lib/brand/echoArt';
import { echoVoiceSessionStore } from '@/lib/echo-jarvis/intents';
import { getEchoJarvisRuntime } from '@/lib/echo-jarvis/runtime/echoJarvisRuntime';
import { EchoJarvisAmbient } from './EchoJarvisAmbient';
import { deactivateEchoEntityStage } from './EchoOrb';
import type { EchoPoint, EchoSide } from './echo-companion';

export interface EchoCompanionHookSurface {
  ready: boolean;
  dragging: boolean;
  settled: { point: EchoPoint; size: number; side: EchoSide } | null;
  living: string;
  beat?: string;
  spriteOn: boolean;
  refs: {
    root: React.RefObject<HTMLButtonElement | null>;
    anchor?: React.RefObject<HTMLDivElement | null>;
    lag: React.RefObject<HTMLSpanElement | null>;
    sprite: React.RefObject<HTMLImageElement | null>;
  };
  attach?: {
    anchor?: (node: HTMLDivElement | null) => void;
    root?: (node: HTMLButtonElement | null) => void;
    lag?: (node: HTMLSpanElement | null) => void;
    sprite?: (node: HTMLImageElement | null) => void;
  };
  pointer: {
    onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove?: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp?: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel?: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerEnter?: (event: React.PointerEvent) => void;
    onPointerLeave?: (event: React.PointerEvent) => void;
  };
  syncPosition?: () => void;
  restoreMascot?: () => void;
  onSpriteLoad?: () => void;
  onSpriteError?: () => void;
  consumeDragClick: (event?: React.MouseEvent) => boolean;
}

export interface EchoCompanionAnchorProps {
  vi: boolean;
  userId?: string;
  isAuth: boolean;
  isOpen: boolean;
  guiding?: boolean;
  exhausted?: boolean;
  unread?: boolean;
  discoveryPhase?: string;
  /** Optional explicit override to force Ambient Living Entity rendering. */
  ambientActive?: boolean;
  companion: EchoCompanionHookSurface;
  onTogglePanel: () => void;
  onOpenPanel: () => void;
  onOpenWorkspace: () => void;
  onStartVoice?: () => void;
}

/**
 * Single-Anchor Spatial Owner with Atomic Visual Ownership Transfer between the original
 * Echo Whale mascot and the Ambient Pearlescent Living 3D Entity.
 *
 * Invariants:
 * 1. Exactly ONE coordinate frame (`companion.refs.anchor`) exists on screen.
 * 2. The Whale DOM stays mounted inside `.echo-anchor-host` so its decoded sprite sheet,
 *    transform, and CSS float/sway animations are NEVER lost across Ambient <-> Mascot switches.
 * 3. Outgoing Whale owner stays visible until incoming Ambient Living Entity fires `onVisualReady(true)`;
 *    turning JARVIS OFF immediately restores the Whale mascot on Frame 0 via `restoreMascot()` with
 *    0 blank frames, 0 square outlines, 0 orphaned shadows, and 0 simulated drag events.
 * 4. When `strictSentinelLocked === true`, renders `null` immediately (zero whale/orb leak).
 */
export function EchoCompanionAnchor({
  vi,
  userId,
  isAuth,
  isOpen,
  guiding = false,
  exhausted = false,
  unread = false,
  discoveryPhase,
  ambientActive: ambientActiveOverride,
  companion,
  onTogglePanel,
  onOpenPanel,
  onOpenWorkspace,
  onStartVoice,
}: EchoCompanionAnchorProps) {
  const snap = useSyncExternalStore(
    echoVoiceSessionStore.subscribe,
    echoVoiceSessionStore.getSnapshot,
    echoVoiceSessionStore.getServerSnapshot,
  );

  const hasLastError = Boolean((snap as { lastError?: unknown }).lastError);
  const hasActiveEntityState =
    snap.entityState !== 'disabled' && snap.entityState !== 'sleeping';

  // Authoritative Ambient Entity ownership: active only when Hands-Free is ON, a voice turn
  // is genuinely active/recovering, or a voice confirmation/error requires attention.
  // Ordinary passive action toasts NEVER hijack the Whale mascot into a disabled orb!
  // While the Echo panel is open it owns the voice presentation (its voice stage draws the entity): the anchor keeps the
  // resting whale instead of a second, duplicate orb behind the panel (incident 2026-11-25).
  const wantsAmbient =
    typeof ambientActiveOverride === 'boolean'
      ? ambientActiveOverride
      : isAuth &&
        !isOpen &&
        !guiding &&
        !snap.strictSentinelLocked &&
        (snap.handsFreeEnabled ||
          hasActiveEntityState ||
          Boolean(snap.pendingConfirmation) ||
          snap.activeToast?.kind === 'error' ||
          hasLastError);

  const hasPassiveOverlayOnly =
    !wantsAmbient &&
    isAuth &&
    !guiding &&
    !snap.strictSentinelLocked &&
    Boolean(snap.activeToast);

  const [ambientVisualReady, setAmbientVisualReady] = useState(false);
  const prevWantsAmbient = useRef(wantsAmbient);
  const companionRef = useRef(companion);
  companionRef.current = companion;

  const handleAmbientVisualReady = useCallback((ready: boolean) => {
    setAmbientVisualReady(ready);
  }, []);

  // Atomic handoff lifecycle:
  // - Mascot -> Ambient: wait for `ambientVisualReady` (with a 96 ms safety ceiling) before hiding Whale.
  // - Ambient -> Mascot: immediately reset `ambientVisualReady` and call `restoreMascot()` synchronously in effect.
  useEffect(() => {
    const wasAmbient = prevWantsAmbient.current;
    prevWantsAmbient.current = wantsAmbient;

    if (!wantsAmbient) {
      setAmbientVisualReady(false);
      if (wasAmbient) {
        deactivateEchoEntityStage();
        companionRef.current.restoreMascot?.();
      } else {
        companionRef.current.syncPosition?.();
      }
      return;
    }

    companionRef.current.syncPosition?.();
    if (ambientVisualReady) return;

    const safetyTimer = setTimeout(() => {
      setAmbientVisualReady(true);
    }, 96);
    return () => clearTimeout(safetyTimer);
  }, [wantsAmbient, ambientVisualReady]);

  if (snap.strictSentinelLocked) {
    return null;
  }

  // Outgoing Whale stays visible until incoming Ambient Entity is mounted, positioned, and visually ready!
  const showWhaleOwner = !wantsAmbient || !ambientVisualReady;

  // Re-sync GuideOffer placement ({ right: 16, bottom: 16 } in Ambient vs above Whale in Mascot) whenever
  // visual ownership switches while a first-visit GuideOffer card is on screen -> 0 px^2 radial overlap!
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (!document.querySelector('[data-testid="guide-offer"]')) return;
    let raf1 = 0;
    let raf2 = 0;
    window.dispatchEvent(new Event('resize'));
    if (typeof window.requestAnimationFrame === 'function') {
      raf1 = window.requestAnimationFrame(() => {
        raf1 = 0;
        window.dispatchEvent(new Event('resize'));
        companionRef.current.syncPosition?.();
        raf2 = window.requestAnimationFrame(() => {
          raf2 = 0;
          companionRef.current.syncPosition?.();
        });
      });
    }
    return () => {
      if (raf1) window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
    };
  }, [showWhaleOwner]);
  const { cols, rows } = ECHO_COMPANION_SPRITE;
  const side: EchoSide = companion.settled?.side ?? 'right';

  const handleQuickVoiceStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (exhausted || !isAuth) return;
    if (onStartVoice) {
      onStartVoice();
      return;
    }
    void getEchoJarvisRuntime().startActiveVoiceTurn();
  };

  // Declarative fallback transform ensures .echo-anchor-host NEVER flashes at (0,0) across null-render remounts
  const anchorInlineStyle: React.CSSProperties | undefined =
    companion.settled && !companion.dragging
      ? {
          transform: `translate3d(${companion.settled.point.x.toFixed(2)}px, ${companion.settled.point.y.toFixed(2)}px, 0)`,
        }
      : undefined;

  return (
    <div
      ref={companion.attach?.anchor ?? companion.refs.anchor}
      className="echo-anchor-host"
      style={anchorInlineStyle}
      data-anchor-mode={showWhaleOwner ? 'whale' : 'ambient'}
      data-visual-owner={showWhaleOwner ? 'mascot' : 'entity'}
      data-ready={companion.ready ? '' : undefined}
      data-dragging={companion.dragging ? '' : undefined}
      data-side={side}
      data-echo-anchor=""
      data-testid="echo-companion-anchor"
    >
      {/* Persistent Whale Mascot DOM — never unmounted across mode switches so sprite & float stay warm */}
      <div
        className="echo-whale-anchor-wrap"
        data-hidden={!showWhaleOwner ? '' : undefined}
        aria-hidden={!showWhaleOwner ? 'true' : undefined}
      >
        <button
          type="button"
          ref={companion.attach?.root ?? companion.refs.root}
          className="echo-launcher"
          tabIndex={showWhaleOwner ? 0 : -1}
          aria-label={
            isOpen
              ? vi ? 'Ẩn Echo Coach' : 'Collapse Echo Coach'
              : vi ? 'Trò chuyện với Echo Coach' : 'Chat with Echo Coach'
          }
          aria-description={unread ? (vi ? 'Có tin nhắn mới' : 'New answer') : undefined}
          data-unread={unread ? '' : undefined}
          data-discovery={discoveryPhase === 'entering' ? 'pulse' : undefined}
          data-ready={companion.ready ? '' : undefined}
          data-dragging={companion.dragging ? '' : undefined}
          data-living={isOpen || !showWhaleOwner ? 'still' : companion.living}
          data-beat={showWhaleOwner ? companion.beat : undefined}
          data-testid="echo-companion"
          aria-expanded={isOpen}
          {...(showWhaleOwner ? companion.pointer : {})}
          onClick={(event) => {
            if (!showWhaleOwner) return;
            if (companion.consumeDragClick(event)) return;
            onTogglePanel();
          }}
        >
          <span ref={companion.attach?.lag ?? companion.refs.lag} className="echo-lag">
            <span className="echo-float">
              <span className="echo-shadow" aria-hidden="true" />
              <span className="echo-whale" aria-hidden="true">
                <span className="echo-frame">
                  <img
                    className="echo-whale-still"
                    src={ECHO_ART.companion.still}
                    alt=""
                    draggable={false}
                    style={{ opacity: companion.spriteOn ? 0 : 1 }}
                  />
                  <img
                    ref={companion.attach?.sprite ?? companion.refs.sprite}
                    className="echo-whale-sheet"
                    src={companion.spriteOn ? ECHO_ART.companion.sprite : undefined}
                    data-src={ECHO_ART.companion.sprite}
                    alt=""
                    draggable={false}
                    onLoad={companion.onSpriteLoad}
                    onError={companion.onSpriteError}
                    style={{
                      width: `${cols * 100}%`,
                      height: `${rows * 100}%`,
                      opacity: companion.spriteOn ? 1 : 0,
                    }}
                  />
                </span>
              </span>
              <span className="echo-rising" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </span>
          </span>
        </button>

        {/* Subtle hover-only inward micro-mic trigger to wake Ambient Voice in 1 click */}
        {showWhaleOwner && isAuth && !isOpen && !guiding && !exhausted && !companion.dragging && (
          <button
            type="button"
            className="echo-whale-mic-trigger"
            data-side={side}
            aria-label={vi ? 'Nói trực tiếp với Echo' : 'Talk to Echo'}
            title={vi ? 'Nói trực tiếp với Echo' : 'Talk to Echo'}
            onClick={handleQuickVoiceStart}
          >
            <Mic size={14} />
          </button>
        )}
      </div>

      {/* Incoming / Active Ambient Living Entity (or passive toast-only portal when Whale owns the anchor) */}
      {(wantsAmbient || hasPassiveOverlayOnly) && (
        <EchoJarvisAmbient
          embedded
          vi={vi}
          userId={userId || snap.userId}
          panelOpen={isOpen}
          exhausted={exhausted}
          preparing={wantsAmbient && !ambientVisualReady}
          toastOnly={hasPassiveOverlayOnly}
          onVisualReady={handleAmbientVisualReady}
          anchorPoint={companion.settled?.point ?? null}
          anchorSize={companion.settled?.size}
          companionSide={side}
          dragging={companion.dragging}
          pointer={companion.pointer}
          consumeDragClick={companion.consumeDragClick}
          onOpenPanel={onOpenPanel}
          onOpenWorkspace={onOpenWorkspace}
        />
      )}
    </div>
  );
}
