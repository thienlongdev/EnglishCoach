import type { HangmanDifficulty, HangmanRound, HangmanTrack } from '@/types/hangman';

export function entryDifficulty(value: string | null): HangmanDifficulty {
  return value === 'MEDIUM' || value === 'HARD' ? value : 'EASY';
}
export function hangmanLocation(difficulty: HangmanDifficulty, play = false) {
  return `/games/hangman?difficulty=${difficulty}${play ? '&view=play' : ''}`;
}

/** Entry is a navigation policy, never a rewrite of saved game history. */
export function playableEntry(track: HangmanTrack, saved: HangmanRound | null) {
  if (saved?.status === 'ACTIVE') return { resume: saved, level: saved.levelNumber, completed: false };
  if (track.catalogCompleted) return { resume: null, level: track.publishedLevels, completed: true };
  const level = saved?.status === 'WON'
    ? Math.min(saved.levelNumber + 1, track.highestUnlocked, track.publishedLevels)
    : saved?.levelNumber ?? track.lastPlayedLevel;
  return { resume: null, level, completed: false };
}

export const LOSS_DURATION = 4400;
export const LOSS_STAGES = [
  [0, 'FINAL_POP'], [280, 'FREE_FALL'], [1100, 'WATER_CONTACT'], [1320, 'WATER_STRUGGLE'],
  [2000, 'SHARK_APPROACH'], [2850, 'SHARK_BITE'], [3070, 'X_EYES_REACTION'], [LOSS_DURATION, 'LOSS_RESULT'],
] as const;
export type LossPhase = typeof LOSS_STAGES[number][1];
export function lossPhase(elapsed: number): LossPhase {
  return [...LOSS_STAGES].reverse().find(([at]) => elapsed >= at)?.[1] ?? 'FINAL_POP';
}
export const lossClockRate = (reduced: boolean) => reduced ? 4 : 1;
export const descent = (initial: number, remaining: number) =>
  58 * Math.min(1, Math.max(0, (initial - remaining) / Math.max(1, initial - 1)));

/** A response from an old route/account/round or an older version cannot replace current UI. */
export function acceptsRound(current: HangmanRound | null, next: HangmanRound, generation: number, activeGeneration: number) {
  return generation === activeGeneration && (!current || (current.roundId === next.roundId && next.version >= current.version));
}
