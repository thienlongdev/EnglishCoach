// Cộng đồng — "Echo Ocean · The Living Community" (2026-10-23) contract: presentation only. Rules: .claude/architecture/10-rules-frozen.md §AR.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const sha = (p) => createHash('sha256').update(readFileSync(new URL('../src/' + p, import.meta.url))).digest('hex');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const C = 'components/community/';
const page = read('app/community/page.tsx');
const glass = read(C + 'CommunityGlass.tsx');
const css = read(C + 'communityGlass.module.css');
const userCard = read(C + 'CommunityUserCard.tsx');
const composer = read(C + 'PostComposer.tsx');
const card = read(C + 'PostCard.tsx');
const trending = read(C + 'TrendingSidebar.tsx');
const all = [page, glass, userCard, composer, card, trending, read(C + 'CommunityRulesCard.tsx')].join('\n');

check('the Community data layer is byte-pinned (API client, user-scoped cache, types)', () => {
  const pins = {
    'services/communityApi.ts': 'a4f5e46a770bda1b42efec58323d1bf8900c8619e10e18e864da60ed512d926d',
    'services/communityCache.ts': '32b3d67a4b566bb4989f779698fa97a0f80390bf61d9b7809c81a44b9bb1f9ba',
    'types/community.ts': '300eb38d5e80d4697bc493fa472728b4cb53b61aee8b8dcd17cbc98bb3b62691',
  };
  for (const [file, hash] of Object.entries(pins)) assert.equal(sha(file), hash, `${file} changed: not a presentation change — update the pin in the same reviewed change`);
});

check('identity: real streak from the shared streak hook, PRO from the entitlement, no invented CEFR / streak defaults', () => {
  assert.match(userCard, /useUnifiedStreak\(\)/);
  assert.match(userCard, /streak\?\.currentStreakDays/);
  assert.match(userCard, /streakDays !== undefined &&/);
  assert.doesNotMatch(userCard, /'B1'|\?\? 0|targetCefr|currentCefr/);
});

check('hero shortcuts only preset the composer with a real post type (no new request, no invented action)', () => {
  const types = [...glass.matchAll(/type: '([A-Z_]+)', tone/g)].map((m) => m[1]);
  assert.deepEqual(types, ['QUESTION', 'CORRECTION_REQUEST', 'ACHIEVEMENT']);
  for (const t of types) assert.match(composer, new RegExp(`type: '${t}'`), `${t} is a composer type`);
  assert.match(composer, /preset\?: \{ type: PostType; nonce: number \} \| null/);
  assert.doesNotMatch(glass, /communityApi|fetch\(/);
});

check('honest feed states: a failed first page shows Retry, never "no posts"; loading is a skeleton, not numbers', () => {
  assert.match(page, /posts\.length === 0 && loadFailed \?/);
  assert.match(page, /setLoadFailed\(true\)/);
  assert.match(page, /<FeedSkeleton \/>/);
});

check('no fabricated social numbers: hero and panels show none; trending meta is the server label / post count', () => {
  assert.doesNotMatch(glass, /\d+(\.\d+)?K|thành viên|online|đang hoạt động/i);
  assert.match(trending, /topic\.label \|\| \(topic\.postCount \? `\$\{topic\.postCount\} bài` : 'Nổi bật'\)/);
});

check('one <main> per page: the feed is a section inside the app shell main', () => {
  assert.doesNotMatch(page, /<main[\s>]/);
});

check('dialogs rendered into <body> carry the Community token world', () => {
  for (const f of ['PostDetailModal.tsx', 'ShareSheet.tsx', 'ReactionSummaryModal.tsx', 'ReportModal.tsx', 'ComposerEmojiPicker.tsx', 'ReactionBar.tsx', 'CommentItem.tsx']) {
    assert.match(read(C + f), /\$\{styles\.world\} (fixed inset-0|z-\[)/, f);
  }
});

check('hero art: content-hashed rendered stills that exist in public/', () => {
  const names = [...glass.matchAll(/\/assets\/community\/(community-hero-\d+-[0-9a-f]{8}\.webp)/g)].map((m) => m[1]);
  assert.equal(names.length, 2);
  for (const n of names) assert.ok(existsSync(new URL('../public/assets/community/' + n, import.meta.url)), n);
});

check('material rules: no backdrop blur, no !important, no own typeface, reduced motion, wallpaper-transparent page', () => {
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /backdrop-filter|!important|font-family/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:global\(html\[data-wallpaper\]\) \.page \{ background: transparent; \}/);
  assert.match(css, /:global\(\.dark\) \.world \{/);
  const world = css.slice(css.indexOf('\n.world {'), css.indexOf(':global(.dark) .world {'));
  assert.doesNotMatch(world, /\n {2}(position|isolation|transform|filter|contain|container-type):/, '.world must not trap fixed dialogs');
  assert.doesNotMatch(all, /backdrop-blur/);
});

check('no sparkle icon or emoji in the Community chrome', () => {
  assert.doesNotMatch(all, /Sparkles|✨/);
});

console.log(`Community Echo Glass PASS (${passed} checks)`);
