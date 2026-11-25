import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url), babel = require('next/dist/compiled/babel/bundle.js');
const read = name => fs.readFileSync(new URL(`../src/lib/vfx/${name}.ts`, import.meta.url), 'utf8');
let reduced = false, coarse = false, clock = 0;
const saved = new Map(), storageListeners = new Set();
const document = { hidden: false };
const env = { console, Math, Date, performance: { now: () => clock }, document,
  navigator: { hardwareConcurrency: 16, deviceMemory: 8 }, innerWidth: 1440,
  localStorage: { getItem: k => saved.get(k), setItem: (k,v) => saved.set(k,v) },
  matchMedia: q => ({ matches: q.includes('reduced') ? reduced : coarse }),
  window: { addEventListener: (_, f) => storageListeners.add(f), removeEventListener: (_, f) => storageListeners.delete(f) },
};
function load(name) {
  const exports = {};
  const code = babel.core().transformSync(read(name), { filename: `${name}.ts`, configFile: false, babelrc: false, presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()] }).code;
  runInNewContext(code, { ...env, exports }); return exports;
}
let checks = 0; const pass = s => { checks++; console.log(`PASS ${s}`); };
const q = load('quality');
assert.equal(q.vfxPreference(), 'auto'); assert.equal(q.deviceVfxTier(), 'high');
coarse = true; assert.equal(q.deviceVfxTier(), 'low'); coarse = false;
const quality = new q.VfxQuality(); q.setVfxPreference('ultra'); assert.equal(quality.update(0), 'ultra');
reduced = true; assert.equal(quality.update(.016), 'low'); reduced = false;
assert.equal(quality.update(.016, false), 'low'); assert.equal(quality.update(.016), 'ultra');
pass('Auto respects coarse devices; reduced motion and unavailable capability cap even Ultra');
for (let i=0;i<80;i++) quality.update(.04); assert.equal(quality.tier,'high');
for (let i=0;i<80;i++) quality.update(.04); assert.equal(quality.tier,'medium');
q.setVfxPreference('high'); assert.equal(quality.update(.016),'high');
for (let i=0;i<400;i++) quality.update(.016); assert.equal(quality.tier,'high');
pass('Sustained slow time lowers quality; healthy frames do not falsely degrade');
let notified=0; const unsub=q.subscribeVfx(()=>notified++);
saved.set('ec-vfx-quality:v1','low'); for(const f of storageListeners) f({key:'ec-vfx-quality:v1'});
assert.equal(q.vfxPreference(),'low'); assert.equal(notified,1); unsub(); assert.equal(storageListeners.size,0);
q.setVfxPreference('invalid'); assert.equal(q.vfxPreference(),'low');
pass('Cross-tab preference revalidates and the final subscriber removes its listener');
const e=load('events');let first=0,second=0;
const a=e.registerCelebration(()=>{first++;return true}),b=e.registerCelebration(()=>{second++;return true});
assert.equal(e.celebrateInWorld(),true);assert.equal(first,0);assert.equal(second,1);b();
assert.equal(e.celebrateInWorld(),true);assert.equal(first,1);a();assert.equal(e.celebrateInWorld(),false);
pass('A milestone has one renderer owner and removed scenes cannot consume it');
const audio=load('audio');let playing=true;
const source={snapshot:()=>({playing}),analyser:{frequencyBinCount:512,fftSize:1024,context:{state:'running',sampleRate:48000},getByteFrequencyData:bytes=>{bytes.fill(0);bytes[3]=255;}}};
const unbind=audio.bindMusicAnalysis(source);clock=100;let bands=audio.musicBands(clock);
assert.equal(bands.mode,'live');assert(bands.bass>0);assert.equal(bands.treble,0);
clock+=20;const cached=bands.bass;assert.equal(audio.musicBands(clock).bass,cached);
document.hidden=true;for(let i=0;i<50;i++)audio.musicBands(clock+=60);assert.equal(bands.mode,'silent');assert(bands.level<.001);document.hidden=false;
source.analyser=null;assert.equal(audio.musicBands(clock+=60).mode,'ambient');
unbind();assert.equal(bands.mode,'silent');assert.equal(bands.level,0);
pass('Real frequency bins, 20 Hz shared sampling, hidden-page release, honest ambient and disposal');
console.log(`${checks} cinematic VFX behavioral groups passed.`);
