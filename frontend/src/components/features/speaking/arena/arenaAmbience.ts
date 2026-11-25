/**
 * ECHO ARCHIPELAGO — 3D Positional Coastal, Interaction and Underwater Soundscape.
 * Portions adapted from Abyssal Garden — Copyright (c) 2026 Maksymilian Dendura, MIT License.
 *
 * Runs entirely on the shared `contactAudioContext()` environmental bus (zero external audio
 * downloads, zero second AudioContext). Voice (LiveKit) keeps its own isolated output, while
 * `setVoiceActive(true)` and `talking` automatically duck ambient layers by -12 dB (0.25x).
 */

import { contactAudioContext, footstep } from '@/lib/embodiment/contactAudio';
import { noiseBuffer } from '@/lib/study-space/ambient';
import { ARENA_WATER_Y, arenaLayout } from './arenaTerrain';

interface EngineVoice {
  tone: OscillatorNode;
  gain: GainNode;
  pan: StereoPannerNode;
  last: number;
}

interface PooledVoice {
  osc: OscillatorNode;
  gain: GainNode;
  pan: StereoPannerNode;
  wetSend: GainNode;
  busyUntil: number;
}

interface FishSplashVoice {
  bp: BiquadFilterNode;
  noiseGain: GainNode;
  popOsc: OscillatorNode;
  popGain: GainNode;
  pan: StereoPannerNode;
  busyUntil: number;
}

export type FishLeapSplashKind = 'exit' | 'reentry';

const D_FIFTHS_HZ = [73.42, 110.0, 164.81, 246.94, 369.99] as const;
const D_PENTATONIC_SEMITONES = [-7, -5, -3, 0, 2, 5, 7, 9, 14, 17] as const;
const VOICE_DUCK_GAIN = 0.25; // -12.04 dB attenuation when mic/LiveKit/Speaking recording is active
const WATERFALL_MAX_DIST_M = 85;
const FISH_SPLASH_MAX_DIST_M = 42;
const FISH_SPLASH_MIN_INTERVAL_SEC = 0.095;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function stereoAzimuthPan(dx: number, dz: number, distance: number, listenerYaw: number): number {
  return clamp((dz * Math.sin(listenerYaw) - dx * Math.cos(listenerYaw)) / Math.max(1, distance), -1, 1);
}

/** Seamless 11-second stereo brown-noise buffer with 4096-sample head/tail cross-fade (zero loop click). */
function createSeamlessBrownBuffer(ctx: AudioContext, seconds = 11): AudioBuffer {
  const sr = ctx.sampleRate;
  const fade = Math.min(4096, Math.floor(sr * 0.1));
  const len = Math.floor(sr * seconds);
  const total = len + fade;
  const buf = ctx.createBuffer(2, len, sr);
  let seed = 20261122;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let ch = 0; ch < 2; ch++) {
    const tmp = new Float32Array(total);
    let b = 0;
    for (let i = 0; i < total; i++) {
      b = (b + 0.02 * (rnd() * 2 - 1)) / 1.02;
      tmp[i] = b * 3.1;
    }
    const out = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      out[i] = tmp[i];
    }
    for (let i = 0; i < fade; i++) {
      const a = i / fade;
      out[i] = out[i] * a + tmp[len + i] * (1 - a);
    }
  }
  return buf;
}

/** Darkening underwater impulse response for muffled sub-aqueous convolution reverb. */
function createUnderwaterImpulse(ctx: AudioContext, seconds = 2.4): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  let seed = 918273;
  const rnd = () => {
    seed = (Math.imul(seed, 22695477) + 1) >>> 0;
    return seed / 4294967296;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const white = rnd() * 2 - 1;
      lp += (white - lp) * (0.04 + 0.48 * Math.exp(-t * 2.2));
      d[i] = lp * (1 - Math.exp(-t * 30)) * Math.exp(-t * 1.65) * (1 - i / len) * 0.42;
    }
  }
  return buf;
}

export class ArenaAmbience {
  private ctx: AudioContext | null = null;
  private bus?: GainNode;

  // Surface sub-bus (passes through dynamic low-pass filter that drops to 420 Hz underwater)
  private surfaceBus?: GainNode;
  private surfaceSubmergeFilter?: BiquadFilterNode;
  private surf?: GainNode;
  private pan?: StereoPannerNode;
  private noise?: AudioBufferSourceNode;
  private filter?: BiquadFilterNode;

  // Breeze and palm rustle layer
  private breezeSrc?: AudioBufferSourceNode;
  private breezeFilter?: BiquadFilterNode;
  private breezeGain?: GainNode;

  // 3D positional dual-band waterfall plunge + Green Mountain brook/river-mouth cascade
  private waterfallRoarSrc?: AudioBufferSourceNode;
  private waterfallRoarFilter?: BiquadFilterNode;
  private waterfallRoarGain?: GainNode;
  private waterfallSrc?: AudioBufferSourceNode;
  private waterfallFilter?: BiquadFilterNode;
  private waterfallGain?: GainNode;
  private waterfallPan?: StereoPannerNode;
  private brookSrc?: AudioBufferSourceNode;
  private brookFilter?: BiquadFilterNode;
  private brookGain?: GainNode;
  private brookPan?: StereoPannerNode;
  private waterfallPos: { x: number; y: number; z: number; active: boolean } = {
    x: 6,
    y: 4.2,
    z: -189,
    active: true,
  };
  private brookMouthPos: { x: number; y: number; z: number; active: boolean } = {
    x: 10,
    y: -1.2,
    z: -148,
    active: true,
  };

  // Overhead coastal seabird bandpass softener + zero-GC jumping-fish splash pool
  private birdFilter?: BiquadFilterNode;
  private fishNoiseSrc?: AudioBufferSourceNode;
  private readonly fishSplashPool: FishSplashVoice[] = [];
  private readonly brookPool: PooledVoice[] = [];
  private lastFishSplashAt = -1;
  private lastFishExitAt = -1;
  private lastFishReentryAt = -1;

  // Underwater Abyssal Garden synthesis sub-graph
  private underwaterBus?: GainNode;
  private uwConvolver?: ConvolverNode;
  private uwWetGain?: GainNode;
  private uwRumbleSrc?: AudioBufferSourceNode;
  private uwRumbleFilter?: BiquadFilterNode;
  private uwRumbleGain?: GainNode;
  private uwWashSrc?: AudioBufferSourceNode;
  private uwWashFilter?: BiquadFilterNode;
  private uwWashGain?: GainNode;
  private uwRushFilter?: BiquadFilterNode;
  private uwRushGain?: GainNode;
  private uwDroneGain?: GainNode;
  private readonly uwLfos: OscillatorNode[] = [];
  private readonly uwDroneOscs: OscillatorNode[] = [];
  private readonly bubblePool: PooledVoice[] = [];
  private readonly chimePool: PooledVoice[] = [];
  private readonly whalePool: PooledVoice[] = [];
  private readonly birdPool: PooledVoice[] = [];

  private splashBuf?: AudioBuffer;
  private brownSeamlessBuf?: AudioBuffer;
  private last = -1;
  private lastReelClickAt = -1;

  // Scheduler timestamps (seconds on AudioContext clock)
  private nextBubbleAt = 2.0;
  private nextChimeAt = 4.5;
  private nextWhaleAt = 16.0;
  private nextBirdAt = 8.0;
  private nextBrookSparkleAt = 1.5;

  // User and voice-ducking controls
  private muted = false;
  private userVolume = 1.0;
  private voiceRecordingActive = false;
  private submersion = 0;
  private listenerCamY = 1.6;
  private swimSpeed = 0;

  private readonly engines = new Map<string, EngineVoice>();

  /** Automatically ducks environmental audio by -12 dB (0.25x) when mic/LiveKit/Speaking recording is active. */
  setVoiceActive(active: boolean): void {
    this.voiceRecordingActive = active;
    if (this.ctx && this.bus) {
      const target = this.muted ? 0 : this.userVolume * (active ? VOICE_DUCK_GAIN : 1);
      this.bus.gain.setTargetAtTime(target, this.ctx.currentTime, 0.12);
    }
  }

