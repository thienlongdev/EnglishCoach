// Echo Life Phase 3 + 4 — the living world and its game, checked without a browser.
// The residents' navigation graph over the real 31-zone world, the 22 residents walking their V3 schedules (never faster than
// a walk, never off the floor, through doors they open), the hotspots that place V3's props in real rooms, the ambient crowd
// lanes, and V3's whole game run through the host adapter: every main mission to each of the three endings, the 14 side
// arcs, the 32 activities, the 10-step tutorial, and a save round trip through V3's own validator.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),babel=require('next/dist/compiled/babel/bundle.js');
const src=fileURLToPath(new URL('../src/',import.meta.url)),cache=new Map();
function resolve(from,n){const p=n.startsWith('@/')?n.slice(2):path.posix.normalize(path.posix.dirname(from)+'/'+n);return p;}
function load(rel){
  if(rel.endsWith('.mjs') || rel.endsWith('.json'))return require(path.join(src,rel));
  if(cache.has(rel))return cache.get(rel);const m={exports:{}};cache.set(rel,m.exports);
  const code=babel.core().transformSync(fs.readFileSync(path.join(src,rel),'utf8'),{filename:rel,babelrc:false,configFile:false,presets:[babel.presetTypescript()],plugins:[babel.pluginTransformModulesCommonjs()]}).code;
  new Function('module','exports','require',code)(m,m.exports,n=>{const r=resolve(rel,n);return load(/\.(mjs|json)$/.test(r)?r:r+'.ts');});return m.exports;
}
const {housePlan}=load('lib/echo-life/plan.ts');
const {cityPlan}=load('lib/echo-life/city.ts');
const {V3_ZONE_IDS}=load('lib/echo-life/zones.ts');
const {LifeNav}=load('lib/echo-life/game/nav.ts');
const {EchoLifeGame}=load('lib/echo-life/game/session.ts');
const V3=load('lib/echo-life/v3/game-core/index.mjs');
let checks=0;const ok=(c,m)=>{assert.ok(c,m);checks++;};

if (process.argv.includes('--sealed-saves')) {
  const {verifySealedSaves}=await import('../../docs/echo-life/final/verify-sealed-saves.mjs');
  if (!process.env.ECHO_LIFE_SEALED_SIMULATORS) throw Error('Set ECHO_LIFE_SEALED_SIMULATORS to the original simulator library directory.');
  const house=housePlan(6), city=cityPlan(house);
  const doorPort={door:()=>({passable:true,isOpen:true,prepare(){},setOpen(){}})};
  const restored=await verifySealedSaves(process.env.ECHO_LIFE_SEALED_SIMULATORS,
    (owner,doc)=>new EchoLifeGame(house,city,owner,doorPort,doc));
  console.log(restored+' sealed-save cases passed');
  process.exit(0);
}

// ── 1. Navigation: every zone reachable from the hall on proven floor, at four room sizes ──────────────────
for(const size of [4,6,7.5,9]){
  const house=housePlan(size),city=cityPlan(house),nav=new LifeNav(house,city);
  const from=city.zones.find(z=>z.id==='hall').waypoint;
  for(const z of city.zones){
    if(z.id==='study'||z.id==='hall')continue;
    // A waypoint a sofa happens to stand on is not a place to stand: the zone's first free spot (as residents use).
    const goal=nav.spots(z.id,1)[0];
    ok(goal,`size ${size}: ${z.id} has a free spot`);
    const r=nav.route(from,goal);
    ok(r,`size ${size}: a resident can walk from the hall to ${z.id}`);
    // Every 3.5 cm of the route is floor a body may stand on (every door open), and floors change only by stair or curb.
    let prev=from,prevY=nav.walk.groundAt(from.x,from.z);
    for(const p of r.points){
      const n=Math.ceil(Math.hypot(p.x-prev.x,p.z-prev.z)/.035);
      for(let i=1;i<=n;i++){
        const q={x:prev.x+(p.x-prev.x)*i/n,z:prev.z+(p.z-prev.z)*i/n};
        assert.ok(nav.walk.free(q),`size ${size} ${z.id}: route step off the floor at ${q.x.toFixed(2)},${q.z.toFixed(2)}`);
        const y=nav.walk.groundAt(q.x,q.z);assert.ok(Math.abs(y-prevY)<=.31,`size ${size} ${z.id}: a jump of ${(y-prevY).toFixed(2)} m`);prevY=y;
      }
      prev=p;
    }
    checks++;
    // Doors on the route are named so the walker opens them.
    const via=new Set(r.doors.map(d=>d.door));
    if(z.doorId)ok(via.has(z.doorId),`size ${size}: the route into ${z.id} names its door ${z.doorId}`);
  }
}

