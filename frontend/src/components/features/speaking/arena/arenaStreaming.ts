import * as T from 'three';
import type { ArenaIslandSpec, ArenaQualityTier, ArenaRuntimeTelemetry } from './arenaContracts';
import { ARENA_QUALITY_CONFIGS, type ArenaQualityConfig } from './arenaQuality';
import { arenaShoreRadius, arenaWaterDepth } from './arenaTerrain';

/**
 * Calibrated VRAM texture budgets (MiB) aligned to deduplicated v7 WebP + PBR maps + single plaque atlas.
 */
export const CALIBRATED_VRAM_BUDGET_MB: Record<ArenaQualityTier, number> = {
  ultra: 420,
  high: 290,
  balanced: 185,
  low: 115,
};

export type ArenaResidencyClass =
  | 'active'
  | 'starting'
  | 'prefetched'
  | 'cached_visited'
  | 'distant_hlod'
  | 'evictable';

export type ArenaPrepStage =
  | 'terrain'
  | 'ocean'
  | 'islands'
  | 'vessels'
  | 'marine'
  | 'textures'
  | 'shaders'
  | 'ready';

export interface ArenaPreparationProgress {
  stage: ArenaPrepStage;
  fraction: number;
  detailEn: string;
  detailVi: string;
}

/**
 * Yields control back to the browser event loop when the current cooperative
 * slice exceeds `budgetMs`, preventing >50ms Long Tasks during cold world setup.
 * Uses MessageChannel when document is hidden so automated/background tabs do not
 * throttle to 1 Hz on requestAnimationFrame.
 */
