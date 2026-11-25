import assert from 'node:assert/strict';
import * as T from 'three';
import R from '@dimforge/rapier3d-compat';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadCastGeometry } from './lib/load-cast.mjs';
import { tsLoader } from './lib/ts-load.mjs';
await R.init();
const out=resolve(process.argv[2]);mkdirSync(out);
const paths=['src/components/study-space/world/rackMechanism.ts','src/components/study-space/world/physics.ts','src/components/study-space/world/fixedRackSurface.ts','src/components/study-space/world/manipulation.ts','scripts/test-rack-transfer.mjs','public/assets/study-space/study-care-89fcd69a17ce.glb','public/assets/study-space/rack-clips-b26e7d278db0.json'];
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),hashes=()=>Object.fromEntries(paths.map(p=>[p,sha(p)]));
const report={scope:'Runtime driveTool and named spring contacts with actual asset; held pull/return only, no human anatomy/support-release claim.',before:hashes(),rows:[],errors:[]};
const asset=resolve(paths[5]),cache=JSON.parse(readFileSync(paths[6],'utf8')),pack=await loadCastGeometry(asset),sources=new Map();pack.scene.traverse(o=>sources.set(o.userData.name??o.name,o));
const load=tsLoader({three:T}),{StudyPhysics}=load('components/study-space/world/physics.ts'),{prepareRackAsset}=load('components/study-space/world/rackMechanism.ts'),{onRack}=load('lib/study-space/kit.ts');
prepareRackAsset(sources.get('rack.cleaning'),cache,sha(asset));
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z),Q=()=>new T.Quaternion();let ph;
try{
 for(const [kind,yaw,obstacle] of [['tool.broom',.71,false],['tool.mop',0,false],['tool.webbrush',.71,false],['tool.broom',.71,true]]){
  const stage=new T.Group(),rack={obj:{id:'rack',kind:'rack.cleaning',pos:[0,0,0],rotY:yaw,scale:1},group:new T.Group()};rack.group.rotation.y=yaw;rack.group.add(sources.get('rack.cleaning').clone(true));stage.add(rack.group);
  const spot=onRack(rack.obj,kind),tool={obj:{id:'tool',kind,pos:spot.pos,rotY:spot.rotY,scale:1},group:new T.Group()};tool.group.position.fromArray(spot.pos);tool.group.rotation.y=spot.rotY;tool.group.add(sources.get(kind).clone(true));stage.add(tool.group);stage.updateWorldMatrix(true,true);
  ph=new StudyPhysics(R,()=>{});ph.sync([rack,tool],6);ph.pick(tool,[rack,tool],6,1);assert(ph.beginRackTransfer('tool','rack'));const record=ph.bodies.get('tool'),held=ph.holds.get(1),start=ph.pointOf('tool'),rotation=tool.group.quaternion.clone();assert.equal(ph.intentionalRackContacts(record).size,51);
  assert.ok(record.colliders.every(c=>c.collisionGroups()&8),'physical clip collisions remain active');
  const front=V(0,.08,.45).applyAxisAngle(V(0,1,0),yaw);let barrier;
  if(obstacle){const at=start.clone().add(V(0,0,.16).applyAxisAngle(V(0,1,0),yaw));barrier=ph.world.createCollider(R.ColliderDesc.cuboid(.18,.08,.01).setTranslation(...at.toArray()).setRotation(Q().setFromAxisAngle(V(0,1,0),yaw)).setCollisionGroups((1<<16)|2|8));}
  let phase='pull',stable=0,frames=0,peakLead=0,peakAfter=0,furthest=0,deepest=0;const costs=[];
  for(;frames<6500;frames++){
   const goal=phase==='pull'?start.clone().add(front):start.clone(),pose=ph.poseAt('tool',goal,rotation.clone().multiply(record.q0.clone().invert())),at=ph.pointOf('tool');
   const begin=performance.now(),br=record.body.rotation(),bodyQ=new T.Quaternion(br.x,br.y,br.z,br.w);
   // Transfer ownership persists during clear motion. The2.5mm force lead
   // applies when the exact full sweep meets the rack, as before; independently
   // prove a larger lead is admitted only for a completely clear sweep.
   const touches=ph.toolMotionFraction(record,at,bodyQ,goal,rotation.clone().multiply(record.q0.clone().invert()),true,false)<1-1e-7;
   ph.driveTool(1,'tool',pose.position,rotation,1/60,true);
   if(touches)peakLead=Math.max(peakLead,held.target.distanceTo(at));
   else assert(ph.toolMotionFraction(record,at,bodyQ,held.target,held.rotation,true,false)>=1-1e-7,'free drive has full clearance');
   ph.update(1/60);costs.push(performance.now()-begin);
   const actual=ph.pointOf('tool');peakAfter=Math.max(peakAfter,held.target.distanceTo(actual));furthest=Math.max(furthest,actual.clone().sub(start).dot(front.clone().normalize()));
   if(barrier&&frames%10===0)for(const c of record.colliders){const h=barrier.contactCollider(c,.01);if(h)deepest=Math.min(deepest,h.distance);}
   const v=record.body.linvel(),w=record.body.angvel();stable=actual.distanceTo(goal)<.005&&Math.hypot(v.x,v.y,v.z)<.01&&Math.hypot(w.x,w.y,w.z)<.01?stable+1:0;
   if(stable>=21){if(phase==='pull'){phase='return';stable=0;assert(ph.beginRackTransfer('tool','rack'));}else break;}
   if(obstacle&&frames>=1400)break;
   if(frames%600===0)console.log(JSON.stringify({kind,yaw,obstacle,frames,phase,miss:actual.distanceTo(goal)}));
  }
  costs.sort((a,b)=>a-b);const row={kind,yaw,obstacle,frames,phase,peakLead,peakAfter,furthest,deepest,p50:costs[Math.floor(costs.length*.5)],p95:costs[Math.floor(costs.length*.95)],miss:ph.pointOf('tool').distanceTo(start)};report.rows.push(row);console.log(JSON.stringify(row));
  assert(peakLead<=.00250001);assert(record.body.isCcdEnabled());
  if(obstacle){assert(furthest<.16);assert(deepest>-.001);assert.equal(phase,'pull');}
  else{assert.equal(phase,'return');assert(frames<6500);assert(row.miss<.005);}
  ph.endRackTransfer('tool');assert.equal(ph.intentionalRackContacts(record).size,0);ph.dispose();ph=null;
 }
}catch(e){report.errors.push(String(e.stack??e));process.exitCode=1;}finally{ph?.dispose();report.after=hashes();report.sourceUnchanged=JSON.stringify(report.before)===JSON.stringify(report.after);report.pass=report.rows.length===4&&!report.errors.length&&report.sourceUnchanged;writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({pass:report.pass,errors:report.errors}));}
