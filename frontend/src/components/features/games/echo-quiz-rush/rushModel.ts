/** Pure continuous-road simulation. Educational correctness arrives only via resolveGate. */
import { TRIALS, LANES, falls, hazardFor, hit as hazardHit, isRising, millPillar, respawnY, sill as sillAt, type Hazard } from './rushTrials';
import { REFORGED, drift6, falls6, hazardsAt, hit6, openHalf, pillar6, plane as wallPlane, respawnAt, respawnX6, respawnY6, shut, slide as wallSlide, touches, zone, type Orb, type Wall6 } from './rushReforged';

export type RushPhase = 'COUNTDOWN' | 'RUNNING' | 'VALIDATING' | 'OPENING' | 'STUMBLE' | 'FINISHING' | 'FINISHED' | 'PAUSED' | 'KNOCKED' | 'FALLING';
/** `jump` / `dodge` are one-shot requests (the scene clears them after each step). `forward` (version 6) is −1..1. */
export interface RushInput { horizontal: number; sprint: boolean; dash: boolean; rush: boolean; target: number | null; jump?: boolean; dodge?: boolean; forward?: number }
/** Physical moments the world and the audio react to (drained by the scene every step). */
export type RushMoment = 'JUMP' | 'LAND' | 'DODGE' | 'KNOCK' | 'FALL' | 'RESPAWN' | 'SILL' | 'RISE' | 'ORB' | 'SHIELD' | 'BUMP';
export interface RushState {
  phase: RushPhase; previousPhase: RushPhase; x: number; y: number; vx: number; speed: number;
  checkpoint: number; total: number; gates: number; selected: number; countdown: number; phaseTime: number;
  stamina: number; dashCooldown: number; dashTime: number; rushEnergy: number; rushTime: number;
  elapsed: number; distance: number; openGate: number; rejected: number; hitSerial: number; spacing: number; courseVersion: number; recoilFrom: number;
  /** Version 4 (Skybound): cumulative wall positions and the server-earned first-try streak. */
  boundaries: number[]; streak: number;
  /** Version 5 (Trials): height, jump / dodge, recovery, this racer's rising wall, and the server's course plan. */
  z: number; vz: number; jumpAt: number; landAt: number; dodgeTime: number; dodgeDir: number; dodgeCooldown: number; guard: number;
  kvx: number; kvy: number; riseStart: number; dropStart: number; dropFrom: number; hold: number; riseCheckpoint: number;
  hazards: Hazard[]; rising: boolean[]; jumps: number; dodges: number; knocks: number; falls: number; jumpSeq: number; dodgeSeq: number;
  landSpeed: number; moments: RushMoment[];
  /** Version 6 (Reforged): forward velocity, the crossing floor, door-slide carry, sealed doors, wall motion, orbs and buffs. */
  vy: number; floorY: number; lastSlide: number; sealed: number[]; walls: Wall6[]; orbs: Orb[]; taken: number[];
  speedUntil: number; shield: number; shieldUntil: number; shieldBlocks: number; dashX: number; dashY: number; lastOrb: string; orbSerial: number;
  /** Version 7: where the runner left the road (its respawn is chosen from there). */
  fallX: number; fallY: number;
  /** A rival's tactic on this racer (competition): ICE_LOCK / TIME_SNARE until race time `effectUntil` (server-decided). */
  effect: string; effectUntil: number;
}
export const ROAD = { left: 50, right: 950, spacing: 2800, reveal: 1700, readable: 1600, speed: 153, horizontal: 430, radius: 26, finishOffset: 700 };
/** Mirrors RushCompetition SKYBOUND constants exactly; the server is the authority in competitive races. */
export const SKYBOUND = { version: 4, base: 200, sprint: 270, dash: 410, dashTime: .25, rush: 320, horizontal: 470, momentumStep: .04, momentumCap: 5 };
export const skybound = (s: Pick<RushState,'courseVersion'|'boundaries'|'total'>) => s.courseVersion >= SKYBOUND.version && s.boundaries.length === s.total && s.total > 0;
export const trials = (s: Pick<RushState,'courseVersion'|'boundaries'|'total'>) => s.courseVersion >= TRIALS.version && skybound(s);
export const reforged = (s: Pick<RushState,'courseVersion'|'boundaries'|'total'|'walls'>) => s.courseVersion >= REFORGED.version && skybound(s) && s.walls.length === s.total;
/** Version 7 (Hardcore): no railings anywhere, harder knocks, falls that keep their momentum. */
export const hardcore = (s: Pick<RushState,'courseVersion'|'boundaries'|'total'|'walls'>) => s.courseVersion >= REFORGED.hardcore && reforged(s);
export const momentum = (s: Pick<RushState,'courseVersion'|'boundaries'|'total'|'streak'>) => skybound(s) ? 1 + SKYBOUND.momentumStep * Math.min(SKYBOUND.momentumCap, Math.max(0, s.streak)) : 1;
/** World position of checkpoint `index`'s wall. */
export const wallAt = (s: Pick<RushState,'courseVersion'|'boundaries'|'total'|'spacing'>, index: number) =>
  skybound(s) ? (index < 0 ? 0 : s.boundaries[Math.min(index, s.boundaries.length - 1)]) : (index + 1) * s.spacing;
