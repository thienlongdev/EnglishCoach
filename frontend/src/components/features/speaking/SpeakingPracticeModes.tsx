"use client";

import React from "react";
import { Headphones, MessageSquare, Mic, ArrowRight, Dices } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { PremiumFeatureBadge } from "@/components/premium/PremiumFeatureBadge";
import { pointerLight } from "@/lib/ui/pointerLight";
import { ModeSign } from "./studio/SpeakingArt";
import styles from "./studio/speakingStudio.module.css";
import { echoSrc } from '@/lib/brand/echoCharacters';

export type PracticeModeType = "shadowing" | "roleplay" | "assessment" | "topic";

export interface SpeakingPracticeModesProps {
    selectedMode: PracticeModeType;
    onSelectMode: (mode: PracticeModeType) => void;
    hasActiveLesson?: boolean;
}

/** Where each mode opens: Quick Check has its own studio panel, the others the practice workspace. */
export const PRACTICE_PANEL_ID: Record<PracticeModeType, string> = {
    shadowing: "speaking-workspace",
    roleplay: "speaking-workspace",
    assessment: "speaking-quick-check",
    topic: "speaking-workspace",
};

export function SpeakingPracticeModes({
    selectedMode,
    onSelectMode,
    hasActiveLesson = false,
}: SpeakingPracticeModesProps) {
    const { locale, t } = useLanguage();
    const vi = locale === "vi";

    const modes = [
        {
            id: "shadowing" as const,
            featureKey: "SPEAKING_SHADOWING",
            tone: "voice",
            title: t.shadowingModeTitle,
            description: t.shadowingModeDesc,
            badge: t.shadowingModeBadge,
            icon: Headphones,
            actionLabel: hasActiveLesson ? t.continueSpeaking : t.startSpeaking,
        },
        {
            id: "roleplay" as const,
            featureKey: "SPEAKING_ROLEPLAY",
            tone: "talk",
            title: t.roleplayModeTitle,
            description: t.roleplayModeDesc,
            badge: t.roleplayModeBadge,
            icon: MessageSquare,
            actionLabel: t.startSpeaking,
        },
        {
            id: "assessment" as const,
            featureKey: "SPEAKING_QUICK_CHECK",
            tone: "mic",
            title: t.quickPronunciationTitle,
            description: t.quickPronunciationDesc,
            badge: t.quickPronunciationBadge,
            icon: Mic,
            actionLabel: t.startSpeaking,
        },
        {
            id: "topic" as const,
            // no Premium feature key: topic speaking uses no AI and no quota
            featureKey: null,
            tone: "topic",
            title: t.topicSpeakingTitle,
            description: t.topicSpeakingDesc,
            badge: t.topicSpeakingBadge,
            icon: Dices,
            actionLabel: t.startSpeaking,
        },
    ];

    return (
        <section aria-labelledby="practice-modes-heading" className={styles.modes}>
            <div className={styles.sectionHead}>
                <h2 id="practice-modes-heading" className={`ec-wp-plate ${styles.sectionLabel}`}>
                    <img src={echoSrc('social', 24)} alt="" aria-hidden="true" />
                    {t.choosePracticeMode}
                </h2>
                <span className={`ec-wp-plate ${styles.sectionNote} hidden sm:inline`}>{t.practiceModesCount}</span>
            </div>

            {/* Four practice cards (modeGrid: 1 → 2 × 2 → one row, by the column width). Each card is ONE control. */}
            <div className={styles.modeGrid} role="tablist" aria-label={t.choosePracticeMode}>
                {modes.map((mode) => {
                    const isSelected = selectedMode === mode.id;
                    const Icon = mode.icon;

                    return (
                        <button
                            key={mode.id}
                            type="button"
                            role="tab"
                            aria-selected={isSelected}
                            aria-controls={PRACTICE_PANEL_ID[mode.id]}
                            data-tone={mode.tone}
                            data-testid={`speaking-mode-${mode.id}`}
                            onClick={() => onSelectMode(mode.id)}
                            className={styles.mode}
                            {...pointerLight}
                        >
                            <span className={styles.modeTop}>
                                <span className={styles.glyph} aria-hidden="true">
                                    <Icon />
                                </span>
                                <span className={styles.badge}>{mode.badge}</span>
                            </span>

                            <span className={styles.modeText}>
                                <span className={styles.modeTitle}>{mode.title}</span>
                                <span className={styles.modeDesc}>{mode.description}</span>
                                {mode.featureKey && (
                                    <span className="flex">
                                        <PremiumFeatureBadge featureKey={mode.featureKey} />
                                    </span>
                                )}
                            </span>

                            <span className={styles.modeFoot}>
                                <span className={styles.modeState}>
                                    {isSelected ? (vi ? "Đang mở" : "Open") : (vi ? "Nhấn để chọn" : "Select")}
                                </span>
                                <ModeSign kind={mode.id} />
                                <span className={styles.modeGo}>
                                    <span>{mode.actionLabel}</span>
                                    <ArrowRight />
                                </span>
                            </span>
                        </button>
                    );
                })}
            </div>
        </section>
    );
}
