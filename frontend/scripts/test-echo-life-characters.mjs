// Echo Life Total Rebirth (A05) — Standalone Node verification suite for Character PBR,
// 48-Clip Cross-Rig Retargeting (killing the crowd_barista toilet-squat walk), Stride-Matched
// Locomotion Blend Space, Facial Micro-Life (6-morph Codex52 & 19-morph Echo59), Look-At & Fingers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { tsLoader } from './lib/ts-load.mjs';

const load = tsLoader({
  three: T,
  'three/examples/jsm/loaders/GLTFLoader.js': { GLTFLoader },
  'three/examples/jsm/utils/SkeletonUtils.js': { clone: cloneSkinned },
  './assets': { acquireLifeAsset: () => Promise.resolve(null), bicycleModel: () => new T.Group(), releaseLifeAsset: () => {}, installGltfTextureDedupPlugin: () => {}, isDedupManagedTexture: () => false, LIFE_ASSETS: { bicycle: '' } },
  './workshopView': { upgradeAndOptimizeVehicleRig: () => {} },
  './basketball': { Basketball: class { update() {} dispose() {} } },
  './marketStock': { MarketStock: class { update() {} dispose() {} } },
  '@/lib/echo-life/game/twoWheeler': { rideModels: {} },
  '@/lib/echo-life/game/automobile': { Automobile: class {} },
  '@/lib/echo-life/v3/game-core/index.mjs': { CHARACTERS: { linh: { name: 'Linh', role: 'Architect', model: 'linh' } }, CATALOG: { properties: { properties: [] } } },
});

const Mats = load('components/study-space/world/echoLife/characterMaterials.ts');
const Anim = load('components/study-space/world/echoLife/characterAnimator.ts');
const Life = load('components/study-space/world/echoLife/characterLife.ts');
const Skin = load('lib/embodiment/skin.ts');
const Fingers = load('lib/embodiment/fingers.ts');
const { HumanRig } = load('lib/embodiment/human.ts');
const { GameView } = load('components/study-space/world/echoLife/gameView.ts');

/** Loads a GLB in CPU-only Node mode (strips encoded images so GLTFLoader parses without ImageBitmap). */
async function loadGlbCpu(publicPath) {
  const data = readFileSync(new URL('../public' + publicPath, import.meta.url));
  const jsonLen = data.readUInt32LE(12);
  const json = JSON.parse(data.subarray(20, 20 + jsonLen).toString('utf8'));
  const rawMaterials = json.materials ?? [];
  if (json.materials) {
    // Keep material names, roughness, metalness, alphaMode, baseColorFactor; strip textures/images only
    json.materials = json.materials.map((m) => ({
      name: m.name,
      alphaMode: m.alphaMode,
      alphaCutoff: m.alphaCutoff,
      doubleSided: m.doubleSided,
      pbrMetallicRoughness: m.pbrMetallicRoughness
        ? {
            baseColorFactor: m.pbrMetallicRoughness.baseColorFactor,
            roughnessFactor: m.pbrMetallicRoughness.roughnessFactor,
            metallicFactor: m.pbrMetallicRoughness.metallicFactor,
          }
        : undefined,
    }));
  }
  delete json.textures;
  delete json.images;
  const raw = Buffer.from(JSON.stringify(json), 'utf8');
  const padded = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20);
  raw.copy(padded);
  const bin = data.subarray(20 + jsonLen);
  const header = Buffer.from(data.subarray(0, 20));
  header.writeUInt32LE(20 + padded.length + bin.length, 8);
  header.writeUInt32LE(padded.length, 12);
  const merged = Buffer.concat([header, padded, bin]);
  const gltf = await new GLTFLoader().parseAsync(
    merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength),
    '',
  );
  return { gltf, bytes: data.length, json, rawMaterials };
}

function getBoneByAny(root, names) {
  let found = null;
  root.traverse((o) => {
    if (found || !o.isBone) return;
    const n = o.userData?.name ?? o.name;
    if (names.includes(n) || names.includes(o.name)) found = o;
  });
  return found;
}

function deg(rad) {
  return (rad * 180) / Math.PI;
}

const report = {};

