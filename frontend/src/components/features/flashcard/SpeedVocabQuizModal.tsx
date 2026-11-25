"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { apiClient } from "@/services/api-client";
import { VocabDeckSummary } from "./DeckCatalogView";
import { cardFace, type CardFaceDeckSense } from "./cardFace";
import {
  AlertCircle,
  Award,
  Check,
  CheckCircle2,
  Clock,
  Flame,
  RotateCcw,
  Trophy,
  Volume2,
  X,
  Zap,
} from "lucide-react";
import s from "./theater/theaterQuiz.module.css";

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
  customMeaning?: string | null;
  customExample?: string | null;
  deckSense?: CardFaceDeckSense | null;
}

export interface QuizQuestion {
  cardId: number;
  word: string;
  ipa?: string;
  topic: string;
  correctAnswer: string;
  options: string[];
  userChoice: string | null;
  isCorrect: boolean | null;
  timedOut: boolean;
}

interface SpeedVocabQuizModalProps {
  isOpen: boolean;
  onClose: () => void;
  deck: VocabDeckSummary;
  availableCards?: Flashcard[];
}

function resolveCardAnswer(card: Flashcard): { word: string; ipa?: string; answer: string } | null {
  const face = cardFace({
    dictionaryEntry: card.dictionaryEntry,
    customMeaning: card.customMeaning ?? null,
    customExample: card.customExample ?? null,
    deckSense: card.deckSense ?? null,
  });
  const word = (face.word || card?.dictionaryEntry?.word || "").trim();
  const answer = (
    face.headline ||
    card?.dictionaryEntry?.generalTranslationVi ||
    card?.dictionaryEntry?.meanings?.[0] ||
    ""
  ).trim();
  if (!word || !answer) return null;
  return { word, ipa: face.ipa || card?.dictionaryEntry?.ipa, answer };
}

