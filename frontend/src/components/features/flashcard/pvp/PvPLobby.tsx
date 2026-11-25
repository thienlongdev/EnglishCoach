"use client";

import React, { useState, useEffect, useRef } from "react";
import Image from "next/image";
import {
  Swords,
  PlusCircle,
  KeyRound,
  Bot,
  Copy,
  Check,
  LogOut,
  Users,
  Shield,
  ArrowRight,
  BookOpen,
} from "lucide-react";
import { useCurrentUserAvatar } from "@/hooks/useCurrentUserAvatar";
import { UserAvatar } from "@/components/common/UserAvatar";
import { PvPRulesModal } from "./PvPRulesModal";
import { VocabDeckSummary } from "../DeckCatalogView";
import { CardBlastRoom, PlayerState } from "./useCardBlastPvP";
import { echoSrc } from '@/lib/brand/echoCharacters';

function getInitials(name?: string | null): string {
  if (!name || !name.trim()) return "EC";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase();
}

interface PvPLobbyProps {
  room: CardBlastRoom | null;
  currentUserId: string;
  isHost: boolean;
  decks: VocabDeckSummary[];
  selectedDeck: VocabDeckSummary | null;
  initialCode?: string;
  error?: string | null;
  onClearError?: () => void;
  isCreatingRoom?: boolean;
  isJoiningRoom?: boolean;
  onCreateRoom: (params: {
    deckId?: number | null;
    deckSlug?: string;
    deckTitle: string;
    direction: "VI_EN" | "EN_VI";
    mode: "HUMAN" | "BOT";
    botLevel?: "EASY" | "NORMAL" | "HARD";
    speedLevel?: number;
    hintLevel?: "EASY" | "NORMAL" | "HARD";
    avatar?: string;
  }) => void;
  onJoinRoom: (code: string, avatar?: string) => void;
  onLeaveRoom: () => void;
  onToggleReady: (ready: boolean, skills?: string[]) => void;
  onBackToModeSelect: () => void;
}

export interface SkillConfig {
  id: string;
  name: string;
  cost: number;
  icon: string;
  desc: string;
}

export const PVP_SKILLS: SkillConfig[] = [
  { id: "ECHO_CHAIN", name: "Kích nổ", cost: 40, icon: "⚡", desc: "Đòn đánh tiếp theo kích nổ từ gần nhất" },
  { id: "SLOW_MO", name: "Làm chậm", cost: 50, icon: "⏳", desc: "Tăng 5s thời hạn cho tất cả từ đang rơi" },
  { id: "EMP_BLAST", name: "Xung kích", cost: 80, icon: "💥", desc: "Quét sạch từ trên màn hình và phản công 1 đòn" },
  { id: "FOG", name: "Mù Sương", cost: 50, icon: "🌫️", desc: "Che khuất 60% chữ của đối thủ trong 5s" },
  { id: "SHIELD", name: "Khiên Chắn", cost: 35, icon: "🛡️", desc: "Chặn 1 đòn tấn công của đối thủ trong 8s" },
];

