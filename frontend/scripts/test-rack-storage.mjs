// Actual authored hardware, current runtime owner, and strict load transfer.
import assert from 'node:assert/strict';
import * as T from 'three';
import R from '@dimforge/rapier3d-compat';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadCastGeometry} from './lib/load-cast.mjs';
import {tsLoader} from './lib/ts-load.mjs';
process.on('uncaughtException',e=>{console.error(String(e.message??e));process.exitCode=1;});
await R.init();
const frontend=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const build=process.argv[2]?JSON.parse(readFileSync(resolve(process.argv[2]))):null;
const assets=readFileSync(resolve(frontend,'src/components/study-space/world/assets.ts'),'utf8');
const asset=build?.asset??resolve(frontend,'public'+assets.match(/STUDY_CARE_URL='([^']+)'/)[1]);
const cacheFile=build?.clipCache??resolve(frontend,'public'+assets.match(/RACK_CLIP_URL='([^']+)'/)[1]);
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),cache=JSON.parse(readFileSync(cacheFile));assert.equal(hash(asset),cache.sourceSha256);
const sourcePaths=['physics','rackStorage','rackMechanism','fixedRackSurface'].map(n=>resolve(frontend,'src/components/study-space/world/'+n+'.ts'));
const hashes=()=>Object.fromEntries(sourcePaths.map(p=>[p,hash(p)]));
const report={before:hashes(),assetSHA256:hash(asset),scope:'Current runtime keyed-guide engagement, real bearing load, settlement and physical withdrawal/return; not humanoid/browser acceptance.',rows:[]};
const out=process.argv[3]?resolve(process.argv[3]):null;if(out)mkdirSync(out);
const load=tsLoader({three:T}),{StudyPhysics}=load('components/study-space/world/physics.ts'),{prepareRackAsset}=load('components/study-space/world/rackMechanism.ts'),{onRack}=load('lib/study-space/kit.ts');
const pack=await loadCastGeometry(asset),sources=new Map();pack.scene.traverse(o=>sources.set(o.userData.name??o.name,o));prepareRackAsset(sources.get('rack.cleaning'),cache,hash(asset));
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z);
function fixture(kind='tool.broom',yaw=0){
 const stage=new T.Group(),rack={obj:{id:'rack',kind:'rack.cleaning',pos:[0,0,0],rotY:yaw,scale:1},group:new T.Group()};rack.group.rotation.y=yaw;rack.group.add(sources.get('rack.cleaning').clone(true));stage.add(rack.group);
 const spot=onRack(rack.obj,kind),tool={obj:{id:'tool',kind,pos:spot.pos,rotY:spot.rotY,scale:1,...(kind==='tool.mop'?{state:{wet:1}}:{})},group:new T.Group()};tool.group.position.fromArray(spot.pos);tool.group.rotation.y=spot.rotY;tool.group.add(sources.get(kind).clone(true));stage.add(tool.group);stage.updateMatrixWorld(true);
 const saves=[],ph=new StudyPhysics(R,(...row)=>saves.push(row));ph.sync([rack,tool],6);assert(ph.solids.get('rack').storage,'authored hardware is recognized');assert.equal(ph.solids.get('rack').colliders.length,239);assert(ph.pick(tool,[rack,tool],6,1));
 return{ph,tool,rack,saves,record:ph.bodies.get('tool')};
}
let live;
try{
 for(const kind of (process.argv.includes('--cycle-only')?[]:['tool.broom','tool.mop','tool.webbrush']))for(const yaw of [0,.71]){
  const x=live=fixture(kind,yaw),before=x.tool.group.position.clone();let ready=false,seconds=0;
  for(let i=0;i<180&&!ready;i++){x.ph.update(1/60);seconds+=1/60;ready=x.ph.supportedRelease(1,'rack');}
  const guide=x.ph.rackGuides.get('tool'),hold=x.ph.holds.get(1),drift=x.tool.group.position.distanceTo(before);
  assert(guide,'actual key engages the visible sleeve');assert(!guide.joint.limitsEnabled(),'the guide must not carry weight at a vertical stop');
  assert(ready,'real bearings carry the tool for the full interval');assert(seconds>=.35);assert(!hold.force,'no hand force during proof');assert(hold.supportTrial.load>=x.record.body.mass()*9.81*.95);assert(drift<.003);
  const row={kind,yaw,seconds,drift,load:hold.supportTrial.load,weight:x.record.body.mass()*9.81,guideVerticalLimits:false};
  x.ph.release(1,undefined,true);for(let i=0;i<180;i++)x.ph.update(1/60);
  assert.equal(x.saves.length,1);assert(x.tool.group.position.distanceTo(before)<.003);assert.equal(x.ph.rackGuides.size,0,'settlement removes guide/base ownership');
  row.finalDrift=x.tool.group.position.distanceTo(before);report.rows.push(row);console.log(JSON.stringify(row));x.ph.dispose();live=null;
 }
 // Removal cannot retain a phantom sleeve or an old support proof.
 if(!process.argv.includes('--cycle-only')){
  const x=live=fixture();x.ph.update(1/60);assert(x.ph.rackGuides.has('tool'));
  x.ph.supportedRelease(1,'rack');x.ph.sync([x.tool],6);x.ph.update(1/60);
  assert.equal(x.ph.rackGuides.size,0);assert.equal(x.ph.world.bodies.len(),1);assert(!x.ph.supportedRelease(1,'rack'));assert.equal(x.ph.heldIn(1),'tool');
  x.ph.forget('tool');assert.equal(x.ph.world.bodies.len(),0);report.rows.push({case:'support removal',pass:true});x.ph.dispose();live=null;
 }
 // Full native lift-out/pull/return/insert on a rotated rack. No pose writes,
 // disabled collision, hand force during release or vertical joint stop.
 for(const kind of ['tool.broom','tool.mop','tool.webbrush'].filter(k=>!process.env.RACK_TEST_KIND||k===process.env.RACK_TEST_KIND)) for(const yaw of [0,.71]){
  const x=live=fixture(kind,yaw),ph=x.ph,start=ph.pointOf('tool'),q=x.tool.group.quaternion.clone();ph.update(1/60);assert(ph.beginRackTransfer('tool','rack'));
  const initialPose=ph.poseAt('tool',ph.pointOf('tool'),q.clone().multiply(x.record.q0.clone().invert()));
  ph.driveTool(1,'tool',initialPose.position,q,1/60,true);ph.update(1/60);
  assert.equal(ph.holds.get(1).rackTransfer,'rack','waiting for a route preserves support ownership');
  const br=x.record.body.rotation(),bodyQ=new T.Quaternion(br.x,br.y,br.z,br.w),actual=ph.pointOf('tool');
  assert(ph.toolMotionFraction(x.record,actual,bodyQ,actual.clone().add(V(0,-.04,0)),bodyQ,true)<.01,'planner cannot route down through the bearing');
  const lift=ph.rackDeparture('tool','rack'),front=V(0,0,.3).applyAxisAngle(V(0,1,0),yaw),raised=start.clone().add(lift),outside=raised.clone().add(front);
  const goals=[raised,outside,raised,start];let phase=0,steps=0,ready=false,detached=false;const trace=[];
  for(;steps<4000&&!ready;steps++){
   if(phase>=2&&phase<4)assert(ph.beginRackTransfer('tool','rack'));
   if(phase<4){const goal=goals[phase],pose=ph.poseAt('tool',goal,q.clone().multiply(x.record.q0.clone().invert()));ph.driveTool(1,'tool',pose.position,q,1/60,true);}
   ph.update(1/60);
   if(phase===0&&!ph.rackGuides.has('tool'))detached=true;
   if(phase<4){const v=x.record.body.linvel(),w=x.record.body.angvel();if(ph.pointOf('tool').distanceTo(goals[phase])<.0002&&Math.hypot(v.x,v.y,v.z)<.01&&Math.hypot(w.x,w.y,w.z)<.01){phase++;if(phase===2)assert(ph.beginRackTransfer('tool','rack'));}}
   else ready=ph.supportedRelease(1,'rack');
   if(steps%120===0)trace.push({steps,phase,at:ph.pointOf('tool')?.toArray(),target:ph.holds.get(1)?.target.toArray(),transfer:ph.holds.get(1)?.rackTransfer,guide:ph.rackGuides.has('tool')});
  }
  report.rows.push({case:'lift-pull-return-support',kind,yaw,steps,phase,ready,detached,trace});
  if(!ready){
   const contacts=[];
   for(const [i,c] of x.record.colliders.entries())ph.world.contactPairsWith(c,o=>ph.world.contactPair(c,o,(m,flipped)=>{
    for(let j=0;j<m.numContacts();j++)contacts.push({part:i,other:o.handle,solid:ph.solidOf_.get(o.handle),otherPosition:o.translation(),distance:m.contactDist(j),normal:m.normal(),flipped});
   }));
   report.rows.at(-1).contacts=contacts;report.rows.at(-1).lift=lift.toArray();report.rows.at(-1).goals=goals.map(g=>g.toArray());
   report.rows.at(-1).physical={body:x.record.body.translation(),rotation:x.record.body.rotation(),key:x.record.colliders.at(-1).translation(),keyRotation:x.record.colliders.at(-1).rotation(),keyShape:x.record.colliders.at(-1).shape,velocity:x.record.body.linvel(),force:ph.holds.get(1)?.force?.toArray(),bias:ph.holds.get(1)?.rackBias?.toArray()};
  }
  assert(detached,'key clears the guide before horizontal withdrawal');assert(ready,'physical return reaches stable real support');assert(steps<4000);
  assert(x.record.body.isCcdEnabled());assert(x.record.colliders.every(c=>(c.collisionGroups()&65535)!==0));
  ph.release(1,undefined,true);for(let i=0;i<180;i++)ph.update(1/60);
  assert.equal(x.saves.length,1);assert(x.tool.group.position.distanceTo(start.clone().sub(x.record.center.clone().applyQuaternion(q)))<.003);
  assert(ph.pick(x.tool,[x.rack,x.tool],6,1),'settled tool can be regrasped');
  ph.update(1/60);assert(ph.rackGuides.has('tool'),'regrasp restores geometric guide ownership');
  report.rows.at(-1).regrasped=true;
  console.log(JSON.stringify({...report.rows.at(-1),trace:undefined}));x.ph.dispose();live=null;
 }
 report.pass=true;
}catch(e){report.pass=false;report.failure=String(e.stack??e);process.exitCode=1;console.error(report.failure);}
finally{live?.ph.dispose();report.after=hashes();report.sourceUnchanged=JSON.stringify(report.before)===JSON.stringify(report.after);if(!report.sourceUnchanged){report.pass=false;process.exitCode=1;}if(out)writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,cases:report.rows.length,sourceUnchanged:report.sourceUnchanged}));}
