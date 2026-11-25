'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import { Client } from '@stomp/stompjs';
import { apiClient } from '@/services/api-client';
import { getWsUrl } from '@/services/stompClient';
import { authEpoch,authEnding } from '@/lib/auth-lifecycle';
import type { CompetitiveInput,CompetitiveState } from '@/types/quizRushCompetitive';

/** What the server would apply from a lease (the sequence number aside): two equal keys need no new message. */
const inputKey=(i:CompetitiveInput)=>`${i.horizontal}:${i.forward??0}:${i.sprint}:${i.jump??0}:${i.dodge??0}:${i.target??''}`;
const closed=(status:string)=>status==='FINISHED'||status==='CANCELED';
/** The room in the address is only a way back to a race in progress: dropped once that race is over or unknown. */
const dropRoom=()=>{const url=new URL(location.href);if(!url.searchParams.has('rushRoom'))return;url.searchParams.delete('rushRoom');history.replaceState(history.state,'',url);};

/**
 * Commands and their lifecycle. Every command is SENT with a request id and ends ACKNOWLEDGED, REJECTED (an ERROR with
 * its id) or EXPIRED — never "pending forever". A command that may be resent is resent with the SAME id (the server's
 * receipt makes a repeat return the first outcome: never a second answer, dash or charge). Lobby commands hold the
 * lobby buttons while in flight; race commands never block one another or movement.
 * - LOBBY: retried at 1.5 / 3.5 / 6 s, expired at 8 s with a visible error; "Thử lại" resends the same request.
 * - answer: retried the same way; the game keeps it alive (`ensure`) while the server still shows the racer at that door,
 *   so a lost message or a lost acknowledgement never leaves the racer standing at the wall.
 * - dash / rush / skill: one attempt (a late repeat would fire at a moment the player did not choose); expired quietly
 *   (dash, rush: the prediction drops it after 0.7 s) or with an error (a skill: press again).
 * Commands other than create / bots / quick / join leave only from a connection bound to the room (an unbound one is
 * refused as SESSION_REPLACED, which ends the connection); they wait for the rejoin.
 */
const LOBBY=new Set(['create','bots','quick','join','ready','start','kick','rematch','leave']);
const CREATING=new Set(['create','bots','quick','join']);
const RETRY_AT=[1500,3500,6000],EXPIRE_MS=8000;
const ONE_SHOT_MS:Record<string,number>={dash:1500,rush:1500,skill:4000};
/** Lease errors are about one input among many (the next lease carries the same keys and counters): never shown. */
const QUIET_INPUT=new Set(['RATE_LIMITED','INPUT_REPLAY_CHANGED','INPUT_SEQUENCE','MATCH_CHANGED','RACER_CLOSED','INVALID_INPUT','ROOM_UNAVAILABLE']);
/** An answer resent after the server moved on is answered with these: the first attempt already counted. */
const SETTLED_ANSWER=new Set(['ANSWER_UNAVAILABLE','CHECKPOINT_CHANGED','GATE_CHOICE_MISMATCH','MATCH_CHANGED']);
const CONNECTION_ERRORS=new Set(['CONNECTION_LOST','CONNECTION_TIMEOUT']);
/**
 * Movement leases: a change goes out at most every 40 ms (a jump / dodge at once), a held input is renewed every 100 ms,
 * at most 30 in any second — inside the server's 40 a second, with room for pings and commands on the same socket.
 */
const INPUT_GAP=40,INPUT_RENEW=90,INPUT_BUDGET=30;
interface Command{action:string;payload:Record<string,unknown>;id:string;at:number;attempts:number;timers:ReturnType<typeof setTimeout>[]}

