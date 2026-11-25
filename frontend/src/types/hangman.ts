export type HangmanDifficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type HangmanStatus = 'ACTIVE' | 'WON' | 'LOST';

export interface HangmanTrack {
  difficulty: HangmanDifficulty;
  startingBalloons: number;
  prefillCount: number;
  highestUnlocked: number;
  lastPlayedLevel: number;
  publishedLevels: number;
  eligibleWordCount: number;
  currentRoundId: string | null;
  catalogCompleted: boolean;
}
export interface HangmanBootstrap {
  catalogVersion: string;
  tracks: HangmanTrack[];
  wordAttribution: string;
  wordSource: string;
  sourceWordCount: number;
}
export interface HangmanRound {
  roundId: string;
  difficulty: HangmanDifficulty;
  levelNumber: number;
  category: string;
  pattern: Array<string | null>;
  prefilledLetters: string[];
  correctLetters: string[];
  wrongLetters: string[];
  hintedLetters: string[];
  initialBalloons: number;
  remainingBalloons: number;
  hintsRemaining: number;
  status: HangmanStatus;
  version: number;
  score: number | null;
  answer: string | null;
  nextLevelAvailable: boolean;
  catalogCompleted: boolean;
}
