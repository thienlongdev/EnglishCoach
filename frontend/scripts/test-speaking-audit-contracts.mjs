import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

function evaluate(file, deps = {}, globals = {}) {
  const { code } = babel.core().transformSync(read('src/' + file), {
    filename: file,
    configFile: false,
    babelrc: false,
    presets: [babel.presetTypescript()],
    plugins: [babel.pluginTransformModulesCommonjs()],
  });
  const exports = {};
  runInNewContext(code, { exports, require: (name) => deps[name] ?? require(name), AbortController, console, ...globals });
  return exports;
}

function harness() {
  const slots = [];
  let cursor = 0, queue = [], dirty = false, run;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [
        slots[i].value,
        (v) => {
          slots[i].value = typeof v === 'function' ? v(slots[i].value) : v;
          dirty = true;
        },
      ];
    },
    useRef(initial) {
      return (slots[cursor++] ??= { current: initial });
    },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) slots[i] = { fn, deps };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) {
        const old = slots[i];
        slots[i] = { deps };
        queue.push(() => {
          old?.cleanup?.();
          slots[i].cleanup = fn();
        });
      }
    },
  };
  return {
    hooks,
    render(fn = run) {
      run = fn;
      let result, n = 0;
      do {
        dirty = false;
        cursor = 0;
        result = run();
        const work = queue;
        queue = [];
        work.forEach((f) => f());
        assert.ok(++n < 40, 'bounded React updates');
      } while (dirty);
      return result;
    },
    unmount() {
      slots.forEach((s) => s?.cleanup?.());
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

// 1. Audio recorder capture, metering & FE-19 fixes
const recorder = read('src/hooks/useAudioRecorder.ts');
check('FE-03/FE-12/FE-19: useAudioRecorder assessmentMode DSP disable, AnalyserNode metering, monotonic clock & timeSliceMs', () => {
  assert.match(recorder, /assessmentMode\?: boolean/);
  assert.match(recorder, /echoCancellation: false/);
  assert.match(recorder, /noiseSuppression: false/);
  assert.match(recorder, /autoGainControl: false/);
  assert.match(recorder, /channelCount: 1/);
  assert.match(recorder, /audioBitsPerSecond: 128000/);
  assert.match(recorder, /createAnalyser\(\)/);
  assert.match(recorder, /inputLevel/);
  assert.match(recorder, /isClipping/);
  assert.match(recorder, /hasSpeechSignal/);
  assert.match(recorder, /peakLevel/);
  assert.match(recorder, /performance\.now\(\)/);
  assert.match(recorder, /recorder\.start\(effectiveTimeSliceMs\)/);
  assert.doesNotMatch(recorder, /recorder\.start\(100\)/);
  assert.match(recorder, /pendingStopResolversRef/);
});

// 2. API client contract & timeouts
const api = read('src/services/speakingApi.ts');
check('FE-01/FE-10/FE-11/RT-03: speakingApi fidelityStatus, matchPercentage, abstentionReason, connectedSpeech & 90s timeouts', () => {
  assert.match(api, /export interface PronunciationV2ContentFidelity/);
  assert.match(api, /fidelityStatus\?:/);
  assert.match(api, /matchPercentage\?:/);
  assert.match(api, /abstentionReason\?: string \| null/);
  assert.match(api, /connectedSpeech\?: PronunciationV2ConnectedSpeech \| null/);
  assert.match(api, /startTimeMs\?: number \| null/);
  assert.match(api, /endTimeMs\?: number \| null/);
  assert.match(api, /submitRoleplayTurn[\s\S]*?timeout:\s*90000/);
  assert.match(api, /analyzeShadowingAudio[\s\S]*?timeout:\s*90000/);
});

// 3. PronunciationV2Panel provenance & abstention truth
const panel = read('src/components/features/speaking/PronunciationV2Panel.tsx');
check('FE-01/FE-04/FE-08/FE-16/RT-03: PronunciationV2Panel off-script, observedPhone gating, DELETION label, null guards & green check fix', () => {
  assert.match(panel, /contentFidelity\?\.fidelityStatus \?\? contentFidelity\?\.status/);
  assert.match(panel, /contentFidelity\?\.matchPercentage \?\? contentFidelity\?\.contentMatchPercentage/);
  assert.match(panel, /fidelityStatus === 'OFF_SCRIPT'/);
  assert.match(panel, /abstentionReason === 'OFF_SCRIPT'/);
  assert.match(panel, /Đạt chuẩn/);
  assert.match(panel, /Hơi lệch/);
  assert.match(panel, /Cần sửa/);
  assert.match(panel, /Chưa đủ bằng chứng/);
  assert.match(panel, /Bị nuốt âm \/ thiếu âm cuối/);
  assert.match(panel, /p\.observedPhoneConfidence == null \|\| p\.observedPhoneConfidence >= 0\.35/);
  assert.match(panel, /p\.actionable &&[\s\S]*?p\.qualityClass === 'ERROR' &&[\s\S]*?p\.observedPhone/);
  assert.match(panel, /setSelectedWordIdx\(null\)/);
  assert.match(panel, /response\?\.requestId/);
  assert.match(panel, /canShowGreenCheck[\s\S]*?overallScore >= 75[\s\S]*?safeWords\.length > 0[\s\S]*?safeAbstentions\.length === 0/);
  assert.match(panel, /hasConnectedSpeechData/);
  assert.match(panel, /safeAbstentions\.length > 0/);
  assert.doesNotMatch(panel, /\{p\.qualityClass\}/);
});

// 4. Profile, Quick Check, Shadowing, Roleplay & Speaking hub fixes
check('FE-02/FE-15/FE-22: SpeakingProfilePanel V2.2 field names, 5 issue statuses, loading dash & Roleplay audioRef/intonationScore', () => {
  const profile = read('src/components/features/speaking/SpeakingProfilePanel.tsx');
  assert.match(profile, /parsedV2\?\.overall\?\.segmentalScore \?\? parsedV2\?\.overall\?\.phonemeScore/);
  assert.match(profile, /parsedV2\?\.overall\?\.intonationScore \?\? parsedV2\?\.overall\?\.pitchScore/);
  assert.match(profile, /parsedV2\?\.priorities\?\.\[0\]\?\.instructionVi/);
  assert.match(profile, /INSUFFICIENT_DATA/);
  assert.match(profile, /Chưa đủ dữ liệu/);
  assert.match(profile, /RECENTLY_STABLE/);
  assert.match(profile, /Đã ổn định/);
  assert.doesNotMatch(profile, /practiceDays30d \?\? progress\?\.currentStreakDays/);
  assert.match(profile, /Boolean\(turn\.audioRef\)/);
  assert.match(profile, /turn\.intonationScore != null/);
});

check('FE-05/FE-12/FE-22: PushToTalkHub assessmentMode, maxDuration auto-submit + REVIEWING UI, recorderError & min-duration guard', () => {
  const hub = read('src/components/features/speaking/PushToTalkHub.tsx');
  assert.match(hub, /assessmentMode: true/);
  assert.match(hub, /onMaxDurationReached:/);
  assert.match(hub, /isReviewing && !quickCheckResult && !isAnalyzing/);
  assert.match(hub, /analysisError \|\| recorderError/);
  assert.match(hub, /durationRef\.current < 0\.4/);
  assert.match(hub, /activeAttemptIdRef\.current = null/);
});

check('FE-13/FE-14/FE-17/FE-21/FE-24: Navigator precedence, YouSaid null guard, ActiveSentence token IPA, AttemptAudioPlayer lazy decode, Drawer & materialId redirect', () => {
  const nav = read('src/components/features/speaking/SentenceNavigator.tsx');
  assert.match(nav, /progress\?\.bestAccuracy \?\? unit\.bestAccuracy/);
  assert.doesNotMatch(nav, /progressMap\[u\.id\] \|\| progressMap\[idx\]/);
  assert.doesNotMatch(nav, /progressMap\[unit\.id\] \|\| progressMap\[originalIndex\]/);

  const youSaid = read('src/components/features/speaking/ShadowingYouSaidPanel.tsx');
  assert.match(youSaid, /Khớp nội dung —/);

  const activeSent = read('src/components/features/speaking/ShadowingActiveSentence.tsx');
  assert.match(activeSent, /wordIpaByIndex\[idx\]/);
  assert.doesNotMatch(activeSent, /phát âm & ví dụ/);

  const player = read('src/components/features/speaking/AttemptAudioPlayer.tsx');
  assert.match(player, /formatAudioTime\(currentTime, "0:00"\)/);
  assert.match(player, /decodeDurationLazily/);

  const drawer = read('src/components/features/speaking/ProgressiveFeedbackDrawer.tsx');
  assert.doesNotMatch(drawer, /length \|\| 0\}\/2/);
  assert.match(drawer, /COLLOCATION/);

  const hubPage = read('src/app/speaking/page.tsx');
  assert.match(hubPage, /searchParams\.get\("materialId"\)/);
  assert.match(hubPage, /\/speaking\/shadowing\/\$\{materialIdParam\.trim\(\)\}/);
});

check('FE-06/FE-07/FE-09/FE-10/FE-11/FE-14/FE-18/FE-20: Shadowing & Roleplay pages reliability guards', () => {
  const sh = read('src/app/speaking/shadowing/[id]/page.tsx');
  assert.match(sh, /assessmentMode: true/);
  assert.match(sh, /submittingRef\.current/);
  assert.match(sh, /pendingSaveAttemptRef\.current/);
  assert.match(sh, /recordedAudioUrlRef\.current/);
  assert.match(sh, /acc != null && acc >= 0/);
  assert.match(sh, /finishedElapsedSec/);

  const rp = read('src/app/speaking/roleplay/[id]/page.tsx');
  assert.match(rp, /assessmentMode: true/);
  assert.match(rp, /setTurnError\(/);
  assert.match(rp, /activeAudioBlobUrlRef\.current = null/);
  assert.match(rp, /pronStatus === "COMPLETED"/);
  assert.match(rp, /Chưa đủ tín hiệu để chấm/);
  assert.match(rp, /submittingTurnRef\.current/);
  assert.match(rp, /pendingRetryTurn/);
  assert.match(rp, /restoredVocab/);
  assert.match(rp, /getTurnTtsKey/);
});

check('ARENA-04/ARENA-09/ARENA-12/ARCH-10: Arena kiosk audio isolation, DSP disable, AbortController & Settings mic check', () => {
  const modal = read('src/components/features/speaking/arena/ArenaSpeakingStationModal.tsx');
  assert.match(modal, /onRecordingChange\?: \(active: boolean\) => void/);
  assert.match(modal, /echoCancellation: false/);
  assert.match(modal, /noiseSuppression: false/);
  assert.match(modal, /autoGainControl: false/);
  assert.match(modal, /channelCount: 1/);
  assert.match(modal, /aiAbortRef/);
  assert.match(modal, /quickResult\.pronunciationError/);
  assert.match(modal, /quickResult\.languageError/);

  const exp = read('src/components/features/speaking/arena/ArenaExperience.tsx');
  assert.match(exp, /onRecordingChange=\{handleKioskRecordingChange\}/);
  assert.match(exp, /voice\.setRemoteDuck\(true\)/);
  assert.match(exp, /voice\.setMicEnabled\(false\)/);
  assert.match(exp, /voice\.status === 'off' \|\| voice\.status === 'failed' \|\| voice\.status === 'blocked'/);
});

// 5. Live VM behavioral verification of ARENA-04/05/08/09/10 in useArenaVoice & useArenaRoom
const layout = JSON.parse(read('src/components/features/speaking/arena/arenaLayout.json'));
const spatial = evaluate('components/features/speaking/arena/arenaSpatial.ts');
const terrain = evaluate('components/features/speaking/arena/arenaTerrain.ts', { './arenaLayout.json': layout });

const timers = new Map();
let timerId = 0;
const timerGlobals = {
  setInterval: (fn) => { timers.set(++timerId, fn); return timerId; },
  clearInterval: (id) => timers.delete(id),
  setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
  clearTimeout: (id) => timers.delete(id),
};

class Param {
  value = 0;
  cancelScheduledValues() {}
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
}
class Node {
  gain = new Param();
  positionX = new Param();
  positionY = new Param();
  positionZ = new Param();
  connect() {}
  disconnect() {}
}
class Context {
  state = 'running';
  currentTime = 1;
  listener = Object.fromEntries(
    ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'].map((n) => [n, new Param()])
  );
  addEventListener() {}
  removeEventListener() {}
  resume() { return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createPanner() { return new Node(); }
  createGain() { return new Node(); }
}

const roomEvents = new Proxy({}, { get: (_, key) => key });
const connection = { Connected: 'connected', Reconnecting: 'reconnecting', SignalReconnecting: 'signal-reconnecting' };
const rooms = [];
class Room {
  handlers = new Map();
  state = 'disconnected';
  canPlaybackAudio = true;
  remoteParticipants = new Map([['peer-voice', { identity: 'peer-voice', isMicrophoneEnabled: true }]]);
  localParticipant = {
    setMicrophoneEnabled: async (value) => ({
      isMuted: !value,
      track: value ? { mediaStreamTrack: { readyState: 'live' } } : undefined,
    }),
  };
  constructor() { rooms.push(this); }
  on(name, fn) { this.handlers.set(name, fn); return this; }
  emit(name, ...args) { this.handlers.get(name)?.(...args); }
  async connect() { this.state = 'connected'; this.emit('ConnectionStateChanged', this.state); }
  async disconnect() { this.state = 'disconnected'; }
  async startAudio() {}
  removeAllListeners() { this.handlers.clear(); }
}

const h = harness();
const space = {
  current: {
    listener: { x: 0, y: 0.3, z: 0, yaw: 0, boat: null },
    players: new Map(),
    updatedAt: 950,
  },
};
const me = { id: 'self', voiceIdentity: 'voice-self', canSpeak: true, online: true, x: 0, z: 0, yaw: 0, boat: null };
const peer = { id: 'peer', voiceIdentity: 'peer-voice', canSpeak: true, online: true, x: 1.5, z: 0, yaw: 0, boat: null };
let state = { roomId: 'room', phase: 'FREE', speaker: null, self: 'self', players: [me, peer] };

const { useArenaVoice } = evaluate(
  'components/features/speaking/arena/useArenaVoice.ts',
  {
    react: h.hooks,
    'livekit-client': { Room, RoomEvent: roomEvents, Track: { Kind: { Audio: 'audio' } }, ConnectionState: connection },
    axios: { isAxiosError: () => false },
    './arenaSpatial': spatial,
    './arenaTerrain': terrain,
    '@/services/speakingArenaApi': {
      getArenaVoice: async () => ({ identity: 'voice-self', url: 'wss://fixture.invalid', token: 'tok' }),
    },
    '@/lib/auth-lifecycle': {
      authEnding: () => false,
      authEpoch: () => 1,
      subscribeAuthLifecycle: () => () => {},
    },
  },
  { ...timerGlobals, AudioContext: Context, performance: { now: () => 1000 }, document: { body: { append() {} } } }
);

let voice = h.render(() => useArenaVoice(state, true, space, false));
await voice.start(true);
voice = h.render();
await flush();
voice = h.render();

const remote = {
  kind: 'audio',
  setWebAudioPlugins(nodes) { this.plugins = nodes; },
  attach() { return { hidden: false }; },
  detach() { return [{ remove() {} }]; },
};
rooms[0].emit('TrackSubscribed', remote, {}, { identity: 'peer-voice' });

// ARENA-05: pier (+0.3m) <-> swimmer over deep water (-25m seabed, y=0.0m surface) 1.5m away -> audible!
space.current.listener = { x: -250, y: 0.3, z: -250, yaw: 0, boat: null };
space.current.players.set('peer-voice', { x: -248.5, y: 0.0, z: -250, yaw: 0, boat: null });
space.current.updatedAt = 990;
for (const tick of timers.values()) tick();
assert.ok(remote.plugins[1].gain.value > 0.8, `ARENA-05 pier-to-swimmer over deep water should be audible, got ${remote.plugins[1].gain.value}`);

// ARENA-05: same boat -> spatial gain floored to 1.0 regardless of vertical offset
space.current.listener = { x: -250, y: 0.4, z: -250, yaw: 0, boat: 'boat-1' };
space.current.players.set('peer-voice', { x: -240, y: 0.4, z: -250, yaw: 0, boat: 'boat-1' });
for (const tick of timers.values()) tick();
assert.equal(remote.plugins[1].gain.value, 1, 'ARENA-05 same-boat passengers floor spatial gain to 1.0');

// ARENA-10: structured TALK phase -> active speaker audible > 6m across harbor
space.current.listener = { x: 0, y: 1.0, z: 0, yaw: 0, boat: null };
space.current.players.set('peer-voice', { x: 25, y: 1.0, z: 0, yaw: 0, boat: null });
state = { ...state, phase: 'TALK', speaker: 'peer' };
voice = h.render();
for (const tick of timers.values()) tick();
assert.equal(remote.plugins[1].gain.value, 1, 'ARENA-10 active speaker in TALK phase is audible beyond 6m');

// ARENA-04: kiosk remote ducking mutes remote LiveKit stream locally and restores cleanly
voice.setRemoteDuck(true);
voice = h.render();
for (const tick of timers.values()) tick();
assert.equal(remote.plugins[1].gain.value, 0, 'ARENA-04 kiosk recording ducks remote LiveKit streams to 0');
voice.setRemoteDuck(false);
voice = h.render();
for (const tick of timers.values()) tick();
assert.equal(remote.plugins[1].gain.value, 1, 'ARENA-04 stopping kiosk recording restores remote LiveKit stream');

// ARENA-09: RoomEvent.Disconnected clears published, speakers, remoteMics
rooms[0].emit('ActiveSpeakersChanged', [{ identity: 'peer-voice' }]);
rooms[0].emit('Connected');
voice = h.render();
assert.equal(voice.speakers.length, 1);
rooms[0].emit('Disconnected');
voice = h.render();
assert.equal(voice.status, 'failed');
assert.equal(voice.published, false);
assert.equal(voice.speakers.length, 0);
assert.equal(Object.keys(voice.remoteMics).length, 0);
h.unmount();
passed += 1;
console.log('PASS ARENA-04/05/09/10 live VM behavioral checks (3D y, same-boat, TALK audibility, kiosk duck, disconnect reset)');

// ARENA-08: useArenaRoom resets room on ROOM_CLOSED / EXPIRED ERROR codes
const r = harness();
let receive;
class StompClient {
  connected = false;
  constructor(opts) { this.opts = opts; }
  activate() { this.connected = true; this.opts.onConnect(); }
  deactivate() { this.connected = false; return Promise.resolve(); }
  subscribe(_d, fn) { receive = (ev) => fn({ body: JSON.stringify(ev) }); }
  publish() {}
}
const { useArenaRoom } = evaluate(
  'components/features/speaking/arena/useArenaRoom.ts',
  {
    react: r.hooks,
    './arenaMotion': evaluate('components/features/speaking/arena/arenaMotion.ts', { './arenaTerrain': terrain }),
    '@stomp/stompjs': { Client: StompClient },
    '@/lib/api-session': { ensureApiSession: async () => true },
    '@/lib/auth-lifecycle': { authEnding: () => false, authEpoch: () => 1, subscribeAuthLifecycle: () => () => {} },
    '@/services/stompClient': { getWsUrl: () => 'ws://fixture.invalid' },
  },
  { ...timerGlobals, crypto: { randomUUID: () => 'req-1' }, performance: { now: () => 1000 } }
);
let roomCtrl = r.render(() => useArenaRoom());
receive({ type: 'SYNC', state: { roomId: 'r1', revision: 1, players: [] } });
roomCtrl = r.render();
assert.equal(roomCtrl.state?.roomId, 'r1');
receive({ type: 'ERROR', requestId: 'other', code: 'ROOM_CLOSED' });
roomCtrl = r.render();
assert.equal(roomCtrl.state, null, 'ARENA-08 ROOM_CLOSED error resets stale room state');
receive({ type: 'SYNC', state: { roomId: 'r2', revision: 1, players: [] } });
roomCtrl = r.render();
assert.equal(roomCtrl.state?.roomId, 'r2');
receive({ type: 'ERROR', requestId: 'other', code: 'EXPIRED' });
roomCtrl = r.render();
assert.equal(roomCtrl.state, null, 'ARENA-08 EXPIRED error resets stale room state');
r.unmount();
passed += 1;
console.log('PASS ARENA-08 live VM behavioral check (ROOM_CLOSED & EXPIRED error reset)');

console.log(`Speaking audit frontend contracts & VM behaviors: ${passed} passed, 0 failed`);
