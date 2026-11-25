/**
 * What lies on a surface: dust that can be pushed, stains that have to be worked at, water that dries. One small grid per surface, the
 * same for a floor and a desk top. Pure numbers, no three.js, so the rules can be tested: sweeping only moves dust, a mop only takes what
 * it touches, and nothing changes where no tool went. A cell is about 9 cm on a floor; the fine edge seen on screen comes from noise in the
 * shader, which is why these values stay smooth and small to store.
 */

export interface Vec2 { x: number; z: number }

/** A cell holds this much dust at most: a heap. 1 is a thick grey film. */
export const DUST_HEAP = 6;

export class GrimeField {
  readonly dust: Float32Array;
  readonly stain: Float32Array;
  readonly wet: Float32Array;
  /** Goes up with every change: what is drawn from this looks at it, and sleeps while it stands still. */
  rev = 0;
  /** Goes up ONLY when `dust` changes so `LifeWorld.drawHeaps()` never rebuilds 460 dust clumps during water streams or drying. */
  dustRev = 0;
  /** Goes up when `dust` or `stain` changes so sweeping/scrubbing uploads at 0 ms latency while wetness-only updates throttle to <= 20 Hz. */
  solidRev = 0;
  /** Cells something stands on: dust settles around them, not under them. */
  readonly covered: Uint8Array;
  private wetCells = 0;

  constructor(readonly nx: number, readonly nz: number, readonly w: number, readonly d: number) {
    const n = nx * nz;
    this.dust = new Float32Array(n); this.stain = new Float32Array(n); this.wet = new Float32Array(n); this.covered = new Uint8Array(n);
  }
  get cell() { return Math.min(this.w / this.nx, this.d / this.nz); }
  private cx(x: number) { return (x / this.w + .5) * this.nx - .5; }
  private cz(z: number) { return (z / this.d + .5) * this.nz - .5; }
  at(i: number, k: number) { return k * this.nx + i; }
  inside(i: number, k: number) { return i >= 0 && k >= 0 && i < this.nx && k < this.nz; }
  /** What is under a point, bilinear (what the shader shows). */
  sample(c: 'dust' | 'stain' | 'wet', x: number, z: number) {
    const a = this[c], fx = this.cx(x), fz = this.cz(z), i = Math.floor(fx), k = Math.floor(fz), u = fx - i, v = fz - k;
    const g = (ii: number, kk: number) => a[this.at(Math.max(0, Math.min(this.nx - 1, ii)), Math.max(0, Math.min(this.nz - 1, kk)))];
    return (g(i, k) * (1 - u) + g(i + 1, k) * u) * (1 - v) + (g(i, k + 1) * (1 - u) + g(i + 1, k + 1) * u) * v;
  }
  total(c: 'dust' | 'stain' | 'wet') { let s = 0; const a = this[c]; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
  /** Square metres with at least this much on them. */
  area(c: 'dust' | 'stain' | 'wet', over = .12) { let n = 0; const a = this[c]; for (let i = 0; i < a.length; i++) if (a[i] > over) n++; return n * (this.w / this.nx) * (this.d / this.nz); }
  get wetting() { return this.wetCells > 0; }

  /** A soft round mark: a spill, a stain, a drip. */
  stamp(c: 'dust' | 'stain' | 'wet', x: number, z: number, radius: number, amount: number, cap = 1) {
    const a = this[c], cell = this.cell, r = Math.max(1, radius / cell), fx = this.cx(x), fz = this.cz(z);
    for (let k = Math.floor(fz - r); k <= Math.ceil(fz + r); k++) for (let i = Math.floor(fx - r); i <= Math.ceil(fx + r); i++) {
      if (!this.inside(i, k)) continue;
      const d = Math.hypot(i - fx, k - fz) / r;
      if (d >= 1) continue;
      const at = this.at(i, k), add = amount * (1 - d * d);
      if (a[at] < cap) a[at] = Math.min(cap, a[at] + add);
    }
    if (c === 'wet') {
      this.wetCells = 1;
    } else {
      this.solidRev++;
      if (c === 'dust') this.dustRev++;
    }
    this.rev++;
  }

  /** Cells of a head `width` across and `depth` along its way, centred on `p`, turned to `dir`. */
  private footprint(p: Vec2, dir: Vec2, width: number, depth: number, each: (at: number, along: number, across: number, i: number, k: number) => void) {
    const cell = this.cell, reach = Math.hypot(width, depth) / 2 + cell, fx = this.cx(p.x), fz = this.cz(p.z), r = Math.ceil(reach / cell);
    const sx = this.w / this.nx, sz = this.d / this.nz;
    for (let k = Math.floor(fz - r); k <= Math.ceil(fz + r); k++) for (let i = Math.floor(fx - r); i <= Math.ceil(fx + r); i++) {
      if (!this.inside(i, k)) continue;
      const dx = (i - fx) * sx, dz = (k - fz) * sz, along = dx * dir.x + dz * dir.z, across = -dx * dir.z + dz * dir.x;
      if (Math.abs(along) <= depth / 2 + cell * .5 && Math.abs(across) <= width / 2 + cell * .5) each(this.at(i, k), along, across, i, k);
    }
  }

  /**
   * A broom going from `from` to `to`. Dust under the head goes ahead of it, the way a plough does, and is left where the stroke ends: a heap. None of
   * it disappears: a little goes round the ends of the head, the rest stays in front. Returns how much was moved.
   */
  sweep(from: Vec2, to: Vec2, width: number, strength = .62): number {
    const dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, dz);
    if (len < 1e-4) return 0;
    const dir = { x: dx / len, z: dz / len }, step = this.cell * .8, n = Math.min(40, Math.ceil(len / step));
    let moved = 0;
    const depth = this.cell * 1.6;
    for (let s = 1; s <= n; s++) {
      const p = { x: from.x + dir.x * len * s / n, z: from.z + dir.z * len * s / n };
      const cells: { at: number; along: number; across: number; i: number; k: number }[] = [];
      this.footprint(p, dir, width, depth, (at, along, across, i, k) => { if (this.dust[at] > 1e-4) cells.push({ at, along, across, i, k }); });
      // The front ones first: what is carried from behind lands on cells that have already given theirs.
      cells.sort((a, b) => b.along - a.along);
      for (const c of cells) {
        const take = this.dust[c.at] * Math.min(1, strength * Math.min(1, len / n / step + .35));
        if (take < 1e-5) continue;
        const ti = Math.round(c.i + dir.x * 1.2), tk = Math.round(c.k + dir.z * 1.2);
        if (!this.inside(ti, tk)) continue;                                              // A wall: it stays against the wall.
        const to1 = this.at(ti, tk);
        if (this.dust[to1] + take > DUST_HEAP) continue;
        const edge = Math.abs(c.across) > width * .44;
        const leakI = Math.round(c.i + (edge ? -dir.z * Math.sign(c.across) : 0)), leakK = Math.round(c.k + (edge ? dir.x * Math.sign(c.across) : 0));
        const leak = edge && this.inside(leakI, leakK) && this.at(leakI, leakK) !== c.at ? take * .1 : 0;
        this.dust[c.at] -= take;
        this.dust[to1] += take - leak;
        if (leak) this.dust[this.at(leakI, leakK)] += leak;
        moved += take;
      }
    }
    if (moved > 0) {
      this.rev++;
      this.dustRev++;
      this.solidRev++;
    }
    return moved;
  }

