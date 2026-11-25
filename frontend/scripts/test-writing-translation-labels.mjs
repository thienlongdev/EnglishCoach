// Writing Translation difficulty label contract (Wave B4, PART XIII §43–§44):
// - User-facing labels in Luyện dịch show "Tất cả trình độ" (ALL), "Cơ bản" (FOUNDATION), and "Nâng cao" (CORE).
// - Zero "Cốt lõi" in rendered Translation UI, even if a stale/cached payload carries legacy "Cốt lõi".
// - Internal codes ("CORE", "FOUNDATION", "ALL") and unrelated modules remain untouched.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');

const feSrcRoot = new URL('../src/', import.meta.url);
const repoRoot = new URL('../../', import.meta.url);
const readFe = (p) => readFileSync(new URL(p, feSrcRoot), 'utf8');
const readRepo = (p) => readFileSync(new URL(p, repoRoot), 'utf8');

function evaluate(relPath, dependencies = {}, globals = {}) {
  const source = readFe(relPath);
  const { code } = babel.core().transformSync(source, {
    filename: relPath,
    configFile: false,
    babelrc: false,
    presets: [
      babel.presetTypescript(),
      ...(relPath.endsWith('.tsx') ? [babel.presetReact()] : []),
    ],
    plugins: [babel.pluginTransformModulesCommonjs()],
  });
  const exports = {};
  const mod = { exports };
  runInNewContext(code, {
    React,
    exports,
    module: mod,
    require: (id) => {
      if (id in dependencies) return dependencies[id];
      return require(id);
    },
    process: { env: {} },
    crypto: globalThis.crypto,
    console,
    setTimeout,
    clearTimeout,
    ...globals,
  });
  return mod.exports;
}

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

const helper = evaluate('components/features/writing/translation/translationDifficultyLabel.ts');

check('shared difficulty helper maps ALL, FOUNDATION, CORE, and legacy "Cốt lõi" cleanly', () => {
  assert.equal(helper.ALL_TRANSLATION_DIFFICULTIES_LABEL, 'Tất cả trình độ');
  assert.equal(helper.formatTranslationDifficultyLabel('ALL'), 'Tất cả trình độ');
  assert.equal(helper.formatTranslationDifficultyLabel('FOUNDATION'), 'Cơ bản');
  assert.equal(helper.formatTranslationDifficultyLabel('FOUNDATION', 'Cơ bản'), 'Cơ bản');
  assert.equal(helper.formatTranslationDifficultyLabel('CORE'), 'Nâng cao');
  assert.equal(helper.formatTranslationDifficultyLabel('CORE', 'Nâng cao'), 'Nâng cao');
  assert.equal(helper.formatTranslationDifficultyLabel('CORE', 'Cốt lõi'), 'Nâng cao');
  assert.equal(helper.formatTranslationDifficultyLabel('core', 'cốt lõi'), 'Nâng cao');
  assert.equal(helper.formatTranslationDifficultyLabel('Cốt lõi'), 'Nâng cao');
  assert.equal(helper.formatTranslationDifficultyLabel(undefined, 'Cốt lõi'), 'Nâng cao');
  assert.equal(helper.formatTranslationDifficultyLabel('UNCALIBRATED', 'Chưa hiệu chuẩn'), 'Chưa hiệu chuẩn');
});

const iconStub = () => React.createElement('i');
const lucideProxy = new Proxy(
  {},
  {
    get: () => iconStub,
  }
);
const glassProxy = new Proxy(
  {},
  {
    get: (_, k) => String(k),
  }
);
const writingGlassStub = {
  WritingHero: ({ title, accent }) => React.createElement('header', null, `${title} ${accent || ''}`),
  Glyph: () => React.createElement('span'),
  StatePanel: ({ title, text }) => React.createElement('section', null, `${title}: ${text}`),
  StudioLoading: ({ text }) => React.createElement('div', null, text),
  topicIdentity: (code) => ({ tone: String(code || 'general').toLowerCase(), icon: iconStub }),
  glass: glassProxy,
};

const { TranslationHome } = evaluate(
  'components/features/writing/translation/TranslationHome.tsx',
  {
    react: React,
    'lucide-react': lucideProxy,
    '../glass/WritingGlass': writingGlassStub,
    './translationDifficultyLabel': helper,
  }
);

