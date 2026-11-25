// Pinned Rapier: a retained grasp transfers weight to real contacts before
// release. These mechanics checks do not qualify humanoid/rack gameplay.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import * as T from 'three';
import R from '@dimforge/rapier3d-compat';
import {tsLoader} from './lib/ts-load.mjs';
import {loadCastGeometry} from './lib/load-cast.mjs';
await R.init();
const load=tsLoader({three:T}),{StudyPhysics}=load('components/study-space/world/physics.ts');
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z);
let checks=0;
const ok=(v,why)=>{assert.ok(v,why);checks++;};
function fixture({height=.52,yaw=0,slope=0,iterations=4}={}){
 const stage=new T.Group(),support=new T.Group(),group=new T.Group();
 const shelf=new T.Mesh(new T.BoxGeometry(.8,.04,.5));shelf.position.y=.5;support.add(shelf);support.rotation.set(0,yaw,slope);
 const mesh=new T.Mesh(new T.BoxGeometry(.18,.14,.12));mesh.position.y=.07;group.add(mesh);group.position.y=height;group.rotation.y=yaw;
 stage.add(support,group);stage.updateWorldMatrix(true,true);
 const rack={group:support,obj:{id:'support',kind:'rack.cleaning',pos:[0,0,0],rotY:yaw,scale:1}};
 const entry={group,obj:{id:'held',kind:'mug',pos:group.position.toArray(),rotY:yaw,scale:1}};
 const saves=[],ph=new StudyPhysics(R,(...args)=>saves.push(args)),entries=[rack,entry];ph.sync(entries,6);ok(ph.pick(entry,entries,6),'pick succeeds');
 // Positive-control support is an exact cuboid for the drawn box. The actual
 // care-rack fixture below remains unchanged. This isolates release ownership
 // from the pinned convex/trimesh contact jitter, which is not accepted here.
 ph.solids.get('support').collider.setShape(new R.Cuboid(.4,.02,.25));
 ph.solids.get('support').collider.setTranslation(V(0,.5,0));
 ph.solids.get('support').collider.setRotation(support.quaternion);
 ph.world.integrationParameters.numSolverIterations=iterations;
 return {ph,group,support,entries,saves,record:ph.bodies.get('held')};
}
for(const hz of [30,60,120])for(const yaw of [0,.71,-1.89]){
 const x=fixture({yaw}),before=x.group.position.clone();let ready=false,elapsed=0;
 for(let i=0;i<hz*3&&!ready;i++){
  x.ph.update(1/hz);elapsed+=1/hz;ready=x.ph.supportedRelease(1,'support');
  if(process.env.SUPPORT_TRACE && i%10===0){
   const manifolds=[];for(const c of x.record.colliders)x.ph.scene.contactPairsWith(c,o=>x.ph.scene.contactPair(c,o,(m,flipped)=>manifolds.push({id:x.ph.solidOf_.get(o.handle),normal:m.normal(),flipped,contacts:Array.from({length:m.numContacts()},(_,i)=>({distance:m.contactDist(i),impulse:m.contactImpulse(i)}))})));
   console.log(JSON.stringify({i,hz,yaw,trial:x.ph.holds.get(1).supportTrial,reaction:x.ph.supportReaction(x.record,'support'),velocity:x.record.body.linvel(),spin:x.record.body.angvel(),manifolds}));
  }
  ok(x.ph.heldIn(1)==='held','logical grasp remains during load transfer');
 }
 ok(ready,'real base carries weight without hand force');ok(elapsed>=.35,'no immediate time-only release');
 ok(!x.ph.holds.get(1).force,'hand force is absent during support proof');
 ok(x.group.position.distanceTo(before)<.003,'load transfer preserves contact position');
 const load=x.ph.holds.get(1).supportTrial.load;
 ok(load>=x.record.body.mass()*9.81*.95,'measured upward reaction carries weight');
 const eventFlags=x.ph.holds.get(1).supportTrial.events;
 x.ph.release(1,undefined,true);ok(x.ph.owns('held'),'release retains dynamic physics ownership');
 ok(x.record.colliders.every((c,i)=>c.activeEvents()===eventFlags[i]),'release restores exact event subscriptions');
 for(let i=0;i<hz*2;i++)x.ph.update(1/hz);
 ok(x.saves.length===1,'gravity settlement persists once');
 ok(V(...x.saves[0][1]).distanceTo(before)<.003,'saved pose stays supported');
 console.log(JSON.stringify({case:'supported',hz,yaw,elapsed,drift:x.group.position.distanceTo(before),load}));x.ph.dispose();
}
// Installed small-step telemetry is normalized, not granted a lower weight
// threshold. An upwards external force must not masquerade as rack support.
{
 const x=fixture();x.ph.update(1/60);x.ph.supportedRelease(1,'support');
 for(let i=0;i<10;i++){x.ph.update(1/60);x.ph.supportedRelease(1,'support');}
 const measured=x.ph.holds.get(1).supportTrial.load;
 ok(measured>=x.record.body.mass()*9.81*.95,'sleep test begins with real measured support');
 x.record.body.sleep();let ready=false;
 for(let i=0;i<30&&!ready;i++){x.ph.update(1/60);ready=x.ph.supportedRelease(1,'support');}
 ok(ready,'sleep does not erase an unchanged solved support reaction');
 ok(x.ph.holds.get(1).supportTrial.load===measured,'sleep retains measured load rather than inventing weight');
 x.ph.cancelSupportedRelease(1);ok(!x.ph.holds.get(1).supportTrial,'cancel discards the sleeping proof');x.ph.dispose();
}
for(const iterations of [1,2,8]){
 const x=fixture({iterations});let ready=false;
 for(let i=0;i<180&&!ready;i++){x.ph.update(1/60);ready=x.ph.supportedRelease(1,'support');}
 ok(ready,'support passes at solver iterations '+iterations);
 ok(Math.abs(x.ph.holds.get(1).supportTrial.load/(x.record.body.mass()*9.81)-1)<.03,'reaction remains measured weight');x.ph.dispose();
}
{
 const x=fixture();x.record.body.addForce(V(0,x.record.body.mass()*9.81*.5,0),true);let ready=false;
 for(let i=0;i<120;i++){x.ph.update(1/60);ready ||= x.ph.supportedRelease(1,'support');}
 ok(!ready,'partial load bearing is insufficient');x.ph.dispose();
}
// No support, wrong support identity, sensor-only contact and a surface above
// the prop must never let a positional spring be mistaken for load bearing.
for(const condition of ['air','wrong-id','sensor','underside']){
 const x=fixture({height:condition==='air'?.7:condition==='underside'?.34:.52});
 if(condition==='sensor')x.ph.solids.get('support').collider.setSensor(true);
 let ready=false;const before=x.group.position.clone();
 for(let i=0;i<90;i++){x.ph.update(1/60);ready ||= x.ph.supportedRelease(1,condition==='wrong-id'?'other':'support');}
 ok(!ready,condition+' cannot release');ok(x.ph.heldIn(1)==='held',condition+' retains grasp');
 ok(x.group.position.distanceTo(before)<.003,condition+' does not start a blind gravity drop');x.ph.dispose();
}
// Cancel and support removal revoke a partially completed proof. A reattempt
// must earn its own uninterrupted load interval.
for(const action of ['cancel','remove']){
 const x=fixture();x.ph.update(1/60);ok(!x.ph.supportedRelease(1,'support'),'trial starts pending');
 for(let i=0;i<10;i++){x.ph.update(1/60);x.ph.supportedRelease(1,'support');}
 ok(x.ph.holds.get(1).supportTrial?.time>0,'trial has physical history');
 const flags=x.ph.holds.get(1).supportTrial.events;
 if(action==='cancel')x.ph.backInWorld(1);else x.ph.sync([x.entries[1]],6);
 x.ph.update(1/60);
 ok(!x.ph.holds.get(1).supportTrial,'interruption discards support history');
 ok(x.record.colliders.every((c,i)=>c.activeEvents()===flags[i]),'interruption restores exact event subscriptions');
 ok(x.ph.holds.get(1).force?.y>0,'hand resumes load immediately');
 ok(!x.ph.supportedRelease(1,'support'),'interruption cannot complete release');x.ph.dispose();
}
// The actual authored broom has no rigid collision on its visible bristles.
// Its nominal rack pose must be refused, rather than frozen by forgetting it.
{
 const pack=await loadCastGeometry(fileURLToPath(new URL('../public/assets/study-space/study-care-aad100a0a3cc.glb',import.meta.url)));
 const {onRack}=load('lib/study-space/kit.ts'),sources=new Map();
 pack.scene.traverse(o=>{if(['rack.cleaning','tool.broom'].includes(o.userData.name??o.name))sources.set(o.userData.name??o.name,o);});
 const stage=new T.Group(),rack={obj:{id:'rack',kind:'rack.cleaning',pos:[0,0,0],rotY:0,scale:1},group:new T.Group()};rack.group.add(sources.get('rack.cleaning').clone(true));
 const spot=onRack(rack.obj,'tool.broom'),tool={obj:{id:'broom',kind:'tool.broom',pos:spot.pos,rotY:spot.rotY,scale:1},group:new T.Group()};tool.group.add(sources.get('tool.broom').clone(true));tool.group.position.fromArray(spot.pos);stage.add(rack.group,tool.group);stage.updateWorldMatrix(true,true);
 const saves=[],ph=new StudyPhysics(R,(...args)=>saves.push(args)),entries=[rack,tool];ph.sync(entries,6);ok(ph.pick(tool,entries,6),'real broom picked');let ready=false;
 for(let i=0;i<120;i++){ph.update(1/60);ready ||= ph.supportedRelease(1,'rack');}
 ok(!ready,'missing bristle support fails closed');ok(ph.heldIn(1)==='broom','unsupported broom remains held');ok(saves.length===0,'unsupported broom is not persisted');ph.dispose();
}
console.log(`supported-release: ${checks} pinned-Rapier load/ownership/interruption checks PASS`);
