'use client';

import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { CompetitiveState, CompetitiveInput } from '@/types/quizRushCompetitive';
import type { RushQuestion } from '@/types/quizRush';
import { boundary, createRush, currentHazard, currentPlane, currentSill, currentSlide, doorHalf6, doorHalfOpening, finishLine, frameStats, gateAt, gateCenter, hardcore, pauseRush, reforged, resolveGate, resumeRush, ROAD, stepRush, trials, wallAt } from './rushModel';
import type { RushInput, RushMoment, RushState } from './rushModel';
import { MILL, RAMS, TRIALS, boulders, impacts, millAngle, millCenter, ramOffset, ramY, rows, type Boulder, type Hazard, type HazardKind } from './rushTrials';
import { CRUMBLE, REFORGED, approach as wallApproach, closure, crumbleTiles, crushRows, crushY, driftRows, driftX, driftY, gust, gustWarning, hazardsAt, logCount, logFrom, logTo, logX, pegAngle, pegsIn, ringCount, ringY, sawDouble, sawRows, sawX, sawY, shut, shutter, stepRows, stepShake, stepY, surfaceHeight, tileShake, type Orb, type OrbKind, type Wall6, type WallKind6 } from './rushReforged';
import { InputHistory, InputLead, RaceClock, RivalBuffer, SimClock, STEP } from './rushNet';
import type { RushHero } from './sky/skyCharacter';
import { SkyWorld, detectQuality, type Quality, type WorldEvent, type WorldFrame, type WorldRacer } from './sky/skyWorld';
import { MouseLook } from '@/lib/embodiment/mouseLook';
import { useSharedKeys } from '@/lib/hud/sharedKeys';
import { RUSH_KEYS, rushView } from './rushView';

export interface SceneHandle {
  input: RushInput; state: RushState; resolve: (correct: boolean, streak?: number) => void;
  advance: (question: RushQuestion | null) => void; pause: () => void; resume: () => void; celebrate: () => void;
  /** One-shot actions shared by the keyboard and the on-screen buttons (the same path for both). */
  jump: () => void; dodge: (direction?: number) => void;
  /** Version 6: the touch joystick (−1..1 each axis, 0/0 = stand still) and the answer highlight (never moves the runner). */
  setMove: (horizontal: number, forward: number) => void; aim: (index: number) => void;
}
export interface SceneHud {
  phase: string; countdown: number; elapsed: number; stamina: number; dash: number; energy: number; checkpoint: number; skill: string;
  streak: number; aim: number; tried: number[]; remaining: number; segment: number; rank: number; racers: number; progress: { id: string; t: number; local: boolean; look: number }[];
  /** Version 5: the obstacle ahead (kind and distance), this racer's rising wall, jump / dodge readiness and protection. */
  hazard: { kind: HazardKind; distance: number; inside: boolean } | null;
  rising: { armed: boolean; sill: number; reach: number } | null;
  airborne: boolean; dodge: number; guard: number; trials: boolean; knocks: number; falls: number;
  /** Version 6: manual movement, the current wall's motion, buffs from orbs and the last pickup. */
  reforged: boolean; wall: { kind: WallKind6; distance: number; moving: boolean; closed: boolean } | null;
  speedBuff: number; shield: number; orb: { kind: OrbKind; serial: number } | null; marked: number; moving: boolean;
}
export type WorldAudio = 'gate-open' | 'gate-pass' | 'footstep' | 'dash' | 'rush' | 'finish' | 'overtake' | 'near-gate'
  | 'jump' | 'land' | 'dodge' | 'knock' | 'fall' | 'respawn' | 'sill' | 'rise' | 'hazard' | 'swoosh' | 'whistle' | 'boom' | 'sprint'
  | 'slam' | 'gust' | 'crack' | 'crumble' | 'shutter' | 'wall-hit' | 'orb-speed' | 'orb-energy' | 'orb-guard' | 'shield' | 'bump';
