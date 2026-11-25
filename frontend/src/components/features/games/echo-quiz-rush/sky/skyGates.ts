import * as THREE from 'three';
import { wrapGateText } from '../rushPresentation';
import { LANE_COLORS, SCENE, laneX, doorHalfWidth } from './skyScale';

/**
 * Knowledge Walls. One wall spans the whole causeway at a checkpoint plane; it has one arched doorway per answer,
 * cut exactly where the authority's collision opening is (`doorHalfWidth` = opening + runner radius), so the stone
 * the runner bumps into is the stone the player sees. Crystal leaves seal each doorway until the server opens one.
 */
export type WallKind = 'normal' | 'milestone' | 'grand';
const HEIGHT: Record<WallKind, number> = { normal: 2.75, milestone: 3.2, grand: 3.7 };
const SPRING = 1.42; // straight jamb height before the arch begins

const shapeCache = new Map<string, THREE.ExtrudeGeometry>();
let stoneTexture: THREE.CanvasTexture | null = null;

function stone() {
  if (stoneTexture) return stoneTexture;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#cdb48c'; g.fillRect(0, 0, 256, 256);
  // Coursed ashlar: offset rows of softly shaded blocks with mortar lines.
  for (let row = 0; row < 8; row++) {
    const h = 32, off = row % 2 ? 32 : 0;
    for (let col = -1; col < 5; col++) {
      const x = col * 64 + off, y = row * h, tint = 192 + ((row * 7 + col * 13) % 5) * 9;
      g.fillStyle = `rgb(${tint + 22},${tint + 2},${tint - 40})`; g.fillRect(x + 2, y + 2, 60, h - 4);
      g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(x + 3, y + 3, 58, 4);
      g.fillStyle = 'rgba(120,90,50,.14)'; g.fillRect(x + 3, y + h - 7, 58, 4);
    }
  }
  stoneTexture = new THREE.CanvasTexture(c);
  stoneTexture.wrapS = stoneTexture.wrapT = THREE.RepeatWrapping;
  stoneTexture.colorSpace = THREE.SRGBColorSpace;
  stoneTexture.anisotropy = 4;
  return stoneTexture;
}

/**
 * One shared copy per stone image and repeat. Cloning a texture marks its image for upload again (three's copy() sets
 * needsUpdate on the shared source), so a clone per wall re-sent the stone maps to the GPU on the very frame a new wall
 * appeared — right after a gate was crossed. Walls never dispose these; disposeGateCaches does.
 */
const sharedStone = new Map<string, THREE.Texture>();
function stoneCopy(source: THREE.Texture, repeat: number) {
  const key = `${source.uuid}:${repeat}`; let t = sharedStone.get(key);
  if (!t) { t = source.clone(); t.repeat.set(repeat, repeat); sharedStone.set(key, t); }
  return t;
}

function archPath(path: THREE.Path, cx: number, w: number) {

  path.moveTo(cx - w, -.01);
  path.lineTo(cx - w, SPRING);
  path.absarc(cx, SPRING, w, Math.PI, 0, true);
  path.lineTo(cx + w, -.01);
  path.lineTo(cx - w, -.01);
}

function wallGeometry(gates: number, kind: WallKind, spacing: number, margin = 0) {
  const key = `${gates}:${kind}:${spacing > 1100}:${margin.toFixed(2)}`;
  let g = shapeCache.get(key);
  if (g) return g;
  // A sliding wall is wider by its slide on both sides, so no gap ever opens beside it (its physics spans the road).
  const half = SCENE.roadHalf + .35 + margin, top = HEIGHT[kind];
  const shape = new THREE.Shape();
  shape.moveTo(-half, -.3); shape.lineTo(half, -.3); shape.lineTo(half, top);
  // A gentle crenellated crown.
  const merlons = 12;
  for (let i = merlons; i > 0; i--) {
    const x1 = -half + (i / merlons) * half * 2, x0 = x1 - half * 2 / merlons;
    shape.lineTo(x1, top + .22); shape.lineTo(x1 - (x1 - x0) * .55, top + .22); shape.lineTo(x1 - (x1 - x0) * .55, top); shape.lineTo(x0, top);
  }
  shape.lineTo(-half, -.3);
  for (let i = 0; i < gates; i++) {
    const hole = new THREE.Path(); archPath(hole, laneX(i, gates), doorHalfWidth(gates, spacing)); shape.holes.push(hole);
  }
  g = new THREE.ExtrudeGeometry(shape, { depth: .5, bevelEnabled: true, bevelSize: .035, bevelThickness: .035, bevelSegments: 2, curveSegments: 18 });
  g.translate(0, 0, -.25);
  shapeCache.set(key, g);
  return g;
}

