/**
 * Course versions 6 ("Reforged") and 7 ("Hardcore") — the browser mirror of RushReforged.java: manual movement, open
 * edges, moving Knowledge Walls, ten (version 7: fourteen) obstacle kinds and orbs. Pure and deterministic; constants are
 * compared with the Java source by `scripts/test-echo-quiz-rush.mjs`. Version 7 has no railing anywhere, tiers 5–6, harder
 * knocks and four more obstacles (BEAM, STEPS, TILT, ROLLER) that exist only in its plans. Units as in version 5 (x
 * lateral, y forward, z height; scene metres x × .01, y × .02, z × .01); speeds are scene metres per second.
 */
import { CHASM, LANES, TRIALS, chasmCenter, falls as chasmFalls, hit as trialsHit, millCenter, millPillar, mix, ramY, RAMS, type Hazard, type Hit } from './rushTrials';

export const REFORGED = {
  version: 6, hardcore: 7, move: 4.24, sprint: 5.6, dash: 8.2, dashTime: .25, rush: 6.4, back: .62, accel: 11, brake: 13, air: 2.6, snare: 1.9,
  speedOrb: 1.25, speedTime: 4, energyOrb: 35, shieldTime: 12, shieldGuard: .6, orbReach: .65, body: 90,
  stumbleTime: .42, recoil: 260, bump: 200, bumpSpeed: 60,
  edge: 470, rail: 424, galeHalf: 220, respawnBack: 120,
  knock7X: 2.3, knock7Y: 1.45, fallDrag: 1.4, respawnSide: 250,
  leadIn: 300, between: 260, runout: 320, readBase: 760, readPerWord: 30, readMin: 1100, readMax: 1750, wallRoom: 380,
} as const;
export type ReforgedKind = 'MILL' | 'RAMS' | 'BOULDERS' | 'SKYFALL' | 'CHASM' | 'SAWS' | 'CRUSHER' | 'GALE' | 'CRUMBLE' | 'DRIFT' | 'BEAM' | 'STEPS' | 'TILT' | 'ROLLER';
export type WallKind6 = 'STATIC' | 'APPROACH' | 'SLIDE' | 'TIMED' | 'RISING' | 'SURGE';
export interface Wall6 { kind: WallKind6; tier: number; phase: number; travel: number; rest: number; advance: number; hold: number; retreat: number; amp: number; slidePeriod: number; shutPeriod: number; openShare: number }
export type OrbKind = 'SPEED' | 'ENERGY' | 'GUARD';
export interface Orb { id: number; kind: OrbKind; checkpoint: number; x: number; y: number; z: number }

const { kx: KX, ky: KY, rs: RS } = TRIALS;
const smooth = (u: number) => { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); };
const mod = (a: number, n: number) => { const r = a % n; return r < 0 ? r + n : r; };
const side = (v: number, fallback: number) => v > 0 ? 1 : v < 0 ? -1 : fallback;
const floorMod = (a: number, n: number) => ((a % n) + n) % n;
/** Java's Math.toRadians (one multiplication by the rounded constant, so both sides round alike). */
const rad = (deg: number) => deg * (Math.PI / 180);

export function readingLength6(q: { prompt: string; context: string; options: { label: string }[] }) {
  const words = [q.prompt, q.context, ...q.options.map(o => o.label)].join(' ').trim().split(/\s+/).length;
  return Math.max(REFORGED.readMin, Math.min(REFORGED.readMax, REFORGED.readBase + REFORGED.readPerWord * words));
}

