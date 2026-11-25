import type { CSSProperties, ReactNode } from "react";
import styles from "./readingGlass.module.css";

/*
 * Typographic cover art for a reading that has no picture of its own (the SYSTEM corpus carries none: agency photos were
 * excluded at import). The motif names the TOPIC FAMILY in line art and the word on the cover is the item's own topic /
 * source — never a borrowed photograph, never game art (10 §AH). A per-item seed shifts the gradient angle and the motif
 * so neighbouring cards of one topic are not identical. Decorative: aria-hidden.
 */
type Family = "mind" | "health" | "earth" | "space" | "history" | "business" | "language" | "travel" | "life" | "story" | "bilingual" | "personal" | "plain";

const PALETTES: Record<Family, [string, string, string]> = {
    mind: ["#4c1d95", "#7c3aed", "#f0abfc"],
    health: ["#9f1239", "#e11d48", "#fdba74"],
    earth: ["#064e3b", "#059669", "#a7f3d0"],
    space: ["#0c1e5a", "#2563eb", "#67e8f9"],
    history: ["#78350f", "#d97706", "#fde68a"],
    business: ["#1e1b4b", "#4f46e5", "#a5b4fc"],
    language: ["#0b3a8a", "#2563eb", "#93c5fd"],
    travel: ["#134e4a", "#0d9488", "#99f6e4"],
    life: ["#7c2d12", "#ea580c", "#fed7aa"],
    story: ["#831843", "#db2777", "#fbcfe8"],
    bilingual: ["#0b2a6e", "#2563eb", "#f9a8d4"],
    personal: ["#1f2a44", "#475569", "#cbd5e1"],
    plain: ["#0f2a5c", "#1d4ed8", "#bae6fd"],
};

export function topicFamily(topic?: string | null): Family {
    const t = (topic || "").toLowerCase();
    if (/psycholog|mind/.test(t)) return "mind";
    if (/health|medic/.test(t)) return "health";
    if (/earth|environment|nature/.test(t)) return "earth";
    if (/space|science|technolog/.test(t)) return "space";
    if (/history|culture|society/.test(t)) return "history";
    if (/business|work/.test(t)) return "business";
    if (/education|language/.test(t)) return "language";
    if (/travel|outdoor/.test(t)) return "travel";
    if (/everyday|life/.test(t)) return "life";
    return "plain";
}

const W = "rgb(255 255 255 / 0.55)";
const F = "rgb(255 255 255 / 0.14)";

