// Actual cast FK and the rack's actual navigation footprint. The old local
// optimizer cannot leave an invalid initial point with only 10cm trials.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {loadCastGeometry} from './lib/load-cast.mjs';
import {tsLoader} from './lib/ts-load.mjs';
const load=tsLoader({three:T});
const {HumanRig}=load('lib/embodiment/human.ts');
const {RoomNavigation}=load('lib/study-space/navigation.ts');
const {onRack}=load('lib/study-space/kit.ts');
const assets=readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts',import.meta.url),'utf8');
const V=(...v)=>new T.Vector3(...v);
let checks=0;
for(const hero of ['LYRA','KAI']){
 const gltf=await loadCastGeometry(assets.match(new RegExp(hero+": '([^']+)'"))[1]);
 const root=new T.Group(),model=gltf.scene;model.scale.setScalar(1.04);root.add(model);
 const rig=new HumanRig(model,root),mixer=new T.AnimationMixer(model);
 mixer.clipAction(gltf.animations.find(c=>c.name==='Idle')).play();
 rig.restore();mixer.update(1/60);rig.capture();root.updateWorldMatrix(true,true);
 const origin=V(-.3667290917,0,-1.7382353389);
 const captured=[
  {side:-1,wrist:V(-.2794837285,1.3009283295,-2.085775949),fingers:V(-.857296278,0,.51482336)},
  {side:1,wrist:V(-.4235494874,1.0594887893,-2.030223428),fingers:V(.942672517,-.332132538,.032503904)},
 ];
 const rack={pos:[0,0,-2],rotY:0};
 const initial=onRack(rack,'tool.broom'),destination=onRack(rack,'tool.broom',Math.PI);
 assert.deepEqual(initial.pos,destination.pos,'storage support does not move');
 assert.equal(destination.rotY,Math.PI,'symmetric shaft retains nearer face');
 const turn=new T.Quaternion().setFromAxisAngle(V(0,1,0),destination.rotY),tool=V(...initial.pos);
 const contacts=captured.map(c=>({...c,wrist:c.wrist.clone().sub(tool).applyQuaternion(turn).add(tool),fingers:c.fingers.clone().applyQuaternion(turn)}));
 const nav=new RoomNavigation(6,[{x:0,z:-2,width:1.02,depth:.36,rotation:0}]);
 const snapshot=()=>JSON.stringify({root:[root.position.toArray(),root.quaternion.toArray()],bones:[...rig.base.keys()].map(b=>[b.position.toArray(),b.quaternion.toArray()])});
 const before=snapshot();
 assert.equal(nav.free(origin),false,'recorded placement seed is inside the inflated rack');
 const start=performance.now(),found=rig.reachStance(contacts,origin,Math.PI,at=>nav.free(at));
 console.log(JSON.stringify({hero,found:found?.toArray(),ms:performance.now()-start}));
 assert.ok(found,hero+' finds a free reachable stance from a blocked seed');
 assert.ok(nav.free(found),'selected stance clears the rack');
 assert.ok(found.z>-1.62,'uses the open front');
 assert.equal(snapshot(),before,'trial bones and root restored');
 assert.equal(rig.reachStance(contacts,origin,Math.PI,()=>false),null,'fully blocked floor still refuses');
 assert.equal(snapshot(),before,'refusal restores all written transforms');
 checks++;
}
console.log(`rack stance: ${checks} actual-cast blocked-seed/refusal/transaction checks PASS`);
