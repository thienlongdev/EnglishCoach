// Contract tests for Echo Life Spatial Environmental & Foley Audio Engine (worldAudio.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const WORLD_AUDIO_URL = new URL('../src/components/study-space/world/echoLife/worldAudio.ts', import.meta.url);
const SOURCE = readFileSync(WORLD_AUDIO_URL, 'utf8');

const { code: TRANSPILED } = babel.core().transformSync(SOURCE, {
  filename: 'worldAudio.ts',
  configFile: false,
  babelrc: false,
  presets: [babel.presetTypescript()],
  plugins: [babel.pluginTransformModulesCommonjs()],
});

function loadWorldAudio({ windowObj, documentObj, sharedCtx = null } = {}) {
  const mod = { exports: {} };
  const customRequire = id => {
    if (id === '@/lib/embodiment/contactAudio') {
      return { contactAudioContext: () => sharedCtx };
    }
    throw new Error(`Unexpected import in worldAudio.ts: ${id}`);
  };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: customRequire,
    console,
    Math,
    Object,
    Set,
    Float32Array,
    Number,
    JSON,
    setTimeout,
    clearTimeout,
    window: windowObj,
    document: documentObj,
  };
  runInNewContext(TRANSPILED, sandbox);
  return mod.exports;
}

function createMockAudioParam(initial = 0) {
  const calls = [];
  return {
    value: initial,
    calls,
    setValueAtTime(v, t) { this.value = v; calls.push(['set', v, t]); },
    exponentialRampToValueAtTime(v, t) { this.value = v; calls.push(['exp', v, t]); },
    setTargetAtTime(v, t, tau) { this.value = v; calls.push(['target', v, t, tau]); },
  };
}

function createMockAudioContext() {
  const created = {
    buffers: [],
    bufferSources: [],
    oscillators: [],
    gains: [],
    filters: [],
    panners: [],
    compressors: [],
    closed: false,
  };

  const makeNode = (extra = {}) => ({
    connectedTo: [],
    disconnected: false,
    connect(dest) { this.connectedTo.push(dest); return dest; },
    disconnect() { this.disconnected = true; },
    ...extra,
  });

  const ctx = {
    state: 'running',
    sampleRate: 44100,
    currentTime: 10.0,
    destination: makeNode({ kind: 'destination' }),
    resume: async () => { ctx.state = 'running'; },
    close: async () => { created.closed = true; },
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      const buf = {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData(c) { return data[c]; },
      };
      created.buffers.push(buf);
      return buf;
    },
    createBufferSource() {
      const node = makeNode({
        kind: 'bufferSource',
        buffer: null,
        loop: false,
        playbackRate: createMockAudioParam(1),
        started: false,
        stopped: false,
        start() { this.started = true; },
        stop() { this.stopped = true; },
      });
      created.bufferSources.push(node);
      return node;
    },
    createOscillator() {
      const node = makeNode({
        kind: 'oscillator',
        type: 'sine',
        frequency: createMockAudioParam(440),
        started: false,
        stopped: false,
        start() { this.started = true; },
        stop() { this.stopped = true; },
      });
      created.oscillators.push(node);
      return node;
    },
    createGain() {
      const node = makeNode({ kind: 'gain', gain: createMockAudioParam(1) });
      created.gains.push(node);
      return node;
    },
    createBiquadFilter() {
      const node = makeNode({
        kind: 'filter',
        type: 'lowpass',
        frequency: createMockAudioParam(350),
        Q: createMockAudioParam(1),
      });
      created.filters.push(node);
      return node;
    },
    createStereoPanner() {
      const node = makeNode({ kind: 'panner', pan: createMockAudioParam(0) });
      created.panners.push(node);
      return node;
    },
    createDynamicsCompressor() {
      const node = makeNode({
        kind: 'compressor',
        threshold: createMockAudioParam(-24),
        knee: createMockAudioParam(30),
        ratio: createMockAudioParam(12),
        attack: createMockAudioParam(0.003),
        release: createMockAudioParam(0.25),
      });
      created.compressors.push(node);
      return node;
    },
  };

  return { ctx, created };
}

