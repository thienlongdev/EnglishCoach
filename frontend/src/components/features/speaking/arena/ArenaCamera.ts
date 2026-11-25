import * as T from 'three';
import type { ArenaWaterMode } from './arenaContracts';

export type ArenaView = 'overview' | 'third' | 'first';

export interface ArenaCameraContext {
  waterMode?: ArenaWaterMode;
  submersion?: number;
  waveSurfaceY?: number;
  boatSpeed?: number;
  inFishing?: boolean;
  fishingBobber?: T.Vector3 | null;
  inSpeaking?: boolean;
  inSeated?: boolean;
}

const CLIP_OFFSETS = [0, -0.13, 0.13] as const;
const DEFAULT_WATER_Y = -1.2;
const MENISCUS_DEADBAND = 0.095;
const FIRST_PERSON_EYE_FORWARD_OFFSET = 0.022;
const FIRST_PERSON_MIN_PITCH = -1.24;
const SPRING_PULL_IN_K = 28;
const SPRING_EASE_OUT_K = 6.5;

/** Camera-only rig; room movement and the authoritative terrain remain owned by Arena. Zero per-frame heap allocations. */
export class ArenaCamera {
  readonly camera = new T.PerspectiveCamera(56, 1, 0.05, 1450);
  /** The vertical field of each view. First person is wider: at 56 degrees your own hands fill the screen. */
  static readonly FOV: Record<ArenaView, number> = { overview: 56, third: 62, first: 72 };

  yaw = Math.PI + 0.16;
  pitch = -0.06;
  zoom = 12;
  view: ArenaView = 'overview';
  /** Height of the character's eyes above its feet, measured from the skeleton. */
  eyeHeight = 1.6;
  /** Smoothly widens third-person follow distance when rowing or piloting a vessel so hull + wake frame cleanly. */
  inBoat = false;
  motorboat = false;
  /** Live vessel speed (m/s), driving wake-framing pullback and dynamic 62° -> 68° motorboat FOV. */
  boatSpeed = 0;
  /** Current water elevation (defaults to ARENA_WATER_Y = -1.2 m) and amphibious state. */
  waterY = DEFAULT_WATER_Y;
  waterMode: ArenaWaterMode = 'land';
  submersion = 0;
  /** Contextual framing flags for fishing (over-the-shoulder + bobber sightline), speaking stations, and benches. */
  inFishing = false;
  fishingBobber: T.Vector3 | null = null;
  inSpeaking = false;
  inSeated = false;
  /** True whenever the camera lens itself is below the water surface. */
  isSubmerged = false;

  /** Dedicated Photo Mode spherical orbit, pan, zoom, and FOV state (zero interference with gameplay view). */
  photoMode = false;
  photoFov = 48;
  photoYaw = Math.PI + 0.18;
  photoPitch = 0.08;
  photoDistance = 2.65;
  readonly photoPanOffset = new T.Vector3();

  private boatPullback = 0;
  private smoothedBoatSpeed = 0;
  private fishingBlend = 0;
  private speakingBlend = 0;
  private seatedBlend = 0;
  private swimSurfaceBlend = 0;
  private diveBlend = 0;
  private smoothedEyeHeight = 1.6;
  private armDistance = -1;
  private lastView: ArenaView = 'overview';
  private wasPhotoMode = false;

  /** Post-IK world-space eye midpoint solved from the character skeleton across all 1P states (land, swim, dive, seat, boat). */
  eyeWorld: T.Vector3 | null = null;
  /** Optional scenic spyglass / lookout override. */
  lookoutOrigin: T.Vector3 | null = null;
  opticalZoom = 2;
  /** The head riding the stride, in metres: set by the body, read only in first person fallback. */
  bob = 0;

