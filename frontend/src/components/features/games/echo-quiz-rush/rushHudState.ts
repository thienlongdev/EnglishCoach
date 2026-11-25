import type { SceneHud } from './RushScene';

/** The HUD before the scene reports (shared by Solo and competitive races). */
export const RUSH_INITIAL_HUD: SceneHud = {
  phase: 'COUNTDOWN', countdown: 3, elapsed: 0, stamina: 100, dash: 0, energy: 0, checkpoint: 0, skill: '', streak: 0, aim: -1, tried: [], remaining: 9999, segment: 1, rank: 1, racers: 1, progress: [],
  hazard: null, rising: null, airborne: false, dodge: 0, guard: 0, trials: false, knocks: 0, falls: 0,
  reforged: false, wall: null, speedBuff: 0, shield: 0, orb: null, marked: -1, moving: false,
};
/** Orb names and what they did (vi / en) — the same effects as RushReforged (speed +25 % for 4 s, +35 energy, one blocked hit). */
export const orbText = (kind: string, vi: boolean): [string, string] => kind === 'SPEED' ? (vi ? ['Cầu Tốc độ', '+25% tốc độ trong 4 giây'] : ['Speed Orb', '+25% speed for 4 s'])
  : kind === 'ENERGY' ? (vi ? ['Cầu Năng lượng', '+35 năng lượng Echo Rush'] : ['Energy Orb', '+35 Echo Rush energy']) : (vi ? ['Cầu Khiên', 'Đỡ một cú va chạm (12 giây)'] : ['Guard Orb', 'Blocks one hit (12 s)']);
