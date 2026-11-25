// Compare the real runtime's pruned queries with its exhaustive native path.
// Includes authored tools/rack, turning, sensors, obstacle replacement/removal
// and exact contact checks for every omitted triangle in sampled motions.
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
const files=['src/components/study-space/world/physics.ts','src/components/study-space/world/rigidToolSurface.ts','src/components/study-space/world/fixedRackSurface.ts','scripts/test-tool-query-bounds.mjs','public/assets/study-space/study-care-aad100a0a3cc.glb'].map(p=>resolve(frontend,p));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),hashes=()=>Object.fromEntries(files.map(p=>[p,sha(p)]));
const report={scope:'Runtime query filtering versus exhaustive native casts; no articulated-rack, head support or gameplay acceptance.',before:hashes(),cases:[],queries:0,blocked:0,omitted:0,nativeChecks:0,errors:[]};
for(const p of files.slice(0,-1))writeFileSync(resolve(out,basename(p)),readFileSync(p),{flag:'wx'});
const load=tsLoader({three:T}),{StudyPhysics}=load('components/study-space/world/physics.ts'),{onRack}=load('lib/study-space/kit.ts');
const pack=await loadCastGeometry(files.at(-1)),sources=new Map();pack.scene.traverse(o=>{if(['rack.cleaning','tool.broom','tool.webbrush'].includes(o.userData.name??o.name))sources.set(o.userData.name??o.name,o);});
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z),Q=()=>new T.Quaternion(),filter=(2<<16)|27;
let ph;
try{
 const {RigidToolQueryBounds}=load('components/study-space/world/rigidToolSurface.ts');
 const scene=new R.World({x:0,y:0,z:0});
 try {
   const obstacle=scene.createCollider(R.ColliderDesc.cuboid(.01,.01,.01).setTranslation(1,.5,0));
   const part=scene.createCollider(R.ColliderDesc.ball(.015).setTranslation(.5,.5,.866));
   scene.updateSceneQueries();
   const bounds=new RigidToolQueryBounds(R), parts=[part], angle=2*Math.PI/3, chordError=angle**2/8;
   const start=V(.5,.5,Math.sqrt(.75)),end=V(.5,.5,-Math.sqrt(.75));
   const from=Q().setFromAxisAngle(V(0,1,0),-angle/2),to=Q().setFromAxisAngle(V(0,1,0),angle/2);
   const select=()=>bounds.select(scene,parts,start,from,end,to,0xffffffff,()=>true,{angle,chordError});
   assert.deepEqual(select(),parts,'a blocker at the middle of the centre orbit must survive');
   obstacle.setTranslation(V(1,.8,0));scene.updateSceneQueries();
   assert.deepEqual(select(),[],'yaw keeps vertex heights fixed');
 } finally {scene.free();}
 for(const kind of ['tool.broom','tool.webbrush'])for(const yaw of [0,.713,2.371]){
  const stage=new T.Group();stage.position.set(.4,.1,-.3);stage.rotation.y=.51;stage.scale.setScalar(1.1);
  const rack={obj:{id:'rack',kind:'rack.cleaning',pos:[.25,0,-.4],rotY:yaw,scale:1},group:new T.Group()};rack.group.add(sources.get('rack.cleaning').clone(true));rack.group.position.fromArray(rack.obj.pos);rack.group.rotation.y=yaw;stage.add(rack.group);
  const spot=onRack(rack.obj,kind),entry={obj:{id:'tool',kind,pos:spot.pos,rotY:spot.rotY,scale:1},group:new T.Group()};entry.group.add(sources.get(kind).clone(true));entry.group.position.fromArray(spot.pos);entry.group.rotation.y=spot.rotY;stage.add(entry.group);stage.updateWorldMatrix(true,true);
  ph=new StudyPhysics(R,()=>{});ph.sync([rack,entry],6);ph.pick(entry,[rack,entry],6,1);
  const record=ph.bodies.get('tool'),at=ph.pointOf('tool'),nativeQuery=ph.queryParts;
  const bodyHandle=record.body.handle,massOwner=record.collider.handle,mass=JSON.stringify([record.body.mass(),record.body.localCom(),record.body.principalInertia(),record.body.principalInertiaLocalFrame()]);
  const selected=[],cost={bounded:[],exhaustive:[]};
  const compare=(from,fromQ,to,toQ,clearance)=>{
   let start=performance.now();const bounded=ph.toolMotionFraction(record,from,fromQ,to,toQ,clearance);cost.bounded.push(performance.now()-start);
   ph.queryParts=r=>r.colliders;
   start=performance.now();const exhaustive=ph.toolMotionFraction(record,from,fromQ,to,toQ,clearance);cost.exhaustive.push(performance.now()-start);ph.queryParts=nativeQuery;
   assert.equal(bounded,exhaustive,`${kind}/${yaw} exact native query parity`);report.queries++;if(exhaustive<1)report.blocked++;
   selected.push({from:from.toArray(),to:to.toArray(),turn:fromQ.angleTo(toQ),clearance,fraction:bounded});
  };
  const q=Q(),obstacle=ph.world.createCollider(R.ColliderDesc.ball(.035).setTranslation(at.x+.08,at.y,at.z));
  const free=V(1.2,1.6,1.2);
  compare(free,q,free.clone().add(V(.07,.02,.09)),q,true);
  compare(free,q,free.clone().add(V(-.08,0,.05)),Q().setFromEuler(new T.Euler(.04,-.05,.02)),false);
  for(const [i,delta] of [[.12,0,0],[-.12,.04,0],[0,.07,0],[0,0,.16],[.06,.02,-.09]].entries()){
   const to=at.clone().add(V(...delta)),toQ=Q().setFromEuler(new T.Euler(.017*i,-.021*i,.013*i));
   compare(at,q,to,toQ,true);compare(at,q,to,toQ,false);
  }
  // A native shape replacement and live sensor change cannot retain an old BVH.
  const cube=new T.BoxGeometry(.06,.08,.1),vp=cube.attributes.position.array.slice(),ix=Uint32Array.from(cube.index.array);
  obstacle.setShape(new R.TriMesh(vp,ix));ph.stale=true;
  const originalVertices=Array.from(obstacle.shape.vertices),originalIndices=Array.from(obstacle.shape.indices);
  compare(at,q,at.clone().add(V(.12,0,0)),q,true);
  assert.deepEqual(Array.from(obstacle.shape.vertices),originalVertices,'BVH never mutates native vertices');assert.deepEqual(Array.from(obstacle.shape.indices),originalIndices,'BVH never reorders native faces');
  obstacle.setSensor(true);ph.stale=true;compare(at,q,at.clone().add(V(.12,0,0)),q,true);
  obstacle.setTranslation(V(at.x-.12,at.y,at.z));ph.stale=true;compare(at,q,at.clone().add(V(-.15,0,0)),q,true);
  ph.world.removeCollider(obstacle,false);compare(at,q,at.clone().add(V(.12,0,0)),q,true);
  // Unknown shape types conservatively survive instead of being pruned.
  const cylinder=ph.world.createCollider(R.ColliderDesc.cylinder(.08,.03).setTranslation(at.x,at.y,at.z+.08));
  compare(at,q,at.clone().add(V(0,0,.14)),q,true);ph.world.removeCollider(cylinder,false);
  // Independent exhaustive native queries prove each rejected triangle cannot
  // hit the current scene along these translations or at angular endpoints.
  for(const delta of [V(.12,.04,.08),V(-.09,-.02,-.04)]){
   const to=at.clone().add(delta),toQ=Q().setFromEuler(new T.Euler(.023,-.017,.011));
   const kept=new Set(nativeQuery.call(ph,record,at,q,to,toQ,filter));
   for(const part of record.colliders)if(!kept.has(part)){
    report.omitted++;const shape=ph.sweepShape(part,true);
    for(const t of [0,.25,.5,.75,1]){
     const rotation=q.clone().slerp(toQ,t),point=at.clone().lerp(to,t);
     const hit=ph.scene.castShape(at,rotation,delta,shape,1,false,undefined,filter,undefined,record.body,ph.notHeld);
     assert.ok(!hit||hit.toi>=1,'pruned triangle cannot hit along native sweep');
     let intersected=false;ph.scene.intersectionsWithShape(point,rotation,shape,()=>{intersected=true;return false;},undefined,filter,undefined,record.body,ph.notHeld);
     assert.equal(intersected,false,'pruned triangle cannot overlap');report.nativeChecks+=2;
    }
   }
  }
  const percent=(a,p)=>[...a].sort((x,y)=>x-y)[Math.floor((a.length-1)*p)];
  ph.release(1,undefined,true);ph.pick(entry,[rack,entry],6,1);
  assert.equal(ph.bodies.get('tool'),record);assert.equal(record.body.handle,bodyHandle);assert.equal(record.collider.handle,massOwner);
  assert.equal(JSON.stringify([record.body.mass(),record.body.localCom(),record.body.principalInertia(),record.body.principalInertiaLocalFrame()]),mass,'queries preserve full inherited mass and ownership');
  compare(free,q,free.clone().add(V(.07,0,.03)),q,true);
  report.cases.push({kind,yaw,queries:selected,costMs:Object.fromEntries(Object.entries(cost).map(([k,a])=>[k,{p50:percent(a,.5),p95:percent(a,.95)}]))});
  console.log(JSON.stringify({kind,yaw,queries:report.queries,nativeChecks:report.nativeChecks,costMs:report.cases.at(-1).costMs}));
  ph.dispose();ph=null;
 }
 assert.ok(report.omitted>100&&report.blocked>0&&report.blocked<report.queries,'exercise pruning, obstruction and clear paths');
}catch(error){report.errors.push(String(error.stack??error));process.exitCode=1;}finally{ph?.dispose();report.after=hashes();report.sourceUnchanged=JSON.stringify(report.before)===JSON.stringify(report.after);report.pass=!report.errors.length&&report.cases.length===6&&report.sourceUnchanged;writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,queries:report.queries,blocked:report.blocked,omitted:report.omitted,nativeChecks:report.nativeChecks,errors:report.errors}));}
