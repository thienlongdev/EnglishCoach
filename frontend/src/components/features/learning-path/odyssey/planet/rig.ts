/* Echo Living Planet — the camera rig. One continuous altitude: far away the camera circles the globe and looks at
   its centre; close in it tilts and looks at the ground like a miniature diorama.
   Direct manipulation: the point of the planet under the pointer stays under the pointer while dragging (drag down ⇒
   the planet moves down), with inertia after release. Off the globe the drag falls back to the screen axes with the
   same sense. The wheel zooms towards the pointer, flights between regions arc over the planet.
   Orientation is a full frame — the focus `f` and a tangent "screen up" vector `fw` — turned rigidly by every drag.
   Nothing is measured against north while dragging, so the poles are ordinary places: no latitude limit, no flip. */
import * as THREE from 'three';

export const ALT_FAR = 430, ALT_NEAR = 16, ALT_REGION = 40, ALT_STATION = 22;
const HALF_FOV_TAN = Math.tan(THREE.MathUtils.degToRad(15));
const TILT_MAX = THREE.MathUtils.degToRad(57);
const up = new THREE.Vector3(), east = new THREE.Vector3(), north = new THREE.Vector3(), fwd = new THREE.Vector3(), tmp = new THREE.Vector3();
const WORLD_Y = new THREE.Vector3(0, 1, 0), WORLD_Z = new THREE.Vector3(0, 0, 1);
const qTmp = new THREE.Quaternion(), vTmp = new THREE.Vector3();

export function localFrame(f: THREE.Vector3, heading: number) {
  up.copy(f).normalize();
  east.crossVectors(Math.abs(up.y) > 0.999 ? WORLD_Z : WORLD_Y, up).normalize();
  north.crossVectors(up, east).normalize();
  fwd.copy(north).multiplyScalar(Math.cos(heading)).addScaledVector(east, Math.sin(heading)).normalize();
  return { up, east, north, fwd };
}
const easeInOut = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

interface Flight { f0: THREE.Vector3; f1: THREE.Vector3; a0: number; a1: number; h1: number; t: number; e: number; dur: number; peak: number }

export class PlanetRig {
  f = new THREE.Vector3(0, 0.26, 0.97).normalize();
  /** The view's "up" on the ground: a unit tangent at `f`, carried rigidly by every rotation (never rebuilt from north). */
  fw = new THREE.Vector3(0, 1, 0);
  alt = ALT_FAR;
  ground = 0;              // smoothed terrain height under the focus
  /** A pointer is holding the planet: the view moves only with the hand. The fling measured from the drag starts on
      release — applied while still holding, it ran ahead of the hand between two pointer events and was pulled back by
      the next one (a shiver, strongest near the edge of the globe and over the poles). */
  held = false;
  /** The last grab was held back by its limit (the grabbed point is no longer under the pointer). */
  capped = false;
  /** Angular velocity of the focus (world axis × rad/s) — inertia after a drag. */
  private spinAxis = new THREE.Vector3();
  private spinRate = 0;
  private flight: Flight | null = null;
  private moved = true;
  /** Smoothed angular velocity of the camera around the planet (world vector, rad/s): drives the water's inertia. */
  readonly angular = new THREE.Vector3();
  private lastCam = new THREE.Vector3();
  readonly radius: number;
  /** Viewport width / height: a portrait phone sees much less across, so every altitude backs off to keep the frame. */
  aspect = 1.6;
  constructor(radius: number) { this.radius = radius; this.heading = 0; }
  /** Compass heading of the view (0 = north up). Only read for lighting and written by flights / placement. */
  get heading() { const { east: E, north: N } = localFrame(this.f, 0); return Math.atan2(this.fw.dot(E), this.fw.dot(N)); }
  set heading(h: number) { this.fw.copy(localFrame(this.f, h).fwd); }
  private ortho() {
    this.f.normalize(); this.fw.addScaledVector(this.f, -this.fw.dot(this.f));
    if (this.fw.lengthSq() < 1e-10) this.fw.copy(localFrame(this.f, 0).fwd); else this.fw.normalize();
  }
  /** Move the focus to a new direction, carrying the view's up along the shortest arc (no twist). */
  private moveFocus(next: THREE.Vector3) {
    vTmp.copy(next).normalize();
    if (this.f.dot(vTmp) > -0.999999) this.fw.applyQuaternion(qTmp.setFromUnitVectors(this.f, vTmp));
    this.f.copy(vTmp); this.ortho();
  }
  private get narrow() { return HALF_FOV_TAN / Math.min(HALF_FOV_TAN, HALF_FOV_TAN * this.aspect); }
  /** Whole planet in view (with its atmosphere), whatever the window shape. */
  get farAlt() { return Math.max(ALT_FAR, this.radius * 1.24 / Math.min(HALF_FOV_TAN, HALF_FOV_TAN * this.aspect) - this.radius); }
  get regionAlt() { return ALT_REGION * Math.pow(this.narrow, 0.75); }
  get stationAlt() { return ALT_STATION * Math.pow(this.narrow, 0.75); }

