// Typography contract (owner brief 2026-10-15; 2026-10-31: the landing hero joins Quicksand too): Quicksand is the one product typeface; formerly Plus Jakarta Sans existed only on
// the public landing hero headline; no first-party code keeps another sans by accident.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
const read = (p) => readFileSync(join(root, p), 'utf8');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(name)) files.push(p);
  }
})(src);
const rel = (p) => relative(root, p).replace(/\\/g, '/');

const layout = read('src/app/layout.tsx');
assert.match(layout, /import \{ Quicksand \} from 'next\/font\/google'/);
assert.match(layout, /variable: '--font-quicksand'/);
assert.match(layout, /subsets: \['latin', 'vietnamese'\]/);
assert.doesNotMatch(layout, /fonts\.googleapis\.com\/css2\?family=(?!Material\+Symbols)/, 'text fonts are self-hosted by next/font');

const jakarta = files.filter((f) => /Plus_Jakarta_Sans/.test(readFileSync(f, 'utf8'))).map(rel);
assert.deepEqual(jakarta, [], 'Plus Jakarta Sans is gone: the landing hero is Quicksand too (owner brief 2026-10-31)');
const hero = read('src/components/landing/LandingHero.tsx');
assert.match(hero, /<h1 ref=\{titleRef\} className=\{`\$\{styles\.heroTitle\}/);
assert.match(read('src/components/landing/landing.module.css'), /\.heroTitle \{[^}]*font-family: var\(--font-quicksand\)/);

// My Books (2026-10-16): Literata is the book body's own typeface, declared once in the lazily loaded reader module,
// never preloaded, and used only inside the reader's shadow root (as --ec-font); the shelf and controls stay Quicksand.
const literata = files.filter((f) => /\bLiterata\(/.test(readFileSync(f, 'utf8')) || /from 'next\/font\/google'|from "next\/font\/google"/.test(readFileSync(f, 'utf8')) && /Literata/.test(readFileSync(f, 'utf8'))).map(rel);
assert.deepEqual(literata, ['src/components/features/reading/books/literata.ts'], 'Literata is declared only by the My Books reader');
const literataSource = read('src/components/features/reading/books/literata.ts');
assert.match(literataSource, /preload: false/, 'the book face is never preloaded');
assert.match(literataSource, /subsets: \["latin", "latin-ext", "vietnamese"\]/);
assert.equal(files.filter((f) => /literata\.style\.fontFamily/.test(readFileSync(f, 'utf8'))).map(rel).join(), 'src/components/features/reading/books/BookReader.tsx', 'only the book reader hands Literata to the book');

const tailwind = read('tailwind.config.ts');
const families = tailwind.slice(tailwind.indexOf('fontFamily: {'), tailwind.indexOf('fontSize: {'));
for (const [, key, value] of families.matchAll(/'?([\w-]+)'?: \[([^\]]+)\]/g)) assert.match(value, /^'var\(--font-quicksand\)'/, `tailwind font ${key} → Quicksand`);
assert.match(read('src/app/globals.css'), /body \{[^}]*font-family: var\(--font-quicksand\)/);

for (const f of files) {
  const text = readFileSync(f, 'utf8');
  assert.doesNotMatch(text, /--font-(inter|newsreader|be-vietnam-pro|jakarta)\b|font-newsreader/, rel(f) + ': retired font variable');
  assert.doesNotMatch(text, /font-family:\s*['"]?(Inter|Be Vietnam Pro|Newsreader|Roboto)\b/i, rel(f) + ': stray first-party font');
}
console.log('Typography: PASS (Quicksand self-hosted for the whole product including the landing hero, every Tailwind family → Quicksand, no retired font variables).');
