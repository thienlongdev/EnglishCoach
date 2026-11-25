'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Client} from '@stomp/stompjs';
import {ensureApiSession} from '@/lib/api-session';
import {authEpoch,authEnding,subscribeAuthLifecycle} from '@/lib/auth-lifecycle';
import {getWsUrl} from '@/services/stompClient';
import type {SpellingState,SpellingCommand,SpellingEvent} from '@/types/spelling';

/** The existing authenticated broker and lifecycle; drafts are coalesced, verdicts are explicit server events. */
export function useSpellingRoom(handle:string|null){
  const [state,setState]=useState<SpellingState|null>(null),[connected,setConnected]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState('');
  const socket=useRef<Client|null>(null),current=useRef<SpellingState|null>(null),secret=useRef(handle),epoch=useRef(0),ready=useRef(false);
  const inflight=useRef<Map<string,{timer:ReturnType<typeof setTimeout>;action:string}>>(new Map());
  const clock=useRef({server:Date.now(),local:performance.now()});
  secret.current=handle;
  const clear=useCallback(()=>{for(const p of inflight.current.values())clearTimeout(p.timer);inflight.current.clear();setPending(false);},[]);
  const send=useCallback((action:string,payload:SpellingCommand={})=>{
    const client=socket.current;if(!client?.connected||!ready.current||authEnding()||epoch.current!==authEpoch())return false;
    const quiet=['draft','move','ping'].includes(action),requestId=payload.requestId??crypto.randomUUID();
    if(!quiet){setError('');setPending(true);inflight.current.set(requestId,{action,timer:setTimeout(()=>{inflight.current.delete(requestId);setPending(inflight.current.size>0);setError('REQUEST_TIMEOUT');},10000)});}
    client.publish({destination:`/app/spelling/${action}`,body:JSON.stringify({...payload,requestId,roomId:payload.roomId??current.current?.roomId,sentinel:payload.sentinel??secret.current??undefined})});
    return true;
  },[]);
  useEffect(()=>{
    let disposed=false,replaced=false,rejoinId:string|null=null;epoch.current=authEpoch();
    const client=new Client({brokerURL:getWsUrl(),reconnectDelay:1800,heartbeatIncoming:10000,heartbeatOutgoing:10000,debug:()=>{},
      beforeConnect:async()=>{if(disposed||replaced||authEnding()||epoch.current!==authEpoch()||!(await ensureApiSession()))void client.deactivate();},
      onConnect:()=>{
        ready.current=false;setConnected(false);
        const rejoin=(roomId:string)=>{rejoinId=crypto.randomUUID();client.publish({destination:'/app/spelling/rejoin',body:JSON.stringify({roomId,requestId:rejoinId,sentinel:secret.current??undefined})});};
        client.subscribe('/user/queue/spelling',message=>{
          if(disposed||authEnding()||epoch.current!==authEpoch())return;
          let event:SpellingEvent;try{event=JSON.parse(message.body);}catch{return;}
          const request=event.requestId?inflight.current.get(event.requestId):undefined;
          if(request&&event.requestId){clearTimeout(request.timer);inflight.current.delete(event.requestId);setPending(inflight.current.size>0);}
          if(event.type==='REPLACED'){replaced=true;ready.current=false;setConnected(false);setError('SESSION_REPLACED');void client.deactivate();return;}
          if(event.type==='ERROR'){
            setError(event.code??'SPELLING_UNAVAILABLE');
            if(['ROOM_NOT_FOUND','SESSION_REPLACED'].includes(event.code??'')){current.current=null;setState(null);ready.current=true;setConnected(true);}
            return;
          }
          if(event.type==='SYNC'){
            if(event.state){current.current=event.state;setState(event.state);rejoin(event.state.roomId);}
            else{current.current=null;setState(null);ready.current=true;setConnected(true);}return;
          }
          if(event.requestId===rejoinId){rejoinId=null;ready.current=true;setConnected(true);setError('');}
          if(request?.action==='leave'){current.current=null;setState(null);return;}
          const next=event.state;
          if(next&&(!current.current||next.roomId!==current.current.roomId||next.revision>=current.current.revision)){
            clock.current={server:next.serverTime,local:performance.now()};current.current=next;setState(next);
          }
        });
        if(current.current)rejoin(current.current.roomId);else client.publish({destination:'/app/spelling/sync',body:JSON.stringify({requestId:crypto.randomUUID()})});
      },
      onWebSocketClose:()=>{ready.current=false;if(!disposed){setConnected(false);clear();}},
      onStompError:()=>{if(!disposed)setError('CONNECTION_LOST');}
    });
    socket.current=client;client.activate();
    const beat=setInterval(()=>{if(current.current)send('ping');},7000);
    const unsubscribe=subscribeAuthLifecycle(()=>{if(authEnding()||epoch.current!==authEpoch()){current.current=null;setState(null);void client.deactivate();}});
    return()=>{disposed=true;ready.current=false;unsubscribe();clearInterval(beat);clear();socket.current=null;void client.deactivate();};
  },[clear,send]);
  return {state,connected,pending,error,send,clock,current,clearError:()=>setError('')};
}
