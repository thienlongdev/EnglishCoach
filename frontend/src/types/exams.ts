// English Coach Exams - Type Definitions

export type ExamFamily = 'IELTS' | 'TOEIC';

export type ExamVariant =
  | 'ACADEMIC'
  | 'GENERAL_TRAINING'
  | 'LR'
  | 'SPEAKING'
  | 'WRITING'
  | 'SUITE';

export type ExamScope =
  | 'FULL'
  | 'LISTENING'
  | 'READING'
  | 'WRITING'
  | 'SPEAKING'
  | 'OSR'
  | 'PARTS_1_7';

export type ExamAttemptMode = 'EXAM_SIMULATION' | 'PRACTICE';

export type ExamAttemptStatus =
  | 'CREATED'
  | 'READY'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'EXPIRED'
  | 'INVALIDATED';

export type ExamSectionState = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'SKIPPED';

export type ScoreMetric =
  | 'LISTENING'
  | 'READING'
  | 'WRITING'
  | 'SPEAKING'
  | 'FULL_OVERALL'
  | 'LR_TOTAL';

export type ResultStatus = 'COMPLETED' | 'PARTIAL' | 'REVIEW_REQUIRED' | 'FAILED';

export interface CatalogFormDto {
  id: string;
  logicalKey: string;
  version: number;
  title: string;
  family: ExamFamily;
  variant: ExamVariant | string;
  scope: ExamScope | string;
  collectionTitle?: string;
  totalDurationMinutes: number;
  totalItems: number;
  skills: string[];
  state: string;
  publishedAt?: string;
  /** Legacy operator column; no longer sent by the server (Exams Phase 2). */
  primaryHealthStatus?: string;
  /** Skills runnable in PRACTICE (authoritative server validation, even when empty). */
  runnableSkills?: string[];
  /** Full standardized simulation available (authoritative server validation). */
  fullExamRunnable?: boolean;
  /** Server validation is not VALID: some content is broken or not standardized. */
  contentReviewRequired?: boolean;
  /** Exams Phase 2: skills that are simulation-grade. */
  simulationSkills?: string[];
  /** Exact AVAILABLE scopes; independent of whole-skill/full-simulation readiness. */
  practiceScopeCodes?: string[];
  /** Exams Phase 2: modes a learner may start; authoritative when present. */
  availableModes?: ExamStartMode[];
  /** Exams Phase 2: concise, learner-safe validation state (no diagnostics). */
  validationStatus?: ExamContentValidationStatus;
}

/** Shared catalog metadata window; legacy array adapters may omit window-only fields. */
export interface CatalogWindowDto {
  forms: CatalogFormDto[];
  total: number;
  hasMore?: boolean;
  variants?: string[];
  simulationCount?: number;
  practiceCount?: number;
  page?: number;
  totalPages?: number;
}

export type ExamStartMode = 'PRACTICE' | 'EXAM_SIMULATION';

export type ExamContentValidationStatus = 'VALID' | 'NEEDS_REVIEW' | 'INVALID' | 'UNKNOWN';

export interface PublicAssetRefDto {
  assetId: string;
  role: string;
  mimeType: string;
  durationMs?: number;
  /**
   * Exams Phase 4B.6: how the runner resolves the asset. 'PLAYBACK_GRANT' = POST /attempts/{id}/playback-grants
   * with assetId (audio AND images). No object key / storage path is ever sent to the client.
   */
  delivery?: 'PLAYBACK_GRANT' | string;
}

export interface PublicStimulusDto {
  id: string;
  kind: string;
  title: string;
  bodyPayload: Record<string, any>;
  assets: PublicAssetRefDto[];
}

export interface PublicItemDto {
  id: string;
  placementId: string;
  logicalItemKey?: string;
  prompt: string;
  interactionType: string;
  options?: Record<string, any> | any[] | null;
  /** Legacy alias for backward compatibility with unmigrated payloads */
  optionDefinitions?: Record<string, any> | any[] | null;
  /** Learner selection size: 2 for a "Choose TWO" pair (each item still stores ONE option id). */
  cardinality: number;
  /** Server answer-spec word limit (Exams Phase 4B.7); the server enforces it when scoring. */
  wordLimit?: number | null;
}

