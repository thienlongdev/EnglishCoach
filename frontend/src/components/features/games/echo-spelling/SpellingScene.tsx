'use client';
import {useEffect,useRef,useState,type RefObject} from 'react';
import * as T from 'three';
import {GLTFLoader,type GLTF} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {ArenaCharacter} from '@/components/features/speaking/arena/ArenaCharacter';
import {arenaCast} from '@/components/features/speaking/arena/arenaAssets';
import {ArenaMotor,ArenaMotion,STEP,type ArenaSurface} from '@/components/features/speaking/arena/arenaMotion';
import {ScenePassage} from '@/lib/morph/scene';
import {theaterAtmosphere} from './theaterAtmosphere';
import {marineSchool} from './marineSchool';
import {contactAudioContext,footstep} from '@/lib/embodiment/contactAudio';
import type {ArenaPlayer} from '@/types/speakingArena';
import type {SpellingState,SpellingPlayer} from '@/types/spelling';
import styles from './spelling.module.css';

const surface:ArenaSurface={floor:()=>0,step:(_x,_z,x,z)=>({x:T.MathUtils.clamp(x,-10.5,10.5),z:T.MathUtils.clamp(z,1,8.2)})};
const peerSurface:ArenaSurface={floor:()=>0,step:(_x,_z,x,z)=>({x:T.MathUtils.clamp(x,-10.5,10.5),z:T.MathUtils.clamp(z,-3,8.2)})};
const asArena=(p:SpellingPlayer):ArenaPlayer=>({...p,team:p.hero==='LYRA'?0:1,moderated:false,canSpeak:false,voiceIdentity:'',gesture:'IDLE'});
interface Props {state:SpellingState|null;typed:RefObject<string>;hero:'LYRA'|'KAI';look:string;vi:boolean;low:boolean;blocked:boolean;connected:boolean;touch:RefObject<{x:number;z:number;jump:boolean}>;move:(x:number,z:number,yaw:number,jump:boolean)=>void;onStats:(stats:{fps:number;draws:number;triangles:number})=>void;onReady:(ready:boolean)=>void}

