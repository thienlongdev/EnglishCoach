// Experimental only: massless elastic bristles supply continuous contact forces to the
// SAME Rapier body. No runtime import, changed collider, placement or gate.
// Evaluate coupling before choosing a production flexible-head representation.
import assert from 'node:assert/strict';
import * as T from 'three';
import R from '@dimforge/rapier3d-compat';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadCastGeometry} from './lib/load-cast.mjs';
import {tsLoader} from './lib/ts-load.mjs';
await R.init();
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z), vec=p=>V(p.x,p.y,p.z);
const load=tsLoader({three:T}),{StudyPhysics}=load('components/study-space/world/physics.ts'),{onRack}=load('lib/study-space/kit.ts');
const pack=await loadCastGeometry(fileURLToPath(new URL('../public/assets/study-space/study-care-aad100a0a3cc.glb',import.meta.url)));
const models=new Map();pack.scene.traverse(o=>{if(['tool.broom','tool.mop','rack.cleaning'].includes(o.userData.name??o.name))models.set(o.userData.name??o.name,o);});

// UV seams duplicate positions. Recover the separate authored fibres by their
// actual indexed triangles, without clustering away any fibre or vertex.
function components(mesh,toBody){
 const a=mesh.geometry.attributes.position,ix=mesh.geometry.index,points=[],parents=[],ids=[],weld=new Map();
 const find=i=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;};
 for(let i=0;i<a.count;i++){
  const p=V().fromBufferAttribute(a,i).applyMatrix4(toBody),key=p.toArray().map(x=>Math.round(x*1e8)).join(',');
  let id=weld.get(key);if(id===undefined){id=parents.length;weld.set(key,id);parents.push(id);points.push(p);}ids.push(id);
 }
 for(let i=0;i<(ix?.count??a.count);i+=3){const t=[0,1,2].map(k=>ids[ix?ix.getX(i+k):i+k]);for(const id of t.slice(1))parents[find(id)]=find(t[0]);}
 const groups=new Map();for(let i=0;i<points.length;i++){const id=find(i);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(points[i]);}
 return [...groups.values()];
}
function matrix(s){return new T.Matrix3().set(s.m11,s.m12,s.m13,s.m12,s.m22,s.m23,s.m13,s.m23,s.m33);}
// Experimental head queries share exactly the same collision groups and held
// body exclusion. The caller refreshes the scene once before its query batch.
// Rapier compat0.12's JS flag8 is interpreted as exclude-dynamic by its WASM,
// not exclude-sensors. Use the public predicate, not guessed numeric flags:
// sensors never carry load, and actual dynamic supports must remain queryable.
const physicalHeadCollider=collider=>!collider.isSensor();
export function headRay(world,ray,length,groups,body){
 return world.castRayAndGetNormal(ray,length,false,undefined,groups,undefined,body,physicalHeadCollider);
}
export function make(yaw,sourceModels=models,initialLowering=0){
 const stage=new T.Group(),rack={obj:{id:'rack',kind:'rack.cleaning',pos:[0,0,0],rotY:yaw,scale:1},group:new T.Group()};
 rack.group.add(sourceModels.get('rack.cleaning').clone(true));rack.group.rotation.y=yaw;
 const spot=onRack(rack.obj,'tool.broom');
 // Offline initial-condition comparison only. This offset is applied before
 // any body exists, never as a movement/placement operation during simulation.
 assert.ok(Number.isFinite(initialLowering)&&initialLowering>=0&&initialLowering<=.03);
 spot.pos[1]-=initialLowering;
 const tool={obj:{id:'broom',kind:'tool.broom',pos:spot.pos,rotY:spot.rotY,scale:1},group:new T.Group()};
 tool.group.add(sourceModels.get('tool.broom').clone(true));tool.group.position.fromArray(spot.pos);tool.group.rotation.y=spot.rotY;stage.add(rack.group,tool.group);stage.updateWorldMatrix(true,true);
 const ph=new StudyPhysics(R,()=>{}),entries=[rack,tool];ph.sync(entries,6);assert.ok(ph.pick(tool,entries,6));
 const record=ph.bodies.get('broom'),body=record.body,origin=vec(body.translation());
 let mesh;tool.group.traverse(o=>{if(o.isMesh&&(o.userData.name??o.name)==='Bristles')mesh=o;});assert.ok(mesh);
 const parts=components(mesh,new T.Matrix4().makeTranslation(-origin.x,-origin.y,-origin.z).multiply(mesh.matrixWorld));
 assert.equal(parts.length,420,'all authored broom bristles');assert.ok(parts.every(p=>p.length===8),'each original two-ring fibre');
 const fibres=parts.map(p=>{
  p.sort((a,b)=>b.y-a.y);const root=p.slice(0,4).reduce((a,v)=>a.add(v),V()).multiplyScalar(.25),tips=p.slice(4),tip=tips.reduce((a,v)=>a.add(v),V()).multiplyScalar(.25);
  return{root,tips,axis:tip.sub(root).normalize()};
 });
 // A real unsupported release, not a move to an invented support. Only the
 // diagnostic bypasses automatic layout settlement while measuring ten seconds.
 ph.release(1);
 const condition=process.env.HEAD_CASE??'supported',external=V();
 if(condition==='missing')ph.sync([tool],6);
 if(condition==='sensor')ph.solids.get('rack').collider.setSensor(true);
 if(condition==='partial'){external.y=body.mass()*9.81*.5;body.addForce(external,true);}
 return {ph,record,body,fibres,origin,condition,external,tool,expectedSupport:condition==='wrong-id'?'other':'rack'};
}

