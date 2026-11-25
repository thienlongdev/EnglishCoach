/**
 * Multiplayer timing for Echo Quiz Rush (course version 6+). Pure — no DOM, no three.js — so `scripts/test-echo-quiz-rush.mjs`
 * can check it. Three pieces:
 *
 * - RaceClock: the authority's race clock estimated from snapshots. The freshest sample (the smallest delay) wins at once;
 *   a persistently slower path is adopted only gradually, so the estimate is continuous and never steps backward under
 *   ordinary jitter. The local simulation runs at this clock plus the time an input needs to reach the server, so a key
 *   pressed now is applied by the server at the same race time the browser applied it.
 * - InputHistory: what this racer actually held at each simulated step, plus the one-shot actions (jump, dodge, dash,
 *   Echo Rush) with their race time. An authoritative snapshot is from the past; replaying this history over it gives the
 *   present state the server will confirm — instead of re-applying the keys held now to the whole gap (which pulled the
 *   runner back on every snapshot).
 * - RivalBuffer: rivals are drawn a fixed delay behind the estimated server clock and interpolated between the two
 *   snapshots around that moment by their server times (not by arrival times, which jitter), so their motion is even.
 * - InputLead + SimClock (2026-10-26): how far the local runner simulates ahead of the snapshot timeline is MEASURED
 *   (the race time the server stamps on this racer's latest input against the timeline time it was sent at), and the
 *   prediction clock follows that target continuously — a little faster or slower, never backward, never standing still.
 *   A round-trip estimate used to enter the clock twice, so an improving estimate (1283 → 385 → 201 ms at a page load)
 *   rewound the prediction by up to a second: the runner snapped back while W was held.
 */
export const STEP = 1 / 120;

export class RaceClock {
  private offset: number | null = null;
  private lastNow = 0;
  /** Seconds per second a sample may be later than the best one before the estimate starts to follow it. */
  static readonly RELAX = .005;
  /** A path this much slower than the estimate is adopted at once (a reconnect, a changed route). */
  static readonly RESET = .3;
  get ready() { return this.offset !== null; }
  /** `now` in ms (performance.now), `elapsed` the snapshot's race seconds, `oneWay` the estimated one-way delay (s). */
  sample(now: number, elapsed: number, oneWay: number) {
    this.relax(now);
    const o = now / 1000 - (elapsed + oneWay);
    if (this.offset === null || o < this.offset || o - this.offset > RaceClock.RESET) this.offset = o;
  }
  private relax(now: number) {
    if (this.offset !== null && now > this.lastNow) this.offset += (now - this.lastNow) / 1000 * RaceClock.RELAX;
    this.lastNow = Math.max(this.lastNow, now);
  }
  /** Estimated authority race time at `now` (ms), or null before the first snapshot. */
  now(now: number) { if (this.offset === null) return null; this.relax(now); return now / 1000 - this.offset; }
  /** The same estimate for an earlier moment `at` (ms) with the current offset (no relaxation side effect). */
  at(at: number) { return this.offset === null ? null : at / 1000 - this.offset; }
}

/**
 * The lead the local simulation needs over the snapshot timeline, measured from the racer's own inputs: the server's
 * snapshot reports the race time it applied this racer's latest input from (`inputAt` + one step), the client knows when
 * that input left (on the snapshot timeline). lead = applied − sent. The median of recent samples follows real latency, the server's
 * tick quantisation and its queueing, and is immune to an inflated first ping. Before enough samples: `fallback`.
 */
export class InputLead {
  private samples: number[] = []; private seen = -1;
  static readonly KEEP = 21; static readonly MIN = 5;
  /**
   * A snapshot: the server applied this racer's input `seq` from race time `appliedAt` (s); it left at snapshot-timeline
   * time `sentAt` (s, null when unknown — sent before a reload). Each seq counts once.
   */
  observe(seq: number, appliedAt: number, sentAt: number | null) {
    // Race time is negative during the countdown (−3 → 0): those leases count, so the lead is known before anyone runs.
    if (!(seq > this.seen) || !(appliedAt > -50) || sentAt === null) return; this.seen = seq;
    this.samples.push(appliedAt - sentAt); if (this.samples.length > InputLead.KEEP) this.samples.shift();
  }
  get measured() { return this.samples.length >= InputLead.MIN; }
  value(fallback: number) {
    if (!this.measured) return fallback;
    const sorted = [...this.samples].sort((a, b) => a - b); return Math.max(.005, Math.min(1.2, sorted[sorted.length >> 1]));
  }
  /** A new match / connection: the old samples describe another path. */
  reset() { this.samples = []; this.seen = -1; }
}

