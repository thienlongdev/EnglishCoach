// Echo Memory Tides 2.0 contracts (owner brief 2026-11-12): Deep Recall helpers and real renders, rating effects only after
// the server stored the rating, ratings only on the back, Card Studio never saves by itself, honest Card Alchemy rules and
// backend invariants (append-only log, strict Fusion acceptance, quota-gated explicit AI actions).
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const read = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const readRepo = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
function evaluate(path, dependencies = {}, globals = {}) {
  const { code } = babel.core().transformSync(read(path), { filename: path, configFile: false, babelrc: false,
    presets: [babel.presetTypescript(), ...(path.endsWith('.tsx') ? [babel.presetReact()] : [])], plugins: [babel.pluginTransformModulesCommonjs()] });
  const module = { exports: {} };
  runInNewContext(code, { exports: module.exports, module, require: (p) => {
    if (p in dependencies) return dependencies[p];
    if (p.startsWith('@/') || p.startsWith('./') || p.endsWith('.css')) throw new Error(`unstubbed import ${p} in ${path}`);
    return require(p);
  }, console, setTimeout, clearTimeout, window: globals.window, document: globals.document, ...globals });
  return module.exports;
}
const css = new Proxy({}, { get: (_, k) => (k === '__esModule' ? false : typeof k === 'string' ? k : undefined) });
const icon = () => null;
const T = 'components/features/flashcard/';

// ── Deep Recall helpers ─────────────────────────────────────────────────────────────────────────
const r = evaluate(T + 'tides/recall.ts');
assert.ok(r.wordForms('study').has('studies') && r.wordForms('plan').has('planning') && r.wordForms('make').has('making'));
assert.ok(!r.wordForms('go').has('went'), 'irregular forms are never guessed');
const cz = r.clozeFor('responsibility', ['A plain sentence.', 'She takes her responsibilities seriously.']);
assert.equal(cz.answer, 'responsibilities');
assert.equal(cz.before + cz.answer + cz.after, 'She takes her responsibilities seriously.');
assert.equal(r.clozeFor('ocean', ['No match here.']), null, 'no example with the word: no invented cloze');
assert.equal(r.clozeFor('look into', ['Police will look into it.']).answer, 'look into');
assert.equal(r.checkCloze('Responsibilities ', cz, 'responsibility'), 'exact');
assert.equal(r.checkCloze('responsibility', cz, 'responsibility'), 'base');
assert.equal(r.checkCloze('duty', cz, 'responsibility'), 'wrong');
assert.equal(r.foldVi('Trách Nhiệm, đẹp!'), 'trach nhiem dep');
assert.equal(r.compareMeaning('trach nhiem', 'Trách nhiệm; bổn phận'), 'close', 'harmless mark / case differences are ignored');
assert.equal(r.compareMeaning('nhiệm vụ', 'trách nhiệm'), 'partial');
assert.equal(r.compareMeaning('con mèo', 'trách nhiệm'), 'none');
assert.equal(r.compareMeaning('', 'trách nhiệm'), 'none');

// ── FlashcardHero with Deep Recall and Card Alchemy (real renders) ─────────────────────────────
const recallControls = evaluate(T + 'RecallControls.tsx', { react: React, '@/context/LanguageContext': { useLanguage: () => ({ locale: 'vi' }) }, './flashcardStudy.module.css': css, 'lucide-react': { Frown: icon, Smile: icon, Laugh: icon } });
const deep = evaluate(T + 'tides/DeepRecall.tsx', { react: React, './recall': r, './memoryTides.module.css': css });
const hero = evaluate(T + 'FlashcardHero.tsx', {
  react: React, '@/context/LanguageContext': { useLanguage: () => ({ locale: 'vi' }) }, 'lucide-react': { RotateCcw: icon, Volume2: icon },
  './RecallControls': recallControls, './cardFace': evaluate(T + 'cardFace.ts'), './flashcardStudy.module.css': css,
  './tides/memoryTides.module.css': css, './tides/DeepRecall': deep, './tides/recall': r, './tides/studyTimeline': evaluate(T + 'tides/studyTimeline.ts'),
}).FlashcardHero;
const card = { id: 7, status: 'LEARNED', reviewCount: 3, nextReviewDate: '2026-11-01T00:00:00',
  dictionaryEntry: { word: 'responsibility', ipa: '/rɪˌspɒnsəˈbɪləti/', generalTranslationVi: 'Trách nhiệm', meanings: [], examples: ['She takes her responsibilities seriously.'] } };
