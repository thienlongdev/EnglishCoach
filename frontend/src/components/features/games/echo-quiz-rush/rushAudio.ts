/**
 * Echo Quiz Rush · Skybound — original adaptive score and sound design, synthesised in the browser (no downloaded or
 * licensed audio). Eight stems of one 8-bar theme (128 BPM, D major: D · Bm · G · A · D · F♯m · G · A) are rendered once
 * with OfflineAudioContext, then loop together sample-aligned; the race only moves their gains:
 *
 *   preparation   pad + bells                       (lobby, countdown adds the string ostinato)
 *   running       + bass + light drums
 *   momentum      + arpeggio                        (first-try streak ≥ 2)
 *   heroic        + lead melody + full drums        (streak ≥ 4, Echo Rush, a close race)
 *   gate tension  ostinato up, lead/arp down, riser (entering a wall's decision zone)
 *   final sprint  everything                        (after the last wall)
 *   victory / defeat stingers duck the score.
 *
 * Audio starts only from a user gesture; mute / volume persist; every node is released on stop / dispose.
 *
 * Sound effects (Skybound Trials) are rendered once into small buffers the same way: six footstep variants (played at
 * the animation's foot contacts, louder and brighter with pace), take-off and landing (soft / heavy), dodge, sprint
 * wind, dash, the Echo Rush call, obstacle hits, a fall, the respawn chime, the stone sill, the rising gate's grind,
 * and one cue per obstacle (beam swoosh, ram creak, boulder rumble, sky-stone whistle and impact, chasm wind).
 * Music and effects have their own levels; big moments duck the score; a soft limiter guards the sum.
 */
export type RushSound = 'start' | 'correct' | 'wrong' | 'dash' | 'rush' | 'finish' | 'ice' | 'snare' | 'swap' | 'gate-open' | 'gate-pass' | 'footstep' | 'ui'
  | 'post' | 'overtake' | 'near-gate' | 'combo' | 'count' | 'go' | 'victory' | 'defeat' | 'deny' | 'ready';
/** Events the 3D world reports (RushScene WorldAudio) — value: pace / strength / obstacle code; pan −1..1. */
export type RushWorldSound = 'gate-open' | 'gate-pass' | 'footstep' | 'dash' | 'rush' | 'near-gate' | 'jump' | 'land' | 'dodge' | 'knock' | 'fall' | 'respawn'
  | 'slam' | 'gust' | 'crack' | 'crumble' | 'shutter' | 'wall-hit' | 'orb-speed' | 'orb-energy' | 'orb-guard' | 'shield' | 'bump'
  | 'sill' | 'rise' | 'hazard' | 'swoosh' | 'whistle' | 'boom' | 'sprint' | 'finish' | 'overtake';
export type RushAmbience = 'rumble' | 'wind' | 'grind' | 'saw' | 'hum';
export interface RushMood { streak: number; tension: boolean; finale: boolean; close: boolean; rush: boolean }
type Preferences = { muted: boolean; volume: number; music: number; effects: number };
type Scene = 'off' | 'lobby' | 'countdown' | 'race' | 'results';

const STORAGE = 'echo-quiz-rush:audio-v1';
const defaults: Preferences = { muted: false, volume: 0.32, music: 1, effects: 1 };
const BPM = 128, BEAT = 60 / BPM, BARS = 8, LOOP = BARS * 4 * BEAT;
const STEMS = ['pad', 'bells', 'bass', 'drumsLight', 'arp', 'lead', 'drumsFull', 'ostinato'] as const;
type Stem = typeof STEMS[number];

// Note helper: semitones from A4.
const hz = (name: string) => {
  const m = /^([A-G])(#|b)?(\d)$/.exec(name)!; const base: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
  return 440 * Math.pow(2, (base[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) - 4) * 12) / 12);
};
const CHORDS: string[][] = [['D3', 'F#3', 'A3'], ['B2', 'D3', 'F#3'], ['G2', 'B2', 'D3'], ['A2', 'C#3', 'E3'], ['D3', 'F#3', 'A3'], ['F#2', 'A2', 'C#3'], ['G2', 'B2', 'D3'], ['A2', 'C#3', 'E3']];
const LEAD: [number, string, number][] = [ // [beat, note, beats]
  [0, 'A4', 1], [1, 'D5', .5], [1.5, 'E5', .5], [2, 'F#5', 1.5], [3.5, 'E5', .5],
  [4, 'D5', 1], [5, 'B4', 1], [6, 'F#4', 2],
  [8, 'G4', .5], [8.5, 'A4', .5], [9, 'B4', 1], [10, 'D5', 1], [11, 'B4', 1],
  [12, 'C#5', 1], [13, 'A4', 1], [14, 'E5', 2],
  [16, 'F#5', 1], [17, 'A5', 1], [18, 'F#5', .5], [18.5, 'E5', .5], [19, 'D5', 1],
  [20, 'C#5', 1], [21, 'A4', 1], [22, 'F#4', 1], [23, 'A4', 1],
  [24, 'B4', 1], [25, 'D5', 1], [26, 'G5', 1], [27, 'F#5', .5], [27.5, 'E5', .5],
  [28, 'E5', 2], [30, 'C#5', 1], [31, 'A4', 1],
];

let stemCache: { rate: number; buffers: Map<Stem, AudioBuffer>; stingers: Map<string, AudioBuffer>; sfx: Map<string, AudioBuffer[]> } | null = null;
let rendering: Promise<void> | null = null;
// High-rate Windows devices can report 192 kHz. Web Audio resamples AudioBuffers itself; a 48 kHz score keeps
// the same audible bandwidth while avoiding four times the offline work and decoded stem memory.
const scoreRate = (deviceRate: number) => Math.min(48000, deviceRate);

function noiseBuffer(ctx: BaseAudioContext, seconds: number) {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate), d = b.getChannelData(0);
  let s = 1234567; for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = s / 0x3fffffff - 1; }
  return b;
}

