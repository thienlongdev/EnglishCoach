/**
 * Course version 5 ("Skybound Trials") — the browser mirror of RushTrials.java. Pure and deterministic: hazards are
 * closed-form functions of the race clock and the server's plan, so prediction, Solo simulation and the renderer all
 * agree with the authority. Constants are compared with the Java source by `scripts/test-echo-quiz-rush.mjs`.
 * Units: x lateral 50–950, y forward, z height (x's scale). Contact is measured in scene units (x × .01, y × .02, z × .01).
 */
export const TRIALS = {
  version: 5, base: 212, sprint: 280, dash: 410, dashTime: .25, rush: 320, lateral: 470,
  jumpSpeed: 390, gravity: 1080, jumpBuffer: .15, jumpRecover: .15,
  dodgeSpeed: 1050, dodgeTime: .16, dodgeCooldown: 1.4,
  knockTime: .55, hitGuard: 1.6, fallTime: 1.0, respawnGuard: 1.4, respawnBack: 120,
  readPerWord: 85, readBase: 1270, readMin: 1800, readMax: 4450, leadIn: 300, runout: 320,
  riseZone: 720, riseWait: 2.6, riseRate: 57, sillMax: 120, sillStep: 6, dropTime: .8, rearm: 1.2,
  kx: .01, ky: .02, rs: .28, runnerHeight: 1.45,
} as const;
export const LANES = [200, 500, 800] as const;
/** Version 5 kinds plus the version 6 and 7 additions (rushReforged.ts). Tier 4 exists only on version 6+ courses, 5–6 on version 7. */
export type HazardKind = 'MILL' | 'RAMS' | 'BOULDERS' | 'SKYFALL' | 'CHASM' | 'SAWS' | 'CRUSHER' | 'GALE' | 'CRUMBLE' | 'DRIFT' | 'BEAM' | 'STEPS' | 'TILT' | 'ROLLER';
export interface Hazard { kind: HazardKind; checkpoint: number; from: number; to: number; tier: number; phase: number; dir: number; lane: number; salt: number }
export interface Hit { vx: number; vy: number }

const { kx: KX, ky: KY, rs: RS } = TRIALS;
export const apex = () => TRIALS.jumpSpeed * TRIALS.jumpSpeed / (2 * TRIALS.gravity);
export const hazardLength = (kind: HazardKind, tier: number) => kind === 'MILL' ? 620 : kind === 'RAMS' ? 880 : kind === 'BOULDERS' ? 1500 : kind === 'SKYFALL' ? (tier === 1 ? 1000 : 1300) : kind === 'CHASM' ? 520 : 0;
export const hazardFor = (hazards: Hazard[] | undefined, checkpoint: number) => hazards?.find(h => h.checkpoint === checkpoint) ?? null;
export const isRising = (rising: boolean[] | undefined, checkpoint: number) => !!rising && checkpoint >= 0 && checkpoint < rising.length && rising[checkpoint] === true;
/** Murmur3 finaliser, identical to Java's 32-bit int arithmetic. */
export function mix(h: number) { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h | 0; }
const floorMod = (a: number, n: number) => ((a % n) + n) % n;
const side = (v: number, fallback: number) => v > 0 ? 1 : v < 0 ? -1 : fallback;

export function hit(h: Hazard | null, t: number, x: number, y: number, z: number): Hit | null {
  if (!h || y < h.from - 120 || y > h.to + 120) return null;
  switch (h.kind) { case 'MILL': return millHit(h, t, x, y, z); case 'RAMS': return ramsHit(h, t, x, y, z); case 'BOULDERS': return boulderHit(h, t, x, y); case 'SKYFALL': return skyfallHit(h, t, x, y); default: return null; }
}

// Rune Mill: a double-ended beam spinning flat at shin height around a crystal pillar. Jump it.
/** Tier 4 exists only on course version 6+ (rushReforged.ts), tiers 5–6 only on version 7. */
export const MILL = { arm: 4.7, thick: .2, top: 46, pillar: .42, spin: [1.1, 1.35, 1.6, 1.95, 2.3, 2.7] } as const;
export const millCenter = (h: Hazard) => (h.from + h.to) / 2;
export const millAngle = (h: Hazard, t: number) => h.phase + h.dir * MILL.spin[h.tier - 1] * t;
function millHit(h: Hazard, t: number, x: number, y: number, z: number): Hit | null {
  if (z >= MILL.top) return null;
  const px = (x - 500) * KX, py = (y - millCenter(h)) * KY, a = millAngle(h, t), ux = Math.cos(a), uy = Math.sin(a);
  const s = px * ux + py * uy, perp = Math.abs(px * uy - py * ux);
  if (Math.abs(s) > MILL.arm + RS || perp > MILL.thick + RS) return null;
  const w = h.dir * MILL.spin[h.tier - 1], vx = -w * py;
  return { vx: side(vx, side(px, 1)) * 380, vy: -200 };
}
export function millPillar(h: Hazard | null, x: number, y: number) {
  if (!h || h.kind !== 'MILL') return x;
  const py = (y - millCenter(h)) * KY, min = MILL.pillar + RS; if (Math.abs(py) >= min) return x;
  const px = (x - 500) * KX, need = Math.sqrt(min * min - py * py); if (Math.abs(px) >= need) return x;
  return 500 + (px < 0 ? -need : need) / KX;
}

