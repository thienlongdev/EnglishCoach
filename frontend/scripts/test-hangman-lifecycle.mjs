import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import * as rig from '../src/components/features/games/hangman/hangmanRig.ts';
import * as presentation from '../src/components/features/games/hangman/hangmanPresentation.ts';
const require=createRequire(import.meta.url), babel=require('next/dist/compiled/babel/bundle.js');
const compile=file=>babel.core().transformSync(readFileSync(new URL('../src/components/features/games/hangman/'+file,import.meta.url),'utf8'),{filename:file,configFile:false,babelrc:false,presets:[babel.presetTypescript(),babel.presetReact()],plugins:[babel.pluginTransformModulesCommonjs()]}).code;
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const fresh=(id='a',difficulty='EASY')=>({roundId:id,difficulty,levelNumber:1,category:'Fixture',pattern:[null,null,null],prefilledLetters:[],correctLetters:[],wrongLetters:[],hintedLetters:[],initialBalloons:10,remainingBalloons:10,hintsRemaining:2,status:'ACTIVE',version:0,score:null,answer:null,nextLevelAvailable:false});
const track=(difficulty='EASY',currentRoundId='a')=>({difficulty,currentRoundId,highestUnlocked:2,lastPlayedLevel:1,publishedLevels:20,catalogCompleted:false});
const data=()=>({tracks:[track(),track('MEDIUM','m'),track('HARD','h')]});
let historyEntries=[],historyAt=0;
const history={get state(){return historyEntries[historyAt]?.state;},replaceState(state,_,url){historyEntries[historyAt]={state,url};},pushState(state,_,url){historyEntries=historyEntries.slice(0,historyAt+1);historyEntries.push({state,url});historyAt++;},back(){historyAt=Math.max(0,historyAt-1);},forward(){historyAt=Math.min(historyEntries.length-1,historyAt+1);}};
const currentParams=()=>new URL(historyEntries[historyAt]?.url??'/games/hangman','https://fixture.invalid').searchParams;

function harness(file,mocks,reduced=false){
  let cursor=0,now=0;const slots=[],effects=[],frames=new Map(),listeners=new Map();let frameId=0;
  const memo=(fn,deps)=>{const i=cursor++;if(!slots[i]||deps.some((v,n)=>v!==slots[i].deps[n]))slots[i]={value:fn(),deps};return slots[i].value;};
  const effect=(fn,deps)=>{const i=cursor++;if(!slots[i]||deps.some((v,n)=>v!==slots[i].deps[n])){slots[i]?.cleanup?.();slots[i]={deps};effects.push(()=>{slots[i].cleanup=fn();});}};
  const hooks={useId:()=> 'fixture-scene',useState(initial){const i=cursor++;slots[i]??={value:initial};return[slots[i].value,v=>slots[i].value=typeof v==='function'?v(slots[i].value):v];},useRef(initial){const i=cursor++;slots[i]??={current:initial};return slots[i];},useCallback:(fn,deps)=>memo(()=>fn,deps),useMemo:memo,useEffect:effect,useLayoutEffect:effect};
  const exports={};const attributes=new Map();const dom={setAttribute:(key,value)=>attributes.set(key,value)};
  const requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId;};
  runInNewContext(compile(file),{exports,React,require:name=>name==='react'?hooks:name.includes('hangmanPresentation')?presentation:name.includes('hangmanRig')?rig:name==='lucide-react'?new Proxy({},{get:()=>()=>null}):name.endsWith('.css')?{}:mocks(name),performance:{now:()=>now},requestAnimationFrame,cancelAnimationFrame:id=>frames.delete(id),window:{history,localStorage:{getItem:()=>null},addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key),matchMedia:()=>({matches:reduced})},console});
  let tree;
  const visit=(node,fn)=>{if(!node)return;if(Array.isArray(node)){node.forEach(n=>visit(n,fn));return;}if(typeof node==='object'){fn(node);visit(node.props?.children,fn);}};
  const render=(...args)=>{cursor=0;tree=exports[file==='HangmanGame.tsx'?'HangmanGame':'HangmanScene'](...args);visit(tree,node=>{if(node.props?.ref)node.props.ref.current=dom;});while(effects.length)effects.shift()();return tree;};
  const find=predicate=>{let result;visit(tree,node=>{if(predicate(node))result=node;});assert.ok(result,'Expected rendered control');return result;};
  const all=predicate=>{const result=[];visit(tree,node=>{if(predicate(node))result.push(node);});return result;};
  return{render,find,all,listeners,attributes,frames,advance(value){now=value;const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn(now));},unmount(){slots.forEach(slot=>slot?.cleanup?.());}};
}
let bootstrapCalls=0,getCalls=0,startCalls=0;
let locale='en',account='owner',saved=fresh(),bootstrap=data(),guessWait=null,guessCalls=0,startLevels=[];
const api={bootstrap:async()=>{bootstrapCalls++;return bootstrap;},get:async id=>{getCalls++;return id==='a'?saved:fresh(id,id==='m'?'MEDIUM':'HARD');},start:async(d,n)=>{startCalls++;startLevels.push(n);return saved.status==='ACTIVE'&&saved.difficulty===d?saved:fresh('new',d);},guess:async(r,letter)=>{guessCalls++;return guessWait?guessWait.promise:{...r,version:r.version+1,wrongLetters:[letter],remainingBalloons:r.remainingBalloons-1};},hint:async r=>({...r,version:r.version+1,hintedLetters:['A']}),retry:async()=>fresh('retry')};
const Scene=()=>null;
const mocks=name=>name==='next-auth/react'?{useSession:()=>({data:{user:{id:account}}})}:name==='next/navigation'?{useSearchParams:currentParams}:name==='next/link'?{default:()=>null}:name.includes('LanguageContext')?{useLanguage:()=>({locale})}:name.includes('hangmanApi')?{hangmanApi:api,newHangmanRequestId:()=> 'fixture-id'}:name==='./HangmanScene'?{HangmanScene:Scene}:require(name);
const isCta=(node,text)=>node.type==='button'&&node.props?.children?.some?.(x=>x===text);
const boot=async(url='/games/hangman?difficulty=EASY&view=play',keepHistory=false)=>{
 if(!keepHistory){historyEntries=[{state:null,url}];historyAt=0;}
 const h=harness('HangmanGame.tsx',mocks);h.render();await flush();h.render();return h;
};
// Entry never auto-enters a saved round and has no gameplay keyboard handler.
const entry=await boot('/games/hangman');
assert.equal(entry.all(n=>n.type===Scene).length,0);assert.equal(entry.listeners.size,0);
assert.equal(entry.all(n=>typeof n.props?.['aria-pressed']==='boolean').length,3);
entry.find(n=>isCta(n,'Play Now')).props.onClick();await flush();entry.render();
assert.equal(entry.find(n=>n.type===Scene).props.round.roundId,'a','Play resumes authoritative saved round');
assert.equal(entry.all(n=>n.props?.role==='group').length,0,'No compact gameplay difficulty selector');
assert.equal(currentParams().get('view'),'play');
entry.find(n=>isCta(n,'Choose difficulty')).props.onClick();entry.render();
assert.equal(entry.all(n=>n.type===Scene).length,0);assert.equal(entry.listeners.size,0);
entry.find(n=>isCta(n,'Play Now')).props.onClick();await flush();entry.render();
assert.equal(entry.find(n=>n.type===Scene).props.round.roundId,'a');
entry.unmount();