/** Synth voices for the offline renders. */
class Voices {
  private noise: AudioBuffer;
  constructor(private ctx: OfflineAudioContext, private out: AudioNode) { this.noise = noiseBuffer(ctx, 1); }
  tone(f: number, at: number, dur: number, gain: number, o: { type?: OscillatorType; attack?: number; release?: number; cutoff?: number; cutoffEnd?: number; q?: number; detune?: number[]; vibrato?: number; pan?: number } = {}) {
    const ctx = this.ctx, g = ctx.createGain(), attack = o.attack ?? .01, release = o.release ?? .2;
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(gain, at + attack);
    g.gain.setValueAtTime(gain, Math.max(at + attack, at + dur - release * .3));
    g.gain.exponentialRampToValueAtTime(.0001, at + dur + release);
    let node: AudioNode = g;
    if (o.cutoff) {
      const f2 = ctx.createBiquadFilter(); f2.type = 'lowpass'; f2.Q.value = o.q ?? .7; f2.frequency.setValueAtTime(o.cutoff, at);
      if (o.cutoffEnd) f2.frequency.exponentialRampToValueAtTime(o.cutoffEnd, at + Math.max(.05, dur));
      g.connect(f2); node = f2;
    }
    if (o.pan) { const p = ctx.createStereoPanner(); p.pan.value = o.pan; node.connect(p); node = p; }
    node.connect(this.out);
    for (const cents of o.detune ?? [0]) {
      const osc = ctx.createOscillator(); osc.type = o.type ?? 'sine'; osc.frequency.value = f; osc.detune.value = cents;
      if (o.vibrato) { const lfo = ctx.createOscillator(), depth = ctx.createGain(); lfo.frequency.value = 5.2; depth.gain.setValueAtTime(0, at); depth.gain.linearRampToValueAtTime(f * o.vibrato, at + Math.min(.3, dur)); lfo.connect(depth); depth.connect(osc.frequency); lfo.start(at); lfo.stop(at + dur + release + .05); }
      osc.connect(g); osc.start(at); osc.stop(at + dur + release + .05);
    }
  }
  /** Filtered noise with a frequency sweep (whooshes, taps, grit, wind). */
  hiss(at: number, dur: number, gain: number, type: BiquadFilterType, from: number, to = from, q = 1, pan = 0, attack = .004) {
    const ctx = this.ctx, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noise; src.loop = true; f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(from, at); f.frequency.exponentialRampToValueAtTime(Math.max(30, to), at + dur);
    g.gain.setValueAtTime(.0001, at); g.gain.linearRampToValueAtTime(gain, at + attack); g.gain.exponentialRampToValueAtTime(.0001, at + dur);
    let node: AudioNode = g;
    if (pan) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); node = p; }
    src.connect(f); f.connect(g); node.connect(this.out); src.start(at, (at * 7.13) % .9); src.stop(at + dur + .05);
  }
  /** A pitch glide (calls, whistles). */
  glide(f0: number, f1: number, at: number, dur: number, gain: number, type: OscillatorType = 'sine', vibrato = 0) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(f1, at + dur);
    if (vibrato) { const l = ctx.createOscillator(), d = ctx.createGain(); l.frequency.value = 6; d.gain.value = f0 * vibrato; l.connect(d); d.connect(o.frequency); l.start(at); l.stop(at + dur + .05); }
    g.gain.setValueAtTime(.0001, at); g.gain.linearRampToValueAtTime(gain, at + Math.min(.05, dur * .2)); g.gain.exponentialRampToValueAtTime(.0001, at + dur);
    o.connect(g); g.connect(this.out); o.start(at); o.stop(at + dur + .05);
  }
  bell(f: number, at: number, gain: number, pan = 0) {
    for (const [ratio, level, decay] of [[1, 1, 1.6], [2.76, .35, .7], [5.4, .18, .35]] as const) this.tone(f * ratio, at, .02, gain * level, { attack: .004, release: decay, pan });
  }
  hit(at: number, gain: number, type: 'kick' | 'snare' | 'hat' | 'shaker' | 'tom' | 'crash', pitch = 1) {
    const ctx = this.ctx;
    if (type === 'kick' || type === 'tom') {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      const f0 = type === 'kick' ? 140 : 180 * pitch, f1 = type === 'kick' ? 42 : 80 * pitch, len = type === 'kick' ? .32 : .4;
      osc.frequency.setValueAtTime(f0, at); osc.frequency.exponentialRampToValueAtTime(f1, at + len * .5);
      g.gain.setValueAtTime(gain, at); g.gain.exponentialRampToValueAtTime(.0001, at + len);
      osc.connect(g); g.connect(this.out); osc.start(at); osc.stop(at + len + .02);
      if (type === 'tom') return;
    }
    if (type === 'kick') return;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const band = ctx.createBiquadFilter(), g = ctx.createGain();
    const spec = { snare: ['bandpass', 1900, .9, .2], hat: ['highpass', 7800, .7, .05], shaker: ['bandpass', 5200, 1.2, .07], crash: ['highpass', 5200, .5, 1.6], tom: ['bandpass', 400, 1, .1] }[type] as [BiquadFilterType, number, number, number];
    band.type = spec[0]; band.frequency.value = spec[1]; band.Q.value = spec[2];
    g.gain.setValueAtTime(gain, at); g.gain.exponentialRampToValueAtTime(.0001, at + spec[3]);
    src.connect(band); band.connect(g); g.connect(this.out); src.start(at, Math.random() * .5); src.stop(at + spec[3] + .02);
    if (type === 'snare') this.tone(190, at, .02, gain * .5, { type: 'triangle', attack: .002, release: .1 });
  }
}

async function renderStem(rate: number, seconds: number, build: (v: Voices, ctx: OfflineAudioContext) => void) {
  const tail = 2.5, ctx = new OfflineAudioContext(2, Math.ceil(rate * (seconds + tail)), rate);
  const bus = ctx.createGain(); bus.connect(ctx.destination);
  build(new Voices(ctx, bus), ctx);
  const rendered = await ctx.startRendering();
  // Fold the release tail back onto the start so the loop is seamless.
  const length = Math.round(rate * seconds), out = new AudioBuffer({ numberOfChannels: 2, length, sampleRate: rate });
  for (let ch = 0; ch < 2; ch++) {
    const src = rendered.getChannelData(ch), dst = out.getChannelData(ch);
    for (let i = 0; i < length; i++) dst[i] = src[i];
    for (let i = length; i < src.length; i++) dst[(i - length) % length] += src[i];
  }
  return out;
}