// ── 2. The game in a 6 m-room world ───────────────────────────────────────────────────────────────────────
const house=housePlan(6),city=cityPlan(house);
const opened=[];
const doorPort={door:id=>({passable:true,isOpen:true,prepare(){},setOpen(o){opened.push([id,o]);}})};
const {RoomNavigation}=load('lib/study-space/navigation.ts');
const {LifeWalk}=load('lib/echo-life/walk.ts');
const {allDoors}=load('lib/echo-life/game/nav.ts');
const openDoors = new Set(allDoors(house,city).map(d=>d.id));
const playerWalk = new LifeWalk(house, city, new RoomNavigation(6,[]), () => openDoors);
const g=new EchoLifeGame(house,city,'u7',doorPort,null,playerWalk);
assert.throws(()=>new EchoLifeGame(house,city,'u7',doorPort,{v:1,save:'',places:{}}),/saved Echo Life story/);
for (const version of [1,2,3]) {
  const old=JSON.parse(g.serialize().save);
  old.version=version;
  old.cash=179;old.done=['tidy'];
  const migrated=new EchoLifeGame(house,city,'u7',doorPort,{v:1,save:JSON.stringify(old),places:{}},playerWalk);
  const restored=JSON.parse(migrated.serialize().save);
  assert.equal(restored.version,4);
  assert.equal(restored.owner,'u7');
  assert.ok(restored.done.includes('tidy'));
}
const s=g.s;
if (process.argv.includes('--export-release-catalogs')) {
  const {writeWorldCatalogs} = await import('../../docs/echo-life/final/export-world.mjs');
  writeWorldCatalogs(house, city, g, V3, playerWalk);
}
ok(Object.keys(s.npcs).length===22&&g.people.walkers.size===22,'22 named residents are in the world, each once');
ok(new Set([...g.people.walkers.values()].map(w=>w.id)).size===22,'no resident is duplicated');
for(const w of g.people.walkers.values())ok(g.nav.walk.free(w),`${w.id} starts on walkable floor`);

// Hotspots: every interactive V3 prop of the 30 public zones has a real place and a stand spot inside its zone.
const v3Props=Object.entries(V3.zones).filter(([z])=>z!=='study').flatMap(([z,zone])=>zone.props.filter(p=>p.action&&p.action!=='ride').map(p=>z+'/'+p.id));
const keys=new Set(g.hotspots.map(h=>h.key));
for(const k of v3Props)ok(keys.has(k),`hotspot for ${k}`);
for(const h of g.hotspots){ok(playerWalk.free(h.stand)&&playerWalk.zone(h.stand)===h.zone,`${h.key} stand spot is free floor in ${h.zone}`);}
const anchored=g.hotspots.filter(h=>h.anchored).length;
ok(anchored>=60,`most props sit on their real Phase 2 furnishing (${anchored})`);
ok(g.hotspots.filter(h=>h.kind==='relic').length===16,'all 16 original keepsakes have physical interaction points');
{
  const visit = new EchoLifeGame(house,city,'u7',doorPort,null,playerWalk);
  const bookmark = visit.hotspots.find(h=>h.id==='col_study_bookmark');
  assert.equal(bookmark.zone,'study');
  visit.focus(bookmark.stand,0);
  const target = visit.nearbyTargets.find(t=>t.kind==='spot' && t.hotspot.id===bookmark.id);
  ok(target && visit.act(target,'collect_relic').ok,'the learner can collect the Gingko Bookmark in the original study');
  const loaded = new EchoLifeGame(house,city,'u7',doorPort,visit.serialize());
  ok(loaded.s.worldV3.exploration.collectibles.includes(bookmark.id) && !loaded.entityFor(bookmark),
    'the collected bookmark stays in the journal and cannot be collected again after reload');
}
ok(g.lanes.length>=20,`ambient crowd lanes on proven pavement (${g.lanes.length})`);
const passers=g.crowd(null);ok(passers.length===80,'80 ambient residents in the day');
for(const p of passers)ok(g.nav.walk.free(p),`ambient person ${p.id} on floor`);