export function yieldToMainThread(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export class ArenaTimeSlicer {
  private sliceStartMs = typeof performance !== 'undefined' ? performance.now() : 0;
  private readonly budgetMs: number;

  constructor(budgetMs = 9.5) {
    this.budgetMs = budgetMs;
  }

  resetSlice(): void {
    this.sliceStartMs = typeof performance !== 'undefined' ? performance.now() : 0;
  }

  async checkpoint(aborted?: () => boolean): Promise<boolean> {
    if (aborted?.()) return false;
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (now - this.sliceStartMs >= this.budgetMs) {
      await yieldToMainThread();
      this.sliceStartMs = typeof performance !== 'undefined' ? performance.now() : 0;
      if (aborted?.()) return false;
    }
    return true;
  }
}

function estimateTextureVramBytes(tex: T.Texture): number {
  const img = tex.image as { width?: number; height?: number } | undefined;
  const w = Number(img?.width) || 0;
  const h = Number(img?.height) || 0;
  if (w <= 0 || h <= 0) return 0;
  const mipFactor = tex.generateMipmaps !== false ? 1.3333 : 1.0;
  return Math.round(w * h * 4 * mipFactor);
}

interface RefEntry<TResource> {
  resource: TResource;
  refs: number;
  bytes: number;
  pinned: boolean;
}

export interface IslandResidencyRecord {
  islandId: string;
  state: ArenaResidencyClass;
  lastActiveAtSec: number;
  detailGroup: T.Group | null;
  midGroup: T.Group | null;
  hlodGroup: T.Group | null;
  ownedTextures: T.Texture[];
  ownedGeometries: T.BufferGeometry[];
  ownedMaterials: T.Material[];
  detailResident: boolean;
  detailFade: number;
  midFade: number;
  fadeUniforms: Array<{ value: number }>;
}

/**
 * Ownership-aware GPU resource residency manager with calibrated LRU detail eviction
 * and staggered re-upload queue. Guarantees shared trees, rocks, PBR textures, and character
 * rigs are ref-counted and never prematurely disposed when a distant island evicts clutter.
 */
export class ArenaResidencyManager {
  private readonly textures = new Map<string, RefEntry<T.Texture>>();
  private readonly geometries = new Map<string, RefEntry<T.BufferGeometry>>();
  private readonly materials = new Map<string, RefEntry<T.Material>>();
  private readonly islands = new Map<string, IslandResidencyRecord>();
  private readonly pendingTextureUploads: T.Texture[] = [];
  private readonly pendingUploadUuids = new Set<string>();
  private totalTextureBytes = 0;

  getCalibratedBudgetMb(tier: ArenaQualityTier): number {
    return Math.max(ARENA_QUALITY_CONFIGS[tier].vramTextureBudgetMb, CALIBRATED_VRAM_BUDGET_MB[tier]);
  }

  retainTexture(tex: T.Texture | null | undefined, pinned = false): void {
    if (!tex) return;
    const entry = this.textures.get(tex.uuid);
    if (entry) {
      entry.refs += 1;
      if (pinned) entry.pinned = true;
      return;
    }
    const bytes = estimateTextureVramBytes(tex);
    this.textures.set(tex.uuid, { resource: tex, refs: 1, bytes, pinned });
    this.totalTextureBytes += bytes;
  }

  releaseTexture(tex: T.Texture | null | undefined): void {
    if (!tex) return;
    const entry = this.textures.get(tex.uuid);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0 && !entry.pinned) {
      this.totalTextureBytes = Math.max(0, this.totalTextureBytes - entry.bytes);
      this.textures.delete(tex.uuid);
      tex.dispose();
    }
  }

  retainGeometry(geo: T.BufferGeometry | null | undefined, pinned = false): void {
    if (!geo) return;
    const entry = this.geometries.get(geo.uuid);
    if (entry) {
      entry.refs += 1;
      if (pinned) entry.pinned = true;
      return;
    }
    let bytes = 0;
    for (const k of Object.keys(geo.attributes)) {
      const attr = geo.attributes[k];
      if (attr && 'array' in attr && attr.array) {
        bytes += attr.array.byteLength;
      }
    }
    if (geo.index?.array) bytes += geo.index.array.byteLength;
    this.geometries.set(geo.uuid, { resource: geo, refs: 1, bytes, pinned });
  }

  releaseGeometry(geo: T.BufferGeometry | null | undefined): void {
    if (!geo) return;
    const entry = this.geometries.get(geo.uuid);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0 && !entry.pinned) {
      this.geometries.delete(geo.uuid);
      geo.dispose();
    }
  }

  retainMaterial(mat: T.Material | null | undefined, pinned = false): void {
    if (!mat) return;
    const entry = this.materials.get(mat.uuid);
    if (entry) {
      entry.refs += 1;
      if (pinned) entry.pinned = true;
    } else {
      this.materials.set(mat.uuid, { resource: mat, refs: 1, bytes: 0, pinned });
    }
    const anyMat = mat as unknown as Record<string, unknown>;
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
      const candidate = anyMat[key];
      if (candidate && (candidate as T.Texture).isTexture) {
        this.retainTexture(candidate as T.Texture, pinned);
      }
    }
  }

  releaseMaterial(mat: T.Material | null | undefined): void {
    if (!mat) return;
    const entry = this.materials.get(mat.uuid);
    if (!entry) return;
    const anyMat = mat as unknown as Record<string, unknown>;
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
      const candidate = anyMat[key];
      if (candidate && (candidate as T.Texture).isTexture) {
        this.releaseTexture(candidate as T.Texture);
      }
    }
    entry.refs -= 1;
    if (entry.refs <= 0 && !entry.pinned) {
      this.materials.delete(mat.uuid);
      mat.dispose();
    }
  }

  registerObjectHierarchy(root: T.Object3D, pinned = false): {
    textures: T.Texture[];
    geometries: T.BufferGeometry[];
    materials: T.Material[];
  } {
    const textures: T.Texture[] = [];
    const geometries: T.BufferGeometry[] = [];
    const materials: T.Material[] = [];
    const seenGeo = new Set<string>();
    const seenMat = new Set<string>();
    const seenTex = new Set<string>();

    root.traverse((obj) => {
      const mesh = obj as T.Mesh;
      if (mesh.geometry && !seenGeo.has(mesh.geometry.uuid)) {
        seenGeo.add(mesh.geometry.uuid);
        geometries.push(mesh.geometry);
        this.retainGeometry(mesh.geometry, pinned);
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) {
        if (!seenMat.has(m.uuid)) {
          seenMat.add(m.uuid);
          materials.push(m);
          this.retainMaterial(m, pinned);
        }
        const anyMat = m as unknown as Record<string, unknown>;
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
          const tex = anyMat[key] as T.Texture | undefined;
          if (tex?.isTexture && !seenTex.has(tex.uuid)) {
            seenTex.add(tex.uuid);
            textures.push(tex);
          }
        }
      }
    });

    return { textures, geometries, materials };
  }

  registerIslandChunk(
    islandId: string,
    groups: { detailGroup?: T.Group | null; midGroup?: T.Group | null; hlodGroup?: T.Group | null },
    isStartingIsland = false,
  ): IslandResidencyRecord {
    if (groups.hlodGroup) this.registerObjectHierarchy(groups.hlodGroup, true);
    if (groups.midGroup) this.registerObjectHierarchy(groups.midGroup, true);
    const detailOwned = groups.detailGroup
      ? this.registerObjectHierarchy(groups.detailGroup, isStartingIsland)
      : { textures: [], geometries: [], materials: [] };

    const rec: IslandResidencyRecord = {
      islandId,
      state: isStartingIsland ? 'starting' : 'distant_hlod',
      lastActiveAtSec: isStartingIsland ? 0.001 : 0,
      detailGroup: groups.detailGroup ?? null,
      midGroup: groups.midGroup ?? null,
      hlodGroup: groups.hlodGroup ?? null,
      ownedTextures: detailOwned.textures,
      ownedGeometries: detailOwned.geometries,
      ownedMaterials: detailOwned.materials,
      detailResident: true,
      detailFade: isStartingIsland ? 1 : 0,
      midFade: isStartingIsland ? 1 : 0,
      fadeUniforms: [],
    };
    this.islands.set(islandId, rec);
    return rec;
  }

  registerIslandFadeUniform(islandId: string, uniform: { value: number }): void {
    const rec = this.islands.get(islandId);
    if (rec && !rec.fadeUniforms.includes(uniform)) {
      rec.fadeUniforms.push(uniform);
      uniform.value = rec.detailFade;
    }
  }

  /**
   * Releases GPU WebGLTextures exclusive to an evicted distant island's `detailGroup`
   * while keeping JS image backing intact for zero-network staggered re-upload on return.
   */
  evictIslandDetail(islandId: string): boolean {
    const rec = this.islands.get(islandId);
    if (!rec || !rec.detailResident || rec.state !== 'evictable') return false;
    rec.detailResident = false;
    const before = this.totalTextureBytes;
    for (let i = 0; i < rec.ownedMaterials.length; i += 1) {
      const anyMat = rec.ownedMaterials[i] as unknown as Record<string, unknown>;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
        const candidate = anyMat[key];
        if (candidate && (candidate as T.Texture).isTexture) {
          this.releaseTexture(candidate as T.Texture);
        }
      }
    }
    return this.totalTextureBytes < before;
  }

  /**
   * Restores ref-counts for a previously evicted island's `detailGroup` textures and queues
   * any newly revived textures for staggered `renderer.initTexture` upload (`<= maxUploadsPerFrame`).
   */
  restoreIslandDetail(islandId: string): void {
    const rec = this.islands.get(islandId);
    if (!rec || rec.detailResident) return;
    rec.detailResident = true;
    for (let i = 0; i < rec.ownedMaterials.length; i += 1) {
      const anyMat = rec.ownedMaterials[i] as unknown as Record<string, unknown>;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
        const tex = anyMat[key] as T.Texture | undefined;
        if (tex?.isTexture) {
          const wasDisposed = !this.textures.has(tex.uuid);
          this.retainTexture(tex, false);
          if (wasDisposed && tex.image && !this.pendingUploadUuids.has(tex.uuid)) {
            tex.needsUpdate = true;
            this.pendingUploadUuids.add(tex.uuid);
            this.pendingTextureUploads.push(tex);
          }
        }
      }
    }
  }

  drainPendingUploads(renderer: T.WebGLRenderer | null | undefined, maxUploads: number): number {
    if (!renderer || this.pendingTextureUploads.length === 0) return 0;
    const limit = Math.max(1, maxUploads);
    let uploaded = 0;
    while (uploaded < limit && this.pendingTextureUploads.length > 0) {
      const tex = this.pendingTextureUploads.shift()!;
      this.pendingUploadUuids.delete(tex.uuid);
      if (tex.image && this.textures.has(tex.uuid)) {
        renderer.initTexture(tex);
        uploaded += 1;
      }
    }
    return uploaded;
  }

  getPendingUploadCount(): number {
    return this.pendingTextureUploads.length;
  }

  getIslandRecord(islandId: string): IslandResidencyRecord | undefined {
    return this.islands.get(islandId);
  }

  getAllIslandRecords(): IterableIterator<IslandResidencyRecord> {
    return this.islands.values();
  }

  getEstimatedTextureMb(): number {
    return Number((this.totalTextureBytes / (1024 * 1024)).toFixed(2));
  }

  getResidencySummary(): Record<ArenaResidencyClass, number> {
    const summary: Record<ArenaResidencyClass, number> = {
      active: 0,
      starting: 0,
      prefetched: 0,
      cached_visited: 0,
      distant_hlod: 0,
      evictable: 0,
    };
    for (const rec of this.islands.values()) {
      summary[rec.state] += 1;
    }
    return summary;
  }

  disposeAll(): void {
    this.pendingTextureUploads.length = 0;
    this.pendingUploadUuids.clear();
    for (const entry of this.textures.values()) {
      entry.resource.dispose();
    }
    for (const entry of this.geometries.values()) {
      entry.resource.dispose();
    }
    for (const entry of this.materials.values()) {
      entry.resource.dispose();
    }
    this.textures.clear();
    this.geometries.clear();
    this.materials.clear();
    this.islands.clear();
    this.totalTextureBytes = 0;
  }
}

export interface UnderwaterGodRaysWarmupTarget {
  warmupSubmergedPipeline(
    renderer: T.WebGLRenderer,
    scene: T.Scene,
    camera: T.Camera,
    yieldFn?: () => Promise<void>,
    aborted?: () => boolean,
    onPrepareSubmergedCamera?: (submergedCam: T.Camera) => void,
  ): Promise<void>;
}

