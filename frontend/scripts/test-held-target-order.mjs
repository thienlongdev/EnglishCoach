// Exercise the real Manipulator callback with live acquisition/clearance states.
// The old callback skipped them, leaving a target planned before torso movement.
import assert from 'node:assert/strict';
import * as T from 'three';
import { tsLoader } from './lib/ts-load.mjs';
const inert = ['@/lib/embodiment/contactAudio', './water/water', './toolWork', './interactions', './physics', './effortMeter', './placement', './stationBoard', './shelfBooks', './openBook', './exploration'];
const load = tsLoader({ three: T, ...Object.fromEntries(inert.map(p => [p, {}])) });
const { Manipulator } = load('components/study-space/world/manipulation.ts');
const V = (x=0,y=0,z=0) => new T.Vector3(x,y,z);
let checks = 0;
for (const mode of ['carry', 'acquiring', 'clearing', 'lowering']) {
  const m = Object.create(Manipulator.prototype), events = [], group = new T.Group();
  const p = { obj: { id: 'subject', kind: 'monitor', scale: 1 }, group };
  const target = V(), finalShoulder = V(.2,1.25,-.3);
  let plans=0, steps=0, refreshes=0;
  const ph = {
    heldIn: side => side===1 ? 'subject' : null,
    centreFor: (_id,at,_q,out) => out.copy(at),
    holdGroupRotation: () => events.push('rotation'), holdRotation: () => {},
    aim: (_side,at) => { target.copy(at); events.push('aim'); },
    pointOf: () => V(0,.7,0), clearanceAlong: () => 1.35,
    poseAt: (_id,at,q) => ({position:at.clone(),quaternion:q.clone()}),
    update: () => { steps++; events.push('physics'); }, fitCarryInRoom: () => {},
  };
  Object.assign(m, { physics: ph, host: { placed: new Map([['subject',p]]), layout: () => ({room:{size:6}}), character: () => ({ready:true,root:new T.Group()}), exploration: {}, reduced: () => false },
    pendingPhysics: .1, carried: new Map([['subject',{w:.6,h:.4,d:.1}]]),
    heldPaths:new Map(),carryGoals:new Map(),toolCarryFrames:new Map(),constrainHeld:(_side,_p,at)=>at,
    intoHands: mode==='acquiring' ? {id:'subject',t:.1,from:V(0,.8,0)} : null,
    liftingOff: new Set(mode==='clearing' ? ['subject'] : []), work:{active:null,beforePhysics:()=>events.push('work-target'),afterPhysics:()=>events.push('work')},
    placing: mode==='lowering' ? {side:1,to:V(.1,.85,-.3),left:1,q:new T.Quaternion()} : null,
    actions: {refreshContacts:()=>{refreshes++;events.push('contacts');}}, followPush:()=>{},
    handCarryPose:()=>{plans++;return {position:finalShoulder.clone(),rotation:new T.Quaternion()};},
  });
  m.resolveContacts();
  assert.equal(steps,1); assert.equal(refreshes,1);
  assert.ok(events.indexOf('aim')>=0 && events.indexOf('aim')<events.indexOf('physics'));
  assert.ok(events.indexOf('aim')<events.indexOf('work-target'));
  assert.ok(events.indexOf('work-target')<events.indexOf('physics'));
  assert.ok(events.indexOf('physics')<events.indexOf('work'));
  assert.ok(events.indexOf('work')<events.indexOf('contacts'));
  if(mode==='carry')assert.ok(target.distanceTo(finalShoulder)<1e-10,'current shoulder owns the target');
  if(mode==='acquiring') {
    assert.equal(plans,1,'acquisition must be planned after the torso too');
    assert.ok(m.intoHands.t>.1 && target.y>.8 && target.y<finalShoulder.y,'approach remains continuous');
  }
  if(mode==='clearing') {
    assert.equal(plans,1,'clearance must not skip final-shoulder planning');
    assert.ok(target.y>=1.38 && target.x>0 && target.x<.2,'up-before-away clearance is preserved');
  }
  if(mode==='lowering') { assert.equal(plans,0);assert.equal(m.placing.left,.9);assert.ok(target.distanceTo(m.placing.to)<1e-10); }
  const snapshot=target.clone(), progress=m.intoHands?.t;
  m.resolveContacts();
  assert.equal(steps,1,'no second physics step without a new frame');
  assert.equal(m.intoHands?.t,progress,'acquisition clock advances once');
  assert.ok(target.equals(snapshot));
  checks++;
}
console.log(`held-target-order: ${checks} carry/acquire/clear/lower paths, once-per-frame planning and physics/contact order PASS`);
