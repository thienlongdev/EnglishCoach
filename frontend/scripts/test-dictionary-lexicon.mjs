// Echo Lexicon (owner brief 2026-10-24, 10 §AW): the global dictionary and the contextual dictionary cards are one
// presentation family over the SAME lookups, audio and saves. These checks keep the redesign honest: the owner's names,
// nested Wiktionary senses shown once, no invented metadata, no blur / priority overrides / own typeface, every save
// told by the server's answer (never alert()), the cards rendered into <body>, and the art under content-hashed names.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const read = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
function evaluate(path) {
  const { code } = babel.core().transformSync(read(path), { filename: path, configFile: false, babelrc: false,
    presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()] });
  const module = { exports: {} };
  runInNewContext(code, { exports: module.exports, module, require, console });
  return module.exports;
}
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

const D = 'components/features/dictionary/';
const global = read(D + 'GlobalDictionarySearch.tsx');
const parts = read(D + 'lexicon/LexiconParts.tsx');
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = noComments(read(D + 'lexicon/lexicon.module.css'));
const mini = noComments(read(D + 'lexicon/mini.module.css'));
const textRaw = evaluate(D + 'lexicon/lexiconText.ts');
// values made in the vm realm are copied into this one (deepStrictEqual compares prototypes)
const plainOf = (v) => JSON.parse(JSON.stringify(v));
const text = Object.fromEntries(Object.entries(textRaw).map(([k, f]) => [k, (...a) => plainOf(f(...a))]));

check('owner names: "Từ điển", "Tra nghĩa", "Cụm từ liên quan"; EN–EN / EN–VI kept; the old names are gone', () => {
  assert.match(global, />Từ điển<\/h2>/);
  assert.match(global, /<span>Tra nghĩa<\/span>/);
  assert.match(global, /<span>Cụm từ liên quan<\/span>/);
  assert.match(global, />\s*EN–EN\s*</);
  assert.match(global, />\s*EN–VI\s*</);
  for (const old of ['Từ điển Anh - Việt & Ngữ liệu', 'TỪ ĐIỂN</span>', 'CÁCH DÙNG & CỤM TỪ']) assert.ok(!global.includes(old), old);
  for (const sub of ["'Collocations'", "'Phrasal Verbs'", "'Idioms'", "'Expressions'"]) assert.ok(global.includes(sub), sub);
});

check('same requests and save rule: lookup, collocations, phrases, one Flashcard rule, the music pause', () => {
  assert.match(global, /lookupCanonical\(clean, mode\)/);
  assert.match(global, /fetchCollocations\(headword\)/);
  assert.match(global, /fetchPhrases\(headword\)/);
  assert.match(global, /const meaningVi = flashcardMeaningVi\(result\);/);
  assert.match(global, /apiClient\.post\("\/flashcards", \{ front, back: back \|\| "No definition", example \}\)/);
  assert.match(global, /window\.dispatchEvent\(new Event\('ec:music-pause'\)\)/);
  assert.match(read('components/dashboard/WordLookupPopover.tsx'), /window\.dispatchEvent\(new Event\("ec:music-pause"\)\)/);
});

