// Viết — "Echo Glass · Writing Universe" (2026-10-23) contract: presentation only. Rules: .claude/architecture/10-rules-frozen.md §AQ.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = new URL('../src/', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const sha = (p) => createHash('sha256').update(readFileSync(new URL(p, root))).digest('hex');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const W = 'components/features/writing/';
const walk = (dir) => readdirSync(new URL(dir, root)).flatMap((f) => {
  const rel = `${dir}${f}`;
  return statSync(new URL(rel, root)).isDirectory() ? walk(`${rel}/`) : [rel];
});
const sources = walk(W).filter((f) => f.endsWith('.tsx') && !f.endsWith('ForYou.tsx'));
const all = sources.map(read).join('\n');
const css = read(`${W}glass/writingGlass.module.css`).replace(/\/\*[\s\S]*?\*\//g, ''); // rules only, not the comments
const glassTsx = read(`${W}glass/WritingGlass.tsx`);

check('scoring, timing, history, persistence, routing and the Writing APIs are byte-pinned (presentation only)', () => {
  const pins = {
    'lib/writing/typing-engine.ts': 'ec7fea2dbd5d4e1d0c0b4962e06b6a32615d947f499120f25b2e1ca78cc36d57',
    'lib/writing/typing-history.ts': '92bbdb49973d1a2c890bb36186aa9f23361ea4e796477b36c913f7b7b47895f8',
    'lib/writing/typing-preferences.ts': 'c2a6e8eab56e8666fb97e45c0363e96794f8ee6224cffa58cc61716ac10144ee',
    'lib/writing/recovery.ts': '6b839bf8d17c207a2487e23eb9afa852fc7a9de570e86e97015bfe4963bef882',
    'lib/writing/route-state.ts': '846d4f1a2f3ecff82697141eaa5f221a2615c9c784f809d5b35cf1f7da8e2375',
    'lib/writing/textarea-caret.ts': '6f6e65f2e20c9bbe3ec48af0080b88c3c9f728cb01ad3c83813ccf83c758842d',
    'services/writingApi.ts': '0212afe6dbb5595b6cd856a2c8fb78b1bc51c2403818dba3b7f9b394658109f3',
    'services/paragraphTranslationApi.ts': 'da8c5bb9067e1cf2d56286420c6933761af1a54fbc7886cbd8935c9fdd985c7f',
    'types/writing.ts': 'a5b85ef2a2432db3d5669ce5c77a76482b7bff0ea6087ab0aff0cd371a82e68d',
  };
  for (const [file, hash] of Object.entries(pins)) assert.equal(sha(file), hash, `${file} changed: an owner decision, update the pin in the same change`);
});

check('one studio world wraps every Writing screen; the five rooms keep their ids and order', () => {
  const module = read(`${W}WritingModule.tsx`);
  assert.equal((module.match(/<WritingStudio world=\{world\}>/g) || []).length, 3, 'gate, sign-in and the module itself');
  const nav = read(`${W}WritingNavigation.tsx`);
  const ids = [...nav.matchAll(/id: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['translation', 'sentence-lab', 'typing', 'coach', 'portfolio']);
  for (const world of ['translation', 'lab', 'typing', 'coach', 'portfolio']) assert.match(all, new RegExp(`world="${world}"`));
});

check('the fabricated labels and fake progress removed by this release do not return', () => {
  for (const banned of ['Động cơ ngôn ngữ v4.9', 'Cấp độ Trung cấp Nâng cao', 'Chuẩn hóa CEFR', 'strokeDashoffset="50.26"', '<span>⌘</span><span>F</span>',
    'isDone = wordCount', 'left-[72%]', "wordCount > 120 ? 'Nội dung vững'", 'Thử thách thích ứng trong mục Dành cho bạn', '>MSS<', '>CYC<', 'Hồ sơ đã đánh giá']) {
    assert.ok(!all.includes(banned), `fabricated UI came back: ${banned}`);
  }
  // a dimension without a server score reads "—", never 0 %
  assert.match(read(`${W}portfolio/Portfolio.tsx`), /match\.score != null \? match\.score : null/);
});

check('hero facts are the catalog / server / tab-history values only', () => {
  assert.match(read(`${W}translation/TranslationHome.tsx`), /value: sentenceCollections\.length/);
  assert.match(read(`${W}coach/TaskPicker.tsx`), /value: allTasks\.length/);
  assert.match(read(`${W}portfolio/Portfolio.tsx`), /value: stats\.completedCount/);
  assert.match(read(`${W}typing/TypingPractice.tsx`), /stats=\{history\.length \? \[/, 'typing shows numbers only when this tab has history');
});

check('the Coach stage rail is the server session stage, every stage mapped', () => {
  const coach = read(`${W}coach/WritingCoach.tsx`);
  for (const s of ['UNDERSTANDING', 'PLANNING', 'DRAFTING', 'ANALYZING', 'FEEDBACK_READY', 'REVISING', 'COMPLETED']) assert.match(coach, new RegExp(`${s}: \\d`));
  for (const f of ['coach/DraftEditor.tsx', 'coach/FeedbackPanel.tsx', 'coach/PlanningForm.tsx']) {
    assert.ok(!read(W + f).includes('chevron_right</span>\n\n          {/* 2. Drafting */}'), `${f} keeps no second step ribbon`);
  }
});

check('typing input guards, writing persistence and AI calls are unchanged in the components', () => {
  const typing = read(`${W}typing/TypingPractice.tsx`);
  assert.ok(typing.includes('onPaste={e => { e.preventDefault()') && typing.includes('onDrop={e => { e.preventDefault()'));
  assert.ok(typing.includes("if (Array.from(value).length > 8) { engine.abort();"), 'bulk input guard');
  const editor = read(`${W}coach/DraftEditor.tsx`);
  assert.match(editor, /debounceTimerRef\.current = setTimeout\(\(\) => \{\s*performSave\(newText\);\s*\}, 1500\);/);
  assert.match(editor, /writingApi\.submitPractice\(session\.id\)/);
  assert.match(read(`${W}sentence-lab/SentenceCheck.tsx`), /writingApi\.submitSentenceCheck\(\s*clean,\s*targetRegister,\s*contextNote \|\| undefined\s*\)/);
});

check('hero art: content-hashed files that exist, decorative', () => {
  const names = [...glassTsx.matchAll(/\/assets\/writing\/(writing-[a-z]+-(?:1280|2560)-[0-9a-f]{8}\.webp)/g)].map((m) => m[1]);
  assert.equal(names.length, 10);
  for (const n of names) assert.ok(existsSync(new URL(`../public/assets/writing/${n}`, import.meta.url)), `missing ${n}`);
  assert.match(glassTsx, /alt="" decoding="async"/);
  assert.match(glassTsx, /className=\{styles\.heroArt\} aria-hidden="true"/);
});

check('material rules: no !important, no backdrop blur, explicit .dark only, reduced motion, no sparkles', () => {
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(css, /backdrop-filter/);
  assert.doesNotMatch(css, /prefers-color-scheme/);
  assert.match(css, /:global\(\.dark\) \.studio \{/);
  assert.match(css, /:global\(html\[data-wallpaper\]\) \.studio \{ background: transparent; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /font-family:(?!\s*inherit)/, 'no own typeface');
  assert.doesNotMatch(all, /Sparkles|✨/);
  assert.doesNotMatch(all, /className="[^"]*![a-z]/, 'no Tailwind important modifiers');
});

console.log(`Writing glass contract: ${passed} checks passed.`);
