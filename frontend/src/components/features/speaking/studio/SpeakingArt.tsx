"use client";

/**
 * Luyện nói "Echo Glass · Living Voice" art (owner brief 2026-10-22). Everything here is decoration: aria-hidden, no pointer
 * input, no request, no microphone. The voice ribbons are drawn light, never a level meter: the Speaking recorders expose no
 * analyser, so nothing on this page moves with the learner's voice.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Briefcase, Coffee, GraduationCap, MessagesSquare, Plane, Users } from "lucide-react";
import styles from "./speakingStudio.module.css";

/** Pauses the CSS animations of a section while it is off screen (`data-paused`, no React state). Callback ref. */
export function usePauseOffscreen<T extends HTMLElement>() {
    const io = useRef<IntersectionObserver | null>(null);
    useEffect(() => () => io.current?.disconnect(), []);
    return useCallback((el: T | null) => {
        io.current?.disconnect();
        io.current = null;
        if (!el || typeof IntersectionObserver === "undefined") return;
        io.current = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) delete el.dataset.paused;
            else el.dataset.paused = "";
        });
        io.current.observe(el);
    }, []);
}

// Fixed star field (a seeded sequence, identical on server and client).
function starField(count: number, seed: number) {
    let s = seed;
    const next = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: count }, () => ({ x: next() * 100, y: next() * 100, r: 0.4 + next() * 1.1, o: 0.25 + next() * 0.6, t: next() < 0.3 }));
}
const PAGE_STARS = starField(70, 11);
const HERO_STARS = starField(46, 29);

/** The page's own sky (shown only when no wallpaper is chosen). */
export function StudioBackdrop() {
    return (
        <div className={styles.backdrop} aria-hidden="true">
            <i /><i /><i /><i />
            <svg className={styles.stars} preserveAspectRatio="none" viewBox="0 0 100 100">
                {PAGE_STARS.map((st, i) => (
                    <circle key={i} cx={st.x} cy={st.y} r={st.r * 0.09} opacity={st.o} className={st.t ? styles.twinkle : undefined} style={st.t ? { animationDelay: `${(i % 7) * -0.6}s` } : undefined} />
                ))}
            </svg>
        </div>
    );
}

const PROFILE =
    "M150 430 C 118 345, 106 240, 148 160 C 184 92, 266 74, 306 120 C 319 136, 319 151, 316 163 C 319 178, 331 197, 347 215 C 339 223, 331 225, 326 229 C 330 236, 332 240, 330 245 C 324 249, 322 251, 326 255 C 332 261, 330 267, 322 271 C 322 283, 320 293, 311 301 C 299 313, 288 321, 286 341 L 284 430";
const NODES: Array<[number, number]> = [[176, 150], [214, 126], [258, 118], [236, 168], [192, 200], [262, 210], [222, 240], [174, 256], [250, 270], [206, 300]];
const LINKS: Array<[number, number]> = [[0, 1], [1, 2], [1, 3], [0, 4], [3, 5], [3, 4], [4, 6], [5, 6], [4, 7], [6, 8], [7, 9], [8, 9], [2, 3]];
// Ribbons leave the mouth and widen into the scene: [lift, swing, end, gradient, width]
const RIBBONS: Array<[number, number, number, string, number]> = [
    [-70, 60, -110, "spRibA", 2.4], [-40, 40, -40, "spRibB", 3.2], [-12, 24, 20, "spRibA", 1.6], [18, -30, 70, "spRibC", 2.8],
    [46, -52, 130, "spRibB", 1.8], [70, -20, 170, "spRibC", 2.2], [-96, 90, -170, "spRibC", 1.4],
];
const ribbonPath = ([lift, swing, end]: [number, number, number, string, number]) =>
    `M332 250 C 410 ${250 + lift}, 470 ${250 + swing}, 540 ${250 + lift * 0.6} S 690 ${250 + end * 0.5}, 780 ${250 + end}`;

