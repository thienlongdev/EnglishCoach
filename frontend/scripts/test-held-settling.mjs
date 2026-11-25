// Real pinned Rapier: hovering targets must settle without a gravity-cycle bias,
// and release must remove the hand force rather than leave a suspended prop.
import assert from 'node:assert/strict';
import * as T from 'three';
import R from '@dimforge/rapier3d-compat';
import {tsLoader} from './lib/ts-load.mjs';
await R.init();
const load=tsLoader({three:T});
const {StudyPhysics}=load('components/study-space/world/physics.ts');
const stage=new T.Group(),group=new T.Group();stage.add(group);
const mesh=new T.Mesh(new T.BoxGeometry(.18,.14,.12));mesh.position.y=.07;group.add(mesh);
const entry={group,obj:{id:'held',kind:'mug',pos:[0,0,0],rotY:0,scale:1}};
const ph=new StudyPhysics(R,()=>{});ph.sync([entry],6);assert.equal(ph.pick(entry,[entry],6),true);
const target=new T.Vector3(.2,1,-.3);ph.aim(1,target);
for(let i=0;i<600;i++)ph.update(1/60);
const actual=ph.pointOf('held'),error=actual.distanceTo(target);
console.log(JSON.stringify({target:target.toArray(),actual:actual.toArray(),error}));
assert.ok(error<.002,'held spring must converge within 2mm without setTranslation');
const body=ph.bodies.get('held').body;
body.addForce({x:.2,y:0,z:0},true);
ph.driveTool(1,'held',group.position,group.quaternion);
ph.release(1,undefined,true);assert.notEqual(ph.bodies.get('held').collider.collisionGroups()&0xffff,0,'release restores tool collisions');
for(let i=0;i<18;i++)ph.update(1/60);
assert.ok(ph.pointOf('held').y<actual.y-.25,'released object falls under gravity');
assert.ok(ph.pointOf('held').x>actual.x+.005,'posing preserves the unrelated horizontal force');
ph.dispose();
// Special placement suppresses the containing solid. A still release must
// restore collisions just as a drop does, including non-tool objects.
{
 const world=new StudyPhysics(R,()=>{});group.position.set(0,1,0);group.quaternion.identity();
 world.sync([entry],6);assert.equal(world.pick(entry,[entry],6),true);
 world.bringToPlace(1);world.release(1,undefined,true);
 assert.notEqual(world.bodies.get('held').collider.collisionGroups()&0xffff,0,'still placement restores object collisions');
 world.dispose();
}
// Ending work without dropping the tool hands its actual pose back to Rapier.
// The next aim must move it and must not retain a stale spring target/velocity.
{
 const world=new StudyPhysics(R,()=>{});group.position.set(0,1,0);group.quaternion.identity();
 world.sync([entry],6);assert.equal(world.pick(entry,[entry],6),true);world.driveTool(1,'held',group.position,group.quaternion);
 const {ToolWork}=load('components/study-space/world/toolWork.ts');
 const work=Object.create(ToolWork.prototype),body={workingBody:true,rig:{setContact:()=>{}}};
 Object.assign(work,{active:{side:1,p:entry},host:{character:()=>body,physics:()=>world},flushState:()=>{},scrape:{set:()=>{}},bendUniform:null});
 const before=world.pointOf('held');work.end();work.end();
 assert.equal(body.workingBody,false);assert.equal(world.heldIn(1),'held','ending tool work retains the held object');
 assert.ok(world.pointOf('held').distanceTo(before)<1e-8,'handoff does not teleport');
 const next=before.clone().add(new T.Vector3(.12,.1,0));world.aim(1,next);
 for(let i=0;i<180;i++)world.update(1/60);
 assert.ok(world.pointOf('held').distanceTo(next)<.002,'tool responds to physical carrying after work ends');
 assert.notEqual(world.bodies.get('held').collider.collisionGroups()&0xffff,0,'tool resumes collision response');
 world.dispose();
}
console.log('held settling: real Rapier equilibrium, release collision and tool handoff PASS');
