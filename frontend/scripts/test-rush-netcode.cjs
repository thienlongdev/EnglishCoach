/*
 * Echo Quiz Rush multiplayer netcode regressions (Codex forensic audit 2026-10-25 → repair 2026-10-26).
 * Runs the EXACT sources in memory (sucrase), with React, the STOMP client, timers and the 3D world stubbed:
 *  A. useRushCompetition + the answer effect of RushCompetitiveGame: lost answer, lost acknowledgement, lost dash before a
 *     gate, a refusal, a lobby timeout, a reconnect with a command in flight, the input send budget, sequence recovery.
 *  B. RushScene against a surrogate 20 Hz authority (the same TS model, leases applied on arrival, ordered TCP each way):
 *     the round-trip estimate 1283 → 385 → 201 ms, jitter, a 600 ms server stall, an accepted-but-unapplied jump, the
 *     jump / dodge counters after a remount, Time Snare prediction.
 *  C. The pure pieces: SimClock, InputLead, faceHeading.
 * node scripts/test-rush-netcode.cjs
 */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const sucrase = require('sucrase');
// RUSH_DIR: another copy of the game sources (an A/B run); RUSH_AB=1 reports a failing group and goes on.
const dir = process.env.RUSH_DIR ?? path.join(__dirname, '../src/components/features/games/echo-quiz-rush');
let groups = 0, failed = 0;
const check = async (name, run) => { try { await run(); groups++; console.log('PASS', name); } catch (e) { if (!process.env.RUSH_AB) throw e; failed++; console.log('FAIL', name, '—', String(e.message).split(/\r?\n/)[0]); } };

// ─── Module loader (fresh module graph per call) ───
function loader(stubs) {
  const cache = new Map();
  const load = file => {
    file = path.resolve(file); if (cache.has(file)) return cache.get(file).exports;
    const code = sucrase.transform(fs.readFileSync(file, 'utf8'), { transforms: ['typescript', 'jsx', 'imports'], jsxRuntime: 'automatic', production: true, filePath: file }).code;
    const mod = { exports: {} }; cache.set(file, mod);
    const req = s => { if (s in stubs) return typeof stubs[s] === 'function' ? stubs[s]() : stubs[s]; if (s.startsWith('.')) { let p = path.resolve(path.dirname(file), s); if (!path.extname(p)) p += fs.existsSync(p + '.ts') ? '.ts' : '.tsx'; return load(p); } return require(s); };
    vm.runInThisContext('(function(require,module,exports){' + code + '\n})', { filename: file })(req, mod, mod.exports); return mod.exports;
  };
  return load;
}

