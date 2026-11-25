import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const GATEWAY_URL = '/assets/study-space/connected-door-90154eda3f77.glb';

interface BakedGateway {
  frameGeo: T.BufferGeometry;
  leafGeo: T.BufferGeometry;
  material: T.MeshStandardMaterial;
  pbrTex: T.DataTexture;
  emissiveTex: T.DataTexture;
}

let baked: BakedGateway | null = null;
let loading: Promise<void> | null = null;
let epoch = 0;

function releaseRaw(root: T.Object3D) {
  const geometries = new Set<T.BufferGeometry>();
  const materials = new Set<T.Material>();
  root.traverse(o => {
    const m = o as T.Mesh;
    if (!m.isMesh) return;
    geometries.add(m.geometry);
    (Array.isArray(m.material) ? m.material : [m.material]).forEach(x => {
      if (x) materials.add(x);
    });
  });
  geometries.forEach(g => g.dispose());
  materials.forEach(m => m.dispose());
}

function releaseBaked(b: BakedGateway) {
  b.frameGeo.dispose();
  b.leafGeo.dispose();
  b.material.dispose();
  b.pbrTex.dispose();
  b.emissiveTex.dispose();
}

function toFloat32Attr(attr: T.BufferAttribute | T.InterleavedBufferAttribute): T.Float32BufferAttribute {
  const isInterleaved = Boolean((attr as T.InterleavedBufferAttribute).isInterleavedBufferAttribute);
  if (
    !isInterleaved &&
    attr instanceof T.BufferAttribute &&
    attr.array instanceof Float32Array &&
    !attr.normalized &&
    attr.gpuType === T.FloatType
  ) {
    return attr as T.Float32BufferAttribute;
  }
  const { itemSize, count } = attr;
  const out = new Float32Array(count * itemSize);
  for (let i = 0; i < count; i++) {
    out[i * itemSize] = attr.getX(i);
    if (itemSize >= 2) out[i * itemSize + 1] = attr.getY(i);
    if (itemSize >= 3) out[i * itemSize + 2] = attr.getZ(i);
    if (itemSize >= 4) out[i * itemSize + 3] = attr.getW(i);
  }
  return new T.Float32BufferAttribute(out, itemSize);
}

function ensureIndex(g: T.BufferGeometry): void {
  if (g.index) return;
  const count = g.attributes.position.count;
  const arr = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) arr[i] = i;
  g.setIndex(new T.BufferAttribute(arr, 1));
}

function flipWinding(g: T.BufferGeometry): void {
  const idx = g.index;
  if (!idx) return;
  const arr = idx.array;
  for (let i = 0; i + 2 < arr.length; i += 3) {
    const tmp = arr[i + 1];
    arr[i + 1] = arr[i + 2];
    arr[i + 2] = tmp;
  }
  idx.needsUpdate = true;
}

/**
 * Reduces the 8 unmerged primitives / 5 materials of `connected-door.glb` into exactly 2 draw calls
 * (`Frame` = 1 mesh, `Leaf` with `Handle` baked in exact pivot coordinates = 1 mesh) sharing 1
 * vertex-colored PBR+Emissive palette material so every physical door costs 2 draws instead of 8.
 */
