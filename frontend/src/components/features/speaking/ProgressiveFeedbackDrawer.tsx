"use client";

import React, { useEffect } from "react";
import {
    X,
    Lightbulb,
    CheckCircle2,
    ArrowRight,
    Loader2,
    AlertCircle,
    BookOpen,
    HelpCircle,
    Info,
} from "lucide-react";
import { SpeakingTurnFeedback, TurnCorrection } from "@/services/speakingApi";
import { Button } from "@/components/ui/button";
import { echoSrc } from '@/lib/brand/echoCharacters';

interface ProgressiveFeedbackDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    turnText: string;
    feedback: SpeakingTurnFeedback | null;
    loading: boolean;
    error: string | null;
}

export const ProgressiveFeedbackDrawer: React.FC<ProgressiveFeedbackDrawerProps> = ({
    isOpen,
    onClose,
    turnText,
    feedback,
    loading,
    error,
}) => {
    // Handle Escape key to close
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape" && isOpen) {
                onClose();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const getCorrectionBadge = (type: TurnCorrection["type"] | string) => {
        switch ((type || "").toUpperCase()) {
            case "GRAMMAR":
                return (
                    <span className="px-2.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 text-[10px] font-extrabold uppercase tracking-wider">
                        Ngữ pháp (Grammar)
                    </span>
                );
            case "VOCABULARY":
            case "WORD_CHOICE":
                return (
                    <span className="px-2.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/60 text-purple-700 dark:text-purple-300 text-[10px] font-extrabold uppercase tracking-wider">
                        Từ vựng (Vocabulary)
                    </span>
                );
            case "COLLOCATION":
                return (
                    <span className="px-2.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 text-[10px] font-extrabold uppercase tracking-wider">
                        Cụm từ tự nhiên (Collocation)
                    </span>
                );
            case "PRONUNCIATION":
                return (
                    <span className="px-2.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-300 text-[10px] font-extrabold uppercase tracking-wider">
                        Phát âm (Pronunciation)
                    </span>
                );
            case "FLUENCY":
                return (
                    <span className="px-2.5 py-0.5 rounded-full bg-teal-100 dark:bg-teal-900/60 text-teal-700 dark:text-teal-300 text-[10px] font-extrabold uppercase tracking-wider">
                        Độ trôi chảy (Fluency)
                    </span>
                );
            case "NATURALNESS":
                return (
                    <span className="px-2.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 text-[10px] font-extrabold uppercase tracking-wider">
                        Độ tự nhiên (Naturalness)
                    </span>
                );
            default:
                return (
                    <span className="px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[10px] font-extrabold uppercase tracking-wider">
                        Gợi ý diễn đạt
                    </span>
                );
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs animate-in fade-in duration-200"
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-drawer-title"
        >
            {/* Backdrop click dismiss */}
            <div className="flex-1" onClick={onClose} />

            {/* Slide-out Drawer Panel */}
            <div data-echo-clear="" className="w-full max-w-lg bg-white dark:bg-gray-900 h-full shadow-2xl border-l border-gray-200 dark:border-gray-800 flex flex-col animate-in slide-in-from-right duration-300 z-10">
                {/* Header */}
                <div className="p-5 border-b border-gray-200/80 dark:border-gray-800 flex items-center justify-between gap-3 shrink-0">
                    <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-2xl bg-purple-100 dark:bg-purple-950 text-purple-600 dark:text-purple-400 flex items-center justify-center font-bold">
                            <Lightbulb size={18} />
                        </div>
                        <div>
                            <h2 id="feedback-drawer-title" className="text-base font-extrabold text-gray-900 dark:text-white">
                                Gợi ý cải thiện lượt nói
                            </h2>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                Tập trung vào độ trôi chảy và tự nhiên (Fluency First)
                            </p>
                        </div>
                    </div>

                    <button
                        onClick={onClose}
                        className="w-9 h-9 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center justify-center text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors cursor-pointer"
                        aria-label="Đóng bảng gợi ý"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Body Content */}
                <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6">
                    {/* Utterance Preview Card */}
                    <div className="p-4 rounded-2xl bg-slate-50 dark:bg-gray-800/80 border border-gray-200/80 dark:border-gray-700/80 notranslate" translate="no">
                        <span className="text-[11px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider block mb-1">
                            Câu bạn vừa nói:
                        </span>
                        <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 italic notranslate" translate="no">
                            "{turnText}"
                        </p>
                    </div>

                    {/* Loading State */}
                    {loading && (
                        <div
                            className="flex flex-col items-center justify-center py-12 gap-3 text-center"
                            role="status"
                            aria-live="polite"
                        >
                            <Loader2 className="w-8 h-8 animate-spin text-purple-600" />
                            <p className="text-sm font-medium text-gray-600 dark:text-gray-300">
                                AI Coach đang phân tích cấu trúc ngữ pháp và từ vựng...
                            </p>
                        </div>
                    )}

                    {/* Error State */}
                    {!loading && error && (
                        <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-900 dark:text-amber-200 flex items-start gap-3">
                            <AlertCircle size={18} className="text-amber-600 shrink-0 mt-0.5" />
                            <div>
                                <h4 className="text-xs font-bold uppercase">Tạm thời chưa có gợi ý</h4>
                                <p className="text-xs mt-1 text-amber-800 dark:text-amber-300">
                                    {error}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Feedback Content */}
                    {!loading && !error && feedback && (
                        <div className="space-y-5 animate-in fade-in duration-200" aria-live="polite">
                            {/* Positive Feedback Banner */}
                            {feedback.positiveFeedback && (
                                <div className="p-4 rounded-2xl bg-emerald-50/90 dark:bg-emerald-950/40 border border-emerald-200/80 dark:border-emerald-900/60 flex items-start gap-3 shadow-xs">
                                    <CheckCircle2 size={18} className="text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                                    <div>
                                        <h4 className="text-xs font-extrabold text-emerald-900 dark:text-emerald-200 uppercase tracking-wider">
                                            Điểm nổi bật (Positive Feedback)
                                        </h4>
                                        <p className="text-xs sm:text-sm text-emerald-800 dark:text-emerald-300 mt-1 leading-relaxed">
                                            {feedback.positiveFeedback}
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* Summary Note */}
                            {feedback.summary && (
                                <div className="text-xs sm:text-sm text-gray-600 dark:text-gray-300 leading-relaxed italic border-l-2 border-purple-500 pl-3">
                                    "{feedback.summary}"
                                </div>
                            )}

                            {/* 1-2 High Value Corrections */}
                            <div className="space-y-3 pt-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                                        <img src={echoSrc('social', 24)} alt="EnglishCoach Whale" className="w-3.5 h-3.5 object-contain" />
                                        Gợi ý tinh chỉnh ({feedback.corrections?.length || 0})
                                    </span>
                                </div>

                                {(!feedback.corrections || feedback.corrections.length === 0) ? (
                                    <div className="p-5 rounded-2xl bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 text-center space-y-1">
                                        <div className="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 flex items-center justify-center mx-auto mb-2">
                                            <CheckCircle2 size={16} />
                                        </div>
                                        <p className="text-xs sm:text-sm font-bold text-gray-800 dark:text-gray-200">
                                            Không có lỗi ngữ pháp nào đáng kể!
                                        </p>
                                        <p className="text-xs text-gray-500 dark:text-gray-400">
                                            Bạn đã diễn đạt tự nhiên và đúng trọng tâm. Hãy tiếp tục duy trì nhé!
                                        </p>
                                    </div>
                                ) : (
                                    <div className="space-y-4">
                                        {feedback.corrections.map((corr, idx) => (
                                            <div
                                                key={idx}
                                                className="p-5 rounded-2xl bg-white dark:bg-gray-800 border border-gray-200/90 dark:border-gray-700 shadow-sm space-y-3.5"
                                            >
                                                <div className="flex items-center justify-between">
                                                    {getCorrectionBadge(corr.type)}
                                                    {corr.priority === "HIGH" && (
                                                        <span className="text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase">
                                                            Ưu tiên cao
                                                        </span>
                                                    )}
                                                </div>

                                                {/* Comparison Row */}
                                                <div className="space-y-2 text-xs sm:text-sm notranslate" translate="no">
                                                    <div className="flex items-start gap-2 p-2.5 rounded-xl bg-rose-50/70 dark:bg-rose-950/30 border border-rose-200/50 dark:border-rose-900/40 text-rose-900 dark:text-rose-200 notranslate" translate="no">
                                                        <span className="font-bold shrink-0">Gốc:</span>
                                                        <span className="line-through notranslate" translate="no">{corr.original}</span>
                                                    </div>

                                                    <div className="flex items-start gap-2 p-2.5 rounded-xl bg-emerald-50/80 dark:bg-emerald-950/40 border border-emerald-200/60 dark:border-emerald-900/50 text-emerald-900 dark:text-emerald-200 notranslate" translate="no">
                                                        <span className="font-bold shrink-0">Nên dùng:</span>
                                                        <span className="font-semibold notranslate" translate="no">{corr.suggestion}</span>
                                                    </div>
                                                </div>

                                                {/* Explanation */}
                                                {corr.explanation && (
                                                    <div className="text-xs text-gray-600 dark:text-gray-300 flex items-start gap-2 pt-1">
                                                        <Info size={14} className="text-purple-500 shrink-0 mt-0.5" />
                                                        <span className="leading-relaxed">{corr.explanation}</span>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Mock Notice */}
                            {feedback.isMocked && (
                                <div className="text-[11px] text-gray-400 dark:text-gray-500 text-center pt-2">
                                    (Gợi ý mẫu được tạo trong chế độ luyện tập ngoại tuyến)
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-200/80 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900 shrink-0 flex items-center justify-end">
                    <Button onClick={onClose} className="rounded-xl text-xs font-semibold cursor-pointer">
                        Đã hiểu và Tiếp tục
                    </Button>
                </div>
            </div>
        </div>
    );
};
