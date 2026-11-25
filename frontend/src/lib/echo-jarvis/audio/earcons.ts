/**
 * Procedural WebAudio Earcon Synthesizer for Echo JARVIS.
 *
 * Pure oscillator + exponential gain-envelope synthesis (45..95 ms):
 * - Zero network requests, zero external audio assets, zero license risk, zero GC churn.
 * - Routes directly into the shared Echo AudioContext (and TTS AnalyserNode when supplied)
 *   so the Living Entity orb ripples crisply on wake, confirmation, action, sleep, or error
 *   without speaking repetitive greeting sentences.
 */

export type EchoEarconKind = 'wake' | 'action_ok' | 'confirm' | 'sleep' | 'error';

interface EarconToneStep {
  delaySec: number;
  durationSec: number;
  freqStartHz: number;
  freqEndHz: number;
  gainPeak: number;
  type: OscillatorType;
  harmonicRatio?: number;
  harmonicGain?: number;
}

const EARCON_RECIPES: Readonly<Record<EchoEarconKind, readonly EarconToneStep[]>> = {
  // 65 ms soft crystalline rising fifth (D5 -> A5) for instant wake / active mic cue
  wake: [
    {
      delaySec: 0,
      durationSec: 0.065,
      freqStartHz: 587.33,
      freqEndHz: 880.0,
      gainPeak: 0.11,
      type: 'sine',
      harmonicRatio: 2.0,
      harmonicGain: 0.02,
    },
  ],
  // 55 ms clean affirmative bell (E5 -> B5)
  action_ok: [
    {
      delaySec: 0,
      durationSec: 0.055,
      freqStartHz: 659.25,
      freqEndHz: 987.77,
      gainPeak: 0.09,
      type: 'sine',
      harmonicRatio: 1.5,
      harmonicGain: 0.015,
    },
  ],
  // 90 ms gentle two-note prompt for pending confirmations (C5 -> E5)
  confirm: [
    {
      delaySec: 0,
      durationSec: 0.042,
      freqStartHz: 523.25,
      freqEndHz: 523.25,
      gainPeak: 0.085,
      type: 'sine',
    },
    {
      delaySec: 0.045,
      durationSec: 0.048,
      freqStartHz: 659.25,
      freqEndHz: 698.46,
      gainPeak: 0.095,
      type: 'sine',
    },
  ],
  // 75 ms soft descending sigh (E5 -> A4) when returning to dormant / sleep
  sleep: [
    {
      delaySec: 0,
      durationSec: 0.075,
      freqStartHz: 659.25,
      freqEndHz: 440.0,
      gainPeak: 0.075,
      type: 'sine',
    },
  ],
  // 70 ms muted low wood-tap for denied / error states (D4 -> A3)
  error: [
    {
      delaySec: 0,
      durationSec: 0.07,
      freqStartHz: 293.66,
      freqEndHz: 220.0,
      gainPeak: 0.08,
      type: 'triangle',
    },
  ],
};

export interface EarconPlayRecord {
  kind: EchoEarconKind;
  timestampMs: number;
  audible: boolean;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Play a short procedural WebAudio earcon on the supplied AudioContext.
 * Returns `true` when scheduled onto WebAudio, or `false` when running headless without AudioContext.
 */
export function playProceduralEarcon(
  ctx: AudioContext | null | undefined,
  kind: EchoEarconKind,
  destination?: AudioNode | null,
  volumeScale = 1.0,
): boolean {
  const recipe = EARCON_RECIPES[kind];
  if (!recipe || !ctx || ctx.state === 'closed') {
    return false;
  }

  if (typeof ctx.createOscillator !== 'function' || typeof ctx.createGain !== 'function') {
    return false;
  }

  const sink = destination ?? ctx.destination;
  if (!sink) return false;

  try {
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      void ctx.resume().catch(() => {});
    }

    const scale = Math.max(0, Math.min(1.5, volumeScale));
    const baseTime = ctx.currentTime + 0.004;

    for (const step of recipe) {
      const t0 = baseTime + step.delaySec;
      const tAttack = t0 + Math.min(0.006, step.durationSec * 0.2);
      const tEnd = t0 + step.durationSec;

      const osc = ctx.createOscillator();
      const env = ctx.createGain();

      osc.type = step.type;
      osc.frequency.setValueAtTime(step.freqStartHz, t0);
      if (step.freqEndHz !== step.freqStartHz) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(40, step.freqEndHz), tEnd);
      }

      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(Math.max(0.0005, step.gainPeak * scale), tAttack);
      env.gain.exponentialRampToValueAtTime(0.0001, tEnd);

      osc.connect(env);
      env.connect(sink);

      osc.start(t0);
      osc.stop(tEnd + 0.004);
      osc.onended = () => {
        try {
          osc.disconnect();
          env.disconnect();
        } catch {
          // Ignore already disconnected nodes
        }
      };

      if (step.harmonicRatio && step.harmonicGain) {
        const harm = ctx.createOscillator();
        const harmEnv = ctx.createGain();
        harm.type = 'sine';
        harm.frequency.setValueAtTime(step.freqStartHz * step.harmonicRatio, t0);
        if (step.freqEndHz !== step.freqStartHz) {
          harm.frequency.exponentialRampToValueAtTime(
            Math.max(40, step.freqEndHz * step.harmonicRatio),
            tEnd,
          );
        }
        harmEnv.gain.setValueAtTime(0.0001, t0);
        harmEnv.gain.linearRampToValueAtTime(Math.max(0.0003, step.harmonicGain * scale), tAttack);
        harmEnv.gain.exponentialRampToValueAtTime(0.0001, tEnd);

        harm.connect(harmEnv);
        harmEnv.connect(sink);
        harm.start(t0);
        harm.stop(tEnd + 0.004);
        harm.onended = () => {
          try {
            harm.disconnect();
            harmEnv.disconnect();
          } catch {
            // Ignore already disconnected nodes
          }
        };
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Stateful earcon tracker that de-bounces duplicate cues within 40 ms and records play history for tests.
 */
export class EchoEarconSynth {
  private readonly history: EarconPlayRecord[] = [];
  private lastKind: EchoEarconKind | null = null;
  private lastPlayedAt = -1000;

  play(
    ctx: AudioContext | null | undefined,
    kind: EchoEarconKind,
    destination?: AudioNode | null,
    volumeScale = 1.0,
  ): boolean {
    const now = nowMs();
    if (this.lastKind === kind && now - this.lastPlayedAt < 40) {
      return false;
    }
    this.lastKind = kind;
    this.lastPlayedAt = now;
    const audible = playProceduralEarcon(ctx, kind, destination, volumeScale);
    this.history.push({ kind, timestampMs: now, audible });
    if (this.history.length > 32) {
      this.history.shift();
    }
    return audible;
  }

  getHistory(): readonly EarconPlayRecord[] {
    return this.history;
  }

  clearHistory(): void {
    this.history.length = 0;
    this.lastKind = null;
    this.lastPlayedAt = -1000;
  }
}
