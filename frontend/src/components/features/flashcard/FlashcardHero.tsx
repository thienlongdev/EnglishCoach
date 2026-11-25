"use client";

import React, { useEffect, useRef, useState } from "react";
import { RotateCcw, Volume2 } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import type { RecallQuality } from "./RecallControls";
import { cardFace, type CardFaceDeckSense } from "./cardFace";
import styles from "./flashcardStudy.module.css";
import tides from "./tides/memoryTides.module.css";
import { ClozeRecall, RecallVerdict, TypeRecall, type RecallAttempt } from "./tides/DeepRecall";
import { clozeFor, type RecallMode } from "./tides/recall";
import type { MemoryTier } from "@/types/flashcardMemory";
import type { StudyPhase } from "./tides/studyTimeline";

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
  deckSense?: CardFaceDeckSense | null;
}

const POS_VI: Record<string, string> = {
  noun: "danh từ",
  phrase: "cụm từ",
  verb: "động từ",
  adjective: "tính từ",
  adverb: "trạng từ",
  preposition: "giới từ",
  conjunction: "liên từ",
};

interface FlashcardHeroProps {
  card: Flashcard;
  flipped: boolean;
  onFlip: () => void;
  onToggleAudio: (e: React.MouseEvent, text: string) => void;
  isPlaying: boolean;
  /** The rating being saved for this card, or null (the ratings themselves live in the theater's dock, StudyDeckView). */
  savingQuality: RecallQuality | null;
  /** False while a dialog or another study tool is open: Space and 1–3 then belong to it. */
  shortcutsEnabled: boolean;
  /** Deep Recall (optional): type the meaning, or fill the word into a stored example, before turning. */
  recallMode?: RecallMode;
  /** Card Alchemy look of this card (server evidence); only Holo Prism / Eternal Pearl show a quiet edge here. */
  tier?: MemoryTier | null;
  /** The card's step on the study timeline; without it the face alone decides (back = ratings ready). */
  phase?: StudyPhase;
}

const TIER_NAME: Record<MemoryTier, string> = {
  RAW: "Raw Memory",
  SILVER: "Silver Echo",
  PRISM: "Holo Prism",
  PEARL: "Eternal Pearl",
};

/** Five coordinated colourways; a card keeps its own (by id) so a deck reads as a lively, consistent set. */
const PALETTES = [
  { // sapphire tide
    "--fc-a": "#1e3a8a", "--fc-b": "#2563eb", "--fc-c": "#0e7490", "--fc-bloom": "rgba(236,72,153,0.5)",
    "--fc-glow": "rgba(167,139,250,0.6)", "--fc-shadow": "rgba(37,99,235,0.6)", "--fc-ink": "#1d4ed8",
    "--fc-tint-1": "rgba(191,219,254,0.75)", "--fc-tint-2": "rgba(207,250,254,0.6)",
    "--fc-tint-dark-1": "rgba(37,99,235,0.28)", "--fc-tint-dark-2": "rgba(14,116,144,0.22)",
  },
  { // violet dusk
    "--fc-a": "#3b0764", "--fc-b": "#6d28d9", "--fc-c": "#be185d", "--fc-bloom": "rgba(251,146,60,0.48)",
    "--fc-glow": "rgba(244,114,182,0.55)", "--fc-shadow": "rgba(109,40,217,0.6)", "--fc-ink": "#6d28d9",
    "--fc-tint-1": "rgba(233,213,255,0.8)", "--fc-tint-2": "rgba(252,231,243,0.7)",
    "--fc-tint-dark-1": "rgba(124,58,237,0.28)", "--fc-tint-dark-2": "rgba(190,24,93,0.2)",
  },
  { // lagoon
    "--fc-a": "#134e4a", "--fc-b": "#0f766e", "--fc-c": "#1d4ed8", "--fc-bloom": "rgba(250,204,21,0.36)",
    "--fc-glow": "rgba(45,212,191,0.55)", "--fc-shadow": "rgba(15,118,110,0.6)", "--fc-ink": "#0f766e",
    "--fc-tint-1": "rgba(204,251,241,0.85)", "--fc-tint-2": "rgba(219,234,254,0.7)",
    "--fc-tint-dark-1": "rgba(13,148,136,0.26)", "--fc-tint-dark-2": "rgba(29,78,216,0.2)",
  },
  { // coral sunset
    "--fc-a": "#881337", "--fc-b": "#e11d48", "--fc-c": "#c2410c", "--fc-bloom": "rgba(253,224,71,0.42)",
    "--fc-glow": "rgba(251,113,133,0.6)", "--fc-shadow": "rgba(225,29,72,0.55)", "--fc-ink": "#be123c",
    "--fc-tint-1": "rgba(255,228,230,0.85)", "--fc-tint-2": "rgba(255,237,213,0.75)",
    "--fc-tint-dark-1": "rgba(225,29,72,0.24)", "--fc-tint-dark-2": "rgba(234,88,12,0.2)",
  },
  { // indigo aurora
    "--fc-a": "#1e1b4b", "--fc-b": "#4338ca", "--fc-c": "#0369a1", "--fc-bloom": "rgba(34,211,238,0.5)",
    "--fc-glow": "rgba(129,140,248,0.6)", "--fc-shadow": "rgba(67,56,202,0.6)", "--fc-ink": "#4338ca",
    "--fc-tint-1": "rgba(224,231,255,0.85)", "--fc-tint-2": "rgba(207,250,254,0.6)",
    "--fc-tint-dark-1": "rgba(79,70,229,0.3)", "--fc-tint-dark-2": "rgba(3,105,161,0.22)",
  },
] as Record<string, string>[] as React.CSSProperties[];

