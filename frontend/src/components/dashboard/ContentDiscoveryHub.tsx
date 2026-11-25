"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSystemContentCards } from '@/hooks/useSystemContentCards';
import useSWR, { mutate as globalMutate } from "swr";
import { useLanguage } from "@/context/LanguageContext";
import { apiClient } from "@/services/api-client";
import {
  FeedArticleItem,
  ListeningTodayItem,
  DictationTodayItem,
  TrendingVocabularyItem,
  ReadingArticleDetail,
  ContentVocabularyItem,
} from "@/types/content";
import {
  Radio,
  Headphones,
  Play,
  Volume2,
  Clock,
  ArrowRight,
  TrendingUp,
  BookmarkPlus,
  Check,
  ExternalLink,
  X,
  Newspaper,
  BookOpen,
  PenTool,
  RotateCcw,
  Download,
  BookmarkCheck,
  Loader2,
} from "lucide-react";
import { WordLookupPopover } from "./WordLookupPopover";
import styles from "./dashboard.module.css";
import { sanitizeSelection, extractContextSentence } from "@/lib/readingSelection";
import { categoryLabel } from "@/components/features/listening/glass/ListeningGlass";


interface ContentDiscoveryHubProps {
  onNavigate: (tab: string) => void;
  token?: string | null;
  /** Optional companion shown beside the feed on wide screens (the dashboard's weekly podium). */
  leading?: React.ReactNode;
}

// ─── Fetcher using apiClient with error handling ────────────────────────────
const contentFetcher = async (url: string, token?: string | null) => {
  try {
    const res = await apiClient.get(url);
    if (res.status === 204) return null;
    return res.data;
  } catch (err: any) {
    if (err?.response?.status === 204) return null;
    return null;
  }
};

// ─── Tone per source (typographic fallback when an article has no usable picture) ───
function getSourceTone(source: string): string {
  const s = source.toLowerCase();
  if (s.includes("learning")) return "learning";
  if (s.includes("bbc")) return "bbc";
  if (s.includes("guardian")) return "guardian";
  if (s.includes("voa")) return "voa";
  if (s.includes("economist")) return "economist";
  return "default";
}

// BBC's feed hands out its 240 px rendition; the same picture exists at 480 px on the same CDN (no proxy). Anything else
// is used exactly as the feed gave it.
function sharperThumb(url: string): string {
  return /^https:\/\/ichef\.bbci\.co\.uk\/.*\/standard\/240\//.test(url) ? url.replace("/standard/240/", "/standard/480/") : url;
}

// A YouTube item's own poster frame (the same video the learner will practise with).
function youtubePoster(id?: string | null): string | null {
  return id && /^[\w-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

/**
 * A content picture that never shifts the layout (its frame has fixed geometry) and never shows a broken image: it fades in
 * once decoded, tries one fallback URL, and removes itself on failure so the typographic fallback underneath stays visible.
 */
function ThumbImage({ src, fallbackSrc, alt = "" }: { src: string | null; fallbackSrc?: string | null; alt?: string }) {
  const [current, setCurrent] = useState<string | null>(src);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => { setCurrent(src); setState("loading"); }, [src]);
  // YouTube answers a missing video with a 120 × 90 grey placeholder (an image, not an error): treat it as a failure.
  const settle = (img: HTMLImageElement) => {
    const placeholder = img.naturalWidth <= 120 && /(^|\.)ytimg\.com$/.test(new URL(img.currentSrc || img.src).hostname);
    if (img.naturalWidth > 0 && !placeholder) setState("loaded");
    else if (fallbackSrc && current !== fallbackSrc) setCurrent(fallbackSrc);
    else setState("error");
  };
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth > 0) settle(img);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  if (!current || state === "error") return null;
  return (
    <img
      ref={ref}
      src={current}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      data-loaded={state === "loaded" || undefined}
      onLoad={(e) => settle(e.currentTarget)}
      onError={() => {
        if (fallbackSrc && current !== fallbackSrc) setCurrent(fallbackSrc);
        else setState("error");
      }}
    />
  );
}