// ─── Walls ───
export const cycle = (w: Wall6) => w.rest + w.advance + w.hold + w.retreat;
export function approach(w: Wall6 | null | undefined, t: number) {
  if (!w || w.travel <= 0) return 0; let u = mod(t - w.phase, cycle(w));
  if (u < w.rest) return 0; u -= w.rest; if (u < w.advance) return w.travel * smooth(u / w.advance); u -= w.advance;
  if (u < w.hold) return w.travel; u -= w.hold; return w.travel * (1 - smooth(u / w.retreat));
}
export const slide = (w: Wall6 | null | undefined, t: number) => !w || w.amp <= 0 ? 0 : w.amp * Math.sin(2 * Math.PI * (t - w.phase) / w.slidePeriod);
export const shut = (w: Wall6 | null | undefined, t: number) => !!w && w.shutPeriod > 0 && mod(t - w.phase, w.shutPeriod) / w.shutPeriod >= w.openShare;
export function shutter(w: Wall6 | null | undefined, t: number) {
  if (!w || w.shutPeriod <= 0) return 0; const u = mod(t - w.phase, w.shutPeriod) / w.shutPeriod, lead = .2 / w.shutPeriod;
  if (u < w.openShare - lead) return 0; if (u < w.openShare) return (u - (w.openShare - lead)) / lead; if (u < 1 - lead) return 1; return 1 - (u - (1 - lead)) / lead;
}
export const plane = (w: Wall6 | null | undefined, rest: number, t: number) => rest - approach(w, t);

// ─── Edges ───
export const hazardsAt = (all: Hazard[] | undefined, checkpoint: number) => (all ?? []).filter(h => h.checkpoint === checkpoint);
export function zone(hazards: Hazard[], y: number) { for (const h of hazards) if (y >= h.from && y <= h.to) return h; return null; }
/** Version 6: open half-width at y (−1 = railed). Version 7 has no railing at all. */
export function openHalf(hazards: Hazard[], y: number) { const h = zone(hazards, y); return !h ? -1 : (h.kind as ReforgedKind) === 'GALE' ? galeHalf(h) : REFORGED.edge; }

// ─── Rune Saws ───
export const SAWS = { gap: 300, r: .6, c: .35, halfY: .1, amp: 380, spin: [1.5, 1.9, 2.4, 2.9, 3.3, 3.7] } as const;
export const sawRows = (tier: number) => tier <= 2 ? 2 : tier >= 5 ? 4 : 3;
export const sawY = (h: Hazard, j: number) => h.from + 180 + j * SAWS.gap;
export const sawDouble = (h: Hazard, j: number) => h.tier >= 3 || h.tier === 2 && j % 2 === 1;
/** Version 7 tiers 5–6: alternate rows sweep the other way. */
export const sawRowDir = (h: Hazard, j: number) => h.tier >= 5 && j % 2 === 1 ? -1 : 1;
export const sawAngle = (h: Hazard, j: number, t: number) => h.phase + j * 1.7 + sawRowDir(h, j) * SAWS.spin[h.tier - 1] * t;
export const sawX = (h: Hazard, j: number, b: number, t: number) => { const s = Math.sin(sawAngle(h, j, t)) * h.dir; return 500 + (b === 0 ? s : -s) * SAWS.amp; };
export const sawVx = (h: Hazard, j: number, b: number, t: number) => { const v = Math.cos(sawAngle(h, j, t)) * h.dir * sawRowDir(h, j) * SAWS.spin[h.tier - 1] * SAWS.amp; return b === 0 ? v : -v; };
function sawsHit(h: Hazard, t: number, x: number, y: number, z: number): Hit | null {
  if (z * KX >= SAWS.c + SAWS.r - .1) return null;
  for (let j = 0; j < sawRows(h.tier); j++) {
    if (Math.abs((y - sawY(h, j)) * KY) > SAWS.halfY + RS) continue;
    for (let b = 0; b < (sawDouble(h, j) ? 2 : 1); b++) if (Math.abs((x - sawX(h, j, b, t)) * KX) <= SAWS.r + RS * .6) return { vx: side(sawVx(h, j, b, t), side(x - sawX(h, j, b, t), 1)) * 360, vy: -240 };
  }
  return null;
}