/**
 * Printed group-level presentation carried once per group (Exams Phase 4B.3–4B.5). Never contains answer keys.
 */
export interface GroupPresentation {
  kind?: string;
  /** Printed question range, e.g. "15-16". */
  questions?: string;
  /** Printed instruction lines, shown once per group. */
  instructions?: string[];
  /** Shared completion template; blanks are written "(n) ______". */
  stem?: string;
  layout?: string;
  wordLimitRule?: string;
  wordLimit?: number;
  /** "Choose TWO": exactly `count` distinct options spread over the printed `questions`. */
  selection?: { count: number; questions: number[] };
}

export interface PublicGroupDto {
  id: string;
  placementId?: string;
  logicalGroupKey?: string;
  questionType: string;
  formKind?: string;
  skill: string;
  ordinal?: number;
  displayNumbering?: string;
  stimuli: PublicStimulusDto[];
  items: PublicItemDto[];
  presentation?: GroupPresentation | null;
}

export interface PublicPartDto {
  id: string;
  partCode: string;
  ordinal: number;
  instructions?: string;
  timingPolicy?: Record<string, any>;
  formKind?: string;
  groups: PublicGroupDto[];
}

export interface PublicSectionDto {
  id: string;
  skill: string;
  ordinal: number;
  specSectionKey?: string;
  durationSeconds: number;
  timingPolicy?: Record<string, any>;
  parts: PublicPartDto[];
}

export interface PublicAttemptManifestDto {
  attemptId?: string;
  formId: string;
  title: string;
  family: ExamFamily;
  variant: string;
  scope: string;
  mode?: ExamAttemptMode;
  manifestHash: string;
  serverRevision?: number;
  manifestScope?: string;
  totalDurationSeconds?: number;
  sections: PublicSectionDto[];
  /** Exams Phase 6: present only for a practice-scoped attempt (server-pinned scope summary). */
  practiceScope?: PracticeScopeSummary | null;
}

export type PublicManifestDto = PublicAttemptManifestDto;

// ─── Exams Phase 6: Practice + Review ───────────────────────────────────────

export type PracticeScopeType = 'TOEIC_PART' | 'IELTS_LISTENING_SECTION' | 'IELTS_READING_PASSAGE' | 'IELTS_WRITING_TASK' | 'IELTS_SPEAKING_PART';
/** Learner availability only — internal reason codes never reach the learner. */
export type PracticeAvailability = 'AVAILABLE' | 'CONTENT_IN_PROGRESS' | 'UNAVAILABLE';

export interface PracticeScopeSummary {
  scopeCode: string;
  scopeType: PracticeScopeType;
  skill: string;
  number: number;
  itemCount?: number;
  scoringMode?: 'OBJECTIVE_RAW' | 'RESPONSE_ONLY';
  timingMode?: 'UNTIMED';
  reviewPolicy?: 'AFTER_SUBMISSION';
  sourceFormVersion?: number;
}

export interface PracticeScopeDto {
  scopeCode: string;
  scopeType: PracticeScopeType;
  skill: string;
  number: number;
  questionCount: number;
  objectiveScoring: boolean;
  scoringMode: 'OBJECTIVE_RAW' | 'RESPONSE_ONLY';
  timingMode: 'UNTIMED';
  availability: PracticeAvailability;
  reviewAvailable: boolean;
  requiresAudio: boolean;
  requiresImage: boolean;
}

export interface PracticeCatalogDto {
  formId: string;
  family: ExamFamily;
  title: string;
  scopes: PracticeScopeDto[];
}

export interface PracticeAttemptDto {
  attemptId: string;
  formId: string;
  scopeCode: string;
  status: string;
  resumedExisting: boolean;
  practiceAgainOf?: string | null;
}

