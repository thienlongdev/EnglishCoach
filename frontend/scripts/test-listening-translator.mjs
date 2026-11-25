// Listening free on-device translator (2026-10-29): pinned same-origin assets, the worker-only CSP and the automatic UI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');
const dir = join(here, '../public/vendor/listening-translator');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

check('every asset matches MANIFEST.sha256 (model rev 30bcd461 + Transformers.js 3.8.1, byte-identical)', () => {
  const lines = readFileSync(join(dir, 'MANIFEST.sha256'), 'utf8').trim().split(/\r?\n/);
  assert.ok(lines.length >= 13);
  for (const line of lines) {
    const [sha, file] = line.split(/\s+/);
    assert.equal(createHash('sha256').update(readFileSync(join(dir, file))).digest('hex'), sha, file);
  }
  for (const f of ['opus-mt-en-vi-30bcd461/onnx/encoder_model_quantized.onnx.bin', 'opus-mt-en-vi-30bcd461/onnx/decoder_model_merged_quantized.onnx.bin',
    'opus-mt-en-vi-30bcd461/LICENSE', 'opus-mt-en-vi-30bcd461/NOTICE.md', 'runtime-3.8.1/LICENSE', 'worker-v2.js']) {
    assert.ok(lines.some(l => l.endsWith('  ' + f)), `${f} listed`);
  }
});

check('the worker loads only its own directory: no remote host, en->vi model, Latin-script target token', () => {
  const worker = readFileSync(join(dir, 'worker-v2.js'), 'utf8');
  assert.doesNotMatch(worker, /https?:\/\//, 'no absolute URL');
  assert.match(worker, /env\.allowLocalModels = false;/);
  assert.match(worker, /env\.remoteHost = BASE\.href;/);
  assert.match(worker, /const MODEL = 'opus-mt-en-vi-30bcd461';/);
  assert.match(worker, /const TARGET = '>>vie<< ';/);
  assert.match(worker, /blocked request outside its directory/);
  assert.match(read('../src/lib/listening/freeTranslator.ts'), /const WORKER_URL = '\/vendor\/listening-translator\/worker-v2\.js';/);
});

check('edge: WebAssembly is allowed only for the translator directory; the site policy is unchanged', () => {
  const nginx = read('../../deploy/nginx/default.conf');
  const site = /add_header Content-Security-Policy "default-src 'self';[^"]+"/.exec(nginx)[0];
  assert.doesNotMatch(site, /wasm-unsafe-eval|unsafe-eval|huggingface|hf\.co/);
  const block = /location \^~ \/vendor\/listening-translator\/ \{([\s\S]*?)\n    \}/.exec(nginx)[1];
  assert.match(block, /add_header_inherit off;/, 'the site policy must not be merged into the worker response');
  assert.match(block, /add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; report-uri \/api\/csp-report" always;/);
  for (const h of ['Strict-Transport-Security', 'X-Content-Type-Options', 'Cache-Control $static_asset_cache_control']) assert.ok(block.includes(h), h);
  // The translator's header and comment, and the study room's physics compile worker (scripts/test-physics-feel.mjs): nothing else.
  assert.equal((nginx.match(/'wasm-unsafe-eval'/g) ?? []).length, 3, 'translator header + comment, study-physics worker header');
  assert.doesNotMatch(nginx, /'unsafe-eval'/);
});

check('Overview: automatic translation, no translate button or counter, no paid call from the client', () => {
  const ui = read('../src/components/features/listening/BilingualTranscript.tsx');
  assert.doesNotMatch(ui, /Dịch song ngữ|Translate into Vietnamese|BrandWhaleIcon|\{count\}\/\{segments\.length\}/);
  assert.match(ui, /translateFree\(seg\.text\)/);
  const api = read('../src/services/listeningWorkspaceApi.ts');
  assert.doesNotMatch(api, /segmentIds|translateListeningSegments/);
  assert.ok(!existsSync(join(here, '../public/vendor/listening-translator-v1.js')), 'first worker removed');
});

console.log(`Listening translator PASS (${passed} checks)`);