// Residents live their schedules: two game days, never faster than a run, never off the floor.
const pos=new Map([...g.people.walkers.values()].map(w=>[w.id,{x:w.x,z:w.z}]));
const visited=new Map([...g.people.walkers.values()].map(w=>[w.id,new Set([w.zone])]));
let maxStep=0;const dt=.1;
s.clock=6*60;
for(let i=0;i<20000;i++){
  g.tick(dt,{x:4.1,z:1.2},{routeBudget:3});
  if(i%5===0)for(const w of g.people.walkers.values()){
    const p=pos.get(w.id),d=Math.hypot(w.x-p.x,w.z-p.z);
    maxStep=Math.max(maxStep,d/(dt*5));
    assert.ok(g.nav.walk.free(w),`${w.id} off the floor at ${w.x.toFixed(2)},${w.z.toFixed(2)} (${w.zone})`);
    pos.set(w.id,{x:w.x,z:w.z});visited.get(w.id).add(w.zone);
  }
}
checks++;
ok(maxStep<=2.4*8+1e-6,`no resident ever moves faster than a far-tier run step (${maxStep.toFixed(2)} m/s average over a step)`);
const moved=[...visited.values()].filter(v=>v.size>=2).length;
ok(moved>=18,`residents travel between zones over the day (${moved}/22 visited 2+ zones)`);
ok(g.people.stats.routes>=22,'routes were searched for the residents');
console.log('people', JSON.stringify({routes:g.people.stats.routes,doors:g.people.stats.doorsOpened,nav:g.nav.stats,scenes:g.people.stats.scenes}));

// ── 3. The whole story through the adapter (V3's own actions at real hotspots and residents) ─────────────
function story(owner,picks){
  const g=new EchoLifeGame(house,city,owner,doorPort,null),s=g.s;
  const spot=(zone,id)=>{const h=g.hotspots.find(h=>h.zone===zone&&(h.id===id||(id==='rack'&&h.id==='broom')));assert.ok(h,`hotspot ${zone}/${id}`);const e=g.entityFor(h);assert.ok(e,`entity ${zone}/${id} available`);return {kind:'spot',hotspot:h,entity:e,label:'',at:h.at,dist:0};};
  const pass=sec=>{for(let i=0;i<Math.ceil(sec*20);i++)g.tick(.05,{x:4.1,z:1.2},{routeBudget:0});};
  const act=(zone,id,choice)=>{const t=spot(zone,id);const key=choice??g.options(t)[0].key;const r=g.act(t,key);assert.equal(r.ok,true,`${zone}/${id} ${key}: ${r.msg}`);pass(1.3);return r;};
  const npc=id=>({kind:'npc',id,name:id,at:{x:0,z:0},dist:0});
  const talk=(who,key='say0')=>{const opts=g.options(npc(who));const k=opts.find(o=>o.key===key)?key:opts[0].key;const r=g.act(npc(who),k);assert.equal(r.ok,true,`talk ${who} ${k}: ${r.msg}`);pass(.3);return r;};
  const choose=(who,choiceId)=>{const opt=g.options(npc(who)).find(o=>o.key.startsWith(`choice:${choiceId}:`)&&(!picks[choiceId]||o.key.endsWith(':'+picks[choiceId])));if(!opt)return;const r=g.act(npc(who),opt.key);assert.equal(r.ok,true,`choice ${choiceId}: ${r.msg}`);};
  const cook=meal=>{act('kitchen','board',meal);act('kitchen','stove');pass(3.3);act('kitchen','stove');act('kitchen','table');act('kitchen','sink');};
  act('living','broom');act('living','dust');act('living','rack');cook('eggs');talk('linh');
  function checkout(item) {
    act('market','shelf',item);
    const target=spot('market','till');
    const purchase=g.marketCheckout(target,g.options(target)[0].key);
    assert.ok(purchase.result.ok,purchase.result.msg);
    assert.deepEqual(purchase.batch.spent[0].items,[item]);
    assert.deepEqual(s.basket,[item],'preparing a receipt preserves the unpaid basket');
    Object.assign(s,purchase.draft);
    g.claims.push(purchase.batch);
  }
  checkout('noodles');cook('noodles');talk('huy');choose('huy','ch2_huy_pact');
  act('cafe','console');for(const i of [...s.challenge.sequence])g.challenge(i);
  const theme=g.options(spot('campus','notice')).find(o=>o.key.startsWith('theme:')&&(!picks.ch3_theme||o.key.endsWith(picks.ch3_theme)));
  act('campus','notice',theme?.key);act('campus','books','correct');choose('hoangphuc','ch3_budget');talk('lan');
  choose('thaovy','ch4_thaovy');
  g.studied(true);act('bedroom','bed');talk('minh');act('park','hoop');s.elapsed=s.challenge.start+.7;g.challenge(0);
  act('linh','letters');choose('linh','ch4_linh_support');talk('linh');
  checkout('kit');act('campus','notice');act('campus','booth');act('campus','booth');
  const fin=g.options(spot('campus','stage')).find(o=>o.key.startsWith('finale:')&&(!picks.ch5_finale_tone||o.key.endsWith(picks.ch5_finale_tone)));
  act('campus','stage',fin?.key);
  return g;
}
const opts=id=>V3.STORY_CHOICES[id].options.map(o=>o.key);
const endings=new Set();
const runs=[0,1,2].map(k=>Object.fromEntries(Object.keys(V3.STORY_CHOICES).map(c=>[c,opts(c)[Math.min(k,opts(c).length-1)]])));
for(const [i,picks] of runs.entries()){
  const done=story('u'+(100+i),picks);
  ok(done.s.done.length===15,`run ${i}: all 15 missions complete through real hotspots and residents`);
  ok(done.s.sandbox,'the semester ends in free play');
  ok(Object.keys(done.s.worldV3.storyChoices).length===6,`run ${i}: the six branching choices were made in play`);
  endings.add(done.s.worldV3.endingId);
  const uniq=done.claims.flatMap(c=>c.uniques);
  ok(V3.quests.every(q=>uniq.includes('mission:'+q.id)),`run ${i}: every mission completion was reported to the server`);
  // The save goes through V3's own validator and comes back the same story.
  const doc=done.serialize();const again=new EchoLifeGame(house,city,'u'+(100+i),doorPort,doc);
  ok(again.s.done.length===15&&again.s.worldV3.endingId===done.s.worldV3.endingId,`run ${i}: the story survives a save round trip`);
  assert.throws(()=>V3.decode(doc.save,'someone-else'));checks++;
}
ok(endings.size===3,`all three endings are reached through play (${[...endings].join(', ')})`);

