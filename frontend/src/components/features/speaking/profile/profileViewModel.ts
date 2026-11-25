import type {
    SpeakingProgress,
    SpeakingProgressSummary,
} from "@/services/speakingApi";
import type {
    SpeakingDailyActivityPoint,
    SpeakingIssueStatus,
    SpeakingProfileOverview,
    SpeakingProfilePronunciationMetrics,
    SpeakingProfileRecurringIssue,
    SpeakingScoreTrendPoint,
    SpeakingStrengthItem,
} from "@/services/speakingProfileApi";
import { getLearnerCategoryLabel, getLearnerIssueLabel } from "@/lib/speaking/labels";

export interface RecurringStatusMeta {
    key: SpeakingIssueStatus;
    labelVi: string;
    labelEn: string;
}

export function resolveRecurringStatusMeta(status?: string | null): RecurringStatusMeta {
    switch (status) {
        case "IMPROVING":
            return { key: "IMPROVING", labelVi: "Đang tiến bộ", labelEn: "Improving" };
        case "PRACTICING":
            return { key: "PRACTICING", labelVi: "Đang luyện tập", labelEn: "Practicing" };
        case "RECENTLY_STABLE":
            return { key: "RECENTLY_STABLE", labelVi: "Đã ổn định", labelEn: "Stabilized" };
        case "INSUFFICIENT_DATA":
            return { key: "INSUFFICIENT_DATA", labelVi: "Chưa đủ dữ liệu", labelEn: "Insufficient data" };
        case "NEEDS_ATTENTION":
        default:
            return { key: "NEEDS_ATTENTION", labelVi: "Cần chú ý", labelEn: "Needs focus" };
    }
}

export function formatSpeakingDuration(seconds?: number | null, vi = true): string {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
    const whole = Math.round(seconds);
    if (whole === 0) return vi ? "0 phút" : "0 min";
    if (whole < 60) return vi ? `${whole} giây` : `${whole}s`;
    const mins = Math.floor(whole / 60);
    if (mins < 60) return vi ? `${mins} phút` : `${mins} min`;
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (remMins === 0) return vi ? `${hrs} giờ` : `${hrs}h`;
    return vi ? `${hrs} giờ ${remMins} phút` : `${hrs}h ${remMins}m`;
}

export function formatScoreOrDash(value?: number | null, suffix = ""): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    return `${Math.round(value)}${suffix}`;
}

export function formatSessionModeLabel(mode?: string | null): string {
    const upper = (mode || "").toUpperCase();
    if (upper === "ROLEPLAY") return "Role-play AI";
    if (upper === "QUICK_CHECK") return "Quick Check";
    return "Shadowing";
}

export function practiceModeFromSessionMode(
    mode?: string | null,
): "shadowing" | "roleplay" | "assessment" {
    const upper = (mode || "").toUpperCase();
    if (upper === "ROLEPLAY") return "roleplay";
    if (upper === "QUICK_CHECK") return "assessment";
    return "shadowing";
}

export interface RhythmDayBar {
    dateKey: string;
    shortLabel: string;
    fullLabel: string;
    active: boolean;
    completedSessions: number;
    attemptsCount: number;
    speakingSeconds: number;
    averageScore: number | null;
}

/**
 * Normalizes the last 14 days from `activityRhythm30d` (or builds an honest 14-day calendar slice
 * from real `recentSessions` timestamps if fallback props are used). Never fabricates activity.
 */
