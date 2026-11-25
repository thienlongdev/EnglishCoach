// Echo Learning Path ("Lộ trình học") — mirrors backend/src/main/java/com/englishcoach/learningpath/LearningPathDtos.java

export type LearningGoal = 'GENERAL' | 'COMMUNICATION' | 'IELTS' | 'TOEIC';
export type DailyMinutes = 15 | 30 | 45 | 60;
export type TaskKind = 'PLACEMENT' | 'VOCAB_REVIEW' | 'DICTATION' | 'READING' | 'TOPIC_SPEAKING' | 'WRITING' | 'EXAM_PRACTICE';
export type PathSkill = 'VOCABULARY' | 'LISTENING' | 'READING' | 'SPEAKING' | 'WRITING' | 'ASSESSMENT';
export type LevelBasis = 'PROFICIENCY' | 'PLACEMENT' | 'PROVISIONAL';

export interface LearningPlanView {
  goal: LearningGoal;
  dailyMinutes: DailyMinutes;
  target: string | null;
  level: string;
  levelBasis: LevelBasis;
  stage: number;
  version: number;
  focus: Record<string, number>;
  focusUpdatedAt: string | null;
}

export interface LearningTask {
  id: number;
  kind: TaskKind;
  skill: PathSkill;
  targetId: number | null;
  targetKey: string | null;
  title: string;
  minutes: number;
  goalCount: number;
  progress: number;
  status: 'OPEN' | 'DONE';
  reason: string;
  carried: boolean;
  resultPct: number | null;
  /** Exam practice only: "<form version uuid>/<practice part code>". */
  targetRef: string | null;
}

export interface StageRequirement {
  code: 'TASKS' | 'SKILLS' | 'LEVEL' | 'CORE_SKILLS' | string;
  current: number;
  needed: number;
  met: boolean;
}

export interface StageView {
  current: number;
  next: StageRequirement[];
  assessmentNeeded: boolean;
}

export interface TodayView {
  plan: LearningPlanView | null;
  day: string | null;
  tasks: LearningTask[];
  done: number;
  total: number;
  minutes: number;
  stage: StageView | null;
}

export interface SkillView {
  skill: Exclude<PathSkill, 'ASSESSMENT'>;
  band: 'UNKNOWN' | 'NEEDS_WORK' | 'DEVELOPING' | 'STRONG' | 'NOT_MEASURED';
  observations: number;
  daysSinceLast: number | null;
}

export interface ProgressSummary {
  plan: LearningPlanView | null;
  stage: StageView | null;
  skills: SkillView[];
  tasksDone: number;
  tasksDone7d: number;
  tasksDone30d: number;
}

export interface DnaChange {
  skill: string;
  direction: 'UP' | 'DOWN';
  reason: string;
}

export interface DnaProposal {
  id: number;
  baseVersion: number;
  dnaGeneratedAt: string;
  expiresAt: string;
  changes: DnaChange[];
  facts: {
    cardsForgetting: number;
    sounds: string[];
    grammar: string[];
    listeningMistakes: number;
    speakingPauses: boolean;
  };
}

export interface GoalInput {
  goal: LearningGoal;
  dailyMinutes: DailyMinutes;
  target: string | null;
}