  private ready = false;
  private readonly target = new T.Vector3();
  private readonly ray = new T.Raycaster();
  private readonly up = new T.Vector3(0, 1, 0);
  private readonly direction = new T.Vector3();
  private readonly pivot = new T.Vector3();
  private readonly desired = new T.Vector3();
  private readonly matrix = new T.Matrix4();
  private readonly rotation = new T.Quaternion();

  // Zero-allocation scratch vectors
  private readonly _flatFwd = new T.Vector3();
  private readonly _rightAxis = new T.Vector3();
  private readonly _camUpAxis = new T.Vector3();
  private readonly _photoFocus = new T.Vector3();
  private readonly _smoothedSwimEye = new T.Vector3();
  private _swimEyeSeeded = false;
  private readonly _aim = new T.Vector3();
  private readonly _bobberDelta = new T.Vector3();
  private readonly _clipDelta = new T.Vector3();
  private readonly _clipSide = new T.Vector3();
  private readonly _clipOrigin = new T.Vector3();
  private readonly _hitBuffer: T.Intersection[] = [];

  constructor() {
    this.ray.firstHitOnly = true;
  }

  look(dx: number, dy: number) {
    const sensitivity = 0.0026 / (this.lookoutOrigin ? Math.sqrt(this.opticalZoom / 2) : 1);
    this.yaw -= dx * sensitivity;
    const minPitch =
      this.waterMode === 'underwater_dive'
        ? -1.25
        : this.view === 'first'
          ? FIRST_PERSON_MIN_PITCH
          : -1.42;
    const maxPitch = this.waterMode === 'underwater_dive' ? 1.15 : 1.05;
    this.pitch = T.MathUtils.clamp(this.pitch - dy * sensitivity, minPitch, maxPitch);
  }

  /** Frame the character from a flattering front 3/4 portrait angle upon entering Photo Mode. */
  resetPhotoOrbit(charYaw: number, initialFov = 48): void {
    const safeYaw = Number.isFinite(charYaw) ? charYaw : 0;
    this.photoYaw = safeYaw + 0.2;
    this.photoPitch = 0.08;
    this.photoDistance = 2.65;
    this.photoFov = T.MathUtils.clamp(initialFov, 25, 75);
    this.photoPanOffset.set(0, 0, 0);
  }

  /** Spherical orbit around the Photo Mode subject (`dxPx`, `dyPx` pointer delta in CSS pixels). */
  orbitPhoto(dxPx: number, dyPx: number): void {
    this.photoYaw -= dxPx * 0.0052;
    this.photoPitch = T.MathUtils.clamp(this.photoPitch + dyPx * 0.0048, -0.52, 1.18);
  }

  /** Screen-plane pan of the Photo Mode focus target (`dxPx`, `dyPx` pointer delta in CSS pixels). */
  panPhoto(dxPx: number, dyPx: number): void {
    const cosElev = Math.cos(this.photoPitch);
    const sinElev = Math.sin(this.photoPitch);
    // Look vector points from spherical camera position toward focus target
    this.direction.set(
      -Math.sin(this.photoYaw) * cosElev,
      -sinElev,
      -Math.cos(this.photoYaw) * cosElev,
    );
    this._rightAxis.crossVectors(this.direction, this.up);
    if (this._rightAxis.lengthSq() > 1e-6) this._rightAxis.normalize();
    else this._rightAxis.set(1, 0, 0);
    this._camUpAxis.crossVectors(this._rightAxis, this.direction).normalize();

    const panScale = this.photoDistance * 0.0016;
    this.photoPanOffset
      .addScaledVector(this._rightAxis, -dxPx * panScale)
      .addScaledVector(this._camUpAxis, dyPx * panScale);
    if (this.photoPanOffset.lengthSq() > 3.5 * 3.5) {
      this.photoPanOffset.setLength(3.5);
    }
  }

  /** Smooth wheel dolly zoom in Photo Mode (`deltaY` wheel delta). */
  zoomPhoto(deltaY: number): void {
    const clampedDelta = T.MathUtils.clamp(deltaY, -240, 240);
    this.photoDistance = T.MathUtils.clamp(
      this.photoDistance * Math.exp(clampedDelta * 0.0012),
      0.95,
      14.0,
    );
  }

