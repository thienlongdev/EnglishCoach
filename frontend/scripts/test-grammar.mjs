// Contract for Echo Grammar Academy and for the routing change that shipped with it (owner brief 2026-11-01; docs/grammar/ROUTING.md,
// docs/grammar/FRONTEND-SPEC.md). Source-level guards: the browser journey is docs/grammar/evidence/journey.cjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(src, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(src, rel));
const ok = (name) => console.log(`  -> PASS: ${name}`);
const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};
const rel = (p) => path.relative(src, p).split(path.sep).join('/');

// 1. The sidebar: "Ngữ pháp" directly after "Thẻ từ vựng", on its own path, with exact labels in both languages.
const sidebar = read('components/layout/Sidebar.tsx');
const navBlock = sidebar.slice(sidebar.indexOf('const NAV_CONFIG = ['));
const navEnd = navBlock.search(/\n\]\s*\n/);
const entries = [...navBlock.slice(0, navEnd).matchAll(/tab:\s*"([A-Za-z]+)"[\s\S]*?href:\s*"([^"]+)"/g)].map((m) => ({ tab: m[1], href: m[2] }));
const tabs = entries.map((e) => e.tab);
assert.ok(tabs.includes('flashcards') && tabs.includes('grammar'), 'both entries exist');
assert.equal(tabs.indexOf('grammar'), tabs.indexOf('flashcards') + 1, `Ngữ pháp sits directly after Thẻ từ vựng (${tabs.join(' > ')})`);
assert.equal(entries.find((e) => e.tab === 'grammar').href, '/grammar', 'the entry goes to /grammar');
assert.ok(/labelKey:\s*"grammar"\s+as const/.test(navBlock), 'the entry is labelled through the label table');
const labels = read('lib/exams/labels.ts');
assert.ok(/flashcards: 'Thẻ từ vựng',\s*\n\s*grammar: 'Ngữ pháp',/.test(labels), 'vi label is exactly "Ngữ pháp", next to Thẻ từ vựng');
assert.ok(/grammar: 'Grammar',/.test(labels), 'en label is "Grammar"');
assert.ok(sidebar.includes('pathname === "/grammar" || pathname.startsWith("/grammar/")'), 'the entry stays lit on every grammar page');
ok('sidebar: Ngữ pháp directly after Thẻ từ vựng, exact label, lit on /grammar/**');

// 2. Every route of the module exists.
for (const route of [
  'app/grammar/layout.tsx', 'app/grammar/page.tsx', 'app/grammar/library/page.tsx', 'app/grammar/topics/[slug]/page.tsx',
  'app/grammar/practice/page.tsx', 'app/grammar/check/[id]/page.tsx', 'app/grammar/mistakes/page.tsx',
  'app/grammar/lab/page.tsx', 'app/grammar/lab/[id]/page.tsx', 'app/grammar/stories/page.tsx', 'app/grammar/stories/[id]/page.tsx',
  'app/grammar/detective/page.tsx', 'app/grammar/detective/[id]/page.tsx',
  'app/grammar/ielts/page.tsx', 'app/grammar/toeic/page.tsx', 'app/grammar/real-world/page.tsx',
]) assert.ok(exists(route), `${route} exists`);
assert.ok(/AuthGuard/.test(read('app/grammar/layout.tsx')), 'the section is behind the sign-in guard');
ok('routes: the whole /grammar tree');

