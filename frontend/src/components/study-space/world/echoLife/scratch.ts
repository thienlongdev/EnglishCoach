import * as T from 'three';

/**
 * Echo Life — Zero-Allocation Frame-Loop Scratch Pool, Static Hierarchy Freezing & Strict GPU Disposal Utilities.
 *
 * Shared by performance-critical tick/render/culling paths (`engine.ts`, `exploration.ts`, `manipulation.ts`,
 * `streaming.ts`, `buildingsView.ts`, `gameView.ts`, `grassField.ts`, vegetation LOD managers) to eliminate
 * per-frame heap churn, skip redundant `Object3D.updateMatrixWorld()` walks on static world geometry, and
 * guarantee leak-free WebGL resource teardown across repeated chunk transitions.
 *
 * Usage contract for scratch objects:
 * - Borrow synchronously inside a single function call; never retain references across `await` or across frames.
 * - Never pass a scratch object into a callee that also borrows the same scratch slot.
 */

export const V3_A = new T.Vector3();
export const V3_B = new T.Vector3();
export const V3_C = new T.Vector3();
export const V3_D = new T.Vector3();
export const V3_E = new T.Vector3();
export const V3_F = new T.Vector3();

export const V2_A = new T.Vector2();
export const V2_B = new T.Vector2();

export const Q_A = new T.Quaternion();
export const Q_B = new T.Quaternion();
export const Q_C = new T.Quaternion();

export const M4_A = new T.Matrix4();
export const M4_B = new T.Matrix4();
export const M4_C = new T.Matrix4();

export const BOX_A = new T.Box3();
export const BOX_B = new T.Box3();
export const SPH_A = new T.Sphere();
export const RAY_A = new T.Raycaster();
export const RAY_B = new T.Raycaster();
export const PLANE_A = new T.Plane();
export const FRUSTUM_A = new T.Frustum();

export const COLOR_A = new T.Color();
export const COLOR_B = new T.Color();

const ORIG_UPDATE_MATRIX_WORLD = T.Object3D.prototype.updateMatrixWorld;
const ORIG_UPDATE_WORLD_MATRIX = T.Object3D.prototype.updateWorldMatrix;
const ORIG_SKELETON_UPDATE = T.Skeleton.prototype.update;

/** Cached 16-float parent `matrixWorld` snapshot per frozen branch root so `force=true` cascades skip in O(1). */
const FROZEN_PARENT_MAT = new WeakMap<T.Object3D, Float32Array>();

function snapshotParentMatrix(node: T.Object3D): void {
  const parent = node.parent;
  if (!parent) {
    FROZEN_PARENT_MAT.delete(node);
    return;
  }
  const pe = parent.matrixWorld.elements;
  let buf = FROZEN_PARENT_MAT.get(node);
  if (!buf) {
    buf = new Float32Array(16);
    FROZEN_PARENT_MAT.set(node, buf);
  }
  for (let i = 0; i < 16; i++) buf[i] = pe[i];
}

function parentMatrixChanged(node: T.Object3D): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const pe = parent.matrixWorld.elements;
  let prev = FROZEN_PARENT_MAT.get(node);
  if (!prev) {
    prev = new Float32Array(16);
    for (let i = 0; i < 16; i++) prev[i] = pe[i];
    FROZEN_PARENT_MAT.set(node, prev);
    return true;
  }
  for (let i = 0; i < 16; i++) {
    if (prev[i] !== pe[i]) {
      for (let j = i; j < 16; j++) prev[j] = pe[j];
      return true;
    }
  }
  return false;
}

/**
 * O(1) `Object3D.updateMatrixWorld` override for completely static subtrees in Three.js `0.186.1`.
 *
 * Three.js `r186` unconditionally recurses `this.children` inside `updateMatrixWorld(force)` even when
 * `matrixWorldAutoUpdate === false`, and any unfrozen ancestor (`scene`/`stage`) propagates `force = true`
 * root-to-leaf. Attaching this shared method to purely-static branch roots skips all descendant recursion in
 * O(1) unless `matrixWorldNeedsUpdate` is set or the parent's `matrixWorld` actually changed (e.g. `stage.scale`).
 */
export function frozenUpdateMatrixWorld(this: T.Object3D, force?: boolean): void {
  if (this.matrixWorldNeedsUpdate || (force === true && parentMatrixChanged(this))) {
    ORIG_UPDATE_MATRIX_WORLD.call(this, true);
  }
}

