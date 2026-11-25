import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  BOULDER, CHASM, LANES, MILL, RAMS, SKYFALL, boulderStart, boulders, chasmCenter, impacts, millAngle, millCenter, ramLift, ramOffset, ramY, rows, rowY,
  type Boulder, type Hazard,
} from '../rushTrials';
import { SCENE, toX, toZ } from './skyScale';
import {
  BEAM, CRUMBLE, CRUSHER, DRIFT, GALE, REFORGED, ROLLER, SAWS, STEPS, closure, crumbleTiles, crumbleU, crushOneSided, crushRows, crushSide, crushY, driftRows, driftX, driftY, galeHalf, gust, gustCycle, gustDir, gustWarning,
  logAngle, logCount, logFrom, logTo, logX, pegAngle, pegsIn, ringCount, ringY, rollerPad, sawAngle, sawDouble, sawRows, sawX, sawY, stepRows, stepShake, stepSink, stepX, stepY, tileShake, tiltAngle,
} from '../rushReforged';

/**
 * Obstacles of the Skybound Trials, drawn from the authored Blender props (props.glb). Every pose comes from the same
 * closed-form functions the server collides with (rushTrials.ts ≡ RushTrials.java) at the race clock, so the beam,
 * the rams, the boulders and the falling stones are exactly where a hit is decided. Telegraphs (sweep circle,
 * impact circles, glowing break lines) are drawn before anything can touch a runner.
 */
const EMISSIVE_CELLS = [6, 7, 14, 16, 17, 18];
interface Built { key: string; group: THREE.Group; update(t: number, time: number, reduced: boolean): void; dispose(): void }
const ringVertex = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ringFragment = /* glsl */`
uniform vec3 uColor; uniform float uProgress; uniform float uAlpha; uniform float uTime; varying vec2 vUv;
void main(){
  vec2 p = vUv * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard;
  float edge = smoothstep(.86, .93, r) * (1.0 - smoothstep(.97, 1.0, r));
  float fill = step(r, uProgress) * (.18 + .12 * sin(r * 24.0 - uTime * 8.0));
  float runes = step(.72, r) * step(r, .8) * (.5 + .5 * sin(atan(p.y, p.x) * 12.0 + uTime * 2.0));
  gl_FragColor = vec4(uColor, (edge * .9 + fill + runes * .35) * uAlpha);
}`;

