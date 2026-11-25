// Owner rule (2026-10-30, 10 §BD): application-owned learner-facing text never shows "&" — Vietnamese copy says "và", English
// copy says "and". This scans the frontend sources for an ampersand between two words inside a string literal or JSX text
// (and for the HTML entity form). Technical uses are not matched (&&, &=, bitwise / type operators next to digits or braces,
// URL query separators). Data KEYS that are stored values and third-party credits are listed below and shown through labels.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const ALLOWED = [
  // stored Listening topics: record / option keys, shown through categoryLabel()
  /"(Ideas|Science|Work|Culture|News) & (Talks|Tech|Study|Travel|Podcasts)"/,
  // stored writing genre keys, shown through their Vietnamese label
  /'(Opinion & Argument|Problem & Solution|Cause & Effect)':/,
  // third-party credit (Pexels title)
  /pexels\('PureRaw: Camera & Film Grain'/,
];
// Canonical single-literal data keys (never skip sibling display strings on the same line!)
const ALLOWED_LITERALS = [
  // Echo Life V3 district key shared with frozen v3/world-data/world.mjs and backend rules.js; rendered via cleanDisplayCopy()
  /^['"]Parks & River['"]$/,
];
const literal = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|(?<![=>-])>[^<>{}\n]*(?=[<{])/g;
const wordAmp = /[^\W\d_)] (?:&|&amp;) [^\W\d_(]/u;
// a JSX text line on its own (no code characters): "Đọc hiểu & Lập dàn ý", "TOEIC L&R Score"
const textLine = /^\s*[^{}<>=;()'"`/*]*[^\W\d_](?: &(?:amp;)? |&)[^\W\d_][^{}<>=;'"`]*$/u;
const found = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(tsx|ts)$/.test(name)) continue;
    readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      const s = line.trim();
      if (!line.includes('&') || s.startsWith('//') || s.startsWith('*') || s.startsWith('import ')) return;
      if (ALLOWED.some((re) => re.test(line))) return;
      if (/\.tsx$/.test(name) && !line.includes('&&') && textLine.test(line)) { found.push(`${relative(root, p).split(sep).join('/')}:${i + 1}: ${s.slice(0, 140)}`); return; }
      for (const m of line.matchAll(literal)) {
        if (wordAmp.test(m[0]) && !ALLOWED_LITERALS.some((re) => re.test(m[0]))) {
          found.push(`${relative(root, p).split(sep).join('/')}:${i + 1}: ${s.slice(0, 140)}`);
        }
      }
    });
  }
};
walk(root);
assert.deepEqual(found, [], `display copy must say "và" / "and", never "&":\n${found.join('\n')}`);
console.log('no-ampersand display copy: OK');
