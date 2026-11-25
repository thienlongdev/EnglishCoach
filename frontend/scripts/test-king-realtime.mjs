import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require=createRequire(import.meta.url),babel=require('next/dist/compiled/babel/bundle.js');
const root='../src/components/features/games/king-of-english/';
const compile=(name,jsx=false)=>babel.core().transformSync(readFileSync(new URL(root+name,import.meta.url),'utf8'),{
  filename:name,configFile:false,babelrc:false,presets:[babel.presetTypescript(),...(jsx?[babel.presetReact()]:[])],
  plugins:[babel.pluginTransformModulesCommonjs()],
}).code;
let count=0;
const check=(name,fn)=>{fn();count++;console.log(`PASS ${name}`);};

// Execute the actual hook with deterministic hooks/transport/timers. Browser evidence separately proves DOM mounting.
let slots=[],index=0,effects=[],cleanups=[],session={user:{id:'1'},accessToken:'fixture'},epoch=1,ending=false;
let timerId=0,id=0;
let transportAuthorization='Bearer refreshed-backend-token',transportCalls=0,transportFailure=null,transportWait=null;
const timers=new Map(),intervals=new Set(),sockets=[];
const hooks={
  useState(initial){const n=index++;if(!(n in slots))slots[n]=initial;return [slots[n],value=>slots[n]=typeof value==='function'?value(slots[n]):value];},
  useRef(initial){const n=index++;if(!(n in slots))slots[n]={current:initial};return slots[n];},
  useCallback(fn){index++;return fn;},
  useEffect(fn){index++;effects.push(fn);},
};
class Client{
  constructor(config){Object.assign(this,config);this.connected=false;this.published=[];sockets.push(this);}
  activate(){this.activated=true;}
  deactivate(){this.deactivated=true;this.connected=false;return Promise.resolve();}
  subscribe(destination,fn){this.subscription=destination;this.receive=fn;}
  publish(message){this.published.push({...message,payload:JSON.parse(message.body)});}
  connect(){this.connected=true;this.onConnect();const sync=this.published.findLast(x=>x.destination==='/app/king-of-english/sync');if(sync)this.emit({type:'SYNC',messageId:sync.payload.messageId});}
  emit(event){this.receive({body:JSON.stringify(event)});}
}
let href='http://localhost/games/king-of-english';
const window={location:{get href(){return href;},get search(){return new URL(href).search;}},history:{state:null,replaceState(_state,_title,url){href=String(url);}}};
const exports={};
runInNewContext(compile('useKingRealtime.ts'),{exports,require:name=>{
  if(name==='react')return hooks;if(name==='@stomp/stompjs')return {Client};
  if(name==='next-auth/react')return {useSession:()=>({data:session}),getSession:async()=>session};
  if(name==='@/services/api-client')return {apiClient:{get:async path=>{
    assert.equal(path,'/king-of-english/config');transportCalls++;
    if(transportWait)await transportWait;
    if(transportFailure)throw transportFailure;
    return {config:{headers:{Authorization:transportAuthorization}}};
  }}};
  if(name==='@/services/stompClient')return {getWsUrl:()=> 'ws://fixture'};
  if(name==='@/lib/auth-lifecycle')return {authEpoch:()=>epoch,authEnding:()=>ending};
  throw Error(name);
},window,URL,URLSearchParams,Date,crypto:{randomUUID:()=>`id-${++id}`},
  setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:n=>timers.delete(n),
  setInterval:fn=>{const n=++timerId;timers.set(n,fn);intervals.add(n);return n;},clearInterval:n=>{timers.delete(n);intervals.delete(n);},console});
