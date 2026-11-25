// Numerical qualification of the real exported skins, not a substitute for visual review.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tsLoader } from './lib/ts-load.mjs';
import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
const {ArenaCharacter}=tsLoader({three:T,'three/examples/jsm/utils/SkeletonUtils.js':{clone}})('components/features/speaking/arena/ArenaCharacter.ts');
const assets=readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts',import.meta.url),'utf8');
async function load(path){
 const data=readFileSync(new URL('../public'+path,import.meta.url));
 const length=data.readUInt32LE(12),j=JSON.parse(data.subarray(20,20+length));
 // Images are irrelevant to skin transforms; omit decoding in this CPU-only test.
 j.materials=j.materials.map(m=>({name:m.name}));delete j.textures;delete j.images;
 const raw=Buffer.from(JSON.stringify(j)),json=Buffer.alloc(Math.ceil(raw.length/4)*4,32);raw.copy(json);
 const bin=data.subarray(20+length),header=Buffer.alloc(20);data.copy(header,0,0,12);header.writeUInt32LE(20+json.length+bin.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
 const glb=Buffer.concat([header,json,bin]);return new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength),'');
}
for(const hero of ['LYRA','KAI']){
 const path=process.argv.includes('--baseline')?`/speaking/arena/${hero.toLowerCase()}/cast.glb`:assets.match(new RegExp(hero+": '([^']+)'"))[1];
 const template=await load(path),actor=new ArenaCharacter(template,0,hero);
 const ready={team:0,online:true,ready:true,gesture:'IDLE'};
 for(let n=0;n<100;n++)actor.update(1/60,ready,false,false,false,false);
 assert.equal(actor.locomotion,'Idle');
 for(const side of ['L','R']){
   const at=bone=>actor.model.getObjectByName(bone+side).getWorldPosition(new T.Vector3());
   assert.ok(at('upper_arm').y-at('hand').y>.36 && Math.abs(at('upper_arm').x-at('hand').x)<.13,hero+' arms hang beside the body');
 }
 for(const speed of [1.55,3.35]){
   for(let n=0;n<180;n++){actor.root.position.z+=speed/180;actor.update(1/180,ready,false,false,false,false);}
   assert.equal(actor.locomotion,speed>2?'Run':'Walk');assert.ok(actor.weights.get(actor.locomotion)>.99);
 }
 for(const [dy,air,clip] of [[.08,true,'JumpUp'],[-.08,true,'JumpFall'],[0,false,'Land']]){
   actor.root.position.y+=dy;actor.update(1/60,ready,false,false,false,false,undefined,0,air);assert.equal(actor.locomotion,clip);
 }
 const seated={...ready,seat:'bench-test-0'}; actor.root.position.y=.5275;
 for(let n=0;n<120;n++)actor.update(1/60,seated,false,false,false,false);
 assert.equal(actor.locomotion,'Sit');
 const joint=n=>actor.model.getObjectByName(n).getWorldPosition(new T.Vector3());
 assert.ok(Math.abs(joint('hips').y-.5275)<.16,hero+' pelvis meets seat');
 for(const side of ['L','R']){
   assert.ok(joint('shin'+side).z-joint('thigh'+side).z>.25);
   assert.ok(joint('shin'+side).y-joint('foot'+side).y>.25);
 }
 actor.root.position.y=0;
 const meshes=[];actor.model.traverse(o=>{if(o.isSkinnedMesh&&(o.name.includes('Body')||o.name.includes('Scarf')))meshes.push(o);});
 assert.ok(meshes.length);
 let contamination=0,collarCount=0,maxRigidError=0;
 const collars=[];
 for(const mesh of meshes){
  const uv=mesh.geometry.attributes.uv,pos=mesh.geometry.attributes.position,weights=mesh.geometry.attributes.skinWeight,indices=mesh.geometry.attributes.skinIndex;
  for(let i=0;i<pos.count;i++){
   const cell=Math.floor(uv.getX(i)*8)+Math.floor(uv.getY(i)*8)*8;
   for(let k=0;k<4;k++)if(weights.getComponent(i,k)>.001&&mesh.skeleton.bones[indices.getComponent(i,k)].name.startsWith('scarf')&&cell!==9)contamination++;
   // Full front and side collar, away from the rear tail attachment.
   if(cell===9&&pos.getY(i)>1.29&&pos.getZ(i)>-.05){collars.push({mesh,index:i,rest:null});collarCount++;}
  }
 }
 assert.ok(collarCount>200,'actual garment collar vertices identified');
 const player={team:0,online:true,ready:false,gesture:'IDLE'};
 const chest=actor.model.getObjectByName('chest'),inverse=new T.Matrix4(),point=new T.Vector3();
 // Two minutes of idle, then all social / locomotion transitions at three frame rates.
 for(const fps of [30,60,120]){
  for(let frame=0;frame<fps*18;frame++){
   const phase=Math.floor(frame/fps/3);
   player.gesture=['IDLE','WAVE','LISTEN','CHEER','IDLE','IDLE'][phase];
   if(phase===4)actor.root.position.x+=2/fps;
   actor.update(1/fps,player,phase===5,false,false,false);
   actor.root.updateMatrixWorld(true);inverse.copy(chest.matrixWorld).invert();
   if(frame%Math.round(fps/10)===0)for(const c of collars){
    c.mesh.skeleton.update();c.mesh.getVertexPosition(c.index,point);point.applyMatrix4(c.mesh.matrixWorld).applyMatrix4(inverse);
    if(c.rest===null)c.rest=point.clone();else maxRigidError=Math.max(maxRigidError,point.distanceTo(c.rest));
   }
  }
 }
 for(let i=0;i<7200;i++)actor.update(1/60,player,false,false,false,false);
 assert.equal(contamination,0,hero+' coat vertices must not follow the scarf chain');
 assert.ok(maxRigidError<.0001,hero+' collar must remain fitted through idle and transitions: '+maxRigidError);
 assert.ok([...actor.weights.values()].every(Number.isFinite));
 console.log(JSON.stringify({hero,path,collarCount,contamination,maxRigidError,frames:10980,result:'PASS'}));
 actor.dispose();
}