// ── 1. Staged 48-Clip Pack Integrity & Raw-RunnerRig Auto-Detection ────────────────────────────────────
{
  const { gltf, bytes, json } = await loadGlbCpu(Anim.ALL48_PACK_URL);
  assert.equal(gltf.animations.length, 48, 'all48 pack contains exactly 48 clips');
  assert.ok(bytes < 520_000, `all48 pack stays compact (<520 KB): ${bytes} bytes`);
  assert.equal(json.extensionsUsed, undefined, 'all48 pack requires zero WASM/Draco extensions');
  assert.equal(json.meshes, undefined, 'all48 pack has dummy meshes stripped');

  const rawRunner = [];
  const nativeEcho = [];
  for (const clip of gltf.animations) {
    const src = Anim.detectClipSourceFamily(clip, 'EchoStudentRig');
    if (src === 'RunnerRig') rawRunner.push(clip.name);
    else nativeEcho.push(clip.name);
  }
  assert.equal(rawRunner.length, 9, `exactly 9 raw RunnerRig clips detected, got ${rawRunner.length}: ${rawRunner}`);
  assert.equal(nativeEcho.length, 39, `exactly 39 native EchoStudentRig clips detected, got ${nativeEcho.length}`);
  for (const expected of ['Walk', 'Walk_Brisk', 'Run', 'Turn_L', 'Turn_R', 'Run_Stop', 'Pick_Up_Floor', 'Greet_Wave', 'Festival_Celebrate']) {
    assert.ok(rawRunner.includes(expected), `${expected} flagged as raw RunnerRig`);
  }
  report.pack48 = { url: Anim.ALL48_PACK_URL, bytes, clips: 48, rawRunnerCount: rawRunner.length, nativeEchoCount: nativeEcho.length };
}

// Load real models for all 3 rig families
const pack48 = (await loadGlbCpu(Anim.ALL48_PACK_URL)).gltf;
const lyraGltf = (await loadGlbCpu('/speaking/arena/lyra/cast-538d9dc8b304.glb')).gltf;
const baristaGltf = (await loadGlbCpu('/echo-life/people/crowd_barista-3e8974cca13b.glb')).gltf;
const linhGltf = (await loadGlbCpu('/echo-life/people/linh-73a0df577f32.glb')).gltf;

assert.equal(Anim.detectRigFamily(lyraGltf.scene), 'RunnerRig');
assert.equal(Anim.detectRigFamily(baristaGltf.scene), 'EchoStudentRig');
assert.equal(Anim.detectRigFamily(linhGltf.scene), 'Codex52');