export const segmentStart = (s: Pick<RushState,'courseVersion'|'boundaries'|'total'|'spacing'>, index: number) => index <= 0 ? 0 : wallAt(s, index - 1);
export const createRush = (total: number, checkpoint = 0, gates = 3, spacing = ROAD.spacing, courseVersion = 3, boundaries: number[] = [], hazards: Hazard[] = [], rising: boolean[] = [], walls: Wall6[] = [], orbs: Orb[] = []): RushState => {
  const s: RushState = {
    phase: 'COUNTDOWN', previousPhase: 'RUNNING', x: 500, y: 0, vx: 0, speed: 0,
    checkpoint, total, gates, selected: -1, countdown: 3, phaseTime: 0, stamina: 100, dashCooldown: 0,
    dashTime: 0, rushEnergy: 0, rushTime: 0, elapsed: 0, distance: 0, openGate: -1, rejected: -1, hitSerial: 0, spacing, courseVersion, recoilFrom: 0,
    boundaries: [...boundaries], streak: 0,
    z: 0, vz: 0, jumpAt: -1, landAt: -100, dodgeTime: 0, dodgeDir: 0, dodgeCooldown: 0, guard: 0, kvx: 0, kvy: 0,
    riseStart: -1, dropStart: -1, dropFrom: 0, hold: -1, riseCheckpoint: -1, hazards: [...hazards], rising: [...rising],
    jumps: 0, dodges: 0, knocks: 0, falls: 0, jumpSeq: 0, dodgeSeq: 0, landSpeed: 0, moments: [],
    vy: 0, floorY: -80, lastSlide: 0, sealed: [], walls: [...walls], orbs: [...orbs], taken: [],
    speedUntil: -1, shield: 0, shieldUntil: -1, shieldBlocks: 0, dashX: 0, dashY: 1, lastOrb: '', orbSerial: 0, fallX: 500, fallY: 0,
    effect: '', effectUntil: -1,
  };
  s.y = skybound(s) ? segmentStart(s, checkpoint) : checkpoint * spacing;
  if (reforged(s)) { if (checkpoint > 0) { s.y = segmentStart(s, checkpoint) + 40; s.floorY = segmentStart(s, checkpoint) + 30; } s.lastSlide = wallSlide(s.walls[checkpoint], 0); }
  return s;
};
export const gateCenter = (index: number, count: number) => ROAD.left + (index + .5) * (ROAD.right - ROAD.left) / count;
/** Collision half-width of a doorway for the runner's centre (the renderer draws the door at this + radius). */
export const doorHalfOpening = (s: Pick<RushState,'gates'|'spacing'>) => (ROAD.right - ROAD.left) / s.gates * (s.spacing > 1100 ? .22 : .38) - ROAD.radius;
export const gateAt = (x: number, count: number) => Math.min(count - 1, Math.max(0, Math.floor((x - ROAD.left) / ((ROAD.right - ROAD.left) / count))));
export const boundary = (state: RushState) => wallAt(state, state.checkpoint);
export const finishLine = (state: Pick<RushState,'courseVersion'|'boundaries'|'total'|'spacing'>) => skybound(state) ? state.boundaries[state.boundaries.length - 1] + ROAD.finishOffset : state.total * state.spacing + ROAD.finishOffset;
/** This racer's rising-wall sill now (0 for an ordinary wall). */
export const currentSill = (s: RushState) => trials(s) && s.riseCheckpoint === s.checkpoint ? sillAt(s.riseStart, s.dropStart, s.dropFrom, s.hold, s.elapsed) : 0;
export const currentHazard = (s: RushState) => trials(s) ? hazardFor(s.hazards, s.checkpoint) : null;
/** Version 6: this racer's current wall plane (moving walls advance toward the runner) and its door slide. */
export const currentPlane = (s: RushState) => reforged(s) && s.checkpoint < s.total ? wallPlane(s.walls[s.checkpoint], boundary(s), s.elapsed) : boundary(s);
export const currentSlide = (s: RushState) => reforged(s) && s.checkpoint < s.total ? wallSlide(s.walls[s.checkpoint], s.elapsed) : 0;
export function pauseRush(s: RushState) { if (s.phase !== 'PAUSED' && s.phase !== 'FINISHED') { s.previousPhase = s.phase; s.phase = 'PAUSED'; } }
export function resumeRush(s: RushState) { if (s.phase === 'PAUSED') s.phase = s.previousPhase; }
/** `streak` is the server's first-try streak after this answer (Skybound momentum); never computed here. */
export function resolveGate(s: RushState, correct: boolean, streak?: number) {
  if (s.phase !== 'VALIDATING' && !(s.phase === 'PAUSED' && s.previousPhase === 'VALIDATING')) return;
  const paused = s.phase === 'PAUSED';
  if (streak !== undefined && Number.isFinite(streak)) s.streak = Math.max(0, Math.floor(streak));
  s.phase = correct ? 'OPENING' : 'STUMBLE'; s.phaseTime = 0;
  if (correct) { s.openGate = s.selected; s.rushEnergy = Math.min(100, s.rushEnergy + 34); }
  else {
    s.rejected = s.selected; s.hitSerial++; s.dashTime = 0; s.rushTime = 0; s.recoilFrom = s.y;
    // Version 6: the sealed door throws the racer back (it stays stone for this question); a moving wall keeps pressing.
    if (reforged(s)) { if (s.selected >= 0 && !s.sealed.includes(s.selected)) s.sealed = [...s.sealed, s.selected]; s.kvx = 0; s.kvy = -REFORGED.recoil; s.vx = 0; s.vy = 0; }
    // A rising gate resumes its climb from where it held while the answer was checked.
    if (s.hold >= 0) { s.riseStart = s.elapsed - s.hold / TRIALS.riseRate; s.dropStart = -1; s.hold = -1; }
  }
  if (paused) pauseRush(s);
}
function airborne(s: RushState, dt: number) {
  if (s.z <= 0 && s.vz <= 0) { s.z = 0; s.vz = 0; return; }
  s.z += s.vz * dt; s.vz -= TRIALS.gravity * dt;
  if (s.z <= 0) { s.landSpeed = -s.vz; s.z = 0; s.vz = 0; s.landAt = s.elapsed; s.moments.push('LAND'); }
}
/** Mirrors RushCompetition.dodge: held steering, else the current drift, else toward the open side. Ground only. */
function dodge(s: RushState, horizontal: number) {
  if (s.phase !== 'RUNNING' || s.dodgeCooldown > 0 || s.z > 0 || s.effect === 'ICE_LOCK') return false;
  s.dodgeDir = horizontal !== 0 ? Math.sign(horizontal) : Math.abs(s.vx) > 20 ? Math.sign(s.vx) : s.x < 500 ? 1 : -1;
  s.dodgeTime = TRIALS.dodgeTime; s.dodgeCooldown = TRIALS.dodgeCooldown; s.dodges++; s.moments.push('DODGE'); return true;
}
function knock(s: RushState, vx: number, vy: number) {
  // Version 7: a hit carries real force — near an open edge it can throw the runner into the abyss.
  const sx = hardcore(s) ? REFORGED.knock7X : 1, sy = hardcore(s) ? REFORGED.knock7Y : 1;
  s.phase = 'KNOCKED'; s.phaseTime = 0; s.kvx = vx * sx; s.kvy = vy * sy; s.vz = Math.max(s.vz, s.z > 0 ? 0 : 220); s.speed = 0; s.dashTime = 0; s.rushTime = 0; s.dodgeTime = 0;
  s.guard = TRIALS.hitGuard; s.knocks++; s.jumpAt = -1; s.moments.push('KNOCK');
}
function fall(s: RushState) {
  // Version 7: the fall keeps the momentum of the step (or the knock) that took the runner off the road.
  const keep = hardcore(s), knocked = s.phase === 'KNOCKED', carryX = keep ? (knocked ? s.kvx : s.vx) : 0, carryY = keep ? (knocked ? s.kvy : s.vy) * .6 : 0;
  s.fallX = s.x; s.fallY = s.y;
  s.phase = 'FALLING'; s.phaseTime = 0; s.speed = 0; s.vx = 0; s.dashTime = 0; s.rushTime = 0; s.dodgeTime = 0; s.kvx = carryX; s.kvy = carryY; s.vz = 0; s.falls++; s.jumpAt = -1; s.moments.push('FALL');
}

