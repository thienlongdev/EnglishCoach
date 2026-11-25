import * as T from 'three';
import { GROUND_Y } from '@/lib/echo-life/plan';
import type { EnterableBuilding } from '@/lib/echo-life/buildings';
import type { Furnishing } from '@/lib/echo-life/plan';
import type { EchoLifeGame } from '@/lib/echo-life/game/session';
import { patchHeightFog } from './atmosphere';
import { getInFlightCompileCount, patchMaterialWithEchoCsm } from './echoCsm';
import { getEchoLifeResidencyManager } from './residencyManager';
import { freezeStaticHierarchy } from './scratch';
import {
  acquireStreetProp,
  instanceStreetProp,
  placeStreetPropOn,
  releaseStreetProp,
  type StreetPropKey,
} from './streetPropsManifest';

const packages = [
  { id: 'noodles', label: 'NOODLES', color: '#95753a', w: .22, h: .18, d: .16 },
  { id: 'rice', label: 'RICE', color: '#2e685f', w: .21, h: .25, d: .12 },
  { id: 'eggs', label: 'FRESH EGGS', color: '#967952', w: .23, h: .10, d: .17 },
  { id: 'kit', label: 'FESTIVAL PAPER', color: '#924756', w: .24, h: .15, d: .07 },
  { id: 'tea', label: 'JASMINE TEA', color: '#507d54', w: .17, h: .21, d: .15 },
];

type CommercialShopId =
  | 'electronics_shop'
  | 'furniture_shop'
  | 'clothing_shop'
  | 'vehicle_dealer'
  | 'home_center'
  | 'repair_shop';

const COMMERCIAL_SHOPS: readonly CommercialShopId[] = [
  'electronics_shop',
  'furniture_shop',
  'clothing_shop',
  'vehicle_dealer',
  'home_center',
  'repair_shop',
];

interface BoxItem {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  rotY: number;
  color: number;
}

function nearBuilding(b: EnterableBuilding | undefined, player: { x: number; z: number }, pad = 7): boolean {
  return !!b &&
    player.x >= b.rect.x0 - pad && player.x <= b.rect.x1 + pad &&
    player.z >= b.rect.z0 - pad && player.z <= b.rect.z1 + pad;
}

function placeLocal(f: Furnishing, lx: number, ly: number, lz: number): { x: number; y: number; z: number } {
  const cos = Math.cos(f.rotY), sin = Math.sin(f.rotY);
  return {
    x: f.x + lx * cos + lz * sin,
    y: f.y + ly,
    z: f.z - lx * sin + lz * cos,
  };
}

function buildSingleBatch(
  name: string,
  items: readonly BoxItem[],
  geometry: T.BufferGeometry,
  material: T.Material,
): T.InstancedMesh {
  const mesh = new T.InstancedMesh(geometry, material, Math.max(1, items.length));
  mesh.name = name;
  const tf = new T.Object3D();
  const color = new T.Color();
  items.forEach((it, idx) => {
    tf.position.set(it.x, it.y, it.z);
    tf.rotation.set(0, it.rotY, 0);
    tf.scale.set(it.w, it.h, it.d);
    tf.updateMatrix();
    mesh.setMatrixAt(idx, tf.matrix);
    color.setHex(it.color);
    mesh.setColorAt(idx, color);
  });
  mesh.count = items.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  patchMaterialWithEchoCsm(material);
  patchHeightFog(material);
  return mesh;
}

type AaaShopPlacement = {
  readonly id: StreetPropKey;
  readonly placements: ReadonlyArray<{ x: number; y: number; z: number; rotY: number; scale?: number }>;
};

interface AaaShopBucket {
  readonly parent: T.Group;
  readonly specs: AaaShopPlacement[];
  readonly owned: { dispose(): void }[];
  readonly refs: StreetPropKey[];
  mounted: boolean;
  epoch: number;
  lastActiveMs: number;
}