/**
 * The prediction's race clock: it follows `target` (snapshot timeline + lead) at a rate between 1 − SLEW and 1 + SLEW, so
 * a changed estimate is absorbed as a slightly slower or faster runner, never as a rewind (the runner snapping back) or a
 * stop (running in place). It jumps only while nothing moves (`free`: the countdown) or across a real discontinuity
 * (≥ SNAP: a reconnect, a long server stall), where the authority's correction is the truth anyway.
 */
export class SimClock {
  private t: number | null = null; private at = 0;
  static readonly SLEW = .12; static readonly GAIN = 2.5; static readonly SNAP = 1;
  /** Clock value at `now` (ms); idempotent for the same `now`. */
  advance(now: number, target: number | null, free: boolean) {
    if (target === null) return this.t;
    if (this.t !== null && now === this.at) return this.t;
    const projected = this.t === null ? target : this.t + Math.max(0, now - this.at) / 1000;
    const error = target - projected;
    if (this.t === null || free || Math.abs(error) >= SimClock.SNAP) this.t = target;
    else this.t += Math.max(0, now - this.at) / 1000 * (1 + Math.max(-SimClock.SLEW, Math.min(SimClock.SLEW, error * SimClock.GAIN)));
    this.at = now; return this.t;
  }
  get value() { return this.t; }
}

/**
 * Facing of a runner (version 6+): toward its velocity (scene units / s) while it runs, back toward the wall while it
 * stands at one; otherwise held. Always the short way, always in (−π, π]. Remote runners use their snapshot-segment
 * velocity, never frame-to-frame position deltas (an extrapolation that overshot a stop and was pulled back used to read
 * as a step backward and swung the rival round).
 */
export function faceHeading(heading: number, sx: number, sz: number, phase: string, dt: number, rate: number) {
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  if (Math.hypot(sx, sz) > .35 && (phase === 'RUNNING' || phase === 'FINISHING')) return wrap(heading + wrap(-Math.atan2(sx, sz) - heading) * (1 - Math.exp(-dt * rate)));
  if (phase === 'VALIDATING' || phase === 'OPENING' || phase === 'STUMBLE') return wrap(heading) * Math.exp(-dt * 8);
  return wrap(heading);
}

export interface HeldInput { horizontal: number; forward: number; sprint: boolean }
interface Shot { t: number; seq: number; dir: number; wall: number }

export class InputHistory {
  private held: (HeldInput & { t: number })[] = [];
  private jumps: Shot[] = []; private dodges: Shot[] = []; private dashes: Shot[] = []; private rushes: Shot[] = [];
  /** The input used for the step that ends at race time t. */
  record(t: number, input: HeldInput) {
    // The race clock may be re-estimated backward: steps recorded for times not reached yet are replaced.
    while (this.held.length > 1 && this.held[this.held.length - 1].t >= t) this.held.pop();
    const last = this.held.at(-1);
    if (last && last.horizontal === input.horizontal && last.forward === input.forward && last.sprint === input.sprint && t > last.t) return;
    this.held.push({ t, horizontal: input.horizontal, forward: input.forward, sprint: input.sprint });
    this.prune(t);
  }
  private prune(t: number) {
    const cut = t - 3; let i = 0; while (i < this.held.length - 1 && this.held[i + 1].t <= cut) i++;
    if (i) this.held.splice(0, i);
    for (const list of [this.jumps, this.dodges, this.dashes, this.rushes]) while (list.length && list[0].t < cut) list.shift();
  }
  /** What was held for the step ending at t (the latest record at or before t; the first record before any). */
  at(t: number): HeldInput {
    for (let i = this.held.length - 1; i >= 0; i--) if (this.held[i].t <= t + 1e-9) return this.held[i];
    return this.held[0] ?? { horizontal: 0, forward: 0, sprint: false };
  }
  jump(t: number, seq: number, wall: number) { this.jumps.push({ t, seq, dir: 0, wall }); }
  dodge(t: number, seq: number, dir: number, wall: number) { this.dodges.push({ t, seq, dir, wall }); }
  dash(t: number, wall: number) { this.dashes.push({ t, seq: 0, dir: 0, wall }); }
  rush(t: number, wall: number) { this.rushes.push({ t, seq: 0, dir: 0, wall }); }
  /**
   * A one-shot action to replay in the step (t0, t1]: one the authority has not applied yet (its counter is above the
   * acknowledged one) that was pressed in this step — or earlier, if this is the first replayed step (its message is
   * still on the way, so the server will apply it from now).
   */
  private due(list: Shot[], t0: number, t1: number, first: boolean, pending: (s: Shot) => boolean) {
    for (const s of list) if (pending(s) && (s.t > t0 + 1e-9 ? s.t <= t1 + 1e-9 : first)) return s;
    return null;
  }
  jumpDue(t0: number, t1: number, first: boolean, acked: number) { return !!this.due(this.jumps, t0, t1, first, s => s.seq > acked); }
  dodgeDue(t0: number, t1: number, first: boolean, acked: number) { return this.due(this.dodges, t0, t1, first, s => s.seq > acked); }
  /** A dash / rush is pending while the snapshot shows none happened and the request is recent (a refusal expires). */
  dashDue(t0: number, t1: number, first: boolean, applied: boolean, wallNow: number) { return !applied && !!this.due(this.dashes, t0, t1, first, s => wallNow - s.wall < 700); }
  rushDue(t0: number, t1: number, first: boolean, applied: boolean, wallNow: number) { return !applied && !!this.due(this.rushes, t0, t1, first, s => wallNow - s.wall < 700); }
}