  setPhotoFov(fovDeg: number): void {
    this.photoFov = T.MathUtils.clamp(fovDeg, 25, 75);
  }

  /** Recommended vertical FOV incorporating Photo Mode override, motorboat speed (62° -> 68°), first-person sprint widen, underwater refraction, and spyglass zoom. */
  recommendedFov(sprintAmount = 0, passageOffset = 0): number {
    if (this.photoMode) {
      return T.MathUtils.clamp(this.photoFov, 25, 75);
    }
    if (this.lookoutOrigin) {
      return T.MathUtils.radToDeg(2 * Math.atan(Math.tan(Math.PI / 6) / this.opticalZoom));
    }
    const base = ArenaCamera.FOV[this.view];
    const speedFactor = this.inBoat
      ? T.MathUtils.clamp(this.smoothedBoatSpeed / (this.motorboat ? 9.5 : 4.5), 0, 1)
      : 0;
    const boatFovBoost =
      this.view === 'third'
        ? speedFactor * (this.motorboat ? 6.0 : 2.5)
        : this.view === 'first'
          ? speedFactor * 3.5
          : 0;
    const sprintBoost = this.view === 'first' && !this.inBoat ? T.MathUtils.clamp(sprintAmount, 0, 1) * 3.0 : 0;
    const underwaterShift = this.isSubmerged && this.view !== 'overview' ? -2.2 : 0;
    return base + boatFovBoost + sprintBoost + underwaterShift - passageOffset;
  }