// ── 4. Side arcs, activities, tutorial ───────────────────────────────────────────────────────────────────
ok(V3.SIDE_QUESTS.length===14,'14 side arcs');
for(const q of V3.SIDE_QUESTS){
  const lead=q.stages.find(st=>st.event.startsWith('sq:'));
  ok(lead,`${q.id} starts with a resident (${q.leadNpc})`);
  ok(V3.CHARACTERS[q.leadNpc],`${q.id} lead ${q.leadNpc} is one of the 22`);
}
const g2=new EchoLifeGame(house,city,'u9',doorPort,null);
const optKeys=g2.options({kind:'npc',id:'anchi',name:'An Chi',at:{x:0,z:0},dist:0}).map(o=>o.key);
ok(optKeys.some(k=>k.startsWith('sq:sq_missing_folio')),'An Chi offers the folio arc in conversation');
ok(V3.FREE_ROAM_ACTIVITY_CATALOG.length===32,'32 free-roam activities');
const actions=new Set(g2.hotspots.map(h=>h.action));
for(const a of ['work_bistro','bistro_order','tea_ceremony','library_study','archive_research','atelier_paint','garden_tend','garden_harvest','photo_snap','photo_album','delivery_start','delivery_drop','fair_spin','market_artisan','campus_seminar','music_jam','arcade','sport','badminton','rings','exercise','cook','work_cafe','work_market','work_repair','learn','plan'])
  ok(actions.has(a),`activity action ${a} has a place in the world`);
ok(g2.tutorialStep?.id==='tut_movement','a new player starts the 10-step tutorial');
g2.tick(.1,{x:4.1,z:1.2});g2.tick(.1,{x:5.6,z:1.2});g2.signal('jumped');
ok(g2.tutorialStep?.id==='tut_interaction','walking and jumping complete step 1');
for(const sig of ['interactedObject','talkedNpc','openedMap','changedZone','openedBag','purchasedItem','usedBuildMode','openedJournal','rodeVehicle','exploredFree'])g2.signal(sig);
ok(g2.s.worldV3.tutorial.completed,'all ten tutorial steps complete from real signals');