export interface RivalSample { e: number; x: number; y: number; z: number; vz: number; phase: string }
export interface RivalPose { x: number; y: number; z: number; vx: number; vy: number; phase: string; extrapolated: boolean }

export class RivalBuffer {
  private samples = new Map<string, RivalSample[]>();
  /** Snapshots taken at race time `e` (ignored when not newer than the last one of that rival). */
  push(id: string, s: RivalSample) {
    let list = this.samples.get(id); if (!list) { list = []; this.samples.set(id, list); }
    const last = list.at(-1); if (last && s.e <= last.e + 1e-6) { if (last && Math.abs(s.e - last.e) < 1e-6) list[list.length - 1] = s; return; }
    list.push(s); while (list.length > 24) list.shift();
  }
  forget(keep: Set<string>) { for (const id of [...this.samples.keys()]) if (!keep.has(id)) this.samples.delete(id); }
  /**
   * Pose at race time `rt`: linear in x / y between the two snapshots around it (by server time), Hermite in height with
   * the reported vertical speed (a jump stays a smooth arc). A jump of more than `teleport` units (a respawn, a swap) is
   * never blended. Past the newest snapshot the pose extrapolates for at most `extrapolate` seconds, then holds.
   */
  pose(id: string, rt: number, teleport = 160, extrapolate = .12): RivalPose | null {
    const list = this.samples.get(id); if (!list?.length) return null;
    const newest = list[list.length - 1];
    if (rt >= newest.e) {
      const prev = list.length > 1 ? list[list.length - 2] : null, span = prev ? newest.e - prev.e : 0;
      const vx = prev && span > 0 ? (newest.x - prev.x) / span : 0, vy = prev && span > 0 ? (newest.y - prev.y) / span : 0;
      const moving = prev && Math.hypot(newest.x - prev.x, newest.y - prev.y) < teleport && newest.phase === prev.phase;
      const ahead = moving ? Math.min(rt - newest.e, extrapolate) : 0;
      return { x: newest.x + vx * ahead, y: newest.y + vy * ahead, z: newest.z, vx: moving ? vx : 0, vy: moving ? vy : 0, phase: newest.phase, extrapolated: rt > newest.e };
    }
    let b = list.length - 1; while (b > 0 && list[b - 1].e > rt) b--;
    if (b === 0) { const s = list[0]; return { x: s.x, y: s.y, z: s.z, vx: 0, vy: 0, phase: s.phase, extrapolated: false }; }
    const a = list[b - 1], s1 = list[b], span = s1.e - a.e, u = span > 0 ? (rt - a.e) / span : 1;
    if (Math.hypot(s1.x - a.x, s1.y - a.y) > teleport) { const s = u < .5 ? a : s1; return { x: s.x, y: s.y, z: s.z, vx: 0, vy: 0, phase: s.phase, extrapolated: false }; }
    const u2 = u * u, u3 = u2 * u, h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    const z = Math.max(-400, h00 * a.z + h10 * span * a.vz + h01 * s1.z + h11 * span * s1.vz);
    return { x: a.x + (s1.x - a.x) * u, y: a.y + (s1.y - a.y) * u, z, vx: (s1.x - a.x) / span, vy: (s1.y - a.y) / span, phase: u < .5 ? a.phase : s1.phase, extrapolated: false };
  }
}