/** O(1) `Object3D.updateWorldMatrix` companion override preserving explicit `updateParents` & dirty propagation. */
export function frozenUpdateWorldMatrix(
  this: T.Object3D,
  updateParents?: boolean,
  updateChildren?: boolean,
): void {
  if (updateParents === true && this.parent !== null) {
    this.parent.updateWorldMatrix(true, false);
  }
  if (this.matrixWorldNeedsUpdate || parentMatrixChanged(this)) {
    ORIG_UPDATE_WORLD_MATRIX.call(this, false, updateChildren === true);
  }
}

/** Clears O(1) frozen method overrides without changing `matrixAutoUpdate` flags. */
function clearFrozenOverrides(node: T.Object3D): void {
  if (node.updateMatrixWorld === frozenUpdateMatrixWorld) {
    delete (node as { updateMatrixWorld?: T.Object3D['updateMatrixWorld'] }).updateMatrixWorld;
  }
  if (node.updateWorldMatrix === frozenUpdateWorldMatrix) {
    delete (node as { updateWorldMatrix?: T.Object3D['updateWorldMatrix'] }).updateWorldMatrix;
  }
  FROZEN_PARENT_MAT.delete(node);
}

/** Updates a `THREE.Frustum` from a camera's current projection & world-inverse matrices with zero allocations. */
export function updateFrustumFromCamera(camera: T.Camera, out: T.Frustum = FRUSTUM_A): T.Frustum {
  M4_A.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  out.setFromProjectionMatrix(M4_A);
  return out;
}

/** Updates a single mutated bone (and optional parent chain stop) without traversing the entire skeleton. */
export function updateSingleBoneWorldMatrix(bone: T.Object3D): void {
  bone.updateMatrix();
  if (bone.parent) {
    bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
  } else {
    bone.matrixWorld.copy(bone.matrix);
  }
  bone.matrixWorldNeedsUpdate = false;
}

export interface FreezeStaticOptions {
  /** Optional predicate identifying nodes that animate/move per frame and must stay auto-updating. */
  isDynamic?: (obj: T.Object3D) => boolean;
}

function isDynamicNode(obj: T.Object3D, predicate?: (o: T.Object3D) => boolean): boolean {
  if (obj.userData?.dynamic === true || obj.userData?.door === true) return true;
  if ((obj as T.SkinnedMesh).isSkinnedMesh) return true;
  if (predicate && predicate(obj)) return true;
  return false;
}

/**
 * Computes local & world matrices once for `root`, disables per-frame matrix recomputation on all static
 * meshes/groups (`matrixAutoUpdate = false`), and installs the O(1) `frozenUpdateMatrixWorld` /
 * `frozenUpdateWorldMatrix` branch skipper on the highest purely-static subtree roots.
 *
 * Unlike setting `matrixWorldAutoUpdate = false` alone (which Three.js `0.186.1` still walks recursively),
 * this eliminates thousands of wasted child traversals per render/reflection/shadow pass while automatically
 * re-propagating whenever `stage.scale`, parent transforms, or `syncFrozenTransform()` mutate.
 *
 * @returns Number of scene-graph nodes frozen.
 */
export function freezeStaticHierarchy(root: T.Object3D, opts: FreezeStaticOptions = {}): number {
  // Ensure existing overrides do not block the initial full world-matrix bake.
  root.traverse(clearFrozenOverrides);
  if (root.parent) {
    root.parent.updateWorldMatrix(true, false);
  }
  ORIG_UPDATE_MATRIX_WORLD.call(root, true);

  let frozen = 0;

  const visit = (node: T.Object3D): boolean => {
    if (isDynamicNode(node, opts.isDynamic)) {
      clearFrozenOverrides(node);
      node.matrixAutoUpdate = true;
      node.matrixWorldAutoUpdate = true;
      return true;
    }

    let hasDynamicDescendant = false;
    const children = node.children;
    const staticChildFlags: boolean[] = [];
    for (let i = 0; i < children.length; i++) {
      const childHasDynamic = visit(children[i]);
      staticChildFlags.push(!childHasDynamic);
      if (childHasDynamic) hasDynamicDescendant = true;
    }

    // Keep `matrixAutoUpdate = false` (skip `compose()` forever) while keeping `matrixWorldAutoUpdate = true`
    // so that when `stage.scale` or a parent transform genuinely mutates, `ORIG_UPDATE_MATRIX_WORLD(true)`
    // recomputes exact `matrixWorld = parent.matrixWorld * matrix` across the branch! On all unchanged frames,
    // `frozenUpdateMatrixWorld` on the branch root returns in O(1) before touching any descendant.
    node.matrixAutoUpdate = false;
    node.matrixWorldAutoUpdate = true;
    node.matrixWorldNeedsUpdate = false;

    if (hasDynamicDescendant) {
      // Dynamic descendants exist beneath `node`: keep traversal open on `node`, and seal purely-static child branches!
      clearFrozenOverrides(node);
      for (let i = 0; i < children.length; i++) {
        if (staticChildFlags[i]) {
          const ch = children[i];
          ch.updateMatrixWorld = frozenUpdateMatrixWorld;
          ch.updateWorldMatrix = frozenUpdateWorldMatrix;
          snapshotParentMatrix(ch);
        }
      }
    } else if (node === root) {
      // Entire `root` subtree is purely static: seal at `root` itself in O(1).
      node.updateMatrixWorld = frozenUpdateMatrixWorld;
      node.updateWorldMatrix = frozenUpdateWorldMatrix;
      snapshotParentMatrix(node);
    }

    frozen++;
    return hasDynamicDescendant;
  };

  visit(root);
  return frozen;
}

