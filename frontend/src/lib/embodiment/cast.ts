import * as T from 'three';
import { skinMaterial } from './skin';
import {
  applyEyeAaaShader,
  applyHairAaaShader,
  applySkinAaaUpgrade,
  setFaceMakeupUniform,
  setHairTipUniform,
  setIrisColorUniform,
  setSkinToneUniform,
  type FaceMakeupUniformInput,
} from '@/components/study-space/world/echoLife/characterMaterials';

/**
 * What makes the cast a person rather than a body: the face (19 morph targets, artist-made FACS shapes), the eyes on their own
 * bones, the skin, the hair and how it swings. The same class on the same meshes in Study Space and Speaking Arena.
 * Everything here runs on the client from what the client already knows: nothing is sent, nothing is analysed.
 */
export type Mood =
  | 'neutral'
  | 'smile'
  | 'happy'
  | 'joy'
  | 'surprise'
  | 'surprised'
  | 'sad'
  | 'think'
  | 'listen'
  | 'focus'
  | 'focused'
  | 'sleep';

const MOODS: Record<Mood, Record<string, number>> = {
  // A face at rest is not blank: the corners of the mouth a touch up, the eyes open.
  neutral: { smile: .34 },
  smile: { smile: .8, squint: .1 },
  happy: { happy: .42, smile: .55, squint: .16 },
  joy: { happy: .58, smile: .78, squint: .22, browUp: .14 },
  surprise: { wide: .75, browUp: .85, ou: .28 },
  surprised: { wide: .78, browUp: .88, ou: .32 },
  sad: { sad: .7, browInner: .55 },
  think: { think: .65, browDown: .22, lookUp: .25 },
  listen: { smile: .22, browUp: .14, browInner: .1 },
  focus: { browDown: .16, squint: .1, lookDown: .35 },
  focused: { browDown: .28, squint: .18, lookDown: .12 },
  sleep: { 'blink.L': 1, 'blink.R': 1 },
};
const VISEMES: [string, number][] = [['aa', .75], ['ih', .6], ['ou', .55], ['ss', .5], ['uu', .45], ['mm', .7]];
const HAIR_TINT: Record<string, { hair: string; shine: string }> = {
  LYRA: { hair: '#40303f', shine: '#d6bcd8' },
  KAI: { hair: '#3a2a22', shine: '#d9b48c' },
};

interface Swing { bone: T.Bone; x: number; z: number; vx: number; vz: number; k: number; c: number; gain: number; rest: T.Quaternion | null; limit: number }
const q = new T.Quaternion(), e = new T.Euler(), v1 = new T.Vector3(), v2 = new T.Vector3();

export interface LookFrame {
  dt: number;
  /** Optional wall-clock delta used to converge facial morphs when simulation time (`dt`) is frozen at 0 (e.g. Photo Studio). */
  liveDt?: number;
  reduced: boolean;
  mood: Mood;
  speaking: boolean;
  /** Where the owner looks, relative to the body. Radians. */
  lookYaw?: number;
  lookPitch?: number;
}

export class CastLook {
  readonly materials: T.Material[] = [];
  private hideable: T.Material[] = [];
  private face: T.Mesh | null = null;
  private faceMaterial: T.MeshPhysicalMaterial | null = null;
  private eyeMaterial: T.MeshPhysicalMaterial | null = null;
  private hairMesh: T.Mesh | null = null;
  private keys = new Map<string, number>();
  private wanted: Float32Array = new Float32Array(0);
  private sculptWeights: Float32Array = new Float32Array(0);
  private isSculptIndex: Uint8Array = new Uint8Array(0);
  private eyes: { bone: T.Bone; rest: T.Quaternion }[] = [];
  private swings: Swing[] = [];
  private head: T.Bone | null = null;
  private hairMaterial: T.MeshPhysicalMaterial | null = null;
  private externalHairMaterials: T.Material[] = [];
  private currentHairHex: string;
  private currentHairTipHex = '#ffffff';
  private currentHairTipMix = 0;
  private lastHead = new T.Vector3();
  private lastVelocity = new T.Vector3();
  private seeded = false;
  private ownView = false;
  private mirrorObserved = false;
  private externalHairPhysics = false;
  private time = 0;
  private blinkAt = 1.4 + Math.random() * 2.5;
  private blinkT = -1;
  private blinkStagger = 0.008;
  private secondBlink = false;
  private saccadeAt = .8;
  private gaze = { x: 0, z: 0, tx: 0, tz: 0 };
  private visemeAt = 0;
  private viseme = 0;
  private visemeLevel = 0;