  get flying() { return !!this.flight; }
  get tilt() { const k = Math.pow(this.narrow, 0.75); return TILT_MAX * (1 - THREE.MathUtils.smoothstep(this.alt, 44 * k, 175 * k)); }
  /** 0 = whole globe, 1 = standing over the ground. */
  get closeness() { const k = Math.pow(this.narrow, 0.75); return 1 - THREE.MathUtils.smoothstep(this.alt, 80 * k, 240 * k); }
  /** Radius of the surface a pointer grabs (the ground under the focus). */
  get grabRadius() { return this.radius + Math.max(0, this.ground) * 0.6; }

  flyTo(dir: THREE.Vector3, alt: number, heading: number, reduced: boolean) {
    const f1 = dir.clone().normalize();
    this.spinRate = 0;
    if (reduced) { this.moveFocus(f1); this.alt = alt; this.heading = heading; this.flight = null; this.moved = true; return 0; }
    const angle = this.f.angleTo(f1);
    const dur = THREE.MathUtils.clamp(0.75 + angle * 0.9 + Math.abs(Math.log(alt / this.alt)) * 0.18, 0.8, 2.2);
    const peak = Math.max(this.alt, alt, angle * this.radius * 1.15);
    this.flight = { f0: this.f.clone(), f1, a0: this.alt, a1: alt, h1: heading, t: 0, e: 0, dur, peak };
    return dur;
  }
  cancelFlight() { this.flight = null; }
  stopSpin() { this.spinRate = 0; }

  /** Rotate the whole view rigidly by a world rotation: focus and screen-up together, any latitude, any number of turns. */
  rotate(q: THREE.Quaternion) {
    this.f.applyQuaternion(q); this.fw.applyQuaternion(q); this.ortho();
    this.moved = true;
  }

  /** Grab: the planet point `grabbed` (unit vector) must appear where the pointer's ray now meets the planet (`hit`).
      Rotating the camera rigidly by q (hit → grabbed) brings it there. Returns the angle moved.
      `limit` caps the turn for this pointer move: towards the edge of the globe a pixel spans a steep slice of the
      sphere, and following it exactly would whip the planet round (several times the speed at the centre). When the
      cap applies the caller grabs afresh under the pointer, so nothing is owed and nothing snaps later. */
  grabTo(grabbed: THREE.Vector3, hit: THREE.Vector3, dt: number, limit = 0.35) {
    this.flight = null;
    const want = hit.angleTo(grabbed), angle = Math.min(want, limit, 0.35);
    this.capped = want > angle + 1e-9;
    if (angle < 1e-6) return 0;
    const axis = tmp.crossVectors(hit, grabbed);
    if (axis.lengthSq() < 1e-12) return 0;
    axis.normalize();
    this.rotate(new THREE.Quaternion().setFromAxisAngle(axis, angle));
    this.track(axis, angle, dt);
    return angle;
  }

