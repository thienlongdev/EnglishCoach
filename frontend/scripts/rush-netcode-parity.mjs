// Regenerates backend/src/test/resources/quizrush/netcode-parity.csv: per-step trajectories of the browser's version 7
// model (rushModel.stepRush) for movement, skills and tactics. RushNetcodeParityTest replays the same inputs through the
// authority (RushCompetition.input / boost / move6) and requires the same state, so the prediction a multiplayer racer
// sees is the one the server will confirm (no correction from a model difference).
//   node scripts/rush-netcode-parity.mjs [--check]   (--check: compare with the stored file instead of writing it)
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch (e) { if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(specifier + '.ts', context); throw e; } } });
const M = await import('../src/components/features/games/echo-quiz-rush/rushModel.ts');
const STEP = 1 / 120, STEPS = 180;
const file = new URL('../../backend/src/test/resources/quizrush/netcode-parity.csv', import.meta.url);

/** Each scenario: start state (effect, effect end, rush energy) and the input of every step (`at(step)`). */
const W = { h: 0, f: 1 }, WD = { h: 1, f: 1 }, S = { h: 0, f: -1 }, A = { h: -1, f: 0 }, NONE = { h: 0, f: 0 };
export const SCENARIOS = [
  { name: 'forward', at: () => W },
  { name: 'backward', at: () => S },
  { name: 'left', at: () => A },
  { name: 'diagonal', at: () => WD },
  { name: 'sprint', at: () => ({ ...W, sprint: true }) },
  { name: 'stop-and-brake', at: k => k < 90 ? W : NONE },
  { name: 'dash', at: k => ({ ...WD, dash: k === 12 }) },
  { name: 'echo-rush', energy: 100, at: k => ({ ...W, rush: k === 6 }) },
  { name: 'dodge', at: k => ({ ...W, h: k >= 20 ? 1 : 0, dodge: k === 20 }) },
  { name: 'jump', at: k => ({ ...W, jump: k === 30 }) },
  { name: 'time-snare-expires', effect: 'TIME_SNARE', until: 10.5, at: () => W },
  { name: 'time-snare-diagonal-sprint', effect: 'TIME_SNARE', until: 10.9, at: () => ({ ...WD, sprint: true }) },
  { name: 'ice-lock-expires', effect: 'ICE_LOCK', until: 10.4, at: k => ({ ...WD, dodge: k === 10 }) },
];
const n = v => (Math.abs(v) < 1e-12 ? 0 : v).toFixed(9);
function trajectory(sc) {
  const s = M.createRush(3, 0, 3, 10000, 7, [10000, 20000, 30000], [], [], [null, null, null], []);
  s.phase = 'RUNNING'; s.elapsed = 10; s.phaseTime = 5; s.y = 1000; s.rushEnergy = sc.energy ?? 0; s.effect = sc.effect ?? ''; s.effectUntil = sc.until ?? -1;
  const rows = [];
  for (let k = 0; k < STEPS; k++) {
    const i = sc.at(k), input = { horizontal: i.h, forward: i.f, sprint: !!i.sprint, jump: !!i.jump, dodge: !!i.dodge, dash: !!i.dash, rush: !!i.rush, target: null };
    M.stepRush(s, input, STEP);
    rows.push([sc.name, k, i.h, i.f, +!!i.sprint, +!!i.jump, +!!i.dodge, +!!i.dash, +!!i.rush, n(s.x), n(s.y), n(s.vx), n(s.vy), n(s.z), n(s.vz), n(s.dashTime), n(s.dodgeTime), n(s.rushTime), s.phase].join(','));
  }
  return rows;
}
const header = `# scenario,effect,effectUntil,energy\n# rows: scenario,step,h,f,sprint,jump,dodge,dash,rush,x,y,vx,vy,z,vz,dashTime,dodgeTime,rushTime,phase (state after the step; start x 500, y 1000, race time 10)`;
const body = SCENARIOS.flatMap(sc => [`#scenario,${sc.name},${sc.effect ?? ''},${sc.until ?? -1},${sc.energy ?? 0}`, ...trajectory(sc)]).join('\n');
const text = `${header}\n${body}\n`;
if (process.argv.includes('--check')) {
  const stored = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (stored !== text) { console.error('netcode-parity.csv is stale: run node scripts/rush-netcode-parity.mjs'); process.exit(1); }
  console.log('netcode-parity.csv matches the browser model');
} else { writeFileSync(file, text); console.log(`wrote ${SCENARIOS.length} scenarios × ${STEPS} steps`); }
