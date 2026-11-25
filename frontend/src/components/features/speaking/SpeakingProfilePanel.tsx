"use client";

import React, { useEffect, useState } from "react";
import { useLanguage } from "@/context/LanguageContext";
import {
    Activity,
    Clock,
    LayoutDashboard,
    Mic,
} from "lucide-react";
import type {
    SpeakingProgress,
    SpeakingProgressSummary,
    SpeakingTurn,
} from "@/services/speakingApi";
import {
    useSpeakingProfileHistory,
    useSpeakingProfileOverview,
    useSpeakingProfilePronunciation,
    useSpeakingSessionDetail,
    type SpeakingHistoryModeFilter,
    type SpeakingHistoryStatusFilter,
    type SpeakingProfileSubTab,
} from "@/services/speakingProfileApi";
import { ProfileOverviewSection } from "./profile/ProfileOverviewSection";
import { ProfilePronunciationSection } from "./profile/ProfilePronunciationSection";
import { ProfileHistorySection } from "./profile/ProfileHistorySection";
import { ProfileSessionDetailDrawer } from "./profile/ProfileSessionDetailDrawer";
import styles from "./studio/speakingStudio.module.css";
import glass from "./profile/speakingProfileGlass.module.css";

export type ProfileTabType = SpeakingProfileSubTab;

/**
 * Canonical status badge descriptor for recurring pronunciation/speaking observations.
 * Preserves all 5 honest evidence states (`IMPROVING`, `PRACTICING`, `RECENTLY_STABLE`, `NEEDS_ATTENTION`, `INSUFFICIENT_DATA`).
 */
export function getRecurringIssueStatusBadge(status?: string | null): { label: string; statusKey: string } {
    switch (status) {
        case "IMPROVING":
            return { label: "Đang tiến bộ", statusKey: "IMPROVING" };
        case "PRACTICING":
            return { label: "Đang luyện tập", statusKey: "PRACTICING" };
        case "RECENTLY_STABLE":
            return { label: "Đã ổn định", statusKey: "RECENTLY_STABLE" };
        case "INSUFFICIENT_DATA":
            return { label: "Chưa đủ dữ liệu", statusKey: "INSUFFICIENT_DATA" };
        case "NEEDS_ATTENTION":
        default:
            return { label: "Cần chú ý", statusKey: "NEEDS_ATTENTION" };
    }
}

/**
 * Extracts persisted V2.2 acoustic sub-scores from stored attempt JSON without triggering AI re-inference.
 */
export function extractPersistedAttemptV2Summary(parsedV2: Record<string, any> | null | undefined) {
    const phonemeScore = parsedV2?.overall?.segmentalScore ?? parsedV2?.overall?.phonemeScore ?? null;
    const intonationScore = parsedV2?.overall?.intonationScore ?? parsedV2?.overall?.pitchScore ?? null;
    const instruction = parsedV2?.priorities?.[0]?.instructionVi ?? null;
    return { phonemeScore, intonationScore, instruction };
}

/**
 * Checks whether a persisted Role-play learner turn carries playable audio or V2.2 prosody metrics.
 */
export function hasPersistedTurnDiagnostics(turn: Pick<SpeakingTurn, "audioRef" | "intonationScore">) {
    return Boolean(turn.audioRef) || turn.intonationScore != null;
}

export interface SpeakingProfilePanelProps {
    isOpen?: boolean;
    onClose?: () => void;
    activeTab: ProfileTabType;
    onTabChange: (tab: ProfileTabType) => void;
    onJumpToPractice?: (mode?: "shadowing" | "roleplay" | "assessment" | "topic") => void;
    progress?: SpeakingProgress | null;
    summary?: SpeakingProgressSummary | null;
    onReloadSummary?: () => void;
}

