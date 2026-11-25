"use client";

import React from "react";

/*
 * HUD art direction shared by the preview HUD and the gameplay panels (GDD 04 §2, cozy-fantasy pass): Chàm Đêm
 * night-indigo surfaces like smooth river stones, a warm lantern-gold hairline on top, pebble radii, one motion
 * language (EASE, 200–320 ms, no spring). Rêu Non = care actions, Mật Ong = coins / rewards / Golden.
 */
export const EASE = "ease-[cubic-bezier(0.22,1,0.36,1)]";
export const PANEL =
  "border border-white/[0.13] bg-gradient-to-b from-[#2a2f6c]/[0.88] to-[#1b1f4d]/[0.92] shadow-[0_14px_34px_-16px_rgba(4,8,24,0.8),inset_0_1px_0_rgba(255,226,160,0.14)] backdrop-blur-xl";
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFE2A0]/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1F2257]";

/** Primary action (care = Rêu Non, reward = Mật Ong). 48 px tall, presses to 0.96. */
export function ActionButton({
  tone = "care",
  children,
  disabled,
  onClick,
  className = "",
  testId,
  ariaLabel,
  guideId,
}: {
  tone?: "care" | "reward" | "quiet";
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  testId?: string;
  ariaLabel?: string;
  /** Echo's guide can point at this button (`data-guide`). */
  guideId?: string;
}) {
  const toneClass =
    tone === "reward"
      ? "bg-gradient-to-b from-[#FFD978] to-[#F4B63F] text-[#3a2a0a] shadow-[0_8px_18px_-10px_rgba(244,182,63,0.9),inset_0_1px_0_rgba(255,255,255,0.5)]"
      : tone === "care"
        ? "bg-gradient-to-b from-[#8fdca2] to-[#5fb97a] text-[#0f2a18] shadow-[0_8px_18px_-10px_rgba(116,201,139,0.9),inset_0_1px_0_rgba(255,255,255,0.45)]"
        : "border border-white/15 bg-white/[0.06] text-[#EEF3FF] hover:bg-white/[0.12]";
  return (
    <button
      type="button"
      data-testid={testId}
      data-guide={guideId}
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-[16px_13px_16px_14px] px-4 text-sm font-bold transition-[transform,filter,background-color] duration-200 ${EASE} active:scale-[0.96] disabled:cursor-default disabled:opacity-45 disabled:active:scale-100 ${FOCUS_RING} cursor-pointer ${toneClass} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Đồng Echo (Echo Coin): the garden's one currency icon — the gold coin with the Echo Whale mark, rendered from the
 * Blender master (`eg_farming.py`). Used everywhere a coin amount is shown; `large` picks the bigger source for art
 * above ~40 px. Decorative: the amount next to it always carries the accessible text.
 */
export function CoinIcon({ className = "h-4 w-4", large = false }: { className?: string; large?: boolean }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={large ? ECHO_COIN_ART : ECHO_COIN_ICON} alt="" aria-hidden draggable={false}
      className={`inline-block shrink-0 select-none object-contain ${className}`} />
  );
}

export const ECHO_COIN_ICON = "/garden/ui/echo_coin_icon_48.webp";
export const ECHO_COIN_ICON_2X = "/garden/ui/echo_coin_icon_96.webp";
export const ECHO_COIN_ART = "/garden/ui/echo_coin.webp";

export function WaterIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden>
      <path d="M10 2.5c3.3 4 5.5 7 5.5 9.6A5.5 5.5 0 0 1 4.5 12.1C4.5 9.5 6.7 6.5 10 2.5z" fill="#7FD3F5" />
      <path d="M7.4 12.6a2.8 2.8 0 0 0 2.4 2.6" stroke="#EAF8FF" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function FertilizerIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden>
      <path d="M5 7.5h10l-1.2 9.2a1.4 1.4 0 0 1-1.4 1.3H7.6a1.4 1.4 0 0 1-1.4-1.3L5 7.5z" fill="#B88A5A" />
      <path d="M6.2 4.2h7.6L15 7.5H5z" fill="#D8AE7C" />
      <path d="M10 15c-2-1-2.6-3.2-1.2-5 1.7.6 2.6 2.2 1.2 5zm0 0c1.3-1.6 3-1.9 4.2-1.3-.6 1.3-2.2 1.9-4.2 1.3z" fill="#74C98B" />
    </svg>
  );
}

/** Tinh chất Ký Ức: a teal memory droplet with a tiny leaf (the Knowledge Tree's magic palette, no sparkle shape). */
export function EssenceIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden>
      <path d="M10 2.2c3.6 4.2 5.6 7.2 5.6 9.9A5.6 5.6 0 0 1 4.4 12.1C4.4 9.4 6.4 6.4 10 2.2z" fill="#3fcfc0" />
      <path d="M10 2.2c3.6 4.2 5.6 7.2 5.6 9.9a5.6 5.6 0 0 1-5.6 5.6z" fill="#2bb3a6" />
      <path d="M8 12.6c.4-1.9 1.9-3 3.7-3-.3 1.9-1.8 3.1-3.7 3z" fill="#c9f5ec" />
    </svg>
  );
}

/** Small rounded chip for state labels (never colour-only: always a word). */
export function Chip({ tone = "quiet", children, testId }: { tone?: "good" | "warn" | "info" | "quiet" | "magic"; children: React.ReactNode; testId?: string }) {
  const cls = {
    good: "border-[#74C98B]/30 bg-[#74C98B]/15 text-[#a6e6b3]",
    warn: "border-[#F2A36B]/35 bg-[#F2A36B]/15 text-[#ffd2b0]",
    info: "border-[#7fd3f5]/30 bg-[#7fd3f5]/12 text-[#c6ecfb]",
    quiet: "border-white/10 bg-white/[0.06] text-[#EEF3FF]/70",
    magic: "border-[#3fcfc0]/35 bg-[#3fcfc0]/15 text-[#9cefe0]",
  }[tone];
  return <span data-testid={testId} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold ${cls}`}>{children}</span>;
}

/** Mobile bottom sheet / desktop side card container with eased entrance (same motion as the inspect card). */
export function GardenSheet({
  labelledBy,
  children,
  onClose,
  testId,
  wide = false,
}: {
  labelledBy: string;
  children: React.ReactNode;
  onClose: () => void;
  testId?: string;
  wide?: boolean;
}) {
  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelledBy}
      data-testid={testId}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      className={`pointer-events-auto ${PANEL} max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-40 max-sm:max-h-[70dvh] max-sm:overflow-y-auto max-sm:rounded-t-[26px] max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] sm:absolute sm:right-3 sm:top-1/2 sm:max-h-[calc(100dvh-9rem)] sm:-translate-y-1/2 sm:overflow-y-auto sm:rounded-[26px_22px_28px_24px] ${wide ? "sm:w-[372px]" : "sm:w-[340px]"} p-4 motion-safe:animate-[eg-sheet-in_320ms_cubic-bezier(0.22,1,0.36,1)]`}
    >
      <div className="mx-auto mb-3 h-1.5 w-11 rounded-full bg-white/25 sm:hidden" />
      {children}
    </aside>
  );
}
