"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { Play, ArrowRight, Headphones, MessageSquare } from "lucide-react";
import { ShadowingSessionState } from "@/services/speakingApi";
import { useLanguage } from "@/context/LanguageContext";
import { StudioThumb } from "./studio/SpeakingArt";
import styles from "./studio/speakingStudio.module.css";

export interface ContinuePracticeCardProps {
    activeSession?: ShadowingSessionState | null;
    title?: string;
    /** The session material's own poster (its thumbnail or YouTube frame), when the hub knows it. */
    thumbnail?: string | null;
    fallbackThumbnail?: string | null;
    onSelectMode?: (mode: "shadowing" | "roleplay" | "assessment") => void;
    handoffQueryString?: string;
}

export function ContinuePracticeCard({
    activeSession,
    title,
    thumbnail = null,
    fallbackThumbnail = null,
    onSelectMode,
    handoffQueryString = "",
}: ContinuePracticeCardProps) {
    const router = useRouter();
    const { locale } = useLanguage();
    const vi = locale === "vi";
    const hasActiveSession = Boolean(activeSession && activeSession.status === "ACTIVE");
    const done = activeSession?.completedUnitsCount ?? 0;
    const total = activeSession?.totalUnitsCount ?? 0;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

    return (
        <section aria-labelledby="continue-practice-heading" className="flex flex-col gap-2.5 min-w-0">
            <h2 id="continue-practice-heading" className={`ec-wp-plate ${styles.sectionLabel}`}>
                <Play className="fill-current" />
                {vi ? "Tiếp tục luyện" : "Continue practising"}
            </h2>

            {hasActiveSession && activeSession ? (
                <div className={`${styles.panel} ${styles.continue}`} data-tone="voice">
                    <div className={styles.continueThumb} aria-hidden="true">
                        <div className={styles.thumbFallback}>
                            <b>Shadowing</b>
                        </div>
                        <StudioThumb src={thumbnail} fallbackSrc={fallbackThumbnail} />
                    </div>
                    <div className={styles.continueBody}>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className={styles.chip}>
                                <Headphones size={11} />
                                Shadowing
                            </span>
                            <span className={styles.liveTag}>{vi ? "Đang thực hiện" : "In progress"}</span>
                        </div>
                        <h3 className={styles.continueTitle} title={title}>
                            {title || (vi ? "Bài luyện Shadowing đang tiến hành" : "Shadowing lesson in progress")}
                        </h3>
                        <p className={styles.continueMeta}>
                            {vi ? "Đã hoàn thành " : "Completed "}
                            <strong>{done}</strong> / <strong>{total}</strong>
                            {vi ? " câu trong bài tập này." : " sentences in this lesson."}
                        </p>
                        {total > 0 && (
                            <div
                                className={styles.progressTrack}
                                role="progressbar"
                                aria-valuemin={0}
                                aria-valuemax={total}
                                aria-valuenow={done}
                                aria-label={vi ? "Tiến độ bài Shadowing" : "Shadowing progress"}
                            >
                                <span style={{ width: `${pct}%` }} />
                            </div>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            const targetId = activeSession.sourceId;
                            if (targetId) {
                                router.push(`/speaking/shadowing/${targetId}${handoffQueryString}`);
                            } else if (onSelectMode) {
                                onSelectMode("shadowing");
                            }
                        }}
                        className={`${styles.primary} self-start sm:self-center`}
                    >
                        <span>{vi ? "Tiếp tục ngay" : "Continue now"}</span>
                        <ArrowRight />
                    </button>
                </div>
            ) : (
                <div className={`${styles.panel} ${styles.continue}`} data-tone="voice">
                    <div className={`${styles.continueThumb} hidden sm:block`} aria-hidden="true">
                        <div className={styles.thumbFallback}>
                            <b>Echo</b>
                            <span>{vi ? "Hôm nay" : "Today"}</span>
                        </div>
                    </div>
                    <div className={styles.continueBody}>
                        <h3 className={styles.continueTitle}>{vi ? "Bắt đầu buổi luyện hôm nay" : "Start today's practice"}</h3>
                        <p className={styles.continueMeta}>
                            {vi
                                ? "Chưa có bài Shadowing nào đang dở. Chọn một bài nghe Shadowing hoặc thử sức với kịch bản hội thoại AI Role-play."
                                : "No Shadowing lesson in progress. Pick a Shadowing passage or try an AI role-play scenario."}
                        </p>
                    </div>
                    {onSelectMode && (
                        <div className={styles.startRow}>
                            <button type="button" onClick={() => onSelectMode("shadowing")} className={styles.soft}>
                                <Headphones />
                                <span>{vi ? "Luyện Shadowing" : "Shadowing"}</span>
                            </button>
                            <button type="button" onClick={() => onSelectMode("roleplay")} className={styles.soft}>
                                <MessageSquare />
                                <span>{vi ? "Hội thoại AI" : "AI conversation"}</span>
                            </button>
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}
