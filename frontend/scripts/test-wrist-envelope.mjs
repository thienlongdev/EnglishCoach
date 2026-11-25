// Check the actual deformed wrist skin against the actual deformed garment.
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import * as T from 'three';
import {MeshBVH} from 'three-mesh-bvh';
import {loadCastGeometry} from './lib/load-cast.mjs';
import {tsLoader} from './lib/ts-load.mjs';
const {HumanRig}=tsLoader({three:T})('lib/embodiment/human.ts');
const arg=k=>{const i=process.argv.indexOf(k);return i<0?null:process.argv[i+1]};
const assets=readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts',import.meta.url),'utf8');
const report={cpuOnly:true,heroes:{},failures:[]};
for(const hero of ['LYRA','KAI']){
 const file=arg('--'+hero.toLowerCase())||assets.match(new RegExp(hero+": '([^']+)'"))[1];
 const gltf=await loadCastGeometry(file),model=gltf.scene,root=new T.Group();root.add(model);model.scale.setScalar(1.04);root.updateMatrixWorld(true);
 const rig=new HumanRig(model,root),mix=new T.AnimationMixer(model);mix.clipAction(gltf.animations.find(c=>c.name==='Idle')).play();
 let skin,cloth;model.traverse(m=>{if(m.name==='Runner_Hands')skin=m;if(m.name==='Runner_Body')cloth=m});
 const probes=[];
 const si=skin.geometry.attributes.skinIndex,sw=skin.geometry.attributes.skinWeight;
 for(const arm of rig.arms){
  const bi=skin.skeleton.bones.indexOf(arm.hand),fi=skin.skeleton.bones.indexOf(arm.fore);
  const wrist=new T.Vector3().setFromMatrixPosition(skin.skeleton.boneInverses[bi].clone().invert());
  const elbow=new T.Vector3().setFromMatrixPosition(skin.skeleton.boneInverses[fi].clone().invert());
  const axis=wrist.clone().sub(elbow).normalize();
  for(let i=0;i<skin.geometry.attributes.position.count;i++){
   const p=new T.Vector3().fromBufferAttribute(skin.geometry.attributes.position,i).applyMatrix4(skin.bindMatrix),a=p.clone().sub(wrist).dot(axis);
   if(a<-.047||a>-.028||p.distanceTo(wrist)>.075)continue;
   probes.push({index:i,side:arm.side,centre:wrist.clone().addScaledVector(axis,a).applyMatrix4(skin.bindMatrix.clone().invert())});
  }
 }
 assert.ok(probes.length>80,'Real wrist vertices sampled');
 const poses=[];
 for(const angle of [0,.5,1,1.5,2,2.5,3,3.5,4,4.5,5,5.5]){
  for(const side of [1,-1])rig.setContact(side,{wrist:new T.Vector3(-side*.23,1.14,.31),fingers:new T.Vector3(Math.sin(angle),.12,Math.cos(angle)).normalize(),palm:new T.Vector3(0,1,0),grip:'book'},.01);
  for(let i=0;i<45;i++){rig.restore();mix.update(1/60);rig.capture();root.updateMatrixWorld(true);rig.update({dt:1/60,reduced:false,own:false,eye:new T.Vector3(0,1.6,.02),lookYaw:0,lookPitch:0});}
  root.updateMatrixWorld(true);skin.skeleton.update();cloth.skeleton.update();
  const g=cloth.geometry.clone(),ps=g.attributes.position;
  for(let i=0;i<ps.count;i++){const p=cloth.getVertexPosition(i,new T.Vector3()).applyMatrix4(cloth.matrixWorld);ps.setXYZ(i,p.x,p.y,p.z);}
  g.computeBoundingBox();g.computeBoundingSphere();
  const tree=new MeshBVH(g),ray=new T.Ray();let outside=0,worst=0,missing=0;
  const leaks=[];
  for(const p of probes){
   const v=skin.getVertexPosition(p.index,new T.Vector3()).applyMatrix4(skin.matrixWorld),c=skin.applyBoneTransform(p.index,p.centre.clone()).applyMatrix4(skin.matrixWorld),r=v.distanceTo(c);
   ray.set(c,v.clone().sub(c).normalize());
   const hits=tree.raycast(ray,T.DoubleSide).filter(h=>h.distance<.075&&h.distance>.006);
   if(!hits.length){missing++;continue;}
   const outerHit=hits.reduce((a,b)=>a.distance>b.distance?a:b),outer=outerHit.distance,penetration=r-outer;
   if(penetration>.001){outside++;if(angle===0)leaks.push({index:p.index,centre:p.centre.toArray(),rest:new T.Vector3().fromBufferAttribute(skin.geometry.attributes.position,p.index).toArray(),skinRadius:r,outer,skinGroups:[0,1,2,3].map(k=>[skin.skeleton.bones[si.getComponent(p.index,k)].name,sw.getComponent(p.index,k)])});}
   worst=Math.max(worst,penetration);
  }
  poses.push({angle,vertices:probes.length,outside,missing,worstMm:worst*1000,...(angle===0?{leaks}: {})});g.dispose();
 }
 report.heroes[hero]={file,poses};
 if(poses.some(p=>p.outside||p.missing))report.failures.push(hero+' exposed wrist sleeve');
 console.log(hero,JSON.stringify({samples:poses.length*probes.length,outside:Math.max(...poses.map(p=>p.outside)),missing:Math.max(...poses.map(p=>p.missing)),worstMm:Math.max(...poses.map(p=>p.worstMm))}));
}
if(arg('--report'))writeFileSync(arg('--report'),JSON.stringify(report,null,2));
assert.equal(report.failures.length,0,report.failures.join('; '));
