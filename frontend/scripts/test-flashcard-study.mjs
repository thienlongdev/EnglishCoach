// Flashcard study surface contracts (owner brief 2026-10-15): real renders of both faces, honest rating copy checked
// against the backend schedule, card identity / double-submit guards, keyboard ownership, no decorative icons.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const read = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const readRepo = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
function evaluate(path, dependencies = {}) {
  const { code } = babel.core().transformSync(read(path), { filename: path, configFile: false, babelrc: false,
    presets: [babel.presetTypescript(), ...(path.endsWith('.tsx') ? [babel.presetReact()] : [])], plugins: [babel.pluginTransformModulesCommonjs()] });
  const module = { exports: {} };
  runInNewContext(code, { exports: module.exports, module, require: (p) => dependencies[p] ?? require(p), console, setTimeout, clearTimeout });
  return module.exports;
}
const cssModule = new Proxy({}, { get: (_, k) => (k === '__esModule' ? false : typeof k === 'string' ? k : undefined) });
const icon = () => null;
const deps = {
  react: React,
  '@/context/LanguageContext': { useLanguage: () => ({ locale: 'vi', t: {} }) },
  './flashcardStudy.module.css': cssModule,
  'lucide-react': { RotateCcw: icon, Volume2: icon, X: icon, BookOpenText: icon, Frown: icon, Smile: icon, Laugh: icon },
};
const recall = evaluate('components/features/flashcard/RecallControls.tsx', deps);
const face = evaluate('components/features/flashcard/cardFace.ts');
// Echo Memory Tides 2.0 (Deep Recall front, tier edge): the hero's optional modules
const recallHelpers = evaluate('components/features/flashcard/tides/recall.ts');
const deepRecall = evaluate('components/features/flashcard/tides/DeepRecall.tsx', { react: React, './recall': recallHelpers, './memoryTides.module.css': cssModule });
const hero = evaluate('components/features/flashcard/FlashcardHero.tsx', { ...deps, './RecallControls': recall, './cardFace': face,
  './tides/memoryTides.module.css': cssModule, './tides/DeepRecall': deepRecall, './tides/recall': recallHelpers,
  './tides/studyTimeline': evaluate('components/features/flashcard/tides/studyTimeline.ts') });

const card = { id: 42, status: 'LEARNED', reviewCount: 2, nextReviewDate: '2026-10-01T00:00:00',
  dictionaryEntry: { word: 'responsibility', ipa: '/rɪˌspɒnsəˈbɪləti/', cefr: 'B1', generalTranslationVi: 'Trách nhiệm',
    meanings: ['A duty to deal with or take care of somebody.'], examples: ['She takes her responsibilities seriously.'] } };
const render = (props) => renderToString(React.createElement(hero.FlashcardHero, { card, flipped: false, onFlip() {}, onToggleAudio() {},
  isPlaying: false, onRate() {}, savingQuality: null, shortcutsEnabled: true, ...props }));

