"use client";

import React, { useRef } from "react";
import { useRouter } from "next/navigation";
import {
    AlertCircle,
    ArrowRight,
    ChevronLeft,
    ChevronRight,
    Clock,
    Eye,
    Headphones,
    MessageSquare,
    Mic,
    RefreshCw,
} from "lucide-react";
import type { SpeakingSessionSummary } from "@/services/speakingApi";
import type {
    SpeakingHistoryModeFilter,
    SpeakingHistoryStatusFilter,
    SpeakingProfileHistoryPage,
    SpeakingProfileSessionSummary,
} from "@/services/speakingProfileApi";
import { buildPaginationTokens, formatSpeakingDuration } from "./profileViewModel";
import glass from "./speakingProfileGlass.module.css";

export interface ProfileHistorySectionProps {
    historyPage: SpeakingProfileHistoryPage | null;
    isLoading: boolean;
    error: unknown;
    modeFilter: SpeakingHistoryModeFilter;
    statusFilter: SpeakingHistoryStatusFilter;
    onModeFilterChange: (mode: SpeakingHistoryModeFilter) => void;
    onStatusFilterChange: (status: SpeakingHistoryStatusFilter) => void;
    onPageChange: (pageZeroBased: number) => void;
    onRetry: () => void;
    selectedSessionId: number | null;
    onOpenSessionDetail: (sessionId: number) => void;
    onJumpToPractice: (mode?: "shadowing" | "roleplay" | "assessment" | "topic") => void;
    legacyRecentSessions?: SpeakingSessionSummary[] | null;
    vi?: boolean;
}

