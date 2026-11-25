// Actual Character + HumanRig: a standing body turns on the spot (planned
// PlantedFeet steps, no locomotion clip). The contact anchor of each shoe must
// follow its planted foot: no stale anchor may pull the pelvis down or split the legs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadCastGeometry } from './lib/load-cast.mjs';
import { tsLoader } from './lib/ts-load.mjs';
const load=tsLoader({three:T,'@/lib/embodiment/skin':{},'@/lib/embodiment/cast':{},'@/lib/avatar/wardrobe':{},'@/lib/avatar/look':{}});
const {HumanRig}=load('lib/embodiment/human.ts'),{Character}=load('components/study-space/world/character.ts');
const assets=readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts',import.meta.url),'utf8');
const verbose=process.env.TURN_VERBOSE==='1';
let samples=0;const failures=[];
for(const hero of ['LYRA','KAI']){
 const gltf=await loadCastGeometry(assets.match(new RegExp(hero+": '([^']+)'"))[1]);
 for(const [hz,scale,yaw0,rate]of [[60,1,Math.PI,2.4],[120,1,Math.PI,1.2],[90,.85,1.3,3.2],[144,1,0,-2.0]]){
  const ch=new Character({model:hero}),stage=new T.Group();stage.position.set(2,.32,-1);stage.scale.setScalar(scale);stage.add(ch.root);
  ch.model=clone(gltf.scene);ch.model.scale.setScalar(1.04);ch.root.add(ch.model);ch.root.rotation.y=yaw0;stage.updateMatrixWorld(true);
  ch.model.traverse(b=>{if(b.isBone)ch.bones.set(b.userData.name??b.name,b);});
  ch.rig=new HumanRig(ch.model,ch.root);ch.mixer=new T.AnimationMixer(ch.model);
  for(const clip of gltf.animations)ch.actions.set(clip.name,ch.mixer.clipAction(clip));
  ch.measureEyes();ch.ready=true;ch.play('Idle',0);
  const dt=1/hz;let minHip=Infinity,maxGoal=0,maxError=0,minSole=Infinity,worst=null;
  // Settle, then sweep the body round in place in alternating directions the way tool work's turnBody does, then hold.
  const plan=[['settle',.6,0],['turn',1.6,rate],['hold',.5,0],['turn',1.2,-rate*.8],['hold',.4,0],['turn',.9,rate*1.3],['hold',1.2,0]];
  for(const [phase,seconds,w]of plan)for(let n=0;n<Math.ceil(seconds*hz);n++){
   if(w)ch.moveRoot(ch.root.position,ch.root.rotation.y+w*dt);
   ch.update(dt,false);
   ch.rig.update({dt,reduced:false,own:false,eye:new T.Vector3(0,1.6,0),lookYaw:0,lookPitch:0,moveYaw:ch.moveYaw,
    dynamics:{stepping:ch.stepping,gait:true,groundAt:()=>.32,mass:ch.bodyKg,loads:[]}});
   const root=ch.root.getWorldPosition(new T.Vector3());
   for(const leg of ch.rig.legs){
    const at=leg.foot.getWorldPosition(new T.Vector3()),q=leg.foot.getWorldQuaternion(new T.Quaternion()),s=leg.foot.getWorldScale(new T.Vector3());
    const hip=(leg.thigh.getWorldPosition(new T.Vector3()).y-root.y)/scale,goal=Math.hypot(leg.goal.x-root.x,leg.goal.z-root.z)/scale;
    const sole=(at.y+leg.sole.offsetY(q,s)-.32)/scale,error=at.distanceTo(leg.goal)/scale;
    minSole=Math.min(minSole,sole);maxError=Math.max(maxError,error);maxGoal=Math.max(maxGoal,goal);
    if(hip<minHip){minHip=hip;worst={phase,n,side:leg.side,yaw:ch.root.rotation.y,goal,planted:ch.rig.feet.feet.map(f=>({side:f.side,d:Math.hypot(f.at.x-root.x,f.at.z-root.z)/scale,air:!!f.swing})),on:ch.rig.gaitFeet.get(leg.side)?.on};}
    samples++;
   }
   if(verbose&&n%Math.round(hz/6)===0)console.log(JSON.stringify({hero,hz,phase,n,yaw:+ch.root.rotation.y.toFixed(3),steps:ch.rig.feet.steps,hips:ch.rig.legs.map(l=>+((l.thigh.getWorldPosition(new T.Vector3()).y-root.y)/scale).toFixed(3)),goals:ch.rig.legs.map(l=>+(Math.hypot(l.goal.x-root.x,l.goal.z-root.z)/scale).toFixed(3)),planted:ch.rig.feet.feet.map(f=>+(Math.hypot(f.at.x-root.x,f.at.z-root.z)/scale).toFixed(3))}));
  }
  const result={hero,hz,scale,rate,steps:ch.rig.feet.steps,minHip,maxGoal,maxError,minSole};
  console.log(JSON.stringify(result));
  if(minHip<.70||maxGoal>.42||maxError>.005||minSole<-.005)failures.push({...result,worst});
 }
}
if(failures.length)console.log(JSON.stringify(failures,null,1));
assert.equal(failures.length,0,'in-place turning keeps every shoe anchor with its planted foot');
console.log('PASS actual Character in-place turning: '+samples+' foot samples');
