"use client";

import { type ComponentType, type ReactNode } from "react";
import {
    Briefcase, BookOpen, Building2, Cpu, GraduationCap, HeartPulse, Home, Landmark, Leaf, Palette, Plane, Sprout, Users,
    BarChart3, PenLine, FileText, Layers,
} from "lucide-react";
import styles from "./writingGlass.module.css";

export { styles as glass };

export type WritingWorld = "translation" | "lab" | "typing" | "coach" | "portfolio";

/*
 * The five Writing heroes are rendered stills of scenes built in code (Blender, CPU; `docs/writing/echo-glass-2026-10-23/art/`):
 * two glass tiles joined by a bridge of light, a grammar prism, keys of light, a floating desk of paper and ink, an archive of
 * manuscripts. Content-hashed names (a changed picture ships under a new name: the edge caches images for a year).
 * Decorative: alt="" and aria-hidden.
 */
export const WRITING_ART: Record<WritingWorld, { small: string; large: string }> = {
    translation: { small: "/assets/writing/writing-translation-1280-5abcb428.webp", large: "/assets/writing/writing-translation-2560-bc2105aa.webp" },
    lab: { small: "/assets/writing/writing-lab-1280-76e02dfb.webp", large: "/assets/writing/writing-lab-2560-23e5d778.webp" },
    typing: { small: "/assets/writing/writing-typing-1280-31cc6272.webp", large: "/assets/writing/writing-typing-2560-6ba58318.webp" },
    coach: { small: "/assets/writing/writing-coach-1280-42963773.webp", large: "/assets/writing/writing-coach-2560-ecd9e126.webp" },
    portfolio: { small: "/assets/writing/writing-portfolio-1280-bbd83b5c.webp", large: "/assets/writing/writing-portfolio-2560-749314ad.webp" },
};

// Light drifting along the painted ribbons: deterministic (same on server and client), decorative only.
const CURRENTS: Record<WritingWorld, { y: string; c: string; d: string; delay: string }[]> = {
    translation: [{ y: "73%", c: "#67e8f9", d: "10s", delay: "0s" }, { y: "79%", c: "#c4b5fd", d: "12s", delay: "-5s" }, { y: "38%", c: "#fcd34d", d: "9s", delay: "-3s" }],
    lab: [{ y: "48%", c: "#f9a8d4", d: "9s", delay: "-2s" }, { y: "52%", c: "#93c5fd", d: "11s", delay: "-6s" }],
    typing: [{ y: "40%", c: "#67e8f9", d: "8s", delay: "0s" }, { y: "58%", c: "#a5b4fc", d: "11s", delay: "-4s" }],
    coach: [{ y: "76%", c: "#fcd34d", d: "11s", delay: "-1s" }, { y: "81%", c: "#c4b5fd", d: "13s", delay: "-6s" }],
    portfolio: [{ y: "84%", c: "#fcd34d", d: "12s", delay: "-2s" }, { y: "88%", c: "#c4b5fd", d: "10s", delay: "-7s" }],
};

/** The studio root: the Writing token world for every screen inside it (see writingGlass.module.css). */
export function WritingStudio({ world, children }: { world: WritingWorld; children: ReactNode }) {
    return <div className={styles.studio} data-world={world} data-testid="writing-studio">{children}</div>;
}

export interface HeroStat { value: ReactNode; label: string; icon: ReactNode }

export function WritingHero({ world, eyebrow, eyebrowIcon, title, accent, lead, stats = [], actions, side, titleId }: {
    world: WritingWorld;
    eyebrow: string;
    eyebrowIcon: ReactNode;
    title: string;
    accent?: string;
    lead: ReactNode;
    stats?: HeroStat[];
    actions?: ReactNode;
    side?: ReactNode;
    titleId: string;
}) {
    const art = WRITING_ART[world];
    return (
        <section className={styles.hero} data-world={world} aria-labelledby={titleId}>
            <div className={styles.heroArt} aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={art.small} srcSet={`${art.small} 1280w, ${art.large} 2560w`} sizes="(min-width: 768px) 62vw, 200vw" alt="" decoding="async" draggable={false} />
            </div>
            <div className={styles.heroShade} aria-hidden="true" />
            <div className={styles.heroCurrent} aria-hidden="true">
                {CURRENTS[world].map((c, i) => <i key={i} style={{ ["--y" as string]: c.y, ["--c" as string]: c.c, ["--d" as string]: c.d, ["--delay" as string]: c.delay }} />)}
            </div>
            <div className={styles.heroBody}>
                <span className={styles.eyebrow}>{eyebrowIcon}{eyebrow}</span>
                <h1 id={titleId} className={styles.heroTitle}>
                    {title}{accent && <> <span className={styles.accent}>{accent}</span></>}
                </h1>
                <p className={styles.heroLead}>{lead}</p>
                {stats.length > 0 && (
                    <dl className={styles.stats}>
                        {stats.map((s) => (
                            <div key={s.label} className={styles.stat}>
                                <span className={styles.statIcon} aria-hidden="true">{s.icon}</span>
                                <div className="flex flex-col-reverse">
                                    <dt>{s.label}</dt>
                                    <dd>{s.value}</dd>
                                </div>
                            </div>
                        ))}
                    </dl>
                )}
                {(actions || side) && <div className={styles.heroActions}>{side}{actions}</div>}
            </div>
        </section>
    );
}

