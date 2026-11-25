// Workstream B3 Comprehensive Verification Suite:
// Speech-Act Classification, Quote-Masking Safety, <0.5ms Concept-Slot Fast-Path Parity,
// Salience Anaphora, Natural Confirmation Vocabulary, Verified Action Lifecycle,
// waitForTargetUrl Post-Condition Honesty, WS action.ack, Cross-Modal Continuity, and BUG-01..BUG-07.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..', 'src');
const readSrc = (rel) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

const storageMap = new Map();
const sessionStorageMap = new Map();
const dispatchedEvents = [];
const windowListeners = new Map();
const cleanupCallbacks = [];
let currentPathname = '/dashboard';
let currentSearch = '';
let blockPushState = false;

class CustomEventPolyfill {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

class EventPolyfill {
  constructor(type) {
    this.type = type;
  }
}

const localStorageMock = {
  getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
  setItem: (k, v) => storageMap.set(k, String(v)),
  removeItem: (k) => storageMap.delete(k),
  clear: () => storageMap.clear(),
};

const sessionStorageMock = {
  get length() {
    return sessionStorageMap.size;
  },
  key: (i) => Array.from(sessionStorageMap.keys())[i] ?? null,
  getItem: (k) => (sessionStorageMap.has(k) ? sessionStorageMap.get(k) : null),
  setItem: (k, v) => sessionStorageMap.set(k, String(v)),
  removeItem: (k) => sessionStorageMap.delete(k),
  clear: () => sessionStorageMap.clear(),
};

const windowMock = {
  get location() {
    return {
      pathname: currentPathname,
      search: currentSearch,
      protocol: 'https:',
      host: 'englishcoach.io.vn',
      hostname: 'englishcoach.io.vn',
      href: `https://englishcoach.io.vn${currentPathname}${currentSearch}`,
    };
  },
  localStorage: localStorageMock,
  sessionStorage: sessionStorageMock,
  history: {
    pushState: (_state, _title, url) => {
      if (blockPushState) return;
      const [p, q] = String(url).split('?');
      currentPathname = p || '/';
      currentSearch = q ? `?${q}` : '';
    },
    back: () => {},
    forward: () => {},
  },
  matchMedia: () => ({ matches: false }),
  addEventListener: (type, fn) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(fn);
  },
  removeEventListener: (type, fn) => {
    windowListeners.get(type)?.delete(fn);
  },
  dispatchEvent: (event) => {
    dispatchedEvents.push({ type: event.type, detail: event.detail });
    const set = windowListeners.get(event.type);
    if (set) {
      for (const fn of set) fn(event);
    }
    return true;
  },
};

const documentMock = {
  documentElement: {
    lang: 'vi',
    style: { setProperty: () => {}, getPropertyValue: () => '' },
    setAttribute: () => {},
    removeAttribute: () => {},
    getAttribute: () => null,
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
  },
  querySelector: () => null,
  scrollingElement: null,
};

let openedStudios = [];
const stubs = {
  '@/services/api-client': { apiClient: { post: async () => ({ data: {} }) }, getBaseUrl: () => '/api/v1' },
  '@/lib/api-session': {
    authFetch: async () => ({ ok: true, json: async () => ({}) }),
    ensureApiSession: async () => true,
    refreshApiSession: async () => true,
    csrfHeaders: () => ({}),
  },
  '@/lib/auth-cache-cleanup': {
    registerUserScopedCleanup: (fn) => {
      cleanupCallbacks.push(fn);
      return () => {};
    },
  },
  '@/lib/auth-lifecycle': {
    authEnding: () => false,
    authEpoch: () => 1,
    onAuthWorkCancelled: () => () => {},
    subscribeAuthLifecycle: () => () => {},
  },
  '@/lib/appearance/scope': {
    applyAppearanceTheme: () => {},
    readAppearanceTheme: () => 'light',
  },
  '@/lib/appearance/state': {
    restoreDefaultAppearance: () => {},
  },
  '@/lib/background-studio/colorScience': {
    cloneThemeConfig: (c) => structuredClone(c),
  },
  '@/lib/background-studio/presets': {
    DEFAULT_BACKGROUND_PRESET_ID: 'pearlescent-abyss',
    findBackgroundPreset: (id) => ({ id, config: { color: { brightness: 100 }, motion: { effects: [] } } }),
  },
  '@/lib/background-studio/store': {
    applyPresetBackground: () => true,
    applyCustomBackground: () => true,
    resolveActiveBgConfig: () => null,
  },
  '@/lib/background-studio/types': {
    BG_BOUNDS: { brightness: { min: 50, max: 150 } },
  },
  '@/lib/guide/store': { openGuidePanel: () => {} },
  '@/lib/navigation/preferences': {
    navStorageKey: (u) => `nav:${u}`,
    setNavigationLayout: () => {},
    setNavigationVisibility: () => {},
  },
  '@/lib/ui/worldDisplay': { setWorldDisplay: () => {} },
  '@/lib/wallpaper/storage': {
    openWallpaperStudio: (room) => openedStudios.push(room ?? 'default'),
  },
  '@/services/echoIntelligenceApi': {
    echoIntelligenceApi: { decide: async () => ({ status: 'APPLIED' }) },
  },
  '@/services/logout': { logout: async () => {} },
  '@/components/features/reading/books/store/bookStore': {
    BookStore: { open: async () => ({ listBooks: async () => [], close: () => {} }) },
  },
};

