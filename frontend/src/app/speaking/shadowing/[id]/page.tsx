"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import {
    ArrowLeft,
    Loader2,
    CheckCircle2,
    RotateCcw,
    Headphones,
    ChevronLeft,
    ChevronRight,
    Trophy,
    Play,
    Pause,
    Mic,
    Square,
    AlertCircle,
    Radio,
} from "lucide-react";
import { getListeningMaterialById } from "@/services/listeningApi";
import { ListeningMaterialDetail } from "@/types/listening";
import {
    SpeakingSessionResponse,
    SpeakingShadowingUnit,
    getShadowingUnits,
    analyzeShadowingAudio,
    ShadowingAnalysisResponse,
    EcsmAnalysisResponse,
    EcsmPrimaryTarget,
    EcsmDrillPlan,
    recordShadowingAttempt,
    getMaterialShadowingProgress,
    ShadowingSegmentProgress,
    getOrCreateActiveShadowingSession,
    advanceShadowingSession,
    PronunciationV2Response,
} from "@/services/speakingApi";
import { AdvancedAudioPlayer, AdvancedAudioPlayerRef } from "@/components/features/listening/AdvancedAudioPlayer";
import { SentenceNavigator, UnitProgressInfo } from "@/components/features/speaking/SentenceNavigator";
import { StudioBackdrop } from "@/components/features/speaking/studio/SpeakingArt";
import studio from "@/components/features/speaking/studio/speakingStudio.module.css";
import sx from "@/components/features/speaking/studio/speakingSession.module.css";
import { ShadowingActiveSentence } from "@/components/features/speaking/ShadowingActiveSentence";
import { ShadowingYouSaidPanel } from "@/components/features/speaking/ShadowingYouSaidPanel";
import { EcsmFeedbackPanel } from "@/components/features/speaking/EcsmFeedbackPanel";
import { PronunciationV2Panel } from "@/components/features/speaking/PronunciationV2Panel";
import { useAudioRecorder, formatTime } from "@/hooks/useAudioRecorder";
import { Button } from "@/components/ui/button";
import { echoSrc } from '@/lib/brand/echoCharacters';
import { useContentTitle } from '@/lib/brand/tabTitle';

