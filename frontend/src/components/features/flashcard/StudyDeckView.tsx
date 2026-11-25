"use client";

import React from "react";
import { Layers } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { FlashcardHero } from "./FlashcardHero";
import type { SessionTally } from "./StudyCompanion";
import { RecallControls, type RecallQuality } from "./RecallControls";
import type { ReviewError } from "./FlashcardUI";
import type { RecallMode } from "./tides/recall";
import { ratingsShown, type StudyPhase } from "./tides/studyTimeline";
import type { MemoryTier } from "@/types/flashcardMemory";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import { MasteryHalo, MemoryCurrent, OrbitTools } from "./theater/TheaterHud";
import th from "./theater/theater.module.css";
import tides from "./tides/memoryTides.module.css";

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

interface StudyDeckViewProps {
  card: Flashcard;
  /** The card's step on the study timeline (tides/studyTimeline.ts). */
  phase?: StudyPhase;
  /** 1-based place of this card in the current pass, and the pass size (reviewed + still due). */
  position: number;
  sessionTotal: number;
  /** Number of cards already confirmed in this pass (separate from total deck mastery). */
  completedCount?: number;
  /** Due cards of this deck that are still waiting in this pass (the card on screen included). */
  dueRemaining: number;
  tally: SessionTally;
  /** The stored rating of each card already rated in this pass, in pass order (null = skipped, e.g. a deleted card). */
  passMarks?: Array<RecallQuality | null>;
  deckTotalWords: number;
  masteredCount: number;
  flipped: boolean;
  onFlip: () => void;
  onToggleAudio: (e: React.MouseEvent, text: string) => void;
  isPlaying: boolean;
  onRate: (quality: RecallQuality, cardId: number) => void;
  /** The last rating that could not be saved (the card stayed), with a retry of that same rating. */
  reviewError?: ReviewError | null;
  onRetry?: (error: ReviewError) => void;
  onDismissError?: () => void;
  savingQuality: RecallQuality | null;
  shortcutsEnabled: boolean;
  isManualOverride?: boolean;
  /** Deep Recall mode of this browser (optional activities; the schedule is unchanged). */
  recallMode?: RecallMode;
  onRecallModeChange?: (mode: RecallMode) => void;
  /** Card Alchemy tier of the card on screen, and whether it is a word the learner keeps finding hard (server evidence). */
  tier?: MemoryTier | null;
  weak?: boolean;
  onOpenForge?: () => void;
  /** Real tools for the word on the card (open only after the turn): the global dictionary, and Echo with a question ready. */
  onLookup?: (word: string) => void;
  onAskEcho?: (word: string) => void;
}

const MODES: Array<{ id: RecallMode; vi: string; en: string; title: [string, string] }> = [
  { id: "flip", vi: "Lật thẻ", en: "Flip", title: ["Nhớ trong đầu rồi lật thẻ", "Recall in your head, then turn"] },
  { id: "type", vi: "Gõ nghĩa", en: "Type", title: ["Gõ nghĩa bạn nhớ trước khi lật", "Type the meaning before turning"] },
  { id: "cloze", vi: "Điền từ", en: "Cloze", title: ["Điền từ vào câu ví dụ đã lưu", "Fill the word into a stored example"] },
];

/**
 * Echo Memory Theater — the study composition (owner brief 2026-11-20). One protagonist: the card, centred in the study
 * viewport on a luminous pedestal. Around it, quiet and ambient: the pass as a Memory Current (session progress), the recall
 * modes, an orbit of real tools for the word (open only after the turn), the deck's mastery halo (long-term, separate from
 * the pass) and, under the pedestal, the rating dock where Khó · Tốt · Dễ arrive only once the back has finished turning.
 * The pointer leans the light field a few pixels (mouse only); the card itself stays still and crisp.
 */
