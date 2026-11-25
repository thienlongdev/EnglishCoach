"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import { apiClient } from "@/services/api-client";
import { invalidateLeaderboardCaches } from "@/hooks/useLeaderboard";
import { VocabDeckSummary } from "../DeckCatalogView";
import { CardBlastEngine, BlastWord, GameDirection, GameDifficulty } from "./CardBlastEngine";
import { PvPLobby } from "../pvp/PvPLobby";
import { PvPResultModal } from "../pvp/PvPResultModal";
import { useCardBlastPvP } from "../pvp/useCardBlastPvP";
import { StrictModeGate, StrictExitConfirm, AttemptVoided } from "@/components/sentinel/StrictModeDialogs";
import { useFocusLockdown } from "@/components/sentinel/useFocusLockdown";
import { beginAttempt, isVoided, sentinelHandle } from "@/lib/sentinel/client";
import type { SentinelAttempt } from "@/lib/sentinel/client";
import {
  Gamepad2,
  Zap,
  RotateCcw,
  BookOpen,
  Volume2,
  Trophy,
  Target,
  Flame,
  X,
  ArrowRight,
  ShieldAlert,
  Check,
  Award,
  Play,
  Settings2,
  Swords,
  User,
} from "lucide-react";

interface DictionaryEntry {
  id?: number;
  word: string;
  ipa?: string;
  generalTranslationVi?: string;
  meanings: string[];
  examples: string[];
}

interface Flashcard {
  id: number;
  dictionaryEntry: DictionaryEntry;
  nextReviewDate?: string;
  status?: string;
  reviewCount?: number;
}

export interface CardBlastModalProps {
  isOpen: boolean;
  onClose: () => void;
  deck: VocabDeckSummary | null;
  availableCards?: Flashcard[];
  allDecks?: VocabDeckSummary[];
  initialPvpCode?: string;
}

interface GameSummaryData {
  score: number;
  accuracy: number;
  maxStreak: number;
  hits: number;
  totalAttempts: number;
  missedWords: BlastWord[];
  isCleared: boolean;
}

export type CardBlastModalPhase =
  | "mode-select"
  | "config"
  | "pvp-lobby"
  | "playing"
  | "summary"
  | "loading";