const WARMUP_HIDDEN_INSTANCE_MATRIX = new T.Matrix4().compose(
  new T.Vector3(0, -512, 0),
  new T.Quaternion(),
  new T.Vector3(1e-4, 1e-4, 1e-4),
);
const WARMUP_HIDDEN_INSTANCE_ELEMENTS = new Float32Array(WARMUP_HIDDEN_INSTANCE_MATRIX.elements);

function isStreamingIslandRingGroup(name: string): boolean {
  return (
    name.startsWith('IslandDetail_') ||
    name.startsWith('IslandMid_') ||
    name.startsWith('IslandHlod_')
  );
}

/**
 * Dual-pipeline pre-gameplay shader compilation and staggered GPU texture upload gate.
 * Temporarily disables frustum culling, reveals all `IslandDetail_*` / `IslandMid_*` / `IslandHlod_*`
 * and non-Light scene groups, forces underwater shadow casters for depth-shader compilation, seeds all
 * zero-count InstancedMeshes (`ArenaSwimFX`, `ArenaMarineEcosystem` splash pool, `ArenaWaterfallSystem`,
 * `ArenaGrassSystem`, `ArenaSkyBirdEcosystem`, `ArenaBoats`, `ArenaFishing`), zero-drawRange particle
 * buffers, and `WorldWakeTrail` VAOs with a valid below-floor micro-scale transform, allocates
 * `sun.shadow.map.depthTexture` in Pass 1 Dry (`ACESFilmic` + sRGB FB), syncs shadow uniforms, and runs
 * Pass 2 Submerged (`NoToneMapping` + linear `sceneCaptureRT` + `UnderwaterGodRaysPass` at a submerged
 * reef pose) so 360-degree pans, island approaches, waterfalls, grass, birds, splashes, and water entry
 * hit `programDelta === 0`!
 */