export function ProfileHistorySection({
    historyPage,
    isLoading,
    error,
    modeFilter,
    statusFilter,
    onModeFilterChange,
    onStatusFilterChange,
    onPageChange,
    onRetry,
    selectedSessionId,
    onOpenSessionDetail,
    onJumpToPractice,
    legacyRecentSessions,
    vi = true,
}: ProfileHistorySectionProps) {
    const router = useRouter();
    const headingRef = useRef<HTMLDivElement>(null);

    const handleSelectPage = (nextPage: number) => {
        onPageChange(nextPage);
        requestAnimationFrame(() => {
            const el = headingRef.current;
            if (!el) return;
            const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
            el.scrollIntoView({
                behavior: reduceMotion ? "auto" : "smooth",
                block: "start",
                inline: "nearest",
            });
        });
    };

    const counts = historyPage?.counts;
    const modePills: Array<{
        key: SpeakingHistoryModeFilter;
        labelVi: string;
        labelEn: string;
        count?: number;
    }> = [
        { key: "ALL", labelVi: "Tất cả", labelEn: "All", count: counts?.all },
        { key: "SHADOWING", labelVi: "Shadowing", labelEn: "Shadowing", count: counts?.shadowing },
        { key: "ROLEPLAY", labelVi: "Role-play AI", labelEn: "Role-play AI", count: counts?.roleplay },
        { key: "QUICK_CHECK", labelVi: "Quick Check", labelEn: "Quick Check", count: counts?.quickCheck },
    ];

    const statusPills: Array<{
        key: SpeakingHistoryStatusFilter;
        labelVi: string;
        labelEn: string;
        count?: number;
    }> = [
        { key: "ALL", labelVi: "Mọi trạng thái", labelEn: "All statuses", count: counts?.all },
        { key: "COMPLETED", labelVi: "Hoàn thành", labelEn: "Completed", count: counts?.completed },
        { key: "ACTIVE", labelVi: "Đang thực hiện", labelEn: "In progress", count: counts?.active },
    ];

    const sessions: SpeakingProfileSessionSummary[] =
        historyPage?.content ??
        (legacyRecentSessions ?? []).map((s) => ({
            ...s,
        }));

    const currentPage = historyPage?.page ?? 0;
    const totalPages = Math.max(1, historyPage?.totalPages ?? 1);
    const totalElements = historyPage?.totalElements ?? sessions.length;
    const pageTokens = buildPaginationTokens(currentPage, totalPages);

    return (
        <div className="space-y-4" data-testid="speaking-profile-history">
            <section className={glass.glassCard} data-tone="cyan" aria-labelledby="sp-history-heading">
                <div ref={headingRef} className={glass.sectionHeader} style={{ scrollMarginTop: "1rem" }}>
                    <div className={glass.sectionTitleRow}>
                        <span className={glass.sectionIconBadge} data-tone="cyan" aria-hidden="true">
                            <Clock />
                        </span>
                        <div>
                            <h3 id="sp-history-heading">
                                {vi ? "Nhật ký các phiên luyện nói" : "Speaking Session History"}
                            </h3>
                        </div>
                    </div>
                    <span className={`${glass.sectionSubnote} ${glass.mono}`}>
                        {historyPage || legacyRecentSessions
                            ? vi
                                ? `Tổng ${totalElements} buổi tập`
                                : `${totalElements} total sessions`
                            : "—"}
                    </span>
                </div>

                {/* Mode & Status Filter Toolbar */}
                <div className={`${glass.filterBar} mb-4`}>
                    <div className={glass.pillGroup} role="group" aria-label={vi ? "Lọc theo chế độ luyện nói" : "Filter by speaking mode"}>
                        <span className={glass.filterGroupLabel}>{vi ? "Chế độ:" : "Mode:"}</span>
                        {modePills.map((p) => (
                            <button
                                key={p.key}
                                type="button"
                                aria-pressed={modeFilter === p.key}
                                onClick={() => onModeFilterChange(p.key)}
                                data-testid={`history-mode-${p.key.toLowerCase()}`}
                                className={glass.filterPill}
                            >
                                <span>{vi ? p.labelVi : p.labelEn}</span>
                                {p.count != null && (
                                    <span className={`${glass.filterPillCount} ${glass.mono}`}>({p.count})</span>
                                )}
                            </button>
                        ))}
                    </div>

                    <div className={glass.pillGroup} role="group" aria-label={vi ? "Lọc theo trạng thái hoàn thành" : "Filter by completion status"}>
                        <span className={glass.filterGroupLabel}>{vi ? "Trạng thái:" : "Status:"}</span>
                        {statusPills.map((p) => (
                            <button
                                key={p.key}
                                type="button"
                                aria-pressed={statusFilter === p.key}
                                onClick={() => onStatusFilterChange(p.key)}
                                data-testid={`history-status-${p.key.toLowerCase()}`}
                                className={glass.filterPill}
                            >
                                <span>{vi ? p.labelVi : p.labelEn}</span>
                                {p.count != null && (
                                    <span className={`${glass.filterPillCount} ${glass.mono}`}>({p.count})</span>
                                )}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Loading / Error / Empty / Paginated List */}
                {isLoading && !historyPage && !legacyRecentSessions ? (
                    <div className="space-y-3" role="status">
                        <div className={glass.skeletonBlock} style={{ height: "5.2rem" }} />
                        <div className={glass.skeletonBlock} style={{ height: "5.2rem" }} />
                        <div className={glass.skeletonBlock} style={{ height: "5.2rem" }} />
                    </div>
                ) : error && !historyPage ? (
                    <div className={glass.stateCard} role="alert">
                        <span className={glass.stateIcon} data-tone="rose" aria-hidden="true">
                            <AlertCircle />
                        </span>
                        <h4 className={glass.stateTitle}>
                            {vi ? "Chưa thể tải lịch sử luyện nói" : "Could not load speaking history"}
                        </h4>
                        <p className={glass.stateDesc}>
                            {vi
                                ? "Vui lòng kiểm tra kết nối và thử lại."
                                : "Please check your connection and try again."}
                        </p>
                        <button type="button" onClick={onRetry} className={glass.actionBtnPrimary}>
                            <RefreshCw />
                            <span>{vi ? "Thử tải lại" : "Retry"}</span>
                        </button>
                    </div>
                ) : sessions.length > 0 ? (
                    <>
                        <div className={glass.sessionList}>
                            {sessions.map((sess) => {
                                const upperMode = (sess.mode || "SHADOWING").toUpperCase();
                                const isCompleted = sess.status === "COMPLETED";
                                const isActive = sess.status === "ACTIVE";
                                const ModeIcon =
                                    upperMode === "ROLEPLAY"
                                        ? MessageSquare
                                        : upperMode === "QUICK_CHECK"
                                        ? Mic
                                        : Headphones;
                                const createdDate = sess.createdAt ? new Date(sess.createdAt) : null;
                                const validDate =
                                    createdDate && !Number.isNaN(createdDate.getTime()) ? createdDate : null;

                                return (
                                    <article
                                        key={sess.sessionId}
                                        data-selected={selectedSessionId === sess.sessionId ? "true" : undefined}
                                        data-testid="speaking-history-row"
                                        className={glass.sessionRow}
                                    >
                                        <div className={glass.sessionLeft}>
                                            <span
                                                className={glass.modeEmblem}
                                                data-mode={upperMode}
                                                aria-hidden="true"
                                            >
                                                <ModeIcon />
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <h4 className={`${glass.sessionTitle} truncate`}>
                                                        {sess.materialTitle ||
                                                            (upperMode === "ROLEPLAY"
                                                                ? "Tình huống hội thoại AI"
                                                                : upperMode === "QUICK_CHECK"
                                                                ? "Quick Check"
                                                                : "Bài luyện Shadowing")}
                                                    </h4>
                                                    <span
                                                        className={glass.statusBadge}
                                                        data-status={isCompleted ? "RECENTLY_STABLE" : "PRACTICING"}
                                                    >
                                                        {isCompleted
                                                            ? vi
                                                                ? "Hoàn thành"
                                                                : "Completed"
                                                            : vi
                                                            ? "Đang thực hiện"
                                                            : "In progress"}
                                                    </span>
                                                    {sess.cefrLevel && (
                                                        <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                                            {sess.cefrLevel}
                                                        </span>
                                                    )}
                                                </div>

                                                <div className={glass.sessionMetaRow}>
                                                    {validDate && (
                                                        <span className={glass.mono}>
                                                            {validDate.toLocaleDateString(vi ? "vi-VN" : "en-US", {
                                                                day: "2-digit",
                                                                month: "2-digit",
                                                                year: "numeric",
                                                            })}
                                                        </span>
                                                    )}
                                                    <span>·</span>
                                                    <span>
                                                        {upperMode === "QUICK_CHECK"
                                                            ? vi
                                                                ? "Quick Check · 1 câu tự do"
                                                                : "Quick Check · 1 utterance"
                                                            : upperMode === "ROLEPLAY"
                                                            ? vi
                                                                ? `${sess.attemptCount} lượt thoại`
                                                                : `${sess.attemptCount} turns`
                                                            : vi
                                                            ? `Đã luyện ${sess.sentencesPracticed}/${sess.totalSentences} câu`
                                                            : `${sess.sentencesPracticed}/${sess.totalSentences} sentences`}
                                                    </span>
                                                    <span>·</span>
                                                    <span>
                                                        {vi ? `${sess.attemptCount} lần thu` : `${sess.attemptCount} takes`}
                                                    </span>
                                                    {sess.durationSeconds != null && sess.durationSeconds > 0 && (
                                                        <>
                                                            <span>·</span>
                                                            <span>{formatSpeakingDuration(sess.durationSeconds, vi)}</span>
                                                        </>
                                                    )}
                                                    {sess.averagePronunciationScore != null && (
                                                        <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                                            V2.2: {Math.round(sess.averagePronunciationScore)}/100
                                                        </span>
                                                    )}
                                                    {sess.resolvedTargetCount > 0 && (
                                                        <span className={glass.statusBadge} data-status="RECENTLY_STABLE">
                                                            {vi
                                                                ? `Sửa đúng: ${sess.resolvedTargetCount}`
                                                                : `Resolved: ${sess.resolvedTargetCount}`}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        <div className={glass.sessionActions}>
                                            <button
                                                type="button"
                                                onClick={() => onOpenSessionDetail(sess.sessionId)}
                                                className={glass.actionBtnGhost}
                                                data-testid={`history-detail-btn-${sess.sessionId}`}
                                            >
                                                <Eye />
                                                <span>{vi ? "Xem chi tiết" : "Details"}</span>
                                            </button>
                                            {isActive && sess.materialId && upperMode !== "QUICK_CHECK" && (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        router.push(
                                                            upperMode === "ROLEPLAY"
                                                                ? `/speaking/roleplay/${sess.materialId}`
                                                                : `/speaking/shadowing/${sess.materialId}`,
                                                        )
                                                    }
                                                    className={glass.actionBtnPrimary}
                                                >
                                                    <span>{vi ? "Tiếp tục" : "Continue"}</span>
                                                    <ArrowRight />
                                                </button>
                                            )}
                                        </div>
                                    </article>
                                );
                            })}
                        </div>

                        {/* Native Pagination Controls */}
                        {totalPages > 1 && (
                            <nav
                                className={glass.pagerBar}
                                aria-label={vi ? "Phân trang lịch sử luyện nói" : "Speaking history pagination"}
                            >
                                <span className={`${glass.pagerInfo} ${glass.mono}`}>
                                    {vi
                                        ? `Trang ${currentPage + 1} / ${totalPages} · ${totalElements} buổi tập`
                                        : `Page ${currentPage + 1} of ${totalPages} · ${totalElements} sessions`}
                                </span>

                                <div className={glass.pagerControls}>
                                    <button
                                        type="button"
                                        disabled={currentPage <= 0 || isLoading}
                                        onClick={() => handleSelectPage(currentPage - 1)}
                                        className={glass.actionBtnGhost}
                                        aria-label={vi ? "Trang trước" : "Previous page"}
                                    >
                                        <ChevronLeft />
                                        <span>{vi ? "Trước" : "Prev"}</span>
                                    </button>

                                    {pageTokens.map((tok, i) =>
                                        tok < 0 ? (
                                            <span key={`gap-${i}`} className="px-1.5 text-xs opacity-60" aria-hidden="true">
                                                …
                                            </span>
                                        ) : (
                                            <button
                                                key={tok}
                                                type="button"
                                                disabled={isLoading}
                                                aria-current={tok === currentPage ? "page" : undefined}
                                                onClick={() => handleSelectPage(tok)}
                                                className={`${glass.pageNumBtn} ${glass.mono}`}
                                            >
                                                {tok + 1}
                                            </button>
                                        ),
                                    )}

                                    <button
                                        type="button"
                                        disabled={currentPage + 1 >= totalPages || isLoading}
                                        onClick={() => handleSelectPage(currentPage + 1)}
                                        className={glass.actionBtnGhost}
                                        aria-label={vi ? "Trang sau" : "Next page"}
                                    >
                                        <span>{vi ? "Sau" : "Next"}</span>
                                        <ChevronRight />
                                    </button>
                                </div>
                            </nav>
                        )}
                    </>
                ) : (
                    <div className={glass.stateCard}>
                        <span className={glass.stateIcon} aria-hidden="true">
                            <Clock />
                        </span>
                        <h4 className={glass.stateTitle}>
                            {modeFilter !== "ALL" || statusFilter !== "ALL"
                                ? vi
                                    ? "Không có buổi tập nào khớp với bộ lọc đã chọn"
                                    : "No sessions match the selected filters"
                                : vi
                                ? "Bạn chưa có lịch sử luyện nói nào"
                                : "No speaking sessions recorded yet"}
                        </h4>
                        <p className={glass.stateDesc}>
                            {modeFilter !== "ALL" || statusFilter !== "ALL"
                                ? vi
                                    ? "Thử đặt lại bộ lọc về Tất cả để xem toàn bộ lịch sử rèn luyện của bạn."
                                    : "Reset filters to All to view your complete speaking history."
                                : vi
                                ? "Mỗi buổi luyện Shadowing, hội thoại AI Role-play và Quick Check đều được lưu lại kèm bản thu âm và phân tích chi tiết tại đây."
                                : "Completed Shadowing lessons, AI Role-play conversations, and Quick Check recordings will appear here with audio playback."}
                        </p>
                        {modeFilter !== "ALL" || statusFilter !== "ALL" ? (
                            <button
                                type="button"
                                onClick={() => {
                                    onModeFilterChange("ALL");
                                    onStatusFilterChange("ALL");
                                }}
                                className={glass.actionBtnGhost}
                            >
                                <span>{vi ? "Đặt lại bộ lọc" : "Reset filters"}</span>
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={() => onJumpToPractice("shadowing")}
                                className={glass.actionBtnPrimary}
                            >
                                <span>{vi ? "Bắt đầu buổi luyện đầu tiên" : "Start practicing"}</span>
                                <ArrowRight />
                            </button>
                        )}
                    </div>
                )}
            </section>
        </div>
    );
}