  /** A dustpan on the floor: what is under its lip comes into it, up to what it can still hold. Returns what it took. */
  scoop(p: Vec2, dir: Vec2, width: number, depth: number, room: number): number {
    if (room <= 0) return 0;
    let took = 0;
    this.footprint(p, dir, width, depth, at => {
      if (room - took <= 0 || this.dust[at] <= 0) return;
      const t = Math.min(this.dust[at], room - took);
      this.dust[at] -= t; took += t;
    });
    if (took > 0) {
      this.rev++;
      this.dustRev++;
      this.solidRev++;
    }
    return took;
  }

  /**
   * A mop or a damp cloth. It takes what it touches into itself and leaves water; how much depends on how wet it is and how dirty it has become. A dirty
   * one starts putting back what it took: that is the streak, and the reason to rinse.
   */
  mop(from: Vec2, to: Vec2, width: number, depth: number, tool: { wet: number; load: number }, pressure = 1, wetsFloor = true): number {
    const dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, dz);
    if (len < 1e-4) return 0;
    const dir = { x: dx / len, z: dz / len }, step = this.cell * .8, n = Math.min(40, Math.ceil(len / step));
    let took = 0;
    let dustChanged = false;
    let solidChanged = false;
    for (let s = 1; s <= n; s++) {
      const p = { x: from.x + dir.x * len * s / n, z: from.z + dir.z * len * s / n };
      const work = (.2 + .8 * Math.min(1, tool.wet / .5)) * (1 - tool.load * .85) * pressure * (len / n) / step;
      this.footprint(p, dir, width, depth, at => {
        const d = this.dust[at] * Math.min(1, .55 * work), st = this.stain[at] * Math.min(1, .16 * work);
        this.dust[at] -= d; this.stain[at] -= st;
        if (d > 1e-6) { dustChanged = true; solidChanged = true; }
        if (st > 1e-6) solidChanged = true;
        const taken = d + st * 1.6;
        took += taken;
        tool.load = Math.min(1, tool.load + taken * .022);
        if (tool.load > .62) {
          // A dirty head is a brush of dirty water.
          const back = (tool.load - .62) * .03 * (len / n) / step;
          this.stain[at] = Math.min(1, this.stain[at] + back * .7);
          this.dust[at] = Math.min(DUST_HEAP, this.dust[at] + back * .3);
          if (back > 0) { dustChanged = true; solidChanged = true; }
        }
        if (wetsFloor && tool.wet > .05) {
          const leave = .28 + tool.wet * .72;
          if (this.wet[at] < leave) { this.wet[at] = Math.min(leave, this.wet[at] + .34 * work + .18); this.wetCells = 1; }
        }
      });
      tool.wet = Math.max(0, tool.wet - width * depth * .018 * (len / n) / step);
    }
    if (dustChanged) this.dustRev++;
    if (solidChanged) this.solidRev++;
    this.rev++;
    return took;
  }

  /** A dry cloth or a duster over a surface. Returns what it lifted. `keep` of that stays on the tool; the rest is in the air, and comes down below. */
  dustOff(from: Vec2, to: Vec2, width: number, depth: number, rate = .7): number {
    const dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, dz);
    if (len < 1e-4) return 0;
    const dir = { x: dx / len, z: dz / len }, step = this.cell * .8, n = Math.min(30, Math.ceil(len / step));
    let took = 0;
    for (let s = 1; s <= n; s++) {
      const p = { x: from.x + dir.x * len * s / n, z: from.z + dir.z * len * s / n };
      const k = Math.min(1, rate * (len / n) / step);
      this.footprint(p, dir, width, depth, at => { const t = this.dust[at] * k; this.dust[at] -= t; took += t; });
    }
    if (took > 0) {
      this.rev++;
      this.dustRev++;
      this.solidRev++;
    }
    return took;
  }

  /** Water dries; quicker with air moving. Asleep when nothing is wet: no work at all on a dry room. */
  dry(seconds: number, perSecond: number) {
    if (!this.wetCells) return false;
    const a = this.wet, dr = perSecond * seconds;
    let left = 0;
    for (let i = 0; i < a.length; i++) if (a[i] > 0) { a[i] = Math.max(0, a[i] - dr); if (a[i] > 0) left++; }
    this.wetCells = left;
    this.rev++;
    return true;
  }
  markWet() { this.wetCells = 1; }

  /** How dusty, 0..1: a whole floor under a thick film is 1. A heap does not make the rest of the room dirty. */
  dustIndex() { let s = 0, n = 0; const a = this.dust; for (let i = 0; i < a.length; i++) { if (this.covered[i]) continue; s += Math.min(1, a[i]); n++; } return n ? s / n : 0; }

  /** One heap to point at: where most dust lies together. Null when it is spread thin. */
  heap(): { x: number; z: number; amount: number } | null {
    let most = 0;
    for (let i = 0; i < this.dust.length; i++) if (this.dust[i] > most) most = this.dust[i];
    if (most < 1) return null;
    // A heap is dust gathered in one place: the 5 × 5 cells holding the most of it, not the single fullest cell. That stays the same place after
    // the record has been stored and read back (stored dust is rounded, and two cells of a heap may swap which is fullest).
    const nx = this.nx, nz = this.nz, S = new Float64Array((nx + 1) * (nz + 1));
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) S[(z + 1) * (nx + 1) + x + 1] = this.dust[this.at(x, z)] + S[z * (nx + 1) + x + 1] + S[(z + 1) * (nx + 1) + x] - S[z * (nx + 1) + x];
    const box = (x0: number, z0: number, x1: number, z1: number) => S[z1 * (nx + 1) + x1] - S[z0 * (nx + 1) + x1] - S[z1 * (nx + 1) + x0] + S[z0 * (nx + 1) + x0];
    let amount = -1, bi = 0, bk = 0;
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const a = box(Math.max(0, i - 2), Math.max(0, k - 2), Math.min(nx, i + 3), Math.min(nz, k + 3));
      if (a > amount + 1e-9) { amount = a; bi = i; bk = k; }
    }
    return { x: (bi + .5) / nx * this.w - this.w / 2, z: (bk + .5) / nz * this.d - this.d / 2, amount };
  }

  encode(): GrimeRecord {
    return { n: [this.nx, this.nz], d: packChannel(this.dust, dustToUnit), s: packChannel(this.stain, v => v), w: packChannel(this.wet, v => v) };
  }
  static decode(rec: GrimeRecord | undefined, nx: number, nz: number, w: number, d: number): GrimeField {
    const f = new GrimeField(nx, nz, w, d);
    if (!rec || rec.n?.[0] !== nx || rec.n?.[1] !== nz) return f;
    unpackChannel(rec.d, f.dust, dustFromUnit);
    unpackChannel(rec.s, f.stain, q => q);
    unpackChannel(rec.w, f.wet, q => q);
    for (let i = 0; i < f.wet.length; i++) if (f.wet[i] > 0) { f.wetCells = 1; break; }
    return f;
  }
}

