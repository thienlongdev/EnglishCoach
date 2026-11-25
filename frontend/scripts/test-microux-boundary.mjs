import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url), babel = require('next/dist/compiled/babel/bundle.js');
const read = path => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
function evaluate(path, deps = {}, globals = {}) {
  const { code } = babel.core().transformSync(read(path), { filename: path, configFile: false, babelrc: false,
    presets: [babel.presetTypescript(), ...(path.endsWith('.tsx') ? [babel.presetReact()] : [])], plugins: [babel.pluginTransformModulesCommonjs()] });
  const exports = {};
  runInNewContext(code, { exports, require: path => deps[path] ?? require(path), React, AbortController, console, ...globals });
  return exports;
}
const lp = 'components/features/listening/';
const timing = evaluate(lp + 'transcript-timing.ts');
const transcriptReact = { ...React, useMemo: fn => fn(), useRef: () => ({ current: null }), useEffect() {} };
const { InteractiveTranscript } = evaluate(lp + 'InteractiveTranscript.tsx', { react: transcriptReact, './transcript-timing': timing,
  'lucide-react': { Play: () => null }, './glass/listeningGlass.module.css': new Proxy({}, { get: (_, key) => String(key) }) });
const fixtures = JSON.parse(readFileSync(new URL('./listening-boundary-fixtures.json', import.meta.url), 'utf8'));
function rendered(segments, time, playing = true) {
  const tree = InteractiveTranscript({ segments, currentTime: time, isPlaying: playing });
  const rows = tree.props.children[1].props.children;
  const active = rows.find(row => row.props.children[1].props.children[0].props.children.some(child => child?.props?.children === 'Đang phát'));
  const word = active?.props.children[2].props.children.find(span => span?.props?.['data-active'] === true);
  return { id: active?.props.id, word: word?.props.children ?? null, tree };
}
for (const f of fixtures) {
  const bounds = timing.transcriptDisplayBounds(f.segments);
  const seen = new Set();
  // Continuous 50ms media samples, same cadence as the existing player.
  for (let tick = 0; tick < 620; tick++) {
    const t = tick / 20, state = rendered(f.segments, t);
    if (state.word) seen.add(state.id + ':' + state.word);
  }
  for (const s of f.segments.slice(0, 5)) {
    const first = s.words[0];
    assert.equal(rendered(f.segments, (first.start + first.end) / 2).id, 'segment-' + s.id);
    assert.equal(rendered(f.segments, (first.start + first.end) / 2).word, first.word);
    assert.ok(seen.has('segment-' + s.id + ':' + first.word), `${f.materialId}/${s.id} first word sampled`);
    // Exact eligibility and pause/resume/middle seek never force word zero.
    assert.equal(rendered(f.segments, first.start).word, first.word);
    const middle = s.words[Math.floor(s.words.length / 2)], t = (middle.start + middle.end) / 2;
    assert.equal(rendered(f.segments, t, false).word, middle.word);
    assert.equal(rendered(f.segments, t, true).word, middle.word);
    assert.equal(rendered(f.segments, first.start).word, first.word); // seek back/replay
    const last = s.words.at(-1), lt = (last.start + last.end) / 2;
    // Aligned words occasionally overlap between sentences; newer sentence owns that overlap.
    if (timing.activeTranscriptSegment(bounds, lt) === f.segments.indexOf(s)) assert.equal(rendered(f.segments, lt).word, last.word);
    const clicked = [];
    const clickTree = InteractiveTranscript({segments:f.segments,currentTime:t,onSegmentClick:time=>clicked.push(time)});
    clickTree.props.children[1].props.children.find(row=>row.props.id==='segment-'+s.id).props.onClick();
    assert.equal(clicked[0], s.startTimeMs);
  }
  console.log(`Listening material ${f.materialId} PASS: first five first words, middle/last, continuous 50ms, paused/resumed derivation, seeks and stored-bound click.`);
}
const s = (start, end, words=[]) => ({startTimeMs:start*1000,endTimeMs:end*1000,words});
const w = (start,end) => ({word:'word',start,end});
let b=timing.transcriptDisplayBounds([s(0,1,[w(0,.18)]),s(1,2,[w(1,1.18)])]);
for(const t of [1,1.03,1.1,1.19,1.41]) assert.equal(timing.activeTranscriptSegment(b,t),1);
assert.equal(timing.activeTranscriptSegment(b,.98),0);
b=timing.transcriptDisplayBounds([s(0,1),s(2,3)]);
assert.equal(timing.activeTranscriptSegment(b,1.5),0); // stable gap
b=timing.transcriptDisplayBounds([s(0,2),s(1.2,3,[w(1,1.1)])]);
assert.equal(timing.activeTranscriptSegment(b,1),1); // word starts before caption, old caption overlaps
assert.equal(timing.activeTranscriptSegment(b,.9999),0);
b=timing.transcriptDisplayBounds([s(0,1,[w(-1,-1),w(NaN,2)]),s(1,2)]);
assert.equal(b[0].start,0); assert.equal(b[0].end,1);
assert.equal(timing.activeTranscriptSegment([],0),-1);
const player=read(lp+'AdvancedAudioPlayer.tsx');
assert.ok(player.includes('}, 50)') && !player.includes('requestAnimationFrame'));

