/**
 * Âm thanh nền — every channel is synthesised in the browser with Web Audio (no audio file, no request, nothing on the
 * server): white, pink and brown noise; rain (filtered noise + random drops); ocean waves (noise swelling on a slow
 * cycle); wind (band-passed noise with a wandering centre); fireplace (low rumble + random crackles); a soft cafe
 * murmur is NOT offered because it cannot be made honestly without recordings. Each channel has its own gain and the
 * mixer has a master gain; levels are remembered per browser.
 */

export type AmbientChannel = 'rain' | 'waves' | 'wind' | 'fire' | 'white' | 'pink' | 'brown';
export const CHANNELS: { id: AmbientChannel; label: string }[] = [
  { id: 'rain', label: 'Mưa' }, { id: 'waves', label: 'Sóng biển' }, { id: 'wind', label: 'Gió' }, { id: 'fire', label: 'Lò sưởi' },
  { id: 'white', label: 'Tiếng ồn trắng' }, { id: 'pink', label: 'Tiếng ồn hồng' }, { id: 'brown', label: 'Tiếng ồn nâu' },
];

export interface AmbientLevels { master: number; levels: Record<AmbientChannel, number>; muted: boolean }
const KEY = 'ec_ambient:v1';
export const AMBIENT_PRESETS: { id: string; label: string; levels: Partial<Record<AmbientChannel, number>> }[] = [
  { id: 'rainy', label: 'Phòng mưa', levels: { rain: 0.7, wind: 0.15, brown: 0.15 } },
  { id: 'ocean', label: 'Bờ biển', levels: { waves: 0.75, wind: 0.2 } },
  { id: 'cabin', label: 'Bên lò sưởi', levels: { fire: 0.7, rain: 0.25 } },
  { id: 'deep', label: 'Tập trung sâu', levels: { brown: 0.55, pink: 0.1 } },
];

export function readLevels(): AmbientLevels {
  const base: AmbientLevels = { master: 0.6, muted: false, levels: { rain: 0, waves: 0, wind: 0, fire: 0, white: 0, pink: 0, brown: 0 } };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as AmbientLevels | null;
    if (raw && typeof raw.master === 'number') return { ...base, ...raw, levels: { ...base.levels, ...raw.levels } };
  } catch { /* defaults */ }
  return base;
}

export function noiseBuffer(ctx: AudioContext, kind: 'white' | 'pink' | 'brown', seconds = 4): AudioBuffer {
  const len = ctx.sampleRate * seconds;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w * 0.5;
      else if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }
    }
  }
  return buf;
}

export class AmbientMixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private gains = new Map<AmbientChannel, GainNode>();
  private timers: ReturnType<typeof setInterval>[] = [];
  state: AmbientLevels = readLevels();

  /** Must be called from a user gesture (browsers start audio only then). */
  async start() {
    if (this.ctx) { await this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const src = (kind: 'white' | 'pink' | 'brown') => { const s = ctx.createBufferSource(); s.buffer = noiseBuffer(ctx, kind); s.loop = true; s.start(); return s; };
    const channel = (id: AmbientChannel) => { const g = ctx.createGain(); g.gain.value = 0; g.connect(this.master!); this.gains.set(id, g); return g; };

    for (const k of ['white', 'pink', 'brown'] as const) src(k).connect(channel(k));

    // Rain: bright filtered noise + random drop clicks.
    const rain = channel('rain');
    const rf = ctx.createBiquadFilter(); rf.type = 'bandpass'; rf.frequency.value = 2400; rf.Q.value = 0.6;
    src('pink').connect(rf).connect(rain);
    const drops = ctx.createGain(); drops.gain.value = 0.5; drops.connect(rain);
    this.timers.push(setInterval(() => {
      if ((this.gains.get('rain')?.gain.value ?? 0) < 0.01) return;
      for (let i = 0; i < 6; i++) {
        const t = ctx.currentTime + Math.random() * 0.2;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 1800 + Math.random() * 2600;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05 * Math.random(), t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
        o.connect(g).connect(drops); o.start(t); o.stop(t + 0.05);
      }
    }, 200));

    // Waves: low-passed noise whose level follows a slow swell.
    const waves = channel('waves');
    const wf = ctx.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 700;
    const swell = ctx.createGain(); swell.gain.value = 0.3;
    src('brown').connect(wf).connect(swell).connect(waves);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.09;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.28;
    lfo.connect(lfoGain).connect(swell.gain); lfo.start();
    const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.09; const lg2 = ctx.createGain(); lg2.gain.value = 350;
    lfo2.connect(lg2).connect(wf.frequency); lfo2.start();

    // Wind: band-passed noise with a wandering centre frequency.
    const wind = channel('wind');
    const bf = ctx.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 500; bf.Q.value = 1.2;
    src('pink').connect(bf).connect(wind);
    const wl = ctx.createOscillator(); wl.frequency.value = 0.05; const wg = ctx.createGain(); wg.gain.value = 260;
    wl.connect(wg).connect(bf.frequency); wl.start();

    // Fire: rumble + crackles.
    const fire = channel('fire');
    const ff = ctx.createBiquadFilter(); ff.type = 'lowpass'; ff.frequency.value = 300;
    const rumble = ctx.createGain(); rumble.gain.value = 0.6;
    src('brown').connect(ff).connect(rumble).connect(fire);
    this.timers.push(setInterval(() => {
      if ((this.gains.get('fire')?.gain.value ?? 0) < 0.01) return;
      const n = Math.random() < 0.6 ? 1 : 3;
      for (let i = 0; i < n; i++) {
        const t = ctx.currentTime + Math.random() * 0.15;
        const b = ctx.createBufferSource(); b.buffer = noiseBuffer(ctx, 'white', 0.05);
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500 + Math.random() * 3000;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.4 * Math.random(), t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03 + Math.random() * 0.05);
        b.connect(hp).connect(g).connect(fire); b.start(t);
      }
    }, 180));
    this.apply();
  }

  set(next: AmbientLevels) {
    this.state = next;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* not remembered */ }
    this.apply();
  }

  get playing() { return !!this.ctx && this.ctx.state === 'running' && !this.state.muted && Object.values(this.state.levels).some((v) => v > 0); }

  private apply() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.state.muted ? 0 : this.state.master, t, 0.15);
    for (const [id, g] of this.gains) g.gain.setTargetAtTime(this.state.levels[id] ?? 0, t, 0.2);
  }

  async stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.gains.clear();
    const c = this.ctx;
    this.ctx = null;
    this.master = null;
    if (c) await c.close().catch(() => undefined);
  }
}

let shared: AmbientMixer | null = null;
export const ambientMixer = () => (shared ??= new AmbientMixer());