  constructor(readonly model: T.Object3D, hero: 'LYRA' | 'KAI' | string) {
    const tint = HAIR_TINT[hero] ?? HAIR_TINT.LYRA;
    this.currentHairHex = tint.hair;
    model.traverse(o => {
      const mesh = o as T.Mesh;
      if ((o as T.Bone).isBone) {
        const name = (o.userData.name as string | undefined) ?? o.name, bone = o as T.Bone;
        bone.scale.set(1, 1, 1);
        if (name === 'head') this.head = bone;
        if (name === 'eye.L' || name === 'eye.R') this.eyes.push({ bone, rest: bone.quaternion.clone() });
        if (/^pony\.\d$/.test(name)) this.swings.push({ bone, x: 0, z: 0, vx: 0, vz: 0, k: 26, c: 5.5, gain: .010 + .004 * Number(name.slice(-1)), rest: null, limit: .55 });
        if (name === 'side.L' || name === 'side.R') this.swings.push({ bone, x: 0, z: 0, vx: 0, vz: 0, k: 62, c: 7, gain: .013, rest: bone.quaternion.clone(), limit: .42 });
        if (name === 'fringe') this.swings.push({ bone, x: 0, z: 0, vx: 0, vz: 0, k: 90, c: 9, gain: .006, rest: bone.quaternion.clone(), limit: .22 });
        return;
      }
      if (!mesh.isMesh) return;
      const source = mesh.material as T.MeshStandardMaterial;
      if (mesh.name.startsWith('Cast_Face')) {
        const skin = skinMaterial(source, { face: true });
        applySkinAaaUpgrade(skin, true);
        mesh.material = skin; this.face = mesh; this.faceMaterial = skin; this.materials.push(skin); this.hideable.push(skin);
        const names = mesh.morphTargetDictionary ?? {};
        const count = mesh.morphTargetInfluences?.length ?? 0;
        this.wanted = new Float32Array(count);
        this.sculptWeights = new Float32Array(count);
        this.isSculptIndex = new Uint8Array(count);
        for (const [k, i] of Object.entries(names)) {
          this.keys.set(k, i);
          if (i < count && (k.startsWith('sculpt_') || i >= 19)) {
            this.isSculptIndex[i] = 1;
          }
        }
      } else if (mesh.name.startsWith('Cast_Eyes')) {
        // Wet corneal highlight + concave iris depth; zero flat emissive washout on pupils
        const eye = new T.MeshPhysicalMaterial({
          name: 'Eye',
          map: source.map,
          roughness: .055,
          metalness: 0,
          clearcoat: 1,
          clearcoatRoughness: .025,
          ior: 1.38,
          specularIntensity: 1.0,
          envMapIntensity: 1.22,
          emissive: new T.Color('#000000'),
          emissiveIntensity: 0,
        });
        applyEyeAaaShader(eye);
        mesh.material = eye; this.eyeMaterial = eye; this.materials.push(eye); this.hideable.push(eye); mesh.castShadow = false; mesh.receiveShadow = false;
      } else if (mesh.name.startsWith('Cast_Hair')) {
        if (!mesh.geometry.getAttribute('tangent') && mesh.geometry.getAttribute('uv') && mesh.geometry.index) mesh.geometry.computeTangents();
        const hairColor = new T.Color(tint.hair);
        // Warm dark hair-tinted specular (never pure white 0xffffff!) — eliminates harsh white specular stripes on Lyra's ponytail
        const hairGlint = hairColor.clone().multiplyScalar(0.55).lerp(new T.Color('#5a4030'), 0.35);
        const hair = new T.MeshPhysicalMaterial({
          name: 'Hair',
          map: source.map,
          color: hairColor,
          vertexColors: true,
          roughness: .58,
          metalness: 0,
          anisotropy: .24,
          anisotropyRotation: Math.PI * 0.5,
          specularIntensity: .22,
          specularColor: hairGlint,
          sheen: .08,
          sheenRoughness: .78,
          sheenColor: hairColor.clone().lerp(new T.Color('#6b4d3b'), 0.28),
          envMapIntensity: .32,
          polygonOffset: true,
          polygonOffsetFactor: -0.5,
          polygonOffsetUnits: -1,
        });
        applyHairAaaShader(hair, { vertexSway: false });
        mesh.material = hair; this.hairMesh = mesh; this.hairMaterial = hair; this.materials.push(hair); this.hideable.push(hair);
      }
    });
    for (const s of this.swings) if (!s.rest) s.rest = null;
  }

  /** Mesh names this class owns: the caller's material loops leave them alone. */
  static owns(mesh: T.Object3D) { return /^Cast_(Face|Eyes|Hair)/.test(mesh.name); }

