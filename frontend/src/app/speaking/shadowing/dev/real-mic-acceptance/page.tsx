"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
    Mic,
    Square,
    CheckCircle2,
    AlertCircle,
    RotateCcw,
    Sparkles,
    Copy,
    Download,
    ArrowRight,
    ArrowLeft,
    HelpCircle,
    Layers,
    Info,
    ShieldCheck,
    Volume2,
    Play,
    Pause,
    Flame,
    Target,
    ChevronRight,
    Activity,
    Clock,
    Terminal,
    FileText,
    ShieldAlert,
    Check,
} from "lucide-react";
import { useAudioRecorder, formatTime } from "@/hooks/useAudioRecorder";

export interface AcceptanceClipDef {
    clip_id: string;
    group: "CLEAN" | "INTENTIONAL_ERROR";
    target_sentence: string;
    instruction_en: string;
    instruction_vi: string;
    target_word?: string;
    target_word_index?: number;
    expected_phone?: string;
    intentional_substitute_phone?: string;
    contrast_name?: string;
    phonetic_focus?: string;
}

export const FALLBACK_16_CLIPS: AcceptanceClipDef[] = [
    // -------------------------------------------------------------
    // Group CLEAN (8 recordings)
    // Varied phonetic coverage: /ð/, /θ/, /r/, /l/, /ɪ/, /i/, /æ/, /ʌ/, /w/, /v/, /z/, /ʃ/, /tʃ/, /dʒ/
    // -------------------------------------------------------------
    {
        clip_id: "clean_01",
        group: "CLEAN",
        target_sentence: "The sun shines brightly today.",
        instruction_en: "Read naturally and correctly in standard English.",
        instruction_vi: "Đọc tự nhiên và chuẩn xác.",
        phonetic_focus: "/ð/, /ʃ/, /z/, /r/, /l/, /ʌ/",
    },
    {
        clip_id: "clean_02",
        group: "CLEAN",
        target_sentence: "I think this is very good.",
        instruction_en: "Read naturally and correctly in standard English.",
        instruction_vi: "Đọc tự nhiên và chuẩn xác.",
        phonetic_focus: "/θ/, /ð/, /ɪ/, /v/, /r/, /i/",
    },
    {
        clip_id: "clean_03",
        group: "CLEAN",
        target_sentence: "We will reach the river soon.",
        instruction_en: "Read naturally and correctly in standard English.",
        instruction_vi: "Đọc tự nhiên và chuẩn xác.",
        phonetic_focus: "/w/, /i/, /tʃ/, /ð/, /r/, /l/, /ɪ/, /v/",
    },
    {
        clip_id: "clean_04",
        group: "CLEAN",
        target_sentence: "She has a black cat.",
        instruction_en: "Read naturally and correctly in standard English.",
        instruction_vi: "Đọc tự nhiên và chuẩn xác.",
        phonetic_focus: "/ʃ/, /i/, /z/, /æ/, /l/",
    },
    {
        clip_id: "clean_05",
        group: "CLEAN",
        target_sentence: "They enjoy the jazz music.",
        instruction_en: "Read naturally and correctly in standard English.",
        instruction_vi: "Đọc tự nhiên và chuẩn xác.",
        phonetic_focus: "/ð/, /dʒ/, /z/, /æ/, /ɪ/",
    },
    {
        clip_id: "clean_06",
        group: "CLEAN",
        target_sentence: "Look at that large yellow ship.",
        instruction_en: "Read naturally and correctly in standard English.",
        instruction_vi: "Đọc tự nhiên và chuẩn xác.",
        phonetic_focus: "/l/, /æ/, /ð/, /r/, /dʒ/, /w/, /ʃ/, /ɪ/",
    },
    {
        clip_id: "clean_07",
        group: "CLEAN",
        target_sentence: "Give me a cup of warm water.",
        instruction_en: "Read naturally and correctly in standard English.",
        instruction_vi: "Đọc tự nhiên và chuẩn xác.",
        phonetic_focus: "/ɡ/, /ɪ/, /v/, /i/, /ʌ/, /w/, /r/",
    },
    {
        clip_id: "clean_08",
        group: "CLEAN",
        target_sentence: "Which teacher chose the green chair?",
        instruction_en: "Read naturally and correctly in standard English.",
        instruction_vi: "Đọc tự nhiên và chuẩn xác.",
        phonetic_focus: "/w/, /ɪ/, /tʃ/, /i/, /ð/, /r/",
    },
    // -------------------------------------------------------------
    // Group INTENTIONAL ERROR (8 recordings)
    // Exact 8 required contrasts
    // -------------------------------------------------------------
    {
        clip_id: "error_01",
        group: "INTENTIONAL_ERROR",
        target_sentence: "I think it is great.",
        instruction_en: "Pronounce 'think' as 'sink' (/s/ instead of /θ/). Read all other words normally.",
        instruction_vi: "Đọc 'think' thành 'sink' (âm /s/ thay vì /θ/). Đọc các từ còn lại bình thường.",
        target_word: "think",
        target_word_index: 1,
        expected_phone: "θ",
        intentional_substitute_phone: "s",
        contrast_name: "θ -> s",
        phonetic_focus: "/θ/ -> /s/",
    },
    {
        clip_id: "error_02",
        group: "INTENTIONAL_ERROR",
        target_sentence: "Three birds are flying.",
        instruction_en: "Pronounce 'Three' as 'Tree' (/t/ instead of /θ/). Read all other words normally.",
        instruction_vi: "Đọc 'Three' thành 'Tree' (âm /t/ thay vì /θ/). Đọc các từ còn lại bình thường.",
        target_word: "Three",
        target_word_index: 0,
        expected_phone: "θ",
        intentional_substitute_phone: "t",
        contrast_name: "θ -> t",
        phonetic_focus: "/θ/ -> /t/",
    },
    {
        clip_id: "error_03",
        group: "INTENTIONAL_ERROR",
        target_sentence: "This book is mine.",
        instruction_en: "Pronounce 'This' as 'Dis' (/d/ instead of /ð/). Read all other words normally.",
        instruction_vi: "Đọc 'This' thành 'Dis' (âm /d/ thay vì /ð/). Đọc các từ còn lại bình thường.",
        target_word: "This",
        target_word_index: 0,
        expected_phone: "ð",
        intentional_substitute_phone: "d",
        contrast_name: "ð -> d",
        phonetic_focus: "/ð/ -> /d/",
    },
    {
        clip_id: "error_04",
        group: "INTENTIONAL_ERROR",
        target_sentence: "We need more red paint.",
        instruction_en: "Pronounce 'red' as 'led' (/l/ instead of /r/). Read all other words normally.",
        instruction_vi: "Đọc 'red' thành 'led' (âm /l/ thay vì /r/). Đọc các từ còn lại bình thường.",
        target_word: "red",
        target_word_index: 3,
        expected_phone: "r",
        intentional_substitute_phone: "l",
        contrast_name: "r -> l",
        phonetic_focus: "/r/ -> /l/",
    },
    {
        clip_id: "error_05",
        group: "INTENTIONAL_ERROR",
        target_sentence: "Please sit on the chair.",
        instruction_en: "Pronounce 'sit' as 'seat' (long /i/ instead of short /ɪ/). Read all other words normally.",
        instruction_vi: "Đọc 'sit' thành 'seat' (âm dài /i/ thay vì /ɪ/). Đọc các từ còn lại bình thường.",
        target_word: "sit",
        target_word_index: 1,
        expected_phone: "ɪ",
        intentional_substitute_phone: "i",
        contrast_name: "ɪ -> i",
        phonetic_focus: "/ɪ/ -> /i/",
    },
    {
        clip_id: "error_06",
        group: "INTENTIONAL_ERROR",
        target_sentence: "The ship sails on the green sea.",
        instruction_en: "Pronounce 'sea' with short /ɪ/ (like 'si' in 'six'). Read all other words normally.",
        instruction_vi: "Đọc 'sea' với âm ngắn /ɪ/ (như 'si'). Đọc các từ còn lại bình thường.",
        target_word: "sea",
        target_word_index: 6,
        expected_phone: "i",
        intentional_substitute_phone: "ɪ",
        contrast_name: "i -> ɪ",
        phonetic_focus: "/i/ -> /ɪ/",
    },
    {
        clip_id: "error_07",
        group: "INTENTIONAL_ERROR",
        target_sentence: "They visited a very nice town.",
        instruction_en: "Pronounce 'very' with /w/ instead of /v/, while keeping the rest of the word as close to 'very' as possible. Read all other words normally.",
        instruction_vi: "Đọc 'very' với âm /w/ thay vì /v/, giữ nguyên phần còn lại của từ sát với 'very' nhất có thể. Đọc các từ còn lại bình thường.",
        target_word: "very",
        target_word_index: 3,
        expected_phone: "v",
        intentional_substitute_phone: "w",
        contrast_name: "v -> w",
        phonetic_focus: "/v/ -> /w/",
    },
    {
        clip_id: "error_08",
        group: "INTENTIONAL_ERROR",
        target_sentence: "He told a funny joke.",
        instruction_en: "Pronounce 'joke' as 'choke' (/tʃ/ instead of /dʒ/). Read all other words normally.",
        instruction_vi: "Đọc 'joke' thành 'choke' (âm /tʃ/ thay vì /dʒ/). Đọc các từ còn lại bình thường.",
        target_word: "joke",
        target_word_index: 4,
        expected_phone: "dʒ",
        intentional_substitute_phone: "tʃ",
        contrast_name: "dʒ -> tʃ",
        phonetic_focus: "/dʒ/ -> /tʃ/",
    },
];