/** Raw practice metrics only — never a TOEIC scaled score or an IELTS band. */
export interface PracticeResultDto {
  attemptId: string;
  mode: 'PRACTICE';
  family: ExamFamily;
  scopeCode: string;
  scopeType: PracticeScopeType;
  skill: string;
  scopeNumber: number;
  sourceTitle?: string;
  sourceFormId: string;
  sourceFormVersion?: number;
  completionStatus: string;
  scoringMode: 'OBJECTIVE_RAW' | 'RESPONSE_ONLY';
  correct?: number;
  incorrect?: number;
  unanswered?: number;
  answered?: number;
  total?: number;
  rawAccuracyPercent?: number;
  timeSpentSeconds?: number;
  averageSecondsPerQuestion?: number;
  wordCount?: number;
  minimumWords?: number;
  writingAssessment?: 'NOT_SCORED';
  standardizedScoreAvailable: false;
  reviewAvailable: boolean;
  submittedAt?: string;
}

export type PracticeReviewStatus = 'CORRECT' | 'INCORRECT' | 'UNANSWERED' | 'NOT_SCORED';

export interface PracticeReviewItemDto {
  itemId: string;
  placementId: string;
  logicalItemKey?: string;
  itemVersion: number;
  questionNumber?: number;
  prompt?: string;
  interactionType?: string;
  optionDefinitions?: Record<string, any> | null;
  learnerAnswer?: any;
  correctAnswers: string[];
  status: PracticeReviewStatus;
  outcome?: string;
  correctAnswerAvailable: boolean;
  explanationAvailable: boolean;
  explanation?: string;
  sourceEvidenceAvailable: boolean;
  aiAssistAvailable: boolean;
  wordCount?: number;
  minimumWords?: number;
}

export interface PracticeReviewGroupDto {
  groupId: string;
  displayNumbering?: string;
  questionType?: string;
  presentation?: GroupPresentation | null;
  stimuli: PublicStimulusDto[];
  items: PracticeReviewItemDto[];
}

export interface PracticeReviewDto {
  attemptId: string;
  family: ExamFamily;
  scopeCode: string;
  scopeType: PracticeScopeType;
  skill: string;
  scopeNumber: number;
  sourceTitle?: string;
  sourceFormId: string;
  sourceFormVersion?: number;
  submittedAt?: string;
  contentBasis: 'ATTEMPT_SNAPSHOT';
  summary: PracticeResultDto;
  partInstructions?: string;
  groups: PracticeReviewGroupDto[];
}

// ─── Exams Phase 8: learner analytics, mistakes, recommended practice (GET /exams/analytics) ──────────────
// Owner-scoped by the server (no user id anywhere). Practice = raw counts only; simulation = scorer components only.

export type ExamSignal = 'INSUFFICIENT_DATA' | 'EMERGING_SIGNAL' | 'ESTABLISHED_SIGNAL' | 'NOT_APPLICABLE';

export interface PracticeOverviewDto {
  attempts: number;
  objectiveAttempts: number;
  writingAttempts: number;
  questions: number;
  correct: number;
  incorrect: number;
  unanswered: number;
  rawAccuracyPercent?: number;
  timeSpentSeconds?: number;
  scopesPracticed: number;
  practiceDays: number;
  lastPracticedAt?: string;
  signal: ExamSignal;
}

export interface TrendPointDto {
  attemptId: string;
  submittedAt: string;
  questions: number;
  correct: number;
  rawAccuracyPercent: number;
}

export interface WritingStatsDto {
  submitted: number;
  lastWordCount?: number;
  averageWordCount?: number;
  minimumWords?: number;
  metMinimumCount: number;
  assessment: 'NOT_SCORED';
}

export interface ScopeStatsDto {
  scopeCode: string;
  scopeType: PracticeScopeType;
  skill: string;
  scopeNumber: number;
  objective: boolean;
  attempts: number;
  questions: number;
  answered: number;
  correct: number;
  incorrect: number;
  unanswered: number;
  rawAccuracyPercent?: number;
  recentQuestions?: number;
  recentCorrect?: number;
  recentIncorrect?: number;
  recentUnanswered?: number;
  recentAccuracyPercent?: number;
  earlierAccuracyPercent?: number;
  signal: ExamSignal;
  recentAttempts: number;
  timeSpentSeconds?: number;
  averageSecondsPerQuestion?: number;
  lastPracticedAt?: string;
  currentRepeatedMistakes?: number;
  trend?: TrendPointDto[];
  writing?: WritingStatsDto;
}