// Run the real discovery hook with fake timers, auth cancellation, storage, and effect cleanup.
let now=0, timerId=0, timers=new Map(), slots=[], cursor=0, effects=[], pending=false, phase;
let account='A', authenticated=true, open=false;
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
const hooks={...React,
  useState(initial){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return[slots[i].value,v=>{slots[i].value=typeof v==='function'?v(slots[i].value):v;pending=true;}];},
  useRef(initial){return slots[cursor++]??={current:initial};},
  useEffect(fn,deps){const i=cursor++;if(!same(slots[i]?.deps,deps)){const old=slots[i];slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});}},
};
const store=new Map(), storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
const setTimer=(fn,delay)=>{const id=++timerId;timers.set(id,{fn,at:now+delay});return id;};
const clearTimer=id=>timers.delete(id);
const auth=evaluate('lib/auth-lifecycle.ts');
const globals={Date:{now:()=>now},localStorage:storage,setTimeout:setTimer,clearTimeout:clearTimer};
let discovery=evaluate('components/features/coach/useEchoDiscovery.ts',{react:hooks,'@/lib/auth-lifecycle':auth},globals);
function render(){let n=0;do{pending=false;cursor=0;phase=discovery.useEchoDiscovery(account,authenticated,open,true).phase;const e=effects;effects=[];e.forEach(fn=>fn());assert.ok(++n<20);}while(pending);return phase;}
function advance(ms){const end=now+ms;while(true){const next=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();render();}now=end;render();}
function remount(){slots.forEach(s=>s?.cleanup?.());slots=[];effects=[];render();}
assert.equal(render(),'hidden');advance(4499);assert.equal(phase,'hidden');
remount();advance(1);assert.equal(phase,'entering');advance(380);assert.equal(phase,'visible');
advance(4999);assert.equal(phase,'visible');advance(1);assert.equal(phase,'leaving');advance(380);assert.equal(phase,'hidden');
remount();advance(10000);assert.equal(phase,'hidden'); // route remount no replay
discovery=evaluate('components/features/coach/useEchoDiscovery.ts',{react:hooks,'@/lib/auth-lifecycle':auth},globals);remount();advance(10000);assert.equal(phase,'hidden'); // refresh marker
account='B';render();advance(2000);open=true;render();advance(10000);assert.equal(phase,'hidden'); // open before delay
open=false;account='C';render();advance(4500);assert.equal(phase,'entering');open=true;render();assert.equal(phase,'leaving');advance(380);assert.equal(phase,'hidden');advance(6000);assert.equal(phase,'hidden');
open=false;account='D';render();advance(1000);auth.beginLogout();render();assert.equal(phase,'hidden');assert.equal(timers.size,0);
auth.beginAuthenticatedSession();account='E';render();advance(4500);assert.equal(phase,'entering');auth.beginLogout();render();assert.equal(phase,'hidden');assert.equal(timers.size,0);
auth.beginAuthenticatedSession();account='F';render();advance(2000);account='G';render();advance(2500);assert.equal(phase,'hidden');advance(2000);assert.equal(phase,'entering');
account='H';render();advance(1000);storage.setItem('echo_discovery_session',JSON.stringify({scope:'H',consumed:true,due:now+3500}));advance(5000);assert.equal(phase,'hidden'); // a different tab consumed the same login
slots.forEach(s=>s?.cleanup?.());assert.equal(timers.size,0);
const css=read('components/features/coach/echo.css');
assert.ok(!css.includes('.echo-root textarea:focus-visible { outline: 2px'));
assert.ok(css.includes('.echo-footer textarea:focus-visible { border: 0; outline: none; box-shadow: none; }'));
assert.ok(css.includes('form:focus-within') && css.includes('.echo-root button:focus-visible { outline: 2px'));
assert.ok(css.includes('prefers-reduced-motion') && css.includes('.echo-discovery[data-phase="leaving"] { opacity: 0; }'));
console.log('Echo micro-UX PASS: delay/entrance/dwell/exit, remount, refresh, open cancellation, visible dismissal, logout, account isolation, cleanup, composer/button focus and reduced motion.');
