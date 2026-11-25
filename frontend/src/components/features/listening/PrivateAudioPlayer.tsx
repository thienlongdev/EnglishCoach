"use client";
import React, {forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {Headphones,Loader2,Play,Pause,RotateCcw} from 'lucide-react';
import {apiClient} from '@/services/api-client';
import {useLanguage} from '@/context/LanguageContext';
import {authEpoch,assertAuthEpoch,authSignal} from '@/lib/auth-lifecycle';
import type {AdvancedAudioPlayerProps,AdvancedAudioPlayerRef} from './AdvancedAudioPlayer';

export const PrivateAudioPlayer=forwardRef<AdvancedAudioPlayerRef,AdvancedAudioPlayerProps>(function PrivateAudioPlayer(props,ref) {
    const {locale}=useLanguage(); const vi=locale==='vi';
    const audio=useRef<HTMLAudioElement>(null); const callbacks=useRef(props); callbacks.current=props;
    const [src,setSrc]=useState<string>(); const [error,setError]=useState(false); const [retry,setRetry]=useState(0);
    const [time,setTime]=useState(0); const [duration,setDuration]=useState(0); const [playing,setPlaying]=useState(false);
    const [rate,setRate]=useState(1);
    const loop=useRef<{start:number;end:number;max:number;count:number;gap:number}|null>(null);
    const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
    const pendingSeek=useRef<number|null>(null); const pendingPlay=useRef(false);
    function cancelGap() {if(timer.current)clearTimeout(timer.current);timer.current=null;}
    function pause() {pendingPlay.current=false;cancelGap();audio.current?.pause();}
    function play() {pendingPlay.current=true;if(audio.current?.readyState&&audio.current.readyState>=1) void audio.current.play().catch(e=>{if(e?.name!=='AbortError')setError(true);});}
    function seek(value:number) {
        if(!Number.isFinite(value))return; cancelGap();
        const bounds=props.lockToSegment?loop.current:null;
        const next=Math.max(bounds?.start??0,Math.min(value,bounds?.end??(audio.current?.duration||Infinity)));
        if(audio.current?.readyState&&audio.current.readyState>=1)audio.current.currentTime=next;else pendingSeek.current=next;
    }
    useImperativeHandle(ref,()=>({seekTo:seek,play,pause,getCurrentTime:()=>audio.current?.currentTime??0,
        setPlaybackRate:r=>{if(audio.current)audio.current.playbackRate=r;setRate(r);},
        setLoop:(start,end,autoPlay=true,maxRepeats=Infinity,gapSeconds=0)=>{pause();loop.current={start,end,max:maxRepeats,count:0,gap:gapSeconds};seek(start);if(autoPlay)play();},
        clearLoop:()=>{cancelGap();loop.current=null;},getCycleCount:()=>loop.current?.count??0,resetCycleCount:()=>{if(loop.current)loop.current.count=0;}
    }));
    useEffect(()=>{
        const abort=new AbortController();const epoch=authEpoch();let url:string|undefined;let disposed=false;
        setSrc(undefined);setError(false);pause();
        apiClient.get<Blob>(props.audioUrl.replace(/^\/api\/v1/,''),{responseType:'blob',signal:abort.signal,timeout:30000}).then(response=>{
            if(disposed)return;assertAuthEpoch(epoch);
            if(!response.data.size||response.data.size>24*1024*1024+1024||!response.data.type.startsWith('audio/'))throw new Error('Invalid audio');
            url=URL.createObjectURL(response.data);setSrc(url);
        }).catch(()=>{if(!disposed&&!abort.signal.aborted)setError(true);});
        const cancel=()=>{pause();abort.abort();if(url){URL.revokeObjectURL(url);url=undefined;}setSrc(undefined);};
        const authAbort=authSignal(); authAbort.addEventListener("abort",cancel,{once:true});
        const visibility=()=>{if(document.hidden)pause();};document.addEventListener('visibilitychange',visibility);
        return()=>{disposed=true;pause();abort.abort();if(url)URL.revokeObjectURL(url);document.removeEventListener('visibilitychange',visibility);authAbort.removeEventListener("abort",cancel);};
    },[props.audioUrl,retry]);
    useEffect(()=>{if(props.isRecording)pause();},[props.isRecording]);
    function updateTime(forceEnd=false) {
        const a=audio.current;if(!a)return;
        const active=loop.current;
        if(active&&(forceEnd||!a.paused)&&a.currentTime>=active.end-.03) {
            a.pause();active.count++;
            if(active.count<active.max){a.currentTime=active.start;timer.current=setTimeout(()=>{timer.current=null;play();},Math.max(0,active.gap)*1000);}
            else pendingPlay.current=false;
        }
        setTime(a.currentTime);callbacks.current.onTimeUpdate?.(a.currentTime,!a.paused);
    }
    useEffect(()=>{
        if(!playing)return;
        const sample=setInterval(()=>updateTime(),50);
        return()=>clearInterval(sample);
    },[playing]);
    const format=(n:number)=>`${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
    return <div className="w-full bg-gradient-to-br from-indigo-950 via-slate-900 to-violet-950 p-4 sm:p-6 text-white" data-testid="document-audio-player">
        <div className="flex items-center gap-3 mb-5"><Headphones className="text-indigo-300" size={28}/><div><p className="font-bold">{vi?'Bài nghe từ tài liệu':'Document listening'}</p><p className="text-xs text-indigo-200">{vi?'Theo dõi và luyện từng câu':'Listen and practise sentence by sentence'}</p></div></div>
        <audio ref={audio} src={src} preload="metadata" onError={()=>setError(true)} onTimeUpdate={()=>updateTime()}
            onLoadedMetadata={()=>{const a=audio.current;if(!a)return;setDuration(a.duration);if(pendingSeek.current!==null){a.currentTime=pendingSeek.current;pendingSeek.current=null;}a.playbackRate=rate;callbacks.current.onReady?.();if(pendingPlay.current)play();}}
            onPlay={()=>{setError(false);setPlaying(true);callbacks.current.onPlaybackStateChange?.(true);}}
            onPause={()=>{setPlaying(false);callbacks.current.onPlaybackStateChange?.(false);}}
            onEnded={()=>{updateTime(true);callbacks.current.onEnded?.();}}/>
        {error?<div role="alert" className="text-sm"><p>{vi?'Chưa thể phát âm thanh.':'Could not play audio.'}</p><button type="button" onClick={()=>setRetry(n=>n+1)} className="mt-2 underline">{vi?'Thử lại':'Retry'}</button></div>:!src?<p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="animate-spin motion-reduce:animate-none" size={16}/>{vi?'Đang tải âm thanh…':'Loading audio…'}</p>:<>
            <input aria-label={vi?'Vị trí phát':'Playback position'} type="range" min={props.lockToSegment?(loop.current?.start??0):0} max={props.lockToSegment?(loop.current?.end??duration):duration} step={0.05} value={time} onChange={e=>{const value=Number(e.target.value);if(props.allowFreeSeek){cancelGap();loop.current=null;}seek(value);setTime(value);if(props.allowFreeSeek)callbacks.current.onUserSeek?.(value);}} className="w-full accent-indigo-400"/>
            <div className="flex flex-wrap items-center gap-3 mt-2">
                <button type="button" onClick={()=>playing?pause():play()} aria-label={playing?(vi?'Tạm dừng':'Pause'):(vi?'Phát':'Play')} className="min-h-[44px] min-w-[44px] rounded-full bg-indigo-500 flex items-center justify-center">{playing?<Pause size={20}/>:<Play size={20}/>}</button>
                <button type="button" onClick={()=>{if(loop.current)loop.current.count=0;seek(loop.current?.start??0);play();}} aria-label={vi?'Nghe lại':'Replay'} className="min-h-[44px] min-w-[44px] rounded-full bg-white/10 flex items-center justify-center"><RotateCcw size={18}/></button>
                <span className="text-xs tabular-nums">{format(time)} / {format(duration)}</span>
                <label className="ml-auto text-xs">{vi?'Tốc độ':'Speed'} <select aria-label={vi?'Tốc độ phát':'Playback speed'} value={rate} onChange={e=>{const value=Number(e.target.value);setRate(value);if(audio.current)audio.current.playbackRate=value;callbacks.current.onPlaybackRateChange?.(value);}} className="ml-1 min-h-[44px] rounded-lg bg-slate-800 px-2">{[.5,.75,1,1.25,1.5,2].map(v=><option key={v} value={v}>{v}×</option>)}</select></label>
            </div>
        </>}
    </div>;
});
