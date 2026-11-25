import * as T from 'three';
import { EXACT_UPRIGHT_MIN_UP_Y, worldUpYFromQuat } from '@/lib/study-space/orientation';

/**
 * Where the thing in the hands will go: a crisp aim ring on the surface under the eyes, a base footprint ring
 * tracking the oriented 3D support boundary, and a rim-lit ghost of the thing standing at its exact 3D quaternion
 * (including 3-axis pitch/yaw/roll and uprighted poses of previously fallen furniture).
 *
 * Vibrant emerald (`#34d399`) where it fits, clear coral-red (`#f87171`) where it does not.
 * Lifted `+3.0 mm` along the surface normal with hardware polygonOffset and `depthWrite: false` so it never
 * Z-fights or flickers on floors, rugs, or desks. Shares the held object's geometry and pre-compiles fixed-key
 * materials for zero runtime shader or heap allocations.
 */
const GHOST_VERTEX = `
varying vec3 vN; varying vec3 vV;
void main() {
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-p.xyz);
  gl_Position = projectionMatrix * p;
}`;
const GHOST_FRAGMENT = `
uniform vec3 uColor; uniform float uAlpha;
varying vec3 vN; varying vec3 vV;
void main() {
  float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
  gl_FragColor = vec4(uColor * (0.82 + rim * 0.92), uAlpha + rim * 0.58);
  #include <colorspace_fragment>
}`;

const GHOST_SHADER_KEY = () => 'ec-placement-ghost-v1';
const RING_SHADER_KEY = () => 'ec-placement-ring-v1';

const VALID_COLOR = new T.Color('#34d399');
const INVALID_COLOR = new T.Color('#f87171');
const DOT_VALID_COLOR = new T.Color('#ecfdf5');
const DOT_INVALID_COLOR = new T.Color('#fee2e2');

/** Surface-normal lift (`+3.0 mm` footprint, `+3.3 mm` aim ring, `+3.5 mm` center dot) preventing coplanar Z-fighting. */
const FOOTPRINT_NORMAL_LIFT_M = 0.003;
const AIM_RING_NORMAL_LIFT_M = 0.0033;
const AIM_DOT_NORMAL_LIFT_M = 0.0035;

function isVisibleInHeld(node: T.Object3D, root: T.Object3D): boolean {
  let cur: T.Object3D | null = node;
  while (cur) {
    if (!cur.visible) return false;
    if (cur === root) break;
    cur = cur.parent;
  }
  return true;
}

export class PlacementPreview {
  readonly group = new T.Group();
  private ring: T.Mesh<T.RingGeometry, T.MeshBasicMaterial>;
  private dot: T.Mesh<T.CircleGeometry, T.MeshBasicMaterial>;
  private footprintRing: T.Mesh<T.RingGeometry, T.MeshBasicMaterial>;
  private warmupDummyGeo: T.BufferGeometry | null = null;
  private ghost: T.Group | null = null;
  private ghostFor: T.Object3D | null = null;
  private ghostMaterial: T.ShaderMaterial;

  private readonly localBounds = new T.Box3();
  private readonly localCenterUnscaled = new T.Vector3();
  private readonly localSizeUnscaled = new T.Vector3(0.3, 0.3, 0.3);
  private readonly lastAtStage = new T.Vector3();
  private readonly lastRestStage = new T.Vector3();
  private readonly lastQuatStage = new T.Quaternion();
  private lastScale = 1;

  private readonly tmpCorner = new T.Vector3();
  private readonly tmpOrientedBox = new T.Box3();
  private readonly tmpLift = new T.Vector3();
  private readonly tmpNormal = new T.Vector3();
  private readonly tmpQuat = new T.Quaternion();
  private readonly tmpUpZ = new T.Vector3(0, 0, 1);
  private readonly tmpInverseMat = new T.Matrix4();
  private readonly tmpMeshBox = new T.Box3();

  private time = 0;
  private shake = 0;
  private ok = true;
  private uprightNow = true;

