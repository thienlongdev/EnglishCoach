// My Books contracts (2026-10-16): the second Reading tab, lazy and local-first; book content never leaves the
// device; selection is passive; the ZIP reader refuses traversal / bombs / encryption; TXT decoding; one book face.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { deflateRawSync, crc32 } from 'node:zlib';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const read = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
function evaluate(path, dependencies = {}) {
  const { code } = babel.core().transformSync(read(path), { filename: path, configFile: false, babelrc: false,
    presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()] });
  const exports = {};
  runInNewContext(code, { exports, require: (p) => dependencies[p] ?? require(p), Blob, TextDecoder, TextEncoder, DecompressionStream, DataView, Uint8Array, ArrayBuffer, Map, Set, Math, Number, String, Error, Promise, console }, {});
  return exports;
}

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; };

// ── Reading integration ──
await check('My Books is the second of four Reading tabs and loads lazily', () => {
  const dash = read('components/features/reading/ReadingDashboard.tsx');
  const ids = [...dash.slice(dash.indexOf('const tabs:'), dash.indexOf('];', dash.indexOf('const tabs:'))).matchAll(/\{ id: "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['library', 'mybooks', 'bilingual', 'speed']);
  assert.match(dash, /const MyBooksTab = dynamic\(\(\) => import\("\.\/books\/MyBooksTab"\), \{\s*ssr: false/);
  assert.doesNotMatch(dash, /from ["']\.\/books\//, 'no static import of the My Books module in the Reading entry');
  assert.match(dash, /savedTab === "mybooks"/, 'the remembered tab includes My Books');
  const tab = read('components/features/reading/books/MyBooksTab.tsx');
  assert.match(tab, /const BookReader = dynamic\(\(\) => import\("\.\/BookReader"\)/, 'the reader engines load only when a book opens');
  const reader = read('components/features/reading/books/BookReader.tsx');
  assert.match(reader, /await import\("\.\/engine\/pdf"\)/, 'PDF.js loads only for a PDF');
  assert.doesNotMatch(reader, /^import (?!type)[^;]*from "\.\/engine\/pdf"/m);
  const pdf = read('components/features/reading/books/engine/pdf.ts');
  assert.doesNotMatch(pdf, /^import (?!type)[^;]*from "pdfjs-dist"/m, 'pdfjs-dist is imported dynamically');
  assert.match(pdf, /import\("pdfjs-dist"\)/);
  assert.match(pdf, /new Worker\(new URL\("pdfjs-dist\/build\/pdf\.worker\.min\.mjs", import\.meta\.url\)/);
  assert.match(pdf, /enableXfa: false/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.devDependencies['pdfjs-dist'], '6.3.289', 'exact, post-advisory PDF.js; bundled at build time only');
});

// ── privacy: books never leave the device ──
await check('engine, store and import code make no network request', () => {
  const dir = new URL('../src/components/features/reading/books/', import.meta.url);
  const walk = (u) => readdirSync(u, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(e.name + '/', u)) : [new URL(e.name, u)]));
  for (const url of walk(dir)) {
    const name = url.pathname.split('/books/')[1];
    const text = readFileSync(url, 'utf8');
    assert.doesNotMatch(text, /<iframe|srcdoc|\.innerHTML\s*=|dangerouslySetInnerHTML|insertAdjacentHTML/, `${name}: no frames or markup sinks`);
    if (/^(engine|store)\//.test(name)) assert.doesNotMatch(text, /apiClient|(?<![\w.])fetch\(|XMLHttpRequest|sendBeacon|WebSocket/, `${name}: local only`);
  }
  const api = read('services/readingBooksApi.ts');
  assert.match(api, /"\/reading\/books\/explain-selection"/);
  for (const field of ['text', 'sentence', 'context', 'bookTitle', 'bookAuthor']) assert.match(api, new RegExp(`${field}: body\\.${field}\\??\\.slice\\(0, \\d+\\)`), `${field} is bounded`);
});

await check('selecting text makes no request: tools run only from explicit clicks', () => {
  const tools = read('components/features/reading/books/SelectionTools.tsx');
  const effects = tools.split('useEffect(').slice(1).map((chunk) => chunk.slice(0, Math.min(...['}, [', '[]);'].map((end) => (chunk.indexOf(end) < 0 ? chunk.length : chunk.indexOf(end))))));
  assert.ok(effects.length >= 2 && effects.every((body) => body.length < 1200), 'effects were found and bounded');
  for (const body of effects) assert.doesNotMatch(body, /explainBookSelection|googleTranslate|lookupDictionary|createFlashcard/);
  assert.match(tools, /onClick=\{\(\) => void runAi\(\)\}/);
  assert.match(tools, /onClick=\{\(\) => void runTranslate\(\)\}/);
  assert.match(tools, /BrandWhaleIcon/, 'the AI action carries the Echo Whale icon');
  assert.doesNotMatch(tools, /Sparkles|✨/);
  const flow = read('components/features/reading/books/engine/flow.ts');
  assert.match(flow, /attachShadow\(\{ mode: "open" \}\)/, 'book content is isolated in a shadow root');
  const css = read('components/features/reading/books/engine/readerCss.ts');
  assert.match(css, /:host \{ all: initial;/);
});

await check('selection cards follow the live text; the Flashcard editor outlives the selection', () => {
  const tools = read('components/features/reading/books/SelectionTools.tsx');
  // a re-reported selection (same words + sentence) never resets an open tool; an open editor is never replaced
  assert.match(tools, /if \(anchor && sameSelection\(selection, anchor\)\) \{ setAnchor\(selection\); return; \}/);
  assert.match(tools, /if \(tool && EDITORS\.has\(tool\.kind\)\) return;/);
  assert.match(tools, /new Set<Tool\["kind"\]>\(\["flashcard", "note"\]\)/);
  // anchored to the live range, editors keep their place when the text goes; one save at a time
  assert.match(tools, /useAnchoredFloating\(\{ open: !mobile, floating: ref, anchor: \(\) => liveRect\(anchor\), onLost: editor \? undefined :/);
  assert.match(tools, /if \(savingRef\.current \|\| tool\?\.kind !== "flashcard"/);
  assert.doesNotMatch(tools, /useAnchor\(|window\.innerHeight \* 0\.7/, 'no position frozen at selection time');
  for (const engine of ['flow', 'pdf']) assert.match(read(`components/features/reading/books/engine/${engine}.ts`), /anchor: range\.cloneRange\(\) \}\);/);
  // Reading: placed from the live range inside the reading column, never from window scroll coordinates
  const reader = read('components/features/reading/InteractiveReader.tsx');
  assert.match(reader, /anchor: \(\) => rangeRect\(selectionRangeRef\.current\),\s+bounds: \(\) => visibleBox\(scrollContainerRef\.current\)/);
  assert.doesNotMatch(reader, /style=\{\{ top: selection\.top, left: selection\.left/);
  const lib = read('lib/ui/anchoredFloating.ts');
  assert.match(lib, /const side: Placement\["side"\] = size\.h <= below \|\| below >= above \? "below" : "above";/);
});

await check('sanitizer drops active content and external resources', () => {
  const s = read('components/features/reading/books/engine/sanitize.ts');
  for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base', 'frame', 'template', 'canvas']) assert.match(s, new RegExp(`"${tag}"`));
  assert.match(s, /name\.startsWith\("on"\)/, 'event attributes are dropped');
  assert.match(s, /FORBIDDEN_VALUE = \/url\\s\*\\\(\|expression\\s\*\\\(\|javascript:/);
  assert.match(s, /foreignobject/);
  assert.match(s, /parts\.push\(s\.startsWith\("\.ec-body"\) \? s : `\.ec-body \$\{s\}`\)/, 'publisher selectors are scoped to the book body');
});

// ── whole-book page numbers ──
await check('page index: whole-book and chapter numbers only from counted files', () => {
  const { PageIndex } = evaluate('components/features/reading/books/engine/pageIndex.ts', { './columns': {}, './readerCss': { READER_CSS: '' }, './text': {} });
  const plain = (x) => JSON.parse(JSON.stringify(x)); // values from the evaluation realm
  const index = new PageIndex('sig', 4);
  assert.equal(index.total, null, 'nothing is claimed before counting');
  index.record(0, { pages: 3, starts: [0] }, false);
  index.record(1, { pages: 5, starts: [2] }, false);
  assert.equal(index.complete, false);
  assert.equal(index.base(1), 3);
  assert.equal(index.base(3), null, 'a file not counted yet leaves later pages unknown');
  assert.deepEqual(plain(index.chapterSpan(1, 1)), { start: -3, end: 2 }, 'a chapter that began in an earlier file');
  assert.equal(index.chapterSpan(1, 3), null, 'its end lies in a file not counted yet');
  index.record(2, { pages: 4, starts: [] }, false);
  index.record(3, { pages: 2, starts: [0] }, false);
  assert.equal(index.total, 14);
  assert.deepEqual(plain(index.chapterSpan(2, 3)), { start: -3, end: 4 }, 'a chapter spanning three files (7 pages)');
  assert.deepEqual(plain(index.chapterSpan(3, 1)), { start: 0, end: 2 }, 'the last chapter ends with the book');
  index.record(2, { pages: 4, starts: [] }, true);
  assert.equal(index.corrections, 0, 'the visible layout agreeing with the count is not a correction');
  index.record(2, { pages: 5, starts: [] }, true);
  assert.equal(index.corrections, 1);
  assert.equal(index.total, 15, 'the visible layout wins');
  index.failed = true;
  assert.equal(index.total, null, 'an unreadable file means no whole-book claim');
  const flow = read('components/features/reading/books/engine/flow.ts');
  assert.match(flow, /\[PAGE_INDEX_VERSION, this\.envKey, L\.Pw, L\.H, L\.gap, hashKey\(font\), metric, p\.fontSize, p\.lineHeight, p\.justify \? 1 : 0, p\.hyphenate \? 1 : 0, this\.flow\?\.lang \?\? ""\]/, 'one index per layout signature');
  const reader = read('components/features/reading/books/BookReader.tsx');
  assert.match(reader, /không phải số trang của bản in/, 'layout pages are never presented as printed page numbers');
  assert.match(reader, /đang đếm số trang cả sách/, 'an honest pending state while counting');
});

await check('page index cache: restored counts are checked by the real layout and stored without blocking reading', () => {
  const { PageIndex, hashKey } = evaluate('components/features/reading/books/engine/pageIndex.ts', { './columns': {}, './readerCss': { READER_CSS: '' }, './text': {} });
  const stored = [{ pages: 3, starts: [0] }, { pages: 5, starts: [2] }, null, { pages: 2, starts: [0] }];
  const a = new PageIndex('sig', 4);
  assert.equal(a.restore(stored), true);
  assert.equal(a.complete, false, 'a partly counted stored index stays partial');
  assert.equal(a.dirty, false, 'restoring writes nothing back');
  a.record(0, { pages: 3, starts: [0] }, true);
  assert.equal(a.invalidated, false, 'the real layout confirming a stored count keeps the index');
  a.record(2, { pages: 4, starts: [] }, false);
  assert.equal(a.total, 14);
  assert.equal(a.dirty, true, 'a newly counted file is stored');
  const b = new PageIndex('sig', 4);
  b.restore(stored);
  b.record(1, { pages: 6, starts: [2] }, true);
  assert.equal(b.invalidated, true, 'a stored count the real layout contradicts drops the stored index');
  assert.equal(b.counts[0], undefined, 'every unchecked restored count is dropped');
  assert.equal(b.counts[3], undefined);
  assert.equal(b.counts[1].pages, 6, 'the real layout is kept');
  assert.equal(b.total, null, 'nothing whole-book is claimed until counted again');
  assert.equal(new PageIndex('sig', 3).restore(stored), false, 'a stored index for other files is refused');
  assert.equal(new PageIndex('sig', 1).restore([{ pages: 2, starts: [3] }]), false, 'an impossible chapter start is refused');
  assert.equal(new PageIndex('sig', 1).restore([{ pages: 0, starts: [] }]), false);
  assert.equal(hashKey('a'), hashKey('a'));
  assert.notEqual(hashKey('a'), hashKey('b'));

  const flow = read('components/features/reading/books/engine/flow.ts');
  assert.match(flow, /index\.persist = Boolean\(this\.pageCache\) && !sig\.includes\("\|\?\|"\)/, 'a layout whose face is not measured is never restored or stored');
  assert.match(flow, /if \(index\.invalidated\) \{[\s\S]{0,200}this\.pageCache\?\.drop\(index\.signature\);[\s\S]{0,40}this\.scheduleCounting\(900\);/, 'a contradicted stored index is dropped and the book counted again');
  assert.match(flow, /if \(this\.turning \|\| this\.drag \|\| this\.down \|\| performance\.now\(\) - this\.lastInput < 700\) \{ this\.scheduleIndexSave\(1000\); return; \}/, 'no cache write during a turn, drag or input');
  const show = flow.slice(flow.indexOf('    private show(page: number) {'), flow.indexOf('    private updateRunning() {'));
  assert.doesNotMatch(show, /useIndex|scheduleCounting|saveIndex|scheduleIndexSave|measure\(\)/, 'showing a page never touches the whole-book index');
  const setPrefs = flow.slice(flow.indexOf('    setPrefs(prefs: ReaderPrefs) {'), flow.indexOf('    private async relayout('));
  assert.doesNotMatch(setPrefs, /before\.theme !== prefs\.theme/, 'a theme change is not a relayout (the index is kept)');
  const cache = read('components/features/reading/books/store/pageCache.ts');
  assert.match(cache, /record\.fp !== meta\.fingerprint/, 'a record made for another file is ignored');
  assert.match(cache, /const MAX_LAYOUTS = 6;/, 'bounded per book');
  assert.doesNotMatch(cache, /fetch\(|XMLHttpRequest|sendBeacon/, 'the cache stays on the device');
  const store = read('components/features/reading/books/store/bookStore.ts');
  assert.match(store, /tx\.objectStore\("prefs"\)\.delete\(BookStore\.pageCacheKey\(id\)\);/, 'removing a book removes its stored page indexes');
  assert.match(store, /const VERSION = 1;/, 'no database version change: a rolled-back reader still opens the library');
  const backup = read('components/features/reading/books/store/backup.ts');
  assert.doesNotMatch(backup, /pageCache|pages:/, 'page indexes are derived data, not part of a backup');
  const reader = read('components/features/reading/books/BookReader.tsx');
  assert.match(reader, /persistent\.current && store && meta\.format !== "pdf" \? openPageCache\(store, meta\)/, 'only library books are cached ("Đọc ngay" leaves nothing behind)');
});

await check('background counting never holds the reader: idle slots, pieces, proofs, sliced loads', () => {
  const pi = read('components/features/reading/books/engine/pageIndex.ts');
  assert.match(pi, /export const PAGE_INDEX_VERSION = 2;/, 'chapter starts by first visible character: stored indexes of version 1 are counted again');
  const counter = pi.slice(pi.indexOf('export class PageCounter'));
  assert.ok((counter.match(/await this\.slot\(gen\);/g) || []).length >= 3, 'every file and every piece waits for an idle moment of the reader');
  assert.match(counter, /if \(!this\.busy\(\) && !inputPending\(\)\) return;/, 'waiting input always goes first');
  assert.match(counter, /this\.source\.loadChapter\(s, \(\) => this\.pause\(gen\)\)/, 'chapters are loaded in slices');
  assert.match(counter, /this\.flow\.setAttribute\("data-ec-wait", ""\);/, 'no frame lays a waiting chapter out');
  assert.match(counter, /if \(proof && !this\.proves\(cols, proof, pad\)\) \{/, 'a piece start is used only when proven');
  assert.match(counter, /rejected\.add\(from\);/, 'a start that does not prove out is never used');
  assert.match(counter, /return this\.countWhole\(gen, root, full, targets, geo\);/, 'content without a provable start is laid out whole (old behaviour)');
  assert.match(counter, /if \(await faceWasMissing\(\)\) continue;/, 'a layout made with a stand-in face is measured again');
  assert.match(pi, /export function nextSlice\(priority: "background" \| "user-visible" = "background"\)/, 'counting slices yield at background priority');
  assert.match(pi, /const MIN_PIECE = 6_000;/);
  assert.match(pi, /function pageHead\(cols: Columns, page: number\): number \{/, 'chapter starts use the first character shown on a page');
  const s = read('components/features/reading/books/engine/sanitize.ts');
  assert.match(s, /export function sanitizeBody\(body: Element, ctx: SanitizeContext\): SanitizedChapter \{\s*const run = rebuild\(body, ctx\);/, 'one rebuild for both');
  assert.match(s, /export async function sanitizeBodyInSlices\([\s\S]{0,160}?\): Promise<SanitizedChapter> \{\s*const run = rebuild\(body, ctx\);/);
  const flow = read('components/features/reading/books/engine/flow.ts');
  assert.match(flow, /const INPUT_EVENTS = \["pointerdown", "keydown", "wheel", "touchstart"\] as const;/, 'any input keeps background work away');
  assert.match(flow, /this\.lastRelocate = info;\s*if \(this\.turning\) \{ this\.relocatePending = true; return; \}/, 'the reader UI update waits until the page has turned');
  assert.match(flow, /this\.source\.loadChapter\(s, \(\) => \(urgent\.on \? Promise\.resolve\(\) : nextSlice\("user-visible"\)\)\)/, 'the next chapter is prefetched in slices');
  assert.match(flow, /if \(this\.drag\) \{ this\.drag\.flip\?\.destroy\(\); this\.drag = null; this\.turning = false; \}/, 'a cancelled drag never leaves the reader stuck turning');
});

await check('page turn: exact page copies, instant turn when a copy cannot be exact', () => {
  const flow = read('components/features/reading/books/engine/flow.ts');
  assert.match(flow, /if \(!this\.fitCopy\(copy, p, content, flow\)\) this\.inexact = true;/);
  assert.match(flow, /if \(this\.inexact\) \{ this\.overlay\.replaceChildren\(\); return null; \}/, 'an inexact copy never folds');
  assert.match(flow, /if \(this\.flow\.lang\) flow\.lang = this\.flow\.lang;/, 'copies hyphenate like the page');
  assert.match(flow, /data-ec-ph/, 'sibling placeholders keep the book CSS selectors matching');
  const flip = read('components/features/reading/books/engine/pageFlip.ts');
  assert.doesNotMatch(flip, /willChange = "transform/, 'no promoted layer: text keeps its weight when the real page takes over');
  const css = read('components/features/reading/books/engine/readerCss.ts');
  assert.match(css, /\.ec-flow\.ec-paged > \.ec-pad \{ break-before: column;/, 'a spread can reach a chapter\'s last left-hand page');
  assert.match(css, /:is\(div, figure, section, article, aside, header, footer, blockquote, p, ul, ol, dl, pre\) \{ max-width: 100%; \}/, 'no picture box runs off the page');
});

// ── ZIP reader ──
const zipMod = evaluate('components/features/reading/books/engine/zip.ts');
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = Buffer.from(e.data);
    const data = e.method === 0 ? raw : deflateRawSync(raw);
    const size = e.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(e.flags ?? 0, 6); local.writeUInt16LE(e.method, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(e.flags ?? 0, 8); cen.writeUInt16LE(e.method, 10);
    cen.writeUInt32LE(crc32(raw), 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(size, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, name, data); central.push(cen, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Blob([...parts, cd, end]);
}

await check('ZIP: reads stored + deflated entries; ignores traversal names', async () => {
  const blob = zip([
    { name: 'mimetype', method: 0, data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', method: 8, data: '<container>Xin chào — sách</container>' },
    { name: '../evil.txt', method: 0, data: 'x' },
    { name: '/abs/path.txt', method: 0, data: 'y' },
  ]);
  const archive = await zipMod.ZipArchive.open(blob);
  assert.equal(await archive.readText('mimetype'), 'application/epub+zip');
  assert.equal(await archive.readText('META-INF/container.xml'), '<container>Xin chào — sách</container>');
  assert.equal(archive.has('../evil.txt') || archive.has('evil.txt'), false);
  assert.equal(archive.has('abs/path.txt'), true, 'an absolute name is re-rooted inside the archive, never outside');
  assert.equal(zipMod.normalizeZipPath('OEBPS/../../etc/passwd'), null);
  assert.equal(zipMod.normalizeZipPath('OEBPS/text/../images/a.png'), 'OEBPS/images/a.png');
  const sliced = await archive.readBlob('mimetype', 'text/plain');
  assert.equal(await sliced.text(), 'application/epub+zip', 'stored entries are sliced, not copied');
});

await check('ZIP: refuses bombs, lying sizes and encrypted entries', async () => {
  await assert.rejects(zipMod.ZipArchive.open(zip([{ name: 'bomb.xhtml', method: 8, data: Buffer.alloc(40 * 1024 * 1024) }])), (e) => e.code === 'ZIP_BOMB');
  const liar = await zipMod.ZipArchive.open(zip([{ name: 'a.xhtml', method: 8, data: 'z'.repeat(5000), declaredSize: 10 }]));
  await assert.rejects(liar.read('a.xhtml'), (e) => e.code === 'ZIP_BOMB');
  const locked = await zipMod.ZipArchive.open(zip([{ name: 'a.xhtml', method: 0, data: 'secret', flags: 1 }]));
  await assert.rejects(locked.read('a.xhtml'), (e) => e.code === 'ENCRYPTED');
  await assert.rejects(zipMod.ZipArchive.open(new Blob(['%PDF-1.7 not a zip at all, padded to be long enough'])), (e) => e.code === 'NOT_ZIP');
});

// ── TXT ──
const txt = evaluate('components/features/reading/books/engine/txt.ts', { './zip': zipMod });
await check('TXT: encodings, binary rejection, headings, bounded sections', () => {
  assert.equal(txt.decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('Chương một')])), 'Chương một');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Đọc sách', 'utf16le')]);
  assert.equal(txt.decodeText(new Uint8Array(utf16)), 'Đọc sách');
  assert.equal(txt.decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9])), 'café', 'invalid UTF-8 falls back to a single-byte code page');
  assert.equal(txt.looksBinary(new Uint8Array([0x25, 0x50, 0x00, 0x01])), true);
  const body = ['Chapter 1', '', 'It was a bright cold day in April.', '', 'Chapter 2', '', 'The clocks were striking thirteen.'].join('\n')
    + '\n\n' + Array.from({ length: 400 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(60)).join('\n\n');
  const source = new txt.TxtSource('Test', '', body);
  assert.ok(source.spine.length >= 2, 'long text is split into bounded sections');
  assert.deepEqual(Array.from(source.toc.slice(0, 2), (t) => t.label), ['Chapter 1', 'Chapter 2']);
  assert.ok(source.spine.every((s) => s.weight > 0));
});

// ── backend contract ──
await check('frontend ContextTranslation mirrors the backend response record', () => {
  const back = readFileSync(new URL('../../backend/src/main/java/com/englishcoach/reading/dto/ContextTranslationResponse.java', import.meta.url), 'utf8');
  const fields = [...back.slice(back.indexOf('record ContextTranslationResponse('), back.indexOf(') {')).matchAll(/String (\w+)/g)].map((m) => m[1]);
  const front = read('types/readingBooks.ts');
  const shape = front.slice(front.indexOf('interface ContextTranslation'));
  for (const f of fields) assert.match(shape, new RegExp(`\\b${f}:`), f);
  const request = readFileSync(new URL('../../backend/src/main/java/com/englishcoach/reading/dto/BookSelectionExplainRequest.java', import.meta.url), 'utf8');
  assert.match(request, /@Size\(max = 300[^)]*\)\s*String text/);
  assert.match(request, /@Size\(max = 1200[^)]*\)\s*String sentence/);
});

console.log(`My Books: PASS (${passed} groups — 2nd Reading tab, lazy engines, local-only book data, passive selection, sanitizer, page index, background counting, exact page copies, ZIP guards, TXT, API contract).`);
