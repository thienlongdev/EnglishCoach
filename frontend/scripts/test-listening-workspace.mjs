import assert from 'node:assert/strict';
import React from 'react';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(import.meta.url),babel=require('next/dist/compiled/babel/bundle.js');
const read=p=>readFileSync(new URL('../src/'+p,import.meta.url),'utf8');
function evaluate(path,deps={},globals={}){
  const {code}=babel.core().transformSync(read(path),{filename:path,configFile:false,babelrc:false,presets:[babel.presetTypescript(),...(path.endsWith('.tsx')?[babel.presetReact()]:[])],plugins:[babel.pluginTransformModulesCommonjs()]});
  const exports={};runInNewContext(code,{exports,require:p=>deps[p]??require(p),console,...globals});return exports;
}
let passed=0;const check=(name,fn)=>{fn();passed++;console.log('PASS '+name);};
const model=evaluate('lib/listeningCheckpoint.ts');
check('real timing ownership covers forward/backward jumps, gaps, overlaps and untimed documents',()=>{
  const segments=[{id:1,startTimeMs:1000,endTimeMs:5000},{id:2,startTimeMs:4000,endTimeMs:6000},{id:3,startTimeMs:9000,endTimeMs:10000}];
  assert.equal(model.listeningSentenceAtTime(segments,4.5),1);assert.equal(model.listeningSentenceAtTime(segments,7),1);assert.equal(model.listeningSentenceAtTime(segments,9.5),2);assert.equal(model.listeningSentenceAtTime(segments,1.5),0);
  assert.equal(model.listeningSentenceAtTime([{startTimeMs:null,endTimeMs:null}],2),-1);
});
check('independent drafts merge while a stale tab cannot overwrite simultaneous edits or a new checkpoint',()=>{
  const base={entries:{1:{draft:'one',status:'draft'}},selectedSegmentId:1,position:1};
  const local={entries:{1:{draft:'own edit',status:'draft'}},selectedSegmentId:2,position:2};
  const remote={entries:{1:{draft:'other edit',status:'draft'},3:{draft:'three',status:'completed'}},selectedSegmentId:3,position:3};
  const conflict=model.mergeListeningCheckpoint(base,local,remote);assert.equal(conflict.conflicts.length,1);assert.equal(conflict.state.entries[1].draft,'other edit');assert.equal(conflict.state.selectedSegmentId,3);
  const merge=model.mergeListeningCheckpoint(base,{...local,entries:{...base.entries,2:{draft:'second',status:'draft'}}},remote);assert.equal(merge.conflicts.length,0);assert.equal(merge.state.entries[2].draft,'second');assert.equal(merge.state.entries[3].status,'completed');
});
function playerHarness(free){
  const effects=[],intervals=new Map(),timers=new Map();let at=0,next=0;
  const hooks={...React,memo:fn=>fn,forwardRef:fn=>fn,useState:v=>[typeof v==='function'?v():v,()=>{}],useRef:v=>({current:v}),useMemo:fn=>fn(),useCallback:fn=>fn,useEffect:fn=>effects.push(fn),useImperativeHandle:(ref,fn)=>{ref.current=fn();}};
  const {AdvancedAudioPlayer}=evaluate('components/features/listening/AdvancedAudioPlayer.tsx',{react:hooks,'./PrivateAudioPlayer':{PrivateAudioPlayer:()=>null},'react-youtube':{default:'youtube'},'lucide-react':{AlertTriangle:()=>null,ExternalLink:()=>null}},
    {performance:{now:()=>at},setInterval:fn=>{intervals.set(++next,fn);return next;},clearInterval:id=>intervals.delete(id),setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)});
  const ref={current:null},events=[],seeks=[];let time=0,state=2;
  const props={audioUrl:'abcdefghijk',allowFreeSeek:free,onUserSeek:t=>events.push(t)};
  const element=AdvancedAudioPlayer(props,ref);const tree=element.type(props,ref);
  const cleanups=effects.map(effect=>effect()).filter(v=>typeof v==='function');
  const youtube=tree.props.children[0];
  const yt={getCurrentTime:()=>time,getPlayerState:()=>state,getPlaybackRate:()=>1,seekTo:t=>{seeks.push(t);time=t;},playVideo:()=>{state=1;},pauseVideo:()=>{state=2;}};
  youtube.props.onReady({target:yt});
  const tick=()=>{at+=50;for(const fn of [...intervals.values()])fn();};
  return {ref,events,seeks,yt,tick,youtube,setTime:t=>{time=t;},getTime:()=>time,cleanup:()=>cleanups.forEach(fn=>fn()),intervals,timers};
}
check('native forward/backward seeks cancel replay without bouncing; explicit replay still seeks exactly once',()=>{
  const p=playerHarness(true);p.ref.current.setLoop(10,12,true,2,.5);p.tick();
  p.setTime(90);p.tick();assert.equal(p.events.at(-1),90);assert.equal(p.getTime(),90);assert.equal(p.seeks.length,1);
  p.setTime(3);p.tick();assert.equal(p.events.at(-1),3);assert.equal(p.seeks.length,1);
  p.ref.current.setLoop(3,5,true,1,0);p.tick();assert.equal(p.seeks.at(-1),3);assert.equal(p.events.length,2);
  p.cleanup();assert.equal(p.intervals.size,0);assert.equal(p.timers.size,0);
});
check('paused native seeks are observed; programmatic resume never looks like a learner seek',()=>{
  const p=playerHarness(true);p.ref.current.seekTo(44);p.tick();assert.equal(p.events.length,0);
  p.setTime(95);p.tick();assert.equal(p.events.at(-1),95);p.cleanup();
});
check('existing locked/repeat engine remains the default for shared consumers',()=>{
  const p=playerHarness(false);p.ref.current.setLoop(10,12,true,2,0);p.tick();p.setTime(1);p.tick();assert.equal(p.seeks.at(-1),10);assert.equal(p.events.length,0);p.cleanup();
});
const timing=evaluate('components/features/listening/transcript-timing.ts');
const hooks={...React,useMemo:fn=>fn(),useRef:()=>({current:null}),useEffect(){}};
const {InteractiveTranscript}=evaluate('components/features/listening/InteractiveTranscript.tsx',{react:hooks,'./transcript-timing':timing,'lucide-react':{Play:()=>null},'./glass/listeningGlass.module.css':new Proxy({},{get:(_,key)=>String(key)})});
check('bilingual rows remove metadata, retain translation pairs, keyboard and untimed text navigation',()=>{
  const selected=[];const tree=InteractiveTranscript({segments:[{id:5,text:'Hello there.',speakerName:'Speaker',startTimeMs:1000,endTimeMs:2000}],currentTime:1,isBilingual:true,translations:{5:'Xin chào.'},onSegmentClick:ms=>selected.push(ms)});
  const row=tree.props.children[1].props.children[0];assert.equal(row.props.children[1],false);assert.equal(row.props.children[3].props.children,'Xin chào.');
  row.props.onKeyDown({key:'Enter',preventDefault(){}});assert.equal(selected[0],1000);
  row.props.children[2].props.children[0].props.onClick({stopPropagation(){}});assert.equal(selected[1],1000);
});
// Execute the actual checkpoint hook with a delayed backend response: typing during I/O must be debounced again.
{
  const effects=[],timers=new Map();let timerId=0;let resolveSave;const calls=[];
  const hooks={useRef:value=>({current:value}),useState:value=>[typeof value==='function'?value():value,()=>{}],useEffect:fn=>effects.push(fn),useCallback:fn=>fn};
  const initial={contentVersion:'version',revision:0,state:{entries:{}},savedAt:null};
  const storage=new Map();
  const api={getListeningCheckpoint:async()=>initial,saveListeningCheckpoint:(...args)=>{calls.push(args);return new Promise(resolve=>{resolveSave=resolve;});}};
  const {useListeningCheckpoint}=evaluate('hooks/useListeningCheckpoint.ts',{react:hooks,'@/services/listeningWorkspaceApi':api,'@/lib/listeningCheckpoint':model,'@/lib/auth-lifecycle':{authEpoch:()=>0,assertAuthEpoch(){},authEnding:()=>false}},
    {localStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)},window:{addEventListener(){},removeEventListener(){}},document:{addEventListener(){},removeEventListener(){}},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
  const hook=useListeningCheckpoint('learner',44);effects.forEach(fn=>fn());await Promise.resolve();
  hook.update(prev=>({...prev,entries:{1:{draft:'first',status:'draft'}}}));
  const saving=hook.save();hook.update(prev=>({...prev,entries:{1:{draft:'typing continues',status:'draft'}}}));
  resolveSave({...initial,revision:1,state:calls[0][3]});await saving;
  assert.equal(calls.length,1,'no immediate second request while typing');assert.equal(timers.size,1,'a fresh debounce is scheduled');
  const callback=[...timers.values()][0];callback();assert.equal(calls.length,2);assert.equal(calls[1][3].entries[1].draft,'typing continues');
  resolveSave({...initial,revision:2,state:calls[1][3]});await Promise.resolve();
  passed++;console.log('PASS actual checkpoint hook debounces edits arriving during backend I/O');
}
console.log(`Listening workspace PASS (${passed} groups)`);