check('speed: a newer search wins, language switch fetches nothing, pending suggestions are cancelled', () => {
  assert.match(global, /const id = \+\+requestIdRef\.current;/);
  assert.match(global, /if \(id !== requestIdRef\.current\) return;/);
  assert.match(global, /const handleModeSwitch = \(newMode: 'en-en' \| 'en-vi'\) => \{\s*setDictMode\(newMode\);\s*\};/);
  assert.match(global, /suggestAbort\.current\?\.abort\(\);/);
  assert.match(global, /disabled=\{!query\.trim\(\)\}/, 'Enter starts a new search while a word is still loading');
  assert.match(global, /return \(\) => \{ alive = false; \};/, 'an answer for a word already left is dropped');
  assert.doesNotMatch(global, /groups: \[\s*\{ pattern: "Common Collocations"/, 'stored (unfiltered) collocation lists are not shown');
});

check('dialog semantics: modal, labelled, Escape, Tab kept inside, focus returned', () => {
  assert.match(global, /role="dialog"\s+aria-modal="true"\s+aria-labelledby=\{titleId\}/);
  assert.match(global, /if \(e\.key === 'Escape'\)/);
  assert.match(global, /if \(e\.key !== 'Tab' \|\| !dialogRef\.current\) return;/);
  assert.match(global, /returnFocusRef\.current = /);
  assert.match(global, /role="combobox"/);
  assert.match(global, /\(e\.metaKey \|\| e\.ctrlKey\) && e\.key\.toLowerCase\(\) === 'k'/);
});

check('no invented metadata: no frequency, topic, rank or fake level; CEFR only from the entry', () => {
  for (const src of [global, parts]) {
    assert.doesNotMatch(src, /Độ phổ biến|Chủ đề|frequency|Rất cao|A2 – C1/);
  }
  assert.match(global, /\{result\.cefr && <span className=\{styles\.cefr\}/);
  assert.doesNotMatch(global + parts, /Cụm kết hợp từ tự nhiên/, 'no filler sentence in place of an example');
});

check('nested Wiktionary senses: a parent keeps its own words, sub-senses stay, an example is shown once', () => {
  const senses = [
    { id: '1', definitionEn: 'To be moved downwards. To move to a lower position under the effect of gravity.', examples: ['Thrown from a cliff, the stone fell.', 'I fell unconscious.', 'The rain fell at dawn.'] },
    { id: '2', definitionEn: 'To move to a lower position under the effect of gravity.', examples: ['Thrown from a cliff, the stone fell.', 'I fell unconscious.'] },
    { id: '3', definitionEn: 'To come down, to drop or descend.', examples: ['The rain fell at dawn.'] },
    { id: '4', definitionEn: 'To move downwards. To let fall; to drop. To sink; to depress.', examples: ['to fall the voice'] },
    { id: '5', definitionEn: 'To let fall; to drop.', examples: [] },
    { id: '6', definitionEn: 'To sink; to depress.', examples: ['to fall the voice'] },
    { id: '7', definitionEn: 'To die.', examples: [] },
  ];
  const n = text.nestSenses(senses);
  assert.deepEqual(n.map((x) => x.gloss), ['To be moved downwards.', 'To come down, to drop or descend.', 'To move downwards.', 'To die.']);
  assert.deepEqual(n.map((x) => x.children.length), [1, 0, 2, 0]);
  assert.deepEqual(n[0].examples, [], 'the parent shows none of the copies it carries');
  assert.deepEqual(n[1].examples, ['The rain fell at dawn.']);
  const total = n.reduce((k, x) => k + 1 + x.children.length, 0);
  assert.equal(total, senses.length, 'no sense is dropped');
  const plain = [{ definitionEn: 'A.', examples: ['x'] }, { definitionEn: 'B.', examples: ['y'] }];
  assert.deepEqual(text.nestSenses(plain).map((x) => [x.gloss, x.examples]), [['A.', ['x']], ['B.', ['y']]]);
});

check('honest labels: literal Wiktionary notes, positional collocation groups, headword emphasis', () => {
  assert.equal(text.isLiteralNote('Used other than figuratively or idiomatically: see fall, back.'), true);
  assert.equal(text.collocationGroupLabel('Next word', 'fall').title, 'Từ thường đi liền sau');
  assert.deepEqual(text.collocationGroupLabel('Adjective + Noun', 'fall').formula, ['tính từ', 'fall']);
  assert.deepEqual(text.markHeadword('Prices have fallen.', 'fall').filter((p) => p.hit).map((p) => p.t), ['fallen']);
  assert.equal(text.sanitizeLexicalText('see fall,‎ back .'), 'see fall, back.');
  assert.equal(text.posLabelVi('verb'), 'Động từ');
});

check('materials: no blur, no priority overrides, Quicksand only (IPA face excepted), reduced motion stops motion', () => {
  for (const s of [css, mini]) {
    assert.doesNotMatch(s, /backdrop-filter|!important/);
    const fonts = s.match(/font-family:[^;]+;/g) || [];
    assert.ok(fonts.every((f) => /Charis SIL/.test(f)), 'only the IPA transcription names a face');
    assert.match(s, /@media \(prefers-reduced-motion: reduce\)/);
  }
  assert.match(css, /:global\(\.dark\) \.lexicon \{/, 'the page follows the explicit .dark class');
  assert.doesNotMatch(global + parts + read(D + 'lexicon/LexiconMini.tsx'), /Sparkles|✨/);
});

check('the art ships under content-hashed names that exist for both day and night themes', () => {
  const names = [...global.matchAll(/\/assets\/dictionary\/(lexicon-ocean-(?:day-)?\d+-[0-9a-f]{8}\.webp)/g)].map((m) => m[1]);
  assert.equal(names.length, 4);
  for (const n of names) assert.ok(existsSync(new URL(`../public/assets/dictionary/${n}`, import.meta.url)), n);
  assert.match(global, /data-testid="dictionary-stage-day"/);
  assert.match(global, /data-testid="dictionary-stage-night"/);
  assert.match(css, /\.stageDay\s*\{\s*opacity:\s*1;\s*\}/);
  assert.match(css, /:global\(\.dark\)\s*\.lexicon\s*\.stageNight\s*\{\s*opacity:\s*1;\s*\}/);
});

check('contextual cards: one Mini family, real states, saves told by the server, rendered into <body>', () => {
  const quick = read(D + 'QuickDictionaryCard.tsx');
  const popover = read(D + 'QuickDictionaryPopover.tsx');
  const popup = read(D + 'DictionaryPopup.tsx');
  const feed = read('components/dashboard/WordLookupPopover.tsx');
  for (const src of [quick, popup, feed]) assert.match(src, /from "(\.\/lexicon|@\/components\/features\/dictionary\/lexicon)\/LexiconMini"/);
  for (const src of [popover, popup, quick]) assert.doesNotMatch(src, /window\.alert|alert\(/);
  assert.match(popover, /createPortal\(popover, document\.body\)/);
  assert.match(popover, /new ResizeObserver\(place\)/, 'placed from its real size');
  assert.match(quick, /onAddFlashcard\(data\.word, data\.vietnameseMeaning, data\.example\)/);
  assert.match(popup, /back = flashcardMeaningVi\(data\) \|\| s\.definitionEn \|\| back;/);
  assert.match(quick, /Đang tra nghĩa\.\.\./);
  assert.match(quick, /Lỗi kết nối từ điển\./);
  assert.ok(!existsSync(new URL('../src/app/qa-lexicon/page.tsx', import.meta.url)) || process.env.LEXICON_QA === '1', 'the temporary QA page never ships');
});

console.log(`ECHO LEXICON CONTRACTS: ${passed} PASSED`);
