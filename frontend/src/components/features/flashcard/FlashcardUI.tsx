"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { pauseMusicForLearning } from '@/lib/music/focus';
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { useFlashcardCatalog } from "@/hooks/useFlashcardCatalog";
import { useModuleEntryScope } from "@/hooks/useModuleEntryResource";
import { apiClient } from "@/services/api-client";
import useSWR, { mutate as globalMutate } from "swr";
import { StudyDeckView } from "./StudyDeckView";
import { StudyCompanion } from "./StudyCompanion";
import { TheaterScene } from "./theater/TheaterScene";
import { TheaterTips } from "./theater/TheaterHud";
import { computePassCounts, mergeDueBatchForPass } from "./theater/passTimeline";
import theater from "./theater/theater.module.css";
import { FlashcardLibraryView } from "./FlashcardLibraryView";
import { CaughtUpView } from "./CaughtUpView";
import { FlashcardGuide, useFlashcardGuideIntro } from "./FlashcardGuide";
import type { RecallQuality } from "./RecallControls";
import type { SessionTally } from "./StudyCompanion";
import { EmptyDeckView } from "./EmptyDeckView";
import { AddFlashcardModal } from "./AddFlashcardModal";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { AuthRequired } from "@/components/common/AuthRequired";
import { DeckCatalogView, VocabDeckSummary } from "./DeckCatalogView";
import { SpeedVocabQuizModal } from "./SpeedVocabQuizModal";
import { CardBlastModal } from "./CardBlastModal";
import { ArrowLeft, BarChart3, CircleHelp, Maximize2, Minimize2, Zap } from "lucide-react";
import { useContentTitle } from '@/lib/brand/tabTitle';
import dynamic from "next/dynamic";
import { RatingFx, type RatingFxEvent } from "./tides/RatingFx";
import { StudyLibraryDrawer } from "./tides/StudyLibraryDrawer";
import { TIMELINE, Timeline, canRate, fxGeometry, step, type StudyEvent, type StudyPhase } from "./tides/studyTimeline";
import pulse from "./tides/memoryPulse.module.css";
import { vfxReduced } from "@/lib/vfx/quality";
import { readRecallMode, writeRecallMode, type RecallMode } from "./tides/recall";
import { MemoryForge } from "./tides/MemoryForge";
import { fetchCardTiers } from "@/services/flashcardMemoryApi";
import type { CardTier } from "@/types/flashcardMemory";
import { dispatchEchoModuleReady } from "@/lib/echo/contextBridge";

// Echo Memory Tides 2.0: the Studio dialog and the Memory Universe load only when opened.
const CardStudio = dynamic(() => import("./tides/CardStudio"), { ssr: false });
const MemoryVault = dynamic(() => import("./tides/MemoryVault"), { ssr: false });

interface DictionaryEntry {
  id?: number;
  word: string;
  ipa?: string;
  cefr?: string;
  generalTranslationVi?: string;
  meanings: string[];
  examples: string[];
}

interface Flashcard {
  id: number;
  dictionaryEntry: DictionaryEntry;
  nextReviewDate: string;
  status: string;
  reviewCount: number;
  customMeaning?: string | null;
  customExample?: string | null;
}

interface FlashcardStats {
  totalCards: number;
  dueCards: number;
  learningCards: number;
  masteredCards: number;
  totalCount?: number;
  dueCount?: number;
  learningCount?: number;
  masteredCount?: number;
}

interface PaginatedCardsResponse {
  content: Flashcard[];
  totalPages: number;
  totalElements: number;
}

/** Pseudo deck of the `review=due` entry (Lộ trình học): every due card of the learner, no deck filter. */
const DUE_REVIEW_SLUG = "due-today";
/** Pseudo deck of the `review=learned` entry (the bell's daily reminder): already-studied cards due now. */
const LEARNED_REVIEW_SLUG = "review-learned";
/** The study screens' frame (it used to be the root page's 7xl <main>); the deck library paints its own full-width world. */
const STUDY_FRAME = "relative mx-auto max-w-7xl px-4 py-8";

/** The pseudo deck of a due-card study: every due card (`learned` = only already-studied ones), no deck filter. */
function dueReviewDeck(learned: boolean): VocabDeckSummary {
  return {
    id: null, slug: learned ? LEARNED_REVIEW_SLUG : DUE_REVIEW_SLUG, title: learned ? "Từ cần ôn hôm nay" : "Thẻ đến hạn hôm nay",
    description: "", category: "DUE", themeColor: "sky",
    icon: "layers", totalWords: 0, isSystem: false, sortOrder: 0, masteredCount: 0, reviewedCount: 0, learningCount: 0,
    dueCount: 0, progressPercentage: 0, isEnrolled: true,
  };
}

export type ReviewError = { cardId: number; quality: RecallQuality; message: string };