// Both faces are present (one 3D card); only the showing face is reachable.
const front = render({});
assert.match(front, /data-flipped="false"/);
assert.match(front, /aria-label="Mặt trước thẻ"[^>]*>|<section[^>]*aria-hidden="false"[^>]*aria-label="Mặt trước thẻ"/);
assert.match(front, /<section[^>]*aria-hidden="true"[^>]*inert=""[^>]*aria-label="Mặt sau thẻ"/, 'hidden back face must be inert');
assert.equal((front.match(/>responsibility</g) || []).length, 2, 'word on both faces');
assert.match(front, /\/rɪˌspɒnsəˈbɪləti\//);
assert.match(front, /Lật thẻ xem nghĩa/);
assert.match(front, /Trách nhiệm/);
assert.match(front, /<mark>responsibilities<\/mark>/, 'inflected headword is highlighted in the example');
const back = render({ flipped: true });
assert.match(back, /<section[^>]*aria-hidden="true"[^>]*inert=""[^>]*aria-label="Mặt trước thẻ"/, 'hidden front face must be inert');
assert.match(back, /data-flipped="true"/);

// Missing optional data: honest empty meaning, no example block, no invented IPA / level.
const bare = render({ card: { ...card, dictionaryEntry: { word: 'ocean', meanings: [], examples: [] } } });
assert.match(bare, /Từ này chưa có nghĩa trong từ điển\./);
assert.doesNotMatch(bare, /Ví dụ/);
assert.doesNotMatch(bare, /B1|\/rɪ/);

// Card text (2026-10-18): the learner's saved meaning / example come first; an old Anki import that stored a note number
// as the word, the word as the meaning and the transcription as the example shows word / IPA (data unchanged).
const legacy = render({ flipped: true, card: { ...card, dictionaryEntry: { word: '2_29', meanings: ['scarf'], examples: ['[skɑːf]'] } } });
assert.equal((legacy.match(/>scarf</g) || []).length, 2, 'legacy import: the real word on both faces');
assert.doesNotMatch(legacy, /2_29/);
assert.match(legacy, /\[skɑːf\]/);
assert.doesNotMatch(legacy, /Ví dụ/, 'a transcription is never shown as an example');
const own = render({ flipped: true, card: { ...card, customMeaning: 'gánh vác (trong bài đọc)', customExample: 'He took on the responsibility.' } });
assert.match(own, /gánh vác \(trong bài đọc\)/);
assert.match(own, /He took on the <mark>responsibility<\/mark>\./);
assert.doesNotMatch(face.cardFace({ dictionaryEntry: { word: 'tide', meanings: ['Imported from Anki Deck'], examples: ['Custom example'] } }).headline ?? '', /Imported/);
assert.equal(face.cardFace({ dictionaryEntry: { word: '2026', meanings: ['42'], examples: [] } }).word, '2026', 'a number front stays when no word is stored');
// a curated topic deck teaches ONE sense (V106): its meaning, example and translation replace the dictionary row's other senses
const deckSense = { partOfSpeech: 'noun', meaningVi: 'Ngân hàng', example: 'He entered the bank.', exampleVi: 'Anh ta vào ngân hàng.' };
const sensed = face.cardFace({ dictionaryEntry: { word: 'bank', generalTranslationVi: 'Đê, gờ, ụ', meanings: ['the side of a river'],
  examples: ['They sat on the river bank.'] }, deckSense });
assert.equal(sensed.headline, 'Ngân hàng');
assert.equal(JSON.stringify(sensed.definitions), '[]');
assert.equal(JSON.stringify(sensed.examples), JSON.stringify(['He entered the bank.']));
assert.equal(JSON.stringify(sensed.exampleTranslations), JSON.stringify(['Anh ta vào ngân hàng.']));
assert.equal(sensed.partOfSpeech, 'noun');
const sensedBack = render({ flipped: true, card: { ...card, dictionaryEntry: { word: 'bank', meanings: [], examples: [] }, deckSense } });
assert.match(sensedBack, /Anh ta vào ngân hàng\./);
assert.match(sensedBack, /danh từ/);
assert.doesNotMatch(sensedBack, /river/);
assert.equal(face.cardFace({ ...card, deckSense: null }).partOfSpeech, null, 'no deck sense: no part of speech');

// Saving: every rating disabled, the chosen one says it is saving.
// (the ratings live in the theater's dock since 2026-11-20: render the controls themselves)
const saving = renderToString(React.createElement(recall.RecallControls, { onRate() {}, savingQuality: 'good', enabled: false }));
assert.doesNotMatch(render({ flipped: true }), /btn-recall-/, 'the card face carries no rating control');
assert.equal((saving.match(/<button[^>]*id="btn-recall-(hard|good|easy)"[^>]*disabled=""/g) || []).length, 3);
assert.match(saving, /Đang lưu…/);
const readyControls = renderToString(React.createElement(recall.RecallControls, { onRate() {}, savingQuality: null, enabled: true }));
assert.deepEqual(
  [...readyControls.matchAll(/<button[^>]*>/g)].map((m) => {
    const id = /id="([^"]+)"/.exec(m[0])?.[1];
    const cls = /class="([^"]+)"/.exec(m[0])?.[1];
    const key = /aria-keyshortcuts="([^"]+)"/.exec(m[0])?.[1];
    return `${id}:${cls}:${key}`;
  }),
  ['btn-recall-easy:rate easy:3', 'btn-recall-good:rate good:2', 'btn-recall-hard:rate hard:1'],
  'left-to-right rating order must be Dễ (easy) – Trung Bình (good) – Khó (hard) with matching tone classes and shortcuts',
);
assert.deepEqual(
  [...readyControls.matchAll(/<span class="rateName">([^<]+)<\/span>/g)].map((m) => m[1]),
  ['Dễ', 'Trung Bình', 'Khó'],
  'left-to-right labels must be Dễ – Trung Bình – Khó',
);
assert.deepEqual(
  [...readyControls.matchAll(/<span class="effectLong">([^<]+)<\/span>/g)].map((m) => m[1]),
  ['Đánh dấu đã thuộc', 'Ôn lại sau 3 ngày', 'Ôn lại hôm nay'],
  'left-to-right schedule effects must stay mapped to each quality',
);