// ─── Crushing Walls (tiers 5–6: every second row is a one-sided ram that shoves toward the far edge) ───
export const CRUSHER = { gap: 320, halfY: .9, reach: 770, period: [3.6, 3.2, 2.85, 2.5, 2.25, 2.0] } as const;
export const crushRows = (tier: number) => tier <= 2 ? 2 : tier >= 5 ? 4 : 3;
export const crushY = (h: Hazard, j: number) => h.from + 200 + j * CRUSHER.gap;
export const crushOneSided = (h: Hazard, j: number) => h.tier >= 5 && j % 2 === 1;
/** The side (−1 left, +1 right) a one-sided ram drives from. */
export const crushSide = (h: Hazard, j: number) => Math.floor(j / 2) % 2 === 0 ? h.dir : -h.dir;
export function closure(h: Hazard, j: number, t: number) {
  const period = CRUSHER.period[h.tier - 1], u = mod(t - h.phase / (2 * Math.PI) * period - j * .33 * period, period) / period;
  if (u < .45) return 0; if (u < .55) return smooth((u - .45) / .1); if (u < .7) return 1; return 1 - (u - .7) / .3;
}
function crusherHit(h: Hazard, t: number, x: number, y: number): Hit | null {
  for (let j = 0; j < crushRows(h.tier); j++) {
    if (Math.abs((y - crushY(h, j)) * KY) > CRUSHER.halfY + RS) continue;
    const c = closure(h, j, t); if (c <= .04) continue;
    if (crushOneSided(h, j)) { const s = crushSide(h, j); if (s * (x - 500) + RS / KX >= REFORGED.edge - CRUSHER.reach * c) return { vx: -s * 520, vy: -150 }; }
    else if (Math.abs(x - 500) * KX + RS >= REFORGED.edge * KX * (1 - c)) return { vx: 0, vy: -330 };
  }
  return null;
}

// ─── Gale Bridge and Wind Balance Bridge (BEAM, version 7: much narrower, longer, telegraphed gusts) ───
export const GALE = { length: 900, period: [3.6, 3.3, 3.0, 2.7, 2.45, 2.2], force: [150, 190, 230, 270, 310, 350] } as const;
export const BEAM = { length: [800, 900, 1000, 1100, 1200, 1300], half: [130, 120, 110, 100, 92, 85], period: [3.4, 3.1, 2.8, 2.5, 2.3, 2.1], force: [160, 195, 230, 255, 265, 270] } as const;
export const galeHalf = (h: Hazard) => h.tier >= 6 ? 170 : h.tier === 5 ? 190 : REFORGED.galeHalf;
const windy = (h: Hazard | null) => !!h && ((h.kind as ReforgedKind) === 'GALE' || (h.kind as ReforgedKind) === 'BEAM');
export const gustPeriod = (h: Hazard) => ((h.kind as ReforgedKind) === 'BEAM' ? BEAM.period : GALE.period)[h.tier - 1];
export const gustDir = (h: Hazard, n: number) => (mix((h.salt + Math.imul(n, 0x2545F491)) | 0) & 1) === 0 ? 1 : -1;
export const gustCycle = (h: Hazard, t: number) => Math.floor((t - h.phase) / gustPeriod(h));
export function gust(h: Hazard, t: number) {
  const period = gustPeriod(h), u = mod(t - h.phase, period) / period;
  if (u < .25 || u > .7) return 0; if (u < .32) return (u - .25) / .07; if (u < .64) return 1; return 1 - (u - .64) / .06;
}
export const gustWarning = (h: Hazard, t: number) => { const period = gustPeriod(h), u = mod(t - h.phase, period) / period; return u >= .03 && u < .25; };
export const wind = (h: Hazard | null, t: number) => !h || !windy(h) ? 0 : gust(h, t) * ((h.kind as ReforgedKind) === 'BEAM' ? BEAM.force : GALE.force)[h.tier - 1] * gustDir(h, gustCycle(h, t));

