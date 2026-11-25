"use client";

import React, { useState, useEffect, useRef, Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
    ArrowLeft,
    Loader2,
    MessageSquare,
    User,
    Bot,
    Target,
    BookOpen,
    Clock,
    CheckCircle2,
    Play,
    Volume2,
    VolumeX,
    Lightbulb,
    Check,
    Award,
    HelpCircle,
    Link2,
    Mic,
    Square,
    RotateCcw,
    Send,
    Flame,
    CheckCheck,
    ChevronDown,
} from "lucide-react";
import {
    getSpeakingScenarioById,
    SpeakingScenario,
    getSpeakingContext,
    SpeakingContext,
    createSpeakingSession,
    submitRoleplayTurn,
    getRoleplayTurns,
    SpeakingTurn,
    updateSpeakingSession,
    getTurnFeedback,
    SpeakingTurnFeedback,
    getTurnPronunciation,
    PronunciationV2Response,
} from "@/services/speakingApi";
import { apiClient } from "@/services/api-client";
import { VoiceSelector } from "@/components/features/speaking/VoiceSelector";
import { useLanguage } from "@/context/LanguageContext";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import { ProgressiveFeedbackDrawer } from "@/components/features/speaking/ProgressiveFeedbackDrawer";
import { PronunciationV2Panel } from "@/components/features/speaking/PronunciationV2Panel";
import { Button } from "@/components/ui/button";
import { X as CloseIcon } from "lucide-react";
import { StudioBackdrop, categoryTone } from "@/components/features/speaking/studio/SpeakingArt";
import studio from "@/components/features/speaking/studio/speakingStudio.module.css";
import sx from "@/components/features/speaking/studio/speakingSession.module.css";
import { echoSrc } from '@/lib/brand/echoCharacters';
import { useContentTitle } from '@/lib/brand/tabTitle';

// Scenario category names (vi, en) for the briefing chip; an unknown key is shown as the server sent it.
const CATEGORY_NAMES: Record<string, [string, string]> = {
    TRAVEL: ["Du lịch", "Travel"],
    DAILY_LIFE: ["Đời sống", "Daily life"],
    BUSINESS: ["Công việc", "Business"],
    WORK: ["Công việc", "Work"],
    ACADEMIC: ["Học tập", "Academic"],
    CASUAL: ["Giao tiếp", "Casual"],
};

interface ChatTurn {
    id?: number;
    speaker: "LEARNER" | "ASSISTANT";
    text: string;
    synthesizedAudioRef?: string | null;
    detectedVocabulary?: string[];
    pronunciationScore?: number | null;
    fluencyScore?: number | null;
    stressScore?: number | null;
    intonationScore?: number | null;
    rhythmScore?: number | null;
    engineVersion?: string | null;
    pronunciationFeedback?: PronunciationV2Response | null;
    createdAt?: string;
}

