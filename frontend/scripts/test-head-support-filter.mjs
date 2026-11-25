// Pinned-Rapier query semantics and real-head sensor rejection. Offline only.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import R from '@dimforge/rapier3d-compat';
import {make,contactStep,headRay} from './probe-flexible-head.mjs';
import {loadCastGeometry} from './lib/load-cast.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),run=process.env.RUN;
assert.match(run??'',/^[a-z0-9_-]+$/i,'unique RUN required');
const out=resolve(root,'docs/study-space/echo-life-6-20261108',run);await mkdir(out);
const candidate='docs/study-space/echo-life-6-20261108/head-authoring-z-mop/study-care-candidate-e29cff44f768.glb';
const inputs=['frontend/scripts/test-head-support-filter.mjs','frontend/scripts/probe-flexible-head.mjs','frontend/src/components/study-space/world/physics.ts','frontend/public/assets/study-space/study-care-aad100a0a3cc.glb',candidate];
const hash=async()=>Object.fromEntries(await Promise.all(inputs.map(async p=>[p,createHash('sha256').update(await readFile(resolve(root,p))).digest('hex')])));
const before=await hash(),failures=[],queries=[],heads=[];let checks=0;
function check(ok,message){checks++;if(!ok)failures.push(message);}
const ray=new R.Ray({x:0,y:2,z:0},{x:0,y:-1,z:0});
for(const type of ['standalone','fixed','kinematic','dynamic']){
 const w=new R.World({x:0,y:-9.81,z:0});
 try{
  const parent=type==='standalone'?undefined:w.createRigidBody(type==='fixed'?R.RigidBodyDesc.fixed():type==='kinematic'?R.RigidBodyDesc.kinematicPositionBased():R.RigidBodyDesc.dynamic());
  const primary=w.createCollider(R.ColliderDesc.cuboid(1,.1,1).setTranslation(0,1,0).setCollisionGroups(0x00010001),parent);
  const floor=w.createCollider(R.ColliderDesc.cuboid(1,.1,1).setCollisionGroups(0x00010001));
  for(const sensor of [false,true,false,true]){
   primary.setSensor(sensor);w.updateSceneQueries();
   const raw=w.castRayAndGetNormal(ray,3,false,R.QueryFilterFlags.EXCLUDE_SENSORS,0x00010001);
   const hit=headRay(w,ray,3,0x00010001);
   queries.push({type,sensor,rawHit:raw?.collider.handle===primary.handle?'primary':raw?.collider.handle===floor.handle?'floor':'none',physicalHit:hit?.collider.handle===primary.handle?'primary':hit?.collider.handle===floor.handle?'floor':'none'});
   check(hit?.collider.handle===(sensor?floor.handle:primary.handle),`${type}/${sensor}: closest physical surface`);
   check(!hit?.collider.isSensor(),`${type}/${sensor}: sensor never supports`);
  }
  primary.setSensor(false);primary.setCollisionGroups(0x00020002);w.updateSceneQueries();
  check(headRay(w,ray,3,0x00010001)?.collider.handle===floor.handle,`${type}: collision groups remain authoritative`);
  primary.setCollisionGroups(0x00010001);w.updateSceneQueries();
  if(parent)check(headRay(w,ray,3,0x00010001,parent)?.collider.handle===floor.handle,`${type}: held body remains excluded`);
 }finally{w.free();}
}

const pack=await loadCastGeometry(resolve(root,candidate)),models=new Map();
pack.scene.traverse(o=>{const n=o.userData.name??o.name;if(['rack.cleaning','tool.broom'].includes(n))models.set(n,o);});
const oldCase=process.env.HEAD_CASE;
try{
 for(const source of ['original','candidate'])for(const yaw of [0,.71,-1.89])for(const mode of ['initial-sensor','becomes-sensor']){
  process.env.HEAD_CASE=mode==='initial-sensor'?'sensor':'supported';
  const x=make(yaw,source==='candidate'?models:undefined,source==='candidate'?.004229381680488586:.003895241767168045);
  try{
   const support=x.ph.solids.get('rack').collider;
   let maxSensorLoad=0,maxSensorContacts=0,lastSolidLoad=0,sensorSteps=0,stateIntact=true,last;
   for(let i=0;i<240;i++){
    if(mode==='becomes-sensor'&&i===120)support.setSensor(true);
    last=contactStep(x,1/60,20,2000,8);
    if(mode==='initial-sensor'||i>=120){
     sensorSteps++;stateIntact&&=support.isSensor();maxSensorLoad=Math.max(maxSensorLoad,last.upward);
     maxSensorContacts=Math.max(maxSensorContacts,x.lastContacts.filter(c=>x.ph.world.getCollider(c.collider).isSensor()).length);
    }else lastSolidLoad=last.upward;
   }
   const result={source,yaw,mode,sensorSteps,stateIntact,maxSensorLoad,maxSensorContacts,lastSolidLoad,finalNamedLoad:last.upward};heads.push(result);
   check(stateIntact,`${source}/${yaw}/${mode}: sensor fixture survives every step`);
   check(maxSensorContacts===0,`${source}/${yaw}/${mode}: zero sensor reaction contacts (got ${maxSensorContacts})`);
   check(maxSensorLoad===0,`${source}/${yaw}/${mode}: zero named sensor load (got ${maxSensorLoad})`);
   if(mode==='becomes-sensor')check(lastSolidLoad>=x.body.mass()*9.81*.95,`${source}/${yaw}: solid carries load before sensor transition`);
  }finally{x.ph.dispose();}
 }
}finally{if(oldCase===undefined)delete process.env.HEAD_CASE;else process.env.HEAD_CASE=oldCase;}
check(JSON.stringify(before)===JSON.stringify(await hash()),'source unchanged during run');
const report={rapierVersion:R.version(),enumSensorFlag:R.QueryFilterFlags.EXCLUDE_SENSORS,checks,failures,queries,heads,sourceHashes:before,scope:'Offline query and elastic-tip support semantics only; no full rods, moving-support reactions, retained grasp or gameplay acceptance.'};
await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({checks,failures,heads,report:resolve(out,'report.json')}));
assert.equal(failures.length,0,'physical sensor exclusion');