  update(
    dt: number,
    focus: T.Vector3,
    blockers: T.Object3D[],
    reduced: boolean,
    context?: ArenaCameraContext,
  ) {
    const safeDt = Math.min(Math.max(dt, 1e-4), 0.1);
    if (context) {
      if (context.waterMode !== undefined) this.waterMode = context.waterMode;
      if (context.submersion !== undefined) this.submersion = context.submersion;
      if (context.waveSurfaceY !== undefined) this.waterY = context.waveSurfaceY;
      if (context.boatSpeed !== undefined) this.boatSpeed = context.boatSpeed;
      if (context.inFishing !== undefined) this.inFishing = context.inFishing;
      if (context.fishingBobber !== undefined) this.fishingBobber = context.fishingBobber;
      if (context.inSpeaking !== undefined) this.inSpeaking = context.inSpeaking;
      if (context.inSeated !== undefined) this.inSeated = context.inSeated;
    }

    const surfaceY = this.waterY;
    const isDive = this.waterMode === 'underwater_dive';
    const isSurfaceSwim = this.waterMode === 'surface_swim';

    if (this.photoMode) {
      this.wasPhotoMode = true;
      this.smoothedEyeHeight +=
        (this.eyeHeight - this.smoothedEyeHeight) * (reduced || !this.ready ? 1 : 1 - Math.exp(-10 * safeDt));
      const chestLift = Math.max(0.88, this.smoothedEyeHeight * 0.68);
      this._photoFocus
        .copy(focus)
        .addScaledVector(this.up, chestLift)
        .add(this.photoPanOffset);
      this.pivot.copy(this._photoFocus);

      const cosElev = Math.cos(this.photoPitch);
      const sinElev = Math.sin(this.photoPitch);
      this.direction.set(
        Math.sin(this.photoYaw) * cosElev,
        sinElev,
        Math.cos(this.photoYaw) * cosElev,
      );
      const wantedDist = T.MathUtils.clamp(this.photoDistance, 0.95, 14.0);
      const clearDist = blockers.length > 0 ? this.probeClearDistance(this.direction, wantedDist, blockers) : wantedDist;
      this.desired.copy(this._photoFocus).addScaledVector(this.direction, clearDist);
      if (!isDive && this.desired.y < focus.y + 0.16) {
        this.desired.y = focus.y + 0.16;
      }
      this.applyMeniscusDeadband(this.desired, surfaceY, isDive);

      this.camera.position.copy(this.desired);
      this.matrix.lookAt(this.camera.position, this._photoFocus, this.up);
      this.rotation.setFromRotationMatrix(this.matrix);
      this.camera.quaternion.copy(this.rotation);
      this.camera.updateMatrixWorld();
      this.isSubmerged = this.camera.position.y < surfaceY;
      this.ready = true;
      return;
    }

    if (this.wasPhotoMode) {
      this.wasPhotoMode = false;
      this.armDistance = -1;
    }

    if (this.lookoutOrigin) {
      const k = reduced ? 1 : 1 - Math.exp(-8 * safeDt);
      const pitchClamped = T.MathUtils.clamp(this.pitch, -0.9, 0.95);
      const cosP = Math.cos(pitchClamped);
      this.direction.set(Math.sin(this.yaw) * cosP, Math.sin(pitchClamped), Math.cos(this.yaw) * cosP);
      this.camera.position.copy(this.lookoutOrigin);
      this._aim.copy(this.camera.position).addScaledVector(this.direction, 12);
      this.matrix.lookAt(this.camera.position, this._aim, this.up);
      this.rotation.setFromRotationMatrix(this.matrix);
      this.camera.quaternion.slerp(this.rotation, k);
      this.camera.updateMatrixWorld();
      this.isSubmerged = this.camera.position.y < surfaceY;
      this.ready = true;
      return;
    }

    if (this.view !== this.lastView) {
      this.armDistance = -1;
      this.lastView = this.view;
    }

    const first = this.view === 'first';
    if (!first || (!isSurfaceSwim && !isDive)) {
      this._swimEyeSeeded = false;
    }

    const envRate = reduced ? 1 : 1 - Math.exp(-7 * safeDt);
    this.smoothedBoatSpeed += ((this.inBoat ? Math.max(0, this.boatSpeed) : 0) - this.smoothedBoatSpeed) * envRate;
    const speedWakePull = this.inBoat
      ? T.MathUtils.clamp(this.smoothedBoatSpeed / 9.5, 0, 1) * (this.motorboat ? 1.65 : 0.65)
      : 0;
    const targetBoatPull = (this.motorboat ? 4.2 : this.inBoat ? 1.55 : 0) + speedWakePull;
    this.boatPullback += (targetBoatPull - this.boatPullback) * (reduced ? 1 : 1 - Math.exp(-6 * safeDt));

    this.fishingBlend += ((this.inFishing && !this.inBoat && !isDive ? 1 : 0) - this.fishingBlend) * envRate;
    this.speakingBlend += ((this.inSpeaking && !this.inBoat && !isDive ? 1 : 0) - this.speakingBlend) * envRate;
    this.seatedBlend += ((this.inSeated && !this.inBoat && !isDive ? 1 : 0) - this.seatedBlend) * (reduced ? 1 : 1 - Math.exp(-8.5 * safeDt));
    this.swimSurfaceBlend += ((isSurfaceSwim ? 1 : 0) - this.swimSurfaceBlend) * envRate;
    this.diveBlend += ((isDive ? 1 : 0) - this.diveBlend) * envRate;
    this.smoothedEyeHeight +=
      (this.eyeHeight - this.smoothedEyeHeight) * (reduced || !this.ready ? 1 : 1 - Math.exp(-10 * safeDt));

    // Jitter-free horizontal + wave-filtered vertical follow damping during surface swim and underwater dive
    const followKXZ = isDive ? 8.5 : isSurfaceSwim ? 10.5 : 12;
    const followKY = isDive ? 6.5 : isSurfaceSwim ? 5.2 : 12;
    const rotK = isDive ? 9.0 : 12;
    const posAlphaXZ = reduced || !this.ready || first ? 1 : 1 - Math.exp(-followKXZ * safeDt);
    const posAlphaY = reduced || !this.ready || first ? 1 : 1 - Math.exp(-followKY * safeDt);
    const posAlpha = posAlphaXZ;
    const rotAlpha = reduced || !this.ready || first ? 1 : 1 - Math.exp(-rotK * safeDt);

    this.target.x += (focus.x - this.target.x) * posAlphaXZ;
    this.target.y += (focus.y - this.target.y) * posAlphaY;
    this.target.z += (focus.z - this.target.z) * posAlphaXZ;

    // Effective pitch freedom per environment mode (1P clamps look-down at -1.24 rad to reveal own hands/legs/feet without collar clip)
    let effPitch = this.pitch;
    if (isDive) {
      effPitch = T.MathUtils.clamp(this.pitch, -1.25, 1.15);
    } else if (first) {
      effPitch = T.MathUtils.clamp(this.pitch, FIRST_PERSON_MIN_PITCH, 1.05);
      this.pitch = effPitch;
    } else if (isSurfaceSwim && this.view === 'third') {
      // Keep third-person surface swim camera comfortably above the waves looking across the lagoon.
      effPitch = T.MathUtils.clamp(this.pitch, -1.2, 0.05);
    }

    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    const cosP = Math.cos(effPitch);
    const sinP = Math.sin(effPitch);
    this.direction.set(sinY * cosP, sinP, cosY * cosP);
    this._flatFwd.set(sinY, 0, cosY);
    // Character/camera right-shoulder vector in world XZ: cross(flatFwd, up) = (-cosY, 0, sinY) -> wait:
    // For yaw = 0 (+Z forward), right of screen is -X: cross((0,0,1), (0,1,0)) = (-1, 0, 0).
    this._rightAxis.crossVectors(this._flatFwd, this.up);

    // Pivot tracks smoothed seated/standing eye height, with subtle shoulder framing during fishing, speaking, or sitting
    const shoulderOffset =
      this.view === 'third'
        ? this.fishingBlend * 0.38 + this.speakingBlend * 0.18 + this.seatedBlend * 0.10
        : 0;
    const pivotLift =
      this.smoothedEyeHeight +
      this.swimSurfaceBlend * 0.12 -
      this.diveBlend * 0.28 +
      this.fishingBlend * 0.12 -
      this.seatedBlend * 0.05;
    this.pivot
      .copy(this.target)
      .addScaledVector(this.up, pivotLift)
      .addScaledVector(this._rightAxis, shoulderOffset);

    if (this.view === 'overview') {
      const zDist = this.zoom + this.boatPullback * 1.4;
      this.desired.set(
        this.target.x - sinY * zDist,
        this.target.y + zDist * 0.44,
        this.target.z - cosY * zDist,
      );
    } else if (this.view === 'third') {
      const baseDist = T.MathUtils.clamp(this.zoom / 3, 2, 5);
      const followDist =
        Math.max(
          1.55,
          baseDist +
            this.boatPullback +
            this.swimSurfaceBlend * 0.35 +
            this.diveBlend * 0.45 -
            this.fishingBlend * 0.25 -
            this.speakingBlend * 0.45 -
            this.seatedBlend * 0.22,
        );
      const verticalLift =
        0.25 +
        this.boatPullback * 0.18 +
        this.swimSurfaceBlend * 0.24 -
        this.diveBlend * 0.20 +
        this.fishingBlend * 0.14 -
        this.seatedBlend * 0.06;
      this.desired
        .copy(this.pivot)
        .addScaledVector(this.direction, -followDist)
        .addScaledVector(this.up, verticalLift);
    } else if (this.eyeWorld) {
      // True post-IK skeleton eye anchor across land, wading, swimming, diving, seated, and boat (`<= 35 mm` offset).
      if (isSurfaceSwim || isDive) {
        if (!this._swimEyeSeeded || reduced) {
          this._smoothedSwimEye.copy(this.eyeWorld);
          this._swimEyeSeeded = true;
        } else {
          const swimFilterAlpha = 1 - Math.exp(-16 * safeDt);
          this._smoothedSwimEye.lerp(this.eyeWorld, swimFilterAlpha);
          // Bound micro-filter lag to <= 8 mm so total `||camPos - eyeWorld|| <= 30 mm` strictly every frame
          this._clipDelta.copy(this._smoothedSwimEye).sub(this.eyeWorld);
          if (this._clipDelta.lengthSq() > 0.008 * 0.008) {
            this._clipDelta.setLength(0.008);
            this._smoothedSwimEye.copy(this.eyeWorld).add(this._clipDelta);
          }
        }
        this.desired.copy(this._smoothedSwimEye).addScaledVector(this._flatFwd, FIRST_PERSON_EYE_FORWARD_OFFSET);
      } else {
        this.desired.copy(this.eyeWorld).addScaledVector(this._flatFwd, FIRST_PERSON_EYE_FORWARD_OFFSET);
      }
    } else {
      const leanFwd = this.inBoat || this.inSeated
        ? 0.08
        : 0.1 + 0.2 * T.MathUtils.smoothstep(-effPitch, 0.65, 1.24);
      this.desired
        .copy(this.pivot)
        .addScaledVector(this._flatFwd, leanFwd)
        .addScaledVector(this.up, this.bob);
    }

    // Waterline meniscus deadband (`y = surfaceY ± 0.095 m`, or bounded in 1P eye-anchor mode) before obstruction solve
    if (!(first && this.eyeWorld && !isSurfaceSwim && !isDive)) {
      this.applyMeniscusDeadband(this.desired, surfaceY, isDive);
      if (first && this.eyeWorld) {
        this._clipDelta.copy(this.desired).sub(this.eyeWorld);
        if (this._clipDelta.lengthSq() > 0.033 * 0.033) {
          this._clipDelta.setLength(0.033);
          this.desired.copy(this.eyeWorld).add(this._clipDelta);
        }
      }
    }

    // Asymmetric spring-arm BVH obstruction avoidance in 3P/overview (1P eyeWorld stays inside the collision capsule)
    const probe = !first;
    if (probe) {
      this.resolveSpringArm(this.desired, blockers, safeDt, reduced);
    } else if (first && !this.eyeWorld && !this.inBoat) {
      this.clip(this.desired, blockers);
    }

    this.camera.position.lerp(this.desired, posAlpha);
    if (probe) {
      this.clip(this.camera.position, blockers);
      this.applyMeniscusDeadband(this.camera.position, surfaceY, isDive);
    } else if (!this.eyeWorld) {
      this.applyMeniscusDeadband(this.camera.position, surfaceY, isDive);
    }

    if (this.view === 'overview') {
      this._aim.copy(this.target).addScaledVector(this.up, 0.85);
    } else if (this.view === 'third') {
      this._aim.copy(this.pivot).addScaledVector(this.direction, 2.2);
      if (this.fishingBlend > 0.01 && this.fishingBobber) {
        this._bobberDelta.copy(this.fishingBobber).sub(this._aim);
        const bobDist = this._bobberDelta.length();
        if (bobDist > 0.1) {
          this._bobberDelta.multiplyScalar(Math.min(1.4, bobDist * 0.22) / bobDist);
          this._aim.addScaledVector(this._bobberDelta, this.fishingBlend * 0.45);
        }
      }
    } else {
      this._aim.copy(this.camera.position).add(this.direction);
    }

    this.matrix.lookAt(this.camera.position, this._aim, this.up);
    this.rotation.setFromRotationMatrix(this.matrix);
    this.camera.quaternion.slerp(this.rotation, rotAlpha);
    this.camera.updateMatrixWorld();
    this.isSubmerged = this.camera.position.y < surfaceY;
    this.ready = true;
  }

