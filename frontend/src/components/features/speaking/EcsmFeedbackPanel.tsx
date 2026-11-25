import React, { useState } from 'react';
import {
    CheckCircle2,
    AlertCircle,
    RotateCcw,
    Volume2,
    Sparkles,
    ArrowRight,
    HelpCircle,
    Layers,
    Info,
    Flame,
    Target,
    ListOrdered,
} from 'lucide-react';
import {
    EcsmAnalysisResponse,
    EcsmPrimaryTarget,
    EcsmDrillPlan,
    EcsmWordAssessment,
    PronunciationV2Response,
} from '@/services/speakingApi';
import { PronunciationV2Panel } from './PronunciationV2Panel';

interface LadderStepInfo {
    level: string;
    level_index?: number;
    title_vi: string;
    instructions_vi: string;
    practice_text: string;
    is_active?: boolean;
    is_completed?: boolean;
}

interface EcsmFeedbackPanelProps {
    response: EcsmAnalysisResponse | null;
    isAnalyzing: boolean;
    contentMatchScore?: number | null;
    onStartRetry?: (target: any, drill: any) => void;
    onPlayReference?: () => void;
    onRetryRecording?: () => void;
}

export const EcsmFeedbackPanel: React.FC<EcsmFeedbackPanelProps> = ({
    response,
    isAnalyzing,
    contentMatchScore,
    onStartRetry,
    onPlayReference,
    onRetryRecording,
}) => {
    const [selectedLadderLevel, setSelectedLadderLevel] = useState<string | null>(null);

    if (isAnalyzing) {
        return (
            <div className="rounded-3xl border border-indigo-200 dark:border-indigo-800/60 bg-white/80 dark:bg-gray-800/80 p-8 text-center backdrop-blur-md shadow-sm">
                <div className="inline-flex h-12 w-12 animate-spin items-center justify-center rounded-full border-4 border-indigo-200 dark:border-indigo-900 border-t-indigo-600 mb-4" />
                <h3 className="text-base sm:text-lg font-bold text-gray-900 dark:text-white">
                    Đang phân tích phát âm chi tiết (ECSM)...
                </h3>
                <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 mt-1">
                    Đánh giá âm vị học (acoustic phonetics), trọng âm và ngữ điệu câu.
                </p>
            </div>
        );
    }

    if (!response) {
        return null;
    }

    // Seamless integration: If response is from Pronunciation Engine V2, render V2 panel
    if ((response as any).engine_version || (response as any).engineVersion || (response as any).overall) {
        return (
            <PronunciationV2Panel
                response={response as any}
                isAnalyzing={isAnalyzing}
                onStartRetry={onStartRetry ? (p) => onStartRetry(p, null) : undefined}
                onPlayReference={onPlayReference}
                onRetryRecording={onRetryRecording}
            />
        );
    }

    const { status, assessment, retryPlan, retryComparison, errorCode, errorMessage, assessmentStatus, evidenceCoverage } = response;

    // Handle system or runtime failure status
    if (status === 'FAILED' || status === 'INSUFFICIENT_AUDIO' || assessmentStatus === 'ASSESSMENT_UNAVAILABLE') {
        const isDeviceUnavailable = errorCode === 'DEVICE_UNAVAILABLE' || (errorMessage && errorMessage.includes('READY'));
        const friendlyErrorMessage: Record<string, string> = {
            AUDIO_UNSUPPORTED_FORMAT: 'Định dạng bản thu chưa được hỗ trợ. Hãy thử ghi âm lại.',
            AUDIO_DECODE_FAILED: 'Không thể xử lý bản thu này. Hãy thử ghi âm lại.',
            AUDIO_EMPTY: 'Bản thu chưa có âm thanh. Hãy thử ghi âm lại.',
            AUDIO_TOO_LONG: 'Bản thu quá dài. Hãy thu lại câu ngắn hơn.',
            AUDIO_TOO_LARGE: 'Bản thu quá lớn. Hãy thu lại câu ngắn hơn.',
            AUDIO_INVALID_DURATION: 'Không thể xác định thời lượng bản thu. Hãy thử ghi âm lại.',
            AUDIO_NORMALIZATION_FAILED: 'Đánh giá phát âm tạm thời chưa khả dụng.',
            ECSM_INFERENCE_FAILED: 'Đánh giá phát âm tạm thời chưa khả dụng.',
            INTERNAL_INFERENCE_ERROR: 'Đánh giá phát âm tạm thời chưa khả dụng.',
            UNSUPPORTED_CODEC: 'Định dạng bản thu chưa được hỗ trợ. Hãy thử ghi âm lại.',
        };
        return (
            <div className="rounded-3xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/80 dark:bg-amber-950/40 p-5 sm:p-6 text-amber-950 dark:text-amber-100 shadow-sm space-y-2">
                <div className="flex items-start gap-3">
                    <AlertCircle className="h-6 w-6 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <div>
                        <h4 className="font-bold text-amber-900 dark:text-amber-200 text-sm sm:text-base">
                            {errorCode === 'NO_SPEECH'
                                ? 'Không nhận diện được giọng nói'
                                : isDeviceUnavailable
                                ? 'Đánh giá phát âm chi tiết (ECSM) tạm thời chưa khả dụng'
                                : 'Thông báo đánh giá phát âm'}
                        </h4>
                        <p className="text-xs sm:text-sm text-amber-800 dark:text-amber-300 mt-1 leading-relaxed">
                            {errorCode === 'NO_SPEECH'
                                ? 'Hệ thống chưa thu được âm thanh rõ ràng. Vui lòng thu âm lại trọn vẹn câu mẫu.'
                                : isDeviceUnavailable
                                ? 'Mô hình ngữ âm ECSM đang được khởi động hoặc bận. Bạn vẫn có thể xem bảng đối chiếu từ ngữ (Whisper STT) và nghe lại bản thu của mình.'
                                : (friendlyErrorMessage[errorCode] || 'Đánh giá phát âm tạm thời chưa khả dụng. Bạn vẫn có thể xem nội dung được nhận diện hoặc thử ghi âm lại.')}
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    const words: EcsmWordAssessment[] = assessment?.words || [];
    const primaryTarget: any = (retryPlan as any)?.primary_target || (retryPlan as any)?.primaryTarget;
    const drill: any = (retryPlan as any)?.drill;
    const ladderSteps: LadderStepInfo[] = (retryPlan as any)?.ladder_steps || (retryPlan as any)?.ladderSteps || [];
    const activeLadderLevel: string = selectedLadderLevel || (retryPlan as any)?.ladder_level || (retryPlan as any)?.ladderLevel || 'LEVEL_3_WORD';

    // Content Match & Evidence Gating Policy:
    const isSevereContentMismatch = contentMatchScore != null && contentMatchScore < 50;
    const isPartialContent = contentMatchScore != null && contentMatchScore >= 50 && contentMatchScore < 80;
    const isLowEvidence = evidenceCoverage != null && evidenceCoverage < 0.50;

    let effectiveStatus: 'NO_ISSUE_DETECTED' | 'ISSUE_DETECTED' | 'INSUFFICIENT_EVIDENCE' | 'ASSESSMENT_UNAVAILABLE' | 'PARTIAL' =
        assessmentStatus || (
            (primaryTarget) ? 'ISSUE_DETECTED' : 'NO_ISSUE_DETECTED'
        );

    if (isSevereContentMismatch || isLowEvidence) {
        if (effectiveStatus !== 'ISSUE_DETECTED') {
            effectiveStatus = 'INSUFFICIENT_EVIDENCE';
        }
    } else if (isPartialContent && effectiveStatus === 'NO_ISSUE_DETECTED') {
        effectiveStatus = 'PARTIAL';
    }

    // Extract target details safely
    const targetWord = primaryTarget?.word_str || primaryTarget?.entity_label || primaryTarget?.word || '';
    const expectedPhone = primaryTarget?.expected_phone;
    const observedPhone = primaryTarget?.observed_phone;
    const observedPhoneTrusted = primaryTarget?.observed_phone_trusted === true
        || primaryTarget?.observedPhoneTrusted === true;
    const recurrenceCount = primaryTarget?.recurrence_count || 1;
    const articulatoryInstructionsVi = (retryPlan as any)?.articulatory_instructions_vi || drill?.cue || (retryPlan as any)?.articulatory_instructions || 'Tập trung điều chỉnh khẩu hình chuẩn xác.';
    const minimalPair = (retryPlan as any)?.minimal_pair || (drill?.minimal_pair ? [drill.minimal_pair.target_word, drill.minimal_pair.contrast_word] : null);

    return (
        <div className="space-y-5">
            {/* 1. Retry Comparison Result Banner if present */}
            {retryComparison && (
                <div
                    className={`rounded-3xl p-5 border shadow-sm transition-all ${
                        (retryComparison.comparison_state === 'IMPROVED' || (retryComparison.comparison_state as string) === 'RESOLVED')
                            ? 'bg-emerald-50/90 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/60 text-emerald-950 dark:text-emerald-100'
                            : (retryComparison.comparison_state === 'INCONCLUSIVE' || (retryComparison.comparison_state as string) === 'UNCERTAIN')
                            ? 'bg-sky-50/90 dark:bg-sky-950/40 border-sky-200 dark:border-sky-800/60 text-sky-950 dark:text-sky-100'
                            : 'bg-amber-50/90 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800/60 text-amber-950 dark:text-amber-100'
                    }`}
                >
                    <div className="flex items-start gap-3">
                        {(retryComparison.comparison_state === 'IMPROVED' || (retryComparison.comparison_state as string) === 'RESOLVED') ? (
                            <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                        ) : (
                            <Info className="h-6 w-6 text-sky-600 dark:text-sky-400 shrink-0 mt-0.5" />
                        )}
                        <div className="space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-bold text-sm sm:text-base">
                                    {(retryComparison.comparison_state as string) === 'RESOLVED'
                                        ? '🎉 Bạn đã làm chủ mục tiêu này trong phiên!'
                                        : retryComparison.comparison_state === 'IMPROVED'
                                        ? 'Tiến bộ rõ rệt ở mục tiêu luyện tập!'
                                        : (retryComparison.comparison_state === 'INCONCLUSIVE' || (retryComparison.comparison_state as string) === 'UNCERTAIN')
                                        ? 'Đã ghi nhận lượt thử lại'
                                        : 'Tiếp tục luyện tập mục tiêu này'}
                                </span>
                                {retryComparison.resolved_this_session && (
                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-extrabold bg-emerald-200 dark:bg-emerald-800 text-emerald-800 dark:text-emerald-100">
                                        Đã làm chủ trong phiên
                                    </span>
                                )}
                            </div>
                            <p className="text-xs sm:text-sm opacity-90">
                                {(retryComparison as any).message_vi || retryComparison.message || 'Tiếp tục thử lại để củng cố phản xạ.'}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* 2. Target Phonetic Map (Canonical Sentence Structure & Acoustic Alignment) */}
            <div className="rounded-3xl border border-slate-200/80 dark:border-gray-700/80 bg-white dark:bg-gray-800/90 p-5 sm:p-6 shadow-sm">
                <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-100 dark:border-gray-700/60">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                        <Layers size={14} />
                        Cấu trúc phát âm câu mẫu (Target Phonetic Map)
                    </h4>
                    <span className="text-[11px] font-medium text-gray-400">Đánh giá phát âm ECSM</span>
                </div>
                <div className="flex flex-wrap gap-2.5 items-center">
                    {words.map((w, idx) => {
                        const isIssue = w.status === 'HIGH_CONFIDENCE_ISSUE';
                        const isPossible = w.status === 'POSSIBLE_ISSUE';
                        const isVariant = w.status === 'VALID_VARIANT';

                        return (
                            <span
                                key={`${w.word}_${idx}`}
                                className={`relative inline-flex flex-col items-center px-3.5 py-2 rounded-2xl text-sm sm:text-base font-semibold transition-all ${
                                    isIssue
                                        ? 'bg-rose-50 dark:bg-rose-950/50 border-2 border-rose-400 dark:border-rose-600 text-rose-950 dark:text-rose-100 shadow-xs'
                                        : isPossible
                                        ? 'bg-amber-50 dark:bg-amber-950/40 border border-dashed border-amber-400 dark:border-amber-600 text-amber-950 dark:text-amber-200'
                                        : isVariant
                                        ? 'bg-sky-50 dark:bg-sky-950/40 border border-sky-300 dark:border-sky-700 text-sky-950 dark:text-sky-200'
                                        : 'bg-slate-50 dark:bg-gray-700/50 border border-slate-200 dark:border-gray-600 text-slate-800 dark:text-slate-100'
                                }`}
                            >
                                <span>{w.word}</span>
                                {isIssue && (
                                    <span className="text-[10px] uppercase tracking-wider font-extrabold text-rose-600 dark:text-rose-400 mt-0.5">
                                        Cần cải thiện
                                    </span>
                                )}
                                {isVariant && (
                                    <span className="text-[10px] text-sky-600 dark:text-sky-400 font-medium mt-0.5">
                                        Biến thể hợp lệ
                                    </span>
                                )}
                            </span>
                        );
                    })}
                </div>
            </div>

            {/* 3. Actionable Pedagogical Assessment Card (Gated) */}
            {effectiveStatus === 'INSUFFICIENT_EVIDENCE' ? (
                <div className="rounded-3xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/70 dark:bg-amber-950/30 p-5 sm:p-6 shadow-sm space-y-4">
                    <div className="flex items-start gap-3.5">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-amber-100 dark:bg-amber-900/60 text-amber-600 dark:text-amber-400 mt-0.5">
                            <HelpCircle className="h-5 w-5" />
                        </div>
                        <div className="space-y-1.5">
                            <h4 className="font-extrabold text-amber-950 dark:text-amber-100 text-base">
                                Chưa đủ dữ liệu để đánh giá phát âm cho câu này
                            </h4>
                            <p className="text-xs sm:text-sm text-amber-800 dark:text-amber-300 leading-relaxed">
                                {isSevereContentMismatch
                                    ? `Nội dung bạn nói khác nhiều so với câu mẫu. Hệ thống chỉ đánh giá phát âm chi tiết khi bạn nói bám sát câu mẫu.`
                                    : 'Âm thanh thu được chưa đủ rõ ràng hoặc chưa khớp đầy đủ với câu mẫu để trích xuất đánh giá ngữ âm đáng tin cậy.'}
                            </p>
                            <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">
                                Hãy nghe lại câu mẫu và thu âm lại trọn vẹn câu để nhận phản hồi phát âm chuẩn xác.
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-3 pt-1">
                        {onPlayReference && (
                            <button
                                type="button"
                                onClick={onPlayReference}
                                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-800 text-xs sm:text-sm font-bold text-amber-900 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-gray-700 transition shadow-xs cursor-pointer"
                            >
                                <Volume2 className="h-4 w-4" />
                                Nghe lại câu mẫu
                            </button>
                        )}
                        {onRetryRecording && (
                            <button
                                type="button"
                                onClick={onRetryRecording}
                                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-xs sm:text-sm font-bold text-white transition shadow-sm cursor-pointer"
                            >
                                <RotateCcw className="h-4 w-4" />
                                Thử lại câu này
                            </button>
                        )}
                    </div>
                </div>
            ) : effectiveStatus === 'PARTIAL' ? (
                <div className="rounded-3xl border border-blue-200 dark:border-blue-800/60 bg-blue-50/70 dark:bg-blue-950/30 p-5 sm:p-6 shadow-sm space-y-3">
                    <div className="flex items-start gap-3.5">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-blue-100 dark:bg-blue-900/60 text-blue-600 dark:text-blue-400 mt-0.5">
                            <Info className="h-5 w-5" />
                        </div>
                        <div className="space-y-1.5">
                            <h4 className="font-extrabold text-blue-950 dark:text-blue-100 text-base">
                                Đánh giá phát âm một phần (Partial Assessment)
                            </h4>
                            <p className="text-xs sm:text-sm text-blue-800 dark:text-blue-300 leading-relaxed">
                                Chỉ những phần bạn đã nói khớp với câu mẫu mới được đưa vào phân tích ngữ âm chi tiết. Các từ nhận diện đúng không phát hiện lỗi ngữ âm nghiêm trọng.
                            </p>
                            <p className="text-xs text-blue-700 dark:text-blue-400 font-medium">
                                Hãy luyện tập nói đầy đủ các từ trong câu mẫu để nhận đánh giá toàn diện cả câu.
                            </p>
                        </div>
                    </div>
                </div>
            ) : effectiveStatus === 'ISSUE_DETECTED' && primaryTarget ? (
                <div className="rounded-3xl border-2 border-indigo-200 dark:border-indigo-800/80 bg-gradient-to-br from-indigo-50/40 via-white to-purple-50/30 dark:from-indigo-950/30 dark:via-gray-800 dark:to-purple-950/20 p-5 sm:p-7 shadow-sm space-y-5">
                    {/* Header: Title & Category & Recurrence Badge */}
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2">
                            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xs">
                                <Target className="h-4 w-4" />
                            </span>
                            <div>
                                <h4 className="font-extrabold text-gray-900 dark:text-white text-base">
                                    Mục tiêu sửa lỗi trọng tâm (Primary Focus)
                                </h4>
                                <span className="text-[11px] text-gray-500 dark:text-gray-400">
                                    Mỗi lượt chỉ tập trung sửa 1 điểm quan trọng nhất
                                </span>
                            </div>
                        </div>

                        <div className="flex items-center gap-2">
                            {recurrenceCount > 1 && (
                                <span className="inline-flex items-center gap-1 text-[11px] font-extrabold px-2.5 py-1 rounded-full bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800/50">
                                    <Flame size={12} className="text-amber-600" />
                                    Lặp lại lần {recurrenceCount} trong phiên
                                </span>
                            )}
                            <span className="text-xs font-bold px-3 py-1 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-800 dark:text-indigo-300">
                                {(primaryTarget.issue_type || primaryTarget.issue_category || '').replace(/_/g, ' ')}
                            </span>
                        </div>
                    </div>

                    {/* Main Focus Detail Card */}
                    <div className="rounded-2xl border border-indigo-100 dark:border-indigo-900/60 bg-white/90 dark:bg-gray-900/80 p-4 sm:p-5 space-y-4 shadow-xs">
                        <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-xs sm:text-sm font-semibold text-gray-500 dark:text-gray-400">Từ trọng tâm:</span>
                            <span className="text-lg sm:text-xl font-extrabold text-gray-900 dark:text-white">{targetWord}</span>
                            {expectedPhone && (
                                <span className="text-sm font-mono font-bold px-2 py-0.5 rounded-lg bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300">
                                    /{expectedPhone}/
                                </span>
                            )}
                            {observedPhone && observedPhoneTrusted ? (
                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                    (Ghi nhận âm gần giống: <span className="font-mono font-bold text-rose-600 dark:text-rose-400">/{observedPhone}/</span>)
                                </span>
                            ) : expectedPhone ? (
                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                    Âm /{expectedPhone}/ bạn vừa nói cần luyện tập thêm.
                                </span>
                            ) : null}
                        </div>

                        {/* Articulatory Cue in Vietnamese */}
                        <div className="text-xs sm:text-sm text-gray-700 dark:text-gray-200 bg-indigo-50/70 dark:bg-indigo-950/40 p-4 rounded-xl border border-indigo-100/80 dark:border-indigo-900/40 space-y-1">
                            <div className="text-[11px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                                <Sparkles size={13} />
                                Hướng dẫn khẩu hình và luồng hơi:
                            </div>
                            <p className="font-medium leading-relaxed">{articulatoryInstructionsVi}</p>
                        </div>

                        {/* Minimal Pair Contrast if available */}
                        {minimalPair && Array.isArray(minimalPair) && minimalPair.length >= 2 && (
                            <div className="flex items-center justify-around p-3.5 bg-slate-50 dark:bg-gray-800/80 rounded-xl border border-slate-200/80 dark:border-gray-700 text-sm">
                                <div className="text-center">
                                    <span className="block text-[11px] text-gray-400 uppercase font-bold">Mục tiêu đúng</span>
                                    <span className="font-extrabold text-emerald-700 dark:text-emerald-300">{minimalPair[0]}</span>
                                    {expectedPhone && (
                                        <span className="text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400 block">/{expectedPhone}/</span>
                                    )}
                                </div>
                                <ArrowRight className="h-5 w-5 text-gray-400" />
                                <div className="text-center">
                                    <span className="block text-[11px] text-gray-400 uppercase font-bold">Dễ nhầm lẫn với</span>
                                    <span className="font-bold text-rose-600 dark:text-rose-400">{minimalPair[1]}</span>
                                    {observedPhone && observedPhoneTrusted && (
                                        <span className="text-xs font-mono text-rose-500 dark:text-rose-400 block">/{observedPhone}/</span>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* 5-Level Adaptive Retry Ladder */}
                        {ladderSteps.length > 0 && (
                            <div className="space-y-2 pt-1 border-t border-slate-100 dark:border-gray-800">
                                <div className="flex items-center justify-between text-xs font-bold text-gray-600 dark:text-gray-300">
                                    <span className="flex items-center gap-1.5">
                                        <ListOrdered size={14} className="text-indigo-600" />
                                        Thang luyện tập sửa lỗi (Retry Ladder):
                                    </span>
                                </div>

                                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                                    {ladderSteps.map((step, idx) => {
                                        const isCurrent = step.level === activeLadderLevel || (step.is_active && !selectedLadderLevel);
                                        return (
                                            <button
                                                key={`ladder-${step.level}-${idx}`}
                                                type="button"
                                                onClick={() => setSelectedLadderLevel(step.level)}
                                                className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                                                    isCurrent
                                                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                                                        : 'bg-gray-50 dark:bg-gray-800/60 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-indigo-300'
                                                }`}
                                            >
                                                <div className={`text-[10px] font-extrabold uppercase ${isCurrent ? 'text-indigo-100' : 'text-gray-400'}`}>
                                                    Bậc {idx + 1}
                                                </div>
                                                <div className="text-xs font-bold truncate mt-0.5">
                                                    {step.title_vi}
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Actions: Listen Reference & Record Retry */}
                    <div className="flex flex-wrap gap-3 pt-1">
                        {onPlayReference && (
                            <button
                                type="button"
                                onClick={onPlayReference}
                                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs sm:text-sm font-bold text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition shadow-xs cursor-pointer"
                            >
                                <Volume2 className="h-4 w-4 text-gray-500" />
                                Nghe lại câu mẫu
                            </button>
                        )}
                        {onStartRetry && (
                            <button
                                type="button"
                                onClick={() => onStartRetry(primaryTarget, drill)}
                                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-xs sm:text-sm font-bold text-white transition shadow-sm hover:shadow cursor-pointer"
                            >
                                <RotateCcw className="h-4 w-4" />
                                Thu âm sửa lỗi mục tiêu này
                            </button>
                        )}
                    </div>
                </div>
            ) : (
                <div className="rounded-3xl border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/60 dark:bg-emerald-950/30 p-6 text-center shadow-sm space-y-2">
                    <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400 mx-auto mb-1" />
                    <h4 className="font-extrabold text-emerald-950 dark:text-emerald-100 text-base">Phát âm tốt cho câu mẫu</h4>
                    <p className="text-xs sm:text-sm text-emerald-700 dark:text-emerald-300">
                        Không phát hiện lỗi ngữ âm nào ở mức độ rủi ro cao trong toàn bộ câu mẫu.
                    </p>
                </div>
            )}
        </div>
    );
};