function SpeakingScenarioDetailContent() {
    const { locale } = useLanguage();
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();

    const id = typeof params?.id === "string" ? parseInt(params.id, 10) : null;

    const sourceType = searchParams.get("sourceType");
    const sourceIdParam = searchParams.get("sourceId");
    const sourceId = sourceIdParam ? parseInt(sourceIdParam, 10) : null;

    const [speakingContext, setSpeakingContext] = useState<SpeakingContext | null>(null);
    const [scenario, setScenario] = useState<SpeakingScenario | null>(null);
    useContentTitle(scenario?.title);
    const [selectedVoiceId, setSelectedVoiceId] = useState<string>("us_female");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [turnError, setTurnError] = useState<string | null>(null);
    const [pendingRetryTurn, setPendingRetryTurn] = useState<{ blob: Blob; clientTurnId: string } | null>(null);

    // Stage Management
    const [stage, setStage] = useState<"briefing" | "conversation">("briefing");
    const [sessionId, setSessionId] = useState<number | null>(null);
    const [turns, setTurns] = useState<ChatTurn[]>([]);
    const [detectedVocabSet, setDetectedVocabSet] = useState<Set<string>>(new Set());
    const [isAiThinking, setIsAiThinking] = useState(false);
    interface TtsState {
        target: "preview" | string | null;
        status: "idle" | "loading" | "playing" | "error";
    }
    const [ttsState, setTtsState] = useState<TtsState>({ target: null, status: "idle" });
    const [isTaskCompleted, setIsTaskCompleted] = useState(false);

    const getTurnTtsKey = (turnId?: number, fallbackIdx?: number): string =>
        turnId != null ? `turn-${turnId}` : `idx-${fallbackIdx ?? 0}`;

    // Feedback Drawer state
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [selectedTurnText, setSelectedTurnText] = useState("");
    const [selectedTurnFeedback, setSelectedTurnFeedback] = useState<SpeakingTurnFeedback | null>(null);
    const [feedbackLoading, setFeedbackLoading] = useState(false);
    const [feedbackError, setFeedbackError] = useState<string | null>(null);

    // Pronunciation V2.2 Drawer state
    const [isPronDrawerOpen, setIsPronDrawerOpen] = useState(false);
    const [selectedTurnPron, setSelectedTurnPron] = useState<PronunciationV2Response | null>(null);
    const [pronLoading, setPronLoading] = useState(false);
    const [pronError, setPronError] = useState<string | null>(null);

    // Target Vocab Popover in header
    const [showVocabPopover, setShowVocabPopover] = useState(false);

    const conversationEndRef = useRef<HTMLDivElement>(null);
    const isMountedRef = useRef(true);
    const activeSessionIdRef = useRef<number | null>(null);
    const trackedObjectUrlsRef = useRef<Set<string>>(new Set());
    const turnGenerationTokenRef = useRef(0);
    const prefetchedInitialAudioRef = useRef<{
        voiceId: string;
        text: string;
        blob: Blob;
        objectUrl: string;
        audio: HTMLAudioElement;
        isReady: boolean;
    } | null>(null);
    const prefetchAbortControllerRef = useRef<AbortController | null>(null);

    const currentAudioRef = useRef<HTMLAudioElement | null>(null);
    const activeAudioBlobUrlRef = useRef<string | null>(null);
    const activeTtsTurnIdRef = useRef<number | null>(null);
    const activeTtsSessionIdRef = useRef<number | null>(null);
    const audioRequestIdRef = useRef(0);
    const submittingTurnRef = useRef<boolean>(false);
    const turnAbortControllerRef = useRef<AbortController | null>(null);
    const lastAutoSubmittedBlobRef = useRef<Blob | null>(null);

    // Audio recorder hook
    const {
        isRecording,
        duration,
        formattedDuration,
        audioBlob,
        inputLevel,
        isClipping,
        hasSpeechSignal,
        isMeteringActive,
        startRecording,
        stopRecording,
        reset,
        error: recorderError,
    } = useAudioRecorder({
        assessmentMode: true,
    });

    useEffect(() => {
        if (!id) return;
        let isMounted = true;
        setLoading(true);

        getSpeakingScenarioById(id)
            .then((data) => {
                if (isMounted) {
                    setScenario(data);
                    if (data.defaultVoiceId) {
                        setSelectedVoiceId(data.defaultVoiceId);
                    }
                    setLoading(false);
                }
            })
            .catch((err) => {
                console.error("Failed to load speaking scenario:", err);
                if (isMounted) {
                    setError("Không tìm thấy kịch bản giao tiếp hoặc có lỗi kết nối.");
                    setLoading(false);
                }
            });

        return () => {
            isMounted = false;
        };
    }, [id]);

    // Restore previous active session turns if reloading page
    useEffect(() => {
        if (!id) return;
        const savedSessionIdStr = typeof window !== "undefined" ? sessionStorage.getItem(`ec_roleplay_session_${id}`) : null;
        if (savedSessionIdStr) {
            const savedSessionId = parseInt(savedSessionIdStr, 10);
            if (!isNaN(savedSessionId)) {
                getRoleplayTurns(savedSessionId)
                    .then((restoredTurns) => {
                        if (restoredTurns && restoredTurns.length > 0) {
                            setSessionId(savedSessionId);
                            const mappedTurns: ChatTurn[] = restoredTurns.map((t) => ({
                                id: t.id,
                                speaker: t.speaker,
                                text: t.text,
                                synthesizedAudioRef: t.synthesizedAudioRef,
                                detectedVocabulary: t.detectedVocabulary || [],
                                pronunciationScore: t.pronunciationScore,
                                fluencyScore: t.fluencyScore,
                                stressScore: t.stressScore,
                                intonationScore: t.intonationScore,
                                rhythmScore: t.rhythmScore,
                                engineVersion: t.engineVersion,
                                createdAt: t.createdAt,
                            }));
                            setTurns(mappedTurns);
                            const restoredVocab = new Set<string>();
                            mappedTurns.forEach((t) => {
                                (t.detectedVocabulary || []).forEach((w) => restoredVocab.add(w));
                            });
                            setDetectedVocabSet(restoredVocab);
                            setStage("conversation");
                        }
                    })
                    .catch((err) => {
                        console.warn("Could not restore previous roleplay session:", err);
                        sessionStorage.removeItem(`ec_roleplay_session_${id}`);
                    });
            }
        }
    }, [id]);

    useEffect(() => {
        if (sourceType && sourceId && !isNaN(sourceId)) {
            getSpeakingContext(sourceType, sourceId)
                .then((ctx) => setSpeakingContext(ctx))
                .catch((err) => {
                    console.warn("Failed to load handoff context for scenario detail:", err);
                    setSpeakingContext(null);
                });
        }
    }, [sourceType, sourceId]);

    // Auto-scroll to bottom of conversation
    useEffect(() => {
        if (stage === "conversation") {
            conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }
    }, [turns, isAiThinking, stage]);

    const createTrackedUrl = (blob: Blob): string => {
        const url = URL.createObjectURL(blob);
        trackedObjectUrlsRef.current.add(url);
        return url;
    };

    const revokeTrackedUrl = (url: string | null) => {
        if (url && trackedObjectUrlsRef.current.has(url)) {
            try {
                URL.revokeObjectURL(url);
            } catch {}
            trackedObjectUrlsRef.current.delete(url);
        }
    };

    const revokeAllTrackedUrls = () => {
        trackedObjectUrlsRef.current.forEach((url) => {
            try {
                URL.revokeObjectURL(url);
            } catch {}
        });
        trackedObjectUrlsRef.current.clear();
    };

    const stopCurrentAudio = () => {
        audioRequestIdRef.current += 1;
        if (currentAudioRef.current) {
            currentAudioRef.current.pause();
            currentAudioRef.current.currentTime = 0;
            currentAudioRef.current = null;
        }
        if (activeAudioBlobUrlRef.current) {
            revokeTrackedUrl(activeAudioBlobUrlRef.current);
            activeAudioBlobUrlRef.current = null;
        }
        activeTtsTurnIdRef.current = null;
        activeTtsSessionIdRef.current = null;
        setTtsState({ target: null, status: "idle" });
    };

    // Stop audio and revoke object URLs on unmount
    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            turnAbortControllerRef.current?.abort();
            turnAbortControllerRef.current = null;
            submittingTurnRef.current = false;
            stopCurrentAudio();
            revokeAllTrackedUrls();
            if (prefetchAbortControllerRef.current) {
                prefetchAbortControllerRef.current.abort();
            }
        };
    }, []);

    useEffect(() => {
        activeSessionIdRef.current = sessionId;
    }, [sessionId]);

    // Background prefetch / pre-generate initial AI greeting on briefing screen
    useEffect(() => {
        if (stage !== "briefing" || !scenario) return;
        const initialText = scenario.initialAiMessage?.trim() || `Hello, welcome! How can I assist you with your ${scenario.title} today?`;
        if (!initialText) return;

        // Skip if already prefetched and ready for current voice & text
        if (
            prefetchedInitialAudioRef.current?.voiceId === selectedVoiceId &&
            prefetchedInitialAudioRef.current?.text === initialText &&
            prefetchedInitialAudioRef.current?.isReady
        ) {
            return;
        }

        // Abort previous in-flight prefetch if voice changed
        if (prefetchAbortControllerRef.current) {
            prefetchAbortControllerRef.current.abort();
        }
        const controller = new AbortController();
        prefetchAbortControllerRef.current = controller;

        if (prefetchedInitialAudioRef.current) {
            revokeTrackedUrl(prefetchedInitialAudioRef.current.objectUrl);
            prefetchedInitialAudioRef.current = null;
        }

        const targetVoice = selectedVoiceId;
        apiClient.post<Blob>(
            "/speaking/tts/synthesize",
            null,
            { params: { voiceId: targetVoice, text: initialText }, responseType: "blob", timeout: 25000, signal: controller.signal }
        ).then(async (res) => {
            if (controller.signal.aborted || !isMountedRef.current) return;
            if (!res.data || res.data.size === 0 || !/^(audio\/|application\/octet-stream)/i.test(res.data.type)) {
                return;
            }
            const url = createTrackedUrl(res.data);
            const audio = new Audio(url);
            await new Promise<void>((resolve) => {
                let done = false;
                const onReady = () => {
                    if (!done) { done = true; resolve(); }
                };
                audio.oncanplaythrough = onReady;
                audio.onloadeddata = onReady;
                setTimeout(onReady, 600);
            });
            if (controller.signal.aborted || !isMountedRef.current) {
                revokeTrackedUrl(url);
                return;
            }
            prefetchedInitialAudioRef.current = {
                voiceId: targetVoice,
                text: initialText,
                blob: res.data,
                objectUrl: url,
                audio,
                isReady: true,
            };
            console.info("Prefetched initial AI audio ready for voice:", targetVoice);
        }).catch((err) => {
            if (controller.signal.aborted) return;
            console.warn("Initial AI audio background prefetch failed/timed out:", err);
        });
    }, [stage, scenario?.id, scenario?.initialAiMessage, scenario?.title, selectedVoiceId]);

    // Play neutral preview sentence or opening line for selected OmniVoice voice
    const playPreviewAudio = async (text: string) => {
        if (!text || !text.trim()) return;

        if (ttsState.target === "preview" && (ttsState.status === "playing" || ttsState.status === "loading")) {
            stopCurrentAudio();
            return;
        }

        stopCurrentAudio();
        const requestId = ++audioRequestIdRef.current;
        setTtsState({ target: "preview", status: "loading" });

        // Reusable cache check: if prefetched audio matches, play without transferring/revoking its shared objectUrl!
        const prefetched = prefetchedInitialAudioRef.current;
        if (prefetched && prefetched.isReady && prefetched.voiceId === selectedVoiceId && prefetched.text === text.trim()) {
            const audio = new Audio(prefetched.objectUrl);
            currentAudioRef.current = audio;
            activeAudioBlobUrlRef.current = null;

            audio.oncanplaythrough = () => {
                if (currentAudioRef.current !== audio) return;
                audio.play().then(() => {
                    if (currentAudioRef.current !== audio) return;
                    setTtsState({ target: "preview", status: "playing" });
                }).catch((err) => {
                    if (currentAudioRef.current !== audio) return;
                    console.warn("Preview playback failed:", err);
                    setTtsState({ target: "preview", status: "error" });
                });
            };
            audio.onplay = () => {
                if (currentAudioRef.current !== audio) return;
                setTtsState({ target: "preview", status: "playing" });
            };
            audio.onended = () => {
                if (currentAudioRef.current === audio) stopCurrentAudio();
            };
            audio.onerror = () => {
                if (currentAudioRef.current !== audio) return;
                stopCurrentAudio();
                setTtsState({ target: "preview", status: "error" });
            };
            return;
        }

        try {
            const response = await apiClient.post<Blob>(
                "/speaking/tts/synthesize",
                null,
                { params: { voiceId: selectedVoiceId, text: text.trim() }, responseType: "blob", timeout: 35000 }
            );
            if (requestId !== audioRequestIdRef.current) return;
            if (!response.data.size || !/^(audio\/|application\/octet-stream)/i.test(response.data.type)) {
                throw new Error("Invalid preview audio response");
            }
            const audioUrl = createTrackedUrl(response.data);
            activeAudioBlobUrlRef.current = audioUrl;
            const audio = new Audio(audioUrl);
            currentAudioRef.current = audio;

            audio.oncanplaythrough = () => {
                if (currentAudioRef.current !== audio) return;
                audio.play().then(() => {
                    if (currentAudioRef.current !== audio) return;
                    setTtsState({ target: "preview", status: "playing" });
                }).catch((err) => {
                    if (currentAudioRef.current !== audio) return;
                    console.warn("Preview audio playback failed or blocked:", err);
                    setTtsState({ target: "preview", status: "error" });
                });
            };

            audio.onplay = () => {
                if (currentAudioRef.current !== audio) return;
                setTtsState({ target: "preview", status: "playing" });
            };

            audio.onended = () => {
                if (currentAudioRef.current === audio) stopCurrentAudio();
            };

            audio.onerror = () => {
                if (currentAudioRef.current !== audio) return;
                console.warn("Preview audio load error");
                stopCurrentAudio();
                setTtsState({ target: "preview", status: "error" });
            };
        } catch (err) {
            if (requestId !== audioRequestIdRef.current) return;
            console.warn("Preview audio constructor error:", err);
            setTtsState({ target: "preview", status: "error" });
        }
    };

    // Play turn audio for AI responses with idle -> loading -> playing -> idle state & truthful retry
    const playTurnAudio = async (
        turnId?: number,
        turnIdx?: number,
        text?: string,
        isAutoPlay: boolean = false,
        playbackSessionId: number | null = sessionId
    ) => {
        const targetKey = getTurnTtsKey(turnId, turnIdx);

        if (ttsState.target === targetKey && (ttsState.status === "playing" || ttsState.status === "loading")) {
            stopCurrentAudio();
            return;
        }

        stopCurrentAudio();
        const requestId = ++audioRequestIdRef.current;
        setTtsState({ target: targetKey, status: "loading" });

        if (!playbackSessionId) {
            setTtsState({ target: targetKey, status: "error" });
            return;
        }

        activeTtsTurnIdRef.current = turnId ?? null;
        activeTtsSessionIdRef.current = playbackSessionId;
        const thisSessionId = playbackSessionId;
        const thisTurnId = turnId;

        try {
            let audioBlob: Blob | null = null;
            if (thisTurnId) {
                // Fetch authenticated turn audio; backend checks persisted audio/cache, 0 generations on replay
                const response = await apiClient.get<Blob>(
                    `/speaking/sessions/${thisSessionId}/turns/${thisTurnId}/audio`,
                    { responseType: "blob", timeout: 35000 }
                );
                audioBlob = response.data;
            } else if (text) {
                const response = await apiClient.post<Blob>(
                    "/speaking/tts/synthesize",
                    null,
                    { params: { voiceId: selectedVoiceId, text }, responseType: "blob", timeout: 35000 }
                );
                audioBlob = response.data;
            }

            // Stale check: guard against turn or session switching while waiting for synthesis
            if (requestId !== audioRequestIdRef.current || activeTtsSessionIdRef.current !== thisSessionId || (thisTurnId && activeTtsTurnIdRef.current !== thisTurnId)) {
                console.info("Discarding stale TTS audio for turn", thisTurnId);
                return;
            }

            if (!audioBlob || audioBlob.size === 0 || !/^(audio\/|application\/octet-stream)/i.test(audioBlob.type)) {
                setTtsState({ target: targetKey, status: "error" });
                return;
            }

            const audioUrl = createTrackedUrl(audioBlob);
            activeAudioBlobUrlRef.current = audioUrl;
            const audio = new Audio(audioUrl);
            currentAudioRef.current = audio;

            audio.oncanplaythrough = () => {
                if (currentAudioRef.current !== audio) return;
                audio.play().then(() => {
                    if (currentAudioRef.current !== audio) return;
                    setTtsState({ target: targetKey, status: "playing" });
                }).catch((err) => {
                    if (currentAudioRef.current !== audio) return;
                    console.warn("Turn audio play failed or blocked by autoplay policy:", err);
                    setTtsState({ target: targetKey, status: "error" });
                });
            };

            audio.onplay = () => {
                if (currentAudioRef.current !== audio) return;
                setTtsState({ target: targetKey, status: "playing" });
            };

            audio.onended = () => {
                if (currentAudioRef.current !== audio) return;
                currentAudioRef.current = null;
                if (activeAudioBlobUrlRef.current) {
                    revokeTrackedUrl(activeAudioBlobUrlRef.current);
                    activeAudioBlobUrlRef.current = null;
                }
                setTtsState({ target: null, status: "idle" });
            };

            audio.onerror = () => {
                if (currentAudioRef.current !== audio) return;
                console.warn("Audio element playback error");
                currentAudioRef.current = null;
                if (activeAudioBlobUrlRef.current) {
                    revokeTrackedUrl(activeAudioBlobUrlRef.current);
                    activeAudioBlobUrlRef.current = null;
                }
                setTtsState({ target: targetKey, status: "error" });
            };
        } catch (err) {
            console.warn("Failed to retrieve turn audio:", err);
            if (requestId === audioRequestIdRef.current && activeTtsSessionIdRef.current === thisSessionId) {
                setTtsState({ target: targetKey, status: "error" });
            }
        }
    };

    // Start active Roleplay Conversation Session with synchronized initial AI greeting
    const handleStartConversation = async () => {
        if (!scenario) return;
        setLoading(true);
        stopCurrentAudio();
        const generationToken = ++turnGenerationTokenRef.current;

        try {
            const session = await createSpeakingSession({
                mode: "ROLEPLAY",
                scenarioId: scenario.id,
                sourceType: sourceType || undefined,
                sourceId: sourceId || undefined,
                voiceId: selectedVoiceId,
            });

            setSessionId(session.id);
            activeSessionIdRef.current = session.id;
            if (typeof window !== "undefined") {
                sessionStorage.setItem(`ec_roleplay_session_${scenario.id}`, String(session.id));
            }

            // Retrieve seeded initial AI greeting turn with DB turn ID
            let initialAiTurn: ChatTurn;
            try {
                const initialTurns = await getRoleplayTurns(session.id);
                if (initialTurns && initialTurns.length > 0) {
                    const t0 = initialTurns[0];
                    initialAiTurn = {
                        id: t0.id,
                        speaker: "ASSISTANT",
                        text: t0.text,
                        synthesizedAudioRef: t0.synthesizedAudioRef,
                        detectedVocabulary: [],
                        createdAt: t0.createdAt,
                    };
                } else {
                    initialAiTurn = {
                        speaker: "ASSISTANT",
                        text: scenario.initialAiMessage || `Hello, welcome! How can I assist you with your ${scenario.title} today?`,
                        detectedVocabulary: [],
                        createdAt: new Date().toISOString(),
                    };
                }
            } catch {
                initialAiTurn = {
                    speaker: "ASSISTANT",
                    text: scenario.initialAiMessage || `Hello, welcome! How can I assist you with your ${scenario.title} today?`,
                    detectedVocabulary: [],
                    createdAt: new Date().toISOString(),
                };
            }

            // Check if initial audio was already prefetched & ready
            let audioToPlay: HTMLAudioElement | null = null;
            let audioUrlToPlay: string | null = null;

            const prefetched = prefetchedInitialAudioRef.current;
            if (prefetched && prefetched.isReady && prefetched.voiceId === selectedVoiceId && prefetched.text === initialAiTurn.text) {
                audioToPlay = prefetched.audio;
                audioUrlToPlay = prefetched.objectUrl;
                prefetchedInitialAudioRef.current = null; // transferred
            } else {
                // Fetch or wait for initial turn audio with bounded timeout
                try {
                    const response = initialAiTurn.id
                        ? await apiClient.get<Blob>(
                            `/speaking/sessions/${session.id}/turns/${initialAiTurn.id}/audio`,
                            { responseType: "blob", timeout: 12000 }
                        )
                        : await apiClient.post<Blob>(
                            "/speaking/tts/synthesize",
                            null,
                            { params: { voiceId: selectedVoiceId, text: initialAiTurn.text }, responseType: "blob", timeout: 12000 }
                        );
                    if (response.data && response.data.size > 0 && /^(audio\/|application\/octet-stream)/i.test(response.data.type)) {
                        const url = createTrackedUrl(response.data);
                        const audio = new Audio(url);
                        await new Promise<void>((resolve) => {
                            let done = false;
                            const onReady = () => {
                                if (!done) { done = true; resolve(); }
                            };
                            audio.oncanplaythrough = onReady;
                            audio.onloadeddata = onReady;
                            setTimeout(onReady, 600);
                        });
                        audioToPlay = audio;
                        audioUrlToPlay = url;
                    }
                } catch (err) {
                    console.warn("Initial AI turn audio fetch failed/timed out:", err);
                }
            }

            // Stale check
            if (!isMountedRef.current || activeSessionIdRef.current !== session.id || generationToken !== turnGenerationTokenRef.current) {
                if (audioUrlToPlay) revokeTrackedUrl(audioUrlToPlay);
                return;
            }

            const initialTurnKey = getTurnTtsKey(initialAiTurn.id, 0);

            if (audioToPlay && audioUrlToPlay) {
                currentAudioRef.current = audioToPlay;
                activeAudioBlobUrlRef.current = audioUrlToPlay;
                activeTtsSessionIdRef.current = session.id;
                activeTtsTurnIdRef.current = initialAiTurn.id ?? null;

                audioToPlay.onplay = () => {
                    if (currentAudioRef.current !== audioToPlay) return;
                    setTtsState({ target: initialTurnKey, status: "playing" });
                };
                audioToPlay.onended = () => {
                    if (currentAudioRef.current !== audioToPlay) return;
                    stopCurrentAudio();
                };
                audioToPlay.onerror = () => {
                    if (currentAudioRef.current !== audioToPlay) return;
                    stopCurrentAudio();
                    setTtsState({ target: initialTurnKey, status: "error" });
                };

                // ATOMIC PUBLISH: reveal text bubble AND transition stage AND start playback immediately
                setTurns([initialAiTurn]);
                setStage("conversation");
                setLoading(false);
                setTtsState({ target: initialTurnKey, status: "playing" });

                audioToPlay.play().catch((playErr) => {
                    console.warn("Initial AI turn audio playback blocked by browser:", playErr);
                    setTtsState({ target: initialTurnKey, status: "error" });
                });
            } else {
                // Audio failed or timed out: reveal text anyway per failure invariant
                setTurns([initialAiTurn]);
                setStage("conversation");
                setLoading(false);
                setTtsState({ target: initialTurnKey, status: "error" });
            }
        } catch (e) {
            console.error("Failed to start roleplay session:", e);
            setError("Không thể khởi tạo phiên đàm thoại. Vui lòng thử lại.");
            setLoading(false);
        }
    };

    // Submit learner voice turn with synchronized TEXT_READY && AUDIO_READY atomic reveal
    const handleSendTurn = async (blobToSend?: Blob, existingClientTurnId?: string) => {
        const blob = blobToSend || audioBlob;
        if (!blob || !sessionId || submittingTurnRef.current) return;

        // Pre-upload guard for freshly recorded blobs (skipped when retrying an already-validated blob)
        if (!existingClientTurnId) {
            if (blob.size === 0) {
                setTurnError("Chưa thu được dữ liệu âm thanh. Hãy bấm micro và nói lại.");
                reset();
                return;
            }
            if (duration > 0 && duration < 0.4) {
                setTurnError("Bản thu quá ngắn (dưới 0,4 giây). Hãy giữ lâu hơn và nói trọn câu trả lời.");
                reset();
                return;
            }
            if (isMeteringActive && !hasSpeechSignal) {
                setTurnError("Không phát hiện tín hiệu giọng nói từ micro. Hãy kiểm tra micro không bị tắt tiếng và nói lại.");
                reset();
                return;
            }
        }

        submittingTurnRef.current = true;
        setTurnError(null);
        setIsAiThinking(true);

        const currentSessionId = sessionId;
        const clientTurnId =
            existingClientTurnId || `turn-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        const generationToken = ++turnGenerationTokenRef.current;

        turnAbortControllerRef.current?.abort();
        const turnController = new AbortController();
        turnAbortControllerRef.current = turnController;

        try {
            const response = await submitRoleplayTurn(currentSessionId, blob, clientTurnId, turnController.signal);

            // Stale check
            if (!isMountedRef.current || activeSessionIdRef.current !== currentSessionId || generationToken !== turnGenerationTokenRef.current) {
                console.info("Discarding turn response for stale session");
                return;
            }

            // Upload succeeded: now safe to release recorded audio and clear retry state
            setPendingRetryTurn(null);
            reset();

            const pronCompleted = response.pronunciationFeedback?.status === "COMPLETED";
            const newLearnerTurn: ChatTurn = {
                id: response.learnerTurn.id,
                speaker: "LEARNER",
                text: response.learnerTurn.text,
                detectedVocabulary: response.detectedVocabularyThisTurn,
                pronunciationScore:
                    response.learnerTurn.pronunciationScore ??
                    (pronCompleted ? response.pronunciationFeedback?.overall?.overallScore : null),
                fluencyScore:
                    response.learnerTurn.fluencyScore ??
                    (pronCompleted ? response.pronunciationFeedback?.overall?.fluencyScore : null),
                stressScore:
                    response.learnerTurn.stressScore ??
                    (pronCompleted ? response.pronunciationFeedback?.overall?.stressScore : null),
                intonationScore:
                    response.learnerTurn.intonationScore ??
                    (pronCompleted ? response.pronunciationFeedback?.overall?.intonationScore : null),
                rhythmScore:
                    response.learnerTurn.rhythmScore ??
                    (pronCompleted ? response.pronunciationFeedback?.overall?.rhythmScore : null),
                engineVersion: response.learnerTurn.engineVersion ?? response.pronunciationFeedback?.engineVersion,
                pronunciationFeedback: response.pronunciationFeedback,
                createdAt: response.learnerTurn.createdAt,
            };

            const newAiTurn: ChatTurn = {
                id: response.assistantTurn.id,
                speaker: "ASSISTANT",
                text: response.assistantTurn.text,
                synthesizedAudioRef: response.assistantTurn.synthesizedAudioRef,
                detectedVocabulary: [],
                createdAt: response.assistantTurn.createdAt,
            };

            // Learner speech is ready: publish learner turn immediately.
            // Keep isAiThinking = true (AI placeholder active).
            // Do NOT publish newAiTurn yet (TEXT_READY, waiting for AUDIO_READY).
            setTurns((prev) => {
                if (response.isIdempotentReplay && prev.some((t) => t.id === response.learnerTurn.id)) {
                    return prev;
                }
                return [...prev, newLearnerTurn];
            });

            // Independent updates: do not block or serialize
            if (response.allDetectedVocabularySoFar) {
                setDetectedVocabSet(new Set(response.allDetectedVocabularySoFar));
            }
            if (response.isTaskCompleted) {
                setIsTaskCompleted(true);
            }

            // Key TTS state by durable turn ID rather than fragile array index
            const targetAiKey = getTurnTtsKey(newAiTurn.id);

            // Immediately begin audio fetch for newAiTurn
            let audioLoadSucceeded = false;
            let audioToPlay: HTMLAudioElement | null = null;
            let audioUrlToPlay: string | null = null;

            try {
                const audioRes = await apiClient.get<Blob>(
                    `/speaking/sessions/${currentSessionId}/turns/${newAiTurn.id}/audio`,
                    { responseType: "blob", timeout: 14000 }
                );

                if (
                    isMountedRef.current &&
                    activeSessionIdRef.current === currentSessionId &&
                    generationToken === turnGenerationTokenRef.current &&
                    audioRes.data &&
                    audioRes.data.size > 0 &&
                    /^(audio\/|application\/octet-stream)/i.test(audioRes.data.type)
                ) {
                    const url = createTrackedUrl(audioRes.data);
                    const audio = new Audio(url);
                    await new Promise<void>((resolve) => {
                        let done = false;
                        const onReady = () => {
                            if (!done) { done = true; resolve(); }
                        };
                        audio.oncanplaythrough = onReady;
                        audio.onloadeddata = onReady;
                        setTimeout(onReady, 600);
                    });

                    if (
                        isMountedRef.current &&
                        activeSessionIdRef.current === currentSessionId &&
                        generationToken === turnGenerationTokenRef.current
                    ) {
                        audioToPlay = audio;
                        audioUrlToPlay = url;
                        audioLoadSucceeded = true;
                    } else {
                        revokeTrackedUrl(url);
                    }
                }
            } catch (audioErr) {
                console.warn("OmniVoice turn audio generation / fetch failed or timed out:", audioErr);
                audioLoadSucceeded = false;
            }

            // Check stale guard before commit
            if (!isMountedRef.current || activeSessionIdRef.current !== currentSessionId || generationToken !== turnGenerationTokenRef.current) {
                if (audioUrlToPlay) revokeTrackedUrl(audioUrlToPlay);
                return;
            }

            if (audioLoadSucceeded && audioToPlay && audioUrlToPlay) {
                stopCurrentAudio();
                currentAudioRef.current = audioToPlay;
                activeAudioBlobUrlRef.current = audioUrlToPlay;
                activeTtsSessionIdRef.current = currentSessionId;
                activeTtsTurnIdRef.current = newAiTurn.id ?? null;

                audioToPlay.onplay = () => {
                    if (currentAudioRef.current !== audioToPlay) return;
                    setTtsState({ target: targetAiKey, status: "playing" });
                };
                audioToPlay.onended = () => {
                    if (currentAudioRef.current !== audioToPlay) return;
                    stopCurrentAudio();
                };
                audioToPlay.onerror = () => {
                    if (currentAudioRef.current !== audioToPlay) return;
                    stopCurrentAudio();
                    setTtsState({ target: targetAiKey, status: "error" });
                };

                // ATOMIC COMMIT: Reveal text bubble AND hide placeholder AND set playing
                setTurns((prev) => [...prev, newAiTurn]);
                setIsAiThinking(false);
                setTtsState({ target: targetAiKey, status: "playing" });

                // Play audio immediately in the same state transition
                audioToPlay.play().catch((playErr) => {
                    console.warn("Turn audio playback blocked by browser or failed:", playErr);
                    setTtsState({ target: targetAiKey, status: "error" });
                });
            } else {
                // Fallback: Reveal AI text anyway, mark TTS error with retry button
                setTurns((prev) => [...prev, newAiTurn]);
                setIsAiThinking(false);
                setTtsState({ target: targetAiKey, status: "error" });
            }
        } catch (err: any) {
            if (turnController.signal.aborted || !isMountedRef.current) return;
            console.error("Failed to process roleplay turn:", err);
            setIsAiThinking(false);

            const isSTTUnintelligible =
                err?.response?.status === 422 ||
                err?.response?.data?.message?.includes("COULD_NOT_HEAR_SPEECH") ||
                err?.message?.includes("COULD_NOT_HEAR_SPEECH");

            if (isSTTUnintelligible) {
                // Genuine STT failure to recognize learner speech from mic: discard unintelligible clip
                setPendingRetryTurn(null);
                reset();
                const errorAiTurn: ChatTurn = {
                    speaker: "ASSISTANT",
                    text: "I couldn't clearly hear your response. Could you please press the microphone and say that again?",
                    detectedVocabulary: [],
                };
                setTurns((prev) => [...prev, errorAiTurn]);
            } else {
                // Downstream server error, LLM timeout, or network disconnect:
                // Keep conversation mounted and retain the learner's recording for 1-click idempotent retry!
                setPendingRetryTurn({ blob, clientTurnId });
                const errorMsg =
                    err?.response?.data?.message ||
                    "Đã xảy ra sự cố kết nối với AI. Bản thu của bạn vẫn được giữ lại để thử gửi lại.";
                setTurnError(errorMsg);
            }
        } finally {
            submittingTurnRef.current = false;
        }
    };

    const handleStartRecording = () => {
        if (isAiThinking || submittingTurnRef.current) return;
        // Strict Audio Separation: Stop any currently playing AI audio so mic does not pick up speaker playback
        activeTtsTurnIdRef.current = null;
        stopCurrentAudio();
        setTurnError(null);
        setPendingRetryTurn(null);
        startRecording();
    };

    const handleStopAndSend = async () => {
        stopRecording();
    };

    const handleOpenFeedback = async (turn: ChatTurn) => {
        if (!sessionId || !turn.id) return;

        setSelectedTurnText(turn.text);
        setSelectedTurnPron(null);
        setPronError(null);
        setIsDrawerOpen(true);
        setFeedbackLoading(true);
        setFeedbackError(null);
        setSelectedTurnFeedback(null);

        try {
            const data = await getTurnFeedback(sessionId, turn.id);
            setSelectedTurnFeedback(data);
            setFeedbackLoading(false);
        } catch (e: any) {
            console.error("Failed to load turn feedback:", e);
            setFeedbackError("Tạm thời chưa thể tải gợi ý cho câu nói này.");
            setFeedbackLoading(false);
        }
    };

    const handleOpenPronunciation = async (turn: ChatTurn) => {
        if (!turn.id) return;
        setIsPronDrawerOpen(true);
        setSelectedTurnText(turn.text);
        setSelectedTurnPron(null);
        setPronError(null);

        if (turn.pronunciationFeedback) {
            setSelectedTurnPron(turn.pronunciationFeedback);
            return;
        }

        if (sessionId) {
            setPronLoading(true);
            setPronError(null);
            try {
                const pronData = await getTurnPronunciation(sessionId, turn.id);
                setSelectedTurnPron(pronData);
                setTurns((prev) =>
                    prev.map((t) => (t.id === turn.id ? { ...t, pronunciationFeedback: pronData } : t))
                );
            } catch (err: any) {
                console.warn("Could not fetch detailed pronunciation for turn:", err);
                setSelectedTurnPron(null);
                setPronError("Chưa tải được phân tích âm học. Hãy mở lại chi tiết để thử lại.");
            } finally {
                setPronLoading(false);
            }
        }
    };

    // When audio recording completes, auto submit once per distinct Blob
    useEffect(() => {
        if (!isRecording && audioBlob && stage === "conversation" && lastAutoSubmittedBlobRef.current !== audioBlob) {
            lastAutoSubmittedBlobRef.current = audioBlob;
            void handleSendTurn(audioBlob);
        }
    }, [isRecording, audioBlob, stage]);

    const handleCompleteSession = async () => {
        if (sessionId) {
            try {
                await updateSpeakingSession(sessionId, { status: "COMPLETED" });
            } catch (e) {
                console.error("Failed to mark session completed:", e);
            }
            if (scenario) {
                sessionStorage.removeItem(`ec_roleplay_session_${scenario.id}`);
            }
        }
        router.push("/speaking");
    };

    // Combine scenario and inherited target vocabulary
    const allTargetWords = Array.from(
        new Set([
            ...(scenario?.targetVocabulary || []),
            ...(speakingContext?.targetVocabulary || []),
        ])
    );

    if (loading) {
        return (
            <div className={`${studio.page} ${sx.session}`} data-tone="talk">
                <StudioBackdrop />
                <div className={sx.center}>
                    <div className={sx.loadingText} role="status">
                        <span className={sx.spinner}><img src={echoSrc('social', 24)} alt="" aria-hidden="true" /></span>
                        <span>Đang tải phòng hội thoại AI Role-play...</span>
                    </div>
                </div>
            </div>
        );
    }

    if (error || !scenario) {
        return (
            <div className={`${studio.page} ${sx.session}`} data-tone="talk">
                <StudioBackdrop />
                <div className={sx.center}>
                    <div className={`${sx.glass} ${sx.card} ${sx.cardSmall}`}>
                        <span className={`${sx.badge} ${sx.badgeWarn}`} aria-hidden="true"><MessageSquare /></span>
                        <h2 className={sx.cardTitle}>Không tìm thấy kịch bản</h2>
                        <p className={sx.cardText}>
                            {error || "Kịch bản giao tiếp này không tồn tại hoặc đã bị gỡ bỏ."}
                        </p>
                        <button type="button" onClick={() => router.push("/speaking")} className={sx.primary}>
                            Quay lại Thư viện Speaking
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const { Icon: CategoryIcon } = categoryTone(scenario.category);
    const categoryName = CATEGORY_NAMES[scenario.category]?.[locale === "vi" ? 0 : 1] ?? scenario.category;

    // ─────────────────────────────────────────────────────────────
    // STAGE 2: ACTIVE CONVERSATION STUDIO (PHASE 7)
    // ─────────────────────────────────────────────────────────────
    if (stage === "conversation") {
        return (
            <div className={`${studio.page} ${sx.session}`} data-tone="talk">
                <StudioBackdrop />
                <div className={sx.room}>
                    {/* ── Top Context Bar ── */}
                    <header className={`${sx.head} ${sx.roomHead}`}>
                        <div className={sx.headMain}>
                            <button
                                type="button"
                                onClick={() => setStage("briefing")}
                                className={sx.back}
                                aria-label="Xem lại hướng dẫn kịch bản"
                                title="Xem lại hướng dẫn kịch bản"
                            >
                                <ArrowLeft />
                            </button>
                            <div className={sx.headText}>
                                <span className={sx.eyebrow}>
                                    Role-play AI
                                    {scenario.cefrLevel && <span className={sx.chip}>{scenario.cefrLevel}</span>}
                                </span>
                                <h1 className={sx.title}>{scenario.title}</h1>
                                <span className={sx.meta}>
                                    Bạn: <strong className="text-emerald-600 dark:text-emerald-400">{scenario.learnerRole}</strong>
                                    {" • "}
                                    AI: <strong className="text-purple-600 dark:text-purple-300">{scenario.aiRole}</strong>
                                </span>
                            </div>
                        </div>

                        <div className={sx.headSide}>
                            {/* Target Vocabulary Progress Compact Popover */}
                            {allTargetWords.length > 0 && (() => {
                                const usedVocabCount = allTargetWords.filter(
                                    (w) => detectedVocabSet.has(w) || detectedVocabSet.has(w.toLowerCase())
                                ).length;
                                return (
                                    <div className="relative">
                                        <button
                                            type="button"
                                            onClick={() => setShowVocabPopover(!showVocabPopover)}
                                            className={sx.vocabBtn}
                                            aria-expanded={showVocabPopover}
                                            title="Xem danh sách từ vựng mục tiêu"
                                        >
                                            <Target />
                                            <span>Mục tiêu {usedVocabCount}/{allTargetWords.length}</span>
                                            <ChevronDown className={`transition-transform duration-200 ${showVocabPopover ? "rotate-180" : ""}`} />
                                        </button>

                                        {showVocabPopover && (
                                            <div className={`${sx.pop} animate-in fade-in zoom-in-95`}>
                                                <div className="flex items-center justify-between gap-2 pb-2 border-b border-black/5 dark:border-white/10">
                                                    <span className={sx.label}><Target /> Từ vựng mục tiêu</span>
                                                    <span className="text-[11px] font-semibold text-purple-600 dark:text-purple-300">
                                                        {usedVocabCount}/{allTargetWords.length} đã dùng
                                                    </span>
                                                </div>
                                                <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto pt-1">
                                                    {allTargetWords.map((word, idx) => {
                                                        const isDetected = detectedVocabSet.has(word) || detectedVocabSet.has(word.toLowerCase());
                                                        return (
                                                            <span
                                                                key={idx}
                                                                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs font-semibold ${
                                                                    isDetected
                                                                        ? "bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800"
                                                                        : "bg-black/[0.04] dark:bg-white/[0.06] text-gray-600 dark:text-gray-300 border border-black/5 dark:border-white/10"
                                                                }`}
                                                            >
                                                                {isDetected && <Check size={11} className="text-emerald-600 dark:text-emerald-400" />}
                                                                {word}
                                                            </span>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })()}

                            <button type="button" onClick={handleCompleteSession} className={sx.soft}>
                                Kết thúc phiên
                            </button>
                        </div>
                    </header>

                    {/* ── Mission Goal Pill ── */}
                    <div className={sx.missionBar}>
                        <div className="flex items-center gap-2 min-w-0">
                            <Target />
                            <span className="truncate">
                                <strong>Nhiệm vụ:</strong> {scenario.learnerGoal}
                            </span>
                        </div>
                        {isTaskCompleted && (
                            <span className={sx.done}>
                                <CheckCheck size={12} /> Đã hoàn thành mục tiêu!
                            </span>
                        )}
                    </div>

                    {/* ── Conversation Stream Stage ── */}
                    <div className={sx.stream}>
                        {turns.map((turn, idx) => {
                            const isAi = turn.speaker === "ASSISTANT";
                            const turnTtsKey = getTurnTtsKey(turn.id, idx);
                            const isPlaying = ttsState.target === turnTtsKey && ttsState.status === "playing";
                            const isLoadingTts = ttsState.target === turnTtsKey && ttsState.status === "loading";
                            const isTtsError = ttsState.target === turnTtsKey && ttsState.status === "error";

                            const pronStatus = turn.pronunciationFeedback?.status;
                            const hasCompletedPron =
                                turn.pronunciationScore != null || pronStatus === "COMPLETED";
                            const isAbstainedPron = !hasCompletedPron && pronStatus === "ABSTAINED";
                            const displayOverallPron =
                                turn.pronunciationScore ??
                                (pronStatus === "COMPLETED" ? turn.pronunciationFeedback?.overall?.overallScore : null);
                            const displayFluency =
                                turn.fluencyScore ??
                                (pronStatus === "COMPLETED" ? turn.pronunciationFeedback?.overall?.fluencyScore : null);
                            const displayStress =
                                turn.stressScore ??
                                (pronStatus === "COMPLETED" && turn.pronunciationFeedback?.lexicalStress?.status === "ASSESSED"
                                    ? turn.pronunciationFeedback?.overall?.stressScore
                                    : null);
                            const displayIntonation =
                                turn.intonationScore ??
                                (pronStatus === "COMPLETED" ? turn.pronunciationFeedback?.overall?.intonationScore : null);

                            return (
                                <div key={turn.id ?? idx} className={`${sx.turn} ${isAi ? sx.turnAi : sx.turnYou}`}>
                                    {/* Speaker Avatar */}
                                    <div className={`${sx.avatar} ${isAi ? sx.avatarAi : sx.avatarYou}`} aria-hidden="true">
                                        {isAi ? <Bot /> : <User />}
                                    </div>

                                    {/* Chat Bubble */}
                                    <div className="min-w-0 space-y-1.5">
                                        <span className={sx.speaker}>{isAi ? scenario.aiRole : "Bạn"}</span>

                                        <div className={`${sx.bubble} ${isAi ? sx.bubbleAi : sx.bubbleYou}`}>
                                            <p>{turn.text}</p>

                                            {/* Target Vocab Used Indicator in Learner turn */}
                                            {!isAi && turn.detectedVocabulary && turn.detectedVocabulary.length > 0 && (
                                                <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-white/30">
                                                    {turn.detectedVocabulary.map((v, vIdx) => (
                                                        <span
                                                            key={vIdx}
                                                            className="px-2 py-0.5 rounded-lg bg-black/15 text-emerald-50 text-[10px] font-bold flex items-center gap-1"
                                                        >
                                                            <Check size={10} /> {v}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}

                                            {/* Acoustic Metrics Pill Badge for Learner Turn */}
                                            {!isAi && (
                                                <div className="mt-2.5 pt-2 border-t border-white/25 flex flex-wrap items-center justify-between gap-2 text-xs">
                                                    {hasCompletedPron ? (
                                                        <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-emerald-50">
                                                            <span className="font-bold flex items-center gap-1">
                                                                🎯 Phát âm:{" "}
                                                                <span className="font-mono text-white text-[13px]">
                                                                    {displayOverallPron != null ? `${Math.round(displayOverallPron)}/100` : "—"}
                                                                </span>
                                                            </span>
                                                            {displayFluency != null && (
                                                                <span className="opacity-90">
                                                                    Trôi chảy: <span className="font-mono font-bold text-white">{Math.round(displayFluency)}/100</span>
                                                                </span>
                                                            )}
                                                            {displayStress != null && (
                                                                <span className="opacity-90">
                                                                    Trọng âm: <span className="font-mono font-bold text-white">{Math.round(displayStress)}/100</span>
                                                                </span>
                                                            )}
                                                            {displayIntonation != null && (
                                                                <span className="opacity-90 hidden sm:inline">
                                                                    Ngữ điệu: <span className="font-mono font-bold text-white">{Math.round(displayIntonation)}/100</span>
                                                                </span>
                                                            )}
                                                        </div>
                                                    ) : isAbstainedPron ? (
                                                        <div className="flex items-center gap-1.5 text-amber-100 text-xs">
                                                            <span className="font-medium">🎯 Phát âm: Chưa đủ tín hiệu để chấm</span>
                                                        </div>
                                                    ) : (
                                                        <div className="flex items-center gap-1.5 text-emerald-50 text-xs">
                                                            <span className="font-medium">🎯 Phát âm: Chưa được chấm</span>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>

                                        {/* Action row (Audio listen button for AI responses) */}
                                        {isAi && (
                                            <div className="flex flex-wrap items-center gap-2 pt-0.5">
                                                <button
                                                    type="button"
                                                    data-replay-btn="true"
                                                    onClick={() => playTurnAudio(turn.id, idx, turn.text, false)}
                                                    disabled={isLoadingTts}
                                                    className={sx.ttsBtn}
                                                    data-state={isPlaying ? "playing" : isLoadingTts ? "loading" : isTtsError ? "error" : "idle"}
                                                    aria-label={
                                                        isPlaying
                                                            ? "Đang phát âm thanh giọng AI"
                                                            : isLoadingTts
                                                            ? "Đang tạo giọng nói..."
                                                            : isTtsError
                                                            ? "Tạo giọng đọc gặp sự cố, bấm để thử lại"
                                                            : "Nghe lại giọng đọc AI"
                                                    }
                                                >
                                                    {isPlaying ? (
                                                        <>
                                                            <div className="flex items-end gap-0.5 h-3 px-0.5 text-white" aria-hidden="true">
                                                                <span className="w-0.5 bg-current rounded-full rp-equalizer-bar-1" />
                                                                <span className="w-0.5 bg-current rounded-full rp-equalizer-bar-2" />
                                                                <span className="w-0.5 bg-current rounded-full rp-equalizer-bar-3" />
                                                            </div>
                                                            <span>Đang phát...</span>
                                                        </>
                                                    ) : isLoadingTts ? (
                                                        <>
                                                            <Loader2 className="animate-spin" />
                                                            <span>Đang tạo giọng nói...</span>
                                                        </>
                                                    ) : isTtsError ? (
                                                        <>
                                                            <RotateCcw />
                                                            <span>Thử lại giọng đọc</span>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Volume2 />
                                                            <span>Nghe lại</span>
                                                        </>
                                                    )}
                                                </button>
                                                {isTtsError && (
                                                    <span role="status" className="text-xs text-amber-700 dark:text-amber-300">
                                                        Không thể tạo giọng nói
                                                    </span>
                                                )}
                                            </div>
                                        )}

                                        {/* Action row (Feedback Suggestion & Pronunciation buttons for Learner turns) */}
                                        {!isAi && turn.id && (
                                            <div className="flex flex-wrap items-center justify-end gap-2 pt-0.5">
                                                {(turn.pronunciationScore != null || turn.pronunciationFeedback) && (
                                                    <button
                                                        type="button"
                                                        onClick={() => handleOpenPronunciation(turn)}
                                                        className={sx.ttsBtn}
                                                        aria-label="Xem chi tiết phân tích phát âm V2.2"
                                                    >
                                                        <Target />
                                                        <span>Chi tiết phát âm (V2.2)</span>
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => handleOpenFeedback(turn)}
                                                    className={sx.ttsBtn}
                                                    aria-label="Xem gợi ý cải thiện ngữ pháp và từ vựng"
                                                >
                                                    <Lightbulb className="text-amber-500" />
                                                    <span>Gợi ý diễn đạt</span>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}

                        {/* Subtle, comfortable AI waiting placeholder with Whale icon */}
                        {isAiThinking && (
                            <div className={`${sx.turn} ${sx.turnAi} animate-in fade-in duration-200`} role="status" aria-live="polite">
                                <div className={`${sx.avatar} ${sx.avatarAi}`} aria-hidden="true">
                                    <Bot />
                                </div>
                                <div className={`${sx.bubble} ${sx.bubbleAi} ${sx.thinking}`}>
                                    <img src={echoSrc('social', 24)} alt="" aria-hidden="true" />
                                    <span>AI đang trả lời...</span>
                                </div>
                            </div>
                        )}

                        <div ref={conversationEndRef} />
                    </div>

                    {/* ── Bottom Push-To-Talk Control Hub ── */}
                    <div className={`${sx.glass} ${sx.talk}`}>
                        {(recorderError || turnError) && (
                            <div className={`${sx.talkErr} flex flex-wrap items-center justify-between gap-2`} role="alert">
                                <span>{turnError || recorderError}</span>
                                <div className="flex items-center gap-2 shrink-0">
                                    {pendingRetryTurn && !isAiThinking && (
                                        <button
                                            type="button"
                                            onClick={() => void handleSendTurn(pendingRetryTurn.blob, pendingRetryTurn.clientTurnId)}
                                            className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold cursor-pointer"
                                        >
                                            Thử gửi lại
                                        </button>
                                    )}
                                    {turnError && (
                                        <button
                                            type="button"
                                            onClick={() => setTurnError(null)}
                                            className="text-xs underline cursor-pointer"
                                        >
                                            Đóng
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}

                        {isRecording && (
                            <div className="w-full max-w-sm mx-auto space-y-1">
                                <div className="h-1.5 w-full rounded-full bg-slate-200/80 dark:bg-white/10 overflow-hidden">
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
                                {isClipping && (
                                    <p className="text-[11px] font-semibold text-rose-600 dark:text-rose-400 text-center">
                                        Âm lượng micro quá lớn (vỡ tiếng)
                                    </p>
                                )}
                            </div>
                        )}

                        <div className={sx.talkRow}>
                            {isRecording ? (
                                <button
                                    type="button"
                                    onClick={handleStopAndSend}
                                    className={`${sx.primary} ${sx.talkBtn} ${sx.talkBtnRec}`}
                                    aria-label="Dừng và gửi câu trả lời"
                                >
                                    <span className={sx.talkPulse} aria-hidden="true"><i /></span>
                                    <span>Dừng và Gửi ({formattedDuration})</span>
                                </button>
                            ) : isAiThinking ? (
                                <button
                                    type="button"
                                    disabled
                                    className={`${sx.primary} ${sx.talkBtn} ${sx.talkBtnWait}`}
                                    aria-label="AI đang trả lời..."
                                >
                                    <img src={echoSrc('social', 24)} alt="" aria-hidden="true" className="w-5 h-5 object-contain" />
                                    <span>AI đang trả lời...</span>
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={handleStartRecording}
                                    className={`${sx.primary} ${sx.talkBtn} ${sx.go}`}
                                    aria-label="Bắt đầu thu âm câu trả lời"
                                >
                                    <Mic />
                                    <span>{locale === 'vi' ? 'Nhấn để nói' : 'Push to Talk'}</span>
                                </button>
                            )}
                        </div>

                        <p className={isRecording ? sx.rec : sx.talkNote}>
                            {isRecording
                                ? "Đang ghi âm — nói rõ ràng vào micro rồi nhấn 'Dừng và Gửi'"
                                : "Nói trực tiếp bằng tiếng Anh để luyện phản xạ tự nhiên cùng AI."}
                        </p>
                    </div>

                    {/* Progressive Feedback Drawer */}
                    <ProgressiveFeedbackDrawer
                        isOpen={isDrawerOpen}
                        onClose={() => setIsDrawerOpen(false)}
                        turnText={selectedTurnText}
                        feedback={selectedTurnFeedback}
                        loading={feedbackLoading}
                        error={feedbackError}
                    />

                    {/* Pronunciation Engine V2.2 Detailed Drawer / Modal */}
                    {isPronDrawerOpen && (
                        <div className={`${sx.scrim} animate-in fade-in`}>
                            <div className={sx.dialog} role="dialog" aria-modal="true" aria-labelledby="pron-dialog-title">
                                <div className={sx.dialogHead}>
                                    <div className="min-w-0">
                                        <h3 id="pron-dialog-title" className="text-lg font-bold flex items-center gap-2">
                                            <span>{locale === 'vi' ? '🎯 Phân tích phát âm âm học (V2.2)' : '🎯 Acoustic Pronunciation Analysis (V2.2)'}</span>
                                        </h3>
                                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 font-mono">
                                            &quot;{selectedTurnText}&quot;
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setIsPronDrawerOpen(false)}
                                        className={sx.round}
                                        aria-label={locale === 'vi' ? 'Đóng' : 'Close'}
                                        autoFocus
                                    >
                                        <CloseIcon />
                                    </button>
                                </div>

                                {pronLoading && (
                                    <div className={sx.loadingText} role="status">
                                        <span className={sx.spinner}><img src={echoSrc('social', 24)} alt="" aria-hidden="true" /></span>
                                        <span>Đang truy xuất phân tích âm học V2.2...</span>
                                    </div>
                                )}

                                {pronError && (
                                    <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 text-sm">
                                        {pronError}
                                    </div>
                                )}

                                {!pronLoading && selectedTurnPron && (
                                    <PronunciationV2Panel response={selectedTurnPron} isRoleplay={true} />
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // ─────────────────────────────────────────────────────────────
    // STAGE 1: BRIEFING & PRE-FLIGHT CHECKLIST
    // ─────────────────────────────────────────────────────────────
    const isPreviewPlaying = ttsState.target === "preview" && ttsState.status === "playing";
    const isPreviewLoading = ttsState.target === "preview" && ttsState.status === "loading";
    const isPreviewError = ttsState.target === "preview" && ttsState.status === "error";

    return (
        <div className={`${studio.page} ${sx.session}`} data-tone="talk">
            <StudioBackdrop />
            <div className={`${sx.wrap} ${sx.wrapNarrow}`}>
                {/* ── Top Navigation Bar ── */}
                <header className={sx.head}>
                    <div className={sx.headMain}>
                        <button
                            type="button"
                            onClick={() => router.push("/speaking")}
                            className={sx.back}
                            aria-label="Quay lại danh sách kịch bản"
                        >
                            <ArrowLeft />
                        </button>
                        <span className={sx.emblem} aria-hidden="true"><CategoryIcon /></span>
                        <div className={sx.headText}>
                            <span className={sx.eyebrow}>
                                Role-play AI
                                {scenario.cefrLevel && <span className={sx.chip}>{scenario.cefrLevel}</span>}
                                {scenario.category && <span className={`${sx.chip} ${sx.chipNeutral}`}>{categoryName}</span>}
                            </span>
                            <h1 className={sx.title}>{scenario.title}</h1>
                        </div>
                    </div>

                    {scenario.estimatedMinutes && scenario.estimatedMinutes > 0 ? (
                        <span className={`${sx.chip} ${sx.chipNeutral} hidden sm:inline-flex`} style={{ fontSize: "0.72rem", padding: "0.35rem 0.75rem", textTransform: "none", letterSpacing: 0 }}>
                            <Clock size={13} />
                            Thời lượng ước tính: ~{scenario.estimatedMinutes} phút
                        </span>
                    ) : null}
                </header>

                {/* ── Inherited Lesson Context Callout (if launched from a lesson) ── */}
                {speakingContext && (
                    <div className={`${sx.glass} ${sx.panel}`} style={{ flexDirection: "row", alignItems: "center" }}>
                        <span className={sx.emblem} aria-hidden="true"><Link2 /></span>
                        <div>
                            <div className="text-sm font-bold">
                                Đang luyện tập theo ngữ cảnh: {speakingContext.sourceTitle}
                            </div>
                            <div className={sx.small}>
                                Nguồn: {speakingContext.sourceType} • {speakingContext.targetVocabulary?.length || 0} từ vựng bài học được tích hợp
                            </div>
                        </div>
                    </div>
                )}

                {/* ── Main Briefing Grid ── */}
                <div className={sx.brief}>
                    {/* Left Column: Context, Roles, Voice, Opening Line, Success Criteria */}
                    <div className={sx.col}>
                        {/* 1. Context & Description Card */}
                        <section className={`${sx.glass} ${sx.panel}`}>
                            <span className={sx.label}><BookOpen /> Bối cảnh tình huống</span>
                            <p className={sx.body}>{scenario.description}</p>

                            {/* Mission Goal Banner */}
                            <div className={sx.mission}>
                                <span className={sx.label}><Target /> Mục tiêu hội thoại</span>
                                <p>{scenario.learnerGoal}</p>
                            </div>
                        </section>

                        {/* 2. Role Assignment Card */}
                        <div className={sx.roles}>
                            <section className={`${sx.glass} ${sx.panel} ${sx.role}`}>
                                <div className={sx.roleHead}>
                                    <span className={`${sx.avatar} ${sx.avatarYou}`} aria-hidden="true"><User /></span>
                                    <div>
                                        <div className={sx.roleKicker}>Vai của bạn</div>
                                        <div className={sx.roleName}>{scenario.learnerRole}</div>
                                    </div>
                                </div>
                                <p className={sx.small}>
                                    Bạn sẽ đóng vai trò này và chủ động trả lời hoặc đặt câu hỏi theo mục tiêu tình huống.
                                </p>
                            </section>
                            <section className={`${sx.glass} ${sx.panel} ${sx.role}`}>
                                <div className={sx.roleHead}>
                                    <span className={`${sx.avatar} ${sx.avatarAi}`} aria-hidden="true"><Bot /></span>
                                    <div>
                                        <div className={sx.roleKicker}>Gia sư AI đóng vai</div>
                                        <div className={sx.roleName}>{scenario.aiRole}</div>
                                    </div>
                                </div>
                                <p className={sx.small}>
                                    AI sẽ nhập vai tự nhiên, phản hồi linh hoạt và dẫn dắt cuộc hội thoại như người bản xứ.
                                </p>
                            </section>
                        </div>

                        {/* 3. Voice Selection Card */}
                        <section className={`${sx.glass} ${sx.panel}`}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className={sx.label}>
                                    <img src={echoSrc('social', 24)} alt="" aria-hidden="true" />
                                    Giọng của AI
                                </span>
                                <span className={sx.small}>Chọn giọng bạn muốn luyện nghe</span>
                            </div>
                            <VoiceSelector
                                selectedVoiceId={selectedVoiceId}
                                onSelectVoice={(v) => {
                                    stopCurrentAudio();
                                    setSelectedVoiceId(v);
                                }}
                                onPlaybackStateChange={(isPlaying) => {
                                    if (isPlaying) {
                                        stopCurrentAudio();
                                    }
                                }}
                            />
                        </section>

                        {/* 4. Opening Line Preview */}
                        {scenario.initialAiMessage && (
                            <section className={`${sx.glass} ${sx.panel}`}>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className={sx.label}>
                                        <Volume2 />
                                        Câu chào mở đầu từ AI ({scenario.aiRole}):
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => playPreviewAudio(scenario.initialAiMessage)}
                                        disabled={isPreviewLoading}
                                        className={sx.ttsBtn}
                                        data-state={isPreviewPlaying ? "playing" : isPreviewLoading ? "loading" : isPreviewError ? "error" : "idle"}
                                        aria-label={
                                            isPreviewPlaying
                                                ? "Đang phát câu chào AI"
                                                : isPreviewLoading
                                                ? "Đang tải câu chào AI"
                                                : isPreviewError
                                                ? "Lỗi phát âm, bấm để thử lại"
                                                : "Nghe thử câu chào AI"
                                        }
                                    >
                                        {isPreviewPlaying ? (
                                            <>
                                                <div className="flex items-end gap-0.5 h-3 px-0.5 text-white" aria-hidden="true">
                                                    <span className="w-0.5 bg-current rounded-full rp-equalizer-bar-1" />
                                                    <span className="w-0.5 bg-current rounded-full rp-equalizer-bar-2" />
                                                    <span className="w-0.5 bg-current rounded-full rp-equalizer-bar-3" />
                                                </div>
                                                <span>Đang phát...</span>
                                            </>
                                        ) : isPreviewLoading ? (
                                            <>
                                                <Loader2 className="animate-spin" />
                                                <span>Đang tải...</span>
                                            </>
                                        ) : isPreviewError ? (
                                            <>
                                                <RotateCcw />
                                                <span>Thử lại</span>
                                            </>
                                        ) : (
                                            <>
                                                <Volume2 />
                                                <span>Nghe thử</span>
                                            </>
                                        )}
                                    </button>
                                </div>
                                <div className={sx.quote}>&ldquo;{scenario.initialAiMessage}&rdquo;</div>
                            </section>
                        )}

                        {/* 5. Success Criteria (Instructional Contract) */}
                        {scenario.successCriteria && scenario.successCriteria.length > 0 && (
                            <section className={`${sx.glass} ${sx.panel}`}>
                                <span className={`${sx.label} ${sx.labelGreen}`}><Award /> Tiêu chí thành công</span>
                                <ul className={sx.list}>
                                    {scenario.successCriteria.map((criterion, idx) => (
                                        <li key={idx}>
                                            <CheckCircle2 />
                                            <span>{criterion}</span>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        )}
                    </div>

                    {/* Right Column: Inherited Vocabulary, Scenario Vocabulary, Grammar, Hints, Start */}
                    <div className={sx.col}>
                        {/* 0. Inherited Lesson Vocabulary (if handoff active) */}
                        {speakingContext?.targetVocabulary && speakingContext.targetVocabulary.length > 0 && (
                            <section className={`${sx.glass} ${sx.panel}`}>
                                <span className={sx.label}><Link2 /> Từ vựng từ bài học ({speakingContext.sourceTitle})</span>
                                <div className={sx.words}>
                                    {speakingContext.targetVocabulary.map((word, idx) => (
                                        <span key={idx} className={`${sx.word} ${sx.wordSolid}`}>{word}</span>
                                    ))}
                                </div>
                            </section>
                        )}

                        {/* 1. Target Vocabulary from Scenario */}
                        {scenario.targetVocabulary && scenario.targetVocabulary.length > 0 && (
                            <section className={`${sx.glass} ${sx.panel}`}>
                                <span className={sx.label}><Target /> Từ vựng kịch bản khuyến khích sử dụng</span>
                                <p className={sx.small}>Hãy cố gắng lồng ghép các từ vựng này vào câu trả lời của bạn:</p>
                                <div className={sx.words}>
                                    {scenario.targetVocabulary.map((word, idx) => (
                                        <span key={idx} className={sx.word}>{word}</span>
                                    ))}
                                </div>
                            </section>
                        )}

                        {/* 2. Target Grammar & Sentence Starters */}
                        {scenario.targetGrammar && scenario.targetGrammar.length > 0 && (
                            <section className={`${sx.glass} ${sx.panel}`}>
                                <span className={`${sx.label} ${sx.labelGold}`}><Lightbulb /> Mẫu câu và Ngữ pháp gợi ý</span>
                                <div className="flex flex-col gap-2">
                                    {scenario.targetGrammar.map((grammar, idx) => (
                                        <div key={idx} className={sx.line}>• {grammar}</div>
                                    ))}
                                </div>
                            </section>
                        )}

                        {/* 3. Optional Hints */}
                        {scenario.optionalHints && scenario.optionalHints.length > 0 && (
                            <section className={`${sx.glass} ${sx.panel}`}>
                                <span className={sx.label}><HelpCircle /> Mẹo đối thoại hữu ích</span>
                                <ul className="space-y-1.5 text-sm list-disc list-inside" style={{ color: "var(--ink-2)" }}>
                                    {scenario.optionalHints.map((hint, idx) => (
                                        <li key={idx} className="leading-relaxed">{hint}</li>
                                    ))}
                                </ul>
                            </section>
                        )}

                        {/* Direct Start Action Card */}
                        <section className={`${sx.glass} ${sx.panel} ${sx.ready}`}>
                            <span className={sx.label}>
                                <img src={echoSrc('social', 24)} alt="" aria-hidden="true" />
                                Sẵn sàng luyện tập
                            </span>
                            <p className={sx.small}>
                                Nhấn nút bên dưới để bắt đầu hội thoại cùng AI. Gia sư AI sẽ đóng vai và đưa ra câu mở đầu.
                            </p>

                            {/* CTA Button to enter conversation mode */}
                            <button type="button" data-guide="rp-start" onClick={handleStartConversation} className={`${sx.primary} w-full`}>
                                <Play className="fill-current" />
                                <span>Bắt đầu hội thoại AI</span>
                            </button>
                        </section>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function SpeakingScenarioDetailPage() {
    return (
        <Suspense fallback={<div className="p-12 text-center text-gray-400">Đang tải kịch bản...</div>}>
            <SpeakingScenarioDetailContent />
        </Suspense>
    );
}