  get isVoiceActive(): boolean {
    return this.voiceRecordingActive;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.bus) {
      const target = muted ? 0 : this.userVolume * (this.voiceRecordingActive ? VOICE_DUCK_GAIN : 1);
      this.bus.gain.setTargetAtTime(target, this.ctx.currentTime, 0.08);
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMasterVolume(volume: number): void {
    this.userVolume = clamp(volume, 0, 1);
    if (this.ctx && this.bus) {
      const target = this.muted ? 0 : this.userVolume * (this.voiceRecordingActive ? VOICE_DUCK_GAIN : 1);
      this.bus.gain.setTargetAtTime(target, this.ctx.currentTime, 0.12);
    }
  }

  /** Set or disable the 3D world position of an island waterfall cascade for positional distance attenuation. */
  setWaterfallPos(x: number, y: number, z: number, active = true): void {
    this.waterfallPos.x = x;
    this.waterfallPos.y = y;
    this.waterfallPos.z = z;
    this.waterfallPos.active = active;
    if (!active) {
      this.brookMouthPos.active = false;
    }
  }

  /** Optional override for the lower Green Mountain brook / river-mouth coordinates (`~(10, -1.2, -148)`). */
  setBrookMouthPos(x: number, y: number, z: number, active = true): void {
    this.brookMouthPos.x = x;
    this.brookMouthPos.y = y;
    this.brookMouthPos.z = z;
    this.brookMouthPos.active = active;
  }

  /** Update continuous camera/swimmer submersion (0 = dry air, 1 = fully underwater) for low-pass + reef audio crossfade. */
  setSubmersion(submersion: number, camY = ARENA_WATER_Y + 1.5, swimSpeed = 0): void {
    this.submersion = clamp(submersion, 0, 1);
    this.listenerCamY = camY;
    this.swimSpeed = Math.max(0, swimSpeed);
  }

  engine(id: string, on: boolean, throttle: number, speed: number, dx: number, dz: number, yaw: number): void {
    if (!this.ctx || !this.surfaceBus) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const distance = Math.hypot(dx, dz);
    let voice = this.engines.get(id);
    if (!on || distance > 65) {
      if (voice) {
        voice.gain.gain.setTargetAtTime(0.0001, now, 0.055);
        voice.tone.stop(now + 0.32);
        this.engines.delete(id);
      }
      return;
    }
    if (!voice) {
      const tone = ctx.createOscillator();
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      tone.type = 'triangle';
      tone.frequency.value = 34;
      gain.gain.value = 0.0001;
      tone.connect(gain).connect(pan).connect(this.surfaceBus);
      tone.start();
      tone.onended = () => {
        tone.disconnect();
        gain.disconnect();
        pan.disconnect();
      };
      voice = { tone, gain, pan, last: -1 };
      this.engines.set(id, voice);
    }
    if (now - voice.last < 0.08) return;
    voice.last = now;
    voice.tone.frequency.setTargetAtTime(38 + 21 * Math.abs(throttle) + Math.min(32, speed * 1.5), now, 0.16);
    voice.gain.gain.setTargetAtTime((0.019 + 0.014 * Math.abs(throttle)) / (1 + 0.006 * distance * distance), now, 0.1);
    voice.pan.pan.setTargetAtTime(stereoAzimuthPan(dx, dz, distance, yaw), now, 0.12);
  }

  private createPooledVoice(
    ctx: AudioContext,
    type: OscillatorType,
    dryTarget: AudioNode,
    wetTarget: AudioNode | null,
    wetAmount: number,
  ): PooledVoice {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    const wetSend = ctx.createGain();
    osc.type = type;
    osc.frequency.value = 440;
    gain.gain.value = 0;
    wetSend.gain.value = wetAmount;
    osc.connect(gain).connect(pan);
    pan.connect(dryTarget);
    if (wetTarget && wetAmount > 0) {
      pan.connect(wetSend).connect(wetTarget);
    }
    osc.start();
    return { osc, gain, pan, wetSend, busyUntil: 0 };
  }

  unlock(): void {
    const ctx = contactAudioContext();
    if (!ctx || this.bus) return;
    this.ctx = ctx;
    const now = ctx.currentTime;

    // Master environmental bus
    this.bus = ctx.createGain();
    this.bus.gain.value = this.muted ? 0 : 0.35;
    this.bus.connect(ctx.destination);

    // Surface sub-bus -> dynamic low-pass filter (2200 Hz in air -> 420 Hz when submerged > 0.5)
    this.surfaceBus = ctx.createGain();
    this.surfaceBus.gain.value = 1.0;
    this.surfaceSubmergeFilter = ctx.createBiquadFilter();
    this.surfaceSubmergeFilter.type = 'lowpass';
    this.surfaceSubmergeFilter.frequency.value = 2200;
    this.surfaceSubmergeFilter.Q.value = 0.65;
    this.surfaceBus.connect(this.surfaceSubmergeFilter).connect(this.bus);

    this.splashBuf = noiseBuffer(ctx, 'pink', 1.2);
    this.brownSeamlessBuf = createSeamlessBrownBuffer(ctx, 11);

    // 1. Ocean surf layer
    this.noise = ctx.createBufferSource();
    this.noise.buffer = this.brownSeamlessBuf;
    this.noise.loop = true;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 640;
    this.surf = ctx.createGain();
    this.surf.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.noise.connect(this.filter).connect(this.surf).connect(this.pan).connect(this.surfaceBus);
    this.noise.start();

    // 2. Tropical breeze and palm frond rustle layer
    this.breezeSrc = ctx.createBufferSource();
    this.breezeSrc.buffer = this.splashBuf;
    this.breezeSrc.loop = true;
    this.breezeSrc.playbackRate.value = 0.52;
    this.breezeFilter = ctx.createBiquadFilter();
    this.breezeFilter.type = 'bandpass';
    this.breezeFilter.frequency.value = 540;
    this.breezeFilter.Q.value = 1.1;
    this.breezeGain = ctx.createGain();
    this.breezeGain.gain.value = 0;
    const breezeLfo = ctx.createOscillator();
    const breezeLfoGain = ctx.createGain();
    breezeLfo.frequency.value = 0.065;
    breezeLfoGain.gain.value = 190;
    breezeLfo.connect(breezeLfoGain).connect(this.breezeFilter.frequency);
    breezeLfo.start();
    this.uwLfos.push(breezeLfo);
    this.breezeSrc.connect(this.breezeFilter).connect(this.breezeGain).connect(this.surfaceBus);
    this.breezeSrc.start();

    // 3. 3D Positional Dual-Band Waterfall Plunge + Lower Brook Cascade (<= 85 m, auto-muffled underwater)
    this.waterfallPan = ctx.createStereoPanner();
    this.waterfallPan.connect(this.surfaceBus);

    // 3a. Deep plunge-pool bass roar (seamless brown noise -> low-pass 250 Hz)
    this.waterfallRoarSrc = ctx.createBufferSource();
    this.waterfallRoarSrc.buffer = this.brownSeamlessBuf;
    this.waterfallRoarSrc.loop = true;
    this.waterfallRoarSrc.playbackRate.value = 0.88;
    this.waterfallRoarFilter = ctx.createBiquadFilter();
    this.waterfallRoarFilter.type = 'lowpass';
    this.waterfallRoarFilter.frequency.value = 250;
    this.waterfallRoarFilter.Q.value = 0.75;
    this.waterfallRoarGain = ctx.createGain();
    this.waterfallRoarGain.gain.value = 0;
    this.waterfallRoarSrc
      .connect(this.waterfallRoarFilter)
      .connect(this.waterfallRoarGain)
      .connect(this.waterfallPan);
    this.waterfallRoarSrc.start();

    // 3b. Upper whitewater cascade mist (pink noise -> modulated bandpass ~1040 Hz)
    this.waterfallSrc = ctx.createBufferSource();
    this.waterfallSrc.buffer = this.splashBuf;
    this.waterfallSrc.loop = true;
    this.waterfallSrc.playbackRate.value = 0.96;
    this.waterfallFilter = ctx.createBiquadFilter();
    this.waterfallFilter.type = 'bandpass';
    this.waterfallFilter.frequency.value = 1040;
    this.waterfallFilter.Q.value = 0.65;
    const wfMistLfo = ctx.createOscillator();
    const wfMistLfoGain = ctx.createGain();
    wfMistLfo.frequency.value = 0.19;
    wfMistLfoGain.gain.value = 135;
    wfMistLfo.connect(wfMistLfoGain).connect(this.waterfallFilter.frequency);
    wfMistLfo.start();
    this.uwLfos.push(wfMistLfo);
    this.waterfallGain = ctx.createGain();
    this.waterfallGain.gain.value = 0;
    this.waterfallSrc
      .connect(this.waterfallFilter)
      .connect(this.waterfallGain)
      .connect(this.waterfallPan);
    this.waterfallSrc.start();

    // 3c. Upper-to-lower Green Mountain brook & river-mouth bubbling stream layer
    this.brookPan = ctx.createStereoPanner();
    this.brookPan.connect(this.surfaceBus);
    this.brookSrc = ctx.createBufferSource();
    this.brookSrc.buffer = this.splashBuf;
    this.brookSrc.loop = true;
    this.brookSrc.playbackRate.value = 1.28;
    this.brookFilter = ctx.createBiquadFilter();
    this.brookFilter.type = 'bandpass';
    this.brookFilter.frequency.value = 1480;
    this.brookFilter.Q.value = 1.85;
    for (const [freq, amp] of [
      [2.3, 210],
      [3.7, 145],
    ] as const) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = freq;
      lg.gain.value = amp;
      lfo.connect(lg).connect(this.brookFilter.frequency);
      lfo.start();
      this.uwLfos.push(lfo);
    }
    this.brookGain = ctx.createGain();
    this.brookGain.gain.value = 0;
    this.brookSrc.connect(this.brookFilter).connect(this.brookGain).connect(this.brookPan);
    this.brookSrc.start();

    // 3d. Shared pink-noise carrier + 3 pre-allocated zero-GC voices for jumping-fish splashes
    this.fishNoiseSrc = ctx.createBufferSource();
    this.fishNoiseSrc.buffer = this.splashBuf;
    this.fishNoiseSrc.loop = true;
    this.fishNoiseSrc.playbackRate.value = 1.08;
    this.fishNoiseSrc.start();
    for (let i = 0; i < 3; i++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 880;
      bp.Q.value = 1.4;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0;
      const popOsc = ctx.createOscillator();
      popOsc.type = 'sine';
      popOsc.frequency.value = 420;
      const popGain = ctx.createGain();
      popGain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      this.fishNoiseSrc.connect(bp).connect(noiseGain).connect(pan);
      popOsc.connect(popGain).connect(pan);
      pan.connect(this.surfaceBus);
      popOsc.start();
      this.fishSplashPool.push({ bp, noiseGain, popOsc, popGain, pan, busyUntil: 0 });
    }

    // 4. Underwater Abyssal Garden sub-graph
    this.underwaterBus = ctx.createGain();
    this.underwaterBus.gain.value = 0;
    this.underwaterBus.connect(this.bus);

    this.uwConvolver = ctx.createConvolver();
    this.uwConvolver.buffer = createUnderwaterImpulse(ctx, 2.4);
    this.uwWetGain = ctx.createGain();
    this.uwWetGain.gain.value = 0.65;
    this.uwConvolver.connect(this.uwWetGain).connect(this.underwaterBus);

    // 4a. Abyssal sub-current rumble (150 Hz low-pass + prime-ratio LFOs)
    this.uwRumbleSrc = ctx.createBufferSource();
    this.uwRumbleSrc.buffer = this.brownSeamlessBuf;
    this.uwRumbleSrc.loop = true;
    this.uwRumbleFilter = ctx.createBiquadFilter();
    this.uwRumbleFilter.type = 'lowpass';
    this.uwRumbleFilter.frequency.value = 150;
    this.uwRumbleFilter.Q.value = 0.7;
    this.uwRumbleGain = ctx.createGain();
    this.uwRumbleGain.gain.value = 0.16;
    for (const [freq, amp] of [[0.07, 0.045], [0.113, 0.032]] as const) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = freq;
      lg.gain.value = amp;
      lfo.connect(lg).connect(this.uwRumbleGain.gain);
      lfo.start();
      this.uwLfos.push(lfo);
    }
    this.uwRumbleSrc.connect(this.uwRumbleFilter).connect(this.uwRumbleGain).connect(this.underwaterBus);
    this.uwRumbleSrc.start();