// ─── Crumbling Span ───
export const CRUMBLE = { tile: 130, down: .34, warn: .14, tileTime: .584, period: [3.8, 3.5, 3.2, 3.0, 2.8, 2.6] } as const;
export const crumbleTiles = (tier: number) => tier <= 2 ? 5 : tier >= 5 ? 7 : 6;
export const crumbleU = (h: Hazard, k: number, t: number) => { const period = CRUMBLE.period[h.tier - 1]; return mod((t - h.phase / (2 * Math.PI) * period - k * CRUMBLE.tileTime) / period, 1); };
export const tileDown = (h: Hazard, k: number, t: number) => crumbleU(h, k, t) < CRUMBLE.down;
export const tileShake = (h: Hazard, k: number, t: number) => { const u = crumbleU(h, k, t); return u >= 1 - CRUMBLE.warn ? (u - (1 - CRUMBLE.warn)) / CRUMBLE.warn : 0; };
const crumbleFalls = (h: Hazard, y: number, t: number) => { const k = Math.floor((y - h.from) / CRUMBLE.tile); return k >= 0 && k < crumbleTiles(h.tier) && tileDown(h, k, t); };

// ─── Drifting Stones ───
export const DRIFT = { gap: 125, r: .95, amp: [150, 200, 250, 300, 330, 360], spin: [.8, 1.0, 1.15, 1.3, 1.45, 1.6] } as const;
export const driftRows = (tier: number) => [3, 4, 4, 5, 5, 6][tier - 1];
export const driftY = (h: Hazard, j: number) => h.from + 50 + DRIFT.gap / 2 + j * DRIFT.gap;
export const driftX = (h: Hazard, j: number, t: number) => 500 + DRIFT.amp[h.tier - 1] * Math.sin(DRIFT.spin[h.tier - 1] * t + h.phase + j * 2.1) * (j % 2 === 0 ? h.dir : -h.dir);
export const driftVx = (h: Hazard, j: number, t: number) => DRIFT.amp[h.tier - 1] * DRIFT.spin[h.tier - 1] * Math.cos(DRIFT.spin[h.tier - 1] * t + h.phase + j * 2.1) * (j % 2 === 0 ? h.dir : -h.dir);
export function stoneUnder(h: Hazard, x: number, y: number, t: number) {
  for (let j = 0; j < driftRows(h.tier); j++) { const dx = (x - driftX(h, j, t)) * KX, dy = (y - driftY(h, j)) * KY; if (dx * dx + dy * dy <= DRIFT.r * DRIFT.r) return j; }
  return -1;
}

// ─── Floating Stepping Stones (version 7): a zigzag of stones over the void; from tier 3 every second one dips for a moment
// (it sinks slightly and its footing shrinks to `dip` of its radius — never gone, so a crossing always remains). ───
/** Spacing calibrated against a plain hop rhythm (hold the run, leap on each landing); smaller, wider-spread stones on harder tiers. */
export const STEPS = { edge: 100, down: .28, warn: .18, dip: .6, gap: [156, 152, 146, 140, 136, 132], off: [40, 52, 62, 72, 80, 88], r: [1.15, 1.1, 1.05, 1.0, .95, .9], sink: [0, 0, 4.2, 3.8, 3.4, 3.0] } as const;
export const stepRows = (tier: number) => [4, 4, 5, 5, 6, 6][tier - 1];
export const stepY = (h: Hazard, j: number) => h.from + STEPS.edge + j * STEPS.gap[h.tier - 1];
export const stepX = (h: Hazard, j: number) => {
  const jitter = h.tier >= 4 ? floorMod(mix((h.salt + Math.imul(j, 0x632BE5AB)) | 0), 61) - 30 : 0;
  return 500 + (j % 2 === 0 ? 1 : -1) * h.dir * STEPS.off[h.tier - 1] + jitter;
};
export const stepSinks = (h: Hazard, j: number) => h.tier >= 3 && j % 2 === 1;
export const stepU = (h: Hazard, j: number, t: number) => { const period = STEPS.sink[h.tier - 1]; return mod(t - h.phase / (2 * Math.PI) * period - j * .9, period) / period; };
export const stepDown = (h: Hazard, j: number, t: number) => stepSinks(h, j) && stepU(h, j, t) < STEPS.down;
export const stepShake = (h: Hazard, j: number, t: number) => { if (!stepSinks(h, j)) return 0; const u = stepU(h, j, t); return u >= 1 - STEPS.warn ? (u - (1 - STEPS.warn)) / STEPS.warn : 0; };
export function stepUnder(h: Hazard, x: number, y: number, t: number) {
  const r = STEPS.r[h.tier - 1];
  for (let j = 0; j < stepRows(h.tier); j++) { const rr = stepDown(h, j, t) ? r * STEPS.dip : r, dx = (x - stepX(h, j)) * KX, dy = (y - stepY(h, j)) * KY; if (dx * dx + dy * dy <= rr * rr) return j; }
  return -1;
}
/**
 * Rendering only: how far (scene metres) a dipping stone has sunk at t — down while it dips (eased), back up before it ends.
 * The drawn stone and a runner standing on it use the same value, so nobody hangs above a stone that went down; the
 * footing rule above (`stepUnder`) still decides who falls.
 */
