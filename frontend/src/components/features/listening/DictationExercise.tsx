"use client";

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
    Play,
    Pause,
    ChevronLeft,
    ChevronRight,
    Settings,
    AlertTriangle,
    CheckCircle2,
    Bookmark,
    X,
    Volume2,
    RotateCcw,
    Keyboard,
    Languages,
    Eye,
    ChevronDown,
    Gauge
} from 'lucide-react';
import { ExerciseAttemptResponse, ListeningExercise, TranscriptSegment, ListeningSentenceState } from '../../../types/listening';
import { submitExerciseAttempt } from '../../../services/listeningApi';
import { useLanguage } from '@/context/LanguageContext';
import { glass as s, errorLabel } from './glass/ListeningGlass';

/** What one check / reveal of a sentence produced (the server's response, when it answered). */
export interface DictationAttemptOutcome {
    exerciseId: number;
    kind: 'correct' | 'incorrect' | 'revealed';
    /** Order of the attempt in this run: a later attempt always wins over an earlier answer arriving late. */
    seq: number;
    /** null until (or unless) the server answered. */
    response: ExerciseAttemptResponse | null;
}

interface DictationExerciseProps {
    exercise: ListeningExercise;
    segment: TranscriptSegment | null;
    onNext: () => void;
    onPrev?: () => void;
    onReplay?: (repeatCount?: number, replayGap?: number) => void;
    onPlay?: () => void;
    onPause?: () => void;
    isPlaying?: boolean;
    isLast: boolean;
    isFirst?: boolean;
    currentIndex: number;
    totalCount: number;
    repeatCount?: number;
    onRepeatCountChange?: (count: number) => void;
    replayGap?: number;
    onReplayGapChange?: (gap: number) => void;
    activeSessionId?: number | null;
    onSessionCreated?: (sessionId: number) => void;
    onAttemptOutcome?: (outcome: DictationAttemptOutcome) => void;
    savedSentence?: ListeningSentenceState;
    onDraftChange?: (draft: string) => void;
    onOpenPicker?: () => void;
    completedCount?: number;
}

export type HintTokenStatus = 'correct' | 'incorrect' | 'unguessed';

export interface HintToken {
    word: string;
    expectedWord: string;
    status: HintTokenStatus;
}

/**
 * DailyDictation Asterisk Mask Tokenizer & Word Matcher
 * Progressive Unlock Rule:
 * - Words before the first unresolved error: revealed if correct
 * - First unresolved error: hinted/revealed ONLY for this word
 * - ALL words after the first unresolved error: remain masked with '*'
 */
export function getAsteriskMaskHint(userInput: string, expectedText: string) {
    if (!expectedText || !expectedText.trim()) {
        return { hintTokens: [] as HintToken[], matchedCount: 0, totalCount: 0, isAllMatched: false };
    }

    const cleanToken = (t: string) => t.toLowerCase().replace(/^[^\w']+|[^\w']+$/g, '');
    const maskAlpha = (w: string) => w.replace(/[a-zA-Z0-9]/g, '*');

    const expectedWords = expectedText.replace(/\n+/g, ' ').trim().split(/\s+/).filter(Boolean);
    const userWords = userInput.trim().split(/\s+/).filter(Boolean);

    let matchedCount = 0;
    let firstUnresolvedErrorFound = false;

    const hintTokens: HintToken[] = expectedWords.map((expWord, idx) => {
        const expClean = cleanToken(expWord);
        const userWord = userWords[idx];

        // If we already hit the first unresolved error, EVERY subsequent word is masked with '*'
        if (firstUnresolvedErrorFound) {
            return {
                word: maskAlpha(expWord),
                expectedWord: expWord,
                status: 'unguessed'
            };
        }

        // Check if user has provided a word for this position
        if (!userWord) {
            // User hasn't typed anything up to this position yet.
            // Since all previous words were correct, subsequent words remain masked.
            firstUnresolvedErrorFound = true;
            return {
                word: maskAlpha(expWord),
                expectedWord: expWord,
                status: 'unguessed'
            };
        }

        const userClean = cleanToken(userWord);

        // 1. Perfect match: previous words were correct, and this word is correct
        if (userClean && expClean && userClean === expClean) {
            matchedCount++;
            return {
                word: expWord,
                expectedWord: expWord,
                status: 'correct'
            };
        }

        // 2. First unresolved error: previous words were correct, but this word is incorrect/typo
        // Reveal / hint ONLY this current word, then stop revealing any further words
        firstUnresolvedErrorFound = true;
        return {
            word: expWord,
            expectedWord: expWord,
            status: 'incorrect'
        };
    });

    const isAllMatched = matchedCount === expectedWords.length && expectedWords.length > 0;

    return {
        hintTokens,
        matchedCount,
        totalCount: expectedWords.length,
        isAllMatched
    };
}

