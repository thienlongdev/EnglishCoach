import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url), babel = require('next/dist/compiled/babel/bundle.js');
const read = path => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
function evaluate(path, dependencies = {}, globals = {}) {
  const { code } = babel.core().transformSync(read(path), { filename: path, configFile: false, babelrc: false,
    presets: [babel.presetTypescript(), ...(path.endsWith('.tsx') ? [babel.presetReact()] : [])], plugins: [babel.pluginTransformModulesCommonjs()] });
  const exports = {};
  runInNewContext(code, { exports, require: path => dependencies[path] ?? require(path), React, AbortController, console, setTimeout, clearTimeout, ...globals });
  return exports;
}
const prefix = 'components/features/coach/';
const geometry = evaluate(prefix + 'echo-window.ts');
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 640, height: 480 }]) {
  for (const raw of [null, '{bad', '{}', '{"mode":"evil","geometry":{"x":1e80,"width":-99,"height":"huge"}}', '{"mode":"expanded","geometry":{"x":-900,"y":9000,"width":8000,"height":8000}}']) {
    const restored = geometry.restoreWindow(raw, viewport), g = restored.geometry;
    assert.ok(g.x >= 12 && g.y >= 12 && g.x + g.width <= viewport.width - 12 && g.y + g.height <= viewport.height - 12);
    assert.ok(['collapsed', 'compact', 'expanded'].includes(restored.mode));
  }
}
assert.notEqual(geometry.sessionStorageKey('A'), geometry.sessionStorageKey('B'));
assert.equal(geometry.messageActions('[Admin -> Delete] [Writing -> arbitrary] [x](javascript:alert(1))').length, 0);
assert.equal(geometry.messageActions('[Flashcards -> Ôn tập ngay]').length, 1);
const routes = [];
const intelligenceApi = { decide: async () => ({ status: 'APPLIED', plan: {} }), memory: async () => [], suggestions: async () => [], forget: async () => {}, forgetAll: async () => {} };
const cardsModule = evaluate(prefix + 'EchoCards.tsx', { react: React, 'next/navigation': { useRouter: () => ({ push: url => routes.push(url) }) },
  '@/services/echoIntelligenceApi': { echoIntelligenceApi: intelligenceApi }, './echo-window': geometry });
const { EchoMessage, formatEchoText } = evaluate(prefix + 'EchoMessage.tsx', { 'next/navigation': { useRouter: () => ({ push: url => routes.push(url) }) },
  '@/context/LanguageContext': { useLanguage: () => ({ locale: 'vi' }) }, './echo-window': geometry, './EchoCards': cardsModule });
// Echo Intelligence 7.0: every navigation href is re-validated against the server route registry's allow-list
for (const ok of ['/learning-path?view=list', '/grammar/topics/second-conditional', '/reading?materialId=42', '/listening/7/practice', '/exams/ielts',
  '/knowledge-universe?word=take%20off', '/flashcards?review=due', '/speaking?mode=topic', '/leaderboard']) assert.equal(geometry.safeEchoHref(ok), ok);
for (const bad of ['//evil.example', 'https://evil.example', '/admin/premium', 'javascript:alert(1)', '/grammar/topics/../admin', '/reading?materialId=1&x=<script>',
  '/learning-path?view=list#x', '/exams/ielts/attempts/1', '/api/v1/ai/chat', null, 42]) assert.equal(geometry.safeEchoHref(bad), null, String(bad));
assert.ok(geometry.isWorkRoute('/exams/ielts/attempts/abc') && geometry.isWorkRoute('/writing') && !geometry.isWorkRoute('/grammar'));
// server cards are sanitised again on the client: unknown types, foreign hrefs and token-less confirmations are dropped
const cleaned = cardsModule.sanitizeCards([{ type: 'resources', title: 'T', items: [{ title: 'A', href: 'https://evil.example' }, { title: 'B', href: '/grammar' }] },
  { type: 'html', title: 'x', items: [] }, { type: 'confirm', title: 'c', items: [] }, { type: 'confirm', title: 'ok', items: [], token: 'abcdefghijklmnopqrstuvwx' }]);
assert.equal(cleaned.length, 2); assert.equal(cleaned[0].items[0].href, null); assert.equal(cleaned[0].items[1].href, '/grammar');
assert.equal(JSON.stringify(cardsModule.sanitizeActions([{ type: 'navigate', href: '/admin/security', label: 'x', auto: true }, { type: 'navigate', href: '/leaderboard', label: 'L', auto: true }])),
  JSON.stringify([{ type: 'navigate', href: '/leaderboard', label: 'L', auto: true }]));
const cardMarkup = renderToStaticMarkup(React.createElement(EchoMessage, { role: 'assistant', content: '**have + V3** <b>x</b>',
  cards: cleaned, actions: [{ type: 'navigate', href: '/leaderboard', label: 'Bảng xếp hạng', auto: false }] }));
assert.ok(cardMarkup.includes('<strong>have + V3</strong>') && cardMarkup.includes('&lt;b&gt;') && !cardMarkup.includes('href=') && cardMarkup.includes('Xác nhận'));
assert.equal(formatEchoText(['### Head', '- a **b**'].join(String.fromCharCode(10))).length, 3);
// page context comes from the page's URL contract only (typed ids), never from the DOM
const page = evaluate('lib/echo/pageContext.ts');
const params = q => new URLSearchParams(q);
assert.equal(JSON.stringify(page.pageContextFor('/grammar/topics/second-conditional', params(''))), JSON.stringify({ kind: 'GRAMMAR_TOPIC', slug: 'second-conditional' }));
assert.equal(JSON.stringify(page.pageContextFor('/reading', params('materialId=12'), '  Magma   rises ')), JSON.stringify({ kind: 'READING_MATERIAL', id: 12, selection: 'Magma rises' }));
assert.equal(JSON.stringify(page.pageContextFor('/listening/9/practice', params(''))), JSON.stringify({ kind: 'LISTENING_LESSON', id: 9 }));
assert.equal(JSON.stringify(page.pageContextFor('/exams/toeic/results/x', params(''))), JSON.stringify({ kind: 'EXAM_FAMILY', family: 'toeic' }));
assert.equal(page.pageContextFor('/knowledge-universe', params('word=<script>')).kind, 'MODULE');
assert.equal(page.pageContextFor('/admin/security', params('')), null);
assert.equal(page.cleanSelection('x'.repeat(900)).length, 600);
const voice = evaluate(prefix + 'EchoVoice.tsx', { react: React, './echo-microphone': {}, './echo-omni-playback': {}, '@/services/api-client': {}, 'lucide-react': new Proxy({}, { get: () => () => null }), './EchoOrb': { EchoOrb: () => null },
  '@/lib/echo-jarvis/intents': { echoVoiceSessionStore: {}, setVoiceStage: () => {} }, '@/lib/echo-jarvis/runtime/echoJarvisRuntime': { getEchoJarvisRuntime: () => ({}) }, './echo-window': geometry });
