"use client";

import React, { useState, useRef, useEffect } from "react";
import {
    Play,
    Pause,
    Check,
    X,
    Layers,
    Info,
} from "lucide-react";
import { WordAlignmentItem } from "@/services/speakingApi";
import { finiteDurationOrNull, formatAudioTime } from "@/lib/audioDuration.mjs";
import { echoSrc } from '@/lib/brand/echoCharacters';

interface ShadowingYouSaidPanelProps {
    transcription: string;
    accuracyScore?: number | null;
    wordAlignment?: WordAlignmentItem[];
    audioUrl?: string | null;
    audioDuration?: number;
    feedback?: string | null;
    isMocked?: boolean;
    className?: string;
}

interface ContentMatchBand {
    label: string;
    badgeBg: string;
    badgeText: string;
    badgeBorder: string;
    description: string;
}

export const getContentMatchBand = (percentage: number): ContentMatchBand => {
    if (percentage >= 90) {
        return {
            label: "Khớp rất cao",
            badgeBg: "bg-emerald-600 text-white border-emerald-700",
            badgeText: "text-emerald-700 dark:text-emerald-300",
            badgeBorder: "border-emerald-200 dark:border-emerald-800",
            description: "Bạn đã nói chính xác gần như toàn bộ từ vựng trong câu mẫu.",
        };
    }
    if (percentage >= 80) {
        return {
            label: "Khớp tốt",
            badgeBg: "bg-teal-600 text-white border-teal-700",
            badgeText: "text-teal-700 dark:text-teal-300",
            badgeBorder: "border-teal-200 dark:border-teal-800",
            description: "Bạn đã nói đúng hầu hết các từ quan trọng trong câu mẫu.",
        };
    }
    if (percentage >= 65) {
        return {
            label: "Khớp khá",
            badgeBg: "bg-blue-600 text-white border-blue-700",
            badgeText: "text-blue-700 dark:text-blue-300",
            badgeBorder: "border-blue-200 dark:border-blue-800",
            description: "Nội dung nhận diện ở mức khá. Một vài từ bị thiếu hoặc phát âm khác câu mẫu.",
        };
    }
    if (percentage >= 50) {
        return {
            label: "Khớp trung bình",
            badgeBg: "bg-amber-600 text-white border-amber-700",
            badgeText: "text-amber-800 dark:text-amber-300",
            badgeBorder: "border-amber-200 dark:border-amber-800",
            description: "Độ khớp một nửa câu mẫu. Bạn nên luyện tập thêm để nói đủ các cụm từ.",
        };
    }
    return {
        label: "Cần luyện lại",
        badgeBg: "bg-rose-600 text-white border-rose-700",
        badgeText: "text-rose-700 dark:text-rose-300",
        badgeBorder: "border-rose-200 dark:border-rose-800",
        description: "Chưa khớp đủ nội dung với câu mẫu. Hãy nghe lại audio mẫu và thử lại.",
    };
};

