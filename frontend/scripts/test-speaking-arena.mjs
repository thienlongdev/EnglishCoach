import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const path = 'components/features/speaking/arena/';

function evaluate(file, deps = {}, globals = {}) {
  const { code } = babel.core().transformSync(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), {
    filename: file,
    configFile: false,
    babelrc: false,
    presets: [babel.presetTypescript()],
    plugins: [babel.pluginTransformModulesCommonjs()],
  });
  const exports = {};
  runInNewContext(code, { exports, require: name => deps[name] ?? require(name), AbortController, console, ...globals });
  return exports;
}

function harness() {
  const slots = [];
  let cursor = 0,
    queue = [],
    dirty = false,
    run;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [
        slots[i].value,
        v => {
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
      let result,
        n = 0;
      do {
        dirty = false;
        cursor = 0;
        result = run();
        const work = queue;
        queue = [];
        work.forEach(f => f());
        assert.ok(++n < 40, 'bounded React updates');
      } while (dirty);
      return result;
    },
    unmount() {
      slots.forEach(s => s?.cleanup?.());
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const spatial = evaluate(path + 'arenaSpatial.ts');
const layoutBytes = readFileSync(new URL('../src/' + path + 'arenaLayout.json', import.meta.url));
assert.deepEqual(
  layoutBytes,
  readFileSync(new URL('../../backend/src/main/resources/data/speaking-arena-layout.json', import.meta.url)),
  'browser/server world layout must be identical',
);
const layout = JSON.parse(layoutBytes);
const terrain = evaluate(path + 'arenaTerrain.ts', { './arenaLayout.json': layout });

assert.equal(layout.version, 7, 'Echo Archipelago layout version 7');
assert.equal(layout.islands.length, 15, '7 major islands + lighthouse + 7 outer islets');
assert.equal(layout.bridges.length, 2, '2 walkable archipelago bridges');
assert.equal(layout.docks.length, 11, '11 coastal piers');
assert.equal(layout.boats.length, 14, '14 moored vessels across 5 playable classes');
assert.equal(layout.interactables.filter(i => i.kind === 'kiosk').length, 15, '15 island speaking stations');
assert.equal(layout.interactables.filter(i => i.kind === 'fruit_tree').length, 16, '16 harvestable tropical fruit trees');
assert.equal(layout.interactables.filter(i => i.kind === 'fishing_spot').length, 10, '10 designated pier fishing spots');

for (const island of layout.islands) {
  const tower = island.id === 'lighthouse';
  const atoll = island.profile === 'atoll';
  assert.equal(terrain.arenaWalkable(island.x, island.z), !tower, island.id + ' center passable');
  if (atoll) {
    assert.equal(terrain.arenaDryWalkable(island.x, island.z), false, 'atoll center is crystal snorkeling lagoon');
    assert.ok(terrain.arenaDryWalkable(island.x + 54, island.z), 'atoll sandy ring is dry walkable');
  } else {
    assert.ok(terrain.arenaDryWalkable(island.x + (tower ? 4.5 : 0), island.z), island.id + ' dry walkable');
  }
}

// Verify >= 8x playable dry land expansion vs v6 baseline (14,857 m^2)
{
  let dryCells = 0;
  const stepM = 4;
  for (let x = -540; x <= 540; x += stepM) {
    for (let z = -540; z <= 540; z += stepM) {
      if (terrain.arenaDryWalkable(x, z)) dryCells++;
    }
  }
  const dryAreaSqM = dryCells * stepM * stepM;
  assert.ok(dryAreaSqM >= 120_000, `dry walkable land area ${dryAreaSqM} m^2 must exceed 8x baseline`);
}

for (const b of layout.bridges) {
  let prior = b.ah;
  for (let j = 0; j <= 100; j++) {
    const t = j / 100,
      x = b.ax + (b.bx - b.ax) * t,
      z = b.az + (b.bz - b.az) * t;
    assert.ok(terrain.arenaWalkable(x, z), 'bridge walkable ' + b.id);
    const h = terrain.arenaHeight(x, z);
    assert.ok(Math.abs(h - prior) < 0.06, 'bridge smooth slope ' + b.id);
    prior = h;
  }
  assert.ok(Math.abs(prior - b.bh) < 1e-8);
}

assert.equal(terrain.arenaWalkable(560, 0), false, 'outside ARENA_PLAYER_LIMIT is blocked');
assert.equal(terrain.arenaWalkable(NaN, 0), false);
{
  const planter = layout.obstacles.find(o => o.kind === 'planter');
  assert.ok(planter, 'planter collider exists');
  const startX = planter.x - planter.radius - 1.5;
  const endX = planter.x + planter.radius + 1.5;
  assert.ok(terrain.arenaStep(startX, planter.z, endX, planter.z).x < planter.x, 'swept motion cannot tunnel through a planter');
}
{
  // Rocky non-beach cliff on commons (angle = -0.35 rad): grounded walk stops safely before cliff drop
  const ang = -0.35;
  const edge = terrain.arenaStep(Math.cos(ang) * 60, Math.sin(ang) * 60, Math.cos(ang) * 98, Math.sin(ang) * 98);
  assert.ok(terrain.arenaDryWalkable(edge.x, edge.z), 'grounded walk stops safely on rocky cliff edge');
}

for (const d of layout.docks) {
  let prior = terrain.arenaHeight(d.ax, d.az);
  for (let j = 0; j <= 100; j++) {
    const t = j / 100,
      x = d.ax + (d.bx - d.ax) * t,
      z = d.az + (d.bz - d.az) * t;
    assert.ok(terrain.arenaWalkable(x, z), 'dock walkable ' + d.id);
    const h = terrain.arenaHeight(x, z);
    assert.ok(Math.abs(h - prior) < 0.08, 'dock smooth slope ' + d.id);
    prior = h;
  }
  // Swimmer beside dock tip can climb out onto dry pier deck
  const dx = d.bx - d.ax,
    dz = d.bz - d.az,
    len = Math.hypot(dx, dz) || 1;
  const sx = d.bx + (dx / len) * 1.1,
    sz = d.bz + (dz / len) * 1.1;
  if (terrain.arenaFloor(sx, sz) < terrain.ARENA_WATER_Y - 0.3) {
    const climb = terrain.arenaClimbOutPoint(sx, sz);
    assert.ok(climb && terrain.arenaDryWalkable(climb.x, climb.z), 'swimmer can climb out at ' + d.id);
  }
}

for (const b of layout.boats) {
  const hull = terrain.arenaHullForModel(b.model);
  assert.ok(terrain.arenaBoatClear(b.x, b.z, b.yaw, hull), 'moored hull in clear water ' + b.id);
  const land = terrain.arenaDisembarkPoint(b.x, b.z, b.yaw, hull);
  assert.ok(land && terrain.arenaDryWalkable(land.x, land.z), 'moored boat has a dry pier landing ' + b.id);
  assert.ok(terrain.arenaHullGap(b.x, b.z, b.yaw, land.x, land.z, hull) <= 1.6, 'a stride from the gunwale ' + b.id);
}
assert.equal(terrain.arenaBoatClear(0, 0, 0), false);
assert.equal(terrain.arenaDisembarkPoint(-420, 420, 0), null);

const seg = (ax, az, bx, bz, x, z) => {
  const dx = bx - ax,
    dz = bz - az,
    l = dx * dx + dz * dz,
    t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l));
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
};
assert.ok(layout.rocks.length > 350, 'shore rocks are colliders across the archipelago');
for (const k of layout.rocks) {
  assert.equal(terrain.arenaBoatClear(k.x, k.z, 0), false, 'rock is solid to a hull');
  for (const b of layout.bridges) assert.ok(seg(b.ax, b.az, b.bx, b.bz, k.x, k.z) > b.width / 2 + k.r + 0.5, 'no rock on a bridge');
  for (const d of layout.docks) assert.ok(seg(d.ax, d.az, d.bx, d.bz, k.x, k.z) > d.width / 2 + k.r + 0.5, 'no rock on a pier');
}
for (const b of layout.bridges) {
  assert.equal(terrain.arenaBoatClear((b.ax + b.bx) / 2, (b.az + b.bz) / 2, 0), false, 'a hull cannot pass under a low bridge');
}
{
  const c = layout.islands[0];
  const a = 0.25;
  const shoreR = terrain.arenaShoreRadius(c, a);
  const sx = Math.cos(a) * (shoreR + 12),
    sz = Math.sin(a) * (shoreR + 12),
    yaw = Math.atan2(-Math.cos(a), -Math.sin(a));
  const at = terrain.arenaBoatStep(sx, sz, yaw, 0, 0);
  assert.ok(at.blocked && terrain.arenaBoatClear(at.x, at.z, yaw) && Math.hypot(at.x, at.z) < shoreR + 11, 'hull reaches the coast and stops');
  const bx = at.x + Math.sin(yaw) * 1.52,
    bz = at.z + Math.cos(yaw) * 1.52;
  assert.ok(Math.hypot(bx, bz) >= terrain.arenaShoreRadius(c, Math.atan2(bz, bx)) + 0.5, 'bow stays off the rock');

  const karst = layout.islands.find(i => i.id === 'karst_bay');
  const kr = terrain.arenaShoreRadius(karst, -2.1) + 3.2;
  assert.equal(
    terrain.arenaDisembarkPoint(karst.x + Math.cos(-2.1) * kr, karst.z + Math.sin(-2.1) * kr, 0),
    null,
    'no landing on a steep karst cliff without a pier',
  );

  // Wave 9 B01/B02/B04: overboard water jump anywhere + all 15 islands (including 7 dockless islets) accessible by boat
  for (const model of ['skiff', 'sampan', 'pelagic', 'tern', 'cruiser']) {
    const hull = terrain.arenaHullForModel(model);
    const over = terrain.arenaOverboardPoint(-105, 18, 0.6, hull, 'ROWER', 1);
    assert.ok(over && terrain.arenaSwimmable(over.x, over.z), 'overboard jump in open sea for ' + model);
    assert.ok(terrain.arenaHullGap(-105, 18, 0.6, over.x, over.z, hull) >= 0.55, 'overboard jump clears hull >= 0.55 m');
  }
  for (const isl of layout.islands) {
    let accessible = false;
    for (let s = 0; s < 72 && !accessible; s++) {
      const a = (s / 72) * Math.PI * 2 - Math.PI;
      const sr = terrain.arenaShoreRadius(isl, a);
      const ux = Math.cos(a),
        uz = Math.sin(a),
        bowYaw = Math.atan2(-ux, -uz);
      for (let seaD = 1.25; seaD <= 5.5; seaD += 0.25) {
        const bx = isl.x + ux * (sr + seaD),
          bz = isl.z + uz * (sr + seaD);
        if (!terrain.arenaBoatClear(bx, bz, bowYaw, terrain.ARENA_HULL)) continue;
        const land = terrain.arenaDisembarkPoint(bx, bz, bowYaw, terrain.ARENA_HULL);
        if (land) {
          assert.ok(terrain.arenaWalkable(land.x, land.z), 'landing walkable on ' + isl.id);
          assert.ok(terrain.arenaCanBoardBoat(bx, bz, bowYaw, land.x, land.z, terrain.ARENA_HULL), 're-boardable on ' + isl.id);
          accessible = true;
        }
        break;
      }
    }
    assert.ok(accessible, 'island accessible by boat: ' + isl.id);
  }
}

for (const o of layout.obstacles.filter(o => ['shrub', 'sign', 'lantern', 'stilt_house', 'market_stall'].includes(o.kind))) {
  assert.equal(terrain.arenaWalkable(o.x, o.z), false, o.kind + ' is solid');
}

const assets = evaluate(path + 'arenaAssets.ts');
function parseLeanGlb(glbBuffer) {
  assert.equal(glbBuffer.readUInt32LE(0), 0x46546c67, 'valid glTF magic');
  assert.equal(glbBuffer.readUInt32LE(4), 2, 'glTF 2.0');
  const jLen = glbBuffer.readUInt32LE(12);
  const meta = JSON.parse(glbBuffer.subarray(20, 20 + jLen));
  const forbidden = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'];
  for (const ext of forbidden) {
    assert.ok(!(meta.extensionsRequired ?? []).includes(ext), `forbidden WASM extension ${ext}`);
    assert.ok(!(meta.extensionsUsed ?? []).includes(ext), `forbidden WASM extensionUsed ${ext}`);
  }
  const json = { ...meta };
  delete json.images;
  delete json.textures;
  delete json.samplers;
  json.extensionsRequired = (json.extensionsRequired ?? []).filter(e => e !== 'EXT_texture_webp');
  json.extensionsUsed = (json.extensionsUsed ?? []).filter(e => e !== 'EXT_texture_webp');
  json.materials = (json.materials ?? []).map(m => {
    const { pbrMetallicRoughness: p = {}, normalTexture, occlusionTexture, emissiveTexture, ...rest } = m;
    const { baseColorTexture, metallicRoughnessTexture, ...pbr } = p;
    return { ...rest, pbrMetallicRoughness: pbr };
  });
  const text = Buffer.from(JSON.stringify(json));
  const pad = Buffer.alloc((4 - (text.length % 4)) % 4, 0x20);
  const bin = glbBuffer.subarray(20 + jLen);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + text.length + pad.length + bin.length, 8);
  head.writeUInt32LE(text.length + pad.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  const lean = Buffer.concat([head, text, pad, bin]);
  return { meta, arrayBuffer: lean.buffer.slice(lean.byteOffset, lean.byteOffset + lean.byteLength) };
}

for (const key of ['ROWBOAT', 'PROPS']) {
  const glb = readFileSync(new URL('../public' + assets.arenaArchipelagoAssets[key], import.meta.url));
  const { meta, arrayBuffer } = parseLeanGlb(glb);
  assert.deepEqual(meta.extensionsRequired ?? [], []);
  const { scene } = await new GLTFLoader().parseAsync(arrayBuffer, '');
  if (key === 'PROPS') {
    for (const prop of scene.children) {
      const box = new Box3().setFromObject(prop);
      assert.ok(box.min.x <= 0 && box.max.x >= 0 && box.min.z <= 0 && box.max.z >= 0, prop.name + ' must cover its placement origin');
    }
  } else {
    for (const [name, x] of [
      ['Oar_L', 0.68],
      ['Oar_R', -0.68],
    ]) {
      const oar = scene.getObjectByName(name);
      assert.ok(oar?.position.distanceTo(new Vector3(x, 0.53, 0.24)) < 0.001, name + ' pivots about its gunwale socket');
    }
  }
}

// Verify all 56 v7 LOD0 + LOD1 GLBs are 100% zero-WASM and parse cleanly
let v7GlbCount = 0;
for (const [slug, pair] of Object.entries(assets.arenaV7Assets.bySlug)) {
  for (const lodKey of ['lod0', 'lod1']) {
    const glb = readFileSync(new URL('../public' + pair[lodKey], import.meta.url));
    const { arrayBuffer } = parseLeanGlb(glb);
    if (slug.startsWith('vessel-') && lodKey === 'lod0') {
      const { scene } = await new GLTFLoader().parseAsync(arrayBuffer, '');
      assert.ok(scene.children.length > 0, slug + ' scene non-empty');
    }
    v7GlbCount++;
  }
}
assert.equal(v7GlbCount, 56, 'all 56 v7 LOD0/LOD1 GLBs verified zero-WASM');
console.log('PASS v7 terrain parity (8.83x area), 15 islands, 11 coastal docks + climb-out, 14 vessels, 392 rocks, 56 zero-WASM v7 GLBs');

assert.equal(spatial.spatialGain(0), 1);
assert.equal(spatial.spatialGain(1.25), 1);
assert.equal(spatial.spatialGain(3), 0.5);
assert.ok(Math.abs(spatial.spatialGain(5) - 0.12) < 1e-9);
assert.equal(spatial.spatialGain(6), 0);
assert.equal(spatial.spatialGain(7), 0);
assert.equal(spatial.spatialGain(200), 0);
assert.equal(spatial.spatialGain(NaN), 0);
let previous = 1;
for (let d = 0; d < 130; d += 0.1) {
  const gain = spatial.spatialGain(d);
  assert.ok(gain >= 0 && gain <= previous + 1e-12);
  previous = gain;
}
console.log('PASS speech gain: finite, monotone, continuous near/far boundaries');

const { ArenaMotor, ArenaMotion, STEP } = evaluate(path + 'arenaMotion.ts', { './arenaTerrain': terrain });
for (const f of layout.furniture.filter(f => ['table', 'bench'].includes(f.kind))) {
  const front = f.yaw,
    offset = f.kind === 'table' ? 1.05 : 0.92;
  const ax = f.x - Math.sin(front) * offset,
    az = f.z - Math.cos(front) * offset;
  if (!terrain.arenaDryWalkable(ax, az)) continue;
  const motor = new ArenaMotor(ax, az);
  motor.requestJump();
  for (let i = 0; i < 90; i++) {
    const dx = f.x - motor.x,
      dz = f.z - motor.z,
      d = Math.hypot(dx, dz),
      v = Math.min(3.35, d / STEP);
    motor.step(d ? (dx * v) / d : 0, d ? (dz * v) / d : 0);
  }
  assert.ok(motor.grounded && Math.abs(motor.y - terrain.arenaHeight(f.x, f.z) - f.top) < 0.002, f.id + ' supports a landing');
}

for (const latency of [50, 100, 200]) {
  const motor = new ArenaMotor(0, 0),
    net = new ArenaMotion(),
    messages = [];
  let remainder = 0,
    prevRender = 0,
    worst = 0,
    sequence = 0,
    stopped = 0;
  for (let frame = 0; frame < 180 * 5; frame++) {
    const now = (frame * 1000) / 180;
    remainder += 1 / 180;
    while (remainder >= STEP) {
      motor.step(0, now < 2700 ? 3.35 : 0);
      remainder -= STEP;
    }
    const render = motor.previous.z + ((motor.z - motor.previous.z) * remainder) / STEP;
    if (frame > 100 && now < 2600) assert.ok(Math.abs(render - prevRender - 3.35 / 180) < 1e-8);
    prevRender = render;
    if (frame % 18 === 0 && ++sequence % 13 !== 0) {
      messages.push({ at: now + latency / 2 + 12 * Math.sin(sequence), time: 100000 + now, z: motor.z, sequence });
    }
    while (messages.length && messages[0].at <= now) {
      const m = messages.shift();
      net.ingest('r', m.time, [{ id: 'peer', sequence: m.sequence, sampledAt: m.time, x: 0, z: m.z, yaw: 0, diveDepth: 1.5 }], now);
    }
    const pose = net.sample('peer', now);
    if (pose) {
      worst = Math.max(worst, Math.abs(pose.z - stopped));
      stopped = pose.z;
    }
  }
  assert.ok(worst < 0.12);
  assert.equal(stopped, motor.z);
  console.log('PASS ' + latency + ' ms, ~8% skipped moves, 180 Hz sprint + rest, maximum peer step ' + worst.toFixed(3) + ' m');
}

const timers = new Map();
let timerId = 0;
const timerGlobals = {
  setInterval: fn => {
    timers.set(++timerId, fn);
    return timerId;
  },
  clearInterval: id => timers.delete(id),
  setTimeout: fn => {
    timers.set(++timerId, fn);
    return timerId;
  },
  clearTimeout: id => timers.delete(id),
};
class Param {
  value = 0;
  cancelScheduledValues() {}
  setValueAtTime(v) {
    this.value = v;
  }
  linearRampToValueAtTime(v) {
    this.value = v;
  }
  setTargetAtTime(v) {
    this.value = v;
  }
}
class Node {
  gain = new Param();
  positionX = new Param();
  positionY = new Param();
  positionZ = new Param();
  connect() {}
  disconnect() {
    this.disconnected = true;
  }
}
const contexts = [];
class Context {
  state = 'running';
  currentTime = 1;
  nodes = [];
  listener = Object.fromEntries(
    ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'].map(n => [n, new Param()]),
  );
  addEventListener() {}
  removeEventListener() {}
  constructor() {
    contexts.push(this);
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
  createPanner() {
    const n = new Node();
    this.nodes.push(n);
    return n;
  }
  createGain() {
    return new Node();
  }
  createMediaStreamSource() {
    return new Node();
  }
  createAnalyser() {
    return { getFloatTimeDomainData: a => a.fill(0.1) };
  }
}
const roomEvents = new Proxy({}, { get: (_, key) => key }),
  connection = { Connected: 'connected', Reconnecting: 'reconnecting', SignalReconnecting: 'signal-reconnecting' };
const rooms = [];
let tickets = 0,
  ticketDeferred = null,
  connectDeferred = null,
  micDeferred = null,
  authListener;
class Room {
  handlers = new Map();
  state = 'disconnected';
  disconnects = 0;
  micCalls = [];
  canPlaybackAudio = true;
  localParticipant = {
    setMicrophoneEnabled: async value => {
      this.micCalls.push(value);
      if (value && micDeferred) await micDeferred;
    },
  };
  constructor(options) {
    this.options = options;
    rooms.push(this);
  }
  on(name, fn) {
    this.handlers.set(name, fn);
    return this;
  }
  emit(name, ...args) {
    this.handlers.get(name)?.(...args);
  }
  async connect() {
    this.connects = (this.connects ?? 0) + 1;
    if (connectDeferred) await connectDeferred;
    this.state = 'connected';
    this.emit('ConnectionStateChanged', this.state);
  }
  async disconnect() {
    this.disconnects++;
    this.state = 'disconnected';
  }
  async startAudio() {}
  removeAllListeners() {
    this.handlers.clear();
  }
}
const h = harness(),
  space = { current: { listener: { x: 0, z: 0, yaw: 0 }, players: new Map() } },
  me = { id: 'self', voiceIdentity: 'voice-1', canSpeak: true, online: true, x: 0, z: 0, yaw: 0 };
let state = { roomId: 'room', self: 'self', players: [me] },
  connected = true;
const { useArenaVoice } = evaluate(
  path + 'useArenaVoice.ts',
  {
    react: h.hooks,
    'livekit-client': { Room, RoomEvent: roomEvents, Track: { Kind: { Audio: 'audio' } }, ConnectionState: connection },
    axios: { isAxiosError: () => false },
    './arenaSpatial': spatial,
    './arenaTerrain': terrain,
    '@/services/speakingArenaApi': {
      getArenaVoice: async () => {
        tickets++;
        if (ticketDeferred) return ticketDeferred;
        return { identity: state.players[0].voiceIdentity, url: 'wss://fixture.invalid', token: 'synthetic' };
      },
    },
    '@/lib/auth-lifecycle': {
      authEnding: () => false,
      authEpoch: () => 1,
      subscribeAuthLifecycle: fn => {
        authListener = fn;
        return () => {
          authListener = null;
        };
      },
    },
  },
  { ...timerGlobals, AudioContext: Context, performance: { now: () => 1000 }, document: { body: { append() {} } } },
);
const motionStore = { history: new Map() };
let voice = h.render(() => useArenaVoice(state, connected, space, false, motionStore));
assert.equal(rooms.length, 0);
assert.equal(tickets, 0);
await voice.start();
voice = h.render();
await flush();
voice = h.render();
assert.equal(voice.status, 'connected');
assert.equal(tickets, 1);
assert.equal(rooms[0].micCalls.length, 0);
console.log('PASS media connection is explicit; connect never implicitly captures microphone');
voice.toggleMic();
voice = h.render();
await flush();
assert.equal(rooms[0].micCalls.at(-1), true);
state = { ...state, players: [{ ...me, canSpeak: false }] };
voice = h.render();
await flush();
assert.equal(rooms[0].micCalls.at(-1), false);
const remote = {
  kind: 'audio',
  setWebAudioPlugins(nodes) {
    this.plugins = nodes;
  },
  attach() {
    return { hidden: false };
  },
  detach() {
    return [
      {
        remove() {
          remote.removed = true;
        },
      },
    ];
  },
};
rooms[0].emit('TrackSubscribed', remote, {}, { identity: 'other-voice' });
for (const tick of timers.values()) tick();
assert.equal(remote.plugins[0].panningModel, 'equalpower');
assert.equal(remote.plugins[1].gain.value, 0);
state = { ...state, players: [state.players[0], { id: 'other', voiceIdentity: 'other-voice', canSpeak: true, online: true, x: 1, z: 0 }] };
voice = h.render();
for (const tick of timers.values()) tick();
assert.equal(remote.plugins[1].gain.value, 1);
state = { ...state, players: state.players.map(p => (p.id === 'other' ? { ...p, online: false } : p)) };
voice = h.render();
for (const tick of timers.values()) tick();
assert.equal(remote.plugins[1].gain.value, 0);
state = { ...state, players: state.players.map(p => ({ ...p, online: true })) };
voice = h.render();
for (const tick of timers.values()) tick();
assert.equal(remote.plugins[1].gain.value, 1);
const pair = state.players,
  extras = [];
for (const [i, x] of [1, 1.2, 6.1, 7, 8, 9].entries()) {
  const id = 'seat-' + i,
    track = { ...remote },
    member = { id, voiceIdentity: id, canSpeak: true, online: true, x, z: 0 };
  rooms[0].emit('TrackSubscribed', track, {}, { identity: id });
  extras.push({ track, member });
}
state = { ...state, players: [...pair, ...extras.map(e => e.member)] };
voice = h.render();
for (const tick of timers.values()) tick();
assert.deepEqual(
  [remote, ...extras.map(e => e.track)].map(t => t.plugins[1].gain.value > 0),
  [true, true, true, false, false, false, false],
);
motionStore.history.set('other', [{ x: 7, z: 0, yaw: 0 }]);
for (const tick of timers.values()) tick();
assert.equal(remote.plugins[1].gain.value, 0, 'stale renderer uses current motion deltas');
motionStore.history.clear();
for (const { track, member } of extras) rooms[0].emit('TrackUnsubscribed', track, {}, { identity: member.id });
state = { ...state, players: pair };
voice = h.render();
console.log('PASS 4 + 4 subscriptions, three audible neighbours, stale-renderer distance gates');
voice.toggleMute('other');
voice = h.render();
for (const tick of timers.values()) tick();
assert.equal(remote.plugins[1].gain.value, 0);
console.log('PASS authority disables capture; unknown, offline and locally muted emitters are inaudible');
connected = false;
voice = h.render();
assert.ok(rooms[0].disconnects > 0);
assert.equal(remote.removed, true);
assert.equal(timers.size, 0);
let resolveConnect;
connectDeferred = new Promise(r => {
  resolveConnect = r;
});
state = { ...state, players: [me] };
connected = true;
voice = h.render();
await flush();
const lateRoom = rooms.at(-1);
connected = false;
voice = h.render();
resolveConnect();
await flush();
assert.equal(lateRoom.micCalls.length, 0);
assert.ok(lateRoom.disconnects >= 2);
connectDeferred = null;
console.log('PASS late provider connection is disconnected before any microphone capture');
let resolveMic;
micDeferred = new Promise(r => {
  resolveMic = r;
});
connected = true;
voice = h.render();
await flush();
const lateMicRoom = rooms.at(-1);
assert.equal(lateMicRoom.micCalls.at(-1), true);
connected = false;
voice = h.render();
resolveMic();
await flush();
assert.equal(lateMicRoom.micCalls.at(-1), false);
assert.ok(lateMicRoom.disconnects >= 2);
micDeferred = null;
console.log('PASS microphone permission completing after control loss is immediately stopped');
let resolveTicket;
ticketDeferred = new Promise(r => {
  resolveTicket = r;
});
connected = true;
voice = h.render();
const waitingRoom = rooms.at(-1);
h.unmount();
resolveTicket({ identity: 'voice-1' });
await flush();
assert.equal(waitingRoom.connects, undefined);
assert.equal(contexts[0].state, 'closed');
assert.equal(authListener, null);
console.log('PASS control loss disconnects tracks; late tickets cannot reconnect after unmount');
const m = harness();
let resolveStream,
  trackStops = 0;
const docListeners = new Map();
const { useArenaMicCheck } = evaluate(
  path + 'useArenaMicCheck.ts',
  { react: m.hooks },
  {
    ...timerGlobals,
    AudioContext: Context,
    navigator: {
      mediaDevices: {
        getUserMedia: () =>
          new Promise(r => {
            resolveStream = r;
          }),
      },
    },
    document: {
      addEventListener: (name, fn) => docListeners.set(name, fn),
      removeEventListener: name => docListeners.delete(name),
    },
  },
);
let check = m.render(() => useArenaMicCheck());
const late = check.start();
check = m.render();
check.stop();
m.unmount();
resolveStream({
  getTracks: () => [
    {
      stop() {
        trackStops++;
      },
    },
  ],
});
await late;
assert.equal(trackStops, 1);
assert.equal(timers.size, 0);
assert.equal(docListeners.size, 0);
console.log('PASS local microphone check closes a permission request that resolves after cancellation');
const r = harness();
let client,
  receive,
  serial = 0;
class StompClient {
  connected = false;
  published = [];
  constructor(options) {
    this.options = options;
    client = this;
  }
  activate() {
    this.connected = true;
    this.options.onConnect();
  }
  deactivate() {
    this.connected = false;
    return Promise.resolve();
  }
  subscribe(_destination, fn) {
    receive = event => fn({ body: JSON.stringify(event) });
  }
  publish(frame) {
    this.published.push({ action: frame.destination.split('/').at(-1), ...JSON.parse(frame.body) });
  }
}
const { useArenaRoom } = evaluate(
  path + 'useArenaRoom.ts',
  {
    react: r.hooks,
    './arenaMotion': evaluate(path + 'arenaMotion.ts', { './arenaTerrain': terrain }),
    '@stomp/stompjs': { Client: StompClient },
    '@/lib/api-session': { ensureApiSession: async () => true },
    '@/lib/auth-lifecycle': { authEnding: () => false, authEpoch: () => 1, subscribeAuthLifecycle: () => () => {} },
    '@/services/stompClient': { getWsUrl: () => 'ws://fixture.invalid' },
  },
  { ...timerGlobals, crypto: { randomUUID: () => `request-${++serial}` }, performance: { now: () => 1000 } },
);
let controls = r.render(() => useArenaRoom());
assert.equal(controls.connected, false);
receive({ type: 'SYNC', state: { roomId: 'restored-room', revision: 4, players: [] } });
controls = r.render();
const firstRejoin = client.published.at(-1);
assert.equal(firstRejoin.action, 'rejoin');
const before = client.published.length;
assert.equal(controls.send('move', { x: 1, z: 2 }), false);
assert.equal(controls.send('ping'), false);
assert.equal(client.published.length, before, 'restored scene cannot send with the old socket binding');
receive({ type: 'ERROR', requestId: firstRejoin.requestId, code: 'ROOM_BUSY' });
controls = r.render();
for (const tick of [...timers.values()]) tick();
const retryRejoin = client.published.at(-1);
assert.equal(retryRejoin.action, 'rejoin');
assert.notEqual(retryRejoin.requestId, firstRejoin.requestId);
receive({ type: 'ACK', requestId: retryRejoin.requestId, state: { roomId: 'restored-room', revision: 5, players: [] } });
controls = r.render();
assert.equal(controls.connected, true);
assert.equal(controls.move(1, 2, 0.5, false, 2.75), true);
assert.equal(client.published.at(-1).aux, 2.75, 'diveDepth forwarded in move frame');
client.options.onWebSocketClose();
controls = r.render();
assert.equal(controls.send('ping'), false);
r.unmount();
console.log('PASS socket recovery holds movement/heartbeats until rejoin ACK, forwards diveDepth, and retries a busy authority');

// Wave 9 E01: Palm & Tropical Fruit Crown Attachment, Gravity-Bounce-Roll Physics & Persistent Landed Lifecycle
{
  const THREE = require('three');
  const fruitMod = evaluate(path + 'arenaFruitTrees.ts', {
    './arenaAssets': assets,
    './arenaTerrain': terrain,
  });
  const testScene = new THREE.Scene();
  const ft = new fruitMod.ArenaFruitTrees(testScene, 'qa-fruit-account', { low: true });
  const snap0 = ft.getTreesSnapshot();
  assert.equal(snap0.length, 16, '16 tropical fruit trees initialized');
  for (const t of snap0) {
    const spec = fruitMod.DEFAULT_FRUIT_TREES.find(s => s.id === t.id);
    const gY = terrain.arenaHeight(spec.x, spec.z);
    for (const sock of t.sockets) {
      const relY = sock.restY - gY;
      if (t.kind === 'coconut') assert.ok(relY > 7.7 && relY < 8.2, `coconut crown socket ${relY.toFixed(2)}m at curved palm crown`);
      if (t.kind === 'papaya') assert.ok(relY > 4.0 && relY < 4.35, `papaya crown socket ${relY.toFixed(2)}m at crownshaft`);
      if (t.kind === 'banana') assert.ok(relY > 1.8 && relY < 2.35, `banana bunch socket ${relY.toFixed(2)}m on stalk`);
      if (t.kind === 'mango') assert.ok(relY > 2.5 && relY < 3.2, `mango bough socket ${relY.toFixed(2)}m under canopy`);
    }
  }
  const coco = fruitMod.DEFAULT_FRUIT_TREES.find(s => s.kind === 'coconut');
  const px = coco.x - 1.2,
    pz = coco.z - 0.6,
    py = terrain.arenaFloor(px, pz);
  const shook = ft.triggerInteraction(px, py, pz, Math.atan2(coco.x - px, coco.z - pz));
  assert.equal(shook, true, 'shaking coconut palm succeeds');
  // Step 0.85 s (mid-fall): fruit must NOT prematurely auto-collect in mid-air!
  for (let f = 0; f < 51; f++) {
    ft.update({ dt: 1 / 60, time: f / 60, playerX: px, playerY: py, playerZ: pz, lookYaw: 0, listenerX: px, listenerZ: pz, listenerYaw: 0 });
  }
  const activeMidFall = ft.getDroppedPool().filter(d => d.active);
  assert.ok(activeMidFall.length >= 1, 'falling coconuts do not vanish mid-air');
  // Step another 3.0 s with stationary shaker: fruit bounces, rolls, settles on sand, and persists!
  for (let f = 51; f < 231; f++) {
    ft.update({ dt: 1 / 60, time: f / 60, playerX: px, playerY: py, playerZ: pz, lookYaw: 0, listenerX: px, listenerZ: pz, listenerYaw: 0 });
  }
  const settledFruits = ft.getDroppedPool().filter(d => d.active && d.settled);
  assert.ok(settledFruits.length >= 1, 'dropped coconuts bounce, roll, and persist settled on sand');
  ft.dispose();
  console.log('PASS E01 palm & tropical fruit crown sockets (+7.94 m coconut), bounce-roll physics, and persistent ground lifecycle');
}

// Phase 2B: Authoritative `tree_trunk` Colliders, Swept Anti-Tunneling & Full Island/Kiosk/Fruit/Pier Reachability
{
  const treeTrunks = layout.obstacles.filter(o => o.kind === 'tree_trunk');
  assert.ok(treeTrunks.length > 0, 'authoritative tree_trunk colliders exist in layout');
  let sweptTested = 0;
  for (const t of treeTrunks) {
    assert.equal(terrain.arenaWalkable(t.x, t.z), false, `tree_trunk at (${t.x}, ${t.z}) blocks interior`);
    if (sweptTested < 12) {
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        const dist = t.radius + 0.95;
        const ax = t.x - Math.cos(ang) * dist;
        const az = t.z - Math.sin(ang) * dist;
        const bx = t.x + Math.cos(ang) * dist;
        const bz = t.z + Math.sin(ang) * dist;
        if (terrain.arenaDryWalkable(ax, az) && terrain.arenaDryWalkable(bx, bz)) {
          const stopped = terrain.arenaStep(ax, az, bx, bz);
          const proj = (stopped.x - t.x) * Math.cos(ang) + (stopped.z - t.z) * Math.sin(ang);
          assert.ok(proj < 0, 'arenaStep stops cleanly before tunneling through tree_trunk');
          assert.ok(terrain.arenaWalkable(stopped.x, stopped.z), 'stopped stance outside tree_trunk remains walkable');
          sweptTested++;
          break;
        }
      }
    }
  }
  assert.ok(sweptTested >= 5, 'verified swept collision against multiple live tree_trunk colliders');

  const kiosks = layout.interactables.filter(i => i.kind === 'kiosk');
  assert.equal(kiosks.length, 15);
  for (const k of kiosks) {
    let reachable = false;
    for (let s = 0; s < 16 && !reachable; s++) {
      const a = (s / 16) * Math.PI * 2;
      for (const r of [1.2, 1.65, 2.05]) {
        const px = k.x + Math.cos(a) * r;
        const pz = k.z + Math.sin(a) * r;
        if (terrain.arenaWalkable(px, pz) && terrain.arenaInReach(px, pz, k.x, k.z)) {
          reachable = true;
          break;
        }
      }
    }
    assert.ok(reachable, `speaking kiosk ${k.id} remains reachable around tree_trunk colliders`);
  }

  const fruitSpecs = layout.interactables.filter(i => i.kind === 'fruit_tree');
  assert.equal(fruitSpecs.length, 16);
  for (const ft of fruitSpecs) {
    let reachable = false;
    for (let s = 0; s < 16 && !reachable; s++) {
      const a = (s / 16) * Math.PI * 2;
      for (const r of [1.1, 1.5, 1.95]) {
        const px = ft.x + Math.cos(a) * r;
        const pz = ft.z + Math.sin(a) * r;
        if (terrain.arenaWalkable(px, pz) && terrain.arenaInReach(px, pz, ft.x, ft.z)) {
          reachable = true;
          break;
        }
      }
    }
    assert.ok(reachable, `fruit tree ${ft.id} remains reachable around tree_trunk colliders`);
  }
  console.log(`PASS Phase 2B ${treeTrunks.length} tree_trunk colliders block tunneling while keeping 15 kiosks, 16 fruit trees, 11 docks, and 15 islands reachable`);
}

// Phase 2B: Underwater Control Guide 5.0 s Auto-Hide (`0 ms` -> `4,500 ms` fading -> `5,000 ms` hidden -> clean re-dive reset)
{
  const copyMod = evaluate(path + 'arenaCopy.ts');
  const interactionsMod = evaluate(path + 'arenaInteractions.ts', {
    './arenaCopy': copyMod,
    './arenaTerrain': terrain,
  });
  const guideTimer = new interactionsMod.ArenaSwimGuideTimer();
  const baseParams = {
    px: 120,
    py: terrain.ARENA_WATER_Y - 2.6,
    pz: 40,
    lookYaw: 0,
    grounded: false,
    swimMode: 'underwater_dive',
    waterDepth: 6.5,
    dockClimb: null,
    fishingHint: null,
    fruitAction: null,
    seat: null,
    boatId: null,
    hasRoom: false,
    players: [],
    occupiedSeats: new Set(),
    fleet: { boats: new Map(), clearOfBoats: () => true },
    litBeacons: new Set(),
    showBoatControlsHint: false,
    holding: null,
    placeTable: null,
    rests: new Map(),
  };

  const st0 = guideTimer.step('underwater_dive', 0);
  assert.equal(st0.showUnderwaterHint, true, 'underwater guide visible at 0 ms');
  assert.equal(st0.underwaterFading, false, 'underwater guide not fading at 0 ms');
  const act0 = interactionsMod.selectContextualAction({
    ...baseParams,
    showUnderwaterControlsHint: st0.showUnderwaterHint,
    underwaterHintFading: st0.underwaterFading,
  });
  assert.equal(act0?.key, 'swim-hint:dive');
  assert.equal(Boolean(act0?.fading), false);

  const st4500 = guideTimer.step('underwater_dive', 4500);
  assert.equal(st4500.showUnderwaterHint, true, 'underwater guide still mounted during fade window at 4500 ms');
  assert.equal(st4500.underwaterFading, true, 'underwaterFading === true at 4500 ms');
  const act4500 = interactionsMod.selectContextualAction({
    ...baseParams,
    showUnderwaterControlsHint: st4500.showUnderwaterHint,
    underwaterHintFading: st4500.underwaterFading,
  });
  assert.equal(act4500?.key, 'swim-hint:dive:fading');
  assert.equal(act4500?.fading, true);

  const st5000 = guideTimer.step('underwater_dive', 500);
  assert.equal(st5000.showUnderwaterHint, false, 'underwater guide hidden completely at 5000 ms');
  assert.equal(st5000.underwaterFading, false);
  const act5000 = interactionsMod.selectContextualAction({
    ...baseParams,
    showUnderwaterControlsHint: st5000.showUnderwaterHint,
    underwaterHintFading: st5000.underwaterFading,
  });
  assert.equal(act5000, null, 'contextual underwater hint unmounts cleanly at 5000 ms');

  // Resurface and dive again -> resets cleanly for the next dive!
  guideTimer.step('surface_swim', 16);
  const stRedive = guideTimer.step('underwater_dive', 0);
  assert.equal(stRedive.showUnderwaterHint, true, 'underwater guide resets cleanly upon resurfacing and diving again');
  assert.equal(stRedive.underwaterFading, false);
  assert.equal(stRedive.elapsedUnderwaterMs, 0);
  console.log('PASS Phase 2B ArenaSwimGuideTimer 5.0 s auto-hide (0 ms visible -> 4500 ms fading -> 5000 ms unmounted -> clean re-dive reset)');
}

console.log('Speaking Arena v7: 12 behavioral groups passed (mock media, not acoustic/provider acceptance).');