// Swinging rams: three iron-banded logs swinging across the road. Time the gap or pass beneath at the swing's end.
export const RAMS = { reach: 6.0, swing: 4.0, halfX: .45, halfY: .55, low: .15, high: 1.35, gap: 280, speed: [1.7, 2.05, 2.4, 2.8, 3.2, 3.6] } as const;
export const ramY = (h: Hazard, j: number) => h.from + 160 + j * RAMS.gap;
export const ramPhase = (h: Hazard, j: number, t: number) => h.phase + j * 1.9 + h.dir * RAMS.speed[h.tier - 1] * t;
/** Version 7 tiers 5–6 swing wider (still inside the reach, so the arc stays a real pendulum). */
export const ramSwing = (h: Hazard) => h.tier >= 5 ? 4.45 : RAMS.swing;
export const ramOffset = (h: Hazard, j: number, t: number) => ramSwing(h) * Math.sin(ramPhase(h, j, t));
export const ramLift = (offset: number) => RAMS.reach - Math.sqrt(RAMS.reach * RAMS.reach - offset * offset);
function ramsHit(h: Hazard, t: number, x: number, y: number, z: number): Hit | null {
  const px = (x - 500) * KX, rz = z * KX;
  for (let j = 0; j < 3; j++) {
    if (Math.abs((y - ramY(h, j)) * KY) > RAMS.halfY + RS) continue;
    const off = ramOffset(h, j, t); if (Math.abs(px - off) > RAMS.halfX + RS) continue;
    const lift = ramLift(off); if (lift + RAMS.low > rz + TRIALS.runnerHeight || lift + RAMS.high < rz) continue;
    const v = h.dir * Math.cos(ramPhase(h, j, t)); return { vx: side(v, side(px - off, 1)) * 420, vy: -150 };
  }
  return null;
}

// Stonefall Run: rune boulders roll down the causeway one lane at a time (pairs on tier 3). Change lanes.
export const BOULDER = { radius: .62, speed: [300, 350, 400, 450, 500, 550], every: [1.35, 1.15, 1.0, .88, .8, .72], pair: 330 } as const;
export interface Boulder { x: number; y: number; k: number; roll: number }
export const boulderStart = (h: Hazard) => h.to + 100;
export const boulderEnd = (h: Hazard) => h.from - 80;
export const boulderLane = (h: Hazard, k: number, pair: number) => { const lane = floorMod(mix((h.salt + Math.imul(k, 0x9E3779B9)) | 0), 3); return pair === 0 ? lane : (lane + 1) % 3; };
/** Version 7 tiers 5–6: anywhere across the road (between two lanes was always safe); a pair keeps `pair` apart. */
export const boulderX = (h: Hazard, k: number, pair: number) => {
  if (h.tier < 5) return LANES[boulderLane(h, k, pair)];
  const x = 160 + floorMod(mix((h.salt + Math.imul(k, 0x9E3779B9)) | 0), 681);
  return pair === 0 ? x : x + BOULDER.pair <= 840 ? x + BOULDER.pair : x - BOULDER.pair;
};
export const boulderPairs = (h: Hazard, k: number) => (h.tier === 3 ? floorMod(k, 4) === 3 : h.tier === 4 ? floorMod(k, 3) === 2 : h.tier >= 5 && floorMod(k, 2) === 1) ? 2 : 1;
export function boulders(h: Hazard, t: number, out: Boulder[] = []): Boulder[] {
  out.length = 0;
  const v = BOULDER.speed[h.tier - 1], every = BOULDER.every[h.tier - 1], span = boulderStart(h) - boulderEnd(h);
  const last = Math.floor((t - h.phase) / every), first = Math.ceil((t - h.phase - span / v) / every);
  for (let k = first; k <= last; k++) {
    const age = t - (h.phase + k * every), y = boulderStart(h) - v * age; if (age < 0 || y < boulderEnd(h)) continue;
    const pairs = boulderPairs(h, k);
    for (let q = 0; q < pairs; q++) out.push({ x: boulderX(h, k, q), y, k, roll: v * age * KY / BOULDER.radius });
  }
  return out;
}
const scratch: Boulder[] = [];
function boulderHit(h: Hazard, t: number, x: number, y: number): Hit | null {
  const r = BOULDER.radius + RS;
  for (const b of boulders(h, t, scratch)) { const dx = (x - b.x) * KX, dy = (y - b.y) * KY; if (dx * dx + dy * dy <= r * r) return { vx: side(dx, 1) * 220, vy: -(BOULDER.speed[h.tier - 1] + 150) }; }
  return null;
}

