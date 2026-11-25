import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Orb, OrbKind } from '../rushReforged';
import { SCENE, toX, toZ } from './skyScale';

/**
 * Orbs of Course version 6, drawn where the server planned them (x, y, height). Each kind has its own silhouette and
 * colour so it reads at a glance — Speed (amber wing rune), Energy (Echo's cyan swirl), Guard (violet shield crystal).
 * A taken orb pops and is gone for this racer; the authority decides pickups in races (the HUD names them).
 */
const COLOR: Record<OrbKind, number> = { SPEED: 0xffc24a, ENERGY: 0x5ff0ff, GUARD: 0xb18cff };
interface Slot { kind: OrbKind; root: THREE.Group; halo: THREE.Sprite; body: THREE.Object3D; pop: number }

function fallback(kind: OrbKind) {
  const g = new THREE.Group();
  const glow = new THREE.MeshStandardMaterial({ color: COLOR[kind], emissive: COLOR[kind], emissiveIntensity: 1.4, roughness: .2, metalness: .1, transparent: true, opacity: .92 });
  const core = kind === 'SPEED' ? new THREE.IcosahedronGeometry(.24, 0) : kind === 'ENERGY' ? new THREE.SphereGeometry(.24, 20, 14) : new THREE.OctahedronGeometry(.28, 0);
  g.add(new THREE.Mesh(core, glow));
  const ringMat = new THREE.MeshStandardMaterial({ color: 0xf6e3b0, metalness: .8, roughness: .25, emissive: COLOR[kind], emissiveIntensity: .35 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.36, .03, 8, 36), ringMat); g.add(ring);
  if (kind === 'SPEED') for (const s of [-1, 1]) { const wing = new THREE.Mesh(new THREE.ConeGeometry(.1, .42, 4).rotateZ(s * Math.PI / 2), glow); wing.position.x = s * .42; g.add(wing); }
  return g;
}
let haloTexture: THREE.CanvasTexture | null = null;
function halo() {
  if (haloTexture) return haloTexture;
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62); grad.addColorStop(0, 'rgba(255,255,255,.95)'); grad.addColorStop(.25, 'rgba(255,255,255,.45)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  haloTexture = new THREE.CanvasTexture(c); haloTexture.colorSpace = THREE.SRGBColorSpace; return haloTexture;
}

export class SkyOrbs {
  readonly group = new THREE.Group();
  private slots = new Map<number, Slot>();
  private templates: Partial<Record<OrbKind, THREE.Object3D>> = {};
  private disposables: { dispose(): void }[] = [];

  setArt(props: GLTF | null) {
    if (!props) return;
    const names: Record<string, OrbKind> = { orb_speed: 'SPEED', orb_energy: 'ENERGY', orb_guard: 'GUARD' };
    props.scene.traverse(o => { const kind = names[o.name]; if (kind) this.templates[kind] = o; });
    for (const [id, slot] of this.slots) { this.group.remove(slot.root); this.slots.delete(id); }
  }

  private build(o: Orb): Slot {
    const root = new THREE.Group(), template = this.templates[o.kind];
    const body = template ? template.clone() : fallback(o.kind);
    if (!template) body.traverse(m => { const mesh = m as THREE.Mesh; if (mesh.isMesh) { this.disposables.push(mesh.geometry, mesh.material as THREE.Material); } });
    const mat = new THREE.SpriteMaterial({ map: halo(), color: COLOR[o.kind], transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: .7 });
    const glow = new THREE.Sprite(mat); glow.scale.setScalar(1.25); this.disposables.push(mat);
    root.add(body, glow); this.group.add(root);
    // A thin light column under ground-level orbs makes them easy to find from far away.
    return { kind: o.kind, root, halo: glow, body, pop: -1 };
  }

  /** Keep the orbs near the viewer posed; `taken` are this racer's pickups (they pop once, then vanish). */
  update(orbs: Orb[] | undefined, taken: number[] | undefined, viewY: number, time: number, dt: number, reduced: boolean) {
    const keep = new Set<number>(), gone = new Set(taken ?? []);
    for (const o of orbs ?? []) {
      if (o.y < viewY - 500 || o.y > viewY + 6500) continue;
      let slot = this.slots.get(o.id);
      if (gone.has(o.id) && (!slot || slot.pop < 0 && slot.root.visible === false)) continue;
      keep.add(o.id);
      if (!slot) { slot = this.build(o); this.slots.set(o.id, slot); }
      const bob = reduced ? 0 : Math.sin(time * 2.2 + o.id) * .07;
      slot.root.position.set(toX(o.x), o.z * SCENE.kx + bob, toZ(o.y));
      slot.body.rotation.y = reduced ? 0 : time * (o.kind === 'SPEED' ? 2.4 : 1.4) + o.id;
      if (gone.has(o.id) && slot.pop < 0) slot.pop = 0;
      if (slot.pop >= 0) {
        slot.pop += dt; const k = slot.pop / .35;
        slot.root.scale.setScalar(1 + k * 1.2); (slot.halo.material as THREE.SpriteMaterial).opacity = Math.max(0, .9 * (1 - k));
        slot.body.visible = k < .35;
        if (k >= 1) { slot.root.visible = false; slot.pop = -2; }
      } else (slot.halo.material as THREE.SpriteMaterial).opacity = .55 + (reduced ? 0 : .2 * Math.sin(time * 4 + o.id));
    }
    for (const [id, slot] of this.slots) if (!keep.has(id)) { this.group.remove(slot.root); this.slots.delete(id); }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables = []; this.slots.clear();
    haloTexture?.dispose(); haloTexture = null;
  }
}