const membraneVertex = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const membraneFragment = /* glsl */`
uniform vec3 uColor; uniform float uTime; uniform float uOpen; uniform float uReject; uniform float uTried; uniform float uAim; uniform float uSpring;
varying vec2 vUv;
void main(){
  // Arch mask in door space: x in [-1,1], y from 0 (threshold) up.
  vec2 p = vec2(vUv.x * 2.0 - 1.0, vUv.y * (uSpring + 1.0));
  float inside = p.y < uSpring ? 1.0 - step(1.0, abs(p.x)) : 1.0 - step(1.0, length(vec2(p.x, p.y - uSpring)));
  if (inside < .5) discard;
  float t = uTime;
  float swirl = sin(p.x * 6.0 + t * 1.7 + sin(p.y * 4.0 - t)) * .5 + .5;
  float rings = sin(length(p - vec2(0.0, uSpring * .7)) * 9.0 - t * 2.6) * .5 + .5;
  float edge = smoothstep(.72, 1.0, max(abs(p.x), p.y > uSpring ? length(vec2(p.x, p.y - uSpring)) : 0.0));
  vec3 base = mix(uColor * .55, uColor * 1.35 + .15, swirl * .55 + rings * .25);
  base = mix(base, vec3(1.0, .97, .85), edge * .45 + uAim * .25);
  vec3 red = vec3(1.0, .25, .3);
  base = mix(base, red, clamp(uReject + uTried * .55, 0.0, 1.0));
  float alpha = (.42 + .3 * swirl + .25 * edge + uAim * .15) * (1.0 - uOpen);
  // Opening: a bright dissolve sweeping up from the threshold.
  float sweep = smoothstep(uOpen * (uSpring + 1.2) - .25, uOpen * (uSpring + 1.2), p.y);
  alpha *= mix(1.0, sweep, step(.001, uOpen));
  base += vec3(1.0, .95, .7) * (1.0 - sweep) * uOpen * 2.0;
  gl_FragColor = vec4(base, clamp(alpha, 0.0, .95));
}`;

interface Door {
  frame: THREE.Mesh; membrane: THREE.Mesh; uniforms: Record<string, THREE.IUniform>;
  leaves: THREE.Group[]; banner: THREE.Mesh; bannerKey: string; seal: THREE.Mesh;
}

export interface WallState {
  labels: string[] | null; monospace: boolean; openGate: number; openProgress: number;
  rejected: number; rejectAge: number; tried: number[]; aim: number; time: number; reduced: boolean;
  /** Rising gates: 0 → 1 as the racer crosses the 720-unit approach where the sill will climb (amber warning). */
  warning?: number;
  /** Version 6: the door the player marked (steady gold rim; never moves anyone). */
  marked?: number;
}

/** Version 6 motion parts of a wall: slide margin (scene units), timed shutters, approach wheels. */
export interface WallMotion { margin: number; shutters: boolean; wheels: boolean }
/** Shared art for the motion parts (props6.glb), with stand-ins until it loads. */
let motionArt: { shutter: THREE.Object3D | null; wheel: THREE.Object3D | null; tower?: THREE.Object3D | null } = { shutter: null, wheel: null };
export function setWallMotionArt(art: typeof motionArt) { motionArt = art; }

export class KnowledgeWall {
  readonly group = new THREE.Group();
  readonly gates: number;
  readonly kind: WallKind;
  private doors: Door[] = [];
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private bodyMaterial: THREE.MeshStandardMaterial;
  private rise = 0;
  private lift = 0;
  private fade = 0;
  private towersCrystal: THREE.Mesh[] = [];
  private warnBand: THREE.Mesh | null = null;
  /** The authored ashlar stone (texture generator), shared by every wall once loaded. */
  private static stoneArt: { albedo: THREE.Texture; normal: THREE.Texture } | null = null;
  static setStone(albedo: THREE.Texture, normal: THREE.Texture) { KnowledgeWall.stoneArt = { albedo, normal }; }

