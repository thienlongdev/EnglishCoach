import assert from 'node:assert/strict';
import * as T from 'three';
import {tsLoader} from './lib/ts-load.mjs';
const inert=['./water/water','./toolWork','./interactions','./physics','./effortMeter','./placement','./stationBoard','./shelfBooks','./openBook','./exploration'];
const load=tsLoader({three:T,'@/lib/embodiment/contactAudio':{contactSound:()=>{}},...Object.fromEntries(inert.map(p=>[p,{}]))});
const {Manipulator}=load('components/study-space/world/manipulation.ts');
const V=(x=0,y=0,z=0)=>new T.Vector3(x,y,z);
let count=0;
function setup(two=false){
 const m=Object.create(Manipulator.prototype), group=new T.Group(), to=V(.2,.023,-.4), q=new T.Quaternion();
 const p={obj:{id:'book',kind:'book.single'},group};
 let at=to.clone(), held=true, releases=0, restored=0, forgotten=0, removed=0;
 const contacts=new Map([[1,{wrist:V(.1,.05,-.4)}],[-1,{wrist:V(.3,.05,-.4)}]]);
 const wrists=new Map([...contacts].map(([side,c])=>[side,c.wrist.clone()]));
 const physics={heldIn:side=>side===1&&held?'book':null,pointOf:()=>at,poseAt:()=>({position:to.clone(),quaternion:q.clone()}),release:()=>{held=false;releases++;},forget:()=>{held=false;forgotten++;},backInWorld:()=>{restored++;},endRackTransfer:()=>{},resumeHeld:()=>{},holdRotation:()=>{},aim:(_s,p)=>at.copy(p),supportedRelease:()=>true,cancelSupportedRelease:()=>{}};
 const stage=new T.Group();
 Object.assign(m,{carryGoals:new Map(),toolCarryFrames:new Map(),liftingOff:new Set(),host:{placed:new Map([['book',p]]),stage,character:()=>({rig:{contactOn:s=>contacts.get(s),wristWorld:s=>wrists.get(s)},root:new T.Group()}),changed:()=>{},say:()=>{},despawn:()=>{removed++;},layout:()=>({room:{size:6}}),exploration:{},reduced:()=>false},physics,placing:null,placeEyes:to.clone(),heldPaths:new Map([['book',to.clone()]]),twoHanded:new Set(two?['book']:[]),actions:{letGo:()=>{}},carried:new Map(),work:{active:null},constrainHeld:(_s,_p,v)=>v});
 m.startPlacement(1,to,q);
 return {m,group,to,q,contacts,wrists,physics,get releases(){return releases},get restored(){return restored},get forgotten(){return forgotten},get removed(){return removed},offset:v=>at.add(v)};
}
for(const failure of ['distance','rotation','right-hand','second-hand']){
 const x=setup(failure==='second-hand');
 if(failure==='distance')x.offset(V(.01));
 if(failure==='rotation')x.group.quaternion.setFromAxisAngle(V(0,1),.03);
 if(failure==='right-hand')x.wrists.get(1).x+=.01;
 if(failure==='second-hand')x.contacts.delete(-1);
 x.m.releasePlaced();assert.equal(x.releases,0,failure+' must retain ownership');assert.ok(x.m.placing);count++;
}
for(const two of [false,true]){
 const x=setup(two);x.m.releasePlaced();x.m.releasePlaced();assert.equal(x.releases,1,'release exactly once at actual pose');assert.equal(x.m.placing,null);assert.equal(x.m.heldPaths.size,0);count++;
}
{
 const x=setup();x.m.updateHeldTargets(x.physics,.1);
 assert.equal(x.physics.pointOf().y,.023,'thin object reaches validated support below 5cm');assert.equal(x.releases,0);count++;
}
for(const outcome of ['failed','cancelled']){
 const x=setup();let done=0;
 const first=x.m.startPlacement(1,x.to,x.q,{gone:true,done:()=>done++});
 if(outcome==='failed')x.m.updateHeldTargets(x.physics,9);else x.m.cancelPlacement();
 assert.equal(first.result,outcome);assert.equal(x.m.placing,null);assert.equal(x.m.placeEyes,null);assert.equal(x.m.heldPaths.size,0);
 assert.equal(x.physics.heldIn(1),'book','failure retains held ownership');assert.equal(done,0);assert.equal(x.forgotten,0);assert.equal(x.removed,0);
 assert.ok(x.restored>0,'cancel/timeout restores physical collisions');
 const next=x.m.startPlacement(1,x.to,x.q,{gone:true});x.m.releasePlaced();
 assert.equal(next.result,'placed');assert.equal(done,0,'an old bin effect cannot run on a later shelf return');count++;
}
{
 const x=setup();const operation=x.m.startPlacement(1,x.to,x.q,{store:{host:'missing',slot:0}});x.m.releasePlaced();
 assert.equal(operation.result,'failed','a vanished drawer is a refused transfer');assert.equal(x.physics.heldIn(1),'book');assert.equal(x.forgotten,0);count++;
}
{
 const x=setup();const operation=x.m.placing;x.physics.heldIn=()=> 'different-object';x.m.releasePlaced();
 assert.equal(operation.result,'failed');assert.equal(x.releases,0,'a placement cannot release a replacement in the same hand');count++;
}
// Rack revalidation uses the supported face selected for this placement,
// including the rotated centre offset. Moving/deleting the rack still fails.
const {onRack}=load('lib/study-space/kit.ts');
for(const outcome of ['placed','moved','turned','missing','unsupported']) {
 const x=setup(), p=x.m.host.placed.get('book');p.obj.kind='tool.broom';
 const rack={obj:{id:'rack',kind:'rack.cleaning',pos:[0,0,-2],rotY:0},group:new T.Group()};
 x.m.host.placed.set('rack',rack);x.m.host.objectState=()=>{};
 const spot=onRack(rack.obj,p.obj.kind,Math.PI),local=V(.01,.6,.02);
 x.q.setFromAxisAngle(V(0,1,0),spot.rotY);x.group.quaternion.copy(x.q);x.group.position.set(...spot.pos);
 x.to.copy(x.group.position).add(local.clone().applyQuaternion(x.q));x.offset(x.to.clone().sub(x.physics.pointOf()));
 x.physics.centreFor=(_id,at,q,out)=>out.copy(at).add(local.clone().applyQuaternion(q));
 x.physics.poseAt=(_id,at,q)=>({position:at.clone().sub(local.clone().applyQuaternion(q)),quaternion:q.clone()});
 const op=x.m.startPlacement(1,x.to,x.q,{rack:'rack'});
 // This fixture isolates final release gates. Route progression has its own
 // lifecycle tests; arrival alone cannot bypass it in the real controller.
 assert.ok(op.rackPath);x.m.releasePlaced();assert.equal(x.releases,0,'unfinished insertion cannot release');
 op.rackPath.ready=true;
 if(outcome==='moved')rack.obj.pos[0]+=.1;
 if(outcome==='turned')rack.obj.rotY+=.1;
 if(outcome==='missing')x.m.host.placed.delete('rack');
 if(outcome==='unsupported')x.physics.supportedRelease=()=>false;
 x.m.releasePlaced();
 assert.equal(op.result,outcome==='placed'?'placed':outcome==='unsupported'?'moving':'failed',outcome+' rack result');
 assert.equal(x.forgotten,0,'rack return never deletes the body as a substitute for support');
 assert.equal(x.releases,outcome==='placed'?1:0,'only measured support allows release');
 if(outcome==='unsupported')assert.equal(x.physics.heldIn(1),'book','unsupported rack pose stays in hand');count++;
}
const {Exploration}=load('components/study-space/world/exploration.ts');
const {RoomNavigation}=load('lib/study-space/navigation.ts');
for(const hz of [30,60,120]){
 const nav=new RoomNavigation(6,[]), root=new T.Group(), target=V(.41,0,-.77);
 const ch={ready:true,root,driveReady:()=>true,drive:p=>root.position.copy(p)};
 const e=Object.create(Exploration.prototype);
 Object.assign(e,{host:{character:()=>ch,navigation:()=>nav},route:null,view:'third',stuck:0,yaw:0,speed:0});
 let result=false;
 for(let i=0;i<hz*5&&!result;i++)result=e.walkToward(target,.006,1/hz,true,true);
 assert.equal(result,true);assert.ok(root.position.distanceTo(target)<=.006,'precise stance cannot finish at the old 6cm waypoint radius');count++;
 root.position.set(0,0,0);ch.drive=()=>{};e.route=null;
 for(let i=0;i<hz;i++)if(e.walkToward(target,.006,1/hz,true,true)===null){result=null;break;}
 assert.equal(result,null,'a blocked stance does not report arrival');count++;
}
console.log(`placement-release: ${count} position/rotation/both-hand/refusal/thin-support/precise-navigation checks PASS`);

// A rotated chair still reserves the full actor radius around every side.
// In a world-axis box the extra corner prevented a sub-millimetre stance
// correction over 30 cm from the actual chair outline.
{
  const m = Object.create(Manipulator.prototype);
  const box = new T.Box3(V(-.3,0,-.25),V(.3,1.2,.25));
  m.ownBox = () => box;
  for (const yaw of [0,.71,1.9]) {
    const rotation = new T.Quaternion().setFromAxisAngle(V(0,1,0),yaw);
    const matrix = new T.Matrix4().compose(V(1,0,-.6),rotation,V(1,1,1));
    const inside = m.placementFootprint({},matrix);
    assert(inside(V(.49,0,0).applyMatrix4(matrix)), 'keep 20 cm beside the rotated side');
    assert(inside(V(.43,0,.38).applyMatrix4(matrix)), 'keep the round corner clearance');
    assert(!inside(V(.47,0,.42).applyMatrix4(matrix)), 'a clear diagonal remains available');
  }
  const tilted = new T.Matrix4().makeRotationX(Math.PI/2);
  assert(m.placementFootprint({},tilted)(V(0,0,1.28)), 'the full tilted height projects into the floor footprint');
}
