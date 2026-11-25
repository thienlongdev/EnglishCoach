// Controller ownership/continuation tests. Actual spring-contact mechanics
// are covered separately by test-rack-transfer with the current authored GLB.
import assert from 'node:assert/strict';
import * as T from 'three';
import {tsLoader} from './lib/ts-load.mjs';
const inert=['./water/water','./toolWork','./interactions','./physics','./effortMeter','./placement','./stationBoard','./shelfBooks','./openBook','./exploration'];
const load=tsLoader({three:T,'@/lib/embodiment/contactAudio':{contactSound(){}},...Object.fromEntries(inert.map(p=>[p,{}]))});
const {Manipulator}=load('components/study-space/world/manipulation.ts');
const {onRack}=load('lib/study-space/kit.ts');
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z),Q=()=>new T.Quaternion();
function setup(){
 const m=Object.create(Manipulator.prototype),stage=new T.Group(),group=new T.Group();stage.add(group);
 const rack={obj:{id:'rack',kind:'rack.cleaning',pos:[0,0,-1.8],rotY:.71},group:new T.Group()};
 const spot=onRack(rack.obj,'tool.broom'),to=V(...spot.pos),rotation=Q().setFromAxisAngle(V(0,1,0),spot.rotY),q0=Q().setFromAxisAngle(V(1,0,0),.2);
 const p={obj:{id:'tool',kind:'tool.broom',scale:1},group},at=V(-.2,.3,-.8),align=at.clone(),via=at.clone().add(V(0,.1,-.1));
 const state={aligned:false,reach:true,supported:false,released:0,restored:0,resumed:0,ended:0,starts:0,probes:[],drives:[],queries:[],reached:[],route:[via,to],search:false,searchTicks:0};
 const physics={motionStepSeconds:dt=>dt,rackDeparture:()=>null,heldIn:s=>s===1?'tool':null,pointOf:()=>at.clone(),startOf:()=>q0.clone(),groupRotationOf:()=>rotation.clone(),
  poseAt:(_id,c,q)=>({position:c.clone(),quaternion:q.clone().multiply(q0)}),centreFor:(_id,p,_q,out)=>out.copy(p),
  backInWorld(){state.restored++;},resumeHeld(){state.resumed++;},endRackTransfer(){state.ended++;},beginRackTransfer(){state.starts++;return true;},
  toolWaypointReached:(_id,goal,q,next)=>{state.queries.push({goal:goal.clone(),q:q.clone(),next:next?.clone()});return goal.distanceTo(align)<1e-9?state.aligned:state.reached.some(p=>p.distanceTo(goal)<1e-9);},
  toolRoute:(_id,goal,q,probe)=>{state.probes.push(probe);return(function*(){while(state.search){state.searchTicks++;yield 1;}return state.route;})();},
  driveTool:(side,id,position,q,dt,stationary)=>state.drives.push({side,id,position:position.clone(),q:q.clone(),dt,stationary}),
  supportedRelease:()=>state.supported,cancelSupportedRelease(){},release(){state.released++;}};
 const wrist=V(.1,1,0),rig={contactOn:()=>({wrist}),wristWorld:()=>wrist.clone()};
 Object.assign(m,{carryGoals:new Map(),host:{stage,placed:new Map([['tool',p],['rack',rack]]),character:()=>({rig}),say(){},changed(){},layout:()=>({room:{size:6}}),exploration:{}},physics,
  work:{active:null},placing:null,twoHanded:new Set(),heldPaths:new Map(),actions:{letGo(){}},carried:new Map(),
  extractionExit:(_p,at)=>at,extractionReachable:()=>state.reach,rigidCarryPose:(_p,q)=>({position:align.clone(),rotation:q}),constrainHeldPose:(_p,center,rotation)=>({center,rotation}),placementReachable:()=>state.reach});
 const op=m.startPlacement(1,to,rotation.clone().multiply(q0.clone().invert()),{rack:'rack'});
 return {m,p,rack,op,physics,state,at,align,via,to,rotation};
}
let checks=0;
{
 const x=setup();x.align.z+=.09;x.m.updateRackPlacement(x.p,1/60);
 assert(x.op.rackPath.settleAt.distanceTo(x.at)<1e-9,'brake at the actual reachable pose clear of the rack');
 assert.equal(x.state.probes.length,0,'braking still waits for physical arrival');
 const blocked=setup();blocked.state.reach=false;blocked.m.updateRackPlacement(blocked.p,1/60);
 assert.equal(blocked.op.rackPath.settleAt,undefined,'an unreachable physical pose cannot start alignment');checks++;
}
{
 const x=setup(),clear=x.align.clone().add(V(0,0,.08));
 x.m.extractionExit=()=>clear.clone();
 x.op.rackPath.approach=false;
 x.m.updateRackPlacement(x.p,1/60);
 assert.equal(x.state.probes.length,0,'an unfinished realignment cannot start insertion');
 assert(x.op.rackPath.target.distanceTo(clear)<1e-9,'after the walk an unaligned tool stays outside the rail');
 checks++;
}
{
 const x=setup();x.op.rackPath.approach=true;
 x.state.aligned=true;x.m.updateHeldTargets(x.physics,1/60);
 assert.equal(x.state.probes.length,0,'aligning before approach never starts insertion');
 x.align.x+=.05;x.m.updateHeldTargets(x.physics,1/60);
 assert(x.op.rackPath.target.distanceTo(x.align)<1e-9,'approach carries the aligned tool with the actual body');
 assert.equal(x.state.probes.length,0,'walking still cannot begin insertion');
 assert.equal(x.state.drives.at(-1).stationary,false,'moving approach uses the motion trajectory controller');
 x.op.rackPath.approach=false;x.m.updateHeldTargets(x.physics,1/60);
 assert.equal(x.state.probes.length,1,'only completed approach enables the physical insertion route');checks++;
}
{
 const m=Object.create(Manipulator.prototype),group=new T.Group(),attempts=[],messages=[];
 group.rotation.y=2.8;
 const p={obj:{id:'tool',kind:'tool.broom'},group},rack={obj:{id:'rack',kind:'rack.cleaning',pos:[0,0,-1.8],rotY:0},group:new T.Group()};
 Object.assign(m,{rackRoutes:new Map(),heldThing:()=>({side:1,p}),host:{say:(...args)=>messages.push(args)},physics:{startOf:()=>Q(),centreFor:(_id,at,_q,out)=>out.copy(at)},
  placeHeldAt:(_side,at,q,options,quiet)=>{attempts.push({at:at.toArray(),q:q.clone(),options,quiet});return q.angleTo(Q())<1e-6;}});
 m.hangBack(rack);
 assert.equal(attempts.length,2,'unreachable nearest face must try the other authored symmetry');
 assert(attempts[0].q.angleTo(Q().setFromAxisAngle(V(0,1,0),Math.PI))<1e-6);
 assert(attempts[1].q.angleTo(Q())<1e-6);
 assert.deepEqual(attempts[0].at,attempts[1].at,'support position is never moved to make a pose pass');
 assert.equal(attempts[0].quiet,true);assert.equal(attempts[1].quiet,false);assert.equal(messages.length,0);checks++;
 attempts.length=0;
 m.rackRoutes.set('tool',{rack:'rack',rackGroup:rack.group,toolGroup:p.group,frame:rack.group.matrixWorld.clone(),rotation:Q()});
 m.hangBack(rack);assert.equal(attempts.length,1,'reuse the original physical storage face first');checks++;
 rack.group.rotation.y=.4;attempts.length=0;m.hangBack(rack);
 assert.equal(attempts.length,2,'moved rack does not reuse a stale storage orientation');checks++;
 p.obj.kind='tool.cloth';attempts.length=0;m.hangBack(rack);
 assert.equal(attempts.length,1,'asymmetric supports never invent a second orientation');checks++;
}
{
 const x=setup(),before=x.p.group.matrix.clone();x.m.updateHeldTargets(x.physics,1/60);
 assert.equal(x.state.probes.length,0,'align before searching at a different orientation');assert.equal(x.state.drives.length,1);
 assert.equal(x.state.drives[0].stationary,true,'no fictitious waypoint velocity');assert(x.state.drives[0].q.angleTo(x.rotation)<1e-7);
 assert.deepEqual(x.p.group.matrix.elements,before.elements,'controller cannot write the drawing');assert.equal(x.state.released,0);checks++;
 x.state.aligned=true;x.m.updateHeldTargets(x.physics,1/60);assert.equal(x.op.rackPath.index,0);assert(x.state.drives.at(-1).position.distanceTo(x.via)<1e-9);
 x.m.updateHeldTargets(x.physics,1/60);assert.equal(x.op.rackPath.index,0,'requested target is not actual arrival');checks++;
 x.at.copy(x.via);x.state.reached.push(x.via);x.m.updateHeldTargets(x.physics,1/60);assert.equal(x.op.rackPath.index,1);assert(x.state.drives.at(-1).position.distanceTo(x.to)<1e-9);
 x.at.lerp(x.to,.5).add(V(.003,.002,.001));x.m.updateHeldTargets(x.physics,1/60);
 const projected=new T.Line3(x.via,x.to).closestPointToPoint(x.at,true,V());
 assert(x.state.drives.at(-1).position.distanceTo(projected)<1e-9,'correct physical spring deflection before advancing along the rail');
 assert(x.state.queries.some(q=>q.next?.distanceTo(x.to)<1e-9),'corner checks include the actual next edge');checks++;
 x.at.copy(x.to);x.p.group.quaternion.copy(x.rotation);x.state.supported=true;x.m.releasePlaced();assert.equal(x.state.released,0,'final pose cannot skip unfinished route');
 x.state.reached.push(x.to);x.m.updateHeldTargets(x.physics,1/60);assert.equal(x.op.rackPath.ready,true);
 x.state.supported=false;x.m.releasePlaced();assert.equal(x.state.released,0,'route completion cannot substitute for support');
 x.state.supported=true;x.m.releasePlaced();assert.equal(x.state.released,1);assert.equal(x.op.result,'placed');checks++;
}
{
 const x=setup();x.state.aligned=true;x.state.search=true;x.m.updateRackPlacement(x.p,1/60);const probe=x.state.probes[0];
 assert(probe(x.via));x.state.reach=false;assert.equal(probe(x.via),false,'yielded return reads current reach');x.state.reach=true;
 x.m.updateRackPlacement(x.p,20);assert.equal(x.op.result,'moving','bounded planner work is not movement timeout');assert(x.op.left===8);assert(x.state.drives.at(-1).position.distanceTo(x.at)<1e-9,'hold actual pose during search');
 x.m.cancelPlacement();assert.equal(probe(x.via),false,'cancel revokes the generator');assert.equal(x.op.result,'cancelled');assert.equal(x.state.resumed,1);assert.equal(x.state.ended,1);assert.equal(x.state.released,0);checks++;
}
for(const change of ['moved','turned','missing','no-route','timeout']){
 const x=setup();x.state.aligned=true;
 if(change==='moved')x.rack.obj.pos[0]+=.02;
 if(change==='turned')x.rack.obj.rotY+=.1;
 if(change==='missing')x.m.host.placed.delete('rack');
 if(change==='no-route')x.state.route=null;
 x.m.updateRackPlacement(x.p,change==='timeout'?9:1/60);
 assert.equal(x.op.result,'failed',change);assert.equal(x.state.released,0);assert.equal(x.physics.heldIn(1),'tool');assert.equal(x.state.resumed,1);assert.equal(x.state.ended,1);assert.equal(x.state.restored,1);checks++;
}
{
 const x=setup();x.state.aligned=true;x.op.rackPath.aligned=true;x.state.route=[x.to];
 for(let i=0;i<20;i++){x.at.lerp(x.to,.01);x.m.updateRackPlacement(x.p,1);}
 assert.equal(x.op.result,'moving','observed slow insertion renews the stall timer');
 const draws=x.state.drives.length;
 for(let i=0;i<9&&x.m.placing;i++)x.m.updateRackPlacement(x.p,1);
 assert.equal(x.op.result,'failed','a blocked physical pose cannot renew itself from requested targets');
 assert(x.state.drives.length>draws);assert.equal(x.state.released,0);checks++;
}
console.log(`rack-placement: ${checks} alignment/waypoint/live-reach/support/interruption/refusal groups PASS`);