    // 4b. Sub-surface wave wash (420 Hz bandpass) + velocity water rush (incommensurate 0.63x loop rate)
    this.uwWashSrc = ctx.createBufferSource();
    this.uwWashSrc.buffer = this.brownSeamlessBuf;
    this.uwWashSrc.loop = true;
    this.uwWashSrc.playbackRate.value = 0.63;

    this.uwWashFilter = ctx.createBiquadFilter();
    this.uwWashFilter.type = 'bandpass';
    this.uwWashFilter.frequency.value = 420;
    this.uwWashFilter.Q.value = 0.55;
    this.uwWashGain = ctx.createGain();
    this.uwWashGain.gain.value = 0.11;
    this.uwWashSrc.connect(this.uwWashFilter).connect(this.uwWashGain).connect(this.underwaterBus);

    this.uwRushFilter = ctx.createBiquadFilter();
    this.uwRushFilter.type = 'bandpass';
    this.uwRushFilter.frequency.value = 240;
    this.uwRushFilter.Q.value = 0.9;
    this.uwRushGain = ctx.createGain();
    this.uwRushGain.gain.value = 0;
    this.uwWashSrc.connect(this.uwRushFilter).connect(this.uwRushGain).connect(this.underwaterBus);
    this.uwWashSrc.start();

