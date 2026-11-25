// Current application boundary integration against independently loaded source
// triangles and the preserved pre-integration mass/lifecycle implementation.
import assert from 'node:assert/strict';
import * as T from 'three';
import R from '@dimforge/rapier3d-compat';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadCastGeometry} from './lib/load-cast.mjs';
import {tsLoader} from './lib/ts-load.mjs';
await R.init();
const frontend=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(process.argv[2]);mkdirSync(out);
const reference=resolve(frontend,'../docs/study-space/echo-life-6-20261108/recovery-checkpoint-at/before/frontend/src/components/study-space/world/physics.ts');
const files=[reference,...['src/components/study-space/world/physics.ts','src/components/study-space/world/rigidToolSurface.ts','scripts/test-rigid-tool-surface.mjs','public/assets/study-space/study-care-aad100a0a3cc.glb'].map(p=>resolve(frontend,p))];
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),hashes=()=>Object.fromEntries(files.map(p=>[p,sha(p)]));
const report={scope:'Current-source boundary geometry, exact inherited mass/COM/inertia, CCD and body/owner lifecycle; not rack mechanism, flexible-head support or humanoid gameplay acceptance.',before:hashes(),cases:[],contacts:0,maxContactError:0,errors:[]};
for(const p of files.filter(p=>/\.(mjs|ts)$/.test(p)))writeFileSync(resolve(out,p===reference?'physics-before.ts':basename(p)),readFileSync(p),{flag:'wx'});
const load=tsLoader({three:T}),Current=load('components/study-space/world/physics.ts').StudyPhysics,Previous=load(reference).StudyPhysics;
const pack=await loadCastGeometry(files.at(-1)),sources=new Map();pack.scene.traverse(o=>{if(['tool.broom','tool.webbrush'].includes(o.userData.name??o.name))sources.set(o.userData.name??o.name,o);});
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z),state=r=>JSON.stringify({mass:r.body.mass(),com:r.body.localCom(),inertia:r.body.principalInertia(),frame:r.body.principalInertiaLocalFrame()});
let current,previous;
try{
 for(const kind of ['tool.broom','tool.webbrush'])for(const yaw of [0,.713,2.371])for(const scale of [.8,1,1.2]){
  const tilt=yaw===.713?.17:yaw===2.371?-.28:0;
  const create=Physics=>{const stage=new T.Group();stage.position.set(1.1,-.3,.7);stage.rotation.y=.41;const group=new T.Group();group.add(sources.get(kind).clone(true));group.position.set(.4,.1,-.6);group.rotation.set(tilt,yaw,0,'YXZ');group.scale.setScalar(scale);stage.add(group);stage.updateWorldMatrix(true,true);const entry={obj:{id:'tool',kind,pos:group.position.toArray(),rotY:yaw,scale},group};const ph=new Physics(R,()=>{});ph.sync([entry],6);ph.pick(entry,[entry],6,1);ph.bodies.get('tool').body.recomputeMassPropertiesFromColliders();return {ph,entry,stage};};
  const a=create(Current),b=create(Previous);current=a.ph;previous=b.ph;
  const record=current.bodies.get('tool'),old=previous.bodies.get('tool'),mass=state(record);assert.equal(mass,state(old),'inherited mass, COM and full principal frame are unchanged');
  const surfaces=record.colliders.filter(c=>c.shape instanceof R.Triangle),expected=kind==='tool.broom'?840:272;assert.equal(surfaces.length,expected);assert.equal(record.colliders.length,old.colliders.length-1+expected);
  assert.equal(record.colliders.filter(c=>c.mass()>0).length,1);assert.equal(record.collider,record.colliders[0]);assert.ok(record.body.isCcdEnabled());
  let mesh;a.entry.group.traverse(o=>{if(o.isMesh&&(o.userData.name??o.name)===(kind==='tool.broom'?'Twine':'Collar'))mesh=o;});
  const transform=a.stage.matrixWorld.clone().invert().multiply(mesh.matrixWorld),attr=mesh.geometry.attributes.position,index=mesh.geometry.index,center=record.body.translation(),origin=V(center.x,center.y,center.z);
  // Keep source coordinates in double precision for the independent oracle.
  const points=Array.from({length:attr.count},(_,i)=>V().fromBufferAttribute(attr,i).applyMatrix4(transform).sub(origin));
  const triangles=Array.from({length:index.count/3},(_,i)=>new T.Triangle(...[0,1,2].map(j=>points[index.getX(i*3+j)]))).filter(t=>t.getArea()>1e-16);assert.equal(triangles.length,expected);
  for(const q of [new T.Quaternion(),new T.Quaternion().setFromEuler(new T.Euler(.37,-1.19,.23))]){
   record.body.setRotation(q,true);current.stale=true;current.scene;
   for(let i=0;i<triangles.length;i++){
    const tri=triangles[i],c=surfaces[i],query=current.sweepShape(c,true);assert.ok(query instanceof R.RoundTriangle);assert.equal(query.borderRadius,.003);
    for(const sign of [-1,1]){
     const at=tri.getMidpoint(V()).addScaledVector(tri.getNormal(V()),sign*.00015).applyQuaternion(q).add(origin),hit=c.contactShape(new R.Ball(.00025),at,new T.Quaternion(),.002);assert.ok(hit,'each source triangle remains contactable from both sides');
     const error=Math.abs(hit.distance+.0001);report.maxContactError=Math.max(report.maxContactError,error);assert.ok(error<1e-6,`${kind}/${yaw}/${scale}/${i}: ${error}`);report.contacts++;
    }
   }
  }
  const handle=record.body.handle,owner=record.collider.handle;current.release(1,undefined,true);current.pick(a.entry,[a.entry],6,1);assert.equal(current.bodies.get('tool'),record);assert.equal(record.body.handle,handle);assert.equal(record.collider.handle,owner);assert.equal(state(record),mass);assert.ok(record.colliders.every(c=>current.colliderOf.get(c.handle)==='tool'));
  report.cases.push({kind,yaw,scale,triangles:expected,totalColliders:record.colliders.length,massPreserved:true,bodyAndMassOwnerReused:true,ccd:true});current.dispose();assert.equal(current.colliderOf.size,0);current=null;previous.dispose();previous=null;
 }
}catch(error){report.errors.push(String(error.stack??error));process.exitCode=1;}finally{current?.dispose();previous?.dispose();report.after=hashes();report.sourceUnchanged=JSON.stringify(report.before)===JSON.stringify(report.after);report.pass=report.errors.length===0&&report.cases.length===18&&report.sourceUnchanged;writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,cases:report.cases.length,contacts:report.contacts,maxContactError:report.maxContactError,errors:report.errors}));}