// Rating copy states the backend's real schedule (FlashcardService#reviewFlashcard + the due query).
const service = readRepo('backend/src/main/java/com/englishcoach/flashcard/service/FlashcardService.java');
const repo = readRepo('backend/src/main/java/com/englishcoach/flashcard/repository/FlashcardRepository.java');
const block = (q) => service.slice(service.indexOf(`case ${q} -> {`), service.indexOf('}', service.indexOf(`case ${q} -> {`)));
assert.match(block('HARD'), /minusSeconds\(1\)/);
assert.match(block('GOOD'), /plusDays\(3\)/);
assert.match(block('EASY'), /plusDays\(7\)[\s\S]*setStatus\("MASTERED"\)/);
assert.match(service, /case "hard", "again", "kho", "khó", "1", "2" -> HARD;/);
assert.match(service, /default -> throw badRequest\(/, 'an unknown rating is refused, never scheduled');
assert.match(repo, /f\.status != 'MASTERED' AND \(f\.nextReviewDate IS NULL OR f\.nextReviewDate <= CURRENT_TIMESTAMP\)/);
const copy = recall.RATING_COPY;
assert.deepEqual(Object.keys(copy), ['hard', 'good', 'easy']);
assert.deepEqual([copy.hard.key, copy.good.key, copy.easy.key], ['1', '2', '3']);
assert.match(copy.hard.vi.effect + copy.hard.vi.detail, /hôm nay/);
assert.match(copy.good.vi.effect + copy.good.vi.detail, /3 ngày/);
assert.match(copy.easy.vi.detail, /Đã thuộc/);
assert.doesNotMatch(JSON.stringify(copy), /7 ngày|7 days|10 phút|\+1 ngày|\+4 ngày/, 'no interval the backend does not apply');

// Study state: the rating names the card on screen; one request in flight; pass tracked by identity.
const ui = read('components/features/flashcard/FlashcardUI.tsx');
assert.match(ui, /if \(!card \|\| card\.id !== cardId \|\| reviewInFlight\.current\) return;/);
assert.match(ui, /params: \{ quality: qualityString \}/);
// a retried rating carries the same Idempotency-Key; nothing advances before the server confirms; no blocking alert
assert.match(ui, /"Idempotency-Key": key/);
assert.match(ui, /previous\.cardId === card\.id && previous\.quality === qualityString \? previous\.key : newReviewKey\(\)/);
assert.doesNotMatch(ui, /Unable to save review to database/);
assert.ok(ui.indexOf('pendingReview.current = null;') < ui.indexOf('setTally((prev)'), 'tally only after the server answered');

assert.match(ui, /export function reviewErrorMessage/);
assert.doesNotMatch(ui, /reviewQueue\[currentIndex\]|libraryCards\[currentIndex\]/);
assert.match(ui, /reviewQueue\.filter\(\(c\) => !passReviewedSet\.has\(c\.id\)\)/);
assert.match(ui, /const shortcutsEnabled = !guideOpen && !showQuizModal && !showAddModal && !cardToDelete && !showCardBlastModal(?: && ![a-zA-Z]+)*;/);
assert.match(ui, /const shortcutsEnabled = [^;]*!forgeCard && !studioOpen;/, 'Memory Forge / Card Studio own the keyboard while open');
assert.match(read('components/features/flashcard/StudyDeckView.tsx'), /<FlashcardHero\s+key=\{card\.id\}/, 'a new card always starts on its front');
assert.match(read('components/features/flashcard/RecallControls.tsx'), /if \(!enabled\) return;/);

// No decorative icons / invented numbers on the study surface.
for (const f of ['FlashcardHero.tsx', 'RecallControls.tsx', 'StudyDeckView.tsx', 'StudyCompanion.tsx', 'CaughtUpView.tsx', 'FlashcardGuide.tsx', 'theater/TheaterHud.tsx', 'theater/TheaterScene.tsx']) {
  const src = read('components/features/flashcard/' + f);
  assert.doesNotMatch(src, /Sparkles|✨|sunBodyGrad|SunCoach|Sun Mascot|mascot-|military_tech|celebration/, f + ': no sparkle / sun / badge art');
  assert.doesNotMatch(src, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, f + ': no decorative emoji');
  assert.doesNotMatch(src, /XP Gained|Độ chính xác|Daily Streak|Elena|Khuyên dùng/, f + ': no invented metrics or nudges');
}
const css = read('components/features/flashcard/flashcardStudy.module.css');
assert.match(css, /backface-visibility: hidden/);
// crisp faces: no fractional 3D scale (translateZ under perspective), no permanent layer, no drifting veil over the word
assert.doesNotMatch(css, /translateZ\(/);
assert.doesNotMatch(css.slice(css.indexOf('.card {'), css.indexOf('}', css.indexOf('.card {'))), /^\s*will-change\s*:/m);
assert.doesNotMatch(css, /animation: aurora|@keyframes aurora/, "no endless drifting light layer");
assert.doesNotMatch(css, /text-shadow: 0 2px 22px/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.card,\s*\.face \{ transition: none; \}/);
console.log('Flashcard study: PASS (both faces rendered with inert hidden face, honest empty data, saving state, rating copy = backend schedule, identity + in-flight guards, keyboard ownership, no decorative icons).');