function lengthClass(word: string) {
  const n = word.length;
  return n <= 9 ? "s" : n <= 14 ? "m" : n <= 22 ? "l" : "xl";
}

function statusLabel(status: string, vi: boolean) {
  if (status === "MASTERED") return vi ? "Đã thuộc" : "Mastered";
  if (status === "LEARNED") return vi ? "Đang học" : "Learning";
  return vi ? "Từ mới" : "New word";
}

/** Emphasise the headword (and simple inflections of a single word) inside an example sentence. */
function highlight(sentence: string, word: string): React.ReactNode {
  const w = word.trim();
  if (!w) return sentence;
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const phrase = /\s/.test(w);
  // Single words also match common inflections: responsibility → responsibilities, agree → agreed, take → taking.
  const stem = phrase || w.length < 4 ? esc(w)
    : /y$/i.test(w) ? `${esc(w.slice(0, -1))}(?:y|i)`
    : /e$/i.test(w) ? `${esc(w.slice(0, -1))}e?`
    : esc(w);
  const pattern = new RegExp(phrase ? `(${stem})` : `\\b(${stem}[a-z]*)`, "gi");
  const parts = sentence.split(pattern);
  if (parts.length === 1) return sentence;
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <React.Fragment key={i}>{part}</React.Fragment>));
}

function isTypingTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export function FlashcardHero({
  card,
  flipped,
  onFlip,
  onToggleAudio,
  isPlaying,
  savingQuality,
  shortcutsEnabled,
  recallMode = "flip",
  tier = null,
  phase: phaseProp,
}: FlashcardHeroProps) {
  const phase: StudyPhase = phaseProp ?? (flipped ? "back" : "front");
  const { locale } = useLanguage();
  const vi = locale === "vi";
  // custom text first; legacy imports (number as word, IPA as example) shown as word / IPA (cardFace)
  const face = cardFace(card);
  const word = face.word || (vi ? "(chưa có từ)" : "(no word)");
  const { ipa, cefr, headline, headlineVi, headlineLang, definitions, examples, exampleTranslations, partOfSpeech } = face;
  const posLabel = partOfSpeech ? (vi ? POS_VI[partOfSpeech] ?? partOfSpeech : partOfSpeech) : null;
  const palette = PALETTES[Math.abs(card.id) % PALETTES.length];

  const cardRef = useRef<HTMLDivElement>(null);
  const flipButtonRef = useRef<HTMLButtonElement>(null);
  const backTitleRef = useRef<HTMLHeadingElement>(null);
  const [audioKey, setAudioKey] = useState<string | null>(null);
  // the learner's Deep Recall answer for this card (the card is keyed by id, so a new card starts empty)
  const [attempt, setAttempt] = useState<RecallAttempt | null>(null);
  const cloze = recallMode === "cloze" ? clozeFor(word, examples) : null;
  const concealed = recallMode === "cloze" && cloze !== null;
  const reveal = (a: RecallAttempt | null) => { setAttempt(a); if (!flipped) onFlip(); };
  const clozeHints = cloze ? [
    vi ? `Bắt đầu bằng “${cloze.answer[0]}”, gồm ${cloze.answer.length} chữ cái` : `Starts with “${cloze.answer[0]}”, ${cloze.answer.length} letters`,
    ...(posLabel ? [vi ? `Từ loại: ${posLabel}` : `Part of speech: ${posLabel}`] : []),
    ...(headline ? [vi ? `Nghĩa: ${headline}` : `Meaning: ${headline}`] : []),
    ...(ipa ? [vi ? `Phát âm: ${ipa}` : `Pronunciation: ${ipa}`] : []),
  ] : [];
  const showTier = tier === "PRISM" || tier === "PEARL";

  // Space turns the card, unless the learner is typing, a control has focus (it handles Space itself) or a dialog
  // owns the keyboard. Held keys do not repeat the turn.
  useEffect(() => {
    if (!shortcutsEnabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || isTypingTarget(e.target)) return;
      const el = e.target as HTMLElement | null;
      if (el && el !== document.body && el.closest("button, a, [role='button'], summary")) return;
      e.preventDefault();
      onFlip();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onFlip, shortcutsEnabled]);

  // Keep keyboard focus with the face that is showing (only when focus was already on the card).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const active = document.activeElement;
    if (!active || !cardRef.current?.contains(active)) return;
    if (flipped) backTitleRef.current?.focus({ preventScroll: true });
    else flipButtonRef.current?.focus({ preventScroll: true });
  }, [flipped]);

  const play = (e: React.MouseEvent, key: string, text: string) => {
    setAudioKey(key);
    onToggleAudio(e, text);
  };
  const pressed = (key: string) => isPlaying && audioKey === key;

  return (
    <div className={`${styles.stage} ${styles.enter}`} style={palette} data-phase={phase} data-saving={savingQuality ?? undefined}>
      <div ref={cardRef} className={styles.card} data-flipped={flipped ? "true" : "false"} data-study-card>
        {/* ── FRONT ── */}
        <section
          className={`${styles.face} ${styles.front}`}
          aria-hidden={flipped}
          inert={flipped}
          aria-label={vi ? "Mặt trước thẻ" : "Card front"}
          onClick={(e) => {
            // Anywhere on the colour surface turns the card; its own controls keep their own action.
            if ((e.target as HTMLElement).closest("button, input, textarea, label, form, [data-no-flip]")) return;
            onFlip();
          }}
        >
          <span className={styles.flipLight} aria-hidden="true" />
          {showTier && <span className={tides.foil} data-tier={tier ?? undefined} aria-hidden="true" />}
          <div className={styles.frontTop}>
            <span className="flex flex-wrap items-center gap-2">
              <span className={styles.status}><span className={styles.statusDot} aria-hidden="true" />{statusLabel(card.status, vi)}</span>
              {showTier && tier && (
                <span className={tides.tierChip} data-tier={tier} title={tier === "PEARL"
                  ? (vi ? "Đã nhớ được ở nhiều ngày khác nhau" : "Recalled on several different days")
                  : (vi ? "Bạn đã tự dùng từ này trong một câu được Echo chấp nhận" : "You used this word in a sentence Echo accepted")}>
                  {TIER_NAME[tier]}
                </span>
              )}
            </span>
            {!concealed && <button
              type="button"
              className={styles.audioFront}
              aria-label={vi ? `Nghe phát âm “${word}”` : `Hear “${word}”`}
              aria-pressed={pressed("front")}
              title={vi ? "Nghe phát âm" : "Hear pronunciation"}
              onClick={(e) => play(e, "front", word)}
            >
              <Volume2 className="h-5 w-5" aria-hidden="true" />
            </button>}
          </div>

          <div className={`${styles.wordBlock} notranslate`} translate="no">
            {concealed && cloze ? (
              <ClozeRecall cloze={cloze} word={word} vi={vi} hints={clozeHints} onReveal={reveal} />
            ) : (
              <>
                <h2 className={styles.word} data-len={lengthClass(word)} lang="en">
                  {word}
                </h2>
                {ipa && <p className={`${styles.ipa} ${styles.frontIpa} m-0`}>{ipa}</p>}
                {recallMode === "type" && <TypeRecall word={word} storedMeaning={headline || null} vi={vi} onReveal={reveal} />}
                {recallMode === "cloze" && !cloze && (
                  <p className={`m-0 text-sm font-semibold ${styles.frontNote}`}>
                    {vi ? "Thẻ này chưa có câu ví dụ chứa từ, nên hiện như thẻ thường." : "This card has no example containing the word, so it shows as usual."}
                  </p>
                )}
              </>
            )}
          </div>

          <div className={styles.frontBottom}>
            <button ref={flipButtonRef} type="button" className={styles.flipButton} onClick={onFlip} data-guide="fc-flip">
              {vi ? "Lật thẻ xem nghĩa" : "Turn to see the meaning"}
              <span className={styles.kbd} aria-hidden="true">Space</span>
            </button>
          </div>
        </section>

        {/* ── BACK ── */}
        <section
          className={`${styles.face} ${styles.back}`}
          aria-hidden={!flipped}
          inert={!flipped}
          aria-label={vi ? "Mặt sau thẻ" : "Card back"}
        >
          <span className={styles.flipLight} aria-hidden="true" />
          <header className={styles.backHead}>
            <div className="min-w-0 notranslate" translate="no">
              <h2 ref={backTitleRef} tabIndex={-1} className={`${styles.backWord} outline-none`} data-len={lengthClass(word)} lang="en">
                {word}
              </h2>
              {(ipa || cefr || posLabel) && (
                <div className={styles.backMeta}>
                  {ipa && <span className={styles.ipa}>{ipa}</span>}
                  {posLabel && <span className={styles.pos} title={vi ? "Từ loại của nghĩa này" : "Part of speech of this sense"}>{posLabel}</span>}
                  {cefr && <span className={styles.cefr} title={vi ? "Trình độ CEFR của từ" : "CEFR level of the word"}>{cefr}</span>}
                </div>
              )}
            </div>
            <div className={styles.backTools}>
              <button
                type="button"
                className={`${styles.tool} ${styles.toolIcon}`}
                aria-label={vi ? `Nghe phát âm “${word}”` : `Hear “${word}”`}
                aria-pressed={pressed("back")}
                title={vi ? "Nghe phát âm" : "Hear pronunciation"}
                onClick={(e) => play(e, "back", word)}
              >
                <Volume2 className="h-[18px] w-[18px]" aria-hidden="true" />
              </button>
              <button type="button" className={styles.tool} onClick={onFlip}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                {vi ? "Lật lại" : "Turn back"}
              </button>
            </div>
          </header>

          {attempt && <RecallVerdict attempt={attempt} vi={vi} />}

          <div className={`${styles.meaning} notranslate`} translate="no">
            <span className={styles.label}>{headlineVi || !headline ? (vi ? "Nghĩa" : "Meaning") : (vi ? "Định nghĩa" : "Definition")}</span>
            {headline ? (
              <p className={styles.meaningVi} lang={headlineLang}>{headline}</p>
            ) : (
              <p className={styles.meaningVi}>{vi ? "Từ này chưa có nghĩa trong từ điển." : "No meaning is stored for this word yet."}</p>
            )}
            {card.deckSense?.sourceKind && <small className={styles.label}>
              {card.deckSense.sourceKind === "book" ? <a href="/assets/licenses/books-vocabulary.txt" target="_blank" rel="noreferrer">{vi ? "Nguồn học liệu" : "Learning sources"}</a> : card.deckSense.sourceKind === "wiki" ? <><a href={"https://vi.wiktionary.org/wiki/" + encodeURIComponent(word.replace(/ /g, "_"))} target="_blank" rel="noreferrer">Wiktionary</a> · <a href="/assets/licenses/vocabulary-library.txt" target="_blank" rel="noreferrer">CC BY-SA 4.0 · {vi ? "Ghi công" : "Credits"}</a></> : card.deckSense.sourceKind === "reader" ? <a href="/assets/licenses/vocabulary-library.txt" target="_blank" rel="noreferrer">EnglishCoach · Reading Lab</a> : "EnglishCoach Original"}
            </small>}
            {definitions.length > 0 && (
              <ul className={styles.definitions} lang="en">
                {definitions.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            )}
          </div>

          {examples.length > 0 && (
            <div className={`${styles.examples} notranslate`} translate="no">
              <span className={styles.label}>{examples.length > 1 ? (vi ? "Ví dụ" : "Examples") : (vi ? "Ví dụ" : "Example")}</span>
              {examples.map((ex, i) => (
                <div key={i} className={styles.example}>
                  <div className={styles.exampleBody}>
                    <p className={styles.exampleText} lang="en">{highlight(ex, word)}</p>
                    {exampleTranslations[i] && <p className={styles.exampleVi} lang="vi">{exampleTranslations[i]}</p>}
                  </div>
                  <button
                    type="button"
                    className={`${styles.tool} ${styles.examplePlay}`}
                    aria-label={vi ? "Nghe câu ví dụ" : "Hear the example"}
                    aria-pressed={pressed(`ex${i}`)}
                    title={vi ? "Nghe câu ví dụ" : "Hear the example"}
                    onClick={(e) => play(e, `ex${i}`, ex)}
                  >
                    <Volume2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