/** Each call is a fixed 1/120s step in production; swept boundary works at larger test steps too. */
export function stepRush(s: RushState, input: RushInput, dt: number): 'GATE' | 'POST' | 'NEXT' | 'FINISH' | null {
  if (!Number.isFinite(dt) || dt <= 0 || dt > .1 || s.phase === 'PAUSED') return null;
  if(s.phase==='FINISHED'){s.phaseTime+=dt;return null;}
  s.phaseTime += dt;
  if (s.phase === 'COUNTDOWN') { s.countdown -= dt; if (s.countdown <= 0) { s.phase = s.checkpoint >= s.total ? 'FINISHING' : 'RUNNING'; s.phaseTime = 0; } return null; }
  if (reforged(s)) return stepReforged(s, input, dt);
  s.elapsed += dt; s.dashCooldown = Math.max(0, s.dashCooldown - dt);
  s.dashTime = Math.max(0, s.dashTime - dt); s.rushTime = Math.max(0, s.rushTime - dt);
  const v5 = trials(s);
  if (v5) {
    s.dodgeCooldown = Math.max(0, s.dodgeCooldown - dt); s.dodgeTime = Math.max(0, s.dodgeTime - dt); s.guard = Math.max(0, s.guard - dt);
    if (s.riseCheckpoint !== s.checkpoint) { s.riseCheckpoint = s.checkpoint; s.riseStart = -1; s.dropStart = -1; s.hold = -1; }
  }
  // On a rising sill the racer stands on it while the answer is checked; at an ordinary door they land in the doorway.
  if (s.phase === 'VALIDATING') { s.speed = 0; if (v5) { if (s.hold >= 0) { s.vz = 0; s.z = s.hold; } else airborne(s, dt); } return null; }
  if (s.phase === 'STUMBLE') {
    s.speed = 0;
    const t = Math.min(1, s.phaseTime / .32), ease = t*t*(3-2*t);
    s.y = s.recoilFrom + (Math.min(s.recoilFrom, boundary(s)-95)-s.recoilFrom)*ease;
    if (v5) airborne(s, dt);
    if (s.phaseTime > .7) { s.phase = 'RUNNING'; s.phaseTime = 0; } return null;
  }
  if (s.phase === 'OPENING') {
    s.speed = 0;
    if (s.phaseTime >= .48) {
      s.speed = v5 ? TRIALS.base : skybound(s) ? SKYBOUND.base : ROAD.speed; s.y += s.speed * dt; s.distance += s.speed * dt;
      if (v5 && s.y > boundary(s) + 10) airborne(s, dt);
      if (s.y >= boundary(s) + 65) {
        s.checkpoint++; s.openGate = -1; s.selected = -1; s.rejected = -1; s.phaseTime = 0;
        s.phase = s.checkpoint === s.total ? 'FINISHING' : 'RUNNING'; return 'NEXT';
      }
    } return null;
  }
  if (s.phase === 'FINISHING') {
    s.vx=(500-s.x)*3;s.x+=s.vx*dt;
    s.speed = v5 ? TRIALS.sprint * momentum(s) : skybound(s) ? SKYBOUND.sprint * momentum(s) : ROAD.speed; s.y += s.speed * dt; s.distance += s.speed * dt;
    if (v5) airborne(s, dt);
    if (s.courseVersion >= 3 ? s.y >= finishLine(s) : s.phaseTime >= 2) { if(s.courseVersion>=3)s.y=finishLine(s);s.phase = 'FINISHED'; s.phaseTime=0;return 'FINISH'; } return null;
  }
  if (v5 && s.phase === 'FALLING') {
    s.speed = 0; s.vx = 0; s.z = -.5 * TRIALS.gravity * .6 * s.phaseTime * s.phaseTime;
    if (s.phaseTime >= TRIALS.fallTime) {
      const h = currentHazard(s);
      s.y = Math.max(segmentStart(s, s.checkpoint) + 70, h ? respawnY(h) : s.y - TRIALS.respawnBack);
      if (h && h.lane >= 0) s.x = LANES[h.lane];
      s.z = 0; s.vz = 0; s.kvx = s.kvy = 0; s.phase = 'RUNNING'; s.phaseTime = 0; s.guard = TRIALS.respawnGuard; s.moments.push('RESPAWN');
    }
    return null;
  }
  if (v5 && s.phase === 'KNOCKED') {
    const decay = Math.exp(-5 * dt);
    s.x = Math.max(76, Math.min(924, s.x + s.kvx * dt)); s.y = Math.max(segmentStart(s, s.checkpoint) + 70, s.y + s.kvy * dt); s.kvx *= decay; s.kvy *= decay; s.speed = 0; s.vx = 0;
    airborne(s, dt);
    if (s.z <= 0 && falls(currentHazard(s), s.x, s.y)) { fall(s); return null; }
    if (s.phaseTime >= TRIALS.knockTime) { s.phase = 'RUNNING'; s.phaseTime = 0; }
    return null;
  }
  const v4 = skybound(s);
  if (input.dash && s.dashCooldown <= 0) { s.dashTime = v4 ? SKYBOUND.dashTime : .23; s.dashCooldown = 4; }
  if (input.rush && s.rushEnergy >= 100 && s.rushTime <= 0) { s.rushTime = 3; s.rushEnergy = 0; }
  if (v5 && input.jump) { s.jumpSeq++; s.jumpAt = s.elapsed; }
  if (v5 && input.dodge) { s.dodgeSeq++; dodge(s, input.horizontal); }
  let horizontal = Math.max(-1, Math.min(1, input.horizontal));
  if (input.target !== null) horizontal = Math.abs(input.target - s.x) > 5 ? Math.sign(input.target - s.x) : 0;
  // A landing takes a breath (jumpRecover) before the next take-off; a press just before it is buffered.
  if (v5 && s.jumpAt >= 0) {
    if (s.z <= 0 && s.vz <= 0 && s.elapsed - s.landAt >= TRIALS.jumpRecover) { s.vz = TRIALS.jumpSpeed; s.jumps++; s.jumpAt = -1; s.moments.push('JUMP'); }
    else if (s.elapsed - s.jumpAt > TRIALS.jumpBuffer) s.jumpAt = -1;
  }
  if (v5 && s.dodgeTime > 0) s.vx = s.dodgeDir * TRIALS.dodgeSpeed;
  else s.vx += (horizontal * (v5 ? TRIALS.lateral : v4 ? SKYBOUND.horizontal : ROAD.horizontal) - s.vx) * Math.min(1, dt * 28);
  const oldX = s.x;
  const nextX = s.x + s.vx * dt;
  s.x = Math.max(ROAD.left + ROAD.radius, Math.min(ROAD.right - ROAD.radius, nextX));
  if (input.target !== null && !(v5 && s.dodgeTime > 0) && (input.target - oldX) * (input.target - nextX) <= 0) s.x = input.target;
  const sprint = input.sprint && s.stamina > 0;
  s.stamina = Math.max(0, Math.min(100, s.stamina + (sprint ? -30 : 19) * dt));
  const desired = v5
    ? (s.dashTime > 0 ? TRIALS.dash : s.rushTime > 0 ? TRIALS.rush : sprint ? TRIALS.sprint : TRIALS.base) * momentum(s)
    : v4
    ? (s.dashTime > 0 ? SKYBOUND.dash : s.rushTime > 0 ? SKYBOUND.rush : sprint ? SKYBOUND.sprint : SKYBOUND.base) * momentum(s)
    : s.dashTime > 0 ? 330 : s.rushTime > 0 ? 255 : sprint ? 210 : ROAD.speed;
  s.speed += (desired - s.speed) * Math.min(1, dt * 18);
  const nextY = s.y + s.speed * dt;
  if (v5) {
    airborne(s, dt);
    const h = currentHazard(s);
    if (h) {
      s.x = millPillar(h, s.x, nextY);
      if (s.z <= 0 && falls(h, s.x, nextY)) { s.y = nextY; s.distance += s.speed * dt; fall(s); return null; }
      if (s.guard <= 0) { const contact = hazardHit(h, s.elapsed, s.x, nextY, s.z); if (contact) { s.y = nextY; knock(s, contact.vx, contact.vy); return null; } }
    }
    // Arm this racer's rising wall as they enter its approach; the sill begins to climb after a visible wait.
    if (isRising(s.rising, s.checkpoint) && s.riseStart < 0 && nextY >= boundary(s) - TRIALS.riseZone) { s.riseStart = s.elapsed + TRIALS.riseWait; s.moments.push('RISE'); }
  }
  if (nextY >= boundary(s) - ROAD.radius) {
    const index=gateAt(s.x,s.gates),halfOpening=doorHalfOpening(s),sill=currentSill(s);
    if (v5 && sill > s.z + TRIALS.sillStep) {
      // The sill rose above this racer's reach: bounce off the plinth; the gate settles and climbs again.
      s.y=boundary(s)-ROAD.radius;s.recoilFrom=s.y;s.phase='STUMBLE';s.phaseTime=0;s.selected=-1;s.hitSerial++;s.dashTime=0;s.rushTime=0;s.speed=0;
      s.dropStart = s.elapsed; s.dropFrom = sill; s.riseStart = s.elapsed + TRIALS.dropTime + TRIALS.rearm; s.moments.push('SILL');
      return 'POST';
    }
    if(Math.abs(s.x-gateCenter(index,s.gates))>halfOpening){
      s.y=boundary(s)-ROAD.radius;s.recoilFrom=s.y;s.phase='STUMBLE';s.phaseTime=0;s.selected=-1;s.hitSerial++;s.dashTime=0;s.rushTime=0;s.speed=0;
      return 'POST';
    }
    s.y = boundary(s) - ROAD.radius; s.selected = index; s.phase = 'VALIDATING'; s.phaseTime = 0;
    if (v5 && sill > 0) { s.hold = sill; s.z = Math.max(s.z, sill); s.vz = 0; }
    return 'GATE';
  }
  s.distance += s.speed * dt; s.y = nextY;
  return null;
}
// ───────────────────────────── Version 6 (Reforged) ─────────────────────────────
/** Mirrors RushCompetition.doorHalf. */
export const doorHalf6 = (count: number) => 900 / count * .22 - ROAD.radius;
/** The crossing floor always; on version 6 also the railings (version 7 has none: an edge is a drop). */
function floorAndRails(s: RushState, hz: Hazard[], open: boolean) {
  if (s.y < s.floorY) { s.y = s.floorY; s.vy = Math.max(0, s.vy); }
  if (!open && openHalf(hz, s.y) < 0) { const c = Math.max(500 - REFORGED.rail, Math.min(500 + REFORGED.rail, s.x)); if (c !== s.x) { s.x = c; s.vx = 0; } }
}
function pressed(s: RushState, front: number) { if (s.checkpoint < s.total && s.y > front) { s.y = front; s.vy = Math.min(s.vy, 0); } }
function collect(s: RushState, y: number) {
  for (const o of s.orbs) {
    if (o.checkpoint !== s.checkpoint || s.taken.includes(o.id) || !touches(o, s.x, y, s.z)) continue;
    s.taken = [...s.taken, o.id]; s.orbSerial++; s.lastOrb = o.kind; s.moments.push('ORB');
    if (o.kind === 'SPEED') s.speedUntil = s.elapsed + REFORGED.speedTime;
    else if (o.kind === 'ENERGY') s.rushEnergy = Math.min(100, s.rushEnergy + REFORGED.energyOrb);
    else { s.shield = 1; s.shieldUntil = s.elapsed + REFORGED.shieldTime; }
  }
}
function respawn6(s: RushState, hz: Hazard[]) {
  if (hardcore(s)) {
    const [x, y] = respawnAt(hz, s.fallX, s.fallY); let at = Math.max(s.floorY + 20, y);
    if (s.checkpoint < s.total) at = Math.min(at, currentPlane(s) - ROAD.radius - 60);
    s.x = x; s.y = at;
  } else {
    let h = zone(hz, s.y); if (!h) for (const c of hz) if (c.from <= s.y + 1) h = c;
    s.y = Math.max(s.floorY + 20, h ? respawnY6(h) : s.y - REFORGED.respawnBack); s.x = h ? respawnX6(h) : 500;
  }
  s.z = 0; s.vz = 0; s.vx = 0; s.vy = 0; s.kvx = s.kvy = 0; s.phase = 'RUNNING'; s.phaseTime = 0; s.guard = TRIALS.respawnGuard; s.moments.push('RESPAWN');
}
/**
 * One step of a version 6 racer — the mirror of RushCompetition.move6. There is no automatic movement: speed comes
 * only from the player's input (or a dash, a knock, wind or a drifting stone).
 */
