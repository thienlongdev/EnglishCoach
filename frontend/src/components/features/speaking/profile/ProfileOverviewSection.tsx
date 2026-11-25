"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import {
    Activity,
    AlertCircle,
    ArrowRight,
    Award,
    BarChart3,
    Calendar,
    CheckCircle2,
    ChevronRight,
    Clock,
    Flame,
    Headphones,
    MessageSquare,
    Mic,
    RefreshCw,
    ShieldCheck,
    Target,
    TrendingUp,
} from "lucide-react";
import type { SpeakingProgress, SpeakingProgressSummary } from "@/services/speakingApi";
import type { SpeakingProfileOverview, SpeakingProfileSubTab } from "@/services/speakingProfileApi";
import {
    buildRhythmBars14d,
    buildStrengthDisplayList,
    formatScoreOrDash,
    formatSpeakingDuration,
    getLearnerCategoryLabel,
    getLearnerIssueLabel,
    normalizeLegacyIssue,
    normalizeTrendNodes,
    practiceModeFromSessionMode,
    resolveRecurringStatusMeta,
} from "./profileViewModel";
import glass from "./speakingProfileGlass.module.css";

export interface ProfileOverviewSectionProps {
    overview: SpeakingProfileOverview | null;
    isLoading: boolean;
    error: unknown;
    onRetry: () => void;
    onSelectSubTab: (tab: SpeakingProfileSubTab) => void;
    onJumpToPractice: (mode?: "shadowing" | "roleplay" | "assessment" | "topic") => void;
    onOpenSessionDetail: (sessionId: number) => void;
    legacyProgress?: SpeakingProgress | null;
    legacySummary?: SpeakingProgressSummary | null;
    vi?: boolean;
}