/** The hero's voice: a profile in light, its words leaving as ribbons. */
export function HeroVoiceArt() {
    return (
        <div className={styles.heroScene} aria-hidden="true">
            <div className={styles.heroGlow} />
            <svg className={styles.heroStars} preserveAspectRatio="none" viewBox="0 0 100 100">
                {HERO_STARS.map((st, i) => (
                    <circle key={i} cx={st.x} cy={st.y} r={st.r * 0.12} opacity={st.o} className={st.t ? styles.twinkle : undefined} style={st.t ? { animationDelay: `${(i % 5) * -0.7}s` } : undefined} />
                ))}
            </svg>
            <svg className={styles.voiceArt} viewBox="0 0 760 420">
                <defs>
                    <linearGradient id="spProfile" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stopColor="#a5f3fc" />
                        <stop offset="0.55" stopColor="#818cf8" />
                        <stop offset="1" stopColor="#f0abfc" />
                    </linearGradient>
                    <radialGradient id="spProfileFill" cx="0.45" cy="0.42" r="0.6">
                        <stop offset="0" stopColor="#38bdf8" stopOpacity="0.45" />
                        <stop offset="0.6" stopColor="#6366f1" stopOpacity="0.18" />
                        <stop offset="1" stopColor="#6366f1" stopOpacity="0" />
                    </radialGradient>
                    <linearGradient id="spRibA" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0" stopColor="#fde68a" />
                        <stop offset="0.3" stopColor="#fb923c" />
                        <stop offset="0.65" stopColor="#ec4899" />
                        <stop offset="1" stopColor="#8b5cf6" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="spRibB" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0" stopColor="#fef3c7" />
                        <stop offset="0.35" stopColor="#22d3ee" />
                        <stop offset="0.7" stopColor="#6366f1" />
                        <stop offset="1" stopColor="#c084fc" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="spRibC" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0" stopColor="#ffffff" />
                        <stop offset="0.4" stopColor="#f472b6" />
                        <stop offset="0.75" stopColor="#a78bfa" />
                        <stop offset="1" stopColor="#38bdf8" stopOpacity="0" />
                    </linearGradient>
                </defs>
                <path className={styles.profileFill} d={`${PROFILE} L 120 430 Z`} />
                <g className={styles.neural}>
                    {LINKS.map(([a, b], i) => (
                        <path key={i} d={`M${NODES[a][0]} ${NODES[a][1]} L${NODES[b][0]} ${NODES[b][1]}`} />
                    ))}
                    {NODES.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 2.6 : 1.7} />)}
                </g>
                <path className={styles.profileLine} d={PROFILE} />
                {RIBBONS.map((rb, i) => <path key={`h${i}`} className={styles.ribbonHalo} d={ribbonPath(rb)} stroke={`url(#${rb[3]})`} strokeWidth={rb[4] * 4} />)}
                {RIBBONS.map((rb, i) => <path key={`s${i}`} className={styles.ribbonSolid} d={ribbonPath(rb)} stroke={`url(#${rb[3]})`} strokeWidth={rb[4]} />)}
                {RIBBONS.map((rb, i) => <path key={`f${i}`} className={styles.ribbon} d={ribbonPath(rb)} stroke={`url(#${rb[3]})`} strokeWidth={rb[4] + 1.2} />)}
            </svg>
            <span className={styles.floatWord} style={{ right: "33%", top: "16%", ["--r" as string]: "-4deg" }}>Practice</span>
            <span className={styles.floatWord} style={{ right: "9%", top: "48%", ["--r" as string]: "3deg" }}>Confidence</span>
            <span className={styles.floatWord} style={{ right: "30%", bottom: "13%", ["--r" as string]: "-2deg" }}>Fluency</span>
            <p className={styles.motto}>{"“Small conversations make big progress.”"}</p>
        </div>
    );
}

export type ModeSignKind = "shadowing" | "roleplay" | "assessment" | "topic";