export const STEP_SINK = .45;
export function stepSink(h: Hazard, j: number, t: number) {
  if (!stepDown(h, j, t)) return 0;
  const d = stepU(h, j, t) / STEPS.down, k = d < .3 ? d / .3 : d > .8 ? (1 - d) / .2 : 1;
  return STEP_SINK * k * k * (3 - 2 * k);
}

// ─── Tilting Road (version 7): the deck leans in 6 m sections (alternating from tier 3), eased across every joint ───
export const TILT = { seg: 300, blend: 70, length: [700, 800, 900, 1000, 1100, 1200], deg: [12, 15, 17, 19, 21, 23], pull: [150, 180, 210, 240, 265, 290] } as const;
export const tiltSign = (h: Hazard, k: number) => h.tier >= 3 && k % 2 === 1 ? -h.dir : h.dir;
/** Signed lean (radians; + means the +x side is low) at y. */
export function tiltAngle(h: Hazard, y: number) {
  const u = y - h.from; if (u < 0 || y > h.to) return 0; const a = rad(TILT.deg[h.tier - 1]);
  const k = Math.floor(u / TILT.seg), within = u - k * TILT.seg, cur = tiltSign(h, k) * a, prev = k === 0 ? 0 : tiltSign(h, k - 1) * a;
  const v = within < TILT.blend ? prev + (cur - prev) * smooth(within / TILT.blend) : cur, end = h.to - y;
  return end < TILT.blend ? v * smooth(end / TILT.blend) : v;
}
export const tiltHalf = (h: Hazard, y: number) => REFORGED.edge * Math.cos(tiltAngle(h, y));
export const tiltSlide = (h: Hazard, y: number) => TILT.pull[h.tier - 1] * Math.sin(tiltAngle(h, y)) / Math.sin(rad(TILT.deg[h.tier - 1]));

// ─── Spiked Rotating Rollers (version 7): logs spin about their length over the abyss, studded with pegs in staggered rings.
// Tier 1 one central log; 2 two parallel logs turning opposite ways; 3–4 two logs in sequence with a pad; 5–6 with a void to leap. ───
export const ROLLER = { r: .55, peg: .42, pegHalf: .07, support: .46, body: .24, pad: 70, padHalf: 120, jump: 50, side: 160,
  length: [620, 680, 760, 800, 840, 880], spin: [1.15, 1.4, 1.6, 1.8, 2.0, 2.2], ring: [80, 74, 70, 66, 62, 66], pegs: [1, 2, 2, 2, 2, 2] } as const;