/** Re-enables `matrixAutoUpdate`, `matrixWorldAutoUpdate`, and native matrix traversal on a subtree. */
export function unfreezeHierarchy(root: T.Object3D): void {
  root.traverse((obj) => {
    clearFrozenOverrides(obj);
    obj.matrixAutoUpdate = true;
    obj.matrixWorldAutoUpdate = true;
    obj.matrixWorldNeedsUpdate = true;
  });
}

/** Alias matching Phase 1E/Wave 2 naming convention for restoring a frozen static subtree. */
export const unfreezeStaticHierarchy = unfreezeHierarchy;

/** Updates a frozen object's local and world matrices after an explicit transform edit. */
export function syncFrozenTransform(obj: T.Object3D): void {
  if (obj.parent) {
    obj.parent.updateWorldMatrix(true, false);
  }
  obj.updateMatrix();
  obj.matrixWorldNeedsUpdate = true;
  ORIG_UPDATE_MATRIX_WORLD.call(obj, true);
  if (obj.updateMatrixWorld === frozenUpdateMatrixWorld) {
    snapshotParentMatrix(obj);
  }
}

export interface DirtyGatedSkeletonHandle {
  /** Registers any newly mounted `SkinnedMesh` skeletons under `subRoot` (e.g. modular outerwear). */
  registerRoot: (subRoot: T.Object3D) => void;
  /** Marks all skeletons registered on this handle dirty so the next render updates `boneMatrices` and `boneTexture`. */
  markDirty: () => void;
  /** Freezes or unfreezes skeleton updates for the current frame; unfreezing marks every skeleton dirty. */
  setFrozenThisFrame: (frozen: boolean) => void;
  /** Restores native `Skeleton.prototype.update` on all attached skeletons. */
  dispose: () => void;
}

export type DirtySkeletonHandle = DirtyGatedSkeletonHandle;

/**
 * Wraps `THREE.Skeleton.update()` for throttled animated characters (e.g. mid/far NPCs) so skipped animation
 * frames avoid redundant 52-65 bone matrix multiplications AND `gl.texSubImage2D` boneTexture uploads.
 * Tracks dirty state independently per `THREE.Skeleton` instance so multi-skeleton characters (body + modular
 * winter outerwear) update every skeleton cleanly before freezing.
 */
export function bindDirtyGatedSkeleton(root: T.Object3D): DirtyGatedSkeletonHandle {
  const skeletonSet = new Set<T.Skeleton>();
  const skeletons: T.Skeleton[] = [];
  const dirtyFlags: boolean[] = [];
  let frozenFrame = false;
  let disposed = false;

  const attachSkeleton = (sk: T.Skeleton): void => {
    if (disposed || skeletonSet.has(sk)) return;
    const idx = skeletons.length;
    skeletonSet.add(sk);
    skeletons.push(sk);
    dirtyFlags.push(true);
    sk.update = function (this: T.Skeleton) {
      if (frozenFrame && !dirtyFlags[idx] && this.boneTexture !== null) {
        return;
      }
      ORIG_SKELETON_UPDATE.call(this);
      dirtyFlags[idx] = false;
    };
  };

  const registerRoot = (subRoot: T.Object3D): void => {
    if (!subRoot || disposed) return;
    subRoot.traverse((obj) => {
      const sm = obj as T.SkinnedMesh;
      if (sm.isSkinnedMesh && sm.skeleton) {
        attachSkeleton(sm.skeleton);
      }
    });
  };

  registerRoot(root);

  return {
    registerRoot,
    markDirty() {
      frozenFrame = false;
      for (let i = 0; i < dirtyFlags.length; i++) {
        dirtyFlags[i] = true;
      }
    },
    setFrozenThisFrame(frozen: boolean) {
      frozenFrame = frozen;
      if (!frozen) {
        for (let i = 0; i < dirtyFlags.length; i++) {
          dirtyFlags[i] = true;
        }
      }
    },
    dispose() {
      disposed = true;
      for (let i = 0; i < skeletons.length; i++) {
        const sk = skeletons[i];
        if (sk.update !== ORIG_SKELETON_UPDATE) {
          delete (sk as { update?: T.Skeleton['update'] }).update;
        }
      }
      skeletons.length = 0;
      dirtyFlags.length = 0;
      skeletonSet.clear();
    },
  };
}