export function buildRhythmBars14d(
    activityRhythm30d?: SpeakingDailyActivityPoint[] | null,
    vi = true,
): RhythmDayBar[] {
    if (Array.isArray(activityRhythm30d) && activityRhythm30d.length > 0) {
        return activityRhythm30d.slice(-14).map((pt) => {
            const parsed = pt.date ? new Date(`${pt.date}T00:00:00`) : null;
            const valid = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
            const shortLabel = valid
                ? `${String(valid.getDate()).padStart(2, "0")}/${String(valid.getMonth() + 1).padStart(2, "0")}`
                : pt.date.slice(-5);
            const fullLabel = valid
                ? valid.toLocaleDateString(vi ? "vi-VN" : "en-US", {
                      weekday: "short",
                      day: "2-digit",
                      month: "2-digit",
                  })
                : pt.date;
            return {
                dateKey: pt.date,
                shortLabel,
                fullLabel,
                active: Boolean(pt.active || pt.completedSessions > 0 || pt.attemptsCount > 0),
                completedSessions: Math.max(0, pt.completedSessions ?? 0),
                attemptsCount: Math.max(0, pt.attemptsCount ?? 0),
                speakingSeconds: Math.max(0, pt.speakingSeconds ?? 0),
                averageScore:
                    typeof pt.averageScore === "number" && Number.isFinite(pt.averageScore)
                        ? Math.round(pt.averageScore)
                        : null,
            };
        });
    }
    return [];
}

export interface NormalizedTrendNode {
    sessionId: number;
    title: string;
    modeLabel: string;
    dateShort: string;
    dateFull: string;
    primaryScore: number;
    primaryMetricKind: "pronunciation" | "contentMatch";
    pronunciationScore: number | null;
    contentMatchScore: number | null;
    fluencyScore: number | null;
    attemptCount: number;
}

export function normalizeTrendNodes(
    trend?: SpeakingScoreTrendPoint[] | null,
    vi = true,
): NormalizedTrendNode[] {
    if (!Array.isArray(trend) || trend.length === 0) return [];
    const nodes: NormalizedTrendNode[] = [];
    for (const pt of trend) {
        const pron =
            typeof pt.pronunciationScore === "number" && Number.isFinite(pt.pronunciationScore)
                ? Math.max(0, Math.min(100, Math.round(pt.pronunciationScore)))
                : null;
        const match =
            typeof pt.contentMatchScore === "number" && Number.isFinite(pt.contentMatchScore)
                ? Math.max(0, Math.min(100, Math.round(pt.contentMatchScore)))
                : null;
        const flu =
            typeof pt.fluencyScore === "number" && Number.isFinite(pt.fluencyScore)
                ? Math.max(0, Math.min(100, Math.round(pt.fluencyScore)))
                : null;

        const primary = pron ?? match;
        if (primary == null) continue;

        const d = pt.timestamp ? new Date(pt.timestamp) : null;
        const valid = d && !Number.isNaN(d.getTime()) ? d : null;
        const dateShort = valid
            ? `${String(valid.getDate()).padStart(2, "0")}/${String(valid.getMonth() + 1).padStart(2, "0")}`
            : "—";
        const dateFull = valid
            ? valid.toLocaleDateString(vi ? "vi-VN" : "en-US", {
                  day: "2-digit",
                  month: "2-digit",
                  year: "numeric",
              })
            : pt.timestamp || "—";

        nodes.push({
            sessionId: pt.sessionId,
            title: pt.title || formatSessionModeLabel(pt.mode),
            modeLabel: formatSessionModeLabel(pt.mode),
            dateShort,
            dateFull,
            primaryScore: primary,
            primaryMetricKind: pron != null ? "pronunciation" : "contentMatch",
            pronunciationScore: pron,
            contentMatchScore: match,
            fluencyScore: flu,
            attemptCount: Math.max(0, pt.attemptCount ?? 0),
        });
    }
    return nodes.slice(-14);
}

export interface StrengthDisplayItem {
    id: string;
    title: string;
    detail: string;
    badge: string;
    windowLabel: string;
    meterPct: number;
}

