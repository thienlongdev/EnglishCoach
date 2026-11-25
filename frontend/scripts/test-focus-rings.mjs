// One focus treatment per field (2026-11-15): a ring that follows the field's own shape, never a square browser ring inside a rounded
// field and never two rings at once. Audit + photographs: docs/ui/focus-2026-11-15/evidence/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = p => readFileSync(join(root, p), 'utf8');
const require = createRequire(import.meta.url);
let passed = 0;
const check = async (name, fn) => { await fn(); passed += 1; console.log('  ok  ' + name); };

await check('`outline-hidden` (a Tailwind 4 name used by 40 fields) produces a utility under Tailwind 3', async () => {
  const postcss = require('postcss'), tailwind = require('tailwindcss'), plugin = require('tailwindcss/plugin');
  const config = read('tailwind.config.ts');
  assert.match(config, /addUtilities\(\{ "\.outline-hidden": \{ outline: "2px solid transparent", "outline-offset": "2px" \} \}\)/);
  const out = await postcss([tailwind({ content: [{ raw: '<i class="focus:outline-hidden"></i>' }], corePlugins: { preflight: false },
    plugins: [plugin(({ addUtilities }) => addUtilities({ '.outline-hidden': { outline: '2px solid transparent', 'outline-offset': '2px' } }))] })]).process('@tailwind utilities', { from: undefined });
  assert.match(out.css, /\.focus\\:outline-hidden:focus\s*\{\s*outline: 2px solid transparent;/);
});

await check('one default ring for fields that bring none, in the base layer (any component wins), never !important', () => {
  const g = read('src/app/globals.css');
  assert.match(g, /@layer base \{[\s\S]*:where\(input:not\(\[type="checkbox"\][^)]*\), textarea, select, \[contenteditable="true"\]\):focus-visible \{\s*outline: 2px solid rgb\(var\(--primary\) \/ 0\.55\);\s*outline-offset: 2px;/);
});

// A rule written for a whole world (`.world :is(button, input…):focus-visible`) out-ranks a plain `.field input:focus-visible`;
// each field rule below is written to win against its world's rule.
const FIXED = [
  ['src/components/features/grammar/academy.module.css', /\.heroField:focus-within input:focus-visible, \.lbSearch:focus-within input:focus-visible \{ outline: none; \}/],
  ['src/components/music/Music.module.css', /\.hub \.searchField input:focus-visible \{ outline: none; \}/],
  ['src/components/features/reading/glass/readingGlass.module.css', /\.page \.field:focus-visible \{ outline: none; \}/],
  ['src/components/features/reading/glass/readingGlass.module.css', /\.page \.editor textarea:focus-visible \{ outline: none; \}/],
  ['src/components/features/profile/profileGlass.module.css', /\.page \.input:focus-visible \{ outline: none; \}/],
  ['src/components/features/writing/glass/writingGlass.module.css', /\.studio :is\(textarea, select, input:not\([^)]*\)\):focus-visible \{ outline: none; \}/],
  ['src/components/features/listening/glass/listeningGlass.module.css', /\.page \.search input:focus-visible \{ outline: none;/],
  ['src/components/features/listening/glass/listeningGlass.module.css', /\.page \.answer :is\(textarea, input\):focus-visible \{ outline: none; \}/],
  ['src/components/features/listening/glass/listeningGlass.module.css', /\.modal :is\(\.input, \.select, \.area\):focus-visible \{ outline: none;/],
  ['src/components/features/exams/universe/examUniverse.module.css', /\.world \.search input:focus-visible \{ outline: none;/],
  ['src/components/features/exams/universe/examUniverse.module.css', /\.world \.select select:focus-visible \{ outline: none;/],
  ['src/components/spatial/SpatialStudio.module.css', /\.searchRow:focus-within \{ box-shadow:/],
  ['src/components/features/learning-path/odyssey/odyssey.module.css', /\.search input:focus-visible, \.topTools select:focus-visible \{ box-shadow: none; \}/],
  ['src/components/features/learning-path/odyssey/atlas.module.css', /\.atlas \.search input:focus-visible, \.atlas \.regionPick select:focus-visible \{ box-shadow: none; \}/],
  ['src/components/messenger/messenger.module.css', /\.search input:focus-visible, \.emojiSearch input:focus-visible, \.settingsRow input:focus-visible, \.findBar input:focus-visible, \.inputWrap textarea:focus-visible \{ outline: none; \}/],
];
await check('fields drawn by a wrapper show focus on the wrapper; fields with their own ring get no second outline', () => {
  for (const [file, rule] of FIXED) assert.match(read(file), rule, file);
  for (const file of new Set(FIXED.map(f => f[0]))) assert.ok(!/!important/.test(read(file).match(/[^\n]*focus[^\n]*/g)?.join('\n') ?? ''), file + ': no !important in focus rules');
});

await check('Tailwind fields with a ring of their own also drop the browser outline', () => {
  for (const f of ['src/components/features/admin-security/SecondFactorPrompt.tsx', 'src/components/features/admin-security/SecuritySettings.tsx', 'src/components/features/admin-security/UserSessionsAdmin.tsx',
    'src/components/features/reading/InteractiveReader.tsx', 'src/components/features/writing/sentence-lab/SentenceCheck.tsx']) {
    const s = read(f);
    for (const line of s.split('\n').filter(l => /<(input|textarea|select)\b/.test(l) || /focus:(ring|border)-/.test(l)))
      if (/focus:(ring|border)-/.test(line) && /className=/.test(line)) assert.match(line, /focus:outline-(none|hidden)/, f + ': ' + line.trim().slice(0, 80));
  }
});

console.log(`Focus rings: ${passed} contract groups passed`);
