// Real authored rack/tool geometry and Rapier casts. This qualifies translation
// search, not humanoid motion or continuous gameplay.
import assert from 'node:assert/strict';
import * as T from 'three';
import R from '@dimforge/rapier3d-compat';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {loadCastGeometry} from './lib/load-cast.mjs';
import {tsLoader} from './lib/ts-load.mjs';
await R.init();
const load=tsLoader({three:T}),{StudyPhysics}=load('components/study-space/world/physics.ts'),{onRack}=load('lib/study-space/kit.ts');
const care=await loadCastGeometry(fileURLToPath(new URL('../public/assets/study-space/study-care-aad100a0a3cc.glb',import.meta.url)));
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z),sources=new Map();
care.scene.traverse(o=>{if(['rack.cleaning','tool.broom'].includes(o.userData.name??o.name))sources.set(o.userData.name??o.name,o);});
let checks=0;
for(const yaw of [0,.71,-1.89]){
 const stage=new T.Group(),rack={obj:{id:'rack',kind:'rack.cleaning',pos:[.3,0,-1.8],rotY:yaw,scale:1},group:new T.Group()};
 rack.group.add(sources.get('rack.cleaning').clone(true));rack.group.position.fromArray(rack.obj.pos);rack.group.rotation.y=yaw;stage.add(rack.group);
 const spot=onRack(rack.obj,'tool.broom'),tool={obj:{id:'tool',kind:'tool.broom',pos:spot.pos,rotY:spot.rotY,scale:1},group:new T.Group()};
 tool.group.add(sources.get('tool.broom').clone(true));tool.group.position.fromArray(spot.pos);tool.group.rotation.y=spot.rotY;stage.add(tool.group);stage.updateWorldMatrix(true,true);
 const ph=new StudyPhysics(R,()=>{}),entries=[rack,tool];ph.sync(entries,6);ph.pick(tool,entries,6,1);
 const start=ph.pointOf('tool'),q=tool.group.quaternion.clone(),body=ph.bodies.get('tool');
 if(process.env.ROUTE_BENCH){
  for(const c of body.colliders){
   const shapes=[c.shape,new R.ConvexPolyhedron(c.vertices(),c.indices())],times=[];
   for(const shape of shapes){const start=performance.now();for(let i=0;i<200;i++){const raw=shape.intoRaw();raw.free();}times.push(performance.now()-start);}
   console.log(JSON.stringify({phase:'compile-shape',vertices:c.vertices().length,indices:c.indices().length,inputIndices:c.shape.indices?.length,ms:times}));
  }
  ph.dispose();process.exit(0);
 }
 const goal=start.clone().add(V(0,.1,.55).applyAxisAngle(V(0,1,0),yaw));
 const task=ph.toolRoute('tool',goal,q,()=>true),began=performance.now();let result,yields=0;
 if(process.env.ROUTE_REPLAY){
  const saved=readFileSync(process.env.ROUTE_REPLAY,'utf8').split('\n').filter(x=>x.startsWith('{')).map(x=>JSON.parse(x)).find(x=>x.phase==='plan'&&x.yaw===yaw);
  if(!saved)break;
  assert.ok(V(...saved.start).distanceTo(start)<1e-7,'replay must use the same start');
  result={done:true,value:saved.route.map(p=>V(...p))};
 }else do{result=task.next();yields++;}while(!result.done);
 const planMs=performance.now()-began;
 if(process.env.ROUTE_TRACE)console.log(JSON.stringify({phase:'plan',yaw,ms:planMs,yields,start:start.toArray(),goal:goal.toArray(),route:result.value?.map(p=>p.toArray())}));
 assert.ok(ph.pointOf('tool').distanceTo(start)<1e-10,'planning never moves the body');
 if(!result.value){const br=body.body.rotation(),bq=new T.Quaternion(br.x,br.y,br.z,br.w),directions=[];for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){if(!x&&!y&&!z)continue;directions.push({x,y,z,fraction:ph.toolMotionFraction(body,start,bq,start.clone().add(V(x,y,z).multiplyScalar(.04)),bq)});}console.log(JSON.stringify({start:start.toArray(),goal:goal.toArray(),yields,directions}));}
 assert.ok(result.value?.length,'actual rack has a collision-cleared translation route');
 let at=start;const bq=q.clone().multiply(ph.startOf('tool').clone().invert());
 for(const p of result.value){
  assert.ok(ph.toolMotionFraction(body,at,bq,p,bq)>1-1e-7,'every complete part sweep is clear');
  if(process.env.ROUTE_TRACE){
   const count=Math.ceil(at.distanceTo(p)/.001);let deepest=0;
   for(let i=0;i<=count;i++)for(const c of body.colliders){const d=ph.solids.get('rack').collider.contactShape(c.shape,at.clone().lerp(p,i/Math.max(1,count)),bq,.003);if(d)deepest=Math.min(deepest,d.distance);}
   console.log(JSON.stringify({phase:'edge',from:at.toArray(),to:p.toArray(),deepest}));
  }
  at=p;
 }
 assert.ok(at.distanceTo(goal)<1e-10,'route ends at requested goal');
 let next=0,deepest=0,prior=-1;
 for(let frame=0;frame<1200&&next<result.value.length;frame++){
  const center=result.value[next],pose=ph.poseAt('tool',center,bq);
  ph.driveTool(1,'tool',pose.position,q,1/60,true);
  ph.update(1/60);
  if(ph.toolWaypointReached('tool',center,q,result.value[next+1]))next++;
  const contacts=[];
  for(const c of body.colliders){const d=ph.solids.get('rack').collider.contactShape(c.shape,c.translation(),c.rotation(),.003);if(d){deepest=Math.min(deepest,d.distance);contacts.push({part:c.handle,distance:d.distance,normal:d.normal1});}}
  if(process.env.ROUTE_TRACE&&(next!==prior||frame%120===0||frame===1199)){
   const h=ph.holds.get(1),br=body.body.rotation(),rotation=new T.Quaternion(br.x,br.y,br.z,br.w);
   console.log(JSON.stringify({phase:'execute',yaw,frame,next,at:ph.pointOf('tool').toArray(),want:center.toArray(),accepted:h.target.toArray(),rotation:rotation.toArray(),turnError:rotation.angleTo(bq),velocity:body.body.linvel(),force:h.force?.toArray(),contacts,deepest}));prior=next;
  }
 }
 assert.equal(next,result.value.length,'force-driven body traverses route without teleport');
 assert.ok(deepest>-.003,'rack contact stays below existing penetration gate');
 const refused=ph.toolRoute('tool',start,q,()=>false);let no;do{no=refused.next();}while(!no.done);assert.equal(no.value,null,'anatomical refusal cannot be bypassed');
 console.log(JSON.stringify({yaw,waypoints:result.value.length,yields,planMs,ms:performance.now()-began,deepest}));ph.dispose();checks++;
}
console.log(`tool route: ${checks} transformed real-rack searches, swept edges, force traversal and refusal PASS`);