function fallbackTemplates() {
  // Stand-ins (same contact sizes) used only until props.glb arrives.
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9b089, roughness: .8 });
  const t: Record<string, THREE.Object3D> = {};
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(.4, .4, 2.3, 16).translate(0, 1.15, 0), mat); t.mill_pillar = pillar;
  const beam = new THREE.Mesh(new THREE.BoxGeometry(9.3, .3, .34).translate(0, .3, 0), new THREE.MeshStandardMaterial({ color: 0x8a5a2e })); t.mill_beam = beam;
  const ram = new THREE.Mesh(new THREE.BoxGeometry(.88, 1.18, 1.08).translate(0, -6, 0), mat); t.ram = ram;
  const arch = new THREE.Group(); for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(.7, 7.2, .7).translate(s * 5.4, 3.6, 0), mat); arch.add(p); } t.ram_arch = arch;
  t.boulder = new THREE.Mesh(new THREE.IcosahedronGeometry(.6, 2), mat);
  t.skystone = new THREE.Mesh(new THREE.IcosahedronGeometry(.42, 1), mat);
  t.chasm_edge = new THREE.Mesh(new THREE.BoxGeometry(9.4, .5, .3).translate(0, -.25, 0), mat);
  t.chasm_beam = new THREE.Mesh(new THREE.BoxGeometry(.8, .32, 2.4).translate(0, -.16, 0), mat);
  t.plinth = new THREE.Mesh(new THREE.BoxGeometry(9.9, 1, .64).translate(0, -.5, 0), mat);
  // Version 6 stand-ins (same contact sizes as rushReforged.ts) until props6.glb arrives.
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9ced8, metalness: .85, roughness: .3, emissive: 0x47e6d6, emissiveIntensity: .15 });
  const blade = new THREE.Mesh(new THREE.CylinderGeometry(SAWS.r, SAWS.r, .08, 28).rotateX(Math.PI / 2), steel); t.saw_blade = blade;
  t.saw_track = new THREE.Mesh(new THREE.BoxGeometry(9.6, .06, .34).translate(0, .01, 0), new THREE.MeshStandardMaterial({ color: 0x383c4a, roughness: .5, metalness: .4 }));
  t.crusher_block = new THREE.Mesh(new THREE.BoxGeometry(4.7, 2.3, CRUSHER.halfY * 2).translate(-2.35, 1.15, 0), mat);
  t.crusher_frame = new THREE.Mesh(new THREE.BoxGeometry(19.6, .5, 2.2).translate(0, 3.1, 0), mat);
  t.gale_bridge = new THREE.Mesh(new THREE.BoxGeometry(REFORGED.galeHalf * .02 + .04, .4, 1).translate(0, -.2, -.5), mat);
  t.gale_pylon = new THREE.Mesh(new THREE.CylinderGeometry(.18, .24, 3.2, 8).translate(0, 1.6, 0), mat);
  t.gale_vane = new THREE.Mesh(new THREE.BoxGeometry(1.1, .5, .04).translate(.55, 0, 0), new THREE.MeshStandardMaterial({ color: 0x23936f, roughness: .8, side: THREE.DoubleSide }));
  t.crumble_tile = new THREE.Mesh(new THREE.BoxGeometry(9.4, .4, CRUMBLE.tile * SCENE.kz - .04).translate(0, -.2, 0), new THREE.MeshStandardMaterial({ color: 0xbfd9ff, roughness: .4, metalness: .1, emissive: 0x2f6fb0, emissiveIntensity: .25 }));
  t.drift_stone = new THREE.Mesh(new THREE.CylinderGeometry(DRIFT.r, DRIFT.r * .55, .9, 20).translate(0, -.45, 0), mat);
  // Version 7 stand-ins (same contact sizes as rushReforged.ts) until props7.glb arrives.
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a2e, roughness: .75 }), bronze = new THREE.MeshStandardMaterial({ color: 0xc99a4a, metalness: .8, roughness: .35 });
  t.roller_log = new THREE.Mesh(new THREE.CylinderGeometry(ROLLER.r, ROLLER.r, 1, 24).rotateX(Math.PI / 2).translate(0, 0, -.5), wood);
  t.roller_band = new THREE.Mesh(new THREE.CylinderGeometry(ROLLER.r + .03, ROLLER.r + .03, .12, 24).rotateX(Math.PI / 2), bronze);
  t.roller_peg = new THREE.Mesh(new THREE.CylinderGeometry(.06, .075, ROLLER.peg + .06, 10).translate(0, ROLLER.r - .06 + (ROLLER.peg + .06) / 2, 0), new THREE.MeshStandardMaterial({ color: 0xb8a07a, roughness: .8 }));
  t.roller_hub = new THREE.Mesh(new THREE.CylinderGeometry(.72, .72, .34, 24).rotateX(Math.PI / 2), bronze);
  t.roller_pad = new THREE.Mesh(new THREE.BoxGeometry(2.4, .36, 1.4).translate(0, -.18, 0), mat);
  t.step_stone = new THREE.Mesh(new THREE.CylinderGeometry(1, .5, .9, 20).translate(0, -.45, 0), mat);
  t.tilt_deck = new THREE.Mesh(new THREE.BoxGeometry(9.4, .4, 1, 1, 1, 8).translate(0, -.2, -.5), mat);
  t.beam_deck = new THREE.Mesh(new THREE.BoxGeometry(1, .4, 1).translate(0, -.2, -.5), mat);
  return t;
}

export class SkyHazards {
  readonly group = new THREE.Group();
  private templates: Record<string, THREE.Object3D> = fallbackTemplates();
  private fromArt = false;
  private built = new Map<string, Built>();
  private disposables: { dispose(): void }[] = [];
  private gapsCache: [number, number][] = [];
  private shadowGeo = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
  private shadowMat = new THREE.MeshBasicMaterial({ color: 0x1a1830, transparent: true, opacity: .32, depthWrite: false });