// ─── A. Hook harness ───
function hookHarness() {
  let now = 0, timerId = 0, ids = 0, callback = null, socket = null; const timers = new Map(), published = [], states = [], effects = [];
  global.location = { href: 'http://probe.test/games/echo-quiz-rush', search: '' }; global.history = { state: null, replaceState() {} };
  global.window = { addEventListener() {}, removeEventListener() {} }; global.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  global.performance = { now: () => now };
  global.setTimeout = (f, ms) => (timers.set(++timerId, { f, at: now + (ms ?? 0) }), timerId); global.clearTimeout = i => timers.delete(i);
  global.setInterval = (f, ms) => { const id = ++timerId; const run = () => { f(); timers.set(id, { f: run, at: now + ms }); }; timers.set(id, { f: run, at: now + ms }); return id; }; global.clearInterval = i => timers.delete(i);
  Object.defineProperty(global, 'crypto', { value: { randomUUID: () => `req-${++ids}` }, configurable: true });
  class Client {
    constructor(o) { this.o = o; this.connected = false; socket = this; }
    async activate() { await this.o.beforeConnect(); this.connected = true; this.o.onConnect(); }
    subscribe(_d, fn) { callback = fn; }
    publish(p) { const body = JSON.parse(p.body); published.push({ ms: now, action: p.destination.split('/').pop(), ...body }); if (p.destination.endsWith('/sync')) queueMicrotask(() => callback({ body: JSON.stringify({ type: 'SYNC', requestId: body.requestId }) })); }
    deactivate() { this.connected = false; return Promise.resolve(); }
  }
  const react = { useRef: v => ({ current: v }), useCallback: f => f, useEffect: f => effects.push(f), useState: v => { const i = states.length; states.push(v); return [v, x => { states[i] = typeof x === 'function' ? x(states[i]) : x; }]; } };
  const load = loader({ react, '@stomp/stompjs': { Client }, '@/services/api-client': { apiClient: { get: async () => ({}) } }, '@/services/stompClient': { getWsUrl: () => 'ws://probe.test' }, '@/lib/auth-lifecycle': { authEpoch: () => 1, authEnding: () => false } });
  const api = load(path.join(dir, 'useRushCompetition.ts')).useRushCompetition();
  effects.forEach(f => f());
  // The answer effect of RushCompetitiveGame, exactly as written.
  const game = fs.readFileSync(path.join(dir, 'RushCompetitiveGame.tsx'), 'utf8');
  const a = game.indexOf('    const option = s.question?.options[s.personal.selected];'), b = game.indexOf('    if (lastPhase.current', a);
  assert(a > 0 && b > a, 'answer effect located');
  const answerEffect = vm.runInThisContext('(() => {' + sucrase.transform(`function effect(s, own, game, answerIds) {\n${game.slice(a, b)}\n}`, { transforms: ['typescript'] }).code + '\nreturn effect; })()');
  const answerIds = { current: new Map() };
  const h = {
    api, published, states, get socket() { return socket; },
    get error() { return states[2]; }, get pending() { return states[3]; },
    advance(ms) { const end = now + ms; for (;;) { let next = null; for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t]; if (!next) break; timers.delete(next[0]); now = next[1].at; next[1].f(); } now = end; },
    deliver(event) { callback({ body: JSON.stringify(event) }); },
    state(phase, extra = {}) { return { roomId: 'room', matchId: 'match', mode: 'BOTS', status: 'RUNNING', revision: ++h.rev, serverNow: h.rev, elapsed: h.rev / 10, you: 'p1', players: [{ id: 'p1', phase, connected: true }], personal: { lastSeq: 0, selected: 0 }, question: { id: 'q0', options: [{ id: 'o0' }, { id: 'o1' }] }, ...extra }; },
    rev: 0,
    effect(state) { answerEffect(state, state.players[0], { connected: true, ensure: api.ensure }, answerIds); },
    sent(action) { return published.filter(p => p.action === action); },
    async start() { await new Promise(r => setImmediate(r)); h.deliver({ type: 'ACK', requestId: 'bind', state: h.state('RUNNING') }); },
  };
  return h;
}