export function SpeedVocabQuizModal({
  isOpen,
  onClose,
  deck,
  availableCards = [],
}: SpeedVocabQuizModalProps) {
  const [status, setStatus] = useState<"loading" | "playing" | "summary" | "empty">("loading");
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [currentQIndex, setCurrentQIndex] = useState(0);
  const [streak, setStreak] = useState(0);
  const [maxStreak, setMaxStreak] = useState(0);
  const [timeLeft, setTimeLeft] = useState(10);
  const [isAnswered, setIsAnswered] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runIdRef = useRef(0);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setIsPlayingAudio(false);
  }, []);

  // Play audio for a given word (pauses Echo Music first, matching FlashcardUI contract)
  const playWordAudio = useCallback(
    async (word: string) => {
      if (!word) return;
      window.dispatchEvent(new Event("ec:music-pause"));
      stopAudio();
      setIsPlayingAudio(true);

      const fallbackSpeech = () => {
        if (typeof window !== "undefined" && "speechSynthesis" in window) {
          const utterance = new SpeechSynthesisUtterance(word);
          utterance.lang = "en-US";
          utterance.onend = () => setIsPlayingAudio(false);
          utterance.onerror = () => setIsPlayingAudio(false);
          window.speechSynthesis.speak(utterance);
        } else {
          setIsPlayingAudio(false);
        }
      };

      const url = `https://api.streamelements.com/kappa/v2/speech?voice=Salli&text=${encodeURIComponent(word)}`;
      try {
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => setIsPlayingAudio(false);
        audio.onerror = fallbackSpeech;
        await audio.play();
      } catch {
        fallbackSpeech();
      }
    },
    [stopAudio],
  );

  // Initialize or restart the quiz (read-only: never mutates SM-2 or learning progress)
  const initQuiz = useCallback(async () => {
    const runId = ++runIdRef.current;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    stopAudio();

    setStatus("loading");
    setQuestions([]);
    setCurrentQIndex(0);
    setStreak(0);
    setMaxStreak(0);
    setIsAnswered(false);
    setTimeLeft(10);

    try {
      let pool: Flashcard[] = [];

      try {
        const deckParam = deck.id ? `deckId=${deck.id}&` : "";
        const res = await apiClient.get<any>(`/flashcards?${deckParam}page=0&size=100`);
        const data = res.data;
        pool = Array.isArray(data) ? data : data?.content || data?.data || [];
      } catch (err) {
        console.warn("Failed to fetch fresh cards for quiz, using availableCards:", err);
        pool = availableCards;
      }

      if (runId !== runIdRef.current) return;

      if (!pool || pool.length === 0) {
        pool = availableCards;
      }

      const resolved = pool
        .map((card) => {
          const r = resolveCardAnswer(card);
          return r ? { card, ...r } : null;
        })
        .filter((x): x is { card: Flashcard; word: string; ipa?: string; answer: string } => x !== null);

      if (resolved.length < 4) {
        setStatus("empty");
        return;
      }

      const allMeaningsMap = new Map<string, string>();
      resolved.forEach((item) => {
        allMeaningsMap.set(item.answer, item.word);
      });
      const allMeanings = Array.from(allMeaningsMap.keys());

      const shuffledCards = [...resolved].sort(() => 0.5 - Math.random());
      const numQuestions = Math.min(15, Math.max(10, Math.min(shuffledCards.length, 10)));
      const selectedQuestionCards = shuffledCards.slice(0, numQuestions);

      const generatedQuestions: QuizQuestion[] = selectedQuestionCards.map((item) => {
        const topic = deck.category?.replace("_", " ") || "VOCABULARY";
        const otherMeanings = allMeanings.filter((m) => m !== item.answer);
        const shuffledDistractors = [...otherMeanings].sort(() => 0.5 - Math.random());
        const distractors = shuffledDistractors.slice(0, 3);

        while (distractors.length < 3) {
          distractors.push(`Ý nghĩa phụ #${distractors.length + 1}`);
        }

        const options = [item.answer, ...distractors].sort(() => 0.5 - Math.random());

        return {
          cardId: item.card.id,
          word: item.word,
          ipa: item.ipa,
          topic,
          correctAnswer: item.answer,
          options,
          userChoice: null,
          isCorrect: null,
          timedOut: false,
        };
      });

      if (runId !== runIdRef.current) return;

      setQuestions(generatedQuestions);
      setStatus("playing");
      setTimeLeft(10);
      setIsAnswered(false);

      if (generatedQuestions[0]) {
        void playWordAudio(generatedQuestions[0].word);
      }
    } catch (e) {
      if (runId !== runIdRef.current) return;
      console.error("Failed to initialize speed vocab quiz:", e);
      setStatus("empty");
    }
  }, [deck, availableCards, playWordAudio, stopAudio]);

  // Open / close lifecycle
  useEffect(() => {
    if (isOpen) {
      void initQuiz();
    } else {
      runIdRef.current += 1;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (advanceTimerRef.current) {
        clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
      stopAudio();
    }
    return () => {
      runIdRef.current += 1;
      if (timerRef.current) clearInterval(timerRef.current);
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    };
  }, [isOpen, initQuiz, stopAudio]);

  // Advance to next question or finish (side effects outside setState updater so sibling listeners like Echo Music never warn)
  const advanceToNext = useCallback(() => {
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }

    const nextIndex = currentQIndex + 1;
    if (nextIndex >= questions.length) {
      setStatus("summary");
      stopAudio();
      return;
    }

    setCurrentQIndex(nextIndex);
    setIsAnswered(false);
    setTimeLeft(10);
    const nextWord = questions[nextIndex]?.word;
    if (nextWord) {
      void playWordAudio(nextWord);
    }
  }, [currentQIndex, questions, playWordAudio, stopAudio]);

  // Handle answer selection (guarded against double answer)
  const handleAnswer = useCallback(
    (selectedOption: string | null, isTimeout = false) => {
      if (isAnswered || status !== "playing") return;

      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }

      setIsAnswered(true);

      const currentQ = questions[currentQIndex];
      if (!currentQ) return;

      const isCorrect = !isTimeout && selectedOption === currentQ.correctAnswer;

      if (isCorrect) {
        setStreak((prev) => {
          const nextStreak = prev + 1;
          setMaxStreak((currMax) => Math.max(currMax, nextStreak));
          return nextStreak;
        });
      } else {
        setStreak(0);
      }

      setQuestions((prev) =>
        prev.map((q, idx) =>
          idx === currentQIndex
            ? {
                ...q,
                userChoice: selectedOption,
                isCorrect,
                timedOut: isTimeout,
              }
            : q,
        ),
      );

      advanceTimerRef.current = setTimeout(() => {
        advanceToNext();
      }, 1300);
    },
    [isAnswered, status, questions, currentQIndex, advanceToNext],
  );

  // 10-Second Countdown Timer
  useEffect(() => {
    if (status !== "playing" || isAnswered) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    setTimeLeft(10);
    const startTime = Date.now();
    const duration = 10000;

    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));
      setTimeLeft(remaining);

      if (elapsed >= duration) {
        if (timerRef.current) clearInterval(timerRef.current);
        handleAnswer(null, true);
      }
    }, 200);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status, currentQIndex, isAnswered, handleAnswer]);

  // Keyboard shortcuts: 1-4 to choose, Space/Enter to advance, Escape to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }

      if (status === "playing") {
        if (!isAnswered) {
          const currentQ = questions[currentQIndex];
          if (!currentQ) return;

          if (e.key === "1" && currentQ.options[0]) {
            e.preventDefault();
            handleAnswer(currentQ.options[0]);
          } else if (e.key === "2" && currentQ.options[1]) {
            e.preventDefault();
            handleAnswer(currentQ.options[1]);
          } else if (e.key === "3" && currentQ.options[2]) {
            e.preventDefault();
            handleAnswer(currentQ.options[2]);
          } else if (e.key === "4" && currentQ.options[3]) {
            e.preventDefault();
            handleAnswer(currentQ.options[3]);
          }
        } else if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          advanceToNext();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, status, isAnswered, questions, currentQIndex, handleAnswer, advanceToNext, onClose]);

  if (!isOpen || typeof window === "undefined") return null;

  const currentQ = questions[currentQIndex];
  const correctCount = questions.filter((q) => q.isCorrect === true).length;
  const accuracyPercentage = questions.length > 0 ? Math.round((correctCount / questions.length) * 100) : 0;
  const incorrectQuestions = questions.filter((q) => q.isCorrect === false);
  const urgency = timeLeft <= 3 ? "critical" : timeLeft <= 5 ? "warn" : "normal";
  const ringR = 46;
  const ringC = 2 * Math.PI * ringR;

  return createPortal(
    <div
      className={s.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={`Quiz Trắc nghiệm: ${deck.title}`}
      data-theater-quiz=""
      onClick={onClose}
    >
      <div className={s.panel} onClick={(e) => e.stopPropagation()}>
        {/* VIEW 1: LOADING */}
        {status === "loading" && (
          <div className={s.centeredState}>
            <span className={s.stateOrb} aria-hidden="true">
              <Zap className="h-7 w-7" />
            </span>
            <h3 className={s.stateTitle}>Đang chuẩn bị câu hỏi trắc nghiệm...</h3>
            <p className={s.stateSub}>
              Trích xuất từ vựng và các phương án từ bộ {deck.title}. Điểm Quiz không làm thay đổi lịch ôn thẻ.
            </p>
          </div>
        )}

        {/* VIEW 2: NOT ENOUGH WORDS */}
        {status === "empty" && (
          <div className={s.centeredState}>
            <span className={s.stateOrb} data-tone="warn" aria-hidden="true">
              <AlertCircle className="h-7 w-7" />
            </span>
            <h3 className={s.stateTitle}>Chưa đủ từ vựng để tạo Quiz</h3>
            <p className={s.stateSub}>
              Bộ từ này cần tối thiểu 4 từ vựng có nghĩa để tạo câu hỏi trắc nghiệm 4 phương án.
            </p>
            <button type="button" onClick={onClose} className={s.btnPrimary}>
              Quay lại bộ từ
            </button>
          </div>
        )}

        {/* VIEW 3: ACTIVE SPEED QUIZ ARENA */}
        {status === "playing" && currentQ && (
          <div className="flex flex-col w-full">
            <header className={s.head}>
              <div className={s.headLeft}>
                <span className={s.counterPill}>
                  <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>
                    Câu {currentQIndex + 1} / {questions.length}
                  </span>
                </span>
                {streak > 0 && (
                  <span className={s.streakPill}>
                    <Flame className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Chuỗi đúng: {streak}</span>
                  </span>
                )}
              </div>

              <div className={s.headRight}>
                <div className={s.timerPill} data-urgency={urgency} aria-live="off">
                  <Clock className="h-4 w-4" aria-hidden="true" />
                  <span>{timeLeft}s</span>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className={s.closeBtn}
                  title="Thoát Quiz (Esc)"
                  aria-label="Thoát Quiz"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </header>

            <div className={s.progressWrap}>
              <div className={s.dots} aria-hidden="true">
                {questions.map((q, idx) => {
                  const dotState =
                    q.isCorrect === true
                      ? "correct"
                      : q.isCorrect === false
                        ? "wrong"
                        : idx === currentQIndex
                          ? "current"
                          : "ahead";
                  return <span key={q.cardId + "-" + idx} className={s.dot} data-state={dotState} />;
                })}
              </div>
              <div className={s.timerRail} aria-hidden="true">
                <div
                  className={s.timerFill}
                  data-urgency={urgency}
                  style={{ width: `${(timeLeft / 10) * 100}%` }}
                />
              </div>
            </div>

            <section className={s.hero} aria-label="Câu hỏi hiện tại">
              <div className={s.heroMeta}>
                <span className={s.topicChip}>{currentQ.topic}</span>
                <span className={s.promptHint}>Chọn nghĩa tiếng Việt chính xác</span>
              </div>

              <div className={`${s.wordRow} notranslate`} translate="no">
                <h2 className={s.word} lang="en">
                  {currentQ.word}
                </h2>
                <button
                  type="button"
                  onClick={() => void playWordAudio(currentQ.word)}
                  disabled={isPlayingAudio}
                  data-playing={isPlayingAudio ? "true" : "false"}
                  title="Phát âm từ này"
                  aria-label={`Phát âm “${currentQ.word}”`}
                  className={s.audioBtn}
                >
                  <Volume2 className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>

              {currentQ.ipa && (
                <p className={`${s.ipa} notranslate`} translate="no">
                  {currentQ.ipa}
                </p>
              )}
            </section>

            <div className={`${s.options} notranslate`} translate="no" role="group" aria-label="Các phương án trả lời">
              {currentQ.options.map((opt, optIndex) => {
                const isSelected = currentQ.userChoice === opt;
                const isTheCorrectOption = opt === currentQ.correctAnswer;
                const optionState = !isAnswered
                  ? "idle"
                  : isTheCorrectOption
                    ? "correct"
                    : isSelected && !currentQ.isCorrect
                      ? "wrong"
                      : "dim";

                return (
                  <button
                    key={optIndex}
                    type="button"
                    disabled={isAnswered}
                    data-state={optionState}
                    onClick={() => handleAnswer(opt)}
                    className={s.option}
                  >
                    <span className={s.optionKey} aria-hidden="true">
                      {optIndex + 1}
                    </span>
                    <span className={s.optionText}>{opt}</span>
                    {isAnswered && isTheCorrectOption && (
                      <span className={s.optionBadge} aria-hidden="true">
                        <Check className="h-4 w-4" />
                      </span>
                    )}
                    {isAnswered && isSelected && !currentQ.isCorrect && (
                      <span className={s.optionBadge} aria-hidden="true">
                        <X className="h-4 w-4" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <footer className={s.foot}>
              <div className={s.keysRow}>
                <span>Phím tắt:</span>
                <kbd>1</kbd>
                <kbd>2</kbd>
                <kbd>3</kbd>
                <kbd>4</kbd>
              </div>

              {isAnswered && (
                <button type="button" onClick={advanceToNext} className={s.nextBtn}>
                  <span>Tiếp theo</span>
                  <kbd>Space</kbd>
                </button>
              )}
            </footer>
          </div>
        )}

        {/* VIEW 4: COMPLETION SUMMARY */}
        {status === "summary" && (
          <div className={s.summaryScroll}>
            <div className={s.summaryHead}>
              <div className={s.accuracyRing} aria-label={`Đạt ${accuracyPercentage}%`}>
                <svg viewBox="0 0 120 120" aria-hidden="true">
                  <circle className={s.ringTrack} cx="60" cy="60" r={ringR} />
                  <circle
                    className={s.ringArc}
                    cx="60"
                    cy="60"
                    r={ringR}
                    strokeDasharray={`${((accuracyPercentage / 100) * ringC).toFixed(2)} ${ringC.toFixed(2)}`}
                  />
                </svg>
                <div className={s.ringCenter}>
                  <strong>{accuracyPercentage}%</strong>
                  <span>
                    {correctCount}/{questions.length}
                  </span>
                </div>
              </div>

              <span className={s.summaryKicker}>
                {accuracyPercentage >= 80 ? (
                  <Trophy className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Award className="h-4 w-4" aria-hidden="true" />
                )}
                <span>Hoàn thành Quiz</span>
              </span>

              <h2 className={s.summaryTitle}>
                Chính xác {correctCount}/{questions.length} câu
              </h2>

              <div className={s.statPills}>
                <span className={s.statPill} data-tone="streak">
                  <Flame className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Chuỗi dài nhất: {maxStreak}</span>
                </span>
                <span className={s.statPill} data-tone="good">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{correctCount} đúng</span>
                </span>
                {incorrectQuestions.length > 0 && (
                  <span className={s.statPill} data-tone="miss">
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{incorrectQuestions.length} cần ôn lại</span>
                  </span>
                )}
              </div>
            </div>

            {incorrectQuestions.length > 0 ? (
              <div className={s.reviewSection}>
                <h4 className={s.reviewTitle}>Các từ cần ôn lại ({incorrectQuestions.length})</h4>
                <div className={s.reviewGrid}>
                  {incorrectQuestions.map((q, idx) => (
                    <div key={idx} className={s.reviewCard}>
                      <div className={s.reviewWordRow}>
                        <div className="min-w-0">
                          <span className={`${s.reviewWord} notranslate`} translate="no" lang="en">
                            {q.word}
                          </span>
                          {q.ipa && (
                            <span className={`${s.reviewIpa} notranslate`} translate="no">
                              {q.ipa}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => void playWordAudio(q.word)}
                          className={s.reviewAudio}
                          title="Phát âm"
                          aria-label={`Phát âm “${q.word}”`}
                        >
                          <Volume2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>

                      <div className={s.reviewAnswers}>
                        <span className={s.ansRight}>
                          <Check className="inline h-3.5 w-3.5 mr-1 align-text-bottom" aria-hidden="true" />
                          {q.correctAnswer}
                        </span>
                        {q.userChoice && (
                          <span className={s.ansWrong}>
                            <X className="inline h-3.5 w-3.5 mr-0.5 align-text-bottom" aria-hidden="true" />
                            {q.userChoice}
                          </span>
                        )}
                        {q.timedOut && <span className={s.ansTimeout}>(Hết thời gian)</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className={s.perfectBanner}>
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                <span>Hoàn hảo! Bạn đã trả lời đúng tất cả các câu hỏi.</span>
              </div>
            )}

            <div className={s.summaryFoot}>
              <button type="button" onClick={() => void initQuiz()} className={s.btnSecondary}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                <span>Luyện lại</span>
              </button>
              <button type="button" onClick={onClose} className={s.btnPrimary}>
                Quay về bộ từ
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
