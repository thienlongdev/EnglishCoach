// Actual Rapier mass lifecycle; cuboid support controls do not qualify the rack.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import * as T from 'three';
import R from '@dimforge/rapier3d-compat';
import {tsLoader} from './lib/ts-load.mjs';
import {loadCastGeometry} from './lib/load-cast.mjs';
await R.init();
const load=tsLoader({three:T}),{StudyPhysics}=load('components/study-space/world/physics.ts');
const {dip,wring,rinse,fillBucket,pourOut,withLevel,VESSELS,massNow}=load('lib/study-space/tools.ts');
const {affordanceOf}=load('lib/study-space/affordances.ts');
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z);
let checks=0;
const ok=(v,message)=>{assert.ok(v,message);checks++;};
const near=(a,b,message)=>ok(Math.abs(a-b)<2e-6*Math.max(1,Math.abs(b)),`${message}: ${a} vs ${b}`);
const vector=(a,b,message)=>{for(const k of ['x','y','z'])near(a[k],b[k],message+' '+k);};
const pack=await loadCastGeometry(fileURLToPath(new URL('../public/assets/study-space/study-care-aad100a0a3cc.glb',import.meta.url)));
let mop;
pack.scene.traverse(o=>{if((o.userData.name??o.name)==='tool.mop')mop=o;});
assert.ok(mop,'active mop mesh exists');
function fixture({kind='tool.mop',state={wet:0},yaw=0,scale=1,support=false}={}){
 const stage=new T.Group(),group=new T.Group();
 if(kind==='tool.mop')group.add(mop.clone(true));
 else {const mesh=new T.Mesh(new T.BoxGeometry(.18,.14,.12));mesh.position.y=.07;group.add(mesh);}
 group.position.y=support?.52:1.5;group.rotation.y=yaw;group.scale.setScalar(scale);stage.add(group);
 const entry={group,obj:{id:'held',kind,pos:group.position.toArray(),rotY:yaw,scale,state}};
 const entries=[entry];
 if(support){
  const rack=new T.Group(),shelf=new T.Mesh(new T.BoxGeometry(.8,.04,.5));shelf.position.y=.5;rack.add(shelf);stage.add(rack);
  entries.unshift({group:rack,obj:{id:'support',kind:'rack.cleaning',pos:[0,0,0],rotY:0,scale:1}});
 }
 stage.updateWorldMatrix(true,true);
 const saves=[],ph=new StudyPhysics(R,(...args)=>saves.push(args));ph.sync(entries,6);ok(ph.pick(entry,entries,6),'pick succeeds');
 if(support){const c=ph.solids.get('support').collider;c.setShape(new R.Cuboid(.4,.02,.25));c.setTranslation(V(0,.5,0));}
 return {ph,entry,entries,group,saves,record:ph.bodies.get('held')};
}
function checkMass(x,state){
 const kg=massNow(x.entry.obj.kind,state,affordanceOf(x.entry.obj.kind).mass);
 near(x.record.body.mass(),kg,'body carries current water mass');near(x.record.kg,kg,'collision bookkeeping uses current mass');
 near(x.record.colliders.reduce((s,c)=>s+c.mass(),0),kg,'compound mass counted exactly once');
 for(const c of x.record.colliders.slice(1))near(c.mass(),0,'secondary collision part has no duplicate mass');
}
// Mutations used by dip/wring/rinse/drying, including repeated cycles. Fresh
// initialization is the oracle for the retained (uncalibrated) inertia model.
for(const yaw of [0,.71,-1.89])for(const scale of [.8,1,1.2]){
 const x=fixture({yaw,scale}),record=x.record,body=record.body,hold=x.ph.holds.get(1);
 const handles=record.colliders.map(c=>c.handle),pose=body.translation(),rotation=body.rotation();
 const com=body.localCom(),target=hold.target.clone();
 body.setLinvel(V(.13,-.02,.07),true);body.setAngvel(V(.03,.04,-.01),true);
 const velocity=body.linvel(),spin=body.angvel();
 for(let cycle=0;cycle<3;cycle++)for(const state of [dip({wet:0,load:.3},{fill:1}).tool,wring({wet:1}),rinse({wet:.55,load:.3}),{wet:0}]){
  x.entry.obj.state=state;x.ph.update(0);checkMass(x,state);
  ok(x.ph.bodies.get('held')===record && record.body===body,'body identity preserved');
  ok(x.ph.holds.get(1)===hold && hold.target.equals(target),'logical grasp and target preserved');
  ok(record.colliders.every((c,i)=>c.handle===handles[i]),'colliders preserved');
  vector(body.translation(),pose,'no mass-change teleport');vector(body.rotation(),rotation,'no mass-change rotation');near(body.rotation().w,rotation.w,'rotation w');
  vector(body.linvel(),velocity,'velocity preserved');vector(body.angvel(),spin,'angular velocity preserved');vector(body.localCom(),com,'existing COM model preserved');
  const fresh=fixture({yaw,scale,state});vector(body.principalInertia(),fresh.record.body.principalInertia(),'same inertia as a fresh identical state');fresh.ph.dispose();
 }
 ok(x.saves.length===0,'no persistence during held mass updates');x.ph.dispose();
}
// Immutable layout replacement must refresh the live entry without rebinding
// its body. Exercise every existing vessel and its actual state helpers.
for(const kind of Object.keys(VESSELS)){
 const x=fixture({kind,state:withLevel(kind,{},0)}),body=x.record.body,hold=x.ph.holds.get(1);
 const states=kind==='tool.bucket'?[fillBucket({}),pourOut({fill:1})]:[withLevel(kind,{},1),withLevel(kind,{},.37),withLevel(kind,{},0)];
 for(const state of states){
  x.entry={group:x.group,obj:{...x.entry.obj,state}};x.entries=[x.entry];x.ph.sync(x.entries,6);checkMass(x,state);
  ok(x.record.entry===x.entry && x.record.body===body && x.ph.holds.get(1)===hold,'replacement preserves live ownership');
 }
 x.ph.dispose();
}
// The retained hand force belongs to the old weight. Remove only that force,
// leaving unrelated forces/torques intact; the next step supplies the new one.
for(const trigger of ['release','update','repick']){
 const x=fixture(),body=x.record.body,hold=x.ph.holds.get(1);
 x.ph.update(1/60);ok(!!hold.force,'hand has applied a force');
 const external=V(.3,.2,-.1),torque=V(.02,-.01,.04);body.addForce(external,true);body.addTorque(torque,true);
 if(trigger==='repick')x.ph.release(1);
 x.entry.obj.state={wet:1};
 if(trigger==='release')x.ph.release(1);
 else if(trigger==='repick')ok(x.ph.pick(x.entry,x.entries,6),'repick refreshes existing body');
 else x.ph.update(0);
 checkMass(x,x.entry.obj.state);
 // Pinned Rapier has no userForce getter: compare the next physical step
 // against a fresh equally loaded body with only the known external inputs.
 const fresh=fixture({state:{wet:1}}),reference=fresh.record.body;fresh.ph.release(1);
 reference.setTranslation(body.translation(),true);reference.setRotation(body.rotation(),true);
 reference.setLinvel(body.linvel(),true);reference.setAngvel(body.angvel(),true);
 reference.addForce(external,true);reference.addTorque(torque,true);
 x.ph.world.step();fresh.ph.world.step();
 vector(body.linvel(),reference.linvel(),'only external force remains after refresh');vector(body.angvel(),reference.angvel(),'external torque survives refresh');
 ok(x.record.body===body && x.saves.length===0,'direct lifecycle refresh preserves body and persistence');fresh.ph.dispose();x.ph.dispose();
}
function supported(x){
 let ready=false;
 for(let i=0;i<180&&!ready;i++){x.ph.update(1/60);ready=x.ph.supportedRelease(1,'support');}
 ok(ready,'measured support reaches the unchanged release gate');return x.ph.holds.get(1).supportTrial;
}
for(const trigger of ['query','update','sync']){
 const x=fixture({kind:'mug',state:{sips:4},support:true}),hold=x.ph.holds.get(1),flags=x.record.colliders.map(c=>c.activeEvents());
 const before=supported(x);ok(before.time>=.35 && before.load>0,'prior physical proof exists');
 // State unrelated to mass must not repeatedly destroy accumulated evidence.
 x.entry.obj.state={sips:4,load:.2};x.ph.update(0);
 ok(hold.supportTrial===before,'unchanged mass retains proof');
 x.entry.obj.state={sips:0};
 if(trigger==='query')ok(!x.ph.supportedRelease(1,'support'),'query cannot accept stale weight proof');
 else if(trigger==='sync')x.ph.sync(x.entries,6);else x.ph.update(0);
 checkMass(x,x.entry.obj.state);ok(!hold.supportTrial || hold.supportTrial.time===0,'weight change discards elapsed support time');
 ok(!hold.supportTrial || hold.supportTrial.load===0,'weight change discards old support force');
 x.ph.cancelSupportedRelease(1);ok(x.record.colliders.every((c,i)=>c.activeEvents()===flags[i]),'exact event subscriptions restored');
 supported(x);x.entry.obj.state={sips:4};ok(!x.ph.supportedRelease(1,'support'),'increased weight also invalidates proof');
 supported(x);x.ph.release(1,undefined,true);ok(x.ph.owns('held'),'supported release retains settlement ownership');
 for(let i=0;i<120;i++)x.ph.update(1/60);
 ok(x.saves.length===1,'fresh proof settles and persists once');x.ph.dispose();
}
// Updating a released body must wake it and invalidate old settlement history.
{
 const x=fixture();x.ph.release(1);const body=x.record.body;
 x.record.time=7.9;x.record.restT=.31;body.sleep();x.entry.obj.state={wet:1};x.ph.update(0);
 checkMass(x,x.entry.obj.state);ok(!body.isSleeping(),'new load wakes released body');
 ok(x.record.time===0 && x.record.restT===0,'settlement must observe the new load');
 ok(x.ph.owns('held') && x.saves.length===0,'old rest history cannot save changed load');x.ph.dispose();
}
console.log(`physics-mass: ${checks} actual-mop/state/ownership/support checks PASS`);
