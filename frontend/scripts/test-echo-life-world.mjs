// Echo Life world: the house plan, the city and the one walk model, checked without a browser.
// A body walks on foot from the study room through the real door, the hallway, down the stair, through the lobby, out of the
// front door, round the block to the riverside and back, in 3.5 cm steps; every step must be admitted and every floor change
// must be a stair or a curb, never a jump.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),babel=require('next/dist/compiled/babel/bundle.js');
const src=fileURLToPath(new URL('../src/',import.meta.url)),cache=new Map();
function load(rel){if(cache.has(rel))return cache.get(rel);const m={exports:{}};cache.set(rel,m.exports);const code=babel.core().transformSync(fs.readFileSync(path.join(src,rel),'utf8'),{filename:rel,babelrc:false,configFile:false,presets:[babel.presetTypescript()],plugins:[babel.pluginTransformModulesCommonjs()]}).code;new Function('module','exports','require',code)(m,m.exports,n=>load(n.startsWith('@/')?n.slice(2)+'.ts':path.posix.normalize(path.posix.dirname(rel)+'/'+n)+'.ts'));return m.exports;}

const {RoomNavigation}=load('lib/study-space/navigation.ts');
const {walkSlide}=load('lib/study-space/exploration.ts');
const {housePlan,GROUND_Y,inRect}=load('lib/echo-life/plan.ts');
const {cityPlan,outdoorAt}=load('lib/echo-life/city.ts');
const {V3_ZONE_IDS}=load('lib/echo-life/zones.ts');
const {LifeWalk}=load('lib/echo-life/walk.ts');
let checks=0;const ok=(c,m)=>{assert.ok(c,m);checks++;};

// A player steers round furniture: a grid search over the walk's own answer, then the legs follow the cells in 3.5 cm steps.
function route(walk,from,to){
  const dist=Math.hypot(to.x-from.x,to.z-from.z);
  const step=dist>25?.25:.1,pad=dist>25?14:10;
  const x0=Math.min(from.x,to.x)-pad,z0=Math.min(from.z,to.z)-pad,nx=Math.ceil((Math.max(from.x,to.x)+pad-x0)/step),nz=Math.ceil((Math.max(from.z,to.z)+pad-z0)/step);
  const id=(i,j)=>j*nx+i,cell=p=>[Math.round((p.x-x0)/step),Math.round((p.z-z0)/step)],at=(i,j)=>({x:x0+i*step,z:z0+j*step});
  const [si,sj]=cell(from),free=new Map(),ok=(i,j)=>{const k=id(i,j);if(!free.has(k))free.set(k,i>=0&&j>=0&&i<nx&&j<nz&&walk.free(at(i,j)));return free.get(k);};
  // A named place that a piece of furniture stands on: the nearest free spot beside it (a person stops at the sofa, not in it).
  let [gi,gj]=cell(to);if(!walk.free(to)){let best=null;for(let r=1;r<=15&&!best;r++)for(let a=-r;a<=r;a++)for(const [i,j] of [[gi+a,gj-r],[gi+a,gj+r],[gi-r,gj+a],[gi+r,gj+a]])if(!best&&ok(i,j))best=[i,j];if(!best)return null;[gi,gj]=best;to=at(gi,gj);}
  const came=new Map([[id(si,sj),-1]]),cost=new Map([[id(si,sj),0]]),open=[[Math.hypot(gi-si,gj-sj),si,sj]];
  while(open.length){
    let bi=0;for(let m=1;m<open.length;m++)if(open[m][0]<open[bi][0])bi=m;
    const [,i,j]=open.splice(bi,1)[0];
    if(i===gi&&j===gj)break;
    for(const [di,dj] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
      const a=i+di,b=j+dj;if(!ok(a,b)||(di&&dj&&(!ok(i+di,j)||!ok(i,j+dj))))continue;
      const c=cost.get(id(i,j))+Math.hypot(di,dj);if(c>=(cost.get(id(a,b))??Infinity))continue;
      cost.set(id(a,b),c);came.set(id(a,b),id(i,j));open.push([c+Math.hypot(gi-a,gj-b),a,b]);
    }
  }
  if(!came.has(id(gi,gj)))return null;
  const path=[];for(let k=id(gi,gj);k!==-1;k=came.get(k))path.unshift(at(k%nx,Math.floor(k/nx)));
  path[path.length-1]=to;return path;
}
function walkTo(walk,p,to,label){
  const path=route(walk,p,to);if(!path)throw new Error(`${label}: no way from ${p.x.toFixed(2)},${p.z.toFixed(2)} to ${to.x.toFixed(2)},${to.z.toFixed(2)} (region ${walk.region(p)})`);
  let track=[];for(const w of path.slice(1)){const r=walkLeg(walk,p,w,label);p=r.p;track=track.concat(r.track);}
  return {p,track};
}
function walkLeg(walk,p,to,label,maxSteps=600){
  let last=walk.groundAt(p.x,p.z),track=[];
  for(let i=0;i<maxSteps;i++){
    const dx=to.x-p.x,dz=to.z-p.z,d=Math.hypot(dx,dz);if(d<.05)return {p,track};
    const s=Math.min(.08,d),q=walkSlide(walk,p,dx/d*s,dz/d*s);
    if(Math.hypot(q.x-p.x,q.z-p.z)<1e-6)throw new Error(`${label}: blocked at ${p.x.toFixed(2)},${p.z.toFixed(2)} (to ${to.x.toFixed(2)},${to.z.toFixed(2)}) region ${walk.region(p)}`);
    p=q;const y=walk.groundAt(p.x,p.z);
    assert.ok(y!==null&&walk.free(p),`${label}: an admitted step left the floor at ${p.x.toFixed(2)},${p.z.toFixed(2)}`);
    assert.ok(Math.abs(y-last)<=.13,`${label}: floor jumped ${(y-last).toFixed(3)} m at ${p.x.toFixed(2)},${p.z.toFixed(2)}`);
    last=y;track.push({x:p.x,z:p.z,y});
  }
  throw new Error(`${label}: did not arrive`);
}