const PEG_SAMPLES = [.15, .5, .85, 1];
export const logCount = (h: Hazard) => h.tier === 1 ? 1 : 2;
const parallel = (h: Hazard) => h.tier === 2;
/** Tiers 3–4 have a stone pad between the two logs; tiers 5–6 a short void to leap. */
export const rollerPad = (h: Hazard) => h.tier === 3 || h.tier === 4;
export const logX = (h: Hazard, i: number) => parallel(h) ? 500 + (i === 0 ? -ROLLER.side : ROLLER.side) : 500;
export const logFrom = (h: Hazard, i: number) => parallel(h) || h.tier === 1 || i === 0 ? h.from : (h.from + h.to) / 2 + (rollerPad(h) ? ROLLER.pad : ROLLER.jump) / 2;
export const logTo = (h: Hazard, i: number) => parallel(h) || h.tier === 1 || i === 1 ? h.to : (h.from + h.to) / 2 - (rollerPad(h) ? ROLLER.pad : ROLLER.jump) / 2;
/** +1: the top of the log moves toward +x. Neighbouring logs always turn opposite ways. */
export const logDir = (h: Hazard, i: number) => i === 0 ? h.dir : -h.dir;
export const ringCount = (h: Hazard, i: number) => Math.max(1, Math.floor((logTo(h, i) - logFrom(h, i) - 40) / ROLLER.ring[h.tier - 1]));
export const ringY = (h: Hazard, i: number, j: number) => logFrom(h, i) + (logTo(h, i) - logFrom(h, i)) * (j + .5) / ringCount(h, i);
export const pegsIn = (h: Hazard, j: number) => h.tier === 6 && j % 2 === 1 ? 3 : ROLLER.pegs[h.tier - 1];
/** Angle from the top (radians; + toward +x) of peg k of ring j on log i at time t. */
export const pegAngle = (h: Hazard, i: number, j: number, k: number, t: number) => h.phase + i * 1.3 + j * 2.39996 + k * 2 * Math.PI / pegsIn(h, j) + logDir(h, i) * ROLLER.spin[h.tier - 1] * t;
/** The rotation of log i (radians, + toward +x at the top). */
export const logAngle = (h: Hazard, i: number, t: number) => logDir(h, i) * ROLLER.spin[h.tier - 1] * t;
export function rollerSupport(h: Hazard, x: number, y: number) {
  for (let i = 0; i < logCount(h); i++) if (y >= logFrom(h, i) && y <= logTo(h, i) && Math.abs(x - logX(h, i)) * KX <= ROLLER.support) return true;
  return rollerPad(h) && Math.abs(y - (h.from + h.to) / 2) <= ROLLER.pad / 2 && Math.abs(x - 500) <= ROLLER.padHalf;
}
export function rollerCarry(h: Hazard, x: number, y: number) {
  for (let i = 0; i < logCount(h); i++) if (y >= logFrom(h, i) && y <= logTo(h, i) && Math.abs(x - logX(h, i)) * KX <= ROLLER.support) return logDir(h, i) * ROLLER.spin[h.tier - 1] * ROLLER.r / KX;
  return 0;
}
function rollerHit(h: Hazard, t: number, x: number, y: number, z: number): Hit | null {
  for (let i = 0; i < logCount(h); i++) {
    const from = logFrom(h, i), to = logTo(h, i); if (y < from - 20 || y > to + 20) continue;
    const dx = (x - logX(h, i)) * KX, feet = z * KX; if (Math.abs(dx) > ROLLER.r + ROLLER.peg + ROLLER.body) continue;
    const n = ringCount(h, i), jc = Math.round((y - from) / (to - from) * n - .5);
    for (let j = Math.max(0, jc - 1); j <= Math.min(n - 1, jc + 1); j++) {
      if (Math.abs((y - ringY(h, i, j)) * KY) > ROLLER.pegHalf + ROLLER.body) continue;
      for (let k = 0; k < pegsIn(h, j); k++) {
        const a = pegAngle(h, i, j, k, t), s = Math.sin(a), c = Math.cos(a);
        for (const f of PEG_SAMPLES) {
          const r = ROLLER.r + ROLLER.peg * f, px = r * s, py = r * c - ROLLER.r;
          if (Math.abs(px - dx) <= ROLLER.body + ROLLER.pegHalf && py >= feet - ROLLER.pegHalf && py <= feet + TRIALS.runnerHeight) return { vx: side(logDir(h, i) * c, side(dx - px, 1)) * 420, vy: -120 };
        }
      }
    }
  }
  return null;
}

