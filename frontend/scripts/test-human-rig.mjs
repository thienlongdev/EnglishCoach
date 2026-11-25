// One human skeleton: the real exported cast, driven by the real rig, measured. Numbers, not a substitute for looking at it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { tsLoader } from './lib/ts-load.mjs';

const load = tsLoader({ three: T });
const { HumanRig } = load('lib/embodiment/human.ts');
const P = load('lib/embodiment/poses.ts');
const { GRIPS, FINGER_NAMES, curlPose } = load('lib/embodiment/fingers.ts');
const { GAIT_SPEED, gaitTimeScale } = load('lib/embodiment/gait.ts');
const { minJerk } = load('lib/embodiment/arms.ts');

const assets = readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts', import.meta.url), 'utf8');
async function loadCast(path) {
  const data = readFileSync(new URL('../public' + path, import.meta.url));
  const length = data.readUInt32LE(12), j = JSON.parse(data.subarray(20, 20 + length));
  const stats = { bytes: data.length, meshes: j.meshes.map(m => m.name), nodes: j.nodes.map(n => n.name), animations: j.animations.map(a => a.name) };
  // Images are irrelevant to the skeleton; omit decoding in this CPU-only test.
  j.materials = j.materials.map(m => ({ name: m.name })); delete j.textures; delete j.images;
  const raw = Buffer.from(JSON.stringify(j)), json = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 32); raw.copy(json);
  const bin = data.subarray(20 + length), header = Buffer.alloc(20); data.copy(header, 0, 0, 12); header.writeUInt32LE(20 + json.length + bin.length, 8); header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const glb = Buffer.concat([header, json, bin]);
  return { gltf: await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), ''), stats };
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