const moduleCache = new Map();
function loadTsModule(relFromSrc) {
  const normalized = relFromSrc.replace(/\\/g, '/');
  if (moduleCache.has(normalized)) return moduleCache.get(normalized);
  const exportsObj = {};
  moduleCache.set(normalized, exportsObj);

  const rawCode = readSrc(normalized);
  const transformed = babel.core().transformSync(rawCode, {
    filename: path.basename(normalized),
    configFile: false,
    babelrc: false,
    presets: [babel.presetTypescript()],
    plugins: [babel.pluginTransformModulesCommonjs()],
  }).code;

  const customRequire = (spec) => {
    if (spec in stubs) return stubs[spec];
    if (spec.startsWith('@/')) {
      const base = spec.slice(2);
      const tryIndex = `${base}/index.ts`;
      const tryTs = `${base}.ts`;
      if (fs.existsSync(path.join(srcRoot, tryTs))) return loadTsModule(tryTs);
      if (fs.existsSync(path.join(srcRoot, tryIndex))) return loadTsModule(tryIndex);
      return loadTsModule(tryTs);
    }
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const joined = path.posix.join(path.posix.dirname(normalized), spec);
      if (joined.endsWith('.ts')) return loadTsModule(joined);
      if (fs.existsSync(path.join(srcRoot, `${joined}.ts`))) return loadTsModule(`${joined}.ts`);
      if (fs.existsSync(path.join(srcRoot, `${joined}/index.ts`))) return loadTsModule(`${joined}/index.ts`);
      return loadTsModule(`${joined}.ts`);
    }
    return require(spec);
  };

  runInNewContext(transformed, {
    exports: exportsObj,
    module: { exports: exportsObj },
    require: customRequire,
    window: windowMock,
    document: documentMock,
    localStorage: localStorageMock,
    sessionStorage: sessionStorageMock,
    CustomEvent: CustomEventPolyfill,
    Event: EventPolyfill,
    WebSocket: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    URLSearchParams,
    AbortSignal,
    AbortController,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    structuredClone,
    console,
    Math,
    Date,
    Object,
    Array,
    Set,
    Map,
    RegExp,
    Number,
    String,
    Boolean,
    Promise,
    Error,
    Uint8Array,
    Int16Array,
    Float32Array,
    ArrayBuffer,
    DataView,
    Buffer,
    TextDecoder,
  });

  return exportsObj;
}

const intents = loadTsModule('lib/echo-jarvis/intents/index.ts');
const pageCtxMod = loadTsModule('lib/echo/pageContext.ts');
const runtimeMod = loadTsModule('lib/echo-jarvis/runtime/echoJarvisRuntime.ts');
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

await check('1. Quote-Masking Safety (__quoted__) preserves contractions and prevents Open "anything" reading collapse', () => {
  const masked = intents.maskQuotedSpans('Open "anything" reading');
  assert.equal(masked.masked, 'Open __quoted__ reading');
  assert.equal(intents.stripUntrustedQuotes("Open 'anything' reading"), 'Open __quoted__ reading');
  assert.equal(intents.compileFastPathUtterance('Open "anything" reading', { pathname: '/dashboard' }), null);
  assert.equal(intents.compileFastPathUtterance("Open 'anything' reading", { pathname: '/dashboard' }), null);

  // Contractions preserved 100%
  for (const contractionSample of [
    "I'd like to open speaking",
    "Let's open speaking",
    "Open today's tasks",
    "Don't delete my account",
    "What's the meaning of resilient?",
  ]) {
    const res = intents.maskQuotedSpans(contractionSample);
    assert.equal(res.hadQuotes, false, `contraction must not be masked as quote: ${contractionSample}`);
  }
  const tasksMatch = intents.compileFastPathUtterance("Open today's tasks", { pathname: '/dashboard' });
  assert.equal(tasksMatch?.intents[0]?.href, '/learning-path?view=list');
  const idLikeMatch = intents.compileFastPathUtterance("I'd like to open speaking", { pathname: '/dashboard' });
  assert.equal(idLikeMatch?.intents[0]?.href, '/speaking');

  // Legitimate quoted headword dictionary lookup still works
  const dict = intents.compileFastPathUtterance('Look up "break the ice"', { pathname: '/reading' });
  assert.deepEqual(plain(dict?.intents), [{ kind: 'dictionary_lookup', word: 'break the ice' }]);
});

