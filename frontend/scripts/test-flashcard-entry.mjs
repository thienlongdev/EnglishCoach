import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const read = p => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
function evaluate(path, dependencies = {}, globals = {}) {
  const { code } = babel.core().transformSync(read(path), { filename: path, configFile: false, babelrc: false,
    presets: [babel.presetTypescript(), ...(path.endsWith('.tsx') ? [babel.presetReact()] : [])], plugins: [babel.pluginTransformModulesCommonjs()] });
  const exports = {}; runInNewContext(code, { exports, require: p => dependencies[p] ?? require(p), AbortController, console, setTimeout, clearTimeout, ...globals }); return exports;
}
const core = evaluate('lib/module-entry-core.ts');
const cache = evaluate('lib/flashcard-system-cache.ts');
const readingCache = evaluate('lib/reading-system-cache.ts');
const deck = { id: 1, slug: 'science', title: 'Science vocabulary', description: 'Learn science', category: 'IELTS_TOPIC',
  themeColor: 'emerald', icon: 'book', totalWords: 100, isSystem: true, sortOrder: 1 };
const catalog = { catalogRevision: 'a'.repeat(64), totalDecks: 1, totalWords: 100, decks: [deck] };
const map = new Map(); const storage = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), clear: () => map.clear() };
const now = Date.now();
cache.saveFlashcardSnapshot(catalog, storage, now);
assert.equal(cache.readFlashcardSnapshot(storage, now).data.totalWords, 100);
assert.equal(cache.readFlashcardSnapshot(storage, now + cache.FLASHCARD_FRESH_MS).stale, true);
assert.equal(cache.readFlashcardSnapshot(storage, now + cache.FLASHCARD_MAX_AGE_MS + 1), undefined);
for (const data of [{ ...catalog, token: 'private' }, { ...catalog, decks: [{ ...deck, masteredCount: 5 }] },
  { ...catalog, decks: [{ ...deck, words: ['secret'] }] }, { ...catalog, decks: [{ ...deck, isSystem: false }] },
  { ...catalog, totalWords: 99 }, { ...catalog, decks: [{ ...deck, id: null }] }]) assert.equal(cache.validFlashcardCatalog(data), false);
for (const raw of ['{', JSON.stringify({ version: 2, cachedAt: now, data: catalog }), JSON.stringify({ version: 1, cachedAt: now + 1, data: catalog }), ' '.repeat(200001)]) {
  storage.setItem(cache.FLASHCARD_SYSTEM_CACHE_KEY, raw); assert.equal(cache.readFlashcardSnapshot(storage, now), undefined);
}
assert.doesNotThrow(() => cache.saveFlashcardSnapshot(catalog, { setItem() { throw Error('quota'); } }));
const cssModule = new Proxy({}, { get: (_, k) => (k === '__esModule' ? false : String(k)) });
const deckArt = evaluate('components/features/flashcard/deckArt.ts', { './bookArt.json': JSON.parse(read('components/features/flashcard/bookArt.json')) });
const view = evaluate('components/features/flashcard/DeckCatalogView.tsx', { react: React, './memoryUniverse.module.css': cssModule, './deckArt': deckArt, './libraryFacets.json': JSON.parse(read('components/features/flashcard/libraryFacets.json')),
  '@/components/common/BrandWhaleIcon': { BrandWhaleIcon: () => null }, '@/components/common/PageJump': { PageJump: () => null } }).DeckCatalogView;
const props = { personalTotalCards: 0, personalDueCards: 0, personalMasteredCards: 0, onSelectDeck() {}, onAddCard() {}, onImportApkg() {} };
const unknown = renderToString(React.createElement(view, { ...props, decks: [], loading: true }));
assert.ok(unknown.includes('Đang tải kho từ vựng')); assert.ok(!unknown.includes('Không tìm thấy')); assert.ok(!unknown.includes('Tổng số từ')); assert.ok(!unknown.includes('Cá nhân'));
const warm = renderToString(React.createElement(view, { ...props, decks: cache.mergeFlashcardDecks(catalog, undefined), progressLoading: true }));
assert.ok(warm.includes('Science vocabulary')); assert.ok(warm.includes('Đang tải tiến độ')); assert.ok(!warm.includes('Chưa học (0/')); assert.ok(!warm.includes('Cá nhân • 0'));
const empty = renderToString(React.createElement(view, { ...props, decks: [], loading: false })); assert.ok(empty.includes('Không tìm thấy bộ từ vựng'));
const failed = renderToString(React.createElement(view, { ...props, decks: [], loading: true, error: 'Unavailable' }));
assert.ok(failed.includes('Unavailable')); assert.ok(failed.includes('Thử lại')); assert.ok(!failed.includes('Không tìm thấy'));
const progress = [{ deckId: null, totalCards: 12, masteredCount: 3, reviewedCount: 3, learningCount: 9, dueCount: 9 },
  { deckId: 1, totalCards: 101, masteredCount: 101, reviewedCount: 101, learningCount: 0, dueCount: 0 }];
