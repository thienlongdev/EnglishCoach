import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { RunnerPose } from './skyRunner';
import { prepareCastMaterials } from '@/lib/embodiment/skin';
import { CastLook, type Mood } from '@/lib/embodiment/cast';
import { Wardrobe } from '@/lib/avatar/wardrobe';
import { decodeLook } from '@/lib/avatar/look';

/**
 * Lyra and Kai, the Skybound heroes — Blender-made, rigged and animated English Coach adventurers (sk_runner.py /
 * sk_runner_rig.py, SK_HERO=lyra|kai). Both share one skeleton, one clip set and one palette layout; the hero is
 * cosmetic only (the simulation never sees it). Locomotion clips (Run, Sprint) are scrubbed by stride phase from the
 * distance actually travelled, so feet never slide and a recoil or a server correction never fast-forwards a step;
 * every other clip answers a real game state or moment (jump, landing, dodge, hit, fall, door brace, refusal, finish).
 * The painted face has six expression rows chosen by offsetting the face atlas.
 */
export type RushHero = 'LYRA' | 'KAI';
export const RUSH_HEROES: readonly RushHero[] = ['LYRA', 'KAI'];
export const isRushHero = (v: unknown): v is RushHero => v === 'LYRA' || v === 'KAI';
/** Racers keep the character sheet's design; only the Echo scarf and wristband accent tells them apart. */
export interface CharacterLook { scarf: string }
export const CHARACTER_LOOKS: CharacterLook[] = [
  { scarf: '#1fb8aa' }, { scarf: '#e9a23b' }, { scarf: '#d9577a' }, { scarf: '#8f6fe6' }, { scarf: '#4ea8ec' },
];
const CELL = { scarf: [9, 15] } as const;
type Clip = 'Idle' | 'Walk' | 'Run' | 'Sprint' | 'Dash' | 'JumpUp' | 'JumpFall' | 'Land' | 'Dodge' | 'DodgeL' | 'Hit' | 'Tumble' | 'Brace' | 'Stumble' | 'Cheer' | 'Wave';
export type CharacterCue = 'jump' | 'dodge-left' | 'dodge-right';
const ONE_SHOT = new Set<Clip>(['JumpUp', 'Land', 'Dodge', 'DodgeL', 'Hit', 'Stumble']);
const FACE = { smile: 0, blink: 1, ouch: 2, focus: 3, surprise: 4, sad: 5 } as const;
const FACE_ROWS = 6;
/**
 * Secondary motion: the ponytail (Lyra) and the scarf tails lag behind changes of pace and height. A damped spring per
 * chain, added on top of the authored clip after the mixer (the mixer rewrites the bones each frame, so nothing builds
 * up); a few multiplications per racer, no simulation.
 */
interface Trail { bones: THREE.Object3D[]; angle: number; vel: number; gain: number }