export interface ClipSavedStatus {
    isRecorded: boolean;
    audioSHA256?: string;
    rawAudioPath?: string;
    derivedWavPath?: string;
    durationSec?: number;
    savedAt?: string;
}

export interface SessionManifest {
    sessionId: string;
    totalClips: number;
    recordedCount: number;
    isComplete: boolean;
    clips: Record<string, ClipSavedStatus>;
    updatedAt: string;
}

export interface EvaluationResult {
    sessionId: string;
    finalVerdict: string;
    isAccepted: boolean;
    gates: Record<string, "PASS" | "FAIL">;
    clean: {
        totalClips: number;
        zeroIssueCount: number;
        falsePositiveUtterances: number;
        utteranceFPR: number;
        unrelatedIssueCount: number;
    };
    error: {
        totalClips: number;
        targetDetectedCount: number;
        targetDetectionRate: number;
        targetLocalizedCount: number;
        targetLocalizationRate: number;
        unrelatedIssueCount: number;
    };
    diagnosis: {
        trustedExactDiagnosisCount: number;
        correctTrustedExactDiagnosisCount: number;
        exactDiagnosisPrecision: number;
        abstentionCount: number;
        abstentionRate: number;
    };
    architecture: {
        crottcUnauthorizedIssues: number;
        authorityInvariantViolations: number;
        legacyDetectorUsed: number;
    };
    performance: {
        medianLatencyMs: number;
        p95LatencyMs: number;
        peakVramMb: number;
    };
    failures: string[];
    results: any[];
}