export const DictationExercise: React.FC<DictationExerciseProps> = ({
    exercise,
    segment,
    onNext,
    onPrev,
    onReplay,
    onPlay,
    onPause,
    isPlaying = false,
    isLast,
    isFirst = false,
    currentIndex,
    totalCount,
    repeatCount = 5,
    onRepeatCountChange,
    replayGap = 0.5,
    onReplayGapChange,
    activeSessionId,
    onSessionCreated,
    onAttemptOutcome,
    savedSentence,
    onDraftChange,
    onOpenPicker,
    completedCount = 0
}) => {
    const { locale } = useLanguage();
    const vi = locale === 'vi';
    const [localSessionId, setLocalSessionId] = useState<number | null>(null);
    const effectiveSessionId = activeSessionId ?? localSessionId;
    const [submissionError, setSubmissionError] = useState<string | null>(null);
    const [answer, setAnswer] = useState(savedSentence?.draft ?? '');
    const [isSuccess, setIsSuccess] = useState(false);
    const [isSkipped, setIsSkipped] = useState(false);
    const [showFeedback, setShowFeedback] = useState(false);
    const [hasSubmitted, setHasSubmitted] = useState(false);
    const [hasSubmittedWrong, setHasSubmittedWrong] = useState(false);
    const [instantHintEnabled, setInstantHintEnabled] = useState(false);
    const [transientHintVisible, setTransientHintVisible] = useState(false);
    // The server's answer to the latest check of THIS sentence (accuracy + primary category, exactly as stored).
    const [recorded, setRecorded] = useState<{ exerciseId: number; seq: number; response: ExerciseAttemptResponse } | null>(null);
    const submitSeqRef = useRef(0);
    const [submitting,setSubmitting]=useState(false);
    const submittingRef=useRef(false);
    const mountedRef=useRef(true);
    useEffect(()=>{mountedRef.current=true;return()=>{mountedRef.current=false;};},[]);

    // Repeat Count and Replay Gap States
    const [localRepeatCount, setLocalRepeatCount] = useState<number>(repeatCount);
    const [localReplayGap, setLocalReplayGap] = useState<number>(replayGap);
    const effectiveRepeatCount = repeatCount ?? localRepeatCount;
    const effectiveReplayGap = replayGap ?? localReplayGap;

    const handleRepeatChange = (val: number) => {
        setLocalRepeatCount(val);
        onRepeatCountChange?.(val);
    };

    const handleGapChange = (val: number) => {
        setLocalReplayGap(val);
        onReplayGapChange?.(val);
    };

    const [showRepeatDropdown, setShowRepeatDropdown] = useState(false);
    const [showGapDropdown, setShowGapDropdown] = useState(false);
    const repeatDropdownRef = useRef<HTMLDivElement>(null);
    const gapDropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (repeatDropdownRef.current && !repeatDropdownRef.current.contains(e.target as Node)) {
                setShowRepeatDropdown(false);
            }
            if (gapDropdownRef.current && !gapDropdownRef.current.contains(e.target as Node)) {
                setShowGapDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const [showFullAnswer, setShowFullAnswer] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [revealedHintWords, setRevealedHintWords] = useState<number>(0);

    // Note System States
    const [note, setNote] = useState('');
    const [tempNote, setTempNote] = useState('');
    const [isNoteModalOpen, setIsNoteModalOpen] = useState(false);

    // Google Translate States
    const [targetLang, setTargetLang] = useState('vi');
    const [translatedText, setTranslatedText] = useState('');
    const [isTranslating, setIsTranslating] = useState(false);

    // Dictionary Popover States
    const [selectedWord, setSelectedWord] = useState<string | null>(null);
    const [dictionaryData, setDictionaryData] = useState<{ uk: string; us: string } | null>(null);
    const [wordTranslation, setWordTranslation] = useState<string>('');
    const [isTranslatingWord, setIsTranslatingWord] = useState(false);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const clickIdRef = useRef(0);

    const expectedSentence = segment?.text || '';
    const expectedWordsList = useMemo(() => {
        return expectedSentence.replace(/\n+/g, ' ').trim().split(/\s+/).filter(Boolean);
    }, [expectedSentence]);

    // Calculate asterisk mask hint based on current answer
    const hintState = useMemo(() => {
        return getAsteriskMaskHint(answer, expectedSentence);
    }, [answer, expectedSentence]);

    const userWordCount = useMemo(() => {
        return answer.trim().split(/\s+/).filter(Boolean).length;
    }, [answer]);

    // Derived visibility for hint/mask area: hidden by default unless instant hint enabled after check or full answer requested
    const showMask = useMemo(() => {
        return (
            (instantHintEnabled && transientHintVisible) ||
            showFullAnswer
        );
    }, [instantHintEnabled, transientHintVisible, showFullAnswer]);

    const translateText = async (lang: string, textToTranslate: string) => {
        if (!textToTranslate.trim() || !lang) return;
        try {
            setIsTranslating(true);
            const url = `/api/translate?tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(textToTranslate)}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error('Translation failed');
            const data = await res.json();
            const rawArray = data.data || data;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = rawArray[0]?.map((item: any) => item[0]).join('') || '';
            setTranslatedText(result);
        } catch (err) {
            console.error('Translation error:', err);
            setTranslatedText('');
        } finally {
            setIsTranslating(false);
        }
    };

    // Auto-translate on success or language change
    useEffect(() => {
        if (isSuccess && expectedSentence) {
            translateText(targetLang, expectedSentence);
        }
    }, [isSuccess, targetLang, expectedSentence]);

    // Close dictionary popover on outside click
    useEffect(() => {
        if (!selectedWord) return;
        const handleDocClick = () => setSelectedWord(null);
        window.addEventListener('click', handleDocClick);
        return () => window.removeEventListener('click', handleDocClick);
    }, [selectedWord]);

    // Reset state whenever moving to a new sentence
    useEffect(() => {
        setAnswer(savedSentence?.draft ?? '');
        setIsSuccess(false);
        setIsSkipped(false);
        setShowFeedback(false);
        setHasSubmitted(false);
        setHasSubmittedWrong(false);
        setTransientHintVisible(false);
        setShowFullAnswer(false);
        setRevealedHintWords(0);
        setSelectedWord(null);
        setDictionaryData(null);
        setWordTranslation('');
        setSubmissionError(null);
        setRecorded(null);
        if (textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [exercise.id, segment?.id, currentIndex]);

    // When the user types or edits: immediately hide instant hint and error feedback
    const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const val = e.target.value;
        setAnswer(val);
        onDraftChange?.(val);
        if (submissionError) setSubmissionError(null);

        // typing / editing / adding space => hide instant hint immediately
        setTransientHintVisible(false);
        setShowFeedback(false);
        setHasSubmitted(false);
        setHasSubmittedWrong(false);
    };

    const handleToggleInstantHint = (enabled: boolean) => {
        setInstantHintEnabled(enabled);
        if (!enabled) {
            setTransientHintVisible(false);
        }
    };

    const playAudioAccent = (word: string, accent: 'uk' | 'us') => {
        const cleanWord = word.replace(/[^a-zA-Z0-9]/g, '');
        if (!cleanWord) return;

        const langCode = accent === 'uk' ? 'en-GB' : 'en-US';
        const audioUrl = `/api/tts?text=${encodeURIComponent(cleanWord)}&lang=${langCode}`;

        const audio = new Audio(audioUrl);
        audio.play().catch(err => console.error("Audio playback failed:", err));
    };

    const handleWordClick = async (word: string) => {
        const cleanWord = word.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        if (!cleanWord) return;

        const myId = ++clickIdRef.current;
        setSelectedWord(cleanWord);
        setWordTranslation('');
        setDictionaryData(null);
        setIsTranslatingWord(true);

        try {
            playAudioAccent(cleanWord, 'us');

            const [dictResult, transResult] = await Promise.allSettled([
                fetch(`/api/dictionary?word=${encodeURIComponent(cleanWord)}`).then(async (res) => {
                    if (!res.ok) throw new Error(`Dict ${res.status}`);
                    return res.json();
                }),
                fetch(`/api/translate?q=${encodeURIComponent(cleanWord)}&tl=${encodeURIComponent(targetLang)}`).then(async (res) => {
                    if (!res.ok) throw new Error(`Translate ${res.status}`);
                    return res.json();
                }),
            ]);

            if (clickIdRef.current !== myId) return;

            if (dictResult.status === 'fulfilled') {
                const dictData = dictResult.value;
                let ukIpa = '';
                let usIpa = '';

                if (Array.isArray(dictData) && dictData.length > 0) {
                    const entry = dictData[0];
                    const phonetics: Array<{ text?: string; audio?: string }> = Array.isArray(entry.phonetics) ? entry.phonetics : [];

                    const ukPhonetic = phonetics.find(p => p.audio && p.audio.includes('-uk.mp3'));
                    if (ukPhonetic?.text?.trim()) ukIpa = ukPhonetic.text.trim();

                    const usPhonetic = phonetics.find(p => p.audio && p.audio.includes('-us.mp3'));
                    if (usPhonetic?.text?.trim()) usIpa = usPhonetic.text.trim();

                    const rootIpa = (entry.phonetic && typeof entry.phonetic === 'string' && entry.phonetic.trim())
                        ? entry.phonetic.trim()
                        : '';

                    let anyIpa = rootIpa;
                    if (!anyIpa) {
                        for (const p of phonetics) {
                            if (p?.text?.trim()) { anyIpa = p.text.trim(); break; }
                        }
                    }

                    if (!ukIpa) ukIpa = anyIpa;
                    if (!usIpa) usIpa = anyIpa;
                }

                setDictionaryData(
                    (ukIpa || usIpa)
                        ? { uk: ukIpa || 'not found', us: usIpa || 'not found' }
                        : null
                );
            } else {
                setDictionaryData(null);
            }

            if (transResult.status === 'fulfilled') {
                const tData = transResult.value;
                const rawArray = tData.data || tData;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const result = rawArray[0]?.map((item: any) => item[0]).join('') || '';
                setWordTranslation(result || cleanWord);
            } else {
                setWordTranslation(cleanWord);
            }

        } catch (outerErr) {
            if (clickIdRef.current === myId) {
                setDictionaryData(null);
                setWordTranslation(cleanWord);
            }
        } finally {
            if (clickIdRef.current === myId) {
                setIsTranslatingWord(false);
            }
        }
    };

    const executeSubmit = async (rawAnswer: string, kind: DictationAttemptOutcome['kind']) => {
        if(submittingRef.current)return;
        submittingRef.current=true;setSubmitting(true);
        setSubmissionError(null);
        const seq = ++submitSeqRef.current;
        const exerciseId = exercise.id;
        // Recorded at once (the learner's action), completed with the server's answer when it arrives.
        const order = Date.now() * 1000 + seq;
        onAttemptOutcome?.({ exerciseId, kind, seq: order, response: null });
        try {
            const res = await submitExerciseAttempt(exerciseId, {
                listeningSessionId: effectiveSessionId ?? undefined,
                rawUserAnswer: rawAnswer
            });
            if (res?.listeningSessionId && !effectiveSessionId) {
                setLocalSessionId(res.listeningSessionId);
                onSessionCreated?.(res.listeningSessionId);
            }
            onAttemptOutcome?.({ exerciseId, kind, seq: order, response: res ?? null });
            if (mountedRef.current && res && kind !== 'revealed' && seq === submitSeqRef.current) {
                setRecorded({ exerciseId, seq, response: res });
            }
        } catch (err: any) {
            console.error("Dictation attempt submission failed:", err);
            const msg = err?.response?.data?.message || (vi ? "Không thể lưu kết quả bài làm. Vui lòng thử lại." : "Failed to save attempt. Please try again.");
            if(mountedRef.current)setSubmissionError(msg);
        } finally {
            submittingRef.current=false;if(mountedRef.current)setSubmitting(false);
        }
    };

    const handleCheck = () => {
        if(submittingRef.current)return;
        setHasSubmitted(true);
        setRecorded(null);
        if (hintState.isAllMatched) {
            setIsSuccess(true);
            setIsSkipped(false);
            setShowFeedback(false);
            setHasSubmittedWrong(false);
            setTransientHintVisible(false);
            executeSubmit(answer.trim() || expectedSentence, 'correct');
        } else {
            setShowFeedback(true);
            setHasSubmittedWrong(true);
            setTransientHintVisible(instantHintEnabled);
            executeSubmit(answer.trim(), 'incorrect');
        }
    };

    const handleSkip = () => {
        if(submittingRef.current)return;
        setShowFullAnswer(true);
        setIsSuccess(true);
        setIsSkipped(true);
        setShowFeedback(false);
        setHasSubmittedWrong(false);
        setHasSubmitted(true);
        setRecorded(null);
        executeSubmit(expectedSentence, 'revealed');
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            onReplay?.(effectiveRepeatCount, effectiveReplayGap);
            return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (isSuccess) {
                onNext();
            } else {
                handleCheck();
            }
        }
    };

    const togglePlayPause = () => {
        if (isPlaying) {
            onPause?.();
        } else {
            onPlay?.();
        }
    };

    const progressPercent = Math.round((completedCount / Math.max(1, totalCount)) * 100);
    const shownRecord = recorded && recorded.exerciseId === exercise.id ? recorded.response : savedSentence?.status !== 'revealed' ? savedSentence?.evaluation : null;
    const accuracyText = (value?: number | null) => (typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 10) / 10}%` : null);

    return (
        <div className={s.console}>
            {/* Console bar: sentence counter, progress, play / pause, shortcuts */}
            <div className={`${s.panel} ${s.consoleBar}`}>
                <div className={s.consoleRow}>
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={onPrev} disabled={isFirst} className={s.iconBtn} title="Câu trước" aria-label="Câu trước">
                            <ChevronLeft size={18} />
                        </button>
                        <button type="button" onClick={onOpenPicker} className={s.sentenceNo} aria-label={vi ? 'Chọn câu' : 'Choose sentence'} aria-haspopup="dialog">
                            <b>Câu {currentIndex + 1}</b>
                            <span>/ {totalCount}</span>
                            <ChevronDown size={13} aria-hidden="true" />
                        </button>
                        <button type="button" onClick={onNext} className={s.iconBtn} title="Câu tiếp theo" aria-label="Câu tiếp theo">
                            <ChevronRight size={18} />
                        </button>
                        <span className={s.meta}>{completedCount}/{totalCount} {vi ? 'đã hoàn thành' : 'completed'}</span>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={togglePlayPause}
                            data-guide="dt-play"
                            className={s.playBtn}
                            title={isPlaying ? "Tạm dừng" : "Phát âm thanh"}
                            aria-label={isPlaying ? "Tạm dừng" : "Phát âm thanh"}
                        >
                            {isPlaying ? <Pause size={17} /> : <Play size={17} className="ml-0.5 fill-current" />}
                        </button>
                        <button
                            type="button"
                            onClick={() => setShowSettings(prev => !prev)}
                            className={s.iconBtn}
                            title="Lối tắt và Cài đặt"
                            aria-label="Lối tắt và Cài đặt"
                            aria-expanded={showSettings}
                        >
                            <Settings size={18} />
                        </button>
                    </div>
                </div>

                {/* Progress through the sentences of this lesson (all sentences, no cap) */}
                <div className={s.progress} role="progressbar" aria-valuemin={0} aria-valuemax={totalCount} aria-valuenow={completedCount} aria-label={vi ? 'Tiến độ các câu' : 'Sentence progress'}>
                    <i style={{ width: `${progressPercent}%` }} />
                </div>

                {showSettings && (
                    <div className={s.shortcuts}>
                        <div className="col-span-full flex items-center gap-1.5 font-bold" style={{ justifyContent: 'flex-start' }}>
                            <Keyboard size={14} aria-hidden="true" />
                            <span>Phím tắt thao tác nhanh:</span>
                        </div>
                        <div><span>Nghe lại đoạn:</span><kbd className={s.kbd}>Tab</kbd></div>
                        <div><span>Kiểm tra / Tiếp:</span><kbd className={s.kbd}>Enter</kbd></div>
                    </div>
                )}
            </div>

            {/* Replay ribbon: replay + repeat count + gap */}
            <div className={`${s.panel} ${s.replay}`}>
                <button
                    type="button"
                    onClick={() => onReplay?.(effectiveRepeatCount, effectiveReplayGap)}
                    className={`${s.btn} ${s.btnPrimary} ${s.replayMain}`}
                    title="Nghe lại câu này"
                >
                    <RotateCcw size={16} aria-hidden="true" />
                    <span>{vi ? 'Nghe lại câu này' : 'Replay'}</span>
                    <kbd className="hidden sm:inline-block ml-1 px-1.5 py-0.5 rounded-md bg-white/20 text-white text-[11px]">Tab</kbd>
                </button>

                <div className={s.dropdown} ref={repeatDropdownRef}>
                    <button
                        type="button"
                        onClick={() => {
                            setShowRepeatDropdown(prev => !prev);
                            setShowGapDropdown(false);
                        }}
                        className={`${s.btn} ${s.btnSoft} ${s.btnSm}`}
                        title="Số lần lặp lại câu"
                        aria-expanded={showRepeatDropdown}
                    >
                        <span>Lặp: {effectiveRepeatCount}x</span>
                        <ChevronDown size={14} aria-hidden="true" className={showRepeatDropdown ? 'rotate-180 transition-transform' : 'transition-transform'} />
                    </button>

                    {showRepeatDropdown && (
                        <div className={s.menu}>
                            <span className={s.menuLabel}>Chọn số lần lặp:</span>
                            <div className={s.menuGrid} style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
                                {[1, 2, 3, 4, 5].map((cnt) => (
                                    <button
                                        key={cnt}
                                        type="button"
                                        aria-pressed={effectiveRepeatCount === cnt}
                                        onClick={() => {
                                            handleRepeatChange(cnt);
                                            setShowRepeatDropdown(false);
                                        }}
                                        className={s.menuOpt}
                                    >
                                        {cnt}x
                                    </button>
                                ))}
                            </div>
                            <label className="flex items-center gap-1.5 pt-1.5" style={{ borderTop: '1px solid var(--well-line)' }}>
                                <span className={s.muted}>Tùy chỉnh:</span>
                                <input
                                    type="number"
                                    min="1"
                                    max="20"
                                    value={effectiveRepeatCount}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value, 10);
                                        if (!isNaN(val) && val >= 1) {
                                            handleRepeatChange(val);
                                        }
                                    }}
                                    className={s.menuNumber}
                                />
                                <span className={s.muted}>lần</span>
                            </label>
                        </div>
                    )}
                </div>

                <div className={s.dropdown} ref={gapDropdownRef}>
                    <button
                        type="button"
                        onClick={() => {
                            setShowGapDropdown(prev => !prev);
                            setShowRepeatDropdown(false);
                        }}
                        className={`${s.btn} ${s.btnSoft} ${s.btnSm}`}
                        title="Khoảng nghỉ giữa các lần lặp"
                        aria-expanded={showGapDropdown}
                    >
                        <span>Khoảng nghỉ: {effectiveReplayGap}s</span>
                        <ChevronDown size={14} aria-hidden="true" className={showGapDropdown ? 'rotate-180 transition-transform' : 'transition-transform'} />
                    </button>

                    {showGapDropdown && (
                        <div className={s.menu}>
                            <span className={s.menuLabel}>Khoảng nghỉ:</span>
                            <div className={s.menuGrid} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                                {[0, 0.25, 0.5, 1, 1.5, 2].map((g) => (
                                    <button
                                        key={g}
                                        type="button"
                                        aria-pressed={effectiveReplayGap === g}
                                        onClick={() => {
                                            handleGapChange(g);
                                            setShowGapDropdown(false);
                                        }}
                                        className={s.menuOpt}
                                    >
                                        {g}s
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {isSuccess ? (
                /* SENTENCE DONE: correct, or the full answer was revealed */
                <div className="flex flex-col gap-4">
                    <div className={`${s.panel} ${s.verdict} ${s.rise}`} data-kind={isSkipped ? 'revealed' : 'correct'} role="status">
                        <div className="flex items-center gap-3 min-w-0">
                            <span className={s.verdictIcon} aria-hidden="true">{isSkipped ? <Eye size={20} /> : <CheckCircle2 size={22} />}</span>
                            <div className="min-w-0">
                                <h3>{isSkipped ? (vi ? 'Đã hiển thị đáp án đầy đủ' : 'Full answer revealed') : (vi ? 'Chính xác!' : 'You are correct!')}</h3>
                                <p>
                                    {isSkipped
                                        ? 'Hãy nghe kỹ lại và quan sát cách phát âm trước khi chuyển câu.'
                                        : 'Bạn đã hoàn thành chính xác câu này! Hãy xem phát âm và bản dịch chi tiết.'}
                                </p>
                                {!isSkipped && accuracyText(shownRecord?.accuracyPercentage) && (
                                    <span className={s.scoreChip}><Gauge size={13} aria-hidden="true" />{vi ? 'Máy chấm ghi nhận' : 'Recorded'}: {accuracyText(shownRecord?.accuracyPercentage)}</span>
                                )}
                            </div>
                        </div>

                        <button type="button" onClick={onNext} className={`${s.btn} ${s.btnPrimary}`}>
                            {isLast ? 'Hoàn thành' : 'Câu tiếp theo'}
                            <ChevronRight size={17} aria-hidden="true" />
                        </button>
                    </div>

                    {submissionError && (
                        <div className={s.notice} data-kind="error" role="alert">
                            <AlertTriangle size={16} aria-hidden="true" />
                            <span>{submissionError}</span>
                        </div>
                    )}

                    {/* The sentence, word by word: tap a word for its pronunciation and dictionary entry */}
                    <div className={`${s.panel} ${s.sentence}`}>
                        <div className={s.sentenceHead}>
                            <span className="inline-flex items-center gap-2">
                                <Volume2 size={16} aria-hidden="true" />
                                Chạm vào từ để nghe phát âm và tra từ điển
                            </span>
                            {onReplay && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        onReplay?.(repeatCount);
                                        setIsSuccess(false);
                                        setIsSkipped(false);
                                        setAnswer('');
                                        onDraftChange?.('');
                                        setShowFeedback(false);
                                        setHasSubmitted(false);
                                        setHasSubmittedWrong(false);
                                        setTransientHintVisible(false);
                                        setShowFullAnswer(false);
                                        setRevealedHintWords(0);
                                        setSelectedWord(null);
                                        setRecorded(null);
                                        setTimeout(() => {
                                            textareaRef.current?.focus();
                                        }, 50);
                                    }}
                                    className={`${s.textLink} inline-flex items-center gap-1`}
                                >
                                    <RotateCcw size={13} aria-hidden="true" /> Thử lại
                                </button>
                            )}
                        </div>

                        <div className={s.words}>
                            {expectedWordsList.map((word, idx) => {
                                const clean = word.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                                const isSelected = selectedWord === clean;
                                return (
                                    <span key={idx} className={s.word} onClick={(e) => e.stopPropagation()}>
                                        <span
                                            role="button"
                                            tabIndex={0}
                                            aria-expanded={isSelected}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleWordClick(word);
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    handleWordClick(word);
                                                }
                                            }}
                                            className={s.wordBtn}
                                        >
                                            {word}
                                        </span>

                                        {isSelected && (
                                            <div onClick={(e) => e.stopPropagation()} className={s.pop} role="dialog" aria-label={clean}>
                                                <div className={s.popHead}>
                                                    <span>{clean}</span>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setSelectedWord(null);
                                                        }}
                                                        className={s.textLink}
                                                        aria-label="Đóng"
                                                    >
                                                        <X size={14} />
                                                    </button>
                                                </div>

                                                <div className={s.popVoices}>
                                                    <button type="button" onClick={(e) => { e.stopPropagation(); playAudioAccent(clean, 'uk'); }} className={s.popVoice}>
                                                        UK <Volume2 size={12} aria-hidden="true" />
                                                    </button>
                                                    <button type="button" onClick={(e) => { e.stopPropagation(); playAudioAccent(clean, 'us'); }} className={s.popVoice}>
                                                        US <Volume2 size={12} aria-hidden="true" />
                                                    </button>
                                                </div>

                                                <div className={s.popIpa}>
                                                    {dictionaryData && (dictionaryData.uk !== 'not found' || dictionaryData.us !== 'not found') ? (
                                                        dictionaryData.uk === dictionaryData.us ? (
                                                            <div>IPA: {dictionaryData.uk.startsWith('/') ? dictionaryData.uk : `/${dictionaryData.uk}/`}</div>
                                                        ) : (
                                                            <>
                                                                <div>UK / {dictionaryData.uk.replace(/^\/|\/$/g, '')} /</div>
                                                                <div>US / {dictionaryData.us.replace(/^\/|\/$/g, '')} /</div>
                                                            </>
                                                        )
                                                    ) : (
                                                        <span className={s.muted}>Chưa có phiên âm IPA</span>
                                                    )}
                                                </div>

                                                <div className={s.popTrans}>
                                                    <small>Bản dịch:</small>
                                                    <div className="font-semibold">
                                                        {isTranslatingWord ? <span className={s.muted}>Đang dịch...</span> : (wordTranslation || '—')}
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </span>
                                );
                            })}
                        </div>
                    </div>

                    {/* Translation of the sentence (explicit, on success only) */}
                    <div className={`${s.panel} ${s.translation}`}>
                        <div className={s.translationHead}>
                            <span className="inline-flex items-center gap-1.5">
                                <Languages size={15} aria-hidden="true" />
                                Bản dịch tiếng Việt
                            </span>
                            <select
                                value={targetLang}
                                onChange={(e) => setTargetLang(e.target.value)}
                                aria-label={vi ? 'Ngôn ngữ dịch' : 'Translation language'}
                            >
                                <option value="vi">{vi ? 'Tiếng Việt' : 'Vietnamese'}</option>
                                <option value="ja">{vi ? 'Tiếng Nhật' : 'Japanese'}</option>
                                <option value="zh-CN">{vi ? 'Tiếng Trung' : 'Chinese'}</option>
                                <option value="ko">{vi ? 'Tiếng Hàn' : 'Korean'}</option>
                                <option value="fr">{vi ? 'Tiếng Pháp' : 'French'}</option>
                                <option value="es">{vi ? 'Tiếng Tây Ban Nha' : 'Spanish'}</option>
                            </select>
                        </div>
                        <p className={s.translationText}>
                            {isTranslating ? (
                                <span className={s.muted}>Đang tải bản dịch...</span>
                            ) : translatedText ? (
                                translatedText
                            ) : (
                                <span className={s.muted}>Chọn ngôn ngữ để dịch</span>
                            )}
                        </p>
                    </div>

                    {/* Personal note (kept on this screen only) */}
                    <div className={`${s.panel} ${s.noteBox}`}>
                        <div className="flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1.5 text-sm font-bold" style={{ color: 'var(--ink-2)' }}>
                                <Bookmark size={15} className="text-amber-500 fill-amber-500" aria-hidden="true" />
                                Ghi chú cá nhân
                            </span>
                            {!note && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setTempNote(note);
                                        setIsNoteModalOpen(true);
                                    }}
                                    className={s.textLink}
                                >
                                    + Thêm ghi chú
                                </button>
                            )}
                        </div>

                        {note && (
                            <div className="flex items-start justify-between gap-3">
                                <p className={`${s.noteText} flex-1`}>{note}</p>
                                <div className="flex items-center gap-3 shrink-0 pt-2">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setTempNote(note);
                                            setIsNoteModalOpen(true);
                                        }}
                                        className={s.textLink}
                                    >
                                        Sửa
                                    </button>
                                    <button type="button" onClick={() => setNote('')} className={s.textLink} data-danger="">
                                        Xóa
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                /* ACTIVE TYPING WORKSPACE */
                <div className="flex flex-col gap-4">
                    <div className={`${s.panel} ${s.answer}`}>
                        <div className={s.answerHead}>
                            <label htmlFor={`dictation-answer-${exercise.id}`} className={s.answerLabel}>
                                Bản chép của bạn
                            </label>
                            <span className={s.answerCount}>
                                {userWordCount} từ đã gõ / ~{expectedWordsList.length} từ
                            </span>
                        </div>

                        <textarea
                            id={`dictation-answer-${exercise.id}`}
                            ref={textareaRef}
                            rows={4}
                            translate="no"
                            data-guide="dt-input"
                            className={`${s.answerField} notranslate`}
                            placeholder="Nhập chính xác những gì bạn nghe được... (bấm Tab để nghe lại)"
                            value={answer}
                            onChange={handleTextChange}
                            onKeyDown={handleKeyDown}
                            autoFocus
                        />

                        <div className={s.answerActions}>
                            <button type="button" disabled={submitting} onClick={handleSkip} className={`${s.btn} ${s.btnSoft}`}>
                                <Eye size={16} aria-hidden="true" />
                                <span>{vi ? 'Bỏ qua' : 'Skip'}</span>
                            </button>

                            <button type="button" disabled={submitting} onClick={handleCheck} data-guide="dt-check" className={`${s.btn} ${s.btnPrimary}`}>
                                <CheckCircle2 size={17} aria-hidden="true" />
                                <span>{vi ? 'Kiểm tra' : 'Check'}</span>
                                <kbd className="hidden sm:inline-block ml-1 px-1.5 py-0.5 rounded-md bg-white/20 text-white text-[11px]">Enter</kbd>
                            </button>
                        </div>

                        {submissionError && (
                            <div className={s.notice} data-kind="error" role="alert">
                                <AlertTriangle size={16} aria-hidden="true" />
                                <span>{submissionError}</span>
                            </div>
                        )}
                    </div>

                    {/* Learner preferences, always reachable */}
                    <div className={s.toggles}>
                        <label className={s.toggle}>
                            <input
                                type="checkbox"
                                checked={instantHintEnabled}
                                onChange={(e) => handleToggleInstantHint(e.target.checked)}
                            />
                            <span>
                                <b>Hiện đáp án ngay</b>
                                <small>Hiện gợi ý đối chiếu sau khi kiểm tra</small>
                            </span>
                        </label>

                        <label className={s.toggle}>
                            <input
                                type="checkbox"
                                checked={showFullAnswer}
                                onChange={(e) => setShowFullAnswer(e.target.checked)}
                            />
                            <span>
                                <b>Hiện toàn bộ đáp án</b>
                                <small>Xem toàn bộ câu tiếng Anh</small>
                            </span>
                        </label>
                    </div>

                    {/* Not yet correct: shown even when the mask is hidden */}
                    {hasSubmittedWrong && (
                        <div className={`${s.notice} ${s.rise}`} data-kind="warn" role="status">
                            <AlertTriangle size={17} aria-hidden="true" />
                            <div>
                                <span className="font-bold text-sm block">Chưa chính xác</span>
                                <span>Hãy nghe lại và thử lại. Bật &quot;Hiện đáp án ngay&quot; nếu bạn muốn xem gợi ý.</span>
                                {shownRecord && accuracyText(shownRecord.accuracyPercentage) && (
                                    <span className={s.scoreChip}>
                                        <Gauge size={13} aria-hidden="true" />
                                        {vi ? 'Máy chấm ghi nhận' : 'Recorded'}: {accuracyText(shownRecord.accuracyPercentage)}
                                        {shownRecord.primaryErrorCategory && shownRecord.primaryErrorCategory !== 'EXACT_MATCH' && ` · ${errorLabel(shownRecord.primaryErrorCategory, vi)}`}
                                    </span>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Word mask: only when the learner asked for hints or the full answer */}
                    {showMask && (
                        <div className={`${s.panel} ${s.mask} ${s.rise}`}>
                            <div className={s.maskHead}>
                                <Eye size={16} aria-hidden="true" />
                                <span>{vi ? 'Định dạng câu và Mặt nạ từ' : 'Sentence Format and Word Mask'}</span>
                            </div>

                            <div className={`${s.maskLine} notranslate`} translate="no">
                                {showFullAnswer ? (
                                    <span className={s.tok} data-s="hint">{expectedSentence}</span>
                                ) : (
                                    hintState.hintTokens.map((token, idx) => {
                                        if (idx < revealedHintWords) {
                                            return <span key={idx} className={s.tok} data-s="hint">{token.expectedWord}</span>;
                                        }
                                        if (showFeedback && token.status === 'correct') {
                                            return <span key={idx} className={s.tok} data-s="correct">{token.expectedWord}</span>;
                                        }
                                        if (showFeedback && token.status === 'incorrect') {
                                            return <span key={idx} className={s.tok} data-s="incorrect" title="Chưa chính xác: Từ mong đợi">{token.expectedWord}</span>;
                                        }
                                        return <span key={idx} className={s.tok} data-s="hidden">{token.word}</span>;
                                    })
                                )}
                            </div>
                            {!showFullAnswer && showFeedback && (
                                <div className={s.legend} aria-hidden="true">
                                    <span><i style={{ background: 'var(--ok)' }} />{vi ? 'Đúng' : 'Correct'}</span>
                                    <span><i style={{ background: 'var(--warn)' }} />{vi ? 'Từ cần sửa (đáp án)' : 'Word to fix (answer)'}</span>
                                    <span><i style={{ background: 'var(--ink-3)' }} />{vi ? 'Chưa mở' : 'Still hidden'}</span>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Note dialog */}
            {isNoteModalOpen && (
                <div className={s.scrim} onClick={() => setIsNoteModalOpen(false)}>
                    <div
                        className={s.dialog}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="dictation-note-title"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => { if (e.key === 'Escape') setIsNoteModalOpen(false); }}
                    >
                        <div className={s.dialogHead}>
                            <span id="dictation-note-title" className="inline-flex items-center gap-2">
                                <Bookmark size={17} className="text-amber-500 fill-amber-500" aria-hidden="true" />
                                Thêm ghi chú cho câu này
                            </span>
                            <button type="button" onClick={() => setIsNoteModalOpen(false)} className={s.iconBtn} aria-label="Đóng">
                                <X size={16} />
                            </button>
                        </div>

                        <textarea
                            value={tempNote}
                            onChange={(e) => setTempNote(e.target.value)}
                            rows={5}
                            className={s.textarea}
                            placeholder="Ghi lại từ mới, ngữ pháp hoặc lưu ý phát âm..."
                            autoFocus
                        />
                        <p className={`${s.muted} text-xs`}>Chỉ bạn mới có thể thấy ghi chú này.</p>

                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setIsNoteModalOpen(false)} className={`${s.btn} ${s.btnGhost} ${s.btnSm}`}>
                                Hủy
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setNote(tempNote);
                                    setIsNoteModalOpen(false);
                                }}
                                className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`}
                            >
                                Lưu ghi chú
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
