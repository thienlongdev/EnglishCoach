// Simultaneous hand constraints: preserve both local grasps and reject
// impossible spans. Numerical reach checks are not skin/collision acceptance.
import assert from 'node:assert/strict';
import { tsLoader } from './lib/ts-load.mjs';
import * as T from 'three';
const load=tsLoader({three:T});
const {fitGraspTranslation}=load('lib/embodiment/graspFrame.ts');
const {solveArm,alignWrist}=load('lib/embodiment/arms.ts');
const V=(...v)=>new T.Vector3(...v),Q=()=>new T.Quaternion();
const local=(x,y,z)=>new T.Matrix4().compose(V(x,y,z),new T.Quaternion().setFromUnitVectors(V(0,1,0),V(0,-.3,-1).normalize()),V(1,1,1));
const pair=[-1,1].map(side=>({local:local(side*.24,.6,side*.10),shoulder:V(side*.16,1.3,0),upper:.25,fore:.214,pole:V(side*.5,.8,.1),limit:.8}));
const immutable=pair.map(a=>a.local.toArray());
let checks=0;
for(const yaw of [0,.23,1.02,-.67])for(const scale of [.7,1,1.3]){
 const base=new T.Matrix4().compose(V(2,.04,-3.65),new T.Quaternion().setFromAxisAngle(V(0,1,0),yaw),V(scale,scale,scale));
 const arms=pair.map(a=>({...a,shoulder:a.shoulder.clone().multiplyScalar(scale).add(V(2,0,-3)),pole:a.pole.clone().multiplyScalar(scale).add(V(2,0,-3)),upper:a.upper*scale,fore:a.fore*scale}));
 const result=fitGraspTranslation(base,arms,.025*scale,.08*scale);
 assert.ok(result.feasible,`feasible dual grasp ${yaw}/${scale}, residual ${result.residual}`);
 for(const a of arms){
  const hand=result.matrix.clone().multiply(a.local),target=new T.Vector3().setFromMatrixPosition(hand),wantedQ=Q();hand.decompose(V(),wantedQ,V());
  const solved=solveArm(a.shoulder,target,a.pole,a.upper,a.fore,{direction:V(0,1,0).applyQuaternion(wantedQ),limit:.9});
  assert.ok(solved.wrist.distanceTo(target)<.00015);
  const q=alignWrist(wantedQ.clone(),solved.wrist.clone().sub(solved.elbow),.9);
  assert.ok(q.angleTo(wantedQ)<.001);
  assert.ok(Math.abs(solved.elbow.distanceTo(a.shoulder)-a.upper)<1e-8);
  assert.ok(Math.abs(solved.wrist.distanceTo(solved.elbow)-a.fore)<1e-8);
 }
 const q0=Q(),q1=Q();base.decompose(V(),q0,V());result.matrix.decompose(V(),q1,V());assert.ok(q0.angleTo(q1)<1e-7);
 assert.ok(new T.Vector3().setFromMatrixPosition(result.matrix).y>=.08*scale);
 checks++;
}
assert.deepEqual(pair.map(a=>a.local.toArray()),immutable,'established anchors never move');
// A shaft passing the shoulder leaves very little space for the lower
// hand to fold. A small inward servo error must still be reachable.
for (const scale of [.7, 1, 1.3]) {
 const upper=.25*scale, fore=.213*scale, folded=Math.abs(upper-fore)+.02, reserve=.025*scale;
 const arm={local:new T.Matrix4(),shoulder:V(0,0,0),pole:V(0,-1,0),upper,fore,limit:.8};
 for(const radius of [0, folded+.001, folded+reserve]) {
  const request=new T.Matrix4().makeTranslation(0,-radius,0);
  const result=fitGraspTranslation(request,[arm],reserve,-Infinity,reserve);
  assert.ok(result.feasible);
  const commanded=new T.Vector3().setFromMatrixPosition(result.matrix);
  assert.ok(commanded.length() >= folded+reserve-.0001, 'folded arm retains the commanded reserve');
  const actual=commanded.clone().setLength(commanded.length()-.006);
  assert.ok(solveArm(arm.shoulder,actual,arm.pole,upper,fore).wrist.distanceTo(actual)<1e-8,
    'a 6 mm inward tracking error stays inside the physical reach band');
 }
}
const impossible=pair.map((a,i)=>({...a,shoulder:V(i===0?-3:3,1.3,0)}));
assert.equal(fitGraspTranslation(new T.Matrix4(),impossible,.025).feasible,false,'no solution when the hands cannot span the object');
console.log(`grasp-reach: ${checks} transformed/scaled rigid pairs, exact lengths/orientation, immutable grips, impossible span reported`);
