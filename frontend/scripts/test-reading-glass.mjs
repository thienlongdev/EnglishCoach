// Reading "Echo Glass" contracts (owner brief 2026-10-23, 10 §AO): presentation only around frozen engines.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const R = 'components/features/reading/';
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  -> PASS: ${name}`); };

// The approved My Books reader is FROZEN (engine, storage, typography, pagination, settings, reader UI): byte-pinned at the
// state the owner approved. Only the shelf (MyBooksTab.tsx) may change for presentation. Changing one of these files is an
// owner decision: update the pin in the same change and say so in the report. Re-pinned 2026-10-25 (owner brief: anchored
// selection cards + an independent Flashcard editor): BookReader / SelectionTools / engine flow + pdf (selection live range).
// Re-pinned 2026-10-30 (owner rule: no "&" in display copy): BookReader / ReaderPanels panel titles only ("và" / "and").
// 2026-11-12 RESTORED: an "Echo AI" toolbar button had been added to SelectionTools and re-pinned without a recorded owner
// decision; the release-candidate validation removed it. The file is byte-identical again to the last shipped, approved state
// (e2c97e8d…). A My Books entry to Echo AI Card Studio needs an explicit owner decision to change this frozen file.
const FROZEN = {
  'BookReader.tsx': 'f0bb1da6adf4faf9c7d6abe3716acbaaadb661e4083187638afbb0001eecd7e2',
  'ReaderPanels.tsx': 'f98d10df392342463763063532dde4e80d9d5d1ced416cde1cc2bcf958eb4521',
  'SelectionTools.tsx': 'e2c97e8d5350e9a026b8f745fcece35f806fa90e671f09973167c411bbfc939f',
  'engine/columns.ts': '661e8bb1a764cded7e7883a30e8265f87471386da6cc6ee94be7e52dde681326',
  'engine/epub.ts': '9bb1052fec138513e2c908042b458aafd7b2b95c596fbc8a5cb63672a269c61e',
  'engine/flow.ts': 'f08b80870624e68a864dba5010c24dfeebc7d172b212c06b0026ddc2dc06915e',
  'engine/pageFlip.ts': 'c2a3dba49c8ae62fda30d3196f43999d06fbd8d959a9cbd37320c298869f0441',
  'engine/pageIndex.ts': '8afc1756a4c5ec1fe5bffe195174ce27a5fe3c4cdea39d64a766868d0969df99',
  'engine/pdf.ts': 'c409218db12d2314066e5a5515ec9d6085f68a49da43c04642066da0f4e007a9',
  'engine/pdfjs-worker.d.ts': '29829fb66fc9b1fca9a19ec6cb7e715341ae3917250782c248cc4d36e455e01f',
  'engine/readerCss.ts': 'dae057614b4d45f82c58efbaad4ddc1d4c507fec09e249e2698028674e2f5907',
  'engine/sanitize.ts': 'caf8335b53cb3a6adcc0b65a9af83e51eed6da34a997310e53f49b49d7068613',
  'engine/search.ts': 'd2a0b57912179599d290f8e0866be1cbb7b344fa05d8e409b910478c6bf6aa76',
  'engine/text.ts': '710302382710feca014c79c8d7bf2bc199a4327436484c121131eb9ea0404df8',
  'engine/txt.ts': '1800e27d724706cdcbd7b23fb5d96fd9b2b10ff94c572d6182aec966b59cf169',
  'engine/types.ts': 'c54ba49c6771c6841df6872d2d018c48a300078e4143dc4d7e840539177f5f80',
  'engine/zip.ts': '7b5c2b7face63eeec6e3bc317e00e7e68d8267fb835e0f85bcc1aae14ac0a80e',
  'literata.ts': '6f65bce0cf618a70622b80d2d1fd90597f57fd65d1f5450956544679159d9b23',
  'store/backup.ts': '868123dcef03d9bd208ec0f1da9e8c48f2b6aec92589ced0bfbbaa15a3a0f4af',
  'store/bookStore.ts': '889914850ba1445e7917f6474f077d936bd292ceae86957851de9e73bcc66e54',
  'store/importer.ts': '63042e15bb344012190faf352e9e7d7e674ca47ee9fb1fbd27197b6f178bcba4',
  'store/pageCache.ts': '6b0d9f146f02ed28504895d7aeb43877f75e92b07082c0866f2086f70be0539e',
};

check('My Books reader engine, storage, typography and settings are byte-identical to the approved state', () => {
  for (const [file, sha] of Object.entries(FROZEN)) {
    const actual = createHash('sha256').update(readFileSync(new URL(`../src/${R}books/${file}`, import.meta.url))).digest('hex');
    assert.equal(actual, sha, `frozen My Books file changed: books/${file}`);
  }
  const shelf = src(`${R}books/MyBooksTab.tsx`);
  assert.doesNotMatch(shelf, /from "\.\/engine\/(?!types)/, 'the shelf imports no engine module');
  assert.doesNotMatch(shelf, /literata|fontFamily/, 'the shelf never touches book typography');
  assert.match(shelf, /return typeof document === "undefined" \? reader : createPortal\(reader, document\.body\);/, 'the full-window reader escapes the workspace column (no sidebar over the book)');
});

check('speed reading engine: timing, chunking, pause and stopword rules unchanged; no invented level', () => {
  const s = src(`${R}SpeedReader.tsx`);
  assert.match(s, /let delay = \(60000 \/ Number\(wpm\)\) \* Number\(chunkSize\);/);
  assert.match(s, /if \(pauseAtPunctuation && hasPunctuation\) \{\s*delay \*= 1\.5;/);
  assert.match(s, /const stops = new Set\(\['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'am', 'in', 'on', 'at', 'to', 'for', 'of', 'with'\]\);/);
  assert.match(s, /if \(e\.code === 'Space'\)[\s\S]*?setIsPaused\(prev => !prev\);[\s\S]*?e\.code === 'Escape'/);
  assert.doesNotMatch(s, /difficultyLevel \|\| 'B1'/, 'no default level in the library picker');
  assert.doesNotMatch(s, /comprehension|improvement|badge|streak/i, 'results show only the run\'s own values');
});

check('bilingual reader keeps the server pairing and passive tools', () => {
  const b = src(`${R}BilingualReader.tsx`);
  assert.match(b, /segments\.map\(\(segment, i\) =>/);
  assert.match(b, /key=\{segment\.position\}/);
  assert.match(b, /lang="en" onMouseUp=/);
  assert.match(b, /\{segment\.en\}/);
  assert.match(b, /lang="vi"/);
  assert.match(b, /\{segment\.vi\}/);
  assert.doesNotMatch(b, /explain|apiClient|openrouter/i, 'no contextual AI from the bilingual reader');
});

check('hero art: content-hashed rendered stills that exist; decoration only', () => {
  const hero = src(`${R}glass/ReadingHero.tsx`);
  const paths = [...hero.matchAll(/"(\/assets\/reading\/[^"]+\.webp)"/g)].map((m) => m[1]);
  assert.equal(paths.length, 9, 'four heroes × two sizes + the shelf backdrop');
  for (const p of paths) {
    assert.match(p, /-[0-9a-f]{8}\.webp$/, `content hash in ${p}`);
    assert.ok(existsSync(new URL(`../public${p}`, import.meta.url)), `asset exists: ${p}`);
  }
  assert.match(hero, /className=\{styles\.heroArt\} aria-hidden="true"/);
  assert.match(hero, /alt=""/);
});

check('honest data: hero numbers are server / shelf values or a pending mark, covers are typographic, no AI star', () => {
  const d = src(`${R}ReadingDashboard.tsx`);
  assert.match(d, /value: systemTotal \?\? "…"/);
  assert.match(d, /value: bilingualCatalog\.data\?\.totalElements \?\? "…"/);
  assert.match(d, /bookSummary === undefined \? "…" : bookSummary === null \? "—"/);
  assert.match(d, /<MyBooksTab onSummary=\{setBookSummary\} \/>/);
  const cover = src(`${R}glass/ReadingCover.tsx`);
  assert.doesNotMatch(cover, /<img|url\(|https?:/, 'covers draw no borrowed picture');
  for (const f of ['ReadingDashboard.tsx', 'ReadingCard.tsx', 'BilingualReader.tsx', 'BilingualReadingCard.tsx', 'BilingualReadingPanel.tsx', 'SpeedReader.tsx', 'books/MyBooksTab.tsx', 'glass/ReadingHero.tsx', 'glass/ReadingCover.tsx']) {
    assert.doesNotMatch(src(R + f), /Sparkles|✨/, `${f}: no sparkle icon`);
  }
  const card = src(`${R}ReadingCard.tsx`);
  assert.match(card, /className=\{styles\.openCue\} aria-hidden="true"/, '"Đọc ngay" is a cue of the one primary control, not a second button');
});

check('glass stylesheet: no blur over a wallpaper, no priority overrides, reduced motion stops the scenes', () => {
  const css = src(`${R}glass/readingGlass.module.css`);
  assert.doesNotMatch(css, /backdrop-filter|!important|font-family/);
  assert.match(css, /:global\(html\[data-wallpaper\]\) \.page \{ background: transparent;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.heroArt img, \.heroGlints i, \.skeleton > div \{ animation: none; \}/);
  assert.match(css, /\.openCue \{ pointer-events: none;/);
});

check('article reader: shell restyled, body / selection / completion paths kept', () => {
  const r = src(`${R}InteractiveReader.tsx`);
  assert.match(r, /onMouseUp=\{handleMouseUp\}/);
  assert.match(r, /className="font-reading drop-cap whitespace-pre-wrap text-slate-800 dark:text-slate-200 space-y-6 select-text cursor-text notranslate"/);
  assert.match(r, /h-\[calc\(100vh-4rem\)\] overflow-hidden/);
  assert.doesNotMatch(r, /-my-8 -mx-4/, 'Reading no longer sits in the padded tab main');
  assert.match(src('components/layout/WorkspaceTabs.tsx'), /activeTab === "reading" \? \(\s*\/\/[^\n]*\n\s*<ReadingDashboard \/>/);
});

console.log(`READING ECHO GLASS CONTRACTS: ${passed} PASSED`);
