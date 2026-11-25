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
const files=['src/components/study-space/world/physics.ts','src/components/study-space/world/rigidToolSurface.ts','src/components/study-space/world/fixedRackSurface.ts','scripts/test-fixed-rack-surface.mjs','public/assets/study-space/study-care-aad100a0a3cc.glb'].map(p=>resolve(frontend,p));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),hashes=()=>Object.fromEntries(files.map(p=>[p,sha(p)]));
const report={scope:'Current static rack partition, independent source contacts, lifecycle and bounded CCD stepping. Clips still static; no extraction/support/gameplay acceptance.',before:hashes(),cases:[],contacts:0,maxError:0,errors:[]};
for(const p of files.slice(0,-1))writeFileSync(resolve(out,basename(p)),readFileSync(p),{flag:'wx'});
const load=tsLoader({three:T}),{StudyPhysics}=load('components/study-space/world/physics.ts'),{onRack}=load('lib/study-space/kit.ts');
const pack=await loadCastGeometry(files.at(-1)),sources=new Map();pack.scene.traverse(o=>{if(['rack.cleaning','tool.broom','tool.mop','tool.webbrush'].includes(o.userData.name??o.name))sources.set(o.userData.name??o.name,o);});
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z),Q=()=>new T.Quaternion();let ph;
try{
 for(const yaw of [0,.713,2.371])for(const scale of [.8,1,1.2]){
  const stage=new T.Group();stage.position.set(.8,-.2,.6);stage.rotation.y=.43;stage.scale.setScalar(1.1);
  const rack={obj:{id:'rack',kind:'rack.cleaning',pos:[.31,0,-.42],rotY:yaw,scale},group:new T.Group()};rack.group.add(sources.get('rack.cleaning').clone(true));rack.group.position.fromArray(rack.obj.pos);rack.group.rotation.y=yaw;rack.group.scale.setScalar(scale);stage.add(rack.group);stage.updateWorldMatrix(true,true);
  ph=new StudyPhysics(R,()=>{});ph.sync([rack],6);
  const record=ph.solids.get('rack');assert.equal(record.colliders.length,19,'eleven fixed surfaces and eight static fingers');assert.ok(record.colliders.every(c=>ph.solidOf_.get(c.handle)==='rack'));
  assert.equal(record.colliders.reduce((n,c)=>n+c.shape.indices.length/3,0),1300,'96 wholly covered source degenerates only');
  const triangles=[];rack.group.traverse(o=>{if(!o.isMesh||o.userData.blob||o.userData.noCollision)return;const a=o.geometry.attributes.position,ix=o.geometry.index,m=stage.matrixWorld.clone().invert().multiply(o.matrixWorld),local=Array.from({length:a.count},(_,i)=>V().fromBufferAttribute(a,i)),points=local.map(p=>p.clone().applyMatrix4(m));for(let i=0;i<ix.count;i+=3){const ids=[ix.getX(i),ix.getX(i+1),ix.getX(i+2)];if(new T.Triangle(...ids.map(j=>local[j])).getArea()>0)triangles.push(new T.Triangle(...ids.map(j=>points[j])));}});
  assert.equal(triangles.length,1300);
  for(const triangle of triangles)for(const sign of [-1,1]){
   const at=triangle.getMidpoint(V()).addScaledVector(triangle.getNormal(V()),sign*.00015),expected=Math.min(...triangles.map(t=>t.closestPointToPoint(at,V()).distanceTo(at)))-.00025;
   const hits=record.colliders.map(c=>c.contactShape(new R.Ball(.00025),at,Q(),.002)).filter(Boolean);assert.ok(hits.length,'every source face remains physical');const error=Math.abs(Math.min(...hits.map(h=>h.distance))-expected);report.maxError=Math.max(report.maxError,error);assert.ok(error<1e-6,`source contact ${yaw}/${scale}: ${error}`);report.contacts++;
  }
  ph.sync([rack],6);assert.equal(ph.solids.get('rack'),record,'unchanged sync reuses all surfaces');
  rack.group.position.x+=.07;ph.sync([rack],6);assert.notEqual(ph.solids.get('rack'),record);assert.equal(ph.solidOf_.size,19,'move rebuilds without orphan owners');assert.equal(ph.world.colliders.len(),25,'nineteen rack surfaces plus five room surfaces and the furniture footprint');
  const moved=ph.solids.get('rack');rack.obj.hidden=true;ph.sync([rack],6);assert.equal(ph.solids.size,0);assert.equal(ph.solidOf_.size,0);assert.ok(moved.colliders.every(c=>!c.isValid()));
  rack.obj.hidden=false;ph.sync([rack],6);assert.equal(ph.solids.get('rack').colliders.length,19);
  // Replacing the entire group at the same pose must also invalidate geometry.
  const old=rack.group;stage.remove(old);rack.group=old.clone(true);stage.add(rack.group);stage.updateWorldMatrix(true,true);const before=ph.solids.get('rack');ph.sync([rack],6);assert.notEqual(ph.solids.get('rack'),before);assert.equal(ph.world.colliders.len(),25);
  ph.sync([],6);assert.equal(ph.solids.size,0);assert.equal(ph.solidOf_.size,0);ph.dispose();ph=null;report.cases.push({yaw,scale,parts:19,contacts:2600,lifecycle:true});
 }
 // Real tools, source geometry and CCD in the active rack. This intentionally
 // does not bypass the static clips or assert a successful extraction.
 report.stepping=[];
 for(const kind of ['tool.broom','tool.mop','tool.webbrush']){
  const stage=new T.Group(),rack={obj:{id:'rack',kind:'rack.cleaning',pos:[0,0,0],rotY:0,scale:1},group:new T.Group()};rack.group.add(sources.get('rack.cleaning').clone(true));stage.add(rack.group);const spot=onRack(rack.obj,kind),entry={obj:{id:'tool',kind,pos:spot.pos,rotY:spot.rotY,scale:1},group:new T.Group()};entry.group.add(sources.get(kind).clone(true));entry.group.position.fromArray(spot.pos);entry.group.rotation.y=spot.rotY;stage.add(entry.group);stage.updateWorldMatrix(true,true);ph=new StudyPhysics(R,()=>{});ph.sync([rack,entry],6);ph.pick(entry,[rack,entry],6,1);const r=ph.bodies.get('tool'),hold=ph.holds.get(1),cost=[];hold.target.copy(ph.pointOf('tool')).add(V(0,0,.0025));hold.stationaryTarget=true;hold.rotation=Q();
  for(let i=0;i<60;i++){const start=performance.now();ph.update(1/60);cost.push(performance.now()-start);assert.ok(Object.values(r.body.translation()).every(Number.isFinite));assert.ok(r.body.isCcdEnabled());}
  cost.sort((a,b)=>a-b);report.stepping.push({kind,frames:60,p50:cost[30],p95:cost[57],max:cost.at(-1)});console.log(JSON.stringify(report.stepping.at(-1)));ph.dispose();ph=null;
 }
 // Unknown/procedural art must retain its full ordinary collider.
 ph=new StudyPhysics(R,()=>{});const group=new T.Group();group.add(new T.Mesh(new T.BoxGeometry(.3,.4,.2)));ph.sync([{obj:{id:'fallback',kind:'rack.cleaning',pos:[0,0,0],rotY:0,scale:1},group}],6);assert.equal(ph.solids.get('fallback').colliders.length,1);
}catch(error){report.errors.push(String(error.stack??error));process.exitCode=1;}finally{ph?.dispose();report.after=hashes();report.sourceUnchanged=JSON.stringify(report.before)===JSON.stringify(report.after);report.pass=!report.errors.length&&report.cases.length===9&&report.sourceUnchanged;writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,cases:report.cases.length,contacts:report.contacts,maxError:report.maxError,errors:report.errors}));}
