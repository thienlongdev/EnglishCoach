"use client";

import React from "react";
import { Activity, CheckCircle2, ChevronRight, LayoutDashboard } from "lucide-react";
import { SpeakingProgress, SpeakingProgressSummary } from "@/services/speakingApi";
import {
    getLearnerCategoryLabel,
    getLearnerIssueLabel,
    resolveRecurringStatusMeta,
} from "./profile/profileViewModel";
import glass from "./profile/speakingProfileGlass.module.css";

export interface SpeakingProfilePreviewProps {
    progress: SpeakingProgress | null;
    summary?: SpeakingProgressSummary | null;
    onOpenProfile: (tab?: "overview" | "pronunciation" | "history") => void;
}

export function SpeakingProfilePreview({
    progress,
    summary,
    onOpenProfile,
}: SpeakingProfilePreviewProps) {
    const issues = progress?.weaknessProfile?.issues || summary?.recurringIssues || [];
    const topCategories = progress?.weaknessProfile?.topCorrectionCategories || [];

    return (
        <section aria-labelledby="speaking-profile-preview-heading" className={glass.workspace}>
            <div className={glass.glassCard} data-tone="indigo">
                <div className={glass.sectionHeader}>
                    <div className={glass.sectionTitleRow}>
                        <span className={glass.sectionIconBadge} aria-hidden="true">
                            <LayoutDashboard />
                        </span>
                        <div>
                            <h2 id="speaking-profile-preview-heading">Hồ sơ luyện nói</h2>
                            <p className={glass.sectionSubnote}>
                                Tổng hợp điểm mạnh và trọng tâm phát âm từ 30 ngày gần đây
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={() => onOpenProfile("history")}
                            className={glass.actionBtnGhost}
                        >
                            <span>Lịch sử</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => onOpenProfile("overview")}
                            className={glass.actionBtnPrimary}
                        >
                            <span>Xem hồ sơ chi tiết</span>
                            <ChevronRight />
                        </button>
                    </div>
                </div>

                {issues.length > 0 ? (
                    <div className={glass.issueGrid}>
                        {issues.slice(0, 3).map((issue, idx) => {
                            const statusMeta = resolveRecurringStatusMeta(issue.status);
                            return (
                                <div key={`${issue.issueKey || idx}`} className={glass.issueCard}>
                                    <div className="space-y-1.5">
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
                                                (issue.distinctSessionsObserved > 0
                                                    ? `Ghi nhận trong ${issue.distinctSessionsObserved} phiên luyện tập`
                                                    : issue.displayCue || "Mục tiêu cần củng cố")}
                                        </p>
                                    </div>

                                    {issue.recentExamples && issue.recentExamples.length > 0 && (
                                        <div className={glass.exampleChips}>
                                            <span className={glass.sectionSubnote}>Ví dụ:</span>
                                            <span className={glass.exampleChip}>
                                                {issue.recentExamples[0].targetWord ||
                                                    issue.recentExamples[0].originalPhrase ||
                                                    issue.recentExamples[0].sentenceSnippet}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : topCategories.length > 0 ? (
                    <div className={glass.subMetricGrid}>
                        {topCategories.map((cat, idx) => (
                            <div key={idx} className={glass.subMetricCard}>
                                <div className={glass.subMetricTop}>
                                    <span className={glass.subMetricName}>
                                        {getLearnerCategoryLabel(cat.category)}
                                    </span>
                                    <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                        {cat.count} góp ý
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className={glass.strengthRow}>
                        <div className={glass.strengthTop}>
                            <div className="flex items-start gap-2.5">
                                <CheckCircle2 />
                                <div>
                                    <div className="font-extrabold text-sm">
                                        Chưa ghi nhận điểm yếu lặp lại qua các buổi tập
                                    </div>
                                    <p className={glass.issueMeta}>
                                        Tiếp tục duy trì nhịp luyện nói đều đặn để tích lũy bằng chứng âm học V2.2.
                                    </p>
                                </div>
                            </div>
                            <Activity size={16} className="opacity-60 shrink-0" />
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
}
