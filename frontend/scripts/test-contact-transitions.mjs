import assert from 'node:assert/strict';
import * as T from 'three';
import {tsLoader} from './lib/ts-load.mjs';
const load=tsLoader({three:T});
const {Interactions}=load('components/study-space/world/interactions.ts');
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z);
const c=x=>({wrist:V(x,1,.4),fingers:V(0,0,1),palm:V(0,1,0),grip:'relaxed'});
let reached=false,touches=0,refusals=0,aim=null;
const contacts=new Map();
const rig={setContact:(s,c)=>contacts.set(s,c),contactOn:s=>contacts.get(s)};
const a=new Interactions({rig:()=>rig,walkToward:()=>true,turnTo:at=>aim=at.clone(),reduced:()=>false,distanceTo:()=>0});
a.start({side:1,contact:()=>c(.3),second:()=>c(-.3),reach:.2,keep:true,ready:()=>reached,onContact:()=>touches++});
a.update(.3);assert.equal(touches,0,'elapsed reach cannot transfer ownership before IK');
assert.ok(aim.distanceTo(V(0,1,.4))<1e-9,'two-hand body faces the grasp midpoint');
a.resolveReach();assert.equal(touches,0,'unreached hand cannot attach');
reached=true;a.update(.1);assert.equal(touches,0,'even a ready callback belongs after IK');
a.resolveReach();a.resolveReach();assert.equal(touches,1,'contact effect exactly once');
a.update(.1);assert.equal(a.holding,true);a.letGoAll();assert.equal(a.holding,false);
for(const ready of [()=>false,()=>null]){
 a.start({contact:()=>c(.2),reach:.1,reachTimeout:.2,ready,onContact:()=>touches++,onUnreachable:()=>refusals++});
 a.update(.4);a.resolveReach();assert.equal(a.busy,false);assert.equal(a.holding,false);
}
assert.equal(touches,1);assert.equal(refusals,2,'timeouts and explicit refusals preserve object ownership');
// A cancelled reach can never attach from a late callback.
a.start({contact:()=>c(.2),ready:()=>true,onContact:()=>touches++});a.update(2);a.cancel();a.resolveReach();assert.equal(touches,1);
// Tool -> carry -> tool changes contact providers, never ownership effects.
assert.equal(a.rebindHeld(1,()=>c(.4)),false,'an empty hand cannot acquire by rebinding');
a.start({contact:()=>c(.2),keep:true,reach:.1,onContact:()=>touches++});a.update(.2);a.update(.1);
const original=contacts.get(1);let x=.3;
const previousAim={...c(.2),bodyGoal:new T.Vector3(2,1,-2),bodyFingers:new T.Vector3(1,0,0),
  pole:new T.Vector3(1,.4,0),wristPivot:true,bend:{pitch:.9,drop:.5}};
assert(a.rebindHeld(1,()=>previousAim,()=>previousAim));
assert.equal(a.rebindHeld(1,()=>c(x),()=>c(-x)),true);
for(const side of [1,-1]){
 assert.equal(contacts.get(side).bodyGoal,undefined,'ordinary carry clears the previous world-space torso target');
 assert.equal(contacts.get(side).bodyFingers,undefined,'old task orientation is released with its torso target');
 assert.equal(contacts.get(side).pole,undefined,'release the world-space elbow pole when a roll ends');
 assert.equal(contacts.get(side).wristPivot,undefined,'walking and placement use their own elbow solve');
 assert.equal(contacts.get(side).bend,undefined,'a superseded body constraint cannot limit the next action');
}
assert.equal(contacts.get(1),original,'primary proxy retains blend history');
assert.ok(contacts.get(-1));x=.6;a.refreshContacts();
assert.equal(contacts.get(1).wrist.x,.6);assert.equal(contacts.get(-1).wrist.x,-.6);
assert.equal(a.rebindHeld(1,()=>null),false,'invalid transfer retains old providers');
x=.7;a.refreshContacts();assert.equal(contacts.get(-1).wrist.x,-.7);
assert.equal(touches,2,'rebinding does not replay pickup');
assert.equal(a.rebindHeld(1,()=>c(.4)),true);assert.equal(contacts.get(-1),null);
// A different operation may own the free hand by the time the tool ends.
a.rebindHeld(1,()=>c(.4),()=>c(-.4));const foreign=c(-.9);rig.setContact(-1,foreign);
a.rebindHeld(1,()=>c(.5));assert.equal(contacts.get(-1),foreign);
a.letGo(1);assert.equal(contacts.get(1),null);assert.equal(contacts.get(-1),foreign);
for (const outcome of ['reached', 'missed', 'cancelled']) {
  let retries = 0, steps = 0, transfers = 0, refused = 0;
  const retry = {
    contact: () => c(.2), reach: .1, reachTimeout: .2,
    ready: () => steps > 0 && outcome === 'reached',
    reposition: () => { retries++; return () => { steps++; return true; }; },
    onContact: () => transfers++, onUnreachable: () => refused++,
  };
  a.start(retry);
  a.update(.4); a.resolveReach();
  assert.equal(a.walking, true);
  assert.equal(contacts.get(1), null, 'release the missed target before stepping');
  if (outcome === 'cancelled') a.cancel();
  a.update(.1); a.update(.4); a.resolveReach(); a.resolveReach();
  assert.equal(retries, 1, 'one retry per pickup');
  assert.equal(transfers, Number(outcome === 'reached'));
  assert.equal(refused, Number(outcome === 'missed'));
  assert.equal(steps, Number(outcome !== 'cancelled'));
  a.cancel();
}
console.log('contact transitions: post-IK attachment, both-hand aim, timeout, refusal and cancellation PASS');