  private shutters: THREE.Object3D[] = [];
  private wheels: THREE.Object3D[] = [];
  private shutterHeight = 0;
  constructor(gates: number, kind: WallKind, private font: string, spacing = 2800, readonly rising = false, readonly motion: WallMotion | null = null) {
    this.gates = gates; this.kind = kind;
    const art = KnowledgeWall.stoneArt;
    const tex = stoneCopy(art ? art.albedo : stone(), art ? .16 : .42);
    this.bodyMaterial = new THREE.MeshStandardMaterial({ map: tex, color: kind === 'grand' ? 0xf3e6c8 : 0xffffff, roughness: .82, metalness: .02 });
    if (art) { this.bodyMaterial.normalMap = stoneCopy(art.normal, .16); this.bodyMaterial.normalScale.set(.8, .8); }
    this.materials.push(this.bodyMaterial);
    const margin = motion?.margin ?? 0;
    const body = new THREE.Mesh(wallGeometry(gates, kind, spacing, margin), this.bodyMaterial);
    body.castShadow = true; body.receiveShadow = true; this.group.add(body);
    const gold = new THREE.MeshStandardMaterial({ color: 0xf2c66d, metalness: .65, roughness: .3, emissive: 0x5a3a08, emissiveIntensity: .35 });
    this.materials.push(gold);
    const top = HEIGHT[kind], w = doorHalfWidth(gates, spacing);

    for (let i = 0; i < gates; i++) {
      const cx = laneX(i, gates), color = new THREE.Color(LANE_COLORS[i % LANE_COLORS.length]);
      // Lane-coloured arch frame: half torus + two jambs, so every door's colour matches its HUD choice.
      const frameMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .55, metalness: .3, roughness: .35 });
      this.materials.push(frameMat);
      const arch = new THREE.TorusGeometry(w + .07, .065, 8, 28, Math.PI);
      const frame = new THREE.Mesh(arch, frameMat); frame.position.set(cx, SPRING, .27);
      for (const side of [-1, 1]) {
        const jamb = new THREE.Mesh(new THREE.CylinderGeometry(.065, .065, SPRING, 8), frameMat);
        jamb.position.set(side * (w + .07), -SPRING / 2, 0); frame.add(jamb);
      }
      this.group.add(frame);