// ── 5. Residents open a closed door with its own swing, pass only once it is passable, and close it behind them ──
{
  const state=new Map();
  const port={door:id=>{let st=state.get(id);if(!st){st={open:false,angle:0,t:0};state.set(id,st);}return{get passable(){return st.angle>.95;},get isOpen(){return st.open;},prepare(){},setOpen(o){st.open=o;}};}};
  const g3=new EchoLifeGame(house,city,'u11',port,null);
  g3.s.clock=7*60+50;
  let passedClosed=0;
  for(let i=0;i<9000;i++){
    for(const st of state.values())st.angle=Math.max(0,Math.min(1.4,st.angle+(st.open?.1:-.1)*1.5)); // the leaf swings over a few frames
    g3.tick(.1,{x:4.1,z:1.2},{routeBudget:3});
    for(const w of g3.people.walkers.values()){
      for(const d of g3.nav.doors){
        const st=state.get(d.id);
        if(st&&st.angle<=.95&&w.x>=d.corridor.x0&&w.x<=d.corridor.x1&&w.z>=d.corridor.z0&&w.z<=d.corridor.z1)passedClosed++;
      }
    }
  }
  ok(g3.people.stats.doorsOpened>0,`residents opened doors themselves (${g3.people.stats.doorsOpened})`);
  ok(passedClosed===0,'no resident ever stood in a doorway whose leaf was not open enough to pass');
  const leftOpen=[...state.entries()].filter(([,st])=>st.open).map(([id])=>id);
  const walkingThrough=[...g3.people.walkers.values()].filter(w=>w.closeBehind).length;
  ok(leftOpen.length<=walkingThrough+2,`residents close the doors they opened (${leftOpen.length} still open, ${walkingThrough} on their way through)`);
}

// ── 6. The bicycle (V3 rules): free hands, within reach, no riding indoors, saved where it was left ────────────
{
  const g4=new EchoLifeGame(house,city,'u12',doorPort,null);
  const bk={...g4.bike};
  ok(g4.nav.walk.zone(bk)==='street','the bicycle is parked on the street by the front door');
  ok(!g4.mount({x:bk.x+5,z:bk.z}).ok,'too far from the bicycle: no ride');
  g4.s.held='broom';ok(!g4.mount({x:bk.x+.5,z:bk.z}).ok,'hands full: no ride (V3)');g4.s.held=null;
  ok(g4.mount({x:bk.x+.5,z:bk.z}).ok&&g4.riding,'free hands within reach: riding');
  g4.tick(.1,{x:bk.x+.5,z:bk.z});g4.tick(.1,{x:bk.x+.8,z:bk.z});
  const ent=house.doors.find(d=>d.id==='entrance');
  const inside=[{x:ent.corridor.x0-.6,z:ent.z},{x:ent.corridor.x1+.6,z:ent.z},{x:ent.x,z:ent.corridor.z0-.6},{x:ent.x,z:ent.corridor.z1+.6}].find(p=>g4.nav.walk.zone(p)==='hall');
  g4.tick(.1,inside);
  ok(!g4.riding,'riding into the house parks the bicycle (V3: park outside first)');
  const doc=g4.serialize();
  ok(doc.places.bike&&Math.hypot(doc.places.bike.x-inside.x,doc.places.bike.z-inside.z)<.05,'the bicycle stays where it was left and is saved there');
  const again=new EchoLifeGame(house,city,'u12',doorPort,doc);
  ok(Math.hypot(again.bike.x-doc.places.bike.x,again.bike.z-doc.places.bike.z)<.05||!again.nav.walk.free(doc.places.bike),'a reload finds the bicycle where it was left');
  ok(new TextEncoder().encode(JSON.stringify(doc)).length<480*1024,`the save is within the server bound (${(JSON.stringify(doc).length/1024).toFixed(0)} KB)`);
}