export interface GrimeRecord { n: [number, number]; d: string; s: string; w: string }

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LEVELS = 31;
/** 32 levels. A cell alone is one character; a longer run adds its length, so smooth fields stay small and noisy ones cost a character a cell at worst. */
function packChannel(a: Float32Array, toUnit: (v: number) => number): string {
  let out = '', i = 0;
  const q = (v: number) => Math.max(0, Math.min(LEVELS, Math.round(toUnit(v) * LEVELS)));
  while (i < a.length) {
    const level = q(a[i]);
    let run = 1;
    while (i + run < a.length && run < 4096 && q(a[i + run]) === level) run++;
    if (run === 1) out += ALPHABET[level * 2];
    else if (run <= 64) out += ALPHABET[level * 2 + 1] + ALPHABET[run - 2];
    else out += ALPHABET[level * 2 + 1] + ALPHABET[63] + ALPHABET[(run - 65) >> 6] + ALPHABET[(run - 65) & 63];
    i += run;
  }
  return out;
}
function unpackChannel(s: string | undefined, a: Float32Array, fromUnit: (q: number) => number) {
  if (typeof s !== 'string') return;
  let i = 0, at = 0;
  while (at < s.length && i < a.length) {
    const c = ALPHABET.indexOf(s[at++]);
    if (c < 0) return;
    const level = c >> 1;
    let run = 1;
    if (c & 1) {
      const r = ALPHABET.indexOf(s[at++]);
      if (r < 0) return;
      if (r < 63) run = r + 2;
      else { const hi = ALPHABET.indexOf(s[at++]), lo = ALPHABET.indexOf(s[at++]); if (hi < 0 || lo < 0) return; run = (hi << 6) + lo + 65; }
    }
    const v = level ? fromUnit(level / LEVELS) : 0;
    for (let n = 0; n < run && i < a.length; n++) a[i++] = v;
  }
}
/** Dust is mostly a thin film and now and then a heap: fine steps up to a thick layer, coarse ones above that. */
const THIN = .64, THIN_SHARE = 24 / 31;
const dustToUnit = (v: number) => v <= THIN ? v / THIN * THIN_SHARE : THIN_SHARE + (1 - THIN_SHARE) * Math.sqrt(Math.min(1, (v - THIN) / (DUST_HEAP - THIN)));
const dustFromUnit = (q: number) => q <= THIN_SHARE ? q / THIN_SHARE * THIN : THIN + (DUST_HEAP - THIN) * ((q - THIN_SHARE) / (1 - THIN_SHARE)) ** 2;

