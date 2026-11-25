"use client";

import React, { useState, useRef, useEffect } from "react";
import {
    Mic,
    Square,
    Play,
    Pause,
    RotateCcw,
    CheckCircle2,
    AlertCircle,
    Check,
    Edit3,
} from "lucide-react";
import { useAudioRecorder, formatTime } from "@/hooks/useAudioRecorder";
import {
    analyzeQuickCheck,
    recheckQuickCheck,
    QuickCheckResponse,
    PronunciationV2Response,
} from "@/services/speakingApi";
import { PronunciationV2Panel } from "@/components/features/speaking/PronunciationV2Panel";
import { PremiumFeatureBadge } from "@/components/premium/PremiumFeatureBadge";
import styles from "./studio/speakingStudio.module.css";
import { echoSrc } from '@/lib/brand/echoCharacters';

// Heights of the resting ornament beside the microphone (fixed; it is hidden while recording, so it never stands for a level).
const IDLE_BARS = [10, 18, 28, 40, 30, 52, 36, 24, 44, 20, 12];

export interface PushToTalkHubProps {
    onComplete?: () => void;
    className?: string;
}

export function PushToTalkHub({
    onComplete,
    className = "",
}: PushToTalkHubProps) {
    const autoSubmitRef = useRef<() => void>(() => {});

    const {
        state,
        isRecording,
        isReviewing,
        isPlaying,
        duration,
        formattedDuration,
        audioBlob,
        error: recorderError,
        inputLevel,
        isClipping,
        hasSpeechSignal,
        isMeteringActive,
        startRecording,
        stopRecordingAsync,
        reset,
        togglePlayback,
    } = useAudioRecorder({
        maxDurationSeconds: 60,
        assessmentMode: true,
        onMaxDurationReached: () => {
            autoSubmitRef.current();
        },
    });

    const [quickCheckResult, setQuickCheckResult] = useState<QuickCheckResponse | null>(null);
    const [editedTranscript, setEditedTranscript] = useState<string>("");
    const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
    const [isRechecking, setIsRechecking] = useState<boolean>(false);
    const [analysisError, setAnalysisError] = useState<string | null>(null);
    const [currentAttemptId, setCurrentAttemptId] = useState<string | null>(null);
    const [isEditingTranscript, setIsEditingTranscript] = useState<boolean>(false);

    // Track active request to prevent stale async responses and duplicate uploads
    const activeAttemptIdRef = useRef<string | null>(null);
    const durationRef = useRef<number>(duration);
    const hasSpeechSignalRef = useRef<boolean>(hasSpeechSignal);
    const isMeteringActiveRef = useRef<boolean>(isMeteringActive);
    useEffect(() => {
        durationRef.current = duration;
    }, [duration]);
    useEffect(() => {
        hasSpeechSignalRef.current = hasSpeechSignal;
    }, [hasSpeechSignal]);
    useEffect(() => {
        isMeteringActiveRef.current = isMeteringActive;
    }, [isMeteringActive]);

    // Initial / reset handler ("Thu lại")
    const handleResetAll = () => {
        activeAttemptIdRef.current = null;
        reset();
        setQuickCheckResult(null);
        setEditedTranscript("");
        setIsAnalyzing(false);
        setIsRechecking(false);
        setAnalysisError(null);
        setCurrentAttemptId(null);
        setIsEditingTranscript(false);
    };

    // Start recording from empty state
    const handleStartRecording = async () => {
        handleResetAll();
        try {
            await startRecording();
        } catch {
            setAnalysisError("Không thể truy cập microphone. Vui lòng kiểm tra quyền thu âm và thử lại.");
        }
    };

    // Stop recording (or submit already-stopped REVIEWING blob) and trigger canonical Quick Check pipeline
    const handleStopAndAnalyze = async (fromAutoStop = false) => {
        if ((!isRecording && !isReviewing && !fromAutoStop) || isAnalyzing || activeAttemptIdRef.current) return;

        setAnalysisError(null);
        setIsAnalyzing(true);

        const attemptId = `qc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        setCurrentAttemptId(attemptId);
        activeAttemptIdRef.current = attemptId;

        try {
            const blob = isRecording || fromAutoStop ? await stopRecordingAsync() : audioBlob;
            if (activeAttemptIdRef.current !== attemptId) return;

            if (!blob || blob.size === 0) {
                setAnalysisError("Chưa thu được âm thanh. Hãy thử nói lại rõ hơn.");
                return;
            }

            if (durationRef.current > 0 && durationRef.current < 0.4) {
                setAnalysisError("Bản thu quá ngắn (dưới 0,4 giây). Hãy nói rõ ít nhất một cụm từ rồi thử lại.");
                return;
            }

            if (isMeteringActiveRef.current && !hasSpeechSignalRef.current) {
                setAnalysisError("Chưa nghe thấy tín hiệu giọng nói từ micro. Hãy kiểm tra micro không bị tắt tiếng và nói rõ hơn.");
                return;
            }

            // Exactly ONE Whisper STT + Pronunciation Engine + Llama structured check
            const result = await analyzeQuickCheck(blob, attemptId);

            // Guard against stale async responses
            if (activeAttemptIdRef.current !== attemptId) {
                return;
            }

            setQuickCheckResult(result);
            const transcript = result.intendedTranscript || result.whisperTranscript || "";
            setEditedTranscript(transcript);

            if (result.sttStatus !== "SUCCESS") {
                setAnalysisError("Chưa nhận diện được câu nói. Hãy thử nói lại rõ hơn.");
            } else {
                onComplete?.();
            }
        } catch (err: any) {
            if (activeAttemptIdRef.current === attemptId) {
                console.error("Quick Check analysis failed", err);
                const status = err?.response?.status;
                if (status === 422) {
                    setAnalysisError("Không nhận diện được lời nói rõ ràng trong bản thu. Vui lòng nói to, rõ hơn và thử lại.");
                } else {
                    setAnalysisError("Chưa thể phân tích lúc này. Vui lòng thử lại.");
                }
            }
        } finally {
            if (activeAttemptIdRef.current === attemptId) {
                activeAttemptIdRef.current = null;
                setIsAnalyzing(false);
            }
        }
    };

    useEffect(() => {
        autoSubmitRef.current = () => {
            void handleStopAndAnalyze(true);
        };
    });

    // Recheck with edited transcript (reuses same audio, 0 Whisper calls)
    const handleRecheckEdited = async () => {
        if (!currentAttemptId || !editedTranscript.trim() || isRechecking || isAnalyzing) return;

        setIsRechecking(true);
        setAnalysisError(null);

        try {
            const updated = await recheckQuickCheck(currentAttemptId, editedTranscript.trim());
            setQuickCheckResult(updated);
            setEditedTranscript(updated.intendedTranscript || updated.whisperTranscript || editedTranscript);
            setIsEditingTranscript(false);
            onComplete?.();
        } catch (err: any) {
            console.error("Quick Check recheck failed", err);
            setAnalysisError("Chưa thể phân tích lúc này. Vui lòng thử lại.");
        } finally {
            setIsRechecking(false);
        }
    };

    const originalTranscript = (quickCheckResult?.intendedTranscript || quickCheckResult?.whisperTranscript || "").trim();
    const isTranscriptChanged = editedTranscript.trim() !== "" && editedTranscript.trim() !== originalTranscript;


    return (
        <div
            className={`${styles.quickPanel} ${className}`}
            role="region"
            aria-label="Quick Check"
        >
            <span className={styles.quickOrb} aria-hidden="true" />
            {/* Header: Clean & Focused */}
            <div className={styles.quickHead}>
                <div className="flex flex-wrap items-center gap-2">
                    <span className={styles.quickTag}>
                        <img src={echoSrc('social', 24)} alt="" aria-hidden="true" />
                        <span>Quick Check</span>
                    </span>
                    <PremiumFeatureBadge featureKey="SPEAKING_QUICK_CHECK" />
                </div>
                <h2 className={styles.quickTitle}>Quick Check</h2>
                <p className={styles.quickText}>
                    Nói một câu bất kỳ bằng tiếng Anh. English Coach sẽ nhận diện câu bạn nói, kiểm tra phát âm và xem cách diễn đạt có tự nhiên hay không.
                </p>
            </div>

            {/* ── 1. EMPTY INITIAL STATE ── */}
            {state === "IDLE" && !quickCheckResult && !isAnalyzing && (
                <div className={styles.stage}>
                    <div className={styles.micWrap}>
                        {/* ornament only: the same fixed bars at rest, gone while recording (never a level meter) */}
                        <div className={styles.bars} aria-hidden="true">
                            {[0, 1].map((side) => (
                                <span key={side}>
                                    {(side === 0 ? IDLE_BARS : [...IDLE_BARS].reverse()).map((h, i) => (
                                        <i key={i} style={{ height: `${h}px`, animationDelay: `${(i % 5) * -0.45}s` }} />
                                    ))}
                                </span>
                            ))}
                        </div>
                        <button
                            type="button"
                            onClick={handleStartRecording}
                            className={styles.mic}
                            aria-label="Nhấn để nói"
                            data-testid="quick-check-start"
                        >
                            <Mic />
                        </button>
                    </div>
                    <div className={styles.micLabel}>
                        <strong>Nhấn để nói</strong>
                        <span>Nói bất kỳ câu tiếng Anh nào bạn vừa nghĩ đến</span>
                    </div>
                </div>
            )}

            {/* ── 2. RECORDING STATE ── */}
            {isRecording && (
                <div className={styles.stage} role="status" aria-live="polite">
                    <div className={styles.micWrap}>
                        <span className={styles.recordRing} aria-hidden="true" />
                        <span className={styles.recordRing} aria-hidden="true" />
                        <span className={styles.recordRing} aria-hidden="true" />
                        <div className={styles.recordOrb} aria-hidden="true">
                            <Mic />
                        </div>
                    </div>

                    <div className={styles.micLabel}>
                        <div className={styles.clock}>{formattedDuration}</div>
                        <span className={styles.recDot}>Đang ghi âm — đang lắng nghe câu nói của bạn...</span>
                    </div>

                    {/* Live microphone level meter */}
                    <div className="w-full max-w-xs space-y-1">
                        <div className="h-2 w-full rounded-full bg-slate-200/80 dark:bg-white/10 overflow-hidden">
                            <div
                                className={`h-full transition-all duration-75 rounded-full ${
                                    isClipping
                                        ? "bg-rose-500"
                                        : inputLevel > 0.12
                                        ? "bg-emerald-500"
                                        : "bg-indigo-400"
                                }`}
                                style={{ width: `${Math.max(4, Math.round(inputLevel * 100))}%` }}
                            />
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                            <span>{hasSpeechSignal ? "Đã nhận tín hiệu giọng nói" : "Đang chờ giọng nói..."}</span>
                            {isClipping && (
                                <span className="font-semibold text-rose-600 dark:text-rose-400">
                                    Âm lượng quá lớn (vỡ tiếng)
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Actions: Stop and cancel */}
                    <div className="flex items-center gap-3 pt-1">
                        <button type="button" onClick={handleResetAll} className={styles.soft}>
                            Hủy
                        </button>
                        <button type="button" onClick={() => void handleStopAndAnalyze(false)} className={`${styles.primary} ${styles.stopBtn}`}>
                            <Square className="fill-current" />
                            <span>Xong và Chấm điểm</span>
                        </button>
                    </div>
                </div>
            )}

            {/* ── 2b. REVIEWING STATE (e.g. if submission failed or stopped before upload) ── */}
            {isReviewing && !quickCheckResult && !isAnalyzing && (
                <div className={styles.stage}>
                    <div className={styles.micLabel}>
                        <div className={styles.clock}>{formattedDuration}</div>
                        <strong>Bản thu âm đã sẵn sàng</strong>
                        <span>Nghe lại hoặc gửi chấm điểm ngay</span>
                    </div>
                    {isClipping && (
                        <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                            Cảnh báo: Bản thu có dấu hiệu vỡ tiếng. Bạn nên đặt micro xa hơn nếu cần thu lại.
                        </p>
                    )}
                    <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
                        <button type="button" onClick={togglePlayback} className={styles.soft}>
                            {isPlaying ? <Pause /> : <Play className="fill-current" />}
                            <span>{isPlaying ? "Tạm dừng" : "Nghe lại"}</span>
                        </button>
                        <button type="button" onClick={handleResetAll} className={styles.soft}>
                            <RotateCcw />
                            <span>Thu lại</span>
                        </button>
                        <button type="button" onClick={() => void handleStopAndAnalyze(false)} className={styles.primary}>
                            <Check />
                            <span>Chấm điểm bản thu</span>
                        </button>
                    </div>
                </div>
            )}

            {/* ── 3. PROCESSING STATE ── */}
            {isAnalyzing && (
                <div className={styles.stage} role="status" aria-live="polite">
                    <div className={styles.processing}>
                        <img src={echoSrc('social', 24)} alt="" aria-hidden="true" />
                    </div>
                    <div className={styles.micLabel}>
                        <strong>Đang nhận diện giọng nói và phân tích đa chiều...</strong>
                        <span>Whisper STT • Pronunciation Engine • Llama Language Check</span>
                    </div>
                </div>
            )}

            {/* ── ERROR ALERT BANNER ── */}
            {(analysisError || recorderError) && !isAnalyzing && (
                <div className={styles.alert} role="alert">
                    <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{analysisError || recorderError || "Không thể thu âm. Vui lòng kiểm tra microphone và thử lại."}</span>
                    </div>
                    <button
                        type="button"
                        onClick={handleResetAll}
                        className="font-bold underline shrink-0 cursor-pointer"
                    >
                        Thu lại
                    </button>
                </div>
            )}

            {/* ── 4. CANONICAL RESULT UI (4 Vertical Sections + Audio UX) ── */}
            {quickCheckResult && quickCheckResult.sttStatus === "SUCCESS" && !isAnalyzing && (
                <div className={`${styles.results} animate-in fade-in slide-in-from-bottom-3 duration-300`}>
                    {/* Audio UX: Nghe lại & Thu lại */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <button type="button" onClick={togglePlayback} className={styles.soft}>
                            {isPlaying ? <Pause /> : <Play className="fill-current" />}
                            <span>{isPlaying ? "Tạm dừng" : "Nghe lại"}</span>
                        </button>
                        <button type="button" onClick={handleResetAll} className={styles.soft}>
                            <RotateCcw />
                            <span>Thu lại câu khác</span>
                        </button>
                    </div>

                    {/* SECTION 1: English Coach nghe được */}
                    <section className={`${styles.well} space-y-3`} aria-labelledby="recognized-transcript-title">
                        <div className="flex items-center justify-between gap-2">
                            <span id="recognized-transcript-title" className={styles.sectionLabel}>
                                <img src={echoSrc('social', 24)} alt="" aria-hidden="true" />
                                <span>English Coach nghe được</span>
                            </span>
                            <a className="text-xs font-semibold underline" href="/knowledge-universe?focus=con%3Asrc%3ASPEAKING">Xem trong vũ trụ</a>
                            {!isEditingTranscript && (
                                <button
                                    type="button"
                                    onClick={() => setIsEditingTranscript(true)}
                                    className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-300 hover:underline cursor-pointer"
                                >
                                    <Edit3 className="w-3 h-3" />
                                    <span>Sửa transcript</span>
                                </button>
                            )}
                        </div>

                        {/* Editable transcript textarea */}
                        <div className="space-y-2">
                            <textarea
                                value={editedTranscript}
                                onChange={(e) => {
                                    setEditedTranscript(e.target.value);
                                    if (!isEditingTranscript) setIsEditingTranscript(true);
                                }}
                                maxLength={500}
                                rows={2}
                                aria-label="English Coach nghe được"
                                className="w-full text-base font-bold text-gray-900 dark:text-white bg-white dark:bg-slate-950/60 border border-indigo-200 dark:border-indigo-800/60 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 leading-relaxed resize-none"
                                placeholder="Nội dung câu nói bạn vừa ghi âm..."
                            />

                            {/* Recheck action button when learner edited transcript */}
                            {isTranscriptChanged && (
                                <div className="flex flex-wrap items-center justify-between gap-3 pt-1 animate-in fade-in duration-200">
                                    <span className="text-[11px] text-gray-500 dark:text-gray-400 italic">
                                        Đã sửa transcript • Không cần thu âm lại
                                    </span>
                                    <button
                                        type="button"
                                        onClick={handleRecheckEdited}
                                        disabled={isRechecking || !editedTranscript.trim()}
                                        className={styles.primary}
                                    >
                                        {isRechecking ? (
                                            <>
                                                <img src={echoSrc('social', 24)} alt="" aria-hidden="true" className="w-3.5 h-3.5 object-contain animate-pulse" />
                                                <span>Đang chấm lại...</span>
                                            </>
                                        ) : (
                                            <>
                                                <Check />
                                                <span>Chấm lại theo câu đã sửa</span>
                                            </>
                                        )}
                                    </button>
                                </div>
                            )}
                        </div>
                    </section>

                    {/* SECTION 2: Phát âm (Real Pronunciation V2.2, NO "Khớp nội dung") */}
                    <section aria-label="Đánh giá phát âm" className="space-y-3">
                        <h3 className={styles.sectionLabel}>Phát âm (Pronunciation Engine V2.2)</h3>

                        {quickCheckResult.pronunciationStatus === "SUCCESS" && quickCheckResult.pronunciation ? (
                            <PronunciationV2Panel
                                response={quickCheckResult.pronunciation}
                                hideContentMatch={true}
                                onRetryRecording={handleResetAll}
                            />
                        ) : quickCheckResult.pronunciationStatus === "SUCCESS" && quickCheckResult.overallScore != null ? (
                            <div className={`${styles.well} space-y-4`}>
                                <div className="flex items-center justify-between pb-3 border-b border-gray-200/60 dark:border-white/10">
                                    <span className="text-sm font-bold">Điểm phát âm tổng thể</span>
                                    <span className="text-2xl font-black text-indigo-600 dark:text-indigo-300">
                                        {Math.round(quickCheckResult.overallScore)} <span className="text-xs text-gray-400 font-normal">/ 100</span>
                                    </span>
                                </div>
                                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center text-xs">
                                    {[
                                        ["Âm vị", quickCheckResult.phonemeScore],
                                        ["Trọng âm", quickCheckResult.stressScore],
                                        ["Ngữ điệu", quickCheckResult.pitchScore],
                                        ["Nhịp điệu", quickCheckResult.rhythmScore],
                                        ["Trôi chảy", quickCheckResult.fluencyScore],
                                    ].map(([label, value], i) => (
                                        <div key={String(label)} className={`p-2 rounded-xl bg-white/80 dark:bg-white/5 ring-1 ring-black/5 dark:ring-white/10 ${i === 4 ? "col-span-2 sm:col-span-1" : ""}`}>
                                            <div className="text-[10px] text-gray-500 dark:text-gray-400 font-semibold">{label}</div>
                                            <div className="text-sm font-bold mt-0.5">
                                                {typeof value === "number" && Number.isFinite(value) ? Math.round(value) : "—"}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/40 text-xs text-amber-900 dark:text-amber-200">
                                {quickCheckResult.pronunciationError || "Đã nhận diện câu nói nhưng chưa thể phân tích phát âm."}
                            </div>
                        )}
                    </section>

                    {/* SECTION 3: Cách diễn đạt (Llama 3.1 Language Check) */}
                    <section className={`${styles.well} space-y-3`} aria-labelledby="language-check-title">
                        <span id="language-check-title" className={styles.sectionLabel}>
                            Cách diễn đạt
                        </span>

                        {quickCheckResult.languageStatus === "SUCCESS" && quickCheckResult.languageFeedback ? (
                            <div className="space-y-3">
                                {quickCheckResult.languageFeedback.corrections.length === 0 ? (
                                    <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/60 dark:border-emerald-900/40 text-emerald-800 dark:text-emerald-200 text-xs font-bold">
                                        <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                                        <span>Câu này đúng và tự nhiên.</span>
                                        {quickCheckResult.languageFeedback.positiveFeedback && (
                                            <span className="font-normal text-emerald-700 dark:text-emerald-300">
                                                — {quickCheckResult.languageFeedback.positiveFeedback}
                                            </span>
                                        )}
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        <div className="text-xs font-bold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                                            <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                                            <span>Cần chỉnh một chút</span>
                                        </div>

                                        <div className="space-y-2.5">
                                            {quickCheckResult.languageFeedback.corrections.map((corr, idx) => (
                                                <div
                                                    key={idx}
                                                    className="p-3.5 rounded-xl bg-white/80 dark:bg-white/[0.04] ring-1 ring-black/5 dark:ring-white/10 space-y-1.5 text-xs"
                                                >
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className="text-gray-500 dark:text-gray-400 font-semibold">Gốc:</span>
                                                        <span className="line-through text-rose-600 dark:text-rose-400 font-medium">
                                                            &ldquo;{corr.original}&rdquo;
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className="text-emerald-700 dark:text-emerald-300 font-bold">Nên dùng:</span>
                                                        <span className="font-bold text-emerald-600 dark:text-emerald-400">
                                                            &ldquo;{corr.suggestion}&rdquo;
                                                        </span>
                                                    </div>
                                                    {corr.explanationVi && (
                                                        <div className="text-gray-600 dark:text-gray-300 pt-1 border-t border-gray-200/40 dark:border-white/10 leading-relaxed">
                                                            <span className="font-semibold text-gray-500">Giải thích: </span>
                                                            {corr.explanationVi}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                                {quickCheckResult.languageError || "Chưa thể phân tích cách diễn đạt lúc này. Vui lòng thử lại."}
                            </div>
                        )}
                    </section>

                    {/* SECTION 4: Cách nói tự nhiên hơn (Only shown if model returns a meaningful alternative) */}
                    {quickCheckResult.languageStatus === "SUCCESS" && quickCheckResult.languageFeedback?.naturalVersion &&
                        quickCheckResult.languageFeedback.naturalVersion.trim().toLowerCase() !==
                            originalTranscript.toLowerCase() && (
                            <section
                                className={`${styles.well} space-y-2`}
                                data-tone="talk"
                                aria-labelledby="natural-version-title"
                            >
                                <span id="natural-version-title" className={styles.sectionLabel}>
                                    <img src={echoSrc('social', 24)} alt="" aria-hidden="true" />
                                    <span>Cách nói tự nhiên hơn</span>
                                </span>
                                <p className="text-sm sm:text-base font-bold leading-relaxed">
                                    &ldquo;{quickCheckResult.languageFeedback.naturalVersion}&rdquo;
                                </p>
                                {quickCheckResult.languageFeedback.meaningNoteVi && (
                                    <p className="text-xs text-purple-800/80 dark:text-purple-200/80 italic pt-1 border-t border-purple-200/40 dark:border-white/10">
                                        {quickCheckResult.languageFeedback.meaningNoteVi}
                                    </p>
                                )}
                            </section>
                        )}
                </div>
            )}
        </div>
    );
}