await check('2. Speech-Act Analyzer: Metalinguistic, Hypothetical, Negated/Deferred, Repair, Polite ?, and True Info Questions', () => {
  // Metalinguistic mentions -> Plane B (null fastPath, null guard)
  for (const meta of [
    'What does "open reading" mean?',
    'Translate "delete my account" into Vietnamese',
    '"Open reading" nghĩa là gì?',
    'How do you pronounce "ubiquitous"?',
    'Open reading nghĩa là gì?',
    'Dịch cụm từ break the ice sang tiếng Việt',
  ]) {
    const sa = intents.analyzeSpeechAct(meta);
    assert.equal(sa.kind, 'METALINGUISTIC_MENTION', `expected METALINGUISTIC_MENTION for: ${meta}`);
    const out = intents.evaluateAndCompileUtterance(meta, { pathname: '/dashboard' });
    assert.equal(out.guard, null, `expected null guard for metalinguistic: ${meta}`);
    assert.equal(out.fastPath, null, `expected null fastPath for metalinguistic: ${meta}`);
  }

  // Hypothetical conditions -> Plane B (null fastPath, null guard!)
  for (const hyp of [
    'If I delete my account, what happens?',
    'What happens if I sign out right now?',
    'Suppose I open Reading, would I lose my draft?',
    'Nếu mình xóa tài khoản thì sao?',
    'Giả sử tôi bấm đăng xuất thì chuyện gì xảy ra?',
  ]) {
    const sa = intents.analyzeSpeechAct(hyp);
    assert.equal(sa.kind, 'HYPOTHETICAL_CONDITION', `expected HYPOTHETICAL_CONDITION for: ${hyp}`);
    const out = intents.evaluateAndCompileUtterance(hyp, { pathname: '/profile' });
    assert.equal(out.guard, null, `expected null guard for hypothetical: ${hyp}`);
    assert.equal(out.fastPath, null, `expected null fastPath for hypothetical: ${hyp}`);
  }

  // Negated or deferred -> Plane B (null fastPath, null guard!)
  for (const neg of [
    "Don't delete my account",
    'Do not open reading right now',
    'Hold off on signing out',
    'Open speaking? Not right now.',
    'Đừng mở phần đọc vội',
    'Khoan mở phần nói đã',
    'Chưa muốn chuyển qua phần nghe',
    'Không cần mở phần đọc đâu',
  ]) {
    const sa = intents.analyzeSpeechAct(neg);
    assert.equal(sa.kind, 'NEGATED_OR_DEFERRED', `expected NEGATED_OR_DEFERRED for: ${neg}`);
    const out = intents.evaluateAndCompileUtterance(neg, { pathname: '/dashboard' });
    assert.equal(out.guard, null, `expected null guard for negated: ${neg}`);
    assert.equal(out.fastPath, null, `expected null fastPath for negated: ${neg}`);
  }

  // Positive UI toggles MUST NOT be misclassified as negated!
  const positiveToggles = [
    ['turn off dark mode', 'theme_mode'],
    ['disable hands-free', 'voice_control'],
    ['hide navigation', 'nav_visibility'],
    ['tắt chế độ tối', 'theme_mode'],
    ['tắt nhạc', 'music_control'],
    ['tạm dừng nhạc', 'music_control'],
    ['ẩn thanh điều hướng', 'nav_visibility'],
  ];
  for (const [phrase, expectedKind] of positiveToggles) {
    const m = intents.compileFastPathUtterance(phrase, { pathname: '/dashboard' });
    assert.ok(m, `positive UI toggle must compile: ${phrase}`);
    assert.equal(m.intents[0].kind, expectedKind, `expected ${expectedKind} for: ${phrase}`);
  }

  // Intra-utterance & leading/trailing Repair Directives
  const repairs = [
    ['open reading, wait no, open listening', '/listening'],
    ['open reading — actually open listening instead', '/listening'],
    ['mở đọc, à nhầm mở nghe đi', '/listening'],
    ['thôi mở phần nghe đi', '/listening'],
    ['Actually, open Listening instead', '/listening'],
    ['Instead, take me to Speaking', '/speaking'],
    ['À không, chuyển qua Nghe đi', '/listening'],
    ['Thay vào đó mở phần Nghe giúp mình', '/listening'],
  ];
  for (const [phrase, expectedHref] of repairs) {
    const m = intents.compileFastPathUtterance(phrase, { pathname: '/dashboard' });
    assert.ok(m, `repair directive must compile: ${phrase}`);
    assert.equal(m.intents[0].href, expectedHref, `repair target mismatch for: ${phrase}`);
  }

  // Polite `?` requests compile, while True Info `?` questions delegate to Plane B
  const politeQuestions = [
    ['Could you open the speaking module?', '/speaking'],
    ['Can you take me to Reading, please?', '/reading'],
    ['May I open Flashcards?', '/flashcards'],
    ['Mở phần luyện nói giúp mình được không?', '/speaking'],
    ['Chuyển qua phần Nghe nhé?', '/listening'],
  ];
  for (const [q, href] of politeQuestions) {
    const m = intents.compileFastPathUtterance(q, { pathname: '/dashboard' });
    assert.ok(m, `polite question must compile: ${q}`);
    assert.equal(m.intents[0].href, href);
  }

  for (const infoQ of [
    'What is shadowing?',
    'Why is my speaking score not improving?',
    'Điểm nói của mình có cải thiện không?',
    'Giải thích thì hiện tại hoàn thành như thế nào?',
    'Open Reading?', // unframed bare question mark -> Plane B
  ]) {
    assert.equal(intents.compileFastPathUtterance(infoQ, { pathname: '/dashboard' }), null, `info question must delegate: ${infoQ}`);
  }
});

await check('3. Concept-Slot Navigation: all 9 user-reported phrases compile in < 0.5 ms + sub-destinations + mixed-intent delegation', () => {
  const nineReportedPhrases = [
    ['open reading', '/reading'],
    ['open speaking', '/speaking'],
    ['open speaking module', '/speaking'],
    ['open speaking module in my website', '/speaking'],
    ['take me to the speaking section', '/speaking'],
    ['I want to open the speaking practice area', '/speaking'],
    ['mở phần luyện nói cho tôi', '/speaking'],
    ['chuyển qua Speaking giúp tôi', '/speaking'],
    ['cho tôi vào phần luyện nói', '/speaking'],
  ];

  // Warm V8 JIT once, then measure deterministic per-utterance latency (< 0.5 ms)
  intents.compileFastPathUtterance('open speaking', { pathname: '/dashboard' });

  for (const [phrase, expectedHref] of nineReportedPhrases) {
    const t0 = performance.now();
    const res = intents.compileFastPathUtterance(phrase, { pathname: '/dashboard' });
    const dt = performance.now() - t0;
    assert.ok(res, `expected Plane-A match for user phrase: "${phrase}"`);
    assert.equal(res.intents[0]?.kind, 'navigate');
    assert.equal(res.intents[0]?.href, expectedHref, `href mismatch for "${phrase}"`);
    assert.ok(dt < 0.5, `expected < 0.5 ms for "${phrase}", got ${dt.toFixed(3)} ms`);
  }

  // Relative paraphrases & specific sub-destinations (never over-peeled!)
  const extraConceptCases = [
    ['open the section where I can practice speaking', '/speaking'],
    ['mở chỗ để mình luyện nghe', '/listening'],
    ['open speaking profile in my website', '/speaking?view=profile'],
    ['open pronunciation analytics', '/speaking?view=profile&sub=pronunciation'],
    ['open grammar practice', '/grammar/practice'],
    ['open study space', '/study-space'],
    ['open sentence lab', '/writing?w=sentence-lab'],
  ];
  for (const [phrase, expectedHref] of extraConceptCases) {
    const res = intents.compileFastPathUtterance(phrase, { pathname: '/dashboard' });
    assert.equal(res?.intents[0]?.href, expectedHref, `sub-destination mismatch for "${phrase}"`);
  }

  // Appearance Studio 'worlds' and 'navigation' rooms
  const worldsStudio = intents.compileFastPathUtterance('open worlds settings', { pathname: '/dashboard' });
  assert.deepEqual(plain(worldsStudio?.intents), [{ kind: 'open_appearance_studio', room: 'worlds' }]);
  const navStudio = intents.compileFastPathUtterance('open navigation settings', { pathname: '/dashboard' });
  assert.deepEqual(plain(navStudio?.intents), [{ kind: 'open_appearance_studio', room: 'navigation' }]);

  // Mixed-intent utterances MUST delegate 100% to Plane B (null)
  assert.equal(
    intents.compileFastPathUtterance('Explain what shadowing is, and open the Speaking module', { pathname: '/dashboard' }),
    null,
  );
  assert.equal(
    intents.compileFastPathUtterance('Open the Speaking module, and explain what shadowing is', { pathname: '/dashboard' }),
    null,
  );
});