check('TranslationHome renders "Tất cả trình độ", "Cơ bản", and "Nâng cao" with zero "Cốt lõi" while preserving value="CORE"', () => {
  const sampleCatalog = {
    availableModes: ['SENTENCE'],
    paragraphModeEnabled: false,
    topics: [
      { code: 'EDUCATION', displayName: 'Giáo dục', count: 20 },
      { code: 'TECHNOLOGY', displayName: 'Công nghệ', count: 30 },
    ],
    difficulties: [
      { code: 'FOUNDATION', displayName: 'Cơ bản', count: 20 },
      // Simulate even a stale cached displayName to prove frontend normalization resilience:
      { code: 'CORE', displayName: 'Cốt lõi', count: 30 },
    ],
    collections: [
      {
        exerciseId: 'ex-1',
        mode: 'SENTENCE',
        topicCode: 'EDUCATION',
        topicDisplayName: 'Giáo dục',
        difficultyBucket: 'FOUNDATION',
        difficultyDisplayName: 'Cơ bản',
        exerciseCount: 2,
        sentenceCount: 20,
      },
      {
        exerciseId: 'ex-2',
        mode: 'SENTENCE',
        topicCode: 'TECHNOLOGY',
        topicDisplayName: 'Công nghệ',
        difficultyBucket: 'CORE',
        difficultyDisplayName: 'Cốt lõi',
        exerciseCount: 3,
        sentenceCount: 30,
      },
    ],
    activeSession: {
      sessionId: 'sess-core-1',
      exerciseId: 'ex-2',
      mode: 'SENTENCE',
      topicCode: 'TECHNOLOGY',
      difficultyBucket: 'CORE',
      currentOrdinal: 2,
      totalUnits: 10,
      sessionRevision: 1,
      updatedAt: '2026-11-25T00:00:00Z',
    },
  };

  const rawHtml = renderToString(
    React.createElement(TranslationHome, {
      catalog: sampleCatalog,
      loading: false,
      onStartSession: () => {},
      onResumeSession: () => {},
    })
  );
  const html = rawHtml.replace(/<!-- -->/g, '');

  assert.match(html, /<option value="ALL"[^>]*>Tất cả trình độ<\/option>/);
  assert.match(html, /<option value="FOUNDATION"[^>]*>Cơ bản \(20\)<\/option>/);
  assert.match(html, /<option value="CORE"[^>]*>Nâng cao \(30\)<\/option>/);
  assert.ok(html.includes('>Cơ bản<'), 'FOUNDATION collection badge displays Cơ bản');
  assert.ok(html.includes('>Nâng cao<'), 'CORE collection badge displays Nâng cao');
  assert.ok(html.includes('aria-label="Bắt đầu: Giáo dục · Cơ bản"'), 'FOUNDATION aria-label');
  assert.ok(html.includes('aria-label="Tiếp tục: Công nghệ · Nâng cao"'), 'CORE active aria-label');
  assert.ok(html.includes('Công nghệ · Nâng cao · Đang ở câu 2 / 10'), 'Active session resume header shows Nâng cao');
  assert.ok(!html.includes('Cốt lõi'), 'Rendered TranslationHome HTML must contain zero "Cốt lõi"');
});

const { TranslationWorkspace } = evaluate(
  'components/features/writing/translation/TranslationWorkspace.tsx',
  {
    react: React,
    'lucide-react': lucideProxy,
    '@/services/writingApi': { writingApi: {} },
    '@/services/api-client': { apiClient: {} },
    '@/services/dictionaryService': { getLexicalTokens: () => [] },
    '@/lib/writing/textarea-caret': { getTextareaSelectionAnchor: () => ({ x: 0, y: 0, anchorY: 0 }) },
    '../shared/WritingStatus': { WritingStatusBadge: () => React.createElement('span', null, 'SAVED') },
    './TranslationHintBar': { TranslationHintBar: () => React.createElement('div') },
    './TranslationFeedback': { TranslationFeedback: () => React.createElement('div') },
    '@/components/features/dictionary/QuickDictionaryPopover': { QuickDictionaryPopover: () => null },
    '@/components/features/dictionary/DictionaryPopup': { DictionaryPopup: () => null },
    '../glass/WritingGlass': writingGlassStub,
    './translationDifficultyLabel': helper,
  }
);

