import React, { useEffect, useState } from 'react';
import {
    CheckCircle2,
    AlertCircle,
    RotateCcw,
    Volume2,
    Target,
    Activity,
    Gauge,
    Info,
} from 'lucide-react';
import { PronunciationV2Response, PronunciationV2Priority } from '@/services/speakingApi';

interface PronunciationV2PanelProps {
    response: PronunciationV2Response | null;
    isAnalyzing?: boolean;
    isRoleplay?: boolean;
    hideContentMatch?: boolean;
    onStartRetry?: (priority: PronunciationV2Priority) => void;
    onPlayReference?: () => void;
    onRetryRecording?: () => void;
}

const QUALITY_CLASS_LABEL_VI: Record<string, string> = {
    ACCEPTABLE: 'Đạt chuẩn',
    WEAK: 'Hơi lệch',
    ERROR: 'Cần sửa',
    UNCERTAIN: 'Chưa đủ bằng chứng',
};

const WORD_UNSCORED_STATUSES = new Set(['OFF_SCRIPT', 'UNCERTAIN', 'NOT_SCORED', 'OMITTED']);

function getQualityClassLabel(qualityClass?: string | null): string {
    if (!qualityClass) return 'Chưa đủ bằng chứng';
    return QUALITY_CLASS_LABEL_VI[qualityClass.toUpperCase()] ?? 'Chưa đủ bằng chứng';
}

function getAbstentionReasonVi(reason?: string | null, scope?: string | null): string {
    const r = (reason || '').toUpperCase();
    const s = (scope || '').toUpperCase();
    if (r.includes('OFF_SCRIPT') || r.includes('QUARANTIN')) return 'Nội dung nói chưa khớp với câu mẫu.';
    if (r.includes('SILENT') || r.includes('NO_SPEECH')) return 'Không nhận diện được tín hiệu giọng nói rõ ràng.';
    if (r.includes('SHORT')) return 'Thời lượng nói quá ngắn để đánh giá chính xác.';
    if (r.includes('CLIP')) return 'Âm lượng đầu vào bị vỡ tiếng.';
    if (r.includes('NOIS') || r.includes('SNR') || r.includes('QUIET')) return 'Tín hiệu âm thanh yếu hoặc có nhiều tạp âm nền.';
    if (r.includes('INSUFFICIENT') || r.includes('ALIGN') || r.includes('LOW_CONFIDENCE')) {
        return 'Chưa đủ bằng chứng âm học để kết luận chắc chắn.';
    }
    if (s.includes('STRESS')) return 'Chưa đủ từ đa âm tiết rõ ràng để chấm trọng âm.';
    if (s.includes('PROSODY') || s.includes('INTONATION')) return 'Chưa đủ dữ liệu ngữ điệu để kết luận.';
    return 'Hệ thống tạm bỏ qua phần chưa đủ độ tin cậy để tránh chấm sai.';
}

function formatPillarScore(score?: number | null): string {
    return typeof score === 'number' && Number.isFinite(score) ? String(Math.round(score)) : '—';
}

