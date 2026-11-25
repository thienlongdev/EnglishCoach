// A grasp made at pickup survives working, interrupted carrying and resuming.
// These are frame-ownership tests, not anatomical or gameplay acceptance.
import assert from 'node:assert/strict';
import * as T from 'three';
import {tsLoader} from './lib/ts-load.mjs';
const load=tsLoader({three:T,'@/lib/embodiment/contactAudio':{Scrape:class{set(){}stop(){}}}});
const {ToolWork}=load('components/study-space/world/toolWork.ts');
const {GraspFrame}=load('lib/embodiment/graspFrame.ts');
const {handRotation}=load('lib/embodiment/poses.ts');
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z);
function localFrame(group,contact){
 group.updateWorldMatrix(true,false);
 return group.matrixWorld.clone().invert().multiply(new T.Matrix4().compose(contact.wrist,handRotation(contact.fingers,contact.palm,new T.Quaternion()),V(1,1,1)));
}
function closeFrame(actual,expected,label){assert.ok(Math.max(...actual.elements.map((v,i)=>Math.abs(v-expected.elements[i])))<1e-6,label);}
function fixture(kind,side,scale){
 const stage=new T.Group(),root=new T.Group(),group=new T.Group();stage.add(root,group);stage.scale.setScalar(scale);stage.position.set(1,.2,-3);
 group.position.set(-.3,.05,-.5);group.rotation.set(.1,.7,-.04);stage.updateWorldMatrix(true,true);
 const contacts=new Map(),ch={ready:true,root,body:{seat:null},lean:0,workingBody:false,
  bodyForward:v=>v.set(0,0,1).applyQuaternion(root.quaternion),eyePoint:v=>v.set(0,1.4,0),turnBody(){},
  rig:{contactProgress:()=>1,contactOn:s=>contacts.get(s)??null,setContact:(s,c)=>contacts.set(s,c),armReach:()=>null,refit(){},fitted:()=>true,fitNow:()=>true,wristWorld:(s,o)=>o.set(0,0,0),
   handFrame(s,w,f,p){const c=contacts.get(s);if(!c)return false;w.copy(c.wrist);f.copy(c.fingers);p.copy(c.palm);return true;}}};
 const ph={resumeHeld(){},driveTool(){},clearFloorLine:()=>null,clearRay:(_a,_b,far)=>far};
 const life={floor:{w:6,d:6},films:new Map(),film:()=>null,webNear:()=>null};
 const work=new ToolWork({stage,character:()=>ch,physics:()=>ph,life:()=>life,exploration:{view:'third',lookFlat:v=>v.set(0,0,1)},handBusy:()=>false,saveState(){},reduced:()=>false});
 const entry={group,obj:{id:'subject',kind,scale:1,pos:group.position.toArray(),rotY:0}};
 // The reached hand may differ from the catalog's nominal handle coordinate.
 // The exact secured frame, including roll, is authoritative after attachment.
 const frame=new T.Matrix4().compose(V(.029,kind==='tool.cloth'?.045:.96,-.06),new T.Quaternion().setFromEuler(new T.Euler(.23,-.51,.17)),V(1,1,1));
 const world=group.matrixWorld.clone().multiply(frame),contact={wrist:new T.Vector3().setFromMatrixPosition(world),fingers:V(0,1,0).transformDirection(world),palm:V(0,0,1).transformDirection(world),grip:'handle'};
 contact.bodyGoal=V(-2,.7,1);contact.bodyFingers=V(1,0,0);
 const anchor=new GraspFrame(group,contact),anchors=new Map([[side,anchor]]);
 contact.bodyGoal=V(2,1,-2);contact.grip='relaxed';
 assert.equal(anchor.contact().bodyGoal,undefined,'the captured frame excludes world-space task intent');
 assert.equal(anchor.contact().bodyFingers,undefined);
 assert.equal(anchor.contact().grip,'handle','reusing an action proxy cannot replace captured grasp metadata');
 contacts.set(side,anchor.contact());work.begin(entry,side,anchors);
 return {work,entry,root,group,ch,anchor,anchors,contacts};
}
let checks=0;
for(const kind of ['tool.broom','tool.mop','tool.cloth','tool.dustpan','tool.webbrush'])for(const side of [-1,1])for(const scale of [.8,1,1.2]){
 const f=fixture(kind,side,scale),initial=f.anchor.local.clone();
 closeFrame(localFrame(f.group,f.work.contactFirst()),initial,'working entry preserves the acquired object-local wrist');
 for(let i=0;i<90;i++){
  f.root.rotation.y=i*.073;f.root.position.set(Math.sin(i*.1)*.2,0,Math.cos(i*.07)*.2);
  f.group.rotation.set(Math.sin(i*.13)*.6,i*.047,Math.cos(i*.11)*.4);f.group.position.set(.2*Math.sin(i*.09),.05+.2*Math.sin(i*.03),.4*Math.cos(i*.07));
  f.work.update(1/60,new T.Ray(V(0,1.4,0),V(0,0,1)));
  const c=f.work.contactFirst();f.contacts.set(side,c);
  f.work.afterPhysics(1/60);f.work.afterBody(1/60);
  closeFrame(localFrame(f.group,f.work.contactFirst()),initial,'work/torso/rotation cannot slide or roll a secured grasp');
  closeFrame(f.anchor.local,initial,'no mutation of acquired frame');
 }
 f.work.end();f.work.begin(f.entry,side,f.anchors);
 closeFrame(localFrame(f.group,f.work.contactFirst()),initial,'resume keeps the original acquired frame');
 f.work.dispose();checks++;
}
console.log(`tool grasp: ${checks} kind/side/scale cases,2700 arbitrary-pose frames and resume PASS`);
