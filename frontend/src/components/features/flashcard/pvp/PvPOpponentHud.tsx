"use client";

import React from "react";
import Image from "next/image";
import { Flame, ShieldAlert, WifiOff } from "lucide-react";
import { PlayerState } from "./useCardBlastPvP";
import { echoSrc } from '@/lib/brand/echoCharacters';

interface PvPOpponentHudProps {
  opponent: PlayerState | null;
  latestReaction?: { playerId: string; reactionId: string } | null;
  isLastStand?: boolean;
}

export const REACTION_MAP: Record<string, { emoji: string; text: string }> = {
  GG: { emoji: "🤝", text: "GG! (Chơi hay lắm)" },
  NICE: { emoji: "👍", text: "Đỉnh quá!" },
  OOPS: { emoji: "😅", text: "Ui trượt rồi!" },
  FIRE: { emoji: "🔥", text: "Cháy quá!" },
};

export const REACTION_EMOJIS = REACTION_MAP;

export function PvPOpponentHud({ opponent, latestReaction, isLastStand }: PvPOpponentHudProps) {
  if (!opponent) return null;

  const hpPercent = Math.max(0, Math.min(100, opponent.hp));
  const hpGradient =
    hpPercent > 60
      ? "from-emerald-500 to-green-500"
      : hpPercent >= 30
      ? "from-amber-500 to-orange-500"
      : "from-red-600 to-rose-500 animate-pulse";

  const isDisconnected = !opponent.connected;
  const showReaction = latestReaction && latestReaction.playerId === opponent.userId;
  const reactionData = showReaction ? REACTION_EMOJIS[latestReaction.reactionId] : null;

  return (
    <div className="absolute top-3 right-3 sm:top-4 sm:right-4 z-40 flex items-center gap-2">
      {/* Floating Reaction Bubble beside Opponent HUD */}
      {showReaction && reactionData && (
        <div
          data-testid="opponent-reaction-bubble"
          className="animate-in fade-in zoom-in-75 slide-in-from-right-3 duration-200 flex items-center gap-1.5 bg-gradient-to-r from-purple-900/95 to-indigo-900/95 border-2 border-purple-400 text-white px-3 py-1.5 rounded-2xl shadow-[0_0_20px_rgba(168,85,247,0.5)] backdrop-blur-md"
        >
          <span className="text-base">{reactionData.emoji}</span>
          <span className="text-xs font-bold font-mono tracking-wide">{reactionData.text}</span>
        </div>
      )}

      {/* Opponent Mini HUD */}
      <div
        data-testid="opponent-mini-hud"
        className={`flex items-center gap-2 sm:gap-3 bg-slate-900/90 backdrop-blur-md border rounded-2xl px-2.5 sm:px-3.5 py-2 shadow-xl transition-all ${
          isLastStand ? "border-red-500 shadow-red-500/30 animate-pulse" : "border-slate-700/60"
        }`}
      >
        {/* Opponent Avatar & Status */}
        <div className="relative flex-shrink-0">
          <div className={`w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-slate-800 border flex items-center justify-center overflow-hidden transition-all ${
            isLastStand ? "border-red-500 ring-2 ring-red-500/60 shadow-[0_0_15px_rgba(239,68,68,0.7)] animate-pulse" : "border-slate-600"
          }`}>
            {opponent.avatar && !opponent.avatar.includes("Whale.svg") && !opponent.avatar.startsWith("blob:") ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={opponent.avatar}
                alt={opponent.displayName || "Opponent"}
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = "none";
                }}
              />
            ) : opponent.avatar && opponent.avatar.includes("Whale.svg") ? (
              <Image
                unoptimized
                src={echoSrc('tech', 40)}
                alt="Bot Echo"
                width={36}
                height={36}
                className="object-contain p-0.5"
              />
            ) : (
              <span className="text-xs font-bold text-slate-300">
                {(opponent.displayName || "OP").substring(0, 2).toUpperCase()}
              </span>
            )}
          </div>
          {isDisconnected && (
            <div className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 shadow-sm animate-pulse">
              <WifiOff className="w-2.5 h-2.5" />
            </div>
          )}
        </div>

        {/* Opponent Stats */}
        <div className="flex flex-col min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-200 truncate max-w-[90px] sm:max-w-[120px]">
              {opponent.displayName || "Đối thủ"}
            </span>
            <div className="flex items-center gap-1">
              {isLastStand && (
                <span className="text-[9px] font-black text-rose-300 bg-rose-950/80 border border-rose-500/60 px-1 rounded-sm uppercase tracking-wider">
                  🔥 LAST STAND
                </span>
              )}
              <span className="text-xs font-mono font-bold text-amber-400">
                {opponent.score}
              </span>
              {opponent.streak > 1 && (
                <span className="inline-flex items-center text-[10px] font-bold text-orange-400 bg-orange-950/60 px-1 rounded-sm">
                  <Flame className="w-2.5 h-2.5 mr-0.5 fill-orange-400" />
                  {opponent.streak}
                </span>
              )}
            </div>
          </div>

          {/* Mini HP Bar */}
          <div className="mt-1 flex items-center gap-1.5">
            <div className="w-28 sm:w-36 h-2.5 rounded-full bg-slate-800 overflow-hidden border border-slate-700/80 relative">
              <div
                className={`h-full bg-gradient-to-r ${hpGradient} transition-all duration-300 rounded-full`}
                style={{ width: `${hpPercent}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-slate-400 w-5 text-right font-medium">
              {hpPercent}
            </span>
          </div>

          {/* Disconnected Grace Warning */}
          {isDisconnected && (
            <div className="mt-0.5 flex items-center gap-1 text-[9px] text-red-400 font-medium">
              <ShieldAlert className="w-2.5 h-2.5 flex-shrink-0" />
              <span>Mất kết nối (15s)</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