export function PvPLobby({
  room,
  currentUserId,
  isHost,
  decks,
  selectedDeck: initialDeck,
  initialCode,
  error,
  onClearError,
  isCreatingRoom = false,
  isJoiningRoom = false,
  onCreateRoom,
  onJoinRoom,
  onLeaveRoom,
  onToggleReady,
  onBackToModeSelect,
}: PvPLobbyProps) {
  // Tabs: 'create' | 'join' | 'bot'
  const [tab, setTab] = useState<"create" | "join" | "bot">(initialCode ? "join" : "create");
  const [selectedSkills, setSelectedSkills] = useState<string[]>(["ECHO_CHAIN", "SLOW_MO", "EMP_BLAST"]);

  // Create form state
  const [chosenDeckKey, setChosenDeckKey] = useState<string>(
    initialDeck?.id != null ? String(initialDeck.id) : (initialDeck?.slug || "")
  );
  const [chosenDirection, setChosenDirection] = useState<"VI_EN" | "EN_VI">("VI_EN");
  const [botLevel, setBotLevel] = useState<"EASY" | "NORMAL" | "HARD">("NORMAL");
  const [speedLevel, setSpeedLevel] = useState<number>(2);
  const [hintLevel, setHintLevel] = useState<"EASY" | "NORMAL" | "HARD">("NORMAL");

  // Join form state
  const [joinCodeInput, setJoinCodeInput] = useState<string>(
    initialCode ? initialCode.replace(/[\s-]/g, "").toUpperCase().slice(0, 6) : ""
  );
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Real user profile avatar
  const { avatarUrl: myAvatarUrl } = useCurrentUserAvatar();

  // Auto-focus input when on 'join' tab
  useEffect(() => {
    if (tab === "join" && !room) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [tab, room]);

  // Handle auto-join from initialCode
  const hasAutoJoinedRef = useRef(false);
  useEffect(() => {
    if (initialCode && !room && !hasAutoJoinedRef.current) {
      const clean = initialCode.replace(/[\s-]/g, "").toUpperCase().slice(0, 6);
      if (clean.length === 6) {
        hasAutoJoinedRef.current = true;
        onJoinRoom(clean, myAvatarUrl || undefined);
      }
    }
  }, [initialCode, room, onJoinRoom, myAvatarUrl]);

  const cleanRoomCode = room?.roomCode ? room.roomCode.replace(/[\s-]/g, "").toUpperCase() : "";

  const handleCopyCode = () => {
    if (!cleanRoomCode) return;
    navigator.clipboard.writeText(cleanRoomCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2500);
  };

  const handleCopyInviteLink = () => {
    if (!cleanRoomCode) return;
    const origin = typeof window !== "undefined" ? window.location.origin : "https://englishcoach.io.vn";
    const inviteUrl = `${origin}/games?pvp=${cleanRoomCode}`;
    navigator.clipboard.writeText(inviteUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2500);
  };

  const resolveDeckSelection = () => {
    if (!chosenDeckKey) {
      return { deckId: null, deckSlug: undefined, deckTitle: "Bộ từ vựng cá nhân" };
    }
    const deck = decks.find(
      (d) => (d.id != null && String(d.id) === chosenDeckKey) || (d.slug && d.slug === chosenDeckKey)
    );
    const numId =
      deck?.id != null
        ? Number(deck.id)
        : !isNaN(Number(chosenDeckKey)) && chosenDeckKey.trim() !== ""
        ? Number(chosenDeckKey)
        : null;
    const slug =
      deck?.slug ||
      (isNaN(Number(chosenDeckKey)) && chosenDeckKey.trim() !== "" ? chosenDeckKey : undefined);
    const title = deck?.title || "Bộ từ vựng";
    return { deckId: numId, deckSlug: slug, deckTitle: title };
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const { deckId, deckSlug, deckTitle } = resolveDeckSelection();
    onCreateRoom({
      deckId,
      deckSlug,
      deckTitle,
      direction: chosenDirection,
      mode: "HUMAN",
      speedLevel,
      hintLevel,
      avatar: myAvatarUrl && !myAvatarUrl.startsWith("blob:") ? myAvatarUrl : undefined,
    });
  };

  const handleBotSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const { deckId, deckSlug, deckTitle } = resolveDeckSelection();
    onCreateRoom({
      deckId,
      deckSlug,
      deckTitle,
      direction: chosenDirection,
      mode: "BOT",
      botLevel: botLevel,
      speedLevel,
      hintLevel,
      avatar: myAvatarUrl && !myAvatarUrl.startsWith("blob:") ? myAvatarUrl : undefined,
    });
  };

  const handleJoinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = joinCodeInput.replace(/[\s-]/g, "").toUpperCase().slice(0, 6);
    if (clean.length === 6) {
      onJoinRoom(clean, myAvatarUrl && !myAvatarUrl.startsWith("blob:") ? myAvatarUrl : undefined);
    }
  };

  const myState = isHost ? room?.host : room?.guest;
  const isMyReady = myState?.ready || false;

  function PlayerAvatarBadge({
    player,
    isCurrent,
    role,
    myAvatarUrl,
  }: {
    player: PlayerState | null | undefined;
    isCurrent: boolean;
    role: "host" | "guest";
    myAvatarUrl: string | null;
  }) {
    const [imgError, setImgError] = useState(false);
    const isBot = player?.userId === "bot_echo" || player?.displayName?.includes("Bot");

    const candidateUrl =
      isCurrent && myAvatarUrl && !myAvatarUrl.startsWith("blob:")
        ? myAvatarUrl
        : player?.avatar && !player.avatar.includes("Whale.svg") && !player.avatar.startsWith("blob:")
        ? player.avatar
        : isCurrent && myAvatarUrl
        ? myAvatarUrl
        : null;

    useEffect(() => {
      setImgError(false);
    }, [candidateUrl]);

    if (isBot) {
      return (
        <div className="w-16 h-16 rounded-full bg-slate-800 border-2 border-cyan-500/80 flex items-center justify-center overflow-hidden mb-3 mt-4 shadow-md shadow-cyan-950/40">
          <Image src={echoSrc('tech', 40)} alt="Bot Echo" width={64} height={64} unoptimized className="object-contain p-0.5" />
        </div>
      );
    }

    if (isCurrent) {
      return (
        <div className="mb-3 mt-4 flex items-center justify-center">
          <UserAvatar
            className="w-16 h-16 rounded-full"
            showFrame={true}
            context="pvp"
            size="md"
            fallbackName={player?.displayName}
          />
        </div>
      );
    }

    if (candidateUrl && !imgError) {
      return (
        <div
          className={`w-16 h-16 rounded-full bg-slate-800 border-2 ${
            role === "host" ? "border-indigo-500 shadow-indigo-950/50" : "border-amber-500 shadow-amber-950/50"
          } flex items-center justify-center overflow-hidden mb-3 mt-4 shadow-md`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={candidateUrl}
            alt={player?.displayName || "Avatar"}
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
          />
        </div>
      );
    }

    const initials = getInitials(player?.displayName);
    const gradientClass =
      role === "host"
        ? "from-indigo-600 via-purple-600 to-pink-600 border-indigo-400/80 shadow-indigo-950/50"
        : "from-amber-500 via-orange-600 to-rose-600 border-amber-400/80 shadow-amber-950/50";

    return (
      <div
        className={`w-16 h-16 rounded-full bg-gradient-to-br ${gradientClass} border-2 flex items-center justify-center mb-3 mt-4 shadow-md`}
      >
        <span className="text-xl font-black text-white tracking-wider drop-shadow">
          {initials}
        </span>
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto p-4 sm:p-6 text-slate-100">
      {error && (
        <div className="mb-4 p-3.5 rounded-2xl bg-rose-500/20 border border-rose-500/40 text-rose-200 text-xs sm:text-sm font-semibold flex items-center justify-between shadow-lg shadow-rose-950/40 animate-fadeIn">
          <span className="flex items-center gap-2">⚠️ {error}</span>
          {onClearError && (
            <button
              type="button"
              onClick={onClearError}
              className="text-rose-300 hover:text-white px-2 py-0.5 rounded-lg hover:bg-rose-500/20 transition cursor-pointer"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* If in a Room -> Show Room Cockpit */}
      {room ? (
        <div data-testid="pvp-room-view" className="space-y-6 animate-fadeIn">
          {/* Room Header Banner */}
          <div className="bg-gradient-to-r from-indigo-900/40 via-slate-900/60 to-purple-900/40 border border-indigo-500/30 rounded-3xl p-5 sm:p-6 backdrop-blur-md shadow-xl text-center relative">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs uppercase tracking-widest font-bold text-indigo-400">
                Phòng Thách Đấu 1v1
              </span>
              <button
                type="button"
                onClick={() => setShowRulesModal(true)}
                className="w-7 h-7 rounded-full bg-slate-800/90 hover:bg-indigo-600 border border-slate-600 hover:border-indigo-400 text-slate-200 hover:text-white font-black text-xs flex items-center justify-center transition-all shadow-md cursor-pointer active:scale-95"
                title="Luật chơi và Cơ chế 1v1"
                aria-label="Luật chơi và Cơ chế 1v1"
              >
                ?
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
              <span className="font-mono text-3xl sm:text-4xl font-black text-amber-400 tracking-wider px-2">
                {cleanRoomCode}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="p-2 sm:px-3 sm:py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 text-xs font-semibold flex items-center gap-1.5 transition-all active:scale-95 shadow-md cursor-pointer"
                  title="Sao chép mã phòng"
                >
                  {copiedCode ? <Check className="w-4 h-4 text-emerald-300" /> : <Copy className="w-4 h-4" />}
                  <span className="hidden sm:inline">
                    {copiedCode ? "Đã chép mã!" : "Sao chép mã"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={handleCopyInviteLink}
                  className="p-2 sm:px-3 sm:py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-all active:scale-95 shadow-md shadow-indigo-600/30 cursor-pointer"
                  title="Sao chép link mời"
                >
                  {copiedLink ? <Check className="w-4 h-4 text-emerald-300" /> : <Copy className="w-4 h-4" />}
                  <span className="hidden sm:inline">
                    {copiedLink ? "Đã sao chép!" : "Sao chép link mời"}
                  </span>
                </button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs text-slate-400">
              <span className="px-2.5 py-1 rounded-full bg-slate-800/80 border border-slate-700">
                📚 {room.deckTitle}
              </span>
              <span className="px-2.5 py-1 rounded-full bg-slate-800/80 border border-slate-700">
                🔄 {room.direction === "VI_EN" ? "Tiếng Việt ➔ Tiếng Anh" : "Tiếng Anh ➔ Tiếng Việt"}
              </span>
              <span className="px-2.5 py-1 rounded-full bg-slate-800/80 border border-slate-700 text-amber-400 font-medium">
                ⚡ Tốc độ Cấp {room.speedLevel || 2}
              </span>
              <span className="px-2.5 py-1 rounded-full bg-slate-800/80 border border-slate-700 text-indigo-300 font-medium">
                💡 {room.hintLevel === "EASY" ? "Gợi ý: Dễ (2 chữ)" : room.hintLevel === "HARD" ? "Gợi ý: Siêu khó" : "Gợi ý: Bình thường (1 chữ)"}
              </span>
            </div>
          </div>

          {/* 2 Players Slots Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Host Slot */}
            <div className="bg-slate-900/80 border border-slate-700/60 rounded-2xl p-4 sm:p-5 flex flex-col items-center text-center relative shadow-md">
              <span className="absolute top-3 left-3 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-800">
                Chủ phòng
              </span>

              <PlayerAvatarBadge
                player={room.host}
                isCurrent={isHost}
                role="host"
                myAvatarUrl={myAvatarUrl}
              />

              <h4 className="font-bold text-base text-slate-200">
                {room.host?.displayName || "Chủ phòng"}
              </h4>

              <div className="mt-3">
                {room.host?.ready ? (
                  <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-xs font-bold">
                    <Check className="w-3.5 h-3.5" /> ĐÃ SẴN SÀNG
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 text-xs font-semibold">
                    Đang chuẩn bị...
                  </span>
                )}
              </div>
            </div>

            {/* Guest Slot */}
            <div className="bg-slate-900/80 border border-slate-700/60 rounded-2xl p-4 sm:p-5 flex flex-col items-center text-center relative shadow-md">
              <span className="absolute top-3 left-3 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                Khách
              </span>

              {room.guest ? (
                <>
                  <PlayerAvatarBadge
                    player={room.guest}
                    isCurrent={!isHost && room.guest.userId === currentUserId}
                    role="guest"
                    myAvatarUrl={myAvatarUrl}
                  />

                  <h4 className="font-bold text-base text-slate-200">
                    {room.guest.displayName}
                  </h4>

                  <div className="mt-3">
                    {room.guest.ready ? (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-xs font-bold">
                        <Check className="w-3.5 h-3.5" /> ĐÃ SẴN SÀNG
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 text-xs font-semibold">
                        Đang chuẩn bị...
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-full py-6">
                  <div className="w-14 h-14 rounded-full border-2 border-dashed border-slate-700 flex items-center justify-center text-slate-500 mb-3 animate-pulse">
                    <Users className="w-6 h-6" />
                  </div>
                  <p className="text-xs font-semibold text-slate-400 max-w-[180px]">
                    Đang đợi đối thủ tham gia...
                  </p>
                  <p className="text-[11px] text-slate-500 mt-1">
                    Gửi mã phòng hoặc link mời
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Phase 3 Tactical Skills Loadout Picker */}
          <div className="bg-slate-900/90 border border-slate-700/70 rounded-2xl p-4 shadow-inner">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-amber-400 font-bold text-xs uppercase tracking-wider flex items-center gap-1.5">
                <Swords className="w-3.5 h-3.5 text-amber-400" />
                Trang bị Kỹ năng Chiến thuật (Chọn 3/5)
              </span>
              <span className="text-[11px] font-semibold text-slate-400">
                Đã chọn: <span className="text-indigo-400 font-bold">{selectedSkills.length}/3</span>
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {PVP_SKILLS.map((s) => {
                const isSelected = selectedSkills.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={isMyReady}
                    onClick={() => {
                      if (isMyReady) return;
                      setSelectedSkills((prev) => {
                        if (prev.includes(s.id)) {
                          if (prev.length <= 1) return prev;
                          return prev.filter((id) => id !== s.id);
                        } else {
                          if (prev.length >= 3) {
                            return [...prev.slice(1), s.id];
                          }
                          return [...prev, s.id];
                        }
                      });
                    }}
                    className={`p-2.5 rounded-xl border text-left transition-all relative flex flex-col justify-between ${
                      isMyReady ? "cursor-default opacity-80" : "cursor-pointer active:scale-95"
                    } ${
                      isSelected
                        ? "bg-indigo-950/80 border-indigo-500 shadow-md shadow-indigo-600/30 scale-[1.02]"
                        : "bg-slate-950/60 border-slate-800 hover:border-slate-700 text-slate-400 opacity-60 hover:opacity-90"
                    }`}
                  >
                    <div className="flex items-center justify-between w-full mb-1">
                      <span className="text-base">{s.icon}</span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-extrabold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                        {s.cost} MP
                      </span>
                    </div>
                    <div>
                      <div className={`text-xs font-bold ${isSelected ? "text-white" : "text-slate-300"}`}>
                        {s.name}
                      </div>
                      <div className="text-[10px] text-slate-400 line-clamp-2 mt-0.5 leading-tight">
                        {s.desc}
                      </div>
                    </div>
                    {isSelected && (
                      <div className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400 animate-pulse" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Lobby Actions */}
          <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => onToggleReady(!isMyReady, selectedSkills)}
              className={`w-full flex-1 py-3.5 px-6 rounded-2xl font-bold text-sm tracking-wide transition-all shadow-lg active:scale-95 cursor-pointer flex items-center justify-center gap-2 ${
                isMyReady
                  ? "bg-amber-600 hover:bg-amber-500 text-white shadow-amber-600/30"
                  : "bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white shadow-emerald-500/30"
              }`}
            >
              {isMyReady ? (
                <>
                  <span>HUỶ SẴN SÀNG</span>
                </>
              ) : (
                <>
                  <Check className="w-5 h-5" />
                  <span>SẴN SÀNG CHIẾN ĐẤU!</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onLeaveRoom}
              className="w-full sm:w-auto py-3.5 px-6 rounded-2xl font-semibold text-sm bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 hover:text-white transition-all border border-slate-700/80 cursor-pointer flex items-center justify-center gap-2"
            >
              <LogOut className="w-4 h-4" />
              <span>Rời phòng</span>
            </button>
          </div>
        </div>
      ) : (
        /* If NOT in a Room -> Show Lobby 3 Tabs */
        <div data-testid="pvp-lobby-tabs" className="space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-amber-500 to-orange-500 flex items-center justify-center shadow-md">
                <Swords className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="font-bold text-lg text-slate-100">Đấu trường 1v1 PvP</h3>
                <p className="text-xs text-slate-400">Card Blast Real-time Multiplayer</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowRulesModal(true)}
                className="w-7 h-7 rounded-full bg-slate-800/90 hover:bg-indigo-600 border border-slate-600 hover:border-indigo-400 text-slate-200 hover:text-white font-black text-xs flex items-center justify-center transition-all shadow-md cursor-pointer active:scale-95"
                title="Xem luật chơi và cơ chế"
                aria-label="Xem luật chơi và cơ chế"
              >
                ?
              </button>
              <button
                type="button"
                onClick={onBackToModeSelect}
                className="text-xs font-semibold text-slate-400 hover:text-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
              >
                ← Đổi chế độ
              </button>
            </div>
          </div>

          {/* 3 Nav Tabs */}
          <div className="grid grid-cols-3 gap-1 bg-slate-900/90 p-1 rounded-2xl border border-slate-800">
            <button
              type="button"
              onClick={() => setTab("create")}
              className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                tab === "create"
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <PlusCircle className="w-4 h-4" />
              <span>Tạo phòng</span>
            </button>

            <button
              type="button"
              onClick={() => setTab("join")}
              className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                tab === "join"
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <KeyRound className="w-4 h-4" />
              <span>Vào phòng</span>
            </button>

            <button
              type="button"
              onClick={() => setTab("bot")}
              className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                tab === "bot"
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Bot className="w-4 h-4" />
              <span>Đấu với Bot</span>
            </button>
          </div>

          {/* TAB 1: TẠO PHÒNG */}
          {tab === "create" && (
            <form onSubmit={handleCreateSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Chọn bộ từ vựng
                </label>
                <select
                  value={chosenDeckKey}
                  onChange={(e) => setChosenDeckKey(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">Bộ từ vựng của bản thân (Mặc định)</option>
                  {decks.map((d) => {
                    const val = d.id != null ? String(d.id) : (d.slug || "");
                    return (
                      <option key={d.id ?? d.slug ?? d.title} value={val}>
                          {d.title}{typeof d.totalWords === "number" ? ` (${d.totalWords} từ)` : ""}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Chiều câu hỏi
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setChosenDirection("VI_EN")}
                    className={`py-2.5 px-3 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      chosenDirection === "VI_EN"
                        ? "bg-indigo-950/80 border-indigo-500 text-indigo-300"
                        : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Tiếng Việt ➔ Tiếng Anh
                  </button>
                  <button
                    type="button"
                    onClick={() => setChosenDirection("EN_VI")}
                    className={`py-2.5 px-3 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      chosenDirection === "EN_VI"
                        ? "bg-indigo-950/80 border-indigo-500 text-indigo-300"
                        : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Tiếng Anh ➔ Tiếng Việt
                  </button>
                </div>
              </div>

              {/* MỨC ĐỘ GỢI Ý */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center justify-between">
                  <span>MỨC ĐỘ GỢI Ý</span>
                  <span className="text-[11px] font-normal text-slate-400">
                    {hintLevel === "EASY"
                      ? "Hé 2 chữ đầu (i m _ _ _ _)"
                      : hintLevel === "NORMAL"
                      ? "Hé 1 chữ đầu (i _ _ _ _ _)"
                      : "Không gợi ý gì"}
                  </span>
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setHintLevel("EASY")}
                    className={`py-2 px-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      hintLevel === "EASY"
                        ? "bg-emerald-950/80 border-emerald-500 text-emerald-300 shadow-sm shadow-emerald-500/20"
                        : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Dễ (2 chữ)
                  </button>
                  <button
                    type="button"
                    onClick={() => setHintLevel("NORMAL")}
                    className={`py-2 px-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      hintLevel === "NORMAL"
                        ? "bg-indigo-950/80 border-indigo-500 text-indigo-300 shadow-sm shadow-indigo-500/20"
                        : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Bình thường (1 chữ)
                  </button>
                  <button
                    type="button"
                    onClick={() => setHintLevel("HARD")}
                    className={`py-2 px-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      hintLevel === "HARD"
                        ? "bg-rose-950/80 border-rose-500 text-rose-300 shadow-sm shadow-rose-500/20"
                        : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Siêu khó (0 chữ)
                  </button>
                </div>
              </div>

              {/* TỐC ĐỘ RƠI */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center justify-between">
                  <span>TỐC ĐỘ RƠI</span>
                  <span className="text-[11px] font-normal text-amber-400">
                    {speedLevel === 1 && "Cấp 1: Rất chậm (14s - 10s)"}
                    {speedLevel === 2 && "Cấp 2: Chậm (11s - 8s)"}
                    {speedLevel === 3 && "Cấp 3: Bình thường (9s - 6s)"}
                    {speedLevel === 4 && "Cấp 4: Nhanh (7s - 4.5s)"}
                    {speedLevel === 5 && "Cấp 5: Siêu nhanh (5.5s - 3.5s)"}
                  </span>
                </label>
                <div className="grid grid-cols-5 gap-1.5">
                  {[
                    { lvl: 1, label: "Cấp 1", desc: "Rất chậm" },
                    { lvl: 2, label: "Cấp 2", desc: "Chậm" },
                    { lvl: 3, label: "Cấp 3", desc: "Thường" },
                    { lvl: 4, label: "Cấp 4", desc: "Nhanh" },
                    { lvl: 5, label: "Cấp 5", desc: "Siêu nhanh" },
                  ].map((s) => (
                    <button
                      key={s.lvl}
                      type="button"
                      onClick={() => setSpeedLevel(s.lvl)}
                      className={`py-2 px-1 rounded-xl text-xs font-bold border transition-all cursor-pointer flex flex-col items-center justify-center ${
                        speedLevel === s.lvl
                          ? "bg-amber-950/80 border-amber-500 text-amber-300 shadow-sm shadow-amber-500/20 scale-[1.02]"
                          : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      <span>{s.label}</span>
                      <span className="text-[10px] font-normal opacity-80">{s.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="submit"
                disabled={isCreatingRoom}
                className={`w-full py-3.5 rounded-2xl font-bold text-sm shadow-lg shadow-indigo-600/30 transition-all active:scale-95 cursor-pointer mt-4 flex items-center justify-center gap-2 ${
                  isCreatingRoom
                    ? "bg-indigo-700/70 text-indigo-200 cursor-wait opacity-80"
                    : "bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white"
                }`}
              >
                {isCreatingRoom ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-1" />
                    <span>Đang tạo phòng đấu...</span>
                  </>
                ) : (
                  <>
                    <span>Tạo phòng đấu</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          )}

          {/* TAB 2: VÀO PHÒNG */}
          {tab === "join" && (
            <form onSubmit={handleJoinSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Nhập mã phòng (6 ký tự)
                </label>
                <input
                  ref={inputRef}
                  type="text"
                  maxLength={6}
                  value={joinCodeInput}
                  onChange={(e) => {
                    const sanitized = e.target.value.replace(/[\s-]/g, "").toUpperCase().slice(0, 6);
                    setJoinCodeInput(sanitized);
                  }}
                  onPaste={(e) => {
                    e.preventDefault();
                    const pasted = e.clipboardData.getData("text") || "";
                    const sanitized = pasted.replace(/[\s-]/g, "").toUpperCase().slice(0, 6);
                    setJoinCodeInput(sanitized);
                  }}
                  placeholder="VD: D2WB5W"
                  className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-4 py-3 text-center font-mono text-2xl font-bold tracking-widest text-amber-400 focus:outline-none focus:border-amber-500 uppercase placeholder:text-slate-600 placeholder:text-base"
                />
              </div>

              <button
                type="submit"
                disabled={joinCodeInput.trim().length !== 6 || isJoiningRoom}
                className={`w-full py-3.5 rounded-2xl font-bold text-sm shadow-lg transition-all active:scale-95 cursor-pointer flex items-center justify-center gap-2 ${
                  joinCodeInput.trim().length === 6 && !isJoiningRoom
                    ? "bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white shadow-amber-600/30"
                    : "bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/60"
                }`}
              >
                {isJoiningRoom ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-1" />
                    <span>Đang vào phòng...</span>
                  </>
                ) : (
                  <>
                    <span>Vào phòng</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          )}

          {/* TAB 3: ĐẤU VỚI BOT ECHO */}
          {tab === "bot" && (
            <form onSubmit={handleBotSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Chọn bộ từ vựng
                </label>
                <select
                  value={chosenDeckKey}
                  onChange={(e) => setChosenDeckKey(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">Bộ từ vựng của bản thân (Mặc định)</option>
                  {decks.map((d) => {
                    const val = d.id != null ? String(d.id) : (d.slug || "");
                    return (
                      <option key={d.id ?? d.slug ?? d.title} value={val}>
                          {d.title}{typeof d.totalWords === "number" ? ` (${d.totalWords} từ)` : ""}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Độ khó của Bot Echo
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setBotLevel("EASY")}
                    className={`py-2 px-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      botLevel === "EASY"
                        ? "bg-emerald-950/80 border-emerald-500 text-emerald-300"
                        : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Dễ (65%)
                  </button>
                  <button
                    type="button"
                    onClick={() => setBotLevel("NORMAL")}
                    className={`py-2 px-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      botLevel === "NORMAL"
                        ? "bg-indigo-950/80 border-indigo-500 text-indigo-300"
                        : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Thường (82%)
                  </button>
                  <button
                    type="button"
                    onClick={() => setBotLevel("HARD")}
                    className={`py-2 px-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      botLevel === "HARD"
                        ? "bg-rose-950/80 border-rose-500 text-rose-300"
                        : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Khó (93%)
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Chiều câu hỏi
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setChosenDirection("VI_EN")}
                    className={`py-2.5 px-3 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      chosenDirection === "VI_EN"
                        ? "bg-indigo-950/80 border-indigo-500 text-indigo-300"
                        : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Tiếng Việt ➔ Tiếng Anh
                  </button>
                  <button
                    type="button"
                    onClick={() => setChosenDirection("EN_VI")}
                    className={`py-2.5 px-3 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      chosenDirection === "EN_VI"
                        ? "bg-indigo-950/80 border-indigo-500 text-indigo-300"
                        : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Tiếng Anh ➔ Tiếng Việt
                  </button>
                </div>
              </div>

              {/* MỨC ĐỘ GỢI Ý (ĐẤU VỚI BOT) */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center justify-between">
                  <span>MỨC ĐỘ GỢI Ý</span>
                  <span className="text-[11px] font-normal text-slate-400">
                    {hintLevel === "EASY"
                      ? "Hé 2 chữ đầu (i m _ _ _ _)"
                      : hintLevel === "NORMAL"
                      ? "Hé 1 chữ đầu (i _ _ _ _ _)"
                      : "Không gợi ý gì"}
                  </span>
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setHintLevel("EASY")}
                    className={`py-2 px-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      hintLevel === "EASY"
                        ? "bg-emerald-950/80 border-emerald-500 text-emerald-300 shadow-sm shadow-emerald-500/20"
                        : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Dễ (2 chữ)
                  </button>
                  <button
                    type="button"
                    onClick={() => setHintLevel("NORMAL")}
                    className={`py-2 px-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      hintLevel === "NORMAL"
                        ? "bg-indigo-950/80 border-indigo-500 text-indigo-300 shadow-sm shadow-indigo-500/20"
                        : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Bình thường (1 chữ)
                  </button>
                  <button
                    type="button"
                    onClick={() => setHintLevel("HARD")}
                    className={`py-2 px-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      hintLevel === "HARD"
                        ? "bg-rose-950/80 border-rose-500 text-rose-300 shadow-sm shadow-rose-500/20"
                        : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Siêu khó (0 chữ)
                  </button>
                </div>
              </div>

              {/* TỐC ĐỘ RƠI (ĐẤU VỚI BOT) */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center justify-between">
                  <span>TỐC ĐỘ RƠI</span>
                  <span className="text-[11px] font-normal text-amber-400">
                    {speedLevel === 1 && "Cấp 1: Rất chậm (14s - 10s)"}
                    {speedLevel === 2 && "Cấp 2: Chậm (11s - 8s)"}
                    {speedLevel === 3 && "Cấp 3: Bình thường (9s - 6s)"}
                    {speedLevel === 4 && "Cấp 4: Nhanh (7s - 4.5s)"}
                    {speedLevel === 5 && "Cấp 5: Siêu nhanh (5.5s - 3.5s)"}
                  </span>
                </label>
                <div className="grid grid-cols-5 gap-1.5">
                  {[
                    { lvl: 1, label: "Cấp 1", desc: "Rất chậm" },
                    { lvl: 2, label: "Cấp 2", desc: "Chậm" },
                    { lvl: 3, label: "Cấp 3", desc: "Thường" },
                    { lvl: 4, label: "Cấp 4", desc: "Nhanh" },
                    { lvl: 5, label: "Cấp 5", desc: "Siêu nhanh" },
                  ].map((s) => (
                    <button
                      key={s.lvl}
                      type="button"
                      onClick={() => setSpeedLevel(s.lvl)}
                      className={`py-2 px-1 rounded-xl text-xs font-bold border transition-all cursor-pointer flex flex-col items-center justify-center ${
                        speedLevel === s.lvl
                          ? "bg-amber-950/80 border-amber-500 text-amber-300 shadow-sm shadow-amber-500/20 scale-[1.02]"
                          : "bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      <span>{s.label}</span>
                      <span className="text-[10px] font-normal opacity-80">{s.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="submit"
                disabled={isCreatingRoom}
                className={`w-full py-3.5 rounded-2xl font-bold text-sm shadow-lg shadow-cyan-600/30 transition-all active:scale-95 cursor-pointer mt-4 flex items-center justify-center gap-2 ${
                  isCreatingRoom
                    ? "bg-teal-700/70 text-teal-200 cursor-wait opacity-80"
                    : "bg-gradient-to-r from-teal-500 to-cyan-600 hover:from-teal-600 hover:to-cyan-700 text-white"
                }`}
              >
                {isCreatingRoom ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-1" />
                    <span>Đang khởi tạo trận đấu...</span>
                  </>
                ) : (
                  <>
                    <span>🤖 Bắt đầu đấu với Bot Echo</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Rules & Mechanics Modal */}
      <PvPRulesModal isOpen={showRulesModal} onClose={() => setShowRulesModal(false)} />
    </div>
  );
}
