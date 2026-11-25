/**
 * Short synthesized cues (Web Audio, no audio files, nothing autoplays): only ever triggered by a round the learner
 * started. Muting is a per-viewer preference.
 */
let ctx: AudioContext | null = null;

function context(): AudioContext | null {
    if (typeof window === "undefined") return null;
    try {
        if (!ctx) {
            const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            ctx = new Ctx();
        }
        if (ctx.state === "suspended") void ctx.resume();
        return ctx;
    } catch {
        return null;
    }
}

function tone(freq: number, startOffset: number, duration: number, volume: number, type: OscillatorType = "sine") {
    const c = context();
    if (!c) return;
    const t = c.currentTime + startOffset;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
}

export type TopicCue = "spin" | "reveal" | "tick" | "go" | "end";

export function playCue(cue: TopicCue, muted: boolean) {
    if (muted) return;
    switch (cue) {
        case "spin": // a rattle of small clicks while the capsules tumble
            for (let i = 0; i < 9; i++) tone(520 + (i % 3) * 90, i * 0.12, 0.05, 0.04, "triangle");
            break;
        case "reveal":
            tone(660, 0, 0.18, 0.08);
            tone(990, 0.12, 0.32, 0.07);
            break;
        case "tick":
            tone(880, 0, 0.08, 0.06, "square");
            break;
        case "go":
            tone(1046, 0, 0.25, 0.08);
            break;
        case "end":
            tone(784, 0, 0.3, 0.08);
            tone(523, 0.22, 0.5, 0.07);
            break;
    }
}
