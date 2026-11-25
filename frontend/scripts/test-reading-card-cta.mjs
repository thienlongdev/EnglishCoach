// ReadingCard Primary CTA & Hit-Testing Regression Suite (Wave B3)
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

function evaluate(path, dependencies = {}, globals = {}) {
  const { code } = babel.core().transformSync(read(path), {
    filename: path,
    configFile: false,
    babelrc: false,
    presets: [babel.presetTypescript(), ...(path.endsWith('.tsx') ? [babel.presetReact()] : [])],
    plugins: [babel.pluginTransformModulesCommonjs()],
  });
  const exports = {};
  runInNewContext(code, {
    React,
    exports,
    require: (p) => dependencies[p] ?? require(p),
    AbortController,
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    ...globals,
  });
  return exports;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  -> PASS: ${name}`);
}

const glassCss = read('components/features/reading/glass/readingGlass.module.css');
const cardSrc = read('components/features/reading/ReadingCard.tsx');
const dashSrc = read('components/features/reading/ReadingDashboard.tsx');

check('CSS stacking & pointer-events let "Đọc ngay" and ArrowRight pass through .cardActions to .cardOpen::after', () => {
  assert.match(glassCss, /\.cardOpen::after\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*z-index:\s*1;/);
  assert.match(glassCss, /\.cardActions\s*\{[^}]*z-index:\s*2;[^}]*pointer-events:\s*none;/);
  assert.match(glassCss, /\.cardActions\s*>\s*button\s*\{\s*pointer-events:\s*auto;\s*\}/);
  assert.match(glassCss, /\.openCue\s*\{\s*pointer-events:\s*none;/);
  assert.match(glassCss, /\.openCue\s+svg\s*\{\s*pointer-events:\s*none;\s*\}/);
  assert.doesNotMatch(glassCss, /backdrop-filter|!important|font-family/);
});

check('ReadingCard uses one canonical handleOpen, preserves Echo Glass cue & zero nested buttons / sparkles / ampersands', () => {
  assert.match(cardSrc, /const handleOpen = \(\) => \{\s*onClick\?\.\(\);\s*\};/);
  assert.match(cardSrc, /<button type="button" onClick=\{handleOpen\} className=\{styles\.cardOpen\}>/);
  assert.match(cardSrc, /onClick=\{handleCardClick\}/);
  assert.match(cardSrc, /className=\{styles\.openCue\} aria-hidden="true"/);
  assert.doesNotMatch(cardSrc, /Sparkles|✨/);
});

const glassStubs = {
  './glass/readingGlass.module.css': { __esModule: true, default: new Proxy({}, { get: (_, k) => String(k) }) },
  './glass/ReadingCover': { ReadingCover: () => null, topicFamily: () => 'earth' },
};

function loadCard(locale = 'vi') {
  return evaluate('components/features/reading/ReadingCard.tsx', {
    react: React,
    '@/context/LanguageContext': { useLanguage: () => ({ locale }) },
    ...glassStubs,
  }).default;
}

// Minimal recursive React element walker to locate live rendered nodes & handlers without a browser bundler.
function walkElements(node, out = []) {
  if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) {
    for (const child of node) walkElements(child, out);
    return out;
  }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      walkElements(node.type(node.props ?? {}), out);
      return out;
    }
    if (typeof node.type === 'string') {
      out.push(node);
    }
    if (node.props?.children !== undefined) {
      walkElements(node.props.children, out);
    }
  }
  return out;
}

function makeTarget(tag, insideInteractive = false) {
  return {
    tagName: tag.toUpperCase(),
    closest: (selector) => {
      if (!insideInteractive) return null;
      return selector.includes('button') ? { tagName: 'BUTTON' } : null;
    },
  };
}

const sampleMaterial = {
  id: 108,
  title: 'Glaciers of Denali',
  sourceName: 'National Park Service',
  materialType: 'ARTICLE',
  wordCount: 520,
  difficultyLevel: 'B2',
  isSystem: true,
  topic: 'Earth Science',
  readMinutes: 3,
  description: 'How alpine ice shapes valleys across Alaska.',
};

check('Rendered markup keeps exact focus order (no duplicate open button, no nested interactive controls)', () => {
  const CardVi = loadCard('vi');
  const systemHtml = renderToString(
    React.createElement(CardVi, { material: sampleMaterial, onClick: () => {}, onSpeakingClick: () => {} })
  );
  assert.ok(!/<button[^>]*>(?:(?!<\/button>).)*<button/.test(systemHtml), 'no nested buttons');
  const systemButtons = [...systemHtml.matchAll(/<button\b[^>]*>/g)];
  assert.equal(systemButtons.length, 2, 'SYSTEM card has exactly 2 focusable buttons (title open + Luyện nói)');
  assert.ok(systemHtml.includes('data-reading-open-cue'));
  assert.ok(systemHtml.includes('data-reading-open-arrow'));
  assert.ok(systemHtml.includes('Đọc ngay'));

  const userHtml = renderToString(
    React.createElement(CardVi, {
      material: { ...sampleMaterial, id: 209, isSystem: false, ownerUserId: 7 },
      canDelete: true,
      onClick: () => {},
      onSpeakingClick: () => {},
      onDelete: () => {},
    })
  );
  const userButtons = [...userHtml.matchAll(/<button\b[^>]*>/g)];
  assert.equal(userButtons.length, 3, 'USER card with canDelete has exactly 3 focusable buttons (title open + Xóa + Luyện nói)');
});

check('Canonical open & action isolation: center/title, "Đọc ngay", ArrowRight, keyboard Enter open ONCE; Speak & Delete stay isolated', () => {
  const CardVi = loadCard('vi');
  let opens = 0;
  const spoken = [];
  const deleted = [];

  const tree = CardVi({
    material: { ...sampleMaterial, isSystem: false, ownerUserId: 7 },
    canDelete: true,
    onClick: () => { opens += 1; },
    onSpeakingClick: (m) => { spoken.push(m.id); },
    onDelete: (id) => { deleted.push(id); },
  });
  const nodes = walkElements(tree);
  const article = nodes.find((n) => n.type === 'article');
  const openBtn = nodes.find((n) => n.type === 'button' && n.props.className === 'cardOpen');
  const speakBtn = nodes.find((n) => n.type === 'button' && n.props.className === 'speakBtn');
  const deleteBtn = nodes.find((n) => n.type === 'button' && n.props.className === 'iconBtn');
  const openCue = nodes.find((n) => n.type === 'span' && n.props['data-reading-open-cue'] !== undefined);

  assert.ok(article && openBtn && speakBtn && deleteBtn && openCue, 'all expected card nodes exist');

  // 1. Real browser click on card body / cover / "Đọc ngay" / ArrowRight OR keyboard Enter/Space hits `.cardOpen` button
  //    AND bubbles to `<article onClick={handleCardClick}>`: must fire `onClick` ONCE (never twice!).
  const btnTarget = makeTarget('button', true);
  openBtn.props.onClick({ defaultPrevented: false, target: btnTarget });
  article.props.onClick({ defaultPrevented: false, target: btnTarget });
  assert.equal(opens, 1, 'primary .cardOpen click + article bubble invokes onClick exactly once');

  // 2. Fallback / direct DOM click on "Đọc ngay" span (`openCue`) bubbles to `<article>`: invokes `onClick` once.
  article.props.onClick({ defaultPrevented: false, target: makeTarget('span', false) });
  assert.equal(opens, 2, 'direct click on openCue span invokes onClick once');

  // 3. Fallback / direct DOM click on `<ArrowRight />` SVG/path bubbles to `<article>`: invokes `onClick` once.
  article.props.onClick({ defaultPrevented: false, target: makeTarget('svg', false) });
  assert.equal(opens, 3, 'direct click on ArrowRight svg invokes onClick once');

  // 4. Prevented event on `<article>` never opens.
  article.props.onClick({ defaultPrevented: true, target: makeTarget('div', false) });
  assert.equal(opens, 3, 'defaultPrevented event is ignored');

  // 5. Clicking "Luyện nói" invokes onSpeakingClick(material) once and NEVER opens or deletes.
  let speakStopped = false;
  let speakPrevented = false;
  speakBtn.props.onClick({
    preventDefault: () => { speakPrevented = true; },
    stopPropagation: () => { speakStopped = true; },
    target: makeTarget('button', true),
  });
  // Even if someone bypassed stopPropagation, article guard still ignores button targets:
  article.props.onClick({ defaultPrevented: speakPrevented, target: makeTarget('span', true) });
  assert.ok(speakStopped && speakPrevented, 'speak button stops propagation and prevents default');
  assert.deepEqual(spoken, [sampleMaterial.id]);
  assert.equal(opens, 3, 'Luyện nói never triggers article open');
  assert.deepEqual(deleted, []);

  // 6. Clicking "Xóa" invokes onDelete(material.id) once and NEVER opens or speaks.
  let deleteStopped = false;
  let deletePrevented = false;
  deleteBtn.props.onClick({
    preventDefault: () => { deletePrevented = true; },
    stopPropagation: () => { deleteStopped = true; },
    target: makeTarget('button', true),
  });
  article.props.onClick({ defaultPrevented: deletePrevented, target: makeTarget('svg', true) });
  assert.ok(deleteStopped && deletePrevented, 'delete button stops propagation and prevents default');
  assert.deepEqual(deleted, [sampleMaterial.id]);
  assert.equal(opens, 3, 'Xóa never triggers article open');
  assert.deepEqual(spoken, [sampleMaterial.id]);
});

check('ReadingDashboard handleOpenMaterial & closeReader preserve materialId query, progress key, and single pushState', () => {
  assert.match(dashSrc, /const handleOpenMaterial = \(m: ReadingMaterial\) => \{[\s\S]*?localStorage\.setItem\("ec_last_read_material_id", m\.id\.toString\(\)\);[\s\S]*?params\.set\("materialId", m\.id\.toString\(\)\);[\s\S]*?window\.history\.pushState\(null, "", `\$\{pathname\}\?\$\{params\.toString\(\)\}`\);\s*\};/);
  assert.match(dashSrc, /const closeReader = \(\) => \{[\s\S]*?params\.delete\("materialId"\);[\s\S]*?window\.history\.pushState\(null, "", `\$\{pathname\}\?\$\{params\.toString\(\)\}`\);\s*\};/);
  assert.match(dashSrc, /onClick=\{\(\) => handleOpenMaterial\(m\)\}/);
  assert.match(dashSrc, /onSpeakingClick=\{\(\) => handleSpeakingHandoff\(m\)\}/);
});

console.log(`Reading card CTA contracts: ${passed}/${passed} PASSED`);