export function SpeakingProfilePanel({
    isOpen = true,
    activeTab,
    onTabChange,
    onJumpToPractice,
    progress = null,
    summary = null,
}: SpeakingProfilePanelProps) {
    const { locale } = useLanguage();
    const vi = locale === "vi";

    // Track visited sub-tabs within this mounted profile session so inactive tabs stay 100% lazy
    // until selected, and already-opened tabs do not re-fetch on switch.
    const [visitedTabs, setVisitedTabs] = useState<Record<ProfileTabType, boolean>>(() => ({
        overview: activeTab === "overview",
        pronunciation: activeTab === "pronunciation",
        history: activeTab === "history",
    }));

    useEffect(() => {
        if (!isOpen) return;
        setVisitedTabs((prev) => (prev[activeTab] ? prev : { ...prev, [activeTab]: true }));
    }, [activeTab, isOpen]);

    // History filter & pagination state (lazy until `history` sub-tab is opened)
    const [historyPage, setHistoryPage] = useState(0);
    const [historyMode, setHistoryMode] = useState<SpeakingHistoryModeFilter>("ALL");
    const [historyStatus, setHistoryStatus] = useState<SpeakingHistoryStatusFilter>("ALL");

    // Session detail drawer state (lazy until a specific session is clicked)
    const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);

    const overviewEnabled = isOpen && (activeTab === "overview" || visitedTabs.overview);
    const pronunciationEnabled = isOpen && (activeTab === "pronunciation" || visitedTabs.pronunciation);
    const historyEnabled = isOpen && (activeTab === "history" || visitedTabs.history);

    const overviewQuery = useSpeakingProfileOverview(overviewEnabled);
    const pronunciationQuery = useSpeakingProfilePronunciation(pronunciationEnabled);
    const historyQuery = useSpeakingProfileHistory(
        {
            page: historyPage,
            size: 10,
            mode: historyMode,
            status: historyStatus,
        },
        historyEnabled,
    );
    const detailQuery = useSpeakingSessionDetail(selectedSessionId, isOpen && selectedSessionId != null);

    if (!isOpen) return null;

    const tabs: Array<{
        id: ProfileTabType;
        labelVi: string;
        labelEn: string;
        icon: React.ComponentType<{ size?: number; className?: string }>;
    }> = [
        { id: "overview", labelVi: "Tổng quan", labelEn: "Overview", icon: LayoutDashboard },
        { id: "pronunciation", labelVi: "Phát âm", labelEn: "Pronunciation", icon: Mic },
        { id: "history", labelVi: "Lịch sử", labelEn: "History", icon: Clock },
    ];

    const subTabIndex = activeTab === "pronunciation" ? 1 : activeTab === "history" ? 2 : 0;

    const handleSubTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") {
            return;
        }
        e.preventDefault();
        const order: ProfileTabType[] = ["overview", "pronunciation", "history"];
        const cur = order.indexOf(activeTab);
        let next = cur;
        if (e.key === "ArrowRight") next = (cur + 1) % order.length;
        else if (e.key === "ArrowLeft") next = (cur - 1 + order.length) % order.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = order.length - 1;
        onTabChange(order[next]);
    };

    const handleJumpToPractice = (mode?: "shadowing" | "roleplay" | "assessment" | "topic") => {
        if (onJumpToPractice) {
            onJumpToPractice(mode);
        }
    };

    return (
        <section
            id="speaking-profile-panel"
            data-testid="speaking-profile-panel"
            className={`${styles.profile} ${glass.workspace}`}
            role="region"
            aria-label={vi ? "Hồ sơ luyện nói" : "Speaking Profile"}
        >
            <div className={glass.shell}>
                {/* ── Header + Spring-Gliding 3-Tab Segmented Pill ── */}
                <div className={glass.topBar}>
                    <div className={glass.brandCluster}>
                        <span className={glass.brandOrb} aria-hidden="true">
                            <Activity />
                        </span>
                        <div className="min-w-0">
                            <span className={glass.eyebrow}>
                                {vi ? "Echo Ocean · Phân tích rèn luyện" : "Echo Ocean · Speaking Analytics"}
                            </span>
                            <h2 className={glass.title}>
                                {vi ? "Hồ sơ luyện nói" : "Speaking Profile"}
                            </h2>
                            <p className={glass.subtitle}>
                                {vi
                                    ? "Tổng hợp tiến độ tích lũy, chỉ số âm học Pronunciation Engine V2.2 và nhật ký bản thu âm thực tế của riêng bạn."
                                    : "Your cumulative speaking consistency, V2.2 acoustic diagnostics, and recorded session history."}
                            </p>
                        </div>
                    </div>

                    <div
                        className={glass.subTabDock}
                        style={{ ["--sub-idx" as string]: subTabIndex }}
                        role="tablist"
                        aria-label={vi ? "Các mục trong hồ sơ luyện nói" : "Speaking profile sections"}
                        onKeyDown={handleSubTabKeyDown}
                    >
                        <span className={glass.subTabGlider} aria-hidden="true" />
                        {tabs.map((tab) => {
                            const isActive = activeTab === tab.id;
                            const Icon = tab.icon;
                            return (
                                <button
                                    key={tab.id}
                                    id={`speaking-profile-tab-${tab.id}`}
                                    type="button"
                                    role="tab"
                                    aria-selected={isActive}
                                    aria-controls={`speaking-profile-panel-${tab.id}`}
                                    data-testid={`speaking-profile-subtab-${tab.id}`}
                                    onClick={() => onTabChange(tab.id)}
                                    className={glass.subTabBtn}
                                >
                                    <Icon />
                                    <span>{vi ? tab.labelVi : tab.labelEn}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* ── Sub-Tab 1: TỔNG QUAN ── */}
                {activeTab === "overview" && (
                    <div
                        id="speaking-profile-panel-overview"
                        role="tabpanel"
                        aria-labelledby="speaking-profile-tab-overview"
                    >
                        <ProfileOverviewSection
                            overview={overviewQuery.data ?? null}
                            isLoading={overviewQuery.isLoading}
                            error={overviewQuery.error}
                            onRetry={() => void overviewQuery.mutate()}
                            onSelectSubTab={onTabChange}
                            onJumpToPractice={handleJumpToPractice}
                            onOpenSessionDetail={(id) => setSelectedSessionId(id)}
                            legacyProgress={progress}
                            legacySummary={summary}
                            vi={vi}
                        />
                    </div>
                )}

                {/* ── Sub-Tab 2: PHÁT ÂM ── */}
                {activeTab === "pronunciation" && (
                    <div
                        id="speaking-profile-panel-pronunciation"
                        role="tabpanel"
                        aria-labelledby="speaking-profile-tab-pronunciation"
                    >
                        <ProfilePronunciationSection
                            pronunciation={pronunciationQuery.data ?? null}
                            isLoading={pronunciationQuery.isLoading}
                            error={pronunciationQuery.error}
                            onRetry={() => void pronunciationQuery.mutate()}
                            onJumpToPractice={handleJumpToPractice}
                            legacyProgress={progress}
                            legacySummary={summary}
                            vi={vi}
                        />
                    </div>
                )}

                {/* ── Sub-Tab 3: LỊCH SỬ ── */}
                {activeTab === "history" && (
                    <div
                        id="speaking-profile-panel-history"
                        role="tabpanel"
                        aria-labelledby="speaking-profile-tab-history"
                    >
                        <ProfileHistorySection
                            historyPage={historyQuery.data ?? null}
                            isLoading={historyQuery.isLoading}
                            error={historyQuery.error}
                            modeFilter={historyMode}
                            statusFilter={historyStatus}
                            onModeFilterChange={(nextMode) => {
                                setHistoryMode(nextMode);
                                setHistoryPage(0);
                            }}
                            onStatusFilterChange={(nextStatus) => {
                                setHistoryStatus(nextStatus);
                                setHistoryPage(0);
                            }}
                            onPageChange={(nextPage) => setHistoryPage(Math.max(0, nextPage))}
                            onRetry={() => void historyQuery.mutate()}
                            selectedSessionId={selectedSessionId}
                            onOpenSessionDetail={(id) => setSelectedSessionId(id)}
                            onJumpToPractice={handleJumpToPractice}
                            legacyRecentSessions={summary?.recentSessions ?? null}
                            vi={vi}
                        />
                    </div>
                )}
            </div>

            {/* ── Rich Liquid Glass Session Detail Drawer ── */}
            <ProfileSessionDetailDrawer
                sessionId={selectedSessionId}
                detail={detailQuery.data ?? null}
                isLoading={detailQuery.isLoading}
                error={detailQuery.error}
                onRetry={() => void detailQuery.mutate()}
                onClose={() => setSelectedSessionId(null)}
                vi={vi}
            />
        </section>
    );
}
