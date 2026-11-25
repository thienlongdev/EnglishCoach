"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Hourglass,
  Layers,
  Library,
  Play,
  RotateCcw,
  Search,
  Shell,
  X,
} from "lucide-react";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import { PageJump } from "@/components/common/PageJump";
import Link from "next/link";
import styles from "./memoryUniverse.module.css";
import indexedFacets from "./libraryFacets.json";
const facets: Record<string,{levels:string[],forms:string[],topic:string,subtopic:string}> = indexedFacets;
import { deckArtFor, FLASHCARD_HERO_ART, type DeckArt } from "./deckArt";

export interface VocabDeckSummary {
  latestRatings?: string[];
  id: number | null;
  slug: string;
  title: string;
  description: string;
  category: string;
  themeColor: string;
  icon: string;
  totalWords: number;
  isSystem: boolean;
  sortOrder: number;
  masteredCount: number;
  reviewedCount: number;
  learningCount: number;
  dueCount: number;
  progressPercentage: number;
  isEnrolled: boolean;
}

interface DeckCatalogViewProps {
  decks: VocabDeckSummary[];
  personalTotalCards: number;
  personalDueCards: number;
  personalMasteredCards: number;
  onSelectDeck: (deck: VocabDeckSummary) => void;
  /** Opens the study of every due card (the same pseudo deck as `?review=due`). */
  onReviewDue?: () => void;
  onAddCard: () => void;
  onImportApkg: () => void;
  /** Echo Memory Tides 2.0: Echo AI Card Studio (dialog) and Memory Universe (Card Vault + Memory Reef). */
  onOpenStudio?: () => void;
  onOpenVault?: () => void;
  loading?: boolean;
  progressLoading?: boolean;
  error?: string;
  onRetry?: () => void;
}

/*
 * Thẻ từ vựng — "Echo Memory Universe" (owner brief 2026-10-24). Presentation only: the same catalog + progress data,
 * the same filters, search and study entry (`onSelectDeck`, which enrolls a system deck first). Every number on this
 * page is a catalog / progress value or "…" while unknown — never an invented metric. Deck pictures are rendered stills
 * of each deck's own topic (`docs/flashcards/memory-universe-2026-10-24/art/`); a deck without its own picture gets a
 * typographic cover, never another deck's art.
 */

const CATEGORY_TABS = [
  { id: "ALL", label: "Tất cả" },
  { id: "TOEIC_SCORE", label: "TOEIC theo khoảng điểm" },
  { id: "IELTS_BAND", label: "IELTS theo band điểm" },
  { id: "BOOK_COLLECTION", label: "Từ sách đến thẻ" },
  { id: "TOPIC", label: "Chủ đề đời sống" },
  { id: "GENERAL_CEFR", label: "Tiếng Anh theo cấp độ" },
  { id: "EXAM_READING", label: "Đọc IELTS và TOEFL" },
  { id: "BIG_IDEAS", label: "Khám phá chuyên ngành" },
  { id: "IDIOMS", label: "Thành ngữ" },
  { id: "ESSENTIAL_4K", label: "4K Vocabulary" },
  { id: "IELTS_TOPIC", label: "Chủ đề IELTS" },
  { id: "OXFORD", label: "Oxford Core and Academic" },
  { id: "PHRASAL_VERBS", label: "Phrasal Verbs" },
  { id: "COLLOCATIONS", label: "Collocations" },
];

const CATEGORY_LABEL: Record<string, string> = {
  TOEIC_SCORE: "TOEIC theo khoảng điểm",
  IELTS_BAND: "IELTS theo band điểm",
  BOOK_COLLECTION: "Từ sách đến thẻ",
  TOPIC: "Chủ đề đời sống",
  GENERAL_CEFR: "Tiếng Anh theo cấp độ", EXAM_READING: "Đọc IELTS và TOEFL",
  READING_LAB: "Từ vựng đọc học thuật", BIG_IDEAS: "Khám phá chuyên ngành", IDIOMS: "Thành ngữ",
  ESSENTIAL_4K: "4000 Essential Words",
  IELTS_TOPIC: "Chủ đề IELTS",
  OXFORD: "Oxford",
  OXFORD_3000: "Oxford 3000",
  OXFORD_5000: "Oxford 5000",
  PHRASAL_VERBS: "Phrasal Verbs",
  COLLOCATIONS: "Collocations",
};

