"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import {
    Activity,
    AlertCircle,
    ArrowRight,
    Award,
    CheckCircle2,
    Gauge,
    Info,
    Mic,
    RefreshCw,
    ShieldCheck,
    Target,
} from "lucide-react";
import type { SpeakingProgress, SpeakingProgressSummary } from "@/services/speakingApi";
import type {
    SpeakingIssueStatus,
    SpeakingProfilePronunciation,
    SpeakingProfileRecurringIssue,
} from "@/services/speakingProfileApi";
import {
    formatScoreOrDash,
    getLearnerCategoryLabel,
    getLearnerIssueLabel,
    mapLegacyMetricsToProfileMetrics,
    normalizeLegacyIssue,
    practiceModeFromSessionMode,
    resolveRecurringStatusMeta,
} from "./profileViewModel";
import glass from "./speakingProfileGlass.module.css";

export interface ProfilePronunciationSectionProps {
    pronunciation: SpeakingProfilePronunciation | null;
    isLoading: boolean;
    error: unknown;
    onRetry: () => void;
    onJumpToPractice: (mode?: "shadowing" | "roleplay" | "assessment" | "topic") => void;
    legacyProgress?: SpeakingProgress | null;
    legacySummary?: SpeakingProgressSummary | null;
    vi?: boolean;
}

type IssueFilterKey = "ALL" | SpeakingIssueStatus;