/** One Three renderer. The theatre is Blender-authored; characters, motor, interpolation and springs are shared with Arena. */
export default function SpellingScene(props:Props){
  const host=useRef<HTMLDivElement>(null),live=useRef(props);live.current=props;
  const [loading,setLoading]=useState(true),[error,setError]=useState(false);
  useEffect(()=>{
    const el=host.current;if(!el)return;
    let renderer:T.WebGLRenderer;
    try{renderer=new T.WebGLRenderer({antialias:true,powerPreference:'high-performance'});}catch{setError(true);return;}
    renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
    renderer.setPixelRatio(Math.min(devicePixelRatio,props.low?1:1.6));renderer.shadowMap.enabled=!props.low;renderer.shadowMap.type=T.PCFShadowMap;
    el.append(renderer.domElement);renderer.domElement.tabIndex=0;renderer.domElement.setAttribute('aria-label',props.vi?'Nhà hát Echo Spelling 3D. WASD di chuyển, Shift chạy, Space nhảy.':'Echo Spelling 3D theatre. WASD moves, Shift runs, Space jumps.');
    const scene=new T.Scene();scene.background=new T.Color('#06152a');scene.fog=new T.FogExp2('#0b2644',.018);
    const camera=new T.PerspectiveCamera(46,1,.1,140);camera.position.set(3.4,5.8,13.4);
    const focus=new T.Vector3(0,3,-4),desired=new T.Vector3(),lookAt=new T.Vector3();
    const pmrem=new T.PMREMGenerator(renderer),envScene=new RoomEnvironment(),env=pmrem.fromScene(envScene,.05);scene.environment=env.texture;scene.environmentIntensity=.32;envScene.dispose();pmrem.dispose();
    scene.add(new T.HemisphereLight('#74c9f2','#261247',.75));
    const key=new T.DirectionalLight('#fff0d1',2.1);key.position.set(1,12,7);key.castShadow=!props.low;key.shadow.mapSize.set(2048,2048);key.shadow.camera.left=-14;key.shadow.camera.right=14;key.shadow.camera.top=14;key.shadow.camera.bottom=-14;key.shadow.camera.far=45;key.shadow.normalBias=.035;scene.add(key);
    const rim=new T.DirectionalLight('#7774ff',2.6);rim.position.set(-8,6,-10);scene.add(rim);
    const fill=new T.PointLight('#44dcff',110,22,2);fill.position.set(5,4,-2);scene.add(fill);
    const spot=new T.SpotLight('#ffe7b0',170,25,.48,.7,1.4);spot.position.set(-3,10,1);spot.target.position.set(0,0,-2.8);scene.add(spot,spot.target);
    const atmosphere=theaterAtmosphere(scene),stepPhase=new Map<string,number>();let recordMatch='';
    const loader=new GLTFLoader(),templates=new Map<string,GLTF>(),characters=new Map<string,ArenaCharacter>(),characterHeroes=new Map<string,string>();
    const motion=new ArenaMotion(peerSurface),keys=new Set<string>(),passage=new ScenePassage(true);
    let disposed=false,raf=0,last=performance.now(),elapsed=0,frames=0,statsAt=last,room='',lastServer=0,motor:ArenaMotor|null=null,acc=0,sequenceAck=-1,lastMove=0,lastResult=0;
    let orbit=0,drag:number|null=null,previousX=0,previousY=0,pitch=0,quality=props.low?1:1.6,slow=0;
    const reduced=matchMedia('(prefers-reduced-motion: reduce)');
    const canvas=document.createElement('canvas');canvas.width=1536;canvas.height=640;const ctx=canvas.getContext('2d')!;
    const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;texture.minFilter=T.LinearFilter;texture.generateMipmaps=false;
    const board=new T.Mesh(new T.PlaneGeometry(10.65,4.36),new T.MeshBasicMaterial({map:texture,toneMapped:false}));board.position.set(0,4.15,-6.57);scene.add(board);
    const font=getComputedStyle(document.body).fontFamily;let boardKey='';
    const drawBoard=(s:SpellingState|null,now:number)=>{
      const turn=s?.turn,player=s?.players.find(p=>p.id===turn?.player),own=turn?.player===s?.self;
      const value=s?.phase==='SPELL'?(own?live.current.typed.current:turn?.typed??''):s?.result?.answer??'';
      const remaining=turn?.deadline?Math.max(0,(turn.deadline-now)/1000):0;
      const stamp=[s?.phase,turn?.id,value,player?.name,player?.streak,Math.ceil(remaining*10),s?.winner,live.current.vi].join('|');
      if(stamp===boardKey)return;boardKey=stamp;
      const g=ctx.createLinearGradient(0,0,1536,640);g.addColorStop(0,'#ffffff');g.addColorStop(.36,'#e7f3f7');g.addColorStop(.72,'#f4f0fc');g.addColorStop(1,'#dceef4');ctx.fillStyle=g;ctx.fillRect(0,0,1536,640);
      ctx.strokeStyle='#ffffff';ctx.lineWidth=12;ctx.strokeRect(8,8,1520,624);ctx.strokeStyle='#a5c5d4';ctx.lineWidth=2;ctx.strokeRect(20,20,1496,600);
      const sheen=ctx.createLinearGradient(0,0,1536,360);sheen.addColorStop(0,'#ffffff88');sheen.addColorStop(.5,'#ffffff00');sheen.addColorStop(1,'#ffffff55');ctx.fillStyle=sheen;ctx.fillRect(0,0,1536,640);
      ctx.textAlign='left';ctx.fillStyle='#47748a';ctx.font=`600 28px ${font}`;ctx.fillText('E C H O   S P E L L I N G',64,70);
      ctx.textAlign='right';ctx.fillStyle='#8a642d';ctx.fillText(s?`${live.current.vi?'VÒNG':'ROUND'} ${s.round}`:'ECHO OCEAN',1470,70);
      ctx.textAlign='center';ctx.fillStyle='#193c59';ctx.font=`700 46px ${font}`;
      const terminal=s&&['FINISHED','ABORTED'].includes(s.phase),winner=s?.players.find(p=>p.id===s.winner);
      let title=player?.name??'';
      if(terminal)title=s.phase==='ABORTED'?(live.current.vi?'Lượt chơi đã kết thúc':'Run ended'):winner?.name??(live.current.vi?'Thử thách hoàn thành':'Challenge complete');
      ctx.fillText(title.slice(0,32),768,155);
      ctx.font=`700 ${value.length>18?66:108}px ${font}`;ctx.fillStyle=s?.result?(s.result.correct?'#17756b':'#a04c44'):'#204967';
      let center=value||({HEAR:live.current.vi?'Lắng nghe…':'Listen…',APPROACH:live.current.vi?'Đến micro':'To the microphone',COUNTDOWN:live.current.vi?'Sẵn sàng…':'Get ready…',LOBBY:'ECHO SPELLING'} as Record<string,string>)[s?.phase??'LOBBY']||'…';
      if(terminal)center=s.winner?(live.current.vi?'NHÀ VÔ ĐỊCH':'CHAMPION'):(s.result?.answer??'ECHO SPELLING');
      ctx.fillText(center,768,327,1400);
      ctx.strokeStyle='#a2c8d6';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(180,375);ctx.lineTo(1356,375);ctx.stroke();
      ctx.font=`700 44px ${font}`;ctx.fillStyle='#416e86';
      const speed=turn?.openedAt&&value?Math.round(value.length*12000/Math.max(250,now-turn.openedAt)):0;
      if(turn){ctx.fillText(`${live.current.vi?'CHUỖI':'STREAK'}  ${player?.streak??0}`,350,475);ctx.fillText(`${s?.result?.wpm??speed}  WPM`,1150,475);}
      ctx.font=`700 72px ${font}`;ctx.fillStyle=remaining>0&&remaining<5?'#b64b3d':'#987137';
      if(s)ctx.fillText(s.phase==='SPELL'?(turn?.deadline?`${remaining.toFixed(1)}s`:'∞'):'◉',768,490);
      texture.needsUpdate=true;
    };
    // Bounded underwater atmosphere: one instanced shoal, one particle draw, no extra render target.
    const count=180,points=new Float32Array(count*3);for(let i=0;i<count;i++){points[i*3]=Math.sin(i*2.399)*25;points[i*3+1]=(i%37)*.37;points[i*3+2]=-15+Math.cos(i*1.73)*20;}
    const dustGeo=new T.BufferGeometry();dustGeo.setAttribute('position',new T.BufferAttribute(points,3));
    const dustMat=new T.PointsMaterial({color:'#94dcfa',size:.045,transparent:true,opacity:.5,depthWrite:false});const dust=new T.Points(dustGeo,dustMat);scene.add(dust);
    const school=marineSchool(scene,loader),dummy=new T.Object3D();void school.ready.catch(()=>{if(!disposed)setError(true);});
    const confettiGeo=new T.PlaneGeometry(.07,.14),confettiMat=new T.MeshStandardMaterial({color:'#f4c46c',metalness:.6,roughness:.25,side:T.DoubleSide});const confetti=new T.InstancedMesh(confettiGeo,confettiMat,180);scene.add(confetti);confetti.visible=false;
    const resources:T.Object3D[]=[];
    const disposeObject=(root:T.Object3D)=>{const textures=new Set<T.Texture>();root.traverse(o=>{const m=o as T.Mesh;if(m.isMesh){m.geometry.dispose();for(const material of Array.isArray(m.material)?m.material:[m.material]){for(const value of Object.values(material))if(value instanceof T.Texture)textures.add(value);material.dispose();}}});textures.forEach(t=>t.dispose());};
    const load=async()=>{
      const [world,lyra,kai]=await Promise.all([loader.loadAsync('/games/echo-spelling/theater-f48d11e84be4.glb'),loader.loadAsync(arenaCast.LYRA),loader.loadAsync(arenaCast.KAI)]);
      if(disposed){[world,lyra,kai].forEach(g=>disposeObject(g.scene));return;}
      world.scene.traverse(o=>{const m=o as T.Mesh;if(m.isMesh){m.castShadow=true;m.receiveShadow=true;}});scene.add(world.scene);resources.push(world.scene);
      templates.set('LYRA',lyra);templates.set('KAI',kai);setLoading(false);live.current.onReady(true);
    };
    void load().catch(()=>{if(!disposed)setError(true);});
    const resize=()=>{const w=el.clientWidth,h=el.clientHeight;renderer.setSize(w,h,false);camera.aspect=w/Math.max(1,h);camera.fov=camera.aspect<.8?50:46;camera.updateProjectionMatrix();};const observer=new ResizeObserver(resize);observer.observe(el);resize();
    const editing=()=>{const e=document.activeElement;return e instanceof HTMLElement&&(e.matches('input,textarea,select,[contenteditable="true"]')||!!e.closest('[role="dialog"],[role="alertdialog"]'));};
    const down=(e:KeyboardEvent)=>{if(editing()||live.current.blocked)return;if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','Space'].includes(e.code)){e.preventDefault();contactAudioContext();keys.add(e.code);if(e.code==='Space'&&!e.repeat)motor?.requestJump();}};
    const up=(e:KeyboardEvent)=>keys.delete(e.code);const blur=()=>{keys.clear();drag=null;};
    const pointer=(e:PointerEvent)=>{if(editing())return;drag=e.pointerId;previousX=e.clientX;previousY=e.clientY;renderer.domElement.setPointerCapture(e.pointerId);renderer.domElement.focus({preventScroll:true});};
    const pointerMove=(e:PointerEvent)=>{if(drag!==e.pointerId)return;orbit=T.MathUtils.clamp(orbit+(e.clientX-previousX)*.003,-.6,.6);pitch=T.MathUtils.clamp(pitch+(e.clientY-previousY)*.004,-1,2);previousX=e.clientX;previousY=e.clientY;};
    const onVisibility=()=>{if(disposed)return;if(document.hidden){keys.clear();drag=null;if(raf){cancelAnimationFrame(raf);raf=0;}}else if(!raf){last=performance.now();raf=requestAnimationFrame(render);}};
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur);document.addEventListener('visibilitychange',onVisibility);renderer.domElement.addEventListener('pointerdown',pointer);renderer.domElement.addEventListener('pointermove',pointerMove);renderer.domElement.addEventListener('pointerup',blur);
    const render=(stamp:number)=>{
      if(disposed||document.hidden){raf=0;keys.clear();return;}raf=requestAnimationFrame(render);
      // ecctrl TimeControl reference: clamp resume delta before fixed-step accumulation.
      const dt=Math.min(1/30,Math.max(0,(stamp-last)/1000));last=stamp;elapsed+=dt;frames++;
      const p=live.current,s=p.state,serverNow=s?s.serverTime+Math.max(0,stamp-lastServer):Date.now();
      if(s&&s.serverTime!==lastServerSeen){lastServerSeen=s.serverTime;lastServer=stamp;motion.ingest(s.roomId,s.serverTime,s.players,stamp);}
      const clockNow=s?s.serverTime+stamp-lastServer:serverNow;
      if((s?.roomId??'')!==room){room=s?.roomId??'';motor=null;sequenceAck=-1;motion.reset(room);keys.clear();}
      const preview:SpellingPlayer={id:'preview',userId:0,name:'Echo',hero:p.hero,look:p.look,online:true,ready:false,eliminated:false,spectator:false,returning:false,x:2.5,z:-1,yaw:.15,sequence:0,sampledAt:stamp,jumpAt:0,jumpFloor:0,score:0,correct:0,wrong:0,streak:0,maxStreak:0,highestWpm:0,integrity:'PRACTICE'};
      const players=s?.players??[preview];const own=s?.players.find(x=>x.id===s.self);
      const controlled=!!own&&!own.returning&&own.id!==s?.turn?.player&&!['FINISHED','ABORTED'].includes(s?.phase??'')&&!p.blocked&&p.connected&&!editing();
      if(own&&!motor){motor=new ArenaMotor(own.x,own.z,0,surface);sequenceAck=own.sequence;}
      if(own&&motor&&own.sequence>sequenceAck){sequenceAck=own.sequence;
        const error=Math.hypot(own.x-motor.x,own.z-motor.z);if(error>1.8){motor.x=own.x;motor.z=own.z;motor.previous.x=own.x;motor.previous.z=own.z;}}
      if(controlled&&motor){
        let x=(keys.has('KeyD')||keys.has('ArrowRight')?1:0)-(keys.has('KeyA')||keys.has('ArrowLeft')?1:0)+p.touch.current.x;
        let z=(keys.has('KeyS')||keys.has('ArrowDown')?1:0)-(keys.has('KeyW')||keys.has('ArrowUp')?1:0)+p.touch.current.z;
        const len=Math.max(1,Math.hypot(x,z)),speed=keys.has('ShiftLeft')?3.35:1.65;x=x/len*speed;z=z/len*speed;
        if(p.touch.current.jump){motor.requestJump();p.touch.current.jump=false;}
        acc=Math.min(acc+dt,.1);while(acc>=STEP){motor.step(x,z);acc-=STEP;}
        if(stamp-lastMove>=100){p.move(motor.x,motor.z,Math.hypot(x,z)>.1?Math.atan2(x,z):own.yaw,motor.jumped);motor.jumped=false;lastMove=stamp;}
      }else if(own&&motor){motor.x=own.x;motor.z=own.z;motor.y=0;motor.previous={x:own.x,y:0,z:own.z};keys.clear();}
      for(const person of players){
        let c=characters.get(person.id);if(c&&characterHeroes.get(person.id)!==person.hero){scene.remove(c.root);c.dispose();characters.delete(person.id);c=undefined;}
        const template=templates.get(person.hero);if(!c&&template){c=new ArenaCharacter(template,person.hero==='LYRA'?0:1,person.hero);c.root.position.set(person.x,0,person.z);c.root.rotation.y=person.yaw;c.resetPosition();characters.set(person.id,c);characterHeroes.set(person.id,person.hero);scene.add(c.root);}
        if(!c)continue;c.dress(person.hero,person.look);
        let pose=motion.sample(person.id,stamp)??{x:person.x,y:0,z:person.z,yaw:person.yaw,airborne:false};
        if(person.id===own?.id&&controlled&&motor){const a=acc/STEP;pose={x:T.MathUtils.lerp(motor.previous.x,motor.x,a),y:T.MathUtils.lerp(motor.previous.y,motor.y,a),z:T.MathUtils.lerp(motor.previous.z,motor.z,a),yaw:Math.hypot(motor.x-motor.previous.x,motor.z-motor.previous.z)>.001?Math.atan2(motor.x-motor.previous.x,motor.z-motor.previous.z):c.root.rotation.y,airborne:!motor.grounded};}
        c.root.position.set(pose.x,pose.y,pose.z);c.root.rotation.y+=Math.atan2(Math.sin(pose.yaw-c.root.rotation.y),Math.cos(pose.yaw-c.root.rotation.y))*(1-Math.exp(-dt*12));
        const terminal=s?.phase==='FINISHED';c.update(dt,asArena(person),person.id===s?.turn?.player&&s?.phase==='SPELL',!!terminal||person.eliminated,s?.winner===person.id,reduced.matches,undefined,0,pose.airborne);
        const beat=Math.floor(c.stridePhase/Math.PI),oldBeat=stepPhase.get(person.id);stepPhase.set(person.id,beat);
        if(oldBeat!==undefined&&oldBeat!==beat&&!pose.airborne&&(c.locomotion==='Walk'||c.locomotion==='Run')&&s?.phase!=='HEAR')footstep('stone',person.id===own?.id?.18:.07);
        if(person.id===s?.turn?.player&&s?.phase==='HEAR'&&lastPhase!==s.phase)c.express('listen');
        if(person.id===s?.turn?.player&&s?.phase==='SPELL'&&lastPhase!==s.phase)c.express('inspect');
        if(s?.result&&s.result.at!==lastResult)c.express(s.result.correct?'clap':'listen');
      }
      if(s?.result)lastResult=s.result.at;lastPhase=s?.phase??'';
      for(const [id,c] of characters)if(!players.some(x=>x.id===id)){scene.remove(c.root);c.dispose();characters.delete(id);}
      const isLobby=!s||s.phase==='LOBBY';
      desired.set(isLobby?3.4:Math.sin(orbit)*10.5,isLobby?5.8:3.45+pitch,isLobby?13.4:Math.cos(orbit)*10.5);
      desired.z*=Math.max(1,.95/camera.aspect);
      lookAt.set(0,isLobby?3.2:2.65,-4);const settle=passage.update(dt,reduced.matches);desired.z+=settle*2;
      camera.position.lerp(desired,1-Math.exp(-dt*2.4));focus.lerp(lookAt,1-Math.exp(-dt*3));camera.lookAt(focus);
      drawBoard(s,clockNow);
      if(s?.newRecords.length&&s.matchId!==recordMatch){recordMatch=s.matchId;atmosphere.record(elapsed);}atmosphere.update(elapsed,reduced.matches);
      if(!reduced.matches)dust.rotation.y=elapsed*.008;school.update(elapsed,reduced.matches);
      confetti.visible=s?.phase==='FINISHED'&&!reduced.matches;
      if(confetti.visible){for(let i=0;i<180;i++){const a=i*2.399;dummy.position.set(Math.sin(a)*6,8-((elapsed*.9+i*.073)%8),-3+Math.cos(a)*4);dummy.rotation.set(elapsed+i,a,elapsed*.7);dummy.scale.setScalar(1);dummy.updateMatrix();confetti.setMatrixAt(i,dummy.matrix);}confetti.instanceMatrix.needsUpdate=true;}
      if(stamp-statsAt>2000){const fps=frames*1000/(stamp-statsAt);p.onStats({fps:Math.round(fps),draws:renderer.info.render.calls,triangles:renderer.info.render.triangles});frames=0;statsAt=stamp;
        slow=fps<28?slow+1:0;if(slow>=2&&quality>1){quality=1;renderer.setPixelRatio(1);slow=0;}}
      const targetDpr=p.low?1:quality;if(renderer.getPixelRatio()!==Math.min(devicePixelRatio,targetDpr))renderer.setPixelRatio(Math.min(devicePixelRatio,targetDpr));
      renderer.render(scene,camera);
    };
    let lastServerSeen=0,lastPhase='';if(!document.hidden)raf=requestAnimationFrame(render);
    return()=>{disposed=true;if(raf){cancelAnimationFrame(raf);raf=0;}observer.disconnect();window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',onVisibility);renderer.domElement.removeEventListener('pointerdown',pointer);renderer.domElement.removeEventListener('pointermove',pointerMove);renderer.domElement.removeEventListener('pointerup',blur);characters.forEach(c=>{scene.remove(c.root);c.dispose();});characters.clear();templates.forEach(g=>disposeObject(g.scene));templates.clear();resources.forEach(disposeObject);resources.length=0;atmosphere.dispose();school.dispose();board.geometry.dispose();board.material.dispose();texture.dispose();canvas.width=0;canvas.height=0;dustGeo.dispose();dustMat.dispose();confettiGeo.dispose();confettiMat.dispose();env.texture.dispose();env.dispose();renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove();};
  },[]);
  return <div ref={host} className={styles.scene} data-testid="spelling-scene">{loading&&!error&&<div className={styles.sceneMessage}>{props.vi?'Đang mở nhà hát dưới đại dương…':'Opening the ocean theatre…'}</div>}{error&&<div className={styles.sceneMessage} role="alert">{props.vi?'Chưa tải được cảnh 3D. Hãy tải lại trang.':'The 3D scene could not load. Please reload.'}</div>}</div>;
}