export const PronunciationV2Panel: React.FC<PronunciationV2PanelProps> = ({
    response,
    isAnalyzing = false,
    isRoleplay = false,
    hideContentMatch = false,
    onStartRetry,
    onPlayReference,
    onRetryRecording,
}) => {
    const [selectedWordIdx, setSelectedWordIdx] = useState<number | null>(null);

    useEffect(() => {
        setSelectedWordIdx(null);
    }, [response?.requestId]);

    if (isAnalyzing) {
        return (
            <div className="rounded-3xl border border-indigo-200 dark:border-indigo-800/60 bg-white/80 dark:bg-gray-800/80 p-8 text-center backdrop-blur-md shadow-sm">
                <div className="inline-flex h-12 w-12 animate-spin items-center justify-center rounded-full border-4 border-indigo-200 dark:border-indigo-900 border-t-indigo-600 mb-4" />
                <h3 className="text-base sm:text-lg font-bold text-gray-900 dark:text-white">
                    Đang phân tích phát âm chuyên sâu...
                </h3>
                <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 mt-1">
                    Đánh giá toàn diện: Âm vị học, trọng âm từ, ngữ điệu F0, nhịp điệu và độ trôi chảy tự nhiên.
                </p>
            </div>
        );
    }

    if (!response) {
        return null;
    }

    const { status, overall, audioQuality, contentFidelity, connectedSpeech, words, priorities, abstentions, timing } = response;
    const safeWords = Array.isArray(words) ? words : [];
    const safePriorities = Array.isArray(priorities) ? priorities : [];
    const safeAbstentions = Array.isArray(abstentions) ? abstentions : [];

    const fidelityStatus = (contentFidelity?.fidelityStatus ?? contentFidelity?.status ?? '').toUpperCase();
    const rawMatchPct = contentFidelity?.matchPercentage ?? contentFidelity?.contentMatchPercentage;
    const matchPct = typeof rawMatchPct === 'number' && Number.isFinite(rawMatchPct) ? Math.round(rawMatchPct) : null;

    if (status === 'FAILED') {
        return (
            <div className="rounded-2xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/70 dark:bg-amber-950/30 p-4 text-sm text-amber-900 dark:text-amber-200 flex items-center justify-between gap-3">
                <span>Chưa thể phân tích phát âm cho bản thu này.</span>
                {onRetryRecording && (
                    <button
                        type="button"
                        onClick={onRetryRecording}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-xs font-bold text-white transition cursor-pointer shrink-0"
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Thu lại
                    </button>
                )}
            </div>
        );
    }

    // Handle Abstention / Audio Failure BEFORE checking !overall (abstained responses may omit overall scores)
    if (status === 'ABSTAINED' || audioQuality?.qualityStatus === 'UNUSABLE') {
        const warnings = audioQuality?.warnings || [];
        const abstentionReason = (response.abstentionReason || '').toUpperCase();
        const itemReasons = safeAbstentions.map((item) => (item.reason || '').toUpperCase());

        const isOffscript =
            fidelityStatus === 'OFF_SCRIPT' ||
            fidelityStatus === 'QUARANTINED' ||
            abstentionReason === 'OFF_SCRIPT' ||
            itemReasons.some((r) => r.includes('OFF_SCRIPT') || r.includes('QUARANTIN'));
        const isTooShort =
            warnings.includes('TOO_SHORT') ||
            abstentionReason.includes('SHORT') ||
            (typeof audioQuality?.durationSec === 'number' && audioQuality.durationSec > 0 && audioQuality.durationSec < 0.3);
        const isNoSpeech =
            warnings.includes('NO_SPEECH') ||
            Boolean(audioQuality?.isSilent) ||
            abstentionReason.includes('SILENT') ||
            abstentionReason.includes('NO_SPEECH') ||
            abstentionReason === 'AUDIO_UNUSABLE_OR_SILENT';
        const isClipped =
            warnings.includes('CLIPPED') ||
            Boolean(audioQuality?.isClipping) ||
            abstentionReason.includes('CLIP');
        const isTooQuiet =
            warnings.includes('TOO_QUIET') ||
            abstentionReason.includes('QUIET');
        const isNoisy =
            warnings.includes('LOW_SNR') ||
            warnings.includes('NOISY') ||
            warnings.includes('EXCESSIVE_NOISE') ||
            abstentionReason.includes('NOIS') ||
            abstentionReason.includes('SNR');
        const isInsufficientWords =
            abstentionReason.includes('INSUFFICIENT') ||
            abstentionReason.includes('NOT_SCORED') ||
            abstentionReason.includes('NO_SCORED') ||
            itemReasons.some((r) => r.includes('INSUFFICIENT') || r.includes('NOT_SCORED'));

        let abstentionTitle = 'Chưa đủ bằng chứng âm học để chấm điểm';
        let abstentionBody = 'Hệ thống tạm dừng chấm điểm bản thu này để tránh đánh giá thiếu chính xác. Vui lòng thử thu âm lại rõ ràng hơn.';

        if (isOffscript) {
            abstentionTitle = 'Nội dung nói chưa khớp với câu mẫu';
            abstentionBody = 'Hệ thống nhận thấy câu nói của bạn khác biệt so với văn bản yêu cầu. Để đảm bảo tính chính xác, hệ thống từ chối chấm điểm thay vì phạt điểm oan.';
        } else if (isTooShort) {
            abstentionTitle = 'Bản thu âm quá ngắn';
            abstentionBody = 'Đoạn thu âm quá ngắn để phân tích âm vị và ngữ điệu. Hãy nói trọn vẹn câu rồi thử lại.';
        } else if (isClipped) {
            abstentionTitle = 'Âm lượng thu quá lớn gây vỡ tiếng';
            abstentionBody = 'Tín hiệu thu bị rè hoặc vỡ tiếng. Hãy giảm âm lượng micro hoặc đặt micro xa miệng hơn một chút.';
        } else if (isNoisy) {
            abstentionTitle = 'Môi trường thu có nhiều tạp âm';
            abstentionBody = 'Tiếng ồn nền lớn làm giảm độ tin cậy của phân tích âm học. Hãy thử thu lại ở nơi yên tĩnh hơn.';
        } else if (isTooQuiet) {
            abstentionTitle = 'Giọng thu quá nhỏ';
            abstentionBody = 'Âm lượng giọng nói chưa đủ rõ để phân tích. Hãy nói to hơn hoặc đưa micro lại gần hơn.';
        } else if (isNoSpeech) {
            abstentionTitle = 'Không nhận diện được âm thanh giọng nói';
            abstentionBody = 'Micro chưa thu được tiếng nói rõ ràng. Hãy kiểm tra micro và thu âm lại trọn vẹn câu mẫu.';
        } else if (isInsufficientWords) {
            abstentionTitle = 'Chưa đủ từ hợp lệ để chấm điểm';
            abstentionBody = 'Hệ thống chưa nhận diện đủ số từ có thể đối chiếu để chấm điểm đáng tin cậy. Hãy đọc rõ từng từ và thử lại.';
        }

        return (
            <div className="rounded-3xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/80 dark:bg-amber-950/40 p-6 text-amber-950 dark:text-amber-100 shadow-sm space-y-4">
                <div className="flex items-start gap-3">
                    <AlertCircle className="h-6 w-6 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <div>
                        <h4 className="font-bold text-amber-900 dark:text-amber-200 text-base">
                            {abstentionTitle}
                        </h4>
                        <p className="text-xs sm:text-sm text-amber-800 dark:text-amber-300 mt-1 leading-relaxed">
                            {abstentionBody}
                        </p>
                        {!isRoleplay && !hideContentMatch && matchPct != null && isOffscript && (
                            <p className="text-xs font-semibold text-amber-900 dark:text-amber-200 mt-1.5">
                                Độ khớp nội dung đo được: {matchPct}%
                            </p>
                        )}
                    </div>
                </div>

                {onRetryRecording && (
                    <button
                        type="button"
                        onClick={onRetryRecording}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-xs sm:text-sm font-bold text-white transition shadow-xs cursor-pointer"
                    >
                        <RotateCcw className="h-4 w-4" />
                        Ghi âm lại
                    </button>
                )}
            </div>
        );
    }

    // V2 is allowed to be unavailable after Whisper succeeds. Keep the
    // valid transcript/content result visible without dereferencing an
    // incomplete payload or inventing a pronunciation score.
    if (!overall) {
        return (
            <div className="rounded-2xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/70 dark:bg-amber-950/30 p-4 text-sm text-amber-900 dark:text-amber-200 flex items-center justify-between gap-3">
                <span>Chưa thể phân tích phát âm cho bản thu này.</span>
                {onRetryRecording && (
                    <button
                        type="button"
                        onClick={onRetryRecording}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-xs font-bold text-white transition cursor-pointer shrink-0"
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Thu lại
                    </button>
                )}
            </div>
        );
    }

    const overallScore =
        typeof overall.overallScore === 'number' && Number.isFinite(overall.overallScore)
            ? Math.max(0, Math.min(100, Math.round(overall.overallScore)))
            : null;
    const segmentalScore =
        typeof overall.segmentalScore === 'number' && Number.isFinite(overall.segmentalScore)
            ? Math.round(overall.segmentalScore)
            : null;
    const intonationScore =
        typeof overall.intonationScore === 'number' && Number.isFinite(overall.intonationScore)
            ? Math.round(overall.intonationScore)
            : null;
    const rhythmScore =
        typeof overall.rhythmScore === 'number' && Number.isFinite(overall.rhythmScore)
            ? Math.round(overall.rhythmScore)
            : null;
    const fluencyScore =
        typeof overall.fluencyScore === 'number' && Number.isFinite(overall.fluencyScore)
            ? Math.round(overall.fluencyScore)
            : null;

    const ratingColor =
        overallScore == null
            ? 'text-slate-500 dark:text-slate-400'
            : overallScore >= 85
            ? 'text-emerald-600 dark:text-emerald-400'
            : overallScore >= 70
            ? 'text-indigo-600 dark:text-indigo-400'
            : overallScore >= 50
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-rose-600 dark:text-rose-400';

    const selectedWord = selectedWordIdx !== null && safeWords[selectedWordIdx] ? safeWords[selectedWordIdx] : null;
    const selectedWordIsUnscored = selectedWord ? WORD_UNSCORED_STATUSES.has(selectedWord.status) : false;

    const hasConnectedSpeechData = Boolean(
        connectedSpeech &&
            (connectedSpeech.summaryVi ||
                connectedSpeech.summaryEn ||
                (Array.isArray(connectedSpeech.notesVi) && connectedSpeech.notesVi.length > 0) ||
                typeof connectedSpeech.finalStopReleaseRate === 'number' ||
                typeof connectedSpeech.cvLinkingContinuity === 'number' ||
                typeof connectedSpeech.linkingScore === 'number')
    );

    return (
        <div className="space-y-6">
            {/* Header Card: Overall Pronunciation Gauge */}
            <div className="rounded-3xl border border-indigo-200/80 dark:border-indigo-800/50 bg-gradient-to-br from-white via-indigo-50/30 to-purple-50/20 dark:from-gray-900 dark:via-gray-800/80 dark:to-indigo-950/20 p-6 sm:p-7 shadow-sm backdrop-blur-md">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
                    {/* Score Circle & Title */}
                    <div className="flex items-center gap-5">
                        <div className="relative flex items-center justify-center h-20 w-20 sm:h-24 sm:w-24 shrink-0">
                            <svg className="h-full w-full -rotate-90 transform" viewBox="0 0 36 36">
                                <path
                                    className="text-gray-200 dark:text-gray-700"
                                    strokeWidth="3.5"
                                    stroke="currentColor"
                                    fill="none"
                                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                />
                                <path
                                    className={ratingColor}
                                    strokeDasharray={`${overallScore ?? 0}, 100`}
                                    strokeWidth="3.5"
                                    strokeLinecap="round"
                                    stroke="currentColor"
                                    fill="none"
                                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                />
                            </svg>
                            <div className="absolute flex flex-col items-center justify-center">
                                <span className={`text-2xl sm:text-3xl font-extrabold ${ratingColor}`}>
                                    {overallScore != null ? overallScore : '—'}
                                </span>
                                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">/ 100</span>
                            </div>
                        </div>

                        <div>
                            <div className="flex items-center gap-2">
                                <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200/50 dark:border-indigo-800/40">
                                    {response.engineVersion ? response.engineVersion : 'Pronunciation Engine'}
                                </span>
                            </div>
                            <h3 className="text-lg sm:text-xl font-extrabold text-gray-900 dark:text-white mt-1">
                                Điểm phát âm tổng thể
                            </h3>
                            {!isRoleplay && !hideContentMatch && (
                                <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                                    Khớp nội dung: {matchPct != null ? `${matchPct}%` : 'Chưa có dữ liệu'}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* Quick action buttons */}
                    <div className="flex items-center gap-2 self-stretch sm:self-auto justify-end">
                        {onPlayReference && (
                            <button
                                type="button"
                                onClick={onPlayReference}
                                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs font-bold text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition cursor-pointer"
                            >
                                <Volume2 className="h-4 w-4 text-gray-500" />
                                Nghe câu mẫu
                            </button>
                        )}
                        {onRetryRecording && (
                            <button
                                type="button"
                                onClick={onRetryRecording}
                                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-xs font-bold text-white transition shadow-sm cursor-pointer"
                            >
                                <RotateCcw className="h-4 w-4" />
                                Thu lại
                            </button>
                        )}
                    </div>
                </div>

                {/* 5-Dimensional Pillars Breakdown */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-6 pt-5 border-t border-gray-200/60 dark:border-gray-800/60">
                    <div className="p-3 rounded-2xl bg-white/70 dark:bg-gray-800/60 border border-gray-200/50 dark:border-gray-700/50">
                        <div className="text-[11px] font-bold text-gray-500 dark:text-gray-400 flex items-center gap-1">
                            🎯 Âm vị (Phonemes)
                        </div>
                        <div className="text-lg font-extrabold text-gray-900 dark:text-white mt-1">
                            {formatPillarScore(segmentalScore)}
                            {segmentalScore != null && <span className="text-xs text-gray-400 font-normal">/100</span>}
                        </div>
                    </div>
                    <div className="p-3 rounded-2xl bg-white/70 dark:bg-gray-800/60 border border-gray-200/50 dark:border-gray-700/50">
                        <div className="text-[11px] font-bold text-gray-500 dark:text-gray-400 flex items-center gap-1">
                            ⚡ Trọng âm (Stress)
                        </div>
                        <div className="text-lg font-extrabold text-gray-900 dark:text-white mt-1">
                            {response.lexicalStress?.status === 'ASSESSED'
                                ? `${response.lexicalStress.matched}/${response.lexicalStress.assessed} từ khớp vị trí nhấn`
                                : 'Chưa đủ dữ liệu'}
                            {response.lexicalStress?.words?.filter((word) => !word.matched).slice(0, 2).map((word, index) => (
                                <p key={word.word + index} className="mt-1 text-xs font-normal">
                                    {word.word} · âm tiết nổi bật {word.observedSyllable}, theo từ điển {word.expectedSyllable}
                                </p>
                            ))}
                        </div>
                    </div>
                    <div className="p-3 rounded-2xl bg-white/70 dark:bg-gray-800/60 border border-gray-200/50 dark:border-gray-700/50">
                        <div className="text-[11px] font-bold text-gray-500 dark:text-gray-400 flex items-center gap-1">
                            〰️ Ngữ điệu (Pitch)
                        </div>
                        <div className="text-lg font-extrabold text-gray-900 dark:text-white mt-1">
                            {formatPillarScore(intonationScore)}
                            {intonationScore != null && <span className="text-xs text-gray-400 font-normal">/100</span>}
                        </div>
                    </div>
                    <div className="p-3 rounded-2xl bg-white/70 dark:bg-gray-800/60 border border-gray-200/50 dark:border-gray-700/50">
                        <div className="text-[11px] font-bold text-gray-500 dark:text-gray-400 flex items-center gap-1">
                            ⏱️ Nhịp điệu (Rhythm)
                        </div>
                        <div className="text-lg font-extrabold text-gray-900 dark:text-white mt-1">
                            {formatPillarScore(rhythmScore)}
                            {rhythmScore != null && <span className="text-xs text-gray-400 font-normal">/100</span>}
                        </div>
                    </div>
                    <div className="p-3 rounded-2xl bg-white/70 dark:bg-gray-800/60 border border-gray-200/50 dark:border-gray-700/50 col-span-2 sm:col-span-1">
                        <div className="text-[11px] font-bold text-gray-500 dark:text-gray-400 flex items-center gap-1">
                            🌊 Trôi chảy (Fluency)
                        </div>
                        <div className="text-lg font-extrabold text-gray-900 dark:text-white mt-1">
                            {formatPillarScore(fluencyScore)}
                            {fluencyScore != null && <span className="text-xs text-gray-400 font-normal">/100</span>}
                        </div>
                    </div>
                </div>
            </div>

            {/* Connected Speech Summary (only rendered when backend provides real diagnostics) */}
            {hasConnectedSpeechData && connectedSpeech && (
                <div className="rounded-3xl border border-sky-200/80 dark:border-sky-800/50 bg-sky-50/50 dark:bg-sky-950/20 p-5 shadow-sm space-y-2.5">
                    <div className="flex items-center gap-2">
                        <Activity className="h-4 w-4 text-sky-600 dark:text-sky-400 shrink-0" />
                        <h4 className="text-sm font-extrabold text-sky-950 dark:text-sky-100">
                            Liên kết âm và âm cuối (Connected Speech)
                        </h4>
                    </div>
                    {(connectedSpeech.summaryVi || connectedSpeech.summaryEn) && (
                        <p className="text-xs sm:text-sm text-sky-900 dark:text-sky-200 leading-relaxed">
                            {connectedSpeech.summaryVi || connectedSpeech.summaryEn}
                        </p>
                    )}
                    <div className="flex flex-wrap gap-2 text-xs">
                        {typeof connectedSpeech.finalStopReleaseRate === 'number' && Number.isFinite(connectedSpeech.finalStopReleaseRate) && (
                            <span className="px-2.5 py-1 rounded-xl bg-white/80 dark:bg-gray-900/60 border border-sky-200/70 dark:border-sky-800/60 font-semibold text-sky-900 dark:text-sky-200">
                                Bật âm cuối: {Math.round(connectedSpeech.finalStopReleaseRate <= 1 ? connectedSpeech.finalStopReleaseRate * 100 : connectedSpeech.finalStopReleaseRate)}%
                            </span>
                        )}
                        {typeof connectedSpeech.cvLinkingContinuity === 'number' && Number.isFinite(connectedSpeech.cvLinkingContinuity) && (
                            <span className="px-2.5 py-1 rounded-xl bg-white/80 dark:bg-gray-900/60 border border-sky-200/70 dark:border-sky-800/60 font-semibold text-sky-900 dark:text-sky-200">
                                Nối âm phụ âm - nguyên âm: {Math.round(connectedSpeech.cvLinkingContinuity <= 1 ? connectedSpeech.cvLinkingContinuity * 100 : connectedSpeech.cvLinkingContinuity)}%
                            </span>
                        )}
                        {typeof connectedSpeech.linkingScore === 'number' && Number.isFinite(connectedSpeech.linkingScore) && typeof connectedSpeech.cvLinkingContinuity !== 'number' && (
                            <span className="px-2.5 py-1 rounded-xl bg-white/80 dark:bg-gray-900/60 border border-sky-200/70 dark:border-sky-800/60 font-semibold text-sky-900 dark:text-sky-200">
                                Độ liền mạch nối âm: {Math.round(connectedSpeech.linkingScore)}/100
                            </span>
                        )}
                    </div>
                    {Array.isArray(connectedSpeech.notesVi) && connectedSpeech.notesVi.length > 0 && (
                        <ul className="list-disc pl-5 text-xs text-sky-900 dark:text-sky-200 space-y-1">
                            {connectedSpeech.notesVi.slice(0, 3).map((note, idx) => (
                                <li key={idx}>{note}</li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {/* Word-Level Assessment with Click-to-Inspect Phoneme Breakdown */}
            <div className="rounded-3xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h4 className="text-sm font-extrabold text-gray-900 dark:text-white">
                            Đối chiếu chi tiết từng từ
                        </h4>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            Bấm vào từng từ để xem chi tiết cấu âm từng âm vị (phoneme)
                        </p>
                    </div>
                    <span className="text-xs text-gray-400 font-mono">
                        {timing?.totalMs ? `${Math.round(timing.totalMs)}ms` : ''}
                    </span>
                </div>

                {/* Word Chips */}
                <div className="flex flex-wrap gap-2.5 pt-1">
                    {safeWords.map((w, idx) => {
                        const isSelected = selectedWordIdx === idx;
                        const isGood = w.status === 'GOOD';
                        const isNeedsWork = w.status === 'NEEDS_WORK';
                        const isUnscored = WORD_UNSCORED_STATUSES.has(w.status);

                        const chipStyle = isGood
                            ? 'bg-emerald-50 text-emerald-900 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-800'
                            : isNeedsWork
                            ? 'bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800'
                            : 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700';

                        const unscoredLabel =
                            w.status === 'OMITTED'
                                ? 'Thiếu từ'
                                : w.status === 'OFF_SCRIPT'
                                ? 'Lệch mẫu'
                                : 'Chưa chấm';

                        return (
                            <button
                                key={idx}
                                type="button"
                                onClick={() => setSelectedWordIdx(isSelected ? null : idx)}
                                className={`px-3.5 py-2 rounded-2xl border text-sm font-bold transition flex items-center gap-1.5 cursor-pointer ${chipStyle} ${
                                    isSelected ? 'ring-2 ring-indigo-500 shadow-md' : 'hover:shadow-xs'
                                }`}
                            >
                                <span>{w.word}</span>
                                {isNeedsWork && <span className="text-[10px] bg-amber-200 dark:bg-amber-900 text-amber-900 dark:text-amber-200 px-1.5 py-0.5 rounded-full font-extrabold">Cần sửa</span>}
                                {isUnscored && (
                                    <span
                                        title="Điểm được tính trên các âm mà hệ thống đủ dữ liệu để chấm."
                                        className="text-[10px] bg-slate-200 dark:bg-gray-700 text-slate-600 dark:text-gray-300 px-1.5 py-0.5 rounded-full font-medium cursor-help"
                                    >
                                        {unscoredLabel}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>

                {/* Subtle footnote explaining unscored items if any exist */}
                {safeWords.some((w) => WORD_UNSCORED_STATUSES.has(w.status)) && (
                    <p className="text-[11px] text-gray-400 dark:text-gray-500 italic pt-0.5">
                        * Điểm được tính trên các âm mà hệ thống đủ dữ liệu để chấm.
                    </p>
                )}

                {/* Selected Word Drawer */}
                {selectedWord && (
                    <div className="rounded-2xl border border-indigo-100 dark:border-indigo-900/60 bg-indigo-50/40 dark:bg-indigo-950/20 p-4 mt-3 space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-bold uppercase tracking-wider text-indigo-900 dark:text-indigo-300">
                                Chi tiết âm vị từ: <strong className="text-sm font-extrabold underline">{selectedWord.word}</strong>
                            </span>
                            {!selectedWordIsUnscored && typeof selectedWord.accuracyScore === 'number' && Number.isFinite(selectedWord.accuracyScore) ? (
                                <span className="text-xs text-indigo-700 dark:text-indigo-400 font-semibold">
                                    Điểm từ: {Math.round(selectedWord.accuracyScore)}/100
                                </span>
                            ) : (
                                <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                                    {selectedWord.status === 'OMITTED'
                                        ? 'Từ chưa được đọc trong bản thu'
                                        : selectedWord.status === 'OFF_SCRIPT'
                                        ? 'Từ nằm ngoài câu mẫu'
                                        : 'Chưa đủ dữ liệu để chấm điểm từ'}
                                </span>
                            )}
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                            {(selectedWord.phones || []).map((p, pIdx) => {
                                const isPhoneError = p.qualityClass === 'ERROR';
                                const isPhoneWeak = p.qualityClass === 'WEAK';
                                const isPhoneAcceptable = p.qualityClass === 'ACCEPTABLE';
                                const isDeletion = (p.diagnosisType || '').toUpperCase() === 'DELETION';
                                const showObservedPhone =
                                    !isDeletion &&
                                    Boolean(
                                        p.actionable &&
                                            p.qualityClass === 'ERROR' &&
                                            p.observedPhone &&
                                            (p.observedPhoneConfidence == null || p.observedPhoneConfidence >= 0.35)
                                    );

                                const pBadge = isPhoneAcceptable
                                    ? 'border-emerald-200 bg-emerald-50/80 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200'
                                    : isPhoneWeak
                                    ? 'border-amber-200 bg-amber-50/80 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200'
                                    : isPhoneError
                                    ? 'border-rose-200 bg-rose-50/80 text-rose-900 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200'
                                    : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-800/60 dark:text-gray-300';

                                return (
                                    <div key={pIdx} className={`p-2.5 rounded-xl border ${pBadge}`}>
                                        <div className="flex items-center justify-between gap-1 text-xs">
                                            <span className="font-mono font-extrabold text-sm">/{p.expectedPhone}/</span>
                                            <span className="text-[10px] font-bold text-right">{getQualityClassLabel(p.qualityClass)}</span>
                                        </div>
                                        {isDeletion && (isPhoneError || isPhoneWeak) && (
                                            <div className="text-[11px] text-rose-700 dark:text-rose-300 mt-1 font-medium">
                                                Bị nuốt âm / thiếu âm cuối
                                            </div>
                                        )}
                                        {showObservedPhone && (
                                            <div className="text-[11px] text-rose-700 dark:text-rose-300 mt-1">
                                                Nghe như: <span className="font-mono font-bold">[{p.observedPhone}]</span>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* Surface Partial Abstentions transparently when present */}
            {safeAbstentions.length > 0 && (
                <div className="rounded-2xl border border-amber-200/80 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20 p-4 space-y-1.5">
                    <div className="flex items-center gap-2 text-xs font-extrabold text-amber-900 dark:text-amber-200">
                        <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                        <span>Lưu ý về độ tin cậy dữ liệu ({safeAbstentions.length})</span>
                    </div>
                    <ul className="list-disc pl-5 text-xs text-amber-800 dark:text-amber-300 space-y-0.5">
                        {safeAbstentions.slice(0, 4).map((item, idx) => (
                            <li key={idx}>{getAbstentionReasonVi(item.reason, item.scope)}</li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Actionable Pedagogical Priorities (Mục tiêu luyện tập ưu tiên) */}
            {safePriorities.length > 0 ? (
                <div className="rounded-3xl border border-indigo-200 dark:border-indigo-800/60 bg-white dark:bg-gray-900 p-6 shadow-sm space-y-4">
                    <div className="flex items-center gap-2">
                        <Target className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                        <h4 className="text-base font-extrabold text-gray-900 dark:text-white">
                            Mục tiêu cải thiện quan trọng nhất ({safePriorities.length})
                        </h4>
                    </div>

                    <div className="space-y-3">
                        {safePriorities.map((item, idx) => (
                            <div
                                key={idx}
                                className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/40 p-4 space-y-2 hover:border-indigo-300 transition"
                            >
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className="h-6 w-6 rounded-full bg-indigo-600 text-white text-xs font-extrabold flex items-center justify-center">
                                            {item.priorityRank}
                                        </span>
                                        <span className="text-sm font-extrabold text-gray-900 dark:text-white">
                                            {item.targetUnit}
                                        </span>
                                    </div>
                                    {item.word && (
                                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-800 dark:text-indigo-300">
                                            Từ: "{item.word}"
                                        </span>
                                    )}
                                </div>

                                <p className="text-xs sm:text-sm text-gray-800 dark:text-gray-200 font-medium leading-relaxed">
                                    {item.instructionVi}
                                </p>
                                {item.instructionEn && (
                                    <p className="text-[11px] text-gray-500 dark:text-gray-400 italic">
                                        Phonetic Cue: {item.instructionEn}
                                    </p>
                                )}

                                {onStartRetry && (
                                    <div className="pt-2 flex justify-end">
                                        <button
                                            type="button"
                                            onClick={() => onStartRetry(item)}
                                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-xs font-bold text-white transition shadow-xs cursor-pointer"
                                        >
                                            <RotateCcw className="h-3.5 w-3.5" />
                                            Luyện lại mục tiêu này
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            ) : (() => {
                if (isRoleplay) {
                    const stress = response.lexicalStress?.status === 'ASSESSED' ? overall.stressScore : null;

                    if (safeWords.length === 0 || overallScore == null) {
                        return (
                            <div className="rounded-3xl border border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-850 p-6 text-center shadow-sm space-y-1">
                                <Info className="h-8 w-8 text-gray-500 mx-auto mb-1" />
                                <h4 className="font-extrabold text-gray-800 dark:text-gray-200 text-base">
                                    Chưa đủ dữ liệu để kết luận
                                </h4>
                                <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">
                                    Bản thu âm quá ngắn hoặc chưa đủ tín hiệu âm học để đưa ra chẩn đoán chi tiết.
                                </p>
                            </div>
                        );
                    }

                    if (segmentalScore != null && segmentalScore >= 75 && rhythmScore != null && rhythmScore < 60) {
                        return (
                            <div className="rounded-3xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/30 p-6 text-center shadow-sm space-y-1">
                                <Activity className="h-8 w-8 text-amber-600 dark:text-amber-400 mx-auto mb-1" />
                                <h4 className="font-extrabold text-amber-950 dark:text-amber-100 text-base">
                                    Âm vị nhìn chung tốt, nhưng nhịp điệu cần cải thiện
                                </h4>
                                <p className="text-xs sm:text-sm text-amber-700 dark:text-amber-300">
                                    Độ chính xác âm vị ({segmentalScore}/100) tốt, nhưng điểm nhịp điệu ({rhythmScore}/100) còn thấp. Hãy chú ý ngắt nghỉ và liên kết âm tự nhiên hơn.
                                </p>
                            </div>
                        );
                    }

                    if (segmentalScore != null && segmentalScore < 60) {
                        return (
                            <div className="rounded-3xl border border-rose-200 dark:border-rose-800/60 bg-rose-50/50 dark:bg-rose-950/30 p-6 text-center shadow-sm space-y-1">
                                <AlertCircle className="h-8 w-8 text-rose-600 dark:text-rose-400 mx-auto mb-1" />
                                <h4 className="font-extrabold text-rose-950 dark:text-rose-100 text-base">
                                    Cần cải thiện độ chuẩn xác âm vị ({segmentalScore}/100)
                                </h4>
                                <p className="text-xs sm:text-sm text-rose-700 dark:text-rose-300">
                                    Các âm vị trong câu còn sai lệch đáng kể so với âm chuẩn bản xứ. Chú ý khẩu hình và âm đuôi.
                                </p>
                            </div>
                        );
                    }

                    if (stress != null && stress < 60) {
                        return (
                            <div className="rounded-3xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/30 p-6 text-center shadow-sm space-y-1">
                                <Gauge className="h-8 w-8 text-amber-600 dark:text-amber-400 mx-auto mb-1" />
                                <h4 className="font-extrabold text-amber-950 dark:text-amber-100 text-base">
                                    Cần chú ý trọng âm ({Math.round(stress)}/100)
                                </h4>
                                <p className="text-xs sm:text-sm text-amber-700 dark:text-amber-300">
                                    Nhấn rõ hơn vào các âm tiết mang trọng âm chính trong từ để giọng nói tự nhiên và dễ hiểu.
                                </p>
                            </div>
                        );
                    }

                    if (fluencyScore != null && fluencyScore < 60) {
                        return (
                            <div className="rounded-3xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/30 p-6 text-center shadow-sm space-y-1">
                                <Activity className="h-8 w-8 text-amber-600 dark:text-amber-400 mx-auto mb-1" />
                                <h4 className="font-extrabold text-amber-950 dark:text-amber-100 text-base">
                                    Cần tăng độ trôi chảy ({fluencyScore}/100)
                                </h4>
                                <p className="text-xs sm:text-sm text-amber-700 dark:text-amber-300">
                                    Tốc độ nói còn ngắt quãng hoặc ngập ngừng. Hãy nói dứt khoát theo từng cụm từ hoàn chỉnh.
                                </p>
                            </div>
                        );
                    }

                    if (overallScore >= 85 && safeAbstentions.length === 0) {
                        return (
                            <div className="rounded-3xl border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/30 p-6 text-center shadow-sm space-y-1">
                                <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400 mx-auto mb-1" />
                                <h4 className="font-extrabold text-emerald-950 dark:text-emerald-100 text-base">
                                    Phát âm rất tốt và cân bằng!
                                </h4>
                                <p className="text-xs sm:text-sm text-emerald-700 dark:text-emerald-300">
                                    Cả âm vị, trọng âm và nhịp điệu đều đạt độ chuẩn xác cao ({overallScore}/100).
                                </p>
                            </div>
                        );
                    }

                    if (overallScore >= 75 && safeAbstentions.length === 0) {
                        return (
                            <div className="rounded-3xl border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/30 p-6 text-center shadow-sm space-y-1">
                                <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400 mx-auto mb-1" />
                                <h4 className="font-extrabold text-emerald-950 dark:text-emerald-100 text-base">
                                    Đạt yêu cầu giao tiếp cơ bản ({overallScore}/100)
                                </h4>
                                <p className="text-xs sm:text-sm text-emerald-700 dark:text-emerald-300">
                                    Không phát hiện lỗi âm vị nghiêm trọng nào. Tiếp tục luyện tập câu dài hơn để tăng phản xạ.
                                </p>
                            </div>
                        );
                    }

                    return (
                        <div className="rounded-3xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/30 p-6 text-center shadow-sm space-y-1">
                            <Info className="h-8 w-8 text-amber-600 dark:text-amber-400 mx-auto mb-1" />
                            <h4 className="font-extrabold text-amber-950 dark:text-amber-100 text-base">
                                Có thể cải thiện thêm ({overallScore}/100)
                            </h4>
                            <p className="text-xs sm:text-sm text-amber-700 dark:text-amber-300">
                                Hãy bấm vào từng từ ở trên để kiểm tra chi tiết từng âm vị và luyện đọc lại rõ ràng hơn.
                            </p>
                        </div>
                    );
                }

                // Non-Roleplay (Shadowing / Quick Check) empty priorities:
                // Only show green checkmark when overallScore >= 75, words are present, and no abstentions occurred.
                const canShowGreenCheck =
                    overallScore != null &&
                    overallScore >= 75 &&
                    safeWords.length > 0 &&
                    safeAbstentions.length === 0;

                if (canShowGreenCheck) {
                    const isHighQuality =
                        overallScore >= 90 &&
                        (segmentalScore == null || segmentalScore >= 85) &&
                        (overall.stressScore == null || overall.stressScore >= 80);
                    return (
                        <div className="rounded-3xl border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/30 p-6 text-center shadow-sm space-y-1">
                            <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400 mx-auto mb-1" />
                            <h4 className="font-extrabold text-emerald-950 dark:text-emerald-100 text-base">
                                {isHighQuality ? 'Phát âm rất tốt!' : 'Không phát hiện lỗi phát âm nghiêm trọng'}
                            </h4>
                            <p className="text-xs sm:text-sm text-emerald-700 dark:text-emerald-300">
                                {isHighQuality
                                    ? 'Khẩu hình và trọng âm chuẩn xác, không phát hiện lỗi cấu âm đáng kể nào.'
                                    : 'Độ chính xác âm vị tốt. Bạn có thể luyện thêm ngữ điệu và nhịp điệu để câu nói tự nhiên hơn.'}
                            </p>
                        </div>
                    );
                }

                if (overallScore == null || safeWords.length === 0) {
                    return (
                        <div className="rounded-3xl border border-slate-200 dark:border-gray-800 bg-slate-50/70 dark:bg-gray-800/50 p-6 text-center shadow-sm space-y-1">
                            <Info className="h-8 w-8 text-slate-500 mx-auto mb-1" />
                            <h4 className="font-extrabold text-slate-800 dark:text-gray-200 text-base">
                                Chưa đủ dữ liệu để xác định mục tiêu luyện tập
                            </h4>
                            <p className="text-xs sm:text-sm text-slate-500 dark:text-gray-400">
                                Bản thu âm chưa có đủ từ được chấm chắc chắn. Hãy đọc chậm và rõ hơn để hệ thống chỉ ra điểm cần sửa.
                            </p>
                        </div>
                    );
                }

                return (
                    <div className="rounded-3xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/60 dark:bg-amber-950/30 p-6 text-center shadow-sm space-y-1">
                        <AlertCircle className="h-8 w-8 text-amber-600 dark:text-amber-400 mx-auto mb-1" />
                        <h4 className="font-extrabold text-amber-950 dark:text-amber-100 text-base">
                            {overallScore < 60
                                ? `Cần luyện tập thêm (${overallScore}/100)`
                                : 'Chưa xác định lỗi đơn lẻ nổi bật nhưng vẫn có thể cải thiện'}
                        </h4>
                        <p className="text-xs sm:text-sm text-amber-800 dark:text-amber-300">
                            {safeAbstentions.length > 0
                                ? 'Một phần tín hiệu chưa đủ rõ để chẩn đoán từng âm vị. Hãy thu lại rõ ràng hơn ở môi trường yên tĩnh.'
                                : 'Hãy chú ý phát âm rõ âm cuối, trọng âm từ và giữ nhịp nói đều hơn trong lần thu tiếp theo.'}
                        </p>
                    </div>
                );
            })()}
        </div>
    );
};