const paletteCache = new Map<string, THREE.Texture>();
function lookPalette(base: THREE.Texture, look: CharacterLook, key: string) {
  const hit = paletteCache.get(key);
  if (hit) return hit;
  const image = base.image as CanvasImageSource & { width: number; height: number };
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  const g = canvas.getContext('2d')!; g.drawImage(image, 0, 0);
  const cell = canvas.width / 8;
  for (const [name, cells] of Object.entries(CELL)) for (const index of cells) {
    g.fillStyle = look[name as keyof CharacterLook];
    g.fillRect((index % 8) * cell, Math.floor(index / 8) * cell, cell, cell);
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  paletteCache.set(key, t);
  return t;
}
export function disposeCharacterPalettes() { for (const t of paletteCache.values()) t.dispose(); paletteCache.clear(); }

const EYE_B = new THREE.Vector3();

export class SkyCharacter {
  readonly root = new THREE.Group();
  private model: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<Clip, THREE.AnimationAction>();
  private weights = new Map<Clip, number>();
  private materials: THREE.MeshStandardMaterial[] = [];
  private face: THREE.Texture | null = null;
  private stride = 0; private run = 0; private sprint = 0;
  /** Travel speed eased over ~70 ms: a frame with no new simulation step (or a late snapshot) never flips Run to Idle. */
  private speedEma = 0;
  private shot: Clip | null = null; private shotAge = 0;
  private yaw = 0; private bank = 0; private lastPhase = '';
  private blinkAt = 2; private ghostValue = 1; private wasAir = false;
  private trails: Trail[] = []; private lastSpeed = 0; private lastVz = 0;
  /** Called at each foot contact while running (0 = left, 1 = right) with the pace 0..1. */
  onStep: (foot: 0 | 1, pace: number) => void = () => {};

  /** A real player: the cast of the Study Space and the Arena, with their face and in their clothes. */
  private castLook: CastLook | null = null;
  private wardrobe: Wardrobe | null = null;
  private owned: THREE.Material[] = [];
  private isCast = false;
  /** The two eye bones of a real player's body: where a first-person camera sits. */
  private eyeBones: THREE.Object3D[] = [];
  private head: THREE.Object3D | null = null;
  private ownView = false;
  /** Resolves once the clothes the player chose are on (at once for a runner without a wardrobe). */
  dressed: Promise<boolean> = Promise.resolve(true);

  constructor(template: GLTF, look: CharacterLook, lookIndex: number, orm: THREE.Texture | null, cast?: { hero: RushHero; avatar: string }) {
    this.model = SkeletonUtils.clone(template.scene);
    this.model.rotation.y = Math.PI;                       // authored facing +Z; the causeway runs toward −Z
    this.model.scale.setScalar(.93);
    this.root.add(this.model);
    if (cast) {
      this.isCast = true;
      this.owned.push(...prepareCastMaterials(this.model));
      this.castLook = new CastLook(this.model, cast.hero);
      this.owned.push(...this.castLook.materials);
      this.wardrobe = new Wardrobe(this.model, cast.hero);
      const dress = decodeLook(cast.hero, cast.avatar);
      this.castLook.setHairColor(dress.colors.hair);
      this.dressed = this.wardrobe.apply(dress).catch(() => false);
    }
    this.model.traverse(o => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true; mesh.receiveShadow = false; mesh.frustumCulled = false;
      if (cast && (CastLook.owns(mesh) || mesh.name.includes('Hands'))) return;
      const m = (mesh.material as THREE.MeshStandardMaterial).clone();
      m.vertexColors = true; m.transparent = true; m.opacity = 1;
      if (mesh.name.includes('Head')) {
        // Each racer owns a copy of the face atlas so it can show its own expression.
        if (m.map) { this.face = m.map.clone(); this.face.needsUpdate = true; m.map = this.face; }
        m.roughness = .55; m.metalness = 0;
      } else {
        if (m.map) m.map = lookPalette(m.map, look, `look${lookIndex}`);
        if (orm) { m.roughnessMap = orm; m.metalnessMap = orm; m.roughness = 1; m.metalness = 1; }
      }
      // Soft rim from the view edge so the silhouette separates from bright skies and dark rock alike.
      m.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float skRim = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
          totalEmissiveRadiance += diffuseColor.rgb * skRim * 0.3;`);
      };
      m.customProgramCacheKey = () => 'skyrunner-rim';
      mesh.material = m; this.materials.push(m);
    });
    const bone = (name: string) => this.model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name));
    this.model.traverse(o => {
      if (!(o as THREE.Bone).isBone) return;
      const name = (o.userData.name as string | undefined) ?? o.name;
      if (name === 'eye.L' || name === 'eye.R' || name === 'eyeL' || name === 'eyeR') this.eyeBones.push(o);
      else if ((name === 'head' || name === 'Head') && !this.head) this.head = o;
    });
    for (const [names, gain] of [[cast ? [] : ['pony.1', 'pony.2', 'pony.3'], 1], [['scarf.L.1', 'scarf.L.2', 'scarf.L.3'], .8], [['scarf.R.1', 'scarf.R.2', 'scarf.R.3'], .8]] as const) {
      const bones = names.map(bone).filter((b): b is THREE.Object3D => !!b);
      if (bones.length) this.trails.push({ bones, angle: 0, vel: 0, gain });
    }
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of template.animations) {
      const name = clip.name as Clip;
      const action = this.mixer.clipAction(clip);
      action.setLoop(ONE_SHOT.has(name) ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = true; action.enabled = true; action.setEffectiveWeight(0); action.play();
      if (['Walk', 'Run', 'Sprint', 'Dash'].includes(name)) action.timeScale = 0;   // scrubbed by real displacement
      this.actions.set(name, action); this.weights.set(name, 0);
    }
  }

  /**
   * Where this body's eyes are this frame, in world space: between the two eye bones, after the clip and the run cycle moved them (running, jumping,
   * falling, landing). A runner without eye bones answers from its head bone, a little forward; null if it has neither.
   */
  eyes(out: THREE.Vector3): THREE.Vector3 | null {
    if (this.eyeBones.length >= 2) {
      this.eyeBones[0].getWorldPosition(out);
      const b = this.eyeBones[1].getWorldPosition(EYE_B);
      return out.add(b).multiplyScalar(.5);
    }
    if (!this.head) return null;
    this.head.getWorldPosition(out);
    return out;
  }
  /** Through one's own eyes: everything of the body stays except the head, its hair and what is worn on it (their shadows stay). */
  setOwnView(on: boolean) {
    if (on === this.ownView) return;
    this.ownView = on;
    this.castLook?.setOwnView(on);
    this.wardrobe?.setOwnView(on);
  }
  get hasOwnView() { return this.isCast; }

  /** Translucent racer on another checkpoint (their doors are private), as before. */
  setGhost(input: number) {
    const value = Math.round(input * 20) / 20;
    if (Math.abs(value - this.ghostValue) < .01) return;
    this.ghostValue = value;
    this.model.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = value > .95;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) { m.transparent = value < .99 || this.materials.includes(m as THREE.MeshStandardMaterial); m.opacity = value; m.depthWrite = value > .95; }
    });
  }

  private play(clip: Clip) { const a = this.actions.get(clip); if (!a) return; a.reset(); a.play(); this.shot = clip; this.shotAge = 0; }
  /** One-shot moments decided by the simulation / authority. */
  cue(kind: CharacterCue) {
    if (kind === 'jump') this.play('JumpUp');
    else this.play(kind === 'dodge-left' ? 'DodgeL' : 'Dodge');
  }

  animate(p: RunnerPose & { airborne?: boolean; vz?: number; heading?: number }) {
    const dt = p.dt, air = !!p.airborne;
    const locomotion = p.phase === 'RUNNING' || p.phase === 'FINISHING' || p.phase === 'OPENING' && p.phaseTime >= .48;
    if (dt > 0) this.speedEma += (p.travel / dt - this.speedEma) * (1 - Math.exp(-dt * 14));
    const measuredSpeed = this.speedEma;
    const moving = locomotion && (p.heading === undefined || measuredSpeed > .12);
    const pace = moving ? Math.min(1, Math.max(0, p.heading === undefined ? (p.speed - 140) / 200 : (measuredSpeed - 3.1) / 3.2)) : 0;
    const walk = this.actions.has('Walk') && p.heading !== undefined ? Math.max(0, Math.min(1, (3.8 - measuredSpeed) / 2.1)) : 0;
    this.run += ((moving ? 1 : 0) - this.run) * (1 - Math.exp(-dt * 10));
    this.sprint += ((p.dashing || p.rushing || pace > .45 ? Math.min(1, pace * 1.6) : 0) - this.sprint) * (1 - Math.exp(-dt * 6));
    const sprintClip = this.isCast ? 0 : this.sprint;   // The cast runs on one captured stride at every pace: the feet stay in step.
    // Stride: scene distance per two steps grows from a run to a sprint (2.6 → 3.2 scene units).
    const before = this.stride;
    if (moving && !air) this.stride = (this.stride + Math.max(0, p.travel) / (2.6 + .6 * this.sprint)) % 1;
    if (moving && !air && p.travel > 0) {
      // Contacts at phase 0 (left) and .5 (right): the moments the authored clip plants each foot.
      if (before > this.stride) this.onStep(0, pace);
      else if (before < .5 && this.stride >= .5) this.onStep(1, pace);
    }
    if (this.wasAir && !air && p.phase === 'RUNNING') this.play('Land');
    this.wasAir = air;
    if (p.phase !== this.lastPhase) {
      if (p.phase === 'KNOCKED') this.play('Hit');
      if (p.phase === 'STUMBLE') this.play('Stumble');
      this.lastPhase = p.phase;
    }
    this.shotAge += dt;
    const shotLive = this.shot && this.shotAge < (this.actions.get(this.shot)?.getClip().duration ?? 0) * .96 ? this.shot : null;
    // Lead clip: held states first, then a running one-shot, then air / idle; null = the stride blend.
    let lead: Clip | null = null;
    if (p.phase === 'FALLING') lead = 'Tumble';
    else if (p.phase === 'VALIDATING') lead = 'Brace';
    else if (p.phase === 'FINISHED' || p.phase === 'OPENING' && p.phaseTime < .48) lead = 'Cheer';
    else if (shotLive) lead = shotLive;
    else if (air) lead = 'JumpFall';
    else if (p.phase === 'KNOCKED') lead = 'Hit';
    else if (!moving) lead = 'Idle';
    const k = 1 - Math.exp(-dt * 14);
    for (const [name, action] of this.actions) {
      let target = 0;
      if (lead === 'Land') target = name === 'Land' ? .6 : name === 'Run' ? (1 - sprintClip) * .4 : name === 'Sprint' ? sprintClip * .4 : 0;
      else if (lead) target = name === lead ? 1 : 0;
      else if (p.dashing && this.actions.has('Dash')) target = name === 'Dash' ? 1 : 0;
      else if (name === 'Walk') target = walk;
      else if (name === 'Run') target = (1 - sprintClip) * (1 - walk);
      else if (name === 'Sprint') target = sprintClip * (1 - walk);
      const w = this.weights.get(name)! + (target - this.weights.get(name)!) * k;
      this.weights.set(name, w);
      action.setEffectiveWeight(w);
      if (['Walk', 'Run', 'Sprint', 'Dash'].includes(name)) action.time = this.stride * action.getClip().duration;
    }
    // Facing-driven runners (version 6) lean into the turn, not into the world's x axis.
    const turn = p.heading !== undefined ? Math.max(-1, Math.min(1, Math.atan2(Math.sin(p.heading - this.yaw), Math.cos(p.heading - this.yaw)) * 6)) : 0;
    const lateral = p.heading !== undefined ? -turn : Math.max(-1, Math.min(1, p.vx / 470));
    this.bank += ((moving ? lateral : 0) - this.bank) * (1 - Math.exp(-dt * 10));
    // Version 6: the runner faces the way it really moves (the world turns `heading` smoothly); older courses lean into the steer.
    if (p.heading !== undefined) this.yaw = p.heading;
    else this.yaw += ((moving && !air ? -Math.atan2(p.vx, Math.max(60, p.speed)) * .55 : 0) - this.yaw) * (1 - Math.exp(-dt * 10));
    this.root.rotation.set(0, this.yaw, -this.bank * .12);
    this.mixer.update(p.reduced && lead === 'Idle' ? 0 : dt);
    if (!p.reduced && dt > 0) {
      // Speeding up or rising swings the hair / scarf back (negative pitch), braking or landing swings it forward.
      const accel = (measuredSpeed - this.lastSpeed) / dt, rise = ((p.vz ?? 0) - this.lastVz) / dt;
      const push = Math.max(-1, Math.min(1, accel / 18 + (air ? .25 : 0) - rise / 9000));
      for (const t of this.trails) {
        t.vel += ((-push * .32) - t.angle) * 90 * dt - t.vel * 11 * dt;
        t.angle = Math.max(-.4, Math.min(.4, t.angle + t.vel * dt));
        t.bones.forEach((b, i) => { b.rotation.x += t.angle * t.gain * (.55 + .3 * i); });
      }
    }
    this.lastSpeed = measuredSpeed; this.lastVz = p.vz ?? 0;

    // Face: hurt on hits and falls, focused at the door or at full pace, happy squint while cheering, natural blinks.
    this.blinkAt -= dt;
    // Surprised for the first moment of a hit or a fall, then hurt; disappointed at a sealed door; happy at a correct
    // door and while cheering; concentrating at the door and at full pace; otherwise a friendly smile with blinks.
    let face: number = FACE.smile;
    if ((p.phase === 'KNOCKED' || p.phase === 'FALLING') && p.phaseTime < .3) face = FACE.surprise;
    else if (p.phase === 'KNOCKED' || p.phase === 'FALLING') face = FACE.ouch;
    else if (p.phase === 'STUMBLE') face = FACE.sad;
    else if (p.phase === 'VALIDATING' || this.sprint > .7) face = FACE.focus;
    else if (lead === 'Cheer') face = FACE.blink;
    if (this.blinkAt < 0) { if (face === FACE.smile || face === FACE.focus) face = FACE.blink; if (this.blinkAt < -.12) this.blinkAt = 2.5 + Math.random() * 2.5; }
    if (this.face) this.face.offset.y = -face / FACE_ROWS;
    if (this.castLook) {
      const mood: Mood = face === FACE.surprise ? 'surprise' : face === FACE.ouch || face === FACE.sad ? 'sad' : face === FACE.focus ? 'focus' : lead === 'Cheer' ? 'happy' : 'smile';
      this.castLook.update({ dt, reduced: p.reduced, mood, speaking: false });
    }
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    for (const m of this.materials) m.dispose();
    for (const m of this.owned) m.dispose();
    this.wardrobe?.dispose();
    this.face?.dispose();
    this.materials = [];
  }

  /** Rendering diagnostics only; no simulation or private question data. */
  animationState() {
    let clip = 'Idle', weight = -1;
    for (const [name, action] of this.actions) if (action.getEffectiveWeight() > weight) {
      clip = name; weight = action.getEffectiveWeight();
    }
    return { clip, stride: this.stride, clips: this.actions.size };
  }
}
