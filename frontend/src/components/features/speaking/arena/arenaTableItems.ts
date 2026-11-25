import * as T from 'three';
import type { GraspShape, HandContact } from '@/lib/embodiment/human';
import type { ArenaItemState } from '@/types/speakingArena';
import { arenaFloor, arenaInReach, arenaLayout } from './arenaTerrain';

/** Original surfaces for objects learners can examine together. The chart uses the playable layout. */
function printedFace(kind: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 384;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#eee2bd'; g.fillRect(0, 0, 512, 384);
  g.strokeStyle = '#a77c46'; g.lineWidth = 3; g.strokeRect(16, 16, 480, 352);
  g.fillStyle = '#214d50'; g.textAlign = 'center'; g.font = 'bold 23px Georgia';
  g.fillText(kind === 'atlas' ? 'TIDEGARDEN   /   SEA CHART' : 'COASTAL FIELD JOURNAL', 256, 51);
  if (kind === 'atlas') {
    const px = (x: number) => 250 + x * 1.48, py = (z: number) => 211 + z * 1.42;
    g.fillStyle = '#d0e4d7'; g.fillRect(26, 65, 460, 283);
    for (const i of arenaLayout.islands) {
      g.beginPath(); g.arc(px(i.x), py(i.z), i.radius * 1.23, 0, Math.PI * 2);
      g.fillStyle = '#bdc593'; g.fill(); g.strokeStyle = '#586e4c'; g.stroke();
    }
    for (const d of arenaLayout.docks) {
      g.beginPath(); g.moveTo(px(d.ax), py(d.az)); g.lineTo(px(d.bx), py(d.bz));
      g.strokeStyle = '#8b562c'; g.lineWidth = 4; g.stroke();
    }
    g.font = 'bold 18px Georgia'; g.fillStyle = '#244c48'; g.fillText('N', 451, 99);
    g.beginPath(); g.moveTo(451, 105); g.lineTo(446, 128); g.lineTo(451, 121); g.lineTo(456, 128); g.fill();
  } else {
    g.strokeStyle = '#5e774b'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(105, 310); g.quadraticCurveTo(211, 220, 258, 92); g.stroke();
    for (let i = 0; i < 12; i++) {
      const t = i / 12, x = 125 + t * 115, y = 285 - t * 178, s = i % 2 ? 1 : -1;
      g.fillStyle = i > 8 ? '#ab526a' : '#78915f'; g.beginPath(); g.moveTo(x, y);
      g.quadraticCurveTo(x + s * 48, y - 4, x + s * 62, y - 42); g.quadraticCurveTo(x + s * 15, y - 40, x, y); g.fill();
    }
    g.fillStyle = '#63553c'; g.font = 'italic 20px Georgia';
    for (const [i, t] of ['Sea breeze', 'Palm fronds', 'Low tide'].entries()) g.fillText(t, 368, 145 + i * 54);
  }
  const texture = new T.CanvasTexture(canvas); texture.colorSpace = T.SRGBColorSpace;
  return texture;
}

/** How each object is held: its outline at grip height (rectangle half extents or a radius), and the fingers' pose. */
const HOLD: Record<string, { half?: [number, number]; radius?: number; gripY: number; grip: HandContact['grip']; thick: number }> = {
  atlas: { half: [.18, .14], gripY: .018, grip: 'book', thick: .036 },
  journal: { half: [.18, .14], gripY: .018, grip: 'book', thick: .036 },
  compass: { radius: .134, gripY: .022, grip: 'book', thick: .045 },
  ledger: { radius: .1, gripY: .13, grip: 'cylinder', thick: .24 },
};
/** Spots on a table (centre and four around it), the same as the server's placeItem. */
const SLOTS: [number, number][] = [[0, 0], [.34, 0], [-.34, 0], [0, .34], [0, -.34]];
const UP = new T.Vector3(0, 1, 0);

interface Item {
  id: string;
  kind: string;
  group: T.Group;
  rest: ArenaItemState;
  /** 0 resting on its table .. 1 in the hands. */
  hold: number;
  turn: number;
  left: HandContact;
  right: HandContact;
}