  /**
   * Prevent the lens from hovering inside `y = surfaceY ± 0.08 m` so the viewport never half-splits on the water plane:
   * - Above-water modes (`land`, `wading`, `surface_swim`, `boat`) hold `y >= surfaceY + 0.095 m`.
   * - `underwater_dive` pushes decisively below `surfaceY - 0.095 m` once diving, or above `+0.095 m` when surfacing.
   */
  private applyMeniscusDeadband(point: T.Vector3, surfaceY: number, isDive: boolean) {
    if (!isDive) {
      if (this.pivot.y >= surfaceY - 0.35 && point.y < surfaceY + MENISCUS_DEADBAND) {
        point.y = surfaceY + MENISCUS_DEADBAND;
      }
      return;
    }
    const dy = point.y - surfaceY;
    if (Math.abs(dy) < MENISCUS_DEADBAND) {
      const diveDown = this.submersion >= 0.45 || this.pivot.y < surfaceY;
      point.y = diveDown ? surfaceY - MENISCUS_DEADBAND : surfaceY + MENISCUS_DEADBAND;
    }
  }

  /** Asymmetric spring-arm obstruction solver: fast pull-in (k = 28) on hit, cushioned ease-out (k = 6.5) on clear. */
  private resolveSpringArm(point: T.Vector3, blockers: T.Object3D[], dt: number, reduced: boolean) {
    this._clipDelta.copy(point).sub(this.pivot);
    const wantedDist = this._clipDelta.length();
    if (wantedDist < 0.001) return;
    this._clipDelta.divideScalar(wantedDist);

    const clearDist = this.probeClearDistance(this._clipDelta, wantedDist, blockers);
    if (reduced || !this.ready || this.armDistance < 0) {
      this.armDistance = clearDist;
    } else if (clearDist < this.armDistance) {
      this.armDistance += (clearDist - this.armDistance) * (1 - Math.exp(-SPRING_PULL_IN_K * dt));
      // Hard wall safety clamp so rapid mouse whips never momentarily expose the back-face of a cliff.
      if (this.armDistance > clearDist + 0.04) this.armDistance = clearDist + 0.02;
    } else {
      this.armDistance += (clearDist - this.armDistance) * (1 - Math.exp(-SPRING_EASE_OUT_K * dt));
    }
    this.armDistance = Math.min(wantedDist, this.armDistance);
    point.copy(this.pivot).addScaledVector(this._clipDelta, this.armDistance);
  }