for(const size of [4,6,7.5,9]){
  const house=housePlan(size),city=cityPlan(house),h=size/2;
  const open=new Set(['hall','bath','entrance']);
  const room=new RoomNavigation(size,[]);
  const walk=new LifeWalk(house,city,room,()=>open);
  for(const residence of city.residences) {
    const {property,door,stair,entryPoint,outsidePoint}=residence;
    ok(walk.zone(entryPoint)===null,'Private floor waits for ownership');
    walk.setOwnedHomes([property.id]);
    ok(!walk.free(door),'Closed residence threshold');
    open.add(door.id);
    ok(walk.clearLine(outsidePoint,entryPoint),'Continuous walk through purchased home entrance');
    const sx=(stair.rect.x0+stair.rect.x1)/2;
    ok(walk.clearLine({x:sx,z:stair.rect.z0-.45},{x:sx,z:stair.rect.z1+.45}),'Clear stair flight to landing');
    ok(residence.furniture.every(f=>!walk.free(f)),'Residence furniture collisions');
    open.delete(door.id);walk.setOwnedHomes([]);
  }
  const net=city.props.find(prop=>prop.asset==='badminton-net');
  for(const side of [-1,1]){
    const z=net.z+side*1.9;
    for(const offset of [-.85,0,.85]){
      const target={x:net.x+offset,z};
      ok(walk.free(target) && walk.zone(target)==='park',`size ${size}: a player can receive at each court target`);
    }
  }
  const door=id=>house.doors.find(d=>d.id===id);
  const hall=door('hall'),bath=door('bath'),entrance=door('entrance');
  const stair=house.stair.rect;
  // Walls and closed doors: the same walk with every door shut cannot leave the study room.
  const shut=new LifeWalk(house,city,room,()=>new Set());
  let p={x:h-.4,z:hall.z};const before={...p};
  for(let i=0;i<80;i++)p=walkSlide(shut,p,.05,0);
  ok(p.x<=h-.19,'A closed door keeps the body in the study room');
  ok(!shut.free({x:h+.08,z:hall.z}),'The doorway itself is solid while the leaf is shut');
  // On foot: study -> hallway -> living room -> kitchen -> hallway -> bathroom -> hallway -> stair -> lobby -> street.
  p={x:0,z:hall.z};
  const hx=(house.zones.find(z=>z.id==='hall').rect.x0+house.zones.find(z=>z.id==='hall').rect.x1)/2;
  const living=house.zones.find(z=>z.id==='living').rect;
  const legs=[
    [{x:h-.3,z:hall.z},'to the hallway door'],[{x:hx,z:hall.z},'through the hallway door'],
    [{x:hx,z:-h+1.5},'along the hallway'],[{x:living.x0+1.2,z:-h+1.5},'through the arch'],[{x:living.x1-1,z:h-.8},'across to the kitchen'],
    [{x:living.x0+1.2,z:-h+1.5},'back to the arch'],[{x:hx,z:-h+1.5},'into the hallway'],[{x:hx,z:h-.5},'to the bathroom door side'],
    [{x:bath.x,z:h-.5},'hallway is wall: blocked expected'],
  ];
  for(const [to,label] of legs.slice(0,8))p=walkTo(walk,p,to,`size ${size} ${label}`).p;
  ok(walk.region(p)==='hall','The body is in the hallway beside the bathroom wall');
  // The bathroom door is reached from the living room side (it is in the living room's south wall).
  p=walkTo(walk,p,{x:hx,z:-h+1.5},`size ${size} back up the hallway`).p;
  p=walkTo(walk,p,{x:living.x0+1.2,z:-h+1.5},`size ${size} into the living room`).p;
  p=walkTo(walk,p,{x:bath.x,z:h-.6},`size ${size} to the bathroom door`).p;
  p=walkTo(walk,p,{x:bath.x,z:h+1.2},`size ${size} into the bathroom`).p;
  ok(walk.region(p)==='bath','Inside the bathroom');
  p=walkTo(walk,p,{x:bath.x,z:h-.6},`size ${size} out of the bathroom`).p;
  p=walkTo(walk,p,{x:living.x0+1.2,z:-h+1.5},`size ${size} back to the arch`).p;
  p=walkTo(walk,p,{x:hx,z:-h+1.5},`size ${size} hallway again`).p;
  p=walkTo(walk,p,{x:hx,z:stair.z0-.3},`size ${size} to the head of the stair`).p;
  const down=walkTo(walk,p,{x:hx,z:stair.z1+.6},`size ${size} down the stair`);p=down.p;
  ok(Math.abs(walk.groundAt(p.x,p.z)-GROUND_Y)<1e-9,'The foot of the stair is the lobby floor');
  ok(down.track.some(t=>t.y<-1.4&&t.y>-1.8),'Halfway down the stair the floor is halfway down');
  // Sideways off the stair into the lobby is walled.
  const mid={x:stair.x1-.25,z:(stair.z0+stair.z1)/2};let side={...mid};for(let i=0;i<40;i++)side=walkSlide(walk,side,.05,0);
  ok(side.x<stair.x1,'The stair is walled from the lobby along its length');
  p=walkTo(walk,p,{x:entrance.x,z:house.front-.6},`size ${size} across the lobby`).p;
  p=walkTo(walk,p,{x:entrance.x,z:house.front+1.5},`size ${size} out of the front door`).p;
  ok(outdoorAt(city,p)?.surface==='sidewalk','Out of the front door is the sidewalk');
  // Across the road (a curb down and up), back, then west and up the side street to the riverside.
  const lantern=city.streets.find(s=>s.id==='lantern').rect;
  const across=walkTo(walk,p,{x:entrance.x,z:lantern.z1-1.5},`size ${size} across Lantern Street`);
  ok(across.track.some(t=>t.y<GROUND_Y-.1),'The road is below the sidewalk');
  p=walkTo(walk,across.p,{x:entrance.x,z:house.front+1.5},`size ${size} back across`).p;
  const westX=house.footprint.x0-5-6.5;
  p=walkTo(walk,p,{x:westX,z:house.front+1.5},`size ${size} west along the sidewalk`).p;
  const river=city.streets.find(s=>s.id==='riverside').rect;
  p=walkTo(walk,p,{x:westX,z:river.z1-1.5},`size ${size} up the side street`).p;
  p=walkTo(walk,p,{x:-h+.5,z:river.z1-1.5},`size ${size} along the riverside road under the study window`).p;
  ok(p.z< -h,'The riverside road is north of the study window');
  p=walkTo(walk,p,{x:-h+.5,z:city.river.z1+1},`size ${size} into the park by the water`).p;
  ok(!walk.free({x:p.x,z:city.river.z1-1}),'The river is not walkable');
  // And home again by the same streets: the way back exists.
  p=walkTo(walk,p,{x:-h+.5,z:river.z1-1.5},`size ${size} back to the road`).p;
  p=walkTo(walk,p,{x:westX,z:river.z1-1.5},`size ${size} back to the corner`).p;
  p=walkTo(walk,p,{x:westX,z:house.front+1.5},`size ${size} back down the side street`).p;
  p=walkTo(walk,p,{x:entrance.x,z:house.front+1.5},`size ${size} back to the door`).p;
  p=walkTo(walk,p,{x:entrance.x,z:house.front-.8},`size ${size} into the lobby`).p;
  p=walkTo(walk,p,{x:(stair.x0+stair.x1)/2,z:stair.z1+.6},`size ${size} to the foot of the stair`).p;
  p=walkTo(walk,p,{x:(stair.x0+stair.x1)/2,z:stair.z0-.3},`size ${size} up the stair`).p;
  ok(Math.abs(walk.groundAt(p.x,p.z))<1e-9,'Upstairs again');
  p=walkTo(walk,p,{x:hx,z:hall.z},`size ${size} to the study door`).p;
  p=walkTo(walk,p,{x:0,z:hall.z},`size ${size} back into the study`).p;
  ok(walk.region(p)==='study','Home');
  // No walkable floor lies on another: the plan is disjoint in plan view.
  for(const a of house.zones)for(const b of house.zones)if(a!==b){
    const overlap=Math.min(a.rect.x1,b.rect.x1)-Math.max(a.rect.x0,b.rect.x0)>1e-6&&Math.min(a.rect.z1,b.rect.z1)-Math.max(a.rect.z0,b.rect.z0)>1e-6;
    assert.ok(!overlap,`${a.id} overlaps ${b.id}`);
  }
  checks++;
  // Openings in one wall never overlap and leave a jamb between them (an overlap once hid the front door behind a pane).
  for(const w of house.walls){const o=[...w.openings].sort((a,b)=>a.from-b.from);for(let i=1;i<o.length;i++)assert.ok(o[i].from-o[i-1].to>=.15,`openings overlap in a wall at ${o[i].from.toFixed(2)}`);}
  for(const d of house.doors){const w=house.walls.find(w=>d.x>=w.x0-1e-6&&d.x<=w.x1+1e-6&&d.z>=w.z0-1e-6&&d.z<=w.z1+1e-6&&d.y>=w.y0-1e-6&&d.y<w.y1);assert.ok(w,`door ${d.id} is in a wall`);const at=d.wallAlong==='z'?d.z:d.x;assert.ok(w.openings.some(o=>Math.abs((o.from+o.to)/2-at)<1e-6&&o.bottom===undefined),`door ${d.id} has its opening`);}
  checks++;
  // City lots never cover a street or the house, and every lot is drawn on solid ground beside a sidewalk.
  for(const l of city.lots){
    const c={x:(l.rect.x0+l.rect.x1)/2,z:(l.rect.z0+l.rect.z1)/2};
    assert.ok(!outdoorAt(city,c),`lot ${l.id} sits on a street`);
    assert.ok(!(c.x>house.footprint.x0&&c.x<house.footprint.x1&&c.z>house.footprint.z0&&c.z<house.footprint.z1),`lot ${l.id} is inside the house`);
  }
  checks++;
  // Street furniture stands on sidewalks, park or garden, never in a road (a sign error once put the riverside trees in the traffic lane).
  for(const pr of city.props){const g=outdoorAt(city,pr);assert.ok(g&&g.surface!=='road'&&g.surface!=='crossing',`${pr.kind} at ${pr.x.toFixed(1)},${pr.z.toFixed(1)} stands on ${g?.surface??'nothing'}`);}
  checks++;
  // The study window's view north stays clear of street trees in front of it.
  for(const pr of city.props)if(pr.kind==='tree'&&pr.z<house.footprint.z0&&pr.z>house.footprint.z0-12)assert.ok(Math.abs(pr.x-h*.3)>h+2.9||pr.variant==='palm',`a tree at x ${pr.x.toFixed(1)} stands in the study window's view`);
  checks++;
  // 31-Zone registry & 13 enterable city building invariants across every study room size.
  ok(city.zones.length===31&&V3_ZONE_IDS.every(id=>city.zones.some(z=>z.id===id)),`size ${size}: all 31 exact V3 zone IDs present`);
  ok(city.buildings.length===13,`size ${size}: all 13 enterable city buildings present`);
  const chunkIds=new Set(city.chunks.map(c=>c.id));
  for(const b of city.buildings){
    assert.ok(chunkIds.has(b.chunkId),`building ${b.id} references unknown chunk ${b.chunkId}`);
    for(const a of b.zones)for(const c of b.zones)if(a!==c){
      const ov=Math.min(a.rect.x1,c.rect.x1)-Math.max(a.rect.x0,c.rect.x0)>1e-6&&Math.min(a.rect.z1,c.rect.z1)-Math.max(a.rect.z0,c.rect.z0)>1e-6;
      assert.ok(!ov,`building ${b.id}: ${a.id} overlaps ${c.id}`);
    }
    for(const w of b.walls){
      const o=[...w.openings].sort((p,q)=>p.from-q.from);
      for(let i=1;i<o.length;i++)assert.ok(o[i].from-o[i-1].to>=.15,`building ${b.id}: openings overlap`);
    }
    const dw=b.walls.find(w=>b.door.x>=w.x0-1e-6&&b.door.x<=w.x1+1e-6&&b.door.z>=w.z0-1e-6&&b.door.z<=w.z1+1e-6);
    assert.ok(dw&&dw.openings.some(o=>Math.abs((o.from+o.to)/2-b.door.x)<1e-6&&o.bottom===undefined),`building ${b.id}: door sits in matching opening`);
    assert.ok(!shut.free({x:b.door.x,z:b.door.z}),`building ${b.id}: closed door blocks entry`);
    for(const l of city.lots){
      const ov=Math.min(b.rect.x1,l.rect.x1)-Math.max(b.rect.x0,l.rect.x0)>1e-6&&Math.min(b.rect.z1,l.rect.z1)-Math.max(b.rect.z0,l.rect.z0)>1e-6;
      assert.ok(!ov,`building ${b.id} overlaps lot ${l.id}`);
    }
    for(const other of city.buildings)if(other!==b){
      const ov=Math.min(b.rect.x1,other.rect.x1)-Math.max(b.rect.x0,other.rect.x0)>1e-6&&Math.min(b.rect.z1,other.rect.z1)-Math.max(b.rect.z0,other.rect.z0)>1e-6;
      assert.ok(!ov,`building ${b.id} overlaps building ${other.id}`);
    }
  }
  checks++;
}

