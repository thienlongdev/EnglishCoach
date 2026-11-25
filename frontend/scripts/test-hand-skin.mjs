import * as T from 'three';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {loadCastGeometry} from './lib/load-cast.mjs';
import {tsLoader} from './lib/ts-load.mjs';
const {HandSkin}=tsLoader({three:T})('lib/embodiment/handSkin.ts');
const assets=readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts',import.meta.url),'utf8');
const names=['thumb','index','middle','ring','little'];
let samples=0,maximum=0;
for(const hero of ['LYRA','KAI']) for(const side of [1,-1]) {
 const {scene:model}=await loadCastGeometry(assets.match(new RegExp(hero+": '([^']+)'"))[1]);
 model.position.set(3.11,-.32,4.55);model.rotation.set(.32,1.83,-.16);model.scale.setScalar(1.06);model.updateMatrixWorld(true);
 const skin=model.getObjectByName('Runner_Hands'),bones=new Map();model.traverse(b=>{if(b.isBone)bones.set(b.userData.name||b.name,b)});
 const hand=bones.get('hand.'+(side===1?'R':'L'));
 const joints=names.flatMap((name,finger)=>[0,1,2].map(joint=>{const bone=bones.get(`${name}.${joint+1}.${side===1?'R':'L'}`);return {bone,rest:bone.quaternion.clone(),finger,joint}}));
 const detached=new HandSkin(skin,hand,joints,side),saved=joints.map(j=>j.bone.quaternion.toArray());
 for(let pose=0;pose<9;pose++) {
  const angles=names.map((_,f)=>[.1+pose*.1,.2+pose*.11,.1+pose*.07,(f-2)*.025,f===0?(pose-4)*.18:0]);
  angles.forEach((a,f)=>detached.setFinger(f,a));
  // Candidate evaluation must never change any live bone.
  assert.deepEqual(joints.map(j=>j.bone.quaternion.toArray()),saved);
  for(const j of joints){const a=angles[j.finger];j.bone.quaternion.copy(j.rest).multiply(new T.Quaternion().setFromEuler(new T.Euler(a[j.joint],j.joint===0?a[4]*side:0,j.joint===0?-a[3]*side:0)))}
  model.updateMatrixWorld(true);skin.skeleton.update();
  const transform=hand.matrixWorld.clone().invert().multiply(skin.matrixWorld),p=new T.Vector3(),q=new T.Vector3();
  for(const index of detached.vertices){skin.getVertexPosition(index,p).applyMatrix4(transform);detached.point(index,q);maximum=Math.max(maximum,p.distanceTo(q));samples++;}
  for(let i=0;i<joints.length;i++)joints[i].bone.quaternion.fromArray(saved[i]);model.updateMatrixWorld(true);
 }
}
console.log(JSON.stringify({samples,maximumMetres:maximum,casts:2,hands:2,poses:9,liveSkeletonWrites:0}));
assert.ok(maximum<1e-7,'Factored snapshot matches actual Three linear blend skinning');
