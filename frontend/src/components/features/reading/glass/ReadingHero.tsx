"use client";

import type { ReactNode } from "react";
import styles from "./readingGlass.module.css";

export type ReadingWorld = "library" | "mybooks" | "bilingual" | "speed";

/*
 * The four Reading heroes are rendered stills of scenes built in code (Blender, `docs/reading/echo-glass-2026-10-23/art/`):
 * an ocean study, a reading room in late sun, two pages at dawn, a focus lab at dusk. Content-hashed names (a changed
 * picture ships under a new name, the edge caches images for a year). Decorative: alt="" and aria-hidden.
 */
const ART: Record<ReadingWorld, { small: string; large: string }> = {
    library: { small: "/assets/reading/reading-library-1280-4f8c05f2.webp", large: "/assets/reading/reading-library-2560-8f573954.webp" },
    mybooks: { small: "/assets/reading/reading-mybooks-1280-609d8c46.webp", large: "/assets/reading/reading-mybooks-2560-65d6975b.webp" },
    bilingual: { small: "/assets/reading/reading-bilingual-1280-7005fe45.webp", large: "/assets/reading/reading-bilingual-2560-56215efa.webp" },
    speed: { small: "/assets/reading/reading-speed-1280-b4a97d99.webp", large: "/assets/reading/reading-speed-2560-3b786fec.webp" },
};
export const SHELF_BACKDROP = "/assets/reading/reading-shelf-backdrop-1600-a3a56c05.webp";
export const READING_ART = ART;

// Deterministic glints over the artwork (same on server and client).
const GLINTS = [
    { l: "62%", t: "30%", d: "0s" }, { l: "71%", t: "18%", d: "-2.2s" }, { l: "79%", t: "42%", d: "-4.1s" },
    { l: "86%", t: "24%", d: "-1.3s" }, { l: "93%", t: "36%", d: "-5.6s" }, { l: "67%", t: "52%", d: "-3.4s" },
];

export interface HeroStat { value: ReactNode; label: string; icon: ReactNode }

export function ReadingHero({ world, eyebrow, eyebrowIcon, title, lead, note, stats, actions }: {
    world: ReadingWorld;
    eyebrow: string;
    eyebrowIcon: ReactNode;
    title: string;
    lead: string;
    note?: ReactNode;
    stats: HeroStat[];
    actions?: ReactNode;
}) {
    const art = ART[world];
    return (
        <section className={styles.hero} data-world={world} aria-labelledby={`reading-hero-${world}`}>
            <div className={styles.heroArt} aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={art.small} srcSet={`${art.small} 1280w, ${art.large} 2560w`} sizes="(min-width: 768px) 60vw, 200vw" alt="" decoding="async" draggable={false} />
                {world === "bilingual" && (
                    <>
                        <span className={styles.artChip} data-lang="en" style={{ left: "68.5%", top: "40%" }}>EN</span>
                        <span className={styles.artChip} data-lang="vi" style={{ left: "82%", top: "40%" }}>VI</span>
                    </>
                )}
            </div>
            <div className={styles.heroShade} aria-hidden="true" />
            <div className={styles.heroGlints} aria-hidden="true">
                {GLINTS.map((g, i) => <i key={i} style={{ left: g.l, top: g.t, animationDelay: g.d }} />)}
            </div>
            <div className={styles.heroBody}>
                <span className={styles.eyebrow}>{eyebrowIcon}{eyebrow}</span>
                <h1 id={`reading-hero-${world}`} className={styles.heroTitle}>{title}</h1>
                <p className={styles.heroLead}>{lead}</p>
                {note && <p className={styles.heroNote}>{note}</p>}
                <dl className={styles.stats}>
                    {stats.map((s) => (
                        <div key={s.label} className={styles.stat} data-tone={world}>
                            <span className={styles.statIcon} aria-hidden="true">{s.icon}</span>
                            <div className="flex flex-col-reverse">
                                <dt>{s.label}</dt>
                                <dd>{s.value}</dd>
                            </div>
                        </div>
                    ))}
                </dl>
                {actions && <div className={styles.heroActions}>{actions}</div>}
            </div>
        </section>
    );
}