const merged = cache.mergeFlashcardDecks(catalog, progress); assert.equal(merged[0].totalWords, 12); assert.equal(merged[1].masteredCount, 100);
assert.equal(cache.mergeFlashcardDecks(catalog, [])[0].totalWords, 0); // authoritative personal empty
let finish, calls = 0, seeded = [];
const service = evaluate('services/moduleEntryResources.ts', { swr: { mutate: async (...args) => seeded.push(args) },
  './api-client': { apiClient: { get: () => { calls++; return new Promise(r => finish = r); } } },
  '../lib/module-entry-core': core, '../lib/listening-system-cache': {}, '../lib/reading-system-cache': readingCache, '../lib/flashcard-system-cache': cache });
const prep = service.prepareModuleEntry(service.FLASHCARD_CATALOG_PATH, 'A');
const route = service.fetchModuleEntry(service.FLASHCARD_CATALOG_PATH, 'A');
await Promise.resolve(); assert.equal(calls, 1); finish({ data: catalog }); await Promise.all([prep, route]); assert.equal(seeded.length, 1);
assert.equal(service.entryKey(service.FLASHCARD_CATALOG_PATH, 'A'), service.entryKey(service.FLASHCARD_CATALOG_PATH, 'B'));
assert.notDeepEqual(service.entryKey(service.FLASHCARD_PROGRESS_PATH, 'A'), service.entryKey(service.FLASHCARD_PROGRESS_PATH, 'B'));
const late = service.prepareModuleEntry(service.FLASHCARD_PROGRESS_PATH, 'A'); await Promise.resolve(); service.clearModuleEntryRequests(); finish({ data: progress });
await assert.rejects(late, /cancelled/); assert.equal(seeded.length, 1);
// Execute real logout to prove only validated SYSTEM metadata survives.
cache.saveFlashcardSnapshot(catalog, storage, now); storage.setItem('private-A', 'secret');
let purged = false, cleared = false;
const browserCache = evaluate('lib/flashcard-system-cache.ts', {}, { window: { localStorage: storage } });
const noop = () => {};
let focusDisposed=0;
const cleanup = evaluate('lib/auth-cache-cleanup.ts', {
  '@/lib/study-space/focus':{disposeFocusEngines(){focusDisposed++;}},
  swr: { mutate: () => { purged = true; } }, '@/hooks/useCurrentUserAvatar': { revokeCurrentAvatarObjectUrl: noop },
  '@/services/stompClient': { disconnectRealtimeClient: noop }, '@/services/listeningCache': { clearListeningUserCache: noop },
  '@/services/communityCache': { clearCommunityUserCache: noop }, '@/lib/wallpaper/youtubeLibrary': { clearWallpaperLibrary: noop }, '@/services/moduleEntryResources': { clearModuleEntryRequests: service.clearModuleEntryRequests },
  '@/lib/listening-system-cache': { preserveSystemListeningSnapshot: () => undefined }, '@/lib/reading-system-cache': readingCache, '@/lib/flashcard-system-cache': browserCache,
  '@/lib/auth-lifecycle': { cancelAuthenticatedWork: noop }, '@/services/profileIdentityResource': { clearProfileIdentityRequests: noop },
  '@/services/leaderboardSnapshots': { clearBoardSnapshots: noop }, '@/services/contentSystemResources': { clearContentRequests: noop },
  '@/lib/content-system-snapshots': { readContentSnapshots: () => undefined },
}, { window: {}, localStorage: storage, sessionStorage: { clear: () => { cleared = true; } } });
cleanup.clearUserScopedCaches();assert.ok(focusDisposed>0); assert.equal(map.size, 1); assert.ok(cache.readFlashcardSnapshot(storage)); assert.ok(purged && cleared);
const ui = read('components/features/flashcard/FlashcardUI.tsx');
assert.ok(ui.includes('useFlashcardCatalog()')); assert.ok(!ui.includes('decksFetcher'));
assert.ok(ui.includes('loading={!catalogKnown}')); assert.ok(ui.includes('mutateDecks();'));
const preparation = read('components/common/ModuleEntryPreparation.tsx'); assert.ok(preparation.includes('[FLASHCARD_CATALOG_PATH, FLASHCARD_PROGRESS_PATH'));
assert.ok(!preparation.includes('/flashcards/due')); assert.ok(!preparation.includes('dictionaryEntry'));
console.log('Flashcards entry: PASS (real cold/warm/empty/error renders, metadata validation, corrupt/versioned/stale snapshots, dedupe, late A rejection, logout privacy, lazy study contracts).');