export interface BlockerCacheEntry {
  mesh: T.Mesh;
  root: T.Object3D;
  box: T.Box3;
  nearDistSq: number;
}

/**
 * Zero-allocation world-AABB broadphase cache for camera obstruction and interaction raycasting.
 * Rebuilds flat mesh entries ONLY when `version` increments, then filters candidates by segment AABB +
 * ray-box intersection before invoking expensive triangle raycasts.
 */
export class BlockerCache {
  private entries: BlockerCacheEntry[] = [];
  private lastVersion = -1;
  private lastRootCount = -1;
  private readonly tmpBox = new T.Box3();
  private readonly tmpHit = new T.Vector3();

  /** Rebuilds cached mesh AABBs only when `version` (or root count) changed. */
  sync(roots: readonly T.Object3D[], version: number): void {
    if (version === this.lastVersion && roots.length === this.lastRootCount) return;
    this.lastVersion = version;
    this.lastRootCount = roots.length;
    this.entries.length = 0;

    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      if (!root) continue;
      root.traverse((obj) => {
        const mesh = obj as T.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        if (!mesh.geometry.boundingBox) {
          mesh.geometry.computeBoundingBox();
        }
        const localBox = mesh.geometry.boundingBox;
        if (!localBox || localBox.isEmpty()) return;
        const worldBox = new T.Box3().copy(localBox).applyMatrix4(mesh.matrixWorld);
        this.entries.push({ mesh, root, box: worldBox, nearDistSq: 0 });
      });
    }
  }

  /** Refreshes a single dynamic root (e.g. a swinging door) without rebuilding the entire cache. */
  refreshRoot(root: T.Object3D): void {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.root !== root) continue;
      const localBox = entry.mesh.geometry.boundingBox;
      if (localBox && !localBox.isEmpty()) {
        entry.box.copy(localBox).applyMatrix4(entry.mesh.matrixWorld);
      }
    }
  }

  /**
   * Populates `out` (zero allocations) with visible meshes whose world AABB intersects the `[origin, target]`
   * segment and ray, sorted front-to-back by ray-box entry distance for early-exit triangle raycasting.
   */
  collectRayCandidates(
    ray: T.Ray,
    origin: T.Vector3,
    target: T.Vector3,
    maxDist: number,
    out: BlockerCacheEntry[],
  ): number {
    out.length = 0;
    const segBox = this.tmpBox.makeEmpty().expandByPoint(origin).expandByPoint(target);
    const maxDistSq = maxDist * maxDist;

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (!entry.root.visible || !entry.mesh.visible) continue;
      if (!entry.box.intersectsBox(segBox)) continue;
      const hit = ray.intersectBox(entry.box, this.tmpHit);
      if (!hit) continue;
      const dSq = origin.distanceToSquared(hit);
      if (dSq > maxDistSq) continue;
      entry.nearDistSq = dSq;
      out.push(entry);
    }

    // Insertion sort (typically 1..12 candidates -> zero comparator/TimSort overhead).
    for (let i = 1; i < out.length; i++) {
      const cur = out[i];
      const curD = cur.nearDistSq;
      let j = i - 1;
      while (j >= 0 && out[j].nearDistSq > curD) {
        out[j + 1] = out[j];
        j--;
      }
      out[j + 1] = cur;
    }

    return out.length;
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
    this.lastVersion = -1;
    this.lastRootCount = -1;
  }
}