/** Native chip scrolling with a permanently painted proportional thumb (OS overlay settings cannot hide it). */
function CategoryRail({ active, children }: { active: string; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null), track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; left: number } | null>(null);
  const id = useId();
  const [scroll, setScroll] = useState({ max: 0, left: 0, ratio: 1 });
  const sync = useCallback(() => { const el = box.current; if (el) setScroll({ max: Math.max(0, el.scrollWidth - el.clientWidth), left: el.scrollLeft, ratio: el.clientWidth / Math.max(1, el.scrollWidth) }); }, []);
  const reveal = useCallback((chip?: HTMLElement | null) => {
    const el = box.current; if (!el) return;
    chip ??= el.querySelector<HTMLElement>('[aria-pressed="true"]'); if (!chip) return;
    const a = el.getBoundingClientRect(), b = chip.getBoundingClientRect();
    if (b.left < a.left + 4) el.scrollLeft -= a.left + 4 - b.left;
    else if (b.right > a.right - 4) el.scrollLeft += b.right - a.right + 4;
    sync();
  }, [sync]);
  useEffect(() => { reveal(); }, [active, reveal]);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const observer = new ResizeObserver(() => reveal()); observer.observe(el);
    for (const chip of el.children) observer.observe(chip);
    reveal(); return () => observer.disconnect();
  }, [reveal]);
  const fraction = Math.max(.06, scroll.ratio);
  return <div className={styles.categoryRegion}>
    <div ref={box} id={id} className={styles.tabs} role="group" aria-label="Lọc theo nhóm bộ từ" data-guide="fc-filter" onScroll={sync}
      onKeyDown={e => {
        const chips = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button')), i = chips.indexOf(e.target as HTMLButtonElement);
        if (i < 0) return;
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? chips.length - 1 : e.key === 'ArrowRight' ? Math.min(i + 1, chips.length - 1) : e.key === 'ArrowLeft' ? Math.max(0, i - 1) : -1;
        if (next < 0) return;
        e.preventDefault(); chips[next].focus({ preventScroll: true }); reveal(chips[next]);
      }}>{children}</div>
    {scroll.max > 1 && <div ref={track} className={styles.categoryScrollbar} role="scrollbar" tabIndex={0} aria-label="Lọc theo nhóm bộ từ"
      aria-controls={id} aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={Math.ceil(scroll.max)} aria-valuenow={Math.round(scroll.left)}
      onKeyDown={e => {
        const el = box.current; if (!el) return;
        const delta = e.key === 'ArrowLeft' ? -80 : e.key === 'ArrowRight' ? 80 : e.key === 'PageUp' ? -el.clientWidth : e.key === 'PageDown' ? el.clientWidth : 0;
        if (!delta && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault(); el.scrollLeft = e.key === 'Home' ? 0 : e.key === 'End' ? scroll.max : el.scrollLeft + delta;
      }}
      onPointerDown={e => {
        if (e.button !== 0 || !box.current) return;
        const r = e.currentTarget.getBoundingClientRect(), thumb = e.currentTarget.firstElementChild!.getBoundingClientRect();
        if (e.clientX < thumb.left || e.clientX > thumb.right) box.current.scrollLeft = Math.max(0, Math.min(scroll.max, (e.clientX - r.left - thumb.width / 2) / (r.width - thumb.width) * scroll.max));
        drag.current = { id: e.pointerId, x: e.clientX, left: box.current.scrollLeft }; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); sync();
      }}
      onPointerMove={e => {
        const d = drag.current; if (!d || d.id !== e.pointerId || !box.current) return;
        const travel = e.currentTarget.clientWidth * (1 - fraction);
        box.current.scrollLeft = d.left + (e.clientX - d.x) / Math.max(1, travel) * scroll.max;
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      <span aria-hidden="true" className={styles.categoryThumb} style={{ width: `${fraction * 100}%`, left: `${scroll.max ? scroll.left / scroll.max * (1 - fraction) * 100 : 0}%` }} />
    </div>}
  </div>;
}

const TONES = new Set(["emerald", "amber", "rose", "indigo", "violet", "cyan", "sky"]);

const is4kDeck = (deck: VocabDeckSummary) => deck.category === "ESSENTIAL_4K" || deck.slug.startsWith("4k-essential-");

function matchesCategory(deck: VocabDeckSummary, category: string) {
  const is4k = is4kDeck(deck);
  return category === "ALL" || (category === "EXAM_READING" && deck.category === "READING_LAB") ||
    (category === "ESSENTIAL_4K" && is4k) ||
    (category !== "ESSENTIAL_4K" && !is4k && (
      deck.category === category ||
      (category === "OXFORD" && (deck.category === "OXFORD" || deck.category === "OXFORD_3000" || deck.category === "OXFORD_5000"))
    ));
}

const fmt = (n: number) => n.toLocaleString("vi-VN");

/** The study view replaces the library in place: bring the scrolling workspace back to its top so its card is in view. */
function scrollWorkspaceTop() {
  if (typeof document === "undefined") return;
  const main = document.querySelector<HTMLElement>("main[data-app-scroll]");
  (main ?? document.scrollingElement)?.scrollTo({ top: 0 });
}

/** Pointer light + a small tilt for fine pointers: CSS variables on the element itself, no React state per frame. */
function useTilt() {
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType !== "mouse") return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
    el.style.setProperty("--rx", `${((0.5 - y) * 5).toFixed(2)}deg`);
    el.style.setProperty("--ry", `${((x - 0.5) * 7).toFixed(2)}deg`);
    el.style.setProperty("--px", `${((0.5 - x) * 10).toFixed(1)}px`);
    el.style.setProperty("--py", `${((0.5 - y) * 6).toFixed(1)}px`);
    el.dataset.lit = "true";
  }, []);
  const onPointerLeave = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    el.style.removeProperty("--rx");
    el.style.removeProperty("--ry");
    el.style.removeProperty("--px");
    el.style.removeProperty("--py");
    delete el.dataset.lit;
  }, []);
  return { onPointerMove, onPointerLeave };
}