/** Account-remounted owner: private socket, API-refreshed credential, bounded retries and input lease. */
export function useRushCompetition(hero:'LYRA'|'KAI'='LYRA',look=''){
  // The chosen hero travels with every command that places this account in a room (create, Bots, Quick Match, join,
  // rejoin); the server keeps an allow-listed value per racer and shows it to everyone in the room.
  const heroRef=useRef(hero);heroRef.current=hero;const lookRef=useRef(look);lookRef.current=look;
  const [state,setState]=useState<CompetitiveState|null>(null),[connected,setConnected]=useState(false),[error,setErrorState]=useState(''),[pending,setPending]=useState(false),[rtt,setRtt]=useState<number|null>(null);
  const snapshot=useRef<CompetitiveState|null>(null),client=useRef<Client|null>(null),epoch=useRef(-1),sequence=useRef(0),ready=useRef(false),disposed=useRef(false);
  const room=useRef<string|null>(null),boundRoom=useRef(''),inflight=useRef(new Map<string,Command>()),expired=useRef<Command|null>(null);
  const inputs=useRef<CompetitiveInput>({horizontal:0,target:null,sprint:false}),inputEnabled=useRef(false),lastPing=useRef(0),pingId=useRef(''),retryRef=useRef<(()=>void)|null>(null);
  const retired=useRef(new Set<string>()),rttRef=useRef<number|null>(null),rttSamples=useRef<number[]>([]);
  const errorTimer=useRef<ReturnType<typeof setTimeout>|null>(null),errorRef=useRef('');
  // The input lease: a change of keys goes out at once (within the send budget), otherwise the held input is renewed every
  // 100 ms. Each sent seq keeps its send time: the scene measures how far ahead of the server it must simulate from it.
  const lastSent=useRef({at:0,key:''}),flush=useRef<ReturnType<typeof setTimeout>|null>(null),publishInput=useRef<()=>void>(()=>{});
  const sentTimes=useRef(new Map<number,number>()),budget=useRef<number[]>([]);
  /**
   * Errors belong to what raised them: a connection error lasts until the connection is back, a command error until the
   * next command (in a running race it fades after 6 s). A state broadcast is not an acknowledgement and clears neither.
   */
  const setError=useCallback((code:string)=>{
    errorRef.current=code;setErrorState(code);if(errorTimer.current){clearTimeout(errorTimer.current);errorTimer.current=null;}
    if(code&&!CONNECTION_ERRORS.has(code))errorTimer.current=setTimeout(()=>{const s=snapshot.current;if(errorRef.current===code&&s&&['COUNTDOWN','RUNNING','FINISHING'].includes(s.status)){errorRef.current='';setErrorState('');}},6000);
  },[]);
  const refreshPending=useCallback(()=>{setPending([...inflight.current.values()].some(c=>LOBBY.has(c.action)));},[]);
  /** Ends a command (acknowledged, rejected or expired): its timers stop and its slot is free. */
  const settle=useCallback((id:string)=>{const c=inflight.current.get(id);if(!c)return null;for(const t of c.timers)clearTimeout(t);inflight.current.delete(id);refreshPending();return c;},[refreshPending]);
  const accept=useCallback((value:CompetitiveState)=>{
    const previous=snapshot.current;if(retired.current.has(value.matchId))return;
    // A race that is already over is shown only by the screen that was following it. Reconnecting with an old room in the
    // address (a refresh after the results, "Về sảnh" and a new mode, a late broadcast) used to put that old result over
    // the new Quick Match / Private Room request.
    if(closed(value.status)&&previous?.matchId!==value.matchId){retired.current.add(value.matchId);if(room.current===value.roomId){room.current=null;dropRoom();}return;}if(previous?.roomId===value.roomId&&previous.matchId===value.matchId&&(previous.revision>value.revision||previous.serverNow>value.serverNow))return;
    if(previous&&previous.matchId!==value.matchId){retired.current.add(previous.matchId);while(retired.current.size>16)retired.current.delete(retired.current.values().next().value!);}
    if(previous?.matchId!==value.matchId){sequence.current=value.personal.lastSeq+1;inputs.current={horizontal:0,target:null,sprint:false,jump:0,dodge:0,forward:0};sentTimes.current.clear();}
    else sequence.current=Math.max(sequence.current,value.personal.lastSeq+1);
    snapshot.current=value;room.current=value.roomId;setState(value);
    // A lobby command whose acknowledgement never arrived but whose effect the room now shows (the server applied it):
    // the "no acknowledgement" notice is stale, so it goes. Every other expired command keeps its notice and "Thử lại".
    const ex=expired.current;
    if(ex&&errorRef.current==='REQUEST_TIMEOUT'){const me=value.players.find(p=>p.id===value.you);
      const done=ex.action==='ready'?me?.ready===ex.payload.ready:ex.action==='start'||ex.action==='rematch'?value.matchId!==ex.payload.matchId||value.status!=='WAITING'&&value.status!=='FINISHED':ex.action==='kick'?!value.players.some(p=>p.id===ex.payload.targetId):CREATING.has(ex.action);
      if(done){expired.current=null;errorRef.current='';setErrorState('');}}
    // The address changes only when the room does: a history update on every 10 Hz snapshot made the App Router re-sync
    // (and browsers throttle frequent history updates).
    const url=new URL(location.href);if(url.searchParams.get('rushRoom')!==value.roomId||url.searchParams.has('rushInvite')){url.searchParams.set('rushRoom',value.roomId);url.searchParams.delete('rushInvite');history.replaceState(history.state,'',url);}
  },[]);
  /** Sends (or resends, same id) one command if this connection may: false when it has to wait. */
  const transmit=useCallback((c:Command)=>{
    const socket=client.current;if(!ready.current||!socket?.connected||authEnding()||epoch.current!==authEpoch())return false;
    if(!CREATING.has(c.action)&&boundRoom.current!==room.current)return false;
    c.attempts++;c.at=performance.now();socket.publish({destination:`/app/quiz-rush/${c.action}`,body:JSON.stringify({...c.payload,requestId:c.id})});return true;
  },[]);
  /** Starts the lifecycle of a command that was just sent for the first time. */
  const schedule=useCallback((c:Command)=>{
    const oneShot=ONE_SHOT_MS[c.action];
    if(oneShot){c.timers.push(setTimeout(()=>{if(disposed.current||!settle(c.id))return;if(c.action==='skill')setError('REQUEST_TIMEOUT');},oneShot));return;}
    for(const at of RETRY_AT)c.timers.push(setTimeout(()=>{if(!disposed.current&&inflight.current.get(c.id)===c)transmit(c);},at));
    c.timers.push(setTimeout(()=>{if(disposed.current||!settle(c.id))return;if(LOBBY.has(c.action)){expired.current=c;setError('REQUEST_TIMEOUT');}},EXPIRE_MS));
  },[settle,setError,transmit]);
  useEffect(()=>{
    disposed.current=false;epoch.current=authEpoch();let gone=false,sync='',synced=false,recoveryRequest='',everSynced=false,rebinding='';let syncTimer:ReturnType<typeof setTimeout>|null=null;
    const commands=inflight.current;
    const abort=new AbortController();room.current=new URLSearchParams(location.search).get('rushRoom');boundRoom.current='';
    const valid=()=>!gone&&!authEnding()&&epoch.current===authEpoch();
    const socket=new Client({brokerURL:getWsUrl(),reconnectDelay:2000,connectionTimeout:10000,heartbeatIncoming:10000,heartbeatOutgoing:10000,
      beforeConnect:async()=>{
        ready.current=false;setConnected(false);
        try{const response=await apiClient.get('/games/echo-quiz-rush/config',{timeout:8000,signal:abort.signal});if(!valid()){void socket.deactivate();return;}
          void response;socket.connectHeaders={};/* the read renewed the session cookie; the handshake carries it */
        }catch(e){
          // Only a refused session stops the connection. A network error or a restarting server (deploys answer 502 for a
          // minute) is not a sign-in problem: the client keeps reconnecting and the lobby says "Đang kết nối".
          const status=(e as {response?:{status?:number}})?.response?.status;
          if(valid()&&(status===401||status===403)){setError('AUTH_REQUIRED');void socket.deactivate();}
        }
      },
      onConnect:()=>{
        if(!valid()){void socket.deactivate();return;}synced=false;sync=crypto.randomUUID();boundRoom.current='';rebinding='';
        // A new connection starts a new round-trip estimate (the old path's samples no longer describe it).
        rttSamples.current=[];
        socket.subscribe('/user/queue/quiz-rush',message=>{
          if(!valid())return;let event:{type:string;requestId?:string|null;code?:string;state?:CompetitiveState&{left?:boolean}};
          try{event=JSON.parse(message.body);}catch{return;}
          const own=event.requestId?commands.get(event.requestId):undefined;
          if(event.type==='SYNC'&&event.requestId===sync){synced=true;everSynced=true;if(syncTimer)clearTimeout(syncTimer);ready.current=true;setConnected(true);if(errorRef.current!=='REQUEST_TIMEOUT')setError('');
            if(room.current){recoveryRequest=crypto.randomUUID();socket.publish({destination:'/app/quiz-rush/rejoin',body:JSON.stringify({roomId:room.current,requestId:recoveryRequest,hero:heroRef.current})});}
            else{const invitation=new URLSearchParams(location.search).get('rushInvite');if(invitation)socket.publish({destination:'/app/quiz-rush/join',body:JSON.stringify({invitation,requestId:crypto.randomUUID(),hero:heroRef.current})});}return;}
          if(event.type==='ERROR'){
            if(event.code==='ROOM_NOT_FOUND'&&event.requestId===recoveryRequest){const shown=!!snapshot.current;if(snapshot.current)retired.current.add(snapshot.current.matchId);snapshot.current=null;room.current=null;setState(null);inputEnabled.current=false;dropRoom();
              // An expired room in the address on page load is simply gone: the lobby opens without an error.
              if(!shown)return;}
            if(event.code==='SESSION_REPLACED'){setError('SESSION_REPLACED');ready.current=false;setConnected(false);void socket.deactivate();return;}
            // A lease error: the next lease carries the same keys and action counters. A sequence the server cannot follow
            // (more than 100 ahead of the last one it applied) restarts from the server's own count instead of failing forever.
            if(!event.requestId){if(event.code==='INPUT_SEQUENCE'&&snapshot.current)sequence.current=snapshot.current.personal.lastSeq+1;if(!QUIET_INPUT.has(event.code??''))setError(event.code??'ROOM_UNAVAILABLE');return;}
            if(event.requestId===pingId.current){pingId.current='';return;}
            if(own){settle(own.id);
              // A new race was asked for while this account still belongs to an open one (a page closed in a lobby or a race):
              // go back to that room — the server knows it — so it can be resumed or left, instead of a dead end.
              if(event.code==='ALREADY_IN_ROOM'&&['create','bots','quick','join'].includes(own.action)){recoveryRequest=crypto.randomUUID();socket.publish({destination:'/app/quiz-rush/rejoin',body:JSON.stringify({roomId:null,requestId:recoveryRequest,hero:heroRef.current})});}
              // Leaving a room that is already gone is a completed leave.
              if(own.action==='leave'&&event.code==='ROOM_NOT_FOUND'){if(snapshot.current)retired.current.add(snapshot.current.matchId);snapshot.current=null;room.current=null;setState(null);inputEnabled.current=false;dropRoom();return;}
              if(own.action==='answer'&&SETTLED_ANSWER.has(event.code??''))return;}
            setError(event.code??'ROOM_UNAVAILABLE');return;}
          if(event.type==='REMOVED'||event.state?.left){if(snapshot.current)retired.current.add(snapshot.current.matchId);snapshot.current=null;room.current=null;boundRoom.current='';setState(null);inputEnabled.current=false;const url=new URL(location.href);url.searchParams.delete('rushRoom');history.replaceState(history.state,'',url);
            if(event.type==='REMOVED'){for(const c of [...commands.values()])settle(c.id);setError('HOST_REMOVED');}}
          else if(event.state?.roomId){if(event.type==='ACK'&&own&&CREATING.has(own.action))retired.current.delete(event.state.matchId);
            // An acknowledged command binds this connection to its room. A live room's state that arrives without one (its
            // former connection is gone, so the server's message reached every connection of the account) is joined first:
            // a ping or input from an unbound connection is refused as SESSION_REPLACED, which used to end the connection.
            if(event.type==='ACK')boundRoom.current=event.state.roomId;
            else if(boundRoom.current!==event.state.roomId&&!closed(event.state.status)&&rebinding!==event.state.roomId&&![...commands.values()].some(c=>CREATING.has(c.action))&&!retired.current.has(event.state.matchId)){rebinding=event.state.roomId;recoveryRequest=crypto.randomUUID();socket.publish({destination:'/app/quiz-rush/rejoin',body:JSON.stringify({roomId:event.state.roomId,requestId:recoveryRequest,hero:heroRef.current})});}
            accept(event.state);if(CONNECTION_ERRORS.has(errorRef.current))setError('');}
          if(event.requestId&&event.requestId===pingId.current){const value=performance.now()-lastPing.current;rttSamples.current.push(value);if(rttSamples.current.length>7)rttSamples.current.shift();
            // A robust round trip: the smallest sample until three exist (the first reply, sent while the page still loads,
            // can be a second late), then the median of the last seven. The scene measures its real lead from inputs anyway.
            const sorted=[...rttSamples.current].sort((a,b)=>a-b);rttRef.current=sorted.length<3?sorted[0]:sorted[Math.floor(sorted.length/2)];setRtt(value);pingId.current='';}
          if(own&&(event.type==='ACK'||event.state))settle(own.id);
        });
        let attempts=0;const handshake=()=>{if(!valid()||synced)return;socket.publish({destination:'/app/quiz-rush/sync',body:JSON.stringify({requestId:sync})});if(++attempts<8)syncTimer=setTimeout(handshake,500);else{setError('CONNECTION_TIMEOUT');void socket.deactivate();}};handshake();
      },
      // "Connection lost" only after a connection existed: the first attempts of a page load are "connecting", not an error.
      onWebSocketClose:()=>{if(valid()){ready.current=false;boundRoom.current='';setConnected(false);if(everSynced)setError('CONNECTION_LOST');inputs.current={horizontal:0,target:null,sprint:false,forward:0};}},
      onStompError:()=>{if(valid()){ready.current=false;boundRoom.current='';setConnected(false);if(everSynced)setError('CONNECTION_LOST');}},
    });client.current=socket;socket.activate();
    retryRef.current=()=>{if(valid())void socket.deactivate().then(()=>{if(valid())socket.activate();});};
    const leaseOpen=()=>{const current=snapshot.current;return !!current&&ready.current&&socket.connected&&boundRoom.current===current.roomId&&inputEnabled.current&&!document.hidden&&!['FINISHED','CANCELED','WAITING','QUEUED'].includes(current.status)&&!['FINISHED','DNF'].includes(current.players.find(p=>p.id===current.you)?.phase??'');};
    /** Inputs sent within the last second (the client's own budget, well inside the server's 40 a second). */
    const spent=(now:number)=>{const b=budget.current;while(b.length&&now-b[0]>=1000)b.shift();return b.length;};
    publishInput.current=()=>{const current=snapshot.current;if(!current||!leaseOpen())return;
      const now=performance.now();
      // Over budget: the newest keys (and the cumulative jump / dodge counters) go out as soon as the window allows.
      if(spent(now)>=INPUT_BUDGET){if(!flush.current)flush.current=setTimeout(()=>{flush.current=null;publishInput.current();},Math.max(5,1000-(now-budget.current[0])));return;}
      const seq=sequence.current++;socket.publish({destination:'/app/quiz-rush/input',body:JSON.stringify({roomId:current.roomId,matchId:current.matchId,input:{seq,...inputs.current}})});
      budget.current.push(now);sentTimes.current.set(seq,now);if(sentTimes.current.size>128)sentTimes.current.delete(sentTimes.current.keys().next().value!);
      lastSent.current={at:now,key:inputKey(inputs.current)};};
    const tick=setInterval(()=>{
      if(!valid()){void socket.deactivate();return;}if(!ready.current||!socket.connected||!snapshot.current)return;
      const current=snapshot.current;
      if(performance.now()-lastSent.current.at>=INPUT_RENEW&&!flush.current)publishInput.current();
      if(performance.now()-lastPing.current>1000&&!['FINISHED','CANCELED'].includes(current.status)&&boundRoom.current===current.roomId){lastPing.current=performance.now();pingId.current=crypto.randomUUID();socket.publish({destination:'/app/quiz-rush/ping',body:JSON.stringify({roomId:current.roomId,requestId:pingId.current})});}
    },100);
    const clear=()=>{inputs.current={horizontal:0,target:null,sprint:false,forward:0};};window.addEventListener('blur',clear);document.addEventListener('visibilitychange',clear);
    return()=>{gone=true;disposed.current=true;if(snapshot.current&&closed(snapshot.current.status))dropRoom();abort.abort();clearInterval(tick);if(flush.current)clearTimeout(flush.current);flush.current=null;publishInput.current=()=>{};if(syncTimer)clearTimeout(syncTimer);if(errorTimer.current)clearTimeout(errorTimer.current);
      for(const c of commands.values())for(const t of c.timers)clearTimeout(t);commands.clear();expired.current=null;
      ready.current=false;boundRoom.current='';void socket.deactivate();client.current=null;snapshot.current=null;room.current=null;retryRef.current=null;window.removeEventListener('blur',clear);document.removeEventListener('visibilitychange',clear);};
  },[accept,settle,setError]);
  /**
   * Sends a new command. Lobby commands take turns (one at a time, except leave, which always goes); race commands never
   * wait for one another — a newer one of the same kind replaces an unanswered older one (an answer at the next door, a
   * new press). `id` keeps a command's identity across calls (`ensure`).
   */
  const send=useCallback((action:string,payload:Record<string,unknown>={},id?:string)=>{
    if(id&&inflight.current.has(id))return true;
    const commands=[...inflight.current.values()];
    if(LOBBY.has(action)&&action!=='leave'&&commands.some(c=>LOBBY.has(c.action)))return false;
    const current=snapshot.current;
    const command:Command={action,payload:{roomId:room.current,matchId:current?.matchId,...(CREATING.has(action)?{hero:heroRef.current,look:lookRef.current}:{}),...payload},id:id??crypto.randomUUID(),at:0,attempts:0,timers:[]};
    if(!transmit(command))return false;
    if(!LOBBY.has(action))for(const c of commands)if(c.action===action)settle(c.id);
    inflight.current.set(command.id,command);expired.current=null;if(LOBBY.has(action))setPending(true);
    if((LOBBY.has(action)||action==='skill')&&errorRef.current&&!CONNECTION_ERRORS.has(errorRef.current))setError('');
    schedule(command);return true;
  },[transmit,schedule,settle,setError]);
  /**
   * Keeps one logical command alive under a stable id: sent if it is not in flight (a first send, or again after it
   * expired while the server still shows the situation that needs it). The id makes every repeat the same request.
   */
  const ensure=useCallback((action:string,payload:Record<string,unknown>,id:string)=>send(action,payload,id),[send]);
  const updateInput=useCallback((value:CompetitiveInput,urgent=false)=>{
    inputs.current=value;const key=inputKey(value);if(key===lastSent.current.key)return;
    // A jump / dodge request goes out at once (take-off timing matters); any other change at most every 40 ms.
    const wait=INPUT_GAP-(performance.now()-lastSent.current.at);
    if(urgent||wait<=0){if(flush.current){clearTimeout(flush.current);flush.current=null;}publishInput.current();}
    else if(!flush.current)flush.current=setTimeout(()=>{flush.current=null;if(inputKey(inputs.current)!==lastSent.current.key)publishInput.current();},wait);
  },[]);
  /** "Thử lại": the expired (or still unanswered) lobby request again with its own id; otherwise a fresh connection. */
  const retry=useCallback(()=>{
    const waiting=expired.current??[...inflight.current.values()].find(c=>LOBBY.has(c.action))??null;
    if(waiting&&ready.current){const again:Command={...waiting,timers:[],attempts:0};for(const t of waiting.timers)clearTimeout(t);inflight.current.delete(waiting.id);
      if(transmit(again)){inflight.current.set(again.id,again);expired.current=null;refreshPending();setError('');schedule(again);return;}}
    retryRef.current?.();
  },[transmit,schedule,refreshPending,setError]);
  /** When this tab sent input `seq` (performance.now ms), for the scene's lead measurement. */
  const sentAt=useCallback((seq:number)=>sentTimes.current.get(seq),[]);
  return{state,snapshot,connected,error,pending,rtt,rttRef,send,ensure,retry,updateInput,inputEnabled,sentAt};
}
