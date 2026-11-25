// Behavioral tests from the actual TS engine, with a deterministic native-media adapter.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
const require = createRequire(import.meta.url), babel = require('next/dist/compiled/babel/bundle.js');
const root = new URL('../src/', import.meta.url);
const read = rel => fs.readFileSync(new URL(rel, root), 'utf8');
const cache = new Map(), saved = new Map(), rows = new Map(), audios = [], revoked = [];
let sequence = 0, pendingPlay = null;
let analysisFactory = null;
class FakeAudio {
  constructor() { audios.push(this); this.dataset = {}; this.paused = true; this.currentTime = 0; this.duration = 200; this.volume = 1; }
  setAttribute() {} removeAttribute() {} remove() { this.removed = true; } load() {}
  async play() { if (pendingPlay) await pendingPlay; this.paused = false; this.onplaying?.(); }
  pause() { this.paused = true; this.onpause?.(); }
}
const storage = {
  listTracks: async scope => [...(rows.get(scope)?.values() ?? [])].map(({ file, cover, ...rest }) => rest),
  getTrack: async (scope, id) => rows.get(scope)?.get(id),
  readSettings: async scope => saved.get(scope),
  writeSettings: async (scope, value) => saved.set(scope, structuredClone(value)),
  deleteTrack: async (scope, id) => rows.get(scope)?.delete(id),
  saveTrack: async (scope, track) => { if (!rows.has(scope)) rows.set(scope, new Map()); rows.get(scope).set(track.id, track); },
  editTrack: async (scope, id, title, artist) => Object.assign(rows.get(scope).get(id), { title, artist }),
};
const importAdapter = { prepareImport: async file => ({ id: `local-${++sequence}`, title: file.name, source: 'local', artist: '', accent: '#aabbcc', mood: 'calm', duration: 100, file, bytes: file.size }) };
const navigator = { mediaSession: { setActionHandler() {} }, storage: { persist: async () => true } };
// One tab's sessionStorage; replace the Map to simulate a new tab.
let tab = new Map();
const sessionStorage = { getItem: key => tab.has(key) ? tab.get(key) : null, setItem: (key, value) => tab.set(key, String(value)), removeItem: key => tab.delete(key) };
function load(rel) {
  if (cache.has(rel)) return cache.get(rel);
  const out = {};
  const code = babel.core().transformSync(read(rel), { filename: path.basename(rel), configFile: false, babelrc: false, presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()] }).code;
  runInNewContext(code, { exports: out, crypto: webcrypto, Math, Date, console, setTimeout, clearTimeout, Uint8Array, Audio: FakeAudio, AudioContext: function () { if (!analysisFactory) throw new Error('Optional analysis unavailable'); return analysisFactory(); }, navigator, sessionStorage,
    MediaMetadata: class { constructor(value) { Object.assign(this, value); } },
    document: { body: { appendChild() {} } }, URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: url => revoked.push(url) },
    require: name => name === './storage' ? storage : name === './import' ? importAdapter : load(path.posix.join(path.posix.dirname(rel), name + '.ts')),
  });
  cache.set(rel, out); return out;
}
const { focusReason, nextIndex, musicDatabaseName, validateMusicFile, clock } = load('lib/music/model.ts');
const { MusicEngine } = load('lib/music/engine.ts');
const { MUSIC_CATALOG } = load('lib/music/catalog.ts');
let groups = 0;
const ok = label => { groups++; console.log(`PASS ${label}`); };
assert.notEqual(musicDatabaseName('A'), musicDatabaseName('B'));
for (const bad of ['guest', '', '../A', 'A/B']) assert.throws(() => musicDatabaseName(bad));
ok('local databases are account scoped; unsafe or guest scopes refused');
for (const file of [{ size: 0, name: 'x.mp3', type: 'audio/mpeg' }, { size: 151 * 1024 * 1024, name: 'x.mp3', type: 'audio/mpeg' }, { size: 5, name: 'x.exe', type: 'audio/mpeg' }, { size: 5, name: 'x.mp3', type: 'text/plain' }]) assert.throws(() => validateMusicFile(file));
validateMusicFile({ size: 500, name: 'track.FLAC', type: '' }); assert.equal(clock(NaN), '0:00'); assert.equal(clock(225), '3:45');
ok('file type/size limits and finite timeline formatting');
for (const route of ['/listening', '/listening/1/practice', '/dictation']) assert.equal(focusReason(route), 'listening');
assert.equal(focusReason('/speaking/topics'), 'speaking'); assert.equal(focusReason('/exams/ielts'), 'exam'); assert.equal(focusReason('/games/hangman'), 'game');
assert.equal(focusReason('/', 'speaking'), 'speaking'); assert.equal(focusReason('/', 'flashcards'), null); assert.equal(focusReason('/music'), null);
ok('listening, dictation, speaking, exams, games focus; browsing stays allowed');
assert.equal(nextIndex(2, 3), 0); assert.equal(nextIndex(0, 3, -1), 2); assert.equal(nextIndex(0, 1, 1, true), 0);
for (let n = 0; n < 100; n++) assert.notEqual(nextIndex(2, 5, 1, true, n / 100), 2);
ok('queue boundaries, previous and shuffle avoid the current track');
assert.equal(new Set(MUSIC_CATALOG.map(t => t.id)).size, MUSIC_CATALOG.length);
assert(MUSIC_CATALOG.every(t => t.url.startsWith('https://www.scottbuckley.com.au/') && t.creditUrl && t.artwork && t.artist === 'Scott Buckley'));
ok('curated entries retain authentic title, artist, artwork and direct credited source');
const a = new MusicEngine('A'); await a.initialize();
assert.equal(a.snapshot().engaged, false);
await a.select(MUSIC_CATALOG[0].id, MUSIC_CATALOG.map(t => t.id));
assert.equal(a.snapshot().engaged, true);
assert.equal(a.snapshot().playing, true); const first = audios.at(-1);
a.seek(32); a.volume(.3); assert.equal(first.volume, .3); assert.equal(first.currentTime, 32);
assert.equal(audios.at(-1), first); ok('play, seek, volume and state updates keep the same audio element');
a.setFocus('speaking'); assert(first.paused); await a.play(); assert(first.paused); a.setFocus(null); assert(!a.snapshot().playing); await a.play(); assert(!first.paused);
ok('focus pauses and blocks restart; leaving a task requires explicit Play');
a.hold('one', true); a.hold('two', true); a.hold('one', false); assert.equal(a.snapshot().focus, 'media'); a.hold('two', false); assert.equal(a.snapshot().focus, null);
ok('overlapping audio focus holds release independently');
await a.next(); assert(first.removed); assert.equal(a.snapshot().current.id, MUSIC_CATALOG[1].id);
a.seek(10); await a.next(-1); assert.equal(a.snapshot().current.id, MUSIC_CATALOG[1].id); assert.equal(a.snapshot().time, 0);
await a.next(-1); assert.equal(a.snapshot().current.id, MUSIC_CATALOG[0].id);
ok('track changes release old audio; previous restarts before moving back');
a.removeQueue(MUSIC_CATALOG[1].id); assert(!a.snapshot().queue.includes(MUSIC_CATALOG[1].id)); a.enqueue(MUSIC_CATALOG[1].id);
const before = a.snapshot().queue.indexOf(MUSIC_CATALOG[1].id); a.moveQueue(MUSIC_CATALOG[1].id, -1); assert.equal(a.snapshot().queue.indexOf(MUSIC_CATALOG[1].id), before - 1);
ok('queue add/remove/reorder persists exact ids');
a.seek(21); a.checkpoint(); a.dispose();
const restored = new MusicEngine('A'); await restored.initialize(); assert.equal(restored.snapshot().time, 21); assert.equal(restored.snapshot().playing, false); assert.equal(restored.snapshot().volume, .3);
const b = new MusicEngine('B'); await b.initialize(); assert.equal(b.snapshot().current, null); assert.equal(b.snapshot().queue.length, 0);
ok('refresh restores position/queue/volume paused; another account sees no private state');
await restored.importFiles([{ name: 'Original.wav', size: 800 }]); assert.equal(restored.snapshot().library.length, 1); const local = restored.snapshot().library[0];
await restored.select(local.id); assert.equal(audios.at(-1).src, 'blob:fixture'); await b.reloadLibrary(); assert.equal(b.snapshot().library.length, 0);
await restored.edit(local.id, 'Updated title', 'Artist'); assert.equal(restored.snapshot().current.title, 'Updated title'); await restored.delete(local.id); assert.equal(restored.snapshot().current, null); assert.equal(restored.snapshot().library.length, 0); assert(revoked.includes('blob:fixture'));
ok('import, private playback, metadata edit, delete and blob cleanup');
await b.select(MUSIC_CATALOG[0].id); b.pause(); let resolvePlay; pendingPlay = new Promise(resolve => { resolvePlay = resolve; });
const late = b.play(); b.setFocus('exam'); resolvePlay(); await late; pendingPlay = null; assert(audios.at(-1).paused);
ok('a delayed play promise cannot overtake an exam interruption');
b.setFocus(null); let rejectPlay; pendingPlay = new Promise((_resolve, reject) => { rejectPlay = reject; });
const interrupted = b.play(); b.pause(); const abort = new Error('Intentional pause'); abort.name = 'AbortError'; rejectPlay(abort); await interrupted; pendingPlay = null;
assert.equal(b.snapshot().error, null); assert.equal(b.snapshot().playing, false);
ok('intentional native play cancellation is not shown as a playback failure');
restored.dispose(); b.dispose();
// Header presence: only after music started in this tab; a refresh keeps it (paused), a new tab or Close clears it.
tab = new Map();
const h1 = new MusicEngine('H'); await h1.initialize(); assert.equal(h1.snapshot().engaged, false);
await h1.select(MUSIC_CATALOG[2].id); assert.equal(h1.snapshot().engaged, true); h1.dispose();
const h2 = new MusicEngine('H'); await h2.initialize(); assert.equal(h2.snapshot().engaged, true); assert.equal(h2.snapshot().playing, false);
h2.dismiss(); assert.equal(h2.snapshot().engaged, false); assert.equal(h2.snapshot().current.id, MUSIC_CATALOG[2].id); h2.dispose();
const h3 = new MusicEngine('H'); await h3.initialize(); assert.equal(h3.snapshot().engaged, false); await h3.select(MUSIC_CATALOG[2].id); h3.dispose();
tab = new Map(); const h4 = new MusicEngine('H'); await h4.initialize(); assert.equal(h4.snapshot().engaged, false); assert.equal(h4.snapshot().playing, false);
await h4.importFiles([{ name: 'Mine.wav', size: 10 }]); const mine = h4.snapshot().library[0]; await h4.select(mine.id); assert.equal(h4.snapshot().engaged, true);
await h4.delete(mine.id); assert.equal(h4.snapshot().engaged, false); h4.dispose();
const other = new MusicEngine('I'); await other.initialize(); assert.equal(other.snapshot().engaged, false); other.dispose();
let closedAnalysis = 0;
analysisFactory = () => ({ state: 'suspended', resume: () => new Promise(() => {}), close: async () => { closedAnalysis++; }, createMediaElementSource: () => { throw new Error('Blocked analysis must not reroute native audio'); } });
const blocked = new MusicEngine('BLOCKED'); await blocked.initialize(); await blocked.importFiles([{ name: 'Local.wav', size: 100 }]);
const started = Date.now(); await blocked.select(blocked.snapshot().library[0].id);
assert(Date.now() - started < 1500); assert.equal(blocked.snapshot().playing, true); assert.equal(blocked.analyser, null); assert.equal(closedAnalysis, 1);
blocked.dispose(); analysisFactory = null;
ok('blocked optional AudioContext times out before rerouting; native local playback stays audible');
ok('header player appears only after Play in this tab; refresh keeps it paused; Close, a new tab, another account or a deleted track clear it');
const provider = read('components/music/MusicProvider.tsx'), sidebar = read('components/layout/Sidebar.tsx'), compact = read('components/music/CompactMusicPlayer.tsx'), css = read('components/music/Music.module.css'), compactCss = read('components/music/CompactMusicPlayer.module.css'), topbar = read('components/layout/TopNavbar.tsx');
// The music engine wraps the page, the coach and the account's Messenger (its cards are part of the same signed-in shell).
assert(read('app/providers.tsx').includes('<MusicProvider>{children}<Suspense fallback={null}><ArenaAwareCoach /></Suspense><MessengerForAccount /></MusicProvider>'));
assert(read('app/providers.tsx').includes("pathname === '/speaking/arena'") && read('app/providers.tsx').includes('null : <CoachWidget />'));
assert(topbar.includes('<CompactMusicPlayer />'));
// The player is the flex item right after the dictionary search slot, inside <header>.
const afterSearch = topbar.slice(topbar.indexOf('<GlobalDictionarySearch'), topbar.indexOf('<CompactMusicPlayer />'));
assert(topbar.indexOf('<CompactMusicPlayer />') < topbar.indexOf('</header>') && afterSearch.match(/<\/div>/g)?.length === 1);
assert(compact.includes('if (!engaged || !current) return null;'));
// The header never loads the room's stylesheet.
for (const rel of ['components/music/CompactMusicPlayer.tsx', 'components/music/MusicArtwork.tsx']) assert(!read(rel).includes('Music.module.css'), rel);
assert(sidebar.indexOf('data-testid="sidebar-music"') > sidebar.indexOf('</nav>'));
assert(sidebar.indexOf('data-testid="sidebar-music"') < sidebar.indexOf('data-testid="sidebar-wallpaper"'));
assert(provider.includes('subscribeAuthLifecycle')); assert(!/createPortal/.test(compact));
for (const sheet of [css, compactCss]) { assert(!/position:\s*(fixed|sticky)/.test(sheet)); assert(sheet.includes('prefers-reduced-motion')); assert(sheet.includes('overflow: clip')); assert(sheet.includes('max-width: 699px')); }
ok('persistent provider, header-only compact surface, standalone sidebar order, reduced motion and responsive rules');
const sources = ['lib/music/engine.ts', 'lib/music/storage.ts', 'lib/music/import.ts', 'components/music/MusicHub.tsx', 'components/music/MusicCoverflow.tsx', 'components/music/CompactMusicPlayer.tsx', 'components/music/MusicArtwork.tsx'];
for (const rel of sources) { assert(!/\b(fetch|XMLHttpRequest|FormData|sendBeacon)\s*\(/.test(read(rel)), rel); assert(!/Sparkles|✨/.test(read(rel)), rel); }
ok('music has no upload/proxy/API calls or forbidden icons');
console.log(`Echo Music: ${groups} behavioral/contract groups passed`);