export function StudyDeckView({
  card,
  phase,
  position,
  sessionTotal,
  completedCount,
  dueRemaining,
  passMarks = [],
  deckTotalWords,
  masteredCount,
  flipped,
  onFlip,
  onToggleAudio,
  isPlaying,
  onRate,
  reviewError = null,
  onRetry,
  onDismissError,
  savingQuality,
  shortcutsEnabled,
  isManualOverride = false,
  recallMode = "flip",
  onRecallModeChange,
  tier = null,
  weak = false,
  onOpenForge,
  onLookup,
  onAskEcho,
}: StudyDeckViewProps) {
  const { locale } = useLanguage();
  const vi = locale === "vi";
  const done = completedCount !== undefined ? Math.max(0, completedCount) : Math.max(0, position - 1);
  const shownPhase: StudyPhase = phase ?? (flipped ? "back" : "front");
  // the ratings arrive only when the back has finished turning, and stay until the card has left
  const ratingsVisible = flipped && ratingsShown(shownPhase);
  const saving = savingQuality !== null;
  const word = card.dictionaryEntry?.word || "";
  const toolsReady = flipped && (shownPhase === "back" || shownPhase === "pending");

  return (
    <div className={th.study} data-phase={shownPhase}>
      <div className={th.hud}>
        <span className={th.counter}>
          <Layers className="h-4 w-4" aria-hidden="true" />
          {isManualOverride ? (vi ? "Thẻ từ thư viện" : "Library card") : <>{vi ? "Thẻ" : "Card"} {position} <span>/ {sessionTotal}</span></>}
        </span>
        {isManualOverride ? <span aria-hidden="true" /> : <MemoryCurrent total={sessionTotal} done={done} marks={passMarks} vi={vi} />}
        <div className={`${th.hudEnd} flex items-center gap-2 justify-self-end`}>
          <MasteryHalo mastered={masteredCount} total={deckTotalWords} vi={vi} compact />
          {onRecallModeChange && (
            <div className={th.modes} role="group" aria-label={vi ? "Cách nhớ lại" : "Recall mode"} data-guide="fc-recall-mode">
              {MODES.map((m) => (
                <button key={m.id} type="button" aria-pressed={recallMode === m.id} title={m.title[vi ? 0 : 1]} onClick={() => onRecallModeChange(m.id)}>
                  {vi ? m.vi : m.en}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {reviewError && (
        <div className={th.reviewError} role="alert">
          <p className="m-0 min-w-0 flex-1">{reviewError.message}</p>
          {reviewError.cardId === card.id && onRetry && (
            <button type="button" className={th.reviewRetry} onClick={() => onRetry(reviewError)} disabled={savingQuality !== null}>
              {vi ? "Thử lại" : "Retry"}
            </button>
          )}
          {onDismissError && (
            <button type="button" className={th.reviewDismiss} onClick={onDismissError} aria-label={vi ? "Đóng thông báo" : "Dismiss"}>
              ×
            </button>
          )}
        </div>
      )}

      <div className={th.arena}>
        <div className={`${th.side} ${th.sideStart}`}>
          <OrbitTools word={word} ready={toolsReady} weak={weak} vi={vi}
            onLookup={() => onLookup?.(word)} onForge={() => onOpenForge?.()} onAskEcho={() => onAskEcho?.(word)} />
        </div>

        <section className={th.cardColumn} aria-label={vi ? "Thẻ đang học" : "Current card"}>
          <div className={th.aura} aria-hidden="true" />
          <div className={th.cardFloat}>
            <FlashcardHero
              key={card.id}
              card={card}
              flipped={flipped}
              onFlip={onFlip}
              onToggleAudio={onToggleAudio}
              isPlaying={isPlaying}
              savingQuality={savingQuality}
              shortcutsEnabled={shortcutsEnabled}
              recallMode={recallMode}
              tier={tier}
              phase={phase}
            />
          </div>
          <div className={th.pedestal} aria-hidden="true"><i /><i /><i /></div>

          <div className={th.dock} data-ready={ratingsVisible ? "true" : "false"}>
            <div className={th.dockRatings} inert={!ratingsVisible}>
              <RecallControls
                onRate={(q) => onRate(q, card.id)}
                savingQuality={savingQuality}
                enabled={flipped && shownPhase === "back" && shortcutsEnabled && !saving}
              />
            </div>
          </div>

          {weak && flipped && onOpenForge && (
            <div className={th.forgeHint}>
              <span>{vi ? "Từ này bạn đã thấy khó ở nhiều ngày khác nhau." : "You have found this word hard on several days."}</span>
              <button type="button" className={tides.linkButton} onClick={onOpenForge}>
                <BrandWhaleIcon size="xs" clean />
                {vi ? "Thử cách ghi nhớ khác" : "Try another way to remember"}
              </button>
            </div>
          )}
        </section>

        <div className={`${th.side} ${th.sideEnd}`}>
          <MasteryHalo mastered={masteredCount} total={deckTotalWords} vi={vi} />
        </div>
      </div>
    </div>
  );
}
