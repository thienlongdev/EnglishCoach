/** Time-independent damped spring. Retargeting changes only the destination, never position or velocity. */
export interface SpringSpec { stiffness: number; damping: number; mass: number; precision: number }
export interface SpringValue { position: number; velocity: number }

export function stepSpring(state: SpringValue, target: number, seconds: number, spec: SpringSpec): SpringValue {
  const t = Math.max(0, seconds);
  const w = Math.sqrt(spec.stiffness / spec.mass);
  const z = spec.damping / (2 * Math.sqrt(spec.stiffness * spec.mass));
  const x = state.position - target, v = state.velocity;
  if (z < 1 - 1e-5) {
    const wd = w * Math.sqrt(1 - z * z), decay = Math.exp(-z * w * t);
    const b = (v + z * w * x) / wd, c = Math.cos(wd * t), s = Math.sin(wd * t);
    const y = x * c + b * s;
    return { position: target + decay * y, velocity: decay * (-z * w * y + wd * (-x * s + b * c)) };
  }
  if (z > 1 + 1e-5) {
    const root = Math.sqrt(z * z - 1), r1 = -w * (z - root), r2 = -w * (z + root);
    const a = (v - r2 * x) / (r1 - r2), b = x - a;
    return { position: target + a * Math.exp(r1 * t) + b * Math.exp(r2 * t), velocity: a * r1 * Math.exp(r1 * t) + b * r2 * Math.exp(r2 * t) };
  }
  const decay = Math.exp(-w * t), b = v + w * x;
  return { position: target + (x + b * t) * decay, velocity: (v - w * b * t) * decay };
}

export class Spring {
  state: SpringValue[];
  target: number[];
  private frame = 0;
  private last = 0;
  private done: (() => void) | undefined;
  constructor(initial: number[], private spec: SpringSpec, private paint: (values: number[]) => void) {
    this.state = initial.map(position => ({ position, velocity: 0 }));
    this.target = [...initial];
  }
  get values(): number[] { return this.state.map(s => s.position); }
  retarget(target: number[], done?: () => void): void {
    this.target = [...target]; this.done = done;
    if (!this.frame) { this.last = performance.now(); this.frame = requestAnimationFrame(this.tick); }
  }
  /** Direct manipulation: the next spring starts with the release velocity. */
  set(values: number[], velocity = values.map(() => 0)): void {
    this.stop();
    this.state = values.map((position, i) => ({ position, velocity: velocity[i] || 0 }));
    this.paint(values);
  }
  stop(): void { cancelAnimationFrame(this.frame); this.frame = 0; this.done = undefined; }
  private tick = (now: number) => {
    this.frame = 0;
    const dt = Math.max(0, (now - this.last) / 1000); this.last = now;
    this.state = this.state.map((s, i) => stepSpring(s, this.target[i], dt, this.spec));
    const settled = this.state.every((s, i) => Math.abs(s.position - this.target[i]) <= this.spec.precision && Math.abs(s.velocity) <= this.spec.precision * 10);
    if (settled) this.state = this.target.map(position => ({ position, velocity: 0 }));
    this.paint(this.values);
    if (settled) { const done = this.done; this.done = undefined; done?.(); }
    else this.frame = requestAnimationFrame(this.tick);
  };
}
