"use client";

import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  AlarmClock,
  BookOpen,
  Brain,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  PlusCircle,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  Volume2,
  X,
} from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { cardFace, type CardFaceDeckSense } from "./cardFace";
import { VocabSearchCombobox } from "./VocabSearchCombobox";
import s from "./theater/theaterLibrary.module.css";

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
  nextReviewDate: string;
  status: string;
  reviewCount: number;
  customMeaning?: string | null;
  customExample?: string | null;
  deckSense?: CardFaceDeckSense | null;
}

type LibraryFilter = "all" | "due" | "learning" | "mastered" | "hard" | "good" | "easy";
type LibrarySort = "default" | "az" | "reviews";

interface FlashcardLibraryViewProps {
  cards: Flashcard[];
  allCards?: Flashcard[];
  dueCards?: Flashcard[];
  totalCount?: number;
  masteredCount?: number;
  learningCount?: number;
  dueCount?: number;
  searchInput: string;
  onSearchChange: (value: string) => void;
  activeFilter: LibraryFilter;
  onFilterChange: (filter: LibraryFilter) => void;
  page: number;
  totalPages: number;
  totalElements: number;
  onPageChange: (newPage: number) => void;
  onCardClick: (card: Flashcard) => void;
  onToggleAudio: (e: React.MouseEvent, text: string) => void;
  isPlaying: boolean;
  onResetProgress: (cardId: number) => void;
  onDeleteCard: (card: Flashcard) => void;
  onAddCard: () => void;
  onImportApkg: () => void;
  isSaving?: boolean;
  isPersonalDeck?: boolean;
  /** The four-number strip. Off inside a study session: the study companion already shows those numbers. */
  showStats?: boolean;
}

const RATING_FILTERS: Array<{ id: "" | "hard" | "good" | "easy"; vi: string; en: string }> = [
  { id: "", vi: "Mọi mức", en: "Any rating" },
  { id: "easy", vi: "Dễ", en: "Easy" },
  { id: "good", vi: "Trung Bình", en: "Medium" },
  { id: "hard", vi: "Khó", en: "Hard" },
];

const SORT_OPTIONS: Array<{ id: LibrarySort; vi: string; en: string }> = [
  { id: "default", vi: "Mặc định", en: "Default" },
  { id: "az", vi: "A đến Z", en: "A to Z" },
  { id: "reviews", vi: "Ôn nhiều nhất", en: "Most reviewed" },
];

