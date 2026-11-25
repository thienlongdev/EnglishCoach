// Echo Memory Theater — Cinematic Reforge regression suite (2026-11-20):
// Verifies timeline math, pass-order locking under reshuffled ties and large-deck refetches,
// removal of redundant instruction box, redesigned floating-card vocabulary library,
// immersive quiz chamber, dual-theme celestial scene, and CSS material / accessibility laws.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const read = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');

function evaluate(path, dependencies = {}) {
  const { code } = babel.core().transformSync(read(path), {
    filename: path,
    configFile: false,
    babelrc: false,
    presets: [babel.presetTypescript(), ...(path.endsWith('.tsx') ? [babel.presetReact()] : [])],
    plugins: [babel.pluginTransformModulesCommonjs()],
  });
  const module = { exports: {} };
  runInNewContext(code, {
    exports: module.exports,
    module,
    require: (p) => (p in dependencies ? dependencies[p] : require(p)),
    console,
    setTimeout,
    clearTimeout,
  });
  return module.exports;
}

const css = new Proxy({}, { get: (_, k) => (k === '__esModule' ? false : typeof k === 'string' ? k : undefined) });
const icon = () => null;
const F = 'components/features/flashcard/';

// ── 1. Timeline mathematics & synchronization ─────────────────────────────────────────────────
const pt = evaluate(F + 'theater/passTimeline.ts');

for (const total of [1, 2, 7, 10, 40, 50, 56, 1320]) {
  let prevT = -1;
  const marks = Array.from({ length: total }, (_, i) => (i % 3 === 0 ? 'hard' : i % 3 === 1 ? 'good' : 'easy'));
  for (let done = 0; done <= total; done++) {
    const layout = pt.buildTimelineLayout(total, done, marks);
    assert.ok(layout.activeT >= prevT - 1e-9, `monotonic activeT for total=${total}, done=${done}: ${prevT} -> ${layout.activeT}`);
    prevT = layout.activeT;
    const activeNodes = layout.nodes.filter((n) => n.state === 'active');
    if (done < total) {
      assert.equal(activeNodes.length, 1, `exactly 1 active node for total=${total}, done=${done}`);
      const expectedT = total === 1 ? 0 : activeNodes[0].t;
      assert.ok(Math.abs(layout.activeT - expectedT) < 1e-6, `activeT matches active node position (${layout.activeT} vs ${expectedT})`);
    } else {
      assert.equal(activeNodes.length, 0, `no active node when pass finished total=${total}`);
      assert.equal(layout.activeT, 1, `activeT=1 when pass finished total=${total}`);
    }
    // Completed nodes before active have state=done, nodes after active have state=ahead
    for (const n of layout.nodes) {
      if (done < total && n.slot < layout.activeSlot) assert.equal(n.state, 'done');
      if (done < total && n.slot > layout.activeSlot) assert.equal(n.state, 'ahead');
      assert.ok(n.t >= 0 && n.t <= 1);
      assert.ok(n.yPct > 10 && n.yPct < 90);
    }
  }
}

// ── 2. Large-deck (1,320 cards) pass stability under reshuffled tied dates & async refetches ──
{
  const initial50 = Array.from({ length: 50 }, (_, i) => ({ id: 1000 + i, nextReviewDate: null, status: 'NEW' }));
  const passOrder = new Map(initial50.map((c, i) => [c.id, i]));
  let cards = pt.mergeDueBatchForPass([], initial50, new Map());
  assert.equal(cards.length, 50);

  // Simulate rating 7 cards (mix of hard, good, easy) while server returns reshuffled rows + brand new cards #51..#90
  const reviewed = [];
  for (let step = 0; step < 7; step++) {
    const q = step === 3 ? 'hard' : step % 2 === 0 ? 'good' : 'easy';
    const current = cards.find((c) => !reviewed.includes(c.id) && (!c.nextReviewDate || c.nextReviewDate <= '2026-11-20'));
    assert.equal(current.id, 1000 + step, `strict sequential pass order at step ${step}`);

    // Immediately after server confirms rating (during 540ms exit animation, heldCard is on screen)
    const updated = {
      ...current,
      status: q === 'easy' ? 'MASTERED' : 'LEARNED',
      nextReviewDate: q === 'hard' ? '2026-11-19' : '2026-11-27',
    };
    cards = cards.map((c) => (c.id === current.id ? updated : c));

    // Pending queue during exit animation
    const dueNow = cards.filter((c) => !c.nextReviewDate || c.nextReviewDate <= '2026-11-20');
    const pendingDuringExit = dueNow.filter((c) => !reviewed.includes(c.id));
    const countsDuringExit = pt.computePassCounts(
      reviewed,
      pendingDuringExit.length,
      current.id,
      pendingDuringExit.some((c) => c.id === current.id),
      false,
    );
    assert.equal(countsDuringExit.passTotal, 50, `passTotal never dips or bumps during exit (q=${q}, step=${step})`);
    assert.equal(countsDuringExit.position, step + 1);

    // Async mutateDue refetch returns 50 reshuffled cards including brand-new cards 2000..2030 from the 1,320-word deck!
    const reshuffledServer = [
      ...Array.from({ length: 30 }, (_, j) => ({ id: 2000 + step * 10 + j, nextReviewDate: null, status: 'NEW' })),
      ...cards.slice(10, 30).reverse(),
    ];
    cards = pt.mergeDueBatchForPass(cards, reshuffledServer, passOrder);
    assert.equal(cards.length, 50, 'pass batch never inflates from 50 to 56 on refetch');

    // After exit completes (advance())
    reviewed.push(current.id);
    const dueAfter = cards.filter((c) => !c.nextReviewDate || c.nextReviewDate <= '2026-11-20');
    const pendingAfter = dueAfter.filter((c) => !reviewed.includes(c.id));
    const countsAfter = pt.computePassCounts(reviewed, pendingAfter.length, null, false, false);
    assert.equal(countsAfter.passTotal, 50, `passTotal locked at 50 after step ${step}`);
    assert.equal(countsAfter.done, step + 1);
    assert.equal(countsAfter.position, step + 2);
  }
}