export function CardBlastModal({
  isOpen,
  onClose,
  deck,
  availableCards = [],
  allDecks = [],
  initialPvpCode,
}: CardBlastModalProps) {
  const searchParams = useSearchParams();
  const urlPvpCode = searchParams?.get("pvp") || initialPvpCode || "";

  // Modal phases: 'mode-select' | 'config' | 'pvp-lobby' | 'playing' | 'summary' | 'loading'
  const [phase, setPhase] = useState<CardBlastModalPhase>("mode-select");
  const [deckCatalog, setDeckCatalog] = useState<VocabDeckSummary[]>(allDecks);
  const [dissolvedToast, setDissolvedToast] = useState<string | null>(null);

  const pvp = useCardBlastPvP({
    onRoomDissolved: (message) => {
      pvp.leaveRoom();
      setPhase("mode-select");
      setDissolvedToast(message);
      if (typeof window !== "undefined" && window.location.search.includes("pvp=")) {
        const url = new URL(window.location.href);
        url.searchParams.delete("pvp");
        window.history.replaceState({}, "", url.toString());
      }
      setTimeout(() => setDissolvedToast(null), 5000);
    },
  });

  // Prepare the authenticated private response channel while mode/configuration
  // is visible. Opening the modal never creates a room.
  useEffect(() => {
    if (isOpen) void pvp.connect();
  }, [isOpen, pvp.connect]);

  // Pre-game config states
  const [direction, setDirection] = useState<GameDirection>("VI_EN"); // Default VI -> EN per reference
  const [difficulty, setDifficulty] = useState<GameDifficulty>("normal");
  const [speedLevel, setSpeedLevel] = useState<number>(3); // 1 to 5

  // Word pool
  const [words, setWords] = useState<BlastWord[]>([]);
  const [isLoadingWords, setIsLoadingWords] = useState(false);

  // Run results
  const [summary, setSummary] = useState<GameSummaryData | null>(null);

  // Audio speech player for weak words review
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const playWordAudio = useCallback((text: string) => {
    if (!text || typeof window === "undefined") return;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      window.speechSynthesis.speak(utterance);
    }
  }, []);

  // Fetch words when modal opens
  const loadWordPool = useCallback(async () => {
    setIsLoadingWords(true);
    let rawCards: Flashcard[] = [];

    try {
      if (deck?.id) {
        const res = await apiClient.get<any>(`/flashcards?deckId=${deck.id}&page=0&size=100`);
        const data = res.data;
        rawCards = Array.isArray(data) ? data : data?.content || data?.data || [];
      }
    } catch {
      // Fallback to availableCards passed from parent
    }

    if (!rawCards || rawCards.length === 0) {
      rawCards = availableCards;
    }

    const transformed: BlastWord[] = rawCards
      .map((c) => ({
        id: c.id,
        word: c.dictionaryEntry?.word?.trim() || "",
        ipa: c.dictionaryEntry?.ipa?.trim(),
        vietnamese:
          c.dictionaryEntry?.generalTranslationVi?.trim() ||
          c.dictionaryEntry?.meanings?.[0]?.trim() ||
          "",
        allMeanings: c.dictionaryEntry?.meanings || [],
        example: c.dictionaryEntry?.examples?.[0]?.trim(),
      }))
      .filter((w) => !!w.word && !!w.vietnamese);

    setWords(transformed);
    setIsLoadingWords(false);
  }, [deck, availableCards]);

  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      setSummary(null);
      loadWordPool();

      if (urlPvpCode) {
        setPhase("pvp-lobby");
        pvp.connect();
      } else {
        setPhase("mode-select");
      }
    } else if (!isOpen && prevIsOpenRef.current) {
      if (pvp.room || pvp.isCreatingRoom) {
        pvp.leaveRoom();
      }
      setPhase("mode-select");
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, urlPvpCode, loadWordPool, pvp]);

  useEffect(() => {
    if (allDecks && allDecks.length > 0) {
      setDeckCatalog(allDecks);
      return;
    }
    apiClient
      .get<VocabDeckSummary[]>("/flashcards/decks")
      .then((res) => {
        if (Array.isArray(res.data)) {
          setDeckCatalog(res.data);
        }
      })
      .catch(() => {});
  }, [allDecks]);

  // The server counts a solo run only when it started that run itself: ask for a run id before play begins and
  // send it back with the result. A failed request keeps the previous id; the game is playable either way.
  const runIdRef = useRef<string | null>(null);
  const requestRun = useCallback(async (sentinel?: string) => {
    try {
      const res = await apiClient.post<{ runId?: string }>("/flashcards/card-blast/start-run", {
        deckId: deck?.id || null,
        sentinel,
      });
      if (res.data?.runId) runIdRef.current = res.data.runId;
    } catch {
      /* no new run id: the result of this run may not be counted */
    }
  }, [deck]);

  // Echo Sentinel (10 §BX): a solo run and a 1v1 match against a person count only as acknowledged strict attempts.
  const [strictGate, setStrictGate] = useState<null | "solo" | "pvp">(null);
  const [strictBusy, setStrictBusy] = useState(false);
  const [strictError, setStrictError] = useState<string | null>(null);
  const [strictAttempt, setStrictAttempt] = useState<{ kind: "solo" | "pvp"; attempt: SentinelAttempt } | null>(null);
  const [strictVoid, setStrictVoid] = useState<string | null>(null);
  const [strictExitAsk, setStrictExitAsk] = useState(false);
  const pendingSkillsRef = useRef<string[] | undefined>(undefined);
  const acceptStrictGate = async () => {
    const kind = strictGate;
    if (!kind) return;
    setStrictBusy(true);
    setStrictError(null);
    try {
      const attempt = await beginAttempt(kind === "solo" ? "CARD_BLAST_SOLO" : "CARD_BLAST_PVP");
      setStrictAttempt({ kind, attempt });
      setStrictVoid(null);
      setStrictGate(null);
      if (kind === "solo") {
        await requestRun(sentinelHandle(attempt));
        setSummary(null);
        setPhase("playing");
      } else {
        pvp.toggleReady(true, pendingSkillsRef.current, sentinelHandle(attempt));
      }
    } catch {
      setStrictError("Chưa thể mở lượt thi xếp hạng lúc này. Hãy thử lại sau ít phút.");
    } finally {
      setStrictBusy(false);
    }
  };
  const strictLive =
    !!strictAttempt &&
    !strictVoid &&
    ((strictAttempt.kind === "solo" && phase === "playing" && !summary) ||
      (strictAttempt.kind === "pvp" && (pvp.room?.status === "COUNTDOWN" || pvp.room?.status === "IN_GAME")));
  useFocusLockdown({
    attempt: strictAttempt?.attempt ?? null,
    active: strictLive,
    onStatus: (state) => { if (isVoided(state)) { setStrictVoid(state); if (strictAttempt?.kind === "solo") setPhase("mode-select"); } },
  });

  // Start game CTA
  const handleStartGame = () => {
    if (words.length === 0) return;
    setStrictError(null);
    setStrictGate("solo");
  };

  // Game over callback from Canvas engine
  const handleGameOver = useCallback(
    async (results: {
      score: number;
      accuracy: number;
      maxStreak: number;
      hits: number;
      totalAttempts: number;
      missedWords: BlastWord[];
    }) => {
      const summaryData: GameSummaryData = {
        ...results,
        isCleared: results.missedWords.length === 0 && results.hits > 0,
      };
      setSummary(summaryData);
      // Keep CardBlastEngine mounted so the canvas scene remains frozen in background

      // Auto-sync run log to PostgreSQL backend (NO Redis)
      try {
        const weakWordIds = results.missedWords.map((w) => w.id);
        const runId = runIdRef.current;
        runIdRef.current = null;
        await apiClient.post("/flashcards/card-blast/finish-run", {
          runId,
          deckId: deck?.id || null,
          score: results.score,
          accuracy: results.accuracy,
          weakWordIds,
          // leaderboard points use the words typed correctly (server-capped), not the streak-multiplied score
          hits: results.hits,
          totalAttempts: results.totalAttempts,
        });
        // the run scores leaderboard XP: no cached board / "Hạng của bạn" may keep the old value
        invalidateLeaderboardCaches();
      } catch (err) {
        console.warn("Failed to record Card Blast run to backend:", err);
      }
      // A next run is a new strict attempt: it starts from the warning again (handleRestart / handleStartGame).
    },
    [deck]
  );

  // Restart run with fresh 100 HP: a new acknowledged attempt from the beginning
  const handleRestart = () => {
    setStrictError(null);
    setStrictGate("solo");
  };

  // Calculate Rank Badge based on accuracy and combo
  const getRankBadge = (accuracy: number, maxStreak: number) => {
    if (accuracy >= 85 && maxStreak >= 8) {
      return { title: "Thiện xạ", icon: "🎯", color: "from-amber-400 to-yellow-500 text-amber-950" };
    }
    if (accuracy >= 60) {
      return { title: "Xạ thủ", icon: "🏹", color: "from-sky-400 to-indigo-500 text-white" };
    }
    return { title: "Tân binh", icon: "🔰", color: "from-slate-400 to-slate-600 text-white" };
  };

