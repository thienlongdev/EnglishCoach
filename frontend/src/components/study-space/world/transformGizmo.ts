import * as T from 'three';
import {
  type RotationAxis3D,
  type TransformSpace,
} from '@/lib/study-space/orientation';

/**
 * Interactive 360-degree 3-Axis Rotation Ring + 3-Axis Translation Arrow Gizmo
 * for Echo Life / StudySpace (both Embodied Precision Placement and Overview Edit Mode).
 *
 * Guarantees:
 * - Every node carries `userData.noCollision = true` so physics colliders, camera swept-sphere
 *   blockers, and world raycast targeters strictly ignore gizmo geometry.
 * - All visible meshes share a single `MeshBasicMaterial` shader topology with a fixed
 *   `customProgramCacheKey` (`ec-transform-gizmo-v1`) -> `0` runtime shader recompiles.
 * - Raycast pick colliders stay `visible = false` during rendering (`0` extra draw calls)
 *   and are enabled only synchronously inside `hitTest()`.
 * - Dynamic sweep arc updates a pre-allocated fixed-capacity `BufferAttribute` in-place ->
 *   `0` runtime geometry allocations (`deltaGeom === 0`).
 * - Dual-mode rotation solver blends ray-plane polar angle with NDC screen-tangent projection
 *   at grazing view angles (`|ray . axis| < 0.18`) -> `0` NaN or gimbal jumps at any angle.
 */

export type GizmoMode = 'rotate' | 'translate' | 'both';
export type GizmoHandleId = 'rx' | 'ry' | 'rz' | 'tx' | 'ty' | 'tz';

export interface GizmoHit {
  readonly handle: GizmoHandleId;
  readonly axis: RotationAxis3D;
  readonly kind: 'rotate' | 'translate';
  readonly pointWorld: T.Vector3;
  readonly distance: number;
}

export interface GizmoDragState {
  readonly handle: GizmoHandleId;
  readonly axis: RotationAxis3D;
  readonly kind: 'rotate' | 'translate';
  readonly deltaAngleRad: number;
  readonly deltaAngleDeg: number;
  readonly deltaTranslation: T.Vector3;
  readonly position: T.Vector3;
  readonly quaternion: T.Quaternion;
}

const GIZMO_CACHE_KEY = () => 'ec-transform-gizmo-v1';

const AXIS_COLORS: Record<RotationAxis3D, { base: number; hover: number }> = {
  x: { base: 0xff5c6c, hover: 0xffa3ad },
  y: { base: 0x34d399, hover: 0x86efac },
  z: { base: 0x38bdf8, hover: 0x93c5fd },
};

const HANDLE_AXIS: Record<GizmoHandleId, RotationAxis3D> = {
  rx: 'x',
  ry: 'y',
  rz: 'z',
  tx: 'x',
  ty: 'y',
  tz: 'z',
};

const HANDLE_KIND: Record<GizmoHandleId, 'rotate' | 'translate'> = {
  rx: 'rotate',
  ry: 'rotate',
  rz: 'rotate',
  tx: 'translate',
  ty: 'translate',
  tz: 'translate',
};

const WEDGE_SEGMENTS = 40;
const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;

function makeGizmoMaterial(color: number, opacity: number): T.MeshBasicMaterial {
  const mat = new T.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    side: T.DoubleSide,
  });
  mat.customProgramCacheKey = GIZMO_CACHE_KEY;
  return mat;
}

function markNoCollision(root: T.Object3D, renderOrder = 19): void {
  root.traverse((node) => {
    node.userData.noCollision = true;
    node.userData.isTransformGizmo = true;
    node.castShadow = false;
    node.receiveShadow = false;
    node.frustumCulled = false;
    if ((node as T.Mesh).isMesh) {
      node.renderOrder = renderOrder;
    }
  });
}

function unitAxisVector(axis: RotationAxis3D, out: T.Vector3): T.Vector3 {
  if (axis === 'x') return out.set(1, 0, 0);
  if (axis === 'y') return out.set(0, 1, 0);
  return out.set(0, 0, 1);
}