// ── 2. Toilet-Squat Walk Proof on Real `crowd_barista` (Before vs After Repair) ───────────────────────
{
  const measurePelvisAndThighDrift = (root, clip) => {
    root.updateWorldMatrix(true, true);
    const hips = getBoneByAny(root, ['hips']);
    const spine = getBoneByAny(root, ['spine']);
    const thighL = getBoneByAny(root, ['thigh.L', 'thighL']);
    const restHipsW = hips.getWorldQuaternion(new T.Quaternion());
    const restSpineW = spine.getWorldQuaternion(new T.Quaternion());
    const restThighW = thighL.getWorldQuaternion(new T.Quaternion());
    const mixer = new T.AnimationMixer(root);
    const act = mixer.clipAction(clip);
    act.reset().play();
    let maxPelvisDeg = 0;
    let maxSpineDeg = 0;
    let avgThighPitchDeg = 0;
    const samples = 24;
    for (let i = 0; i < samples; i++) {
      act.time = (clip.duration * i) / samples;
      mixer.update(0);
      root.updateWorldMatrix(true, true);
      const curHipsW = hips.getWorldQuaternion(new T.Quaternion());
      const hipsDelta = curHipsW.clone().multiply(restHipsW.clone().invert());
      maxPelvisDeg = Math.max(maxPelvisDeg, Math.abs(deg(new T.Euler().setFromQuaternion(hipsDelta, 'XYZ').x)));
      const curSpineW = spine.getWorldQuaternion(new T.Quaternion());
      const spineDelta = curSpineW.clone().multiply(restSpineW.clone().invert());
      maxSpineDeg = Math.max(maxSpineDeg, Math.abs(deg(new T.Euler().setFromQuaternion(spineDelta, 'XYZ').x)));
      const curThighW = thighL.getWorldQuaternion(new T.Quaternion());
      const thighDelta = curThighW.clone().multiply(restThighW.clone().invert());
      avgThighPitchDeg += deg(new T.Euler().setFromQuaternion(thighDelta, 'XYZ').x);
    }
    act.stop();
    mixer.uncacheRoot(root);
    return {
      maxPelvisPitchDeg: +maxPelvisDeg.toFixed(2),
      maxSpinePitchDeg: +maxSpineDeg.toFixed(2),
      meanThighBiasDeg: +(avgThighPitchDeg / samples).toFixed(2),
    };
  };

  const brokenRoot = cloneSkinned(baristaGltf.scene);
  const rawWalk = baristaGltf.animations.find((a) => a.name === 'Walk');
  const before = measurePelvisAndThighDrift(brokenRoot, rawWalk);

  const fixedRoot = cloneSkinned(baristaGltf.scene);
  const repairedClips = Anim.repairActorClips(baristaGltf.animations, fixedRoot);
  const fixedWalk = repairedClips.find((a) => a.name === 'Walk');
  const after = measurePelvisAndThighDrift(fixedRoot, fixedWalk);

  assert.ok(before.maxPelvisPitchDeg > 18, `raw crowd_barista Walk has >18° pelvic pitch bug: ${before.maxPelvisPitchDeg}°`);
  assert.ok(after.maxPelvisPitchDeg < 5, `repaired crowd_barista Walk pelvis pitch must be <5° upright: ${after.maxPelvisPitchDeg}°`);
  assert.ok(Math.abs(after.meanThighBiasDeg) < 12, `repaired thigh mean pitch must be near vertical (<12°), got ${after.meanThighBiasDeg}°`);
  report.crowdBaristaWalkRepair = { before, after };
}

// ── 3. Cross-Rig 48-Clip Retargeting Across ALL 3 Rig Families (Lyra65, Echo59, Codex52) ──────────────
{
  const testClips = ['Walk', 'Walk_Brisk', 'Run', 'Sit_Idle', 'Talk_Gesture', 'Sport_Basketball_Shoot', 'Bicycle_Pedal'];
  const summary = {};
  for (const [label, gltf] of [
    ['RunnerRig_Lyra', lyraGltf],
    ['Echo59_Barista', baristaGltf],
    ['Codex52_Linh', linhGltf],
  ]) {
    const root = cloneSkinned(gltf.scene);
    const retargeted = Anim.getRetargeted48Clips(pack48, root);
    assert.equal(retargeted.size, 48, `${label} received all 48 retargeted clips`);
    const hips = getBoneByAny(root, ['hips', 'Hips']);
    const head = getBoneByAny(root, ['head', 'Head']);
    const thighL = getBoneByAny(root, ['thigh.L', 'thighL', 'LeftUpLeg']);
    const shinL = getBoneByAny(root, ['shin.L', 'shinL', 'LeftLeg']);
    root.updateWorldMatrix(true, true);
    const restThighLen = thighL.getWorldPosition(new T.Vector3()).distanceTo(shinL.getWorldPosition(new T.Vector3()));

    const mixer = new T.AnimationMixer(root);
    let maxLenDrift = 0;
    for (const cn of testClips) {
      const clip = retargeted.get(cn.toLowerCase());
      assert.ok(clip, `${label} has clip ${cn}`);
      if (label === 'Codex52_Linh') {
        assert.ok(clip.tracks.some((tr) => tr.name === 'Spine1.quaternion'), 'Codex52 split Spine1 track exists');
      }
      const act = mixer.clipAction(clip);
      act.reset().play();
      for (const f of [0, 0.33, 0.66]) {
        act.time = clip.duration * f;
        mixer.update(0);
        root.updateWorldMatrix(true, true);
        for (const b of [hips, head, thighL, shinL]) {
          const p = b.getWorldPosition(new T.Vector3());
          assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), `${label}:${cn} finite`);
        }
        const curLen = thighL.getWorldPosition(new T.Vector3()).distanceTo(shinL.getWorldPosition(new T.Vector3()));
        maxLenDrift = Math.max(maxLenDrift, Math.abs(curLen - restThighLen));
      }
      act.stop();
    }
    mixer.uncacheRoot(root);
    assert.ok(maxLenDrift < 0.002, `${label} thigh length invariant preserved (<2mm): ${maxLenDrift}`);
    summary[label] = { clips: retargeted.size, maxBoneLenDriftMm: +(maxLenDrift * 1000).toFixed(3) };
  }
  report.crossRigRetarget = summary;
}