      const uniforms = {
        uColor: { value: color }, uTime: { value: 0 }, uOpen: { value: 0 }, uReject: { value: 0 }, uTried: { value: 0 }, uAim: { value: 0 }, uSpring: { value: SPRING / w },
      };
      const membraneMat = new THREE.ShaderMaterial({ uniforms, vertexShader: membraneVertex, fragmentShader: membraneFragment, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      this.materials.push(membraneMat);
      const membrane = new THREE.Mesh(new THREE.PlaneGeometry(w * 2, SPRING + w).translate(0, (SPRING + w) / 2, 0), membraneMat);
      membrane.position.set(cx, 0, .2); this.group.add(membrane);

      // Two crystal leaves hinged at the jambs; the correct one swings away from the runner.
      const leafMat = new THREE.MeshStandardMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), .35), transparent: true, opacity: .55, metalness: .2, roughness: .15, emissive: color, emissiveIntensity: .25 });
      this.materials.push(leafMat);
      const leaves: THREE.Group[] = [];
      for (const side of [-1, 1]) {
        // Each leaf is a quarter-arch: local x runs from its hinge (0) to the door centre (-side * w).
        const hinge = new THREE.Group(); hinge.position.set(cx + side * w, 0, .05);
        const s = new THREE.Shape();
        s.moveTo(0, 0); s.lineTo(-side * w, 0); s.lineTo(-side * w, SPRING + w);
        for (let k = 0; k <= 10; k++) { const a = Math.PI / 2 * (k / 10); s.lineTo(-side * w + side * Math.sin(a) * w, SPRING + Math.cos(a) * w); }
        s.lineTo(0, 0);
        const leaf = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: .06, bevelEnabled: false }), leafMat);
        hinge.add(leaf); this.group.add(hinge); leaves.push(hinge);
      }

      // A red seal shown on doors the server already rejected for this question.
      const sealMat = new THREE.MeshBasicMaterial({ color: 0xff5468, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
      this.materials.push(sealMat);
      const sealGeo = new THREE.RingGeometry(w * .34, w * .46, 32);
      const seal = new THREE.Mesh(sealGeo, sealMat); seal.position.set(cx, SPRING * .78, .3);
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(w * .9, w * .1), sealMat); bar.rotation.z = Math.PI / 4; seal.add(bar);
      this.group.add(seal);

      const bannerMat = new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, depthWrite: false });
      this.materials.push(bannerMat);
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bannerMat);
      banner.position.set(cx, top + .9, .5); banner.renderOrder = 3;
      this.group.add(banner);
      this.doors.push({ frame, membrane, uniforms, leaves, banner, bannerKey: '', seal });
      if (motion?.shutters) {
        // A crystal portcullis per doorway, rising from below the threshold; all doors move together.
        const h = SPRING + w + .05; this.shutterHeight = h;
        let shutter: THREE.Object3D;
        if (motionArt.shutter) { shutter = motionArt.shutter.clone(); shutter.scale.set(w * 2 / 1.2, h / 2.2, 1); shutter.traverse(o => { o.userData.shared = true; const mesh = o as THREE.Mesh; if (mesh.isMesh) { mesh.material = (mesh.material as THREE.Material).clone(); this.materials.push(mesh.material as THREE.Material); } }); }
        else {
          const bars = new THREE.Group(), barMat = new THREE.MeshStandardMaterial({ color: 0xbfe8ff, emissive: color, emissiveIntensity: .5, metalness: .3, roughness: .2, transparent: true, opacity: .82 });
          this.materials.push(barMat);
          for (let k = 0; k < 5; k++) { const bar = new THREE.Mesh(new THREE.BoxGeometry(.08, h, .08), barMat); bar.position.set(-w + .1 + k * (w * 2 - .2) / 4, h / 2, 0); bars.add(bar); }
          const rail = new THREE.Mesh(new THREE.BoxGeometry(w * 2, .1, .1), barMat); rail.position.y = h * .55; bars.add(rail);
          shutter = bars;
        }
        shutter.position.set(cx, -h, .12); this.group.add(shutter); this.shutters.push(shutter);
      }
    }
    if (motion?.wheels) {
      // Bronze drive wheels under the wall show it is a machine that moves (they roll with its travel).
      const wheelMat = new THREE.MeshStandardMaterial({ color: 0xc99a4a, metalness: .8, roughness: .35 }); this.materials.push(wheelMat);
      for (let k = 0; k <= gates; k++) for (const zSide of [-1, 1]) {
        const x = -SCENE.roadHalf + k * SCENE.roadHalf * 2 / gates;
        const wheel = motionArt.wheel ? motionArt.wheel.clone() : new THREE.Mesh(new THREE.CylinderGeometry(.32, .32, .16, 18).rotateZ(Math.PI / 2), wheelMat);
        if (motionArt.wheel) wheel.traverse(o => { o.userData.shared = true; const mesh = o as THREE.Mesh; if (mesh.isMesh) { mesh.material = (mesh.material as THREE.Material).clone(); this.materials.push(mesh.material as THREE.Material); } });
        wheel.position.set(Math.max(-SCENE.roadHalf + .2, Math.min(SCENE.roadHalf - .2, x)), .3, zSide * .36); this.group.add(wheel); this.wheels.push(wheel);
      }
    }

    // End towers with floating crystals (taller for milestone / grand walls).
    const towerMat = new THREE.MeshStandardMaterial({ map: tex, color: 0xf6ead2, roughness: .8 });
    const roofMat = new THREE.MeshStandardMaterial({ color: kind === 'normal' ? 0x2f8f8a : kind === 'milestone' ? 0x6b56c9 : 0xd9a53a, roughness: .5, metalness: .2 });
    const crystalMat = new THREE.MeshStandardMaterial({ color: kind === 'grand' ? 0xffe39a : 0x9ff3ff, emissive: kind === 'grand' ? 0xffb340 : 0x3fd6e6, emissiveIntensity: 1.4, roughness: .1, metalness: .1, transparent: true, opacity: .92 });
    this.materials.push(towerMat, roofMat, crystalMat);
    for (const side of [-1, 1]) {
      const h = top + (kind === 'normal' ? .8 : 1.6);
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(.48, .58, h, 10), towerMat);
      tower.position.set(side * (SCENE.roadHalf + .7 + margin), h / 2 - .3, 0); tower.castShadow = true;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(.66, .9, 10), roofMat); roof.position.y = h / 2 + .45; tower.add(roof);
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(kind === 'grand' ? .42 : .3, 0), crystalMat);
      crystal.position.y = h / 2 + 1.35; tower.add(crystal); this.towersCrystal.push(crystal);
      const band = new THREE.Mesh(new THREE.TorusGeometry(.52, .05, 6, 20), gold); band.rotation.x = Math.PI / 2; band.position.y = h / 2 - .2; tower.add(band);
      if (motionArt.tower) {
        const authored = motionArt.tower.clone(); authored.position.set(tower.position.x, -.3, 0); authored.scale.y = h / 3.85;
        authored.traverse(o => { o.userData.shared = true; const mesh = o as THREE.Mesh; if (mesh.isMesh) {
          mesh.material = (mesh.material as THREE.Material).clone(); mesh.castShadow = true; this.materials.push(mesh.material as THREE.Material);
        } });
        this.group.add(authored);
        // Keep the live floating crystal above the authored spire.
        crystal.position.y = h + 1.15; crystal.position.x = tower.position.x; this.group.add(crystal);
        tower.geometry.dispose(); roof.geometry.dispose(); band.geometry.dispose();
      } else this.group.add(tower);
    }
    if (rising) {
      // A rune band along the foot of a rising gate: it glows amber across the approach, warning that the sill climbs.
      const bandMat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
      this.materials.push(bandMat);
      this.warnBand = new THREE.Mesh(new THREE.BoxGeometry(SCENE.roadHalf * 2 + .9, .1, .56), bandMat); this.warnBand.position.y = .06; this.group.add(this.warnBand);
    }
  }

  private bannerTexture(label: string, index: number, monospace: boolean) {
    const width = 640, pad = 34, fontSize = 54;
    const c = document.createElement('canvas'); const g = c.getContext('2d')!;
    const font = `700 ${fontSize}px ${monospace ? 'ui-monospace, Menlo, Consolas, monospace' : this.font}`;
    g.font = font;
    const lines = wrapGateText(label, width - pad * 2 - 96, t => g.measureText(t).width).slice(0, 4);
    const height = Math.max(150, 70 + lines.length * 66);
    c.width = width; c.height = height;
    const color = '#' + new THREE.Color(LANE_COLORS[index % LANE_COLORS.length]).getHexString();
    // Glass tablet: deep night-blue, gold rim, lane-coloured badge with the key number.
    const r = 36;
    g.beginPath(); g.roundRect(6, 6, width - 12, height - 12, r);
    const fill = g.createLinearGradient(0, 0, 0, height); fill.addColorStop(0, 'rgba(18,40,72,.95)'); fill.addColorStop(1, 'rgba(10,24,48,.95)');
    g.fillStyle = fill; g.fill();
    g.lineWidth = 6; g.strokeStyle = color; g.stroke();
    g.beginPath(); g.roundRect(16, 16, width - 32, height - 32, r - 10); g.lineWidth = 2; g.strokeStyle = 'rgba(255,233,180,.45)'; g.stroke();
    g.beginPath(); g.arc(pad + 34, height / 2, 34, 0, Math.PI * 2); g.fillStyle = color; g.fill();
    g.fillStyle = '#0d2038'; g.font = `800 44px ${this.font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(index + 1), pad + 34, height / 2 + 2);
    g.font = font; g.fillStyle = '#fff8e6'; g.textAlign = 'left';
    const textX = pad + 92, start = height / 2 - (lines.length - 1) * 33;
    lines.forEach((line, i) => g.fillText(line, textX, start + i * 66 + 2));
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8; texture.generateMipmaps = true;
    return { texture, aspect: height / width };
  }

  /** 0 → sunk below the causeway, 1 → standing. Used when a question is revealed (the wall rises in the distance). */
  setRise(value: number) {
    this.rise = Math.max(0, Math.min(1, value));
    this.place();
    this.group.visible = this.rise > 0.001;
  }
  /** Version 6: the sliding doors' offset (scene units; the whole wall face slides). */
  setSlide(x: number) { this.group.position.x = x; }
  /** Version 6: shutters 0 (up, open) → 1 (down, closed); the door this racer opened stays open. */
  setShutter(value: number, openGate: number) {
    this.shutters.forEach((sh, i) => { const v = i === openGate ? 0 : value, e = v * v * (3 - 2 * v); sh.position.y = -this.shutterHeight * (1 - e); sh.visible = e > .002; });
  }
  /** Version 6: how far an advancing wall has travelled (scene units) — its wheels roll by it. */
  setTravel(distance: number) { for (const w of this.wheels) w.rotation.x = -distance / .32; }
  /** Rising gates: the whole wall stands on its plinth at this height (scene units, the racer's own sill). */
  setLift(value: number) { if (Math.abs(value - this.lift) < 1e-4) return; this.lift = value; this.place(); }
  private place() { const e = 1 - Math.pow(1 - this.rise, 3); this.group.position.y = -HEIGHT[this.kind] * 1.25 * (1 - e) + this.lift; }
  get risen() { return this.rise; }

  /** A passed wall dissolves into light as the runner clears it, so the following camera never sits behind stone. */
  setFade(amount: number) {
    const a = Math.max(0, Math.min(1, amount));
    if (Math.abs(a - this.fade) < .005) return;
    this.fade = a;
    this.group.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[]) {
        if (m instanceof THREE.ShaderMaterial) { mesh.visible = a < .5; continue; }
        m.userData.baseOpacity ??= m.opacity; m.userData.baseTransparent ??= m.transparent;
        m.transparent = a > 0 || m.userData.baseTransparent; m.opacity = m.userData.baseOpacity * (1 - a * .88); m.depthWrite = a < .2;
      }
      mesh.castShadow = a < .5;
    });
  }

  update(state: WallState) {
    const laneW = SCENE.roadHalf * 2 / this.gates;
    this.doors.forEach((door, i) => {
      const label = state.labels?.[i] ?? '';
      const key = label ? `${label}|${state.monospace}` : '';
      if (door.bannerKey !== key) {
        door.bannerKey = key;
        const material = door.banner.material as THREE.MeshBasicMaterial;
        material.map?.dispose(); material.map = null;
        if (label) {
          const { texture, aspect } = this.bannerTexture(label, i, state.monospace);
          material.map = texture; material.needsUpdate = true;
          const w = Math.min(3.3, laneW * .96);
          door.banner.scale.set(w, w * aspect, 1);
          door.banner.position.y = HEIGHT[this.kind] + .3 + w * aspect / 2;
        }
        door.banner.visible = !!label;
      }
      const open = state.openGate === i ? state.openProgress : 0;
      const ease = open * open * (3 - 2 * open);
      door.uniforms.uTime.value = state.reduced ? 0 : state.time + i * 1.7;
      door.uniforms.uOpen.value = ease;
      const reject = state.rejected === i ? Math.max(0, 1 - state.rejectAge / .9) : 0;
      door.uniforms.uReject.value = reject;
      const tried = state.tried.includes(i) && state.openGate !== i ? 1 : 0;
      door.uniforms.uTried.value = tried;
      door.uniforms.uAim.value = state.aim === i ? 1 : 0;
      door.leaves[0].rotation.y = ease * 1.85; door.leaves[1].rotation.y = -ease * 1.85;
      // A rejected door shudders (amplitude decays) — the stone around it never moves.
      const shake = reject && !state.reduced ? Math.sin(state.rejectAge * 60) * .04 * reject : 0;
      for (const leaf of door.leaves) leaf.position.z = .05 + shake;
      (door.seal.material as THREE.MeshBasicMaterial).opacity = Math.max(tried * .85, reject);
      door.seal.visible = tried > 0 || reject > 0;
      door.banner.visible = !!label && ease < .98;
      const frameMat = door.frame.material as THREE.MeshStandardMaterial;
      frameMat.emissiveIntensity = .45 + (state.aim === i ? .65 : 0) + (state.marked === i ? 1.1 : 0) + ease * 1.6 + reject * 1.2;
      if (reject) frameMat.emissive.setRGB(1, .3, .35); else frameMat.emissive.set(LANE_COLORS[i % LANE_COLORS.length]);
    });
    if (this.warnBand) {
      const w = state.warning ?? 0;
      (this.warnBand.material as THREE.MeshBasicMaterial).opacity = w > 0 ? .35 + .5 * w * (state.reduced ? 1 : .6 + .4 * Math.sin(state.time * (6 + 10 * w))) : .12;
    }
    for (const [index, crystal] of this.towersCrystal.entries()) {
      crystal.userData.baseY ??= crystal.position.y;
      crystal.rotation.y = state.reduced ? 0 : state.time * (1.2 + index * .2);
      crystal.position.y = crystal.userData.baseY + (state.reduced ? 0 : Math.sin(state.time * 2 + index) * .12);
    }
  }

  dispose() {
    for (const door of this.doors) {
      (door.banner.material as THREE.MeshBasicMaterial).map?.dispose();
      door.membrane.geometry.dispose(); door.banner.geometry.dispose(); door.seal.geometry.dispose();
      door.frame.geometry.dispose();
      door.frame.children.forEach(c => (c as THREE.Mesh).geometry.dispose());
      door.leaves.forEach(l => (l.children[0] as THREE.Mesh).geometry.dispose());
      (door.seal.children[0] as THREE.Mesh).geometry.dispose();
    }
    this.group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry && !m.userData.shared && !shapeCacheHas(m.geometry)) m.geometry.dispose(); });
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.materials = []; this.textures = [];
  }
}

function shapeCacheHas(g: THREE.BufferGeometry) {
  for (const value of shapeCache.values()) if (value === g) return true;
  return false;
}

/** A wall whose question is not revealed yet: towers and a faint light curtain, no doors to miscount. */
export class PendingWall {
  readonly group = new THREE.Group();
  private materials: THREE.Material[] = [];
  private curtain: THREE.Mesh;
  constructor(kind: WallKind) {
    const tex = stone();
    const towerMat = new THREE.MeshStandardMaterial({ map: tex, color: 0xf6ead2, roughness: .8 });
    const roofMat = new THREE.MeshStandardMaterial({ color: kind === 'normal' ? 0x2f8f8a : kind === 'milestone' ? 0x6b56c9 : 0xd9a53a, roughness: .5 });
    const curtainMat = new THREE.MeshBasicMaterial({ color: kind === 'grand' ? 0xffd27a : 0xbff6ff, transparent: true, opacity: .16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false });
    this.materials.push(towerMat, roofMat, curtainMat);
    const top = HEIGHT[kind];
    for (const side of [-1, 1]) {
      const h = top + (kind === 'normal' ? .8 : 1.6);
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(.48, .58, h, 10), towerMat); tower.position.set(side * (SCENE.roadHalf + .7), h / 2 - .3, 0);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(.66, .9, 10), roofMat); roof.position.y = h / 2 + .45; tower.add(roof);
      this.group.add(tower);
    }
    this.curtain = new THREE.Mesh(new THREE.PlaneGeometry(SCENE.roadHalf * 2 + .6, top + .4), curtainMat);
    this.curtain.position.y = (top + .4) / 2 - .2; this.group.add(this.curtain);
  }
  update(time: number, reduced: boolean) { (this.curtain.material as THREE.MeshBasicMaterial).opacity = .12 + (reduced ? 0 : Math.sin(time * 1.6) * .04); }
  dispose() {
    this.group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    for (const m of this.materials) m.dispose();
  }
}

export function disposeGateCaches() {
  for (const g of shapeCache.values()) g.dispose();
  shapeCache.clear();
  stoneTexture?.dispose(); stoneTexture = null;
  for (const t of sharedStone.values()) t.dispose();
  sharedStone.clear();
}