async function renderAll(rate: number) {
  const buffers = new Map<Stem, AudioBuffer>(), stingers = new Map<string, AudioBuffer>();
  const bar = (b: number) => b * 4 * BEAT, beat = (n: number) => n * BEAT;
  const jobs: [Stem, (v: Voices) => void][] = [
    ['pad', v => CHORDS.forEach((chord, b) => chord.forEach((n, i) => v.tone(hz(n) * 2, bar(b), 4 * BEAT, .045, { type: 'sawtooth', attack: .5, release: .9, cutoff: 1300, detune: [-7, 6], pan: (i - 1) * .4 })))],
    ['bells', v => { for (let b = 0; b < BARS; b += 2) { const root = hz(CHORDS[b][0]) * 8; v.bell(root, bar(b), .05, -.3); v.bell(root * 1.5, bar(b) + beat(2.5), .035, .35); v.bell(root * 1.26, bar(b + 1) + beat(1), .03, 0); } }],
    ['bass', v => CHORDS.forEach((chord, b) => { for (let e = 0; e < 8; e++) { const f = hz(chord[0]) / (e === 7 ? 1 : 2) * (e === 6 ? 1.5 : 1); v.tone(f, bar(b) + e * BEAT / 2, BEAT / 2 * .8, .16, { type: 'triangle', attack: .005, release: .12, cutoff: 900, cutoffEnd: 300 }); v.tone(f / 2, bar(b) + e * BEAT / 2, BEAT / 2 * .8, .1, { attack: .005, release: .1 }); } })],
    ['drumsLight', v => { for (let b = 0; b < BARS; b++) { v.hit(bar(b), .7, 'kick'); v.hit(bar(b) + beat(2), .6, 'kick'); if (b % 4 === 3) v.hit(bar(b) + beat(2.5), .45, 'kick'); for (let e = 0; e < 8; e++) v.hit(bar(b) + e * BEAT / 2, e % 2 ? .05 : .08, 'shaker'); } }],
    ['arp', v => CHORDS.forEach((chord, b) => { const tones = [...chord, ...chord.map(n => n.replace(/\d/, d => String(+d + 1)))].map(hz); const order = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 2, 3, 4, 5, 4, 2]; order.forEach((k, s) => v.tone(tones[k] * 2, bar(b) + s * BEAT / 4, BEAT / 4 * .9, .035, { type: 'square', attack: .003, release: .09, cutoff: 3200, cutoffEnd: 700, pan: s % 2 ? .25 : -.25 })); })],
    ['lead', v => LEAD.forEach(([at, n, len]) => v.tone(hz(n), beat(at), beat(len) * .95, .07, { type: 'sawtooth', attack: .03, release: .18, cutoff: 2400, detune: [-4, 5], vibrato: .006 }))],
    ['drumsFull', v => { for (let b = 0; b < BARS; b++) { v.hit(bar(b) + beat(1), .5, 'snare'); v.hit(bar(b) + beat(3), .55, 'snare'); for (let s = 0; s < 16; s++) v.hit(bar(b) + s * BEAT / 4, s % 4 === 0 ? .12 : s % 2 ? .05 : .08, 'hat'); if (b === 0 || b === 4) v.hit(bar(b), .25, 'crash'); }
      for (let s = 0; s < 8; s++) v.hit(bar(7) + beat(2) + s * BEAT / 4, .5, 'tom', 1.4 - s * .08); }],
    ['ostinato', v => CHORDS.forEach((chord, b) => { for (let e = 0; e < 8; e++) v.tone(hz(chord[e % 4 === 3 ? 2 : 0]), bar(b) + e * BEAT / 2, BEAT / 2 * .45, .06, { type: 'sawtooth', attack: .004, release: .06, cutoff: 1600, detune: [-5, 5] }); })],
  ];
  for (const [name, build] of jobs) buffers.set(name, await renderStem(rate, LOOP, build));
  // Victory: a rising fanfare and a held D major chord. Defeat: a gentle fall that resolves to major — encouraging.
  const stinger = async (seconds: number, build: (v: Voices) => void) => { const ctx = new OfflineAudioContext(2, Math.ceil(rate * seconds), rate); const bus = ctx.createGain(); bus.connect(ctx.destination); build(new Voices(ctx, bus)); return ctx.startRendering(); };
  stingers.set('victory', await stinger(3.4, v => { ['D4', 'F#4', 'A4', 'D5'].forEach((n, i) => v.tone(hz(n), i * .14, .3, .09, { type: 'sawtooth', attack: .01, release: .2, cutoff: 2800, detune: [-6, 6] })); ['D4', 'F#4', 'A4', 'D5', 'F#5'].forEach(n => v.tone(hz(n), .6, 1.6, .06, { type: 'sawtooth', attack: .05, release: 1, cutoff: 2600, detune: [-7, 7] })); v.hit(.6, .7, 'kick'); v.hit(.6, .3, 'crash'); v.bell(hz('D6'), .6, .06); v.bell(hz('A6'), .9, .04); }));
  stingers.set('defeat', await stinger(3, v => { ['A4', 'F#4', 'E4', 'D4'].forEach((n, i) => v.tone(hz(n), i * .22, .4, .07, { type: 'triangle', attack: .02, release: .3, cutoff: 2000 })); ['D4', 'F#4', 'A4'].forEach(n => v.tone(hz(n), 1, 1.4, .05, { type: 'sawtooth', attack: .2, release: .9, cutoff: 1500, detune: [-6, 6] })); v.bell(hz('F#5'), 1.1, .04); }));
  stemCache = { rate, buffers, stingers, sfx: await renderSfx(rate) };
}