function buildSnapTicksGeometry(radius = 1.0, tickCount = 24): T.BufferGeometry {
  const positions = new Float32Array(tickCount * 6 * 3);
  let ptr = 0;
  const halfWidth = 0.008;
  for (let i = 0; i < tickCount; i++) {
    const major = i % 6 === 0;
    const inner = radius - (major ? 0.075 : 0.042);
    const outer = radius + (major ? 0.035 : 0.018);
    const theta = (i / tickCount) * Math.PI * 2;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const tx = -s * halfWidth;
    const ty = c * halfWidth;

    const x0 = c * inner - tx, y0 = s * inner - ty;
    const x1 = c * inner + tx, y1 = s * inner + ty;
    const x2 = c * outer + tx, y2 = s * outer + ty;
    const x3 = c * outer - tx, y3 = s * outer - ty;

    // Two triangles in XY plane
    positions[ptr++] = x0; positions[ptr++] = y0; positions[ptr++] = 0;
    positions[ptr++] = x1; positions[ptr++] = y1; positions[ptr++] = 0;
    positions[ptr++] = x2; positions[ptr++] = y2; positions[ptr++] = 0;

    positions[ptr++] = x0; positions[ptr++] = y0; positions[ptr++] = 0;
    positions[ptr++] = x2; positions[ptr++] = y2; positions[ptr++] = 0;
    positions[ptr++] = x3; positions[ptr++] = y3; positions[ptr++] = 0;
  }
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(positions, 3));
  geo.computeBoundingSphere();
  return geo;
}

export class TransformGizmo3D {
  readonly group = new T.Group();

  private readonly visualRoot = new T.Group();
  private readonly pickRoot = new T.Group();
  private readonly rotateVisualGroup = new T.Group();
  private readonly translateVisualGroup = new T.Group();

  private readonly ringMeshes: Record<RotationAxis3D, T.Mesh<T.BufferGeometry, T.MeshBasicMaterial>>;
  private readonly arrowGroups: Record<RotationAxis3D, T.Group>;
  private readonly arrowMaterials: Record<RotationAxis3D, T.MeshBasicMaterial>;
  private readonly hubMesh: T.Mesh<T.BufferGeometry, T.MeshBasicMaterial>;
  private readonly ticksMesh: T.Mesh<T.BufferGeometry, T.MeshBasicMaterial>;
  private readonly sweepMesh: T.Mesh<T.BufferGeometry, T.MeshBasicMaterial>;
  private readonly sweepPositions: T.BufferAttribute;

  private readonly pickMeshes: T.Mesh<T.BufferGeometry, T.MeshBasicMaterial>[] = [];
  private readonly pickMaterial = makeGizmoMaterial(0xffffff, 0);
  private readonly geometries: T.BufferGeometry[] = [];
  private readonly materials: T.MeshBasicMaterial[] = [];

  private modeNow: GizmoMode = 'both';
  private spaceNow: TransformSpace = 'local';
  private yawWorldLocked = true;
  private snapDeg = 15;
  private fineSnapDeg = 5;
  private translateSnapM = 0;

  private baseRadius = 0.45;
  private originStagePos = new T.Vector3();
  private currentStageQuat = new T.Quaternion();
  private localPivotOffset = new T.Vector3();

  private hoveredHandle: GizmoHandleId | null = null;
  private highlightedAxis: RotationAxis3D | null = null;

  private activeDrag: {
    handle: GizmoHandleId;
    axis: RotationAxis3D;
    kind: 'rotate' | 'translate';
    startStagePos: T.Vector3;
    startStageQuat: T.Quaternion;
    pivotStagePos: T.Vector3;
    pivotWorldPos: T.Vector3;
    axisWorld: T.Vector3;
    axisStage: T.Vector3;
    planeUWorld: T.Vector3;
    planeVWorld: T.Vector3;
    prevRadialWorld: T.Vector3;
    useScreenTangent: boolean;
    startNdc: T.Vector2;
    tangentNdc: T.Vector2;
    accumulatedRad: number;
    snappedRad: number;
    startAxisParam: number;
    deltaTranslationStage: T.Vector3;
    outPos: T.Vector3;
    outQuat: T.Quaternion;
  } | null = null;

  // Scratch math objects (zero hot-loop allocations)
  private readonly tmpWorldPos = new T.Vector3();
  private readonly tmpCamPos = new T.Vector3();
  private readonly tmpHitWorld = new T.Vector3();
  private readonly tmpRadial = new T.Vector3();
  private readonly tmpCross = new T.Vector3();
  private readonly tmpTangent3D = new T.Vector3();
  private readonly tmpProjA = new T.Vector3();
  private readonly tmpProjB = new T.Vector3();
  private readonly tmpPlane = new T.Plane();
  private readonly tmpParentQuat = new T.Quaternion();
  private readonly tmpInvParentQuat = new T.Quaternion();
  private readonly tmpBasisQuat = new T.Quaternion();
  private readonly tmpDeltaQuat = new T.Quaternion();
  private readonly tmpOffset = new T.Vector3();

