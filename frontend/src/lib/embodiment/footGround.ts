import * as T from 'three';

const _source = new T.Vector3();
const _offset = new T.Vector3();
const _free = new T.Vector3();
const _travelDir = new T.Vector3();
const _anchored = new T.Vector3();
const _solePrev = new T.Vector3();
const _lockedOut = new T.Vector3();

/** A stance foot rolls about its measured sole contact. The animation supplies
 * lift-off and swing; the scene supplies the support height. This is a contact
 * constraint for leg IK, not a second rigid-body simulation.
 *
 * Zero per-frame heap allocations (`0` `new Vector3` / `.clone()` in `solve` & `reorient`),
 * exact conservative rigid-sole support rolling (`0` hysteresis drift under heel-to-toe rocking),
 * and continuous `lockWeight` (`1 - verticalGaitWeight`).
 */
export class FootGround {
  /** How far a locked footprint may stay from the clip's own foot, metres at scale 1. */
  static MAX_LOCK = 0.04;
  /** How far a footprint left beyond that pivots back under the clip's foot in one frame, metres at scale 1. */
  static PIVOT = 0.0045;
  on = false;
  /** This frame's shoe pivots with the body (see `solve`): nothing re-anchors it. */
  private pivoting = false;
  private seen = false;
  private point = new T.Vector3();
  private local = new T.Vector3();
  private ankle = new T.Vector3();
  private rotation = new T.Quaternion();
  private scale = new T.Vector3(1, 1, 1);
  private bottomY = Infinity;
  private source = new T.Vector3();
  private sourceSeen = false;
  private landingLift = 0;
  private release = new T.Vector3();
  private stepActive = false;
  private stepFrom = new T.Vector3();
  private stepTo = new T.Vector3();
  private stepElapsed = 0;
  private stepSeconds = 0.2;

  get recovering(): boolean {
    return this.stepActive;
  }

  /** Normalized progress `[0..1]` within current contact/recovery, or `0.45` mid-stance default. */
  stanceProgress = 0.45;
  private stanceTime = 0;

  reset(): void {
    this.pivoting = false;
    this.on = false;
    this.seen = false;
    this.sourceSeen = false;
    this.landingLift = 0;
    this.release.set(0, 0, 0);
    this.stepActive = false;
    this.stanceTime = 0;
    this.stanceProgress = 0.45;
  }

  /** Remember the reached shoe, never the requested IK target. */
  reached(at: T.Vector3, q: T.Quaternion, bottomY: number): void {
    this.ankle.copy(at);
    this.rotation.copy(q);
    this.bottomY = bottomY;
    this.seen = true;
  }

  reorient(
    at: T.Vector3,
    q: T.Quaternion,
    scale: T.Vector3,
    sole: T.Vector3,
    ground: number | null,
    low: number,
  ): void {
    if (
      !this.pivoting &&
      this.seen &&
      ground !== null &&
      Math.abs(this.bottomY - ground) <= 0.005 * this.scale.y &&
      at.y + low - ground <= 0.005 * this.scale.y
    ) {
      _offset.copy(sole).multiply(scale).applyQuaternion(q);
      this.point.copy(sole).multiply(scale).applyQuaternion(this.rotation).add(this.ankle).setY(ground);
      at.copy(this.point).sub(_offset);
      this.local.copy(sole);
    }
    if (ground !== null) at.y = Math.max(at.y, ground - low);
  }

