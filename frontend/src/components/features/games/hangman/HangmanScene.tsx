'use client';
import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { HangmanRound } from '@/types/hangman';
import { descent, lossPhase, lossClockRate, LOSS_DURATION } from './hangmanPresentation';
import { ExplorerRig, SharkRig, ArtPalette } from './HangmanArtwork';
import './hangman-scene.css';
import { EXPLORER_HANDS, explorerHands, explorerPose, mouthBridge, sharkMouthCentre, waterContactMotion, balloonHand, balloonRope, balloonBundle, mirrorBundles, gripTransfer, GRIP_TRANSFER_DURATION, WATER_Y, WATER_ENTRY_X, WATER_CONTACT_AT, BITE_AT, X_EYES_AT, lossMotion, surfaceBiteTarget } from './hangmanRig';

const BALLOONS = [[214,88],[272,49],[330,53],[390,47],[447,88],[480,92],[180,92],[414,84],[243,82],[453,96]];
type Props = { round: HangmanRound; pending?: boolean; onLossComplete: (id: string) => void; onPopPaint?: (at: number) => void };
/** Original layered art. Actors and the water plane share an 800 × 520 world. */
export function HangmanScene({ round, pending, onLossComplete, onPopPaint }: Props) {
  const sceneId=useId().replace(/:/g,''),humanClip=`${sceneId}-human-water`,sharkMask=`${sceneId}-shark-water`,sharkDepth=`${sceneId}-shark-depth`;
  const root=useRef<HTMLDivElement>(null), human=useRef<SVGGElement>(null), shark=useRef<SVGGElement>(null), jaw=useRef<SVGGElement>(null), pupils=useRef<SVGGElement>(null), mouth=useRef<SVGPathElement>(null);
  const splash=useRef<SVGGElement>(null),ripples=useRef<SVGGElement>(null);
  const previous=useRef(round), latest=useRef({round,pending,onLossComplete,onPopPaint,reaction:'IDLE'});
  const winStart=useRef<number|null>(null),winOrigin=useRef({x:585,y:438,face:1});
  const lossStart=useRef<number|null>(null), reactionUntil=useRef(0), currentDrop=useRef(descent(round.initialBalloons,round.remainingBalloons));
  const sharkPosition=useRef({x:585,y:438,face:1}), attackOrigin=useRef({x:585,y:438,face:1}), announced=useRef(false);
  const mirrored=mirrorBundles(round.roundId),ids=Array.from({length:round.remainingBalloons},(_,i)=>i),bundle=balloonBundle(ids,mirrored);
  const support=useRef({bundle,at:performance.now()-GRIP_TRANSFER_DURATION,from:{leftArm:0,rightArm:0}}),supportAngles=useRef({leftArm:0,rightArm:0});
  const lossDrop=useRef(currentDrop.current),lossElapsed=useRef(0),lossTick=useRef(0);
  const lossArms=useRef({leftArm:0,rightArm:0});
  const [reaction,setReaction]=useState('IDLE'), [burst,setBurst]=useState<number|null>(null);
  latest.current={round,pending,onLossComplete,onPopPaint,reaction};
  useLayoutEffect(()=>{
    const old=previous.current;
    if(old.roundId!==round.roundId){lossStart.current=null;lossElapsed.current=0;winStart.current=null;announced.current=false;currentDrop.current=descent(round.initialBalloons,round.remainingBalloons);support.current={bundle,at:performance.now()-GRIP_TRANSFER_DURATION,from:{leftArm:0,rightArm:0}};setBurst(null);setReaction('IDLE');}
    else if(round.version>old.version){const wrong=round.remainingBalloons<old.remainingBalloons;setReaction(wrong?'WRONG':'CORRECT');reactionUntil.current=performance.now()+900;if(wrong){setBurst(round.remainingBalloons);}}
    if(round.status==='WON'&&winStart.current===null){winStart.current=performance.now();winOrigin.current={...sharkPosition.current};}
    if(support.current.bundle!==bundle){support.current={bundle,at:performance.now(),from:{...supportAngles.current}};}
    if(round.status==='LOST'&&lossStart.current===null){lossStart.current=performance.now();lossTick.current=lossStart.current;lossElapsed.current=0;lossDrop.current=currentDrop.current;lossArms.current={...supportAngles.current};attackOrigin.current={...sharkPosition.current};}
    previous.current=round;
  },[round]);
  useLayoutEffect(()=>{if(burst===null)return;const frame=requestAnimationFrame(at=>latest.current.onPopPaint?.(at));return()=>cancelAnimationFrame(frame);},[burst]);
  useLayoutEffect(()=>{
    let frame=0,last=performance.now(),sampleAt=performance.now(),frameCount=0,slowFrames=0,maxFrame=0,phase='';const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
    const nodes=Object.fromEntries(['head','leftArm','rightArm','leftLeg','rightLeg'].map(name=>[name,human.current?.querySelector?.<SVGGElement>(`.hm-joint-${name}`)]));
    const tail=shark.current?.querySelector?.<SVGGElement>('.hm-joint-tail'),fin=shark.current?.querySelector?.<SVGGElement>('.hm-joint-fin');
    const handNodes=Array.from(human.current?.querySelectorAll?.<SVGGElement>('.hm-hand-grip')??[]),openNodes=Array.from(human.current?.querySelectorAll?.<SVGGElement>('.hm-hand-open')??[]);
    const bridge=human.current?.querySelector?.<SVGPathElement>('.hm-bundle-bridge');
    const ease=(n:number)=>{const t=Math.min(1,Math.max(0,n));return t*t*(3-2*t);};
    const tick=(now:number)=>{
      const {round:r,pending:waiting}=latest.current,gap=now-last,dt=Math.min(64,gap);last=now;frameCount++;maxFrame=Math.max(maxFrame,gap);if(gap>25)slowFrames++;if(now-sampleAt>5000){root.current?.setAttribute('data-frame-sample',JSON.stringify({frames:frameCount,slowFrames,maxFrameMs:+maxFrame.toFixed(2)}));sampleAt=now;frameCount=0;slowFrames=0;maxFrame=0;}
      const loss=lossStart.current!==null;
      if(loss){lossElapsed.current+=Math.max(0,now-lossTick.current)*lossClockRate(reduced.matches);lossTick.current=now;}
      const elapsed=loss?lossElapsed.current:0;
      const p=loss?lossPhase(elapsed):r.status==='WON'?'WIN':waiting?'THINKING':now<reactionUntil.current?latest.current.reaction:r.remainingBalloons<=2?'WORRIED':'IDLE';
      root.current?.setAttribute('data-loss-elapsed',loss?elapsed.toFixed(1):'');
      if(p!==phase){root.current?.setAttribute('data-phase',p);phase=p;}
      const target=r.status==='WON'?0:descent(r.initialBalloons,Math.max(1,r.remainingBalloons));
      currentDrop.current+=(target-currentDrop.current)*(reduced.matches?1:1-Math.exp(-dt/220));
      const holding=balloonBundle(Array.from({length:r.remainingBalloons},(_,i)=>i),mirrorBundles(r.roundId));
      const age=reduced.matches?GRIP_TRANSFER_DURATION:now-support.current.at,transfer=gripTransfer(holding,age),blend=ease((age-140)/710);
      supportAngles.current={leftArm:transfer.leftArm+support.current.from.leftArm*(1-blend),rightArm:transfer.rightArm+support.current.from.rightArm*(1-blend)};
      root.current?.setAttribute('data-grip-state',transfer.state);root.current?.setAttribute('data-bundle',holding);
      const motion=loss?lossMotion(elapsed,lossDrop.current,reduced.matches):null;
      const bob=reduced.matches?0:Math.sin(now/710)*2.5,lean=holding==='LEFT'?-2:holding==='RIGHT'?2:0;
      human.current?.setAttribute('transform',`translate(${motion?.x??0} ${motion?.drop??currentDrop.current+bob}) rotate(${motion?.angle??(reduced.matches?lean:Math.sin(now/1100)*1.1+lean*blend)} 330 245)`);
      root.current?.setAttribute('data-wet',String(motion?.wet??false));
      root.current?.setAttribute('data-waterline',String(WATER_Y));root.current?.setAttribute('data-body-drop',(motion?.drop??currentDrop.current+bob).toFixed(2));
      const surface=waterContactMotion(loss?elapsed:0,reduced.matches);
      splash.current?.setAttribute('opacity',String(surface.splash));
      splash.current?.setAttribute('transform',`scale(${surface.spread} ${1-.35*(surface.spread-.65)})`);
      ripples.current?.setAttribute('opacity',String(surface.ripple));
      ripples.current?.setAttribute('transform',`scale(${surface.spread} 1)`);
      const open=loss?30*ease((elapsed-2000)/650)*(1-ease((elapsed-BITE_AT)/(X_EYES_AT-BITE_AT)))+4*ease((elapsed-3300)/500):r.remainingBalloons<=2?10:4+Math.sin(now/850)*1.5;
      let x:number,y:number,face:number,tilt:number;
      if(loss){const approach=ease((elapsed-2000)/(BITE_AT-2000)),contact=surfaceBiteTarget(motion!.drop,motion!.x,motion!.angle),centre=sharkMouthCentre(open);x=attackOrigin.current.x+(contact.x-centre[0]-attackOrigin.current.x)*approach;y=attackOrigin.current.y+(contact.y-centre[1]-attackOrigin.current.y)*approach;face=attackOrigin.current.face+(1-attackOrigin.current.face)*ease((elapsed-1700)/300);tilt=0;const after=ease((elapsed-3400)/1000);x+=150*after;y+=25*after;}
      else{const t=(now/1000)%14,critical=r.remainingBalloons<=2;x=critical?495+45*Math.cos(t/14*Math.PI*2):505+140*Math.cos(t/14*Math.PI*2);y=440+Math.sin(now/700)*5;face=Math.tanh(Math.sin(t/14*Math.PI*2)*7);tilt=Math.sin(t/14*Math.PI*2)*4;if(r.status==='WON'){const away=ease((now-(winStart.current??now))/1800);x=winOrigin.current.x+(620-winOrigin.current.x)*away;y=winOrigin.current.y+(430-winOrigin.current.y)*away;face=winOrigin.current.face+(-1-winOrigin.current.face)*away;tilt=8*away;}}
      if(reduced.matches&&!loss){x=585;y=438;face=1;tilt=0;}
      sharkPosition.current={x,y,face};shark.current?.setAttribute('transform',`translate(${x} ${y}) rotate(${tilt}) scale(${face} 1)`);
      jaw.current?.setAttribute('transform',`rotate(${-open})`);mouth.current?.setAttribute('d',mouthBridge(open));pupils.current?.setAttribute('transform',`translate(${loss||r.remainingBalloons<=4?-2:Math.sin(now/1400)*2} ${loss||r.remainingBalloons<=4?-3:0})`);
      const pose=explorerPose(now,loss?elapsed:null,p==='WRONG'?900-(reactionUntil.current-now):null,p==='WIN'||p==='CORRECT',reduced.matches,p==='THINKING');
      if(!loss){pose.leftArm+=supportAngles.current.leftArm;pose.rightArm+=supportAngles.current.rightArm;}
      else if(elapsed<WATER_CONTACT_AT){const release=1-ease(elapsed/450);pose.leftArm+=lossArms.current.leftArm*release;pose.rightArm+=lossArms.current.rightArm*release;}
      else if(elapsed>=X_EYES_AT){pose.head=8;pose.leftArm=-24;pose.rightArm=24;}
      else if(elapsed>=WATER_CONTACT_AT){pose.leftArm=-12+(reduced.matches?0:Math.sin(elapsed/100)*9);pose.rightArm=12-(reduced.matches?0:Math.sin(elapsed/115)*9);}
      // Soles arrive at the reviewed contact plane before underwater kicking.
      if(loss&&elapsed<WATER_CONTACT_AT){const landing=ease((elapsed-650)/450);pose.leftLeg*=1-landing;pose.rightLeg*=1-landing;}
      for(const name of ['head','leftArm','rightArm','leftLeg','rightLeg'] as const)nodes[name]?.setAttribute('transform',`rotate(${pose[name].toFixed(3)})`);
      const hands=explorerHands(pose);
      for(let side=0;side<2;side++){const empty=holding===(side===0?'RIGHT':'LEFT'),grip=loss?0:empty?transfer.secondaryGrip:1;handNodes[side]?.setAttribute('opacity',String(grip));openNodes[side]?.setAttribute('opacity',String(1-grip));handNodes[side]?.style.setProperty('opacity',String(grip));openNodes[side]?.style.setProperty('opacity',String(1-grip));}
      bridge?.setAttribute('d',`M${hands[0].join(' ')} L${hands[1].join(' ')}`);bridge?.setAttribute('opacity',holding==='LEFT'||holding==='RIGHT'?String(transfer.secondaryGrip):'0');
      // React replaces popped balloon children; read the current small set instead of retaining detached paths.
      for(const node of Array.from(human.current?.querySelectorAll?.<SVGGElement>('[data-balloon]')??[])){
        const b={index:Number(node.getAttribute('data-balloon')),shape:node.querySelector<SVGGElement>('.hm-balloon-shape'),rope:node.querySelector<SVGPathElement>('.hm-rope')};
        const [originalX,by]=BALLOONS[b.index],bx=mirrorBundles(r.roundId)?660-originalX:originalX,sway=reduced.matches?0:Math.sin(now/(900+b.index*65)+b.index*.7)*4,lift=reduced.matches?0:Math.cos(now/(1100+b.index*70)+b.index)*2;
        const popped=b.index>=r.remainingBalloons,age=loss?elapsed:900-(reactionUntil.current-now),slack=popped?ease(age/280):0;
        b.shape?.setAttribute('transform',`translate(${sway.toFixed(2)} ${lift.toFixed(2)})`);
        b.rope?.setAttribute('d',balloonRope(bx,by,hands[balloonHand(b.index,mirrorBundles(r.roundId))],sway,lift,slack));
        b.rope?.setAttribute('opacity',popped?String(1-ease(age/280)):'1');
      }
      const swim=now/(loss&&elapsed>2000&&elapsed<3300?95:210);
      tail?.setAttribute('transform',`rotate(${reduced.matches?0:Math.sin(swim)*7})`);fin?.setAttribute('transform',`rotate(${reduced.matches?0:Math.sin(swim*.55+.6)*6})`);
      if(loss&&elapsed>=LOSS_DURATION&&!announced.current){announced.current=true;latest.current.onLossComplete(r.roundId);}
      frame=requestAnimationFrame(tick);
    };frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[round.roundId]);
  return <div ref={root} data-phase="IDLE" data-grip={round.remainingBalloons===0?'RELEASED':'HOLDING'} data-hangman-art="v4.3" data-impact-x={WATER_ENTRY_X} data-clearance={WATER_Y-341-descent(round.initialBalloons,Math.max(1,round.remainingBalloons))} className={`hm-scene hm-v41 ${round.remainingBalloons<=Math.ceil(round.initialBalloons/2)?'hm-worried':''}`} aria-label={`${round.remainingBalloons} of ${round.initialBalloons} balloons remaining`}>
    <svg viewBox="0 0 800 520" role="img" aria-label="A blue-capped explorer in orange overalls, floating on balloons above a mischievous big-jawed shark">
      <ArtPalette/>
      <defs>
        <clipPath id={humanClip} clipPathUnits="userSpaceOnUse"><rect width="800" height={WATER_Y}/></clipPath>
        <linearGradient id={sharkDepth} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={WATER_Y} y2={WATER_Y+32}><stop stopColor="white"/><stop offset=".35" stopColor="#b8b8b8"/><stop offset="1" stopColor="black"/></linearGradient>
        <mask id={sharkMask} maskUnits="userSpaceOnUse" x="0" y="0" width="800" height="520"><rect width="800" height={WATER_Y} fill="white"/><rect y={WATER_Y} width="800" height="32" fill={`url(#${sharkDepth})`}/></mask>
      </defs>
      <rect width="800" height="520" fill="url(#hm-sky)"/><circle cx="690" cy="91" r="46" fill="#fff0b6" opacity=".8"/>
      <g fill="#fff9eb" opacity=".65"><path d="M22 92q-12-29 23-34 5-43 46-30 18-22 40 5 41-5 40 29 33 20 2 33Z"/><path d="M580 232q-14-18 7-31 6-35 39-25 28-31 52 4 43-10 50 23 30 8 11 29Z"/></g>
      <path d={`M0 ${WATER_Y}q45-8 95 0t110 0 115 0 120 0 125 0 120 0 115 0V520H0Z`} fill="url(#hm-sea)"/>
      <g className="hm-water hm-water-back" fill="none" stroke="#d0f9ea" strokeWidth="3" opacity=".65"><path d="M-160 420q40-12 80 0t80 0 80 0 80 0 80 0 80 0 80 0 80 0 80 0 80 0 80 0 80 0"/><path d="M-80 449h43m95 5h32m101-7h55m117 9h29m120-10h43m80 6h31"/></g>
      <g clipPath={`url(#${humanClip})`} data-water-actor="human"><g ref={human}><g className="hm-rig-float">
        {BALLOONS.slice(0,round.initialBalloons).map(([originalX,y],i)=>{if(i>=round.remainingBalloons&&i!==burst)return null;const x=mirrored?660-originalX:originalX,[hx,hy]=EXPLORER_HANDS[balloonHand(i,mirrored)];return <g key={`${round.roundId}-${i}`} className="hm-balloon" data-balloon={i} data-hand={balloonHand(i,mirrored)===0?'LEFT':'RIGHT'} style={{'--delay':`${i*-.47}s`,'--duration':`${3.8+i*.27}s`,transformOrigin:`${hx}px ${hy}px`} as CSSProperties}>
          <path className="hm-rope" d={balloonRope(x,y,[hx,hy],0,0)} fill="none" stroke="#384b57" strokeWidth="1.6"/>
          <g className={i===burst?'hm-pop':''} style={{transformOrigin:`${x}px ${y}px`}}>
            <g className="hm-balloon-shape">
            <path d={`M${x-7} ${y+27}l7 10 5-10`} fill={`url(#hm-balloon-${i%5})`} className="hm-ink"/>
            <path d={`M${x} ${y-35}C${x+47} ${y-38} ${x+42} ${y+29} ${x} ${y+32}C${x-34} ${y+32} ${x-42} ${y-31} ${x} ${y-35}Z`} fill={`url(#hm-balloon-${i%5})`} className="hm-ink"/>
            <path d={`M${x-14} ${y-20}q-10 10-5 23`} fill="none" stroke="#fff9e7" strokeWidth="6" strokeLinecap="round" opacity=".8"/>
            <path d={`M${x+22} ${y+10}q-5 15-15 17`} fill="none" stroke="#503e59" strokeWidth="2" opacity=".3"/></g>
          </g>{i===burst&&<g key={round.version} className="hm-burst" stroke="#fff6ce" strokeWidth="5" strokeLinecap="round" style={{transformOrigin:`${x}px ${y}px`}}><path d={`M${x-46} ${y}h-14m110 0h14M${x} ${y-45}v-14m0 112v14M${x-34} ${y-32}l-10-10m85 85 10 10M${x+34} ${y-32}l10-10m-85 85-10 10`}/></g>}
        </g>;})}<path className="hm-bundle-bridge" stroke="#384b57" strokeWidth="2.2" fill="none" opacity="0"/><ExplorerRig/>
      </g></g></g>
      <g mask={`url(#${sharkMask})`} data-water-actor="shark"><g ref={shark} className="hm-shark-world" transform="translate(585 438)"><SharkRig jawRef={jaw} pupilsRef={pupils} mouthRef={mouth}/></g></g>
      {/* Fixed world parent; only local shapes expand. No phase/CSS restarts. */}
      <g className="hm-water-contact" transform={`translate(${WATER_ENTRY_X} ${WATER_Y})`}>
        <g ref={splash} className="hm-impact" opacity="0" stroke="#e6fff1" strokeWidth="4" strokeLinecap="round" fill="#a9edf1"><path d="M-50 0q-19-30-9-34 9-1 18 28m69 6q12-38 23-29 5 7-14 25m-11 7q-1-28 10-23 3 5-4 19m-51 1q-20-14-25-7"/><path d="M-24-20l-6-13m26 5v-18m18 16 8-15" fill="none"/></g>
        <g ref={ripples} className="hm-struggle-ripples" opacity="0" fill="none" stroke="#d0f9ea" strokeWidth="3"><ellipse rx="58" ry="7"/><ellipse cy="8" rx="74" ry="10"/><path d="M-43-1q17-5 27-1m32 0q13-4 26 0" strokeLinecap="round"/></g>
      </g>
      <g className="hm-water hm-water-front" fill="none" stroke="#6fc7d4" strokeWidth="4" opacity=".65"><path d="M-160 501q40-9 80 0t80 0 80 0 80 0 80 0 80 0 80 0 80 0 80 0 80 0 80 0 80 0"/></g>
      <g className="hm-win-stars" fill="#fff5bf"><path d="m250 260 4 9 10 1-8 6 2 10-8-5-9 5 2-10-7-6 10-1Zm170-10 3 7 8 1-6 5 1 8-6-4-7 4 1-8-5-5 8-1Z"/></g>
    </svg>
  </div>;
}