// ── 4. Stride-Matched Speed Scaling & CharacterAnimator State Machine ─────────────────────────────────
{
  const sSlow = Anim.strideTimeScale('walk', 0.54, 1);
  const sNom = Anim.strideTimeScale('walk', 1.08, 1);
  const sFast = Anim.strideTimeScale('walk', 1.62, 1);
  assert.ok(sSlow < sNom && sNom < sFast, 'strideTimeScale scales monotonically with speed');
  assert.ok(Math.abs(sNom - 1.0) < 1e-6, 'nominal walk speed gives 1.0x timeScale');
  assert.equal(Anim.strideTimeScale('walk', 0.01, 1), 0.38, 'lower clamp respected');
  assert.equal(Anim.strideTimeScale('walk', 9.0, 1), 1.55, 'upper clamp respected');

  const linhRoot = cloneSkinned(linhGltf.scene);
  const animator = new Anim.CharacterAnimator(linhRoot, linhGltf.animations, 'npc:linh');
  animator.bindPack(pack48);
  const states = [];
  // Idle -> Walk -> Walk_Brisk -> Run -> Stop -> Sit -> Dialogue Speak -> Dialogue Listen -> Basketball Shoot
  for (const step of [
    { activity: 'idle', speed: 0, seated: false, inDialogue: false, speaking: false, frames: 8 },
    { activity: 'walk', speed: 1.05, seated: false, inDialogue: false, speaking: false, frames: 12 },
    { activity: 'walk', speed: 1.75, seated: false, inDialogue: false, speaking: false, frames: 12 },
    { activity: 'run', speed: 2.6, seated: false, inDialogue: false, speaking: false, frames: 12 },
    { activity: 'idle', speed: 0, seated: true, inDialogue: false, speaking: false, frames: 20 },
    { activity: 'idle', speed: 0, seated: false, inDialogue: true, speaking: true, frames: 12 },
    { activity: 'idle', speed: 0, seated: false, inDialogue: true, speaking: false, frames: 12 },
  ]) {
    for (let i = 0; i < step.frames; i++) animator.update({ dt: 1 / 30, ...step });
    states.push({ clip: animator.currentName, scale: +(animator.current?.timeScale ?? 0).toFixed(2) });
  }
  assert.equal(states[5].clip, 'talk_gesture', 'speaking dialogue enters talk_gesture immediately');
  assert.equal(states[6].clip, 'listen_nod', 'listening dialogue enters listen_nod');
  assert.ok(animator.triggerOneShot('shoot_basket'), 'triggerOneShot(shoot_basket) succeeds');
  assert.equal(animator.currentName, 'sport_basketball_shoot');
  animator.dispose();
  report.animatorStates = states;
}

