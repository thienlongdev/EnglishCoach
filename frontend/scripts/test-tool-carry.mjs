// A secured cleaning-tool grip must use the same arm-constrained rigid target
// as other carried objects, regardless of catalog hand count or camera.
import assert from 'node:assert/strict';
import * as T from 'three';
import { tsLoader } from './lib/ts-load.mjs';
const inert=['@/lib/embodiment/contactAudio','./water/water','./toolWork','./interactions','./physics','./effortMeter','./placement','./stationBoard','./shelfBooks','./openBook','./exploration'];
const load=tsLoader({three:T,...Object.fromEntries(inert.map(p=>[p,{}]))});
const {Manipulator}=load('components/study-space/world/manipulation.ts');
const {GraspFrame}=load('lib/embodiment/graspFrame.ts');
const {reachableWrist}=load('lib/embodiment/arms.ts');
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z), UP=V(0,1,0);
let checks=0;
for(const count of [1,2])for(const yaw of [0,.37,1.9,-2.43])for(const scale of [.8,1,1.2]){
 const m=Object.create(Manipulator.prototype),stage=new T.Group(),root=new T.Group(),group=new T.Group();
 stage.scale.setScalar(scale);stage.position.set(2,.1,-3);stage.add(root,group);root.rotation.y=yaw;
 group.userData.ownBox=new T.Box3(V(-.15,0,-.05),V(.15,1.36,.05));
 const localTool=new T.Quaternion();group.quaternion.copy(root.quaternion).multiply(localTool);group.position.set(0,.15,0);
 stage.updateWorldMatrix(true,true);
 const forward=V(0,0,1).applyQuaternion(root.quaternion),right=new T.Vector3().crossVectors(forward,UP);
 const anchors=new Map();
 for(const side of count===2?[1,-1]:[1]){
  // Two actual grips, when present; a long tool held in one hand must not
  // invent the catalog's second hand when its support hand was released.
  const local=V(side*.08,1.06,0),wrist=group.localToWorld(local);
  anchors.set(side,new GraspFrame(group,{wrist,fingers:forward.clone(),palm:UP.clone(),grip:'handle'}));
 }
 const original=[...anchors].map(([s,a])=>[s,a.local.toArray()]);
 const armReach=side=>({shoulder:stage.localToWorld(right.clone().multiplyScalar(side*.16).add(V(0,1.3,0))),upper:.25*scale,fore:.214*scale,length:.464*scale});
 const p={obj:{id:'tool',kind:'tool.broom',scale:1},group};
 Object.assign(m,{host:{stage,character:()=>({root,ready:true,rig:{armReach,armHome:armReach},bodyForward:out=>out.copy(forward)})},physics:{startOf:()=>new T.Quaternion()},
  grasps:new Map([['tool',anchors]]),carried:new Map([['tool',{w:.3,h:1.36,d:.1}]]),toolCarryFrames:new Map([['tool',{rotation:localTool,turn:0}]]),
  carryFar:0,carryYaw:0,handTurn:0,placeTilt:0});
 const result=m.handCarryPose(1,p);
 assert.ok(result,`secured tool must not fall back to eye/AABB targeting (${count},${yaw},${scale})`);
 const world=stage.matrixWorld.clone().multiply(new T.Matrix4().compose(result.position,result.rotation,group.scale));
 for(const [side,anchor] of anchors){
  const hand=world.clone().multiply(anchor.local),wrist=new T.Vector3().setFromMatrixPosition(hand),fingers=V(0,1,0).transformDirection(hand),a=armReach(side);
  const pole=a.shoulder.clone().addScaledVector(right,side*.34*scale).addScaledVector(UP,-.42*scale).addScaledVector(forward,-.12*scale);
  assert.ok(reachableWrist(a.shoulder,wrist,fingers,a.upper,a.fore,.8,pole).distanceTo(wrist)<.00015*scale,'every retained wrist is reachable');
 }
 assert.ok(group.userData.ownBox.clone().applyMatrix4(world).min.y>=stage.position.y+.079*scale,'whole tool clears floor');
 assert.deepEqual([...anchors].map(([s,a])=>[s,a.local.toArray()]),original,'no secured regrip');
 checks++;
}
console.log(`tool carry: ${checks} one/two-hand, arbitrary yaw, transformed/scaled fixed-grasp checks PASS`);