/** One id per rating click; a retry of the same rating reuses it so the server applies it at most once. */
function newReviewKey() {
  const c = typeof globalThis !== "undefined" ? (globalThis as any).crypto : undefined;
  if (c?.randomUUID) return c.randomUUID() as string;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** What the learner reads when a rating could not be saved (the card stays on screen). */
export function reviewErrorMessage(error: any, vi: boolean): string {
  const status: number | undefined = error?.response?.status;
  const serverText = typeof error?.response?.data?.message === "string" ? error.response.data.message : "";
  if (!status) return vi ? "Mất kết nối khi lưu đánh giá. Thẻ vẫn ở đây, bấm Thử lại." : "The connection dropped while saving. Your card is still here: try again.";
  if (status === 401) return vi ? "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại rồi thử lại." : "Your session has expired. Sign in again, then retry.";
  if (status === 400 && serverText) return serverText;
  if (status === 429 || status === 503) return vi ? "Máy chủ đang bận. Thử lại sau giây lát." : "The server is busy. Try again in a moment.";
  return vi ? "Chưa lưu được đánh giá. Hãy thử lại." : "The rating was not saved. Please try again.";
}

export function FlashcardUI() {
  const scope = useModuleEntryScope();
  return <FlashcardContent key={scope ?? "pending"} />;
}

function FlashcardContent() {
  const { data: session, status } = useSession();
  const searchParams = useSearchParams();
  const pvpParam = searchParams?.get("pvp") || null;

  // Selected Deck State: null = DeckCatalogView (Default), non-null = Scoped Study/Library View
  const [selectedDeck, setSelectedDeck] = useState<VocabDeckSummary | null>(null);
  useContentTitle(selectedDeck?.title);
  const [showQuizModal, setShowQuizModal] = useState(false);
  const [showCardBlastModal, setShowCardBlastModal] = useState(false);

  useEffect(() => {
    if (pvpParam) {
      setShowCardBlastModal(true);
    }
  }, [pvpParam]);

  const [cards, setCards] = useState<Flashcard[]>([]);
  const [libraryCards, setLibraryCards] = useState<Flashcard[]>([]);
  const [stats, setStats] = useState<FlashcardStats | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [manualOverrideCard, setManualOverrideCard] = useState<Flashcard | null>(null);
  const [cardToDelete, setCardToDelete] = useState<Flashcard | null>(null);
  const [isStudying, setIsStudying] = useState(false);

  // Study pass, tracked by card IDENTITY (the due list is re-fetched and re-ordered by the server after every rating,
  // so a position index would skip or repeat cards). A card rated in this pass is not shown again in it; cards rated
  // "Khó" stay due on the server and come back with the next pass.
  const [passReviewedIds, setPassReviewedIds] = useState<number[]>([]);
  // The stored rating of each card of this pass (Memory Current colours); a skipped card (deleted elsewhere) has none.
  const [passMarks, setPassMarks] = useState<Record<number, RecallQuality | null>>({});
  // Stable pass order (Task B, 2026-11-20). The server orders due cards by date only, so cards that share a date (every new
  // card of a deck) came back in a different order after each rating's UPDATE; the pass then showed whichever card a refetch
  // put first ("card 3 flashes, then card 2"). The pass keeps the order in which it first saw each card: a refetch may add
  // cards at the end or remove some, never reorder the ones still waiting. Reset with every new pass.
  const passOrder = useRef<Map<number, number>>(new Map());
  const [tally, setTally] = useState<SessionTally>({ hard: 0, good: 0, easy: 0 });
  // the stored ratings of this session, in order (the completion's tide line draws exactly these); never sent anywhere
  const [trail, setTrail] = useState<RecallQuality[]>([]);
  // the tide of the rating the server just stored: how the rated card leaves (Khó sinks, Tốt drifts, Dễ becomes a pearl)
  const [tide, setTide] = useState<RecallQuality | null>(null);
  const [savingQuality, setSavingQuality] = useState<RecallQuality | null>(null);
  // Synchronous in-flight guard: two key presses in one frame both see the old React state, never this ref.
  const reviewInFlight = useRef(false);
  // The rating last sent for a card and its id: reused by a retry until the server confirms it.
  const pendingReview = useRef<{ cardId: number; quality: RecallQuality; key: string } | null>(null);
  const [reviewError, setReviewError] = useState<ReviewError | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const { showIntro, dismissIntro } = useFlashcardGuideIntro();

  // Echo Memory Tides 2.0 ─ every effect / counter below follows a rating the SERVER stored; none changes the schedule.
  const [newlyMastered, setNewlyMastered] = useState(0);

  // Echo Memory Pulse ─ ONE timeline for the card on screen (tides/studyTimeline.ts): turning, ratings appearing, the stored
  // rating's effect, the card leaving and the next one arriving. Every delay goes through `timeline` (cancelled on deck
  // switch and unmount); `phaseRef` is read synchronously so a second key / click can never pass a pending rating.
  const timeline = useRef(new Timeline());
  const [phase, setPhaseState] = useState<StudyPhase>("front");
  const phaseRef = useRef<StudyPhase>("front");
  const go = useCallback((event: StudyEvent): boolean => {
    const next = step(phaseRef.current, event);
    if (!next) return false;
    phaseRef.current = next;
    setPhaseState(next);
    return true;
  }, []);
  // the rated card stays on screen while its effect plays and it leaves (a due-list refetch must not swap it early)
  const [heldCard, setHeldCard] = useState<Flashcard | null>(null);
  const [fx, setFx] = useState<RatingFxEvent[]>([]);
  const fxSeq = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  // a response that arrives after a deck switch / unmount belongs to a session that no longer exists
  const sessionToken = useRef(0);
  const [libraryOpen, setLibraryOpen] = useState(false);
  // Echo Memory Theater: the on-demand insights sheet and the theater's own fullscreen (Fullscreen API on a click only)
  const [insightsOpen, setInsightsOpen] = useState(false);
  const insightsButton = useRef<HTMLButtonElement>(null);
  const theaterRef = useRef<HTMLElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const resetTimeline = useCallback(() => {
    timeline.current.cancel();
    sessionToken.current += 1;
    phaseRef.current = "front";
    setPhaseState("front");
    setHeldCard(null);
    setFx([]);
  }, []);
  useEffect(() => () => { timeline.current.cancel(); sessionToken.current += 1; }, []);
  const [recallMode, setRecallMode] = useState<RecallMode>("flip");
  useEffect(() => { setRecallMode(readRecallMode()); }, []);
  const changeRecallMode = useCallback((mode: RecallMode) => { setRecallMode(mode); writeRecallMode(mode); }, []);
  const [tiers, setTiers] = useState<Record<number, CardTier>>({});
  const tierAsked = useRef<Set<number>>(new Set());
  const [forgeCard, setForgeCard] = useState<{ id: number; word: string } | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);

  // Audio refs
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Pagination & Search
  const [libPage, setLibPage] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "due" | "learning" | "mastered" | "hard" | "good" | "easy">("all");
  const LIB_PAGE_SIZE = 50;

  // Add card modal & file input
  const [showAddModal, setShowAddModal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Debounce search query 400ms
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchQuery(searchInput);
      setLibPage(0);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // The API client authenticates with the session cookie; no header is built here.
  const getHeaders = (): Record<string, string> => ({});

  const userScope = session?.user ? ((session.user as any).id || session.user.email) : null;

  const statsFetcher = async (urlOrTuple: string | [string, any]): Promise<FlashcardStats> => {
    const rawUrl = Array.isArray(urlOrTuple) ? urlOrTuple[0] : urlOrTuple;
    const cleanUrl = rawUrl.startsWith("/api/v1") ? rawUrl.replace(/^\/api\/v1/, "") : rawUrl;
    const res = await apiClient.get<FlashcardStats>(cleanUrl);
    return res.data;
  };

  const cardsFetcher = async (urlOrTuple: string | [string, any]): Promise<PaginatedCardsResponse> => {
    const rawUrl = Array.isArray(urlOrTuple) ? urlOrTuple[0] : urlOrTuple;
    const cleanUrl = rawUrl.startsWith("/api/v1") ? rawUrl.replace(/^\/api\/v1/, "") : rawUrl;
    const res = await apiClient.get<any>(cleanUrl);
    const data = res.data;
    return {
      content: Array.isArray(data) ? data : data?.content || data?.data || [],
      totalPages: data?.totalPages || 1,
      totalElements: data?.totalElements || (Array.isArray(data) ? data.length : 0),
    };
  };

  const { decks: decksData, mutateDecks, mutateAllDecks, catalogKnown, progressKnown, error: catalogError } = useFlashcardCatalog();

  // 1. Lightweight Stats Summary (strictly scoped when a deck is selected)
  const statsKey = selectedDeck?.id !== null && selectedDeck?.id !== undefined
    ? `/api/v1/flashcards/stats?deckId=${selectedDeck.id}`
    : (selectedDeck !== null ? "/api/v1/flashcards/stats" : null);

  const { data: statsData, mutate: mutateStats } = useSWR<FlashcardStats>(
    userScope && statsKey ? [statsKey, userScope] : null,
    statsFetcher,
    { revalidateOnFocus: false, revalidateIfStale: true, revalidateOnMount: true, dedupingInterval: 30000, keepPreviousData: false }
  );

  // 2. Due Cards for Review Cockpit (strictly scoped when a deck is selected)
  const dueKey = selectedDeck?.id !== null && selectedDeck?.id !== undefined
    ? `/api/v1/flashcards/due?deckId=${selectedDeck.id}&page=0&size=50`
    : selectedDeck?.slug === LEARNED_REVIEW_SLUG
      ? "/api/v1/flashcards/due?reviewOnly=true&page=0&size=50"
      : (selectedDeck !== null ? "/api/v1/flashcards/due?page=0&size=50" : null);

  const { data: dueData, mutate: mutateDue, error: dueError } = useSWR<PaginatedCardsResponse>(
    userScope && dueKey ? [dueKey, userScope] : null,
    cardsFetcher,
    { revalidateOnFocus: false, revalidateIfStale: true, revalidateOnMount: true, dedupingInterval: 30000, keepPreviousData: false }
  );

  // Compute review queue (due today or no nextReviewDate)
  const reviewQueue = useMemo(() => {
    return cards.filter((card) => {
      if (!card) return false;
      if (!card.nextReviewDate) return true;
      const due = new Date(card.nextReviewDate);
      const today = new Date();
      due.setHours(0, 0, 0, 0);
      today.setHours(0, 0, 0, 0);
      return due <= today;
    });
  }, [cards]);

  // Current active study card: a library card opened by hand, else the first due card not yet rated in this pass.
  const passReviewedSet = useMemo(() => new Set(passReviewedIds), [passReviewedIds]);
  const pendingQueue = useMemo(() => {
    const waiting = reviewQueue.filter((c) => !passReviewedSet.has(c.id));
    const order = passOrder.current;
    for (const c of waiting) if (!order.has(c.id)) order.set(c.id, order.size);
    return waiting.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }, [reviewQueue, passReviewedSet]);
  const currentStudyCard: Flashcard | null = manualOverrideCard || pendingQueue[0] || null;
  // what is on screen: the rated card while its effect plays and it leaves, else the current card
  const displayCard: Flashcard | null = heldCard ?? currentStudyCard;
  const dueKnown = dueData !== undefined || !!dueError;

  // 3. Paginated Library Cards (lazy: skipped during active review until library, caught-up cram, or quiz/blast needs it)
  const statusParam = activeFilter !== "all" ? `&status=${activeFilter}` : "";
  const searchParam = searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : "";
  const deckParam = selectedDeck?.id !== null && selectedDeck?.id !== undefined ? `deckId=${selectedDeck.id}&` : "";
  const needLibrary =
    selectedDeck !== null &&
    (libraryOpen ||
      !isStudying ||
      showQuizModal ||
      showCardBlastModal ||
      (dueKnown && !displayCard && (passReviewedIds.length > 0 || !dueData?.content?.length)));
  const libKey = needLibrary
    ? `/api/v1/flashcards?${deckParam}page=${libPage}&size=${LIB_PAGE_SIZE}${statusParam}${searchParam}`
    : null;

  const { data: libData, mutate: mutateLib, error: libError } = useSWR<PaginatedCardsResponse>(
    userScope && libKey ? [libKey, userScope] : null,
    cardsFetcher,
    { revalidateOnFocus: false, revalidateIfStale: true, revalidateOnMount: true, dedupingInterval: 30000, keepPreviousData: false }
  );

  // User-scoped local storage cache hydration (ONLY when a deck is selected)
  useEffect(() => {
    if (typeof window !== "undefined" && userScope && selectedDeck !== null) {
      const scopeKey = selectedDeck.id ?? (selectedDeck.slug === DUE_REVIEW_SLUG || selectedDeck.slug === LEARNED_REVIEW_SLUG ? selectedDeck.slug : "personal");
      const cacheKey = `flashcards_cache_${userScope}_${scopeKey}`;
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed) {
            if (Array.isArray(parsed.cards) && parsed.cards.length > 0) {
              setLibraryCards(parsed.cards);
              setLoading(false);
            }
            if (parsed.stats) {
              setStats(parsed.stats);
            }
          }
        } catch (e) {}
      }
    }
  }, [userScope, selectedDeck]);

  // Sync data updates to state & user-scoped cache
  useEffect(() => {
    if (statsData) {
      setStats(statsData);
    }
    if (dueData?.content) {
      setCards((prev) => mergeDueBatchForPass(prev, dueData.content, passOrder.current));
    }
    if (libData?.content) {
      setLibraryCards(libData.content);
    }

    if (userScope && typeof window !== "undefined" && selectedDeck !== null) {
      const scopeKey = selectedDeck.id ?? (selectedDeck.slug === DUE_REVIEW_SLUG || selectedDeck.slug === LEARNED_REVIEW_SLUG ? selectedDeck.slug : "personal");
      const cacheKey = `flashcards_cache_${userScope}_${scopeKey}`;
      const currentCards = libData?.content || libraryCards;
      const currentStats = statsData || stats;
      if (currentCards.length > 0 || currentStats) {
        localStorage.setItem(cacheKey, JSON.stringify({ cards: currentCards, stats: currentStats }));
      }
    }

    if (session && (statsData || libData || dueData || dueError || libError)) {
      setLoading(false);
    }
  }, [statsData, dueData, libData, session, userScope, selectedDeck, dueError, libError]);

  // Audio management
  const stopAudio = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.resume();
      window.speechSynthesis.cancel();
    }
    setIsPlaying(false);
  };

  // Leaving a face or a card stops its sound.
  useEffect(() => {
    stopAudio();
  }, [manualOverrideCard?.id, passReviewedIds.length, flipped]);

  const toggleAudio = (e: React.MouseEvent, text: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!text) return;

    if (isPlaying) {
      stopAudio(e);
      return;
    }

    playAudio(text);
  };

  const playAudio = async (text: string) => {
    pauseMusicForLearning();
    setIsPlaying(true);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    // 1. Try HTML5 Audio (Salli voice MP3)
    const url = `https://api.streamelements.com/kappa/v2/speech?voice=Salli&text=${encodeURIComponent(text)}`;
    try {
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setIsPlaying(false);
      await audio.play();
      return;
    } catch (err) {
      console.warn("HTML5 Audio failed, falling back to Web Speech API:", err);
    }

    // 2. Fallback: Web Speech API
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utteranceRef.current = utterance;
      utterance.lang = "en-US";

      const voices = window.speechSynthesis.getVoices();
      const premiumVoice = voices.find(
        (v) =>
          v.name.includes("Aria") ||
          v.name.includes("Female") ||
          v.name.includes("Samantha") ||
          v.name.includes("Google US English")
      );
      if (premiumVoice) utterance.voice = premiumVoice;

      utterance.onend = () => setIsPlaying(false);
      utterance.onerror = () => setIsPlaying(false);
      window.speechSynthesis.speak(utterance);
    } else {
      setIsPlaying(false);
    }
  };

  // Global SWR revalidation for dashboard stats and user counters (local flashcard keys are mutated explicitly)
  const triggerGlobalStatsRevalidation = () => {
    globalMutate(
      (key) => {
        const keyStr =
          typeof key === "string"
            ? key
            : Array.isArray(key) && typeof key[0] === "string"
              ? key[0]
              : "";
        if (!keyStr || keyStr.includes("/flashcards")) return false;
        return keyStr.includes("/dashboard") || keyStr.includes("/user/stats");
      },
      undefined,
      { revalidate: true }
    );
  };

  // Review handler: exactly three ratings ("hard", "good", "easy"), sent unchanged to the existing review endpoint.
  // The rating always names the card that was on screen; a stale or duplicate rating is dropped, never re-targeted.
  // The card on screen changes only after the server confirmed the rating; a failure keeps the card, counts nothing
  // and offers a retry that reuses the same request id (Idempotency-Key), so a retried rating is applied at most once.
  const handleReview = async (qualityString: RecallQuality, cardId: number) => {
    const card = currentStudyCard;
    if (!card || card.id !== cardId || reviewInFlight.current) return;
    // a rating counts only once the back has finished turning: clicks, taps, keys 1–3 and "Thử lại" alike
    if (!canRate(phaseRef.current)) return;
    go("RATE");
    const token = sessionToken.current;

    reviewInFlight.current = true;
    setSavingQuality(qualityString);
    setIsSaving(true);
    setReviewError(null);
    const previous = pendingReview.current;
    const key = previous && previous.cardId === card.id && previous.quality === qualityString ? previous.key : newReviewKey();
    pendingReview.current = { cardId: card.id, quality: qualityString, key };
    try {
      const response = await apiClient.put(`/flashcards/${card.id}/review`, null, {
        headers: { ...getHeaders(), "Idempotency-Key": key },
        params: { quality: qualityString },
        timeout: 20000,
      });

      if (response.status !== 200 && response.status !== 201) {
        throw new Error("Failed to save review to database");
      }
      pendingReview.current = null;
      // the session this rating belongs to has gone (deck switch, unmount): stored on the server, nothing to show here
      if (token !== sessionToken.current) return;

      const updatedCard: Flashcard = response.data;
      // keep the rated card on screen (its schedule just moved, so it leaves the due list in this same render)
      setHeldCard(card);
      if (card.status !== "MASTERED" && updatedCard?.status === "MASTERED" && response.headers?.["x-review-replayed"] !== "true") {
        setNewlyMastered((n) => n + 1);
      }
      setLibraryCards((prev) => prev.map((c) => (c.id === card.id ? updatedCard : c)));
      setCards((prev) => prev.map((c) => (c.id === card.id ? updatedCard : c)));
      setTally((prev) => ({ ...prev, [qualityString]: prev[qualityString] + 1 }));
      if (!manualOverrideCard) setPassMarks((prev) => ({ ...prev, [card.id]: qualityString }));
      setTrail((prev) => [...prev, qualityString]);

      mutateDue();
      mutateLib();
      mutateStats();
      mutateDecks();
      triggerGlobalStatsRevalidation();

      confirmRating(card, qualityString, !!manualOverrideCard);
    } catch (e: any) {
      if (token !== sessionToken.current) return;
      console.error("[Flashcard Review Error]", e?.response?.status ?? e?.message);
      // nothing was stored: no effect, the card stays on its back and the ratings answer again
      go("FAIL");
      if (e?.response?.status === 404) {
        // the card is no longer the learner's (deleted elsewhere): leave it and go on with the pass
        pendingReview.current = null;
        setPassReviewedIds((prev) => (prev.includes(card.id) ? prev : [...prev, card.id]));
        setPassMarks((prev) => ({ ...prev, [card.id]: null }));
        setManualOverrideCard(null);
        setFlipped(false);
        go("RESET");
        mutateDue();
        setReviewError({ cardId: card.id, quality: qualityString, message: "Thẻ này không còn trong bộ của bạn, đã chuyển sang thẻ tiếp theo." });
      } else {
        setReviewError({ cardId: card.id, quality: qualityString, message: reviewErrorMessage(e, true) });
      }
    } finally {
      reviewInFlight.current = false;
      setSavingQuality(null);
      setIsSaving(false);
    }
  };

  /**
   * The server stored the rating: its effect starts at the real pressed button and reaches the card (positions from live
   * rects, relative to the study stage), the rated card leaves while the effect still travels, then the next card arrives
   * on its front. One timeline; reduced motion = a still confirmation and the next card at once.
   */
  const confirmRating = (card: Flashcard, quality: RecallQuality, manual: boolean) => {
    go("CONFIRM");
    setTide(quality);
    const reduced = vfxReduced();
    const layer = stageRef.current;
    const button = typeof document !== "undefined" ? document.getElementById("btn-recall-" + quality) : null;
    const cardEl = layer?.querySelector("[data-study-card]");
    if (layer && button && cardEl) {
      const targetEl = layer.querySelector("[data-fx-target]") ?? layer.querySelector('[role="progressbar"]');
      const geometry = fxGeometry(layer.getBoundingClientRect(), button.getBoundingClientRect(), cardEl.getBoundingClientRect(),
        targetEl?.getBoundingClientRect() ?? null);
      const id = ++fxSeq.current;
      setFx((prev) => [...prev.slice(-1), { id, quality, geometry, reduced }]);
      timeline.current.schedule(reduced ? TIMELINE.reducedFx : TIMELINE.fxLife, () => setFx((prev) => prev.filter((f) => f.id !== id)));
    }
    const advance = () => {
      setFlipped(false);
      if (manual) setManualOverrideCard(null);
      else setPassReviewedIds((prev) => (prev.includes(card.id) ? prev : [...prev, card.id]));
      setHeldCard(null);
      go("SWAP");
      timeline.current.schedule(reduced ? 0 : TIMELINE.enter, () => go("ENTERED"));
    };
    if (reduced) { advance(); return; }
    timeline.current.schedule(TIMELINE.exitAt, () => go("EXIT"));
    timeline.current.schedule(TIMELINE.exitAt + TIMELINE.exit, advance);
  };

  // Turning the card is a timeline step too: while it turns nothing else can start, and the ratings arrive when it is done.
  const handleFlip = useCallback(() => {
    if (reviewInFlight.current) return;
    if (!go("FLIP")) return;
    setFlipped(phaseRef.current === "flipping-back");
    timeline.current.schedule(vfxReduced() ? 0 : TIMELINE.flip, () => go("FLIP_DONE"));
  }, [go]);

  // Reset mastered card to LEARNED
  const resetCardProgress = async (cardId: number) => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const response = await apiClient.put(`/flashcards/${cardId}/reset`, {}, {
        headers: getHeaders(),
      });

      if (response.status !== 200 && response.status !== 201) {
        throw new Error("Failed to reset flashcard");
      }

      const todayDate = new Date().toISOString().split("T")[0];
      const optimisticUpdate = (prevCards: Flashcard[]) =>
        prevCards.map((c) => (c.id === cardId ? { ...c, status: "LEARNED", nextReviewDate: todayDate } : c));

      setLibraryCards(optimisticUpdate);
      setCards(optimisticUpdate);

      mutateDue();
      mutateLib();
      mutateStats();
      mutateDecks();
      triggerGlobalStatsRevalidation();
    } catch (e: any) {
      console.error("[Flashcard Reset Error]", e);
      alert(`API Error: ${e.response?.status} - Failed to reset card.`);
    } finally {
      setIsSaving(false);
    }
  };

  // Delete card confirmation
  const confirmDelete = async () => {
    if (!cardToDelete) return;
    try {
      const res = await apiClient.delete(`/flashcards/${cardToDelete.id}`, { headers: getHeaders() });
      if (res.status === 200 || res.status === 204) {
        setLibraryCards((prev) => prev.filter((c) => c.id !== cardToDelete.id));
        setCards((prev) => prev.filter((c) => c.id !== cardToDelete.id));
        setCardToDelete(null);
        mutateDue();
        mutateLib();
        mutateStats();
        mutateDecks();
        triggerGlobalStatsRevalidation();
      }
    } catch (e: any) {
      console.error("[Flashcard Delete Error]", e);
      alert("Error: Unable to delete flashcard.");
    }
  };

  // Add flashcard
  const handleAddFlashcard = async (front: string, back: string, example: string) => {
    try {
      const res = await apiClient.post(
        "/flashcards",
        { front, back, example },
        { headers: getHeaders() }
      );
      if (res.status === 200) alert(`“${front.trim()}” đã có trong Flashcards của bạn.`);
      setShowAddModal(false);
      mutateDue();
      mutateLib();
      mutateStats();
      mutateDecks();
      triggerGlobalStatsRevalidation();
    } catch (e: any) {
      console.error("[Flashcard Add Error]", e?.response?.status ?? e?.message);
      const reason = typeof e?.response?.data?.message === "string" && e.response.status < 500 ? e.response.data.message : "";
      alert(reason ? `Chưa lưu được thẻ: ${reason}` : "Chưa lưu được thẻ. Hãy thử lại.");
    }
  };

  // Import Anki .apkg
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await apiClient.post("/flashcards/upload-apkg", formData, {
        headers: { ...getHeaders(), "Content-Type": "multipart/form-data" },
      });
      alert(`Successfully imported ${res.data.importedCount || 0} flashcards!`);
      mutateDue();
      mutateLib();
      mutateStats();
      mutateDecks();
    } catch (error: any) {
      console.error("[Import .apkg Error]", error);
      alert("Failed to upload .apkg file.");
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // Select Deck & Enroll if system deck is not yet enrolled or has new words
  const handleSelectDeck = async (deck: VocabDeckSummary) => {
    if (deck.id !== null && (!deck.isEnrolled || (deck.learningCount + deck.masteredCount < deck.totalWords))) {
      try {
        await apiClient.post(`/flashcards/decks/${deck.id}/enroll`);
        mutateDecks();
      } catch (err) {
        console.error("Failed to enroll system deck:", err);
      }
    }

    setSelectedDeck(deck);
    setCards([]);
    setReviewError(null);
    pendingReview.current = null;
    setPassReviewedIds([]);
    setPassMarks({});
    passOrder.current = new Map();
    setInsightsOpen(false);
    setTally({ hard: 0, good: 0, easy: 0 });
    setTrail([]);
    setNewlyMastered(0);
    setFlipped(false);
    resetTimeline();
    // every study session starts with the vocabulary library folded into its one bar
    setLibraryOpen(false);
    setIsStudying(true);
    setManualOverrideCard(null);
    setLibPage(0);
    setSearchInput("");
  };

  // Click row to start manual review
  const handleFlashcardClick = (card: Flashcard) => {
    if (reviewInFlight.current) return;
    resetTimeline();
    setManualOverrideCard(card);
    setFlipped(false);
    setIsStudying(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const passCounts = computePassCounts(
    passReviewedIds,
    pendingQueue.length,
    heldCard?.id ?? null,
    heldCard ? pendingQueue.some((c) => c.id === heldCard.id) : false,
    !!manualOverrideCard,
  );
  const passTotal = passCounts.passTotal;
  // Space and 1-3 belong to an open dialog or study tool, never to the card behind it.
  const shortcutsEnabled = !guideOpen && !showQuizModal && !showAddModal && !cardToDelete && !showCardBlastModal && !forgeCard && !studioOpen;

  // Card Alchemy tiers of the cards in this pass: asked once per card (one small read, no AI), never per rating.
  useEffect(() => {
    if (!isStudying || !userScope) return;
    const ids = reviewQueue.map((c) => c.id).concat(manualOverrideCard ? [manualOverrideCard.id] : []).filter((id) => !tierAsked.current.has(id)).slice(0, 100);
    if (!ids.length) return;
    ids.forEach((id) => tierAsked.current.add(id));
    const ctrl = new AbortController();
    fetchCardTiers(ids, ctrl.signal)
      .then((list) => setTiers((prev) => { const next = { ...prev }; list.forEach((t) => { next[t.flashcardId] = t; }); return next; }))
      .catch(() => { ids.forEach((id) => tierAsked.current.delete(id)); });
    return () => ctrl.abort();
  }, [isStudying, userScope, reviewQueue, manualOverrideCard]);

  const totalElements = libData?.totalElements ?? stats?.totalCards ?? libraryCards.length;
  const totalPages = libData?.totalPages ?? Math.max(1, Math.ceil(totalElements / LIB_PAGE_SIZE));

  // Extract Personal Stats from decksData or stats
  const personalDeckSummary = useMemo(() => {
    return decksData?.find((d) => d.id === null || d.slug === "personal");
  }, [decksData]);

  const personalTotalCards = personalDeckSummary?.totalWords ?? 0;
  const personalDueCards = personalDeckSummary?.dueCount ?? 0;
  const personalMasteredCards = personalDeckSummary?.masteredCount ?? 0;

  // `review=due` (Lộ trình học "Ôn từ vựng"): open the study of every due card at once instead of the deck list.
  // Without a deck the server's due list covers all of the learner's decks; the scheduler is unchanged.
  // A deck someone shared in Echo Messenger: open it once it is in the catalog.
  const sharedDeckParam = searchParams?.get("deck") || null;
  const sharedDeckDone = useRef<string | null>(null);
  useEffect(() => {
    if (!sharedDeckParam || sharedDeckDone.current === sharedDeckParam || !catalogKnown) return;
    const deck = decksData.find(d => String(d.id) === sharedDeckParam);
    if (!deck) return;
    sharedDeckDone.current = sharedDeckParam;
    void handleSelectDeck(deck);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedDeckParam, catalogKnown, decksData]);
  const reviewParam = searchParams?.get("review") || null;
  const handledReviewParamRef = useRef<string | null>(null);
  useEffect(() => {
    if (reviewParam !== "due" && reviewParam !== "learned") {
      handledReviewParamRef.current = null;
      return;
    }
    if (status !== "authenticated" || !catalogKnown) return;
    const targetSlug = reviewParam === "learned" ? LEARNED_REVIEW_SLUG : DUE_REVIEW_SLUG;
    if (handledReviewParamRef.current === reviewParam && selectedDeck?.slug === targetSlug) return;
    handledReviewParamRef.current = reviewParam;
    void handleSelectDeck(dueReviewDeck(reviewParam === "learned"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewParam, status, catalogKnown, selectedDeck?.slug]);

  // Typed Echo JARVIS flashcard_control bridge (strictly view/filter only — NEVER SRS rating!)
  useEffect(() => {
    const onFlashcardIntent = (event: Event) => {
      const d = (event as CustomEvent<{ mode?: "due" | "learned" | "catalog"; deckId?: number; searchQuery?: string }>).detail;
      if (!d) return;
      if (d.mode === "due") {
        handledReviewParamRef.current = "due";
        void handleSelectDeck(dueReviewDeck(false));
      } else if (d.mode === "learned") {
        handledReviewParamRef.current = "learned";
        void handleSelectDeck(dueReviewDeck(true));
      } else if (d.mode === "catalog") {
        handledReviewParamRef.current = null;
        setSelectedDeck(null);
      } else if (typeof d.deckId === "number" && decksData) {
        handledReviewParamRef.current = null;
        const match = decksData.find((item) => item.id === d.deckId);
        if (match) void handleSelectDeck(match);
      }
      if (typeof d.searchQuery === "string") {
        setSearchInput(d.searchQuery);
        setSearchQuery(d.searchQuery);
        setLibPage(0);
      }
    };
    window.addEventListener("ec:flashcard:intent", onFlashcardIntent);
    window.addEventListener("ec:flashcards:intent", onFlashcardIntent);
    dispatchEchoModuleReady("flashcards");
    return () => {
      window.removeEventListener("ec:flashcard:intent", onFlashcardIntent);
      window.removeEventListener("ec:flashcards:intent", onFlashcardIntent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decksData]);

  // The theater's fullscreen follows the browser (Esc, F11, another tab); entering it is always a click on its own button.
  useEffect(() => {
    const sync = () => setFullscreen(typeof document !== "undefined" && !!theaterRef.current && document.fullscreenElement === theaterRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const leaveFullscreen = useCallback(() => {
    if (typeof document !== "undefined" && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, []);
  const toggleFullscreen = () => {
    const el = theaterRef.current;
    if (!el) return;
    if (document.fullscreenElement) leaveFullscreen();
    else void el.requestFullscreen?.().catch(() => undefined);
  };
  // anything that opens outside the theater (page dialogs, the dictionary, Echo) first leaves fullscreen so it is visible
  useEffect(() => {
    if (showQuizModal || showAddModal || cardToDelete || showCardBlastModal) leaveFullscreen();
  }, [showQuizModal, showAddModal, cardToDelete, showCardBlastModal, leaveFullscreen]);
  const lookUpWord = (word: string) => {
    if (!word) return;
    leaveFullscreen();
    window.dispatchEvent(new CustomEvent("ec:dictionary:lookup", { detail: { word } }));
  };
  // Echo opens with a question ready in its composer; nothing is sent until the learner presses Send.
  const askEcho = (word: string) => {
    if (!word) return;
    leaveFullscreen();
    window.dispatchEvent(new CustomEvent("echo:ask", { detail: { text: `Giải thích giúp mình từ “${word}”: nghĩa thường gặp, cách dùng và 2 câu ví dụ dễ nhớ.` } }));
  };
  const closeInsights = () => { setInsightsOpen(false); insightsButton.current?.focus({ preventScroll: true }); };

  // Subtle multi-depth pointer parallax across the celestial world & card light field (mouse only, rAF-throttled, never React state).
  const parallaxFrame = useRef(0);
  const handleTheaterPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType !== "mouse" || parallaxFrame.current) return;
    const el = theaterRef.current;
    if (!el) return;
    const { clientX, clientY } = e;
    parallaxFrame.current = requestAnimationFrame(() => {
      parallaxFrame.current = 0;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--px", (((clientX - r.left) / Math.max(1, r.width)) * 2 - 1).toFixed(3));
      el.style.setProperty("--py", (((clientY - r.top) / Math.max(1, r.height)) * 2 - 1).toFixed(3));
    });
  }, []);
  const handleTheaterPointerLeave = useCallback(() => {
    const el = theaterRef.current;
    if (!el) return;
    el.style.removeProperty("--px");
    el.style.removeProperty("--py");
  }, []);
  useEffect(() => () => { if (parallaxFrame.current) cancelAnimationFrame(parallaxFrame.current); }, []);
  const theaterParallax = typeof window !== "undefined" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Unauthenticated State
  if (status === "unauthenticated") {
    return <section className={STUDY_FRAME}><div className="w-full"><AuthRequired /></div></section>;
  }

  // =========================================================================
  // SCREEN 1: DECK CATALOG VIEW (DEFAULT WHEN selectedDeck === null)
  // =========================================================================
  if (selectedDeck === null && vaultOpen) {
    return <MemoryVault userScope={userScope} onBack={() => { setVaultOpen(false); void mutateDecks(); }} />;
  }

  if (selectedDeck === null) {
    return (
      <div className="w-full">
        {/* Hidden File Input for Anki .apkg */}
        <input
          type="file"
          accept=".apkg"
          ref={fileInputRef}
          onChange={handleFileChange}
          className="hidden"
        />

        <DeckCatalogView
          decks={decksData || []}
          personalTotalCards={personalTotalCards}
          personalDueCards={personalDueCards}
          personalMasteredCards={personalMasteredCards}
          onSelectDeck={handleSelectDeck}
          onReviewDue={() => { void handleSelectDeck(dueReviewDeck(false)); }}
          onAddCard={() => setShowAddModal(true)}
          onImportApkg={() => fileInputRef.current?.click()}
          onOpenStudio={() => setStudioOpen(true)}
          onOpenVault={() => setVaultOpen(true)}
          loading={!catalogKnown}
          progressLoading={!progressKnown}
          error={catalogError ? "Không thể tải kho từ vựng. Vui lòng thử lại." : undefined}
          onRetry={() => { void mutateAllDecks(); }}
        />

        {/* MODALS */}
        <AddFlashcardModal
          isOpen={showAddModal}
          onClose={() => setShowAddModal(false)}
          onSave={handleAddFlashcard}
          isSaving={isSaving}
        />

        {studioOpen && (
          <CardStudio
            open={studioOpen}
            onClose={() => setStudioOpen(false)}
            onSaved={() => { void mutateDecks(); triggerGlobalStatsRevalidation(); }}
          />
        )}


        <CardBlastModal
          isOpen={showCardBlastModal}
          onClose={() => setShowCardBlastModal(false)}
          deck={null}
          availableCards={libraryCards}
          allDecks={decksData || []}
          initialPvpCode={pvpParam || undefined}
        />
      </div>
    );
  }

  // =========================================================================
  // the due-review entry has no deck: stats, due list and library are the learner's whole collection (server, deckId absent)
  const isDueReview = selectedDeck?.slug === DUE_REVIEW_SLUG || selectedDeck?.slug === LEARNED_REVIEW_SLUG;
  const isPersonalDeck = !isDueReview && (selectedDeck?.id === null || selectedDeck?.slug === "personal");
  const deckScopedTotal = isPersonalDeck
    ? personalTotalCards
    : isDueReview ? (stats?.totalCards ?? totalElements) : (selectedDeck?.totalWords ?? totalElements);
  const deckScopedMastered = stats?.masteredCards ?? stats?.masteredCount ?? selectedDeck?.masteredCount ?? 0;
  const deckScopedLearning = stats?.learningCards ?? stats?.learningCount ?? selectedDeck?.learningCount ?? deckScopedTotal;
  const deckScopedDue = stats?.dueCards ?? stats?.dueCount ?? selectedDeck?.dueCount ?? reviewQueue.length;
  const effectiveTotalCards = deckScopedTotal;

  // the existing vocabulary management UI (search, filters, table, audio, actions); inside a study session without the
  // four-number strip (the companion already shows those numbers)
  const renderLibrary = (showStats: boolean) => (
        <FlashcardLibraryView
          cards={libraryCards}
          allCards={libraryCards}
          dueCards={cards}
          totalCount={deckScopedTotal}
          masteredCount={deckScopedMastered}
          learningCount={deckScopedLearning}
          dueCount={deckScopedDue}
          searchInput={searchInput}
          onSearchChange={(search) => {
            setSearchInput(search);
            setLibPage(0);
          }}
          activeFilter={activeFilter}
          onFilterChange={(filter) => {
            setActiveFilter(filter);
            setLibPage(0);
          }}
          page={libPage}
          totalPages={totalPages}
          totalElements={deckScopedTotal}
          onPageChange={setLibPage}
          onCardClick={handleFlashcardClick}
          onToggleAudio={toggleAudio}
          isPlaying={isPlaying}
          onResetProgress={resetCardProgress}
          onDeleteCard={setCardToDelete}
          onAddCard={() => setShowAddModal(true)}
          onImportApkg={() => fileInputRef.current?.click()}
          isSaving={isSaving}
          isPersonalDeck={isPersonalDeck}
          showStats={showStats}
        />
  );

  const leaveDeck = () => {
    leaveFullscreen();
    mutateDecks();
    setSelectedDeck(null);
    setIsStudying(false);
    setManualOverrideCard(null);
    setInsightsOpen(false);
  };
  const categoryLabel = selectedDeck.category
    ? (selectedDeck.category === "TOPIC" ? "Chủ đề đời sống" : selectedDeck.category.replace("_", " "))
    : null;

  /* 1. THE STUDY STAGE — the effect layer is positioned over it, so a rating's effect keeps its place when the page scrolls
        and survives the card change and the switch to the completion screen */
  const stage = (
      <div ref={stageRef} className="relative" data-tide={tide ?? undefined}>
      <div className={pulse.layer} aria-hidden="true">
        {fx.map((f) => <RatingFx key={f.id} event={f} />)}
      </div>
      {effectiveTotalCards === 0 && !loading ? (
        /* Empty Deck State */
        <EmptyDeckView
          onAddCard={() => setShowAddModal(true)}
          onImportApkg={() => fileInputRef.current?.click()}
        />
      ) : isStudying && displayCard ? (
        /* Active study: one card, three memory ratings */
        <StudyDeckView
          card={displayCard}
          phase={phase}
          position={passCounts.position}
          sessionTotal={passTotal}
          completedCount={passCounts.done}
          dueRemaining={pendingQueue.length}
          tally={tally}
          passMarks={passReviewedIds.map((id) => passMarks[id] ?? null)}
          deckTotalWords={selectedDeck?.totalWords || effectiveTotalCards}
          masteredCount={deckScopedMastered}
          flipped={flipped}
          onFlip={handleFlip}
          onToggleAudio={toggleAudio}
          isPlaying={isPlaying}
          onRate={handleReview}
          reviewError={reviewError && (reviewError.cardId === displayCard.id || !pendingQueue.some((c) => c.id === reviewError.cardId)) ? reviewError : null}
          onRetry={(err) => { void handleReview(err.quality, err.cardId); }}
          onDismissError={() => setReviewError(null)}
          savingQuality={savingQuality}
          shortcutsEnabled={shortcutsEnabled}
          isManualOverride={!!manualOverrideCard}
          recallMode={recallMode}
          onRecallModeChange={changeRecallMode}
          tier={tiers[displayCard.id]?.tier ?? null}
          weak={!!tiers[displayCard.id]?.weak}
          onOpenForge={() => { leaveFullscreen(); setForgeCard({ id: displayCard.id, word: displayCard.dictionaryEntry?.word || "" }); }}
          onLookup={lookUpWord}
          onAskEcho={askEcho}
        />
      ) : isStudying && !dueKnown ? (
        /* Due cards not known yet: a card-shaped placeholder in the card's place, never a false "all done" */
        <div className="mx-auto w-full max-w-[840px] pt-14" aria-busy="true">
          <div className="h-[clamp(340px,54vh,470px)] animate-pulse rounded-[32px] bg-gradient-to-br from-indigo-200/70 to-cyan-100/70 dark:from-indigo-900/50 dark:to-slate-800" />
        </div>
      ) : isStudying && dueError && cards.length === 0 ? (
        <div className="mx-auto max-w-xl rounded-3xl border border-rose-200 bg-rose-50 p-6 text-rose-800 dark:border-rose-500/30 dark:bg-rose-950 dark:text-rose-200" role="alert">
          <p className="font-bold">Không tải được danh sách thẻ cần ôn.</p>
          <button type="button" onClick={() => { void mutateDue(); }} className="mt-3 min-h-[2.5rem] rounded-xl bg-rose-600 px-4 text-sm font-bold text-white hover:bg-rose-700">
            Thử lại
          </button>
        </div>
      ) : isStudying ? (
        /* End of a pass */
        <div className="mx-auto w-full max-w-[1100px]">
        <CaughtUpView
          tally={tally}
          trail={trail}
          newlyMastered={newlyMastered}
          remainingDue={Math.max(reviewQueue.length, dueData?.totalElements ?? 0)}
          onBackToLibrary={() => {
            leaveFullscreen();
            triggerGlobalStatsRevalidation();
            setInsightsOpen(false);
            setIsStudying(false);
          }}
          onReviewRemaining={() => {
            resetTimeline();
            setPassReviewedIds([]);
            setPassMarks({});
            passOrder.current = new Map();
            setCards(dueData?.content ? [...dueData.content] : []);
            setFlipped(false);
            void mutateDue();
          }}
          onCramMode={() => {
            if (libraryCards.length > 0) {
              resetTimeline();
              setManualOverrideCard(libraryCards[0]);
              setFlipped(false);
              setIsStudying(true);
            }
          }}
        />
        </div>
      ) : null}
      </div>
  );

  /* 3. MODALS */
  const modals = (
    <>
      <AddFlashcardModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSave={handleAddFlashcard}
        isSaving={isSaving}
      />

      <FlashcardGuide open={guideOpen} onClose={() => setGuideOpen(false)} />

      <MemoryForge card={forgeCard} open={!!forgeCard} onClose={() => setForgeCard(null)} />

      <DeleteConfirmModal
        card={cardToDelete}
        onClose={() => setCardToDelete(null)}
        onConfirm={confirmDelete}
      />

      <SpeedVocabQuizModal
        isOpen={showQuizModal}
        onClose={() => setShowQuizModal(false)}
        deck={selectedDeck}
        availableCards={libraryCards}
      />

      <CardBlastModal
        isOpen={showCardBlastModal}
        onClose={() => setShowCardBlastModal(false)}
        deck={selectedDeck}
        availableCards={libraryCards}
        allDecks={decksData || []}
        initialPvpCode={pvpParam || undefined}
      />
    </>
  );

  const fileInput = (
    <input
      type="file"
      accept=".apkg"
      ref={fileInputRef}
      onChange={handleFileChange}
      className="hidden"
    />
  );

  // =========================================================================
  // ECHO MEMORY THEATER — an active study pass (owner brief 2026-11-20): the card is the protagonist of one spatial scene;
  // deck identity, tools and numbers are a quiet ambient layer; details open on demand (insights sheet, tips, library pill).
  // =========================================================================
  if (isStudying && !(effectiveTotalCards === 0 && !loading)) {
    const back = flipped && (phase === "back" || phase === "pending");
    const sessionProgressRatio = passTotal > 0 ? passCounts.done / passTotal : 0;
    return (
      <section
        ref={theaterRef}
        className={theater.root}
        data-theater=""
        data-fullscreen={fullscreen ? "" : undefined}
        aria-label={`Học thẻ: ${selectedDeck.title}`}
        onPointerMove={theaterParallax ? handleTheaterPointerMove : undefined}
        onPointerLeave={theaterParallax ? handleTheaterPointerLeave : undefined}
      >
        {fileInput}
        <TheaterScene progressRatio={sessionProgressRatio} tide={tide} />

        <header className={theater.bar}>
          <div className={theater.deck}>
            <button type="button" className={theater.deckBack} onClick={leaveDeck} aria-label="Quay lại kho bộ từ" title="Quay lại kho bộ từ">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <h2 className={theater.deckTitle}>{selectedDeck.title}</h2>
            {categoryLabel && <span className={theater.deckChip}>{categoryLabel}</span>}
          </div>
          <div className={theater.barTools}>
            <button ref={insightsButton} type="button" className={theater.iconButton} aria-expanded={insightsOpen}
              aria-label="Bộ nhớ lượt này" title="Bộ nhớ lượt này" onClick={() => (insightsOpen ? closeInsights() : setInsightsOpen(true))}>
              <BarChart3 className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
            <button type="button" className={theater.iconButton} aria-label="Cách học Flashcard" title="Cách học Flashcard" onClick={() => { leaveFullscreen(); setGuideOpen(true); }}>
              <CircleHelp className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
            <button type="button" className={theater.iconButton} aria-pressed={fullscreen}
              aria-label={fullscreen ? "Thoát toàn màn hình" : "Toàn màn hình"} title={fullscreen ? "Thoát toàn màn hình" : "Toàn màn hình"} onClick={toggleFullscreen}>
              {fullscreen ? <Minimize2 className="h-[18px] w-[18px]" aria-hidden="true" /> : <Maximize2 className="h-[18px] w-[18px]" aria-hidden="true" />}
            </button>
            <button type="button" id="topbar-quiz-btn" className={theater.quiz} onClick={() => setShowQuizModal(true)}>
              <span className={theater.quizGlyph} aria-hidden="true">
                <Zap className="h-3.5 w-3.5" />
              </span>
              <span>Quiz Trắc nghiệm</span>
            </button>
          </div>
        </header>

        <div className={theater.stage} data-phase={phase}>{stage}</div>

        <footer className={theater.foot}>
          {/* 2. VOCABULARY LIBRARY — during a study session ONE folded pill (open on request) */}
          {effectiveTotalCards > 0 && isStudying && (
            <StudyLibraryDrawer open={libraryOpen} onOpenChange={setLibraryOpen} count={loading && !stats ? null : deckScopedTotal}>
              {renderLibrary(false)}
            </StudyLibraryDrawer>
          )}
          <TheaterTips back={back} vi showIntro={showIntro} onDismissIntro={dismissIntro} onOpenGuide={() => { leaveFullscreen(); setGuideOpen(true); }} />
        </footer>

        <StudyCompanion
          open={insightsOpen}
          onClose={closeInsights}
          tally={tally}
          dueRemaining={manualOverrideCard ? null : pendingQueue.length}
          totalCards={selectedDeck?.totalWords || effectiveTotalCards}
          masteredCount={deckScopedMastered}
          onOpenGuide={() => { leaveFullscreen(); setGuideOpen(true); }}
        />
        {modals}
      </section>
    );
  }

  // A deck outside a study pass: its full library (with its numbers) under the deck bar.
  return (
    <section className={STUDY_FRAME}><div className="w-full">
    <div className="w-full max-w-[1280px] mx-auto flex flex-col gap-8">
      {fileInput}

      {/* TOP NAVIGATION BAR FOR SCOPED DECK VIEW */}
      <div className="w-full flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={leaveDeck}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs sm:text-sm font-semibold transition cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Quay lại kho bộ từ</span>
          </button>
          <div className="h-5 w-px bg-slate-200 dark:bg-slate-700 hidden sm:block" />
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
              {selectedDeck.title}
            </h2>
            {categoryLabel && (
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/40">
                {categoryLabel}
              </span>
            )}
          </div>
        </div>

        {/* Quiz Button */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            id="topbar-quiz-btn"
            onClick={() => setShowQuizModal(true)}
            className="h-11 px-5 text-sm font-bold rounded-2xl shadow-md transition-all duration-200 transform hover:-translate-y-0.5 bg-gradient-to-r from-amber-500 via-orange-500 to-yellow-500 text-white shadow-amber-500/25 hover:shadow-amber-500/40 border border-amber-400/40 inline-flex items-center gap-2 cursor-pointer active:scale-95"
          >
            <Zap className="w-4 h-4 text-white fill-white" />
            <span>Quiz Trắc nghiệm</span>
          </button>
        </div>
      </div>

      {stage}

      {/* 2. VOCABULARY LIBRARY — outside a study session, the full library */}
      {effectiveTotalCards > 0 && !isStudying && renderLibrary(true)}

      {modals}
    </div>
    </div></section>
  );
}