// ── 3. Removed redundant instruction box ──────────────────────────────────────────────────────
const deckSrc = read(F + 'StudyDeckView.tsx');
const theaterCss = read(F + 'theater/theater.module.css');
assert.doesNotMatch(deckSrc, /Nhớ nghĩa trong đầu, rồi lật thẻ để tự chấm|dockHint/, 'redundant instruction box removed from StudyDeckView');
assert.doesNotMatch(theaterCss, /\.dockHint/, 'dockHint CSS removed from theater.module.css');

// ── 4. MemoryCurrent & TheaterScene real SSR renders ──────────────────────────────────────────
const hud = evaluate(F + 'theater/TheaterHud.tsx', {
  react: React,
  'lucide-react': { BookOpen: icon, Brain: icon, ChevronRight: icon, Lightbulb: icon, X: icon },
  '@/lib/brand/echoCharacters': { echoSrc: () => '/echo.png' },
  '../RecallControls': { RATING_COPY: { hard: { key: '1', vi: { name: 'Khó', short: 'Hôm nay' }, en: { name: 'Hard', short: 'Today' } }, good: { key: '2', vi: { name: 'Tốt', short: 'Sau 3 ngày' }, en: { name: 'Good', short: 'In 3 days' } }, easy: { key: '3', vi: { name: 'Dễ', short: 'Đã thuộc' }, en: { name: 'Easy', short: 'Mastered' } } } },
  './passTimeline': pt,
  './theater.module.css': css,
});
const currentHtml = renderToString(React.createElement(hud.MemoryCurrent, {
  total: 56,
  done: 6,
  marks: ['good', 'easy', 'hard', 'good', 'easy', 'good'],
  vi: true,
}));
assert.match(currentHtml, /role="progressbar"/);
assert.match(currentHtml, /aria-valuemax="56"/);
assert.match(currentHtml, /aria-valuenow="6"/);
assert.match(currentHtml, /data-fx-target=""/);
assert.match(currentHtml, /--cur-t:/, 'lit strand uses exact clip-path percentage token');
assert.doesNotMatch(currentHtml, /stroke-dasharray|pathLength/, 'no buggy stroke-dasharray / pathLength on MemoryCurrent');

const sceneMod = evaluate(F + 'theater/TheaterScene.tsx', {
  react: React,
  '@/components/brand/EchoSwimmer': { EchoSwimmer: () => React.createElement('div', { 'data-echo-swimmer': '' }) },
  './theater.module.css': css,
});
const sceneHtml = renderToString(React.createElement(sceneMod.TheaterScene, { progressRatio: 0.4, tide: 'easy' }));
assert.match(sceneHtml, /celestialDay/, 'light-mode celestial centerpiece rendered');
assert.match(sceneHtml, /planetBody/, 'dark-mode celestial planet rendered');
assert.match(sceneHtml, /crescent/, 'dark-mode balancing crescent rendered');
assert.match(sceneHtml, /--th-progress:0\.400/, 'verified progress ratio wired to atmosphere');