check('TranslationWorkspace active-session header renders "Nâng cao" for CORE and "Cơ bản" for FOUNDATION', () => {
  const baseUnit = {
    unitId: 'u-1',
    ordinal: 1,
    sourceVi: 'Công nghệ hiện đại thay đổi cách con người giao tiếp.',
    hintLevel: 'HIDDEN',
    referenceRevealed: false,
    draftText: '',
    terminalStatus: 'UNSEEN',
    visibleHints: [],
    maskedTokens: [],
    referenceEn: null,
  };

  const coreHtml = renderToString(
    React.createElement(TranslationWorkspace, {
      userId: 1,
      onBackToHome: () => {},
      onSessionUpdated: () => {},
      session: {
        sessionId: 'sess-1',
        exerciseId: 'ex-2',
        mode: 'SENTENCE',
        topicCode: 'TECHNOLOGY',
        difficultyBucket: 'CORE',
        contentVersion: 1,
        currentOrdinal: 1,
        totalUnits: 5,
        sessionRevision: 0,
        status: 'ACTIVE',
        currentUnit: baseUnit,
        units: [baseUnit],
      },
    })
  );
  assert.ok(coreHtml.includes('>Nâng cao<'), 'Active CORE workspace header displays Nâng cao');
  assert.ok(!coreHtml.includes('>CORE<'), 'Active CORE workspace header does not leak raw CORE code');
  assert.ok(!coreHtml.includes('Cốt lõi'), 'Active CORE workspace header never shows Cốt lõi');

  const foundationHtml = renderToString(
    React.createElement(TranslationWorkspace, {
      userId: 1,
      onBackToHome: () => {},
      onSessionUpdated: () => {},
      session: {
        sessionId: 'sess-2',
        exerciseId: 'ex-1',
        mode: 'SENTENCE',
        topicCode: 'EDUCATION',
        difficultyBucket: 'FOUNDATION',
        contentVersion: 1,
        currentOrdinal: 1,
        totalUnits: 5,
        sessionRevision: 0,
        status: 'ACTIVE',
        currentUnit: baseUnit,
        units: [baseUnit],
      },
    })
  );
  assert.ok(foundationHtml.includes('>Cơ bản<'), 'Active FOUNDATION workspace header displays Cơ bản');
});

check('backend catalog service maps CORE -> "Nâng cao" while keeping code "CORE", and unrelated modules stay untouched', () => {
  const beCatalog = readRepo(
    'backend/src/main/java/com/englishcoach/writing/translation/service/TranslationCatalogService.java'
  );
  assert.match(beCatalog, /"FOUNDATION",\s*"Cơ bản"/);
  assert.match(beCatalog, /"CORE",\s*"Nâng cao"/);
  assert.ok(!beCatalog.includes('Cốt lõi'), 'TranslationCatalogService.java must not contain "Cốt lõi"');

  const homeSrc = readFe('components/features/writing/translation/TranslationHome.tsx');
  assert.match(homeSrc, /difficultyBucket:\s*col\.difficultyBucket/, 'Start session payload keeps internal difficultyBucket');

  // Verify no TSX file under writing/translation contains literal "Cốt lõi"
  const walkTsx = (dirUrl) =>
    readdirSync(dirUrl).flatMap((entry) => {
      const full = new URL(entry, dirUrl);
      if (statSync(full).isDirectory()) return walkTsx(new URL(`${entry}/`, dirUrl));
      return entry.endsWith('.tsx') ? [full] : [];
    });
  for (const fileUrl of walkTsx(new URL('components/features/writing/translation/', feSrcRoot))) {
    const content = readFileSync(fileUrl, 'utf8');
    assert.ok(!content.includes('Cốt lõi'), `Unexpected "Cốt lõi" in ${fileUrl.pathname}`);
  }

  // Unrelated modules with legitimate Vietnamese "cốt lõi" copy remain intact
  assert.match(readFe('components/features/writing/coach/DraftEditor.tsx'), /cốt lõi/);
  assert.match(readFe('components/features/writing/coach/PlanningForm.tsx'), /cốt lõi/);
});

console.log(`Writing translation difficulty labels: ${passed} checks passed.`);