  solve(
    at: T.Vector3,
    q: T.Quaternion,
    scale: T.Vector3,
    sole: T.Vector3,
    ground: number | null,
    dt: number,
    k: number,
    out: T.Vector3,
    canStep = false,
    travel?: T.Vector3,
    pivoting = false,
    lockWeight = 1,
  ): T.Vector3 {
    const wLock = T.MathUtils.clamp(lockWeight, 0, 1);
    _source.copy(at);
    _offset.copy(sole).multiply(scale).applyQuaternion(q);
    // Ground compression is not an airborne displacement. Carry only the
    // horizontal stance correction into swing, so release cannot pin a low
    // ankle to the floor while its horizontal correction decays.
    const decay24 = Math.exp(-dt * 24);
    _free.copy(_source).addScaledVector(this.release, decay24);
    const height = ground === null ? Infinity : _source.y + _offset.y - ground;

    let horizTravelSpeed = 0;
    let advancing = 0;
    if (travel) {
      horizTravelSpeed = Math.hypot(travel.x, travel.z);
      if (this.sourceSeen && horizTravelSpeed > 0.1) {
        _travelDir.set(travel.x / horizTravelSpeed, 0, travel.z / horizTravelSpeed);
        advancing =
          ((_source.x - this.source.x) * _travelDir.x + (_source.z - this.source.z) * _travelDir.z) /
          Math.max(dt, 1 / 240);
      }
    }

    // Retargeting can lower a toe before the forward swing has finished. Keep
    // clearance while it advances; plant only after the landing foot settles.
    if (!this.on && !this.stepActive && advancing > 0.35 * k && height < 0.008 * k) {
      this.landingLift = 0.008 * k - height;
    } else {
      this.landingLift *= Math.exp(-40 * dt);
    }
    _free.y += this.landingLift;

    const was = this.on;
    const previousHeight = ground === null || !this.seen ? Infinity : this.bottomY - ground;
    if (was && this.seen && sole.distanceToSquared(this.local) > 1e-12) {
      this.point
        .copy(sole)
        .multiply(scale)
        .applyQuaternion(this.rotation)
        .add(this.ankle);
      if (ground !== null) this.point.y = ground;
    }

    // Pivoting (a walking body turning fast over it): the shoe turns with the body on its ball or heel, it is not held
    // where it stood. Held, the turn swept a foot 0.3 m out across the other leg.
    this.pivoting = pivoting;
    if (pivoting) {
      this.on = false;
      this.stepActive = false;
    }
    if (this.stepActive || ground === null || pivoting || (this.on && height > 0.006 * k)) {
      this.on = false;
    } else if (!this.on && height + this.landingLift <= 0.005 * k && ground !== null) {
      this.on = true;
      this.stanceTime = 0;
      // A shoe already within contact distance lands where it actually was,
      // rather than jumping to the next animated footprint.
      if (Math.abs(previousHeight) <= 0.005 * k) {
        _solePrev.copy(sole).multiply(scale).applyQuaternion(this.rotation).add(this.ankle);
        this.point.copy(_solePrev);
      } else {
        this.point.copy(_free).add(_offset);
      }
      this.point.y = ground;
    }

    if (this.on) {
      this.stanceTime += Math.max(0, dt);
      const estStanceDur = horizTravelSpeed > 2.0 * k ? 0.28 : 0.52;
      this.stanceProgress = T.MathUtils.clamp(this.stanceTime / estStanceDur, 0, 1);
      _lockedOut.copy(this.point).sub(_offset);
      out.x = T.MathUtils.lerp(_free.x, _lockedOut.x, wLock);
      out.z = T.MathUtils.lerp(_free.z, _lockedOut.z, wLock);
      out.y = _lockedOut.y;

      // A direction/crossfade change can ask for a different footprint without
      // a lift in the blended clip. Take a real clearance step before the old
      // anchor drags the body into a split. The other foot must support it.
      const distance = Math.hypot(out.x - _source.x, out.z - _source.z);
      const allowHop = canStep && horizTravelSpeed < 1.85 * k && wLock > 0.5;
      if (!this.stepActive && allowHop && distance > 0.1 * k) {
        // The shoe can rock from heel to toe during this swing. Interpolate
        // ankle positions so a different lowest vertex cannot translate the
        // ankle by the full length of the shoe in one frame.
        this.stepActive = true;
        this.stepFrom.copy(out);
        this.stepTo.copy(_source).setY(ground! - _offset.y);
        this.stepElapsed = 0;
        this.stepSeconds = Math.min(0.26, 0.14 + (distance * 0.35) / k);
      }
      this.release.set(out.x - _source.x, 0, out.z - _source.z);
    } else {
      this.stanceTime = 0;
      this.stanceProgress = 0.45;
      this.release.multiplyScalar(decay24);
      out.copy(_free);
    }

    if (this.stepActive) {
      this.stepElapsed = Math.min(this.stepSeconds, this.stepElapsed + dt);
      const t = this.stepElapsed / this.stepSeconds;
      // Lift before transferring horizontally; settle before re-acquiring.
      const tr = T.MathUtils.clamp((t - 0.12) / 0.76, 0, 1);
      const blend = tr * tr * tr * (10 + tr * (-15 + 6 * tr));
      if (t < 0.65 && ground !== null) {
        this.stepTo.copy(_source).setY(ground - _offset.y);
      }
      out.lerpVectors(this.stepFrom, this.stepTo, blend);
      out.y += Math.sin(Math.PI * t) ** 2 * 0.055 * k;
      this.on = false;
      this.release.set(0, 0, 0);
      if (t >= 1) {
        this.stepActive = false;
        this.point.copy(out).add(_offset);
        this.on = ground !== null;
        if (ground !== null) this.point.y = ground;
        this.release.set(out.x - _source.x, 0, out.z - _source.z);
      }
    }

    if (ground !== null) out.y = Math.max(out.y, ground - _offset.y);

    // Clearance, not a controller flag, permits transfer. A changed sole
    // footprint (e.g. a flat shoe rolling from heel to toe) can put the first
    // or last recovery-step samples on the ground while `on` is false. Keep
    // that actual material contact fixed until the shoe has lifted clear.
    if (
      !pivoting &&
      wLock > 0.05 &&
      ground !== null &&
      this.seen &&
      Math.abs(previousHeight) <= 0.005 * k &&
      out.y + _offset.y - ground <= 0.005 * k
    ) {
      _anchored
        .copy(sole)
        .multiply(scale)
        .applyQuaternion(this.rotation)
        .add(this.ankle)
        .sub(_offset);
      out.x = T.MathUtils.lerp(out.x, _anchored.x, wLock);
      out.z = T.MathUtils.lerp(out.z, _anchored.z, wLock);
      if (this.on) this.point.copy(out).add(_offset).setY(ground);
    }

    // A locked shoe pivots with a body that turns over it; it never stays behind far enough to cross the other leg.
    if (ground !== null && !this.stepActive) {
      const dx = out.x - _source.x;
      const dz = out.z - _source.z;
      const d = Math.hypot(dx, dz);
      const most = FootGround.MAX_LOCK * k;
      if (d > most && d > 1e-8) {
        const keep = Math.max(most, d - FootGround.PIVOT * k) / d;
        const sx = _source.x + dx * keep - out.x;
        const sz = _source.z + dz * keep - out.z;
        out.x += sx;
        out.z += sz;
        this.ankle.x += sx;
        this.ankle.z += sz;
        if (this.on) this.point.copy(out).add(_offset).setY(ground);
        this.release.set(out.x - _source.x, 0, out.z - _source.z);
      }
    }

    this.local.copy(sole);
    this.scale.copy(scale);
    this.source.copy(_source);
    this.sourceSeen = true;
    return out;
  }
}