  constructor() {
    this.ghostMaterial = new T.ShaderMaterial({
      vertexShader: GHOST_VERTEX,
      fragmentShader: GHOST_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: T.FrontSide,
      uniforms: {
        uColor: { value: VALID_COLOR.clone() },
        uAlpha: { value: 0.26 },
      },
    });
    this.ghostMaterial.customProgramCacheKey = GHOST_SHADER_KEY;

    const ringMat = new T.MeshBasicMaterial({
      color: VALID_COLOR.clone(),
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: T.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    ringMat.customProgramCacheKey = RING_SHADER_KEY;

    const dotMat = new T.MeshBasicMaterial({
      color: DOT_VALID_COLOR.clone(),
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: T.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    dotMat.customProgramCacheKey = RING_SHADER_KEY;

    const footMat = new T.MeshBasicMaterial({
      color: VALID_COLOR.clone(),
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: T.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    footMat.customProgramCacheKey = RING_SHADER_KEY;

    this.ring = new T.Mesh(new T.RingGeometry(0.02, 0.028, 40), ringMat);
    this.dot = new T.Mesh(new T.CircleGeometry(0.0054, 18), dotMat);
    this.footprintRing = new T.Mesh(new T.RingGeometry(0.88, 1.0, 48), footMat);
    this.footprintRing.rotation.x = -Math.PI / 2;

    this.footprintRing.renderOrder = 6;
    this.footprintRing.userData.noCollision = true;
    this.group.add(this.footprintRing);

    this.ring.renderOrder = 7;
    this.ring.userData.noCollision = true;
    this.group.add(this.ring);

    this.dot.renderOrder = 8;
    this.dot.userData.noCollision = true;
    this.group.add(this.dot);

    // Hidden warmup proxy mesh so Stage-6 `runPreEntryWarmup` compiles `ghostMaterial` alongside `ring`/`dot`/`footprintRing`
    // against both the Linear HDR PostFX RT and the sRGB backbuffer (`programDelta === 0` on first pickup!).
    this.warmupDummyGeo = new T.BoxGeometry(0.08, 0.08, 0.08);
    const warmupProxy = new T.Mesh(this.warmupDummyGeo, this.ghostMaterial);
    warmupProxy.visible = false;
    warmupProxy.castShadow = false;
    warmupProxy.receiveShadow = false;
    warmupProxy.userData.noCollision = true;
    this.group.add(warmupProxy);

    this.group.visible = false;
    this.group.userData.noCollision = true;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /**
   * `at` is the point on the surface (stage space), `normal` its up direction, `rest` where the thing's own origin
   * will stand, and `quaternion` its full 3D orientation (supporting arbitrary X/Y/Z tilt or upright reset).
   * Allocates zero geometries, materials, vectors, or strings per frame.
   */
  show(
    at: T.Vector3,
    normal: T.Vector3,
    ok: boolean,
    held: T.Object3D,
    rest: T.Vector3,
    quaternion: T.Quaternion,
    scale: number,
  ): void {
    this.group.visible = true;
    this.ok = ok;
    this.uprightNow = worldUpYFromQuat(quaternion) >= EXACT_UPRIGHT_MIN_UP_Y;
    this.lastAtStage.copy(at);
    this.lastRestStage.copy(rest);
    this.lastQuatStage.copy(quaternion).normalize();
    this.lastScale = Math.max(0.05, scale);

    this.tmpNormal.copy(normal);
    if (this.tmpNormal.lengthSq() < 1e-6) this.tmpNormal.set(0, 1, 0);
    else this.tmpNormal.normalize();

    this.tmpQuat.setFromUnitVectors(this.tmpUpZ, this.tmpNormal);

    this.tmpLift.copy(this.tmpNormal).multiplyScalar(AIM_RING_NORMAL_LIFT_M);
    this.ring.position.copy(at).add(this.tmpLift);
    this.ring.quaternion.copy(this.tmpQuat);

    this.tmpLift.copy(this.tmpNormal).multiplyScalar(AIM_DOT_NORMAL_LIFT_M);
    this.dot.position.copy(at).add(this.tmpLift);
    this.dot.quaternion.copy(this.tmpQuat);

    const statusColor = ok ? VALID_COLOR : INVALID_COLOR;
    this.ring.material.color.copy(statusColor);
    this.dot.material.color.copy(ok ? DOT_VALID_COLOR : DOT_INVALID_COLOR);
    this.footprintRing.material.color.copy(statusColor);
    (this.ghostMaterial.uniforms.uColor.value as T.Color).copy(statusColor);

    if (this.ghostFor !== held) this.buildGhost(held);
    if (this.ghost) {
      this.ghost.position.copy(rest);
      this.ghost.quaternion.copy(this.lastQuatStage);
      this.ghost.scale.setScalar(this.lastScale);
      this.ghost.visible = true;
    }

    this.updateOrientedFootprint();
  }

  hide(): void {
    this.group.visible = false;
  }

  /** Force-rebuilds cached ghost meshes if a held object swapped sub-visibility or assets. */
  invalidate(): void {
    this.ghostFor = null;
  }

  /** A click on a place that does not fit: the ring says no, the thing stays in the hands. */
  refuse(): void {
    this.shake = 0.45;
  }

  /** Scaled local offset from the object's origin to its geometric center (for `TransformGizmo3D.attach`). */
  localPivotOffset(out: T.Vector3 = new T.Vector3()): T.Vector3 {
    return out.copy(this.localCenterUnscaled).multiplyScalar(this.lastScale);
  }

  /** Exact stage-space geometric center of the oriented 3D ghost. */
  anchorStageCenter(out: T.Vector3 = new T.Vector3()): T.Vector3 {
    return out
      .copy(this.localCenterUnscaled)
      .multiplyScalar(this.lastScale)
      .applyQuaternion(this.lastQuatStage)
      .add(this.lastRestStage);
  }

  /** Exact world-space geometric center of the oriented 3D ghost. */
  anchorWorldCenter(out: T.Vector3 = new T.Vector3()): T.Vector3 {
    this.anchorStageCenter(out);
    if (this.group.parent) {
      this.group.parent.updateWorldMatrix(true, false);
      this.group.parent.localToWorld(out);
    }
    return out;
  }

  /** Bounding radius in stage metres for sizing a 3D gizmo snugly around the previewed object. */
  radius(): number {
    const sx = this.localSizeUnscaled.x * this.lastScale;
    const sy = this.localSizeUnscaled.y * this.lastScale;
    const sz = this.localSizeUnscaled.z * this.lastScale;
    return Math.max(0.16, Math.hypot(sx, sy, sz) * 0.52);
  }

  /** Pre-compiles ghost and ring shaders during scene warmup so first pickup incurs `0` shader hitches. */
  warmup(renderer: T.WebGLRenderer, camera: T.Camera): void {
    const prevVis = this.group.visible;
    let tempMesh: T.Mesh | null = null;
    if (!this.ghost) {
      this.warmupDummyGeo ??= new T.BoxGeometry(0.1, 0.1, 0.1);
      tempMesh = new T.Mesh(this.warmupDummyGeo, this.ghostMaterial);
      tempMesh.userData.noCollision = true;
      this.group.add(tempMesh);
    }
    this.group.visible = true;
    try {
      renderer.compile(this.group, camera);
    } finally {
      if (tempMesh) this.group.remove(tempMesh);
      this.group.visible = prevVis;
    }
  }

  private buildGhost(held: T.Object3D): void {
    if (this.ghost) {
      this.group.remove(this.ghost);
      this.ghost = null;
    }
    this.ghostFor = held;
    const ghost = new T.Group();
    ghost.userData.noCollision = true;
    this.localBounds.makeEmpty();

    held.updateWorldMatrix(true, true);
    const inverse = this.tmpInverseMat.copy(held.matrixWorld).invert();
    const meshBox = this.tmpMeshBox;

    held.traverse((o) => {
      const mesh = o as T.Mesh;
      if (
        !mesh.isMesh ||
        mesh.userData.blob ||
        mesh.userData.noCollision ||
        mesh.userData.isTransformGizmo ||
        !isVisibleInHeld(mesh, held)
      ) {
        return;
      }
      const copy = new T.Mesh(mesh.geometry, this.ghostMaterial);
      copy.matrixAutoUpdate = false;
      // Shape relative to the object's unscaled local frame (`ghost` group applies `scale` and 3D `quaternion`).
      copy.matrix.multiplyMatrices(inverse, mesh.matrixWorld);
      copy.userData.noCollision = true;
      copy.castShadow = false;
      copy.receiveShadow = false;
      copy.renderOrder = 5;
      ghost.add(copy);

      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox && !mesh.geometry.boundingBox.isEmpty()) {
        meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(copy.matrix);
        this.localBounds.union(meshBox);
      }
    });

    if (this.localBounds.isEmpty()) {
      this.localBounds.min.set(-0.15, 0, -0.15);
      this.localBounds.max.set(0.15, 0.3, 0.15);
    }
    this.localBounds.getCenter(this.localCenterUnscaled);
    this.localBounds.getSize(this.localSizeUnscaled);

    this.ghost = ghost;
    this.group.add(ghost);
  }

  private updateOrientedFootprint(): void {
    this.tmpOrientedBox.makeEmpty();
    const min = this.localBounds.min;
    const max = this.localBounds.max;
    const s = this.lastScale;
    for (let ix = 0; ix < 2; ix++) {
      const x = (ix ? max.x : min.x) * s;
      for (let iy = 0; iy < 2; iy++) {
        const y = (iy ? max.y : min.y) * s;
        for (let iz = 0; iz < 2; iz++) {
          const z = (iz ? max.z : min.z) * s;
          this.tmpCorner.set(x, y, z).applyQuaternion(this.lastQuatStage).add(this.lastRestStage);
          this.tmpOrientedBox.expandByPoint(this.tmpCorner);
        }
      }
    }
    const cx = (this.tmpOrientedBox.min.x + this.tmpOrientedBox.max.x) * 0.5;
    const cz = (this.tmpOrientedBox.min.z + this.tmpOrientedBox.max.z) * 0.5;
    const spanX = this.tmpOrientedBox.max.x - this.tmpOrientedBox.min.x;
    const spanZ = this.tmpOrientedBox.max.z - this.tmpOrientedBox.min.z;
    const footR = T.MathUtils.clamp(Math.hypot(spanX, spanZ) * 0.38, 0.055, 1.35);

    // Clear visual overlays (rugs, mats, desk pads) when resting on horizontal surfaces, then lift `+3.0 mm` along surface normal.
    const baseY =
      this.tmpNormal.y >= 0.85 && Math.abs(this.lastAtStage.y - this.tmpOrientedBox.min.y) <= 0.03
        ? Math.max(this.tmpOrientedBox.min.y, this.lastAtStage.y)
        : this.tmpOrientedBox.min.y;

    this.tmpLift.copy(this.tmpNormal).multiplyScalar(FOOTPRINT_NORMAL_LIFT_M);
    this.footprintRing.position.set(cx + this.tmpLift.x, baseY + this.tmpLift.y, cz + this.tmpLift.z);
    if (this.tmpNormal.y >= 0.5) {
      this.footprintRing.quaternion.copy(this.tmpQuat);
    } else {
      this.tmpLift.set(0, 1, 0);
      this.footprintRing.quaternion.setFromUnitVectors(this.tmpUpZ, this.tmpLift);
    }
    this.footprintRing.scale.setScalar(footR);
  }

  update(dt: number, reduced: boolean): void {
    if (!this.group.visible) return;
    this.time += dt;
    const pulse = reduced ? 1 : 1 + 0.07 * Math.sin(this.time * 4.2);
    const wobble = this.shake > 0 && !reduced ? Math.sin(this.shake * 60) * this.shake * 0.5 : 0;
    this.shake = Math.max(0, this.shake - dt);
    this.ring.scale.setScalar(pulse + wobble);
    this.ring.material.opacity = this.ok ? 0.96 : 0.84 + 0.16 * Math.sin(this.time * 9);
    this.footprintRing.material.opacity = this.ok ? (this.uprightNow ? 0.72 : 0.60) : 0.78;
    this.ghostMaterial.uniforms.uAlpha.value =
      (this.ok ? 0.22 + (reduced ? 0 : 0.04 * Math.sin(this.time * 3)) : 0.28) + this.shake * 0.4;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.dot.geometry.dispose();
    this.dot.material.dispose();
    this.footprintRing.geometry.dispose();
    this.footprintRing.material.dispose();
    this.warmupDummyGeo?.dispose();
    this.ghostMaterial.dispose();
  }
}