// ==============================================================
// IMMERSIVE COSMIC SPACE BACKGROUND (60 FPS DRIFTING STARS & NEBULA)
// ==============================================================
function CosmicSpaceBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let width = 0;
    let height = 0;

    interface CosmicStar {
      x: number;
      y: number;
      r: number;
      alpha: number;
      speed: number;
      pulsePhase: number;
      pulseSpeed: number;
    }
    const stars: CosmicStar[] = [];

    const handleResize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (stars.length === 0) {
        for (let i = 0; i < 75; i++) {
          stars.push({
            x: Math.random() * width,
            y: Math.random() * height,
            r: Math.random() * 1.2 + 0.6,
            alpha: Math.random() * 0.45 + 0.3,
            speed: 0.25 + Math.random() * 0.85,
            pulsePhase: Math.random() * Math.PI * 2,
            pulseSpeed: 0.02 + Math.random() * 0.03,
          });
        }
      }
    };

    handleResize();
    window.addEventListener("resize", handleResize);

    const render = () => {
      // 1. Midnight cosmic gradient matching in-game arena (#050716 -> #090d26)
      const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
      bgGrad.addColorStop(0, "#050716");
      bgGrad.addColorStop(1, "#090d26");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      // 2. Soft nebula glows
      const maxDim = Math.max(width, height);

      // Nebula 1 (Indigo/Violet - top-left)
      const neb1 = ctx.createRadialGradient(
        width * 0.22,
        height * 0.26,
        0,
        width * 0.22,
        height * 0.26,
        maxDim * 0.48
      );
      neb1.addColorStop(0, "rgba(99, 102, 241, 0.12)");
      neb1.addColorStop(1, "rgba(99, 102, 241, 0)");
      ctx.fillStyle = neb1;
      ctx.fillRect(0, 0, width, height);

      // Nebula 2 (Cyan/Teal - bottom-right)
      const neb2 = ctx.createRadialGradient(
        width * 0.78,
        height * 0.72,
        0,
        width * 0.78,
        height * 0.72,
        maxDim * 0.48
      );
      neb2.addColorStop(0, "rgba(20, 184, 166, 0.09)");
      neb2.addColorStop(1, "rgba(20, 184, 166, 0)");
      ctx.fillStyle = neb2;
      ctx.fillRect(0, 0, width, height);

      // Nebula 3 (Cosmic Purple - center)
      const neb3 = ctx.createRadialGradient(
        width * 0.52,
        height * 0.48,
        0,
        width * 0.52,
        height * 0.48,
        maxDim * 0.38
      );
      neb3.addColorStop(0, "rgba(168, 85, 247, 0.07)");
      neb3.addColorStop(1, "rgba(168, 85, 247, 0)");
      ctx.fillStyle = neb3;
      ctx.fillRect(0, 0, width, height);

      // 3. Drifting starfield with twinkling
      for (const st of stars) {
        st.y += st.speed;
        if (st.y > height) {
          st.y = -5;
          st.x = Math.random() * width;
        }
        st.pulsePhase += st.pulseSpeed;
        const currentAlpha = Math.max(0.15, Math.min(0.95, st.alpha + Math.sin(st.pulsePhase) * 0.28));

        ctx.fillStyle = `rgba(255, 255, 255, ${currentAlpha})`;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full block pointer-events-none"
    />
  );
}

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#050716] overflow-hidden select-none animate-in fade-in duration-200">
      {strictGate && (
        <StrictModeGate vi busy={strictBusy} error={strictError} graceSeconds={20}
          onAccept={() => void acceptStrictGate()} onBack={() => setStrictGate(null)} />
      )}
      {!strictGate && strictExitAsk && strictLive && (
        <StrictExitConfirm vi onStay={() => setStrictExitAsk(false)}
          onLeave={() => { setStrictExitAsk(false); if (strictAttempt?.kind === "pvp") { pvp.leaveRoom(); setPhase("mode-select"); } else onClose(); }} />
      )}
      {!strictGate && strictVoid && (
        <AttemptVoided vi state={strictVoid}
          onRestart={strictAttempt?.kind === "solo" ? () => { setStrictVoid(null); setStrictGate("solo"); } : undefined}
          onLobby={() => { setStrictVoid(null); if (strictAttempt?.kind === "pvp") { pvp.leaveRoom(); } setPhase("mode-select"); }} />
      )}
      {/* Dissolved Room Toast Notification */}
      {dissolvedToast && (
        <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[70] px-5 py-3 rounded-2xl bg-slate-900/95 border border-amber-500/50 text-amber-200 text-sm font-semibold shadow-2xl backdrop-blur-xl flex items-center gap-3 animate-in fade-in slide-in-from-top-4 duration-300 pointer-events-none">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping flex-shrink-0" />
          <span>{dissolvedToast}</span>
        </div>
      )}

      {/* Immersive Cosmic Space Background for Pre-game and Summary views */}
      {phase !== "playing" && !(phase === "pvp-lobby" && (pvp.phase === "COUNTDOWN" || pvp.phase === "PLAYING")) && (
        <CosmicSpaceBackground />
      )}

      {/* ============================================================== */}
      {/* 0. MODE SELECTION SCREEN (SINGLE PLAYER VS 1V1 PVP) */}
      {/* ============================================================== */}
      {phase === "mode-select" && (
        <div className="relative z-10 w-full max-w-xl mx-4 p-6 sm:p-8 rounded-3xl bg-slate-900/95 border border-slate-700/80 shadow-[0_0_60px_rgba(30,58,138,0.45)] backdrop-blur-xl flex flex-col gap-6 animate-in zoom-in-95 duration-200">
          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            className="absolute top-5 right-5 p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Header */}
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 via-blue-600 to-cyan-500 flex items-center justify-center shadow-[0_0_25px_rgba(79,70,229,0.4)]">
              <Gamepad2 className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight">
                  Game Bắn Chữ
                </h2>
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase bg-indigo-500/20 text-indigo-400 border border-indigo-500/40">
                  Arcade Hub
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Chọn chế độ luyện tập phản xạ từ vựng
              </p>
            </div>
          </div>

          {/* 2 Mode Selection Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Mode 1: Single Player */}
            <button
              type="button"
              onClick={() => setPhase("config")}
              className="group p-5 rounded-2xl bg-slate-800/50 hover:bg-slate-800 border border-slate-700/80 hover:border-indigo-500/80 transition-all duration-200 text-left flex flex-col justify-between gap-4 cursor-pointer hover:shadow-[0_0_30px_rgba(99,102,241,0.25)] hover:scale-[1.02] active:scale-98"
            >
              <div className="flex flex-col gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 group-hover:bg-indigo-500 group-hover:text-white transition-all">
                  <User className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-white flex items-center gap-1.5">
                    <span>Luyện tập Đơn</span>
                    <span className="text-xs">👤</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    Luyện tập một mình với kỹ năng chiến thuật, hồi năng lượng Mana và phục thù từ khó.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 text-xs font-bold text-indigo-400 group-hover:text-indigo-300">
                <span>Vào luyện tập</span>
                <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
              </div>
            </button>

            {/* Mode 2: 1v1 PvP */}
            <button
              type="button"
              onClick={() => {
                pvp.connect();
                setPhase("pvp-lobby");
              }}
              className="group p-5 rounded-2xl bg-gradient-to-br from-indigo-950/40 via-purple-950/30 to-slate-900 border border-purple-500/40 hover:border-purple-400 transition-all duration-200 text-left flex flex-col justify-between gap-4 cursor-pointer hover:shadow-[0_0_30px_rgba(168,85,247,0.3)] hover:scale-[1.02] active:scale-98"
            >
              <div className="flex flex-col gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-500/40 flex items-center justify-center text-purple-400 group-hover:bg-purple-500 group-hover:text-white transition-all">
                  <Swords className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-white flex items-center gap-1.5">
                    <span>Thách đấu 1v1 (PvP)</span>
                    <span className="text-xs">⚔️</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    Đấu trí thời gian thực cùng bạn bè qua mã phòng hoặc đọ sức cùng Bot Echo.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 text-xs font-bold text-purple-400 group-hover:text-purple-300">
                <span>Vào đấu trường</span>
                <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
              </div>
            </button>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* 0.5 PVP LOBBY, ARENA & RESULTS SCREEN */}
      {/* ============================================================== */}
      {phase === "pvp-lobby" && (
        <>
          {pvp.phase === "RESULT" && pvp.result ? (
            <>
              <div className="relative z-10 w-full h-full">
                <CardBlastEngine
                  words={
                    pvp.schedule && pvp.schedule.length > 0
                      ? pvp.schedule.map((s) => ({
                          id: s.wordId,
                          word: s.word,
                          ipa: s.ipa,
                          vietnamese: s.vietnamese,
                          allMeanings: s.targetAnswers || [],
                          example: "",
                        }))
                      : words
                  }
                  direction={pvp.room?.direction || direction}
                  difficulty={pvp.room?.hintLevel === "EASY" ? "easy" : pvp.room?.hintLevel === "HARD" ? "hard" : "normal"}
                  speedLevel={pvp.room?.speedLevel || 2}
                  deckTitle={pvp.room?.deckTitle || deck?.title || "PvP 1v1"}
                  onExit={() => {
                    pvp.leaveRoom();
                    setPhase("mode-select");
                  }}
                  pvp={{
                    schedule: pvp.schedule,
                    matchStartServerMs: pvp.matchStartServerMs || 0,
                    clockOffset: pvp.clockOffset,
                    myState: pvp.myState,
                    opponent: pvp.opponent,
                    sendHit: pvp.sendHit,
                    sendGameOver: pvp.sendGameOver,
                    phase: "RESULT",
                    result: pvp.result,
                    incomingAttack: pvp.incomingAttack,
                    parryEvent: pvp.parryEvent,
                    goldenWord: pvp.goldenWord,
                    goldenTaken: pvp.goldenTaken,
                    lastStandPlayers: pvp.lastStandPlayers,
                    isLocalPlayerInLastStand: pvp.isLocalPlayerInLastStand,
                    suddenDeath: pvp.suddenDeath,
                    latestReaction: pvp.latestReaction,
                    sendReaction: pvp.sendReaction,
                    shieldAbsorbed: pvp.shieldAbsorbed,
                    echoChainEvent: pvp.echoChainEvent,
                    fogActiveUntilMs: pvp.fogActiveUntilMs,
                    fogOpponentUntilMs: pvp.fogOpponentUntilMs,
                    shieldActiveUntilMs: pvp.shieldActiveUntilMs,
                    sendSkill: pvp.sendSkill,
                    hintLevel: pvp.room?.hintLevel || "NORMAL",
                    speedLevel: pvp.room?.speedLevel || 2,
                  }}
                />
              </div>
              <PvPResultModal
                result={pvp.result}
                currentUserId={pvp.currentUserId}
                isHost={pvp.isHost}
                rematchRequested={!!pvp.myState?.rematchRequested}
                onRematch={() => {
                  if (pvp.result?.reason === "FORFEIT") {
                    pvp.leaveRoom();
                    setPhase("mode-select");
                    setDissolvedToast("Đối thủ đã rời đi. Vui lòng tạo hoặc tham gia phòng mới.");
                    setTimeout(() => setDissolvedToast(null), 5000);
                  } else {
                    pvp.requestRematch();
                  }
                }}
                onExit={() => {
                  pvp.leaveRoom();
                  setPhase("mode-select");
                }}
              />
            </>
          ) : pvp.phase === "COUNTDOWN" || pvp.phase === "PLAYING" ? (
            <div className="relative z-10 w-full h-full">
              <CardBlastEngine
                words={
                  pvp.schedule && pvp.schedule.length > 0
                    ? pvp.schedule.map((s) => ({
                        id: s.wordId,
                        word: s.word,
                        ipa: s.ipa,
                        vietnamese: s.vietnamese,
                        allMeanings: s.targetAnswers || [],
                        example: "",
                      }))
                    : words
                }
                direction={pvp.room?.direction || direction}
                difficulty={pvp.room?.hintLevel === "EASY" ? "easy" : pvp.room?.hintLevel === "HARD" ? "hard" : "normal"}
                speedLevel={pvp.room?.speedLevel || 2}
                deckTitle={pvp.room?.deckTitle || deck?.title || "PvP 1v1"}
                onExit={() => {
                  pvp.leaveRoom();
                  setPhase("mode-select");
                }}
                pvp={{
                  schedule: pvp.schedule,
                  matchStartServerMs: pvp.matchStartServerMs || 0,
                  clockOffset: pvp.clockOffset,
                  myState: pvp.myState,
                  opponent: pvp.opponent,
                  sendHit: pvp.sendHit,
                  sendGameOver: pvp.sendGameOver,
                  phase: pvp.phase === "COUNTDOWN" ? "COUNTDOWN" : "PLAYING",
                  result: pvp.result,
                  incomingAttack: pvp.incomingAttack,
                  parryEvent: pvp.parryEvent,
                  goldenWord: pvp.goldenWord,
                  goldenTaken: pvp.goldenTaken,
                  lastStandPlayers: pvp.lastStandPlayers,
                  isLocalPlayerInLastStand: pvp.isLocalPlayerInLastStand,
                  suddenDeath: pvp.suddenDeath,
                  latestReaction: pvp.latestReaction,
                  sendReaction: pvp.sendReaction,
                  shieldAbsorbed: pvp.shieldAbsorbed,
                  echoChainEvent: pvp.echoChainEvent,
                  fogActiveUntilMs: pvp.fogActiveUntilMs,
                  fogOpponentUntilMs: pvp.fogOpponentUntilMs,
                  shieldActiveUntilMs: pvp.shieldActiveUntilMs,
                  sendSkill: pvp.sendSkill,
                  hintLevel: pvp.room?.hintLevel || "NORMAL",
                  speedLevel: pvp.room?.speedLevel || 2,
                }}
              />
            </div>
          ) : (
            <div className="relative z-10 w-full max-w-xl mx-4 p-6 sm:p-8 rounded-3xl bg-slate-900/95 border border-slate-700/80 shadow-[0_0_60px_rgba(30,58,138,0.45)] backdrop-blur-xl flex flex-col gap-6 animate-in zoom-in-95 duration-200 max-h-[95vh] overflow-y-auto">
              <PvPLobby
                room={pvp.room}
                currentUserId={pvp.currentUserId}
                isHost={pvp.isHost}
                decks={deckCatalog}
                selectedDeck={deck}
                initialCode={urlPvpCode || undefined}
                error={pvp.error}
                onClearError={() => pvp.setError(null)}
                isCreatingRoom={pvp.isCreatingRoom}
                isJoiningRoom={pvp.isJoiningRoom}
                onCreateRoom={(params) => {
                  pvp.createRoom(params);
                }}
                onJoinRoom={(code, avatar) => pvp.joinRoom(code, avatar)}
                onLeaveRoom={() => {
                  pvp.leaveRoom();
                  setPhase("mode-select");
                }}
                onToggleReady={(ready, skills) => {
                  // A ready vote against a person opens the strict warning first; against Echo bots nothing changes.
                  if (ready && pvp.room?.mode === "HUMAN") { pendingSkillsRef.current = skills; setStrictError(null); setStrictGate("pvp"); }
                  else pvp.toggleReady(ready, skills);
                }}
                onBackToModeSelect={() => {
                  pvp.leaveRoom();
                  setPhase("mode-select");
                }}
              />
            </div>
          )}
        </>
      )}

      {/* ============================================================== */}
      {/* 1. PRE-GAME CONFIGURATION SCREEN (CENTERED GALAXY CARD) */}
      {/* ============================================================== */}
      {phase === "config" && (
        <div className="relative z-10 w-full max-w-xl mx-4 p-6 sm:p-8 rounded-3xl bg-slate-900/95 border border-slate-700/80 shadow-[0_0_60px_rgba(30,58,138,0.45)] backdrop-blur-xl flex flex-col gap-6 animate-in zoom-in-95 duration-200 max-h-[95vh] overflow-y-auto">
          {/* Row 1 (Top Bar): Back to mode selection button on far left, Close button on far right */}
          <div className="flex items-center justify-between w-full">
            <button
              type="button"
              onClick={() => setPhase("mode-select")}
              className="px-3 py-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1 transition cursor-pointer"
            >
              ← Đổi chế độ
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Row 2 (Centered Title): Gamepad icon + Game Bắn Chữ + ARCADE HUD badge centered with mt-2 mb-4 */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3.5 mt-2 mb-4 text-center sm:text-left">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 via-blue-600 to-cyan-500 flex items-center justify-center shadow-[0_0_25px_rgba(79,70,229,0.4)] shrink-0">
              <Gamepad2 className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center justify-center sm:justify-start gap-2">
                <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight">
                  Game Bắn Chữ
                </h2>
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase bg-indigo-500/20 text-indigo-400 border border-indigo-500/40">
                  Arcade HUD
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {deck?.title || "Bộ từ vựng"} • {words.length} từ khả dụng
              </p>
            </div>
          </div>

          {/* Form options */}
          <div className="flex flex-col gap-5">
            {/* 1. Mode: [Việt -> Anh] vs [Anh -> Việt] */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-400">
                1. Chiều luyện tập
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setDirection("VI_EN")}
                  className={`p-3.5 rounded-2xl border text-left transition cursor-pointer ${
                    direction === "VI_EN"
                      ? "bg-indigo-600/20 border-indigo-500 text-white shadow-[0_0_20px_rgba(99,102,241,0.3)] ring-1 ring-indigo-400/50"
                      : "bg-slate-800/40 border-slate-800 text-slate-400 hover:bg-slate-800/80 hover:text-slate-200"
                  }`}
                >
                  <p className="font-extrabold text-sm text-indigo-300">Việt → Anh</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Nghĩa rơi xuống • gõ từ tiếng Anh
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setDirection("EN_VI")}
                  className={`p-3.5 rounded-2xl border text-left transition cursor-pointer ${
                    direction === "EN_VI"
                      ? "bg-indigo-600/20 border-indigo-500 text-white shadow-[0_0_20px_rgba(99,102,241,0.3)] ring-1 ring-indigo-400/50"
                      : "bg-slate-800/40 border-slate-800 text-slate-400 hover:bg-slate-800/80 hover:text-slate-200"
                  }`}
                >
                  <p className="font-extrabold text-sm text-indigo-300">Anh → Việt</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Từ rơi xuống • gõ nghĩa tiếng Việt
                  </p>
                </button>
              </div>
            </div>

            {/* 2. Difficulty Level */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-400">
                2. Mức độ gợi ý
              </label>
              <div className="grid grid-cols-3 gap-2.5">
                {[
                  { id: "easy", name: "Dễ", desc: "Hé lộ 2 chữ cái đầu" },
                  { id: "normal", name: "Bình thường", desc: "Hé lộ 1 chữ cái đầu" },
                  { id: "hard", name: "Siêu khó", desc: "Không gợi ý gì" },
                ].map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDifficulty(d.id as GameDifficulty)}
                    className={`p-3 rounded-2xl border text-center transition cursor-pointer ${
                      difficulty === d.id
                        ? "bg-indigo-600/20 border-indigo-500 text-white shadow-[0_0_18px_rgba(99,102,241,0.3)] ring-1 ring-indigo-400/50"
                        : "bg-slate-800/40 border-slate-800 text-slate-400 hover:bg-slate-800/80 hover:text-slate-200"
                    }`}
                  >
                    <p className="font-extrabold text-xs sm:text-sm text-white">{d.name}</p>
                    <p className="text-[10px] text-slate-400 mt-1 leading-tight">{d.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* 3. Falling Speed: 1 to 5 selector with active highlight pill */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-400">
                <span>3. Tốc độ rơi: Cấp {speedLevel} / 5</span>
                <span className="text-indigo-400 font-mono">
                  {speedLevel <= 2 ? "Chậm" : speedLevel === 3 ? "Tiêu chuẩn" : "Siêu tốc ⚡"}
                </span>
              </div>
              <div className="grid grid-cols-5 gap-2">
                {[1, 2, 3, 4, 5].map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => setSpeedLevel(lvl)}
                    className={`py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                      speedLevel === lvl
                        ? "bg-indigo-600 text-white shadow-[0_0_12px_rgba(99,102,241,0.5)] border border-indigo-400"
                        : "bg-slate-800/60 text-slate-400 hover:bg-slate-800 hover:text-white border border-slate-700/50"
                    }`}
                  >
                    Cấp {lvl}
                  </button>
                ))}
              </div>
            </div>

            {/* Rules guide list at bottom */}
            <div className="p-3.5 rounded-2xl bg-slate-950/70 border border-slate-800/80 flex flex-col gap-1.5 text-xs text-slate-400">
              <div className="flex items-center gap-2">
                <Check className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span>Chữ rơi từ trên xuống — gõ đúng trước khi chạm vạch đỏ</span>
              </div>
              <div className="flex items-center gap-2">
                <Check className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span>Chữ gõ đúng lập tức nổ tung, không cần nhấn Enter</span>
              </div>
              <div className="flex items-center gap-2">
                <Check className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span>Bỏ lỡ từ sẽ bị trừ năng lượng và từ rơi vào hàng đợi Phục thù</span>
              </div>
              <div className="flex items-center gap-2">
                <Check className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span>Hỗ trợ gõ cả tiếng Việt có dấu lẫn không dấu (IME-friendly)</span>
              </div>
            </div>
          </div>

          {/* Low words warning */}
          {words.length < 3 && !isLoadingWords && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>Bộ từ này cần tối thiểu 3 từ vựng có sẵn để chơi Game Bắn Chữ.</span>
            </div>
          )}

          {/* Big CTA Button: "Chơi" */}
          <button
            type="button"
            onClick={handleStartGame}
            disabled={words.length < 3 || isLoadingWords}
            className={`w-full py-4 rounded-2xl font-black text-lg tracking-wider flex items-center justify-center gap-2 transition cursor-pointer active:scale-98 ${
              words.length >= 3 && !isLoadingWords
                ? "bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 text-white shadow-[0_0_30px_rgba(79,70,229,0.5)] hover:shadow-[0_0_40px_rgba(79,70,229,0.7)] hover:brightness-110"
                : "bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed"
            }`}
          >
            <Play className="w-5 h-5 fill-white text-white" />
            <span>Chơi</span>
          </button>
        </div>
      )}

      {/* ============================================================== */}
      {/* 2. PLAYING CANVAS ENGINE */}
      {/* ============================================================== */}
      {phase === "playing" && (
        <div className="relative z-10 w-full h-full">
          <CardBlastEngine
            words={words}
            direction={direction}
            difficulty={difficulty}
            speedLevel={speedLevel}
            deckTitle={deck?.title || "Vocabulary Deck"}
            onGameOver={handleGameOver}
            onExit={() => { if (strictLive) setStrictExitAsk(true); else onClose(); }}
            onChangeConfig={() => setPhase("config")}
          />
        </div>
      )}

      {/* ============================================================== */}
      {/* 3. GAME OVER & WEAK WORDS REVIEW SCREEN */}
      {/* ============================================================== */}
      {phase === "summary" && summary && (
        <div className="relative z-10 w-full max-w-2xl max-h-[92vh] mx-4 p-6 sm:p-8 rounded-3xl bg-slate-900/95 border border-slate-700/80 shadow-[0_0_60px_rgba(30,58,138,0.45)] backdrop-blur-xl flex flex-col gap-6 overflow-y-auto animate-in zoom-in-95 duration-200">
          {/* Header Title with Rank Badge */}
          <div className="text-center flex flex-col items-center gap-2">
            <div
              className={`w-16 h-16 rounded-2xl flex items-center justify-center ${
                summary.isCleared
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 shadow-[0_0_20px_rgba(16,185,129,0.4)]"
                  : "bg-red-500/20 text-red-400 border border-red-500/40 shadow-[0_0_20px_rgba(239,68,68,0.4)]"
              }`}
            >
              {summary.isCleared ? <Trophy className="w-8 h-8" /> : <ShieldAlert className="w-8 h-8" />}
            </div>
            <h2 className="text-2xl sm:text-3xl font-black text-white">
              {summary.isCleared ? "CHIẾN THẮNG! 🏆" : "HẾT MẠNG 💥"}
            </h2>
            {/* Rank badge */}
            {(() => {
              const badge = getRankBadge(summary.accuracy, summary.maxStreak);
              return (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-xs font-bold text-slate-200">
                  <Award className="w-4 h-4 text-amber-400" />
                  <span>Danh hiệu: <strong className="text-amber-400">{badge.title} {badge.icon}</strong></span>
                </div>
              );
            })()}
            <p className="text-xs sm:text-sm text-slate-400">
              {summary.isCleared
                ? "Bạn đã tiêu diệt toàn bộ từ vựng mà không để cạn kiệt năng lượng!"
                : "Đừng nản lòng! Ôn lại các từ bị lọt để phản xạ nhạy bén hơn lần sau."}
            </p>
          </div>

          {/* Stat Grid: Điểm, Bắn trúng, Chuỗi dài nhất, Cấp */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-4 rounded-2xl bg-slate-950/80 border border-slate-800 text-center">
            <div>
              <p className="text-[10px] uppercase font-bold text-slate-500">Điểm</p>
              <p className="text-lg sm:text-2xl font-black text-amber-400 font-mono mt-0.5">
                {summary.score}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase font-bold text-slate-500">Bắn trúng</p>
              <p className="text-lg sm:text-2xl font-black text-emerald-400 font-mono mt-0.5">
                {summary.hits} / {summary.totalAttempts}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase font-bold text-slate-500">Chuỗi dài nhất</p>
              <p className="text-lg sm:text-2xl font-black text-orange-400 font-mono mt-0.5">
                🔥 {summary.maxStreak}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase font-bold text-slate-500">Cấp</p>
              <p className="text-sm sm:text-base font-extrabold text-indigo-400 mt-1">
                Cấp {speedLevel} ({difficulty === "easy" ? "Dễ" : difficulty === "normal" ? "Bình thường" : "Siêu khó"})
              </p>
            </div>
          </div>

          {/* DANH SÁCH "TỪ ĐỂ LỌT — ÔN LẠI" (Weak Words Review) */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <BookOpen className="w-4 h-4 text-emerald-400" />
                <span>Từ để lọt — Ôn lại ({summary.missedWords.length})</span>
              </h3>
              {summary.missedWords.length > 0 && (
                <span className="text-[11px] text-amber-400 font-medium">
                  Đã tự động ghim vào danh sách cần ôn
                </span>
              )}
            </div>

            {summary.missedWords.length === 0 ? (
              <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm text-center font-bold">
                🏅 Tuyệt đỉnh! Bạn không bỏ sót bất kỳ từ nào trong lượt chơi này!
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-1">
                {summary.missedWords.map((w) => (
                  <div
                    key={w.id}
                    className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800 hover:border-slate-700 flex items-start justify-between gap-2.5 transition"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <strong className="text-white text-xs sm:text-sm font-bold truncate">{w.word}</strong>
                        {w.ipa && (
                          <span className="text-[11px] text-slate-400 font-mono">{w.ipa}</span>
                        )}
                      </div>
                      <p className="text-xs font-semibold text-emerald-400 mt-0.5 truncate">
                        {w.vietnamese}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => playWordAudio(w.word)}
                      title="Nghe phát âm"
                      className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition shrink-0 cursor-pointer"
                    >
                      <Volume2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Action buttons: [🔁 Chơi lại] and [Đổi chiều • mức] */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={handleRestart}
              className="flex-1 py-3.5 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 text-slate-950 font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:brightness-110 transition cursor-pointer active:scale-98"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Chơi lại</span>
            </button>
            <button
              type="button"
              onClick={() => setPhase("config")}
              className="flex-1 py-3.5 rounded-2xl bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 font-bold text-sm tracking-wider flex items-center justify-center gap-2 transition cursor-pointer active:scale-98"
            >
              <Settings2 className="w-4 h-4 text-indigo-300" />
              <span>Đổi chiều • mức</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-3.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-sm tracking-wider flex items-center justify-center gap-2 border border-slate-700 transition cursor-pointer"
            >
              <BookOpen className="w-4 h-4 text-slate-400" />
              <span>Về bộ từ</span>
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}