export function buildStrengthDisplayList(
    overview?: SpeakingProfileOverview | null,
    legacySummary?: SpeakingProgressSummary | null,
    legacyProgress?: SpeakingProgress | null,
    vi = true,
): StrengthDisplayItem[] {
    if (overview?.strengths && overview.strengths.length > 0) {
        return overview.strengths.slice(0, 4).map((s: SpeakingStrengthItem) => {
            const num = typeof s.score === "number" && Number.isFinite(s.score) ? Math.round(s.score) : null;
            let badge = vi ? "Đã ghi nhận" : "Recorded";
            let meterPct = 76;
            if (num != null) {
                if (s.unit === "/100") {
                    badge = `${num}/100`;
                    meterPct = Math.max(14, Math.min(100, num));
                } else if (s.unit === "%") {
                    badge = `${num}%`;
                    meterPct = Math.max(14, Math.min(100, num));
                } else if (s.unit === "days") {
                    badge = vi ? `${num} ngày` : `${num} days`;
                    meterPct = Math.max(20, Math.min(100, Math.round((num / 30) * 100) + 25));
                } else if (s.unit === "targets") {
                    badge = vi ? `${num} mục tiêu` : `${num} targets`;
                    meterPct = Math.min(100, 45 + num * 12);
                } else {
                    badge = vi ? `${num} phiên` : `${num} sessions`;
                    meterPct = Math.min(100, 40 + num * 8);
                }
            }
            return {
                id: s.id,
                title: vi ? s.titleVi : s.titleEn,
                detail: vi ? s.detailVi : s.detailEn,
                badge,
                windowLabel: vi ? s.windowLabelVi : s.windowLabelEn,
                meterPct,
            };
        });
    }

    // Legacy prop fallback when rendered with `summary` / `progress` directly in tests
    const out: StrengthDisplayItem[] = [];
    const pm = legacySummary?.pronunciationMetrics;
    const ps = legacySummary?.practiceSummary;

    if (pm?.averageContentMatchScore != null && pm.averageContentMatchScore >= 70) {
        const v = Math.round(pm.averageContentMatchScore);
        out.push({
            id: "legacy_content_match",
            title: vi ? "Độ khớp nội dung rõ ràng" : "Strong content match",
            detail: vi
                ? `Khớp nội dung trung bình đạt ${v}% theo Whisper STT (${pm.totalAttemptsCount} lượt thu).`
                : `Average content match ${v}% across ${pm.totalAttemptsCount} recordings.`,
            badge: `${v}%`,
            windowLabel: vi ? "30 ngày qua" : "Last 30 days",
            meterPct: v,
        });
    }
    if (pm?.averagePronunciationScore != null && pm.averagePronunciationScore >= 70) {
        const v = Math.round(pm.averagePronunciationScore);
        out.push({
            id: "legacy_pron",
            title: vi ? "Phát âm âm học V2.2 ổn định" : "Consistent V2.2 pronunciation",
            detail: vi
                ? `Điểm phát âm tổng thể trung bình đạt ${v}/100 qua ${pm.scoredAttemptsCount} lượt phân tích.`
                : `Average V2.2 pronunciation ${v}/100 across ${pm.scoredAttemptsCount} scored attempts.`,
            badge: `${v}/100`,
            windowLabel: vi ? "30 ngày qua" : "Last 30 days",
            meterPct: v,
        });
    }
    if ((ps?.resolvedThisSessionCount30d ?? 0) > 0) {
        const c = ps!.resolvedThisSessionCount30d;
        out.push({
            id: "legacy_retry",
            title: vi ? "Khắc phục phát âm qua Retry" : "Retry target resolution",
            detail: vi
                ? `Đã sửa đúng thành công ${c} mục tiêu phát âm ngay trong buổi tập.`
                : `Resolved ${c} pronunciation targets within practice sessions.`,
            badge: vi ? `${c} mục tiêu` : `${c} targets`,
            windowLabel: vi ? "30 ngày qua" : "Last 30 days",
            meterPct: Math.min(100, 48 + c * 10),
        });
    }
    if ((legacyProgress?.totalCompletedSessions ?? 0) > 0 && out.length < 3) {
        const c = legacyProgress!.totalCompletedSessions;
        out.push({
            id: "legacy_sessions",
            title: vi ? "Hoàn thành phiên luyện nói" : "Completed speaking sessions",
            detail: vi
                ? `Tích lũy ${c} phiên luyện nói Shadowing và Role-play hoàn chỉnh.`
                : `Completed ${c} full Shadowing and Role-play sessions.`,
            badge: vi ? `${c} phiên` : `${c} sessions`,
            windowLabel: vi ? "Toàn thời gian" : "Lifetime",
            meterPct: Math.min(100, 42 + c * 7),
        });
    }
    return out.slice(0, 4);
}

