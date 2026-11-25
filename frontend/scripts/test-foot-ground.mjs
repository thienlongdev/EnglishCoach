// Actual Character crossfades + HumanRig + exported soles. Contact is measured
// from geometry, independently of the controller's contact flags.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadCastGeometry } from './lib/load-cast.mjs';
import { tsLoader } from './lib/ts-load.mjs';
const load=tsLoader({three:T,'@/lib/embodiment/skin':{},'@/lib/embodiment/cast':{},'@/lib/avatar/wardrobe':{},'@/lib/avatar/look':{}});
const {HumanRig}=load('lib/embodiment/human.ts'),{Character}=load('components/study-space/world/character.ts');
const {correctGaits}=load('lib/embodiment/gaitClip.ts');
const assets=readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts',import.meta.url),'utf8');
let samples=0;
for(const hero of ['LYRA','KAI']){
 const gltf=await loadCastGeometry(assets.match(new RegExp(hero+": '([^']+)'"))[1]);
 for(const [hz,scale,yaw]of [[60,1,0],[120,1,0],[120,.85,1.3]]){
  const ch=new Character({model:hero}),stage=new T.Group();stage.position.set(2,.32,-1);stage.scale.setScalar(scale);stage.rotation.y=yaw;stage.add(ch.root);
  ch.model=clone(gltf.scene);ch.model.scale.setScalar(1.04);ch.root.add(ch.model);stage.updateMatrixWorld(true);
  ch.model.traverse(b=>{if(b.isBone)ch.bones.set(b.userData.name??b.name,b);});
  const anatomy=new Map();
  for(const side of ['L','R']){
   const foot=ch.bones.get('foot.'+side),inverse=foot.getWorldQuaternion(new T.Quaternion()).invert();
   anatomy.set(foot,{up:new T.Vector3(0,1,0).applyQuaternion(inverse),front:new T.Vector3(0,0,1).applyQuaternion(stage.quaternion).applyQuaternion(inverse)});
  }
  ch.rig=new HumanRig(ch.model,ch.root);ch.mixer=new T.AnimationMixer(ch.model);
  // The clips the game plays: Walk and Run put right for this skeleton at load (gaitClip.ts).
  const gaits=correctGaits(gltf.animations,ch.model,ch.rig.gaitSkeleton);ch.gaitDrawn=gaits.speed;
  for(const clip of gaits.clips)ch.actions.set(clip.name,ch.mixer.clipAction(clip));
  ch.measureEyes();ch.ready=true;ch.play('Idle',0);
  const last=new Map(),lift=new Map([[-1,0],[1,0]]);let minSole=Infinity,maxSlip=0,minHip=Infinity,maxError=0,contacts=0,worst=null,lowest=null;
  const velocity=new T.Vector3(),dt=1/hz;
  let anklePitchMin=Infinity,anklePitchMax=-Infinity,ankleRollMax=0;
  const segments=[['idle',.35,0,0],['walk',1.4,0,1.25],['stop',.7,0,0],['run',1.2,0,2.8],['stop',.7,0,0],['side',1.2,1.25,0],['back',1.2,0,-1.25],['stop',1,0,0]];
  for(const [phase,seconds,vx,vz]of segments)for(let n=0;n<Math.ceil(seconds*hz);n++){
   velocity.lerp(new T.Vector3(vx,0,vz),1-Math.exp(-12*dt));
   ch.drive(ch.root.position.clone().addScaledVector(velocity,dt),velocity.length()>.02,dt,0);ch.update(dt,false);
   ch.rig.update({dt,reduced:false,own:false,eye:new T.Vector3(0,1.6,0),lookYaw:0,lookPitch:0,moveYaw:ch.moveYaw,
    dynamics:{stepping:ch.stepping,gait:true,groundAt:()=>.32,mass:ch.bodyKg,loads:[]}});
   const rootY=ch.root.getWorldPosition(new T.Vector3()).y;
   for(const leg of ch.rig.legs){
    const at=leg.foot.getWorldPosition(new T.Vector3()),q=leg.foot.getWorldQuaternion(new T.Quaternion()),s=leg.foot.getWorldScale(new T.Vector3());
    const basis=anatomy.get(leg.foot),up=basis.up.clone().applyQuaternion(q),front=basis.front.clone().applyQuaternion(q),right=up.clone().cross(front);
    const tibia=leg.shin.getWorldPosition(new T.Vector3()).sub(at).normalize();
    const anklePitch=Math.atan2(tibia.dot(front),tibia.dot(up))*180/Math.PI,ankleRoll=Math.asin(T.MathUtils.clamp(tibia.dot(right),-1,1))*180/Math.PI;
    anklePitchMin=Math.min(anklePitchMin,anklePitch);anklePitchMax=Math.max(anklePitchMax,anklePitch);ankleRollMax=Math.max(ankleRollMax,Math.abs(ankleRoll));
    const height=(at.y+leg.sole.offsetY(q,s)-.32)/scale,local=leg.sole.supportPoint(q,s,new T.Vector3()),p=local.clone().multiply(s).applyQuaternion(q).add(at),prev=last.get(leg.side);
    minSole=Math.min(minSole,height);const hipHeight=(leg.thigh.getWorldPosition(new T.Vector3()).y-rootY)/scale;
    if(hipHeight<minHip){minHip=hipHeight;lowest={phase,n,side:leg.side,root:ch.root.position.toArray(),at:at.toArray(),raw:leg.at.toArray(),weight:{...ch.rig.balance.out},legs:ch.rig.legs.map(l=>({side:l.side,on:ch.rig.gaitFeet.get(l.side)?.on,step:ch.rig.gaitFeet.get(l.side)?.recovering,at:l.foot.getWorldPosition(new T.Vector3()).toArray(),goal:l.goal.toArray(),hip:l.thigh.getWorldPosition(new T.Vector3()).toArray()}))};}
    maxError=Math.max(maxError,at.distanceTo(leg.goal)/scale);
    if(height>.025)lift.set(leg.side,lift.get(leg.side)+1);
    if(prev&&Math.abs(height)<.005&&Math.abs(prev.height)<.005){
     const before=local.clone().multiply(prev.s).applyQuaternion(prev.q).add(prev.at);
     const slip=Math.hypot(p.x-before.x,p.z-before.z)/scale;
     if(slip>maxSlip){maxSlip=slip;worst={phase,n,side:leg.side,on:ch.rig.gaitFeet.get(leg.side)?.on,step:ch.rig.gaitFeet.get(leg.side)?.step,height,previousHeight:prev.height,at:at.toArray(),previous:prev.at.toArray(),goal:leg.goal.toArray(),raw:leg.at.toArray(),clip:ch.currentName,time:ch.current.time};}contacts++;
    }
    last.set(leg.side,{at,q,s,height});samples++;
   }
  }
  const result={hero,hz,scale,yaw,minSole,maxSlip,minHip,maxError,anklePitchMin,anklePitchMax,ankleRollMax,contacts,lifts:[...lift.values()],...((maxSlip>.005||minHip<.70||maxError>.005)?{worst,lowest}:{})};console.log(JSON.stringify(result));
  assert.ok(minSole>=-.005, 'no sole penetrates floor');assert.ok(maxSlip<=.005,'geometric contact does not skate');
  assert.ok(maxError<=.005,'legs reach actual targets');assert.ok(minHip>=.70,'locomotion does not pull hips into a split');
  assert.ok(contacts>100&&[...lift.values()].every(x=>x>20),'both feet have real lift and stance samples');
  assert.ok(anklePitchMin>=-42&&anklePitchMax<=25,'actual tibia-to-foot sagittal angle stays within locomotion envelope');
  assert.ok(ankleRollMax<=12,'ankles do not fold sideways during direction changes');
 }
}
console.log('PASS actual Character locomotion, stops, side/back travel and stage transforms: '+samples+' foot samples');

// Heel and toe can exchange lowest vertex midway through a recovery swing.
// In this case the source ankle has no longitudinal motion at all.
{
  const {FootGround} = load('lib/embodiment/footGround.ts');
  const foot = new FootGround(), rotation = new T.Quaternion(), scale = new T.Vector3(1,1,1);
  const ankle = new T.Vector3(0,.1,0), sole = new T.Vector3(0,-.1,-.1), result = new T.Vector3();
  const advance = () => {
    foot.solve(ankle, rotation, scale, sole, 0, 1/144, 1, result, true);
    foot.reached(result, rotation, result.y + sole.y);
  };
  advance();
  ankle.x = .13;
  advance();
  assert.ok(foot.recovering);
  for (let i=0;i<10;i++) advance();
  const before = result.z;
  sole.z = .1;
  advance();
  assert.ok(Math.abs(result.z-before)<.005, 'an airborne sole change cannot shift the ankle by a shoe length');
}