export function ProfileOverviewSection({
    overview,
    isLoading,
    error,
    onRetry,
    onSelectSubTab,
    onJumpToPractice,
    onOpenSessionDetail,
    legacyProgress,
    legacySummary,
    vi = true,
}: ProfileOverviewSectionProps) {
    const router = useRouter();
    const [activeRhythmIdx, setActiveRhythmIdx] = useState<number | null>(null);
    const [activeTrendIdx, setActiveTrendIdx] = useState<number | null>(null);

    if (isLoading && !overview && !legacySummary && !legacyProgress) {
        return (
            <div className="space-y-4" role="status" aria-label={vi ? "Đang tải tổng quan hồ sơ nói" : "Loading speaking overview"}>
                <div className={glass.skeletonBlock} style={{ height: "10.5rem" }} />
                <div className={glass.skeletonGrid}>
                    <div className={glass.skeletonBlock} />
                    <div className={glass.skeletonBlock} />
                </div>
                <div className={glass.skeletonGrid}>
                    <div className={glass.skeletonBlock} />
                    <div className={glass.skeletonBlock} />
                </div>
            </div>
        );
    }

    if (error && !overview && !legacySummary) {
        return (
            <div className={glass.stateCard} role="alert">
                <span className={glass.stateIcon} data-tone="rose" aria-hidden="true">
                    <AlertCircle />
                </span>
                <h3 className={glass.stateTitle}>
                    {vi ? "Chưa thể tải tổng quan hồ sơ luyện nói" : "Could not load speaking profile overview"}
                </h3>
                <p className={glass.stateDesc}>
                    {vi
                        ? "Đã xảy ra gián đoạn kết nối khi đồng bộ dữ liệu luyện tập. Dữ liệu đã lưu của bạn vẫn an toàn."
                        : "A network interruption occurred while loading your speaking summary. Your saved history remains intact."}
                </p>
                <button type="button" onClick={onRetry} className={glass.actionBtnPrimary}>
                    <RefreshCw />
                    <span>{vi ? "Thử tải lại" : "Retry"}</span>
                </button>
            </div>
        );
    }

    // Resolve authoritative fields from `overview` (with backwards-compatible fallback to `legacyProgress`/`legacySummary`)
    const lifetimeCompleted =
        overview?.lifetime.completedSessions ?? legacyProgress?.totalCompletedSessions ?? null;
    const lifetimeInProgress = overview?.lifetime.inProgressSessions ?? null;
    const lifetimeSpeakingSec =
        overview?.lifetime.qualifiedSpeakingSeconds ?? legacyProgress?.totalQualifiedSpeakingSeconds ?? null;
    const lifetimeRoleplayTurns =
        overview?.lifetime.roleplayLearnerTurns ?? legacyProgress?.totalRoleplayTurns ?? null;
    const lifetimeVocabUsed =
        overview?.lifetime.targetVocabularyUsed ?? legacyProgress?.targetVocabularyUsed ?? null;

    const streakDays =
        overview?.recentWindow.currentStreakDays ?? legacyProgress?.currentStreakDays ?? null;
    const sessions30d =
        overview?.recentWindow.sessionsCompleted30d ?? legacySummary?.practiceSummary.sessionsCompleted30d ?? null;
    const sessions7d =
        overview?.recentWindow.sessionsCompleted7d ?? legacySummary?.practiceSummary.sessionsCompleted7d ?? null;
    const sentences30d =
        overview?.recentWindow.sentencesPracticed30d ?? legacySummary?.practiceSummary.sentencesPracticed30d ?? null;
    const sentences7d =
        overview?.recentWindow.sentencesPracticed7d ?? legacySummary?.practiceSummary.sentencesPracticed7d ?? null;
    const activeDays30d =
        overview?.recentWindow.practiceDays30d ?? legacySummary?.practiceSummary.practiceDays30d ?? null;
    const activeDays7d =
        overview?.recentWindow.practiceDays7d ?? legacySummary?.practiceSummary.practiceDays7d ?? null;
    const resolved30d =
        overview?.recentWindow.resolvedTargets30d ?? legacySummary?.practiceSummary.resolvedThisSessionCount30d ?? null;
    const retries30d =
        overview?.recentWindow.retries30d ?? legacySummary?.practiceSummary.retries30d ?? null;
    const avgPron30d =
        overview?.recentWindow.averagePronunciationScore30d ??
        legacySummary?.pronunciationMetrics?.averagePronunciationScore ??
        null;
    const v2Scored30d =
        overview?.recentWindow.v2ScoredAttempts30d ??
        legacySummary?.pronunciationMetrics?.scoredAttemptsCount ??
        0;
    const totalAttempts30d =
        overview?.recentWindow.totalAttempts30d ??
        legacySummary?.pronunciationMetrics?.totalAttemptsCount ??
        0;

    const rhythmBars = buildRhythmBars14d(overview?.activityRhythm30d, vi);
    const maxRhythmVal = Math.max(
        1,
        ...rhythmBars.map((b) => (b.attemptsCount > 0 ? b.attemptsCount : b.completedSessions)),
    );
    const hasAnyRhythmActivity = rhythmBars.some((b) => b.active);
    const selectedBar =
        activeRhythmIdx != null && rhythmBars[activeRhythmIdx]
            ? rhythmBars[activeRhythmIdx]
            : rhythmBars[rhythmBars.length - 1] ?? null;

    const trendNodes = normalizeTrendNodes(overview?.scoreTrend, vi);
    const selectedTrend =
        activeTrendIdx != null && trendNodes[activeTrendIdx]
            ? trendNodes[activeTrendIdx]
            : trendNodes[trendNodes.length - 1] ?? null;

    const strengths = buildStrengthDisplayList(overview, legacySummary, legacyProgress, vi);
    const focusAreas =
        overview?.focusAreas ??
        (legacySummary?.recurringIssues ?? legacyProgress?.weaknessProfile?.issues ?? []).map(normalizeLegacyIssue);
    const recentImprovements = overview?.recentImprovements ?? legacySummary?.recentImprovements ?? [];
    const recentSessions = overview?.recentSessions ?? legacySummary?.recentSessions ?? [];

    return (
        <div className="space-y-5" data-testid="speaking-profile-overview">
            {/* ── 1. Evidence-Backed Hero Summary (Lifetime vs 7d / 30d Windows) ── */}
            <div className={glass.heroBanner}>
                {/* Left: Lifetime Cumulative Stage */}
                <div className={glass.lifetimeStage}>
                    <div className="space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className={glass.windowTag}>
                                <Award size={12} />
                                <span>{vi ? "Tích lũy toàn thời gian" : "Lifetime cumulative"}</span>
                            </span>
                            <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                <Flame size={12} className="text-amber-500" />
                                <span>
                                    {streakDays != null
                                        ? vi
                                            ? `Chuỗi ${streakDays} ngày`
                                            : `${streakDays}d streak`
                                        : vi
                                        ? "Chuỗi —"
                                        : "Streak —"}
                                </span>
                            </span>
                        </div>

                        <div className={glass.lifetimeMetricsRow}>
                            <div className={glass.lifetimeItem}>
                                <div className={`${glass.lifetimeValue} ${glass.mono}`}>
                                    {lifetimeCompleted != null ? lifetimeCompleted : "—"}
                                </div>
                                <div className={glass.lifetimeLabel}>
                                    {vi ? "Phiên hoàn thành" : "Completed sessions"}
                                </div>
                            </div>
                            <div className={glass.lifetimeItem}>
                                <div className={glass.lifetimeValue}>
                                    {formatSpeakingDuration(lifetimeSpeakingSec, vi)}
                                </div>
                                <div className={glass.lifetimeLabel}>
                                    {vi ? "Thời lượng nói hợp lệ" : "Qualified speaking"}
                                </div>
                            </div>
                            <div className={glass.lifetimeItem}>
                                <div className={`${glass.lifetimeValue} ${glass.mono}`}>
                                    {formatScoreOrDash(avgPron30d, "/100")}
                                </div>
                                <div className={glass.lifetimeLabel}>
                                    {vi ? "Điểm V2.2 TB (30d)" : "Avg V2.2 (30d)"}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className={glass.lifetimeFoot}>
                        {lifetimeRoleplayTurns != null && (
                            <span className={glass.kpiSubPill}>
                                <MessageSquare size={11} />
                                <span>
                                    {vi
                                        ? `${lifetimeRoleplayTurns} lượt thoại Role-play`
                                        : `${lifetimeRoleplayTurns} role-play turns`}
                                </span>
                            </span>
                        )}
                        {lifetimeVocabUsed != null && lifetimeVocabUsed > 0 && (
                            <span className={glass.kpiSubPill}>
                                <span>
                                    {vi
                                        ? `${lifetimeVocabUsed} từ mục tiêu đã dùng`
                                        : `${lifetimeVocabUsed} target words used`}
                                </span>
                            </span>
                        )}
                        {lifetimeInProgress != null && lifetimeInProgress > 0 && (
                            <span className={glass.kpiSubPill}>
                                <span>
                                    {vi
                                        ? `${lifetimeInProgress} phiên đang dở`
                                        : `${lifetimeInProgress} in progress`}
                                </span>
                            </span>
                        )}
                    </div>
                </div>

                {/* Right: 30-Day & 7-Day Window Breakdown */}
                <div className="flex flex-col justify-between gap-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className={glass.windowTag} data-tone="indigo">
                            <Calendar size={12} />
                            <span>{vi ? "Hoạt động 30 ngày và 7 ngày gần đây" : "Last 30 days and 7 days"}</span>
                        </span>
                        <span className={glass.sectionSubnote}>
                            {totalAttempts30d > 0
                                ? vi
                                    ? `${totalAttempts30d} lượt thu (${v2Scored30d} chấm V2.2)`
                                    : `${totalAttempts30d} takes (${v2Scored30d} V2.2 scored)`
                                : vi
                                ? "Chưa phát sinh lượt thu trong 30 ngày"
                                : "No recordings in last 30 days"}
                        </span>
                    </div>

                    <div className={glass.recentWindowGrid}>
                        <div className={glass.kpiTile}>
                            <div className={glass.kpiHeader}>
                                <span>{vi ? "Phiên hoàn thành (30d)" : "Sessions (30d)"}</span>
                                <CheckCircle2 />
                            </div>
                            <div className={`${glass.kpiPrimary} ${glass.mono}`}>
                                {sessions30d != null ? (vi ? `${sessions30d} phiên` : `${sessions30d}`) : "—"}
                            </div>
                            <span className={glass.kpiSubPill}>
                                {sessions7d != null
                                    ? vi
                                        ? `7 ngày qua: ${sessions7d} phiên`
                                        : `Last 7d: ${sessions7d}`
                                    : "—"}
                            </span>
                        </div>

                        <div className={glass.kpiTile}>
                            <div className={glass.kpiHeader}>
                                <span>{vi ? "Câu Shadowing (30d)" : "Sentences (30d)"}</span>
                                <Headphones />
                            </div>
                            <div className={`${glass.kpiPrimary} ${glass.mono}`}>
                                {sentences30d != null ? (vi ? `${sentences30d} câu` : `${sentences30d}`) : "—"}
                            </div>
                            <span className={glass.kpiSubPill}>
                                {sentences7d != null
                                    ? vi
                                        ? `7 ngày qua: ${sentences7d} câu`
                                        : `Last 7d: ${sentences7d}`
                                    : "—"}
                            </span>
                        </div>

                        <div className={glass.kpiTile}>
                            <div className={glass.kpiHeader}>
                                <span>{vi ? "Ngày có luyện tập" : "Active days"}</span>
                                <Activity />
                            </div>
                            <div className={`${glass.kpiPrimary} ${glass.mono}`}>
                                {activeDays30d != null ? (vi ? `${activeDays30d}/30 ngày` : `${activeDays30d}/30d`) : "—"}
                            </div>
                            <span className={glass.kpiSubPill}>
                                {activeDays7d != null
                                    ? vi
                                        ? `7 ngày qua: ${activeDays7d}/7 ngày`
                                        : `Last 7d: ${activeDays7d}/7d`
                                    : "—"}
                            </span>
                        </div>

                        <div className={glass.kpiTile}>
                            <div className={glass.kpiHeader}>
                                <span>{vi ? "Mục tiêu sửa đúng" : "Targets resolved"}</span>
                                <Target />
                            </div>
                            <div className={`${glass.kpiPrimary} ${glass.mono}`}>
                                {resolved30d != null ? (vi ? `${resolved30d} lần` : `${resolved30d}`) : "—"}
                            </div>
                            <span className={glass.kpiSubPill}>
                                {retries30d != null
                                    ? vi
                                        ? `Qua ${retries30d} lượt Retry`
                                        : `Across ${retries30d} retries`
                                    : "—"}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── 2. Interactive Practice Consistency Rhythm + Score Progression Sparkline ── */}
            <div className={glass.twoColGrid}>
                {/* Card A: 14-Day Practice Consistency Rhythm */}
                <section className={glass.glassCard} data-tone="cyan" aria-labelledby="sp-rhythm-heading">
                    <div className={glass.sectionHeader}>
                        <div className={glass.sectionTitleRow}>
                            <span className={glass.sectionIconBadge} data-tone="cyan" aria-hidden="true">
                                <Activity />
                            </span>
                            <h3 id="sp-rhythm-heading">
                                {vi ? "Nhịp độ rèn luyện (14 ngày gần đây)" : "Practice Consistency (Last 14 Days)"}
                            </h3>
                        </div>
                        <span className={glass.sectionSubnote}>
                            {vi ? "Chạm hoặc di chuột từng ngày" : "Hover or tap a day"}
                        </span>
                    </div>

                    {rhythmBars.length > 0 ? (
                        <>
                            <div className={glass.chartReadoutBar} aria-live="polite">
                                {selectedBar ? (
                                    <>
                                        <span>
                                            <strong>{selectedBar.fullLabel}</strong>
                                            {" · "}
                                            {selectedBar.active
                                                ? vi
                                                    ? `${selectedBar.completedSessions} phiên · ${selectedBar.attemptsCount} lượt thu`
                                                    : `${selectedBar.completedSessions} sessions · ${selectedBar.attemptsCount} takes`
                                                : vi
                                                ? "Nghỉ ngơi (0 lượt thu)"
                                                : "Rest day (0 takes)"}
                                        </span>
                                        <span className={glass.mono}>
                                            {selectedBar.speakingSeconds > 0
                                                ? formatSpeakingDuration(selectedBar.speakingSeconds, vi)
                                                : selectedBar.averageScore != null
                                                ? `${selectedBar.averageScore}/100`
                                                : ""}
                                        </span>
                                    </>
                                ) : null}
                            </div>

                            <div className={glass.rhythmColumns} role="group" aria-label={vi ? "Biểu đồ tần suất luyện nói 14 ngày" : "14-day practice bar chart"}>
                                {rhythmBars.map((bar, idx) => {
                                    const rawMetric = bar.attemptsCount > 0 ? bar.attemptsCount : bar.completedSessions;
                                    const heightPct = bar.active
                                        ? Math.max(16, Math.round((rawMetric / maxRhythmVal) * 100))
                                        : 0;
                                    const isFocused = (activeRhythmIdx ?? rhythmBars.length - 1) === idx;
                                    return (
                                        <button
                                            key={bar.dateKey}
                                            type="button"
                                            className={glass.rhythmColBtn}
                                            data-active={isFocused ? "true" : undefined}
                                            onMouseEnter={() => setActiveRhythmIdx(idx)}
                                            onFocus={() => setActiveRhythmIdx(idx)}
                                            onClick={() => setActiveRhythmIdx(idx)}
                                            aria-label={`${bar.fullLabel}: ${bar.completedSessions} phiên, ${bar.attemptsCount} lượt thu`}
                                        >
                                            <span className={glass.rhythmTrack} aria-hidden="true">
                                                <span
                                                    className={
                                                        bar.active
                                                            ? glass.rhythmFill
                                                            : `${glass.rhythmFill} ${glass.rhythmFillEmpty}`
                                                    }
                                                    style={bar.active ? { height: `${heightPct}%` } : undefined}
                                                />
                                            </span>
                                            <span className={`${glass.rhythmDayLabel} ${glass.mono}`}>
                                                {idx % 2 === 0 || idx === rhythmBars.length - 1
                                                    ? bar.shortLabel.slice(0, 2)
                                                    : "·"}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>

                            {!hasAnyRhythmActivity && (
                                <p className={`${glass.sectionSubnote} mt-2`}>
                                    {vi
                                        ? "Chưa ghi nhận lượt thu âm nào trong 14 ngày vừa qua. Một buổi Quick Check hoặc Shadowing ngắn sẽ khởi động lại nhịp tập của bạn."
                                        : "No speaking recordings in the last 14 days. Start a short Quick Check or Shadowing lesson to build momentum."}
                                </p>
                            )}
                        </>
                    ) : (
                        <div className={glass.stateCard}>
                            <p className={glass.stateDesc}>
                                {vi
                                    ? "Hoàn thành buổi tập đầu tiên để mở biểu đồ nhịp độ rèn luyện hàng ngày."
                                    : "Complete your first practice session to unlock your daily consistency rhythm."}
                            </p>
                        </div>
                    )}
                </section>

                {/* Card B: Score Progression Sparkline */}
                <section className={glass.glassCard} data-tone="indigo" aria-labelledby="sp-trend-heading">
                    <div className={glass.sectionHeader}>
                        <div className={glass.sectionTitleRow}>
                            <span className={glass.sectionIconBadge} aria-hidden="true">
                                <TrendingUp />
                            </span>
                            <h3 id="sp-trend-heading">
                                {vi ? "Diễn biến điểm qua các phiên" : "Session Score Progression"}
                            </h3>
                        </div>
                        <span className={glass.sectionSubnote}>
                            {trendNodes.length >= 2
                                ? vi
                                    ? `${trendNodes.length} phiên có chấm điểm`
                                    : `${trendNodes.length} scored sessions`
                                : vi
                                ? "Cần >= 2 phiên có điểm"
                                : "Requires >= 2 scored sessions"}
                        </span>
                    </div>

                    {trendNodes.length >= 2 ? (
                        <>
                            <div className={glass.chartReadoutBar} aria-live="polite">
                                {selectedTrend ? (
                                    <>
                                        <span className="truncate max-w-[70%]">
                                            <strong>{selectedTrend.dateShort}</strong>
                                            {" · "}
                                            {selectedTrend.modeLabel}: {selectedTrend.title}
                                        </span>
                                        <span className={glass.mono}>
                                            {selectedTrend.pronunciationScore != null
                                                ? `V2.2: ${selectedTrend.pronunciationScore}/100`
                                                : `STT: ${selectedTrend.contentMatchScore}%`}
                                        </span>
                                    </>
                                ) : null}
                            </div>

                            {(() => {
                                const w = 420;
                                const h = 118;
                                const padX = 18;
                                const padY = 14;
                                const plotW = w - padX * 2;
                                const plotH = h - padY * 2;
                                const coords = trendNodes.map((n, i) => {
                                    const x =
                                        trendNodes.length === 1
                                            ? w / 2
                                            : padX + (i / (trendNodes.length - 1)) * plotW;
                                    const y = padY + (1 - n.primaryScore / 100) * plotH;
                                    return { x, y, node: n, idx: i };
                                });
                                const linePath = coords
                                    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
                                    .join(" ");
                                const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${(h - padY).toFixed(1)} L${coords[0].x.toFixed(1)},${(h - padY).toFixed(1)} Z`;

                                return (
                                    <div className={glass.sparkWrap}>
                                        <svg
                                            className={glass.sparkSvg}
                                            viewBox={`0 0 ${w} ${h}`}
                                            role="img"
                                            aria-label={vi ? "Biểu đồ đường tiến triển điểm phát âm" : "Score progression chart"}
                                        >
                                            <defs>
                                                <linearGradient id="spTrendStroke" x1="0%" y1="0%" x2="100%" y2="0%">
                                                    <stop offset="0%" stopColor="#06b6d4" />
                                                    <stop offset="55%" stopColor="#4f46e5" />
                                                    <stop offset="100%" stopColor="#a855f7" />
                                                </linearGradient>
                                                <linearGradient id="spTrendArea" x1="0%" y1="0%" x2="0%" y2="100%">
                                                    <stop offset="0%" stopColor="rgb(79 70 229)" stopOpacity="0.28" />
                                                    <stop offset="100%" stopColor="rgb(14 165 233)" stopOpacity="0.0" />
                                                </linearGradient>
                                            </defs>
                                            {[25, 50, 75].map((pct) => {
                                                const gy = padY + (1 - pct / 100) * plotH;
                                                return (
                                                    <line
                                                        key={pct}
                                                        x1={padX}
                                                        x2={w - padX}
                                                        y1={gy}
                                                        y2={gy}
                                                        className={glass.sparkGridLine}
                                                    />
                                                );
                                            })}
                                            <path d={areaPath} className={glass.sparkArea} />
                                            <path d={linePath} className={glass.sparkLine} />
                                            {coords.map(({ x, y, node, idx }) => {
                                                const active = (activeTrendIdx ?? coords.length - 1) === idx;
                                                return (
                                                    <g
                                                        key={`${node.sessionId}-${idx}`}
                                                        className={glass.sparkDotGroup}
                                                        data-active={active ? "true" : undefined}
                                                        tabIndex={0}
                                                        role="button"
                                                        aria-label={`${node.dateFull} - ${node.title}: ${node.primaryScore}`}
                                                        onMouseEnter={() => setActiveTrendIdx(idx)}
                                                        onFocus={() => setActiveTrendIdx(idx)}
                                                        onClick={() => {
                                                            setActiveTrendIdx(idx);
                                                            if (node.sessionId > 0) {
                                                                onOpenSessionDetail(node.sessionId);
                                                            }
                                                        }}
                                                        onKeyDown={(e) => {
                                                            if ((e.key === "Enter" || e.key === " ") && node.sessionId > 0) {
                                                                e.preventDefault();
                                                                onOpenSessionDetail(node.sessionId);
                                                            }
                                                        }}
                                                    >
                                                        <circle cx={x} cy={y} r={10} className={glass.sparkDotOuter} />
                                                        <circle cx={x} cy={y} r={active ? 4.8 : 3.8} className={glass.sparkDotCore} />
                                                    </g>
                                                );
                                            })}
                                        </svg>
                                    </div>
                                );
                            })()}
                        </>
                    ) : (
                        <div className={glass.stateCard}>
                            <span className={glass.stateIcon} aria-hidden="true">
                                <BarChart3 />
                            </span>
                            <h4 className={glass.stateTitle}>
                                {trendNodes.length === 1
                                    ? vi
                                        ? `Đã ghi nhận 1 phiên có điểm (${trendNodes[0].primaryScore}/100)`
                                        : `1 scored session recorded (${trendNodes[0].primaryScore}/100)`
                                    : vi
                                    ? "Chưa đủ dữ liệu để vẽ đường xu hướng"
                                    : "Insufficient data for score trend"}
                            </h4>
                            <p className={glass.stateDesc}>
                                {vi
                                    ? "Hệ thống chỉ vẽ đường tiến triển khi có ít nhất 2 phiên được chấm điểm thực tế để tránh suy diễn sai lệch."
                                    : "At least 2 scored speaking sessions are required before plotting a trend line."}
                            </p>
                        </div>
                    )}
                </section>
            </div>

            {/* ── 3. Recorded Strengths & Prioritized Focus Areas ── */}
            <div className={glass.twoColGrid}>
                {/* Recorded Strengths Card */}
                <section className={glass.glassCard} data-tone="emerald" aria-labelledby="sp-strengths-heading">
                    <div className={glass.sectionHeader}>
                        <div className={glass.sectionTitleRow}>
                            <span className={glass.sectionIconBadge} data-tone="emerald" aria-hidden="true">
                                <ShieldCheck />
                            </span>
                            <h3 id="sp-strengths-heading">
                                {vi ? "Điểm mạnh đã ghi nhận" : "Recorded Strengths"}
                            </h3>
                        </div>
                        <span className={glass.sectionSubnote}>
                            {vi ? "Từ bằng chứng thực tế" : "Evidence-backed"}
                        </span>
                    </div>

                    {strengths.length > 0 ? (
                        <div className={glass.strengthList}>
                            {strengths.map((item) => (
                                <div key={item.id} className={glass.strengthRow}>
                                    <div className={glass.strengthTop}>
                                        <div className="flex items-start gap-2.5 min-w-0">
                                            <CheckCircle2 />
                                            <div className="min-w-0">
                                                <div className="font-extrabold text-sm">{item.title}</div>
                                                <p className={glass.issueMeta}>{item.detail}</p>
                                            </div>
                                        </div>
                                        <span className={`${glass.kpiSubPill} ${glass.mono} shrink-0`}>
                                            {item.badge}
                                        </span>
                                    </div>
                                    <div className={glass.miniMeterTrack} aria-hidden="true">
                                        <div className={glass.miniMeterFill} style={{ width: `${item.meterPct}%` }} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className={glass.stateCard}>
                            <span className={glass.stateIcon} aria-hidden="true">
                                <ShieldCheck />
                            </span>
                            <h4 className={glass.stateTitle}>
                                {vi ? "Chưa đủ dữ liệu để xác nhận điểm mạnh" : "Building evidence for strengths"}
                            </h4>
                            <p className={glass.stateDesc}>
                                {vi
                                    ? `Cần tối thiểu ${overview?.dataSufficiency.minScoredAttemptsForStrength ?? 3} lượt chấm âm học V2.2 hoặc thói quen luyện tập nhiều ngày để hệ thống tổng hợp điểm mạnh đáng tin cậy.`
                                    : "Complete a few more scored speaking attempts so English Coach can verify your strongest skills."}
                            </p>
                            <button
                                type="button"
                                onClick={() => onJumpToPractice("shadowing")}
                                className={glass.actionBtnGhost}
                            >
                                <span>{vi ? "Luyện Shadowing ngay" : "Practice Shadowing"}</span>
                                <ArrowRight />
                            </button>
                        </div>
                    )}
                </section>

                {/* Recent Within-Session Improvements & Quick Jump */}
                <section className={glass.glassCard} data-tone="violet" aria-labelledby="sp-improvements-heading">
                    <div className={glass.sectionHeader}>
                        <div className={glass.sectionTitleRow}>
                            <span className={glass.sectionIconBadge} data-tone="violet" aria-hidden="true">
                                <Award />
                            </span>
                            <h3 id="sp-improvements-heading">
                                {vi ? "Mục tiêu vừa khắc phục thành công" : "Recently Resolved Targets"}
                            </h3>
                        </div>
                        <button
                            type="button"
                            onClick={() => onSelectSubTab("history")}
                            className={glass.actionBtnGhost}
                        >
                            <span>{vi ? "Xem lịch sử" : "View history"}</span>
                            <ChevronRight />
                        </button>
                    </div>

                    {recentImprovements.length > 0 ? (
                        <div className={glass.strengthList}>
                            {recentImprovements.slice(0, 4).map((imp, idx) => (
                                <div key={`${imp.sessionId}-${idx}`} className={glass.strengthRow}>
                                    <div className={glass.strengthTop}>
                                        <div className="flex items-start gap-2.5 min-w-0">
                                            <CheckCircle2 />
                                            <div className="min-w-0">
                                                <div className="font-extrabold text-sm">
                                                    {imp.targetWord
                                                        ? `Từ "${imp.targetWord}"${imp.targetPhone ? ` (/${imp.targetPhone}/)` : ""}`
                                                        : getLearnerIssueLabel(imp.issueType)}
                                                </div>
                                                <p className={glass.issueMeta}>
                                                    {imp.materialTitle}
                                                    {" · "}
                                                    {vi
                                                        ? `Sửa đúng sau ${imp.retryCount} lượt thử lại`
                                                        : `Resolved after ${imp.retryCount} retries`}
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => onOpenSessionDetail(imp.sessionId)}
                                            className={glass.actionBtnGhost}
                                        >
                                            <span>{vi ? "Chi tiết" : "Detail"}</span>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : recentSessions.length > 0 ? (
                        <div className={glass.strengthList}>
                            {recentSessions.slice(0, 3).map((sess) => (
                                <div key={sess.sessionId} className={glass.strengthRow}>
                                    <div className={glass.strengthTop}>
                                        <div className="min-w-0">
                                            <div className="font-extrabold text-sm truncate">
                                                {sess.materialTitle}
                                            </div>
                                            <p className={glass.issueMeta}>
                                                {sess.mode === "QUICK_CHECK"
                                                    ? vi
                                                        ? "Quick Check · 1 câu nói tự do"
                                                        : "Quick Check · 1 utterance"
                                                    : sess.mode === "ROLEPLAY"
                                                    ? vi
                                                        ? `Role-play AI · ${sess.attemptCount} lượt thoại`
                                                        : `Role-play AI · ${sess.attemptCount} turns`
                                                    : vi
                                                    ? `Shadowing · ${sess.sentencesPracticed}/${sess.totalSentences} câu`
                                                    : `Shadowing · ${sess.sentencesPracticed}/${sess.totalSentences} sentences`}
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => onOpenSessionDetail(sess.sessionId)}
                                            className={glass.actionBtnGhost}
                                        >
                                            <span>{vi ? "Chi tiết" : "Detail"}</span>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className={glass.stateCard}>
                            <span className={glass.stateIcon} aria-hidden="true">
                                <Clock />
                            </span>
                            <h4 className={glass.stateTitle}>
                                {vi ? "Chưa có mục tiêu Retry được giải quyết" : "No retry resolutions yet"}
                            </h4>
                            <p className={glass.stateDesc}>
                                {vi
                                    ? "Khi luyện Shadowing, hãy sử dụng nút Thu lại (Retry) trên các từ được gợi ý để theo dõi tiến bộ khắc phục tức thì tại đây."
                                    : "Use Retry on highlighted words during Shadowing to record immediate within-session improvements."}
                            </p>
                        </div>
                    )}
                </section>
            </div>

            {/* ── 4. Prioritized Improvement Focus Cards with 1-Click Jump to Practice ── */}
            <section className={glass.glassCard} data-tone="amber" aria-labelledby="sp-focus-heading">
                <div className={glass.sectionHeader}>
                    <div className={glass.sectionTitleRow}>
                        <span className={glass.sectionIconBadge} data-tone="amber" aria-hidden="true">
                            <Target />
                        </span>
                        <div>
                            <h3 id="sp-focus-heading">
                                {vi ? "Trọng tâm ưu tiên cần rèn luyện" : "Prioritized Improvement Focus"}
                            </h3>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => onSelectSubTab("pronunciation")}
                        className={glass.actionBtnGhost}
                    >
                        <Mic />
                        <span>{vi ? "Mở phân tích âm học V2.2" : "Open V2.2 acoustics"}</span>
                        <ChevronRight />
                    </button>
                </div>

                {focusAreas.length > 0 ? (
                    <div className={glass.issueGrid}>
                        {focusAreas.slice(0, 4).map((issue, idx) => {
                            const statusMeta = resolveRecurringStatusMeta(issue.status);
                            const firstEx = issue.recentExamples?.[0];
                            return (
                                <article key={`${issue.issueKey || idx}`} className={glass.issueCard}>
                                    <div className="space-y-2">
                                        <div className={glass.issueHead}>
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                <span className={glass.categoryChip} data-cat={issue.category || "PRONUNCIATION"}>
                                                    {getLearnerCategoryLabel(issue.category)}
                                                </span>
                                                {issue.targetPhone && (
                                                    <span className={`${glass.phonePill} ${glass.mono}`}>
                                                        /{issue.targetPhone}/
                                                    </span>
                                                )}
                                            </div>
                                            <span className={glass.statusBadge} data-status={statusMeta.key}>
                                                {vi ? statusMeta.labelVi : statusMeta.labelEn}
                                            </span>
                                        </div>

                                        <h4 className={glass.issueTitle}>
                                            {issue.title || getLearnerIssueLabel(issue.issueType, issue.targetWord)}
                                        </h4>
                                        <p className={glass.issueMeta}>
                                            {issue.statusExplanation ||
                                                (issue.distinctSessionsObserved > 0
                                                    ? vi
                                                        ? `Quan sát trong ${issue.distinctSessionsObserved} phiên riêng biệt`
                                                        : `Observed across ${issue.distinctSessionsObserved} distinct sessions`
                                                    : issue.displayCue)}
                                        </p>

                                        {issue.displayCue && issue.statusExplanation && (
                                            <div className={glass.cueCallout}>{issue.displayCue}</div>
                                        )}

                                        {issue.recentExamples && issue.recentExamples.length > 0 && (
                                            <div className={glass.exampleChips}>
                                                <span className={glass.sectionSubnote}>
                                                    {vi ? "Ví dụ:" : "Examples:"}
                                                </span>
                                                {issue.recentExamples.slice(0, 3).map((ex, eIdx) => (
                                                    <span key={eIdx} className={glass.exampleChip}>
                                                        {ex.targetWord || ex.originalPhrase || ex.sentenceSnippet}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex items-center justify-end pt-1">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                if (issue.practiceAgainRoute) {
                                                    router.push(issue.practiceAgainRoute);
                                                } else if (firstEx?.mode) {
                                                    onJumpToPractice(practiceModeFromSessionMode(firstEx.mode));
                                                } else if (
                                                    issue.category === "GRAMMAR" ||
                                                    issue.category === "VOCABULARY" ||
                                                    issue.category === "NATURALNESS"
                                                ) {
                                                    onJumpToPractice("roleplay");
                                                } else {
                                                    onJumpToPractice("shadowing");
                                                }
                                            }}
                                            className={glass.actionBtnPrimary}
                                        >
                                            <span>{issue.practiceAgainLabel || (vi ? "Luyện tập ngay" : "Practice now")}</span>
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
                            <CheckCircle2 />
                        </span>
                        <h4 className={glass.stateTitle}>
                            {overview?.dataSufficiency.hasAnyPractice
                                ? vi
                                    ? "Chưa ghi nhận lỗi lặp lại qua nhiều buổi tập"
                                    : "No recurring cross-session issues detected"
                                : vi
                                ? "Chưa có dữ liệu mục tiêu cần cải thiện"
                                : "No focus targets recorded yet"}
                        </h4>
                        <p className={glass.stateDesc}>
                            {overview?.dataSufficiency.hasAnyPractice
                                ? vi
                                    ? "Một điểm yếu chỉ được đưa vào danh sách trọng tâm khi lặp lại qua ít nhất 2 phiên riêng biệt. Hãy tiếp tục duy trì luyện nói đều đặn!"
                                    : "Issues are promoted to recurring priorities only when observed across at least 2 distinct sessions."
                                : vi
                                ? "Bắt đầu một bài Shadowing, hội thoại Role-play AI hoặc Quick Check để hệ thống phân tích trọng tâm cá nhân hóa cho bạn."
                                : "Start a Shadowing passage, AI Role-play, or Quick Check so English Coach can identify personalized focus areas."}
                        </p>
                        <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                            <button
                                type="button"
                                onClick={() => onJumpToPractice("shadowing")}
                                className={glass.actionBtnPrimary}
                            >
                                <Headphones />
                                <span>{vi ? "Mở thư viện Shadowing" : "Open Shadowing"}</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => onJumpToPractice("assessment")}
                                className={glass.actionBtnGhost}
                            >
                                <Mic />
                                <span>{vi ? "Thử Quick Check" : "Try Quick Check"}</span>
                            </button>
                        </div>
                    </div>
                )}
            </section>
        </div>
    );
}
