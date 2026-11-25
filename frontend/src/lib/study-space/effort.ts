import { affordanceOf } from './affordances';

/**
 * Human effort against real resistance, in newtons. A thing starts to slide when the push beats static friction (μs·m·g), keeps
 * sliding while it beats sliding friction (μk·m·g), and comes off the floor only when the arms beat its weight (m·g). What one adult
 * can do braced on a wooden floor bounds all of it: past that the thing does not move, however many times the button is pressed.
 * Pure numbers, no three.js: the meter, the push controller and the tests read the same answers.
 */
export const GRAVITY = 9.81;

/** What one adult manages, braced, both hands unless said. Newtons. */
export const HUMAN = {
  push: 430,
  pull: 410,
  /** Lifting with both arms close to the body; one hand only a small thing. */
  liftTwo: 45 * GRAVITY,
  liftOne: 9 * GRAVITY,
  /** A push or a lift this light needs no gathering of strength: it simply happens. */
  effortlessPush: 70,
  effortlessLift: 40,
} as const;

/** What touches the floor: the feet of the thing, not its upholstery. Static and sliding friction on the room's wooden floor. */
type Feet = 'casters' | 'wood-legs' | 'wood-base' | 'metal' | 'fabric' | 'ceramic';
const FRICTION: Record<Feet, { static: number; sliding: number; vi: string; en: string }> = {
  casters: { static: .07, sliding: .045, vi: 'bánh xe', en: 'casters' },
  'wood-legs': { static: .42, sliding: .3, vi: 'chân gỗ trên sàn gỗ', en: 'wooden legs on wood' },
  'wood-base': { static: .48, sliding: .36, vi: 'đế gỗ trên sàn gỗ', en: 'a wooden base on wood' },
  metal: { static: .3, sliding: .22, vi: 'đế kim loại', en: 'a metal base' },
  fabric: { static: .55, sliding: .45, vi: 'vải trên sàn', en: 'fabric on the floor' },
  ceramic: { static: .5, sliding: .4, vi: 'chậu gốm', en: 'a ceramic pot' },
};
const FEET: Record<string, Feet> = {
  'chair.office': 'casters',
  'bed.drawer': 'wood-base', drawers: 'wood-base', nightstand: 'wood-base', 'shelf.tall': 'wood-base',
  beanbag: 'fabric', pouf: 'fabric', 'rug.round': 'fabric', 'rug.rect': 'fabric', 'rug.cloud': 'fabric',
  'lamp.floor': 'metal', telescope: 'metal', monitor: 'metal',
  'plant.monstera': 'ceramic', 'plant.snake': 'ceramic',
};
export function feetOf(kind: string): Feet {
  if (FEET[kind]) return FEET[kind];
  const a = affordanceOf(kind);
  return a.family === 'plant' ? 'ceramic' : a.family === 'rug' ? 'fabric' : a.material === 'metal' ? 'metal' : 'wood-legs';
}

export interface Resistance {
  kind: string;
  mass: number;
  /** Newtons to break it free (static friction), and to keep it sliding. */
  breakaway: number;
  sliding: number;
  /** The most a person brings to bear in this direction. */
  human: number;
  feasible: boolean;
  /** Light enough to need no gathering of strength. */
  effortless: boolean;
  feet: { vi: string; en: string };
}

/** Pushing or pulling something along the floor: friction, never its weight, decides. Pulling is a little weaker than pushing. */
export function slideResistance(kind: string, pulling = false): Resistance {
  const a = affordanceOf(kind), f = FRICTION[feetOf(kind)];
  const breakaway = f.static * a.mass * GRAVITY, sliding = f.sliding * a.mass * GRAVITY;
  const human = pulling ? HUMAN.pull : HUMAN.push;
  return { kind, mass: a.mass, breakaway, sliding, human, feasible: a.mobility !== 'fixed' && breakaway <= human, effortless: breakaway <= HUMAN.effortlessPush, feet: { vi: f.vi, en: f.en } };
}

/** Lifting off its support: the whole weight, a little more to start it rising. */
export function liftResistance(kind: string): Resistance {
  const a = affordanceOf(kind);
  const weight = a.mass * GRAVITY * 1.12;
  const human = a.hands === 2 ? HUMAN.liftTwo : HUMAN.liftOne;
  return { kind, mass: a.mass, breakaway: weight, sliding: weight, human, feasible: a.mobility === 'portable' && weight <= human, effortless: weight <= HUMAN.effortlessLift, feet: { vi: '', en: '' } };
}

/**
 * The strength a person gathers: rapid presses add to it, holding the button (or the key) builds it steadily, both to the same
 * ceiling, and it fades when nothing feeds it. The same input gives the same force whatever the frame rate.
 */
export class EffortGauge {
  /** Newtons being applied now. */
  applied = 0;
  private holding = false;
  constructor(readonly max: number) {}
  /** One press: a sharp gathering of strength. About ten fast presses reach the ceiling. */
  tap() { this.applied = Math.min(this.max, this.applied + this.max * .13); }
  hold(on: boolean) { this.holding = on; }
  get held() { return this.holding; }
  update(dt: number) {
    if (this.holding) this.applied = Math.min(this.max, this.applied + this.max * .42 * dt);
    else this.applied *= Math.exp(-.55 * dt);
    if (this.applied < .5) this.applied = 0;
  }
  /** 0..1 of the ceiling, for the meter. */
  get level() { return this.max > 0 ? this.applied / this.max : 0; }
}

/** Speed the legs can keep while moving this much weight along the floor. */
export function pushSpeed(mass: number) { return Math.max(.45, Math.min(1.25, 1.45 - mass / 95)); }