  /** When an external XPBD solver (`SecondaryPhysics`) drives ponytail & side locks, pause internal 2-DOF Euler swing. */
  setExternalHairPhysics(enabled: boolean) { this.externalHairPhysics = enabled; }

  /** The scarf and anything else the caller wants left out of the owner's view, its shadow kept. */
  hideInOwnView(material: T.Material) { this.hideable.push(material); if (this.ownView) this.apply(material, true); }

  private apply(material: T.Material, hidden: boolean) {
    // Not drawn, still casting: the shadow pass does not look at these two, so the shadow keeps its head.
    material.colorWrite = !hidden; material.depthWrite = !hidden;
  }
  setOwnView(on: boolean) {
    if (on === this.ownView) return;
    this.ownView = on;
    for (const m of this.hideable) this.apply(m, on);
  }

  /** When true while in 1st-person (`ownView`), keeps facial blinks, saccades, and morphs updating for planar mirror reflections. */
  setMirrorObserved(observed: boolean): void {
    this.mirrorObserved = Boolean(observed);
  }

  get isMirrorObserved(): boolean {
    return this.mirrorObserved;
  }

  private applyColorToHairMaterial(mat: T.Material, hex: string) {
    if (!(mat instanceof T.MeshStandardMaterial)) return;
    mat.color.set(hex);
    if (mat instanceof T.MeshPhysicalMaterial) {
      mat.specularColor.copy(mat.color).multiplyScalar(0.55).lerp(new T.Color('#5a4030'), 0.35);
      mat.sheenColor.copy(mat.color).lerp(new T.Color('#6b4d3b'), 0.28);
    }
  }

  setHairColor(hex: string) {
    this.currentHairHex = hex;
    if (this.hairMaterial) this.applyColorToHairMaterial(this.hairMaterial, hex);
    for (const m of this.externalHairMaterials) this.applyColorToHairMaterial(m, hex);
  }

  setHairTipColor(hex: string, mix: number) {
    this.currentHairTipHex = hex;
    this.currentHairTipMix = T.MathUtils.clamp(mix, 0, 1);
    if (this.hairMaterial) setHairTipUniform(this.hairMaterial, this.currentHairTipHex, this.currentHairTipMix);
    for (const m of this.externalHairMaterials) setHairTipUniform(m, this.currentHairTipHex, this.currentHairTipMix);
  }

  /** Persistent Wave 11 anatomical face sculpt weights (`sculpt_*`, morph indices 19..38). */
  setFaceSculpt(weights: Partial<Record<string, number>>) {
    if (!this.face || !this.face.morphTargetInfluences) return;
    const influences = this.face.morphTargetInfluences;
    for (const [k, rawVal] of Object.entries(weights)) {
      const idx = this.keys.get(k);
      if (idx === undefined || idx >= this.sculptWeights.length) continue;
      const val = typeof rawVal === 'number' && Number.isFinite(rawVal) ? T.MathUtils.clamp(rawVal, -1, 1) : 0;
      this.sculptWeights[idx] = val;
      this.isSculptIndex[idx] = 1;
      influences[idx] = val;
    }
  }

  setSkinTone(hex: string) {
    setSkinToneUniform(this.faceMaterial, hex);
  }

  setIrisColor(hex: string, mix = 0.88) {
    setIrisColorUniform(this.eyeMaterial, hex, mix);
  }

  setFaceMakeup(makeup: FaceMakeupUniformInput) {
    setFaceMakeupUniform(this.faceMaterial, makeup);
  }

  setBuiltinHairVisible(visible: boolean) {
    if (this.hairMesh) this.hairMesh.visible = visible;
  }