export interface InteractionStatsDto {
  interactionType: string;
  questions: number;
  correct: number;
  incorrect: number;
  unanswered: number;
  rawAccuracyPercent: number;
  signal: ExamSignal;
}

export type MistakeState = 'REPEATED' | 'SINGLE' | 'IMPROVED';

export interface MistakeItemDto {
  logicalItemKey?: string;
  itemVersion: number;
  questionNumber?: number;
  interactionType?: string;
  scopeCode: string;
  formTitle?: string;
  occurrences: number;
  missCount: number;
  correctCount: number;
  lastOutcome: 'CORRECT' | 'INCORRECT' | 'UNANSWERED';
  lastSeenAt: string;
  state: MistakeState;
  reviewAttemptId?: string;
  outcomes: Array<'CORRECT' | 'INCORRECT' | 'UNANSWERED'>;
}

export interface MistakeSummaryDto {
  repeated: number;
  single: number;
  improved: number;
  items: MistakeItemDto[];
  totalTracked: number;
}

export interface RecommendationReasonDto {
  code: 'REPEATED_MISTAKES' | 'MANY_BLANKS' | 'RECENT_MISSES' | 'LOWER_THAN_OTHER_SCOPES' | 'IMPROVING' | 'NOT_PRACTICED_YET'
    | 'AVAILABLE_TO_START' | string;
  facts: Record<string, number | string>;
}

export interface PracticeRecommendationDto {
  rank: number;
  kind: 'FOCUS' | 'COVERAGE' | 'START';
  scopeCode: string;
  scopeType: PracticeScopeType;
  skill: string;
  scopeNumber: number;
  formId: string;
  formTitle?: string;
  reasons: RecommendationReasonDto[];
  signal?: ExamSignal;
  sampleQuestions?: number;
  sampleAttempts?: number;
}

export interface RecommendationBlockDto {
  status: 'PERSONALIZED' | 'INSUFFICIENT_DATA' | 'NO_AVAILABLE_SCOPE';
  items: PracticeRecommendationDto[];
}

export interface SimulationComponentDto {
  metric: string;
  scaledScore: number;
  scaleName: string;
  rawScore?: number;
}

export interface SimulationRawSectionDto {
  metric: string;
  correct?: number;
  maxRaw?: number;
  percent?: number;
  scale: string;
}

export interface SimulationAttemptAnalyticsDto {
  attemptId: string;
  formId: string;
  formTitle?: string;
  variant?: string;
  scope?: string;
  submittedAt?: string;
  timeSpentSeconds?: number;
  resultStatus: string;
  components: SimulationComponentDto[];
  rawSections: SimulationRawSectionDto[];
}

export interface SimulationOverviewDto {
  submitted: number;
  withStandardizedScore: number;
  attempts: SimulationAttemptAnalyticsDto[];
}

export interface ActivityWeekDto {
  weekStart: string;
  practiceAttempts: number;
  simulationAttempts: number;
  questions: number;
}

export interface FamilyAnalyticsDto {
  family: ExamFamily;
  practice: PracticeOverviewDto;
  scopes: ScopeStatsDto[];
  questionTypes: InteractionStatsDto[];
  mistakes: MistakeSummaryDto;
  recommendations: RecommendationBlockDto;
  simulation: SimulationOverviewDto;
  activity: ActivityWeekDto[];
}

export interface ExamAnalyticsDto {
  generatedAt: string;
  windowDays: number;
  recentDays: number;
  /** Internal policy versions (support / tests); never rendered to learners. */
  policyVersions: Record<string, string>;
  families: FamilyAnalyticsDto[];
}

export interface AttemptSectionStateDto {
  id: string;
  sectionId: string;
  skill: string;
  state: ExamSectionState;
  phase: string;
  deadlineAt?: string;
  durationSeconds: number;
  remainingSeconds?: number;
}

export interface AttemptStateDto {
  attemptId: string;
  formId: string;
  family: ExamFamily;
  variant: string;
  scope: string;
  mode: ExamAttemptMode;
  status: ExamAttemptStatus;
  revision: number;
  writerEpoch: number;
  serverTime: string;
  startedAt?: string;
  scheduledEndAt?: string;
  activeSectionId?: string;
  sections: AttemptSectionStateDto[];
  responses: Record<string, any>;
  flaggedPlacements: string[];
}