interface Props {
  total: number; checkpoint: number; question: RushQuestion | null; reduced: boolean; stress?: boolean; spacing?: number; courseVersion?: number; localLabel?: string;
  boundaries?: number[]; streak?: number; celebrate?: boolean; hazards?: Hazard[]; rising?: boolean[]; walls?: Wall6[]; orbs?: Orb[];
  /** The local racer's hero (cosmetic only). */
  hero?: RushHero;
  /** What the local player wears (`lib/avatar/look.ts`). */
  avatar?: string;
  onReady: (handle: SceneHandle) => void; onGate: (index: number) => void; onNext: () => void; onFinish: () => void;
  /** A physical setback: bumped a door frame, bounced off a risen sill, hit by an obstacle, or fell. */
  onHud: (hud: SceneHud) => void; onHidden: () => void; onError: () => void; onObstacle: (kind: 'post' | 'sill' | 'knock' | 'fall') => void;
  /** World sounds; `value` carries a pace (footsteps), a strength (landing) or a hazard kind code. */
  onWorldAudio?: (event: WorldAudio, value?: number, pan?: number) => void;
  /** Continuous obstacle ambience levels (0..1) with a stereo position. */
  onAmbience?: (kind: 'rumble' | 'wind' | 'grind' | 'saw' | 'hum', level: number, pan: number) => void;
  network?: { enabled: () => boolean; snapshot: MutableRefObject<CompetitiveState | null>; onInput: (input: CompetitiveInput, urgent?: boolean) => void; onBoost: (kind: 'dash' | 'rush') => void; localLabel: string; rtt?: () => number | null;
    /** When (performance.now ms) this tab sent input `seq`: the input-lead measurement. */
    sentAt?: (seq: number) => number | undefined };
  /** Mouse-look taken or let go (the HUD steps aside while it is on). */
  onLock?: (locked: boolean) => void;
}
const look = (id: string) => Math.max(0, Number(id.slice(1)) - 1);
const HAZARD_CODE: Record<HazardKind, number> = { MILL: 1, RAMS: 2, BOULDERS: 3, SKYFALL: 4, CHASM: 5, SAWS: 6, CRUSHER: 7, GALE: 8, CRUMBLE: 9, DRIFT: 10, BEAM: 11, STEPS: 12, TILT: 13, ROLLER: 14 };
/** Version 6 keys (physical positions, so every keyboard layout plays the same): movement only from these. */
const MOVE_KEYS: Record<string, [number, number]> = { KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] };
const GAME_CODES = new Set([...Object.keys(MOVE_KEYS), 'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'KeyF', 'KeyE', 'Digit1', 'Digit2', 'Digit3', 'Digit4']);

export default function RushScene(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null), latest = useRef(props);
  latest.current = props;
  // The camera key switches between behind the runner and through their eyes; the mouse-look key turns the head (the race never changes).
  const mouseRef = useRef<MouseLook | null>(null);
  useSharedKeys({ camera: () => rushView.toggle(), mouse: () => mouseRef.current?.toggle() }, { taken: RUSH_KEYS });
  useEffect(() => {
    const canvas = canvasRef.current!;
    let world: SkyWorld;
    let quality: Quality = detectQuality();
    try { world = new SkyWorld(canvas, quality, () => latest.current.onError()); }
    catch { latest.current.onError(); return; }
    world.setView(rushView.get());
    const offView = rushView.subscribe(() => world.setView(rushView.get()));
    // Mouse-look: a click on the course (or the key) takes the pointer, the head turns with the mouse, Esc gives it back.
    const mouse = new MouseLook(canvas, look => { world.setLookHeld(look.locked); latest.current.onLock?.(look.locked); });
    mouseRef.current = mouse;
    const turnHead = (e: MouseEvent) => { if (document.pointerLockElement === canvas) world.lookBy(e.movementX, e.movementY); };
    const takePointer = (e: PointerEvent) => { if (e.button === 0 && e.pointerType === 'mouse' && !mouse.locked && state.phase !== 'FINISHED' && state.phase !== 'PAUSED') mouse.enable(); };
    document.addEventListener('mousemove', turnHead);
    canvas.addEventListener('pointerdown', takePointer);
    const spacing = props.spacing ?? ROAD.spacing;
    let disposed = false, raf = 0, last = 0, accumulator = 0, hudAt = 0, celebrating = !!props.celebrate, readyStarted = false, hiddenHeartbeat = 0;
    const rushDebugQuery = typeof window !== 'undefined' && typeof window.location?.search === 'string' && new URLSearchParams(window.location.search).get('rushDebug') === '1';
    const isDebugDatasetOn = () =>
      process.env.NODE_ENV !== 'production' ||
      rushDebugQuery ||
      Boolean((window as unknown as { __EC_RUSH_DEBUG__?: boolean }).__EC_RUSH_DEBUG__);
    let serializedWalls: Wall6[] | null = null;
    let serializedOrbs: Orb[] | null = null;
    let serializedHazards: Hazard[] | null = null;
    let serializedRising: boolean[] | null = null;
    let serializedLabelsKey = '';
    let serializedTakenKey = '';
    let q = props.question, accepted: CompetitiveState | null = null, displayX = 500, displayY = 0, displayZ = 0, initialized = false;
    const passedGates = new Map<number, { gates: number; openGate: number; boundary: number }>();
    // Multiplayer (course version 6+): the estimated authority clock, what this racer held at every step (replayed over each
    // snapshot), rivals interpolated by server time, and a display offset that eases out an authoritative correction.
    // `arrivals` follows the snapshots' own timeline (no delay term): rivals are drawn between snapshots already here, and
    // the local runner simulates ahead of it by the measured input lead (`lead`) on a clock that never rewinds (`sim`).
    const arrivals = new RaceClock(), sim = new SimClock(), lead = new InputLead(), history = new InputHistory(), rivals = new RivalBuffer();
    const visual = { x: 0, y: 0, z: 0 }, prevStep = { x: 0, y: 0, z: 0 };
    let serverCheckpoint = props.checkpoint;
    const crossed = new Set<number>();
    /** Rivals are drawn this far behind the newest snapshot timeline: one snapshot interval plus room for arrival jitter. */
    const RIVAL_DELAY = .15;
    const state = createRush(props.total, props.checkpoint, q?.options.length ?? 3, spacing, props.courseVersion ?? 3, props.boundaries ?? [], props.hazards ?? [], props.rising ?? [], props.walls ?? [], props.orbs ?? []);
    state.streak = props.streak ?? 0;
    displayY = state.y; displayX = state.x; Object.assign(prevStep, { x: state.x, y: state.y, z: state.z });
    const input: RushInput = { horizontal: 0, sprint: false, dash: false, rush: false, target: null, jump: false, dodge: false, forward: 0 };
    // Version 6: held movement keys and the touch joystick combine into the movement axes; an answer key only marks a door.
    const held = new Set<string>(); let touch = { h: 0, f: 0 }, marked = -1, markedFor = q?.id ?? '';
    const v6 = () => reforged(state);
    /** The modern multiplayer path (replay + server-clock rivals) serves every version 6+ race; older stored races keep theirs. */
    const modern = () => !!latest.current.network && v6();
    /** Until enough inputs were measured: the round trip (an input travels up, its effect comes back down) plus a step. */
    const fallbackLead = () => Math.min(.8, Math.max(.01, (latest.current.network?.rtt?.() ?? 80) / 1000)) + .015;
    /**
     * The race time the local simulation has reached by `now`: the snapshot timeline plus the lead an input needs to be
     * applied by the server at the race time the browser applied it. Continuous: a changed lead slews it (SimClock).
     */
    const simTarget = (now: number) => { const a = arrivals.now(now); return a === null ? null : sim.advance(now, a + lead.value(fallbackLead()), !initialized || state.phase === 'COUNTDOWN'); };
    function axes() {
      let h = touch.h, f = touch.f;
      for (const code of held) { const a = MOVE_KEYS[code]; if (a) { h += a[0]; f += a[1]; } }
      input.horizontal = Math.max(-1, Math.min(1, h)); input.forward = Math.max(-1, Math.min(1, f));
    }
    // Competitive: monotonic request counters sent with the input lease (the server applies each increase once).
    let jumpCounter = 0, dodgeCounter = 0, dodgeHeld = 0;
    const times: number[] = []; let slowCount = 0, finishCalled = false, nearCue = -1, hazardCue = '', riseCue = -1;
    let tried: number[] = [], triedFor = q?.id ?? '', previousRank = 0, metricsAt = 0;
    const moments: RushMoment[] = [];
    const motion = { frames: 0, y: 0, phase: '', local: 0, back: 0, lstall: 0, ls: 0, lq: 0, rn: 0, rs: 0, rq: 0, stall: 0, spike: 0, corrections: 0, maxCorrection: 0,
      remote: new Map<string, { x: number; y: number; v: number; phase: string }>() };
    const audio = (event: WorldAudio, value?: number, pan?: number) => latest.current.onWorldAudio?.(event, value, pan);
    // A passed wall stays where it was crossed (a moving wall freezes for its own racer as they go through it).
    const rememberGate = (checkpoint: number, gates: number, openGate: number, plane = wallAt(state, checkpoint)) => { if (checkpoint >= 0 && openGate >= 0) passedGates.set(checkpoint, { gates, openGate, boundary: plane }); };
    const emit = (kind: WorldEvent, lane = -1) => world.event(kind, lane);
    world.onFootstep = (_foot, pace) => audio('footstep', pace, (state.x - 500) / 450 * .4);
    function sendInput(urgent = false) {
      const n = latest.current.network; if (!n) return;
      // While input is off (menu, tactics, a reconnect) the lease says "stand still", but the keys still held are kept:
      // forgetting them made a key held through the pause dead until it was pressed again.
      const on = n.enabled();
      n.onInput({ horizontal: on ? input.horizontal : 0, target: v6() && on ? null : on ? input.target : null, sprint: on && input.sprint, jump: jumpCounter, dodge: dodgeCounter, forward: v6() && on ? input.forward ?? 0 : 0 }, urgent);
    }
    const handle: SceneHandle = {
      input, state,
      resolve: (correct, streak) => {
        const selected = state.selected, before = state.streak;
        resolveGate(state, correct, streak);
        if (correct) { audio('gate-open'); emit('correct', selected); if (state.streak > before && state.streak >= 3) emit('streak'); }
        else { if (selected >= 0 && !tried.includes(selected)) tried = [...tried, selected]; emit('wrong', selected); }
      },
      advance: question => { q = question; state.gates = q?.options.length ?? 3; if (q?.id !== triedFor) { tried = []; triedFor = q?.id ?? ''; } if (q?.id !== markedFor) { marked = -1; markedFor = q?.id ?? ''; } },
      pause: () => { pauseRush(state); clearInput(); mouse.suspend(); }, resume: () => { resumeRush(state); last = 0; accumulator = 0; },
      // The joystick is quantised to steps of .05, so the lease (and its prediction) changes only when the input really does.
      setMove: (h, f) => { const q20 = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 20) / 20; touch = { h: q20(h), f: q20(f) }; axes(); },
      aim: index => { marked = index; },
      celebrate: () => { celebrating = true; },
      // While the lease is closed (no connection, menu, tactics) a press is not counted: its counter would leave with the
      // first lease after the reconnect and the server would jump at a moment nobody chose.
      jump: () => { if (!trials(state) || latest.current.network && !latest.current.network.enabled()) return; input.jump = true; if (latest.current.network) { jumpCounter++; if (modern()) history.jump(state.elapsed + STEP, jumpCounter, performance.now()); sendInput(true); } },
      dodge: direction => {
        if (!trials(state) || latest.current.network && !latest.current.network.enabled()) return;
        input.dodge = true; if (direction) dodgeHeld = direction;
        if (latest.current.network) {
          dodgeCounter++; const h = input.horizontal; if (direction) input.horizontal = direction;
          if (modern()) history.dodge(state.elapsed + STEP, dodgeCounter, direction || input.horizontal, performance.now());
          sendInput(true); input.horizontal = h;
        }
      },
    };
    function clearInput() { input.horizontal = 0; input.forward = 0; input.target = null; input.sprint = false; input.dash = false; input.rush = false; input.jump = false; input.dodge = false; held.clear(); touch = { h: 0, f: 0 }; }
    function resize() { const rect = canvas.getBoundingClientRect(); world.resize(rect.width, rect.height); }
    // Version 6 keys: W A S D / arrows move (nothing moves without them) · Space jump (the only jump key) · Ctrl dodge ·
    // Shift sprint · F dash · E Echo Rush · 1–4 mark a door (a reading aid; the runner never moves by itself).
    function key6(event: KeyboardEvent) {
      const code = event.code, down = event.type === 'keydown';
      if (GAME_CODES.has(code)) event.preventDefault();
      if (MOVE_KEYS[code]) { if (down) held.add(code); else held.delete(code); axes(); return; }
      if (code === 'ShiftLeft' || code === 'ShiftRight') { input.sprint = down; return; }
      if (!down || event.repeat) return;
      if (code === 'Space') handle.jump();
      else if (code === 'ControlLeft' || code === 'ControlRight') handle.dodge(input.horizontal || undefined);
      else if (code === 'KeyF') input.dash = true;
      else if (code === 'KeyE') input.rush = true;
      else if (/^Digit[1-4]$/.test(code)) { const i = Number(code.slice(5)) - 1; if (i < state.gates) marked = marked === i ? -1 : i; }
    }
    // Courses up to version 5 keep their own keys (a saved older race resumes exactly as it was played).
    function key(event: KeyboardEvent) {
      // A release always counts (a key let go while a control had focus must not stay held); presses inside controls do not.
      if (event.type === 'keydown' && event.target instanceof HTMLElement && (event.target.closest('input,select,[role="dialog"],.rush-question') || event.target.closest('.rush-tactics'))) return;
      if (v6()) { key6(event); return; }
      const k = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Shift', 'a', 'd', 'w', 's', 'f', 'e', '1', '2', '3', '4'].includes(k)) event.preventDefault();
      const down = event.type === 'keydown';
      if (k === 'ArrowLeft' || k === 'a') { if (down || input.horizontal < 0) input.horizontal = down ? -1 : 0; input.target = null; }
      if (k === 'ArrowRight' || k === 'd') { if (down || input.horizontal > 0) input.horizontal = down ? 1 : 0; input.target = null; }
      if (k === 'Shift') input.sprint = down;
      if ((k === ' ' || k === 'w' || k === 'ArrowUp') && down && !event.repeat) handle.jump();
      if ((k === 's' || k === 'ArrowDown') && down && !event.repeat) handle.dodge();
      if (k === 'f' && down && !event.repeat) input.dash = true;
      if (k === 'e' && down && !event.repeat) input.rush = true;
      if (down && /^[1-4]$/.test(k) && Number(k) <= state.gates) input.target = gateCenter(Number(k) - 1, state.gates);
    }
    function stopHiddenHeartbeat() {
      if (hiddenHeartbeat) { window.clearInterval(hiddenHeartbeat); hiddenHeartbeat = 0; }
    }
    function startHiddenHeartbeat() {
      if (hiddenHeartbeat || disposed || !latest.current.network) return;
      // Multiplayer hidden-tab keepalive: keep lightweight input leases ticking while WebGL world.frame() stays paused.
      hiddenHeartbeat = window.setInterval(() => {
        if (disposed || !document.hidden) { stopHiddenHeartbeat(); return; }
        sendInput();
      }, 250);
    }
    function hidden() {
      if (document.hidden) {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        if (latest.current.network) { clearInput(); startHiddenHeartbeat(); }
        else handle.pause();
        latest.current.onHidden();
      } else {
        stopHiddenHeartbeat();
        last = 0;
        if (!disposed && readyStarted && !raf) raf = requestAnimationFrame(render);
      }
    }
    function blurred() { if (latest.current.network) clearInput(); else handle.pause(); latest.current.onHidden(); }
    // Ctrl is the dodge key, and Ctrl+W closes a tab in most browsers: while a race runs, leaving asks first.
    function leaving(event: BeforeUnloadEvent) { if (v6() && !['FINISHED', 'COUNTDOWN'].includes(state.phase)) { event.preventDefault(); event.returnValue = ''; } }
    const observer = new ResizeObserver(resize); observer.observe(canvas);
    window.addEventListener('keydown', key); window.addEventListener('keyup', key); window.addEventListener('blur', blurred); window.addEventListener('beforeunload', leaving);
    document.addEventListener('visibilitychange', hidden);
    resize();

    const course = () => ({ total: state.total, walls: Array.from({ length: state.total }, (_, i) => wallAt(state, i)), finish: finishLine(state), spacing: state.spacing, hazards: state.hazards, rising: state.rising,
      motion: v6() ? state.walls : undefined, orbs: v6() ? state.orbs : undefined, open: hardcore(state) });
    let courseCache = course(), courseKey = '';
    const remotes: WorldRacer[] = [];
    /** Drawn ground under a racer (a leaning deck, a sinking stone); held from the start of a fall so a faller never pops up. */
    const grounds = new Map<string, number>();
    function groundOf(id: string, phase: string, x: number, y: number) {
      if (phase === 'FALLING' && grounds.has(id)) return grounds.get(id)!;
      const g = surfaceHeight(state.hazards, x, y, state.elapsed); grounds.set(id, g); return g;
    }
    function frameView(now: number, dt: number): WorldFrame {
      const key = `${state.total}:${state.spacing}:${state.courseVersion}:${state.boundaries.join(',')}:${state.hazards.length}:${state.rising.join('')}:${state.walls.length}:${state.orbs.length}`;
      if (key !== courseKey) { courseKey = key; courseCache = course(); }
      const x = displayX, y = displayY;
      // A predicted crossing runs ahead of the server: the next wall shows its doors only once the server sends its question.
      const shown = q && (!modern() || serverCheckpoint === state.checkpoint) ? q : null;
      const slideNow = currentSlide(state);
      const half = v6() ? doorHalf6(state.gates) : doorHalfOpening(state), lane = gateAt(x - slideNow, state.gates);
      const aim = shown && Math.abs(x - slideNow - gateCenter(lane, state.gates)) <= half ? lane : -1;
      const phase = state.phase === 'PAUSED' ? state.previousPhase : state.phase;
      return {
        mode: celebrating ? 'celebrate' : 'race', now, dt, reduced: latest.current.reduced, course: courseCache, clock: state.elapsed,
        local: { id: accepted?.you ?? 'p1', name: '', x, y, vx: state.vx, speed: state.speed, phase, phaseTime: state.phaseTime,
          connected: true, checkpoint: state.checkpoint, effect: '', streak: state.streak, look: 0, hero: latest.current.hero, avatar: latest.current.avatar, gates: shown ? state.gates : 0, openGate: state.openGate, rejected: state.rejected,
          dashing: state.dashTime > 0, rushing: state.rushTime > 0, z: displayZ, vz: state.vz, guard: state.guard, sill: currentSill(state),
          vy: state.vy, shield: state.shield, boosted: state.elapsed < state.speedUntil, taken: state.taken, ground: groundOf('', phase, x, y) },
        question: shown ? { id: shown.id, labels: shown.options.map(o => o.label), monospace: shown.family === 'SPELLING_CHOICE' || shown.family === 'SPELLING_CORRECTION' || shown.family === 'MISSING_LETTER' } : null,
        tried, aim, marked, passed: [...passedGates.entries()].map(([checkpoint, v]) => ({ checkpoint, gates: v.gates, openGate: v.openGate, plane: v.boundary })), remotes,
        moments: dt > 0 ? moments : [],
      };
    }
    // World + audio for a physical moment of the local racer (local simulation or a server-confirmed change).
    function moment(m: RushMoment) {
      moments.push(m);
      const pan = (state.x - 500) / 450 * .5;
      if (m === 'JUMP') audio('jump', 1, pan);
      if (m === 'LAND') audio('land', Math.min(1, state.landSpeed / TRIALS.jumpSpeed), pan);
      if (m === 'DODGE') audio('dodge', 1, pan);
      if (m === 'KNOCK') { audio('knock', 1, pan); latest.current.onObstacle('knock'); }
      if (m === 'FALL') { audio('fall', 1, pan); latest.current.onObstacle('fall'); }
      if (m === 'RESPAWN') audio('respawn', 1, pan);
      if (m === 'SILL') { audio('sill', 1, pan); latest.current.onObstacle('sill'); }
      if (m === 'RISE') audio('rise', 1, 0);
      if (m === 'ORB') { const k = state.lastOrb; audio(k === 'SPEED' ? 'orb-speed' : k === 'ENERGY' ? 'orb-energy' : 'orb-guard', 1, pan); }
      if (m === 'SHIELD') audio('shield', 1, pan);
      if (m === 'BUMP') audio('bump', 1, pan);
    }

    // Obstacles you can hear: the beam or a ram sweeping past, boulders rolling near, sky-stones falling, chasm wind,
    // the rising gate grinding. Positions come from the same functions as the collisions (never decoration).
    let soundClock = -1, millSide = 0, wasSprinting = false, grindWall = 0, pressing = false; const ramSide = [0, 0, 0]; const boulderList: Boulder[] = [];
    function soundscape(t: number, x: number, y: number) {
      const ambience = latest.current.onAmbience, h = v6() ? hazardsAt(state.hazards, state.checkpoint).find(z => y < z.to + 400 && ['MILL', 'RAMS', 'BOULDERS', 'SKYFALL', 'CHASM'].includes(z.kind)) ?? null : currentHazard(state);
      let rumble = 0, rumblePan = 0, wind = 0;
      const px = (x - 500) * .01;
      if (h && soundClock >= 0 && t > soundClock) {
        const outside = y < h.from ? h.from - y : y > h.to ? y - h.to : 0, near = Math.max(0, 1 - outside / 1200);
        if (h.kind === 'MILL' && near > 0) {
          const py = (y - millCenter(h)) * .02, r = Math.hypot(px, py);
          // Sign of the beam's crossing over the runner's bearing (the beam is double-ended: compare modulo π).
          let diff = (millAngle(h, t) - Math.atan2(py, px)) % Math.PI; if (diff < -Math.PI / 2) diff += Math.PI; if (diff > Math.PI / 2) diff -= Math.PI;
          const sideNow = Math.sign(diff);
          if (millSide && sideNow && sideNow !== millSide && Math.abs(diff) < .6 && r < MILL.arm + 3) audio('swoosh', Math.max(.2, 1 - r / (MILL.arm + 3)), Math.max(-1, Math.min(1, -Math.cos(millAngle(h, t)) * .6)));
          millSide = sideNow;
        }
        if (h.kind === 'RAMS') for (let j = 0; j < 3; j++) {
          const dy = (ramY(h, j) - y) * .02; if (Math.abs(dy) > 8) { ramSide[j] = 0; continue; }
          const off = ramOffset(h, j, t), sideNow = Math.sign(off - px);
          if (ramSide[j] && sideNow !== ramSide[j]) audio('swoosh', Math.max(.2, 1 - Math.abs(dy) / 8), Math.max(-1, Math.min(1, (off - px) * .3)));
          ramSide[j] = sideNow;
          void RAMS;
        }
        if (h.kind === 'BOULDERS') for (const b of boulders(h, t, boulderList)) {
          const dx = (b.x - x) * .01, dz = (b.y - y) * .02, dist = Math.hypot(dx, dz);
          const level = Math.max(0, 1 - dist / 14); if (level > rumble) { rumble = level; rumblePan = Math.max(-1, Math.min(1, dx * .25)); }
        }
        if (h.kind === 'SKYFALL') for (const i of impacts(h, t)) {
          const dz = Math.abs(i.y - y) * .02; if (dz > 16) continue;
          const level = Math.max(.15, 1 - dz / 16);
          if (soundClock < i.time - .85 && t >= i.time - .85) audio('whistle', level, 0);
          if (soundClock < i.time && t >= i.time) audio('boom', level, 0);
          void rows;
        }
        if (h.kind === 'CHASM') wind = near;
      }
      let saw = 0, sawPan = 0, hum = 0;
      if (v6() && soundClock >= 0 && t > soundClock) {
        for (const z of hazardsAt(state.hazards, state.checkpoint)) {
          const outside = y < z.from ? z.from - y : y > z.to ? y - z.to : 0, near = Math.max(0, 1 - outside / 1200);
          if (near <= 0) continue;
          if (z.kind === 'SAWS') for (let j = 0; j < sawRows(z.tier); j++) for (let b = 0; b < (sawDouble(z, j) ? 2 : 1); b++) {
            const dx = (sawX(z, j, b, t) - x) * .01, dz = (sawY(z, j) - y) * .02, level = Math.max(0, 1 - Math.hypot(dx, dz) / 14);
            if (level > saw) { saw = level; sawPan = Math.max(-1, Math.min(1, dx * .25)); }
          }
          if (z.kind === 'CRUSHER') for (let j = 0; j < crushRows(z.tier); j++) {
            const dz = Math.abs(crushY(z, j) - y) * .02; if (dz > 18) continue;
            if (closure(z, j, soundClock) < .5 && closure(z, j, t) >= .5) audio('slam', Math.max(.2, 1 - dz / 18), 0);
          }
          if (z.kind === 'GALE' || z.kind === 'BEAM') { if (gust(z, soundClock) <= 0 && gust(z, t) > 0) audio('gust', near, 0); if (!gustWarning(z, soundClock) && gustWarning(z, t)) audio('swoosh', near * .5, 0); wind = Math.max(wind, near * (z.kind === 'BEAM' ? .8 : .6)); }
          if (z.kind === 'STEPS') for (let j = 0; j < stepRows(z.tier); j++) {
            const dz = Math.abs(stepY(z, j) - y) * .02; if (dz > 16) continue;
            if (stepShake(z, j, soundClock) <= 0 && stepShake(z, j, t) > 0) audio('crack', Math.max(.2, 1 - dz / 16), 0);
          }
          // A turning roller creaks; a peg sweeping over the top close to the runner whistles past.
          if (z.kind === 'ROLLER') {
            grindWall = Math.max(grindWall, near * .55);
            for (let i = 0; i < logCount(z); i++) {
              if (y < logFrom(z, i) - 200 || y > logTo(z, i)) continue;
              const n = ringCount(z, i), j = Math.max(0, Math.min(n - 1, Math.round((y - logFrom(z, i)) / (logTo(z, i) - logFrom(z, i)) * n - .5) + 1));
              for (let k = 0; k < pegsIn(z, j); k++) { const before = Math.cos(pegAngle(z, i, j, k, soundClock)), after = Math.cos(pegAngle(z, i, j, k, t)); if (before < .96 && after >= .96) audio('swoosh', Math.max(.2, 1 - Math.abs(ringY(z, i, j) - y) * .02 / 6), Math.max(-1, Math.min(1, (logX(z, i) - x) * .004))); }
            }
          }
          if (z.kind === 'CRUMBLE') for (let k = 0; k < crumbleTiles(z.tier); k++) {
            const dz = Math.abs(z.from + (k + .5) * CRUMBLE.tile - y) * .02; if (dz > 16) continue;
            if (tileShake(z, k, soundClock) <= 0 && tileShake(z, k, t) > 0) audio('crack', Math.max(.2, 1 - dz / 16), 0);
            if (tileShake(z, k, soundClock) > .9 && tileShake(z, k, t) === 0) audio('crumble', Math.max(.2, 1 - dz / 16), 0);
          }
          if (z.kind === 'DRIFT') { hum = Math.max(hum, near); for (let j = 0; j < driftRows(z.tier); j++) void driftX(z, j, t), driftY(z, j); }
        }
        const w = state.checkpoint < state.total ? state.walls[state.checkpoint] : null, toWall = (currentPlane(state) - y) * .02;
        if (w && toWall < 26) {
          if (w.shutPeriod > 0 && shutter(w, soundClock) < .5 !== shutter(w, t) < .5) audio('shutter', Math.max(.25, 1 - toWall / 26), 0);
          const moving = wallApproach(w, t) !== wallApproach(w, soundClock);
          if (moving) grindWall = Math.max(grindWall, Math.max(0, 1 - toWall / 26));
          if (state.openGate < 0 && state.phase === 'RUNNING' && toWall < .7 && wallApproach(w, t) > wallApproach(w, soundClock) && !pressing) { pressing = true; audio('wall-hit', 1, 0); }
          if (toWall > 1.2) pressing = false;
        }
      }
      soundClock = t;
      ambience?.('rumble', rumble, rumblePan);
      ambience?.('wind', wind * .8, 0);
      ambience?.('saw', saw, sawPan);
      ambience?.('hum', hum, 0);
      const rising = state.riseStart >= 0 && state.hold < 0 && state.elapsed >= state.riseStart && currentSill(state) > 0 && currentSill(state) < TRIALS.sillMax && state.phase === 'RUNNING';
      ambience?.('grind', rising ? 1 : grindWall * .8, 0); grindWall = 0;
    }

    /** Prediction never crosses into a checkpoint the server has not confirmed (older stored races only). */
    function holdCrossing(checkpoint: number) {
      if (state.checkpoint !== checkpoint) { state.checkpoint = checkpoint; state.phase = 'RUNNING'; state.phaseTime = 0; state.sealed = [...tried]; }
      if (state.checkpoint < state.total) state.y = Math.min(state.y, currentPlane(state) + 64);
    }
    /** The authority's state of this racer at the snapshot's race time (the course plan and the private details included). */
    function authoritative(server: CompetitiveState, own: CompetitiveState['players'][number]): RushState {
      const p = server.personal;
      return Object.assign({ ...state, moments: [] as RushMoment[] }, { phase: server.status === 'COUNTDOWN' ? 'COUNTDOWN' : own.phase, x: own.x, y: own.y, vx: own.vx, speed: own.speed, checkpoint: own.checkpoint,
        gates: server.question?.options.length ?? 3, countdown: Math.max(0, -server.elapsed), elapsed: Math.max(0, server.elapsed), phaseTime: p.phaseTime,
        stamina: p.stamina, rushEnergy: p.energy, dashCooldown: p.dashCooldown, dashTime: p.dashTime, rushTime: p.rushTime,
        selected: p.selected, openGate: p.openGate, rejected: p.rejected, spacing: server.spacing ?? 1100, courseVersion: server.courseVersion ?? 1,
        recoilFrom: p.recoilFrom >= 0 ? p.recoilFrom : own.y, streak: own.streak ?? 0,
        z: own.z ?? 0, vz: p.vz ?? 0, guard: p.guard ?? 0, kvx: p.kvx ?? 0, kvy: p.kvy ?? 0, dodgeTime: p.dodgeTime ?? 0, dodgeDir: p.dodgeDir ?? 0, dodgeCooldown: p.dodgeCooldown ?? 0,
        riseCheckpoint: p.riseCheckpoint ?? -1, riseStart: p.riseStart ?? -1, dropStart: p.dropStart ?? -1, dropFrom: p.dropFrom ?? 0, hold: p.hold ?? -1,
        jumps: p.jumps ?? 0, dodges: p.dodges ?? 0, knocks: p.knocks ?? 0, falls: p.falls ?? 0,
        vy: p.vy ?? 0, floorY: p.floorY ?? -80, lastSlide: p.lastSlide ?? 0, taken: p.orbs ?? [], speedUntil: Math.max(0, server.elapsed) + (p.speedLeft ?? 0) - (p.speedLeft ? 0 : 1),
        shield: p.shield ?? 0, shieldUntil: Math.max(0, server.elapsed) + (p.shieldLeft ?? 0), shieldBlocks: p.shieldBlocks ?? 0, dashX: p.dashX ?? 0, dashY: p.dashY ?? 1,
        orbSerial: p.orbSerial ?? 0, lastOrb: p.lastOrb ?? '', fallX: p.fallX ?? own.x, fallY: p.fallY ?? own.y,
        // A jump the server accepted but has not applied yet, and the last landing (take-off recovery): rebuilt from the
        // snapshot, never inherited from the prediction (a replay from an accepted-but-unapplied jump used to drop it).
        jumpAt: p.jumpAt ?? -1, landAt: p.landAt ?? -100, jumpSeq: p.jumpSeq ?? 0, dodgeSeq: p.dodgeSeq ?? 0,
        effect: own.effect ?? '', effectUntil: own.effect ? Math.max(0, server.elapsed) + (own.effectRemaining ?? 0) : -1 } as Partial<RushState>);
    }
    /**
     * Races stored before version 6: tactical effects approximated on the predicted input. Version 6+ races carry the
     * effect in the state (`effect` / `effectUntil`) and the step applies it where the authority does (move6).
     */
    function effectInput(base: RushInput, effect: string): RushInput {
      return effect === 'ICE_LOCK' ? { ...base, horizontal: 0, target: null, dodge: false } : base;
    }
    /**
     * Replay the race time a snapshot travelled (its race time → `until`) with what this racer really held at each step and
     * the one-shot actions the server has not applied yet. The result is the present the authority will confirm.
     */
    function replay(s: RushState, server: CompetitiveState, until: number, wallNow: number) {
      const p = server.personal; let n = 0;
      while (s.elapsed + STEP <= until + 1e-6 && n < 120) {
        const t0 = s.elapsed, t1 = t0 + STEP, held = history.at(t1), first = n === 0;
        const dodge = history.dodgeDue(t0, t1, first, p.dodgeSeq ?? 0);
        stepRush(s, { horizontal: dodge && dodge.dir ? dodge.dir : held.horizontal, forward: held.forward, sprint: held.sprint, target: null,
          jump: history.jumpDue(t0, t1, first, p.jumpSeq ?? 0), dodge: !!dodge,
          dash: history.dashDue(t0, t1, first, p.dashCooldown > 0, wallNow), rush: history.rushDue(t0, t1, first, p.rushTime > 0, wallNow) }, STEP); n++;
      }
      s.moments.length = 0;
    }
    /** Adopt an authoritative snapshot on the modern path: replay it to the present, keep the shown runner continuous. */
    function adopt(server: CompetitiveState, own: CompetitiveState['players'][number], now: number) {
      const before = { x: state.x, y: state.y, z: state.z, checkpoint: state.checkpoint, phase: state.phase };
      const auth = authoritative(server, own);
      auth.sealed = [...tried];
      const running = server.status !== 'COUNTDOWN' && !['FINISHED', 'DNF'].includes(own.phase);
      // The present is the race clock's estimate, not the prediction's own time: when the estimate moved back (the server
      // was late), the prediction re-synchronises here instead of standing still until the clock catches up with it.
      const present = simTarget(now) ?? state.elapsed;
      if (running && state.phase !== 'COUNTDOWN' && present > auth.elapsed) replay(auth, server, present, now);
      else if (running && state.phase === 'COUNTDOWN') { const target = simTarget(now); if (target !== null && target > auth.elapsed) replay(auth, server, target, now); }
      // The shown runner stays where it was drawn; the difference eases out (a respawn, a swap or a far error snaps).
      const dx = auth.x - before.x, dy = auth.y - before.y, dz = auth.z - before.z, far = Math.hypot(dx, dy) > 140;
      const snap = !initialized || far || (auth.phase === 'FALLING') !== (before.phase === 'FALLING') && Math.hypot(dx, dy) > 40;
      if (initialized && before.phase === 'RUNNING' && auth.phase === 'RUNNING' && before.checkpoint === auth.checkpoint) { motion.corrections++; motion.maxCorrection = Math.max(motion.maxCorrection, Math.hypot(dx, dy)); }
      if (snap) { visual.x = visual.y = visual.z = 0; Object.assign(prevStep, { x: auth.x, y: auth.y, z: auth.z }); }
      else { visual.x -= dx; visual.y -= dy; visual.z -= dz; prevStep.x += dx; prevStep.y += dy; prevStep.z += dz; }
      Object.assign(state, auth);
    }
    /** Server-decided moments of this racer the local prediction did not produce (a pickup, a block, a hit, a fall). */
    function serverMoments(server: CompetitiveState, own: CompetitiveState['players'][number], previous: CompetitiveState | null, localPhase: string) {
      const p = server.personal;
      if ((p.orbSerial ?? 0) > (previous?.personal.orbSerial ?? 0) && previous) moment('ORB');
      if ((p.shieldBlocks ?? 0) > (previous?.personal.shieldBlocks ?? 0) && previous) moment('SHIELD');
      if (state.phase === 'KNOCKED' && localPhase !== 'KNOCKED') moment('KNOCK');
      if (state.phase === 'FALLING' && localPhase !== 'FALLING') moment('FALL');
      if (localPhase === 'FALLING' && state.phase === 'RUNNING') moment('RESPAWN');
      void own;
    }
    /** Races stored before version 6 (automatic running): the original snapshot handling, unchanged. */
    function legacySnapshot(server: CompetitiveState, own: CompetitiveState['players'][number], previous: CompetitiveState | null) {
      const p = server.personal, localPhase = state.phase;
      if (own.checkpoint > state.checkpoint) rememberGate(state.checkpoint, state.gates, state.openGate >= 0 ? state.openGate : p.openGate, wallAt(state, state.checkpoint));
      // A jump / dodge the server has not seen yet stays predicted locally (its counter is ahead of the server's).
      const pendingJump = (p.jumpSeq ?? 0) < jumpCounter, pendingDodge = (p.dodgeSeq ?? 0) < dodgeCounter;
      const keepZ = pendingJump ? { z: state.z, vz: state.vz } : null, keepDodge = pendingDodge ? { dodgeTime: state.dodgeTime, dodgeDir: state.dodgeDir, dodgeCooldown: state.dodgeCooldown, vx: state.vx } : null;
      Object.assign(state, authoritative(server, own));
      if (keepZ) Object.assign(state, keepZ);
      if (keepDodge) Object.assign(state, keepDodge);
      serverMoments(server, own, previous, localPhase);
      if (server.question?.id !== q?.id) { q = server.question; if (q?.id !== triedFor) { tried = []; triedFor = q?.id ?? ''; } }
      if (p.rejected >= 0 && own.phase === 'STUMBLE' && !tried.includes(p.rejected)) tried = [...tried, p.rejected];
      state.sealed = [...tried]; serverCheckpoint = own.checkpoint;
      if (!initialized) { initialized = true; displayX = own.x; displayY = own.y; }
    }
    function render(now: number) {
      if (disposed) return;
      if (document.hidden) {
        raf = 0;
        if (latest.current.network) { sendInput(); startHiddenHeartbeat(); }
        return;
      }
      const rawDt = last ? now - last : 16.67; last = now;
      moments.length = 0;
      if (!document.hidden && state.phase !== 'PAUSED' && state.phase !== 'COUNTDOWN') {
        if (times.length < 18000) times.push(rawDt);
        if (rawDt > 25) slowCount++;
        // Sustained slow frames lower the visual tier only; gameplay and physics are identical on every tier.
        if (times.length % 120 === 0) { if (slowCount > 30 && quality !== 'low') { quality = quality === 'high' ? 'medium' : 'low'; world.setQuality(quality); } slowCount = 0; }
      }
      const dt = Math.min(rawDt / 1000, .05);
      const network = latest.current.network, server = network?.snapshot.current;
      const own = server?.players.find(p => p.id === server.you);
      const fresh = !!server && server !== accepted, previous = accepted, previousOwn = previous?.players.find(p => p.id === previous.you);
      if (fresh && server) {
        if (accepted?.matchId !== server.matchId) lead.reset();
        accepted = server;
        // Every snapshot sets the timeline and feeds the rivals' buffer (server race time, never arrival time).
        arrivals.sample(now, server.elapsed, 0);
        // The input lead: the race time the server applied this racer's latest input from, against when it left this tab.
        const mine = server.personal, sentAt = mine.lastSeq >= 0 ? network?.sentAt?.(mine.lastSeq) : undefined;
        if (mine.inputAt !== undefined) lead.observe(mine.lastSeq, mine.inputAt + STEP, sentAt === undefined ? null : arrivals.at(sentAt));
        // Jump / dodge counters continue from the authority's: a remounted scene (a refresh, a rejoin) starts at 0, and a
        // press at or below the server's counter used to be ignored until the old count was overtaken.
        jumpCounter = Math.max(jumpCounter, mine.jumpSeq ?? 0); dodgeCounter = Math.max(dodgeCounter, mine.dodgeSeq ?? 0);
        const keep = new Set<string>();
        for (const p of server.players) if (p.id !== server.you) { keep.add(p.id); rivals.push(p.id, { e: server.elapsed, x: p.x, y: p.y, z: p.z ?? 0, vz: p.vz ?? 0, phase: p.phase }); }
        rivals.forget(keep);
        if (own) {
          if (server.boundaries?.length && server.boundaries.join() !== state.boundaries.join()) state.boundaries = [...server.boundaries];
          // The course plan arrives with command answers / before the start; broadcasts during the race omit it.
          if (server.hazards) state.hazards = server.hazards;
          if (server.rising) state.rising = server.rising;
          if (server.walls) state.walls = server.walls;
          if (server.orbs) state.orbs = server.orbs;
        }
      }
      if (network) { if (!network.enabled()) { input.dash = input.rush = input.jump = input.dodge = false; } sendInput(); if (input.dash) { network.onBoost('dash'); if (modern()) history.dash(state.elapsed + STEP, now); } if (input.rush) { network.onBoost('rush'); if (modern()) history.rush(state.elapsed + STEP, now); } }
      const frozen = !!network && (!network.enabled() || !own?.connected || own?.phase === 'DNF' || server?.recovery === 'PERSISTENCE_UNAVAILABLE');
      const effect = own?.effect ?? '';
      // One fixed 1/120 s step of the local runner (Solo, or the prediction of a race), with its world moments and audio.
      const stepOnce = () => {
        const iced = !modern() && effect === 'ICE_LOCK', held = { ...input, horizontal: input.dodge && dodgeHeld ? dodgeHeld : input.horizontal };
        const effective = frozen ? { ...held, horizontal: 0, forward: 0, sprint: false, jump: false, dodge: false, dash: false, rush: false, target: null } : modern() ? held : effectInput(held, effect);
        if (iced) state.vx = state.dodgeTime > 0 ? state.vx : 0;
        if (modern()) history.record(state.elapsed + STEP, { horizontal: effective.horizontal, forward: effective.forward ?? 0, sprint: effective.sprint });
        const priorY = state.y, priorCheckpoint = state.checkpoint, priorGates = state.gates, priorOpen = state.openGate, dashBefore = state.dashTime, rushBefore = state.rushTime;
        Object.assign(prevStep, { x: state.x, y: state.y, z: state.z });
        state.moments.length = 0;
        const event = network && !modern() && frozen ? null : stepRush(state, effective, STEP);
        // In a race the authority confirms pickups and shield blocks; local prediction stays silent for them.
        const stepMoments = state.moments.splice(0).filter(m => !network || (m !== 'ORB' && m !== 'SHIELD'));
        for (const m of stepMoments) moment(m);
        if (modern()) {
          // A predicted crossing of an opened door: the passed wall stays open where it was crossed, and it sounds now.
          if (event === 'NEXT') { rememberGate(priorCheckpoint, priorGates, priorOpen, state.floorY - 30); if (!crossed.has(priorCheckpoint)) { crossed.add(priorCheckpoint); audio('gate-pass'); } }
        } else if (network && own) {
          // Older stored races: prediction holds at a crossing until the server confirms it.
          if (v6() && event === 'NEXT') holdCrossing(own.checkpoint);
          if (!v6() && event === 'NEXT') { state.checkpoint = own.checkpoint; state.phase = 'OPENING'; state.openGate = server!.personal.openGate; state.y = boundary(state) + 65; state.phaseTime = Math.max(.48, server!.personal.phaseTime); }
          if (effect === 'TIME_SNARE' && state.phase === 'RUNNING') { state.speed = Math.min(95, state.speed); state.y = Math.min(state.y, priorY + 95 / 120); if (v6()) state.vy = Math.min(state.vy, REFORGED.snare / TRIALS.ky); }
        }
        input.dash = false; input.rush = false; input.jump = false; input.dodge = false; dodgeHeld = 0;
        if (!network && dashBefore <= 0 && state.dashTime > 0) { audio('dash'); emit('dash'); }
        if (!network && rushBefore <= 0 && state.rushTime > 0) { audio('rush'); emit('rush'); }
        if (!network && event === 'GATE') latest.current.onGate(state.selected);
        if (!network && event === 'POST' && !stepMoments.includes('SILL')) { latest.current.onObstacle('post'); emit('post'); }
        if (!network && event === 'NEXT') { rememberGate(priorCheckpoint, priorGates, priorOpen, v6() ? state.floorY - 30 : wallAt(state, priorCheckpoint)); audio('gate-pass'); latest.current.onNext(); }
        if (!network && event === 'FINISH') { audio('finish'); emit('finish'); }
      };
      let alpha = 1;
      if (modern()) {
        // The race clock decides how far the runner simulates: no frame-time accumulator, no clock jump at a snapshot.
        const target = simTarget(now);
        if (target !== null && state.phase === 'COUNTDOWN' && target >= 0 && own && server?.status !== 'COUNTDOWN') { state.phase = 'RUNNING'; state.phaseTime = 0; state.countdown = 0; state.elapsed = Math.max(state.elapsed, 0); }
        if (target !== null && state.phase !== 'COUNTDOWN' && state.phase !== 'PAUSED') {
          let n = 0; while (state.elapsed + STEP <= target + 1e-9 && n < 90) { stepOnce(); n++; }
          if (n === 90) { state.elapsed = Math.max(state.elapsed, target - STEP); Object.assign(prevStep, { x: state.x, y: state.y, z: state.z }); }
          alpha = Math.max(0, Math.min(1, (target - state.elapsed) / STEP));
        }
        if (fresh && server && own) {
          const localPhase = state.phase;
          if (server.question?.id !== q?.id) { q = server.question; if (q?.id !== triedFor) { tried = []; triedFor = q?.id ?? ''; } }
          if (server.personal.rejected >= 0 && own.phase === 'STUMBLE' && !tried.includes(server.personal.rejected)) tried = [...tried, server.personal.rejected];
          if (own.checkpoint > serverCheckpoint && !passedGates.has(serverCheckpoint)) rememberGate(serverCheckpoint, state.gates, server.personal.openGate >= 0 ? server.personal.openGate : state.openGate, (server.personal.floorY ?? 0) - 30);
          serverCheckpoint = own.checkpoint;
          adopt(server, own, now);
          if (!initialized) { initialized = true; Object.assign(prevStep, { x: state.x, y: state.y, z: state.z }); }
          serverMoments(server, own, previous, localPhase);
        }
      } else {
        if (fresh && server && own) legacySnapshot(server, own, previous);
        accumulator += dt; let steps = 0;
        while (accumulator >= STEP && steps < 6) { stepOnce(); accumulator -= STEP; steps++; }
        if (steps === 6) accumulator = Math.min(accumulator, STEP);
        alpha = network ? 1 : Math.max(0, Math.min(1, accumulator / STEP));
      }
      if (fresh && server && own && previousOwn) {
        const p = server.personal;
        if (previousOwn.phase !== 'OPENING' && own.phase === 'OPENING') { audio('gate-open'); emit('correct', p.openGate); if ((own.streak ?? 0) >= 3 && (own.streak ?? 0) > (previousOwn.streak ?? 0)) emit('streak'); }
        if (previousOwn.phase !== 'STUMBLE' && own.phase === 'STUMBLE') emit(p.rejected >= 0 ? 'wrong' : 'post');
        if (previousOwn.checkpoint < own.checkpoint && !crossed.has(previousOwn.checkpoint)) { crossed.add(previousOwn.checkpoint); audio('gate-pass'); }
        if ((previous?.personal.dashTime ?? 0) <= 0 && p.dashTime > 0) { audio('dash'); emit('dash'); }
        if ((previous?.personal.rushTime ?? 0) <= 0 && p.rushTime > 0) { audio('rush'); emit('rush'); }
        if (previousOwn.phase !== 'FINISHED' && own.phase === 'FINISHED') { audio('finish'); emit('finish'); }
      }
      if (!network && state.phase === 'FINISHED' && state.phaseTime >= 1.05 && !finishCalled) { finishCalled = true; celebrating = true; latest.current.onFinish(); }
      if (network && accepted && ['FINISHED', 'CANCELED'].includes(accepted.status)) celebrating = true;
      // Shown runner = the simulation interpolated between its last two steps (frames and 120 Hz steps never align), plus
      // the easing offset of the last authoritative correction. A teleport (respawn) is never interpolated.
      const jumpStep = Math.hypot(state.x - prevStep.x, state.y - prevStep.y) > 60;
      const a = jumpStep ? 1 : alpha, ease = Math.exp(-dt * 11);
      visual.x *= ease; visual.y *= ease; visual.z *= ease;
      if (!network || modern()) {
        displayX = prevStep.x + (state.x - prevStep.x) * a + visual.x; displayY = prevStep.y + (state.y - prevStep.y) * a + visual.y; displayZ = prevStep.z + (state.z - prevStep.z) * a + visual.z;
      } else {
        displayX += (state.x - displayX) * (1 - Math.exp(-dt * 18)); displayY += (state.y - displayY) * (1 - Math.exp(-dt * 18)); displayZ = state.z;
        if (Math.abs(displayY - state.y) > 160) displayY = state.y;
      }
      if (v6()) { if (state.openGate < 0 && state.checkpoint < state.total && state.phase !== 'FALLING') displayY = Math.min(displayY, currentPlane(state) - ROAD.radius); }
      else if (!['OPENING', 'FINISHING', 'FINISHED'].includes(state.phase)) displayY = Math.min(displayY, boundary(state) - ROAD.radius);

      // Remote racers: authoritative coordinates interpolated by server time a fixed delay behind the clock (never a
      // placeholder or a prediction of answers).
      remotes.length = 0;
      let rank = 1, racers = 1;
      const localProgress = displayY;
      const progress: SceneHud['progress'] = [];
      const rivalTime = arrivals.now(now);
      if (server) for (const p of server.players) {
        if (p.id === server.you) continue;
        const pose = rivalTime !== null ? rivals.pose(p.id, rivalTime - RIVAL_DELAY) : null;
        const x = pose?.x ?? p.x, y = pose?.y ?? p.y, z = pose?.z ?? p.z ?? 0, phase = pose?.phase ?? p.phase;
        remotes.push({ id: p.id, name: p.name, x, y, vx: pose ? pose.vx : p.vx, vy: pose ? pose.vy : p.vy, speed: pose ? Math.hypot(pose.vx * TRIALS.kx, pose.vy * TRIALS.ky) / TRIALS.ky : p.speed, phase,
          phaseTime: phase === 'OPENING' ? (p.speed > 0 ? .48 : 0) : 1, connected: p.connected, checkpoint: p.checkpoint, effect: p.effect, streak: p.streak ?? 0, look: look(p.id), hero: p.hero, avatar: p.bot ? undefined : p.look ?? '', z, guard: p.guard ?? 0,
          ground: groundOf(p.id, phase, x, y) });
        racers++;
        const ahead = p.phase === 'FINISHED' ? (state.phase !== 'FINISHED' || (p.finishAt >= 0 && p.finishAt < (own?.finishAt ?? Infinity))) : y > localProgress;
        if (ahead) rank++;
        progress.push({ id: p.id, t: Math.min(1, y / finishLine(state)), local: false, look: look(p.id) });
      }
      if (server) {
        progress.push({ id: server.you, t: Math.min(1, localProgress / finishLine(state)), local: true, look: look(server.you) });
        const own = server.players.find(p => p.id === server.you);
        if (own?.rank) rank = own.rank;
        if (previousRank && rank < previousRank && state.phase === 'RUNNING') audio('overtake');
        previousRank = rank;
        world.setLocalEffect(own?.effect ?? '');
      } else progress.push({ id: 'p1', t: Math.min(1, state.y / finishLine(state)), local: true, look: 0 });

      // Tension cue: once per checkpoint, as the runner enters the decision zone of a revealed wall.
      const remaining = boundary(state) - displayY;
      if (q && state.phase === 'RUNNING' && remaining < 900 && nearCue !== state.checkpoint) { nearCue = state.checkpoint; audio('near-gate'); }
      // An obstacle announces itself once, a little before its zone (the HUD names it at the same moment).
      const hz = currentHazard(state);
      const hazardDistance = hz ? hz.from - displayY : Infinity;
      if (hz && hazardDistance < 900 && hazardDistance > -200 && hazardCue !== `${hz.checkpoint}:${hz.kind}`) { hazardCue = `${hz.checkpoint}:${hz.kind}`; audio('hazard', HAZARD_CODE[hz.kind]); }
      if (state.riseStart >= 0 && riseCue !== state.checkpoint && state.elapsed >= state.riseStart - .05) { riseCue = state.checkpoint; audio('rise', 2, 0); }

      // Motion diagnostics (published with the metrics): a backward step of the shown runner while it runs forward, and
      // uneven per-frame travel of the shown rivals are what a player perceives as stutter.
      if (rawDt > 0 && state.phase !== 'PAUSED') {
        const dy = displayY - motion.y, forward = (input.forward ?? 0) > .5 && state.phase === 'RUNNING' && motion.phase === 'RUNNING';
        if (forward && motion.frames > 0) { motion.local++; if (dy < -.5) motion.back++; if (Math.abs(dy) < .05) motion.lstall++; const v = dy / (rawDt / 1000); motion.ls += v; motion.lq += v * v; }
        for (const r of remotes) {
          const old = motion.remote.get(r.id), d = old ? Math.hypot(r.x - old.x, r.y - old.y) / (rawDt / 1000) : 0;
          if (old && r.phase === 'RUNNING' && old.phase === 'RUNNING') { motion.rn++; motion.rs += d; motion.rq += d * d; if (d < 1 && old.v > 60) motion.stall++; if (old.v > 30 && d > old.v * 2.5) motion.spike++; }
          motion.remote.set(r.id, { x: r.x, y: r.y, v: old ? old.v * .7 + d * .3 : d, phase: r.phase });
        }
        motion.y = displayY; motion.phase = state.phase; motion.frames++;
      }
      if (state.phase !== 'PAUSED') soundscape(state.elapsed, displayX, displayY);
      else for (const k of ['rumble', 'wind', 'grind'] as const) latest.current.onAmbience?.(k, 0, 0);
      // A wind swell as a sprint begins (only when stamina actually allows it).
      const sprinting = input.sprint && state.stamina > 0 && state.phase === 'RUNNING';
      if (sprinting && !wasSprinting) audio('sprint');
      wasSprinting = sprinting;
      world.frame(frameView(now, state.phase === 'PAUSED' ? 0 : dt));

      if (now - hudAt > 100) {
        hudAt = now;
        const view = frameView(now, 0);
        const skill = state.dashTime > 0 ? 'DASH' : state.rushTime > 0 ? 'ECHO RUSH' : input.sprint && state.stamina > 0 ? 'SPRINT' : '';
        const rising = trials(state) && state.rising[state.checkpoint] ? { armed: state.riseStart >= 0, sill: currentSill(state), reach: TRIALS.sillStep + TRIALS.jumpSpeed * TRIALS.jumpSpeed / (2 * TRIALS.gravity) } : null;
        const w6 = v6() && state.checkpoint < state.total ? state.walls[state.checkpoint] : null;
        const ahead6 = v6() ? hazardsAt(state.hazards, state.checkpoint).find(z => displayY < z.to + 60) ?? null : null;
        const hzHud = v6() ? ahead6 : hz, hzDistance = hzHud ? hzHud.from - displayY : Infinity;
        latest.current.onHud({ phase: state.phase, countdown: Math.ceil(state.countdown), elapsed: state.elapsed, stamina: state.stamina, dash: state.dashCooldown, energy: state.rushEnergy, checkpoint: state.checkpoint,
          skill, streak: state.streak, aim: view.aim, tried, remaining, segment: boundary(state) - wallAt(state, state.checkpoint - 1), rank, racers, progress,
          hazard: hzHud && hzDistance < 1400 && displayY < hzHud.to + 60 ? { kind: hzHud.kind, distance: Math.max(0, hzDistance), inside: hzDistance <= 0 } : null,
          rising, airborne: state.z > .5, dodge: state.dodgeCooldown, guard: state.guard, trials: trials(state), knocks: state.knocks, falls: state.falls,
          reforged: v6(), wall: w6 ? { kind: w6.kind, distance: Math.max(0, currentPlane(state) - displayY), moving: w6.travel > 0 || w6.amp > 0, closed: shut(w6, state.elapsed) && state.openGate < 0 } : null,
          speedBuff: Math.max(0, state.speedUntil - state.elapsed), shield: state.shield, orb: state.orbSerial > 0 ? { kind: state.lastOrb as OrbKind, serial: state.orbSerial } : null,
          marked, moving: Math.hypot(input.horizontal, input.forward ?? 0) > .05 });
        if (isDebugDatasetOn()) {
          canvas.dataset.phase = state.phase; canvas.dataset.x = state.x.toFixed(1); canvas.dataset.progress = state.y.toFixed(1); canvas.dataset.checkpoint = String(state.checkpoint); canvas.dataset.skill = skill;
          canvas.dataset.streak = String(state.streak); canvas.dataset.aim = String(view.aim); canvas.dataset.quality = world.tier;
          canvas.dataset.z = state.z.toFixed(1); canvas.dataset.clock = state.elapsed.toFixed(3); canvas.dataset.guard = state.guard.toFixed(2); canvas.dataset.knocks = String(state.knocks); canvas.dataset.falls = String(state.falls);
          canvas.dataset.jumps = String(state.jumps); canvas.dataset.dodges = String(state.dodges); canvas.dataset.sill = currentSill(state).toFixed(1);
          canvas.dataset.vx = state.vx.toFixed(1); canvas.dataset.vz = state.vz.toFixed(1); canvas.dataset.forward = (input.forward ?? 0).toFixed(2); canvas.dataset.horizontal = input.horizontal.toFixed(2); canvas.dataset.vy = state.vy.toFixed(1); canvas.dataset.floor = state.floorY.toFixed(1);
          canvas.dataset.plane = currentPlane(state).toFixed(1); canvas.dataset.slide = currentSlide(state).toFixed(1); canvas.dataset.shield = String(state.shield);
          canvas.dataset.marked = String(marked); canvas.dataset.version = String(state.courseVersion);
          const takenKey = `${state.taken.length}:${state.orbSerial ?? 0}`;
          if (takenKey !== serializedTakenKey) { serializedTakenKey = takenKey; canvas.dataset.taken = JSON.stringify(state.taken); }
          if (state.walls !== serializedWalls) { serializedWalls = state.walls; canvas.dataset.walls = JSON.stringify(state.walls); }
          if (state.orbs !== serializedOrbs) { serializedOrbs = state.orbs; canvas.dataset.orbs = JSON.stringify(state.orbs); }
          if (state.hazards !== serializedHazards) { serializedHazards = state.hazards; canvas.dataset.hazards = JSON.stringify(state.hazards); }
          if (state.rising !== serializedRising) { serializedRising = state.rising; canvas.dataset.rising = JSON.stringify(state.rising); }
          const labelsKey = `${q?.id ?? ''}:${q?.options.length ?? 0}`;
          if (labelsKey !== serializedLabelsKey) { serializedLabelsKey = labelsKey; canvas.dataset.gateLabels = JSON.stringify(q?.options.map(o => o.label) ?? []); }
          canvas.dataset.playBounds = JSON.stringify({ barrier: boundary(state), remaining, finish: finishLine(state), camera: world.camera.position.toArray().map(v => +v.toFixed(2)) });
          canvas.dataset.doors = JSON.stringify(q ? q.options.map((_, i) => world.doorScreen(state.checkpoint, i, state.gates)) : []);
          canvas.dataset.worldObjects = JSON.stringify({ passed: [...passedGates.entries()].map(([checkpoint, v]) => ({ checkpoint, ...v })), current: state.checkpoint < state.total ? { checkpoint: state.checkpoint, boundary: boundary(state), openGate: state.openGate } : null, finish: finishLine(state) });
          canvas.dataset.visibleRacers = String(racers);
          canvas.dataset.camera = JSON.stringify(world.cameraDiagnostics());
          if (now - metricsAt > 1000) {
            metricsAt = now; canvas.dataset.metrics = JSON.stringify(frameStats(times)); canvas.dataset.render = JSON.stringify(world.stats());
            const cv = (n: number, s: number, q: number) => n > 1 && s > 0 ? +(Math.sqrt(Math.max(0, q / n - (s / n) ** 2)) / (s / n)).toFixed(3) : null;
            canvas.dataset.motion = JSON.stringify({ frames: motion.frames, local: motion.local, back: motion.back, lstall: motion.lstall, localCv: cv(motion.local, motion.ls, motion.lq), corrections: motion.corrections, maxCorrection: +motion.maxCorrection.toFixed(1),
              remote: motion.rn, remoteCv: cv(motion.rn, motion.rs, motion.rq), stall: motion.stall, spike: motion.spike,
              rtt: Math.round(latest.current.network?.rtt?.() ?? -1), lead: modern() ? +((simTarget(now) ?? 0) - (arrivals.now(now) ?? 0)).toFixed(3) : null });
            Object.assign(motion, { local: 0, back: 0, lstall: 0, ls: 0, lq: 0, rn: 0, rs: 0, rq: 0, stall: 0, spike: 0, corrections: 0, maxCorrection: 0 });
          }
        }
      }
      raf = requestAnimationFrame(render);
    }
    void world.prepare(frameView(performance.now(), 0)).then(() => {
      if (disposed) return;
      readyStarted = true;
      latest.current.onReady(handle);
      if (document.hidden) {
        if (latest.current.network) startHiddenHeartbeat();
      } else {
        raf = requestAnimationFrame(render);
      }
    });
    return () => {
      disposed = true; stopHiddenHeartbeat(); cancelAnimationFrame(raf); observer.disconnect(); clearInput();
      for (const k of ['rumble', 'wind', 'grind'] as const) latest.current.onAmbience?.(k, 0, 0);
      window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); window.removeEventListener('blur', blurred); window.removeEventListener('beforeunload', leaving); document.removeEventListener('visibilitychange', hidden);
      offView(); document.removeEventListener('mousemove', turnHead); canvas.removeEventListener('pointerdown', takePointer); mouse.dispose(); mouseRef.current = null;
      world.dispose();
    };
    // One scene per mounted race. Props callbacks/question changes use latest/advance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" role="img" aria-label="Echo Quiz Rush" data-testid="rush-canvas" />;
}