/* ── topic identity of the real translation collections (unknown codes get the neutral identity) ───────────────────── */
type Icon = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
const TOPIC_TONES: Record<string, { tone: string; icon: Icon }> = {
    GENERAL: { tone: "general", icon: Layers },
    EDUCATION: { tone: "education", icon: GraduationCap },
    FAMILY: { tone: "family", icon: Users },
    TECHNOLOGY: { tone: "technology", icon: Cpu },
    HEALTH: { tone: "health", icon: HeartPulse },
    WORK: { tone: "work", icon: Briefcase },
    URBAN_LIFE: { tone: "city", icon: Building2 },
    TRAVEL: { tone: "travel", icon: Plane },
    ENVIRONMENT: { tone: "nature", icon: Leaf },
    NATURE: { tone: "nature", icon: Sprout },
    SOCIETY: { tone: "society", icon: Landmark },
    CULTURE: { tone: "culture", icon: Palette },
    HOME: { tone: "family", icon: Home },
    SCIENCE: { tone: "science", icon: BookOpen },
};
export const topicIdentity = (code?: string | null) => (code && TOPIC_TONES[code.toUpperCase()]) || { tone: "other", icon: FileText as Icon };

/** Writing Coach families (the canonical ones TaskPicker already derives). */
export const FAMILY_TONES: Record<string, { tone: string; icon: Icon }> = {
    IELTS_TASK_1: { tone: "ielts1", icon: BarChart3 },
    IELTS_TASK_2: { tone: "ielts2", icon: PenLine },
    TOEIC_WRITING: { tone: "toeic", icon: Briefcase },
    GENERAL_ACADEMIC: { tone: "academic", icon: GraduationCap },
};

export function Glyph({ tone, icon: I, small = false }: { tone: string; icon: Icon; small?: boolean }) {
    return (
        <span className={`${styles.glyph} ${small ? styles.glyphSm : ""}`} data-tone={tone} aria-hidden="true">
            <I aria-hidden />
        </span>
    );
}

export function StudioLoading({ text }: { text: string }) {
    return (
        <div className={styles.loading} role="status" aria-live="polite">
            <span className={styles.quill} aria-hidden="true"><i /><b /></span>
            <span>{text}</span>
        </div>
    );
}

export function StatePanel({ icon, title, text, actions, kind = "empty" }: { icon: ReactNode; title: string; text?: ReactNode; actions?: ReactNode; kind?: "empty" | "error" }) {
    return (
        <div className={`${styles.panel} ${styles.state}`} data-kind={kind} role={kind === "error" ? "alert" : undefined}>
            <span className={styles.stateIcon} aria-hidden="true">{icon}</span>
            <h3 className={styles.stateTitle}>{title}</h3>
            {text && <p className={styles.stateText}>{text}</p>}
            {actions && <div className={styles.stateActions}>{actions}</div>}
        </div>
    );
}

/** The Writing Coach stage rail: the server's own session stage, shown in four learner steps (never a progress estimate). */
export type CoachStep = { label: string; state: "done" | "current" | "todo" };
export function StageRail({ steps, label }: { steps: CoachStep[]; label: string }) {
    return (
        <ol className={`${styles.panel} ${styles.stages}`} aria-label={label}>
            {steps.map((s, i) => (
                <li key={s.label} className="flex items-center gap-1.5">
                    {i > 0 && <span className={styles.stageSep} aria-hidden="true" />}
                    <span className={styles.stageStep} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
                        <span className={styles.stageNum}>
                            {s.state === "done"
                                ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
                                : i + 1}
                        </span>
                        {s.label}
                    </span>
                </li>
            ))}
        </ol>
    );
}
