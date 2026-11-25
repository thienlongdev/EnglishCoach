'use client';
import { useEffect,useRef } from 'react';
import * as T from 'three';
import { CinematicBurst } from '@/lib/vfx/particles';
import { VfxQuality,vfxReduced,VFX_BUDGET } from '@/lib/vfx/quality';

/** Ephemeral only: never mounted on an ordinary study action, disposed after four seconds. A renderer that cannot start
 *  (or loses its context) hides the canvas: a failed WebGL canvas is otherwise painted as a blank slab over the page. */
export default function BurstCanvas(){
 const ref=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{
  const canvas=ref.current;if(!canvas||vfxReduced())return;
  let renderer:T.WebGLRenderer;try{renderer=new T.WebGLRenderer({canvas,alpha:true,antialias:false,powerPreference:'low-power'});}catch{canvas.hidden=true;return;}
  const quality=new VfxQuality();let tier=quality.update(0);const scene=new T.Scene(),camera=new T.PerspectiveCamera(45,1,.1,20),burst=new CinematicBurst(tier);
  camera.position.set(0,.5,3.7);camera.lookAt(0,.25,0);scene.add(burst.root);burst.start();renderer.setClearColor(0,0);
  const resize=()=>{const w=canvas.clientWidth,h=canvas.clientHeight;renderer.setPixelRatio(Math.min(devicePixelRatio,VFX_BUDGET[tier].dpr));renderer.setSize(w,h,false);camera.aspect=w/Math.max(1,h);camera.updateProjectionMatrix();};resize();
  let frame=0,last=performance.now(),stopped=false;
  const stop=()=>{stopped=true;cancelAnimationFrame(frame);};
  const draw=(now:number)=>{if(stopped||document.hidden||vfxReduced()){stop();return;}const next=quality.update((now-last)/1000);if(next!==tier){tier=next;resize();}burst.setTier(tier);burst.update((now-last)/1000,renderer.getPixelRatio());last=now;renderer.render(scene,camera);if(burst.active)frame=requestAnimationFrame(draw);};frame=requestAnimationFrame(draw);
  const lost=(e:Event)=>{e.preventDefault();stop();canvas.hidden=true;};canvas.addEventListener('webglcontextlost',lost);document.addEventListener('visibilitychange',stop);window.addEventListener('resize',resize);
  return()=>{stop();window.removeEventListener('resize',resize);document.removeEventListener('visibilitychange',stop);canvas.removeEventListener('webglcontextlost',lost);burst.dispose();renderer.dispose();renderer.forceContextLoss();};
 },[]);
 return <canvas ref={ref} aria-hidden="true" data-echo-vfx="celebration" style={{position:'fixed',inset:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:30}}/>;
}