export function hazardLength6(kind: ReforgedKind, tier: number) {
  switch (kind) {
    case 'MILL': return 620; case 'RAMS': return 880; case 'BOULDERS': return 1500; case 'CHASM': return 520;
    case 'SKYFALL': return (tier === 1 ? 1000 : 1300) + (tier >= 4 ? 300 : 0);
    case 'SAWS': return 360 + (sawRows(tier) - 1) * SAWS.gap; case 'CRUSHER': return 400 + (crushRows(tier) - 1) * CRUSHER.gap;
    case 'GALE': return GALE.length; case 'CRUMBLE': return crumbleTiles(tier) * CRUMBLE.tile; case 'DRIFT': return driftRows(tier) * DRIFT.gap + 100;
    case 'BEAM': return BEAM.length[tier - 1]; case 'STEPS': return 2 * STEPS.edge + (stepRows(tier) - 1) * STEPS.gap[tier - 1];
    case 'TILT': return TILT.length[tier - 1]; case 'ROLLER': return ROLLER.length[tier - 1];
  }
}

// ─── Dispatch ───
export function hit6(h: Hazard | null, t: number, x: number, y: number, z: number): Hit | null {
  if (!h || y < h.from - 120 || y > h.to + 120) return null;
  switch (h.kind as ReforgedKind) {
    case 'SAWS': return sawsHit(h, t, x, y, z); case 'CRUSHER': return crusherHit(h, t, x, y); case 'ROLLER': return rollerHit(h, t, x, y, z);
    case 'MILL': case 'RAMS': case 'BOULDERS': case 'SKYFALL': return trialsHit(h, t, x, y, z); default: return null;
  }
}
/** `open` (version 7): no railing, so outside obstacle zones the road edge is a real drop too. */
export function falls6(hazards: Hazard[], x: number, y: number, t: number, open = false) {
  const h = zone(hazards, y); if (!h) return open && Math.abs(x - 500) > REFORGED.edge;
  const dx = Math.abs(x - 500);
  switch (h.kind as ReforgedKind) {
    case 'GALE': return dx > galeHalf(h);
    case 'BEAM': return dx > BEAM.half[h.tier - 1];
    case 'TILT': return dx > tiltHalf(h, y);
    case 'STEPS': return stepUnder(h, x, y, t) < 0;
    case 'ROLLER': return !rollerSupport(h, x, y);
    case 'CHASM': return dx > REFORGED.edge || chasmFalls(h, x, y);
    case 'CRUMBLE': return dx > REFORGED.edge || crumbleFalls(h, y, t);
    case 'DRIFT': return dx > REFORGED.edge || stoneUnder(h, x, y, t) < 0;
    default: return dx > REFORGED.edge;
  }
}
export const respawnY6 = (h: Hazard) => h.kind === 'CHASM' ? chasmCenter(h) - CHASM.half[h.tier - 1] - TRIALS.respawnBack : h.from - REFORGED.respawnBack;
export const respawnX6 = (h: Hazard) => h.kind === 'CHASM' && h.lane >= 0 ? LANES[h.lane] : 500;
/** Version 7: where a runner who fell at (x, y) comes back (mirrors RushReforged.respawnAt). */
export function respawnAt(hazards: Hazard[], x: number, y: number): [number, number] {
  const h = zone(hazards, y); if (h) return [respawnX6(h), respawnY6(h)];
  const back = y - REFORGED.respawnBack, behind = zone(hazards, back);
  return [500 + Math.max(-REFORGED.respawnSide, Math.min(REFORGED.respawnSide, x - 500)), behind ? behind.to + 30 : back];
}
export function drift6(hazards: Hazard[], x: number, y: number, t: number, grounded: boolean) {
  const h = zone(hazards, y); if (!h) return 0;
  if (windy(h)) return wind(h, t);
  if (!grounded) return 0;
  switch (h.kind as ReforgedKind) {
    case 'DRIFT': { const j = stoneUnder(h, x, y, t); return j < 0 ? 0 : driftVx(h, j, t); }
    case 'TILT': return tiltSlide(h, y);
    case 'ROLLER': return rollerCarry(h, x, y);
    default: return 0;
  }
}
export function pillar6(hazards: Hazard[], x: number, y: number) { for (const h of hazards) if (h.kind === 'MILL') x = millPillar(h, x, y); return x; }
/** Footholds a careful runner aims for at y (bots, test pilots): roller logs, the next stones, a beam's middle, the uphill side. */
export function footholds(hazards: Hazard[], y: number): number[] {
  let h = zone(hazards, y); if (!h) for (const c of hazards) if (c.from > y && c.from - y < 320) { h = c; break; }
  if (!h) return [];
  switch (h.kind as ReforgedKind) {
    case 'ROLLER': return logCount(h) === 2 && parallel(h) ? [logX(h, 0), logX(h, 1)] : [500];
    case 'STEPS': { let j = 0; while (j < stepRows(h.tier) - 1 && stepY(h, j) < y + 20) j++; return [stepX(h, j), stepX(h, Math.max(0, j - 1))]; }
    case 'BEAM': case 'GALE': return [500];
    case 'TILT': return [500 - Math.sign(tiltAngle(h, Math.max(h.from + 1, y))) * 170];
    default: return [];
  }
}
/**
 * Rendering only: the height of the walking surface above the causeway at (x, y) — the leaning deck of a Tilting Road
 * (scene metres; the drawn runner stands on it while its physics height stays relative to the surface).
 */
