'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Eight-second, local-only input meter. No playback, recording, upload or provider connection. */
export function useArenaMicCheck() {
  const [active,setActive]=useState(false),[level,setLevel]=useState(0),[error,setError]=useState('');
  const generation=useRef(0),dispose=useRef<(()=>void)|null>(null);
  const stop=useCallback(()=>{generation.current++;dispose.current?.();dispose.current=null;setActive(false);setLevel(0);},[]);
  const start=useCallback(async()=>{
    stop();const run=generation.current;setError('');setActive(true);
    let stream:MediaStream|undefined,context:AudioContext|undefined;
    try {
      stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1},video:false});
      if(run!==generation.current){stream.getTracks().forEach(t=>t.stop());return;}
      context=new AudioContext({latencyHint:'interactive'});
      const analyser=context.createAnalyser();analyser.fftSize=256;
      const source=context.createMediaStreamSource(stream);source.connect(analyser);
      const samples=new Float32Array(256);
      const tick=setInterval(()=>{analyser.getFloatTimeDomainData(samples);let energy=0;for(const n of samples)energy+=n*n;setLevel(Math.min(1,Math.sqrt(energy/samples.length)*4));},50);
      const timeout=setTimeout(stop,8000);
      dispose.current=()=>{clearInterval(tick);clearTimeout(timeout);source.disconnect();stream?.getTracks().forEach(t=>t.stop());void context?.close();};
      await context.resume();
    } catch {
      stream?.getTracks().forEach(t=>t.stop());if(context?.state!=='closed')void context?.close();
      if(run===generation.current){stop();setError('MIC_DENIED');}
    }
  },[stop]);
  useEffect(()=>{
    const hide=()=>{if(document.hidden)stop();};document.addEventListener('visibilitychange',hide);
    return()=>{generation.current++;dispose.current?.();dispose.current=null;document.removeEventListener('visibilitychange',hide);};
  },[stop]);
  return {active,level,error,start,stop};
}
