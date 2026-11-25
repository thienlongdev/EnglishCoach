"use client";

import React, { CSSProperties } from "react";
import styles from "./topicStudio.module.css";

export type MachineState = "idle" | "spinning" | "dropping" | "opened";

/** Capsule colours: one per category family, so the capsule that drops already hints at the topic area. */
export const CAPSULE_COLORS = ["#8b7bff", "#f472b6", "#fbbf24", "#34d399", "#38bdf8", "#fb7185", "#a78bfa", "#f3d48b"];

export function capsuleColor(category: string | null | undefined): string {
    if (!category) return CAPSULE_COLORS[0];
    let h = 0;
    for (let i = 0; i < category.length; i++) h = (h * 31 + category.charCodeAt(i)) >>> 0;
    return CAPSULE_COLORS[h % CAPSULE_COLORS.length];
}

// A fixed pile resting in the lower part of the dome (percent of the dome box) with per-capsule motion offsets.
const PILE = [
    [8, 62], [24, 70], [41, 74], [58, 72], [74, 64], [16, 46], [33, 53], [50, 55], [66, 50],
    [26, 33], [44, 37], [60, 31], [36, 18], [12, 28],
].map(([x, y], i) => ({
    x, y,
    c: CAPSULE_COLORS[i % CAPSULE_COLORS.length],
    r: (i * 47) % 360,
    d: `${(i % 5) * -0.07}s`,
    dx: `${((i * 13) % 11) - 5}px`,
    dy: `${-8 - ((i * 7) % 9)}px`,
}));

/**
 * The topic machine. It only animates the draw the server is making — the question is never chosen here.
 * Decorative for assistive technology; the live region of the studio announces what happens.
 */
export function CapsuleMachine({ state, color, width = 250 }: { state: MachineState; color: string; width?: number }) {
    const stateClass =
        state === "spinning" ? styles.spinning : state === "dropping" ? styles.dropping : state === "opened" ? `${styles.dropping} ${styles.opened}` : "";
    return (
        <div className={`${styles.machine} ${stateClass}`} style={{ "--machine-w": `${width}px` } as CSSProperties} aria-hidden="true">
            <div className={styles.dome}>
                <div className={styles.tumbler}>
                    {PILE.map((p, i) => (
                        <span
                            key={i}
                            className={styles.capsule}
                            style={{ "--x": `${p.x}%`, "--y": `${p.y}%`, "--c": p.c, "--r": `${p.r}deg`, "--d": p.d, "--dx": p.dx, "--dy": p.dy } as CSSProperties}
                        />
                    ))}
                </div>
                <div className={styles.glare} />
            </div>
            <div className={styles.collar} />
            <div className={styles.body}>
                <div className={styles.knob} />
                <div className={styles.chute}>
                    {(state === "dropping" || state === "opened") && (
                        <div className={styles.outCapsule} style={{ "--c": color } as CSSProperties}>
                            <span className={`${styles.half} ${styles.top}`} />
                            <span className={`${styles.half} ${styles.bottom}`} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