export function surfaceHeight(hazards: Hazard[] | undefined, x: number, y: number, t = 0) {
  if (!hazards) return 0;
  for (const h of hazards) {
    if (y < h.from || y > h.to) continue;
    if ((h.kind as ReforgedKind) === 'TILT') { const a = tiltAngle(h, y), d = Math.max(-REFORGED.edge, Math.min(REFORGED.edge, x - 500)) * KX; return -d * Math.tan(a); }
    // A runner over a stone stands on it: a sinking stone carries them down with it.
    if ((h.kind as ReforgedKind) === 'STEPS') { const r = STEPS.r[h.tier - 1]; for (let j = 0; j < stepRows(h.tier); j++) { const dx = (x - stepX(h, j)) * KX, dy = (y - stepY(h, j)) * KY; if (dx * dx + dy * dy <= r * r) return -stepSink(h, j, t); } }
  }
  return 0;
}
export const touches = (o: Orb, x: number, y: number, z: number) => { const dx = (x - o.x) * KX, dy = (y - o.y) * KY, dz = (z + REFORGED.body - o.z) * KX; return dx * dx + dy * dy + dz * dz <= REFORGED.orbReach * REFORGED.orbReach; };
/** Kept for the practice course layout: where an orb sits inside a hazard (same rule as RushReforged.orbFor). */
export const orbSpot = (h: Hazard, lane: number) => h.kind === 'CHASM' ? { x: LANES[lane], y: chasmCenter(h), z: REFORGED.body + 55 } : h.kind === 'MILL' ? { x: 760, y: millCenter(h), z: REFORGED.body }
  : h.kind === 'RAMS' ? { x: LANES[lane], y: ramY(h, 1) + RAMS.gap / 2, z: REFORGED.body } : { x: LANES[lane], y: (h.from + h.to) / 2, z: REFORGED.body };
