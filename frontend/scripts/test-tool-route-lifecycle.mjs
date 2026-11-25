// A yielded extraction search must use the current body, not old shoulders.
import assert from 'node:assert/strict';
import * as T from 'three';
import {tsLoader} from './lib/ts-load.mjs';
const inert=['@/lib/embodiment/contactAudio','./water/water','./toolWork','./interactions','./physics','./effortMeter','./placement','./stationBoard','./shelfBooks','./openBook','./exploration'];
const load=tsLoader({three:T,...Object.fromEntries(inert.map(p=>[p,{}]))});
const {Manipulator}=load('components/study-space/world/manipulation.ts');
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z);
const m=Object.create(Manipulator.prototype),stage=new T.Group(),group=new T.Group(),root=new T.Group();stage.add(group,root);stage.updateWorldMatrix(true,true);
const p={obj:{id:'tool',kind:'tool.broom',scale:1},group};
let shoulder=V(0,1.3,0),probe;
const local=new T.Matrix4().makeRotationX(Math.PI/2).setPosition(.1,1.1,.3),anchors=new Map([[1,{local}]]);
const character={root,rig:{armReach:()=>({shoulder:shoulder.clone(),upper:.25,fore:.214})},bodyForward:out=>out.set(0,0,1)};
const extraction={id:'tool',rotation:new T.Quaternion(),route:null,task:null,index:0,searched:0,stopped:false};
Object.assign(m,{host:{stage,placed:new Map([['tool',p]]),character:()=>character},grasps:new Map([['tool',anchors]]),toolExtraction:extraction,
 rigidCarryPose:()=>({position:V(),rotation:new T.Quaternion()}),physics:{rackDeparture:()=>null,pointOf:()=>V(),centreFor:(_id,p)=>p,startOf:()=>new T.Quaternion(),poseAt:(_id,at)=>({position:at.clone()}),toolRoute:(_id,_goal,_rotation,reachable)=>{probe=reachable;return(function*(){while(true)yield 1;})();}}});
m.extractTool(p);
assert.equal(probe(V()),true,'initial target is reachable');
shoulder=V(3,1.3,0);
m.extractTool(p);
assert.equal(probe(V()),false,'resumed search must reject the same target after shoulder movement');
shoulder=V(0,1.3,0);m.extractTool(p);
assert.equal(probe(V()),true,'same secured grasp can become reachable again');
const old=probe;m.toolExtraction=null;
assert.equal(old(V()),false,'cancelled search cannot keep authorizing waypoints');
const {StudyPhysics}=tsLoader({three:T})('components/study-space/world/physics.ts');
{
 const ph=Object.create(StudyPhysics.prototype),record={q0:new T.Quaternion()},via=V(.04,0,.04),goal=V(.08,0,0);
 Object.assign(ph,{bodies:new Map([['tool',record]]),disposed:false,pointOf:()=>V(),toolMotionFraction:(_r,a,_aq,b)=>a.length()<1e-8&&b.x>.05?0:1});
 const route=ph.toolRoute('tool',goal,new T.Quaternion(),()=>true,[via]).next();
 assert(route.done&&route.value?.length===2,'a verified reverse path avoids blind lattice expansion');
 assert(route.value[0].distanceTo(via)<1e-9&&route.value[0]!==via,'route owns its own waypoint copies');
 const blocked=ph.toolRoute('tool',goal,new T.Quaternion(),()=>false,[via]);
 let result;do{result=blocked.next();}while(!result.done);
 assert.equal(result.value,null,'historical route never bypasses current anatomical rejection');
}
for(const changed of [false,true]){
 const ph=Object.create(StudyPhysics.prototype),record={q0:new T.Quaternion()};let moved=false;
 Object.assign(ph,{bodies:new Map([['tool',record]]),disposed:false,pointOf:()=>V(),
  toolMotionFraction:(_r,a,_aq,b)=>a.length()<1e-8&&b.x>.05?0:1});
 const task=ph.toolRoute('tool',V(.08,0,0),new T.Quaternion(),at=>!moved||at.x>=.059);
 for(let i=0;i<26;i++)assert.equal(task.next().done,false,'search yields while exploring neighbours');
 moved=changed;const result=task.next();assert.equal(result.done,true,'search completes after frontier expansion');
 if(changed)assert.equal(result.value,null,'a path with an obsolete earlier edge is refused');
 else assert.ok(result.value?.length===2,'unchanged reachable detour stays valid');
}
console.log('tool-route-lifecycle: live shoulder, cancelled-search and stale-edge checks PASS');
// Extraction must leave the whole tool in front of the support, not merely
// arrive at a wrist-friendly point still inside its side posts. Check real
// transformed bounds and prove this query never writes either scene object.
for(const yaw of [0,.71,2.3])for(const scale of [.65,1,1.4]){
 const stage=new T.Group(),rackGroup=new T.Group(),toolGroup=new T.Group();
 stage.position.set(4,.3,-2);stage.scale.setScalar(1.2);stage.add(rackGroup,toolGroup);
 rackGroup.position.set(1,0,-1);rackGroup.rotation.y=yaw;rackGroup.scale.setScalar(scale);
 rackGroup.add(new T.Mesh(new T.BoxGeometry(1,1.4,.3)));
 toolGroup.scale.setScalar(scale);toolGroup.add(new T.Mesh(new T.BoxGeometry(.34,1.3,.06)));
 stage.updateWorldMatrix(true,true);
 const rack={obj:{id:'rack',kind:'rack.cleaning'},group:rackGroup},tool={obj:{id:'tool',kind:'tool.broom'},group:toolGroup};
 const m=Object.create(Manipulator.prototype),q=new T.Quaternion().setFromAxisAngle(V(0,1,0),yaw),front=V(0,0,1).applyQuaternion(q),center=rackGroup.position.clone();
 Object.assign(m,{host:{stage,placed:new Map([['rack',rack],['tool',tool]])},physics:{startOf:()=>new T.Quaternion(),poseAt:(_id,c)=>({position:c.clone()})}});
 const before=JSON.stringify([rackGroup.position,rackGroup.quaternion,toolGroup.position,toolGroup.quaternion]);
 const exit=m.extractionExit(tool,center,q,'rack');
 assert(exit.clone().sub(center).dot(front)>=.18*scale+.009-1e-8,'whole rigid bounds clear the actual support front');
 assert(exit.clone().sub(center).cross(front).length()<1e-8,'query preserves tangential placement');
 const far=center.clone().addScaledVector(front,2);assert(m.extractionExit(tool,far,q,'rack').distanceTo(far)<1e-9,'already clear destination stays unchanged');
 assert.equal(JSON.stringify([rackGroup.position,rackGroup.quaternion,toolGroup.position,toolGroup.quaternion]),before,'no tool/root/support teleport');
}
console.log('tool-route-lifecycle: nine rotated/scaled support-exit bounds PASS');
