import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const source = readFileSync(new URL('../src/components/features/flashcard/pvp/useCardBlastPvP.ts', import.meta.url), 'utf8');
const { code } = babel.core().transformSync(source, {
  filename: 'useCardBlastPvP.ts', configFile: false, babelrc: false,
  presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()],
});

// Execute the real hook's actions/callbacks with controlled transport and timers.
// The separate React SSR test covers real React initialization/source ordering.
function harness() {
  let cursor = 0, timerId = 0;
  const slots = [], effects = [], timers = new Map(), clients = [];
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: initial };
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }];
    },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!slots[index] || deps.some((d, i) => d !== slots[index].deps[i])) slots[index] = { fn, deps };
      return slots[index].fn;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!slots[index] || deps?.some((d, i) => d !== slots[index].deps?.[i])) {
        slots[index]?.cleanup?.(); effects.push(() => { slots[index] = { deps, cleanup: fn() }; });
      }
    },
  };
  class Client {
    constructor(config) { this.config = config; this.connected = false; this.subscriptions = new Map(); this.frames = []; clients.push(this); }
    activate() { this.connected = true; this.config.onConnect(); }
    deactivate() { this.connected = false; return Promise.resolve(); }
    subscribe(topic, callback) { this.subscriptions.set(topic, callback); return { unsubscribe: () => this.subscriptions.delete(topic) }; }
    publish(frame) { this.frames.push(frame); }
    emit(type, payload) { this.subscriptions.get('/user/queue/pvp')({ body: JSON.stringify({ type, payload }) }); }
    pong() { this.emit('PONG', { clientTimeMs: Date.now(), serverTimeMs: Date.now() }); }
  }
  const timer = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; };
  const exports = {};
  runInNewContext(code, {
    exports, require: name => name === 'react' ? react : name === '@stomp/stompjs' ? { Client, TickerStrategy: { Worker: 'worker' } }
      : name === 'next-auth/react' ? { getSession: async () => ({ user: { id: '1' } }) }
      : name === '@/lib/api-session' ? { ensureApiSession: async () => true } : require(name),
    process, console, performance, window: { location: { protocol: 'http:', host: 'localhost:3002', hostname: 'localhost' } },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: timer, clearTimeout: id => timers.delete(id), setInterval: timer, clearInterval: id => timers.delete(id),
    requestAnimationFrame: fn => timer(fn, 16), cancelAnimationFrame: id => timers.delete(id),
  });
  const render = () => { cursor = 0; const hook = exports.useCardBlastPvP(); while (effects.length) effects.shift()(); return hook; };
  return { render, clients, unmount: () => slots.forEach(s => s?.cleanup?.()),
    expire: ms => { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); } } };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const params = { deckTitle: 'Disposable test vocabulary', mode: 'HUMAN', direction: 'VI_EN' };
const room = n => ({ roomCode: `TEST${n}`, mode: 'HUMAN', status: 'WAITING', host: { userId: '1' } });
const h = harness(); let hook = h.render();
const first = hook.createRoom(params);
const duplicate = hook.createRoom(params);
await flush(); const client = h.clients[0];
assert.equal(h.clients.length, 1);
assert.equal(client.frames.filter(f => f.destination === '/app/pvp/create').length, 0, 'Never send before private queue is proven ready');
client.pong(); await first; await duplicate;
assert.equal(client.frames.filter(f => f.destination === '/app/pvp/create').length, 1, 'Early/double click queues one intent');
h.expire(8000); hook = h.render(); assert.match(hook.error, /Không nhận được/);
await hook.createRoom(params);
assert.equal(client.frames.filter(f => f.destination === '/app/pvp/create').length, 1, 'A timeout cannot unlock an outstanding intent');
client.emit('ROOM_CREATED', room(0)); hook = h.render();
assert.equal(hook.error, null); assert.equal(hook.isCreatingRoom, false); assert.equal(hook.phase, 'LOBBY');
h.expire(8000); assert.equal(h.render().error, null, 'Success wins over stale failure timers');
for (let n = 1; n <= 20; n++) {
  hook = h.render(); hook.leaveRoom(); client.emit('ROOM_LEFT', {}); hook = h.render();
  await Promise.all([hook.createRoom(params), hook.createRoom(params)]);
  client.emit('ROOM_CREATED', room(n)); hook = h.render();
  assert.equal(hook.room.roomCode, `TEST${n}`); assert.equal(hook.error, null);
}
assert.equal(client.frames.filter(f => f.destination === '/app/pvp/create').length, 21);
hook.leaveRoom(); client.emit('ROOM_LEFT', {}); hook = h.render();
await hook.createRoom(params); hook.leaveRoom(); client.emit('ROOM_CREATED', room(99));
assert.equal(h.render().room, null, 'A cancelled late result must not reopen the lobby');
assert.equal(JSON.parse(client.frames.at(-1).body).roomCode, 'TEST99', 'Release a room acknowledged after cancellation');
client.emit('ROOM_LEFT', {});
hook = h.render(); await hook.createRoom(params);
const sendsBeforeReconnect = client.frames.filter(f => f.destination === '/app/pvp/create').length;
client.config.onConnect(); client.pong(); await flush();
assert.equal(client.frames.filter(f => f.destination === '/app/pvp/create').length, sendsBeforeReconnect, 'Reconnect never resends CREATE');
assert.equal(client.frames.at(-1).destination, '/app/pvp/rejoin');
assert.deepEqual(JSON.parse(client.frames.at(-1).body), {}, 'Recover pending ACK using authenticated membership');
client.emit('ROOM_REJOINED', room(100)); hook = h.render();
assert.equal(hook.room.roomCode, 'TEST100'); assert.equal(hook.error, null); assert.equal(hook.isCreatingRoom, false);
const cancelled = harness(); const pending = cancelled.render().createRoom(params);
cancelled.unmount(); await flush(); await pending;
assert.equal(cancelled.clients.length, 0, 'No connection or create after unmount during auth lookup');
console.log('Card Blast create actions: PASS (private-channel readiness, one queued intent, double click, 20 fresh attempts, timeout/late-success race, cancellation/unmount).');