/** Soft, slow variation over a surface, the same for a surface every time it is asked. */
function softNoise(x: number, z: number, seed: number) {
  const s = (a: number, b: number) => { const h = Math.sin(a * 127.1 + b * 311.7 + seed * 74.7) * 43758.5453; return h - Math.floor(h); };
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  return (s(ix, iz) * (1 - u) + s(ix + 1, iz) * u) * (1 - v) + (s(ix, iz + 1) * (1 - u) + s(ix + 1, iz + 1) * u) * v;
}

/**
 * Time passing over a surface: dust comes down, more along the walls and in corners, none under what stands there, and it slows as it builds: a room left for
 * a month is not filthier than one left for two weeks. `days` of it are added towards `cap`.
 */
export function settleDust(f: GrimeField, days: number, perDay: number, cap: number, seed: number, wallsMatter: boolean) {
  if (days <= 0 || cap <= 0) return;
  const k = 1 - Math.exp(-days * perDay / Math.max(.001, cap));
  for (let z = 0; z < f.nz; z++) for (let x = 0; x < f.nx; x++) {
    const at = f.at(x, z);
    if (f.covered[at]) continue;
    const nx = (x + .5) / f.nx, nz = (z + .5) / f.nz;
    const edge = wallsMatter ? Math.max(0, 1 - Math.min(nx, 1 - nx, nz, 1 - nz) * 5) : 0;
    const shape = (.62 + .76 * softNoise(nx * 5.5, nz * 5.5, seed)) * (1 + edge * .85);
    const target = cap * shape;
    if (f.dust[at] < target) f.dust[at] += (target - f.dust[at]) * k;
  }
  f.rev++;
  f.dustRev++;
  f.solidRev++;
}