  /** Screen-axis drag (pointer off the globe, keyboard): content follows the pointer, never the opposite way. */
  drag(dx: number, dy: number, height: number, camera: THREE.Camera, dt = 1 / 60) {
    this.flight = null;
    const k = this.angularPerPixel(height);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    // Drag right ⇒ the focus moves left (−dx about screen up); drag down ⇒ the focus moves up (−dy about screen right).
    const q = new THREE.Quaternion().setFromAxisAngle(screenUp, -dx * k).multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * k));
    const angle = 2 * Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));
    const axis = new THREE.Vector3(q.x, q.y, q.z);
    this.rotate(q);
    if (axis.lengthSq() > 1e-12 && angle > 1e-7) this.track(axis.normalize(), angle, dt);
  }
  /** Keep a smoothed angular velocity of the drag for the inertia that follows the release. */
  private track(axis: THREE.Vector3, angle: number, dt: number) {
    const rate = angle / Math.max(1 / 120, Math.min(dt, 0.1));
    const v = this.spinAxis.multiplyScalar(this.spinRate).lerp(axis.clone().multiplyScalar(rate), 0.5);
    this.spinRate = v.length(); if (this.spinRate > 1e-6) this.spinAxis.copy(v).divideScalar(this.spinRate); else this.spinAxis.set(0, 1, 0);
    this.spinRate = Math.min(this.spinRate, 4);
  }
  /** Pointer held still before release: no fling at all (the view stays exactly where the hand left it). */
  holdStill() { this.spinRate = 0; }
  /** Radians of planet per screen pixel at the centre of the view. */
  angularPerPixel(height: number) {
    const slant = this.alt / Math.max(0.35, Math.cos(this.tilt));
    return (2 * slant * HALF_FOV_TAN) / (height * this.radius) * (this.closeness > 0.5 ? 1 : 0.92);
  }
  turn(radians: number) { this.flight = null; this.fw.applyAxisAngle(this.f, -radians); this.ortho(); this.moved = true; }
  /** Zoom by a factor (<1 = closer); towards a direction on the planet when given (zoom to the pointer). */
  zoom(factor: number, toward?: THREE.Vector3 | null) {
    this.flight = null;
    const next = THREE.MathUtils.clamp(this.alt * factor, ALT_NEAR, this.farAlt);
    if (toward && next < this.alt) {
      const t = THREE.MathUtils.clamp((1 - next / this.alt) * 0.85, 0, 0.6);
      this.moveFocus(vTmp.copy(this.f).lerp(toward, t));
    }
    this.alt = next; this.moved = true;
  }

  /** Advance one frame and place the camera. Returns true while anything moved. */
  update(dt: number, camera: THREE.PerspectiveCamera, heightAt: (dir: THREE.Vector3) => number) {
    let moving = this.moved; this.moved = false;
    if (this.flight) {
      const fl = this.flight; fl.t = Math.min(1, fl.t + dt / fl.dur);
      const e = easeInOut(fl.t);
      const nf = new THREE.Vector3().copy(fl.f0).lerp(fl.f1, e).normalize();
      if (fl.f0.dot(fl.f1) < -0.98) {
        // Antipodal: go around any axis square to the start (the lerp passes through the centre).
        const ax = new THREE.Vector3().crossVectors(fl.f0, Math.abs(fl.f0.y) > 0.9 ? WORLD_Z : WORLD_Y).normalize();
        nf.copy(fl.f0).applyAxisAngle(ax, Math.PI * e);
      }
      this.moveFocus(nf);
      // Ease the carried screen-up towards the wanted heading at the destination; it is exact on arrival.
      const want = localFrame(this.f, fl.h1).fwd, left = Math.atan2(vTmp.crossVectors(this.fw, want).dot(this.f), this.fw.dot(want));
      const share = fl.t >= 1 ? 1 : THREE.MathUtils.clamp((e - fl.e) / Math.max(1e-4, 1 - fl.e), 0, 1);
      this.fw.applyAxisAngle(this.f, left * share); this.ortho(); fl.e = e;
      // Altitude: log-space blend with a lift over long distances.
      const base = Math.exp(THREE.MathUtils.lerp(Math.log(fl.a0), Math.log(fl.a1), e));
      this.alt = Math.max(base, base + (fl.peak - Math.max(fl.a0, fl.a1)) * Math.sin(Math.PI * e) * 0.9);
      if (fl.t >= 1) this.flight = null;
      moving = true;
    } else if (this.spinRate > 1e-4 && !this.held) {
      this.rotate(new THREE.Quaternion().setFromAxisAngle(this.spinAxis, this.spinRate * dt));
      this.spinRate *= Math.exp(-dt * 4.2);
      moving = true;
    }
    const target = heightAt(this.f);
    const g = this.ground + (target - this.ground) * Math.min(1, dt * 6);
    if (Math.abs(g - this.ground) > 1e-3) moving = true;
    this.ground = g;
    this.ortho();
    const U = up.copy(this.f), F = fwd.copy(this.fw);
    this.aspect = camera.aspect || this.aspect;
    const k = Math.pow(this.narrow, 0.75);
    const tilt = this.tilt, b = 1 - THREE.MathUtils.smoothstep(this.alt, 70 * k, 230 * k);
    const surface = tmp.copy(U).multiplyScalar(this.radius + Math.max(0, g));
    const slant = this.alt / Math.cos(tilt);
    camera.position.copy(surface).addScaledVector(U, Math.cos(tilt) * slant).addScaledVector(F, -Math.sin(tilt) * slant);
    const look = U.clone().multiplyScalar((this.radius + Math.max(0, g)) * b);
    camera.up.copy(U).multiplyScalar(Math.sin(tilt)).addScaledVector(F, Math.cos(tilt)).normalize();
    camera.lookAt(look);
    const dist = camera.position.length();
    camera.near = Math.max(0.3, (dist - this.radius - 16) * 0.2);
    camera.far = dist + this.radius * 3.4 + 1600;
    camera.updateProjectionMatrix();
    // How fast the view turns around the planet (for the ocean's inertia), smoothed.
    if (dt > 0 && this.lastCam.lengthSq() > 0) {
      const a = this.lastCam.clone().normalize(), c = camera.position.clone().normalize();
      const ax = new THREE.Vector3().crossVectors(a, c), s = ax.length();
      const w = s > 1e-9 ? ax.multiplyScalar(Math.asin(Math.min(1, s)) / s / dt) : ax.set(0, 0, 0);
      this.angular.lerp(w.clampLength(0, 6), 1 - Math.exp(-dt * 10));
    }
    this.lastCam.copy(camera.position);
    return moving;
  }
}