const h=await boot();assert.equal(historyEntries.length,2,'Direct play route has entry predecessor');
guessWait=deferred();h.find(n=>n.props?.['aria-label']==='Z').props.onClick();h.render();
assert.equal(h.find(n=>n.props?.['aria-label']==='Z').props['aria-busy'],true);assert.equal(h.find(n=>n.props?.['aria-label']==='Y').props.disabled,true);
h.listeners.get('keydown')({key:'Z',target:{tagName:'BODY'},preventDefault(){}});assert.equal(guessCalls,1);
guessWait.resolve({...saved,version:1,wrongLetters:['Z'],remainingBalloons:9});await flush();h.render();
assert.equal(h.find(n=>n.type===Scene).props.round.remainingBalloons,9);
h.find(n=>n.props?.['aria-label']==='Z used').props.onClick();assert.equal(guessCalls,1);
h.find(n=>isCta(n,'Choose difficulty')).props.onClick();h.render();assert.equal(h.listeners.size,0);
history.forward();h.render();assert.equal(h.find(n=>n.type===Scene).props.round.version,1,'Browser Back/Forward preserves in-memory progress');
// A refresh retains the play URL marker and the same server snapshot.
saved={...saved,version:1,wrongLetters:['Z'],remainingBalloons:9,hintedLetters:['B'],hintsRemaining:1};
h.unmount();const refreshed=await boot(undefined,true);assert.equal(historyEntries.length,2);
assert.equal(refreshed.find(n=>n.type===Scene).props.round.version,1);assert.equal(refreshed.find(n=>n.type===Scene).props.round.hintsRemaining,1);
guessWait=deferred();refreshed.find(n=>n.props?.['aria-label']==='Y').props.onClick();account='new-owner';refreshed.render();await flush();refreshed.render();
guessWait.resolve({...saved,version:99,remainingBalloons:0,status:'LOST'});await flush();refreshed.render();
assert.equal(refreshed.find(n=>n.type===Scene).props.round.status,'ACTIVE','Old account response rejected');refreshed.unmount();
assert.equal(refreshed.listeners.size,0);assert.equal(refreshed.frames.size,0);

