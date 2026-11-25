import type { Hazard } from '@/components/features/games/echo-quiz-rush/rushTrials';
import type { Orb, Wall6 } from '@/components/features/games/echo-quiz-rush/rushReforged';
export type RushDifficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type RushTopic = 'MIXED' | 'VOCABULARY' | 'WORD_RELATIONS' | 'SPELLING' | 'GRAMMAR' | 'WORD_USE' | 'PHRASAL_VERBS' | 'IDIOMS_EXPRESSIONS';
export interface RushOption { id: string; label: string }
export interface RushQuestion { id: string; family: string; prompt: string; context: string; options: RushOption[] }
export interface RushReview { family: string; prompt: string; context: string; answer: string; explanation: string; mistakes: number; sourceRefs?: string | null }
export interface RushSession {
  id: string; status: 'ACTIVE' | 'FINISHED' | 'ABANDONED'; difficulty: RushDifficulty; topic: RushTopic;
  total: number; checkpoint: number; correct: number; incorrect: number; startedAt: string; finishedAt: string | null;
  elapsedMs: number; question: RushQuestion | null; review: RushReview[]; contentVersion: string; courseVersion: number; spacing: number;
  /** Skybound (v4): cumulative wall positions; empty for older courses. Momentum is the server's first-try streak. */
  boundaries?: number[]; streak?: number; bestStreak?: number;
  /** Version 5 (Trials): the server-planned obstacle zones and rising walls. */
  hazards?: Hazard[]; rising?: boolean[];
  /** Version 6 (Reforged): each wall's motion and the course's orbs. */
  walls?: Wall6[]; orbs?: Orb[];
}
export interface RushFeedback { session: RushSession; correct: boolean; repeated: boolean; explanation: string }
export interface RushConfig { available: boolean; eligible: Record<string, number>; topics: Record<string, string[]>; attribution: string; contentVersion: string }
export interface RushSetup { difficulty: RushDifficulty; topic: RushTopic; checkpoints: number }