/**
 * Distance-culled (`< 7 m`) stocked merchandise & display props across all 9 Riverside commercial shops:
 *  - Sunrise Market reactive grocery SKUs (`stock:noodles..tea`) + bakery loaves & produce crates
 *  - Willow Corner Bistro & Pixel Café pastries, espresso bar cups, and booth refreshments
 *  - Single-draw-call instanced display stock for Volt & Silicon, Riverside Living, Thread & Campus,
 *    Greenway Motors, Timber & Stone Homeworks, and Tech & Fix Repair Workshop.
 */
export class MarketStock {
  readonly group = new T.Group();
  private marketGroup = new T.Group();
  private cafeGroup = new T.Group();
  private shopGroups = new Map<CommercialShopId, T.Group>();
  private batches: T.InstancedMesh[] = [];
  private cafeMeshes: T.InstancedMesh[] = [];
  private extraMeshes: T.InstancedMesh[] = [];
  private extraMats: T.Material[] = [];
  private cafeMats: T.Material[] = [];
  private readonly marketAaa: AaaShopBucket;
  private readonly cafeAaa: AaaShopBucket;
  private lastIdleCheckMs = 0;
  private disposed = false;
  private atlas?: T.CanvasTexture;
  private material?: T.MeshStandardMaterial;

  constructor(parent: T.Group) {
    this.group.name = 'sunrise-market-stock';
    this.marketGroup.name = 'market-goods';
    this.cafeGroup.name = 'cafe-bistro-goods';
    this.marketAaa = { parent: this.marketGroup, specs: [], owned: [], refs: [], mounted: false, epoch: 0, lastActiveMs: 0 };
    this.cafeAaa = { parent: this.cafeGroup, specs: [], owned: [], refs: [], mounted: false, epoch: 0, lastActiveMs: 0 };
    this.group.add(this.marketGroup, this.cafeGroup);
    parent.add(this.group);
  }

  private registerAaaProp(
    bucket: AaaShopBucket,
    id: StreetPropKey,
    placements: ReadonlyArray<{ x: number; y: number; z: number; rotY: number; scale?: number }>,
  ) {
    if (!placements.length || this.disposed) return;
    bucket.specs.push({ id, placements });
  }

  private mountAaaBucket(bucket: AaaShopBucket) {
    if (this.disposed || bucket.mounted || !bucket.specs.length) return;
    bucket.mounted = true;
    const epoch = ++bucket.epoch;
    for (const spec of bucket.specs) {
      bucket.refs.push(spec.id);
      void acquireStreetProp(spec.id).then((prop) => {
        if (this.disposed || bucket.epoch !== epoch || !prop) return;
        const matrices = spec.placements.map((p) =>
          placeStreetPropOn(p.x, p.y, p.z, p.rotY, p.scale ?? 1, undefined, spec.id),
        );
        const grp = instanceStreetProp(prop, matrices, false);
        grp.name = `shop-aaa-prop:${spec.id}`;
        bucket.parent.add(grp);
        freezeStaticHierarchy(grp);
        bucket.owned.push({
          dispose() {
            grp.traverse((o) => {
              if (o instanceof T.InstancedMesh) o.dispose();
            });
            grp.removeFromParent();
          },
        });
      });
    }
  }

  private releaseAaaBucket(bucket: AaaShopBucket): boolean {
    if (!bucket.mounted && !bucket.owned.length && !bucket.refs.length) return false;
    bucket.mounted = false;
    bucket.epoch++;
    for (const r of bucket.owned) r.dispose();
    bucket.owned.length = 0;
    for (const key of bucket.refs) releaseStreetProp(key);
    bucket.refs.length = 0;
    return true;
  }

