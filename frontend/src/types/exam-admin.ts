export type JsonObject = Record<string, unknown>;

export interface CorpusPracticeReleaseReceipt {
  packageId: string;
  operation: string;
  planId: string;
  packageIndex: number;
  packageCount: number;
  formId?: string;
  scopeCodes?: string[];
}

export type ExamContentPackage = JsonObject & {
  manifest?: JsonObject;
  form?: JsonObject & { id?: string; contentHash?: string };
};

export interface ValidationError {
  path: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  computedContentHash?: string;
  errors: ValidationError[];
}

export interface ImportResult {
  packageId: string;
  packageVersion: number;
  contentHash: string;
  formId: string;
  status: 'IMPORTED' | 'ALREADY_IMPORTED' | 'REJECTED';
  idempotentReplay: boolean;
  errors: ValidationError[];
}

export type MeasurementEvent = {
  id: string;
  attemptId: string;
  submissionId: string;
  responseId: string;
  userId: number;
  formId: string;
  itemId: string;
  family: 'IELTS' | 'TOEIC';
  variant: string;
  scope: string;
  skill: 'LISTENING' | 'READING' | 'WRITING' | 'SPEAKING';
  taskFamily?: string;
  attemptMode: 'EXAM_SIMULATION' | 'PRACTICE';
  formVersion: number;
  itemVersion: number;
  formContentHash: string;
  itemContentHash: string;
  manifestHash: string;
  submissionHash: string;
  responseRevision: number;
  exposureStatus: 'FAMILIAR' | 'UNEXPOSED' | 'UNKNOWN';
  consentStatus: 'GRANTED' | 'WITHDRAWN' | 'UNKNOWN';
  sourceType: 'RUNTIME_EXPORT' | 'OPERATOR_LINKED_IMPORT' | 'SYNTHETIC_ENGINEERING';
  evidenceClass: 'RUNTIME_OPERATIONAL' | 'ENGINEERING_SYNTHETIC';
  outcomeStatus: 'CORRECT' | 'INCORRECT' | 'OMITTED' | 'ABSTAINED' | 'UNKNOWN';
  outcomeSource: 'ANSWER_SPEC' | 'RUNTIME_SCORE_ARTIFACT' | 'HUMAN_RATING' | 'UNAVAILABLE';
  scoreAwarded?: number;
  maxScore?: number;
  responseTimeMs?: number;
  selectedOption?: string;
  responsePayload?: JsonObject;
  eventHash: string;
};

export interface ItemStatistic {
  itemId: string;
  sampleSize: number;
  validCount: number;
  pValue?: number;
  itemRestPointBiserial?: number;
  omissionRate?: number;
  medianResponseTimeMs?: number;
  distractorRates: Record<string, number>;
  calculationStatus: 'CALCULATED' | 'INSUFFICIENT' | 'UNDEFINED' | string;
  flags: string[];
}

export interface RunSummary {
  id: string;
  family: 'IELTS' | 'TOEIC';
  skill?: 'LISTENING' | 'READING' | 'WRITING' | 'SPEAKING';
  formId?: string;
  status: 'RAW' | 'CLEAN' | 'FINAL' | 'INSUFFICIENT' | 'REJECTED' | string;
  rawCount: number;
  cleanCount: number;
  excludedCount: number;
  inputHash: string;
  consentPolicyVersion: string;
  createdAt: string;
  finalizedAt?: string;
}

export interface AnalysisReport {
  runId: string;
  itemStatistics: ItemStatistic[];
  reliability: {
    respondents: number;
    items: number;
    kr20?: number;
    status: string;
    reason?: string;
  };
  rawCount: number;
  cleanCount: number;
  excludedCount: number;
  status: string;
  hygieneFlags: string[];
}

export interface RunView {
  run: RunSummary;
  items: ItemStatistic[];
}

export interface GoldDataset {
  id: string;
  logicalCode: string;
  version: number;
  family: 'IELTS' | 'TOEIC';
  skill: 'LISTENING' | 'READING' | 'WRITING' | 'SPEAKING';
  rubricVersionId?: string;
  consentPolicyVersion: string;
  provenanceStatement: string;
  status: 'DRAFT' | 'LOCKED' | 'RELEASED' | 'REVOKED' | string;
  lockedBy?: number;
  lockedAt?: string;
}

