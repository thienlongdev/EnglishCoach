// Real captured Lyra/Kai left/right skins, resized book geometry. This tests the
// isolated numerical job, not browser worker delivery or runtime integration.
import * as T from 'three';
import * as BVH from 'three-mesh-bvh';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {loadCastGeometry} from './lib/load-cast.mjs';
import {tsLoader} from './lib/ts-load.mjs';
const load=tsLoader({three:T,'three-mesh-bvh':BVH}),{runFingerFit}=load('lib/embodiment/fingerFitJob.ts'),{meshShape}=load('lib/embodiment/grasp.ts'),{HandSkin}=load('lib/embodiment/handSkin.ts');
const assets=readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts',import.meta.url),'utf8'),report={cases:[]};
for(const hero of ['LYRA','KAI'])for(const side of ['R','L'])for(const thickness of [.65,1,1.35]){
 if(process.env.FILTER&&!`${hero}-${side}-${thickness}`.includes(process.env.FILTER))continue;
 const input=JSON.parse(readFileSync(join(process.argv[2],hero+'-'+side+'.json'),'utf8'));
 const {scene:model}=await loadCastGeometry(assets.match(new RegExp(hero+": '([^']+)'"))[1]);
 const bones=new Map();model.traverse(b=>{if(b.isBone)bones.set(b.userData.name||b.name,b)});
 for(const b of input.bones){const bone=bones.get(b.name);if(bone){bone.position.fromArray(b.position);bone.quaternion.fromArray(b.quaternion);bone.scale.fromArray(b.scale)}}
 model.updateMatrixWorld(true);
 const hand=bones.get('hand.'+side),mesh=model.getObjectByName('Runner_Hands'),geometry=new T.BufferGeometry();
 geometry.setAttribute('position',new T.Float32BufferAttribute(input.meshes.flat(),3));geometry.computeBoundingBox();
 const base=geometry.boundingBox.min.z,ps=geometry.attributes.position;
 for(let i=0;i<ps.count;i++)ps.setZ(i,base+(ps.getZ(i)-base)*thickness);
 const object=new T.Group();object.matrixAutoUpdate=false;object.matrix.copy(hand.matrixWorld);object.add(new T.Mesh(geometry));object.updateMatrixWorld(true);
 const shape=meshShape(object,hero+side+thickness),names=['thumb','index','middle','ring','little'];
 const joints=input.fingers.map(f=>({bone:bones.get(f.name),rest:new T.Quaternion().fromArray(f.rest),finger:names.findIndex(n=>f.name.startsWith(n+'.')),joint:Number(f.name.split('.')[1])-1}));
 const seed=names.map(n=>{const fs=input.fingers.filter(f=>f.name.startsWith(n+'.'));return [...fs.map(f=>f.bend),fs[0].spread,0]});
 const saved=joints.map(j=>j.bone.quaternion.toArray()),skin=new HandSkin(mesh,hand,joints,input.side).serialize();
 const job={skin:structuredClone(skin),surface:shape.meshData(),handToObject:shape.toLocal.clone().multiply(hand.matrixWorld).toArray(),seed,pregraspRetreat:.024};
 const savedSkin=structuredClone(job.skin);
 const result=await runFingerFit(job,()=>false);
 assert.deepEqual(joints.map(j=>j.bone.quaternion.toArray()),saved,'No live bone mutations');
 assert.deepEqual(job.skin,savedSkin,'Snapshot input is immutable');
 assert.ok(result,'Job completes');
 report.cases.push({hero,side,thickness,result});
 if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(report,null,2));
 console.log(JSON.stringify({hero,side,thickness,valid:result.valid,clearance:result.fullHandClearance,intersections:result.trianglesIntersect,offset:result.wristOffset,milliseconds:result.milliseconds,attempts:result.attempts}));
 assert.equal(await runFingerFit(job,()=>true),null,'Cancelled jobs publish no pose');
}
assert.ok(report.cases.every(c=>c.result.valid.every(Boolean)&&!c.result.trianglesIntersect&&c.result.fullHandClearance>=0),'All full-hand geometries clear the object with opposing pads');
assert.ok(report.cases.every(c=>Math.abs(c.result.wristOffset[1])*1.04<=.024001),'Pregrasp search remains bounded');