  /**
   * Releases idle AAA interior shop props (`shopCashRegister`, `cafeCoffeeCart`, `libPottedPlant`)
   * once the player has left Market or Café/Bistro for `>= idleMs` (default `45 s`), letting
   * `EchoLifeResidencyManager` evict their textures safely under VRAM pressure while never thrashing
   * on doorway exits or disposing mid-compile.
   */
  releaseInactiveProps(idleMs = 45_000): void {
    if (this.disposed || getInFlightCompileCount() > 0) return;
    const effectiveIdleMs = Math.max(45_000, idleMs);
    const now = Date.now();
    let releasedAny = false;
    if (!this.marketGroup.visible && this.marketAaa.mounted && now - this.marketAaa.lastActiveMs >= effectiveIdleMs) {
      releasedAny = this.releaseAaaBucket(this.marketAaa) || releasedAny;
    }
    if (!this.cafeGroup.visible && this.cafeAaa.mounted && now - this.cafeAaa.lastActiveMs >= effectiveIdleMs) {
      releasedAny = this.releaseAaaBucket(this.cafeAaa) || releasedAny;
    }
    if (releasedAny) {
      getEchoLifeResidencyManager().evictIfNeeded();
    }
  }

  private stockShelves(shelves: Furnishing[], store: EnterableBuilding) {
    const label = document.createElement('canvas');
    label.width = 256; label.height = 128 * packages.length;
    const ctx = label.getContext('2d')!;
    this.atlas = new T.CanvasTexture(label);
    this.atlas.colorSpace = T.SRGBColorSpace;
    this.material = new T.MeshStandardMaterial({ map: this.atlas, roughness: .72 });
    patchMaterialWithEchoCsm(this.material);
    patchHeightFog(this.material);
    const transform = new T.Object3D();
    packages.forEach((product, i) => {
      const row = i * 128;
      ctx.fillStyle = product.color; ctx.fillRect(0, row, 256, 128);
      ctx.fillStyle = '#f5ecd6'; ctx.fillRect(10, row + 8, 236, 112);
      ctx.fillStyle = product.color; ctx.textAlign = 'center';
      ctx.font = 'bold 16px sans-serif'; ctx.fillText('SUNRISE MARKET', 128, row + 38);
      ctx.font = 'bold 25px sans-serif'; ctx.fillText(product.label, 128, row + 80, 225);
      const geometry = product.id === 'tea' ? new T.CylinderGeometry(product.w / 2, product.w / 2, product.h, 12) :
        new T.BoxGeometry(product.w, product.h, product.d);
      const uv = geometry.getAttribute('uv');
      for (let j = 0; j < uv.count; j++) uv.setY(j, 1 - (i + 1 - .006 - uv.getY(j) * .988) / packages.length);
      const batch = new T.InstancedMesh(geometry, this.material!, 8);
      batch.name = 'stock:' + product.id;
      const shelf = shelves[i < 3 ? 0 : 1];
      // Shelf tops measured on market-shelf-e34834942882. All eight packages fit across its 2.4 m span.
      const level = [.533, .933, 1.333, .533, .933][i], scale = shelf.size / 2.4;
      for (let j = 0; j < 8; j++) {
        const x = (j - 3.5) * .27 * scale, z = .20 * scale;
        transform.position.set(shelf.x + x * Math.cos(shelf.rotY) + z * Math.sin(shelf.rotY),
          shelf.y + (level + product.h / 2) * scale, shelf.z - x * Math.sin(shelf.rotY) + z * Math.cos(shelf.rotY));
        transform.rotation.y = shelf.rotY; transform.scale.setScalar(scale); transform.updateMatrix();
        batch.setMatrixAt(j, transform.matrix);
      }
      batch.computeBoundingSphere();
      this.batches.push(batch); this.marketGroup.add(batch);
    });

    // Bakery case loaves & produce display boxes (1 instanced draw call inside marketGroup)
    const items: BoxItem[] = [];
    const bakery = store.furniture.find(f => f.asset === 'patisserie-case');
    if (bakery) {
      const tones = [0xd49652, 0xc47e3c, 0xe2b16e, 0xb86d35, 0xdeb066, 0xca8a48];
      for (let k = 0; k < 6; k++) {
        const lx = (k - 2.5) * 0.19, lz = k % 2 === 0 ? -0.09 : 0.09;
        const p = placeLocal(bakery, lx, 0.96, lz);
        items.push({ ...p, w: 0.15, h: 0.08, d: 0.11, rotY: bakery.rotY + (k - 2.5) * 0.12, color: tones[k] });
      }
    }
    const checkout = store.furniture.find(f => f.asset === 'market-checkout');
    if (checkout) {
      const impulseColors = [0x3c7a57, 0xc95a49, 0xd8a33e, 0x456990];
      for (let k = 0; k < 4; k++) {
        const p = placeLocal(checkout, (k - 1.5) * 0.24, 0.96, 0.18);
        items.push({ ...p, w: 0.14, h: 0.12, d: 0.12, rotY: checkout.rotY, color: impulseColors[k] });
      }
      // Cycles-baked AAA cash register sitting atop Sunrise Market checkout counter.
      const regPos = placeLocal(checkout, -0.34, 0.90, -0.06);
      this.registerAaaProp(this.marketAaa, 'shopCashRegister', [
        { x: regPos.x, y: regPos.y, z: regPos.z, rotY: checkout.rotY + Math.PI },
      ]);
    }
    // Lush indoor Ficus accent framing Sunrise Market's entrance corner (clear of aisles & door).
    this.registerAaaProp(this.marketAaa, 'libPottedPlant', [
      { x: store.rect.x0 + 0.92, y: GROUND_Y, z: store.rect.z0 + 0.92, rotY: 0.4, scale: 0.88 },
    ]);
    this.mountAaaBucket(this.marketAaa);
    if (items.length) {
      const mat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.68 });
      const mesh = buildSingleBatch('shop-display-market-extras', items, new T.BoxGeometry(1, 1, 1), mat);
      this.extraMats.push(mat);
      this.extraMeshes.push(mesh);
      this.marketGroup.add(mesh);
    }
  }

  private stockCafeAndBistro(game: EchoLifeGame) {
    const pastryPos: { x: number; y: number; z: number; rotY: number }[] = [];
    const cupPos: { x: number; y: number; z: number; rotY: number }[] = [];

    const bistro = game.nav.city.buildings.find(x => x.id === 'bistro');
    if (bistro) {
      for (const f of bistro.furniture) {
        if (f.asset === 'patisserie-case' || f.asset === 'crepe-kiosk') {
          for (let k = 0; k < 6; k++) {
            const p = placeLocal(f, (k - 2.5) * 0.22, 0.97, k % 2 === 0 ? -0.1 : 0.1);
            pastryPos.push({ ...p, rotY: f.rotY + k * 0.4 });
          }
          for (let k = 0; k < 4; k++) {
            const p = placeLocal(f, (k - 1.5) * 0.16, 0.99, -0.22);
            cupPos.push({ ...p, rotY: f.rotY });
          }
        } else if (f.asset === 'espresso' || f.asset === 'espresso-counter') {
          for (let k = 0; k < 4; k++) {
            const p = placeLocal(f, (k - 1.5) * 0.15, 0.95, 0.14);
            cupPos.push({ ...p, rotY: f.rotY });
          }
        } else if (f.asset === 'cafe-booth') {
          const p1 = placeLocal(f, -0.25, 0.78, 0.02);
          const p2 = placeLocal(f, 0.25, 0.78, -0.04);
          pastryPos.push({ ...p1, rotY: f.rotY });
          cupPos.push({ ...p2, rotY: f.rotY });
        }
      }
    }

    const cafe = game.nav.city.buildings.find(x => x.id === 'cafe');
    if (cafe) {
      for (const f of cafe.furniture) {
        if (f.asset === 'cafe-booth') {
          for (let k = 0; k < 2; k++) {
            const p = placeLocal(f, (k - 0.5) * 0.36, 0.79, 0.04);
            pastryPos.push({ ...p, rotY: f.rotY + k * 0.5 });
            const c = placeLocal(f, (k - 0.5) * 0.36, 0.81, -0.14);
            cupPos.push({ ...c, rotY: f.rotY });
          }
        } else if (f.asset === 'gaming-desk') {
          // Outer desk edge outside the curved monitor footprint: energy drink cup & snack pastry
          const cup = placeLocal(f, 0.56, 0.80, 0.20);
          const snack = placeLocal(f, -0.56, 0.79, 0.20);
          cupPos.push({ ...cup, rotY: f.rotY });
          pastryPos.push({ ...snack, rotY: f.rotY });
        }
      }
    }

    if (!pastryPos.length && !cupPos.length) return;
    const pastryMat = new T.MeshStandardMaterial({ color: 0xd99b56, roughness: 0.65 });
    const cupMat = new T.MeshStandardMaterial({ color: 0xf4efe6, roughness: 0.28, metalness: 0.04 });
    const saucerMat = new T.MeshStandardMaterial({ color: 0xeae2d4, roughness: 0.32, metalness: 0.06 });
    patchMaterialWithEchoCsm(pastryMat); patchHeightFog(pastryMat);
    patchMaterialWithEchoCsm(cupMat); patchHeightFog(cupMat);
    patchMaterialWithEchoCsm(saucerMat); patchHeightFog(saucerMat);
    this.cafeMats.push(pastryMat, cupMat, saucerMat);
    const pastries = new T.InstancedMesh(new T.CylinderGeometry(0.065, 0.08, 0.055, 10), pastryMat, Math.max(1, pastryPos.length));
    const cups = new T.InstancedMesh(new T.CylinderGeometry(0.042, 0.032, 0.095, 10), cupMat, Math.max(1, cupPos.length));
    const saucers = new T.InstancedMesh(new T.CylinderGeometry(0.072, 0.055, 0.014, 10), saucerMat, Math.max(1, cupPos.length));
    pastries.name = 'shop-display-pastries';
    cups.name = 'shop-display-cups';
    saucers.name = 'shop-display-saucers';
    const tf = new T.Object3D();
    pastryPos.forEach((p, i) => {
      tf.position.set(p.x, p.y, p.z); tf.rotation.set(0, p.rotY, 0); tf.scale.set(1, 1, 1); tf.updateMatrix();
      pastries.setMatrixAt(i, tf.matrix);
    });
    cupPos.forEach((c, i) => {
      tf.position.set(c.x, c.y, c.z); tf.rotation.set(0, c.rotY, 0); tf.scale.set(1, 1, 1); tf.updateMatrix();
      cups.setMatrixAt(i, tf.matrix);
      tf.position.set(c.x, c.y - 0.048, c.z); tf.updateMatrix();
      saucers.setMatrixAt(i, tf.matrix);
    });
    pastries.count = pastryPos.length; pastries.computeBoundingSphere();
    cups.count = cupPos.length; cups.computeBoundingSphere();
    saucers.count = cupPos.length; saucers.computeBoundingSphere();
    this.cafeMeshes.push(pastries, cups, saucers);
    this.cafeGroup.add(pastries, cups, saucers);

    // Enrich Pixel Café & Willow Corner Bistro with Cycles-baked artisan coffee cart & counter cash register.
    const cartPlacements: { x: number; y: number; z: number; rotY: number; scale?: number }[] = [];
    const regPlacements: { x: number; y: number; z: number; rotY: number; scale?: number }[] = [];
    if (cafe) {
      cartPlacements.push({
        x: cafe.rect.x1 - 1.45,
        y: GROUND_Y,
        z: cafe.rect.z0 + 5.1,
        rotY: -Math.PI / 2,
        scale: 0.86,
      });
    }
    if (bistro) {
      const kiosk = bistro.furniture.find((f) => f.asset === 'crepe-kiosk');
      if (kiosk) {
        const regPos = placeLocal(kiosk, 0.72, 0.92, -0.10);
        regPlacements.push({ x: regPos.x, y: regPos.y, z: regPos.z, rotY: kiosk.rotY + Math.PI });
      }
    }
    this.registerAaaProp(this.cafeAaa, 'cafeCoffeeCart', cartPlacements);
    this.registerAaaProp(this.cafeAaa, 'shopCashRegister', regPlacements);
    this.mountAaaBucket(this.cafeAaa);
  }

  private stockCommercialShop(id: CommercialShopId, b: EnterableBuilding): T.Group {
    const grp = new T.Group();
    grp.name = 'shop-display-' + id;
    const items: BoxItem[] = [];

    if (id === 'electronics_shop') {
      // Boxed GPUs, motherboards, and NVMe SSD packs on Parts Showcase & Electronics Counter
      const cab = b.furniture.find(f => f.asset === 'display-cabinet');
      if (cab) {
        const boxColors = [0x1f6f78, 0x264653, 0x3a86ff, 0x6b4c9a, 0x2a9d8f, 0xe76f51, 0x334155, 0x0ea5e9];
        for (let row = 0; row < 2; row++) {
          for (let col = 0; col < 4; col++) {
            const p = placeLocal(cab, (col - 1.5) * 0.26, 0.62 + row * 0.42, 0.04);
            items.push({ ...p, w: 0.20, h: 0.24, d: 0.09, rotY: cab.rotY, color: boxColors[row * 4 + col] });
          }
        }
      }
      const desk = b.furniture.find(f => f.asset === 'gaming-desk');
      if (desk) {
        const counterBoxes = [0x264653, 0x0ea5e9, 0x475569];
        for (let k = 0; k < 3; k++) {
          const p = placeLocal(desk, (k - 1) * 0.46, 0.84, 0.12);
          items.push({ ...p, w: 0.24, h: 0.14, d: 0.18, rotY: desk.rotY + (k - 1) * 0.14, color: counterBoxes[k] });
        }
      }
      if (items.length) {
        const mat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.44, metalness: 0.14 });
        const mesh = buildSingleBatch('shop-stock-electronics', items, new T.BoxGeometry(1, 1, 1), mat);
        this.extraMats.push(mat); this.extraMeshes.push(mesh); grp.add(mesh);
      }
    } else if (id === 'furniture_shop') {
      // Timber & terrazzo material finish swatches + rolled upholstery samples on display cabinet & showroom table
      const cab = b.furniture.find(f => f.asset === 'display-cabinet');
      if (cab) {
        const swatches = [0xd8c3a5, 0x8e6b4f, 0x5c4033, 0xeae2d6, 0x6b705c, 0x3d405b, 0xb5838d, 0xcbd5e1];
        for (let row = 0; row < 2; row++) {
          for (let col = 0; col < 4; col++) {
            const p = placeLocal(cab, (col - 1.5) * 0.27, 0.60 + row * 0.42, 0.04);
            items.push({ ...p, w: 0.18, h: 0.22, d: 0.06, rotY: cab.rotY + 0.12, color: swatches[row * 4 + col] });
          }
        }
      }
      const tbl = b.furniture.find(f => f.asset === 'table');
      if (tbl) {
        const books = [0xf5ebe0, 0x6d4c33, 0x457b9d];
        for (let k = 0; k < 3; k++) {
          const p = placeLocal(tbl, (k - 1) * 0.28, 0.79 + k * 0.02, 0.05);
          items.push({ ...p, w: 0.22, h: 0.05, d: 0.17, rotY: tbl.rotY + k * 0.25, color: books[k] });
        }
      }
      if (items.length) {
        const mat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.68 });
        const mesh = buildSingleBatch('shop-stock-furniture', items, new T.BoxGeometry(1, 1, 1), mat);
        this.extraMats.push(mat); this.extraMeshes.push(mesh); grp.add(mesh);
      }
    } else if (id === 'clothing_shop') {
      // Folded seasonal apparel stacks on Entry Bench + boutique boxes beside garment racks
      const bench = b.furniture.find(f => f.asset === 'bench-cushion');
      if (bench) {
        const palette = [0xf4ece1, 0x6b8e78, 0x2c4257, 0x8c3b4a, 0xd4a359, 0x4f5d75];
        for (const side of [-0.46, 0.46]) {
          for (let layer = 0; layer < 3; layer++) {
            const p = placeLocal(bench, side, 0.50 + layer * 0.055, 0);
            items.push({
              ...p, w: 0.30, h: 0.048, d: 0.24,
              rotY: bench.rotY + (layer % 2 === 0 ? 0.05 : -0.05),
              color: palette[(side < 0 ? 0 : 3) + layer],
            });
          }
        }
      }
      const racks = b.furniture.filter(f => f.asset === 'garment-rack');
      racks.forEach((rk, ri) => {
        const boxColors = [0xe8d8cc, 0x7a4253];
        const p = placeLocal(rk, ri === 0 ? -0.45 : 0.45, 0.10, 0.45);
        items.push({ ...p, w: 0.28, h: 0.18, d: 0.22, rotY: rk.rotY + 0.2, color: boxColors[ri % 2] });
      });
      if (items.length) {
        const mat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86 });
        const mesh = buildSingleBatch('shop-stock-clothing', items, new T.BoxGeometry(1, 1, 1), mat);
        this.extraMats.push(mat); this.extraMeshes.push(mesh); grp.add(mesh);
      }
    } else if (id === 'vehicle_dealer') {
      // Glossy riding helmets & alloy display canisters on dealer desk + showroom stands
      const desk = b.furniture.find(f => f.asset === 'gaming-desk');
      if (desk) {
        const helmetColors = [0xd62828, 0x1d3557, 0xf4a261, 0x2a9d8f];
        for (let k = 0; k < 4; k++) {
          const p = placeLocal(desk, (k - 1.5) * 0.32, 0.88, -0.05);
          items.push({ ...p, w: 0.22, h: 0.20, d: 0.22, rotY: desk.rotY, color: helmetColors[k] });
        }
      }
      const moto = b.furniture.find(f => f.asset === 'moto-commuter');
      if (moto) {
        const p = placeLocal(moto, 0.55, 0.32, 0.65);
        items.push({ ...p, w: 0.26, h: 0.64, d: 0.26, rotY: moto.rotY, color: 0x334155 });
      }
      const scooter = b.furniture.find(f => f.asset === 'scooter-ev');
      if (scooter) {
        const p = placeLocal(scooter, -0.55, 0.32, 0.65);
        items.push({ ...p, w: 0.26, h: 0.64, d: 0.26, rotY: scooter.rotY, color: 0x0f766e });
      }
      if (items.length) {
        const mat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0.36 });
        const mesh = buildSingleBatch('shop-stock-vehicle', items, new T.CylinderGeometry(0.5, 0.52, 1, 12), mat);
        this.extraMats.push(mat); this.extraMeshes.push(mesh); grp.add(mesh);
      }
    } else if (id === 'home_center') {
      // Stacked timber planks, stone tile swatches, and finish sample tins on Kitchen Island
      const island = b.furniture.find(f => f.asset === 'kitchen-island');
      if (island) {
        const timber = [0xb07d4f, 0x8d5b34, 0xd4a97d];
        for (let k = 0; k < 3; k++) {
          const p = placeLocal(island, -0.48, 0.94 + k * 0.045, 0);
          items.push({ ...p, w: 0.52, h: 0.038, d: 0.24, rotY: island.rotY + 0.04 * k, color: timber[k] });
        }
        const paints = [0xe9c46a, 0x2a9d8f, 0xe76f51, 0x457b9d];
        for (let k = 0; k < 4; k++) {
          const p = placeLocal(island, 0.12 + k * 0.20, 0.99, -0.10);
          items.push({ ...p, w: 0.14, h: 0.16, d: 0.14, rotY: island.rotY, color: paints[k] });
        }
        const tiles = [0xe2ded5, 0x9fa4a9, 0xc7bfb2];
        for (let k = 0; k < 3; k++) {
          const p = placeLocal(island, 0.22 + k * 0.22, 0.94, 0.20);
          items.push({ ...p, w: 0.18, h: 0.03, d: 0.18, rotY: island.rotY, color: tiles[k] });
        }
      }
      if (items.length) {
        const mat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62 });
        const mesh = buildSingleBatch('shop-stock-home-center', items, new T.BoxGeometry(1, 1, 1), mat);
        this.extraMats.push(mat); this.extraMeshes.push(mesh); grp.add(mesh);
      }
    } else if (id === 'repair_shop') {
      // Red mechanic toolbox, spare parts trays, and lubricant boxes on Workbench & Craft Station
      const bench = b.furniture.find(f => f.asset === 'workbench');
      if (bench) {
        const tb = placeLocal(bench, -0.48, 0.99, -0.05);
        items.push({ ...tb, w: 0.44, h: 0.22, d: 0.22, rotY: bench.rotY, color: 0xb91c1c });
        const trayColors = [0x475569, 0x64748b, 0xd97706, 0x0284c7];
        for (let k = 0; k < 4; k++) {
          const p = placeLocal(bench, 0.04 + k * 0.20, 0.94, 0.06);
          items.push({ ...p, w: 0.15, h: 0.12, d: 0.16, rotY: bench.rotY, color: trayColors[k] });
        }
      }
      const craft = b.furniture.find(f => f.asset === 'table');
      if (craft) {
        const kitColors = [0x334155, 0x0f766e, 0xb45309];
        for (let k = 0; k < 3; k++) {
          const p = placeLocal(craft, (k - 1) * 0.28, 0.82, 0.02);
          items.push({ ...p, w: 0.22, h: 0.11, d: 0.18, rotY: craft.rotY + (k - 1) * 0.1, color: kitColors[k] });
        }
      }
      if (items.length) {
        const mat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.44, metalness: 0.36 });
        const mesh = buildSingleBatch('shop-stock-repair', items, new T.BoxGeometry(1, 1, 1), mat);
        this.extraMats.push(mat); this.extraMeshes.push(mesh); grp.add(mesh);
      }
    }

    this.group.add(grp);
    freezeStaticHierarchy(grp);
    return grp;
  }

  update(game: EchoLifeGame, player: { x: number; z: number }) {
    const now = Date.now();
    const store = game.nav.city.buildings.find(b => b.id === 'market');
    const nearMarket = nearBuilding(store, player, 7);
    this.marketGroup.visible = nearMarket;
    if (nearMarket && store) {
      this.marketAaa.lastActiveMs = now;
      if (!this.batches.length) {
        const shelves = store.furniture.filter(f => f.asset === 'market-shelf');
        if (shelves.length >= 2) this.stockShelves(shelves, store);
      } else if (!this.marketAaa.mounted) {
        this.mountAaaBucket(this.marketAaa);
      }
      this.batches.forEach((batch, i) => {
        const id = packages[i].id;
        const reserved = game.s.basket.reduce((count, item) => count + Number(item === id), 0);
        batch.count = Math.max(0, Math.min(8, (game.s.stock[id] ?? 8) - reserved));
      });
    }

    const cafe = game.nav.city.buildings.find(b => b.id === 'cafe');
    const bistro = game.nav.city.buildings.find(b => b.id === 'bistro');
    const nearFood = nearBuilding(cafe, player, 7) || nearBuilding(bistro, player, 7);
    this.cafeGroup.visible = nearFood;
    if (nearFood) {
      this.cafeAaa.lastActiveMs = now;
      if (!this.cafeMeshes.length) this.stockCafeAndBistro(game);
      else if (!this.cafeAaa.mounted) this.mountAaaBucket(this.cafeAaa);
    }

    if (now - this.lastIdleCheckMs >= 5_000) {
      this.lastIdleCheckMs = now;
      this.releaseInactiveProps(45_000);
    }

    for (const id of COMMERCIAL_SHOPS) {
      const b = game.nav.city.buildings.find(x => x.id === id);
      const near = nearBuilding(b, player, 7);
      let grp = this.shopGroups.get(id);
      if (near && b && !grp) {
        grp = this.stockCommercialShop(id, b);
        this.shopGroups.set(id, grp);
      }
      if (grp) grp.visible = near;
    }
  }

  dispose() {
    this.disposed = true;
    this.releaseAaaBucket(this.marketAaa);
    this.releaseAaaBucket(this.cafeAaa);
    for (const batch of this.batches) { batch.dispose(); batch.geometry.dispose(); }
    for (const m of this.cafeMeshes) { m.dispose(); m.geometry.dispose(); }
    for (const m of this.extraMeshes) { m.dispose(); m.geometry.dispose(); }
    for (const mat of this.cafeMats) mat.dispose();
    for (const mat of this.extraMats) mat.dispose();
    this.shopGroups.clear();
    this.material?.dispose(); this.atlas?.dispose(); this.group.removeFromParent();
  }
}