// 3. Laws of the codebase, scanned over the module's own files.
const files = [
  ...walk(path.join(src, 'components/features/grammar')), ...walk(path.join(src, 'app/grammar')), ...walk(path.join(src, 'lib/grammar')),
  path.join(src, 'hooks/useGrammar.ts'), path.join(src, 'services/grammarApi.ts'), path.join(src, 'types/grammar.ts'),
].filter((f) => fs.existsSync(f) && /\.(tsx?|css|mjs)$/.test(f));
assert.ok(files.length > 40, `module files found (${files.length})`);
const literal = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|(?<![=>-])>[^<>{}\n]*(?=[<{])/g;
const wordAmp = /[^\W\d_)] (?:&|&amp;) [^\W\d_(]/u;
const emoji = /[\u{1F300}-\u{1FAFF}\u{2728}\u{2B50}\u{1F900}-\u{1F9FF}]/u;
const bad = [];
for (const file of files) {
  // Comments may name a rule ("no `!important`"); only code and styles are judged.
  const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const name = rel(file);
  const isCss = file.endsWith('.css');
  const isCode = /\.(tsx?|mjs)$/.test(file) && !name.endsWith('.generated.ts');
  if (/Sparkles/.test(text)) bad.push(`${name}: Sparkles`);
  if (emoji.test(text)) bad.push(`${name}: emoji or sparkle character`);
  if (/backdrop-filter|backdropFilter|backdrop-blur/.test(text)) bad.push(`${name}: backdrop blur`);
  if (/!important/.test(text)) bad.push(`${name}: !important`);
  if (isCss && /prefers-color-scheme/.test(text)) bad.push(`${name}: theme must follow the explicit .dark class, not prefers-color-scheme`);
  if (isCss && /font-family\s*:/.test(text.replace(/font-family\s*:\s*(var\(--font-mono[^;]*|ui-monospace[^;]*|[^;]*IPA[^;]*|inherit)\s*;/gi, ''))) bad.push(`${name}: an own typeface`);
  if (isCode) {
    if (/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(text)) bad.push(`${name}: a markup or code sink`);
    text.split('\n').forEach((line, i) => {
      const s = line.trim();
      if (!line.includes('&') || s.startsWith('//') || s.startsWith('*') || s.startsWith('import ')) return;
      for (const m of line.matchAll(literal)) if (wordAmp.test(m[0])) bad.push(`${name}:${i + 1}: "&" in copy`);
    });
  }
}
assert.deepEqual(bad, [], `the module breaks a law:\n${bad.join('\n')}`);
ok(`laws: ${files.length} files without Sparkles, emoji, backdrop blur, !important, own typeface, markup sinks or "&" in copy`);

// 4. The learner API carries no answer key and no user id.
const types = read('types/grammar.ts');
const exerciseBody = types.slice(types.indexOf('export interface Exercise {'), types.indexOf('export type Answer'));
for (const forbidden of ['key', 'answer', 'answers', 'accept', 'correct', 'ok', 'explain', 'note', 'notes', 'fix', 'model', 'expected', 'checklist', 'why', 'rubric']) {
  assert.ok(!new RegExp(`[{;\\s]${forbidden}\\??:`).test(exerciseBody.replace(/options\?:[^\n]*|blanks\?:[^\n]*/g, '')), `the learner's Exercise has no "${forbidden}" field`);
}
assert.ok(/no keys, notes or explanations/.test(types), 'the contract says so');
const api = read('services/grammarApi.ts');
assert.ok(!/userId|user_id|ownerUserId|\buser\b/i.test(api.replace(/\/\*\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')), 'no call names a user: the principal decides');
for (const m of api.matchAll(/apiClient\.(?:get|post|put|delete)[^`'(]*[`'(]\s*[`']?(\/[a-z/${}.()]*)/g)) assert.ok(m[1].startsWith('/grammar'), `${m[1]} stays under /grammar`);
const hook = read('hooks/useGrammar.ts');
assert.ok(/\['grammar-me',\s*\w+/.test(hook) || /grammar-me/.test(hook), 'learner data is cached under a key with the user');
assert.ok(/\['grammar-catalog'\]/.test(hook) && /grammar-topic/.test(hook), 'content is a shared cache');
const clean = read('lib/auth-cache-cleanup.ts');
assert.ok(clean.includes('mutate(() => true') && clean.includes('sessionStorage.clear()') && clean.includes('localStorage.clear()'), 'sign-out clears every SWR key and both storages, grammar included');
ok('learner API: no key fields, no user id, scoped caches, cleared at sign-out');

// 5. The AI is never reached by a passive event: one explicit call.
const professor = read('components/features/grammar/Professor.tsx');
assert.equal((professor.match(/askProfessor\(/g) ?? []).length, 1, 'one explicit call to the professor');
for (const file of files.filter((f) => f.endsWith('.tsx') && !f.endsWith('Professor.tsx'))) assert.ok(!/askProfessor/.test(fs.readFileSync(file, 'utf8')), `${rel(file)} never calls the professor`);
assert.ok(/onClick=\{[^}]*ask/i.test(professor) || /onSubmit/.test(professor), 'asked only from a press');
ok('AI: only an explicit press asks the Professor');

// 6. The routing change (docs/grammar/ROUTING.md).
const routes = await import(new URL('../src/lib/navigation/routes.ts', import.meta.url).href);
assert.deepEqual([...routes.ROOT_MODULES], ['dashboard', 'flashcards', 'reading', 'writing', 'leaderboard']);
for (const m of routes.ROOT_MODULES) assert.ok(exists(`app/(workspace)/${m}/page.tsx`), `/${m} is a real route`);
assert.equal(routes.moduleHref('grammar'), '/grammar');
assert.equal(routes.canonicalHref('/?tab=writing&w=coach'), '/writing?w=coach');
assert.equal(routes.canonicalHref('/?tab=reading&materialId=1'), '/reading?materialId=1');
assert.equal(routes.canonicalHref('/?tab=flashcards&review=due'), '/flashcards?review=due');
assert.equal(routes.canonicalHref('/?tab=leaderboard&lbPeriod=WEEK&lbScope=GLOBAL'), '/leaderboard?lbPeriod=WEEK&lbScope=GLOBAL');
assert.equal(routes.canonicalHref('/?tab=speaking'), '/speaking');
assert.equal(routes.canonicalHref('/?tab=exams'), '/exams');
assert.equal(routes.canonicalHref('/?tab=landing'), '/?tab=landing', 'the landing is not a module');
assert.equal(routes.canonicalHref('/?x=1'), '/?x=1');
assert.equal(routes.rootModuleOf('/reading'), 'reading');
assert.equal(routes.rootModuleOf('/reading/1'), null);
assert.deepEqual(routes.legacyView('/writing', null), { pathname: '/', tab: 'writing' });
const proxy = read('proxy.ts');
assert.ok(/NextResponse\.redirect\(new URL\(target, request\.nextUrl\), 307\)/.test(proxy), 'the old address answers a temporary redirect (a rollback must not loop on a cached 308)');
assert.ok(!/\b308\b|permanent/i.test(proxy.slice(proxy.indexOf('canonicalHref') - 400, proxy.indexOf('canonicalHref') + 400)), 'never a permanent redirect');
const layout = read('app/(workspace)/layout.tsx');
assert.ok(/<WorkspaceTabs/.test(layout), 'one mounted layout for the five modules');
for (const m of routes.ROOT_MODULES) assert.ok(!/return\s*\(?\s*</.test(read(`app/(workspace)/${m}/page.tsx`).replace(/export default function[^{]*\{\s*return null/, '')) || /return null/.test(read(`app/(workspace)/${m}/page.tsx`)), `/${m} renders nothing of its own`);
const home = read('components/landing/Home.tsx');
assert.ok(/isLanding \? <LandingPage \/>/.test(home), '/ is the Landing');
ok('routing: canonical addresses, parameters kept, 307, one layout, / is the Landing');

console.log('\nALL GRAMMAR CONTRACTS PASSED');
