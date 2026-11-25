// Flashcards "Echo Memory Universe" library (2026-10-24): presentation contract.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const view = read('src/components/features/flashcard/DeckCatalogView.tsx');
const css = read('src/components/features/flashcard/memoryUniverse.module.css');
const art = read('src/components/features/flashcard/deckArt.ts');
const ui = read('src/components/features/flashcard/FlashcardUI.tsx');
const page = read('src/components/layout/WorkspaceTabs.tsx');

// no generic AI star / sparkle icon, no emoji sparkle
assert.doesNotMatch(view, /Sparkles|WandSparkles|✨/);
// no invented metrics from the reference picture (overall %, study minutes, "+n this week")
assert.doesNotMatch(view, /Tiến độ tổng thể|phút|tuần này|mới tuần|Tuyệt vời/);
// numbers only from catalog / progress; unknown progress is "…", never a placeholder 0
assert.match(view, /value=\{progressLoading \? "…" : fmt\(totals\.mastered\)\}/);
assert.match(view, /value=\{progressLoading \? "…" : fmt\(totals\.due\)\}/);
// same study entry (enrolls first in FlashcardUI) and the due review is the existing pseudo deck
assert.match(view, /onClick=\{\(\) => onSelect\(deck\)\}/);
assert.match(view, /const openDeck = useCallback\(\(deck: VocabDeckSummary\) => \{ scrollWorkspaceTop\(\); onSelectDeck\(deck\); \}/);
assert.match(ui, /onReviewDue=\{\(\) => \{ void handleSelectDeck\(dueReviewDeck\(false\)\); \}\}/);
assert.match(ui, /void handleSelectDeck\(dueReviewDeck\(reviewParam === "learned"\)\)/);
// the due CTA appears only from known progress with something due
assert.match(view, /!progressLoading && onReviewDue \? \(\s*totals\.due > 0/);
// study screens keep the former 7xl frame; the library paints its own world
assert.match(ui, /const STUDY_FRAME = "relative mx-auto max-w-7xl px-4 py-8";/);
assert.match(page, /activeTab === "flashcards" \? \(/);

// every catalog deck has its own picture; every referenced file exists and its name carries its content hash
const decks = readdirSync(new URL('../backend/src/main/resources/data/decks/', root)).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(new URL('../backend/src/main/resources/data/decks/' + f, root), 'utf8')).slug);
// Extension decks use the existing typographic cover; legacy commissioned art remains required.
const bookImages = JSON.parse(read('src/components/features/flashcard/bookArt.json'));
for (const slug of decks.filter(x=>!x.startsWith("lib-"))) {
  if (slug.startsWith("bk-")) {
    const files = bookImages[slug.split("-")[1]];
    assert.equal(files?.length, 2, `two sizes for ${slug}`);
    for (const file of files) {
      const bytes = readFileSync(new URL('public/assets/flashcards/' + file, root));
      assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
      assert.ok(file.includes(createHash('sha256').update(bytes).digest('hex').slice(0,12)));
    }
  } else assert.ok(art.includes(`"${slug}": art(`), `picture for ${slug}`);
}

// owner rule (2026-10-30, 10 §BD): SYSTEM deck titles / descriptions and the curated topic decks' Vietnamese text never show
// "&" ("và" instead); curated decks carry a meaning, an example and its translation for every word
for (const f of readdirSync(new URL('../backend/src/main/resources/data/decks/', root)).filter((x) => x.endsWith('.json'))) {
  const d = JSON.parse(readFileSync(new URL('../backend/src/main/resources/data/decks/' + f, root), 'utf8'));
  assert.ok(!d.title.includes('&') && !(d.description ?? '').includes('&'), `"&" in the title / description of ${d.slug}`);
  if (!d.curated) continue;
  if (d.slug.startsWith('lib-')) {
    assert.ok(d.words.every(w => w.source?.license && w.source_kind && w.pos), d.slug);
    assert.equal(d.words.length, new Set(d.words.map(w=>w.word)).size, d.slug);
  } else if (d.slug.startsWith('bk-')) {
    assert.equal(d.category, 'BOOK_COLLECTION', d.slug);
    assert.equal(d.words.length, new Set(d.words.map(w=>w.word)).size, d.slug);
    for (const w of d.words) {
      assert.ok(w.source?.sourceUnit>0 && w.source?.senseId && w.source_kind==='book');
      assert.ok(['codex-authored','existing-deck'].includes(w.source.content) && w.pos && w.meanings?.[0]);
    }
  } else if (d.slug.startsWith('toeic-score-') || d.slug.startsWith('ielts-band-')) {
    assert.equal(d.category, d.slug.startsWith('toeic-score-') ? 'TOEIC_SCORE' : 'IELTS_BAND', d.slug);
    assert.equal(d.words.length, new Set(d.words.map(w => w.word)).size, d.slug);
    assert.ok(d.words.every(w => w.source?.license && w.source?.confidence && w.source.confidence !== 'REVIEW_REQUIRED' && w.source_kind && w.pos && w.meanings?.[0]), d.slug);
  } else assert.equal(d.category, 'TOPIC', d.slug);
  for (const w of d.words) {
    assert.ok(w.general_translation_vi && !w.general_translation_vi.includes('&'), `${d.slug}/${w.word} meaning`);
    assert.ok(w.examples?.[0] && w.examples_vi?.[0] && !w.examples_vi[0].includes('&'), `${d.slug}/${w.word} example + translation`);
  }
}
assert.match(view, /\{ id: "TOPIC", label: "Chủ đề đời sống" \}/);
assert.match(view, /\{ id: "TOEIC_SCORE", label: "TOEIC theo khoảng điểm" \}/);
assert.match(view, /\{ id: "IELTS_BAND", label: "IELTS theo band điểm" \}/);
const files = [...art.matchAll(/"((?:deck|flashcards-hero)-[a-z0-9-]+-([0-9a-f]{8})\.webp)"/g)];
assert.ok(files.length >= 2 * decks.filter(x=>!x.startsWith("lib-") && !x.startsWith("bk-")).length + 4);
for (const [, name, hash] of files) {
  const url = new URL('public/assets/flashcards/' + name, root);
  assert.ok(existsSync(url), name);
  assert.equal(createHash('sha256').update(readFileSync(url)).digest('hex').slice(0, 8), hash, `hash of ${name}`);
}
// an unknown deck gets a typographic cover, never another deck's art
assert.match(art, /return BY_SLUG\[slug\] \?\? null;/);
assert.match(view, /if \(!art \|\| failed\)/);

// material rules: no backdrop blur over a wallpaper, no !important, no own typeface, explicit .dark, wallpaper-aware page
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
assert.ok(!/backdrop-filter|!important|font-family/.test(cssCode), 'no backdrop blur / !important / own typeface');
assert.ok(!/prefers-color-scheme/.test(cssCode), 'theme only from the explicit .dark class');
assert.match(css, /:global\(\.dark\) \.world \{/);
assert.match(css, /:global\(html\[data-wallpaper\]\) \.page \{ background: transparent; \}/);
// tone tokens declared on the element that carries data-tone
assert.match(css, /\.deck\[data-tone="emerald"\] \{ --t1:/);
// reduced motion stops the hero / cards
const reduce = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
for (const sel of ['.heroArt img', '.heroCaustics', '.heroMotes i', '.deck {']) assert.ok(reduce.includes(sel), sel);
// decoration is hidden from assistive tech
assert.match(view, /className=\{styles\.heroArt\} aria-hidden="true"/);
assert.match(view, /className=\{styles\.heroMotes\} aria-hidden="true"/);

console.log(`Flashcard library glass: PASS (${decks.length} decks; commissioned covers and library text covers, ${files.length} hashed files, honest numbers, same study entry, material rules).`);