// ── 1. Surface classifier (6 distinct surfaces) ──────────────────────────────────────────────────────────
{
  const { classifyFootSurface } = loadWorldAudio();
  assert.equal(classifyFootSurface('park', 'park'), 'grass');
  assert.equal(classifyFootSurface('garden', 'botanical'), 'grass');
  assert.equal(classifyFootSurface(null, 'greenway'), 'grass');

  assert.equal(classifyFootSurface('road', 'street'), 'asphalt');
  assert.equal(classifyFootSurface('crossing', 'street'), 'asphalt');

  assert.equal(classifyFootSurface('sidewalk', 'street'), 'paver');
  assert.equal(classifyFootSurface('plaza', 'campus'), 'paver');
  assert.equal(classifyFootSurface('door:cafe', 'street'), 'paver');

  assert.equal(classifyFootSurface('study', 'study', false, 'oak'), 'wood');
  assert.equal(classifyFootSurface('living', 'house'), 'wood');
  assert.equal(classifyFootSurface('prop_stairs', 'house'), 'wood');
  assert.equal(classifyFootSurface('door:house', 'house'), 'wood');

  assert.equal(classifyFootSurface('kitchen', 'house'), 'tile');
  assert.equal(classifyFootSurface('bath', 'house'), 'tile');
  assert.equal(classifyFootSurface('cafe', 'cafe'), 'tile');
  assert.equal(classifyFootSurface('study', 'study', false, 'marble'), 'tile');
  assert.equal(classifyFootSurface('study', 'study', false, 'tile'), 'tile');

  assert.equal(classifyFootSurface('study', 'study', true, 'oak'), 'carpet', 'rug overrides wood floor');
  assert.equal(classifyFootSurface('study', 'study', false, 'carpet'), 'carpet');
  assert.equal(classifyFootSurface('park', 'park', true), 'carpet', 'rug flag always resolves to carpet');
}

// ── 2. Acoustic indoor/outdoor muffling curve ────────────────────────────────────────────────────────────
{
  const { computeOutdoorOcclusion } = loadWorldAudio();
  const out = computeOutdoorOcclusion(false, false);
  const openWin = computeOutdoorOcclusion(true, true);
  const closedIn = computeOutdoorOcclusion(true, false);

  assert.equal(out.cutoffHz, 20000);
  assert.equal(out.gain, 1.0);
  assert.equal(openWin.cutoffHz, 2400);
  assert.ok(openWin.gain > closedIn.gain && openWin.gain < out.gain);
  assert.equal(closedIn.cutoffHz, 480);
  assert.ok(out.cutoffHz > openWin.cutoffHz && openWin.cutoffHz > closedIn.cutoffHz);
  assert.ok(closedIn.gain > 0 && closedIn.gain < 0.35);
}

// ── 3. Mixer channel math & clamping ─────────────────────────────────────────────────────────────────────
{
  const { normalizeMixer, computeChannelGains, DEFAULT_WORLD_AUDIO_MIXER } = loadWorldAudio();

  const normalized = normalizeMixer({ master: 1.8, ambience: -0.4, foley: Number.NaN, vehiclesUi: 0.5, muted: false });
  assert.equal(normalized.master, 1);
  assert.equal(normalized.ambience, 0);
  assert.equal(normalized.foley, 0);
  assert.equal(normalized.vehiclesUi, 0.5);
  assert.equal(normalized.muted, false);

  const mutedGains = computeChannelGains({ ...DEFAULT_WORLD_AUDIO_MIXER, muted: true });
  assert.deepEqual({ ...mutedGains }, { master: 0, ambience: 0, foley: 0, vehiclesUi: 0 });

  const lowGains = computeChannelGains({ muted: false, master: 0.25, ambience: 0.25, foley: 0.25, vehiclesUi: 0.25 });
  const midGains = computeChannelGains({ muted: false, master: 0.50, ambience: 0.50, foley: 0.50, vehiclesUi: 0.50 });
  const maxGains = computeChannelGains({ muted: false, master: 1.0, ambience: 1.0, foley: 1.0, vehiclesUi: 1.0 });
  assert.ok(lowGains.master > 0 && lowGains.master < midGains.master && midGains.master < maxGains.master);
  assert.equal(maxGains.master, 1);
  assert.equal(computeChannelGains({ muted: false, master: 0, ambience: 0, foley: 0, vehiclesUi: 0 }).master, 0);
}

