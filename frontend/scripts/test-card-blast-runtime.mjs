import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToString } from 'react-dom/server';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const source = readFileSync(new URL('../src/components/features/flashcard/pvp/useCardBlastPvP.ts', import.meta.url), 'utf8');
const { code } = babel.core().transformSync(source, {
  filename: 'useCardBlastPvP.ts', configFile: false, babelrc: false,
  presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()],
});
const exports = {};
runInNewContext(code, { exports, require: name => name === '@/lib/api-session' ? { ensureApiSession: async () => true } : require(name),
  process, console, setTimeout, clearTimeout, setInterval, clearInterval });
function Probe() {
  const pvp = exports.useCardBlastPvP();
  assert.equal(pvp.phase, 'IDLE');
  assert.equal(pvp.shieldActiveUntilMs, null);
  return React.createElement('span', null, pvp.phase);
}
assert.equal(renderToString(React.createElement(Probe)), '<span>IDLE</span>');
console.log('Card Blast hook runtime render: PASS (executes hook initialization; catches TDZ regressions).');
