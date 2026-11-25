/**
 * What touching a thing sounds like. Made here, from a press, never a file and never before a gesture: a short filtered
 * noise for the contact and a decaying resonance for what the material does. Bounded voices; it stays quiet and it stays out
 * of the way of studying.
 */
export type ContactMaterial = 'wood' | 'metal' | 'glass' | 'ceramic' | 'paper' | 'cloth' | 'plastic';

const MODES: Record<ContactMaterial, { noise: [number, number]; ring: number[]; decay: number; level: number }> = {
  wood: { noise: [620, .9], ring: [190, 410], decay: .09, level: .85 },
  metal: { noise: [2600, 1.6], ring: [1180, 2870], decay: .16, level: .55 },
  glass: { noise: [3400, 2.2], ring: [2240, 4310], decay: .2, level: .42 },
  ceramic: { noise: [1900, 1.5], ring: [1040, 2410], decay: .11, level: .6 },
  paper: { noise: [3800, .6], ring: [], decay: .07, level: .5 },
  cloth: { noise: [900, .4], ring: [], decay: .09, level: .36 },
  plastic: { noise: [1500, 1], ring: [720], decay: .06, level: .55 },
};

let context: AudioContext | null = null;
let voices = 0;
let noise: AudioBuffer | null = null;
let externalSink: AudioNode | null = null;
const activeScrapes = new Set<Scrape>();

function resolveSink(c: AudioContext, explicit?: AudioNode): AudioNode {
  if (explicit) return explicit;
  if (externalSink && (externalSink.context === undefined || externalSink.context === c)) {
    return externalSink;
  }
  return c.destination;
}

function connectToSink(node: AudioNode, c: AudioContext, explicit?: AudioNode): AudioNode {
  const target = resolveSink(c, explicit);
  try {
    node.connect(target);
    return target;
  } catch {
    if (target !== c.destination) {
      try { node.connect(c.destination); } catch { /* already closed */ }
    }
    return c.destination;
  }
}

/** Route contact/foley audio through an external mixer bus (e.g. Echo Life foleyGain) or reset to context destination. */
export function setContactAudioSink(node: AudioNode | null): void {
  externalSink = node;
  for (const scrape of activeScrapes) {
    scrape.reconnectSink();
  }
}

/** Return the currently attached external audio sink, if any. */
export function getContactAudioSink(): AudioNode | null {
  return externalSink;
}