export function ProfilePronunciationSection({
    pronunciation,
    isLoading,
    error,
    onRetry,
    onJumpToPractice,
    legacyProgress,
    legacySummary,
    vi = true,
}: ProfilePronunciationSectionProps) {
    const router = useRouter();
    const [statusFilter, setStatusFilter] = useState<IssueFilterKey>("ALL");

    if (isLoading && !pronunciation && !legacySummary && !legacyProgress) {
        return (
            <div className="space-y-4" role="status" aria-label={vi ? "Đang tải phân tích phát âm" : "Loading pronunciation analytics"}>
                <div className={glass.skeletonBlock} style={{ height: "12rem" }} />
                <div className={glass.skeletonGrid}>
                    <div className={glass.skeletonBlock} />
                    <div className={glass.skeletonBlock} />
                </div>
            </div>
        );
    }

    if (error && !pronunciation && !legacySummary) {
        return (
            <div className={glass.stateCard} role="alert">
                <span className={glass.stateIcon} data-tone="rose" aria-hidden="true">
                    <AlertCircle />
                </span>
                <h3 className={glass.stateTitle}>
                    {vi ? "Chưa thể tải hồ sơ phát âm V2.2" : "Could not load V2.2 pronunciation profile"}
                </h3>
                <p className={glass.stateDesc}>
                    {vi
                        ? "Kết nối tạm thời gián đoạn khi tải dữ liệu âm học. Vui lòng thử tải lại."
                        : "Unable to load acoustic metrics right now. Please try again."}
                </p>
                <button type="button" onClick={onRetry} className={glass.actionBtnPrimary}>
                    <RefreshCw />
                    <span>{vi ? "Thử tải lại" : "Retry"}</span>
                </button>
            </div>
        );
    }

    const metrics = pronunciation?.metrics ?? mapLegacyMetricsToProfileMetrics(legacySummary?.pronunciationMetrics);
    const scoredCount = metrics?.scoredAttemptsCount ?? 0;
    const totalCount = metrics?.totalAttemptsCount ?? 0;
    const abstainedOrSttOnly =
        (metrics?.abstainedAttemptsCount ?? 0) + (metrics?.sttOnlyAttemptsCount ?? 0) ||
        Math.max(0, totalCount - scoredCount);

    const overallScore =
        typeof metrics?.averagePronunciationScore === "number" && Number.isFinite(metrics.averagePronunciationScore)
            ? Math.max(0, Math.min(100, Math.round(metrics.averagePronunciationScore)))
            : null;

    // Combine recurring issues + single-session INSUFFICIENT_DATA observations so every status can be explored honestly
    const fallbackLegacyIssues: SpeakingProfileRecurringIssue[] = (
        legacySummary?.recurringIssues ??
        legacyProgress?.weaknessProfile?.issues ??
        []
    )
        .filter(
            (i) =>
                i.category === "PRONUNCIATION" ||
                i.category === "STRESS" ||
                !i.category ||
                i.targetPhone != null,
        )
        .map(normalizeLegacyIssue);

    const allExplorerIssues: SpeakingProfileRecurringIssue[] = pronunciation
        ? [...(pronunciation.recurringIssues ?? []), ...(pronunciation.singleSessionObservations ?? [])]
        : fallbackLegacyIssues;

    const filterOptions: Array<{ key: IssueFilterKey; labelVi: string; labelEn: string; count: number }> = [
        { key: "ALL", labelVi: "Tất cả", labelEn: "All", count: allExplorerIssues.length },
        {
            key: "NEEDS_ATTENTION",
            labelVi: "Cần chú ý",
            labelEn: "Needs focus",
            count: allExplorerIssues.filter((i) => (i.status || "NEEDS_ATTENTION") === "NEEDS_ATTENTION").length,
        },
        {
            key: "PRACTICING",
            labelVi: "Đang luyện tập",
            labelEn: "Practicing",
            count: allExplorerIssues.filter((i) => i.status === "PRACTICING").length,
        },
        {
            key: "IMPROVING",
            labelVi: "Đang tiến bộ",
            labelEn: "Improving",
            count: allExplorerIssues.filter((i) => i.status === "IMPROVING").length,
        },
        {
            key: "RECENTLY_STABLE",
            labelVi: "Đã ổn định",
            labelEn: "Stabilized",
            count: allExplorerIssues.filter((i) => i.status === "RECENTLY_STABLE").length,
        },
        {
            key: "INSUFFICIENT_DATA",
            labelVi: "Chưa đủ dữ liệu",
            labelEn: "Insufficient data",
            count: allExplorerIssues.filter((i) => i.status === "INSUFFICIENT_DATA").length,
        },
    ];

    const visibleIssues =
        statusFilter === "ALL"
            ? allExplorerIssues
            : allExplorerIssues.filter((i) => (i.status || "NEEDS_ATTENTION") === statusFilter);

    const strongPatterns = pronunciation?.strongPatterns ?? [];
    const ringRadius = 46;
    const ringCircumference = 2 * Math.PI * ringRadius;
    const ringOffset =
        overallScore != null ? ringCircumference * (1 - overallScore / 100) : ringCircumference;

    const stressHasCounts = (metrics?.lexicalStressAssessedWords ?? 0) > 0;

    return (
        <div className="space-y-5" data-testid="speaking-profile-pronunciation">
            {/* ── 1. V2.2 Acoustic Sub-Metric Radial & Gauge Observatory ── */}
            <section className={glass.glassCard} data-tone="indigo" aria-labelledby="sp-v2-acoustics-heading">
                <div className={glass.sectionHeader}>
                    <div className={glass.sectionTitleRow}>
                        <span className={glass.sectionIconBadge} aria-hidden="true">
                            <Gauge />
                        </span>
                        <div>
                            <h3 id="sp-v2-acoustics-heading">
                                {vi
                                    ? "Đài quan sát âm học Pronunciation Engine V2.2"
                                    : "Pronunciation Engine V2.2 Acoustic Observatory"}
                            </h3>
                        </div>
                    </div>
                    <span className={glass.sectionSubnote}>
                        {pronunciation
                            ? vi
                                ? pronunciation.windowLabelVi
                                : pronunciation.windowLabelEn
                            : vi
                            ? "30 ngày gần đây"
                            : "Last 30 days"}
                    </span>
                </div>

                {scoredCount > 0 ? (
                    <div className={glass.pronHeroLayout}>
                        {/* Overall V2.2 Radial Gauge + Honest Scored vs Abstained Provenance */}
                        <div className={glass.radialStage}>
                            <div className={glass.radialRingBox}>
                                <svg className={glass.radialRingSvg} viewBox="0 0 112 112" aria-hidden="true">
                                    <defs>
                                        <linearGradient id="spPronRadialGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                                            <stop offset="0%" stopColor="#22d3ee" />
                                            <stop offset="52%" stopColor="#4f46e5" />
                                            <stop offset="100%" stopColor="#a855f7" />
                                        </linearGradient>
                                    </defs>
                                    <circle cx="56" cy="56" r={ringRadius} className={glass.radialTrack} />
                                    <circle
                                        cx="56"
                                        cy="56"
                                        r={ringRadius}
                                        className={glass.radialArc}
                                        strokeDasharray={ringCircumference}
                                        strokeDashoffset={ringOffset}
                                    />
                                </svg>
                                <div className={glass.radialCenter}>
                                    <span className={`${glass.radialScore} ${glass.mono}`}>
                                        {overallScore != null ? overallScore : "—"}
                                    </span>
                                    <span className={glass.radialDenominator}>/ 100 V2.2</span>
                                </div>
                            </div>

                            <div>
                                <div className="text-xs font-extrabold">
                                    {vi ? "Điểm phát âm tổng thể" : "Overall Pronunciation"}
                                </div>
                                <div className="text-[11px] opacity-75 mt-0.5">
                                    {vi
                                        ? `Tổng hợp từ ${scoredCount} lượt chấm đủ bằng chứng`
                                        : `Averaged from ${scoredCount} verified V2.2 assessments`}
                                </div>
                            </div>

                            <div className={glass.provenanceRow}>
                                <span className={`${glass.provenancePill} ${glass.mono}`}>
                                    {vi ? `Đã chấm: ${scoredCount}` : `Scored: ${scoredCount}`}
                                </span>
                                <span className={`${glass.provenancePill} ${glass.mono}`}>
                                    {vi
                                        ? `Tạm bỏ qua / chỉ STT: ${abstainedOrSttOnly}`
                                        : `Abstained / STT-only: ${abstainedOrSttOnly}`}
                                </span>
                            </div>
                        </div>

                        {/* Sub-Metric Gauges Grid */}
                        <div className={glass.subMetricGrid}>
                            {/* 1. Phonemes */}
                            <div className={glass.subMetricCard}>
                                <div className={glass.subMetricTop}>
                                    <span className={glass.subMetricName}>
                                        {vi ? "Âm vị (Phonemes)" : "Phonemes"}
                                    </span>
                                    <span className={`${glass.subMetricVal} ${glass.mono}`}>
                                        {formatScoreOrDash(metrics?.averagePhonemeScore, "/100")}
                                    </span>
                                </div>
                                <div className={glass.miniMeterTrack} aria-hidden="true">
                                    <div
                                        className={glass.miniMeterFill}
                                        style={{
                                            width: `${Math.max(0, Math.min(100, Math.round(metrics?.averagePhonemeScore ?? 0)))}%`,
                                        }}
                                    />
                                </div>
                                <div className={glass.subMetricHint}>
                                    {vi
                                        ? "Độ chính xác khẩu hình nguyên âm và phụ âm đơn lẻ"
                                        : "Segmental vowel and consonant articulation"}
                                </div>
                            </div>

                            {/* 2. Lexical Stress (with real word/syllable numerator & denominator!) */}
                            <div className={glass.subMetricCard}>
                                <div className={glass.subMetricTop}>
                                    <span className={glass.subMetricName}>
                                        {vi ? "Trọng âm từ (Lexical Stress)" : "Lexical Stress"}
                                    </span>
                                    <span className={`${glass.subMetricVal} ${glass.mono}`}>
                                        {formatScoreOrDash(metrics?.averageStressScore, "/100")}
                                    </span>
                                </div>
                                <div className={glass.miniMeterTrack} aria-hidden="true">
                                    <div
                                        className={glass.miniMeterFill}
                                        style={{
                                            width: `${Math.max(0, Math.min(100, Math.round(metrics?.averageStressScore ?? 0)))}%`,
                                        }}
                                    />
                                </div>
                                <div className={glass.subMetricHint}>
                                    {stressHasCounts
                                        ? vi
                                            ? `Khớp ${metrics!.lexicalStressMatchedWords}/${metrics!.lexicalStressAssessedWords} từ đa âm tiết được đo`
                                            : `${metrics!.lexicalStressMatchedWords}/${metrics!.lexicalStressAssessedWords} multi-syllable words matched`
                                        : vi
                                        ? "Đo vị trí âm tiết nhấn chính theo từ điển"
                                        : "Primary stressed syllable match against lexicon"}
                                </div>
                            </div>

                            {/* 3. Fluency */}
                            <div className={glass.subMetricCard}>
                                <div className={glass.subMetricTop}>
                                    <span className={glass.subMetricName}>
                                        {vi ? "Lưu loát (Fluency)" : "Fluency"}
                                    </span>
                                    <span className={`${glass.subMetricVal} ${glass.mono}`}>
                                        {formatScoreOrDash(metrics?.averageFluencyScore, "/100")}
                                    </span>
                                </div>
                                <div className={glass.miniMeterTrack} aria-hidden="true">
                                    <div
                                        className={glass.miniMeterFill}
                                        style={{
                                            width: `${Math.max(0, Math.min(100, Math.round(metrics?.averageFluencyScore ?? 0)))}%`,
                                        }}
                                    />
                                </div>
                                <div className={glass.subMetricHint}>
                                    {vi
                                        ? "Tốc độ phát âm và kiểm soát khoảng nghỉ tự nhiên"
                                        : "Speech rate continuity and natural pause control"}
                                </div>
                            </div>

                            {/* 4. STT Content Match */}
                            <div className={glass.subMetricCard}>
                                <div className={glass.subMetricTop}>
                                    <span className={glass.subMetricName}>
                                        {vi ? "Khớp nội dung (STT)" : "STT Content Match"}
                                    </span>
                                    <span className={`${glass.subMetricVal} ${glass.mono}`}>
                                        {formatScoreOrDash(metrics?.averageContentMatchScore, "%")}
                                    </span>
                                </div>
                                <div className={glass.miniMeterTrack} aria-hidden="true">
                                    <div
                                        className={glass.miniMeterFill}
                                        style={{
                                            width: `${Math.max(0, Math.min(100, Math.round(metrics?.averageContentMatchScore ?? 0)))}%`,
                                        }}
                                    />
                                </div>
                                <div className={glass.subMetricHint}>
                                    {vi
                                        ? `Đối chiếu từ vựng Whisper trên ${metrics?.contentMatchAttemptsCount || totalCount} lượt thu`
                                        : `Whisper word alignment across ${metrics?.contentMatchAttemptsCount || totalCount} takes`}
                                </div>
                            </div>

                            {/* 5. Pitch / Intonation */}
                            <div className={glass.subMetricCard}>
                                <div className={glass.subMetricTop}>
                                    <span className={glass.subMetricName}>
                                        {vi ? "Cao độ (Pitch / F0)" : "Intonation (Pitch)"}
                                    </span>
                                    <span className={`${glass.subMetricVal} ${glass.mono}`}>
                                        {formatScoreOrDash(metrics?.averagePitchScore, "/100")}
                                    </span>
                                </div>
                                <div className={glass.miniMeterTrack} aria-hidden="true">
                                    <div
                                        className={glass.miniMeterFill}
                                        style={{
                                            width: `${Math.max(0, Math.min(100, Math.round(metrics?.averagePitchScore ?? 0)))}%`,
                                        }}
                                    />
                                </div>
                                <div className={glass.subMetricHint}>
                                    {vi
                                        ? "Đường nét ngữ điệu lên xuống cuối cụm và câu"
                                        : "Prosodic pitch contour across clauses"}
                                </div>
                            </div>

                            {/* 6. Rhythm */}
                            <div className={glass.subMetricCard}>
                                <div className={glass.subMetricTop}>
                                    <span className={glass.subMetricName}>
                                        {vi ? "Nhịp điệu (Rhythm)" : "Rhythm"}
                                    </span>
                                    <span className={`${glass.subMetricVal} ${glass.mono}`}>
                                        {formatScoreOrDash(metrics?.averageRhythmScore, "/100")}
                                    </span>
                                </div>
                                <div className={glass.miniMeterTrack} aria-hidden="true">
                                    <div
                                        className={glass.miniMeterFill}
                                        style={{
                                            width: `${Math.max(0, Math.min(100, Math.round(metrics?.averageRhythmScore ?? 0)))}%`,
                                        }}
                                    />
                                </div>
                                <div className={glass.subMetricHint}>
                                    {vi
                                        ? "Tương phản độ dài nguyên âm nhấn và lướt (nPVI-V)"
                                        : "Stressed vs unstressed vowel timing contrast"}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className={glass.stateCard}>
                        <span className={glass.stateIcon} aria-hidden="true">
                            <Mic />
                        </span>
                        <h4 className={glass.stateTitle}>
                            {totalCount > 0
                                ? vi
                                    ? `Đã ghi nhận ${totalCount} lượt thu nhưng chưa có lượt chấm V2.2 đủ độ tin cậy`
                                    : `${totalCount} recordings found, 0 met V2.2 acoustic confidence thresholds`
                                : vi
                                ? "Chưa có dữ liệu âm học V2.2 để tổng hợp chỉ số"
                                : "No V2.2 acoustic data recorded yet"}
                        </h4>
                        <p className={glass.stateDesc}>
                            {totalCount > 0
                                ? vi
                                    ? "Pronunciation Engine V2.2 tự động tạm bỏ qua (abstain) các bản thu bị ồn nền, quá ngắn hoặc lệch câu mẫu để không bao giờ chấm điểm oan. Hãy thử thu lại rõ ràng trong môi trường yên tĩnh."
                                    : "Pronunciation Engine V2.2 abstains on noisy, clipped, or off-script audio to protect score accuracy. Try recording clearly in a quiet space."
                                : vi
                                ? "Hoàn thành các câu Shadowing hoặc Quick Check để mở khóa biểu đồ 6 chiều âm học (Âm vị, Trọng âm, Cao độ, Nhịp điệu, Lưu loát và Khớp nội dung)."
                                : "Complete Shadowing sentences or Quick Check recordings to unlock your 6-pillar acoustic gauges."}
                        </p>
                        <button
                            type="button"
                            onClick={() => onJumpToPractice("shadowing")}
                            className={glass.actionBtnPrimary}
                        >
                            <span>{vi ? "Bắt đầu luyện phát âm" : "Start pronunciation practice"}</span>
                            <ArrowRight />
                        </button>
                    </div>
                )}
            </section>

            {/* ── 2. Interactive Phoneme & Prosody Issue Explorer ── */}
            <section className={glass.glassCard} data-tone="violet" aria-labelledby="sp-issue-explorer-heading">
                <div className={glass.sectionHeader}>
                    <div className={glass.sectionTitleRow}>
                        <span className={glass.sectionIconBadge} data-tone="violet" aria-hidden="true">
                            <Target />
                        </span>
                        <div>
                            <h3 id="sp-issue-explorer-heading">
                                {vi ? "Khám phá chi tiết âm vị và ngữ điệu" : "Phoneme and Prosody Explorer"}
                            </h3>
                        </div>
                    </div>
                    <span className={glass.sectionSubnote}>
                        {vi
                            ? `${allExplorerIssues.length} mục tiêu đã quan sát`
                            : `${allExplorerIssues.length} observed targets`}
                    </span>
                </div>

                {allExplorerIssues.length > 0 && (
                    <div className={`${glass.filterBar} mb-4`} role="group" aria-label={vi ? "Lọc theo trạng thái tiến triển" : "Filter by issue status"}>
                        <div className={glass.pillGroup}>
                            <span className={glass.filterGroupLabel}>{vi ? "Trạng thái:" : "Status:"}</span>
                            {filterOptions
                                .filter((opt) => opt.key === "ALL" || opt.count > 0)
                                .map((opt) => (
                                    <button
                                        key={opt.key}
                                        type="button"
                                        aria-pressed={statusFilter === opt.key}
                                        onClick={() => setStatusFilter(opt.key)}
                                        className={glass.filterPill}
                                    >
                                        <span>{vi ? opt.labelVi : opt.labelEn}</span>
                                        <span className={`${glass.filterPillCount} ${glass.mono}`}>({opt.count})</span>
                                    </button>
                                ))}
                        </div>
                    </div>
                )}

                {visibleIssues.length > 0 ? (
                    <div className={glass.issueGrid}>
                        {visibleIssues.map((issue, idx) => {
                            const statusMeta = resolveRecurringStatusMeta(issue.status);
                            const firstEx = issue.recentExamples?.[0];
                            return (
                                <article key={`${issue.issueKey || idx}`} className={glass.issueCard}>
                                    <div className="space-y-2.5">
                                        <div className={glass.issueHead}>
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                <span className={glass.categoryChip} data-cat={issue.category || "PRONUNCIATION"}>
                                                    {getLearnerCategoryLabel(issue.category)}
                                                </span>
                                                {issue.targetPhone && (
                                                    <span className={`${glass.phonePill} ${glass.mono}`}>
                                                        /{issue.targetPhone}/
                                                        {issue.observedPhone ? ` -> /${issue.observedPhone}/` : ""}
                                                    </span>
                                                )}
                                            </div>
                                            <span className={glass.statusBadge} data-status={statusMeta.key}>
                                                {vi ? statusMeta.labelVi : statusMeta.labelEn}
                                            </span>
                                        </div>

                                        <div>
                                            <h4 className={glass.issueTitle}>
                                                {issue.title || getLearnerIssueLabel(issue.issueType, issue.targetWord)}
                                            </h4>
                                            <p className={glass.issueMeta}>
                                                {issue.statusExplanation ||
                                                    (vi
                                                        ? `Quan sát trong ${issue.distinctSessionsObserved} phiên (${issue.totalOccurrences} lần xuất hiện)`
                                                        : `Observed in ${issue.distinctSessionsObserved} sessions (${issue.totalOccurrences} occurrences)`)}
                                            </p>
                                        </div>

                                        {issue.displayCue && (
                                            <div className={glass.cueCallout}>
                                                <span className="font-bold mr-1">
                                                    {vi ? "Hướng dẫn khẩu hình:" : "Coaching cue:"}
                                                </span>
                                                {issue.displayCue}
                                            </div>
                                        )}

                                        {issue.recentExamples && issue.recentExamples.length > 0 && (
                                            <div className="space-y-1.5">
                                                <div className={glass.sectionSubnote}>
                                                    {vi ? "Ví dụ thực tế từ buổi tập:" : "Recorded examples:"}
                                                </div>
                                                <div className={glass.exampleChips}>
                                                    {issue.recentExamples.slice(0, 4).map((ex, eIdx) => (
                                                        <span
                                                            key={eIdx}
                                                            className={glass.exampleChip}
                                                            title={ex.sentenceSnippet || ex.sourceTitle || ""}
                                                        >
                                                            {ex.targetWord ? (
                                                                <strong>{ex.targetWord}</strong>
                                                            ) : null}
                                                            {ex.targetWord && ex.sentenceSnippet ? " · " : ""}
                                                            {ex.sentenceSnippet || ex.originalPhrase || ""}
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-500/10">
                                        <span className={glass.sectionSubnote}>
                                            {issue.resolvedSessionCount > 0
                                                ? vi
                                                    ? `Đã cải thiện ở ${issue.resolvedSessionCount} phiên`
                                                    : `Improved in ${issue.resolvedSessionCount} sessions`
                                                : issue.evidenceWindow || ""}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                if (issue.practiceAgainRoute) {
                                                    router.push(issue.practiceAgainRoute);
                                                } else if (firstEx?.mode) {
                                                    onJumpToPractice(practiceModeFromSessionMode(firstEx.mode));
                                                } else {
                                                    onJumpToPractice("shadowing");
                                                }
                                            }}
                                            className={glass.actionBtnGhost}
                                        >
                                            <span>{issue.practiceAgainLabel || (vi ? "Luyện tập lại" : "Practice again")}</span>
                                            <ArrowRight />
                                        </button>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                ) : (
                    <div className={glass.stateCard}>
                        <span className={glass.stateIcon} aria-hidden="true">
                            <Info />
                        </span>
                        <h4 className={glass.stateTitle}>
                            {allExplorerIssues.length > 0
                                ? vi
                                    ? "Không có mục tiêu nào thuộc bộ lọc trạng thái này"
                                    : "No targets match this status filter"
                                : vi
                                ? "Chưa phát hiện mẫu lỗi âm vị hoặc trọng âm cần lưu ý"
                                : "No phoneme or prosody issues recorded yet"}
                        </h4>
                        <p className={glass.stateDesc}>
                            {allExplorerIssues.length > 0
                                ? vi
                                    ? "Hãy chọn 'Tất cả' để xem đầy đủ các quan sát âm học của bạn."
                                    : "Select 'All' to view every recorded acoustic observation."
                                : vi
                                ? "Khi hệ thống phát hiện âm vị lệch chuẩn hoặc nhấn sai trọng âm qua các bài tập, hướng dẫn khẩu hình và từ ví dụ thực tế sẽ hiển thị tại đây."
                                : "Phoneme substitutions, deletions, and lexical stress notes from your recordings will appear here with real word examples."}
                        </p>
                    </div>
                )}
            </section>

            {/* ── 3. Strong Pronunciation Patterns ── */}
            <section className={glass.glassCard} data-tone="emerald" aria-labelledby="sp-strong-phonemes-heading">
                <div className={glass.sectionHeader}>
                    <div className={glass.sectionTitleRow}>
                        <span className={glass.sectionIconBadge} data-tone="emerald" aria-hidden="true">
                            <ShieldCheck />
                        </span>
                        <h3 id="sp-strong-phonemes-heading">
                            {vi ? "Mẫu âm vị phát âm vững vàng" : "Strong Phoneme Patterns"}
                        </h3>
                    </div>
                    <span className={glass.sectionSubnote}>
                        {vi ? "Độ chuẩn xác ổn định cao" : "Verified high accuracy"}
                    </span>
                </div>

                {strongPatterns.length > 0 ? (
                    <div className={glass.subMetricGrid}>
                        {strongPatterns.map((pat) => (
                            <div key={pat.phone} className={glass.subMetricCard}>
                                <div className={glass.subMetricTop}>
                                    <div className="flex items-center gap-2">
                                        <span className={`${glass.phonePill} ${glass.mono}`}>
                                            {pat.ipaDisplay || `/${pat.phone}/`}
                                        </span>
                                        <span className="text-xs font-extrabold">
                                            {vi ? pat.categoryLabelVi : pat.categoryLabelEn}
                                        </span>
                                    </div>
                                    <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                        {Math.round(pat.acceptableRate * (pat.acceptableRate <= 1 ? 100 : 1))}%
                                    </span>
                                </div>
                                <div className={glass.subMetricHint}>
                                    {vi
                                        ? `Đạt chuẩn ${pat.acceptableCount}/${pat.observationsCount} lần đo · Chất lượng TB ${Math.round(pat.averageQualityScore)}/100`
                                        : `${pat.acceptableCount}/${pat.observationsCount} acceptable · Avg quality ${Math.round(pat.averageQualityScore)}/100`}
                                </div>
                                {pat.exampleWords && pat.exampleWords.length > 0 && (
                                    <div className={glass.exampleChips}>
                                        {pat.exampleWords.slice(0, 4).map((w, i) => (
                                            <span key={`${w}-${i}`} className={glass.exampleChip}>
                                                {w}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className={glass.stateCard}>
                        <span className={glass.stateIcon} aria-hidden="true">
                            <Award />
                        </span>
                        <h4 className={glass.stateTitle}>
                            {vi ? "Đang tích lũy mẫu âm vị vững vàng" : "Accumulating strong phoneme evidence"}
                        </h4>
                        <p className={glass.stateDesc}>
                            {vi
                                ? "Một âm vị chỉ được xác nhận là vững vàng khi xuất hiện đủ số lần đo độc lập với tỷ lệ đạt chuẩn cao từ V2.2."
                                : "Phonemes are listed here once verified across multiple high-confidence V2.2 observations."}
                        </p>
                    </div>
                )}
            </section>
        </div>
    );
}