// ── 4. Birdsong daytime, weather & green-zone gating ─────────────────────────────────────────────────────
{
  const { birdsongDensity } = loadWorldAudio();

  const morningPark = birdsongDensity(8.0, 0, 0, false, false, 'park');
  const afternoonPark = birdsongDensity(15.5, 0, 0, false, false, 'park');
  const morningBotanical = birdsongDensity(7.5, 0, 0, false, false, 'botanical');
  const morningStreet = birdsongDensity(8.0, 0, 0, false, false, 'street');
  const morningOpenWindow = birdsongDensity(8.0, 0, 0, true, true, 'park');

  assert.ok(morningPark > 0.7, 'clear morning park should have rich birdsong');
  assert.ok(morningPark > afternoonPark && afternoonPark > 0, 'dawn/morning should exceed afternoon');
  assert.ok(morningBotanical > 0.7, 'botanical garden should have rich birdsong');
  assert.ok(morningPark > morningStreet && morningStreet > 0, 'green zone denser than street');
  assert.ok(morningOpenWindow > 0 && morningOpenWindow < morningPark, 'open window passes attenuated birdsong');

  // Strictly silent at night, heavy rain, heavy snow, closed indoor, and non-bird indoor venues
  assert.equal(birdsongDensity(22.5, 0, 0, false, false, 'park'), 0, 'silent late night');
  assert.equal(birdsongDensity(2.0, 0, 0, false, false, 'park'), 0, 'silent midnight');
  assert.equal(birdsongDensity(4.5, 0, 0, false, false, 'park'), 0, 'silent pre-dawn');
  assert.equal(birdsongDensity(8.5, 0.35, 0, false, false, 'park'), 0, 'silent during heavy rain');
  assert.equal(birdsongDensity(8.5, 0.25, 0, false, false, 'park'), 0, 'silent at rain threshold');
  assert.equal(birdsongDensity(8.5, 0, 0.30, false, false, 'park'), 0, 'silent during snow');
  assert.equal(birdsongDensity(8.5, 0, 0, true, false, 'park'), 0, 'silent indoors with closed window');
  assert.equal(birdsongDensity(8.5, 0, 0, false, false, 'electronics_shop'), 0, 'silent in indoor shop zone');
}

// ── 5. Spatial river distance attenuation & stereo panner clamping ───────────────────────────────────────
{
  const { computeRiverSpatial } = loadWorldAudio();
  const river = { x0: -60, x1: 60, z0: -38, z1: -26 };

  const close = computeRiverSpatial({ x: 0, z: -24 }, 0, river); // 2 m south of river
  const mid = computeRiverSpatial({ x: 0, z: -11 }, 0, river);   // 15 m south of river
  const far = computeRiverSpatial({ x: 0, z: 14 }, 0, river);    // 40 m south of river
  const outOfRange = computeRiverSpatial({ x: 0, z: 40 }, 0, river); // 66 m away

  assert.ok(close.gain > mid.gain && mid.gain > far.gain && far.gain > 0, 'river attenuation must decrease monotonically');
  assert.equal(outOfRange.gain, 0, 'river silent past 55 m');
  assert.equal(outOfRange.pan, 0);

  // Directional polarity: player at (0, -16), river is directly North (-Z)
  const facingNorth = computeRiverSpatial({ x: 0, z: -16 }, 0, river);
  const facingEast = computeRiverSpatial({ x: 0, z: -16 }, -Math.PI / 2, river);
  const facingWest = computeRiverSpatial({ x: 0, z: -16 }, Math.PI / 2, river);

  assert.ok(Math.abs(facingNorth.pan) < 1e-6, 'river straight ahead centers pan at 0');
  assert.ok(facingEast.pan < -0.8 && facingEast.pan >= -0.85, 'facing East puts northern river in LEFT ear');
  assert.ok(facingWest.pan > 0.8 && facingWest.pan <= 0.85, 'facing West puts northern river in RIGHT ear');

  // Extreme yaw sweep must always clamp strictly to [-0.85, +0.85]
  for (let i = 0; i < 36; i++) {
    const yaw = (i / 36) * Math.PI * 2;
    const s = computeRiverSpatial({ x: 10, z: -12 }, yaw, river);
    assert.ok(s.pan >= -0.85 && s.pan <= 0.85, `pan out of clamp: ${s.pan}`);
    assert.ok(s.gain >= 0 && s.gain <= 1, `gain out of bounds: ${s.gain}`);
  }

  // Null inputs degrade safely
  assert.deepEqual({ ...computeRiverSpatial(null, 0, river) }, { distance: Infinity, gain: 0, pan: 0 });
  assert.deepEqual({ ...computeRiverSpatial({ x: 0, z: 0 }, 0, null) }, { distance: Infinity, gain: 0, pan: 0 });
}