// Skyfall: rows of falling sky-stones; glowing circles mark two lanes one second before impact. The gaps are safe.
export const SKYFALL = { radius: 1.05, warn: 1.0, before: .05, after: .2, rowGap: 300, stagger: .8, period: [2.6, 2.3, 2.0, 1.8, 1.6, 1.45] } as const;
export interface Impact { row: number; n: number; time: number; y: number; safe: number }
export const rows = (h: Hazard) => h.tier === 1 ? 3 : h.tier >= 5 ? 5 : 4;
export const rowY = (h: Hazard, j: number) => h.from + 200 + j * SKYFALL.rowGap;
export const safeLane = (h: Hazard, row: number, n: number) => floorMod(mix(h.salt ^ ((Math.imul(row, 7919) + Math.imul(n, 104729)) | 0)), 3);
export function impacts(h: Hazard, t: number): Impact[] {
  const out: Impact[] = [], period = SKYFALL.period[h.tier - 1];
  for (let j = 0; j < rows(h); j++) {
    const base = h.phase + j * SKYFALL.stagger, n = Math.ceil((t - base - SKYFALL.after - .4) / period), at = base + n * period;
    if (t >= at - SKYFALL.warn) out.push({ row: j, n, time: at, y: rowY(h, j), safe: safeLane(h, j, n) });
  }
  return out;
}
function skyfallHit(h: Hazard, t: number, x: number, y: number): Hit | null {
  const r = SKYFALL.radius + RS;
  for (const i of impacts(h, t)) {
    if (t < i.time - SKYFALL.before || t > i.time + SKYFALL.after) continue;
    for (let lane = 0; lane < 3; lane++) { if (lane === i.safe) continue; const dx = (x - LANES[lane]) * KX, dy = (y - i.y) * KY; if (dx * dx + dy * dy <= r * r) return { vx: side(dx, 1) * 300, vy: -220 }; }
  }
  return null;
}

// Broken bridge: a gap across the road; jump it, or (tiers 1–2) cross the narrow beam.
export const CHASM = { half: [40, 46, 52, 56, 60, 64], grace: 14, beamHalf: 34 } as const;

export const chasmCenter = (h: Hazard) => (h.from + h.to) / 2;
export function falls(h: Hazard | null, x: number, y: number) {
  if (!h || h.kind !== 'CHASM') return false;
  if (Math.abs(y - chasmCenter(h)) >= CHASM.half[h.tier - 1] - CHASM.grace) return false;
  return h.lane < 0 || Math.abs(x - LANES[h.lane]) > CHASM.beamHalf;
}
export const respawnY = (h: Hazard) => h.kind === 'CHASM' ? chasmCenter(h) - CHASM.half[h.tier - 1] - TRIALS.respawnBack : h.from - TRIALS.respawnBack;

/** Rising Knowledge Gate sill height (z units). riseStart < 0: dormant; hold ≥ 0: frozen while an answer is checked. */
export function sill(riseStart: number, dropStart: number, dropFrom: number, hold: number, t: number) {
  if (hold >= 0) return hold; if (riseStart < 0) return 0;
  if (dropStart >= 0 && t < dropStart + TRIALS.dropTime) return dropFrom * (1 - (t - dropStart) / TRIALS.dropTime);
  return Math.min(TRIALS.sillMax, Math.max(0, (t - riseStart) * TRIALS.riseRate));
}
/** Earliest predicted contact for a grounded runner heading from x0 to xTarget (Infinity when clear). Training-ground bots and hints only. */
export function threat(h: Hazard, t: number, x0: number, xTarget: number, y0: number, speed: number, horizon: number) {
  for (let tau = 0; tau <= horizon + 1e-9; tau += .05) {
    const x = x0 + Math.sign(xTarget - x0) * Math.min(Math.abs(xTarget - x0), TRIALS.lateral * tau), y = y0 + speed * tau;
    if (h.kind === 'CHASM' ? falls(h, x, y) : hit(h, t + tau, x, y, 0)) return tau;
  }
  return Infinity;
}
/** Reading road of one question: v4's seconds on the faster road. */
export function readingLength(q: { prompt: string; context: string; options: { label: string }[] }) {
  const words = [q.prompt, q.context, ...q.options.map(o => o.label)].join(' ').trim().split(/\s+/).length;
  return Math.max(TRIALS.readMin, Math.min(TRIALS.readMax, TRIALS.readBase + TRIALS.readPerWord * words));
}