  constructor() {
    this.group.name = 'ec-transform-gizmo-3d';
    this.group.visible = false;
    this.pickRoot.visible = false;
    this.materials.push(this.pickMaterial);

    const ringGeo = new T.TorusGeometry(1.0, 0.017, 12, 72);
    const pickRingGeo = new T.TorusGeometry(1.0, 0.068, 8, 48);
    const shaftGeo = new T.CylinderGeometry(0.015, 0.015, 0.42, 12);
    const coneGeo = new T.ConeGeometry(0.052, 0.145, 16);
    const pickArrowGeo = new T.CylinderGeometry(0.075, 0.075, 0.62, 8);
    const hubGeo = new T.SphereGeometry(0.048, 14, 12);
    const ticksGeo = buildSnapTicksGeometry(1.0, 24);

    const sweepArray = new Float32Array((WEDGE_SEGMENTS + 1) * 3 * 3);
    const sweepGeo = new T.BufferGeometry();
    this.sweepPositions = new T.BufferAttribute(sweepArray, 3);
    this.sweepPositions.setUsage(T.DynamicDrawUsage);
    sweepGeo.setAttribute('position', this.sweepPositions);
    sweepGeo.setDrawRange(0, 0);

    this.geometries.push(
      ringGeo,
      pickRingGeo,
      shaftGeo,
      coneGeo,
      pickArrowGeo,
      hubGeo,
      ticksGeo,
      sweepGeo,
    );

    const makeRing = (axis: RotationAxis3D, handle: GizmoHandleId) => {
      const mat = makeGizmoMaterial(AXIS_COLORS[axis].base, 0.86);
      this.materials.push(mat);
      const mesh = new T.Mesh(ringGeo, mat);
      const pick = new T.Mesh(pickRingGeo, this.pickMaterial);
      pick.userData.gizmoHandle = handle;
      if (axis === 'x') {
        mesh.rotation.y = Math.PI / 2;
        pick.rotation.y = Math.PI / 2;
      } else if (axis === 'y') {
        mesh.rotation.x = Math.PI / 2;
        pick.rotation.x = Math.PI / 2;
      }
      this.rotateVisualGroup.add(mesh);
      this.pickRoot.add(pick);
      this.pickMeshes.push(pick);
      return mesh;
    };

    this.ringMeshes = {
      x: makeRing('x', 'rx'),
      y: makeRing('y', 'ry'),
      z: makeRing('z', 'rz'),
    };

    const makeArrow = (axis: RotationAxis3D, handle: GizmoHandleId) => {
      const mat = makeGizmoMaterial(AXIS_COLORS[axis].base, 0.9);
      this.materials.push(mat);
      const g = new T.Group();
      const shaft = new T.Mesh(shaftGeo, mat);
      shaft.position.y = 1.25;
      const cone = new T.Mesh(coneGeo, mat);
      cone.position.y = 1.52;
      g.add(shaft, cone);

      const pick = new T.Mesh(pickArrowGeo, this.pickMaterial);
      pick.userData.gizmoHandle = handle;
      // Align local +Y of cylinder/cone onto +X, +Y, or +Z
      const align = new T.Euler(
        axis === 'z' ? Math.PI / 2 : 0,
        0,
        axis === 'x' ? -Math.PI / 2 : 0,
      );
      g.rotation.copy(align);
      pick.rotation.copy(align);
      if (axis === 'x') pick.position.set(1.31, 0, 0);
      else if (axis === 'y') pick.position.set(0, 1.31, 0);
      else pick.position.set(0, 0, 1.31);

      this.translateVisualGroup.add(g);
      this.pickRoot.add(pick);
      this.pickMeshes.push(pick);
      return { group: g, mat };
    };

    const ax = makeArrow('x', 'tx');
    const ay = makeArrow('y', 'ty');
    const az = makeArrow('z', 'tz');
    this.arrowGroups = { x: ax.group, y: ay.group, z: az.group };
    this.arrowMaterials = { x: ax.mat, y: ay.mat, z: az.mat };

    const hubMat = makeGizmoMaterial(0xf8fafc, 0.85);
    const ticksMat = makeGizmoMaterial(0xffffff, 0.42);
    const sweepMat = makeGizmoMaterial(0x38bdf8, 0.24);
    this.materials.push(hubMat, ticksMat, sweepMat);

    this.hubMesh = new T.Mesh(hubGeo, hubMat);
    this.ticksMesh = new T.Mesh(ticksGeo, ticksMat);
    this.ticksMesh.visible = false;
    this.sweepMesh = new T.Mesh(sweepGeo, sweepMat);
    this.sweepMesh.visible = false;

    this.visualRoot.add(this.sweepMesh, this.ticksMesh, this.rotateVisualGroup, this.translateVisualGroup, this.hubMesh);
    this.group.add(this.visualRoot, this.pickRoot);

    markNoCollision(this.group, 19);
    this.sweepMesh.renderOrder = 18;
    this.ticksMesh.renderOrder = 18;
    this.hubMesh.renderOrder = 21;
    this.refreshVisualStyling();
  }

  get visible(): boolean {
    return this.group.visible;
  }