export interface RaterAssignment {
  id: string;
  datasetId: string;
  responseId: string;
  attemptId: string;
  family: 'IELTS' | 'TOEIC';
  skill: 'LISTENING' | 'READING' | 'WRITING' | 'SPEAKING';
  raterUserId: number;
  assignedBy: number;
  blindToOtherRatings: boolean;
  status: 'ASSIGNED' | 'SUBMITTED' | 'ADJUDICATED' | 'CANCELLED' | string;
  createdAt: string;
}

export interface RaterAssignmentView {
  assignment: RaterAssignment;
  itemId: string;
  prompt: string;
  interactionType: string;
  optionDefinitions: JsonObject;
  skill: string;
  rubricVersionId?: string;
  responsePayload: JsonObject;
  textResponse?: string;
  recordingId?: string;
  stimulusAssets: Array<{
    stimulusId: string;
    title?: string;
    bodyPayload?: JsonObject;
    assetId?: string;
    objectKey?: string;
    mimeType?: string;
    durationMs?: number;
    role?: string;
  }>;
}

export interface RaterRatingSummary {
  id: string;
  assignmentId: string;
  criterionScores: JsonObject;
  overallScore?: number;
  confidence?: number;
  ratingHash: string;
  submittedAt: string;
}

export interface EvaluationMetrics {
  sampleSize: number;
  scoredCount: number;
  abstainedCount: number;
  mae?: number | string;
  rmse?: number | string;
  exactRate?: number | string;
  adjacentRate?: number | string;
  kappa?: number | string;
  correlation?: number | string;
  abstentionRate: number;
  status: string;
  reason?: string;
}

export interface EvaluationReport {
  overall: EvaluationMetrics;
  byCriterion: Record<string, EvaluationMetrics>;
  bySubgroup: Record<string, EvaluationMetrics>;
  hygieneFlags: string[];
}

export interface CalibrationPackage {
  id: string;
  logicalCode: string;
  version: number;
  formId: string;
  scoringSchemeId: string;
  measurementRunId: string;
  method: string;
  maturityStage: string;
  mappingTable: JsonObject;
  uncertaintyModel: JsonObject;
  evidenceHash: string;
  validationReport: string;
  approvalState: string;
  approvedBy?: number;
  approvedAt?: string;
}

export interface AdminFormSummary {
  id: string;
  logicalKey: string;
  version: number;
  title: string;
  family: string;
  variant: string;
  scope: string;
  lifecycleState: string;
  contentHash: string;
  authorId?: number;
  createdAt: string;
  packageId?: string;
  packageVersion?: number;
  packageStatus?: string;
}

export interface AdminSourceSummary {
  id: string;
  code: string;
  name: string;
  owner?: string;
  publisher?: string;
  sourceType: string;
  retiredAt?: string;
  createdAt: string;
}

// ─── Exams Phase 8D: operations center (ADMIN only; derived canonical truth, no stored admin flags) ─────────────────

export interface OpsLedgerSummary {
  present: boolean;
  validDecisions: number;
  invalidRecords: number;
  recordedViaAdminCenter: number;
  pendingApplication: number;
}

export interface OpsPackageRow {
  testId: string;
  packageId: string;
  packageVersion: number;
  sourceKey: string;
  family?: string;
  collection?: string;
  book?: string;
  test?: string;
  semanticFingerprint: string;
  manifestContentHash: string;
  phase2Status: string;
  gate: Record<string, boolean>;
  importReady: boolean;
  readyExceptHumanQa: boolean;
  disposition: string;
  dispositionReportStale: boolean;
  openQaByPriority: Record<string, number>;
  mediaAssets: number;
  mediaReady: number;
  imagesAwaitingHumanApproval: number;
  practiceScopes: Record<string, number>;
  projectAuthorization: string;
  publisherLicence: string;
  provenanceComplete: boolean;
  localImportOperation: string;
  productionImportOperation: string;
}

export interface OpsOverview {
  generatedAt: string;
  stagingConfigured: boolean;
  stagingNote?: string;
  gateTotals: Record<string, number>;
  dispositionTotals: Record<string, number>;
  practiceScopeTotals: Record<string, number>;
  ledger: OpsLedgerSummary;
  packages: OpsPackageRow[];
  versions: Record<string, string>;
}

export interface OpsLedgerDecision {
  decision: string;
  reviewer: string;
  reviewedAt: string;
  fingerprintCurrent: boolean;
  recordedVia?: string;
}