// ── 6. Headless CI no-throw lifecycle (no window, no document, no AudioContext) ──────────────────────────
{
  const { EchoLifeWorldAudio } = loadWorldAudio({ windowObj: undefined, documentObj: undefined, sharedCtx: null });
  const audio = new EchoLifeWorldAudio();
  assert.equal(audio.unlock(), false, 'headless unlock returns false cleanly');

  const river = { x0: -50, x1: 50, z0: -35, z1: -25 };
  assert.doesNotThrow(() => {
    audio.update({
      dt: 0.016, active: true, pos: { x: 0, z: -20 }, cameraYaw: 0,
      region: 'park', zone: 'park', indoor: false, windowOpen: false,
      hour: 9, rain: 0.5, snow: 0, cloud: 0.7, riverRect: river,
      vehicle: { kind: 'car', speed: 10, throttle: 1, braking: false },
    });
    audio.update({
      dt: 0.016, active: true, pos: { x: 2, z: 2 }, cameraYaw: 1.2,
      region: 'cafe', zone: 'cafe', indoor: true, windowOpen: false,
      hour: 14, rain: 0, snow: 0, cloud: 0.2, riverRect: river,
      vehicle: { kind: 'bike', speed: 5, throttle: 0, braking: false },
    });
    audio.update({
      dt: 0.016, active: false, pos: null, cameraYaw: 0,
      region: null, zone: null, indoor: false, hour: 23, rain: 0, riverRect: null,
    });
    for (const s of ['grass', 'asphalt', 'paver', 'wood', 'tile', 'carpet']) {
      audio.triggerFootstep(s, 0.7, 0.8, false);
      audio.triggerFootstep(s, 0.9, 0.2, true);
    }
    audio.triggerDoor(true, 1.5);
    audio.triggerDoor(false, 2.0);
    for (const k of ['bounce', 'rim', 'backboard', 'swish', 'shoot', 'catch']) {
      audio.triggerBasketball(k, 0.8);
    }
    for (const v of ['car', 'bike', 'motorbike']) audio.triggerHorn(v);
    for (const u of ['tap', 'open', 'close', 'confirm']) audio.triggerUiClick(u);
    audio.toggleMute();
    audio.toggleMute();
    audio.suspend();
    audio.dispose();
  });
}

