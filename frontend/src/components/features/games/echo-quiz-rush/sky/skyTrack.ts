import * as THREE from 'three';
import { LANE_COLORS, SCENE, laneX, doorHalfWidth } from './skyScale';
import type { SkyArt } from './skyAssets';

/** Up to twelve road cuts (scene z, near → far): broken bridges, and the spans replaced by bridges, tiles or stones. */
const MAX_GAPS = 12;
/** Railing pieces are short so a railing ends exactly where the authority's open edge begins. */
const RAIL_PIECE = 2;
function cuttable(material: THREE.Material, gaps: THREE.IUniform) {
  material.onBeforeCompile = shader => {
    shader.uniforms.uGaps = gaps;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
varying float vSkyZ;`).replace('#include <project_vertex>', `#include <project_vertex>
{ vec4 skyW = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  skyW = instanceMatrix * skyW;
#endif
  vSkyZ = (modelMatrix * skyW).z; }`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
varying float vSkyZ; uniform vec2 uGaps[${MAX_GAPS}];`).replace('void main() {', `void main() {
  for (int i = 0; i < ${MAX_GAPS}; i++) { if (vSkyZ < uGaps[i].x && vSkyZ > uGaps[i].y) discard; }`);
  };
  material.customProgramCacheKey = () => 'sky-cut';
}

/**
 * The floating causeway: instanced tiles of carved stone over a rocky keel, low parapets with lanterns, recycled as
 * the camera advances. Road surface is y = 0. Lane runways glow in each door's colour on the approach to the current
 * wall, exactly as wide as the doorway, so lining up is a visual skill rather than a guess.
 */
const TILE = 8;

function roadTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c9b089'; g.fillRect(0, 0, 512, 512);
  // Large flagstones, a central sun mosaic stripe and gilded edge bands.
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const x = col * 128 + (row % 2) * 64, y = row * 128, tint = 196 + ((row * 5 + col * 3) % 4) * 8;
    g.fillStyle = `rgb(${tint + 14},${tint - 8},${tint - 48})`;
    g.beginPath(); g.roundRect(x + 4, y + 4, 120, 120, 10); g.fill();
    g.beginPath(); g.roundRect(x - 508, y + 4, 120, 120, 10); g.fill();
    g.fillStyle = 'rgba(255,240,210,.25)'; g.fillRect(x + 10, y + 10, 108, 6);
  }
  g.strokeStyle = 'rgba(150,115,60,.35)'; g.lineWidth = 3;
  for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(0, i * 128); g.lineTo(512, i * 128); g.stroke(); }
  g.fillStyle = '#d8b15a'; g.fillRect(0, 0, 16, 512); g.fillRect(496, 0, 16, 512);
  g.fillStyle = '#8a5f1c'; g.fillRect(16, 0, 4, 512); g.fillRect(492, 0, 4, 512);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export class SkyTrack {
  readonly group = new THREE.Group();
  private slabs: THREE.InstancedMesh;
  private keels: THREE.InstancedMesh;
  private rails: THREE.InstancedMesh;
  private lanterns: THREE.InstancedMesh;
  private count: number;
  private matrix = new THREE.Matrix4();
  private disposables: { dispose(): void }[] = [];
  private runways: THREE.Mesh[] = [];
  private runwayGates = 0;
  private runwayMats: THREE.MeshBasicMaterial[] = [];
  private finishArch: THREE.Group | null = null;
  private finishMaterials: THREE.Material[] = [];
  private startPad: THREE.Mesh;
  private gaps: THREE.IUniform<THREE.Vector2[]> = { value: Array.from({ length: MAX_GAPS }, () => new THREE.Vector2(1e6, 1e6)) };
  private slabMaterials: THREE.MeshStandardMaterial[];
  private posts: THREE.InstancedMesh;
  private plinths: THREE.InstancedMesh;
  /** Open (railing-free) stretches in scene z (near > far); empty = railed everywhere (older courses). */
  private open: [number, number][] = [];
  private grooveMeshes: THREE.Mesh[] = [];
  private grooveMat: THREE.MeshBasicMaterial | null = null;
  private pieces() { return Math.ceil((this.reachBehind + this.reachAhead) / RAIL_PIECE) + 2; }

  constructor(quality: 'high' | 'medium' | 'low', private reachBehind = 24, private reachAhead = 150) {
    this.count = Math.ceil((reachBehind + reachAhead) / TILE) + 1;
    const tex = roadTexture(); tex.repeat.set(1, TILE / (SCENE.roadHalf * 2 + .4));
    const slabGeo = new THREE.BoxGeometry(SCENE.roadHalf * 2 + .4, .4, TILE).translate(0, -.2, 0);
    // Top face uses the texture; the sides keep a plain carved colour.
    const slabMat = [new THREE.MeshStandardMaterial({ color: 0xd9c9a8, roughness: .9 }), new THREE.MeshStandardMaterial({ color: 0xd9c9a8, roughness: .9 }),
      new THREE.MeshStandardMaterial({ map: tex, roughness: .78, metalness: .02 }), new THREE.MeshStandardMaterial({ color: 0xb8a582, roughness: .9 }),
      new THREE.MeshStandardMaterial({ color: 0xd9c9a8, roughness: .9 }), new THREE.MeshStandardMaterial({ color: 0xd9c9a8, roughness: .9 })];
    this.slabMaterials = slabMat;
    this.slabs = new THREE.InstancedMesh(slabGeo, slabMat, this.count); this.slabs.receiveShadow = true;
    const keelGeo = new THREE.CylinderGeometry(SCENE.roadHalf + .2, .6, 3.4, 6, 1, false).scale(1, 1, TILE / (SCENE.roadHalf * 2 + .4) * .9).translate(0, -2.1, 0);
    const keelMat = new THREE.MeshStandardMaterial({ color: 0x8c8178, roughness: 1, flatShading: true });
    this.keels = new THREE.InstancedMesh(keelGeo, keelMat, this.count);
    // A balustrade: a carved top rail on short posts, built from unit pieces clipped to the railed stretches.
    const railGeo = new THREE.BoxGeometry(.26, .12, 1).translate(0, .86, -.5);
    const railMat = new THREE.MeshStandardMaterial({ color: 0xf1e6cf, roughness: .7 });
    this.rails = new THREE.InstancedMesh(railGeo, railMat, this.pieces() * 2); this.rails.castShadow = quality === 'high';
    const postGeo = new THREE.CylinderGeometry(.075, .1, .82, 8).translate(0, .41, 0);
    this.posts = new THREE.InstancedMesh(postGeo, railMat, this.pieces() * 4); this.posts.castShadow = quality === 'high';
    const plinthGeo = new THREE.BoxGeometry(.34, .1, 1).translate(0, .05, -.5);
    this.plinths = new THREE.InstancedMesh(plinthGeo, railMat, this.pieces() * 2);
    this.disposables.push(postGeo, plinthGeo);
    const lanternGeo = new THREE.SphereGeometry(.13, 10, 8);
    const lanternMat = new THREE.MeshStandardMaterial({ color: 0xfff0b8, emissive: 0xffc861, emissiveIntensity: 2.2, roughness: .3 });
    this.lanterns = new THREE.InstancedMesh(lanternGeo, lanternMat, this.count * 2);
    for (const mesh of [this.slabs, this.keels, this.rails, this.lanterns, this.posts, this.plinths]) { mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.group.add(mesh); }
    for (const m of [...slabMat, keelMat, railMat, lanternMat]) cuttable(m, this.gaps);
    this.disposables.push(tex, slabGeo, keelGeo, railGeo, lanternGeo, keelMat, railMat, lanternMat, ...slabMat);

    // A round start dais behind the first metre of road.
    const padMat = new THREE.MeshStandardMaterial({ color: 0xf3e5c4, roughness: .7, emissive: 0x3a2a08, emissiveIntensity: .15 });
    this.startPad = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 5.6, .5, 32).translate(0, -.25, 0), padMat);
    this.startPad.position.z = 5; this.startPad.receiveShadow = true; this.group.add(this.startPad);
    this.disposables.push(this.startPad.geometry, padMat);
  }

  /** The authored road stone (albedo / normal / roughness) replaces the procedural flagstones. */
  setArt(art: SkyArt) {
    const keel = art.props6?.scene.getObjectByName('causeway_keel') as THREE.Mesh | undefined;
    if (keel?.isMesh) {
      this.keels.geometry = keel.geometry;
      const material = (keel.material as THREE.MeshStandardMaterial).clone();
      cuttable(material, this.gaps); this.keels.material = material; this.disposables.push(material);
    }
    if (!art.road) return;
    const top = this.slabMaterials[2];
    const scale = (t: THREE.Texture) => { const c = t.clone(); c.repeat.set(1, TILE / (SCENE.roadHalf * 2 + .4)); c.needsUpdate = true; this.disposables.push(c); return c; };
    top.map = scale(art.road.albedo); top.normalMap = scale(art.road.normal); top.roughnessMap = scale(art.road.rough);
    top.normalScale.set(.9, .9); top.roughness = 1; top.color.set(0xffffff); top.needsUpdate = true;
    if (art.ashlar) for (const i of [0, 1, 3, 4, 5]) {
      const m = this.slabMaterials[i]; const map = art.ashlar.albedo.clone(); map.repeat.set(2, .5); map.needsUpdate = true; this.disposables.push(map);
      m.map = map; m.color.set(0xe8dcc4); m.needsUpdate = true;
    }
  }
  /** Version 6: stretches without a railing (the hazard zones), in scene z (near, far). */
  setOpen(open: [number, number][]) { this.open = open; }
  /**
   * Rune grooves on the road where an advancing wall travels (two glowing rails per wall, from its rest plane back by
   * its travel), so the player sees the wall's path before it moves.
   */
  grooves(list: { near: number; far: number }[], time: number, reduced: boolean) {
    if (!this.grooveMat) { this.grooveMat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: .4, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }); }
    while (this.grooveMeshes.length < list.length * 2) { const m = new THREE.Mesh(new THREE.PlaneGeometry(.12, 1).rotateX(-Math.PI / 2).translate(0, .014, -.5), this.grooveMat); m.renderOrder = 1; this.group.add(m); this.grooveMeshes.push(m); }
    this.grooveMeshes.forEach((m, i) => {
      const g = list[i >> 1]; m.visible = !!g; if (!g) return;
      m.position.set((i % 2 ? 1 : -1) * (SCENE.roadHalf - .55), 0, g.near); m.scale.z = Math.max(.01, g.near - g.far);
    });
    this.grooveMat.opacity = .28 + (reduced ? 0 : .12 * Math.sin(time * 3));
  }
  /** Gaps in scene z (near, far); unused slots are pushed out of reach. */
  setGaps(gaps: [number, number][]) {
    for (let i = 0; i < MAX_GAPS; i++) { const g = gaps[i]; this.gaps.value[i].set(g ? g[0] : 1e6, g ? g[1] : 1e6); }
  }

  /** Tiles from just behind the camera to far ahead; the road ends a little after the finish plaza. */
  update(cameraZ: number, finishZ: number) {
    const first = Math.floor((cameraZ + this.reachBehind) / TILE);
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const z = (first - i) * TILE - TILE / 2;
      const visible = z < 2 + TILE && z > finishZ - 40;
      this.matrix.makeTranslation(0, visible ? 0 : -500, z);
      this.slabs.setMatrixAt(i, this.matrix); this.keels.setMatrixAt(i, this.matrix);
      const lanternZ = z + TILE / 2 - .2, lit = visible && this.railedAt(lanternZ);
      for (const side of [-1, 1]) {
        this.matrix.makeTranslation(side * (SCENE.roadHalf + .12), lit ? 1.12 : -500, lanternZ); this.lanterns.setMatrixAt(n, this.matrix);
        n++;
      }
    }
    // Railing pieces, each clipped to the railed part of its length (a railing never stands over an open edge).
    const pieces = this.pieces(), firstPiece = Math.floor((cameraZ + this.reachBehind) / RAIL_PIECE);
    const scale = new THREE.Matrix4(), place = new THREE.Matrix4();
    let r = 0, q = 0;
    for (let i = 0; i < pieces; i++) {
      const near = (firstPiece - i) * RAIL_PIECE, far = near - RAIL_PIECE;
      let segs: [number, number][] = near > 2 + TILE || far < finishZ - 40 ? [] : [[far, near]];
      for (const [on, of] of this.open) segs = segs.flatMap(([lo, hi]): [number, number][] => { if (on <= lo || of >= hi) return [[lo, hi]]; const out: [number, number][] = []; if (of > lo) out.push([lo, of]); if (on < hi) out.push([on, hi]); return out; });
      let a = far, b = far; for (const [lo, hi] of segs) if (hi - lo > a - b) { a = hi; b = lo; }
      const len = a - b;
      for (const side of [-1, 1]) {
        const x = side * (SCENE.roadHalf + .12);
        if (len > .02) { place.makeTranslation(x, 0, a); scale.makeScale(1, 1, len); this.rails.setMatrixAt(r, place.clone().multiply(scale)); this.plinths.setMatrixAt(r, place.clone().multiply(scale)); }
        else { place.makeTranslation(0, -500, 0); this.rails.setMatrixAt(r, place); this.plinths.setMatrixAt(r, place); }
        r++;
        for (const at of [a - .01, a - len / 2]) { place.makeTranslation(x, len > .02 ? 0 : -500, at); this.posts.setMatrixAt(q, place); q++; }
      }
    }
    for (const mesh of [this.slabs, this.keels, this.rails, this.lanterns, this.posts, this.plinths]) mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Runways for the current wall: `approach` 0..1 grows as the runner nears it; `aim` is the door the runner is lined
   * up with (−1 for none), `tried` doors the server rejected.
   */
  runway(gates: number, wallZ: number, approach: number, aim: number, tried: number[], spacing: number, time: number, reduced: boolean, offset = 0) {
    if (this.runwayGates !== gates) {
      for (const r of this.runways) { this.group.remove(r); r.geometry.dispose(); }
      for (const m of this.runwayMats) m.dispose();
      this.runways = []; this.runwayMats = []; this.runwayGates = gates;
      for (let i = 0; i < gates; i++) {
        const mat = new THREE.MeshBasicMaterial({ color: LANE_COLORS[i % LANE_COLORS.length], transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
        const w = doorHalfWidth(gates, spacing) * 2;
        const strip = new THREE.Mesh(new THREE.PlaneGeometry(w, 22).rotateX(-Math.PI / 2).translate(0, .012, 11), mat);
        strip.position.x = laneX(i, gates); strip.renderOrder = 1;
        this.group.add(strip); this.runways.push(strip); this.runwayMats.push(mat);
      }
    }
    this.runways.forEach((strip, i) => {
      strip.position.z = wallZ + .3; strip.position.x = laneX(i, gates) + offset;
      const pulse = reduced ? 1 : .85 + .15 * Math.sin(time * 4 + i);
      const base = tried.includes(i) ? .04 : .1 + (aim === i ? .14 : 0);
      this.runwayMats[i].opacity = gates ? Math.max(0, Math.min(1, approach)) * base * pulse : 0;
    });
  }
  hideRunway() { for (const m of this.runwayMats) m.opacity = 0; }
  private railedAt(z: number) { for (const [near, far] of this.open) if (z <= near && z >= far) return false; return true; }

  /** A tall golden finish arch over the plaza. */
  finish(z: number, font: string, label: string) {
    if (!this.finishArch) {
      const gold = new THREE.MeshStandardMaterial({ color: 0xf4c768, metalness: .7, roughness: .25, emissive: 0x6b4209, emissiveIntensity: .5 });
      const stoneMat = new THREE.MeshStandardMaterial({ color: 0xf6ead2, roughness: .75 });
      this.finishMaterials.push(gold, stoneMat);
      const arch = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(SCENE.roadHalf + .9, .32, 12, 48, Math.PI), gold); ring.position.y = 3.6; arch.add(ring);
      for (const side of [-1, 1]) {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(.55, .7, 4.2, 12), stoneMat); pillar.position.set(side * (SCENE.roadHalf + .9), 1.9, 0); arch.add(pillar);
      }
      const c = document.createElement('canvas'); c.width = 1024; c.height = 220; const g = c.getContext('2d')!;
      g.fillStyle = 'rgba(20,32,70,.92)'; g.beginPath(); g.roundRect(8, 8, 1008, 204, 60); g.fill(); g.lineWidth = 10; g.strokeStyle = '#f4c768'; g.stroke();
      g.fillStyle = '#fff4d6'; g.font = `800 120px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, 512, 118);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const bannerMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false });
      this.finishMaterials.push(bannerMat); this.disposables.push(tex);
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.38), bannerMat); banner.position.set(0, 9.2, .4); arch.add(banner);
      const plaza = new THREE.Mesh(new THREE.CylinderGeometry(9, 8, .5, 40).translate(0, -.26, 0), stoneMat); plaza.position.z = -10; plaza.receiveShadow = true; arch.add(plaza);
      this.finishArch = arch; this.group.add(arch);
    }
    this.finishArch.position.z = z;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    for (const r of this.runways) r.geometry.dispose();
    for (const m of this.runwayMats) m.dispose();
    this.finishArch?.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    for (const m of this.finishMaterials) m.dispose();
    this.slabs.dispose(); this.keels.dispose(); this.rails.dispose(); this.lanterns.dispose(); this.posts.dispose(); this.plinths.dispose();
    for (const m of this.grooveMeshes) m.geometry.dispose(); this.grooveMat?.dispose();
  }
}