// ─── B. Scene harness (exact RushScene, surrogate authority) ───
function rng(seed) { let r = seed; return () => (r = (r * 16807) % 2147483647) / 2147483647; }
async function sceneRun(o) {
  const ctx = { effects: [], frames: [], now: 0, raf: null, listeners: {}, canvas: { dataset: {}, getBoundingClientRect: () => ({ width: 1280, height: 720 }), addEventListener() {}, removeEventListener() {} } };
  global.performance = { now: () => ctx.now }; global.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  global.HTMLElement = class {}; global.window = { addEventListener: (k, fn) => ctx.listeners[k] = fn, removeEventListener() {} };
  global.ResizeObserver = class { observe() {} disconnect() {} }; global.requestAnimationFrame = fn => (ctx.raf = fn, 1); global.cancelAnimationFrame = () => {};
  const load = loader({ react: { useEffect: fn => ctx.effects.push(fn), useRef: v => ({ current: v === null ? ctx.canvas : v }) }, 'react/jsx-runtime': { jsx: () => ({}), jsxs: () => ({}) },
    // The camera (behind the runner or through the eyes) and mouse-look only draw: the race below never reads them.
    '@/lib/embodiment/mouseLook': { MouseLook: class { get locked() { return false; } enable() {} toggle() {} suspend() {} dispose() {} } }, '@/lib/hud/sharedKeys': { useSharedKeys: () => ({}) },
    './rushView': { RUSH_KEYS: [], rushView: { get: () => 'third', subscribe: () => () => {}, toggle() {} } },
    './sky/skyWorld': { detectQuality: () => 'low', SkyWorld: class { constructor() { this.tier = 'low'; this.camera = { position: { toArray: () => [0, 0, 0] } }; } setView() {} setLookHeld() {} lookBy() {} cameraDiagnostics() { return {}; } resize() {} prepare() { return Promise.resolve(); } setQuality() {} event() {} setLocalEffect() {} dispose() {} doorScreen() { return { x: 0, y: 0 }; } stats() { return {}; } frame(f) { ctx.frames.push({ x: f.local.x, y: f.local.y, z: f.local.z, phase: f.local.phase }); } } } });
  const M = load(path.join(dir, 'rushModel.ts')), N = load(path.join(dir, 'rushNet.ts'));
  const B = [10000, 20000, 30000], rand = rng(o.seed ?? 7);
  const authority = M.createRush(3, 0, 3, 10000, 7, B, [], [], [null, null, null], []); authority.phase = 'RUNNING';
  if (o.effect) { authority.effect = o.effect; authority.effectUntil = o.effectUntil; }
  const timing = { rtt: o.rtt ? o.rtt(0) : 2 * (o.delay ?? 65) };
  let upLast = 0, downLast = 0; const up = [], down = [];
  const wire = (dirn, at) => { const d = (o.delay ?? 65) + (o.jitter ? (rand() * 2 - 1) * o.jitter : 0); const arrive = Math.max(at + Math.max(1, d), dirn === 'up' ? upLast : downLast); if (dirn === 'up') upLast = arrive; else downLast = arrive; return arrive; };
  let seq = 0, held = { horizontal: 0, forward: 0, sprint: false, jump: 0, dodge: 0 }, lastKey = '', lastAt = -1e9; const sent = new Map(), leases = [];
  const key = i => `${i.horizontal}:${i.forward}:${i.sprint}:${i.jump}:${i.dodge}`;
  const publish = now => { const s = seq++; sent.set(s, now); up.push({ at: wire('up', now), seq: s, input: { ...held } }); lastKey = key(held); lastAt = now; };
  let applied = { horizontal: 0, forward: 0, sprint: false }, lastSeq = -1, inputAt = -100, rev = 0, seqBase = o.counters ?? 0;
  authority.jumpSeq = seqBase; authority.dodgeSeq = seqBase;
  const snap = serverNow => { const s = authority; return { matchId: 'm', roomId: 'r', you: 'p1', mode: 'BOTS', status: 'RUNNING', revision: ++rev, serverNow, elapsed: s.elapsed, spacing: 10000, courseVersion: 7, total: 3, boundaries: B, recovery: '',
    players: [{ id: 'p1', name: 'probe', connected: true, phase: s.phase, x: s.x, y: s.y, vx: s.vx, vy: s.vy, vz: s.vz, speed: s.speed, checkpoint: s.checkpoint, effect: s.effect, effectRemaining: Math.max(0, s.effectUntil - s.elapsed), z: s.z, streak: 0 }],
    personal: { phaseTime: s.phaseTime, stamina: s.stamina, energy: s.rushEnergy, dashCooldown: s.dashCooldown, dashTime: s.dashTime, rushTime: s.rushTime, selected: s.selected, openGate: s.openGate, rejected: s.rejected, recoilFrom: s.recoilFrom, vz: s.vz, guard: s.guard, kvx: s.kvx, kvy: s.kvy,
      dodgeTime: s.dodgeTime, dodgeDir: s.dodgeDir, dodgeCooldown: s.dodgeCooldown, riseCheckpoint: s.riseCheckpoint, riseStart: s.riseStart, dropStart: s.dropStart, dropFrom: s.dropFrom, hold: s.hold, jumps: s.jumps, dodges: s.dodges, knocks: s.knocks, falls: s.falls, vy: s.vy, floorY: s.floorY,
      lastSlide: s.lastSlide, orbs: s.taken, speedLeft: 0, shield: s.shield, shieldLeft: 0, shieldBlocks: 0, dashX: s.dashX, dashY: s.dashY, fallX: s.fallX, fallY: s.fallY, jumpSeq: s.jumpSeq, dodgeSeq: s.dodgeSeq, lastSeq, inputAt, jumpAt: s.jumpAt, landAt: s.landAt },
    question: { id: 'q0', family: 'SPELLING_CHOICE', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] } }; };
  const ref = { current: snap(0) };
  let handle;
  const props = { total: 3, checkpoint: 0, question: ref.current.question, reduced: true, spacing: 10000, courseVersion: 7, boundaries: B, hazards: [], rising: [], walls: [null, null, null], orbs: [],
    onReady: x => handle = x, onGate() {}, onNext() {}, onFinish() {}, onHud() {}, onHidden() {}, onError() { throw Error('world failed'); }, onObstacle() {},
    network: { enabled: () => true, snapshot: ref, localLabel: 'probe', rtt: () => timing.rtt, onBoost() {}, sentAt: s => sent.get(s),
      onInput: i => { held = { horizontal: i.horizontal, forward: i.forward ?? 0, sprint: i.sprint, jump: i.jump ?? 0, dodge: i.dodge ?? 0 }; leases.push({ ...held }); if (key(held) !== lastKey && (ctx.now - lastAt >= 40 || held.jump !== (up.at(-1)?.input.jump ?? seqBase))) publish(ctx.now); } } };
  load(path.join(dir, 'RushScene.tsx')).default(props); ctx.effects.forEach(f => f()); await Promise.resolve();
  const frame = now => { ctx.now = now; const fn = ctx.raf; ctx.raf = null; fn(now); return ctx.frames.at(-1); };
  const press = (code, type) => ctx.listeners[type]({ code, type, repeat: false, target: null, preventDefault() {} });
  let nextTick = 50, lastTickWall = 0, tickIndex = 0, wHeld = false, wSince = -1, spaceAt = o.space ?? -1;
  const stats = { back: 0, maxBack: 0, stall: 0, vMin: Infinity, vMax: 0, maxDz: 0, jumpsSeen: [], frames: 0 };
  let last = null;
  frame(0);
  for (let k = 1; k <= (o.frames ?? 1200); k++) {
    const now = k * 1000 / 60;
    if (o.rtt) timing.rtt = o.rtt(now);
    const wantW = o.pattern ? o.pattern(now) : true;
    if (wantW !== wHeld) { press('KeyW', wantW ? 'keydown' : 'keyup'); wHeld = wantW; wSince = now; }
    if (spaceAt >= 0 && now >= spaceAt) { press('Space', 'keydown'); press('Space', 'keyup'); spaceAt = -1; }
    if (now - lastAt >= 100) publish(now);
    while (nextTick <= now) {
      if (o.stall && nextTick >= o.stall[0] && nextTick < o.stall[0] + o.stall[1]) { nextTick += 50; continue; }
      // Leases arriving before this tick: applied on arrival (RushCompetition.input): keys, and a jump counter that moved
      // forward is ACCEPTED (jumpAt = now) and applied by the next step. A ping answered right then shows that moment.
      while (up.length && up[0].at <= nextTick) { const m = up.shift(); if (m.seq > lastSeq) { lastSeq = m.seq; applied = m.input; inputAt = authority.elapsed;
        if (m.input.jump > authority.jumpSeq) { authority.jumpSeq = m.input.jump; authority.jumpAt = authority.elapsed; if (o.pingOnAccept) down.push({ at: wire('down', m.at), value: snap(m.at) }); } } }
      const dt = Math.min(.25, (nextTick - lastTickWall) / 1000); lastTickWall = nextTick;
      const live = authority.elapsed - inputAt <= .35;
      for (let n = 0, steps = Math.round(dt * 120); n < steps; n++) M.stepRush(authority, { horizontal: live ? applied.horizontal : 0, forward: live ? applied.forward : 0, sprint: applied.sprint, target: null, dash: false, rush: false }, N.STEP);
      if (++tickIndex % 2 === 0) down.push({ at: wire('down', nextTick), value: snap(nextTick) });
      nextTick += 50;
    }
    down.sort((p, q) => p.at - q.at);
    while (down.length && down[0].at <= now) ref.current = down.shift().value;
    const f = frame(now);
    if (last && now > 2000) {
      const dy = f.y - last.y; stats.frames++;
      if (dy < -.5) { stats.back++; stats.maxBack = Math.max(stats.maxBack, -dy); }
      if (wHeld && f.phase === 'RUNNING' && Math.abs(dy) < .05) stats.stall++;
      if (wHeld && now - wSince > 600) { stats.vMin = Math.min(stats.vMin, dy * 60); stats.vMax = Math.max(stats.vMax, dy * 60); }
      stats.maxDz = Math.max(stats.maxDz, Math.abs(f.z - last.z));
    }
    stats.jumpsSeen.push(handle.state.jumps);
    last = f;
  }
  return { stats, handle, authority, leases, ctx };
}