// ── 7. Full Mock Web Audio Graph, Persistence, Subscriptions & Disposal ────────────────────────────────────
{
  const storage = new Map();
  const winListeners = new Map();
  const windowObj = {
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
    },
    addEventListener: (ev, fn) => {
      if (!winListeners.has(ev)) winListeners.set(ev, new Set());
      winListeners.get(ev).add(fn);
    },
    removeEventListener: (ev, fn) => {
      winListeners.get(ev)?.delete(fn);
    },
  };
  const documentObj = { hidden: false };
  const { ctx, created } = createMockAudioContext();

  const { EchoLifeWorldAudio, AUDIO_STORAGE_KEY } = loadWorldAudio({ windowObj, documentObj, sharedCtx: ctx });
  const audio = new EchoLifeWorldAudio();

  // Gesture listeners registered until unlock succeeds
  assert.equal(winListeners.get('pointerdown')?.size, 1);
  assert.equal(winListeners.get('keydown')?.size, 1);

  // Subscriber & snapshot identity + localStorage persistence
  let notifyCount = 0;
  const unsub = audio.subscribe(() => { notifyCount++; });
  const snap0 = audio.getMixer();
  const snapSame = audio.setMixer({ master: snap0.master });
  assert.equal(snapSame, snap0, 'no-op setMixer preserves snapshot reference');
  assert.equal(notifyCount, 0);

  const snap1 = audio.setMixer({ master: 0.85, ambience: 0.60 });
  assert.notEqual(snap1, snap0);
  assert.equal(notifyCount, 1);
  assert.equal(JSON.parse(storage.get(AUDIO_STORAGE_KEY)).master, 0.85);
  unsub();

  // Unlock builds noise buffers, dynamics limiter, outdoor LPF bus, ambient beds & vehicle graph
  assert.equal(audio.unlock(), true);
  assert.equal(winListeners.get('pointerdown')?.size, 0, 'gesture listeners cleaned up after unlock');
  assert.equal(created.buffers.length, 3, 'white, pink, brown noise buffers created');
  assert.equal(created.buffers[0].duration, 4, '4-second seamless noise buffers');
  assert.equal(created.compressors.length, 1, 'master dynamics limiter present');
  assert.ok(created.panners.length >= 2, 'stereo panners created for river voices');

  // Identify outdoor LPF (initialized at 20000 Hz)
  const outdoorLpf = created.filters.find(f => f.type === 'lowpass' && f.frequency.value === 20000);
  assert.ok(outdoorLpf, 'shared outdoor occlusion LPF exists');

  const river = { x0: -60, x1: 60, z0: -38, z1: -26 };

  // Frame 1: Outdoor rainy morning park next to river, driving EV car
  audio.update({
    dt: 0.05, active: true, pos: { x: 0, z: -20 }, cameraYaw: -Math.PI / 2,
    region: 'park', zone: 'park', indoor: false, windowOpen: false,
    hour: 8.5, rain: 0.65, snow: 0, cloud: 0.8, riverRect: river,
    vehicle: { kind: 'car', speed: 12, throttle: 0.9, braking: false },
  });
  assert.equal(outdoorLpf.frequency.value, 20000);
  assert.ok(created.panners[0].pan.value < -0.7, 'river panned left when facing East');

  // Frame 2: Clear morning park -> birdsong should fire over 3 seconds of simulation
  const oscBeforeBirds = created.oscillators.length;
  for (let i = 0; i < 40; i++) {
    ctx.currentTime += 0.1;
    audio.update({
      dt: 0.1, active: true, pos: { x: 0, z: -20 }, cameraYaw: 0,
      region: 'park', zone: 'park', indoor: false, windowOpen: false,
      hour: 8.0, rain: 0, snow: 0, cloud: 0.1, riverRect: river,
      vehicle: { kind: 'bike', speed: 5.5, throttle: 0, braking: false },
    });
  }
  assert.ok(created.oscillators.length > oscBeforeBirds, 'daytime clear park synthesized procedural birdsong');

  // Frame 3: Inside closed Pixel Café -> LPF shifts to 480 Hz, café murmur + clinks
  audio.update({
    dt: 0.05, active: true, pos: { x: 10, z: 10 }, cameraYaw: 0,
    region: 'cafe', zone: 'cafe', indoor: true, windowOpen: false,
    hour: 13.0, rain: 0.8, snow: 0, cloud: 0.9, riverRect: river,
    vehicle: null,
  });
  assert.equal(outdoorLpf.frequency.value, 480, 'indoor closed muffles outdoor bus to 480 Hz');

  // Frame 4: Inside study room with open window -> LPF shifts to 2400 Hz
  audio.update({
    dt: 0.05, active: true, pos: { x: 0, z: 0 }, cameraYaw: 0,
    region: 'study', zone: 'study', indoor: true, windowOpen: true,
    hour: 10.0, rain: 0.4, snow: 0, cloud: 0.5, riverRect: river,
    vehicle: null,
  });
  assert.equal(outdoorLpf.frequency.value, 2400, 'open window couples outdoor bus at 2400 Hz');

  // Trigger all interactive foley & UI SFX (also exercise door & basketball on a fresh voice budget)
  const sourcesBeforeFoley = created.bufferSources.length;
  const oscBeforeFoley = created.oscillators.length;
  for (const s of ['grass', 'asphalt', 'paver', 'wood', 'tile', 'carpet']) {
    audio.triggerFootstep(s, 0.75, 0.5, s === 'grass');
  }
  // 7th simultaneous voice should be gracefully capped by 6-voice limit without throwing
  audio.triggerFootstep('paver', 0.8, 0.4, false);
  audio.triggerHorn('car');
  audio.triggerHorn('bike');
  audio.triggerHorn('motorbike');
  audio.triggerUiClick('tap');
  audio.triggerUiClick('open');
  audio.triggerUiClick('close');
  audio.triggerUiClick('confirm');
  assert.ok(created.bufferSources.length > sourcesBeforeFoley, 'footstep noise bursts synthesized');
  assert.ok(created.oscillators.length > oscBeforeFoley, 'horn, bell, and UI oscillators synthesized');

  // Exercise door & basketball synthesis cleanly on a separate instance with full foley voice headroom
  const audioFoley = new EchoLifeWorldAudio();
  assert.equal(audioFoley.unlock(), true);
  const oscBeforeCourt = created.oscillators.length;
  const srcBeforeCourt = created.bufferSources.length;
  audioFoley.triggerDoor(true, 1.2);
  audioFoley.triggerDoor(false, 1.5);
  audioFoley.triggerBasketball('bounce', 0.9);
  audioFoley.triggerBasketball('rim', 0.8);
  audioFoley.triggerBasketball('backboard', 0.75);
  audioFoley.triggerBasketball('swish', 0.95);
  assert.ok(created.oscillators.length > oscBeforeCourt, 'door latch + basketball bounce/rim/backboard synthesized');
  assert.ok(created.bufferSources.length > srcBeforeCourt, 'door swing + net swish synthesized');
  audioFoley.dispose();

  // Mute zeroes master + bus gains cleanly
  assert.equal(audio.toggleMute(), true);
  const masterGain = created.gains[0];
  assert.equal(masterGain.gain.value, 0, 'mute zeroes master gain immediately');
  assert.equal(audio.toggleMute(), false);
  assert.ok(masterGain.gain.value > 0, 'unmute restores master gain');

  // Suspend & dispose cleanly without closing shared AudioContext
  audio.suspend();
  audio.dispose();
  assert.equal(created.closed, false, 'dispose must never close the shared AudioContext');
  assert.equal(outdoorLpf.disconnected, true, 'dispose disconnects graph buses');
}

// ── 8. Static hygiene laws on worldAudio.ts ──────────────────────────────────────────────────────────────
{
  const VN_RE = /[ăâđêôơưĂÂĐÊÔƠƯáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵÁÀẢÃẠẤẦẨẪẬẮẰẲẴẶÉÈẺẼẸẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌỐỒỔỖỘỚỜỞỠỢÚÙỦŨỤỨỪỬỮỰÝỲỶỸỴ]/;
  const cleaned = SOURCE.replace(/\bCaf[ée](?![a-zA-Z])/g, '');
  assert.equal(VN_RE.test(cleaned), false, 'worldAudio.ts must be 100% English-only (0 Vietnamese diacritics)');
  assert.equal(/\bSparkles?\b|✨/.test(SOURCE), false, 'worldAudio.ts must have zero Sparkles/emoji');
  assert.equal(/\bfetch\s*\(|openrouter|\/ai\//i.test(SOURCE), false, 'worldAudio.ts must have zero network or AI calls');
}

console.log('PASS echo-life spatial audio engine: all 8 contract groups pass');