for (const hero of ['LYRA', 'KAI']) {
  const path = assets.match(new RegExp(hero + ": '([^']+)'"))[1];
  const { gltf, stats } = await loadCast(path);
  // Wrist cloth needs local subdivisions to follow the anatomical skin. The
  // measured increase is 2.74% Lyra / 4.08% Kai; retain a bounded, decoder-free GLB.
  assert.ok(stats.bytes < 6_300_000, hero + ' cast stays a reasonable download');
  for (const side of 'LR') {
    for (const f of FINGER_NAMES) for (const j of [1, 2, 3]) assert.ok(stats.nodes.includes(`${f}.${j}.${side}`), `${f}.${j}.${side} is a real joint`);
    assert.ok(stats.nodes.includes(`fore_twist.${side}`), 'the forearm shares the roll');
  }
  assert.ok(gltf.scene.getObjectByProperty('name', 'Runner_Hands')?.isSkinnedMesh, 'hands are skinned to the one skeleton');
  for (const clip of ['Idle', 'Walk', 'Run', 'Speak', 'Listen', 'Ready', 'Defeat']) assert.ok(stats.animations.includes(clip), clip);

  const root = new T.Group(), model = clone(gltf.scene);
  model.scale.setScalar(1.04); root.add(model);
  const rig = new HumanRig(model, root);
  assert.equal(rig.ready, true);
  const mixer = new T.AnimationMixer(model), clips = new Map(gltf.animations.map(c => [c.name, c]));
  const idle = mixer.clipAction(clips.get('Idle')); idle.play();
  const eye = new T.Vector3(0, 1.6, .02);
  const frame = (dt, extra = {}) => {
    rig.restore(); mixer.update(dt); rig.capture();
    root.updateWorldMatrix(true, true);
    rig.update({ dt, reduced: false, own: false, eye, lookYaw: 0, lookPitch: 0, ...extra });
    model.updateWorldMatrix(true, true);
  };
  frame(1 / 60);
  // Forward flexion must bring the chest toward the work at every body yaw.
  {
    for (const yaw of [0, .73, -2.1, 4.3]) {
      root.rotation.y = yaw; frame(1 / 60);
      const chest = rig.bones.get('chest'), before = chest.getWorldPosition(new T.Vector3());
      const forward = rig.forward.clone();
      rig.applyReachTrunk({ drop: 0, pitch: .35, yaw: 0, roll: 0 });
      const travel = chest.getWorldPosition(new T.Vector3()).sub(before).dot(forward);
      assert.ok(travel > .06, hero + ' forward hinge advances chest at yaw ' + yaw + ': ' + travel);
    }
    root.rotation.y = 0; frame(1 / 60);
  }
  // Stance search uses the actual articulated cast but must be transactional:
  // no trial pose may leak into the mixer or into the rendered skeleton.
  {
    const snapshot=()=>JSON.stringify({root:root.matrix.toArray(),bones:[...rig.base.keys()].map(b=>[b.position.toArray(),b.quaternion.toArray()]),hips:rig.baseHips.toArray(),base:[...rig.base.values()].map(q=>q.toArray())});
    const before=snapshot(), started=performance.now();
    const goals=[{side:1,wrist:new T.Vector3(-.16,.03,.45),fingers:new T.Vector3(0,0,1)}];
    const stance=rig.reachStance(goals,new T.Vector3(0,0,0),0,()=>true);
    assert.ok(stance,hero+' can plan a low wrist stance without lengthening bones');
    assert.equal(snapshot(),before,'stance trials restore every written bone and captured base');
    assert.equal(rig.reachStance(goals,new T.Vector3(),0,()=>false),null,'blocked floor refuses stance');
    assert.equal(snapshot(),before,'refused trials also restore the skeleton');
    console.log(JSON.stringify({hero,stance:stance.toArray(),stanceSearchMs:performance.now()-started}));
  }
  const lengths = rig.state.arms.map(a => ({ upper: dist(a.shoulder, a.elbow), fore: dist(a.elbow, a.wrist) }));
  for (const l of lengths) {
    assert.ok(l.upper > .23 && l.upper < .27, 'an upper arm of human length: ' + l.upper);
    assert.ok(l.fore > .195 && l.fore < .235, 'a forearm of human length: ' + l.fore);
  }

  // A root must not outrun a physical object before its spring can follow.
  // The constraint evaluates actual cast shoulders/lengths without changing
  // either the skeleton or the established world-space hand contacts.
  {
    const thing=new T.Group(), wrist=new T.Vector3(), fingers=new T.Vector3(), palm=new T.Vector3();
    for(const side of [1,-1]) {
      rig.handFrame(side,wrist,fingers,palm);
      rig.setContact(side,{wrist:wrist.clone(),fingers:fingers.clone(),palm:palm.clone(),grip:'relaxed',on:thing,onAt:new T.Vector3()});
    }
    for(let i=0;i<60;i++) frame(1/60);
    const before=JSON.stringify(rig.state),at=root.position.clone();
    assert.equal(rig.heldRootMotionFraction(at,at,0),1,'no root motion stays available');
    const far=at.clone().add(new T.Vector3(2,0,0));
    const fraction=rig.heldRootMotionFraction(at,far,0);
    assert.ok(fraction>=0 && fraction<.3,hero+' cannot leave the stationary secured wrists behind');
    assert.equal(JSON.stringify(rig.state),before,'reach query never writes a trial skeleton');
    const half=rig.heldRootMotionFraction(at,far,0,.05);
    assert.ok(half<=.05,'reach constraint respects the physical collision bound');
    rig.restore(); mixer.update(1/60); rig.capture(); root.updateWorldMatrix(true,true);
    assert.ok(Math.abs(rig.heldRootMotionFraction(at,far,0)-fraction)<1e-10,'mixer restoration cannot change a solved-shoulder root query');
    rig.setContact(1,null);rig.setContact(-1,null);
    assert.equal(rig.heldRootMotionFraction(at,far,Math.PI),1,'free hands do not restrict navigation');
    for(let i=0;i<60;i++)frame(1/60);
  }

  // Every gesture, both arms, at 60 fps: bones never stretch, the wrist stays where the pose put it, nothing is NaN.
  for (const g of ['wave', 'clap', 'cheer', 'listen', 'inspect', 'dance', 'hop']) {
    rig.play(g);
    for (let t = 0; t < P.GESTURE_SECONDS[g] + .2; t += 1 / 60) {
      frame(1 / 60);
      for (const [i, a] of rig.state.arms.entries()) {
        assert.ok(a.wrist.every(Number.isFinite));
        assert.ok(Math.abs(dist(a.shoulder, a.elbow) - lengths[i].upper) < 2e-3, `${g}: upper arm keeps its length`);
        assert.ok(Math.abs(dist(a.elbow, a.wrist) - lengths[i].fore) < 2e-3, `${g}: forearm keeps its length`);
      }
    }
  }

  // Clapping: at each beat the palms meet, measured on the real skinned vertices of both hands; between beats they never cross the midline.
  const hands = model.getObjectByProperty('name', 'Runner_Hands');
  const handsOverlap = () => {
    hands.skeleton.update();
    const p = new T.Vector3(), count = hands.geometry.getAttribute('position').count, a = [], b = [];
    for (let i = 0; i < count; i++) { hands.getVertexPosition(i, p); p.applyMatrix4(hands.matrixWorld); (i < count / 2 ? a : b).push(p.clone()); }
    const mean = l => l.reduce((s, v) => s + v.x, 0) / l.length, sign = mean(a) < mean(b) ? 1 : -1;
    const key = v => `${Math.round(v.y / .004)}|${Math.round(v.z / .004)}`, top = new Map(), low = new Map();
    for (const v of a) { const k = key(v), d = v.x * sign; if (!top.has(k) || d > top.get(k)) top.set(k, d); }
    for (const v of b) { const k = key(v), d = v.x * sign; if (!low.has(k) || d < low.get(k)) low.set(k, d); }
    let deepest = -Infinity;
    for (const [k, d] of top) if (low.has(k)) deepest = Math.max(deepest, d - low.get(k));
    return deepest;
  };
  rig.play('clap');
  let elapsed = 0, contacts = 0;
  for (let t = 0; t < P.GESTURE_SECONDS.clap; t += 1 / 240) {
    frame(1 / 240); elapsed += 1 / 240;
    const [r, l] = rig.state.arms;
    const gap = r.wrist[0] - l.wrist[0];
    // The character faces +Z: its right (+1) is at -X.
    if (P.gestureEnvelope('clap', elapsed) > .9) assert.ok(Math.abs(gap) >= 2 * P.CLAP_CONTACT - .004, 'palms never pass through each other');
    if (P.CLAP_BEATS.some(b => elapsed >= b && elapsed < b + 1 / 240 + 1e-6) || (contacts < P.CLAP_BEATS.length && P.CLAP_BEATS[contacts] <= elapsed)) {
      const overlap = handsOverlap();
      assert.ok(overlap > -.006, hero + ': palm on palm at the beat, not a gap: ' + overlap);
      assert.ok(overlap < .003, hero + ': one hand never passes through the other: ' + overlap);
      const dot = r.palmAxis[0] * l.palmAxis[0] + r.palmAxis[1] * l.palmAxis[1] + r.palmAxis[2] * l.palmAxis[2];
      assert.ok(dot < -.9, 'the palms face each other: ' + dot);
      contacts++;
    }
  }
  assert.equal(contacts, P.CLAP_BEATS.length, 'every beat is a real contact');

  // A hand goes where it is sent, and lets go. The elbow stays down and out.
  const goal = new T.Vector3(-.2, 1.14, .33);
  rig.setContact(1, { wrist: goal, fingers: new T.Vector3(0, 0, 1), palm: new T.Vector3(0, -1, 0), grip: 'handle' }, .5);
  let progress = [];
  for (let i = 0; i < 60; i++) { frame(1 / 60); progress.push(rig.contactProgress(1)); }
  assert.ok(progress[progress.length - 1] === 1);
  const on = rig.state.arms.find(a => a.side === 1);
  assert.ok(dist(on.wrist, goal.toArray()) < .004, 'the wrist is on the contact: ' + dist(on.wrist, goal.toArray()));
  assert.ok(on.elbow[1] < on.shoulder[1] && on.elbow[1] < on.wrist[1] + .11, 'the elbow hangs below');
  rig.setContact(1, null);
  for (let i = 0; i < 40; i++) frame(1 / 60);
  assert.ok(rig.contactProgress(1) === 0, 'the hand has let go');
  assert.equal(minJerk(0), 0); assert.equal(minJerk(1), 1); assert.ok(Math.abs(minJerk(.5) - .5) < 1e-9, 'a reach is symmetric in time');

  // With a prop held still, looking away cannot pull the shoulder beyond the arm's reach.
  // This reproduces a body stopped by furniture while the player's eyes continue turning.
  {
    const prop = new T.Group(); root.add(prop);
    const wrist = new T.Vector3(-.23, 1.23, .29), fingers = new T.Vector3(.2, 0, 1).normalize();
    rig.setContact(1, { wrist, fingers, palm: new T.Vector3(0, 1, 0), grip: 'book', on: prop }, .1);
    for (let i = 0; i < 60; i++) frame(1 / 60);
    let worst = 0;
    for (let i = 0; i < 480; i++) {
      frame(1 / 120, { own: true, lookYaw: 2 * Math.sin(i / 60), lookPitch: -.4 + .4 * Math.cos(i / 80) });
      const arm = rig.state.arms.find(a => a.side === 1);
      worst = Math.max(worst, dist(arm.wrist, wrist.toArray()));
    }
    assert.ok(worst < .012, `${hero}: held wrist stays reachable while looking around: ${worst}`);
    rig.setContact(1, null); root.remove(prop);
    for (let i = 0; i < 45; i++) frame(1 / 60);
  }

  // The rigid-grasp planner must see the FINAL shoulders. Moving a clavicle
  // after that callback invalidates even a jointly reachable two-hand target.
  {
    const prop=new T.Object3D();root.add(prop);
    for(const side of [1,-1])rig.setContact(side,{wrist:new T.Vector3(-side*.23,1.18,.34),fingers:new T.Vector3(0,0,1),palm:new T.Vector3(side,0,0),grip:'handle',on:prop},.1);
    for(let i=0;i<30;i++)frame(1/60);
    for(let i=0;i<24;i++){
      let measured;
      frame(1/60,{own:true,lookYaw:.4*Math.sin(i/6),dynamics:i<12?undefined:{stepping:false,mass:55,loads:[],strain:1},resolveContacts:()=>{measured=rig.state.arms.map(a=>a.shoulder);}});
      for(const [j,a] of rig.state.arms.entries())assert.ok(dist(a.shoulder,measured[j])<1e-8,`${hero}: grasp-planning shoulder moves after callback: ${dist(a.shoulder,measured[j])}`);
    }
    for(const side of [1,-1])rig.setContact(side,null);root.remove(prop);
    for(let i=0;i<45;i++)frame(1/60);
  }

  // Layers never compound on a pose the mixer does not rewrite: the same look gives the same head, frame after frame.
  // The physical body advances after target planning. A secured grip must
  // still reach that new contact, including when the torso easing lags it.
  {
    const prop=new T.Object3D();root.add(prop);
    const contacts=[1,-1].map(side=>({side,wrist:new T.Vector3(-side*.23,1.18,.34),fingers:new T.Vector3(0,0,1),palm:new T.Vector3(side,0,0),grip:'handle',on:prop}));
    for(const c of contacts)rig.setContact(c.side,c,.1);
    for(let i=0;i<60;i++)frame(1/60);
    let worst=0;
    for(let i=0;i<60;i++){
      frame(1/60,{resolveContacts:()=>{
        for(const c of contacts){c.wrist.z=.34+.26*Math.sin(i*Math.PI/60);c.wrist.y=1.18-.10*Math.sin(i*Math.PI/60);}
      }});
      for(const c of contacts)worst=Math.max(worst,rig.wristWorld(c.side).distanceTo(c.wrist));
    }
    assert.ok(worst<.001,`${hero}: secured wrists follow post-physics contacts: ${worst}`);
    for(const side of [1,-1])rig.setContact(side,null);root.remove(prop);
    for(let i=0;i<60;i++)frame(1/60);
  }

  // Recovery moves the root while the physical contacts remain stationary.
  // Both wrists must be solved after the admitted recovery, on the real cast.
  {
    const prop=new T.Object3D(), origin=root.position.clone();
    const targets=new Map([1,-1].map(side=>[side,new T.Vector3(-side*.23,1.18,.34)]));
    for(const side of [1,-1])rig.setContact(side,{wrist:targets.get(side),fingers:new T.Vector3(0,0,1),palm:new T.Vector3(side,0,0),grip:'handle',on:prop},.1);
    for(let i=0;i<30;i++)frame(1/60);
    for(let i=0;i<60;i++){
      const x=origin.x+.012*Math.sin(i/7), z=origin.z+.009*Math.sin(i/11);
      frame(1/60,{resolveRoot:()=>root.position.set(x,origin.y,z),resolveContacts:()=>{}});
      assert.equal(root.position.x,x,'recovery request is committed in the body update');
      for(const arm of rig.state.arms)assert.ok(dist(arm.wrist,targets.get(arm.side).toArray())<.003,`${hero}: recovery must retain physical wrist contact`);
    }
    for(const side of [1,-1])rig.setContact(side,null);
    root.position.copy(origin);for(let i=0;i<45;i++)frame(1/60);
  }

  idle.timeScale = 0;
  const head = model.getObjectByName('head'), q0 = new T.Quaternion();
  frame(1 / 60, { lookYaw: .5, lookPitch: -.4 }); head.getWorldQuaternion(q0);
  for (let i = 0; i < 300; i++) frame(1 / 60, { lookYaw: .5, lookPitch: -.4 });
  assert.ok(head.getWorldQuaternion(new T.Quaternion()).angleTo(q0) < 1e-3, 'three hundred frames later the head has not drifted');
  idle.timeScale = 1;

  // Turning on the spot carries the weight across: it stays where it is in the room, read in the new axes. A turn is not a stumble.
  {
    const dynamics = { stepping: false, mass: 55, loads: [], handForce: null, stance: null, strain: 0, roomAt: () => true };
    root.position.set(0, 0, 0); root.rotation.set(0, 0, 0);
    for (let i = 0; i < 40; i++) frame(1 / 60, { dynamics });
    Object.assign(rig.balance, { x: 0, z: .05, vx: 0, vz: 0 });
    root.rotation.y = Math.PI / 2;
    frame(1 / 480, { dynamics });
    assert.ok(Math.abs(Math.abs(rig.balance.x) - .05) < .006 && Math.abs(rig.balance.z) < .006, `a quarter turn reads the same weight sideways: ${rig.balance.x.toFixed(3)}, ${rig.balance.z.toFixed(3)}`);
    rig.balance.reset(); root.rotation.set(0, 0, 0);
    for (let i = 0; i < 40; i++) frame(1 / 60, { dynamics });
    const steps = rig.feet.steps;
    // A slow turn of the whole body on the spot: the feet turn with it in small steps, never a step to catch a fall.
    for (let i = 0; i < 90; i++) { root.rotation.y += Math.PI / 2 / 90; frame(1 / 60, { dynamics }); assert.ok(rig.balance.out.over <= 0, 'no fall to catch while turning: ' + rig.balance.out.over); }
    assert.ok(rig.feet.steps - steps <= 6, 'a few turning steps: ' + (rig.feet.steps - steps));
    root.rotation.set(0, 0, 0); rig.balance.reset();
  }

  // The gaits are real strides: looped without a step, and a planted foot stays planted when played at the measured speed.
  for (const [name, speed] of [['Walk', 1.4], ['Run', 2.9]]) {
    idle.stop();
    const clip = clips.get(name), action = mixer.clipAction(clip); action.reset().play();
    const scale = gaitTimeScale(name, speed, 1.04);
    action.timeScale = scale;
    root.position.set(0, 0, 0); root.rotation.set(0, 0, 0);
    const foot = [model.getObjectByName('footL') ?? model.getObjectByName('foot.L'), model.getObjectByName('footR') ?? model.getObjectByName('foot.R')];
    const was = [new T.Vector3(), new T.Vector3()];
    let least = [Infinity, Infinity], lowest = [Infinity, Infinity];
    const dt = 1 / 120;
    for (let i = 0; i < 240; i++) {
      mixer.update(dt); root.position.z += speed * dt;
      root.updateWorldMatrix(true, true);
      foot.forEach((bone, k) => {
        const p = bone.getWorldPosition(new T.Vector3());
        if (i > 4) { const v = p.distanceTo(was[k]) / dt; least[k] = Math.min(least[k], v); }
        lowest[k] = Math.min(lowest[k], p.y);
        was[k].copy(p);
      });
    }
    action.stop();
    for (const k of [0, 1]) assert.ok(least[k] < (name === 'Run' ? .8 : .32), `${name}: a stance foot stands nearly still on the floor, not skating: ${least[k].toFixed(3)} m/s`);
    assert.ok(GAIT_SPEED[name] > .5);
  }
  idle.play();
  console.log(JSON.stringify({ hero, path, bytes: stats.bytes, contacts, result: 'PASS' }));
}
// Grips stay inside the range of a real hand.
for (const [name, grip] of Object.entries(GRIPS)) grip.forEach((f, i) => {
  assert.ok(f[0] <= 1.6 && f[1] <= 1.8 && f[2] <= 1.25, `${name} ${FINGER_NAMES[i]}: within the flexion of a real joint`);
  assert.ok(Math.abs(f[3]) <= .4, `${name} ${FINGER_NAMES[i]}: within the spread of a real hand`);
});
assert.ok(curlPose(1)[2][1] > curlPose(0)[2][1]);
console.log('PASS human rig: one skeleton, real fingers and twist, bones that never stretch, palm-on-palm claps, contact hands, no compounding layers, feet that stay planted.');