    // 4c. Subtle stacked-fifths D-major reef shimmer pad
    this.uwDroneGain = ctx.createGain();
    this.uwDroneGain.gain.value = 0.18;
    this.uwDroneGain.connect(this.underwaterBus);
    const droneWet = ctx.createGain();
    droneWet.gain.value = 0.25;
    this.uwDroneGain.connect(droneWet).connect(this.uwConvolver);
    D_FIFTHS_HZ.forEach((baseHz, idx) => {
      for (const sign of [-1, 1] as const) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = baseHz + sign * (0.04 + idx * 0.014);
        g.gain.value = Math.max(0.004, 0.015 - idx * 0.0022);
        osc.connect(g).connect(this.uwDroneGain!);
        osc.start();
        this.uwDroneOscs.push(osc);
      }
    });

    // 4d. Zero-GC preallocated procedural voice pools (bubbles, reef chimes, Echo Whale calls, brook sparkles, coastal birds)
    for (let i = 0; i < 4; i++) {
      this.bubblePool.push(this.createPooledVoice(ctx, 'sine', this.underwaterBus, this.uwConvolver, 0.14));
    }
    for (let i = 0; i < 3; i++) {
      this.chimePool.push(this.createPooledVoice(ctx, 'sine', this.underwaterBus, this.uwConvolver, 0.85));
    }
    for (let i = 0; i < 2; i++) {
      this.whalePool.push(this.createPooledVoice(ctx, 'triangle', this.underwaterBus, this.uwConvolver, 1.35));
    }
    for (let i = 0; i < 2; i++) {
      this.brookPool.push(this.createPooledVoice(ctx, 'sine', this.surfaceBus, null, 0));
    }
    this.birdFilter = ctx.createBiquadFilter();
    this.birdFilter.type = 'bandpass';
    this.birdFilter.frequency.value = 1780;
    this.birdFilter.Q.value = 0.85;
    this.birdFilter.connect(this.surfaceBus);
    for (let i = 0; i < 2; i++) {
      this.birdPool.push(this.createPooledVoice(ctx, 'sine', this.birdFilter, null, 0));
    }

    this.nextBubbleAt = now + 1.4;
    this.nextChimeAt = now + 3.8;
    this.nextWhaleAt = now + 14.0;
    this.nextBirdAt = now + 7.5 + Math.random() * 4.5;
    this.nextBrookSparkleAt = now + 1.2;
  }

  private acquireVoice(pool: readonly PooledVoice[], now: number): PooledVoice | null {
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].busyUntil <= now) return pool[i];
    }
    return null;
  }

  private scheduleUnderwaterEvents(now: number): void {
    // 1. Rising bubble blips
    if (now >= this.nextBubbleAt) {
      this.nextBubbleAt = now + 0.65 + Math.random() * 2.8;
      const count = 1 + Math.floor(Math.random() * 3);
      const panVal = (Math.random() * 2 - 1) * 0.72;
      for (let i = 0; i < count; i++) {
        const v = this.acquireVoice(this.bubblePool, now);
        if (!v) break;
        const start = now + i * (0.055 + Math.random() * 0.075);
        const f0 = 420 + Math.random() * 780;
        const f1 = f0 * (1.42 + Math.random() * 0.65);
        const dur = 0.048 + 36 / f0;
        v.pan.pan.setValueAtTime(clamp(panVal + (Math.random() - 0.5) * 0.18, -1, 1), start);
        v.osc.frequency.cancelScheduledValues(start);
        v.osc.frequency.setValueAtTime(f0, start);
        v.osc.frequency.exponentialRampToValueAtTime(f1, start + dur);
        v.gain.gain.cancelScheduledValues(start);
        v.gain.gain.setValueAtTime(0.0001, start);
        v.gain.gain.linearRampToValueAtTime(0.024 + Math.random() * 0.016, start + 0.007);
        v.gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        v.busyUntil = start + dur + 0.03;
      }
    }

    // 2. Harmonic D-major pentatonic reef shimmer
    if (now >= this.nextChimeAt) {
      this.nextChimeAt = now + 3.2 + Math.random() * 6.4;
      const v = this.acquireVoice(this.chimePool, now);
      if (v) {
        const semi = D_PENTATONIC_SEMITONES[Math.floor(Math.random() * D_PENTATONIC_SEMITONES.length)];
        const freq = 587.33 * Math.pow(2, semi / 12);
        const dur = 2.6 + Math.random() * 1.8;
        v.pan.pan.setValueAtTime((Math.random() * 2 - 1) * 0.65, now);
        v.osc.frequency.cancelScheduledValues(now);
        v.osc.frequency.setValueAtTime(freq, now);
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setValueAtTime(0.0001, now);
        v.gain.gain.linearRampToValueAtTime(0.014, now + 0.04);
        v.gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
        v.busyUntil = now + dur + 0.05;
      }
    }

    // 3. Rare distant Echo Whale song calls
    if (now >= this.nextWhaleAt) {
      this.nextWhaleAt = now + 22 + Math.random() * 26;
      const v = this.acquireVoice(this.whalePool, now);
      if (v) {
        const f0 = 175 + Math.random() * 165;
        const f1 = f0 * (Math.random() < 0.5 ? 0.68 : 1.46);
        const dur = 1.8 + Math.random() * 1.4;
        v.pan.pan.setValueAtTime((Math.random() * 2 - 1) * 0.8, now);
        v.osc.frequency.cancelScheduledValues(now);
        v.osc.frequency.setValueAtTime(f0, now);
        v.osc.frequency.exponentialRampToValueAtTime(f1, now + dur);
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setValueAtTime(0.0001, now);
        v.gain.gain.linearRampToValueAtTime(0.022, now + dur * 0.38);
        v.gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
        v.busyUntil = now + dur + 0.1;
      }
    }
  }

  private scheduleBrookSparkles(now: number, distM: number, basePan: number, segT: number): void {
    if (now < this.nextBrookSparkleAt) return;
    this.nextBrookSparkleAt = now + 0.24 + Math.random() * 0.44;
    if (distM > 52) return;
    const prox = 1 - distM / 52;
    const count = Math.random() < 0.38 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const v = this.acquireVoice(this.brookPool, now);
      if (!v) break;
      const start = now + i * (0.048 + Math.random() * 0.055);
      // Higher crystalline droplet sparkle near upper plunge, rounder stream babble near lower river mouth
      const f0 = (760 - segT * 150) + Math.random() * 540;
      const f1 = f0 * (1.28 + Math.random() * 0.36);
      const dur = 0.036 + 26 / f0;
      const peak = (0.011 * prox * prox) / (1 + 0.03 * distM * distM);
      if (peak < 0.00025) break;
      v.pan.pan.setValueAtTime(clamp(basePan + (Math.random() - 0.5) * 0.22, -1, 1), start);
      v.osc.frequency.cancelScheduledValues(start);
      v.osc.frequency.setValueAtTime(f0, start);
      v.osc.frequency.exponentialRampToValueAtTime(f1, start + dur);
      v.gain.gain.cancelScheduledValues(start);
      v.gain.gain.setValueAtTime(0.0001, start);
      v.gain.gain.linearRampToValueAtTime(peak, start + 0.006);
      v.gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      v.busyUntil = start + dur + 0.025;
    }
  }

  private scheduleCoastalBirdCall(
    now: number,
    coastalPresence: number,
    shoreDx: number,
    shoreDz: number,
    listenerYaw: number,
  ): void {
    if (now < this.nextBirdAt) return;
    // Natural long archipelago interval (7..18 s)
    this.nextBirdAt = now + 7.0 + Math.random() * 11.0;
    const v1 = this.acquireVoice(this.birdPool, now);
    if (!v1) return;

    // Spatialize gently overhead around shoreward/coastal sky bearing (narrowed to +-0.72 for overhead elevation)
    const shoreBearing = Math.atan2(-shoreDx, -shoreDz) + (Math.random() - 0.5) * 1.65;
    const skyDx = Math.sin(shoreBearing) * 20;
    const skyDz = Math.cos(shoreBearing) * 20;
    const overheadPan = stereoAzimuthPan(skyDx, skyDz, 20, listenerYaw) * 0.72;
    const presence = clamp(coastalPresence, 0.32, 1);

    if (Math.random() < 0.52) {
      // Motif A: Gentle coastal tern two-note overhead call
      const base = 1580 + Math.random() * 380;
      const peak = 0.0085 * (0.45 + 0.55 * presence);
      v1.pan.pan.setValueAtTime(overheadPan, now);
      v1.osc.frequency.cancelScheduledValues(now);
      v1.osc.frequency.setValueAtTime(base, now);
      v1.osc.frequency.exponentialRampToValueAtTime(base * 1.17, now + 0.075);
      v1.osc.frequency.exponentialRampToValueAtTime(base * 0.84, now + 0.22);
      v1.gain.gain.cancelScheduledValues(now);
      v1.gain.gain.setValueAtTime(0.0001, now);
      v1.gain.gain.linearRampToValueAtTime(peak, now + 0.032);
      v1.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      v1.busyUntil = now + 0.27;

      const v2 = this.acquireVoice(this.birdPool, now);
      if (v2 && v2 !== v1) {
        const t2 = now + 0.26 + Math.random() * 0.05;
        const base2 = base * 0.93;
        v2.pan.pan.setValueAtTime(clamp(overheadPan + (Math.random() - 0.5) * 0.12, -0.78, 0.78), t2);
        v2.osc.frequency.cancelScheduledValues(t2);
        v2.osc.frequency.setValueAtTime(base2, t2);
        v2.osc.frequency.exponentialRampToValueAtTime(base2 * 1.13, t2 + 0.07);
        v2.osc.frequency.exponentialRampToValueAtTime(base2 * 0.8, t2 + 0.23);
        v2.gain.gain.cancelScheduledValues(t2);
        v2.gain.gain.setValueAtTime(0.0001, t2);
        v2.gain.gain.linearRampToValueAtTime(peak * 0.68, t2 + 0.03);
        v2.gain.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.25);
        v2.busyUntil = t2 + 0.28;
      }
    } else {
      // Motif B: Warm gliding gull arc overhead
      const base = 1160 + Math.random() * 340;
      const peak = 0.0092 * (0.45 + 0.55 * presence);
      v1.pan.pan.setValueAtTime(overheadPan, now);
      v1.osc.frequency.cancelScheduledValues(now);
      v1.osc.frequency.setValueAtTime(base * 0.92, now);
      v1.osc.frequency.exponentialRampToValueAtTime(base * 1.24, now + 0.13);
      v1.osc.frequency.exponentialRampToValueAtTime(base * 0.76, now + 0.38);
      v1.gain.gain.cancelScheduledValues(now);
      v1.gain.gain.setValueAtTime(0.0001, now);
      v1.gain.gain.linearRampToValueAtTime(peak, now + 0.055);
      v1.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.41);
      v1.busyUntil = now + 0.45;
    }
  }

  update(
    x: number,
    z: number,
    yaw: number,
    t: number,
    volume: number,
    talking: boolean,
    boatingSpeed = 0,
    submersion?: number,
    camY?: number,
    swimSpeed?: number,
  ): void {
    if (submersion !== undefined) this.submersion = clamp(submersion, 0, 1);
    if (camY !== undefined) this.listenerCamY = camY;
    if (swimSpeed !== undefined) this.swimSpeed = Math.max(0, swimSpeed);

    if (!this.ctx || !this.bus || !this.surf || !this.pan || t - this.last < 0.1) return;
    this.last = t;
    this.userVolume = clamp(volume, 0, 1);

    const islands = arenaLayout.islands;
    let nearest = islands[0];
    let bestShoreGap = Math.abs(Math.hypot(x - nearest.x, z - nearest.z) - nearest.radius);
    for (let i = 1; i < islands.length; i++) {
      const cand = islands[i];
      const gap = Math.abs(Math.hypot(x - cand.x, z - cand.z) - cand.radius);
      if (gap < bestShoreGap) {
        bestShoreGap = gap;
        nearest = cand;
      }
    }
    const dx = x - nearest.x;
    const dz = z - nearest.z;
    const r = Math.hypot(dx, dz);
    const shore = Math.exp(-bestShoreGap / 14);
    const inland = r <= nearest.radius ? 1 : Math.exp(-(r - nearest.radius) / 22);
    const hullWash = Math.min(0.055, boatingSpeed * 0.012);
    const time = this.ctx.currentTime;

    // Master bus respects mute + automatic -12 dB voice ducking when LiveKit/mic/recording is active
    const duck = talking || this.voiceRecordingActive ? VOICE_DUCK_GAIN : 1.0;
    const masterGain = this.muted ? 0 : this.userVolume * duck;
    this.bus.gain.setTargetAtTime(masterGain, time, 0.14);

    // Submersion low-pass filter on surface sounds: 2200 Hz above water -> 420 Hz when submersion > 0.5
    const sub = this.submersion;
    const underWeight = sub > 0.5 ? clamp((sub - 0.5) / 0.38, 0, 1) : clamp(sub * 0.35, 0, 0.18);
    if (this.surfaceSubmergeFilter && this.surfaceBus) {
      const cutoff = sub > 0.5 ? 420 : 2200 - sub * 2800;
      this.surfaceSubmergeFilter.frequency.setTargetAtTime(Math.max(360, cutoff), time, 0.14);
      this.surfaceBus.gain.setTargetAtTime(1 - underWeight * 0.68, time, 0.16);
    }

    if (this.filter) {
      this.filter.frequency.setTargetAtTime(620 + Math.min(380, boatingSpeed * 85), time, 0.2);
    }
    this.surf.gain.setTargetAtTime(0.012 + hullWash + shore * (0.045 + 0.025 * Math.sin(t * 0.67)), time, 0.2);
    this.pan.pan.setTargetAtTime(stereoAzimuthPan(dx, dz, r, yaw) * shore * 0.65, time, 0.2);

    // Tropical breeze and palm rustle
    if (this.breezeGain) {
      const gust = 0.5 + 0.5 * Math.sin(t * 0.41 + 1.2);
      this.breezeGain.gain.setTargetAtTime(inland * (0.008 + 0.011 * gust) * (1 - sub), time, 0.25);
    }

    // 3D Positional Dual-Band Waterfall Plunge + Upper/Lower Brook Cascade (<= 85 m, low-pass muffled underwater)
    let brookDistForSparkle = Infinity;
    let brookPanForSparkle = 0;
    let brookSegT = 0;
    if (this.waterfallPan && this.waterfallGain && this.waterfallRoarGain) {
      if (this.waterfallPos.active) {
        const wdx = this.waterfallPos.x - x;
        const wdz = this.waterfallPos.z - z;
        const wHoriz = Math.hypot(wdx, wdz);
        const wDist3d = Math.hypot(wHoriz, (this.waterfallPos.y - this.listenerCamY) * 0.65);
        if (wDist3d < WATERFALL_MAX_DIST_M) {
          const u = wDist3d / WATERFALL_MAX_DIST_M;
          const win = (1 - u * u) * (1 - u * u);
          const roarGain = ((0.072 * win) / (1 + 0.0085 * wDist3d * wDist3d)) * (1 - underWeight * 0.52);
          const mistGain = ((0.058 * win) / (1 + 0.014 * wDist3d * wDist3d)) * (1 - underWeight * 0.82);
          const wPan = stereoAzimuthPan(wdx, wdz, wHoriz, yaw) * clamp(wHoriz / 6, 0.18, 0.95);
          this.waterfallRoarGain.gain.setTargetAtTime(roarGain, time, 0.18);
          this.waterfallGain.gain.setTargetAtTime(mistGain, time, 0.18);
          this.waterfallPan.pan.setTargetAtTime(wPan, time, 0.18);
          if (this.waterfallRoarFilter) {
            const roarHz = sub > 0.5 ? 145 : Math.max(165, 265 - wDist3d * 0.9 - sub * 180);
            this.waterfallRoarFilter.frequency.setTargetAtTime(roarHz, time, 0.18);
          }
          if (this.waterfallFilter) {
            const mistHz = sub > 0.5 ? 320 : Math.max(480, 1120 - wDist3d * 4.8 - sub * 1100);
            this.waterfallFilter.frequency.setTargetAtTime(mistHz, time, 0.18);
          }
        } else {
          this.waterfallRoarGain.gain.setTargetAtTime(0, time, 0.2);
          this.waterfallGain.gain.setTargetAtTime(0, time, 0.2);
        }
      } else {
        this.waterfallRoarGain.gain.setTargetAtTime(0, time, 0.2);
        this.waterfallGain.gain.setTargetAtTime(0, time, 0.2);
      }
    }

    if (this.brookGain && this.brookPan) {
      if (this.waterfallPos.active && this.brookMouthPos.active) {
        const ax = this.waterfallPos.x;
        const az = this.waterfallPos.z;
        const abx = this.brookMouthPos.x - ax;
        const abz = this.brookMouthPos.z - az;
        const abLenSq = abx * abx + abz * abz;
        brookSegT = abLenSq > 1e-4 ? clamp(((x - ax) * abx + (z - az) * abz) / abLenSq, 0, 1) : 0;
        const sx = ax + abx * brookSegT;
        const sy = this.waterfallPos.y + (this.brookMouthPos.y - this.waterfallPos.y) * brookSegT;
        const sz = az + abz * brookSegT;
        const bdx = sx - x;
        const bdz = sz - z;
        const bHoriz = Math.hypot(bdx, bdz);
        const bDist3d = Math.hypot(bHoriz, (sy - this.listenerCamY) * 0.65);
        brookDistForSparkle = bDist3d;
        if (bDist3d < WATERFALL_MAX_DIST_M) {
          const bu = bDist3d / WATERFALL_MAX_DIST_M;
          const bWin = (1 - bu * bu) * (1 - bu * bu);
          const streamContour = 0.58 + 0.42 * Math.sin(brookSegT * Math.PI * 0.85 + 0.25);
          const bGain =
            ((0.036 * bWin * streamContour) / (1 + 0.018 * bDist3d * bDist3d)) * (1 - underWeight * 0.88);
          brookPanForSparkle = stereoAzimuthPan(bdx, bdz, bHoriz, yaw) * clamp(bHoriz / 4.5, 0.15, 0.92);
          this.brookGain.gain.setTargetAtTime(bGain, time, 0.18);
          this.brookPan.pan.setTargetAtTime(brookPanForSparkle, time, 0.18);
          if (this.brookFilter) {
            const brookHz =
              sub > 0.5 ? 340 : Math.max(620, 1560 - brookSegT * 240 - bDist3d * 5.2 - sub * 1400);
            this.brookFilter.frequency.setTargetAtTime(brookHz, time, 0.18);
          }
        } else {
          this.brookGain.gain.setTargetAtTime(0, time, 0.2);
        }
      } else {
        this.brookGain.gain.setTargetAtTime(0, time, 0.2);
      }
    }

    // Underwater sub-bus + procedural bubble/chime/Echo Whale/brook-sparkle/seabird scheduler
    if (this.underwaterBus) {
      this.underwaterBus.gain.setTargetAtTime(underWeight * 0.88, time, 0.16);
      if (this.uwWashGain) {
        const nearSurface = clamp(1 + (this.listenerCamY - ARENA_WATER_Y) / 22, 0, 1);
        this.uwWashGain.gain.setTargetAtTime(0.07 + 0.16 * nearSurface * nearSurface, time, 0.2);
      }
      if (this.uwRushGain && this.uwRushFilter) {
        const motionSpeed = Math.max(this.swimSpeed, boatingSpeed * 0.4);
        const rushAmt = 0.18 * Math.pow(clamp(motionSpeed / 6.5, 0, 1), 1.2);
        this.uwRushGain.gain.setTargetAtTime(rushAmt, time, 0.15);
        this.uwRushFilter.frequency.setTargetAtTime(220 + motionSpeed * 32, time, 0.15);
      }
      if (this.ctx.state === 'running' && masterGain > 0.005) {
        if (sub < 0.35 && brookDistForSparkle < 52) {
          this.scheduleBrookSparkles(time, brookDistForSparkle, brookPanForSparkle, brookSegT);
        }
        if (sub > 0.5) {
          this.scheduleUnderwaterEvents(time);
        } else if (sub < 0.2) {
          const coastalPresence = Math.max(shore, inland * 0.85, 0.36);
          this.scheduleCoastalBirdCall(time, coastalPresence, dx, dz, yaw);
        }
      }
    }
  }

  step(x: number, z: number, lx: number, lz: number, yaw: number, impact: number, wood: boolean): void {
    if (!this.ctx || !this.surfaceBus || this.ctx.state !== 'running' || this.muted) return;
    const dx = x - lx;
    const dz = z - lz;
    const distance = Math.hypot(dx, dz);
    if (distance > 18) return;
    const gain = this.ctx.createGain();
    const pan = this.ctx.createStereoPanner();
    gain.gain.value = impact / (1 + 0.18 * distance * distance);
    pan.pan.value = stereoAzimuthPan(dx, dz, distance, yaw);
    pan.connect(gain).connect(this.surfaceBus);
    footstep(wood ? 'wood' : 'stone', impact, pan);
    setTimeout(() => {
      pan.disconnect();
      gain.disconnect();
    }, 240);
  }

  /** Subtle water blade dip + soft timber oarlock creak when rowing within earshot. */
  oarSplash(x: number, z: number, lx: number, lz: number, yaw: number, strength = 0.6): void {
    if (!this.ctx || !this.surfaceBus || !this.splashBuf || this.ctx.state !== 'running' || this.muted) return;
    const dx = x - lx;
    const dz = z - lz;
    const distance = Math.hypot(dx, dz);
    if (distance > 26) return;
    const now = this.ctx.currentTime;
    const atten = (strength * 0.14) / (1 + 0.12 * distance * distance);

    const src = this.ctx.createBufferSource();
    src.buffer = this.splashBuf;
    src.playbackRate.value = 0.85 + Math.random() * 0.25;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(520, now);
    bp.frequency.exponentialRampToValueAtTime(240, now + 0.26);
    bp.Q.value = 1.4;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(atten, now + 0.035);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = stereoAzimuthPan(dx, dz, distance, yaw);
    src.connect(bp).connect(env).connect(pan).connect(this.surfaceBus);
    src.start(now);
    src.stop(now + 0.3);

    const creak = this.ctx.createOscillator();
    const creakGain = this.ctx.createGain();
    creak.type = 'triangle';
    creak.frequency.setValueAtTime(168 + Math.random() * 24, now);
    creak.frequency.exponentialRampToValueAtTime(132, now + 0.14);
    creakGain.gain.setValueAtTime(0.0001, now);
    creakGain.gain.linearRampToValueAtTime(atten * 0.18, now + 0.025);
    creakGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    creak.connect(creakGain).connect(pan);
    creak.start(now);
    creak.stop(now + 0.16);
    setTimeout(() => {
      pan.disconnect();
      env.disconnect();
      bp.disconnect();
      creakGain.disconnect();
    }, 340);
  }

  /** Positional water-entry splash, wading splash, or dive resurface burst. */
  waterSplash(
    x: number,
    z: number,
    lx: number,
    lz: number,
    yaw: number,
    strength = 0.7,
    deep = false,
  ): void {
    if (!this.ctx || !this.surfaceBus || !this.splashBuf || this.ctx.state !== 'running' || this.muted) return;
    const dx = x - lx;
    const dz = z - lz;
    const distance = Math.hypot(dx, dz);
    if (distance > 30) return;
    const now = this.ctx.currentTime;
    const atten = (clamp(strength, 0.1, 1.2) * 0.18) / (1 + 0.1 * distance * distance);

    const src = this.ctx.createBufferSource();
    src.buffer = this.splashBuf;
    src.playbackRate.value = deep ? 0.66 + Math.random() * 0.18 : 0.92 + Math.random() * 0.25;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(deep ? 390 : 680, now);
    bp.frequency.exponentialRampToValueAtTime(deep ? 165 : 260, now + 0.36);
    bp.Q.value = 1.05;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(atten, now + 0.028);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = stereoAzimuthPan(dx, dz, distance, yaw);
    src.connect(bp).connect(env).connect(pan).connect(this.surfaceBus);
    src.start(now);
    src.stop(now + 0.41);

    // Subtle cavity bubble pop on deep entry
    if (deep) {
      const pop = this.ctx.createOscillator();
      const popGain = this.ctx.createGain();
      pop.type = 'sine';
      pop.frequency.setValueAtTime(220, now + 0.04);
      pop.frequency.exponentialRampToValueAtTime(480, now + 0.19);
      popGain.gain.setValueAtTime(0.0001, now + 0.04);
      popGain.gain.linearRampToValueAtTime(atten * 0.35, now + 0.065);
      popGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.21);
      pop.connect(popGain).connect(pan);
      pop.start(now + 0.04);
      pop.stop(now + 0.22);
      setTimeout(() => popGain.disconnect(), 460);
    }

    setTimeout(() => {
      pan.disconnect();
      env.disconnect();
      bp.disconnect();
    }, 460);
  }

  /**
   * Zero-allocation positional jumping-fish water-break (`'exit'`) and water re-entry (`'reentry'`) splash foley.
   * Audible within <= 42 m, rate-limited across simultaneous schools, muted when deeply underwater,
   * and routed through `surfaceBus` -> `bus` (inheriting -12 dB `VOICE_DUCK_GAIN` ducking).
   */
  triggerFishLeapSplash(
    x: number,
    z: number,
    listenerX: number,
    listenerZ: number,
    listenerYaw: number,
    kind: 'exit' | 'reentry',
    strength = 0.7,
  ): void {
    if (!this.ctx || !this.surfaceBus || this.fishSplashPool.length === 0 || this.ctx.state !== 'running' || this.muted) {
      return;
    }
    // Mute completely when deeply submerged; fade out smoothly in shallow dives
    if (this.submersion > 0.78 && this.listenerCamY < ARENA_WATER_Y - 1.8) return;
    const subGain = this.submersion > 0.3 ? clamp(1 - (this.submersion - 0.3) / 0.55, 0, 1) : 1;
    if (subGain <= 0.02) return;

    const dx = x - listenerX;
    const dz = z - listenerZ;
    const distance = Math.hypot(dx, dz);
    if (!Number.isFinite(distance) || distance > FISH_SPLASH_MAX_DIST_M) return;

    const now = this.ctx.currentTime;
    if (now - this.lastFishSplashAt < FISH_SPLASH_MIN_INTERVAL_SEC) return;
    if (kind === 'exit' && now - this.lastFishExitAt < 0.14) return;
    if (kind === 'reentry' && now - this.lastFishReentryAt < 0.14) return;

    let slot: FishSplashVoice | null = null;
    for (let i = 0; i < this.fishSplashPool.length; i++) {
      if (this.fishSplashPool[i].busyUntil <= now) {
        slot = this.fishSplashPool[i];
        break;
      }
    }
    if (!slot) return;

    this.lastFishSplashAt = now;
    if (kind === 'exit') this.lastFishExitAt = now;
    else this.lastFishReentryAt = now;

    const u = distance / FISH_SPLASH_MAX_DIST_M;
    const edgeWin = (1 - u * u) * (1 - u * u);
    const clampedStrength = clamp(strength, 0.15, 1.25);
    const basePeak = kind === 'reentry' ? 0.072 : 0.052;
    const atten = ((basePeak * clampedStrength * edgeWin) / (1 + 0.032 * distance * distance)) * subGain;
    if (atten <= 0.00025) return;

    const panVal = stereoAzimuthPan(dx, dz, distance, listenerYaw);
    slot.pan.pan.setValueAtTime(panVal, now);

    if (kind === 'exit') {
      // Crisp silver surface-tension break + light upward tail-flick droplet
      const dur = 0.135;
      slot.bp.Q.setValueAtTime(1.55, now);
      slot.bp.frequency.cancelScheduledValues(now);
      slot.bp.frequency.setValueAtTime(920 + Math.random() * 180, now);
      slot.bp.frequency.exponentialRampToValueAtTime(1680 + Math.random() * 220, now + 0.045);
      slot.bp.frequency.exponentialRampToValueAtTime(620, now + dur);

      slot.noiseGain.gain.cancelScheduledValues(now);
      slot.noiseGain.gain.setValueAtTime(0.0001, now);
      slot.noiseGain.gain.linearRampToValueAtTime(atten, now + 0.014);
      slot.noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      const popStart = now + 0.01;
      const popDur = 0.065;
      const f0 = 540 + Math.random() * 140;
      slot.popOsc.frequency.cancelScheduledValues(popStart);
      slot.popOsc.frequency.setValueAtTime(f0, popStart);
      slot.popOsc.frequency.exponentialRampToValueAtTime(f0 * 1.75, popStart + popDur);
      slot.popGain.gain.cancelScheduledValues(now);
      slot.popGain.gain.setValueAtTime(0.0001, now);
      slot.popGain.gain.setValueAtTime(0.0001, popStart);
      slot.popGain.gain.linearRampToValueAtTime(atten * 0.28, popStart + 0.008);
      slot.popGain.gain.exponentialRampToValueAtTime(0.0001, popStart + popDur);
      slot.busyUntil = now + dur + 0.025;
    } else {
      // Rounder water-cavity re-entry plop + rising droplet bubble pop
      const dur = 0.215;
      slot.bp.Q.setValueAtTime(1.25, now);
      slot.bp.frequency.cancelScheduledValues(now);
      slot.bp.frequency.setValueAtTime(700 + Math.random() * 140, now);
      slot.bp.frequency.exponentialRampToValueAtTime(280, now + dur);

      slot.noiseGain.gain.cancelScheduledValues(now);
      slot.noiseGain.gain.setValueAtTime(0.0001, now);
      slot.noiseGain.gain.linearRampToValueAtTime(atten, now + 0.018);
      slot.noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      const popStart = now + 0.024;
      const popDur = 0.095;
      const f0 = 250 + Math.random() * 90;
      slot.popOsc.frequency.cancelScheduledValues(popStart);
      slot.popOsc.frequency.setValueAtTime(f0, popStart);
      slot.popOsc.frequency.exponentialRampToValueAtTime(f0 * 2.25, popStart + popDur);
      slot.popGain.gain.cancelScheduledValues(now);
      slot.popGain.gain.setValueAtTime(0.0001, now);
      slot.popGain.gain.setValueAtTime(0.0001, popStart);
      slot.popGain.gain.linearRampToValueAtTime(atten * 0.42, popStart + 0.012);
      slot.popGain.gain.exponentialRampToValueAtTime(0.0001, popStart + popDur);
      slot.busyUntil = now + dur + 0.03;
    }
  }

  /** Rhythmic surface swim stroke or muffled underwater fin kick. */
  swimStroke(
    x: number,
    z: number,
    lx: number,
    lz: number,
    yaw: number,
    underwater = false,
    strength = 0.55,
  ): void {
    const targetBus = underwater ? this.underwaterBus ?? this.surfaceBus : this.surfaceBus;
    if (!this.ctx || !targetBus || !this.splashBuf || this.ctx.state !== 'running' || this.muted) return;
    const dx = x - lx;
    const dz = z - lz;
    const distance = Math.hypot(dx, dz);
    if (distance > 22) return;
    const now = this.ctx.currentTime;
    const atten = (clamp(strength, 0.1, 1) * 0.1) / (1 + 0.14 * distance * distance);

    const src = this.ctx.createBufferSource();
    src.buffer = this.splashBuf;
    src.playbackRate.value = underwater ? 0.52 + Math.random() * 0.14 : 0.84 + Math.random() * 0.2;
    const filter = this.ctx.createBiquadFilter();
    filter.type = underwater ? 'lowpass' : 'bandpass';
    filter.frequency.setValueAtTime(underwater ? 310 : 540, now);
    filter.frequency.exponentialRampToValueAtTime(underwater ? 150 : 250, now + 0.26);
    filter.Q.value = 0.9;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(atten, now + 0.045);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = stereoAzimuthPan(dx, dz, distance, yaw);
    src.connect(filter).connect(env).connect(pan).connect(targetBus);
    src.start(now);
    src.stop(now + 0.3);
    setTimeout(() => {
      pan.disconnect();
      env.disconnect();
      filter.disconnect();
    }, 340);
  }

  /** Fishing rod cast whoosh + spool whirr. */
  fishingCast(x: number, z: number, lx: number, lz: number, yaw: number): void {
    if (!this.ctx || !this.surfaceBus || !this.splashBuf || this.ctx.state !== 'running' || this.muted) return;
    const dx = x - lx;
    const dz = z - lz;
    const distance = Math.hypot(dx, dz);
    if (distance > 20) return;
    const now = this.ctx.currentTime;
    const atten = 0.095 / (1 + 0.12 * distance * distance);

    const src = this.ctx.createBufferSource();
    src.buffer = this.splashBuf;
    src.playbackRate.value = 1.35;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(480, now);
    bp.frequency.exponentialRampToValueAtTime(1950, now + 0.14);
    bp.frequency.exponentialRampToValueAtTime(720, now + 0.28);
    bp.Q.value = 1.6;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(atten, now + 0.05);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = stereoAzimuthPan(dx, dz, distance, yaw);
    src.connect(bp).connect(env).connect(pan).connect(this.surfaceBus);
    src.start(now);
    src.stop(now + 0.32);
    setTimeout(() => {
      pan.disconnect();
      env.disconnect();
      bp.disconnect();
    }, 360);
  }

  /** Bobber water landing plop or sharp fish bite splash. */
  fishingSplash(bobberX: number, bobberZ: number, lx: number, lz: number, yaw: number, bite = false): void {
    this.waterSplash(bobberX, bobberZ, lx, lz, yaw, bite ? 0.82 : 0.45, bite);
    if (!bite || !this.ctx || !this.bus || this.ctx.state !== 'running' || this.muted) return;
    // Crisp alert double-ping so learners recognize a bite immediately
    const now = this.ctx.currentTime;
    [783.99, 1046.5].forEach((freq, idx) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      const at = now + idx * 0.075;
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(0.042, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(g).connect(this.bus!);
      osc.start(at);
      osc.stop(at + 0.18);
      setTimeout(() => g.disconnect(), 300);
    });
  }

  /** Rate-limited mechanical fishing reel ratchet click pitched subtly by line tension (0..1). */
  fishingReelClick(tension: number, fishPulling = false): void {
    if (!this.ctx || !this.surfaceBus || this.ctx.state !== 'running' || this.muted) return;
    const now = this.ctx.currentTime;
    const minInterval = fishPulling ? 0.055 : 0.082;
    if (now - this.lastReelClickAt < minInterval) return;
    this.lastReelClickAt = now;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    const clampedT = clamp(tension, 0, 1);
    osc.frequency.setValueAtTime(820 + clampedT * 680 + (fishPulling ? 180 : 0), now);
    osc.frequency.exponentialRampToValueAtTime(420 + clampedT * 240, now + 0.028);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.022 + clampedT * 0.018, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.032);
    osc.connect(gain).connect(this.surfaceBus);
    osc.start(now);
    osc.stop(now + 0.036);
    setTimeout(() => gain.disconnect(), 80);
  }

  /** Celebratory warm tropical marimba arpeggio when landing a catch. */
  fishingCatch(legendary = false): void {
    if (!this.ctx || !this.bus || this.ctx.state !== 'running' || this.muted) return;
    const now = this.ctx.currentTime;
    const notes = legendary ? [523.25, 659.25, 783.99, 1046.5, 1318.5] : [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      const at = now + i * 0.085;
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(0.048, at + 0.014);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.38);
      osc.connect(g).connect(this.bus!);
      osc.start(at);
      osc.stop(at + 0.4);
      setTimeout(() => g.disconnect(), 520 + i * 90);
    });
  }

  /** Leafy palm/canopy rustle burst when shaking a tropical fruit tree. */
  treeShake(x: number, z: number, lx: number, lz: number, yaw: number): void {
    if (!this.ctx || !this.surfaceBus || !this.splashBuf || this.ctx.state !== 'running' || this.muted) return;
    const dx = x - lx;
    const dz = z - lz;
    const distance = Math.hypot(dx, dz);
    if (distance > 20) return;
    const now = this.ctx.currentTime;
    const atten = 0.085 / (1 + 0.14 * distance * distance);

    const src = this.ctx.createBufferSource();
    src.buffer = this.splashBuf;
    src.playbackRate.value = 1.15;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1450, now);
    bp.frequency.exponentialRampToValueAtTime(780, now + 0.34);
    bp.Q.value = 0.85;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(atten, now + 0.04);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = stereoAzimuthPan(dx, dz, distance, yaw);
    src.connect(bp).connect(env).connect(pan).connect(this.surfaceBus);
    src.start(now);
    src.stop(now + 0.38);
    setTimeout(() => {
      pan.disconnect();
      env.disconnect();
      bp.disconnect();
    }, 420);
  }

  /** Organic sandy thud when a coconut, mango, banana bunch, or papaya lands on the ground. */
  fruitDrop(
    x: number,
    z: number,
    lx: number,
    lz: number,
    yaw: number,
    strength = 0.65,
    sandy = true,
  ): void {
    if (!this.ctx || !this.surfaceBus || !this.splashBuf || this.ctx.state !== 'running' || this.muted) return;
    const dx = x - lx;
    const dz = z - lz;
    const distance = Math.hypot(dx, dz);
    if (distance > 20) return;
    const now = this.ctx.currentTime;
    const atten = (clamp(strength, 0.1, 1) * 0.12) / (1 + 0.15 * distance * distance);
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = stereoAzimuthPan(dx, dz, distance, yaw);
    pan.connect(this.surfaceBus);

    // Low organic body thump
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(sandy ? 128 : 162, now);
    osc.frequency.exponentialRampToValueAtTime(sandy ? 54 : 72, now + 0.11);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(atten, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
    osc.connect(g).connect(pan);
    osc.start(now);
    osc.stop(now + 0.14);

    // Soft sand/leaf grain scatter
    const src = this.ctx.createBufferSource();
    src.buffer = this.splashBuf;
    src.playbackRate.value = 0.75;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = sandy ? 580 : 950;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(atten * 0.45, now);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    src.connect(lp).connect(ng).connect(pan);
    src.start(now);
    src.stop(now + 0.1);

    setTimeout(() => {
      g.disconnect();
      ng.disconnect();
      lp.disconnect();
      pan.disconnect();
    }, 200);
  }

  /** Warm coastal harmonic cue when interacting with a beacon, fruit harvest, or speaking board. */
  interactCue(bright = true): void {
    if (!this.ctx || !this.bus || this.ctx.state !== 'running' || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(bright ? 523.25 : 392.0, now);
    osc.frequency.exponentialRampToValueAtTime(bright ? 659.25 : 329.63, now + 0.16);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.045, now + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain).connect(this.bus);
    osc.start(now);
    osc.stop(now + 0.24);
    setTimeout(() => gain.disconnect(), 280);
  }

  dispose(): void {
    for (const voice of this.engines.values()) {
      try {
        voice.tone.stop();
      } catch {
        /* already stopped */
      }
      voice.tone.disconnect();
      voice.gain.disconnect();
      voice.pan.disconnect();
    }
    this.engines.clear();

    const stopSource = (s?: AudioScheduledSourceNode) => {
      if (!s) return;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    };

    stopSource(this.noise);
    stopSource(this.breezeSrc);
    stopSource(this.waterfallRoarSrc);
    stopSource(this.waterfallSrc);
    stopSource(this.brookSrc);
    stopSource(this.fishNoiseSrc);
    stopSource(this.uwRumbleSrc);
    stopSource(this.uwWashSrc);
    this.uwLfos.forEach(stopSource);
    this.uwLfos.length = 0;
    this.uwDroneOscs.forEach(stopSource);
    this.uwDroneOscs.length = 0;

    for (const pool of [this.bubblePool, this.chimePool, this.whalePool, this.brookPool, this.birdPool]) {
      for (const v of pool) {
        stopSource(v.osc);
        v.gain.disconnect();
        v.pan.disconnect();
        v.wetSend.disconnect();
      }
      pool.length = 0;
    }

    for (const fv of this.fishSplashPool) {
      stopSource(fv.popOsc);
      fv.bp.disconnect();
      fv.noiseGain.disconnect();
      fv.popGain.disconnect();
      fv.pan.disconnect();
    }
    this.fishSplashPool.length = 0;

    this.filter?.disconnect();
    this.surf?.disconnect();
    this.pan?.disconnect();
    this.breezeFilter?.disconnect();
    this.breezeGain?.disconnect();
    this.waterfallRoarFilter?.disconnect();
    this.waterfallRoarGain?.disconnect();
    this.waterfallFilter?.disconnect();
    this.waterfallGain?.disconnect();
    this.waterfallPan?.disconnect();
    this.brookFilter?.disconnect();
    this.brookGain?.disconnect();
    this.brookPan?.disconnect();
    this.birdFilter?.disconnect();
    this.surfaceSubmergeFilter?.disconnect();
    this.surfaceBus?.disconnect();
    this.uwRumbleFilter?.disconnect();
    this.uwRumbleGain?.disconnect();
    this.uwWashFilter?.disconnect();
    this.uwWashGain?.disconnect();
    this.uwRushFilter?.disconnect();
    this.uwRushGain?.disconnect();
    this.uwDroneGain?.disconnect();
    this.uwWetGain?.disconnect();
    this.uwConvolver?.disconnect();
    this.underwaterBus?.disconnect();
    this.bus?.disconnect();
    this.bus = undefined;
    this.ctx = null;
  }
}
