/**
 * Canonical Writing Module Type Definitions (P0)
 * 
 * Defines all shared contracts for:
 * - Route navigation state (For You, Sentence Lab, Writing Coach, Portfolio)
 * - Sessions, stages, and optimistic working copies
 * - Submissions, assessments, and feedback issues
 * - Sentence Check and 7-mode Practice Engine
 * - Longitudinal Error Memory and Skill projections
 */

export type WritingView = 'translation' | 'for-you' | 'sentence-lab' | 'typing' | 'coach' | 'portfolio';

export type SentenceLabSubView = 'check' | 'mistakes';

export type WritingSessionStage = 
  | 'UNDERSTANDING'
  | 'PLANNING'
  | 'DRAFTING'
  | 'ANALYZING'
  | 'FEEDBACK_READY'
  | 'REVISING'
  | 'COMPLETED';

export type AssessmentStatus = 
  | 'QUEUED'
  | 'RUNNING'
  | 'READY'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL'
  | 'CANCELLED';

export type SubmissionKind = 
  | 'COACH_DRAFT'
  | 'SENTENCE_CHECK'
  | 'PRACTICE_ATTEMPT'
  | 'PLAN_INPUT';

export type AssessmentOperation = 
  | 'SENTENCE_CHECK'
  | 'DOCUMENT_ANALYSIS'
  | 'PLAN_ORGANIZE'
  | 'PRACTICE_EVALUATION';

export type PracticeMode = 
  | 'COMBINE'
  | 'REPAIR'
  | 'EXPAND'
  | 'REWRITE_NATURALLY'
  | 'PARAPHRASE'
  | 'CHANGE_REGISTER'
  | 'IMPROVE_COHESION';

export type IssueKind = 'ERROR' | 'IMPROVEMENT' | 'UNCERTAIN';

export type IssueSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'SUGGESTION';

export type IssueDisposition = 'ACTIVE' | 'DISPUTED' | 'DISMISSED' | 'RESOLVED' | 'SUPERSEDED';

export type DimensionStatus = 'CORRECT' | 'NEEDS_WORK' | 'UNCERTAIN' | 'UNAVAILABLE';

export interface WritingRouteState {
  view: WritingView;
  mode?: string;
  subView?: SentenceLabSubView;
  patternCode?: string;
  sessionId?: string;
  taskId?: string;
  draftId?: string;
  assessmentId?: string;
  practiceId?: string;
}

export interface WritingCapabilities {
  enabled: boolean;
  mutationsEnabled: boolean;
  assessmentsEnabled: boolean;
  workerEnabled: boolean;
  maxSentenceChars: number;
  maxDraftWords: number;
  maxDraftChars: number;
}

export interface WritingProfile {
  userId: number;
  displayName?: string;
  cefrLevel: string; // e.g. 'B1', 'B2', 'C1'
  focusAreas?: string[];
  preferredRegister?: string;
  goals?: string[];
  interests?: string[];
  explanationLocale: string; // 'en' | 'vi'
  provenance: string;
  version: number;
  updatedAt: string;
}

export interface WritingTask {
  targetWords?: string[];
  id: string;
  version: number;
  category: 'Everyday' | 'Academic' | 'Work' | 'Creative';
  title: string;
  prompt: string;
  guidance: string;
  audience: string;
  targetRegister: string;
  targetWordCountMin: number;
  targetWordCountMax: number;
  requirements: string[];
  constraints?: string[];
  cefrLevel?: string;
  targetCefr?: string;
  level?: string;
  family?: string;
  taskSubtype?: string;
  visualData?: any;
}