export function FlashcardLibraryView({
  cards,
  allCards,
  dueCards,
  totalCount,
  masteredCount: propMasteredCount,
  learningCount: propLearningCount,
  dueCount: propDueCount,
  searchInput,
  onSearchChange,
  activeFilter,
  onFilterChange,
  page,
  totalPages,
  totalElements,
  onPageChange,
  onCardClick,
  onToggleAudio,
  onResetProgress,
  onDeleteCard,
  onAddCard,
  onImportApkg,
  isSaving = false,
  isPersonalDeck = false,
  showStats = true,
}: FlashcardLibraryViewProps) {
  const { t, locale } = useLanguage();
  const vi = locale === "vi";
  const [pageInput, setPageInput] = useState<string | number>(page + 1);
  const [sortBy, setSortBy] = useState<LibrarySort>("default");
  const [filtersExpanded, setFiltersExpanded] = useState(
    activeFilter === "hard" || activeFilter === "good" || activeFilter === "easy",
  );
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPageInput(page + 1);
  }, [page]);

  // Focus search with '/' key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const masteredCount = propMasteredCount ?? (allCards ? allCards.filter((c) => c.status === "MASTERED").length : 0);
  const learningCount = propLearningCount ?? (allCards ? allCards.filter((c) => c.status === "LEARNED" || c.status === "NEW").length : 0);
  const dueCount = propDueCount ?? (dueCards ? dueCards.length : 0);
  const totalCountVal = totalCount ?? (allCards ? allCards.length : 0);

  const isRatingFilter = activeFilter === "hard" || activeFilter === "good" || activeFilter === "easy";
  const secondaryActiveCount = (isRatingFilter ? 1 : 0) + (sortBy !== "default" ? 1 : 0);

  const sortedCards = useMemo(() => {
    if (sortBy === "default") return cards;
    const next = [...cards];
    if (sortBy === "az") {
      next.sort((a, b) =>
        (cardFace(a).word || "").localeCompare(cardFace(b).word || "", "en", { sensitivity: "base" }),
      );
    } else if (sortBy === "reviews") {
      next.sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0));
    }
    return next;
  }, [cards, sortBy]);

  const commitPageJump = () => {
    let newPage = parseInt(String(pageInput), 10);
    if (Number.isNaN(newPage) || newPage <= 0) newPage = 1;
    else if (newPage > totalPages) newPage = totalPages;
    setPageInput(newPage);
    onPageChange(newPage - 1);
  };

  return (
    <section className={s.root} data-theater-library="">
      {/* 1. Floating Glass Metric Crystals (outside active study pass) */}
      {showStats && (
        <div className={s.metrics}>
          <div className={s.metricCard}>
            <span className={s.metricOrb} data-tone="due" aria-hidden="true">
              <AlarmClock className="h-5 w-5" />
            </span>
            <div className={s.metricBody}>
              <span className={s.metricLabel}>{t.reviewPending}</span>
              <strong className={s.metricVal}>{dueCount.toLocaleString(vi ? "vi-VN" : "en-US")}</strong>
            </div>
          </div>

          <div className={s.metricCard}>
            <span className={s.metricOrb} data-tone="learning" aria-hidden="true">
              <Brain className="h-5 w-5" />
            </span>
            <div className={s.metricBody}>
              <span className={s.metricLabel}>{t.learningState}</span>
              <strong className={s.metricVal}>{learningCount.toLocaleString(vi ? "vi-VN" : "en-US")}</strong>
            </div>
          </div>

          <div className={s.metricCard}>
            <span className={s.metricOrb} data-tone="mastered" aria-hidden="true">
              <CheckCircle2 className="h-5 w-5" />
            </span>
            <div className={s.metricBody}>
              <span className={s.metricLabel}>{t.masteredTerms}</span>
              <strong className={s.metricVal}>{masteredCount.toLocaleString(vi ? "vi-VN" : "en-US")}</strong>
            </div>
          </div>

          <div className={s.metricCard}>
            <span className={s.metricOrb} data-tone="total" aria-hidden="true">
              <Database className="h-5 w-5" />
            </span>
            <div className={s.metricBody}>
              <span className={s.metricLabel}>{t.totalTracked}</span>
              <strong className={s.metricVal}>{totalCountVal.toLocaleString(vi ? "vi-VN" : "en-US")}</strong>
            </div>
          </div>
        </div>
      )}

      {/* 2. Single Unified Liquid-Glass Search & Filter Ribbon */}
      <div className={s.ribbon}>
        <div className={s.searchRow}>
          <div className={s.searchWrap}>
            <Search className={`${s.searchIcon} h-4 w-4`} aria-hidden="true" />
            <VocabSearchCombobox
              inputRef={searchRef}
              value={searchInput}
              onChange={onSearchChange}
              placeholder={t.searchPlaceholderFlashcards}
              vi={vi}
              variant="theater"
            />
            {searchInput && (
              <button
                type="button"
                className={s.searchClear}
                aria-label={vi ? "Xóa từ khóa tìm kiếm" : "Clear search"}
                onClick={() => onSearchChange("")}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
            <span className={s.searchKey} aria-hidden="true">
              <kbd>/</kbd>
            </span>
          </div>

          <div className={s.ribbonActions}>
            <button
              type="button"
              className={s.toggleFilters}
              aria-expanded={filtersExpanded}
              data-active={secondaryActiveCount > 0 ? "true" : "false"}
              onClick={() => setFiltersExpanded((v) => !v)}
            >
              <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
              <span>{vi ? "Bộ lọc và sắp xếp" : "Filter and sort"}</span>
              {secondaryActiveCount > 0 && <span className={s.filterBadge}>{secondaryActiveCount}</span>}
            </button>

            {isPersonalDeck && (
              <>
                <button type="button" onClick={onImportApkg} className={s.actionGhost}>
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  <span>{t.importApkg}</span>
                </button>
                <button type="button" id="library-add-card-btn" onClick={onAddCard} className={s.actionPrimary}>
                  <PlusCircle className="h-4 w-4" aria-hidden="true" />
                  <span>{t.addFlashcard}</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Status Capsules */}
        <div className={s.tabsRow}>
          <div className={s.tabs} role="group" aria-label={vi ? "Lọc theo trạng thái học" : "Filter by learning status"}>
            <button
              type="button"
              className={s.tab}
              aria-pressed={activeFilter === "all"}
              onClick={() => onFilterChange("all")}
            >
              <span>{t.allVocabulary}</span>
              <span className={s.tabCount}>{totalCountVal.toLocaleString(vi ? "vi-VN" : "en-US")}</span>
            </button>

            <button
              type="button"
              className={s.tab}
              aria-pressed={activeFilter === "due"}
              onClick={() => onFilterChange("due")}
            >
              <span className={s.tabDot} data-tone="due" aria-hidden="true" />
              <span>{t.dueForReview}</span>
              <span className={s.tabCount}>{dueCount.toLocaleString(vi ? "vi-VN" : "en-US")}</span>
            </button>

            <button
              type="button"
              className={s.tab}
              aria-pressed={activeFilter === "learning"}
              onClick={() => onFilterChange("learning")}
            >
              <span className={s.tabDot} data-tone="learning" aria-hidden="true" />
              <span>{t.learning}</span>
              <span className={s.tabCount}>{learningCount.toLocaleString(vi ? "vi-VN" : "en-US")}</span>
            </button>

            <button
              type="button"
              className={s.tab}
              aria-pressed={activeFilter === "mastered"}
              onClick={() => onFilterChange("mastered")}
            >
              <span className={s.tabDot} data-tone="mastered" aria-hidden="true" />
              <span>{t.mastered}</span>
              <span className={s.tabCount}>{masteredCount.toLocaleString(vi ? "vi-VN" : "en-US")}</span>
            </button>
          </div>

          <span className={s.resultSummary}>
            {vi
              ? `Trang ${page + 1}/${Math.max(1, totalPages)} · ${totalElements.toLocaleString("vi-VN")} từ`
              : `Page ${page + 1}/${Math.max(1, totalPages)} · ${totalElements.toLocaleString("en-US")} words`}
          </span>
        </div>

        {/* Progressive Disclosure: Last Rating & Sort */}
        {filtersExpanded && (
          <div className={s.secondaryTray}>
            <div className={s.trayGroup}>
              <span className={s.trayLabel}>{vi ? "Lần chấm gần nhất" : "Last rating"}</span>
              <div className={s.chipGroup} role="group" aria-label={vi ? "Lọc theo lần chấm gần nhất" : "Filter by last rating"}>
                {RATING_FILTERS.map((rf) => {
                  const pressed = rf.id === "" ? !isRatingFilter : activeFilter === rf.id;
                  return (
                    <button
                      key={rf.id || "any"}
                      type="button"
                      className={s.miniChip}
                      data-rating={rf.id || undefined}
                      aria-pressed={pressed}
                      onClick={() => onFilterChange((rf.id || "all") as LibraryFilter)}
                    >
                      {vi ? rf.vi : rf.en}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className={s.trayGroup}>
              <span className={s.trayLabel}>{vi ? "Sắp xếp trang này" : "Sort page"}</span>
              <div className={s.chipGroup} role="group" aria-label={vi ? "Sắp xếp danh sách" : "Sort vocabulary list"}>
                {SORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={s.miniChip}
                    aria-pressed={sortBy === opt.id}
                    onClick={() => setSortBy(opt.id)}
                  >
                    {vi ? opt.vi : opt.en}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 3. Spatial Liquid-Glass Word Card Grid */}
      {sortedCards.length > 0 ? (
        <div className={s.grid} role="list" aria-label={vi ? "Danh sách từ vựng" : "Vocabulary cards"}>
          {sortedCards.map((c) => {
            const face = cardFace(c);
            const word = face.word || (vi ? "Chưa có từ" : "Unknown");
            const translationVi = face.headlineVi ? face.headline : null;
            const englishDef = face.headlineVi ? face.definitions[0] : face.headline;
            const meaning = translationVi || englishDef || (vi ? "Chưa có nghĩa" : "No meaning yet");
            const example = face.examples[0] || "";
            const isDue = !c.nextReviewDate || new Date(c.nextReviewDate) <= new Date();
            const cardStatus: "mastered" | "due" | "learning" =
              c.status === "MASTERED" ? "mastered" : isDue ? "due" : "learning";
            const statusText =
              cardStatus === "mastered"
                ? t.mastered
                : cardStatus === "due"
                  ? t.dueForReview
                  : t.learning;
            const expanded = expandedId === c.id;
            const hasLongDetail = (englishDef && translationVi && englishDef.length > 48) || example.length > 72;

            return (
              <article
                key={c.id}
                role="listitem"
                tabIndex={0}
                className={s.wordCard}
                data-status={cardStatus}
                data-expanded={expanded ? "true" : "false"}
                onClick={() => onCardClick(c)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    if ((e.target as HTMLElement).closest("button")) return;
                    e.preventDefault();
                    onCardClick(c);
                  }
                }}
              >
                <div className={s.cardHead}>
                  <div className={s.cardTitleGroup}>
                    <div className={s.cardWordRow} lang="en">
                      <h3 className={`${s.cardWord} notranslate`} translate="no">
                        {word}
                      </h3>
                      {face.ipa && (
                        <span className={`${s.cardIpa} notranslate`} translate="no">
                          {face.ipa}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className={s.cardActions}>
                    <button
                      type="button"
                      className={s.cardIconBtn}
                      title={vi ? `Phát âm “${word}”` : `Pronounce “${word}”`}
                      aria-label={vi ? `Phát âm “${word}”` : `Pronounce “${word}”`}
                      onClick={(e) => onToggleAudio(e, word)}
                    >
                      <Volume2 className="h-4 w-4" aria-hidden="true" />
                    </button>

                    {c.status === "MASTERED" ? (
                      <button
                        type="button"
                        className={s.cardIconBtn}
                        data-tone="warn"
                        title={vi ? "Đặt lại tiến độ để ôn lại từ này" : "Reset progress to re-learn"}
                        aria-label={vi ? `Đặt lại tiến độ “${word}”` : `Reset “${word}”`}
                        disabled={isSaving}
                        onClick={(e) => {
                          e.stopPropagation();
                          onResetProgress(c.id);
                        }}
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={s.cardIconBtn}
                        data-tone="danger"
                        title={vi ? "Xóa thẻ" : "Delete card"}
                        aria-label={vi ? `Xóa thẻ “${word}”` : `Delete “${word}”`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteCard(c);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>

                <p className={s.cardMeaning}>{translationVi || meaning}</p>

                {englishDef && translationVi && (
                  <p className={s.cardDef} lang="en">
                    {englishDef}
                  </p>
                )}

                {example && (
                  <p className={s.cardExample} lang="en">
                    “{example}”
                  </p>
                )}

                <div className={s.cardFoot}>
                  <span className={s.statusPill} data-status={cardStatus}>
                    <i aria-hidden="true" />
                    {statusText}
                  </span>

                  <div className={s.cardMeta}>
                    {hasLongDetail && (
                      <button
                        type="button"
                        className={s.expandBtn}
                        aria-expanded={expanded}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedId(expanded ? null : c.id);
                        }}
                      >
                        {expanded ? (vi ? "Thu gọn" : "Less") : vi ? "Chi tiết" : "More"}
                      </button>
                    )}
                    <span>
                      {c.reviewCount > 0
                        ? vi
                          ? `${c.reviewCount} lần ôn`
                          : `${c.reviewCount} reviews`
                        : vi
                          ? "Từ mới"
                          : "New"}
                    </span>
                    {c.nextReviewDate && (
                      <span>· {new Date(c.nextReviewDate).toLocaleDateString(vi ? "vi-VN" : "en-US")}</span>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className={s.empty}>
          <span className={s.emptyIcon} aria-hidden="true">
            <BookOpen className="h-6 w-6" />
          </span>
          <p className={s.emptyTitle}>
            {vi ? "Không tìm thấy thẻ từ vựng nào" : "No flashcards found"}
          </p>
          <p className={s.emptySub}>
            {vi ? "Thử thay đổi từ khóa tìm kiếm hoặc bộ lọc trạng thái." : "Try adjusting your search query or status filter."}
          </p>
        </div>
      )}

      {/* 4. Glass Pagination Bar */}
      {sortedCards.length > 0 && (
        <nav className={s.pager} aria-label={vi ? "Phân trang thư viện từ vựng" : "Vocabulary library pagination"}>
          <button
            type="button"
            className={s.pagerBtn}
            disabled={page <= 0}
            onClick={() => onPageChange(Math.max(0, page - 1))}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            <span>{vi ? "Trang trước" : "Previous"}</span>
          </button>

          <div className={s.pagerCenter}>
            <span>{vi ? "Trang" : "Page"}</span>
            <input
              type="number"
              min={1}
              max={Math.max(1, totalPages)}
              value={pageInput}
              aria-label={vi ? "Số trang" : "Page number"}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={commitPageJump}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitPageJump();
                }
              }}
              className={s.pagerInput}
            />
            <span>
              {vi ? "trên" : "of"} {Math.max(1, totalPages)}
            </span>
          </div>

          <button
            type="button"
            className={s.pagerBtn}
            disabled={page + 1 >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            <span>{vi ? "Trang sau" : "Next"}</span>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </nav>
      )}
    </section>
  );
}
