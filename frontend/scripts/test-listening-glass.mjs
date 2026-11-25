// Nghe — "Echo Glass · Sonic Universe" (2026-10-23) contract: presentation only. Rules: .claude/architecture/10-rules-frozen.md §AP.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const sha = (p) => createHash('sha256').update(readFileSync(new URL('../src/' + p, import.meta.url))).digest('hex');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const page = read('app/listening/page.tsx');
const lesson = read('components/features/listening/workspace/LessonWorkspace.tsx');
const practice = lesson;
const stats = read('app/listening/dashboard/page.tsx');
const dictation = read('components/features/listening/DictationExercise.tsx');
const sharedCard = read('components/features/listening/SharedListeningCard.tsx');
const ownCard = read('components/features/listening/ListeningMaterialCard.tsx');
const glassTsx = read('components/features/listening/glass/ListeningGlass.tsx');
const css = read('components/features/listening/glass/listeningGlass.module.css');
const all = [page, lesson, practice, stats, dictation, sharedCard, ownCard, glassTsx].join('\n');

check('owner-authorized free-seek player revision; shared timing, resolver and import APIs remain pinned', () => {
  const pins = {
    'components/features/listening/AdvancedAudioPlayer.tsx': '0d13fb24cf6f6c7336a5796f627b3748f27f13146534be9e3fe4cce382cd80f1',
    'components/features/listening/PrivateAudioPlayer.tsx': '70cd56892e29aeb48c7b63eb67380e4420286c3d82f249919ca68673633927aa',
    'components/features/listening/transcript-timing.ts': '0b47e62589651b06f9587617327692a3bb05ca841e399bdc9555d4260c026620',
    'lib/listeningPractice.ts': 'c4e9b28266e7ffd7ec71481b2c0fdca90f80e65c09ab8a56f1d5504d2b1aa81a',
    'services/listeningApi.ts': '162b6031b867c70e2337686db1db80fd2a141bd0a10a40ee2988367139f6540e',
    'services/listeningDocumentApi.ts': '53367623b49736f8d205b1c333eb1d77077b851aacc8c68738554ce1f844b08b',
  };
  for (const [file, hash] of Object.entries(pins)) assert.equal(sha(file), hash, `${file} changed: an owner decision, update the pin in the same change`);
});

check('one Import control on /listening (owner rule)', () => {
  assert.equal((page.match(/setIsImportOpen\(true\)/g) || []).length, 1);
});

check('no invented defaults: no fallback CEFR / accent / topic / duration / progress', () => {
  assert.doesNotMatch(all, /\|\|\s*'B2'|\?\?\s*'B2'|\|\|\s*'International'|\|\|\s*'American'|\|\|\s*'General'|'00:00'/);
  assert.doesNotMatch(page, /progress \|\| 35|progress \|\| 25|Đã luyện ~/, 'the resume entry claims no progress');
  assert.doesNotMatch(lesson, /progress:/, 'the lesson writes no invented progress for the resume entry');
});

check('no fake controls: no "coming soon" community stub, no decorative microphone in the answer field', () => {
  assert.doesNotMatch(practice + dictation, /Sắp ra mắt|Bình luận \(/);
  assert.doesNotMatch(dictation, /<Mic\b/);
  assert.doesNotMatch(all, /<Sparkles|✨/);
});

check('dictation keeps the server-side scoring path and only shows what the server returned', () => {
  assert.match(dictation, /submitExerciseAttempt\(exerciseId, \{\s*listeningSessionId: effectiveSessionId \?\? undefined,\s*rawUserAnswer: rawAnswer\s*\}\)/);
  assert.match(dictation, /export function getAsteriskMaskHint/);
  assert.match(dictation, /kind !== 'revealed'/, 'a revealed sentence never shows an accuracy');
  assert.match(practice, /completeListeningSession\(activeSessionId\)/, 'finishing still completes the server session');
  assert.match(practice, /o\.kind !== 'revealed'/, 'the run average excludes revealed sentences');
});

check('unknown counts read "…" / "—", never a fake 0', () => {
  assert.match(page, /categoriesData === undefined \? '—'/);
  assert.match(page, /personalData === undefined && !cachedPersonal \? '—'/);
});

check('a document import never gets a video thumbnail', () => {
  assert.match(ownCard, /const thumbnailUrl = isDocument \? null :/);
});

check('hero art: content-hashed rendered stills that exist in public/', () => {
  const names = [...glassTsx.matchAll(/\/assets\/listening\/(listening-[a-z]+-\d+-[0-9a-f]{8}\.webp)/g)].map((m) => m[1]);
  assert.equal(names.length, 4);
  for (const n of names) assert.ok(existsSync(new URL('../public/assets/listening/' + n, import.meta.url)), n);
});

check('hero art covers the whole hero (no picture edge or strand end inside a wide hero; 2026-10-23 seam repair)', () => {
  assert.equal([...glassTsx.matchAll(/listening-[a-z]+-(\d+)-[0-9a-f]{8}\.webp/g)].filter((m) => !['1920', '3840'].includes(m[1])).length, 0, 'the 4.8 : 1 panoramas only');
  const art = css.slice(css.indexOf('.heroArt {'), css.indexOf('.heroArt img {'));
  assert.match(art, /inset: 0;/);
  assert.doesNotMatch(art, /aspect-ratio/);
  assert.match(css, /\.heroArt img \{[^}]*object-fit: cover;[^}]*object-position: 100%/);
  assert.doesNotMatch(css + glassTsx, /heroCurrent/, 'straight streaks never followed the curved ribbons');
});

check('material rules: no backdrop blur, no !important, no own typeface, reduced motion stops the module', () => {
  assert.doesNotMatch(css, /backdrop-filter|!important|font-family:(?!\s*ui-monospace)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.page\[data-world="personal"\]/);
  assert.match(css, /:global\(html\[data-wallpaper\]\) \.page/);
});

console.log(`Listening Echo Glass PASS (${passed} checks)`);
