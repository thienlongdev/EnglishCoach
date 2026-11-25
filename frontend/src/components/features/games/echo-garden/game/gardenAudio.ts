/**
 * Echo Garden interaction sounds (Phase 2): tiny, soft cues synthesized with Web Audio — no audio files, nothing
 * downloaded, nothing licensed. The context is created lazily on the first played cue (always the result of a user
 * action, so autoplay rules are respected). A mute switch is remembered per browser (a convenience only; storage may
 * be unavailable, in which case sound simply defaults to on for the session).
 */

export type GardenSound = "plant" | "water" | "harvest" | "coins" | "essence" | "shoo" | "graduate" | "soft";

const STORAGE_KEY = "echo-garden:muted";

type Note = { f: number; t: number; d: number; type?: OscillatorType; g?: number; slide?: number };

const SOUNDS: Record<GardenSound, Note[]> = {
  plant: [{ f: 330, t: 0, d: 0.12, type: "triangle", g: 0.18, slide: 220 }, { f: 520, t: 0.08, d: 0.1, type: "sine", g: 0.08 }],
  water: [0, 0.05, 0.1, 0.16].map((t, i) => ({ f: 900 + i * 140, t, d: 0.07, type: "sine", g: 0.06, slide: 1400 + i * 120 })),
  harvest: [{ f: 523, t: 0, d: 0.16, type: "triangle", g: 0.14 }, { f: 659, t: 0.09, d: 0.16, type: "triangle", g: 0.12 }, { f: 784, t: 0.18, d: 0.22, type: "triangle", g: 0.11 }],
  coins: [{ f: 1046, t: 0, d: 0.08, type: "square", g: 0.035 }, { f: 1318, t: 0.07, d: 0.12, type: "square", g: 0.03 }],
  essence: [{ f: 587, t: 0, d: 0.35, type: "sine", g: 0.1 }, { f: 880, t: 0.1, d: 0.4, type: "sine", g: 0.08 }, { f: 1174, t: 0.22, d: 0.45, type: "sine", g: 0.05 }],
  shoo: [{ f: 420, t: 0, d: 0.22, type: "sine", g: 0.1, slide: 900 }, { f: 700, t: 0.12, d: 0.14, type: "sine", g: 0.06 }],
  graduate: [523, 659, 784, 1046].map((f, i) => ({ f, t: i * 0.12, d: 0.6 - i * 0.05, type: "triangle", g: 0.1 })),
  soft: [{ f: 440, t: 0, d: 0.12, type: "sine", g: 0.07 }],
};

class GardenAudio {
  private ctx: AudioContext | null = null;
  private mutedState: boolean | null = null;

  get muted(): boolean {
    if (this.mutedState === null) {
      try {
        this.mutedState = typeof window !== "undefined" && window.localStorage.getItem(STORAGE_KEY) === "1";
      } catch {
        this.mutedState = false;
      }
    }
    return this.mutedState;
  }

  setMuted(m: boolean) {
    this.mutedState = m;
    try {
      window.localStorage.setItem(STORAGE_KEY, m ? "1" : "0");
    } catch {
      /* storage unavailable: the choice holds for this session */
    }
  }

  play(sound: GardenSound) {
    if (this.muted || typeof window === "undefined") return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx ??= new Ctx();
      const ctx = this.ctx;
      if (ctx.state === "suspended") void ctx.resume();
      const t0 = ctx.currentTime + 0.01;
      for (const n of SOUNDS[sound]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = n.type ?? "sine";
        o.frequency.setValueAtTime(n.f, t0 + n.t);
        if (n.slide) o.frequency.exponentialRampToValueAtTime(n.slide, t0 + n.t + n.d);
        const peak = n.g ?? 0.1;
        g.gain.setValueAtTime(0.0001, t0 + n.t);
        g.gain.exponentialRampToValueAtTime(peak, t0 + n.t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.t + n.d);
        o.connect(g).connect(ctx.destination);
        o.start(t0 + n.t);
        o.stop(t0 + n.t + n.d + 0.02);
      }
    } catch {
      /* sound is optional feedback: never break gameplay */
    }
  }

  /** Release the audio device when the garden unmounts. */
  close() {
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}

export const gardenAudio = new GardenAudio();