// ── 7. A server-accepted purchase goes through V3's own buyShopItem and takes the server's id ─────────────
{
  const g5=new EchoLifeGame(house,city,'u13',doorPort,null);
  const before=g5.s.progression.ownedObjects.length;
  const r=g5.applyPurchase('home_center','sku_rice_cooker_smart','ec_0123456789abcdef0123',{credits:5,skills:{},claimed:[],owned:[],dailyEarned:0});
  ok(r.ok,`V3 applied the purchase (${r.msg})`);
  ok(g5.s.progression.ownedObjects.length===before+1&&g5.s.progression.ownedObjects.some(o=>o.instanceId==='ec_0123456789abcdef0123'),'the new owned object carries the server id');
  ok(g5.s.progression.economy.credits===5,'credits are the server wallet after the purchase');
  ok(g5.s.worldV3.tutorial.flags.purchasedItem===true,'a purchase is the tutorial shop signal');
}

// ── 8. Server wallet is authoritative ────────────────────────────────────────────────────────────────────
{
  const original=V3.createGame('returning-learner');
  original.version=3;
  original.progression.materials.fabric=7;
  original.progression.skills.business.xp=150;
  original.done=['tidy'];
  delete original.worldV3;
  const decoded=V3.decode(JSON.stringify(original),'returning-learner');
  ok(decoded.version===4 && decoded.progression.materials.fabric===7 &&
    decoded.progression.skills.business.xp===150 && decoded.done.includes('tidy') &&
    decoded.progression.ownedObjects.every(o=>o.ownerAccountId==='returning-learner'),
    'a V2 progression save keeps its property, materials, skills and completed mission on upgrade');
}
g2.applyWallet({credits:333,skills:{social:150,technology:0},claimed:[],owned:[],dailyEarned:0});
ok(g2.s.progression.economy.credits===333&&g2.s.progression.skills.social.level===3,'the server wallet overwrites credits and skill XP');

// A same-minute checkout in another tab must survive both stale snapshots already queued here.
cache.set('services/api-client.ts',{exports:{}});
const {GameSaver}=load('lib/echo-life/game/saver.ts');
{
  const own=g2.serialize(), peer=structuredClone(own);
  const narrative=JSON.parse(peer.save); narrative.bag.rice=2; peer.save=JSON.stringify(narrative);
  const wallet={credits:111,skills:{},claimed:[],owned:[],dailyEarned:0};
  const current={doc:peer,revision:2,wallet};
  let puts=0;
  const saver=new GameSaver({
    get:async()=>({doc:own,revision:1,wallet}),
    put:async()=>{puts++;throw {status:409,current};},
  },'9');
  await saver.load();
  let restored; saver.onNewer=doc=>{restored=doc};
  saver.schedule(()=>own);
  await Promise.all([saver.flush(),saver.flush()]);
  ok(puts===1 && restored===peer && saver.revision===2,'same-minute peer checkout supersedes both stale local saves');
  saver.dispose();
}
{
  const requests=[], doc=g2.serialize();
  const wallet={credits:100,skills:{},claimed:[],owned:[],dailyEarned:0};
  const saver=new GameSaver({
    get:async()=>({doc:null,revision:0,wallet}),
    claims:async(batches,snapshot)=>{
      requests.push(JSON.stringify([batches,snapshot]));
      if(requests.length===1)throw {status:0};
      return {wallet,granted:[],refused:{},revision:1};
    },
  },'9');
  await saver.load();
  await saver.checkout(doc,{source:'checkout',uniques:[],credits:0,xp:{},spent:[{kind:'market',items:['rice'],sale:false}]});
  ok(requests.length===2 && requests[0]===requests[1] && saver.revision===1,'lost checkout response retries the identical receipt and snapshot');
  saver.dispose();
}