export interface ResponseBatchItem {
  placementId: string;
  itemId?: string;
  answerPayload?: Record<string, any>;
  textResponse?: string;
  recordingId?: string;
  flagged?: boolean;
}

export interface ResponseSaveReceiptDto {
  attemptId: string;
  acknowledgedRevision: number;
  savedCount: number;
  serverTime: string;
}

export interface ComponentScoreDto {
  metric: ScoreMetric;
  rawScore?: number;
  scaledScore: number;
  scaleName: string;
  uncertaintyRange?: Record<string, any>;
  status?: string;
  isPending?: boolean;
}

export interface CriterionScoreDto {
  target: string;
  rubricCriterion: string;
  score: number;
  evidenceReferences?: Array<Record<string, any>>;
  confidenceMeta?: Record<string, any>;
}

export interface ScoringProgressDto {
  attemptId: string;
  resultStatus: ResultStatus;
  isCompleted: boolean;
  stages: { stageKey: string; status: string; durationMs?: number }[];
  failureMessage?: string;
  estimatedReadyAt?: string;
}

export interface ExamResultDto {
  artifactId: string;
  attemptId: string;
  family: ExamFamily;
  variant: string;
  scope: string;
  mode: ExamAttemptMode;
  resultStatus: ResultStatus;
  overallScore?: number;
  skillScores: Record<string, number>;
  components: ComponentScoreDto[];
  criteria: CriterionScoreDto[];
  versionBundle: Record<string, any>;
  completedAt: string;
}

export type SpeakingTurnState =
  | 'LOCKED'
  | 'CURRENT'
  | 'PREPARING'
  | 'READY_TO_RECORD'
  | 'RECORDING'
  | 'UPLOADING'
  | 'RECORDED'
  | 'COMPLETED'
  | 'FAILED_UPLOAD';

export interface SpeakingTurnDto {
  turnKey: string;
  turnSequence: number;
  partCode: string;
  placementId?: string;
  itemId?: string;
  turnState: SpeakingTurnState | string;
  prompt?: string | null;
  preparationSeconds?: number | null;
  maxResponseSeconds?: number | null;
  preparationDeadline?: string | null;
  responseDeadline?: string | null;
  remainingSeconds?: number | null;
  recordingId?: string | null;
  completedAt?: string | null;
  transitionToken?: string | null;
  mediaUrl?: string | null;
}

export interface SpeakingTurnSummaryDto {
  turnKey: string;
  turnSequence: number;
  partCode: string;
  recordingId?: string | null;
  state: string;
}

export interface SpeakingRuntimeStateDto {
  attemptId: string;
  sectionId: string;
  currentTurnCursor: number;
  turnRevision: number;
  currentTurn?: SpeakingTurnDto | null;
  totalTurns: number;
  lockedTurnCount: number;
  completedTurns: SpeakingTurnSummaryDto[];
  sectionCompleted: boolean;
  activePartCode?: string | null;
  transitionToken?: string | null;
}

export interface StartPreparationCommand {
  clientMutationId?: string;
  expectedTurnRevision: number;
  turnKey?: string;
  transitionToken?: string;
}

export interface StartRecordingCommand {
  clientMutationId?: string;
  expectedTurnRevision: number;
  turnKey?: string;
  transitionToken?: string;
}

export interface StopRecordingCommand {
  clientMutationId?: string;
  expectedTurnRevision: number;
  turnKey?: string;
  transitionToken?: string;
}

export interface CompleteTurnCommand {
  clientMutationId?: string;
  expectedTurnRevision: number;
  recordingId?: string;
  durationMs?: number;
  turnKey?: string;
  transitionToken?: string;
}

export interface ItemReviewDto {
  placementId: string;
  itemId: string;
  prompt: string;
  interactionType: string;
  userAnswer: any;
  acceptedAnswers: any;
  explanation?: string;
  isCorrect: boolean;
  creditAwarded: number;
  maxCredit: number;
  skill?: ScoreMetric | string;
  isSubjective?: boolean;
}

