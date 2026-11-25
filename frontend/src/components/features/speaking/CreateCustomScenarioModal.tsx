"use client";

import React, { useState } from "react";
import { X, Loader2, User, Bot, Target, BookOpen, Clock, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createCustomScenario, SpeakingScenario } from "@/services/speakingApi";
import { VoiceSelector } from "./VoiceSelector";
import { echoSrc } from '@/lib/brand/echoCharacters';

interface CreateCustomScenarioModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: (scenario: SpeakingScenario) => void;
}

const CEFR_OPTIONS = ["A1", "A2", "B1", "B2", "C1", "C2"];

export function CreateCustomScenarioModal({
    isOpen,
    onClose,
    onSuccess,
}: CreateCustomScenarioModalProps) {
    const [topic, setTopic] = useState("");
    const [cefrLevel, setCefrLevel] = useState("B1");
    const [context, setContext] = useState("");
    const [learnerRole, setLearnerRole] = useState("");
    const [aiRole, setAiRole] = useState("");
    const [voiceId, setVoiceId] = useState("us_female");
    const [learnerGoal, setLearnerGoal] = useState("");
    const [targetVocabulary, setTargetVocabulary] = useState("");
    const [desiredTurns, setDesiredTurns] = useState<number | undefined>(6);
    const [estimatedMinutes, setEstimatedMinutes] = useState<number | undefined>(5);

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);

        if (!topic.trim()) {
            setError("Vui lòng nhập chủ đề / tình huống.");
            return;
        }
        if (!context.trim()) {
            setError("Vui lòng nhập bối cảnh tình huống.");
            return;
        }
        if (!learnerRole.trim()) {
            setError("Vui lòng nhập vai của bạn.");
            return;
        }
        if (!aiRole.trim()) {
            setError("Vui lòng nhập vai của AI.");
            return;
        }
        if (!learnerGoal.trim()) {
            setError("Vui lòng nhập mục tiêu hội thoại.");
            return;
        }

        const vocabList = targetVocabulary
            ? targetVocabulary
                  .split(",")
                  .map((v) => v.trim())
                  .filter((v) => v.length > 0)
            : [];

        try {
            setIsSubmitting(true);
            const scenario = await createCustomScenario({
                topic: topic.trim(),
                cefrLevel,
                context: context.trim(),
                learnerRole: learnerRole.trim(),
                aiRole: aiRole.trim(),
                mission: learnerGoal.trim(),
                targetVocabulary: vocabList.length > 0 ? vocabList : undefined,
                targetTurns: desiredTurns ? Number(desiredTurns) : undefined,
                estimatedDuration: estimatedMinutes ? `${estimatedMinutes} phút` : undefined,
                voiceId,
            });
            onSuccess(scenario);
        } catch (err: any) {
            console.error("Failed to generate custom scenario:", err);
            setError(
                err?.response?.data?.message ||
                err?.message ||
                "Không thể tạo tình huống. Vui lòng kiểm tra lại kết nối và thử lại."
            );
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
            <div
                className="bg-white dark:bg-[#0c0f1d] rounded-3xl shadow-2xl shadow-purple-950/40 border border-purple-500/25 w-full max-w-2xl max-h-[90vh] overflow-y-auto"
                role="dialog"
                aria-modal="true"
                aria-labelledby="custom-scenario-title"
            >
                <div className="sticky top-0 bg-white/95 dark:bg-[#0c0f1d]/95 backdrop-blur-md px-6 py-4 border-b border-purple-500/15 flex items-center justify-between z-10 bg-gradient-to-r from-purple-500/10 via-cyan-500/5 to-transparent">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-2xl bg-gradient-to-br from-purple-500/20 to-cyan-500/20 border border-purple-500/30 flex items-center justify-center shadow-xs">
                            <img src={echoSrc('social', 24)} alt="EnglishCoach Whale" className="w-5 h-5 object-contain drop-shadow-[0_0_6px_rgba(168,85,247,0.6)]" />
                        </div>
                        <div>
                            <h2 id="custom-scenario-title" className="text-lg font-extrabold text-gray-900 dark:text-white tracking-tight">
                                Tạo tình huống Role-play riêng
                            </h2>
                            <p className="text-xs text-purple-700/80 dark:text-purple-300/80">
                                AI sẽ thiết lập cấu trúc kịch bản và câu mở đầu theo yêu cầu của bạn
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={isSubmitting}
                        className="p-2 rounded-xl text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer"
                        aria-label="Đóng"
                    >
                        <X size={18} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-6 space-y-5">
                    {error && (
                        <div className="p-3.5 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 text-rose-700 dark:text-rose-300 text-xs font-medium">
                            {error}
                        </div>
                    )}

                    {/* Topic */}
                    <div>
                        <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1.5">
                            Chủ đề / Tình huống <span className="text-rose-500">*</span>
                        </label>
                        <input
                            type="text"
                            required
                            value={topic}
                            onChange={(e) => setTopic(e.target.value)}
                            placeholder="Ví dụ: Phỏng vấn xin việc AI Engineer, Gọi món ở nhà hàng Ý..."
                            className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-gray-50 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                        />
                    </div>

                    {/* Level */}
                    <div>
                        <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1.5">
                            Mức độ CEFR <span className="text-rose-500">*</span>
                        </label>
                        <div className="flex flex-wrap gap-2">
                            {CEFR_OPTIONS.map((lvl) => {
                                const isActive = cefrLevel === lvl;
                                return (
                                    <button
                                        key={lvl}
                                        type="button"
                                        onClick={() => setCefrLevel(lvl)}
                                        className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer ${
                                            isActive
                                                ? "bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-600 text-white shadow-md shadow-purple-600/35 ring-1 ring-purple-400/50 scale-105"
                                                : "bg-gray-100 dark:bg-gray-800/80 text-gray-600 dark:text-gray-300 hover:bg-purple-50 dark:hover:bg-purple-950/40 hover:text-purple-600 dark:hover:text-purple-300 border border-transparent hover:border-purple-300/40"
                                        }`}
                                    >
                                        {lvl}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Context */}
                    <div>
                        <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1.5">
                            Bối cảnh hội thoại <span className="text-rose-500">*</span>
                        </label>
                        <textarea
                            required
                            rows={2}
                            value={context}
                            onChange={(e) => setContext(e.target.value)}
                            placeholder="Ví dụ: Bạn đang có buổi phỏng vấn trực tiếp tại văn phòng một công ty khởi nghiệp AI..."
                            className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-gray-50 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500 resize-none"
                        />
                    </div>

                    {/* Roles: 2 columns */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1.5 flex items-center gap-1.5">
                                <User size={13} className="text-emerald-500" />
                                Vai của tôi (Learner) <span className="text-rose-500">*</span>
                            </label>
                            <input
                                type="text"
                                required
                                value={learnerRole}
                                onChange={(e) => setLearnerRole(e.target.value)}
                                placeholder="Ví dụ: Ứng viên (Candidate)"
                                className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-gray-50 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1.5 flex items-center gap-1.5">
                                <Bot size={13} className="text-purple-500" />
                                Vai của AI (Interlocutor) <span className="text-rose-500">*</span>
                            </label>
                            <input
                                type="text"
                                required
                                value={aiRole}
                                onChange={(e) => setAiRole(e.target.value)}
                                placeholder="Ví dụ: Trưởng nhóm ML (Interviewer)"
                                className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-gray-50 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                            />
                        </div>
                    </div>

                    {/* GIỌNG CỦA AI */}
                    <div>
                        <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1.5 flex items-center justify-between">
                            <span className="flex items-center gap-1.5">
                                <Volume2 size={13} className="text-purple-500" />
                                GIỌNG CỦA AI <span className="text-rose-500">*</span>
                            </span>
                            <span className="text-[11px] font-normal text-gray-400">
                                Bấm biểu tượng loa để nghe thử
                            </span>
                        </label>
                        <VoiceSelector
                            selectedVoiceId={voiceId}
                            onSelectVoice={(v) => setVoiceId(v)}
                            disabled={isSubmitting}
                            compact={true}
                        />
                    </div>

                    {/* Learner Goal / Mission */}
                    <div>
                        <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1.5 flex items-center gap-1.5">
                            <Target size={13} className="text-amber-500" />
                            Mục tiêu hội thoại <span className="text-rose-500">*</span>
                        </label>
                        <textarea
                            required
                            rows={2}
                            value={learnerGoal}
                            onChange={(e) => setLearnerGoal(e.target.value)}
                            placeholder="Ví dụ: Giới thiệu bản thân, giải thích 1 dự án nổi bật và đặt 2 câu hỏi cho nhà tuyển dụng..."
                            className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-gray-50 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500 resize-none"
                        />
                    </div>

                    {/* Target Vocabulary (Optional) */}
                    <div>
                        <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1.5 flex items-center gap-1.5">
                            <BookOpen size={13} className="text-indigo-500" />
                            Từ / Cụm từ muốn luyện (Tùy chọn, phân tách bằng dấu phẩy)
                        </label>
                        <input
                            type="text"
                            value={targetVocabulary}
                            onChange={(e) => setTargetVocabulary(e.target.value)}
                            placeholder="Ví dụ: pipeline, fine-tuning, latency, scalable, benchmark"
                            className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-gray-50 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                        />
                    </div>

                    {/* Desired Turns & Minutes (Optional) */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1.5 flex items-center gap-1.5">
                                <Clock size={13} className="text-gray-400" />
                                Số lượt mong muốn (Tùy chọn)
                            </label>
                            <input
                                type="number"
                                min={2}
                                max={20}
                                value={desiredTurns || ""}
                                onChange={(e) => setDesiredTurns(e.target.value ? parseInt(e.target.value, 10) : undefined)}
                                placeholder="6 lượt"
                                className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-gray-50 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1.5 flex items-center gap-1.5">
                                <Clock size={13} className="text-gray-400" />
                                Thời lượng ước tính (Tùy chọn, phút)
                            </label>
                            <input
                                type="number"
                                min={1}
                                max={30}
                                value={estimatedMinutes || ""}
                                onChange={(e) => setEstimatedMinutes(e.target.value ? parseInt(e.target.value, 10) : undefined)}
                                placeholder="5 phút"
                                className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-gray-50 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                            />
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="pt-2 flex items-center justify-end gap-3 border-t border-gray-100 dark:border-gray-800">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={onClose}
                            disabled={isSubmitting}
                            className="rounded-xl cursor-pointer transition-all duration-200 active:scale-[0.985] hover:bg-gray-100 dark:hover:bg-gray-800 text-xs font-semibold px-4 py-2.5"
                        >
                            Hủy
                        </Button>
                        <Button
                            type="submit"
                            disabled={isSubmitting}
                            className="rounded-xl bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold gap-2 cursor-pointer shadow-lg shadow-purple-600/30 transition-all duration-200 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-purple-500 disabled:opacity-50 disabled:pointer-events-none px-6 py-2.5 text-xs"
                        >
                            {isSubmitting ? (
                                <>
                                    <Loader2 size={16} className="animate-spin" />
                                    <span>Đang tạo tình huống...</span>
                                </>
                            ) : (
                                <>
                                    <img src={echoSrc('social', 24)} alt="EnglishCoach Whale" className="w-4 h-4 object-contain drop-shadow-[0_0_6px_rgba(255,255,255,0.7)]" />
                                    <span>Tạo kịch bản AI</span>
                                </>
                            )}
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
}