export async function warmupArenaShadersAndTextures(opts: {
  renderer: T.WebGLRenderer;
  scene: T.Scene;
  camera: T.Camera;
  quality: ArenaQualityConfig;
  slicer: ArenaTimeSlicer;
  residency?: ArenaResidencyManager | null;
  underwaterGodRays?: UnderwaterGodRaysWarmupTarget | null;
  syncShadow?: (cam?: T.Camera) => void;
  aborted?: () => boolean;
  onProgress?: (p: ArenaPreparationProgress) => void;
}): Promise<number> {
  const { renderer, scene, camera, quality, slicer, residency, aborted, onProgress } = opts;
  const startMs = typeof performance !== 'undefined' ? performance.now() : 0;

  const sceneUserData = scene.userData as {
    __ecArenaGodRaysPass?: UnderwaterGodRaysWarmupTarget;
    __ecArenaSyncShadow?: (cam?: T.Camera) => void;
    __ecArenaSetWarmupShadows?: (force: boolean) => void;
  };
  sceneUserData.__ecArenaSetWarmupShadows?.(true);

  const uniqueTextures: T.Texture[] = [];
  const seenTex = new Set<string>();
  const savedVisibility: Array<{ obj: T.Object3D; visible: boolean }> = [];
  const savedRingScales: Array<{ obj: T.Object3D; sx: number; sy: number; sz: number }> = [];
  const savedFadeUniforms: Array<{ uniform: { value: number }; value: number }> = [];
  const savedFrustum: Array<{ obj: T.Object3D; culled: boolean }> = [];
  const savedBatchedFrustum: Array<{ mesh: T.BatchedMesh; culled: boolean }> = [];
  const savedInstancedMeshes: Array<{ mesh: T.InstancedMesh; count: number; raw0: Float32Array }> = [];
  const savedDrawRanges: Array<{ geo: T.BufferGeometry; start: number; count: number }> = [];
  const savedInstancedGeos: Array<{
    geo: T.InstancedBufferGeometry;
    instanceCount: number;
    savedSampleAt0?: [number, number, number, number];
    savedShape0?: [number, number, number, number];
  }> = [];

  if (residency) {
    for (const rec of residency.getAllIslandRecords()) {
      for (const group of [rec.detailGroup, rec.midGroup, rec.hlodGroup]) {
        if (group && !group.visible) {
          savedVisibility.push({ obj: group, visible: false });
          group.visible = true;
        }
      }
      for (let u = 0; u < rec.fadeUniforms.length; u += 1) {
        const uf = rec.fadeUniforms[u];
        if (uf.value < 1) {
          savedFadeUniforms.push({ uniform: uf, value: uf.value });
          uf.value = 1;
        }
      }
    }
  }

  const collectUploadableTexture = (candidate: unknown) => {
    const tex = candidate as (T.Texture & { isRenderTargetTexture?: boolean }) | undefined;
    if (!tex?.isTexture || tex.isRenderTargetTexture || !tex.image || seenTex.has(tex.uuid)) return;
    seenTex.add(tex.uuid);
    if (tex.anisotropy < quality.anisotropy) {
      tex.anisotropy = quality.anisotropy;
    }
    uniqueTextures.push(tex);
  };

  scene.traverse((obj) => {
    // Never flip hidden Lights visible — mutating light counts would alter shader defines during warmup.
    if ((obj as T.Light).isLight) return;
    if (!obj.visible) {
      savedVisibility.push({ obj, visible: obj.visible });
      obj.visible = true;
    }
    if (
      isStreamingIslandRingGroup(obj.name) &&
      (obj.scale.x <= 1e-4 || obj.scale.y <= 1e-4 || obj.scale.z <= 1e-4)
    ) {
      savedRingScales.push({ obj, sx: obj.scale.x, sy: obj.scale.y, sz: obj.scale.z });
      obj.scale.set(1, 1, 1);
    }
    if (obj.frustumCulled) {
      savedFrustum.push({ obj, culled: obj.frustumCulled });
      obj.frustumCulled = false;
    }

    const batched = obj as T.BatchedMesh;
    if (batched.isBatchedMesh && batched.perObjectFrustumCulled) {
      savedBatchedFrustum.push({ mesh: batched, culled: batched.perObjectFrustumCulled });
      batched.perObjectFrustumCulled = false;
    }

    // Seed zero-count InstancedMeshes (`ArenaSwimFX`, `ArenaMarineEcosystem` fish-leap splashes,
    // `ArenaWaterfallSystem`, `ArenaGrassSystem`, `ArenaSkyBirdEcosystem`, `ArenaBoats`, `ArenaFishing`)
    // with a valid invertible below-floor micro-scale matrix at slot 0 so WebGL2/D3D11 compiles and
    // draw-links 100% of their vertex, fragment, and shadow-depth PSOs BEFORE unlocking gameplay!
    const instMesh = obj as T.InstancedMesh;
    if (instMesh.isInstancedMesh && instMesh.count === 0 && instMesh.instanceMatrix && instMesh.instanceMatrix.count > 0) {
      const arr = instMesh.instanceMatrix.array as Float32Array;
      const raw0 = new Float32Array(16);
      for (let k = 0; k < 16; k += 1) raw0[k] = arr[k] ?? 0;
      savedInstancedMeshes.push({ mesh: instMesh, count: 0, raw0 });
      arr.set(WARMUP_HIDDEN_INSTANCE_ELEMENTS, 0);
      instMesh.instanceMatrix.needsUpdate = true;
      if (instMesh.instanceColor) {
        instMesh.instanceColor.needsUpdate = true;
      }
      if (instMesh.geometry) {
        for (const attr of Object.values(instMesh.geometry.attributes)) {
          if ((attr as T.InstancedBufferAttribute).isInstancedBufferAttribute) {
            attr.needsUpdate = true;
          }
        }
      }
      instMesh.count = 1;
    }

    const renderable = obj as T.Mesh | T.Points | T.Line;
    const isMesh = (obj as T.Mesh).isMesh === true;
    const isPoints = (obj as T.Points).isPoints === true;
    const isLine = (obj as T.Line).isLine === true;

    if ((isMesh || isPoints || isLine) && renderable.geometry) {
      const geo = renderable.geometry;
      const instGeo = geo as T.InstancedBufferGeometry;
      if (isMesh && instGeo.isInstancedBufferGeometry && instGeo.instanceCount === 0) {
        // Seed zero-instance InstancedBufferGeometry (`WorldWakeTrail` in `arenaSea.ts`) with a non-clipped
        // wake quad at slot 0 so its fragment shader and blending pipeline are draw-linked during boot!
        let hasValidCapacity = true;
        for (const attr of Object.values(instGeo.attributes)) {
          if ((attr as T.InstancedBufferAttribute).isInstancedBufferAttribute && attr.count < 1) {
            hasValidCapacity = false;
            break;
          }
        }
        if (hasValidCapacity) {
          const sampleAtAttr = instGeo.getAttribute('sampleAt') as T.InstancedBufferAttribute | undefined;
          const shapeAttr = instGeo.getAttribute('shape') as T.InstancedBufferAttribute | undefined;
          let savedSampleAt0: [number, number, number, number] | undefined;
          let savedShape0: [number, number, number, number] | undefined;
          if (sampleAtAttr && shapeAttr && sampleAtAttr.count >= 1 && shapeAttr.count >= 1) {
            savedSampleAt0 = [
              sampleAtAttr.getX(0),
              sampleAtAttr.getY(0),
              sampleAtAttr.getZ(0),
              sampleAtAttr.getW(0),
            ];
            savedShape0 = [
              shapeAttr.getX(0),
              shapeAttr.getY(0),
              shapeAttr.getZ(0),
              shapeAttr.getW(0),
            ];
            sampleAtAttr.setXYZW(0, camera.position.x, camera.position.z - 6, 0, 120);
            shapeAttr.setXYZW(0, 0, 1, 0.25, 0.85);
            sampleAtAttr.needsUpdate = true;
            shapeAttr.needsUpdate = true;
          }
          savedInstancedGeos.push({
            geo: instGeo,
            instanceCount: 0,
            savedSampleAt0,
            savedShape0,
          });
          instGeo.instanceCount = 1;
        }
      } else if (!instMesh.isInstancedMesh && !instGeo.isInstancedBufferGeometry && geo.drawRange.count === 0) {
        const totalVerts = geo.index ? geo.index.count : geo.attributes.position?.count ?? 0;
        const minPrimVerts = isPoints ? 1 : isLine ? 2 : 3;
        if (totalVerts >= minPrimVerts) {
          savedDrawRanges.push({ geo, start: geo.drawRange.start, count: 0 });
          geo.setDrawRange(0, minPrimVerts);
        }
      }
    }

    const rawMaterial = (renderable as { material?: T.Material | T.Material[] }).material;
    const mats = Array.isArray(rawMaterial) ? rawMaterial : rawMaterial ? [rawMaterial] : [];
    for (const m of mats) {
      const anyMat = m as unknown as Record<string, unknown>;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
        collectUploadableTexture(anyMat[key]);
      }
      const uniforms = (m as T.ShaderMaterial).uniforms;
      if (uniforms && typeof uniforms === 'object') {
        for (const u of Object.values(uniforms)) {
          if (u && typeof u === 'object' && 'value' in u) {
            collectUploadableTexture(u.value);
          }
        }
      }
    }
  });

  try {
    onProgress?.({
      stage: 'textures',
      fraction: 0.74,
      detailEn: 'Uploading coastal textures to GPU',
      detailVi: 'Đang nạp vật liệu biển đảo lên GPU',
    });

    const perSlice = Math.max(1, quality.maxTextureUploadsPerFrame);
    for (let i = 0; i < uniqueTextures.length; i += 1) {
      if (aborted?.()) break;
      renderer.initTexture(uniqueTextures[i]);
      if ((i + 1) % perSlice === 0) {
        await yieldToMainThread();
        slicer.resetSlice();
      }
    }

    onProgress?.({
      stage: 'shaders',
      fraction: 0.84,
      detailEn: 'Compiling ocean, reef and island shaders',
      detailVi: 'Đang biên dịch ánh sáng đại dương và quần đảo',
    });

    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);

    // Pass 1 — Dry Pipeline (`ACESFilmicToneMapping` + sRGB default framebuffer + shadow depth pass)
    if (!aborted?.()) {
      const maybeAsync = renderer as T.WebGLRenderer & {
        compileAsync?: (s: T.Object3D, c: T.Camera, targetScene?: T.Scene) => Promise<unknown>;
      };
      if (typeof maybeAsync.compileAsync === 'function') {
        await maybeAsync.compileAsync(scene, camera, scene);
      } else {
        renderer.compile(scene, camera);
      }
      // Execute one 1x1-scissored shadow + scene warmup draw while all chunks and zero-instance VAOs
      // are active so WebGLShadowMap allocates `sun.shadow.map.depthTexture` (2048^2) and compiles all
      // MeshDepthMaterial / customDepthMaterial variants BEFORE unlock — including interleaved
      // InstancedMesh <-> Mesh transitions across FrontSide/BackSide/DoubleSide x (noMap | map) so
      // Three.js singleton `_depthMaterial` caches every shadow-pass program variant upfront!
      if (!aborted?.()) {
        let sampleUvGeo: T.BufferGeometry | null = null;
        for (let i = 0; i < scene.children.length && !sampleUvGeo; i++) {
          scene.children[i].traverse((node) => {
            if (sampleUvGeo) return;
            const m = node as T.Mesh;
            if (
              m.isMesh &&
              !(m as T.InstancedMesh).isInstancedMesh &&
              !(m as T.SkinnedMesh).isSkinnedMesh &&
              m.geometry &&
              !(m.geometry as T.InstancedBufferGeometry).isInstancedBufferGeometry &&
              m.geometry.attributes.position &&
              m.geometry.attributes.uv
            ) {
              sampleUvGeo = m.geometry;
            }
          });
        }
        const sampleTex = uniqueTextures[0] ?? null;
        const tempDepthGroup = new T.Group();
        const tempDepthMats: T.Material[] = [];
        const tempDepthInsts: T.InstancedMesh[] = [];
        if (sampleUvGeo) {
          const sides: T.Side[] = [T.FrontSide, T.BackSide, T.DoubleSide];
          const maps: Array<T.Texture | null> = sampleTex ? [null, sampleTex] : [null];
          for (const side of sides) {
            for (const map of maps) {
              const mat = new T.MeshBasicMaterial({ side, map: map ?? undefined });
              tempDepthMats.push(mat);
              const inst = new T.InstancedMesh(sampleUvGeo, mat, 1);
              inst.setMatrixAt(0, WARMUP_HIDDEN_INSTANCE_MATRIX);
              inst.instanceMatrix.needsUpdate = true;
              inst.castShadow = true;
              inst.frustumCulled = false;
              tempDepthInsts.push(inst);
              tempDepthGroup.add(inst);

              const mesh = new T.Mesh(sampleUvGeo, mat);
              mesh.position.set(0, -512, 0);
              mesh.scale.setScalar(1e-4);
              mesh.castShadow = true;
              mesh.frustumCulled = false;
              tempDepthGroup.add(mesh);
            }
          }
          scene.add(tempDepthGroup);
          tempDepthGroup.updateMatrixWorld(true);
        }

        const prevTarget = renderer.getRenderTarget();
        const prevViewport = new T.Vector4();
        const prevScissor = new T.Vector4();
        const prevScissorTest = renderer.getScissorTest();
        const prevAutoReset = renderer.info.autoReset;
        renderer.getViewport(prevViewport);
        renderer.getScissor(prevScissor);
        try {
          renderer.info.autoReset = false;
          renderer.setRenderTarget(null);
          renderer.setViewport(0, 0, 1, 1);
          renderer.setScissor(0, 0, 1, 1);
          renderer.setScissorTest(true);
          renderer.render(scene, camera);
        } finally {
          if (tempDepthGroup.parent) scene.remove(tempDepthGroup);
          for (const inst of tempDepthInsts) inst.dispose();
          for (const mat of tempDepthMats) mat.dispose();
          renderer.setScissorTest(false);
          renderer.clear(true, true, true);
          renderer.setRenderTarget(prevTarget);
          renderer.setViewport(prevViewport);
          renderer.setScissor(prevScissor);
          renderer.setScissorTest(prevScissorTest);
          renderer.info.autoReset = prevAutoReset;
        }
      }
    }

    // Bind the newly allocated `sun.shadow.map.depthTexture` (uShadowEnabled = 1) BEFORE Pass 2!
    const syncShadow = opts.syncShadow ?? sceneUserData.__ecArenaSyncShadow;
    syncShadow?.(camera);

    // Pass 2 — Submerged Dual Pipeline (`NoToneMapping` + `sceneCaptureRT` Linear HalfFloat RT + `UnderwaterGodRaysPass`)
    const godRays = opts.underwaterGodRays ?? sceneUserData.__ecArenaGodRaysPass ?? null;

    if (godRays && quality.tier !== 'low' && !aborted?.()) {
      await yieldToMainThread();
      slicer.resetSlice();
      if (!aborted?.()) {
        onProgress?.({
          stage: 'shaders',
          fraction: 0.94,
          detailEn: 'Prewarming underwater light shafts and water entry',
          detailVi: 'Đang chuẩn bị tia sáng và hiệu ứng dưới nước',
        });
        await godRays.warmupSubmergedPipeline(
          renderer,
          scene,
          camera,
          async () => {
            await yieldToMainThread();
            slicer.resetSlice();
          },
          aborted,
          syncShadow,
        );
      }
    }
  } finally {
    sceneUserData.__ecArenaSetWarmupShadows?.(false);
    for (let i = savedInstancedGeos.length - 1; i >= 0; i -= 1) {
      const entry = savedInstancedGeos[i];
      if (entry.savedSampleAt0) {
        const attr = entry.geo.getAttribute('sampleAt') as T.InstancedBufferAttribute | undefined;
        if (attr) {
          attr.setXYZW(0, ...entry.savedSampleAt0);
          attr.needsUpdate = true;
        }
      }
      if (entry.savedShape0) {
        const attr = entry.geo.getAttribute('shape') as T.InstancedBufferAttribute | undefined;
        if (attr) {
          attr.setXYZW(0, ...entry.savedShape0);
          attr.needsUpdate = true;
        }
      }
      entry.geo.instanceCount = entry.instanceCount;
    }
    for (let i = savedDrawRanges.length - 1; i >= 0; i -= 1) {
      const entry = savedDrawRanges[i];
      entry.geo.setDrawRange(entry.start, entry.count);
    }
    for (let i = savedInstancedMeshes.length - 1; i >= 0; i -= 1) {
      const entry = savedInstancedMeshes[i];
      (entry.mesh.instanceMatrix.array as Float32Array).set(entry.raw0, 0);
      entry.mesh.instanceMatrix.needsUpdate = true;
      entry.mesh.count = entry.count;
    }
    for (let i = savedBatchedFrustum.length - 1; i >= 0; i -= 1) {
      savedBatchedFrustum[i].mesh.perObjectFrustumCulled = savedBatchedFrustum[i].culled;
    }
    for (let i = savedFrustum.length - 1; i >= 0; i -= 1) {
      savedFrustum[i].obj.frustumCulled = savedFrustum[i].culled;
    }
    for (let i = savedRingScales.length - 1; i >= 0; i -= 1) {
      const entry = savedRingScales[i];
      entry.obj.scale.set(entry.sx, entry.sy, entry.sz);
    }
    for (let i = savedFadeUniforms.length - 1; i >= 0; i -= 1) {
      savedFadeUniforms[i].uniform.value = savedFadeUniforms[i].value;
    }
    for (let i = savedVisibility.length - 1; i >= 0; i -= 1) {
      savedVisibility[i].obj.visible = savedVisibility[i].visible;
    }
  }

  const endMs = typeof performance !== 'undefined' ? performance.now() : startMs;
  return Number(Math.max(0, endMs - startMs).toFixed(2));
}

export interface StreamerUpdateInput {
  playerX: number;
  playerZ: number;
  playerY?: number;
  velX: number;
  velZ: number;
  camForwardX: number;
  camForwardZ: number;
  camYawRate?: number;
  inBoat?: boolean;
  boatYawVel?: number;
  waterDepth?: number;
  submersion?: number;
  elapsedSec: number;
  renderer?: T.WebGLRenderer | null;
}

interface CandidatePromotion {
  rec: IslandResidencyRecord;
  isl: ArenaIslandSpec;
  desiredState: ArenaResidencyClass;
  effectiveDist: number;
  edgeDist: number;
}

/**
 * Genuine 3-Ring Predictive Island Streamer:
 * - Exact coastline distance via `arenaShoreRadius(isl, bearing)` (eliminating `0.72 * radius` late pop)
 * - True world velocity + curved boat trajectory lookahead (`v * T + 0.5 * (omega x v) * T^2`)
 * - Camera frustum + angular pan-rate (`camYawRate`) sweep cone lookahead
 * - Water depth & submersion lookahead (`arenaWaterDepth`)
 * - Staggered background promotion (`<= 1` detail + `<= 2` mid per tick) & smooth `0.32 s` crossfade
 * - Calibrated LRU eviction + staggered GPU texture re-upload (`<= maxTextureUploadsPerFrame`)
 */
export class ArenaPredictiveStreamer {
  private readonly islands: readonly ArenaIslandSpec[];
  private readonly residency: ArenaResidencyManager;
  private readonly startingIslandId: string;
  private readonly promotionScratch: CandidatePromotion[] = [];
  private readonly evictScratch: IslandResidencyRecord[] = [];
  private quality: ArenaQualityConfig;
  private lastTickSec = -10;
  private lastFrameSec = -1;
  private prevCamFx = 0;
  private prevCamFz = -1;
  private hasPrevCam = false;
  private activeChunks = 0;
  private warmChunks = 0;
  private transitionCount = 0;

  constructor(opts: {
    islands: readonly ArenaIslandSpec[];
    residency: ArenaResidencyManager;
    qualityTier: ArenaQualityTier;
    startingIslandId?: string;
  }) {
    this.islands = opts.islands;
    this.residency = opts.residency;
    this.quality = ARENA_QUALITY_CONFIGS[opts.qualityTier];
    this.startingIslandId = opts.startingIslandId ?? (opts.islands[0]?.id || 'commons');
  }

  setQualityTier(tier: ArenaQualityTier): void {
    this.quality = ARENA_QUALITY_CONFIGS[tier];
    this.lastTickSec = -10;
  }

  getCounts(): { activeChunks: number; warmChunks: number; transitionCount: number } {
    return {
      activeChunks: this.activeChunks,
      warmChunks: this.warmChunks,
      transitionCount: this.transitionCount,
    };
  }

  private stepIslandFades(dtSec: number, force: boolean): void {
    const step = force ? 1 : Math.min(1, Math.max(0.004, dtSec) / 0.32);
    for (let i = 0; i < this.islands.length; i += 1) {
      const rec = this.residency.getIslandRecord(this.islands[i].id);
      if (!rec) continue;
      const wantDetail = rec.state === 'active' || rec.state === 'starting' ? 1 : 0;
      const wantMid =
        wantDetail === 1 || rec.state === 'prefetched' || rec.state === 'cached_visited' ? 1 : 0;

      if (force) {
        rec.detailFade = wantDetail;
        rec.midFade = wantMid;
      } else {
        if (rec.detailFade < wantDetail) rec.detailFade = Math.min(1, rec.detailFade + step);
        else if (rec.detailFade > wantDetail) rec.detailFade = Math.max(0, rec.detailFade - step);

        if (rec.midFade < wantMid) rec.midFade = Math.min(1, rec.midFade + step);
        else if (rec.midFade > wantMid) rec.midFade = Math.max(0, rec.midFade - step);
      }

      const smoothDetail = rec.detailFade * rec.detailFade * (3 - 2 * rec.detailFade);
      for (let u = 0; u < rec.fadeUniforms.length; u += 1) {
        rec.fadeUniforms[u].value = smoothDetail;
      }

      if (rec.detailGroup) {
        const vis = rec.detailFade > 0.005;
        rec.detailGroup.visible = vis;
        if (vis) {
          const s = rec.detailFade >= 0.999 ? 1 : 0.985 + 0.015 * smoothDetail;
          if (rec.detailGroup.scale.y !== s) {
            rec.detailGroup.scale.set(1, s, 1);
          }
        }
      }
      if (rec.midGroup) {
        rec.midGroup.visible = rec.midFade > 0.005 || rec.detailFade > 0.005;
      }
      if (rec.hlodGroup) {
        rec.hlodGroup.visible = true;
      }
    }
  }

  update(input: StreamerUpdateInput, force = false): boolean {
    const frameDt =
      this.lastFrameSec >= 0 ? Math.max(0, Math.min(0.25, input.elapsedSec - this.lastFrameSec)) : 1 / 60;
    this.lastFrameSec = input.elapsedSec;

    // Drain staggered texture uploads (`<= maxTextureUploadsPerFrame`) & advance smooth LOD fades every frame
    this.residency.drainPendingUploads(input.renderer, this.quality.maxTextureUploadsPerFrame);

    let derivedYawRate = 0;
    if (this.hasPrevCam && frameDt > 1e-4) {
      const crossY = this.prevCamFx * input.camForwardZ - this.prevCamFz * input.camForwardX;
      const dotXZ = this.prevCamFx * input.camForwardX + this.prevCamFz * input.camForwardZ;
      derivedYawRate = Math.atan2(crossY, dotXZ) / frameDt;
    }
    this.prevCamFx = input.camForwardX;
    this.prevCamFz = input.camForwardZ;
    this.hasPrevCam = true;

    if (!force && input.elapsedSec - this.lastTickSec < 0.09) {
      this.stepIslandFades(frameDt, false);
      return false;
    }
    const tickDt = this.lastTickSec >= 0 ? Math.max(0.016, input.elapsedSec - this.lastTickSec) : 0.1;
    this.lastTickSec = input.elapsedSec;

    const maxSpeed = input.inBoat ? 22 : 16;
    const speed = Math.hypot(input.velX, input.velZ);
    const clampedSpeed = Math.min(speed, maxSpeed);
    const invSpeed = speed > 0.2 ? 1 / speed : 0;
    const vxDir = input.velX * invSpeed;
    const vzDir = input.velZ * invSpeed;

    const horizonSec = input.inBoat ? 4.2 : 3.2;
    const lookaheadVel = clampedSpeed * horizonSec;

    // Curved boat trajectory prediction: p_pred = p + v*T + 0.5*(omega x v)*T^2
    const omega = T.MathUtils.clamp(input.boatYawVel ?? 0, -2.5, 2.5);
    const useCurvedBoat = Boolean(input.inBoat) && speed > 0.8 && Math.abs(omega) > 0.02;
    const clampedVx = vxDir * clampedSpeed;
    const clampedVz = vzDir * clampedSpeed;
    const predBoatX =
      input.playerX + clampedVx * horizonSec + 0.5 * omega * clampedVz * horizonSec * horizonSec;
    const predBoatZ =
      input.playerZ + clampedVz * horizonSec - 0.5 * omega * clampedVx * horizonSec * horizonSec;

    // Angular pan-rate lead vector so fast camera sweeps prefetch islands entering the frustum
    const camYawRate = T.MathUtils.clamp(input.camYawRate ?? derivedYawRate, -6, 6);
    const panLeadRad = T.MathUtils.clamp(camYawRate * 0.42, -0.85, 0.85);
    const cosLead = Math.cos(panLeadRad);
    const sinLead = Math.sin(panLeadRad);
    const leadCamX = input.camForwardX * cosLead - input.camForwardZ * sinLead;
    const leadCamZ = input.camForwardX * sinLead + input.camForwardZ * cosLead;
    const panBoostM = 24 + Math.min(18, Math.abs(camYawRate) * 6.5);

    // Water depth & submersion lookahead
    const depth = input.waterDepth ?? arenaWaterDepth(input.playerX, input.playerZ);
    const sub = T.MathUtils.clamp(input.submersion ?? 0, 0, 1);
    const deepSubmergedTrim = sub > 0.45 && depth > 6 ? 18 * sub : 0;

    const r0 = Math.max(68, this.quality.activeRingRadiusM - deepSubmergedTrim);
    const r1 = this.quality.warmRingRadiusM + (depth > 0.4 && sub < 0.35 ? 16 : 0);
    const rEvict = this.quality.evictRingRadiusM;
    const hysteresis = 16;
    const calibratedBudgetMb = this.residency.getCalibratedBudgetMb(this.quality.tier);

    this.promotionScratch.length = 0;

    for (let i = 0; i < this.islands.length; i += 1) {
      const isl = this.islands[i];
      const rec = this.residency.getIslandRecord(isl.id);
      if (!rec) continue;

      const dx = isl.x - input.playerX;
      const dz = isl.z - input.playerZ;
      const rawDist = Math.hypot(dx, dz);
      // Exact coastline distance along actual shore lobe bearing from island center toward player
      const shoreR = arenaShoreRadius(isl, Math.atan2(-dz, -dx));
      const edgeDist = Math.max(0, rawDist - shoreR);

      let curvedEdgeDist = edgeDist;
      if (useCurvedBoat) {
        const pdx = isl.x - predBoatX;
        const pdz = isl.z - predBoatZ;
        const pRaw = Math.hypot(pdx, pdz);
        const pShore = arenaShoreRadius(isl, Math.atan2(-pdz, -pdx));
        curvedEdgeDist = Math.max(0, pRaw - pShore);
      }

      let dirDotVel = 0;
      let dirDotCam = 0;
      if (rawDist > 1e-3) {
        const invD = 1 / rawDist;
        const ux = dx * invD;
        const uz = dz * invD;
        dirDotVel = Math.max(0, ux * vxDir + uz * vzDir);
        dirDotCam = Math.max(
          0,
          ux * input.camForwardX + uz * input.camForwardZ,
          ux * leadCamX + uz * leadCamZ,
        );
      }

      const linearPredDist = Math.max(0, edgeDist - lookaheadVel * dirDotVel - panBoostM * dirDotCam);
      const effectiveDist = Math.min(linearPredDist, Math.max(0, curvedEdgeDist - 14 * dirDotCam));

      const wasActive = rec.state === 'active' || rec.state === 'starting';
      const wasWarm = rec.state === 'prefetched' || rec.state === 'cached_visited';
      const activeThreshold = wasActive ? r0 + hysteresis : r0;
      const warmThreshold = wasWarm ? r1 + hysteresis : r1;

      let desiredState: ArenaResidencyClass;
      if (effectiveDist <= activeThreshold) {
        desiredState = isl.id === this.startingIslandId && edgeDist <= r0 ? 'starting' : 'active';
      } else if (effectiveDist <= warmThreshold) {
        desiredState = 'prefetched';
      } else if (
        rec.lastActiveAtSec > 0 &&
        edgeDist <= rEvict &&
        input.elapsedSec - rec.lastActiveAtSec < 45 &&
        this.residency.getEstimatedTextureMb() <= calibratedBudgetMb
      ) {
        desiredState = 'cached_visited';
      } else if (edgeDist > rEvict) {
        desiredState = 'evictable';
      } else {
        desiredState = 'distant_hlod';
      }

      this.promotionScratch.push({ rec, isl, desiredState, effectiveDist, edgeDist });
    }

    // Closest effectiveDist gets priority when staggering background chunk promotions (`<= 1` detail, `<= 2` mid)
    this.promotionScratch.sort((a, b) => a.effectiveDist - b.effectiveDist);

    let detailPromotionsThisTick = 0;
    let midPromotionsThisTick = 0;
    let activeCount = 0;
    let warmCount = 0;
    let changed = false;

    for (let i = 0; i < this.promotionScratch.length; i += 1) {
      const item = this.promotionScratch[i];
      const { rec, desiredState } = item;
      const prevIsDetail = rec.state === 'active' || rec.state === 'starting';
      const prevIsMid = prevIsDetail || rec.state === 'prefetched' || rec.state === 'cached_visited';
      const wantDetail = desiredState === 'active' || desiredState === 'starting';
      const wantMid = wantDetail || desiredState === 'prefetched' || desiredState === 'cached_visited';

      let nextState = desiredState;
      if (!force) {
        if (wantDetail && !prevIsDetail) {
          if (detailPromotionsThisTick >= 1) {
            nextState = 'prefetched';
          } else {
            detailPromotionsThisTick += 1;
          }
        } else if (wantMid && !prevIsMid) {
          if (midPromotionsThisTick >= 2) {
            nextState = 'distant_hlod';
          } else {
            midPromotionsThisTick += 1;
          }
        }
      }

      if (nextState === 'active' || nextState === 'starting' || nextState === 'prefetched') {
        if (!rec.detailResident) {
          this.residency.restoreIslandDetail(rec.islandId);
        }
      }
      if (nextState === 'active' || nextState === 'starting') {
        rec.lastActiveAtSec = input.elapsedSec;
      }

      if (nextState !== rec.state || force) {
        rec.state = nextState;
        changed = true;
        this.transitionCount += 1;
      }

      if (nextState === 'active' || nextState === 'starting') activeCount += 1;
      else if (nextState === 'prefetched' || nextState === 'cached_visited') warmCount += 1;
    }

    // Real calibrated LRU eviction on `'evictable'` outer islands when resident textures exceed tier budget
    if (this.residency.getEstimatedTextureMb() > calibratedBudgetMb) {
      this.evictScratch.length = 0;
      for (const rec of this.residency.getAllIslandRecords()) {
        if (rec.state === 'evictable' && rec.detailResident && rec.islandId !== this.startingIslandId) {
          this.evictScratch.push(rec);
        }
      }
      this.evictScratch.sort((a, b) => a.lastActiveAtSec - b.lastActiveAtSec);
      for (let i = 0; i < this.evictScratch.length; i += 1) {
        if (this.residency.getEstimatedTextureMb() <= calibratedBudgetMb) break;
        this.residency.evictIslandDetail(this.evictScratch[i].islandId);
      }
    }

    this.stepIslandFades(force ? 1 : tickDt, force);

    this.activeChunks = activeCount;
    this.warmChunks = warmCount;
    return changed;
  }
}

export { ArenaPredictiveStreamer as ArenaIslandStreamer };

const SAMPLE_WINDOW = 1800;

export class ArenaRuntimeProfiler {
  private readonly frameDurations = new Float32Array(SAMPLE_WINDOW);
  private readonly sortScratch = new Float32Array(SAMPLE_WINDOW);
  private writeIndex = 0;
  private sampleCount = 0;
  private tier: ArenaQualityTier = 'high';
  private shaderWarmupMs = 0;
  private lastDraws = 0;
  private lastTriangles = 0;
  private lastGeometries = 0;
  private lastTextures = 0;
  private lastPrograms = 0;
  private prevTextures = 0;
  private prevPrograms = 0;
  private activeIslandChunks = 0;
  private warmIslandChunks = 0;
  private longTasksCount = 0;
  private longTasksTotalMs = 0;
  private lastLongTaskEndMs = -1000;
  private observer: PerformanceObserver | null = null;
  private readonly spikeCounts: Record<string, number> = {
    shader_compile: 0,
    texture_upload: 0,
    chunk_transition: 0,
    long_task_js: 0,
    gpu_or_driver: 0,
    tab_hidden: 0,
  };

  constructor(initialTier: ArenaQualityTier) {
    this.tier = initialTier;
    this.attachLongTaskObserver();
  }

  private attachLongTaskObserver(): void {
    if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;
    try {
      const supported = PerformanceObserver.supportedEntryTypes;
      if (!supported || !supported.includes('longtask')) return;
      this.observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i += 1) {
          const e = entries[i];
          this.longTasksCount += 1;
          this.longTasksTotalMs += e.duration;
          this.lastLongTaskEndMs = e.startTime + e.duration;
        }
      });
      this.observer.observe({ type: 'longtask', buffered: false });
    } catch {
      this.observer = null;
    }
  }

  setTier(tier: ArenaQualityTier): void {
    this.tier = tier;
  }

  setShaderWarmupMs(ms: number): void {
    this.shaderWarmupMs = ms;
  }

  resetWindow(): void {
    this.writeIndex = 0;
    this.sampleCount = 0;
    this.longTasksCount = 0;
    this.longTasksTotalMs = 0;
    for (const k of Object.keys(this.spikeCounts)) {
      this.spikeCounts[k] = 0;
    }
  }

  recordFrame(
    rawDtMs: number,
    renderer: T.WebGLRenderer,
    activeChunks: number,
    warmChunks: number,
    chunkChangedThisFrame: boolean,
  ): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      if (rawDtMs > 100) this.spikeCounts.tab_hidden += 1;
      return;
    }

    const clamped = Math.max(0.1, Math.min(rawDtMs, 1000));
    this.frameDurations[this.writeIndex] = clamped;
    this.writeIndex = (this.writeIndex + 1) % SAMPLE_WINDOW;
    if (this.sampleCount < SAMPLE_WINDOW) this.sampleCount += 1;

    const info = renderer.info;
    const programsCount = Array.isArray(info.programs) ? info.programs.length : 0;
    const texturesCount = info.memory.textures;

    if (this.sampleCount > 5 && clamped > 28) {
      const now = typeof performance !== 'undefined' ? performance.now() : 0;
      if (programsCount > this.prevPrograms) {
        this.spikeCounts.shader_compile += 1;
      } else if (texturesCount > this.prevTextures) {
        this.spikeCounts.texture_upload += 1;
      } else if (chunkChangedThisFrame) {
        this.spikeCounts.chunk_transition += 1;
      } else if (now - this.lastLongTaskEndMs < 40) {
        this.spikeCounts.long_task_js += 1;
      } else {
        this.spikeCounts.gpu_or_driver += 1;
      }
    }

    this.prevPrograms = programsCount;
    this.prevTextures = texturesCount;
    this.lastDraws = info.render.calls;
    this.lastTriangles = info.render.triangles;
    this.lastGeometries = info.memory.geometries;
    this.lastTextures = texturesCount;
    this.lastPrograms = programsCount;
    this.activeIslandChunks = activeChunks;
    this.warmIslandChunks = warmChunks;
  }

  snapshot(): ArenaRuntimeTelemetry {
    const n = this.sampleCount;
    if (n === 0) {
      return {
        tier: this.tier,
        fps: 0,
        onePercentLowFps: 0,
        frameTimeP50Ms: 0,
        frameTimeP95Ms: 0,
        frameTimeP99Ms: 0,
        draws: this.lastDraws,
        triangles: this.lastTriangles,
        geometries: this.lastGeometries,
        textures: this.lastTextures,
        programs: this.lastPrograms,
        shaderWarmupMs: this.shaderWarmupMs,
        longTasksCount: this.longTasksCount,
        longTasksTotalMs: Number(this.longTasksTotalMs.toFixed(1)),
        activeIslandChunks: this.activeIslandChunks,
        warmIslandChunks: this.warmIslandChunks,
        spikeCounts: { ...this.spikeCounts },
      };
    }

    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const v = this.frameDurations[i];
      this.sortScratch[i] = v;
      sum += v;
    }
    const sub = this.sortScratch.subarray(0, n);
    sub.sort();

    const p50 = sub[Math.min(n - 1, Math.floor(n * 0.5))];
    const p95 = sub[Math.min(n - 1, Math.floor(n * 0.95))];
    const p99 = sub[Math.min(n - 1, Math.floor(n * 0.99))];
    const worstCount = Math.max(1, Math.floor(n * 0.01));
    let worstSum = 0;
    for (let i = n - worstCount; i < n; i += 1) {
      worstSum += sub[i];
    }
    const meanMs = sum / n;
    const worstMeanMs = worstSum / worstCount;

    return {
      tier: this.tier,
      fps: Number((1000 / Math.max(0.1, meanMs)).toFixed(2)),
      onePercentLowFps: Number((1000 / Math.max(0.1, worstMeanMs)).toFixed(2)),
      frameTimeP50Ms: Number(p50.toFixed(2)),
      frameTimeP95Ms: Number(p95.toFixed(2)),
      frameTimeP99Ms: Number(p99.toFixed(2)),
      draws: this.lastDraws,
      triangles: this.lastTriangles,
      geometries: this.lastGeometries,
      textures: this.lastTextures,
      programs: this.lastPrograms,
      shaderWarmupMs: this.shaderWarmupMs,
      longTasksCount: this.longTasksCount,
      longTasksTotalMs: Number(this.longTasksTotalMs.toFixed(1)),
      activeIslandChunks: this.activeIslandChunks,
      warmIslandChunks: this.warmIslandChunks,
      spikeCounts: { ...this.spikeCounts },
    };
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}

export interface ArenaProfileWindowHandle {
  snapshot: () => ArenaRuntimeTelemetry;
  reset: () => void;
  getResidency: () => {
    estimatedTextureMb: number;
    classes: Record<ArenaResidencyClass, number>;
  };
}

declare global {
  interface Window {
    __EC_ARENA_PROFILE__?: ArenaProfileWindowHandle;
  }
}

export function bindArenaWindowProfiler(
  profiler: ArenaRuntimeProfiler,
  residency: ArenaResidencyManager,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handle: ArenaProfileWindowHandle = {
    snapshot: () => profiler.snapshot(),
    reset: () => profiler.resetWindow(),
    getResidency: () => ({
      estimatedTextureMb: residency.getEstimatedTextureMb(),
      classes: residency.getResidencySummary(),
    }),
  };
  window.__EC_ARENA_PROFILE__ = handle;
  return () => {
    if (window.__EC_ARENA_PROFILE__ === handle) {
      delete window.__EC_ARENA_PROFILE__;
    }
  };
}