export interface WritingSession {
  id: string;
  userId: number;
  taskId: string;
  taskSnapshot: WritingTask;
  stage: WritingSessionStage;
  workingPlan: string;
  workingText: string;
  currentRevision: number;
  draftCount?: number;
  activeAssessmentId?: string;
  finalDraftId?: string;
  isFavorite: boolean;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WritingDraft {
  id: string;
  sessionId: string;
  ordinal: number;
  content: string;
  wordCount: number;
  characterCount: number;
  assessmentId?: string;
  submittedAt: string;
}

export interface FeedbackIssue {
  id: string;
  assessmentId: string;
  kind: IssueKind;
  severity: IssueSeverity;
  category: string;
  patternCode?: string;
  title: string;
  explanation: string;
  description?: string;
  sourceQuote: string;
  startOffset: number;
  endOffset: number;
  replacement?: string;
  disposition: IssueDisposition;
  priorityRank: number; // 1 = highest priority (typically 1-4 displayed first)
  teachingRule?: string;
  suggestedPracticeMode?: PracticeMode;
}

export interface DimensionVerdict {
  dimension: string; // e.g., 'Grammar', 'Naturalness', 'Vocabulary', 'Cohesion', 'Task'
  status: DimensionStatus;
  summary: string;
  score?: number; // 0-100 nullable (never manufactured)
}

export interface WritingAssessment {
  id: string;
  submissionId: string;
  operation: AssessmentOperation;
  status: AssessmentStatus;
  overallScore?: number; // nullable
  grammaticallyCorrect: boolean | null;
  analysisStatus?: 'COMPLETED' | 'ANALYSIS_UNAVAILABLE' | 'INCONCLUSIVE';
  coverageSummary: string;
  dimensionVerdicts: DimensionVerdict[];
  issues: FeedbackIssue[];
  strengths: string[];
  prioritizedIssueIds: string[];
  retryCount: number;
  retryable: boolean;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface SentenceCheckRequest {
  text: string;
  targetRegister?: string;
  contextNote?: string;
  clientMutationId: string;
}

export interface SentenceCheckResult {
  submissionId: string;
  assessmentId: string;
  originalText: string;
  status: AssessmentStatus;
  grammaticallyCorrect: boolean | null;
  analysisStatus?: 'COMPLETED' | 'ANALYSIS_UNAVAILABLE' | 'INCONCLUSIVE';
  dimensionVerdicts: DimensionVerdict[];
  issues: FeedbackIssue[];
  suggestedImprovement?: string;
  explanation?: string;
  grammarFeedback?: any;
  correctedSentence?: string;
}

export interface PracticeExerciseSnapshot {
  id: string;
  mode: PracticeMode;
  prompt: string;
  originalContext?: string;
  targetPatternCode?: string;
  requiredConstraints: string[];
  hints: string[]; // hints available to the server
  sampleSolutionLength: number;
}

export interface WritingPracticeEpisode {
  id: string;
  userId: number;
  mode: PracticeMode;
  exerciseSnapshot: PracticeExerciseSnapshot;
  targetPatternCode?: string;
  currentAttemptOrdinal: number;
  maxAttempts: number;
  revealedHints: string[]; // only revealed hints sent to client
  isCompleted: boolean;
  isSuccess: boolean;
  modelAnswerRevealed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeAttemptResult {
  attemptId?: string;
  practiceId?: string;
  attemptOrdinal?: number;
  isSuccess: boolean;
  learnerAnswer?: string;
  feedback: string;
  revealedHint?: string;
  unlockedHint?: string;
  canRetry?: boolean;
  isCompleted?: boolean;
  masteryUpdated?: boolean;
  newEstimatedMastery?: number;
  modelAnswerRevealed?: boolean;
  modelAnswer?: string; // only present if explicitly revealed after permitted ladder
}

export interface ErrorOccurrence {
  id: string;
  issueId?: string;
  assessmentId?: string;
  submissionId?: string;
  patternCode: string;
  title?: string;
  sourceFeature: string; // 'Sentence Lab' | 'Writing Coach'
  originalText?: string;
  wrongSpan?: string;
  startOffset?: number;
  endOffset?: number;
  replacement?: string;
  correctedSentence?: string;
  explanation?: string;
  teachingRule?: string;
  category?: string;
  severity?: string;
  recordedAt: string;
}

export interface LearnerErrorMemory {
  id: string;
  userId: number;
  patternCode: string;
  category: string;
  title: string;
  occurrenceCount: number;
  contextCount: number;
  lastSeenAt: string;
  estimatedMastery: number; // 0-100 heuristic
  hasSufficientEvidence: boolean;
  dueForPractice: boolean;
  nextPracticeDueAt?: string;
  isMuted: boolean;
  teachingRule?: string;
  defaultPracticeMode?: string;
  occurrences?: ErrorOccurrence[];
}

export interface WritingSkillMastery {
  skillCode: string;
  category: string;
  name: string;
  evidenceCount: number;
  masteryPercentage?: number;
  trend: 'IMPROVING' | 'STABLE' | 'NEEDS_ATTENTION' | 'INSUFFICIENT_DATA';
  lastPracticedAt?: string;
}

export interface DailyWordCount {
  dayCode: string;
  dayName: string;
  dayOfWeek: number;
  wordCount: number;
  isToday: boolean;
  isPast: boolean;
}

export interface ForYouDashboard {
  continueSession?: WritingSession;
  recommendedDuePractice?: {
    patternCode: string;
    patternTitle: string;
    suggestedMode: PracticeMode;
    dueReason: string;
    isCurriculum?: boolean;
  };
  recommendedTask?: WritingTask;
  activeFocusPatterns: LearnerErrorMemory[];
  weeklyEvidenceCount: number;
  weeklyWordsWritten?: number;
  weeklyTargetWords?: number;
  daysCompletedThisWeek?: number;
  completedPracticesToday?: number;
  targetPracticesDaily?: number;
  dailyWordCounts?: DailyWordCount[];
  isCurriculumRecommendation?: boolean;
  streakDays?: number;
}

export interface PortfolioSummaryItem {
  sessionId: string;
  taskTitle: string;
  category: string;
  stage: WritingSessionStage;
  draftCount: number;
  isFavorite: boolean;
  completedAt?: string;
  updatedAt: string;
  wordCount: number;
  score?: number;
  previewText?: string;
  firstDraftPreview?: string;
  finalDraftPreview?: string;
  firstDraftWordCount?: number;
  finalDraftWordCount?: number;
  firstDraftScore?: number;
  finalDraftScore?: number;
  firstDraftIssueCount?: number;
  finalDraftIssueCount?: number;
}

export interface DraftDiffChunk {
  type: 'EQUAL' | 'INSERT' | 'DELETE';
  text: string;
}

export interface DraftComparisonResult {
  draft1Id: string;
  draft2Id: string;
  draft1Ordinal: number;
  draft2Ordinal: number;
  diffChunks: DraftDiffChunk[];
  resolvedIssueCount: number;
  unresolvedIssueCount: number;
  wordCountChange: number;
}

export interface PlanSection {
  section_title: string;
  points: string[];
}

export interface PlanOrganizationResult {
  organized_sections: PlanSection[];
  suggestions: string[];
}

export interface DocumentAssessmentResult {
  assessmentId: string;
  submissionId: string;
  draftOrdinal: number;
  status: AssessmentStatus;
  overallScore?: number;
  dimensionVerdicts: DimensionVerdict[];
  prioritizedIssues: FeedbackIssue[];
  allIssues: FeedbackIssue[];
  strengths: string[];
  summary: string;
  coverageSummary?: string;
  issues?: FeedbackIssue[];
  createdAt: string;
}

// Phase 8: Cross-module Source Types
export type WritingSourceType = 'VOCABULARY' | 'READING' | 'LISTENING' | 'SPEAKING';

export interface WritingSourceContext {
  sourceType: WritingSourceType;
  sourceId: string;
  sourceTitle: string;
  sourceCategory?: string;
  sourceCefrLevel?: string;
  sourceExcerpt?: string;
  targetWords?: string[];
  suggestedTaskTitle: string;
  suggestedTaskPrompt: string;
  suggestedTaskGuidance: string;
  suggestedAudience: string;
  suggestedTargetRegister: string;
  suggestedWordCountMin: number;
  suggestedWordCountMax: number;
  requirements: string[];
  elicitedPatterns: string[];
}

export interface CreateSessionFromSourceRequest {
  sourceType: WritingSourceType;
  sourceId: string;
}

// Phase 9: Intelligence and Analytics Types
export interface MasteredPattern {
  patternCode: string;
  title: string;
  category: string;
  occurrenceCount: number;
  contextCount: number;
  masteryPercentage?: number;
  status: 'RESOLVED' | 'IN_PROGRESS' | 'NEEDS_ATTENTION';
}

export interface SkillDimensionScore {
  dimension: string;
  name: string;
  score?: number | null;
  evidenceCount: number;
  trend: 'IMPROVING' | 'STEADY' | 'NEEDS_WORK' | 'INSUFFICIENT_DATA';
  guidance: string;
}

export interface WeeklyWritingReport {
  periodStart: string;
  periodEnd: string;
  totalWordsWritten: number;
  completedSessions: number;
  draftsComposed: number;
  practicesCompleted: number;
  errorResolutionVelocity?: number | null;
  topMasteredPatterns: MasteredPattern[];
  skillDimensionScores: SkillDimensionScore[];
  constructiveSummary: string;
}

export interface WritingTimelinePoint {
  sessionId: string;
  taskTitle: string;
  completedAt: string;
  wordCount: number;
  draft1Score?: number;
  finalScore?: number;
  revisionGain?: number;
}

export interface ErrorDensityPoint {
  date: string;
  errorsPerHundredWords: number;
  totalWords: number;
  totalErrors: number;
}

export interface LongitudinalProgress {
  totalWordsCumulative: number;
  completedSessionsCount: number;
  totalPracticesCompleted: number;
  averageScore?: number;
  timeline: WritingTimelinePoint[];
  errorDensityHistory: ErrorDensityPoint[];
}

export interface AdaptiveTaskRequest {
  cefrLevel?: string;
  category?: string;
  register?: string;
  focusPatternCodes?: string[];
}

export interface AdaptiveTaskResponse {
  title: string;
  prompt: string;
  guidance: string;
  audience: string;
  target_register: string;
  target_word_count_min: number;
  target_word_count_max: number;
  requirements: string[];
  elicited_patterns: string[];
}

export interface SocraticPlanRequest {
  taskPrompt: string;
  currentPlan?: string;
  learnerQuestion?: string;
}

export interface SocraticSuggestionItem {
  id: string;
  operation: 'ADD' | 'MODIFY' | 'COUNTERARGUMENT' | 'EVIDENCE' | 'STRUCTURAL' | 'EXPAND' | 'REMOVE' | 'REORDER';
  section: 'thesis' | 'counterargument' | 'main_argument' | 'synthesis' | 'evidence' | 'conclusion';
  content: string;
  reasoning?: string;
}

export interface SocraticPlanResponse {
  probing_questions: string[];
  structural_prompts: string[];
  encouragement: string;
  suggested_items?: SocraticSuggestionItem[];
}


export interface ModelAnswerComparisonRequest {
  taskId?: string;
  sessionId?: string;
  taskPrompt: string;
  learnerDraft: string;
  targetRegister?: string;
  learnerLevel?: string;
}

export interface ModelAnswerComparisonResponse {
  exemplar_model_answer: string;
  calibrated_level?: string;
  structural_observations: string[];
  lexical_alternatives: string[];
  coaching_summary: string;
}

export interface DraftSummary {
  id: string;
  ordinal: number;
  content: string;
  wordCount: number;
  createdAt: string;
  overallScore?: number;
  assessmentId?: string;
}

export interface WritingSessionDetail {
  session: WritingSession;
  task?: any;
  drafts: DraftSummary[];
  finalAssessment?: DocumentAssessmentResult;
}

// Translation Practice Contracts
export interface TranslationTopic {
  code: string;
  displayName: string;
  count: number;
}

export interface TranslationDifficulty {
  code: string;
  displayName: string;
  count: number;
}

export interface TranslationCollection {
  exerciseId?: string;
  mode: string;
  topicCode: string;
  topicDisplayName: string;
  difficultyBucket: string;
  difficultyDisplayName: string;
  exerciseCount: number;
  sentenceCount?: number;
}

export interface TranslationSessionSummary {
  sessionId: string;
  exerciseId: string;
  mode: string;
  topicCode: string;
  difficultyBucket: string;
  currentOrdinal: number;
  totalUnits: number;
  sessionRevision: number;
  updatedAt: string;
}

export interface TranslationCatalog {
  availableModes: string[];
  topics: TranslationTopic[];
  difficulties: TranslationDifficulty[];
  collections: TranslationCollection[];
  activeSession?: TranslationSessionSummary | null;
  paragraphModeEnabled: boolean;
}

export interface TranslationStartRequest {
  mode?: string;
  topicCode?: string;
  difficultyBucket?: string;
  exerciseId?: string;
  clientMutationId: string;
}

export interface TranslationToken {
  index: number;
  firstChar: string;
  length: number;
  leadingPunct: string;
  trailingPunct: string;
  revealed: boolean;
  word?: string | null;
  punctuationOnly?: boolean;
}

export interface TranslationUnit {
  unitId: string;
  ordinal: number;
  sourceVi: string;
  hintLevel: 'HIDDEN' | 'CUE' | 'CHUNK' | 'REFERENCE';
  referenceRevealed: boolean;
  draftText: string;
  terminalStatus: 'UNSEEN' | 'DRAFTING' | 'ACCEPTED' | 'NEEDS_REVISION' | 'REVEALED' | 'SKIPPED' | 'UNCERTAIN';
  visibleHints: Array<{
    text?: string;
    kind: string;
    cue?: string;
    order: number;
    source: string;
  }>;
  maskedTokens?: TranslationToken[];
  referenceEn?: string | null;
}

export interface TranslationSession {
  sessionId: string;
  exerciseId: string;
  mode: string;
  topicCode: string;
  difficultyBucket: string;
  cefrBand?: string;
  contentVersion: number;
  currentOrdinal: number;
  totalUnits: number;
  sessionRevision: number;
  status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED' | 'EXPIRED';
  currentUnit: TranslationUnit;
  units: TranslationUnit[];
}

export interface TranslationDraftRequest {
  clientMutationId: string;
  expectedRevision: number;
  draftText: string;
  unitOrdinal?: number;
}

export interface TranslationDraftResponse {
  sessionId: string;
  unitOrdinal: number;
  draftText: string;
  sessionRevision: number;
  savedAt: string;
}

export interface TranslationHintRequest {
  clientMutationId: string;
  expectedRevision: number;
  action: 'NEXT_HINT' | 'REVEAL_TOKEN' | 'REVEAL_ALL' | 'REVEAL_REFERENCE' | 'HIDE_ALL' | 'HIDE_REFERENCE';
  tokenIndex?: number;
}

export interface TranslationHintResponse {
  sessionId: string;
  unitOrdinal: number;
  hintLevel: string;
  referenceRevealed: boolean;
  visibleHints: Array<{
    text?: string;
    kind: string;
    cue?: string;
    order: number;
    source: string;
  }>;
  maskedTokens?: TranslationToken[];
  referenceEn?: string | null;
  sessionRevision: number;
}

export interface TranslationIssue {
  offsetStart: number;
  offsetEnd: number;
  flaggedText: string;
  category: string;
  message: string;
  suggestion?: string;
}

export interface TranslationFeedback {
  meaningVerdict: 'ACCURATE' | 'PARTIAL' | 'INACCURATE' | 'UNCERTAIN';
  grammarVerdict: 'ACCURATE' | 'MINOR_ISSUES' | 'INCORRECT' | 'UNCERTAIN';
  naturalnessVerdict: 'NATURAL' | 'ACCEPTABLE' | 'AWKWARD' | 'UNCERTAIN';
  overallStatus: 'ACCEPTED' | 'NEEDS_REVISION' | 'INCORRECT' | 'UNCERTAIN';
  headlineSummary: string;
  naturalSuggestion?: string;
  issues: TranslationIssue[];
}

export interface TranslationAttemptRequest {
  clientMutationId: string;
  expectedRevision: number;
  answerText: string;
  action: 'SUBMIT' | 'REVISE' | 'CONTINUE' | 'SKIP';
}

export interface TranslationAttemptResponse {
  attemptId: string;
  sessionId: string;
  unitOrdinal: number;
  attemptOrdinal: number;
  action: string;
  evaluationStatus: 'ACCEPTED' | 'NEEDS_REVISION' | 'INCORRECT' | 'UNCERTAIN' | 'SKIPPED' | 'CONTINUED' | 'UNAVAILABLE';
  accepted?: boolean | null;
  sessionRevision: number;
  feedback?: TranslationFeedback | null;
  referenceEn?: string | null;
  nextOrdinal?: number | null;
  sessionCompleted: boolean;
}



export type TypingWritingCategory = 'sentence' | 'paragraph' | 'draft';
export interface TypingWritingSource { id: string; title: string; savedAt: string; text: string | null }
export interface TypingWritingSourcePage { content: TypingWritingSource[]; hasNext: boolean }
