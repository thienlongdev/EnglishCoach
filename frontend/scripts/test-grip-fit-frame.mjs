import assert from 'node:assert/strict';
import * as T from 'three';
import {tsLoader} from './lib/ts-load.mjs';
const {gripFitFrame,gripFitChanged}=tsLoader({three:T})('lib/embodiment/gripFitFrame.ts');
const hand=new T.Matrix4().compose(new T.Vector3(.2,1.1,.3),new T.Quaternion().setFromEuler(new T.Euler(.2,.8,-.3)),new T.Vector3(1.04,1.04,1.04));
const cylinder=hand.clone().multiply(new T.Matrix4().makeTranslation(0,.072,.03)).multiply(new T.Matrix4().makeRotationZ(1.32));
const shape={kind:'cyl',half:[.0125,.6,.0125],toLocal:cylinder.clone().invert()},base=gripFitFrame(hand,shape);
for(let i=0;i<100;i++){
 const world=new T.Matrix4().compose(new T.Vector3(Math.sin(i)*3,Math.cos(i)*2,i*.03),new T.Quaternion().setFromEuler(new T.Euler(i*.13,i*.071,i*.017)),new T.Vector3(1,1,1));
 const moved={...shape,toLocal:world.clone().multiply(cylinder).invert()};
 assert(!gripFitChanged(base,gripFitFrame(world.clone().multiply(hand),moved)),'common continuous world movement retains contact fit');
 const gauge={...shape,toLocal:cylinder.clone().multiply(new T.Matrix4().makeRotationY(i*.17)).invert()};
 assert(!gripFitChanged(base,gripFitFrame(hand,gauge)),'cylinder axial coordinate spin does not trigger work');
}
const wristTurn=hand.clone().multiply(new T.Matrix4().makeRotationZ(.12));
assert(new T.Vector3().setFromMatrixPosition(wristTurn).distanceTo(new T.Vector3().setFromMatrixPosition(hand))<1e-12);
assert(gripFitChanged(base,gripFitFrame(wristTurn,shape)),'rotation without wrist translation invalidates stale finger fit');
const shifted={...shape,toLocal:cylinder.clone().premultiply(new T.Matrix4().makeTranslation(.002,0,0)).invert()};
assert(gripFitChanged(base,gripFitFrame(hand,shifted)),'physical surface motion invalidates the fit');
assert(gripFitChanged(null,base));
console.log('grip fit frame: 200 rigid-motion/gauge cases, wrist rotation and surface translation PASS');