// ── 5. CharacterLife — FACS Morphs (6 & 19), Look-At Direction, Zero Drift & Natural Fingers ──────────
{
  const testLifeOnModel = (label, gltf, expectedMorphCount) => {
    const root = cloneSkinned(gltf.scene);
    const life = new Life.CharacterLife(root, label);
    assert.equal(life.capabilities.morphCount, expectedMorphCount, `${label} morph count`);
    assert.equal(life.capabilities.fingerBoneCount, 30, `${label} 30 finger bones`);
    assert.equal(life.capabilities.hasLookAtChain, true, `${label} look-at chain`);

    // Measure baseline head forward direction
    const head = getBoneByAny(root, ['head', 'Head']);
    const handL = getBoneByAny(root, ['hand.L', 'handL', 'LeftHand']);
    const idx3L = getBoneByAny(root, ['index.3.L', 'index3L', 'LeftHandIndex3']);
    root.updateWorldMatrix(true, true);
    const headPos = head.getWorldPosition(new T.Vector3());
    // Target to character's right (-X) and slightly up (+Y)
    const targetRightUp = headPos.clone().add(new T.Vector3(-1.4, 0.35, 1.8));
    const toTarget = targetRightUp.clone().sub(headPos).normalize();
    const headFwdBefore = new T.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new T.Quaternion())).normalize();
    const dotBefore = headFwdBefore.dot(toTarget);

    // Measure index fingertip distance to palm center before vs after finger curl
    const tipBefore = idx3L.getWorldPosition(new T.Vector3());
    const palmRef = handL.getWorldPosition(new T.Vector3());
    const tipDistBefore = tipBefore.distanceTo(palmRef);

    // Step 4 seconds of speaking dialogue with look target & blinking
    let maxBlink = 0;
    let maxSpeech = 0;
    let maxSmile = 0;
    for (let i = 0; i < 240; i++) {
      life.restore();
      life.capture();
      life.update({
        dt: 1 / 60,
        lookTargetWorld: targetRightUp,
        speed: 0,
        seated: false,
        inDialogue: true,
        speaking: true,
        mood: 'friendly',
      });
      const snap = life.morphSnapshot;
      maxBlink = Math.max(maxBlink, snap['blink.L'] ?? 0);
      maxSpeech = Math.max(maxSpeech, snap.aa ?? 0, snap.ih ?? 0, snap.ou ?? 0);
      maxSmile = Math.max(maxSmile, snap.smile ?? 0);
    }

    root.updateWorldMatrix(true, true);
    const headFwdAfter = new T.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new T.Quaternion())).normalize();
    const dotAfter = headFwdAfter.dot(toTarget);
    const tipDistAfter = idx3L.getWorldPosition(new T.Vector3()).distanceTo(handL.getWorldPosition(new T.Vector3()));

    assert.ok(dotAfter > dotBefore + 0.08, `${label} look-at turns head toward target (${dotBefore.toFixed(3)} -> ${dotAfter.toFixed(3)})`);
    assert.ok(maxBlink > 0.35, `${label} natural blink triggers (${maxBlink})`);
    assert.ok(maxSpeech > 0.25, `${label} dialogue lip-sync visemes active (${maxSpeech})`);
    assert.ok(maxSmile > 0.4, `${label} friendly mood smile active (${maxSmile})`);
    assert.ok(tipDistAfter < tipDistBefore, `${label} finger curl bends INWARD toward palm (${tipDistBefore.toFixed(4)} -> ${tipDistAfter.toFixed(4)})`);

    // Restore invariance check: after restore(), head rotation returns identically to captured base (<1e-6)
    life.restore();
    root.updateWorldMatrix(true, true);
    const headFwdRestored = new T.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new T.Quaternion())).normalize();
    assert.ok(headFwdRestored.distanceTo(headFwdBefore) < 1e-5, `${label} restore() guarantees zero frame-to-frame drift`);

    return {
      morphCount: expectedMorphCount,
      lookDotDelta: +(dotAfter - dotBefore).toFixed(3),
      maxBlink: +maxBlink.toFixed(2),
      maxSpeech: +maxSpeech.toFixed(2),
      maxSmile: +maxSmile.toFixed(2),
      fingerCurlDeltaMm: +((tipDistBefore - tipDistAfter) * 1000).toFixed(2),
    };
  };

  report.lifeCodex52 = testLifeOnModel('npc:linh', linhGltf, 6);
  report.lifeEcho59 = testLifeOnModel('crowd:barista', baristaGltf, 19);
}

