export interface ParagraphPassageSummary {
  id: string;
  externalPassageId: string;
  passageOrdinal: number;
  sourceVi: string;
  referenceEn?: string;
  genre: string;
  topic: string;
  difficultyStatus: string;
  contentVersion: number;
  attributionText: string;
  licenseCode: string;
  sourceUrl?: string;
  targetUrl?: string;
}

export interface ParagraphGenreCount {
  genre: string;
  count: number;
}

export interface ParagraphTopicCount {
  difficultyLabel?: string;
  topic: string;
  displayName?: string;
  count: number;
}

export interface ParagraphDifficultyDto {
  status: string;
  label: string;
  count: number;
  calibrated: boolean;
}

export interface ParagraphDifficultyCount {
  difficultyStatus: string;
  count: number;
}

export interface ParagraphSessionSummary {
  sessionId: string;
  status: string;
  currentIndex: number;
  totalItems: number;
  filterGenre?: string;
  filterTopic?: string;
  updatedAt: string;
}

export interface ParagraphCatalog {
  totalEligiblePassages: number;
  totalPassages?: number;
  availableGenres?: ParagraphGenreCount[];
  genres?: ParagraphGenreCount[];
  topics: ParagraphTopicCount[];
  difficulty?: ParagraphDifficultyDto;
  difficulties?: ParagraphDifficultyCount[];
  activeSession?: ParagraphSessionSummary | null;
  enabled?: boolean;
  paragraphModeEnabled?: boolean;
}

export interface ParagraphSessionItem {
  itemId: string;
  passageId: string;
  ordinal: number;
  contentVersion: number;
  sourceVi: string;
  referenceEn?: string;
  sourceTitle?: string;
  targetTitle?: string;
  genre: string;
  topic: string;
  difficultyStatus: string;
  attributionText: string;
  licenseCode: string;
  sourceUrl?: string;
  targetUrl?: string;
  draftText: string;
  draftRevision: number;
  progressState: 'NOT_STARTED' | 'IN_PROGRESS' | 'NEEDS_REVISION' | 'ACCEPTED' | 'SKIPPED';
}

export interface ParagraphSession {
  sessionId: string;
  status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
  currentIndex: number;
  sessionRevision: number;
  totalItems: number;
  clientMutationId: string;
  filterGenre?: string;
  filterTopic?: string;
  items: ParagraphSessionItem[];
  createdAt: string;
  updatedAt: string;
}

export interface ParagraphIssue {
  dimension: 'MEANING' | 'GRAMMAR' | 'NATURALNESS' | 'VOCABULARY' | 'COHESION';
  issueType: 'ERROR' | 'IMPROVEMENT' | 'STYLE';
  severity: 'MAJOR' | 'MINOR' | 'SUGGESTION';
  learnerSpan?: string;
  spanStart?: number | null;
  spanEnd?: number | null;
  message: string;
  suggestion?: string;
}

export interface ParagraphFeedback {
  accepted?: boolean | null;
  evaluationStatus: 'ACCEPTED' | 'NEEDS_REVISION' | 'UNCERTAIN' | 'PENDING' | 'CONTINUED' | 'SKIPPED';
  overallSummary: string;
  meaningVerdict?: string;
  meaningScore?: number;
  grammarVerdict?: string;
  grammarScore?: number;
  naturalnessVerdict?: string;
  naturalnessScore?: number;
  vocabularyVerdict?: string;
  vocabularyScore?: number;
  cohesionVerdict?: string;
  cohesionScore?: number;
  issues: ParagraphIssue[];
  suggestedCorrection?: string;
  naturalAlternative?: string;
  referenceEn?: string;
  modelId?: string;
  generationCount?: number;
  cached?: boolean;
  latencyMs?: number;
}

export interface ParagraphAttemptResponse {
  attemptId: string;
  sessionId: string;
  sessionItemId: string;
  passageId: string;
  ordinal: number;
  attemptOrdinal: number;
  action: 'SUBMIT' | 'REVISE' | 'CONTINUE' | 'SKIP';
  clientMutationId: string;
  submittedText: string;
  evaluationStatus: 'ACCEPTED' | 'NEEDS_REVISION' | 'UNCERTAIN' | 'PENDING' | 'CONTINUED' | 'SKIPPED';
  accepted?: boolean | null;
  feedback?: ParagraphFeedback;
  sessionProgressState: string;
  itemProgressState: string;
  createdAt: string;
}

export interface ParagraphAssistanceSegment {
  segmentIndex: number;
  sourceVi: string;
  tokenCount: number;
  revealed: boolean;
  text?: string;
  tokens: string[];
}

export interface ParagraphAssistanceResponse {
  sessionId: string;
  ordinal: number;
  passageId: string;
  fullReferenceRevealed: boolean;
  fullReferenceEn?: string;
  segments: ParagraphAssistanceSegment[];
}

export interface ParagraphAssistanceRequest {
  ordinal: number;
  action: 'GET_SEGMENTS' | 'REVEAL_SEGMENT' | 'REVEAL_WORD' | 'REVEAL_ALL' | 'HIDE_ALL';
  segmentIndex?: number;
  wordIndex?: number;
}

export interface ParagraphStartRequest {
  clientMutationId: string;
  genre?: string;
  topic?: string;
  limit?: number;
}

export interface ParagraphDraftRequest {
  ordinal: number;
  draftText: string;
  expectedRevision: number;
  clientMutationId: string;
}

export interface ParagraphDraftResponse {
  sessionId: string;
  ordinal: number;
  draftRevision: number;
  progressState: string;
  updatedAt: string;
}