function Motif({ family, s }: { family: Family; s: number }): ReactNode {
    const dx = (s % 7) * 9 - 27;
    const dy = (s % 5) * 4 - 8;
    const g = { fill: "none", stroke: W, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
    switch (family) {
        case "mind":
            return <g transform={`translate(${dx} ${dy})`}>
                {[30, 50, 70, 90].map((r) => <circle key={r} cx="230" cy="70" r={r} {...g} strokeOpacity={1 - r / 120} />)}
                {[[230, 70], [196, 44], [262, 40], [270, 96], [204, 104], [168, 76]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r={4.5} fill={W} />)}
                <path d="M230 70 196 44M230 70 262 40M230 70 270 96M230 70 204 104M196 44 168 76" {...g} strokeOpacity={0.7} />
            </g>;
        case "health":
            return <g transform={`translate(${dx} 0)`}>
                <circle cx="240" cy="66" r="56" fill={F} />
                <path d="M120 78h46l12-30 18 58 16-46 10 18h50" {...g} strokeWidth={3} />
            </g>;
        case "earth":
            if (s % 3 === 1) return <g transform={`translate(${dx} 0)`}>
                <circle cx="236" cy="46" r="20" fill="rgb(255 255 255 / 0.45)" />
                {[0, 1, 2].map((i) => <path key={i} d={`M120 ${92 + i * 16}q25-14 50 0t50 0 50 0 50 0`} {...g} strokeOpacity={0.9 - i * 0.25} />)}
            </g>;
            if (s % 3 === 2) return <g transform={`translate(${dx} 0)`}>
                {[[190, 1], [226, 1.25], [262, 0.95], [292, 0.8]].map(([x, k], i) => <g key={i}><path {...g} fill={F} d={`M${x} ${118 - 64 * k}l${22 * k} ${50 * k}h${-44 * k}Z`} /><path d={`M${x} ${118 - 14 * k}v${14 * k}`} {...g} /></g>)}
                <path d="M150 120h170" {...g} />
            </g>;
            return <g transform={`translate(${dx} 0)`}>
                <circle cx="252" cy="44" r="18" fill="rgb(255 255 255 / 0.5)" />
                <path d="M-10 140 70 70l50 40 60-62 70 62 40-26 60 56Z" fill={F} />
                <path d="M-10 140 60 96l60 30 70-50 80 64Z" fill="rgb(255 255 255 / 0.1)" />
                <path d="M70 70l50 40 60-62 70 62 40-26" {...g} strokeOpacity={0.8} />
            </g>;
        case "space":
            return <g transform={`translate(${dx} ${dy})`}>
                <ellipse cx="236" cy="70" rx="86" ry="26" {...g} transform="rotate(-14 236 70)" />
                <ellipse cx="236" cy="70" rx="60" ry="18" {...g} strokeOpacity={0.6} transform="rotate(-14 236 70)" />
                <circle cx="236" cy="70" r="24" fill="rgb(255 255 255 / 0.32)" />
                <circle cx="160" cy="88" r="5" fill={W} /><circle cx="300" cy="46" r="3.5" fill={W} />
            </g>;
        case "history":
            return <g transform={`translate(${dx} 0)`}>
                <path d="M150 52h150L225 18Z" {...g} fill={F} />
                {[166, 194, 222, 250, 278].map((x) => <rect key={x} x={x} y="58" width="12" height="60" rx="2" fill={F} stroke={W} strokeWidth={1.6} />)}
                <path d="M146 124h158" {...g} />
            </g>;
        case "business":
            return <g transform={`translate(${dx} 0)`}>
                {[0, 1, 2, 3, 4].map((i) => <rect key={i} x={170 + i * 26} y={112 - (i + 1) * 15 - (s % 3) * 3} width="16" height={(i + 1) * 15 + (s % 3) * 3} rx="3" fill={F} stroke={W} strokeWidth={1.4} />)}
                <path d="M160 92 196 70l26 12 30-26 40-20" {...g} strokeWidth={2.6} />
            </g>;
        case "language":
        case "bilingual":
            return <g transform={`translate(${dx} ${dy})`}>
                <path d="M160 46q36-14 70 0v66q-34-14-70 0Z" {...g} fill={F} />
                <path d="M230 46q36-14 70 0v66q-34-14-70 0Z" {...g} fill={F} />
                {[60, 72, 84, 96].map((y) => <path key={y} d={`M172 ${y}h44M242 ${y}h44`} stroke={W} strokeWidth={1.6} strokeLinecap="round" strokeOpacity={0.7} />)}
                {family === "bilingual" && <path d="M218 128h24m-6-6 6 6-6 6" {...g} />}
            </g>;
        case "travel":
            return <g transform={`translate(${dx} 0)`}>
                <circle cx="248" cy="62" r="34" {...g} /><path d="m248 38 8 24-8 24-8-24Z" fill={W} />
                <path d="M110 120c40-30 70 10 100-16" {...g} strokeDasharray="4 8" />
            </g>;
        case "life":
            return <g transform={`translate(${dx} 0)`}>
                <circle cx="250" cy="52" r="22" fill="rgb(255 255 255 / 0.4)" />
                <path d="M170 120V82l36-28 36 28v38Z" {...g} fill={F} />
                <path d="M196 120v-22h20v22" {...g} />
            </g>;
        case "story":
            return <g transform={`translate(${dx} ${dy})`}>
                <path d="M200 30c-30 30-30 60 0 90 30-30 30-60 0-90Z" {...g} fill={F} />
                <circle cx="268" cy="44" r="12" fill="rgb(255 255 255 / 0.45)" />
                {[[150, 50], [290, 92], [170, 108]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="2.5" fill={W} />)}
            </g>;
        default:
            return <g transform={`translate(${dx} ${dy})`}>
                <rect x="190" y="26" width="76" height="96" rx="6" {...g} fill={F} transform="rotate(8 228 74)" />
                <rect x="176" y="30" width="76" height="96" rx="6" {...g} fill="rgb(255 255 255 / 0.18)" />
                {[52, 64, 76, 88].map((y) => <path key={y} d={`M188 ${y}h50`} stroke={W} strokeWidth={1.6} strokeLinecap="round" />)}
            </g>;
    }
}

export function ReadingCover({ family, seed = 0, word, size = "md", className }: { family: Family; seed?: number; word?: string | null; size?: "md" | "lg"; className?: string }) {
    const [c0, c1, c2] = PALETTES[family];
    const s = Math.abs(Math.trunc(seed));
    // per-item variation: angle, light position, a small hue / saturation shift and the motif's own variant
    const style = { "--c0": c0, "--c1": c1, "--c2": c2, "--ca": `${110 + (s % 7) * 13}deg`, "--cx": `${55 + (s % 5) * 9}%`,
        "--ch": `${((s * 37) % 31) - 15}deg`, "--cs": String(0.9 + ((s * 13) % 5) * 0.06) } as CSSProperties;
    return (
        <div className={`${styles.cover} ${className ?? ""}`} data-size={size} style={style} aria-hidden="true">
            <svg viewBox="0 0 320 140" preserveAspectRatio={size === "lg" ? "xMaxYMid meet" : "xMaxYMid slice"}><Motif family={family} s={s} /></svg>
            {word && <span className={styles.coverWord}>{word}</span>}
        </div>
    );
}