// Helper to resolve API endpoint (supports same-origin Next.js rewrites or direct host URL)
async function getApiBaseUrl(): Promise<string> {
    if (typeof window !== "undefined") {
        try {
            const check = await fetch("/api/v1/real-mic-pack/manifest", { method: "HEAD" });
            if (check.ok || check.status === 405 || check.status === 200) {
                return ""; // Same origin proxy
            }
        } catch {
            // Fallback to direct URL
        }
    }
    return process.env.NEXT_PUBLIC_AI_SERVICE_URL || "http://localhost:8000";
}

export default function RealMicAcceptancePage() {
    const [clips, setClips] = useState<AcceptanceClipDef[]>(FALLBACK_16_CLIPS);
    const [currentIndex, setCurrentIndex] = useState<number>(0);
    const [sessionId, setSessionId] = useState<string>("");
    const [sessionManifest, setSessionManifest] = useState<SessionManifest | null>(null);
    const [loadingManifest, setLoadingManifest] = useState<boolean>(true);
    const [savingClip, setSavingClip] = useState<boolean>(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [evaluating, setEvaluating] = useState<boolean>(false);
    const [evaluationResult, setEvaluationResult] = useState<EvaluationResult | null>(null);
    const [evalError, setEvalError] = useState<string | null>(null);
    const [copiedSession, setCopiedSession] = useState<boolean>(false);
    const [apiBase, setApiBase] = useState<string>("");

    // Audio Recorder
    const recorder = useAudioRecorder({ maxDurationSeconds: 30 });

    // Initialize session and fetch manifest
    useEffect(() => {
        async function init() {
            setLoadingManifest(true);
            try {
                const base = await getApiBaseUrl();
                setApiBase(base);

                // Fetch fixed pack manifest from server
                try {
                    const manifestResp = await fetch(`${base}/api/v1/real-mic-pack/manifest`);
                    if (manifestResp.ok) {
                        const data = await manifestResp.json();
                        if (data.clips && data.clips.length === 16) {
                            setClips(data.clips);
                        }
                    }
                } catch (e) {
                    console.warn("Using fallback local 16-clip definition:", e);
                }

                // Check URL params for session ID or localStorage
                let sId = "";
                if (typeof window !== "undefined") {
                    const urlParams = new URLSearchParams(window.location.search);
                    sId = urlParams.get("session_id") || "";
                }
                if (!sId) {
                    sId = localStorage.getItem("ecsm_real_mic_session_id") || "";
                }
                if (!sId) {
                    const now = new Date();
                    const pad = (n: number) => n.toString().padStart(2, "0");
                    sId = `session_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
                }
                localStorage.setItem("ecsm_real_mic_session_id", sId);
                setSessionId(sId);

                // Fetch session status
                try {
                    const sessionResp = await fetch(`${base}/api/v1/real-mic-pack/session?session_id=${sId}`);
                    if (sessionResp.ok) {
                        const sData: SessionManifest = await sessionResp.json();
                        setSessionManifest(sData);

                        // Auto-advance to first unrecorded clip
                        const firstUnrecorded = FALLBACK_16_CLIPS.findIndex((c) => !sData.clips?.[c.clip_id]?.isRecorded);
                        if (firstUnrecorded !== -1) {
                            setCurrentIndex(firstUnrecorded);
                        }
                    }
                } catch (e) {
                    console.warn("Could not load previous session data:", e);
                }
            } catch (err) {
                console.error("Failed to initialize acceptance session:", err);
            } finally {
                setLoadingManifest(false);
            }
        }
        init();
    }, []);

    const activeClip = clips[currentIndex] || FALLBACK_16_CLIPS[0];
    const isRecorded = Boolean(sessionManifest?.clips?.[activeClip?.clip_id]?.isRecorded);
    const recordedMeta = sessionManifest?.clips?.[activeClip?.clip_id];
    const totalRecorded = sessionManifest?.recordedCount || Object.values(sessionManifest?.clips || {}).filter(c => c.isRecorded).length || 0;
    const isPackComplete = totalRecorded === 16;

    // Save recorded audio with robust contract parsing
    const handleSaveRecording = useCallback(async () => {
        if (!recorder.audioBlob || !activeClip || !sessionId) return;
        setSavingClip(true);
        setSaveError(null);
        try {
            const formData = new FormData();
            formData.append("file", recorder.audioBlob, `${activeClip.clip_id}.webm`);
            formData.append("session_id", sessionId);
            formData.append("clip_id", activeClip.clip_id);
            formData.append(
                "metadata",
                JSON.stringify({
                    group: activeClip.group,
                    targetSentence: activeClip.target_sentence,
                    targetWord: activeClip.target_word,
                    targetWordIndex: activeClip.target_word_index,
                    expectedPhone: activeClip.expected_phone,
                    intentionalSubstitutePhone: activeClip.intentional_substitute_phone,
                    contrastName: activeClip.contrast_name,
                    mimeType: recorder.audioBlob.type || "audio/webm",
                    durationSec: recorder.duration,
                    browser: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
                })
            );

            const resp = await fetch(`${apiBase}/api/v1/real-mic-pack/save`, {
                method: "POST",
                body: formData,
            });

            if (resp.ok) {
                // Parse server JSON response
                let saveResult: any = {};
                try {
                    saveResult = await resp.json();
                } catch (jsonErr) {
                    console.warn("Could not parse save JSON body:", jsonErr);
                }

                const savedSha = saveResult.audioSHA256 || "verified";
                const savedClipId = saveResult.clipId || activeClip.clip_id;

                // Update local sessionManifest state immediately
                setSessionManifest((prev) => {
                    const existingClips = prev?.clips || {};
                    const isAlreadyCounted = existingClips[savedClipId]?.isRecorded;
                    const newRecordedCount = (prev?.recordedCount || Object.values(existingClips).filter(c => c.isRecorded).length) + (isAlreadyCounted ? 0 : 1);

                    return {
                        sessionId: saveResult.sessionId || sessionId,
                        totalClips: 16,
                        recordedCount: newRecordedCount,
                        isComplete: newRecordedCount === 16,
                        clips: {
                            ...existingClips,
                            [savedClipId]: {
                                isRecorded: true,
                                audioSHA256: savedSha,
                                rawAudioPath: saveResult.rawAudioPath,
                                derivedWavPath: saveResult.derivedWavPath,
                                durationSec: saveResult.durationSec || recorder.duration,
                                savedAt: new Date().toISOString(),
                            },
                        },
                        updatedAt: new Date().toISOString(),
                    };
                });

                // Reset local recorder preview
                recorder.reset();

                // Background sync of full session manifest
                try {
                    const sessionResp = await fetch(`${apiBase}/api/v1/real-mic-pack/session?session_id=${sessionId}`);
                    if (sessionResp.ok) {
                        const sData: SessionManifest = await sessionResp.json();
                        setSessionManifest(sData);
                    }
                } catch {
                    // Ignore background sync errors if local state updated
                }

                // Advance to next unrecorded or next index
                if (currentIndex < clips.length - 1) {
                    setCurrentIndex(currentIndex + 1);
                }
            } else {
                let errDetail = "";
                try {
                    const errJson = await resp.json();
                    errDetail = errJson.detail || JSON.stringify(errJson);
                } catch {
                    errDetail = await resp.text();
                }
                const msg = `Server rejected save (HTTP ${resp.status}): ${errDetail || resp.statusText}`;
                setSaveError(msg);
                alert(msg);
            }
        } catch (e: any) {
            console.error("Failed to save audio clip:", e);
            const msg = `Save error: ${e.message || String(e)}`;
            setSaveError(msg);
            alert(msg);
        } finally {
            setSavingClip(false);
        }
    }, [recorder, activeClip, sessionId, currentIndex, clips, apiBase]);

    // Trigger batch evaluation
    const handleRunEvaluation = async () => {
        if (!sessionId) return;
        setEvaluating(true);
        setEvalError(null);
        setEvaluationResult(null);
        try {
            const formData = new FormData();
            formData.append("session_id", sessionId);
            formData.append("http_base_url", "http://localhost:8000");

            const resp = await fetch(`${apiBase}/api/v1/real-mic-pack/evaluate`, {
                method: "POST",
                body: formData,
            });

            if (!resp.ok) {
                let errText = "";
                try {
                    const errData = await resp.json();
                    errText = errData.detail || JSON.stringify(errData);
                } catch {
                    errText = await resp.text();
                }
                throw new Error(`Evaluation failed (HTTP ${resp.status}): ${errText || resp.statusText}`);
            }

            const resData: EvaluationResult = await resp.json();
            setEvaluationResult(resData);
        } catch (e: any) {
            console.error("Batch evaluation failed:", e);
            setEvalError(e.message || "Evaluation failed.");
        } finally {
            setEvaluating(false);
        }
    };

    const handleCopySessionId = () => {
        navigator.clipboard.writeText(sessionId);
        setCopiedSession(true);
        setTimeout(() => setCopiedSession(false), 2000);
    };

    const handleStartNewSession = () => {
        if (confirm("Start a new acceptance session? (Previous recordings will remain saved on disk)")) {
            const now = new Date();
            const pad = (n: number) => n.toString().padStart(2, "0");
            const newId = `session_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            localStorage.setItem("ecsm_real_mic_session_id", newId);
            setSessionId(newId);
            setSessionManifest(null);
            setEvaluationResult(null);
            setCurrentIndex(0);
            recorder.reset();
        }
    };

    if (loadingManifest) {
        return (
            <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-slate-400 font-medium">Connecting to AI Service and loading acceptance pack...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans">
            <div className="max-w-6xl mx-auto space-y-6">
                {/* Header */}
                <div className="bg-slate-900/80 border border-slate-800 backdrop-blur-md rounded-2xl p-6 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-3">
                            <div className="p-2.5 bg-indigo-500/20 text-indigo-400 rounded-xl border border-indigo-500/30">
                                <ShieldCheck className="w-6 h-6" />
                            </div>
                            <div>
                                <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                                    Pronunciation V1 — Final Real-Mic Acceptance
                                    <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                                        ONE-SHOT
                                    </span>
                                </h1>
                                <p className="text-sm text-slate-400 mt-0.5">
                                    Capture once (16 clips) → Persist raw audio → Batch replay → Official verdict.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <div className="bg-slate-950/70 border border-slate-800 px-3.5 py-2 rounded-xl flex items-center gap-2 text-xs">
                            <span className="text-slate-400 font-mono">Session:</span>
                            <span className="text-indigo-400 font-mono font-semibold">{sessionId}</span>
                            <button
                                onClick={handleCopySessionId}
                                className="p-1 hover:text-white text-slate-400 transition"
                                title="Copy Session ID"
                            >
                                {copiedSession ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                        </div>
                        <button
                            onClick={handleStartNewSession}
                            className="text-xs px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition border border-slate-700"
                        >
                            New Session
                        </button>
                    </div>
                </div>

                {/* Progress Bar & Navigation Grid */}
                <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-4">
                    <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2 font-medium">
                            <span>Collection Progress:</span>
                            <span className="text-indigo-400 font-bold">{totalRecorded} / 16</span>
                            <span className="text-xs text-slate-400">({Math.round((totalRecorded / 16) * 100)}%)</span>
                        </div>
                        {isPackComplete ? (
                            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1.5">
                                <CheckCircle2 className="w-3.5 h-3.5" /> All 16 Clips Persisted and Ready for Replay
                            </span>
                        ) : (
                            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1.5">
                                <Clock className="w-3.5 h-3.5" /> Recording in progress ({16 - totalRecorded} remaining)
                            </span>
                        )}
                    </div>

                    {/* Progress Fill */}
                    <div className="w-full bg-slate-950 h-2.5 rounded-full overflow-hidden border border-slate-800/80">
                        <div
                            className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-emerald-400 transition-all duration-300"
                            style={{ width: `${(totalRecorded / 16) * 100}%` }}
                        />
                    </div>

                    {/* 16-Clip Grid Buttons */}
                    <div className="grid grid-cols-8 md:grid-cols-16 gap-1.5 pt-1">
                        {clips.map((c, idx) => {
                            const isDone = Boolean(sessionManifest?.clips?.[c.clip_id]?.isRecorded);
                            const isActive = idx === currentIndex;
                            const isClean = c.group === "CLEAN";

                            return (
                                <button
                                    key={c.clip_id}
                                    onClick={() => {
                                        recorder.reset();
                                        setSaveError(null);
                                        setCurrentIndex(idx);
                                    }}
                                    className={`relative p-2 rounded-xl text-center flex flex-col items-center justify-center transition border ${
                                        isActive
                                            ? "border-indigo-400 bg-indigo-500/20 shadow-lg shadow-indigo-500/10"
                                            : isDone
                                            ? "border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20"
                                            : "border-slate-800 bg-slate-950/60 hover:bg-slate-800/60 text-slate-400"
                                    }`}
                                >
                                    <span className="text-[10px] font-bold">
                                        {isClean ? `clean_${String(idx + 1).padStart(2, "0")}` : `error_${String(idx - 7).padStart(2, "0")}`}
                                    </span>
                                    {isDone && (
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-1" />
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Main Capture Workspace */}
                {activeClip && (
                    <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 md:p-10 shadow-2xl space-y-8 relative overflow-hidden">
                        {/* Background Accent Glow */}
                        <div
                            className={`absolute top-0 right-0 w-96 h-96 rounded-full blur-3xl opacity-10 pointer-events-none ${
                                activeClip.group === "CLEAN" ? "bg-emerald-500" : "bg-amber-500"
                            }`}
                        />

                        {/* Top Metadata */}
                        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-5">
                            <div className="flex items-center gap-3">
                                <span
                                    className={`px-3.5 py-1.5 rounded-xl text-xs font-bold tracking-wide uppercase border ${
                                        activeClip.group === "CLEAN"
                                            ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                                            : "bg-amber-500/20 text-amber-300 border-amber-500/30"
                                    }`}
                                >
                                    {activeClip.group === "CLEAN" ? "Group Clean" : "Group Intentional Error"}
                                </span>
                                <span className="text-slate-400 font-mono text-sm font-semibold">
                                    Clip {currentIndex + 1} of 16 ({activeClip.clip_id})
                                </span>
                            </div>

                            {activeClip.phonetic_focus && (
                                <div className="text-xs font-mono px-3 py-1 bg-slate-950 border border-slate-800 rounded-lg text-slate-300">
                                    Focus: <span className="text-indigo-300 font-bold">{activeClip.phonetic_focus}</span>
                                </div>
                            )}
                        </div>

                        {/* Sentence Display */}
                        <div className="space-y-3 text-center py-4">
                            <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight text-white font-sans leading-tight">
                                {activeClip.target_sentence}
                            </h2>
                        </div>

                        {/* Instruction Card */}
                        <div
                            className={`p-5 rounded-2xl border text-sm leading-relaxed ${
                                activeClip.group === "CLEAN"
                                    ? "bg-emerald-950/30 border-emerald-500/30 text-emerald-200"
                                    : "bg-amber-950/30 border-amber-500/30 text-amber-200"
                            }`}
                        >
                            <div className="flex items-start gap-3">
                                <div className="p-1 rounded bg-black/20 shrink-0 mt-0.5">
                                    {activeClip.group === "CLEAN" ? (
                                        <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                                    ) : (
                                        <Target className="w-5 h-5 text-amber-400" />
                                    )}
                                </div>
                                <div className="space-y-1">
                                    <p className="font-semibold text-base">{activeClip.instruction_en}</p>
                                    <p className="text-xs opacity-80">{activeClip.instruction_vi}</p>
                                    {activeClip.contrast_name && (
                                        <p className="text-xs font-mono font-bold pt-1 text-amber-300">
                                            Contrast Target: Word "{activeClip.target_word}" → Replace /{activeClip.expected_phone}/ with /{activeClip.intentional_substitute_phone}/
                                        </p>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Recording Control Center */}
                        <div className="flex flex-col items-center justify-center gap-6 py-4">
                            {/* Recording Button */}
                            <div className="flex items-center gap-4">
                                {recorder.isRecording ? (
                                    <button
                                        onClick={recorder.stopRecording}
                                        className="w-20 h-20 rounded-full bg-rose-600 hover:bg-rose-500 flex items-center justify-center shadow-lg shadow-rose-600/30 transition-transform active:scale-95 animate-pulse"
                                        title="Stop Recording"
                                    >
                                        <Square className="w-8 h-8 text-white" />
                                    </button>
                                ) : (
                                    <button
                                        onClick={() => {
                                            setSaveError(null);
                                            recorder.startRecording();
                                        }}
                                        disabled={savingClip}
                                        className="w-20 h-20 rounded-full bg-indigo-600 hover:bg-indigo-500 flex items-center justify-center shadow-lg shadow-indigo-600/30 transition-transform active:scale-95"
                                        title="Start Recording"
                                    >
                                        <Mic className="w-8 h-8 text-white" />
                                    </button>
                                )}
                            </div>

                            {/* Timer / Status */}
                            <div className="text-center font-mono">
                                {recorder.isRecording ? (
                                    <div className="flex items-center gap-2 text-rose-400 font-bold text-lg animate-pulse">
                                        <span className="w-3 h-3 rounded-full bg-rose-500" />
                                        Recording: {recorder.formattedDuration}
                                    </div>
                                ) : recorder.audioUrl ? (
                                    <div className="text-slate-300 text-sm">
                                        Captured ({recorder.duration.toFixed(1)}s) — Preview and confirm save below
                                    </div>
                                ) : isRecorded ? (
                                    <div className="text-emerald-400 text-sm font-semibold flex items-center gap-1.5 justify-center">
                                        <CheckCircle2 className="w-4 h-4" /> Already Saved on Disk (SHA: {recordedMeta?.audioSHA256?.substring(0, 10)}...)
                                    </div>
                                ) : (
                                    <div className="text-slate-400 text-sm">
                                        Click microphone to record clip {currentIndex + 1}
                                    </div>
                                )}
                            </div>

                            {/* Error notification if save failed */}
                            {saveError && (
                                <div className="p-3 bg-rose-950/40 border border-rose-500/40 rounded-xl text-rose-300 text-xs flex items-center gap-2 max-w-md">
                                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                                    <span>{saveError}</span>
                                </div>
                            )}

                            {/* Playback Preview if new audio recorded */}
                            {recorder.audioUrl && (
                                <div className="bg-slate-950 border border-slate-800 p-4 rounded-2xl flex flex-col md:flex-row items-center gap-4 w-full max-w-md">
                                    <audio controls src={recorder.audioUrl} className="w-full h-10" />
                                    <button
                                        onClick={handleSaveRecording}
                                        disabled={savingClip}
                                        className="w-full md:w-auto px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl transition shadow-lg shadow-emerald-600/20 shrink-0 flex items-center justify-center gap-2"
                                    >
                                        {savingClip ? (
                                            <>
                                                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                                Persisting...
                                            </>
                                        ) : (
                                            <>
                                                <CheckCircle2 className="w-4 h-4" />
                                                Confirm and Save
                                            </>
                                        )}
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* Navigation Footer */}
                        <div className="flex items-center justify-between border-t border-slate-800/80 pt-6">
                            <button
                                onClick={() => {
                                    recorder.reset();
                                    setSaveError(null);
                                    setCurrentIndex(Math.max(0, currentIndex - 1));
                                }}
                                disabled={currentIndex === 0}
                                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-xl text-sm font-medium transition flex items-center gap-2"
                            >
                                <ArrowLeft className="w-4 h-4" /> Previous
                            </button>

                            <div className="text-xs text-slate-500 font-mono">
                                Clip ID: {activeClip.clip_id}
                            </div>

                            <button
                                onClick={() => {
                                    recorder.reset();
                                    setSaveError(null);
                                    setCurrentIndex(Math.min(clips.length - 1, currentIndex + 1));
                                }}
                                disabled={currentIndex === clips.length - 1}
                                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-xl text-sm font-medium transition flex items-center gap-2"
                            >
                                Next <ArrowRight className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                )}

                {/* Final Batch Replay & Scoring Section */}
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 md:p-8 shadow-2xl space-y-6">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div>
                            <h3 className="text-xl font-bold text-white flex items-center gap-2">
                                <Activity className="w-5 h-5 text-indigo-400" />
                                Final Batch Evaluation and Scoring
                            </h3>
                            <p className="text-sm text-slate-400 mt-1">
                                Replays all 16 persisted clips through the real application HTTP route (<code className="text-indigo-300">POST /api/v1/ecsm/analyze</code>) without per-case blockers.
                            </p>
                        </div>

                        <button
                            onClick={handleRunEvaluation}
                            disabled={evaluating || totalRecorded < 16}
                            className={`px-8 py-3.5 rounded-2xl font-bold text-base transition shadow-xl flex items-center justify-center gap-2 shrink-0 ${
                                isPackComplete
                                    ? "bg-gradient-to-r from-indigo-600 via-purple-600 to-emerald-600 hover:opacity-90 text-white shadow-indigo-500/20 active:scale-95"
                                    : "bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed"
                            }`}
                        >
                            {evaluating ? (
                                <>
                                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                    Replaying 16 Clips on GPU...
                                </>
                            ) : (
                                <>
                                    <Play className="w-5 h-5 fill-current" />
                                    RUN FINAL BATCH EVALUATION
                                </>
                            )}
                        </button>
                    </div>

                    {evalError && (
                        <div className="p-4 bg-rose-950/40 border border-rose-500/40 rounded-2xl text-rose-300 text-sm flex items-start gap-3">
                            <AlertCircle className="w-5 h-5 shrink-0 text-rose-400 mt-0.5" />
                            <div>
                                <p className="font-bold">Evaluation Failed</p>
                                <p className="text-xs opacity-90">{evalError}</p>
                            </div>
                        </div>
                    )}

                    {/* Evaluation Result View */}
                    {evaluationResult && (
                        <div className="space-y-6 pt-4 border-t border-slate-800">
                            {/* Big Verdict Banner */}
                            <div
                                className={`p-6 rounded-2xl border flex flex-col md:flex-row items-center justify-between gap-4 ${
                                    evaluationResult.isAccepted
                                        ? "bg-emerald-950/50 border-emerald-500/40 text-emerald-100 shadow-xl shadow-emerald-500/10"
                                        : "bg-rose-950/50 border-rose-500/40 text-rose-100 shadow-xl shadow-rose-500/10"
                                }`}
                            >
                                <div className="flex items-center gap-4">
                                    <div
                                        className={`p-3 rounded-2xl ${
                                            evaluationResult.isAccepted ? "bg-emerald-500 text-slate-950" : "bg-rose-500 text-white"
                                        }`}
                                    >
                                        {evaluationResult.isAccepted ? (
                                            <ShieldCheck className="w-8 h-8" />
                                        ) : (
                                            <ShieldAlert className="w-8 h-8" />
                                        )}
                                    </div>
                                    <div>
                                        <div className="text-xs font-mono font-bold tracking-wider uppercase opacity-80">
                                            Official Final Acceptance Verdict
                                        </div>
                                        <div className="text-2xl md:text-3xl font-extrabold tracking-tight">
                                            {evaluationResult.finalVerdict}
                                        </div>
                                    </div>
                                </div>

                                <div className="text-right font-mono text-xs text-slate-400">
                                    <div>Median Latency: <span className="text-white font-bold">{evaluationResult.performance.medianLatencyMs}ms</span></div>
                                    <div>P95 Latency: <span className="text-white font-bold">{evaluationResult.performance.p95LatencyMs}ms</span></div>
                                    <div>Peak VRAM: <span className="text-white font-bold">{evaluationResult.performance.peakVramMb}MB</span></div>
                                </div>
                            </div>

                            {/* 8 Acceptance Gates Cards */}
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                {Object.entries(evaluationResult.gates).map(([gate, status]) => (
                                    <div
                                        key={gate}
                                        className={`p-4 rounded-xl border flex items-center justify-between ${
                                            status === "PASS"
                                                ? "bg-emerald-950/20 border-emerald-500/30 text-emerald-200"
                                                : "bg-rose-950/20 border-rose-500/30 text-rose-200"
                                        }`}
                                    >
                                        <span className="text-xs font-mono font-bold">{gate}</span>
                                        <span
                                            className={`text-xs px-2 py-0.5 rounded font-bold uppercase ${
                                                status === "PASS" ? "bg-emerald-500/30 text-emerald-300" : "bg-rose-500/30 text-rose-300"
                                            }`}
                                        >
                                            {status}
                                        </span>
                                    </div>
                                ))}
                            </div>

                            {/* Key Summary Stats Table */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 bg-slate-950/80 p-5 rounded-2xl border border-slate-800 text-xs">
                                <div>
                                    <span className="text-slate-400">Clean Zero-Issues:</span>
                                    <p className="text-base font-bold text-white mt-0.5">{evaluationResult.clean.zeroIssueCount} / 8</p>
                                </div>
                                <div>
                                    <span className="text-slate-400">Target Error Detection:</span>
                                    <p className="text-base font-bold text-white mt-0.5">
                                        {evaluationResult.error.targetDetectedCount} / 8 ({(evaluationResult.error.targetDetectionRate * 100).toFixed(1)}%)
                                    </p>
                                </div>
                                <div>
                                    <span className="text-slate-400">Target Localization:</span>
                                    <p className="text-base font-bold text-white mt-0.5">
                                        {evaluationResult.error.targetLocalizedCount} / 8 ({(evaluationResult.error.targetLocalizationRate * 100).toFixed(1)}%)
                                    </p>
                                </div>
                                <div>
                                    <span className="text-slate-400">Diagnosis Precision:</span>
                                    <p className="text-base font-bold text-white mt-0.5">
                                        {(evaluationResult.diagnosis.exactDiagnosisPrecision * 100).toFixed(1)}%
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
