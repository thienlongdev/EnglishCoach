import { stepSpring } from '@/lib/morph/spring';
import { MORPH_ID, MORPH_SPRING } from './tokens';

// Motion intent only, no room/account data and no retained canvas across routes.
let arrival: { path: string; at: number } | null = null;
export function markWorldPassage(path: string) {
  arrival = ['/study-space', '/speaking/arena', '/games'].includes(path) ? { path, at: Date.now() } : null;
}
export function takeWorldPassage(path: string) {
  const age = arrival ? Date.now() - arrival.at : Infinity;
  const match = arrival?.path === path && age >= 0 && age < 8000;
  if (match || age < 0 || age >= 8000) arrival = null;
  return !!match;
}
/** Scene-owned lens settling using the deployed Echo Morph 2.0 spring. Never delays navigation. */
export class ScenePassage {
  readonly id = MORPH_ID;
  private state = { position: 0, velocity: 0 };
  private target = 0;
  constructor(arriving = false) { if (arriving) this.state.position = 1; }
  leave(value: boolean) { this.target = value ? 1 : 0; }
  update(dt: number, reduced: boolean) {
    this.state = reduced ? { position: 0, velocity: 0 } : stepSpring(this.state, this.target, dt, MORPH_SPRING.surface);
    return this.state.position;
  }
}