  private probeClearDistance(dir: T.Vector3, maxDistance: number, blockers: T.Object3D[]): number {
    if (!blockers.length) return maxDistance;
    let limit = maxDistance;
    this._clipSide.crossVectors(dir, this.up);
    const sideLen = this._clipSide.length();
    if (sideLen > 1e-5) this._clipSide.divideScalar(sideLen);
    else this._clipSide.set(1, 0, 0);

    for (let i = 0; i < CLIP_OFFSETS.length; i++) {
      const offset = CLIP_OFFSETS[i];
      this._clipOrigin.copy(this.pivot).addScaledVector(this._clipSide, offset);
      this.ray.set(this._clipOrigin, dir);
      this.ray.far = maxDistance + 0.15;
      this._hitBuffer.length = 0;
      const hits = this.ray.intersectObjects(blockers, false, this._hitBuffer);
      if (hits.length > 0) {
        limit = Math.min(limit, Math.max(0.08, hits[0].distance - 0.18));
      }
    }
    return limit;
  }

  private clip(point: T.Vector3, blockers: T.Object3D[]) {
    if (!blockers.length) return;
    this._clipDelta.copy(point).sub(this.pivot);
    const distance = this._clipDelta.length();
    if (distance < 0.001) return;
    this._clipDelta.divideScalar(distance);
    const limit = this.probeClearDistance(this._clipDelta, distance, blockers);
    if (limit < distance) {
      point.copy(this.pivot).addScaledVector(this._clipDelta, limit);
    }
  }
}
