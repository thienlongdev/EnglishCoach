// Real casts, real skin weights: a measured palm seat must still be clear
// after the fingers close. Bone centres do not qualify the drawn surface.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {clone} from 'three/examples/jsm/utils/SkeletonUtils.js';
import {loadCastGeometry} from './lib/load-cast.mjs';
import {tsLoader} from './lib/ts-load.mjs';
const load=tsLoader({three:T}),{HumanRig}=load('lib/embodiment/human.ts'),{GRIPS}=load('lib/embodiment/fingers.ts');
const assets=readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts',import.meta.url),'utf8'),rows=[];
for(const hero of ['LYRA','KAI']){
 const g=await loadCastGeometry(assets.match(new RegExp(hero+": '([^']+)'"))[1]);
 const root=new T.Group(),model=clone(g.scene);model.scale.setScalar(1.04);root.add(model);root.updateMatrixWorld(true);
 const rig=new HumanRig(model,root);
 for(const arm of rig.arms)for(const radius of [.0105,.0125,.0165]){
  const before=arm.fingers.map(f=>f.bone.quaternion.toArray()),seat=rig.palmSeat(arm.side,radius,.072,.25);
  assert.deepEqual(arm.fingers.map(f=>f.bone.quaternion.toArray()),before,'palm planning never writes the live hand');
  const origin=arm.hand.getWorldPosition(new T.Vector3()),rotation=arm.hand.getWorldQuaternion(new T.Quaternion());
  const fingers=new T.Vector3(0,1,0).applyQuaternion(rotation),palm=new T.Vector3(0,0,1).applyQuaternion(rotation);
  const point=origin.clone().addScaledVector(fingers,.072).addScaledVector(palm,seat),axis=new T.Vector3(arm.side*Math.cos(.25),Math.sin(.25),0).applyQuaternion(rotation);
  const toLocal=new T.Matrix4().makeRotationFromQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0),axis)).setPosition(point).invert();
  const shape=()=>({kind:'cyl',toLocal,half:[radius,.6,radius]});
  rig.setContact(arm.side,{wrist:origin,fingers,palm,grip:'handle',wrap:true,shape,on:new T.Group()});arm.contactT=1;
  const start=performance.now();assert(rig.fitNow(arm.side));rig.fingers(arm,GRIPS.handle,1,true);model.updateMatrixWorld(true);
  const mesh=arm.palmSkin.mesh;mesh.skeleton.update();
  const si=mesh.geometry.getAttribute('skinIndex'),sw=mesh.geometry.getAttribute('skinWeight'),hand=mesh.skeleton.bones.indexOf(arm.hand),boneClass=new Map(arm.fingers.map(f=>[mesh.skeleton.bones.indexOf(f.bone),[f.finger,f.joint]]));
  let minimum=Infinity,faceMinimum=Infinity,thumbPad=Infinity;const middle=[Infinity,Infinity,Infinity,Infinity],v=new T.Vector3(),surface=new Map();
  for(const i of new Set(mesh.geometry.index.array)){
   let own=0,cls=null,best=0;
   for(let k=0;k<4;k++){const b=si.getComponent(i,k),w=sw.getComponent(i,k);if(b===hand||boneClass.has(b))own+=w;if(boneClass.has(b)&&w>best){best=w;cls=boneClass.get(b);}}
   if(own<.5)continue;
   mesh.getVertexPosition(i,v).applyMatrix4(mesh.matrixWorld).applyMatrix4(toLocal);const d=Math.hypot(v.x,v.z)-radius;minimum=Math.min(minimum,d);
   surface.set(i,v.clone().setY(0));
   if(cls&&cls[0]===0&&cls[1]===2&&best>.5)thumbPad=Math.min(thumbPad,d);
   if(cls&&cls[0]>0&&cls[1]===1&&best>.5)middle[cls[0]-1]=Math.min(middle[cls[0]-1],d);
  }
  // The shaft spans the hand. Project each indexed skin triangle onto the
  // shaft's cross-section; a face can cross the cylinder between clear vertices.
  const triangle=new T.Triangle(),shaftCenter=new T.Vector3(),closest=new T.Vector3();
  const indices=mesh.geometry.index.array;
  for(let i=0;i<indices.length;i+=3){
   const points=[surface.get(indices[i]),surface.get(indices[i+1]),surface.get(indices[i+2])];
   if(points.some(p=>!p))continue;
   triangle.set(...points);
   if(triangle.getArea()===0){
    for(let k=0;k<3;k++){
     const a=points[k],b=points[(k+1)%3];
     const radial=a.equals(b)?a.length():new T.Line3(a,b).closestPointToPoint(shaftCenter,true,closest).length();
     faceMinimum=Math.min(faceMinimum,radial-radius);
    }
   }else faceMinimum=Math.min(faceMinimum,triangle.closestPointToPoint(shaftCenter,closest).length()-radius);
  }
  const row={hero,side:arm.side,radius,seat,minimum,faceMinimum,thumbPad,middle,jointFit:arm.jointFit,fit:arm.fit,spread:arm.spreadFit,ms:performance.now()-start};rows.push(row);console.log(JSON.stringify(row));
 }
}
if(!process.argv.includes('--observe'))for(const row of rows){assert(row.minimum>=0&&row.faceMinimum>=0,`${row.hero}/${row.side} power-grip skin clears handle: ${row.faceMinimum}`);assert(row.thumbPad<=.002,`${row.hero}/${row.side} thumb pad meets the shaft: ${row.thumbPad}`);assert(row.middle.every(v=>v<=.002),`${row.hero}/${row.side} all four middle fingers meet the handle: ${row.middle}`);}