// Elastic-tip compliance control. A velocity-form implicit elastic constraint
// estimates reaction impulse, applied through Rapier's public impulse API. The
// root object is NEVER moved by this solver. This is not a complete rod model:
// bending along multiple segments, self-contact and rendering remain
// unimplemented and no gameplay acceptance may be inferred from this probe.
export function contactStep(x,dt,kBend,kAxial,iterations){
 const {ph,body,fibres}=x,world=ph.world,q0=body.rotation(),q=new T.Quaternion(q0.x,q0.y,q0.z,q0.w),at=vec(body.translation()),com=vec(body.worldCom());
 const invMass=body.effectiveInvMass(),S=matrix(body.effectiveWorldInvInertiaSqrt()),invI=S.clone().multiply(S),gravity=vec(world.gravity).add(V(x.external.x*invMass.x,x.external.y*invMass.y,x.external.z*invMass.z)).multiplyScalar(dt),contacts=[];
 if(x.softForce){body.addForce(x.softForce.clone().negate(),true);body.addTorque(x.softTorque.clone().negate(),true);}
 const velocity=vec(body.linvel()).add(gravity),angular=vec(body.angvel());
 world.updateSceneQueries();
 for(const fibre of fibres){
  const root=fibre.root.clone().applyQuaternion(q).add(at),axis=fibre.axis.clone().applyQuaternion(q);let best=null;
  for(const [tipIndex,tipLocal] of fibre.tips.entries()){
   const tip=tipLocal.clone().applyQuaternion(q).add(at),r=tip.clone().sub(com),v=vec(body.linvel()).add(vec(body.angvel()).cross(r)).add(gravity),end=tip.clone().addScaledVector(v,dt),delta=end.sub(root),len=delta.length();
   if(len<1e-8)continue;
   // Match the held body's real collision filter. G_FURN footprints are for
   // pushed-furniture navigation, not surfaces a bristle can physically touch.
   const ray=new R.Ray(root,delta.multiplyScalar(1/len)),hit=headRay(world,ray,len,x.record.collider.collisionGroups(),body);
   if(!hit)continue;
   const normal=vec(hit.normal).normalize();if(normal.dot(delta)>0)normal.negate();
   const point=root.clone().addScaledVector(delta,hit.toi),phi=tip.clone().sub(point).dot(normal);
   const compliance=f=>f.clone().multiplyScalar(1/kBend).addScaledVector(axis,axis.dot(f)*(1/kAxial-1/kBend));
   const mu=process.env.HEAD_FRICTION===undefined?(x.record.collider.friction()+hit.collider.friction())*.5:Number(process.env.HEAD_FRICTION);
   const c={normal,point,phi,compliance,lambda:V(),support:ph.solidOf_.get(hit.collider.handle),collider:hit.collider.handle,tipLocal,tip,tipIndex,mu,fibre};
   if(!best||c.phi<best.phi)best=c;
  }
  if(best){
   best.arm=best.point.clone().sub(com);
   const prev=fibre.contact;
   best.anchor=prev?.collider===best.collider&&prev.tipIndex===best.tipIndex&&prev.normal.dot(best.normal)>.999?prev.anchor.clone():best.point.clone();
   best.phiVector=best.tip.clone().sub(best.anchor);
   const t1=best.normal.clone().cross(Math.abs(best.normal.x)<.9?V(1,0,0):V(0,1,0)).normalize(),t2=best.normal.clone().cross(t1);
   best.axes=[best.normal,t1,t2];best.denominators=best.axes.map(d=>{const cross=best.arm.clone().cross(d);return d.x**2*invMass.x+d.y**2*invMass.y+d.z**2*invMass.z+cross.dot(cross.clone().applyMatrix3(invI))+d.dot(best.compliance(d))/(dt*dt);});contacts.push(best);
  }else fibre.contact=null;
 }
 for(let it=0;it<iterations;it++)for(const c of contacts){
  for(const [index,d] of c.axes.entries()){
   const v=velocity.clone().add(angular.clone().cross(c.arm)),dl=-(v.dot(d)+c.phiVector.dot(d)/dt+c.compliance(c.lambda).dot(d)/(dt*dt))/c.denominators[index];
   const before=c.lambda.clone(),next=before.clone().addScaledVector(d,dl);
   if(index===0)next.addScaledVector(d,Math.max(0,next.dot(d))-next.dot(d));
   else{const normal=Math.max(0,next.dot(c.normal)),tangent=next.clone().addScaledVector(c.normal,-normal),limit=c.mu*normal;tangent.clampLength(0,limit);next.copy(c.normal).multiplyScalar(normal).add(tangent);}
   c.lambda.copy(next);const impulse=next.sub(before);velocity.add(V(impulse.x*invMass.x,impulse.y*invMass.y,impulse.z*invMass.z));angular.add(c.arm.clone().cross(impulse).applyMatrix3(invI));
  }
 }
 // Constant force acts over the same solver substeps as gravity. An impulse
 // applied only before the outer step leaves a 0.061m/s end-step velocity bias
 // despite a nearly stationary pose; that bias must not be hidden by a gate.
 x.softForce=contacts.reduce((sum,c)=>sum.add(c.lambda),V()).multiplyScalar(1/dt);
 x.softTorque=contacts.reduce((sum,c)=>sum.add(c.arm.clone().cross(c.lambda)),V()).multiplyScalar(1/dt);
 body.addForce(x.softForce,true);body.addTorque(x.softTorque,true);
 world.step(ph.events);let upward=0,maxDeflection=0,maxSurfaceError=0,maxPenetration=0,worst=null;const qt=body.rotation(),afterQ=new T.Quaternion(qt.x,qt.y,qt.z,qt.w),after=vec(body.translation());
 for(const c of contacts){
  if(c.support===x.expectedSupport&&c.normal.y>=.5)upward+=c.lambda.y/dt;
  const deform=c.compliance(c.lambda).multiplyScalar(1/dt);maxDeflection=Math.max(maxDeflection,deform.length());
  const drawn=c.tipLocal.clone().applyQuaternion(afterQ).add(after).add(deform);
  const normal=c.lambda.dot(c.normal),tangent=c.lambda.clone().addScaledVector(c.normal,-normal),sliding=tangent.length()>=c.mu*normal-1e-8;
  const gap=drawn.clone().sub(c.point).dot(c.normal);maxPenetration=Math.max(maxPenetration,-gap);
  if(normal>0&&Math.abs(gap)>maxSurfaceError){maxSurfaceError=Math.abs(gap);worst={gap,normalForce:normal/dt,normal:c.normal.toArray(),point:c.point.toArray(),anchor:c.anchor.toArray(),deform:deform.toArray(),phi:c.phiVector.toArray()};}
  c.fibre.contact={collider:c.collider,normal:c.normal.clone(),tipIndex:c.tipIndex,anchor:sliding?drawn.addScaledVector(c.normal,-drawn.clone().sub(c.point).dot(c.normal)):c.anchor};
 }
 // Expose the actual solved reactions to the separate surface-qualification
 // probe. This does not deform the product mesh or add another force owner.
 x.lastContacts=contacts;
 return{upward,maxDeflection,maxSurfaceError,maxPenetration,...(process.env.HEAD_DIAG?{worst}:{}),contacts:contacts.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
const cases=process.env.HEAD_STIFFNESS?[Number(process.env.HEAD_STIFFNESS)]:[2,20,200];
for(const stiffness of cases)for(const yaw of (process.env.HEAD_YAW?[Number(process.env.HEAD_YAW)]:[0,.71,-1.89])){
 const x=make(yaw),samples=[],steps=Number(process.env.HEAD_STEPS??600),dt=1/60,weight=x.body.mass()*9.81;
 let stable=0,bestStable=0,maxDrift=0,maxDeflection=0,maxSurfaceError=0,maxPenetration=0,last;
 for(let i=0;i<steps;i++){
  if(x.condition==='remove'&&i===120)x.ph.sync([x.tool],6);
  const begin=performance.now();last=contactStep(x,dt,stiffness,2000,Number(process.env.HEAD_ITERATIONS??8));samples.push(performance.now()-begin);
  const speed=vec(x.body.linvel()).length(),spin=vec(x.body.angvel()).length(),drift=vec(x.body.translation()).distanceTo(x.origin);
  stable=last.upward>=weight*.95&&speed<.01&&spin<.01?stable+dt:0;bestStable=Math.max(stable,bestStable);maxDrift=Math.max(maxDrift,drift);maxDeflection=Math.max(maxDeflection,last.maxDeflection);maxSurfaceError=Math.max(maxSurfaceError,last.maxSurfaceError);maxPenetration=Math.max(maxPenetration,last.maxPenetration);
  if(process.env.HEAD_TRACE&&i%30===0)console.log(JSON.stringify({phase:'step',i,stiffness,yaw,drift,speed,spin,stable,...last}));
 }
 samples.sort((a,b)=>a-b);const finalDrift=vec(x.body.translation()).distanceTo(x.origin);
 const rotation=x.body.rotation(),rotationRad=new T.Quaternion(rotation.x,rotation.y,rotation.z,rotation.w).angleTo(new T.Quaternion()),mechanicalGatesPassed=finalDrift<=.005&&rotationRad<=.015&&stable>=.35;
 console.log(JSON.stringify({phase:'result',condition:x.condition,stiffness,yaw,friction:process.env.HEAD_FRICTION??'collider-average',fibres:x.fibres.length,steps,weight,finalDrift,maxDrift,maxDeflection,maxSurfaceError,maxPenetration,stable,bestStable,rotationRad,mechanicalGatesPassed,finalLoad:last.upward,contacts:last.contacts,p95Ms:samples[Math.floor(samples.length*.95)],limitations:'analytical elastic tips/Coulomb friction only; no runtime/render/rod/self-contact/continuous gameplay qualification'}));x.ph.dispose();
 if(process.env.HEAD_ASSERT)assert.equal(mechanicalGatesPassed,x.condition==='supported','existing support/pose mechanics gates: '+x.condition);
}
}
