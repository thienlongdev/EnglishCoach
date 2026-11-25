import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(ROOT, '..');

// Vietnamese-specific diacritic letters (excludes standard ASCII and English/French loanwords like Café/Résumé,
// while catching all Vietnamese vowels/consonants with diacritics such as ă â đ ê ô ơ ư and Vietnamese tone marks).
const VN_RE = /[ăâđêôơưĂÂĐÊÔƠƯáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵÁÀẢÃẠẤẦẨẪẬẮẰẲẴẶÉÈẺẼẸẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌỐỒỔỖỘỚỜỞỠỢÚÙỦŨỤỨỪỬỮỰÝỲỶỸỴ]/;
// Allow "Café" / "Résumé" (standard English loanwords used in Pixel Café).
const ALLOWED_LOANWORDS = /\bCaf[ée](?![a-zA-Z])|\bR[ée]sum[ée](?![a-zA-Z])/g;
const LITERAL_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|(?<![=>-])>[^<>{}\n]*(?=[<{])/g;
const WORD_AMP_RE = /[^\W\d_)] (?:&|&amp;) [^\W\d_(]/u;
const FORBIDDEN_SPARKLE_RE = new RegExp('\\b' + 'Spark' + 'les?\\b|\\u2728');

function stripCommentsAndLoanwords(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(ALLOWED_LOANWORDS, '');
}

// Phase 2 (In-World Gameplay): 100% English-only — zero Vietnamese diacritics allowed.
const IN_WORLD_TARGET_FILES = [
  'frontend/src/components/study-space/echoLife/EchoLifeHud.tsx',
  'frontend/src/components/study-space/echoLife/CinematicDialogue.tsx',
  'frontend/src/components/study-space/echoLife/Minimap.tsx',
  'frontend/src/components/study-space/echoLife/Workshop.tsx',
  'frontend/src/components/study-space/world/echoLife/buildingsView.ts',
  'frontend/src/components/study-space/world/echoLife/cityView.ts',
  'frontend/src/components/study-space/world/echoLife/house.ts',
  'frontend/src/components/study-space/world/echoLife/gameHost.ts',
  'frontend/src/components/study-space/world/echoLife/gameView.ts',
  'frontend/src/components/study-space/world/echoLife/marketStock.ts',
  'frontend/src/components/study-space/world/echoLife/basketball.ts',
  'frontend/src/components/study-space/world/echoLife/sharedCity.ts',
  'frontend/src/components/study-space/world/furniture.ts',
  'backend/src/main/java/com/englishcoach/studyspace/StudySharedService.java',
];

// Phase 1 (Pre-Entry Experience, TASK 1 §11.2): Vietnamese Liquid Glass pre-entry before entering the 3D world.
const REQUIRED_PRE_ENTRY_STAGES_VI = [
  'Đang chuẩn bị Không gian học tập',
  'Đang tải môi trường và nhân vật',
  'Đang tối ưu đồ họa',
  'Đang đồng bộ thế giới',
  'Sắp sẵn sàng khám phá',
];

const violations = [];

for (const rel of IN_WORLD_TARGET_FILES) {
  const full = path.join(REPO, rel);
  if (!fs.existsSync(full)) {
    violations.push(`${rel}: FILE MISSING`);
    continue;
  }
  const raw = fs.readFileSync(full, 'utf8');
  const cleaned = stripCommentsAndLoanwords(raw);
  const lines = cleaned.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (VN_RE.test(line)) {
      violations.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 140)}`);
    }
  });
}

// Verify StudySpace.tsx forces English in-world when lifeEnabled is true.
const studySpace = fs.readFileSync(path.join(REPO, 'frontend/src/components/study-space/StudySpace.tsx'), 'utf8');
if (!/const\s+vi\s*=\s*!lifeEnabled\s*&&\s*locale\s*===\s*'vi'/.test(studySpace)) {
  violations.push('frontend/src/components/study-space/StudySpace.tsx: missing `const vi = !lifeEnabled && locale === \'vi\'` guard');
}

// Verify Two-Phase Language Boundary: Vietnamese pre-entry stage labels and design invariants.
const overlayRel = 'frontend/src/components/study-space/echoLife/EchoLifeLoadingOverlay.tsx';
const entryRel = 'frontend/src/components/study-space/StudySpaceEntry.tsx';
const cssRel = 'frontend/src/components/study-space/echoLife/echoLifeLoading.module.css';

const overlaySrc = fs.readFileSync(path.join(REPO, overlayRel), 'utf8');
const entrySrc = fs.readFileSync(path.join(REPO, entryRel), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, cssRel), 'utf8');

for (const label of REQUIRED_PRE_ENTRY_STAGES_VI) {
  if (!overlaySrc.includes(label)) {
    violations.push(`${overlayRel}: missing required Vietnamese pre-entry stage label "${label}"`);
  }
}

if (!entrySrc.includes('Đang chuẩn bị Không gian học tập')) {
  violations.push(`${entryRel}: dynamic loading fallback must render Vietnamese pre-entry label "Đang chuẩn bị Không gian học tập"`);
}

for (const [rel, src] of [[overlayRel, overlaySrc], [entryRel, entrySrc], [cssRel, cssSrc]]) {
  if (FORBIDDEN_SPARKLE_RE.test(src)) {
    violations.push(`${rel}: forbidden decorative icon or emoji detected`);
  }
  const lines = src.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import ')) return;
    for (const m of line.matchAll(LITERAL_RE)) {
      if (WORD_AMP_RE.test(m[0])) {
        violations.push(`${rel}:${idx + 1}: ampersand "&" forbidden in display copy (${m[0].slice(0, 80)})`);
      }
    }
  });
}

const cssNoComments = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
if (/backdrop-filter\s*:/i.test(cssNoComments)) {
  violations.push(`${cssRel}: backdrop-filter is forbidden over live WebGL / Echo Life surfaces (10 §AF / §CE)`);
}
if (/!important/i.test(cssNoComments)) {
  violations.push(`${cssRel}: !important is forbidden (10 §CE)`);
}
if (!/:global\(\.dark\)/.test(cssSrc)) {
  violations.push(`${cssRel}: missing explicit :global(.dark) theme support (10 §Y)`);
}
if (!/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/.test(cssSrc)) {
  violations.push(`${cssRel}: missing @media (prefers-reduced-motion: reduce) compliance`);
}

if (violations.length) {
  console.error('FAIL: Echo Life Two-Phase Language Boundary / Pre-Entry UX compliance failed:');
  for (const v of violations) console.error('  -', v);
  process.exit(1);
}

console.log(
  `PASS echo-life Two-Phase Language Boundary (${IN_WORLD_TARGET_FILES.length} in-world English files + StudySpace guard + 5/5 Vietnamese pre-entry stages + Echo Liquid Glass CSS invariants)`,
);
