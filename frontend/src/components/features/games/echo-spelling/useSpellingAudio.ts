'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {authFetch} from '@/lib/api-session';
import {holdMusicFocus} from '@/lib/music/focus';
import type {SpellingCommand,SpellingState} from '@/types/spelling';

/** Playback only: every recording was prepared by the existing local OmniVoice, never browser TTS. */
export function useSpellingAudio(state:SpellingState|null,send:(action:string,c?:SpellingCommand)=>boolean,volume:number){
  const [status,setStatus]=useState<'idle'|'loading'|'playing'|'blocked'|'failed'>('idle');
  const player=useRef<HTMLAudioElement|null>(null),release=useRef<(()=>void)|null>(null),generation=useRef(0),currentUrl=useRef('');
  const cache=useRef(new Map<string,string>()),volumeRef=useRef(volume);volumeRef.current=volume;
  const completion=useRef<(()=>void)|null>(null),priority=useRef(false),abort=useRef<AbortController|null>(null);
  const stop=useCallback(()=>{generation.current++;abort.current?.abort();player.current?.pause();if(player.current){player.current.onended=null;player.current.onerror=null;}release.current?.();release.current=null;priority.current=false;setStatus('idle');},[]);
  const play=useCallback(async(url:string,onEnd?:()=>void,word=false)=>{
    if(priority.current&&!word)return;
    stop();priority.current=word;const ticket=generation.current;completion.current=onEnd??null;currentUrl.current=url;
    const controller=new AbortController();abort.current=controller;setStatus('loading');
    try{
      let local=cache.current.get(url);
      if(!local){const response=await authFetch(url,{cache:'no-store',signal:controller.signal});if(!response.ok)throw new Error('AUDIO_UNAVAILABLE');
        const blob=await response.blob();if(ticket!==generation.current)return;
        local=URL.createObjectURL(blob);cache.current.set(url,local);
        while(cache.current.size>24){const first=cache.current.keys().next().value!;URL.revokeObjectURL(cache.current.get(first)!);cache.current.delete(first);}}
      if(ticket!==generation.current)return;
      const audio=player.current??new Audio();player.current=audio;audio.preload='auto';audio.src=local;audio.volume=volumeRef.current;
      audio.onended=()=>{if(ticket!==generation.current)return;release.current?.();release.current=null;priority.current=false;setStatus('idle');completion.current?.();};
      audio.onerror=()=>{if(ticket===generation.current){setStatus('failed');release.current?.();release.current=null;}};
      release.current=holdMusicFocus('Echo Spelling narrator');
      try{await audio.play();if(ticket===generation.current)setStatus('playing');}
      catch(e){if(ticket===generation.current){setStatus(e instanceof DOMException&&e.name==='NotAllowedError'?'blocked':'failed');release.current?.();release.current=null;}}
    }catch(e){if(!controller.signal.aborted&&ticket===generation.current)setStatus('failed');}
  },[stop]);
  useEffect(()=>{if(player.current)player.current.volume=volume;},[volume]);
  const wordKey=state?.turn?.audioUrl&&['HEAR','SPELL'].includes(state.phase)?`${state.turn.id}:${state.turn.audioRevision}`:'';
  const live=useRef(state);live.current=state;
  useEffect(()=>{
    const s=live.current;if(!wordKey||!s?.turn?.audioUrl)return;
    const turn=s.turn,first=s.phase==='HEAR',self=turn.player===s.self;
    void play(turn.audioUrl!,first&&self?()=>send('heard',{turnId:turn.id}):undefined,true);
    return stop;
  },[wordKey,play,send,stop]);
  const phraseKey=state?.phase==='COUNTDOWN'?`start:${state.matchId}`:state?.phase==='APPROACH'?`contestant:${state.turn?.id}`:
    state?.phase==='RESULT'?`${state.result?.correct?'correct':state.result?.reason==='TIMEOUT'?'timeout':'wrong'}:${state.turn?.id}`:
    state?.phase==='FINISHED'?`${state.winner&&state.mode==='MULTIPLAYER'?'winner':'finish'}:${state.matchId}`:'';
  useEffect(()=>{if(phraseKey)void play(`/api/v1/spelling/announcements/${phraseKey.split(':')[0]}`);},[phraseKey,play]);
  useEffect(()=>()=>{stop();for(const url of cache.current.values())URL.revokeObjectURL(url);cache.current.clear();},[stop]);
  const resume=useCallback(()=>{
    const audio=player.current;
    if(audio&&status==='blocked'){release.current=holdMusicFocus('Echo Spelling narrator');void audio.play().then(()=>setStatus('playing')).catch(()=>setStatus('failed'));}
    else if(currentUrl.current)void play(currentUrl.current,completion.current??undefined,true);
  },[play,status]);
  return{status,resume,preview:()=>play('/api/v1/spelling/announcements/start'),stop};
}
