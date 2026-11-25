/** A bounded, piecewise-linear motion clock. It requests motion; only the host moves a body. */
export interface RootMotionTrack {
  name: string;
  duration: number;
  times: readonly number[];
  positions: readonly number[];
  yaw: readonly number[];
  /** Predicted/annotated contacts, never evidence of physical support force. L, R per sample. */
  contacts?: readonly number[];
}
export interface RootPose { x: number; z: number; yaw: number }
export type MotionResult = 'playing' | 'blocked' | 'completed' | 'cancelled';

/** Validate imported metadata before it can own a character. No executable callbacks in assets. */
export function readRootMotion(value: unknown): RootMotionTrack | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as RootMotionTrack, n = v.times?.length;
  if (typeof v.name !== 'string' || v.name.length > 96 || !Array.isArray(v.times) || !n || n < 2 || n > 4096 ||
      !Array.isArray(v.positions) || v.positions.length !== n * 3 || !Array.isArray(v.yaw) || v.yaw.length !== n ||
      !Number.isFinite(v.duration) || v.duration <= 0 || v.duration > 120 || v.times[0] !== 0 || Math.abs(v.times[n - 1] - v.duration) > 1e-5) return null;
  if (![...v.times, ...v.positions, ...v.yaw].every(Number.isFinite)) return null;
  if (v.contacts && (!Array.isArray(v.contacts) || v.contacts.length !== n * 2 || !v.contacts.every(x => x === 0 || x === 1))) return null;
  if (Math.hypot(v.positions[0], v.positions[2], v.yaw[0]) > 1e-6) return null;
  for (let i = 0; i < n; i++) {
    if (Math.abs(v.positions[i * 3 + 1]) > 1e-6) return null;
    if (i && (v.times[i] <= v.times[i - 1] || Math.abs(v.yaw[i] - v.yaw[i - 1]) >= Math.PI)) return null;
  }
  return Object.freeze({ name: v.name, duration: v.duration, times: Object.freeze([...v.times]), positions: Object.freeze([...v.positions]), yaw: Object.freeze([...v.yaw]), ...(v.contacts ? { contacts: Object.freeze([...v.contacts]) } : {}) });
}

export class RootMotionClock {
  time = 0;
  blockedFor = 0;
  result: MotionResult = 'playing';
  private index = 0;
  constructor(readonly track: RootMotionTrack, readonly origin: RootPose, readonly scale: number) {
    if (![origin.x, origin.z, origin.yaw, scale].every(Number.isFinite) || scale <= 0) throw new Error('Invalid root frame');
  }
  pose(time = this.time): RootPose {
    const t = this.track; let i = this.index;
    while (i > 0 && t.times[i] > time) i--;
    while (i + 1 < t.times.length - 1 && t.times[i + 1] <= time) i++;
    const u = Math.max(0, Math.min(1, (time - t.times[i]) / (t.times[i + 1] - t.times[i])));
    const x = (t.positions[i * 3] + (t.positions[i * 3 + 3] - t.positions[i * 3]) * u) * this.scale;
    const z = (t.positions[i * 3 + 2] + (t.positions[i * 3 + 5] - t.positions[i * 3 + 2]) * u) * this.scale;
    const c = Math.cos(this.origin.yaw), s = Math.sin(this.origin.yaw);
    return { x: this.origin.x + c * x + s * z, z: this.origin.z - s * x + c * z, yaw: this.origin.yaw + t.yaw[i] + (t.yaw[i + 1] - t.yaw[i]) * u };
  }
  get contacts(): readonly [number, number] | null {
    const c = this.track.contacts; if (!c) return null;
    let i = this.index;
    while (i + 1 < this.track.times.length && this.track.times[i + 1] <= this.time) i++;
    return [c[i * 2], c[i * 2 + 1]];
  }
  /** The host returns the fraction it actually applied to BOTH translation and yaw. */
  advance(dt: number, move: (pose: RootPose) => number, reverse = false) {
    if (this.result === 'cancelled' || !Number.isFinite(dt) || dt <= 0) return;
    if (this.result === 'completed' && (!reverse || this.time === 0)) return;
    const budget = Math.min(dt, .05);
    const end = reverse ? Math.max(0, this.time - budget) : Math.min(this.track.duration, this.time + budget);
    let obstructed = false;
    // Never skip a corner in a root path, even when a render frame spans several samples.
    for (let steps = 0; steps < 32 && Math.abs(end - this.time) > 1e-10; steps++) {
      while (this.index + 1 < this.track.times.length - 1 && this.track.times[this.index + 1] <= this.time + 1e-10) this.index++;
      if (reverse) {
        while (this.index > 0 && this.track.times[this.index] >= this.time - 1e-10) this.index--;
      }
      const next = reverse ? Math.max(end, this.track.times[this.index]) : Math.min(end, this.track.times[this.index + 1]);
      const accepted = move(this.pose(next));
      const f = Number.isFinite(accepted) ? Math.max(0, Math.min(1, accepted)) : 0;
      this.time += (next - this.time) * f;
      if (f < 1 - 1e-9) { obstructed = true; break; }
    }
    this.blockedFor = obstructed ? this.blockedFor + budget : 0;
    const completed = reverse ? this.time <= 1e-9 : this.time >= this.track.duration - 1e-9;
    this.result = completed ? 'completed' : obstructed ? 'blocked' : 'playing';
    if (this.blockedFor >= .8 - 1e-9) this.cancel();
  }
  cancel() { if (this.result !== 'completed') this.result = 'cancelled'; }
}