/** One-shot effects and ambience loops (rendered once; a few variants each so repeats never sound identical). */
async function renderSfx(rate: number) {
  const out = new Map<string, AudioBuffer[]>();
  const one = async (seconds: number, build: (v: Voices) => void) => { const ctx = new OfflineAudioContext(2, Math.ceil(rate * seconds), rate); const bus = ctx.createGain(); bus.connect(ctx.destination); build(new Voices(ctx, bus)); return ctx.startRendering(); };
  const set = async (name: string, variants: number, seconds: number, build: (v: Voices, i: number) => void) => { const list: AudioBuffer[] = []; for (let i = 0; i < variants; i++) list.push(await one(seconds, v => build(v, i))); out.set(name, list); };
  // Footsteps on carved stone: a soft body thump, the heel tap, a little grit; each variant shifts pitch and balance.
  await set('step', 6, .18, (v, i) => { const p = 1 + (i - 2.5) * .045, w = i % 2 ? .9 : 1.05;
    v.tone(105 * p, 0, .025, .55 * w, { attack: .001, release: .07, cutoff: 700 }); v.hiss(.002, .045, .42 * w, 'bandpass', 2100 * p, 950 * p, 1.4); v.hiss(.012, .06, .1, 'highpass', 5600, 3200, .7); });
  await set('land', 2, .5, (v, i) => { const heavy = i === 1;
    v.tone(heavy ? 62 : 85, 0, .04, heavy ? .9 : .6, { attack: .002, release: heavy ? .3 : .16, cutoff: 500 }); v.hiss(0, heavy ? .3 : .18, heavy ? .6 : .4, 'lowpass', 1400, 180, .8);
    v.hiss(.02, .12, heavy ? .3 : .16, 'bandpass', 2400, 1200, 1.5); });
  await set('jump', 3, .35, (v, i) => { v.hiss(0, .26, .34, 'bandpass', 380 + i * 40, 1900 + i * 120, 1.6, 0, .02); v.hiss(0, .06, .2, 'highpass', 3000, 2000, .8); });
  await set('dodge', 2, .4, (v, i) => { const s = i ? -1 : 1; v.hiss(0, .3, .38, 'bandpass', 700, 2600, 2.2, -.6 * s, .015); v.hiss(.12, .2, .22, 'bandpass', 2400, 900, 2, .6 * s); });
  await set('sprint', 1, .7, v => { v.hiss(0, .62, .28, 'lowpass', 300, 1800, .9, 0, .2); v.hiss(.05, .5, .12, 'highpass', 2500, 5000, .6, 0, .15); });
  await set('dash', 2, .55, (v, i) => { v.hiss(0, .32, .5, 'bandpass', 280, 3600, 1.8, 0, .008); v.tone(1800 + i * 200, 0, .02, .12, { attack: .001, release: .05 }); v.bell(hz('A6'), .06, .05); v.hiss(.18, .3, .1, 'highpass', 6000, 9000, .5); });
  // Echo Rush: Echo's call — a gliding whale-song rise over bells and a breath of wind.
  await set('rush', 1, 1.6, v => { v.glide(220, 660, 0, .7, .16, 'sine', .015); v.glide(330, 990, .05, .65, .07, 'triangle', .01); ['D5', 'A5', 'D6', 'F#6'].forEach((n, k) => v.bell(hz(n), .25 + k * .09, .05, (k - 1.5) * .3)); v.hiss(0, 1.1, .2, 'bandpass', 300, 2600, 1.2, 0, .3); });
  await set('knock', 3, .5, (v, i) => { v.tone(70 + i * 8, 0, .03, .95, { attack: .001, release: .22, cutoff: 600 }); v.hiss(0, .14, .6, 'bandpass', 900 + i * 200, 400, 1.3); v.hiss(.01, .09, .3, 'bandpass', 2800, 1800, 2); });
  await set('fall', 1, 1.2, v => { v.glide(1400, 260, 0, 1.0, .1, 'sine'); v.hiss(0, 1.1, .3, 'bandpass', 900, 260, .9, 0, .1); });
  await set('respawn', 1, 1.3, v => { ['D5', 'F#5', 'A5', 'D6', 'A6'].forEach((n, k) => v.bell(hz(n), k * .07, .06, (k - 2) * .25)); v.hiss(.1, .9, .1, 'highpass', 5000, 9000, .6, 0, .2); });
  await set('sill', 1, .7, v => { v.tone(55, 0, .05, 1, { attack: .002, release: .35, cutoff: 400 }); v.hiss(0, .4, .55, 'lowpass', 700, 120, 1); v.hiss(.05, .3, .2, 'bandpass', 1500, 600, 1.4); });
  await set('rise', 1, 1.6, v => { v.hiss(0, 1.5, .45, 'lowpass', 220, 420, 1.5, 0, .2); v.tone(46, 0, 1.2, .35, { attack: .2, release: .4 }); for (let k = 0; k < 10; k++) v.hiss(.1 + k * .13, .08, .18, 'bandpass', 600 + (k % 3) * 200, 400, 2); });
  await set('swoosh', 3, .6, (v, i) => { v.hiss(0, .42, .55, 'bandpass', 180 + i * 30, 950, 1.7, 0, .12); v.hiss(.18, .3, .25, 'bandpass', 900, 220, 1.5); });
  await set('whistle', 2, 1.0, (v, i) => { v.glide(2300 - i * 200, 700, 0, .85, .07, 'sine'); v.hiss(0, .9, .12, 'bandpass', 3000, 800, 3, 0, .4); });
  await set('boom', 2, .9, (v, i) => { v.tone(48 + i * 6, 0, .06, 1, { attack: .002, release: .5, cutoff: 300 }); v.hiss(0, .5, .7, 'lowpass', 1600, 120, .9); v.hiss(.02, .25, .3, 'bandpass', 3000, 1500, 1.8); });
  await set('hazard-1', 1, 1.0, v => { v.hiss(0, .8, .3, 'bandpass', 160, 700, 1.4, 0, .25); for (let k = 0; k < 4; k++) v.tone(320 - k * 30, .1 + k * .17, .06, .05, { type: 'sawtooth', attack: .01, release: .08, cutoff: 900 }); });
  await set('hazard-2', 1, 1.0, v => { for (let k = 0; k < 6; k++) v.hiss(k * .12, .07, .22, 'bandpass', 1300 - k * 80, 900, 4); v.tone(90, 0, .6, .2, { attack: .1, release: .3 }); });
  await set('hazard-3', 1, 1.2, v => { v.hiss(0, 1.1, .5, 'lowpass', 120, 260, 1.2, 0, .3); v.tone(40, 0, .9, .4, { attack: .3, release: .3 }); });
  await set('hazard-4', 1, 1.0, v => { v.glide(2600, 900, 0, .9, .05); v.hiss(.5, .45, .3, 'lowpass', 1200, 100, .9); });
  await set('hazard-5', 1, 1.3, v => { v.hiss(0, 1.2, .35, 'bandpass', 300, 900, .6, 0, .5); v.hiss(.3, .9, .15, 'bandpass', 900, 400, .8, 0, .3); });
  // Course version 6 obstacles and pickups.
  await set('hazard-6', 1, 1.0, v => { v.glide(900, 2400, 0, .7, .05, 'sawtooth'); v.hiss(0, .8, .2, 'bandpass', 2400, 4200, 4, 0, .1); });
  await set('hazard-7', 1, 1.1, v => { v.tone(44, 0, .07, .9, { attack: .002, release: .4, cutoff: 320 }); v.hiss(0, .5, .5, 'lowpass', 900, 120, 1); v.tone(44, .45, .07, .7, { attack: .002, release: .4, cutoff: 320 }); });
  await set('hazard-8', 1, 1.3, v => { v.hiss(0, 1.2, .4, 'bandpass', 260, 1400, .7, -.4, .4); v.hiss(.3, .9, .25, 'bandpass', 1400, 500, .8, .4, .3); });
  await set('hazard-9', 1, 1.0, v => { for (let k = 0; k < 5; k++) v.hiss(k * .15, .08, .3, 'bandpass', 3000 - k * 300, 1600, 3); v.tone(70, .6, .3, .3, { attack: .01, release: .25 }); });
  await set('hazard-10', 1, 1.2, v => { v.glide(180, 260, 0, 1.0, .12, 'sine', .02); ['D5', 'A5'].forEach((n, k) => v.bell(hz(n), .2 + k * .25, .04)); });
  // Version 7: the wind over a narrow beam, stepping-stone chimes, a leaning road's groan, a turning roller's creak.
  await set('hazard-11', 1, 1.3, v => { v.hiss(0, 1.2, .45, 'bandpass', 500, 2200, 1.4, -.3, .4); v.glide(1400, 2100, .1, .9, .03, 'sine', .01); });
  await set('hazard-12', 1, 1.1, v => { ['E5', 'B5', 'E6'].forEach((n, k) => v.bell(hz(n), k * .18, .05)); v.tone(110, 0, .5, .12, { attack: .05, release: .3 }); });
  await set('hazard-13', 1, 1.3, v => { v.glide(140, 70, 0, 1.1, .3, 'sawtooth', .02); v.hiss(.1, 1.0, .3, 'lowpass', 500, 160, .9, 0, .3); });
  await set('hazard-14', 1, 1.3, v => { for (let k = 0; k < 5; k++) { v.tone(120 + (k % 2) * 25, k * .22, .14, .22, { type: 'sawtooth', attack: .02, release: .1, cutoff: 700 }); v.hiss(k * .22 + .1, .05, .25, 'bandpass', 1800, 1200, 4); } });
  await set('slam', 3, .7, (v, i) => { v.tone(40 + i * 5, 0, .05, 1, { attack: .001, release: .45, cutoff: 260 }); v.hiss(0, .35, .65, 'lowpass', 1600, 140, .9); v.hiss(.01, .12, .35, 'bandpass', 2600, 1200, 2.2); });
  await set('gust', 2, 1.4, (v, i) => { v.hiss(0, 1.3, .55, 'bandpass', 220 + i * 60, 1300, .8, i ? .5 : -.5, .35); v.hiss(.2, 1.0, .2, 'highpass', 2600, 4800, .6, i ? .6 : -.6, .3); });
  await set('crack', 3, .45, (v, i) => { for (let k = 0; k < 4; k++) v.hiss(k * .05 + i * .01, .04, .5, 'bandpass', 3800 - k * 400, 2200, 5); v.tone(140, 0, .05, .3, { attack: .001, release: .1 }); });
  await set('crumble', 2, .9, (v, i) => { v.hiss(0, .8, .55, 'lowpass', 1300, 160, .9, 0, .02); for (let k = 0; k < 6; k++) v.hiss(.05 + k * .11, .07, .25, 'bandpass', 1800 + i * 200, 900, 2.5); });
  await set('shutter', 2, .6, (v, i) => { v.tone(220 + i * 30, 0, .03, .35, { type: 'square', attack: .001, release: .12, cutoff: 1800 }); v.hiss(0, .3, .4, 'bandpass', 2000, 700, 2); v.tone(110, .08, .05, .5, { attack: .001, release: .25, cutoff: 500 }); });
  await set('wall-hit', 2, .8, (v, i) => { v.tone(52 + i * 6, 0, .06, 1, { attack: .001, release: .5, cutoff: 280 }); v.hiss(0, .45, .6, 'lowpass', 900, 100, .9); v.hiss(.02, .2, .25, 'bandpass', 1800, 700, 1.8); });
  await set('orb-speed', 1, .9, v => { v.glide(500, 1600, 0, .45, .14, 'triangle'); v.hiss(0, .6, .25, 'bandpass', 600, 4200, 1.4, 0, .05); v.bell(hz('E6'), .3, .05); });
  await set('orb-energy', 1, 1.0, v => { ['D6', 'F#6', 'A6', 'D7'].forEach((n, k) => v.bell(hz(n), k * .06, .055, (k - 1.5) * .3)); v.glide(330, 660, 0, .5, .06, 'sine', .01); });
  await set('orb-guard', 1, 1.1, v => { v.tone(hz('D4'), 0, .8, .14, { type: 'triangle', attack: .02, release: .5, cutoff: 2400 }); v.tone(hz('A4'), .05, .75, .1, { type: 'triangle', attack: .02, release: .5, cutoff: 2400 }); v.bell(hz('D6'), .1, .05); v.hiss(0, .7, .1, 'highpass', 5000, 9000, .5, 0, .2); });
  await set('shield', 2, .7, (v, i) => { v.tone(1200 + i * 150, 0, .03, .25, { type: 'triangle', attack: .001, release: .35 }); v.bell(hz('B5'), .02, .06); v.hiss(0, .3, .35, 'bandpass', 3200, 1400, 2.4); });
  await set('deny', 1, .2, v => { v.tone(190, 0, .035, .22, { type: 'triangle', attack: .002, release: .03 }); v.tone(160, .07, .035, .22, { type: 'triangle', attack: .002, release: .03 }); });
  await set('ready', 1, .5, v => { v.bell(hz('E6'), 0, .05); v.bell(hz('B6'), .06, .035); });
  // Ambience loops (seamless by folding their tails like the score stems).
  const loop = async (name: string, seconds: number, build: (v: Voices) => void) => out.set(name, [await renderStem(rate, seconds, build)]);
  await loop('rumble', 1.6, v => { for (let k = 0; k < 8; k++) v.hiss(k * .2, .35, .45, 'lowpass', 140, 200, 1.5, 0, .1); v.tone(42, 0, 1.6, .25, { attack: .2, release: .2 }); });
  await loop('wind', 3.2, v => { v.hiss(0, 1.8, .3, 'bandpass', 380, 900, .6, -.3, .6); v.hiss(1.4, 1.8, .26, 'bandpass', 900, 420, .6, .3, .6); });
  await loop('grind', 1.2, v => { for (let k = 0; k < 9; k++) v.hiss(k * .133, .12, .3, 'lowpass', 380, 300, 2); v.tone(48, 0, 1.2, .3, { attack: .1, release: .1 }); });
  // Saw blades: a metallic whine with a gritty bite; drifting stones: a low rune hum with a slow shimmer.
  await loop('saw', 1.0, v => { v.tone(820, 0, 1.0, .05, { type: 'sawtooth', attack: .05, release: .05, cutoff: 3200, detune: [-14, 14] }); v.tone(1640, 0, 1.0, .02, { type: 'square', attack: .05, release: .05, cutoff: 5200 }); for (let k = 0; k < 10; k++) v.hiss(k * .1, .06, .1, 'bandpass', 5200, 4200, 4); });
  await loop('hum', 2.4, v => { v.tone(98, 0, 2.4, .2, { attack: .3, release: .3, vibrato: .01 }); v.tone(147, 0, 2.4, .08, { type: 'triangle', attack: .4, release: .4, vibrato: .015 }); v.hiss(0, 2.2, .06, 'bandpass', 1800, 2600, 2, 0, .6); });
  return out;
}

