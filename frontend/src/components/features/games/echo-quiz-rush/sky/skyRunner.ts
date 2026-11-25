import * as THREE from 'three';

/**
 * The Skyrunner: an original semi-chibi English Coach explorer built from primitives (no imported model), with a
 * teal Echo scarf whose tails stream behind the runner — the most readable shape from a third-person camera — and a
 * satchel of pages on the back. Every limb is a pivot, so locomotion is posed procedurally from the authoritative
 * motion (distance travelled, lateral speed, phase), never from a separate clock that could slide the feet.
 */
export interface RunnerLook { hoodie: number; trim: number; hair: number; scarf: number; skin: number }
export const RUNNER_LOOKS: RunnerLook[] = [
  { hoodie: 0xf2b84b, trim: 0x8a5a12, hair: 0x4a2c1d, scarf: 0x18b5a4, skin: 0xffd8bf },
  { hoodie: 0xef7f62, trim: 0x8d3424, hair: 0x2b1b18, scarf: 0x18b5a4, skin: 0xf3c4a2 },
  { hoodie: 0x9b8ce0, trim: 0x46378f, hair: 0x2d2a4a, scarf: 0x18b5a4, skin: 0xffe1cc },
  { hoodie: 0x5aa6e6, trim: 0x1d4f86, hair: 0x5b3a26, scarf: 0x18b5a4, skin: 0xe8b48f },
  { hoodie: 0x54c49a, trim: 0x16654a, hair: 0x1f1d1a, scarf: 0x18b5a4, skin: 0xffd2b0 },
];

let gradient: THREE.DataTexture | null = null;
/** Three-band toon ramp shared by every runner (soft cel shading reads well at small sizes). */
export function toonRamp() {
  if (!gradient) {
    gradient = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
    gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
  }
  return gradient;
}

const shared = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry) {
  let g = shared.get(key);
  if (!g) { g = make(); shared.set(key, g); }
  return g;
}

export interface RunnerPose {
  phase: string; phaseTime: number; travel: number; speed: number; vx: number; dt: number; time: number;
  dashing: boolean; rushing: boolean; momentum: number; reduced: boolean;
  /** Version 6: facing (radians about the vertical, 0 = down the causeway). */
  heading?: number;
}

export class SkyRunner {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private head = new THREE.Group();
  private hips: THREE.Group[] = [];
  private knees: THREE.Group[] = [];
  private shoulders: THREE.Group[] = [];
  private elbows: THREE.Group[] = [];
  private scarf: THREE.Group[] = [];
  private materials: THREE.Material[] = [];
  private stride = 0;
  private bank = 0;
  private yaw = 0;
  private run = 0;
  private sway = 0;
  private ghostValue = 1;

  constructor(look: RunnerLook) {
    const mat = (color: number, emissive = 0) => {
      const m = new THREE.MeshToonMaterial({ color, gradientMap: toonRamp(), emissive, emissiveIntensity: emissive ? .35 : 0, transparent: true });
      this.materials.push(m);
      return m;
    };
    const hoodie = mat(look.hoodie), trim = mat(look.trim), skin = mat(look.skin), hair = mat(look.hair);
    const scarf = mat(look.scarf, 0x0a6f66), dark = mat(0x23202b), white = mat(0xffffff), shoe = mat(0xf4efe6), gold = mat(0xf5c35a, 0x6a4a10);
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = true; return o;
    };
    const limb = (r: number, l: number) => geo(`limb${r}:${l}`, () => new THREE.CapsuleGeometry(r, l, 4, 10).translate(0, -l / 2 - r * .3, 0));

    // Facing −Z (down the causeway). Feet at y = 0.
    this.root.add(this.body);
    this.body.position.y = .43;
    const torso = mesh(geo('torso', () => new THREE.CapsuleGeometry(.165, .2, 6, 14)), hoodie, 0, .2, 0);
    torso.scale.set(1, 1, .86);
    const belt = mesh(geo('belt', () => new THREE.TorusGeometry(.158, .03, 8, 20).rotateX(Math.PI / 2)), trim, 0, .1, 0);
    // Satchel of pages on the back: the camera sees it on every frame.
    const bag = mesh(geo('bag', () => new THREE.BoxGeometry(.25, .24, .12, 2, 2, 2)), trim, 0, .25, .16);
    const flap = mesh(geo('flap', () => new THREE.BoxGeometry(.26, .1, .13)), hoodie, 0, .34, .165);
    const pages = mesh(geo('pages', () => new THREE.BoxGeometry(.19, .05, .1)), white, 0, .39, .15);
    const buckle = mesh(geo('buckle', () => new THREE.BoxGeometry(.05, .05, .02)), gold, 0, .31, .232);
    this.body.add(torso, belt, bag, flap, pages, buckle);

