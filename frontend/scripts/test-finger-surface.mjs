import * as T from 'three';
import * as BVH from 'three-mesh-bvh';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {loadCastGeometry} from './lib/load-cast.mjs';
import {tsLoader} from './lib/ts-load.mjs';
const load=tsLoader({three:T,'three-mesh-bvh':BVH}),{FingerSurfaceFit}=load('lib/embodiment/fingerSurface.ts'),{meshShape,surfaceOf}=load('lib/embodiment/grasp.ts'),{HandSkin}=load('lib/embodiment/handSkin.ts');
const directory=statSync(process.argv[2]).isDirectory();
const assets=readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts',import.meta.url),'utf8');
const report={cases:[]};
for(const hero of ['LYRA','KAI'])for(const side of directory?['R','L']:['R'])for(const thickness of [.65,1,1.35]){
 if(process.env.FILTER&&!`${hero}-${side}-${thickness}`.includes(process.env.FILTER))continue;
 const input=JSON.parse(readFileSync(directory?join(process.argv[2],hero+'-'+side+'.json'):process.argv[2],'utf8'));
 const gltf=await loadCastGeometry(assets.match(new RegExp(hero+": '([^']+)'"))[1]),model=gltf.scene;
 const bones=new Map();model.traverse(b=>{if(b.isBone)bones.set(b.userData.name||b.name,b)});
 for(const b of input.bones){const bone=bones.get(b.name);if(bone){bone.position.fromArray(b.position);bone.quaternion.fromArray(b.quaternion);bone.scale.fromArray(b.scale)}}
 model.updateMatrixWorld(true);
 const hand=bones.get('hand.'+(input.side===1?'R':'L')),skin=model.getObjectByName('Runner_Hands');
 const geom=new T.BufferGeometry();geom.setAttribute('position',new T.Float32BufferAttribute(input.meshes.flat(),3));geom.computeBoundingBox();
 const base=geom.boundingBox.min.z,ps=geom.attributes.position;
 for(let i=0;i<ps.count;i++)ps.setZ(i,base+(ps.getZ(i)-base)*thickness);
 if(process.env.RETREAT){const offset=Number(process.env.RETREAT);for(let i=0;i<ps.count;i++)ps.setY(i,ps.getY(i)+offset);}
 const object=new T.Group();object.matrixAutoUpdate=false;object.matrix.copy(hand.matrixWorld);object.add(new T.Mesh(geom));object.updateMatrixWorld(true);
 const shape=meshShape(object,hero+':'+side+':'+thickness),names=['thumb','index','middle','ring','little'];
 const joints=input.fingers.map(f=>({bone:bones.get(f.name),rest:new T.Quaternion().fromArray(f.rest),finger:names.findIndex(n=>f.name.startsWith(n+'.')),joint:Number(f.name.split('.')[1])-1}));
 const seed=names.map(n=>{const fs=input.fingers.filter(f=>f.name.startsWith(n+'.'));return [...fs.map(f=>f.bend),fs[0].spread,0]});
 const saved=joints.map(j=>j.bone.quaternion.toArray());
 const fit=new FingerSurfaceFit(skin,hand,joints,input.side,shape,seed),times=[];let result=null;
 const start=performance.now();
 while(!result&&times.length<2000){const t=performance.now();result=fit.step(1.5);times.push(performance.now()-t);}
 assert.ok(result,'Fit finishes within bounded work');
 assert.deepEqual(joints.map(j=>j.bone.quaternion.toArray()),saved,'Solver does not write live bones');
 const numerical=new HandSkin(structuredClone(new HandSkin(skin,hand,joints,input.side).serialize()));
 result.pose.forEach((p,f)=>numerical.setFinger(f,p));
 const surface=numerical.geometry();surface.boundsTree=new BVH.MeshBVH(surface);const intersection=surfaceOf(object,hero+':'+side+':'+thickness).intersectsGeometry(surface,new T.Matrix4());surface.dispose();
 let fullClearance=Infinity,worst=null;const point=new T.Vector3();for(const i of numerical.handVertices){const distance=shape.signedDistance(numerical.point(i,point));if(distance<fullClearance){fullClearance=distance;worst={i,point:point.toArray(),inside:shape.inside(point),weights:[0,1,2,3].map(k=>[skin.skeleton.bones[skin.geometry.attributes.skinIndex.getComponent(i,k)].userData.name,skin.geometry.attributes.skinWeight.getComponent(i,k)])};}}
 result.worst=worst;
 result.trianglesIntersect=intersection;result.fullHandClearance=fullClearance;
 const row={hero,side,thickness,result,totalMs:performance.now()-start,steps:times.length,maxStepMs:Math.max(...times),p95StepMs:times.slice().sort((a,b)=>a-b)[Math.floor(times.length*.95)]};
 console.log(JSON.stringify(row));report.cases.push(row);
}
if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(report,null,2));
assert.ok(report.cases.every(c=>c.result.valid.every(Boolean)),'All pads reach opposite surfaces with skin clearance');
assert.ok(report.cases.every(c=>!c.result.trianglesIntersect&&c.result.fullHandClearance>=0),'Whole hand including palm and triangle interiors stays outside object');