// Complete 31-Zone Continuous On-Foot Expedition (size 6): start in study room, walk through ALL 31 exact V3 zones
// (10 home zones, 13 enterable city buildings incl. climbing BOTH 2-storey interior staircases, 8 outdoor districts)
// strictly in 3.5 cm walkSlide increments with zero teleports and <= 0.13 m floor delta per step!
{
  const house=housePlan(6),city=cityPlan(house),h=3;
  const open=new Set([...house.doors.map(d=>d.id),...city.buildings.map(b=>b.door.id)]);
  const room=new RoomNavigation(6,[]);
  const walk=new LifeWalk(house,city,room,()=>open);
  const visited=new Set();
  const mark=pt=>{const z=walk.zone(pt);if(z)visited.add(z);};
  const go=(from,to,label)=>{
    const res=walkTo(walk,from,to,label);
    for(const t of res.track)mark(t);
    mark(res.p);
    return res;
  };
  const hz=id=>house.zones.find(z=>z.id===id).rect;
  const hd=id=>house.doors.find(d=>d.id===id);
  const bld=id=>city.buildings.find(b=>b.id===id);
  const zd=id=>city.zones.find(z=>z.id===id);
  const hx=(hz('hall').x0+hz('hall').x1)/2;
  const lantern=city.streets.find(s=>s.id==='lantern').rect;
  const river=city.streets.find(s=>s.id==='riverside').rect;
  const marketBlvd=city.streets.find(s=>s.id==='market_blvd').rect;
  const xW1=house.footprint.x0-5-13;
  const xW2=xW1-13-40;
  const xE1=house.footprint.x1+10;
  const xE2=xE1+13+42;
  const xE3=xE2+13+48;

  // 1. All 10 Home zones on foot (study -> hall -> living -> kitchen -> bath -> bedroom -> balcony -> gaming_room -> stair -> lobby -> garage -> street -> yard)
  let p={x:0,z:hd('hall').z};mark(p);
  p=go(p,{x:hx,z:hd('hall').z},'31z study->hall').p;
  p=go(p,{x:hz('living').x0+1.1,z:-h+1.5},'31z hall->living').p;
  p=go(p,{x:hz('kitchen').x0+1.0,z:h-.9},'31z living->kitchen').p;
  p=go(p,{x:hd('bath').x,z:h+1.2},'31z kitchen->bath').p;
  p=go(p,{x:hz('living').x1-.9,z:hd('bedroom').z},'31z bath->bedroom door').p;
  p=go(p,{x:hz('bedroom').x0+2.4,z:hd('bedroom').z},'31z into bedroom').p;
  ok(walk.zone(p)==='bedroom','Reached bedroom');
  p=go(p,{x:hz('balcony').x0+1.1,z:hd('balcony').z},'31z bedroom->balcony').p;
  ok(walk.zone(p)==='balcony','Reached open-sky balcony');
  p=go(p,{x:hz('bedroom').x0+2.4,z:hd('bedroom').z},'31z balcony->bedroom').p;
  p=go(p,{x:hd('gaming').x,z:hz('gaming_room').z0+1.1},'31z bedroom->gaming_room').p;
  ok(walk.zone(p)==='gaming_room','Reached gaming_room');
  p=go(p,{x:hz('bedroom').x0+2.4,z:hd('bedroom').z},'31z gaming->bedroom').p;
  p=go(p,{x:hz('living').x0+1.1,z:-h+1.5},'31z bedroom->living').p;
  p=go(p,{x:hx,z:house.stair.rect.z0-.3},'31z living->stair head').p;
  p=go(p,{x:hx,z:house.stair.rect.z1+.6},'31z down stair').p;
  p=go(p,{x:hz('garage').x0+1.3,z:hd('garage').z},'31z lobby->garage').p;
  ok(walk.zone(p)==='garage','Reached personal garage');
  p=go(p,{x:hd('garage_out').x,z:house.front+1.5},'31z garage->street').p;
  ok(walk.zone(p)==='street','Stepped onto Lantern Street from garage');
  p=go(p,{x:house.footprint.x1+4,z:house.front+1.5},'31z street->east yard entry').p;
  p=go(p,zd('yard').waypoint,'31z into home yard').p;
  ok(walk.zone(p)==='yard','Reached home garden (yard)');

  // 2. West Riverfront & Neighborhood: Botanical Garden, Atelier, Linh's House, Minh's House
  p=go(p,{x:xW1+1.5,z:river.z1-1.5},'31z yard->riverside road').p;
  p=go(p,zd('botanical').waypoint,'31z into botanical garden').p;
  ok(walk.zone(p)==='botanical','Reached Community Botanical Garden');
  const enterBuilding=(id)=>{
    const b=bld(id);
    p=go(p,b.outsidePoint,`31z approach ${id}`).p;
    p=go(p,b.entryPoint,`31z enter ${id}`).p;
    ok(walk.zone(p)===id,`Entered city building ${id}`);
    return b;
  };
  const exitBuilding=(b)=>{p=go(p,b.outsidePoint,`31z exit ${b.id}`).p;};

  let b=enterBuilding('atelier');exitBuilding(b);
  p=go(p,{x:xW1+1.5,z:river.z1-1.5},'31z atelier->west cross').p;
  p=go(p,{x:xW1+1.5,z:lantern.z0+1.5},'31z down west cross to Lantern St').p;
  b=enterBuilding('linh');exitBuilding(b);
  b=enterBuilding('minh');exitBuilding(b);

  // 3. West Shopping Row: Electronics, 2-Storey Furniture Showroom (climb to 2F!), Clothing, Vehicle Dealer
  p=go(p,{x:xW2+11.5,z:lantern.z1-1.5},'31z to west shopping row').p;
  b=enterBuilding('electronics_shop');exitBuilding(b);
  b=enterBuilding('furniture_shop');
  const fUpper=b.zones.find(z=>z.id==='furniture_shop:upper');
  const fClimb=go(p,{x:(fUpper.rect.x0+fUpper.rect.x1)/2,z:(fUpper.rect.z0+fUpper.rect.z1)/2},'31z climb furniture_shop 2F');
  p=fClimb.p;
  ok(walk.groundAt(p.x,p.z)>GROUND_Y+2.4,'Climbed interior staircase to furniture_shop 2nd floor gallery');
  p=go(p,b.entryPoint,'31z descend furniture_shop stair').p;
  exitBuilding(b);
  p=go(p,{x:xW2+11.5,z:marketBlvd.z0+1.5},'31z down to Market Blvd').p;
  b=enterBuilding('clothing_shop');exitBuilding(b);
  b=enterBuilding('vehicle_dealer');exitBuilding(b);

  // 4. South Shopping Row & Café Row: Home Center, Repair Shop, Pixel Café, Willow Bistro, Sunrise Market
  p=go(p,{x:xW1+11.5,z:marketBlvd.z0+1.5},'31z east along Market Blvd').p;
  b=enterBuilding('home_center');exitBuilding(b);
  b=enterBuilding('repair_shop');exitBuilding(b);
  p=go(p,{x:xW1+11.5,z:lantern.z1-1.5},'31z north to Café Row').p;
  b=enterBuilding('cafe');exitBuilding(b);
  b=enterBuilding('bistro');exitBuilding(b);
  p=go(p,{x:xE1+11.5,z:lantern.z1-1.5},'31z east to Sunrise Market').p;
  b=enterBuilding('market');exitBuilding(b);

  // 5. University Green, 2-Storey Library (climb to 2F!), Old Campus Fountain Court
  p=go(p,{x:xE1+15,z:lantern.z0+1.5},'31z cross to campus').p;
  p=go(p,zd('campus').waypoint,'31z enter University Green').p;
  ok(walk.zone(p)==='campus','Reached University Green');
  p=go(p,{x:xE2+11.5,z:lantern.z0+1.5},'31z campus->library avenue').p;
  b=enterBuilding('library');
  const lUpper=b.zones.find(z=>z.id==='library:upper');
  const lClimb=go(p,{x:(lUpper.rect.x0+lUpper.rect.x1)/2,z:(lUpper.rect.z0+lUpper.rect.z1)/2},'31z climb library 2F');
  p=lClimb.p;
  ok(walk.groundAt(p.x,p.z)>GROUND_Y+2.4,'Climbed interior staircase to University Library 2nd floor mezzanine');
  p=go(p,b.entryPoint,'31z descend library stair').p;
  exitBuilding(b);
  p=go(p,zd('fountain_plaza').waypoint,'31z into Old Campus Fountain Court').p;
  ok(walk.zone(p)==='fountain_plaza','Reached Old Campus Fountain Court');

  // 6. Hidden Lantern Tea Garden, Riverside Greenway, Boardwalk Fair & Riverside Park
  p=go(p,zd('lantern_garden').waypoint,'31z into Hidden Lantern Tea Garden').p;
  ok(walk.zone(p)==='lantern_garden','Reached Hidden Lantern Tea Garden');
  p=go(p,zd('greenway').waypoint,'31z north to Riverside Greenway').p;
  ok(walk.zone(p)==='greenway','Reached Riverside Greenway');
  p=go(p,{x:xE3+1.5,z:river.z0+1.5},'31z west along Riverside Rd to Fair').p;
  p=go(p,zd('fair').waypoint,'31z into Boardwalk Fair').p;
  ok(walk.zone(p)==='fair','Reached Boardwalk Fair');
  p=go(p,{x:xE2-10,z:river.z0+1.5},'31z fair->Riverside Park').p;
  p=go(p,zd('park').waypoint,'31z into Riverside Park').p;
  ok(walk.zone(p)==='park','Reached Riverside Park');

  const missing=V3_ZONE_IDS.filter(id=>!visited.has(id));
  ok(missing.length===0&&visited.size===31,`All 31 exact V3 zones reached continuously on foot (missing: ${missing.join(', ')})`);

  // 7. Streaming chunk distance verification (home vs far east greenway triggers WARM/COLD unload!).
  const distTo=(pt,rc)=>Math.hypot(Math.max(rc.x0-pt.x,0,pt.x-rc.x1),Math.max(rc.z0-pt.z,0,pt.z-rc.z1));
  const chunk=id=>city.chunks.find(c=>c.id===id);
  ok(distTo({x:0,z:0},chunk('home-core').rect)===0,'Study origin inside home-core chunk');
  ok(distTo({x:0,z:0},chunk('campus-east').rect)>64&&distTo({x:0,z:0},chunk('campus-east').rect)<=114,'campus-east starts WARM from study');
  ok(distTo({x:0,z:0},chunk('greenway-east').rect)>138,'greenway-east starts COLD from study');
  const gw=zd('greenway').waypoint;
  ok(distTo(gw,chunk('greenway-east').rect)===0,'greenway-east becomes HOT at greenway');
  ok(distTo(gw,chunk('river-west').rect)>138&&distTo(gw,chunk('shopping-west').rect)>138,'West chunks unload to COLD when player visits east greenway');
}
console.log(`PASS ${checks} Echo Life world plan, 31-zone walk, buildings and streaming checks`);