    // Scarf ring + two streaming tails (chained pivots, follow-through from speed).
    const ring = mesh(geo('scarfRing', () => new THREE.TorusGeometry(.125, .055, 8, 20).rotateX(Math.PI / 2)), scarf, 0, .39, 0);
    this.body.add(ring);
    for (const side of [-1, 1]) {
      let parent: THREE.Object3D = this.body;
      for (let i = 0; i < 3; i++) {
        const pivot = new THREE.Group();
        pivot.position.set(i === 0 ? side * .05 : 0, i === 0 ? .37 : -.12, i === 0 ? .12 : 0);
        const piece = mesh(geo(`tail${i}`, () => new THREE.BoxGeometry(.075 - i * .01, .13, .025).translate(0, -.06, 0)), scarf);
        pivot.add(piece); parent.add(pivot); this.scarf.push(pivot); parent = pivot;
      }
    }

    // Head: large, round, friendly. Eyes face forward; the hair cap and tuft read from behind.
    this.head.position.y = .47;
    this.body.add(this.head);
    const skull = mesh(geo('skull', () => new THREE.SphereGeometry(.29, 24, 18)), skin, 0, .25, 0);
    const cap = mesh(geo('hair', () => new THREE.SphereGeometry(.305, 24, 14, 0, Math.PI * 2, 0, Math.PI * .58)), hair, 0, .27, .02);
    cap.rotation.x = .25;
    const tuft = mesh(geo('tuft', () => new THREE.ConeGeometry(.08, .2, 10)), hair, .04, .55, .06);
    tuft.rotation.set(-.6, 0, -.35);
    const fringe = mesh(geo('fringe', () => new THREE.SphereGeometry(.17, 14, 8, 0, Math.PI * 2, 0, Math.PI * .5)), hair, 0, .38, -.16);
    fringe.rotation.x = -1.1;
    this.head.add(skull, cap, tuft, fringe);
    for (const side of [-1, 1]) {
      const eye = mesh(geo('eye', () => new THREE.SphereGeometry(.045, 12, 10)), dark, side * .1, .22, -.26);
      eye.scale.set(1, 1.35, .5);
      const shine = mesh(geo('shine', () => new THREE.SphereGeometry(.014, 8, 6)), white, side * .1 + .015, .25, -.285);
      const cheek = mesh(geo('cheek', () => new THREE.SphereGeometry(.035, 10, 8)), mat(0xff9d8f), side * .17, .15, -.22);
      cheek.scale.set(1, .6, .4);
      this.head.add(eye, shine, cheek);
    }

