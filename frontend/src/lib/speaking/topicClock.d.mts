import type { TopicStyle } from '@/types/speakingTopic';

export interface TopicSettings {
  quickSeconds: number;
  readyCountdown: boolean;
  deepPrepSeconds: number;
  deepSpeakSeconds: number;
  part1Seconds: number;
  part3Seconds: number;
}

export interface Clock {
  durationMs: number;
  startedAt: number;
  pausedAt: number | null;
  pausedTotal: number;
}

export interface PlanStep {
  kind: 'ready' | 'prep' | 'speak';
  ms: number;
  question: number;
  minMs?: number;
}

export declare const PRESETS: Readonly<{
  quickSpeak: number[];
  deepPrep: number[];
  deepSpeak: number[];
  part1Answer: number[];
  part3Answer: number[];
  readyMs: number;
  part2PrepMs: number;
  part2SpeakMs: number;
  part2MinMs: number;
}>;
export declare const DEFAULT_SETTINGS: Readonly<TopicSettings>;
export declare function startClock(durationMs: number, now: number): Clock;
export declare function elapsedMs(clock: Clock, now: number): number;
export declare function remainingMs(clock: Clock, now: number): number;
export declare function isDone(clock: Clock, now: number): boolean;
export declare function pauseClock(clock: Clock, now: number): Clock;
export declare function resumeClock(clock: Clock, now: number): Clock;
export declare function formatCountdown(ms: number): string;
export declare function formatElapsed(ms: number): string;
export declare function buildPlan(style: TopicStyle, settings: Partial<TopicSettings>, questionCount: number): PlanStep[];
export declare function targetSeconds(style: TopicStyle, plan: PlanStep[]): number;
export declare function canPause(style: TopicStyle): boolean;