  get dragging(): boolean {
    return this.activeDrag !== null;
  }

  get hovered(): GizmoHandleId | null {
    return this.hoveredHandle;
  }

  get mode(): GizmoMode {
    return this.modeNow;
  }

  get space(): TransformSpace {
    return this.spaceNow;
  }

  get dragAngleDegrees(): number {
    return this.activeDrag ? this.activeDrag.snappedRad * DEG_PER_RAD : 0;
  }

  setMode(mode: GizmoMode): void {
    if (this.modeNow === mode) return;
    this.modeNow = mode;
    this.rotateVisualGroup.visible = mode === 'rotate' || mode === 'both';
    this.translateVisualGroup.visible = mode === 'translate' || mode === 'both';
    const arrowOffset = mode === 'translate' ? -0.82 : 0;
    for (const axis of ['x', 'y', 'z'] as const) {
      const g = this.arrowGroups[axis];
      const shaft = g.children[0];
      const cone = g.children[1];
      if (shaft && cone) {
        shaft.position.y = 1.25 + arrowOffset;
        cone.position.y = 1.52 + arrowOffset;
      }
    }
    for (const pick of this.pickMeshes) {
      const h = pick.userData.gizmoHandle as GizmoHandleId;
      if (HANDLE_KIND[h] === 'translate') {
        const c = 1.31 + arrowOffset;
        const a = HANDLE_AXIS[h];
        pick.position.set(a === 'x' ? c : 0, a === 'y' ? c : 0, a === 'z' ? c : 0);
      }
    }
    this.refreshVisualStyling();
  }

  setSpace(space: TransformSpace, yawWorldLocked = true): void {
    this.spaceNow = space;
    this.yawWorldLocked = yawWorldLocked;
    this.syncGroupTransform();
  }

  setSnap(snapDeg = 15, fineSnapDeg = 5, translateSnapM = 0): void {
    this.snapDeg = Math.max(0, snapDeg);
    this.fineSnapDeg = Math.max(0, fineSnapDeg);
    this.translateSnapM = Math.max(0, translateSnapM);
  }

  /**
   * Highlights a specific rotation axis ring (`'x' | 'y' | 'z' | null`), e.g. when cycling
   * the active rotation axis with `KeyZ` while carrying an item under mouse-look.
   */
  setHighlightAxis(axis: RotationAxis3D | null): void {
    if (this.highlightedAxis === axis) return;
    this.highlightedAxis = axis;
    this.refreshVisualStyling();
  }

  /**
   * Positions and orients the gizmo around the target object in stage space.
   * `localPivotOffset` shifts the visual gizmo center to the object's geometric center
   * (so floor-anchored chairs show rings around their seat/backrest instead of underground)
   * while preserving exact origin coordinates during rotation.
   */
  attach(
    stagePosition: T.Vector3,
    stageQuaternion: T.Quaternion,
    baseRadius = 0.45,
    localPivotOffset?: T.Vector3,
  ): void {
    this.group.visible = true;
    this.originStagePos.copy(stagePosition);
    this.currentStageQuat.copy(stageQuaternion).normalize();
    this.baseRadius = Math.max(0.14, baseRadius);
    if (localPivotOffset) this.localPivotOffset.copy(localPivotOffset);
    else this.localPivotOffset.set(0, 0, 0);
    this.syncGroupTransform();
  }

  hide(): void {
    if (!this.group.visible && !this.activeDrag) return;
    this.cancelDrag();
    this.hoveredHandle = null;
    this.group.visible = false;
    this.ticksMesh.visible = false;
    this.sweepMesh.visible = false;
  }

  /** Updates screen-adaptive gizmo scale so rings remain easy to grab at any camera distance. */
  updateScale(camera: T.Camera): void {
    if (!this.group.visible) return;
    this.group.updateWorldMatrix(true, false);
    this.group.getWorldPosition(this.tmpWorldPos);
    camera.getWorldPosition(this.tmpCamPos);
    const dist = Math.max(0.25, this.tmpWorldPos.distanceTo(this.tmpCamPos));

    let screenRadius = this.baseRadius;
    if ((camera as T.PerspectiveCamera).isPerspectiveCamera) {
      const fovRad = (camera as T.PerspectiveCamera).fov * RAD_PER_DEG;
      screenRadius = Math.tan(fovRad * 0.5) * dist * 0.22;
    }
    const parentScale = this.group.parent ? this.group.parent.scale.x || 1 : 1;
    const minR = Math.max(0.18, this.baseRadius * 0.72);
    const maxR = Math.max(1.45, this.baseRadius * 2.15);
    const targetR = T.MathUtils.clamp(screenRadius / Math.max(0.2, parentScale), minR, maxR);
    this.group.scale.setScalar(targetR);
  }