const render=()=>{index=0;effects=[];return exports.useKingRealtime();};
const mount=()=>{render();cleanups=effects.map(fn=>fn()).filter(Boolean);return render();};
const unmount=()=>{cleanups.forEach(fn=>fn());cleanups=[];};
const state=(revision=1)=>({roomCode:'ABCDEF12',matchId:'match-1',revision,inputRevision:0,round:0,serverTimestamp:Date.now(),score:0});
let hook=mount(),socket=sockets.at(-1);
await socket.beforeConnect();
check('CONNECT follows a backend-validated read (which renews the session cookie) and carries no token in the frame',()=>{
  assert.equal(transportCalls,1);assert.equal(Object.keys(socket.connectHeaders).length,0);
});
transportAuthorization='Bearer refreshed-after-expiry';await socket.beforeConnect();
check('reconnect repeats the validated read; the handshake cookie, not a header, authenticates',()=>{
  assert.equal(transportCalls,2);assert.equal(Object.keys(socket.connectHeaders).length,0);
});
socket.connect();hook=render();
check('mount activates one dedicated client and private subscription',()=>{assert.equal(sockets.length,1);assert.equal(socket.subscription,'/user/queue/king-of-english');assert.equal(hook.connected,true);});
check('pending rejects concurrent submission and matches ACK receipt',()=>{
  assert.equal(hook.send('start',{mode:'REFLEX',flow:'SOLO'}),true);assert.equal(hook.send('start'),false);
  const receipt=socket.published.at(-1).payload.messageId;
  socket.emit({type:'ACK',messageId:receipt,state:state()});hook=render();assert.equal(hook.pending,false);assert.equal(hook.state.roomCode,'ABCDEF12');
});
check('server state controls match revision and older broadcasts are ignored',()=>{
  socket.emit({type:'STATE',state:state(4)});socket.emit({type:'STATE',state:state(2)});hook=render();assert.equal(hook.state.revision,4);
  hook.send('answer',{answer:'word'});const body=socket.published.at(-1).payload;assert.equal(body.matchId,'match-1');assert.equal(body.revision,0);assert.equal(body.round,0);
  socket.emit({type:'ERROR',messageId:body.messageId,code:'STALE_ROUND'});hook=render();assert.equal(hook.pending,false);assert.equal(hook.error,'STALE_ROUND');
});
check('timeout recovers through rejoin without replaying answer or creating room',()=>{
  hook.send('answer',{answer:'word'});const timeout=[...timers.entries()].at(-1);timers.delete(timeout[0]);timeout[1]();hook=render();
  assert.equal(hook.pending,false);assert.equal(hook.error,'REQUEST_TIMEOUT');assert.equal(socket.published.at(-1).destination,'/app/king-of-english/rejoin');
});
check('socket reconnect sends rejoin and preserves server-owned score',()=>{
  socket.onWebSocketClose();hook=render();assert.equal(hook.connected,false);socket.connect();
  assert.equal(socket.published.at(-1).payload.roomCode,'ABCDEF12');assert.equal(socket.published.at(-1).destination,'/app/king-of-english/rejoin');
  hook=render();assert.equal(hook.connected,false);assert.equal(hook.send('start'),false);socket.emit({type:'STATE',state:state(4)});
});
check('leave ACK clears state and URL recovery key',()=>{
  hook=render();hook.send('leave');const receipt=socket.published.at(-1).payload.messageId;
  socket.emit({type:'ACK',messageId:receipt,state:state(5)});hook=render();assert.equal(hook.state,null);assert.equal(new URL(href).searchParams.has('room'),false);
});
check('expired finished room leave error still returns to lobby',()=>{
  href='http://localhost/games/king-of-english?room=ABCDEF12';
  socket.emit({type:'STATE',state:{...state(6),status:'FINISHED'}});hook=render();
  assert.equal(hook.send('leave'),true);const receipt=socket.published.at(-1).payload.messageId;
  socket.emit({type:'ERROR',messageId:receipt,code:'ROOM_NOT_FOUND'});hook=render();
  assert.equal(hook.state,null);assert.equal(hook.pending,false);assert.equal(hook.error,null);assert.equal(new URL(href).searchParams.has('room'),false);
});
check('auth epoch prevents old send and old user event acceptance',()=>{
  epoch++;assert.equal(hook.send('start'),false);socket.emit({type:'STATE',state:state(6)});hook=render();assert.equal(hook.state,null);
});
check('unmount clears owned timers and deactivates client',()=>{unmount();assert.equal(socket.deactivated,true);assert.equal(timers.size,0);});
check('new account begins without previous score or pending request',()=>{
  session={user:{id:'2'},accessToken:'fixture-2'};hook=mount();socket=sockets.at(-1);assert.equal(hook.state,null);assert.equal(hook.pending,false);assert.equal(hook.connected,false);
});
check('URL recovery mounts and issues rejoin once connected',()=>{
  unmount();href='http://localhost/games/king-of-english?room=ABCDEF12';hook=mount();socket=sockets.at(-1);socket.connect();assert.equal(socket.published.length,2);assert.equal(socket.published[1].destination,'/app/king-of-english/rejoin');
  hook=render();assert.equal(hook.connected,false);assert.equal(hook.send('start'),false);
  socket.emit({type:'ERROR',code:'ROOM_NOT_FOUND'});hook=render();assert.equal(new URL(href).searchParams.has('room'),false);assert.equal(hook.connected,true);
  hook.send('start');const receipt=socket.published.at(-1).payload.messageId;socket.emit({type:'ACK',messageId:receipt,state:state()});hook=render();assert.equal(hook.error,null);unmount();
});
check('direct invite falls back from nonmember rejoin to one bounded join',()=>{
  href='http://localhost/games/king-of-english?room=ABCDEF12';hook=mount();socket=sockets.at(-1);socket.connect();
  socket.emit({type:'ERROR',code:'NOT_A_MEMBER'});const join=socket.published.at(-1);assert.equal(join.destination,'/app/king-of-english/join');
  socket.emit({type:'ERROR',code:'NOT_A_MEMBER'});assert.equal(socket.published.filter(x=>x.destination.endsWith('/join')).length,1);
  socket.emit({type:'ACK',messageId:join.payload.messageId,state:state()});hook=render();assert.equal(hook.pending,false);assert.equal(hook.state.roomCode,'ABCDEF12');unmount();
});
check('unconfirmed subscription never enables room mutations and times out visibly',()=>{
  href='http://localhost/games/king-of-english';hook=mount();socket=sockets.at(-1);socket.connected=true;socket.onConnect();hook=render();
  assert.equal(hook.connected,false);assert.equal(hook.send('start'),false);assert.equal(socket.published.at(-1).destination,'/app/king-of-english/sync');
  // First owned timeout bounds the entire connect/synchronize phase.
  const deadline=[...timers.entries()][0];timers.delete(deadline[0]);deadline[1]();hook=render();
  assert.equal(hook.error,'CONNECTION_TIMEOUT');assert.equal(socket.deactivated,true);unmount();
});
href='http://localhost/games/king-of-english';
hook=mount();socket=sockets.at(-1);transportAuthorization=null;await socket.beforeConnect();hook=render();
check('no request header is consulted: the validated read alone admits the connection',()=>{
  assert.equal(socket.deactivated,undefined);assert.equal(Object.keys(socket.connectHeaders).length,0);assert.equal(hook.error,null);
});unmount();
hook=mount();socket=sockets.at(-1);transportFailure=new Error('offline');await socket.beforeConnect();hook=render();
check('failed credential validation stops socket activation without leaking credentials',()=>{
  assert.equal(socket.deactivated,true);assert.equal(socket.connectHeaders,undefined);assert.equal(hook.error,'SERVER_UNAVAILABLE');
});unmount();transportFailure=null;transportAuthorization='Bearer current-token';
let releaseTransport;transportWait=new Promise(resolve=>{releaseTransport=resolve;});
hook=mount();socket=sockets.at(-1);const oldSocket=socket,oldConnect=socket.beforeConnect();
unmount();hook=mount();const newSocket=sockets.at(-1);releaseTransport();await oldConnect;transportWait=null;
await newSocket.beforeConnect();newSocket.connect();hook=render();
check('cleanup of an in-flight old connection cannot destroy the new valid socket',()=>{
  assert.equal(oldSocket.deactivated,true);assert.equal(oldSocket.connectHeaders,undefined);
  assert.equal(newSocket.deactivated,undefined);assert.equal(hook.connected,true);
});unmount();
transportWait=new Promise(resolve=>{releaseTransport=resolve;});
hook=mount();socket=sockets.at(-1);const endedConnect=socket.beforeConnect();epoch++;ending=true;
releaseTransport();await endedConnect;
check('logout during credential refresh prevents late Authorization publication',()=>{
  assert.equal(socket.deactivated,true);assert.equal(socket.connectHeaders,undefined);
});unmount();ending=false;transportWait=null;
hook=mount();socket=sockets.at(-1);socket.connect();
check('heartbeat keeps active and finished rooms alive and preserves finished terminal results after room TTL',()=>{
  const heartbeat=()=>timers.get([...intervals][0])?.();
  socket.emit({type:'STATE',state:{...state(7),status:'PLAYING'}});hook=render();
  const before=socket.published.filter(x=>x.destination==='/app/king-of-english/ping').length;heartbeat();
  assert.equal(socket.published.filter(x=>x.destination==='/app/king-of-english/ping').length,before+1);
  socket.emit({type:'STATE',state:{...state(8),status:'FINISHED'}});hook=render();
  const finishedBefore=socket.published.filter(x=>x.destination==='/app/king-of-english/ping').length;heartbeat();hook=render();
  assert.equal(socket.published.filter(x=>x.destination==='/app/king-of-english/ping').length,finishedBefore+1,'a finished room stays alive for replay / rematch');
  socket.emit({type:'ERROR',code:'ROOM_NOT_FOUND'});hook=render();
  assert.equal(hook.state.status,'FINISHED');
  assert.equal(hook.error,null);
  socket.onWebSocketClose();socket.connect();
  socket.emit({type:'ERROR',code:'ROOM_NOT_FOUND'});hook=render();
  assert.equal(hook.state.status,'FINISHED');assert.equal(hook.error,null);assert.equal(hook.connected,true);
  // A learner-requested rematch after expiry must still explain why it failed.
  assert.equal(hook.send('rematch'),true);const receipt=socket.published.at(-1).payload.messageId;
  socket.emit({type:'ERROR',code:'ROOM_NOT_FOUND',messageId:receipt});hook=render();
  assert.equal(hook.state.status,'FINISHED');assert.equal(hook.error,'ROOM_NOT_FOUND');assert.equal(hook.pending,false);
});
unmount();
hook=mount();socket=sockets.at(-1);socket.connect();socket.emit({type:'STATE',state:{...state(20),status:'PLAYING'}});hook=render();
check('a word leaves at once, the next does not wait for it, and each is settled by its own id',()=>{
  assert.equal(hook.submitMove('cat',[0,1,2]),true);assert.equal(hook.submitMove('dog',[3,4,5]),true);
  const sent=socket.published.filter(x=>x.destination==='/app/king-of-english/move');assert.equal(sent.length,2);
  hook=render();assert.equal(hook.moves.length,2);assert.equal(hook.pending,false);
  socket.emit({type:'ERROR',messageId:sent[0].payload.messageId,code:'WORD_USED'});hook=render();assert.equal(hook.refused.word,'cat');assert.equal(hook.moves.length,1);
  socket.emit({type:'ACK',messageId:sent[1].payload.messageId,state:{...state(21),status:'PLAYING'}});hook=render();assert.equal(hook.moves.length,0);assert.equal(hook.refused,null);
});
check('a word sent into a dropped connection goes again with its own id after the rejoin, never twice',()=>{
  socket.onWebSocketClose();hook=render();assert.equal(hook.connected,false);
  assert.equal(hook.submitMove('fish',[6,7,8]),true);hook=render();assert.equal(hook.moves.length,1);
  const before=socket.published.filter(x=>x.destination.endsWith('/move')).length;
  socket.connect();assert.equal(socket.published.filter(x=>x.destination.endsWith('/move')).length,before,'nothing goes before the room is rejoined');
  socket.emit({type:'STATE',state:{...state(22),status:'PLAYING'}});
  const moves=socket.published.filter(x=>x.destination.endsWith('/move'));assert.equal(moves.length,before+1);assert.equal(moves.at(-1).payload.answer,'fish');
  socket.emit({type:'STATE',state:{...state(23),status:'PLAYING'}});assert.equal(socket.published.filter(x=>x.destination.endsWith('/move')).length,before+1);
  socket.emit({type:'ACK',messageId:moves.at(-1).payload.messageId});hook=render();assert.equal(hook.moves.length,0);
});
check('the end of a match empties the queue: a late word never reaches another match',()=>{
  hook.submitMove('bird',[9,10,11]);hook=render();assert.equal(hook.moves.length,1);
  socket.emit({type:'STATE',state:{...state(24),status:'FINISHED'}});hook=render();assert.equal(hook.moves.length,0);
});
unmount();
hook=mount();socket=sockets.at(-1);transportFailure=new Error('offline');await socket.beforeConnect();hook=render();
{
  const retry=[...timers.entries()].at(-1);
  check('a server that does not answer is tried again, not given up on',()=>{assert.equal(socket.deactivated,true);assert.equal(hook.error,'SERVER_UNAVAILABLE');assert(retry);});
  transportFailure=null;socket.activated=false;timers.delete(retry[0]);retry[1]();await Promise.resolve();await Promise.resolve();
  check('the retry opens the connection again by itself',()=>{assert.equal(socket.activated,true);});
}
unmount();
transportFailure=Object.assign(new Error('signed out'),{response:{status:401}});
hook=mount();socket=sockets.at(-1);const timersBefore=timers.size;await socket.beforeConnect();hook=render();
check('an ended session stops the attempts and says so',()=>{assert.equal(hook.error,'AUTH_REQUIRED');assert.equal(timers.size,timersBefore);});
unmount();transportFailure=null;