export function stepReforged(s: RushState, input: RushInput, dt: number): 'GATE' | 'POST' | 'NEXT' | 'FINISH' | null {
  s.elapsed += dt; const t = s.elapsed;
  // One-shot requests act where the authority applies them: on arrival, before the step runs its timers down
  // (RushCompetition.input / boost / dodge), so a dash, an Echo Rush and a dodge last exactly as long as on the server.
  if (input.jump) { s.jumpSeq++; s.jumpAt = t - dt; }
  if (s.phase === 'RUNNING') {
    if (input.dash && s.dashCooldown <= 0) {
      s.dashTime = SKYBOUND.dashTime; s.dashCooldown = 4;
      let h0 = input.horizontal, f0 = input.forward ?? 0, l0 = Math.hypot(h0, f0); if (l0 < .05) { h0 = 0; f0 = 1; l0 = 1; } s.dashX = h0 / l0; s.dashY = f0 / l0;
    }
    if (input.rush && s.rushEnergy >= 100 && s.rushTime <= 0) { s.rushTime = 3; s.rushEnergy = 0; }
  }
  if (input.dodge) { s.dodgeSeq++; dodge(s, input.horizontal); }
  s.dashCooldown = Math.max(0, s.dashCooldown - dt); s.dashTime = Math.max(0, s.dashTime - dt); s.rushTime = Math.max(0, s.rushTime - dt);
  s.dodgeCooldown = Math.max(0, s.dodgeCooldown - dt); s.dodgeTime = Math.max(0, s.dodgeTime - dt); s.guard = Math.max(0, s.guard - dt);
  if (s.shield > 0 && t >= s.shieldUntil) s.shield = 0;
  if (t >= s.effectUntil) s.effect = '';
  if (s.riseCheckpoint !== s.checkpoint) { s.riseCheckpoint = s.checkpoint; s.riseStart = -1; s.dropStart = -1; s.hold = -1; }
  const hz = hazardsAt(s.hazards, s.checkpoint), gated = s.checkpoint < s.total, open = hardcore(s);
  const w = gated ? s.walls[s.checkpoint] : null, count = s.gates;
  const planeY = gated ? wallPlane(w, boundary(s), t) : 0, slideNow = gated ? wallSlide(w, t) : 0, front = planeY - ROAD.radius, half = doorHalf6(count);
  const carry = slideNow - s.lastSlide; s.lastSlide = slideNow;
  if (s.phase === 'VALIDATING') { s.vx = s.vy = 0; s.speed = 0; s.y = front; s.x += carry; if (s.hold >= 0) { s.vz = 0; s.z = s.hold; } else airborne(s, dt); return null; }
  if (s.phase === 'OPENING') { s.vx = s.vy = 0; s.speed = 0; s.y = front; s.x += carry; airborne(s, dt); if (s.phaseTime >= .48) { s.phase = 'RUNNING'; s.phaseTime = 0; } return null; }
  if (s.phase === 'STUMBLE') {
    const decay = Math.exp(-6 * dt); s.y += s.kvy * dt; s.kvy *= decay; s.vx = 0; s.vy = 0; s.speed = 0; floorAndRails(s, hz, open); pressed(s, front); airborne(s, dt);
    if (s.phaseTime >= REFORGED.stumbleTime) { s.phase = 'RUNNING'; s.phaseTime = 0; } return null;
  }
  if (s.phase === 'FALLING') {
    s.speed = 0; s.vx = s.vy = 0;
    // Version 7: the body keeps the momentum it left the road with (eased by air), never through a wall.
    if (open) { const decay = Math.exp(-REFORGED.fallDrag * dt); s.x += s.kvx * dt; s.y = Math.max(s.floorY, s.y + s.kvy * dt); if (gated) s.y = Math.min(s.y, front); s.kvx *= decay; s.kvy *= decay; }
    s.z = -.5 * TRIALS.gravity * .6 * s.phaseTime * s.phaseTime; if (s.phaseTime >= TRIALS.fallTime) respawn6(s, hz); return null;
  }
  if (s.phase === 'KNOCKED') {
    const decay = Math.exp(-5 * dt); s.x += s.kvx * dt; s.y += s.kvy * dt; s.kvx *= decay; s.kvy *= decay; s.vx = s.vy = 0; s.speed = 0; floorAndRails(s, hz, open); pressed(s, front); airborne(s, dt);
    if (s.z <= 0 && falls6(hz, s.x, s.y, t, open)) { fall(s); return null; }
    if (s.phaseTime >= TRIALS.knockTime) { s.phase = 'RUNNING'; s.phaseTime = 0; } return null;
  }
  if (s.phase !== 'RUNNING' && s.phase !== 'FINISHING') return null;
  let h =Math.max(-1, Math.min(1, input.horizontal)), f = Math.max(-1, Math.min(1, input.forward ?? 0));
  // Tactics act inside the step exactly where the authority applies them (move6): Ice Lock takes the steering, Time Snare
  // caps the speed before it is integrated and the forward velocity before the step moves the runner.
  if (s.effect === 'ICE_LOCK') h = 0;
  let len = Math.hypot(h, f); if (len > 1) { h /= len; f /= len; len = 1; }
  const moving = len > .05, air = s.z > 0 || s.vz > 0, sprint = input.sprint && s.stamina > 0 && moving;
  s.stamina = Math.max(0, Math.min(100, s.stamina + (sprint ? -30 : 19) * dt));
  let sp: number = s.rushTime > 0 ? REFORGED.rush : sprint ? REFORGED.sprint : REFORGED.move;
  sp *= momentum(s); if (t < s.speedUntil) sp *= REFORGED.speedOrb; if (s.effect === 'TIME_SNARE') sp = Math.min(sp, REFORGED.snare);
  if (s.dashTime > 0) { const d = REFORGED.dash * momentum(s); s.vx = s.dashX * d / TRIALS.kx; s.vy = s.dashY * d / TRIALS.ky; }
  else { const k = Math.min(1, dt * (air ? REFORGED.air : moving ? REFORGED.accel : REFORGED.brake)); s.vx += (h * sp / TRIALS.kx - s.vx) * k; s.vy += (f * sp * (f < 0 ? REFORGED.back : 1) / TRIALS.ky - s.vy) * k; }
  if (s.effect === 'TIME_SNARE') s.vy = Math.min(s.vy, REFORGED.snare / TRIALS.ky);
  if (s.jumpAt >= 0) {
    if (s.z <= 0 && s.vz <= 0 && s.elapsed - s.landAt >= TRIALS.jumpRecover) { s.vz = TRIALS.jumpSpeed; s.jumps++; s.jumpAt = -1; s.moments.push('JUMP'); }
    else if (s.elapsed - s.jumpAt > TRIALS.jumpBuffer) s.jumpAt = -1;
  }
  if (s.dodgeTime > 0) s.vx = s.dodgeDir * TRIALS.dodgeSpeed;
  const y0 = s.y; let nextX = s.x + (s.vx + drift6(hz, s.x, s.y, t, !air)) * dt, nextY = s.y + s.vy * dt;
  if (nextY < s.floorY) { nextY = s.floorY; s.vy = Math.max(0, s.vy); }
  // Version 6 railings (with their end posts); version 7 has none.
  if (!open && openHalf(hz, nextY) < 0 && openHalf(hz, s.y) >= 0 && Math.abs(nextX - 500) > REFORGED.rail) { nextY = s.y; s.vy = 0; }
  if (!open && openHalf(hz, nextY) < 0) { const c = Math.max(500 - REFORGED.rail, Math.min(500 + REFORGED.rail, nextX)); if (c !== nextX) { nextX = c; s.vx = 0; } }
  let doorway = gated && s.openGate >= 0 && y0 > front - 1; const door = gated && s.openGate >= 0 ? gateCenter(s.openGate, count) + slideNow : 500;
  if (doorway && Math.abs(s.x - door) <= half + .5) nextX = Math.max(door - half, Math.min(door + half, nextX)); else doorway = false;
  s.x = pillar6(hz, nextX, nextY);
  airborne(s, dt);
  s.speed = Math.hypot(s.vx * TRIALS.kx, s.vy * TRIALS.ky) / TRIALS.ky;
  s.distance += Math.abs(nextY - y0);
  if (s.z <= 0 && falls6(hz, s.x, nextY, t, open)) { s.y = nextY; fall(s); return null; }

  if (s.guard <= 0) for (const hazard of hz) {
    const contact = hit6(hazard, t, s.x, nextY, s.z); if (!contact) continue;
    if (s.shield > 0) { s.shield = 0; s.shieldBlocks++; s.guard = REFORGED.shieldGuard; s.moments.push('SHIELD'); break; }
    s.y = nextY; knock(s, contact.vx, contact.vy); return null;
  }
  collect(s, nextY);
  if (!gated) { s.y = nextY; if (s.y >= finishLine(s)) { s.y = finishLine(s); s.phase = 'FINISHED'; s.phaseTime = 0; s.speed = 0; s.vx = s.vy = 0; return 'FINISH'; } return null; }
  if (isRising(s.rising, s.checkpoint) && s.riseStart < 0 && nextY >= boundary(s) - TRIALS.riseZone) { s.riseStart = t + TRIALS.riseWait; s.moments.push('RISE'); }
  if (doorway || nextY >= front && s.openGate >= 0 && Math.abs(s.x - door) <= half) {
    if (nextY >= planeY + 65) {
      s.checkpoint++; s.floorY = planeY + 30; s.openGate = -1; s.selected = -1; s.rejected = -1; s.phaseTime = 0; s.y = nextY; s.sealed = [];
      s.phase = s.checkpoint === s.total ? 'FINISHING' : 'RUNNING'; s.lastSlide = s.checkpoint < s.total ? wallSlide(s.walls[s.checkpoint], t) : 0; return 'NEXT';
    }
    s.y = nextY; return null;
  }
  if (nextY >= front) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((s.x - slideNow - 50) / (900 / count))));
    const inside = Math.abs(s.x - slideNow - gateCenter(index, count)) <= half, sill = currentSill(s);
    if (sill > s.z + TRIALS.sillStep) {
      s.y = front; s.phase = 'STUMBLE'; s.phaseTime = 0; s.kvy = -REFORGED.bump; s.selected = -1; s.dashTime = 0; s.vx = s.vy = 0; s.hitSerial++;
      s.dropStart = t; s.dropFrom = sill; s.riseStart = t + TRIALS.dropTime + TRIALS.rearm; s.moments.push('SILL'); return 'POST';
    }
    if (inside && s.openGate < 0 && !shut(w, t) && !s.sealed.includes(index)) {
      s.y = front; s.selected = index; s.phase = 'VALIDATING'; s.phaseTime = 0; s.speed = 0; s.vx = s.vy = 0;
      if (sill > 0) { s.hold = sill; s.z = Math.max(s.z, sill); s.vz = 0; }
      return 'GATE';
    }
    if (s.vy > REFORGED.bumpSpeed) { s.y = front; s.phase = 'STUMBLE'; s.phaseTime = 0; s.kvy = -REFORGED.bump; s.selected = -1; s.dashTime = 0; s.vx = s.vy = 0; s.hitSerial++; s.moments.push('BUMP'); return 'POST'; }
    nextY = front; s.vy = Math.min(s.vy, 0);
  }
  s.y = nextY; pressed(s, front);
  return null;
}
export function frameStats(frames: number[]) {
  const values = frames.filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!values.length) return null;
  const quantile = (p: number) => values[Math.min(values.length - 1, Math.floor(values.length * p))];
  return { frames: values.length, fps: 1000 / (values.reduce((a,b) => a + b, 0) / values.length), median: quantile(.5), p95: quantile(.95), p99: quantile(.99), worst: values[values.length - 1], over25: values.filter(x => x > 25).length, over50: values.filter(x => x > 50).length };
}
/** Mirrors RushCompetition.segmentLength: 80 road units per word (prompt, context, every choice) + 1,200, clamped 1,700–4,200. */
export function skyboundWalls(questions: { prompt: string; context: string; options: { label: string }[] }[]) {
  let at = 0;
  return questions.map(q => {
    const words = [q.prompt, q.context, ...q.options.map(o => o.label)].join(' ').trim().split(/\s+/).length;
    at += Math.max(1700, Math.min(4200, 1200 + 80 * words));
    return at;
  });
}