/**
 * Builds compact page number tokens with `-1` standing for an ellipsis gap.
 */
export function buildPaginationTokens(currentZeroBased: number, totalPages: number): number[] {
    if (totalPages <= 1) return [0];
    if (totalPages <= 7) {
        return Array.from({ length: totalPages }, (_, i) => i);
    }
    const pages = new Set<number>([0, totalPages - 1, currentZeroBased, currentZeroBased - 1, currentZeroBased + 1]);
    const sorted = [...pages].filter((p) => p >= 0 && p < totalPages).sort((a, b) => a - b);
    const tokens: number[] = [];
    for (let i = 0; i < sorted.length; i += 1) {
        if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
            tokens.push(-1);
        }
        tokens.push(sorted[i]);
    }
    return tokens;
}

export function mapLegacyMetricsToProfileMetrics(
    pm?: SpeakingProgressSummary["pronunciationMetrics"] | null,
): SpeakingProfilePronunciationMetrics | null {
    if (!pm) return null;
    const total = Math.max(0, pm.totalAttemptsCount ?? 0);
    const scored = Math.max(0, pm.scoredAttemptsCount ?? 0);
    return {
        averagePronunciationScore: pm.averagePronunciationScore ?? null,
        averageContentMatchScore: pm.averageContentMatchScore ?? null,
        averagePhonemeScore: pm.averagePhonemeScore ?? null,
        averageStressScore: pm.averageStressScore ?? null,
        averagePitchScore: pm.averagePitchScore ?? null,
        averageRhythmScore: pm.averageRhythmScore ?? null,
        averageFluencyScore: pm.averageFluencyScore ?? null,
        scoredAttemptsCount: scored,
        totalAttemptsCount: total,
        abstainedAttemptsCount: Math.max(0, total - scored),
        sttOnlyAttemptsCount: 0,
        lexicalStressMatchedWords: 0,
        lexicalStressAssessedWords: 0,
        lexicalStressAssessmentsCount: 0,
        contentMatchAttemptsCount: total,
        shadowingScoredCount: scored,
        quickCheckScoredCount: 0,
        roleplayScoredCount: 0,
    };
}

export function normalizeLegacyIssue(
    issue: NonNullable<SpeakingProgressSummary["recurringIssues"]>[number],
): SpeakingProfileRecurringIssue {
    return {
        issueKey: issue.issueKey,
        category: issue.category,
        title: issue.title,
        issueType: issue.issueType,
        targetWord: issue.targetWord,
        targetPhone: issue.targetPhone,
        status: issue.status || "NEEDS_ATTENTION",
        statusExplanation: issue.statusExplanation,
        distinctSessionsObserved: issue.distinctSessionsObserved,
        totalOccurrences: issue.totalOccurrences,
        resolvedSessionCount: issue.resolvedSessionCount,
        lastObservedAt: issue.lastObservedAt,
        displayCue: issue.displayCue,
        evidenceWindow: issue.evidenceWindow,
        recentExamples: issue.recentExamples,
        practiceAgainRoute: issue.practiceAgainRoute,
        practiceAgainLabel: issue.practiceAgainLabel,
    };
}

export { getLearnerCategoryLabel, getLearnerIssueLabel };