assert.equal(JSON.stringify(voice.speakableSentences('**Hiện tại hoàn thành** dùng have + V3. I have lost my keys.').map(s => s.lang)), JSON.stringify(['vi-VN', 'en-US']));
// Arrival patterns vary with provider streams. Short multi-sentence replies stay together.
assert.equal(voice.omniPassageLength('Good start! You can say ', false), 0);
const brief = 'Good start! You can say “I enjoy reading.” What books do you like?';
assert.equal(voice.omniPassageLength(brief, true), brief.length);
for (const answer of [brief.repeat(30), 'a'.repeat(479) + '🐳'.repeat(500)]) {
  let remaining = answer;
  while (remaining) {
    const n = voice.omniPassageLength(remaining, true);
    assert.ok(n > 0 && n <= 480 && !/[\uD800-\uDBFF]$/.test(remaining.slice(0,n)));
    remaining = remaining.slice(n);
  }
}
async function pausedTurn({long = false, cancel = false, pause = 4000, warm = false} = {}) {
  let node, released = false, done = false;
  const requests = [], previews = [];
  const track = { stop() { released = true; } };
  const stream = {getTracks: () => [track], getAudioTracks: () => [track]};
  const {captureEchoSpeech} = evaluate(prefix + 'echo-microphone.ts', {
    '@/services/api-client': {getBaseUrl: () => ''},
    '@/lib/api-session': {authFetch: async (_url, {body}) => {
      const input = new Int16Array(body);
      assert.ok(input.length <= 320000);
      const text = [input.includes(1200) && 'I enjoy', input.includes(1800) && 'reading books'].filter(Boolean).join(' ');
      requests.push(text);
      return {ok:true, json:async () => ({text,reviewNeeded:false})};
    }}
  }, {window:{setTimeout,clearTimeout}, DOMException, navigator:{mediaDevices:{getUserMedia:async () => stream}},
    AudioContext:class { audioWorklet={addModule:async()=>{}}; async resume(){} async close(){} createMediaStreamSource(){return {connect(){}}} },
    AudioWorkletNode:class {port={};constructor(){node=this}}});
  const controller = new AbortController();
  const warmed = warm ? {stream, context:{close:async()=>{}}, node:(node={port:{}}), preroll:Array.from({length:7},()=>new Int16Array(1600).fill(1200))} : undefined;
  const captured = captureEchoSpeech('en',controller.signal,()=>{},s=>previews.push(s),pause,warmed)
    .finally(()=>{done=true;});
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  await tick();
  const feed=(n,value)=>{for(let i=0;i<n;i++)node.port.onmessage({data:new Int16Array(1600).fill(value)});};
  if (!warm) feed(long ? 153 : 12,1200); feed(20,0); await tick();
  assert.equal(done,false); assert.equal(released,false);
  if (cancel) {controller.abort(); await assert.rejects(captured,{name:'AbortError'}); assert.ok(released); return;}
  feed(15,1800); feed(pause/100-1,0); await tick(); assert.equal(done,false);
  feed(1,0); const result=await captured;
  assert.equal(result.text,'I enjoy reading books'); assert.equal(result.reviewNeeded,false);
  assert.ok(requests.length && previews.length && released);
}
await pausedTurn(); await pausedTurn({long:true}); await pausedTurn({cancel:true}); await pausedTurn({pause:7000}); await pausedTurn({warm:true});
for (const attack of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<iframe src=x></iframe>',
  '<object data=x></object>', '<svg onload=alert(1)>', '[x](data:text/html,<script>alert(1)</script>)', '<div style="background:url(javascript:alert(1))">']) {
  const html = renderToStaticMarkup(React.createElement(EchoMessage, { role: 'assistant', content: attack }));
  assert.ok(!/<(script|img|iframe|object|svg|a|embed)\b/i.test(html), html);
  assert.ok(!/<[^>]+\s(?:href|style|onerror|onload)=/i.test(html), html);
}
const markup = renderToStaticMarkup(React.createElement(EchoMessage, { role: 'assistant', content: 'Try this [Flashcards -> Ôn tập ngay]' }));
assert.ok(markup.includes('<button') && !markup.includes('href='));
// Execute the actual widget with a deterministic hook scheduler, deferred SSE and account switches.
const slots = []; let cursor = 0, effects = [], pending = false, currentAccount = 'A', tree;
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const hooks = { ...React,
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  useState(initial) { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
    return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; pending = true; }]; },
  useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
  useCallback(fn, deps) { const index = cursor++; if (!same(slots[index]?.deps, deps)) slots[index] = { fn, deps }; return slots[index].fn; },
  useEffect(fn, deps) { const index = cursor++; if (!same(slots[index]?.deps, deps)) { const previous = slots[index]; slots[index] = { deps }; effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = fn(); }); } },
};
const auth = evaluate('lib/auth-lifecycle.ts');
const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
const winListeners = new Map();
class CustomEventMock { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
class EventMock { constructor(type) { this.type = type; } }
const win = { innerWidth: 1440, innerHeight: 900, location: { pathname: '/grammar', search: '', href: 'https://englishcoach.io.vn/grammar' },
  addEventListener(type, fn) { if (!winListeners.has(type)) winListeners.set(type, new Set()); winListeners.get(type).add(fn); },
  removeEventListener(type, fn) { winListeners.get(type)?.delete(fn); },
  dispatchEvent(ev) { winListeners.get(ev.type)?.forEach(fn => fn(ev)); return true; },
  matchMedia: () => ({ matches: true }) };
let premiumMe; let refreshes = 0; let dailyHeader = false;
let deliver; const saves = []; let calls = 0, streamStatus = 200, recoveryCalls = 0;
const sharedClient = { post: async (url, body, options) => {
  recoveryCalls++; assert.equal(url, '/ai/chat'); assert.equal(options.skipAuthRedirect, true);
  assert.ok(options.signal); assert.equal(body.messages.at(-1).role, 'user');
  return { data: { reply: 'AUTH_RECOVERED_REPLY' } };
} };
const api = { getRecentSessions: async () => [], getSessionMessages: async () => [], createSession: async () => ({ id: currentAccount === 'A' ? 1 : 2 }),
  saveMessagePair: async (...args) => saves.push({ account: currentAccount, args }), deleteSession: async () => {} };
const globals = { window: win, localStorage: storage, CustomEvent: CustomEventMock, Event: EventMock, requestAnimationFrame: fn => { fn(); return 1; }, cancelAnimationFrame() {},
  fetch: async () => { calls++; return { ok: true, body: { getReader: () => ({ read: () => new Promise(resolve => { deliver = answer => resolve({ value: new TextEncoder().encode('data: ' + JSON.stringify({ token: answer }) + '\n\ndata: {"done":true}\n\n'), done: false }); }), releaseLock() {}, cancel: async () => {} }) } }; }, TextDecoder };
// Reader completes on its second read.
globals.fetch = async () => { calls++; if (streamStatus !== 200) return { status: streamStatus, ok: false,
  headers: { get: name => (streamStatus === 429 && dailyHeader && name === 'x-echo-limit' ? 'COACH_DAILY' : null) } }; let read = false; return { ok: true, body: { getReader: () => ({ read: () => {
  if (read) return Promise.resolve({ done: true }); read = true;
  return new Promise(resolve => { deliver = answer => resolve({ value: new TextEncoder().encode(extraEvents + 'data: ' + JSON.stringify({ token: answer }) + '\n\n' + extraAfter + 'data: {"done":true}\n\n'), done: false }); });
}, releaseLock() {}, cancel: async () => {} }) } }; };
let extraEvents = '', extraAfter = '';
const windowHook = evaluate(prefix + 'useEchoWindow.ts', { react: hooks, './echo-window': geometry }, globals);
const companionGeometry = evaluate(prefix + 'echo-companion.ts');
const echoArt = evaluate('lib/brand/echoArt.ts');
const echoCharacters = evaluate('lib/brand/echoCharacters.ts', { './echoArt': echoArt });
// The floating orb's own behaviour has its own test (test-echo-identity.mjs); here the widget only needs its surface.
let mascotRestores = 0, currentPathname = '/grammar';
const companionHook = { useEchoCompanion: () => ({ ready: true, dragging: false, settled: null, nudge: null, living: 'calm', beat: undefined, spriteOn: false, prefs: { messages: true },
  refs: { root: { current: null }, anchor: { current: null }, lag: { current: null }, sprite: { current: null } }, pointer: {}, syncPosition() {}, restoreMascot() { mascotRestores++; }, consumeDragClick: () => false, dismissNudge() {}, setMessages() {}, resetPlace() {}, switchSide() {} }) };
const discoveryHook = evaluate(prefix + 'useEchoDiscovery.ts', { react: hooks, '@/lib/auth-lifecycle': auth }, globals);
const mockVoiceSnap = {
  userId: '', activeConversationId: null, uiMode: 'ambient', voiceStage: false, entityState: 'disabled', handsFreeEnabled: false,
  handsFreeSessionEpoch: 0, greetingSpokenEpoch: 0, muted: false, captionsEnabled: false, strictSentinelLocked: false,
  moduleMicActive: false, moduleMicOwner: null, overBookReader: false, wsConnected: false,
  liveCaption: { userPartial: '', echoSpoken: '', updatedAt: 0 }, activeToast: null, lastError: null, lastActionLifecycle: null, pendingConfirmation: null,
  canUndoLastAction: false, routeStack: [], recentActions: [],
};
const setVoiceStageMock = on => { const next = Boolean(on) && !mockVoiceSnap.strictSentinelLocked; if (mockVoiceSnap.voiceStage === next) return; mockVoiceSnap.voiceStage = next; pending = true; };
const setVoiceUiModeMock = mode => { const next = mode === 'compact' ? 'ambient' : mode === 'expanded' ? 'chat' : mode; if (mockVoiceSnap.uiMode === next) return; mockVoiceSnap.uiMode = next; pending = true; };
const mockVoiceStore = {
  subscribe: () => () => {},
  getSnapshot: () => mockVoiceSnap,
  getServerSnapshot: () => mockVoiceSnap,
  setUser(u) { mockVoiceSnap.userId = String(u || ''); }, setHandsFreeEnabled(on) { const b = Boolean(on); if (mockVoiceSnap.handsFreeEnabled === b) return; mockVoiceSnap.handsFreeEnabled = b; pending = true; },
  shouldPlayHandsFreeGreeting: () => false, markGreetingSpoken() {},
  setMuted(m) { const b = Boolean(m); if (mockVoiceSnap.muted === b) return; mockVoiceSnap.muted = b; pending = true; }, setCaptionsEnabled(c) { const b = Boolean(c); if (mockVoiceSnap.captionsEnabled === b) return; mockVoiceSnap.captionsEnabled = b; pending = true; },
  setOverBookReader(o) { const b = Boolean(o); if (mockVoiceSnap.overBookReader === b) return; mockVoiceSnap.overBookReader = b; pending = true; }, setWsConnected(c) { const b = Boolean(c); if (mockVoiceSnap.wsConnected === b) return; mockVoiceSnap.wsConnected = b; pending = true; },
  setModuleMicState(active, owner = null) { const b = Boolean(active), o = b ? owner : null; if (mockVoiceSnap.moduleMicActive === b && mockVoiceSnap.moduleMicOwner === o) return; mockVoiceSnap.moduleMicActive = b; mockVoiceSnap.moduleMicOwner = o; pending = true; },
  setUiMode: setVoiceUiModeMock, setVoiceStage: setVoiceStageMock, setEntityState(s) { if (mockVoiceSnap.entityState === s) return; mockVoiceSnap.entityState = s; pending = true; },
  setLiveCaption(p) { mockVoiceSnap.liveCaption = { ...mockVoiceSnap.liveCaption, ...p, updatedAt: Date.now() }; pending = true; },
  clearLiveCaption() { if (!mockVoiceSnap.liveCaption.userPartial && !mockVoiceSnap.liveCaption.echoSpoken) return; mockVoiceSnap.liveCaption = { userPartial: '', echoSpoken: '', updatedAt: 0 }; pending = true; },
  setActiveToast(t) { mockVoiceSnap.activeToast = t; pending = true; }, clearActiveToast() { if (!mockVoiceSnap.activeToast) return; mockVoiceSnap.activeToast = null; pending = true; },
  setVoiceError(e) { mockVoiceSnap.lastError = e; pending = true; }, clearVoiceError() { if (!mockVoiceSnap.lastError) return; mockVoiceSnap.lastError = null; pending = true; },
  setActiveConversationId(id) { mockVoiceSnap.activeConversationId = id; }, pushRoute(r) { mockVoiceSnap.routeStack = [...mockVoiceSnap.routeStack, r]; },
  popRoute: () => null, setPendingServerConfirmation(c) { mockVoiceSnap.pendingConfirmation = c; pending = true; },
  setPendingClientConfirmation(c) { mockVoiceSnap.pendingConfirmation = c; pending = true; }, hasActivePendingConfirmation: () => Boolean(mockVoiceSnap.pendingConfirmation),
  consumePendingConfirmation: () => { const c = mockVoiceSnap.pendingConfirmation; mockVoiceSnap.pendingConfirmation = null; return c; },
  clearPendingConfirmation() { mockVoiceSnap.pendingConfirmation = null; pending = true; }, pushUndoAction: () => 'u1', peekUndoActionLabel: () => null,
  popAndRunUndoAction: async () => ({ ok: false }), clearUndoStack() {}, recordAction() {},
  resetOnLogout() { mockVoiceSnap.userId = ''; mockVoiceSnap.voiceStage = false; mockVoiceSnap.entityState = 'disabled'; mockVoiceSnap.handsFreeEnabled = false; mockVoiceSnap.lastError = null; mockVoiceSnap.liveCaption = { userPartial: '', echoSpoken: '', updatedAt: 0 }; pending = true; },
};
let capturedBridge = null, capturedActionHost = null, sleepCalls = 0, dismissErrorCalls = 0, activeVoiceStarts = 0, retryCalls = 0, legacyCaptureCalls = 0;
let nextStartVoiceResult = true;
const mockJarvisRuntime = {
  configure() {}, bindChatBridge: b => { capturedBridge = b; return () => { if (capturedBridge === b) capturedBridge = null; }; },
  setHandsFreeEnabled: async (on, opts) => { mockVoiceStore.setHandsFreeEnabled(on); if (!on && opts?.userInitiated) setVoiceStageMock(false); mockVoiceStore.setEntityState(on ? 'dormant' : 'disabled'); return true; },
  restoreHandsFreeSilently: async () => false,
  startActiveVoiceTurn: async () => { activeVoiceStarts++; if (!nextStartVoiceResult) return false; mockVoiceStore.clearVoiceError(); mockVoiceStore.setEntityState('listening'); return true; },
  retryLastVoiceTurn: async () => { retryCalls++; mockVoiceStore.clearVoiceError(); mockVoiceStore.setEntityState('thinking'); return true; },
  dismissError() { dismissErrorCalls++; mockVoiceStore.clearVoiceError(); if (mockVoiceSnap.entityState === 'error') mockVoiceStore.setEntityState(mockVoiceSnap.handsFreeEnabled ? 'dormant' : 'disabled'); },
  submitTextTurn: async () => {}, setMuted(m) { mockVoiceStore.setMuted(m); },
  interruptCurrentTurn() { mockVoiceStore.setEntityState('listening'); },
  enterSleep() { sleepCalls++; mockVoiceStore.clearVoiceError(); mockVoiceStore.setEntityState(mockVoiceSnap.handsFreeEnabled ? 'dormant' : 'sleeping'); },
  decideConfirmation: async () => {}, undoLastUiAction: async () => false, hardTeardown() { mockVoiceStore.resetOnLogout(); },
};
// Export all 16 `@/lib/echo-jarvis/intents` symbols consumed by CoachWidget + EchoVoice
const mockIntentsBarrel = {
  clearActiveSalientResources() {},
  compileEchoFastPath: () => null,
  detectUtteranceLanguage: () => 'vi',
  dispatchEchoIntent: async () => ({ status: 'done', detail: '' }),
  echoVoiceSessionStore: mockVoiceStore,
  executeIntentDag: async (intents = []) => {
    const steps = [];
    for (const intent of intents) {
      if (intent?.kind === 'navigate' && intent.href && !geometry.isWorkRoute(currentPathname)) {
        capturedActionHost?.routerPush?.(intent.href);
      }
      steps.push({ intent, outcome: { status: 'done', detail: '' } });
    }
    return { status: 'done', steps };
  },
  extractSalientResources: () => [],
  getSessionSalientResources: () => [],
  promoteActiveSalientResourcesToSession() {},
  pushVoiceRouteHistory(r) { mockVoiceStore.pushRoute(r); },
  registerEchoActionHost: host => { capturedActionHost = host; return () => { if (capturedActionHost === host) capturedActionHost = null; }; },
  safeEchoJarvisHref: h => geometry.safeEchoHref(h),
  setPendingServerConfirmation: c => mockVoiceStore.setPendingServerConfirmation(c),
  setSessionSalientResources() {},
  setVoiceStage: setVoiceStageMock,
  setVoiceUiMode: setVoiceUiModeMock,
};
assert.equal(Object.keys(mockIntentsBarrel).length, 16);
const MockEchoOrb = props => React.createElement('div', { 'data-mock-orb': props.slot || 'default', 'data-orb-state': props.state || 'idle' });
const MockCompanionAnchor = ({ vi, isOpen, onTogglePanel, onStartVoice }) => React.createElement('div', { 'data-anchor': '1' },
  React.createElement('button', {
    type: 'button',
    'aria-label': isOpen ? (vi ? 'Ẩn Echo Coach' : 'Collapse Echo Coach') : (vi ? 'Trò chuyện với Echo Coach' : 'Chat with Echo Coach'),
    onClick: onTogglePanel,
  }),
  !isOpen && onStartVoice ? React.createElement('button', {
    type: 'button',
    'aria-label': vi ? 'Nói trực tiếp với Echo' : 'Talk to Echo',
    onClick: onStartVoice,
  }) : null,
);
const { EchoVoice: RealEchoVoice } = evaluate(prefix + 'EchoVoice.tsx', {
  react: hooks,
  './echo-microphone': { END_OF_TURN_MS: 4000, captureEchoSpeech: async () => { legacyCaptureCalls++; return { text: '', reviewNeeded: false }; } },
  './echo-omni-playback': { OMNI_VOICES: ['us_female', 'us_male', 'uk_female', 'uk_male'], EchoOmniPlayback: class { stop() {} enqueue() {} } },
  '@/services/api-client': { getBaseUrl: () => '/api/v1' },
  'lucide-react': new Proxy({}, { get: (_, name) => () => React.createElement('i', { name }) }),
  './EchoOrb': { EchoOrb: MockEchoOrb },
  '@/lib/echo-jarvis/intents': mockIntentsBarrel,
  '@/lib/echo-jarvis/runtime/echoJarvisRuntime': { getEchoJarvisRuntime: () => mockJarvisRuntime },
  './echo-window': geometry,
}, globals);
const { CoachWidget } = evaluate(prefix + 'CoachWidget.tsx', { react: hooks,
  '@/lib/guide/store': { guideBusy: () => false, guideSpeaking: () => false, subscribeGuide: () => () => {} },
  'next-auth/react': { useSession: () => ({ status: 'authenticated', data: { user: { id: currentAccount } } }) },
  'next/navigation': { useRouter: () => ({ push: url => routes.push(url) }), usePathname: () => currentPathname, useSearchParams: () => null }, 'lucide-react': new Proxy({}, { get: (_, name) => () => React.createElement('i', { name }) }),
  '@/services/api-client': { apiClient: sharedClient, getBaseUrl: () => '/api/v1' }, '@/lib/auth-lifecycle': auth, '@/services/echoCoachApi': { echoCoachApi: api },
  '@/lib/api-session': { authFetch: (url, init) => globals.fetch(url, init) },
  '@/context/LanguageContext': { useLanguage: () => ({ locale: 'vi' }) }, './echo-window': geometry, './useEchoWindow': windowHook,
  '@/hooks/usePremiumEntitlement': { usePremiumEntitlement: () => ({ entitlement: premiumMe, isPremium: false, mutateEntitlement: async () => { refreshes++; } }) },
  '@/services/premiumApi': { dailyAllowance: (me, pool) => me?.freeDaily?.find(a => a.pool === pool), ECHO_LIMITS: { free: { perDay: 10, deepPerDay: 1 }, premium: { perDay: 60, perMonth: 500, deepPerDay: 3, deepPerMonth: 40 } } },
  './useEchoDiscovery': discoveryHook, './useEchoCompanion': companionHook, './echo-companion': companionGeometry, '@/lib/brand/echoCharacters': echoCharacters, '@/lib/brand/echoArt': echoArt,
  './EchoMessage': { EchoMessage }, './echo.css': {}, './EchoWorkspaceRail': { EchoWorkspaceRail: () => null }, './EchoOrb': { EchoOrb: MockEchoOrb },
  './EchoCompanionAnchor': { EchoCompanionAnchor: MockCompanionAnchor }, './EchoImmersiveWorkspace': { EchoImmersiveWorkspace: () => null },
  '@/lib/echo-jarvis/intents': mockIntentsBarrel,
  '@/lib/echo-jarvis/runtime/echoJarvisRuntime': { getEchoJarvisRuntime: () => mockJarvisRuntime, getEchoJarvisRuntimeInstance: () => ({ ...mockJarvisRuntime, bindWorkspaceContextProvider: () => () => {} }) },
  '@/lib/echo/contextBridge': { getEchoWorkspaceContextSnapshot: () => null, utteranceReferencesBookOrPassage: () => false, publishEchoWorkspaceContext() {}, clearEchoWorkspaceContext() {}, setOverBookReader() {} },
  './EchoCards': cardsModule, './EchoVoice': { EchoVoice: RealEchoVoice },
  './EchoAssist': { EchoMemoryPanel: () => null, EchoSuggestions: () => null, readProactive: () => false, writeProactive() {} },
  '@/lib/echo/pageContext': { pageContextFor: () => ({ kind: 'MODULE', module: 'grammar' }), recentSelection: () => undefined, clearRecentSelection() {}, watchPageSelection: () => () => {} } }, globals);
function expandComponents(node) {
  if (!node || typeof node !== 'object') return node;
  if (node.type === MockCompanionAnchor) return expandComponents(MockCompanionAnchor(node.props));
  if (node.type === RealEchoVoice) return expandComponents(RealEchoVoice(node.props));
  if (node.type === MockEchoOrb) return expandComponents(MockEchoOrb(node.props));
  if (typeof node.props?.children === 'string' || typeof node.props?.children === 'number') return node;
  const kids = React.Children.toArray(node.props?.children).map(expandComponents);
  return kids.length ? { ...node, props: { ...node.props, children: kids } } : node;
}
function renderOnceFrame0() { cursor = 0; tree = expandComponents(CoachWidget()); return tree; }
function render() { let count = 0; do { pending = false; cursor = 0; tree = expandComponents(CoachWidget()); const list = effects; effects = []; list.forEach(fn => fn()); if (++count > 30) throw Error('render loop'); } while (pending); return tree; }
function nodes(node, type) {
  if (!node || typeof node !== 'object') return [];
  return [...(node.type === type ? [node] : []), ...React.Children.toArray(node.props?.children).flatMap(child => nodes(child, type))];
}
const button = label => nodes(tree, 'button').find(n => n.props['aria-label'] === label);
render(); button('Trò chuyện với Echo Coach').props.onClick(); render(); assert.equal(nodes(tree, 'section').length, 1);
assert.equal(nodes(tree, 'textarea')[0].props.disabled, true);
await new Promise(resolve => setImmediate(resolve)); render();
assert.equal(nodes(tree, 'textarea')[0].props.disabled, false);
button('Mở rộng').props.onClick(); render(); assert.ok(nodes(tree, 'section')[0].props.className.includes('echo-expanded'));
let prevented = false;
const header = nodes(tree, 'header')[0];
header.props.onPointerDown({ button: 0, clientX: 800, clientY: 200, target: { closest: () => null }, currentTarget: { setPointerCapture() {} }, pointerId: 1, preventDefault() { prevented = true; } });
render(); nodes(tree, 'header')[0].props.onPointerMove({ clientX: -5000, clientY: 9000 }); render(); nodes(tree, 'header')[0].props.onPointerUp(); render();
assert.ok(prevented); const style = nodes(tree, 'section')[0].props.style; assert.ok(style.left >= 12 && style.top + style.height <= 888);
button('Đổi kích thước: dùng các phím mũi tên').props.onKeyDown({ key: 'ArrowRight', preventDefault() {} }); render();
button('Ẩn Echo').props.onClick(); render(); button('Trò chuyện với Echo Coach').props.onClick(); render(); assert.ok(nodes(tree, 'section')[0].props.className.includes('echo-expanded'));
nodes(tree, 'textarea')[0].props.onChange({ target: { value: 'about to nghĩa là gì' } }); render();
const sendingA = nodes(tree, 'form')[0].props.onSubmit({ preventDefault() {} });
await new Promise(resolve => setImmediate(resolve)); render(); assert.equal(calls, 1); assert.ok(deliver);
const answerA = deliver; auth.beginLogout(); currentAccount = 'B'; auth.beginAuthenticatedSession(); render();
answerA('PRIVATE_A_CANARY'); await new Promise(resolve => setImmediate(resolve)); render();
assert.ok(!JSON.stringify(tree).includes('PRIVATE_A_CANARY')); assert.equal(saves.length, 0);
assert.ok(!nodes(tree, EchoMessage).some(n => n.props.role === 'user')); assert.equal(nodes(tree, 'textarea')[0].props.value, '');
streamStatus = 401;
nodes(tree, 'textarea')[0].props.onChange({ target: { value: 'What does hello mean?' } }); render();
nodes(tree, 'form')[0].props.onSubmit({ preventDefault() {} });
await new Promise(resolve => setImmediate(resolve)); render();
assert.equal(recoveryCalls, 1); assert.ok(JSON.stringify(tree).includes('AUTH_RECOVERED_REPLY')); assert.equal(saves.length, 1);
// streamed status, server cards and a learner-requested validated navigation: shown, sanitised, navigated once
streamStatus = 200; const routesBefore = routes.length;
extraEvents = 'data: ' + JSON.stringify({ status: 'Echo đang mở lộ trình hôm nay…' }) + '\n\n';
extraAfter = 'data: ' + JSON.stringify({ cards: [{ type: 'tasks', title: 'Lộ trình hôm nay', items: [{ title: 'Ôn 20 thẻ', href: '/flashcards?review=due', status: 'OPEN' }] }] }) + '\n\n'
  + 'data: ' + JSON.stringify({ actions: [{ type: 'navigate', href: '//evil.example', label: 'x', auto: true }, { type: 'navigate', href: '/learning-path?view=list', label: 'Nhiệm vụ hôm nay', auto: true }] }) + '\n\n';
nodes(tree, 'textarea')[0].props.onChange({ target: { value: 'Mở nhiệm vụ hôm nay' } }); render();
nodes(tree, 'form')[0].props.onSubmit({ preventDefault() {} });
await new Promise(resolve => setImmediate(resolve)); render();
deliver('Mình mở lộ trình cho bạn nhé.'); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); render();
const lastEcho = nodes(tree, EchoMessage).at(-1).props;
assert.equal(lastEcho.cards.length, 1); assert.equal(lastEcho.actions.length, 1);
assert.equal(JSON.stringify(routes.slice(routesBefore)), JSON.stringify(['/learning-path?view=list']), 'only the validated destination opens, once');
extraEvents = ''; extraAfter = '';
// A partial reply is visible before completion. Stopping discards any later cards and history write.
const originalFetch = globals.fetch;
let releaseLate;
globals.fetch = async (url, init) => {
  if (init.method === 'DELETE') return {ok:true,status:204};
  let first=true;
  return {ok:true,status:200,body:{getReader:()=>({releaseLock(){},cancel:async()=>{},read:async()=>{
    if(first) { first=false; return {value:new TextEncoder().encode('data: {"token":"VI_DRAFT"}\n\n'),done:false}; }
    return new Promise(resolve=>{releaseLate=resolve});
  }})}};
};
const beforeStop = [saves.length,routes.length];
nodes(tree,'textarea')[0].props.onChange({target:{value:'Explain a long sentence.'}}); render();
nodes(tree,'form')[0].props.onSubmit({preventDefault(){}});
await new Promise(resolve=>setImmediate(resolve)); render();
assert.ok(JSON.stringify(tree).includes('VI_DRAFT'));
button('Dừng trả lời').props.onClick(); render();
releaseLate({value:new TextEncoder().encode('data: {"actions":[]}\n\ndata: {"done":true}\n\n'),done:false});
await new Promise(resolve=>setImmediate(resolve)); render();
assert.ok(!JSON.stringify(tree).includes('VI_DRAFT'));
assert.deepEqual([saves.length,routes.length],beforeStop);
globals.fetch=originalFetch;
streamStatus = 503;
nodes(tree, 'textarea')[0].props.onChange({ target: { value: 'What does goodbye mean?' } }); render();
nodes(tree, 'form')[0].props.onSubmit({ preventDefault() {} });
await new Promise(resolve => setImmediate(resolve)); render();
assert.equal(recoveryCalls, 1, 'provider/transport failures must never replay inference');
// free daily allowance: the counter is the server's, the 11th message is refused by the server and the send stays off
premiumMe = { freeDaily: [{ pool: 'COACH', limit: 10, used: 7, remaining: 3, resetsAt: '2026-10-18T17:00:00Z' }] }; render();
assert.ok(JSON.stringify(tree).includes('Echo Coach · 7/10 tin nhắn hôm nay'));
streamStatus = 429; dailyHeader = true;
nodes(tree, 'textarea')[0].props.onChange({ target: { value: 'One more question?' } }); render();
nodes(tree, 'form')[0].props.onSubmit({ preventDefault() {} });
await new Promise(resolve => setImmediate(resolve)); render();
assert.ok(JSON.stringify(tree).includes('Bạn đã dùng hết 10 tin nhắn miễn phí hôm nay'), 'daily limit is explained');
assert.ok(!JSON.stringify(tree).includes('Mình cần nghỉ một chút'), 'daily limit is not the per-minute throttle');
assert.ok(refreshes >= 1, 'the counter is re-read from the server');
assert.equal(nodes(tree, 'button').find(n => n.props['aria-label'] === 'Gửi tin nhắn').props.disabled, true);
const callsBefore = calls; nodes(tree, 'form')[0].props.onSubmit({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve));
assert.equal(calls, callsBefore, 'no request once the day is used up');
assert.ok(nodes(tree, EchoMessage).length > 0, 'earlier messages stay readable');
// ── Phase 2A Voice Stage Presentation, Barge-In Truncation, Exhausted Stage Retention & Logout Wipe ──
auth.beginLogout(); mockVoiceStore.resetOnLogout(); currentAccount = 'C'; premiumMe = undefined; streamStatus = 200; dailyHeader = false; auth.beginAuthenticatedSession(); render();
await new Promise(resolve => setImmediate(resolve)); render();
// Open History first, then collapse so we prove `openVoice()` clears `historyOpen` and paints `.echo-voice-stage` on Frame 0!
button('Tùy chọn Echo').props.onClick(); render();
nodes(tree, 'button').find(n => JSON.stringify(n.props.children).includes('Lịch sử trò chuyện')).props.onClick(); render();
assert.ok(nodes(tree, 'div').some(n => n.props.className === 'echo-history'));
button('Ẩn Echo').props.onClick(); render();
assert.equal(nodes(tree, 'section').filter(n => !n.props.className.includes('echo-closing')).length, 0);
// Click Companion Mic from closed widget -> single synchronous Frame-0 render MUST already have `data-voice-stage="true"` and `.echo-voice-stage`!
button('Nói trực tiếp với Echo').props.onClick();
renderOnceFrame0();
const frame0Panel = nodes(tree, 'section')[0];
assert.equal(frame0Panel.props['data-voice-stage'], 'true', 'Frame 0 panel is marked data-voice-stage');
assert.equal(nodes(tree, 'div').filter(n => n.props.className === 'echo-voice-stage').length, 1, 'framesWithPanelButNoStage === 0 on Frame 0');
assert.equal(nodes(tree, 'div').find(n => n.props.className === 'echo-conversation').props.hidden, true, 'chat log hidden on Frame 0');
assert.equal(nodes(tree, 'form')[0].props.hidden, true, 'text composer form hidden on Frame 0');
assert.equal(nodes(tree, 'div').filter(n => n.props['data-mock-orb'] === 'welcome').length, 0, 'zero duplicate welcome EchoOrb while voiceStageActive');
assert.equal(nodes(tree, 'div').filter(n => n.props['data-mock-orb'] === 'voice').length, 1, 'voice stage EchoOrb mounted');
await new Promise(resolve => setImmediate(resolve)); render();
// Spoken "Expand Echo" (`onVoiceUiCommand('expand')`) expands without leaving voiceStage or calling enterSleep
const sleepsBeforeExpand = sleepCalls;
button('Thu gọn')?.props.onClick?.(); render();
capturedActionHost.onVoiceUiCommand('expand'); render();
assert.ok(nodes(tree, 'section')[0].props.className.includes('echo-expanded'));
assert.equal(mockVoiceSnap.voiceStage, true, 'voice expand preserves voiceStage');
assert.equal(sleepCalls, sleepsBeforeExpand, 'voice expand never calls enterSleep');
// Executing caption priority & <= 170 char clamp
mockVoiceStore.setEntityState('executing');
mockVoiceStore.setLiveCaption({ userPartial: 'short user text', echoSpoken: 'word '.repeat(60).trim() });
render();
const execCaption = nodes(tree, 'p').find(n => n.props.className === 'echo-voice-caption').props.children;
assert.ok(execCaption.startsWith('…') && execCaption.length <= 171, 'executing prefers echoSpoken and clamps <= 170 chars');
// Recoverable error + Retry in-place + no legacy getUserMedia fallback when runtime returns false
mockVoiceStore.setEntityState('error');
mockVoiceStore.setVoiceError({ id: 'e1', kind: 'service_busy', title: 'Echo đang bận đôi chút, bạn thử hỏi lại ngay nhé', canRetry: true, occurredAt: Date.now() });
render();
assert.equal(nodes(tree, 'div').filter(n => n.props.className === 'echo-voice-stage').length, 1, 'error stays inside voice stage');
const errAlert = nodes(tree, 'div').find(n => n.props.className === 'echo-voice-error');
assert.ok(errAlert, 'inline voice error rendered');
nodes(errAlert, 'button')[0].props.onClick(); await new Promise(resolve => setImmediate(resolve)); render();
assert.equal(retryCalls, 1, 'Retry triggers runtime retryLastVoiceTurn in-place');
mockVoiceStore.setEntityState('dormant'); render();
nextStartVoiceResult = false;
button('Nói với Echo').props.onClick(); await new Promise(resolve => setImmediate(resolve)); render();
assert.equal(legacyCaptureCalls, 0, 'false return from startActiveVoiceTurn never falls through to legacy getUserMedia');
nextStartVoiceResult = true;
// Module-mic arbitration hint & disabled controls
mockVoiceStore.setModuleMicState(true, 'speaking'); render();
assert.ok(JSON.stringify(tree).includes('Đang nhường micro cho bài luyện'));
assert.equal(button('Nói với Echo').props.disabled, true, 'resting mic disabled during moduleMicActive');
mockVoiceStore.setModuleMicState(false, null); render();
// Daily quota exhaustion mid-session (`V-EXHAUSTED-UNMOUNT`) keeps `.echo-voice-stage` mounted with disabled talk button!
premiumMe = { freeDaily: [{ pool: 'COACH', limit: 10, used: 10, remaining: 0, resetsAt: '2026-11-26T17:00:00Z' }] };
render();
assert.equal(nodes(tree, 'div').filter(n => n.props.className === 'echo-voice-stage').length, 1, 'exhausting quota mid-session never unmounts voice stage');
assert.equal(button('Nói với Echo').props.disabled, true, 'resting mic disabled when daily quota exhausted');
assert.ok(JSON.stringify(tree).includes('lượt trò chuyện hôm nay'), 'localized quota notice shown inside voice stage');
premiumMe = undefined; render();
// Barge-in `onTruncateTurn` shared contract: updates already-appended assistant turn in-place & drops 0-word unheard turns
assert.equal(typeof capturedBridge?.onTruncateTurn, 'function');
capturedBridge.onAppendTurn('Explain conditionals', 'Zero conditional. First conditional. Second conditional.');
render();
assert.equal(capturedBridge.getHistory().at(-1).content, 'Zero conditional. First conditional. Second conditional.');
capturedBridge.onTruncateTurn('Explain conditionals', 'Zero conditional.', { turnSeq: 4 });
render();
assert.equal(capturedBridge.getHistory().at(-1).content, 'Zero conditional.', 'getHistory immediately reflects heard-only truncated text');
assert.equal(nodes(tree, EchoMessage).at(-1).props.content, 'Zero conditional.', 'EchoMessage updated in-place on barge-in truncate');
const histLenBeforeZeroHeard = capturedBridge.getHistory().length;
capturedBridge.onAppendTurn('Unheard turn', 'Completely unheard sentence one. Sentence two.');
capturedBridge.onTruncateTurn('Unheard turn', '', { turnSeq: 5 });
render();
assert.equal(capturedBridge.getHistory().length, histLenBeforeZeroHeard, '0-word barge-in removes unheard turn from history');
assert.ok(!JSON.stringify(tree).includes('Completely unheard sentence one'));
// Explicit reopen into Chat clears active non-dormant voice + error even if `voiceStage` was false (started from Ambient)
button('Ẩn Echo').props.onClick(); render();
setVoiceStageMock(false); mockVoiceStore.setEntityState('listening');
mockVoiceStore.setVoiceError({ id: 'e2', kind: 'service_busy', title: 'Echo đang bận', canRetry: true, occurredAt: Date.now() });
render();
const sleepsBeforeChatOpen = sleepCalls, dismissBeforeChatOpen = dismissErrorCalls;
button('Trò chuyện với Echo Coach').props.onClick(); render();
assert.equal(mockVoiceSnap.voiceStage, false);
assert.ok(sleepCalls > sleepsBeforeChatOpen && dismissErrorCalls > dismissBeforeChatOpen, 'explicit Chat open sleeps active ambient voice and clears error');
assert.equal(nodes(tree, 'div').filter(n => n.props.className === 'echo-voice-stage').length, 0, 'explicit Chat open shows Chat, not Voice');
// Explicit `echo:ask` exits voiceStage and reveals prefilled text composer
button('Trò chuyện trực tiếp với Echo').props.onClick(); render();
assert.equal(mockVoiceSnap.voiceStage, true);
win.dispatchEvent(new CustomEventMock('echo:ask', { detail: { text: 'Giải thích từ resilient' } })); render();
assert.equal(mockVoiceSnap.voiceStage, false, 'echo:ask exits voiceStage');
assert.equal(nodes(tree, 'textarea')[0].props.value, 'Giải thích từ resilient');
assert.equal(nodes(tree, 'form')[0].props.hidden, undefined);
// Entering `isGarden` suspended route exits voiceStage cleanly; companion surface exposes restoreMascot
button('Trò chuyện trực tiếp với Echo').props.onClick(); render();
assert.equal(mockVoiceSnap.voiceStage, true);
currentPathname = '/study-space'; render();
assert.equal(mockVoiceSnap.voiceStage, false, 'entering 3D StudySpace exits voiceStage');
currentPathname = '/grammar'; render();
companionHook.useEchoCompanion().restoreMascot();
assert.equal(mascotRestores, 1, 'restoreMascot hook surface wired');
// Logout / account switch wipes `voiceStage` and conversation state (`0` cross-user inheritance)
button('Trò chuyện trực tiếp với Echo').props.onClick(); render();
assert.equal(mockVoiceSnap.voiceStage, true);
auth.beginLogout(); mockVoiceStore.resetOnLogout(); currentAccount = 'D'; auth.beginAuthenticatedSession(); render();
assert.equal(mockVoiceSnap.voiceStage, false, 'logout resets voiceStage');
assert.ok(!JSON.stringify(tree).includes('Zero conditional.'), 'User D never inherits User C voice transcript');
assert.ok(!read(prefix + 'echo.css').includes('backdrop-filter'), 'zero backdrop-filter in echo.css');
win.innerWidth = 390; win.innerHeight = 844;
assert.ok(read(prefix + 'echo.css').includes('@media (max-width: 639px)') && read(prefix + 'echo.css').includes('prefers-reduced-motion'));
assert.ok(read('app/providers.tsx').includes('<CoachWidget />') && !read('components/layout/WorkspaceTabs.tsx').includes('<CoachWidget />'));
for (const layout of ['app/listening/layout.tsx', 'app/speaking/layout.tsx']) {
  assert.ok(!read(layout).includes('CoachWidget'), `${layout} must use the global Echo instance`);
}
assert.ok(!read(prefix + 'CoachWidget.tsx').includes('7-Day DNA Active'));
console.log('Echo behavior PASS: geometry recovery/clamp, modes, drag/keyboard resize, strict React XSS rendering, action allowlist, deferred A response isolation, account input reset, single route-persistent instance, mobile/reduced-motion contracts.');
