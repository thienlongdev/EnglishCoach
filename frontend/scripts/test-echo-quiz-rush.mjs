import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
// The game modules use bundler-style extensionless relative imports; resolve them to their .ts files here.
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch (e) { if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(specifier + '.ts', context); throw e; } } });
const { createRush, stepRush, resolveGate, pauseRush, resumeRush, gateCenter, gateAt, ROAD, frameStats, SKYBOUND, skyboundWalls, momentum, wallAt, segmentStart, finishLine, boundary } = await import('../src/components/features/games/echo-quiz-rush/rushModel.ts');
const T = await import('../src/components/features/games/echo-quiz-rush/rushTrials.ts');
const R = await import('../src/components/features/games/echo-quiz-rush/rushReforged.ts');
import {wrapGateText,racerColor} from '../src/components/features/games/echo-quiz-rush/rushPresentation.ts';
import {animateRunner,createRunnerMotion} from '../src/components/features/games/echo-quiz-rush/rushAnimation.ts';
let groups=0;
const check=(name,run)=>{run();groups++;console.log('PASS',name);};
const input=()=>({horizontal:0,sprint:false,dash:false,rush:false,target:null});
const running=(gates=3)=>{const s=createRush(3,0,gates);s.phase='RUNNING';return s;};
const advance=(s,i,seconds,hz=120)=>{for(let n=0;n<seconds*hz;n++)stepRush(s,i,1/hz);};
check('forward integration and refresh rates',()=>{
  const positions=[30,60,120].map(hz=>{const s=running();advance(s,input(),4,hz);return s.y;});
  assert(Math.max(...positions)-Math.min(...positions)<4);
});
check('continuous steering, acceleration, boundaries and target crossing',()=>{
  const s=running(),i=input();i.horizontal=-1;advance(s,i,3);assert.equal(s.x,ROAD.left+ROAD.radius);
  i.horizontal=1;advance(s,i,3);assert.equal(s.x,ROAD.right-ROAD.radius);
  i.target=gateCenter(0,4);advance(s,i,3);assert(Math.abs(s.x-i.target)<6);assert.equal(gateAt(s.x,4),0);
});
check('sprint bounded cost, recovery and dash cooldown',()=>{
  const s=running(),i=input();i.sprint=true;advance(s,i,2);assert(s.stamina<41&&s.speed>200);
  i.sprint=false;advance(s,i,1);assert(s.stamina>50);i.dash=true;stepRush(s,i,1/120);assert(s.dashCooldown>3.9);assert(s.dashTime>0);
  const time=s.dashCooldown;stepRush(s,i,1/120);assert(s.dashCooldown<time);
});
check('two/three/four gate swept collisions cannot be skipped by abilities',()=>{
  for(const count of [2,3,4])for(const skill of ['sprint','dash','rush']){
    const s=running(count),i=input();s.x=gateCenter(0,count);s.y=ROAD.spacing-30;s.rushEnergy=100;i[skill]=true;
    for(let n=0;n<20&&s.phase==='RUNNING';n++)stepRush(s,i,.1);
    assert.equal(s.phase,'VALIDATING');assert.equal(s.y,ROAD.spacing-ROAD.radius);assert.equal(s.checkpoint,0);
  }
});
check('physical gateposts block movement without educational submission',()=>{
  for(const count of [2,3,4]){const s=running(count);s.x=ROAD.left+(ROAD.right-ROAD.left)/count;s.y=ROAD.spacing-30;const i=input();i.dash=true;
    let event=null;for(let n=0;n<20&&!event;n++)event=stepRush(s,i,.1);assert.equal(event,'POST');assert.equal(s.phase,'STUMBLE');assert.equal(s.checkpoint,0);assert.equal(s.rushEnergy,0);}
});
check('wrong gates recover without progress or energy and correct gates physically open first',()=>{
  const s=running();s.y=ROAD.spacing-ROAD.radius;s.phase='VALIDATING';s.selected=1;resolveGate(s,false);assert.equal(s.phase,'STUMBLE');assert.equal(s.rushEnergy,0);
  advance(s,input(),.8);assert.equal(s.phase,'RUNNING');assert.equal(s.checkpoint,0);
  s.phase='VALIDATING';s.y=ROAD.spacing-ROAD.radius;resolveGate(s,true);assert.equal(s.phase,'OPENING');assert.equal(s.openGate,1);assert.equal(s.rushEnergy,34);
  const y=s.y;advance(s,input(),.4);assert.equal(s.y,y);assert.equal(s.checkpoint,0);
  advance(s,input(),2);assert.equal(s.checkpoint,1);assert.equal(s.phase,'RUNNING');
  const energy=s.rushEnergy;resolveGate(s,true);assert.equal(s.rushEnergy,energy);
});
check('pause, server response while paused and terminal refresh',()=>{
  const s=running();pauseRush(s);const y=s.y;advance(s,input(),2);assert.equal(s.y,y);resumeRush(s);assert.equal(s.phase,'RUNNING');
  s.phase='VALIDATING';pauseRush(s);resolveGate(s,true);assert.equal(s.phase,'PAUSED');assert.equal(s.previousPhase,'OPENING');resumeRush(s);assert.equal(s.phase,'OPENING');
  const done=createRush(3,3);advance(done,input(),8);assert.equal(done.phase,'FINISHED');assert.equal(done.y,3*ROAD.spacing+ROAD.finishOffset);
});
check('maximum boost still leaves reaction and cross-road travel time',()=>{
  const travel=(ROAD.right-ROAD.left-2*ROAD.radius)/ROAD.horizontal+.08;
  assert((ROAD.spacing-ROAD.radius)/330>travel+.8);
});
check('Echo Rush earned energy and one bounded activation',()=>{
  const s=running(),i=input();i.rush=true;stepRush(s,i,.1);assert.equal(s.rushTime,0);
  s.rushEnergy=100;stepRush(s,i,.1);assert.equal(s.rushEnergy,0);assert.equal(s.rushTime,3);stepRush(s,i,.1);assert(s.rushTime<3);
});
check('frame percentiles report tails',()=>{const stats=frameStats([...Array(98).fill(16.7),50,120]);assert.equal(stats.worst,120);assert.equal(stats.over50,1);assert.equal(stats.p99,120);});
check('new integration preserves guarded entry and does not expose answers in production scene',()=>{
  const root=new URL('../',import.meta.url),read=p=>readFileSync(new URL(p,root),'utf8');
  assert(read('src/app/games/echo-quiz-rush/page.tsx').includes('AuthGuard'));
  assert(read('src/components/features/games/GamesHub.tsx').includes('/games/echo-quiz-rush'));
  assert(read('src/services/quizRushApi.ts').includes('apiClient'));
  assert(!read('src/components/features/games/echo-quiz-rush/RushScene.tsx').includes('answerId'));
  const source=read('src/components/features/games/echo-quiz-rush/RushGame.tsx');assert(!source.includes('Sparkles'));
  const audio=read('src/components/features/games/echo-quiz-rush/rushAudio.ts');assert(audio.includes('echo-quiz-rush:audio-v1'));assert(audio.includes('AudioContext'));
  const scene=read('src/components/features/games/echo-quiz-rush/RushScene.tsx');assert(scene.includes('passedGates'));assert(scene.includes('SkyWorld'));
  for(const f of ['skyWorld','skyGates','skyRunner','skyTrack','skyEnvironment','skyEffects','skyEcho','skyScale'])assert(!read(`src/components/features/games/echo-quiz-rush/sky/${f}.ts`).includes('answerId'),f);
  for(const f of ['RushGame.tsx','RushCompetitiveGame.tsx','RushHud.tsx','RushAttract.tsx'])assert(!read(`src/components/features/games/echo-quiz-rush/${f}`).includes('Sparkles'),f);
});
check('full labels wrap without lost characters or horizontal compression',()=>{
 for(const text of ['evnelope','envelope','it happens to the best of us','extraordinarilylongword'])for(const width of [40,64,120]){const lines=wrapGateText(text,width,t=>t.length*8);assert.equal(lines.join('').replaceAll(' ',''),text.replaceAll(' ',''));assert(lines.every(l=>l.length*8<=width));}
});
check('question preview and fully readable choices have independent speed bounds',()=>{
 assert((ROAD.spacing-65-ROAD.reveal)/330>=2.5);
 assert((ROAD.readable-ROAD.radius)/330>=4);
 for(const spacing of [1100,2800,3700]){const s=createRush(8,3,4,spacing);assert.equal(s.y,3*spacing);s.phase='RUNNING';s.y=4*spacing-30;s.x=gateCenter(1,4);stepRush(s,input(),.1);assert.equal(s.y,4*spacing-26);}
});
check('recoil is continuous, monotonic and remains behind the closed plane',()=>{
 const s=running();s.y=ROAD.spacing-ROAD.radius;s.phase='VALIDATING';s.selected=0;const start=s.y;resolveGate(s,false);assert.equal(s.y,start);
 let previous=s.y;for(let i=0;i<38;i++){stepRush(s,input(),1/120);assert(s.y<=previous&&previous-s.y<3);assert(s.y<=start);previous=s.y;}
 advance(s,input(),.02);assert.equal(s.y,ROAD.spacing-95);
 assert.equal(new Set(['p1','p2','p3','p4','p5'].map(racerColor)).size,5);
});
check('modestly faster ordinary speed matches authority without changing burst bounds',()=>{
 assert.equal(ROAD.speed,153);assert.equal((ROAD.speed-144)/144,.0625);const s=running();advance(s,input(),2);assert(s.speed>152&&s.speed<=153);assert(s.y>297&&s.y<306);
 const authority=readFileSync(new URL('../../backend/src/main/java/com/englishcoach/quizrush/RushCompetition.java',import.meta.url),'utf8');
 assert(authority.includes('BASE_SPEED=153'));assert(authority.includes('sprint?210:BASE_SPEED'));
});
check('stride groups supporting feet, stops at gates and resists reconciliation jumps',()=>{
 const m=createRunnerMotion(0),sequence=[];let y=0;
 for(let i=0;i<80;i++){y+=153/120;const p=animateRunner(m,y,0,153,'RUNNING',i/120,1/120,false);if(sequence.at(-1)!==p.col)sequence.push(p.col);assert(p.lift>=0&&p.lift<=.009);}
 assert.deepEqual(sequence.slice(0,6),[0,2,4,1,3,5]);
 const stride=m.stride;animateRunner(m,y-69,0,0,'STUMBLE',.2,1/120,false);assert.equal(m.stride,stride);
 animateRunner(m,y-69,0,0,'VALIDATING',.1,1/120,false);assert.equal(m.stride,stride);
 const before=m.stride;animateRunner(m,y+2000,0,330,'RUNNING',1,1/120,false);assert((m.stride-before+1)%1<.03);
});
check('run presentation has bounded cadence, smooth steering and reduced motion',()=>{
 for(const speed of [95,153,210,255,330]){const m=createRunnerMotion(0);let y=0,previous=0;
  for(let i=0;i<120;i++){y+=speed/120;const p=animateRunner(m,y,430,speed,'RUNNING',i/120,1/120,false);assert(Math.abs(p.bank-previous)<.004);previous=p.bank;assert(p.bank<=.035);}
  const p=animateRunner(m,y+speed/120,430,speed,'RUNNING',1,1/120,true);assert.equal(p.bank,0);assert.equal(p.lift,0);
 }
});
const v4=(total=3,checkpoint=0,gates=3,walls=skyboundWalls(Array.from({length:total},()=>({prompt:'Choose the word.',context:'',options:[{label:'a'},{label:'b'}]}))))=>{const s=createRush(total,checkpoint,gates,2800,4,walls);s.phase='RUNNING';return s;};
const java=readFileSync(new URL('../../backend/src/main/java/com/englishcoach/quizrush/RushCompetition.java',import.meta.url),'utf8');
check('Skybound constants mirror the server authority exactly',()=>{
 const n=name=>Number(new RegExp(name+'=([0-9.]+)').exec(java)[1]);
 assert.equal(SKYBOUND.base,n('V4_BASE'));assert.equal(SKYBOUND.sprint,n('V4_SPRINT'));assert.equal(SKYBOUND.dash,n('V4_DASH'));assert.equal(SKYBOUND.dashTime,n('V4_DASH_TIME'));
 assert.equal(SKYBOUND.rush,n('V4_RUSH'));assert.equal(SKYBOUND.horizontal,n('V4_LATERAL'));assert.equal(SKYBOUND.momentumStep,n('MOMENTUM_STEP'));assert.equal(SKYBOUND.momentumCap,n('MOMENTUM_CAP'));
 assert(java.includes('Math.max(1700,Math.min(4200,1200+80.0*words))'));assert(java.includes('public static final int SKYBOUND=4;'));
});
check('reading segments: per-question length, cumulative walls and an anchored finish',()=>{
 const q=(prompt,context,...labels)=>({prompt,context,options:labels.map(label=>({label}))});
 const walls=skyboundWalls([q('Choose the correctly spelled word.','','lose','lsoe'),q('Choose the verb that agrees with the subject.','The old photographs in the drawer that my grandmother kept for decades still ___ the quiet summers we spent at the lake house together.','remind','reminds','reminding','reminded'),q('Pick one.','','a','b')]);
 assert.equal(walls[0],1200+80*7);assert.equal(walls[2]-walls[1],1700);assert(walls[1]-walls[0]>1500&&walls[1]-walls[0]<=4200);
 const s=createRush(3,2,2,2800,4,walls);assert.equal(s.y,walls[1]);assert.equal(segmentStart(s,2),walls[1]);assert.equal(boundary(s),walls[2]);assert.equal(finishLine(s),walls[2]+ROAD.finishOffset);
 const legacy=createRush(3,1,3,2800,3,walls);assert.equal(boundary(legacy),5600);assert.equal(legacy.y,2800);
});
check('momentum: earned streak speeds the runner, capped, never on legacy courses',()=>{
 const s=v4();assert.equal(momentum(s),1);advance(s,input(),2);assert(Math.abs(s.speed-SKYBOUND.base)<1);
 s.streak=3;advance(s,input(),1);assert(Math.abs(s.speed-SKYBOUND.base*1.12)<1);s.streak=99;assert.equal(momentum(s),1+SKYBOUND.momentumStep*SKYBOUND.momentumCap);
 const old=running();old.streak=5;assert.equal(momentum(old),1);advance(old,input(),2);assert(old.speed<=153);
 const r=v4();r.phase='VALIDATING';r.selected=0;resolveGate(r,true,4);assert.equal(r.streak,4);r.phase='VALIDATING';resolveGate(r,false,0);assert.equal(r.streak,0);
});
check('Skybound bursts cannot skip a closed wall; dash lasts .25s',()=>{
 for(const count of [2,3,4])for(const skill of ['sprint','dash','rush']){
  const s=v4(3,0,count),i=input();s.streak=5;s.x=gateCenter(0,count);s.y=wallAt(s,0)-30;s.rushEnergy=100;i[skill]=true;
  for(let n=0;n<20&&s.phase==='RUNNING';n++)stepRush(s,i,.1);
  assert.equal(s.phase,'VALIDATING');assert.equal(s.y,wallAt(s,0)-ROAD.radius);
 }
 const s=v4(),i=input();i.dash=true;stepRush(s,i,1/120);assert(Math.abs(s.dashTime-(SKYBOUND.dashTime-1/120))<1e-9||s.dashTime<=SKYBOUND.dashTime);
});
check('every Skybound segment leaves reading time even at an unbroken full-momentum sprint',()=>{
 for(const words of [3,7,15,30,45]){const len=Math.max(1700,Math.min(4200,1200+80*words));const seconds=len/(SKYBOUND.sprint*(1+SKYBOUND.momentumStep*SKYBOUND.momentumCap));assert(seconds*2.8+.01>=Math.min(words,34),`${words} words`);}
 assert((1700-65)/(SKYBOUND.dash*(1+SKYBOUND.momentumStep*SKYBOUND.momentumCap))>2.5,'even a dash cannot cross a minimum segment in under 2.5 s');
});
check('3D world maps doors exactly onto the collision openings',()=>{
 const scale=readFileSync(new URL('../src/components/features/games/echo-quiz-rush/sky/skyScale.ts',import.meta.url),'utf8');
 assert(scale.includes("(spacing > 1100 ? .22 : .38)) * SCENE.kx"));assert(readFileSync(new URL('../src/components/features/games/echo-quiz-rush/rushModel.ts',import.meta.url),'utf8').includes('(s.spacing > 1100 ? .22 : .38) - ROAD.radius'));
 const gates=readFileSync(new URL('../src/components/features/games/echo-quiz-rush/sky/skyGates.ts',import.meta.url),'utf8');assert(gates.includes('doorHalfWidth(gates, spacing)'));
});
// ── Course version 5 "Skybound Trials" ──
const trialsJava=readFileSync(new URL('../../backend/src/main/java/com/englishcoach/quizrush/RushTrials.java',import.meta.url),'utf8');
const jn=name=>{const m=trialsJava.match(new RegExp(`[,\\s]${name}=([-\\d.]+)[,;]`));assert(m,`${name} in RushTrials.java`);return Number(m[1]);};
const ja=name=>{const m=trialsJava.match(new RegExp(`${name}=\\{([^}]*)\\}`));assert(m,`${name}[] in RushTrials.java`);return m[1].split(',').map(Number);};
check('Trials constants mirror RushTrials.java exactly',()=>{
 const t=T.TRIALS;
 const pairs={version:'VERSION',base:'BASE',sprint:'SPRINT',dash:'DASH',dashTime:'DASH_TIME',rush:'RUSH',lateral:'LATERAL',jumpSpeed:'JUMP_SPEED',gravity:'GRAVITY',jumpBuffer:'JUMP_BUFFER',jumpRecover:'JUMP_RECOVER',
  dodgeSpeed:'DODGE_SPEED',dodgeTime:'DODGE_TIME',dodgeCooldown:'DODGE_COOLDOWN',knockTime:'KNOCK_TIME',hitGuard:'HIT_GUARD',fallTime:'FALL_TIME',respawnGuard:'RESPAWN_GUARD',respawnBack:'RESPAWN_BACK',
  readPerWord:'READ_PER_WORD',readBase:'READ_BASE',readMin:'READ_MIN',readMax:'READ_MAX',leadIn:'LEAD_IN',runout:'RUNOUT',riseZone:'RISE_ZONE',riseWait:'RISE_WAIT',riseRate:'RISE_RATE',sillMax:'SILL_MAX',
  sillStep:'SILL_STEP',dropTime:'DROP_TIME',rearm:'REARM',kx:'KX',ky:'KY',rs:'RS',runnerHeight:'RUNNER_HEIGHT'};
 for(const [k,j] of Object.entries(pairs)) assert.equal(t[k],jn(j),k);
 assert.deepEqual([...T.LANES],ja('LANES'));
 assert.equal(T.MILL.arm,jn('MILL_ARM'));assert.equal(T.MILL.thick,jn('MILL_THICK'));assert.equal(T.MILL.top,jn('MILL_TOP'));assert.equal(T.MILL.pillar,jn('MILL_PILLAR'));assert.deepEqual([...T.MILL.spin],ja('MILL_SPIN'));
 assert.equal(T.RAMS.reach,jn('RAM_REACH'));assert.equal(T.RAMS.swing,jn('RAM_SWING'));assert.equal(T.RAMS.halfX,jn('RAM_HALF_X'));assert.equal(T.RAMS.halfY,jn('RAM_HALF_Y'));assert.equal(T.RAMS.low,jn('RAM_LOW'));assert.equal(T.RAMS.high,jn('RAM_HIGH'));assert.equal(T.RAMS.gap,jn('RAM_GAP'));assert.deepEqual([...T.RAMS.speed],ja('RAM_SPEED'));
 assert.equal(T.BOULDER.radius,jn('BOULDER_R'));assert.deepEqual([...T.BOULDER.speed],ja('BOULDER_SPEED'));assert.deepEqual([...T.BOULDER.every],ja('BOULDER_EVERY'));
 assert.equal(T.SKYFALL.radius,jn('FALL_RADIUS'));assert.equal(T.SKYFALL.warn,jn('FALL_WARN'));assert.equal(T.SKYFALL.before,jn('FALL_BEFORE'));assert.equal(T.SKYFALL.after,jn('FALL_AFTER'));assert.equal(T.SKYFALL.rowGap,jn('FALL_ROW_GAP'));assert.equal(T.SKYFALL.stagger,jn('FALL_STAGGER'));assert.deepEqual([...T.SKYFALL.period],ja('FALL_PERIOD'));
 assert.deepEqual([...T.CHASM.half],ja('CHASM_HALF'));assert.equal(T.CHASM.grace,jn('CHASM_GRACE'));assert.equal(T.CHASM.beamHalf,jn('BEAM_HALF'));
 for(const c of ['0x85ebca6b','0xc2b2ae35']) assert(trialsJava.toLowerCase().includes(c),'murmur constant '+c);
 assert(trialsJava.includes('0x9E3779B9'),'boulder lane constant');
 assert(Math.abs(t.base/SKYBOUND.base-1.06)<1e-9,'ordinary running speed is +6 % over v4');
});
const v5=(hazards=[],rising=[])=>{const walls=[5000,10000,15000];const s=createRush(3,0,3,ROAD.spacing,5,walls,hazards,rising);s.phase='RUNNING';return s;};
const fly=(s,seconds,i=input())=>{let maxZ=0;for(let n=0;n<seconds*120;n++){stepRush(s,i,1/120);i.jump=false;maxZ=Math.max(maxZ,s.z);}return maxZ;};
check('Trials jump: one buffered press, ~70 unit apex, ~0.72 s airtime, landing recovery',()=>{
 const s=v5();const i=input();i.jump=true;let t=0,up=false,landed=-1,maxZ=0;
 for(let n=0;n<240;n++){stepRush(s,i,1/120);i.jump=false;t+=1/120;maxZ=Math.max(maxZ,s.z);if(s.z>0)up=true;if(up&&s.z===0&&landed<0)landed=t;}
 assert.equal(s.jumps,1);assert(Math.abs(maxZ-T.apex())<2.5,`apex ${maxZ}`);assert(Math.abs(landed-2*T.TRIALS.jumpSpeed/T.TRIALS.gravity)<.03,`airtime ${landed}`);
 const j=input();j.jump=true;stepRush(s,j,1/120);assert(s.z>0,'a later press jumps again');
});
const chasm={kind:'CHASM',checkpoint:0,from:600,to:1120,tier:1,phase:0,dir:1,lane:-1,salt:7};
check('broken bridge: walking in falls, respawns behind it with temporary guard',()=>{
 const t=v5([chasm]);for(let n=0;n<1200&&t.phase!=='FALLING';n++)stepRush(t,input(),1/120);assert.equal(t.phase,'FALLING');assert.equal(t.falls,1);
 fly(t,T.TRIALS.fallTime+.02);assert.equal(t.phase,'RUNNING');assert(t.guard>T.TRIALS.respawnGuard-.1,'guard after respawn '+t.guard);
 assert(Math.abs(t.y-T.respawnY(chasm))<10,'respawned behind the gap '+t.y);
});
check('broken bridge: a timed jump or the beam lane crosses without falling',()=>{
 const s=v5([chasm]);const c=T.chasmCenter(chasm);while(s.y<c-90)stepRush(s,input(),1/120);fly(s,3,Object.assign(input(),{jump:true}));assert.equal(s.falls,0);
 const b=v5([{...chasm,lane:0}]);b.x=T.LANES[0];fly(b,4);assert.equal(b.falls,0);
});
check('Rune Mill: the beam knocks a grounded runner and passes under a jumping one',()=>{
 const mill={kind:'MILL',checkpoint:0,from:600,to:1220,tier:1,phase:0,dir:1,lane:-1,salt:3};const y=T.millCenter(mill);
 assert(T.hit(mill,0,600,y,0),'grounded runner on the arm is hit');assert.equal(T.hit(mill,0,600,y,T.MILL.top+1),null);
 assert.equal(T.hit(mill,0,600,y+400,0),null,'well clear of the arm');
});
check('rising gate: sill grows at the server rate, caps, holds while checked and drops',()=>{
 assert.equal(T.sill(-1,-1,0,-1,9),0);assert(Math.abs(T.sill(0,-1,0,-1,1)-T.TRIALS.riseRate)<1e-9);assert.equal(T.sill(0,-1,0,-1,99),T.TRIALS.sillMax);
 assert.equal(T.sill(0,-1,0,40,99),40,'held while the answer is checked');assert(Math.abs(T.sill(0,10,80,-1,10+T.TRIALS.dropTime/2)-40)<1e-9);
});
check('reading road: v5 segments keep reading time at full momentum sprint',()=>{
 const max=T.TRIALS.sprint*(1+SKYBOUND.momentumStep*SKYBOUND.momentumCap);
 for(const words of [3,7,15,30,45]){const len=Math.max(T.TRIALS.readMin,Math.min(T.TRIALS.readMax,T.TRIALS.readBase+T.TRIALS.readPerWord*words));const sec=len/max;assert(sec*2.8+.01>=Math.min(words,34),`${words} words: ${sec}s`);}
 assert(trialsJava.includes('READ_BASE+READ_PER_WORD*')||trialsJava.includes('READ_PER_WORD*'),'Java reading formula');
 const q={prompt:'Choose the word',context:'',options:[{label:'a'},{label:'b'}]};assert.equal(T.readingLength(q),T.TRIALS.readMin);
});
check('Trials 3D, skills, guide and audio stay presentation (no answer data, one input path)',()=>{
 const dir='../src/components/features/games/echo-quiz-rush/';
 for(const f of ['sky/skyHazards.ts','sky/skyCharacter.ts','sky/skyAssets.ts','sky/skyWorld.ts','sky/skyEnvironment.ts','sky/skyTrack.ts','sky/skyGates.ts']){const src=readFileSync(new URL(dir+f,import.meta.url),'utf8');assert(!/answerId|correctIndex|truth/.test(src),f);}
 const scene=readFileSync(new URL(dir+'RushScene.tsx',import.meta.url),'utf8');assert(scene.includes('handle.jump()')&&scene.includes('handle.dodge()'),'keys call the scene handle');
 const skills=readFileSync(new URL(dir+'rushSkills.tsx',import.meta.url),'utf8');assert(skills.includes('aria-disabled'));assert(!/Sparkles/.test(skills));
 const howto=readFileSync(new URL(dir+'RushHowTo.tsx',import.meta.url),'utf8');assert(howto.includes("'echo-quiz-rush:howto-v7'"));
 const audio=readFileSync(new URL(dir+'rushAudio.ts',import.meta.url),'utf8');assert(!/https?:\/\//.test(audio),'no downloaded audio');assert(audio.includes("'echo-quiz-rush:audio-v1'"));
 const manifest=readFileSync(new URL(dir+'sky/skyAssets.manifest.ts',import.meta.url),'utf8');let files=0;
 for(const m of manifest.matchAll(/['"](\/games\/echo-quiz-rush\/skybound\/[^'"]+)['"]/g)){
  files++;assert(/-[0-9a-f]{8,}\./.test(m[1]),'content-hashed '+m[1]);
  const bytes=readFileSync(new URL('../public'+m[1],import.meta.url));assert(bytes.length>0);
  assert(m[1].includes('-'+createHash('sha256').update(bytes).digest('hex').slice(0,8)+'.'),'asset hash matches bytes '+m[1]);
  if(m[1].endsWith('.glb')){
   assert.equal(bytes.readUInt32LE(0),0x46546c67);assert.equal(bytes.readUInt32LE(8),bytes.length);
   const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString('utf8').trim());
   if(m[1].includes('/runner-')){const clips=gltf.animations.map(a=>a.name);for(const clip of ['Idle','Walk','Run','Sprint','Dash','JumpUp','JumpFall','Land','Dodge','DodgeL','Hit','Stumble','Tumble','Brace','Cheer'])assert(clips.includes(clip),clip);assert(gltf.skins.length>0);}
   if(m[1].includes('/props6-'))for(const name of ['saw_blade','crusher_block','crusher_frame','gale_bridge','crumble_tile','drift_stone','orb_speed','orb_energy','orb_guard','shutter','wall_wheel','knowledge_tower','causeway_keel'])assert(gltf.nodes.some(n=>n.name===name),name);
   if(m[1].includes('/props7-'))for(const name of ['roller_log','roller_band','roller_peg','roller_hub','roller_pad','step_stone','tilt_deck','beam_deck'])assert(gltf.nodes.some(n=>n.name===name),name);
  }
 }
 assert(files>=8,'authored asset files listed: '+files);
});
const staticWall = () => ({kind:'STATIC',tier:1,phase:0,travel:0,rest:0,advance:0,hold:0,retreat:0,amp:0,slidePeriod:0,shutPeriod:0,openShare:0});
const reforgedRace = (hazards=[], orbs=[]) => {
 const s=createRush(2,0,3,2800,6,[6000,12000],hazards,[false,false],[staticWall(),staticWall()],orbs);
 s.phase='RUNNING';return s;
};
check('V6 physical constants match the server authority, including orb collision reach',()=>{
 const java=readFileSync(new URL('../../backend/src/main/java/com/englishcoach/quizrush/RushReforged.java',import.meta.url),'utf8');
 for(const [key,value] of Object.entries(R.REFORGED)){
  const name=key.replace(/[A-Z]/g,c=>'_'+c).toUpperCase();
  const match=java.match(new RegExp('\\b'+name+'\\s*=\\s*([\\d.]+)'));
  assert(match,'server constant '+name);assert.equal(value,+match[1],name);
 }
});
check('V6 standstill, forward/backward motion, normalized diagonals and braking',()=>{
 const i={...input(),forward:0};const s=reforgedRace();advance(s,i,3);assert.equal(s.y,0);assert.equal(s.x,500);
 i.forward=1;advance(s,i,2);assert(s.y>350);assert.equal(s.jumps,0);assert.equal(s.dodges,0);
 i.forward=0;advance(s,i,1);const stopped=s.y;advance(s,i,1);assert(Math.abs(s.y-stopped)<.01);
 s.y=2000;i.forward=-1;advance(s,i,1);assert(s.y<1900);assert.equal(s.dodges,0);
 const d=reforgedRace();advance(d,{...input(),horizontal:1,forward:1},.7);
 assert(Math.abs(Math.hypot(d.vx*.01,d.vy*.02)-R.REFORGED.move)<.02);
});
check('V6 open edges fall and recover to the preceding safe floor',()=>{
 const hazard={kind:'SAWS',checkpoint:0,from:1000,to:2000,tier:1,phase:0,dir:1,lane:-1,salt:1};
 const s=reforgedRace([hazard]);s.x=969;s.y=1100;
 advance(s,{...input(),horizontal:1,forward:0},.1);assert.equal(s.phase,'FALLING');assert.equal(s.falls,1);
 advance(s,{...input(),forward:0},1.1);assert.equal(s.phase,'RUNNING');assert.equal(s.y,880);assert(s.guard>0);
});
check('V6 orb reach, one collection, real speed effect and expiration',()=>{
 const orb={id:0,kind:'SPEED',checkpoint:0,x:500,y:100,z:90};
 assert(R.touches(orb,564,100,0));assert(!R.touches(orb,566,100,0));
 const s=reforgedRace([], [orb]);advance(s,{...input(),forward:1},1);
 assert.deepEqual(s.taken,[0]);assert(s.speedUntil>s.elapsed);assert(s.vy>R.REFORGED.move/.02);
 advance(s,{...input(),forward:0},5);assert.equal(s.orbSerial,1);assert(s.speedUntil<s.elapsed);
});
check('V6 wall motion stays deterministic and timed shutters expose a usable opening',()=>{
 const slide={...staticWall(),kind:'SLIDE',amp:90,slidePeriod:4.4};assert(Math.abs(R.slide(slide,1.1)-90)<1e-8);
 const timed={...staticWall(),kind:'TIMED',shutPeriod:3.8,openShare:.62};assert(!R.shut(timed,0));assert(R.shut(timed,3.8*.8));
 const approach={...staticWall(),kind:'APPROACH',travel:560,rest:2.6,advance:7,hold:1.2,retreat:3};
 assert.equal(R.plane(approach,6000,0),6000);assert(R.plane(approach,6000,6)<5800);
});
// ───────────────────────────── Version 7 (Hardcore) ─────────────────────────────
const hardRace = (hazards=[], orbs=[]) => {
 const s=createRush(2,0,3,2800,7,[6000,12000],hazards,[false,false],[staticWall(),staticWall()],orbs);
 s.phase='RUNNING';return s;
};
check('V7 tables match the server authority (tiers 5–6 and the four new obstacles)',()=>{
 const java=readFileSync(new URL('../../backend/src/main/java/com/englishcoach/quizrush/RushReforged.java',import.meta.url),'utf8');
 const trials=readFileSync(new URL('../../backend/src/main/java/com/englishcoach/quizrush/RushTrials.java',import.meta.url),'utf8');
 const arr=(src,name)=>{const m=src.match(new RegExp('\\b'+name+'\\s*=\\s*\\{([^}]*)\\}'));assert(m,'server table '+name);return m[1].split(',').map(Number);};
 const pairs=[['SAW_SPIN',R.SAWS.spin],['CRUSH_PERIOD',R.CRUSHER.period],['GALE_PERIOD',R.GALE.period],['GALE_FORCE',R.GALE.force],['CRUMBLE_PERIOD',R.CRUMBLE.period],
  ['DRIFT_AMP',R.DRIFT.amp],['DRIFT_SPIN',R.DRIFT.spin],['BEAM_LEN',R.BEAM.length],['BEAM_HALF',R.BEAM.half],['BEAM_PERIOD',R.BEAM.period],['BEAM_FORCE',R.BEAM.force],
  ['STEP_GAP',R.STEPS.gap],['STEP_OFF',R.STEPS.off],['STEP_R',R.STEPS.r],['STEP_SINK',R.STEPS.sink],['TILT_LEN',R.TILT.length],['TILT_DEG',R.TILT.deg],['TILT_PULL',R.TILT.pull],
  ['ROLL_LEN',R.ROLLER.length],['ROLL_SPIN',R.ROLLER.spin],['ROLL_RING',R.ROLLER.ring],['ROLL_PEGS',R.ROLLER.pegs]];
 for(const [name,ts] of pairs)assert.deepEqual(arr(java,name),[...ts],name);
 for(const [name,ts] of [['MILL_SPIN',T.MILL.spin],['RAM_SPEED',T.RAMS.speed],['BOULDER_SPEED',T.BOULDER.speed],['BOULDER_EVERY',T.BOULDER.every],['FALL_PERIOD',T.SKYFALL.period],['CHASM_HALF',T.CHASM.half]])
  assert.deepEqual(arr(trials,name),[...ts],name);
 for(const [name,v] of [['STEP_EDGE',R.STEPS.edge],['STEP_DOWN',R.STEPS.down],['STEP_WARN',R.STEPS.warn],['STEP_DIP',R.STEPS.dip],['TILT_SEG',R.TILT.seg],['TILT_BLEND',R.TILT.blend],
  ['ROLL_R',R.ROLLER.r],['ROLL_PEG',R.ROLLER.peg],['ROLL_PEG_HALF',R.ROLLER.pegHalf],['ROLL_SUPPORT',R.ROLLER.support],['ROLL_BODY',R.ROLLER.body],['ROLL_PAD',R.ROLLER.pad],['ROLL_PAD_HALF',R.ROLLER.padHalf],
  ['ROLL_JUMP',R.ROLLER.jump],['ROLL_SIDE',R.ROLLER.side],['CRUSH_REACH',R.CRUSHER.reach],['BOULDER_PAIR',T.BOULDER.pair]]){
  const m=(java+trials).match(new RegExp('\\b'+name+'\\s*=\\s*([\\d.]+)'));assert(m,'server constant '+name);assert.equal(v,+m[1],name);
 }
 // The authority's probe file (generated by scripts/rush-v7-probes.mjs from these functions) still matches them.
 const csv=readFileSync(new URL('../../backend/src/test/resources/quizrush/v7-probes.csv',import.meta.url),'utf8').trim().split('\n').slice(1);assert(csv.length>5000);
 for(const line of csv.filter((_,i)=>i%7===0)){const c=line.split(',');const h={kind:c[0],checkpoint:0,from:+c[5],to:+c[6],tier:+c[1],phase:+c[2],dir:+c[3],lane:-1,salt:+c[4]};
  const t=+c[7],x=+c[8],y=+c[9],z=+c[10],hit=R.hit6(h,t,x,y,z);assert.equal(hit?String(Math.sign(hit.vx)):'',c[11],line);assert.equal(String(R.falls6([h],x,y,t,true)),c[13],line);}
});
check('V7 has no railing: a plain road edge is a drop with momentum; version 6 keeps its rails',()=>{
 const s=hardRace();s.x=900;s.y=600;let n=0;while(s.phase!=='FALLING'&&n++<240)stepRush(s,{...input(),horizontal:1,forward:0},1/120);
 assert.equal(s.phase,'FALLING');assert(s.fallX>500+R.REFORGED.edge);assert(s.kvx>0);const x0=s.x;advance(s,{...input(),forward:0},.3);assert(s.x>x0,'keeps flying outward');
 advance(s,{...input(),forward:0},1);assert.equal(s.phase,'RUNNING');assert(Math.abs(s.x-500)<=R.REFORGED.respawnSide);assert.equal(s.y,600-R.REFORGED.respawnBack);
 const old=reforgedRace();old.x=900;old.y=600;advance(old,{...input(),horizontal:1,forward:0},1.5);assert.equal(old.phase,'RUNNING');assert.equal(old.x,500+R.REFORGED.rail);
});
check('V7 new obstacles: stones, dips, lean, beam, rollers',()=>{
 const steps={kind:'STEPS',checkpoint:0,from:1000,to:1000+R.hazardLength6('STEPS',3),tier:3,phase:.4,dir:1,lane:-1,salt:99};
 assert(!R.falls6([steps],R.stepX(steps,0),R.stepY(steps,0),0,true));
 let dipped=0;for(let t=0;t<R.STEPS.sink[2];t+=.01)if(R.stepDown(steps,1,t))dipped++;assert(Math.abs(dipped/(R.STEPS.sink[2]/.01)-R.STEPS.down)<.02);
 const tilt={kind:'TILT',checkpoint:0,from:1000,to:1000+R.hazardLength6('TILT',4),tier:4,phase:0,dir:1,lane:-1,salt:7};
 const s=hardRace([tilt]);s.y=1150;advance(s,{...input(),forward:0},1.2);assert(s.x>520,'slides to the low side');
 assert(R.surfaceHeight([tilt],900,1150)<0&&R.surfaceHeight([tilt],100,1150)>0,'the low side is drawn lower');
 const beam={kind:'BEAM',checkpoint:0,from:1000,to:1000+R.hazardLength6('BEAM',6),tier:6,phase:0,dir:1,lane:-1,salt:3};assert(R.falls6([beam],500+R.BEAM.half[5]+1,1200,0,true));
 const roll={kind:'ROLLER',checkpoint:0,from:1000,to:1000+R.hazardLength6('ROLLER',1),tier:1,phase:0,dir:1,lane:-1,salt:5};const ry=R.ringY(roll,0,2);
 let met=0,cleared=0;for(let t=0;t<8;t+=.01){if(R.hit6(roll,t,500,ry,0))met++;if(R.hit6(roll,t,500,ry,60))cleared++;}assert(met>0);assert.equal(cleared,0);
 assert.equal(R.rollerCarry(roll,500,ry),R.ROLLER.spin[0]*R.ROLLER.r/.01*roll.dir);
});
const N = await import('../src/components/features/games/echo-quiz-rush/rushNet.ts');
check('multiplayer clock never steps backward under jitter and adopts a slower path gradually',()=>{
 const c=new N.RaceClock();let prev=-Infinity;let rnd=1;const rand=()=>(rnd=(rnd*16807)%2147483647)/2147483647;
 const arrivals=Array.from({length:200},(_,k)=>k*100+45+rand()*50);
 for(let k=0;k<200;k++){c.sample(arrivals[k],k*.1,.045);for(let w=arrivals[k];w<(arrivals[k+1]??arrivals[k]+100);w+=16){const v=c.now(w);assert(v>=prev-1e-9,'monotonic');prev=v;}}
 assert(Math.abs(c.now(200*100+45)-(20+.05))<.08,'tracks the authority within jitter');
});
check('input history replays what was held, and one-shot actions until acknowledged',()=>{
 const h=new N.InputHistory();for(let i=1;i<=240;i++)h.record(i*N.STEP,{horizontal:i<120?0:1,forward:1,sprint:false});
 assert.equal(h.at(100*N.STEP).horizontal,0);assert.equal(h.at(130*N.STEP).horizontal,1);
 h.jump(1.0,3,0);assert(h.jumpDue(1.0-N.STEP,1.0,false,2));assert(!h.jumpDue(1.0-N.STEP,1.0,false,3),'acknowledged');assert(h.jumpDue(1.5,1.5+N.STEP,true,2),'still in flight: first replayed step');
 h.dash(1.1,1000);assert(h.dashDue(1.0,1.1,false,false,1200));assert(!h.dashDue(1.0,1.1,false,true,1200));assert(!h.dashDue(1.0,1.1,false,false,2000),'a refused dash expires');
});
check('rivals interpolate by server time: even speed despite jittered arrival, no blend across a respawn',()=>{
 const b=new N.RivalBuffer();for(let k=0;k<20;k++)b.push('p2',{e:k*.1,x:500,y:k*21.2,z:0,vz:0,phase:'RUNNING'});
 let prev=null;const speeds=[];for(let t=.4;t<1.6;t+=1/144){const p=b.pose('p2',t);if(prev)speeds.push((p.y-prev)/(1/144));prev=p.y;}
 const mean=speeds.reduce((a,v)=>a+v,0)/speeds.length;assert(speeds.every(v=>Math.abs(v-mean)<1e-6),'constant speed');assert(Math.abs(mean-212)<1e-6);
 b.push('p2',{e:2.0,x:500,y:100,z:0,vz:0,phase:'RUNNING'});const mid=b.pose('p2',1.95);assert(mid.y===100||mid.y===19*21.2,'a respawn is never blended');
});
check('scene uses the modern replay path for version 6+ races and never steps the clock back per snapshot',()=>{
 const dir='../src/components/features/games/echo-quiz-rush/';const scene=readFileSync(new URL(dir+'RushScene.tsx',import.meta.url),'utf8');
 assert(scene.includes('replay(auth')&&scene.includes('rivals.pose(')&&scene.includes('arrivals.sample(now, server.elapsed, 0)'));assert(!scene.includes('(network?.rtt?.() ?? 90) / 2000'),'the half-round-trip lead with current keys is gone');
 // 2026-10-26: one timeline (no round-trip term inside it), the measured input lead on a clock that never rewinds.
 assert(scene.includes('sim.advance(now, a + lead.value(fallbackLead())')&&scene.includes('lead.observe(')&&!scene.includes('oneWay()'),'no double-counted round trip');
 const hook=readFileSync(new URL(dir+'useRushCompetition.ts',import.meta.url),'utf8');assert(hook.includes('publishInput.current()')&&hook.includes('INPUT_GAP-(performance.now()-lastSent.current.at)')&&hook.includes('INPUT_BUDGET=30'));
});
check('repair 2026-10-25: headings stay in (−π, π] so a wall never spins the runner a full turn',()=>{
 const dir='../src/components/features/games/echo-quiz-rush/';const world=readFileSync(new URL(dir+'sky/skyWorld.ts',import.meta.url),'utf8');
 const net=readFileSync(new URL(dir+'rushNet.ts',import.meta.url),'utf8');
 assert(world.includes('export const wrapAngle')&&net.includes("return wrap(heading) * Math.exp(-dt * 8)")&&world.includes('this.heading = faceHeading(this.heading,'),'the wall decay works on the wrapped heading');
 assert(!world.includes('this.heading *= Math.exp(-dt * 8)'),'no decay of an unwrapped heading');
 assert(world.includes('slot.heading = faceHeading(slot.heading, r.vx')&&!world.includes('Math.atan2(x - slot.lastX, slot.lastZ - z)'),'rivals face their snapshot velocity, never a frame delta');
 // The rule itself: from a heading that wound past ±π, the decay toward the wall takes the short way (never > π of turning).
 const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));let h=0;for(let k=0;k<400;k++){const target=k%2?Math.PI-.01:-Math.PI+.01;h=wrap(h+wrap(target-h)*.2);}
 h+=2*Math.PI;let turned=0,prev=wrap(h);for(let k=0;k<200;k++){const next=wrap(prev)*Math.exp(-1/60*8);turned+=Math.abs(wrap(next-prev));prev=next;}
 assert(turned<=Math.PI+1e-6,`turned ${turned}`);
});
check('repair 2026-10-25: a sinking stone carries its runner down; nobody hangs above it',()=>{
 const h={kind:'STEPS',checkpoint:0,from:1000,to:1000+R.hazardLength6('STEPS',4),tier:4,phase:.3,dir:1,lane:-1,salt:99};
 let seen=false;for(let t=0;t<8;t+=.01){const j=1;if(!R.stepSinks(h,j))continue;const sink=R.stepSink(h,j,t);assert(sink>=0&&sink<=R.STEP_SINK+1e-9);
  const g=R.surfaceHeight([h],R.stepX(h,j),R.stepY(h,j),t);assert(Math.abs(g+sink)<1e-9,'runner on the stone at its height');if(sink>.4)seen=true;
  if(R.stepDown(h,j,t))assert(R.stepUnder(h,R.stepX(h,j),R.stepY(h,j),t)===j,'the stone still holds whoever stands on its middle');}
 assert(seen,'the stone really sinks');assert(R.surfaceHeight([h],500,h.from-50,1)===0,'plain road is level');
 const skin=readFileSync(new URL('../src/components/features/games/echo-quiz-rush/sky/skyHazards.ts',import.meta.url),'utf8');assert(skin.includes('st.position.y = -stepSink(h, j, t)')&&!skin.includes('2.6'),'the drawn stone uses the same sink');
});
check('repair 2026-10-25: input history survives a race clock re-estimated backward',()=>{
 const h=new N.InputHistory();h.record(1,{horizontal:0,forward:1,sprint:false});h.record(2,{horizontal:1,forward:1,sprint:false});h.record(3,{horizontal:0,forward:0,sprint:false});
 h.record(2.5,{horizontal:-1,forward:1,sprint:false});assert.equal(h.at(2.6).horizontal,-1);assert.equal(h.at(2.2).horizontal,1);assert.equal(h.at(3.5).horizontal,-1,'a step recorded for a time not reached yet is replaced');
 const scene=readFileSync(new URL('../src/components/features/games/echo-quiz-rush/RushScene.tsx',import.meta.url),'utf8');assert(scene.includes('const present = simTarget(now) ?? state.elapsed'),'snapshots re-synchronise to the race clock');
});
check('repair 2026-10-25: a finished race never takes the screen of a new request',()=>{
 const dir='../src/components/features/games/echo-quiz-rush/';const hook=readFileSync(new URL(dir+'useRushCompetition.ts',import.meta.url),'utf8');
 assert(hook.includes('if(closed(value.status)&&previous?.matchId!==value.matchId)'),'closed races are adopted only by the screen following them');
 assert(hook.includes("if(snapshot.current&&closed(snapshot.current.status))dropRoom();"),'leaving drops a finished room from the address');
 assert(hook.includes("if(everSynced)setError('CONNECTION_LOST')"),'no "connection lost" before a first connection');
 const rush=readFileSync(new URL(dir+'RushGame.tsx',import.meta.url),'utf8');assert(rush.includes("setHallTry(v => v + 1)")&&!rush.includes('Promise.all([quizRushApi.config'),'the hall retries its configuration and never dies on an optional read');
 assert(rush.includes('Nguồn câu hỏi, âm thanh và hình ảnh'));
 const comp=readFileSync(new URL(dir+'RushCompetitiveGame.tsx',import.meta.url),'utf8');assert(comp.includes('onHidden={() => { if (racing && document.hidden) audio.current?.pause(); }}'),'a blur never switches race input off');const topics=readFileSync(new URL(dir+'rushTopics.ts',import.meta.url),'utf8');assert(!/'[^']*[à-ỹ][^']* & [^']*'/u.test(topics),'Vietnamese labels say "và"');
});
console.log(`Echo Quiz Rush: ${groups} groups passed`);

