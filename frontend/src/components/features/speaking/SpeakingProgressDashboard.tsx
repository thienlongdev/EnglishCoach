"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    AlertCircle,
    ArrowRight,
    Award,
    Calendar,
    CheckCircle2,
    ChevronRight,
    Clock,
    Eye,
    Mic,
    Play,
    RefreshCw,
    TrendingUp,
} from "lucide-react";
import {
    SpeakingProgressSummary,
    SpeakingSessionDetail,
    SpeakingSessionSummary,
    getSpeakingProgressSummary,
    getSpeakingSessionDetail,
    getSpeakingSessionHistory,
} from "@/services/speakingApi";
import { ProfileSessionDetailDrawer } from "./profile/ProfileSessionDetailDrawer";
import {
    getLearnerCategoryLabel,
    getLearnerIssueLabel,
    resolveRecurringStatusMeta,
} from "./profile/profileViewModel";
import glass from "./profile/speakingProfileGlass.module.css";

export function SpeakingProgressDashboard() {
    const router = useRouter();
    const [summary, setSummary] = useState<SpeakingProgressSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [historySessions, setHistorySessions] = useState<SpeakingSessionSummary[] | null>(null);
    const [historyPage, setHistoryPage] = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [loadingHistory, setLoadingHistory] = useState(false);

    const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);
    const [sessionDetail, setSessionDetail] = useState<SpeakingSessionDetail | null>(null);
    const [loadingDetail, setLoadingDetail] = useState(false);
    const [detailError, setDetailError] = useState<unknown>(null);

    useEffect(() => {
        void loadSummary();
    }, []);

    const loadSummary = async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await getSpeakingProgressSummary();
            setSummary(data);
        } catch (err) {
            console.error("Failed to load speaking progress summary:", err);
            setError("Không thể tải thông tin tiến độ luyện nói. Vui lòng thử lại.");
        } finally {
            setLoading(false);
        }
    };

    const fetchHistory = async (page: number) => {
        setLoadingHistory(true);
        try {
            const res = await getSpeakingSessionHistory(page, 10);
            setHistorySessions(res.content || []);
            setHistoryPage(res.page);
            setTotalPages(Math.max(1, res.totalPages || 1));
        } catch (err) {
            console.error("Failed to load session history:", err);
        } finally {
            setLoadingHistory(false);
        }
    };

    const openSessionDetail = async (sessionId: number) => {
        setSelectedSessionId(sessionId);
        setSessionDetail(null);
        setDetailError(null);
        setLoadingDetail(true);
        try {
            const detail = await getSpeakingSessionDetail(sessionId);
            setSessionDetail(detail);
        } catch (err) {
            console.error("Failed to load session detail:", err);
            setDetailError(err);
        } finally {
            setLoadingDetail(false);
        }
    };

    if (loading) {
        return (
            <div className={glass.workspace}>
                <div className={glass.skeletonBlock} style={{ height: "9rem" }} />
                <div className={glass.skeletonGrid}>
                    <div className={glass.skeletonBlock} />
                    <div className={glass.skeletonBlock} />
                </div>
            </div>
        );
    }

    if (error || !summary) {
        return (
            <div className={glass.workspace}>
                <div className={glass.stateCard} role="alert">
                    <span className={glass.stateIcon} data-tone="rose" aria-hidden="true">
                        <AlertCircle />
                    </span>
                    <h3 className={glass.stateTitle}>{error || "Chưa có dữ liệu tiến độ."}</h3>
                    <button type="button" onClick={() => void loadSummary()} className={glass.actionBtnPrimary}>
                        <RefreshCw />
                        <span>Thử lại</span>
                    </button>
                </div>
            </div>
        );
    }

    const { practiceSummary, activeSession, recentSessions, recurringIssues, recentImprovements } = summary;
    const hasHistory =
        practiceSummary.sessionsCompleted30d > 0 || (recentSessions && recentSessions.length > 0);
    const displayedSessions = historySessions ?? recentSessions ?? [];

    return (
        <div className={glass.workspace} id="speaking-progress-dashboard">
            {/* 1. Active Session Continue Banner */}
            {activeSession && activeSession.status === "ACTIVE" && (
                <div className={glass.glassCard} data-tone="cyan">
                    <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <div className="space-y-1">
                            <span className={glass.windowTag}>
                                <Play size={11} className="fill-current" />
                                <span>Đang thực hiện</span>
                            </span>
                            <h3 className={glass.title} style={{ fontSize: "1.15rem" }}>
                                Tiếp tục bài luyện Shadowing
                            </h3>
                            <p className={glass.issueMeta}>
                                Đã hoàn thành <strong>{activeSession.completedUnitsCount}</strong> trên tổng số{" "}
                                <strong>{activeSession.totalUnitsCount}</strong> câu trong bài tập này.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => {
                                if (activeSession.sourceId) {
                                    router.push(`/speaking/shadowing/${activeSession.sourceId}`);
                                }
                            }}
                            className={glass.actionBtnPrimary}
                        >
                            <span>Tiếp tục ngay</span>
                            <ArrowRight />
                        </button>
                    </div>
                </div>
            )}

            {/* 2. Practice Summary 30d / 7d Grid */}
            <div className={glass.glassCard} data-tone="indigo">
                <div className={glass.sectionHeader}>
                    <div className={glass.sectionTitleRow}>
                        <span className={glass.sectionIconBadge} aria-hidden="true">
                            <Calendar />
                        </span>
                        <h3>Tổng quan tần suất luyện tập (30 ngày gần đây)</h3>
                    </div>
                </div>
                <div className={glass.recentWindowGrid}>
                    <div className={glass.kpiTile}>
                        <div className={glass.kpiHeader}>
                            <span>Buổi tập hoàn thành</span>
                        </div>
                        <div className={`${glass.kpiPrimary} ${glass.mono}`}>
                            {practiceSummary.sessionsCompleted30d}
                        </div>
                        <span className={glass.kpiSubPill}>
                            7 ngày qua: {practiceSummary.sessionsCompleted7d}
                        </span>
                    </div>
                    <div className={glass.kpiTile}>
                        <div className={glass.kpiHeader}>
                            <span>Số câu đã luyện</span>
                        </div>
                        <div className={`${glass.kpiPrimary} ${glass.mono}`}>
                            {practiceSummary.sentencesPracticed30d}
                        </div>
                        <span className={glass.kpiSubPill}>
                            7 ngày qua: {practiceSummary.sentencesPracticed7d}
                        </span>
                    </div>
                    <div className={glass.kpiTile}>
                        <div className={glass.kpiHeader}>
                            <span>Số ngày có luyện tập</span>
                        </div>
                        <div className={`${glass.kpiPrimary} ${glass.mono}`}>
                            {practiceSummary.practiceDays30d}
                        </div>
                        <span className={glass.kpiSubPill}>
                            7 ngày qua: {practiceSummary.practiceDays7d}/7 ngày
                        </span>
                    </div>
                    <div className={glass.kpiTile}>
                        <div className={glass.kpiHeader}>
                            <span>Mục tiêu đã giải quyết</span>
                        </div>
                        <div className={`${glass.kpiPrimary} ${glass.mono}`}>
                            {practiceSummary.resolvedThisSessionCount30d}
                        </div>
                        <span className={glass.kpiSubPill}>Qua Retry trong phiên</span>
                    </div>
                </div>
            </div>

            {/* 3. Recurring Targets & Within-Session Improvements */}
            <div className={glass.twoColGrid}>
                <div className={glass.glassCard} data-tone="amber">
                    <div className={glass.sectionHeader}>
                        <div className={glass.sectionTitleRow}>
                            <span className={glass.sectionIconBadge} data-tone="amber" aria-hidden="true">
                                <TrendingUp />
                            </span>
                            <h4>Mục tiêu phát âm cần lưu ý</h4>
                        </div>
                    </div>

                    {recurringIssues && recurringIssues.length > 0 ? (
                        <div className="space-y-3">
                            {recurringIssues.map((issue, idx) => {
                                const statusMeta = resolveRecurringStatusMeta(issue.status);
                                return (
                                    <div key={idx} className={glass.issueCard}>
                                        <div className={glass.issueHead}>
                                            <span
                                                className={glass.categoryChip}
                                                data-cat={issue.category || "PRONUNCIATION"}
                                            >
                                                {getLearnerCategoryLabel(issue.category)}
                                            </span>
                                            <span className={glass.statusBadge} data-status={statusMeta.key}>
                                                {statusMeta.labelVi}
                                            </span>
                                        </div>
                                        <div className={glass.issueTitle}>
                                            {issue.title || getLearnerIssueLabel(issue.issueType, issue.targetWord)}
                                        </div>
                                        <p className={glass.issueMeta}>
                                            {issue.statusExplanation ||
                                                `Quan sát trong ${issue.distinctSessionsObserved} buổi tập riêng biệt`}
                                        </p>
                                        {issue.displayCue && (
                                            <div className={glass.cueCallout}>{issue.displayCue}</div>
                                        )}
                                        {issue.practiceAgainRoute && (
                                            <div className="flex justify-end">
                                                <button
                                                    type="button"
                                                    onClick={() => router.push(issue.practiceAgainRoute!)}
                                                    className={glass.actionBtnGhost}
                                                >
                                                    <span>{issue.practiceAgainLabel || "Luyện tập lại"}</span>
                                                    <ChevronRight />
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className={glass.stateCard}>
                            <p className={glass.stateDesc}>
                                {hasHistory
                                    ? "Chưa phát hiện điểm phát âm lặp lại qua nhiều buổi tập."
                                    : "Hãy hoàn thành thêm các buổi tập để hệ thống tổng hợp mục tiêu cần rèn luyện."}
                            </p>
                        </div>
                    )}
                </div>

                <div className={glass.glassCard} data-tone="emerald">
                    <div className={glass.sectionHeader}>
                        <div className={glass.sectionTitleRow}>
                            <span className={glass.sectionIconBadge} data-tone="emerald" aria-hidden="true">
                                <Award />
                            </span>
                            <h4>Tiến bộ ghi nhận trong buổi tập</h4>
                        </div>
                    </div>

                    {recentImprovements && recentImprovements.length > 0 ? (
                        <div className={glass.strengthList}>
                            {recentImprovements.map((imp, idx) => (
                                <div key={idx} className={glass.strengthRow}>
                                    <div className={glass.strengthTop}>
                                        <div className="flex items-start gap-2">
                                            <CheckCircle2 />
                                            <div>
                                                <div className="font-extrabold text-sm">
                                                    {imp.targetWord
                                                        ? `Từ "${imp.targetWord}"`
                                                        : getLearnerIssueLabel(imp.issueType)}
                                                </div>
                                                <p className={glass.issueMeta}>
                                                    {imp.materialTitle} · Sửa đúng sau {imp.retryCount} lần thử
                                                </p>
                                            </div>
                                        </div>
                                        <span className={glass.statusBadge} data-status="RECENTLY_STABLE">
                                            Đã giải quyết
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className={glass.stateCard}>
                            <p className={glass.stateDesc}>
                                Chưa có mục tiêu sửa phát âm thành công gần đây. Hãy sử dụng Retry khi có gợi ý!
                            </p>
                        </div>
                    )}
                </div>
            </div>

            {/* 4. Session History List */}
            <div className={glass.glassCard} data-tone="cyan">
                <div className={glass.sectionHeader}>
                    <div className={glass.sectionTitleRow}>
                        <span className={glass.sectionIconBadge} data-tone="cyan" aria-hidden="true">
                            <Clock />
                        </span>
                        <h4>Lịch sử buổi tập</h4>
                    </div>
                    {historySessions == null && (
                        <button
                            type="button"
                            onClick={() => void fetchHistory(0)}
                            className={glass.actionBtnGhost}
                        >
                            <span>Tải toàn bộ lịch sử</span>
                            <ChevronRight />
                        </button>
                    )}
                </div>

                {loadingHistory ? (
                    <div className={glass.skeletonBlock} style={{ height: "6rem" }} />
                ) : displayedSessions.length > 0 ? (
                    <div className={glass.sessionList}>
                        {displayedSessions.map((sess) => (
                            <div key={sess.sessionId} className={glass.sessionRow}>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className={glass.sessionTitle}>{sess.materialTitle}</span>
                                        <span
                                            className={glass.statusBadge}
                                            data-status={
                                                sess.status === "COMPLETED" ? "RECENTLY_STABLE" : "PRACTICING"
                                            }
                                        >
                                            {sess.status === "COMPLETED" ? "Hoàn thành" : "Đang thực hiện"}
                                        </span>
                                    </div>
                                    <div className={glass.sessionMetaRow}>
                                        <span>
                                            Đã luyện {sess.sentencesPracticed}/{sess.totalSentences} câu
                                        </span>
                                        <span>·</span>
                                        <span>{sess.attemptCount} lần thu</span>
                                    </div>
                                </div>

                                <div className={glass.sessionActions}>
                                    <button
                                        type="button"
                                        onClick={() => void openSessionDetail(sess.sessionId)}
                                        className={glass.actionBtnGhost}
                                    >
                                        <Eye />
                                        <span>Chi tiết</span>
                                    </button>
                                </div>
                            </div>
                        ))}

                        {historySessions != null && totalPages > 1 && (
                            <div className={glass.pagerBar}>
                                <span className={`${glass.pagerInfo} ${glass.mono}`}>
                                    Trang {historyPage + 1} / {totalPages}
                                </span>
                                <div className={glass.pagerControls}>
                                    <button
                                        type="button"
                                        disabled={historyPage <= 0}
                                        onClick={() => void fetchHistory(historyPage - 1)}
                                        className={glass.actionBtnGhost}
                                    >
                                        Trang trước
                                    </button>
                                    <button
                                        type="button"
                                        disabled={historyPage + 1 >= totalPages}
                                        onClick={() => void fetchHistory(historyPage + 1)}
                                        className={glass.actionBtnGhost}
                                    >
                                        Trang sau
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className={glass.stateCard}>
                        <span className={glass.stateIcon} aria-hidden="true">
                            <Mic />
                        </span>
                        <p className={glass.stateDesc}>Chưa có buổi tập nào được hoàn thành.</p>
                    </div>
                )}
            </div>

            <ProfileSessionDetailDrawer
                sessionId={selectedSessionId}
                detail={sessionDetail}
                isLoading={loadingDetail}
                error={detailError}
                onRetry={() => {
                    if (selectedSessionId != null) void openSessionDetail(selectedSessionId);
                }}
                onClose={() => {
                    setSelectedSessionId(null);
                    setSessionDetail(null);
                }}
            />
        </div>
    );
}