export interface SpeakingTurnReviewDto {
  turnOrder: number;
  turnKey?: string;
  partKey: string;
  promptSourceId: string;
  promptText: string;
  recordingId?: string;
  playbackUrl?: string;
  durationSeconds?: number;
  transcriptText?: string;
  transcriptStatus?: string;
  acousticEvidence?: Record<string, any>;
  missingReason?: string;
  turnFeedback?: {
    strengths?: string[];
    issues?: string[];
    suggestion?: string;
  };
}

export interface SpeakingCriterionReviewDto {
  rubricCriterion: string;
  estimatedBand?: number | null;
  bandDescriptor?: string;
  evidenceHighlights?: string[];
  confidenceMeta?: Record<string, any>;
  status?: string;
}

export interface SpeakingAttemptReviewDto {
  attemptId: string;
  family: ExamFamily;
  status: ResultStatus;
  overallSpeakingBand?: number | null;
  turns: SpeakingTurnReviewDto[];
  criteria: SpeakingCriterionReviewDto[];
  examinerFeedback?: string;
  abstentionReason?: string;
  sessionSummary?: {
    overallFeedback?: string;
    strongestArea?: string;
    mainWeakness?: string;
    nextRecommendedFocus?: string;
    strengths?: string[];
    weaknesses?: string[];
    nextSteps?: string[];
  };
}

export interface AttemptReviewDto {
  attemptId: string;
  family: ExamFamily;
  items: ItemReviewDto[];
  reviewEmbargoEnded: boolean;
  speakingReview?: SpeakingAttemptReviewDto;
}

export interface MetricSummaryDto {
  latest?: number;
  best?: number;
  latestDate?: string;
  bestDate?: string;
  trendSlope?: number;
  trendDirection: string;
}

export interface IeltsObservationDto {
  attemptId: string;
  artifactId: string;
  date: string;
  variant: string;
  scope: string;
  overall?: number;
  listening?: number;
  reading?: number;
  writing?: number;
  speaking?: number;
  exposureStatus: string;
  isOSR: boolean;
}

export interface ToeicObservationDto {
  attemptId: string;
  artifactId: string;
  date: string;
  variant: string;
  lrTotal?: number;
  listening?: number;
  reading?: number;
  speaking?: number;
  writing?: number;
  exposureStatus: string;
}

export interface RecommendationDto {
  id: string;
  evidenceId: string;
  diagnosticCode: string;
  trainingModule: 'READING' | 'LISTENING' | 'WRITING' | 'SPEAKING';
  targetId: string;
  reason: string;
  handoffUrl: string;
  status: string;
  createdAt: string;
}

export interface IeltsProfileDto {
  overall: MetricSummaryDto;
  listening: MetricSummaryDto;
  reading: MetricSummaryDto;
  writing: MetricSummaryDto;
  speaking: MetricSummaryDto;
  observations: IeltsObservationDto[];
  comparabilityCohort: string;
  confidenceState: string;
  recommendations: RecommendationDto[];
}

export interface ToeicProfileDto {
  lrTotal: MetricSummaryDto;
  listening: MetricSummaryDto;
  reading: MetricSummaryDto;
  speaking: MetricSummaryDto;
  writing: MetricSummaryDto;
  observations: ToeicObservationDto[];
  comparabilityCohort: string;
  confidenceState: string;
  recommendations: RecommendationDto[];
}

export interface AttemptHistoryItemDto {
  attemptId: string;
  formId: string;
  formTitle: string;
  family: ExamFamily;
  variant: string;
  scope: string;
  mode: ExamAttemptMode;
  status: ExamAttemptStatus;
  score?: number;
  startedAt?: string;
  completedAt?: string;
  /** Exams Phase 7: server-pinned practice scope code of a part practice (e.g. TOEIC_PART_5); null otherwise. */
  practiceScopeCode?: string | null;
}

export interface ActiveSimulationAttemptSummary {
  attemptId: string;
  formId: string;
  family: ExamFamily;
  variant: string;
  formTitle: string;
  mode: ExamAttemptMode;
  status: ExamAttemptStatus;
  currentSkill: string;
  startedAt: string;
  resumable: boolean;
}