guessWait=null;account='owner';saved={...fresh(),status:'WON',nextLevelAvailable:true};
const won=await boot('/games/hangman');won.find(n=>isCta(n,'Play Now')).props.onClick();await flush();won.render();assert.equal(startLevels.at(-1),2);won.unmount();
saved={...fresh(),status:'LOST'};const lost=await boot('/games/hangman');lost.find(n=>isCta(n,'Play Now')).props.onClick();await flush();lost.render();assert.equal(startLevels.at(-1),1);lost.unmount();

saved=fresh();const fail=await boot();guessWait=deferred();fail.find(n=>n.props?.['aria-label']==='Z').props.onClick();guessWait.reject(Error('network'));await flush();fail.render();
assert.equal(fail.find(n=>n.type===Scene).props.round.remainingBalloons,10);assert.equal(fail.find(n=>n.props?.['aria-label']==='Y').props.disabled,false);fail.unmount();guessWait=null;
for(const language of ['vi','en']){
 locale=language;const intro=await boot('/games/hangman');
 for(const [i,d] of ['EASY','MEDIUM','HARD'].entries()){
  intro.all(n=>n.type==='button'&&typeof n.props?.['aria-pressed']==='boolean')[i].props.onClick();intro.render();await flush();intro.render();
  assert.equal(intro.all(n=>n.type===Scene).length,0,'Track selection remains at entry');
  assert.equal(currentParams().get('difficulty'),null,'Selection never changes URL');
  assert.equal(intro.all(n=>n.props?.['aria-pressed']===true).length,1);
 }
 const before=[bootstrapCalls,getCalls,startCalls],url=historyEntries[historyAt].url,depth=historyEntries.length;
 for(const selected of [0,1,2,0,2,1]){
  intro.all(n=>n.type==='button'&&typeof n.props?.['aria-pressed']==='boolean')[selected].props.onClick();intro.render();await flush();intro.render();
  assert.deepEqual([bootstrapCalls,getCalls,startCalls],before,'Card selection makes zero API requests');
  assert.equal(historyEntries[historyAt].url,url);assert.equal(historyEntries.length,depth);
  const cards=intro.all(n=>n.type==='button'&&typeof n.props?.['aria-pressed']==='boolean');assert.equal(cards[selected].props['aria-pressed'],true);
  assert.equal(intro.all(n=>n.props?.['aria-busy']===true).length,0,'No selecting loading screen');
 }
 intro.find(n=>isCta(n,language==='vi'?'Chơi ngay':'Play Now')).props.onClick();await flush();intro.render();
 assert.equal(intro.find(n=>n.type===Scene).props.round.difficulty,'MEDIUM');assert.equal(currentParams().get('difficulty'),'MEDIUM');intro.unmount();
}
locale='en';saved=fresh();bootstrap=data();
const terminal=await boot();guessWait=deferred();terminal.find(n=>n.props?.['aria-label']==='Z').props.onClick();
guessWait.resolve({...saved,status:'LOST',version:1,remainingBalloons:0,pattern:['A','B','C'],answer:'ABC'});await flush();terminal.render();
assert.ok(terminal.find(n=>n.props?.['aria-label']==='blank blank blank'));assert.equal(terminal.all(n=>isCta(n,'Retry')).length,0);
terminal.find(n=>n.type===Scene).props.onLossComplete('a');terminal.render();assert.ok(terminal.find(n=>n.props?.['aria-label']==='A B C'));terminal.unmount();guessWait=null;

let completions=0;const scene=harness('HangmanScene.tsx',name=>name==='./HangmanArtwork'?{ExplorerRig:()=>null,SharkRig:()=>null,ArtPalette:()=>null}:require(name));
let r=fresh();const props=()=>({round:r,onLossComplete:()=>completions++});scene.render(props());scene.advance(100);r={...r,version:1,remainingBalloons:0,status:'LOST'};scene.render(props());scene.render(props());
scene.advance(100+2850);assert.equal(scene.attributes.get('data-phase'),'SHARK_BITE');assert.equal(completions,0);scene.render(props());scene.advance(100+4400);scene.advance(100+5000);assert.equal(completions,1);
r=fresh('retry');scene.render(props());scene.render(props());scene.advance(6000);assert.equal(scene.attributes.get('data-phase'),'IDLE');scene.unmount();assert.equal(scene.frames.size,0);
let shortCompletions=0;const short=harness('HangmanScene.tsx',name=>name==='./HangmanArtwork'?{ExplorerRig:()=>null,SharkRig:()=>null,ArtPalette:()=>null}:require(name),true);
short.render({round:{...fresh(),status:'LOST',remainingBalloons:0},onLossComplete:()=>shortCompletions++});short.advance(1099);assert.equal(shortCompletions,0);short.advance(1100);assert.equal(shortCompletions,1);short.advance(1200);assert.equal(shortCompletions,1);short.unmount();
console.log('Hangman V4.3 component lifecycle PASS: entry/play history, keyboard cleanup, resume/refresh, stale account, request lock, difficulty/localization, masked loss and once-only/reduced result.');