export class RushAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private effects: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private analyser: AnalyserNode | null = null;
  private stemGains = new Map<Stem, GainNode>();
  private bed: AudioBufferSourceNode[] = [];
  private bedNodes: AudioNode[] = [];
  private voices = new Set<AudioScheduledSourceNode>();
  private lastEvent = new Map<RushSound, number>();
  private noise: AudioBuffer | null = null;
  private scene: Scene = 'off';
  private mood: RushMood = { streak: 0, tension: false, finale: false, close: false, rush: false };
  private paused = false;
  private duckUntil = 0;
  private ambiences = new Map<RushAmbience, { src: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode }>();
  private prefs: Preferences = RushAudio.preference();

  static preference(): Preferences {
    if (typeof window === 'undefined') return defaults;
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Partial<Preferences>;
      const level = (v: unknown, d: number) => Number.isFinite(v) ? Math.max(0, Math.min(1, v as number)) : d;
      return { muted: typeof value.muted === 'boolean' ? value.muted : defaults.muted, volume: level(value.volume, defaults.volume), music: level(value.music, defaults.music), effects: level(value.effects, defaults.effects) };
    } catch { return defaults; }
  }
  get muted() { return this.prefs.muted; }
  set muted(value: boolean) { this.setMuted(value); }
  get volume() { return this.prefs.volume; }
  set volume(value: number) { this.setVolume(value); }

  snapshot() {
    let output = 0;
    if (this.analyser) { const samples = new Float32Array(this.analyser.fftSize); this.analyser.getFloatTimeDomainData(samples); output = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length); }
    return { ...this.prefs, state: this.context?.state ?? 'locked', active: this.scene === 'race' || this.scene === 'countdown', paused: this.paused, output, nodes: this.bed.length, scene: this.scene };
  }
  setMuted(value: boolean) { this.prefs.muted = value; this.persist(); this.applyMix(); }
  setVolume(value: number) { this.prefs.volume = Math.max(0, Math.min(1, value)); this.persist(); this.applyMix(); }
  /** Separate levels for the score and the sound effects (persisted with mute and the master volume). */
  setMusic(value: number) { this.prefs.music = Math.max(0, Math.min(1, value)); this.persist(); this.applyMix(); }
  setEffects(value: number) { this.prefs.effects = Math.max(0, Math.min(1, value)); this.persist(); this.applyMix(); }
  private persist() { try { localStorage.setItem(STORAGE, JSON.stringify(this.prefs)); } catch { /* private mode */ } }

  /** Call inside a user gesture. Renders the score once per page (≈ a few hundred ms, off the gesture path). */
  async unlock() {
    this.context ??= new AudioContext();
    if (!this.master) this.buildGraph();
    await this.context.resume().catch(() => {});
    const rate = scoreRate(this.context.sampleRate);
    if (!stemCache || stemCache.rate !== rate) { rendering ??= renderAll(rate).finally(() => { rendering = null; }); }
    void rendering?.then(() => { if (this.context && this.scene !== 'off') this.ensureBed(); });
    this.applyMix();
    return this.context.state === 'running';
  }

  /** Preparation music for the lobby (needs a prior unlock from a gesture). */
  lobby() { this.scene = 'lobby'; this.paused = false; this.ensureBed(); this.applyMix(); }
  startRace() { this.scene = 'countdown'; this.paused = false; this.ensureBed(); this.applyMix(); }
  /** Countdown over: the run layers come in. */
  go() { if (this.scene === 'countdown') { this.scene = 'race'; this.applyMix(); } }
  setMood(mood: Partial<RushMood>) {
    const next = { ...this.mood, ...mood };
    if (JSON.stringify(next) === JSON.stringify(this.mood)) return;
    this.mood = next; this.applyMix();
  }
  pause() { this.paused = true; this.applyMix(); }
  resume() { this.paused = false; this.applyMix(); }
  /** Results: the score settles back to preparation colours after the stinger. */
  results() { this.scene = 'results'; this.paused = false; this.mood = { streak: 0, tension: false, finale: false, close: false, rush: false }; this.ensureBed(); this.applyMix(); }
  stopRace() { this.scene = 'off'; this.paused = false; this.stopBed(); this.stopAmbience(); this.applyMix(); }

  private stopBed() {
    for (const node of this.bed) { try { node.stop(); } catch { /* already stopped */ } }
    for (const node of this.bedNodes) { try { node.disconnect(); } catch { /* detached */ } }
    this.bed = []; this.bedNodes = [];
  }

  private buildGraph() {
    const ctx = this.context!;
    this.master = ctx.createGain(); this.music = ctx.createGain(); this.effects = ctx.createGain();
    this.musicFilter = ctx.createBiquadFilter(); this.musicFilter.type = 'lowpass'; this.musicFilter.frequency.value = 18000; this.musicFilter.Q.value = .5;
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 256;
    // Small generated hall for depth (no impulse download).
    this.reverb = ctx.createConvolver();
    const ir = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * 2.2), ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3.2) * .35; }
    this.reverb.buffer = ir;
    const send = ctx.createGain(); send.gain.value = .22;
    const protection = ctx.createDynamicsCompressor();
    protection.threshold.value = -10; protection.knee.value = 8; protection.ratio.value = 4; protection.attack.value = .004; protection.release.value = .18;
    const highpass = ctx.createBiquadFilter(); highpass.type = 'highpass'; highpass.frequency.value = 30;
    this.master.gain.value = 0; this.music.gain.value = 0; this.effects.gain.value = .8;
    this.music.connect(this.musicFilter); this.musicFilter.connect(this.master); this.musicFilter.connect(send);
    this.effects.connect(this.master); this.effects.connect(send); send.connect(this.reverb); this.reverb.connect(this.master);
    this.master.connect(highpass); highpass.connect(protection); protection.connect(this.analyser); this.analyser.connect(ctx.destination);
    for (const stem of STEMS) { const g = ctx.createGain(); g.gain.value = 0; g.connect(this.music); this.stemGains.set(stem, g); }
    this.noise = noiseBuffer(ctx, 1.5);
    this.applyMix();
  }

  private ensureBed() {
    const ctx = this.context;
    if (!ctx || !stemCache || stemCache.rate !== scoreRate(ctx.sampleRate) || this.bed.length) return;
    // One shared start time keeps every stem sample-aligned for the whole session.
    const at = ctx.currentTime + .05;
    for (const stem of STEMS) {
      const src = ctx.createBufferSource(); src.buffer = stemCache.buffers.get(stem)!; src.loop = true;
      src.connect(this.stemGains.get(stem)!); src.start(at);
      this.bed.push(src); this.bedNodes.push(src);
    }
    this.applyMix();
  }

  private levels(): Record<Stem, number> {
    const m = this.mood, s = this.scene;
    const zero = { pad: 0, bells: 0, bass: 0, drumsLight: 0, arp: 0, lead: 0, drumsFull: 0, ostinato: 0 };
    if (s === 'off') return zero;
    if (s === 'lobby' || s === 'results') return { ...zero, pad: .75, bells: .7, arp: s === 'results' ? .25 : 0, bass: s === 'results' ? .35 : 0 };
    if (s === 'countdown') return { ...zero, pad: .7, bells: .5, ostinato: .55, drumsLight: .25 };
    const heroic = m.finale || m.rush || m.close || m.streak >= 4, momentum = heroic || m.streak >= 2;
    return {
      pad: m.finale ? .55 : .5, bells: .35, bass: .85, drumsLight: .85,
      arp: momentum ? (m.tension ? .35 : .7) : 0,
      lead: heroic ? (m.tension && !m.finale ? .3 : .8) : 0,
      drumsFull: m.finale ? 1 : heroic ? .7 : 0,
      ostinato: m.tension || m.finale ? .85 : m.close ? .4 : 0,
    };
  }

  private applyMix() {
    const ctx = this.context;
    if (!ctx || !this.master || !this.music || !this.effects) return;
    const at = ctx.currentTime;
    this.master.gain.setTargetAtTime(this.prefs.muted ? 0 : this.prefs.volume, at, .03);
    const ducked = at < this.duckUntil ? .35 : 1;
    this.music.gain.setTargetAtTime((this.paused ? .1 : .9 * ducked) * this.prefs.music, at, this.paused ? .15 : .25);
    this.effects.gain.setTargetAtTime((this.paused ? .35 : 1) * this.prefs.effects, at, .04);
    // Tension narrows the score a little (a held breath) without changing loudness.
    this.musicFilter?.frequency.setTargetAtTime(this.mood.tension && !this.mood.finale && this.scene === 'race' ? 5200 : 18000, at, .35);
    const levels = this.levels();
    for (const stem of STEMS) this.stemGains.get(stem)?.gain.setTargetAtTime(levels[stem], at, .6);
  }

  private duck(seconds: number) {
    if (!this.context) return;
    this.duckUntil = this.context.currentTime + seconds; this.applyMix();
    setTimeout(() => this.applyMix(), seconds * 1000 + 30);
  }

  private track(node: AudioScheduledSourceNode, ...chain: AudioNode[]) {
    this.voices.add(node);
    node.onended = () => { this.voices.delete(node); for (const n of [node, ...chain]) { try { n.disconnect(); } catch { /* detached */ } } };
  }
  private tone(f: number, at: number, duration: number, level: number, type: OscillatorType = 'sine', endHz?: number, pan = 0) {
    const ctx = this.context;
    if (!ctx || !this.effects || this.voices.size >= 24) return;
    const osc = ctx.createOscillator(), gain = ctx.createGain(), panner = ctx.createStereoPanner();
    osc.type = type; osc.frequency.setValueAtTime(f, at);
    if (endHz) osc.frequency.exponentialRampToValueAtTime(Math.max(20, endHz), at + duration);
    gain.gain.setValueAtTime(.0001, at); gain.gain.linearRampToValueAtTime(level, at + Math.min(.012, duration * .2));
    gain.gain.exponentialRampToValueAtTime(.0001, at + duration); panner.pan.value = pan;
    osc.connect(gain); gain.connect(panner); panner.connect(this.effects); osc.start(at); osc.stop(at + duration + .03);
    this.track(osc, gain, panner);
  }
  private noiseBurst(at: number, duration: number, level: number, type: BiquadFilterType, from: number, to = from, q = 1, pan = 0) {
    const ctx = this.context;
    if (!ctx || !this.effects || !this.noise || this.voices.size >= 24) return;
    const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain(), panner = ctx.createStereoPanner();
    src.buffer = this.noise; filter.type = type; filter.Q.value = q;
    filter.frequency.setValueAtTime(from, at); filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), at + duration);
    gain.gain.setValueAtTime(.0001, at); gain.gain.linearRampToValueAtTime(level, at + Math.min(.03, duration * .3)); gain.gain.exponentialRampToValueAtTime(.0001, at + duration);
    panner.pan.value = pan;
    src.connect(filter); filter.connect(gain); gain.connect(panner); panner.connect(this.effects); src.start(at, Math.random() * .4); src.stop(at + duration + .03);
    this.track(src, filter, gain, panner);
  }
  private stinger(name: 'victory' | 'defeat') {
    const ctx = this.context, buffer = stemCache?.stingers.get(name);
    if (!ctx || !buffer || !this.effects) return false;
    const src = ctx.createBufferSource(), gain = ctx.createGain(); gain.gain.value = 1.1;
    src.buffer = buffer; src.connect(gain); gain.connect(this.effects); src.start(); this.track(src, gain);
    this.duck(buffer.duration * .8);
    return true;
  }

  /** Play a rendered effect: a random variant, slight pitch variation, placed in the stereo field. */
  private sample(name: string, gain: number, pan = 0, rate = 1, variant = -1) {
    const ctx = this.context, list = stemCache?.sfx.get(name);
    if (!ctx || !list?.length || !this.effects || this.voices.size >= 24) return false;
    const src = ctx.createBufferSource(), g = ctx.createGain(), p = ctx.createStereoPanner();
    src.buffer = list[variant >= 0 ? variant % list.length : Math.floor(Math.random() * list.length)];
    src.playbackRate.value = rate * (1 + (Math.random() - .5) * .06);
    g.gain.value = gain; p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g); g.connect(p); p.connect(this.effects); src.start(); this.track(src, g, p);
    return true;
  }
  /**
   * World sounds from the race: footsteps at foot contacts (value = pace), take-off / landing (value = strength),
   * obstacles and the rising gate. Cooldowns keep rapid repeats from stacking into noise.
   */
  world(kind: RushWorldSound, value = 1, pan = 0) {
    const ctx = this.context;
    if (this.prefs.muted || !ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime, key = ('w:' + kind) as RushSound;
    const cooldown = kind === 'footstep' ? .07 : kind === 'swoosh' ? .25 : kind === 'land' ? .12 : kind === 'slam' || kind === 'crack' || kind === 'shutter' ? .18 : kind === 'gust' ? .8 : .06;
    if (now - (this.lastEvent.get(key) ?? -Infinity) < cooldown) return;
    this.lastEvent.set(key, now);
    switch (kind) {
      case 'footstep': this.sample('step', .1 + .14 * value, pan, .92 + value * .16); return;
      case 'jump': this.sample('jump', .32, pan); return;
      case 'land': this.sample('land', .22 + .4 * value, pan, 1, value > .8 ? 1 : 0); return;
      case 'dodge': this.sample('dodge', .42, pan, 1, pan < 0 ? 1 : 0); return;
      case 'sprint': this.sample('sprint', .3, 0); return;
      case 'knock': this.sample('knock', .62, pan); this.duck(.45); return;
      case 'fall': this.sample('fall', .45, pan); this.duck(.8); return;
      case 'respawn': this.sample('respawn', .4, 0); return;
      case 'sill': this.sample('sill', .6, pan); return;
      case 'rise': this.sample('rise', value > 1 ? .5 : .35, 0); return;
      case 'hazard': this.sample(`hazard-${Math.round(value)}`, .32, 0); return;
      case 'swoosh': this.sample('swoosh', .2 + .45 * value, pan); return;
      case 'whistle': this.sample('whistle', .12 + .3 * value, pan); return;
      case 'boom': this.sample('boom', .2 + .55 * value, pan); if (value > .6) this.duck(.3); return;
      case 'dash': if (!this.sample('dash', .55, pan)) this.play('dash'); return;
      case 'rush': if (!this.sample('rush', .6, 0)) this.play('rush'); this.duck(.9); return;
      case 'gate-open': case 'gate-pass': case 'near-gate': this.play(kind); return;
      case 'slam': this.sample('slam', .25 + .5 * value, pan); if (value > .7) this.duck(.25); return;
      case 'gust': this.sample('gust', .2 + .4 * value, pan, 1, pan < 0 ? 0 : 1); return;
      case 'crack': this.sample('crack', .15 + .35 * value, pan); return;
      case 'crumble': this.sample('crumble', .2 + .4 * value, pan); return;
      case 'shutter': this.sample('shutter', .15 + .35 * value, pan); return;
      case 'wall-hit': case 'bump': this.sample('wall-hit', kind === 'bump' ? .45 : .6, pan); this.duck(.3); return;
      case 'orb-speed': case 'orb-energy': case 'orb-guard': this.sample(kind, .55, pan); return;
      case 'shield': this.sample('shield', .6, pan); return;
      default: return;
    }
  }
  /** Continuous obstacle ambience (boulder rumble, chasm wind, rising-gate grind): level 0..1, panned, smoothed. */
  ambience(kind: RushAmbience, level: number, pan = 0) {
    const ctx = this.context, buffer = stemCache?.sfx.get(kind)?.[0];
    if (!ctx || !buffer || !this.effects) return;
    let a = this.ambiences.get(kind);
    if (!a && level <= .001) return;
    if (!a) {
      const src = ctx.createBufferSource(), gain = ctx.createGain(), p = ctx.createStereoPanner();
      src.buffer = buffer; src.loop = true; gain.gain.value = 0; src.connect(gain); gain.connect(p); p.connect(this.effects); src.start();
      a = { src, gain, pan: p }; this.ambiences.set(kind, a);
    }
    const peak = kind === 'rumble' ? .55 : kind === 'grind' ? .4 : kind === 'saw' ? .18 : kind === 'hum' ? .3 : .22;
    a.gain.gain.setTargetAtTime(this.prefs.muted || this.paused ? 0 : Math.max(0, Math.min(1, level)) * peak, ctx.currentTime, .12);
    a.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), ctx.currentTime, .1);
  }
  private stopAmbience() {
    for (const a of this.ambiences.values()) { try { a.src.stop(); } catch { /* stopped */ } for (const n of [a.src, a.gain, a.pan]) { try { n.disconnect(); } catch { /* detached */ } } }
    this.ambiences.clear();
  }

  /** `level` lets combo cues climb with the streak. */
  play(kind: RushSound, level = 0) {
    const ctx = this.context;
    if (this.prefs.muted || !ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const cooldown = kind === 'footstep' ? .2 : kind === 'near-gate' ? 1.5 : .09;
    if (now - (this.lastEvent.get(kind) ?? -Infinity) < cooldown) return;
    this.lastEvent.set(kind, now);
    const at = now + .01, D = (n: string) => hz(n);
    switch (kind) {
      case 'footstep': { const pan = (Math.random() - .5) * .3; this.noiseBurst(at, .07, .05, 'lowpass', 900, 300, .8, pan); this.tone(95 + Math.random() * 20, at, .05, .03, 'sine', 60, pan); return; }
      case 'gate-open': this.noiseBurst(at, .7, .07, 'lowpass', 500, 90, 1.2); [D('D6'), D('F#6'), D('A6')].forEach((f, i) => this.tone(f, at + i * .05, .9, .035, 'sine', undefined, (i - 1) * .3)); return;
      case 'gate-pass': this.noiseBurst(at, .35, .045, 'bandpass', 600, 2400, 1.4); return;
      case 'correct': this.tone(D('A5'), at, .16, .06, 'triangle'); this.tone(D('D6'), at + .08, .36, .07, 'triangle'); this.noiseBurst(at + .05, .4, .03, 'highpass', 6000, 9000, .7); return;
      case 'combo': { const scale = ['D5', 'E5', 'F#5', 'A5', 'B5', 'D6', 'E6']; const f = D(scale[Math.min(scale.length - 1, Math.max(0, level - 1))]); this.tone(f, at, .25, .05, 'square'); this.tone(f * 1.5, at + .06, .3, .035, 'triangle'); return; }
      case 'wrong': this.tone(92, at, .32, .16, 'sine', 48); this.tone(D('A#3'), at + .02, .22, .035, 'triangle', D('A3')); this.noiseBurst(at, .25, .06, 'lowpass', 700, 150, 1); return;
      case 'post': this.tone(80, at, .26, .14, 'sine', 45); this.noiseBurst(at, .18, .05, 'lowpass', 600, 120, 1); return;
      case 'dash': this.noiseBurst(at, .38, .1, 'bandpass', 350, 2600, 1.6); this.tone(D('A4'), at, .2, .025, 'sine', D('A5')); return;
      case 'rush': this.noiseBurst(at, .6, .1, 'bandpass', 300, 3200, 1.4); [D('D5'), D('A5'), D('D6')].forEach((f, i) => this.tone(f, at + i * .07, .5, .04, 'triangle')); return;
      case 'overtake': this.noiseBurst(at, .3, .06, 'bandpass', 900, 3000, 2, .4); this.tone(D('E6'), at + .1, .2, .035, 'sine'); return;
      case 'near-gate': this.noiseBurst(at, 1.3, .045, 'bandpass', 220, 2000, 2.5); this.tone(D('D2'), at, 1.2, .05, 'sine'); return;
      case 'count': this.tone(D('A5'), at, .18, .06, 'triangle'); return;
      case 'go': [D('D5'), D('F#5'), D('A5'), D('D6')].forEach((f, i) => this.tone(f, at, .5, .04 + i * .005, 'triangle')); this.noiseBurst(at, .5, .05, 'highpass', 4000, 8000, .7); return;
      case 'finish': if (!this.stinger('victory')) [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, at + i * .09, .4, .05, 'triangle')); return;
      case 'victory': this.stinger('victory'); return;
      case 'defeat': this.stinger('defeat'); return;
      case 'start': [D('D5'), D('F#5'), D('A5')].forEach((f, i) => this.tone(f, at + i * .08, .22, .045, 'triangle')); return;
      case 'ui': this.tone(D('D6'), at, .06, .025, 'sine'); return;
      case 'deny': if (!this.sample('deny', .35)) this.tone(170, at, .06, .05, 'triangle'); return;
      case 'ready': if (!this.sample('ready', .3)) this.tone(D('E6'), at, .2, .03, 'sine'); return;
      case 'ice': [1174.66, 880, 587.33].forEach((f, i) => this.tone(f, at + i * .07, .18, .03, 'sine')); return;
      case 'snare': [220, 196, 146.83].forEach((f, i) => this.tone(f, at + i * .07, .18, .03, 'sine')); return;
      case 'swap': [392, 783.99, 392].forEach((f, i) => this.tone(f, at + i * .07, .18, .03, 'sine')); return;
    }
  }

  dispose() {
    this.stopBed(); this.stopAmbience();
    for (const voice of this.voices) { try { voice.stop(); voice.disconnect(); } catch { /* ended */ } }
    this.voices.clear(); this.lastEvent.clear(); this.stemGains.clear();
    void this.context?.close();
    this.context = null; this.master = this.music = this.effects = null; this.musicFilter = null; this.reverb = null; this.analyser = null; this.noise = null;
  }
}