const css=new Proxy({},{get:(t,k)=>k==='__esModule'?false:String(k)});
const framer={useReducedMotion:()=>true,motion:{button:React.forwardRef(({layout,whileTap,transition,...props},ref)=>React.createElement('button',{...props,ref}))}};
const sibling=(file)=>{const exports={};runInNewContext(compile(file,true),{exports,React,console,require:name=>{
  if(name==='react')return React;if(name==='react-dom')return {createPortal:node=>node};if(name==='framer-motion')return framer;if(name==='lucide-react')return new Proxy({},{get:()=>()=>null});
  if(name==='./king.module.css')return css;throw Error(name);}});return exports;};
const arena={};
runInNewContext(compile('KingArena.tsx',true),{exports:arena,require:name=>{
  if(name==='react')return React;
  if(name==='react-dom')return {createPortal:node=>node};
  if(name==='framer-motion')return framer;
  if(name==='./king.module.css')return css;
  if(name==='./kingArt')return {KING_ART:{},KING_MODE_ART:{}};
  if(name==='./KingChain')return sibling('KingChain.tsx');
  if(name==='./KingFeedback')return sibling('KingFeedback.tsx');
  if(name==='lucide-react')return new Proxy({},{get:()=>()=>null});
  if(name==='@/components/ui/button')return {Button:({variant,...props})=>React.createElement('button',props)};
  if(name.endsWith('BrandWhaleIcon'))return {BrandWhaleIcon:()=>null};
  if(name==='./KingShell')return {KingShell:({children})=>children};
  if(name==='./KingExplainRound')return {KingExplainRound:()=>null};
  if(name==='./KingConquestBoard')return {KingConquestBoard:()=>null};
  if(name==='./KingConquestRanks')return {KingConquestRanks:()=>null};
  if(name==='./KingHud')return {KingHud:()=>null,ChampionshipBreakdown:()=>null,modeName:()=>''};
  if(name==='./kingErrors')return {kingError:code=>code};
  if(name==='./useKingRealtime')return {useKingRealtime:()=>({})};
  if(name==='./kingAudio')return {KingAudio:class {enable(){} play(){} close(){}}};
  // Echo Sentinel (10 §BX): its own contract lives in test-echo-sentinel.mjs.
  if(name==='@/components/sentinel/StrictModeDialogs')return {StrictModeGate:()=>null,StrictExitConfirm:()=>null,AttemptVoided:()=>null};
  if(name==='@/components/sentinel/useFocusLockdown')return {useFocusLockdown:()=>({report:async()=>null})};
  if(name==='@/lib/sentinel/client')return {beginAttempt:async()=>null,isVoided:()=>false,sentinelHandle:()=>''};
  throw Error(name);
},React,console,Date,setInterval,clearInterval});
const props={vi:false,disabled:false,selected:[],setSelected:()=>{},answer:'',setAnswer:()=>{},submit:()=>{}};
const markup=item=>renderToStaticMarkup(React.createElement(arena.ChallengeInput,{...props,item}));
check('tile renderer preserves repeated word IDs and accessible undo/place controls',()=>{
  const html=markup({tiles:[{id:0,text:'had'},{id:1,text:'had'}],options:[]});assert.equal((html.match(/aria-label="Place had"/g)||[]).length,2);assert(html.includes('Your answer'));assert(html.includes('Clear'));assert(html.includes('disabled=""'));
});
check('new shorter challenge cannot crash on a selection from the previous tile set',()=>{
  const html=renderToStaticMarkup(React.createElement(arena.ChallengeInput,{...props,selected:[4,5],item:{tiles:[{id:0,text:'new'},{id:1,text:'tiles'}],options:[]}}));
  assert(html.includes('Place new'));assert(!html.includes('Remove undefined'));
});
check('option renderer has readable buttons and no repeat-guess input',()=>{const html=markup({options:['make','do','paint']});assert(html.includes('make'));assert(!html.includes('<input'));assert.equal((html.match(/<button/g)||[]).length,3);});
check('text renderer has bounded labelled input and native form submit',()=>{const html=markup({options:[]});assert(html.includes('Your answer'));assert(html.includes('maxLength="160"'));assert(html.includes('<form'));assert(html.includes('type="submit"'));});
check('all renderers honor pending/connection/lock disabled state',()=>{
  for(const item of [{tiles:[{id:0,text:'a'}],options:[]},{options:['a','b']},{options:[]}]){
    const html=renderToStaticMarkup(React.createElement(arena.ChallengeInput,{...props,disabled:true,item}));assert(html.includes('disabled=""'));
  }
});
console.log(`King Phase 2 lifecycle/renderer checks: ${count} passed; simulated hooks/transport + real React SSR, browser mounting verified separately.`);