await check('4. Confirmation Voice/Text Vocabulary & "không hủy" inversion fix', () => {
  const bareConfirms = [
    'yes', 'yep', 'yeah', 'sure', 'ok', 'okay', 'confirm', 'go ahead', 'do it',
    'dong y', 'xac nhan', 'ok luon', 'duoc', 'u', 'vang', 'đúng',
  ];
  for (const word of bareConfirms) {
    assert.equal(intents.compileFastPathUtterance(word, { hasPendingConfirmation: false }), null, `no pending -> null: ${word}`);
    const m = intents.compileFastPathUtterance(word, { hasPendingConfirmation: true });
    assert.deepEqual(plain(m?.intents), [{ kind: 'voice_confirm', decision: 'confirm' }], `confirm failed for: ${word}`);
  }

  const bareCancels = [
    'no', 'nope', 'cancel', 'stop', "don't", 'do not', 'never mind', 'stay here',
    'khong', 'đừng', 'dung', 'huy', 'thoi', 'khoan', 'o lai',
  ];
  for (const word of bareCancels) {
    const m = intents.compileFastPathUtterance(word, { hasPendingConfirmation: true });
    assert.deepEqual(plain(m?.intents), [{ kind: 'voice_confirm', decision: 'cancel' }], `cancel failed for: ${word}`);
  }

  // "không hủy" MUST NEVER trigger cancel!
  assert.equal(intents.matchPendingConfirmationDecision('không hủy'), null);
  assert.equal(intents.matchPendingConfirmationDecision('khong huy'), null);
  assert.equal(intents.compileFastPathUtterance('không hủy', { hasPendingConfirmation: true }), null);
});

await check('5. Salience & Anaphora Tracker: singular, ordinal (1..3, last), sessionStorage continuity, and history_back', () => {
  intents.setVoiceSessionUser('501');
  intents.clearAllSalientResources();

  const extracted = intents.extractSalientResources(
    [
      {
        type: 'resources',
        items: [
          { title: 'IELTS Urban Trees', href: '/reading?materialId=101', meta: 'reading' },
          { title: 'Malicious Phish', href: 'https://evil.example.com/steal', meta: 'reading' },
          { title: 'Ocean Currents Dictation', href: '/listening/202/practice', meta: 'listening' },
          { title: 'Job Interview Roleplay', href: '/speaking/roleplay/303', meta: 'speaking' },
        ],
      },
    ],
    [],
  );
  assert.equal(extracted.length, 3, 'external URL rejected, 3 valid items indexed 1..3');
  assert.deepEqual(plain(extracted.map((x) => x.index)), [1, 2, 3]);

  // Single-item salience resolves "open it" / "mở bài đó"
  const singleSalience = [extracted[0]];
  assert.equal(
    intents.compileFastPathUtterance('open that one', { salientResources: singleSalience })?.intents[0]?.href,
    '/reading?materialId=101',
  );
  assert.equal(
    intents.compileFastPathUtterance('mở bài đó', { salientResources: singleSalience })?.intents[0]?.href,
    '/reading?materialId=101',
  );

  // Multi-item salience: bare "open it" is ambiguous -> null, while ordinals resolve exact index!
  intents.setSessionSalientResources(extracted, 777, '501');
  const persisted = intents.getSessionSalientResources(777, '501');
  assert.equal(persisted.length, 3);
  assert.equal(intents.compileFastPathUtterance('open it', { sessionId: 777 }), null);
  assert.equal(
    intents.compileFastPathUtterance('open the first one', { sessionId: 777 })?.intents[0]?.href,
    '/reading?materialId=101',
  );
  assert.equal(
    intents.compileFastPathUtterance('open the second one', { sessionId: 777 })?.intents[0]?.href,
    '/listening/202/practice',
  );
  assert.equal(
    intents.compileFastPathUtterance('mở gợi ý số 2', { sessionId: 777 })?.intents[0]?.href,
    '/listening/202/practice',
  );
  assert.equal(
    intents.compileFastPathUtterance('mở cái cuối', { sessionId: 777 })?.intents[0]?.href,
    '/speaking/roleplay/303',
  );

  // Anaphoric back navigation
  for (const backPhrase of [
    'take me back',
    'take me back there',
    'go back to the previous page',
    'quay lại trang trước',
    'quay về chỗ cũ',
  ]) {
    const m = intents.compileFastPathUtterance(backPhrase, { pathname: '/reading' });
    assert.deepEqual(plain(m?.intents), [{ kind: 'history_back' }], `back failed for: ${backPhrase}`);
  }

  // Logout wipes salience immediately
  for (const fn of cleanupCallbacks) fn();
  assert.equal(intents.getSessionSalientResources(777, '501').length, 0);
});

