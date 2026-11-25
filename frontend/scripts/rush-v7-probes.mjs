/* Echo Quiz Rush course version 7 — parity probes. Evaluates the browser mirror (rushReforged.ts / rushTrials.ts) at fixed
 * points (a grid over every new obstacle and the tier 5–6 versions of the older ones, plus targeted peg / stone / lean
 * points) and writes them as CSV for RushHardcoreTest, which asks the server the same questions and must get the same
 * answers. Run from frontend/: node scripts/rush-v7-probes.mjs > ../backend/src/test/resources/quizrush/v7-probes.csv */
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch (e) { if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(specifier + '.ts', context); throw e; } } });
const R = await import('../src/components/features/games/echo-quiz-rush/rushReforged.ts');

const hazards = [];
for (const kind of ['ROLLER', 'STEPS', 'TILT', 'BEAM']) for (let tier = 1; tier <= 6; tier++) {
  const from = 1000; hazards.push({ kind, checkpoint: 0, from, to: from + R.hazardLength6(kind, tier), tier, phase: .7 + tier * .31, dir: tier % 2 ? 1 : -1, lane: -1, salt: 12345 + tier * 977 });
}
for (const kind of ['SAWS', 'CRUSHER', 'BOULDERS', 'GALE', 'RAMS', 'MILL', 'SKYFALL', 'CRUMBLE', 'DRIFT', 'CHASM']) for (const tier of [5, 6]) {
  const from = 1000; hazards.push({ kind, checkpoint: 0, from, to: from + R.hazardLength6(kind, tier), tier, phase: 1.1 + tier * .17, dir: tier === 5 ? 1 : -1, lane: -1, salt: 777 + tier * 31 });
}
const rows = ['kind,tier,phase,dir,salt,from,to,t,x,y,z,hitSide,hitVy,falls,drift'];
const fmt = v => Number.isInteger(v) ? String(v) : v.toPrecision(14);
const probe = (h, t, x, y, z) => {
  const hit = R.hit6(h, t, x, y, z), falls = R.falls6([h], x, y, t, true), drift = R.drift6([h], x, y, t, z <= 0);
  rows.push([h.kind, h.tier, h.phase, h.dir, h.salt, h.from, h.to, t, fmt(x), fmt(y), z, hit ? Math.sign(hit.vx) : '', hit ? hit.vy : '', falls, fmt(drift)].join(','));
};
for (const h of hazards) {
  const len = h.to - h.from;
  for (const t of [0, 1.37, 6.9]) for (const fx of [-.32, -.06, 0, .05, .2]) for (const fy of [.03, .31, .62, .96]) for (const z of [0, 45]) probe(h, t, 500 + fx * 1000, h.from + fy * len, z);
  if (h.kind === 'ROLLER') for (let i = 0; i < R.logCount(h); i++) for (let j = 0; j < R.ringCount(h, i); j++) for (let k = 0; k < 24; k++) {
    const t = k * .113 + j * .05; probe(h, t, R.logX(h, i) + (k % 3 - 1) * 12, R.ringY(h, i, j) + (k % 5 - 2) * 6, k % 4 === 3 ? 50 : 0);
  }
  if (h.kind === 'STEPS') for (let j = 0; j < R.stepRows(h.tier); j++) for (let k = 0; k < 10; k++) probe(h, k * .61, R.stepX(h, j) + (k - 5) * 9, R.stepY(h, j) + (k % 3 - 1) * 20, 0);
  if (h.kind === 'TILT') for (let k = 0; k < 40; k++) probe(h, 0, 500 + (k % 9 - 4) * 115, h.from + k / 39 * len, 0);
}
console.log(rows.join('\n'));