export interface DisposeTreeOptions {
  /** Geometries owned by a shared cache that must NOT be disposed. */
  keepGeometries?: ReadonlySet<T.BufferGeometry>;
  /** Materials owned by a shared cache that must NOT be disposed. */
  keepMaterials?: ReadonlySet<T.Material>;
  /** Textures owned by a shared cache that must NOT be disposed. */
  keepTextures?: ReadonlySet<T.Texture>;
  /** If true, even textures/materials tagged `userData.shared === true` are disposed. Default: `false`. */
  disposeShared?: boolean;
  /** If true, detaches all children from `root` after disposal. Default: `false`. */
  clearChildren?: boolean;
}

export interface DisposeTreeStats {
  geometries: number;
  materials: number;
  textures: number;
  instancedMeshes: number;
  skeletons: number;
}

const MATERIAL_TEXTURE_SLOTS = [
  'map',
  'alphaMap',
  'aoMap',
  'bumpMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'displacementMap',
  'emissiveMap',
  'envMap',
  'gradientMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'lightMap',
  'matcap',
  'metalnessMap',
  'normalMap',
  'roughnessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'specularColorMap',
  'specularIntensityMap',
  'thicknessMap',
  'transmissionMap',
] as const;

function collectMaterialTextures(mat: T.Material, out: Set<T.Texture>): void {
  const record = mat as unknown as Record<string, unknown>;
  for (let i = 0; i < MATERIAL_TEXTURE_SLOTS.length; i++) {
    const candidate = record[MATERIAL_TEXTURE_SLOTS[i]];
    if (candidate && (candidate as T.Texture).isTexture) {
      out.add(candidate as T.Texture);
    }
  }
  const uniforms = (mat as T.ShaderMaterial).uniforms;
  if (uniforms) {
    for (const key in uniforms) {
      const val = uniforms[key]?.value;
      if (val && (val as T.Texture).isTexture) {
        out.add(val as T.Texture);
      }
    }
  }
}

/**
 * Deeply disposes all unique geometries, materials, unshared textures, `InstancedMesh` GPU buffers, and
 * `SkinnedMesh` bone textures inside `root`.
 *
 * Honors `userData.shared === true` (on geometries, materials, or textures) as well as explicit `keep*` sets
 * so cached global PBR atlases and shared material libraries remain intact with zero double-dispose errors.
 */
export function disposeObjectTree(root: T.Object3D, opts: DisposeTreeOptions = {}): DisposeTreeStats {
  const geometries = new Set<T.BufferGeometry>();
  const materials = new Set<T.Material>();
  const textures = new Set<T.Texture>();
  const instanced = new Set<T.InstancedMesh>();
  const skeletons = new Set<T.Skeleton>();

  const disposeShared = opts.disposeShared === true;

  root.traverse((obj) => {
    const mesh = obj as T.Mesh;
    if (mesh.geometry && (mesh.geometry as T.BufferGeometry).isBufferGeometry) {
      geometries.add(mesh.geometry);
    }

    const mat = mesh.material;
    if (Array.isArray(mat)) {
      for (let i = 0; i < mat.length; i++) {
        if (mat[i]) materials.add(mat[i]);
      }
    } else if (mat) {
      materials.add(mat);
    }

    if ((obj as T.InstancedMesh).isInstancedMesh) {
      instanced.add(obj as T.InstancedMesh);
    }

    const skinned = obj as T.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.skeleton) {
      skeletons.add(skinned.skeleton);
    }
  });

  const stats: DisposeTreeStats = {
    geometries: 0,
    materials: 0,
    textures: 0,
    instancedMeshes: 0,
    skeletons: 0,
  };

  for (const m of materials) {
    if (!disposeShared && m.userData?.shared === true) continue;
    if (opts.keepMaterials?.has(m)) continue;
    collectMaterialTextures(m, textures);
    m.dispose();
    stats.materials++;
  }

  for (const tex of textures) {
    if (!disposeShared && tex.userData?.shared === true) continue;
    if (opts.keepTextures?.has(tex)) continue;
    tex.dispose();
    stats.textures++;
  }

  for (const geo of geometries) {
    if (!disposeShared && geo.userData?.shared === true) continue;
    if (opts.keepGeometries?.has(geo)) continue;
    geo.dispose();
    stats.geometries++;
  }

  for (const im of instanced) {
    im.dispose();
    stats.instancedMeshes++;
  }

  for (const sk of skeletons) {
    sk.dispose();
    stats.skeletons++;
  }

  if (opts.clearChildren) {
    root.clear();
  }

  return stats;
}