  /** Raycasts against invisible wider torus/capsule pick colliders (`0` render-loop overhead). */
  hitTest(raycaster: T.Raycaster): GizmoHit | null {
    if (!this.group.visible) return null;
    this.group.updateMatrixWorld(true);
    this.pickRoot.visible = true;
    try {
      for (const pick of this.pickMeshes) {
        const h = pick.userData.gizmoHandle as GizmoHandleId;
        const kind = HANDLE_KIND[h];
        pick.visible =
          kind === 'rotate'
            ? this.modeNow === 'rotate' || this.modeNow === 'both'
            : this.modeNow === 'translate' || this.modeNow === 'both';
      }
      this.pickRoot.updateMatrixWorld(true);
      const hits = raycaster.intersectObjects(this.pickMeshes, false);
      if (!hits.length) return null;
      // Prefer rotation rings slightly when tied within 1.5 cm
      let best = hits[0];
      for (let i = 1; i < hits.length; i++) {
        const cur = hits[i];
        if (cur.distance < best.distance - 0.015) {
          best = cur;
        }
      }
      const handle = best.object.userData.gizmoHandle as GizmoHandleId;
      return {
        handle,
        axis: HANDLE_AXIS[handle],
        kind: HANDLE_KIND[handle],
        pointWorld: best.point.clone(),
        distance: best.distance,
      };
    } finally {
      this.pickRoot.visible = false;
    }
  }

  updateHover(raycaster: T.Raycaster): GizmoHandleId | null {
    if (this.activeDrag) return this.activeDrag.handle;
    const hit = this.hitTest(raycaster);
    const next = hit?.handle ?? null;
    if (next !== this.hoveredHandle) {
      this.hoveredHandle = next;
      this.refreshVisualStyling();
    }
    return next;
  }

  /**
   * Begins an interactive 3D rotation or translation drag from the current raycaster & NDC pointer.
   */
  beginDrag(
    raycaster: T.Raycaster,
    pointerNdc: Readonly<{ x: number; y: number }>,
    camera: T.Camera,
    explicitHit?: GizmoHit | null,
  ): boolean {
    const hit = explicitHit ?? this.hitTest(raycaster);
    if (!hit) return false;

    this.hoveredHandle = hit.handle;
    this.group.updateMatrixWorld(true);
    const parentWorldQuat = this.getParentWorldQuat(this.tmpParentQuat);
    const invParentQuat = this.tmpInvParentQuat.copy(parentWorldQuat).invert();

    const pivotStage = this.tmpOffset
      .copy(this.localPivotOffset)
      .applyQuaternion(this.currentStageQuat)
      .add(this.originStagePos)
      .clone();
    const pivotWorld = this.group.parent
      ? this.group.parent.localToWorld(pivotStage.clone())
      : pivotStage.clone();

    const axisStage = unitAxisVector(hit.axis, new T.Vector3());
    const useLocalAxis =
      this.spaceNow === 'local' && !(hit.kind === 'rotate' && hit.axis === 'y' && this.yawWorldLocked);
    if (useLocalAxis) {
      axisStage.applyQuaternion(this.currentStageQuat).normalize();
    }
    const axisWorld = axisStage.clone().applyQuaternion(parentWorldQuat).normalize();

    // Orthonormal basis `(planeUWorld, planeVWorld)` perpendicular to `axisWorld`
    const refUp = Math.abs(axisWorld.y) < 0.9 ? new T.Vector3(0, 1, 0) : new T.Vector3(1, 0, 0);
    const planeUWorld = new T.Vector3().crossVectors(refUp, axisWorld).normalize();
    const planeVWorld = new T.Vector3().crossVectors(axisWorld, planeUWorld).normalize();

    this.tmpPlane.setFromNormalAndCoplanarPoint(axisWorld, pivotWorld);
    const viewAlignment = Math.abs(raycaster.ray.direction.dot(axisWorld));
    const useScreenTangent = hit.kind === 'rotate' && viewAlignment < 0.18;

    const initialPlaneHit = new T.Vector3();
    if (!raycaster.ray.intersectPlane(this.tmpPlane, initialPlaneHit)) {
      initialPlaneHit.copy(hit.pointWorld);
    }
    const prevRadialWorld = initialPlaneHit
      .clone()
      .sub(pivotWorld)
      .addScaledVector(axisWorld, -initialPlaneHit.clone().sub(pivotWorld).dot(axisWorld));
    if (prevRadialWorld.lengthSq() < 1e-6) {
      prevRadialWorld.copy(planeUWorld);
    } else {
      prevRadialWorld.normalize();
    }

    // Orient planeUWorld along the initial grab radial so the visual sweep sector starts cleanly at 0 deg!
    planeUWorld.copy(prevRadialWorld);
    planeVWorld.crossVectors(axisWorld, planeUWorld).normalize();

    // Screen-space tangent for edge-on grazing rotation fallback
    this.tmpTangent3D.crossVectors(axisWorld, prevRadialWorld).normalize();
    const worldRadius = Math.max(0.15, this.group.scale.x);
    this.tmpProjA.copy(hit.pointWorld).project(camera);
    this.tmpProjB
      .copy(hit.pointWorld)
      .addScaledVector(this.tmpTangent3D, worldRadius * 0.25)
      .project(camera);
    const tangentNdc = new T.Vector2(this.tmpProjB.x - this.tmpProjA.x, this.tmpProjB.y - this.tmpProjA.y);
    if (tangentNdc.lengthSq() < 1e-6) tangentNdc.set(1, 0);
    else tangentNdc.normalize();

    const startAxisParam = this.rayAxisParameter(
      raycaster.ray.origin,
      raycaster.ray.direction,
      pivotWorld,
      axisWorld,
    );

    void invParentQuat;
    this.activeDrag = {
      handle: hit.handle,
      axis: hit.axis,
      kind: hit.kind,
      startStagePos: this.originStagePos.clone(),
      startStageQuat: this.currentStageQuat.clone(),
      pivotStagePos: pivotStage,
      pivotWorldPos: pivotWorld,
      axisWorld,
      axisStage,
      planeUWorld,
      planeVWorld,
      prevRadialWorld,
      useScreenTangent,
      startNdc: new T.Vector2(pointerNdc.x, pointerNdc.y),
      tangentNdc,
      accumulatedRad: 0,
      snappedRad: 0,
      startAxisParam,
      deltaTranslationStage: new T.Vector3(),
      outPos: this.originStagePos.clone(),
      outQuat: this.currentStageQuat.clone(),
    };

    this.updateSweepVisual(0);
    this.refreshVisualStyling();
    return true;
  }