// ── 5. Redesigned Vocabulary Library real SSR render ──────────────────────────────────────────
const libMod = evaluate(F + 'FlashcardLibraryView.tsx', {
  react: React,
  'lucide-react': new Proxy({}, { get: () => icon }),
  '@/context/LanguageContext': {
    useLanguage: () => ({
      locale: 'vi',
      t: {
        reviewPending: 'Cần ôn',
        learningState: 'Đang học',
        masteredTerms: 'Đã thuộc',
        totalTracked: 'Tổng số',
        searchPlaceholderFlashcards: 'Tìm từ vựng...',
        allVocabulary: 'Tất cả',
        dueForReview: 'Cần ôn',
        learning: 'Đang học',
        mastered: 'Đã thuộc',
        importApkg: 'Nhập .apkg',
        addFlashcard: 'Thêm thẻ',
      },
    }),
  },
  './cardFace': evaluate(F + 'cardFace.ts'),
  './VocabSearchCombobox': { VocabSearchCombobox: ({ placeholder }) => React.createElement('input', { placeholder, role: 'combobox' }) },
  './theater/theaterLibrary.module.css': css,
});

const sampleCards = [
  {
    id: 1,
    status: 'LEARNED',
    reviewCount: 3,
    nextReviewDate: '2026-11-18T00:00:00Z',
    dictionaryEntry: { word: 'resilient', ipa: '/rɪˈzɪliənt/', generalTranslationVi: 'kiên cường', meanings: ['able to recover quickly'], examples: ['Coral reefs are resilient.'] },
  },
  {
    id: 2,
    status: 'MASTERED',
    reviewCount: 7,
    nextReviewDate: '2026-11-28T00:00:00Z',
    dictionaryEntry: { word: 'itinerary', ipa: '/aɪˈtɪnərəri/', generalTranslationVi: 'lịch trình', meanings: ['a travel plan'], examples: ['Send me your itinerary.'] },
  },
];
const libHtml = renderToString(React.createElement(libMod.FlashcardLibraryView, {
  cards: sampleCards,
  totalCount: 1320,
  masteredCount: 5,
  learningCount: 1315,
  dueCount: 50,
  searchInput: '',
  onSearchChange() {},
  activeFilter: 'all',
  onFilterChange() {},
  page: 0,
  totalPages: 27,
  totalElements: 1320,
  onPageChange() {},
  onCardClick() {},
  onToggleAudio() {},
  isPlaying: false,
  onResetProgress() {},
  onDeleteCard() {},
  onAddCard() {},
  onImportApkg() {},
  isPersonalDeck: true,
  showStats: false,
}));
assert.match(libHtml, /data-theater-library=""/);
assert.match(libHtml, /role="list"/);
assert.match(libHtml, /resilient/);
assert.match(libHtml, /kiên cường/);
assert.match(libHtml, /\/rɪˈzɪliənt\//);
assert.match(libHtml, /Coral reefs are resilient\./);
assert.match(libHtml, /library-add-card-btn/);
assert.match(libHtml, /Bộ lọc và sắp xếp/);
assert.doesNotMatch(libHtml, /grid-cols-12/, 'legacy admin table layout removed');

// ── 6. Redesigned Quiz contracts ──────────────────────────────────────────────────────────────
const quizSrc = read(F + 'SpeedVocabQuizModal.tsx');
assert.doesNotMatch(quizSrc, /Sparkles|✨/, 'Quiz has zero Sparkles');
assert.doesNotMatch(quizSrc, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'Quiz has zero decorative emoji');
assert.match(quizSrc, /cardFace\(/, 'Quiz resolves card meanings consistently via cardFace');
assert.match(quizSrc, /runIdRef/, 'Quiz guards stale async init when closed');
assert.match(quizSrc, /ec:music-pause/, 'Quiz pauses Echo Music before pronunciation');
assert.doesNotMatch(quizSrc, /\/review/, 'Quiz never mutates SM-2 or learning progress');

// ── 7. Material & accessibility CSS laws ──────────────────────────────────────────────────────
for (const cssFile of ['theater/theater.module.css', 'theater/theaterLibrary.module.css', 'theater/theaterQuiz.module.css', 'tides/memoryPulse.module.css']) {
  const raw = read(F + cssFile).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(raw, /backdrop-filter/, `${cssFile}: zero backdrop-filter`);
  assert.doesNotMatch(raw, /!important/, `${cssFile}: zero !important`);
  assert.match(raw, /:global\(\.dark\)/, `${cssFile}: explicit .dark theme parity`);
  assert.match(raw, /prefers-reduced-motion:\s*reduce/, `${cssFile}: reduced motion handled`);
}

console.log('Echo Memory Theater Reforge: PASS (timeline math, 1320-card pass locking, redundant hint removed, floating glass library, immersive quiz, dual-theme celestial scene, CSS material laws).');