  constructor(private quality: 'high' | 'medium' | 'low') { this.disposables.push(this.shadowGeo, this.shadowMat); }

  /** Swap in the authored props (once). Emissive rune cells glow; stone keeps its palette tone. */
  setArt(props: GLTF | null, orm: THREE.Texture | null) {
    if (!props || this.fromArt) return;
    this.fromArt = true; this.absorb(props, orm);
  }
  private absorb(props: GLTF, orm: THREE.Texture | null) {
    const templates: Record<string, THREE.Object3D> = {};
    let emissive: THREE.Texture | null = null;
    props.scene.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.MeshStandardMaterial;
      if (!emissive && m.map?.image) {
        const image = m.map.image as CanvasImageSource & { width: number; height: number };
        const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
        const g = c.getContext('2d')!; g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
        const cell = c.width / 8;
        for (const i of EMISSIVE_CELLS) g.drawImage(image, (i % 8) * cell, Math.floor(i / 8) * cell, cell, cell, (i % 8) * cell, Math.floor(i / 8) * cell, cell, cell);
        emissive = new THREE.CanvasTexture(c); emissive.flipY = false; emissive.colorSpace = THREE.SRGBColorSpace;
        emissive.magFilter = emissive.minFilter = THREE.NearestFilter; emissive.generateMipmaps = false;
        this.disposables.push(emissive);
      }
      if (m.map) { m.map.magFilter = THREE.NearestFilter; m.map.minFilter = THREE.NearestFilter; m.map.generateMipmaps = false; m.map.needsUpdate = true; }
      if (orm) { m.roughnessMap = orm; m.metalnessMap = orm; m.roughness = 1; m.metalness = 1; }
      if (emissive) { m.emissiveMap = emissive; m.emissive.set(0xffffff); m.emissiveIntensity = 1.6; }
      m.vertexColors = false;
      mesh.castShadow = this.quality === 'high'; mesh.receiveShadow = true;
      templates[mesh.name] = mesh;
    });
    for (const name of Object.keys(this.templates)) if (templates[name]) this.templates[name] = templates[name];
    for (const b of this.built.values()) { this.group.remove(b.group); b.dispose(); }
    this.built.clear();
  }

  private part(name: string) { return this.templates[name].clone(); }
  /** The version 6 props (Blender, props6.glb) merge into the same template table. */
  setArt6(props: GLTF | null, orm: THREE.Texture | null) {
    if (!props || this.fromArt6) return;
    this.fromArt6 = true; this.absorb(props, orm);
  }
  private fromArt6 = false;
  /** The version 7 props (Blender, props7.glb): rollers, stepping stones, the leaning deck, the wind beam. */
  setArt7(props: GLTF | null, orm: THREE.Texture | null) {
    if (!props || this.fromArt7) return;
    this.fromArt7 = true; this.absorb(props, orm);
  }
  private fromArt7 = false;
  private shadow(scale: number) { const s = new THREE.Mesh(this.shadowGeo, this.shadowMat); s.scale.setScalar(scale); s.position.y = .015; s.renderOrder = 1; return s; }
  private ring(color: number, radius: number) {
    const mat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(color) }, uProgress: { value: 0 }, uAlpha: { value: 0 }, uTime: { value: 0 } },
      vertexShader: ringVertex, fragmentShader: ringFragment, transparent: true, depthWrite: false, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2).rotateX(-Math.PI / 2), mat);
    mesh.position.y = .02; mesh.renderOrder = 2;
    return mesh;
  }

  private build(h: Hazard): Built {
    const group = new THREE.Group();
    const own: { dispose(): void }[] = [];
    const ringOf = (color: number, r: number) => { const m = this.ring(color, r); own.push(m.geometry, m.material as THREE.Material); return m; };
    let update: Built['update'] = () => {};
    if (h.kind === 'MILL') {
      const z = toZ(millCenter(h));
      const pillar = this.part('mill_pillar'), beam = this.part('mill_beam');
      pillar.position.set(0, 0, z); beam.position.set(0, 0, z);
      const sweep = ringOf(0xffc46b, MILL.arm + .25); sweep.position.set(0, .02, z);
      group.add(pillar, beam, sweep);
      update = (t, time, reduced) => {
        beam.rotation.y = millAngle(h, t);
        const u = (sweep.material as THREE.ShaderMaterial).uniforms; u.uAlpha.value = .55; u.uProgress.value = 0; u.uTime.value = reduced ? 0 : time;
      };
    } else if (h.kind === 'RAMS') {
      const rams: THREE.Object3D[] = [];
      for (let j = 0; j < 3; j++) {
        const z = toZ(ramY(h, j));
        const arch = this.part('ram_arch'); arch.position.set(0, 0, z);
        const ram = this.part('ram'); ram.position.set(0, RAMS.reach + .75, z);
        const shadow = this.shadow(.7); shadow.position.z = z; shadow.name = 'shadow';
        group.add(arch, ram, shadow); rams.push(ram, shadow);
      }
      update = t => {
        for (let j = 0; j < 3; j++) {
          const off = ramOffset(h, j, t), ram = rams[j * 2], shadow = rams[j * 2 + 1];
          ram.rotation.z = Math.asin(Math.max(-1, Math.min(1, off / RAMS.reach)));
          shadow.position.x = off; const lift = ramLift(off); shadow.scale.setScalar(.75 - lift * .2);
          (shadow as THREE.Mesh).visible = lift < 1.6;
        }
      };
    } else if (h.kind === 'BOULDERS') {
      // The boulder gate at the top of the run, then a pool of rolling stones.
      const gate = this.part('ram_arch'); gate.position.set(0, 0, toZ(boulderStart(h)) - .4); group.add(gate);
      const pool: { stone: THREE.Object3D; shadow: THREE.Mesh }[] = [];
      for (let i = 0; i < 10; i++) { const stone = this.part('boulder'); const shadow = this.shadow(.62); stone.visible = shadow.visible = false; group.add(stone, shadow); pool.push({ stone, shadow }); }
      const list: Boulder[] = [];
      update = t => {
        boulders(h, t, list);
        pool.forEach((p, i) => {
          const b = list[i]; p.stone.visible = p.shadow.visible = !!b;
          if (!b) return;
          p.stone.position.set(toX(b.x), BOULDER.radius, toZ(b.y)); p.stone.rotation.set(b.roll, b.k * .7, 0);
          p.shadow.position.set(toX(b.x), .015, toZ(b.y));
        });
      };
    } else if (h.kind === 'SKYFALL') {
      // Per row: two impact circles (the safe lane stays dark), a falling sky-stone and a shockwave.
      const rowsOf: { circles: THREE.Mesh[]; stones: THREE.Object3D[]; waves: THREE.Mesh[] }[] = [];
      for (let j = 0; j < rows(h); j++) {
        const z = toZ(rowY(h, j));
        const row = { circles: [] as THREE.Mesh[], stones: [] as THREE.Object3D[], waves: [] as THREE.Mesh[] };
        for (let lane = 0; lane < 3; lane++) {
          const c = ringOf(0xff8a5c, SKYFALL.radius); c.position.set(toX(LANES[lane]), .021, z);
          const w = ringOf(0xffd27a, SKYFALL.radius); w.position.set(toX(LANES[lane]), .03, z);
          const s = this.part('skystone'); s.position.set(toX(LANES[lane]), 20, z);
          group.add(c, w, s); row.circles.push(c); row.waves.push(w); row.stones.push(s);
        }
        rowsOf.push(row);
      }
      update = (t, time, reduced) => {
        const live = new Map(impacts(h, t).map(i => [i.row, i]));
        rowsOf.forEach((row, j) => {
          const i = live.get(j);
          for (let lane = 0; lane < 3; lane++) {
            const hot = !!i && lane !== i.safe;
            const circle = (row.circles[lane].material as THREE.ShaderMaterial).uniforms, wave = (row.waves[lane].material as THREE.ShaderMaterial).uniforms;
            const before = i ? i.time - t : 9;
            circle.uAlpha.value = hot && before > 0 ? Math.min(1, (SKYFALL.warn - before) / .25 + .2) : 0;
            circle.uProgress.value = hot ? Math.max(0, 1 - before / SKYFALL.warn) : 0; circle.uTime.value = reduced ? 0 : time;
            const stone = row.stones[lane]; stone.visible = hot && before > -.05 && before < .85;
            if (stone.visible) { stone.position.y = Math.max(.35, before * 24); stone.rotation.set(time * 3, time * 2, 0); }
            const after = -before;
            wave.uAlpha.value = hot && after >= 0 && after < .55 ? 1 - after / .55 : 0;
            row.waves[lane].scale.setScalar(1 + after * 1.6); wave.uProgress.value = 1;
          }
        });
      };
    } else if (h.kind === 'SAWS') {
      // Floor slots with their housings; one blade (two on harder rows) racing along each slot.
      const blades: { mesh: THREE.Object3D; j: number; b: number }[] = [];
      for (let j = 0; j < sawRows(h.tier); j++) {
        const z = toZ(sawY(h, j)); const track = this.part('saw_track'); track.position.set(0, 0, z); group.add(track);
        for (let b = 0; b < (sawDouble(h, j) ? 2 : 1); b++) { const blade = this.part('saw_blade'); blade.position.set(0, SAWS.c, z); group.add(blade); blades.push({ mesh: blade, j, b }); }
        const warn = ringOf(0xff8a5c, .9); warn.position.set(0, .02, z); warn.scale.set(5.2, 1, .45); group.add(warn); blades.push({ mesh: warn, j: -1 - j, b: 0 });
      }
      update = (t, time, reduced) => {
        for (const bl of blades) {
          if (bl.j < 0) { const u = (bl.mesh as THREE.Mesh).material as THREE.ShaderMaterial; u.uniforms.uAlpha.value = .32; u.uniforms.uProgress.value = 1; u.uniforms.uTime.value = reduced ? 0 : time; continue; }
          bl.mesh.position.x = toX(sawX(h, bl.j, bl.b, t));
          // The blade rolls the way it travels: spin = travel / radius (plus its own fast cut).
          bl.mesh.rotation.z = -(sawX(h, bl.j, bl.b, t) - 500) * SCENE.kx / SAWS.r - (reduced ? 0 : time * 14) * (bl.b ? -1 : 1);
          void sawAngle;
        }
      };
    } else if (h.kind === 'CRUSHER') {
      // Per row: a stone frame spanning the road and two rune blocks driven together from the edges.
      const rowsOf: { left: THREE.Object3D; right: THREE.Object3D; glow: THREE.Mesh }[] = [];
      for (let j = 0; j < crushRows(h.tier); j++) {
        const z = toZ(crushY(h, j)), frame = this.part('crusher_frame'); frame.position.set(0, 0, z); group.add(frame);
        const left = this.part('crusher_block'), right = this.part('crusher_block'); right.rotation.y = Math.PI; left.position.z = right.position.z = z; group.add(left, right);
        const glow = ringOf(0xffcf6b, 1); glow.position.set(0, .025, z); glow.scale.set(4.6, 1, .9); group.add(glow);
        rowsOf.push({ left, right, glow });
      }
      // Tiers 5–6: every second row is one ram from one side that drives most of the way across (longer block).
      rowsOf.forEach((r, j) => { if (!crushOneSided(h, j)) return; const s = crushSide(h, j), keep = s < 0 ? r.left : r.right, drop = s < 0 ? r.right : r.left;
        drop.visible = false; keep.scale.x = CRUSHER.reach / REFORGED.edge; });
      update = (t, time, reduced) => rowsOf.forEach((r, j) => {
        const c = closure(h, j, t), inner = REFORGED.edge * SCENE.kx * (1 - c);
        if (crushOneSided(h, j)) { const s = crushSide(h, j), face = s * (REFORGED.edge - CRUSHER.reach * c) * SCENE.kx; (s < 0 ? r.left : r.right).position.x = face; }
        else { r.left.position.x = -inner; r.right.position.x = inner; }
        // Telegraph: the floor between the blocks glows just before a slam.
        const period = CRUSHER.period[h.tier - 1], u = ((t - h.phase / (2 * Math.PI) * period - j * .33 * period) % period + period) % period / period;
        const m = r.glow.material as THREE.ShaderMaterial; m.uniforms.uAlpha.value = u > .33 && u < .55 ? (.4 + .6 * Math.sin((u - .33) / .22 * Math.PI)) : 0; m.uniforms.uProgress.value = 1; m.uniforms.uTime.value = reduced ? 0 : time;
      });
    } else if (h.kind === 'GALE' || h.kind === 'BEAM') {
      // The narrow span (no rail), pylons with wind vanes that swing to the coming gust, and streaks of wind. The Wind
      // Balance Bridge (version 7) is a much narrower beam, tiled from the authored metre so its carving keeps scale.
      const len = (h.to - h.from) * SCENE.kz, mid = toZ((h.from + h.to) / 2);
      if (h.kind === 'GALE') { const bridge = this.part('gale_bridge'); bridge.position.set(0, 0, toZ(h.from)); bridge.scale.set(galeHalf(h) / REFORGED.galeHalf, 1, len); group.add(bridge); }
      else {
        const pieces = Math.max(1, Math.round(len)), width = BEAM.half[h.tier - 1] * 2 * SCENE.kx + .04;
        for (let k = 0; k < pieces; k++) { const deck = this.part('beam_deck'); deck.position.set(0, 0, toZ(h.from) - k * len / pieces); deck.scale.set(width, 1, len / pieces); group.add(deck); }
      }
      const vanes: THREE.Object3D[] = [];
      for (let k = 0; k < 4; k++) for (const sx of [-1, 1]) {
        const z = toZ(h.from + (h.to - h.from) * (k + .5) / 4), pylon = this.part('gale_pylon'); pylon.position.set(sx * 3.4, -1.2, z); group.add(pylon);
        const vane = this.part('gale_vane'); vane.position.set(sx * 3.4, 2.15, z); group.add(vane); vanes.push(vane);
      }
      const streaks: THREE.Mesh[] = [];
      const streakMat = new THREE.MeshBasicMaterial({ color: 0xe8f6ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      own.push(streakMat);
      const streakGeo = new THREE.PlaneGeometry(2.4, .05); own.push(streakGeo);
      for (let k = 0; k < (this.quality === 'low' ? 10 : 22); k++) { const m = new THREE.Mesh(streakGeo, streakMat); m.position.set(0, .4 + (k % 5) * .35, mid - len / 2 + (k * 7.31 % 1) * len); m.userData.seed = k * 1.37; group.add(m); streaks.push(m); }
      update = (t, time, reduced) => {
        const g = gust(h, t), dir = gustDir(h, gustCycle(h, t)), warn = gustWarning(h, t);
        const nextDir = gustDir(h, gustCycle(h, t) + (warn ? 0 : 1));
        for (const v of vanes) v.rotation.y += ((dir > 0 ? 0 : Math.PI) - v.rotation.y) * .08 + (reduced ? 0 : Math.sin(time * 9 + v.position.z) * .01 * (1 + g * 4));
        streakMat.opacity = (warn ? .25 : 0) + g * .55;
        for (const m of streaks) { const sp = (reduced ? 0 : 1) * (6 + g * 18), x = ((time * sp + m.userData.seed * 3) % 14) - 7; m.position.x = (warn ? nextDir : dir) * x; m.rotation.y = 0; m.visible = g > .02 || warn; }
      };
      void GALE;
    } else if (h.kind === 'CRUMBLE') {
      // Crystal-veined tiles that shake (warning), drop away and reassemble — the same tile timing as the authority.
      const tiles: THREE.Object3D[] = [];
      for (let k = 0; k < crumbleTiles(h.tier); k++) { const tile = this.part('crumble_tile'); tile.position.set(0, 0, toZ(h.from + (k + .5) * CRUMBLE.tile)); group.add(tile); tiles.push(tile); }
      const baseZ = tiles.map(tl => tl.position.z);
      update = (t, time, reduced) => tiles.forEach((tile, k) => {
        const u = crumbleU(h, k, t), shake = tileShake(h, k, t);
        if (u < CRUMBLE.down) {
          // Fall for the first third of the down time, gone, then rise back into place at its end.
          const d = u / CRUMBLE.down, fall = d < .35 ? d / .35 : d > .85 ? (1 - d) / .15 : 1;
          tile.position.y = -fall * fall * 4.5; tile.visible = fall < .98; tile.rotation.x = fall * .35; tile.rotation.z = fall * .2 * (k % 2 ? 1 : -1);
        } else { tile.position.y = 0; tile.visible = true; tile.rotation.set(0, 0, 0); }
        tile.position.x = reduced ? 0 : Math.sin(time * 70 + k) * .03 * shake; tile.position.z = baseZ[k];
      });
    } else if (h.kind === 'STEPS') {
      // Small floating stones in a zigzag; a sinking one shakes, sinks (carrying whoever stands on it) and rises again on the authority's timing.
      const stones: THREE.Object3D[] = [];
      for (let j = 0; j < stepRows(h.tier); j++) {
        const stone = this.part('step_stone'), r = STEPS.r[h.tier - 1]; stone.scale.set(r, .85, r); stone.position.set(toX(stepX(h, j)), 0, toZ(stepY(h, j))); stone.rotation.y = j * 1.3; group.add(stone); stones.push(stone);
      }
      update = (t, time, reduced) => stones.forEach((st, j) => {
        const shake = stepShake(h, j, t);
        st.position.y = -stepSink(h, j, t);
        st.position.x = toX(stepX(h, j)) + (reduced ? 0 : Math.sin(time * 60 + j) * .035 * shake);
      });
    } else if (h.kind === 'TILT') {
      // The leaning road: the authored deck metre tiled along the zone, each vertex turned about the road axis by the lean
      // at its own distance — the same function the authority slides runners with, so the surface is continuous.
      const template = this.templates.tilt_deck as THREE.Mesh, len = (h.to - h.from) * SCENE.kz, pieces = Math.max(1, Math.round(len)), step = len / pieces;
      // A touch darker than the pale palette stone, so the leaning deck reads as the same causeway stone in full sun.
      const deckMat = (template.material as THREE.MeshStandardMaterial).clone(); deckMat.color.set(0xcdbfa6); own.push(deckMat);
      for (let k = 0; k < pieces; k++) {
        const geo = template.geometry.clone(), pos = geo.attributes.position as THREE.BufferAttribute;
        for (let v = 0; v < pos.count; v++) {
          const x = pos.getX(v), y = pos.getY(v), z = toZ(h.from) - k * step + pos.getZ(v) * step;
          const a = tiltAngle(h, h.from + (toZ(h.from) - z) / SCENE.kz), c = Math.cos(a), s = Math.sin(a);
          pos.setXYZ(v, x * c + y * s, -x * s + y * c, z);
        }
        geo.computeVertexNormals(); geo.computeBoundingSphere(); own.push(geo);
        const deck = new THREE.Mesh(geo, deckMat); deck.castShadow = template.castShadow; deck.receiveShadow = true; group.add(deck);
      }
    } else if (h.kind === 'ROLLER') {
      // Spiked Rotating Rollers: banded logs over the abyss (top flush with the road), turning about their length with
      // pegs on staggered rings; a bronze bearing on its stone footing at each log end. Every peg is posed by pegAngle.
      const spins: { spin: THREE.Group; i: number }[] = [];
      for (let i = 0; i < logCount(h); i++) {
        const from = logFrom(h, i), len = (logTo(h, i) - from) * SCENE.kz;
        const pivot = new THREE.Group(); pivot.position.set(toX(logX(h, i)), -ROLLER.r, toZ(from)); group.add(pivot);
        const spin = new THREE.Group(); pivot.add(spin); spins.push({ spin, i });
        const pieces = Math.max(1, Math.round(len));
        for (let k = 0; k < pieces; k++) { const seg = this.part('roller_log'); seg.position.z = -k * len / pieces; seg.scale.z = len / pieces; spin.add(seg); }
        for (let j = 0; j < ringCount(h, i); j++) {
          const z = -(ringY(h, i, j) - from) * SCENE.kz;
          if (j % 2 === 0) { const band = this.part('roller_band'); band.position.z = z; spin.add(band); }
          for (let k = 0; k < pegsIn(h, j); k++) { const peg = this.part('roller_peg'); peg.position.z = z; peg.rotation.z = -pegAngle(h, i, j, k, 0); spin.add(peg); }
        }
        for (const end of [0, 1]) { const hub = this.part('roller_hub'); hub.scale.set(.8, .8, 1); hub.position.z = end ? -len - .17 : .17; hub.rotation.y = end ? Math.PI : 0; pivot.add(hub); }
      }
      if (rollerPad(h)) { const pad = this.part('roller_pad'); pad.position.set(0, 0, toZ((h.from + h.to) / 2)); group.add(pad); }
      update = t => { for (const s of spins) s.spin.rotation.z = -logAngle(h, s.i, t); };
    } else if (h.kind === 'DRIFT') {
      const stones: THREE.Object3D[] = [];
      for (let j = 0; j < driftRows(h.tier); j++) { const stone = this.part('drift_stone'); stone.position.set(0, 0, toZ(driftY(h, j))); group.add(stone); stones.push(stone); }
      update = (t, time, reduced) => stones.forEach((st, j) => { st.position.x = toX(driftX(h, j, t)); st.rotation.y = reduced ? 0 : time * .3 + j; });
    } else if (h.kind === 'CHASM') {
      const c = chasmCenter(h), half = CHASM.half[h.tier - 1];
      const near = this.part('chasm_edge'), far = this.part('chasm_edge');
      near.position.set(0, 0, toZ(c - half)); far.position.set(0, 0, toZ(c + half)); far.rotation.y = Math.PI;
      group.add(near, far);
      if (h.lane >= 0) { const beam = this.part('chasm_beam'); beam.position.set(toX(LANES[h.lane]), 0, toZ(c)); beam.scale.z = (half * 2 * SCENE.kz + .5) / 2.4; group.add(beam); }
    }
    this.group.add(group);
    return { key: `${h.checkpoint}:${h.kind}`, group, update, dispose: () => { for (const d of own) d.dispose(); } };
  }

  /**
   * Keep the obstacles near the viewer built and posed at race time `t`. `viewY` is the viewer's road position.
   */
  update(hazards: Hazard[], t: number, viewY: number, time: number, reduced: boolean) {
    const keep = new Set<string>();
    this.gapsCache.length = 0;
    for (const h of hazards) {
      if (h.to < viewY - 1200 || h.from > viewY + 7500) continue;
      const key = `${h.checkpoint}:${h.kind}`;
      keep.add(key);
      let b = this.built.get(key);
      if (!b) { b = this.build(h); this.built.set(key, b); }
      b.update(t, time, reduced);
      if (h.kind === 'CHASM') { const c = chasmCenter(h), half = CHASM.half[h.tier - 1]; this.gapsCache.push([toZ(c - half), toZ(c + half)]); }
      // Version 6: the narrow bridge, the crumbling span and the drifting stones replace the causeway over their zone.
      if (['GALE', 'CRUMBLE', 'DRIFT', 'BEAM', 'STEPS', 'TILT', 'ROLLER'].includes(h.kind)) this.gapsCache.push([toZ(h.from), toZ(h.to)]);

    }
    for (const [key, b] of this.built) if (!keep.has(key)) { this.group.remove(b.group); b.dispose(); this.built.delete(key); }
  }
  /** A rising gate's plinth (unit height; the world scales it to the sill). */
  plinth() { const p = this.part('plinth'); p.scale.y = .001; return p; }
  /** Road gaps (scene z ranges, near > far) for the causeway cut. */
  gaps() { return this.gapsCache; }

  dispose() {
    for (const b of this.built.values()) b.dispose();
    this.built.clear();
    for (const d of this.disposables) d.dispose();
  }
}