export default function ShadowingStudioPage() {
    const params = useParams();
    const router = useRouter();

    const id = typeof params?.id === "string" ? parseInt(params.id, 10) : null;

    const [material, setMaterial] = useState<ListeningMaterialDetail | null>(null);
    useContentTitle(material?.title);
    const [units, setUnits] = useState<SpeakingShadowingUnit[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [currentIndex, setCurrentIndex] = useState(0);
    const [session, setSession] = useState<SpeakingSessionResponse | null>(null);
    const [isFinished, setIsFinished] = useState(false);
    const [isAudioPlaying, setIsAudioPlaying] = useState(false);
    const [playbackRate, setPlaybackRate] = useState<number>(1.0);
    const [repeatCount, setRepeatCount] = useState<number>(() => {
        if (typeof window !== "undefined") {
            try {
                const saved = sessionStorage.getItem("shadowing_repeat_preference");
                if (saved === "Infinity" || saved === "inf") return Infinity;
                const num = Number(saved);
                if ([1, 2, 3].includes(num)) return num;
            } catch {}
        }
        return 1;
    });

    // Unit progress map: key is unitId
    const [progressMap, setProgressMap] = useState<Record<number, UnitProgressInfo>>({});

    // Current Unit Attempt & Analysis State
    const [analysisResult, setAnalysisResult] = useState<ShadowingAnalysisResponse | null>(null);
    const [pronunciationV2Result, setPronunciationV2Result] = useState<PronunciationV2Response | null>(null);
    const [ecsmResult, setEcsmResult] = useState<EcsmAnalysisResponse | null>(null);
    const [activeTarget, setActiveTarget] = useState<EcsmPrimaryTarget | null>(null);
    const [parentAttemptId, setParentAttemptId] = useState<string | null>(null);
    const [lastAttemptId, setLastAttemptId] = useState<string | null>(null);
    const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
    const [recordedAudioDuration, setRecordedAudioDuration] = useState<number>(0);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [finishedElapsedSec, setFinishedElapsedSec] = useState<number>(0);

    // Audio Recorder Hook
    const {
        state: recorderState,
        isRecording,
        isReviewing,
        isProcessing,
        isPlaying: isReviewPlaying,
        duration: recordedDuration,
        formattedDuration,
        playbackCurrentTime,
        playbackDuration,
        playbackProgress,
        audioBlob,
        error: recorderError,
        inputLevel,
        isClipping,
        hasSpeechSignal,
        isMeteringActive,
        startRecording,
        stopRecording,
        cancelRecording,
        reset: resetRecorder,
        setProcessing,
        togglePlayback: toggleReviewPlayback,
        seekPlayback: seekReviewPlayback,
    } = useAudioRecorder({
        maxDurationSeconds: 60,
        resetKey: `${id ?? "shadowing"}:${currentIndex}`,
        assessmentMode: true,
    });

    const playerRef = useRef<AdvancedAudioPlayerRef>(null);
    const startTimeRef = useRef<number>(Date.now());
    const sessionIdRef = useRef<number | null>(null);
    const playbackPermissionRef = useRef<boolean>(false);
    const lastUnitIndexRef = useRef<number | null>(null);
    const activeAttemptIdRef = useRef<string | null>(null);
    const activeUnitIdRef = useRef<number | null>(null);
    const analysisAbortRef = useRef<AbortController | null>(null);
    const submittingRef = useRef<boolean>(false);
    const recordedAudioUrlRef = useRef<string | null>(null);
    const pendingSaveAttemptRef = useRef<{
        clientAttemptId: string;
        unitId: number;
        blob: Blob;
        durationSec: number;
        analysis: ShadowingAnalysisResponse;
    } | null>(null);
    const unitGenerationRef = useRef(0);
    const segmentGenerationRef = useRef(0);

    // Safe recording trigger: immediately pauses and silences reference media, revokes playback permission
    const handleStartRecording = async () => {
        unitGenerationRef.current += 1;
        analysisAbortRef.current?.abort();
        analysisAbortRef.current = null;
        submittingRef.current = false;
        pendingSaveAttemptRef.current = null;
        activeAttemptIdRef.current = null;
        activeUnitIdRef.current = null;
        setSubmitError(null);
        setAnalysisResult(null);
        setPronunciationV2Result(null);
        setEcsmResult(null);
        setLastAttemptId(null);
        playbackPermissionRef.current = false;
        if (playerRef.current) {
            try {
                playerRef.current.clearLoop();
                playerRef.current.pause();
            } catch {}
        }
        await startRecording();
    };

    // 1. Initialize Lesson, Units & Session from Database with Full Hydration
    useEffect(() => {
        if (!id) return;
        let isMounted = true;
        unitGenerationRef.current += 1;
        analysisAbortRef.current?.abort();
        analysisAbortRef.current = null;
        activeAttemptIdRef.current = null;
        activeUnitIdRef.current = null;
        setMaterial(null);
        setUnits([]);
        setSession(null);
        setCurrentIndex(0);
        setProgressMap({});
        setAnalysisResult(null);
        setPronunciationV2Result(null);
        setEcsmResult(null);
        setActiveTarget(null);
        setParentAttemptId(null);
        setLastAttemptId(null);
        setSubmitError(null);
        setLoading(true);

        Promise.all([
            getListeningMaterialById(id),
            getShadowingUnits(id),
            getOrCreateActiveShadowingSession(id),
            getMaterialShadowingProgress(id).catch(() => [] as ShadowingSegmentProgress[]),
        ])
            .then(([matData, unitsData, sessionState, initialProgress]) => {
                if (isMounted) {
                    setMaterial(matData);
                    setUnits(unitsData);
                    setSession({
                        id: sessionState.sessionId,
                        mode: sessionState.mode,
                        status: sessionState.status,
                        durationSeconds: 0,
                        createdAt: sessionState.createdAt || new Date().toISOString(),
                    });
                    sessionIdRef.current = sessionState.sessionId;

                    // Rehydrate durable current unit index from backend
                    const hydratedIndex = sessionState.currentUnitIndex != null
                        && sessionState.currentUnitIndex >= 0
                        && sessionState.currentUnitIndex < unitsData.length
                        ? sessionState.currentUnitIndex
                        : 0;
                    setCurrentIndex(hydratedIndex);

                    // Attempt diagnostics are intentionally not hydrated into
                    // the active card. They must be produced by a real
                    // recording for the currently selected unit; otherwise a
                    // previous session/unit can leak Primary Focus and retry
                    // state into a fresh sentence. Durable progress below is
                    // still restored for the navigator.
                    setAnalysisResult(null);
                    setPronunciationV2Result(null);
                    setEcsmResult(null);
                    setActiveTarget(null);
                    setParentAttemptId(null);
                    setLastAttemptId(null);

                    // Populate existing practiced progress
                    const pMap: Record<number, UnitProgressInfo> = {};
                    if (Array.isArray(unitsData)) {
                        unitsData.forEach((u) => {
                            pMap[u.id] = {
                                attemptCount: u.attemptCount || 0,
                                bestAccuracy: u.bestAccuracy,
                                isPracticed: u.isPracticed || (u.attemptCount || 0) > 0,
                            };
                        });
                    }
                    if (sessionState.unitStates) {
                        Object.entries(sessionState.unitStates).forEach(([uIdStr, state]) => {
                            const uId = Number(uIdStr);
                            if (uId) {
                                pMap[uId] = {
                                    attemptCount: Math.max(pMap[uId]?.attemptCount || 0, 1),
                                    bestAccuracy: pMap[uId]?.bestAccuracy,
                                    isPracticed: true,
                                };
                            }
                        });
                    }
                    if (Array.isArray(initialProgress)) {
                        initialProgress.forEach((p) => {
                            const uId = p.unitId || p.segmentId;
                            if (uId) {
                                pMap[uId] = {
                                    attemptCount: Math.max(pMap[uId]?.attemptCount || 0, p.attemptCount || 0),
                                    bestAccuracy: p.bestAccuracy ?? pMap[uId]?.bestAccuracy,
                                    isPracticed: (p.attemptCount || 0) > 0 || pMap[uId]?.isPracticed,
                                };
                            }
                        });
                    }
                    setProgressMap(pMap);
                    setLoading(false);
                }
            })
            .catch((err) => {
                console.error("Failed to initialize Shadowing Studio:", err);
                if (isMounted) {
                    setError("Không thể tải dữ liệu bài nghe hoặc khởi tạo câu luyện tập Shadowing.");
                    setLoading(false);
                }
            });

        return () => {
            isMounted = false;
            unitGenerationRef.current += 1;
            analysisAbortRef.current?.abort();
            analysisAbortRef.current = null;
        };
    }, [id]);

    const currentUnit: SpeakingShadowingUnit | null = units[currentIndex] || null;
    const isFirst = currentIndex === 0;
    const isLast = currentIndex === units.length - 1;

    // 2. Loop current unit audio with discrete repeat count & explicit playback intent check
    const loopCurrentUnit = useCallback((explicitIntent: boolean = false) => {
        if (isRecording) return;
        if (explicitIntent) {
            playbackPermissionRef.current = true;
        }
        if (!playbackPermissionRef.current) return;
        if (currentUnit && playerRef.current) {
            const startSec = currentUnit.startTimeMs / 1000;
            const endSec = currentUnit.endTimeMs / 1000;
            playerRef.current.setLoop(startSec, endSec, true, repeatCount, 0);
        }
    }, [currentUnit, isRecording, repeatCount]);

    const handleSetRepeatCount = useCallback((count: number) => {
        setRepeatCount(count);
        if (typeof window !== "undefined") {
            try {
                sessionStorage.setItem("shadowing_repeat_preference", count.toString());
            } catch {}
        }

        // Changing the mode starts a fresh segment sequence. Preserve an
        // intentional pause, but keep the segment boundary configured so a
        // subsequent native YouTube Play cannot escape into the full video.
        if (!currentUnit || isRecording || !playerRef.current) return;
        const wasPlaying = isAudioPlaying;
        const startSec = currentUnit.startTimeMs / 1000;
        const endSec = currentUnit.endTimeMs / 1000;
        playbackPermissionRef.current = wasPlaying;
        playerRef.current.clearLoop();
        playerRef.current.setLoop(startSec, endSec, wasPlaying, count, 0);
    }, [currentUnit, isAudioPlaying, isRecording]);

    // Automatically synchronize the active segment on unit changes. The
    // generation and identity checks invalidate delayed callbacks from the
    // previous sentence before they can seek the player back to old timings.
    useEffect(() => {
        if (loading || !currentUnit || isRecording) return;

        const isNewUnit = lastUnitIndexRef.current !== currentUnit.id;
        lastUnitIndexRef.current = currentUnit.id;
        const generation = ++segmentGenerationRef.current;
        const unitId = currentUnit.id;
        const applySegment = () => {
            if (
                generation !== segmentGenerationRef.current
                || unitId !== currentUnit.id
                || !playbackPermissionRef.current
                || isRecording
                || !playerRef.current
            ) return;
            const startSec = currentUnit.startTimeMs / 1000;
            const endSec = currentUnit.endTimeMs / 1000;
            playerRef.current.clearLoop();
            playerRef.current.setLoop(startSec, endSec, isNewUnit, repeatCount, 0);
        };

        if (isNewUnit) {
            playbackPermissionRef.current = true;
        }
        applySegment();
        const timer = setTimeout(applySegment, 300);
        return () => {
            clearTimeout(timer);
            if (generation === segmentGenerationRef.current) {
                segmentGenerationRef.current += 1;
            }
        };
    }, [currentUnit, isRecording, loading]);

    // Handle speed change
    const handleSetSpeed = (speed: number) => {
        setPlaybackRate(speed);
        if (playerRef.current) {
            playerRef.current.setPlaybackRate(speed);
        }
    };

    // Clean up ephemeral audio URL when unit changes or unmounts
    const cleanupLearnerAudio = useCallback(() => {
        if (recordedAudioUrlRef.current) {
            try {
                URL.revokeObjectURL(recordedAudioUrlRef.current);
            } catch {}
            recordedAudioUrlRef.current = null;
        }
        setRecordedAudioUrl(null);
    }, []);

    useEffect(() => {
        return () => {
            if (recordedAudioUrlRef.current) {
                try {
                    URL.revokeObjectURL(recordedAudioUrlRef.current);
                } catch {}
                recordedAudioUrlRef.current = null;
            }
        };
    }, []);

    // Reset attempt UI for current unit
    const clearCurrentAttemptState = useCallback(() => {
        unitGenerationRef.current += 1;
        analysisAbortRef.current?.abort();
        analysisAbortRef.current = null;
        submittingRef.current = false;
        pendingSaveAttemptRef.current = null;
        activeAttemptIdRef.current = null;
        activeUnitIdRef.current = null;
        if (playerRef.current) {
            try {
                playerRef.current.clearLoop();
                playerRef.current.pause();
            } catch {}
        }
        resetRecorder();
        setAnalysisResult(null);
        setPronunciationV2Result(null);
        setEcsmResult(null);
        setActiveTarget(null);
        setParentAttemptId(null);
        setLastAttemptId(null);
        setSubmitError(null);
        cleanupLearnerAudio();
    }, [resetRecorder, cleanupLearnerAudio]);

    // Navigate to specific unit index
    const handleSelectUnit = useCallback((index: number) => {
        if (index >= 0 && index < units.length) {
            clearCurrentAttemptState();
            // The existing Shadowing UX starts the newly selected sentence;
            // the segment controller will seek to its own timestamps.
            playbackPermissionRef.current = true;
            setCurrentIndex(index);
        }
    }, [units.length, clearCurrentAttemptState]);

    const handleTranslationLoaded = useCallback((unitId: number, translation: string) => {
        setUnits((prev) => prev.map((u) => u.id === unitId ? { ...u, translation } : u));
    }, []);

    const handleNext = () => {
        if (session && currentUnit) {
            advanceShadowingSession(session.id, currentUnit.id, 'COMPLETE').catch(console.error);
        }
        if (!isLast) {
            playbackPermissionRef.current = true;
            handleSelectUnit(currentIndex + 1);
        } else {
            handleFinish();
        }
    };

    const handlePrev = () => {
        if (!isFirst) {
            playbackPermissionRef.current = true;
            handleSelectUnit(currentIndex - 1);
        }
    };

    // Retry current unit
    const handleRetry = () => {
        clearCurrentAttemptState();
        loopCurrentUnit(true);
    };

    // Start targeted ECSM corrective retry
    const handleStartEcsmRetry = (target: EcsmPrimaryTarget, drill: EcsmDrillPlan) => {
        setActiveTarget(target);
        setParentAttemptId(lastAttemptId);
        cleanupLearnerAudio();
        resetRecorder();
        handleStartRecording();
    };

    // Submit and score recorded audio
    const handleSubmitAttempt = async () => {
        if (!audioBlob || !currentUnit || !session || submittingRef.current) return;

        const currentBlob = audioBlob;
        const currentDur = playbackDuration || recordedDuration || 0;
        const targetUnitId = currentUnit.id;

        // Pre-upload client guard: reject ultra-short or digital-silence recordings before billing quota
        if (currentBlob.size === 0) {
            setSubmitError("Chưa thu được dữ liệu âm thanh. Hãy thu lại câu mẫu.");
            return;
        }
        if (currentDur > 0 && currentDur < 0.4) {
            setSubmitError("Bản thu quá ngắn (dưới 0,4 giây). Hãy đọc trọn vẹn câu mẫu rồi thử lại.");
            return;
        }
        if (isMeteringActive && !hasSpeechSignal) {
            setSubmitError("Không phát hiện tín hiệu giọng nói từ micro. Hãy kiểm tra micro không bị tắt tiếng và thu lại.");
            return;
        }

        submittingRef.current = true;
        setSubmitError(null);
        setProcessing(true);

        const requestGeneration = unitGenerationRef.current;

        // Reuse cached analysis receipt if a previous save attempt failed for this exact recording
        const cached = pendingSaveAttemptRef.current;
        const canReuseCached =
            cached != null &&
            cached.unitId === targetUnitId &&
            cached.blob === currentBlob;

        const clientAttemptId = canReuseCached
            ? cached.clientAttemptId
            : typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `attempt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

        activeAttemptIdRef.current = clientAttemptId;
        activeUnitIdRef.current = targetUnitId;

        const isCurrentAttempt = () => (
            unitGenerationRef.current === requestGeneration
            && activeAttemptIdRef.current === clientAttemptId
            && activeUnitIdRef.current === targetUnitId
        );

        try {
            let analysis: ShadowingAnalysisResponse;
            if (canReuseCached) {
                analysis = cached.analysis;
            } else {
                const requestController = new AbortController();
                analysisAbortRef.current?.abort();
                analysisAbortRef.current = requestController;

                // Execute the canonical one-upload STT + Pronunciation pipeline.
                try {
                    analysis = await analyzeShadowingAudio(currentBlob, {
                        expectedText: currentUnit.displayText,
                        sessionId: session.id,
                        unitId: currentUnit.id,
                        attemptId: clientAttemptId,
                        parentAttemptId: parentAttemptId || undefined,
                        activeTargetId: activeTarget?.target_id || undefined,
                        signal: requestController.signal,
                    });
                } catch (err: any) {
                    if (!isCurrentAttempt() || requestController.signal.aborted) return;
                    console.error("Shadowing STT/pronunciation analysis failed:", err);
                    if (err?.response?.status === 422) {
                        setSubmitError("Không nhận diện được lời nói rõ ràng trong bản thu. Hãy nói to, rõ hơn và thử lại.");
                    } else {
                        setSubmitError("Không thể nhận diện giọng nói. Hãy thử lại.");
                    }
                    setProcessing(false);
                    return;
                }

                // The response must be bound to this exact client-generated attempt.
                if (!isCurrentAttempt()) return;
                if (!analysis || analysis.clientAttemptId !== clientAttemptId) {
                    console.error("Shadowing analysis response attempt mismatch", {
                        expected: clientAttemptId,
                        received: analysis?.clientAttemptId,
                    });
                    setSubmitError("Kết quả phân tích không hợp lệ. Hãy thử lại.");
                    setProcessing(false);
                    return;
                }

                // Whisper failure is not a valid attempt. Do not fall back to the
                // reference sentence or fabricate a zero score/transcript.
                const recognizedText = (analysis?.learnerTranscript || analysis?.transcription || "").trim();
                if (!recognizedText) {
                    if (!isCurrentAttempt()) return;
                    setSubmitError("Không thể nhận diện giọng nói. Hãy thử lại.");
                    setProcessing(false);
                    return;
                }

                // Cache analyzed receipt so transient persistence retry does NOT re-run STT/MDD or double-charge quota
                pendingSaveAttemptRef.current = {
                    clientAttemptId,
                    unitId: targetUnitId,
                    blob: currentBlob,
                    durationSec: currentDur,
                    analysis,
                };
            }

            if (!isCurrentAttempt()) return;

            const accuracy = analysis?.accuracyScore ?? null;
            const pronunciationScore = analysis?.pronunciationScore ?? null;
            const attemptDurationSec = Math.max(1, Math.round(currentDur));
            try {
                await recordShadowingAttempt(session.id, {
                    clientAttemptId,
                    unitId: targetUnitId,
                    durationSeconds: attemptDurationSec,
                });
            } catch (err) {
                if (!isCurrentAttempt()) return;
                console.error("Shadowing attempt persistence failed:", err);
                setSubmitError("Không thể lưu kết quả luyện tập. Bấm Chấm điểm lại để lưu mà không cần thu lại.");
                setProcessing(false);
                return;
            }

            // A unit switch can happen while persistence is finishing. No result
            // from that attempt may enter the new unit's presentation state.
            if (!isCurrentAttempt()) return;

            pendingSaveAttemptRef.current = null;

            // Update local progress map for the captured unit only. A null score
            // stays null; it is never converted into a synthetic zero.
            setProgressMap((prev) => {
                const prevEntry = prev[targetUnitId] || { attemptCount: 0, bestAccuracy: undefined };
                const newAccuracy = accuracy != null
                    ? (prevEntry.bestAccuracy != null ? Math.max(prevEntry.bestAccuracy, accuracy) : accuracy)
                    : prevEntry.bestAccuracy;
                const newPronunciation = pronunciationScore != null
                    ? (prevEntry.bestPronunciation != null ? Math.max(prevEntry.bestPronunciation, pronunciationScore) : pronunciationScore)
                    : prevEntry.bestPronunciation;
                return {
                    ...prev,
                    [targetUnitId]: {
                        attemptCount: prevEntry.attemptCount + 1,
                        bestAccuracy: newAccuracy,
                        bestPronunciation: newPronunciation,
                        isPracticed: true,
                    },
                };
            });

            // Retain ephemeral audio URL for playback in YOU SAID panel, revoking any previous one.
            if (recordedAudioUrlRef.current) {
                try {
                    URL.revokeObjectURL(recordedAudioUrlRef.current);
                } catch {}
            }
            const retainedUrl = URL.createObjectURL(currentBlob);
            recordedAudioUrlRef.current = retainedUrl;
            setRecordedAudioUrl(retainedUrl);
            setRecordedAudioDuration(currentDur);
            setAnalysisResult(analysis);
            setPronunciationV2Result(analysis?.pronunciationV2 || null);
            setLastAttemptId(clientAttemptId);
            analysisAbortRef.current = null;
            resetRecorder();
        } finally {
            submittingRef.current = false;
        }
    };

    const handleFinish = () => {
        unitGenerationRef.current += 1;
        analysisAbortRef.current?.abort();
        analysisAbortRef.current = null;
        submittingRef.current = false;
        pendingSaveAttemptRef.current = null;
        activeAttemptIdRef.current = null;
        activeUnitIdRef.current = null;
        playbackPermissionRef.current = false;
        setFinishedElapsedSec(Math.max(0, Math.round((Date.now() - startTimeRef.current) / 1000)));
        setIsFinished(true);
        if (playerRef.current) {
            playerRef.current.clearLoop();
            playerRef.current.pause();
        }
        if (session && currentUnit) {
            advanceShadowingSession(session.id, currentUnit.id, 'COMPLETE').catch(console.error);
        }
    };

    // Calculate aggregated statistics
    const practicedCount = useMemo(() => {
        let count = 0;
        units.forEach((u) => {
            if (progressMap[u.id]?.isPracticed || u.isPracticed || u.attemptCount > 0) count++;
        });
        return count;
    }, [units, progressMap]);

    const averageAccuracy = useMemo(() => {
        const scores: number[] = [];
        units.forEach((u) => {
            const acc = progressMap[u.id]?.bestAccuracy ?? u.bestAccuracy;
            if (acc != null && acc >= 0) scores.push(acc);
        });
        return scores.length > 0
            ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
            : null;
    }, [units, progressMap]);

    const averagePronunciation = useMemo(() => {
        const scores: number[] = [];
        units.forEach((u) => {
            const pron = progressMap[u.id]?.bestPronunciation;
            if (pron != null && pron >= 0) scores.push(pron);
        });
        return scores.length > 0
            ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
            : null;
    }, [units, progressMap]);

    if (loading) {
        return (
            <div className={`${studio.page} ${sx.session}`} data-tone="voice">
                <StudioBackdrop />
                <div className={sx.center}>
                    <div className={sx.loadingText} role="status">
                        <span className={sx.spinner}><img src={echoSrc('social', 24)} alt="" aria-hidden="true" /></span>
                        <span>Đang thiết lập không gian luyện phát âm Shadowing Studio...</span>
                    </div>
                </div>
            </div>
        );
    }

    if (error || !material || units.length === 0) {
        return (
            <div className={`${studio.page} ${sx.session}`} data-tone="voice">
                <StudioBackdrop />
                <div className={sx.center}>
                    <div className={`${sx.glass} ${sx.card} ${sx.cardSmall}`}>
                        <span className={`${sx.badge} ${sx.badgeWarn}`} aria-hidden="true"><Headphones /></span>
                        <h2 className={sx.cardTitle}>Không tìm thấy bài nghe</h2>
                        <p className={sx.cardText}>
                            {error || "Bài nghe này chưa có phụ đề từng câu để luyện tập Shadowing."}
                        </p>
                        <button type="button" onClick={() => router.push("/speaking")} className={sx.primary}>
                            Quay lại Speaking Hub
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ─── Completion Screen ───────────────────────────────────────────────────
    if (isFinished) {
        return (
            <div className={`${studio.page} ${sx.session}`} data-tone="voice">
                <StudioBackdrop />
                <div className={sx.center}>
                    <div className={`${sx.glass} ${sx.card}`}>
                        <span className={sx.badge} aria-hidden="true"><Trophy /></span>
                        <h1 className={sx.cardTitle}>Hoàn thành bài tập Shadowing!</h1>
                        <p className={`${sx.cardText} line-clamp-1`}>{material.title}</p>

                        {/* Stats Summary */}
                        <div className={sx.stats} data-count={averagePronunciation != null ? 4 : 3}>
                            <div className={sx.stat}>
                                <small>Độ khớp nội dung</small>
                                <b>{averageAccuracy != null ? <>{averageAccuracy}<i>/100</i></> : "—"}</b>
                            </div>
                            {averagePronunciation != null && (
                                <div className={sx.stat}>
                                    <small>Điểm phát âm V2</small>
                                    <b>{averagePronunciation}<i>/100</i></b>
                                </div>
                            )}
                            <div className={sx.stat}>
                                <small>Số câu đã luyện</small>
                                <b>{practicedCount}/{units.length}</b>
                            </div>
                            <div className={sx.stat}>
                                <small>Thời gian luyện</small>
                                <b>{finishedElapsedSec}s</b>
                            </div>
                        </div>

                        <div className={`${sx.split} w-full`}>
                            <button
                                type="button"
                                onClick={() => {
                                    startTimeRef.current = Date.now();
                                    setIsFinished(false);
                                    handleSelectUnit(0);
                                }}
                                className={sx.soft}
                            >
                                <RotateCcw /> Luyện lại từ đầu
                            </button>
                            <button type="button" onClick={() => router.push("/speaking")} className={sx.primary}>
                                Quay lại Speaking Hub
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    const activeError = recorderError || submitError;
    const practicedPct = units.length > 0 ? Math.round((practicedCount / units.length) * 100) : 0;

    // ─── Main Shadowing Learning Workspace ──────────────────────────────────
    return (
        <div className={`${studio.page} ${sx.session}`} data-tone="voice">
            <StudioBackdrop />
            <div className={sx.wrap}>
                {/* ── Lesson Header Bar ── */}
                <header className={sx.head}>
                    <div className={sx.headMain}>
                        <button
                            type="button"
                            onClick={() => router.push("/speaking")}
                            className={sx.back}
                            aria-label="Quay lại danh sách Speaking"
                        >
                            <ArrowLeft />
                        </button>
                        <span className={sx.emblem} aria-hidden="true"><Headphones /></span>
                        <div className={sx.headText}>
                            <span className={sx.eyebrow}>
                                Shadowing Studio
                                {material.cefrLevel && <span className={sx.chip}>{material.cefrLevel}</span>}
                                {material.topic && <span className={`${sx.chip} ${sx.chipNeutral}`}>{material.topic}</span>}
                            </span>
                            <h1 className={sx.title}>{material.title}</h1>
                            <span className={sx.meta}>
                                Câu <strong>{currentIndex + 1}</strong> / {units.length}
                            </span>
                        </div>
                    </div>

                    <div className={sx.headSide}>
                        <div className={sx.meter}>
                            <span className={sx.meterLabel}>
                                <CheckCircle2 />
                                Đã luyện: {practicedCount}/{units.length} câu
                            </span>
                            <div
                                className={sx.track}
                                role="progressbar"
                                aria-valuemin={0}
                                aria-valuemax={units.length}
                                aria-valuenow={practicedCount}
                                aria-label="Số câu đã luyện"
                            >
                                <span style={{ width: `${practicedPct}%` }} />
                            </div>
                        </div>
                        <button type="button" onClick={handleFinish} className={sx.soft}>
                            Kết thúc bài tập
                        </button>
                    </div>
                </header>

                {/* ── Two-Column Desktop Workspace Grid ── */}
                <div className={sx.grid}>
                    {/* ── Left Column: Media Player, Controls, Active Sentence, Recording & YOU SAID ── */}
                    <div className={sx.col}>
                        {/* 1. Persistent Video/Media Player */}
                        <div className={sx.media}>
                            <AdvancedAudioPlayer
                                ref={playerRef}
                                audioUrl={material.audioUrl || ""}
                                onPlaybackStateChange={setIsAudioPlaying}
                                isRecording={isRecording}
                                repeatCount={repeatCount}
                                lockToSegment
                                segmentStart={currentUnit ? currentUnit.startTimeMs / 1000 : undefined}
                                segmentEnd={currentUnit ? currentUnit.endTimeMs / 1000 : undefined}
                            />
                        </div>

                        {/* 2. Media Control Bar Under Video */}
                        <div className={`${sx.glass} ${sx.controls}`}>
                            <div className={sx.ctrlGroup}>
                                {/* Prev Sentence */}
                                <button
                                    type="button"
                                    onClick={handlePrev}
                                    disabled={isFirst || isRecording}
                                    className={sx.iconBtn}
                                    aria-label="Câu trước"
                                    title="Câu trước"
                                >
                                    <ChevronLeft />
                                </button>

                                {/* Replay / Loop Sentence */}
                                <button
                                    type="button"
                                    onClick={() => loopCurrentUnit(true)}
                                    disabled={isRecording}
                                    className={sx.soft}
                                    title={`Phát lại câu mẫu (${repeatCount === Infinity ? "Vô hạn" : `${repeatCount} lần`})`}
                                >
                                    <RotateCcw />
                                    <span>Lặp lại câu mẫu</span>
                                </button>

                                {/* Play / Pause Video */}
                                <button
                                    type="button"
                                    disabled={isRecording}
                                    onClick={() => {
                                        if (isRecording) return;
                                        if (isAudioPlaying) {
                                            playbackPermissionRef.current = false;
                                            playerRef.current?.pause();
                                        } else {
                                            playbackPermissionRef.current = true;
                                            playerRef.current?.play();
                                        }
                                    }}
                                    className={`${sx.iconBtn} ${sx.iconBtnLead}`}
                                    aria-label={isAudioPlaying ? "Tạm dừng video" : "Phát video"}
                                    title={isAudioPlaying ? "Tạm dừng" : "Phát"}
                                >
                                    {isAudioPlaying ? <Pause /> : <Play className="fill-current ml-0.5" />}
                                </button>

                                {/* Next Sentence */}
                                <button
                                    type="button"
                                    onClick={handleNext}
                                    disabled={isLast || isRecording}
                                    className={sx.iconBtn}
                                    aria-label="Câu sau"
                                    title="Câu sau"
                                >
                                    <ChevronRight />
                                </button>
                            </div>

                            {/* Right Controls: Repeat Selector & Playback Speed Controls */}
                            <div className={sx.ctrlGroup}>
                                <div className={sx.seg} role="group" aria-label="Số lần lặp lại câu mẫu">
                                    <span className={sx.segLabel}>Lặp lại</span>
                                    {([1, 2, 3, Infinity] as const).map((count) => (
                                        <button
                                            key={count === Infinity ? "inf" : count}
                                            type="button"
                                            onClick={() => handleSetRepeatCount(count)}
                                            className={sx.segBtn}
                                            aria-pressed={repeatCount === count}
                                            title={count === Infinity ? "Lặp lại vô hạn" : `Lặp lại ${count} lần`}
                                        >
                                            {count === Infinity ? "∞" : `${count}x`}
                                        </button>
                                    ))}
                                </div>
                                <div className={sx.seg} role="group" aria-label="Tốc độ phát">
                                    <span className={sx.segLabel}>Tốc độ</span>
                                    {[0.75, 1.0, 1.25].map((speed) => (
                                        <button
                                            key={speed}
                                            type="button"
                                            onClick={() => handleSetSpeed(speed)}
                                            className={sx.segBtn}
                                            aria-pressed={playbackRate === speed}
                                        >
                                            {speed}x
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* 3. Active Sentence Card (with Natural Spacing, Instant IPA & Translation) */}
                        {currentUnit && (
                            <ShadowingActiveSentence
                                key={`active-unit-${currentUnit.id || currentIndex}`}
                                unitId={currentUnit.id}
                                sentenceText={currentUnit.displayText}
                                segmentIndex={currentIndex}
                                ipa={currentUnit.ipa}
                                wordIpaJson={currentUnit.wordIpaJson}
                                translation={currentUnit.translation}
                                onTranslationLoaded={handleTranslationLoaded}
                                className={sx.glassCard}
                            />
                        )}

                        {/* ── Error Banner ── */}
                        {activeError && (
                            <div className={sx.alert} role="alert">
                                <AlertCircle />
                                <p className="font-medium">{activeError}</p>
                            </div>
                        )}

                        {/* 4. Recording & Evaluation Control Hub */}
                        <div className={`${sx.glass} ${sx.stage}`}>
                            {/* IDLE / READY State (Compact) */}
                            {recorderState === "IDLE" && !analysisResult && (
                                <div className={sx.stageCenter}>
                                    <div className={sx.micZone}>
                                        <button
                                            type="button"
                                            onClick={handleStartRecording}
                                            className={sx.mic}
                                            aria-label="Bắt đầu thu âm phát âm câu này"
                                        >
                                            <Mic />
                                        </button>
                                    </div>
                                    <p className={sx.hint}>
                                        <strong>Nhấn micro để bắt đầu thu âm câu mẫu</strong>
                                        <span>Lắng nghe câu mẫu, thu âm và nhận kết quả so khớp từ ngữ</span>
                                    </p>
                                </div>
                            )}

                            {/* REQUESTING PERMISSION State */}
                            {recorderState === "REQUESTING_PERMISSION" && (
                                <div className={sx.stageCenter} role="status">
                                    <span className={sx.spinner}><Radio className="w-7 h-7" /></span>
                                    <p className={sx.hint}>
                                        <strong>Đang yêu cầu quyền truy cập microphone...</strong>
                                    </p>
                                </div>
                            )}

                            {/* RECORDING State: live Web Audio input level indicator */}
                            {isRecording && (
                                <div className={sx.stageCenter} role="status" aria-live="polite">
                                    <div className={sx.micZone}>
                                        <span className={sx.ring} aria-hidden="true" />
                                        <span className={sx.ring} aria-hidden="true" />
                                        <span className={sx.ring} aria-hidden="true" />
                                        <button
                                            type="button"
                                            onClick={stopRecording}
                                            className={sx.stop}
                                            aria-label="Dừng ghi âm và nghe lại"
                                        >
                                            <Square />
                                        </button>
                                    </div>
                                    <span className={sx.clock}>{formattedDuration}</span>
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
                                    <span className={sx.rec}>Đang ghi âm — nhấn nút vuông đỏ để hoàn tất câu nói</span>
                                </div>
                            )}

                            {/* REVIEWING State (Prior to Submission) */}
                            {isReviewing && (
                                <div className="w-full space-y-4">
                                    <div className={sx.review}>
                                        <div className={sx.reviewTimes}>
                                            <span>{formatTime(playbackCurrentTime)}</span>
                                            <span>Nghe lại trước khi nộp</span>
                                            <span>{formatTime(playbackDuration)}</span>
                                        </div>

                                        {/* Progress Bar */}
                                        <div
                                            onClick={(e) => {
                                                const rect = e.currentTarget.getBoundingClientRect();
                                                const clickX = e.clientX - rect.left;
                                                const pct = Math.max(0, Math.min(1, clickX / rect.width));
                                                seekReviewPlayback(pct * playbackDuration);
                                            }}
                                            className={sx.seek}
                                        >
                                            <span style={{ width: `${playbackProgress * 100}%` }} />
                                        </div>
                                    </div>

                                    {isClipping && (
                                        <p className="text-xs font-medium text-amber-700 dark:text-amber-300 text-center">
                                            Cảnh báo: Bản thu có dấu hiệu vỡ tiếng. Bạn có thể thu lại ở khoảng cách micro xa hơn.
                                        </p>
                                    )}

                                    <div className={sx.actions}>
                                        {/* Cancel / Retry */}
                                        <button
                                            type="button"
                                            onClick={() => {
                                                pendingSaveAttemptRef.current = null;
                                                setSubmitError(null);
                                                cancelRecording();
                                            }}
                                            className={sx.soft}
                                        >
                                            <RotateCcw />
                                            <span>Thu lại</span>
                                        </button>

                                        {/* Play / Pause Toggle */}
                                        <button
                                            type="button"
                                            onClick={toggleReviewPlayback}
                                            className={sx.round}
                                            aria-label={isReviewPlaying ? "Tạm dừng nghe lại" : "Phát nghe lại"}
                                        >
                                            {isReviewPlaying ? <Pause /> : <Play className="ml-0.5 fill-current" />}
                                        </button>

                                        {/* Submit & Analyze */}
                                        <button type="button" onClick={handleSubmitAttempt} disabled={isProcessing} className={sx.primary}>
                                            <img src={echoSrc('social', 24)} alt="" aria-hidden="true" className="w-3.5 h-3.5 object-contain" />
                                            <span>Chấm điểm</span>
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* PROCESSING State */}
                            {isProcessing && (
                                <div className={sx.stageCenter} role="status" aria-live="polite">
                                    <span className={sx.spinner}><img src={echoSrc('social', 24)} alt="" aria-hidden="true" /></span>
                                    <p className={sx.hint}>
                                        <strong>Đang nhận diện giọng nói và phân tích phát âm V2.2...</strong>
                                        <span>Whisper STT + Pronunciation V2.2 Acoustic Engine</span>
                                    </p>
                                </div>
                            )}

                            {/* ERROR State Recovery */}
                            {recorderState === "ERROR" && (
                                <div className="flex justify-center">
                                    <button type="button" onClick={handleRetry} className={sx.soft}>
                                        <RotateCcw />
                                        Thử lại
                                    </button>
                                </div>
                            )}

                            {/* 5. Pronunciation V2.2 Assessment Panel (with fallback to legacy ECSM if present) */}
                            {pronunciationV2Result ? (
                                <div className="pt-2">
                                    <PronunciationV2Panel
                                        response={pronunciationV2Result}
                                        isAnalyzing={isProcessing}
                                        onPlayReference={() => loopCurrentUnit(true)}
                                        onRetryRecording={handleRetry}
                                    />
                                </div>
                            ) : ecsmResult ? (
                                <div className="pt-2">
                                    <EcsmFeedbackPanel
                                        response={ecsmResult}
                                        isAnalyzing={isProcessing}
                                        contentMatchScore={analysisResult?.accuracyScore ?? null}
                                        onStartRetry={handleStartEcsmRetry}
                                        onPlayReference={() => loopCurrentUnit(true)}
                                        onRetryRecording={handleRetry}
                                    />
                                </div>
                            ) : null}

                            {/* 6. YOU SAID Panel with Word Alignment and Learner Audio Playback */}
                            {analysisResult && (
                                <div className="space-y-4 pt-2">
                                    <ShadowingYouSaidPanel
                                        transcription={analysisResult.transcription || analysisResult.learnerTranscript || ""}
                                        accuracyScore={analysisResult.accuracyScore}
                                        wordAlignment={analysisResult.wordAlignment}
                                        feedback={analysisResult.feedback}
                                        isMocked={analysisResult.isMocked}
                                        audioUrl={recordedAudioUrl}
                                        audioDuration={recordedAudioDuration}
                                    />

                                    {/* Retry / Next Controls */}
                                    <div className={sx.split}>
                                        <button type="button" onClick={handleRetry} className={sx.soft}>
                                            <RotateCcw />
                                            <span>Luyện tập lại câu này</span>
                                        </button>
                                        <button type="button" onClick={handleNext} className={`${sx.primary} ${sx.go}`}>
                                            <span>{isLast ? "Hoàn thành bài tập" : "Câu tiếp theo"}</span>
                                            <ChevronRight />
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* ── Right Column: Sentence Navigator ── */}
                    <div className={sx.aside}>
                        <SentenceNavigator
                            units={units}
                            currentIndex={currentIndex}
                            onSelectUnit={handleSelectUnit}
                            progressMap={progressMap}
                            className={sx.glassCard}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
