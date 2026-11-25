// Hình nền (wallpapers) contracts — 2026-10-19 rebuild. Static source rules + the pure media / preference rules,
// executed from the real TypeScript sources (transpiled with Next's bundled Babel, no network).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const frontend = fs.existsSync(path.resolve('src')) ? path.resolve('.') : path.resolve('frontend');
const src = (...p) => path.join(frontend, 'src', ...p);
const read = (...p) => fs.readFileSync(src(...p), 'utf8');
let passed = 0;
const ok = (label) => { passed += 1; console.log(`PASS ${label}`); };

// ─── Load the pure modules from source ────────────────────────────────────────────────────────────────
const modules = new Map();
// One browser: every module sees the same localStorage. The library API is a test double (no network in contracts).
const storage = new Map();
const apiCalls = [];
const fakeServer = { items: new Map() };
const wallpaperLibraryApi = {
  list: async () => { apiCalls.push(['list']); return { items: [...fakeServer.items.values()], limit: 50 }; },
  save: async (videoId) => { apiCalls.push(['save', videoId]); const entry = { id: `e-${videoId}`, videoId, background: null }; fakeServer.items.set(videoId, entry); return { entry, created: true }; },
  importDeviceList: async (ids) => { apiCalls.push(['import', ...ids]); for (const v of ids) fakeServer.items.set(v, { id: `e-${v}`, videoId: v, background: null }); return { items: [...fakeServer.items.values()], imported: ids.length, alreadySaved: 0, overLimit: 0, limit: 50 }; },
  setBackground: async (id, input) => { apiCalls.push(['background', id, input.kind]); return { id, videoId: 'x', background: input.kind ? { kind: input.kind, url: input.url ?? null, fileName: input.fileName ?? null } : null }; },
  remove: async (id) => { apiCalls.push(['remove', id]); },
};
function load(rel) {
  if (modules.has(rel)) return modules.get(rel);
  const code = babel.core().transformSync(read(...rel.split('/')), {
    filename: path.basename(rel), configFile: false, babelrc: false,
    presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()],
  }).code;
  const exports = {};
  modules.set(rel, exports);
  runInNewContext(code, {
    exports, URL, URLSearchParams, console,
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1 },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    navigator: {},
    CustomEvent: class { constructor(type) { this.type = type; } },
    require: (name) => {
      if (name === '@/lib/appearance/scope') return load('lib/appearance/scope.ts');
      if (name === '@/services/wallpaperLibraryApi') return { wallpaperLibraryApi };
      if (name.startsWith('@/lib/wallpaper/')) return load(`lib/wallpaper/${name.slice('@/lib/wallpaper/'.length)}.ts`);
      if (name.startsWith('./')) return load(`${rel.split('/').slice(0, -1).join('/')}/${name.slice(2)}.ts`);
      return {};
    },
  });
  return exports;
}
const catalog = load('lib/wallpaper/catalog.ts');
const media = load('lib/wallpaper/media.ts');
const store = load('lib/wallpaper/storage.ts');