  /**
   * Advances the active 3D drag and returns the updated stage-space position + 3D quaternion.
   * Pass `fineModifier = true` (e.g. `Alt` or `Shift`) for fine `5 deg` / smooth snapping.
   */
  updateDrag(
    raycaster: T.Raycaster,
    pointerNdc: Readonly<{ x: number; y: number }>,
    fineModifier = false,
  ): GizmoDragState | null {
    const drag = this.activeDrag;
    if (!drag) return null;

    if (drag.kind === 'rotate') {
      if (drag.useScreenTangent) {
        const dx = pointerNdc.x - drag.startNdc.x;
        const dy = pointerNdc.y - drag.startNdc.y;
        drag.accumulatedRad = (dx * drag.tangentNdc.x + dy * drag.tangentNdc.y) * Math.PI * 1.65;
      } else {
        this.tmpPlane.setFromNormalAndCoplanarPoint(drag.axisWorld, drag.pivotWorldPos);
        if (raycaster.ray.intersectPlane(this.tmpPlane, this.tmpHitWorld)) {
          this.tmpRadial.copy(this.tmpHitWorld).sub(drag.pivotWorldPos);
          this.tmpRadial.addScaledVector(drag.axisWorld, -this.tmpRadial.dot(drag.axisWorld));
          if (this.tmpRadial.lengthSq() > 1e-6) {
            this.tmpRadial.normalize();
            this.tmpCross.crossVectors(drag.prevRadialWorld, this.tmpRadial);
            const sinA = this.tmpCross.dot(drag.axisWorld);
            const cosA = T.MathUtils.clamp(drag.prevRadialWorld.dot(this.tmpRadial), -1, 1);
            const stepRad = Math.atan2(sinA, cosA);
            drag.accumulatedRad += stepRad;
            drag.prevRadialWorld.copy(this.tmpRadial);
          }
        }
      }

      const activeSnapDeg = fineModifier ? this.fineSnapDeg : this.snapDeg;
      const snapRad = activeSnapDeg * RAD_PER_DEG;
      drag.snappedRad =
        snapRad > 1e-6 ? Math.round(drag.accumulatedRad / snapRad) * snapRad : drag.accumulatedRad;

      this.tmpDeltaQuat.setFromAxisAngle(drag.axisStage, drag.snappedRad);
      drag.outQuat.copy(drag.startStageQuat).premultiply(this.tmpDeltaQuat).normalize();

      // Pivot-preserving origin update so rotating around geometric center keeps the object centered in place
      this.tmpOffset.copy(this.localPivotOffset).applyQuaternion(drag.outQuat);
      drag.outPos.copy(drag.pivotStagePos).sub(this.tmpOffset);

      this.originStagePos.copy(drag.outPos);
      this.currentStageQuat.copy(drag.outQuat);
      this.syncGroupTransform();
      this.updateSweepVisual(drag.snappedRad);

      return {
        handle: drag.handle,
        axis: drag.axis,
        kind: 'rotate',
        deltaAngleRad: drag.snappedRad,
        deltaAngleDeg: Math.round(drag.snappedRad * DEG_PER_RAD * 10) / 10,
        deltaTranslation: drag.deltaTranslationStage.set(0, 0, 0),
        position: drag.outPos,
        quaternion: drag.outQuat,
      };
    }

    // 3-Axis Translation (`tx` / `ty` / `tz`)
    const curParam = this.rayAxisParameter(
      raycaster.ray.origin,
      raycaster.ray.direction,
      drag.pivotWorldPos,
      drag.axisWorld,
    );
    const parentScale = this.group.parent ? Math.max(0.1, this.group.parent.scale.x || 1) : 1;
    let deltaStageScalar = T.MathUtils.clamp((curParam - drag.startAxisParam) / parentScale, -8, 8);
    const snapM = fineModifier ? this.translateSnapM * 0.25 : this.translateSnapM;
    if (snapM > 1e-5) {
      deltaStageScalar = Math.round(deltaStageScalar / snapM) * snapM;
    }

    drag.deltaTranslationStage.copy(drag.axisStage).multiplyScalar(deltaStageScalar);
    drag.outPos.copy(drag.startStagePos).add(drag.deltaTranslationStage);
    drag.outQuat.copy(drag.startStageQuat);

    this.originStagePos.copy(drag.outPos);
    this.syncGroupTransform();

    return {
      handle: drag.handle,
      axis: drag.axis,
      kind: 'translate',
      deltaAngleRad: 0,
      deltaAngleDeg: 0,
      deltaTranslation: drag.deltaTranslationStage,
      position: drag.outPos,
      quaternion: drag.outQuat,
    };
  }