function audio(resume = true) {
  if (typeof window === 'undefined' || document.hidden) return null;
  try {
    context ??= new AudioContext();
    if (resume && context.state === 'suspended') void context.resume();
    if (!noise) {
      noise = context.createBuffer(1, Math.floor(context.sampleRate * .3), context.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return context;
  } catch { return null; }
}

/** Allocate the device and noise buffer while the room loads. No source is started. */
export function contactAudioContext() { return audio(); }
export function prepareContactAudio() { if (!context) audio(false); }

/** `strength` 0..1 is how hard; `distance` in metres from the ears. */
export function contactSound(material: ContactMaterial, strength = .5, distance = .6) {
  if (voices >= 6) return;
  const c = audio();
  if (!c || !noise) return;
  const m = MODES[material], now = c.currentTime;
  const level = m.level * (.25 + .75 * Math.min(1, strength)) * .11 / (1 + distance * distance * .5);
  voices++;
  const out = c.createGain();
  out.gain.value = level;
  connectToSink(out, c);
  const src = c.createBufferSource(), band = c.createBiquadFilter(), env = c.createGain();
  src.buffer = noise;
  src.playbackRate.value = .85 + Math.random() * .3;
  band.type = 'bandpass'; band.frequency.value = m.noise[0] * (.9 + Math.random() * .2); band.Q.value = m.noise[1];
  env.gain.setValueAtTime(1, now);
  env.gain.exponentialRampToValueAtTime(.001, now + m.decay);
  src.connect(band).connect(env).connect(out);
  src.start(now, Math.random() * .2, m.decay + .02);
  for (const f of m.ring) {
    const osc = c.createOscillator(), g = c.createGain();
    osc.frequency.value = f * (.97 + Math.random() * .06);
    g.gain.setValueAtTime(.55 * strength, now);
    g.gain.exponentialRampToValueAtTime(.001, now + m.decay * 1.7);
    osc.connect(g).connect(out);
    osc.start(now);
    osc.stop(now + m.decay * 1.8);
  }
  setTimeout(() => { voices--; try { out.disconnect(); } catch { /* already gone */ } }, (m.decay * 1.8 + .05) * 1000);
}

/** A door's slow groan on its hinge, or a drawer on its runners: a low filtered noise that rises and dies with the motion. */
export function slideSound(material: 'hinge' | 'runner', seconds = .5, distance = .6) {
  if (voices >= 6) return;
  const c = audio();
  if (!c || !noise) return;
  const now = c.currentTime;
  voices++;
  const src = c.createBufferSource(), band = c.createBiquadFilter(), env = c.createGain();
  src.buffer = noise; src.loop = true;
  src.playbackRate.value = material === 'hinge' ? .35 : .6;
  band.type = 'bandpass'; band.frequency.value = material === 'hinge' ? 340 : 720; band.Q.value = material === 'hinge' ? 2.4 : 1.1;
  const peak = (material === 'hinge' ? .035 : .05) / (1 + distance * distance * .5);
  env.gain.setValueAtTime(.0001, now);
  env.gain.exponentialRampToValueAtTime(peak, now + seconds * .25);
  env.gain.exponentialRampToValueAtTime(.0001, now + seconds);
  src.connect(band).connect(env);
  connectToSink(env, c);
  src.start(now);
  src.stop(now + seconds + .02);
  setTimeout(() => { voices--; try { env.disconnect(); } catch { /* already gone */ } }, (seconds + .05) * 1000);
}

/** A foot landing: a low thump on boards, a soft press on a rug. Quiet: a step is heard, it does not compete with studying. */
export function footstep(surface: 'wood' | 'rug' | 'stone', strength = .5, destination?: AudioNode) {
  if (voices >= 6) return;
  const c = audio();
  if (!c || !noise) return;
  const now = c.currentTime, wood = surface === 'wood';
  voices++;
  const src = c.createBufferSource(), band = c.createBiquadFilter(), env = c.createGain();
  src.buffer = noise; src.playbackRate.value = .55 + Math.random() * .2;
  band.type = 'lowpass'; band.frequency.value = (wood ? 620 : surface==='stone' ? 520 : 300) * (.9 + Math.random() * .2); band.Q.value = wood ? 1.4 : .5;
  const peak = (wood ? .05 : .026) * (.45 + .55 * strength), decay = wood ? .085 : .11;
  env.gain.setValueAtTime(peak, now);
  env.gain.exponentialRampToValueAtTime(.0005, now + decay);
  src.connect(band).connect(env);
  connectToSink(env, c, destination);
  src.start(now, Math.random() * .2, decay + .02);
  if (wood) {
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(118 * (.94 + Math.random() * .12), now);
    o.frequency.exponentialRampToValueAtTime(64, now + .07);
    g.gain.setValueAtTime(peak * .9, now);
    g.gain.exponentialRampToValueAtTime(.0005, now + .08);
    o.connect(g);
    connectToSink(g, c, destination);
    o.start(now); o.stop(now + .09);
  }
  setTimeout(() => { voices--; }, (decay + .06) * 1000);
}

/** Furniture on the floor: one voice for as long as it moves, as loud as it goes, its pitch from what its feet are made of. */
const SCRAPE: Record<string, { f: number; q: number; rate: number; level: number }> = {
  casters: { f: 1500, q: .7, rate: 1.1, level: .018 }, 'wood-legs': { f: 720, q: 1.2, rate: .55, level: .05 }, 'wood-base': { f: 520, q: 1, rate: .45, level: .058 },
  metal: { f: 1250, q: 1.6, rate: .7, level: .04 }, fabric: { f: 340, q: .5, rate: .4, level: .03 }, ceramic: { f: 980, q: 1.4, rate: .6, level: .045 },
  bristle: { f: 3200, q: .7, rate: 1.05, level: .05 }, wet: { f: 720, q: .5, rate: .42, level: .07 }, rub: { f: 1700, q: .8, rate: .8, level: .03 }, scrape: { f: 2300, q: 1.5, rate: .75, level: .035 }, feather: { f: 4600, q: .5, rate: 1.2, level: .016 },
};
export class Scrape {
  private src: AudioBufferSourceNode | null = null;
  private band: BiquadFilterNode | null = null;
  private gain: GainNode | null = null;
  private ctx: AudioContext | null = null;
  private sink: AudioNode | null = null;
  reconnectSink() {
    if (!this.gain || !this.ctx) return;
    const target = resolveSink(this.ctx);
    if (target === this.sink) return;
    try { this.gain.disconnect(); } catch { /* already disconnected */ }
    this.sink = connectToSink(this.gain, this.ctx);
  }
  set(level: number, feet: string) {
    const c = audio();
    if (!c || !noise) return;
    if (!this.src) {
      if (level <= 0) return;
      this.ctx = c;
      this.src = c.createBufferSource(); this.band = c.createBiquadFilter(); this.gain = c.createGain();
      this.src.buffer = noise; this.src.loop = true; this.band.type = 'bandpass'; this.gain.gain.value = 0;
      this.src.connect(this.band).connect(this.gain);
      this.sink = connectToSink(this.gain, c);
      activeScrapes.add(this);
      this.src.start();
    } else {
      this.ctx = c;
      this.reconnectSink();
    }
    const m = SCRAPE[feet] ?? SCRAPE['wood-legs'], now = c.currentTime;
    this.band!.frequency.setTargetAtTime(m.f * (.85 + level * .3), now, .05); this.band!.Q.value = m.q;
    this.src.playbackRate.setTargetAtTime(m.rate * (.8 + level * .4), now, .05);
    this.gain!.gain.setTargetAtTime(m.level * level, now, level > 0 ? .04 : .09);
  }
  stop() {
    activeScrapes.delete(this);
    try { this.src?.stop(); } catch { /* it had already stopped */ }
    this.src?.disconnect(); this.band?.disconnect(); this.gain?.disconnect();
    this.src = null; this.band = null; this.gain = null; this.ctx = null; this.sink = null;
  }
}

/**
 * The air of the room: rain on the glass, wind outside, both louder with the window open. One voice each, always the same two nodes, and silence when there is no weather.
 * Under reduced motion it stays, since sound is not motion; `allowed` is for the learner's own quiet setting.
 */
export class RoomAir {
  private rain: { src: AudioBufferSourceNode; gain: GainNode; band: BiquadFilterNode } | null = null;
  private wind: { src: AudioBufferSourceNode; gain: GainNode; band: BiquadFilterNode } | null = null;
  private voice(rate: number, type: BiquadFilterType, f: number, q: number) {
    const c = audio();
    if (!c || !noise) return null;
    const src = c.createBufferSource(), band = c.createBiquadFilter(), gain = c.createGain();
    src.buffer = noise; src.loop = true; src.playbackRate.value = rate; band.type = type; band.frequency.value = f; band.Q.value = q; gain.gain.value = 0;
    src.connect(band).connect(gain).connect(c.destination); src.start();
    return { src, gain, band };
  }
  set(rain: number, wind: number, open: boolean, allowed: boolean) {
    if (rain <= 0 && wind <= .12) { if (this.rain || this.wind) this.stop(); return; }
    const c = audio();
    if (!c || c.state !== 'running') return;
    const now = c.currentTime, on = allowed ? 1 : .5;
    if (rain > 0 && !this.rain) this.rain = this.voice(1.3, 'highpass', 900, .5);
    if (this.rain) { this.rain.gain.gain.setTargetAtTime(rain * (open ? .06 : .018) * on, now, .9); this.rain.band.frequency.setTargetAtTime(open ? 700 : 1500, now, .5); }
    if (wind > .12 && !this.wind) this.wind = this.voice(.32, 'bandpass', 420, .8);
    if (this.wind) { this.wind.gain.gain.setTargetAtTime(Math.max(0, wind - .1) * (open ? .05 : .008) * on, now, 1.4); this.wind.band.frequency.setTargetAtTime(300 + wind * 400, now, 2); }
  }
  stop() { for (const v of [this.rain, this.wind]) { try { v?.src.stop(); } catch { /* it had already stopped */ } v?.src.disconnect(); v?.band.disconnect(); v?.gain.disconnect(); } this.rain = null; this.wind = null; }
}
/** Water running into something: as long as the seconds asked for, and the note rises as it fills. */
export function waterRun(seconds: number, distance = 0) {
  const c = audio();
  if (!c || !noise) return;
  const now = c.currentTime, src = c.createBufferSource(), band = c.createBiquadFilter(), gain = c.createGain();
  src.buffer = noise; src.loop = true; src.playbackRate.value = 1.15; band.type = 'bandpass'; band.Q.value = .7;
  const level = .05 / (1 + distance * distance * .5);
  band.frequency.setValueAtTime(700, now); band.frequency.linearRampToValueAtTime(1500, now + seconds);
  gain.gain.setValueAtTime(.0001, now); gain.gain.exponentialRampToValueAtTime(level, now + .12); gain.gain.setValueAtTime(level, now + Math.max(.13, seconds - .15)); gain.gain.exponentialRampToValueAtTime(.0001, now + seconds);
  src.connect(band).connect(gain); connectToSink(gain, c); src.start(now); src.stop(now + seconds + .02);
  src.onended = () => { src.disconnect(); band.disconnect(); gain.disconnect(); };
  return () => { try { src.stop(); } catch { /* already ended */ } };
}
/** A body of water going somewhere: a slop, a slosh, a mop going in. */
export function splash(strength = .5) {
  const c = audio();
  if (!c || !noise) return;
  const now = c.currentTime, src = c.createBufferSource(), band = c.createBiquadFilter(), gain = c.createGain();
  src.buffer = noise; src.playbackRate.value = .7 + Math.random() * .25; band.type = 'bandpass'; band.frequency.value = 640 + Math.random() * 300; band.Q.value = .6;
  gain.gain.setValueAtTime(.08 * strength, now); gain.gain.exponentialRampToValueAtTime(.0003, now + .4);
  src.connect(band).connect(gain); connectToSink(gain, c); src.start(now, Math.random() * .1, .4);
}

/** Two soft notes: a screen coming on, a computer put together. */
export function chime(kind: 'boot' | 'ready') {
  const c = audio();
  if (!c) return;
  const now = c.currentTime;
  (kind === 'boot' ? [523.25, 783.99] : [659.25, 987.77]).forEach((f, i) => {
    const o = c.createOscillator(), g = c.createGain(), at = now + i * .11;
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(.0001, at);
    g.gain.exponentialRampToValueAtTime(.035, at + .02);
    g.gain.exponentialRampToValueAtTime(.0002, at + .42);
    o.connect(g);
    connectToSink(g, c);
    o.start(at); o.stop(at + .44);
  });
}