/** Each practice mode's own sign in its tone (decorative). */
export function ModeSign({ kind }: { kind: ModeSignKind }) {
    return (
        <svg className={styles.sign} viewBox="0 0 120 72" aria-hidden="true">
            {kind === "shadowing" && (
                <>
                    <path d="M6 40 C 18 18, 30 18, 42 40 S 66 62, 78 40 S 102 18, 114 40" />
                    <path className={`${styles.alt} ${styles.signWave}`} d="M6 48 C 18 26, 30 26, 42 48 S 66 70, 78 48 S 102 26, 114 48" />
                </>
            )}
            {kind === "roleplay" && (
                <>
                    <rect x="12" y="10" width="54" height="30" rx="12" />
                    <path d="M26 40 L 22 50 L 36 40" />
                    <rect className={styles.alt} x="52" y="30" width="58" height="30" rx="12" />
                    <path className={styles.alt} d="M96 60 L 100 68 L 88 60" />
                    <path className={styles.signWave} d="M24 25 H 54" />
                    <path className={`${styles.alt} ${styles.signWave}`} d="M64 45 H 98" />
                </>
            )}
            {kind === "assessment" && (
                <>
                    <circle className={styles.signRing} cx="84" cy="36" r="30" />
                    <circle className={`${styles.alt} ${styles.signRing}`} cx="84" cy="36" r="30" />
                    <circle className={styles.signRing} cx="84" cy="36" r="30" />
                    <circle cx="84" cy="36" r="8" />
                </>
            )}
            {kind === "topic" && (
                <>
                    <rect x="20" y="14" width="34" height="44" rx="8" transform="rotate(-10 37 36)" />
                    <rect className={styles.alt} x="50" y="12" width="34" height="44" rx="8" transform="rotate(8 67 34)" />
                    <circle className={styles.signWave} cx="98" cy="30" r="12" />
                    <path className={styles.alt} d="M60 28 h 14 M60 36 h 10" />
                </>
            )}
        </svg>
    );
}

/** Category emblem of a conversation scenario (the catalogue carries no pictures, so none are invented). */
export function categoryTone(category?: string | null): { tone: string; Icon: React.ComponentType<{ className?: string }> } {
    switch (category) {
        case "TRAVEL": return { tone: "voice", Icon: Plane };
        case "DAILY_LIFE": return { tone: "mic", Icon: Coffee };
        case "BUSINESS": return { tone: "talk", Icon: Briefcase };
        case "WORK": return { tone: "talk", Icon: Users };
        case "ACADEMIC": return { tone: "topic", Icon: GraduationCap };
        default: return { tone: "topic", Icon: MessagesSquare };
    }
}

// A YouTube item's own poster frame (the same video the learner practises with).
export function youtubePoster(id?: string | null): string | null {
    return id && /^[\w-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

/**
 * A content picture that never shifts the layout (its frame has fixed geometry) and never shows a broken image: it fades in
 * once decoded, tries one fallback URL, and removes itself on failure so the typographic fallback underneath stays visible.
 */
export function StudioThumb({ src, fallbackSrc }: { src: string | null; fallbackSrc?: string | null }) {
    const [current, setCurrent] = useState<string | null>(src);
    const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
    const ref = useRef<HTMLImageElement>(null);
    useEffect(() => { setCurrent(src); setState("loading"); }, [src]);
    // YouTube answers a missing video with a 120 × 90 grey placeholder (an image, not an error): treat it as a failure.
    const settle = (img: HTMLImageElement) => {
        let placeholder = false;
        try { placeholder = img.naturalWidth <= 120 && /(^|\.)ytimg\.com$/.test(new URL(img.currentSrc || img.src).hostname); } catch { /* relative URL */ }
        if (img.naturalWidth > 0 && !placeholder) setState("loaded");
        else if (fallbackSrc && current !== fallbackSrc) setCurrent(fallbackSrc);
        else setState("error");
    };
    useEffect(() => {
        const img = ref.current;
        // decided before hydration attached the handlers: a finished image without pixels is a failed load
        if (img && img.complete) {
            if (img.naturalWidth > 0) settle(img);
            else if (fallbackSrc && current !== fallbackSrc) setCurrent(fallbackSrc);
            else setState("error");
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [current]);
    if (!current || state === "error") return null;
    return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
            ref={ref}
            src={current}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            data-loaded={state === "loaded" || undefined}
            onLoad={(e) => settle(e.currentTarget)}
            onError={() => {
                if (fallbackSrc && current !== fallbackSrc) setCurrent(fallbackSrc);
                else setState("error");
            }}
        />
    );
}