const render = (p = {}) => renderToString(React.createElement(hero, { card, flipped: false, onFlip() {}, onToggleAudio() {}, isPlaying: false,
  onRate() {}, savingQuality: null, shortcutsEnabled: true, ...p }));
const frontPart = (html) => html.slice(0, html.indexOf('aria-label="Mặt sau thẻ"'));

const plain = render();
// Echo Memory Theater (2026-11-20): the ratings left the card for the theater's dock (StudyDeckView); the card never carries them.
assert.doesNotMatch(plain, /btn-recall-/, 'Khó / Tốt / Dễ are never on the card itself (the dock owns them)');
assert.doesNotMatch(plain, /tierChip|foil/, 'no tier, no decoration');

const typed = render({ recallMode: 'type' });
assert.match(frontPart(typed), /Nghĩa của “responsibility” là gì\?/);
assert.match(frontPart(typed), /<input[^>]*lang="vi"/);
assert.match(frontPart(typed), /data-no-flip/);

const cloze = render({ recallMode: 'cloze' });
assert.match(frontPart(cloze), /Điền từ còn thiếu/);
assert.doesNotMatch(frontPart(cloze), />responsibility</, 'the cloze front never shows the word it asks for');
assert.doesNotMatch(frontPart(cloze), /responsibilities/, 'nor the inflected form in the sentence');
assert.doesNotMatch(frontPart(cloze), /Nghe phát âm/, 'no audio that would say the answer');
assert.match(cloze, />responsibility</, 'the back still names the word');
const clozeNone = render({ recallMode: 'cloze', card: { ...card, dictionaryEntry: { ...card.dictionaryEntry, examples: [] } } });
assert.match(frontPart(clozeNone), /chưa có câu ví dụ chứa từ/);
assert.match(frontPart(clozeNone), />responsibility</);

assert.match(render({ tier: 'PRISM' }), /Holo Prism/);
assert.match(render({ tier: 'PEARL' }), /Eternal Pearl/);
assert.doesNotMatch(render({ tier: 'SILVER' }), /Silver Echo/, 'the study card stays minimal below Holo Prism');

// verdict on the back: honest keyword wording, never "perfect"
const verdict = renderToString(React.createElement(deep.RecallVerdict, { vi: true, attempt: { kind: 'type', typed: 'trách nhiệm', match: 'close' } }));
assert.match(verdict, /chỉ là so khớp từ khóa/);
assert.doesNotMatch(verdict, /hoàn hảo|chính xác 100|perfect/i);

const same = (x, y, m) => assert.equal(JSON.stringify(x), JSON.stringify(y), m); // objects from the VM sandbox
// ── Echo Memory Pulse: one timeline, effects from the real button, after the stored rating ─────────────
const tl = evaluate(T + 'tides/studyTimeline.ts');
const walk = (from, events) => events.reduce((p, e) => (p === null ? null : tl.step(p, e)), from);
assert.equal(walk('front', ['FLIP', 'FLIP_DONE']), 'back');
assert.equal(tl.step('front', 'RATE'), null, 'no rating on the front');
assert.equal(tl.step('flipping-back', 'RATE'), null, 'no rating while the card turns');
assert.equal(tl.step('flipping-back', 'FLIP'), null, 'a second press does not reverse a turn');
assert.equal(tl.step('pending', 'RATE'), null, 'a pending rating blocks every other rating (keys and clicks)');
assert.equal(walk('back', ['RATE', 'FAIL']), 'back', 'a failure restores the back with its ratings');
assert.equal(walk('back', ['RATE', 'CONFIRM', 'EXIT', 'SWAP', 'ENTERED']), 'front');
assert.equal(walk('back', ['RATE', 'CONFIRM', 'SWAP', 'ENTERED']), 'front', 'reduced motion skips the exit');
assert.equal(tl.step('exit', 'RESET'), 'front');
assert.ok(tl.canRate('back') && !['front', 'flipping-back', 'pending', 'effect', 'exit', 'enter'].some(tl.canRate));
assert.ok(!tl.ratingsShown('flipping-back') && tl.ratingsShown('pending') && tl.ratingsShown('exit') && !tl.ratingsShown('enter'));
assert.equal(tl.TIMELINE.flip, 600);
const post = tl.TIMELINE.exitAt + tl.TIMELINE.exit + tl.TIMELINE.enter;
assert.ok(post >= 550 && post <= 800, `post-confirmation sequence ${post} ms`);
const clock = new tl.Timeline(); let fired = 0;
clock.schedule(5, () => fired++); clock.schedule(5, () => fired++); clock.cancel();
await new Promise((r) => setTimeout(r, 30));
assert.equal(fired, 0, 'cancelling the timeline stops the whole sequence');
assert.equal(clock.size, 0);
// geometry: relative to the stage layer, from the real button / card / progress rects (scroll-proof)
const g = tl.fxGeometry({ left: 100, top: 1000, width: 800, height: 600 }, { left: 300, top: 1450, width: 120, height: 60 },
  { left: 120, top: 1060, width: 600, height: 470 }, { left: 200, top: 1020, width: 300, height: 6 });