export function arenaTableItems(scene: T.Scene) {
  const items = new Map<string, Item>();
  const paper = new T.MeshStandardMaterial({ color: '#e7d7ac', roughness: .89 });
  const brass = new T.MeshStandardMaterial({ color: '#c29247', metalness: .55, roughness: .32 });
  const teal = new T.MeshStandardMaterial({ color: '#30625e', roughness: .65 });
  const coral = new T.MeshStandardMaterial({ color: '#a4433b', roughness: .59 });
  const glass = new T.MeshStandardMaterial({ color: '#9cc9c7', transparent: true, opacity: .28, depthWrite: false });
  const textures: T.Texture[] = [];
  const add = (root: T.Group, geometry: T.BufferGeometry, material: T.Material, x = 0, y = 0, z = 0) => {
    const m = new T.Mesh(geometry, material); m.position.set(x, y, z); m.castShadow = true; root.add(m); return m;
  };
  for (const spec of arenaLayout.interactables.filter(i => i.kind === 'artifact')) {
    const g = new T.Group(); g.name = spec.id;
    const kind = spec.id.slice(9);
    if (kind === 'atlas' || kind === 'journal') {
      add(g, new T.BoxGeometry(.36, .032, .28), teal);
      add(g, new T.BoxGeometry(.346, .022, .265), paper, 0, .025, 0);
      const texture = printedFace(kind); textures.push(texture);
      const page = add(g, new T.PlaneGeometry(.338, .254), new T.MeshStandardMaterial({ map: texture, roughness: .93 }), 0, .037, 0);
      page.rotation.x = -Math.PI / 2;
      add(g, new T.BoxGeometry(.018, .043, .28), brass, -.173, .007, 0);
    } else if (kind === 'compass') {
      add(g, new T.CylinderGeometry(.134, .12, .045, 40), brass);
      add(g, new T.CylinderGeometry(.115, .115, .009, 40), paper, 0, .026, 0);
      for (let i = 0; i < 16; i++) {
        const a = i * Math.PI / 8; const tick = add(g, new T.BoxGeometry(.003, .004, i % 4 ? .01 : .021), teal, Math.sin(a) * .099, .033, Math.cos(a) * .099); tick.rotation.y = a;
      }
      for (const side of [-1, 1]) {
        const needle = add(g, new T.ConeGeometry(.019, .093, 4), side > 0 ? coral : teal, 0, .039, side * .045);
        needle.rotation.x = side * Math.PI / 2; needle.scale.z = .25;
      }
      add(g, new T.SphereGeometry(.012, 12, 8), brass, 0, .046, 0);
    } else {
      for (const y of [.012, .255]) add(g, new T.CylinderGeometry(.105, .105, .02, 24), brass, 0, y, 0);
      const profile = [new T.Vector2(.071, .025), new T.Vector2(.069, .058), new T.Vector2(.011, .124), new T.Vector2(.011, .144), new T.Vector2(.069, .214), new T.Vector2(.071, .245)];
      add(g, new T.LatheGeometry(profile, 32), glass);
      add(g, new T.ConeGeometry(.063, .066, 24), paper, 0, .059, 0);
      for (let i = 0; i < 3; i++) { const a = i * Math.PI * 2 / 3; add(g, new T.CylinderGeometry(.006, .006, .24, 8), brass, Math.cos(a) * .087, .134, Math.sin(a) * .087); }
    }
    const rest: ArenaItemState = { id: spec.id, table: null, x: spec.x, z: spec.z, y: arenaFloor(spec.x, spec.z), yaw: spec.yaw };
    const table = arenaLayout.furniture.find(f => f.kind === 'table' && Math.hypot(f.x - spec.x, f.z - spec.z) < .5);
    rest.table = table?.id ?? null;
    g.position.set(rest.x, rest.y + .018, rest.z);
    g.rotation.y = rest.yaw + Math.PI;
    scene.add(g);
    const spec2 = HOLD[kind] ?? HOLD.compass;
    // One stable contact (and shape function) per hand: the finger fit is kept while the grip holds.
    const contact = (): HandContact => {
      const c: HandContact = { wrist: new T.Vector3(), fingers: new T.Vector3(), palm: new T.Vector3(), grip: spec2.grip };
      const at = new T.Vector3(), q = new T.Quaternion();
      c.shape = (): GraspShape => {
        g.updateWorldMatrix(true, false);
        at.set(0, spec2.gripY, 0).applyMatrix4(g.matrixWorld);
        g.getWorldQuaternion(q);
        const toLocal = new T.Matrix4().compose(at, q, new T.Vector3(1, 1, 1)).invert();
        return spec2.half
          ? { kind: 'box', toLocal, half: [spec2.half[0], spec2.thick / 2, spec2.half[1]] }
          : { kind: 'cyl', toLocal, half: [spec2.radius!, spec2.thick / 2, spec2.radius!] };
      };
      return c;
    };
    items.set(spec.id, { id: spec.id, kind, group: g, rest, hold: 0, turn: 0, left: contact(), right: contact() });
  }

  const target = new T.Vector3(), q = new T.Quaternion(), q2 = new T.Quaternion(), restQ = new T.Quaternion(), restP = new T.Vector3();
  const fwd = new T.Vector3(), left = new T.Vector3(), basis = new T.Matrix4(), ex = new T.Vector3(), ey = new T.Vector3(), ez = new T.Vector3();
  const centre = new T.Vector3(), dir = new T.Vector3(), towards = new T.Vector3();

  function restPose(item: Item) {
    restP.set(item.rest.x, item.rest.y + .018, item.rest.z);
    restQ.setFromAxisAngle(UP, item.rest.yaw + Math.PI);
  }

  /** Set an object's rest from the room (or from a local placement in the preview). */
  function setRest(state: ArenaItemState) {
    const item = items.get(state.id);
    if (item) item.rest = { ...state };
  }

  return {
    items,
    setRest,
    /** The rooms' item list is the truth for where everything rests. */
    syncRests(list: readonly ArenaItemState[] | undefined) { if (list) for (const s of list) setRest(s); },
    /**
     * In the hands: carried in front of the waist, page tilted towards the eyes; inspecting, raised before the eyes with
     * the face turned to them. `turn` (eighths of a turn, from the room) spins it in the hands. Reached over 0.35 s.
     */
    hold(id: string, body: { root: T.Object3D; eye: T.Vector3; look: T.Vector3 }, inspecting: boolean, turn: number, dt: number) {
      const item = items.get(id);
      if (!item) return;
      const yaw = body.root.rotation.y;
      fwd.set(Math.sin(yaw), 0, Math.cos(yaw)); left.set(Math.cos(yaw), 0, -Math.sin(yaw));
      item.turn += (turn * Math.PI / 4 - item.turn) * (1 - Math.exp(-10 * dt));
      if (inspecting) {
        target.copy(body.eye).addScaledVector(body.look, .42).addScaledVector(UP, -.05);
        ey.copy(body.eye).sub(target).normalize(); // face towards the eyes
        ez.copy(UP).addScaledVector(ey, -ey.dot(UP)).normalize().negate(); // top of the page (local -z) up
        ex.crossVectors(ey, ez).normalize();
        basis.makeBasis(ex, ey, ez);
        q.setFromRotationMatrix(basis).multiply(q2.setFromAxisAngle(UP, item.turn));
      } else {
        target.copy(body.root.position).addScaledVector(fwd, .34).addScaledVector(UP, 1.02);
        q.setFromAxisAngle(left, -.42).multiply(q2.setFromAxisAngle(UP, yaw + Math.PI + item.turn));
      }
      item.hold = Math.min(1, item.hold + dt / .35);
      const s = item.hold * item.hold * (3 - 2 * item.hold);
      restPose(item);
      item.group.position.lerpVectors(restP, target, s);
      // A small lift on the way: never slide through the table top.
      item.group.position.y += Math.sin(s * Math.PI) * .08;
      item.group.quaternion.slerpQuaternions(restQ, q, s);
      item.group.updateMatrixWorld(true);
    },
    /** Not held: back to (or staying at) its rest place. */
    settle(id: string, dt: number) {
      const item = items.get(id);
      if (!item) return;
      restPose(item);
      if (item.hold <= 0) { item.group.position.copy(restP); item.group.quaternion.copy(restQ); item.turn = 0; return; }
      item.hold = Math.max(0, item.hold - dt / .35);
      const s = item.hold * item.hold * (3 - 2 * item.hold);
      item.group.position.lerp(restP, 1 - s);
      item.group.position.y = Math.max(item.group.position.y, restP.y);
      item.group.quaternion.slerp(restQ, 1 - s);
    },
    /**
     * Both hands on the object as it is drawn now: each on the edge facing that hand's side, palm towards the centre, thumb
     * over the top and the fingers under it. As the object turns the hands keep to its edges.
     */
    contacts(id: string, body: { root: T.Object3D }) {
      const item = items.get(id);
      if (!item || item.hold < .02) return null;
      const h = HOLD[item.kind] ?? HOLD.compass, m = item.group.matrixWorld;
      ex.setFromMatrixColumn(m, 0).normalize(); ey.setFromMatrixColumn(m, 1).normalize(); ez.setFromMatrixColumn(m, 2).normalize();
      centre.set(0, h.gripY, 0).applyMatrix4(m);
      const yaw = body.root.rotation.y;
      left.set(Math.cos(yaw), 0, -Math.sin(yaw));
      for (const side of [-1, 1] as const) {
        const c = side < 0 ? item.left : item.right;
        // Direction of this hand's side, laid in the object's plane.
        dir.copy(left).multiplyScalar(-side).addScaledVector(ey, side * left.dot(ey));
        if (dir.lengthSq() < 1e-6) dir.copy(ex).multiplyScalar(-side);
        dir.normalize();
        let reach: number;
        if (h.half) {
          const ax = Math.abs(dir.dot(ex)), az = Math.abs(dir.dot(ez));
          reach = Math.min(ax > 1e-4 ? h.half[0] / ax : Infinity, az > 1e-4 ? h.half[1] / az : Infinity);
        } else reach = h.radius!;
        const edge = target.copy(centre).addScaledVector(dir, reach);
        c.palm.copy(dir).negate();
        // Fingers: towards the far side of the object and down under it (the thumb stays on top).
        towards.copy(ey).negate().multiplyScalar(.55);
        fwd.crossVectors(UP, dir).multiplyScalar(side).normalize();
        c.fingers.copy(fwd).multiplyScalar(.8).add(towards);
        c.fingers.addScaledVector(c.palm, -c.fingers.dot(c.palm)).normalize();
        c.wrist.copy(edge).addScaledVector(c.palm, -.024).addScaledVector(c.fingers, -.072);
      }
      return { left: item.left, right: item.right };
    },
    /**
     * Preview (no room) only: put the object on a table spot as the server would. Null when no table is within reach or
     * every spot is taken.
     */
    placeLocal(id: string, tableId: string, px: number, pz: number, yaw: number) {
      const item = items.get(id), table = arenaLayout.furniture.find(f => f.kind === 'table' && f.id === tableId);
      if (!item || !table || Math.hypot(px - table.x, pz - table.z) > 1.9 || !arenaInReach(px, pz, table.x, table.z)) return false;
      const c = Math.cos(table.yaw), s = Math.sin(table.yaw);
      let best: [number, number] | null = null, bestD = Infinity;
      for (const [u, v] of SLOTS) {
        const x = table.x + c * u + s * v, z = table.z - s * u + c * v;
        if ([...items.values()].some(o => o !== item && Math.hypot(o.rest.x - x, o.rest.z - z) < .3)) continue;
        const d = Math.hypot(px - x, pz - z);
        if (d < bestD) { bestD = d; best = [x, z]; }
      }
      if (!best) return false;
      item.rest = { id, table: table.id, x: best[0], z: best[1], y: arenaFloor(table.x, table.z), yaw };
      return true;
    },
    /** The table within reach of a learner standing here, for setting something down. */
    tableNear(px: number, pz: number) {
      let best: { id: string; d: number } | null = null;
      for (const f of arenaLayout.furniture) {
        if (f.kind !== 'table') continue;
        const d = Math.hypot(px - f.x, pz - f.z);
        if (d <= 1.85 && arenaInReach(px, pz, f.x, f.z) && (!best || d < best.d)) best = { id: f.id, d };
      }
      return best?.id ?? null;
    },
    dispose() { for (const t of textures) t.dispose(); },
  };
}
