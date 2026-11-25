// Actual Rapier + care meshes: compound shapes must preserve every rigid part,
// total mass, motion constraints and lifecycle. This is not rack gameplay QA.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import * as T from 'three';
import R from '@dimforge/rapier3d-compat';
import {loadCastGeometry} from './lib/load-cast.mjs';
import {tsLoader} from './lib/ts-load.mjs';
await R.init();
const load=tsLoader({three:T}),{StudyPhysics}=load(process.env.COLLIDER_SOURCE??'components/study-space/world/physics.ts');
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z);
let checks=0;
function ok(value,why){assert.ok(value,why);checks++;}
function fixture(group,api=R,kind='tool.broom'){
 const stage=new T.Group();stage.add(group);stage.updateWorldMatrix(true,true);
 const entry={group,obj:{id:'tool',kind,pos:group.position.toArray(),rotY:group.rotation.y,scale:1}};
 const saves=[],ph=new StudyPhysics(api,(...v)=>saves.push(v));ph.sync([entry],8);
 ok(ph.pick(entry,[entry],8,1),'tool attaches');
 return {ph,entry,r:ph.bodies.get('tool'),saves};
}
function pair(nested=false,count=2){
 const g=new T.Group();g.position.y=1.5;
 const first=new T.Mesh(new T.BoxGeometry(.1,.1,.1));g.add(first);
 for(let i=1;i<count;i++){const m=new T.Mesh(new T.BoxGeometry(.1,.1,.1));m.position.x=.6*i;(nested?first:g).add(m);}
 return g;
}
// A mesh can parent another mesh. Its collider must not swallow that child's
// empty gap a second time, turning the compound back into one broad wedge.
{
 const {ph,r}=fixture(pair(true));
 ok(r.colliders.length===2,'nested authored meshes retain two rigid parts');
 const xs=Array.from(r.colliders[0].shape.vertices).filter((_,i)=>i%3===0);
 ok(Math.max(...xs)-Math.min(...xs)<.101,'parent part excludes descendant mesh');
 ph.dispose();
}
// A rejected/throwing part must fall back to the complete object, never quietly
// leave that part with no collider. No partial compound is an accepted shape.
for(const throws of [false,true]){
 let calls=0;
 const desc=Object.create(R.ColliderDesc);
 desc.convexHull=points=>{if(++calls===2){if(throws)throw Error('invalid authored hull');return null;}return R.ColliderDesc.convexHull(points);};
 desc.convexMesh=(points,indices)=>{if(++calls===2){if(throws)throw Error('invalid authored hull');return null;}return R.ColliderDesc.convexMesh(points,indices);};
 const {ph,r}=fixture(pair(),{...R,ColliderDesc:desc});
 ok(r.colliders.length===1,'failed part falls back atomically');
 const xs=Array.from(r.colliders[0].shape.vertices).filter((_,i)=>i%3===0);
 ok(Math.max(...xs)-Math.min(...xs)>.69,'fallback retains the rejected part extent');
 ph.dispose();
}
{
 const {ph,r}=fixture(pair(false,13));
 ok(r.colliders.length===1,'part budget uses the complete aggregate fallback');ph.dispose();
}
{
 const {ph,r}=fixture(pair());
 // This post meets only the second part, not the first; the grip may not cross.
 const post=ph.world.createCollider(R.ColliderDesc.cuboid(.08,.08,.04).setTranslation(.6,1.5,.3));
 const f=ph.heldMotionFraction(V(),V(0,0,.6),0);
 ok(f>.2&&f<.5,'secondary part constrains linear movement: '+f);
 ok(ph.heldMotionFraction(V(),V(0,0,-.3),0)===1,'clear retreat remains admitted');
 ok(r.colliders.every(c=>!ph.notHeld(ph.world.getCollider(c.handle))),'all held parts excluded from self queries');
 ph.world.removeCollider(post,false);
 ok(ph.heldMotionFraction(V(),V(0,0,.6),0)===1,'removed obstacle leaves the query index');
 // A surface under only the second part must be found by a shape cast.
 const shelf=ph.world.createCollider(R.ColliderDesc.cuboid(.12,.03,.12).setTranslation(.6,1.35,0));
 ok(ph.clearanceAlong('tool',ph.pointOf('tool'))>1.4,'clearance includes secondary rigid part');
 ph.world.removeCollider(shelf,false);
 const angularPost=ph.world.createCollider(R.ColliderDesc.cuboid(.025,.08,.025).setTranslation(0,1.5,-.6));
 const angle=ph.heldMotionFraction(V(),V(),Math.PI);
 ok(angle>.3&&angle<.55,'secondary part constrains rotational arc: '+angle);
 ph.world.removeCollider(angularPost,false);
 ph.dispose();
}
const asset=await loadCastGeometry(fileURLToPath(new URL('../public/assets/study-space/study-care-aad100a0a3cc.glb',import.meta.url)));
for(const kind of ['tool.broom','tool.mop','tool.webbrush'])for(const [scale,yaw,tilt] of [[.7,-2.31,.17],[1,.63,0],[1.3,2.82,-.28]]){
 let source;asset.scene.traverse(o=>{if(o.name===kind||o.userData.name===kind)source=o;});assert.ok(source,kind);
 const group=new T.Group();group.add(source.clone(true));group.scale.setScalar(scale);group.position.set(.3,1.2,-.2);group.rotation.set(tilt,yaw,0,'YXZ');
 const {ph,entry,r,saves}=fixture(group,R,kind);
 const boundaryCount=kind==='tool.broom'?840:kind==='tool.webbrush'?272:0;
 ok(r.colliders.length>1&&r.colliders.length<=12+boundaryCount,kind+' source-bounded parts');
 ok(r.colliders.filter(c=>c.shape instanceof R.Triangle).length===boundaryCount,kind+' exact source boundary triangle count');
 ok(Math.abs(r.body.mass()-r.kg)<1e-6,kind+' mass assigned exactly once');
 const extent=new T.Box3().setFromObject(group).getSize(V()).multiplyScalar(.5);
 const h=[Math.max(.025,extent.x),Math.max(.012,extent.y),Math.max(.025,extent.z)];
 const expect=h.map((_,i)=>Math.max(1e-5,r.kg/3*(h[(i+1)%3]**2+h[(i+2)%3]**2))).sort((a,b)=>a-b);
 const actual=Object.values(r.body.principalInertia()).sort((a,b)=>a-b);
 ok(actual.every((v,i)=>Math.abs(v-expect[i])<1e-6),kind+' inertia not multiplied by part count');
 const handles=r.colliders.map(c=>c.handle);
 ok(handles.every(h=>ph.colliderOf.get(h)==='tool'),kind+' every part routes collision events');
 // Bounds alone missed a tapered phantom handle: sparse support directions
 // kept its bottom and narrowed tip but discarded the full-width upper rings.
 // Every rendered rigid vertex must remain inside its own convex collider,
 // across real asset rotations/scales, not merely inside the aggregate AABB.
 const parts=[];group.traverse(o=>{if(o.isMesh&&!o.userData.noCollision&&!o.userData.blob)parts.push(o);});
 let colliderIndex=0;
 for(let part=0;part<parts.length;part++){
  const mesh=parts[part],a=mesh.geometry.attributes.position,name=mesh.userData.name??mesh.name;
  const count=kind==='tool.broom'&&name==='Twine'?840:kind==='tool.webbrush'&&name==='Collar'?272:0;
  if(count){
   const boundary=r.colliders.slice(colliderIndex,colliderIndex+count);colliderIndex+=count;
   const triangles=boundary.map(c=>{ok(c.shape instanceof R.Triangle,'source boundary uses native triangles');const q=c.rotation(),p=c.translation(),rotation=new T.Quaternion(q.x,q.y,q.z,q.w),origin=V(p.x,p.y,p.z);return new T.Triangle(...[c.shape.a,c.shape.b,c.shape.c].map(v=>V(v.x,v.y,v.z).applyQuaternion(rotation).add(origin)));});
   for(let i=0;i<a.count;i++){const at=V().fromBufferAttribute(a,i).applyMatrix4(mesh.matrixWorld),gap=Math.min(...triangles.map(t=>t.closestPointToPoint(at,V()).distanceTo(at)));ok(gap<.00001,`${kind} ${name} source vertex retained: ${gap}m`);}
   continue;
  }
  const c=r.colliders[colliderIndex++];
  // Descriptor faces index descriptor vertices; raw generated faces index raw
  // generated vertices. Never mix the two when checking archived hull builders.
  const indexed=!!c.shape.indices,vertices=indexed?c.shape.vertices:c.vertices(),indices=indexed?c.shape.indices:c.indices(),cp=c.translation(),cq=c.rotation();
  const q=new T.Quaternion(cq.x,cq.y,cq.z,cq.w),origin=V(cp.x,cp.y,cp.z),points=Array.from({length:vertices.length/3},(_,i)=>V(vertices[i*3],vertices[i*3+1],vertices[i*3+2]).applyQuaternion(q).add(origin));
  const inside=points.reduce((s,p)=>s.add(p),V()).multiplyScalar(1/points.length),planes=[];
  for(let i=0;i<indices.length;i+=3){
   const x=points[indices[i]],y=points[indices[i+1]],z=points[indices[i+2]],normal=y.clone().sub(x).cross(z.clone().sub(x));
   if(normal.lengthSq()<1e-16)continue;normal.normalize();if(normal.dot(inside.clone().sub(x))>0)normal.negate();planes.push({normal,at:x,face:[x,y,z]});
  }
  // Test the actual convex faces directly. Rapier 0.12's point projection can
  // report a distant face even for one of its own boundary vertices.
  let gap=0,worst=null;
  for(let i=0;i<a.count;i++){
   const at=V().fromBufferAttribute(a,i).applyMatrix4(mesh.matrixWorld);
   for(const p of planes){const d=p.normal.dot(at.clone().sub(p.at));if(d>gap){gap=d;worst={point:at.toArray(),face:p.face.map(v=>v.toArray()),normal:p.normal.toArray(),rawGap:Math.max(...points.map(v=>p.normal.dot(v.clone().sub(p.at))))};}}
  }
  ok(planes.length>=4,kind+' physical hull has enclosing faces');
  if(process.env.COLLIDER_TRACE&&gap>=.00001)console.log(JSON.stringify({kind,part,gap,worst,rawVertices:vertices.length,rawIndices:indices.length,inputVertices:c.shape.vertices.length,inputIndices:c.shape.indices?.length,sameVertices:JSON.stringify(Array.from(vertices))===JSON.stringify(Array.from(c.shape.vertices)),sameIndices:JSON.stringify(Array.from(indices))===JSON.stringify(Array.from(c.shape.indices??[]))}));
  ok(gap<.00001,`${kind} ${mesh.userData.name??mesh.name} physical hull covers drawn vertices: ${gap}m`);
 }
 ok(colliderIndex===r.colliders.length,'each physical part belongs to exactly one authored source mesh');
 ph.driveTool(1,'tool',group.position,group.quaternion);
 ok(r.colliders.every(c=>(c.collisionGroups()&0xffff)!==0),'working retains collisions on every part');
 ph.resumeHeld(1);
 ok(r.colliders.every(c=>(c.collisionGroups()&0xffff)!==0),'work→carry restores every part');
 const target=ph.pointOf('tool').clone().add(V(.08,.1,.04));ph.aim(1,target);ph.holdGroupRotation(1,group.quaternion);
 for(let i=0;i<300;i++)ph.update(1/60);
 ok(ph.pointOf('tool').distanceTo(target)<.002,'transformed compound converges without teleport');
 ph.bringToPlace(1);ph.release(1,undefined,true);
 ok(r.colliders.every(c=>(c.collisionGroups()&0xffff)!==0),'still release restores every part');
 if(scale===.7)ph.forget('tool');
 else if(scale===1)ph.sync([],8);
 else ph.flush();
 ok(handles.every(h=>!ph.colliderOf.has(h)&&!ph.world.getCollider(h)),'remove/sync/flush removes every part');
 ok(saves.length===(scale===1.3?1:0),'only explicit flush commits its retained layout');
 ph.dispose();ph.dispose();
 ok(ph.colliderOf.size===0&&ph.holds.size===0,'dispose idempotently releases registries');
}
console.log(`tool colliders: ${checks} checks PASS (not full rack acceptance)`);
