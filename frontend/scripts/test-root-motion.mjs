// Motion time must follow accepted rigid motion at any render rate, including corners and full turns.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as T from 'three';
const require=createRequire(import.meta.url),babel=require('next/dist/compiled/babel/bundle.js');
function load(file,deps={}) { const {code}=babel.core().transformSync(readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),{filename:file,configFile:false,babelrc:false,presets:[babel.presetTypescript()],plugins:[babel.pluginTransformModulesCommonjs()]});const exports={};runInNewContext(code,{exports,require:n=>deps[n]??require(n),console,window:{dispatchEvent(){}},Event});return exports; }
const motion=load('lib/embodiment/rootMotion.ts'),{RootMotionClock,readRootMotion}=motion;
const {RoomNavigation}=load('lib/study-space/navigation.ts'),posture=load('lib/embodiment/posture.ts');
let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++},near=(a,b,m)=>ok(Math.abs(a-b)<1e-8,`${m}: ${a} / ${b}`);
const data={name:'test',duration:1,times:[0,.25,.5,.75,1],positions:[0,0,0, 1,0,0, 1,0,1, 0,0,1, 0,0,0],yaw:[0,2,4,6,8],contacts:[1,1,0,1,1,0,1,1,0,0]};
const track=readRootMotion(data);ok(track,'valid unwrapped-yaw trajectory');
{
 const clock=new RootMotionClock(track,{x:2,z:-1,yaw:.71},1.04);
 while(clock.result!=='completed') clock.advance(.04,()=>1);
 let from=clock.time;
 clock.advance(.04,()=>.5,true);
 near(clock.time,from-.02,'a blocked rise consumes only the accepted reverse motion');
 while(clock.result!=='completed'){
   from=clock.time;
   clock.advance(.04,()=>1,true);
   ok(clock.time<from,'return clock moves toward the standing sample');
 }
 near(clock.time,0,'recovery reaches the first captured pose');
 near(clock.pose().x,2,'recovery returns to original root x');
 near(clock.pose().yaw,.71,'recovery returns to original heading');
}
for(const patch of [{times:[0,0,.5,.75,1]},{positions:data.positions.map((v,i)=>i===2?NaN:v)},{yaw:[0,4,5,6,8]},{duration:2},{contacts:[2]}])ok(!readRootMotion({...data,...patch}),'invalid metadata refused');
data.positions[3]=999;near(track.positions[3],1,'metadata is copied');
for(const hz of [20,30,60,120,144]){
 const clock=new RootMotionClock(track,{x:2,z:-1,yaw:.71},1.04);let root=clock.pose(),last=0;
 for(let i=0;i<hz*2 && clock.result!=='completed';i++)clock.advance(1/hz,p=>{ok(Math.abs(p.yaw-root.yaw)<=.4+1e-8,'yaw split before wrapping');root=p;last++;return 1});
 near(clock.time,1,'complete timeline');near(root.x,2,'closed root path');near(root.z,-1,'closed root path');near(root.yaw,8.71,'full turns retained');ok(last>=20,'bounded calls');
}
{
 const clock=new RootMotionClock(track,{x:0,z:0,yaw:0},1);clock.advance(.05,()=>.4);near(clock.time,.02,'partial motion gives partial clip time');
 const t=clock.time;for(let i=0;i<8;i++)clock.advance(.05,()=>0);near(clock.time,t,'blocked frames do not consume clip');
 clock.advance(.05,()=>1);near(clock.time,t+.05,'unblocking resumes from accepted sample');near(clock.blockedFor,0,'unblocked timer reset');
 for(let i=0;i<16;i++)clock.advance(.05,()=>0);ok(clock.result==='cancelled','bounded obstruction cancellation');
 const stopped=clock.time;clock.advance(.05,()=>{throw Error('terminal clock must not move')});near(clock.time,stopped,'terminal no writes');
}
{
 const nav=new RoomNavigation(6,[{x:.6,z:0,width:.02,depth:2,rotation:0}]);
 const f=nav.motionFraction({x:0,z:0},{x:1,z:0});near(f,.3899999,'continuous inflated thin obstacle');
 ok(nav.motionFraction({x:0,z:0},{x:0,z:1})===1,'parallel clear');
 ok(nav.motionFraction({x:.39,z:0},{x:0,z:0})===1,'retreat from boundary');
 ok(nav.motionFraction({x:0,z:0},{x:0,z:4})<.7,'room boundary');
 const rotated=new RoomNavigation(6,[{x:1,z:0,width:.02,depth:2,rotation:.7}]);
 const rf=rotated.motionFraction({x:0,z:0},{x:2,z:0});ok(rf>0&&rf<1,'rotated obstacle');
 for(let i=0;i<=100;i++)ok(rotated.free({x:2*rf*i/100,z:0}),'entire accepted segment is free');
}
const arms=load('lib/embodiment/arms.ts',{three:T});
const {Character}=load('components/study-space/world/character.ts',{'three':T,'@/lib/embodiment/arms':arms,'@/lib/embodiment/poses':load('lib/embodiment/poses.ts',{three:T,'@/lib/embodiment/arms':arms,'./arms':arms}),'@/lib/embodiment/human':{CROUCH:{eye:.38,pelvis:.34}},'@/lib/embodiment/gaitClip':{},'@/lib/embodiment/locomotionBiomech':load('lib/embodiment/locomotionBiomech.ts',{three:T,'./arms':arms}),'@/lib/embodiment/skin':{},'@/lib/embodiment/cast':{},'@/lib/embodiment/gait':load('lib/embodiment/gait.ts'),'@/lib/embodiment/posture':posture,'@/lib/embodiment/rootMotion':motion,'@/components/features/speaking/arena/arenaAssets':{},'@/lib/avatar/wardrobeAssets':{WAVE11_CAST_URLS:{}},'@/lib/avatar/wardrobe':{},'@/lib/avatar/look':{},'@/lib/avatar/characterCreator':{},'./echoLife/characterMaterials':{},'./echoLife/deadBlend':{}});
function character(){const c=new Character({model:'LYRA'});c.ready=true;c.model=new T.Group();c.root.add(c.model);c.mixer=new T.AnimationMixer(c.model);for(const name of ['Idle','test'])c.actions.set(name,c.mixer.clipAction(new T.AnimationClip(name,1,[new T.NumberKeyframeTrack('.position[y]',[0,1],[0,.1])])));c.play('Idle',0);return c;}
{
 const c=character();ok(c.registerMotion(track),'bind track to loaded clip');c.motionAllowed=()=>false;ok(!c.performMotion('test'),'hand/context admission');
 c.motionAllowed=()=>true;ok(c.performMotion('test'),'start existing character action');ok(c.posture==='acting','same posture authority');ok(!c.driveReady(),'manual drive cannot race action');
 c.motionFraction=()=>.5;c.update(.04,false);near(c.motionState.time,.02,'real Character accepts half time');near(c.actions.get('test').time,.02,'mixer consumes exact accepted time');
 const p=c.root.position.clone(),y=c.root.rotation.y;c.faceToward(2,.1);c.turnBody(2,.1);ok(c.root.position.equals(p)&&c.root.rotation.y===y,'other turns cannot overwrite root');
 c.cancelMotion('test-cancel');for(let i=0;i<30;i++)c.update(.02,false);ok(c.posture==='standing'&&!c.motionActive,'cancel blends out and relinquishes posture');ok(c.root.position.equals(p),'cancel never rewinds root');
 ok(c.performMotion('test'),'replay after cancellation');c.resetPose(new T.Vector3(2,0,2),1);ok(!c.motionActive&&c.posture==='standing','room reset drops timeline');
 c.dispose();ok(!c.motionActive,'dispose releases');
}
console.log(`root motion: ${checks} checks pass`);