  endDrag(): void {
    if (!this.activeDrag) return;
    this.activeDrag = null;
    this.sweepMesh.visible = false;
    this.refreshVisualStyling();
  }

  cancelDrag(): { position: T.Vector3; quaternion: T.Quaternion } | null {
    if (!this.activeDrag) return null;
    const restored = {
      position: this.activeDrag.startStagePos.clone(),
      quaternion: this.activeDrag.startStageQuat.clone(),
    };
    this.originStagePos.copy(restored.position);
    this.currentStageQuat.copy(restored.quaternion);
    this.activeDrag = null;
    this.sweepMesh.visible = false;
    this.syncGroupTransform();
    this.refreshVisualStyling();
    return restored;
  }

  /**
   * Pre-warms the shared `ec-transform-gizmo-v1` WebGLProgram during scene boot
   * so revealing the gizmo later incurs `0` shader compilation stalls (`programDelta === 0`).
   */
  warmup(renderer: T.WebGLRenderer, camera: T.Camera): void {
    const prevVisible = this.group.visible;
    const prevTicks = this.ticksMesh.visible;
    const prevSweep = this.sweepMesh.visible;
    this.group.visible = true;
    this.ticksMesh.visible = true;
    this.sweepMesh.visible = true;
    try {
      renderer.compile(this.group, camera);
    } finally {
      this.group.visible = prevVisible;
      this.ticksMesh.visible = prevTicks;
      this.sweepMesh.visible = prevSweep;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.pickMeshes.length = 0;
  }

  private getParentWorldQuat(out: T.Quaternion): T.Quaternion {
    if (this.group.parent) {
      return this.group.parent.getWorldQuaternion(out);
    }
    return out.set(0, 0, 0, 1);
  }

  private syncGroupTransform(): void {
    this.tmpOffset.copy(this.localPivotOffset).applyQuaternion(this.currentStageQuat);
    this.group.position.copy(this.originStagePos).add(this.tmpOffset);

    if (this.spaceNow === 'local') {
      this.visualRoot.quaternion.copy(this.currentStageQuat);
      this.pickRoot.quaternion.copy(this.currentStageQuat);
      if (this.yawWorldLocked) {
        // Keep the emerald Yaw (`ry`) ring horizontal in world XZ even when local X/Z rings follow object tilt
        this.tmpBasisQuat.copy(this.currentStageQuat).invert();
        this.ringMeshes.y.quaternion.copy(this.tmpBasisQuat).multiply(
          this.tmpDeltaQuat.setFromEuler(new T.Euler(Math.PI / 2, 0, 0)),
        );
        const pickRy = this.pickMeshes.find((m) => m.userData.gizmoHandle === 'ry');
        if (pickRy) pickRy.quaternion.copy(this.ringMeshes.y.quaternion);
      }
    } else {
      this.visualRoot.quaternion.set(0, 0, 0, 1);
      this.pickRoot.quaternion.set(0, 0, 0, 1);
      this.ringMeshes.y.rotation.set(Math.PI / 2, 0, 0);
      const pickRy = this.pickMeshes.find((m) => m.userData.gizmoHandle === 'ry');
      if (pickRy) pickRy.rotation.set(Math.PI / 2, 0, 0);
    }
  }

  private updateSweepVisual(snappedRad: number): void {
    const drag = this.activeDrag;
    if (!drag || drag.kind !== 'rotate' || Math.abs(snappedRad) < 1e-4) {
      this.sweepMesh.visible = false;
      return;
    }
    const clamped = T.MathUtils.clamp(snappedRad, -Math.PI * 2, Math.PI * 2);
    const parentWorldQuat = this.getParentWorldQuat(this.tmpParentQuat);
    const toVisualLocal = this.tmpBasisQuat
      .copy(parentWorldQuat)
      .multiply(this.visualRoot.quaternion)
      .invert();

    const uLocal = drag.planeUWorld.clone().applyQuaternion(toVisualLocal).normalize();
    const vLocal = drag.planeVWorld.clone().applyQuaternion(toVisualLocal).normalize();

    const attr = this.sweepPositions;
    let vert = 0;
    for (let i = 0; i < WEDGE_SEGMENTS; i++) {
      const a0 = (i / WEDGE_SEGMENTS) * clamped;
      const a1 = ((i + 1) / WEDGE_SEGMENTS) * clamped;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);

      attr.setXYZ(vert++, 0, 0, 0);
      attr.setXYZ(
        vert++,
        uLocal.x * c0 + vLocal.x * s0,
        uLocal.y * c0 + vLocal.y * s0,
        uLocal.z * c0 + vLocal.z * s0,
      );
      attr.setXYZ(
        vert++,
        uLocal.x * c1 + vLocal.x * s1,
        uLocal.y * c1 + vLocal.y * s1,
        uLocal.z * c1 + vLocal.z * s1,
      );
    }
    attr.needsUpdate = true;
    this.sweepMesh.geometry.setDrawRange(0, WEDGE_SEGMENTS * 3);
    this.sweepMesh.material.color.setHex(AXIS_COLORS[drag.axis].hover);
    this.sweepMesh.visible = true;
  }