function formatDurationSeconds(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// ─── Vietnam Timezone (Asia/Ho_Chi_Minh) Daily Helpers ──────────────────────
function getAsiaHoChiMinhDateString(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function getMsUntilNextMidnightVietnam(): number {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(now);

  const partMap: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      partMap[p.type] = parseInt(p.value, 10);
    }
  }

  const hours = (partMap.hour || 0) % 24;
  const minutes = partMap.minute || 0;
  const seconds = partMap.second || 0;
  const msToday = (hours * 3600 + minutes * 60 + seconds) * 1000 + now.getMilliseconds();
  const msUntilMidnight = 86400000 - msToday;
  return Math.max(1000, msUntilMidnight + 150);
}

export function ContentDiscoveryHub({ onNavigate, token, leading }: ContentDiscoveryHubProps) {
  const router = useRouter();
  const { locale } = useLanguage();
  const [selectedArticleId, setSelectedArticleId] = useState<number | null>(null);
  const [dailyDateKey, setDailyDateKey] = useState<string>(() => getAsiaHoChiMinhDateString());

  // Auto-rotate at exactly 00:00:00 Asia/Ho_Chi_Minh without reloading whole Dashboard
  useEffect(() => {
    let timerId: NodeJS.Timeout;

    const scheduleNextMidnight = () => {
      const ms = getMsUntilNextMidnightVietnam();
      timerId = setTimeout(() => {
        const nextDate = getAsiaHoChiMinhDateString();
        setDailyDateKey(nextDate);
        scheduleNextMidnight();
      }, ms);
    };

    scheduleNextMidnight();

    return () => {
      if (timerId) clearTimeout(timerId);
    };
  }, []);

  const handleListenAction = (deepLink?: string) => {
    if (deepLink) {
      if (deepLink.startsWith("/")) {
        router.push(deepLink);
      } else {
        window.location.href = deepLink;
      }
    } else {
      onNavigate("listening");
    }
  };

  const handleDictationAction = (deepLink?: string) => {
    if (deepLink) {
      if (deepLink.startsWith("/")) {
        router.push(deepLink);
      } else {
        window.location.href = deepLink;
      }
    } else {
      onNavigate("listening");
    }
  };

  // SYSTEM card metadata only; reading detail and saved overlays remain user-scoped.
  const { data: feedArticles, isLoading: feedLoading, error: feedError } = useSystemContentCards<FeedArticleItem[] | null>('/content/feed');
  const { data: listeningToday, isLoading: listeningLoading } = useSystemContentCards<ListeningTodayItem | null>('/content/listening/today');
  const { data: dictationToday, isLoading: dictationLoading } = useSystemContentCards<DictationTodayItem | null>('/content/dictation/today');
  const hasListening = !!listeningToday;
  const hasDictation = !!dictationToday;
  const isBlock2Loading = (listeningLoading || dictationLoading) && !hasListening && !hasDictation;
  const showBlock2 = hasListening || hasDictation || isBlock2Loading;
  const { data: trendingVocab, isLoading: trendingLoading } = useSystemContentCards<TrendingVocabularyItem[] | null>(`/content/vocabulary/daily?date=${dailyDateKey}`);

  // Flashcard save state
  const [savingWords, setSavingWords] = useState<Set<string>>(new Set());
  const [savedWords, setSavedWords] = useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Set<string>>(new Set());

  const handleSaveFlashcard = async (word: string, meaning: string, example?: string | null) => {
    if (savedWords.has(word) || savingWords.has(word)) return;
    setSavingWords((prev) => new Set(prev).add(word));
    setSaveErrors((prev) => {
      const next = new Set(prev);
      next.delete(word);
      return next;
    });

    try {
      const res = await apiClient.post("/flashcards", {
        front: word,
        back: meaning,
        example: example || "",
      });
      if (res.status === 200 || res.status === 201) {
        setSavedWords((prev) => new Set(prev).add(word));
        globalMutate(
          (key) => {
            if (typeof key === "string") return key.includes("/flashcards");
            if (Array.isArray(key) && typeof key[0] === "string") return key[0].includes("/flashcards");
            return false;
          },
          undefined,
          { revalidate: true }
        );
      }
    } catch (err: any) {
      // If error indicates word already exists, treat as saved
      if (err?.response?.status === 409) {
        setSavedWords((prev) => new Set(prev).add(word));
      } else {
        setSaveErrors((prev) => new Set(prev).add(word));
      }
    } finally {
      setSavingWords((prev) => {
        const next = new Set(prev);
        next.delete(word);
        return next;
      });
    }
  };

  const vi = locale === "vi";
  const feedPanel = (
    <div className={styles.panel} data-purpose="english-feed">
      <div className={styles.panelHead}>
        <span className={styles.panelIcon} data-tone="sky" aria-hidden="true"><Newspaper className="h-5 w-5" /></span>
        <div className="min-w-0">
          <h2 className={styles.panelTitle}>{vi ? "Khám phá nội dung hôm nay" : "Daily Content Discovery"}</h2>
          <p className={styles.panelLead}>
            {vi
              ? "Bản tin báo quốc tế, podcast tuyển chọn và từ vựng đời thực hot nhất tuần này"
              : "Curated international news, featured podcasts, and trending real-world slang this week"}
          </p>
        </div>
      </div>

      {/* ─── BLOCK 1: ENGLISH FEED (the four real articles of today) ─── */}
      <p className="sr-only">{vi ? "Bản tin báo quốc tế tuyển chọn" : "Curated International News Feed"}</p>
      {feedLoading ? (
        <div className={styles.feedGrid}>
          {[1, 2, 3, 4].map((i) => <div key={i} className={`${styles.shimmerBlock} h-64`} />)}
        </div>
      ) : feedArticles && feedArticles.length > 0 ? (
        <div className={styles.feedGrid}>
          {feedArticles.map((article) => {
            return (
              <article key={article.id} className={styles.feedCard}>
                <div className={styles.feedThumb} data-source={getSourceTone(article.source)}>
                  {/* Typographic fallback (always underneath): the real source and section, never a stock or game picture. */}
                  <div className={styles.thumbFallback} aria-hidden="true">
                    <Newspaper className={styles.tfGlyph} />
                    {article.category && <span className={styles.tfCat}>{article.category}</span>}
                    <span className={styles.tfMark}>{article.source}</span>
                  </div>
                  {article.thumbnail && (
                    <ThumbImage src={sharperThumb(article.thumbnail)} fallbackSrc={article.thumbnail} alt={article.title} />
                  )}
                  <div className={styles.thumbChips}>
                    <span className={styles.chipSource}>{article.source}</span>
                    <span className={styles.chipLevel}>{article.level}</span>
                  </div>
                  <span className={styles.chipTime}>
                    <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{vi ? `${article.readMinutes} phút đọc` : `~${article.readMinutes} min read`}</span>
                  </span>
                </div>
                <div className={styles.feedBody}>
                  <h3 className={styles.feedTitle} onClick={() => setSelectedArticleId(article.id)}>
                    {article.title}
                  </h3>
                  {article.summary && <p className={styles.feedSummary}>{article.summary}</p>}
                  {article.category && <p className="text-[11px] font-semibold text-[var(--ink-3)]">{article.category}</p>}
                </div>
                <div className={styles.feedAction}>
                  <button
                    type="button"
                    id={`btn-read-article-${article.id}`}
                    onClick={() => setSelectedArticleId(article.id)}
                    className={`${styles.btn} ${styles.btnTeal} ${styles.btnBlock}`}
                  >
                    <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{locale === "vi" ? "Đọc bài" : "Read article"}</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className={styles.emptyNote}>
          {locale === "vi" ? "Chưa có bản tin nào hôm nay." : "No news feed available today."}
        </div>
      )}
    </div>
  );

  return (
    <section className={styles.hub} data-purpose="english-content-discovery-hub">
      <div className={styles.hubRow} data-leading={leading ? "" : undefined}>
        {leading}
        {feedPanel}
      </div>

      {/* ─── BLOCK 2: LISTENING TODAY + DAILY DICTATION ──────────────────── */}
      {showBlock2 && (
        <div className={styles.mediaRow} data-pair={hasListening && hasDictation ? "" : undefined}>
          {isBlock2Loading ? (
            <>
              <div className={`${styles.shimmerBlock} h-56`} />
              <div className={`${styles.shimmerBlock} h-56`} />
            </>
          ) : (
            <>
              {/* Listening of the Day */}
              {listeningToday && (
                <div className={styles.mediaCard} data-tone="amber" data-has-thumb="">
                  <div className={styles.mediaThumb}>
                    <div className={styles.mediaFallback} aria-hidden="true">
                      <Headphones className={styles.mfGlyph} />
                      <span>{listeningToday.channel || (vi ? "Bài nghe hôm nay" : "Listening Today")}</span>
                    </div>
                    <ThumbImage src={listeningToday.thumbnail || youtubePoster(listeningToday.youtubeVideoId)} fallbackSrc={youtubePoster(listeningToday.youtubeVideoId)} />
                    <span className={styles.mediaPlay} aria-hidden="true"><Headphones className="h-5 w-5" /></span>
                  </div>
                  <div className={styles.mediaBody}>
                    <div className={styles.mediaKicker}>
                      <span className={styles.kicker}>
                        <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{vi ? "Bài nghe hôm nay" : "Listening Today"}</span>
                      </span>
                      {listeningToday.accent && <span className={styles.tag}>{listeningToday.accent} Accent</span>}
                      <span className={styles.tag}>{listeningToday.level}</span>
                    </div>
                    {(listeningToday.channel || listeningToday.topic) && (
                      <p className={styles.mediaSub}>
                        {[listeningToday.channel, categoryLabel(listeningToday.topic, vi)].filter(Boolean).join(" · ")}
                      </p>
                    )}
                    <h3 className={styles.mediaTitle}>{listeningToday.title}</h3>
                    <div className={styles.mediaMeta}>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{formatDurationSeconds(listeningToday.durationSeconds)}</span>
                      </span>
                      <span aria-hidden="true">•</span>
                      <strong>{vi ? "Phát âm bản xứ" : "Native Accent"}</strong>
                    </div>
                    <div className={styles.mediaFoot}>
                      <button
                        type="button"
                        id="btn-listen-today-action"
                        onClick={() => handleListenAction(listeningToday.deepLink)}
                        className={`${styles.btn} ${styles.btnAmber}`}
                      >
                        <span>{vi ? "Nghe ngay" : "Listen Now"}</span>
                        <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Daily Dictation */}
              {dictationToday && (
                <div className={styles.mediaCard} data-tone="indigo" data-has-thumb="">
                  <div className={styles.mediaThumb}>
                    <div className={styles.mediaFallback} aria-hidden="true">
                      <PenTool className={styles.mfGlyph} />
                      <span>{categoryLabel(dictationToday.topic, vi) || (vi ? "Chép chính tả" : "Dictation")}</span>
                    </div>
                    <ThumbImage src={youtubePoster(dictationToday.youtubeVideoId)} />
                    <span className={styles.mediaPlay} aria-hidden="true"><Volume2 className="h-5 w-5" /></span>
                  </div>
                  <div className={styles.mediaBody}>
                    <div className={styles.mediaKicker}>
                      <span className={styles.kicker}>
                        <PenTool className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{vi ? `Thử thách ${dictationToday.durationSeconds || 20} giây` : `${dictationToday.durationSeconds || 20}-Sec Challenge`}</span>
                      </span>
                      {dictationToday.accent && <span className={styles.tag}>{dictationToday.accent}</span>}
                      <span className={styles.tag}>{dictationToday.level}</span>
                    </div>
                    <h3 className={styles.mediaTitle}>{dictationToday.title}</h3>
                    <p className={styles.mediaLine}>
                      {dictationToday.durationSeconds ? `${dictationToday.durationSeconds} giây • ` : ""}
                      {vi ? "Nghe và chép lại chính xác từng từ" : "Listen and transcribe word-for-word"}
                    </p>
                    {/* Decorative, static waveform (not a live spectrum). */}
                    <div className={styles.wave} aria-hidden="true">
                      <Volume2 className="mr-1 h-4 w-4 shrink-0" />
                      {[35, 60, 45, 80, 55, 30, 75, 90, 65, 40, 85, 50, 70, 95, 45, 60, 75, 40, 65, 85, 50, 70].map((h, i) => (
                        <i key={i} style={{ height: `${h}%` }} />
                      ))}
                    </div>
                    <p className={styles.mediaNote}>
                      {vi
                        ? "Chế độ ẩn transcript: Tập trung nghe phản xạ và ghi lại toàn bộ nội dung."
                        : "Hidden transcript mode: Sharpen listening reflexes by transcribing verbatim."}
                    </p>
                    <div className={styles.mediaFoot}>
                      <button
                        type="button"
                        id="btn-dictation-today-action"
                        onClick={() => handleDictationAction(dictationToday.deepLink)}
                        className={`${styles.btn} ${styles.btnIndigo}`}
                      >
                        <span>{vi ? "Luyện chép chính tả" : "Practice Dictation"}</span>
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ─── BLOCK 3: TRENDING VOCABULARY (today's five words) ───────────── */}
      <div className={styles.panel} data-purpose="trending-vocabulary">
        <div className={styles.panelHead}>
          <span className={styles.panelIcon} data-tone="violet" aria-hidden="true"><TrendingUp className="h-5 w-5" /></span>
          <h3 className={styles.panelTitle}>
            {locale === "vi" ? "Từ vựng đời thực hot tuần này" : "Trending Real-World Slang This Week"}
          </h3>
          <span className={styles.panelChip}>{locale === "vi" ? "5 từ tiêu biểu" : "Top 5 words"}</span>
        </div>

        {trendingLoading ? (
          <div className={styles.vocabRail}>
            {[1, 2, 3, 4, 5].map((i) => <div key={i} className={`${styles.shimmerBlock} h-40 min-w-[14rem]`} />)}
          </div>
        ) : trendingVocab && trendingVocab.length > 0 ? (
          <div className={styles.vocabRail}>
            {trendingVocab.map((item) => {
              const isSaved = savedWords.has(item.word);
              const isSaving = savingWords.has(item.word);
              const hasError = saveErrors.has(item.word);
              return (
                <div key={item.id} className={styles.capsule}>
                  <div className={styles.vocabWord}>
                    <strong>{item.word}</strong>
                    {item.phonetic && <span>{item.phonetic}</span>}
                  </div>
                  <p className={styles.vocabMeaning}>{item.meaning}</p>
                  {item.exampleSentence && <p className={styles.vocabExample}>&ldquo;{item.exampleSentence}&rdquo;</p>}
                  <button
                    type="button"
                    id={`btn-save-trending-${item.word}`}
                    disabled={isSaved || isSaving}
                    data-state={isSaved ? "saved" : hasError ? "error" : undefined}
                    onClick={() => handleSaveFlashcard(item.word, item.meaning, item.exampleSentence)}
                    className={styles.saveBtn}
                  >
                    {isSaved ? (
                      <>
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{locale === "vi" ? "Đã lưu" : "Saved"}</span>
                      </>
                    ) : isSaving ? (
                      <span>{locale === "vi" ? "Đang lưu..." : "Saving..."}</span>
                    ) : hasError ? (
                      <>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{locale === "vi" ? "Thử lại" : "Retry"}</span>
                      </>
                    ) : (
                      <>
                        <BookmarkPlus className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{locale === "vi" ? "Lưu Flashcard" : "Save Card"}</span>
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className={styles.emptyNote}>
            {locale === "vi" ? "Chưa có từ vựng thịnh hành." : "No trending vocabulary available."}
          </div>
        )}
      </div>

      {/* ─── READING VIEW MODAL (ĐỌC & TRA TỪ 1-CHẠM) ────────────────────── */}
      {selectedArticleId !== null && (
        <ArticleReadingModal
          articleId={selectedArticleId}
          token={token}
          onClose={() => setSelectedArticleId(null)}
          onSaveFlashcard={handleSaveFlashcard}
          savedWords={savedWords}
          savingWords={savingWords}
          onNavigate={onNavigate}
        />
      )}
    </section>
  );
}

// ─── ARTICLE READING MODAL ──────────────────────────────────────────────────
interface ArticleReadingModalProps {
  articleId: number;
  token?: string | null;
  onClose: () => void;
  onSaveFlashcard: (word: string, meaning: string, example?: string | null) => Promise<void>;
  savedWords: Set<string>;
  savingWords: Set<string>;
  onNavigate?: (tab: string) => void;
}

function ArticleReadingModal({
  articleId,
  token,
  onClose,
  onSaveFlashcard,
  savedWords,
  savingWords,
  onNavigate,
}: ArticleReadingModalProps) {
  const { locale } = useLanguage();

  // Reading content and details
  const { data: detail, isLoading, error } = useSWR<ReadingArticleDetail | null>(
    [`/content/reading/${articleId}`, token],
    ([url, t]) => contentFetcher(url, t as string | null)
  );

  // Library Save State
  const [isSavingToLibrary, setIsSavingToLibrary] = useState(false);
  const [isSavedToLibrary, setIsSavedToLibrary] = useState(false);

  useEffect(() => {
    if (detail?.saved !== undefined) {
      setIsSavedToLibrary(detail.saved);
    }
  }, [detail?.saved]);

  const handleSaveToLibrary = async () => {
    if (isSavingToLibrary || isSavedToLibrary) return;
    setIsSavingToLibrary(true);
    try {
      const res = await apiClient.post<{ saved: boolean; alreadySaved: boolean; libraryArticleId: number }>(
        `/content/reading/save/${articleId}`,
        {}
      );
      if (res.data?.saved) {
        setIsSavedToLibrary(true);
      }
    } catch (err) {
      console.error("Failed to save to reading library", err);
    } finally {
      setIsSavingToLibrary(false);
    }
  };

  // Close on ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Map vocabulary by lower-case word and lemma for 1-touch lookup
  const vocabMap = useMemo(() => {
    const map = new Map<string, ContentVocabularyItem>();
    if (detail?.vocabulary) {
      for (const item of detail.vocabulary) {
        map.set(item.word.toLowerCase(), item);
        if (item.lemma) {
          map.set(item.lemma.toLowerCase(), item);
        }
      }
    }
    return map;
  }, [detail]);

  // Split content into paragraphs
  const paragraphs = useMemo(() => {
    if (!detail?.content) return [];
    return detail.content.split(/\n\n+/).filter((p) => p.trim().length > 0);
  }, [detail?.content]);

  // Interactive Text Selection Popover state
  const contentContainerRef = useRef<HTMLDivElement>(null);
  const [popoverState, setPopoverState] = useState<{
    isOpen: boolean;
    anchorRect: DOMRect | null;
    targetWord: string;
    contextSentence?: string;
    curatedItem?: ContentVocabularyItem | null;
  }>({
    isOpen: false,
    anchorRect: null,
    targetWord: "",
  });

  // Attach selection listeners (mouseup/touchend with ~150ms debounce, and dblclick)
  useEffect(() => {
    const container = contentContainerRef.current;
    if (!container) return;

    let timer: NodeJS.Timeout | null = null;

    const handleSelection = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

        const range = sel.getRangeAt(0);
        if (!container.contains(range.commonAncestorContainer)) return;

        const raw = range.toString();
        const sanitized = sanitizeSelection(raw);
        if (!sanitized) return;

        const rect = range.getBoundingClientRect();
        const sentence = extractContextSentence(range, container);

        setPopoverState({
          isOpen: true,
          anchorRect: rect,
          targetWord: sanitized,
          contextSentence: sentence,
          curatedItem: null,
        });
      }, 150);
    };

    const handleDblClick = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return;

      const raw = range.toString();
      const sanitized = sanitizeSelection(raw);
      if (!sanitized) return;

      const rect = range.getBoundingClientRect();
      const sentence = extractContextSentence(range, container);

      setPopoverState({
        isOpen: true,
        anchorRect: rect,
        targetWord: sanitized,
        contextSentence: sentence,
        curatedItem: null,
      });
    };

    container.addEventListener("mouseup", handleSelection);
    container.addEventListener("touchend", handleSelection);
    container.addEventListener("dblclick", handleDblClick);

    return () => {
      if (timer) clearTimeout(timer);
      container.removeEventListener("mouseup", handleSelection);
      container.removeEventListener("touchend", handleSelection);
      container.removeEventListener("dblclick", handleDblClick);
    };
  }, [detail]);

  const handleCuratedClick = (v: ContentVocabularyItem, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopoverState({
      isOpen: true,
      anchorRect: rect,
      targetWord: v.word,
      contextSentence: v.exampleSentence || undefined,
      curatedItem: v,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-4xl max-h-[90vh] bg-white dark:bg-[#111726] rounded-2xl sm:rounded-3xl border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col overflow-hidden">
        {/* Top-right Modal Close Button */}
        <button
          type="button"
          id="btn-close-reading-modal"
          onClick={onClose}
          className="absolute top-4 right-4 z-20 p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="p-5 sm:p-6 pr-14 border-b border-slate-200/80 dark:border-slate-800 flex items-center justify-between gap-4 shrink-0 bg-slate-50/50 dark:bg-slate-900/50 flex-wrap">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {detail && (
                <>
                  <span className="px-2.5 py-0.5 rounded-md text-xs font-bold bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                    {detail.source}
                  </span>
                  <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                    {detail.level}
                  </span>
                  {detail.contentMode === "SUMMARY_LINK" && (
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-800">
                      {locale === "vi" ? "Bản tóm tắt" : "Summary Only"}
                    </span>
                  )}
                </>
              )}
            </div>
            <h2 className="text-base sm:text-xl font-bold text-slate-900 dark:text-slate-100 truncate">
              {detail ? detail.title : locale === "vi" ? "Đang tải bài đọc..." : "Loading article..."}
            </h2>
          </div>

          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            {/* Action: Lưu vào Thư viện Đọc */}
            {detail && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  id="btn-save-to-reading-library"
                  disabled={isSavingToLibrary || isSavedToLibrary}
                  onClick={handleSaveToLibrary}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-xs cursor-pointer disabled:cursor-default ${
                    isSavedToLibrary
                      ? "bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700"
                      : "bg-indigo-600 hover:bg-indigo-700 text-white"
                  }`}
                >
                  {isSavingToLibrary ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>{locale === "vi" ? "Đang lưu..." : "Saving..."}</span>
                    </>
                  ) : isSavedToLibrary ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      <span>{locale === "vi" ? "Đã lưu vào Thư viện" : "Saved to Library"}</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-3.5 h-3.5" />
                      <span>{locale === "vi" ? "Lưu vào Thư viện Đọc" : "Save to Reading Library"}</span>
                    </>
                  )}
                </button>

                {isSavedToLibrary && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      if (onNavigate) {
                        onNavigate("reading");
                      } else {
                        window.location.href = "/reading";
                      }
                    }}
                    className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline font-semibold cursor-pointer"
                  >
                    {locale === "vi" ? "Mở Thư viện Đọc" : "Open Reading Library"}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Content Body & Vocabulary Sidebar */}
        <div ref={contentContainerRef} className="flex-1 overflow-y-auto p-5 sm:p-7 space-y-6">
          {isLoading ? (
            <div className="space-y-4 animate-pulse">
              <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-full" />
              <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-11/12" />
              <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-4/5" />
              <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-full mt-6" />
              <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-10/12" />
            </div>
          ) : error || !detail ? (
            <div className="p-8 text-center text-sm text-slate-500">
              {locale === "vi" ? "Không thể tải nội dung bài đọc." : "Failed to load reading content."}
            </div>
          ) : (
            <>
              {/* Summary Mode Banner */}
              {detail.contentMode === "SUMMARY_LINK" && (
                <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-800/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <p className="text-xs font-bold text-amber-900 dark:text-amber-200">
                      {locale === "vi" ? "Nguồn chỉ cung cấp bản tóm tắt" : "Source provides summary only"}
                    </p>
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      {locale === "vi"
                        ? "Bạn vẫn có thể bôi đen bất kỳ từ nào để tra từ điển và lưu flashcard, hoặc bấm đọc bài gốc."
                        : "You can still highlight any word to lookup and save flashcards, or read the full original article."}
                    </p>
                  </div>
                  {(detail.sourceUrl || detail.url) && (
                    <a
                      href={detail.sourceUrl || detail.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 rounded-xl text-xs font-bold bg-amber-600 hover:bg-amber-700 text-white shrink-0 inline-flex items-center gap-1.5 transition-colors shadow-xs"
                    >
                      <span>{locale === "vi" ? "Đọc bài gốc" : "Read Original"}</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              )}

              {/* Text Paragraphs */}
              <div className="space-y-5 text-slate-800 dark:text-slate-200 text-sm sm:text-base leading-relaxed sm:leading-loose select-text">
                {paragraphs.map((p, idx) => {
                  const words = p.split(/(\s+)/);
                  return (
                    <p key={idx}>
                      {words.map((w, wIdx) => {
                        const clean = w.replace(/^[^\w]+|[^\w]+$/g, "").toLowerCase();
                        const isMatch = vocabMap.has(clean);
                        if (!isMatch || w.trim().length === 0) {
                          return <span key={wIdx}>{w}</span>;
                        }

                        const vItem = vocabMap.get(clean)!;

                        return (
                          <span
                            key={wIdx}
                            onClick={(e) => handleCuratedClick(vItem, e)}
                            className="cursor-pointer text-indigo-700 dark:text-indigo-400 font-semibold underline decoration-indigo-400/50 decoration-2 underline-offset-4 hover:bg-indigo-100 dark:hover:bg-indigo-950/80 rounded px-0.5 transition-colors"
                            title={locale === "vi" ? "Chạm để tra từ vựng" : "Tap to lookup vocabulary"}
                          >
                            {w}
                          </span>
                        );
                      })}
                    </p>
                  );
                })}
              </div>

              {/* Key Vocabulary in Article (1-Touch List) */}
              {detail.vocabulary && detail.vocabulary.length > 0 && (
                <div className="mt-8 pt-6 border-t border-slate-200 dark:border-slate-800 space-y-3">
                  <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <span>{locale === "vi" ? "Từ vựng trọng tâm trong bài" : "Key Vocabulary in Article"}</span>
                  </h4>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {detail.vocabulary.map((v) => {
                      const isSaved = savedWords.has(v.word);
                      const isSaving = savingWords.has(v.word);

                      return (
                        <div
                          key={v.id}
                          className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 flex items-start justify-between gap-2.5"
                        >
                          <div className="space-y-0.5 min-w-0">
                            <div className="flex items-baseline gap-2">
                              <span
                                className="font-bold text-sm text-indigo-600 dark:text-indigo-400 cursor-pointer hover:underline"
                                onClick={(e) => handleCuratedClick(v, e)}
                              >
                                {v.word}
                              </span>
                              {v.phonetic && (
                                <span className="text-[10px] font-mono text-slate-400">
                                  {v.phonetic}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-slate-700 dark:text-slate-300 font-medium">
                              {v.meaning}
                            </p>
                            {v.exampleSentence && (
                              <p className="text-[11px] text-slate-500 italic truncate">
                                &ldquo;{v.exampleSentence}&rdquo;
                              </p>
                            )}
                          </div>

                          <button
                            type="button"
                            disabled={isSaved || isSaving}
                            onClick={() => onSaveFlashcard(v.word, v.meaning, v.exampleSentence)}
                            className={`p-1.5 rounded-lg text-xs font-semibold transition-all shrink-0 cursor-pointer disabled:cursor-default ${
                              isSaved
                                ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300"
                                : "bg-white dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-950 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
                            }`}
                            title={isSaved ? (locale === "vi" ? "Đã lưu vào bộ thẻ" : "Saved to flashcards") : (locale === "vi" ? "Lưu Flashcard" : "Save Flashcard")}
                          >
                            {isSaved ? (
                              <Check className="w-4 h-4 text-emerald-600" />
                            ) : isSaving ? (
                              <span className="text-[10px]">...</span>
                            ) : (
                              <BookmarkPlus className="w-4 h-4 text-indigo-500" />
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Shared Interactive Text-Selection Dictionary Popover */}
      <WordLookupPopover
        isOpen={popoverState.isOpen}
        anchorRect={popoverState.anchorRect}
        targetWord={popoverState.targetWord}
        contextSentence={popoverState.contextSentence}
        articleTitle={detail?.title}
        token={token}
        curatedItem={popoverState.curatedItem}
        onClose={() => setPopoverState((prev) => ({ ...prev, isOpen: false }))}
        onSelectWord={(word) =>
          setPopoverState((prev) => ({ ...prev, targetWord: word, curatedItem: null }))
        }
        containerRef={contentContainerRef}
      />
    </div>
  );
}

