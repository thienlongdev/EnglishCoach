'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import { Client } from '@stomp/stompjs';
import { useSession } from 'next-auth/react';
import { getWsUrl } from '@/services/stompClient';
import { apiClient } from '@/services/api-client';
import { authEpoch,authEnding } from '@/lib/auth-lifecycle';
import type { KingState } from './realtimeTypes';

type Event={type:'STATE'|'ACK'|'ERROR'|'SYNC';state?:KingState;code?:string;messageId?:string};
/** A word on its way to the server. It stays here until the server answered that message id, across any number of reconnects. */
export type KingMove={id:string;match:string;word:string;path:number[];sentAt:number;tries:number};
const MOVE_ANSWER_MS=4000,MOVE_TRIES=4,MOVE_QUEUE=8;
export function useKingRealtime(){
  const {data:session}=useSession();
  const scope=(session?.user as {id?:string}|undefined)?.id||session?.user?.email;
  const [state,setState]=useState<KingState|null>(null),[connected,setConnected]=useState(false),
    [pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[offset,setOffset]=useState(0),
    [moves,setMoves]=useState<KingMove[]>([]),[refused,setRefused]=useState<{word:string;code:string}|null>(null);
  const client=useRef<Client|null>(null),current=useRef<KingState|null>(null),room=useRef<string|null>(null),
    pendingId=useRef<string|null>(null),pendingAction=useRef<string|null>(null),sent=useRef(false),
    timeout=useRef<ReturnType<typeof setTimeout>|null>(null),generation=useRef(0),ownedEpoch=useRef(-1),inviteJoinTried=useRef(false),resetConnection=useRef<(()=>void)|null>(null),connectionReady=useRef(false),
    outbox=useRef<KingMove[]>([]),moveWatch=useRef<ReturnType<typeof setTimeout>|null>(null),wakeConnection=useRef<(()=>void)|null>(null),
    // Echo Sentinel handle of the ranked attempt ("id.secret"): page memory only, sent on launch / rejoin / rematch.
    sentinel=useRef<string|null>(null);
  const showMoves=useCallback(()=>setMoves([...outbox.current]),[]);
  const stopMoveWatch=useCallback(()=>{if(moveWatch.current)clearTimeout(moveWatch.current);moveWatch.current=null;},[]);
  /** No answer in time on a socket that looks open means the socket is not really there: replace it now, not after the heartbeat notices. */
  const watchMoves=useCallback(()=>{
    if(moveWatch.current||!outbox.current.length)return;
    moveWatch.current=setTimeout(()=>{
      moveWatch.current=null;
      const now=Date.now();
      const lost=outbox.current.filter(m=>m.tries>=MOVE_TRIES&&now-m.sentAt>=MOVE_ANSWER_MS);
      if(lost.length){outbox.current=outbox.current.filter(m=>!lost.includes(m));showMoves();setError('REQUEST_TIMEOUT');}
      if(outbox.current.some(m=>now-m.sentAt>=MOVE_ANSWER_MS)&&client.current?.connected){connectionReady.current=false;setConnected(false);setError('CONNECTION_LOST');client.current.forceDisconnect?.();}
      watchMoves();
    },MOVE_ANSWER_MS);
  },[showMoves]);
  const publishMove=useCallback((m:KingMove)=>{
    if(!connectionReady.current||!client.current?.connected)return;
    m.sentAt=Date.now();m.tries++;
    client.current.publish({destination:'/app/king-of-english/move',body:JSON.stringify({roomCode:room.current,matchId:m.match,round:current.current?.round,revision:current.current?.inputRevision,answer:m.word,order:m.path,messageId:m.id})});
  },[]);
  const accept=useCallback((s:KingState)=>{
    if(current.current?.roomCode===s.roomCode&&current.current.revision>s.revision)return;
    current.current=s;room.current=s.roomCode;setState(s);
    // serverTimestamp is always a little old on arrival: the largest recent sample is the truest, and the clock does not jitter with the network.
    const sample=s.serverTimestamp-Date.now();setOffset(o=>o===0||sample>o||o-sample>1500?sample:o);
    if(outbox.current.length&&(s.status!=='PLAYING'||outbox.current.some(m=>m.match!==s.matchId))){outbox.current=s.status==='PLAYING'?outbox.current.filter(m=>m.match===s.matchId):[];setMoves([...outbox.current]);}
    const url=new URL(window.location.href);url.searchParams.set('room',s.roomCode);window.history.replaceState(window.history.state,'',url);
  },[]);
  useEffect(()=>{
    if(!scope||authEnding())return;
    const epoch=authEpoch(),gen=++generation.current;let disposed=false;
    let connectionTimer:ReturnType<typeof setTimeout>|null=null,syncTimer:ReturnType<typeof setTimeout>|null=null,retryTimer:ReturnType<typeof setTimeout>|null=null,retries=0,syncId='',synchronized=false;
    const stopTimers=()=>{if(connectionTimer)clearTimeout(connectionTimer);if(syncTimer)clearTimeout(syncTimer);if(retryTimer)clearTimeout(retryTimer);connectionTimer=null;syncTimer=null;retryTimer=null;};
    resetConnection.current=()=>{stopTimers();retries=0;connectionReady.current=false;setConnected(false);if(!current.current&&!room.current)sent.current=false;};
    /** The match is on the server and its clock keeps running: while this arena is open the connection keeps trying, slower and slower, never giving up. */
    const reopen=()=>{if(disposed||epoch!==authEpoch()||authEnding())return;void socket.deactivate().then(()=>{if(!disposed&&client.current===socket&&epoch===authEpoch()&&!authEnding()){boundConnection();socket.activate();}});};
    const retryLater=()=>{if(disposed||retryTimer)return;const delay=Math.min(15000,1000*2**Math.min(retries++,4));retryTimer=setTimeout(()=>{retryTimer=null;reopen();},delay);};
    wakeConnection.current=()=>{if(disposed||socket.connected)return;retries=0;if(retryTimer){clearTimeout(retryTimer);retryTimer=null;}if(connectionTimer){clearTimeout(connectionTimer);connectionTimer=null;}reopen();};
    const boundConnection=()=>{if(connectionTimer)return;connectionTimer=setTimeout(()=>{connectionTimer=null;if(!disposed){connectionReady.current=false;setConnected(false);setError('CONNECTION_TIMEOUT');void socket.deactivate();retryLater();}},20000);};
    ownedEpoch.current=epoch;connectionReady.current=false;setConnected(false);setPending(false);setError(null);pendingId.current=null;
    current.current=null;setState(null);room.current=new URLSearchParams(window.location.search).get('room');sent.current=false;inviteJoinTried.current=false;
    const socket=new Client({
      brokerURL:getWsUrl(),reconnectDelay:2000,connectionTimeout:10000,heartbeatIncoming:10000,heartbeatOutgoing:10000,
      beforeConnect:async()=>{
        boundConnection();
        if(disposed||epoch!==authEpoch()||authEnding()){void socket.deactivate();return;}
        try{
          // The API client renews the session cookie when it has lapsed.
          const response=await apiClient.get('/king-of-english/config',{timeout:8000});
          if(disposed||epoch!==authEpoch()||authEnding()){void socket.deactivate();return;}
          // The successful read proves the session cookie is fresh; the handshake carries it, no token in the frame.
          void response;socket.connectHeaders={};
        }catch(failure){
          const status=(failure as {status?:number;response?:{status?:number}}|null)?.response?.status??(failure as {status?:number}|null)?.status;
          const signedOut=status===401||status===403;
          if(!disposed&&epoch===authEpoch()&&!authEnding())setError(signedOut?'AUTH_REQUIRED':'SERVER_UNAVAILABLE');
          void socket.deactivate();
          // A server that is restarting answers again in a minute; a session that has ended does not.
          if(!signedOut)retryLater();
        }
      },
      onConnect:()=>{
        if(disposed||gen!==generation.current||epoch!==authEpoch()||authEnding()){void socket.deactivate();return;}
        synchronized=false;syncId=crypto.randomUUID();
        socket.subscribe('/user/queue/king-of-english',m=>{
          if(disposed||epoch!==authEpoch()||authEnding())return;
          let event:Event;try{event=JSON.parse(m.body);}catch{return;}
          const queued=event.messageId?outbox.current.find(q=>q.id===event.messageId):undefined;
          if(queued){
            outbox.current=outbox.current.filter(q=>q!==queued);setMoves([...outbox.current]);
            if(!outbox.current.length)stopMoveWatch();
            if(event.type==='ERROR'&&event.code==='STALE_SESSION'){
              // This socket lost the room to a newer one of the same account; take it back, the word goes again from there.
              outbox.current=[queued,...outbox.current];setMoves([...outbox.current]);connectionReady.current=false;
              socket.publish({destination:'/app/king-of-english/rejoin',body:JSON.stringify({roomCode:room.current||'',sentinel:sentinel.current??undefined})});
              return;
            }
            if(event.type==='ERROR'&&event.code&&event.code!=='ROOM_NOT_FOUND'&&event.code!=='NOT_A_MEMBER'){setRefused({word:queued.word,code:event.code});return;}
            if(event.type==='ACK'){setRefused(null);if(event.state)accept(event.state);return;}
            event.messageId=undefined;
          }
          if(event.type==='SYNC'&&event.messageId===syncId){
            if(synchronized)return;synchronized=true;stopTimers();retries=0;setError(null);
            if(room.current||sent.current){boundConnection();socket.publish({destination:'/app/king-of-english/rejoin',body:JSON.stringify({roomCode:room.current||'',sentinel:sentinel.current??undefined})});}
            else {connectionReady.current=true;setConnected(true);}
            return;
          }
          if(event.type==='ERROR'){
            // Leaving is a client navigation intent. A finished room may have
            // expired between rendering the result and pressing Lobby, so the
            // server can legitimately answer ROOM_NOT_FOUND (or another
            // membership error). Do not strand the result view in that case:
            // settle the leave locally and let KingArena return to the lobby.
            if(pendingAction.current==='leave'){
              if(timeout.current)clearTimeout(timeout.current);
              pendingId.current=null;pendingAction.current=null;setPending(false);setError(null);
              current.current=null;room.current=null;setState(null);sent.current=false;
              const url=new URL(window.location.href);url.searchParams.delete('room');window.history.replaceState(window.history.state,'',url);
              return;
            }
            // Expiry after a terminal result is expected during a late rejoin.
            // Suppress it before publishing an error to the UI, as well as
            // preserving the result. Explicit action errors still settle below.
            if(event.code==='ROOM_NOT_FOUND'&&current.current?.status==='FINISHED'&&!event.messageId){
              stopTimers();connectionReady.current=true;setConnected(true);setError(null);return;
            }
            stopTimers();setError(event.code||'SERVER_UNAVAILABLE');
            // A direct invite opens a fresh authenticated socket. The server quite
            // correctly rejects rejoin because the guest has no membership yet;
            // recover the invite by issuing one bounded join attempt. Never retry
            // indefinitely, and never replay a gameplay command.
            if(event.code==='NOT_A_MEMBER'&&room.current&&!inviteJoinTried.current&&!pendingId.current){
              inviteJoinTried.current=true;
              const joinId=crypto.randomUUID();pendingId.current=joinId;pendingAction.current='join';setPending(true);setError(null);
              socket.publish({destination:'/app/king-of-english/join',body:JSON.stringify({roomCode:room.current,messageId:joinId,sentinel:sentinel.current??undefined})});
              timeout.current=setTimeout(()=>{if(pendingId.current===joinId){pendingId.current=null;setPending(false);setError('REQUEST_TIMEOUT');}},10000);
            }else if(synchronized){connectionReady.current=true;setConnected(true);}
            if(event.code==='STALE_ROUND'&&socket.connected&&room.current)socket.publish({destination:'/app/king-of-english/ping',body:JSON.stringify({roomCode:room.current})});
            if(event.code==='ROOM_NOT_FOUND'&&current.current?.status!=='FINISHED'){
              // A finished result is a client-owned terminal view. The server
              // expires finished rooms after FINISH_TTL, and a late sync or
              // reconnect error must not erase that already-rendered result.
              room.current=null;current.current=null;setState(null);
              const url=new URL(window.location.href);url.searchParams.delete('room');window.history.replaceState(window.history.state,'',url);
            }
          }else if(event.state){
            const resumed=!connectionReady.current;
            stopTimers();retries=0;connectionReady.current=true;setConnected(true);setError(null);accept(event.state);
            // Words the old connection never answered go again with their own ids: a word the server did take ends at its receipt.
            if(resumed&&outbox.current.length){outbox.current.forEach(publishMove);setMoves([...outbox.current]);watchMoves();}
          }
          if(event.messageId&&event.messageId===pendingId.current){
            if(timeout.current)clearTimeout(timeout.current);
            if(event.type==='ACK'&&pendingAction.current==='leave'){
              room.current=null;current.current=null;setState(null);
              const url=new URL(window.location.href);url.searchParams.delete('room');window.history.replaceState(window.history.state,'',url);
            }
            pendingId.current=null;setPending(false);
          }
        });
        let attempts=0;
        const sync=()=>{if(disposed||synchronized)return;socket.publish({destination:'/app/king-of-english/sync',body:JSON.stringify({messageId:syncId})});if(++attempts<6&&!synchronized)syncTimer=setTimeout(sync,500);};
        sync();
      },
      onWebSocketClose:()=>{if(!disposed){connectionReady.current=false;setConnected(false);setError('CONNECTION_LOST');stopMoveWatch();if(pendingId.current){pendingId.current=null;setPending(false);if(timeout.current)clearTimeout(timeout.current);}boundConnection();}},
      onStompError:()=>{if(!disposed){connectionReady.current=false;setConnected(false);setError('AUTH_REQUIRED');}},
    });
    client.current=socket;boundConnection();socket.activate();
    const heartbeat=setInterval(()=>{
      if(epoch!==authEpoch()||authEnding()){void socket.deactivate();return;}
      // A ping on a finished room keeps it on the server while its result is on screen (replay / rematch stay
      // possible, up to the server's keep limit). A later ROOM_NOT_FOUND for that room is suppressed above.
      if(socket.connected&&room.current)socket.publish({destination:'/app/king-of-english/ping',body:JSON.stringify({roomCode:room.current})});
    },10000);
    // Back online, or back on this tab: try now rather than at the end of a backoff.
    const wake=()=>{if(typeof document==='undefined'||!document.hidden)wakeConnection.current?.();};
    window.addEventListener?.('online',wake);
    if(typeof document!=='undefined')document.addEventListener('visibilitychange',wake);
    return()=>{disposed=true;stopTimers();stopMoveWatch();generation.current++;clearInterval(heartbeat);if(timeout.current)clearTimeout(timeout.current);
      window.removeEventListener?.('online',wake);if(typeof document!=='undefined')document.removeEventListener('visibilitychange',wake);
      void socket.deactivate();client.current=null;current.current=null;room.current=null;pendingId.current=null;resetConnection.current=null;wakeConnection.current=null;outbox.current=[];};
  },[scope,accept,publishMove,stopMoveWatch,watchMoves]);
  const send=useCallback((action:string,payload:Record<string,unknown>={})=>{
    if(!connectionReady.current||!client.current?.connected||pendingId.current||authEnding()||ownedEpoch.current!==authEpoch())return false;
    const id=crypto.randomUUID();pendingId.current=id;pendingAction.current=action;sent.current=true;setPending(true);setError(null);
    client.current.publish({destination:`/app/king-of-english/${action}`,body:JSON.stringify({
      roomCode:room.current,matchId:current.current?.matchId,round:current.current?.round,
      revision:current.current?.inputRevision,sentinel:sentinel.current??undefined,...payload,messageId:id,
    })});
    timeout.current=setTimeout(()=>{pendingId.current=null;setPending(false);setError('REQUEST_TIMEOUT');
      if(client.current?.connected)client.current.publish({destination:'/app/king-of-english/rejoin',body:JSON.stringify({roomCode:room.current||'',sentinel:sentinel.current??undefined})});
    },10000);
    return true;
  },[]);
  /**
   * Soán ngôi: a word never waits for the one before it and never blocks the next. It leaves at once, even while the connection
   * is coming back (it then goes as soon as the room is rejoined), and only the server's answer scores it. False: too many waiting.
   */
  const submitMove=useCallback((word:string,path:number[])=>{
    const match=current.current?.matchId;
    if(!match||authEnding()||ownedEpoch.current!==authEpoch()||outbox.current.length>=MOVE_QUEUE)return false;
    const move:KingMove={id:crypto.randomUUID(),match,word,path,sentAt:Date.now(),tries:0};
    outbox.current=[...outbox.current,move];setMoves(outbox.current);setRefused(null);
    publishMove(move);watchMoves();
    return true;
  },[publishMove,watchMoves]);
  const retry=useCallback(()=>{const socket=client.current;if(!socket||authEnding()||ownedEpoch.current!==authEpoch())return;resetConnection.current?.();setError(null);void socket.deactivate().then(()=>{if(client.current===socket&&!authEnding())socket.activate();});},[]);
  const setSentinel=useCallback((handle:string|null)=>{sentinel.current=handle;},[]);
  return {state,connected,pending,error,offset,send,retry,submitMove,moves,refused,setSentinel};
}