await check('6. Verified Action Lifecycle, waitForTargetUrl failure honesty, Empty Undo, WS action.ack, and BUG-01..BUG-07', async () => {
  intents.setVoiceSessionUser('601');
  intents.clearUndoStack();
  currentPathname = '/dashboard';
  currentSearch = '';
  blockPushState = false;

  // Empty Undo stack returns honest status: 'failed' + localized message
  const emptyUndo = await intents.dispatchEchoIntent({ kind: 'undo_last_action' });
  assert.equal(emptyUndo.status, 'failed');
  assert.equal(emptyUndo.spokenMessage?.vi, 'Chưa có thao tác nào để hoàn tác.');
  assert.equal(emptyUndo.spokenMessage?.en, 'Nothing to undo yet.');
  assert.equal(intents.getVoiceSessionSnapshot().lastActionLifecycle?.state, 'failed');

  // 1-step navigate when URL updates -> 'succeeded'
  const okNav = await intents.executeIntentDag([{ kind: 'navigate', href: '/writing?w=translation&mode=PARAGRAPH' }]);
  assert.equal(okNav.status, 'done');
  assert.equal(currentPathname, '/writing');
  assert.equal(currentSearch, '?w=translation&mode=PARAGRAPH');
  assert.equal(intents.getVoiceSessionSnapshot().lastActionLifecycle?.state, 'succeeded');

  // 1-step navigate when URL fails to update (e.g. blocked navigation) -> 'failed', NEVER 'done'!
  currentPathname = '/dashboard';
  currentSearch = '';
  blockPushState = true;
  try {
    const failedNav = await intents.executeIntentDag(
      [{ kind: 'navigate', href: '/speaking?mode=shadowing' }],
      { routeTimeoutMs: 60, pollIntervalMs: 15 },
    );
    assert.equal(failedNav.status, 'failed');
    assert.equal(failedNav.steps[0].outcome.status, 'failed');
    assert.equal(failedNav.steps[0].outcome.spokenMessage?.vi, 'Mình chưa mở được trang đó lúc này.');
    assert.equal(intents.getVoiceSessionSnapshot().lastActionLifecycle?.state, 'failed');
  } finally {
    blockPushState = false;
  }

  // Off-module writing_control preserves mode=PARAGRAPH from /dashboard
  currentPathname = '/dashboard';
  currentSearch = '';
  const wrPara = await intents.executeIntentDag([{ kind: 'writing_control', room: 'translation', mode: 'PARAGRAPH' }]);
  assert.equal(wrPara.status, 'done');
  assert.equal(currentPathname, '/writing');
  assert.equal(currentSearch, '?w=translation&mode=PARAGRAPH');

  // WS action.client_plan sends truthful action.ack over WS and syncs server sessionId to chatBridge
  const sentAckPayloads = [];
  const appendedTurns = [];
  let syncedSid = null;
  let capturedCallbacks = null;

  const mockSession = {
    isRunning: true,
    isActiveConversation: true,
    playback: {
      isPlaying: false,
      isPausedHold: false,
      ensureAudioContext: () => null,
      getAnalyserNode: () => null,
      hardCancel: () => ({ turnSeq: 1, playedMs: 0, spokenTextSoFar: '', wasGreeting: false }),
    },
    detector: { setMode: () => {}, setTtsPlaying: () => {} },
    voiceClient: {
      isWsConnected: true,
      nextTurnSeq: () => 5,
      sendActionAck: (turnSeq, status, spokenMessage) => {
        sentAckPayloads.push({ turnSeq, status, spokenMessage });
        return true;
      },
      sendTurnEscalate: () => true,
      sendToolConfirm: () => true,
      cancelAndTruncateTurn: async () => {},
      disconnectIdle: () => {},
    },
    setPreferences: () => {},
    setFollowupExtended: () => {},
    resumeActiveListening: () => {},
    enterDormantStandby: () => {},
    start: async () => true,
    stop: () => {},
    dispose: () => {},
  };

  const rt = new runtimeMod.EchoJarvisRuntime(
    {
      sessionFactory: () => mockSession,
    },
    false,
  );
  rt.configure({ userId: '601', locale: 'vi' });
  rt.bindChatBridge({
    getHistory: () => [],
    onSyncSessionId: (sid) => {
      syncedSid = sid;
    },
    onAppendTurn: (u, a, _c, _act, opts) => {
      appendedTurns.push({ u, a, opts });
    },
  });
  rt['ensureAudioSession']();
  rt['lastUserTranscript'] = 'Hoàn tác thao tác vừa rồi';

  // Server sends undo_last_action when stack is empty -> client sends truthful failed action.ack (NOT fake spokenAck!)
  await rt['handleServerClientPlan']({
    turnSeq: 9,
    sessionId: 4040,
    intents: [{ kind: 'undo_last_action' }],
    spokenAck: 'Đang hoàn tác thao tác vừa rồi.',
    lang: 'vi',
  });
  assert.equal(syncedSid, 4040, 'server sessionId synced to CoachWidget chatBridge');
  assert.equal(sentAckPayloads.length, 1);
  assert.deepEqual(plain(sentAckPayloads[0]), {
    turnSeq: 9,
    status: 'failed',
    spokenMessage: 'Chưa có thao tác nào để hoàn tác.',
  });
  assert.equal(appendedTurns[0]?.a, 'Chưa có thao tác nào để hoàn tác.', 'truthful message recorded in chatBridge');

  // BUG-02: /learning-path list view vs odyssey
  assert.equal(intents.safeEchoJarvisHref('/learning-path'), '/learning-path');
  assert.equal(intents.safeEchoJarvisHref('/learning-path?view=list'), '/learning-path?view=list');
  assert.equal(intents.isImmersive3dWorldRoute('/learning-path', new URLSearchParams('')), false);
  assert.equal(intents.isImmersive3dWorldRoute('/learning-path', new URLSearchParams('view=list')), false);
  assert.equal(intents.isImmersive3dWorldRoute('/learning-path', new URLSearchParams('view=odyssey')), true);

  // BUG-03B: /speaking/shadowing/42 -> SHADOWING_LESSON, /speaking/roleplay/42 -> SPEAKING_SCENARIO
  assert.deepEqual(
    plain(pageCtxMod.pageContextFor('/speaking/shadowing/42', new URLSearchParams(''))),
    { kind: 'SHADOWING_LESSON', id: 42 },
  );
  assert.deepEqual(
    plain(pageCtxMod.pageContextFor('/speaking/roleplay/42', new URLSearchParams(''))),
    { kind: 'SPEAKING_SCENARIO', id: 42 },
  );

  // Source contracts for BUG-01, BUG-05, BUG-06, BUG-07 & CoachWidget Mode-3 channel='text' + Confirm Banner
  const coachSrc = readSrc('components/features/coach/CoachWidget.tsx');
  const musicSrc = readSrc('components/music/MusicProvider.tsx');
  const writingSrc = readSrc('components/features/writing/WritingModule.tsx');
  const flashcardSrc = readSrc('components/features/flashcard/FlashcardUI.tsx');
  const readingSrc = readSrc('components/features/reading/ReadingDashboard.tsx');

  assert.match(coachSrc, /onSubmitText=\{\(text\)\s*=>\s*void sendMessage\(undefined,\s*undefined,\s*text\)\}/);
  assert.match(coachSrc, /echo-panel-confirm-banner/);
  assert.match(musicSrc, /ec:jarvis:music/);
  assert.match(writingSrc, /ec:writing:intent/);
  assert.match(writingSrc, /dispatchEchoModuleReady\('writing'/);
  assert.match(flashcardSrc, /ec:flashcards:intent/);
  assert.match(flashcardSrc, /handledReviewParamRef/);
  assert.match(readingSrc, /if \(rawSection !== "bilingual"\) setSelectedBilingual\(null\)/);
});

await check('7. Wave C Security, 10 §AB Hygiene, sendTurnCheck Parity, Multi-Round Merge, Salience Reset & Held-Out Concept Slots', async () => {
  const voiceClientMod = loadTsModule('lib/echo-jarvis/audio/echoVoiceClient.ts');
  const ctxBridgeMod = loadTsModule('lib/echo/contextBridge.ts');
  const sentFrames = [];

  class MockWs {
    static OPEN = 1;
    readyState = 1;
    binaryType = 'arraybuffer';
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    send(payload) {
      if (typeof payload === 'string') sentFrames.push(JSON.parse(payload));
    }
    close() {
      this.readyState = 3;
    }
  }

  // [P0-2] WS sendTurnCheck carries 1-to-1 metadata with commitInput
  const fakePlayback = {
    beginTurn: () => {},
    softDuck: () => {},
    pauseHold: () => 0,
    resumeFromHold: () => {},
    hardCancel: () => ({ turnSeq: 1, playedMs: 0, spokenTextSoFar: '', wasGreeting: false }),
    enqueuePcm16Chunk: () => {},
    markTurnComplete: () => {},
  };
  let mockHasPendingConfirm = true;
  let mockStrictSentinel = false;
  const client = new voiceClientMod.EchoVoiceClient({
    playback: fakePlayback,
    webSocketFactory: () => {
      const sock = new MockWs();
      setTimeout(() => {
        sock.onopen?.();
        sock.onmessage?.({ data: JSON.stringify({ type: 'session.ready' }) });
      }, 0);
      return sock;
    },
    callbacks: {
      getSessionFlags: () => ({
        pathname: '/reading',
        hasPendingConfirmation: mockHasPendingConfirm,
        hasActiveStrictSentinel: mockStrictSentinel,
      }),
      getConversationHistory: () => [{ role: 'user', content: 'prev turn' }],
      getSalientResources: () => [{ index: 1, title: 'Tree Passage', href: '/reading?materialId=101', kind: 'reading' }],
    },
  });
  client.setSessionConfig({ sessionId: 888, locale: 'vi', voiceId: 'us_female' });
  await client.connect({ mode: 'hands_free', locale: 'vi' });
  sentFrames.length = 0;

  client.sendTurnCheck(12, true, { pageContext: { kind: 'MODULE', module: 'reading' } });
  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0].type, 'input.turn_check');
  assert.equal(sentFrames[0].turnSeq, 12);
  assert.equal(sentFrames[0].autoCommit, true);
  assert.equal(sentFrames[0].sessionId, 888);
  assert.equal(sentFrames[0].pathname, '/reading');
  assert.equal(sentFrames[0].hasPendingConfirmation, true);
  assert.equal(sentFrames[0].hasActiveStrictSentinel, false);
  assert.equal(sentFrames[0].messages?.length, 1);
  assert.equal(sentFrames[0].salientResources?.length, 1);

  // [P1-R1] Passive updateSession without resetSession omits empty messages:[] so Turn-1/barge-in history is never wiped
  sentFrames.length = 0;
  client.updateSession({ sessionId: null, messages: [], salientResources: [], pageContext: { kind: 'MODULE', module: 'dashboard' } });
  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0].type, 'session.update');
  assert.equal(sentFrames[0].sessionId, null);
  assert.equal(sentFrames[0].resetSession, undefined);
  assert.equal(sentFrames[0].messages, undefined);
  assert.equal(sentFrames[0].salientResources, undefined);

  // [P1-4] Explicit resetSession: true (newChat) transmits resetSession: true, sessionId: null, messages: [], salientResources: []
  sentFrames.length = 0;
  client.updateSession({ sessionId: null, resetSession: true, messages: [], salientResources: [], pageContext: { kind: 'MODULE', module: 'dashboard' } });
  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0].type, 'session.update');
  assert.equal(sentFrames[0].resetSession, true);
  assert.equal(sentFrames[0].sessionId, null);
  assert.deepEqual(plain(sentFrames[0].messages), []);
  assert.deepEqual(plain(sentFrames[0].salientResources), []);

  // [P0] 10 §AB Local-Book Privacy Hygiene on getTurnPageContext when transcript IS known
  currentPathname = '/reading';
  currentSearch = '?section=mybooks';
  ctxBridgeMod.setOverBookReader(true);
  ctxBridgeMod.publishEchoWorkspaceContext({
    source: 'mybooks-reader',
    kind: 'BOOK_ACTIVE',
    module: 'reading',
    bookMeta: { title: 'Private Local EPUB', author: 'Alice', progressPct: 45 },
    clientVisibleExcerpt: 'TOP_SECRET_LOCAL_BOOK_EXCERPT_DO_NOT_LEAK',
  });

  const privacyRt = new runtimeMod.EchoJarvisRuntime({}, false);
  privacyRt.configure({ userId: '701', locale: 'en' });
  // Simulate a previous turn that DID ask about the book — must NEVER poison the next unrelated turn!
  privacyRt['lastUserTranscript'] = 'Explain this chapter in detail';
  const session701 = privacyRt['ensureAudioSession']();
  const getTurnCtx = session701['callbacks'].getTurnPageContext;

  // Unrelated known transcript -> ZERO bookMeta / clientVisibleExcerpt
  const unrelatedCtx = plain(getTurnCtx('What is the difference between make and do?'));
  assert.equal(unrelatedCtx?.bookMeta, undefined, '10 §AB: unrelated turn must NOT attach bookMeta');
  assert.equal(unrelatedCtx?.clientVisibleExcerpt, undefined, '10 §AB: unrelated turn must NOT attach clientVisibleExcerpt');

  // Explicit page/book reference -> attaches on-demand bookMeta & clientVisibleExcerpt
  const bookRefCtx = plain(getTurnCtx('Summarize this paragraph for me'));
  assert.equal(bookRefCtx?.bookMeta?.title, 'Private Local EPUB');
  assert.equal(bookRefCtx?.clientVisibleExcerpt, 'TOP_SECRET_LOCAL_BOOK_EXCERPT_DO_NOT_LEAK');

  const viBookRefCtx = plain(getTurnCtx('Giải thích câu này giúp mình'));
  assert.equal(viBookRefCtx?.clientVisibleExcerpt, 'TOP_SECRET_LOCAL_BOOK_EXCERPT_DO_NOT_LEAK');

  // Pre-ASR WS turn_check (transcript === undefined) -> includes fresh candidate for backend EchoRouter.pageReferenced
  const preAsrCtx = plain(getTurnCtx(undefined));
  assert.equal(preAsrCtx?.bookMeta?.title, 'Private Local EPUB');

  ctxBridgeMod.clearEchoWorkspaceContext('mybooks-reader');
  ctxBridgeMod.setOverBookReader(false);

  // [P1-2] WS Salience Wipe prevention + multi-round pendingTurnActions merge + shared-hub URL skip
  intents.setVoiceSessionUser('702');
  intents.clearAllSalientResources();

  // 5 bilingual items sharing hub-only "/reading?section=bilingual" must NOT collapse into 1 misleading "open it" target!
  const sharedHubSalience = intents.extractSalientResources(
    [
      {
        type: 'resources',
        items: [
          { title: 'Story 1', href: '/reading?section=bilingual' },
          { title: 'Story 2', href: '/reading?section=bilingual' },
          { title: 'Story 3', href: '/reading?section=bilingual' },
          { title: 'Story 4', href: '/reading?section=bilingual' },
          { title: 'Story 5', href: '/reading?section=bilingual' },
        ],
      },
    ],
    [{ type: 'navigate', label: 'Bilingual Reading', href: '/reading?section=bilingual' }],
  );
  assert.equal(sharedHubSalience.length, 0, 'shared hub-only URLs across multiple items must be skipped');

  // Round 0 emits 5 distinct resource cards -> Round 1 emits navigate "/speaking" with cards === undefined -> 5 items preserved!
  const salienceRt = new runtimeMod.EchoJarvisRuntime({}, false);
  salienceRt.configure({ userId: '702', locale: 'en', sessionId: 909 });
  const sess702 = salienceRt['ensureAudioSession']();
  const onActionsAndCards = sess702['callbacks'].onActionsAndCards;
  onActionsAndCards({
    turnSeq: 21,
    cards: [
      {
        type: 'resources',
        items: [
          { title: 'S1', href: '/speaking/roleplay/11' },
          { title: 'S2', href: '/speaking/roleplay/12' },
          { title: 'S3', href: '/speaking/roleplay/13' },
          { title: 'S4', href: '/speaking/roleplay/14' },
          { title: 'S5', href: '/speaking/roleplay/15' },
        ],
      },
    ],
    actions: [{ type: 'navigate', href: '/speaking?mode=roleplay', label: 'Roleplay', auto: false }],
  });
  onActionsAndCards({
    turnSeq: 21,
    cards: undefined,
    actions: [{ type: 'navigate', href: '/speaking', label: 'Speaking', auto: false }],
  });
  assert.equal(intents.getSessionSalientResources(909, '702').length, 5, 'trailing navigate frame must NOT wipe 5 resource-card items');
  assert.equal(salienceRt['pendingTurnActions'].length, 2, 'multi-round pendingTurnActions appended & deduplicated');

  // [P1-4] resetConversationSession() clears active salience & never leaks session 909 into new null/910 session
  assert.equal(intents.getSessionSalientResources(null, '702').length, 0, 'concrete session 909 never pollutes active slot');
  intents.setSessionSalientResources([{ index: 1, title: 'Temp', href: '/listening/5', kind: 'listening' }], null, '702');
  assert.equal(intents.getSessionSalientResources(null, '702').length, 1);
  salienceRt.resetConversationSession();
  assert.equal(intents.getSessionSalientResources(null, '702').length, 0, 'resetConversationSession wipes active slot');

  // [P2-1] Default waitForTargetUrl timeout is 500 ms (< 650 ms backend ACTION_ACK_TIMEOUT_MS)
  currentPathname = '/dashboard';
  currentSearch = '';
  blockPushState = true;
  try {
    const t0 = performance.now();
    const timedOut = await intents.executeIntentDag([{ kind: 'navigate', href: '/listening' }]);
    const elapsed = performance.now() - t0;
    assert.equal(timedOut.status, 'failed');
    assert.ok(elapsed >= 450 && elapsed < 750, `expected ~500ms default routeTimeoutMs, got ${elapsed.toFixed(0)}ms`);
  } finally {
    blockPushState = false;
  }

  // Guard Parity ("log me out", "cancel my Premium subscription" -> DENIED; negated/hypothetical -> Plane B; "Sign out" -> PLANE_A)
  assert.equal(intents.detectUtteranceGuard('log me out', { pathname: '/dashboard' })?.decision, 'DENIED');
  assert.equal(intents.detectUtteranceGuard('cancel my Premium subscription', { pathname: '/premium' })?.decision, 'DENIED');
  assert.equal(intents.detectUtteranceGuard("Don't log me out", { pathname: '/dashboard' }), null);
  assert.equal(intents.detectUtteranceGuard('If I cancel my Premium subscription, what happens?', { pathname: '/premium' }), null);
  assert.equal(intents.compileFastPathUtterance('Sign out', { pathname: '/dashboard' })?.intents[0]?.kind, 'request_logout');

  // Held-Out Concept-Slot Generalization & Vietnamese "Đang mở Tủ sách của bạn." copy
  const heldOutCases = [
    ['bring up speaking stats in my profile', '/speaking?view=profile'],
    ["I'd love to jump into shadowing in the speaking section", '/speaking?mode=shadowing'],
    ['take me over to Echo Quiz Rush game', '/games/echo-quiz-rush'],
    ['switch my screen to home dashboard', '/dashboard'],
    ['head over to leaderboard rankings on the English Coach portal', '/leaderboard'],
    ['review due flashcards', '/flashcards?review=due'],
    ['review learned flashcards', '/flashcards?review=learned'],
    ['cho mình xem kỹ năng nói', '/speaking'],
    ['bookshelf', '/reading?section=mybooks'],
    ['tủ sách', '/reading?section=mybooks'],
    ["open today's learning path tasks", '/learning-path?view=list'],
    ['mở nhiệm vụ lộ trình học hôm nay', '/learning-path?view=list'],
    ['open Study Space fullscreen', '/study-space'],
    ['open Speaking Arena fullscreen', '/speaking/arena'],
    ['mở đọc, khoan không phải, mở nghe đi', '/listening'],
  ];
  for (const [phrase, expectedHref] of heldOutCases) {
    const res = intents.compileFastPathUtterance(phrase, { pathname: '/dashboard' });
    assert.ok(res, `expected held-out Plane-A match for: "${phrase}"`);
    assert.equal(res.intents[0]?.kind, 'navigate', `expected navigate for "${phrase}"`);
    assert.equal(res.intents[0]?.href, expectedHref, `href mismatch for "${phrase}"`);
  }

  const tuSachMatch = intents.compileFastPathUtterance('mở tủ sách', { pathname: '/dashboard' });
  assert.equal(tuSachMatch?.spokenAck, 'Đang mở Tủ sách của bạn.');
  assert.ok(!tuSachMatch?.spokenAck.includes('của tôi'));

  const navStudioMatch = intents.compileFastPathUtterance('open navigation studio settings', { pathname: '/dashboard' });
  assert.deepEqual(plain(navStudioMatch?.intents), [{ kind: 'open_appearance_studio', room: 'navigation' }]);

  const scrollDownVi = intents.compileFastPathUtterance('cuộn xuống dưới', { pathname: '/reading' });
  assert.deepEqual(plain(scrollDownVi?.intents), [{ kind: 'scroll', target: 'down' }]);
  const scrollUpVi = intents.compileFastPathUtterance('cuộn lên trên', { pathname: '/reading' });
  assert.deepEqual(plain(scrollUpVi?.intents), [{ kind: 'scroll', target: 'up' }]);

  // [P2-3] CoachWidget subtitle copy & multi-round merge helpers
  const coachSrc = readSrc('components/features/coach/CoachWidget.tsx');
  assert.match(coachSrc, /Người bạn đồng hành AI của bạn/);
  assert.match(coachSrc, /Your AI companion and learning coach/);
  assert.doesNotMatch(coachSrc, /Giáo sư tiếng Anh của bạn/);
  assert.doesNotMatch(coachSrc, /Your English professor/);
  assert.match(coachSrc, /mergeCards\(cards,\s*nextCards\)/);
  assert.match(coachSrc, /mergeActions\(actions,\s*nextActions\)/);
});

console.log(`verify-echo-agentic: ${passed}/7 comprehensive check suites passed`);