// ─── 1. Catalog: real, licensed, genuinely animated ───────────────────────────────────────────────────
const presets = catalog.WALLPAPER_PRESETS;
assert.ok(presets.length >= 3, 'at least three animated presets');
assert.equal(new Set(presets.map((p) => p.id)).size, presets.length, 'preset ids are unique');
for (const p of presets) {
  assert.equal(p.kind, 'video', `${p.id}: every preset is a real video`);
  assert.ok(p.renditions.length >= 1 && p.duration > 0, `${p.id}: has files and a loop length`);
  for (const r of p.renditions) {
    assert.match(r.url, /^https:\/\/videos\.pexels\.com\/video-files\/\d+\/[\w-]+\.mp4$/, `${p.id}: MP4 on the provider CDN`);
    assert.ok([720, 1080, 1440, 2160].includes(r.height) && r.bytes > 0 && r.fps > 0, `${p.id}: rendition facts`);
  }
  assert.ok(p.renditions.some((r) => r.height === 720), `${p.id}: a light 720p file exists (preview / data saver)`);
  assert.match(p.poster, /^https:\/\/images\.pexels\.com\/videos\/\d+\//, `${p.id}: poster from the provider image CDN`);
  assert.equal(p.credit.provider, 'Pexels');
  assert.equal(p.credit.license, 'Pexels License');
  assert.match(p.credit.sourceUrl, /^https:\/\/www\.pexels\.com\/video\/[\w-]+\/$/, `${p.id}: links its source page`);
  assert.ok(p.credit.author.trim(), `${p.id}: names its author`);
  assert.match(p.accent, /^#[0-9a-f]{6}$/i);
  assert.ok(p.titleVi && p.titleEn && p.moodVi && p.moodEn, `${p.id}: vi + en copy`);
  assert.ok(catalog.WALLPAPER_COLLECTIONS.some((c) => c.id === p.collection), `${p.id}: known collection`);
}
assert.ok(new Set(presets.map((p) => p.collection)).size >= 4, 'presets span several moods');
ok(`catalog: ${presets.length} licensed, credited, real-video presets`);

// ─── 2. Rendition choice ──────────────────────────────────────────────────────────────────────────────
const coral = catalog.findPreset('coral-reef');
const desktop = { width: 1920, height: 1080, dpr: 1, constrained: false };
const retina = { width: 1440, height: 900, dpr: 2, constrained: false };
const phone = { width: 390, height: 844, dpr: 3, constrained: false };
assert.equal(media.pickRendition(coral, 'auto', desktop).height, 1080, '1080p screen → 1080p');
assert.equal(media.pickRendition(coral, 'auto', retina).height, 1440, 'retina laptop → 1440p');
assert.ok(media.pickRendition(coral, 'auto', phone).height <= 1080, 'phones stay at or below 1080p');
assert.equal(media.pickRendition(coral, 'saver', desktop).height, 720, 'data saver → 720p');
assert.equal(media.pickRendition(coral, 'auto', { ...desktop, constrained: true }).height, 720, 'Save-Data / slow network → 720p');
assert.equal(media.pickRendition(coral, 'max', desktop).height, 2160, 'highest → 4K where a light 4K file exists');
for (const p of presets) {
  for (const q of ['auto', 'saver', 'max']) {
    for (const s of [desktop, retina, phone]) {
      const r = media.pickRendition(p, q, s);
      assert.ok(media.mbps(r, p.duration) <= media.MAX_MBPS, `${p.id} ${q}: never above the bitrate cap`);
    }
  }
  assert.equal(media.previewRendition(p).height, 720, `${p.id}: the studio previews the 720p file`);
}
assert.equal(media.qualityLabel({ height: 2160 }), '4K');
ok('rendition choice: screen, density, data saver, bitrate cap');

// ─── 3. Learner links ─────────────────────────────────────────────────────────────────────────────────
const link = media.checkCustomLink;
assert.deepEqual(link('https://cdn.example.com/a/scene.MP4').ok && link('https://cdn.example.com/a/scene.MP4').kind, 'video');
assert.equal(link('https://cdn.example.com/a/scene.webp').kind, 'image');
assert.equal(link('https://cdn.example.com/a/scene').kind, 'unknown');
assert.equal(link('http://cdn.example.com/a.mp4').reason, 'not-https');
assert.equal(link('https://user:pass@cdn.example.com/a.mp4').reason, 'credentials');
for (const host of ['localhost', '127.0.0.1', '10.0.0.2', '192.168.1.4', '172.20.0.1', 'intranet', 'nas.local', '[::1]']) {
  assert.equal(link(`https://${host}/a.mp4`).reason, 'local', `local host refused: ${host}`);
}
assert.equal(link('javascript:alert(1)').reason, 'not-https');
assert.equal(link('not a link').reason, 'invalid');
assert.equal(link('').reason, 'empty');
assert.equal(link(`https://cdn.example.com/${'a'.repeat(2100)}.mp4`).reason, 'too-long');
const yt = link('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
assert.equal(yt.reason, 'youtube');
assert.equal(yt.youtubeId, 'dQw4w9WgXcQ');
assert.equal(link('https://youtu.be/dQw4w9WgXcQ').reason, 'youtube');
ok('learner links: HTTPS only, no credentials, no local hosts, YouTube recognised');

// ─── 3b. YouTube links: strict hosts, id only, every URL rebuilt from the id ──────────────────────────
const ytp = media.parseYouTubeLink;
const id = 'dQw4w9WgXcQ';
for (const url of [
  `https://www.youtube.com/watch?v=${id}`,
  `https://youtube.com/watch?v=${id}&list=PL123&index=2&si=abc`,
  `https://www.youtube.com/watch?app=desktop&v=${id}&t=42s`,
  `https://m.youtube.com/watch?v=${id}&feature=share`,
  `https://music.youtube.com/watch?v=${id}`,
  `https://youtu.be/${id}?si=Track_123&t=10`,
  `https://www.youtube.com/shorts/${id}?feature=share`,
  `https://www.youtube.com/live/${id}?si=x`,
  `https://www.youtube.com/embed/${id}?start=5`,
  `https://www.youtube-nocookie.com/embed/${id}`,
  `youtube.com/watch?v=${id}`,
  `youtu.be/${id}`,
  `  http://www.youtube.com/watch?v=${id}  `,
]) {
  assert.deepEqual({ ...ytp(url) }, { type: 'video', id }, `recognised: ${url}`);
}
assert.equal(ytp('https://www.youtube.com/playlist?list=PL123').type, 'playlist');
assert.equal(ytp('https://www.youtube.com/embed/videoseries?list=PL123').type, 'playlist');
assert.equal(link('https://www.youtube.com/playlist?list=PL123').reason, 'youtube-playlist');
for (const url of ['https://www.youtube.com/@channel', 'https://www.youtube.com/', 'https://www.youtube.com/watch?v=short', 'https://youtu.be/', `https://www.youtube.com/watch?v=${id}x`]) {
  assert.equal(ytp(url).type, 'no-video', `no video: ${url}`);
}
assert.equal(link('https://www.youtube.com/@channel').reason, 'youtube-no-video');
for (const url of [
  `https://www.youtube.com.evil.example/watch?v=${id}`,
  `https://youtube.com@evil.example/watch?v=${id}`,
  `https://evil.example/watch?v=${id}&host=youtube.com`,
  `https://notyoutube.com/watch?v=${id}`,
  `https://www.youtube.com:8443/watch?v=${id}`,
  `javascript:alert('youtube.com/watch?v=${id}')`,
  `ftp://youtube.com/watch?v=${id}`,
  'not a link',
  '',
]) {
  assert.equal(ytp(url), null, `not YouTube: ${url}`);
}
assert.deepEqual([...media.youtubeThumbnails(id)], [
  `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
  `https://i.ytimg.com/vi/${id}/sddefault.jpg`,
  `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
]);
assert.equal(media.youtubeEmbedUrl(id), `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`);
assert.throws(() => media.youtubeEmbedUrl('"><script>'), /invalid YouTube id/);
assert.throws(() => media.youtubeThumbnails('../../x'), /invalid YouTube id/);
ok('YouTube links: watch / youtu.be / shorts / live / embed / mobile; playlists and look-alike hosts refused');

// ─── 3c. "Video YouTube của tôi": kept with the account (server), never a wallpaper source, private per account ──
const ytSaved = load('lib/wallpaper/youtubeSaved.ts');
const lib = load('lib/wallpaper/youtubeLibrary.ts');
const keyA = store.accountKey(101), keyB = store.accountKey(202), keyGuest = store.accountKey('');
assert.equal(ytSaved.savedYouTubeKey(keyA), 'ec_wallpaper:v2:u101:youtube', 'former device list key (read once for the move)');
// The former device list of account A (bda0f11d…) moves into A's account once; B's and the guest's never do.
storage.set(ytSaved.savedYouTubeKey(keyA), JSON.stringify({ version: 1, items: [{ id, savedAt: 3 }, { id: 'jNQXAC9IVRw', savedAt: 2 }, { id: '"><img src=x>', savedAt: 9 }] }));
storage.set(ytSaved.savedYouTubeKey(keyGuest), JSON.stringify({ version: 1, items: [{ id: 'M7lc1UVf-VE', savedAt: 1 }] }));
assert.equal(ytSaved.readLegacySavedYouTube(keyGuest).length, 0, 'a guest list never enters an account');
await lib.loadLibrary(keyA);
assert.deepEqual(apiCalls.find((c) => c[0] === 'import'), ['import', id, 'jNQXAC9IVRw'], 'only A\'s valid ids are moved, newest first');
assert.equal(storage.has(ytSaved.savedYouTubeKey(keyA)), false, 'device copy removed after the server answered');
assert.ok(storage.has(ytSaved.savedYouTubeKey(keyGuest)), 'guest list untouched');
assert.deepEqual(lib.libraryFor(keyA).items.map((x) => x.videoId).sort(), [id, 'jNQXAC9IVRw'].sort());
assert.equal(lib.libraryFor(keyA).moved.imported, 2);
assert.equal(lib.libraryFor(keyB).items.length, 0, 'B never sees A\'s list (memory is tagged by account)');
assert.equal(lib.libraryFor(keyGuest).items.length, 0, 'the guest never sees A\'s list');
const callsBefore = apiCalls.length;
await lib.loadLibrary(keyGuest);
assert.equal(apiCalls.length, callsBefore, 'a guest makes no library request');
await lib.saveToLibrary(keyA, 'k2qgadSvNyU');
assert.equal(lib.libraryFor(keyA).items[0].videoId, 'k2qgadSvNyU', 'a save shows the server\'s entry first');
// A late answer for A after the switch to B is discarded.
const slow = lib.loadLibrary(keyA);
lib.clearWallpaperLibrary();
await slow;
assert.equal(lib.getLibraryState().owner, null, 'sign-out forgets the list; a late answer never restores it');
const libSrc = read('lib', 'wallpaper', 'youtubeLibrary.ts');
assert.ok(!/localStorage\.setItem|sessionStorage|indexedDB/.test(libSrc), 'the account list is never written to browser storage');
const apiSrc = read('services', 'wallpaperLibraryApi.ts');
assert.ok(apiSrc.includes("'/wallpaper/youtube-videos'") && !/userId|user_id|openrouter|\/ai\//i.test(apiSrc), 'API: account-scoped by the session, no user id, no AI');
assert.equal(store.normalizePreference({ source: 'custom', customUrl: `https://www.youtube.com/watch?v=${id}`, customKind: 'video' }).source, 'none', 'a YouTube URL is never a custom link');
// YouTube as the background (owner decision 2026-10-19): only the validated 11-character id is ever stored.
const ytPref = store.normalizePreference({ source: 'youtube', youtubeId: id, customUrl: 'https://evil.example/x.mp4' });
assert.equal(ytPref.source, 'youtube');
assert.equal(ytPref.youtubeId, id);
assert.equal(ytPref.customUrl, undefined, 'a YouTube preference carries the id only');
assert.equal(store.sourceKey(ytPref), `youtube:${id}`);
for (const bad of [`https://youtu.be/${id}`, 'videoseries', 'short', `${id}x`, '"><img>', null]) {
  assert.equal(store.normalizePreference({ source: 'youtube', youtubeId: bad }).source, 'none', `stored YouTube id re-validated: ${bad}`);
}
const cleanup = read('lib', 'auth-cache-cleanup.ts');
assert.ok(cleanup.includes('localStorage.clear()') && cleanup.includes('safely(clearWallpaperLibrary)') && !/ec_wallpaper/.test(cleanup), 'sign-out clears the in-memory list and every wallpaper key');
const hostSrc = read('components', 'wallpaper', 'WallpaperStudioHost.tsx');
assert.ok(hostSrc.includes('key={accountKey(userId)}') && hostSrc.includes('storageKey={accountKey(userId)}'), 'studio remounts per account');
// Device files (the learner's own copy of a video): per-account IndexedDB, bounded, never sent anywhere.
const devSrc = read('lib', 'wallpaper', 'deviceVideos.ts');
const dev = load('lib/wallpaper/deviceVideos.ts');
assert.equal(dev.deviceVideoDbName(101), 'ec-wallpaper-v1-u101');
assert.equal(dev.checkDeviceVideo({ name: 'clip.mp4', type: 'video/mp4', size: 10 }).ok, true);
assert.equal(dev.checkDeviceVideo({ name: 'x.exe', type: 'application/x-msdownload', size: 10 }).reason, 'type');
assert.equal(dev.checkDeviceVideo({ name: 'big.mp4', type: 'video/mp4', size: dev.MAX_DEVICE_VIDEO_BYTES + 1 }).reason, 'size');
assert.ok(!/fetch\(|XMLHttpRequest|@\/services|FormData|apiClient/.test(devSrc), 'device files: no network of any kind');
// The library preference: an attached direct link (re-validated) or a device file; never a YouTube URL or id.
const libPref = store.normalizePreference({ source: 'library', entryId: '7b3f1c2e-1d4a-4c5b-9e6f-0a1b2c3d4e5f', media: 'link', customUrl: 'https://media.example.org/ocean.mp4' });
assert.equal(libPref.source, 'library');
assert.equal(store.normalizePreference({ source: 'library', entryId: '7b3f1c2e-1d4a-4c5b-9e6f-0a1b2c3d4e5f', media: 'link', customUrl: `https://youtu.be/${id}` }).source, 'none', 'a YouTube link can never be the attached video');
assert.equal(store.normalizePreference({ source: 'library', entryId: 'not-a-uuid', media: 'file' }).source, 'none');
assert.match(store.sourceKey(store.normalizePreference({ source: 'library', entryId: '7b3f1c2e-1d4a-4c5b-9e6f-0a1b2c3d4e5f', media: 'file', fileStamp: 5 })), /^library:.*:file:5$/);
ok('YouTube library: server-kept per account, one-time move of the device list, private memory, own-video sources validated');

// ─── 4. Preferences: per account, re-validated ────────────────────────────────────────────────────────
assert.equal(store.accountKey(42), 'ec_wallpaper:v2:u42');
assert.equal(store.accountKey('a/b<c>'), 'ec_wallpaper:v2:uabc');
assert.equal(store.accountKey(''), 'ec_wallpaper:v2:guest');
const norm = store.normalizePreference;
assert.equal(norm({ source: 'preset', presetId: 'nope' }).source, 'none', 'unknown preset → default');
assert.equal(norm({ source: 'preset', presetId: 'aurora', clarity: 7 }).clarity, 1, 'clarity clamped');
assert.equal(norm({ source: 'custom', customUrl: 'http://x.example/a.mp4', customKind: 'video' }).source, 'none', 'stored http link rejected');
assert.equal(norm({ source: 'custom', customUrl: 'https://x.example/a.mp4' }).source, 'none', 'unverified custom kind rejected');
assert.equal(norm({ source: 'custom', customUrl: 'https://x.example/a.mp4', customKind: 'video' }).source, 'custom');
assert.equal(norm('garbage').source, 'none');
const key = store.accountKey(7);
store.writePreference(key, { ...store.DEFAULT_PREFERENCE, source: 'preset', presetId: 'nebula' });
assert.equal(store.currentPreference(key).presetId, 'nebula');
assert.equal(store.currentPreference(store.accountKey(8)).source, 'none', 'another account does not see it');
assert.equal(store.sourceKey(store.currentPreference(key)), 'preset:nebula');
ok('preferences: account-scoped key, stored values re-validated');

// ─── 5. Shell integration ─────────────────────────────────────────────────────────────────────────────
const sidebar = read('components', 'layout', 'Sidebar.tsx');
const topbar = read('components', 'layout', 'TopNavbar.tsx');
const accountMenu = read('components', 'layout', 'AccountMenu.tsx');
const frame = read('components', 'layout', 'ApplicationFrame.tsx');
assert.ok(sidebar.includes('data-testid="sidebar-wallpaper"') && sidebar.includes('aria-haspopup="dialog"'), 'sidebar entry opens a dialog');
assert.ok(sidebar.includes('vi ? "Giao diện" : "Appearance"'), 'sidebar label vi/en');
assert.ok(sidebar.includes('openWallpaperStudio()') && sidebar.includes('<RailTip label={wallpaperLabel} />'), 'opens the studio; collapsed-rail tooltip');
assert.ok(sidebar.includes('closeDrawerOnPhone(); openWallpaperStudio()'), 'phone drawer closes first');
assert.ok(!/useRef|useMemo/.test(sidebar), 'SidebarInner keeps no useRef / useMemo (King sidebar test)');
assert.ok(!/wallpaper/i.test(topbar) && !/wallpaper/i.test(accountMenu), 'no wallpaper trigger in the top bar or the account menu');
const workspaceBranch = frame.slice(frame.indexOf('flex h-screen overflow-clip'), frame.indexOf('export default function ApplicationFrame'));
assert.ok(frame.indexOf('flex h-screen overflow-clip') > frame.indexOf('isQuietRuntime || isLandingPreview || isPublicLanding || isAuthRoute'), 'the non-scrolling workspace frame comes after every excluded branch');
assert.equal((frame.match(/<WallpaperStage \/>/g) || []).length, 1, 'exactly one background engine');
assert.equal((frame.match(/<WallpaperStudioHost \/>/g) || []).length, 1, 'exactly one studio host');
// The one engine is one element (`background`), used by the workspace frame and, since 2026-11-02, by Không gian học tập (exclusive branches).
assert.ok(frame.slice(frame.indexOf('const background = ('), frame.indexOf('const isStudyTimer')).includes('<WallpaperStage />'), 'the background element holds the one engine');
assert.ok(workspaceBranch.includes('{!immersive && background}'), 'engine in the workspace frame (not while a world fills the window)');
assert.equal((frame.match(/\{background\}|\{!immersive && background\}/g) || []).length, 2, 'engine only in the workspace frame and Không gian học tập (not landing, auth, exam runtime, Garden, Quiz Rush)');
ok('shell: sidebar is the only entry; one engine, one studio host');

// ─── 6. Engine, studio and styles ─────────────────────────────────────────────────────────────────────
const stage = read('components', 'wallpaper', 'WallpaperStage.tsx');
const studio = read('components', 'wallpaper', 'WallpaperStudio.tsx');
const host = read('components', 'wallpaper', 'WallpaperStudioHost.tsx');
const stageCss = read('components', 'wallpaper', 'WallpaperStage.module.css');
const studioCss = read('components', 'wallpaper', 'WallpaperStudio.module.css');
const globals = read('app', 'globals.css');
const wallpaperSources = [stage, studio, host, read('lib', 'wallpaper', 'catalog.ts'), read('lib', 'wallpaper', 'media.ts'), read('lib', 'wallpaper', 'storage.ts'), read('lib', 'wallpaper', 'deviceVideos.ts')].join('\n');
assert.ok(!/Sparkles|✨|Wand/.test(wallpaperSources), 'no sparkle / wand icons');
assert.ok(!/@\/services|fetch\(|apiClient|openrouter/i.test(wallpaperSources), 'media, engine and studio make no server or AI call (the library store is the one API user)');
assert.ok(!/youtubeLibrary|wallpaperLibraryApi/.test(stage), 'the background engine never calls the library API (playback = 0 backend requests)');
// YouTube background (owner decision 2026-10-19, OpenQuiz-style): YouTube's own player, muted, looping, no control bar,
// driven only through the IFrame API message channel; never a stream, a download or a proxy.
const backdrop = read('components', 'wallpaper', 'YouTubeBackdrop.tsx');
assert.ok(!/<iframe/.test(stage) && stage.includes('<YouTubeBackdrop videoId={target.youtubeId}'), 'the engine embeds YouTube only through YouTubeBackdrop');
assert.equal((backdrop.match(/<iframe/g) || []).length, 1, 'one player per YouTube layer');
assert.ok(backdrop.includes('youtubeBackgroundUrl(videoId, window.location.origin)') && !/youtube(-nocookie)?\.com\/embed/.test(backdrop), 'the background player URL is rebuilt from the validated id only');
assert.ok(backdrop.includes('event.source !== frame.contentWindow || !YOUTUBE_PLAYER_ORIGINS.includes(event.origin)'), 'only the player\'s own messages are read');
assert.ok(!/contentDocument|iframe_api|<script|\.src\s*=/.test(backdrop), 'no third-party script and no reach into YouTube\'s frame');
assert.ok(/lastState === PLAYING && lastTime >= 0 && time > lastTime/.test(backdrop) && backdrop.includes("settle('timeout')") && backdrop.includes("'blocked'"), 'YouTube playback is claimed only from the player\'s advancing clock; errors and silence fail');
assert.ok(backdrop.includes(' inert>') && backdrop.includes('tabIndex={-1}') && backdrop.includes('allow="autoplay; encrypted-media"') && !/allowFullScreen|fullscreen/.test(backdrop), 'the background player takes no focus, click or key');
assert.ok(/\.ytFrame \{[^}]*width: max\(100cqw, 177\.78cqh\)[^}]*height: max\(100cqh, 56\.25cqw\)[^}]*pointer-events: none/.test(stageCss) && stageCss.includes('container-type: size'), 'the player covers the stage at 16:9 and never takes pointer input');
const bgUrl = new URL(media.youtubeBackgroundUrl(id, 'https://englishcoach.io.vn'));
assert.equal(bgUrl.origin + bgUrl.pathname, `https://www.youtube-nocookie.com/embed/${id}`);
for (const [k, v] of Object.entries({ autoplay: '1', mute: '1', controls: '0', loop: '1', playlist: id, playsinline: '1', enablejsapi: '1', origin: 'https://englishcoach.io.vn' })) {
  assert.equal(bgUrl.searchParams.get(k), v, `background player ${k}=${v}`);
}
assert.equal(new URL(media.youtubeBackgroundUrl(id, 'javascript:alert(1)')).searchParams.get('origin'), null, 'an odd origin is never passed on');
assert.throws(() => media.youtubeBackgroundUrl('"><script>', 'https://englishcoach.io.vn'), /invalid YouTube id/);
assert.ok(media.youtubeEmbedUrl(id) === `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`, 'the studio preview stays YouTube\'s player with its own controls and sound');
assert.ok(!/youtube-nocookie\.com\/embed\/\$\{/.test(studio) && studio.includes('src={youtubeEmbedUrl(stageYoutube)}'), 'the player URL is built only from the validated id');
assert.ok(/\{stageYoutube && youtubeOpen && \(\s*<iframe/.test(studio), 'the player loads only after the learner opens it');
assert.ok(studio.includes("(draft.source !== 'youtube' || (!!stageYoutube && draft.youtubeId === stageYoutube))") && studio.includes("(!stageYoutube || draft.source === 'youtube')"), 'a YouTube video is applied only while it is the one on the stage');
assert.ok(/draft\.source !== 'library' \|\| \(focus\.type === 'library' && customVerified === 'video'\)/.test(studio), 'an attached own video is applied only after its frames played on the stage');
assert.ok(studio.includes('data-testid="wallpaper-own-video-rights"') && /if \(bgRights && /.test(studio), 'attaching an own video needs the learner\'s rights confirmation');
assert.ok(studio.includes('{withApp && !stageYoutube && <AppMiniature') && studio.includes('{!youtubeOpen && ('), 'nothing is drawn over the open YouTube player');
assert.ok(studio.includes('data-testid="wallpaper-youtube-card"') && studio.indexOf("['link',") < studio.indexOf('...WALLPAPER_COLLECTIONS.map'), 'YouTube entry is a card in "Tất cả" and the second tab');
assert.ok(!/youtube\.com|youtu\.be|ytimg|https?:/i.test(read('lib', 'wallpaper', 'storage.ts')) && read('lib', 'wallpaper', 'storage.ts').includes('isYouTubeId(value.youtubeId)'), 'a YouTube choice is stored as a validated id, never a URL');
assert.ok(stage.includes("video.removeAttribute('src')") && stage.includes('video.load()'), 'a removed layer releases its decoder');
assert.ok(stage.includes('video.currentTime > 0 && !video.paused'), 'playback is proven by advancing time');
assert.ok(stage.includes("'visibilitychange'") && stage.includes('prefers-reduced-motion'), 'hidden tab pauses; reduced motion → still');
assert.ok(stage.includes('READY_TIMEOUT_MS') && stage.includes("fail('timeout')") && stage.includes("state: 'failed'"), 'failures are bounded and reported');
assert.ok(!stage.includes('crossOrigin'), 'no CORS requirement on media');
assert.ok(stage.includes('URL.revokeObjectURL(objectUrl)') && stage.includes("fail('missing')"), 'device files: blob URL released with the layer; a missing file fails cleanly');
assert.ok(!/backdrop-filter/.test(stageCss), 'no blur over the wallpaper');
assert.ok(/:global\(\.dark\) \.veil/.test(stageCss), 'veil follows the explicit dark class');
assert.ok(!/has-custom-wallpaper|ec-wallpaper-layer/.test(globals), 'old global overrides removed');
const ruleStart = globals.indexOf('html[data-wallpaper] main[data-app-scroll],');
const glassStart = globals.indexOf('html[data-wallpaper]:not(.dark) main[data-app-scroll] :is(');
const block = globals.slice(ruleStart, globals.indexOf('}', ruleStart) + 1);
const glass = globals.slice(glassStart, globals.indexOf('}', glassStart) + 1);
assert.equal((globals.match(/html\[data-wallpaper\]/g) || []).length, 5, 'global wallpaper rules: page shells, light glass cards, reading plate (+ its pseudo-element)');
assert.ok(block.includes('html[data-wallpaper] main[data-app-scroll]') && !/!important|backdrop-filter|opacity/.test(block), 'surface rule: transparent page shells only, no !important, no blur');
assert.ok(glassStart > 0 && !/!important|backdrop-filter/.test(glass) && !/\[class\*=/.test(glass), 'glass rule: exact class tokens only, no !important, no blur');
assert.ok(!/bg-white\/(10|15|20|25)"/.test(glass), 'never the chips of dark heroes');
assert.ok(studio.includes('role="dialog"') && studio.includes('aria-modal="true"') && studio.includes("event.key === 'Escape'"), 'studio is an accessible modal dialog');
assert.ok(studio.includes('setBackgroundHeld(true)'), 'background pauses while the studio previews');
assert.ok(/prefers-reduced-motion: reduce/.test(studioCss) && /max-width: 920px/.test(studioCss), 'studio: reduced motion + phone layout');
assert.ok(host.includes("dynamic(() => import('./WallpaperStudio')"), 'studio code loads on demand');
ok('engine + studio: proven playback, bounded failures, no blur, accessible, lazy');

// ─── 6b. Light mode: thin veil (scenes keep their colour), local reading plates (text keeps its contrast) ──
const veilLight = stageCss.slice(stageCss.indexOf('.veil {'), stageCss.indexOf('}', stageCss.indexOf('.veil {')));
const alphaAt = (clarity) => Math.min(0.34, Math.max(0.04, 0.3 - 0.3 * clarity));
assert.ok(veilLight.includes('--wp-a: clamp(0.04, calc(0.3 - 0.3 * var(--wp-clarity, 0.6)), 0.34)'), 'light veil formula');
assert.ok(alphaAt(0.6) <= 0.12 + 1e-9 && alphaAt(0) <= 0.34, 'light veil stays thin: 0.12 at the default clarity, ≤ 0.34 at the calmest');
const plateStart = globals.indexOf('html[data-wallpaper] main[data-app-scroll] .ec-wp-plate::before {');
const plate = globals.slice(plateStart, globals.indexOf('}', plateStart) + 1);
assert.ok(plateStart > 0 && /z-index: -1/.test(plate) && /pointer-events: none/.test(plate) && !/!important|backdrop-filter|filter:/.test(plate), 'plate: behind the text, never catches the pointer, no blur / filter / !important');
assert.ok(!/ec-wp-plate[^{]*\{[^}]*(margin|padding)/.test(globals), 'plate never changes layout (no margin / padding)');
assert.ok(/html\.dark\[data-wallpaper\] main\[data-app-scroll\] \.ec-wp-plate::before \{\s*background-color: rgb\(var\(--surface\)\);/.test(globals), 'dark plate = the app surface (text keeps its plain-app contrast)');
const darkStart = globals.indexOf('html.dark[data-wallpaper] main[data-app-scroll] :is(');
const dark = globals.slice(darkStart, globals.indexOf('}', darkStart) + 1);
assert.ok(darkStart > 0 && /:not\(\.fixed, \.absolute, \[class\*="bg-gradient"\]/.test(dark) && !/!important|backdrop-filter/.test(dark) && !/\[class\*="dark/.test(dark), 'dark cards: exact tokens, overlays / positioned / gradient layers excluded, no blur, no !important');
assert.ok(!/dark:bg-black\//.test(dark) && !/dark:bg-white\/(10|15|20)"/.test(dark), 'never modal backdrops or the white chips of heroes');
for (const t of ['dark:bg-gray-800/80', 'dark:bg-indigo-950/30', 'dark:bg-white/[0.03]', 'dark:bg-[#0e1729]/70']) assert.ok(dark.includes(`[class~="${t}"]`) && globals.includes(`[class~="${t}"] { --ec-wp-tint:`), `measured dark failure covered: ${t}`);
for (const [file, label] of [
  [['components', 'dashboard', 'DashboardSectionHeader.tsx'], 'dashboard section headers'],
  [['components', 'features', 'reading', 'ReadingDashboard.tsx'], 'Reading library heading'],
  [['components', 'features', 'speaking', 'SpeakingPracticeModes.tsx'], 'Speaking modes heading'],
  [['components', 'features', 'speaking', 'ContinuePracticeCard.tsx'], 'Speaking continue heading'],
  [['app', 'listening', 'page.tsx'], 'Listening library lead'],
  [['components', 'features', 'exams', 'ExamPracticeRecommendations.tsx'], 'Exams suggestions'],
  [['components', 'features', 'leaderboard', 'ProficiencyBoardTab.tsx'], 'Leaderboard hint (Năng lực; the Thi đua hint sits in its period card)'],
  [['components', 'features', 'games', 'GamesHub.tsx'], 'Games Hub library heading'],
  [['components', 'features', 'exams', 'ExamsHome.tsx'], 'Exams "Bạn muốn luyện gì?"'],
  [['components', 'common', 'AuthRequired.tsx'], 'signed-out gate "Đăng nhập để tiếp tục"'],
  [['components', 'common', 'AuthGuard.tsx'], 'sign-in check "Đang kiểm tra đăng nhập…"'],
]) {
  assert.ok(read(...file).includes('ec-wp-plate'), `${label} carry the reading plate`);
}
ok('light mode: thin veil, local reading plates (no layout change, no blur)');

// ─── 7. Edge policy still admits the media and the visible YouTube player ─────────────────────────────
const nginx = fs.readFileSync(path.join(frontend, '..', 'deploy', 'nginx', 'default.conf'), 'utf8');
const csp = nginx.match(/Content-Security-Policy "([^"]+)"/)[1];
assert.match(csp, /media-src [^;]*https:/, 'media-src admits HTTPS media');
assert.match(csp, /img-src [^;]*https:/, 'img-src admits HTTPS posters');
assert.match(csp, /frame-src [^;]*https:\/\/www\.youtube-nocookie\.com/, 'frame-src admits the privacy-enhanced YouTube player');
ok('CSP compatible without any change');

console.log(`--- Hình nền: ${passed} contract groups passed ---`);