// ── 6. Unified Character PBR Classifier & Material Upgrader ───────────────────────────────────────────
{
  const cases = [
    ['Cast_Face', 'cast_face', 'skin_face'],
    ['Cast_Eyes', 'cast_eye', 'eyes'],
    ['Cast_Hair', 'cast_hair', 'hair'],
    ['Runner_Hands', 'Hand_Skin', 'skin_body'],
    ['Cast_Scarf', 'runner_body', 'cloth_knit'],
    ['Face_and_visible_skin', 'skin', 'skin_face'],
    ['Eyes', 'Eyes', 'eyes'],
    ['Brows', 'Brows', 'brows'],
    ['Hair_braid01', 'Hair_braid01', 'hair'],
    ['Wardrobe_female_casualsuit02', 'Wardrobe_female_casualsuit02', 'cloth_cotton'],
    ['Shoes_shoes01', 'Shoes_shoes01', 'footwear_sneaker'],
    ['Wear_Bottom_denim_jeans', 'Mat_Bottom_denim_jeans_1f2937', 'cloth_denim'],
    ['Wear_Shoes_leather_loafers', 'Mat_Shoe_leather_loafers_4a3228', 'footwear_leather'],
    ['Trim_Soles_white_sneakers', 'Mat_Sole_f8fafc', 'footwear_sole'],
    ['Mesh', 'Mat_Face_bg_barista', 'skin_face'],
    ['Mesh', 'Mat_Skin_ecc1a3', 'skin_body'],
    ['Mesh', 'Atelier_glass', 'glass'],
    ['Mesh', 'Atelier_metal', 'metal'],
  ];
  for (const [meshName, matName, expected] of cases) {
    assert.equal(Mats.classifyCharacterSurface(meshName, matName), expected, `classify(${meshName}, ${matName})`);
  }

  for (const [label, gltf] of [
    ['Codex52_Linh', linhGltf],
    ['Echo59_Barista', baristaGltf],
  ]) {
    const root = cloneSkinned(gltf.scene);
    const res = Mats.upgradeCharacterMaterials(root, { quality: 'high' });
    assert.ok(res.materials.length > 0, `${label} upgraded materials created`);
    let skinCount = 0;
    let eyeCount = 0;
    let hairAlphaFixed = 0;
    let bodyReceivesShadow = 0;

    root.traverse((o) => {
      if (!o.isMesh) return;
      const mat = o.material;
      if (mat.name?.startsWith('PBR_Skin_')) {
        skinCount++;
        assert.ok(mat instanceof T.MeshPhysicalMaterial, 'skin is MeshPhysicalMaterial');
        assert.ok(
          /^ec-skin-aaa-(face|body)-v4(\|(echo-hfog-v1|echo-csm-v5))*$/.test(mat.customProgramCacheKey()),
          `skin uses distinct AAA v4 cache key with creation-time fog+CSM: got ${mat.customProgramCacheKey()}`,
        );
        // Verify onBeforeCompile actually patches the Three.js physical lights + worldpos/CSM chunks cleanly
        const fakeShader = {
          vertexShader: '#include <common>\n#include <worldpos_vertex>\n#include <shadowmap_pars_vertex>\n#include <shadowmap_vertex>',
          fragmentShader: '#include <common>\n#include <lights_physical_pars_fragment>\n#include <opaque_fragment>\n#include <fog_fragment>',
          uniforms: {},
        };
        mat.onBeforeCompile(fakeShader, null);
        assert.ok(fakeShader.fragmentShader.includes('ecSssTint'), 'wrap-diffuse SSS injected');
        assert.ok(
          fakeShader.fragmentShader.includes('ecRim') || fakeShader.fragmentShader.includes('ecAaaRim'),
          'grazing rim injected',
        );
        assert.equal(o.receiveShadow, true, `${label} skin receives shadows`);
        assert.equal(o.castShadow, true, `${label} skin casts shadows`);
      } else if (mat.name?.startsWith('PBR_Eye_')) {
        eyeCount++;
        assert.ok(mat.roughness <= 0.12 && mat.clearcoat === 1.0, `${label} glossy clearcoat cornea eye`);
        assert.equal(o.receiveShadow, false, `${label} eyes do not self-shadow muddy`);
      } else if (mat.name?.startsWith('PBR_Hair_')) {
        assert.equal(mat.transparent, false, `${label} hair avoids BLEND sorting halos`);
        assert.equal(mat.depthWrite, true, `${label} hair writes depth`);
        hairAlphaFixed++;
      } else if (mat.name?.startsWith('PBR_')) {
        if (o.receiveShadow) bodyReceivesShadow++;
      }
    });

    assert.ok(skinCount >= 1, `${label} upgraded skin count >= 1`);
    assert.ok(eyeCount >= 1, `${label} upgraded eye count >= 1`);
    assert.ok(hairAlphaFixed >= 1, `${label} upgraded hair count >= 1`);
    assert.ok(bodyReceivesShadow >= 1, `${label} clothing/shoes receive shadows`);
    res.materials.forEach((m) => m.dispose());
  }
  report.pbrUpgrade = { classifierCases: cases.length, status: 'PASS' };
}