(async () => {
  // ─── A ───
  await check('lost answer: the same request is resent until the server answers; one answer; the racer is never left at the wall', async () => {
    const h = hookHarness(); await h.start();
    const at = h.state('VALIDATING'); h.deliver({ type: 'STATE', state: at }); h.effect(at);
    const first = h.sent('answer'); assert.equal(first.length, 1); const id = first[0].requestId;
    // The message is lost. The server keeps showing VALIDATING; the game re-runs its effect on every state.
    for (let t = 0; t < 1600; t += 100) { h.advance(100); const s = h.state('VALIDATING'); h.deliver({ type: 'STATE', state: s }); h.effect(s); }
    const again = h.sent('answer'); assert(again.length >= 2, 'resent'); assert(again.every(p => p.requestId === id), 'same request id every time');
    h.deliver({ type: 'ACK', requestId: id, state: h.state('OPENING') });
    const count = h.sent('answer').length; h.advance(10000); assert.equal(h.sent('answer').length, count, 'nothing after the acknowledgement');
    assert.equal(h.api.send('leave'), true, 'leave is free');
  });
  await check('lost acknowledgement: repeats carry the first request id (the receipt returns the first outcome); a settled refusal is quiet', async () => {
    const h = hookHarness(); await h.start();
    const at = h.state('VALIDATING'); h.deliver({ type: 'STATE', state: at }); h.effect(at); const id = h.sent('answer')[0].requestId;
    // The server applied it (the broadcast shows the door opening) but the acknowledgement was lost.
    const moved = h.state('OPENING'); h.deliver({ type: 'STATE', state: moved }); h.effect(moved);
    h.advance(1600); const repeats = h.sent('answer'); assert(repeats.length >= 2 && repeats.every(p => p.requestId === id));
    h.deliver({ type: 'ERROR', requestId: id, code: 'ANSWER_UNAVAILABLE' }); assert.equal(h.error, '', 'a settled answer is not an error');
    const next = h.state('VALIDATING', { question: { id: 'q1', options: [{ id: 'x' }] } }); h.deliver({ type: 'STATE', state: next }); h.effect(next);
    const ids = new Set(h.sent('answer').map(p => p.requestId)); assert.equal(ids.size, 2, 'the next door gets its own single request');
  });
  await check('a lost dash before the gate never blocks the answer at the gate (each command has its own slot)', async () => {
    const h = hookHarness(); await h.start();
    assert.equal(h.api.send('dash'), true); h.advance(300);
    const at = h.state('VALIDATING'); h.deliver({ type: 'STATE', state: at }); h.effect(at);
    assert.equal(h.sent('answer').length, 1, 'answer sent at once while the dash is unanswered');
    h.advance(2000); assert.equal(h.sent('dash').length, 1, 'a dash is never repeated later (a late dash would fire at a moment nobody chose)');
    assert.equal(h.api.send('dash'), true, 'the slot was freed');
  });
  await check('a refusal ends the command with its error; a state broadcast does not clear it; a new press is possible', async () => {
    const h = hookHarness(); await h.start();
    assert.equal(h.api.send('skill', { skill: 'ICE_LOCK', targetId: 'p2' }), true); const id = h.sent('skill')[0].requestId;
    h.deliver({ type: 'ERROR', requestId: id, code: 'COOLDOWN' }); assert.equal(h.error, 'COOLDOWN');
    h.deliver({ type: 'STATE', state: h.state('RUNNING') }); assert.equal(h.error, 'COOLDOWN', 'a snapshot is not an acknowledgement');
    assert.equal(h.api.send('skill', { skill: 'TIME_SNARE', targetId: 'p2' }), true);
    h.advance(7000); assert.equal(h.error, 'REQUEST_TIMEOUT', 'an unanswered skill ends with an error, the player presses again');
  });
  await check('a lobby command is retried with its id, expires at 8 s with an error, never holds Leave, and Retry resends the same request', async () => {
    const h = hookHarness(); await h.start();
    assert.equal(h.api.send('ready', { ready: true }), true); const id = h.sent('ready')[0].requestId; assert.equal(h.pending, true);
    h.advance(8001); const sends = h.sent('ready'); assert.equal(sends.length, 4, 'first send + three retries'); assert(sends.every(p => p.requestId === id));
    assert.equal(h.pending, false); assert.equal(h.error, 'REQUEST_TIMEOUT');
    h.deliver({ type: 'STATE', state: h.state('RUNNING') }); assert.equal(h.error, 'REQUEST_TIMEOUT', 'still shown after a broadcast');
    h.api.retry(); assert.equal(h.sent('ready').at(-1).requestId, id, 'Retry = the same safe request');
    assert.equal(h.api.send('leave'), true, 'Leave always goes');
  });
  await check('reconnect with an answer in flight: nothing leaves an unbound connection; after the rejoin the same answer goes out', async () => {
    const h = hookHarness(); await h.start();
    const at = h.state('VALIDATING'); h.deliver({ type: 'STATE', state: at }); h.effect(at); const id = h.sent('answer')[0].requestId;
    h.socket.o.onWebSocketClose(); assert.equal(h.error, 'CONNECTION_LOST');
    h.socket.o.onConnect(); await new Promise(r => setImmediate(r));
    const rejoin = h.sent('rejoin').at(-1); assert(rejoin, 'rejoin first');
    const before = h.sent('answer').length; h.advance(4000); assert.equal(h.sent('answer').length, before, 'no command from an unbound connection (SESSION_REPLACED would end it)');
    h.deliver({ type: 'ACK', requestId: rejoin.requestId, state: h.state('VALIDATING') }); assert.equal(h.error, '', 'connection error cleared once back');
    h.advance(2600); const after = h.sent('answer'); assert(after.length > before && after.at(-1).requestId === id, 'resent with the same id');
  });
  await check('movement leases stay inside 30 a second (no silent drop at the edge), and the newest keys always go out', async () => {
    const h = hookHarness(); await h.start(); h.api.inputEnabled.current = true;
    for (let t = 0; t < 2000; t += 5) { h.api.updateInput({ horizontal: (t / 5) % 2 ? 1 : -1, forward: 1, sprint: false, jump: Math.floor(t / 200), dodge: 0, target: null }, t % 200 === 0); h.advance(5); }
    h.api.updateInput({ horizontal: 0, forward: 0, sprint: false, jump: 99, dodge: 0, target: null }); h.advance(1200);
    const leases = h.sent('input'); for (const l of leases) assert(leases.filter(m => m.ms > l.ms - 1000 && m.ms <= l.ms).length <= 30, `budget at ${l.ms}`);
    assert.equal(leases.at(-1).input.jump, 99, 'coalesced, never lost'); assert(leases.length > 40);
    assert.equal(typeof h.api.sentAt(leases.at(-1).input.seq), 'number', 'send times kept for the lead measurement');
    // A sequence the server cannot follow restarts from its own count; a lease error is never shown.
    h.deliver({ type: 'STATE', state: h.state('RUNNING', { personal: { lastSeq: 7, selected: -1 } }) });
    h.deliver({ type: 'ERROR', requestId: null, code: 'INPUT_SEQUENCE' }); assert.equal(h.error, '');
    h.api.updateInput({ horizontal: 1, forward: 1, sprint: true, jump: 99, dodge: 0, target: null }); h.advance(200);
    assert.equal(h.sent('input').at(-1).input.seq >= 8 && h.sent('input').at(-1).input.seq <= 10, true, 'resumed from the server count');
  });

  // ─── B ───
  await check('race clock: the round-trip estimate 1283 → 385 → 201 ms never rewinds or stops the runner (Codex trace: 10 back-steps before)', async () => {
    const { stats } = await sceneRun({ delay: 65, rtt: ms => ms < 2000 ? 1283 : ms < 4000 ? 385 : 201 });
    assert.equal(stats.back, 0); assert.equal(stats.stall, 0);
    assert(stats.vMin > 212 * .85 && stats.vMax < 212 * 1.15, `held W speed ${stats.vMin.toFixed(1)}–${stats.vMax.toFixed(1)}`);
  });
  await check('race clock: jitter 65 ± 35 ms each way and a 600 ms server stall cost no back-step', async () => {
    const j = await sceneRun({ delay: 65, jitter: 35, rtt: () => 130 }); assert.equal(j.stats.back, 0); assert.equal(j.stats.stall, 0);
    const s = await sceneRun({ delay: 65, stall: [6000, 600] }); assert.equal(s.stats.back, 0); assert.equal(s.stats.stall, 0);
    const p = await sceneRun({ delay: 65, jitter: 35, rtt: () => 130, pattern: now => (now % 2500) < 1900 }); assert(p.stats.maxBack < 2, `start/stop corrections stay under 2 units (${p.stats.maxBack})`);
  });
  await check('a jump the server accepted but has not applied yet stays one continuous jump (a ping in between used to erase it)', async () => {
    const { stats, handle, authority } = await sceneRun({ delay: 40, space: 3000, pingOnAccept: true, frames: 300 });
    assert.equal(authority.jumps, 1); assert.equal(handle.state.jumps, 1);
    const seen = stats.jumpsSeen.slice(stats.jumpsSeen.indexOf(1)); assert(seen.every(v => v === 1), 'the predicted jump is never taken back');
    assert(stats.maxDz < 9, `height changes smoothly (${stats.maxDz.toFixed(2)} per frame)`);
  });
  await check('after a remount the first Space / Ctrl press continues the server counters (10 → 11), applied once', async () => {
    const { leases, authority } = await sceneRun({ delay: 40, space: 2500, counters: 10, frames: 240 });
    assert(!leases.some(l => l.jump > 0 && l.jump < 10), 'never restarts at 1');
    assert.equal(leases.find(l => l.jump > 10).jump, 11, 'the press is 11'); assert.equal(authority.jumps, 1, 'one jump');
  });
  await check('Time Snare: the prediction is the authority (no correction while snared)', async () => {
    const { handle, authority } = await sceneRun({ delay: 40, effect: 'TIME_SNARE', effectUntil: 30, frames: 300 });
    assert(Math.abs(handle.state.vy - authority.vy) < 1e-6 && authority.vy <= 95 + 1e-9, 'both capped at the snare speed');
    const gap = handle.state.y - authority.y; assert(gap >= 0 && gap < 95 * .4, `prediction ahead only by the lead (${gap.toFixed(1)})`);
  });

  // ─── C ───
  const N = loader({})(path.join(dir, 'rushNet.ts'));
  await check('SimClock follows a falling target without going back or stopping; jumps only while free or across a real gap', async () => {
    const c = new N.SimClock(); let prev = c.advance(0, 1.3, true);
    let ms = 16; for (; ms < 14000; ms += 16) { const target = ms / 1000 + (ms < 2000 ? 1.3 : ms < 4000 ? .4 : .2); const v = c.advance(ms, target, false); const rate = (v - prev) / .016; assert(rate > .87 && rate < 1.13, `rate ${rate} at ${ms}`); prev = v; }
    assert(Math.abs(prev - ((ms - 16) / 1000 + .2)) < .02, `converged (${prev - ((ms - 16) / 1000 + .2)})`);
    assert.equal(c.advance(ms, 3, false), 3, 'a gap of seconds is a discontinuity (snap)'); assert.equal(c.advance(ms, 9, false), 3, 'idempotent for one frame');
  });
  await check('InputLead: no estimate before five samples, then the median (an outlier never sets the lead)', async () => {
    const l = new N.InputLead(); for (let s = 0; s < 4; s++) l.observe(s, 10 + .1 + (s === 0 ? 1.2 : 0), 10); assert.equal(l.value(.5), .5);
    l.observe(4, 10.1, 10); assert(Math.abs(l.value(.5) - .1) < 1e-9); l.observe(4, 99, 10); assert(Math.abs(l.value(.5) - .1) < 1e-9, 'each seq once');
    l.observe(5, -100 + 1 / 120, 10); l.observe(6, 10.1, null); assert(Math.abs(l.value(.5) - .1) < 1e-9, 'no input yet (−100) and an unknown send time are not samples');
    l.reset(); assert.equal(l.value(.3), .3); for (let s = 0; s < 5; s++) l.observe(s, -2 + .12, -2); assert(Math.abs(l.value(.3) - .12) < 1e-9, 'countdown leases measure the lead');
  });
  await check('faceHeading: a rival pulled back after an overshooting extrapolation keeps facing forward; a wall turns the short way', async () => {
    const b = new N.RivalBuffer(); for (let k = 0; k <= 10; k++) b.push('p2', { e: k * .1, x: 500, y: k * 21.2, z: 0, vz: 0, phase: 'RUNNING' });
    let heading = 0, worst = 0, prevPose = null, deltaHeading = 0, deltaWorst = 0; const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
    for (let t = .9; t < 1.6; t += 1 / 60) {
      if (Math.abs(t - 1.15) < 1 / 120) b.push('p2', { e: 1.1, x: 500, y: 10 * 21.2 + 1, z: 0, vz: 0, phase: 'RUNNING' }); // the rival stopped
      const p = b.pose('p2', t); heading = N.faceHeading(heading, p.vx * .01, p.vy * .02, p.phase, 1 / 60, 10); worst = Math.max(worst, Math.abs(heading));
      // The former rule (skyWorld before 2026-10-26): toward the frame-to-frame position delta whenever it exceeds .002 m.
      if (prevPose) { const dx = (p.x - prevPose.x) * .01, dz = (prevPose.y - p.y) * -.02; if (Math.hypot(dx, dz) > .002) deltaHeading = wrap(deltaHeading + wrap(-Math.atan2(dx, dz) - deltaHeading) * (1 - Math.exp(-10 / 60))); deltaWorst = Math.max(deltaWorst, Math.abs(deltaHeading)); }
      prevPose = p;
    }
    assert(worst < .05, `velocity heading stays forward (${worst.toFixed(3)} rad)`); assert(deltaWorst > .3, `the former position-delta rule swung the rival (${deltaWorst.toFixed(2)} rad)`);
    let h = Math.PI - .05, turned = 0; for (let k = 0; k < 120; k++) { const n = N.faceHeading(h, 0, 0, 'VALIDATING', 1 / 60, 12); turned += Math.abs(wrap(n - h)); h = n; } assert(turned <= Math.PI, 'short way at a wall');
  });
  console.log(`Echo Quiz Rush netcode: ${groups} groups passed${failed ? `, ${failed} failed` : ''}`); if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });
