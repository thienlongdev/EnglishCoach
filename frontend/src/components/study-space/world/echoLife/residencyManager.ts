import * as T from 'three';
import type { QualityTier } from './renderConfig';

/**
 * Echo Life — Unified Ownership-Aware, Ref-Counted, Byte-Tracked LRU GPU Residency Manager.
 *
 * Calibrated for 4 GB laptop GPUs (RTX 3050 Laptop target) per `@perf-stream-reviewer` (§4):
 * - Separates 4 GB dGPU opt-in High (`high_4g`: `520/640 MB`, total app `<= 1,000 MB`) from
 *   >= 6 GB dGPU High (`high`: `740/900 MB`, total app `<= 1,400 MB`), Balanced (`380/460 MB`,
 *   total app `<= 700 MB`), Low (`220/300 MB`, total app `<= 450 MB`), and Ultra (`1250/1550 MB`,
 *   total app `<= 2,200 MB`).
 * - Dynamically subtracts actual live fixed GPU allocations (`totalApp - RT - shadows - PMREM - geometry`)
 *   so window resizes and DPR changes immediately tighten tracked residency before WDDM paging occurs.
 * - Supports explicit boot pinning (`pinBootEntry()` / `setBootActive()`) so no pruner can ever evict
 *   or dispose assets mid-warmup before the boot gate reaches `ready`.
 * - Explicitly closes `ImageBitmap` handles (`bitmap.close()`) strictly inside disposal helpers.
 */

export type ResidencyCategory =
  | 'core'
  | 'interior'
  | 'chunk'
  | 'prop'
  | 'npc'
  | 'vehicle'
  | 'pbr'
  | 'hdri'
  | 'veg';

export type ResidencyTierProfile = QualityTier | 'high_4g';

export interface ResidencyTierBudget {
  readonly profile: ResidencyTierProfile;
  readonly totalAppBudgetMB: number;
  readonly totalAppBudgetBytes: number;
  readonly softBudgetMB: number;
  readonly hardBudgetMB: number;
  readonly softBudgetBytes: number;
  readonly hardBudgetBytes: number;
  readonly maxCachedInteriors: number;
  readonly maxNpcTemplates: number;
}

export interface FixedGpuBreakdownBytes {
  readonly renderTargetsBytes: number;
  readonly shadowMapsBytes: number;
  readonly pmremBytes: number;
  readonly geometryBytes: number;
}

const MB = 1024 * 1024;
const MIN_DYNAMIC_TRACKED_FLOOR_BYTES = 128 * MB;

/**
 * Hard minimum LRU cooldown (`>= 8000 ms`) preventing circling a block or stepping indoor<->outdoor
 * through a doorway from unloading and reloading the same GPU assets repeatedly.
 */
export const MIN_RESIDENCY_HOLD_MS = 10_000;
export const MIN_RESIDENCY_HOLD_FLOOR_MS = 8_000;
export const RESIDENCY_HYSTERESIS_DIST_M = 28;
const THRASH_RELOAD_WINDOW_SEC = 60;

/** Conservative 4 GB RTX 3050 Laptop-safe tracked & total-app WebGL2 VRAM watermarks per tier profile. */
export const RESIDENCY_BUDGETS: Readonly<Record<ResidencyTierProfile, ResidencyTierBudget>> = Object.freeze({
  low: Object.freeze({
    profile: 'low',
    totalAppBudgetMB: 450,
    totalAppBudgetBytes: 450 * MB,
    softBudgetMB: 220,
    hardBudgetMB: 300,
    softBudgetBytes: 220 * MB,
    hardBudgetBytes: 300 * MB,
    maxCachedInteriors: 2,
    maxNpcTemplates: 8,
  }),
  balanced: Object.freeze({
    profile: 'balanced',
    totalAppBudgetMB: 700,
    totalAppBudgetBytes: 700 * MB,
    softBudgetMB: 380,
    hardBudgetMB: 460,
    softBudgetBytes: 380 * MB,
    hardBudgetBytes: 460 * MB,
    maxCachedInteriors: 3,
    maxNpcTemplates: 12,
  }),
  high_4g: Object.freeze({
    profile: 'high_4g',
    totalAppBudgetMB: 1000,
    totalAppBudgetBytes: 1000 * MB,
    softBudgetMB: 520,
    hardBudgetMB: 640,
    softBudgetBytes: 520 * MB,
    hardBudgetBytes: 640 * MB,
    maxCachedInteriors: 4,
    maxNpcTemplates: 14,
  }),
  high: Object.freeze({
    profile: 'high',
    totalAppBudgetMB: 1400,
    totalAppBudgetBytes: 1400 * MB,
    softBudgetMB: 740,
    hardBudgetMB: 900,
    softBudgetBytes: 740 * MB,
    hardBudgetBytes: 900 * MB,
    maxCachedInteriors: 5,
    maxNpcTemplates: 18,
  }),
  ultra: Object.freeze({
    profile: 'ultra',
    totalAppBudgetMB: 2200,
    totalAppBudgetBytes: 2200 * MB,
    softBudgetMB: 1250,
    hardBudgetMB: 1550,
    softBudgetBytes: 1250 * MB,
    hardBudgetBytes: 1550 * MB,
    maxCachedInteriors: 8,
    maxNpcTemplates: 26,
  }),
});

export function resolveResidencyTierProfile(
  tier: QualityTier,
  is4GbGpu = false,
): ResidencyTierProfile {
  if (tier === 'high' && is4GbGpu) return 'high_4g';
  return tier;
}

export const DEFAULT_RETENTION_SEC: Readonly<Record<ResidencyCategory, number>> = Object.freeze({
  core: Number.POSITIVE_INFINITY,
  interior: 45,
  npc: 60,
  vehicle: 45,
  prop: 35,
  chunk: 30,
  veg: 60,
  pbr: 90,
  hdri: 90,
});

export interface ResidencyRegisterOptions {
  readonly key: string;
  readonly category: ResidencyCategory;
  readonly estimatedBytes: number;
  readonly initialRefs?: number;
  readonly pinned?: boolean;
  readonly bootPinned?: boolean;
  readonly minRetentionSec?: number;
  readonly distanceM?: number;
  readonly dispose: () => void;
}

export interface ResidencyEntrySnapshot {
  readonly key: string;
  readonly category: ResidencyCategory;
  readonly estimatedBytes: number;
  readonly refCount: number;
  readonly pinned: boolean;
  readonly bootPinned: boolean;
  readonly minRetentionSec: number;
  readonly lastUsedSec: number;
  readonly lastDistanceM: number;
}

export interface ResidencyStats {
  readonly tier: QualityTier;
  readonly profile: ResidencyTierProfile;
  readonly bootActive: boolean;
  readonly bootPinnedCount: number;
  readonly totalEntries: number;
  readonly activeRefEntries: number;
  readonly evictableEntries: number;
  readonly totalResidentBytes: number;
  readonly totalResidentMB: number;
  readonly fixedOverheadBytes: number;
  readonly fixedBreakdown: Readonly<FixedGpuBreakdownBytes>;
  readonly effectiveTotalBytes: number;
  readonly effectiveTotalMB: number;
  readonly totalAppBudgetMB: number;
  /** Dynamic tracked soft watermark after subtracting fixed RT/shadow/PMREM/geometry bytes. */
  readonly effectiveSoftBudgetMB: number;
  /** Dynamic tracked hard watermark after subtracting fixed RT/shadow/PMREM/geometry bytes. */
  readonly effectiveHardBudgetMB: number;
  readonly softBudgetMB: number;
  readonly hardBudgetMB: number;
  readonly minResidencyHoldMs: number;
  readonly totalEvictions: number;
  readonly totalEvictedBytes: number;
  readonly thrashGuardBoosts: number;
  readonly bytesByCategory: Readonly<Record<ResidencyCategory, number>>;
  readonly countByCategory: Readonly<Record<ResidencyCategory, number>>;
}

interface InternalEntry {
  key: string;
  category: ResidencyCategory;
  estimatedBytes: number;
  refCount: number;
  pinned: boolean;
  minRetentionSec: number;
  lastUsedSec: number;
  releasedAtSec: number;
  lastDistanceM: number;
  hasDistance: boolean;
  dispose: () => void;
}

interface EvictCandidate {
  entry: InternalEntry;
  score: number;
}

const CATEGORIES: readonly ResidencyCategory[] = [
  'core',
  'interior',
  'chunk',
  'prop',
  'npc',
  'vehicle',
  'pbr',
  'hdri',
  'veg',
];

function nowSeconds(): number {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;
}

function bytesPerTexel(type: T.TextureDataType, format: T.AnyPixelFormat): number {
  let channels = 4;
  if (format === T.RedFormat || format === T.RedIntegerFormat || format === T.AlphaFormat || format === T.DepthFormat) {
    channels = 1;
  } else if (format === T.RGFormat || format === T.RGIntegerFormat) {
    channels = 2;
  } else if (format === T.RGBFormat || format === T.RGBIntegerFormat) {
    channels = 4;
  }

  switch (type) {
    case T.FloatType:
      return channels * 4;
    case T.HalfFloatType:
      return channels * 2;
    case T.UnsignedShortType:
    case T.ShortType:
      return channels * 2;
    case T.UnsignedIntType:
    case T.IntType:
    case T.UnsignedInt248Type:
      return 4;
    default:
      return channels;
  }
}

/**
 * Estimates uncompressed GPU memory footprint of a `THREE.Texture` including mipmap chain (`~1.333x`)
 * and cubemap faces (`6x`).
 */
export function estimateTextureGpuBytes(tex: T.Texture | null | undefined): number {
  if (!tex) return 0;
  const img = tex.image as
    | { width?: number; height?: number; length?: number; [idx: number]: { width?: number; height?: number } | undefined }
    | null
    | undefined;
  if (!img) return 0;

  let width = 0;
  let height = 0;
  let faces = 1;

  if (Array.isArray(img)) {
    if (img.length > 0) {
      faces = img.length;
      width = Number((img[0] as { width?: number } | undefined)?.width ?? 0);
      height = Number((img[0] as { height?: number } | undefined)?.height ?? 0);
    }
  } else {
    width = Number(img.width ?? 0);
    height = Number(img.height ?? 0);
  }

  if (width <= 0 || height <= 0) return 0;
  const bpp = bytesPerTexel(tex.type, tex.format);
  const mipFactor = tex.generateMipmaps !== false ? 1.3334 : 1.0;
  return Math.ceil(width * height * bpp * mipFactor * faces);
}

/**
 * Estimates total GPU VRAM footprint (vertex/index buffers + unique textures) of a Three.js object subtree.
 */
export function estimateObjectGpuBytes(root: T.Object3D): number {
  const seenGeo = new Set<T.BufferGeometry>();
  const seenTex = new Set<T.Texture>();
  let totalBytes = 0;

  const accountTex = (tex: unknown) => {
    if (tex instanceof T.Texture && !seenTex.has(tex)) {
      seenTex.add(tex);
      totalBytes += estimateTextureGpuBytes(tex);
    }
  };

  root.traverse((obj) => {
    const mesh = obj as T.Mesh;
    if (!mesh.isMesh) return;

    const geo = mesh.geometry;
    if (geo && !seenGeo.has(geo)) {
      seenGeo.add(geo);
      if (geo.index?.array) {
        totalBytes += geo.index.array.byteLength;
      }
      for (const attr of Object.values(geo.attributes)) {
        if (attr && 'array' in attr && attr.array) {
          totalBytes += attr.array.byteLength;
        }
      }
    }

    if ((obj as T.InstancedMesh).isInstancedMesh) {
      const inst = obj as T.InstancedMesh;
      if (inst.instanceMatrix?.array) totalBytes += inst.instanceMatrix.array.byteLength;
      if (inst.instanceColor?.array) totalBytes += inst.instanceColor.array.byteLength;
    }

    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const mat of mats) {
      if (!mat) continue;
      const rec = mat as unknown as Record<string, unknown>;
      accountTex(rec.map);
      accountTex(rec.normalMap);
      accountTex(rec.roughnessMap);
      accountTex(rec.metalnessMap);
      accountTex(rec.aoMap);
      accountTex(rec.emissiveMap);
      accountTex(rec.alphaMap);
      accountTex(rec.bumpMap);
      accountTex(rec.clearcoatMap);
      accountTex(rec.clearcoatNormalMap);
      accountTex(rec.clearcoatRoughnessMap);
      accountTex(rec.sheenColorMap);
      accountTex(rec.sheenRoughnessMap);
      accountTex(rec.envMap);
    }
  });

  return totalBytes;
}

/**
 * Safely disposes a `THREE.Texture` AND closes any backing `ImageBitmap` handle strictly inside disposal
 * (never while the texture is still alive, because anisotropy/tier updates may re-upload it).
 */
export function disposeTextureSafely(tex: T.Texture | null | undefined): void {
  if (!tex) return;
  const img = tex.image as unknown;
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
    try {
      img.close();
    } catch {
      /* already closed */
    }
  } else if (Array.isArray(img)) {
    for (const face of img) {
      if (typeof ImageBitmap !== 'undefined' && face instanceof ImageBitmap) {
        try {
          face.close();
        } catch {
          /* already closed */
        }
      }
    }
  }
  tex.dispose();
}

/**
 * Disposes geometries, materials, and textures (including `ImageBitmap.close()`) inside a subtree.
 * Skips resources flagged with `userData.shared === true` unless `disposeShared` is explicitly set.
 */
export function disposeObjectResourcesSafely(
  root: T.Object3D,
  opts: { disposeShared?: boolean; clearChildren?: boolean } = {},
): void {
  const disposeShared = opts.disposeShared === true;
  const geometries = new Set<T.BufferGeometry>();
  const materials = new Set<T.Material>();
  const textures = new Set<T.Texture>();

  root.traverse((obj) => {
    if (obj instanceof T.InstancedMesh) {
      obj.dispose();
    } else if (typeof T.BatchedMesh === 'function' && obj instanceof T.BatchedMesh) {
      obj.dispose();
    }
    const mesh = obj as T.Mesh;
    if (!mesh.isMesh) return;

    if (mesh.geometry && (disposeShared || !mesh.geometry.userData?.shared)) {
      geometries.add(mesh.geometry);
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const mat of mats) {
      if (!mat) continue;
      if (!disposeShared && mat.userData?.shared) continue;
      materials.add(mat);
      const rec = mat as unknown as Record<string, unknown>;
      for (const slot of [
        'map',
        'normalMap',
        'roughnessMap',
        'metalnessMap',
        'aoMap',
        'emissiveMap',
        'alphaMap',
        'bumpMap',
        'clearcoatMap',
        'clearcoatNormalMap',
        'clearcoatRoughnessMap',
        'sheenColorMap',
        'sheenRoughnessMap',
      ]) {
        const tex = rec[slot];
        if (tex instanceof T.Texture && (disposeShared || !tex.userData?.shared)) {
          textures.add(tex);
        }
      }
    }
  });

  for (const tex of textures) disposeTextureSafely(tex);
  for (const mat of materials) mat.dispose();
  for (const geo of geometries) geo.dispose();

  if (opts.clearChildren) {
    while (root.children.length > 0) {
      root.remove(root.children[root.children.length - 1]);
    }
  }
}

export class EchoLifeResidencyManager {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly bootPinnedKeys = new Set<string>();
  private readonly recentEvictions = new Map<string, number>();
  private readonly candidatePool: EvictCandidate[] = [];
  private tier: QualityTier;
  private profile: ResidencyTierProfile;
  private bootActive = false;
  private totalResidentBytes = 0;
  private minHoldMs = MIN_RESIDENCY_HOLD_MS;
  private vramBudgetOverrideBytes: number | null = null;
  private fixedBreakdown: FixedGpuBreakdownBytes = {
    renderTargetsBytes: 0,
    shadowMapsBytes: 0,
    pmremBytes: 0,
    geometryBytes: 0,
  };
  private lastEvictTickSec = -Infinity;
  private readonly evictCadenceSec = 1.0;
  private totalEvictions = 0;
  private totalEvictedBytes = 0;
  private thrashGuardBoosts = 0;

  constructor(initialProfile: ResidencyTierProfile = 'balanced', minResidencyHoldMs = MIN_RESIDENCY_HOLD_MS) {
    this.profile = initialProfile;
    this.tier = initialProfile === 'high_4g' ? 'high' : initialProfile;
    this.minHoldMs = Math.max(MIN_RESIDENCY_HOLD_FLOOR_MS, Math.round(minResidencyHoldMs));
  }

  get minResidencyHoldMs(): number {
    return this.minHoldMs;
  }

  setMinResidencyHoldMs(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.minHoldMs = Math.max(MIN_RESIDENCY_HOLD_FLOOR_MS, Math.round(ms));
  }

  /** Optional explicit tracked VRAM ceiling override (in MB) from `renderConfig.streaming.vramBudgetMB`. */
  setVramBudgetOverrideMB(vramBudgetMB: number | null | undefined): void {
    if (vramBudgetMB === null || vramBudgetMB === undefined || !Number.isFinite(vramBudgetMB) || vramBudgetMB <= 0) {
      this.vramBudgetOverrideBytes = null;
      return;
    }
    this.vramBudgetOverrideBytes = Math.max(MIN_DYNAMIC_TRACKED_FLOOR_BYTES, Math.round(vramBudgetMB * MB));
  }

  private get minHoldSec(): number {
    return this.minHoldMs * 0.001;
  }

  get qualityTier(): QualityTier {
    return this.tier;
  }

  get tierProfile(): ResidencyTierProfile {
    return this.profile;
  }

  get budget(): ResidencyTierBudget {
    return RESIDENCY_BUDGETS[this.profile];
  }

  get isBootActive(): boolean {
    return this.bootActive;
  }

  setQualityTier(tier: QualityTier, is4GbGpu = false): void {
    this.tier = tier;
    this.profile = resolveResidencyTierProfile(tier, is4GbGpu);
  }

  setTierProfile(profile: ResidencyTierProfile): void {
    this.profile = profile;
    this.tier = profile === 'high_4g' ? 'high' : profile;
  }

  /**
   * Updates fixed non-evictable GPU allocations (`RT`, `shadows`, `PMREM`, unmeasured `geometry`),
   * recomputing dynamic tracked watermarks via `totalApp - RT - shadows - PMREM - geometry`.
   * Call on renderer init, resize, DPR change, or tier change.
   */
  setFixedGpuBreakdown(breakdown: Partial<FixedGpuBreakdownBytes>): void {
    this.fixedBreakdown = {
      renderTargetsBytes: Math.max(0, Math.round(breakdown.renderTargetsBytes ?? this.fixedBreakdown.renderTargetsBytes)),
      shadowMapsBytes: Math.max(0, Math.round(breakdown.shadowMapsBytes ?? this.fixedBreakdown.shadowMapsBytes)),
      pmremBytes: Math.max(0, Math.round(breakdown.pmremBytes ?? this.fixedBreakdown.pmremBytes)),
      geometryBytes: Math.max(0, Math.round(breakdown.geometryBytes ?? this.fixedBreakdown.geometryBytes)),
    };
  }

  /** Convenience helper when only aggregate fixed overhead bytes are known. */
  setFixedOverheadBytes(bytes: number): void {
    this.setFixedGpuBreakdown({
      renderTargetsBytes: Math.max(0, Math.round(bytes)),
      shadowMapsBytes: 0,
      pmremBytes: 0,
      geometryBytes: 0,
    });
  }

  private totalFixedBytes(): number {
    return (
      this.fixedBreakdown.renderTargetsBytes +
      this.fixedBreakdown.shadowMapsBytes +
      this.fixedBreakdown.pmremBytes +
      this.fixedBreakdown.geometryBytes
    );
  }

  /**
   * Dynamic tracked residency watermarks derived by subtracting fixed GPU allocations from the
   * profile's total-app budget (`tracked = totalApp - RT - shadows - PMREM - geometry`), clamped to
   * the profile's static ceilings so high-res panels (`1440p`/`1600p`) automatically tighten tracked cache.
   */
  effectiveTrackedBudgets(): { softBytes: number; hardBytes: number } {
    const b = this.budget;
    const fixed = this.totalFixedBytes();
    const remainingApp = Math.max(MIN_DYNAMIC_TRACKED_FLOOR_BYTES, b.totalAppBudgetBytes - fixed);
    let hardBytes = Math.min(b.hardBudgetBytes, remainingApp);
    if (this.vramBudgetOverrideBytes !== null) {
      hardBytes = Math.min(hardBytes, this.vramBudgetOverrideBytes);
    }
    const softBytes = Math.min(b.softBudgetBytes, Math.floor(hardBytes * 0.82));
    return { softBytes, hardBytes };
  }

  /** Enables or disables boot-gate eviction lockdown (`true` during G0/G1 boot; `false` on `ready`). */
  setBootActive(active: boolean): void {
    this.bootActive = active;
    if (!active) {
      this.unpinBootEntries();
    }
  }

  /** Pins a residency key until the boot gate completes (`unpinBootEntries()`). */
  pinBootEntry(key: string): void {
    this.bootPinnedKeys.add(key);
    const entry = this.entries.get(key);
    if (entry) {
      const now = nowSeconds();
      entry.lastUsedSec = now;
      entry.releasedAtSec = now;
    }
  }

  /** Releases all temporary boot pins once `EchoLifeBootOrchestrator` transitions to `ready`. */
  unpinBootEntries(): void {
    const now = nowSeconds();
    for (const key of this.bootPinnedKeys) {
      const entry = this.entries.get(key);
      if (entry) {
        entry.lastUsedSec = now;
        entry.releasedAtSec = now;
      }
    }
    this.bootPinnedKeys.clear();
  }

  private isProtected(entry: InternalEntry): boolean {
    return entry.refCount > 0 || entry.pinned || this.bootPinnedKeys.has(entry.key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): ResidencyEntrySnapshot | null {
    const e = this.entries.get(key);
    if (!e) return null;
    return {
      key: e.key,
      category: e.category,
      estimatedBytes: e.estimatedBytes,
      refCount: e.refCount,
      pinned: e.pinned,
      bootPinned: this.bootPinnedKeys.has(e.key),
      minRetentionSec: e.minRetentionSec,
      lastUsedSec: e.lastUsedSec,
      lastDistanceM: e.lastDistanceM,
    };
  }

  /** Registers or updates a tracked GPU resource entry (auto-boot-pinned if registered during boot). */
  register(opts: ResidencyRegisterOptions): void {
    const now = nowSeconds();
    const safeBytes = Math.max(0, Math.round(opts.estimatedBytes));
    if (opts.bootPinned || this.bootActive) {
      this.bootPinnedKeys.add(opts.key);
    }

    // Anti-thrash backoff: if this asset was evicted within the last 60 s (e.g. circling a block or
    // stepping indoor<->outdoor repeatedly), double its retention window so it stays warm!
    const prevEvictSec = this.recentEvictions.get(opts.key);
    let retentionBoost = 1;
    if (prevEvictSec !== undefined) {
      this.recentEvictions.delete(opts.key);
      if (now - prevEvictSec <= THRASH_RELOAD_WINDOW_SEC) {
        retentionBoost = 2;
        this.thrashGuardBoosts++;
      }
    }

    const rawRetention = opts.minRetentionSec ?? DEFAULT_RETENTION_SEC[opts.category];
    const baseRetention =
      rawRetention === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Math.max(this.minHoldSec, rawRetention);
    const effectiveRetention =
      baseRetention === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Math.min(180, Math.max(baseRetention * retentionBoost, retentionBoost > 1 ? 60 : baseRetention));

    const existing = this.entries.get(opts.key);
    if (existing) {
      this.totalResidentBytes -= existing.estimatedBytes;
      existing.category = opts.category;
      existing.estimatedBytes = safeBytes;
      existing.dispose = opts.dispose;
      if (opts.pinned !== undefined) existing.pinned = opts.pinned;
      if (opts.minRetentionSec !== undefined || retentionBoost > 1) {
        existing.minRetentionSec = Math.max(existing.minRetentionSec, effectiveRetention);
      }
      if (opts.distanceM !== undefined) {
        existing.lastDistanceM = Math.max(0, opts.distanceM);
        existing.hasDistance = true;
      }
      if (opts.initialRefs !== undefined) existing.refCount = Math.max(existing.refCount, opts.initialRefs);
      existing.lastUsedSec = now;
      existing.releasedAtSec = now;
      this.totalResidentBytes += safeBytes;
      return;
    }

    const entry: InternalEntry = {
      key: opts.key,
      category: opts.category,
      estimatedBytes: safeBytes,
      refCount: Math.max(0, opts.initialRefs ?? 0),
      pinned: opts.pinned ?? opts.category === 'core',
      minRetentionSec: effectiveRetention,
      lastUsedSec: now,
      releasedAtSec: now,
      lastDistanceM: Math.max(0, opts.distanceM ?? 0),
      hasDistance: opts.distanceM !== undefined,
      dispose: opts.dispose,
    };
    this.entries.set(opts.key, entry);
    this.totalResidentBytes += safeBytes;
  }

  acquire(key: string, distanceM?: number): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    const now = nowSeconds();
    e.refCount++;
    e.lastUsedSec = now;
    e.releasedAtSec = now;
    if (distanceM !== undefined) {
      e.lastDistanceM = Math.max(0, distanceM);
      e.hasDistance = true;
    }
    return true;
  }

  release(key: string, distanceM?: number): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    const now = nowSeconds();
    e.refCount = Math.max(0, e.refCount - 1);
    e.lastUsedSec = now;
    e.releasedAtSec = now;
    if (distanceM !== undefined) {
      e.lastDistanceM = Math.max(0, distanceM);
      e.hasDistance = true;
    }
    return true;
  }

  touch(key: string, distanceM?: number): void {
    const e = this.entries.get(key);
    if (!e) return;
    const now = nowSeconds();
    e.lastUsedSec = now;
    e.releasedAtSec = now;
    if (distanceM !== undefined) {
      e.lastDistanceM = Math.max(0, distanceM);
      e.hasDistance = true;
    }
  }

  updateDistance(key: string, distanceM: number): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.lastDistanceM = Math.max(0, distanceM);
    e.hasDistance = true;
  }

  updateBytes(key: string, estimatedBytes: number): void {
    const e = this.entries.get(key);
    if (!e) return;
    const next = Math.max(0, Math.round(estimatedBytes));
    this.totalResidentBytes += next - e.estimatedBytes;
    e.estimatedBytes = next;
  }

  setPinned(key: string, pinned: boolean): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.pinned = pinned;
    e.lastUsedSec = nowSeconds();
  }

  unregister(key: string, invokeDispose = false): boolean {
    this.bootPinnedKeys.delete(key);
    const e = this.entries.get(key);
    if (!e) return false;
    this.entries.delete(key);
    this.totalResidentBytes = Math.max(0, this.totalResidentBytes - e.estimatedBytes);
    if (invokeDispose) {
      try {
        e.dispose();
      } catch {
        /* isolate disposal errors */
      }
    }
    return true;
  }

  /** 1 Hz throttled housekeeping entrypoint for the main simulation loop. */
  tick(nowSec = nowSeconds()): number {
    if (this.bootActive) return 0;
    if (nowSec - this.lastEvictTickSec < this.evictCadenceSec) {
      return 0;
    }
    this.lastEvictTickSec = nowSec;
    return this.evictIfNeeded(nowSec, false);
  }

  /**
   * Evaluates dynamic soft/hard tracked watermarks and category caps (`maxCachedInteriors`, `maxNpcTemplates`),
   * evicting only unreferenced, unpinned, non-boot-pinned entries using distance-weighted LRU scoring
   * and a strict `minResidencyHoldMs >= 8000 ms` + distance hysteresis floor.
   */
  evictIfNeeded(nowSec = nowSeconds(), force = false): number {
    if (this.bootActive && !force) return 0;

    const budget = this.budget;
    const { softBytes, hardBytes } = this.effectiveTrackedBudgets();
    const minHoldSec = this.minHoldSec;
    let evictedCount = 0;

    evictedCount += this.enforceCategoryCap('interior', budget.maxCachedInteriors, nowSec);
    evictedCount += this.enforceCategoryCap('npc', budget.maxNpcTemplates, nowSec);

    if (!force && this.totalResidentBytes <= softBytes) {
      return evictedCount;
    }

    // 1. Soft watermark trim: strictly honors `max(minHoldSec, minRetentionSec)` AND distance hysteresis (>= 28 m).
    const softTarget = Math.floor(softBytes * 0.88);
    if (this.totalResidentBytes > softBytes || force) {
      const target = force ? Math.min(softTarget, softBytes) : softTarget;
      evictedCount += this.evictPass(
        nowSec,
        target,
        (entry, idleSec) =>
          idleSec >= Math.max(minHoldSec, entry.minRetentionSec) &&
          (!entry.hasDistance || entry.lastDistanceM >= RESIDENCY_HYSTERESIS_DIST_M),
      );
    }

    // 2. Hard watermark guard: relaxes retention down to `minHoldSec` (>= 8 s) while protecting nearby (< 24 m) entries.
    if (this.totalResidentBytes > hardBytes) {
      const hardTarget = Math.floor(softBytes * 0.96);
      evictedCount += this.evictPass(
        nowSec,
        hardTarget,
        (entry, idleSec) => idleSec >= minHoldSec && (!entry.hasDistance || entry.lastDistanceM >= 24),
      );
    }

    // 3. Extreme OOM ceiling (> 112% hard tracked budget): keeps `minHoldSec` first, then >= 4 s emergency fallback.
    if (this.totalResidentBytes > hardBytes * 1.12) {
      evictedCount += this.evictPass(nowSec, hardBytes, (_entry, idleSec) => idleSec >= minHoldSec);
      if (this.totalResidentBytes > hardBytes * 1.15) {
        evictedCount += this.evictPass(nowSec, hardBytes, (_entry, idleSec) => idleSec >= (force ? 0 : 4));
      }
    }

    return evictedCount;
  }

  private pushCandidateSorted(count: number, entry: InternalEntry, score: number): number {
    let slot: EvictCandidate;
    if (count < this.candidatePool.length) {
      slot = this.candidatePool[count];
      slot.entry = entry;
      slot.score = score;
    } else {
      slot = { entry, score };
      this.candidatePool.push(slot);
    }
    let pos = count;
    while (pos > 0 && this.candidatePool[pos - 1].score < score) {
      this.candidatePool[pos] = this.candidatePool[pos - 1];
      pos--;
    }
    this.candidatePool[pos] = slot;
    return count + 1;
  }

  private clearCandidateRefs(count: number): void {
    const dummy = null as unknown as InternalEntry;
    for (let i = 0; i < count; i++) {
      this.candidatePool[i].entry = dummy;
    }
  }

  private enforceCategoryCap(category: ResidencyCategory, maxCached: number, nowSec: number): number {
    if (maxCached <= 0) return 0;
    const minHoldSec = this.minHoldSec;
    let totalInCat = 0;
    let candCount = 0;

    for (const entry of this.entries.values()) {
      if (entry.category !== category) continue;
      totalInCat++;
      if (this.isProtected(entry)) continue;
      const idleSec = Math.max(0, nowSec - Math.max(entry.lastUsedSec, entry.releasedAtSec));
      if (idleSec < Math.max(minHoldSec, entry.minRetentionSec)) continue;
      if (entry.hasDistance && entry.lastDistanceM < RESIDENCY_HYSTERESIS_DIST_M && totalInCat <= maxCached + 2) {
        continue;
      }
      const distTerm = entry.hasDistance ? entry.lastDistanceM * 0.65 : 22;
      candCount = this.pushCandidateSorted(candCount, entry, distTerm + idleSec);
    }

    const excess = totalInCat - maxCached;
    if (excess <= 0 || candCount === 0) {
      this.clearCandidateRefs(candCount);
      return 0;
    }

    let evicted = 0;
    for (let i = 0; i < candCount && evicted < excess; i++) {
      if (this.evictEntry(this.candidatePool[i].entry, nowSec)) evicted++;
    }
    this.clearCandidateRefs(candCount);
    return evicted;
  }

  private evictPass(
    nowSec: number,
    targetTrackedBytes: number,
    eligible: (entry: InternalEntry, idleSec: number) => boolean,
  ): number {
    let candCount = 0;
    for (const entry of this.entries.values()) {
      if (this.isProtected(entry)) continue;
      const idleSec = Math.max(0, nowSec - Math.max(entry.lastUsedSec, entry.releasedAtSec));
      if (!eligible(entry, idleSec)) continue;
      const distTerm = entry.hasDistance ? entry.lastDistanceM * 0.65 : 22;
      candCount = this.pushCandidateSorted(candCount, entry, distTerm + idleSec);
    }
    if (candCount === 0) return 0;

    let evicted = 0;
    for (let i = 0; i < candCount; i++) {
      if (this.totalResidentBytes <= targetTrackedBytes) break;
      if (this.evictEntry(this.candidatePool[i].entry, nowSec)) evicted++;
    }
    this.clearCandidateRefs(candCount);
    return evicted;
  }

  private evictEntry(entry: InternalEntry, nowSec = nowSeconds()): boolean {
    if (!this.entries.delete(entry.key)) return false;
    this.bootPinnedKeys.delete(entry.key);
    this.totalResidentBytes = Math.max(0, this.totalResidentBytes - entry.estimatedBytes);
    this.totalEvictions++;
    this.totalEvictedBytes += entry.estimatedBytes;
    if (this.recentEvictions.size >= 128) {
      const oldestKey = this.recentEvictions.keys().next().value;
      if (oldestKey !== undefined) this.recentEvictions.delete(oldestKey);
    }
    this.recentEvictions.set(entry.key, nowSec);
    try {
      entry.dispose();
    } catch {
      /* isolate disposer error */
    }
    return true;
  }

  disposeAll(): void {
    const all = Array.from(this.entries.values());
    this.entries.clear();
    this.bootPinnedKeys.clear();
    this.recentEvictions.clear();
    this.candidatePool.length = 0;
    this.bootActive = false;
    this.totalResidentBytes = 0;
    this.fixedBreakdown = { renderTargetsBytes: 0, shadowMapsBytes: 0, pmremBytes: 0, geometryBytes: 0 };
    for (const entry of all) {
      try {
        entry.dispose();
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  stats(): ResidencyStats {
    const bytesByCategory = {} as Record<ResidencyCategory, number>;
    const countByCategory = {} as Record<ResidencyCategory, number>;
    for (const c of CATEGORIES) {
      bytesByCategory[c] = 0;
      countByCategory[c] = 0;
    }

    let activeRefEntries = 0;
    let evictableEntries = 0;
    for (const e of this.entries.values()) {
      bytesByCategory[e.category] += e.estimatedBytes;
      countByCategory[e.category]++;
      if (e.refCount > 0) activeRefEntries++;
      else if (!this.isProtected(e)) evictableEntries++;
    }

    const fixedOverheadBytes = this.totalFixedBytes();
    const effectiveTotalBytes = this.totalResidentBytes + fixedOverheadBytes;
    const budget = this.budget;
    const { softBytes, hardBytes } = this.effectiveTrackedBudgets();

    return {
      tier: this.tier,
      profile: this.profile,
      bootActive: this.bootActive,
      bootPinnedCount: this.bootPinnedKeys.size,
      totalEntries: this.entries.size,
      activeRefEntries,
      evictableEntries,
      totalResidentBytes: this.totalResidentBytes,
      totalResidentMB: Number((this.totalResidentBytes / MB).toFixed(2)),
      fixedOverheadBytes,
      fixedBreakdown: { ...this.fixedBreakdown },
      effectiveTotalBytes,
      effectiveTotalMB: Number((effectiveTotalBytes / MB).toFixed(2)),
      totalAppBudgetMB: budget.totalAppBudgetMB,
      effectiveSoftBudgetMB: Number((softBytes / MB).toFixed(2)),
      effectiveHardBudgetMB: Number((hardBytes / MB).toFixed(2)),
      softBudgetMB: budget.softBudgetMB,
      hardBudgetMB: budget.hardBudgetMB,
      minResidencyHoldMs: this.minHoldMs,
      totalEvictions: this.totalEvictions,
      totalEvictedBytes: this.totalEvictedBytes,
      thrashGuardBoosts: this.thrashGuardBoosts,
      bytesByCategory,
      countByCategory,
    };
  }
}

let sharedResidencyManager: EchoLifeResidencyManager | null = null;

export function getEchoLifeResidencyManager(
  initialProfile: ResidencyTierProfile = 'balanced',
): EchoLifeResidencyManager {
  if (!sharedResidencyManager) {
    sharedResidencyManager = new EchoLifeResidencyManager(initialProfile);
  }
  return sharedResidencyManager;
}

export function resetEchoLifeResidencyManager(disposeEntries = false): void {
  if (sharedResidencyManager && disposeEntries) {
    sharedResidencyManager.disposeAll();
  }
  sharedResidencyManager = null;
}