export function ShadowingYouSaidPanel({
    transcription,
    accuracyScore,
    wordAlignment,
    audioUrl,
    audioDuration,
    feedback,
    isMocked = false,
    className = "",
}: ShadowingYouSaidPanelProps) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [totalDuration, setTotalDuration] = useState<number | null>(null);

    // Initialize learner audio
    useEffect(() => {
        if (!audioUrl) {
            audioRef.current = null;
            setIsPlaying(false);
            setCurrentTime(0);
            setTotalDuration(null);
            return;
        }

        const audio = new Audio(audioUrl);
        audioRef.current = audio;

        const updateDuration = () => {
            setTotalDuration(
                finiteDurationOrNull(audio.duration) ?? finiteDurationOrNull(audioDuration)
            );
        };

        const onTimeUpdate = () => {
            if (Number.isFinite(audio.currentTime) && audio.currentTime >= 0) {
                setCurrentTime(audio.currentTime);
            }
        };

        const onEnded = () => {
            setIsPlaying(false);
            setCurrentTime(0);
        };

        audio.addEventListener("loadedmetadata", updateDuration);
        audio.addEventListener("durationchange", updateDuration);
        audio.addEventListener("canplay", updateDuration);
        audio.addEventListener("timeupdate", onTimeUpdate);
        audio.addEventListener("ended", onEnded);

        return () => {
            audio.pause();
            audio.removeEventListener("loadedmetadata", updateDuration);
            audio.removeEventListener("durationchange", updateDuration);
            audio.removeEventListener("canplay", updateDuration);
            audio.removeEventListener("timeupdate", onTimeUpdate);
            audio.removeEventListener("ended", onEnded);
            audio.removeAttribute("src");
            audio.load();
            if (audioRef.current === audio) audioRef.current = null;
        };
    }, [audioUrl, audioDuration]);

    const togglePlay = () => {
        if (!audioRef.current) return;
        if (isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
        } else {
            audioRef.current.play().then(() => {
                setIsPlaying(true);
            }).catch((err) => {
                console.error("Failed to play learner audio:", err);
                setIsPlaying(false);
            });
        }
    };

    const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!audioRef.current || totalDuration == null) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, clickX / rect.width));
        const seekSec = pct * totalDuration;
        audioRef.current.currentTime = seekSec;
        setCurrentTime(seekSec);
    };

    const progressPct = totalDuration == null
        ? 0
        : Math.max(0, Math.min(100, (currentTime / totalDuration) * 100));
    const scoreVal = typeof accuracyScore === "number" && Number.isFinite(accuracyScore) ? Math.round(accuracyScore) : null;
    const band = scoreVal != null ? getContentMatchBand(scoreVal) : null;

    return (
        <div
            id="shadowing-you-said-panel"
            className={`w-full rounded-3xl bg-slate-50/90 dark:bg-gray-800/90 border border-slate-200 dark:border-gray-700/80 shadow-md p-5 sm:p-7 space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300 ${className}`}
            role="region"
            aria-label="Bảng đối chiếu nội dung từ ngữ nhận diện"
        >
            {/* ── Section Header ── */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200/80 dark:border-gray-700/80">
                <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-blue-600 text-white flex items-center justify-center shadow-xs">
                        <Layers size={16} />
                    </div>
                    <div>
                        <h3 className="text-sm sm:text-base font-extrabold text-gray-900 dark:text-gray-100 uppercase tracking-wide">
                            Đối chiếu nội dung bạn nói (You Said)
                        </h3>
                        <p className="text-[11px] text-gray-500 dark:text-gray-400">
                            Nhận diện qua Whisper STT • Phân tích mức độ khớp từ vựng
                        </p>
                    </div>
                </div>

                {/* Content Match Multi-Level Score Pill */}
                <div className="flex items-center gap-2">
                    {isMocked && (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-300 border border-amber-300/40">
                            Mock STT
                        </span>
                    )}
                    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl ${band ? band.badgeBg : "bg-slate-600 text-white border-slate-700"} font-extrabold text-xs shadow-xs border`}>
                        <img src={echoSrc('social', 24)} alt="Echo" className="w-3.5 h-3.5 object-contain" />
                        <span>{scoreVal != null ? `Khớp nội dung ${scoreVal}%` : "Khớp nội dung —"}</span>
                    </div>
                </div>
            </div>

            {/* ── Audio Playback Bar for Learner Audio ── */}
            {audioUrl && (
                <div className="p-3.5 rounded-2xl bg-white dark:bg-gray-900/90 border border-slate-200 dark:border-gray-700/60 shadow-xs flex items-center gap-3.5">
                    <button
                        type="button"
                        onClick={togglePlay}
                        className="w-10 h-10 rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-95 text-white flex items-center justify-center shadow-sm transition-all cursor-pointer shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                        aria-label={isPlaying ? "Tạm dừng nghe lại giọng bạn" : "Nghe lại giọng bạn vừa thu âm"}
                    >
                        {isPlaying ? <Pause size={18} /> : <Play size={18} className="ml-0.5 fill-current" />}
                    </button>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between text-[11px] font-mono text-gray-500 dark:text-gray-400 mb-1 font-semibold">
                            <span>Nghe lại bản thu âm của bạn</span>
                            <span>
                                {formatAudioTime(currentTime, "0:00")} / {formatAudioTime(totalDuration)}
                            </span>
                        </div>

                        {/* Interactive Seek Bar */}
                        <div
                            onClick={handleSeek}
                            className="h-2 w-full bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden cursor-pointer relative"
                        >
                            <div
                                className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-100"
                                style={{ width: `${progressPct}%` }}
                            ></div>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Word-by-Word Alignment Breakdown ── */}
            {wordAlignment && wordAlignment.length > 0 && (
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-wider text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                            <Layers size={13} />
                            Đối chiếu từ ngữ từng vị trí trong câu
                        </span>
                    </div>

                    <div
                        className="p-4 rounded-2xl bg-white dark:bg-gray-900/90 border border-slate-200/80 dark:border-gray-700/60 flex flex-wrap gap-2 items-center leading-relaxed notranslate"
                        translate="no"
                        role="region"
                        aria-label="Chi tiết so khớp từng từ"
                    >
                        {wordAlignment.map((item, idx) => {
                            const status = (item.status || "").toUpperCase();

                            if (status === "MATCH" || status === "EXACT_MATCH") {
                                return (
                                    <span
                                        key={idx}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-emerald-100 dark:bg-emerald-950/80 text-emerald-900 dark:text-emerald-200 font-bold text-sm border border-emerald-300/70 dark:border-emerald-700/60 shadow-2xs"
                                    >
                                        <Check size={13} className="text-emerald-600 dark:text-emerald-400" />
                                        <span>{item.word}</span>
                                        <span className="sr-only">(Khớp đúng từ)</span>
                                    </span>
                                );
                            }

                            if (status === "MISSING_WORD") {
                                return (
                                    <del
                                        key={idx}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-amber-100/90 dark:bg-amber-950/70 text-amber-900 dark:text-amber-200 line-through font-semibold text-sm border border-amber-300/70 dark:border-amber-700/60 shadow-2xs"
                                        title="Từ này có trong câu mẫu nhưng bạn chưa đọc"
                                    >
                                        <span>{item.word}</span>
                                        <span className="sr-only">(Từ bị thiếu)</span>
                                    </del>
                                );
                            }

                            if (status === "WRONG_WORD") {
                                return (
                                    <span
                                        key={idx}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-rose-100/90 dark:bg-rose-950/70 text-rose-900 dark:text-rose-200 font-semibold text-sm border border-rose-300/70 dark:border-rose-700/60 shadow-2xs"
                                        title={`Nhận diện: ${item.spokenWord || item.word} (câu mẫu: ${item.expectedWord || item.word})`}
                                    >
                                        <X size={13} className="text-rose-600 dark:text-rose-400" />
                                        <span>{item.spokenWord || item.word}</span>
                                        {item.expectedWord && (
                                             <span className="text-[11px] opacity-80 font-normal ml-0.5">
                                                (mẫu: {item.expectedWord})
                                            </span>
                                        )}
                                        <span className="sr-only">(Nhận diện từ khác)</span>
                                    </span>
                                );
                            }

                            if (status === "EXTRA_WORD") {
                                return (
                                    <span
                                        key={idx}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-purple-100 dark:bg-purple-950/80 text-purple-900 dark:text-purple-200 font-medium text-sm border border-purple-300/70 dark:border-purple-700/60 shadow-2xs"
                                    >
                                        <span>+{item.spokenWord || item.word}</span>
                                        <span className="sr-only">(Từ nói thêm)</span>
                                    </span>
                                );
                            }

                            // NEAR_MATCH / MINOR_SPELLING
                            return (
                                <span
                                    key={idx}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-yellow-100 dark:bg-yellow-950/80 text-yellow-900 dark:text-yellow-200 font-medium text-sm border border-yellow-300/70 dark:border-yellow-700/60 shadow-2xs"
                                >
                                    <span>{item.word}</span>
                                    {item.spokenWord && item.spokenWord !== item.word && (
                                        <span className="text-[11px] opacity-80 font-normal">
                                            (~{item.spokenWord})
                                        </span>
                                    )}
                                    <span className="sr-only">(Gần khớp)</span>
                                </span>
                            );
                        })}
                    </div>

                    {/* Legend */}
                    <div className="flex flex-wrap items-center gap-3.5 text-[11px] text-gray-500 dark:text-gray-400 pt-1 px-1">
                        <span className="flex items-center gap-1">
                            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span> Khớp đúng từ
                        </span>
                        <span className="flex items-center gap-1">
                            <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span> Bị thiếu
                        </span>
                        <span className="flex items-center gap-1">
                            <span className="w-2.5 h-2.5 rounded-full bg-rose-500"></span> Khác câu mẫu
                        </span>
                        <span className="flex items-center gap-1">
                            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500"></span> Gần khớp
                        </span>
                        <span className="flex items-center gap-1">
                            <span className="w-2.5 h-2.5 rounded-full bg-purple-500"></span> Từ nói thêm
                        </span>
                    </div>
                </div>
            )}

            {/* ── Recognized STT Transcript ── */}
            <div className="space-y-1 notranslate" translate="no">
                <span className="text-xs font-bold uppercase tracking-wider text-gray-600 dark:text-gray-300 block">
                    Văn bản nhận diện giọng nói (Whisper STT):
                </span>
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-900/80 p-3.5 rounded-xl border border-slate-200 dark:border-gray-700/60 break-words leading-relaxed notranslate" translate="no">
                    "{transcription || "..."}"
                </div>
            </div>

            {/* ── Honest Multi-Level Content Feedback Banner ── */}
            <div className="p-3.5 rounded-2xl bg-blue-50/80 dark:bg-blue-950/30 border border-blue-200/80 dark:border-blue-800/50 text-left space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-blue-800 dark:text-blue-300">
                    <Info size={13} />
                    <span>Đánh giá độ khớp nội dung: {band ? band.label : "Chưa có dữ liệu"}</span>
                </div>
                <p className="text-xs sm:text-sm text-blue-900 dark:text-blue-100">
                    {feedback || (band ? band.description : "Chưa đủ dữ liệu nhận diện để tính độ khớp nội dung.")}
                </p>
            </div>

            {/* ── Semantic Distinction Notice ── */}
            <div className="text-[11px] text-gray-400 dark:text-gray-500 italic pt-1 border-t border-slate-100 dark:border-gray-700/40">
                Lưu ý: Bảng này chỉ đo lường độ khớp từ ngữ nhận diện qua Whisper STT. Điểm phát âm chuyên sâu (âm vị, trọng âm, ngữ điệu, độ trôi chảy) được phân tích độc lập bởi Pronunciation V2.2 ở bảng chi tiết.
            </div>
        </div>
    );
}
