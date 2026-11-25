// Loads a TypeScript source file for a Node contract test, with `@/` and relative imports resolved the same way.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url), babel = require('next/dist/compiled/babel/bundle.js');
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

export function tsLoader(external = {}) {
  const cache = new Map();
  const load = (absolute) => {
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const { code } = babel.core().transformSync(readFileSync(absolute, 'utf8'), { filename: absolute, configFile: false, babelrc: false, presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()] });
    const module = { exports: {} };
    cache.set(absolute, module);
    const req = (name) => {
      if (name in external) return external[name];
      if (name.startsWith('@/') || name.startsWith('.')) {
        const base = name.startsWith('@/') ? resolve(SRC, name.slice(2)) : resolve(dirname(absolute), name);
        const isFile = (p) => existsSync(p) && statSync(p).isFile();
        if (base.endsWith('.json') && isFile(base)) return JSON.parse(readFileSync(base, 'utf8'));
        const file = [base, base + '.ts', base + '.tsx', base + '.mjs', base + '.js', resolve(base, 'index.ts'), resolve(base, 'index.mjs'), resolve(base, 'index.js')].find(isFile);
        if (!file) throw new Error('cannot resolve ' + name + ' from ' + absolute);
        return load(file);
      }
      return require(name);
    };
    runInNewContext(code, { module, exports: module.exports, require: req, console, Math, setTimeout, performance });
    return module.exports;
  };
  return (file) => load(resolve(SRC, file));
}
