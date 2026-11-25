// Opt-in local integration: two SYNTHETIC authenticated clients, real Spring STOMP/game/OmniVoice/PG.
// This is protocol evidence, not human multiplayer acceptance.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {Client} from '@stomp/stompjs';
const require=createRequire(import.meta.url),WebSocket=require('next/dist/compiled/ws');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const reports=[],clients=[];
async function api(user,path,body){const r=await fetch(`http://127.0.0.1:8998${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer spelling-fixture-user${user}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert(r.ok,`${path}: ${r.status}`);return r;}
async function user(id){
 const u={id,state:null,events:[],handle:null};
 const client=new Client({webSocketFactory:()=>new WebSocket('ws://127.0.0.1:8998/ws-card-blast',{headers:{Origin:`http://localhost:331${id}`,Cookie:`ec_at=spelling-fixture-user${id}`}}),heartbeatIncoming:10000,heartbeatOutgoing:10000,reconnectDelay:0,debug:()=>{}});u.client=client;
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CONNECT timeout')),8000);client.onStompError=e=>reject(Error(e.headers.message));client.onConnect=()=>{clearTimeout(timer);client.subscribe('/user/queue/spelling',m=>{const e=JSON.parse(m.body);u.events.push(e);if(e.state)u.state=e.state;});resolve();};client.activate();});
 clients.push(u);return u;
}
async function until(test,label,ms=12000){const end=Date.now()+ms;while(Date.now()<end){if(test())return;await sleep(20);}throw Error(`Timeout: ${label}`);}
function send(u,action,payload={}){const requestId=crypto.randomUUID();u.client.publish({destination:`/app/spelling/${action}`,body:JSON.stringify({requestId,roomId:u.state?.roomId,sentinel:u.handle,...payload})});return requestId;}
async function command(u,action,payload={}){const id=send(u,action,payload);await until(()=>u.events.some(e=>e.requestId===id),action);const e=u.events.find(e=>e.requestId===id);assert.notEqual(e.type,'ERROR',`${action}: ${e.code}`);return e;}
async function acknowledge(u){const a=await(await api(u.id,'/api/v1/sentinel/attempts',{activity:'ECHO_SPELLING',acknowledged:true,policyVersion:1})).json();u.handle=`${a.id}.${a.token}`;u.attempt=a;
 u.heart=setInterval(()=>{void api(u.id,`/api/v1/sentinel/attempts/${a.id}/heartbeat`,{token:a.token,visible:true});send(u,'ping');},5000);}
async function hear(u){await until(()=>u.state?.phase==='HEAR'&&u.state.turn.player===String(u.id),'active audio',15000);const turn=u.state.turn;
 const r=await api(u.id,turn.audioUrl);const bytes=new Uint8Array(await r.arrayBuffer());assert.equal(new TextDecoder().decode(bytes.slice(0,4)),'RIFF');assert(!turn.audioUrl.includes('ocean'));await sleep(turn.audioDurationMs+180);await command(u,'heard',{turnId:turn.id});return turn;}
try{
 const a=await user(1),b=await user(2);
 // Existing UI fixture run may still belong to learner 1; explicitly leave through the ordinary endpoint.
 await command(a,'sync');if(a.state){await command(a,'rejoin');await command(a,'leave');a.state=null;}
 await command(a,'create',{mode:'MULTIPLAYER',difficulty:'EASY',hero:'LYRA',capacity:2});await command(b,'join',{code:a.state.code,hero:'KAI'});
 assert.equal(a.state.roomId,b.state.roomId);assert.equal(b.state.self,'2');assert.equal(b.state.players.length,2);
 await acknowledge(a);await acknowledge(b);await command(a,'ready',{value:true});await command(b,'ready',{value:true});await command(a,'start');
 const first=await hear(a);await sleep(600);const start=performance.now();send(a,'draft',{turnId:first.id,text:'oc',sequence:1});await until(()=>b.state?.turn?.typed==='oc','spectator typing');const draftMs=performance.now()-start;
 assert.equal(b.state.result,null);assert.equal(b.state.turn.player,'1');assert(!JSON.stringify(b.state).includes('"answer":"ocean"'));
 const judged=performance.now();send(a,'draft',{turnId:first.id,text:'ocean',sequence:2});await until(()=>a.state?.phase==='RESULT','automatic verdict');const verdictMs=performance.now()-judged;
 assert.equal(a.state.result.correct,true);assert.equal(a.state.players.find(x=>x.id==='1').correct,1);
 await command(a,'answer',{turnId:first.id,text:'ocean',sequence:3});assert.equal(a.state.players.find(x=>x.id==='1').correct,1);
 const second=await hear(b);await sleep(600);await command(b,'answer',{turnId:second.id,text:'incorrect',sequence:1});await until(()=>b.state?.phase==='FINISHED'&&b.state.saved,'saved winner');assert.equal(b.state.winner,'1');
 const before=a.state.roomId;await command(a,'rematch');await until(()=>b.state?.roomId===a.state.roomId&&b.state.roomId!==before,'shared replay');assert.equal(b.state.phase,'LOBBY');assert(b.state.players.every(x=>!x.ready));
 const ra=await(await api(1,'/api/v1/spelling/records')).json(),rb=await(await api(2,'/api/v1/spelling/records')).json();assert(ra.recent.some(x=>x.mode==='MULTIPLAYER'&&x.won));assert(rb.recent.some(x=>x.mode==='MULTIPLAYER'&&!x.won));
 reports.push({test:'two synthetic authenticated clients on real broker',passed:true,draftSpectatorMs:Math.round(draftMs),automaticVerdictMs:Math.round(verdictMs),independentPlayers:true,preparedOmniVoice:true,duplicateScoring:false,nextTurn:true,legitimateWinner:true,durableResults:true,sharedReplay:true});
 await command(a,'leave');await command(b,'leave');
 writeFileSync('../docs/echo-spelling/2026-11-18/broker-evidence.json',JSON.stringify({environment:'local synthetic principals; actual production-source services, PostgreSQL and audio',reports},null,2)+'\n');console.log(JSON.stringify(reports));
}finally{for(const u of clients){clearInterval(u.heart);await u.client.deactivate();}}