export interface OpsQaEntry {
  entryId: string;
  kind: 'QUEUE_ENTRY' | 'CROP_UNIT';
  type?: string;
  subtype?: string;
  severity?: string;
  releasePriority?: string;
  status?: string;
  fingerprint?: string;
  page?: number;
  questions?: unknown;
  cropSha256?: string;
  technical?: string;
  technicalCodes?: string[];
  reportCurrent: boolean;
  latestDecision?: OpsLedgerDecision;
  decisionPendingApplication: boolean;
  decidable: boolean;
}

export interface OpsMediaAsset {
  assetId: string;
  sha256: string;
  mimeType?: string;
  roles: string[];
  stimulusKinds: string[];
  validationState?: string;
  sourceKind: string;
  fileStatus: string;
  ready: boolean;
  bound: boolean;
  bindingCount: number;
  cropTechnical?: string;
  cropHumanApproved: boolean;
  waitingOnlyForHuman: boolean;
  previewable: boolean;
}

export interface OpsPracticeScope {
  scopeCode: string;
  scopeType: string;
  number: number;
  learnerState: string;
  ready: boolean;
  reasonCodes: string[];
  questionCount: number;
}

export interface OpsRightsDecision {
  basis: string;
  operation: string;
  allowed: boolean;
  reason: string;
  grantedBy?: string;
  unclearedCodes: string[];
}

export interface OpsRights {
  projectAuthorization: Record<string, unknown>;
  publisherLicences?: Array<Record<string, unknown>>;
  publisherLicenceGapCodes?: string[];
  decisions: OpsRightsDecision[];
  policyVersion: string;
}

export interface OpsProvenance {
  complete: boolean;
  gaps: string[];
  rawSourcePath?: string;
  rawSourceSha256?: string;
  pageRange?: string;
  audioReferences: number;
  extractorName?: string;
  extractorVersion?: string;
  reviewStatus?: string;
  sourceIdentity?: Record<string, unknown>;
}

export interface OpsImportPlan {
  target: string;
  operation: string;
  contentOperation: string;
  blockers: string[];
  notes: string[];
  planId: string;
  planVersion: string;
  plannedPackageVersion: number;
  plannedFormVersion: number;
  changedPlacements: number;
  reusedPlacements: number;
  retireConsiderations?: Array<Record<string, unknown>>;
  executable: boolean;
}

export interface OpsLifecyclePlan {
  executionMode: 'PLAN_ONLY';
  publicationAllowed: boolean;
  publicationBlockers: string[];
  retirementPending: boolean;
  retirementNotes: string[];
}

export interface OpsLegacyMapping {
  legacyLogicalKey?: string;
  legacyPackageId?: string;
  status?: string;
  proposedAction?: string;
  executed: boolean;
  replacementReady: boolean;
}

export interface OpsPackageDetail {
  summary: OpsPackageRow;
  validatorVersion: string;
  phase2BlockingCodes: string[];
  gateReasons: string[];
  runnerBlocking: string[];
  scoringBlocking: string[];
  reviewCodes: string[];
  compatibilityDiagnostics: Array<{ gate: string; code: string; severity: string; occurrences: number }>;
  qaEntries: OpsQaEntry[];
  cropUnits: OpsQaEntry[];
  media: OpsMediaAsset[];
  practiceScopes: OpsPracticeScope[];
  practiceBasisNote: string;
  rights: OpsRights;
  provenance: OpsProvenance;
  importPlans: OpsImportPlan[];
  legacyMappings: OpsLegacyMapping[];
  lifecycle: OpsLifecyclePlan;
  dispositionReasonCodes: string[];
  nextAction?: string;
}

/** The reviewer and timestamp are set by the server from the authenticated administrator — never sent. */
export interface OpsQaDecisionRequest {
  testId: string;
  entryId: string;
  decision: 'APPROVE' | 'REJECT' | 'CORRECT';
  fingerprint: string;
  correctedValue?: unknown;
  note?: string;
}

export interface OpsQaDecisionReceipt {
  testId: string;
  entryId: string;
  decision: string;
  reviewer: string;
  reviewedAt: string;
  fingerprint: string;
  previousStatus: string;
  previousDecision?: string;
  ledgerRecords: number;
  effect: string;
}

export interface OpsPersistedForm {
  formId: string;
  logicalKey: string;
  version: number;
  family?: string;
  title?: string;
  lifecycleState?: string;
  validation: Record<string, unknown>;
  practiceScopes: OpsPracticeScope[];
  rights: OpsRights;
  recordedPackageIdentity?: Record<string, unknown>;
  lifecycle: OpsLifecyclePlan;
}
