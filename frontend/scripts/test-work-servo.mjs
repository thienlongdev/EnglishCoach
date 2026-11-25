// A feedback-bounded command is not an independently moving hand trajectory.
// Its derivative must not feed the body's own velocity back as extra intent.
import assert from 'node:assert/strict';
import * as T from 'three';
import R from '@dimforge/rapier3d-compat';
import {tsLoader} from './lib/ts-load.mjs';
await R.init();
const {StudyPhysics}=tsLoader({three:T})('components/study-space/world/physics.ts');
const rows=[];
for(const hz of [10,30,60,90,120,144,'mixed']){
 const group=new T.Group();group.position.set(0,1.5,0);group.add(new T.Mesh(new T.BoxGeometry(.1,.5,.1)));
 const entry={group,obj:{id:'servo',kind:'tool.broom',pos:[0,1.5,0],rotY:0,scale:1}},ph=new StudyPhysics(R,()=>{});
 ph.sync([entry],6);ph.pick(entry,[entry],6,1);
 const body=ph.bodies.get('servo').body,q0=ph.startOf('servo'),goal=new T.Vector3(.7,1.5,0),end=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),1.6);
 let time=0,frame=0,maxLinear=0,maxAngular=0;
 while(time<8){
  const dt=hz==='mixed'?[1/144,1/90,1/120,1/30][frame++%4]:1/hz;
  const p=body.translation(),r=body.rotation(),at=new T.Vector3(p.x,p.y,p.z),q=new T.Quaternion(r.x,r.y,r.z,r.w).multiply(q0);
  const seconds=ph.motionStepSeconds?.(dt)??dt;
  const rotation=q.rotateTowards(end,.8*seconds),center=at.clone().add(goal.clone().sub(at).clampLength(0,.35*seconds));
  const pose=ph.poseAt('servo',center,rotation.clone().multiply(q0.clone().invert()));
  ph.driveTool(1,'servo',pose.position,rotation,dt,false,true);ph.update(dt);time+=dt;
  const v=body.linvel(),w=body.angvel();maxLinear=Math.max(maxLinear,Math.hypot(v.x,v.y,v.z));maxAngular=Math.max(maxAngular,Math.hypot(w.x,w.y,w.z));
 }
 const row={hz,maxLinear,maxAngular,positionError:ph.pointOf('servo').distanceTo(goal),angleError:group.quaternion.angleTo(end)};rows.push(row);ph.dispose();
}
console.log(JSON.stringify(rows));
if(!process.argv.includes('--observe'))for(const row of rows){
 assert(row.maxLinear<=.40,`${row.hz}Hz: .35m/s command must not self-accelerate: ${row.maxLinear}`);
 assert(row.maxAngular<=.9,`${row.hz}Hz: .8rad/s command must not self-accelerate: ${row.maxAngular}`);
 assert(row.positionError<.005,`${row.hz}Hz: retain5mm arrival`);
 assert(row.angleError<.015,`${row.hz}Hz: retain.015rad arrival`);
}
// The command remains a force, including when its path is blocked. No solver
// stabilization may turn into a pose write or remove physical collisions.
for(const hz of [30,60,144]){
 const group=new T.Group();group.position.set(0,1,0);group.add(new T.Mesh(new T.BoxGeometry(.1,.1,.1)));
 const entry={group,obj:{id:'wall-test',kind:'tool.broom',pos:[0,1,0],rotY:0,scale:1}},ph=new StudyPhysics(R,()=>{});
 ph.sync([entry],6);ph.pick(entry,[entry],6,1);
 const record=ph.bodies.get(entry.obj.id),wall=ph.world.createCollider(R.ColliderDesc.cuboid(.025,.8,.4).setTranslation(.3,1,0));
 let deepest=0;
 for(let i=0;i<hz*3;i++){
  const at=ph.pointOf(entry.obj.id),to=at.clone().add(new T.Vector3(.6,1,0).sub(at).clampLength(0,.35*ph.motionStepSeconds(1/hz)));
  ph.driveTool(1,entry.obj.id,to,new T.Quaternion(),1/hz,false,true);ph.update(1/hz);
  for(const c of record.colliders){assert.notEqual(c.collisionGroups()&0xffff,0);const hit=wall.contactShape(c.shape,record.body.translation(),record.body.rotation(),.01);if(hit)deepest=Math.min(deepest,hit.distance);}
 }
 assert(deepest>-.003,`${hz}Hz bounded motion keeps3mm collision gate: ${deepest}`);
 assert(group.position.x>.20&&group.position.x<.23,'bounded motion reaches the obstacle without tunnelling');
 ph.resumeHeld(1);assert.equal(ph.holds.get(1).motionTarget,false);ph.dispose();
}
console.log('work servo: bounded intent, rate invariance, collision and carry handoff PASS');