// An owned motorbike takes its physics and upgrades from the server workshop.
{
  const {TwoWheeler}=load('lib/echo-life/game/twoWheeler.ts');
  const state=V3.createGame('rider');
  state.progression.skills.mobility.level=8;
  state.progression.economy.credits=10000;
  const motor=V3.buyShopItem(state,'vehicle_dealer','sku_veh_vesper','rider').instance;
  const id='ec_'+'a'.repeat(20);
  motor.instanceId=id;
  state.progression.activeVehicleId=id;
  const receipt={instanceId:id,storeId:'vehicle_dealer',sku:'sku_veh_vesper'};
  const wallet={workshop:state.progression,owned:[receipt]};
  const ride=new TwoWheeler(g2.nav.walk);
  ride.authorize({...wallet,owned:[]});
  ok(!ride.spec,'a ride needs a current server purchase');
  ride.authorize(wallet);
  ok(ride.spec?.maxSpeed===13.4 && ride.powered,'Vesper uses its catalogue speed and powered riding pose');
  motor.installedComponents.performance='vcomp_moto_exhaust';
  ride.authorize(wallet);
  ok(Math.abs(ride.spec.maxSpeed-15.4)<1e-6,'installed exhaust changes the actual drive limit');
  const start={...ride.pose};
  ok(ride.toggle(start,()=>true) && ride.driving,'owned two-wheeler can be mounted at the curb');
  ride.drive(.1,1,0,false,()=>false);
  ok(ride.speed===0 && ride.pose.x===start.x && ride.pose.z===start.z,'blocked vehicle footprint stops before contact');
  for(let i=0;i<10;i++)ride.drive(.05,1,0,false,()=>true);
  ok(ride.speed>.6 && ride.spin>0,'clear approach accelerates and turns the wheels');
  ok(!ride.toggle(ride.pose,()=>true) && ride.driving,'rider must slow before dismounting');
  for(let i=0;i<8;i++)ride.drive(.05,0,0,true,()=>true);
  ok(!ride.toggle(ride.pose,()=>false) && ride.driving,'blocked sidewalk keeps rider on vehicle');
  ok(ride.toggle(ride.pose,()=>true) && !ride.driving,'clear sidewalk permits dismount');
  const spot={...ride.pose}, next=new TwoWheeler(g2.nav.walk,ride.snapshot());
  next.authorize(wallet);
  ok(next.pose.x===spot.x && next.pose.yaw===spot.yaw,'parking restores by server instance');
  next.authorize({...wallet,owned:[]});
  ok(!next.spec && !Object.hasOwn(next.snapshot(),id),'a sold ride releases its parking and controls');
}

{
  const {Automobile}=load('lib/echo-life/game/automobile.ts');
  const mango='ec_'+'b'.repeat(20), lotus='ec_'+'c'.repeat(20);
  const owned=[{instanceId:mango,storeId:'vehicle_dealer',sku:'sku_car_mango'},
    {instanceId:lotus,storeId:'vehicle_dealer',sku:'sku_car_lotus'}];
  const wallet={owned,claimed:[],workshop:{ownedObjects:[],activeCarId:mango}};
  const car=new Automobile(g2.nav.walk);
  car.authorize(wallet);
  const spawn={...car.pose};
  car.pose.x+=1.25;
  const oldMango={...car.pose};
  wallet.workshop.activeCarId=lotus;
  car.authorize(wallet);
  ok(car.spec.instanceId===lotus && car.pose.x===spawn.x,'second owned car has its own parking spot');
  car.pose.x-=1.3;
  const oldLotus={...car.pose};
  const restored=new Automobile(g2.nav.walk, oldLotus, oldLotus.yaw, lotus, car.snapshot());
  wallet.workshop.activeCarId=mango;
  restored.authorize(wallet,lotus);
  ok(restored.pose.x===oldMango.x,'server selection restores the first car after reload');
  wallet.workshop.activeCarId=lotus;
  restored.authorize(wallet,mango);
  ok(restored.pose.x===oldLotus.x,'switching back restores the second car');
  const legacy=new Automobile(g2.nav.walk,oldMango,oldMango.yaw,mango);
  legacy.authorize(wallet,mango);
  ok(legacy.pose.x===spawn.x,'a server selection change does not transfer the previous format car position');
  wallet.workshop.activeCarId=mango;
  legacy.authorize(wallet,mango);
  ok(legacy.pose.x===oldMango.x,'previous format parking is recovered for its original instance');
  ok(legacy.toggle(legacy.pose,()=>true) && legacy.driving,'an owned car accepts its driver');
  for(let i=0;i<22;i++) legacy.drive(1/60,1,.5,false,()=>true);
  const wheelSpin=legacy.wheels.map(w=>w.spin);
  ok(wheelSpin.every(n=>n>0) && Math.max(...wheelSpin)-Math.min(...wheelSpin)>0.001,'turning produces distinct inside and outside wheel travel');
  ok(legacy.chassis.initialized && Math.abs(legacy.chassis.pitch)>0.0001,'acceleration transfers load across the axles');
  for(let i=0;i<180;i++) legacy.drive(1/60,0,0,true,()=>true);
  ok(legacy.speed===0 && legacy.wheels.every(w=>Math.abs(w.velocity)<.002 && Math.abs(w.travel)<.002),'suspension settles on all four contacts after braking');
}
console.log(`echo-life game: ${checks} checks passed`);