function DeckPicture({ art, title, eager = false }: { art: DeckArt | null; title: string; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!art || failed) {
    // typographic cover: the deck's own initial over its tone (no borrowed picture)
    return (
      <div className={styles.deckArtFallback} aria-hidden="true">
        <span>{title.trim().charAt(0).toUpperCase() || "A"}</span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={styles.deckArtImg}
      src={art.small}
      srcSet={`${art.small} 640w, ${art.large} ${art.largeWidth ?? 1280}w`}
      sizes="(min-width: 1280px) 30vw, (min-width: 768px) 46vw, 92vw"
      alt=""
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function ProgressBar({ value, total, label }: { value: number; total: number; label: string }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
  return (
    <div
      className={styles.bar}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={value}
      aria-valuetext={`${value}/${total} từ đã thuộc`}
    >
      <span className={styles.barFill} style={{ width: `${pct}%` }} data-empty={pct === 0 ? "true" : undefined} />
    </div>
  );
}

function DeckCard({ deck, progressLoading, onSelect, index }: {
  deck: VocabDeckSummary; progressLoading: boolean; onSelect: (d: VocabDeckSummary) => void; index: number;
}) {
  const tilt = useTilt();
  const titleId = useId();
  const total = deck.totalWords || 0;
  const mastered = Math.min(deck.masteredCount || 0, total);
  const reviewed = Math.min(deck.reviewedCount || 0, total);
  const due = deck.dueCount || 0;
  const isCompleted = total > 0 && mastered >= total;
  const isLearning = !isCompleted && reviewed > 0;
  const tone = TONES.has(deck.themeColor) ? deck.themeColor : "sky";
  const category = CATEGORY_LABEL[deck.category] ?? deck.category.replace(/_/g, " ");
  const cta = isCompleted ? "Ôn tập lại" : isLearning ? "Tiếp tục học" : "Bắt đầu học";

  return (
    <article className={styles.deck} data-guide="fc-deck" data-tone={tone} aria-labelledby={titleId} style={{ ["--i" as string]: index }} {...tilt}>
      <div className={styles.deckFrame}>
        <div className={styles.deckArt}>
          <DeckPicture art={deckArtFor(deck.slug)} title={deck.title} eager={index < 3} />
          <span className={styles.deckArtShade} aria-hidden="true" />
        </div>
        <span className={styles.deckSheen} aria-hidden="true" />
        <div className={styles.deckBody}>
          <span className={styles.deckChip}>
            <Layers aria-hidden="true" />
            <span>{category}</span>
            <i aria-hidden="true">·</i>
            <span>{fmt(total)} từ</span>
          </span>
          <h3 id={titleId} className={styles.deckTitle}>{deck.title}</h3>
          {facets[deck.slug] && <small className={styles.facetNote}>{[facets[deck.slug].subtopic,facets[deck.slug].levels.length ? "Có từ " + facets[deck.slug].levels.join(" · ") : "Chưa xác định CEFR"].filter(Boolean).join("  /  ")}</small>}
          <p className={styles.deckDesc}>{deck.description || "Bộ từ vựng trọng tâm chọn lọc theo chuẩn quốc tế."}</p>

          {progressLoading ? (
            <p className={styles.deckPending} aria-busy="true">Đang tải tiến độ…</p>
          ) : (
            <div className={styles.deckProgress}>
              <div className={styles.deckProgressHead}>
                <span>Đã thuộc</span>
                <strong>{fmt(mastered)}<small>/{fmt(total)}</small></strong>
              </div>
              <ProgressBar value={mastered} total={total} label={`Tiến độ ${deck.title}`} />
              <div className={styles.deckMeta}>
                {isCompleted ? (
                  <span className={styles.state} data-state="done"><CheckCircle2 aria-hidden="true" />Đã thuộc hết</span>
                ) : isLearning ? (
                  <span className={styles.state} data-state="learning">Đang học</span>
                ) : (
                  <span className={styles.state} data-state="new">Chưa học</span>
                )}
                <span className={styles.due} data-has={due > 0 ? "true" : undefined}>
                  <Hourglass aria-hidden="true" />{fmt(due)} cần ôn
                </span>
              </div>
            </div>
          )}

          <button type="button" className={styles.cta} onClick={() => onSelect(deck)}>
            <span className={styles.ctaGlyph} aria-hidden="true"><Play /></span>
            <span>{cta}</span>
          </button>
        </div>
      </div>
    </article>
  );
}

function PersonalCard({ deck, total, due, mastered, onSelect }: {
  deck: VocabDeckSummary; total: number; due: number; mastered: number; onSelect: (d: VocabDeckSummary) => void;
}) {
  const tilt = useTilt();
  const pct = total > 0 ? Math.round((mastered * 100) / total) : 0;
  return (
    <article className={`${styles.deck} ${styles.personal}`} data-guide="fc-personal" data-tone="cyan" aria-labelledby="personal-deck-title" {...tilt}>
      <div className={styles.deckFrame}>
        <div className={styles.personalArt}>
          <DeckPicture art={deckArtFor("personal")} title="Bộ từ của bản thân" eager />
          <span className={styles.deckArtShade} aria-hidden="true" />
        </div>
        <span className={styles.deckSheen} aria-hidden="true" />
        <div className={styles.personalBody}>
          <span className={styles.deckChip} data-signature="true">
            <Shell aria-hidden="true" />
            <span>Cá nhân • {fmt(total)} từ</span>
          </span>
          <h3 id="personal-deck-title" className={styles.personalTitle}>Bộ từ của bản thân</h3>
          <p className={styles.deckDesc}>
            Tự thêm và ôn tập từ vựng của riêng bạn qua bài đọc, video YouTube, hoặc nhập tệp Anki (.apkg).
          </p>
          <dl className={styles.personalStats}>
            <div data-k="saved"><dt>Đã lưu</dt><dd>{fmt(total)}<span>từ của bạn</span></dd></div>
            <div data-k="due"><dt>Cần ôn tập</dt><dd>{fmt(due)}<span>thẻ tới hạn</span></dd></div>
            <div data-k="mastered"><dt>Đã thuộc</dt><dd>{fmt(mastered)}<span>từ đã ghi nhớ</span></dd></div>
          </dl>
          <div className={styles.deckProgress}>
            <div className={styles.deckProgressHead}>
              <span>Tiến độ thuộc</span>
              <strong>{pct}%</strong>
            </div>
            <ProgressBar value={mastered} total={total} label="Tiến độ bộ từ của bản thân" />
          </div>
          <button type="button" className={`${styles.cta} ${styles.ctaPersonal}`} onClick={() => onSelect(deck)}>
            <span className={styles.ctaGlyph} aria-hidden="true"><Play /></span>
            <span>Học ngay</span>
          </button>
        </div>
      </div>
    </article>
  );
}

function HeroArt() {
  return (
    <div className={styles.heroArt} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={FLASHCARD_HERO_ART.small}
        srcSet={`${FLASHCARD_HERO_ART.small} 1920w, ${FLASHCARD_HERO_ART.large} 3840w`}
        sizes="(min-width: 768px) 100vw, 260vw"
        alt=""
        decoding="async"
        draggable={false}
      />
    </div>
  );
}

const MOTES = [
  { x: "54%", s: "5px", d: "13s", delay: "0s" }, { x: "61%", s: "8px", d: "11s", delay: "-4s" },
  { x: "69%", s: "4px", d: "15s", delay: "-7s" }, { x: "77%", s: "7px", d: "12s", delay: "-2s" },
  { x: "84%", s: "5px", d: "14s", delay: "-9s" }, { x: "91%", s: "6px", d: "10s", delay: "-5.5s" },
  { x: "47%", s: "4px", d: "16s", delay: "-11s" },
];

function Hero({ children }: { children: React.ReactNode }) {
  return (
    <section className={styles.hero} aria-labelledby="flashcard-hero-title">
      <HeroArt />
      <div className={styles.heroShade} aria-hidden="true" />
      <div className={styles.heroCaustics} aria-hidden="true" />
      <div className={styles.heroMotes} aria-hidden="true">
        {MOTES.map((m, i) => (
          <i key={i} style={{ ["--x" as string]: m.x, ["--s" as string]: m.s, ["--d" as string]: m.d, ["--delay" as string]: m.delay }} />
        ))}
      </div>
      <div className={styles.heroBody}>
        <span className={styles.eyebrow}><Library aria-hidden="true" />Thẻ từ vựng · Ôn tập ngắt quãng</span>
        <h1 id="flashcard-hero-title" className={styles.heroTitle}>
          <span>Đại dương từ vựng</span>
          <span className={styles.heroTitleGlow}>cùng Echo</span>
        </h1>
        <p className={styles.heroLead}>
          Chọn một bộ từ, lật thẻ và ôn lại đúng lúc. Mỗi từ bạn thuộc là một viên ngọc trong đại dương ký ức của riêng bạn.
        </p>
        {children}
      </div>
    </section>
  );
}

function Stat({ icon, value, label, note, tone }: { icon: React.ReactNode; value: string; label: string; note?: string; tone: string }) {
  return (
    <div className={styles.stat} data-tone={tone}>
      <span className={styles.statWell} aria-hidden="true">{icon}</span>
      <span className={styles.statText}>
        <strong>{value}</strong>
        <span>{label}</span>
        {note ? <small>{note}</small> : null}
      </span>
    </div>
  );
}

export function DeckCatalogView({
  decks,
  personalTotalCards,
  personalDueCards,
  personalMasteredCards,
  onSelectDeck,
  onReviewDue,
  onOpenStudio,
  onOpenVault,
  loading = false,
  progressLoading = false,
  error,
  onRetry,
}: DeckCatalogViewProps) {
  const [activeCategory, setActiveCategory] = useState("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [level, setLevel] = useState("");
  const [source, setSource] = useState("");
  const [reference, setReference] = useState("");
  const [study, setStudy] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [form, setForm] = useState("");
  const [topic,setTopic] = useState("");
  const [order, setOrder] = useState("");
  const [page, setPage] = useState(1);
  const searchId = useId();
  // Extract personal deck & system decks
  const personalDeck = useMemo(() => {
    const found = decks.find((d) => d.id === null || d.slug === "personal");
    if (found) {
      return {
        ...found,
        totalWords: personalTotalCards || found.totalWords,
        dueCount: personalDueCards || found.dueCount,
        masteredCount: personalMasteredCards || found.masteredCount,
      };
    }
    return {
      id: null,
      slug: "personal",
      title: "Bộ từ của bản thân",
      description: "Tự thêm và ôn tập từ vựng của riêng bạn.",
      category: "PERSONAL",
      themeColor: "emerald",
      icon: "user",
      totalWords: personalTotalCards,
      isSystem: false,
      sortOrder: 0,
      masteredCount: personalMasteredCards,
      reviewedCount: personalMasteredCards,
      learningCount: 0,
      dueCount: personalDueCards,
      progressPercentage: personalTotalCards > 0 ? Math.round((personalMasteredCards * 100) / personalTotalCards) : 0,
      isEnrolled: true,
    } as VocabDeckSummary;
  }, [decks, personalTotalCards, personalDueCards, personalMasteredCards]);

  const systemDecks = useMemo(() => {
    return decks.filter((d) => d.isSystem || (d.id !== null && d.slug !== "personal"));
  }, [decks]);

  // Filtered system decks
  const filteredDecks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return systemDecks.filter((deck) => {
      const meta=facets[deck.slug];
      const matchSearch = !q || [deck.title,deck.description,meta?.topic,meta?.subtopic].some(s=>s?.toLocaleLowerCase("vi").includes(q));
      const wiki = deck.category === "GENERAL_CEFR" || deck.category === "EXAM_READING";
      const ref = deck.category === "BOOK_COLLECTION" ? "books" : deck.category === "READING_LAB" || deck.category === "EXAM_READING" ? "reading" : deck.category === "BIG_IDEAS" ? "ideas" : deck.category.startsWith("OXFORD") ? "oxford" : "";
      const state = deck.totalWords > 0 && deck.masteredCount >= deck.totalWords ? "done" : deck.isEnrolled ? "active" : "new";
      return matchesCategory(deck, activeCategory) && (!reference || ref === reference) && matchSearch && (!level || meta?.levels.includes(level)) && (!topic || meta?.topic===topic)
          && (!source || (source === "books" ? deck.category === "BOOK_COLLECTION" : source === "wiki" ? wiki : source === "original" ? deck.slug.startsWith("lib-") && !wiki : !deck.slug.startsWith("lib-") && deck.category !== "BOOK_COLLECTION"))
        && (!difficulty || (!progressLoading && deck.latestRatings?.includes(difficulty)))
        && (!form || meta?.forms.includes(form))
        && (!study || (!progressLoading && (study === "due" ? deck.dueCount > 0 : study === state)));
    }).sort((a,b) => order === "title" ? a.title.localeCompare(b.title,"vi") : order === "size" ? b.totalWords - a.totalWords : a.sortOrder - b.sortOrder);
  }, [systemDecks, activeCategory, searchQuery, level, source, reference, study, form, topic, difficulty, order, progressLoading]);
  const pages = Math.max(1, Math.ceil(filteredDecks.length / 12));
  const currentPage = Math.min(pages, page);
  const pageDecks = filteredDecks.slice((currentPage - 1) * 12, currentPage * 12);

  const topicOptions = useMemo(()=> Array.from(new Set(systemDecks.map(d=>facets[d.slug]?.topic).filter(Boolean))).sort((a,b)=>a.localeCompare(b,"vi")),[systemDecks]);
  const tabCounts = useMemo(
    () => Object.fromEntries(CATEGORY_TABS.map((t) => [t.id, systemDecks.filter((d) => matchesCategory(d, t.id)).length])),
    [systemDecks],
  );

  const systemWords = useMemo(() => systemDecks.reduce((sum, d) => sum + (d.totalWords || 0), 0), [systemDecks]);
  const totals = useMemo(() => {
    const all = [...systemDecks, personalDeck];
    return {
      mastered: systemDecks.reduce((s, d) => s + Math.min(d.masteredCount || 0, d.totalWords || 0), 0) + (personalDeck.masteredCount || 0),
      due: all.reduce((s, d) => s + (d.dueCount || 0), 0),
      enrolled: systemDecks.filter((d) => d.isEnrolled).length,
    };
  }, [systemDecks, personalDeck]);

  const openDeck = useCallback((deck: VocabDeckSummary) => { scrollWorkspaceTop(); onSelectDeck(deck); }, [onSelectDeck]);
  const openDue = useCallback(() => { scrollWorkspaceTop(); onReviewDue?.(); }, [onReviewDue]);

  const showPersonal = !progressLoading && activeCategory === "ALL" && !searchQuery && !level && !source && !reference && !study && !form && !topic && !difficulty && currentPage === 1;
  const filtering = activeCategory !== "ALL" || !!searchQuery.trim() || !!level || !!source || !!reference || !!study || !!form || !!topic || !!difficulty;

  if (loading) {
    return (
      <div className={styles.world}>
        <section className={styles.page} aria-busy={!error} aria-live="polite">
          <div className={styles.inner}>
            <div className={`${styles.hero} ${styles.heroLoading}`}>
              <div className={styles.heroBody}>
                <h1 className={styles.heroTitle}><span>Chọn bộ từ để bắt đầu học</span></h1>
                <p className={styles.heroLead} role={error ? "alert" : undefined}>{error || "Đang tải kho từ vựng…"}</p>
                {error ? (
                  <button type="button" onClick={onRetry} className={styles.heroCta}>
                    <RotateCcw aria-hidden="true" /><span>Thử lại</span>
                  </button>
                ) : null}
              </div>
            </div>
            {!error ? (
              <div className={styles.grid} aria-hidden="true">
                {[0, 1, 2].map((i) => <div key={i} className={styles.skeleton} />)}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.world}>
      <section className={styles.page}>
        <div className={styles.inner}>
          {/* 1. HERO — the world, with the learner's real totals */}
          <Hero>
            <div className={styles.stats}>
              <Stat
                tone="sky"
                icon={<Layers />}
                value={fmt(systemDecks.length + (progressLoading ? 0 : 1))}
                label={progressLoading ? "Bộ từ trong kho" : "Bộ từ vựng"}
                note={progressLoading ? undefined : `${fmt(totals.enrolled)} bộ đang học`}
              />
              <Stat
                tone="violet"
                icon={<BookOpen />}
                value={fmt(progressLoading ? systemWords : systemWords + personalTotalCards)}
                label={progressLoading ? "Từ trong kho" : "Tổng số từ"}
              />
              <Stat
                tone="emerald"
                icon={<CheckCircle2 />}
                value={progressLoading ? "…" : fmt(totals.mastered)}
                label="Từ đã thuộc"
              />
              <Stat
                tone="amber"
                icon={<Hourglass />}
                value={progressLoading ? "…" : fmt(totals.due)}
                label="Thẻ cần ôn"
              />
            </div>
            {!progressLoading && onReviewDue ? (
              totals.due > 0 ? (
                <div className={styles.heroActions}>
                  <button type="button" className={styles.heroCta} onClick={openDue} data-guide="fc-due">
                    <span className={styles.ctaGlyph} aria-hidden="true"><Play /></span>
                    <span>Ôn {fmt(totals.due)} thẻ đến hạn</span>
                  </button>
                </div>
              ) : (
                <p className={styles.heroCalm}>Hôm nay chưa có thẻ nào đến hạn ôn. Chọn một bộ từ bên dưới để học từ mới.</p>
              )
            ) : null}
            {onOpenStudio || onOpenVault ? (
              <div className={styles.heroTides}>
                {onOpenStudio ? (
                  <button type="button" className={styles.heroGhost} onClick={onOpenStudio} data-guide="fc-studio">
                    <BrandWhaleIcon size="xs" clean />
                    <span>Echo AI Card Studio</span>
                  </button>
                ) : null}
                {onOpenVault ? (
                  <button type="button" className={styles.heroGhost} onClick={() => { scrollWorkspaceTop(); onOpenVault(); }} data-guide="fc-vault">
                    <Shell aria-hidden="true" />
                    <span>Memory Universe</span>
                  </button>
                ) : null}
                {/* Vũ trụ tri thức: how the words you study connect (verified relations only) */}
                <Link className={styles.heroGhost} href="/knowledge-universe">
                  <span>Vũ trụ tri thức</span>
                </Link>
              </div>
            ) : null}
          </Hero>

          {/* 2. DISCOVERY — categories + search */}
          <div className={styles.controls} role="search">
            <CategoryRail active={activeCategory}>
              {CATEGORY_TABS.map((tab) => {
                const isActive = activeCategory === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => { setActiveCategory(tab.id); setPage(1); }}
                    className={styles.tab}
                  >
                    <span>{tab.label}</span>
                    <small>{tabCounts[tab.id] ?? 0}</small>
                  </button>
                );
              })}
            </CategoryRail>
            <div className={styles.search}>
              <label htmlFor={searchId} className="sr-only">Tìm bộ từ</label>
              <Search className={styles.searchIcon} aria-hidden="true" />
              <input
                id={searchId}
                type="text"
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
                placeholder="Tìm bộ từ theo tên, chủ đề…"
                autoComplete="off"
              />
              {searchQuery ? (
                <button type="button" className={styles.searchClear} onClick={() => setSearchQuery("")} aria-label="Xoá tìm kiếm">
                  <X aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>

          <details className={styles.advancedFilters}><summary>Lọc và sắp xếp{filtering ? " · Đang lọc" : ""}</summary><div className={styles.libraryFilters}>
            {[
              ["Bộ có từ ở cấp", level, setLevel, [["", "Mọi cấp độ"], ...["A1","A2","B1","B2","C1","C2"].map(x=>[x,x])]],
              ["Nguồn nội dung", source, setSource, [["","Mọi nguồn"],["books","Từ sách đến thẻ"],["wiki","Wiktionary"],["original","EnglishCoach Original"],["previous","Kho đã có"]]],
              ["Tuyến tham khảo", reference, setReference, [["","Mọi tuyến"],["books","Từ sách đến thẻ"],["reading","Mục từ IELTS / TOEFL"],["ideas","Chủ đề Big Ideas"],["oxford","Oxford trong kho cũ"]]],
              ["Chủ đề", topic, setTopic, [["","Mọi chủ đề"], ...topicOptions.map(t=>[t,t])]],
              ["Dạng mục từ", form, setForm, [["","Mọi dạng"],["word","Từ đơn"],["phrase","Cụm từ"],["collocation","Kết hợp từ"],["idiom","Thành ngữ"],["phrasal","Cụm động từ"]]],
              ["Bộ có thẻ vừa chấm", difficulty, setDifficulty, [["","Mọi mức"],["easy","Dễ"],["good","Trung Bình"],["hard","Khó"]]],
              ["Tiến độ học", study, setStudy, [["","Mọi tiến độ"],["new","Chưa bắt đầu"],["active","Đang học"],["done","Đã thuộc hết"],["due","Đến hạn ôn"]]],
              ["Sắp xếp", order, setOrder, [["","Thứ tự thư viện"],["title","Tên A–Z"],["size","Nhiều thẻ nhất"]]],
            ].map(row => {
              const [label,value,update,options] = row as [string,string,(v:string)=>void,string[][]];
              return <label key={label}>{label}<select aria-label={label} value={value} disabled={(label==="Tiến độ học" || label==="Bộ có thẻ vừa chấm") && progressLoading} onChange={e=>{update(e.target.value);setPage(1);}}>
                {options.map(([id,name])=><option key={id} value={id}>{name}</option>)}
              </select></label>;
            })}
          </div>
          </details>
          <div className={styles.collectionHead}>
            <h2 className={styles.collectionTitle}>Kho bộ từ</h2>
            <p className={styles.collectionCount} aria-live="polite">
              {filtering ? `${fmt(filteredDecks.length)} bộ từ phù hợp` : `${fmt(systemDecks.length)} bộ từ hệ thống`}
            </p>
          </div>

          {/* 3. COLLECTION */}
          <div className={styles.grid}>
            {showPersonal && (
              <PersonalCard
                deck={personalDeck}
                total={personalTotalCards}
                due={personalDueCards}
                mastered={personalMasteredCards}
                onSelect={openDeck}
              />
            )}
            {progressLoading && !searchQuery && activeCategory === "ALL" && (
              <div aria-busy="true" className={`${styles.skeleton} ${styles.skeletonPersonal}`}>
                <span>Đang tải bộ từ cá nhân…</span>
              </div>
            )}
            {pageDecks.map((deck, i) => (
              <DeckCard key={deck.id || deck.slug} deck={deck} progressLoading={progressLoading} onSelect={openDeck} index={i} />
            ))}
          </div>

          {pages > 1 && <div className={styles.libraryPager}><PageJump page={currentPage} pages={pages} onPage={setPage} label="Trang bộ từ" /></div>}
          {/* Empty State */}
          {filteredDecks.length === 0 && (
            <div className={styles.empty}>
              <span className={styles.emptyIcon} aria-hidden="true"><Search /></span>
              <h4>Không tìm thấy bộ từ vựng</h4>
              <p>
                {searchQuery
                  ? <>Không có bộ từ nào khớp với &quot;{searchQuery}&quot;. Hãy thử tìm bằng từ khoá khác.</>
                  : "Nhóm này chưa có bộ từ nào."}
              </p>
              {filtering ? (
                <button type="button" className={styles.emptyReset} onClick={() => { setSearchQuery(""); setActiveCategory("ALL"); setLevel(""); setSource(""); setReference(""); setStudy(""); setDifficulty(""); setForm(""); setTopic(""); setPage(1); }}>
                  Xem tất cả bộ từ
                </button>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
