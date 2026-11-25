/** "Nói theo chủ đề" — wire types of `/api/v1/speaking/topics/**` (no AI, no scoring). */

export type TopicStyle = 'QUICK' | 'DEEP' | 'IELTS1' | 'IELTS2' | 'IELTS3';
export type TopicBand = 'BASIC' | 'INTERMEDIATE' | 'ADVANCED';

export interface TopicCategoryCount {
  key: string;
  vi: string;
  en: string;
  count: number;
}

export interface TopicStyleCatalog {
  style: TopicStyle;
  units: number;
  questions: number;
  categories: TopicCategoryCount[];
  bands: Record<TopicBand, number>;
}

export interface TopicCatalog {
  version: string;
  provenance: string;
  reviewStatus: string;
  styles: TopicStyleCatalog[];
}

export interface TopicItem {
  id: string;
  style: TopicStyle;
  category: string;
  categoryVi: string;
  categoryEn: string;
  level: string;
  band: TopicBand;
  title: string | null;
  /** QUICK / DEEP: one prompt · IELTS1 / IELTS3: the linked questions · IELTS2: the cue-card task */
  questions: string[];
  bullets: string[];
  explain: string | null;
  definition: { term: string; en: string; vi: string } | null;
  linkedId: string | null;
  followUpId: string | null;
}

export type TopicDrawOutcome = 'DRAWN' | 'EXHAUSTED' | 'EMPTY';

export interface TopicDraw {
  outcome: TopicDrawOutcome;
  drawId: number | null;
  item: TopicItem | null;
  poolSize: number;
  unseenRemaining: number;
}

export interface TopicRound {
  drawId: number;
  status: 'DRAWN' | 'SKIPPED' | 'STARTED' | 'FINISHED';
  targetSeconds: number | null;
  spokenSeconds: number | null;
  reachedTarget: boolean | null;
  recorded: boolean;
}

export interface TopicHistoryEntry {
  drawId: number;
  status: 'STARTED' | 'FINISHED';
  spokenSeconds: number | null;
  reachedTarget: boolean | null;
  drawnAt: string;
  item: TopicItem;
}

export interface TopicSummary {
  roundsFinished: number;
  roundsReachedTarget: number;
  spokenSeconds: number;
  distinctTopicsSpoken: number;
  topicsDrawn: number;
  lastPracticeAt: string | null;
  recent: TopicHistoryEntry[];
  favorites: TopicItem[];
}
