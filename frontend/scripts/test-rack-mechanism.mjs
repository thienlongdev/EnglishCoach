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
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const paths=['src/components/study-space/world/rackMechanism.ts','src/components/study-space/world/physics.ts','src/components/study-space/world/fixedRackSurface.ts','src/components/study-space/world/assets.ts','scripts/test-rack-mechanism.mjs','public/assets/study-space/study-care-89fcd69a17ce.glb','public/assets/study-space/rack-clips-b26e7d278db0.json'];
const hashes=()=>Object.fromEntries(paths.map(p=>[p,sha(p)]));
const report={scope:'Actual runtime rack ownership, authored surface preservation, spring motion/rendering, closure, transformed lifecycle and disposal. Not humanoid extraction or supported release.',before:hashes(),rows:[],errors:[]};
const asset=resolve(paths[5]),cache=JSON.parse(readFileSync(paths[6],'utf8'));
const pack=await loadCastGeometry(asset);let source;pack.scene.traverse(o=>{if((o.userData.name??o.name)==='rack.cleaning')source=o;});
const load=tsLoader({three:T}),{StudyPhysics}=load('components/study-space/world/physics.ts'),{prepareRackAsset}=load('components/study-space/world/rackMechanism.ts');
const V=()=>new T.Vector3(),Q=()=>new T.Quaternion();
const surface=root=>{
 root.updateWorldMatrix(true,true);const inv=root.matrixWorld.clone().invert(),rows=[];
 root.traverse(o=>{if(!o.isMesh||o.userData.blob||o.userData.noCollision)return;const a=o.geometry.attributes.position,ix=o.geometry.index,m=inv.clone().multiply(o.matrixWorld);for(let i=0;i<(ix?.count??a.count);i+=3){const face=[0,1,2].map(j=>V().fromBufferAttribute(a,ix?ix.getX(i+j):i+j).applyMatrix4(m).toArray().map(v=>Math.round(v*1e6)).join(','));rows.push(face.join(';'));}});return rows.sort();
};
let ph;
try{
 const original=surface(source);assert.equal(original.length,1396);
 const invalid=source.clone(true);assert.throws(()=>prepareRackAsset(invalid,cache,'wrong'),'wrong cache never changes drawing');assert.deepEqual(surface(invalid),original);
 prepareRackAsset(source,cache,sha(asset));assert.deepEqual(surface(source),original,'every source triangle and winding retained');
 for(const [yaw,scale] of [[0,1],[.713,.8],[2.371,1.2]]){
  const stage=new T.Group();stage.position.set(.8,-.2,.6);stage.rotation.y=.43;stage.scale.setScalar(1.1);
  const rack={obj:{id:'rack',kind:'rack.cleaning',pos:[.31,0,-.42],rotY:yaw,scale},group:new T.Group()};rack.group.add(source.clone(true));rack.group.position.fromArray(rack.obj.pos);rack.group.rotation.y=yaw;rack.group.scale.setScalar(scale);stage.add(rack.group);stage.updateWorldMatrix(true,true);
  ph=new StudyPhysics(R,()=>assert.fail('rack mechanism must not commit unrelated room state'));ph.sync([rack],6);
  const record=ph.solids.get('rack');assert.ok(record.rack);assert.equal(record.rack.fingers.length,8);assert.equal(record.colliders.length,215);assert.equal(ph.solidOf_.size,215);assert.equal(ph.world.bodies.len(),9);
  assert.ok(record.rack.fingers.every(f=>f.body.isCcdEnabled()&&f.joint.contactsEnabled()));
  ph.sync([rack],6);assert.equal(ph.solids.get('rack'),record,'unchanged sync reuses joints and surfaces');
  const f=record.rack.fingers[1],axis=new T.Vector3(0,1,0).applyQuaternion(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),yaw));
  f.body.applyTorqueImpulse(axis.multiplyScalar(.00004*scale**3),true);
  let peak=0,maxDraw=0;
  for(let frame=0;frame<600;frame++){
   ph.update(1/60);record.rack.draw(1);
   const localQ=Q().setFromAxisAngle(new T.Vector3(0,1,0),yaw).invert();const q=f.body.rotation();peak=Math.max(peak,localQ.clone().multiply(new T.Quaternion(q.x,q.y,q.z,q.w)).angleTo(Q()));
   let node;rack.group.traverse(o=>{if(o.userData.rackFinger===1)node=o;});const actual=node.getWorldQuaternion(Q()).normalize(),stageQ=stage.getWorldQuaternion(Q());const expected=stageQ.multiply(new T.Quaternion(q.x,q.y,q.z,q.w)).normalize();maxDraw=Math.max(maxDraw,actual.angleTo(expected));
   assert.ok(Object.values(f.body.translation()).every(Number.isFinite));
  }
  const relative=Q().setFromAxisAngle(new T.Vector3(0,1,0),yaw).invert();const q=f.body.rotation(),closure=relative.multiply(new T.Quaternion(q.x,q.y,q.z,q.w)).angleTo(Q());
  assert.ok(peak>.005,'a physical disturbance moves the visible clip');assert.ok(closure<.005,'same offline closure gate');assert.ok(maxDraw<1e-6,'drawing follows actual joint orientation');
  assert.ok(ph.asleep,'an unused rack must let the room stop physics stepping');
  rack.group.position.x+=.07;ph.sync([rack],6);assert.notEqual(ph.solids.get('rack'),record);assert.equal(ph.world.bodies.len(),9);assert.equal(ph.solidOf_.size,215);
  const moved=ph.solids.get('rack');rack.obj.hidden=true;ph.sync([rack],6);assert.equal(ph.world.bodies.len(),0);assert.equal(ph.solidOf_.size,0);assert.ok(moved.colliders.every(c=>!c.isValid()));
  rack.obj.hidden=false;ph.sync([rack],6);assert.equal(ph.world.bodies.len(),9);ph.sync([],6);assert.equal(ph.world.bodies.len(),0);assert.equal(ph.world.colliders.len(),5);assert.equal(ph.solidOf_.size,0);
  report.rows.push({yaw,scale,peak,closure,maxDraw,colliders:215,frames:600,lifecycle:true});ph.dispose();ph=null;
 }
}catch(e){report.errors.push(String(e.stack??e));process.exitCode=1;}finally{ph?.dispose();report.after=hashes();report.sourceUnchanged=JSON.stringify(report.before)===JSON.stringify(report.after);report.pass=report.rows.length===3&&!report.errors.length&&report.sourceUnchanged;writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report));}