function bakeGateway(scene: T.Group): BakedGateway | null {
  scene.updateMatrixWorld(true);
  const frameRoot = scene.getObjectByName('Frame');
  const leafRoot = scene.getObjectByName('Leaf');
  if (!frameRoot || !leafRoot) return null;
  const handleRoot = scene.getObjectByName('Handle');

  // Collect all unique untextured PBR materials across Frame, Leaf, and Handle into an 8×1 lookup palette.
  const matSlots = new Map<T.Material, number>();
  const matList: T.MeshStandardMaterial[] = [];
  const registerMaterial = (m: T.Material): number => {
    const existing = matSlots.get(m);
    if (existing !== undefined) return existing;
    const slot = matList.length;
    matSlots.set(m, slot);
    matList.push(m as T.MeshStandardMaterial);
    return slot;
  };

  for (const root of [frameRoot, leafRoot, handleRoot]) {
    if (!root) continue;
    root.traverse(o => {
      const m = o as T.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (mats[0]) registerMaterial(mats[0]);
    });
  }

  const paletteWidth = Math.max(8, 1 << Math.ceil(Math.log2(Math.max(1, matList.length))));
  const pbrData = new Uint8Array(paletteWidth * 4);
  const emissiveData = new Uint8Array(paletteWidth * 4);
  let maxEmissive = 0;
  for (const m of matList) {
    if (m.emissive) {
      const intensity = m.emissiveIntensity ?? 1;
      maxEmissive = Math.max(maxEmissive, m.emissive.r * intensity, m.emissive.g * intensity, m.emissive.b * intensity);
    }
  }
  const emissiveNorm = maxEmissive > 1e-4 ? maxEmissive : 1;

  for (let i = 0; i < matList.length; i++) {
    const m = matList[i];
    const r = T.MathUtils.clamp(m.roughness ?? 0.5, 0, 1);
    const met = T.MathUtils.clamp(m.metalness ?? 0, 0, 1);
    pbrData[i * 4 + 0] = 255;
    pbrData[i * 4 + 1] = Math.round(r * 255);
    pbrData[i * 4 + 2] = Math.round(met * 255);
    pbrData[i * 4 + 3] = 255;

    const ei = m.emissiveIntensity ?? 1;
    const er = m.emissive ? T.MathUtils.clamp((m.emissive.r * ei) / emissiveNorm, 0, 1) : 0;
    const eg = m.emissive ? T.MathUtils.clamp((m.emissive.g * ei) / emissiveNorm, 0, 1) : 0;
    const eb = m.emissive ? T.MathUtils.clamp((m.emissive.b * ei) / emissiveNorm, 0, 1) : 0;
    emissiveData[i * 4 + 0] = Math.round(er * 255);
    emissiveData[i * 4 + 1] = Math.round(eg * 255);
    emissiveData[i * 4 + 2] = Math.round(eb * 255);
    emissiveData[i * 4 + 3] = 255;
  }

  const pbrTex = new T.DataTexture(pbrData, paletteWidth, 1);
  pbrTex.minFilter = T.NearestFilter;
  pbrTex.magFilter = T.NearestFilter;
  pbrTex.generateMipmaps = false;
  pbrTex.needsUpdate = true;

  const emissiveTex = new T.DataTexture(emissiveData, paletteWidth, 1);
  emissiveTex.minFilter = T.NearestFilter;
  emissiveTex.magFilter = T.NearestFilter;
  emissiveTex.generateMipmaps = false;
  emissiveTex.needsUpdate = true;

  const buildPart = (roots: (T.Object3D | undefined)[], referenceRoot: T.Object3D): T.BufferGeometry | null => {
    const invRef = referenceRoot.matrixWorld.clone().invert();
    const pieces: T.BufferGeometry[] = [];
    const rel = new T.Matrix4();

    for (const root of roots) {
      if (!root) continue;
      root.traverse(o => {
        const m = o as T.Mesh;
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        const std = mats[0] as T.MeshStandardMaterial | undefined;
        if (!std) return;
        const slot = matSlots.get(std) ?? 0;

        const g = m.geometry.clone();
        g.morphAttributes = {};
        for (const name of Object.keys(g.attributes)) {
          if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
        }
        g.setAttribute('position', toFloat32Attr(g.attributes.position));
        if (g.attributes.normal) g.setAttribute('normal', toFloat32Attr(g.attributes.normal));

        rel.multiplyMatrices(invRef, m.matrixWorld);
        const det = rel.determinant();
        g.applyMatrix4(rel);
        ensureIndex(g);
        if (det < 0) flipWinding(g);
        if (!g.attributes.normal) g.computeVertexNormals();

        const count = g.attributes.position.count;
        const colors = new Float32Array(count * 3);
        const uvs = new Float32Array(count * 2);
        const u = (slot + 0.5) / paletteWidth;
        const c = std.color ?? new T.Color('#ffffff');
        for (let i = 0; i < count; i++) {
          c.toArray(colors, i * 3);
          uvs[i * 2] = u;
          uvs[i * 2 + 1] = 0.5;
        }
        g.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
        g.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
        pieces.push(g);
      });
    }

    if (!pieces.length) return null;
    const merged = pieces.length === 1 ? pieces[0] : mergeGeometries(pieces, false);
    if (pieces.length > 1) pieces.forEach(p => p.dispose());
    if (!merged) return null;
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  };

  const frameGeo = buildPart([frameRoot], frameRoot);
  // Handle vertices in `connected-door.glb` are authored in the same hinge-pivot coordinate frame as Leaf.
  const leafGeo = buildPart([leafRoot, handleRoot], leafRoot);
  if (!frameGeo || !leafGeo) {
    frameGeo?.dispose();
    leafGeo?.dispose();
    pbrTex.dispose();
    emissiveTex.dispose();
    return null;
  }

  const material = new T.MeshStandardMaterial({
    name: 'connected-door-batched',
    vertexColors: true,
    side: T.DoubleSide,
    roughness: 1,
    metalness: 1,
    roughnessMap: pbrTex,
    metalnessMap: pbrTex,
    emissive: new T.Color(maxEmissive > 1e-4 ? '#ffffff' : '#000000'),
    emissiveIntensity: maxEmissive > 1e-4 ? maxEmissive : 0,
    emissiveMap: maxEmissive > 1e-4 ? emissiveTex : null,
  });

  return { frameGeo, leafGeo, material, pbrTex, emissiveTex };
}

export function loadGatewayAssets() {
  if (loading) return loading;
  const at = epoch;
  return (loading = new GLTFLoader()
    .loadAsync(GATEWAY_URL)
    .then(g => {
      if (at !== epoch) {
        releaseRaw(g.scene);
        return;
      }
      const next = bakeGateway(g.scene);
      releaseRaw(g.scene);
      if (at !== epoch) {
        if (next) releaseBaked(next);
        return;
      }
      if (baked) releaseBaked(baked);
      baked = next;
    })
    .catch(() => {
      loading = null;
    }));
}

export function gatewayAsset() {
  if (!baked) return null;
  const frame = new T.Mesh(baked.frameGeo, baked.material);
  frame.name = 'Frame';
  frame.castShadow = true;
  frame.receiveShadow = true;

  const leaf = new T.Mesh(baked.leafGeo, baked.material);
  leaf.name = 'Leaf';
  leaf.castShadow = true;
  leaf.receiveShadow = true;

  // Handle geometry is baked into `leaf` at exact hinge-pivot coordinates; keep lightweight anchor group for callers.
  const handle = new T.Group();
  handle.name = 'Handle';

  return { frame, leaf, handle };
}

export function disposeGatewayAssets() {
  epoch++;
  if (baked) releaseBaked(baked);
  baked = null;
  loading = null;
}
