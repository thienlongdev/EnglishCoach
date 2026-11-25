// Work uses the same force-driven Rapier body as carry. The requested head may
// be behind furniture; that never licenses a transform write or a remote clean.
import assert from 'node:assert/strict';
import * as T from 'three';
import R from '@dimforge/rapier3d-compat';
import {tsLoader} from './lib/ts-load.mjs';
await R.init();
const load=tsLoader({three:T,'@/lib/embodiment/contactAudio':{Scrape:class{set(){}stop(){}}}});
const {StudyPhysics}=load('components/study-space/world/physics.ts'),{ToolWork}=load('components/study-space/world/toolWork.ts');
const {GraspFrame}=load('lib/embodiment/graspFrame.ts'),{toolOf}=load('lib/study-space/tools.ts');
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z);
for(const hz of [30,60,120]){
 const stage=new T.Group(),group=new T.Group();stage.add(group);group.position.set(0,1,0);
 group.add(new T.Mesh(new T.BoxGeometry(.1,.1,.1)));
 const entry={group,obj:{id:'tool',kind:'tool.broom',pos:[0,1,0],rotY:0,scale:1}};
 const ph=new StudyPhysics(R,()=>{});ph.sync([entry],6);ph.pick(entry,[entry],6,1);
 const body=ph.bodies.get('tool'),before=ph.pointOf('tool'),draw=group.position.clone();
 const wall=ph.world.createCollider(R.ColliderDesc.cuboid(.025,.8,.4).setTranslation(.3,1,0));
 const target=V(.6,1,0),q=new T.Quaternion();
 ph.driveTool(1,'tool',target,q);
 assert.ok(ph.pointOf('tool').distanceTo(before)<1e-9,'work target must not teleport the body');
 assert.ok(group.position.distanceTo(draw)<1e-9,'work target must not teleport the drawing');
 let deepest=0;
 for(let i=0;i<hz*3;i++){
  ph.driveTool(1,'tool',target,q);ph.update(1/hz);
  for(const c of body.colliders){
   assert.notEqual(c.collisionGroups()&0xffff,0,'work never disables collisions');
   const hit=wall.contactShape(c.shape,body.body.translation(),body.body.rotation(),.01);
   if(hit)deepest=Math.min(deepest,hit.distance);
  }
 }
 assert.ok(deepest>-.003,`${hz}Hz target cannot force tool through barrier: ${deepest}`);
 assert.ok(group.position.x>.20&&group.position.x<.23,'actual work pose stops in front of barrier');
 const blocked=ph.pointOf('tool');ph.resumeHeld(1);
 assert.ok(ph.pointOf('tool').distanceTo(blocked)<1e-9,'ending work retains the actual pose');
 assert.ok(ph.holds.get(1).target.distanceTo(blocked)<1e-9,'carry starts at actual pose, not blocked work target');
 ph.aim(1,V(0,1,0));for(let i=0;i<hz*2;i++)ph.update(1/hz);
 assert.ok(ph.pointOf('tool').distanceTo(V(0,1,0))<.002,'carry can retreat from blocked work');
 ph.dispose();
}
// Work/carry planning advances from the observed body in bounded increments.
// Exercise that closed loop, rather than only an unchanging absolute target:
// render frames with no Rapier step must not erase target velocity history.
for(const hz of [10,30,60,90,120,144,'mixed']){
 const group=new T.Group();group.position.set(0,1,0);
 group.add(new T.Mesh(new T.BoxGeometry(.15,.5,.08)));
 const entry={group,obj:{id:'clock',kind:'tool.broom',pos:[0,1,0],rotY:0,scale:1}};
 const ph=new StudyPhysics(R,()=>{});ph.sync([entry],6);ph.pick(entry,[entry],6,1);
 const wanted=new T.Quaternion().setFromEuler(new T.Euler(.4,1.7,-.1)),goal=V(.3,1,.3);
 const q0=ph.startOf('clock').clone();let elapsed=0,frame=0;
 while(elapsed<10){
  const dt=hz==='mixed'?[1/144,1/90,1/120,1/30][frame++%4]:1/hz;
  const seconds=ph.motionStepSeconds(dt);
  const rotation=ph.groupRotationOf('clock').rotateTowards(wanted,.8*seconds);
  const actual=ph.pointOf('clock'),center=actual.clone().add(goal.clone().sub(actual).clampLength(0,.35*seconds));
  const pose=ph.poseAt('clock',center,rotation.clone().multiply(q0.clone().invert()));
  ph.driveTool(1,'clock',pose.position,rotation,dt,false,true);ph.update(dt);elapsed+=dt;
 }
 const miss=ph.pointOf('clock').distanceTo(goal),angle=group.quaternion.angleTo(wanted);
 assert.ok(miss<.005,`${hz}Hz bounded work must arrive within5mm, not stall: ${miss}`);
 assert.ok(angle<.015,`${hz}Hz bounded work must retain its .015rad pose gate: ${angle}`);
 ph.dispose();
}
{
 const stage=new T.Group(),group=new T.Group();stage.add(group);
 const entry={group,obj:{id:'cloth',kind:'tool.cloth',pos:[0,0,0],rotY:0,scale:1}},strokes=[];
 const ch={ready:true,root:new T.Group(),body:{seat:null},bodyForward:v=>v.set(0,0,1),turnBody(){},lean:0,rig:{contactOn:()=>null,setContact(){}}};
 const life={blot:()=>{},floor:{w:6,d:6,mop:(a,b)=>strokes.push([a,b])}};
 const work=new ToolWork({stage,character:()=>ch,life:()=>life,physics:()=>null,exploration:{view:'first'},handBusy:()=>false,saveState(){},reduced:()=>false});
 work.begin(entry,1,new Map([[1,new GraspFrame(group,work.gripWorld(entry,toolOf(entry.obj.kind),0,1))]]));work.pressing=true;work.touching={kind:'floor'};work.surfacePoint.set(0,0,0);
 // Desired head is far beyond the obstruction, but the physics-drawn head
 // has only travelled 10cm along the floor. Only those real cells may change.
 work.head.set(2,0,0);group.position.set(.1,.01,0);work.afterPhysics(1/60);
 assert.equal(strokes.length,1);assert.equal(strokes[0][1].x,.1);assert.equal(strokes[0][1].z,0);
 group.position.set(.2,.4,0);work.afterPhysics(1/60);
 assert.equal(strokes.length,1,'raised tool cannot clean a distant requested surface');
 assert.equal(work.isWorking,false,'working flag reflects physical surface contact');
 work.dispose();
}
// Regressions for the post-physics callback: it may observe the body and alter
// world state only at real contact, never move finalized shoulders or complete
// a blocked/cancelled operation merely because its animation timer elapsed.
function fixture(kind='tool.cloth') {
 const stage=new T.Group(),group=new T.Group();stage.add(group);
 const entry={group,obj:{id:'subject',kind,pos:[0,0,0],rotY:0,scale:1}},strokes=[],effects=[];
 const ch={ready:true,root:new T.Group(),body:{seat:null},bodyForward:v=>v.set(0,0,1),eyePoint:v=>v.set(0,1.4,0),
  turnBody(){effects.push('turn');this.root.rotation.y+=.1;},lean:0,
  rig:{contactOn:()=>null,setContact(){},refit(){},fitted:()=>true,fitNow:()=>true,wristWorld:(s,o)=>o.set(0,0,0),armReach:()=>null,contactProgress:()=>1}};
 const floor={w:6,d:6,mop:(a,b)=>strokes.push([a,b])};
 const life={blot(){},floor,films:new Map(),film:key=>life.films.get(key),wipe:(_f,a,b)=>strokes.push([a,b]),brushWeb:()=>effects.push('web'),webNear:()=>null};
 const ph={driveTool(){},clearFloorLine:()=>null,clearRay:(_a,_b,far)=>far,resumeHeld(){}};
 const ex={view:'third',lookFlat:v=>v.set(0,0,1)};
 const work=new ToolWork({stage,character:()=>ch,life:()=>life,physics:()=>ph,exploration:ex,handBusy:()=>false,saveState(){},reduced:()=>false});
 const spec=toolOf(kind),anchors=new Map([[1,new GraspFrame(group,work.gripWorld(entry,spec,spec.hands===2?1:0,1))]]);
 work.begin(entry,1,anchors);
 return {work,ch,group,life,strokes,effects,entry,anchors,ray:new T.Ray(V(0,1.4,0),V(0,-1,0))};
}
const failures=[];
function check(name,fn){try{fn();console.log('PASS '+name);}catch(e){failures.push(name);console.error('FAIL '+name+': '+e.message);}}
check('a working shaft can leave a detour that becomes obstructed',()=>{
 const f=fixture('tool.mop'), physics=f.work.host.physics();
 f.group.position.set(0,.04,.55);
 f.ch.turnBody=()=>{};
 physics.heldMotionFraction=(_from,_to,turn)=>turn<0?0:1;
 f.work.press(true);
 f.work.alternateTurn=-1;
 const ray=new T.Ray(V(0,1.4,0),V(.45,-1.4,-.35).normalize());
 for(let i=0;i<10;i++)f.work.update(1/60,ray);
 assert.equal(f.work.alternateTurn,1,'reverse only after the current arc is blocked and the other clears');
 f.work.press(false);
 assert.equal(f.work.alternateTurn,0,'a fresh stroke chooses its own approach');
 f.work.dispose();
});
check('work planning preserves live finger surfaces and secured grasps',()=>{
 const f=fixture('tool.broom');f.work.gripWorld(f.entry,f.work.active.spec,0,-1);
 const surfaces=[...f.work.felt].map(([side,v])=>({side,point:v.point.toArray(),axis:v.axis.toArray(),radius:v.radius,matrix:v.shape().toLocal.elements.slice()}));
 const local=f.anchors.get(1).local.elements.slice(),position=f.group.position.toArray(),rotation=f.group.quaternion.toArray();
 for(let i=0;i<80;i++)f.work.update(1/60,new T.Ray(V(0,1.4,0),V(.2+Math.sin(i*.06)*.15,-1.4,.6).normalize()));
 for(const s of surfaces){const v=f.work.felt.get(s.side);assert.deepEqual(v.point.toArray(),s.point);assert.deepEqual(v.axis.toArray(),s.axis);assert.equal(v.radius,s.radius);assert.deepEqual(v.shape().toLocal.elements,s.matrix);}
 assert.deepEqual(f.anchors.get(1).local.elements,local);assert.deepEqual(f.group.position.toArray(),position);assert.deepEqual(f.group.quaternion.toArray(),rotation);
 assert.ok(V(0,1,0).applyQuaternion(f.work.requestedRotation).distanceTo(f.work.axis)<1e-10,'roll preserves the requested shaft axis');f.work.dispose();
});
check('handle approach is invariant under world translation rotation and uniform scale',()=>{
 for(const side of [-1,1])for(const k of [.65,1,1.45])for(let i=0;i<17;i++){
  const f=fixture('tool.broom'),stage=f.work.host.stage;stage.add(f.ch.root);f.ch.root.position.set(.2,.1,-.3);f.ch.root.rotation.y=i*.421;
  f.ch.bodyForward=v=>v.set(Math.sin(f.ch.root.rotation.y),0,Math.cos(f.ch.root.rotation.y));
  const point=V(.4,.8,.3),axis=V(.2,.9,-.3).normalize(),a=f.work.handFrameAt(point,axis,side);
  stage.position.set(3,-2,1);stage.rotation.set(.1*i,.29*i,-.07*i);stage.scale.setScalar(k);stage.updateMatrixWorld(true);
  const b=f.work.handFrameAt(point.clone().applyMatrix4(stage.matrixWorld),axis.clone().transformDirection(stage.matrixWorld),side);
  assert.ok(b.wrist.distanceTo(a.wrist.applyMatrix4(stage.matrixWorld))<1e-10);assert.ok(b.fingers.distanceTo(a.fingers.transformDirection(stage.matrixWorld))<1e-10);assert.ok(b.palm.distanceTo(a.palm.transformDirection(stage.matrixWorld))<1e-10);f.work.dispose();
 }
});
check('work request preserves acquired shaft roll and stage invariance across arbitrary body turns',()=>{
 function request(yaw,k,stageYaw,preparing=false){
  const f=fixture('tool.broom'),stage=f.work.host.stage;stage.add(f.ch.root);f.ch.root.rotation.y=yaw;
  f.ch.bodyForward=v=>v.set(Math.sin(yaw),0,Math.cos(yaw));f.work.host.exploration={view:'first',lookFlat:f.ch.bodyForward};f.work.host.preparing=()=>preparing;
  f.group.position.set(.2,.12,.4);f.group.rotation.set(.2,.73,-.11);stage.scale.setScalar(k);stage.rotation.y=stageYaw;stage.position.set(3,.4,-2);stage.updateMatrixWorld(true);
  f.anchors.set(1,new GraspFrame(f.group,f.work.gripWorld(f.entry,f.work.active.spec,1,1)));
  f.work.begin(f.entry,1,f.anchors);const acquired=f.group.quaternion.clone();
  const local=f.anchors.get(1).local.elements.slice(),ray=new T.Ray(V(0,1.4,0),V(Math.sin(yaw)*.6,-1.4,Math.cos(yaw)*.6).normalize());f.work.update(1/60,ray);
  assert.deepEqual(f.anchors.get(1).local.elements,local);const q=f.work.requestedRotation.clone();
  assert.ok(V(0,1,0).applyQuaternion(q).distanceTo(f.work.axis)<1e-7,'shaft follows work axis');
  const undoSwing=new T.Quaternion().setFromUnitVectors(f.work.axis,V(0,1,0).applyQuaternion(acquired));
  assert.ok(undoSwing.multiply(q).angleTo(acquired)<1e-7,'lowering adds no axial spin to the acquired frame');
  f.work.dispose();return q;
 }
 for(let i=0;i<41;i++){const yaw=-Math.PI*2+i*.317,base=request(yaw,1,0);for(const [k,rotation]of[[.7,.836],[1.4,-2.713]])assert.ok(base.angleTo(request(yaw,k,rotation))<1e-7);request(yaw,1,.836,true);}
});
check('post-physics work keeps finalized root and lean fixed',()=>{
 const f=fixture();f.work.pressing=true;f.work.touching={kind:'floor'};f.group.position.set(.1,0,.2);f.work.lean=.3;
 f.work.afterPhysics(1/60);assert.equal(f.ch.root.rotation.y,0);assert.equal(f.ch.lean,0);f.work.dispose();
});
check('an airborne head can turn toward work without claiming contact',()=>{
 const f=fixture('tool.broom');f.group.position.set(0,.2,.3);f.work.pressing=true;
 f.work.touching={kind:'floor'};f.work.afterPhysics(1/60);
 assert.equal(f.work.isWorking,false,'head has not reached the floor');
 const initial=f.anchors.get(1).local.clone();
 f.work.update(1/60,new T.Ray(V(0,1.4,0),V(.5,-1.4,.5).normalize()));
 assert.ok(f.effects.includes('turn'),'surface approach must not wait for physical contact');
 f.work.afterPhysics(1/60);
 assert.equal(f.work.worked,0,'turning toward a surface is not cleaning');
 assert.deepEqual(f.anchors.get(1).local.elements,initial.elements,'approach cannot regrip');
 f.effects.length=0;f.work.host.preparing=()=>true;
 f.work.update(1/60,f.ray);assert.equal(f.effects.includes('turn'),false,'rack extraction retains its acquired approach');
 f.work.dispose();
});
check('cancel and reacquire discard old work overrides and residuals',()=>{
 const f=fixture();f.work.moveHead(V(2,0,0),.3);f.work.gripSecond=.2;f.work.end();
 assert.equal(f.work.headBusy,false);f.work.begin(f.entry,1,f.anchors);assert.equal(f.work.gripSecond,0);f.work.dispose();
});
check('blocked work cannot complete on time alone',()=>{
 const f=fixture();let completed=0;f.work.moveHead(V(2,1,0),.1,()=>completed++);
 for(let i=0;i<30;i++){f.work.update(1/30,f.ray);f.work.afterPhysics(1/30);}
 assert.equal(completed,0);assert.equal(f.work.headBusy,true);
 f.group.position.set(2,1,0);for(let i=0;i<30;i++){f.work.update(1/30,f.ray);f.work.afterPhysics(1/30);}
 assert.equal(completed,1);f.work.dispose();
});
check('interrupting a blocked operation retains the held tool and cancels its effect',()=>{
 const f=fixture();let completed=0;f.work.moveHead(V(2,1,0),.1,()=>completed++);f.work.cancelOperation();
 assert.equal(f.work.active.p,f.entry);assert.equal(f.work.headBusy,false);
 f.group.position.set(2,1,0);for(let i=0;i<30;i++){f.work.update(1/30,f.ray);f.work.afterPhysics(1/30);}
 assert.equal(completed,0);f.work.dispose();
});
check('landing never cleans the projection of an airborne path',()=>{
 const f=fixture();f.work.pressing=true;f.work.headLast.set(-1,1,0);f.group.position.set(1,0,0);f.work.touching={kind:'floor'};
 f.work.afterPhysics(1/60);assert.equal(f.strokes.length,0);f.work.dispose();
});
check('coplanar head outside a rotated tabletop cannot wipe it',()=>{
 const f=fixture();f.life.films.set('desk',{surface:{key:'desk',x:0,y:.7,z:0,rotY:Math.PI/4},field:{w:1,d:.4}});
 f.group.position.set(1,.7,1);f.work.headLast.set(.9,.7,1);f.work.touching={kind:'top',key:'desk'};f.work.surfacePoint.set(0,.7,0);f.work.pressing=true;
 f.work.afterPhysics(1/60);assert.equal(f.strokes.length,0);assert.equal(f.work.isWorking,false);f.work.dispose();
});
check('web contact needs spatial proximity, not equal height',()=>{
 const f=fixture('tool.webbrush');f.group.position.set(2,2,0);f.work.headLast.set(1.9,2,0);f.work.touching={kind:'web',id:'web'};f.work.surfacePoint.set(0,2,0);f.work.pressing=true;
 f.work.afterPhysics(1/60);assert.equal(f.effects.includes('web'),false);f.work.dispose();
});
check('the work ray hits the nearest finite web sheet inside its unobstructed reach',()=>{
 const {LifeWorld}=tsLoader({three:T,'./grimeView':{},'./room':{},'@/lib/embodiment/contactAudio':{}})('components/study-space/world/lifeWorld.ts');
 const life=Object.create(LifeWorld.prototype);
 const sheet=(z,yaw)=>{const mesh=new T.Object3D();mesh.position.set(0,2,z);mesh.rotation.y=yaw;return{mesh,web:{size:.5}};};
 life.webs=new Map([['far',sheet(-2,.2)],['near',sheet(-1,.4)]]);
 const ray=new T.Ray(V(.12,2,0),V(0,0,-1)),hit=life.webNear(ray,3);
 assert.equal(hit.id,'near');
 const mesh=life.webs.get('near').mesh;
 assert(Math.abs(hit.at.clone().sub(mesh.position).dot(V(0,0,1).applyQuaternion(mesh.quaternion)))<1e-8);
 assert.equal(life.webNear(ray,.5),null,'a closer obstruction hides the web');
 assert.equal(life.webNear(new T.Ray(V(0,2.6,0),V(0,0,-1)),3),null,'a ray above its finite bounds misses');
 assert.equal(life.webNear(new T.Ray(V(0,2,0),V(1,0,0)),3),null,'passing beside the sheet cannot manufacture contact');
});
check('secondary wrist is measured even when primary wrist fits',()=>{
 const f=fixture('tool.broom');f.work.handAt=1;f.work.lowerAt=.6;f.work.secondOn=true;
 f.work.second=f.work.gripWorld(f.entry,f.work.active.spec,0,-1);f.ch.rig.contactOn=side=>side===-1?f.work.second:null;
 f.ch.rig.handFrame=(side,w,fi,p)=>{const c=side===1?f.work.contactFirst():f.work.second;w.copy(c.wrist);if(side===-1)w.x+=.1;fi.copy(c.fingers);p.copy(c.palm);return true;};
 f.work.afterBody(1/60);assert.ok(f.work.gripSecond>.09);f.work.dispose();
});
check('finger fitting stays on the real handle despite an unreachable palm',()=>{
 const f=fixture('tool.broom');f.work.handAt=1;f.work.gripWorld(f.entry,f.work.active.spec,1,1);
 f.ch.rig.handFrame=(_side,w,fi,p)=>{w.set(.1365,.994,-.072);fi.set(0,0,1);p.set(-1,0,0);return true;};
 f.work.afterBody(1/60);assert.ok(Math.abs(f.work.felt.get(1).point.x)<1e-9);f.work.dispose();
});
check('a different job owns the free hand without tool refits',()=>{
 const f=fixture('tool.broom');f.work.handAt=1;f.work.lowerAt=.6;f.work.secondOn=true;f.work.second={};
 f.ch.rig.contactOn=()=>({});let secondRefits=0;f.ch.rig.refit=side=>{if(side===-1)secondRefits++;};
 f.ch.rig.handFrame=(_side,w,fi,p)=>{w.set(.1365,.994,-.072);fi.set(0,0,1);p.set(-1,0,0);return true;};
 f.work.afterBody(1/60);assert.equal(secondRefits,0);assert.equal(f.work.gripSecond,0);f.work.dispose();
});
check('valid rotated tabletop and glass contacts still clean',()=>{
 for(const glass of [false,true]){
  const f=fixture(),key=glass?'glass':'desk';
  f.life.films.set(key,{surface:{key,x:0,y:.7,z:glass?-2:0,rotY:Math.PI/4},field:{w:1,d:.4}});
  f.group.position.set(.1,.7,glass?-2:.1);f.work.headLast.set(.08,.7,glass?-2:.1);
  f.work.touching={kind:glass?'glass':'top',key};f.work.surfacePoint.set(0,.7,glass?-2:0);if(glass)f.work.surfaceNormal.set(0,0,1);f.work.pressing=true;
  f.work.afterPhysics(1/60);assert.equal(f.strokes.length,1);assert.equal(f.work.isWorking,true);f.work.dispose();
 }
});
check('a tilted floor brush cleans at its moving strands and never from the air',()=>{
 const f=fixture('tool.mop'), geometry=new T.BufferGeometry();
 geometry.setAttribute('position',new T.Float32BufferAttribute([0,-.08,0,.05,0,0,.05,0,.02],3));
 const strands=new T.Mesh(geometry);f.group.add(strands);f.group.userData.care={Strands:strands};
 strands.rotation.z=Math.PI/6;
 f.life.mop=(a,b)=>f.strokes.push([a,b]);
 f.work.pressing=true;
 const sample=(x,y)=>{
  f.group.position.set(x,y,0);f.work.touching={kind:'floor'};f.work.surfacePoint.set(x,0,0);
  f.work.afterPhysics(1/60);
 };
 sample(0,.20);sample(.1,.08);
 assert.equal(f.strokes.length,0,'landing does not draw a stroke through the air');
 sample(.2,.08);
 assert.equal(f.strokes.length,1);assert.ok(Math.abs(f.strokes[0][1].x-.24)<1e-6);
 sample(.4,.22);assert.equal(f.strokes.length,1);
 f.work.dispose();geometry.dispose();
});
assert.deepEqual(failures,[],'work feedback regressions');
console.log('tool work physics: force ownership, obstruction, handoff at30/60/120Hz, actual cleaning and work feedback PASS');