same(g.origin, { x: 260, y: 480 });
same(g.card, { x: 20, y: 60, w: 600, h: 470 });
same(g.target, { x: 250, y: 23 });
same(g.edge, { x: 260, y: 530 });
const scrolled = tl.fxGeometry({ left: 100, top: 400, width: 800, height: 600 }, { left: 300, top: 850, width: 120, height: 60 },
  { left: 120, top: 460, width: 600, height: 470 }, null);
same(scrolled.origin, g.origin, 'the same layout scrolled gives the same positions');
same(scrolled.target, { x: 320, y: 60 }, 'no progress line: the pearl goes to the card top');

const fxMod = evaluate(T + 'tides/RatingFx.tsx', { react: React, './memoryPulse.module.css': css,
  '@/lib/vfx/quality': { vfxPreference: () => 'high', deviceVfxTier: () => 'high' } }, { window: {} });
const ev = (q, reduced = false) => ({ id: 1, quality: q, geometry: g, reduced });
const fxHtml = (q, reduced) => renderToString(React.createElement(fxMod.RatingFx, { event: ev(q, reduced) }));
const hardFx = fxHtml('hard');
assert.match(hardFx, /data-quality="hard"/);
assert.match(hardFx, /<line class="trace" x1="260" y1="480" x2="260" y2="530"/, 'Khó: the pull from the pressed button down to the waterline (card edge)');
assert.match(hardFx, /class="waterline"/, 'Khó: the card sinks through a waterline');
assert.equal((hardFx.match(/class="bubble"/g) || []).length, 5, 'Khó: a few bubbles rise (the card resurfaces this session)');
assert.equal((hardFx.match(/class="ink/g) || []).length, 2);
assert.match(hardFx, /--ox:260px;--oy:480px/, 'the effect starts at the real button');
const goodFx = fxHtml('good');
assert.equal((goodFx.match(/class="ring/g) || []).length, 2);
assert.match(goodFx, /class="current"/, 'Tốt: an indigo current across the card');
assert.equal((goodFx.match(/class="ghost/g) || []).length, 2, 'Tốt: two afterimages drift away');
assert.match(goodFx, /class="edge"/);
const easyFx = fxHtml('easy');
assert.equal((easyFx.match(/class="mote"/g) || []).length, 10);
assert.equal((easyFx.match(/class="pearl"/g) || []).length, 1, 'one pearl forms (no duplicate pearls)');
assert.match(easyFx, /class="nacre"/);
assert.match(easyFx, /--tx:-70px;--ty:-249px/, 'the pearl travels from the card centre to the progress line');
const stillFx = fxHtml('easy', true);
assert.match(stillFx, /data-reduced="true"/);
assert.doesNotMatch(stillFx, /mote|pearl|ring|nacre|bubble|ghost/, 'reduced motion: one still confirmation');
const fxSrc = read(T + 'tides/RatingFx.tsx');
assert.doesNotMatch(fxSrc, /<canvas|getContext\(|WebGLRenderer|requestAnimationFrame|setTimeout|from ["']three["']/, 'no renderer, no loop, no own timer');

const ui = read(T + 'FlashcardUI.tsx');
const put = ui.indexOf('await apiClient.put(`/flashcards/${card.id}/review`');
const catchAt = ui.indexOf('} catch (e: any) {', put);
const confirmAt = ui.indexOf('confirmRating(card, qualityString', put);
assert.ok(put > 0 && confirmAt > put && confirmAt < catchAt, 'the effect starts only after the stored rating, never on failure');
assert.ok(ui.indexOf('pendingReview.current = null;', put) < confirmAt);
assert.ok(ui.indexOf('if (!canRate(phaseRef.current)) return;') < put, 'ratings only in the back phase');
assert.ok(ui.indexOf('setHeldCard(card);', put) < ui.indexOf('setCards((prev)', put), 'the rated card is held before the due list changes');
assert.match(ui.slice(catchAt, catchAt + 400), /if \(token !== sessionToken\.current\) return;[\s\S]*go\("FAIL"\)/, 'a failure cancels the visuals and restores the back');
assert.match(ui, /timeline\.current\.schedule\(TIMELINE\.exitAt \+ TIMELINE\.exit, advance\)/);
assert.match(ui, /<div ref=\{stageRef\} className="relative" data-tide=\{tide \?\? undefined\}>/, 'effects live over the stage, outside the card; the stored rating decides the exit');
assert.ok(ui.indexOf('setTide(quality);') > ui.indexOf('const confirmRating ='), 'the tide is set only by a stored rating');
assert.match(ui, /setTrail\(\(prev\) => \[\.\.\.prev, qualityString\]\);/, 'the tide line records stored ratings only');
assert.match(ui, /useEffect\(\(\) => \(\) => \{ timeline\.current\.cancel\(\);/, 'unmount cancels the timeline');
const selectDeck = ui.slice(ui.indexOf('const handleSelectDeck'), ui.indexOf('const handleFlashcardClick'));
assert.match(selectDeck, /resetTimeline\(\);[\s\S]*setLibraryOpen\(false\);/, 'a new session: timeline reset, library folded');
assert.equal((ui.match(/setLibraryOpen\(/g) || []).length, 1, 'only entering a session sets the library (never a rating or a card change)');
assert.match(ui, /<StudyLibraryDrawer open=\{libraryOpen\} onOpenChange=\{setLibraryOpen\}/);
assert.match(ui, /\{effectiveTotalCards > 0 && !isStudying && renderLibrary\(true\)\}/, 'outside a session the full library stays');
assert.match(ui, /\{renderLibrary\(false\)\}/, 'inside a session: no duplicated four-number strip');

// the dock: ratings arrive only once the back has finished turning, inert before; keys 1–3 live only in the back phase
const deckSrc = read(T + 'StudyDeckView.tsx');
assert.match(deckSrc, /const ratingsVisible = flipped && ratingsShown\(shownPhase\);/);
assert.match(deckSrc, /data-ready=\{ratingsVisible \? "true" : "false"\}/);
assert.match(deckSrc, /<div className=\{th\.dockRatings\} inert=\{!ratingsVisible\}>/);
assert.match(deckSrc, /enabled=\{flipped && shownPhase === "back" && shortcutsEnabled && !saving\}/);
assert.match(deckSrc, /onRate=\{\(q\) => onRate\(q, card\.id\)\}/, 'a rating always names the card on screen');
assert.doesNotMatch(read(T + 'FlashcardHero.tsx'), /<RecallControls/, 'the card face holds no rating control');
const theaterCss = read(T + 'theater/theater.module.css');
assert.match(theaterCss, /\.dock\[data-ready='false'\] \.dockRatings \{ opacity: 0; translate: 0 10px; pointer-events: none; \}/);
const studyCss = read(T + 'flashcardStudy.module.css');
assert.match(studyCss, /\.stage\[data-phase='exit'\] \{\s*animation: cardExit 340ms/);
assert.match(studyCss, /@keyframes cardExit \{\s*to \{ opacity: 0; translate: 0 -10px; scale: 0\.97; \}/, 'exit uses translate / scale, never the card\'s rotateY');
for (const [tide, name] of [['hard', 'tideUndertow'], ['good', 'tideDrift'], ['easy', 'tidePearl']]) {
  assert.ok(studyCss.includes(`[data-tide='${tide}'] .stage[data-phase='exit'] {\n  animation: ${name} 340ms`) || studyCss.includes(`[data-tide='${tide}'] .stage[data-phase='exit'] {\r\n  animation: ${name} 340ms`), `${tide}: ${name}`);
  const at = studyCss.indexOf(`@keyframes ${name}`);
  assert.doesNotMatch(studyCss.slice(at, studyCss.indexOf('\n}', at)), /transform/, `${name} never touches the card's rotateY`);
}
assert.ok(studyCss.includes("[data-tide] .stage[data-phase='exit'],"), 'reduced motion stops the tide exits');
// completion: the tide line draws exactly this session's stored ratings; the burst is portalled out of the animated card
const caught = read(T + 'CaughtUpView.tsx');
assert.match(caught, /createPortal\(<Burst key=\{burst\} \/>, document\.body\)/, 'the full-window burst is never trapped in the transformed card');
assert.match(read('components/vfx/BurstCanvas.tsx'), /catch\{canvas\.hidden=true;return;\}/, 'a renderer that cannot start never leaves a blank slab');

// the library bar: collapsed by default, one row, real aria, mounted only when open
const drawer = evaluate(T + 'tides/StudyLibraryDrawer.tsx', { react: React, 'lucide-react': { ChevronDown: icon, Library: icon },
  '@/lib/morph/tokens': { MORPH_EASE: {}, MORPH_ID: 'x', MORPH_MS: { surface: 1, base: 1 }, morphReduced: () => true }, './memoryPulse.module.css': css });
const closed = renderToString(React.createElement(drawer.StudyLibraryDrawer, { open: false, onOpenChange() {}, count: 1234 },
  React.createElement('input', { id: 'lib-search' })));
assert.match(closed, /aria-expanded="false"/);
assert.match(closed, /Thư viện từ vựng/);
assert.match(closed, /1\.234 từ/);
assert.match(closed, /Mở thư viện/);
assert.doesNotMatch(closed, /lib-search/, 'collapsed: no management control in the page');
const opened = renderToString(React.createElement(drawer.StudyLibraryDrawer, { open: true, onOpenChange() {}, count: null },
  React.createElement('input', { id: 'lib-search' })));
assert.match(opened, /aria-expanded="true"/);
assert.match(opened, /aria-controls="[^"]+-panel"/);
assert.match(opened, /role="region"/);
assert.match(opened, /lib-search/);
assert.match(opened, /Thu gọn/);
assert.match(opened, /Đang tải…/);

assert.match(ui, /x-review-replayed/, 'a replayed rating is not counted as newly mastered');
assert.match(ui, /fetchCardTiers\(ids, ctrl\.signal\)/);
assert.match(ui, /tierAsked\.current\.has\(id\)/, 'tiers are asked once per card, not per rating');

// ── Card Studio never saves by itself; AI only from explicit buttons ──────────────────────────
const studio = read(T + 'tides/CardStudio.tsx');
assert.equal((studio.match(/saveStudioCard\(/g) || []).length, 1);
assert.ok(studio.indexOf('saveStudioCard(') > studio.indexOf('const saveSelected = async'), 'saves only inside the learner\'s "Lưu" action');
assert.match(studio, /selected: !c\.alreadySaved/, 'a word the learner already has starts unselected');
assert.doesNotMatch(studio, /useEffect\([^)]*generateStudioDrafts/s, 'opening the Studio sends nothing');
const api = read('services/flashcardMemoryApi.ts');
for (const path of ['/flashcards/studio/drafts', '/flashcards/memory/forge', '/flashcards/memory/fusion/check']) assert.match(api, new RegExp(`apiClient\\.post<[^>]+>\\("${path.replace(/\//g, '\\/')}"`));
const reader = read('components/features/reading/InteractiveReader.tsx');
const open = reader.slice(reader.indexOf('const handleOpenStudio'), reader.indexOf('const handleOpenFlashcard'));
assert.doesNotMatch(open, /apiClient|fetch\(/, 'opening the Studio from Reading makes no request');
const tools = read('components/features/reading/books/SelectionTools.tsx');
// The My Books reader files are frozen (10 §AO): no Card Studio entry in its toolbar without an explicit owner decision.
assert.doesNotMatch(tools, /CardStudio|setStudioText|Echo AI/, 'the frozen My Books toolbar has no Card Studio entry');

const studioMod = evaluate(T + 'tides/CardStudio.tsx', {
  react: React, 'next/link': ({ children }) => children, 'lucide-react': { Check: icon, Loader2: icon, RotateCcw: icon, Trash2: icon, X: icon },
  '@/components/common/BrandWhaleIcon': { BrandWhaleIcon: icon },
  '@/services/flashcardMemoryApi': { generateStudioDrafts() { throw new Error('no AI on render'); }, saveStudioCard() { throw new Error('no save on render'); }, isCancelled: () => false, memoryAiError: () => ({ message: '', upgrade: false }) },
  './TidesDialog': evaluate(T + 'tides/TidesDialog.tsx', { react: React, 'lucide-react': { X: icon }, './memoryTides.module.css': css }),
  './memoryTides.module.css': css,
  './useEchoAiAllowance': { useEchoAiAllowance: () => allowanceStub },
});
let allowanceStub = { allowed: true, isPremium: false, exhaustedNote: null, refresh() {}, openUpgrade() {}, badge: React.createElement('i', null, 'Còn 3/3 lượt AI hôm nay'), upgradeModal: null };
const studioHtml = renderToString(React.createElement(studioMod.CardStudio, { open: true, onClose() {}, initialText: 'The council will look into the delays.', sourceLabel: 'City news' }));
assert.match(studioHtml, /Echo AI Card Studio/);
assert.match(studioHtml, /Phân tích với Echo AI/);
assert.match(studioHtml, /City news/);
assert.match(studioHtml, /AI tạo Flashcard[\s\S]*Còn 3\/3 lượt AI hôm nay/, 'the Studio shows the shared site-wide AI allowance');
allowanceStub = { ...allowanceStub, allowed: false, exhaustedNote: 'Bạn đã dùng hết lượt AI miễn phí hôm nay (dùng chung cho mọi tính năng AI). Lượt mới có vào 0:00.' };
const spentHtml = renderToString(React.createElement(studioMod.CardStudio, { open: true, onClose() {}, initialText: 'The council will look into the delays.' }));
assert.match(spentHtml, /dùng hết lượt AI miễn phí hôm nay/);
assert.match(spentHtml, /<button[^>]*disabled=""[^>]*>[\s\S]{0,80}Phân tích với Echo AI/, 'no AI request is offered once the shared allowance is spent');
// one allowance system: the three dialogs use the site-wide hook, which is built only from the existing premium pieces
const allowanceSrc = read(T + 'tides/useEchoAiAllowance.tsx');
assert.match(allowanceSrc, /usePremiumEntitlement/);
assert.match(allowanceSrc, /PremiumFeatureBadge/);
assert.match(allowanceSrc, /PremiumUpgradeModal/);
assert.doesNotMatch(allowanceSrc, /localStorage|apiClient|fetch\(/, 'no client-side counter, no own request');
for (const [file, key] of [['CardStudio.tsx', 'FLASHCARD_AI_STUDIO'], ['MemoryForge.tsx', 'FLASHCARD_MEMORY_FORGE'], ['CardFusion.tsx', 'FLASHCARD_FUSION_CHECK']]) {
  assert.match(read(T + 'tides/' + file), new RegExp(`useEchoAiAllowance\\("${key}"`), `${file} uses the shared allowance under its own feature key`);
}
assert.equal(renderToString(React.createElement(studioMod.CardStudio, { open: false, onClose() {} })), '');

// ── Presentation rules for every new file ─────────────────────────────────────────────────────
const tideFiles = readdirSync(new URL('../src/' + T + 'tides/', import.meta.url));
for (const f of tideFiles) {
  const src = read(T + 'tides/' + f);
  assert.doesNotMatch(src, /Sparkles|✨/, f + ': no sparkle');
  assert.doesNotMatch(src, /[\u{1F300}-\u{1FAFF}]/u, f + ': no decorative emoji');
  if (f.endsWith('.css')) {
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /backdrop-filter|!important|font-family/, f + ': no blur, no important flag, no own typeface');
    assert.match(src, /prefers-reduced-motion: reduce/, f + ': reduced motion handled');
  }
  if (f.endsWith('.tsx')) assert.doesNotMatch(src.replace(/&&|&amp;|&#/g, ''), />[^<{]*&[^<]*</, f + ': no "&" in display copy');
}

// ── Backend invariants ────────────────────────────────────────────────────────────────────────
const mig = readRepo('backend/src/main/resources/db/migration/exams/V116__echo_memory_tides.sql');
assert.match(mig, /BEFORE UPDATE OR DELETE ON public\.flashcard_review_log/);
assert.match(mig, /CHECK \(quality IN \('hard', 'good', 'easy'\)\)/);
assert.match(mig, /REFERENCES public\.users\(id\) ON DELETE RESTRICT/);
assert.doesNotMatch(mig, /ON DELETE CASCADE|DROP TABLE|DROP COLUMN|ALTER TABLE|UPDATE public\.flashcards/);
const svc = readRepo('backend/src/main/java/com/englishcoach/flashcard/service/FlashcardService.java');
const rv = svc.slice(svc.indexOf('public ReviewOutcome review('), svc.indexOf('public Flashcard submitReview'));
assert.ok(rv.indexOf('return new ReviewOutcome(withDeckSense(card), true);') < rv.indexOf('reviewLog.record('), 'a replayed key writes no log row');
assert.ok(rv.indexOf('saveAndFlush(card)') < rv.indexOf('reviewLog.record('), 'log row in the same transaction, after the stored rating');
const ctl = readRepo('backend/src/main/java/com/englishcoach/flashcard/memory/FlashcardMemoryController.java');
assert.equal((ctl.match(/@RequirePremiumAi\(value = "FLASHCARD_[A-Z_]+", reuseClientRequestId = false\)/g) || []).length, 3);
assert.equal((ctl.match(/@PostMapping/g) || []).length, 3, 'only the three explicit AI actions write or call AI');
const mem = readRepo('backend/src/main/java/com/englishcoach/flashcard/memory/FlashcardMemoryService.java');
assert.doesNotMatch(mem, /UPDATE public\.flashcards|INSERT INTO public\.flashcards|next_review_date/, 'Memory Tides never changes cards or schedules');
assert.match(mem, /owner_user_id IS NULL AND lower\(word\)/, 'Studio IPA / CEFR come from the shared dictionary only');
const ai = readRepo('backend/src/main/java/com/englishcoach/flashcard/memory/MemoryAi.java');
assert.match(ai, /WordForms\.uses\(sentence, first\) && WordForms\.uses\(sentence, second\)/);
const evo = readRepo('backend/src/main/java/com/englishcoach/flashcard/memory/MemoryEvolution.java');
assert.match(evo, /PEARL_DAYS = 3;/);
assert.match(evo, /PEARL_SPAN_DAYS = 14;/);
const vault = read(T + 'tides/MemoryVault.tsx');
assert.match(vault, /ít nhất 3 ngày khác nhau, cách nhau từ 14 ngày/, 'the shown Pearl rule is the server rule');

// V117: a Studio card shows ONLY its approved contextual sense; every older card renders exactly as before
const { cardFace } = evaluate(T + 'cardFace.ts');
const dictRow = { word: 'struggle', ipa: '/ˈstrʌɡl/', generalTranslationVi: 'đấu tranh', meanings: ['a hard fight in which people try to obtain something'], examples: ['Marx wrote about the class struggle.'] };
const studioFace = cardFace({ dictionaryEntry: dictRow, customMeaning: 'chật vật', customExample: 'The children struggled to make a decision.',
  customDefinition: 'to try hard to do something difficult', customPartOfSpeech: 'verb', customExampleVi: 'Bọn trẻ đã chật vật để đưa ra quyết định.' });
same(studioFace.definitions, ['to try hard to do something difficult'], 'only the approved definition');
same(studioFace.examples, ['The children struggled to make a decision.'], 'only the approved example (no other-sense example)');
same(studioFace.exampleTranslations, ['Bọn trẻ đã chật vật để đưa ra quyết định.']);
assert.equal(studioFace.partOfSpeech, 'verb');
assert.equal(studioFace.headline, 'chật vật');
assert.equal(studioFace.ipa, '/ˈstrʌɡl/', 'IPA still comes from the dictionary');
const legacyFace = cardFace({ dictionaryEntry: dictRow, customMeaning: 'chật vật', customExample: 'The children struggled to make a decision.' });
same(legacyFace.definitions, ['a hard fight in which people try to obtain something'], 'a card without a contextual sense is unchanged');
same(legacyFace.examples, ['The children struggled to make a decision.', 'Marx wrote about the class struggle.']);
assert.equal(legacyFace.partOfSpeech, null);
assert.match(read(T + 'tides/CardStudio.tsx'), /definition: same \? d\.definitionEn : null, partOfSpeech: same \? d\.partOfSpeech : null, exampleVi: same \? d\.sentenceVi : null/, 'Studio saves the approved sense only for the term Echo analysed');

console.log('Echo Memory Tides: PASS (recall helpers, Deep Recall / cloze renders, ratings only on the back, tier edge, one study timeline (back-ready ratings, stored-rating effects from the real button, exit / enter), folded library bar, Studio explicit-only and approval-only saves, presentation rules, backend invariants).');