// ── 7. Wave 2A Wiring Proofs: skin.ts SSS, fingers.ts cascade, HumanRig clearTransientContacts, GameView labels & 4x-CPU opts ──
{
  // 7a. skin.ts shared wrap-diffuse SSS shader & receiveShadow
  const srcMat = new T.MeshStandardMaterial({ color: '#e8c4a8', roughness: 0.7 });
  const faceMat = Skin.skinMaterial(srcMat, { face: true });
  const bodyMat = Skin.skinMaterial(srcMat, { face: false });
  assert.equal(faceMat.customProgramCacheKey(), 'ec-skin-sss-face-v3', 'skin.ts face shares ec-skin-sss-face-v3');
  assert.equal(bodyMat.customProgramCacheKey(), 'ec-skin-sss-body-v3', 'skin.ts body shares ec-skin-sss-body-v3');
  const fake = { fragmentShader: '#include <lights_physical_pars_fragment>\n#include <opaque_fragment>' };
  faceMat.onBeforeCompile(fake, null);
  assert.ok(fake.fragmentShader.includes('ecSssTint') && fake.fragmentShader.includes('ecRim'), 'skin.ts injects SSS + rim');
  faceMat.dispose();
  bodyMat.dispose();
  srcMat.dispose();

  // 7b. fingers.ts GRIPS.relaxed anatomical cascade (no 34° splay)
  const rel = Fingers.GRIPS.relaxed;
  assert.ok(rel[1][1] < rel[2][1] && rel[2][1] < rel[3][1] && rel[3][1] < rel[4][1], 'GRIPS.relaxed has progressive index->little PIP cascade');
  assert.ok(rel[1][3] < 0 && rel[4][3] > 0, 'GRIPS.relaxed closes index and little finger bind splay inward');

  // 7c. HumanRig.clearTransientContacts() + teleport-ghost guard prevents 90° basketball door-reach fold
  const root = new T.Group();
  const model = cloneSkinned(lyraGltf.scene);
  model.scale.setScalar(1.04);
  root.add(model);
  root.updateWorldMatrix(true, true);
  const rig = new HumanRig(model, root);
  const mixer = new T.AnimationMixer(model);
  mixer.clipAction(lyraGltf.animations.find((c) => c.name === 'Idle')).play();
  const stepRig = (dt = 1 / 60) => {
    rig.restore();
    mixer.update(dt);
    rig.capture();
    root.updateWorldMatrix(true, true);
    rig.update({ dt, reduced: false, own: false, eye: new T.Vector3(0, 1.56, 0.02), lookYaw: 0, lookPitch: 0 });
  };
  // Reach toward a close low door handle -> builds non-zero trunk bend
  rig.setContact(1, { wrist: new T.Vector3(-0.22, 0.55, 0.52), fingers: new T.Vector3(0, 0, 1), palm: new T.Vector3(0, -1, 0), grip: 'handle' }, 0.1);
  for (let i = 0; i < 30; i++) stepRig();
  const bentPitch = rig.bendNow.pitch;
  assert.ok(bentPitch > 0.15, `close reach builds trunk bend (${bentPitch.toFixed(3)} rad)`);
  // Clear transient contacts on teleport -> bend resets immediately to 0
  rig.clearTransientContacts();
  assert.equal(rig.bendNow.pitch, 0, 'clearTransientContacts resets bend.pitch to 0');
  assert.equal(rig.contactOn(1), null, 'clearTransientContacts clears transient arm contact');
  // Even if a stale interaction sets a contact 80m away after teleport, ghost guard refuses to fold trunk
  rig.setContact(1, { wrist: new T.Vector3(80, 0.9, -45), fingers: new T.Vector3(0, 0, 1), palm: new T.Vector3(0, -1, 0), grip: 'handle' }, 0.05);
  for (let i = 0; i < 15; i++) stepRig();
  assert.equal(rig.bendNow.pitch, 0, `teleport-ghost guard keeps bend.pitch === 0 for 80m target (got ${rig.bendNow.pitch})`);

  // 7d. GameView: labels() localToWorld fix, 4-tier setQuality, no yellow diamonds, static boundingSphere, challenge focusRing hidden
  const stage = new T.Group();
  stage.position.set(12.5, -3.2, -8.4);
  stage.scale.setScalar(1.25);
  const view = new GameView('ultra');
  stage.add(view.group);
  stage.updateWorldMatrix(true, true);
  assert.equal(view.quality, 'ultra', 'GameView accepts ultra quality tier');
  view.setQuality('balanced');
  assert.equal(view.quality, 'balanced', 'setQuality updates quality tier');
  assert.equal(view.diamonds, undefined, 'floating yellow octahedron diamonds removed from GameView');
  assert.ok(view.bodyMesh.boundingSphere && view.bodyMesh.boundingSphere.radius >= 300, 'static boundingSphere set on instanced bodyMesh');

  const cam = new T.PerspectiveCamera(60, 16 / 9, 0.1, 400);
  cam.position.set(12.5, 0.5, -2.0);
  cam.lookAt(12.5, -1.0, -8.4);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  const fakeWalk = { groundAt: () => 0, surface: () => ({ region: 'park' }) };
  const fakeGame = {
    s: { challenge: { type: 'sport' } },
    people: {
      talking: null,
      stats: { scenes: [] },
      walkers: new Map([['linh', { id: 'linh', x: 1.2, z: -0.6, yaw: 0, activity: 'idle', moving: false, seat: null, facing: null }]]),
    },
    hotspots: [],
    crowd: () => [],
    traffic: [],
    weather: { rain: false },
    car: { pose: { x: 0, z: 0, yaw: 0 }, spec: null, updateDoor() {} },
    twoWheeler: { pose: { x: 0, z: 0, yaw: 0 }, spec: null, updateDoor() {} },
    bike: { x: 0, z: 0, yaw: 0 },
    riding: false,
    ridingShared: false,
    sceneById: () => null,
    entityFor: () => null,
  };
  const labels = view.labels(fakeGame, fakeWalk, cam, 1280, 720, { x: 0, z: 0 }, null);
  assert.equal(labels.length, 1, 'label emitted for nearby resident under non-identity stage');
  // Expected exact world-projected pixel of local (1.2, 1.92, -0.6) transformed by stage
  const expectedWorld = new T.Vector3(1.2, 1.92, -0.6);
  view.group.localToWorld(expectedWorld).project(cam);
  const expectedX = ((expectedWorld.x + 1) / 2) * 1280;
  const expectedY = ((1 - expectedWorld.y) / 2) * 720;
  const errPx = Math.hypot(labels[0].x - expectedX, labels[0].y - expectedY);
  assert.ok(errPx < 0.5, `labels() localToWorld projection error < 0.5px (got ${errPx.toFixed(3)}px)`);

  // Verify focusRing stays hidden while challenge is active
  view.update(1 / 60, fakeGame, fakeWalk, { x: 0, z: 0 }, { kind: 'npc', id: 'linh', name: 'Linh', at: { x: 1.2, z: -0.6 }, dist: 1.3 }, false, 0, false, cam);
  assert.equal(view.focusRing.visible, false, 'focusRing hidden during active challenge');
  view.dispose();

  report.wave2aWiring = {
    skinSssKeys: ['ec-skin-sss-face-v3', 'ec-skin-sss-body-v3'],
    relaxedCascadePipRad: rel.map((f) => f[1]),
    teleportGhostBendPitch: rig.bendNow.pitch,
    labelProjectionErrPx: +errPx.toFixed(4),
    challengeFocusRingVisible: false,
    status: 'PASS',
  };
}

console.log(JSON.stringify({ status: 'PASS', report }, null, 2));