  /** Registers/unregisters a modular `Wear_hair` group so 1st-person hides it cleanly while keeping shadows & color sync. */
  bindExternalHair(group: T.Object3D | null) {
    for (const old of this.externalHairMaterials) {
      this.hideable = this.hideable.filter(m => m !== old);
      this.apply(old, false);
    }
    this.externalHairMaterials = [];
    if (!group) return;
    group.traverse(o => {
      const mesh = o as T.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m || this.externalHairMaterials.includes(m)) continue;
        this.externalHairMaterials.push(m);
        this.hideable.push(m);
        this.applyColorToHairMaterial(m, this.currentHairHex);
        setHairTipUniform(m, this.currentHairTipHex, this.currentHairTipMix);
        if (this.ownView) this.apply(m, true);
      }
    });
  }

  /** Height of the eyes above the model's origin and how far forward of the head bone, measured from the skeleton. */
  eyeOffset(out = new T.Vector3()) {
    const [a, b] = this.eyes;
    if (!a || !b || !this.head) return null;
    a.bone.getWorldPosition(v1); b.bone.getWorldPosition(v2);
    out.copy(v1).add(v2).multiplyScalar(.5);
    return this.model.worldToLocal(out);
  }

  private add(name: string, w: number) {
    const i = this.keys.get(name);
    if (i !== undefined && !this.isSculptIndex[i]) this.wanted[i] = Math.min(1, this.wanted[i] + w);
  }

  update(f: LookFrame) {
    const dt = Math.max(0, Math.min(f.dt, .05));
    const frozen = dt <= 1e-5;
    const morphDt = !frozen ? dt : f.liveDt !== undefined && f.liveDt > 1e-5 ? Math.min(f.liveDt, .05) : 0;
    this.time += dt;
    if (!this.externalHairPhysics) this.swingHair(dt, f.reduced);
    // Through one's own eyes there is no face to draw unless observed in a planar mirror.
    if (!this.face || (this.ownView && !this.mirrorObserved)) return;
    for (let i = 0; i < this.wanted.length; i++) {
      this.wanted[i] = this.isSculptIndex[i] ? this.sculptWeights[i] : 0;
    }
    const mood = MOODS[f.mood] ?? MOODS.neutral;
    for (const k in mood) this.add(k, mood[k]);
    // Asymmetric natural blinking (6–14 ms L/R stagger + crisp 55 ms close / 115 ms ease-out open).
    if (frozen) {
      this.blinkT = -1;
    } else if (f.mood !== 'sleep' && !f.reduced) {
      if (this.blinkT < 0 && this.time > this.blinkAt) {
        this.blinkT = 0;
        this.secondBlink = Math.random() < .14;
        this.blinkStagger = (Math.random() < .5 ? 1 : -1) * (0.006 + Math.random() * 0.008);
      }
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        const closing = .055, opening = .115, total = closing + opening;
        const evalLid = (t: number) => {
          if (t <= 0 || t >= total) return 0;
          if (t < closing) return t / closing;
          const u = (t - closing) / opening;
          return 1 - u * u * (3 - 2 * u);
        };
        const tL = this.blinkT - Math.max(0, this.blinkStagger);
        const tR = this.blinkT - Math.max(0, -this.blinkStagger);
        if (this.blinkT >= total + Math.abs(this.blinkStagger)) {
          this.blinkT = -1;
          this.blinkAt = this.time + (this.secondBlink ? .14 : 1.9 + Math.random() * 3.4);
          this.secondBlink = false;
        } else {
          this.add('blink.L', evalLid(tL));
          this.add('blink.R', evalLid(tR));
        }
      }
      // Subtle eyelid-gaze vertical coupling (looking down slightly lowers upper lids; looking up lifts brows)
      const pitch = f.lookPitch ?? 0;
      if (pitch < -0.05) {
        const droop = T.MathUtils.clamp(-pitch / 0.45, 0, 1) * 0.28;
        this.add('blink.L', droop);
        this.add('blink.R', droop);
        this.add('lookDown', droop * 1.1);
      } else if (pitch > 0.08) {
        this.add('browUp', T.MathUtils.clamp(pitch / 0.42, 0, 1) * 0.16);
      }
    }
    // Talking: the mouth goes through shapes at the pace of speech, with small pauses. The voice itself is never analysed.
    if (!frozen && f.speaking && !f.reduced) {
      if (this.time > this.visemeAt) {
        this.viseme = Math.floor(Math.random() * VISEMES.length);
        const rest = Math.random() < .12;
        this.visemeLevel = rest ? 0 : .55 + Math.random() * .45;
        this.visemeAt = this.time + (rest ? .16 + Math.random() * .16 : .075 + Math.random() * .085);
      }
      const [name, weight] = VISEMES[this.viseme];
      this.add(name, weight * this.visemeLevel);
      this.add('browUp', .08 * this.visemeLevel);
    }
    const keys = this.face.morphTargetInfluences!;
    const instant = f.reduced || morphDt <= 0;
    const mouth = instant ? 1 : 1 - Math.exp(-(f.speaking ? 22 : 9) * morphDt);
    const lids = instant ? 1 : 1 - Math.exp(-46 * morphDt);
    const slow = instant ? 1 : 1 - Math.exp(-(frozen ? 12 : 7) * morphDt);
    const lidA = this.keys.get('blink.L'), lidB = this.keys.get('blink.R');
    for (let i = 0; i < keys.length; i++) {
      if (this.isSculptIndex[i]) {
        keys[i] = this.sculptWeights[i];
        continue;
      }
      const a = instant ? 1 : i === lidA || i === lidB ? lids : VISEME_INDEX(this.keys, i) ? mouth : slow;
      keys[i] += (this.wanted[i] - keys[i]) * a;
    }
    // The eyes: small quick moves, and they lead the head towards where it is going.
    if (!f.reduced && !frozen) {
      if (this.time > this.saccadeAt) {
        this.gaze.tx = (Math.random() - .5) * .07 + (f.lookPitch ?? 0) * .18;
        this.gaze.tz = (Math.random() - .5) * .12 + (f.lookYaw ?? 0) * .22;
        this.saccadeAt = this.time + .6 + Math.random() * 2.6;
      }
      const s = 1 - Math.exp(-38 * dt);
      this.gaze.x += (this.gaze.tx - this.gaze.x) * s; this.gaze.z += (this.gaze.tz - this.gaze.z) * s;
    } else if (frozen) {
      const s = instant ? 1 : 1 - Math.exp(-18 * morphDt);
      this.gaze.x += (0 - this.gaze.x) * s;
      this.gaze.z += (0 - this.gaze.z) * s;
    }
    e.set(T.MathUtils.clamp(this.gaze.x, -.3, .3), 0, T.MathUtils.clamp(this.gaze.z, -.42, .42));
    q.setFromEuler(e);
    if (this.head) this.head.scale.set(1, 1, 1);
    for (const eye of this.eyes) {
      eye.bone.scale.set(1, 1, 1);
      eye.bone.quaternion.copy(eye.rest).multiply(q);
    }
  }

  /** The tail and the side locks answer the head's acceleration on small springs. One stiff step per frame, nothing simulated beyond that. */
  private swingHair(dt: number, reduced: boolean) {
    const hairOverrides = this.model.userData.__ecHairRigOverrides as
      | ReadonlyMap<string, { position: T.Vector3; quaternion: T.Quaternion }>
      | undefined;
    for (const s of this.swings) s.bone.scale.set(1, 1, 1);
    if (hairOverrides) {
      for (const s of this.swings) {
        const bName = (s.bone.userData.name as string | undefined) ?? s.bone.name;
        const ov = hairOverrides.get(bName);
        if (ov) {
          s.bone.position.copy(ov.position);
          s.bone.quaternion.copy(ov.quaternion);
        }
      }
    }
    if (!this.head || !this.swings.length || dt <= 0) return;
    this.head.getWorldPosition(v1);
    if (!this.seeded) { this.lastHead.copy(v1); this.seeded = true; }
    const velocity = v2.copy(v1).sub(this.lastHead).divideScalar(Math.max(dt, .001));
    this.lastHead.copy(v1);
    const ax = reduced ? 0 : T.MathUtils.clamp((velocity.x - this.lastVelocity.x) / dt, -30, 30);
    const az = reduced ? 0 : T.MathUtils.clamp((velocity.z - this.lastVelocity.z) / dt, -30, 30);
    const ay = reduced ? 0 : T.MathUtils.clamp((velocity.y - this.lastVelocity.y) / dt, -30, 30);
    this.lastVelocity.copy(velocity);
    // Into the head's own frame.
    this.head.getWorldQuaternion(q).invert();
    v1.set(ax, ay, az).applyQuaternion(q);
    for (const s of this.swings) {
      const steps = 2, h = dt / steps;
      for (let i = 0; i < steps; i++) {
        s.vx += (-s.k * s.x - s.c * s.vx + v1.z * s.gain * s.k) * h; s.x += s.vx * h;
        s.vz += (-s.k * s.z - s.c * s.vz - v1.x * s.gain * s.k) * h; s.z += s.vz * h;
      }
      s.x = T.MathUtils.clamp(s.x, -s.limit, s.limit); s.z = T.MathUtils.clamp(s.z, -s.limit, s.limit);
      if (Math.abs(s.x) + Math.abs(s.z) < 1e-4 && !s.rest) continue;
      e.set(s.x, 0, s.z); q.setFromEuler(e);
      if (s.rest) s.bone.quaternion.copy(s.rest).multiply(q);
      else s.bone.quaternion.multiply(q);          // The clip holds the pony's pose; HumanRig restores it before every mixer pass.
    }
  }
}

const MOUTH_KEYS = new Set(['aa', 'ih', 'ou', 'uu', 'mm', 'ss']);
function VISEME_INDEX(keys: Map<string, number>, index: number) {
  for (const name of MOUTH_KEYS) if (keys.get(name) === index) return true;
  return false;
}