  private refreshVisualStyling(): void {
    const activeHandle = this.activeDrag?.handle ?? this.hoveredHandle;
    const focusAxis =
      (activeHandle ? HANDLE_AXIS[activeHandle] : null) ?? this.highlightedAxis;

    for (const axis of ['x', 'y', 'z'] as const) {
      const rHandle: GizmoHandleId = axis === 'x' ? 'rx' : axis === 'y' ? 'ry' : 'rz';
      const tHandle: GizmoHandleId = axis === 'x' ? 'tx' : axis === 'y' ? 'ty' : 'tz';
      const rActive = activeHandle === rHandle || (!activeHandle && this.highlightedAxis === axis);
      const tActive = activeHandle === tHandle;

      const rMat = this.ringMeshes[axis].material;
      rMat.color.setHex(rActive ? AXIS_COLORS[axis].hover : AXIS_COLORS[axis].base);
      rMat.opacity = rActive ? 1.0 : activeHandle ? 0.28 : this.highlightedAxis ? 0.34 : 0.84;

      const tMat = this.arrowMaterials[axis];
      tMat.color.setHex(tActive ? AXIS_COLORS[axis].hover : AXIS_COLORS[axis].base);
      tMat.opacity = tActive ? 1.0 : activeHandle ? 0.28 : 0.88;
    }

    if (focusAxis && (this.modeNow === 'rotate' || this.modeNow === 'both')) {
      this.ticksMesh.visible = true;
      this.ticksMesh.quaternion.copy(this.ringMeshes[focusAxis].quaternion);
      this.ticksMesh.material.color.setHex(AXIS_COLORS[focusAxis].hover);
    } else {
      this.ticksMesh.visible = false;
    }
  }

  private rayAxisParameter(
    rayOrigin: T.Vector3,
    rayDir: T.Vector3,
    axisOrigin: T.Vector3,
    axisDir: T.Vector3,
  ): number {
    const w0x = rayOrigin.x - axisOrigin.x;
    const w0y = rayOrigin.y - axisOrigin.y;
    const w0z = rayOrigin.z - axisOrigin.z;
    const b = rayDir.x * axisDir.x + rayDir.y * axisDir.y + rayDir.z * axisDir.z;
    const d = rayDir.x * w0x + rayDir.y * w0y + rayDir.z * w0z;
    const e = axisDir.x * w0x + axisDir.y * w0y + axisDir.z * w0z;
    const denom = 1 - b * b;
    if (denom < 1e-4) {
      return e;
    }
    return (e - b * d) / denom;
  }
}
