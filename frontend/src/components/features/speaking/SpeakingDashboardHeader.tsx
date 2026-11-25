"use client";

import React from "react";
import { AudioLines, Flame, Target, Link2, X } from "lucide-react";
import { SpeakingContext } from "@/services/speakingApi";
import { useLanguage } from "@/context/LanguageContext";
import { HeroVoiceArt, usePauseOffscreen } from "./studio/SpeakingArt";
import styles from "./studio/speakingStudio.module.css";

export interface SpeakingDashboardHeaderProps {
    speakingContext: SpeakingContext | null;
    streakDays?: number;
    activeTargetsCount?: number;
    onClearContext?: () => void;
}

/**
 * Luyện nói hero ("Echo Glass · Living Voice"): the module's name, its tagline and the two server numbers the hub already
 * read (Speaking streak, active practice targets). A number still loading reads "—", never an invented 0.
 */
export function SpeakingDashboardHeader({
    speakingContext,
    streakDays,
    activeTargetsCount,
    onClearContext,
}: SpeakingDashboardHeaderProps) {
    const { locale, t } = useLanguage();
    const vi = locale === "vi";
    const heroRef = usePauseOffscreen<HTMLElement>();

    return (
        <div className={styles.heroZone}>
            {/* ── Inherited Lesson Context Banner (Handoff) ── */}
            {speakingContext && (
                <div className={`${styles.panel} ${styles.context}`} role="region" aria-label={t.inheritedContext}>
                    <div className="space-y-3 flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className={styles.contextTag}>
                                <Link2 size={12} />
                                {vi ? "Ngữ cảnh:" : "Context:"} {speakingContext.sourceType}
                            </span>
                            {speakingContext.cefrLevel && (
                                <span className={styles.chip} data-tone="talk">{speakingContext.cefrLevel}</span>
                            )}
                            <span className="text-sm font-bold">{speakingContext.sourceTitle}</span>
                        </div>

                        {/* Target Vocabulary Chips */}
                        {speakingContext.targetVocabulary && speakingContext.targetVocabulary.length > 0 && (
                            <div>
                                <div className={`${styles.sectionLabel} mb-2`}>
                                    <Target size={12} />
                                    {t.targetVocab}
                                </div>
                                <div className="flex flex-wrap gap-1.5" role="list" aria-label={t.targetVocab}>
                                    {speakingContext.targetVocabulary.map((word, idx) => (
                                        <span key={idx} className={styles.vocabChip} role="listitem">
                                            {word}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Clear Context Action */}
                    {onClearContext && (
                        <button
                            type="button"
                            onClick={onClearContext}
                            className={`${styles.ghostBtn} self-start shrink-0`}
                            title={t.clearContextAction}
                            aria-label={t.clearContextAction}
                        >
                            <X size={15} />
                            <span>{t.clearContextAction}</span>
                        </button>
                    )}
                </div>
            )}

            {/* ── Hero ── */}
            <header ref={heroRef} className={`${styles.hero} ${styles.pauseScope}`}>
                <HeroVoiceArt />
                <div className={styles.heroCopy}>
                    <div className={styles.heroTitleRow}>
                        <span className={styles.heroEmblem} aria-hidden="true">
                            <AudioLines />
                        </span>
                        <div className="min-w-0">
                            <h1 className={styles.heroTitle}>{t.speakingPractice}</h1>
                            <p className={styles.heroLead}>{t.speakingTagline}</p>
                        </div>
                    </div>
                    <p className={styles.heroText}>
                        {vi
                            ? "Chọn một cách luyện bên dưới: nói nhại theo bài nghe thật, hội thoại theo tình huống, kiểm tra nhanh một câu hoặc rút chủ đề để nói."
                            : "Pick a way to practise below: shadow real recordings, talk through a scenario, check one sentence or draw a topic to speak about."}
                    </p>
                    <div className={styles.heroStats}>
                        <div className={styles.stat} data-tone="mic">
                            <span className={styles.statIcon} aria-hidden="true"><Flame /></span>
                            <div>
                                <div className={styles.statValue}>
                                    {streakDays !== undefined ? (vi ? `${streakDays} ngày` : `${streakDays} ${streakDays === 1 ? "day" : "days"}`) : "—"}
                                </div>
                                <div className={styles.statLabel}>{vi ? "Chuỗi ngày luyện nói" : "Speaking streak"}</div>
                            </div>
                        </div>
                        <div className={styles.stat} data-tone="talk">
                            <span className={styles.statIcon} aria-hidden="true"><Target /></span>
                            <div>
                                <div className={styles.statValue}>
                                    {activeTargetsCount !== undefined ? (vi ? `${activeTargetsCount} mục tiêu` : `${activeTargetsCount} targets`) : "—"}
                                </div>
                                <div className={styles.statLabel}>{vi ? "Mục tiêu rèn luyện" : "Active targets"}</div>
                            </div>
                        </div>
                    </div>
                </div>
            </header>
        </div>
    );
}