    // Limbs. Hips and shoulders are pivots inside the body so the run bob carries them.
    for (const side of [-1, 1]) {
      const hip = new THREE.Group(); hip.position.set(side * .085, .02, 0);
      const thigh = mesh(limb(.065, .12), trim); hip.add(thigh);
      const knee = new THREE.Group(); knee.position.y = -.2; hip.add(knee);
      const shin = mesh(limb(.058, .1), trim); knee.add(shin);
      const foot = mesh(geo('foot', () => new THREE.CapsuleGeometry(.055, .08, 4, 8).rotateX(Math.PI / 2)), shoe, 0, -.2, -.035);
      knee.add(foot);
      this.body.add(hip); this.hips.push(hip); this.knees.push(knee);

      const shoulder = new THREE.Group(); shoulder.position.set(side * .2, .31, 0);
      const upper = mesh(limb(.05, .09), hoodie); shoulder.add(upper);
      const elbow = new THREE.Group(); elbow.position.y = -.15; shoulder.add(elbow);
      const fore = mesh(limb(.045, .07), hoodie); elbow.add(fore);
      const hand = mesh(geo('hand', () => new THREE.SphereGeometry(.055, 10, 8)), skin, 0, -.14, 0); elbow.add(hand);
      shoulder.rotation.z = side * .12;
      this.body.add(shoulder); this.shoulders.push(shoulder); this.elbows.push(elbow);
    }
  }

  /** Translucent spirit look for a racer who is on another checkpoint than the viewer (their doors are private). */
  setGhost(input: number) {
    const value = Math.round(input * 20) / 20;
    if (Math.abs(value - this.ghostValue) < .01) return;
    this.ghostValue = value;
    for (const m of this.materials) { m.opacity = value; m.depthWrite = value > .95; }
    this.root.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = value > .95; });
  }

  /**
   * Pose from observed motion. `travel` is world distance moved this frame (already in scene units); the stride phase
   * advances only with it, so a recoil, a server correction or a stop never fast-forwards a step.
   */
  animate(p: RunnerPose) {
    const moving = p.phase === 'RUNNING' || p.phase === 'FINISHING' || p.phase === 'OPENING' && p.phaseTime >= .48;
    const target = moving ? Math.min(1, p.speed / 260) : 0;
    const k = 1 - Math.exp(-p.dt * 9);
    this.run += (target - this.run) * k;
    const strideLength = 1.15 + .55 * this.run;
    if (moving) this.stride = (this.stride + Math.max(0, p.travel) / strideLength) % 1;
    const phi = this.stride * Math.PI * 2;
    const swing = (.5 + .45 * this.run) * (p.reduced ? .6 : 1);
    const lateral = Math.max(-1, Math.min(1, p.vx / 470));
    this.bank += ((moving ? lateral : 0) - this.bank) * (1 - Math.exp(-p.dt * 10));
    if (p.heading !== undefined) this.yaw = p.heading;
    else this.yaw += ((moving ? -Math.atan2(p.vx, Math.max(60, p.speed)) * .65 : 0) - this.yaw) * (1 - Math.exp(-p.dt * 10));

    let lean = -(.08 + .22 * this.run) - (p.dashing ? .18 : 0);
    let bob = moving ? Math.abs(Math.sin(phi)) * .05 * this.run : Math.sin(p.time * 2.4) * .008;
    let armLift = 0, celebrate = 0, recoil = 0, brace = 0;

    if (p.phase === 'STUMBLE') {
      // Knocked back off the sealed door, arms thrown up, then a determined recovery.
      const t = Math.min(1, p.phaseTime / .32), back = Math.sin(t * Math.PI) * (1 - Math.max(0, p.phaseTime - .32) / .38);
      recoil = Math.max(0, back); lean = .35 * recoil; armLift = 1.6 * recoil; bob = .04 * recoil;
    } else if (p.phase === 'VALIDATING') {
      brace = 1; lean = -.05;
    } else if (p.phase === 'OPENING' && p.phaseTime < .48) {
      celebrate = Math.sin(Math.min(1, p.phaseTime / .48) * Math.PI); bob = celebrate * .18; armLift = 2.2 * celebrate; lean = .05;
    } else if (p.phase === 'FINISHED') {
      celebrate = 1; const hop = Math.abs(Math.sin(p.time * 5)); bob = hop * .22; armLift = 2.6; lean = .08;
    }

    this.body.position.y = .43 + bob;
    this.body.rotation.set(lean, 0, -this.bank * .28);
    this.root.rotation.y = this.yaw;
    this.head.rotation.set(-lean * .45 + (brace ? -.15 : 0), 0, this.bank * .1);

    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1, leg = Math.sin(phi) * s;
      const runHip = moving ? leg * swing : 0, runKnee = moving ? .25 + .95 * Math.pow(Math.max(0, Math.sin(phi * 1 + (i ? Math.PI : 0) - 1.1)), 1.5) * this.run : .05;
      this.hips[i].rotation.x = runHip + (celebrate ? (i ? .6 : -.2) * celebrate : 0) - recoil * .4;
      this.knees[i].rotation.x = -(runKnee + celebrate * .5 + recoil * .3);
      // Index 0 is the left arm (−x): a negative z-rotation swings it outward, a positive one the right arm.
      const outward = i ? 1 : -1, arm = moving && !armLift ? -leg * swing * 1.1 : 0;
      if (brace) { this.shoulders[i].rotation.x = 1.35; this.shoulders[i].rotation.z = outward * .22; }
      else if (armLift) { this.shoulders[i].rotation.x = .2 + (celebrate ? 0 : .35); this.shoulders[i].rotation.z = outward * (.15 + Math.min(2.6, armLift) * .9) + (celebrate && !p.reduced ? outward * Math.sin(p.time * 8 + i) * .12 : 0); }
      else { this.shoulders[i].rotation.x = arm; this.shoulders[i].rotation.z = outward * .12; }
      this.elbows[i].rotation.x = brace ? .2 : moving && !armLift ? 1.25 : .3 + armLift * .1;
    }

    // Scarf follow-through: streams back with speed, flutters with a little noise, swings against steering.
    const stream = Math.min(1, p.speed / 300) * (p.reduced ? .5 : 1);
    this.sway += p.dt * (6 + 10 * stream);
    this.scarf.forEach((pivot, index) => {
      const n = index % 3, side = index < 3 ? -1 : 1;
      const flutter = p.reduced ? 0 : Math.sin(this.sway + n * 1.3 + side) * (.12 + .25 * stream);
      pivot.rotation.x = -((n === 0 ? .25 + 1.05 * stream : .22 * stream) + flutter * (n + 1) * .5);
      pivot.rotation.z = this.bank * .5 * (n + 1) * .4 + side * .06;
    });
  }

  dispose() {
    for (const m of this.materials) m.dispose();
    this.materials = [];
  }
}

/** Shared geometries live for the page; call when the last world is torn down. */
export function disposeRunnerGeometries() {
  for (const g of shared.values()) g.dispose();
  shared.clear();
  gradient?.dispose(); gradient = null;
}
